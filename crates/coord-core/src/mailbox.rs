//! Passive, self-asserted mailboxes. This sidecar never reads or writes the
//! coordination state, launches providers, or grants authority to act. A post
//! reads only the desktop app's host lease (heartbeat.rs), to say who will
//! pick it up; a passive post never starts anything.
use crate::{heartbeat, store::Store};
use anyhow::{Context, Result, bail, ensure};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
    time::{Duration, Instant},
};

const RETENTION: u64 = 30 * 24 * 60 * 60;
const MAX_STATE: usize = 64 * 1024 * 1024;
const SEEDS: [(&str, &str); 5] = [
    ("claude-phaseforge", "Claude Code PhaseForge release session"),
    ("codex-marketplace", "Rebuild DeloresAI marketplace"),
    ("codex-dgxbridge", "Build Spark Dev Bridge"),
    ("codex-claudacoda", "CodaClauda Codex chat"),
    ("owner", "Ben"),
];

/// Advisory collision, not an authorization failure. The caller may expose this
/// public claim record and map this type to CLI exit code 3.
#[derive(Debug)]
pub struct ClaimConflict {
    pub current_holder: Value,
}
impl std::fmt::Display for ClaimConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The resource has an active claim held by another mailbox address")
    }
}
impl std::error::Error for ClaimConflict {}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Address {
    name: String,
    label: String,
    created_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Message {
    id: String,
    sequence: u64,
    to: String,
    from: String,
    kind: String,
    subject: String,
    body: String,
    created_at: u64,
    read_at: Option<u64>,
    reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resource: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredMessage {
    message: Message,
    digest: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Claim {
    resource: String,
    holder: String,
    purpose: String,
    message_id: String,
    created_at: u64,
    expires_at: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Mailbox {
    schema: u32,
    next_sequence: u64,
    addresses: BTreeMap<String, Address>,
    messages: BTreeMap<String, StoredMessage>,
    claims: BTreeMap<String, Claim>,
}
impl Mailbox {
    fn new(now: u64) -> Self {
        Self {
            schema: 1,
            next_sequence: 1,
            addresses: SEEDS.into_iter().map(|(name, label)| {
                (name.into(), Address { name: name.into(), label: label.into(), created_at: now })
            }).collect(),
            messages: BTreeMap::new(),
            claims: BTreeMap::new(),
        }
    }
    fn prune(&mut self, now: u64) {
        self.messages.retain(|_, stored| now.saturating_sub(stored.message.created_at) < RETENTION);
        self.claims.retain(|_, claim| claim.expires_at > now);
    }
    fn address(&self, name: &str) -> Result<()> {
        ensure!(self.addresses.contains_key(name), "Mailbox address is not registered");
        Ok(())
    }
}

fn no_link(metadata: &fs::Metadata) -> Result<()> {
    ensure!(!metadata.file_type().is_symlink(), "Mailbox storage cannot use symbolic links");
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        ensure!(metadata.file_attributes() & 0x400 == 0, "Mailbox storage cannot use reparse points");
    }
    Ok(())
}
fn check_path(path: &Path, optional: bool) -> Result<()> {
    ensure!(path.is_absolute(), "Mailbox storage must be absolute");
    for (index, part) in path.ancestors().enumerate() {
        match fs::symlink_metadata(part) {
            Ok(metadata) => no_link(&metadata)?,
            Err(e) if index == 0 && optional && e.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => bail!("Mailbox storage is missing or inaccessible"),
        }
    }
    Ok(())
}
fn open_private(path: &Path, create: bool) -> Result<File> {
    check_path(path, create)?;
    let mut options = OpenOptions::new();
    options.read(true).write(create).create(create).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000).share_mode(if create { 3 } else { 1 });
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path).context("Mailbox storage cannot be opened")?;
    let metadata = file.metadata().context("Mailbox storage cannot be checked")?;
    no_link(&metadata)?;
    ensure!(metadata.is_file(), "Mailbox storage is not a regular file");
    check_path(path, false)?;
    Ok(file)
}
fn transaction<T>(store: &Store, now: u64, action: impl FnOnce(&mut Mailbox) -> Result<T>) -> Result<T> {
    check_path(&store.root, false)?;
    ensure!(store.root.is_dir(), "Mailbox board directory is unavailable");
    let lock = open_private(&store.root.join("mailbox.lock"), true)?;
    FileExt::lock_exclusive(&lock).context("Mailbox lock is unavailable")?;
    let path = store.root.join("mailbox.json");
    let original = match fs::symlink_metadata(&path) {
        Ok(_) => {
            let file = open_private(&path, false)?;
            let mut bytes = Vec::new();
            file.take((MAX_STATE + 1) as u64).read_to_end(&mut bytes).context("Mailbox cannot be read")?;
            ensure!(bytes.len() <= MAX_STATE, "Mailbox exceeds its storage limit");
            Some(bytes)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => bail!("Mailbox is inaccessible; preserve it before repair"),
    };
    let mut state: Mailbox = match &original {
        Some(bytes) => serde_json::from_slice(bytes).context("Mailbox is invalid; preserve it before repair")?,
        None => Mailbox::new(now),
    };
    ensure!(state.schema == 1 && state.next_sequence > 0, "Unsupported mailbox schema or cursor");
    ensure!(state.messages.values().all(|v| v.message.sequence > 0 && v.message.sequence < state.next_sequence), "Mailbox cursor is inconsistent; preserve it before repair");
    state.prune(now);
    let result = action(&mut state)?;
    let bytes = serde_json::to_vec(&state)?;
    ensure!(bytes.len() <= MAX_STATE, "Mailbox exceeds its storage limit");
    if original.as_deref() != Some(bytes.as_slice()) {
        let mut temp = tempfile::NamedTempFile::new_in(&store.root).context("Mailbox write cannot be reserved")?;
        temp.write_all(&bytes).context("Mailbox write failed")?;
        temp.as_file().sync_all().context("Mailbox write could not be synchronized")?;
        check_path(&path, true)?;
        temp.persist(&path).map_err(|e| e.error).context("Mailbox could not be atomically saved")?;
        #[cfg(unix)]
        File::open(&store.root)?.sync_all()?;
    }
    Ok(result)
}

/// The mailbox's own credential rule: real key shapes and credential
/// assignments are refused; ordinary words and prose mentions are not.
fn secret(text: &str) -> bool {
    crate::secrets::mailbox_credential(text)
}
fn text(args: &Value, key: &str, max: usize, empty: bool) -> Result<String> {
    let value = args.get(key).and_then(Value::as_str).ok_or_else(|| anyhow::anyhow!("Mailbox text field is missing or invalid"))?;
    ensure!(value.len() <= max && (empty || !value.trim().is_empty()) && !value.contains('\0'), "Mailbox text field is empty or exceeds its limit");
    ensure!(!secret(value), "Mailbox content contains a recognizable credential or pairing code");
    Ok(value.to_owned())
}
fn name_value(value: &str) -> Result<String> {
    ensure!(!secret(value), "Mailbox content contains a recognizable credential or pairing code");
    let name = value.trim().to_ascii_lowercase();
    ensure!(!name.is_empty() && name.len() <= 80 && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b)), "Mailbox address must use 1 to 80 letters, digits, dots, underscores or hyphens");
    Ok(name)
}
fn name(args: &Value, key: &str) -> Result<String> {
    name_value(&text(args, key, 160, false)?)
}
fn identifier(args: &Value, key: &str) -> Result<String> {
    let value = text(args, key, 128, false)?;
    ensure!(value.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b)), "Mailbox message ID has invalid characters");
    Ok(value)
}
fn fields(args: &Value, allowed: &[&str], required: &[&str]) -> Result<()> {
    let values = args.as_object().ok_or_else(|| anyhow::anyhow!("Mailbox arguments must be an object"))?;
    ensure!(values.keys().all(|key| allowed.contains(&key.as_str())) && required.iter().all(|key| values.contains_key(*key)), "Mailbox arguments contain missing or unsupported fields");
    Ok(())
}
fn number(args: &Value, key: &str, default: u64, low: u64, high: u64) -> Result<u64> {
    let value = match args.get(key) {
        None => default,
        Some(value) => value.as_u64().ok_or_else(|| anyhow::anyhow!("Mailbox numeric argument must be an unsigned integer"))?,
    };
    ensure!((low..=high).contains(&value), "Mailbox numeric argument is outside its supported range");
    Ok(value)
}
fn resource(args: &Value) -> Result<String> {
    let value = text(args, "resource", 1024, false)?;
    ensure!(!value.chars().any(char::is_control), "Mailbox resource cannot contain control characters");
    Ok(value.trim().to_owned())
}
#[derive(Clone, Serialize)]
struct Post {
    to: String,
    from: String,
    kind: String,
    subject: String,
    body: String,
    reply_to: Option<String>,
    resource: Option<String>,
    ttl: Option<u64>,
}
fn post(args: &Value) -> Result<(String, Post)> {
    fields(args, &["to", "from", "kind", "subject", "body", "reply_to", "id", "resource", "ttl"], &["to", "from", "kind", "subject", "body"])?;
    let id = if args.get("id").is_some() { identifier(args, "id")? } else { uuid::Uuid::new_v4().to_string() };
    let kind = text(args, "kind", 16, false)?;
    ensure!(["notice", "question", "reply", "claim", "release"].contains(&kind.as_str()), "Unsupported mailbox message kind");
    let subject = text(args, "subject", 512, true)?;
    ensure!(!subject.chars().any(char::is_control), "Mailbox subject cannot contain control characters");
    let body = text(args, "body", 32768, true)?;
    let reply_to = args.get("reply_to").map(|_| identifier(args, "reply_to")).transpose()?;
    ensure!(kind == "reply" || reply_to.is_none(), "Only replies can set reply_to");
    let resource = args.get("resource").map(|_| resource(args)).transpose()?;
    ensure!(!matches!(kind.as_str(), "claim" | "release") || resource.is_some(), "Claim and release messages require a resource");
    let ttl = if kind == "claim" { Some(number(args, "ttl", 30, 1, 120)?) } else {
        ensure!(args.get("ttl").is_none(), "Only claim messages accept ttl");
        None
    };
    Ok((id, Post { to: name(args, "to")?, from: name(args, "from")?, kind, subject, body, reply_to, resource, ttl }))
}
/// The digest behind stable ids: the post with its parent resolved.
fn digest(post: &Post) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(post)?)))
}
/// Questions and notices from `to` to `from` that `from` has not replied to, newest first.
fn open_threads<'a>(state: &'a Mailbox, from: &str, to: &str) -> Vec<&'a Message> {
    let all = || state.messages.values().map(|v| &v.message);
    let answered: HashSet<&str> = all().filter(|m| m.from == from && m.to == to).filter_map(|m| m.reply_to.as_deref()).collect();
    let mut open: Vec<_> = all()
        .filter(|m| m.from == to && m.to == from && matches!(m.kind.as_str(), "question" | "notice") && !answered.contains(m.id.as_str()))
        .collect();
    open.sort_by_key(|m| std::cmp::Reverse(m.sequence));
    open
}
fn save_post(state: &mut Mailbox, id: &str, post: &Post, now: u64) -> Result<Value> {
    if let Some(existing) = state.messages.get(id) {
        // A retry takes the parent the first post resolved, then compares.
        let mut resolved = post.clone();
        if resolved.kind == "reply" && resolved.reply_to.is_none() {
            resolved.reply_to = existing.message.reply_to.clone();
        }
        // The second digest is how a 0.6.0 inferred reply was saved.
        ensure!(existing.digest == digest(&resolved)? || existing.digest == digest(post)?, "Message ID already exists with a different payload");
        return Ok(serde_json::to_value(&existing.message)?);
    }
    state.address(&post.from)?;
    // The team inbox exists before the app first runs, so saving never waits for it.
    if post.to == heartbeat::TEAM_ADDRESS && !state.addresses.contains_key(&post.to) {
        let label = "CodaClauda team requests".into();
        state.addresses.insert(post.to.clone(), Address { name: post.to.clone(), label, created_at: now });
    }
    state.address(&post.to)?;
    let mut post = post.clone();
    // A reply without reply_to answers the open question or notice from its recipient, when exactly one is open.
    if post.kind == "reply" && post.reply_to.is_none() {
        let open = open_threads(state, &post.from, &post.to);
        post.reply_to = Some(match open.as_slice() {
            [only] => only.id.clone(),
            [] => bail!("Nothing from {} to {} is waiting for a reply; pass --reply-to <message id>", post.to, post.from),
            many => {
                let mut ids: Vec<&str> = many.iter().take(10).map(|m| m.id.as_str()).collect();
                if many.len() > 10 {
                    ids.push("...");
                }
                bail!("{} messages from {} to {} are waiting for a reply ({}); pass --reply-to with one of these ids", many.len(), post.to, post.from, ids.join(", "))
            }
        });
    }
    if let Some(parent_id) = &post.reply_to {
        let parent = &state.messages.get(parent_id).ok_or_else(|| anyhow::anyhow!("Reply message is unavailable or outside retention"))?.message;
        ensure!(parent.to == post.from && parent.from == post.to, "Reply must reverse the original sender and recipient");
    }
    if matches!(post.kind.as_str(), "claim" | "release") {
        let resource = post.resource.as_ref().expect("validated claim resource");
        if let Some(current) = state.claims.get(resource) {
            if current.holder != post.from {
                return Err(ClaimConflict { current_holder: serde_json::to_value(current)? }.into());
            }
        } else {
            ensure!(post.kind != "release", "There is no active claim to release");
        }
        if post.kind == "claim" {
            state.claims.insert(resource.clone(), Claim {
                resource: resource.clone(), holder: post.from.clone(), purpose: post.subject.clone(),
                message_id: id.to_owned(), created_at: now, expires_at: now.saturating_add(post.ttl.expect("validated ttl") * 60),
            });
        } else {
            state.claims.remove(resource);
        }
    }
    let digest = digest(&post)?;
    let sequence = state.next_sequence;
    state.next_sequence = sequence.checked_add(1).ok_or_else(|| anyhow::anyhow!("Mailbox sequence limit reached"))?;
    let message = Message {
        id: id.to_owned(), sequence, to: post.to.clone(), from: post.from.clone(), kind: post.kind.clone(),
        subject: post.subject.clone(), body: post.body.clone(), created_at: now, read_at: None,
        reply_to: post.reply_to.clone(), resource: post.resource.clone(),
    };
    let result = serde_json::to_value(&message)?;
    state.messages.insert(id.to_owned(), StoredMessage { message, digest });
    Ok(result)
}

/// App progress replies; every other reply is a terminal answer. 0.6.0 said "received".
const ACKNOWLEDGEMENTS: [&str; 3] = ["queued", "admitted", "received"];
/// "acknowledgement" for a reply whose body is one of those JSON objects, else "terminal".
fn reply_kind(message: &Message) -> &'static str {
    let single = serde_json::from_str::<Value>(&message.body).ok().and_then(|v| match v {
        Value::Object(o) if o.len() == 1 => o.keys().next().cloned(),
        _ => None,
    });
    if single.is_some_and(|k| ACKNOWLEDGEMENTS.contains(&k.as_str())) { "acknowledgement" } else { "terminal" }
}

/// What a post to codaclauda-team asks for, as its sender should understand it.
fn team_request(post: &Post, id: &str, host: &str) -> Value {
    let body: Value = serde_json::from_str(&post.body).unwrap_or(Value::Null);
    let start = body.get("start").is_some_and(Value::is_object);
    let cancel = format!(
        r#"To cancel it before a teammate launches, post --kind notice to {} with body {{"cancel":{{"requestId":"{id}"}}}} and a new --id. Ben can cancel it in Settings > Team."#,
        heartbeat::TEAM_ADDRESS
    );
    match (post.kind.as_str(), start) {
        ("question", true) => json!({
            "state": "queued", "requestId": id, "cancel": cancel,
            "note": if host == "available" { "Nothing has started yet. Replies follow: queued, then admitted once a teammate actually launches, then the outcome." }
                else { "Nothing has started. It stays queued and starts only when CodaClauda runs within 24 hours, unless it is cancelled first; after that it is refused, never started late." },
        }),
        ("notice", true) => json!({"state": "passive", "note": "A notice never starts a teammate. Post the same body with --kind question to ask for one."}),
        _ => match body["cancel"]["requestId"].as_str() {
            Some(target) => json!({"state": "cancel-requested", "requestId": target}),
            None => Value::Null,
        },
    }
}

/// Plain addresses identify the caller's asserted role only. No operation here
/// verifies a provider identity or treats mailbox text as owner authorization.
pub fn api(store: &Store, op: &str, args: &Value) -> Result<Value> {
    api_with_clock(store, op, args, &crate::now)
}
fn api_with_clock(store: &Store, op: &str, args: &Value, clock: &dyn Fn() -> u64) -> Result<Value> {
    match op {
        "register" => {
            fields(args, &["name", "label"], &["name"])?;
            let name = name(args, "name")?;
            let supplied_label = args.get("label").map(|_| text(args, "label", 480, false)).transpose()?;
            if let Some(label) = &supplied_label {
                ensure!(label.chars().count() <= 120 && !label.chars().any(char::is_control), "Mailbox label exceeds its limit or contains control characters");
            }
            let now = clock();
            transaction(store, now, |state| {
                if let Some(existing) = state.addresses.get_mut(&name) {
                    if let Some(label) = &supplied_label { existing.label = label.trim().into(); }
                    return Ok(serde_json::to_value(existing)?);
                }
                let address = Address { label: supplied_label.as_deref().unwrap_or(&name).trim().into(), name: name.clone(), created_at: now };
                state.addresses.insert(name, address.clone());
                Ok(serde_json::to_value(address)?)
            })
        }
        "directory" => {
            fields(args, &[], &[])?;
            transaction(store, clock(), |state| Ok(json!({"addresses":state.addresses.values().collect::<Vec<_>>(),"identity":"self-asserted-label"})))
        }
        "post" => {
            let (id, post) = post(args)?;
            let now = clock();
            let mut saved = transaction(store, now, |state| save_post(state, &id, &post, now))?;
            let mut delivery = heartbeat::delivery(&store.root, &post.to, now.saturating_mul(1000));
            if post.to == heartbeat::TEAM_ADDRESS {
                let host = delivery["host"].as_str().unwrap_or("unknown").to_owned();
                delivery["request"] = team_request(&post, &id, &host);
            }
            saved["delivery"] = delivery;
            Ok(saved)
        }
        "inbox" => {
            fields(args, &["addr", "since", "limit", "unread"], &["addr"])?;
            let addr = name(args, "addr")?;
            let since = number(args, "since", 0, 0, u64::MAX)?;
            let limit = number(args, "limit", 20, 1, 100)? as usize;
            let unread = match args.get("unread") { None => false, Some(v) => v.as_bool().ok_or_else(|| anyhow::anyhow!("unread must be boolean"))? };
            transaction(store, clock(), |state| {
                state.address(&addr)?;
                let mut messages: Vec<_> = state.messages.values().map(|v| &v.message).filter(|m| m.to == addr && m.sequence > since && (!unread || m.read_at.is_none())).collect();
                messages.sort_by_key(|m| m.sequence);
                let more = messages.len() > limit;
                messages.truncate(limit);
                let cursor = messages.last().map_or(since, |m| m.sequence);
                Ok(json!({"messages":messages,"next_cursor":cursor,"has_more":more}))
            })
        }
        "ack" => {
            fields(args, &["addr", "id"], &["addr", "id"])?;
            let addr = name(args, "addr")?;
            let id = identifier(args, "id")?;
            let now = clock();
            transaction(store, now, |state| {
                state.address(&addr)?;
                let message = &mut state.messages.get_mut(&id).ok_or_else(|| anyhow::anyhow!("Mailbox message is unavailable"))?.message;
                ensure!(message.to == addr, "Only the addressed recipient can acknowledge this message");
                message.read_at.get_or_insert(now);
                Ok(serde_json::to_value(message)?)
            })
        }
        "wait-reply" => {
            // Default: the first reply of any kind (unchanged). terminal: the first
            // reply that is not an acknowledgement, plus the latest acknowledgement.
            fields(args, &["id", "timeout", "terminal"], &["id"])?;
            let id = identifier(args, "id")?;
            let timeout = number(args, "timeout", 20, 0, 60)?;
            let terminal = match args.get("terminal") {
                None => false,
                Some(v) => v.as_bool().ok_or_else(|| anyhow::anyhow!("terminal must be boolean"))?,
            };
            let deadline = Instant::now() + Duration::from_secs(timeout);
            loop {
                let (reply, acknowledgement) = transaction(store, clock(), |state| {
                    ensure!(state.messages.contains_key(&id), "Original mailbox message is unavailable");
                    let mut replies: Vec<&Message> = state.messages.values().map(|v| &v.message).filter(|m| m.reply_to.as_deref() == Some(id.as_str())).collect();
                    replies.sort_by_key(|m| m.sequence);
                    if !terminal {
                        return Ok((replies.first().map(|m| (*m).clone()), None));
                    }
                    let last = replies.iter().rev().find(|m| reply_kind(m) == "acknowledgement").map(|m| (*m).clone());
                    Ok((replies.iter().find(|m| reply_kind(m) == "terminal").map(|m| (*m).clone()), last))
                })?;
                if reply.is_some() || Instant::now() >= deadline {
                    let mut out = json!({"timed_out":reply.is_none(),"reply_kind":reply.as_ref().map(reply_kind),"reply":reply});
                    if terminal {
                        out["acknowledgement"] = json!(acknowledgement);
                    }
                    return Ok(out);
                }
                std::thread::sleep(Duration::from_millis(100).min(deadline.saturating_duration_since(Instant::now())));
            }
        }
        "claims" => {
            fields(args, &["resource"], &[])?;
            let resource = args.get("resource").map(|_| resource(args)).transpose()?;
            transaction(store, clock(), |state| Ok(json!({"claims":state.claims.values().filter(|c| resource.as_ref().is_none_or(|r| r == &c.resource)).collect::<Vec<_>>()})))
        }
        _ => bail!("Unsupported mailbox operation"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Store) {
        let root = tempfile::tempdir().unwrap();
        let store = Store::new(Some(root.path().to_owned())).unwrap();
        (root, store)
    }
    fn at(store: &Store, op: &str, args: Value, now: u64) -> Result<Value> {
        api_with_clock(store, op, &args, &|| now)
    }
    fn message(id: &str) -> Value {
        json!({"id":id,"to":"codex-claudacoda","from":"owner","kind":"question","subject":"Review","body":"Please inspect the change."})
    }
    fn claim(id: &str, from: &str) -> Value {
        json!({"id":id,"to":"owner","from":from,"kind":"claim","subject":"Release verification","body":"Advisory claim only","resource":"shared test rig","ttl":1})
    }
    #[test]
    fn seeds_sidecar_without_reading_or_mutating_legacy_state() {
        let (_dir, store) = fixture();
        let old = b"legacy bytes intentionally not parsed";
        fs::write(store.root.join("state.json"), old).unwrap();
        let directory = at(&store, "directory", json!({}), 100).unwrap();
        assert_eq!(directory["addresses"].as_array().unwrap().len(), 5);
        assert_eq!(directory["identity"], "self-asserted-label");
        assert_eq!(fs::read(store.root.join("state.json")).unwrap(), old);
        assert!(!store.root.join("state.lock").exists());
        at(&store, "register", json!({"name":"New-Role","label":"New role"}), 101).unwrap();
        assert_eq!(at(&store, "directory", json!({}), 102).unwrap()["addresses"].as_array().unwrap().len(), 6);
    }
    #[test]
    fn stable_posts_replay_once_and_reject_changed_payload_after_restart() {
        let (_dir, store) = fixture();
        let first = at(&store, "post", message("stable"), 100).unwrap();
        let reopened = Store::new(Some(store.root.clone())).unwrap();
        assert_eq!(first, at(&reopened, "post", message("stable"), 200).unwrap());
        let mut changed = message("stable"); changed["body"] = json!("Different");
        assert!(at(&reopened, "post", changed, 201).is_err());
        let inbox = at(&reopened, "inbox", json!({"addr":"codex-claudacoda"}), 202).unwrap();
        assert_eq!(inbox["messages"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn inbox_reads_do_not_ack_and_cursor_pages_are_oldest_first() {
        let (_dir, store) = fixture();
        for id in ["z", "a", "m"] { at(&store, "post", message(id), 100).unwrap(); }
        let page = at(&store, "inbox", json!({"addr":"codex-claudacoda","limit":2,"unread":true}), 101).unwrap();
        assert_eq!(page["messages"][0]["id"], "z");
        assert_eq!(page["messages"][1]["id"], "a");
        assert_eq!(page["has_more"], true);
        assert!(page["messages"][0]["read_at"].is_null());
        let next = at(&store, "inbox", json!({"addr":"codex-claudacoda","since":page["next_cursor"]}), 102).unwrap();
        assert_eq!(next["messages"][0]["id"], "m");
        assert!(at(&store, "ack", json!({"addr":"owner","id":"z"}), 103).is_err());
        at(&store, "ack", json!({"addr":"codex-claudacoda","id":"z"}), 104).unwrap();
        assert_eq!(at(&store, "ack", json!({"addr":"codex-claudacoda","id":"z"}), 105).unwrap()["read_at"], 104);
        assert_eq!(at(&store, "inbox", json!({"addr":"codex-claudacoda","unread":true}), 106).unwrap()["messages"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn reply_pair_is_reversed_and_timeout_is_success() {
        let (_dir, store) = fixture();
        at(&store, "post", message("question"), 100).unwrap();
        assert_eq!(at(&store, "wait-reply", json!({"id":"question","timeout":0}), 101).unwrap(), json!({"reply":null,"reply_kind":null,"timed_out":true}));
        let mut reply = json!({"id":"answer","to":"owner","from":"codex-marketplace","kind":"reply","reply_to":"question","subject":"Re: Review","body":"Reviewed."});
        assert!(at(&store, "post", reply.clone(), 102).is_err());
        reply["from"] = json!("codex-claudacoda");
        at(&store, "post", reply, 103).unwrap();
        let waited = at(&store, "wait-reply", json!({"id":"question","timeout":0}), 104).unwrap();
        assert_eq!(waited["timed_out"], false);
        assert_eq!(waited["reply"]["id"], "answer");
    }
    #[test]
    fn a_bare_reply_needs_exactly_one_open_thread_and_retries_are_idempotent() {
        let (_dir, store) = fixture();
        let reply = |id: &str| json!({"id":id,"to":"owner","from":"codex-claudacoda","kind":"reply","subject":"Re","body":"Done."});
        // Zero open threads: refused, nothing saved, the flag is named.
        let error = at(&store, "post", reply("early"), 100).unwrap_err().to_string();
        assert!(error.contains("--reply-to"), "{error}");
        assert!(!store.root.join("mailbox.json").exists(), "a refused reply is not saved");
        // Exactly one open question: answered, with the inferred parent saved.
        at(&store, "post", message("first"), 101).unwrap();
        assert_eq!(at(&store, "post", reply("answer-1"), 102).unwrap()["reply_to"], "first");
        // Retrying the same id is idempotent, bare or naming that parent, though nothing is open now.
        let again = at(&store, "post", reply("answer-1"), 103).unwrap();
        assert_eq!((again["reply_to"].as_str(), again["sequence"].as_u64()), (Some("first"), Some(2)));
        let mut explicit = reply("answer-1");
        explicit["reply_to"] = json!("first");
        assert_eq!(at(&store, "post", explicit, 104).unwrap()["sequence"], 2);
        // Several open (a notice counts): refused, naming every candidate id.
        let mut notice = message("second");
        notice["kind"] = json!("notice");
        at(&store, "post", notice, 105).unwrap();
        at(&store, "post", message("third"), 106).unwrap();
        let error = at(&store, "post", reply("answer-2"), 107).unwrap_err().to_string();
        assert!(error.contains("--reply-to") && error.contains("(third, second)") && !error.contains("first"), "{error}");
        // An explicit reply to a notice works, after which one thread is open again.
        let mut to_notice = reply("answer-2");
        to_notice["reply_to"] = json!("second");
        at(&store, "post", to_notice, 108).unwrap();
        assert_eq!(at(&store, "post", reply("answer-3"), 109).unwrap()["reply_to"], "third");
        // The sender/recipient relation, changed retries and reply_to on other kinds are still refused.
        let mut wrong = reply("answer-4");
        wrong["from"] = json!("codex-marketplace");
        wrong["reply_to"] = json!("third");
        assert!(at(&store, "post", wrong, 110).is_err());
        let mut changed = reply("answer-1");
        changed["reply_to"] = json!("third");
        assert!(at(&store, "post", changed, 111).is_err());
        let mut bad = message("bad");
        bad["kind"] = json!("notice");
        bad["reply_to"] = json!("first");
        assert!(at(&store, "post", bad, 112).is_err());
    }
    #[test]
    fn wait_reply_tells_acknowledgements_from_terminal_answers() {
        let (_dir, store) = fixture();
        let team = heartbeat::TEAM_ADDRESS;
        at(&store, "post", json!({"id":"ask","to":team,"from":"codex-claudacoda","kind":"question","subject":"Need a reviewer","body":"{\"start\":{}}"}), 100).unwrap();
        let answer = |id: &str, body: Value| json!({"id":id,"to":"codex-claudacoda","from":team,"kind":"reply","reply_to":"ask","subject":"Re","body":body.to_string()});
        at(&store, "post", answer("q", json!({"queued":{"requestId":"ask"}})), 101).unwrap();
        // The default still returns the first reply, and now says it is only an acknowledgement.
        let first = at(&store, "wait-reply", json!({"id":"ask","timeout":0}), 102).unwrap();
        assert_eq!((first["reply"]["id"].as_str(), first["reply_kind"].as_str()), (Some("q"), Some("acknowledgement")));
        let wait = |now: u64| at(&store, "wait-reply", json!({"id":"ask","timeout":0,"terminal":true}), now).unwrap();
        let pending = wait(102);
        assert_eq!((pending["timed_out"].as_bool(), pending["acknowledgement"]["id"].as_str()), (Some(true), Some("q")));
        at(&store, "post", answer("a", json!({"admitted":{"requestId":"ask","sessionId":"s_1"}})), 103).unwrap();
        at(&store, "post", answer("done", json!({"completed":{"requestId":"ask"}})), 104).unwrap();
        let done = wait(105);
        assert_eq!((done["reply"]["id"].as_str(), done["reply_kind"].as_str(), done["acknowledgement"]["id"].as_str()), (Some("done"), Some("terminal"), Some("a")));
        assert!(at(&store, "wait-reply", json!({"id":"ask","terminal":"yes"}), 106).is_err());
    }
    #[test]
    fn team_posts_save_before_the_app_runs_and_say_so_honestly() {
        let (_dir, store) = fixture();
        let request = json!({"id":"start-1","to":heartbeat::TEAM_ADDRESS,"from":"codex-claudacoda","kind":"question","subject":"Need a reviewer","body":"{\"start\":{}}"});
        let saved = at(&store, "post", request.clone(), 100).unwrap();
        let delivery = &saved["delivery"];
        assert_eq!((delivery["receipt"].as_str(), delivery["host"].as_str(), delivery["reader"].as_str()), (Some("saved"), Some("unavailable"), Some("app")));
        assert_eq!((delivery["request"]["state"].as_str(), delivery["request"]["requestId"].as_str()), (Some("queued"), Some("start-1")));
        assert!(delivery["request"]["cancel"].as_str().unwrap().contains(r#"{"cancel":{"requestId":"start-1"}}"#));
        assert!(delivery["request"]["note"].as_str().unwrap().contains("starts only when CodaClauda runs"));
        assert_eq!(at(&store, "inbox", json!({"addr":heartbeat::TEAM_ADDRESS}), 101).unwrap()["messages"][0]["id"], "start-1");
        // A notice is passive: saved, and never a start request.
        let mut notice = request;
        notice["id"] = json!("start-2");
        notice["kind"] = json!("notice");
        assert_eq!(at(&store, "post", notice, 102).unwrap()["delivery"]["request"]["state"], "passive");
        let plain = at(&store, "post", message("plain"), 103).unwrap();
        assert_eq!((plain["delivery"]["reader"].as_str(), plain["delivery"].get("request")), (Some("agent"), None));
        // Posting started nothing: the coordination state was never created.
        assert!(!store.root.join("state.json").exists());
    }
    #[test]
    fn claim_conflicts_expire_and_only_holder_can_release() {
        let (_dir, store) = fixture();
        at(&store, "post", claim("first", "codex-claudacoda"), 100).unwrap();
        let err = at(&store, "post", claim("second", "codex-marketplace"), 159).unwrap_err();
        assert_eq!(err.downcast_ref::<ClaimConflict>().unwrap().current_holder["holder"], "codex-claudacoda");
        let mut release = claim("release", "codex-marketplace");
        release["kind"] = json!("release"); release.as_object_mut().unwrap().remove("ttl");
        assert!(at(&store, "post", release.clone(), 159).unwrap_err().downcast_ref::<ClaimConflict>().is_some());
        at(&store, "post", claim("second", "codex-marketplace"), 160).unwrap();
        at(&store, "post", release, 161).unwrap();
        assert!(at(&store, "claims", json!({}), 162).unwrap()["claims"].as_array().unwrap().is_empty());
        // Replaying an old claim returns its receipt and cannot reacquire it.
        at(&store, "post", claim("first", "codex-claudacoda"), 163).unwrap();
        assert!(at(&store, "claims", json!({}), 164).unwrap()["claims"].as_array().unwrap().is_empty());
    }
    #[test]
    fn concurrent_claims_have_one_holder_and_one_message() {
        let (_dir, store) = fixture();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = ["codex-marketplace", "codex-claudacoda"].into_iter().map(|address| {
            let store = store.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || { barrier.wait(); at(&store, "post", claim(address, address), 100) })
        }).collect();
        let outcomes: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(outcomes.iter().filter(|v| v.is_ok()).count(), 1);
        assert!(outcomes.iter().find_map(|v| v.as_ref().err()).unwrap().downcast_ref::<ClaimConflict>().is_some());
        assert_eq!(at(&store, "claims", json!({}), 101).unwrap()["claims"].as_array().unwrap().len(), 1);
        assert_eq!(at(&store, "inbox", json!({"addr":"owner"}), 101).unwrap()["messages"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn retention_prunes_on_reads_without_resetting_sequence() {
        let (_dir, store) = fixture();
        at(&store, "post", message("old"), 100).unwrap();
        assert_eq!(at(&store, "inbox", json!({"addr":"codex-claudacoda"}), 99 + RETENTION).unwrap()["messages"].as_array().unwrap().len(), 1);
        assert!(at(&store, "inbox", json!({"addr":"codex-claudacoda"}), 100 + RETENTION).unwrap()["messages"].as_array().unwrap().is_empty());
        assert_eq!(at(&store, "post", message("new"), 101 + RETENTION).unwrap()["sequence"], 2);
        let state: Mailbox = serde_json::from_slice(&fs::read(store.root.join("mailbox.json")).unwrap()).unwrap();
        assert!(!state.messages.contains_key("old"));
    }
    #[test]
    fn secret_and_size_rejection_never_persists_input() {
        let (_dir, store) = fixture();
        // Generated-looking values are built at run time so no source line looks like a credential.
        let generated = ["Ab3dEf6h", "Ij9kLm2n", "Op5qRs8t"].concat();
        let samples = ["password=hunter2".to_owned(), "pairing code: 123456".into(), "token=opaque-example".into(), "sk-ant-abcdefghijklmnopqrstuv".into(),
            "-----BEGIN PRIVATE KEY-----".into(), "CLAUDACODA_SESSION_CAPABILITY=private-example".into(), format!("Bearer {generated}"),
            format!("x\\nghp_{generated}"), "the password is hunter2".into()];
        for value in samples.iter().map(String::as_str) {
            for field in ["body", "subject", "resource"] {
                let mut args = message("secret"); args[field] = json!(value);
                let err = at(&store, "post", args, 100).unwrap_err().to_string();
                // The refusal is one fixed sentence: it never echoes any part of the input.
                assert_eq!(err, "Mailbox content contains a recognizable credential or pairing code", "{value}");
                assert!(!store.root.join("mailbox.json").exists());
            }
            assert!(at(&store, "register", json!({"name":"role","label":value}), 100).is_err());
        }
        // Prose and compound words are saved: only credential shapes are refused.
        let mut prose = message("prose");
        prose["body"] = json!("The token is ready; secret: none; authorization: granted. See task-review-notes-for-today and desk-automation-tools.");
        at(&store, "post", prose, 100).unwrap();
        at(&store, "register", json!({"name":"claude-desk-automation-tools-3f2a"}), 100).unwrap();
        let mut args = message("bytes"); args["body"] = json!("é".repeat(16385));
        assert!(at(&store, "post", args.clone(), 100).is_err());
        args["body"] = json!("é".repeat(16384));
        at(&store, "post", args, 100).unwrap();
        for value in [0, 121] { let mut args = claim("ttl", "owner"); args["ttl"] = json!(value); assert!(at(&store, "post", args, 100).is_err()); }
    }
    #[test]
    fn corrupt_mailbox_is_not_reinitialized() {
        let (_dir, store) = fixture();
        fs::write(store.root.join("mailbox.json"), b"broken").unwrap();
        assert!(at(&store, "directory", json!({}), 100).is_err());
        assert_eq!(fs::read(store.root.join("mailbox.json")).unwrap(), b"broken");
    }
    #[cfg(unix)]
    #[test]
    fn symlink_sidecars_are_rejected_without_touching_target() {
        use std::os::unix::fs::symlink;
        for sidecar in ["mailbox.lock", "mailbox.json"] {
            let (_dir, store) = fixture();
            let target = store.root.join("untouched"); fs::write(&target, b"original").unwrap();
            symlink(&target, store.root.join(sidecar)).unwrap();
            assert!(at(&store, "directory", json!({}), 100).is_err());
            assert_eq!(fs::read(&target).unwrap(), b"original");
        }
    }
}
