//! Optional git worktree per chat (0.5). A new chat in a git project can run
//! in its own worktree on branch `codaclauda/<short id>`, kept under the
//! board's `desktop-ui/worktrees/<short>/<repo folder>` (outside the project,
//! so nothing lands in the repository or a synced Desktop folder). Diff shows
//! changes against the commit the worktree started from (or last merged);
//! apply commits them and merges the branch into the original branch in the
//! original checkout; discard removes the worktree and its branch. A PR pushes
//! the branch and runs `gh pr create`; PR and CI status come from gh.
//!
//! Git runs with fixed argv, no shell, no prompts and no window, with the same
//! hardening as desktop.rs (no fsmonitor, no signature display, no external
//! diff or textconv programs). Commit hooks stay as the repository set them.

use super::{Failure, Inner, Record, ensure_dirs, host, lock, reply};
use crate::desktop::{failure_line, gh_output, is_link};
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Output, Stdio},
    sync::Arc,
    time::Duration,
};
use tokio::{process::Command, time::timeout};

const WORKTREE_DIR: &str = "worktrees";
const GIT_QUICK: Duration = Duration::from_secs(20);
const GIT_SLOW: Duration = Duration::from_secs(120);
const GIT_PUSH: Duration = Duration::from_secs(180);
const GH_WAIT: Duration = Duration::from_secs(90);
const OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
const PATCH_LIMIT: usize = 1024 * 1024;
const FILES_LIMIT: usize = 2000;
const UNTRACKED_LIMIT: usize = 200;
const UNTRACKED_READ: u64 = 256 * 1024;
const DIFF: &[&str] = &[
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
];

/// What `create` made; the session record keeps each field.
pub(super) struct Tree {
    pub cwd: String,
    pub root: String,
    pub branch: String,
    pub repo_root: String,
    pub base_branch: Option<String>,
    pub base_commit: String,
}

fn shown(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        text.replace('/', "\\")
    } else {
        text
    }
}

async fn git(dir: &Path, args: &[&str], limit: Duration) -> Result<Output, Failure> {
    let mut command = Command::new("git");
    command
        .arg("--no-pager")
        .args(["-c", "log.showSignature=false", "-c", "core.fsmonitor="])
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ("GIT_UNAVAILABLE", "Git is not installed or not on PATH.".to_owned())
        } else {
            ("GIT_UNAVAILABLE", format!("Git could not start: {e}"))
        }
    })?;
    let pid = child.id();
    let mut wait = std::pin::pin!(child.wait_with_output());
    match timeout(limit, wait.as_mut()).await {
        Ok(Ok(output)) if output.stdout.len() <= OUTPUT_LIMIT => Ok(output),
        Ok(Ok(_)) => Err(("GIT_FAILED", "Git returned more output than CodaClauda shows.".into())),
        Ok(Err(e)) => Err(("GIT_FAILED", format!("Git failed: {e}"))),
        Err(_) => {
            // A push may run credential helpers and ssh; end the whole tree.
            #[cfg(windows)]
            if let Some(pid) = pid {
                crate::desktop::kill_tree(pid).await;
            }
            #[cfg(not(windows))]
            let _ = pid;
            Err(("GIT_TIMEOUT", "Git did not finish in time.".into()))
        }
    }
}

/// Successful git output, trimmed; a failure carries git's telling line.
async fn git_ok(dir: &Path, args: &[&str], limit: Duration) -> Result<String, Failure> {
    let output = git(dir, args, limit).await?;
    if !output.status.success() {
        let line = failure_line(&output.stderr);
        return Err(("GIT_FAILED", if line.is_empty() { format!("git {} failed.", args[0]) } else { line }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn make_dir(path: &Path) -> Result<(), Failure> {
    match fs::create_dir(path) {
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => {
            return Err(("WORKTREE_FAILED", format!("Could not create {}: {e}", shown(path))));
        }
        _ => {}
    }
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !is_link(&meta) => Ok(()),
        _ => Err(("WORKTREE_FAILED", format!("{} must be a real folder.", shown(path)))),
    }
}

/// Adds a worktree for session `id` of the repository containing `cwd`.
pub(super) async fn create(dir: &Path, id: &str, cwd: &Path) -> Result<Tree, Failure> {
    let not_repo = |_| {
        (
            "NOT_A_GIT_REPO",
            format!("{} is not inside a git repository; start the chat without a worktree.", shown(cwd)),
        )
    };
    let top = git_ok(cwd, &["rev-parse", "--show-toplevel"], GIT_QUICK).await.map_err(not_repo)?;
    let prefix = git_ok(cwd, &["rev-parse", "--show-prefix"], GIT_QUICK).await.unwrap_or_default();
    let base_commit = git_ok(cwd, &["rev-parse", "--verify", "HEAD"], GIT_QUICK).await.map_err(|_| {
        (
            "WORKTREE_FAILED",
            "This repository has no commits yet; commit once before starting a worktree chat.".to_owned(),
        )
    })?;
    let base_branch = git_ok(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"], GIT_QUICK)
        .await
        .ok()
        .filter(|b| !b.is_empty());
    let short = id.get(2..10).unwrap_or(id);
    let branch = format!("codaclauda/{short}");
    let repo_root = PathBuf::from(shown(Path::new(&top)));
    let folder = repo_root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "project".into());
    ensure_dirs(dir).map_err(|e| ("WORKTREE_FAILED", format!("Session storage is unavailable: {e}")))?;
    let holder = dir.join(WORKTREE_DIR);
    make_dir(&holder)?;
    let holder = holder.join(short);
    make_dir(&holder)?;
    let root = holder.join(&folder);
    let root_text = root.to_string_lossy().into_owned();
    git_ok(&repo_root, &["worktree", "add", "-b", &branch, &root_text, "HEAD"], GIT_SLOW)
        .await
        .map_err(|(_, m)| ("WORKTREE_FAILED", format!("Git could not create the worktree: {m}")))?;
    let mut session_cwd = root.clone();
    for part in prefix.split('/').filter(|p| !p.is_empty()) {
        session_cwd.push(part);
    }
    if !session_cwd.is_dir() {
        session_cwd = root.clone();
    }
    Ok(Tree {
        cwd: shown(&session_cwd),
        root: shown(&root),
        branch,
        repo_root: shown(&repo_root),
        base_branch,
        base_commit,
    })
}

/// Best effort: undo a worktree whose session was never saved.
pub(super) async fn remove(tree: &Tree) {
    let repo = PathBuf::from(&tree.repo_root);
    let _ = git(&repo, &["worktree", "remove", "--force", &tree.root], GIT_SLOW).await;
    let _ = git(&repo, &["branch", "-D", &tree.branch], GIT_QUICK).await;
    if let Some(holder) = Path::new(&tree.root).parent() {
        let _ = fs::remove_dir(holder);
    }
}

fn status_name(code: &str) -> &'static str {
    match code.chars().next() {
        Some('A') => "added",
        Some('D') => "deleted",
        Some('T') => "typechange",
        Some('U') => "unmerged",
        _ => "modified",
    }
}

fn fields(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|b| *b == 0)
        .filter(|f| !f.is_empty())
        .map(|f| String::from_utf8_lossy(f).into_owned())
        .collect()
}

/// One untracked file as a "new file" patch, plus its line count.
fn untracked_patch(root: &Path, relative: &str) -> Option<(String, u64)> {
    let path = root.join(relative);
    let meta = fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || is_link(&meta) {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(&path).ok()?.take(UNTRACKED_READ).read_to_end(&mut bytes).ok()?;
    let head = format!("diff --git a/{relative} b/{relative}\nnew file mode 100644\n");
    if bytes.contains(&0) {
        return Some((format!("{head}Binary files /dev/null and b/{relative} differ\n"), 0));
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().collect();
    let mut patch = format!("{head}--- /dev/null\n+++ b/{relative}\n@@ -0,0 +1,{} @@\n", lines.len());
    for line in &lines {
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
    }
    if meta.len() > UNTRACKED_READ {
        patch.push_str("+… (file continues; too large to show)\n");
    }
    Some((patch, lines.len() as u64))
}

fn cut(text: &mut String, limit: usize) -> bool {
    if text.len() <= limit {
        return false;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    true
}

impl Inner {
    /// No turn, launch or queued turn may be using the session.
    fn require_idle(&self, id: &str) -> Result<(), Failure> {
        let state = lock(&self.state);
        if state.session_busy(id) || state.queues.get(id).is_some_and(|q| !q.is_empty()) {
            return Err((
                "SESSION_BUSY",
                "Wait for the agent to finish (or stop it) first.".into(),
            ));
        }
        Ok(())
    }

    fn worktree_of(record: &Record) -> Result<(PathBuf, String), Failure> {
        match (&record.worktree_path, &record.branch) {
            (Some(root), Some(branch)) if Path::new(root).is_dir() => {
                Ok((PathBuf::from(root), branch.clone()))
            }
            (Some(_), Some(_)) => Err((
                "WORKTREE_MISSING",
                "This chat's worktree folder is gone.".into(),
            )),
            _ => Err((
                "NO_WORKTREE",
                "This chat does not have its own worktree.".into(),
            )),
        }
    }

    /// Stages everything in the worktree and commits it when anything changed.
    async fn commit_all(root: &Path, message: &str) -> Result<bool, Failure> {
        git_ok(root, &["add", "-A"], GIT_SLOW).await?;
        let staged = git(root, &["diff", "--cached", "--quiet"], GIT_QUICK).await?;
        if staged.status.code() != Some(1) {
            return Ok(false);
        }
        git_ok(root, &["commit", &format!("--message={message}")], GIT_SLOW)
            .await
            .map_err(|(_, m)| ("COMMIT_FAILED", format!("Git could not commit: {m}")))?;
        Ok(true)
    }

    async fn diff(&self, id: &str) -> Result<Value, Failure> {
        let record = self.record_of(id)?;
        let (root, base) = match (&record.worktree_path, &record.base_commit) {
            (Some(_), Some(base)) => (Self::worktree_of(&record)?.0, base.clone()),
            _ => {
                let top = git_ok(Path::new(&record.cwd), &["rev-parse", "--show-toplevel"], GIT_QUICK)
                    .await
                    .map_err(|_| ("NOT_A_GIT_REPO", "This chat's folder is not a git repository.".to_owned()))?;
                (PathBuf::from(shown(Path::new(&top))), "HEAD".to_owned())
            }
        };
        let with = |extra: &[&str]| -> Vec<String> {
            DIFF.iter().chain(extra).map(|s| (*s).to_owned()).collect()
        };
        let run = |args: Vec<String>| {
            let root = root.clone();
            async move {
                let args: Vec<&str> = args.iter().map(String::as_str).collect();
                git(&root, &args, GIT_SLOW).await
            }
        };
        let base = base.as_str();
        let (numstat, names, patch, others) = tokio::join!(
            run(with(&["--numstat", "-z", base])),
            run(with(&["--name-status", "-z", base])),
            run(with(&[base])),
            run(vec!["ls-files".into(), "--others".into(), "--exclude-standard".into(), "-z".into()]),
        );
        let (numstat, names, patch, others) = (numstat?, names?, patch?, others?);
        if !patch.status.success() {
            return Err(("GIT_FAILED", failure_line(&patch.stderr)));
        }
        let mut counts = std::collections::HashMap::new();
        for line in fields(&numstat.stdout) {
            let mut parts = line.splitn(3, '\t');
            let (Some(add), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
                continue;
            };
            counts.insert(path.to_owned(), (add.parse::<u64>().unwrap_or(0), del.parse::<u64>().unwrap_or(0)));
        }
        let mut files = Vec::new();
        let name_fields = fields(&names.stdout);
        for pair in name_fields.chunks(2) {
            let [code, path] = pair else { continue };
            let (additions, deletions) = counts.get(path).copied().unwrap_or((0, 0));
            files.push(json!({"path": path, "status": status_name(code), "additions": additions, "deletions": deletions}));
        }
        let mut text = String::from_utf8_lossy(&patch.stdout).into_owned();
        for relative in fields(&others.stdout).iter().take(UNTRACKED_LIMIT) {
            if let Some((added, lines)) = untracked_patch(&root, relative) {
                files.push(json!({"path": relative, "status": "added", "additions": lines, "deletions": 0}));
                text.push_str(&added);
            }
            if text.len() > PATCH_LIMIT {
                break;
            }
        }
        let mut truncated = fields(&others.stdout).len() > UNTRACKED_LIMIT || files.len() > FILES_LIMIT;
        files.truncate(FILES_LIMIT);
        truncated |= cut(&mut text, PATCH_LIMIT);
        Ok(json!({"files": files, "patch": text, "truncated": truncated}))
    }

    async fn apply(&self, id: &str, message: Option<&str>) -> Result<Value, Failure> {
        let record = self.record_of(id)?;
        self.require_idle(id)?;
        let (root, branch) = Self::worktree_of(&record)?;
        let message: String = message
            .map(|m| m.trim().chars().filter(|c| *c == '\n' || !c.is_control()).take(4000).collect())
            .filter(|m: &String| !m.trim().is_empty())
            .unwrap_or_else(|| format!("CodaClauda: {}", record.title));
        let committed = Self::commit_all(&root, &message).await?;
        let mut merged = false;
        if let (Some(repo), Some(base)) = (&record.repo_root, &record.base_branch) {
            let repo = PathBuf::from(repo);
            let current = git_ok(&repo, &["symbolic-ref", "--quiet", "--short", "HEAD"], GIT_QUICK)
                .await
                .unwrap_or_default();
            if &current != base {
                return Err((
                    "BASE_NOT_CHECKED_OUT",
                    format!(
                        "Check out {base} in {} first (it has {} checked out). The changes {} on {branch}.",
                        shown(&repo),
                        if current.is_empty() { "a detached HEAD".to_owned() } else { current },
                        if committed { "were committed" } else { "stay" }
                    ),
                ));
            }
            let range = format!("{base}..{branch}");
            let ahead = git_ok(&repo, &["rev-list", "--count", &range], GIT_QUICK)
                .await?
                .parse::<u64>()
                .unwrap_or(0);
            if ahead > 0 {
                if let Err((_, problem)) = git_ok(&repo, &["merge", "--no-edit", &branch], GIT_SLOW).await {
                    let _ = git(&repo, &["merge", "--abort"], GIT_QUICK).await;
                    return Err((
                        "MERGE_FAILED",
                        format!("Git could not merge {branch} into {base}: {problem} The merge was aborted; the changes stay committed on {branch}."),
                    ));
                }
                merged = true;
            }
        }
        if merged {
            let head = git_ok(&root, &["rev-parse", "HEAD"], GIT_QUICK).await?;
            let _ = self.with_record(id, |r| r.base_commit = Some(head));
        }
        Ok(json!({"committed": committed, "merged": merged, "branch": branch}))
    }

    async fn discard(self: &Arc<Self>, id: &str) -> Result<Value, Failure> {
        let record = self.record_of(id)?;
        self.require_idle(id)?;
        let (Some(root), Some(branch), Some(repo)) = (&record.worktree_path, &record.branch, &record.repo_root) else {
            return Err(("NO_WORKTREE", "This chat does not have its own worktree.".into()));
        };
        if lock(&self.state).live.contains_key(id) {
            self.close(id)?;
            for _ in 0..100 {
                if !lock(&self.state).live.contains_key(id) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            if lock(&self.state).live.contains_key(id) {
                return Err((
                    "SESSION_BUSY",
                    "The agent has not confirmed it stopped; try again in a moment.".into(),
                ));
            }
        }
        let repo = PathBuf::from(repo);
        let mut removed = false;
        for _ in 0..4 {
            let done = git(&repo, &["worktree", "remove", "--force", root], GIT_SLOW).await;
            if done.is_ok_and(|o| o.status.success()) || !Path::new(root).exists() {
                removed = true;
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        let _ = git(&repo, &["worktree", "prune"], GIT_QUICK).await;
        if !removed {
            return Err((
                "WORKTREE_BUSY",
                "Git could not remove the worktree; a program may still have files open in it. Close it and try again.".into(),
            ));
        }
        let _ = git(&repo, &["branch", "-D", branch], GIT_QUICK).await;
        if let Some(holder) = Path::new(root).parent() {
            let _ = fs::remove_dir(holder);
        }
        self.with_record(id, |r| {
            r.worktree_path = None;
            r.branch = None;
            r.base_commit = None;
            r.status = "stopped".into();
        })
        .map_err(|message| ("STORAGE_FAILED", message))?;
        self.publish(super::event(id, None, "status", json!({"status": "stopped"})), false);
        Ok(json!({"discarded": true}))
    }

    async fn pr_create(&self, id: &str, title: &str, body: &str) -> Result<Value, Failure> {
        let record = self.record_of(id)?;
        self.require_idle(id)?;
        let (root, branch) = Self::worktree_of(&record)?;
        let title: String = title.trim().chars().filter(|c| !c.is_control()).take(256).collect();
        if title.is_empty() {
            return Err(("INVALID_ARGUMENTS", "Give the pull request a title.".into()));
        }
        if body.len() > 60_000 {
            return Err(("INPUT_TOO_LARGE", "The pull request description is too long.".into()));
        }
        Self::commit_all(&root, &title).await?;
        git_ok(&root, &["push", "--set-upstream", "origin", &branch], GIT_PUSH)
            .await
            .map_err(|(_, m)| ("PUSH_FAILED", format!("Git could not push {branch}: {m}")))?;
        let title_arg = format!("--title={title}");
        let body_arg = format!("--body={body}");
        let mut args = vec!["pr", "create", "--head", branch.as_str()];
        if let Some(base) = &record.base_branch {
            args.extend(["--base", base.as_str()]);
        }
        args.extend([title_arg.as_str(), body_arg.as_str()]);
        let output = gh_output(&args, GH_WAIT, Some(&root)).await?;
        if !output.status.success() {
            return Err(("PR_FAILED", format!("GitHub CLI could not create the pull request: {}", failure_line(&output.stderr))));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let url = stdout
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with("https://") && l.contains("/pull/"))
            .ok_or(("PR_FAILED", "GitHub CLI did not report the new pull request.".to_owned()))?
            .to_owned();
        let number = url.rsplit('/').next().and_then(|n| n.parse::<u64>().ok());
        let _ = self.with_record(id, |r| {
            r.pr_url = Some(url.clone());
            r.pr_number = number;
        });
        Ok(json!({"url": url, "number": number}))
    }

    async fn pr_status(&self, id: &str) -> Result<Value, Failure> {
        let record = self.record_of(id)?;
        let none = json!({"url": null, "state": null, "checks": []});
        let Some(target) = record.branch.clone().or_else(|| record.pr_url.clone()) else {
            return Ok(none);
        };
        let dir = [&record.worktree_path, &record.repo_root, &Some(record.cwd.clone())]
            .into_iter()
            .flatten()
            .map(PathBuf::from)
            .find(|p| p.is_dir())
            .ok_or(("PROJECT_MISSING", "The chat's folder is not available.".to_owned()))?;
        let output = gh_output(
            &["pr", "view", &target, "--json", "url,state,statusCheckRollup"],
            GH_WAIT,
            Some(&dir),
        )
        .await?;
        if !output.status.success() {
            let line = failure_line(&output.stderr);
            if line.to_ascii_lowercase().contains("no pull requests found") {
                return Ok(none);
            }
            return Err(("GH_UNAVAILABLE", format!("GitHub CLI could not read the pull request: {line}")));
        }
        let pr: Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| ("GH_UNAVAILABLE", "GitHub CLI returned unreadable pull request data.".to_owned()))?;
        let lower = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_ascii_lowercase);
        let checks: Vec<Value> = pr["statusCheckRollup"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| {
                // CheckRun has name/status/conclusion; StatusContext has context/state.
                let state = lower(&c["state"]);
                let pending = matches!(state.as_deref(), Some("pending" | "expected"));
                json!({
                    "name": c["name"].as_str().or(c["context"].as_str()).unwrap_or("check"),
                    "status": lower(&c["status"]).unwrap_or_else(|| if pending { "in_progress".into() } else { "completed".into() }),
                    "conclusion": lower(&c["conclusion"]).or(if pending { None } else { state }),
                })
            })
            .collect();
        if let Some(url) = pr["url"].as_str().filter(|u| record.pr_url.as_deref() != Some(*u)) {
            let url = url.to_owned();
            let _ = self.with_record(id, |r| r.pr_url = Some(url));
        }
        Ok(json!({"url": pr["url"], "state": lower(&pr["state"]), "checks": checks}))
    }
}

// ----------------------------------------------------------------- commands

#[tauri::command]
pub(crate) async fn session_diff(app: tauri::AppHandle, id: String) -> Value {
    let inner = host(&app);
    reply(inner.diff(&id).await)
}

#[tauri::command]
pub(crate) async fn session_worktree_apply(
    app: tauri::AppHandle,
    id: String,
    message: Option<String>,
) -> Value {
    let inner = host(&app);
    reply(inner.apply(&id, message.as_deref()).await)
}

#[tauri::command]
pub(crate) async fn session_worktree_discard(app: tauri::AppHandle, id: String) -> Value {
    let inner = host(&app);
    reply(inner.discard(&id).await)
}

#[tauri::command]
pub(crate) async fn session_pr_create(
    app: tauri::AppHandle,
    id: String,
    title: String,
    body: Option<String>,
) -> Value {
    let inner = host(&app);
    reply(inner.pr_create(&id, &title, body.as_deref().unwrap_or("")).await)
}

#[tauri::command]
pub(crate) async fn session_pr_status(app: tauri::AppHandle, id: String) -> Value {
    let inner = host(&app);
    reply(inner.pr_status(&id).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untracked_files_become_new_file_patches() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), "one\ntwo\n").unwrap();
        let (patch, lines) = untracked_patch(dir.path(), "note.txt").unwrap();
        assert_eq!(lines, 2);
        assert!(patch.contains("@@ -0,0 +1,2 @@\n+one\n+two\n"));
        assert_eq!(status_name("M"), "modified");
        let mut text = "aé".to_owned();
        assert!(cut(&mut text, 2) && text == "a");
    }
}
