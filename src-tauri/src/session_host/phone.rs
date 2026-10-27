//! Two-way messages on the owner's one ntfy topic. The owner chooses this
//! phone channel. Every app publish is tagged, scanned and receipted.
//! Only the passive board is written; existing wake/access checks still apply.
use super::{Failure, Inner, Record, host, lock, notify, phone_approvals, reply, write_atomic};
use coord_core::{mailbox, secrets::mailbox_credential, store::Store};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, fs, path::Path, sync::Arc, time::Duration};

const FILE: &str = "phone.json";
const ADDRESS: &str = "owner-phone";
const APP_TAG: &str = "codaclauda";
const POLL_EVERY: Duration = Duration::from_secs(5);
const POLL_BYTES: usize = 1024 * 1024;
const STATE_BYTES: usize = 16 * 1024 * 1024;
const MESSAGE_BYTES: usize = 24 * 1024;
const RECEIPT_LIMIT: usize = 20_000;
const RETENTION: u64 = 30 * 24 * 60 * 60;
const SCAN_REFUSAL: &str = "Message not forwarded: the mailbox credential scanner found a possible credential or pairing code. Remove it and send a new message.";
const STORAGE_ERROR: &str = "Phone settings or receipts are unavailable. Phone messaging is paused; restore the saved phone.json and restart CodaClauda. Existing receipt evidence will not be overwritten.";
const UNKNOWN_PUSH: &str = "A phone push may have been sent, but its result is unknown. It will not be retried automatically; check the phone and board.";

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InboundReceipt {
    digest: String,
    to: Option<String>,
    /// Byte offset in the original input: freezes multiword-title routing on retry.
    text_start: usize,
    feedback: Option<String>,
    feedback_attempted: bool,
    done: bool,
    at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PushReceipt {
    /// Persisted before HTTP dispatch. An interrupted attempt is never replayed.
    state: String,
    at: u64,
}

/// Inert evidence from the unreleased two-topic draft, never replayed on the
/// notification topic. Keep its receipt schema strict so bodies cannot enter it.
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyInboundReceipt {
    digest: String,
    to: Option<String>,
    feedback: Option<String>,
    feedback_attempted: bool,
    feedback_state: Option<String>,
    done: bool,
    at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(super) struct Book {
    schema: u32,
    enabled: bool,
    topic_digest: Option<String>,
    pub(super) revision: u64,
    created_at: u64,
    last_id: Option<String>,
    last_recipient: Option<String>,
    /// Namespaced by URL digest; old delivered IDs survive URL changes.
    inbound: BTreeMap<String, InboundReceipt>,
    /// Global source-message IDs: a URL change never republishes old board mail.
    outbound: BTreeMap<String, PushReceipt>,
    /// Namespaced ntfy IDs, in addition to the tag that survives a crash before save.
    published: BTreeMap<String, u64>,
    legacy_inbound: BTreeMap<String, LegacyInboundReceipt>,
    legacy_cursor: Option<String>,
    last_error: Option<String>,
    /// 0.7.2: send agents' APPROVAL REQUESTs to the phone with one-time codes (phone_approvals.rs).
    pub(super) approvals: bool,
    pub(super) approval_ledger: phone_approvals::Ledger,
    #[serde(skip)]
    storage_failed: bool,
}

impl Default for Book {
    fn default() -> Self {
        Self { schema: 2, enabled: true, topic_digest: None, revision: 0,
            created_at: 0, last_id: None, last_recipient: None, inbound: BTreeMap::new(),
            outbound: BTreeMap::new(), published: BTreeMap::new(), legacy_inbound: BTreeMap::new(),
            legacy_cursor: None, last_error: None, approvals: true, approval_ledger: phone_approvals::Ledger::default(), storage_failed: false }
    }
}

impl Book {
    fn advance_cursor(&mut self, id: &str) {
        self.last_id = Some(id.into());
        // Retire only the obsolete 0.6.1 parser error after actual progress.
        // Unknown outbound outcomes and credential refusals remain evidence.
        if self.last_error.as_deref() == Some("ntfy returned an unsupported event.") {
            self.last_error = None;
        }
    }
    pub(super) fn current(&self, revision: u64) -> bool {
        self.enabled && !self.storage_failed && self.topic_digest.is_some() && self.revision == revision
    }
    pub(super) fn approval_current(&self, revision: u64) -> bool {
        self.approvals && self.current(revision)
    }
    fn settings(&mut self, enabled: bool) -> Result<(), Failure> {
        if self.storage_failed { return Err(failure("PHONE_STORAGE_FAILED", STORAGE_ERROR)); }
        self.enabled = enabled;
        self.revision = self.revision.wrapping_add(1);
        self.last_error = None;
        Ok(())
    }
    fn bind(&mut self, url: Option<&str>, now: u64) -> Result<bool, Failure> {
        if self.storage_failed { return Err(failure("PHONE_STORAGE_FAILED", STORAGE_ERROR)); }
        let digest = url.map(url_digest);
        if self.topic_digest == digest { return Ok(false); }
        self.topic_digest = digest;
        self.revision = self.revision.wrapping_add(1);
        self.created_at = now;
        self.last_id = None;
        self.last_recipient = None;
        self.last_error = None;
        // Switching topic cancels unfinished routing and its feedback, while
        // retaining dedupe evidence. Outbound attempts are never cleared.
        for receipt in self.inbound.values_mut() {
            receipt.done = true;
            receipt.feedback = None;
        }
        Ok(true)
    }
    fn own(&self, item: &Incoming) -> bool {
        item.tags.iter().any(|tag| tag == APP_TAG)
            || self.published.contains_key(&scoped(self.topic_digest.as_deref().unwrap_or(""), &item.id))
    }
    fn complete_push(&mut self, source: &str, ntfy_id: Result<&str, &Failure>, refused: bool, recipient: Option<&str>) {
        if let Some(receipt) = self.outbound.get_mut(source) {
            receipt.state = match ntfy_id {
                Ok(_) if refused => "refused", Ok(_) => "sent",
                Err(("PHONE_PUSH_FAILED" | "PHONE_CLIENT_UNAVAILABLE", _)) => "failed",
                Err(_) => "unknown",
            }.into();
        }
        match ntfy_id {
            Ok(id) => {
                let digest = self.topic_digest.as_deref().unwrap_or("");
                self.published.insert(scoped(digest, id), coord_core::now());
                // A rejection or system warning never changes reply routing.
                if !refused && let Some(to) = recipient.filter(|to| *to != ADDRESS && *to != "owner") {
                    self.last_recipient = Some(to.into());
                }
                if refused { self.last_error = Some(SCAN_REFUSAL.into()); }
            }
            Err((_, message)) => self.last_error = Some(message.clone()),
        }
    }
}

fn failure(code: &'static str, text: &str) -> Failure { (code, text.into()) }
fn url_digest(url: &str) -> String { format!("{:x}", Sha256::digest(url.as_bytes())) }
fn scoped(digest: &str, id: &str) -> String { format!("{digest}:{id}") }
fn valid_event_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn persist(path: &Path, book: &Book) -> Result<(), Failure> {
    let bytes = serde_json::to_vec_pretty(book).map_err(|_| failure("PHONE_STORAGE_FAILED", STORAGE_ERROR))?;
    if bytes.len() > STATE_BYTES { return Err(failure("PHONE_STORAGE_FAILED", STORAGE_ERROR)); }
    write_atomic(path, &bytes).map_err(|_| failure("PHONE_STORAGE_FAILED", STORAGE_ERROR))
}
fn read_book(path: &Path) -> Result<Book, Failure> {
    let bytes = match fs::read(path) {
        Ok(bytes) if bytes.len() <= STATE_BYTES => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Book::default()),
        _ => return Err(failure("PHONE_STORAGE_FAILED", STORAGE_ERROR)),
    };
    let mut value: Value = serde_json::from_slice(&bytes).map_err(|_| failure("PHONE_STORAGE_FAILED", STORAGE_ERROR))?;
    // The unreleased two-topic draft must not carry its generated topic or
    // selected recipient into the one-topic flow. Preserve explicit Off and
    // all board-reply attempts, including ambiguous ones.
    if value["schema"] == 1 {
        let object = value.as_object_mut().ok_or_else(|| failure("PHONE_STORAGE_FAILED", STORAGE_ERROR))?;
        for name in ["topic", "defaultRecipient", "createdAt"] { object.remove(name); }
        if let Some(inbound) = object.remove("inbound") { object.insert("legacyInbound".into(), inbound); }
        if let Some(cursor) = object.remove("lastId") { object.insert("legacyCursor".into(), cursor); }
        if let Some(entries) = object.get_mut("outbound").and_then(Value::as_object_mut) {
            let old = std::mem::take(entries);
            *entries = old.into_iter().map(|(id, entry)| (format!("board:{id}"), entry)).collect();
        }
        object.insert("schema".into(), json!(2));
    }
    let mut book: Book = serde_json::from_value(value).map_err(|_| failure("PHONE_STORAGE_FAILED", STORAGE_ERROR))?;
    if book.schema != 2 || book.inbound.len() > RECEIPT_LIMIT || book.outbound.len() > RECEIPT_LIMIT
        || book.published.len() > RECEIPT_LIMIT || book.legacy_inbound.len() > RECEIPT_LIMIT
        || !book.approval_ledger.valid(RECEIPT_LIMIT) {
        return Err(failure("PHONE_STORAGE_FAILED", STORAGE_ERROR));
    }
    if book.outbound.values().any(|r| r.state == "sending")
        || book.legacy_inbound.values().any(|r| r.feedback_state.as_deref() == Some("sending")) {
        book.last_error = Some(UNKNOWN_PUSH.into());
    }
    if book.approval_ledger.uncertain() {
        book.last_error = Some("A phone approval delivery is reserved or has an unknown result. It is not retried automatically; reconcile its exact board request and chat.".into());
    }
    Ok(book)
}

#[derive(Clone, Debug, Deserialize)]
struct Incoming {
    id: String,
    time: u64,
    topic: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Debug)]
enum PollEvent {
    Message(Incoming),
    /// A cached non-message event: move the cursor without routing its payload.
    Skip(String),
}

/// ntfy's JSONL stream also contains control events and future event types.
/// Keep their validated cursors in order; ephemeral open/keepalive IDs are not
/// cached message cursors and must not replace the last handled ID.
fn parse_poll(bytes: &[u8], topic: &str) -> Result<Vec<PollEvent>, Failure> {
    if bytes.len() > POLL_BYTES { return Err(failure("PHONE_POLL_TOO_LARGE", "The ntfy poll exceeded its size limit. Check the topic for unwanted traffic.")); }
    let text = std::str::from_utf8(bytes).map_err(|_| failure("PHONE_POLL_INVALID", "ntfy returned invalid message data."))?;
    let mut out = Vec::new();
    for line in text.lines().filter(|s| !s.trim().is_empty()) {
        let value: Value = serde_json::from_str(line).map_err(|_| failure("PHONE_POLL_INVALID", "ntfy returned invalid message data."))?;
        match value["event"].as_str() {
            Some("open" | "keepalive") => continue,
            Some("message") => {},
            Some(_) => {
                // Ignore unknown payloads, but never persist a cursor from a
                // different topic or an invalid/missing ID.
                if value["topic"].as_str() == Some(topic)
                    && let Some(id) = value["id"].as_str().filter(|id| valid_event_id(id)) {
                    out.push(PollEvent::Skip(id.into()));
                }
                continue;
            },
            None => return Err(failure("PHONE_POLL_INVALID", "ntfy returned invalid message data.")),
        }
        let item: Incoming = serde_json::from_value(value).map_err(|_| failure("PHONE_POLL_INVALID", "ntfy returned invalid message data."))?;
        if item.topic != topic || !valid_event_id(&item.id) { return Err(failure("PHONE_POLL_INVALID", "ntfy returned invalid message identifiers.")); }
        out.push(PollEvent::Message(item));
    }
    Ok(out)
}

/// Each callback finishes its durable update before the next event is visited.
/// False means owner settings changed; an error leaves later cursors untouched.
async fn walk_poll<'a, F, Fut>(items: &'a [PollEvent], mut apply: F) -> Result<(), Failure>
where F: FnMut(&'a PollEvent) -> Fut,
      Fut: std::future::Future<Output = Result<bool, Failure>> {
    for item in items {
        if !apply(item).await? { break; }
    }
    Ok(())
}

#[derive(Clone)]
struct Recipient { address: String, title: Option<String>, active: bool }

fn recipients(directory: &Value, records: &[Record]) -> Vec<Recipient> {
    let known: BTreeSet<&str> = directory["addresses"].as_array().into_iter().flatten().filter_map(|v| v["name"].as_str()).collect();
    let mut sessions: Vec<_> = records.iter().filter(|r| r.status != "closed")
        .filter_map(|r| r.mailbox_address.as_deref().filter(|a| *a != ADDRESS && known.contains(a)).map(|a| (r, a))).collect();
    sessions.sort_by_key(|(r, _)| std::cmp::Reverse(r.last_activity_at));
    let mut out = Vec::new();
    for (record, address) in sessions {
        if !out.iter().any(|r: &Recipient| r.address == address) {
            let title = record.title.trim();
            let title = (!title.is_empty() && !title.chars().any(char::is_control) && !mailbox_credential(title)).then(|| title.to_owned());
            out.push(Recipient { address: address.into(), title, active: true });
        }
    }
    for address in known {
        if address != ADDRESS && !out.iter().any(|r| r.address == address) {
            out.push(Recipient { address: address.into(), title: None, active: false });
        }
    }
    out
}
fn choice_hint(choices: &[Recipient]) -> String {
    let names: Vec<_> = choices.iter().filter(|r| r.active).take(3).map(|r| {
        match r.title.as_deref().filter(|t| !mailbox_credential(t)) {
            Some(title) => format!("{} (@{})", title.chars().take(60).collect::<String>(), r.address),
            None => format!("@{}", r.address),
        }
    }).collect();
    let mut hint = "Start with @name to choose an agent".to_owned();
    if !names.is_empty() { hint.push_str(&format!(". Available agents: {}", names.join(", "))); }
    hint.push('.');
    // Even hints must not disclose a suspicious self-asserted address/title.
    if mailbox_credential(&hint) { "Start with @name to choose an agent. See the agent names in CodaClauda.".into() } else { hint }
}
fn prefix_match(rest: &str, name: &str) -> Option<usize> {
    // case-insensitive comparison without indexing a lowercased Unicode string
    let end = rest.char_indices().nth(name.chars().count()).map_or(rest.len(), |(i, _)| i);
    let prefix = &rest[..end];
    (prefix.to_lowercase() == name.to_lowercase() && rest[end..].chars().next().is_none_or(char::is_whitespace)).then_some(end)
}
fn route(body: &str, last: Option<&str>, choices: &[Recipient]) -> Result<(String, usize), String> {
    if mailbox_credential(body) { return Err(SCAN_REFUSAL.into()); }
    if body.len() > MESSAGE_BYTES || body.contains('\0') { return Err("Message not forwarded: it is too large or contains invalid text.".into()); }
    let trimmed = body.trim_start();
    let leading = body.len() - trimmed.len();
    let (to, start) = if let Some(rest) = trimmed.strip_prefix('@') {
        let mut matches = Vec::new();
        if let Some(quoted) = rest.strip_prefix('"') {
            let Some(end) = quoted.find('"') else { return Err("Close the quoted agent name, or use its @board-address.".into()); };
            if quoted[end + 1..].chars().next().is_some_and(|c| !c.is_whitespace()) { return Err("Add a space after the quoted agent name.".into()); }
            let name = &quoted[..end];
            for r in choices {
                if r.address.eq_ignore_ascii_case(name) {
                    matches.push((r.address.clone(), end + 2));
                }
            }
            if matches.is_empty() {
                for r in choices {
                    if r.title.as_ref().is_some_and(|t| t.to_lowercase() == name.to_lowercase()) {
                        matches.push((r.address.clone(), end + 2));
                    }
                }
            }
        } else {
            // Prefer an exact address first; titles use the longest matching name.
            for r in choices {
                if let Some(end) = prefix_match(rest, &r.address) { matches.push((r.address.clone(), end)); }
            }
            if matches.is_empty() {
                for r in choices {
                    if let Some(end) = r.title.as_deref().and_then(|t| prefix_match(rest, t)) { matches.push((r.address.clone(), end)); }
                }
                if let Some(longest) = matches.iter().map(|(_, n)| *n).max() { matches.retain(|(_, n)| *n == longest); }
            }
        }
        matches.sort(); matches.dedup();
        if matches.len() > 1 {
            let addresses: Vec<_> = matches.iter().take(3).map(|(address, _)| format!("@{address}")).collect();
            let hint = format!("That agent name is ambiguous. Choose a unique board address: {}.", addresses.join(", "));
            return Err(if mailbox_credential(&hint) { "That agent name is ambiguous. Find its unique board address in CodaClauda.".into() } else { hint });
        }
        let Some((to, end)) = matches.pop() else { return Err(format!("That agent name is unknown. {}", choice_hint(choices))); };
        (to, leading + 1 + end)
    } else {
        let Some(to) = last.filter(|to| choices.iter().any(|r| r.address == *to)) else { return Err(choice_hint(choices)); };
        (to.to_owned(), leading)
    };
    if to == ADDRESS { return Err("owner-phone is the phone reply address. Choose an agent instead.".into()); }
    let text = body[start..].trim_start();
    if text.trim().is_empty() { return Err("Message not forwarded: add text after the agent name.".into()); }
    Ok((to, body.len() - text.len()))
}
fn post_args(namespace: &str, item: &Incoming, receipt: &InboundReceipt) -> Value {
    let id = format!("phone-{:x}", Sha256::digest(scoped(namespace, &item.id)));
    let text = item.message.get(receipt.text_start..).unwrap_or("").trim();
    json!({"id": id, "from": ADDRESS, "to": receipt.to, "kind": "notice", "subject": "Ben (phone)", "body": text})
}
fn prepare(book: &mut Book, item: &Incoming, choices: &[Recipient], feedback: impl FnOnce(&str) -> Option<String>) -> Result<bool, Failure> {
    if book.own(item) { book.advance_cursor(&item.id); return Ok(false); }
    let id = scoped(book.topic_digest.as_deref().unwrap_or(""), &item.id);
    let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&(&item.title, &item.message)).unwrap_or_default()));
    if let Some(saved) = book.inbound.get(&id) {
        if saved.digest != digest { return Err(failure("PHONE_ID_COLLISION", "ntfy reused a message ID with changed text. Nothing further was forwarded.")); }
        let pending = !saved.done;
        if !pending { book.advance_cursor(&item.id); }
        return Ok(pending);
    }
    let now = coord_core::now();
    if item.time < book.created_at || item.time < now.saturating_sub(RETENTION) { book.advance_cursor(&item.id); return Ok(false); }
    book.inbound.retain(|_, r| !r.done || r.at >= now.saturating_sub(RETENTION));
    if book.inbound.len() >= RECEIPT_LIMIT { return Err(failure("PHONE_RECEIPT_LIMIT", "Too many recent phone messages. Older receipts expire after 30 days.")); }
    let routed = if mailbox_credential(&item.title) { Err(SCAN_REFUSAL.into()) }
        else { route(&item.message, book.last_recipient.as_deref(), choices) };
    let (to, text_start, feedback) = match routed {
        Ok((to, start)) => { let note = feedback(&to); (Some(to), start, note) },
        Err(note) => (None, 0, Some(note)),
    };
    book.inbound.insert(id, InboundReceipt { digest, to, text_start, feedback, at: now, ..Default::default() });
    Ok(true)
}

pub(super) struct Publication {
    pub id: String,
    pub title: String,
    pub subject: String,
    pub body: String,
    pub limit: usize,
    pub tag: &'static str,
    pub recipient: Option<String>,
}
fn board_publication(id: &str, item: &Value) -> Publication {
    let from = item["from"].as_str().unwrap_or("CodaClauda");
    let recipient = (from != ADDRESS && from != "owner" && from != "codaclauda-team").then(|| from.to_owned());
    Publication { id: format!("board:{id}"), title: from.into(), subject: item["subject"].as_str().unwrap_or("").into(),
        body: item["body"].as_str().unwrap_or("").into(), limit: 1000, tag: "", recipient }
}
fn outbound_text(title: &str, subject: &str, body: &str, limit: usize) -> (String, String, bool) {
    if [title, subject, body].iter().any(|text| mailbox_credential(text)) { return ("CodaClauda".into(), SCAN_REFUSAL.into(), true); }
    let title = title.chars().filter(|c| c.is_ascii() && !c.is_control()).take(80).collect();
    (title, body.chars().take(limit).collect(), false)
}
fn begin_push(book: &mut Book, publication: &Publication) -> Result<Option<(String, String, bool)>, Failure> {
    if book.outbound.contains_key(&publication.id) { return Ok(None); }
    let cutoff = coord_core::now().saturating_sub(RETENTION);
    book.outbound.retain(|_, r| r.at >= cutoff);
    book.published.retain(|_, at| *at >= cutoff);
    if book.outbound.len() >= RECEIPT_LIMIT || book.published.len() >= RECEIPT_LIMIT {
        return Err(failure("PHONE_RECEIPT_LIMIT", "Phone reply receipt storage is full. Older receipts expire after 30 days; replies remain on the board."));
    }
    let prepared = outbound_text(&publication.title, &publication.subject, &publication.body, publication.limit);
    book.outbound.insert(publication.id.clone(), PushReceipt { state: "sending".into(), at: coord_core::now() });
    Ok(Some(prepared))
}

fn topic_name(url: &str) -> Result<String, Failure> {
    let parsed = url::Url::parse(url).map_err(|_| failure("PHONE_TOPIC_INVALID", "Check your saved ntfy topic URL in Settings > Phone."))?;
    let name = parsed.path().trim_matches('/');
    if name.is_empty() || name.contains('/') || name.contains('%') || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(failure("PHONE_TOPIC_INVALID", "Use a plain HTTPS ntfy topic URL without query parameters or escaped characters."));
    }
    Ok(name.into())
}
async fn bounded_body(mut response: reqwest::Response, max: usize) -> Result<Vec<u8>, Failure> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| failure("PHONE_NETWORK_FAILED", "The ntfy response was interrupted."))? {
        if bytes.len().saturating_add(chunk.len()) > max { return Err(failure("PHONE_RESPONSE_TOO_LARGE", "The ntfy response exceeded its size limit.")); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn poll(url: &str, since: Option<&str>, created: u64) -> Result<Vec<PollEvent>, Failure> {
    let topic = topic_name(url)?;
    let client = notify::client().ok_or_else(|| failure("PHONE_NETWORK_FAILED", "The HTTPS client is unavailable."))?;
    let first = created.saturating_sub(1).to_string();
    let response = client.get(format!("{}/json", url.trim_end_matches('/')))
        .query(&[("poll", "1"), ("since", since.unwrap_or(&first))]).send().await
        .map_err(|_| failure("PHONE_NETWORK_FAILED", "The ntfy poll failed. Check your connection; polling will retry."))?;
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS { return Err(failure("PHONE_RATE_LIMITED", "ntfy is rate limiting this topic. Polling will retry after a short pause.")); }
    if !response.status().is_success() { return Err(failure("PHONE_NETWORK_FAILED", "ntfy refused the poll. Check the connection and saved topic URL.")); }
    if response.headers().get("X-Messages-Truncated").is_some_and(|v| v == "1") { return Err(failure("PHONE_POLL_TRUNCATED", "ntfy truncated its cached messages. Nothing from this poll was forwarded; check the topic for unwanted traffic.")); }
    parse_poll(&bounded_body(response, POLL_BYTES).await?, &topic)
}
fn published_id(bytes: &[u8]) -> Result<String, Failure> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| failure("PHONE_PUSH_UNKNOWN", UNKNOWN_PUSH))?;
    value["id"].as_str().filter(|id| valid_event_id(id)).map(str::to_owned).ok_or_else(|| failure("PHONE_PUSH_UNKNOWN", UNKNOWN_PUSH))
}
struct PushOutcome {
    result: Result<String, Failure>,
    http_status: Option<u16>,
    attempted: bool,
}
impl PushOutcome {
    fn receipt(&self, id: &str, refused: bool) -> Value {
        let (status, message) = match &self.result {
            Ok(_) if refused => ("refused", SCAN_REFUSAL),
            Ok(_) => ("sent", "ntfy accepted the notice. Check your phone; display on the phone is not confirmed."),
            Err(("PHONE_PUSH_FAILED" | "PHONE_CLIENT_UNAVAILABLE", text)) => ("failed", text.as_str()),
            Err((_, text)) => ("unknown", text.as_str()),
        };
        json!({"id": id, "status": status, "message": message, "ntfyId": self.result.as_ref().ok(), "httpStatus": self.http_status, "attempted": self.attempted})
    }
}
pub(super) fn refused_publication(id: &str, message: &str) -> Value {
    json!({"id": id, "status": "refused", "message": message, "ntfyId": null, "httpStatus": null, "attempted": false})
}
fn publish_tags(tag: &str) -> String {
    if tag.is_empty() { APP_TAG.to_owned() } else { format!("{APP_TAG},{tag}") }
}
fn response_outcome(status: u16, bytes: Result<&[u8], Failure>) -> PushOutcome {
    let result = if !(200..300).contains(&status) {
        Err(failure("PHONE_PUSH_FAILED", "ntfy returned an unsuccessful HTTP response. The notice was not retried; check the phone before sending another notice."))
    } else {
        bytes.and_then(published_id).map_err(|_| failure("PHONE_PUSH_UNKNOWN", UNKNOWN_PUSH))
    };
    PushOutcome { result, http_status: Some(status), attempted: true }
}
/// The only HTTP publish site. The tag suppresses a self-message even if the
/// app closes after ntfy accepts it but before its ID receipt is persisted.
async fn push(url: &str, title: &str, body: &str, tag: &str, actions: Option<&str>) -> PushOutcome {
    let Some(client) = notify::client() else {
        return PushOutcome { result: Err(failure("PHONE_CLIENT_UNAVAILABLE", "The HTTPS client is unavailable. No notice was sent.")), http_status: None, attempted: false };
    };
    let mut request = client.post(url).header("Title", title).header("Tags", publish_tags(tag));
    if let Some(actions) = actions { request = request.header("Actions", actions); }
    let response = match request.body(body.to_owned()).send().await {
        Ok(response) => response,
        Err(_) => return PushOutcome { result: Err(failure("PHONE_PUSH_UNKNOWN", UNKNOWN_PUSH)), http_status: None, attempted: true },
    };
    let status = response.status().as_u16();
    if !response.status().is_success() { return response_outcome(status, Ok(&[])); }
    let bytes = bounded_body(response, 64 * 1024).await;
    response_outcome(status, bytes.as_deref().map_err(|_| failure("PHONE_PUSH_UNKNOWN", UNKNOWN_PUSH)))
}

impl Inner {
    pub(super) fn load_phone(&self) {
        let book = read_book(&self.dir.join(FILE)).unwrap_or_else(|(_, error)| Book { enabled: false, last_error: Some(error), storage_failed: true, ..Book::default() });
        *lock(&self.phone) = book;
        if let Err((_, message)) = self.phone_bind(self.phone_reply_url().as_deref()) { self.phone_error(&message); }
    }
    pub(super) fn change_phone<T>(&self, update: impl FnOnce(&mut Book) -> Result<T, Failure>) -> Result<T, Failure> {
        let mut held = lock(&self.phone);
        if held.storage_failed { return Err(failure("PHONE_STORAGE_FAILED", STORAGE_ERROR)); }
        let mut next = held.clone();
        let result = update(&mut next)?;
        if let Err(e) = persist(&self.dir.join(FILE), &next) {
            held.enabled = false; held.last_error = Some(STORAGE_ERROR.into()); held.storage_failed = true;
            return Err(e);
        }
        *held = next;
        Ok(result)
    }
    pub(super) fn phone_error(&self, message: &str) { let _ = self.change_phone(|b| { b.last_error = Some(message.into()); Ok(()) }); }
    /// Caller holds phone_gate, or is initializing before any tasks start.
    pub(super) fn phone_bind(&self, url: Option<&str>) -> Result<(), Failure> {
        // Same synchronous gate as managed dispatch and desktop queue spawn.
        // Caller already holds phone_gate; never hold this across an await.
        let _lifecycle = lock(&self.lifecycle);
        if lock(&self.phone).topic_digest == url.map(url_digest) { return Ok(()); }
        let changed = self.change_phone(|b| b.bind(url, coord_core::now()))?;
        if changed { self.phone_approvals_reset(); }
        Ok(())
    }
    fn phone_directory(&self) -> Result<Value, Failure> {
        mailbox::api(&self.board_store()?, "directory", &json!({})).map_err(|_| failure("PHONE_BOARD_FAILED", "The board directory is unavailable."))
    }
    fn phone_view(&self) -> Result<Value, Failure> {
        let book = lock(&self.phone).clone();
        let directory = self.phone_directory();
        let last_error = book.last_error.clone().or_else(|| directory.as_ref().err().map(|(_, text)| text.clone()));
        let choices = recipients(&directory.unwrap_or_else(|_| json!({"addresses": []})), &lock(&self.state).records);
        let choices: Vec<_> = choices.iter().filter(|r| r.active || book.last_recipient.as_deref() == Some(&r.address))
            .map(|r| json!({"address": r.address, "label": r.title.as_deref().unwrap_or(&r.address)})).collect();
        let mut approvals = self.phone_approvals_view();
        approvals["enabled"] = json!(book.approvals);
        Ok(json!({"enabled": book.enabled, "topicUrl": self.phone_reply_url(), "lastRecipient": book.last_recipient, "recipients": choices, "lastError": last_error, "approvals": approvals}))
    }
    pub(super) fn phone_current(&self, revision: u64) -> bool { lock(&self.phone).current(revision) }
    pub(super) fn phone_approval_current(&self, revision: u64) -> bool { lock(&self.phone).approval_current(revision) }
    pub(super) fn phone_approvals_on(&self) -> bool { let book = lock(&self.phone); book.approvals && book.enabled && !book.storage_failed }
    pub(super) fn phone_created_at(&self) -> u64 { lock(&self.phone).created_at }
    /// "approve <code>" / "deny <code>": an answer to an approval request (phone_approvals.rs).
    /// Receipted like any phone message so a re-poll never applies it twice, but never posted
    /// as a board notice. Ok(false): not an answer, or one prepare() already handles.
    fn phone_answer(&self, item: &Incoming, store: &Store) -> Result<bool, Failure> {
        if mailbox_credential(&item.message) || mailbox_credential(&item.title) || item.message.len() > MESSAGE_BYTES { return Ok(false); }
        let Some((decision, code, note)) = phone_approvals::parse_decision(&item.message) else { return Ok(false) };
        let now = coord_core::now();
        {
            let book = lock(&self.phone);
            let id = scoped(book.topic_digest.as_deref().unwrap_or(""), &item.id);
            if book.own(item) || book.inbound.contains_key(&id) || item.time < book.created_at || item.time < now.saturating_sub(RETENTION) { return Ok(false); }
        }
        let feedback = self.phone_decide(decision, &code, &note, store);
        let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&(&item.title, &item.message)).unwrap_or_default()));
        self.change_phone(|book| {
            let id = scoped(book.topic_digest.as_deref().unwrap_or(""), &item.id);
            book.inbound.insert(id, InboundReceipt { digest, to: None, text_start: 0, feedback: Some(feedback), at: now, done: true, ..Default::default() });
            book.advance_cursor(&item.id);
            Ok(())
        })?;
        Ok(true)
    }
    fn phone_register(&self) -> Result<Store, Failure> {
        let store = self.board_store()?;
        mailbox::api(&store, "register", &json!({"name": ADDRESS, "label": "Ben (phone)"}))
            .map_err(|_| failure("PHONE_BOARD_FAILED", "The phone reply address could not be registered on the board."))?;
        Ok(store)
    }
    fn phone_incoming(&self, item: &Incoming, store: &Store) -> Result<(), Failure> {
        if self.phone_answer(item, store)? { return Ok(()); }
        let records = lock(&self.state).records.clone();
        let choices = recipients(&self.phone_directory()?, &records);
        let wake = self.wake_enabled();
        let pending = self.change_phone(|book| prepare(book, item, &choices, |to| {
            match records.iter().find(|r| r.mailbox_address.as_deref() == Some(to)) {
                Some(r) if !wake || !r.wake || r.status == "closed" => Some("Saved to the board, but this session cannot wake now. Check Wake on mail in CodaClauda.".into()),
                Some(_) => None,
                None => Some("Saved to the board. This address has no CodaClauda session to wake; its recipient must check the board.".into()),
            }
        }))?;
        if !pending { return Ok(()); }
        let (id, namespace, receipt) = {
            let book = lock(&self.phone);
            let namespace = book.topic_digest.clone().unwrap_or_default();
            let id = scoped(&namespace, &item.id);
            (id.clone(), namespace, book.inbound[&id].clone())
        };
        if receipt.to.is_some() && mailbox::post_reserved(store, &post_args(&namespace, item, &receipt)).is_err() {
            self.change_phone(|b| { b.inbound.get_mut(&id).unwrap().feedback = Some("The message could not be confirmed on the board. CodaClauda will retry the same message ID; check Settings > Phone.".into()); Ok(()) })?;
            return Err(failure("PHONE_BOARD_FAILED", "The phone message could not be confirmed on the board. The same message ID will be retried."));
        }
        self.change_phone(|book| { book.inbound.get_mut(&id).unwrap().done = true; book.advance_cursor(&item.id); Ok(()) })
    }
    /// Called under phone_gate, so URL changes/disable cannot race publication.
    pub(super) async fn phone_publish_locked(&self, url: &str, publication: Publication) -> Result<Value, Failure> {
        self.phone_publish_actions_locked(url, publication, None).await
    }
    /// Like phone_publish_locked, with ntfy action buttons (approval requests). A refused
    /// (credential) notice never carries buttons.
    pub(super) async fn phone_publish_actions_locked(&self, url: &str, publication: Publication, actions: Option<&str>) -> Result<Value, Failure> {
        let prepared = self.change_phone(|b| begin_push(b, &publication))?;
        if let Some((title, body, refused)) = prepared {
            let outcome = push(url, &title, &body, publication.tag, if refused { None } else { actions }).await;
            let mut receipt = outcome.receipt(&publication.id, refused);
            if self.change_phone(|b| {
                b.complete_push(&publication.id, outcome.result.as_deref(), refused, publication.recipient.as_deref());
                Ok(())
            }).is_err() {
                // The durable pre-dispatch receipt still prevents replay. Never
                // describe a post-dispatch save failure as "nothing was sent".
                receipt["status"] = json!("unknown");
                receipt["message"] = json!("The outcome could not be saved. The notice may have been sent and will not be retried automatically. Check your phone and repair phone receipt storage.");
            }
            return Ok(receipt);
        }
        let book = lock(&self.phone);
        let state = book.outbound.get(&publication.id).map(|r| r.state.as_str()).unwrap_or("unknown");
        Ok(json!({"id": publication.id, "status": if state == "sending" { "unknown" } else { state }, "message": "This notice already has an attempt receipt. It was not sent again.", "ntfyId": null, "httpStatus": null, "attempted": false}))
    }
    /// Finish/error/wake warnings use this same tagged, scanned, durable path.
    /// Their own notify switches are independent of the inbound-message switch.
    pub(super) fn phone_notification(&self, publication: Publication) {
        let Some(inner) = self.me.upgrade() else { return; };
        let expected_url = self.phone_reply_url();
        tauri::async_runtime::spawn(async move {
            let _gate = inner.phone_gate.lock().await;
            let Some(url) = inner.phone_reply_url() else { return; };
            if Some(&url) != expected_url.as_ref() { return; }
            if let Err((_, message)) = inner.phone_publish_locked(&url, publication).await { inner.phone_error(&message); }
        });
    }
    async fn phone_feedback(&self, revision: u64) -> Result<(), Failure> {
        let ids: Vec<_> = lock(&self.phone).inbound.iter().filter(|(_, r)| r.feedback.is_some() && !r.feedback_attempted).take(20).map(|(id, _)| id.clone()).collect();
        for id in ids {
            let _gate = self.phone_gate.lock().await;
            if !self.phone_current(revision) { break; }
            let Some(url) = self.phone_reply_url() else { break; };
            let body = lock(&self.phone).inbound[&id].feedback.clone().unwrap();
            self.phone_publish_locked(&url, Publication { id: format!("feedback:{id}"), title: "CodaClauda".into(), subject: String::new(), body, limit: 1000, tag: "", recipient: None }).await?;
            self.change_phone(|b| { b.inbound.get_mut(&id).unwrap().feedback_attempted = true; Ok(()) })?;
        }
        Ok(())
    }
    async fn phone_outbound(&self, revision: u64, store: &Store) -> Result<(), Failure> {
        let page = mailbox::api(store, "inbox", &json!({"addr": ADDRESS, "unread": true, "limit": 20})).map_err(|_| failure("PHONE_BOARD_FAILED", "The phone reply inbox could not be read."))?;
        for item in page["messages"].as_array().into_iter().flatten() {
            let _gate = self.phone_gate.lock().await;
            if !self.phone_current(revision) { break; }
            let Some(url) = self.phone_reply_url() else { break; };
            let Some(id) = item["id"].as_str() else { continue; };
            self.phone_publish_locked(&url, board_publication(id, item)).await?;
            // Acknowledged means processed by this bridge, not read on the phone.
            mailbox::api(store, "ack", &json!({"addr": ADDRESS, "id": id})).map_err(|_| failure("PHONE_BOARD_FAILED", "A phone reply was processed but could not be acknowledged on the board."))?;
        }
        Ok(())
    }
    async fn phone_tick(&self) -> Result<(), Failure> {
        // URL and revision are one snapshot. notify_set holds this gate while
        // updating both, so a new revision can never authorize an old URL fetch.
        let (snapshot, url) = {
            let _gate = self.phone_gate.lock().await;
            let snapshot = lock(&self.phone).clone();
            if !snapshot.current(snapshot.revision) { return Ok(()); }
            let Some(url) = self.phone_reply_url() else { return Ok(()); };
            (snapshot, url)
        };
        let fetched = poll(&url, snapshot.last_id.as_deref(), snapshot.created_at).await;
        let store = {
            let _gate = self.phone_gate.lock().await;
            if !self.phone_current(snapshot.revision) { return Ok(()); }
            self.phone_register()?
        };
        let consumed = match &fetched {
            Ok(items) => walk_poll(items, |item| async {
                let _gate = self.phone_gate.lock().await;
                if !self.phone_current(snapshot.revision) { return Ok(false); }
                match item {
                    PollEvent::Message(message) => self.phone_incoming(message, &store)?,
                    PollEvent::Skip(id) => self.change_phone(|book| { book.advance_cursor(id); Ok(()) })?,
                }
                Ok(true)
            }).await,
            Err(error) => Err(error.clone()),
        };
        if let Err((_, message)) = &consumed { self.phone_error(message); }
        self.phone_feedback(snapshot.revision).await?;
        self.phone_outbound(snapshot.revision, &store).await?;
        self.phone_approval_requests(snapshot.revision, &store).await?;
        consumed
    }
}

pub(super) fn spawn_watcher(inner: Arc<Inner>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let outcome = inner.phone_tick().await;
            let pause = if matches!(outcome, Err(("PHONE_RATE_LIMITED", _))) { Duration::from_secs(60) } else { POLL_EVERY };
            if let Err((_, message)) = outcome { inner.phone_error(&message); }
            tokio::time::sleep(pause).await;
        }
    });
}

#[tauri::command]
pub(crate) async fn phone_settings_get(app: tauri::AppHandle) -> Value { reply(host(&app).phone_view()) }

#[tauri::command]
pub(crate) async fn phone_settings_set(app: tauri::AppHandle, enabled: bool) -> Value {
    let inner = host(&app);
    let _gate = inner.phone_gate.lock().await;
    let result = (|| {
        let _lifecycle = lock(&inner.lifecycle);
        if !enabled && lock(&inner.phone).storage_failed { lock(&inner.phone).enabled = false; return inner.phone_view(); }
        inner.change_phone(|b| b.settings(enabled))?;
        inner.phone_approvals_reset();
        inner.phone_view()
    })();
    reply(result)
}

/// Turn phone approvals on or off (Settings > Phone); messaging itself is unchanged.
#[tauri::command]
pub(crate) async fn phone_approvals_set(app: tauri::AppHandle, enabled: bool) -> Value {
    let inner = host(&app);
    let _gate = inner.phone_gate.lock().await;
    let _lifecycle = lock(&inner.lifecycle);
    reply(inner.change_phone(|b| { b.approvals = enabled; b.revision = b.revision.wrapping_add(1); Ok(()) }).and_then(|_| { inner.phone_approvals_reset(); inner.phone_view() }))
}

/// After five wrong codes phone approvals lock; only the owner, on the PC, unlocks them.
#[tauri::command]
pub(crate) async fn phone_approvals_unlock(app: tauri::AppHandle) -> Value {
    let inner = host(&app);
    let _gate = inner.phone_gate.lock().await;
    reply(inner.phone_approvals_unlock().and_then(|_| inner.phone_view()))
}

#[cfg(test)]
#[path = "phone_tests.rs"]
mod tests;
