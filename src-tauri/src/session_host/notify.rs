//! Opt-in phone push (0.5): when a turn finishes or fails, the engine posts a
//! scanned reply preview to the owner's ntfy topic URL. Nothing is sent without
//! a saved URL. Agent-to-agent board turns stay quiet unless they fail or the
//! agent explicitly posts to owner-phone. The webview keeps its toast and chime.

use super::{Failure, Inner, Provider, Record, ensure_dirs, host, lock, phone::Publication, random_hex, reply, write_atomic};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fs, sync::OnceLock, time::Duration};

const NOTIFY_FILE: &str = "notify.json";
const URL_LIMIT: usize = 512;

/// Sender names classify notification traffic only; they grant no authority.
fn peer_turn(origin: &Value) -> bool {
    matches!(origin["kind"].as_str(), Some("wake" | "team"))
        && !matches!(origin["from"].as_str(), Some("owner" | "owner-phone"))
}

/// Read the final complete assistant message for this exact turn. Deltas,
/// tool output, other turns and other sessions cannot become a reply preview.
fn final_reply(bytes: &[u8], id: &str, turn_id: &str) -> Option<String> {
    bytes.rsplit(|b| *b == b'\n').find_map(|line| {
        let event: Value = serde_json::from_slice(line).ok()?;
        if event["id"] != id || event["turnId"] != turn_id || event["kind"] != "message" {
            return None;
        }
        event["text"].as_str().filter(|text| !text.trim().is_empty()).map(str::to_owned)
    })
}

pub(super) fn turn_publication(record: &Record, turn_id: &str, status: &str, origin: &Value, reply: Option<&str>) -> Option<Publication> {
    let (body, tag) = match status {
        "completed" if !peer_turn(origin) => (reply.filter(|text| !text.trim().is_empty())?.to_owned(), "white_check_mark"),
        "failed" => ("The agent stopped with an error. Open CodaClauda for details.".into(), "warning"),
        _ => return None,
    };
    let title = if record.title.trim().is_empty() {
        record.mailbox_address.clone().filter(|address| !address.trim().is_empty())
            .unwrap_or_else(|| Provider::parse(&record.provider).map_or("An agent", Provider::label).to_owned())
    } else {
        record.title.clone()
    };
    // The full message and title reach the shared credential scanner before
    // the character limit is applied. Receipts retain no message text.
    Some(Publication { id: format!("turn:{}:{turn_id}", record.id), title, subject: record.title.clone(),
        body, limit: 300, tag, recipient: record.mailbox_address.clone() })
}

/// Fixed owner-triggered test: no caller-supplied URL, body or routing identity.
pub(super) fn test_publication() -> Publication {
    Publication { id: format!("test:{}", random_hex(16)), title: "CodaClauda".into(),
        subject: "Phone notification test".into(), body: "CodaClauda phone notification test. If you can read this on your phone, this notice arrived.".into(),
        limit: 160, tag: "", recipient: None }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Settings {
    ntfy_url: Option<String>,
    on_finish: bool,
    on_error: bool,
}

/// 0.6: both pushes start on, so pasting a topic URL is the only step.
/// Nothing is posted until the owner saves a URL; a saved file keeps its switches.
impl Default for Settings {
    fn default() -> Self {
        Self { ntfy_url: None, on_finish: true, on_error: true }
    }
}

/// An https topic URL without embedded credentials.
fn check_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.len() > URL_LIMIT {
        return Err("The ntfy topic URL is too long.".into());
    }
    let url = url::Url::parse(raw).map_err(|_| "Enter the full ntfy topic URL, for example https://ntfy.sh/your-topic.".to_owned())?;
    if url.scheme() != "https" || url.host_str().is_none_or(str::is_empty) {
        return Err("The ntfy topic URL must start with https://.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Leave sign-in details out of the URL; use a hard-to-guess topic name instead.".into());
    }
    let topic = url.path().trim_matches('/');
    if topic.is_empty() {
        return Err("Add your topic to the URL, for example https://ntfy.sh/your-topic.".into());
    }
    if url.query().is_some() || url.fragment().is_some() || !topic.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)) {
        return Err("Use a plain HTTPS ntfy topic URL, without query parameters, fragments or escaped characters.".into());
    }
    Ok(url.to_string().trim_end_matches('/').to_owned())
}

pub(super) fn client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .https_only(true)
                .user_agent(format!("CodaClauda/{}", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(15))
                .connect_timeout(Duration::from_secs(8))
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .build()
                .ok()
        })
        .as_ref()
}

impl Inner {
    pub(super) fn load_notify(&self) {
        let settings = fs::read(self.dir.join(NOTIFY_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
            .map(|mut s| {
                s.ntfy_url = s.ntfy_url.and_then(|u| check_url(&u).ok());
                s
            })
            .unwrap_or_default();
        *lock(&self.notify) = settings;
    }

    fn notify_set(&self, url: Option<String>, on_finish: bool, on_error: bool) -> Result<Value, Failure> {
        let ntfy_url = match url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
            None => None,
            Some(raw) => Some(check_url(raw).map_err(|m| ("INVALID_ARGUMENTS", m))?),
        };
        let settings = Settings {
            ntfy_url,
            on_finish,
            on_error,
        };
        // The shared gate keeps URL rebinding and all publishes/poll commits
        // serialized. A failed namespace save pauses the bridge fail-closed.
        let mut value = json!(settings);
        value["schema"] = json!("codaclauda.notify/1");
        ensure_dirs(&self.dir)
            .and_then(|_| write_atomic(&self.dir.join(NOTIFY_FILE), &serde_json::to_vec_pretty(&value)?))
            .map_err(|e| ("STORAGE_FAILED", format!("Could not save notify.json: {e}")))?;
        self.phone_bind(settings.ntfy_url.as_deref())?;
        *lock(&self.notify) = settings.clone();
        Ok(json!(settings))
    }

    pub(super) fn phone_reply_url(&self) -> Option<String> {
        lock(&self.notify).ntfy_url.clone()
    }

    /// Called once per finished turn (from `finish_turn`).
    pub(super) fn notify_turn(&self, id: &str, turn_id: &str, status: &str, origin: &Value) {
        let settings = lock(&self.notify).clone();
        let Some(_) = settings.ntfy_url else {
            return;
        };
        if !matches!(status, "completed" if settings.on_finish && !peer_turn(origin))
            && !matches!(status, "failed" if settings.on_error) {
            return;
        }
        let Some(record) = lock(&self.state)
            .records
            .iter()
            .find(|r| r.id == id)
            .cloned()
        else {
            return;
        };
        let answer = if status == "completed" {
            let _guard = lock(&self.log_lock);
            fs::read(self.log_path(id)).ok().and_then(|bytes| final_reply(&bytes, id, turn_id))
        } else {
            None
        };
        if let Some(publication) = turn_publication(&record, turn_id, status, origin, answer.as_deref()) {
            self.phone_notification(publication);
        }
    }

    /// An owner notice (the wake loop guard) to the ntfy topic, when one is
    /// configured. The caller passes a short line with no message text.
    pub(super) fn notify_owner(&self, line: &str) {
        if self.phone_reply_url().is_some() {
            self.phone_notification(Publication { id: format!("warning:{}", random_hex(16)), title: "CodaClauda".into(), subject: String::new(), body: line.into(), limit: 160, tag: "warning", recipient: None });
        }
    }
}

// ----------------------------------------------------------------- commands

#[tauri::command]
pub(crate) async fn notify_settings_get(app: tauri::AppHandle) -> Value {
    let settings = lock(&host(&app).notify).clone();
    reply(Ok(json!(settings)))
}

#[tauri::command]
pub(crate) async fn notify_settings_set(
    app: tauri::AppHandle,
    ntfy_url: Option<String>,
    on_finish: Option<bool>,
    on_error: Option<bool>,
) -> Value {
    let inner = host(&app);
    let _gate = inner.phone_gate.lock().await;
    reply(inner.notify_set(ntfy_url, on_finish.unwrap_or(false), on_error.unwrap_or(false)))
}

/// Owner webview command only; not exposed to the CLI, board or provider MCP.
#[tauri::command]
pub(crate) async fn notify_test(app: tauri::AppHandle) -> Value {
    let inner = host(&app);
    let _gate = inner.phone_gate.lock().await;
    let publication = test_publication();
    let id = publication.id.clone();
    let Some(url) = inner.phone_reply_url() else {
        return reply(Ok(super::phone::refused_publication(&id, "Save an ntfy topic URL before sending a test. No notice was sent.")));
    };
    // A failed pre-dispatch save refuses without HTTP. Post-dispatch failures
    // return an unknown receipt from the shared path and are never retried.
    let receipt = inner.phone_publish_locked(&url, publication).await
        .unwrap_or_else(|(_, message)| super::phone::refused_publication(&id, &message));
    reply(Ok(receipt))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_reply_uses_last_complete_message_from_the_matching_turn_only() {
        let lines = [
            json!({"id": "session", "turnId": "previous", "kind": "message", "text": "Old answer"}),
            json!({"id": "session", "turnId": "current", "kind": "user", "text": "Owner question"}),
            json!({"id": "session", "turnId": "current", "kind": "message", "text": "Intermediate update"}),
            json!({"id": "session", "turnId": "current", "kind": "message", "text": "Actual final answer"}),
            json!({"id": "session", "turnId": "current", "kind": "delta", "text": "Partial text"}),
            json!({"id": "session", "turnId": "current", "kind": "tool", "text": "Tool output"}),
            json!({"id": "different", "turnId": "current", "kind": "message", "text": "Other session"}),
            json!({"id": "session", "turnId": "later", "kind": "message", "text": "Other turn"}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        assert_eq!(final_reply(lines.as_bytes(), "session", "current").as_deref(), Some("Actual final answer"));
        assert!(final_reply(lines.as_bytes(), "session", "missing").is_none());
        assert!(final_reply(b"not valid json", "session", "current").is_none());
    }

    #[test]
    fn claude_final_reply_keeps_all_text_blocks_without_earlier_commentary() {
        let assistant = |blocks: Value| json!({"type": "assistant", "message": {"content": blocks}});
        let messages = [
            assistant(json!([
                {"type": "text", "text": "I will inspect the source."},
                {"type": "tool_use", "name": "Read", "input": {"file_path": "fixture.rs"}},
                {"type": "text", "text": "Still checking."},
            ])),
            assistant(json!([
                {"type": "text", "text": "The requested change is complete."},
                {"type": "text", "text": "Focused checks passed."},
            ])),
        ];
        let mut lines = Vec::new();
        let mut tool_count = 0;
        for message in messages {
            for output in crate::session_parse::parse_claude(&message) {
                match output {
                    crate::session_parse::Out::Message(text) => lines.push(json!({"id": "session", "turnId": "current", "kind": "message", "text": text}).to_string()),
                    crate::session_parse::Out::Tool { .. } => tool_count += 1,
                    _ => {}
                }
            }
        }
        assert_eq!(lines.len(), 2, "each assistant message remains one complete message");
        assert_eq!(tool_count, 1);
        assert_eq!(final_reply(lines.join("\n").as_bytes(), "session", "current").as_deref(),
            Some("The requested change is complete.\n\nFocused checks passed."));
    }

    #[test]
    fn successful_peer_board_turns_stay_quiet_but_owner_turns_and_errors_remain_eligible() {
        let record = Record { id: "session".into(), title: "Release reviewer".into(), provider: "codex".into(),
            mailbox_address: Some("codex-reviewer".into()), ..Record::default() };
        for kind in ["wake", "team"] {
            for from in ["claude-builder", "codex-reviewer", "codaclauda-team", "", "Owner"] {
                let origin = json!({"kind": kind, "from": from});
                assert!(turn_publication(&record, "turn", "completed", &origin, Some("Private coordination reply")).is_none());
                assert_eq!(turn_publication(&record, "turn", "failed", &origin, None).unwrap().tag, "warning");
            }
            assert!(turn_publication(&record, "turn", "completed", &json!({"kind": kind}), Some("Unknown sender")).is_none());
            for from in ["owner", "owner-phone"] {
                assert!(turn_publication(&record, "turn", "completed", &json!({"kind": kind, "from": from}), Some("Owner answer")).is_some());
            }
        }
        for origin in [Value::Null, json!({"kind": "schedule"}), json!({"kind": "handoff"}), json!({"kind": "continue"})] {
            assert!(turn_publication(&record, "turn", "completed", &origin, Some("Owner answer")).is_some());
        }
        assert!(turn_publication(&record, "turn", "completed", &Value::Null, None).is_none());
        assert!(turn_publication(&record, "turn", "interrupted", &Value::Null, Some("Partial answer")).is_none());
        let fallback = Record { title: String::new(), ..record };
        assert_eq!(turn_publication(&fallback, "turn", "completed", &Value::Null, Some("Answer")).unwrap().title, "codex-reviewer");
        let fallback = Record { mailbox_address: None, ..fallback };
        assert_eq!(turn_publication(&fallback, "turn", "completed", &Value::Null, Some("Answer")).unwrap().title, "Codex");
    }

    #[test]
    fn only_plain_https_topic_urls_are_kept() {
        assert_eq!(check_url(" https://ntfy.sh/ben-agents ").unwrap(), "https://ntfy.sh/ben-agents");
        assert_eq!(check_url("https://NTFY.SH/ben-agents/").unwrap(), "https://ntfy.sh/ben-agents");
        for bad in ["http://ntfy.sh/x", "https://ntfy.sh/", "https://u:p@ntfy.sh/x", "ntfy.sh/x", "file:///c:/x",
            "https://ntfy.sh/topic?tracking=yes", "https://ntfy.sh/topic#fragment", "https://ntfy.sh/%74opic", "https://ntfy.sh/topic/json"] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
        let saved = json!({"ntfyUrl": null, "onFinish": true, "onError": false});
        let settings: Settings = serde_json::from_value(saved.clone()).unwrap();
        assert_eq!(json!(settings), saved);
        assert_eq!(json!(Settings::default()), json!({"ntfyUrl": null, "onFinish": true, "onError": true}), "no URL, so nothing posts");
    }
}
