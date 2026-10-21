//! Passive, self-asserted mailboxes. This sidecar never reads or writes the
//! coordination state, launches providers, or grants authority to act. A post
//! reads only the desktop app's heartbeat, to say who will pick it up.
use crate::{heartbeat, store::Store};
use anyhow::{Context, Result, bail, ensure};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::OnceLock,
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

fn secret(text: &str) -> bool {
    static EXTRA: OnceLock<regex::Regex> = OnceLock::new();
    crate::redact(text) != text || EXTRA.get_or_init(|| regex::Regex::new(
        r#"(?i)(?:-----BEGIN[ A-Z]*PRIVATE KEY-----|(?:pairing[ _-]*(?:code|token)|session[ _-]*(?:token|capability)|claudacoda[ _-]*session[ _-]*capability|codaclauda[ _-]*capability|authorization|token|secret|password|passwd|pwd)["']?\s*(?::|=|\bis\b)\s*["']?[^\s,;"'}]+|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\bAKIA[A-Z0-9]{16}\b)"#
    ).expect("fixed mailbox credential expression")).is_match(text)
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
#[derive(Serialize)]
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
fn save_post(state: &mut Mailbox, id: &str, post: &Post, now: u64) -> Result<Value> {
    let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(post)?));
    if let Some(existing) = state.messages.get(id) {
        ensure!(existing.digest == digest, "Message ID already exists with a different payload");
        return Ok(serde_json::to_value(&existing.message)?);
    }
    state.address(&post.from)?;
    // The team inbox exists before the app first runs, so saving never waits for it.
    if post.to == heartbeat::TEAM_ADDRESS && !state.addresses.contains_key(&post.to) {
        let label = "CodaClauda team requests".into();
        state.addresses.insert(post.to.clone(), Address { name: post.to.clone(), label, created_at: now });
    }
    state.address(&post.to)?;
    // A reply without reply_to answers the newest message from its recipient to its sender.
    let reply_to = match &post.reply_to {
        None if post.kind == "reply" => Some(
            state.messages.values().map(|v| &v.message).filter(|m| m.from == post.to && m.to == post.from)
                .max_by_key(|m| m.sequence).map(|m| m.id.clone())
                .ok_or_else(|| anyhow::anyhow!("Nothing from {} to {} is retained to reply to; pass --reply-to <message id>", post.to, post.from))?,
        ),
        value => value.clone(),
    };
    if let Some(parent_id) = &reply_to {
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
    let sequence = state.next_sequence;
    state.next_sequence = sequence.checked_add(1).ok_or_else(|| anyhow::anyhow!("Mailbox sequence limit reached"))?;
    let message = Message {
        id: id.to_owned(), sequence, to: post.to.clone(), from: post.from.clone(), kind: post.kind.clone(),
        subject: post.subject.clone(), body: post.body.clone(), created_at: now, read_at: None,
        reply_to, resource: post.resource.clone(),
    };
    let result = serde_json::to_value(&message)?;
    state.messages.insert(id.to_owned(), StoredMessage { message, digest });
    Ok(result)
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
            saved["delivery"] = heartbeat::delivery(&store.root, &post.to, now.saturating_mul(1000));
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
            fields(args, &["id", "timeout"], &["id"])?;
            let id = identifier(args, "id")?;
            let timeout = number(args, "timeout", 20, 0, 60)?;
            let deadline = Instant::now() + Duration::from_secs(timeout);
            loop {
                let reply = transaction(store, clock(), |state| {
                    ensure!(state.messages.contains_key(&id), "Original mailbox message is unavailable");
                    Ok(state.messages.values().map(|v| &v.message).filter(|m| m.reply_to.as_deref() == Some(id.as_str())).min_by_key(|m| m.sequence).cloned())
                })?;
                if reply.is_some() || Instant::now() >= deadline {
                    return Ok(json!({"timed_out":reply.is_none(),"reply":reply}));
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
        assert_eq!(at(&store, "wait-reply", json!({"id":"question","timeout":0}), 101).unwrap(), json!({"reply":null,"timed_out":true}));
        let mut reply = json!({"id":"answer","to":"owner","from":"codex-marketplace","kind":"reply","reply_to":"question","subject":"Re: Review","body":"Reviewed."});
        assert!(at(&store, "post", reply.clone(), 102).is_err());
        reply["from"] = json!("codex-claudacoda");
        at(&store, "post", reply, 103).unwrap();
        let waited = at(&store, "wait-reply", json!({"id":"question","timeout":0}), 104).unwrap();
        assert_eq!(waited["timed_out"], false);
        assert_eq!(waited["reply"]["id"], "answer");
    }
    #[test]
    fn reply_without_reply_to_answers_the_newest_message_or_names_the_flag() {
        let (_dir, store) = fixture();
        let reply = |id: &str| json!({"id":id,"to":"owner","from":"codex-claudacoda","kind":"reply","subject":"Re","body":"Done."});
        let error = at(&store, "post", reply("early"), 100).unwrap_err().to_string();
        assert!(error.contains("--reply-to"), "{error}");
        assert!(!store.root.join("mailbox.json").exists(), "a refused reply is not saved");
        at(&store, "post", message("older"), 101).unwrap();
        at(&store, "post", message("newer"), 102).unwrap();
        assert_eq!(at(&store, "post", reply("answer"), 103).unwrap()["reply_to"], "newer");
        let mut notice = message("notice"); notice["kind"] = json!("notice"); notice["reply_to"] = json!("older");
        assert!(at(&store, "post", notice, 104).is_err());
    }
    #[test]
    fn team_posts_save_before_the_app_runs_and_say_so() {
        let (_dir, store) = fixture();
        let request = json!({"id":"start-1","to":heartbeat::TEAM_ADDRESS,"from":"codex-claudacoda","kind":"question","subject":"Need a reviewer","body":"{\"start\":{}}"});
        let saved = at(&store, "post", request, 100).unwrap();
        assert_eq!(saved["delivery"]["state"], "app_not_running");
        assert_eq!(at(&store, "inbox", json!({"addr":heartbeat::TEAM_ADDRESS}), 101).unwrap()["messages"][0]["id"], "start-1");
        assert_eq!(at(&store, "post", message("plain"), 102).unwrap()["delivery"]["state"], "passive");
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
        let samples = ["password=hunter2", "pairing code: 123456", "token=opaque-example", "sk-ant-abcdefghijklmnopqrstuv", "-----BEGIN PRIVATE KEY-----", "CLAUDACODA_SESSION_CAPABILITY=private-example"];
        for value in samples {
            for field in ["body", "subject", "resource"] {
                let mut args = message("secret"); args[field] = json!(value);
                let err = at(&store, "post", args, 100).unwrap_err().to_string();
                assert!(!err.contains(value));
                assert!(!store.root.join("mailbox.json").exists());
            }
            assert!(at(&store, "register", json!({"name":"role","label":value}), 100).is_err());
        }
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
