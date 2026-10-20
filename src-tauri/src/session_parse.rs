//! Pure parsing for the 0.4 session engine: provider stdout lines become a
//! small set of normalized outputs. No I/O happens here.

use serde_json::Value;

const SUMMARY_LIMIT: usize = 160;

#[derive(Debug, PartialEq)]
pub(crate) enum Out {
    /// Claude `system/init` session id.
    ProviderSession(String),
    Delta(String),
    Message(String),
    Tool { name: String, summary: String },
    Status(String),
    Error(String),
    /// End of a turn: completed | interrupted | failed.
    Done(String),
    /// Codex provider turn id (needed for turn/interrupt).
    TurnStarted(String),
    /// Codex JSON-RPC response to one of our requests.
    Response { id: u64, result: Result<Value, String> },
    /// Codex server-initiated request (approvals etc.); answered with an error.
    ServerRequest { id: Value, method: String },
    /// Claude control request (permission prompt); answered with an error.
    ControlRequest(String),
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// One line, at most SUMMARY_LIMIT characters.
pub(crate) fn clip(raw: &str) -> String {
    let flat: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let flat = flat.trim();
    if flat.chars().count() <= SUMMARY_LIMIT {
        return flat.to_owned();
    }
    let mut cut: String = flat.chars().take(SUMMARY_LIMIT - 1).collect();
    cut.push('…');
    cut
}

fn brief(input: &Value) -> String {
    for key in [
        "command",
        "file_path",
        "path",
        "notebook_path",
        "pattern",
        "url",
        "query",
        "description",
        "prompt",
    ] {
        if let Some(value) = input.get(key).and_then(Value::as_str) {
            return clip(value);
        }
    }
    match input {
        Value::Null => String::new(),
        Value::String(s) => clip(s),
        other => clip(&other.to_string()),
    }
}

/// Claude Code `--output-format stream-json --verbose --include-partial-messages`.
pub(crate) fn parse_claude(line: &Value) -> Vec<Out> {
    let mut out = Vec::new();
    match line["type"].as_str() {
        Some("system") => match line["subtype"].as_str() {
            Some("init") => {
                if let Some(id) = text(&line["session_id"]) {
                    out.push(Out::ProviderSession(id));
                }
            }
            Some("api_retry") => out.push(Out::Status("retrying".into())),
            _ => {}
        },
        Some("stream_event") => {
            let event = &line["event"];
            if event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta" {
                if let Some(chunk) = text(&event["delta"]["text"]) {
                    out.push(Out::Delta(chunk));
                }
            }
        }
        Some("assistant") => {
            if let Some(blocks) = line["message"]["content"].as_array() {
                for block in blocks {
                    match block["type"].as_str() {
                        Some("text") => {
                            if let Some(t) = text(&block["text"]) {
                                out.push(Out::Message(t));
                            }
                        }
                        Some("tool_use") | Some("server_tool_use") => out.push(Out::Tool {
                            name: text(&block["name"]).unwrap_or_else(|| "tool".into()),
                            summary: brief(&block["input"]),
                        }),
                        _ => {}
                    }
                }
            }
        }
        Some("result") => {
            let success = line["subtype"] == "success" && line["is_error"] != true;
            if !success {
                let detail = text(&line["result"])
                    .or_else(|| {
                        line["errors"].as_array().map(|errors| {
                            errors
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join("; ")
                        })
                    })
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| {
                        format!(
                            "Claude ended the turn: {}",
                            line["subtype"].as_str().unwrap_or("error")
                        )
                    });
                out.push(Out::Error(detail));
            }
            out.push(Out::Done(if success { "completed" } else { "failed" }.into()));
        }
        Some("control_request") => {
            if let Some(id) = text(&line["request_id"]) {
                out.push(Out::ControlRequest(id));
            }
        }
        _ => {}
    }
    out
}

fn codex_tool(item: &Value) -> Option<Out> {
    let (name, summary) = match item["type"].as_str()? {
        "commandExecution" => ("shell".to_owned(), clip(item["command"].as_str().unwrap_or(""))),
        "fileChange" => {
            let paths: Vec<&str> = item["changes"]
                .as_array()
                .map(|changes| changes.iter().filter_map(|c| c["path"].as_str()).collect())
                .unwrap_or_default();
            ("edit".to_owned(), clip(&paths.join(", ")))
        }
        "mcpToolCall" => (
            format!(
                "{}.{}",
                item["server"].as_str().unwrap_or("mcp"),
                item["tool"].as_str().unwrap_or("tool")
            ),
            brief(&item["arguments"]),
        ),
        "dynamicToolCall" => (
            item["tool"].as_str().unwrap_or("tool").to_owned(),
            brief(&item["arguments"]),
        ),
        "webSearch" => ("web_search".to_owned(), clip(item["query"].as_str().unwrap_or(""))),
        "imageView" => ("view_image".to_owned(), clip(item["path"].as_str().unwrap_or(""))),
        _ => return None,
    };
    Some(Out::Tool { name, summary })
}

/// Codex `app-server` stdio JSON-RPC (newline JSON, no `jsonrpc` field).
pub(crate) fn parse_codex(line: &Value) -> Vec<Out> {
    let mut out = Vec::new();
    let Some(method) = line["method"].as_str() else {
        if let Some(id) = line["id"].as_u64() {
            let result = match line.get("error") {
                Some(error) if !error.is_null() => Err(error["message"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| error.to_string())),
                _ => Ok(line.get("result").cloned().unwrap_or(Value::Null)),
            };
            out.push(Out::Response { id, result });
        }
        return out;
    };
    if let Some(id) = line.get("id").filter(|id| !id.is_null()) {
        out.push(Out::ServerRequest {
            id: id.clone(),
            method: method.to_owned(),
        });
        return out;
    }
    let params = &line["params"];
    match method {
        "item/agentMessage/delta" => {
            if let Some(chunk) = text(&params["delta"]) {
                out.push(Out::Delta(chunk));
            }
        }
        "item/started" => out.extend(codex_tool(&params["item"])),
        "item/completed" => {
            if params["item"]["type"] == "agentMessage" {
                if let Some(t) = text(&params["item"]["text"]) {
                    out.push(Out::Message(t));
                }
            }
        }
        "turn/started" => {
            if let Some(id) = text(&params["turn"]["id"]) {
                out.push(Out::TurnStarted(id));
            }
        }
        "turn/completed" => {
            let status = params["turn"]["status"].as_str().unwrap_or("completed");
            if status == "failed" {
                out.push(Out::Error(
                    text(&params["turn"]["error"]["message"])
                        .unwrap_or_else(|| "Codex reported a failed turn.".into()),
                ));
            }
            out.push(Out::Done(
                match status {
                    "interrupted" | "failed" => status,
                    _ => "completed",
                }
                .into(),
            ));
        }
        "error" => {
            let message = text(&params["error"]["message"]).unwrap_or_else(|| "Codex error".into());
            if params["willRetry"] == true {
                out.push(Out::Status(format!("retrying: {}", clip(&message))));
            } else {
                out.push(Out::Error(message));
            }
        }
        _ => {}
    }
    out
}

/// First dotted number run, for example "2.1.299 (Claude Code)" → [2, 1, 299].
pub(crate) fn parse_version(raw: &str) -> Vec<u64> {
    let bytes = raw.as_bytes();
    let mut start = 0;
    while start < bytes.len() {
        if bytes[start].is_ascii_digit() {
            let mut end = start;
            while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'.') {
                end += 1;
            }
            let run = raw[start..end].trim_end_matches('.');
            if run.contains('.') {
                return run.split('.').filter_map(|p| p.parse().ok()).collect();
            }
            start = end;
        } else {
            start += 1;
        }
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn versions_and_claude_stream() {
        assert_eq!(parse_version("2.1.299 (Claude Code)"), vec![2, 1, 299]);
        assert_eq!(parse_version("codex-cli 0.163.0-alpha.10.2"), vec![0, 163, 0]);
        assert_eq!(
            parse_claude(&json!({"type":"system","subtype":"init","session_id":"abc"})),
            vec![Out::ProviderSession("abc".into())]
        );
        assert_eq!(
            parse_claude(&json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}})),
            vec![Out::Delta("Hi".into())]
        );
        assert_eq!(
            parse_claude(&json!({"type":"assistant","message":{"content":[{"type":"text","text":"Done."},{"type":"tool_use","name":"Bash","input":{"command":"ls\n-la"}}]}})),
            vec![
                Out::Message("Done.".into()),
                Out::Tool { name: "Bash".into(), summary: "ls -la".into() }
            ]
        );
        assert_eq!(
            parse_claude(&json!({"type":"result","subtype":"success","is_error":false})),
            vec![Out::Done("completed".into())]
        );
    }

    #[test]
    fn codex_notifications_and_responses() {
        assert_eq!(
            parse_codex(&json!({"method":"item/agentMessage/delta","params":{"delta":"x","itemId":"i","threadId":"t","turnId":"u"}})),
            vec![Out::Delta("x".into())]
        );
        assert_eq!(
            parse_codex(&json!({"method":"turn/completed","params":{"threadId":"t","turn":{"id":"u","status":"interrupted","items":[]}}})),
            vec![Out::Done("interrupted".into())]
        );
        assert_eq!(
            parse_codex(&json!({"id":3,"result":{"turn":{"id":"u"}}})),
            vec![Out::Response { id: 3, result: Ok(json!({"turn":{"id":"u"}})) }]
        );
        assert!(matches!(
            parse_codex(&json!({"id":9,"method":"item/commandExecution/requestApproval","params":{}}))[0],
            Out::ServerRequest { .. }
        ));
    }
}
