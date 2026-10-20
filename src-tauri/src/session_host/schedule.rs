//! Scheduled tasks (0.4.1), run in process while CodaClauda is open; nothing
//! runs while the app is closed. Each schedule reuses one dedicated session,
//! created on its first run at the project's access level, and sends its
//! prompt through the normal send path. A missed run (app closed at the due
//! time) runs once after startup when `catchUp` is set, and is skipped
//! otherwise. Schedules live in `schedules.json`; each schedule's run history
//! is `schedules/<id>.jsonl`, capped at the newest 500 runs.

use super::{
    Failure, Inner, Provider, Queued, Record, TEXT_LIMIT, host, lock, now_ms, random_hex, reply,
    valid_id, write_atomic,
};
use chrono::{Datelike, Local, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fs, path::Path, path::PathBuf, sync::Arc, time::Duration};
use tauri::Emitter;

const SCHEDULE_FILE: &str = "schedules.json";
const RUN_DIR: &str = "schedules";
const RUN_LIMIT: usize = 500;
const RUNS_DEFAULT: u64 = 50;
const MAX_SCHEDULES: usize = 50;
const TICK_EVERY: Duration = Duration::from_secs(30);
const MIN_INTERVAL: u32 = 15;
const MAX_INTERVAL: u32 = 7 * 24 * 60;
const EVENT: &str = "schedule://event";
const UI_STATE: &str = "ui-state.json";
const UI_STATE_LIMIT: u64 = 8 * 1024 * 1024;
const SCHEDULE_LIMIT_BYTES: u64 = 8 * 1024 * 1024;
const RUN_LIMIT_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum Cadence {
    Interval { minutes: u32 },
    Daily { time: String, days: Vec<u8> },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Schedule {
    id: String,
    name: String,
    project_id: String,
    cwd: String,
    provider: String,
    prompt: String,
    cadence: Cadence,
    enabled: bool,
    #[serde(default)]
    catch_up: bool,
    #[serde(default)]
    last_run_at: Option<u64>,
    #[serde(default)]
    next_run_at: Option<u64>,
    /// The dedicated session this schedule reuses (created on the first run).
    #[serde(default)]
    session_id: Option<String>,
    /// Fallback access when the project has no saved level ('full' | 'read').
    #[serde(default, skip_serializing_if = "Option::is_none")]
    access: Option<String>,
    #[serde(default)]
    created_at: u64,
    #[serde(default)]
    revision: u64,
    /// Written before any asynchronous session setup. A restart never retries it.
    #[serde(default)]
    pending: Option<PendingRun>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingRun {
    at: u64,
    key: String,
    turn_id: String,
    trigger: String,
    origin: Value,
    session_id: Option<String>,
}

fn storage_failure(message: String) -> Failure { ("STORAGE_FAILED", message) }

fn validate_origin(schedule: &Schedule, origin: &Value) -> Result<(), Failure> {
    if origin["revision"].as_u64() != Some(schedule.revision)
        || (origin["trigger"] != "manual" && !schedule.enabled) {
        return Err(("SCHEDULE_CHANGED", "The schedule was edited or paused before admission; this run was not started.".into()));
    }
    Ok(())
}

fn run_record(pending: &PendingRun, status: &str) -> Value {
    json!({"at": pending.at, "status": status, "sessionId": pending.session_id,
        "turnId": pending.turn_id, "trigger": pending.trigger})
}

/// Sleeping an open host is also a missed run. Allow normal tick jitter, but
/// honor the owner's catch-up choice once more than two ticks were missed.
fn skip_missed(schedule: &mut Schedule, now: u64) -> bool {
    if schedule.enabled && !schedule.catch_up && schedule.pending.is_none()
        && schedule.next_run_at.is_some_and(|due| now.saturating_sub(due) > 2 * TICK_EVERY.as_millis() as u64) {
        schedule.next_run_at = next_run(&schedule.cadence, now);
        true
    } else { false }
}

/// The host loads its durable turn ledger first. A reservation without an
/// accepted outcome is uncertain, never an invitation to replay its prompt.
fn recover_run(run: &mut Value, outcome: Option<&Value>, now: u64) {
    match outcome.and_then(|v| v["status"].as_str()) {
        Some("completed") => { run["status"] = json!("done"); },
        Some("failed" | "cancelled" | "interrupted" | "closed") => {
            run["status"] = json!("error");
            run["error"] = json!(outcome.and_then(|v| v["error"].as_str())
                .unwrap_or("The run ended or was interrupted before restart. It was not replayed."));
        },
        _ => {
            run["status"] = json!("unknown");
            run["error"] = json!("CodaClauda restarted before this run's outcome was confirmed. Inspect Chat before an explicit retry; it was not replayed.");
        }
    }
    run["endedAt"] = json!(now);
}

fn read_json(path: &Path, limit: u64) -> Result<Option<Value>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
    };
    if file.metadata().map_err(|e| e.to_string())?.len() > limit {
        return Err(format!("{} exceeds its storage bound; existing bytes were preserved.", path.display()));
    }
    serde_json::from_reader(std::io::BufReader::new(file))
        .map(Some).map_err(|e| format!("Could not parse {}: {e}; existing bytes were preserved.", path.display()))
}

fn valid_schedule_id(id: &str) -> bool {
    id.len() == 12
        && id.starts_with("sch_")
        && id[4..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hhmm(time: &str) -> Option<NaiveTime> {
    let (h, m) = time.split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    NaiveTime::from_hms_opt(h.parse().ok()?, m.parse().ok()?, 0)
}

fn parse_cadence(value: &Value) -> Result<Cadence, String> {
    match value["kind"].as_str() {
        Some("interval") => {
            let minutes = value["minutes"].as_u64().unwrap_or(0);
            if !(MIN_INTERVAL as u64..=MAX_INTERVAL as u64).contains(&minutes) {
                return Err(format!(
                    "An interval must be {MIN_INTERVAL} to {MAX_INTERVAL} minutes."
                ));
            }
            Ok(Cadence::Interval {
                minutes: minutes as u32,
            })
        }
        Some("daily") => {
            let time = value["time"].as_str().unwrap_or("").trim();
            if hhmm(time).is_none() {
                return Err("A daily time must be HH:MM (24-hour).".into());
            }
            let mut days = Vec::new();
            for day in value["days"].as_array().into_iter().flatten() {
                match day.as_u64() {
                    Some(d @ 0..=6) if !days.contains(&(d as u8)) => days.push(d as u8),
                    Some(0..=6) => {}
                    _ => return Err("Days must be 0 (Sunday) to 6 (Saturday).".into()),
                }
            }
            days.sort_unstable();
            if days.is_empty() {
                return Err("Pick at least one weekday.".into());
            }
            Ok(Cadence::Daily {
                time: time.to_owned(),
                days,
            })
        }
        _ => Err("cadence.kind must be interval or daily.".into()),
    }
}

/// The first due time strictly after `after` (epoch ms), in local time for
/// daily cadences. The first occurrence is used when a wall time repeats at DST.
fn next_run(cadence: &Cadence, after: u64) -> Option<u64> {
    match cadence {
        Cadence::Interval { minutes } => after.checked_add(u64::from(*minutes) * 60_000),
        Cadence::Daily { time, days } => {
            let at = hhmm(time)?;
            let now = Local.timestamp_millis_opt(after as i64).single()?;
            for offset in 0..=7 {
                let date = now.date_naive().checked_add_days(chrono::Days::new(offset))?;
                let weekday = date.weekday().num_days_from_sunday() as u8;
                if !days.is_empty() && !days.contains(&weekday) {
                    continue;
                }
                let local = date.and_time(at);
                // A time inside a DST gap moves on by an hour.
                let Some(when) = Local
                    .from_local_datetime(&local)
                    .earliest()
                    .or_else(|| Local.from_local_datetime(&(local + chrono::TimeDelta::hours(1))).earliest())
                else {
                    continue;
                };
                let ms = when.timestamp_millis();
                if ms > after as i64 {
                    return Some(ms as u64);
                }
            }
            None
        }
    }
}

pub(super) fn spawn_ticker(inner: Arc<Inner>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TICK_EVERY).await;
            inner.schedule_tick().await;
        }
    });
}

impl Inner {
    fn runs_path(&self, id: &str) -> PathBuf {
        self.dir.join(RUN_DIR).join(format!("{id}.jsonl"))
    }

    pub(super) fn load_schedules(&self) {
        if let Err(message) = self.restore_schedules() {
            self.storage_error(&message);
        }
    }

    fn restore_schedules(&self) -> Result<(), String> {
        let value = match read_json(&self.dir.join(SCHEDULE_FILE), SCHEDULE_LIMIT_BYTES)? {
            Some(value) => value,
            None => return Ok(()),
        };
        if value["schema"] != "codaclauda.schedules/1" {
            return Err("The saved schedules have an unsupported schema; their bytes were preserved.".into());
        }
        let mut list: Vec<Schedule> = serde_json::from_value(value["schedules"].clone())
            .map_err(|e| format!("The saved schedules are invalid: {e}; their bytes were preserved."))?;
        let mut ids = std::collections::HashSet::new();
        if list.len() > MAX_SCHEDULES || list.iter().any(|s| {
            !valid_schedule_id(&s.id) || !ids.insert(s.id.clone())
                || Provider::parse(&s.provider).is_none() || s.prompt.len() > TEXT_LIMIT
                || s.prompt.trim().is_empty() || !Path::new(&s.cwd).is_absolute()
                || parse_cadence(&serde_json::to_value(&s.cadence).unwrap_or(Value::Null)).is_err()
        }) {
            return Err("The saved schedules exceed bounds or contain invalid identities/cadences; their bytes were preserved.".into());
        }
        let now = now_ms();
        for schedule in &mut list {
            let mut runs = self.read_runs(&schedule.id).map_err(|e| e.1)?;
            // A crash can occur between the config reservation and history write.
            if let Some(pending) = &schedule.pending {
                if !runs.iter().any(|r| r["turnId"] == pending.turn_id) {
                    runs.push(run_record(pending, "reserved"));
                }
            }
            let mut changed = schedule.pending.is_some();
            for run in &mut runs {
                if matches!(run["status"].as_str(), Some("sent" | "reserved")) {
                    let outcome = run["turnId"].as_str().and_then(|id| self.turn_outcome(id));
                    recover_run(run, outcome.as_ref(), now);
                    changed = true;
                }
            }
            if changed { self.write_runs(&schedule.id, &runs).map_err(|e| e.1)?; }
            schedule.pending = None;
            if schedule.enabled {
                match schedule.next_run_at {
                    Some(due) if due <= now && !schedule.catch_up => {
                        schedule.next_run_at = next_run(&schedule.cadence, now);
                    }
                    None => schedule.next_run_at = next_run(&schedule.cadence, now),
                    _ => {}
                }
            } else { schedule.next_run_at = None; }
        }
        self.save_schedules(&list).map_err(|e| e.1)?;
        *lock(&self.schedules) = list;
        Ok(())
    }

    fn save_schedules(&self, list: &[Schedule]) -> Result<(), Failure> {
        let result = (|| -> Result<(), String> {
            super::ensure_dirs(&self.dir).map_err(|e| e.to_string())?;
            let bytes = serde_json::to_vec_pretty(
                &json!({"schema": "codaclauda.schedules/1", "schedules": list}),
            ).map_err(|e| e.to_string())?;
            if bytes.len() as u64 > SCHEDULE_LIMIT_BYTES {
                return Err("Schedules exceed their storage bound; existing bytes were preserved.".into());
            }
            write_atomic(&self.dir.join(SCHEDULE_FILE), &bytes).map_err(|e| e.to_string())
        })();
        result.map_err(|e| {
            let message = format!("Could not persist schedules: {e}. No new scheduled work will start.");
            self.storage_error(&message);
            storage_failure(message)
        })
    }

    fn ensure_run_dir(&self) -> std::io::Result<()> {
        super::ensure_dirs(&self.dir)?;
        let path = self.dir.join(RUN_DIR);
        match fs::create_dir(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e),
            _ => {}
        }
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(std::io::Error::other("Schedule history must be a real directory."));
        }
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(std::io::Error::other("Schedule history cannot be a reparse point."));
            }
        }
        Ok(())
    }

    fn read_runs(&self, id: &str) -> Result<Vec<Value>, Failure> {
        let path = self.runs_path(id);
        let result = (|| -> Result<Vec<Value>, String> {
            let file = match fs::File::open(&path) {
                Ok(file) => file,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
                Err(e) => return Err(e.to_string()),
            };
            if file.metadata().map_err(|e| e.to_string())?.len() > RUN_LIMIT_BYTES {
                return Err("Run history exceeds its storage bound.".into());
            }
            use std::io::BufRead;
            let mut runs = Vec::new();
            for line in std::io::BufReader::new(file).lines() {
                let line = line.map_err(|e| e.to_string())?;
                if !line.trim().is_empty() {
                    let run: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
                    if !run.is_object() || runs.len() >= RUN_LIMIT {
                        return Err("Run history has invalid or excess records.".into());
                    }
                    runs.push(run);
                }
            }
            Ok(runs)
        })();
        result.map_err(|e| storage_failure(format!("Could not read schedule history {id}: {e}; existing bytes were preserved.")))
    }

    fn write_runs(&self, id: &str, runs: &[Value]) -> Result<(), Failure> {
        let result = (|| -> std::io::Result<()> {
            self.ensure_run_dir()?;
            let mut bytes = Vec::new();
            for run in runs.iter().skip(runs.len().saturating_sub(RUN_LIMIT)) {
                bytes.extend(serde_json::to_vec(run)?);
                bytes.push(b'\n');
            }
            if bytes.len() as u64 > RUN_LIMIT_BYTES {
                return Err(std::io::Error::other("Run history exceeds its storage bound."));
            }
            write_atomic(&self.runs_path(id), &bytes)
        })();
        result.map_err(|e| {
            let message = format!("Could not persist schedule history {id}: {e}.");
            self.storage_error(&message);
            storage_failure(message)
        })
    }

    fn append_run(&self, id: &str, run: &Value) -> Result<(), Failure> {
        let _guard = lock(&self.run_lock);
        let mut runs = self.read_runs(id)?;
        // The reservation is the identity: retries never append another run.
        if runs.iter().any(|r| r["turnId"] == run["turnId"]) { return Ok(()); }
        runs.push(run.clone());
        self.write_runs(id, &runs)
    }

    fn update_run(&self, id: &str, turn_id: &str, change: impl FnOnce(&mut Value)) -> Result<Option<Value>, Failure> {
        let _guard = lock(&self.run_lock);
        let mut runs = self.read_runs(id)?;
        let Some(run) = runs.iter_mut().rev().find(|r| r["turnId"] == turn_id) else { return Ok(None); };
        change(run);
        let updated = run.clone();
        self.write_runs(id, &runs)?;
        Ok(Some(updated))
    }

    fn emit_run(&self, id: &str, kind: &str, run: &Value) {
        let _ = self
            .app
            .emit(EVENT, json!({"id": id, "kind": kind, "run": run}));
    }

    /// Read the current policy on every admission, including dequeue. An unreadable
    /// setting is not permission to fall back to Full. Missing explicit settings
    /// use the exact level shown when the owner saved the schedule, else Read.
    fn project_access(&self, schedule: &Schedule) -> Result<String, Failure> {
        let state = read_json(&self.dir.join(UI_STATE), UI_STATE_LIMIT)
            .map_err(|message| ("ACCESS_UNAVAILABLE", message))?;
        let saved = state.as_ref().map(|s| &s["projectAccess"][&schedule.project_id]);
        match saved.and_then(|v| v["level"].as_str()) {
            Some("full") => Ok("full".into()),
            Some("read" | "read-only") => Ok("read".into()),
            Some(_) => Err(("ACCESS_UNAVAILABLE", "The project's saved access level is invalid. Review it before running a schedule.".into())),
            None => Ok(if schedule.access.as_deref() == Some("full") { "full" } else { "read" }.into()),
        }
    }

    /// Called with lifecycle/state held by normal turn admission. Never lock
    /// either here; schedule mutations use lifecycle -> schedules in that order.
    pub(super) fn validate_schedule_origin(&self, record: &Record, origin: &Value) -> Result<(), Failure> {
        let list = lock(&self.schedules);
        let schedule = list.iter().find(|s| origin["scheduleId"] == s.id)
            .ok_or_else(|| ("SCHEDULE_NOT_FOUND", "The schedule was deleted before this turn started.".into()))?;
        validate_origin(schedule, origin)?;
        let access = self.project_access(schedule)?;
        if record.provider != schedule.provider || record.project_id != schedule.project_id
            || record.cwd != schedule.cwd || record.access != access {
            return Err(("SCHEDULE_CHANGED", "The schedule's project or access changed before admission. Run again to create a session with the current policy.".into()));
        }
        Ok(())
    }

    fn schedule_list(&self) -> Result<Value, Failure> {
        if let Some(message) = lock(&self.storage_failure).clone() { return Err(storage_failure(message)); }
        Ok(json!({"schedules": *lock(&self.schedules)}))
    }

    fn schedule_save(&self, input: &Value) -> Result<Value, Failure> {
        let invalid = |m: &str| ("INVALID_ARGUMENTS", m.to_owned());
        if !input.is_object() {
            return Err(invalid("schedule must be an object."));
        }
        let name: String = input["name"]
            .as_str()
            .map(|s| s.trim().chars().filter(|c| !c.is_control()).take(120).collect())
            .filter(|s: &String| !s.is_empty())
            .ok_or_else(|| invalid("Give the schedule a name."))?;
        let provider = Provider::parse(input["provider"].as_str().unwrap_or(""))
            .ok_or_else(|| invalid("provider must be claude or codex."))?;
        let cwd = input["cwd"]
            .as_str()
            .map(str::trim)
            .filter(|c| !c.is_empty() && c.len() <= 4096)
            .ok_or_else(|| invalid("cwd must be the project folder."))?;
        if !Path::new(cwd).is_absolute() || (input["enabled"].as_bool().unwrap_or(true) && !Path::new(cwd).is_dir()) {
            return Err((
                "PROJECT_MISSING",
                format!("{cwd} is not an existing project folder."),
            ));
        }
        let project_id: String = input["projectId"]
            .as_str()
            .map(|s| s.trim().chars().take(512).collect())
            .filter(|s: &String| !s.is_empty())
            .unwrap_or_else(|| cwd.to_owned());
        let prompt = input["prompt"]
            .as_str()
            .filter(|p| !p.trim().is_empty())
            .ok_or_else(|| invalid("Write the prompt the schedule sends."))?;
        if prompt.len() > TEXT_LIMIT {
            return Err(("INPUT_TOO_LARGE", "The prompt is too large.".into()));
        }
        let cadence = parse_cadence(&input["cadence"]).map_err(|m| invalid(&m))?;
        let enabled = input["enabled"].as_bool().unwrap_or(true);
        let catch_up = input["catchUp"].as_bool().unwrap_or(false);
        let access = match input["access"].as_str() {
            Some("full") => Some("full".to_owned()),
            Some("read") => Some("read".to_owned()),
            _ => None,
        };
        let now = now_ms();
        let _lifecycle = lock(&self.lifecycle);
        if let Some(message) = lock(&self.storage_failure).clone() { return Err(storage_failure(message)); }
        let mut current = lock(&self.schedules);
        let mut list = current.clone();
        let saved = match input["id"].as_str().filter(|s| !s.is_empty()) {
            Some(id) => {
                let Some(existing) = list.iter_mut().find(|s| s.id == id) else {
                    return Err(("SCHEDULE_NOT_FOUND", "That schedule no longer exists.".into()));
                };
                if existing.provider != provider.name() || existing.cwd != cwd || existing.project_id != project_id {
                    existing.session_id = None; // a different agent or folder gets its own session
                }
                let retime = existing.cadence != cadence || !existing.enabled || existing.next_run_at.is_none();
                existing.name = name;
                existing.project_id = project_id;
                existing.cwd = cwd.to_owned();
                existing.provider = provider.name().to_owned();
                existing.prompt = prompt.to_owned();
                existing.cadence = cadence;
                existing.enabled = enabled;
                existing.catch_up = catch_up;
                existing.access = access;
                existing.revision = existing.revision.checked_add(1)
                    .ok_or_else(|| invalid("Schedule revision limit reached; create a new schedule."))?;
                if !enabled {
                    existing.next_run_at = None;
                } else if retime {
                    existing.next_run_at = next_run(&existing.cadence, now);
                }
                existing.clone()
            }
            None => {
                if list.len() >= MAX_SCHEDULES {
                    return Err((
                        "SCHEDULE_LIMIT",
                        format!("CodaClauda keeps at most {MAX_SCHEDULES} schedules."),
                    ));
                }
                let schedule = Schedule {
                    id: format!("sch_{}", random_hex(4)),
                    name,
                    project_id,
                    cwd: cwd.to_owned(),
                    provider: provider.name().to_owned(),
                    prompt: prompt.to_owned(),
                    next_run_at: if enabled { next_run(&cadence, now) } else { None },
                    cadence,
                    enabled,
                    catch_up,
                    last_run_at: None,
                    session_id: None,
                    access,
                    created_at: now,
                    revision: 1,
                    pending: None,
                };
                list.push(schedule.clone());
                schedule
            }
        };
        self.save_schedules(&list)?;
        *current = list;
        Ok(json!({"schedule": saved}))
    }

    fn schedule_delete(&self, id: &str) -> Result<Value, Failure> {
        let _lifecycle = lock(&self.lifecycle);
        if let Some(message) = lock(&self.storage_failure).clone() { return Err(storage_failure(message)); }
        let mut current = lock(&self.schedules);
        let mut list = current.clone();
        let before = list.len();
        list.retain(|s| s.id != id);
        if list.len() == before {
            return Err(("SCHEDULE_NOT_FOUND", "That schedule no longer exists.".into()));
        }
        self.save_schedules(&list)?;
        *current = list;
        // Keep the bounded history as a receipt for any already-admitted turn.
        // Deleting a timer does not cancel provider work already in progress.
        Ok(json!({"deleted": true}))
    }

    fn schedule_runs(&self, id: &str, limit: Option<u64>) -> Result<Value, Failure> {
        if !lock(&self.schedules).iter().any(|s| s.id == id) {
            return Err(("SCHEDULE_NOT_FOUND", "That schedule no longer exists.".into()));
        }
        let limit = limit.unwrap_or(RUNS_DEFAULT).clamp(1, RUN_LIMIT as u64) as usize;
        let runs = {
            let _guard = lock(&self.run_lock);
            self.read_runs(id)?
        };
        // Newest first.
        let runs: Vec<Value> = runs.into_iter().rev().take(limit).collect();
        Ok(json!({"runs": runs}))
    }

    /// Reserve a unique run and advance the due time in the same durable write.
    /// All mutations share lifecycle; no mutex is held across an await.
    fn reserve_run(&self, id: &str, trigger: &str, expected_due: Option<u64>) -> Result<(Schedule, PendingRun), Failure> {
        let _lifecycle = lock(&self.lifecycle);
        if let Some(message) = lock(&self.storage_failure).clone() { return Err(storage_failure(message)); }
        let mut current = lock(&self.schedules);
        let mut list = current.clone();
        let s = list.iter_mut().find(|s| s.id == id)
            .ok_or_else(|| ("SCHEDULE_NOT_FOUND", "That schedule no longer exists.".into()))?;
        if s.pending.is_some() {
            return Err(("SCHEDULE_BUSY", "This schedule already has a run being admitted.".into()));
        }
        let at = now_ms();
        if trigger != "manual" && (!s.enabled || s.next_run_at != expected_due || expected_due.is_none_or(|due| due > at)) {
            return Err(("SCHEDULE_CHANGED", "The schedule is paused or its due time changed.".into()));
        }
        let key = if trigger == "manual" {
            format!("schedule:{id}:{}:manual:{}", s.revision, random_hex(12))
        } else {
            format!("schedule:{id}:{}:due:{}", s.revision, expected_due.unwrap_or_default())
        };
        let origin = json!({"kind": "schedule", "scheduleId": id, "name": s.name, "trigger": trigger, "revision": s.revision});
        let item = Queued::keyed(s.prompt.clone(), Vec::new(), origin.clone(), key.clone());
        let pending = PendingRun { at, key, turn_id: item.turn_id, trigger: trigger.into(), origin, session_id: s.session_id.clone() };
        s.last_run_at = Some(at);
        if trigger != "manual" || s.next_run_at.is_none() {
            s.next_run_at = if s.enabled { next_run(&s.cadence, at) } else { None };
        }
        s.pending = Some(pending.clone());
        let reserved = s.clone();
        self.save_schedules(&list)?;
        *current = list;
        self.append_run(id, &run_record(&pending, "reserved"))?;
        Ok((reserved, pending))
    }

    fn clear_reservation(&self, id: &str, turn_id: &str) -> Result<(), Failure> {
        let _lifecycle = lock(&self.lifecycle);
        let mut current = lock(&self.schedules);
        let mut list = current.clone();
        if let Some(s) = list.iter_mut().find(|s| s.id == id) {
            if s.pending.as_ref().is_some_and(|p| p.turn_id == turn_id) {
                s.pending = None;
                self.save_schedules(&list)?;
                *current = list;
            }
        }
        Ok(())
    }

    async fn fire(self: &Arc<Self>, id: &str, trigger: &str, expected_due: Option<u64>) -> Result<Value, Failure> {
        let (schedule, pending) = self.reserve_run(id, trigger, expected_due)?;
        let outcome = self.fire_reserved(&schedule, &pending).await;
        let result = match outcome {
            Ok(run) => Ok(run),
            Err((code, message)) => {
                let message: String = message.chars().take(2000).collect();
                self.update_run(id, &pending.turn_id, |run| {
                    run["status"] = json!(if code == "STORAGE_FAILED" { "unknown" } else { "error" });
                    run["endedAt"] = json!(now_ms());
                    run["error"] = json!(message);
                }).map(|run| {
                    let run = run.unwrap_or_else(|| run_record(&pending, "unknown"));
                    self.emit_run(id, "error", &run);
                    run
                })
            }
        };
        // If clearing fails, the persisted reservation stays blocking until
        // restart reconciliation. Never silently retry an uncertain outcome.
        self.clear_reservation(id, &pending.turn_id)?;
        result
    }

    async fn fire_reserved(self: &Arc<Self>, schedule: &Schedule, pending: &PendingRun) -> Result<Value, Failure> {
        let access = self.project_access(schedule)?;
        if !Path::new(&schedule.cwd).is_dir() {
            return Err(("PROJECT_MISSING", "The schedule's project folder is unavailable.".into()));
        }
        let existing = {
            let state = lock(&self.state);
            schedule.session_id.as_ref().and_then(|id| state.records.iter().find(|r| &r.id == id))
                .filter(|r| r.provider == schedule.provider && r.project_id == schedule.project_id && r.cwd == schedule.cwd && r.access == access)
                .map(|r| r.id.clone())
        };
        let session_id = match existing {
            Some(id) => id,
            None => {
                let value = self.start(json!({
                    "provider": schedule.provider, "projectId": schedule.project_id,
                    "cwd": schedule.cwd, "access": access,
                    "title": format!("{} (scheduled)", schedule.name),
                })).await?;
                value["session"]["id"].as_str().filter(|id| valid_id(id)).map(str::to_owned)
                    .ok_or_else(|| ("SESSION_UNAVAILABLE", "The session was not created.".into()))?
            }
        };
        {
            let _lifecycle = lock(&self.lifecycle);
            let mut current = lock(&self.schedules);
            let mut list = current.clone();
            let s = list.iter_mut().find(|s| s.id == schedule.id)
                .ok_or_else(|| ("SCHEDULE_NOT_FOUND", "The schedule was deleted before admission.".into()))?;
            validate_origin(s, &pending.origin)?;
            if !s.pending.as_ref().is_some_and(|p| p.turn_id == pending.turn_id) {
                return Err(("SCHEDULE_CHANGED", "This run reservation is no longer current.".into()));
            }
            s.session_id = Some(session_id.clone());
            s.pending.as_mut().unwrap().session_id = Some(session_id.clone());
            self.save_schedules(&list)?;
            *current = list;
        }
        self.update_run(&schedule.id, &pending.turn_id, |run| { run["sessionId"] = json!(session_id); })?;
        let item = Queued::keyed(schedule.prompt.clone(), Vec::new(), pending.origin.clone(), pending.key.clone());
        // Normal admission atomically rechecks schedule revision/access and
        // refuses a busy automatic run. Manual runs use the bounded owner queue.
        self.submit(&session_id, item)?;
        let run = self.update_run(&schedule.id, &pending.turn_id, |run| {
            if run["status"] == "reserved" { run["status"] = json!("sent"); }
        })?.unwrap_or_else(|| run_record(pending, "unknown"));
        self.emit_run(&schedule.id, "run", &run);
        Ok(run)
    }

    /// Called when a scheduled turn ends (from finish_turn or close).
    pub(super) fn schedule_finished(&self, origin: &Value, turn_id: &str, status: &str, failure: Option<&str>) {
        let Some(id) = origin["scheduleId"].as_str().filter(|id| valid_schedule_id(id)) else {
            return;
        };
        let done = status == "completed";
        let updated = self.update_run(id, turn_id, |run| {
            run["status"] = json!(if done { "done" } else { "error" });
            run["endedAt"] = json!(now_ms());
            if !done {
                run["error"] = json!(failure.map_or_else(|| format!("The turn ended: {status}."), str::to_owned).chars().take(2000).collect::<String>());
            }
        });
        match updated {
            Ok(Some(run)) => self.emit_run(id, if done { "run" } else { "error" }, &run),
            Err((_, message)) => self.storage_error(&message),
            Ok(None) => {}
        }
    }

    async fn schedule_tick(self: &Arc<Self>) {
        let now = now_ms();
        if lock(&self.storage_failure).is_some() { return; }
        {
            let _lifecycle = lock(&self.lifecycle);
            let mut current = lock(&self.schedules);
            let mut list = current.clone();
            let mut changed = false;
            for schedule in &mut list { changed |= skip_missed(schedule, now); }
            if changed {
                if self.save_schedules(&list).is_err() { return; }
                *current = list;
            }
        }
        let due: Vec<(String, &'static str, u64)> = lock(&self.schedules)
            .iter()
            .filter(|s| s.enabled && s.pending.is_none())
            .filter_map(|s| {
                let at = s.next_run_at?;
                // Long overdue runs include startup catch-up or host sleep.
                (at <= now).then(|| {
                    (
                        s.id.clone(),
                        if now - at > 2 * TICK_EVERY.as_millis() as u64 { "catch-up" } else { "timer" },
                        at,
                    )
                })
            })
            .collect();
        for (id, trigger, at) in due {
            if let Err((_, message)) = self.fire(&id, trigger, Some(at)).await {
                eprintln!("CodaClauda could not run schedule {id}: {message}");
            }
        }
    }
}

// ----------------------------------------------------------------- commands

#[tauri::command]
pub(crate) async fn schedule_list(app: tauri::AppHandle) -> Value {
    reply(host(&app).schedule_list())
}

#[tauri::command]
pub(crate) async fn schedule_save(app: tauri::AppHandle, schedule: Value) -> Value {
    reply(host(&app).schedule_save(&schedule))
}

#[tauri::command]
pub(crate) async fn schedule_delete(app: tauri::AppHandle, id: String) -> Value {
    reply(host(&app).schedule_delete(&id))
}

#[tauri::command]
pub(crate) async fn schedule_run_now(app: tauri::AppHandle, id: String) -> Value {
    let inner = host(&app);
    reply(inner.fire(&id, "manual", None).await.map(|run| json!({"run": run})))
}

#[tauri::command]
pub(crate) async fn schedule_runs(app: tauri::AppHandle, id: String, limit: Option<u64>) -> Value {
    reply(host(&app).schedule_runs(&id, limit))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cadences_parse_and_advance() {
        assert!(parse_cadence(&json!({"kind": "interval", "minutes": 14})).is_err());
        let every = parse_cadence(&json!({"kind": "interval", "minutes": 15})).unwrap();
        assert_eq!(next_run(&every, 1_000), Some(1_000 + 15 * 60_000));
        assert!(parse_cadence(&json!({"kind": "daily", "time": "25:00", "days": []})).is_err());
        assert!(parse_cadence(&json!({"kind": "daily", "time": "09:00", "days": [7]})).is_err());
        assert!(parse_cadence(&json!({"kind": "daily", "time": "09:00", "days": []})).is_err());
        assert!(parse_cadence(&json!({"kind": "interval", "minutes": 10081})).is_err());
        assert_eq!(next_run(&every, u64::MAX), None);
        let daily = parse_cadence(&json!({"kind": "daily", "time": "09:30", "days": [3, 1, 1]})).unwrap();
        assert_eq!(daily, Cadence::Daily { time: "09:30".into(), days: vec![1, 3] });
        let start = Local.with_ymd_and_hms(2026, 10, 20, 10, 0, 0).unwrap(); // a Tuesday
        let next = next_run(&daily, start.timestamp_millis() as u64).unwrap();
        let when = Local.timestamp_millis_opt(next as i64).unwrap();
        assert_eq!((when.weekday().num_days_from_sunday(), when.format("%H:%M").to_string()), (3, "09:30".into()));
        assert!(valid_schedule_id("sch_0123abcd") && !valid_schedule_id("sch_../x"));
    }

    fn fixture() -> Schedule {
        Schedule {
            id: "sch_0123abcd".into(), name: "Review".into(), project_id: "fixture".into(),
            cwd: "C:/fixture".into(), provider: "codex".into(), prompt: "Read the fixture".into(),
            cadence: Cadence::Interval { minutes: 15 }, enabled: true, catch_up: false,
            last_run_at: None, next_run_at: Some(1000), session_id: None, access: Some("read".into()),
            created_at: 0, revision: 3, pending: None,
        }
    }

    #[test]
    fn config_revision_and_pause_invalidate_waiting_automatic_work() {
        let mut schedule = fixture();
        let timer = json!({"scheduleId": schedule.id, "trigger": "timer", "revision": 3});
        assert!(validate_origin(&schedule, &timer).is_ok());
        schedule.enabled = false;
        assert!(validate_origin(&schedule, &timer).is_err());
        assert!(validate_origin(&schedule, &json!({"trigger": "manual", "revision": 3})).is_ok());
        schedule.revision += 1;
        assert!(validate_origin(&schedule, &json!({"trigger": "manual", "revision": 3})).is_err());
    }

    #[test]
    fn host_sleep_honors_catch_up_without_skipping_normal_tick_jitter() {
        let mut schedule = fixture();
        assert!(!skip_missed(&mut schedule, 31_000));
        assert_eq!(schedule.next_run_at, Some(1000));
        assert!(skip_missed(&mut schedule, 61_001));
        assert_eq!(schedule.next_run_at, Some(61_001 + 15 * 60_000));
        schedule.next_run_at = Some(1000);
        schedule.catch_up = true;
        assert!(!skip_missed(&mut schedule, 61_001));
        assert_eq!(schedule.next_run_at, Some(1000));
        schedule.enabled = false;
        schedule.catch_up = false;
        assert!(!skip_missed(&mut schedule, 61_001));
    }

    #[test]
    fn restart_outcomes_are_terminal_or_explicitly_unknown_never_replayed() {
        for (outcome, expected) in [
            (Some(json!({"status": "completed"})), "done"),
            (Some(json!({"status": "interrupted", "error": "Stopped at restart"})), "error"),
            (Some(json!({"status": "queued"})), "unknown"),
            (None, "unknown"),
        ] {
            let mut run = json!({"turnId": "t_stable", "status": "sent", "at": 50});
            recover_run(&mut run, outcome.as_ref(), 100);
            assert_eq!(run["status"], expected);
            assert_eq!(run["turnId"], "t_stable");
            assert_eq!(run["endedAt"], 100);
        }
    }

    #[test]
    fn reservation_round_trip_keeps_identity_and_corrupt_state_is_preserved() {
        let mut schedule = fixture();
        let origin = json!({"kind": "schedule", "scheduleId": schedule.id, "trigger": "timer", "revision": schedule.revision});
        let key = "schedule:sch_0123abcd:3:due:1000".to_owned();
        let one = Queued::keyed(schedule.prompt.clone(), vec![], origin.clone(), key.clone());
        let two = Queued::keyed(schedule.prompt.clone(), vec![], origin.clone(), key.clone());
        assert_eq!(one.turn_id, two.turn_id);
        schedule.pending = Some(PendingRun { at: 1000, key, turn_id: one.turn_id.clone(), trigger: "timer".into(), origin, session_id: None });
        let restored: Schedule = serde_json::from_slice(&serde_json::to_vec(&schedule).unwrap()).unwrap();
        assert_eq!(restored.pending.unwrap().turn_id, one.turn_id);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("schedules.json");
        fs::write(&path, b"{broken").unwrap();
        assert!(read_json(&path, 1024).is_err());
        assert_eq!(fs::read(path).unwrap(), b"{broken");
    }
}
