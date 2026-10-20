//! Project helpers for 0.5 that need no session: the CLAUDE.md / AGENTS.md
//! editor (those two names at the project root only, at most 200 KB, never
//! through a link) and GitHub Actions status for the City (`gh run list`,
//! fixed argv, the owner's own gh sign-in).

use crate::desktop::{blocking, existing_directory, is_link, read_bounded, run_gh};
use crate::error;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    time::Duration,
};

const INSTRUCTIONS_LIMIT: usize = 200 * 1024;
const GH_RUNS_WAIT: Duration = Duration::from_secs(30);

type Failure = (&'static str, String);

fn instructions_path(cwd: &str, file: &str) -> Result<PathBuf, Failure> {
    if !matches!(file, "CLAUDE.md" | "AGENTS.md") {
        return Err((
            "INVALID_ARGUMENTS",
            "file must be CLAUDE.md or AGENTS.md.".into(),
        ));
    }
    let dir = existing_directory(cwd).map_err(|message| ("PROJECT_MISSING", message))?;
    Ok(dir.join(file))
}

fn read_instructions(cwd: &str, file: &str) -> Result<Value, Failure> {
    let path = instructions_path(cwd, file)?;
    match read_bounded(&path, INSTRUCTIONS_LIMIT as u64)? {
        None => Ok(json!({"text": "", "exists": false})),
        Some(bytes) => Ok(json!({"text": String::from_utf8_lossy(&bytes), "exists": true})),
    }
}

fn write_instructions(cwd: &str, file: &str, text: &str) -> Result<Value, Failure> {
    if text.len() > INSTRUCTIONS_LIMIT {
        return Err((
            "FILE_TOO_LARGE",
            format!("{file} is limited to 200 KB here."),
        ));
    }
    let path = instructions_path(cwd, file)?;
    if let Ok(meta) = fs::symlink_metadata(&path) {
        if !meta.is_file() || is_link(&meta) {
            return Err((
                "WRITE_REFUSED",
                format!("{file} is not a regular file; CodaClauda will not write through it."),
            ));
        }
    }
    let dir = path.parent().ok_or(("WRITE_FAILED", "The project folder is unavailable.".to_owned()))?;
    let failed = |e: std::io::Error| ("WRITE_FAILED", format!("Could not save {file}: {e}"));
    let mut temporary = tempfile::NamedTempFile::new_in(dir).map_err(failed)?;
    temporary.write_all(text.as_bytes()).map_err(failed)?;
    temporary.as_file().sync_all().map_err(failed)?;
    temporary.persist(&path).map_err(|e| failed(e.error))?;
    Ok(json!({"ok": true}))
}

#[tauri::command]
pub(crate) async fn project_instructions_read(
    project_id: Option<String>,
    cwd: String,
    file: String,
) -> Value {
    let _ = project_id;
    blocking(move || read_instructions(&cwd, &file)).await
}

#[tauri::command]
pub(crate) async fn project_instructions_write(
    project_id: Option<String>,
    cwd: String,
    file: String,
    text: String,
) -> Value {
    let _ = project_id;
    blocking(move || write_instructions(&cwd, &file, &text)).await
}

/// `owner/name`, in GitHub's own character set (never a gh flag).
fn valid_repo(repo: &str) -> bool {
    let Some((owner, name)) = repo.split_once('/') else {
        return false;
    };
    (1..=39).contains(&owner.len())
        && owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !owner.starts_with('-')
        && (1..=100).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && !name.starts_with(['-', '.'])
}

fn epoch_ms(raw: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(raw.as_str()?)
        .ok()
        .map(|t| t.timestamp_millis())
}

fn runs(raw: &Value) -> Vec<Value> {
    let lower = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_ascii_lowercase);
    raw.as_array()
        .into_iter()
        .flatten()
        .map(|run| {
            json!({
                "name": run["workflowName"].as_str().filter(|s| !s.is_empty()).or(run["name"].as_str()).unwrap_or("workflow"),
                "title": run["displayTitle"],
                "status": lower(&run["status"]),
                "conclusion": lower(&run["conclusion"]),
                "branch": run["headBranch"],
                "url": run["url"],
                "at": epoch_ms(&run["createdAt"]),
            })
        })
        .collect()
}

#[tauri::command]
pub(crate) async fn ci_status(project_id: Option<String>, repo: String) -> Value {
    let _ = project_id;
    let repo = repo.trim().trim_end_matches(".git").to_owned();
    if !valid_repo(&repo) {
        return error("INVALID_ARGUMENTS", "repo must be owner/name.");
    }
    let fields = "name,workflowName,displayTitle,status,conclusion,headBranch,url,createdAt";
    match run_gh(
        &["run", "list", "--repo", &repo, "--limit", "20", "--json", fields],
        GH_RUNS_WAIT,
    )
    .await
    {
        Ok(stdout) => match serde_json::from_slice::<Value>(&stdout) {
            Ok(raw) => json!({"ok": true, "data": {"runs": runs(&raw)}}),
            Err(_) => error("GH_UNAVAILABLE", "GitHub CLI returned unreadable run data."),
        },
        Err((code, message)) => error(code, message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instructions_stay_at_the_root_and_runs_are_mapped() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_string_lossy().into_owned();
        assert!(instructions_path(&cwd, "../CLAUDE.md").is_err());
        assert_eq!(read_instructions(&cwd, "AGENTS.md").unwrap()["exists"], false);
        write_instructions(&cwd, "AGENTS.md", "# Rules\n").unwrap();
        assert_eq!(read_instructions(&cwd, "AGENTS.md").unwrap()["text"], "# Rules\n");
        assert!(write_instructions(&cwd, "CLAUDE.md", &"x".repeat(INSTRUCTIONS_LIMIT + 1)).is_err());
        assert!(valid_repo("delores88/codaclauda") && !valid_repo("-x/y") && !valid_repo("a/b/c"));
        let mapped = runs(&json!([{"workflowName": "CI", "status": "completed", "conclusion": "success",
            "headBranch": "main", "url": "https://github.com/o/r/actions/runs/1", "createdAt": "2026-10-20T10:00:00Z"}]));
        assert_eq!(mapped[0]["conclusion"], "success");
        assert_eq!(mapped[0]["at"], 1_792_490_400_000_i64);
    }
}
