//! Opt-in phone push (0.5): when a turn finishes or fails, the engine posts a
//! short line to the owner's ntfy topic URL. Nothing is sent without a saved URL.
//! The line names the agent and the chat title; it never carries reply text,
//! errors, file contents or paths. The webview keeps its own toast and chime.

use super::{Failure, Inner, Provider, ensure_dirs, host, lock, phone::Publication, random_hex, reply, write_atomic};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fs, sync::OnceLock, time::Duration};

const NOTIFY_FILE: &str = "notify.json";
const URL_LIMIT: usize = 512;

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
    pub(super) fn notify_turn(&self, id: &str, turn_id: &str, status: &str) {
        let settings = lock(&self.notify).clone();
        let Some(_) = settings.ntfy_url else {
            return;
        };
        let (what, tag) = match status {
            "completed" if settings.on_finish => ("finished a reply", "white_check_mark"),
            "failed" if settings.on_error => ("stopped with an error", "warning"),
            _ => return,
        };
        let Some((provider, title, address)) = lock(&self.state)
            .records
            .iter()
            .find(|r| r.id == id)
            .map(|r| (r.provider.clone(), r.title.clone(), r.mailbox_address.clone()))
        else {
            return;
        };
        let agent = Provider::parse(&provider).map_or("An agent", Provider::label);
        // Pass the full raw title/body into the shared scanner before clipping.
        let body = format!("{agent} {what}: {title}");
        let sender = address.clone().unwrap_or_else(|| agent.to_owned());
        self.phone_notification(Publication { id: format!("turn:{id}:{turn_id}"), title: sender, subject: title, body, limit: 160, tag, recipient: address });
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
