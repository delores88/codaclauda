//! CodaClauda 0.4 session engine. The app process owns every provider process
//! (one kill-on-close job object each, so agents die with the app), streams
//! normalized events to the webview on `session://event`, and keeps the
//! registry (`sessions.json`) and per-session display logs
//! (`sessions/<id>.jsonl`) next to `ui-state.json`. API-key variables are
//! stripped from every launch. Supported personal authentication and effective
//! provider policy are checked before dispatch; credentials are never copied.
//!
//! 0.4.1 adds a per-session send queue (owner turns, wakes and scheduled runs
//! wait their turn), wake on mail (`wake.rs`) and in-app schedules
//! (`schedule.rs`); both reuse the one send/lifecycle path below.
//!
//! 0.5 adds fork and hand-off (`fork.rs`), an optional git worktree per chat
//! with diff/apply/discard/PR (`worktree.rs`), usage and context fill with
//! Codex compact-now, read-only detection of other Claude/Codex sessions
//! (`external.rs`), the owner's own MCP servers at Full access (`mcp.rs`) and
//! opt-in phone push (`notify.rs`). All of them reuse the lifecycle below.
//! How many agents may work at once is an owner setting (`limits.rs`), new
//! sessions wake on mail by default, and agents can start teammates in
//! projects where the owner allows it (`team.rs`).

pub(crate) mod external;
pub(crate) mod fork;
pub(crate) mod limits;
pub(crate) mod mcp;
pub(crate) mod notify;
pub(crate) mod schedule;
pub(crate) mod team;
pub(crate) mod wake;
pub(crate) mod worktree;

use crate::session_parse::{self, Out, Reported, Usage};
use crate::session_policy;
use crate::{board, error};
use coord_core::adapters::{self, OwnedProcess};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard, Weak,
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
const IDLE_LIMIT: Duration = Duration::from_secs(10 * 60);
const REAP_EVERY: Duration = Duration::from_secs(60);
const STOP_GRACE: Duration = Duration::from_secs(5);
const RPC_WAIT: Duration = Duration::from_secs(90);
const TEXT_LIMIT: usize = 256 * 1024;
const STDERR_TAIL: usize = 4096;
const HISTORY_DEFAULT: u64 = 500;
const HISTORY_MAX: u64 = 5000;
/// Turns that may wait behind the current one, per session.
const QUEUE_MAX: usize = 50;
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
    "turn/diff/updated",
];

type Failure = (&'static str, String);

fn require_browser_disabled(playwright: bool) -> Result<(), String> {
    if playwright {
        return Err("Browser control is unavailable in CodaClauda. Start a new session without browser control.".into());
    }
    Ok(())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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

#[derive(Clone, Default, Serialize, Deserialize)]
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
    /// Wake on mail (0.4.1): opt-in, off by default.
    #[serde(default)]
    wake: bool,
    /// This session's own board address, kept once assigned.
    #[serde(default)]
    mailbox_address: Option<String>,
    #[serde(default)]
    wakes: Wakes,
    /// 0.5 worktree chats: the worktree root and its `codaclauda/<short>` branch.
    #[serde(default)]
    worktree_path: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    /// The original checkout and the branch/commit the worktree started from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    repo_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pr_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pr_number: Option<u64>,
    #[serde(default)]
    usage: Usage,
    /// Codex account rate-limit windows, as last reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rate_limits: Option<Value>,
    /// A fork's source provider session (Claude) or thread (Codex), forked on
    /// its first launch; `forked_from`/`handoff_from` name the CodaClauda chat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fork_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    forked_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    handoff_from: Option<String>,
    /// 0.5 team starts: { address, messageId, at } of the (self-asserted)
    /// agent whose board request started this session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    started_by: Option<Value>,
    /// 0.5: the short CodaClauda note still has to precede the first turn.
    #[serde(default)]
    team_note: bool,
}

/// Wake counters shown in the UI: rolling hour and day, and all time.
#[derive(Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(default)]
struct Wakes {
    hour: u32,
    day: u32,
    total: u64,
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
    failure: Mutex<Option<String>>,
    completed_turns: Mutex<HashSet<String>>,
    /// Held until a completed turn or confirmed process exit. The updater takes
    /// this same board lease exclusively before it permits replacement.
    runtime_lease: Mutex<Option<Arc<File>>>,
    /// Claude: tokens in context after the latest model call.
    context: AtomicU64,
    /// The saved usage when this process first reported, and whether it
    /// restored the provider's earlier totals (see `merge_usage`).
    usage_base: Mutex<Option<(Usage, Option<bool>)>>,
    /// (name, command) of the owner's MCP servers passed to this launch.
    mcp: Mutex<Vec<(String, String)>>,
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

/// No new process may reuse a capacity slot until the previous owned process
/// has actually exited. Job termination also stops its helper descendants.
fn retire(proc: &Arc<Proc>) -> bool {
    proc.kill();
    lock(&proc.input).take();
    lock(&proc.pending).clear();
    for _ in 0..50 {
        if matches!(lock(&proc.child).try_wait(), Ok(Some(_))) {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn spawn_owned(
    exe: &Path,
    args: &[OsString],
    cwd: &Path,
    provider: Provider,
    generation: u64,
    lease: Arc<File>,
    extra_env: &[(String, String)],
) -> Result<(Arc<Proc>, File), String> {
    let mut env = launch_env();
    // The owner's MCP server variables (names checked when saved, never the
    // stripped provider controls), inherited by the MCP children.
    for (name, value) in extra_env {
        env.retain(|key, _| !key.to_string_lossy().eq_ignore_ascii_case(name));
        env.insert(name.into(), value.into());
    }
    let mut child = OwnedProcess::spawn(exe, args, cwd, &env)
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
    });
    let tail = Arc::new(Mutex::new(String::new()));
    {
        let tail = tail.clone();
        thread::spawn(move || drain_stderr(stderr, tail));
    }
    Ok((
        Arc::new(Proc {
            generation,
            provider,
            child: Mutex::new(child),
            input: Mutex::new(Some(sender)),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            stderr: tail,
            expected_exit: AtomicBool::new(false),
            failure: Mutex::new(None),
            completed_turns: Mutex::new(HashSet::new()),
            runtime_lease: Mutex::new(Some(lease)),
            context: AtomicU64::new(0),
            usage_base: Mutex::new(None),
            mcp: Mutex::new(Vec::new()),
        }),
        stdout,
    ))
}

struct Live {
    proc: Arc<Proc>,
    last_used: Instant,
}

struct Turn {
    id: String,
    provider_turn: Option<String>,
    stopping: bool,
    dispatched: bool,
    start_pending: bool,
    completion: Option<String>,
    _lease: Arc<File>,
    /// Null for an owner turn; {kind:'wake'|'schedule', ...} otherwise.
    origin: Value,
}

/// A turn waiting in a session's send queue (or about to start).
#[derive(Clone, Serialize, Deserialize)]
struct Queued {
    turn_id: String,
    text: String,
    attachments: Vec<Attachment>,
    origin: Value,
    #[serde(default)]
    key: Option<String>,
}

impl Queued {
    fn new(text: String, attachments: Vec<Attachment>, origin: Value) -> Self {
        Self {
            turn_id: format!("t_{}", random_hex(6)),
            text,
            attachments,
            origin,
            key: None,
        }
    }

    /// Automation retries reuse an identity, never generate a second turn.
    fn keyed(text: String, attachments: Vec<Attachment>, origin: Value, key: String) -> Self {
        Self {
            turn_id: keyed_turn_id(&key),
            text,
            attachments,
            origin,
            key: Some(key),
        }
    }

    fn fingerprint(&self, session: &str) -> String {
        hex_digest(
            &serde_json::to_vec(&json!({
                "sessionId": session, "text": self.text, "attachments": self.attachments,
                "origin": self.origin, "key": self.key,
            }))
            .expect("A turn contains only JSON values"),
        )
    }

    fn user_event(&self, session: &str) -> Value {
        let mut data = json!({"text": self.text, "attachments": self.attachments, "queued": true});
        if !self.origin.is_null() {
            data["origin"] = self.origin.clone();
        }
        event(session, Some(&self.turn_id), "user", data)
    }
}

/// Turns that need no automation revalidation: the owner's own, Codex
/// compact-now, a hand-off's summary (0.5), and a team start's first turn,
/// authorized by the project switch when its session was created.
fn owner_equivalent_origin(origin: &Value) -> bool {
    origin.is_null() || matches!(origin["kind"].as_str(), Some("compact" | "handoff" | "team"))
}

fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn keyed_turn_id(key: &str) -> String {
    format!(
        "t_{}",
        hex_digest(format!("codaclauda.turn/1:{key}").as_bytes())
    )
}

fn valid_turn_id(id: &str) -> bool {
    id.starts_with("t_")
        && (3..=80).contains(&id.len())
        && id[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Persisted in the same atomic snapshot as session records. Terminal entries
/// retain a small identity/outcome index; prompt and attachment copies are
/// removed once their terminal display events have been saved. Dedupe identities
/// are never discarded merely because the bounded display log was trimmed.
#[derive(Clone, Serialize, Deserialize)]
struct DurableTurn {
    session_id: String,
    turn_id: String,
    fingerprint: String,
    key: Option<String>,
    origin: Value,
    status: String,
    error: Option<String>,
    payload: Option<Queued>,
    history_saved: bool,
}

impl DurableTurn {
    fn accepted(session: &str, item: &Queued) -> Self {
        Self {
            session_id: session.to_owned(),
            turn_id: item.turn_id.clone(),
            fingerprint: item.fingerprint(session),
            key: item.key.clone(),
            origin: item.origin.clone(),
            status: "queued".into(),
            error: None,
            payload: Some(item.clone()),
            history_saved: false,
        }
    }

    fn terminal(&self) -> bool {
        matches!(
            self.status.as_str(),
            "completed" | "failed" | "cancelled" | "interrupted"
        )
    }

    fn settle(&mut self, status: &str, error: Option<&str>) {
        self.status = status.to_owned();
        self.error = error.map(str::to_owned);
        self.history_saved = false;
    }

    fn outcome(&self) -> Value {
        json!({"turnId": self.turn_id, "sessionId": self.session_id,
            "status": self.status, "origin": self.origin, "error": self.error})
    }
}

/// A turn taken from the queue and admitted (record saved, user event
/// persisted, update lease held), ready to be delivered.
struct Started {
    record: Record,
    proc: Option<Arc<Proc>>,
    item: Queued,
    lease: Arc<File>,
}

impl Turn {
    fn complete(&mut self, status: String) -> Option<String> {
        if self.start_pending {
            self.completion = Some(status);
            None
        } else {
            Some(status)
        }
    }

    fn acknowledge(
        &mut self,
        completed: &HashSet<String>,
        provider_turn: &str,
    ) -> Result<Option<String>, String> {
        if !accept_codex_turn(self, completed, Some(provider_turn)) {
            return Err(
                "Codex returned conflicting turn identities; its process will be stopped.".into(),
            );
        }
        self.start_pending = false;
        Ok(self.completion.take())
    }
}

/// Notifications and turn/start responses may interleave. Remember completed
/// provider IDs so late output cannot bind a newly admitted local turn.
fn accept_codex_turn(
    turn: &mut Turn,
    completed: &HashSet<String>,
    provider_turn: Option<&str>,
) -> bool {
    let Some(provider_turn) = provider_turn.filter(|id| !id.is_empty()) else {
        return false;
    };
    if completed.contains(provider_turn) {
        return false;
    }
    match &turn.provider_turn {
        Some(current) => current == provider_turn,
        None => {
            turn.provider_turn = Some(provider_turn.to_owned());
            true
        }
    }
}

struct State {
    records: Vec<Record>,
    live: HashMap<String, Live>,
    turns: HashMap<String, Turn>,
    launching: HashMap<String, String>,
    queues: HashMap<String, VecDeque<Queued>>,
    ledger: BTreeMap<String, DurableTurn>,
    /// Owner setting (Settings → Limits → Agents at once), see `limits.rs`.
    max_live: limits::Limit,
}

impl Default for State {
    fn default() -> Self {
        Self {
            records: Vec::new(),
            live: HashMap::new(),
            turns: HashMap::new(),
            launching: HashMap::new(),
            queues: HashMap::new(),
            ledger: BTreeMap::new(),
            max_live: limits::Limit::Unlimited,
        }
    }
}

impl State {
    fn duplicate(&self, session: &str, item: &Queued) -> Result<Option<Value>, Failure> {
        let Some(previous) = self.ledger.get(&item.turn_id) else {
            return Ok(None);
        };
        if previous.session_id != session || previous.fingerprint != item.fingerprint(session) {
            return Err((
                "TURN_ID_CONFLICT",
                "This turn identity already belongs to different content.".into(),
            ));
        }
        Ok(Some(json!({"accepted": true, "turnId": previous.turn_id,
            "queued": self.queues.get(session).map_or(0, VecDeque::len),
            "duplicate": true, "status": previous.status})))
    }

    fn accept_queued(
        &mut self,
        session: &str,
        item: Queued,
        persist: impl FnOnce(&Self) -> Result<(), String>,
    ) -> Result<(), String> {
        let id = item.turn_id.clone();
        self.ledger
            .insert(id.clone(), DurableTurn::accepted(session, &item));
        self.queues
            .entry(session.to_owned())
            .or_default()
            .push_back(item);
        if let Err(error) = persist(self) {
            self.ledger.remove(&id);
            if let Some(queue) = self.queues.get_mut(session) {
                queue.retain(|turn| turn.turn_id != id);
                if queue.is_empty() {
                    self.queues.remove(session);
                }
            }
            return Err(error);
        }
        Ok(())
    }

    /// Recovery never reconstructs a runnable queue. Both queued and active
    /// acceptances become inspectable interruptions, including automation.
    fn interrupt_pending(&mut self) -> (bool, Vec<(String, Option<String>)>) {
        let known: HashSet<_> = self.ledger.keys().cloned().collect();
        let mut legacy = Vec::new();
        let mut changed = false;
        for record in &mut self.records {
            if record.status == "running" {
                record.status = "idle".into();
                let turn = record.turn_id.take();
                if !turn.as_ref().is_some_and(|id| known.contains(id)) {
                    legacy.push((record.id.clone(), turn));
                }
                changed = true;
            } else if record.turn_id.as_ref().is_some_and(|id| known.contains(id)) {
                record.turn_id = None;
                changed = true;
            }
        }
        for turn in self.ledger.values_mut().filter(|turn| !turn.terminal()) {
            turn.settle("interrupted", Some("CodaClauda closed before this turn completed. It was not replayed; inspect any partial work before sending again."));
            changed = true;
        }
        self.queues.clear();
        (changed, legacy)
    }

    fn reserve_launch(
        &mut self,
        id: &str,
        turn_id: &str,
    ) -> Result<Option<(String, Live)>, String> {
        if !self
            .turns
            .get(id)
            .is_some_and(|t| t.id == turn_id && !t.stopping)
        {
            return Err("This turn was stopped before the agent could start.".into());
        }
        if self.live.contains_key(id) || self.launching.contains_key(id) {
            return Err("This agent already has a process or launch in progress.".into());
        }
        // Unlimited (the default) never closes an idle agent to make room.
        let working = self.live.len() + self.launching.len();
        let victim = if !self.max_live.allows(working) {
            let oldest = self.live.iter()
                .filter(|(id, _)| !self.turns.contains_key(*id))
                .min_by_key(|(_, live)| live.last_used)
                .map(|(id, _)| id.clone())
                .ok_or_else(|| format!("{working} agents are already working (Settings → Limits → Agents at once). Wait for one to finish, stop one, or raise the limit."))?;
            self.live.remove(&oldest).map(|live| (oldest, live))
        } else {
            None
        };
        self.launching.insert(id.to_owned(), turn_id.to_owned());
        Ok(victim)
    }

    fn release_launch(&mut self, id: &str, turn_id: &str) {
        if self.launching.get(id).is_some_and(|turn| turn == turn_id) {
            self.launching.remove(id);
        }
    }

    fn accepts_launch(&self, id: &str, turn_id: &str) -> bool {
        self.launching.get(id).is_some_and(|turn| turn == turn_id)
            && self
                .turns
                .get(id)
                .is_some_and(|turn| turn.id == turn_id && !turn.stopping)
    }

    /// A queued turn may start only when no turn, launch or closing process
    /// still owns the session (what 0.4.0 refused as SESSION_BUSY).
    fn session_busy(&self, id: &str) -> bool {
        self.turns.contains_key(id)
            || self.launching.contains_key(id)
            || self
                .live
                .get(id)
                .is_some_and(|live| live.proc.expected_exit.load(Ordering::SeqCst))
    }
}

struct LaunchReservation {
    inner: Arc<Inner>,
    id: String,
    turn_id: String,
}

impl Drop for LaunchReservation {
    fn drop(&mut self) {
        lock(&self.inner.state).release_launch(&self.id, &self.turn_id);
        // A queued turn may have been waiting for this launch slot to clear.
        self.inner.queue_next(&self.id);
    }
}

struct Inner {
    me: Weak<Inner>,
    app: tauri::AppHandle,
    dir: PathBuf,
    board: PathBuf,
    _host_lease: File,
    state: Mutex<State>,
    /// Serializes output attribution with close/send/replacement. A generation
    /// check followed by an unlocked mutation would still permit stale output.
    lifecycle: Mutex<()>,
    storage_failure: Mutex<Option<String>>,
    executables: Mutex<HashMap<Provider, PathBuf>>,
    log_lock: Mutex<()>,
    generation: AtomicU64,
    wake: Mutex<wake::Book>,
    schedules: Mutex<Vec<schedule::Schedule>>,
    run_lock: Mutex<()>,
    notify: Mutex<notify::Settings>,
    team: Mutex<team::Book>,
    /// The team inbox address is registered once per run.
    team_registered: AtomicBool,
}

/// Tauri-managed handle to the session engine.
pub(crate) struct SessionHost {
    inner: Arc<Inner>,
}

impl SessionHost {
    pub(crate) fn new(app: tauri::AppHandle, board: &board::BoardBinding) -> Result<Self, String> {
        let dir = crate::desktop::ui_dir(board);
        ensure_dirs(&dir).map_err(|e| format!("Session storage is unavailable: {e}"))?;
        let host_lease = lease_file(&dir.join("sessions-host.lock"))?;
        FileExt::try_lock_exclusive(&host_lease).map_err(|_| {
            "CodaClauda is already open on this board. Use the existing window.".to_owned()
        })?;
        let inner = Arc::new_cyclic(|me| Inner {
            me: me.clone(),
            app,
            dir,
            board: board.state_dir().to_owned(),
            _host_lease: host_lease,
            state: Mutex::new(State::default()),
            lifecycle: Mutex::new(()),
            storage_failure: Mutex::new(None),
            executables: Mutex::new(HashMap::new()),
            log_lock: Mutex::new(()),
            generation: AtomicU64::new(0),
            wake: Mutex::new(wake::Book::default()),
            schedules: Mutex::new(Vec::new()),
            run_lock: Mutex::new(()),
            notify: Mutex::new(notify::Settings::default()),
            team: Mutex::new(team::Book::default()),
            team_registered: AtomicBool::new(false),
        });
        inner.load()?;
        inner.load_wake();
        inner.load_schedules();
        inner.load_notify();
        inner.load_limits();
        inner.load_team();
        let reaper = inner.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(REAP_EVERY).await;
                reaper.reap_idle();
            }
        });
        wake::spawn_watcher(inner.clone());
        schedule::spawn_ticker(inner.clone());
        Ok(Self { inner })
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
        if !fs::metadata(&path)?.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotADirectory,
                "Session storage contains a non-directory path.",
            ));
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

/// Match the updater's lock-file sharing rules: readers/writers may open it,
/// but Windows must not allow its identity to be replaced while it is held.
fn lease_file(path: &Path) -> Result<File, String> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            return Err("The session lease cannot be a link.".into());
        }
    }
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000).share_mode(3);
    }
    let file = options
        .open(path)
        .map_err(|e| format!("Session lease is unavailable: {e}"))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("Session lease is unavailable: {e}"))?;
    if !metadata.is_file() {
        return Err("The session lease is not a regular file.".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("The session lease cannot be a reparse point.".into());
        }
    }
    Ok(file)
}

fn runtime_lease(board: &Path) -> Result<Arc<File>, String> {
    let file = lease_file(&board.join("session-runtime.lock"))?;
    FileExt::try_lock_shared(&file).map_err(|_| {
        "An update is replacing CodaClauda. Wait for it to finish before sending.".to_owned()
    })?;
    Ok(Arc::new(file))
}

fn read_registry(path: &Path) -> Result<Vec<Record>, String> {
    read_snapshot(path).map(|(records, _)| records)
}

fn read_snapshot(path: &Path) -> Result<(Vec<Record>, BTreeMap<String, DurableTurn>), String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), BTreeMap::new()));
        }
        Err(e) => return Err(format!("Could not read the saved sessions: {e}")),
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        "The saved sessions registry is unreadable; its bytes have been preserved.".to_owned()
    })?;
    let legacy = value["schema"] == "codaclauda.sessions/1";
    if !legacy && value["schema"] != "codaclauda.sessions/2" {
        return Err(
            "The saved sessions registry has an unsupported schema; it has been preserved.".into(),
        );
    }
    let records: Vec<Record> = serde_json::from_value(value["sessions"].clone()).map_err(|_| {
        "The saved sessions registry has invalid records; it has been preserved.".to_owned()
    })?;
    let mut seen = HashSet::new();
    if records.iter().any(|r| {
        !valid_id(&r.id) || Provider::parse(&r.provider).is_none() || !seen.insert(r.id.clone())
    }) {
        return Err("The saved sessions registry has invalid or duplicate identities; it has been preserved.".into());
    }
    let ledger: BTreeMap<String, DurableTurn> = if legacy {
        if value.get("turns").is_some() {
            return Err(
                "A legacy sessions registry contains unexpected turn data; it has been preserved."
                    .into(),
            );
        }
        BTreeMap::new()
    } else {
        serde_json::from_value(value["turns"].clone()).map_err(|_| {
            "The saved turn ledger is invalid; its bytes have been preserved.".to_owned()
        })?
    };
    for (id, turn) in &ledger {
        let valid_payload = match &turn.payload {
            Some(item) => {
                item.turn_id == *id
                    && item.key == turn.key
                    && item.origin == turn.origin
                    && item.fingerprint(&turn.session_id) == turn.fingerprint
                    && item.text.len() <= TEXT_LIMIT
                    && item.attachments.len() <= 20
                    && item
                        .attachments
                        .iter()
                        .all(|a| Path::new(&a.path).is_absolute())
            }
            None => turn.terminal() && turn.history_saved,
        };
        if id != &turn.turn_id
            || turn.fingerprint.len() != 64
            || !turn.fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
            || !valid_turn_id(id)
            || !seen.contains(&turn.session_id)
            || !(turn.terminal() || matches!(turn.status.as_str(), "queued" | "active"))
            || !valid_payload
            || (turn.history_saved && turn.payload.is_some())
            || turn
                .key
                .as_ref()
                .is_some_and(|key| key.len() > 4096 || keyed_turn_id(key) != *id)
            || (turn.status == "active"
                && !records
                    .iter()
                    .any(|r| r.id == turn.session_id && r.turn_id.as_deref() == Some(id.as_str())))
        {
            return Err("The saved turn ledger has inconsistent identities or outcomes; its bytes have been preserved.".into());
        }
    }
    if !legacy
        && records.iter().any(|r| {
            r.status == "running"
                && !r.turn_id.as_ref().is_some_and(|id| {
                    ledger
                        .get(id)
                        .is_some_and(|t| t.session_id == r.id && t.status == "active")
                })
        })
    {
        return Err(
            "A running session is missing its durable turn; the registry has been preserved."
                .into(),
        );
    }
    Ok((records, ledger))
}

fn save_snapshot(
    dir: &Path,
    records: &[Record],
    ledger: &BTreeMap<String, DurableTurn>,
) -> Result<(), String> {
    ensure_dirs(dir).map_err(|e| format!("Could not prepare session storage: {e}"))?;
    let target = dir.join(REGISTRY_FILE);
    if let Ok(previous) = fs::read(&target) {
        if serde_json::from_slice::<Value>(&previous)
            .is_ok_and(|v| v["schema"] == "codaclauda.sessions/1")
        {
            let backup = dir.join("sessions.schema1.backup.json");
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&backup)
            {
                Ok(mut file) => file
                    .write_all(&previous)
                    .and_then(|_| file.sync_all())
                    .map_err(|e| {
                        format!("Could not preserve the original session registry: {e}")
                    })?,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if fs::read(&backup).map_err(|e| e.to_string())? != previous {
                        return Err("The original session registry backup differs; preserve both files before migrating.".into());
                    }
                }
                Err(e) => {
                    return Err(format!(
                        "Could not preserve the original session registry: {e}"
                    ));
                }
            }
        }
    }
    let bytes = serde_json::to_vec_pretty(
        &json!({"schema": "codaclauda.sessions/2", "sessions": records, "turns": ledger}),
    )
    .map_err(|e| format!("Could not encode saved sessions: {e}"))?;
    write_atomic(&target, &bytes).map_err(|e| format!("Could not save sessions.json: {e}"))
}

#[cfg(test)]
fn save_registry(dir: &Path, records: &[Record]) -> Result<(), String> {
    save_snapshot(dir, records, &BTreeMap::new())
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

    fn load(&self) -> Result<(), String> {
        let (records, ledger) = read_snapshot(&self.dir.join(REGISTRY_FILE))?;
        {
            let mut state = lock(&self.state);
            state.records = records;
            state.ledger = ledger;
        }
        // No provider is resumed from disk. Ensure accepted payloads can be
        // inspected, then atomically record interruption of every pending turn.
        let pending: Vec<_> = lock(&self.state)
            .ledger
            .values()
            .filter(|turn| !turn.terminal())
            .cloned()
            .collect();
        for turn in &pending {
            if let Some(item) = &turn.payload {
                self.append_once(&item.user_event(&turn.session_id))?;
            }
        }
        let legacy = {
            let mut state = lock(&self.state);
            let (changed, legacy) = state.interrupt_pending();
            if changed {
                self.save(&state)?;
            }
            legacy
        };
        for (id, turn) in legacy {
            self.append_once(&event(&id, turn.as_deref(), "done", json!({
                "status": "interrupted", "text": "CodaClauda closed during this reply; the agent may have finished part of the work."
            })))?;
        }
        let unsettled: Vec<_> = lock(&self.state)
            .ledger
            .values()
            .filter(|turn| turn.terminal() && !turn.history_saved)
            .map(|turn| turn.turn_id.clone())
            .collect();
        for turn in unsettled {
            self.write_settlement(&turn, false)?;
        }
        Ok(())
    }

    /// Retry-safe history repair after a crash between the atomic registry
    /// transition and display-log append. Lifecycle serializes all callers.
    fn append_once(&self, ev: &Value) -> Result<(), String> {
        let id = ev["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or("Invalid session event identity.")?;
        let existing = match fs::read(self.log_path(id)) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => {
                let message = format!("Could not reconcile session history: {e}");
                self.storage_error(&message);
                return Err(message);
            }
        };
        if existing
            .split(|b| *b == b'\n')
            .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
            .any(|old| {
                old["turnId"] == ev["turnId"]
                    && old["kind"] == ev["kind"]
                    && old["terminal"] == ev["terminal"]
            })
        {
            return Ok(());
        }
        self.append(ev)
    }

    /// The ledger is the durable outcome. Once display events are saved, keep
    /// only its identity/digest/origin/status, not another copy of the prompt.
    fn write_settlement(&self, turn_id: &str, emit: bool) -> Result<(), String> {
        let Some(turn) = lock(&self.state).ledger.get(turn_id).cloned() else {
            return Ok(());
        };
        if !turn.terminal() {
            return Ok(());
        }
        if let Some(item) = &turn.payload {
            self.append_once(&item.user_event(&turn.session_id))?;
        }
        let error = turn.error.as_ref().map(|message| {
            event(
                &turn.session_id,
                Some(turn_id),
                "error",
                json!({"error": message, "terminal": true}),
            )
        });
        if let Some(ev) = &error {
            self.append_once(ev)?;
        }
        let done = event(
            &turn.session_id,
            Some(turn_id),
            "done",
            json!({"status": turn.status, "error": turn.error}),
        );
        self.append_once(&done)?;
        if emit {
            if let Some(ev) = error {
                self.publish(ev, false);
            }
            self.publish(done, false);
        }
        let mut state = lock(&self.state);
        if let Some(current) = state.ledger.get_mut(turn_id) {
            current.history_saved = true;
            current.payload = None;
        }
        self.save(&state)
    }

    fn turn_outcome(&self, turn_id: &str) -> Option<Value> {
        lock(&self.state)
            .ledger
            .get(turn_id)
            .map(DurableTurn::outcome)
    }

    /// Caller holds lifecycle and state; automation validators may lock only
    /// their own configuration books, never reacquire these locks.
    fn validate_origin(&self, record: &Record, origin: &Value) -> Result<(), Failure> {
        if owner_equivalent_origin(origin) {
            return Ok(());
        }
        match origin["kind"].as_str() {
            Some("wake") => self.validate_wake_origin(record, origin),
            Some("schedule") => self.validate_schedule_origin(record, origin),
            _ => Err(("INVALID_ARGUMENTS", "Unknown turn origin.".into())),
        }
    }

    fn validate_turn_origin(&self, state: &State, id: &str, turn_id: &str) -> Result<(), String> {
        let record = state
            .records
            .iter()
            .find(|r| r.id == id)
            .ok_or("The session no longer exists.")?;
        let turn = state
            .turns
            .get(id)
            .filter(|t| t.id == turn_id)
            .ok_or("The turn no longer exists.")?;
        self.validate_origin(record, &turn.origin)
            .map_err(|(_, message)| message)
    }

    fn storage_error(&self, message: &str) {
        *lock(&self.storage_failure) = Some(message.to_owned());
        let _ = self
            .app
            .emit(EVENT, event("", None, "error", json!({"error": message})));
    }

    fn save(&self, state: &State) -> Result<(), String> {
        let result = save_snapshot(&self.dir, &state.records, &state.ledger);
        if let Err(message) = &result {
            self.storage_error(message);
        }
        result
    }

    fn append(&self, ev: &Value) -> Result<(), String> {
        let Some(id) = ev["id"].as_str().filter(|id| valid_id(id)) else {
            return Err("Invalid session event identity.".into());
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
            let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
            file.write_all(&line)?;
            file.sync_data()
        })();
        let result = result.map_err(|e| format!("Could not save the session history: {e}"));
        if let Err(message) = &result {
            self.storage_error(message);
        }
        result
    }

    /// Emits to the webview; deltas and status changes are not persisted.
    fn publish(&self, ev: Value, persist: bool) {
        if persist {
            if let Err(message) = self.append(&ev) {
                if let Some(id) = ev["id"].as_str() {
                    if let Some(proc) = lock(&self.state).live.get(id).map(|l| l.proc.clone()) {
                        *lock(&proc.failure) = Some(message.clone());
                        proc.kill();
                    }
                }
                let _ = self.app.emit(
                    EVENT,
                    event(
                        ev["id"].as_str().unwrap_or(""),
                        ev["turnId"].as_str(),
                        "error",
                        json!({"error": message}),
                    ),
                );
            }
        }
        let _ = self.app.emit(EVENT, ev);
    }

    fn with_record<T>(
        &self,
        id: &str,
        change: impl FnOnce(&mut Record) -> T,
    ) -> Result<Option<T>, String> {
        let mut state = lock(&self.state);
        let Some(index) = state.records.iter().position(|r| r.id == id) else {
            return Ok(None);
        };
        let previous = state.records[index].clone();
        let result = change(&mut state.records[index]);
        if let Err(error) = self.save(&state) {
            state.records[index] = previous;
            return Err(error);
        }
        Ok(Some(result))
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

    async fn wait_stopped(&self, id: &str, turn_id: &str) {
        loop {
            if !self.turn_active(id, turn_id) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
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
            if let Some(durable) = state.ledger.get_mut(&turn.id) {
                durable.settle(
                    status,
                    if status == "interrupted" {
                        None
                    } else {
                        failure.as_deref()
                    },
                );
            }
            let _ = self.save(&state);
            (turn, status.to_owned(), shown)
        };
        let failure = failure.filter(|_| status != "interrupted");
        let _ = self.write_settlement(&turn.id, true);
        self.publish(event(id, None, "status", json!({"status": shown})), false);
        if turn.origin["kind"] == "schedule" {
            self.schedule_finished(&turn.origin, &turn.id, &status, failure.as_deref());
        }
        self.notify_turn(id, &status);
        // Each 'done' releases the next queued turn, in order.
        self.queue_next(id);
        true
    }

    /// A transport failure is ambiguous once a child exists. Keep its turn and
    /// updater lease until the stdout supervisor confirms process termination.
    fn fail_turn(&self, id: &str, turn_id: &str, message: String) {
        let _lifecycle = lock(&self.lifecycle);
        let proc = {
            let state = lock(&self.state);
            if !state.turns.get(id).is_some_and(|t| t.id == turn_id) {
                return;
            }
            state.live.get(id).map(|live| live.proc.clone())
        };
        if let Some(proc) = proc {
            *lock(&proc.failure) = Some(message);
            proc.kill();
        } else {
            self.finish_turn(id, Some(turn_id), "failed", Some(message), "error");
        }
    }

    // --------------------------------------------------------- provider output

    fn handle(&self, id: &str, proc: &Arc<Proc>, out: Out, envelope: &Value) {
        let _lifecycle = lock(&self.lifecycle);
        if !lock(&self.state)
            .live
            .get(id)
            .is_some_and(|live| live.proc.generation == proc.generation)
        {
            return;
        }
        if proc.expected_exit.load(Ordering::SeqCst) {
            return;
        }
        // Rate limits are account-wide, so they carry no thread or turn.
        if proc.provider == Provider::Codex
            && !matches!(
                &out,
                Out::Response { .. } | Out::ServerRequest { .. } | Out::RateLimits(_)
            )
        {
            let mut state = lock(&self.state);
            let thread = envelope["params"]["threadId"].as_str();
            if thread.is_none()
                || !state
                    .records
                    .iter()
                    .any(|record| record.id == id && record.thread_id.as_deref() == thread)
            {
                return;
            }
            let provider_turn = envelope["params"]["turnId"]
                .as_str()
                .or_else(|| envelope["params"]["turn"]["id"].as_str());
            let Some(turn) = state.turns.get_mut(id) else {
                return;
            };
            if !turn.dispatched {
                return;
            }
            if !accept_codex_turn(turn, &lock(&proc.completed_turns), provider_turn) {
                return;
            }
        }
        match out {
            Out::Response { id: call, result } => {
                if let Some(sender) = lock(&proc.pending).remove(&call) {
                    let _ = sender.send(result);
                }
            }
            Out::ServerRequest { id: call, method } => {
                let _ = proc.write(
                    json!({"id": call, "error": {"code": -32601, "message": format!("CodaClauda does not answer {method}.")}})
                        .to_string(),
                );
                let turn = self.current_turn(id).map(|t| t.0);
                self.publish(
                    event(
                        id,
                        turn.as_deref(),
                        "error",
                        json!({"error": format!("Codex asked for {method}; CodaClauda declined it.")}),
                    ),
                    true,
                );
            }
            Out::ControlRequest(request) => {
                let _ = proc.write(
                    json!({"type": "control_response", "response": {"subtype": "error", "request_id": request, "error": "CodaClauda does not answer permission prompts."}})
                        .to_string(),
                );
            }
            Out::ProviderSession(session) => {
                let mut state = lock(&self.state);
                // A fork that reports its source session would interleave two chats.
                if state.records.iter().any(|r| {
                    r.id == id
                        && r.provider_session_id.is_none()
                        && r.fork_from.as_deref() == Some(session.as_str())
                }) {
                    *lock(&proc.failure) = Some(
                        "Claude resumed the original conversation instead of forking it; it was stopped before replying.".into(),
                    );
                    proc.kill();
                    return;
                }
                let changed = match state.records.iter_mut().find(|r| r.id == id) {
                    Some(r) if r.provider_session_id.as_deref() != Some(session.as_str()) => {
                        r.provider_session_id = Some(session);
                        true
                    }
                    _ => false,
                };
                if changed {
                    if let Err(message) = self.save(&state) {
                        *lock(&proc.failure) = Some(message);
                        proc.kill();
                    }
                }
            }
            Out::TurnStarted(provider_turn) => {
                if let Some(turn) = lock(&self.state).turns.get_mut(id) {
                    turn.provider_turn.get_or_insert(provider_turn);
                }
            }
            Out::Delta(text) => {
                if let Some((turn, _)) = self.current_turn(id) {
                    self.publish(
                        event(id, Some(&turn), "delta", json!({"text": text})),
                        false,
                    );
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
                if lock(&proc.failure).is_some() {
                    return; // a timed-out/failed transport must quiesce first
                }
                self.complete_provider_turn(id, proc, status);
            }
            Out::Context(tokens) => proc.context.store(tokens, Ordering::SeqCst),
            Out::Usage(reported) => self.record_usage(id, proc, reported),
            Out::RateLimits(limits) => self.record_rate_limits(id, &limits),
            Out::Compacted => {
                let compacting = lock(&self.state)
                    .turns
                    .get(id)
                    .is_some_and(|t| t.origin["kind"] == "compact");
                if compacting && lock(&proc.failure).is_none() {
                    self.complete_provider_turn(id, proc, "completed".into());
                }
            }
        }
    }

    /// Folds one cumulative report into the record and tells the webview.
    fn record_usage(&self, id: &str, proc: &Arc<Proc>, reported: Reported) {
        let tokens = reported.context_tokens.or_else(|| {
            let seen = proc.context.load(Ordering::SeqCst);
            (seen > 0).then_some(seen)
        });
        let pct = session_parse::context_pct(tokens, reported.context_window);
        let (usage, turn) = {
            let mut state = lock(&self.state);
            let turn = state.turns.get(id).map(|t| t.id.clone());
            let Some(record) = state.records.iter_mut().find(|r| r.id == id) else {
                return;
            };
            let mut base = lock(&proc.usage_base);
            let (saved, restored) = base.get_or_insert((record.usage, None));
            record.usage = session_parse::merge_usage(saved, restored, &reported, pct);
            let usage = record.usage;
            drop(base);
            let _ = self.save(&state);
            (usage, turn)
        };
        self.publish(
            event(id, turn.as_deref(), "usage", json!({"usage": usage})),
            false,
        );
    }

    /// Keeps only the plan windows (used percent, window length, reset time).
    fn record_rate_limits(&self, id: &str, limits: &Value) {
        let window = |w: &Value| {
            w.is_object().then(|| {
                json!({"usedPercent": w["usedPercent"], "windowDurationMins": w["windowDurationMins"], "resetsAt": w["resetsAt"]})
            })
        };
        let kept = json!({
            "primary": window(&limits["primary"]),
            "secondary": window(&limits["secondary"]),
            "planType": limits["planType"],
            "at": now_ms(),
        });
        let usage = {
            let mut state = lock(&self.state);
            let Some(record) = state.records.iter_mut().find(|r| r.id == id) else {
                return;
            };
            record.rate_limits = Some(kept.clone());
            let usage = record.usage;
            let _ = self.save(&state);
            usage
        };
        self.publish(
            event(id, None, "usage", json!({"usage": usage, "rateLimits": kept})),
            false,
        );
    }

    /// A terminal notification does not authorize process reuse while its
    /// turn/start RPC is still ambiguous. Its eventual timeout must retire the
    /// same turn, never a later request on this process.
    fn complete_provider_turn(&self, id: &str, proc: &Arc<Proc>, status: String) {
        let (provider_turn, status) = {
            let mut state = lock(&self.state);
            let Some(turn) = state.turns.get_mut(id) else {
                return;
            };
            let Some(status) = turn.complete(status) else {
                return;
            };
            (turn.provider_turn.clone(), status)
        };
        if let Some(provider_turn) = provider_turn {
            let mut completed = lock(&proc.completed_turns);
            completed.insert(provider_turn);
            if completed.len() >= 4096 {
                proc.kill();
            }
        }
        lock(&proc.runtime_lease).take();
        self.finish_turn(id, None, &status, None, "idle");
    }

    fn read_stdout(self: Arc<Self>, id: String, proc: Arc<Proc>, stdout: File) {
        let reader = BufReader::with_capacity(1 << 16, stdout);
        for line in reader.split(b'\n') {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            if proc.provider == Provider::Claude
                && value["type"] == "system"
                && value["subtype"] == "init"
            {
                let policy = lock(&self.state)
                    .records
                    .iter()
                    .find(|r| r.id == id)
                    .map(|r| r.access.clone());
                if let Some(access) = policy {
                    let mcp: Vec<String> =
                        lock(&proc.mcp).iter().map(|(name, _)| name.clone()).collect();
                    if let Err(message) = session_policy::verify_claude_init(&value, &access, &mcp)
                    {
                        *lock(&proc.failure) = Some(message);
                        proc.kill();
                        continue;
                    }
                }
            }
            let outputs = match proc.provider {
                Provider::Claude => session_parse::parse_claude(&value),
                Provider::Codex => session_parse::parse_codex(&value),
            };
            for out in outputs {
                self.handle(&id, &proc, out, &value);
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
        if code.is_none() {
            for _ in 0..50 {
                if let Ok(Some(exit)) = lock(&proc.child).try_wait() {
                    code = Some(exit);
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        }
        lock(&proc.pending).clear();
        lock(&proc.input).take();
        let _lifecycle = lock(&self.lifecycle);
        if code.is_none() {
            // Retain the process entry and runtime lease if termination could
            // not be confirmed: neither sends nor the updater may race it.
            self.publish(event(id, None, "error", json!({
                "error": "The agent process has not confirmed it stopped. Close CodaClauda before updating or retrying."
            })), false);
            return;
        }
        lock(&proc.runtime_lease).take();
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
        // A turn queued behind this closing process can start once it is gone
        // (deferred: it runs after this supervisor releases `lifecycle`).
        self.queue_next(id);
        if let Some(message) = lock(&proc.failure).take() {
            self.finish_turn(id, None, "failed", Some(message), "error");
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

    /// Reserve admission under the same lock that counts live and pending
    /// processes. Discovery and process creation cannot overbook this slot.
    fn reserve_launch(
        self: &Arc<Self>,
        id: &str,
        turn_id: &str,
    ) -> Result<LaunchReservation, String> {
        let _lifecycle = lock(&self.lifecycle);
        let victim = {
            let mut state = lock(&self.state);
            self.validate_turn_origin(&state, id, turn_id)?;
            state.reserve_launch(id, turn_id)?
        };
        if let Some((old_id, live)) = victim {
            if !retire(&live.proc) {
                let mut state = lock(&self.state);
                state.live.insert(old_id, live);
                state.release_launch(id, turn_id);
                return Err(
                    "An idle agent has not confirmed it stopped. Close CodaClauda before retrying."
                        .into(),
                );
            }
        }
        Ok(LaunchReservation {
            inner: self.clone(),
            id: id.into(),
            turn_id: turn_id.into(),
        })
    }

    async fn launch(
        self: &Arc<Self>,
        record: &Record,
        provider: Provider,
        turn_id: &str,
        lease: Arc<File>,
    ) -> Result<Arc<Proc>, String> {
        require_browser_disabled(record.playwright)?;
        let reservation = Arc::new(self.reserve_launch(&record.id, turn_id)?);
        let exe = self.executable(provider).await?;
        if !lock(&self.state).accepts_launch(&record.id, turn_id) {
            return Err("This turn was stopped before the agent could start.".into());
        }
        let cwd = PathBuf::from(&record.cwd);
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(format!(
                "The project folder {} is not available.",
                record.cwd
            ));
        }
        // The owner's own MCP servers (0.5): Full access only, read at each launch.
        let servers = if record.access == "full" {
            self.project_mcp(&record.project_id)
        } else {
            Vec::new()
        };
        let args = match provider {
            Provider::Claude => {
                self.claude_preflight(record, &exe, lease.clone(), reservation.clone())
                    .await?;
                let config = mcp::write_claude_config(&self.dir, &record.id, &servers)?;
                claude_args(record, &uuid_v4(), config.as_deref())
            }
            Provider::Codex => {
                let (mut overrides, inherited) = self
                    .codex_preflight(record, &exe, lease.clone(), reservation.clone())
                    .await?;
                overrides.extend(mcp::codex_overrides(&servers, &inherited)?);
                codex_args(&overrides)
            }
        };
        let extra_env = mcp::provider_env(&servers);
        let (proc, stdout) = {
            let _lifecycle = lock(&self.lifecycle);
            let mut state = lock(&self.state);
            if !state.accepts_launch(&record.id, turn_id) {
                return Err("This turn was stopped while the agent was starting.".into());
            }
            self.validate_turn_origin(&state, &record.id, turn_id)?;
            // Admission and spawn share the close/stop gate.
            let (proc, stdout) = spawn_owned(
                &exe,
                &args,
                &cwd,
                provider,
                self.generation.fetch_add(1, Ordering::SeqCst) + 1,
                lease,
                &extra_env,
            )?;
            // Set before its output is read: startup checks accept only these.
            *lock(&proc.mcp) = mcp::owned_list(&servers);
            state.release_launch(&record.id, turn_id);
            state.live.insert(
                record.id.clone(),
                Live {
                    proc: proc.clone(),
                    last_used: Instant::now(),
                },
            );
            (proc, stdout)
        };
        {
            let inner = self.clone();
            let reader = proc.clone();
            let id = record.id.clone();
            thread::spawn(move || inner.read_stdout(id, reader, stdout));
        }
        if provider == Provider::Codex {
            if let Err(message) = self.codex_handshake(record, &proc, turn_id).await {
                *lock(&proc.failure) = Some(message.clone());
                proc.kill();
                return Err(message);
            }
        }
        Ok(proc)
    }

    async fn claude_preflight(
        &self,
        record: &Record,
        exe: &Path,
        lease: Arc<File>,
        reservation: Arc<LaunchReservation>,
    ) -> Result<(), String> {
        crate::session_policy_sources::ensure_claude_system_unmanaged()?;
        let configured = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty());
        let config_dirs = if let Some(configured) = configured {
            vec![PathBuf::from(configured)]
        } else {
            ["USERPROFILE", "HOME"]
                .iter()
                .filter_map(|name| std::env::var_os(name).filter(|v| !v.is_empty()))
                .map(|home| PathBuf::from(home).join(".claude"))
                .collect::<Vec<_>>()
        };
        if config_dirs.is_empty() {
            return Err(
                "Claude's configuration directory could not be checked before sign-in inspection."
                    .into(),
            );
        }
        for config_dir in config_dirs {
            crate::session_policy_sources::ensure_claude_unmanaged(&config_dir)?;
        }
        let (proc, mut stdout) = {
            let _lifecycle = lock(&self.lifecycle);
            if !lock(&self.state).accepts_launch(&record.id, &reservation.turn_id) {
                return Err("This turn was stopped before Claude sign-in inspection.".into());
            }
            spawn_owned(
                exe,
                &session_policy::claude_auth_args(&record.access),
                Path::new(&record.cwd),
                Provider::Claude,
                self.generation.fetch_add(1, Ordering::SeqCst) + 1,
                lease,
                &[],
            )?
        };
        lock(&proc.input).take();
        let (sender, receiver) = oneshot::channel();
        let turn_id = reservation.turn_id.clone();
        {
            let reader = proc.clone();
            thread::spawn(move || {
                let _reservation = reservation;
                let mut bytes = Vec::new();
                let result = Read::by_ref(&mut stdout)
                    .take(1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "Could not read Claude sign-in status.".to_owned())
                    .and_then(|_| {
                        if bytes.len() > 1024 * 1024 {
                            Err("Claude sign-in status exceeded its output limit.".to_owned())
                        } else {
                            serde_json::from_slice::<Value>(&bytes).map_err(|_| {
                                "Claude returned an unreadable sign-in status.".to_owned()
                            })
                        }
                    });
                let _ = sender.send(result);
                while !retire(&reader) {
                    thread::sleep(Duration::from_secs(1));
                }
            });
        }
        let result = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(20), receiver) => match result {
                Ok(Ok(result)) => result,
                _ => Err("Claude did not return its sign-in status in time.".into()),
            },
            _ = self.wait_stopped(&record.id, &turn_id) =>
                Err("This turn stopped during Claude sign-in inspection.".into()),
        };
        let retiring = proc.clone();
        let stopped = tauri::async_runtime::spawn_blocking(move || retire(&retiring))
            .await
            .map_err(|_| {
                "Claude sign-in inspection could not confirm process termination.".to_owned()
            })?;
        if !stopped {
            return Err("Claude sign-in inspection has not confirmed it stopped. Close CodaClauda before retrying.".into());
        }
        let auth = result?;
        session_policy::verify_claude_auth(&auth)?;
        let config_dir = auth["configDirectory"].as_str().ok_or(
            "Claude did not identify its configuration directory; session launch was refused.",
        )?;
        crate::session_policy_sources::ensure_claude_unmanaged(Path::new(config_dir))
    }

    /// Resolve inherited server names without creating or resuming a provider
    /// thread. This child owns the same admission slot and update lease.
    async fn codex_preflight(
        &self,
        record: &Record,
        exe: &Path,
        lease: Arc<File>,
        reservation: Arc<LaunchReservation>,
    ) -> Result<(Vec<String>, Vec<String>), String> {
        let (proc, stdout) = {
            let _lifecycle = lock(&self.lifecycle);
            if !lock(&self.state).accepts_launch(&record.id, &reservation.turn_id) {
                return Err("This turn was stopped before Codex policy inspection.".into());
            }
            spawn_owned(
                exe,
                &codex_args(&[]),
                Path::new(&record.cwd),
                Provider::Codex,
                self.generation.fetch_add(1, Ordering::SeqCst) + 1,
                lease,
                &[],
            )?
        };
        let turn_id = reservation.turn_id.clone();
        {
            let reader = proc.clone();
            thread::spawn(move || {
                // Keep admission and the board host alive even if an ambiguous
                // termination makes the requesting async task return early.
                let _reservation = reservation;
                for line in BufReader::new(stdout).split(b'\n') {
                    let Ok(line) = line else { break };
                    let Ok(value) = serde_json::from_slice::<Value>(&line) else {
                        continue;
                    };
                    for out in session_parse::parse_codex(&value) {
                        if let Out::Response { id, result } = out {
                            if let Some(sender) = lock(&reader.pending).remove(&id) {
                                let _ = sender.send(result);
                            }
                        }
                    }
                }
                while !retire(&reader) {
                    thread::sleep(Duration::from_secs(1));
                }
            });
        }
        let operation = async {
            initialize_codex(&proc).await?;
            let config = rpc(
                &proc,
                "config/read",
                json!({"includeLayers": false, "cwd": record.cwd}),
            )
            .await?;
            session_policy::codex_preflight_overrides(&config)
                .map(|overrides| (overrides, session_policy::codex_mcp_names(&config)))
        };
        let result = tokio::select! {
            result = operation => result,
            _ = self.wait_stopped(&record.id, &turn_id) =>
                Err("This turn stopped during Codex policy inspection.".into()),
        };
        let retiring = proc.clone();
        let stopped = tauri::async_runtime::spawn_blocking(move || retire(&retiring))
            .await
            .map_err(|_| {
                "Codex policy inspection could not confirm process termination.".to_owned()
            })?;
        if !stopped {
            return Err("Codex policy inspection has not confirmed it stopped. Close CodaClauda before retrying.".into());
        }
        result
    }

    async fn codex_handshake(
        &self,
        record: &Record,
        proc: &Arc<Proc>,
        turn_id: &str,
    ) -> Result<(), String> {
        initialize_codex(proc).await?;
        let config = self
            .turn_rpc(
                &record.id,
                turn_id,
                proc,
                "config/read",
                json!({"includeLayers": false, "cwd": record.cwd}),
            )
            .await?;
        let owned = lock(&proc.mcp).clone();
        session_policy::verify_codex_config(&config, &owned)?;
        let account = self
            .turn_rpc(
                &record.id,
                turn_id,
                proc,
                "account/read",
                json!({"refreshToken": false}),
            )
            .await?;
        session_policy::verify_codex_account(&account)?;
        let mut base = json!({"cwd": record.cwd, "sandbox": sandbox_mode(&record.access), "approvalPolicy": "never"});
        if let Some(model) = &record.model {
            base["model"] = json!(model);
        }
        let (known, fork) = lock(&self.state)
            .records
            .iter()
            .find(|r| r.id == record.id)
            .map(|r| (r.thread_id.clone(), r.fork_from.clone()))
            .unwrap_or_default();
        let result = match known {
            // A fork's first launch copies its source thread (0.5).
            None if fork.is_some() => {
                let source = fork.clone().unwrap_or_default();
                let mut params = base.clone();
                params["threadId"] = json!(source);
                params["excludeTurns"] = json!(true);
                match self
                    .turn_rpc(&record.id, turn_id, proc, "thread/fork", params)
                    .await
                {
                    Ok(result) if result["thread"]["id"].as_str() != Some(source.as_str()) => {
                        result
                    }
                    outcome => {
                        let problem = outcome.err().unwrap_or_else(|| {
                            "it returned the original thread".to_owned()
                        });
                        self.publish(
                            event(
                                &record.id,
                                Some(turn_id),
                                "error",
                                json!({"error": format!("Codex could not fork the earlier thread ({problem}). Starting a new thread; earlier context is not available to it.")}),
                            ),
                            true,
                        );
                        base["serviceName"] = json!("codaclauda");
                        self.turn_rpc(&record.id, turn_id, proc, "thread/start", base)
                            .await?
                    }
                }
            }
            Some(thread) => {
                let mut params = base.clone();
                params["threadId"] = json!(thread);
                params["excludeTurns"] = json!(true);
                match self
                    .turn_rpc(&record.id, turn_id, proc, "thread/resume", params)
                    .await
                {
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
                        base["serviceName"] = json!("codaclauda");
                        self.turn_rpc(&record.id, turn_id, proc, "thread/start", base)
                            .await?
                    }
                }
            }
            None => {
                base["serviceName"] = json!("codaclauda");
                self.turn_rpc(&record.id, turn_id, proc, "thread/start", base)
                    .await?
            }
        };
        let thread = result["thread"]["id"]
            .as_str()
            .ok_or("Codex did not return a thread id.")?
            .to_owned();
        let session = result["thread"]["sessionId"]
            .as_str()
            .unwrap_or(&thread)
            .to_owned();
        let _lifecycle = lock(&self.lifecycle);
        if !lock(&self.state)
            .live
            .get(&record.id)
            .is_some_and(|live| live.proc.generation == proc.generation)
            || !self.turn_active(&record.id, turn_id)
        {
            return Err("This turn was stopped while Codex was connecting.".into());
        }
        self.with_record(&record.id, |r| {
            r.thread_id = Some(thread);
            r.provider_session_id = Some(session);
        })?;
        Ok(())
    }

    async fn turn_rpc(
        &self,
        id: &str,
        turn_id: &str,
        proc: &Arc<Proc>,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let (call, receiver) = {
            let _lifecycle = lock(&self.lifecycle);
            self.check_dispatch(id, turn_id, proc)?;
            // A compaction runs as a provider turn whose id arrives only in
            // its notifications, so there is no start reply to wait for.
            if method == "turn/start" || method == "thread/compact/start" {
                if let Some(turn) = lock(&self.state).turns.get_mut(id) {
                    turn.dispatched = true;
                    turn.start_pending = method == "turn/start";
                }
            }
            begin_rpc(proc, method, params)?
        };
        await_rpc(proc, method, call, receiver).await
    }

    /// Caller holds lifecycle so a close/stop cannot cross input admission.
    fn check_dispatch(&self, id: &str, turn_id: &str, proc: &Arc<Proc>) -> Result<(), String> {
        let state = lock(&self.state);
        if !state
            .turns
            .get(id)
            .is_some_and(|turn| turn.id == turn_id && !turn.stopping)
            || !state
                .live
                .get(id)
                .is_some_and(|live| live.proc.generation == proc.generation)
            || proc.expected_exit.load(Ordering::SeqCst)
            || lock(&proc.failure).is_some()
        {
            return Err("This turn stopped before the agent could receive it.".into());
        }
        let record = state
            .records
            .iter()
            .find(|r| r.id == id)
            .ok_or("The session no longer exists.")?;
        let turn = state.turns.get(id).ok_or("The turn no longer exists.")?;
        self.validate_origin(record, &turn.origin)
            .map_err(|(_, message)| message)?;
        Ok(())
    }

    // ------------------------------------------------------------- commands

    fn list(&self) -> Value {
        let state = lock(&self.state);
        let sessions: Vec<Value> = state
            .records
            .iter()
            .map(|record| {
                let mut value =
                    serde_json::to_value(record).expect("A record contains only JSON values");
                value["queued"] = json!(state.queues.get(&record.id).map_or(0, VecDeque::len));
                // Team view: awake = an owned process (or one starting), asleep = none.
                value["live"] = json!(
                    state.live.contains_key(&record.id) || state.launching.contains_key(&record.id)
                );
                value
            })
            .collect();
        json!({"sessions": sessions})
    }

    async fn start(&self, args: Value) -> Result<Value, Failure> {
        let invalid = |m: &str| ("INVALID_ARGUMENTS", m.to_owned());
        require_browser_disabled(args["playwright"].as_bool().unwrap_or(false))
            .map_err(|message| ("BROWSER_UNAVAILABLE", message))?;
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
                .map(|s| {
                    s.trim()
                        .chars()
                        .filter(|c| !c.is_control())
                        .take(limit)
                        .collect::<String>()
                })
                .filter(|s| !s.is_empty())
        };
        let word = |value: &Value| -> Result<Option<String>, Failure> {
            match value.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                None => Ok(None),
                Some(s)
                    if s.len() <= 80
                        && s.chars()
                            .all(|c| c.is_ascii_alphanumeric() || "-._[]:/".contains(c)) =>
                {
                    Ok(Some(s.to_owned()))
                }
                Some(_) => Err(invalid("model and effort must be short names.")),
            }
        };
        let model = word(&args["model"])?;
        let effort = word(&args["effort"])?;
        let shared_id = short(&args["sharedId"], 128);
        let _lease =
            runtime_lease(&self.board).map_err(|message| ("SESSION_UNAVAILABLE", message))?;
        self.executable(provider)
            .await
            .map_err(|message| ("AGENT_UNAVAILABLE", message))?;
        if let Some(message) = lock(&self.storage_failure).clone() {
            return Err(("STORAGE_FAILED", message));
        }
        let now = now_ms();
        let id = format!("s_{}", random_hex(8));
        // 0.5: an optional git worktree of its own on branch codaclauda/<short>.
        let tree = if args["worktree"].as_bool() == Some(true) {
            Some(worktree::create(&self.dir, &id, folder).await?)
        } else {
            None
        };
        let session_cwd = tree.as_ref().map_or_else(|| cwd.to_owned(), |t| t.cwd.clone());
        let title =
            short(&args["title"], 200).unwrap_or_else(|| format!("{} chat", provider.label()));
        // 0.5: wake on by default, with its own board address.
        let (wake, mailbox_address) = self.default_wake(provider.name(), &session_cwd, &title).await;
        let record = Record {
            provider: provider.name().into(),
            project_id: short(&args["projectId"], 512).unwrap_or_else(|| cwd.to_owned()),
            cwd: session_cwd,
            title,
            wake,
            mailbox_address,
            // Set only by team.rs; the owner's session_start command strips it.
            started_by: args.get("startedBy").filter(|v| v.is_object()).cloned(),
            team_note: true,
            access: access.into(),
            status: "idle".into(),
            created_at: now,
            last_activity_at: now,
            shared: shared_id.is_some(),
            shared_id,
            model,
            effort,
            worktree_path: tree.as_ref().map(|t| t.root.clone()),
            branch: tree.as_ref().map(|t| t.branch.clone()),
            repo_root: tree.as_ref().map(|t| t.repo_root.clone()),
            base_branch: tree.as_ref().and_then(|t| t.base_branch.clone()),
            base_commit: tree.as_ref().map(|t| t.base_commit.clone()),
            id,
            ..Record::default()
        };
        let saved = {
            let mut state = lock(&self.state);
            state.records.push(record.clone());
            let saved = self.save(&state);
            if saved.is_err() {
                state.records.pop();
            }
            saved
        };
        if let Err(message) = saved {
            if let Some(tree) = &tree {
                worktree::remove(tree).await;
            }
            return Err(("STORAGE_FAILED", message));
        }
        Ok(json!({"session": record}))
    }

    /// Owner sends, wakes and scheduled runs all come through here. A busy
    /// session queues the turn (at most QUEUE_MAX waiting) instead of refusing.
    /// Admission keeps 0.4.0's send rules: it holds `lifecycle`, refuses after a
    /// storage failure, and saves the record and user event before any provider
    /// work (see `take_next`).
    fn submit(self: &Arc<Self>, id: &str, item: Queued) -> Result<Value, Failure> {
        let _lifecycle = lock(&self.lifecycle);
        if !valid_turn_id(&item.turn_id)
            || item
                .key
                .as_ref()
                .is_some_and(|key| key.len() > 4096 || keyed_turn_id(key) != item.turn_id)
        {
            return Err(("INVALID_ARGUMENTS", "Invalid turn identity.".into()));
        }
        // Reconcile prior durable acceptance before checking changed settings.
        // No provider action or budget consumption occurs on this path.
        if let Some(previous) = lock(&self.state).duplicate(id, &item)? {
            return Ok(previous);
        }
        if let Some(message) = lock(&self.storage_failure).clone() {
            return Err(("STORAGE_FAILED", message));
        }
        if item.text.trim().is_empty() && item.attachments.is_empty() {
            return Err(("INVALID_ARGUMENTS", "Type a message first.".into()));
        }
        if item.text.len() > TEXT_LIMIT
            || item.attachments.len() > 20
            || serde_json::to_vec(&item.origin).map_or(true, |b| b.len() > TEXT_LIMIT)
        {
            return Err((
                "INPUT_TOO_LARGE",
                "The message or its attachment list is too large.".into(),
            ));
        }
        if item
            .attachments
            .iter()
            .any(|a| !Path::new(&a.path).is_absolute())
        {
            return Err((
                "INVALID_ARGUMENTS",
                "Attachments need absolute paths.".into(),
            ));
        }
        let turn_id = item.turn_id.clone();
        let user = item.user_event(id);
        let before = {
            let mut state = lock(&self.state);
            let Some(record) = state.records.iter().find(|r| r.id == id) else {
                return Err(("SESSION_NOT_FOUND", "That chat no longer exists.".into()));
            };
            require_browser_disabled(record.playwright)
                .map_err(|message| ("BROWSER_UNAVAILABLE", message))?;
            let before = state.queues.get(id).map_or(0, VecDeque::len);
            if item.origin["kind"] == "schedule"
                && item.origin["trigger"] != "manual"
                && (state.session_busy(id) || before > 0)
            {
                return Err((
                    "SESSION_BUSY",
                    "Skipped: the session was still working on an earlier turn.".into(),
                ));
            }
            if before >= QUEUE_MAX {
                return Err((
                    "QUEUE_FULL",
                    format!(
                        "{QUEUE_MAX} messages are already waiting for this agent. Let it catch up or close it, then send again."
                    ),
                ));
            }
            self.validate_origin(record, &item.origin)?;
            state
                .accept_queued(id, item.clone(), |state| self.save(state))
                .map_err(|message| ("STORAGE_FAILED", message))?;
            before
        };
        if let Err(message) = self.append_once(&user) {
            {
                let mut state = lock(&self.state);
                if let Some(queue) = state.queues.get_mut(id) {
                    queue.retain(|turn| turn.turn_id != turn_id);
                }
                self.waiting(&mut state, id);
            }
            self.settle_unstarted(id, &item, "failed", Some(&message));
            return Err(("STORAGE_FAILED", message));
        }
        self.publish(user, false);
        let (outcome, waiting) = self.admit_queued(id, Some(turn_id.as_str()));
        if waiting != before {
            self.publish_queued(id, waiting);
        }
        outcome?;
        Ok(json!({"accepted": true, "turnId": turn_id, "queued": waiting, "duplicate": false}))
    }

    /// Turns still waiting for this session (and forgets an empty queue).
    fn waiting(&self, state: &mut State, id: &str) -> usize {
        let count = state.queues.get(id).map_or(0, VecDeque::len);
        if count == 0 {
            state.queues.remove(id);
        }
        count
    }

    fn publish_queued(&self, id: &str, count: usize) {
        self.publish(
            event(
                id,
                None,
                "queued",
                json!({"count": count, "status": format!("queued ({count})")}),
            ),
            false,
        );
    }

    /// Admits the next queued turn when the session is free. Caller holds
    /// `lifecycle` and the state lock. As in 0.4.0's send, the turn holds the
    /// update lease, and its record and user event are saved before any
    /// provider work; a failed save is rolled back and refuses the turn.
    /// None: nothing can start now. Some(Err): the front turn could not be
    /// admitted and has left the queue.
    fn take_next(&self, state: &mut State, id: &str) -> Option<Result<Started, (Queued, Failure)>> {
        if state.session_busy(id) {
            return None;
        }
        let item = state.queues.get_mut(id)?.pop_front()?;
        if let Some(message) = lock(&self.storage_failure).clone() {
            return Some(Err((item, ("STORAGE_FAILED", message))));
        }
        let lease = match runtime_lease(&self.board) {
            Ok(lease) => lease,
            Err(message) => return Some(Err((item, ("SESSION_UNAVAILABLE", message)))),
        };
        let Some(record) = state.records.iter_mut().find(|r| r.id == id) else {
            return Some(Err((
                item,
                ("SESSION_NOT_FOUND", "That chat no longer exists.".into()),
            )));
        };
        if let Err(message) = require_browser_disabled(record.playwright) {
            return Some(Err((item, ("BROWSER_UNAVAILABLE", message))));
        }
        if let Err(failure) = self.validate_origin(record, &item.origin) {
            return Some(Err((item, failure)));
        }
        let previous = record.clone();
        record.status = "running".into();
        record.turn_id = Some(item.turn_id.clone());
        record.last_activity_at = now_ms();
        let record = record.clone();
        let Some(durable) = state.ledger.get_mut(&item.turn_id) else {
            if let Some(current) = state.records.iter_mut().find(|r| r.id == id) {
                *current = previous;
            }
            return Some(Err((
                item,
                (
                    "STORAGE_FAILED",
                    "The queued turn has no durable acceptance record.".into(),
                ),
            )));
        };
        durable.status = "active".into();
        let running = event(
            id,
            Some(&item.turn_id),
            "status",
            json!({"status": "running"}),
        );
        if let Err(message) = self.save(state).and_then(|_| self.append_once(&running)) {
            if let Some(current) = state.records.iter_mut().find(|r| r.id == id) {
                *current = previous;
            }
            if let Some(durable) = state.ledger.get_mut(&item.turn_id) {
                durable.status = "queued".into();
            }
            return Some(Err((item, ("STORAGE_FAILED", message))));
        }
        state.turns.insert(
            id.to_owned(),
            Turn {
                id: item.turn_id.clone(),
                provider_turn: None,
                stopping: false,
                dispatched: false,
                start_pending: false,
                completion: None,
                _lease: lease.clone(),
                origin: item.origin.clone(),
            },
        );
        let proc = state.live.get_mut(id).map(|live| {
            live.last_used = Instant::now();
            *lock(&live.proc.runtime_lease) = Some(lease.clone());
            live.proc.clone()
        });
        Some(Ok(Started {
            record,
            proc,
            item,
            lease,
        }))
    }

    /// Starts queued turns in order while the session is free. Caller holds
    /// `lifecycle`. A turn that cannot be admitted leaves the queue: the
    /// `submitted` one returns its failure, any other is settled as failed.
    /// Returns whether `submitted` started now, and how many turns still wait.
    fn admit_queued(
        self: &Arc<Self>,
        id: &str,
        submitted: Option<&str>,
    ) -> (Result<bool, Failure>, usize) {
        loop {
            let (next, waiting) = {
                let mut state = lock(&self.state);
                let next = self.take_next(&mut state, id);
                (next, self.waiting(&mut state, id))
            };
            match next {
                None => return (Ok(false), waiting),
                Some(Ok(started)) => {
                    let mine = submitted == Some(started.item.turn_id.as_str());
                    self.run_turn(started);
                    return (Ok(mine), waiting);
                }
                Some(Err((item, failure))) => {
                    self.settle_unstarted(id, &item, "failed", Some(failure.1.as_str()));
                    if submitted == Some(item.turn_id.as_str()) {
                        return (Err(failure), waiting);
                    }
                }
            }
        }
    }

    /// Accepted turns always receive a durable terminal outcome, including
    /// rejection after waiting and explicit queue cancellation.
    fn settle_unstarted(&self, _id: &str, item: &Queued, status: &str, failure: Option<&str>) {
        {
            let mut state = lock(&self.state);
            if let Some(turn) = state.ledger.get_mut(&item.turn_id) {
                turn.settle(status, failure);
            }
            let _ = self.save(&state);
        }
        let _ = self.write_settlement(&item.turn_id, true);
        if item.origin["kind"] == "schedule" {
            self.schedule_finished(&item.origin, &item.turn_id, status, failure);
        }
    }

    /// Starts the next queued turn once the session is free: after a 'done',
    /// a released launch reservation or a confirmed process exit. Callers often
    /// hold `lifecycle`, which admission takes itself, so this runs on its own
    /// blocking task.
    fn queue_next(&self, id: &str) {
        let Some(me) = self.me.upgrade() else {
            return;
        };
        let id = id.to_owned();
        tauri::async_runtime::spawn_blocking(move || me.start_next(&id));
    }

    fn start_next(self: &Arc<Self>, id: &str) {
        let _lifecycle = lock(&self.lifecycle);
        let before = lock(&self.state).queues.get(id).map_or(0, VecDeque::len);
        if before == 0 {
            return;
        }
        let (_, waiting) = self.admit_queued(id, None);
        if waiting != before {
            self.publish_queued(id, waiting);
        }
    }

    fn run_turn(self: &Arc<Self>, started: Started) {
        let Started {
            record,
            proc,
            item,
            lease,
        } = started;
        let Queued {
            turn_id,
            text,
            attachments,
            origin,
            ..
        } = item;
        // The accepted user event was already persisted and emitted, including
        // while this turn waited behind an earlier one.
        self.publish(
            event(
                &record.id,
                Some(&turn_id),
                "status",
                json!({"status": "running"}),
            ),
            false,
        );
        let inner = self.clone();
        let compact = origin["kind"] == "compact";
        tauri::async_runtime::spawn(async move {
            if let Err(message) = inner
                .deliver(&record, proc, &turn_id, &text, &attachments, lease, compact)
                .await
            {
                inner.fail_turn(&record.id, &turn_id, message);
            }
        });
    }

    async fn deliver(
        self: &Arc<Self>,
        record: &Record,
        proc: Option<Arc<Proc>>,
        turn_id: &str,
        text: &str,
        attachments: &[Attachment],
        lease: Arc<File>,
        compact: bool,
    ) -> Result<(), String> {
        let provider = Provider::parse(&record.provider).ok_or("Unknown provider.")?;
        let proc = match proc {
            Some(proc) => proc,
            None => self.launch(record, provider, turn_id, lease).await?,
        };
        if !self.turn_active(&record.id, turn_id) {
            return Ok(()); // stopped while the agent was starting
        }
        if compact {
            // Codex compact-now (0.5); the turn ends on its turn/completed
            // or thread/compacted notification.
            if provider != Provider::Codex {
                return Err("Only Codex sessions can compact on request.".into());
            }
            let thread = lock(&self.state)
                .records
                .iter()
                .find(|r| r.id == record.id)
                .and_then(|r| r.thread_id.clone())
                .ok_or("Codex has no thread for this chat.")?;
            self.turn_rpc(
                &record.id,
                turn_id,
                &proc,
                "thread/compact/start",
                json!({"threadId": thread}),
            )
            .await?;
            return Ok(());
        }
        let prompt = with_attachments(text, attachments);
        let note = self.first_turn_note(&record.id);
        let prompt = match &note {
            Some(note) => format!("{note}\n\n{prompt}"),
            None => prompt,
        };
        match provider {
            Provider::Claude => {
                let _lifecycle = lock(&self.lifecycle);
                self.check_dispatch(&record.id, turn_id, &proc)?;
                if let Some(turn) = lock(&self.state).turns.get_mut(&record.id) {
                    turn.dispatched = true;
                }
                proc.write(
                    json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": prompt}]}, "parent_tool_use_id": null})
                        .to_string(),
                )?;
                self.note_delivered(&record.id);
                Ok(())
            }
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
                let result = self
                    .turn_rpc(&record.id, turn_id, &proc, "turn/start", params)
                    .await?;
                self.note_delivered(&record.id);
                let provider_turn = result["turn"]["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or("Codex did not identify its accepted turn.")?;
                let _lifecycle = lock(&self.lifecycle);
                let completion = {
                    let mut state = lock(&self.state);
                    let Some(turn) = state
                        .turns
                        .get_mut(&record.id)
                        .filter(|turn| turn.id == turn_id)
                    else {
                        return Ok(());
                    };
                    turn.acknowledge(&lock(&proc.completed_turns), provider_turn)?
                };
                if let Some(status) = completion {
                    self.complete_provider_turn(&record.id, &proc, status);
                }
                Ok(())
            }
        }
    }

    fn stop(self: &Arc<Self>, id: &str) -> Result<Value, Failure> {
        let _lifecycle = lock(&self.lifecycle);
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
                    // The grace timer owns interruption failure. A separate RPC
                    // timeout must not retire a later turn on this same process.
                    let call = proc.next_id.fetch_add(1, Ordering::SeqCst);
                    let _ = proc.write(
                        json!({
                            "id": call, "method": "turn/interrupt",
                            "params": {"threadId": thread, "turnId": provider_turn}
                        })
                        .to_string(),
                    );
                }
            }
        }
        // If the provider ignores the interrupt, end its process; the session
        // stays resumable and the next send resumes it.
        let inner = self.clone();
        let id = id.to_owned();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(STOP_GRACE).await;
            let _lifecycle = lock(&inner.lifecycle);
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
        let _lifecycle = lock(&self.lifecycle);
        let (live, turn, dropped, saved) = {
            let mut state = lock(&self.state);
            let Some(record) = state.records.iter_mut().find(|r| r.id == id) else {
                return Err(("SESSION_NOT_FOUND", "That chat no longer exists.".into()));
            };
            record.status = "stopped".into();
            let proc = state.live.get(id).map(|live| live.proc.clone());
            let turn = if proc.is_some() {
                if let Some(turn) = state.turns.get_mut(id) {
                    turn.stopping = true;
                }
                None
            } else {
                state.turns.remove(id)
            };
            if proc.is_none() {
                if let Some(record) = state.records.iter_mut().find(|r| r.id == id) {
                    record.turn_id = None;
                }
            }
            if let Some(turn) = &turn {
                if let Some(durable) = state.ledger.get_mut(&turn.id) {
                    durable.settle("interrupted", None);
                }
            }
            let dropped = state.queues.remove(id).unwrap_or_default();
            for item in &dropped {
                if let Some(durable) = state.ledger.get_mut(&item.turn_id) {
                    durable.settle("cancelled", None);
                }
            }
            let saved = self.save(&state);
            (proc, turn, dropped, saved)
        };
        if let Some(turn) = turn {
            let _ = self.write_settlement(&turn.id, true);
            if turn.origin["kind"] == "schedule" {
                self.schedule_finished(&turn.origin, &turn.id, "interrupted", None);
            }
        }
        for item in &dropped {
            let _ = self.write_settlement(&item.turn_id, true);
            if item.origin["kind"] == "schedule" {
                self.schedule_finished(&item.origin, &item.turn_id, "cancelled", None);
            }
        }
        if !dropped.is_empty() {
            self.publish_queued(id, 0);
        }
        self.publish(
            event(id, None, "status", json!({"status": "stopped"})),
            false,
        );
        if let Some(proc) = live {
            // Keep this generation and its turn until exit is confirmed.
            proc.kill();
        }
        saved.map_err(|message| ("STORAGE_FAILED", message))?;
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
        let _lifecycle = lock(&self.lifecycle);
        let victims: Vec<(String, Arc<Proc>)> = {
            let state = lock(&self.state);
            state
                .live
                .iter()
                .filter(|(id, live)| {
                    !state.turns.contains_key(*id) && live.last_used.elapsed() > IDLE_LIMIT
                })
                .map(|(id, live)| (id.clone(), live.proc.clone()))
                .collect()
        };
        for (id, proc) in victims {
            if retire(&proc) {
                lock(&self.state).live.remove(&id);
            }
        }
    }
}

// ------------------------------------------------------------------ helpers

type RpcReceiver = oneshot::Receiver<Result<Value, String>>;

fn begin_rpc(proc: &Arc<Proc>, method: &str, params: Value) -> Result<(u64, RpcReceiver), String> {
    let call = proc.next_id.fetch_add(1, Ordering::SeqCst);
    let (sender, receiver) = oneshot::channel();
    lock(&proc.pending).insert(call, sender);
    if let Err(problem) =
        proc.write(json!({"id": call, "method": method, "params": params}).to_string())
    {
        lock(&proc.pending).remove(&call);
        return Err(problem);
    }
    Ok((call, receiver))
}

async fn await_rpc(
    proc: &Arc<Proc>,
    method: &str,
    call: u64,
    receiver: RpcReceiver,
) -> Result<Value, String> {
    await_rpc_for(proc, method, call, receiver, RPC_WAIT).await
}

async fn await_rpc_for(
    proc: &Arc<Proc>,
    method: &str,
    call: u64,
    receiver: RpcReceiver,
    wait: Duration,
) -> Result<Value, String> {
    match tokio::time::timeout(wait, receiver).await {
        Ok(Ok(result)) => result.map_err(|e| format!("Codex rejected {method}: {e}")),
        Ok(Err(_)) => Err(format!("Codex stopped before answering {method}.")),
        Err(_) => {
            lock(&proc.pending).remove(&call);
            let message = format!(
                "Codex did not answer {method} in time. Its process is being stopped before another turn can start."
            );
            *lock(&proc.failure) = Some(message.clone());
            proc.kill();
            Err(message)
        }
    }
}

async fn rpc(proc: &Arc<Proc>, method: &str, params: Value) -> Result<Value, String> {
    let (call, receiver) = begin_rpc(proc, method, params)?;
    await_rpc(proc, method, call, receiver).await
}

async fn initialize_codex(proc: &Arc<Proc>) -> Result<(), String> {
    rpc(proc, "initialize", json!({
        "clientInfo": {"name": "codaclauda", "title": "CodaClauda", "version": env!("CARGO_PKG_VERSION")},
        "capabilities": {"experimentalApi": false, "optOutNotificationMethods": CODEX_QUIET}
    })).await?;
    proc.write(json!({"method": "initialized"}).to_string())
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
        !STRIPPED_ENV.contains(&name.as_str()) && session_policy::retain_launch_env(&name)
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

fn claude_args(record: &Record, fresh_session: &str, mcp_config: Option<&Path>) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
    ]
    .map(OsString::from)
    .into();
    args.extend(session_policy::claude_policy_args(&record.access));
    // Full access only (the caller passes None otherwise). `--mcp-config` is
    // variadic, so another option always follows it; `--strict-mcp-config`
    // (policy args) keeps every other MCP source out.
    if let Some(config) = mcp_config.filter(|_| record.access == "full") {
        args.extend(["--mcp-config".into(), config.as_os_str().to_owned()]);
    }
    if let Some(model) = &record.model {
        args.extend(["--model".into(), model.into()]);
    }
    if let Some(effort) = &record.effort {
        args.extend(["--effort".into(), effort.into()]);
    }
    match (&record.provider_session_id, &record.fork_from) {
        (Some(session), _) => args.extend(["--resume".into(), session.into()]),
        // A fork's first launch: a new session id holding a copy of the source.
        (None, Some(source)) => {
            args.extend(["--resume".into(), source.into(), "--fork-session".into()])
        }
        (None, None) => args.extend(["--session-id".into(), fresh_session.into()]),
    }
    args
}

fn codex_args(overrides: &[String]) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["app-server", "--listen", "stdio://"]
        .map(OsString::from)
        .into();
    for setting in session_policy::codex_base_overrides()
        .iter()
        .chain(overrides.iter())
    {
        args.extend(["-c".into(), setting.into()]);
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
        if kind.is_file()
            && entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(name)
        {
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

/// Locate a desktop-app bundle or PATH executable using metadata only.
/// Fresh isolated authentication and effective-policy checks belong to launch.
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
                scan(
                    &roaming.join("Claude").join("claude-code"),
                    provider.exe(),
                    3,
                    &mut found,
                );
            }
            if let Some(local) = var("LOCALAPPDATA") {
                if let Ok(packages) = fs::read_dir(local.join("Packages")) {
                    for package in packages.flatten().filter(|p| {
                        p.file_name()
                            .to_string_lossy()
                            .starts_with("AnthropicPBC.Claude_")
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
                scan(
                    &profile.join(".local").join("bin"),
                    provider.exe(),
                    1,
                    &mut found,
                );
            }
        }
        Provider::Codex => {
            if let Some(local) = var("LOCALAPPDATA") {
                scan(
                    &local.join("OpenAI/Codex/bin"),
                    provider.exe(),
                    2,
                    &mut found,
                );
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
    found.into_iter().next().ok_or_else(|| {
        format!(
            "{} could not be found. Install its desktop app or CLI, then try again.",
            provider.label()
        )
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
pub(crate) async fn session_start(app: tauri::AppHandle, mut args: Value) -> Value {
    let inner = host(&app);
    // Only a team start (team.rs) records who started a session.
    if let Some(fields) = args.as_object_mut() {
        fields.remove("startedBy");
    }
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
    let item = Queued::new(text, attachments.unwrap_or_default(), Value::Null);
    reply(inner.submit(&id, item))
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

impl Inner {
    /// Codex compact-now (0.5), queued like any other turn. Claude runs with
    /// slash commands disabled here, so `/compact` cannot be sent to it.
    fn compact(self: &Arc<Self>, id: &str) -> Result<Value, Failure> {
        let (provider, thread) = lock(&self.state)
            .records
            .iter()
            .find(|r| r.id == id)
            .map(|r| (r.provider.clone(), r.thread_id.clone()))
            .ok_or(("SESSION_NOT_FOUND", "That chat no longer exists.".to_owned()))?;
        if provider != "codex" {
            return Err((
                "COMPACT_UNSUPPORTED",
                "Claude sessions in CodaClauda run with slash commands disabled, so /compact is unavailable here. Claude compacts on its own when its context fills.".into(),
            ));
        }
        if thread.is_none() {
            return Err((
                "NOTHING_TO_COMPACT",
                "Send a message first; this chat has no Codex thread yet.".into(),
            ));
        }
        let item = Queued::new(
            "Compact this conversation's context.".into(),
            Vec::new(),
            json!({"kind": "compact"}),
        );
        self.submit(id, item)?;
        Ok(json!({"ok": true}))
    }
}

#[tauri::command]
pub(crate) async fn session_compact(app: tauri::AppHandle, id: String) -> Value {
    let inner = host(&app);
    reply(inner.compact(&id))
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
            status: "idle".into(),
            ..Record::default()
        }
    }

    #[test]
    fn compact_handoff_and_team_turns_are_admitted_but_unknown_origins_are_not() {
        // 0.5 hand-off and compact-now were refused as "Unknown turn origin"
        // after the 0.4.1 merge; automation origins still revalidate.
        for kind in ["compact", "handoff", "team"] {
            assert!(owner_equivalent_origin(&json!({"kind": kind})), "{kind}");
        }
        assert!(owner_equivalent_origin(&Value::Null));
        for kind in ["wake", "schedule", "mystery"] {
            assert!(!owner_equivalent_origin(&json!({"kind": kind})), "{kind}");
        }
        // Team fields round-trip, and legacy records never get the first-turn note.
        let legacy: Record = serde_json::from_value(json!({"id": "s_0123456789abcdef", "provider": "codex", "projectId": "p", "cwd": "C:\\p", "title": "t", "access": "read", "threadId": null, "providerSessionId": null, "status": "idle", "createdAt": 1, "lastActivityAt": 1, "shared": false, "sharedId": null})).unwrap();
        assert!(!legacy.team_note && legacy.started_by.is_none() && !legacy.wake);
        let mut started = legacy.clone();
        started.started_by = Some(json!({"address": "claude-p-0001", "messageId": "m1", "at": 2}));
        started.team_note = true;
        let back: Record = serde_json::from_value(serde_json::to_value(&started).unwrap()).unwrap();
        assert_eq!(back.started_by, started.started_by);
        assert!(back.team_note);
    }

    #[test]
    fn durable_queue_recovery_interrupts_without_replaying_and_preserves_identity() {
        let dir = tempfile::tempdir().unwrap();
        let saved = record("claude", "read");
        let mut state = State {
            records: vec![saved.clone()],
            ..State::default()
        };
        let first = Queued::keyed(
            "private prompt".into(),
            vec![],
            json!({"kind":"wake","messageId":"m1"}),
            "wake:stable-key".into(),
        );
        let second = Queued::new("second queued prompt".into(), vec![], Value::Null);
        for item in [&first, &second] {
            state
                .accept_queued(&saved.id, item.clone(), |s| {
                    save_snapshot(dir.path(), &s.records, &s.ledger)
                })
                .unwrap();
        }
        // One accepted turn started; the other never reached a provider.
        state.records[0].status = "running".into();
        state.records[0].turn_id = Some(first.turn_id.clone());
        state.ledger.get_mut(&first.turn_id).unwrap().status = "active".into();
        save_snapshot(dir.path(), &state.records, &state.ledger).unwrap();
        let (records, ledger) = read_snapshot(&dir.path().join(REGISTRY_FILE)).unwrap();
        let mut recovered = State {
            records,
            ledger,
            ..State::default()
        };
        assert!(recovered.interrupt_pending().0);
        assert!(
            recovered.queues.is_empty()
                && recovered.turns.is_empty()
                && recovered.launching.is_empty()
        );
        assert_eq!(recovered.records[0].status, "idle");
        for item in [&first, &second] {
            let turn = &recovered.ledger[&item.turn_id];
            assert_eq!(turn.status, "interrupted");
            assert_eq!(turn.payload.as_ref().unwrap().text, item.text);
            assert_eq!(
                recovered.duplicate(&saved.id, item).unwrap().unwrap()["turnId"],
                item.turn_id
            );
        }
        save_snapshot(dir.path(), &recovered.records, &recovered.ledger).unwrap();
        assert!(
            read_snapshot(&dir.path().join(REGISTRY_FILE))
                .unwrap()
                .1
                .values()
                .all(|t| t.status == "interrupted")
        );
    }

    #[test]
    fn rejected_queue_save_rolls_back_admission_without_losing_prior_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let saved = record("codex", "read");
        let mut state = State {
            records: vec![saved.clone()],
            ..State::default()
        };
        save_snapshot(dir.path(), &state.records, &state.ledger).unwrap();
        let previous = fs::read(dir.path().join(REGISTRY_FILE)).unwrap();
        fs::remove_dir(dir.path().join(LOG_DIR)).unwrap();
        fs::write(dir.path().join(LOG_DIR), b"preserve storage obstruction").unwrap();
        let item = Queued::new("must not dispatch".into(), vec![], Value::Null);
        assert!(
            state
                .accept_queued(&saved.id, item, |s| save_snapshot(
                    dir.path(),
                    &s.records,
                    &s.ledger
                ))
                .is_err()
        );
        assert!(state.queues.is_empty() && state.ledger.is_empty() && state.turns.is_empty());
        assert_eq!(fs::read(dir.path().join(REGISTRY_FILE)).unwrap(), previous);
    }

    #[test]
    fn terminal_receipts_compact_payload_without_forgetting_dedupe_or_collisions() {
        let dir = tempfile::tempdir().unwrap();
        let saved = record("codex", "read");
        let item = Queued::keyed(
            "original confidential prompt".into(),
            vec![],
            json!({"kind":"schedule","scheduleId":"test"}),
            "scheduled:run1".into(),
        );
        let mut state = State {
            records: vec![saved.clone()],
            ..State::default()
        };
        state
            .accept_queued(&saved.id, item.clone(), |s| {
                save_snapshot(dir.path(), &s.records, &s.ledger)
            })
            .unwrap();
        for status in ["cancelled", "failed"] {
            let turn = state.ledger.get_mut(&item.turn_id).unwrap();
            turn.settle(status, Some("explicit terminal reason"));
            save_snapshot(dir.path(), &state.records, &state.ledger).unwrap();
            let (_, rows) = read_snapshot(&dir.path().join(REGISTRY_FILE)).unwrap();
            assert_eq!(rows[&item.turn_id].status, status);
        }
        let turn = state.ledger.get_mut(&item.turn_id).unwrap();
        turn.history_saved = true;
        turn.payload = None;
        save_snapshot(dir.path(), &state.records, &state.ledger).unwrap();
        assert!(
            !String::from_utf8(fs::read(dir.path().join(REGISTRY_FILE)).unwrap())
                .unwrap()
                .contains("original confidential prompt")
        );
        let (records, ledger) = read_snapshot(&dir.path().join(REGISTRY_FILE)).unwrap();
        let state = State {
            records,
            ledger,
            ..State::default()
        };
        assert_eq!(
            state.duplicate(&saved.id, &item).unwrap().unwrap()["duplicate"],
            true
        );
        let changed = Queued::keyed(
            "changed payload".into(),
            vec![],
            item.origin.clone(),
            item.key.clone().unwrap(),
        );
        assert_eq!(
            state.duplicate(&saved.id, &changed).unwrap_err().0,
            "TURN_ID_CONFLICT"
        );
        assert!(state.duplicate("s_1111111111111111", &item).is_err());
    }

    #[test]
    fn legacy_registry_migration_preserves_original_and_new_ledger_is_strict() {
        let dir = tempfile::tempdir().unwrap();
        ensure_dirs(dir.path()).unwrap();
        let saved = record("claude", "read");
        let path = dir.path().join(REGISTRY_FILE);
        let original =
            serde_json::to_vec(&json!({"schema":"codaclauda.sessions/1","sessions":[saved]}))
                .unwrap();
        fs::write(&path, &original).unwrap();
        let (records, ledger) = read_snapshot(&path).unwrap();
        assert!(ledger.is_empty());
        save_snapshot(dir.path(), &records, &ledger).unwrap();
        assert_eq!(
            fs::read(dir.path().join("sessions.schema1.backup.json")).unwrap(),
            original
        );
        assert_eq!(read_snapshot(&path).unwrap().0[0].id, saved.id);
        let good: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        for malformed in [
            json!({"schema":"codaclauda.sessions/2","sessions":good["sessions"]}),
            json!({"schema":"codaclauda.sessions/2","sessions":good["sessions"],"turns":{"t_00":{}}}),
        ] {
            let bytes = serde_json::to_vec(&malformed).unwrap();
            fs::write(&path, &bytes).unwrap();
            assert!(read_snapshot(&path).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn launch_arguments_follow_the_access_level() {
        let full: Vec<String> = claude_args(&record("claude", "full"), "u", None)
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(
            full.windows(2)
                .any(|w| w == ["--permission-mode", "bypassPermissions"])
        );
        assert!(full.contains(&"--disable-slash-commands".to_owned()));
        assert!(!full.contains(&"--mcp-config".to_owned()));
        let read: Vec<String> = claude_args(&record("claude", "read"), "u", Some(Path::new("m.json")))
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(read.contains(&"--restricted".to_owned()));
        assert!(read.windows(2).any(|w| w == ["--session-id", "u"]));
        assert!(!read.contains(&"--mcp-config".to_owned()));
        let mut fork = record("claude", "full");
        fork.fork_from = Some("src".into());
        let forked: Vec<String> = claude_args(&fork, "u", Some(Path::new("m.json")))
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(forked.windows(3).any(|w| w == ["--resume", "src", "--fork-session"]));
        assert!(forked.windows(2).any(|w| w == ["--mcp-config", "m.json"]));
        let codex: Vec<String> = codex_args(&[])
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(codex.contains(&"forced_login_method=\"chatgpt\"".to_owned()));
        assert!(!codex.iter().any(|arg| arg.contains("mcp_servers.")));
        let probe = codex_args(&[]);
        assert!(
            !probe
                .iter()
                .any(|arg| arg.to_string_lossy().contains("mcp_servers."))
        );
        assert!(valid_id("s_0123456789abcdef") && !valid_id("s_../../x"));
        assert_eq!(uuid_v4().len(), 36);
    }

    #[test]
    fn persisted_browser_requests_are_preserved_but_cannot_be_dispatched() {
        let dir = tempfile::tempdir().unwrap();
        let mut saved = record("claude", "full");
        saved.playwright = true;
        save_registry(dir.path(), &[saved]).unwrap();
        let loaded = read_registry(&dir.path().join(REGISTRY_FILE)).unwrap();
        assert!(loaded[0].playwright);
        assert!(
            require_browser_disabled(loaded[0].playwright)
                .unwrap_err()
                .contains("unavailable")
        );
        assert!(require_browser_disabled(false).is_ok());
    }

    #[test]
    fn only_one_host_can_load_a_boards_registry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions-host.lock");
        let first = lease_file(&path).unwrap();
        FileExt::try_lock_exclusive(&first).unwrap();
        let second = lease_file(&path).unwrap();
        assert!(FileExt::try_lock_exclusive(&second).is_err());
        drop(first);
        FileExt::try_lock_exclusive(&second).unwrap();
    }

    #[test]
    fn update_excludes_turn_admission_until_every_owner_releases() {
        let dir = tempfile::tempdir().unwrap();
        let turn = runtime_lease(dir.path()).unwrap();
        let process = turn.clone();
        let another_turn = runtime_lease(dir.path()).unwrap();
        let updater = lease_file(&dir.path().join("session-runtime.lock")).unwrap();
        assert!(FileExt::try_lock_exclusive(&updater).is_err());
        drop(turn);
        drop(another_turn);
        assert!(FileExt::try_lock_exclusive(&updater).is_err());
        drop(process);
        FileExt::try_lock_exclusive(&updater).unwrap();
        assert!(runtime_lease(dir.path()).is_err());
        drop(updater);
        assert!(runtime_lease(dir.path()).is_ok());
    }

    #[test]
    fn malformed_and_duplicate_registries_are_preserved_and_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(REGISTRY_FILE);
        assert!(read_registry(&path).unwrap().is_empty());
        let records = [record("codex", "read"), record("codex", "read")];
        for bytes in [
            b"{broken".to_vec(),
            serde_json::to_vec(&json!({"schema": "unknown", "sessions": []})).unwrap(),
            serde_json::to_vec(&json!({"schema": "codaclauda.sessions/1", "sessions": records}))
                .unwrap(),
        ] {
            fs::write(&path, &bytes).unwrap();
            assert!(read_registry(&path).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn registry_write_errors_are_returned_without_replacing_existing_data() {
        let dir = tempfile::tempdir().unwrap();
        let saved = vec![record("claude", "read")];
        save_registry(dir.path(), &saved).unwrap();
        let previous = fs::read(dir.path().join(REGISTRY_FILE)).unwrap();
        // An unexpected non-directory at the display-log path must fail
        // before the registry can be replaced or a turn can be dispatched.
        fs::remove_dir(dir.path().join(LOG_DIR)).unwrap();
        fs::write(dir.path().join(LOG_DIR), b"preserve me").unwrap();
        assert!(save_registry(dir.path(), &[]).is_err());
        assert_eq!(fs::read(dir.path().join(REGISTRY_FILE)).unwrap(), previous);
        assert_eq!(
            read_registry(&dir.path().join(REGISTRY_FILE))
                .unwrap()
                .len(),
            1
        );
    }

    fn queued_turn(id: &str, lease: Arc<File>) -> Turn {
        Turn {
            id: id.into(),
            provider_turn: None,
            stopping: false,
            dispatched: false,
            start_pending: false,
            completion: None,
            _lease: lease,
            origin: Value::Null,
        }
    }

    #[test]
    fn simultaneous_launches_cannot_overbook_pending_capacity() {
        let dir = tempfile::tempdir().unwrap();
        let lease = runtime_lease(dir.path()).unwrap();
        let mut state = State::default();
        state.max_live = limits::Limit::Finite(5); // the owner's setting, not a built-in cap
        for n in 0..8 {
            state
                .turns
                .insert(format!("s{n}"), queued_turn("t", lease.clone()));
        }
        let state = Arc::new(Mutex::new(state));
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let attempts: Vec<_> = (0..8)
            .map(|n| {
                let state = state.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    lock(&state).reserve_launch(&format!("s{n}"), "t").is_ok()
                })
            })
            .collect();
        let admitted = attempts
            .into_iter()
            .map(|attempt| attempt.join().unwrap())
            .filter(|admitted| *admitted)
            .count();
        assert_eq!(admitted, 5);
        assert_eq!(lock(&state).launching.len(), 5);
        let mut state = lock(&state);
        state.turns.insert("s9".into(), queued_turn("t", lease));
        let Err(refused) = state.reserve_launch("s9", "t") else {
            panic!("a launch past the owner's limit was admitted");
        };
        assert!(refused.contains("Settings → Limits → Agents at once"), "{refused}");
    }

    #[test]
    fn cancelled_launch_and_stale_cleanup_cannot_target_a_new_turn() {
        let dir = tempfile::tempdir().unwrap();
        let lease = runtime_lease(dir.path()).unwrap();
        let mut state = State::default();
        state
            .turns
            .insert("s".into(), queued_turn("old", lease.clone()));
        assert!(state.reserve_launch("s", "old").is_ok());
        state.turns.remove("s"); // close while discovery is outstanding
        assert!(!state.accepts_launch("s", "old"));
        state.turns.insert("s".into(), queued_turn("new", lease));
        assert!(state.reserve_launch("s", "new").is_err());
        state.release_launch("s", "old"); // the old startup has quiesced
        assert!(state.reserve_launch("s", "new").is_ok());
        state.release_launch("s", "old"); // delayed old cleanup
        assert!(state.accepts_launch("s", "new"));
        assert!(!state.accepts_launch("s", "old"));
    }

    #[test]
    fn delayed_provider_notifications_cannot_complete_or_rebind_a_later_turn() {
        let dir = tempfile::tempdir().unwrap();
        let lease = runtime_lease(dir.path()).unwrap();
        let mut completed = HashSet::new();
        let mut first = queued_turn("local-1", lease.clone());
        assert!(accept_codex_turn(
            &mut first,
            &completed,
            Some("provider-1")
        ));
        completed.insert(first.provider_turn.unwrap());
        let mut second = queued_turn("local-2", lease);
        // Old turn/started, output and completion share this identity gate,
        // including before the new turn/start response has arrived.
        assert!(!accept_codex_turn(
            &mut second,
            &completed,
            Some("provider-1")
        ));
        assert!(second.provider_turn.is_none());
        assert!(!accept_codex_turn(&mut second, &completed, None));
        assert!(accept_codex_turn(
            &mut second,
            &completed,
            Some("provider-2")
        ));
        assert!(!accept_codex_turn(
            &mut second,
            &completed,
            Some("provider-1")
        ));
        assert_eq!(second.provider_turn.as_deref(), Some("provider-2"));
    }

    #[test]
    fn terminal_event_before_start_reply_keeps_the_turn_and_update_lease() {
        let dir = tempfile::tempdir().unwrap();
        let mut turn = queued_turn("local", runtime_lease(dir.path()).unwrap());
        turn.start_pending = true;
        turn.dispatched = true;
        let completed = HashSet::new();
        assert!(accept_codex_turn(&mut turn, &completed, Some("provider")));
        assert!(turn.complete("completed".into()).is_none());
        assert!(turn.start_pending);
        let updater = lease_file(&dir.path().join("session-runtime.lock")).unwrap();
        assert!(FileExt::try_lock_exclusive(&updater).is_err());
        assert_eq!(
            turn.acknowledge(&completed, "provider").unwrap().as_deref(),
            Some("completed")
        );
        drop(turn);
        FileExt::try_lock_exclusive(&updater).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn ambiguous_rpc_timeout_retires_owned_child_and_keeps_lease_until_quiescent() {
        let dir = tempfile::tempdir().unwrap();
        let cmd = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32")
            .join("cmd.exe");
        // A local pipe consumer, never a provider or model. It deliberately
        // accepts input without replying to exercise the real timeout path.
        let args = ["/d", "/q", "/c", "more > nul"].map(OsString::from);
        let (proc, _stdout) = spawn_owned(
            &cmd,
            &args,
            dir.path(),
            Provider::Codex,
            1,
            runtime_lease(dir.path()).unwrap(),
            &[],
        )
        .unwrap();
        let (call, receiver) = begin_rpc(&proc, "turn/start", json!({})).unwrap();
        let error = await_rpc_for(
            &proc,
            "turn/start",
            call,
            receiver,
            Duration::from_millis(30),
        )
        .await
        .unwrap_err();
        assert!(error.contains("did not answer"));
        assert!(proc.expected_exit.load(Ordering::SeqCst));
        assert!(lock(&proc.failure).is_some());
        let updater = lease_file(&dir.path().join("session-runtime.lock")).unwrap();
        assert!(FileExt::try_lock_exclusive(&updater).is_err());
        assert!(retire(&proc));
        lock(&proc.runtime_lease).take();
        FileExt::try_lock_exclusive(&updater).unwrap();
    }
}
