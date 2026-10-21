//! The desktop app's host lease (its heartbeat) and the delivery answer a post
//! gets (0.6).
//!
//! While it runs, the app writes `<board>/desktop-ui/host-heartbeat.json`
//! atomically every few seconds and removes it on a clean exit. The file names
//! the exact board it serves (its canonical path) and the installation that
//! wrote it: an id derived from that installation's settings folder, whose
//! board binding (`.claudacoda-board.json`) must name this same board. This
//! module only reads it. The host lease is:
//! - `available`: a heartbeat at most 30 s old, for this board, from an
//!   installation bound to this board;
//! - `unavailable`: none (never run, or closed cleanly), stale, or one for
//!   another board or installation, which does not count;
//! - `unknown`: the file or its binding cannot be read or found, or is
//!   malformed; the error is reported.
//! A post is saved whatever the lease says. The answer is information about who
//! reads an inbox, not permission for anything, and not proof anyone acted.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

/// The board address the app polls for teammate start requests.
pub const TEAM_ADDRESS: &str = "codaclauda-team";
/// A heartbeat whose `at` is further than this from now is stale.
pub const LIVE_MS: u64 = 30_000;
/// Written by the app since the board/installation binding (0.6).
pub const SCHEMA: &str = "codaclauda.host-heartbeat/2";
/// An installation's board binding, in its settings folder (see the desktop's board.rs).
pub const BINDING_FILE: &str = ".claudacoda-board.json";
const TEAM_POLL_SECONDS: u64 = 5;
const WAKE_POLL_SECONDS: u64 = 10;
const MAX_BYTES: u64 = 256 * 1024;
const BINDING_MAX_BYTES: u64 = 16 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub pid: u32,
    /// Unix milliseconds of the latest poll.
    pub at: u64,
    #[serde(default)]
    pub version: String,
    /// The canonical board folder the writing app is bound to.
    #[serde(default)]
    pub board: Option<String>,
    /// `installation_id` of the writing installation's settings folder.
    #[serde(default)]
    pub installation: Option<String>,
    /// The writing installation's settings folder (it holds its board binding).
    #[serde(default)]
    pub settings_dir: Option<String>,
    #[serde(default)]
    pub team_poll_seconds: u64,
    #[serde(default)]
    pub wake_poll_seconds: u64,
    /// Board addresses of CodaClauda sessions with wake on.
    #[serde(default)]
    pub addresses: Vec<String>,
    /// The owner's standing teammate switch.
    #[serde(default)]
    pub team: bool,
    /// Why the app's latest read of the team inbox failed, if it did.
    #[serde(default)]
    pub team_error: Option<String>,
}

/// The host lease as one post sees it.
#[derive(Debug, PartialEq)]
pub enum Lease {
    Available(Heartbeat),
    /// `last` is a stale heartbeat that was this board's and installation's.
    Unavailable { reason: String, last: Option<Heartbeat> },
    Unknown(String),
}

/// `<board>/desktop-ui/host-heartbeat.json`.
pub fn path(board: &Path) -> PathBuf {
    board.join("desktop-ui").join("host-heartbeat.json")
}

/// A stable id for one installation: its canonical settings folder, hashed.
pub fn installation_id(settings_dir: &Path) -> Option<String> {
    let real = fs::canonicalize(settings_dir).ok()?;
    let mut text = real.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        text = text.to_lowercase();
    }
    let digest = format!("{:x}", Sha256::digest(format!("codaclauda.installation/1\n{text}")));
    Some(digest[..32].to_owned())
}

fn same_dir(a: &Path, b: &Path) -> bool {
    matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(a), Ok(b)) if a == b)
}

/// A bounded regular file (never a link), or None when it does not exist.
fn read_small(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{} cannot be checked: {e}", path.display())),
    };
    if !metadata.is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(limit + 1).read_to_end(&mut bytes))
        .map_err(|e| format!("{} cannot be read: {e}", path.display()))?;
    if bytes.len() as u64 > limit {
        return Err(format!("{} exceeds its size limit", path.display()));
    }
    Ok(Some(bytes))
}

/// The host lease of `board` at `now_ms`.
pub fn lease(board: &Path, now_ms: u64) -> Lease {
    let unavailable = |reason: String, last| Lease::Unavailable { reason, last };
    let bytes = match read_small(&path(board), MAX_BYTES) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return unavailable("no heartbeat: CodaClauda has not run on this board, or was closed".into(), None),
        Err(e) => return Lease::Unknown(format!("the heartbeat is unreadable: {e}")),
    };
    let Ok(beat) = serde_json::from_slice::<Heartbeat>(&bytes) else {
        return Lease::Unknown("the heartbeat is not valid JSON".into());
    };
    let (Some(beat_board), Some(installation), Some(settings)) = (&beat.board, &beat.installation, &beat.settings_dir) else {
        return Lease::Unknown("the heartbeat names no board and installation (an older CodaClauda wrote it)".into());
    };
    if !same_dir(Path::new(beat_board), board) {
        return unavailable(format!("the heartbeat is for another board ({beat_board})"), None);
    }
    if installation_id(Path::new(settings)).as_deref() != Some(installation.as_str()) {
        return unavailable("the heartbeat's installation id does not match its settings folder".into(), None);
    }
    let binding = match read_small(&Path::new(settings).join(BINDING_FILE), BINDING_MAX_BYTES) {
        Ok(Some(bytes)) => bytes,
        // Not visible from here (another launch context, or removed): it cannot be confirmed either way.
        Ok(None) => return Lease::Unknown(format!("installation {installation}'s board binding was not found, so the heartbeat cannot be confirmed")),
        Err(e) => return Lease::Unknown(format!("installation {installation}'s board binding is unreadable: {e}")),
    };
    let bound = serde_json::from_slice::<Value>(&binding).ok().and_then(|v| v["state_dir"].as_str().map(PathBuf::from));
    match bound {
        None => return Lease::Unknown(format!("installation {installation}'s board binding is malformed")),
        Some(dir) if !same_dir(&dir, board) => {
            return unavailable(format!("installation {installation} is bound to another board"), None);
        }
        Some(_) => {}
    }
    if beat.at > now_ms.saturating_add(LIVE_MS) {
        return Lease::Unknown("the heartbeat's time is ahead of this PC's clock".into());
    }
    let age = now_ms.saturating_sub(beat.at);
    if age > LIVE_MS {
        let reason = format!("the last heartbeat is {} s old: CodaClauda stopped without closing cleanly", age / 1000);
        return unavailable(reason, Some(beat));
    }
    Lease::Available(beat)
}

/// What a post saved for `to` can expect: the durable board receipt, the host
/// lease, who reads `to`, and when.
pub fn delivery(board: &Path, to: &str, now_ms: u64) -> Value {
    let lease = lease(board, now_ms);
    let lists = |b: &Heartbeat| b.addresses.iter().any(|a| a.trim().eq_ignore_ascii_case(to));
    let (mut host, mut detail, beat) = match &lease {
        Lease::Available(b) => ("available", None, Some(b)),
        Lease::Unavailable { reason, last } => ("unavailable", Some(reason.clone()), last.as_ref()),
        Lease::Unknown(error) => ("unknown", Some(error.clone()), None),
    };
    let reader = if to == TEAM_ADDRESS { "app" } else if beat.is_some_and(lists) { "session" } else { "agent" };
    if let (Lease::Available(b), "app") = (&lease, reader) {
        if let Some(error) = &b.team_error {
            host = "unknown";
            detail = Some(format!("CodaClauda is running but could not read {TEAM_ADDRESS}: {error}"));
        }
    }
    let every = beat.map_or(0, |b| if reader == "app" { b.team_poll_seconds } else { b.wake_poll_seconds });
    let every = if every > 0 { every } else if reader == "app" { TEAM_POLL_SECONDS } else { WAKE_POLL_SECONDS };
    let pickup = (host == "available" && reader != "agent").then_some(every);
    let why = detail.clone().unwrap_or_default();
    let note = match (reader, host) {
        ("agent", _) => format!("{to} reads its inbox when it next checks. Saved is not read; a message is information, not authority."),
        ("app", "available") => format!("CodaClauda is running on this board and reads {TEAM_ADDRESS} every {every} s. Replies follow: queued, then admitted once a teammate actually launches, then the outcome (wait-reply --terminal waits for it)."),
        (_, "available") => format!("CodaClauda is running on this board and wakes {to} within {every} s. Woken is not acted on; watch for its reply."),
        (_, "unavailable") => format!("CodaClauda is not running on this board ({why}). The message is saved; nothing reads {to} until Ben opens CodaClauda (Start menu > CodaClauda). Tell Ben instead of waiting."),
        _ => format!("Whether CodaClauda is running on this board is unknown: {why}. The message is saved; tell Ben if no reply comes."),
    };
    json!({
        "receipt": "saved", "board": board.display().to_string(), "host": host, "hostDetail": detail,
        "installation": beat.and_then(|b| b.installation.clone()), "reader": reader, "pickupSeconds": pickup, "note": note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A board and an installation bound to it, in one temporary folder.
    struct Fixture {
        _dir: tempfile::TempDir,
        board: PathBuf,
        settings: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let board = dir.path().join("board");
        let settings = dir.path().join(".app.claudacoda-settings");
        fs::create_dir_all(board.join("desktop-ui")).unwrap();
        fs::create_dir_all(&settings).unwrap();
        bind(&settings, &board);
        Fixture { _dir: dir, board, settings }
    }

    fn bind(settings: &Path, board: &Path) {
        let record = json!({"schema": 1, "install_root": settings.parent().unwrap().join("app"), "state_dir": board});
        fs::write(settings.join(BINDING_FILE), record.to_string()).unwrap();
    }

    fn beat(f: &Fixture, at: u64, board: &Path, settings: &Path) {
        let value = Heartbeat {
            schema: Some(SCHEMA.into()),
            pid: 7,
            at,
            version: "0.6.0".into(),
            board: Some(board.to_string_lossy().into_owned()),
            installation: installation_id(settings),
            settings_dir: Some(settings.to_string_lossy().into_owned()),
            team_poll_seconds: 5,
            wake_poll_seconds: 10,
            addresses: vec!["claude-app-0001".into()],
            team: true,
            team_error: None,
        };
        fs::write(path(&f.board), serde_json::to_vec(&value).unwrap()).unwrap();
    }

    #[test]
    fn the_host_lease_is_available_only_for_this_board_and_a_bound_installation() {
        let f = fixture();
        let host = |to: &str, now: u64| delivery(&f.board, to, now)["host"].as_str().unwrap().to_owned();
        // Never run: unavailable, and saved either way.
        let saved = delivery(&f.board, TEAM_ADDRESS, 1_000_000);
        assert_eq!((saved["receipt"].as_str(), saved["host"].as_str(), saved["reader"].as_str()), (Some("saved"), Some("unavailable"), Some("app")));
        assert!(saved["note"].as_str().unwrap().contains("Tell Ben instead of waiting"));
        assert_eq!(delivery(&f.board, "claude-app-0001", 1_000_000)["reader"], "agent");
        beat(&f, 1_000_000, &f.board, &f.settings);
        let live = delivery(&f.board, TEAM_ADDRESS, 1_030_000);
        assert_eq!((live["host"].as_str(), live["pickupSeconds"].as_u64()), (Some("available"), Some(5)));
        assert_eq!(live["installation"], json!(installation_id(&f.settings)));
        assert_eq!(delivery(&f.board, "claude-app-0001", 1_000_000)["pickupSeconds"], 10);
        assert_eq!(delivery(&f.board, "codex-claudacoda", 1_000_000)["reader"], "agent");
        // Stale: unavailable, but the addresses it last listed are still known to be the app's.
        let stale = delivery(&f.board, "claude-app-0001", 1_030_001);
        assert_eq!((stale["host"].as_str(), stale["reader"].as_str()), (Some("unavailable"), Some("session")));
        assert!(stale["hostDetail"].as_str().unwrap().contains("30 s old"));
        assert_eq!(host(TEAM_ADDRESS, 1_000_000 - LIVE_MS - 1), "unknown", "a heartbeat from the future");

        // A heartbeat for another board does not count.
        let other = f.board.parent().unwrap().join("other-board");
        fs::create_dir_all(&other).unwrap();
        beat(&f, 1_000_000, &other, &f.settings);
        assert_eq!(host(TEAM_ADDRESS, 1_000_000), "unavailable");
        assert!(delivery(&f.board, TEAM_ADDRESS, 1_000_000)["hostDetail"].as_str().unwrap().contains("another board"));
        // Nor one from an installation bound to another board, or with an id that is not its own.
        let elsewhere = f.board.parent().unwrap().join(".other.claudacoda-settings");
        fs::create_dir_all(&elsewhere).unwrap();
        bind(&elsewhere, &other);
        beat(&f, 1_000_000, &f.board, &elsewhere);
        assert_eq!(host(TEAM_ADDRESS, 1_000_000), "unavailable");
        let mut forged: Value = serde_json::from_slice(&fs::read(path(&f.board)).unwrap()).unwrap();
        forged["settingsDir"] = json!(f.settings);
        fs::write(path(&f.board), forged.to_string()).unwrap();
        assert_eq!(host(TEAM_ADDRESS, 1_000_000), "unavailable");

        // Unreadable or malformed: unknown, with the error.
        fs::write(path(&f.board), b"{broken").unwrap();
        let broken = delivery(&f.board, TEAM_ADDRESS, 1_000_000);
        assert_eq!(broken["host"], "unknown");
        assert!(broken["hostDetail"].as_str().unwrap().contains("not valid JSON"));
        fs::write(path(&f.board), json!({"at": 1_000_000, "addresses": []}).to_string()).unwrap();
        assert_eq!(host(TEAM_ADDRESS, 1_000_000), "unknown", "an older heartbeat without a binding");
        fs::remove_file(path(&f.board)).unwrap();
        fs::create_dir(path(&f.board)).unwrap();
        assert_eq!(host(TEAM_ADDRESS, 1_000_000), "unknown");
        fs::remove_dir(path(&f.board)).unwrap();
        beat(&f, 1_000_000, &f.board, &f.settings);
        fs::write(f.settings.join(BINDING_FILE), b"not json").unwrap();
        assert_eq!(host(TEAM_ADDRESS, 1_000_000), "unknown");
        fs::remove_file(f.settings.join(BINDING_FILE)).unwrap();
        assert_eq!(host(TEAM_ADDRESS, 1_000_000), "unknown", "a binding that cannot be found cannot confirm it");
        // The app reports a failed team-inbox read: running, but whether it reads the request is unknown.
        bind(&f.settings, &f.board);
        let mut failing: Value = serde_json::from_slice(&fs::read(path(&f.board)).unwrap()).unwrap();
        failing["teamError"] = json!("Mailbox is invalid; preserve it before repair");
        fs::write(path(&f.board), failing.to_string()).unwrap();
        let team = delivery(&f.board, TEAM_ADDRESS, 1_000_000);
        assert_eq!((team["host"].as_str(), team["pickupSeconds"].as_u64()), (Some("unknown"), None));
        assert!(team["hostDetail"].as_str().unwrap().contains("Mailbox is invalid"));
        assert_eq!(host("claude-app-0001", 1_000_000), "available");
    }
}
