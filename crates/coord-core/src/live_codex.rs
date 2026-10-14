//! Attach to an already running Codex server through its public CLI proxy.
//! Never starts/resumes/forks a provider conversation or changes its permissions.
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, Stdio},
    sync::mpsc::{self, Receiver, SyncSender},
    time::{Duration, Instant},
};

const LINE_LIMIT: u64 = 1024 * 1024;
const CALL_TIMEOUT: Duration = Duration::from_secs(10);

struct Proxy {
    child: Child,
    outbound: SyncSender<Value>,
    writes: Receiver<std::result::Result<(), String>>,
    inbound: Receiver<std::result::Result<Value, String>>,
    next_id: u64,
}
impl Drop for Proxy {
    fn drop(&mut self) {
        // This is only our short-lived stdio proxy, never the shared daemon.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Proxy {
    fn connect(executable: &Path, socket: Option<&Path>) -> Result<Self> {
        ensure!(
            executable.is_absolute() && executable.is_file(),
            "Select an existing absolute Codex executable"
        );
        #[cfg(windows)]
        ensure!(
            executable
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("exe")),
            "Codex must be a native executable"
        );
        if let Some(socket) = socket {
            ensure!(
                socket.is_absolute(),
                "Codex control socket must be an absolute path"
            );
        }
        let mut command = crate::command(executable);
        command.args(["app-server", "proxy"]);
        if let Some(socket) = socket {
            command.arg("--sock").arg(socket);
        }
        command
            .env_remove("CODACLAUDA_CAPABILITY")
            .env_remove("CLAUDACODA_SESSION_CAPABILITY")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command
            .spawn()
            .context("Could not start the supported Codex control-socket proxy")?;
        let mut stdin = child
            .stdin
            .take()
            .context("Codex proxy input unavailable")?;
        let stdout = child
            .stdout
            .take()
            .context("Codex proxy output unavailable")?;
        let (outbound, output) = mpsc::sync_channel::<Value>(1);
        let (write_result, writes) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            while let Ok(value) = output.recv() {
                let result = writeln!(stdin, "{value}")
                    .and_then(|_| stdin.flush())
                    .map_err(|_| "Codex proxy disconnected while writing".to_owned());
                let failed = result.is_err();
                if write_result.send(result).is_err() || failed {
                    break;
                }
            }
        });
        let (events, inbound) = mpsc::sync_channel(32);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                let result = match reader
                    .by_ref()
                    .take(LINE_LIMIT + 1)
                    .read_until(b'\n', &mut bytes)
                {
                    Ok(0) => Err(
                        "The running Codex server is unavailable through its public proxy"
                            .to_owned(),
                    ),
                    Ok(_) if bytes.len() as u64 <= LINE_LIMIT && bytes.ends_with(b"\n") => {
                        serde_json::from_slice(&bytes)
                            .map_err(|_| "Invalid Codex proxy JSON".to_owned())
                    }
                    _ => Err("Codex proxy response exceeded its bound or disconnected".to_owned()),
                };
                let failed = result.is_err();
                if events.send(result).is_err() || failed {
                    break;
                }
            }
        });
        let mut proxy = Self {
            child,
            outbound,
            writes,
            inbound,
            next_id: 1,
        };
        proxy.call("initialize", json!({"clientInfo":{"name":"claudacoda_live","title":"ClaudaCoda existing-conversation messaging","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}))?;
        proxy.send(
            json!({"method":"initialized"}),
            Instant::now() + CALL_TIMEOUT,
        )?;
        Ok(proxy)
    }
    fn send(&mut self, value: Value, deadline: Instant) -> Result<()> {
        self.outbound
            .try_send(value)
            .context("Codex proxy writer unavailable")?;
        self.writes
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .context("Timed out writing to the running Codex server")?
            .map_err(anyhow::Error::msg)
    }
    fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let deadline = Instant::now() + CALL_TIMEOUT;
        self.send(json!({"id":id,"method":method,"params":params}), deadline)?;
        loop {
            let value = self
                .inbound
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .context("Timed out waiting for the running Codex server")?
                .map_err(anyhow::Error::msg)?;
            // Never satisfy approvals or echo unrelated model messages.
            if value.get("id").and_then(Value::as_u64) != Some(id) || value.get("method").is_some()
            {
                continue;
            }
            ensure!(
                value.get("error").is_none(),
                "Codex rejected {method}; inspect the connection in Codex before retrying"
            );
            return value
                .get("result")
                .cloned()
                .context("Codex response omitted result");
        }
    }
    fn verify_target(&mut self, chat_id: &str, project: &Path) -> Result<Value> {
        uuid::Uuid::parse_str(chat_id)
            .context("Use the exact Codex thread UUID, not a label or session-tree ID")?;
        let mut cursor = Value::Null;
        let mut found = false;
        for _ in 0..20 {
            let result = self.call("thread/loaded/list", json!({"limit":100,"cursor":cursor}))?;
            let ids = result["data"]
                .as_array()
                .context("Codex loaded-thread inventory is invalid")?;
            if ids.iter().any(|id| id.as_str() == Some(chat_id)) {
                found = true;
                break;
            }
            cursor = result.get("nextCursor").cloned().unwrap_or(Value::Null);
            if cursor.is_null() {
                break;
            }
        }
        ensure!(
            found,
            "The selected chat is not loaded on this running Codex server. No session was started or resumed"
        );
        let result = self.call(
            "thread/read",
            json!({"threadId":chat_id,"includeTurns":false}),
        )?;
        verify_metadata(&result, chat_id, project)
    }
}

fn verify_metadata(result: &Value, chat_id: &str, project: &Path) -> Result<Value> {
    let thread = &result["thread"];
    ensure!(
        thread["id"].as_str() == Some(chat_id),
        "Codex returned a different thread identity"
    );
    let cwd = thread["cwd"]
        .as_str()
        .context("Codex did not report the selected chat's project")?;
    ensure!(
        std::fs::canonicalize(cwd)? == std::fs::canonicalize(project)?,
        "Codex chat project differs from its ClaudaCoda registration"
    );
    Ok(
        json!({"thread_id":chat_id,"project":project,"status":thread["status"],"identity":"loaded-thread-on-connected-server","adapter":"codex-public-proxy","queue_api":"experimental"}),
    )
}

/// Read-only proof that this exact conversation is loaded on the reached server.
pub fn probe(
    executable: &Path,
    socket: Option<&Path>,
    chat_id: &str,
    project: &Path,
) -> Result<Value> {
    Proxy::connect(executable, socket)?.verify_target(chat_id, project)
}

/// Caller must durably claim the message BEFORE invoking this operation.
/// Any error after that claim is ambiguous and must not automatically retry.
pub fn deliver(
    executable: &Path,
    socket: Option<&Path>,
    chat_id: &str,
    project: &Path,
    message_id: &str,
    content: &str,
) -> Result<Value> {
    crate::safe_id(message_id)?;
    ensure!(
        !content.is_empty() && content.len() <= 64 * 1024,
        "Message exceeds the live Codex delivery bound"
    );
    let mut proxy = Proxy::connect(executable, socket)?;
    let verified = proxy.verify_target(chat_id, project)?;
    let response = proxy.call("thread/queue/add", json!({"threadId":chat_id,"clientUserMessageId":message_id,"input":[{"type":"text","text":content}]}))?;
    let queued = &response["queuedSubmission"];
    ensure!(
        queued["clientUserMessageId"].as_str() == Some(message_id),
        "Codex queue receipt does not match the message ID"
    );
    let queue_id = queued["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 512)
        .context("Codex did not return a bounded queue receipt")?;
    // Existing busy threads retain their queue. Do not interrupt them or create
    // another engine. Only an idle thread gets an explicit queue-start request.
    let status = &verified["status"];
    let idle = status.as_str() == Some("idle") || status["type"].as_str() == Some("idle");
    let mut receipt = json!({"adapter":"codex-public-proxy","thread_id":chat_id,"client_message_id":message_id,"queue_id":queue_id,"state":"submitted","acknowledged":false,"queue_api":"experimental","note":"Provider queue accepted the message; awaiting recipient acknowledgment"});
    if idle {
        match proxy.call(
            "thread/queue/start",
            json!({"threadId":chat_id,"queuedSubmissionId":queue_id}),
        ) {
            Ok(result) => {
                receipt["turn_id"] = result["turn"]["id"].clone();
            }
            Err(_) => {
                receipt["note"] = json!(
                    "Provider queue accepted the message, but starting its turn was not confirmed. Do not resend; inspect the existing chat"
                );
            }
        }
    }
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_requires_exact_thread_and_project() {
        let project = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let value = json!({"thread":{"id":id,"cwd":project.path(),"status":{"type":"idle"},"preview":"private history must not escape"}});
        let result = verify_metadata(&value, &id, project.path()).unwrap();
        assert!(!result.to_string().contains("private history"));
        assert!(verify_metadata(&value, "different", project.path()).is_err());
        assert!(verify_metadata(&value, &id, other.path()).is_err());
    }
    #[test]
    fn invalid_proxy_target_is_rejected_before_spawn() {
        assert!(
            probe(
                Path::new("relative-executable"),
                None,
                "chat",
                Path::new(".")
            )
            .is_err()
        );
    }
}
