#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{Value, json};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tauri::Manager;
use tokio::{io::AsyncWriteExt, process::Command, time::timeout};

const OPERATIONS: &[&str] = &[
    "discover", "status", "connect", "grant", "submit", "messages", "request", "pause",
    "cancel", "reconnect", "spark-config", "spark",
];
const INPUT_LIMIT: usize = 256 * 1024;
const OUTPUT_LIMIT: usize = 16 * 1024 * 1024;

fn cli_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let packaged = app.path().resource_dir().map_err(|e| e.to_string())?
        .join("bin").join("claudacoda-cli.exe");
    if packaged.is_file() { return Ok(packaged); }
    #[cfg(debug_assertions)]
    {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../dist/bin/claudacoda-cli.exe");
        if development.is_file() { return Ok(development); }
    }
    Err(format!("The bundled coordination CLI is missing: {}. Reinstall ClaudaCoda.", packaged.display()))
}

fn error(code: &str, message: impl Into<String>) -> Value {
    json!({"ok": false, "error": {"code": code, "message": message.into()}})
}

#[tauri::command]
fn preferences(app: tauri::AppHandle) -> Value {
    match cli_path(&app) {
        Ok(path) => json!({"ok":true,"data":{"cli_path":path,"version":env!("CARGO_PKG_VERSION")}}),
        Err(message) => error("CLI_MISSING", message),
    }
}

/// The webview has no generic process or filesystem command. Every call is a
/// fixed CLI operation with a single JSON input; neither argument is shell text.
#[tauri::command]
async fn rpc(app: tauri::AppHandle, op: String, args: Value) -> Value {
    if !OPERATIONS.contains(&op.as_str()) {
        return error("OPERATION_DENIED", "This desktop operation is not supported.");
    }
    if !args.is_object() {
        return error("INVALID_ARGUMENTS", "Operation arguments must be a JSON object.");
    }
    let input = match serde_json::to_vec(&args) {
        Ok(input) if input.len() <= INPUT_LIMIT => input,
        _ => return error("INPUT_TOO_LARGE", "The request exceeds the desktop input limit."),
    };
    let path = match cli_path(&app) {
        Ok(path) => path,
        Err(message) => return error("CLI_MISSING", message),
    };
    let mut command = Command::new(path);
    command.args(["--json", "api", &op])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW; never a shell.
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => return error("CLI_START_FAILED", e.to_string()),
    };
    let result = timeout(Duration::from_secs(90), async move {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(&input).await?;
            stdin.shutdown().await?;
        }
        child.wait_with_output().await
    }).await;
    let output = match result {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return error("CLI_IO_FAILED", e.to_string()),
        Err(_) => return error("CLI_TIMEOUT", "The local operation timed out. Refresh the board before retrying a submission; it may already have been recorded."),
    };
    if output.stdout.len() > OUTPUT_LIMIT {
        return error("OUTPUT_TOO_LARGE", "The local response exceeds the desktop output limit.");
    }
    match serde_json::from_slice::<Value>(&output.stdout) {
        Ok(value) if value.get("ok").and_then(Value::as_bool).is_some() => value,
        _ => {
            let detail: String = String::from_utf8_lossy(&output.stderr).chars().take(2000).collect();
            error("CLI_PROTOCOL_ERROR", format!("The local CLI returned an invalid response (exit {}). {}", output.status, detail.trim()))
        }
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![rpc, preferences])
        .run(tauri::generate_context!())
        .expect("ClaudaCoda could not start");
}
