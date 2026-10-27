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
use super::{Failure, Inner, Queued, desktop_queue, lock, phone::Publication};
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
const LOCKED: &str = "Phone approvals are locked after repeated wrong codes. Unlock them in CodaClauda: Settings > Phone.";
const WRONG: &str = "That approval code is not valid. Check the code in the request notification and try again.";
const EXPIRED: &str = "That approval code has expired. Answer the request in CodaClauda, or ask the agent to send it again.";

/// In memory only: a restart forgets every code and re-sends open requests with new ones.
#[derive(Default)]
pub(super) struct Approvals {
    codes: BTreeMap<String, Pending>,
    /// Request ids pushed (or found answered) during this run.
    pushed: BTreeSet<String>,
    /// Owner inbox cursor (board sequence).
    since: u64,
    wrong: u32,
    /// Per run, so a restart's new codes get their own push receipts.
    run: String,
}

#[derive(Clone)]
struct Pending {
    request: String,
    from: String,
    title: String,
    expires: u64,
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
/// "approve K7Q2-MX4P", "Deny k7q2mx4p too risky", "yes K7Q2MX4P". None: not an approval answer
/// (then it is an ordinary phone message, routed as before).
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
fn answered(store: &Store, request: &str) -> bool {
    mailbox::api(store, "wait-reply", &json!({"id": request, "timeout": 0})).is_ok_and(|r| !r["reply"].is_null())
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
fn push_body(title: &str, body: &str, code: &str) -> String {
    let details = if mailbox_credential(title) || mailbox_credential(body) {
        "The request's text is withheld here because it may contain a credential. Read it in CodaClauda > Approvals.".to_owned()
    } else {
        let excerpt: String = body.chars().filter(|c| *c == '\n' || !c.is_control()).take(600).collect();
        format!("{title}\n\n{excerpt}")
    };
    let code = display(code);
    format!("{details}\n\nTap Approve or Deny, or reply: approve {code} (or: deny {code} and a reason). One use, expires in 24 hours.")
}
/// ntfy action buttons: each publishes the answer to this same topic from the phone.
fn actions(url: &str, code: &str) -> String {
    let code = display(code);
    format!("http, Approve, {url}, method=POST, body=approve {code}, clear=true; http, Deny, {url}, method=POST, body=deny {code}, clear=true")
}

impl Inner {
    pub(super) fn phone_approvals_view(&self) -> Value {
        let approvals = lock(&self.phone_approvals);
        json!({"locked": approvals.wrong >= WRONG_LIMIT, "waiting": approvals.codes.len()})
    }
    pub(super) fn phone_approvals_unlock(&self) {
        lock(&self.phone_approvals).wrong = 0;
    }

    /// Phone tick: each new APPROVAL REQUEST to owner goes to the phone once per run, with a fresh code.
    pub(super) async fn phone_approval_requests(&self, revision: u64, store: &Store) -> Result<(), Failure> {
        if !self.phone_approvals_on() {
            return Ok(());
        }
        let since = lock(&self.phone_approvals).since;
        let page = mailbox::api(store, "inbox", &json!({"addr": OWNER, "since": since, "limit": 100}))
            .map_err(|_| ("PHONE_BOARD_FAILED", "The owner inbox could not be read for approval requests.".to_owned()))?;
        let floor = self.phone_created_at().max(coord_core::now().saturating_sub(LOOKBACK));
        for m in page["messages"].as_array().into_iter().flatten() {
            let (Some(id), Some(sequence)) = (m["id"].as_str(), m["sequence"].as_u64()) else { continue };
            let wanted = is_request(m) && m["created_at"].as_u64().unwrap_or(0) >= floor && !lock(&self.phone_approvals).pushed.contains(id);
            if wanted && !answered(store, id) {
                let Some(code) = new_code() else {
                    self.phone_error("Phone approvals need the system's secure random source, which is unavailable. Approve on the PC.");
                    return Ok(());
                };
                let from = m["from"].as_str().unwrap_or("an agent").to_owned();
                let title = request_title(m["subject"].as_str().unwrap_or(""));
                let body = push_body(&title, m["body"].as_str().unwrap_or(""), &code);
                let run = {
                    let mut approvals = lock(&self.phone_approvals);
                    if approvals.run.is_empty() { approvals.run = super::random_hex(6); }
                    approvals.codes.retain(|_, p| p.expires > coord_core::now());
                    approvals.codes.insert(code.clone(), Pending { request: id.into(), from: from.clone(), title, expires: coord_core::now() + CODE_TTL });
                    approvals.run.clone()
                };
                let _gate = self.phone_gate.lock().await;
                if !self.phone_current(revision) { return Ok(()); }
                let Some(url) = self.phone_reply_url() else { return Ok(()) };
                let publication = Publication { id: format!("approval:{run}:{id}"), title: format!("Approval needed: {from}"), subject: String::new(), body, limit: 1500, tag: "raised_hand", recipient: None };
                self.phone_publish_actions_locked(&url, publication, Some(&actions(&url, &code))).await?;
            }
            let mut approvals = lock(&self.phone_approvals);
            if is_request(m) { approvals.pushed.insert(id.to_owned()); }
            approvals.since = approvals.since.max(sequence);
        }
        Ok(())
    }

    /// Applies a phone answer; returns the note sent back to the phone.
    pub(super) fn phone_decide(&self, decision: Decision, code: &str, note: &str, store: &Store) -> String {
        let pending = {
            let mut approvals = lock(&self.phone_approvals);
            if approvals.wrong >= WRONG_LIMIT { return LOCKED.into(); }
            match approvals.codes.remove(code) {
                Some(pending) => { approvals.wrong = 0; pending }
                None => {
                    approvals.wrong += 1;
                    return if approvals.wrong >= WRONG_LIMIT { LOCKED.into() } else { WRONG.into() };
                }
            }
        };
        if pending.expires <= coord_core::now() { return EXPIRED.into(); }
        if answered(store, &pending.request) { return "That request was already answered in CodaClauda. Nothing changed.".into(); }
        let verb = if decision == Decision::Approve { "Approved" } else { "Denied" };
        let text = chat_text(decision, &pending.title, &pending.request, note);
        // The board record: an owner reply on the request (the Approvals page shows it answered).
        let reply = json!({"id": format!("phone-answer-{}", pending.request), "from": OWNER, "to": pending.from, "kind": "reply",
            "reply_to": pending.request, "subject": format!("{verb} from Ben's phone"), "body": text});
        let recorded = mailbox::api(store, "post", &reply).is_ok();
        let record_note = if recorded { "" } else { " The board record failed, so the request may still look open in CodaClauda." };
        let who = &pending.from;
        // Ben's words in the agent's own chat.
        let session = lock(&self.state).records.iter()
            .find(|r| r.status != "closed" && r.mailbox_address.as_deref() == Some(who.as_str()))
            .map(|r| r.id.clone());
        if let (Some(id), Some(inner)) = (session, self.me.upgrade()) {
            let item = Queued::keyed(text, Vec::new(), json!({"from": PHONE, "approval": pending.request}), format!("approval:{}", pending.request));
            return match inner.submit(&id, item) {
                Ok(_) => format!("{verb}: \"{}\". Sent to @{who}'s CodaClauda chat as your words.{record_note}", pending.title),
                Err((_, why)) => format!("{verb} on the board, but @{who}'s CodaClauda chat did not take it: {why}{record_note}"),
            };
        }
        if desktop_queue::bound(&self.dir, who) {
            if let Some(inner) = self.me.upgrade() {
                let (address, title) = (who.clone(), pending.title.clone());
                tauri::async_runtime::spawn(async move {
                    let outcome = desktop_queue::queue_owner_answer(&inner, &address, text).await;
                    let line = match outcome {
                        Ok(()) => format!("Delivered to @{address}'s Codex chat: \"{title}\"."),
                        Err(why) => format!("Could not put your answer into @{address}'s Codex chat ({why}). Answer it in the Codex app."),
                    };
                    inner.phone_notification(Publication { id: format!("approval-delivery:{}", super::random_hex(8)), title: "CodaClauda".into(), subject: String::new(), body: line, limit: 400, tag: "", recipient: None });
                });
            }
            return format!("{verb}: \"{}\". Putting it into @{who}'s Codex chat now.{record_note}", pending.title);
        }
        format!("{verb} and recorded on the board, but @{who} is not a chat CodaClauda can type into. Answer it in its own app.{record_note}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_need_a_code_and_keep_ben_s_extra_words() {
        assert_eq!(parse_decision("approve K7Q2-MX4P"), Some((Decision::Approve, "K7Q2MX4P".into(), String::new())));
        assert_eq!(parse_decision("  Deny: k7q2mx4p too risky today "), Some((Decision::Deny, "K7Q2MX4P".into(), "too risky today".into())));
        assert_eq!(parse_decision("yes K7Q2-MX4P, staging only"), Some((Decision::Approve, "K7Q2MX4P".into(), "staging only".into())));
        for ordinary in ["approve", "approve the PR", "@Reviewer approve K7Q2-MX4P", "deny K7Q2-MX4", "approve K7Q2-MX4PX", "approve K7Q2-MX40", "please approve K7Q2-MX4P"] {
            assert_eq!(parse_decision(ordinary), None, "{ordinary}");
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
            let body = push_body("Ship 0.7.2", "Publish the installer.", &code);
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
        let body = push_body("Use key", "password: Hunter2Hunter2", "K7Q2MX4P");
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
}
