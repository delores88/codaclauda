//! Pure parsing for the 0.4 session engine: provider stdout lines become a
//! small set of normalized outputs. No I/O happens here.

use serde::{Deserialize, Serialize};
use serde_json::Value;

const SUMMARY_LIMIT: usize = 160;

/// A session's running token totals (0.5). `costUsd` is Claude's own estimate
/// (never invented for Codex); `contextPct` is the last reported context fill.
#[derive(Clone, Copy, Default, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Usage {
    pub input: u64,
    pub output: u64,
    pub cached: u64,
    pub cost_usd: Option<f64>,
    pub context_pct: Option<f64>,
}

/// Cumulative usage as one provider process reports it.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub(crate) struct Reported {
    pub input: u64,
    pub output: u64,
    pub cached: u64,
    pub cost: Option<f64>,
    pub context_tokens: Option<u64>,
    pub context_window: Option<u64>,
}

/// Providers report totals for their own process or thread, and a resumed
/// provider may or may not restore earlier totals. The first report of a
/// process decides: totals at least as large as the saved ones were restored;
/// smaller totals start again and are added to what was saved.
pub(crate) fn merge_usage(
    saved: &Usage,
    restored: &mut Option<bool>,
    now: &Reported,
    context_pct: Option<f64>,
) -> Usage {
    let restored =
        *restored.get_or_insert(now.input + now.output >= saved.input + saved.output);
    let base = if restored { Usage::default() } else { *saved };
    Usage {
        input: base.input + now.input,
        output: base.output + now.output,
        cached: base.cached + now.cached,
        cost_usd: match now.cost {
            Some(cost) => Some(base.cost_usd.unwrap_or(0.0) + cost),
            None => saved.cost_usd,
        },
        context_pct: context_pct.or(saved.context_pct),
    }
}

/// Percent of the context window in use, one decimal, at most 100.
pub(crate) fn context_pct(tokens: Option<u64>, window: Option<u64>) -> Option<f64> {
    match (tokens, window) {
        (Some(tokens), Some(window)) if window > 0 => {
            Some(((tokens as f64 / window as f64) * 1000.0).round().min(1000.0) / 10.0)
        }
        _ => None,
    }
}

fn count(value: &Value) -> u64 {
    value.as_u64().unwrap_or(0)
}

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
    /// Cumulative usage (Claude `result`, Codex `thread/tokenUsage/updated`).
    Usage(Reported),
    /// Claude: tokens in context after the latest model call.
    Context(u64),
    /// Codex `account/rateLimits/updated` (account-wide, not thread-bound).
    RateLimits(Value),
    /// Codex `thread/compacted`.
    Compacted,
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
            let usage = &line["message"]["usage"];
            if usage.is_object() {
                let tokens = count(&usage["input_tokens"])
                    + count(&usage["cache_creation_input_tokens"])
                    + count(&usage["cache_read_input_tokens"])
                    + count(&usage["output_tokens"]);
                if tokens > 0 {
                    out.push(Out::Context(tokens));
                }
            }
            if let Some(blocks) = line["message"]["content"].as_array() {
                // Text blocks belong to one assistant message. Keep them
                // together so the transcript and final-reply preview begin
                // with its first block rather than treating its last block
                // as a separate final answer.
                let parts: Vec<_> = blocks.iter().filter(|block| block["type"] == "text")
                    .filter_map(|block| block["text"].as_str().filter(|value| !value.is_empty())).collect();
                let mut message = (!parts.is_empty()).then(|| parts.join("\n\n"));
                for block in blocks {
                    match block["type"].as_str() {
                        Some("text") => {
                            if let Some(t) = message.take() {
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
            let usage = &line["usage"];
            if usage.is_object() || line["total_cost_usd"].is_number() {
                let cache_read = count(&usage["cache_read_input_tokens"]);
                let window = line["modelUsage"]
                    .as_object()
                    .and_then(|models| models.values().filter_map(|m| m["contextWindow"].as_u64()).max());
                out.push(Out::Usage(Reported {
                    input: count(&usage["input_tokens"])
                        + count(&usage["cache_creation_input_tokens"])
                        + cache_read,
                    output: count(&usage["output_tokens"]),
                    cached: cache_read,
                    cost: line["total_cost_usd"].as_f64().filter(|c| c.is_finite() && *c >= 0.0),
                    context_tokens: None,
                    context_window: window,
                }));
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
        "thread/tokenUsage/updated" => {
            let usage = &params["tokenUsage"];
            let total = &usage["total"];
            out.push(Out::Usage(Reported {
                input: count(&total["inputTokens"]),
                output: count(&total["outputTokens"]),
                cached: count(&total["cachedInputTokens"]),
                cost: None, // a ChatGPT plan reports no per-request dollar figure
                context_tokens: usage["last"]["totalTokens"].as_u64(),
                context_window: usage["modelContextWindow"].as_u64(),
            }));
        }
        "account/rateLimits/updated" => {
            if params["rateLimits"].is_object() {
                out.push(Out::RateLimits(params["rateLimits"].clone()));
            }
        }
        "thread/compacted" => out.push(Out::Compacted),
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

    #[test]
    fn usage_is_parsed_and_merged_across_processes() {
        let codex = parse_codex(&json!({"method":"thread/tokenUsage/updated","params":{"threadId":"t","turnId":"u",
            "tokenUsage":{"total":{"inputTokens":900,"cachedInputTokens":400,"outputTokens":50,"reasoningOutputTokens":0,"totalTokens":950},
                          "last":{"inputTokens":300,"cachedInputTokens":0,"outputTokens":20,"reasoningOutputTokens":0,"totalTokens":320},
                          "modelContextWindow":1000}}}));
        let Out::Usage(reported) = codex[0] else { panic!("usage") };
        assert_eq!((reported.input, reported.cached, reported.cost), (900, 400, None));
        assert_eq!(context_pct(reported.context_tokens, reported.context_window), Some(32.0));
        let claude = parse_claude(&json!({"type":"result","subtype":"success","total_cost_usd":0.25,
            "usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":5},"modelUsage":{"m":{"contextWindow":200000}}}));
        assert!(matches!(claude[0], Out::Usage(Reported { input: 100, cached: 90, output: 5, .. })));
        let saved = Usage { input: 1000, output: 100, cached: 0, cost_usd: Some(1.0), context_pct: None };
        // A resumed process that restarts its counters adds to the saved totals...
        let mut restored = None;
        let fresh = Reported { input: 10, output: 1, cost: Some(0.5), ..Reported::default() };
        let merged = merge_usage(&saved, &mut restored, &fresh, Some(5.0));
        assert_eq!((merged.input, merged.cost_usd, merged.context_pct), (1010, Some(1.5), Some(5.0)));
        // ...and one that restored them replaces them.
        let mut restored = None;
        let carried = Reported { input: 1200, output: 120, cost: Some(1.2), ..Reported::default() };
        assert_eq!(merge_usage(&saved, &mut restored, &carried, None).input, 1200);
    }
}
