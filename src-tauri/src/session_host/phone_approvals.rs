//! Approvals from Ben's phone (0.7.2). An agent's APPROVAL REQUEST to owner is
//! pushed to the owner's phone topic with Approve and Deny buttons and a
//! one-time code; replying "approve <code>" or "deny <code> <reason>" works
//! too. Codes live only in this process's memory (never on disk, the board or
//! the UI), work once and expire after a day; five wrong codes lock phone
//! approvals until the owner unlocks them on the PC. A checked answer is Ben's
//! own (his choice, 2026-10-27): it goes into the agent's own chat as his words
//! (a CodaClauda chat as a turn, a bound Codex desktop chat through `codex
//! queue`), and an owner reply on the board marks the request answered.
//! Anyone holding the private topic could answer; docs/PHONE.md says so.
use super::{Failure, Inner, Record, desktop_queue, lock, phone::Publication};
use serde::{Deserialize, Serialize};
use coord_core::{mailbox, secrets::mailbox_credential, store::Store};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 8;
const CODE_TTL: u64 = 24 * 60 * 60;
/// Requests older than this when phone approvals first see them are not pushed.
const LOOKBACK: u64 = 24 * 60 * 60;
pub(super) const WRONG_LIMIT: u32 = 5;
const OWNER: &str = "owner";
const PHONE: &str = "owner-phone";
const LOCKED: &str = "Not sent to any agent: phone approvals are locked after five wrong codes. Unlock them in CodaClauda: Settings > Phone.";
const WRONG: &str = "Not sent to any agent: that approval code is not valid. Copy the whole approve or deny line from the request notification.";
const INVALID_FORMAT: &str = "Not sent to any agent: an approve or deny reply needs that request's code. Copy the whole approve or deny line, including its code, from the request notification into the topic or your Shortcut.";
const EXPIRED: &str = "Not sent to any agent: that approval code has expired. Answer the request in CodaClauda, or ask the agent to send it again.";

/// In memory only: a restart forgets every code and re-sends open requests with new ones.
#[derive(Default)]
pub(super) struct Approvals {
    codes: BTreeMap<String, Pending>,
    /// Request ids pushed (or found answered) during this run.
    pushed: BTreeSet<String>,
    /// Owner inbox cursor (board sequence).
    since: u64,
    /// Per run, so a restart's new codes get their own push receipts.
    run: String,
}

#[derive(Clone)]
struct Pending {
    request: String,
    from: String,
    title: String,
    expires: u64,
    revision: u64,
    route: Route,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Decision {
    Approve,
    Deny,
}

/// The canonical form of a typed code (any case, an optional dash), or None.
fn normalize(raw: &str) -> Option<String> {
    let code: String = raw.chars().filter(|c| *c != '-').collect::<String>().to_ascii_uppercase();
    (code.len() == CODE_LEN && code.bytes().all(|b| ALPHABET.contains(&b))).then_some(code)
}
pub(super) fn display(code: &str) -> String {
    format!("{}-{}", &code[..4], &code[4..])
}
/// "approve K7Q2-MX4P", "Deny k7q2mx4p too risky", "yes K7Q2MX4P".
/// None means no coded answer; malformed explicit decisions are refused by routing.
pub(super) fn parse_decision(text: &str) -> Option<(Decision, String, String)> {
    let text = text.trim();
    let (word, rest) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
    let decision = match word.trim_end_matches([':', ',', '.', '!']).to_ascii_lowercase().as_str() {
        "approve" | "approved" | "yes" => Decision::Approve,
        "deny" | "denied" | "no" => Decision::Deny,
        _ => return None,
    };
    let rest = rest.trim_start();
    let (code, note) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    let code = normalize(code.trim_end_matches([':', ',', '.', '!']))?;
    Some((decision, code, note.trim().to_owned()))
}
/// Reserve explicit decision commands even when their code/spacing is malformed.
/// Conversational yes/no stays ordinary unless parse_decision accepts a code.
/// This is a format refusal, not a checked code attempt or an approval mutation.
pub(super) fn malformed_decision_feedback(text: &str) -> Option<&'static str> {
    let word = text.trim_start().split(|c: char| c.is_whitespace() || c.is_ascii_punctuation()).next().unwrap_or("");
    (matches!(word.to_ascii_lowercase().as_str(), "approve" | "approved" | "deny" | "denied")
        && parse_decision(text).is_none()).then_some(INVALID_FORMAT)
}
/// A fresh code from the OS random source; None if it is unavailable (no weak fallback).
fn new_code() -> Option<String> {
    let mut out = String::with_capacity(CODE_LEN);
    while out.len() < CODE_LEN {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).ok()?;
        // Rejection sampling keeps the 31 symbols equally likely.
        for b in bytes {
            if (b as usize) < ALPHABET.len() * (256 / ALPHABET.len()) && out.len() < CODE_LEN {
                out.push(ALPHABET[b as usize % ALPHABET.len()] as char);
            }
        }
    }
    Some(out)
}
fn is_request(m: &Value) -> bool {
    m["to"] == OWNER
        && !matches!(m["from"].as_str(), Some(OWNER | PHONE) | None)
        && m["subject"].as_str().is_some_and(|s| s.trim_start().to_ascii_lowercase().starts_with("approval request"))
}
/// "APPROVAL REQUEST: Ship 0.7.2" -> "Ship 0.7.2" (one line, no control characters, at most 200 characters).
fn request_title(subject: &str) -> String {
    let trimmed = subject.trim_start();
    let rest = trimmed.get("approval request".len()..).unwrap_or("");
    let rest = rest.trim_start_matches([':', '-', ' ', '\u{2013}', '\u{2014}']).trim();
    let title: String = rest.chars().filter(|c| !c.is_control()).take(200).collect();
    if title.is_empty() { "(no description)".into() } else { title }
}
fn answered(store: &Store, request: &str) -> Result<bool, Failure> {
    mailbox::api(store, "wait-reply", &json!({"id": request, "timeout": 0}))
        .map(|r| !r["reply"].is_null())
        .map_err(|_| ("PHONE_BOARD_FAILED", "The existing owner decision could not be verified.".into()))
}
/// The words put into the agent's own chat: Ben's answer, said plainly.
pub(super) fn chat_text(decision: Decision, title: &str, request: &str, note: &str) -> String {
    let mut text = match decision {
        Decision::Approve => format!("Ben approved your request from his phone: \"{title}\". CodaClauda checked his one-time approval code, so this is Ben's own answer in this chat. Go ahead with exactly what the request described, nothing more."),
        Decision::Deny => format!("Ben denied your request from his phone: \"{title}\". CodaClauda checked his one-time approval code, so this is Ben's own answer in this chat. Do not go ahead."),
    };
    if !note.is_empty() {
        text.push_str(&format!("\n\nBen added: {note}"));
    }
    text.push_str(&format!("\n\n(Board request {request}.)"));
    text
}
/// The request notification: what is asked, which chat the answer goes to, and the exact lines to
/// send (the real code; an iPhone Shortcut can send a whole line as it is).
fn push_body(title: &str, body: &str, code: &str, destination: &str) -> String {
    let details = if mailbox_credential(title) || mailbox_credential(body) {
        "The request's text is withheld here because it may contain a credential. Read it in CodaClauda > Approvals.".to_owned()
    } else {
        let excerpt: String = body.chars().filter(|c| *c == '\n' || !c.is_control()).take(600).collect();
        format!("{title}\n\n{excerpt}")
    };
    let code = display(code);
    format!("{details}\n\nFor: {destination}\n\nTo answer, send exactly one of these lines (copy the whole line):\napprove {code}\ndeny {code}\nWords after the code reach the agent too. Or tap Approve or Deny if your phone shows buttons. One use; expires in 24 hours.")
}
/// "Claude Code" / "Codex" for people.
fn provider_label(provider: &str) -> &'static str {
    match provider { "claude" => "Claude Code", "codex" => "Codex", _ => "Agent" }
}
/// The last folder of a path, for people ("MyCast"); never a credential-looking value.
fn folder_name(path: &str) -> String {
    let name = path.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or("").trim();
    if name.is_empty() || mailbox_credential(name) { "its project".into() } else { name.chars().filter(|c| !c.is_control()).take(60).collect() }
}
/// Where an answer goes, in words: shown on the phone only, never used for routing.
pub(super) struct Destination {
    /// For the notification title (ASCII survives there): "Claude Code in MyCast".
    pub(super) short: String,
    /// The exact existing chat: "Claude Code chat \"Release\" in MyCast, a CodaClauda chat (@claude-x)".
    pub(super) chat: String,
    /// For the notification body: the chat and how the answer reaches it.
    pub(super) long: String,
}
fn destination_text(from: &str, route: &Route, chat_title: Option<&str>) -> Destination {
    match route {
        Route::Managed(m) => {
            let (who, project) = (provider_label(&m.provider), folder_name(&m.cwd));
            let chat = chat_title.map_or_else(|| format!("{who} chat"), |t| format!("{who} chat \"{t}\""));
            let chat = format!("{chat} in {project}, a CodaClauda chat (@{from})");
            Destination { short: format!("{who} in {project}"), long: format!("{chat}. Your answer goes into that chat as your words."), chat }
        }
        Route::Desktop(b) => {
            let project = folder_name(b.cwd());
            let chat = format!("the Codex desktop chat in {project} set to Wake by mail (@{from})");
            Destination { short: format!("Codex in {project}"), long: format!("{chat}. Your answer is queued into that chat as your words."), chat }
        }
        Route::BoardOnly => Destination { short: format!("@{from}"), chat: format!("@{from}"),
            long: format!("@{from}. CodaClauda cannot type into that chat, so your answer is only recorded on the board; answer it in its own app too.") },
    }
}
/// ntfy action buttons: each publishes the answer to this same topic from the phone.
fn actions(url: &str, code: &str) -> String {
    let code = display(code);
    format!("http, Approve, {url}, method=POST, body=approve {code}, clear=true; http, Deny, {url}, method=POST, body=deny {code}, clear=true")
}

/// Only identities/digests/generation/outcomes persist. Codes and request text do not.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Ledger {
    wrong: u32,
    decisions: BTreeMap<String, Applied>,
}
impl Ledger {
    pub(super) fn uncertain(&self) -> bool { self.decisions.values().any(|a| matches!(a.outcome.as_str(), "reserved" | "desktop-sending" | "unknown")) }
    pub(super) fn valid(&self, limit: usize) -> bool {
        self.wrong <= WRONG_LIMIT && self.decisions.len() <= limit && self.decisions.iter().all(|(id, a)| {
            id == &a.request && !id.is_empty() && a.body_digest.len() == 64
                && a.body_digest.bytes().all(|c| c.is_ascii_hexdigit())
                && a.message == answer_id(id)
                && matches!(a.outcome.as_str(), "reserved" | "managed" | "desktop-sending" | "queued" | "unknown" | "not-started" | "board-only" | "superseded" | "board-failed")
        })
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedRoute {
    id: String,
    provider: String,
    project: String,
    cwd: String,
    address: Option<String>,
    thread: Option<String>,
    provider_session: Option<String>,
}
impl ManagedRoute {
    fn from_record(r: &Record) -> Self {
        Self { id: r.id.clone(), provider: r.provider.clone(), project: r.project_id.clone(), cwd: r.cwd.clone(),
            address: r.mailbox_address.clone(), thread: r.thread_id.clone(), provider_session: r.provider_session_id.clone() }
    }
    fn matches(&self, r: &Record) -> bool { r.status != "closed" && r.wake && self == &Self::from_record(r) }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Route {
    Managed(ManagedRoute),
    Desktop(desktop_queue::OwnerAnswerBinding),
    BoardOnly,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Applied {
    request: String,
    address: String,
    message: String,
    body_digest: String,
    revision: u64,
    route: Route,
    outcome: String,
    at: u64,
}
fn answer_id(request: &str) -> String { format!("phone-answer-{}", super::hex_digest(request.as_bytes())) }
impl Applied {
    fn matches_message(&self, m: &Value) -> bool {
        m["id"] == self.message && m["reply_to"] == self.request && m["from"] == OWNER
            && m["to"] == self.address && m["kind"] == "reply"
            && m["body"].as_str().is_some_and(|body| super::hex_digest(body.as_bytes()) == self.body_digest)
    }
    fn proof(&self) -> Value {
        json!({"request": self.request, "message": self.message, "digest": self.body_digest, "revision": self.revision})
    }
}

impl Inner {
    pub(super) fn phone_approvals_view(&self) -> Value {
        let wrong = lock(&self.phone).approval_ledger.wrong;
        let waiting = lock(&self.phone_approvals).codes.len();
        json!({"locked": wrong >= WRONG_LIMIT, "waiting": waiting})
    }
    pub(super) fn phone_approvals_unlock(&self) -> Result<(), Failure> {
        self.change_phone(|b| { b.approval_ledger.wrong = 0; Ok(()) })
    }
    pub(super) fn phone_approvals_reset(&self) {
        *lock(&self.phone_approvals) = Approvals::default();
    }
    fn phone_approval_route(&self, address: &str) -> Route {
        let state = lock(&self.state);
        let records: Vec<_> = state.records.iter().filter(|r| r.status != "closed" && r.mailbox_address.as_deref() == Some(address)).collect();
        if let [r] = records.as_slice() { return Route::Managed(ManagedRoute::from_record(r)); }
        if !records.is_empty() { return Route::BoardOnly; }
        drop(state);
        desktop_queue::owner_answer_binding(&self.dir, address).ok().flatten().map(Route::Desktop).unwrap_or(Route::BoardOnly)
    }
    /// Words for where an answer goes (the chat's current title, read only).
    fn phone_destination(&self, from: &str, route: &Route) -> Destination {
        let title = match route {
            Route::Managed(m) => lock(&self.state).records.iter().find(|r| r.id == m.id).map(|r| r.title.trim().chars().take(80).collect::<String>())
                .filter(|t| !t.is_empty() && !t.chars().any(char::is_control) && !mailbox_credential(t)),
            _ => None,
        };
        destination_text(from, route, title.as_deref())
    }
    fn phone_approval_route_current(&self, address: &str, route: &Route) -> bool {
        if !self.wake_enabled() { return false; }
        match route {
            Route::Managed(expected) => lock(&self.state).records.iter().any(|r| expected.matches(r)),
            Route::Desktop(expected) => desktop_queue::owner_answer_binding(&self.dir, address).ok().flatten().as_ref() == Some(expected),
            Route::BoardOnly => false,
        }
    }
    fn phone_approval_outcome(&self, request: &str, outcome: &str) -> Result<(), Failure> {
        self.change_phone(|b| {
            let a = b.approval_ledger.decisions.get_mut(request).ok_or(("PHONE_STORAGE_FAILED", "The decision record is unavailable.".into()))?;
            a.outcome = outcome.into(); Ok(())
        })
    }

    /// Phone tick: only new, uncommitted requests receive an ephemeral code.
    pub(super) async fn phone_approval_requests(&self, revision: u64, store: &Store) -> Result<(), Failure> {
        if !self.phone_approval_current(revision) { return Ok(()); }
        let since = lock(&self.phone_approvals).since;
        let page = mailbox::api(store, "inbox", &json!({"addr": OWNER, "since": since, "limit": 100}))
            .map_err(|_| ("PHONE_BOARD_FAILED", "The owner inbox could not be read for approval requests.".to_owned()))?;
        let floor = self.phone_created_at().max(coord_core::now().saturating_sub(LOOKBACK));
        for m in page["messages"].as_array().into_iter().flatten() {
            let (Some(id), Some(sequence)) = (m["id"].as_str(), m["sequence"].as_u64()) else { continue };
            let committed = lock(&self.phone).approval_ledger.decisions.contains_key(id);
            let wanted = is_request(m) && !committed && m["created_at"].as_u64().unwrap_or(0) >= floor && !lock(&self.phone_approvals).pushed.contains(id);
            if wanted && !answered(store, id)? {
                let Some(code) = new_code() else {
                    self.phone_error("Phone approvals need the system's secure random source, which is unavailable. Approve on the PC.");
                    return Ok(());
                };
                let from = m["from"].as_str().unwrap_or("an agent").to_owned();
                let title = request_title(m["subject"].as_str().unwrap_or(""));
                let route = self.phone_approval_route(&from);
                let destination = self.phone_destination(&from, &route);
                let body = push_body(&title, m["body"].as_str().unwrap_or(""), &code, &destination.long);
                let _gate = self.phone_gate.lock().await;
                if !self.phone_approval_current(revision) { return Ok(()); }
                let Some(url) = self.phone_reply_url() else { return Ok(()) };
                let run = {
                    let mut approvals = lock(&self.phone_approvals);
                    if approvals.run.is_empty() { approvals.run = super::random_hex(6); }
                    approvals.codes.retain(|_, p| p.expires > coord_core::now());
                    if approvals.codes.len() >= 20_000 || approvals.codes.contains_key(&code) { return Ok(()); }
                    approvals.codes.insert(code.clone(), Pending { request: id.into(), from: from.clone(), title, expires: coord_core::now() + CODE_TTL, revision, route });
                    approvals.run.clone()
                };
                let publication = Publication { id: format!("approval:{run}:{id}"), title: format!("Approval needed: {}", destination.short), subject: String::new(), body, limit: 1800, tag: "raised_hand", recipient: None };
                self.phone_publish_actions_locked(&url, publication, Some(&actions(&url, &code))).await?;
            }
            let _gate = self.phone_gate.lock().await;
            if !self.phone_approval_current(revision) { return Ok(()); }
            let mut approvals = lock(&self.phone_approvals);
            if is_request(m) { approvals.pushed.insert(id.to_owned()); }
            approvals.since = approvals.since.max(sequence);
        }
        Ok(())
    }

    /// Caller holds phone_gate. Reserve before board commit; no external action
    /// is possible without both durable records. Restart never reissues a code
    /// for a reserved/unknown decision.
    pub(super) fn phone_decide(&self, decision: Decision, code: &str, note: &str, store: &Store) -> String {
        if !self.phone_approvals_on() { return "Not sent to any agent: phone approvals are off in CodaClauda Settings > Phone.".into(); }
        if lock(&self.phone).approval_ledger.wrong >= WRONG_LIMIT { return LOCKED.into(); }
        let pending = lock(&self.phone_approvals).codes.remove(code);
        let Some(pending) = pending else {
            return match self.change_phone(|b| { b.approval_ledger.wrong = (b.approval_ledger.wrong + 1).min(WRONG_LIMIT); Ok(b.approval_ledger.wrong) }) {
                Ok(wrong) if wrong >= WRONG_LIMIT => LOCKED.into(),
                Ok(_) => WRONG.into(), Err(_) => "Not sent to any agent: phone approval storage failed.".into(),
            };
        };
        if !self.phone_approval_current(pending.revision) { return "Not sent to any agent: that approval was revoked when phone settings changed.".into(); }
        if pending.expires <= coord_core::now() { return EXPIRED.into(); }
        match answered(store, &pending.request) {
            Ok(true) => return "Not sent to any agent: that request was already answered in CodaClauda. Nothing changed.".into(),
            Err(_) => return "Not sent to any agent: the board could not be checked, so nothing was approved. Answer it in CodaClauda.".into(),
            Ok(false) => {}
        }
        let verb = if decision == Decision::Approve { "Approved" } else { "Denied" };
        let destination = self.phone_destination(&pending.from, &pending.route);
        let text = chat_text(decision, &pending.title, &pending.request, note);
        let id = answer_id(&pending.request);
        let applied = Applied { request: pending.request.clone(), address: pending.from.clone(), message: id.clone(),
            body_digest: super::hex_digest(text.as_bytes()), revision: pending.revision, route: pending.route.clone(), outcome: "reserved".into(), at: coord_core::now() };
        let reserved = self.change_phone(|b| {
            if !b.approval_current(pending.revision) || b.approval_ledger.decisions.contains_key(&pending.request) || b.approval_ledger.decisions.len() >= 20_000 {
                return Err(("PHONE_APPROVAL_REFUSED", "The decision is revoked or already reserved.".into()));
            }
            b.approval_ledger.wrong = 0;
            b.approval_ledger.decisions.insert(pending.request.clone(), applied); Ok(())
        });
        if reserved.is_err() { return "Not sent to any agent: the decision could not be saved, so nothing was approved. Answer it in CodaClauda.".into(); }
        let reply = json!({"id": id, "from": OWNER, "to": pending.from, "kind": "reply",
            "reply_to": pending.request, "subject": format!("{verb} from Ben's phone"), "body": text});
        match mailbox::post_first_owner_reply(store, &reply) {
            Ok(saved) if saved["recorded"] == true => {},
            Ok(_) => { let _ = self.phone_approval_outcome(&pending.request, "superseded"); return "Not sent to any agent: that request was already answered on the PC.".into(); }
            Err(_) => { let _ = self.phone_approval_outcome(&pending.request, "board-failed"); return "Not sent to any agent: the board did not confirm your answer, so nothing was dispatched. Check the request in CodaClauda before answering again.".into(); }
        }
        if !self.phone_approval_route_current(&pending.from, &pending.route) {
            let _ = self.phone_approval_outcome(&pending.request, "board-only");
            return format!("{verb} on the board only: \"{}\". Not sent to any agent: the original chat for @{} closed or Wake on mail is off, and no other chat was used.", pending.title, pending.from);
        }
        match pending.route {
            Route::Managed(_) => {
                if self.phone_approval_outcome(&pending.request, "managed").is_err() { return "Recorded on the board but not sent to any agent: delivery storage failed, so no turn was started.".into(); }
                // The existing wake route is the only managed-session writer.
                format!("{verb}: \"{}\". Going to {} through Wake on mail; its reply comes here when it runs (not confirmed yet).", pending.title, destination.chat)
            }
            Route::Desktop(binding) => {
                if self.phone_approval_outcome(&pending.request, "desktop-sending").is_err() { return "Recorded on the board but not sent to any agent: the queue could not be reserved.".into(); }
                let Some(inner) = self.me.upgrade() else { let _ = self.phone_approval_outcome(&pending.request, "not-started"); return "Recorded on the board but not sent to any agent: the chat host is unavailable.".into() };
                let request = pending.request.clone();
                tauri::async_runtime::spawn(async move {
                    let result = desktop_queue::queue_owner_answer(&inner, binding, request.clone(), pending.revision, text).await;
                    let _ = inner.phone_approval_outcome(&request, result.state);
                    inner.phone_notification(Publication { id: format!("approval-delivery:{}", super::random_hex(8)), title: "CodaClauda".into(), subject: String::new(), body: result.detail, limit: 500, tag: "", recipient: None });
                });
                format!("{verb}: \"{}\". Queuing it once into {}; you get a note here when it lands or fails.", pending.title, destination.chat)
            }
            Route::BoardOnly => unreachable!("unavailable routes handled above"),
        }
    }

    /// Used by desktop's count-only poll to exclude this separately tracked
    /// decision, even when it was revoked or its send became unknown.
    pub(super) fn phone_approval_reply(&self, message: &Value) -> bool {
        bridge_reply(message)
    }
    /// Only the exact persisted bridge reply may become a checked phone wake.
    /// Other owner-labelled messages retain the ordinary untrusted-mail path.
    pub(super) fn phone_approval_wake(&self, message: &Value) -> Option<Result<(String, Value), Failure>> {
        checked_wake_message(&lock(&self.phone), message)
    }
    /// Revalidated under lifecycle/state both at durable admission and dequeue.
    pub(super) fn validate_phone_wake(&self, record: &Record, origin: &Value) -> Result<(), Failure> {
        validate_checked_wake(&lock(&self.phone), record, origin)
    }
    pub(super) fn phone_desktop_approval_current(&self, request: &str, revision: u64, binding: &desktop_queue::OwnerAnswerBinding) -> bool {
        let book = lock(&self.phone);
        book.approval_current(revision) && book.approval_ledger.decisions.get(request).is_some_and(|a| a.revision == revision
            && a.outcome == "desktop-sending" && matches!(&a.route, Route::Desktop(original) if original == binding))
    }
}

fn bridge_reply(message: &Value) -> bool {
    message["id"].as_str().is_some_and(mailbox::phone_answer_id)
}
fn checked_wake_message(book: &super::phone::Book, message: &Value) -> Option<Result<(String, Value), Failure>> {
    if !bridge_reply(message) { return None; }
    let Some(a) = message["reply_to"].as_str().and_then(|id| book.approval_ledger.decisions.get(id)) else {
        return Some(Err(("PHONE_APPROVAL_REVOKED", "The durable phone decision is unavailable; it cannot become ordinary mail.".into())));
    };
    if a.matches_message(message) && book.approval_current(a.revision) && a.outcome == "reserved" {
        return Some(Err(("PHONE_APPROVAL_PENDING", "The durable decision commit has not completed.".into())));
    }
    if !a.matches_message(message) || !book.approval_current(a.revision) || a.outcome != "managed" || !matches!(a.route, Route::Managed(_)) {
        return Some(Err(("PHONE_APPROVAL_REVOKED", "This bridge decision is not available for automatic delivery.".into())));
    }
    Some(Ok((message["body"].as_str().unwrap_or("").to_owned(), a.proof())))
}
fn validate_checked_wake(book: &super::phone::Book, record: &Record, origin: &Value) -> Result<(), Failure> {
    let Some(proof) = origin.get("phoneApproval") else {
        return if origin["messageId"].as_str().is_some_and(mailbox::phone_answer_id) {
            Err(("PHONE_APPROVAL_REVOKED", "A bridge answer needs its original durable proof.".into()))
        } else { Ok(()) };
    };
    let a = proof["request"].as_str().and_then(|id| book.approval_ledger.decisions.get(id));
    let valid = a.is_some_and(|a| book.approval_current(a.revision) && a.outcome == "managed" && a.proof() == *proof
        && origin["messageId"] == a.message && origin["from"] == OWNER && origin["address"] == a.address
        && matches!(&a.route, Route::Managed(route) if route.matches(record)));
    if valid { Ok(()) } else { Err(("PHONE_APPROVAL_REVOKED", "The original checked phone decision or route changed.".into())) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_need_a_code_and_keep_ben_s_extra_words() {
        assert_eq!(parse_decision("approve K7Q2-MX4P"), Some((Decision::Approve, "K7Q2MX4P".into(), String::new())));
        assert_eq!(parse_decision("  Deny: k7q2mx4p too risky today "), Some((Decision::Deny, "K7Q2MX4P".into(), "too risky today".into())));
        assert_eq!(parse_decision("yes K7Q2-MX4P, staging only"), Some((Decision::Approve, "K7Q2MX4P".into(), "staging only".into())));
        assert_eq!(parse_decision("no K7Q2-MX4P! not now"), Some((Decision::Deny, "K7Q2MX4P".into(), "not now".into())));
        for uncoded in ["approve", "approve the PR", "@Reviewer approve K7Q2-MX4P", "deny K7Q2-MX4", "approve K7Q2-MX4PX", "approve K7Q2-MX40", "please approve K7Q2-MX4P"] {
            assert_eq!(parse_decision(uncoded), None, "{uncoded}");
        }
    }

    #[test]
    fn explicit_malformed_decisions_get_feedback_without_reclassifying_conversation() {
        for malformed in ["Approve", " approved! ", "DENY", "denied.", "approve the release", "deny K7Q2-MX4", "approve K7Q2-MX4PX", "approve K7Q2-MX40", "approve:K7Q2-MX4P", "deny=K7Q2MX4P", "approved(K7Q2MX4P)"] {
            assert_eq!(malformed_decision_feedback(malformed), Some(INVALID_FORMAT), "{malformed}");
        }
        for ordinary in ["yes", "no", "yes please", "no thanks", "yes short", "no K7Q2-MX40", "approval needed", "denying this", "@Reviewer approve K7Q2-MX4P", "please approve the release"] {
            assert_eq!(malformed_decision_feedback(ordinary), None, "{ordinary}");
        }
        for coded in ["approve K7Q2-MX4P", "approved k7q2mx4p", "Deny: K7Q2MX4P not now", "denied K7Q2-MX4P", "yes K7Q2-MX4P", "no K7Q2MX4P"] {
            assert!(parse_decision(coded).is_some(), "{coded}");
            assert_eq!(malformed_decision_feedback(coded), None, "{coded}");
        }
    }

    #[test]
    fn codes_use_the_unambiguous_alphabet_and_pass_the_credential_scanner() {
        let mut seen = BTreeSet::new();
        for _ in 0..200 {
            let code = new_code().expect("OS random source");
            assert_eq!(code.len(), CODE_LEN);
            assert!(code.bytes().all(|b| ALPHABET.contains(&b)), "{code}");
            assert_eq!(normalize(&display(&code).to_lowercase()), Some(code.clone()));
            let body = push_body("Ship 0.7.2", "Publish the installer.", &code, "Claude Code chat \"Release\" in CodaClauda, a CodaClauda chat (@claude-x).");
            assert!(!mailbox_credential(&body), "{body}");
            assert!(!mailbox_credential(&actions("https://ntfy.sh/a-long-private-topic", &code)));
            seen.insert(code);
        }
        assert!(seen.len() > 190, "codes do not repeat in practice");
        for ambiguous in ["0", "O", "1", "I", "L"] { assert!(!ALPHABET.contains(&ambiguous.as_bytes()[0])); }
    }

    #[test]
    fn requests_are_agent_messages_to_owner_with_the_approval_subject() {
        let m = |from: &str, to: &str, subject: &str| json!({"from": from, "to": to, "subject": subject});
        assert!(is_request(&m("codex-claudacoda", "owner", "APPROVAL REQUEST: Ship 0.7.2")));
        assert!(is_request(&m("claude-x", "owner", "  approval request - publish")));
        assert!(!is_request(&m("owner", "owner", "APPROVAL REQUEST: self")));
        assert!(!is_request(&m("owner-phone", "owner", "APPROVAL REQUEST: phone")));
        assert!(!is_request(&m("codex-x", "codex-y", "APPROVAL REQUEST: peer")));
        assert!(!is_request(&m("codex-x", "owner", "Re: APPROVAL REQUEST")));
        assert_eq!(request_title("APPROVAL REQUEST: Ship 0.7.2"), "Ship 0.7.2");
        assert_eq!(request_title("Approval request \u{2014} Deploy"), "Deploy");
        assert_eq!(request_title("APPROVAL REQUEST"), "(no description)");
    }

    #[test]
    fn a_request_carrying_a_credential_is_withheld_from_the_phone() {
        let body = push_body("Use key", "password: Hunter2Hunter2", "K7Q2MX4P", "@claude-x.");
        assert!(body.contains("withheld") && !body.contains("Hunter2"));
        assert!(body.contains("approve K7Q2-MX4P"));
    }

    #[test]
    fn the_chat_words_say_who_answered_and_how_far_to_go() {
        let yes = chat_text(Decision::Approve, "Ship 0.7.2", "req-1", "staging first");
        assert!(yes.contains("Ben approved") && yes.contains("exactly what the request described") && yes.contains("Ben added: staging first") && yes.contains("req-1"));
        let no = chat_text(Decision::Deny, "Ship 0.7.2", "req-1", "");
        assert!(no.contains("Do not go ahead") && !no.contains("Ben added"));
    }

    #[test]
    fn the_request_names_its_chat_and_the_exact_lines_to_send() {
        let managed = Route::Managed(ManagedRoute { id: "s_1".into(), provider: "claude".into(), project: "local:c:/work/mycast".into(),
            cwd: r"C:\Users\Ben\Desktop\MyCast".into(), address: Some("claude-mycast-1a2b".into()), thread: None, provider_session: None });
        let here = destination_text("claude-mycast-1a2b", &managed, Some("Release"));
        assert_eq!(here.short, "Claude Code in MyCast");
        assert_eq!(here.chat, "Claude Code chat \"Release\" in MyCast, a CodaClauda chat (@claude-mycast-1a2b)");
        assert!(here.long.ends_with("Your answer goes into that chat as your words."));
        assert!(destination_text("claude-mycast-1a2b", &managed, None).chat.starts_with("Claude Code chat in MyCast"));
        let elsewhere = destination_text("claude-desktop", &Route::BoardOnly, None);
        assert!(elsewhere.long.contains("only recorded on the board") && elsewhere.short == "@claude-desktop");

        let body = push_body("Ship 0.7.2", "Publish the installer.", "K7Q2MX4P", &here.long);
        assert!(body.contains("For: Claude Code chat \"Release\" in MyCast"), "{body}");
        let lines: Vec<&str> = body.lines().collect();
        assert!(lines.contains(&"approve K7Q2-MX4P") && lines.contains(&"deny K7Q2-MX4P"), "each answer is a whole line to copy: {body}");
        assert!(!mailbox_credential(&body));
        for (path, name) in [(r"C:\Users\Ben\Desktop\MyCast\", "MyCast"), ("/home/ben/app", "app"), ("", "its project")] {
            assert_eq!(folder_name(path), name);
        }
    }

    #[test]
    fn every_refusal_says_nothing_reached_an_agent() {
        for text in [LOCKED, WRONG, INVALID_FORMAT, EXPIRED] {
            assert!(text.starts_with("Not sent to any agent"), "{text}");
            assert!(!text.chars().any(|c| c.is_ascii_digit()), "no example code a Shortcut could send: {text}");
        }
    }
    fn decision_fixture() -> (super::super::phone::Book, Record, Value) {
        let record: Record = serde_json::from_value(json!({"id":"s_0123456789abcdef","provider":"codex","projectId":"local:fixture","cwd":"C:/fixture","title":"Fixture","access":"full","threadId":null,"providerSessionId":null,"status":"idle","createdAt":1,"lastActivityAt":1,"shared":false,"sharedId":null,"wake":true,"mailboxAddress":"codex-fixture"})).unwrap();
        let mut book: super::super::phone::Book = serde_json::from_value(json!({"schema":2,"enabled":true,"topicDigest":"fixture-topic-digest","revision":7,"approvals":true})).unwrap();
        let text = chat_text(Decision::Approve, "Fixture scope", "request-fixture", "");
        let applied = Applied { request: "request-fixture".into(), address: "codex-fixture".into(), message: answer_id("request-fixture"),
            body_digest: super::super::hex_digest(text.as_bytes()), revision: 7, route: Route::Managed(ManagedRoute::from_record(&record)), outcome: "managed".into(), at: 1 };
        let message = json!({"id":applied.message,"from":"owner","to":"codex-fixture","kind":"reply","reply_to":"request-fixture","body":text});
        book.approval_ledger.decisions.insert(applied.request.clone(), applied);
        (book, record, message)
    }
    fn checked_item(book: &super::super::phone::Book, record: &Record, message: &Value) -> super::super::Queued {
        let (text, proof) = checked_wake_message(book, message).unwrap().unwrap();
        let origin = json!({"kind":"wake","from":"owner","address":"codex-fixture","messageId":message["id"],"messageKind":"reply","phoneApproval":proof});
        validate_checked_wake(book, record, &origin).unwrap();
        super::super::Queued::keyed(text, Vec::new(), origin, super::super::wake::wake_key(&record.id, "codex-fixture", message["id"].as_str().unwrap()))
    }

    #[test]
    fn committed_phone_reply_admits_one_supported_wake_and_reconciles_after_restart() {
        let dir = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let store = Store::new(Some(dir.path().join("board"))).unwrap();
        mailbox::api(&store, "register", &json!({"name":"codex-fixture"})).unwrap();
        mailbox::api(&store, "post", &json!({"id":"request-fixture","from":"codex-fixture","to":"owner","kind":"question","subject":"APPROVAL REQUEST: Fixture scope","body":"Fixture only"})).unwrap();
        let (book, record, message) = decision_fixture();
        let mut reply = message.clone(); reply["subject"] = json!("Approved from phone");
        assert_eq!(mailbox::post_first_owner_reply(&store, &reply).unwrap()["recorded"], true);
        let inbox = mailbox::api(&store, "inbox", &json!({"addr":"codex-fixture","unread":true})).unwrap();
        let item = checked_item(&book, &record, &inbox["messages"][0]);
        assert_eq!(item.origin["kind"], "wake");
        assert!(!super::super::owner_equivalent_origin(&item.origin), "not a generic owner-origin bypass");
        let mut state = super::super::State { records: vec![record.clone()], ..Default::default() };
        state.accept_queued(&record.id, item.clone(), |s| super::super::save_snapshot(dir.path(), &s.records, &s.ledger)).unwrap();
        assert!(state.duplicate(&record.id, &item).unwrap().is_some());
        let (records, ledger) = super::super::read_snapshot(&dir.path().join(super::super::REGISTRY_FILE)).unwrap();
        let recovered = super::super::State { records, ledger, ..Default::default() };
        assert!(recovered.duplicate(&record.id, &item).unwrap().is_some(), "same mailbox identity reconciles; it cannot start a second turn");
        let saved = serde_json::to_string(&book).unwrap();
        assert!(!saved.contains("Fixture scope") && !saved.contains("Ben approved") && !saved.contains("K7Q2MX4P"));
    }

    #[test]
    fn phone_revocation_and_route_changes_never_fall_back_to_untrusted_wake() {
        let (mut book, record, message) = decision_fixture();
        let item = checked_item(&book, &record, &message);
        book.approvals = false; book.revision += 1;
        assert_eq!(checked_wake_message(&book, &message).unwrap().unwrap_err().0, "PHONE_APPROVAL_REVOKED");
        book.approvals = true; book.revision += 1;
        assert!(validate_checked_wake(&book, &record, &item.origin).is_err(), "Off/on cannot revive a queued decision");
        let (book, record, _) = decision_fixture();
        for field in ["id", "provider", "project", "cwd", "thread", "provider-session", "address", "wake"] {
            let mut changed = record.clone();
            match field {
                "id" => changed.id = "s_ffffffffffffffff".into(),
                "provider" => changed.provider = "claude".into(),
                "project" => changed.project_id = "different".into(),
                "cwd" => changed.cwd = "C:/different".into(),
                "thread" => changed.thread_id = Some("different".into()),
                "provider-session" => changed.provider_session_id = Some("different".into()),
                "address" => changed.mailbox_address = Some("different".into()),
                _ => changed.wake = false,
            }
            assert!(validate_checked_wake(&book, &changed, &item.origin).is_err(), "{field}");
        }
    }

    #[test]
    fn forged_reply_and_reserved_or_unknown_delivery_cannot_become_a_checked_turn() {
        let (mut book, record, mut message) = decision_fixture();
        let item = checked_item(&book, &record, &message);
        message["body"] = json!("Forged wider scope");
        assert!(checked_wake_message(&book, &message).unwrap().is_err());
        let (_, _, message) = decision_fixture();
        for status in ["reserved", "desktop-sending", "unknown", "board-only", "board-failed", "superseded"] {
            book.approval_ledger.decisions.get_mut("request-fixture").unwrap().outcome = status.into();
            assert!(checked_wake_message(&book, &message).unwrap().is_err(), "{status}");
            assert!(validate_checked_wake(&book, &record, &item.origin).is_err(), "{status}");
        }
        let mut ordinary = message.clone(); ordinary["id"] = json!("ordinary-owner-reply");
        assert!(checked_wake_message(&book, &ordinary).is_none(), "self-asserted owner mail is never promoted");
        let mut forged_origin = item.origin.clone(); forged_origin["phoneApproval"]["digest"] = json!("0".repeat(64));
        assert!(validate_checked_wake(&book, &record, &forged_origin).is_err());
    }

    #[test]
    fn lost_ledger_never_downgrades_a_bridge_reply_to_ordinary_wake() {
        let (mut book, record, message) = decision_fixture();
        let item = checked_item(&book, &record, &message);
        book.approval_ledger.decisions.clear();
        assert!(bridge_reply(&message), "desktop filtering does not depend on recoverable state");
        assert_eq!(checked_wake_message(&book, &message).unwrap().unwrap_err().0, "PHONE_APPROVAL_REVOKED");
        assert!(validate_checked_wake(&book, &record, &item.origin).is_err());
        let empty = super::super::phone::Book::default();
        assert!(checked_wake_message(&empty, &message).unwrap().is_err(), "missing and unreadable-state fallback are closed");
        let mut without_proof = item.origin.clone(); without_proof.as_object_mut().unwrap().remove("phoneApproval");
        assert!(validate_checked_wake(&empty, &record, &without_proof).is_err(), "old queued bridge origin cannot downgrade either");
    }

    #[test]
    fn durable_wrong_code_lock_is_separate_from_ephemeral_codes() {
        let (mut book, _, _) = decision_fixture();
        book.approval_ledger.wrong = WRONG_LIMIT;
        let saved = serde_json::to_vec(&book).unwrap();
        let restored: super::super::phone::Book = serde_json::from_slice(&saved).unwrap();
        assert_eq!(restored.approval_ledger.wrong, WRONG_LIMIT);
        assert!(restored.approval_ledger.valid(20_000));
        assert!(Approvals::default().codes.is_empty());
        book.approval_ledger.wrong = WRONG_LIMIT + 1;
        assert!(!book.approval_ledger.valid(20_000), "malformed count fails closed");
    }

}
