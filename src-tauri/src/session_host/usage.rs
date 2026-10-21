//! Usage and credits (0.6): one owner setting for the whole app (`usage.json`),
//! never per project and never reachable from an agent's tools. It governs only
//! the sessions CodaClauda owns: other Codex or Claude clients and the provider
//! account's own settings are not affected.
//!
//! Protocol relied on, pinned to codex-cli 0.163.0-alpha.10.2 (its app-server
//! v2 schema dump): `account/rateLimits/read` → { accountId?,
//! ordinaryUsageAllowed?, rateLimits { primary?, secondary? { usedPercent,
//! windowDurationMins?, resetsAt? }, credits? { hasCredits, unlimited,
//! balance? }, spendControlReached?, rateLimitReachedType? },
//! rateLimitResetCredits? { availableCount } }; `account/rateLimits/updated`
//! (sparse: a null never clears a saved value); `account/updated` and
//! `account/login/completed` (sign-in changed); `account/rateLimitResetCredit/
//! consume` { idempotencyKey } → outcome reset | nothingToReset | noCredit |
//! alreadyRedeemed; `account/usage/read` { threadId } → threadUsage?
//! .estimatedUsageCreditsMicros (an estimate). Claude: claude 2.1.299
//! stream-json `rate_limit_event` and its usage-limit errors. An absent or null
//! field stays unknown: never zero, never permission to spend.
//!
//! A turn the gate refuses before anything reaches the provider is held: it
//! keeps its turn ID and payload in the durable ledger (`DurableTurn.hold`),
//! survives a restart, is cancelled by Stop or close, and is dispatched again
//! once at a validated provider reset (or when the owner presses Try now or
//! turns a setting on), rechecked through normal admission and a fresh gate. A
//! usage-limit error after the turn was sent is never replayed: its receipt is
//! kept, the session is marked stopped at the usage limit and the owner may
//! Continue with a new turn that names the original one.
//!
//! Earned Codex reset credits: one reset episode per account (a hash of
//! accountId, never the id) across every session and CodaClauda process,
//! recorded with its idempotency key in the app data folder under a file lock
//! before the consume call. Nothing here reads credentials or changes sign-in.

use super::{
    DurableTurn, Failure, Inner, Proc, Provider, Queued, Record, State, begin_rpc, ensure_dirs, event,
    hex_digest, host, lease_file, lock, now_ms, reply, uuid_v4, write_atomic,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::File,
    future::Future,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::Manager;

const USAGE_FILE: &str = "usage.json";
const FILE_LIMIT: u64 = 64 * 1024;
/// Read-only provider queries never retire the process when they are slow.
const SOFT_WAIT: Duration = Duration::from_secs(20);
/// Wait a little past the reported reset before the one retry.
const RESET_MARGIN_MS: u64 = 30_000;
/// A snapshot this fresh is not read again before a send.
const FRESH_MS: u64 = 5_000;
const RESETS_FILE: &str = "usage-resets.json";
const RESETS_LOCK: &str = "usage-resets.lock";
const RESETS_SCHEMA: &str = "codaclauda.usage-resets/1";
/// Long enough for another chat's consume and its two reads.
const LOCK_WAIT: Duration = Duration::from_secs(75);
const HOUR: u64 = 3600;
const WEEK: u64 = 7 * 24 * HOUR;
/// Clock slack when a reset is checked against its window.
const SKEW: u64 = 120;
pub(super) const CLAUDE_USAGE_URL: &str = "https://claude.ai/settings/usage";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Settings {
    pub codex_credits: bool,
    pub codex_resets: bool,
    pub claude_credits: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { codex_credits: true, codex_resets: true, claude_credits: true }
    }
}

impl Settings {
    const OFF: Self = Self { codex_credits: false, codex_resets: false, claude_credits: false };

    fn to_json(self) -> Value {
        json!({"codex": {"useCredits": self.codex_credits, "useResets": self.codex_resets},
            "claude": {"useCredits": self.claude_credits}})
    }
}

/// Every flag defaults to true when absent; anything but a boolean is invalid.
pub(super) fn parse_settings(value: &Value) -> Result<Settings, String> {
    if !value.is_object() {
        return Err("Usage settings are not an object.".into());
    }
    let flag = |provider: &str, key: &str| match &value[provider][key] {
        Value::Null => Ok(true),
        Value::Bool(on) => Ok(*on),
        _ => Err(format!("{provider}.{key} must be true or false.")),
    };
    Ok(Settings {
        codex_credits: flag("codex", "useCredits")?,
        codex_resets: flag("codex", "useResets")?,
        claude_credits: flag("claude", "useCredits")?,
    })
}

// ------------------------------------------------------------- held turns

/// A turn the usage gate held before anything reached the provider. Saved on
/// its `DurableTurn`, so it survives a restart with its original turn ID.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Hold {
    pub(super) provider: String,
    pub(super) reason: String,
    /// A validated provider reset (unix seconds) for the one automatic retry.
    #[serde(default)]
    pub(super) retry_at: Option<u64>,
    /// The one automatic retry was used: no timer is armed again.
    #[serde(default)]
    pub(super) retried: bool,
    /// The owner pressed Try now (Claude has no fresh limit query to recheck).
    #[serde(default)]
    pub(super) owner_try: bool,
    #[serde(default)]
    pub(super) at: u64,
}

impl Hold {
    /// When the one automatic retry is due: an unused, future reset within a week.
    pub(super) fn due(&self, now_secs: u64) -> Option<u64> {
        self.retry_at
            .filter(|at| !self.retried && *at > now_secs && *at <= now_secs + WEEK + SKEW)
    }
}

/// What releases a held turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Trigger {
    /// The one automatic retry at this validated reset (unix seconds).
    Timer(u64),
    /// The owner pressed Try now.
    Owner,
    /// The owner turned a usage setting on.
    Settings,
}

pub(super) enum Released {
    NotHeld,
    Queued,
    /// Admission refused it at dispatch; it is settled and was never sent.
    Refused(Queued, Failure),
}

/// What the engine does with a send.
pub(super) enum Gate {
    Send,
    /// The turn was stopped meanwhile; the stop path finishes it.
    Stopped,
    Hold(Hold),
}

fn provider_label(name: &str) -> &'static str {
    Provider::parse(name).map_or("The agent", Provider::label)
}

pub(super) fn held_text(hold: &Hold, now_secs: u64) -> String {
    let base = format!(
        "{}'s plan limit is reached and {}. Nothing was sent.",
        provider_label(&hold.provider),
        hold.reason
    );
    match hold.due(now_secs) {
        Some(at) => format!("{base} This turn keeps its place and is sent once at {}, the reset the provider reported. Stop cancels it.", when(at)),
        None if hold.retried => format!("{base} It was still limited at its one retry, so it will not retry again by itself. Waiting for the plan to reset; check Settings > Usage. Try now sends it when you choose; Stop cancels it."),
        None => format!("{base} No usable reset time was reported, so no retry is scheduled. Waiting for the plan to reset; check Settings > Usage. Try now sends it when you choose; Stop cancels it."),
    }
}

/// The held turn as the UI shows it (session list and live 'usage' events).
pub(super) fn held_view(turn_id: &str, hold: &Hold, now_secs: u64) -> Value {
    json!({"turnId": turn_id, "provider": hold.provider, "reason": hold.reason,
        "retryAt": hold.due(now_secs).map(|at| at.saturating_mul(1000)), "retried": hold.retried,
        "since": hold.at, "text": held_text(hold, now_secs)})
}

fn stopped_text(provider: Provider, resets_at: Option<u64>) -> String {
    let reset = resets_at
        .map(|at| format!(" The limit resets {}.", when(at)))
        .unwrap_or_default();
    format!(
        "{}'s usage limit stopped this turn after it was sent, so part of it may already have run. Stopped at the usage limit; review what ran, then Continue (a new turn that names this one; nothing is replayed).{reset}",
        provider.label()
    )
}

/// The owner's Continue: a new turn naming the original. One per stopped turn.
pub(super) fn continue_item(turn_id: &str) -> Queued {
    Queued::keyed(
        format!("Continue from turn {turn_id}, which stopped at the usage limit after it was sent. Part of it may already have run: check what was done before repeating any step."),
        Vec::new(),
        json!({"kind": "continue", "turnId": turn_id}),
        format!("continue:{turn_id}"),
    )
}

impl State {
    pub(super) fn held_turn(&self, session: &str) -> Option<&DurableTurn> {
        self.ledger
            .values()
            .find(|t| t.status == "held" && t.session_id == session)
    }

    /// A queued turn may start: nothing runs and no held turn is ahead of it.
    pub(super) fn startable(&self, session: &str) -> bool {
        !self.session_busy(session) && self.held_turn(session).is_none()
    }

    /// The gate refused before anything reached the provider: the current turn
    /// goes back to the ledger as held (same turn ID, payload kept) and the
    /// session is free. None: it was stopped, already dispatched (it may have
    /// started, so it is never held) or replaced meanwhile.
    pub(super) fn hold_turn(
        &mut self,
        session: &str,
        turn_id: &str,
        mut hold: Hold,
        persist: impl FnOnce(&Self) -> Result<(), String>,
    ) -> Result<Option<Hold>, String> {
        if !self
            .turns
            .get(session)
            .is_some_and(|t| t.id == turn_id && !t.stopping && !t.dispatched)
        {
            return Ok(None);
        }
        let Some(index) = self.records.iter().position(|r| r.id == session) else {
            return Ok(None);
        };
        let Some(durable) = self
            .ledger
            .get_mut(turn_id)
            .filter(|d| d.status == "active" && d.payload.is_some())
        else {
            return Ok(None);
        };
        let before = durable.clone();
        // The one automatic retry is never re-armed.
        if before.hold.as_ref().is_some_and(|h| h.retried) {
            hold.retried = true;
        }
        durable.status = "held".into();
        durable.hold = Some(hold.clone());
        let record_before = self.records[index].clone();
        let record = &mut self.records[index];
        record.status = "idle".into();
        record.turn_id = None;
        record.last_activity_at = now_ms();
        if let Err(error) = persist(self) {
            self.ledger.insert(turn_id.to_owned(), before);
            self.records[index] = record_before;
            return Err(error);
        }
        self.turns.remove(session);
        Ok(Some(hold))
    }

    /// Moves a held turn to the front of its queue, after rechecking the chat
    /// and the caller's admission (access level, revocation). A stale timer
    /// (already retried, re-held or cancelled) releases nothing.
    pub(super) fn take_held(
        &mut self,
        session: &str,
        turn_id: &str,
        trigger: Trigger,
        admit: impl FnOnce(&Self, &Record, &Queued) -> Result<(), Failure>,
        persist: impl FnOnce(&Self) -> Result<(), String>,
    ) -> Result<Released, String> {
        let Some(durable) = self
            .ledger
            .get(turn_id)
            .filter(|d| d.session_id == session && d.status == "held")
        else {
            return Ok(Released::NotHeld);
        };
        let (Some(item), Some(hold)) = (durable.payload.clone(), durable.hold.clone()) else {
            return Ok(Released::NotHeld);
        };
        if let Trigger::Timer(at) = trigger {
            if hold.retried || hold.retry_at != Some(at) {
                return Ok(Released::NotHeld);
            }
        }
        let before = durable.clone();
        let refusal = match self.records.iter().find(|r| r.id == session) {
            None => Some(("cancelled", ("SESSION_NOT_FOUND", "That chat no longer exists.".to_owned()))),
            Some(r) if r.status == "stopped" => Some((
                "cancelled",
                ("SESSION_CLOSED", "The chat was closed, so its held turn was not sent.".to_owned()),
            )),
            Some(r) => admit(self, r, &item).err().map(|failure| ("failed", failure)),
        };
        let durable = self.ledger.get_mut(turn_id).expect("checked above");
        if let Some((status, failure)) = refusal {
            durable.settle(status, Some(&format!("{} The held turn was never sent.", failure.1)));
            if let Err(error) = persist(self) {
                self.ledger.insert(turn_id.to_owned(), before);
                return Err(error);
            }
            return Ok(Released::Refused(item, failure));
        }
        durable.status = "queued".into();
        if let Some(h) = durable.hold.as_mut() {
            match trigger {
                Trigger::Timer(_) => h.retried = true,
                Trigger::Owner => h.owner_try = true,
                Trigger::Settings => {}
            }
        }
        self.queues
            .entry(session.to_owned())
            .or_default()
            .push_front(item);
        if let Err(error) = persist(self) {
            self.ledger.insert(turn_id.to_owned(), before);
            if let Some(queue) = self.queues.get_mut(session) {
                queue.retain(|t| t.turn_id != turn_id);
                if queue.is_empty() {
                    self.queues.remove(session);
                }
            }
            return Err(error);
        }
        Ok(Released::Queued)
    }

    /// Stop or close: the held turn is cancelled (the caller saves).
    pub(super) fn cancel_held(&mut self, session: &str) -> Option<Queued> {
        let turn_id = self.held_turn(session)?.turn_id.clone();
        let durable = self.ledger.get_mut(&turn_id)?;
        durable.settle("cancelled", Some("Stopped while waiting for the plan limit. It was never sent."));
        durable.payload.clone()
    }

    /// The provider stopped a dispatched turn for its usage limit: mark the
    /// chat (once per turn). The ledger receipt is left exactly as it settles.
    pub(super) fn mark_usage_stopped(&mut self, session: &str, provider: &str, now: u64) -> Option<String> {
        let turn_id = self.turns.get(session).filter(|t| t.dispatched)?.id.clone();
        let record = self.records.iter_mut().find(|r| r.id == session)?;
        if record
            .usage_stopped
            .as_ref()
            .is_some_and(|v| v["turnId"] == turn_id.as_str())
        {
            return None;
        }
        record.usage_stopped = Some(json!({"turnId": turn_id, "provider": provider, "at": now}));
        Some(turn_id)
    }

    /// The owner's Continue for the chat's stopped turn, once that turn ended.
    pub(super) fn continue_item(&self, record: &Record, turn_id: &str) -> Result<Queued, Failure> {
        let stopped = record
            .usage_stopped
            .as_ref()
            .and_then(|v| v["turnId"].as_str());
        if stopped != Some(turn_id) {
            return Err(("NOT_STOPPED", "That turn is not the one stopped at the usage limit.".into()));
        }
        if self.ledger.get(turn_id).is_some_and(|t| !t.terminal()) {
            return Err(("SESSION_BUSY", "Wait for the stopped turn to finish before continuing.".into()));
        }
        Ok(continue_item(turn_id))
    }
}

// ------------------------------------------------------------ pure decisions

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PlanState {
    Allowed,
    Limited,
    /// Not reported: never treated as recovery.
    Unknown,
}

/// Limited on an explicit refusal or a reached type; Allowed only when the
/// backend says so (null means unavailable).
pub(super) fn codex_state(snapshot: &Value) -> PlanState {
    let reached = snapshot["rateLimits"]["rateLimitReachedType"]
        .as_str()
        .is_some_and(|t| !t.is_empty());
    match snapshot["ordinaryUsageAllowed"].as_bool() {
        Some(false) => PlanState::Limited,
        _ if reached => PlanState::Limited,
        Some(true) => PlanState::Allowed,
        None => PlanState::Unknown,
    }
}

/// The reset the one retry may wait for: every full window must report a
/// future reset within its own reported length; the latest of them counts.
pub(super) fn codex_retry_at(snapshot: &Value, now_secs: u64) -> Option<u64> {
    let full: Vec<&Value> = ["primary", "secondary"]
        .iter()
        .map(|w| &snapshot["rateLimits"][w])
        .filter(|w| w["usedPercent"].as_i64().is_some_and(|p| p >= 100))
        .collect();
    if full.is_empty() {
        return None;
    }
    full.iter()
        .map(|w| {
            let at = w["resetsAt"].as_u64()?;
            let window = w["windowDurationMins"]
                .as_u64()
                .filter(|m| *m > 0)?
                .saturating_mul(60);
            (at > now_secs && at <= now_secs + window + SKEW).then_some(at)
        })
        .collect::<Option<Vec<u64>>>()?
        .into_iter()
        .max()
}

/// Credits carry a turn past the limit only on explicit reports: credits left
/// and `spendControlReached: false`. Ok holds the reported balance, if any.
pub(super) fn codex_credit_check(snapshot: &Value, settings: Settings) -> Result<Option<String>, String> {
    if !settings.codex_credits {
        return Err("ChatGPT credits are off in Settings > Usage".into());
    }
    let limits = &snapshot["rateLimits"];
    let credits = &limits["credits"];
    if !credits.is_object() {
        return Err("Codex did not report ChatGPT credits, so none are used".into());
    }
    if credits["unlimited"] != true && credits["hasCredits"] != true {
        return Err(if credits["hasCredits"] == false {
            "no ChatGPT credits are left".into()
        } else {
            "Codex did not report whether ChatGPT credits are left, so none are used".into()
        });
    }
    match limits["spendControlReached"].as_bool() {
        Some(false) => Ok(credits["balance"].as_str().map(str::to_owned)),
        Some(true) => Err("the spend cap is reached in ChatGPT Settings > Usage".into()),
        None => Err("Codex did not report the spend-cap state, so credits are not used".into()),
    }
}

/// Claude's own clearing rule: a passed reset time means the limit is over.
fn claude_current(info: Option<&Value>, now_secs: u64) -> Option<&Value> {
    info.filter(|i| i["resetsAt"].as_u64().is_none_or(|at| at > now_secs))
}

pub(super) fn claude_overage(info: &Value) -> bool {
    info["isUsingOverage"] == true
        || info["overageInUse"] == true
        || (info["status"] == "rejected"
            && matches!(info["overageStatus"].as_str(), Some("allowed" | "allowed_warning")))
}

#[derive(Debug, PartialEq)]
pub(super) enum ClaudePlan {
    Plan,
    Credits,
    /// `bypass`: the owner's Try now may send anyway (nothing could be spent).
    Hold { reason: String, bypass: bool },
}

pub(super) fn claude_plan(info: Option<&Value>, settings: Settings, now_secs: u64) -> ClaudePlan {
    let Some(info) = claude_current(info, now_secs) else {
        return ClaudePlan::Plan;
    };
    if claude_overage(info) {
        return if settings.claude_credits {
            ClaudePlan::Credits
        } else {
            ClaudePlan::Hold { reason: "usage credits are off in Settings > Usage".into(), bypass: false }
        };
    }
    if info["status"] == "rejected" {
        return ClaudePlan::Hold {
            reason: "Claude reports no usage credits to continue on (claude.ai Settings > Usage)".into(),
            bypass: true,
        };
    }
    ClaudePlan::Plan
}

/// A Claude reset the one retry may wait for: in the future and within the
/// reported limit's window (five-hour or seven-day); anything else is unknown.
pub(super) fn claude_retry_at(info: Option<&Value>, now_secs: u64) -> Option<u64> {
    let info = info?;
    let at = info["resetsAt"].as_u64()?;
    let kind = info["rateLimitType"].as_str()?;
    let window = if kind.starts_with("five_hour") {
        5 * HOUR
    } else if kind.starts_with("seven_day") {
        WEEK
    } else {
        return None;
    };
    (at > now_secs && at <= now_secs + window + SKEW).then_some(at)
}

/// A turn's estimated credit share comes only from two reported totals. A
/// missing report leaves the share and the next base unknown (never zero).
pub(super) fn turn_share(previous: Option<u64>, total: Option<u64>) -> (Option<u64>, Option<u64>) {
    match (previous, total) {
        (Some(before), Some(now)) if now >= before => (Some(now), Some(now - before)),
        (_, total) => (total, None),
    }
}

/// Reset episodes are kept per account by a hash of accountId, never the id.
pub(super) fn account_hash(read: &Value) -> Option<String> {
    read["accountId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(|id| hex_digest(format!("codaclauda.codex-account/1\n{id}").as_bytes()))
}

// ------------------------------------------------------- reset episodes

/// One stretch at the plan limit for one account, shared by every session and
/// CodaClauda process through `usage-resets.json` in the app data folder.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResetEpisode {
    /// The idempotency key every consume attempt of this episode reuses.
    key: String,
    started_at: u64,
    /// The validated window reset when it started (unix seconds), if known.
    #[serde(default)]
    until: Option<u64>,
    /// reset | alreadyRedeemed | nothingToReset | noCredit | unrecognized.
    /// None while the reply is outstanding or was lost: only `key` is retried.
    #[serde(default)]
    outcome: Option<String>,
    #[serde(default)]
    settled_at: Option<u64>,
    /// A fresh read showed this account allowed again.
    #[serde(default)]
    closed_at: Option<u64>,
}

impl ResetEpisode {
    /// Still the same limit stretch: not closed, its window has not reset on
    /// its own, and the limited windows have not rolled over since it began.
    fn open(&self, now_secs: u64, fresh_until: Option<u64>) -> bool {
        if self.closed_at.is_some() {
            return false;
        }
        let horizon = self.until.unwrap_or(self.started_at / 1000 + WEEK) + HOUR;
        if now_secs > horizon {
            return false;
        }
        !matches!((self.until, fresh_until), (Some(until), Some(fresh)) if fresh > until + HOUR)
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct ResetBook {
    schema: String,
    accounts: BTreeMap<String, ResetEpisode>,
}

#[derive(Debug, PartialEq)]
pub(super) enum Step {
    Recovered,
    Skip(String),
    Consume(String),
}

impl ResetBook {
    fn empty() -> Self {
        Self { schema: RESETS_SCHEMA.into(), accounts: BTreeMap::new() }
    }

    /// Decided under the lock on a fresh read. The returned key is persisted
    /// with its episode before any consume call.
    pub(super) fn begin(&mut self, account: &str, snapshot: &Value, use_resets: bool, now: u64) -> Step {
        let now_secs = now / 1000;
        match codex_state(snapshot) {
            PlanState::Allowed => {
                self.close_if_recovered(account, snapshot, now);
                return Step::Recovered;
            }
            PlanState::Unknown => {
                return Step::Skip("Codex did not report whether ordinary use is allowed, so no reset is redeemed".into());
            }
            PlanState::Limited => {}
        }
        let fresh_until = codex_retry_at(snapshot, now_secs);
        if let Some(episode) = self.accounts.get(account).filter(|e| e.open(now_secs, fresh_until)) {
            return match episode.outcome.as_deref() {
                None if use_resets => Step::Consume(episode.key.clone()),
                None => Step::Skip("earned resets are off in Settings > Usage".into()),
                Some("reset" | "alreadyRedeemed") => Step::Skip("an earned reset was already redeemed for this limit".into()),
                Some("nothingToReset") => Step::Skip("Codex reported nothing to reset for this limit".into()),
                Some("noCredit") => Step::Skip("no earned reset credit is available".into()),
                Some(_) => Step::Skip("the earlier reset attempt had an unrecognized outcome".into()),
            };
        }
        if !use_resets {
            return Step::Skip("earned resets are off in Settings > Usage".into());
        }
        match snapshot["rateLimitResetCredits"]["availableCount"].as_i64() {
            None => return Step::Skip("Codex did not report how many earned resets are available".into()),
            Some(n) if n <= 0 => return Step::Skip("no earned reset credit is available".into()),
            Some(_) => {}
        }
        let episode = ResetEpisode { key: uuid_v4(), started_at: now, until: fresh_until, ..ResetEpisode::default() };
        let key = episode.key.clone();
        self.accounts.insert(account.to_owned(), episode);
        Step::Consume(key)
    }

    /// A lost reply (None) leaves the episode pending for a retry of its key.
    pub(super) fn settle(&mut self, account: &str, key: &str, outcome: Option<&str>, now: u64) {
        let Some(episode) = self.accounts.get_mut(account).filter(|e| e.key == key) else {
            return;
        };
        episode.outcome = outcome.map(|o| match o {
            "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit" => o.to_owned(),
            _ => "unrecognized".to_owned(),
        });
        if episode.outcome.is_some() {
            episode.settled_at = Some(now);
        }
    }

    pub(super) fn close_if_recovered(&mut self, account: &str, snapshot: &Value, now: u64) -> bool {
        if codex_state(snapshot) != PlanState::Allowed {
            return false;
        }
        match self.accounts.get_mut(account).filter(|e| e.closed_at.is_none()) {
            Some(episode) => {
                episode.closed_at = Some(now);
                true
            }
            None => false,
        }
    }
}

/// The app data folder's reset record and its lock file.
pub(super) struct Resets {
    dir: PathBuf,
}

/// Proof that the reset lock is held; released when dropped.
pub(super) struct ResetLock {
    _file: File,
}

impl Resets {
    pub(super) fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Blocking: waits until every other session and process released it.
    fn lock(&self, wait: Duration) -> Result<ResetLock, String> {
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| format!("CodaClauda's app data folder is unavailable ({e})"))?;
        let file = lease_file(&self.dir.join(RESETS_LOCK))?;
        let deadline = Instant::now() + wait;
        loop {
            if FileExt::try_lock_exclusive(&file).is_ok() {
                return Ok(ResetLock { _file: file });
            }
            if Instant::now() >= deadline {
                return Err("another CodaClauda chat is still redeeming a reset".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn load(&self, _held: &ResetLock) -> Result<ResetBook, String> {
        match super::schedule::read_json(&self.dir.join(RESETS_FILE), FILE_LIMIT)? {
            None => Ok(ResetBook::empty()),
            Some(value) if value["schema"] == RESETS_SCHEMA => serde_json::from_value(value)
                .map_err(|_| "the saved reset record is invalid (its bytes were preserved)".to_owned()),
            Some(_) => Err("the saved reset record has an unsupported schema (its bytes were preserved)".into()),
        }
    }

    fn save(&self, _held: &ResetLock, book: &ResetBook) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(book).map_err(|e| e.to_string())?;
        write_atomic(&self.dir.join(RESETS_FILE), &bytes).map_err(|e| e.to_string())
    }
}

#[derive(Debug, PartialEq)]
pub(super) enum Redeem {
    /// A fresh read shows this account allowed again; nothing was redeemed now.
    NotNeeded,
    /// `reset`, or `alreadyRedeemed` (this episode's key completed earlier).
    Redeemed { outcome: String },
    Skipped(String),
}

/// One reset step under the shared lock: fresh read → decide → persist the
/// episode and key → consume → persist the outcome → re-read. `read` returns
/// a fresh snapshot and its account hash; `consume` sends one idempotency key.
pub(super) async fn redeem_with<R, RF, C, CF>(
    resets: &Resets,
    use_resets: bool,
    mut read: R,
    mut consume: C,
) -> Redeem
where
    R: FnMut() -> RF,
    RF: Future<Output = Option<(Value, Option<String>)>>,
    C: FnMut(String) -> CF,
    CF: Future<Output = Result<Value, String>>,
{
    let locker = Resets::new(resets.dir.clone());
    let held = match tokio::task::spawn_blocking(move || locker.lock(LOCK_WAIT)).await {
        Ok(Ok(held)) => held,
        Ok(Err(why)) => return Redeem::Skipped(why),
        Err(_) => return Redeem::Skipped("the reset lock could not be taken".into()),
    };
    let Some((snapshot, account)) = read().await else {
        return Redeem::Skipped("Codex did not answer its usage read".into());
    };
    let Some(account) = account else {
        return Redeem::Skipped("Codex did not report which account it uses, so a reset could not be kept to one per account".into());
    };
    let mut book = match resets.load(&held) {
        Ok(book) => book,
        Err(why) => return Redeem::Skipped(why),
    };
    let key = match book.begin(&account, &snapshot, use_resets, now_ms()) {
        Step::Recovered => {
            let _ = resets.save(&held, &book);
            return Redeem::NotNeeded;
        }
        Step::Skip(why) => return Redeem::Skipped(why),
        Step::Consume(key) => key,
    };
    if let Err(why) = resets.save(&held, &book) {
        return Redeem::Skipped(format!("the reset could not be recorded before redeeming it ({why})"));
    }
    let reply = consume(key.clone()).await;
    let outcome = reply
        .as_ref()
        .ok()
        .and_then(|v| v["outcome"].as_str())
        .map(str::to_owned);
    book.settle(&account, &key, outcome.as_deref(), now_ms());
    // An unsaved outcome stays pending, so the next attempt retries the same key.
    let _ = resets.save(&held, &book);
    // Re-read after every outcome, including a lost reply.
    if let Some((fresh, Some(same))) = read().await {
        if same == account && book.close_if_recovered(&account, &fresh, now_ms()) {
            let _ = resets.save(&held, &book);
        }
    }
    drop(held);
    match outcome.as_deref() {
        Some(done @ ("reset" | "alreadyRedeemed")) => Redeem::Redeemed { outcome: done.to_owned() },
        Some("nothingToReset") => Redeem::Skipped("Codex reported nothing to reset".into()),
        Some("noCredit") => Redeem::Skipped("no earned reset credit is available".into()),
        Some(_) => Redeem::Skipped("Codex returned an unrecognized reset outcome".into()),
        None => Redeem::Skipped(format!(
            "the reset reply was lost ({}); only the same attempt is retried, never a second reset",
            reply.err().unwrap_or_else(|| "no outcome".into())
        )),
    }
}

// ------------------------------------------------------------------ book

#[derive(Default)]
pub(crate) struct Book {
    settings: Settings,
    /// usage.json could not be read: credits and resets stay off (fail closed).
    failure: Option<String>,
    /// The last read, without its accountId.
    codex: Option<Value>,
    codex_at: Option<u64>,
    /// Hash of the accountId the snapshot describes.
    codex_account: Option<String>,
    claude: Option<Value>,
    claude_at: Option<u64>,
    /// "Continuing on credits" is said once per limit stretch.
    codex_noticed: bool,
    claude_noticed: bool,
}

impl Book {
    fn effective(&self) -> Settings {
        if self.failure.is_some() { Settings::OFF } else { self.settings }
    }

    pub(super) fn set_codex(&mut self, mut read: Value) {
        if !read["rateLimits"].is_object() {
            return;
        }
        let account = account_hash(&read);
        if let Some(fields) = read.as_object_mut() {
            fields.remove("accountId");
        }
        // Another account (or one no longer reported) inherits nothing.
        if account != self.codex_account || codex_state(&read) == PlanState::Allowed {
            self.codex_noticed = false;
        }
        self.codex_account = account;
        self.codex = Some(read);
        self.codex_at = Some(now_ms());
    }

    /// The notification is sparse: only non-null values replace saved ones.
    pub(super) fn merge_codex(&mut self, update: &Value) {
        let Some(fields) = update.as_object() else { return };
        let snapshot = self.codex.get_or_insert_with(|| json!({"rateLimits": {}}));
        if !snapshot["rateLimits"].is_object() {
            snapshot["rateLimits"] = json!({});
        }
        for (key, value) in fields.iter().filter(|(_, v)| !v.is_null()) {
            snapshot["rateLimits"][key] = value.clone();
        }
        self.codex_at = Some(now_ms());
    }

    /// The Codex sign-in changed: the old snapshot describes another account.
    pub(super) fn forget_codex(&mut self) {
        self.codex = None;
        self.codex_at = None;
        self.codex_account = None;
        self.codex_noticed = false;
    }

    pub(super) fn set_claude(&mut self, info: &Value) {
        if info.is_object() {
            if !claude_overage(info) {
                self.claude_noticed = false;
            }
            self.claude = Some(info.clone());
            self.claude_at = Some(now_ms());
        }
    }
}

/// What a provider line says about usage.
#[derive(Debug, PartialEq)]
pub(super) enum Signal {
    CodexRateLimits(Value),
    CodexAccountChanged,
    CodexTurnDone,
    ClaudeRateLimit(Value),
    /// The provider refused or ended the turn for its usage limit.
    UsageLimit,
}

fn claude_limit_text(text: &str) -> bool {
    let t = text.to_lowercase();
    (t.contains("hit your") && t.contains("limit"))
        || t.contains("usage limit reached")
        || t.contains("out of usage credits")
}

/// Conservative: only the providers' structured usage-limit markers (Codex
/// `codexErrorInfo: usageLimitExceeded`; Claude `error: rate_limit` with its
/// usage-limit wording or `api_error: usage_limit_reached`, and an error result
/// with that wording). Transient rate limiting is not a usage limit.
pub(super) fn observe(provider: Provider, line: &Value) -> Vec<Signal> {
    let mut out = Vec::new();
    match provider {
        Provider::Codex => {
            let params = &line["params"];
            let usage_limit = |error: &Value| error["codexErrorInfo"] == "usageLimitExceeded";
            match line["method"].as_str() {
                Some("account/rateLimits/updated") if params["rateLimits"].is_object() => {
                    out.push(Signal::CodexRateLimits(params["rateLimits"].clone()));
                }
                Some("account/updated" | "account/login/completed") => out.push(Signal::CodexAccountChanged),
                Some("turn/completed") => {
                    if usage_limit(&params["turn"]["error"]) {
                        out.push(Signal::UsageLimit);
                    }
                    out.push(Signal::CodexTurnDone);
                }
                Some("error") if params["willRetry"] != true && usage_limit(&params["error"]) => {
                    out.push(Signal::UsageLimit);
                }
                _ => {}
            }
        }
        Provider::Claude => match line["type"].as_str() {
            Some("rate_limit_event") if line["rate_limit_info"].is_object() => {
                out.push(Signal::ClaudeRateLimit(line["rate_limit_info"].clone()));
            }
            Some("assistant") if line["error"] == "rate_limit" => {
                let text: String = line["message"]["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|b| b["text"].as_str())
                    .collect();
                if line["api_error"] == "usage_limit_reached" || claude_limit_text(&text) {
                    out.push(Signal::UsageLimit);
                }
                if line["api_error_params"]["rate_limit_info"].is_object() {
                    out.push(Signal::ClaudeRateLimit(line["api_error_params"]["rate_limit_info"].clone()));
                }
            }
            Some("result") if line["is_error"] == true => {
                if line["result"].as_str().is_some_and(claude_limit_text) {
                    out.push(Signal::UsageLimit);
                }
            }
            _ => {}
        },
    }
    out
}

/// A local time like "Tue 21 Oct 14:05" for a unix-seconds reset.
pub(super) fn when(secs: u64) -> String {
    chrono::DateTime::from_timestamp(secs as i64, 0)
        .map(|t| t.with_timezone(&chrono::Local).format("%a %-d %b %H:%M").to_string())
        .unwrap_or_else(|| "the reset".into())
}

fn read_settings(path: &std::path::Path) -> Result<Settings, String> {
    match super::schedule::read_json(path, FILE_LIMIT)? {
        None => Ok(Settings::default()),
        Some(value) => parse_settings(&value),
    }
}

// ------------------------------------------------------------- the host side

async fn soft_rpc(proc: &Arc<Proc>, method: &str, params: Value) -> Result<Value, String> {
    let (call, receiver) = begin_rpc(proc, method, params)?;
    match tokio::time::timeout(SOFT_WAIT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(format!("Codex stopped before answering {method}.")),
        Err(_) => {
            lock(&proc.pending).remove(&call);
            Err(format!("Codex did not answer {method} in time."))
        }
    }
}

fn sleep_until_ms(at_ms: u64) -> tokio::time::Sleep {
    tokio::time::sleep(Duration::from_millis(at_ms.saturating_sub(now_ms())))
}

impl Inner {
    pub(super) fn load_usage(&self) {
        let mut book = lock(&self.usage);
        match read_settings(&self.dir.join(USAGE_FILE)) {
            Ok(settings) => {
                book.settings = settings;
                book.failure = None;
            }
            Err(message) => {
                book.failure = Some(format!("{message} Credits and resets stay off until you save Settings > Usage."));
            }
        }
    }

    fn usage_settings(&self) -> Value {
        let book = lock(&self.usage);
        let mut value = book.effective().to_json();
        value["error"] = json!(book.failure);
        value
    }

    fn usage_settings_set(self: &Arc<Self>, provider: &str, credits: Option<bool>, resets: Option<bool>) -> Result<Value, Failure> {
        let mut book = lock(&self.usage);
        let before = book.effective();
        let mut next = before;
        match provider {
            "codex" => {
                next.codex_credits = credits.unwrap_or(next.codex_credits);
                next.codex_resets = resets.unwrap_or(next.codex_resets);
            }
            "claude" if resets.is_some() => {
                return Err(("INVALID_ARGUMENTS", "Claude has no earned reset credits.".into()));
            }
            "claude" => next.claude_credits = credits.unwrap_or(next.claude_credits),
            _ => return Err(("INVALID_ARGUMENTS", "provider must be claude or codex.".into())),
        }
        ensure_dirs(&self.dir)
            .and_then(|_| write_atomic(&self.dir.join(USAGE_FILE), &serde_json::to_vec_pretty(&next.to_json()).unwrap_or_default()))
            .map_err(|e| ("STORAGE_FAILED", format!("Could not save usage.json: {e}")))?;
        book.settings = next;
        book.failure = None;
        drop(book);
        // A setting the owner turned on may release turns held for it.
        let enabled = (next.codex_credits && !before.codex_credits)
            || (next.codex_resets && !before.codex_resets)
            || (next.claude_credits && !before.claude_credits);
        if enabled {
            self.recheck_held(provider);
        }
        Ok(self.usage_settings())
    }

    fn usage_status(&self, provider: &str) -> Result<Value, Failure> {
        let book = lock(&self.usage);
        let now = now_ms() / 1000;
        match provider {
            "codex" => {
                let state = book.codex.as_ref().map_or(PlanState::Unknown, codex_state);
                Ok(json!({
                    "provider": "codex", "snapshot": book.codex, "at": book.codex_at,
                    "state": match state { PlanState::Allowed => "allowed", PlanState::Limited => "limited", PlanState::Unknown => "unknown" },
                    "limited": state == PlanState::Limited,
                    "resetsAt": book.codex.as_ref().and_then(|s| codex_retry_at(s, now)),
                    "resetCredits": book.codex.as_ref().and_then(|s| s["rateLimitResetCredits"]["availableCount"].as_i64()),
                    "accountReported": book.codex_account.is_some(),
                }))
            }
            "claude" => Ok(json!({
                "provider": "claude", "snapshot": book.claude, "at": book.claude_at,
                "limited": claude_current(book.claude.as_ref(), now).is_some_and(|i| i["status"] == "rejected"),
                "overage": claude_current(book.claude.as_ref(), now).is_some_and(claude_overage),
                "resetsAt": claude_retry_at(book.claude.as_ref(), now),
                "resets": "unsupported",
            })),
            _ => Err(("INVALID_ARGUMENTS", "provider must be claude or codex.".into())),
        }
    }

    /// A saved chat line about usage (rendered in the transcript).
    fn usage_notice(&self, id: &str, turn: Option<&str>, text: &str, tone: &str, extra: Value) {
        let mut data = json!({"text": text, "tone": tone});
        if let (Some(target), Value::Object(fields)) = (data.as_object_mut(), extra) {
            target.extend(fields);
        }
        self.publish(event(id, turn, "notice", data), true);
    }

    /// Where this chat's turns are billed when not plainly the plan: "credits"
    /// (ChatGPT), "usage-credits" (Claude), "reset" (after an earned reset)
    /// or "unknown" (Codex did not report the limit state).
    fn set_billing(&self, id: &str, billing: Option<&str>) {
        let changed = lock(&self.state).records.iter().any(|r| r.id == id && r.billing.as_deref() != billing);
        if !changed {
            return;
        }
        if let Ok(Some((usage, last))) = self.with_record(id, |r| {
            r.billing = billing.map(str::to_owned);
            (r.usage, r.last_turn_credits.clone())
        }) {
            self.publish(event(id, None, "usage", json!({"usage": usage, "billing": billing, "lastTurnCredits": last})), false);
        }
    }

    /// The chat's held turn and usage-limit stop, for the UI.
    pub(super) fn publish_usage_state(&self, id: &str) {
        let now = now_ms() / 1000;
        let data = {
            let state = lock(&self.state);
            let Some(record) = state.records.iter().find(|r| r.id == id) else { return };
            let held = state
                .held_turn(id)
                .and_then(|t| t.hold.as_ref().map(|h| held_view(&t.turn_id, h, now)));
            json!({"usage": record.usage, "held": held, "usageStopped": record.usage_stopped})
        };
        self.publish(event(id, None, "usage", data), false);
    }

    pub(super) async fn read_codex_limits(&self, proc: &Arc<Proc>) {
        if let Ok(read) = soft_rpc(proc, "account/rateLimits/read", json!({"excludeResetCreditDetails": true})).await {
            lock(&self.usage).set_codex(read);
        }
    }

    fn resets(&self) -> Option<Resets> {
        self.app.path().app_data_dir().ok().map(Resets::new)
    }

    async fn redeem_reset(&self, proc: &Arc<Proc>, use_resets: bool) -> Redeem {
        let Some(resets) = self.resets() else {
            return Redeem::Skipped("CodaClauda's app data folder is unavailable, so no reset is redeemed".into());
        };
        let inner: &Inner = self;
        redeem_with(
            &resets,
            use_resets,
            || {
                let proc = proc.clone();
                async move {
                    inner.read_codex_limits(&proc).await;
                    let fresh = {
                        let book = lock(&inner.usage);
                        book.codex.clone().map(|s| (s, book.codex_account.clone()))
                    };
                    fresh
                }
            },
            |key| {
                let proc = proc.clone();
                async move {
                    soft_rpc(&proc, "account/rateLimitResetCredit/consume", json!({"idempotencyKey": key})).await
                }
            },
        )
        .await
    }

    /// Before a Codex turn is sent (nothing has reached the provider yet).
    pub(super) async fn codex_usage_gate(self: &Arc<Self>, id: &str, proc: &Arc<Proc>, turn_id: &str) -> Gate {
        let stale = {
            let book = lock(&self.usage);
            book.codex.as_ref().is_none_or(|s| codex_state(s) != PlanState::Allowed)
                && book.codex_at.is_none_or(|at| now_ms().saturating_sub(at) > FRESH_MS)
        };
        if stale {
            self.read_codex_limits(proc).await; // never decide on a stale or missing "limited"
        }
        if !self.turn_active(id, turn_id) {
            return Gate::Stopped;
        }
        let (snapshot, settings) = {
            let book = lock(&self.usage);
            (book.codex.clone(), book.effective())
        };
        let state = snapshot.as_ref().map_or(PlanState::Unknown, codex_state);
        if state != PlanState::Limited {
            // Unknown is sent on the plan (the provider decides) but never shown as known.
            self.set_billing(id, (state == PlanState::Unknown).then_some("unknown"));
            return Gate::Send;
        }
        let mut redeemed = None;
        let mut reset_why = None;
        if settings.codex_resets {
            match self.redeem_reset(proc, true).await {
                Redeem::NotNeeded => {}
                Redeem::Redeemed { outcome } => redeemed = Some(outcome),
                Redeem::Skipped(why) => reset_why = Some(why),
            }
            if !self.turn_active(id, turn_id) {
                return Gate::Stopped;
            }
        }
        let snapshot = lock(&self.usage).codex.clone().unwrap_or(Value::Null);
        if let Some(outcome) = &redeemed {
            let left = snapshot["rateLimitResetCredits"]["availableCount"].as_i64();
            let text = match (outcome.as_str(), left) {
                ("reset", Some(n)) => format!("Redeemed one earned Codex reset credit ({n} left, as Codex reports)."),
                ("reset", None) => "Redeemed one earned Codex reset credit.".to_owned(),
                _ => "An earned reset credit redeemed earlier for this limit applies; no second one was used.".to_owned(),
            };
            self.usage_notice(id, Some(turn_id), &text, "info", json!({"billing": "reset"}));
        }
        if codex_state(&snapshot) != PlanState::Limited {
            self.set_billing(id, redeemed.as_ref().map(|_| "reset"));
            return Gate::Send;
        }
        match codex_credit_check(&snapshot, settings) {
            Ok(balance) => {
                let first = !std::mem::replace(&mut lock(&self.usage).codex_noticed, true);
                if first {
                    let text = format!(
                        "Codex's plan limit is reached; this chat continues on ChatGPT credits (balance {}, in ChatGPT's credit units, not money).",
                        balance.as_deref().unwrap_or("not reported")
                    );
                    self.usage_notice(id, Some(turn_id), &text, "info", json!({"billing": "credits"}));
                }
                self.set_billing(id, Some("credits"));
                Gate::Send
            }
            Err(credit_why) => {
                let reason = match reset_why {
                    Some(why) => format!("{why}, and {credit_why}"),
                    None => credit_why,
                };
                Gate::Hold(Hold {
                    provider: "codex".into(),
                    reason,
                    retry_at: codex_retry_at(&snapshot, now_ms() / 1000),
                    at: now_ms(),
                    ..Hold::default()
                })
            }
        }
    }

    /// Before a Claude turn starts its process (snapshot only, no request).
    pub(super) fn claude_usage_gate(&self, id: &str, turn_id: &str) -> Gate {
        if !self.turn_active(id, turn_id) {
            return Gate::Stopped;
        }
        let now = now_ms() / 1000;
        let owner_try = lock(&self.state)
            .ledger
            .get(turn_id)
            .and_then(|t| t.hold.as_ref())
            .is_some_and(|h| h.owner_try);
        let (plan, info) = {
            let book = lock(&self.usage);
            (claude_plan(book.claude.as_ref(), book.effective(), now), book.claude.clone())
        };
        match plan {
            ClaudePlan::Plan => {
                self.set_billing(id, None);
                Gate::Send
            }
            // The owner chose to try anyway; Claude decides, and nothing is spent.
            ClaudePlan::Hold { bypass: true, .. } if owner_try => {
                self.set_billing(id, None);
                Gate::Send
            }
            ClaudePlan::Credits => {
                let first = !std::mem::replace(&mut lock(&self.usage).claude_noticed, true);
                if first {
                    self.usage_notice(id, Some(turn_id), "Claude's plan limit is reached; this chat continues on usage credits.", "info", json!({"billing": "usage-credits", "link": CLAUDE_USAGE_URL}));
                }
                self.set_billing(id, Some("usage-credits"));
                Gate::Send
            }
            ClaudePlan::Hold { reason, .. } => Gate::Hold(Hold {
                provider: "claude".into(),
                reason,
                retry_at: claude_retry_at(info.as_ref(), now),
                at: now_ms(),
                ..Hold::default()
            }),
        }
    }

    /// The gate held the current turn: it leaves the session (nothing was
    /// sent) and waits in the ledger. A timed schedule run is not held for
    /// days; it is reported as not sent and its schedule runs again.
    pub(super) fn hold_turn(self: &Arc<Self>, id: &str, turn_id: &str, proc: Option<&Arc<Proc>>, hold: Hold) -> Result<(), String> {
        let _lifecycle = lock(&self.lifecycle);
        let timed_run = lock(&self.state)
            .turns
            .get(id)
            .is_some_and(|t| t.id == turn_id && t.origin["kind"] == "schedule" && t.origin["trigger"] != "manual");
        if timed_run {
            return Err(format!("{}'s plan limit is reached and {}. This scheduled run was not sent.", provider_label(&hold.provider), hold.reason));
        }
        let held = {
            let mut state = lock(&self.state);
            state.hold_turn(id, turn_id, hold, |s| self.save(s))?
        };
        let Some(hold) = held else {
            return Ok(()); // stopped, closed or dispatched meanwhile: that path wins
        };
        if let Some(proc) = proc {
            lock(&proc.runtime_lease).take();
        }
        let now = now_ms() / 1000;
        let mut extra = json!({"hold": held_view(turn_id, &hold, now)});
        if hold.provider == "claude" {
            extra["link"] = json!(CLAUDE_USAGE_URL);
        }
        self.publish(event(id, None, "status", json!({"status": "idle"})), false);
        self.usage_notice(id, Some(turn_id), &held_text(&hold, now), "warn", extra);
        self.publish_usage_state(id);
        self.arm_hold(id, turn_id, &hold);
        Ok(())
    }

    /// The one automatic retry, at a validated reset; armed once per turn and time.
    fn arm_hold(self: &Arc<Self>, id: &str, turn_id: &str, hold: &Hold) {
        let Some(at) = hold.due(now_ms() / 1000) else { return };
        let token = format!("{turn_id}@{at}");
        if !lock(&self.usage_timers).insert(token.clone()) {
            return;
        }
        let (inner, id, turn_id) = (self.clone(), id.to_owned(), turn_id.to_owned());
        tauri::async_runtime::spawn(async move {
            let due = at.saturating_mul(1000) + RESET_MARGIN_MS;
            while now_ms() < due {
                sleep_until_ms(due).await;
            }
            lock(&inner.usage_timers).remove(&token);
            // Admission takes lifecycle; it runs off the async workers.
            let _ = tauri::async_runtime::spawn_blocking(move || {
                if let Err((_, message)) = inner.release_held(&id, &turn_id, Trigger::Timer(at)) {
                    inner.usage_notice(&id, Some(&turn_id), &format!("The held turn was not sent at the reset: {message}"), "warn", json!({}));
                }
            })
            .await;
        });
    }

    /// After a restart: held turns stay held, and a still-valid reset re-arms
    /// its one retry (a reset that passed while closed waits for Try now).
    pub(super) fn restore_holds(self: &Arc<Self>) {
        let held: Vec<(String, String, Hold)> = lock(&self.state)
            .ledger
            .values()
            .filter(|t| t.status == "held")
            .filter_map(|t| Some((t.session_id.clone(), t.turn_id.clone(), t.hold.clone()?)))
            .collect();
        for (id, turn_id, hold) in held {
            self.arm_hold(&id, &turn_id, &hold);
        }
    }

    /// Dispatches a held turn through normal admission and then the gate again.
    pub(super) fn release_held(self: &Arc<Self>, id: &str, turn_id: &str, trigger: Trigger) -> Result<Value, Failure> {
        let _lifecycle = lock(&self.lifecycle);
        if let Some(message) = lock(&self.storage_failure).clone() {
            return Err(("STORAGE_FAILED", message));
        }
        let released = {
            let mut state = lock(&self.state);
            state.take_held(
                id,
                turn_id,
                trigger,
                |s, record, item| {
                    self.check_admission(s, record)?;
                    self.validate_origin(record, &item.origin)
                },
                |s| self.save(s),
            )
        }
        .map_err(|message| ("STORAGE_FAILED", message))?;
        match released {
            Released::NotHeld => Ok(json!({"released": false})),
            Released::Refused(item, failure) => {
                let _ = self.write_settlement(&item.turn_id, true);
                if item.origin["kind"] == "schedule" {
                    self.schedule_finished(&item.origin, &item.turn_id, "failed", Some(failure.1.as_str()));
                }
                self.publish_usage_state(id);
                self.queue_next(id);
                Err(failure)
            }
            Released::Queued => {
                self.publish_usage_state(id);
                let (outcome, waiting) = self.admit_queued(id, None);
                self.publish_queued(id, waiting);
                outcome?;
                Ok(json!({"released": true, "turnId": turn_id}))
            }
        }
    }

    fn recheck_held(self: &Arc<Self>, provider: &str) {
        let held: Vec<(String, String)> = {
            let state = lock(&self.state);
            state
                .ledger
                .values()
                .filter(|t| t.status == "held")
                .filter(|t| state.records.iter().any(|r| r.id == t.session_id && r.provider == provider))
                .map(|t| (t.session_id.clone(), t.turn_id.clone()))
                .collect()
        };
        for (id, turn_id) in held {
            let _ = self.release_held(&id, &turn_id, Trigger::Settings);
        }
    }

    /// After Stop or close cancelled a held turn: its receipt, then the queue.
    pub(super) fn held_cancelled(&self, id: &str, item: &Queued, next: bool) {
        let _ = self.write_settlement(&item.turn_id, true);
        if item.origin["kind"] == "schedule" {
            self.schedule_finished(&item.origin, &item.turn_id, "cancelled", None);
        }
        self.publish_usage_state(id);
        if next {
            self.queue_next(id);
        }
    }

    fn retry_held(self: &Arc<Self>, id: &str) -> Result<Value, Failure> {
        let turn_id = lock(&self.state)
            .held_turn(id)
            .map(|t| t.turn_id.clone())
            .ok_or(("NOT_HELD", "This chat has no held turn.".to_owned()))?;
        self.release_held(id, &turn_id, Trigger::Owner)
    }

    fn continue_turn(self: &Arc<Self>, id: &str, turn_id: &str) -> Result<Value, Failure> {
        let item = {
            let state = lock(&self.state);
            let record = state
                .records
                .iter()
                .find(|r| r.id == id)
                .ok_or(("SESSION_NOT_FOUND", "That chat no longer exists.".to_owned()))?;
            state.continue_item(record, turn_id)?
        };
        self.submit(id, item)
    }

    /// The owner moved on from a turn stopped at the usage limit.
    pub(super) fn clear_usage_stopped(&self, id: &str) {
        let marked = lock(&self.state)
            .records
            .iter()
            .any(|r| r.id == id && r.usage_stopped.is_some());
        if marked && self.with_record(id, |r| r.usage_stopped = None).is_ok() {
            self.publish_usage_state(id);
        }
    }

    /// Called for every provider line before it is parsed.
    pub(super) fn usage_signal(self: &Arc<Self>, id: &str, proc: &Arc<Proc>, signal: Signal) {
        let current = || lock(&self.state).live.get(id).is_some_and(|l| l.proc.generation == proc.generation);
        match signal {
            Signal::CodexRateLimits(update) => lock(&self.usage).merge_codex(&update),
            Signal::CodexAccountChanged => lock(&self.usage).forget_codex(),
            Signal::ClaudeRateLimit(info) => {
                let overage = claude_overage(&info) && claude_current(Some(&info), now_ms() / 1000).is_some();
                let first = {
                    let mut book = lock(&self.usage);
                    book.set_claude(&info);
                    overage && !std::mem::replace(&mut book.claude_noticed, true)
                };
                if !current() {
                    return;
                }
                self.set_billing(id, overage.then_some("usage-credits"));
                if first {
                    let turn = self.current_turn(id).map(|t| t.0);
                    self.usage_notice(id, turn.as_deref(), "Claude is on usage credits: its plan limit is reached.", "info", json!({"billing": "usage-credits"}));
                }
            }
            Signal::CodexTurnDone if current() => self.codex_turn_credits(id, proc),
            Signal::UsageLimit if current() => self.usage_limited(id, proc),
            _ => {}
        }
    }

    /// The estimated credit share of the turn that just ended (`account/usage/read`).
    fn codex_turn_credits(self: &Arc<Self>, id: &str, proc: &Arc<Proc>) {
        let turn = self.current_turn(id).map(|t| t.0);
        let Some(thread) = lock(&self.state).records.iter().find(|r| r.id == id).and_then(|r| r.thread_id.clone()) else {
            return;
        };
        let (inner, proc, id) = (self.clone(), proc.clone(), id.to_owned());
        tauri::async_runtime::spawn(async move {
            let total = soft_rpc(&proc, "account/usage/read", json!({"threadId": thread}))
                .await
                .ok()
                .and_then(|read| read["threadUsage"]["estimatedUsageCreditsMicros"].as_u64());
            let saved = inner.with_record(&id, |r| {
                let (base, share) = turn_share(r.credits_micros, total);
                r.credits_micros = base;
                r.last_turn_credits = Some(json!({"turnId": turn, "micros": share, "at": now_ms(), "estimate": true}));
                (r.usage, r.last_turn_credits.clone(), r.billing.clone())
            });
            if let Ok(Some((usage, last, billing))) = saved {
                inner.publish(event(&id, None, "usage", json!({"usage": usage, "lastTurnCredits": last, "billing": billing})), false);
            }
        });
    }

    /// The provider refused or ended a turn that was already sent: part of it
    /// may have run, so it is never sent again. The chat is marked stopped at
    /// the usage limit and the owner decides whether to Continue.
    fn usage_limited(self: &Arc<Self>, id: &str, proc: &Arc<Proc>) {
        let marked = {
            let mut state = lock(&self.state);
            let marked = state.mark_usage_stopped(id, proc.provider.name(), now_ms());
            if marked.is_some() {
                let _ = self.save(&state);
            }
            marked
        };
        let Some(turn_id) = marked else { return };
        self.publish_usage_state(id);
        let (inner, proc, id) = (self.clone(), proc.clone(), id.to_owned());
        tauri::async_runtime::spawn(async move {
            let provider = proc.provider;
            let now = now_ms() / 1000;
            let resets_at = match provider {
                Provider::Codex => {
                    inner.read_codex_limits(&proc).await;
                    lock(&inner.usage).codex.as_ref().and_then(|s| codex_retry_at(s, now))
                }
                Provider::Claude => claude_retry_at(lock(&inner.usage).claude.as_ref(), now),
            };
            let mut extra = json!({"stopped": {"turnId": turn_id}, "limit": {"resetsAt": resets_at.map(|s| s.saturating_mul(1000))}});
            if provider == Provider::Claude {
                extra["link"] = json!(CLAUDE_USAGE_URL);
            }
            inner.usage_notice(&id, Some(&turn_id), &stopped_text(provider, resets_at), "warn", extra);
        });
    }
}

// ----------------------------------------------------------------- commands

#[tauri::command]
pub(crate) async fn usage_settings_get(app: tauri::AppHandle) -> Value {
    reply(Ok(host(&app).usage_settings()))
}

#[tauri::command]
pub(crate) async fn usage_settings_set(
    app: tauri::AppHandle,
    provider: String,
    use_credits: Option<bool>,
    use_resets: Option<bool>,
) -> Value {
    reply(host(&app).usage_settings_set(&provider, use_credits, use_resets))
}

#[tauri::command]
pub(crate) async fn usage_status(app: tauri::AppHandle, provider: String) -> Value {
    reply(host(&app).usage_status(&provider))
}

/// The owner's Continue after a turn stopped at the usage limit: a new turn
/// that names the original (never a replay of it).
#[tauri::command]
pub(crate) async fn session_continue(app: tauri::AppHandle, id: String, turn_id: String) -> Value {
    reply(host(&app).continue_turn(&id, &turn_id))
}

/// The owner's Try now for a held turn: normal admission, then a fresh gate.
#[tauri::command]
pub(crate) async fn session_retry_held(app: tauri::AppHandle, id: String) -> Value {
    reply(host(&app).retry_held(&id))
}

#[cfg(test)]
mod tests {
    use super::super::{REGISTRY_FILE, Turn, owner_equivalent_origin, read_snapshot, runtime_lease, save_snapshot};
    use super::*;
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    const NOW: u64 = 1_792_800_000; // unix seconds, inside the recorded windows

    /// Recorded shape of `account/rateLimits/read` (codex 0.163.0-alpha.10.2)
    /// after the weekly plan limit, with credits left and two earned resets.
    fn limited_read() -> Value {
        json!({
            "accountId": "acct-owner-a",
            "ordinaryUsageAllowed": false,
            "rateLimits": {
                "limitId": "codex", "limitName": null, "planType": "plus",
                "primary": {"usedPercent": 41, "windowDurationMins": 300, "resetsAt": 1792803600},
                "secondary": {"usedPercent": 100, "windowDurationMins": 10080, "resetsAt": 1792832400},
                "credits": {"hasCredits": true, "unlimited": false, "balance": "11.86"},
                "spendControlReached": false,
                "rateLimitReachedType": "rate_limit_reached"
            },
            "rateLimitResetCredits": {"availableCount": 2, "credits": null}
        })
    }

    fn allowed_read() -> Value {
        let mut read = limited_read();
        read["ordinaryUsageAllowed"] = json!(true);
        read["rateLimits"]["rateLimitReachedType"] = Value::Null;
        read["rateLimits"]["secondary"]["usedPercent"] = json!(3);
        read
    }

    #[test]
    fn usage_settings_default_on_and_refuse_non_booleans() {
        assert_eq!(parse_settings(&json!({})).unwrap(), Settings::default());
        let off = parse_settings(&json!({"codex": {"useCredits": false}, "claude": {"useCredits": false}})).unwrap();
        assert!(!off.codex_credits && off.codex_resets && !off.claude_credits);
        assert!(parse_settings(&json!({"codex": {"useResets": "yes"}})).is_err());
        assert!(parse_settings(&json!([])).is_err());
        let back = parse_settings(&off.to_json()).unwrap();
        assert_eq!(back, off);
        let failed = Book { failure: Some("unreadable".into()), ..Book::default() };
        assert_eq!(failed.effective(), Settings::OFF, "an unreadable file never spends");
    }

    #[test]
    fn usage_unknown_fields_stay_unknown() {
        let all = Settings::default();
        let read = limited_read();
        assert_eq!(codex_state(&read), PlanState::Limited);
        assert_eq!(codex_credit_check(&read, all), Ok(Some("11.86".into())));
        // ordinaryUsageAllowed absent: unknown, never recovery.
        let mut sparse = allowed_read();
        sparse.as_object_mut().unwrap().remove("ordinaryUsageAllowed");
        assert_eq!(codex_state(&sparse), PlanState::Unknown);
        // Absent credits, hasCredits or spendControlReached never permit spending.
        for (path, value) in [("credits", Value::Null), ("spendControlReached", Value::Null)] {
            let mut r = read.clone();
            r["rateLimits"][path] = value;
            let why = codex_credit_check(&r, all).unwrap_err();
            assert!(why.contains("did not report"), "{why}");
        }
        let mut r = read.clone();
        r["rateLimits"]["credits"] = json!({"balance": "4.00"});
        assert!(codex_credit_check(&r, all).unwrap_err().contains("did not report"));
        r["rateLimits"]["credits"] = json!({"hasCredits": false, "unlimited": false});
        assert_eq!(codex_credit_check(&r, all).unwrap_err(), "no ChatGPT credits are left");
        // An absent reset count is not zero and not permission: no episode, no consume.
        let mut book = ResetBook::empty();
        let mut r = read.clone();
        r["rateLimitResetCredits"] = Value::Null;
        assert!(matches!(book.begin("a", &r, true, NOW * 1000), Step::Skip(why) if why.contains("did not report")));
        assert!(book.accounts.is_empty());
        let mut unknown = read.clone();
        unknown.as_object_mut().unwrap().remove("ordinaryUsageAllowed");
        unknown["rateLimits"]["rateLimitReachedType"] = Value::Null;
        assert!(matches!(book.begin("a", &unknown, true, NOW * 1000), Step::Skip(_)));
        // A missing credit estimate leaves the turn's share and the next base unknown.
        assert_eq!(turn_share(Some(1_000), Some(121_000)), (Some(121_000), Some(120_000)));
        assert_eq!(turn_share(Some(1_000), None), (None, None));
        assert_eq!(turn_share(None, Some(5_000)), (Some(5_000), None));
        // Reset times without a window length, in the past or beyond the window are unknown.
        assert_eq!(codex_retry_at(&read, NOW), Some(1792832400));
        let mut r = read.clone();
        r["rateLimits"]["secondary"]["windowDurationMins"] = Value::Null;
        assert_eq!(codex_retry_at(&r, NOW), None);
        assert_eq!(codex_retry_at(&read, 1792832401), None);
        r = read.clone();
        r["rateLimits"]["secondary"]["resetsAt"] = json!(NOW + 30 * 86_400);
        assert_eq!(codex_retry_at(&r, NOW), None);
        r = read.clone();
        r["rateLimits"]["secondary"]["usedPercent"] = json!(40);
        assert_eq!(codex_retry_at(&r, NOW), None, "a limit with no full window has no known reset");
        let claude = json!({"status": "rejected", "resetsAt": NOW + 600, "rateLimitType": "mystery"});
        assert_eq!(claude_retry_at(Some(&claude), NOW), None);
        assert_eq!(claude_retry_at(Some(&json!({"resetsAt": NOW + 600, "rateLimitType": "five_hour"})), NOW), Some(NOW + 600));
    }

    #[test]
    fn usage_retry_is_once_and_only_at_a_validated_future_reset() {
        let hold = Hold { provider: "codex".into(), reason: "x".into(), retry_at: Some(NOW + 600), ..Hold::default() };
        assert_eq!(hold.due(NOW), Some(NOW + 600));
        assert!(held_text(&hold, NOW).contains("is sent once at"));
        assert_eq!(hold.due(NOW + 601), None, "a reset that passed while closed arms nothing");
        let used = Hold { retried: true, ..hold.clone() };
        assert_eq!(used.due(NOW), None);
        assert!(held_text(&used, NOW).contains("will not retry again by itself"));
        let unknown = Hold { retry_at: None, ..hold.clone() };
        assert!(held_text(&unknown, NOW).contains("Waiting for the plan to reset; check Settings > Usage"));
        let far = Hold { retry_at: Some(NOW + 30 * 86_400), ..hold };
        assert_eq!(far.due(NOW), None);
    }

    #[test]
    fn usage_account_change_invalidates_stale_state() {
        let mut book = Book::default();
        book.set_codex(limited_read());
        let first = book.codex_account.clone().unwrap();
        assert_eq!(first.len(), 64);
        assert!(book.codex.as_ref().unwrap().get("accountId").is_none(), "the raw id is never kept");
        book.codex_noticed = true;
        let mut other = limited_read();
        other["accountId"] = json!("acct-owner-b");
        book.set_codex(other.clone());
        assert_ne!(book.codex_account.as_deref(), Some(first.as_str()));
        assert!(!book.codex_noticed, "another account inherits nothing");
        book.forget_codex();
        assert!(book.codex.is_none() && book.codex_account.is_none());
        // A reset episode belongs to one account.
        let mut resets = ResetBook::empty();
        let Step::Consume(a) = resets.begin(&first, &limited_read(), true, NOW * 1000) else { panic!() };
        let b_hash = account_hash(&other).unwrap();
        let Step::Consume(b) = resets.begin(&b_hash, &other, true, NOW * 1000) else { panic!() };
        assert_ne!(a, b);
        assert!(!serde_json::to_string(&resets).unwrap().contains("acct-owner"));
        assert!(matches!(observe(Provider::Codex, &json!({"method": "account/updated", "params": {"authMode": "chatgpt"}})).as_slice(), [Signal::CodexAccountChanged]));
    }

    #[test]
    fn usage_codex_updates_merge_sparsely_into_the_read_snapshot() {
        let mut book = Book::default();
        book.set_codex(limited_read());
        // account/rateLimits/updated after a reset: nulls never clear saved values.
        book.merge_codex(&json!({"primary": {"usedPercent": 3, "windowDurationMins": 300, "resetsAt": 1792591200},
            "credits": null, "planType": null, "rateLimitReachedType": null, "spendControlReached": null}));
        let snap = book.codex.as_ref().unwrap();
        assert_eq!(snap["rateLimits"]["primary"]["usedPercent"], 3);
        assert_eq!(snap["rateLimits"]["credits"]["balance"], "11.86");
        assert_eq!(snap["rateLimits"]["spendControlReached"], false);
        assert_eq!(snap["rateLimits"]["planType"], "plus");
        assert_eq!(codex_state(snap), PlanState::Limited, "a sparse update cannot prove recovery; the gate re-reads");
    }

    #[test]
    fn usage_claude_plan_follows_the_owner_setting() {
        // Recorded rate_limit_event.rate_limit_info (claude 2.1.299 stream-json).
        let info = json!({"status": "rejected", "resetsAt": 1792832400, "rateLimitType": "seven_day",
            "overageStatus": "allowed", "isUsingOverage": false, "utilization": 1.0});
        assert_eq!(claude_plan(Some(&info), Settings::default(), NOW), ClaudePlan::Credits);
        let off = Settings { claude_credits: false, ..Settings::default() };
        assert_eq!(claude_plan(Some(&info), off, NOW),
            ClaudePlan::Hold { reason: "usage credits are off in Settings > Usage".into(), bypass: false });
        // A known rejection without overage is held before sending (the owner may try anyway).
        let plain = json!({"status": "rejected", "resetsAt": 1792832400, "overageStatus": "rejected", "rateLimitType": "seven_day"});
        assert!(matches!(claude_plan(Some(&plain), Settings::default(), NOW), ClaudePlan::Hold { bypass: true, .. }));
        assert_eq!(claude_retry_at(Some(&plain), NOW), Some(1792832400));
        // A passed reset clears the state; a warning is still the plan.
        assert_eq!(claude_plan(Some(&info), off, 1792832401), ClaudePlan::Plan);
        assert_eq!(claude_plan(Some(&json!({"status": "allowed_warning"})), off, NOW), ClaudePlan::Plan);
    }

    #[test]
    fn usage_limit_detection_uses_recorded_payloads_and_ignores_transient_limits() {
        let codex_failed = json!({"method": "turn/completed", "params": {"threadId": "t", "turn": {"id": "u", "status": "failed",
            "error": {"message": "You've hit your usage limit. Upgrade to Pro or try again in 3 days.", "codexErrorInfo": "usageLimitExceeded", "additionalDetails": null}}}});
        assert_eq!(observe(Provider::Codex, &codex_failed), vec![Signal::UsageLimit, Signal::CodexTurnDone]);
        let codex_error = json!({"method": "error", "params": {"threadId": "t", "turnId": "u", "willRetry": false,
            "error": {"message": "usage limit", "codexErrorInfo": "usageLimitExceeded"}}});
        assert_eq!(observe(Provider::Codex, &codex_error), vec![Signal::UsageLimit]);
        for transient in [
            json!({"method": "error", "params": {"willRetry": true, "error": {"message": "x", "codexErrorInfo": "usageLimitExceeded"}}}),
            json!({"method": "error", "params": {"willRetry": false, "error": {"message": "slow down", "codexErrorInfo": "rateLimitExceeded"}}}),
        ] {
            assert!(observe(Provider::Codex, &transient).is_empty());
        }
        let update = json!({"method": "account/rateLimits/updated", "params": {"rateLimits": {"primary": {"usedPercent": 7}}}});
        assert!(matches!(observe(Provider::Codex, &update).as_slice(), [Signal::CodexRateLimits(_)]));
        let login = json!({"method": "account/login/completed", "params": {"success": true}});
        assert_eq!(observe(Provider::Codex, &login), vec![Signal::CodexAccountChanged]);

        let event = json!({"type": "rate_limit_event", "rate_limit_info": {"status": "allowed_warning", "resetsAt": 1792832400,
            "rateLimitType": "seven_day", "isUsingOverage": false}, "uuid": "x", "session_id": "s"});
        assert!(matches!(observe(Provider::Claude, &event).as_slice(), [Signal::ClaudeRateLimit(_)]));
        let assistant = json!({"type": "assistant", "error": "rate_limit", "session_id": "s", "parent_tool_use_id": null,
            "message": {"role": "assistant", "content": [{"type": "text", "text": "You've hit your weekly limit · resets Oct 24, 9am"}]}});
        assert_eq!(observe(Provider::Claude, &assistant), vec![Signal::UsageLimit]);
        let result = json!({"type": "result", "subtype": "success", "is_error": true, "result": "You've hit your session limit · resets 3pm"});
        assert_eq!(observe(Provider::Claude, &result), vec![Signal::UsageLimit]);
        for other in [
            json!({"type": "assistant", "error": "rate_limit", "message": {"content": [{"type": "text", "text": "API Error: Request rate limit reached"}]}}),
            json!({"type": "result", "is_error": true, "result": "API Error: 529 overloaded"}),
            json!({"type": "result", "is_error": false, "result": "We hit your limit of patience? No."}),
        ] {
            assert!(!observe(Provider::Claude, &other).contains(&Signal::UsageLimit), "{other}");
        }
    }

    // ------------------------------------------------- reset episodes (no provider)

    /// A fake Codex backend: idempotent per key, counting reads and consumes.
    #[derive(Default)]
    struct Backend {
        keys: Mutex<Vec<String>>,
        reads: AtomicUsize,
        lose_first: bool,
        outcome: &'static str,
        recover: bool,
    }

    impl Backend {
        fn read(&self) -> Option<(Value, Option<String>)> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            let redeemed = !self.keys.lock().unwrap().is_empty();
            let read = if self.recover && redeemed { allowed_read() } else { limited_read() };
            Some((read.clone(), account_hash(&read)))
        }
        fn consume(&self, key: String) -> Result<Value, String> {
            let mut keys = self.keys.lock().unwrap();
            let seen = keys.contains(&key);
            keys.push(key);
            if self.lose_first && keys.len() == 1 {
                return Err("Codex did not answer account/rateLimitResetCredit/consume in time.".into());
            }
            let outcome = if seen && self.outcome == "reset" { "alreadyRedeemed" } else { self.outcome };
            Ok(json!({"outcome": outcome}))
        }
        fn unique_keys(&self) -> usize {
            let mut keys = self.keys.lock().unwrap().clone();
            keys.sort();
            keys.dedup();
            keys.len()
        }
    }

    async fn redeem(resets: &Resets, backend: &Arc<Backend>) -> Redeem {
        redeem_with(
            resets,
            true,
            || {
                let backend = backend.clone();
                async move { backend.read() }
            },
            |key| {
                let backend = backend.clone();
                async move { backend.consume(key) }
            },
        )
        .await
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn usage_concurrent_sessions_share_one_reset_episode() {
        let dir = tempfile::tempdir().unwrap();
        // Lagging backend: still limited after the reset, so later sessions rely on the episode.
        let backend = Arc::new(Backend { outcome: "reset", ..Backend::default() });
        let tasks: Vec<_> = (0..6)
            .map(|_| {
                // A separate handle per session, as separate CodaClauda processes would have.
                let resets = Resets::new(dir.path().to_path_buf());
                let backend = backend.clone();
                tokio::spawn(async move { redeem(&resets, &backend).await })
            })
            .collect();
        let mut results = Vec::new();
        for task in tasks {
            results.push(task.await.unwrap());
        }
        assert_eq!(backend.keys.lock().unwrap().len(), 1, "exactly one consume call");
        assert_eq!(results.iter().filter(|r| matches!(r, Redeem::Redeemed { .. })).count(), 1);
        assert_eq!(results.iter().filter(|r| matches!(r, Redeem::Skipped(why) if why.contains("already redeemed"))).count(), 5);
        let saved = std::fs::read_to_string(dir.path().join(RESETS_FILE)).unwrap();
        assert!(!saved.contains("acct-owner"), "only the account hash is stored");
    }

    #[tokio::test]
    async fn usage_lost_consume_reply_retries_only_the_same_key() {
        let dir = tempfile::tempdir().unwrap();
        let resets = Resets::new(dir.path().to_path_buf());
        let backend = Arc::new(Backend { outcome: "reset", lose_first: true, ..Backend::default() });
        assert!(matches!(redeem(&resets, &backend).await, Redeem::Skipped(why) if why.contains("lost")));
        let pending: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join(RESETS_FILE)).unwrap()).unwrap();
        let episode = pending["accounts"].as_object().unwrap().values().next().unwrap().clone();
        assert!(episode["outcome"].is_null(), "persisted before the call, still pending after the lost reply");
        assert_eq!(redeem(&resets, &backend).await, Redeem::Redeemed { outcome: "alreadyRedeemed".into() });
        assert!(matches!(redeem(&resets, &backend).await, Redeem::Skipped(_)));
        let keys = backend.keys.lock().unwrap().clone();
        assert_eq!(keys.len(), 2, "one retry after the lost reply, then none");
        assert_eq!(keys[0], keys[1]);
        assert_eq!(episode["key"], keys[0].as_str());
        assert_eq!(backend.reads.load(Ordering::SeqCst), 5, "a fresh read before and after each consume");
    }

    #[tokio::test]
    async fn usage_reset_outcomes_settle_one_episode_and_reread() {
        for outcome in ["reset", "alreadyRedeemed", "nothingToReset", "noCredit"] {
            let dir = tempfile::tempdir().unwrap();
            let resets = Resets::new(dir.path().to_path_buf());
            let backend = Arc::new(Backend { outcome, ..Backend::default() });
            let first = redeem(&resets, &backend).await;
            match outcome {
                "reset" | "alreadyRedeemed" => assert_eq!(first, Redeem::Redeemed { outcome: outcome.into() }),
                "nothingToReset" => assert_eq!(first, Redeem::Skipped("Codex reported nothing to reset".into())),
                _ => assert_eq!(first, Redeem::Skipped("no earned reset credit is available".into())),
            }
            assert_eq!(backend.reads.load(Ordering::SeqCst), 2, "{outcome}: re-read after the outcome");
            assert!(matches!(redeem(&resets, &backend).await, Redeem::Skipped(_)), "{outcome}");
            assert_eq!(backend.keys.lock().unwrap().len(), 1, "{outcome}: never a second consume in one episode");
        }
        // Recovery closes the episode; a later, new limit stretch may redeem once more.
        let dir = tempfile::tempdir().unwrap();
        let resets = Resets::new(dir.path().to_path_buf());
        let backend = Arc::new(Backend { outcome: "reset", recover: true, ..Backend::default() });
        assert!(matches!(redeem(&resets, &backend).await, Redeem::Redeemed { .. }));
        assert_eq!(redeem(&resets, &backend).await, Redeem::NotNeeded);
        let held = resets.lock(LOCK_WAIT).unwrap();
        let mut book = resets.load(&held).unwrap();
        let account = account_hash(&limited_read()).unwrap();
        assert!(book.accounts[&account].closed_at.is_some());
        assert!(matches!(book.begin(&account, &limited_read(), true, NOW * 1000), Step::Consume(_)));
        assert_eq!(backend.unique_keys(), 1);
    }

    // ------------------------------------------ held turns in the durable ledger

    fn session(id: &str) -> Record {
        Record {
            id: id.into(),
            provider: "codex".into(),
            project_id: "p".into(),
            cwd: "C:\\p".into(),
            title: "t".into(),
            access: "read".into(),
            status: "idle".into(),
            ..Record::default()
        }
    }

    /// What `take_next` does to state when it admits the front turn.
    fn start(state: &mut State, id: &str, lease: &Arc<File>) -> String {
        let item = state.queues.get_mut(id).unwrap().pop_front().unwrap();
        let record = state.records.iter_mut().find(|r| r.id == id).unwrap();
        record.status = "running".into();
        record.turn_id = Some(item.turn_id.clone());
        state.ledger.get_mut(&item.turn_id).unwrap().status = "active".into();
        state.turns.insert(id.into(), Turn {
            id: item.turn_id.clone(), provider_turn: None, stopping: false, dispatched: false,
            start_pending: false, completion: None, _lease: lease.clone(), origin: item.origin.clone(),
        });
        item.turn_id
    }

    fn hold(retry_at: Option<u64>) -> Hold {
        Hold { provider: "codex".into(), reason: "ChatGPT credits are off in Settings > Usage".into(), retry_at, at: 1, ..Hold::default() }
    }

    const A: &str = "s_0123456789abcdef";
    const B: &str = "s_fedcba9876543210";

    #[test]
    fn usage_pre_flight_rejection_is_held_and_a_sent_turn_is_never_replayed() {
        let dir = tempfile::tempdir().unwrap();
        let lease = runtime_lease(dir.path()).unwrap();
        let save = |s: &State| save_snapshot(dir.path(), &s.records, &s.ledger);
        let mut state = State { records: vec![session(A), session(B)], ..State::default() };
        // Refused by the gate before anything was sent: held, never started.
        let first = Queued::new("plan the release".into(), vec![], Value::Null);
        state.accept_queued(A, first.clone(), save).unwrap();
        start(&mut state, A, &lease);
        assert_eq!(state.mark_usage_stopped(A, "codex", 1), None, "an undispatched turn is not a partial run");
        assert!(state.hold_turn(A, &first.turn_id, hold(Some(NOW + 600)), save).unwrap().is_some());
        let held = &state.ledger[&first.turn_id];
        assert_eq!(held.status, "held");
        assert_eq!(held.payload.as_ref().unwrap().text, "plan the release");
        assert!(!state.turns.contains_key(A) && state.records[0].status == "idle" && state.records[0].turn_id.is_none());
        assert!(!state.startable(A), "later turns wait behind the held one");

        // Sent, then stopped by the provider: it may have run, so it is neither held nor replayed.
        let sent = Queued::new("ship it".into(), vec![], Value::Null);
        state.accept_queued(B, sent.clone(), save).unwrap();
        start(&mut state, B, &lease);
        state.turns.get_mut(B).unwrap().dispatched = true;
        assert_eq!(state.hold_turn(B, &sent.turn_id, hold(None), save).unwrap(), None);
        assert_eq!(state.ledger[&sent.turn_id].status, "active", "its receipt is untouched");
        assert_eq!(state.mark_usage_stopped(B, "codex", 2).as_deref(), Some(sent.turn_id.as_str()));
        assert_eq!(state.mark_usage_stopped(B, "codex", 3), None, "marked once");
        assert!(state.queues.get(B).is_none_or(|q| q.is_empty()) && state.held_turn(B).is_none());
        let stopped = state.records[1].clone();
        assert_eq!(state.continue_item(&stopped, &sent.turn_id).err().map(|f| f.0), Some("SESSION_BUSY"));
        state.turns.remove(B);
        state.ledger.get_mut(&sent.turn_id).unwrap().settle("failed", None);
        // The owner's Continue is a new turn that names the original, once.
        assert_eq!(state.continue_item(&stopped, &first.turn_id).err().map(|f| f.0), Some("NOT_STOPPED"));
        let next = state.continue_item(&stopped, &sent.turn_id).unwrap();
        assert_ne!(next.turn_id, sent.turn_id);
        assert_eq!(next.origin, json!({"kind": "continue", "turnId": sent.turn_id}));
        assert!(next.text.contains(&sent.turn_id) && owner_equivalent_origin(&next.origin));
        assert_eq!(state.continue_item(&stopped, &sent.turn_id).unwrap().turn_id, next.turn_id);
    }

    #[test]
    fn usage_held_turn_cancels_survives_restart_once_and_retries_once() {
        let dir = tempfile::tempdir().unwrap();
        let lease = runtime_lease(dir.path()).unwrap();
        let save = |s: &State| save_snapshot(dir.path(), &s.records, &s.ledger);
        let ok = |_: &State, _: &Record, _: &Queued| Ok(());
        let at = NOW + 600;
        let mut state = State { records: vec![session(A)], ..State::default() };
        // Cancellation before the reset: the timer then releases nothing.
        let early = Queued::new("first".into(), vec![], Value::Null);
        state.accept_queued(A, early.clone(), save).unwrap();
        start(&mut state, A, &lease);
        state.hold_turn(A, &early.turn_id, hold(Some(at)), save).unwrap();
        assert_eq!(state.cancel_held(A).unwrap().turn_id, early.turn_id);
        assert_eq!(state.ledger[&early.turn_id].status, "cancelled");
        assert!(matches!(state.take_held(A, &early.turn_id, Trigger::Timer(at), ok, save), Ok(Released::NotHeld)));
        assert!(state.queues.get(A).is_none_or(|q| q.is_empty()) && state.startable(A));

        // A restart restores the held turn once, with its identity and timer.
        let item = Queued::new("second".into(), vec![], Value::Null);
        state.accept_queued(A, item.clone(), save).unwrap();
        start(&mut state, A, &lease);
        state.hold_turn(A, &item.turn_id, hold(Some(at)), save).unwrap();
        save(&state).unwrap();
        let (records, ledger) = read_snapshot(&dir.path().join(REGISTRY_FILE)).unwrap();
        let mut back = State { records, ledger, ..State::default() };
        back.interrupt_pending();
        assert_eq!(back.ledger.values().filter(|t| t.status == "held").count(), 1);
        assert_eq!(back.held_turn(A).unwrap().turn_id, item.turn_id);
        assert_eq!(back.duplicate(A, &item).unwrap().unwrap()["status"], "held");
        assert!(back.queues.is_empty() && back.turns.is_empty());
        assert_eq!(back.held_turn(A).unwrap().hold.as_ref().unwrap().due(NOW), Some(at));

        // The one retry at the reset, from the front of the queue.
        assert!(matches!(back.take_held(A, &item.turn_id, Trigger::Timer(at), ok, save), Ok(Released::Queued)));
        assert_eq!(back.queues[A].front().unwrap().turn_id, item.turn_id);
        assert!(back.ledger[&item.turn_id].hold.as_ref().unwrap().retried);
        assert!(matches!(back.take_held(A, &item.turn_id, Trigger::Timer(at), ok, save), Ok(Released::NotHeld)));
        // Limited again: held without another timer.
        start(&mut back, A, &lease);
        let again = back.hold_turn(A, &item.turn_id, hold(Some(at + 600)), save).unwrap().unwrap();
        assert!(again.retried && again.due(NOW).is_none());
        assert!(matches!(back.take_held(A, &item.turn_id, Trigger::Timer(at + 600), ok, save), Ok(Released::NotHeld)));
        assert_eq!(back.held_turn(A).unwrap().turn_id, item.turn_id, "it stays held for the owner");
    }

    #[test]
    fn usage_held_turn_rechecks_access_and_closed_state_before_dispatch() {
        let dir = tempfile::tempdir().unwrap();
        let lease = runtime_lease(dir.path()).unwrap();
        let save = |s: &State| save_snapshot(dir.path(), &s.records, &s.ledger);
        let mut state = State { records: vec![session(A)], ..State::default() };
        let item = Queued::new("deploy".into(), vec![], json!({"kind": "team"}));
        state.accept_queued(A, item.clone(), save).unwrap();
        start(&mut state, A, &lease);
        state.hold_turn(A, &item.turn_id, hold(None), save).unwrap();
        let revoked = state.take_held(A, &item.turn_id, Trigger::Owner, |_, record, queued| {
            assert_eq!((record.id.as_str(), &queued.origin), (A, &json!({"kind": "team"})));
            Err(("TEAM_ACCESS_CHANGED", "This teammate's access exceeds the project's current level.".into()))
        }, save);
        assert!(matches!(revoked, Ok(Released::Refused(_, ("TEAM_ACCESS_CHANGED", _)))));
        let turn = &state.ledger[&item.turn_id];
        assert_eq!(turn.status, "failed");
        assert!(turn.error.as_deref().unwrap().contains("never sent"));
        assert!(state.queues.get(A).is_none_or(|q| q.is_empty()) && state.turns.is_empty() && state.startable(A));

        let late = Queued::new("after close".into(), vec![], Value::Null);
        state.accept_queued(A, late.clone(), save).unwrap();
        start(&mut state, A, &lease);
        state.hold_turn(A, &late.turn_id, hold(None), save).unwrap();
        state.records[0].status = "stopped".into();
        let closed = state.take_held(A, &late.turn_id, Trigger::Owner, |_, _, _| Ok(()), save);
        assert!(matches!(closed, Ok(Released::Refused(_, ("SESSION_CLOSED", _)))));
        assert_eq!(state.ledger[&late.turn_id].status, "cancelled");
    }
}
