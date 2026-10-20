//! CodaClauda 0.4 session engine. The app process owns every provider process
//! (one kill-on-close job object each, so agents die with the app), streams
//! normalized events to the webview on `session://event`, and keeps the
//! registry (`sessions.json`) and per-session display logs
//! (`sessions/<id>.jsonl`) next to `ui-state.json`. API-key variables are
//! stripped from every launch so billing stays on the subscriptions, and no
//! credential is read, printed or written.

use crate::session_parse::{self, Out};
use crate::{board, error};
use coord_core::adapters::{self, OwnedProcess};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

const EVENT: &str = "session://event";
const REGISTRY_FILE: &str = "sessions.json";
const LOG_DIR: &str = "sessions";
const LOG_LIMIT: u64 = 5 * 1024 * 1024;
const MAX_LIVE: usize = 3;
const IDLE_LIMIT: Duration = Duration::from_secs(10 * 60);
const REAP_EVERY: Duration = Duration::from_secs(60);
const STOP_GRACE: Duration = Duration::from_secs(5);
const RPC_WAIT: Duration = Duration::from_secs(90);
const TEXT_LIMIT: usize = 256 * 1024;
const STDERR_TAIL: usize = 4096;
const HISTORY_DEFAULT: u64 = 500;
const HISTORY_MAX: u64 = 5000;
/// Registry `latest` on 2026-10-20 (GET registry.npmjs.org/@playwright/mcp/latest).
const PLAYWRIGHT_MCP: &str = "@playwright/mcp@0.0.83";
/// Removed from every launch environment (coord-core already strips these and more).
const STRIPPED_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
];
const CODEX_QUIET: &[&str] = &[
    "item/commandExecution/outputDelta",
    "item/fileChange/outputDelta",
    "item/reasoning/textDelta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "thread/tokenUsage/updated",
    "turn/diff/updated",
];

type Failure = (&'static str, String);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    if getrandom::fill(&mut buffer).is_err() {
        let seed = now_ms().to_le_bytes();
        for (i, b) in buffer.iter_mut().enumerate() {
            *b = seed[i % seed.len()] ^ (i as u8).wrapping_mul(31);
        }
    }
    buffer.iter().map(|b| format!("{b:02x}")).collect()
}

fn uuid_v4() -> String {
    let hex = random_hex(16);
    let mut b: Vec<u8> = (0..16)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap_or(0))
        .collect();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn valid_id(id: &str) -> bool {
    id.len() == 18
        && id.starts_with("s_")
        && id[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn ok(data: Value) -> Value {
    json!({"ok": true, "data": data})
}

fn event(id: &str, turn: Option<&str>, kind: &str, extra: Value) -> Value {
    let mut ev = json!({"id": id, "turnId": turn, "kind": kind, "at": now_ms()});
    if let (Some(target), Value::Object(fields)) = (ev.as_object_mut(), extra) {
        target.extend(fields);
    }
    ev
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Provider {
    Claude,
    Codex,
}

impl Provider {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
        }
    }
    fn exe(self) -> &'static str {
        match self {
            Self::Claude => "claude.exe",
            Self::Codex => "codex.exe",
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: String,
    provider: String,
    project_id: String,
    cwd: String,
    title: String,
    access: String,
    thread_id: Option<String>,
    provider_session_id: Option<String>,
    status: String,
    created_at: u64,
    last_activity_at: u64,
    shared: bool,
    shared_id: Option<String>,
    #[serde(default)]
    playwright: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Attachment {
    path: String,
    #[serde(default)]
    name: String,
}

/// One owned provider process.
struct Proc {
    generation: u64,
    provider: Provider,
    child: Mutex<OwnedProcess>,
    input: Mutex<Option<mpsc::Sender<String>>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    stderr: Arc<Mutex<String>>,
    expected_exit: AtomicBool,
}

impl Proc {
    fn write(&self, line: String) -> Result<(), String> {
        lock(&self.input)
            .as_ref()
            .ok_or_else(|| "The agent process is no longer accepting input.".to_owned())?
            .send(line)
            .map_err(|_| "The agent process is no longer accepting input.".to_owned())
    }
    fn kill(&self) {
        self.expected_exit.store(true, Ordering::SeqCst);
        let _ = lock(&self.child).terminate();
    }
}

/// Graceful end: close stdin, give the provider a moment, then end the job.
fn shutdown(proc: Arc<Proc>) {
    proc.expected_exit.store(true, Ordering::SeqCst);
    lock(&proc.input).take();
    thread::spawn(move || {
        let end = Instant::now() + Duration::from_secs(3);
        while Instant::now() < end {
            if matches!(lock(&proc.child).try_wait(), Ok(Some(_))) {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = lock(&proc.child).terminate();
    });
}

struct Live {
    proc: Arc<Proc>,
    last_used: Instant,
}

struct Turn {
    id: String,
    provider_turn: Option<String>,
    stopping: bool,
}

#[derive(Default)]
struct State {
    records: Vec<Record>,
    live: HashMap<String, Live>,
    turns: HashMap<String, Turn>,
}

struct Inner {
    app: tauri::AppHandle,
    dir: PathBuf,
    state: Mutex<State>,
    executables: Mutex<HashMap<Provider, PathBuf>>,
    log_lock: Mutex<()>,
    generation: AtomicU64,
}

/// Tauri-managed handle to the session engine.
pub(crate) struct SessionHost {
    inner: Arc<Inner>,
}

impl SessionHost {
    pub(crate) fn new(app: tauri::AppHandle, board: &board::BoardBinding) -> Self {
        let inner = Arc::new(Inner {
            app,
            dir: crate::desktop::ui_dir(board),
            state: Mutex::new(State::default()),
            executables: Mutex::new(HashMap::new()),
            log_lock: Mutex::new(()),
            generation: AtomicU64::new(0),
        });
        inner.load();
        let reaper = inner.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(REAP_EVERY).await;
                reaper.reap_idle();
            }
        });
        Self { inner }
    }
}

// ------------------------------------------------------------- persistence

fn ensure_dirs(dir: &Path) -> std::io::Result<()> {
    // One level at a time: never recreate a moved or removed board.
    for path in [dir.to_path_buf(), dir.join(LOG_DIR)] {
        match fs::create_dir(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e),
            _ => {}
        }
    }
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or(Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|e| e.error)?;
    Ok(())
}

/// Keeps the newest half of an oversized display log, on a line boundary.
fn trim_log(path: &Path) -> std::io::Result<()> {
    let bytes = fs::read(path)?;
    let from = bytes.len().saturating_sub((LOG_LIMIT / 2) as usize);
    let start = bytes[from..]
        .iter()
        .position(|b| *b == b'\n')
        .map(|p| from + p + 1)
        .unwrap_or(bytes.len());
    write_atomic(path, &bytes[start..])
}

impl Inner {
    fn log_path(&self, id: &str) -> PathBuf {
        self.dir.join(LOG_DIR).join(format!("{id}.jsonl"))
    }

    fn load(&self) {
        let path = self.dir.join(REGISTRY_FILE);
        let mut records: Vec<Record> = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| serde_json::from_value(v["sessions"].clone()).ok())
            {
                Some(records) => records,
                None => {
                    // Keep an unreadable registry for inspection instead of overwriting it.
                    let _ = fs::rename(&path, self.dir.join("sessions.json.unreadable"));
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };
        records.retain(|r| valid_id(&r.id) && Provider::parse(&r.provider).is_some());
        let mut interrupted = Vec::new();
        for record in &mut records {
            if record.status == "running" {
                record.status = "idle".into();
                interrupted.push((record.id.clone(), record.turn_id.take()));
            }
        }
        let mut state = lock(&self.state);
        state.records = records;
        if !interrupted.is_empty() {
            self.save(&state);
        }
        drop(state);
        for (id, turn) in interrupted {
            self.append(&event(
                &id,
                turn.as_deref(),
                "done",
                json!({"status": "interrupted", "text": "CodaClauda closed during this reply; the agent may have finished part of the work."}),
            ));
        }
    }

    fn save(&self, state: &State) {
        let result = (|| -> std::io::Result<()> {
            ensure_dirs(&self.dir)?;
            let bytes = serde_json::to_vec_pretty(
                &json!({"schema": "codaclauda.sessions/1", "sessions": state.records}),
            )?;
            write_atomic(&self.dir.join(REGISTRY_FILE), &bytes)
        })();
        if let Err(e) = result {
            eprintln!("CodaClauda could not save sessions.json: {e}");
        }
    }

    fn append(&self, ev: &Value) {
        let Some(id) = ev["id"].as_str().filter(|id| valid_id(id)) else {
            return;
        };
        let _guard = lock(&self.log_lock);
        let path = self.log_path(id);
        let result = (|| -> std::io::Result<()> {
            ensure_dirs(&self.dir)?;
            if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > LOG_LIMIT {
                trim_log(&path)?;
            }
            let mut line = serde_json::to_vec(ev)?;
            line.push(b'\n');
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)?
                .write_all(&line)
        })();
        if let Err(e) = result {
            eprintln!("CodaClauda could not append a session event: {e}");
        }
    }

    /// Emits to the webview; deltas and status changes are not persisted.
    fn publish(&self, ev: Value, persist: bool) {
        if persist {
            self.append(&ev);
        }
        let _ = self.app.emit(EVENT, ev);
    }

    fn with_record<T>(&self, id: &str, change: impl FnOnce(&mut Record) -> T) -> Option<T> {
        let mut state = lock(&self.state);
        let result = state.records.iter_mut().find(|r| r.id == id).map(change)?;
        self.save(&state);
        Some(result)
    }

    fn current_turn(&self, id: &str) -> Option<(String, bool)> {
        lock(&self.state)
            .turns
            .get(id)
            .map(|t| (t.id.clone(), t.stopping))
    }

    fn turn_active(&self, id: &str, turn_id: &str) -> bool {
        lock(&self.state)
            .turns
            .get(id)
            .is_some_and(|t| t.id == turn_id && !t.stopping)
    }

    /// Ends the session's current turn (or only `only`). Returns false when
    /// there was no matching turn, so double reports are harmless.
    fn finish_turn(
        &self,
        id: &str,
        only: Option<&str>,
        status: &str,
        failure: Option<String>,
        record_status: &str,
    ) -> bool {
        let (turn, status, shown) = {
            let mut state = lock(&self.state);
            match state.turns.get(id) {
                Some(t) if only.is_none_or(|wanted| wanted == t.id) => {}
                _ => return false,
            }
            let Some(turn) = state.turns.remove(id) else {
                return false;
            };
            let status = if turn.stopping && status != "completed" {
                "interrupted"
            } else {
                status
            };
            let mut shown = record_status.to_owned();
            if let Some(record) = state.records.iter_mut().find(|r| r.id == id) {
                record.turn_id = None;
                record.last_activity_at = now_ms();
                if record.status == "stopped" {
                    shown = "stopped".into();
                } else {
                    record.status = record_status.into();
                }
            }
            if let Some(live) = state.live.get_mut(id) {
                live.last_used = Instant::now();
            }
            self.save(&state);
            (turn, status.to_owned(), shown)
        };
        if let Some(message) = failure.filter(|_| status != "interrupted") {
            self.publish(
                event(id, Some(&turn.id), "error", json!({"error": message})),
                true,
            );
        }
        self.publish(
            event(id, Some(&turn.id), "done", json!({"status": status})),
            true,
        );
        self.publish(event(id, None, "status", json!({"status": shown})), false);
        true
    }

    // --------------------------------------------------------- provider output

    fn handle(&self, id: &str, proc: &Arc<Proc>, out: Out) {
        match out {
            Out::Response { id: call, result } => {
                if let Some(sender) = lock(&proc.pending).remove(&call) {
                    let _ = sender.send(result);
                }
            }
            Out::ServerRequest { id: call, method } => {
                let _ = proc.write(
                    json!({"id": call, "error": {"code": -32601, "message": format!("CodaClauda 0.4.0 does not answer {method}.")}})
                        .to_string(),
                );
                let turn = self.current_turn(id).map(|t| t.0);
                self.publish(
                    event(
                        id,
                        turn.as_deref(),
                        "error",
                        json!({"error": format!("Codex asked for {method}; CodaClauda 0.4.0 declined it.")}),
                    ),
                    true,
                );
            }
            Out::ControlRequest(request) => {
                let _ = proc.write(
                    json!({"type": "control_response", "response": {"subtype": "error", "request_id": request, "error": "CodaClauda 0.4.0 does not answer permission prompts."}})
                        .to_string(),
                );
            }
            Out::ProviderSession(session) => {
                let mut state = lock(&self.state);
                let changed = match state.records.iter_mut().find(|r| r.id == id) {
                    Some(r) if r.provider_session_id.as_deref() != Some(session.as_str()) => {
                        r.provider_session_id = Some(session);
                        true
                    }
                    _ => false,
                };
                if changed {
                    self.save(&state);
                }
            }
            Out::TurnStarted(provider_turn) => {
                if let Some(turn) = lock(&self.state).turns.get_mut(id) {
                    turn.provider_turn.get_or_insert(provider_turn);
                }
            }
            Out::Delta(text) => {
                if let Some((turn, _)) = self.current_turn(id) {
                    self.publish(event(id, Some(&turn), "delta", json!({"text": text})), false);
                }
            }
            Out::Message(text) => {
                let turn = self.current_turn(id).map(|t| t.0);
                self.publish(
                    event(id, turn.as_deref(), "message", json!({"text": text})),
                    true,
                );
            }
            Out::Tool { name, summary } => {
                let turn = self.current_turn(id).map(|t| t.0);
                self.publish(
                    event(
                        id,
                        turn.as_deref(),
                        "tool",
                        json!({"tool": {"name": name, "summary": summary}}),
                    ),
                    true,
                );
            }
            Out::Status(status) => {
                let turn = self.current_turn(id).map(|t| t.0);
                self.publish(
                    event(id, turn.as_deref(), "status", json!({"status": status})),
                    false,
                );
            }
            Out::Error(message) => match self.current_turn(id) {
                Some((_, true)) => {} // the error is the interrupt itself
                turn => self.publish(
                    event(
                        id,
                        turn.as_ref().map(|t| t.0.as_str()),
                        "error",
                        json!({"error": message}),
                    ),
                    true,
                ),
            },
            Out::Done(status) => {
                self.finish_turn(id, None, &status, None, "idle");
            }
        }
    }

    fn read_stdout(self: Arc<Self>, id: String, proc: Arc<Proc>, stdout: File) {
        let reader = BufReader::with_capacity(1 << 16, stdout);
        for line in reader.split(b'\n') {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            let outputs = match proc.provider {
                Provider::Claude => session_parse::parse_claude(&value),
                Provider::Codex => session_parse::parse_codex(&value),
            };
            for out in outputs {
                self.handle(&id, &proc, out);
            }
        }
        self.exited(&id, &proc);
    }

    fn exited(&self, id: &str, proc: &Arc<Proc>) {
        let mut code = None;
        for _ in 0..20 {
            if let Ok(Some(exit)) = lock(&proc.child).try_wait() {
                code = Some(exit);
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        // Also ends any MCP helper the provider left in its job.
        let _ = lock(&proc.child).terminate();
        lock(&proc.pending).clear();
        lock(&proc.input).take();
        let current = {
            let mut state = lock(&self.state);
            let current = state
                .live
                .get(id)
                .is_some_and(|l| l.proc.generation == proc.generation);
            if current {
                state.live.remove(id);
            }
            current
        };
        if !current {
            return;
        }
        if proc.expected_exit.load(Ordering::SeqCst) {
            self.finish_turn(id, None, "interrupted", None, "idle");
            return;
        }
        let tail = coord_core::redact(lock(&proc.stderr).trim());
        let message = format!(
            "{} stopped unexpectedly (exit code {}).{}",
            proc.provider.label(),
            code.map_or_else(|| "unknown".to_owned(), |c| c.to_string()),
            if tail.is_empty() {
                String::new()
            } else {
                format!(" {tail}")
            }
        );
        self.finish_turn(id, None, "failed", Some(message), "error");
    }

    // ---------------------------------------------------------------- launch

    async fn executable(&self, provider: Provider) -> Result<PathBuf, String> {
        if let Some(path) = lock(&self.executables)
            .get(&provider)
            .filter(|p| p.is_file())
            .cloned()
        {
            return Ok(path);
        }
        let found = tauri::async_runtime::spawn_blocking(move || discover(provider))
            .await
            .map_err(|_| "Agent discovery stopped unexpectedly.".to_owned())??;
        lock(&self.executables).insert(provider, found.clone());
        Ok(found)
    }

    /// At most MAX_LIVE provider processes: close the least recently used idle one.
    fn make_room(&self, except: &str) -> Result<(), String> {
        let victim = {
            let mut state = lock(&self.state);
            if state.live.len() < MAX_LIVE || state.live.contains_key(except) {
                return Ok(());
            }
            let oldest = state
                .live
                .iter()
                .filter(|(id, _)| !state.turns.contains_key(*id))
                .min_by_key(|(_, live)| live.last_used)
                .map(|(id, _)| id.clone());
            match oldest {
                Some(id) => state.live.remove(&id),
                None => {
                    return Err(format!(
                        "{MAX_LIVE} agents are already working. Wait for one to finish or stop one, then send again."
                    ));
                }
            }
        };
        if let Some(live) = victim {
            shutdown(live.proc);
        }
        Ok(())
    }

    fn write_mcp_config(&self, id: &str) -> Result<PathBuf, String> {
        let path = self.dir.join(LOG_DIR).join(format!("{id}.mcp.json"));
        let config = json!({"mcpServers": {"playwright": {"command": "cmd", "args": ["/c", "npx", "-y", PLAYWRIGHT_MCP]}}});
        ensure_dirs(&self.dir)
            .and_then(|_| write_atomic(&path, &serde_json::to_vec_pretty(&config)?))
            .map_err(|e| format!("Could not write the browser-control configuration: {e}"))?;
        Ok(path)
    }

    async fn launch(
        self: &Arc<Self>,
        record: &Record,
        provider: Provider,
        turn_id: &str,
    ) -> Result<Arc<Proc>, String> {
        let exe = self.executable(provider).await?;
        self.make_room(&record.id)?;
        let cwd = PathBuf::from(&record.cwd);
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(format!(
                "The project folder {} is not available.",
                record.cwd
            ));
        }
        let args = match provider {
            Provider::Claude => {
                let mcp = if record.playwright {
                    Some(self.write_mcp_config(&record.id)?)
                } else {
                    None
                };
                claude_args(record, &uuid_v4(), mcp.as_deref())
            }
            Provider::Codex => codex_args(record),
        };
        let mut child = OwnedProcess::spawn(&exe, &args, &cwd, &launch_env())
            .map_err(|e| format!("Could not start {}: {e:#}", provider.label()))?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            let _ = child.terminate();
            return Err(format!("{} started without its pipes.", provider.label()));
        };
        let (sender, lines) = mpsc::channel::<String>();
        thread::spawn(move || {
            let mut stdin = stdin;
            for line in lines {
                let written = stdin
                    .write_all(line.as_bytes())
                    .and_then(|_| stdin.write_all(b"\n"))
                    .and_then(|_| stdin.flush());
                if written.is_err() {
                    break;
                }
            }
            // Dropping stdin here gives the provider EOF.
        });
        let tail = Arc::new(Mutex::new(String::new()));
        {
            let tail = tail.clone();
            thread::spawn(move || drain_stderr(stderr, tail));
        }
        let proc = Arc::new(Proc {
            generation: self.generation.fetch_add(1, Ordering::SeqCst) + 1,
            provider,
            child: Mutex::new(child),
            input: Mutex::new(Some(sender)),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            stderr: tail,
            expected_exit: AtomicBool::new(false),
        });
        let replaced = lock(&self.state).live.insert(
            record.id.clone(),
            Live {
                proc: proc.clone(),
                last_used: Instant::now(),
            },
        );
        if let Some(old) = replaced {
            shutdown(old.proc);
        }
        {
            let inner = self.clone();
            let reader = proc.clone();
            let id = record.id.clone();
            thread::spawn(move || inner.read_stdout(id, reader, stdout));
        }
        if provider == Provider::Codex {
            if let Err(message) = self.codex_handshake(record, &proc, turn_id).await {
                self.finish_turn(&record.id, Some(turn_id), "failed", Some(message.clone()), "error");
                proc.kill();
                return Err(message);
            }
        }
        Ok(proc)
    }

    async fn codex_handshake(
        &self,
        record: &Record,
        proc: &Arc<Proc>,
        turn_id: &str,
    ) -> Result<(), String> {
        rpc(
            proc,
            "initialize",
            json!({"clientInfo": {"name": "codaclauda", "title": "CodaClauda", "version": env!("CARGO_PKG_VERSION")},
                   "capabilities": {"experimentalApi": false, "optOutNotificationMethods": CODEX_QUIET}}),
        )
        .await?;
        proc.write(json!({"method": "initialized"}).to_string())?;
        let mut base = json!({"cwd": record.cwd, "sandbox": sandbox_mode(&record.access), "approvalPolicy": "never"});
        if let Some(model) = &record.model {
            base["model"] = json!(model);
        }
        let known = lock(&self.state)
            .records
            .iter()
            .find(|r| r.id == record.id)
            .and_then(|r| r.thread_id.clone());
        let result = match known {
            Some(thread) => {
                let mut params = base.clone();
                params["threadId"] = json!(thread);
                params["excludeTurns"] = json!(true);
                match rpc(proc, "thread/resume", params).await {
                    Ok(result) => result,
                    Err(problem) => {
                        self.publish(
                            event(
                                &record.id,
                                Some(turn_id),
                                "error",
                                json!({"error": format!("Codex could not resume the earlier thread ({problem}). Starting a new thread; earlier context is not available to it.")}),
                            ),
                            true,
                        );
                        thread_start(proc, base).await?
                    }
                }
            }
            None => thread_start(proc, base).await?,
        };
        let thread = result["thread"]["id"]
            .as_str()
            .ok_or("Codex did not return a thread id.")?
            .to_owned();
        let session = result["thread"]["sessionId"]
            .as_str()
            .unwrap_or(&thread)
            .to_owned();
        self.with_record(&record.id, |r| {
            r.thread_id = Some(thread);
            r.provider_session_id = Some(session);
        });
        Ok(())
    }

    // ------------------------------------------------------------- commands

    fn list(&self) -> Value {
        json!({"sessions": lock(&self.state).records})
    }

    async fn start(&self, args: Value) -> Result<Value, Failure> {
        let invalid = |m: &str| ("INVALID_ARGUMENTS", m.to_owned());
        let provider = Provider::parse(args["provider"].as_str().unwrap_or(""))
            .ok_or_else(|| invalid("provider must be claude or codex."))?;
        let access = match args["access"].as_str() {
            Some("full") => "full",
            Some("read") | None => "read",
            _ => return Err(invalid("access must be full or read.")),
        };
        let cwd = args["cwd"]
            .as_str()
            .map(str::trim)
            .filter(|c| !c.is_empty() && c.len() <= 4096)
            .ok_or_else(|| invalid("cwd must be the project folder."))?;
        let folder = Path::new(cwd);
        if !folder.is_absolute() || !folder.is_dir() {
            return Err((
                "PROJECT_MISSING",
                format!("{cwd} is not an existing project folder."),
            ));
        }
        let short = |value: &Value, limit: usize| {
            value
                .as_str()
                .map(|s| s.trim().chars().filter(|c| !c.is_control()).take(limit).collect::<String>())
                .filter(|s| !s.is_empty())
        };
        let word = |value: &Value| -> Result<Option<String>, Failure> {
            match value.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                None => Ok(None),
                Some(s)
                    if s.len() <= 80
                        && s.chars().all(|c| c.is_ascii_alphanumeric() || "-._[]:/".contains(c)) =>
                {
                    Ok(Some(s.to_owned()))
                }
                Some(_) => Err(invalid("model and effort must be short names.")),
            }
        };
        let model = word(&args["model"])?;
        let effort = word(&args["effort"])?;
        let shared_id = short(&args["sharedId"], 128);
        self.executable(provider)
            .await
            .map_err(|message| ("AGENT_UNAVAILABLE", message))?;
        let now = now_ms();
        let record = Record {
            id: format!("s_{}", random_hex(8)),
            provider: provider.name().into(),
            project_id: short(&args["projectId"], 512).unwrap_or_else(|| cwd.to_owned()),
            cwd: cwd.to_owned(),
            title: short(&args["title"], 200)
                .unwrap_or_else(|| format!("{} chat", provider.label())),
            access: access.into(),
            thread_id: None,
            provider_session_id: None,
            status: "idle".into(),
            created_at: now,
            last_activity_at: now,
            shared: shared_id.is_some(),
            shared_id,
            playwright: args["playwright"].as_bool().unwrap_or(false),
            model,
            effort,
            turn_id: None,
        };
        {
            let mut state = lock(&self.state);
            state.records.push(record.clone());
            self.save(&state);
        }
        Ok(json!({"session": record}))
    }

    fn send(
        self: &Arc<Self>,
        id: String,
        text: String,
        attachments: Vec<Attachment>,
    ) -> Result<Value, Failure> {
        if text.trim().is_empty() && attachments.is_empty() {
            return Err(("INVALID_ARGUMENTS", "Type a message first.".into()));
        }
        if text.len() > TEXT_LIMIT || attachments.len() > 20 {
            return Err((
                "INPUT_TOO_LARGE",
                "The message or its attachment list is too large.".into(),
            ));
        }
        if attachments.iter().any(|a| !Path::new(&a.path).is_absolute()) {
            return Err(("INVALID_ARGUMENTS", "Attachments need absolute paths.".into()));
        }
        let turn_id = format!("t_{}", random_hex(6));
        let (record, proc) = {
            let mut state = lock(&self.state);
            if state.turns.contains_key(&id) {
                return Err((
                    "SESSION_BUSY",
                    "This agent is still replying. Stop it or wait for it to finish.".into(),
                ));
            }
            let Some(record) = state.records.iter_mut().find(|r| r.id == id) else {
                return Err(("SESSION_NOT_FOUND", "That chat no longer exists.".into()));
            };
            record.status = "running".into();
            record.turn_id = Some(turn_id.clone());
            record.last_activity_at = now_ms();
            let record = record.clone();
            state.turns.insert(
                id.clone(),
                Turn {
                    id: turn_id.clone(),
                    provider_turn: None,
                    stopping: false,
                },
            );
            let proc = state.live.get_mut(&id).map(|live| {
                live.last_used = Instant::now();
                live.proc.clone()
            });
            self.save(&state);
            (record, proc)
        };
        self.publish(
            event(
                &id,
                Some(&turn_id),
                "user",
                json!({"text": text, "attachments": attachments}),
            ),
            true,
        );
        self.publish(
            event(&id, Some(&turn_id), "status", json!({"status": "running"})),
            false,
        );
        let inner = self.clone();
        let turn = turn_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(message) = inner
                .deliver(&record, proc, &turn, &text, &attachments)
                .await
            {
                inner.finish_turn(&record.id, Some(&turn), "failed", Some(message), "error");
            }
        });
        Ok(json!({"accepted": true, "turnId": turn_id}))
    }

    async fn deliver(
        self: &Arc<Self>,
        record: &Record,
        proc: Option<Arc<Proc>>,
        turn_id: &str,
        text: &str,
        attachments: &[Attachment],
    ) -> Result<(), String> {
        let provider = Provider::parse(&record.provider).ok_or("Unknown provider.")?;
        let proc = match proc {
            Some(proc) => proc,
            None => self.launch(record, provider, turn_id).await?,
        };
        if !self.turn_active(&record.id, turn_id) {
            return Ok(()); // stopped while the agent was starting
        }
        let prompt = with_attachments(text, attachments);
        match provider {
            Provider::Claude => proc.write(
                json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": prompt}]}, "parent_tool_use_id": null})
                    .to_string(),
            ),
            Provider::Codex => {
                let thread = lock(&self.state)
                    .records
                    .iter()
                    .find(|r| r.id == record.id)
                    .and_then(|r| r.thread_id.clone())
                    .ok_or("Codex has no thread for this chat.")?;
                let mut input = vec![json!({"type": "text", "text": prompt})];
                for attachment in attachments.iter().filter(|a| is_image(&a.path)) {
                    input.push(json!({"type": "localImage", "path": attachment.path}));
                }
                let mut params = json!({"threadId": thread, "input": input, "approvalPolicy": "never", "sandboxPolicy": sandbox_policy(&record.access)});
                if let Some(effort) = &record.effort {
                    params["effort"] = json!(effort);
                }
                if let Some(model) = &record.model {
                    params["model"] = json!(model);
                }
                let result = rpc(&proc, "turn/start", params).await?;
                if let Some(provider_turn) = result["turn"]["id"].as_str() {
                    if let Some(turn) = lock(&self.state).turns.get_mut(&record.id) {
                        turn.provider_turn.get_or_insert(provider_turn.to_owned());
                    }
                }
                Ok(())
            }
        }
    }

    fn stop(self: &Arc<Self>, id: &str) -> Result<Value, Failure> {
        let (turn_id, provider_turn, proc, thread) = {
            let mut state = lock(&self.state);
            let Some(thread) = state
                .records
                .iter()
                .find(|r| r.id == id)
                .map(|r| r.thread_id.clone())
            else {
                return Err(("SESSION_NOT_FOUND", "That chat no longer exists.".into()));
            };
            let proc = state.live.get(id).map(|l| l.proc.clone());
            let Some(turn) = state.turns.get_mut(id) else {
                return Ok(json!({"stopped": true}));
            };
            turn.stopping = true;
            (turn.id.clone(), turn.provider_turn.clone(), proc, thread)
        };
        let Some(proc) = proc else {
            self.finish_turn(id, Some(&turn_id), "interrupted", None, "idle");
            return Ok(json!({"stopped": true}));
        };
        match proc.provider {
            Provider::Claude => {
                let _ = proc.write(
                    json!({"type": "control_request", "request_id": format!("stop_{}", random_hex(6)), "request": {"subtype": "interrupt"}})
                        .to_string(),
                );
            }
            Provider::Codex => {
                if let (Some(thread), Some(provider_turn)) = (thread, provider_turn) {
                    let proc = proc.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = rpc(
                            &proc,
                            "turn/interrupt",
                            json!({"threadId": thread, "turnId": provider_turn}),
                        )
                        .await;
                    });
                }
            }
        }
        // If the provider ignores the interrupt, end its process; the session
        // stays resumable and the next send resumes it.
        let inner = self.clone();
        let id = id.to_owned();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(STOP_GRACE).await;
            if lock(&inner.state)
                .turns
                .get(&id)
                .is_some_and(|t| t.id == turn_id)
            {
                proc.kill();
            }
        });
        Ok(json!({"stopped": true}))
    }

    fn close(&self, id: &str) -> Result<Value, Failure> {
        let (live, turn) = {
            let mut state = lock(&self.state);
            let Some(record) = state.records.iter_mut().find(|r| r.id == id) else {
                return Err(("SESSION_NOT_FOUND", "That chat no longer exists.".into()));
            };
            record.status = "stopped".into();
            record.turn_id = None;
            let live = state.live.remove(id);
            let turn = state.turns.remove(id);
            self.save(&state);
            (live, turn)
        };
        if let Some(turn) = turn {
            self.publish(
                event(id, Some(&turn.id), "done", json!({"status": "interrupted"})),
                true,
            );
        }
        self.publish(event(id, None, "status", json!({"status": "stopped"})), false);
        if let Some(live) = live {
            shutdown(live.proc);
        }
        Ok(json!({"closed": true}))
    }

    fn history(&self, id: &str, limit: Option<u64>) -> Result<Value, Failure> {
        if !valid_id(id) || !lock(&self.state).records.iter().any(|r| r.id == id) {
            return Err(("SESSION_NOT_FOUND", "That chat no longer exists.".into()));
        }
        let limit = limit.unwrap_or(HISTORY_DEFAULT).clamp(1, HISTORY_MAX) as usize;
        let bytes = {
            let _guard = lock(&self.log_lock);
            match fs::read(self.log_path(id)) {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                Err(e) => return Err(("READ_FAILED", format!("Could not read this chat: {e}"))),
            }
        };
        let mut events: Vec<Value> = bytes
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
            .filter_map(|line| serde_json::from_slice(line).ok())
            .collect();
        if events.len() > limit {
            events.drain(..events.len() - limit);
        }
        Ok(json!({"events": events}))
    }

    fn reap_idle(&self) {
        let victims: Vec<Live> = {
            let mut state = lock(&self.state);
            let idle: Vec<String> = state
                .live
                .iter()
                .filter(|(id, live)| {
                    !state.turns.contains_key(*id) && live.last_used.elapsed() > IDLE_LIMIT
                })
                .map(|(id, _)| id.clone())
                .collect();
            idle.iter().filter_map(|id| state.live.remove(id)).collect()
        };
        for live in victims {
            shutdown(live.proc);
        }
    }
}

// ------------------------------------------------------------------ helpers

async fn rpc(proc: &Arc<Proc>, method: &str, params: Value) -> Result<Value, String> {
    let call = proc.next_id.fetch_add(1, Ordering::SeqCst);
    let (sender, receiver) = oneshot::channel();
    lock(&proc.pending).insert(call, sender);
    if let Err(problem) =
        proc.write(json!({"id": call, "method": method, "params": params}).to_string())
    {
        lock(&proc.pending).remove(&call);
        return Err(problem);
    }
    match tokio::time::timeout(RPC_WAIT, receiver).await {
        Ok(Ok(result)) => result.map_err(|e| format!("Codex rejected {method}: {e}")),
        Ok(Err(_)) => Err(format!("Codex stopped before answering {method}.")),
        Err(_) => {
            lock(&proc.pending).remove(&call);
            Err(format!("Codex did not answer {method} in time."))
        }
    }
}

async fn thread_start(proc: &Arc<Proc>, mut params: Value) -> Result<Value, String> {
    params["serviceName"] = json!("codaclauda");
    rpc(proc, "thread/start", params).await
}

fn drain_stderr(mut stderr: File, tail: Arc<Mutex<String>>) {
    let mut buffer = [0u8; 4096];
    while let Ok(size) = stderr.read(&mut buffer) {
        if size == 0 {
            break;
        }
        let mut kept = lock(&tail);
        kept.push_str(&String::from_utf8_lossy(&buffer[..size]));
        if kept.len() > STDERR_TAIL {
            let mut cut = kept.len() - STDERR_TAIL;
            while !kept.is_char_boundary(cut) {
                cut += 1;
            }
            kept.drain(..cut);
        }
    }
}

fn launch_env() -> BTreeMap<OsString, OsString> {
    let mut env = adapters::subscription_environment();
    env.retain(|name, _| {
        let name = name.to_string_lossy().to_ascii_uppercase();
        !STRIPPED_ENV.contains(&name.as_str())
    });
    env
}

fn sandbox_mode(access: &str) -> &'static str {
    if access == "full" {
        "danger-full-access"
    } else {
        "read-only"
    }
}

fn sandbox_policy(access: &str) -> Value {
    if access == "full" {
        json!({"type": "dangerFullAccess"})
    } else {
        json!({"type": "readOnly"})
    }
}

fn claude_args(record: &Record, fresh_session: &str, mcp: Option<&Path>) -> Vec<OsString> {
    let mode = if record.access == "full" {
        "bypassPermissions"
    } else {
        "plan"
    };
    let mut args: Vec<OsString> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--disable-slash-commands",
        "--permission-mode",
        mode,
        "--permission-prompts",
        "none",
    ]
    .map(OsString::from)
    .into();
    if let Some(model) = &record.model {
        args.extend(["--model".into(), model.into()]);
    }
    if let Some(effort) = &record.effort {
        args.extend(["--effort".into(), effort.into()]);
    }
    match &record.provider_session_id {
        Some(session) => args.extend(["--resume".into(), session.into()]),
        None => args.extend(["--session-id".into(), fresh_session.into()]),
    }
    // Variadic flag: keep it last.
    if let Some(path) = mcp {
        args.extend(["--mcp-config".into(), path.as_os_str().to_owned()]);
    }
    args
}

fn codex_args(record: &Record) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        "forced_login_method=\"chatgpt\"",
    ]
    .map(OsString::from)
    .into();
    if record.playwright {
        args.extend([
            "-c".into(),
            "mcp_servers.playwright.command=\"cmd\"".into(),
            "-c".into(),
            format!("mcp_servers.playwright.args=[\"/c\",\"npx\",\"-y\",\"{PLAYWRIGHT_MCP}\"]").into(),
        ]);
    }
    args
}

fn is_image(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| {
            ["png", "jpg", "jpeg", "gif", "webp", "bmp"]
                .iter()
                .any(|x| e.eq_ignore_ascii_case(x))
        })
}

fn with_attachments(text: &str, attachments: &[Attachment]) -> String {
    if attachments.is_empty() {
        return text.to_owned();
    }
    let mut prompt = text.to_owned();
    prompt.push_str("\n\nAttached files:");
    for attachment in attachments {
        let name = if attachment.name.trim().is_empty() {
            Path::new(&attachment.path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        } else {
            attachment.name.clone()
        };
        prompt.push_str(&format!("\n- {name}: {}", attachment.path));
    }
    prompt
}

// --------------------------------------------------------------- discovery

fn scan(root: &Path, name: &str, depth: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 || out.len() >= 32 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.take(128).flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_file() && entry.file_name().to_string_lossy().eq_ignore_ascii_case(name) {
            out.push(entry.path());
        } else if kind.is_dir() {
            scan(&entry.path(), name, depth - 1, out);
        }
    }
}

/// The version folder in a desktop-app bundle path (`claude-code\2.1.299\…`).
fn path_version(path: &Path) -> Vec<u64> {
    path.components()
        .filter_map(|c| {
            let part = c.as_os_str().to_string_lossy();
            (part.contains('.') && part.chars().all(|ch| ch.is_ascii_digit() || ch == '.'))
                .then(|| session_parse::parse_version(&part))
        })
        .next_back()
        .unwrap_or_default()
}

/// Newest signed-in desktop-app bundle (or PATH install), using coord-core's
/// read-only probe. No model request is made.
fn discover(provider: Provider) -> Result<PathBuf, String> {
    let var = |name: &str| {
        std::env::var_os(name)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    let mut found = Vec::new();
    match provider {
        Provider::Claude => {
            if let Some(roaming) = var("APPDATA") {
                scan(&roaming.join("Claude").join("claude-code"), provider.exe(), 3, &mut found);
            }
            if let Some(local) = var("LOCALAPPDATA") {
                if let Ok(packages) = fs::read_dir(local.join("Packages")) {
                    for package in packages.flatten().filter(|p| {
                        p.file_name().to_string_lossy().starts_with("AnthropicPBC.Claude_")
                    }) {
                        scan(
                            &package.path().join("LocalCache/Roaming/Claude/claude-code"),
                            provider.exe(),
                            3,
                            &mut found,
                        );
                    }
                }
            }
            if let Some(profile) = var("USERPROFILE") {
                scan(&profile.join(".local").join("bin"), provider.exe(), 1, &mut found);
            }
        }
        Provider::Codex => {
            if let Some(local) = var("LOCALAPPDATA") {
                scan(&local.join("OpenAI/Codex/bin"), provider.exe(), 2, &mut found);
            }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(provider.exe());
            if candidate.is_absolute() && candidate.is_file() {
                found.push(candidate);
            }
        }
    }
    // Newest bundle first; identical versions (MSIX mirror of the same bundle) once.
    let mut seen = std::collections::BTreeSet::new();
    found.retain(|p| {
        let version = path_version(p);
        let key = if version.is_empty() {
            p.to_string_lossy().to_ascii_lowercase()
        } else {
            format!("{version:?}")
        };
        seen.insert(key)
    });
    found.sort_by_key(|p| std::cmp::Reverse(path_version(p)));
    let mut best: Option<(Vec<u64>, PathBuf)> = None;
    let mut problem = None;
    for candidate in found.iter().take(4) {
        match adapters::probe(provider.name(), candidate) {
            Ok(result) if result["authenticated"] == true => {
                let version = session_parse::parse_version(result["version"].as_str().unwrap_or(""));
                if !path_version(candidate).is_empty() {
                    best = Some((version, candidate.clone()));
                    break; // sorted newest first
                }
                if best.as_ref().is_none_or(|(v, _)| version > *v) {
                    best = Some((version, candidate.clone()));
                }
            }
            Ok(_) => problem = Some("it is not signed in to a subscription".to_owned()),
            Err(e) => problem = Some(e.to_string()),
        }
    }
    best.map(|(_, path)| path).ok_or_else(|| match provider {
        Provider::Claude => format!(
            "Claude Code is not ready{}. Open the Claude desktop app and sign in, then try again.",
            problem.map(|p| format!(" ({p})")).unwrap_or_default()
        ),
        Provider::Codex => format!(
            "Codex is not ready{}. Open the Codex app and sign in with ChatGPT, then try again.",
            problem.map(|p| format!(" ({p})")).unwrap_or_default()
        ),
    })
}

// ----------------------------------------------------------------- commands

fn host(app: &tauri::AppHandle) -> Arc<Inner> {
    app.state::<SessionHost>().inner.clone()
}

fn reply(result: Result<Value, Failure>) -> Value {
    match result {
        Ok(data) => ok(data),
        Err((code, message)) => error(code, message),
    }
}

#[tauri::command]
pub(crate) async fn session_list(app: tauri::AppHandle) -> Value {
    ok(host(&app).list())
}

#[tauri::command]
pub(crate) async fn session_start(app: tauri::AppHandle, args: Value) -> Value {
    let inner = host(&app);
    reply(inner.start(args).await)
}

#[tauri::command]
pub(crate) async fn session_send(
    app: tauri::AppHandle,
    id: String,
    text: String,
    attachments: Option<Vec<Attachment>>,
) -> Value {
    let inner = host(&app);
    reply(inner.send(id, text, attachments.unwrap_or_default()))
}

#[tauri::command]
pub(crate) async fn session_stop(app: tauri::AppHandle, id: String) -> Value {
    let inner = host(&app);
    reply(inner.stop(&id))
}

#[tauri::command]
pub(crate) async fn session_close(app: tauri::AppHandle, id: String) -> Value {
    reply(host(&app).close(&id))
}

#[tauri::command]
pub(crate) async fn session_history(
    app: tauri::AppHandle,
    id: String,
    limit: Option<u64>,
) -> Value {
    reply(host(&app).history(&id, limit))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(provider: &str, access: &str) -> Record {
        Record {
            id: "s_0123456789abcdef".into(),
            provider: provider.into(),
            project_id: "p".into(),
            cwd: "C:\\p".into(),
            title: "t".into(),
            access: access.into(),
            thread_id: None,
            provider_session_id: None,
            status: "idle".into(),
            created_at: 0,
            last_activity_at: 0,
            shared: false,
            shared_id: None,
            playwright: true,
            model: None,
            effort: None,
            turn_id: None,
        }
    }

    #[test]
    fn launch_arguments_follow_the_access_level() {
        let full: Vec<String> = claude_args(&record("claude", "full"), "u", Some(Path::new("m.json")))
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(full.windows(2).any(|w| w == ["--permission-mode", "bypassPermissions"]));
        assert!(full.contains(&"--disable-slash-commands".to_owned()));
        assert_eq!(full[full.len() - 2..], ["--mcp-config", "m.json"]);
        let read: Vec<String> = claude_args(&record("claude", "read"), "u", None)
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(read.windows(2).any(|w| w == ["--permission-mode", "plan"]));
        assert!(read.windows(2).any(|w| w == ["--session-id", "u"]));
        let codex: Vec<String> = codex_args(&record("codex", "read"))
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(codex.contains(&"forced_login_method=\"chatgpt\"".to_owned()));
        assert!(valid_id("s_0123456789abcdef") && !valid_id("s_../../x"));
        assert_eq!(uuid_v4().len(), 36);
    }
}
