//! ClaudaCoda-specific durable update writes and coordination admission guard.
//! The guard uses the same state.lock protocol as coord-core, without modifying
//! a board, pausing it, replaying requests, or importing provider credentials.
use coord_core::model::State;
use fs2::FileExt;
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, String>;
const MAX_BOARD_BYTES: u64 = 64 * 1024 * 1024;
static BINDING: std::sync::OnceLock<(PathBuf, PathBuf)> = std::sync::OnceLock::new();

pub fn initialize(binding: &crate::board::BoardBinding) -> Result<()> {
    binding.validate()?;
    let value = (
        binding.state_dir().to_owned(),
        binding.settings_dir().to_owned(),
    );
    if let Some(existing) = BINDING.get() {
        if *existing != value {
            return Err("Update board binding cannot change while running.".into());
        }
        return Ok(());
    }
    BINDING
        .set(value)
        .map_err(|_| "Update board binding is already initialized.".into())
}
pub fn board_root() -> Result<PathBuf> {
    directory(
        &BINDING
            .get()
            .ok_or("Update board binding is unavailable.")?
            .0,
    )
}
pub fn settings_root() -> Result<PathBuf> {
    directory(
        &BINDING
            .get()
            .ok_or("Update board binding is unavailable.")?
            .1,
    )
}

pub struct AdmissionGuard {
    _runtime: File,
    _board: File,
}

fn reject_links(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err("Update storage paths must be absolute.".into());
    }
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err("Update storage cannot use reparse points.".into());
                    }
                }
                if metadata.file_type().is_symlink() {
                    return Err("Update storage cannot use symbolic links.".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Update storage is inaccessible.".into()),
        }
    }
    Ok(())
}

fn directory(path: &Path) -> Result<PathBuf> {
    reject_links(path)?;
    let actual = path
        .canonicalize()
        .map_err(|_| "Update storage is missing.")?;
    if !actual.is_dir() {
        return Err("Update storage is not a directory.".into());
    }
    Ok(actual)
}

pub fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    reject_links(path)?;
    let parent = directory(
        path.parent()
            .ok_or("Update storage has no parent directory.")?,
    )?;
    let name = path.file_name().ok_or("Update storage has no file name.")?;
    let target = parent.join(name);
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|_| "Update state could not be encoded.")?;
    let mut temporary = tempfile::NamedTempFile::new_in(&parent)
        .map_err(|_| "Update state could not be reserved.")?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "Update state could not be saved.")?;
    // Recheck immediately before atomic replacement; never follow a replaced link.
    reject_links(&target)?;
    temporary
        .persist(&target)
        .map_err(|_| "Update state could not be finalized.")?;
    Ok(())
}

/// Hold this guard through the installer handoff. All coord-core mutations use
/// this same exclusive lock, so a new request cannot race the active-work check.
/// Dropping the file releases the guard; it never changes the owner's pause state.
pub fn guard_board(board: &Path) -> Result<AdmissionGuard> {
    let board = directory(board)?;
    let runtime_path = board.join("session-runtime.lock");
    reject_links(&runtime_path)?;
    let mut runtime_options = OpenOptions::new();
    runtime_options
        .create(true)
        .read(true)
        .write(true)
        .truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        runtime_options.custom_flags(0x00200000).share_mode(3);
    }
    let runtime = runtime_options
        .open(&runtime_path)
        .map_err(|_| "Session connection lease is unavailable.")?;
    let metadata = runtime
        .metadata()
        .map_err(|_| "Session connection lease is unavailable.")?;
    if !metadata.is_file() {
        return Err("Session connection lease is not a file.".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Session connection lease cannot be a reparse point.".into());
        }
    }
    FileExt::try_lock_exclusive(&runtime).map_err(|_| "Disconnect the CodaClauda MCP server in connected agents before installing, then reconnect it afterward. Their conversations can stay open.")?;
    let lock_path = board.join("state.lock");
    reject_links(&lock_path)?;
    let mut lock_options = OpenOptions::new();
    lock_options
        .create(true)
        .read(true)
        .write(true)
        .truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Match coord-core's read/write sharing, but retain the lock's identity:
        // another process must not rename it and admit work through a new file.
        lock_options.custom_flags(0x00200000).share_mode(3);
    }
    let lock = lock_options
        .open(&lock_path)
        .map_err(|_| "The coordination board lock is unavailable.")?;
    let metadata = lock
        .metadata()
        .map_err(|_| "The coordination lock cannot be checked.")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("The coordination lock cannot be a reparse point.".into());
        }
    }
    if !metadata.is_file() {
        return Err("The coordination lock is not a file.".into());
    }
    FileExt::try_lock_exclusive(&lock).map_err(
        |_| "The coordination board is busy. Wait for its current operation before installing.",
    )?;
    let state_path = board.join("state.json");
    reject_links(&state_path)?;
    let mut state_options = OpenOptions::new();
    state_options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        state_options.custom_flags(0x00200000).share_mode(1);
    }
    let state_file = match state_options.open(&state_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AdmissionGuard {
                _runtime: runtime,
                _board: lock,
            });
        }
        Err(_) => {
            return Err("The coordination board cannot be checked. Nothing was installed.".into());
        }
    };
    let metadata = state_file
        .metadata()
        .map_err(|_| "The coordination board cannot be checked.")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("The coordination board cannot be a reparse point.".into());
        }
    }
    if !metadata.is_file() {
        return Err("The coordination board is not a file.".into());
    }
    let mut bytes = Vec::new();
    state_file
        .take(MAX_BOARD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "The coordination board could not be read.")?;
    if bytes.len() as u64 > MAX_BOARD_BYTES {
        return Err("The coordination board exceeds the update preflight limit. Preserve it before a manual update.".into());
    }
    let state: State = serde_json::from_slice(&bytes)
        .map_err(|_| "The coordination board is invalid. Preserve it; update was stopped.")?;
    if !matches!(state.schema_version, 1 | 2) {
        return Err("This coordination board needs a compatible updater.".into());
    }
    if state.requests.values().any(|request| !request.terminal()) {
        return Err("Finish or cancel active and queued requests before installing an update. Pausing dispatch does not stop active work.".into());
    }
    if state.session_messages.values().any(|message| {
        !matches!(
            message.phase.as_str(),
            "acknowledged" | "replied" | "failed"
        ) && state
            .conversations
            .get(&message.conversation_id)
            .is_some_and(|conversation| {
                conversation.revoked_at.is_none() && conversation.expires_at > coord_core::now()
            })
    }) {
        return Err("There are messages awaiting delivery or acknowledgment. Finish the exchange, or revoke its conversation in Agent setup before installing. Its history will be preserved.".into());
    }
    Ok(AdmissionGuard {
        _runtime: runtime,
        _board: lock,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn connected_session_mcp_blocks_replacement_without_touching_state() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(temp.path().join("session-runtime.lock"))
            .unwrap();
        FileExt::lock_shared(&runtime).unwrap();
        assert!(guard_board(temp.path()).is_err());
        assert!(!temp.path().join("state.json").exists());
        drop(runtime);
        assert!(guard_board(temp.path()).is_ok());
    }

    #[test]
    fn pending_message_requires_receipt_or_conversation_revocation_before_update() {
        let temp = tempfile::tempdir().unwrap();
        let board = temp.path().join("board");
        let store = coord_core::store::Store::new(Some(board.clone())).unwrap();
        let mut registered = Vec::new();
        for provider in ["claude", "codex"] {
            registered.push(
                coord_core::session::owner_api(
                    &store,
                    "session-register",
                    &json!({
                        "id":provider,"provider":provider,"chat_id":provider,"label":provider,
                        "project":temp.path(),"mode":"inbox","expires_seconds":300
                    }),
                )
                .unwrap(),
            );
        }
        coord_core::session::owner_api(
            &store,
            "session-conversation",
            &json!({
                "id":"pair","registrations":["claude","codex"],"expires_seconds":300
            }),
        )
        .unwrap();
        coord_core::session::session_api(
            &store,
            "claude",
            registered[0]["capability"].as_str().unwrap(),
            "send",
            &json!({
                "id":"message","conversation_id":"pair","body":"pending fixture"
            }),
        )
        .unwrap();
        let before = fs::read(board.join("state.json")).unwrap();
        assert!(guard_board(&board).is_err());
        assert_eq!(fs::read(board.join("state.json")).unwrap(), before);
        coord_core::session::owner_api(
            &store,
            "session-revoke",
            &json!({"conversation_id":"pair"}),
        )
        .unwrap();
        assert!(guard_board(&board).is_ok());
        assert_eq!(store.read().unwrap().session_messages.len(), 1);
    }

    fn fixture(phase: &str) -> Value {
        let mut state = serde_json::to_value(State::default()).unwrap();
        state["requests"] = json!({"request": {
            "id":"request", "digest":"fixture", "grant_id":"grant", "target":"agent",
            "kind":"question", "prompt":"fixture", "expected_result":"fixture",
            "origin":"owner", "origin_session":null, "parent_id":null, "root_id":"request",
            "hop":0, "state":phase, "created_at":1, "updated_at":1, "workspace":null,
            "session_id":null, "answer":null, "receipt":null, "blocker":null,
            "cancel_requested":false, "worker_claim":null, "capability_hash":"fixture",
            "events":[], "spark_jobs":[]
        }});
        state
    }

    #[test]
    fn admission_is_locked_without_changing_board_or_pause_state() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.json");
        let before = serde_json::to_vec(&fixture("completed")).unwrap();
        fs::write(&path, &before).unwrap();
        let guard = guard_board(temp.path()).unwrap();
        assert!(guard_board(temp.path()).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        drop(guard);
        assert!(guard_board(temp.path()).is_ok());
    }

    #[test]
    fn queued_live_unknown_and_corrupt_records_refuse_setup() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.json");
        for phase in ["queued", "delivered", "acknowledged", "running", "unknown"] {
            fs::write(&path, serde_json::to_vec(&fixture(phase)).unwrap()).unwrap();
            assert!(guard_board(temp.path()).is_err(), "{phase}");
        }
        for value in [
            json!({"schema_version":2,"requests":{}}),
            json!({"schema_version":1}),
            json!({"schema_version":1,"requests":{}}),
            json!({"schema_version":1,"requests":{"bad":{"state":"completed"}}}),
        ] {
            fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            assert!(guard_board(temp.path()).is_err());
        }
        fs::write(&path, b"broken").unwrap();
        assert!(guard_board(temp.path()).is_err());
    }

    #[test]
    fn empty_and_terminal_boards_are_preserved() {
        let temp = tempfile::tempdir().unwrap();
        drop(guard_board(temp.path()).unwrap());
        assert!(!temp.path().join("state.json").exists());
        for phase in ["completed", "failed", "cancelled", "needs-owner"] {
            let state = fixture(phase);
            atomic_json(&temp.path().join("state.json"), &state).unwrap();
            assert!(guard_board(temp.path()).is_ok());
            assert_eq!(
                serde_json::from_slice::<Value>(&fs::read(temp.path().join("state.json")).unwrap())
                    .unwrap(),
                state
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn active_guard_prevents_lock_file_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let guard = guard_board(temp.path()).unwrap();
        assert!(
            fs::rename(
                temp.path().join("state.lock"),
                temp.path().join("moved.lock")
            )
            .is_err()
        );
        drop(guard);
        fs::rename(
            temp.path().join("state.lock"),
            temp.path().join("moved.lock"),
        )
        .unwrap();
    }
}
