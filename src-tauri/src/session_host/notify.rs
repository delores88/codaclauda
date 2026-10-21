//! Opt-in phone push (0.5): when a turn finishes or fails, the engine posts a
//! short line to the owner's own ntfy topic URL (https only, off by default).
//! The line names the agent and the chat title; it never carries reply text,
//! errors, file contents or paths. The webview keeps its own toast and chime.

use super::{Failure, Inner, Provider, ensure_dirs, host, lock, reply, write_atomic};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fs, sync::OnceLock, time::Duration};

const NOTIFY_FILE: &str = "notify.json";
const URL_LIMIT: usize = 512;

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
    if url.path().trim_matches('/').is_empty() {
        return Err("Add your topic to the URL, for example https://ntfy.sh/your-topic.".into());
    }
    Ok(url.to_string())
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
                .build()
                .ok()
        })
        .as_ref()
}

fn clip(text: &str, limit: usize) -> String {
    let flat: String = text.chars().filter(|c| !c.is_control()).collect();
    if flat.chars().count() <= limit {
        return flat;
    }
    let mut cut: String = flat.chars().take(limit - 1).collect();
    cut.push('…');
    cut
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
        self.phone_check_reply_url(settings.ntfy_url.as_deref())?;
        let mut value = json!(settings);
        value["schema"] = json!("codaclauda.notify/1");
        ensure_dirs(&self.dir)
            .and_then(|_| write_atomic(&self.dir.join(NOTIFY_FILE), &serde_json::to_vec_pretty(&value)?))
            .map_err(|e| ("STORAGE_FAILED", format!("Could not save notify.json: {e}")))?;
        *lock(&self.notify) = settings.clone();
        Ok(json!(settings))
    }

    pub(super) fn phone_reply_url(&self) -> Option<String> {
        lock(&self.notify).ntfy_url.clone()
    }

    /// Called once per finished turn (from `finish_turn`).
    pub(super) fn notify_turn(&self, id: &str, status: &str) {
        let settings = lock(&self.notify).clone();
        let Some(url) = settings.ntfy_url else {
            return;
        };
        let (what, tag) = match status {
            "completed" if settings.on_finish => ("finished a reply", "white_check_mark"),
            "failed" if settings.on_error => ("stopped with an error", "warning"),
            _ => return,
        };
        let Some((provider, title)) = lock(&self.state)
            .records
            .iter()
            .find(|r| r.id == id)
            .map(|r| (r.provider.clone(), r.title.clone()))
        else {
            return;
        };
        let agent = Provider::parse(&provider).map_or("An agent", Provider::label);
        let body = format!("{agent} {what}: {}", clip(&title, 80));
        push(url, tag, body);
    }

    /// An owner notice (the wake loop guard) to the ntfy topic, when one is
    /// configured. The caller passes a short line with no message text.
    pub(super) fn notify_owner(&self, line: &str) {
        if let Some(url) = lock(&self.notify).ntfy_url.clone() {
            push(url, "warning", clip(line, 160));
        }
    }
}

fn push(url: String, tag: &'static str, body: String) {
    tauri::async_runtime::spawn(async move {
        let Some(client) = client() else {
            return;
        };
        let sent = client
            .post(&url)
            .header("Title", "CodaClauda")
            .header("Tags", tag)
            .body(body)
            .send()
            .await;
        match sent {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => eprintln!("CodaClauda: ntfy answered {}", response.status()),
            Err(e) => eprintln!("CodaClauda: ntfy push failed: {}", e.without_url()),
        }
    });
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_https_topic_urls_are_kept() {
        assert_eq!(check_url(" https://ntfy.sh/ben-agents ").unwrap(), "https://ntfy.sh/ben-agents");
        for bad in ["http://ntfy.sh/x", "https://ntfy.sh/", "https://u:p@ntfy.sh/x", "ntfy.sh/x", "file:///c:/x"] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
        let saved = json!({"ntfyUrl": null, "onFinish": true, "onError": false});
        let settings: Settings = serde_json::from_value(saved.clone()).unwrap();
        assert_eq!(json!(settings), saved);
        assert_eq!(json!(Settings::default()), json!({"ntfyUrl": null, "onFinish": true, "onError": true}), "no URL, so nothing posts");
    }
}
