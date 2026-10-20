//! Scheduled tasks (0.4.1), run in process while CodaClauda is open; nothing
//! runs while the app is closed. Each schedule reuses one dedicated session,
//! created on its first run at the project's access level, and sends its
//! prompt through the normal send path. A missed run (app closed at the due
//! time) runs once after startup when `catchUp` is set, and is skipped
//! otherwise. Schedules live in `schedules.json`; each schedule's run history
//! is `schedules/<id>.jsonl`, capped at the newest 500 runs.

use super::{
    Failure, Inner, Provider, Queued, TEXT_LIMIT, host, lock, now_ms, random_hex, reply,
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
            Ok(Cadence::Daily {
                time: time.to_owned(),
                days,
            })
        }
        _ => Err("cadence.kind must be interval or daily.".into()),
    }
}

/// The first due time strictly after `after` (epoch ms), in local time for
/// daily cadences. An empty day list means every day.
fn next_run(cadence: &Cadence, after: u64) -> Option<u64> {
    match cadence {
        Cadence::Interval { minutes } => Some(after + u64::from(*minutes) * 60_000),
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
        let path = self.dir.join(SCHEDULE_FILE);
        let mut list: Vec<Schedule> = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| serde_json::from_value(v["schedules"].clone()).ok())
            {
                Some(list) => list,
                None => {
                    let _ = fs::rename(&path, self.dir.join("schedules.json.unreadable"));
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };
        list.retain(|s| valid_schedule_id(&s.id) && Provider::parse(&s.provider).is_some());
        let now = now_ms();
        let mut changed = false;
        for schedule in list.iter_mut().filter(|s| s.enabled) {
            match schedule.next_run_at {
                // Missed while the app was closed: catch-up stays due (one run
                // on the first tick); otherwise skip to the next due time.
                Some(due) if due <= now && !schedule.catch_up => {
                    schedule.next_run_at = next_run(&schedule.cadence, now);
                    changed = true;
                }
                None => {
                    schedule.next_run_at = next_run(&schedule.cadence, now);
                    changed = true;
                }
                _ => {}
            }
        }
        *lock(&self.schedules) = list;
        if changed {
            self.save_schedules(&lock(&self.schedules));
        }
    }

    fn save_schedules(&self, list: &[Schedule]) {
        let result = (|| -> std::io::Result<()> {
            super::ensure_dirs(&self.dir)?;
            let bytes = serde_json::to_vec_pretty(
                &json!({"schema": "codaclauda.schedules/1", "schedules": list}),
            )?;
            write_atomic(&self.dir.join(SCHEDULE_FILE), &bytes)
        })();
        if let Err(e) = result {
            eprintln!("CodaClauda could not save schedules.json: {e}");
        }
    }

    fn ensure_run_dir(&self) -> std::io::Result<()> {
        super::ensure_dirs(&self.dir)?;
        match fs::create_dir(self.dir.join(RUN_DIR)) {
            Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => Err(e),
            _ => Ok(()),
        }
    }

    fn read_runs(&self, id: &str) -> Vec<Value> {
        fs::read(self.runs_path(id))
            .map(|bytes| {
                bytes
                    .split(|b| *b == b'\n')
                    .filter(|line| !line.is_empty())
                    .filter_map(|line| serde_json::from_slice(line).ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn write_runs(&self, id: &str, runs: &[Value]) {
        let result = (|| -> std::io::Result<()> {
            self.ensure_run_dir()?;
            let mut bytes = Vec::new();
            for run in runs.iter().skip(runs.len().saturating_sub(RUN_LIMIT)) {
                bytes.extend(serde_json::to_vec(run)?);
                bytes.push(b'\n');
            }
            write_atomic(&self.runs_path(id), &bytes)
        })();
        if let Err(e) = result {
            eprintln!("CodaClauda could not save the runs of schedule {id}: {e}");
        }
    }

    fn append_run(&self, id: &str, run: &Value) {
        let _guard = lock(&self.run_lock);
        let mut runs = self.read_runs(id);
        runs.push(run.clone());
        self.write_runs(id, &runs);
    }

    /// Updates the run for `turn_id`; returns the updated run.
    fn update_run(&self, id: &str, turn_id: &str, change: impl FnOnce(&mut Value)) -> Option<Value> {
        let _guard = lock(&self.run_lock);
        let mut runs = self.read_runs(id);
        let run = runs.iter_mut().rev().find(|r| r["turnId"] == turn_id)?;
        change(run);
        let updated = run.clone();
        self.write_runs(id, &runs);
        Some(updated)
    }

    fn emit_run(&self, id: &str, kind: &str, run: &Value) {
        let _ = self
            .app
            .emit(EVENT, json!({"id": id, "kind": kind, "run": run}));
    }

    /// The project's saved level from the desktop state, else the schedule's
    /// fallback, else 'full' (a local project folder is Ben's own; access.js).
    /// A saved browser-control preference is ignored: it is unavailable (0.4.0).
    fn project_access(&self, schedule: &Schedule) -> String {
        let saved = fs::File::open(self.dir.join(UI_STATE))
            .ok()
            .filter(|f| f.metadata().is_ok_and(|m| m.len() <= UI_STATE_LIMIT))
            .and_then(|f| serde_json::from_reader::<_, Value>(std::io::BufReader::new(f)).ok())
            .map(|state| state["projectAccess"][&schedule.project_id].clone())
            .unwrap_or(Value::Null);
        let level = match saved["level"].as_str() {
            Some("full") => "full",
            Some("read" | "read-only") => "read",
            _ => match schedule.access.as_deref() {
                Some("read") => "read",
                _ => "full",
            },
        };
        level.to_owned()
    }

    fn schedule_list(&self) -> Value {
        json!({"schedules": *lock(&self.schedules)})
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
        if !Path::new(cwd).is_absolute() || !Path::new(cwd).is_dir() {
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
        let mut list = lock(&self.schedules);
        let saved = match input["id"].as_str().filter(|s| !s.is_empty()) {
            Some(id) => {
                let Some(existing) = list.iter_mut().find(|s| s.id == id) else {
                    return Err(("SCHEDULE_NOT_FOUND", "That schedule no longer exists.".into()));
                };
                if existing.provider != provider.name() || existing.cwd != cwd {
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
                };
                list.push(schedule.clone());
                schedule
            }
        };
        self.save_schedules(&list);
        Ok(json!({"schedule": saved}))
    }

    fn schedule_delete(&self, id: &str) -> Result<Value, Failure> {
        let mut list = lock(&self.schedules);
        let before = list.len();
        list.retain(|s| s.id != id);
        if list.len() == before {
            return Err(("SCHEDULE_NOT_FOUND", "That schedule no longer exists.".into()));
        }
        self.save_schedules(&list);
        drop(list);
        if valid_schedule_id(id) {
            let _guard = lock(&self.run_lock);
            let _ = fs::remove_file(self.runs_path(id));
        }
        Ok(json!({"deleted": true}))
    }

    fn schedule_runs(&self, id: &str, limit: Option<u64>) -> Result<Value, Failure> {
        if !lock(&self.schedules).iter().any(|s| s.id == id) {
            return Err(("SCHEDULE_NOT_FOUND", "That schedule no longer exists.".into()));
        }
        let limit = limit.unwrap_or(RUNS_DEFAULT).clamp(1, RUN_LIMIT as u64) as usize;
        let runs = {
            let _guard = lock(&self.run_lock);
            self.read_runs(id)
        };
        // Newest first.
        let runs: Vec<Value> = runs.into_iter().rev().take(limit).collect();
        Ok(json!({"runs": runs}))
    }

    /// One run: the dedicated session (created when missing), then the prompt.
    async fn fire(self: &Arc<Self>, id: &str, trigger: &str) -> Result<Value, Failure> {
        let Some(schedule) = lock(&self.schedules).iter().find(|s| s.id == id).cloned() else {
            return Err(("SCHEDULE_NOT_FOUND", "That schedule no longer exists.".into()));
        };
        let at = now_ms();
        // Advance the timer first so a slow or failed run is not retried every tick.
        {
            let mut list = lock(&self.schedules);
            if let Some(s) = list.iter_mut().find(|s| s.id == id) {
                s.last_run_at = Some(at);
                if trigger != "manual" || s.next_run_at.is_none() {
                    s.next_run_at = if s.enabled { next_run(&s.cadence, at) } else { None };
                }
            }
            self.save_schedules(&list);
        }
        let existing = schedule
            .session_id
            .clone()
            .filter(|sid| valid_id(sid) && lock(&self.state).records.iter().any(|r| &r.id == sid));
        let session_id = match existing {
            Some(sid) => sid,
            None => {
                let access = self.project_access(&schedule);
                let created = self
                    .start(json!({
                        "provider": schedule.provider,
                        "projectId": schedule.project_id,
                        "cwd": schedule.cwd,
                        "access": access,
                        "title": format!("{} (scheduled)", schedule.name),
                    }))
                    .await;
                match created {
                    Ok(value) => {
                        let sid = value["session"]["id"].as_str().unwrap_or_default().to_owned();
                        let mut list = lock(&self.schedules);
                        if let Some(s) = list.iter_mut().find(|s| s.id == id) {
                            s.session_id = Some(sid.clone());
                        }
                        self.save_schedules(&list);
                        sid
                    }
                    Err((_, message)) => {
                        let run = json!({"at": at, "status": "error", "sessionId": null, "turnId": null, "trigger": trigger, "error": message});
                        self.append_run(id, &run);
                        self.emit_run(id, "error", &run);
                        return Ok(run);
                    }
                }
            }
        };
        if trigger != "manual" {
            let busy = {
                let state = lock(&self.state);
                state.turns.contains_key(&session_id)
                    || state.queues.get(&session_id).is_some_and(|q| !q.is_empty())
            };
            if busy {
                let run = json!({"at": at, "status": "error", "sessionId": session_id, "turnId": null, "trigger": trigger, "error": "Skipped: the session was still working on an earlier turn."});
                self.append_run(id, &run);
                self.emit_run(id, "error", &run);
                return Ok(run);
            }
        }
        let origin = json!({"kind": "schedule", "scheduleId": id, "name": schedule.name, "trigger": trigger});
        let item = Queued::new(schedule.prompt.clone(), Vec::new(), origin);
        // Record the run before the turn can finish, so its result always lands.
        let mut run = json!({"at": at, "status": "sent", "sessionId": session_id, "turnId": item.turn_id, "trigger": trigger});
        self.append_run(id, &run);
        let turn_id = item.turn_id.clone();
        match self.submit(&session_id, item) {
            Ok(_) => self.emit_run(id, "run", &run),
            Err((_, message)) => {
                run = self
                    .update_run(id, &turn_id, |r| {
                        r["status"] = json!("error");
                        r["error"] = json!(message);
                    })
                    .unwrap_or(run);
                self.emit_run(id, "error", &run);
            }
        }
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
                run["error"] = json!(failure.map_or_else(|| format!("The turn ended: {status}."), str::to_owned));
            }
        });
        if let Some(run) = updated {
            self.emit_run(id, if done { "run" } else { "error" }, &run);
        }
    }

    async fn schedule_tick(self: &Arc<Self>) {
        let now = now_ms();
        let due: Vec<(String, &'static str)> = lock(&self.schedules)
            .iter()
            .filter(|s| s.enabled)
            .filter_map(|s| {
                let at = s.next_run_at?;
                // Overdue by more than two ticks means the app was closed then.
                (at <= now).then(|| {
                    (
                        s.id.clone(),
                        if now - at > 2 * TICK_EVERY.as_millis() as u64 { "catch-up" } else { "timer" },
                    )
                })
            })
            .collect();
        for (id, trigger) in due {
            if let Err((_, message)) = self.fire(&id, trigger).await {
                eprintln!("CodaClauda could not run schedule {id}: {message}");
            }
        }
    }
}

// ----------------------------------------------------------------- commands

#[tauri::command]
pub(crate) async fn schedule_list(app: tauri::AppHandle) -> Value {
    reply(Ok(host(&app).schedule_list()))
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
    reply(inner.fire(&id, "manual").await.map(|run| json!({"run": run})))
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
        let daily = parse_cadence(&json!({"kind": "daily", "time": "09:30", "days": [3, 1, 1]})).unwrap();
        assert_eq!(daily, Cadence::Daily { time: "09:30".into(), days: vec![1, 3] });
        let start = Local.with_ymd_and_hms(2026, 10, 20, 10, 0, 0).unwrap(); // a Tuesday
        let next = next_run(&daily, start.timestamp_millis() as u64).unwrap();
        let when = Local.timestamp_millis_opt(next as i64).unwrap();
        assert_eq!((when.weekday().num_days_from_sunday(), when.format("%H:%M").to_string()), (3, "09:30".into()));
        assert!(valid_schedule_id("sch_0123abcd") && !valid_schedule_id("sch_../x"));
    }
}
