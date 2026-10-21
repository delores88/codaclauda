//! Owner setting for how many CodaClauda agent processes may work at once
//! (Settings → Limits → Agents at once): a whole number or "unlimited", the
//! default. Saved as `session-limits.json` next to the other session
//! settings; only a missing file means the default. Invalid saved settings
//! block new launches until the owner saves a valid value. Only the owner's
//! own webview reaches these commands. `Limit` is also the number-or-unlimited
//! shape of the other app-side owner settings (team guard).

use super::{Failure, Inner, QUEUE_MAX, ensure_dirs, host, lock, reply, write_atomic};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};
use std::fs;

const LIMITS_FILE: &str = "session-limits.json";
/// The largest whole number a JavaScript Number holds exactly.
pub(crate) const JS_SAFE_MAX: u64 = 9_007_199_254_740_991;

/// A whole number or "unlimited" on the wire and on disk (never null).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Limit {
    Finite(u64),
    Unlimited,
}

impl Limit {
    /// Whether one more fits when `used` are already counted.
    pub(crate) fn allows(self, used: usize) -> bool {
        match self {
            Limit::Unlimited => true,
            Limit::Finite(max) => (used as u64) < max,
        }
    }

    pub(crate) fn to_json(self) -> Value {
        match self {
            Limit::Finite(n) => json!(n),
            Limit::Unlimited => json!("unlimited"),
        }
    }
}

impl Serialize for Limit {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Limit::Finite(n) => serializer.serialize_u64(*n),
            Limit::Unlimited => serializer.serialize_str("unlimited"),
        }
    }
}

impl<'de> Deserialize<'de> for Limit {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        parse_limit(&value, "limit", 0).map_err(serde::de::Error::custom)
    }
}

/// Owner input: a whole number from `min` to 9007199254740991, or "unlimited".
/// Nothing else (null, fractions, strings of digits, negatives) is accepted.
pub(crate) fn parse_limit(value: &Value, label: &str, min: u64) -> Result<Limit, String> {
    if value.as_str() == Some("unlimited") {
        return Ok(Limit::Unlimited);
    }
    value
        .as_u64()
        .filter(|n| (min..=JS_SAFE_MAX).contains(n))
        .map(Limit::Finite)
        .ok_or_else(|| {
            format!("{label} must be a whole number from {min} to {JS_SAFE_MAX}, or \"unlimited\".")
        })
}

/// Only an absent file receives defaults; malformed persisted policy cannot
/// silently widen the owner's finite setting.
fn parse(bytes: Option<&[u8]>) -> Result<Limit, String> {
    let Some(bytes) = bytes else { return Ok(Limit::Unlimited); };
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| "Saved Agents at once settings are invalid; save a valid value in Settings → Limits.".to_owned())?;
    if value["schema"] != "codaclauda.session-limits/1" {
        return Err("Saved Agents at once settings have an unsupported schema; the file was preserved.".into());
    }
    parse_limit(&value["maxLive"], "Agents at once", 1)
}

fn view(max_live: Limit) -> Value {
    json!({"maxLive": max_live.to_json(), "queueMax": QUEUE_MAX})
}

impl Inner {
    pub(super) fn load_limits(&self) {
        let loaded = match fs::read(self.dir.join(LIMITS_FILE)) {
            Ok(bytes) => parse(Some(&bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => parse(None),
            Err(e) => Err(format!("Saved Agents at once settings could not be read: {e}")),
        };
        let mut state = lock(&self.state);
        match loaded {
            Ok(limit) => { state.max_live = limit; state.limit_failure = None; }
            Err(message) => { state.limit_failure = Some(message); }
        }
    }

    fn limits_set(&self, max_live: &Value) -> Result<Value, Failure> {
        let _lifecycle = lock(&self.lifecycle);
        let limit = parse_limit(max_live, "Agents at once", 1)
            .map_err(|message| ("INVALID_ARGUMENTS", message))?;
        // A finite value must also fit this machine's counters (checked, never saturated).
        if let Limit::Finite(n) = limit {
            usize::try_from(n).map_err(|_| {
                (
                    "INVALID_ARGUMENTS",
                    "Agents at once is too large for this computer; choose a smaller value or \"unlimited\".".to_owned(),
                )
            })?;
        }
        let value = json!({"schema": "codaclauda.session-limits/1", "maxLive": limit.to_json()});
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
        let mut state = lock(&self.state);
        state.max_live = limit;
        state.limit_failure = None;
        Ok(view(limit))
    }
}

// ----------------------------------------------------------------- commands

#[tauri::command]
pub(crate) async fn session_limits_get(app: tauri::AppHandle) -> Value {
    let host = host(&app);
    let state = lock(&host.state);
    match &state.limit_failure {
        Some(message) => reply(Err(("LIMITS_STORAGE_FAILED", message.clone()))),
        None => reply(Ok(view(state.max_live))),
    }
}

#[tauri::command]
pub(crate) async fn session_limits_set(app: tauri::AppHandle, max_live: Value) -> Value {
    reply(host(&app).limits_set(&max_live))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agents_at_once_round_trips_numbers_and_unlimited_and_defaults_to_unlimited() {
        assert_eq!(parse(None).unwrap(), Limit::Unlimited);
        for bad in [&b"not json"[..], br#"{"maxLive":0}"#, br#"{"maxLive":-1}"#, br#"{"maxLive":2.5}"#, br#"{"maxLive":"6"}"#, br#"{"maxLive":null}"#, b"{}"] {
            assert!(parse(Some(bad)).is_err(), "{}", String::from_utf8_lossy(bad));
        }
        for limit in [Limit::Finite(1), Limit::Finite(12), Limit::Finite(JS_SAFE_MAX), Limit::Unlimited] {
            let saved = serde_json::to_vec(&json!({"schema": "codaclauda.session-limits/1", "maxLive": limit})).unwrap();
            assert_eq!(parse(Some(&saved)).unwrap(), limit);
            assert_eq!(view(limit)["maxLive"], limit.to_json());
        }
        assert_eq!(view(Limit::Unlimited)["maxLive"], "unlimited");
        // Wire validation names the setting; nothing silently becomes unlimited.
        for bad in [json!(0), json!(JS_SAFE_MAX + 1), json!(-3), json!(1.5), json!(null), json!("never"), json!("12")] {
            let error = parse_limit(&bad, "Agents at once", 1).unwrap_err();
            assert!(error.starts_with("Agents at once must be a whole number from 1 to 9007199254740991"), "{error}");
        }
        assert_eq!(parse_limit(&json!("unlimited"), "x", 1).unwrap(), Limit::Unlimited);
        assert!(Limit::Unlimited.allows(usize::MAX));
        assert!(Limit::Finite(2).allows(1) && !Limit::Finite(2).allows(2));
    }
}
