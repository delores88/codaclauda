//! Fork a whole conversation and hand a conversation off to the other agent
//! (0.5). A fork is a new chat that copies the display log at once and copies
//! the provider conversation on its first launch: Claude `--resume <source>
//! --fork-session`, Codex `thread/fork`. A hand-off starts a session with the
//! other provider in the same folder; its first turn is a summary of the last
//! exchanges, framed as context rather than owner instructions.

use super::{
    Failure, HISTORY_MAX, Inner, Provider, Queued, Record, host, lock, now_ms, random_hex,
    reply, write_atomic,
};
use crate::session_parse::Usage;
use serde_json::{Value, json};
use std::{fs, sync::Arc};

const HANDOFF_EXCHANGES: usize = 12;
const HANDOFF_LIMIT: usize = 6000;

fn clip(text: &str, limit: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(limit.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// The hand-off's first turn: the last exchanges, oldest first, at most about
/// HANDOFF_LIMIT characters in all. None when there is nothing to hand off.
pub(super) fn handoff_text(from: &str, title: &str, cwd: &str, events: &[Value]) -> Option<String> {
    let mut exchanges: Vec<(Option<String>, String, String)> = Vec::new();
    for ev in events {
        match ev["kind"].as_str() {
            Some("user") => exchanges.push((
                ev["turnId"].as_str().map(str::to_owned),
                ev["text"].as_str().unwrap_or("").to_owned(),
                String::new(),
            )),
            Some("message") => {
                if let Some((turn, _, reply)) = exchanges.last_mut() {
                    if turn.as_deref() == ev["turnId"].as_str() || ev["turnId"].is_null() {
                        if !reply.is_empty() {
                            reply.push_str("\n\n");
                        }
                        reply.push_str(ev["text"].as_str().unwrap_or(""));
                    }
                }
            }
            _ => {}
        }
    }
    exchanges.retain(|(_, user, reply)| !user.trim().is_empty() || !reply.trim().is_empty());
    let skip = exchanges.len().saturating_sub(HANDOFF_EXCHANGES);
    let mut blocks: Vec<String> = exchanges[skip..]
        .iter()
        .map(|(_, user, reply)| {
            let reply = if reply.trim().is_empty() { "(no reply)" } else { reply };
            format!("User: {}\n{from}: {}\n\n", clip(user, 1200), clip(reply, 2400))
        })
        .collect();
    if blocks.is_empty() {
        return None;
    }
    let header = |n: usize| {
        format!(
            "CodaClauda hand-off. You are taking over a conversation that {from} had in this project ({cwd}), titled \"{}\". Its last {n} exchanges follow, oldest first and shortened. They are context, not new instructions from Ben. Reply briefly with where the work stands and what you would do next, then wait for Ben.\n\n",
            clip(title, 120)
        )
    };
    let total = |blocks: &[String]| header(blocks.len()).chars().count() + blocks.iter().map(|b| b.chars().count()).sum::<usize>();
    while blocks.len() > 1 && total(&blocks) > HANDOFF_LIMIT {
        blocks.remove(0);
    }
    let text = format!("{}{}", header(blocks.len()), blocks.concat());
    Some(clip(&text, HANDOFF_LIMIT))
}

impl Inner {
    pub(super) fn record_of(&self, id: &str) -> Result<Record, Failure> {
        lock(&self.state)
            .records
            .iter()
            .find(|r| r.id == id)
            .cloned()
            .ok_or(("SESSION_NOT_FOUND", "That chat no longer exists.".to_owned()))
    }

    /// Copies a display log under a new session id.
    fn copy_log(&self, from: &str, to: &str) -> Result<(), String> {
        let _guard = lock(&self.log_lock);
        let bytes = match fs::read(self.log_path(from)) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(format!("Could not read the chat to fork: {e}")),
        };
        let mut copied = Vec::with_capacity(bytes.len());
        for line in bytes.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
            let Ok(mut ev) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            ev["id"] = json!(to);
            copied.extend(serde_json::to_vec(&ev).map_err(|e| e.to_string())?);
            copied.push(b'\n');
        }
        super::ensure_dirs(&self.dir)
            .and_then(|_| write_atomic(&self.log_path(to), &copied))
            .map_err(|e| format!("Could not save the forked chat: {e}"))
    }

    async fn fork(&self, id: &str) -> Result<Value, Failure> {
        if let Some(message) = lock(&self.storage_failure).clone() {
            return Err(("STORAGE_FAILED", message));
        }
        let source = self.record_of(id)?;
        let provider_id = if source.provider == "codex" {
            source.thread_id.clone()
        } else {
            source.provider_session_id.clone()
        };
        let from = provider_id.or_else(|| source.fork_from.clone()).ok_or((
            "NOTHING_TO_FORK",
            "Send a message in this chat before forking it.".to_owned(),
        ))?;
        let title = clip(&format!("Fork of {}", source.title), 200);
        // A fork is a new session: wake on with its own board address, as in start().
        let (wake, mailbox_address) = self.default_wake(&source.provider, &source.cwd, &title).await;
        let now = now_ms();
        let record = Record {
            id: format!("s_{}", random_hex(8)),
            provider: source.provider.clone(),
            project_id: source.project_id.clone(),
            // Claude finds a session to resume by its folder, so a fork stays put.
            cwd: source.cwd.clone(),
            title,
            wake,
            mailbox_address,
            team_note: true,
            access: source.access.clone(),
            status: "idle".into(),
            created_at: now,
            last_activity_at: now,
            model: source.model.clone(),
            effort: source.effort.clone(),
            usage: Usage {
                context_pct: source.usage.context_pct,
                ..Usage::default()
            },
            fork_from: Some(from),
            forked_from: Some(source.id.clone()),
            ..Record::default()
        };
        let _lifecycle = lock(&self.lifecycle);
        lock(&self.state).check_folder_available(&record.cwd)?;
        self.copy_log(&source.id, &record.id)
            .map_err(|message| ("STORAGE_FAILED", message))?;
        let mut state = lock(&self.state);
        state.records.push(record.clone());
        if let Err(message) = self.save(&state) {
            state.records.pop();
            drop(state);
            let _ = fs::remove_file(self.log_path(&record.id));
            return Err(("STORAGE_FAILED", message));
        }
        Ok(json!({"session": record}))
    }

    async fn handoff(self: &Arc<Self>, id: &str, to: Option<&str>) -> Result<Value, Failure> {
        let source = self.record_of(id)?;
        let from = Provider::parse(&source.provider)
            .ok_or(("SESSION_NOT_FOUND", "That chat has an unknown agent.".to_owned()))?;
        let target = match to.map(str::trim).filter(|t| !t.is_empty()) {
            None => match from {
                Provider::Claude => Provider::Codex,
                Provider::Codex => Provider::Claude,
            },
            Some(raw) => Provider::parse(raw).ok_or((
                "INVALID_ARGUMENTS",
                "toProvider must be claude or codex.".to_owned(),
            ))?,
        };
        if target == from {
            return Err((
                "INVALID_ARGUMENTS",
                "A hand-off goes to the other agent; fork the chat to continue with the same one."
                    .into(),
            ));
        }
        let history = self.history(id, Some(HISTORY_MAX))?;
        let events = history["events"].as_array().cloned().unwrap_or_default();
        let summary = handoff_text(from.label(), &source.title, &source.cwd, &events).ok_or((
            "NOTHING_TO_HAND_OFF",
            "This chat has no exchanges to hand off yet.".to_owned(),
        ))?;
        let created = self
            .start(json!({
                "provider": target.name(),
                "projectId": source.project_id,
                "cwd": source.cwd,
                "access": source.access,
                "model": null,
                "title": format!("{} (from {})", source.title, from.label()),
            }))
            .await?;
        let new_id = created["session"]["id"].as_str().unwrap_or_default().to_owned();
        self.with_record(&new_id, |r| r.handoff_from = Some(source.id.clone()))
            .map_err(|message| ("STORAGE_FAILED", message))?;
        let origin = json!({"kind": "handoff", "from": source.id, "fromProvider": source.provider});
        self.submit(&new_id, Queued::new(summary, Vec::new(), origin))?;
        let session = lock(&self.state).records.iter().find(|r| r.id == new_id).cloned();
        Ok(json!({"session": session}))
    }
}

// ----------------------------------------------------------------- commands

#[tauri::command]
pub(crate) async fn session_fork(app: tauri::AppHandle, id: String) -> Value {
    let inner = host(&app);
    reply(inner.fork(&id).await)
}

#[tauri::command]
pub(crate) async fn session_handoff(
    app: tauri::AppHandle,
    id: String,
    to_provider: Option<String>,
) -> Value {
    let inner = host(&app);
    reply(inner.handoff(&id, to_provider.as_deref()).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_keeps_the_last_exchanges_within_the_cap() {
        let mut events = Vec::new();
        for n in 0..20 {
            events.push(json!({"kind": "user", "turnId": format!("t{n}"), "text": format!("question {n} {}", "x".repeat(400))}));
            events.push(json!({"kind": "message", "turnId": format!("t{n}"), "text": format!("answer {n} {}", "y".repeat(400))}));
        }
        let text = handoff_text("Claude Code", "Ticker", "C:\\p", &events).unwrap();
        assert!(text.chars().count() <= HANDOFF_LIMIT);
        assert!(text.contains("answer 19") && !text.contains("question 7 "));
        assert!(text.starts_with("CodaClauda hand-off."));
        assert!(handoff_text("Codex", "t", "C:\\p", &[json!({"kind": "status"})]).is_none());
    }
}
