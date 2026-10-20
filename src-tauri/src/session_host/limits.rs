//! Owner setting for how many CodaClauda agent processes may work at once
//! (Settings → Limits → Agents at once). Saved as `session-limits.json` next to
//! the other session settings; a missing or invalid file means the default.
//! Only the owner's own webview reaches these commands.

use super::{Failure, Inner, QUEUE_MAX, ensure_dirs, host, lock, reply, write_atomic};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{fs, ops::RangeInclusive};

const LIMITS_FILE: &str = "session-limits.json";
pub(super) const DEFAULT_MAX_LIVE: usize = 6;
const MAX_LIVE_RANGE: RangeInclusive<usize> = 1..=32;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    max_live: usize,
}

/// The saved value, or the default for a missing, invalid or out-of-range file.
fn parse(bytes: Option<&[u8]>) -> usize {
    bytes
        .and_then(|b| serde_json::from_slice::<Saved>(b).ok())
        .map(|s| s.max_live)
        .filter(|n| MAX_LIVE_RANGE.contains(n))
        .unwrap_or(DEFAULT_MAX_LIVE)
}

fn view(max_live: usize) -> Value {
    json!({"maxLive": max_live, "queueMax": QUEUE_MAX})
}

impl Inner {
    pub(super) fn load_limits(&self) {
        let bytes = fs::read(self.dir.join(LIMITS_FILE)).ok();
        lock(&self.state).max_live = parse(bytes.as_deref());
    }

    fn limits_set(&self, max_live: u64) -> Result<Value, Failure> {
        let n = usize::try_from(max_live)
            .ok()
            .filter(|n| MAX_LIVE_RANGE.contains(n))
            .ok_or_else(|| {
                (
                    "INVALID_ARGUMENTS",
                    format!(
                        "Agents at once must be a whole number from {} to {}.",
                        MAX_LIVE_RANGE.start(),
                        MAX_LIVE_RANGE.end()
                    ),
                )
            })?;
        let value = json!({"schema": "codaclauda.session-limits/1", "maxLive": n});
        ensure_dirs(&self.dir)
            .and_then(|_| {
                write_atomic(
                    &self.dir.join(LIMITS_FILE),
                    &serde_json::to_vec_pretty(&value)?,
                )
            })
            .map_err(|e| {
                (
                    "STORAGE_FAILED",
                    format!("Could not save session-limits.json: {e}"),
                )
            })?;
        lock(&self.state).max_live = n;
        Ok(view(n))
    }
}

// ----------------------------------------------------------------- commands

#[tauri::command]
pub(crate) async fn session_limits_get(app: tauri::AppHandle) -> Value {
    let max_live = lock(&host(&app).state).max_live;
    reply(Ok(view(max_live)))
}

#[tauri::command]
pub(crate) async fn session_limits_set(app: tauri::AppHandle, max_live: u64) -> Value {
    reply(host(&app).limits_set(max_live))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_invalid_saved_limit_falls_back_to_the_default() {
        assert_eq!(parse(None), DEFAULT_MAX_LIVE);
        let bad: [&[u8]; 5] = [
            b"not json",
            br#"{"maxLive":0}"#,
            br#"{"maxLive":33}"#,
            br#"{"maxLive":-1}"#,
            b"{}",
        ];
        for bad in bad {
            assert_eq!(parse(Some(bad)), DEFAULT_MAX_LIVE);
        }
        let saved = br#"{"schema":"codaclauda.session-limits/1","maxLive":12}"#;
        assert_eq!(parse(Some(&saved[..])), 12);
    }
}
