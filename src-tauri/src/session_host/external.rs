//! Detect Claude Code and Codex sessions already on this machine (0.5), from
//! metadata only. Claude: `<config>/projects/<encoded cwd>/<session>.jsonl`;
//! the folder name is decoded back to a real directory by matching existing
//! folder names, never by reading the transcript. Codex keeps its working
//! folder only inside each rollout's first record (`session_meta`), so only
//! that one line is parsed and every field but `cwd` is dropped. No credential
//! file is opened and nothing is copied or changed.

use super::{host, lock, reply};
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

fn env_dir(name: &str) -> Option<PathBuf> {
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

fn entry(provider: &str, cwd: Option<String>, modified: u64, now: u64, owned: bool) -> Value {
    json!({
        "provider": provider,
        "projectHint": cwd.as_deref().map(hint),
        "cwd": cwd,
        "modifiedAt": modified,
        "active": now.saturating_sub(modified) < ACTIVE_MS,
        "owned": owned,
    })
}

fn claude_sessions(owned: &HashSet<String>, now: u64) -> Vec<Value> {
    let config = env_dir("CLAUDE_CONFIG_DIR").or_else(|| env_dir("USERPROFILE").map(|h| h.join(".claude")));
    let Some(projects) = config.map(|c| c.join("projects")) else {
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
            found.push((modified, entry("claude", Some(cwd), modified, now, owned.contains(&stem))));
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().take(PER_PROVIDER).map(|(_, v)| v).collect()
}

/// Only `payload.cwd` of the first record is kept.
fn codex_cwd(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut line = Vec::new();
    BufReader::new(file.take(FIRST_LINE)).read_until(b'\n', &mut line).ok()?;
    let first: Value = serde_json::from_slice(&line).ok()?;
    first["payload"]["cwd"].as_str().map(str::to_owned)
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
    let home = env_dir("CODEX_HOME").or_else(|| env_dir("USERPROFILE").map(|h| h.join(".codex")));
    let Some(root) = home.map(|h| h.join("sessions")) else {
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
                    found.push(entry("codex", codex_cwd(&path), modified, now, owned.contains(&thread)));
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
