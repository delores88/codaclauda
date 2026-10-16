//! Desktop-only helpers for the 0.3 UI. Every command uses the same envelope as
//! `rpc`. Nothing here is a generic filesystem or process bridge: paths are
//! fixed under the bound board, scans read metadata only, spawned programs use
//! fixed argv without a shell, and external opens accept http(s) links or
//! existing local folders only. No credential is read, printed or stored.

use crate::{board, error};
use base64::Engine as _;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tokio::{process::Command, time::timeout};

const UI_DIR: &str = "desktop-ui";
const ATTACHMENTS_DIR: &str = "attachments";
const STATE_FILE: &str = "ui-state.json";
const MANIFEST_FILE: &str = "projects.manifest.json";
const STATE_LIMIT: u64 = 8 * 1024 * 1024;
const MANIFEST_LIMIT: u64 = 2 * 1024 * 1024;
const ATTACHMENT_LIMIT: usize = 25 * 1024 * 1024;
const PROCESS_OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
const SCAN_FILE_LIMIT: u64 = 60_000;
const SCAN_DEPTH_LIMIT: usize = 14;
const SCAN_BUDGET: Duration = Duration::from_secs(4);
const LOC_FILE_LIMIT: u64 = 2 * 1024 * 1024;
const DISCOVER_LIMIT: usize = 300;
const DISCOVER_BUDGET: Duration = Duration::from_secs(8);
const MARKER_ENTRY_LIMIT: usize = 4_000;
const GIT_TIMEOUT: Duration = Duration::from_secs(10);
const GH_TIMEOUT: Duration = Duration::from_secs(15);
const GH_GRAPHQL_TIMEOUT: Duration = Duration::from_secs(45);
const GH_CREATE_TIMEOUT: Duration = Duration::from_secs(90);
const GH_CLONE_TIMEOUT: Duration = Duration::from_secs(180);
const API_TIMEOUT: Duration = Duration::from_secs(20);
const GH_PAGES: usize = 3;
const COLLAB_PAGES: usize = 6;
const COLLAB_LIMIT: usize = 500;
const COLLAB_BUDGET: Duration = Duration::from_secs(90);
const REPO_DESCRIPTION_LIMIT: usize = 350;
const GH_SIGN_IN_HINT: &str = "Open a terminal and run gh auth login, then try again. CodaClauda never asks for your GitHub password or token.";
const TOKEN_PREFIXES: &[&str] = &["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"];
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    ".next",
    ".nuxt",
    ".cache",
    ".gradle",
    ".idea",
    ".vs",
    "bin",
    "obj",
    "coverage",
    "vendor",
    ".turbo",
    ".parcel-cache",
    "pods",
    "deriveddata",
];

/// Exact names, compared case-insensitively, then extension patterns.
const MARKER_NAMES: &[&str] = &[
    ".git",
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Gemfile",
    "composer.json",
    "pubspec.yaml",
    "CMakeLists.txt",
    "Makefile",
];
const MARKER_EXTENSIONS: &[(&str, &str)] = &[
    ("sln", "*.sln"),
    ("csproj", "*.csproj"),
    ("blend", "*.blend"),
];

const REPOS_QUERY: &str = "query($login: String!, $cursor: String) { repositoryOwner(login: $login) { login repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, orderBy: {field: PUSHED_AT, direction: DESC}) { pageInfo { hasNextPage endCursor } nodes { name nameWithOwner description url isPrivate isArchived isFork diskUsage pushedAt stargazerCount primaryLanguage { name } defaultBranchRef { name target { ... on Commit { history { totalCount } } } } languages(first: 6, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name } } } } } } }";

type Failure = (&'static str, String);

fn ok(data: Value) -> Value {
    json!({"ok": true, "data": data})
}

fn fail(code: &'static str, message: impl Into<String>) -> Failure {
    (code, message.into())
}

/// Runs filesystem work off the async runtime and wraps it in the envelope.
async fn blocking<F>(work: F) -> Value
where
    F: FnOnce() -> Result<Value, Failure> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(Ok(data)) => ok(data),
        Ok(Err((code, message))) => error(code, message),
        Err(_) => error(
            "DESKTOP_TASK_FAILED",
            "The desktop operation stopped unexpectedly.",
        ),
    }
}

/// Display form of a path: `\\?\C:\x` becomes `C:\x`, `\\?\UNC\s\x` becomes `\\s\x`.
fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return rest.to_owned();
        }
    }
    text.into_owned()
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn ui_dir(board: &board::BoardBinding) -> PathBuf {
    board.state_dir().join(UI_DIR)
}

fn bound_ui_dir(app: &tauri::AppHandle) -> PathBuf {
    ui_dir(&app.state::<board::BoardBinding>())
}

/// Writes must never recreate a moved or removed board as an empty one.
fn writable_ui_dir(app: &tauri::AppHandle) -> Result<PathBuf, Failure> {
    let board = app.state::<board::BoardBinding>();
    board
        .validate()
        .map_err(|message| fail("BOARD_UNAVAILABLE", message))?;
    Ok(ui_dir(&board))
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.filter(|value| !value.is_empty()).map(PathBuf::from)
}

/// The Desktop known folder follows OneDrive and policy redirection.
#[cfg(windows)]
fn known_desktop() -> Option<PathBuf> {
    use windows::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_Desktop, KF_FLAG_DEFAULT, SHGetKnownFolderPath},
    };
    unsafe {
        let allocated = SHGetKnownFolderPath(&FOLDERID_Desktop, KF_FLAG_DEFAULT, None).ok()?;
        let text = allocated.to_string();
        // The shell allocates this string even if UTF-16 conversion fails.
        CoTaskMemFree(Some(allocated.0.cast()));
        text.ok()
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    }
}

#[cfg(not(windows))]
fn known_desktop() -> Option<PathBuf> {
    None
}

fn desktop_dir() -> Option<PathBuf> {
    known_desktop().or_else(|| home_dir().map(|home| home.join("Desktop")))
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    };
    #[cfg(not(windows))]
    let reparse = false;
    metadata.file_type().is_symlink() || reparse
}

/// Creates one directory level under the bound board and refuses links.
fn ensure_dir(path: &Path) -> Result<(), Failure> {
    match fs::create_dir(path) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => {
            return Err(fail(
                "WRITE_FAILED",
                format!("Could not create {}: {e}", display_path(path)),
            ));
        }
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|e| fail("WRITE_FAILED", format!("{}: {e}", display_path(path))))?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err(fail(
            "WRITE_REFUSED",
            format!(
                "{} must be a real directory, not a file or link.",
                display_path(path)
            ),
        ));
    }
    Ok(())
}

/// Missing files are `None`; links, oversized files and read errors fail.
fn read_bounded(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, Failure> {
    let metadata = match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(fail("READ_FAILED", format!("{}: {e}", display_path(path))));
        }
        Ok(metadata) => metadata,
    };
    if !metadata.is_file() || is_link(&metadata) {
        return Err(fail(
            "READ_REFUSED",
            format!("{} is not a regular file.", display_path(path)),
        ));
    }
    if metadata.len() > limit {
        return Err(fail(
            "FILE_TOO_LARGE",
            format!("{} exceeds {limit} bytes.", display_path(path)),
        ));
    }
    let file = fs::File::open(path)
        .map_err(|e| fail("READ_FAILED", format!("{}: {e}", display_path(path))))?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| fail("READ_FAILED", format!("{}: {e}", display_path(path))))?;
    if bytes.len() as u64 > limit {
        return Err(fail(
            "FILE_TOO_LARGE",
            format!("{} exceeds {limit} bytes.", display_path(path)),
        ));
    }
    Ok(Some(bytes))
}

/// Only local drive paths (or absolute paths off Windows). UNC and device
/// paths are refused so a crafted value cannot trigger network authentication.
fn local_absolute(raw: &str) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 4096 || raw.contains('\0') {
        return None;
    }
    #[cfg(windows)]
    {
        let bytes = raw.as_bytes();
        let drive = bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/');
        if !drive {
            return None;
        }
    }
    let path = PathBuf::from(raw);
    path.is_absolute().then_some(path)
}

fn existing_directory(raw: &str) -> Result<PathBuf, String> {
    let path = local_absolute(raw).ok_or("The path must be an absolute local folder.")?;
    let canonical = fs::canonicalize(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!("{} is not a folder.", display_path(&canonical)));
    }
    Ok(canonical)
}

// ---------------------------------------------------------------- paths/state

#[tauri::command]
pub(crate) fn desktop_paths(board: tauri::State<'_, board::BoardBinding>) -> Value {
    let state_dir = board.state_dir();
    let ui = ui_dir(&board);
    let attachments = ui.join(ATTACHMENTS_DIR);
    let manifest = ui.join(MANIFEST_FILE);
    ok(json!({
        "state_dir": display_path(state_dir),
        "ui_dir": display_path(&ui),
        "attachments_dir": display_path(&attachments),
        "manifest_path": display_path(&manifest),
        "desktop_dir": desktop_dir().map(|path| display_path(&path)),
        "home_dir": home_dir().map(|path| display_path(&path)),
    }))
}

#[tauri::command]
pub(crate) async fn desktop_state_load(app: tauri::AppHandle) -> Value {
    let path = bound_ui_dir(&app).join(STATE_FILE);
    blocking(move || match read_bounded(&path, STATE_LIMIT)? {
        None => Ok(json!({"state": null})),
        Some(bytes) => serde_json::from_slice::<Value>(&bytes)
            .map(|state| json!({"state": state}))
            .map_err(|e| {
                fail(
                    "STATE_INVALID",
                    format!("The saved desktop state is not valid JSON: {e}"),
                )
            }),
    })
    .await
}

#[tauri::command]
pub(crate) async fn desktop_state_save(app: tauri::AppHandle, state: Value) -> Value {
    let ui = match writable_ui_dir(&app) {
        Ok(ui) => ui,
        Err((code, message)) => return error(code, message),
    };
    blocking(move || {
        let bytes = serde_json::to_vec(&state).map_err(|e| fail("STATE_INVALID", e.to_string()))?;
        if bytes.len() as u64 > STATE_LIMIT {
            return Err(fail(
                "STATE_TOO_LARGE",
                format!("Desktop state exceeds {STATE_LIMIT} bytes."),
            ));
        }
        ensure_dir(&ui)?;
        let write_failed =
            |e: std::io::Error| fail("WRITE_FAILED", format!("Could not save desktop state: {e}"));
        let mut temporary = tempfile::NamedTempFile::new_in(&ui).map_err(write_failed)?;
        temporary.write_all(&bytes).map_err(write_failed)?;
        temporary.as_file().sync_all().map_err(write_failed)?;
        temporary
            .persist(ui.join(STATE_FILE))
            .map_err(|e| write_failed(e.error))?;
        Ok(json!({"saved_at": unix_seconds()}))
    })
    .await
}

#[tauri::command]
pub(crate) async fn desktop_manifest_load(app: tauri::AppHandle) -> Value {
    let path = bound_ui_dir(&app).join(MANIFEST_FILE);
    blocking(move || {
        let shown = display_path(&path);
        match read_bounded(&path, MANIFEST_LIMIT)? {
            None => Ok(json!({"manifest": null, "path": shown})),
            Some(bytes) => serde_json::from_slice::<Value>(&bytes)
                .map(|manifest| json!({"manifest": manifest, "path": shown}))
                .map_err(|e| {
                    fail(
                        "MANIFEST_INVALID",
                        format!("{shown} is not valid JSON: {e}"),
                    )
                }),
        }
    })
    .await
}

// ---------------------------------------------------------------- project scan

#[derive(Clone, Copy)]
enum Loc {
    Code,
    /// Notebooks: JSON documents whose code share is roughly a third.
    Notebook,
    Data,
    Skip,
}

fn language_for(extension: &str) -> Option<(&'static str, Loc)> {
    use Loc::{Code, Data, Notebook, Skip};
    Some(match extension {
        "rs" => ("Rust", Code),
        "ts" | "tsx" => ("TypeScript", Code),
        "js" | "jsx" | "mjs" | "cjs" => ("JavaScript", Code),
        "py" => ("Python", Code),
        "go" => ("Go", Code),
        "java" => ("Java", Code),
        "kt" | "kts" => ("Kotlin", Code),
        "cs" => ("C#", Code),
        "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" => ("C++", Code),
        "c" | "h" => ("C", Code),
        "html" | "htm" => ("HTML", Code),
        "css" | "scss" | "sass" | "less" => ("CSS", Code),
        "sh" | "bash" | "zsh" => ("Shell", Code),
        "ps1" | "psm1" | "psd1" => ("PowerShell", Code),
        "rb" => ("Ruby", Code),
        "php" => ("PHP", Code),
        "swift" => ("Swift", Code),
        "dart" => ("Dart", Code),
        "lua" => ("Lua", Code),
        "vue" => ("Vue", Code),
        "svelte" => ("Svelte", Code),
        "md" | "mdx" => ("Markdown", Data),
        "json" => ("JSON", Data),
        "toml" => ("TOML", Data),
        "yml" | "yaml" => ("YAML", Data),
        // Notebooks are JSON documents; .blend files are binary scenes.
        "ipynb" => ("Jupyter Notebook", Notebook),
        "glsl" | "wgsl" | "hlsl" | "frag" | "vert" => ("GLSL", Code),
        "sql" => ("SQL", Code),
        "blend" => ("Blender", Skip),
        _ => return None,
    })
}

#[derive(Default)]
struct ScanTotals {
    files: u64,
    bytes: u64,
    code_bytes: u64,
    notebook_bytes: u64,
    languages: HashMap<&'static str, u64>,
    truncated: bool,
}

/// Generated, vendored or lock files say little about a project's own code.
fn generated(relative: &str) -> bool {
    let lower = relative.replace('\\', "/").to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    name.ends_with(".min.js")
        || name.ends_with(".min.css")
        || name.ends_with(".map")
        || matches!(name, "package-lock.json" | "cargo.lock" | "yarn.lock" | "pnpm-lock.yaml" | "poetry.lock" | "composer.lock" | "gemfile.lock")
        || lower.split('/').any(|part| matches!(part, "vendor" | "third_party" | "third-party" | "dist" | "build" | "node_modules"))
}

impl ScanTotals {
    /// Count one regular file by size only (never opened).
    fn add(&mut self, relative: &str, size: u64) {
        self.files += 1;
        self.bytes += size;
        if generated(relative) {
            return;
        }
        let Some(extension) = Path::new(relative)
            .extension()
            .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        else {
            return;
        };
        let Some((language, loc)) = language_for(&extension) else {
            return;
        };
        // Only code shapes the language mix and line estimate; docs and data
        // (Markdown, JSON, YAML, TOML) are counted in bytes but not as code.
        match loc {
            Loc::Code => {
                *self.languages.entry(language).or_default() += size;
                if size <= LOC_FILE_LIMIT {
                    self.code_bytes += size;
                }
            }
            Loc::Notebook => {
                *self.languages.entry(language).or_default() += size / 3;
                if size <= LOC_FILE_LIMIT {
                    self.notebook_bytes += size;
                }
            }
            Loc::Data | Loc::Skip => {}
        }
    }
}

/// Metadata-only walk. Directory entries come from the enumeration itself, so
/// no file is opened (OneDrive placeholders are never hydrated). Symlinks,
/// junctions and mount points are not followed.
fn scan_tree(root: &Path) -> ScanTotals {
    let started = Instant::now();
    let mut totals = ScanTotals::default();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut visited = 0u64;
    'walk: while let Some((directory, depth)) = stack.pop() {
        if started.elapsed() > SCAN_BUDGET {
            totals.truncated = true;
            break;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited % 256 == 0 && started.elapsed() > SCAN_BUDGET {
                totals.truncated = true;
                break 'walk;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                if depth >= SCAN_DEPTH_LIMIT {
                    totals.truncated = true;
                    continue;
                }
                stack.push((entry.path(), depth + 1));
            } else if kind.is_file() {
                if totals.files >= SCAN_FILE_LIMIT {
                    totals.truncated = true;
                    break 'walk;
                }
                let Ok(metadata) = entry.metadata() else {
                    continue;
                };
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default();
                totals.add(&relative, metadata.len());
            }
        }
    }
    totals
}

/// Sizes of git-tracked files only (respects .gitignore, so downloaded
/// dependencies and build output are not counted). Metadata only.
fn scan_tracked(root: &Path, tracked: &[u8]) -> ScanTotals {
    let started = Instant::now();
    let mut totals = ScanTotals::default();
    for raw in tracked.split(|byte| *byte == 0).filter(|part| !part.is_empty()) {
        if totals.files >= SCAN_FILE_LIMIT || started.elapsed() > SCAN_BUDGET {
            totals.truncated = true;
            break;
        }
        let Ok(relative) = std::str::from_utf8(raw) else {
            continue;
        };
        // git always reports forward-slash paths inside the work tree.
        if relative.split('/').any(|part| part == ".." || part.is_empty()) {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(root.join(relative)) else {
            continue;
        };
        if metadata.is_file() {
            totals.add(relative, metadata.len());
        }
    }
    totals
}

/// `git ls-files -z` with the same hardened flags as git_text; larger output cap.
async fn git_tracked_files(repo: &str) -> Option<Vec<u8>> {
    let mut command = Command::new("git");
    command
        .arg("--no-pager")
        .args(["-c", "log.showSignature=false", "-c", "core.fsmonitor="])
        .arg("-C")
        .arg(repo)
        .args(["ls-files", "-z", "--cached"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let child = command.spawn().ok()?;
    let output = timeout(GIT_TIMEOUT, child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    (output.status.success() && output.stdout.len() <= 32 * 1024 * 1024).then_some(output.stdout)
}

async fn git_text(repo: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new("git");
    // A project's own .git/config must not run programs: log.showSignature
    // makes `git log` execute the repository-configured gpg.program.
    command
        .arg("--no-pager")
        .args(["-c", "log.showSignature=false", "-c", "core.fsmonitor="])
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let child = command.spawn().ok()?;
    let output = timeout(GIT_TIMEOUT, child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() || output.stdout.len() > 64 * 1024 {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

/// Remote URLs may embed tokens (`https://user:token@host/...`); drop them.
fn redact_remote(raw: &str) -> Option<String> {
    match url::Url::parse(raw) {
        // `user:secret@host:path` parses as an opaque URL with scheme `user`;
        // such values take the scp-like branch below instead.
        Ok(mut parsed) if !parsed.cannot_be_a_base() => {
            if matches!(parsed.scheme(), "http" | "https") {
                let _ = parsed.set_username("");
            }
            let _ = parsed.set_password(None);
            Some(parsed.to_string())
        }
        // An unparseable URL with a scheme could still carry credentials.
        _ if raw.contains("://") => None,
        // scp-like `git@host:owner/repo`; strip anything that looks like user:secret@.
        _ => match raw.split_once('@') {
            Some((user, rest)) if user.contains(':') => Some(rest.to_owned()),
            _ => Some(raw.to_owned()),
        },
    }
}

async fn git_summary(repo: &str) -> Value {
    let (commits, commits_7d, last_commit_at, branch, remote) = tokio::join!(
        git_text(repo, &["rev-list", "--count", "HEAD"]),
        git_text(repo, &["rev-list", "--count", "--since=7.days", "HEAD"]),
        git_text(repo, &["log", "-1", "--format=%ct"]),
        git_text(repo, &["rev-parse", "--abbrev-ref", "HEAD"]),
        git_text(repo, &["remote", "get-url", "origin"]),
    );
    json!({
        "commits": commits.and_then(|v| v.parse::<u64>().ok()),
        "commits_7d": commits_7d.and_then(|v| v.parse::<u64>().ok()),
        "last_commit_at": last_commit_at.and_then(|v| v.parse::<i64>().ok()),
        "branch": branch,
        "remote": remote.and_then(|v| redact_remote(&v)),
    })
}

#[tauri::command]
pub(crate) async fn project_scan(path: String) -> Value {
    let root = match existing_directory(&path) {
        Ok(root) => root,
        Err(message) => return error("SCAN_REFUSED", message),
    };
    let has_git = fs::symlink_metadata(root.join(".git")).is_ok();
    let tracked = if has_git {
        git_tracked_files(&display_path(&root)).await
    } else {
        None
    };
    let scanned = tauri::async_runtime::spawn_blocking(move || {
        let totals = match tracked {
            Some(list) if !list.is_empty() => scan_tracked(&root, &list),
            _ => scan_tree(&root),
        };
        Ok::<_, Failure>((root, totals, has_git))
    })
    .await;
    let (root, totals, has_git) = match scanned {
        Ok(Ok(result)) => result,
        Ok(Err((code, message))) => return error(code, message),
        Err(_) => {
            return error(
                "DESKTOP_TASK_FAILED",
                "The project scan stopped unexpectedly.",
            );
        }
    };
    let shown = display_path(&root);
    let git = if has_git {
        git_summary(&shown).await
    } else {
        Value::Null
    };
    let mut languages: Vec<(&str, u64)> = totals.languages.into_iter().collect();
    languages.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    let languages: Vec<Value> = languages
        .into_iter()
        .take(8)
        .map(|(name, bytes)| json!({"name": name, "bytes": bytes}))
        .collect();
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| shown.clone());
    ok(json!({
        "path": shown,
        "name": name,
        "files": totals.files,
        "bytes": totals.bytes,
        "loc": totals.code_bytes / 38 + totals.notebook_bytes / 150,
        "languages": languages,
        "truncated": totals.truncated,
        "git": git,
    }))
}

// ---------------------------------------------------------- project discovery

fn desktop_roots() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    candidates.extend(known_desktop());
    candidates.extend(home_dir().map(|home| home.join("Desktop")));
    if let Some(onedrive) = std::env::var_os("OneDrive").filter(|v| !v.is_empty()) {
        candidates.push(PathBuf::from(onedrive).join("Desktop"));
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    for candidate in candidates {
        if let Ok(canonical) = fs::canonicalize(&candidate)
            && canonical.is_dir()
            && !roots.contains(&canonical)
        {
            roots.push(canonical);
        }
    }
    roots
}

fn project_markers(directory: &Path) -> Vec<&'static str> {
    let mut found = [false; MARKER_NAMES.len() + MARKER_EXTENSIONS.len()];
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    for entry in entries.flatten().take(MARKER_ENTRY_LIMIT) {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if let Some(index) = MARKER_NAMES
            .iter()
            .position(|marker| marker.eq_ignore_ascii_case(&name))
        {
            found[index] = true;
            continue;
        }
        if let Some((_, extension)) = name.rsplit_once('.')
            && let Some(index) = MARKER_EXTENSIONS
                .iter()
                .position(|(ext, _)| *ext == extension)
            && entry.file_type().is_ok_and(|kind| kind.is_file())
        {
            found[MARKER_NAMES.len() + index] = true;
        }
    }
    MARKER_NAMES
        .iter()
        .copied()
        .chain(MARKER_EXTENSIONS.iter().map(|(_, label)| *label))
        .zip(found)
        .filter_map(|(label, hit)| hit.then_some(label))
        .collect()
}

fn discover_projects() -> Value {
    let started = Instant::now();
    let mut examined = 0usize;
    let mut truncated = false;
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut projects: Vec<(String, Value)> = Vec::new();
    'roots: for root in desktop_roots() {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue; // files, symlinks and junctions are not projects
            }
            if examined >= DISCOVER_LIMIT || started.elapsed() > DISCOVER_BUDGET {
                truncated = true;
                break 'roots;
            }
            examined += 1;
            let path = entry.path();
            if seen.contains(&path) {
                continue;
            }
            seen.push(path.clone());
            let markers = project_markers(&path);
            if markers.is_empty() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            projects.push((
                name.to_lowercase(),
                json!({
                    "name": name,
                    "path": display_path(&path),
                    "is_git": markers.contains(&".git"),
                    "markers": markers,
                }),
            ));
        }
    }
    projects.sort_by(|a, b| a.0.cmp(&b.0));
    json!({
        "projects": projects.into_iter().map(|(_, project)| project).collect::<Vec<_>>(),
        "truncated": truncated,
    })
}

#[tauri::command]
pub(crate) async fn desktop_discover_projects() -> Value {
    blocking(|| Ok(discover_projects())).await
}

// ---------------------------------------------------------------- GitHub

fn valid_login(login: &str) -> bool {
    (1..=39).contains(&login.len())
        && login
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// One line of tool output, safe to show: token-shaped words and URLs with
/// embedded credentials are redacted, control characters dropped, length capped.
fn sanitize_line(line: &str, max: usize) -> String {
    line.split_whitespace()
        .map(|word| {
            let lower = word.to_ascii_lowercase();
            if TOKEN_PREFIXES.iter().any(|prefix| lower.contains(prefix)) {
                "[redacted]"
            } else if word.contains("://") && word.contains('@') {
                "[redacted-url]"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect()
}

/// gh errors normally carry no secrets; scrub token-shaped words regardless.
fn scrub(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    sanitize_line(line, 200)
}

/// The most telling stderr line of a failed create/clone: git progress lines
/// ("Cloning into ...") are skipped in favour of the actual error.
fn failure_line(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    const TELLING: &[&str] = &[
        "error",
        "fatal",
        "failed",
        "already exists",
        "graphql",
        "http ",
        "not found",
        "could not",
        "permission",
        "denied",
        "unknown flag",
    ];
    const PROGRESS: &[&str] = &[
        "cloning into",
        "remote:",
        "receiving objects",
        "resolving deltas",
        "updating files",
    ];
    let telling = lines.iter().find(|line| {
        let lower = line.to_ascii_lowercase();
        TELLING.iter().any(|word| lower.contains(word))
    });
    let fallback = || {
        lines.iter().find(|line| {
            let lower = line.to_ascii_lowercase();
            !PROGRESS.iter().any(|word| lower.starts_with(word))
        })
    };
    sanitize_line(telling.or_else(fallback).copied().unwrap_or(""), 300)
}

/// Spawns gh with fixed argv (never a shell), no console window and no
/// interactive prompts. A timeout is reported as `GH_TIMEOUT`.
async fn gh_output(
    args: &[&str],
    limit: Duration,
    cwd: Option<&Path>,
) -> Result<std::process::Output, Failure> {
    let mut command = Command::new("gh");
    command
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        // gh runs git for clones; neither may wait on a prompt nobody can see.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            fail(
                "GH_UNAVAILABLE",
                "GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com.",
            )
        } else {
            fail("GH_UNAVAILABLE", format!("GitHub CLI could not start: {e}"))
        }
    })?;
    let pid = child.id();
    // Pinned locally so gh stays alive (and its PID owned) until its tree is ended.
    let mut wait = std::pin::pin!(child.wait_with_output());
    match timeout(limit, wait.as_mut()).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(e)) => Err(fail("GH_UNAVAILABLE", format!("GitHub CLI failed: {e}"))),
        Err(_) => {
            // kill_on_drop ends gh only; its git/ssh children would be orphaned.
            #[cfg(windows)]
            if let Some(pid) = pid {
                kill_tree(pid).await;
            }
            #[cfg(not(windows))]
            let _ = pid;
            Err(fail("GH_TIMEOUT", "GitHub CLI timed out."))
        }
    }
}

/// Ends a still-running process and its descendants with the system taskkill.
#[cfg(windows)]
async fn kill_tree(pid: u32) {
    let root = std::env::var_os("SystemRoot")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let mut command = Command::new(root.join("System32").join("taskkill.exe"));
    command
        .args(["/T", "/F", "/PID"])
        .arg(pid.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW);
    if let Ok(mut child) = command.spawn() {
        let _ = timeout(Duration::from_secs(10), child.wait()).await;
    }
}

async fn run_gh(args: &[&str], limit: Duration) -> Result<Vec<u8>, Failure> {
    let output = gh_output(args, limit, None)
        .await
        .map_err(|(code, message)| match code {
            "GH_TIMEOUT" => ("GH_UNAVAILABLE", message),
            code => (code, message),
        })?;
    if !output.status.success() {
        let detail = scrub(&output.stderr);
        return Err(fail(
            "GH_UNAVAILABLE",
            format!(
                "GitHub CLI is unavailable or not signed in ({}). {detail}",
                output.status
            )
            .trim()
            .to_owned(),
        ));
    }
    if output.stdout.len() > PROCESS_OUTPUT_LIMIT {
        return Err(fail(
            "GH_UNAVAILABLE",
            "GitHub CLI output exceeded the limit.",
        ));
    }
    Ok(output.stdout)
}

async fn gh_login() -> Result<String, Failure> {
    let stdout = run_gh(&["api", "user", "--jq", ".login"], GH_TIMEOUT).await?;
    let login = String::from_utf8_lossy(&stdout).trim().to_owned();
    if valid_login(&login) {
        Ok(login)
    } else {
        Err(fail(
            "GH_UNAVAILABLE",
            "GitHub CLI did not return a signed-in login.",
        ))
    }
}

#[tauri::command]
pub(crate) async fn github_user() -> Value {
    match gh_login().await {
        Ok(login) => ok(json!({"login": login, "source": "gh"})),
        Err((code, message)) => error(code, message),
    }
}

fn graphql_repo(node: &Value) -> Value {
    let languages: Vec<Value> = node
        .pointer("/languages/edges")
        .and_then(Value::as_array)
        .map(|edges| {
            edges
                .iter()
                .filter_map(|edge| {
                    Some(json!({
                        "name": edge.pointer("/node/name")?.as_str()?,
                        "bytes": edge.get("size")?.as_u64()?,
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    let field = |pointer: &str| node.pointer(pointer).cloned().unwrap_or(Value::Null);
    json!({
        "name": field("/name"),
        "full_name": field("/nameWithOwner"),
        "description": field("/description"),
        "url": field("/url"),
        "private": field("/isPrivate"),
        "archived": field("/isArchived"),
        "fork": field("/isFork"),
        "language": field("/primaryLanguage/name"),
        "languages": languages,
        "size_kb": field("/diskUsage"),
        "pushed_at": field("/pushedAt"),
        "stars": field("/stargazerCount"),
        "default_branch": field("/defaultBranchRef/name"),
        "commit_count": field("/defaultBranchRef/target/history/totalCount"),
    })
}

async fn gh_repos(login: &str) -> Result<Vec<Value>, Failure> {
    let query = format!("query={REPOS_QUERY}");
    let login_arg = format!("login={login}");
    let mut cursor: Option<String> = None;
    let mut repos = Vec::new();
    for _ in 0..GH_PAGES {
        let cursor_arg = cursor.as_ref().map(|c| format!("cursor={c}"));
        let mut args = vec![
            "api",
            "graphql",
            "-f",
            query.as_str(),
            "-f",
            login_arg.as_str(),
        ];
        if let Some(cursor_arg) = &cursor_arg {
            args.extend(["-f", cursor_arg.as_str()]);
        }
        let stdout = run_gh(&args, GH_GRAPHQL_TIMEOUT).await?;
        let response: Value = serde_json::from_slice(&stdout)
            .map_err(|_| fail("GH_UNAVAILABLE", "GitHub CLI returned invalid JSON."))?;
        let Some(connection) = response.pointer("/data/repositoryOwner/repositories") else {
            return Err(fail(
                "GITHUB_USER_NOT_FOUND",
                format!("GitHub has no account named {login}."),
            ));
        };
        if let Some(nodes) = connection.get("nodes").and_then(Value::as_array) {
            repos.extend(nodes.iter().filter(|n| n.is_object()).map(graphql_repo));
        }
        let next = connection
            .pointer("/pageInfo/hasNextPage")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        cursor = connection
            .pointer("/pageInfo/endCursor")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if !next || cursor.is_none() {
            break;
        }
    }
    Ok(repos)
}

fn api_repo(repo: &Value) -> Value {
    let field = |key: &str| repo.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "name": field("name"),
        "full_name": field("full_name"),
        "description": field("description"),
        "url": field("html_url"),
        "private": field("private"),
        "archived": field("archived"),
        "fork": field("fork"),
        "language": field("language"),
        "languages": null,
        "size_kb": field("size"),
        "pushed_at": field("pushed_at"),
        "stars": field("stargazers_count"),
        "default_branch": field("default_branch"),
        "commit_count": null,
    })
}

async fn api_repos(login: &str) -> Result<Vec<Value>, Failure> {
    let unavailable = |e: reqwest::Error| {
        fail(
            "GITHUB_UNAVAILABLE",
            format!("GitHub could not be reached: {e}"),
        )
    };
    let client = reqwest::Client::builder()
        .user_agent("CodaClauda")
        .timeout(API_TIMEOUT)
        .build()
        .map_err(unavailable)?;
    let mut response = client
        .get(format!(
            "https://api.github.com/users/{login}/repos?per_page=100&sort=pushed"
        ))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(unavailable)?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(fail(
            "GITHUB_USER_NOT_FOUND",
            format!("GitHub has no account named {login}."),
        ));
    }
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS
    {
        return Err(fail(
            "GITHUB_RATE_LIMITED",
            "GitHub's public API rate limit was reached. Sign in with `gh auth login` or retry later.",
        ));
    }
    if !status.is_success() {
        return Err(fail(
            "GITHUB_UNAVAILABLE",
            format!("GitHub answered with HTTP {status}."),
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(unavailable)? {
        if body.len() + chunk.len() > PROCESS_OUTPUT_LIMIT {
            return Err(fail(
                "GITHUB_UNAVAILABLE",
                "GitHub's response exceeded the limit.",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let repos: Value = serde_json::from_slice(&body)
        .map_err(|_| fail("GITHUB_UNAVAILABLE", "GitHub returned invalid JSON."))?;
    Ok(repos
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|r| r.is_object())
                .map(api_repo)
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub(crate) async fn github_repos(user: String) -> Value {
    let user = user.trim().to_owned();
    let login = if user.is_empty() {
        match gh_login().await {
            Ok(login) => login,
            Err((code, message)) => return error(code, message),
        }
    } else if valid_login(&user) {
        user
    } else {
        return error(
            "INVALID_USER",
            "GitHub user names contain 1-39 letters, digits or hyphens.",
        );
    };
    match gh_repos(&login).await {
        Ok(repos) => ok(json!({"user": login, "source": "gh", "repos": repos})),
        Err(_) => match api_repos(&login).await {
            Ok(repos) => ok(json!({"user": login, "source": "api", "repos": repos})),
            Err((code, message)) => error(code, message),
        },
    }
}

// ------------------------------------------------- GitHub: contributor islands

/// One repository from `user/repos`, trimmed to what the City's islands map
/// needs. Repositories the viewer owns and malformed names are dropped.
fn collab_repo(repo: &Value, viewer: &str) -> Option<Value> {
    let owner = repo.get("owner")?;
    let login = owner.get("login")?.as_str()?;
    let name = repo.get("name")?.as_str()?;
    if !valid_login(login)
        || login.starts_with('-')
        || !valid_repo_folder(name)
        || login.eq_ignore_ascii_case(viewer)
    {
        return None;
    }
    let kind = match owner.get("type").and_then(Value::as_str) {
        Some("Organization") => "Organization",
        _ => "User",
    };
    let flag = |key: &str| repo.get(key).and_then(Value::as_bool).unwrap_or(false);
    let can = |key: &str| {
        repo.pointer(&format!("/permissions/{key}"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    let text = |key: &str, max: usize| {
        repo.get(key)
            .and_then(Value::as_str)
            .map(|value| sanitize_line(value, max))
            .filter(|value| !value.is_empty())
    };
    let full_name = format!("{login}/{name}");
    Some(json!({
        "full_name": full_name,
        "owner": {"login": login, "type": kind},
        "name": name,
        "private": flag("private"),
        "archived": flag("archived"),
        "fork": flag("fork"),
        "permissions": {
            "push": can("push"),
            "admin": can("admin"),
            "maintain": can("maintain"),
            "triage": can("triage"),
            "pull": can("pull"),
        },
        "pushed_at": text("pushed_at", 40),
        "size_kb": repo.get("size").and_then(Value::as_u64).unwrap_or(0),
        "language": text("language", 60),
        "html_url": format!("https://github.com/{full_name}"),
        "default_branch": text("default_branch", 100),
        "stargazers": repo.get("stargazers_count").and_then(Value::as_u64).unwrap_or(0),
    }))
}

/// `user/repos` as a collaborator or organization member, most recently pushed
/// first, page by page so neither the output nor the run time is unbounded.
/// A later page that fails ends the list early (`truncated`); the first fails.
async fn gh_collab_repos(viewer: &str) -> Result<(Vec<Value>, bool), Failure> {
    let deadline = Instant::now() + COLLAB_BUDGET;
    let mut repos = Vec::new();
    let mut truncated = false;
    for page in 1..=COLLAB_PAGES {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            truncated = true;
            break;
        }
        let path = format!(
            "user/repos?affiliation=collaborator,organization_member&sort=pushed&per_page=100&page={page}"
        );
        let stdout = match run_gh(&["api", path.as_str()], left.min(GH_GRAPHQL_TIMEOUT)).await {
            Ok(stdout) => stdout,
            Err(failure) if page == 1 => return Err(failure),
            Err(_) => {
                truncated = true;
                break;
            }
        };
        let response: Value = serde_json::from_slice(&stdout)
            .map_err(|_| fail("GH_UNAVAILABLE", "GitHub CLI returned invalid JSON."))?;
        let Some(list) = response.as_array() else {
            return Err(fail(
                "GH_UNAVAILABLE",
                "GitHub CLI returned an unexpected response.",
            ));
        };
        repos.extend(list.iter().filter_map(|repo| collab_repo(repo, viewer)));
        if repos.len() >= COLLAB_LIMIT {
            truncated = repos.len() > COLLAB_LIMIT || list.len() == 100;
            repos.truncate(COLLAB_LIMIT);
            break;
        }
        if list.len() < 100 {
            break;
        }
        truncated = page == COLLAB_PAGES;
    }
    Ok((repos, truncated))
}

/// Repositories the GitHub CLI's signed-in account reaches as a collaborator or
/// organization member, never its own (at most 500). Uses gh's own sign-in;
/// there is no anonymous fallback because the public API cannot list another
/// account's access. No token is read, passed or printed.
#[tauri::command]
pub(crate) async fn github_collab_repos() -> Value {
    let viewer = match gh_login().await {
        Ok(login) => login,
        Err(failure) => {
            let (code, message) = with_sign_in_hint(failure);
            return error(code, message);
        }
    };
    match gh_collab_repos(&viewer).await {
        Ok((repos, truncated)) => ok(json!({
            "user": viewer,
            "source": "gh",
            "repos": repos,
            "truncated": truncated,
        })),
        Err(failure) => {
            let (code, message) = with_sign_in_hint(failure);
            error(code, message)
        }
    }
}

// ------------------------------------------------- GitHub: create and clone

/// Repository names that are also safe Windows folder names. Names starting
/// with '-' could be read as gh flags; '.'/'..' and a trailing dot would not
/// name a new folder; device names cannot be folders at all. A clone folder
/// named `.git` would make its parent a repository with cloned config.
fn valid_repo_folder(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    !name.eq_ignore_ascii_case(".git")
        && (1..=100).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && !name.starts_with('-')
        && !name.ends_with('.')
        && !RESERVED_NAMES.contains(&stem.as_str())
}

/// New repositories additionally may not start with '.'.
fn valid_new_repo_name(name: &str) -> bool {
    valid_repo_folder(name) && !name.starts_with('.')
}

/// `owner/name` from a GitHub remote (https, ssh:// or scp-like `git@github.com:`).
fn github_full_name(remote: &str) -> Option<String> {
    const HOST: &str = "github.com";
    // ASCII lowercasing keeps byte offsets, so the index is valid in `remote`.
    let at = remote.to_ascii_lowercase().find(HOST)?;
    let rest = &remote[at + HOST.len()..];
    let rest = rest.strip_prefix(':').or_else(|| rest.strip_prefix('/'))?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, name) = rest.split_once('/')?;
    (valid_login(owner) && valid_repo_folder(name)).then(|| format!("{owner}/{name}"))
}

/// `<parent>/<name>` for a new clone: the parent is an existing local folder
/// and nothing (file, folder or link) is at the target yet.
fn clone_target(parent_dir: &str, name: &str) -> Result<(PathBuf, PathBuf), Failure> {
    let parent =
        existing_directory(parent_dir).map_err(|message| fail("INVALID_FOLDER", message))?;
    let target = parent.join(name);
    match fs::symlink_metadata(&target) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((parent, target)),
        Ok(_) => Err(fail(
            "FOLDER_EXISTS",
            format!(
                "{} already exists. Choose another name or location.",
                display_path(&target)
            ),
        )),
        Err(e) => Err(fail(
            "INVALID_FOLDER",
            format!("{}: {e}", display_path(&target)),
        )),
    }
}

/// gh's wording when it has no usable sign-in (lowercased stderr line).
fn signed_out(lower: &str) -> bool {
    ["gh auth login", "not logged in", "authentication", "bad credentials"]
        .iter()
        .any(|phrase| lower.contains(phrase))
}

/// gh failures that mean "install or sign in to the GitHub CLI" get the hint.
fn with_sign_in_hint((code, message): Failure) -> Failure {
    if code == "GH_UNAVAILABLE" {
        (code, format!("{} {GH_SIGN_IN_HINT}", message.trim()))
    } else {
        (code, message)
    }
}

/// After gh finished: the folder must be a git work tree; its origin (read
/// with the hardened git helper, credentials redacted) names the repository.
async fn read_clone(
    target: &Path,
    expected: String,
    failed: &'static str,
) -> Result<Value, Failure> {
    let path = display_path(target);
    let has_git = fs::symlink_metadata(target.join(".git")).is_ok_and(|m| !is_link(&m));
    if !has_git {
        return Err(fail(
            failed,
            format!("GitHub CLI finished, but {path} is not a git repository."),
        ));
    }
    let full_name = git_text(&path, &["remote", "get-url", "origin"])
        .await
        .and_then(|remote| redact_remote(&remote))
        .and_then(|remote| github_full_name(&remote))
        .unwrap_or(expected);
    Ok(json!({
        "path": path,
        "url": format!("https://github.com/{full_name}"),
        "full_name": full_name,
    }))
}

async fn create_repo(
    name: &str,
    description: &str,
    private: bool,
    parent_dir: &str,
) -> Result<Value, Failure> {
    let name = name.trim();
    if !valid_new_repo_name(name) {
        return Err(fail(
            "INVALID_NAME",
            "Repository names use 1-100 letters, digits, '.', '-' or '_', cannot start with '.' or '-', cannot end with '.', and cannot be a reserved Windows name.",
        ));
    }
    let description = description.trim();
    if description.chars().count() > REPO_DESCRIPTION_LIMIT
        || description.chars().any(char::is_control)
    {
        return Err(fail(
            "INVALID_DESCRIPTION",
            format!("Descriptions are one line of at most {REPO_DESCRIPTION_LIMIT} characters."),
        ));
    }
    let (parent, target) = clone_target(parent_dir, name)?;
    let login = gh_login().await.map_err(with_sign_in_hint)?;
    let cwd = PathBuf::from(display_path(&parent));
    let description_arg = format!("--description={description}");
    let mut args = vec![
        "repo",
        "create",
        name,
        if private { "--private" } else { "--public" },
    ];
    if !description.is_empty() {
        args.push(description_arg.as_str());
    }
    args.extend(["--add-readme", "--clone"]);
    let output = match gh_output(&args, GH_CREATE_TIMEOUT, Some(&cwd)).await {
        Ok(output) => output,
        Err(("GH_TIMEOUT", _)) => {
            return Err(fail(
                "CREATE_FAILED",
                format!(
                    "GitHub CLI did not finish within {} seconds. Check https://github.com/{login}/{name} before retrying; it may already exist.",
                    GH_CREATE_TIMEOUT.as_secs()
                ),
            ));
        }
        Err(failure) => return Err(with_sign_in_hint(failure)),
    };
    // Without a TTY, gh prints the new repository's URL before it clones.
    let created = String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .find_map(github_full_name);
    if !output.status.success() {
        let detail = failure_line(&output.stderr);
        let lower = detail.to_ascii_lowercase();
        if let Some(full_name) = created {
            return Err(fail(
                "CLONE_FAILED",
                format!(
                    "Created {full_name} on GitHub, but cloning it into {} failed: {detail}",
                    display_path(&target)
                ),
            ));
        }
        if lower.contains("already exists") {
            return Err(fail(
                "REPO_EXISTS",
                format!(
                    "{login}/{name} already exists on GitHub. Pick another name, or clone it instead."
                ),
            ));
        }
        if signed_out(&lower) {
            return Err(fail(
                "GH_UNAVAILABLE",
                format!("GitHub CLI is not signed in. {GH_SIGN_IN_HINT}"),
            ));
        }
        return Err(fail(
            "CREATE_FAILED",
            if detail.is_empty() {
                format!("GitHub CLI could not create the repository ({}).", output.status)
            } else {
                format!("GitHub CLI could not create the repository: {detail}")
            },
        ));
    }
    let expected = created.unwrap_or_else(|| format!("{login}/{name}"));
    read_clone(&target, expected, "CREATE_FAILED").await
}

async fn clone_repo(full_name: &str, parent_dir: &str) -> Result<Value, Failure> {
    let full_name = full_name.trim();
    // valid_repo_folder also refuses "." and ".." (no trailing dot).
    let valid = full_name.split_once('/').filter(|(owner, name)| {
        valid_login(owner) && !owner.starts_with('-') && valid_repo_folder(name)
    });
    let Some((_, name)) = valid else {
        return Err(fail(
            "INVALID_REPO",
            "Repositories are named owner/name (letters, digits, '.', '-' or '_').",
        ));
    };
    let (parent, target) = clone_target(parent_dir, name)?;
    let cwd = PathBuf::from(display_path(&parent));
    let args = ["repo", "clone", full_name, name];
    let output = match gh_output(&args, GH_CLONE_TIMEOUT, Some(&cwd)).await {
        Ok(output) => output,
        Err(("GH_TIMEOUT", _)) => {
            return Err(fail(
                "CLONE_FAILED",
                format!(
                    "Cloning {full_name} did not finish within {} seconds. Remove any partial folder at {} before retrying.",
                    GH_CLONE_TIMEOUT.as_secs(),
                    display_path(&target)
                ),
            ));
        }
        Err(failure) => return Err(with_sign_in_hint(failure)),
    };
    if !output.status.success() {
        let detail = failure_line(&output.stderr);
        if signed_out(&detail.to_ascii_lowercase()) {
            return Err(fail(
                "GH_UNAVAILABLE",
                format!("GitHub CLI is not signed in. {GH_SIGN_IN_HINT}"),
            ));
        }
        return Err(fail(
            "CLONE_FAILED",
            if detail.is_empty() {
                format!("GitHub CLI could not clone {full_name} ({}).", output.status)
            } else {
                format!("GitHub CLI could not clone {full_name}: {detail}")
            },
        ));
    }
    read_clone(&target, full_name.to_owned(), "CLONE_FAILED").await
}

/// Creates `name` in the signed-in GitHub CLI account (with a README) and
/// clones it into `<parent_dir>/<name>`. Uses gh's own sign-in; no token is
/// read, passed or printed.
#[tauri::command]
pub(crate) async fn github_create_repo(
    name: String,
    description: Option<String>,
    private: bool,
    parent_dir: String,
) -> Value {
    let description = description.unwrap_or_default();
    match create_repo(&name, &description, private, &parent_dir).await {
        Ok(data) => ok(data),
        Err((code, message)) => error(code, message),
    }
}

/// Clones `owner/name` into `<parent_dir>/<name>` with the GitHub CLI.
#[tauri::command]
pub(crate) async fn github_clone_repo(full_name: String, parent_dir: String) -> Value {
    match clone_repo(&full_name, &parent_dir).await {
        Ok(data) => ok(data),
        Err((code, message)) => error(code, message),
    }
}

// ---------------------------------------------------------------- attachments

const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
    "COM8", "COM9", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn trim_name(name: &str) -> &str {
    name.trim_start_matches(['.', ' '])
        .trim_end_matches(['.', ' '])
}

/// Keeps [A-Za-z0-9._ -()], collapses other runs to `_`, preserves a short
/// extension when truncating to 80 characters, avoids reserved device names.
fn sanitize_name(raw: &str) -> String {
    let mut cleaned = String::new();
    let mut replaced = false;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ' ' | '-' | '(' | ')') {
            cleaned.push(ch);
            replaced = false;
        } else if !replaced {
            cleaned.push('_');
            replaced = true;
        }
    }
    let mut name = trim_name(&cleaned).to_owned();
    if name.len() > 80 {
        name = match name.rfind('.') {
            Some(dot) if dot > 0 && name.len() - dot <= 16 => {
                let extension = name[dot..].to_owned();
                format!("{}{extension}", &name[..80 - extension.len()])
            }
            _ => name[..80].to_owned(),
        };
        name = trim_name(&name).to_owned();
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        name = format!("_{name}");
        name.truncate(80);
    }
    if name.is_empty() || name.chars().all(|c| c == '_') {
        "attachment".to_owned()
    } else {
        name
    }
}

fn save_attachment(ui: &Path, name: &str, encoded: &str) -> Result<Value, Failure> {
    let mut encoded = encoded.trim();
    if encoded.starts_with("data:")
        && let Some((_, payload)) = encoded.split_once(";base64,")
    {
        encoded = payload;
    }
    let too_large = || {
        fail(
            "ATTACHMENT_TOO_LARGE",
            format!("Attachments are limited to {ATTACHMENT_LIMIT} bytes."),
        )
    };
    if encoded.len() > ATTACHMENT_LIMIT.div_ceil(3) * 4 {
        return Err(too_large());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| fail("ATTACHMENT_INVALID", "The attachment is not valid base64."))?;
    if bytes.len() > ATTACHMENT_LIMIT {
        return Err(too_large());
    }
    let clean = sanitize_name(name);
    let attachments = ui.join(ATTACHMENTS_DIR);
    let day = attachments.join(chrono::Local::now().format("%Y-%m-%d").to_string());
    ensure_dir(ui)?;
    ensure_dir(&attachments)?;
    ensure_dir(&day)?;
    for _ in 0..8 {
        let mut random = [0u8; 4];
        getrandom::fill(&mut random)
            .map_err(|_| fail("WRITE_FAILED", "Secure randomness is unavailable."))?;
        let prefix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let path = day.join(format!("{prefix}-{clean}"));
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(fail(
                    "WRITE_FAILED",
                    format!("Could not save the attachment: {e}"),
                ));
            }
        };
        if let Err(e) = file.write_all(&bytes).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(fail(
                "WRITE_FAILED",
                format!("Could not save the attachment: {e}"),
            ));
        }
        return Ok(json!({
            "path": display_path(&path),
            "name": clean,
            "bytes": bytes.len(),
        }));
    }
    Err(fail(
        "WRITE_FAILED",
        "Could not allocate a unique attachment name.",
    ))
}

#[tauri::command]
pub(crate) async fn attachment_save(
    app: tauri::AppHandle,
    name: String,
    data_base64: String,
) -> Value {
    let ui = match writable_ui_dir(&app) {
        Ok(ui) => ui,
        Err((code, message)) => return error(code, message),
    };
    blocking(move || save_attachment(&ui, &name, &data_base64)).await
}

// ---------------------------------------------------------------- window/shell

#[cfg(windows)]
fn send_voice_typing_chord() -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
        KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY, VK_H, VK_LWIN,
    };
    let key = |vk: VIRTUAL_KEY, extended: bool, up: bool| {
        let mut flags = 0;
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY.0;
        }
        if up {
            flags |= KEYEVENTF_KEYUP.0;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: KEYBD_EVENT_FLAGS(flags),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    };
    let chord = [
        key(VK_LWIN, true, false),
        key(VK_H, false, false),
        key(VK_H, false, true),
        key(VK_LWIN, true, true),
    ];
    let size = std::mem::size_of::<INPUT>() as i32;
    let sent = unsafe { SendInput(&chord, size) };
    if sent as usize == chord.len() {
        return Ok(());
    }
    if sent > 0 {
        // Never leave the Windows key logically held down.
        let release = [key(VK_H, false, true), key(VK_LWIN, true, true)];
        unsafe { SendInput(&release, size) };
    }
    Err("Windows blocked the voice typing shortcut (Win+H).".into())
}

#[tauri::command]
pub(crate) async fn dictation_start(window: tauri::WebviewWindow) -> Value {
    #[cfg(windows)]
    {
        if let Err(e) = window.set_focus() {
            return error("DICTATION_FAILED", e.to_string());
        }
        // Let the focus change reach the webview before the chord arrives.
        tokio::time::sleep(Duration::from_millis(150)).await;
        match send_voice_typing_chord() {
            Ok(()) => ok(json!({"started": true})),
            Err(message) => error("DICTATION_FAILED", message),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        ok(json!({
            "started": false,
            "reason": "System voice typing is available on Windows only.",
        }))
    }
}

#[tauri::command]
pub(crate) async fn window_attention(window: tauri::WebviewWindow) -> Value {
    let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    ok(json!({}))
}

/// http(s) URLs without embedded credentials, or an existing local folder.
fn external_target(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 4096 {
        return Err("Nothing valid to open.".into());
    }
    if let Ok(url) = url::Url::parse(raw)
        && matches!(url.scheme(), "http" | "https")
    {
        if !url.username().is_empty() || url.password().is_some() {
            return Err("Links with embedded credentials are not opened.".into());
        }
        if url.host_str().is_none_or(str::is_empty) {
            return Err("The link has no host.".into());
        }
        return Ok(url.to_string());
    }
    existing_directory(raw)
        .map(|path| display_path(&path))
        .map_err(|_| "Only http(s) links and existing local folders can be opened.".into())
}

#[cfg(windows)]
fn shell_open(target: &str) -> Result<(), String> {
    use windows::{
        Win32::{
            System::Com::{
                COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
            },
            UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        },
        core::{PCWSTR, w},
    };
    let wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        // Shell handlers may use COM; initialize this dedicated thread first.
        let initialized =
            CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).is_ok();
        let result = ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
        if initialized {
            CoUninitialize();
        }
        let code = result.0 as isize;
        if code > 32 {
            Ok(())
        } else {
            Err(format!("Windows could not open the target (code {code})."))
        }
    }
}

#[tauri::command]
pub(crate) async fn open_external(target: String) -> Value {
    let checked = tauri::async_runtime::spawn_blocking(move || external_target(&target)).await;
    let resolved = match checked {
        Ok(Ok(resolved)) => resolved,
        Ok(Err(message)) => return error("OPEN_REFUSED", message),
        Err(_) => return error("OPEN_REFUSED", "The target could not be checked."),
    };
    #[cfg(windows)]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let target = resolved.clone();
        if let Err(e) = std::thread::Builder::new()
            .name("open-external".into())
            .spawn(move || {
                let _ = sender.send(shell_open(&target));
            })
        {
            return error("OPEN_FAILED", e.to_string());
        }
        match receiver.await {
            Ok(Ok(())) => ok(json!({"opened": true, "target": resolved})),
            Ok(Err(message)) => error("OPEN_FAILED", message),
            Err(_) => error("OPEN_FAILED", "The shell closed unexpectedly."),
        }
    }
    #[cfg(not(windows))]
    {
        error(
            "OPEN_UNAVAILABLE",
            format!("Open {resolved} from your file manager or browser on this platform."),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collab_repo_keeps_other_owners_and_trims_fields() {
        let org = json!({
            "name": "payments-api", "owner": {"login": "deloresai", "type": "Organization", "id": 7},
            "private": true, "size": 1800, "language": "Go", "stargazers_count": 4,
            "pushed_at": "2026-10-01T10:00:00Z", "default_branch": "main",
            "permissions": {"admin": false, "maintain": false, "push": true, "triage": true, "pull": true},
            "html_url": "https://example.invalid/elsewhere", "description": "not returned",
        });
        let repo = collab_repo(&org, "delores88").expect("an organization repository is kept");
        assert_eq!(repo["full_name"], "deloresai/payments-api");
        assert_eq!(repo["owner"], json!({"login": "deloresai", "type": "Organization"}));
        assert_eq!(repo["html_url"], "https://github.com/deloresai/payments-api");
        assert_eq!(repo["permissions"]["push"], true);
        assert_eq!(repo["permissions"]["admin"], false);
        assert_eq!(repo["size_kb"], 1800);
        assert!(repo.get("description").is_none());

        let own = json!({"name": "dotfiles", "owner": {"login": "Delores88", "type": "User"}});
        assert!(collab_repo(&own, "delores88").is_none(), "the viewer's own repositories are excluded");
        let bad = json!({"name": "../x", "owner": {"login": "someone", "type": "User"}});
        assert!(collab_repo(&bad, "delores88").is_none(), "malformed names are dropped");
    }
}
