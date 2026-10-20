//! Version 1 adapters. Only owned, newly created provider processes are controlled.
use anyhow::{Context, Result, bail};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
    thread,
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const LINE_LIMIT: usize = 1024 * 1024;
// Only these request-bound server tools receive noninteractive provider approval.
// Each call still passes the MCP server's immutable owner-grant checks.
const OWNED_MCP_TOOLS: &[&str] = &[
    "get_context",
    "list_files",
    "read_file",
    "write_file",
    "ask",
    "review",
    "delegate",
    "wait",
    "messages",
    "cancel",
    "spark_status",
    "spark_run",
    "spark_wait",
    "spark_logs",
    "spark_cancel",
];

pub struct LaunchSpec {
    pub agent: String,
    pub executable: PathBuf,
    pub workspace: PathBuf,
    pub prompt: String,
    pub mcp_executable: PathBuf,
    pub state_dir: PathBuf,
    pub request_id: String,
    pub capability: String,
    pub timeout_seconds: u64,
    pub max_turns: u32,
    pub work_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Outcome {
    pub success: bool,
    pub session_id: Option<String>,
    pub answer: String,
    pub usage: Value,
    pub estimated_cost_usd: Option<f64>,
    pub exit_code: Option<i32>,
    pub stop_reason: Option<String>,
}

/// Start an owner worker without inheriting the caller's capture pipes or a
/// provider job. The capability is delivered only through its private stdin.
pub fn spawn_worker(
    executable: &Path,
    args: &[OsString],
    cwd: &Path,
    capability: &str,
) -> Result<()> {
    native_executable(executable)?;
    if !cwd.is_absolute() || !cwd.is_dir() || capability.is_empty() || capability.len() > 256 {
        bail!("invalid worker directory or capability");
    }
    #[cfg(windows)]
    return win::spawn_worker(
        executable,
        args,
        cwd,
        &subscription_environment(),
        capability,
    );
    #[cfg(not(windows))]
    {
        let _ = args;
        bail!("worker process handle isolation is supported on Windows only");
    }
}

pub fn subscription_environment() -> BTreeMap<OsString, OsString> {
    // Never inspect credential values. Provider-owned saved authentication stays in place.
    std::env::vars_os()
        .filter(|(key, _)| {
            let key = key.to_string_lossy().to_ascii_uppercase();
            !matches!(
                key.as_str(),
                "OPENAI_API_KEY"
                    | "CODEX_API_KEY"
                    | "ANTHROPIC_API_KEY"
                    | "ANTHROPIC_AUTH_TOKEN"
                    | "ANTHROPIC_BASE_URL"
                    | "OPENAI_BASE_URL"
                    | "CLAUDE_CODE_OAUTH_TOKEN"
                    | "CLAUDE_CODE_API_KEY_HELPER_TTL_MS"
                    | "CLAUDE_CODE_USE_BEDROCK"
                    | "CLAUDE_CODE_USE_VERTEX"
                    | "CLAUDE_CODE_USE_FOUNDRY"
                    | "CLAUDE_CODE_SIMPLE"
                    | "CLAUDE_CODE_SAFE_MODE"
                    | "CLAUDE_CODE_RESUME_INTERRUPTED_TURN"
                    | "CODACLAUDA_CAPABILITY"
            )
        })
        .collect()
}

fn clean_text(text: &str, capability: &str) -> String {
    let mut text = if capability.is_empty() {
        text.to_owned()
    } else {
        text.replace(capability, "[REDACTED]")
    };
    for pattern in [
        r"(?i)\b(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{12,}",
        r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{12,}",
        r"(?i)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+",
    ] {
        if let Ok(regex) = Regex::new(pattern) {
            text = regex.replace_all(&text, "[REDACTED]").into_owned();
        }
    }
    text
}

fn scrub_value(value: &Value, capability: &str) -> Value {
    match value {
        Value::String(s) => Value::String(clean_text(s, capability)),
        Value::Array(a) => Value::Array(a.iter().map(|v| scrub_value(v, capability)).collect()),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    let key_lower = key.to_ascii_lowercase();
                    let secret = [
                        "api_key",
                        "apikey",
                        "access_token",
                        "refresh_token",
                        "authorization",
                        "password",
                        "capability",
                        "secret",
                    ]
                    .iter()
                    .any(|needle| key_lower.contains(needle));
                    (
                        key.clone(),
                        if secret {
                            json!("[REDACTED]")
                        } else {
                            scrub_value(value, capability)
                        },
                    )
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn valid_agent(agent: &str) -> Result<()> {
    if !matches!(agent, "claude" | "codex") {
        bail!("unsupported adapter: {agent}");
    }
    Ok(())
}

fn native_executable(path: &Path) -> Result<()> {
    if !path.is_absolute() || !path.is_file() {
        bail!("provider executable must be an existing absolute native executable path");
    }
    #[cfg(windows)]
    if !path
        .extension()
        .is_some_and(|x| x.to_string_lossy().eq_ignore_ascii_case("exe"))
    {
        bail!("Windows adapters require a native .exe; shell wrappers are not supported");
    }
    Ok(())
}

/// Read-only install/authentication checks. No model request or session resume.
pub fn probe(agent: &str, executable: &Path) -> Result<Value> {
    valid_agent(agent)?;
    native_executable(executable)?;
    let cwd = executable.parent().context("executable has no parent")?;
    let version = capture(executable, &["--version".into()], cwd, 10)?;
    if version.code != Some(0) {
        bail!(
            "provider version check failed: {}",
            clean_text(&version.stderr, "")
        );
    }
    let version = version.stdout.trim().to_owned();
    let help_args: Vec<OsString> = if agent == "codex" {
        vec!["exec".into(), "--help".into()]
    } else {
        vec!["--help".into()]
    };
    let help = capture(executable, &help_args, cwd, 10)?;
    let required: &[&str] = if agent == "codex" {
        &["--ignore-user-config", "--json", "--sandbox"]
    } else {
        &[
            "--restricted",
            "--strict-mcp-config",
            "--tools",
            "--session-id",
            "--permission-prompts",
        ]
    };
    let supported = help.code == Some(0) && required.iter().all(|flag| help.stdout.contains(flag));
    let args: Vec<OsString> = if agent == "claude" {
        vec!["auth".into(), "status".into()]
    } else {
        vec!["login".into(), "status".into()]
    };
    let auth = capture(executable, &args, cwd, 10)?;
    let (authenticated, method) = if agent == "claude" {
        let data: Value = serde_json::from_str(&auth.stdout).unwrap_or(Value::Null);
        let method = data
            .get("authMethod")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        (
            auth.code == Some(0)
                && data.get("loggedIn").and_then(Value::as_bool) == Some(true)
                && method == "claude.ai",
            method.to_owned(),
        )
    } else {
        let logged_in = auth.code == Some(0)
            && format!("{}{}", auth.stdout, auth.stderr).contains("Logged in using ChatGPT");
        (
            logged_in,
            if logged_in {
                "chatgpt"
            } else {
                "unavailable_or_not_subscription"
            }
            .to_owned(),
        )
    };
    Ok(
        json!({"agent":agent,"executable":executable,"version":version,"mode":"new-session-v1",
        "supported":supported,"authenticated":authenticated,"auth_method":method,
        "auth_status":if authenticated {"authenticated"} else {"needs-owner"},
        "status":if !supported {"unsupported"} else if authenticated {"available"} else {"needs-owner"},
        "hard_token_cap":false,"hard_dollar_cap":false,"turn_cap":agent=="claude",
        "existing_session_delivery":"unsupported","cost":if agent=="claude" {"provider_estimate"} else {"unavailable"}}),
    )
}

/// Locate binary distributions and probe at most two candidates per agent.
/// Does not inspect profile/session files or credential values.
pub fn discover() -> Value {
    fn collect(root: &Path, name: &str, depth: usize, output: &mut Vec<PathBuf>) {
        if depth == 0 || output.len() >= 32 {
            return;
        }
        let Ok(entries) = fs::read_dir(root) else {
            return;
        };
        for entry in entries.take(128).flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_file()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(name)
            {
                output.push(entry.path());
            } else if kind.is_dir() {
                collect(&entry.path(), name, depth - 1, output);
            }
        }
    }
    let mut codex = Vec::new();
    let mut claude = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for (name, target) in [("codex.exe", &mut codex), ("claude.exe", &mut claude)] {
                let path = dir.join(name);
                if path.is_absolute() && path.is_file() {
                    target.push(path);
                }
            }
        }
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let profile = PathBuf::from(profile);
        collect(
            &profile.join("AppData/Local/OpenAI/Codex/bin"),
            "codex.exe",
            3,
            &mut codex,
        );
        collect(
            &profile.join("AppData/Roaming/npm/node_modules/@openai"),
            "codex.exe",
            8,
            &mut codex,
        );
        collect(&profile.join(".local/bin"), "claude.exe", 1, &mut claude);
        collect(
            &profile.join("AppData/Roaming/Claude/claude-code"),
            "claude.exe",
            4,
            &mut claude,
        );
        if let Ok(packages) = fs::read_dir(profile.join("AppData/Local/Packages")) {
            for package in packages.flatten().filter(|p| {
                p.file_name()
                    .to_string_lossy()
                    .starts_with("AnthropicPBC.Claude_")
            }) {
                collect(
                    &package.path().join("LocalCache/Roaming/Claude/claude-code"),
                    "claude.exe",
                    4,
                    &mut claude,
                );
            }
        }
    }
    fn endpoint(agent: &str, candidates: &mut Vec<PathBuf>) -> Value {
        // Preserve PATH priority. Never turn a binary search into dozens of probes.
        let mut seen = std::collections::BTreeSet::new();
        candidates.retain(|path| seen.insert(path.to_string_lossy().to_ascii_lowercase()));
        let mut best = json!({"agent":agent,"executable":null,"version":null,
            "authenticated":false,"supported":false,"auth_status":"unavailable","status":"unavailable"});
        for candidate in candidates.iter().take(2) {
            match probe(agent, candidate) {
                Ok(result) => {
                    let ready = result["supported"] == true && result["authenticated"] == true;
                    if best["supported"] != true || ready {
                        best = result;
                    }
                    if ready {
                        break;
                    }
                }
                Err(error) if best["executable"].is_null() => {
                    best["executable"] = json!(candidate);
                    best["status"] = json!("unsupported");
                    best["diagnostic"] = json!(clean_text(&error.to_string(), ""));
                }
                Err(_) => {}
            }
        }
        best
    }
    let agents = vec![
        endpoint("codex", &mut codex),
        endpoint("claude", &mut claude),
    ];
    json!({"schema_version":1,"agents":agents,"codex":codex,"claude":claude,
        "note":"Read-only binary and subscription probes; no model requests. At most two candidates per agent are probed."})
}

fn launch_args(spec: &LaunchSpec) -> Result<Vec<OsString>> {
    let args = vec![
        "--state-dir".to_owned(),
        spec.state_dir.to_string_lossy().into_owned(),
        "mcp".to_owned(),
        "--request".to_owned(),
        spec.request_id.clone(),
    ];
    let server = json!({"command":spec.mcp_executable,"args":args,"env":{"CODACLAUDA_CAPABILITY":spec.capability}});
    if spec.agent == "claude" {
        let config = spec.work_dir.join("claude-mcp.json");
        write_new(
            &config,
            &serde_json::to_vec_pretty(&json!({"mcpServers":{"codaclauda":server}}))?,
        )?;
        Ok(vec![
            "--print".into(),
            "--restricted".into(),
            "--strict-mcp-config".into(),
            "--mcp-config".into(),
            config.into_os_string(),
            "--tools".into(),
            "".into(),
            "--allowedTools".into(),
            "mcp__codaclauda__*".into(),
            "--permission-mode".into(),
            "dontAsk".into(),
            "--permission-prompts".into(),
            "none".into(),
            "--disable-slash-commands".into(),
            "--no-chrome".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--max-turns".into(),
            spec.max_turns.to_string().into(),
            "--session-id".into(),
            uuid::Uuid::new_v4().to_string().into(),
        ])
    } else {
        let mut result: Vec<OsString> = vec![
            "--no-daemon".into(),
            "exec".into(),
            "--ignore-user-config".into(),
            "--strict-config".into(),
            "--json".into(),
            "--sandbox".into(),
            "read-only".into(),
            "--color".into(),
            "never".into(),
            "-C".into(),
            spec.workspace.as_os_str().to_owned(),
        ];
        let mut config = vec![
            "forced_login_method=\"chatgpt\"".to_owned(),
            "approval_policy=\"never\"".to_owned(),
            "web_search=\"disabled\"".to_owned(),
            "project_doc_max_bytes=0".to_owned(),
            // The host also carries MCP discovery; disabling it disables owned tools.
            // Excluding the native functions namespace from the nested map, with
            // code-mode-only exposure, removes native apply_patch as well as shell
            // access. shell_tool=false alone does not remove apply_patch.
            "features.code_mode={enabled=true,excluded_tool_namespaces=[\"functions\"]}".to_owned(),
            "features.code_mode_only=true".to_owned(),
            "features.code_mode_host={enabled=true,disable_in_process_fallback=true}".to_owned(),
            format!(
                "projects.{}.trust_level=\"untrusted\"",
                serde_json::to_string(&spec.workspace.to_string_lossy())?
            ),
            format!(
                "mcp_servers.codaclauda.command={}",
                serde_json::to_string(&spec.mcp_executable.to_string_lossy())?
            ),
            format!(
                "mcp_servers.codaclauda.args={}",
                serde_json::to_string(&args)?
            ),
            format!(
                "mcp_servers.codaclauda.env.CODACLAUDA_CAPABILITY={}",
                serde_json::to_string(&spec.capability)?
            ),
            "mcp_servers.codaclauda.required=true".to_owned(),
            "mcp_servers.codaclauda.tool_timeout_sec=65".to_owned(),
            "mcp_servers.codaclauda.default_tools_approval_mode=\"prompt\"".to_owned(),
            format!(
                "mcp_servers.codaclauda.enabled_tools={}",
                serde_json::to_string(OWNED_MCP_TOOLS)?
            ),
        ];
        // The owner grant already authorizes this bounded server surface. Keep
        // global approval_policy=never and approve only the named server tools;
        // provider prompts must not block peer handoffs before our scope checks.
        for tool in OWNED_MCP_TOOLS {
            config.push(format!(
                "mcp_servers.codaclauda.tools.{tool}.approval_mode=\"approve\""
            ));
        }
        for feature in [
            "shell_tool",
            "multi_agent",
            "multi_agent_v2",
            "plugins",
            "apps",
            "hooks",
            "goals",
            "memories",
            "remote_plugin",
            "skill_mcp_dependency_install",
            "skill_search",
            "view_image",
            "browser_use",
            "computer_use",
            "image_generation",
            "workspace_dependencies",
            "tool_suggest",
            "in_app_local_automation",
        ] {
            config.push(format!("features.{feature}=false"));
        }
        for item in config {
            result.push("-c".into());
            result.push(item.into());
        }
        result.push("-".into());
        Ok(result)
    }
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("create private adapter config {}", path.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

#[derive(Default)]
struct Parsed {
    session: Option<String>,
    answer: String,
    usage: Value,
    cost: Option<f64>,
    completed: bool,
    failed: bool,
    claude_tools_verified: bool,
}

impl Parsed {
    fn event(
        &mut self,
        agent: &str,
        value: Value,
        emit: &mut impl FnMut(Value) -> Result<()>,
    ) -> Result<()> {
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        if agent == "claude" {
            if kind == "system" && value["subtype"] == "init" {
                let tools = value
                    .get("tools")
                    .and_then(Value::as_array)
                    .context("Claude initialization omitted its tool inventory; launch refused")?;
                for tool in tools {
                    let name = tool
                        .as_str()
                        .context("Claude initialization contained an invalid tool name")?;
                    // ToolSearch only discovers the already restricted MCP surface.
                    if !name.starts_with("mcp__codaclauda__") && name != "ToolSearch" {
                        bail!("Claude exposed an unauthorized native or MCP tool: {name}");
                    }
                }
                let servers = value
                    .get("mcp_servers")
                    .and_then(Value::as_array)
                    .context("Claude initialization omitted its MCP inventory; launch refused")?;
                if servers.len() != 1
                    || servers[0]["name"] != "codaclauda"
                    || servers[0]["status"] != "connected"
                {
                    bail!(
                        "Claude must connect exactly the owned CodaClauda MCP server; launch refused"
                    );
                }
                self.claude_tools_verified = true;
                emit(
                    json!({"type":"provider","provider_type":"tool_surface_verified","tools":tools,"agent":agent}),
                )?;
            } else if matches!(kind, "assistant" | "user" | "result") && !self.claude_tools_verified
            {
                bail!(
                    "Claude emitted conversation output before a verified tool inventory; launch refused"
                );
            }
        }
        let id = if agent == "codex" && kind == "thread.started" {
            value.get("thread_id")
        } else if agent == "claude" {
            value.get("session_id")
        } else {
            None
        };
        if let Some(id) = id.and_then(Value::as_str).filter(|id| !id.is_empty()) {
            if self.session.as_deref() != Some(id) {
                self.session = Some(id.to_owned());
                emit(json!({"type":"session","session_id":id,"agent":agent}))?;
            }
        }
        if agent == "codex" {
            if kind == "turn.completed" {
                self.completed = true;
                self.usage = value.get("usage").cloned().unwrap_or(Value::Null);
            }
            if matches!(kind, "turn.failed" | "error") {
                self.failed = true;
                if let Some(message) = value
                    .pointer("/error/message")
                    .or_else(|| value.get("message"))
                    .and_then(Value::as_str)
                {
                    self.answer.push_str(message);
                    self.answer.push('\n');
                }
            }
            if let Some(item) = value.get("item") {
                let item_type = item
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                if matches!(
                    item_type,
                    "command_execution" | "file_change" | "web_search" | "image_generation"
                ) || (item_type.contains("tool")
                    && !matches!(item_type, "mcp_tool_call" | "tool_search"))
                {
                    bail!("Codex exposed an unauthorized native tool event: {item_type}");
                }
                if item_type == "mcp_tool_call" && item["server"] != "codaclauda" {
                    bail!("Codex exposed an unowned MCP server; request stopped");
                }
                if kind == "item.completed" && item_type == "agent_message" {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        self.answer.push_str(text);
                        self.answer.push('\n');
                    }
                }
                if item_type.contains("tool")
                    || matches!(item_type, "command_execution" | "file_change")
                {
                    emit(
                        json!({"type":"tool","provider_type":item_type,"phase":kind,"tool":item.get("tool"),
                        "server":item.get("server"),"call_id":item.get("id"),"status":item.get("status"),"session_id":self.session}),
                    )?;
                }
            }
        } else {
            if kind == "result" {
                self.completed = true;
                self.failed = value
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || value
                        .get("subtype")
                        .and_then(Value::as_str)
                        .is_some_and(|x| x != "success");
                if let Some(result) = value.get("result").and_then(Value::as_str) {
                    self.answer = result.to_owned();
                }
                if self.answer.is_empty() {
                    if let Some(errors) = value.get("errors") {
                        self.answer = errors.to_string();
                    }
                }
                self.usage = json!({"tokens":value.get("usage"),"models":value.get("modelUsage"),"num_turns":value.get("num_turns")});
                self.cost = value.get("total_cost_usd").and_then(Value::as_f64);
            }
            if let Some(content) = value.pointer("/message/content").and_then(Value::as_array) {
                for item in content {
                    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
                    if kind == "assistant" && item_type == "text" {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            self.answer.push_str(text);
                            self.answer.push('\n');
                        }
                    }
                    if matches!(item_type, "tool_use" | "tool_result") {
                        if item_type == "tool_use" {
                            let name = item.get("name").and_then(Value::as_str).unwrap_or("");
                            if !name.starts_with("mcp__codaclauda__") && name != "ToolSearch" {
                                bail!("Claude invoked an unauthorized tool: {name}");
                            }
                        }
                        emit(
                            json!({"type":"tool","provider_type":item_type,"tool":item.get("name"),
                            "call_id":item.get("id").or_else(|| item.get("tool_use_id")),"session_id":self.session}),
                        )?;
                    }
                }
            }
        }
        emit(
            json!({"type":"provider","provider_type":kind,"subtype":value.get("subtype"),"session_id":self.session}),
        )
    }
}

/// Run one newly authorized session. Callback failure also terminates its owned job.
pub fn run(
    spec: &LaunchSpec,
    mut on_event: impl FnMut(Value) -> Result<()>,
    mut is_cancelled: impl FnMut() -> bool,
) -> Result<Outcome> {
    valid_agent(&spec.agent)?;
    native_executable(&spec.executable)?;
    native_executable(&spec.mcp_executable)?;
    if spec.timeout_seconds == 0
        || spec.timeout_seconds > 3600
        || spec.max_turns == 0
        || spec.max_turns > 100
    {
        bail!("adapter requires timeout 1..3600 seconds and max_turns 1..100");
    }
    if spec.prompt.len() > LINE_LIMIT
        || spec.capability.is_empty()
        || !spec.workspace.is_absolute()
        || !spec.state_dir.is_absolute()
        || !spec.work_dir.is_absolute()
        || !spec.workspace.is_dir()
        || !spec.work_dir.is_dir()
    {
        bail!("invalid prompt, capability, workspace or private work directory");
    }
    if is_cancelled() {
        return Ok(stopped("cancelled_before_spawn"));
    }
    let info = probe(&spec.agent, &spec.executable)?;
    if info["supported"] != true {
        bail!("unsupported installed adapter interface");
    }
    if info["authenticated"] != true {
        bail!("subscription authentication required; sign in using the provider's official CLI");
    }
    let args = launch_args(spec)?;
    let mut child = OwnedProcess::spawn(
        &spec.executable,
        &args,
        &spec.workspace,
        &subscription_environment(),
    )?;
    on_event(
        json!({"type":"spawned","agent":spec.agent,"version":info["version"],"adapter":"new-session-v1",
        "workspace":spec.workspace,"request_id":spec.request_id}),
    )?;
    let input = child.stdin.take().context("provider stdin missing")?;
    let prompt = spec.prompt.clone();
    let writer = thread::spawn(move || {
        let mut input = input;
        input.write_all(prompt.as_bytes())
    });
    let receiver = readers(&mut child)?;
    let start = Instant::now();
    let mut heartbeat = Instant::now();
    let mut parsed = Parsed::default();
    let mut pending = Vec::new();
    let mut stderr = Vec::new();
    let mut bytes = 0usize;
    let mut streams = 0;
    let mut code = None;
    let mut stop_reason = None;
    let mut exited = None;
    loop {
        if stop_reason.is_none() && is_cancelled() {
            stop_reason = Some("cancelled".to_owned());
            child.terminate()?;
        }
        if stop_reason.is_none() && start.elapsed() >= Duration::from_secs(spec.timeout_seconds) {
            stop_reason = Some("deadline_exceeded".to_owned());
            child.terminate()?;
        }
        if heartbeat.elapsed() >= Duration::from_secs(2) {
            on_event(
                json!({"type":"heartbeat","elapsed_seconds":start.elapsed().as_secs(),"session_id":parsed.session}),
            )?;
            heartbeat = Instant::now();
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(PipeEvent::Data(is_error, data)) => {
                bytes = bytes.saturating_add(data.len());
                if bytes > OUTPUT_LIMIT {
                    if stop_reason.is_none() {
                        stop_reason = Some("output_limit_exceeded".to_owned());
                        child.terminate()?;
                    }
                    continue;
                }
                if is_error {
                    if stderr.len() < 16384 {
                        stderr.extend_from_slice(&data[..data.len().min(16384 - stderr.len())]);
                    }
                } else {
                    pending.extend_from_slice(&data);
                    while let Some(newline) = pending.iter().position(|x| *x == b'\n') {
                        let line: Vec<u8> = pending.drain(..=newline).collect();
                        if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                            parsed.event(
                                &spec.agent,
                                scrub_value(&value, &spec.capability),
                                &mut on_event,
                            )?;
                        }
                    }
                    if pending.len() > LINE_LIMIT && stop_reason.is_none() {
                        stop_reason = Some("provider_line_limit_exceeded".to_owned());
                        child.terminate()?;
                    }
                }
            }
            Ok(PipeEvent::Closed) => streams += 1,
            Ok(PipeEvent::Error(message)) => {
                streams += 1;
                if stop_reason.is_none() {
                    stop_reason = Some(format!(
                        "provider_pipe_error: {}",
                        clean_text(&message, &spec.capability)
                    ));
                    child.terminate()?;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => streams = 2,
        }
        if code.is_none() {
            code = child.try_wait()?;
            if code.is_some() {
                // End every owned descendant, including MCP servers, before draining final output.
                child.terminate()?;
                exited = Some(Instant::now());
            }
        }
        if code.is_some()
            && (streams >= 2 || exited.is_some_and(|t| t.elapsed() >= Duration::from_secs(2)))
        {
            break;
        }
    }
    if !pending.is_empty() && pending.len() <= LINE_LIMIT {
        if let Ok(value) = serde_json::from_slice::<Value>(&pending) {
            parsed.event(
                &spec.agent,
                scrub_value(&value, &spec.capability),
                &mut on_event,
            )?;
        }
    }
    if writer.is_finished() {
        if let Ok(Err(error)) = writer.join() {
            if !parsed.completed && stop_reason.is_none() {
                stop_reason = Some(format!("provider_stdin_error: {error}"));
            }
        }
    }
    if stop_reason.is_none() && (!parsed.completed || parsed.session.is_none()) {
        stop_reason = Some("provider_exited_without_terminal_session_receipt".to_owned());
    }
    if stop_reason.is_none() && (parsed.failed || code != Some(0)) {
        stop_reason = Some("provider_failed".to_owned());
    }
    if parsed.answer.trim().is_empty() && !stderr.is_empty() {
        parsed.answer = clean_text(&String::from_utf8_lossy(&stderr), &spec.capability);
    }
    Ok(Outcome {
        success: stop_reason.is_none(),
        session_id: parsed.session,
        answer: clean_text(parsed.answer.trim(), &spec.capability),
        usage: parsed.usage,
        estimated_cost_usd: parsed.cost,
        exit_code: code,
        stop_reason,
    })
}

fn stopped(reason: &str) -> Outcome {
    Outcome {
        success: false,
        session_id: None,
        answer: String::new(),
        usage: Value::Null,
        estimated_cost_usd: None,
        exit_code: None,
        stop_reason: Some(reason.to_owned()),
    }
}

enum PipeEvent {
    Data(bool, Vec<u8>),
    Closed,
    Error(String),
}

fn read_pipe(mut pipe: File, is_error: bool, sender: SyncSender<PipeEvent>) {
    loop {
        let mut buffer = vec![0u8; 4096];
        match pipe.read(&mut buffer) {
            Ok(0) => {
                let _ = sender.send(PipeEvent::Closed);
                break;
            }
            Ok(size) => {
                buffer.truncate(size);
                if sender.send(PipeEvent::Data(is_error, buffer)).is_err() {
                    break;
                }
            }
            Err(error) => {
                let _ = sender.send(PipeEvent::Error(error.to_string()));
                break;
            }
        }
    }
}

fn readers(child: &mut OwnedProcess) -> Result<Receiver<PipeEvent>> {
    let (sender, receiver) = mpsc::sync_channel(32);
    let out = child.stdout.take().context("stdout missing")?;
    let err = child.stderr.take().context("stderr missing")?;
    let other = sender.clone();
    thread::spawn(move || read_pipe(out, false, sender));
    thread::spawn(move || read_pipe(err, true, other));
    Ok(receiver)
}

struct Capture {
    stdout: String,
    stderr: String,
    code: Option<i32>,
}
fn capture(exe: &Path, args: &[OsString], cwd: &Path, timeout: u64) -> Result<Capture> {
    let mut child = OwnedProcess::spawn(exe, args, cwd, &subscription_environment())?;
    child.stdin.take();
    let receiver = readers(&mut child)?;
    let start = Instant::now();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut closed = 0;
    let mut code = None;
    loop {
        if start.elapsed() >= Duration::from_secs(timeout) {
            child.terminate()?;
            bail!("provider probe timed out");
        }
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(PipeEvent::Data(err, data)) => {
                if stdout.len() + stderr.len() + data.len() > LINE_LIMIT {
                    child.terminate()?;
                    bail!("provider probe output exceeded limit");
                }
                if err {
                    stderr.extend(data);
                } else {
                    stdout.extend(data);
                }
            }
            Ok(PipeEvent::Closed) => closed += 1,
            Ok(PipeEvent::Error(error)) => bail!("provider probe pipe: {error}"),
            Err(RecvTimeoutError::Disconnected) => closed = 2,
            Err(RecvTimeoutError::Timeout) => {}
        }
        if code.is_none() {
            code = child.try_wait()?;
            if code.is_some() {
                child.terminate()?;
            }
        }
        if code.is_some() && closed >= 2 {
            break;
        }
    }
    Ok(Capture {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        code,
    })
}

#[cfg(windows)]
pub use win::OwnedProcess;

#[cfg(windows)]
mod win {
    use super::*;
    use std::{
        ffi::c_void,
        mem::{size_of, size_of_val, zeroed},
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle},
        },
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0,
            WAIT_TIMEOUT,
        },
        Security::SECURITY_ATTRIBUTES,
        System::{JobObjects::*, Pipes::CreatePipe, Threading::*},
    };

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }
    impl Handle {
        fn file(mut self) -> File {
            let raw = self.0;
            self.0 = null_mut();
            unsafe { File::from_raw_handle(raw) }
        }
    }

    pub(super) fn spawn_worker(
        exe: &Path,
        args: &[OsString],
        cwd: &Path,
        env: &BTreeMap<OsString, OsString>,
        capability: &str,
    ) -> Result<()> {
        // A worker outlives the short owner CLI invocation. In particular it must
        // not inherit any otherwise-inheritable stdout/stderr capture handles.
        // It is intentionally not placed in the provider's kill-on-close job.
        let output = fs::OpenOptions::new().write(true).open("NUL")?;
        let error = fs::OpenOptions::new().write(true).open("NUL")?;
        let (stdin_read, stdin_write) = pipe()?;
        unsafe {
            if SetHandleInformation(stdin_write.0, HANDLE_FLAG_INHERIT, 0) == 0 {
                return Err(std::io::Error::last_os_error()).context("protect worker input handle");
            }
            let mut handles = [stdin_read.0, output.as_raw_handle(), error.as_raw_handle()];
            for handle in handles {
                if SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) == 0 {
                    return Err(std::io::Error::last_os_error())
                        .context("prepare worker standard handle");
                }
            }
            let mut attribute_size = 0;
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_size);
            let mut storage = vec![0usize; attribute_size.div_ceil(size_of::<usize>())];
            let attributes = storage.as_mut_ptr().cast();
            if InitializeProcThreadAttributeList(attributes, 1, 0, &mut attribute_size) == 0 {
                return Err(std::io::Error::last_os_error())
                    .context("initialize worker handle list");
            }
            struct Attributes(LPPROC_THREAD_ATTRIBUTE_LIST);
            impl Drop for Attributes {
                fn drop(&mut self) {
                    unsafe { DeleteProcThreadAttributeList(self.0) }
                }
            }
            let attributes = Attributes(attributes);
            if UpdateProcThreadAttribute(
                attributes.0,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_mut_ptr().cast(),
                size_of_val(&handles),
                null_mut(),
                null(),
            ) == 0
            {
                return Err(std::io::Error::last_os_error())
                    .context("restrict worker inherited handles");
            }
            let mut startup: STARTUPINFOEXW = zeroed();
            startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = handles[0];
            startup.StartupInfo.hStdOutput = handles[1];
            startup.StartupInfo.hStdError = handles[2];
            startup.lpAttributeList = attributes.0;
            let mut environment = Vec::<u16>::new();
            let mut sorted: Vec<_> = env.iter().collect();
            sorted.sort_by_key(|(key, _)| key.to_string_lossy().to_ascii_uppercase());
            for (key, value) in sorted {
                environment.extend(key.encode_wide());
                environment.push(b'=' as u16);
                environment.extend(value.encode_wide());
                environment.push(0);
            }
            environment.push(0);
            let application = wide(exe.as_os_str());
            let directory = wide(cwd.as_os_str());
            let mut argv = command_line(exe.as_os_str(), args)?;
            let mut info: PROCESS_INFORMATION = zeroed();
            if CreateProcessW(
                application.as_ptr(),
                argv.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_SUSPENDED
                    | CREATE_NO_WINDOW
                    | CREATE_UNICODE_ENVIRONMENT
                    | EXTENDED_STARTUPINFO_PRESENT,
                environment.as_ptr().cast(),
                directory.as_ptr(),
                &startup.StartupInfo,
                &mut info,
            ) == 0
            {
                return Err(std::io::Error::last_os_error()).context("launch owner worker");
            }
            let process = Handle(info.hProcess);
            let main_thread = Handle(info.hThread);
            // The bounded capability fits the pipe before the worker resumes.
            // Closing this writer provides EOF without waiting for worker exit.
            let input_result = stdin_write.file().write_all(capability.as_bytes());
            if let Err(error) = input_result {
                TerminateProcess(process.0, 1);
                return Err(error).context("deliver worker capability");
            }
            if ResumeThread(main_thread.0) == u32::MAX {
                let error = std::io::Error::last_os_error();
                TerminateProcess(process.0, 1);
                return Err(error).context("resume owner worker");
            }
            Ok(())
        }
    }

    /// A provider process contained in its own kill-on-close job object.
    pub struct OwnedProcess {
        process: Handle,
        job: Handle,
        pub stdin: Option<File>,
        pub stdout: Option<File>,
        pub stderr: Option<File>,
    }
    // Plain owned kernel handles; moving them between threads is sound.
    unsafe impl Send for OwnedProcess {}
    impl OwnedProcess {
        pub fn spawn(
            exe: &Path,
            args: &[OsString],
            cwd: &Path,
            env: &BTreeMap<OsString, OsString>,
        ) -> Result<Self> {
            unsafe {
                let job = Handle(CreateJobObjectW(null(), null()));
                if job.0.is_null() {
                    return Err(std::io::Error::last_os_error())
                        .context("create owned process job");
                }
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const _) as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(std::io::Error::last_os_error()).context("set process containment");
                }
                let (stdin_read, stdin_write) = pipe()?;
                let (stdout_read, stdout_write) = pipe()?;
                let (stderr_read, stderr_write) = pipe()?;
                for handle in [&stdin_write, &stdout_read, &stderr_read] {
                    if SetHandleInformation(handle.0, HANDLE_FLAG_INHERIT, 0) == 0 {
                        return Err(std::io::Error::last_os_error())
                            .context("protect parent pipe handle");
                    }
                }
                let mut attribute_size = 0;
                InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_size);
                // usize storage provides the alignment required by the Win32 opaque structure.
                let mut attribute_storage =
                    vec![0usize; attribute_size.div_ceil(size_of::<usize>())];
                let attributes = attribute_storage.as_mut_ptr().cast();
                if InitializeProcThreadAttributeList(attributes, 1, 0, &mut attribute_size) == 0 {
                    return Err(std::io::Error::last_os_error())
                        .context("initialize inherited-handle list");
                }
                struct Attributes(LPPROC_THREAD_ATTRIBUTE_LIST);
                impl Drop for Attributes {
                    fn drop(&mut self) {
                        unsafe {
                            DeleteProcThreadAttributeList(self.0);
                        }
                    }
                }
                let attributes = Attributes(attributes);
                let mut handles = [stdin_read.0, stdout_write.0, stderr_write.0];
                if UpdateProcThreadAttribute(
                    attributes.0,
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    handles.as_mut_ptr().cast(),
                    size_of_val(&handles),
                    null_mut(),
                    null(),
                ) == 0
                {
                    return Err(std::io::Error::last_os_error())
                        .context("restrict inherited handles");
                }
                let mut startup: STARTUPINFOEXW = zeroed();
                startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = stdin_read.0;
                startup.StartupInfo.hStdOutput = stdout_write.0;
                startup.StartupInfo.hStdError = stderr_write.0;
                startup.lpAttributeList = attributes.0;
                let application = wide(exe.as_os_str());
                let directory = wide(cwd.as_os_str());
                let mut command = command_line(exe.as_os_str(), args)?;
                let mut environment: Vec<u16> = Vec::new();
                let mut env_sorted: Vec<_> = env.iter().collect();
                env_sorted.sort_by_key(|(key, _)| key.to_string_lossy().to_ascii_uppercase());
                for (key, value) in env_sorted {
                    environment.extend(key.encode_wide());
                    environment.push(b'=' as u16);
                    environment.extend(value.encode_wide());
                    environment.push(0);
                }
                environment.push(0);
                let mut info: PROCESS_INFORMATION = zeroed();
                let created = CreateProcessW(
                    application.as_ptr(),
                    command.as_mut_ptr(),
                    null(),
                    null(),
                    1,
                    CREATE_SUSPENDED
                        | CREATE_NO_WINDOW
                        | CREATE_UNICODE_ENVIRONMENT
                        | EXTENDED_STARTUPINFO_PRESENT,
                    environment.as_ptr().cast(),
                    directory.as_ptr(),
                    &startup.StartupInfo,
                    &mut info,
                );
                if created == 0 {
                    return Err(std::io::Error::last_os_error())
                        .context("launch provider executable");
                }
                let process = Handle(info.hProcess);
                let main_thread = Handle(info.hThread);
                if AssignProcessToJobObject(job.0, process.0) == 0 {
                    let error = std::io::Error::last_os_error();
                    TerminateProcess(process.0, 1);
                    return Err(error)
                        .context("contain suspended provider process; launch refused");
                }
                if ResumeThread(main_thread.0) == u32::MAX {
                    return Err(std::io::Error::last_os_error())
                        .context("resume contained provider process");
                }
                Ok(Self {
                    process,
                    job,
                    stdin: Some(stdin_write.file()),
                    stdout: Some(stdout_read.file()),
                    stderr: Some(stderr_read.file()),
                })
            }
        }
        pub fn try_wait(&mut self) -> Result<Option<i32>> {
            unsafe {
                match WaitForSingleObject(self.process.0, 0) {
                    WAIT_TIMEOUT => Ok(None),
                    WAIT_OBJECT_0 => {
                        let mut code = 0;
                        if GetExitCodeProcess(self.process.0, &mut code) == 0 {
                            return Err(std::io::Error::last_os_error())
                                .context("read owned process result");
                        }
                        Ok(Some(code as i32))
                    }
                    _ => Err(std::io::Error::last_os_error()).context("wait for owned process"),
                }
            }
        }
        pub fn terminate(&mut self) -> Result<()> {
            unsafe {
                if TerminateJobObject(self.job.0, 1) == 0 {
                    return Err(std::io::Error::last_os_error()).context("stop owned request job");
                }
            }
            Ok(())
        }
    }
    fn pipe() -> Result<(Handle, Handle)> {
        unsafe {
            let mut attrs = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: null_mut(),
                bInheritHandle: 1,
            };
            let mut read = null_mut();
            let mut write = null_mut();
            if CreatePipe(&mut read, &mut write, &mut attrs, 0) == 0 {
                return Err(std::io::Error::last_os_error()).context("create provider pipe");
            }
            Ok((Handle(read), Handle(write)))
        }
    }
    fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }

    // CRT quoting, passed directly to CreateProcessW; never through PowerShell/cmd.
    fn quote(value: &std::ffi::OsStr, out: &mut Vec<u16>) -> Result<()> {
        out.push(b'"' as u16);
        let mut slashes = 0;
        for ch in value.encode_wide() {
            if ch == 0 {
                bail!("NUL in process argument");
            }
            if ch == b'\\' as u16 {
                slashes += 1;
                continue;
            }
            if ch == b'"' as u16 {
                out.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2 + 1));
            } else {
                out.extend(std::iter::repeat_n(b'\\' as u16, slashes));
            }
            slashes = 0;
            out.push(ch);
        }
        out.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        out.push(b'"' as u16);
        Ok(())
    }
    fn command_line(exe: &std::ffi::OsStr, args: &[OsString]) -> Result<Vec<u16>> {
        let mut out = Vec::new();
        quote(exe, &mut out)?;
        for arg in args {
            out.push(b' ' as u16);
            quote(arg, &mut out)?;
        }
        if out.len() >= 32766 {
            bail!("provider argument vector exceeds Windows command-line limit");
        }
        out.push(0);
        Ok(out)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn quotes_exact_argv_without_shell_interpolation() {
            let mut output = Vec::new();
            quote(std::ffi::OsStr::new("a b\\\"c\\"), &mut output).unwrap();
            assert_eq!(String::from_utf16(&output).unwrap(), "\"a b\\\\\\\"c\\\\\"");
            assert!(quote(std::ffi::OsStr::new("a\0b"), &mut Vec::new()).is_err());
        }

        // These subprocess helpers do not run during ordinary cargo test. They
        // keep a real worker alive after its real parent test process has exited.
        #[test]
        #[ignore]
        fn worker_capture_leaf() {
            let Ok(marker) = std::env::var("CODACLAUDA_EOF_TEST_MARKER") else {
                return;
            };
            let marker = PathBuf::from(marker);
            let mut token = String::new();
            std::io::stdin().read_to_string(&mut token).unwrap();
            assert_eq!(token, "test-capability");
            fs::write(&marker, "running").unwrap();
            let end = Instant::now() + Duration::from_secs(10);
            while !marker.with_extension("stop").exists() && Instant::now() < end {
                thread::sleep(Duration::from_millis(20));
            }
            fs::write(marker.with_extension("done"), "done").unwrap();
        }

        #[test]
        #[ignore]
        fn worker_capture_parent() {
            let Ok(marker) = std::env::var("CODACLAUDA_EOF_TEST_MARKER") else {
                return;
            };
            let marker = PathBuf::from(marker);
            let args: Vec<OsString> = [
                "--ignored",
                "--exact",
                "adapters::win::tests::worker_capture_leaf",
                "--nocapture",
            ]
            .map(OsString::from)
            .into();
            crate::adapters::spawn_worker(
                &std::env::current_exe().unwrap(),
                &args,
                marker.parent().unwrap(),
                "test-capability",
            )
            .unwrap();
            let end = Instant::now() + Duration::from_secs(3);
            while !marker.exists() && Instant::now() < end {
                thread::sleep(Duration::from_millis(20));
            }
            assert!(
                marker.exists(),
                "worker did not consume its private stdin and start"
            );
        }

        #[test]
        fn worker_capture_reaches_eof_after_parent_exit_while_worker_lives() {
            use std::process::{Command, Stdio};
            let directory = tempfile::tempdir().unwrap();
            let marker = directory.path().join("worker-started");
            struct StopLeaf(PathBuf);
            impl Drop for StopLeaf {
                fn drop(&mut self) {
                    let _ = fs::write(self.0.with_extension("stop"), "stop");
                    let end = Instant::now() + Duration::from_secs(2);
                    while !self.0.with_extension("done").exists() && Instant::now() < end {
                        thread::sleep(Duration::from_millis(20));
                    }
                }
            }
            let _cleanup = StopLeaf(marker.clone());
            let mut parent = Command::new(std::env::current_exe().unwrap());
            use std::os::windows::process::CommandExt;
            parent.creation_flags(CREATE_NO_WINDOW);
            let mut parent = parent
                .args([
                    "--ignored",
                    "--exact",
                    "adapters::win::tests::worker_capture_parent",
                    "--nocapture",
                ])
                .env("CODACLAUDA_EOF_TEST_MARKER", &marker)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let mut stdout = parent.stdout.take().unwrap();
            let mut stderr = parent.stderr.take().unwrap();
            let (sender, receiver) = std::sync::mpsc::sync_channel(2);
            let stderr_sender = sender.clone();
            thread::spawn(move || {
                let result = stdout.read_to_end(&mut Vec::new()).map(|_| ());
                let _ = sender.send(result);
            });
            thread::spawn(move || {
                let result = stderr.read_to_end(&mut Vec::new()).map(|_| ());
                let _ = stderr_sender.send(result);
            });
            let end = Instant::now() + Duration::from_secs(5);
            let exit = loop {
                if let Some(exit) = parent.try_wait().unwrap() {
                    break Some(exit);
                }
                if Instant::now() >= end {
                    let _ = parent.kill();
                    let _ = parent.wait();
                    break None;
                }
                thread::sleep(Duration::from_millis(20));
            };
            assert!(
                exit.is_some_and(|exit| exit.success()),
                "owner parent did not exit promptly"
            );
            assert!(marker.exists(), "worker never started");
            // The worker remains alive waiting for StopLeaf. EOF must be produced
            // by the parent's exit, not by waiting for the long-lived worker.
            let first = receiver.recv_timeout(Duration::from_secs(2));
            let second = receiver.recv_timeout(Duration::from_secs(2));
            assert!(
                first.is_ok_and(|result| result.is_ok())
                    && second.is_ok_and(|result| result.is_ok()),
                "worker retained a parent capture handle after parent exit"
            );
            assert!(
                !marker.with_extension("done").exists(),
                "worker finished before EOF was verified"
            );
        }
    }
}

// Containment is a supported Windows capability; fail closed on other hosts.
#[cfg(not(windows))]
pub struct OwnedProcess {
    pub stdin: Option<File>,
    pub stdout: Option<File>,
    pub stderr: Option<File>,
}
#[cfg(not(windows))]
impl OwnedProcess {
    pub fn spawn(
        _: &Path,
        _: &[OsString],
        _: &Path,
        _: &BTreeMap<OsString, OsString>,
    ) -> Result<Self> {
        bail!("new-session-v1 process containment is supported on Windows only");
    }
    pub fn try_wait(&mut self) -> Result<Option<i32>> {
        bail!("unsupported host");
    }
    pub fn terminate(&mut self) -> Result<()> {
        bail!("unsupported host");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_receipts_require_actual_session_and_terminal_event() {
        let mut parsed = Parsed::default();
        let mut events = Vec::new();
        let mut emit = |v| {
            events.push(v);
            Ok(())
        };
        parsed
            .event(
                "codex",
                json!({"type":"thread.started","thread_id":"actual-id"}),
                &mut emit,
            )
            .unwrap();
        parsed
            .event(
                "codex",
                json!({"type":"item.completed","item":{"type":"agent_message","text":"answer"}}),
                &mut emit,
            )
            .unwrap();
        assert!(!parsed.completed);
        parsed
            .event(
                "codex",
                json!({"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3}}),
                &mut emit,
            )
            .unwrap();
        assert_eq!(parsed.session.as_deref(), Some("actual-id"));
        assert!(parsed.completed);
        assert_eq!(parsed.usage["input_tokens"], 10);
        assert!(events.iter().any(|v| v["type"] == "session"));
    }
    #[test]
    fn claude_budget_error_is_not_success() {
        let mut parsed = Parsed::default();
        parsed.event("claude",json!({"type":"system","subtype":"init","tools":["mcp__codaclauda__messages"],"mcp_servers":[{"name":"codaclauda","status":"connected"}]}),&mut |_|Ok(())).unwrap();
        parsed.event("claude",json!({"type":"result","session_id":"actual","subtype":"error_max_turns","is_error":true,"total_cost_usd":0.03}),&mut |_|Ok(())).unwrap();
        assert!(parsed.failed);
        assert!(parsed.completed);
        assert_eq!(parsed.cost, Some(0.03));
    }
    #[test]
    fn rejects_claude_native_tools_or_unowned_servers() {
        for (tools, servers) in [
            (
                json!(["Read"]),
                json!([{"name":"codaclauda","status":"connected"}]),
            ),
            (
                json!(["mcp__other__run"]),
                json!([{"name":"codaclauda","status":"connected"}]),
            ),
            (json!([]), json!([{"name":"other","status":"connected"}])),
            (json!([]), json!([{"name":"codaclauda","status":"failed"}])),
        ] {
            let mut parsed = Parsed::default();
            assert!(parsed
                .event(
                    "claude",
                    json!({"type":"system","subtype":"init","tools":tools,"mcp_servers":servers}),
                    &mut |_| Ok(())
                )
                .is_err());
            assert!(!parsed.claude_tools_verified);
        }
    }
    #[test]
    fn rejects_codex_native_tools_and_unowned_mcp_events() {
        for item in [
            json!({"type":"command_execution","command":"whoami"}),
            json!({"type":"file_change","changes":[]}),
            json!({"type":"mcp_tool_call","server":"other","tool":"read"}),
            json!({"type":"mcp_tool_call","tool":"read_file"}),
            json!({"type":"collab_agent_tool_call","tool":"spawn_agent"}),
        ] {
            let mut parsed = Parsed::default();
            assert!(
                parsed
                    .event(
                        "codex",
                        json!({"type":"item.started","item":item}),
                        &mut |_| Ok(())
                    )
                    .is_err()
            );
        }
        let mut parsed = Parsed::default();
        assert!(parsed.event("codex", json!({"type":"item.started","item":{"type":"mcp_tool_call","server":"codaclauda","tool":"get_context"}}), &mut |_| Ok(())).is_ok());
    }
    #[test]
    fn scrubs_credentials_but_preserves_usage_tokens() {
        let value = scrub_value(
            &json!({"access_token":"private","input_tokens":12,"answer":"Bearer abcdefghijklmnop cap-value"}),
            "cap-value",
        );
        assert_eq!(value["access_token"], "[REDACTED]");
        assert_eq!(value["input_tokens"], 12);
        assert!(!value.to_string().contains("abcdefghijklmnop"));
        assert!(!value.to_string().contains("cap-value"));
    }
}
