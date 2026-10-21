//! Usage and credits (0.6): one owner setting for the whole app (`usage.json`),
//! never per project and never reachable from an agent's tools.
//!
//! Codex: a host-wide plan snapshot from `account/rateLimits/read` (at each
//! launch, before a send while the plan looks limited, and after a usage-limit
//! error), merged with the sparse `account/rateLimits/updated` notifications.
//! With the plan limit reached a send (1) uses one of the owner's earned weekly
//! resets when allowed, else (2) continues on ChatGPT credits when allowed and
//! available, else (3) waits, says why, and retries once at the reset.
//! Claude: its stream-json `rate_limit_event` and usage-limit errors. Usage
//! credits carry on past the plan limit unless the owner turned them off; then
//! a turn that would use them waits for the reset. A turn rejected for its limit
//! is sent again once at the reported reset (while the app stays open).
//! Nothing here reads credentials, changes sign-in or spends without the
//! owner's setting; the same subscription sign-in is used throughout.

use super::{
    Failure, Inner, Proc, Provider, Queued, begin_rpc, ensure_dirs, event, host, lock, now_ms,
    reply, uuid_v4, write_atomic,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

const USAGE_FILE: &str = "usage.json";
const FILE_LIMIT: u64 = 64 * 1024;
/// Read-only provider queries never retire the process when they are slow.
const SOFT_WAIT: Duration = Duration::from_secs(20);
/// Wait a little past the reported reset before the one retry.
const RESET_MARGIN_MS: u64 = 30_000;
const RETRY_PREFIX: &str = "usage-retry:";
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

/// One stretch of time with the plan limit reached.
#[derive(Clone, Debug, Default)]
pub(super) struct Episode {
    /// The reset-credit idempotency key, reused for every retry in the episode.
    key: String,
    reset_tried: bool,
    noticed: bool,
}

#[derive(Default)]
pub(crate) struct Book {
    settings: Settings,
    /// usage.json could not be read: credits and resets stay off (fail closed).
    failure: Option<String>,
    codex: Option<Value>,
    codex_at: Option<u64>,
    claude: Option<Value>,
    claude_at: Option<u64>,
    codex_episode: Option<Episode>,
    claude_episode: Option<Episode>,
}

impl Book {
    fn effective(&self) -> Settings {
        if self.failure.is_some() { Settings::OFF } else { self.settings }
    }

    pub(super) fn set_codex(&mut self, read: Value) {
        if read["rateLimits"].is_object() {
            self.codex = Some(read);
            self.codex_at = Some(now_ms());
        }
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

    pub(super) fn set_claude(&mut self, info: &Value) {
        if info.is_object() {
            self.claude = Some(info.clone());
            self.claude_at = Some(now_ms());
        }
    }
}

// ------------------------------------------------------------ pure decisions

/// What to do with a send.
#[derive(Debug, PartialEq)]
pub(super) enum Plan {
    /// Send; `billing` names where it is billed when not the plan, `notice`
    /// is said once per episode.
    Go { billing: Option<&'static str>, notice: Option<String> },
    /// Spend one earned weekly reset with this key, then send.
    Reset { key: String, available: i64 },
    /// Do not send now.
    Hold { reason: String, resets_at: Option<u64> },
}

pub(super) fn codex_limited(snapshot: &Value) -> bool {
    snapshot["ordinaryUsageAllowed"] == false
        || snapshot["rateLimits"]["rateLimitReachedType"]
            .as_str()
            .is_some_and(|t| !t.is_empty())
}

/// When ordinary use comes back: the latest reset of a full window (unix seconds).
pub(super) fn codex_resets_at(snapshot: &Value) -> Option<u64> {
    ["primary", "secondary"]
        .iter()
        .map(|w| &snapshot["rateLimits"][w])
        .filter(|w| w["usedPercent"].as_i64().is_some_and(|p| p >= 100))
        .filter_map(|w| w["resetsAt"].as_u64())
        .max()
}

fn codex_credits(snapshot: &Value) -> (bool, Option<String>) {
    let credits = &snapshot["rateLimits"]["credits"];
    let usable = credits["unlimited"] == true || credits["hasCredits"] == true;
    (usable, credits["balance"].as_str().map(str::to_owned))
}

pub(super) fn codex_plan(snapshot: Option<&Value>, settings: Settings, episode: &mut Option<Episode>) -> Plan {
    let Some(snapshot) = snapshot.filter(|s| codex_limited(s)) else {
        *episode = None;
        return Plan::Go { billing: None, notice: None };
    };
    let ep = episode.get_or_insert_with(|| Episode { key: uuid_v4(), ..Episode::default() });
    let available = snapshot["rateLimitResetCredits"]["availableCount"].as_i64().unwrap_or(0);
    if settings.codex_resets && available > 0 && !ep.reset_tried {
        return Plan::Reset { key: ep.key.clone(), available };
    }
    let (usable, balance) = codex_credits(snapshot);
    let capped = snapshot["rateLimits"]["spendControlReached"] == true;
    if settings.codex_credits && usable && !capped {
        let notice = (!ep.noticed).then(|| {
            format!(
                "Plan limit reached; continuing on ChatGPT credits (balance {}).",
                balance.as_deref().unwrap_or("not reported")
            )
        });
        ep.noticed = true;
        return Plan::Go { billing: Some("credits"), notice };
    }
    let reason = if !settings.codex_credits {
        "ChatGPT credits are off in Settings > Usage"
    } else if capped {
        "the spend cap is reached in ChatGPT Settings > Usage"
    } else {
        "no ChatGPT credits are left"
    };
    Plan::Hold { reason: reason.into(), resets_at: codex_resets_at(snapshot) }
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

pub(super) fn claude_plan(info: Option<&Value>, settings: Settings, episode: &mut Option<Episode>, now_secs: u64) -> Plan {
    let Some(info) = claude_current(info, now_secs).filter(|i| claude_overage(i)) else {
        *episode = None;
        return Plan::Go { billing: None, notice: None };
    };
    let ep = episode.get_or_insert_with(Episode::default);
    if settings.claude_credits {
        let notice = (!ep.noticed).then(|| "Claude's plan limit is reached; this chat continues on usage credits.".to_owned());
        ep.noticed = true;
        return Plan::Go { billing: Some("usage-credits"), notice };
    }
    Plan::Hold {
        reason: "usage credits are off in Settings > Usage".into(),
        resets_at: info["resetsAt"].as_u64(),
    }
}

/// What a provider line says about usage.
#[derive(Debug, PartialEq)]
pub(super) enum Signal {
    CodexRateLimits(Value),
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

fn held_text(provider: &str, reason: &str, resets_at: Option<u64>, retry: bool) -> String {
    match (resets_at, retry) {
        (Some(at), true) => format!("{provider}'s plan limit is reached and {reason}. This turn waits and is sent once at {}.", when(at)),
        (Some(at), false) => format!("{provider}'s plan limit is still reached and {reason}. The turn was not sent; the limit resets {}.", when(at)),
        (None, _) => format!("{provider}'s plan limit is reached and {reason}. The turn was not sent and no reset time was reported; send it again later."),
    }
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

    fn usage_settings_set(&self, provider: &str, credits: Option<bool>, resets: Option<bool>) -> Result<Value, Failure> {
        let mut book = lock(&self.usage);
        let mut next = book.effective();
        match provider {
            "codex" => {
                next.codex_credits = credits.unwrap_or(next.codex_credits);
                next.codex_resets = resets.unwrap_or(next.codex_resets);
            }
            "claude" if resets.is_some() => {
                return Err(("INVALID_ARGUMENTS", "Claude has no weekly-reset credits.".into()));
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
        Ok(self.usage_settings())
    }

    fn usage_status(&self, provider: &str) -> Result<Value, Failure> {
        let book = lock(&self.usage);
        let now = now_ms() / 1000;
        match provider {
            "codex" => Ok(json!({
                "provider": "codex", "snapshot": book.codex, "at": book.codex_at,
                "limited": book.codex.as_ref().is_some_and(codex_limited),
                "resetsAt": book.codex.as_ref().and_then(codex_resets_at),
            })),
            "claude" => Ok(json!({
                "provider": "claude", "snapshot": book.claude, "at": book.claude_at,
                "limited": claude_current(book.claude.as_ref(), now).is_some_and(|i| i["status"] == "rejected"),
                "overage": claude_current(book.claude.as_ref(), now).is_some_and(claude_overage),
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

    /// Where this chat's turns are billed when not the plan ("credits" for
    /// ChatGPT credits, "usage-credits" for Claude), shown in the panel.
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

    pub(super) async fn read_codex_limits(&self, proc: &Arc<Proc>) {
        if let Ok(read) = soft_rpc(proc, "account/rateLimits/read", json!({"excludeResetCreditDetails": true})).await {
            lock(&self.usage).set_codex(read);
        }
    }

    /// Before a Codex turn is sent. Ok: send (or the turn stopped meanwhile);
    /// Err: the turn fails with that message and nothing was sent.
    pub(super) async fn codex_usage_gate(self: &Arc<Self>, id: &str, proc: &Arc<Proc>, turn_id: &str) -> Result<(), String> {
        let limited = || lock(&self.usage).codex.as_ref().is_some_and(codex_limited);
        if limited() {
            self.read_codex_limits(proc).await; // never decide on a stale "limited"
        }
        let mut waited = false;
        loop {
            if !self.turn_active(id, turn_id) {
                return Ok(());
            }
            let plan = {
                let mut book = lock(&self.usage);
                let settings = book.effective();
                let snapshot = book.codex.clone();
                codex_plan(snapshot.as_ref(), settings, &mut book.codex_episode)
            };
            match plan {
                Plan::Go { billing, notice } => {
                    self.set_billing(id, billing);
                    if let Some(text) = notice {
                        self.usage_notice(id, Some(turn_id), &text, "info", json!({"billing": billing}));
                    }
                    return Ok(());
                }
                Plan::Reset { key, available } => {
                    let outcome = soft_rpc(proc, "account/rateLimitResetCredit/consume", json!({"idempotencyKey": key})).await;
                    match outcome.as_ref().ok().and_then(|v| v["outcome"].as_str()) {
                        Some(done @ ("reset" | "alreadyRedeemed")) => {
                            self.read_codex_limits(proc).await;
                            if done == "reset" {
                                let left = lock(&self.usage).codex.as_ref()
                                    .and_then(|s| s["rateLimitResetCredits"]["availableCount"].as_i64())
                                    .filter(|n| *n < available)
                                    .unwrap_or(available - 1)
                                    .max(0);
                                self.usage_notice(id, Some(turn_id), &format!("Used a weekly reset ({left} left)."), "info", json!({"billing": "reset"}));
                            }
                            self.set_billing(id, None);
                            return Ok(());
                        }
                        _ => {
                            if let Some(ep) = lock(&self.usage).codex_episode.as_mut() {
                                ep.reset_tried = true;
                            }
                        }
                    }
                }
                Plan::Hold { reason, resets_at } => {
                    let Some(at) = resets_at.filter(|_| !waited) else {
                        return Err(held_text("Codex", &reason, resets_at, false));
                    };
                    self.usage_notice(id, Some(turn_id), &held_text("Codex", &reason, Some(at), true), "warn",
                        json!({"hold": {"reason": reason, "resetsAt": at.saturating_mul(1000)}}));
                    tokio::select! {
                        _ = sleep_until_ms(at.saturating_mul(1000) + RESET_MARGIN_MS) => {}
                        _ = self.wait_stopped(id, turn_id) => return Ok(()),
                    }
                    waited = true;
                    self.read_codex_limits(proc).await;
                }
            }
        }
    }

    /// Before a Claude turn starts its process (snapshot only, no request).
    pub(super) async fn claude_usage_gate(self: &Arc<Self>, id: &str, turn_id: &str) -> Result<(), String> {
        let mut waited = false;
        loop {
            if !self.turn_active(id, turn_id) {
                return Ok(());
            }
            let plan = {
                let mut book = lock(&self.usage);
                let settings = book.effective();
                let info = book.claude.clone();
                claude_plan(info.as_ref(), settings, &mut book.claude_episode, now_ms() / 1000)
            };
            match plan {
                Plan::Go { billing, notice } => {
                    self.set_billing(id, billing);
                    if let Some(text) = notice {
                        self.usage_notice(id, Some(turn_id), &text, "info", json!({"billing": billing}));
                    }
                    return Ok(());
                }
                Plan::Reset { .. } => return Ok(()), // Claude has no weekly resets
                Plan::Hold { reason, resets_at } => {
                    let Some(at) = resets_at.filter(|_| !waited) else {
                        return Err(held_text("Claude", &reason, resets_at, false));
                    };
                    self.usage_notice(id, Some(turn_id), &held_text("Claude", &reason, Some(at), true), "warn",
                        json!({"hold": {"reason": reason, "resetsAt": at.saturating_mul(1000)}, "link": CLAUDE_USAGE_URL}));
                    tokio::select! {
                        _ = sleep_until_ms(at.saturating_mul(1000) + RESET_MARGIN_MS) => {}
                        _ = self.wait_stopped(id, turn_id) => return Ok(()),
                    }
                    waited = true;
                }
            }
        }
    }

    /// Called for every provider line before it is parsed.
    pub(super) fn usage_signal(self: &Arc<Self>, id: &str, proc: &Arc<Proc>, signal: Signal) {
        let current = || lock(&self.state).live.get(id).is_some_and(|l| l.proc.generation == proc.generation);
        match signal {
            Signal::CodexRateLimits(update) => lock(&self.usage).merge_codex(&update),
            Signal::ClaudeRateLimit(info) => {
                let overage = claude_overage(&info) && claude_current(Some(&info), now_ms() / 1000).is_some();
                let first = {
                    let mut book = lock(&self.usage);
                    book.set_claude(&info);
                    if !overage {
                        book.claude_episode = None;
                        false
                    } else {
                        let ep = book.claude_episode.get_or_insert_with(Episode::default);
                        !std::mem::replace(&mut ep.noticed, true)
                    }
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

    /// The credit estimate of the turn that just ended (`account/usage/read`).
    fn codex_turn_credits(self: &Arc<Self>, id: &str, proc: &Arc<Proc>) {
        let turn = self.current_turn(id).map(|t| t.0);
        let Some(thread) = lock(&self.state).records.iter().find(|r| r.id == id).and_then(|r| r.thread_id.clone()) else {
            return;
        };
        let (inner, proc, id) = (self.clone(), proc.clone(), id.to_owned());
        tauri::async_runtime::spawn(async move {
            let Ok(read) = soft_rpc(&proc, "account/usage/read", json!({"threadId": thread})).await else { return };
            let Some(total) = read["threadUsage"]["estimatedUsageCreditsMicros"].as_u64() else { return };
            let saved = inner.with_record(&id, |r| {
                if let Some(previous) = r.credits_micros {
                    r.last_turn_credits = Some(json!({"turnId": turn, "micros": total.saturating_sub(previous), "at": now_ms()}));
                }
                r.credits_micros = Some(total);
                (r.usage, r.last_turn_credits.clone(), r.billing.clone())
            });
            if let Ok(Some((usage, last, billing))) = saved {
                inner.publish(event(&id, None, "usage", json!({"usage": usage, "lastTurnCredits": last, "billing": billing})), false);
            }
        });
    }

    /// The provider refused or ended this turn for its usage limit: explain,
    /// and send the same turn once more at the reset (once per turn, never a
    /// retry of a retry, never a scheduled run; not kept across a restart).
    fn usage_limited(self: &Arc<Self>, id: &str, proc: &Arc<Proc>) {
        let (turn_id, payload) = {
            let state = lock(&self.state);
            let Some(turn) = state.turns.get(id) else { return };
            (turn.id.clone(), state.ledger.get(&turn.id).and_then(|t| t.payload.clone()))
        };
        if !lock(&self.usage_retries).insert(turn_id.clone()) {
            return;
        }
        let (inner, proc, id) = (self.clone(), proc.clone(), id.to_owned());
        tauri::async_runtime::spawn(async move {
            let provider = proc.provider;
            let (next, resets_at, now) = match provider {
                Provider::Codex => {
                    inner.read_codex_limits(&proc).await;
                    let book = lock(&inner.usage);
                    let settings = book.effective();
                    let snapshot = book.codex.clone().unwrap_or(Value::Null);
                    let resets = snapshot["rateLimitResetCredits"]["availableCount"].as_i64().unwrap_or(0);
                    let (usable, balance) = codex_credits(&snapshot);
                    if settings.codex_resets && resets > 0 {
                        ("It is sent again now and uses one of your weekly resets first.".to_owned(), None, true)
                    } else if settings.codex_credits && usable && snapshot["rateLimits"]["spendControlReached"] != true {
                        (format!("It is sent again now on ChatGPT credits (balance {}).", balance.as_deref().unwrap_or("not reported")), None, true)
                    } else {
                        (String::new(), codex_resets_at(&snapshot), false)
                    }
                }
                Provider::Claude => {
                    let at = lock(&inner.usage).claude.as_ref().and_then(|i| i["resetsAt"].as_u64());
                    (format!("To keep working past the limit, turn on usage credits in claude.ai Settings > Usage ({}).", CLAUDE_USAGE_URL), at, false)
                }
            };
            let retryable = payload.as_ref().is_some_and(|p| {
                !p.key.as_deref().is_some_and(|k| k.starts_with(RETRY_PREFIX)) && p.origin["kind"] != "schedule"
            });
            let due = if now { Some(now_ms() + 5_000) } else { resets_at.map(|at| at.saturating_mul(1000) + RESET_MARGIN_MS) };
            let plan = match (retryable, due) {
                (true, Some(_)) if now => String::new(),
                (true, Some(_)) => format!(" This turn is sent once more at {}, while CodaClauda stays open.", when(resets_at.unwrap_or(0))),
                _ => " Send it again after the limit resets.".to_owned(),
            };
            let text = format!("{}'s usage limit stopped this turn. {next}{plan}", provider.label());
            let mut extra = json!({"limit": {"resetsAt": resets_at.map(|s| s.saturating_mul(1000))}});
            if provider == Provider::Claude {
                extra["link"] = json!(CLAUDE_USAGE_URL);
            }
            inner.usage_notice(&id, Some(&turn_id), text.trim(), "warn", extra);
            let (Some(item), true, Some(due)) = (payload, retryable, due) else { return };
            sleep_until_ms(due).await;
            let retry = Queued::keyed(item.text, item.attachments, item.origin, format!("{RETRY_PREFIX}{turn_id}"));
            if let Err((_, message)) = inner.submit(&id, retry) {
                inner.usage_notice(&id, Some(&turn_id), &format!("The automatic retry was not sent: {message}"), "warn", json!({}));
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Recorded shape of `account/rateLimits/read` (codex 0.163.0-alpha.10.2)
    /// after the weekly plan limit, with credits left and two earned resets.
    fn limited_read() -> Value {
        json!({
            "ordinaryUsageAllowed": false,
            "rateLimits": {
                "limitId": "codex", "limitName": null, "planType": "plus",
                "primary": {"usedPercent": 41, "windowDurationMins": 300, "resetsAt": 1792573200},
                "secondary": {"usedPercent": 100, "windowDurationMins": 10080, "resetsAt": 1792832400},
                "credits": {"hasCredits": true, "unlimited": false, "balance": "11.86"},
                "spendControlReached": false,
                "rateLimitReachedType": "rate_limit_reached"
            },
            "rateLimitResetCredits": {"availableCount": 2, "credits": null}
        })
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
    fn usage_codex_gate_uses_a_reset_first_then_credits_then_holds() {
        let read = limited_read();
        let mut episode = None;
        let all = Settings::default();
        let Plan::Reset { key, available } = codex_plan(Some(&read), all, &mut episode) else { panic!("reset first") };
        assert_eq!(available, 2);
        // The same episode reuses its idempotency key on retry.
        let Plan::Reset { key: again, .. } = codex_plan(Some(&read), all, &mut episode) else { panic!() };
        assert_eq!(key, again);
        episode.as_mut().unwrap().reset_tried = true; // nothingToReset / noCredit
        let Plan::Go { billing, notice } = codex_plan(Some(&read), all, &mut episode) else { panic!("credits") };
        assert_eq!(billing, Some("credits"));
        assert_eq!(notice.as_deref(), Some("Plan limit reached; continuing on ChatGPT credits (balance 11.86)."));
        assert!(matches!(codex_plan(Some(&read), all, &mut episode), Plan::Go { notice: None, .. }), "noticed once per episode");

        let mut fresh = None;
        let no_resets = Settings { codex_resets: false, ..all };
        assert!(matches!(codex_plan(Some(&read), no_resets, &mut fresh), Plan::Go { billing: Some("credits"), .. }));
        let cases = [
            (Settings { codex_credits: false, ..no_resets }, read.clone(), "ChatGPT credits are off in Settings > Usage"),
            (no_resets, { let mut r = read.clone(); r["rateLimits"]["spendControlReached"] = json!(true); r }, "the spend cap is reached in ChatGPT Settings > Usage"),
            (no_resets, { let mut r = read.clone(); r["rateLimits"]["credits"]["hasCredits"] = json!(false); r }, "no ChatGPT credits are left"),
        ];
        for (settings, snapshot, expected) in cases {
            let mut ep = None;
            assert_eq!(codex_plan(Some(&snapshot), settings, &mut ep),
                Plan::Hold { reason: expected.into(), resets_at: Some(1792832400) });
        }
        // Back under the plan: the episode ends and its key is not reused.
        let mut ok = read.clone();
        ok["ordinaryUsageAllowed"] = json!(true);
        ok["rateLimits"]["rateLimitReachedType"] = Value::Null;
        assert_eq!(codex_plan(Some(&ok), all, &mut episode), Plan::Go { billing: None, notice: None });
        assert!(episode.is_none());
        assert_eq!(codex_plan(None, all, &mut episode), Plan::Go { billing: None, notice: None });
    }

    #[test]
    fn usage_codex_updates_merge_sparsely_into_the_read_snapshot() {
        let mut book = Book::default();
        book.set_codex(limited_read());
        // account/rateLimits/updated after a reset: nulls never clear saved values.
        book.merge_codex(&json!({"primary": {"usedPercent": 3, "windowDurationMins": 300, "resetsAt": 1792591200},
            "credits": null, "planType": null, "rateLimitReachedType": null}));
        let snap = book.codex.as_ref().unwrap();
        assert_eq!(snap["rateLimits"]["primary"]["usedPercent"], 3);
        assert_eq!(snap["rateLimits"]["credits"]["balance"], "11.86");
        assert_eq!(snap["rateLimits"]["planType"], "plus");
        assert!(codex_limited(snap), "a sparse update cannot prove recovery; the gate re-reads");
        assert_eq!(codex_resets_at(snap), Some(1792832400));
    }

    #[test]
    fn usage_claude_overage_follows_the_owner_setting() {
        // Recorded rate_limit_event.rate_limit_info (claude 2.1.299 stream-json).
        let info = json!({"status": "rejected", "resetsAt": 1792832400, "rateLimitType": "seven_day",
            "overageStatus": "allowed", "isUsingOverage": false, "utilization": 1.0});
        let now = 1792800000;
        let mut ep = None;
        let Plan::Go { billing, notice } = claude_plan(Some(&info), Settings::default(), &mut ep, now) else { panic!() };
        assert_eq!(billing, Some("usage-credits"));
        assert!(notice.unwrap().contains("usage credits"));
        let off = Settings { claude_credits: false, ..Settings::default() };
        assert_eq!(claude_plan(Some(&info), off, &mut None, now),
            Plan::Hold { reason: "usage credits are off in Settings > Usage".into(), resets_at: Some(1792832400) });
        // A rejection without overage is sent (Claude refuses it; the retry handles it),
        // and a passed reset clears the state.
        let plain = json!({"status": "rejected", "resetsAt": 1792832400, "overageStatus": "rejected"});
        assert_eq!(claude_plan(Some(&plain), off, &mut None, now), Plan::Go { billing: None, notice: None });
        assert_eq!(claude_plan(Some(&info), off, &mut None, 1792832401), Plan::Go { billing: None, notice: None });
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
}
