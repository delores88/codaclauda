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

use super::{Failure, Inner, Record, canonical_folder, ensure_dirs, host, reply};
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

// Only Git argv uses the ordinary drive/UNC spelling. Persisted paths and
// filesystem identity checks retain the canonical board/worktree spelling.
fn git_path(path: &Path) -> Result<String, Failure> {
    coord_core::paths::git_argument(path).map_err(|e| ("GIT_PATH_UNSUPPORTED", e.to_string()))
}

async fn git(dir: &Path, args: &[&str], limit: Duration) -> Result<Output, Failure> {
    let directory = git_path(dir)?;
    let mut command = Command::new("git");
    command
        .arg("--no-pager")
        .args(["-c", "log.showSignature=false", "-c", "core.fsmonitor="])
        .args(["-c", "core.longpaths=true"])
        .arg("-C")
        .arg(directory)
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
    if canonical_folder(dir)?.starts_with(canonical_folder(&repo_root)?) {
        return Err(("WORKTREE_FAILED", "Session storage is inside this repository. Choose a board outside the project before creating worktrees.".into()));
    }
    let holder = dir.join(WORKTREE_DIR);
    make_dir(&holder)?;
    let holder = holder.join(short);
    make_dir(&holder)?;
    let root = holder.join(&folder);
    let root_text = git_path(&root)?;
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
    let _ = remove_worktree(&repo, Path::new(&tree.root)).await;
    let _ = git(&repo, &["branch", "-D", &tree.branch], GIT_QUICK).await;
    if let Some(holder) = Path::new(&tree.root).parent() {
        let _ = fs::remove_dir(holder);
    }
}

async fn remove_worktree(repo: &Path, root: &Path) -> Result<(), Failure> {
    let root_text = git_path(root)?;
    git_ok(repo, &["worktree", "remove", "--force", &root_text], GIT_SLOW).await?;
    Ok(())
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

/// Refuse an existing operation without changing its index, files or metadata.
fn no_pending_git_operation(git_dir: &Path) -> Result<(), Failure> {
    for name in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
        "sequencer",
        "BISECT_LOG",
    ] {
        match fs::symlink_metadata(git_dir.join(name)) {
            Ok(_) => return Err(("GIT_OPERATION_IN_PROGRESS", "This checkout already has a Git operation in progress. Finish or cancel it yourself before using this action; CodaClauda has not changed it.".into())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err(("GIT_OPERATION_IN_PROGRESS", "Git operation metadata could not be inspected; no changes were started.".into())),
        }
    }
    Ok(())
}

async fn git_metadata(root: &Path, flag: &str) -> Result<PathBuf, Failure> {
    let path = PathBuf::from(git_ok(root, &["rev-parse", flag], GIT_QUICK).await?);
    canonical_folder(&if path.is_absolute() {
        path
    } else {
        root.join(path)
    })
}

async fn require_git_idle(root: &Path) -> Result<(), Failure> {
    no_pending_git_operation(&git_metadata(root, "--absolute-git-dir").await?)
}

fn github_origin(remote: &str) -> Result<String, Failure> {
    let invalid = || {
        ("PR_REMOTE_UNSUPPORTED", "PR actions require exactly one origin push URL for a repository on github.com, using HTTPS or git@github.com SSH.".into())
    };
    let remote = remote.trim();
    let path = remote
        .strip_prefix("https://github.com/")
        .or_else(|| remote.strip_prefix("git@github.com:"))
        .or_else(|| remote.strip_prefix("ssh://git@github.com/"))
        .ok_or_else(invalid)?;
    let path = path.strip_suffix(".git").unwrap_or(path);
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        })
    {
        return Err(invalid());
    }
    Ok(path.to_owned())
}

async fn origin_repo(root: &Path) -> Result<(String, String), Failure> {
    let remote = git_ok(
        root,
        &["remote", "get-url", "--push", "--all", "origin"],
        GIT_QUICK,
    )
    .await?;
    let repo = github_origin(&remote)?;
    Ok((repo, remote))
}

fn checked_pr(
    pr: &Value,
    repo: &str,
    branch: Option<&str>,
    base: Option<&str>,
) -> Result<(String, u64), Failure> {
    let invalid = || {
        ("PR_MISMATCH", "GitHub CLI returned a PR outside the expected origin repository, branch or base. No PR identity was saved.".into())
    };
    let url = pr["url"].as_str().ok_or_else(invalid)?;
    let prefix = format!("https://github.com/{repo}/pull/");
    let number = url
        .get(prefix.len()..)
        .filter(|_| {
            url.get(..prefix.len())
                .is_some_and(|v| v.eq_ignore_ascii_case(&prefix))
        })
        .filter(|value| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|n| *n > 0)
        .ok_or_else(invalid)?;
    if branch.is_some_and(|b| pr["headRefName"].as_str() != Some(b))
        || base.is_some_and(|b| pr["baseRefName"].as_str() != Some(b))
        || pr["isCrossRepository"].as_bool() != Some(false)
    {
        return Err(invalid());
    }
    Ok((url.to_owned(), number))
}

impl Inner {
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

    /// Bind the path and branch to this app's registered worktree before any mutation.
    async fn validate_worktree(
        &self,
        record: &Record,
    ) -> Result<(PathBuf, String, PathBuf), Failure> {
        let (root, branch) = Self::worktree_of(record)?;
        let canonical_root = canonical_folder(&root)?;
        let owned = canonical_folder(&self.dir.join(WORKTREE_DIR))?;
        let expected_holder = owned.join(record.id.get(2..10).unwrap_or(&record.id));
        if canonical_root.parent() != Some(expected_holder.as_path()) {
            return Err(("WORKTREE_MISMATCH", "The saved worktree is outside this chat's managed folder; no changes were started.".into()));
        }
        let top = git_ok(&root, &["rev-parse", "--show-toplevel"], GIT_QUICK).await?;
        let actual_branch = git_ok(
            &root,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
            GIT_QUICK,
        )
        .await?;
        if canonical_folder(Path::new(&top))? != canonical_root || actual_branch != branch {
            return Err(("WORKTREE_MISMATCH", "The worktree root or checked-out branch has changed. Restore the recorded branch before using this action.".into()));
        }
        let repo = PathBuf::from(record.repo_root.as_deref().ok_or((
            "NO_WORKTREE",
            "The original checkout is not recorded.".into(),
        ))?);
        if git_metadata(&root, "--git-common-dir").await?
            != git_metadata(&repo, "--git-common-dir").await?
        {
            return Err((
                "WORKTREE_MISMATCH",
                "The worktree and original checkout no longer share the same Git repository."
                    .into(),
            ));
        }
        require_git_idle(&root).await?;
        Ok((root, branch, repo))
    }

    fn operation_paths(record: &Record) -> Result<Vec<PathBuf>, Failure> {
        let root = Self::worktree_of(record)?.0;
        let repo = record.repo_root.as_ref().ok_or((
            "NO_WORKTREE",
            "The original checkout is not recorded.".into(),
        ))?;
        Ok(vec![root, PathBuf::from(repo)])
    }

    /// Stages everything in the worktree and commits it when anything changed.
    async fn commit_all(root: &Path, message: &str) -> Result<bool, Failure> {
        git_ok(root, &["add", "-A"], GIT_SLOW).await?;
        let staged = git(root, &["diff", "--cached", "--quiet"], GIT_QUICK).await?;
        match staged.status.code() {
            Some(0) => return Ok(false),
            Some(1) => {},
            _ => return Err(("GIT_FAILED", "Git could not determine whether the staged changes differ; no commit was attempted.".into())),
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
        let _reservation = self.reserve_folder_operation(&Self::operation_paths(&record)?)?;
        let (root, branch, repo) = self.validate_worktree(&record).await?;
        // Refuse unrelated owner work before staging or committing the agent branch.
        require_git_idle(&repo).await?;
        let base = record.base_branch.as_deref().ok_or((
            "BASE_NOT_CHECKED_OUT",
            "The original checkout had no branch. Choose a branch before applying this worktree."
                .into(),
        ))?;
        let current = git_ok(
            &repo,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
            GIT_QUICK,
        )
        .await?;
        if current != base {
            return Err((
                "BASE_NOT_CHECKED_OUT",
                format!(
                    "Check out {base} in {} first. No commit or merge was attempted.",
                    shown(&repo)
                ),
            ));
        }
        if !git_ok(
            &repo,
            &["status", "--porcelain", "--untracked-files=normal"],
            GIT_QUICK,
        )
        .await?
        .is_empty()
        {
            return Err(("BASE_DIRTY", "The original checkout has local changes. Commit or preserve them yourself before applying this worktree.".into()));
        }
        let message: String = message
            .map(|m| {
                m.trim()
                    .chars()
                    .filter(|c| *c == '\n' || !c.is_control())
                    .take(4000)
                    .collect()
            })
            .filter(|m: &String| !m.trim().is_empty())
            .unwrap_or_else(|| format!("CodaClauda: {}", record.title));
        let committed = Self::commit_all(&root, &message).await?;
        let range = format!("{base}..{branch}");
        let ahead = git_ok(&repo, &["rev-list", "--count", &range], GIT_QUICK)
            .await?
            .parse::<u64>()
            .map_err(|_| {
                (
                    "GIT_FAILED",
                    "Git returned an unreadable revision count.".into(),
                )
            })?;
        if ahead > 0 {
            // Never abort: even a failed/timed-out command may have changed the index.
            git_ok(&repo, &["merge", "--no-overwrite-ignore", "--no-edit", &branch], GIT_SLOW).await.map_err(|(_, problem)| (
                "MERGE_FAILED", format!("Git did not confirm merging {branch} into {base}: {problem} Inspect the original checkout before another action. No abort or retry was attempted; the worktree commit is retained.")))?;
            let head = git_ok(&root, &["rev-parse", "HEAD"], GIT_QUICK).await?;
            self.with_record(id, |r| r.base_commit = Some(head))
                .map_err(|m| ("STORAGE_FAILED", m))?;
        }
        Ok(json!({"committed": committed, "merged": ahead > 0, "branch": branch}))
    }

    async fn discard(self: &Arc<Self>, id: &str) -> Result<Value, Failure> {
        let record = self.record_of(id)?;
        let _reservation = self.reserve_folder_operation(&Self::operation_paths(&record)?)?;
        let (root, branch, repo) = self.validate_worktree(&record).await?;
        require_git_idle(&repo).await?;
        // Exactly one removal. Unknown outcomes stay inspectable; no prune/retry loop.
        remove_worktree(&repo, &root).await.map_err(|(_, problem)| (
            "WORKTREE_REMOVE_UNCONFIRMED", format!("Git did not confirm removing the worktree: {problem} Inspect it before another action; no retry, prune or branch deletion was attempted.")))?;
        if root.exists() {
            return Err(("WORKTREE_REMOVE_UNCONFIRMED", "Git reported success but the worktree folder remains. No branch deletion was attempted.".into()));
        }
        let branch_removed = git_ok(&repo, &["branch", "-D", &branch], GIT_QUICK)
            .await
            .is_ok();
        if let Some(holder) = root.parent() {
            let _ = fs::remove_dir(holder);
        }
        self.with_record(id, |r| {
            r.worktree_path = None;
            r.branch = None;
            r.base_commit = None;
            r.status = "stopped".into();
        })
        .map_err(|message| ("STORAGE_FAILED", message))?;
        self.publish(
            super::event(id, None, "status", json!({"status": "stopped"})),
            false,
        );
        Ok(
            json!({"discarded": true, "branchDeletionConfirmed": branch_removed,
            "message": if branch_removed { "Worktree and branch removed." } else { "Worktree removed; Git did not confirm branch deletion. Inspect the original repository before deleting the branch yourself." }}),
        )
    }

    fn save_pr(&self, id: &str, url: &str, number: u64) -> Result<Value, Failure> {
        self.with_record(id, |r| {
            r.pr_url = Some(url.to_owned());
            r.pr_number = Some(number);
        })
        .map_err(|message| ("STORAGE_FAILED", message))?;
        Ok(json!({"url": url, "number": number}))
    }

    async fn pr_create(&self, id: &str, title: &str, body: &str) -> Result<Value, Failure> {
        let record = self.record_of(id)?;
        let _reservation = self.reserve_folder_operation(&Self::operation_paths(&record)?)?;
        let (root, branch, _) = self.validate_worktree(&record).await?;
        let (repo, origin) = origin_repo(&root).await?;
        // Include the host so inherited GH_HOST cannot redirect this action.
        let gh_repo = format!("github.com/{repo}");
        let title: String = title
            .trim()
            .chars()
            .filter(|c| !c.is_control())
            .take(256)
            .collect();
        if title.is_empty() {
            return Err(("INVALID_ARGUMENTS", "Give the pull request a title.".into()));
        }
        if body.len() > 60_000 {
            return Err((
                "INPUT_TOO_LARGE",
                "The pull request description is too long.".into(),
            ));
        }
        // Reconcile a prior unknown create outcome before any new remote mutation.
        let existing = gh_output(
            &[
                "pr",
                "list",
                "--repo",
                &gh_repo,
                "--head",
                &branch,
                "--state",
                "open",
                "--json",
                "url,headRefName,baseRefName,isCrossRepository",
            ],
            GH_WAIT,
            Some(&root),
        )
        .await?;
        if !existing.status.success() {
            return Err((
                "PR_FAILED",
                "Could not reconcile existing origin PRs; no commit, push or create was attempted."
                    .into(),
            ));
        }
        let existing: Value = serde_json::from_slice(&existing.stdout).map_err(|_| {
            (
                "PR_FAILED",
                "GitHub CLI returned unreadable PR data; no push or create was attempted.".into(),
            )
        })?;
        let existing = existing.as_array().ok_or((
            "PR_FAILED",
            "GitHub CLI returned unexpected PR data.".into(),
        ))?;
        if !existing.is_empty() {
            if existing.len() != 1 {
                return Err((
                    "PR_MISMATCH",
                    "More than one PR matches this branch. Inspect GitHub before creating another."
                        .into(),
                ));
            }
            let (url, number) = checked_pr(
                &existing[0],
                &repo,
                Some(&branch),
                record.base_branch.as_deref(),
            )?;
            return self.save_pr(id, &url, number);
        }
        Self::commit_all(&root, &title).await?;
        if origin_repo(&root).await?.1 != origin {
            return Err((
                "PR_REMOTE_CHANGED",
                "The origin push URL changed; no push or PR creation was attempted.".into(),
            ));
        }
        git_ok(
            &root,
            &["push", "--set-upstream", "origin", &branch],
            GIT_PUSH,
        )
        .await
        .map_err(|(_, m)| {
            (
                "PUSH_FAILED",
                format!(
                    "Git did not confirm pushing {branch}: {m} Inspect the remote before retrying."
                ),
            )
        })?;
        let title_arg = format!("--title={title}");
        let body_arg = format!("--body={body}");
        let mut args = vec![
            "pr",
            "create",
            "--repo",
            gh_repo.as_str(),
            "--head",
            branch.as_str(),
        ];
        if let Some(base) = &record.base_branch {
            args.extend(["--base", base.as_str()]);
        }
        args.extend([title_arg.as_str(), body_arg.as_str()]);
        let output = gh_output(&args, GH_WAIT, Some(&root)).await.map_err(|(_, m)| ("PR_OUTCOME_UNKNOWN", format!("PR creation was not confirmed: {m} A later explicit attempt will first reconcile existing PRs.")))?;
        if !output.status.success() {
            return Err((
                "PR_OUTCOME_UNKNOWN",
                format!(
                    "GitHub CLI did not confirm PR creation: {} A later explicit attempt will first reconcile existing PRs.",
                    failure_line(&output.stderr)
                ),
            ));
        }
        // Read back the exact target after creation; a printed URL is not enough.
        let output = gh_output(
            &[
                "pr",
                "view",
                &branch,
                "--repo",
                &gh_repo,
                "--json",
                "url,headRefName,baseRefName,isCrossRepository",
            ],
            GH_WAIT,
            Some(&root),
        )
        .await?;
        if !output.status.success() {
            return Err(("PR_OUTCOME_UNKNOWN", "The PR may exist, but its origin identity could not be confirmed. A later explicit attempt will reconcile it.".into()));
        }
        let pr: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
            (
                "PR_OUTCOME_UNKNOWN",
                "GitHub CLI returned unreadable PR confirmation.".into(),
            )
        })?;
        let (url, number) = checked_pr(&pr, &repo, Some(&branch), record.base_branch.as_deref())?;
        self.save_pr(id, &url, number)
    }

    async fn pr_status(&self, id: &str) -> Result<Value, Failure> {
        let record = self.record_of(id)?;
        let none = json!({"url": null, "state": null, "checks": []});
        let Some(target) = record
            .pr_number
            .map(|n| n.to_string())
            .or_else(|| record.branch.clone())
        else {
            return Ok(none);
        };
        let dir = [
            &record.worktree_path,
            &record.repo_root,
            &Some(record.cwd.clone()),
        ]
        .into_iter()
        .flatten()
        .map(PathBuf::from)
        .find(|p| p.is_dir())
        .ok_or((
            "PROJECT_MISSING",
            "The chat's folder is not available.".to_owned(),
        ))?;
        let (repo, _) = origin_repo(&dir).await?;
        let gh_repo = format!("github.com/{repo}");
        let output = gh_output(
            &[
                "pr",
                "view",
                &target,
                "--repo",
                &gh_repo,
                "--json",
                "url,state,statusCheckRollup,headRefName,baseRefName,isCrossRepository",
            ],
            GH_WAIT,
            Some(&dir),
        )
        .await?;
        if !output.status.success() {
            let line = failure_line(&output.stderr);
            if line.to_ascii_lowercase().contains("no pull requests found") {
                return Ok(none);
            }
            return Err((
                "GH_UNAVAILABLE",
                format!("GitHub CLI could not read the pull request: {line}"),
            ));
        }
        let pr: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
            (
                "GH_UNAVAILABLE",
                "GitHub CLI returned unreadable pull request data.".to_owned(),
            )
        })?;
        let (confirmed_url, confirmed_number) = checked_pr(
            &pr,
            &repo,
            record.branch.as_deref(),
            record.base_branch.as_deref(),
        )?;
        let lower = |v: &Value| {
            v.as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_ascii_lowercase)
        };
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
        if record.pr_url.as_deref() != Some(confirmed_url.as_str()) {
            self.save_pr(id, &confirmed_url, confirmed_number)?;
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

    #[cfg(windows)]
    #[test]
    fn git_paths_preserve_unc_identity_and_refuse_verbatim_aliases() {
        assert_eq!(
            git_path(Path::new(r"\\?\C:\owner folder\desktop-ui")).unwrap(),
            "C:/owner folder/desktop-ui"
        );
        for unc in [
            r"\\?\UNC\server\share\owner folder",
            r"\\server\share\owner folder",
        ] {
            assert_eq!(git_path(Path::new(unc)).unwrap(), "//server/share/owner folder");
        }
        for unsupported in [
            r"\\?\C:\owner.\project",
            r"\\?\C:\NUL\project",
            r"\\?\Volume{123}\project",
        ] {
            assert_eq!(git_path(Path::new(unsupported)).unwrap_err().0, "GIT_PATH_UNSUPPORTED");
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn canonical_windows_board_worktree_create_use_and_remove_preserve_binding() {
        // Isolated local Git fixture only: no provider, remote, or owner board.
        let temp = tempfile::tempdir().unwrap();
        let repository = temp.path().join("source repo");
        let board = temp.path().join("desktop ui");
        fs::create_dir_all(repository.join("nested folder")).unwrap();
        fs::create_dir(&board).unwrap();
        let repository = repository.canonicalize().unwrap();
        let board = board.canonicalize().unwrap();
        let binding = shown(&board);
        assert!(binding.starts_with(r"\\?\"));
        fs::write(board.join("binding-proof.txt"), &binding).unwrap();
        git_ok(&repository, &["init", "--quiet", "-b", "main"], GIT_QUICK).await.unwrap();
        for (key, value) in [
            ("user.name", "CodaClauda Unit Test"),
            ("user.email", "unit@example.invalid"),
            ("commit.gpgsign", "false"),
            ("core.hooksPath", ""),
            ("core.autocrlf", "false"),
        ] {
            git_ok(&repository, &["config", "--local", key, value], GIT_QUICK).await.unwrap();
        }
        fs::write(repository.join("nested folder/note.txt"), "baseline\n").unwrap();
        assert!(Inner::commit_all(&repository, "Isolated baseline").await.unwrap());

        let tree = create(&board, "s-12345678-fixture", &repository.join("nested folder"))
            .await.unwrap();
        let root = PathBuf::from(&tree.root);
        assert!(tree.root.starts_with(&binding));
        assert_eq!(PathBuf::from(&tree.cwd), root.join("nested folder"));
        assert_eq!(fs::read_to_string(root.join("nested folder/note.txt")).unwrap(), "baseline\n");
        require_git_idle(&root).await.unwrap();
        assert!(git_ok(Path::new(&tree.cwd), &["status", "--porcelain"], GIT_QUICK).await.unwrap().is_empty());
        fs::write(root.join("nested folder/note.txt"), "owner-reviewed edit\n").unwrap();
        assert!(git_ok(&root, &["diff", "--no-ext-diff", "--no-textconv"], GIT_QUICK)
            .await.unwrap().contains("+owner-reviewed edit"));
        assert!(Inner::commit_all(&root, "Isolated worktree edit").await.unwrap());
        git_ok(&repository, &["merge", "--ff-only", &tree.branch], GIT_SLOW).await.unwrap();
        assert_eq!(fs::read_to_string(repository.join("nested folder/note.txt")).unwrap(), "owner-reviewed edit\n");

        // The same path-aware removal helper is used by explicit discard.
        remove(&tree).await;
        assert!(!root.exists());
        assert!(!git(&repository, &["show-ref", "--verify", &format!("refs/heads/{}", tree.branch)], GIT_QUICK)
            .await.unwrap().status.success());
        assert_eq!(fs::read_to_string(board.join("binding-proof.txt")).unwrap(), binding);
        assert_eq!(shown(&board.canonicalize().unwrap()), binding);
    }

    #[test]
    fn pending_owner_git_operations_are_refused_without_touching_their_state() {
        let dir = tempfile::tempdir().unwrap();
        let index = dir.path().join("index");
        fs::write(&index, b"owner conflict resolution").unwrap();
        for name in [
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "rebase-merge",
            "rebase-apply",
            "sequencer",
            "BISECT_LOG",
        ] {
            let marker = dir.path().join(name);
            fs::write(&marker, b"existing owner operation").unwrap();
            assert_eq!(
                no_pending_git_operation(dir.path()).unwrap_err().0,
                "GIT_OPERATION_IN_PROGRESS"
            );
            assert_eq!(fs::read(&marker).unwrap(), b"existing owner operation");
            assert_eq!(fs::read(&index).unwrap(), b"owner conflict resolution");
            fs::remove_file(marker).unwrap();
        }
        assert!(no_pending_git_operation(dir.path()).is_ok());
    }

    #[test]
    fn pr_identity_is_bound_to_one_origin_repository_and_its_exact_branches() {
        for url in [
            "https://github.com/owner/repo.git",
            "git@github.com:owner/repo.git",
            "ssh://git@github.com/owner/repo",
        ] {
            assert_eq!(github_origin(url).unwrap(), "owner/repo");
        }
        for url in [
            "https://token@github.com/owner/repo",
            "https://elsewhere/owner/repo",
            "https://github.com/owner/repo?x=1",
            "git@github.com:../repo",
            "https://github.com/owner/repo.git\nhttps://github.com/other/repo.git",
        ] {
            assert!(github_origin(url).is_err(), "{url}");
        }
        let pr = json!({"url":"https://github.com/owner/repo/pull/17", "headRefName":"codaclauda/12345678", "baseRefName":"main", "isCrossRepository":false});
        assert_eq!(
            checked_pr(&pr, "owner/repo", Some("codaclauda/12345678"), Some("main"))
                .unwrap()
                .1,
            17
        );
        for (key, value) in [
            ("url", json!("https://github.com/other/repo/pull/17")),
            ("url", json!("https://github.com/owner/repo/pull/17?x")),
            ("headRefName", json!("other")),
            ("baseRefName", json!("production")),
            ("isCrossRepository", json!(true)),
        ] {
            let mut wrong = pr.clone();
            wrong[key] = value;
            assert!(
                checked_pr(
                    &wrong,
                    "owner/repo",
                    Some("codaclauda/12345678"),
                    Some("main")
                )
                .is_err()
            );
        }
    }

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
