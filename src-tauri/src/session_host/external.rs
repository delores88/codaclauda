//! Detect Claude Code and Codex sessions already on this machine (0.5), from
//! metadata only. Claude: `<config>/projects/<encoded cwd>/<session>.jsonl`;
//! the folder name is decoded back to a real directory by matching existing
//! folder names, never by reading the transcript. Codex keeps its working
//! folder only inside each rollout's first record (`session_meta`), so only
//! that one line is parsed and every field but `cwd` and `id` is dropped. No
//! credential file is opened and nothing is copied or changed.
//!
//! 0.6: each row carries its `providerSessionId` (Claude: the file stem; Codex:
//! the `session_meta` id), and `session_adopt` starts a CodaClauda session that
//! resumes that exact conversation (Claude `--resume <id>`, Codex
//! `thread/resume <id>`) at the project's current access, Read when the folder
//! is neither a linked project nor the owner's own. Only file names are
//! matched to find a conversation; its contents are never read here.
//!
//! Continue is refused while another app may still write the conversation
//! (it changed in the last 15 minutes, or a Codex thread is bound for Wake
//! by mail in `desktop_queue.rs`), so one conversation never has two writers.
//! The refusal offers Fork instead: a separate, labeled copy made on its
//! first launch by the existing fork path (Claude `--resume <id>
//! --fork-session`, Codex `thread/fork`); the original is never changed.
//! Neither action wakes or updates the other app's window.

use super::{Failure, Inner, Provider, Record, desktop_queue, host, lock, now_ms, random_hex, reply};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const ACTIVE_MS: u64 = 15 * 60 * 1000;
const PER_PROVIDER: usize = 200;
const FIRST_LINE: u64 = 256 * 1024;
const DIR_ENTRIES: usize = 4000;
const RESOLVE_BUDGET: usize = 64;

pub(super) fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

fn real_dir(entry: &fs::DirEntry) -> bool {
    entry
        .file_type()
        .is_ok_and(|t| t.is_dir() && !t.is_symlink())
}

/// Claude's folder encoding: every character other than an ASCII letter or
/// digit becomes '-'.
fn encode(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn walk(dir: &Path, rest: &str, budget: &mut usize) -> Option<PathBuf> {
    if rest.is_empty() {
        return Some(dir.to_path_buf());
    }
    if *budget == 0 {
        return None;
    }
    *budget -= 1;
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.take(DIR_ENTRIES).flatten().filter(real_dir) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let encoded = encode(&name);
        if encoded.is_empty() {
            continue;
        }
        if rest == encoded {
            return Some(entry.path());
        }
        if let Some(tail) = rest.strip_prefix(encoded.as_str()).and_then(|t| t.strip_prefix('-')) {
            if let Some(found) = walk(&entry.path(), tail, budget) {
                return Some(found);
            }
        }
    }
    None
}

/// The real folder a Claude project directory name stands for, else a
/// best-effort reading of the name.
fn claude_cwd(encoded: &str) -> String {
    let bytes = encoded.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b'-' && bytes[2] == b'-' {
        let drive = char::from(bytes[0]);
        let rest = encoded.get(3..).unwrap_or("");
        let mut budget = RESOLVE_BUDGET;
        if let Some(found) = walk(&PathBuf::from(format!("{drive}:\\")), rest, &mut budget) {
            return found.to_string_lossy().into_owned();
        }
        return format!("{drive}:\\{}", rest.replace('-', "\\"));
    }
    encoded.replace('-', "/")
}

fn hint(cwd: &str) -> String {
    cwd.trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .to_owned()
}

fn entry(provider: &str, cwd: Option<String>, id: Option<String>, modified: u64, now: u64, owned: bool) -> Value {
    json!({
        "provider": provider,
        "projectHint": cwd.as_deref().map(hint),
        "cwd": cwd,
        "providerSessionId": id,
        "modifiedAt": modified,
        "active": now.saturating_sub(modified) < ACTIVE_MS,
        "owned": owned,
    })
}

/// The provider's normal sign-in folder (its own environment override, else
/// the default under the user profile). Only file names under it are matched.
pub(super) fn normal_home(provider: Provider) -> Option<PathBuf> {
    match provider {
        Provider::Claude => env_dir("CLAUDE_CONFIG_DIR").or_else(|| env_dir("USERPROFILE").map(|h| h.join(".claude"))),
        Provider::Codex => env_dir("CODEX_HOME").or_else(|| env_dir("USERPROFILE").map(|h| h.join(".codex"))),
    }
}

/// Claude and Codex conversation ids are UUIDs; nothing else reaches argv.
pub(super) fn conversation_id(id: &str) -> bool {
    id.len() == 36
        && id.char_indices().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() }
        })
}

/// `<normal config>/projects/*/<session>.jsonl`, by name only.
pub(super) fn claude_transcript(session: &str) -> Option<PathBuf> {
    if !conversation_id(session) {
        return None;
    }
    let projects = normal_home(Provider::Claude)?.join("projects");
    let name = format!("{session}.jsonl");
    fs::read_dir(&projects)
        .ok()?
        .take(DIR_ENTRIES)
        .flatten()
        .filter(real_dir)
        .map(|project| project.path().join(&name))
        .find(|path| fs::symlink_metadata(path).is_ok_and(|m| m.is_file()))
}

/// `<normal CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`, by name only.
pub(super) fn codex_rollout(thread: &str) -> Option<PathBuf> {
    if !conversation_id(thread) {
        return None;
    }
    rollout_in(&normal_home(Provider::Codex)?.join("sessions"), thread)
}

pub(super) fn rollout_in(root: &Path, thread: &str) -> Option<PathBuf> {
    let suffix = format!("-{thread}.jsonl");
    for year in sorted_children(root, true) {
        for month in sorted_children(&year, true) {
            for day in sorted_children(&month, true) {
                for path in sorted_children(&day, false) {
                    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    if name.starts_with("rollout-") && name.ends_with(&suffix) {
                        return Some(path);
                    }
                }
            }
        }
    }
    None
}

fn claude_sessions(owned: &HashSet<String>, now: u64) -> Vec<Value> {
    let Some(projects) = normal_home(Provider::Claude).map(|c| c.join("projects")) else {
        return Vec::new();
    };
    let Ok(dirs) = fs::read_dir(&projects) else {
        return Vec::new();
    };
    let mut found: Vec<(u64, Value)> = Vec::new();
    let mut decoded: HashMap<String, String> = HashMap::new();
    for project in dirs.take(DIR_ENTRIES).flatten().filter(real_dir) {
        let encoded = project.file_name().to_string_lossy().into_owned();
        let Ok(files) = fs::read_dir(project.path()) else {
            continue;
        };
        for file in files.take(DIR_ENTRIES).flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let modified = modified_ms(&meta);
            let cwd = decoded
                .entry(encoded.clone())
                .or_insert_with(|| claude_cwd(&encoded))
                .clone();
            let is_owned = owned.contains(&stem);
            found.push((modified, entry("claude", Some(cwd), Some(stem), modified, now, is_owned)));
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().take(PER_PROVIDER).map(|(_, v)| v).collect()
}

/// Only `payload.cwd` and `payload.id` of the first record are kept.
pub(super) fn codex_meta(path: &Path) -> (Option<String>, Option<String>) {
    let read = || -> Option<Value> {
        let file = fs::File::open(path).ok()?;
        let mut line = Vec::new();
        BufReader::new(file.take(FIRST_LINE)).read_until(b'\n', &mut line).ok()?;
        serde_json::from_slice(&line).ok()
    };
    let Some(first) = read() else {
        return (None, None);
    };
    let text = |v: &Value| v.as_str().map(str::to_owned);
    (text(&first["payload"]["cwd"]), text(&first["payload"]["id"]).filter(|id| conversation_id(id)))
}

fn sorted_children(dir: &Path, dirs: bool) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut list: Vec<PathBuf> = entries
        .take(DIR_ENTRIES)
        .flatten()
        .filter(|e| {
            e.file_type()
                .is_ok_and(|t| !t.is_symlink() && if dirs { t.is_dir() } else { t.is_file() })
        })
        .map(|e| e.path())
        .collect();
    list.sort();
    list.reverse();
    list
}

fn codex_sessions(owned: &HashSet<String>, now: u64) -> Vec<Value> {
    let Some(root) = normal_home(Provider::Codex).map(|h| h.join("sessions")) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    // sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl, newest first.
    'done: for year in sorted_children(&root, true) {
        for month in sorted_children(&year, true) {
            for day in sorted_children(&month, true) {
                for path in sorted_children(&day, false) {
                    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
                        continue;
                    }
                    let Ok(meta) = fs::symlink_metadata(&path) else {
                        continue;
                    };
                    let thread = name
                        .trim_end_matches(".jsonl")
                        .get(name.len().saturating_sub(6 + 36)..)
                        .unwrap_or("")
                        .to_owned();
                    let modified = modified_ms(&meta);
                    let (cwd, id) = codex_meta(&path);
                    let is_owned = owned.contains(&thread) || id.as_ref().is_some_and(|id| owned.contains(id));
                    found.push(entry("codex", cwd, id, modified, now, is_owned));
                    if found.len() >= PER_PROVIDER {
                        break 'done;
                    }
                }
            }
        }
    }
    found
}

#[tauri::command]
pub(crate) async fn external_sessions_list(app: tauri::AppHandle) -> Value {
    let owned: HashSet<String> = lock(&host(&app).state)
        .records
        .iter()
        .flat_map(|r| [r.provider_session_id.clone(), r.thread_id.clone()])
        .flatten()
        .collect();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    let found = tauri::async_runtime::spawn_blocking(move || {
        let mut all = claude_sessions(&owned, now);
        all.extend(codex_sessions(&owned, now));
        all.sort_by(|a, b| b["modifiedAt"].as_u64().cmp(&a["modifiedAt"].as_u64()));
        all
    })
    .await;
    match found {
        Ok(sessions) => reply(Ok(json!({"sessions": sessions}))),
        Err(_) => reply(Err((
            "SCAN_FAILED",
            "Looking for other sessions stopped unexpectedly.".into(),
        ))),
    }
}

/// Like the UI's normalizePath: forward slashes, no \\?\ prefix, no trailing slash, lower case.
pub(super) fn norm(path: &str) -> String {
    let mut p = path.trim().replace('\\', "/");
    if p.get(..8).is_some_and(|prefix| prefix.eq_ignore_ascii_case("//?/UNC/")) {
        p = format!("//{}", &p[8..]);
    } else if let Some(rest) = p.strip_prefix("//?/") {
        p = rest.to_owned();
    }
    p.trim_end_matches('/').to_lowercase()
}

fn within(path: &str, root: &str) -> bool {
    !root.is_empty() && (path == root || path.strip_prefix(root).is_some_and(|rest| rest.starts_with('/')))
}

/// `gh:owner/name` from a GitHub remote URL, as the UI derives project ids.
fn github_id(remote: &str) -> Option<String> {
    let (_, rest) = remote.split_once("github.com")?;
    let rest = rest.trim_start_matches([':', '/']).trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, name) = rest.split_once('/')?;
    (!owner.is_empty() && !name.is_empty() && !name.contains('/')).then(|| format!("gh:{}/{}", owner.to_lowercase(), name.to_lowercase()))
}

/// The project and access an adopted conversation gets: the deepest linked
/// local project containing the folder at its current level (Projects' saved
/// level, else Full as for every linked folder); an unlinked folder under the
/// user profile is the owner's own (Full); anything else, or settings that
/// cannot be read, is Read. Never above the project's current level.
fn adopt_access(ui: &Result<Option<Value>, String>, cwd: &str, profile: Option<&str>) -> (Option<String>, &'static str) {
    let Ok(ui) = ui else {
        return (None, "read");
    };
    let folder = norm(cwd);
    let linked = ui
        .as_ref()
        .and_then(|state| state["projects"]["local"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| Some((norm(item["path"].as_str()?), item)))
        .filter(|(path, _)| within(&folder, path))
        .max_by_key(|(path, _)| path.len());
    if let Some((path, item)) = linked {
        let id = format!("local:{path}");
        let ids = [Some(id.clone()), item["stats"]["git"]["remote"].as_str().and_then(github_id)];
        let saved = ui.as_ref().map(|state| &state["projectAccess"]);
        let level = ids
            .iter()
            .flatten()
            .find_map(|key| saved.and_then(|map| map.get(key)).filter(|r| r.is_object()))
            .map(|record| record["level"].as_str());
        let access = match level {
            None => "full",
            Some(Some("full")) => "full",
            Some(_) => "read",
        };
        return (Some(id), access);
    }
    let own = profile.map(norm).is_some_and(|home| within(&folder, &home));
    (None, if own { "full" } else { "read" })
}

/// "continue" (the default) resumes the conversation itself; "fork" makes a copy.
fn fork_mode(mode: Option<&str>) -> Result<bool, Failure> {
    match mode.map(str::trim) {
        None | Some("") | Some("continue") => Ok(false),
        Some("fork") => Ok(true),
        Some(_) => Err(("INVALID_ARGUMENTS", "mode must be continue or fork.".into())),
    }
}

fn ago_text(ms: u64) -> String {
    match ms / 60_000 {
        0 => "less than a minute".into(),
        1 => "1 minute".into(),
        n => format!("{n} minutes"),
    }
}

/// Continue would give the conversation a second writer while another app
/// may still be using it: it changed in the last 15 minutes, or (Codex) it is
/// bound for Wake by mail. Each refusal names Fork instead.
fn continue_refusal(provider: Provider, modified: u64, now: u64, bound: Option<&str>) -> Option<Failure> {
    let label = provider.label();
    if let Some(address) = bound {
        return Some(("CONVERSATION_BOUND", format!(
            "This {label} conversation wakes by mail in its own app (bound to {address}). Continuing it here too would give it two writers. Turn off Wake by mail for it first, or choose Fork instead for a separate copy."
        )));
    }
    let ago = now.saturating_sub(modified);
    (ago < ACTIVE_MS).then(|| ("CONVERSATION_ACTIVE", format!(
        "This {label} conversation changed {} ago, so it may still be open in another app. Continuing it here at the same time would give it two writers. Close it there and continue once it has had no changes for 15 minutes, or choose Fork instead for a separate copy.",
        ago_text(ago)
    )))
}

impl Inner {
    async fn adopt(&self, provider: &str, session: &str, cwd: &str, title: Option<&str>, mode: Option<&str>) -> Result<Value, Failure> {
        let provider = Provider::parse(provider)
            .ok_or(("INVALID_ARGUMENTS", "provider must be claude or codex.".to_owned()))?;
        let copy = fork_mode(mode)?;
        let session = session.trim();
        if !conversation_id(session) {
            return Err(("INVALID_ARGUMENTS", "That is not a Claude Code or Codex conversation id.".into()));
        }
        let cwd = cwd.trim();
        if cwd.is_empty() || cwd.len() > 4096 || !Path::new(cwd).is_absolute() || !Path::new(cwd).is_dir() {
            return Err(("PROJECT_MISSING", format!("{cwd} is not an existing folder on this PC.")));
        }
        // Continuing it twice would interleave two CodaClauda chats in one conversation.
        let existing = lock(&self.state)
            .records
            .iter()
            .find(|r| {
                r.provider == provider.name()
                    && (r.provider_session_id.as_deref() == Some(session) || r.thread_id.as_deref() == Some(session))
            })
            .cloned();
        if let Some(record) = existing.filter(|_| !copy) {
            return Ok(json!({"session": record, "existing": true}));
        }
        let wanted = session.to_owned();
        let found = tauri::async_runtime::spawn_blocking(move || {
            let path = match provider {
                Provider::Claude => claude_transcript(&wanted),
                Provider::Codex => codex_rollout(&wanted),
            }?;
            // The file's last change only; its contents are not read.
            Some(fs::symlink_metadata(&path).map_or(0, |meta| modified_ms(&meta)))
        })
        .await
        .map_err(|_| ("SCAN_FAILED", "Looking for that conversation stopped unexpectedly.".to_owned()))?;
        let Some(modified) = found else {
            return Err(("SESSION_NOT_FOUND", format!("That {} conversation is no longer on this PC.", provider.label())));
        };
        if !copy {
            let bound = match provider {
                Provider::Codex => desktop_queue::bound_address(&self.dir, session).map_err(|m| ("BINDINGS_UNREADABLE", m))?,
                Provider::Claude => None,
            };
            if let Some(refusal) = continue_refusal(provider, modified, now_ms(), bound.as_deref()) {
                return Err(refusal);
            }
        }
        let ui = super::schedule::read_json(&self.dir.join("ui-state.json"), 8 * 1024 * 1024);
        let profile = env_dir("USERPROFILE").map(|p| p.to_string_lossy().into_owned());
        let (project_id, access) = adopt_access(&ui, cwd, profile.as_deref());
        let title = title
            .map(|t| t.trim().chars().filter(|c| !c.is_control()).take(200).collect::<String>())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| format!("{} conversation{}", provider.label(), if copy { " (copy)" } else { "" }));
        if copy {
            return self.adopt_copy(provider, session, cwd, project_id, access, title).await;
        }
        self.start(json!({
            "provider": provider.name(), "projectId": project_id, "cwd": cwd, "access": access, "title": title,
            "adoptedFrom": {"provider": provider.name(), "providerSessionId": session},
        }))
        .await
    }

    /// Fork instead: a new CodaClauda session whose first launch copies the
    /// conversation through the existing fork path; the original is untouched
    /// and keeps its own app. A copy is never bound to or confused with it.
    async fn adopt_copy(
        &self,
        provider: Provider,
        session: &str,
        cwd: &str,
        project_id: Option<String>,
        access: &str,
        title: String,
    ) -> Result<Value, Failure> {
        if let Some(message) = lock(&self.storage_failure).clone() {
            return Err(("STORAGE_FAILED", message));
        }
        self.executable(provider).await.map_err(|message| ("AGENT_UNAVAILABLE", message))?;
        // A copy is a new session: wake on with its own board address, as in start().
        let (wake, mailbox_address) = self.default_wake(provider.name(), cwd, &title).await;
        let now = now_ms();
        let record = Record {
            id: format!("s_{}", random_hex(8)),
            provider: provider.name().into(),
            project_id: project_id.unwrap_or_else(|| cwd.to_owned()),
            cwd: cwd.to_owned(),
            title,
            wake,
            mailbox_address,
            team_note: true,
            access: access.into(),
            status: "idle".into(),
            created_at: now,
            last_activity_at: now,
            fork_from: Some(session.to_owned()),
            adopted_from: Some(json!({"provider": provider.name(), "providerSessionId": session, "copy": true})),
            ..Record::default()
        };
        let _lifecycle = lock(&self.lifecycle);
        let mut state = lock(&self.state);
        self.check_admission(&state, &record)?;
        state.records.push(record.clone());
        if let Err(message) = self.save(&state) {
            state.records.pop();
            return Err(("STORAGE_FAILED", message));
        }
        Ok(json!({"session": record, "copy": true}))
    }
}

/// { provider, providerSessionId, cwd, title?, mode? } → { session, existing?, copy? }:
/// continue an existing Claude Code or Codex conversation as a CodaClauda
/// session, or (mode "fork") start a separate copy of it.
#[tauri::command]
pub(crate) async fn session_adopt(
    app: tauri::AppHandle,
    provider: String,
    provider_session_id: String,
    cwd: String,
    title: Option<String>,
    mode: Option<String>,
) -> Value {
    let inner = host(&app);
    reply(inner.adopt(&provider, &provider_session_id, &cwd, title.as_deref(), mode.as_deref()).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adopt_uses_the_projects_current_access_and_finds_conversations_by_name_only() {
        let ui = Ok(Some(json!({
            "projects": {"local": [
                {"path": "C:\\Users\\Ben\\Work"},
                {"path": "C:\\Users\\Ben\\Work\\Locked", "stats": {"git": {"remote": "https://github.com/someone/locked.git"}}},
            ]},
            "projectAccess": {"gh:someone/locked": {"level": "read"}},
        })));
        let home = Some("C:\\Users\\Ben");
        assert_eq!(adopt_access(&ui, "C:\\Users\\Ben\\Work\\app", home), (Some("local:c:/users/ben/work".into()), "full"));
        // The deepest linked project wins, found by its GitHub id too.
        assert_eq!(adopt_access(&ui, "c:/users/ben/work/locked/", home).1, "read");
        assert_eq!(adopt_access(&ui, "C:\\Users\\Ben\\Elsewhere", home), (None, "full"));
        assert_eq!(adopt_access(&ui, "D:\\Shared\\x", home), (None, "read"));
        assert_eq!(adopt_access(&Err("unreadable".into()), "C:\\Users\\Ben\\Work", home), (None, "read"));
        assert_eq!(adopt_access(&Ok(None), "C:\\Users\\Benjamin", home).1, "read");
        assert!(conversation_id("0199a8f2-1c2d-7e3f-8a9b-0c1d2e3f4a5b"));
        assert!(!conversation_id("--resume") && !conversation_id("../0199a8f2-1c2d-7e3f-8a9b-0c1d2e3f4a"));
        // Rollouts are matched by file name; contents are never opened.
        let dir = tempfile::tempdir().unwrap();
        let day = dir.path().join("2026").join("10").join("21");
        fs::create_dir_all(&day).unwrap();
        let thread = "0199a8f2-1c2d-7e3f-8a9b-0c1d2e3f4a5b";
        let file = day.join(format!("rollout-2026-10-21T10-00-00-{thread}.jsonl"));
        fs::write(&file, b"not json; must not be read").unwrap();
        assert_eq!(rollout_in(dir.path(), thread), Some(file));
        assert_eq!(rollout_in(dir.path(), "0199a8f2-1c2d-7e3f-8a9b-0c1d2e3f4a5c"), None);
    }

    #[test]
    fn claude_folder_names_decode_against_real_folders() {
        assert_eq!(encode("C:\\Users\\Ben\\PhaseForge-claude"), "C--Users-Ben-PhaseForge-claude");
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("My Project").join("app-v2")).unwrap();
        let mut budget = RESOLVE_BUDGET;
        let found = walk(dir.path(), "My-Project-app-v2", &mut budget).unwrap();
        assert!(found.ends_with(Path::new("My Project").join("app-v2")));
        assert_eq!(hint("C:\\a\\b\\"), "b");
    }

    #[test]
    fn continue_is_refused_while_recently_active_or_bound_and_offers_a_copy() {
        let now = 100 * 60_000;
        let active = continue_refusal(Provider::Claude, now - 4 * 60_000, now, None).unwrap();
        assert_eq!(active.0, "CONVERSATION_ACTIVE");
        assert!(active.1.contains("changed 4 minutes ago") && active.1.contains("Fork instead"));
        assert!(continue_refusal(Provider::Codex, now - 15 * 60_000, now, None).is_none());
        // A bound Codex thread is refused however long it has been idle.
        let bound = continue_refusal(Provider::Codex, now - 90 * 60_000, now, Some("codex-desk")).unwrap();
        assert_eq!(bound.0, "CONVERSATION_BOUND");
        assert!(bound.1.contains("codex-desk") && bound.1.contains("Fork instead"));
        assert_eq!((fork_mode(None), fork_mode(Some("continue")), fork_mode(Some("fork"))), (Ok(false), Ok(false), Ok(true)));
        assert!(fork_mode(Some("resume-original")).is_err());

        // The binding adopt checks is the owner's saved Wake by mail binding.
        let dir = tempfile::tempdir().unwrap();
        let thread = "0199a8f2-1c2d-7e3f-8a9b-0c1d2e3f4a5b";
        assert_eq!(desktop_queue::bound_address(dir.path(), thread).unwrap(), None);
        let saved = json!({"schema": 1, "bindings": [{"address": "codex-desk", "provider": "codex", "threadId": thread,
            "cwd": "C:\\work\\app", "projectId": "local:c:/work", "boundAt": 1, "cursor": 0, "last": null}]});
        fs::write(dir.path().join("desktop-bindings.json"), saved.to_string()).unwrap();
        assert_eq!(desktop_queue::bound_address(dir.path(), thread).unwrap().as_deref(), Some("codex-desk"));
        // Unreadable bindings refuse Continue rather than guess there is no other writer.
        fs::write(dir.path().join("desktop-bindings.json"), b"{not json").unwrap();
        assert!(desktop_queue::bound_address(dir.path(), thread).is_err());
    }
}
