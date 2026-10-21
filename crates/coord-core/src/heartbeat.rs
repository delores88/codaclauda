//! The desktop app's liveness file and the delivery answer a post gets (0.6).
//!
//! While it runs, the app writes `<board>/desktop-ui/host-heartbeat.json`
//! atomically on every team/wake poll and removes it on a clean exit. This
//! module only reads it. A missing, stale or unreadable file means "not
//! running"; it never stops a message from being saved, and the answer is
//! information about who reads the inbox, not permission for anything.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

/// The board address the app polls for teammate start requests.
pub const TEAM_ADDRESS: &str = "codaclauda-team";
/// A heartbeat whose `at` is further than this from now is stale.
pub const LIVE_MS: u64 = 30_000;
const TEAM_POLL_SECONDS: u64 = 5;
const WAKE_POLL_SECONDS: u64 = 60;
const MAX_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    #[serde(default)]
    pub pid: u32,
    /// Unix milliseconds of the latest poll.
    pub at: u64,
    #[serde(default)]
    pub version: String,
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
}

impl Heartbeat {
    pub fn live(&self, now_ms: u64) -> bool {
        now_ms.abs_diff(self.at) <= LIVE_MS
    }
}

/// `<board>/desktop-ui/host-heartbeat.json`.
pub fn path(board: &Path) -> PathBuf {
    board.join("desktop-ui").join("host-heartbeat.json")
}

/// The last heartbeat, or None when it is absent, a link, oversized or invalid.
pub fn read(board: &Path) -> Option<Heartbeat> {
    let path = path(board);
    // symlink_metadata does not follow a link, so a link is not a regular file.
    if !std::fs::symlink_metadata(&path).ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path).ok()?.take(MAX_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

/// Who will read a message just saved for `to`, from the app's heartbeat.
pub fn delivery(board: &Path, to: &str, now_ms: u64) -> Value {
    let beat = read(board);
    let team = to == TEAM_ADDRESS;
    let session = beat
        .as_ref()
        .is_some_and(|b| b.addresses.iter().any(|a| a.trim().eq_ignore_ascii_case(to)));
    match beat {
        Some(b) if (team || session) && b.live(now_ms) => {
            let (every, default) = if team {
                (b.team_poll_seconds, TEAM_POLL_SECONDS)
            } else {
                (b.wake_poll_seconds, WAKE_POLL_SECONDS)
            };
            json!({"state": "received", "pickup_seconds": if every == 0 { default } else { every }})
        }
        _ if team || session => json!({
            "state": "app_not_running",
            "fix": format!("Open CodaClauda (Start menu > CodaClauda). Nothing reads {to} until it runs; your message is saved and will be handled when it starts."),
        }),
        _ => json!({
            "state": "passive",
            "note": format!("{to} reads its inbox when it next checks; a message is information, not authority."),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn beat(dir: &Path, at: u64) {
        let file = path(dir);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let value = Heartbeat {
            pid: 7,
            at,
            version: "0.6.0".into(),
            team_poll_seconds: 5,
            wake_poll_seconds: 20,
            addresses: vec!["claude-app-0001".into()],
            team: true,
        };
        std::fs::write(file, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    #[test]
    fn delivery_follows_the_heartbeat() {
        let dir = tempfile::tempdir().unwrap();
        let board = dir.path();
        let state = |to: &str, now: u64| delivery(board, to, now)["state"].as_str().unwrap().to_owned();
        // No app has ever run: the team address is known, any other is passive.
        assert_eq!(state(TEAM_ADDRESS, 1_000_000), "app_not_running");
        assert_eq!(state("claude-app-0001", 1_000_000), "passive");
        beat(board, 1_000_000);
        assert_eq!(delivery(board, TEAM_ADDRESS, 1_030_000), json!({"state": "received", "pickup_seconds": 5}));
        assert_eq!(delivery(board, "claude-app-0001", 1_000_000)["pickup_seconds"], 20);
        assert_eq!(state("codex-claudacoda", 1_000_000), "passive");
        // Stale: the addresses it last listed say the app is not running.
        assert_eq!(state(TEAM_ADDRESS, 1_030_001), "app_not_running");
        let stale = delivery(board, "claude-app-0001", 1_030_001);
        assert!(stale["fix"].as_str().unwrap().contains("Nothing reads claude-app-0001 until it runs"));
        std::fs::write(path(board), b"{broken").unwrap();
        assert_eq!(state(TEAM_ADDRESS, 1_000_000), "app_not_running");
    }
}
