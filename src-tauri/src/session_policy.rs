//! Policy for CodaClauda-owned sessions, separate from the legacy scoped adapter.
//!
//! These checks do not override administrative policy. Claude's managed-source
//! guard and a fresh, isolated `auth status` must run before launching a session.
//! Codex must read effective config for the session cwd, restart with the named
//! overrides below, then verify config and account before starting/resuming a
//! thread. Startup events are an additional check, not the enforcement boundary.

use serde_json::{Map, Value};
use std::ffi::OsString;

const READ_TOOLS: &[&str] = &["Read", "Glob", "Grep"];
const DISABLED_CODEX_FEATURES: &[&str] = &[
    "hooks",
    "apps",
    "plugins",
    "remote_plugin",
    "browser_use",
    "computer_use",
    "skill_mcp_dependency_install",
];

/// Keep provider-owned credential locations, not inherited authentication,
/// endpoint, remote-host or parent-session controls. Values are never inspected.
pub fn retain_launch_env(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    !(name == "CLAUDECODE"
        || name.starts_with("ANTHROPIC_")
        || name.starts_with("OPENAI_")
        || name.starts_with("CLAUDE_CODE_")
        || (name.starts_with("CODEX_") && name != "CODEX_HOME"))
}

fn claude_isolation_args(access: &str) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "--setting-sources",
        "",
        "--settings",
        r#"{"disableAllHooks":true}"#,
        "--strict-mcp-config",
        "--no-chrome",
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    // Safe mode preserves OAuth and adds customization isolation at Read only.
    // Full retains native tools with the same strict MCP and settings boundary.
    if access != "full" {
        args.push("--safe-mode".into());
    }
    args
}

/// Append before the session/resume arguments.
pub fn claude_policy_args(access: &str) -> Vec<OsString> {
    let mut args = claude_isolation_args(access);
    args.extend([
        "--disable-slash-commands".into(),
        "--permission-prompts".into(),
        "none".into(),
        "--permission-mode".into(),
        if access == "full" {
            "bypassPermissions".into()
        } else {
            "plan".into()
        },
    ]);
    if access != "full" {
        args.push("--restricted".into());
    }
    args.extend([
        "--tools".into(),
        if access == "full" {
            "default".into()
        } else {
            READ_TOOLS.join(",").into()
        },
    ]);
    args
}

/// No model request; use the same environment and source isolation as launch.
/// Tool-list flags are intentionally absent: they are variadic in this CLI.
pub fn claude_auth_args(access: &str) -> Vec<OsString> {
    let mut args = claude_isolation_args(access);
    args.extend(["auth".into(), "status".into(), "--json".into()]);
    args
}

/// This release supports personal OAuth subscriptions without managed policy.
/// The caller checks managed-source presence using the returned configDirectory.
pub fn verify_claude_auth(auth: &Value) -> Result<(), String> {
    if auth["loggedIn"] != true
        || auth["authMethod"] != "claude.ai"
        || auth["apiProvider"] != "firstParty"
    {
        return Err("Claude requires a local Claude.ai subscription login.".into());
    }
    if !matches!(auth["subscriptionType"].as_str(), Some("pro" | "max")) {
        return Err(
            "Owned Claude sessions currently support personal Pro or Max subscriptions; managed or unknown subscription types are unsupported."
                .into(),
        );
    }
    if auth
        .get("apiKeySource")
        .is_some_and(|source| !source.is_null() && source.as_str() != Some("none"))
    {
        return Err("Claude reported an unsupported API-key authentication source.".into());
    }
    if auth["configDirectory"]
        .as_str()
        .is_none_or(|path| path.is_empty())
    {
        return Err("Claude did not report its configuration directory.".into());
    }
    Ok(())
}

/// Verify the system/init event before accepting it as a ready session.
pub fn verify_claude_init(event: &Value, access: &str) -> Result<(), String> {
    let mode = if access == "full" {
        "bypassPermissions"
    } else {
        "plan"
    };
    if event["type"] != "system"
        || event["subtype"] != "init"
        || event["permissionMode"] != mode
        || event["apiKeySource"] != "none"
    {
        return Err(
            "Claude startup did not confirm the requested access and authentication policy.".into(),
        );
    }
    if event.get("apiProvider").is_some_and(|v| v != "firstParty") {
        return Err("Claude startup reported an unsupported provider.".into());
    }
    let tools = event["tools"]
        .as_array()
        .ok_or("Claude startup omitted its tool inventory.")?;
    let servers = event["mcp_servers"]
        .as_array()
        .ok_or("Claude startup omitted its MCP inventory.")?;
    let plugins = event["plugins"]
        .as_array()
        .ok_or("Claude startup omitted its plugin inventory.")?;
    if !plugins.is_empty() {
        return Err("Claude exposed inherited plugins in an isolated session.".into());
    }
    for tool in tools {
        let name = tool
            .as_str()
            .ok_or("Claude returned an invalid tool inventory.")?;
        if access != "full" {
            if !READ_TOOLS.contains(&name) {
                return Err("Claude exposed a tool outside the Read only allowlist.".into());
            }
        } else if name.starts_with("mcp__") {
            return Err("MCP tools are unavailable in CodaClauda-owned sessions.".into());
        }
    }
    if !servers.is_empty() {
        return Err("MCP servers are unavailable in CodaClauda-owned sessions.".into());
    }
    Ok(())
}

/// Each returned string is one argument to `-c`, never shell command text.
pub fn codex_base_overrides() -> Vec<String> {
    let mut result = vec![
        r#"model_provider="openai""#.into(),
        r#"forced_login_method="chatgpt""#.into(),
        "notify=[]".into(),
    ];
    result.extend(
        DISABLED_CODEX_FEATURES
            .iter()
            .map(|name| format!("features.{name}=false")),
    );
    result
}

fn config(response: &Value) -> Result<&Map<String, Value>, String> {
    response["config"]
        .as_object()
        .ok_or_else(|| "Codex did not return effective configuration.".into())
}

fn optional_table<'a>(
    config: &'a Map<String, Value>,
    key: &str,
) -> Result<Option<&'a Map<String, Value>>, String> {
    match config.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(table)) => Ok(Some(table)),
        _ => Err(format!("Codex returned an invalid {key} configuration.")),
    }
}

fn verify_codex_routing(config: &Map<String, Value>) -> Result<(), String> {
    if config.get("model_provider").and_then(Value::as_str) != Some("openai")
        || config.get("forced_login_method").and_then(Value::as_str) != Some("chatgpt")
    {
        return Err("Codex did not retain the required ChatGPT provider configuration.".into());
    }
    // Never merge an inherited custom definition into the official provider.
    if optional_table(config, "model_providers")?
        .is_some_and(|providers| providers.contains_key("openai"))
    {
        return Err("A custom Codex openai provider definition is unsupported for owned subscription sessions.".into());
    }
    for (key, official) in [
        ("chatgpt_base_url", "https://chatgpt.com/backend-api"),
        ("openai_base_url", "https://api.openai.com/v1"),
    ] {
        match config.get(key) {
            // openai_base_url normally is null; the ChatGPT default is explicit.
            None | Some(Value::Null) if key == "openai_base_url" => {}
            Some(Value::String(value)) if value.trim_end_matches('/') == official => {}
            _ => {
                return Err(
                    "A custom or unverified Codex authentication endpoint is unsupported.".into(),
                );
            }
        }
    }
    Ok(())
}

/// ONLY named additions; the caller supplies codex_base_overrides separately.
/// TOML tables merge: `mcp_servers={}` does not remove inherited servers.
pub fn codex_preflight_overrides(response: &Value) -> Result<Vec<String>, String> {
    let config = config(response)?;
    verify_codex_routing(config)?;
    let mut overrides = Vec::new();
    for key in ["mcp_servers", "plugins"] {
        if let Some(entries) = optional_table(config, key)? {
            if entries.len() > 128 {
                return Err("Codex configuration has too many inherited servers or plugins for an owned session.".into());
            }
            for name in entries.keys() {
                let quoted = serde_json::to_string(name)
                    .map_err(|_| "Could not encode an inherited Codex configuration name.")?;
                overrides.push(format!("{key}.{quoted}.enabled=false"));
            }
        }
    }
    Ok(overrides)
}

pub fn verify_codex_config(response: &Value) -> Result<(), String> {
    let config = config(response)?;
    verify_codex_routing(config)?;
    if config
        .get("notify")
        .and_then(Value::as_array)
        .is_none_or(|v| !v.is_empty())
    {
        return Err("Codex did not disable inherited notification commands.".into());
    }
    let features = optional_table(config, "features")?
        .ok_or("Codex did not report its effective feature settings.")?;
    if DISABLED_CODEX_FEATURES
        .iter()
        .any(|name| features.get(*name) != Some(&Value::Bool(false)))
    {
        return Err("Codex did not disable inherited hooks, apps, plugins and native computer/browser integrations.".into());
    }
    if let Some(plugins) = optional_table(config, "plugins")? {
        if plugins.values().any(|v| v["enabled"] != false) {
            return Err("Codex retained an enabled inherited plugin.".into());
        }
    }
    if let Some(servers) = optional_table(config, "mcp_servers")? {
        for server in servers.values() {
            if server["enabled"] != false {
                return Err("Codex retained an enabled MCP server in an isolated session.".into());
            }
        }
    }
    Ok(())
}

pub fn verify_codex_account(response: &Value) -> Result<(), String> {
    if response["requiresOpenaiAuth"] != true || response["account"]["type"] != "chatgpt" {
        return Err("Codex requires its existing ChatGPT login; API-key and external-provider accounts are unsupported.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn codex_config() -> Value {
        let mut response = json!({"config":{
            "model_provider":"openai", "forced_login_method":"chatgpt",
            "chatgpt_base_url":"https://chatgpt.com/backend-api/", "openai_base_url":null,
            "notify":[], "mcp_servers":{}, "plugins":{}, "model_providers":{}, "features":{}
        }});
        for name in DISABLED_CODEX_FEATURES {
            response["config"]["features"][*name] = json!(false);
        }
        response
    }

    fn claude_init() -> Value {
        json!({"type":"system","subtype":"init","permissionMode":"plan","apiKeySource":"none",
            "tools":["Read","Glob","Grep"],"mcp_servers":[],"plugins":[]})
    }

    #[test]
    fn claude_read_is_a_tool_boundary_and_auth_probe_cannot_consume_tools() {
        let args = claude_policy_args("read");
        assert!(args.contains(&"--restricted".into()));
        assert!(args.contains(&"--safe-mode".into()));
        assert!(args.contains(&"Read,Glob,Grep".into()));
        assert!(!args.contains(&"--bare".into()));
        let auth = claude_auth_args("read");
        assert!(!auth.contains(&"--tools".into()));
        assert_eq!(
            &auth[auth.len() - 3..],
            &["auth", "status", "--json"].map(OsString::from)
        );
        let full = claude_policy_args("full");
        assert!(!full.contains(&"--safe-mode".into()));
        assert!(!full.contains(&"--restricted".into()));
        assert!(full.contains(&"--strict-mcp-config".into()));
    }

    #[test]
    fn provider_environment_controls_are_removed_without_reading_credentials() {
        for key in [
            "ANTHROPIC_CUSTOM_HEADERS",
            "OPENAI_BASE_URL",
            "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
            "CLAUDE_CODE_REMOTE_MCP_CONFIG",
            "CLAUDE_CODE_POLICY_HELPER_PS1_PATH",
            "CODEX_ACCESS_TOKEN",
            "codex_exec_server_url",
            "CLAUDECODE",
        ] {
            assert!(!retain_launch_env(key), "{key}");
        }
        for key in ["CoDeX_HoMe", "CLAUDE_CONFIG_DIR", "USERPROFILE", "PATH"] {
            assert!(retain_launch_env(key), "{key}");
        }
    }

    #[test]
    fn claude_refuses_non_subscription_or_managed_accounts() {
        let auth = json!({"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",
            "subscriptionType":"max","configDirectory":"C:/owner/.claude"});
        assert!(verify_claude_auth(&auth).is_ok());
        for (key, value) in [
            ("authMethod", json!("api_key")),
            ("apiProvider", json!("gateway")),
            ("subscriptionType", json!("team")),
            ("subscriptionType", Value::Null),
            ("apiKeySource", json!("apiKeyHelper")),
            ("configDirectory", json!("")),
        ] {
            let mut changed = auth.clone();
            changed[key] = value;
            assert!(verify_claude_auth(&changed).is_err(), "{key}");
        }
    }

    #[test]
    fn claude_rejects_read_tool_escalation_and_browser_off_mcp() {
        let initial = claude_init();
        assert!(verify_claude_init(&initial, "read").is_ok());
        for name in ["Bash", "Write", "Agent", "WebFetch", "mcp__other__read"] {
            let mut event = initial.clone();
            event["tools"].as_array_mut().unwrap().push(json!(name));
            assert!(verify_claude_init(&event, "read").is_err());
        }
        let mut full = initial.clone();
        full["permissionMode"] = json!("bypassPermissions");
        full["mcp_servers"] = json!([{"name":"unexpected","status":"connected"}]);
        assert!(verify_claude_init(&full, "full").is_err());
    }

    #[test]
    fn full_allows_native_tools_but_no_mcp_tools_or_servers() {
        let mut event = claude_init();
        event["permissionMode"] = json!("bypassPermissions");
        event["tools"] = json!(["Read", "Write", "Bash"]);
        assert!(verify_claude_init(&event, "full").is_ok());
        event["tools"] = json!(["mcp__legacy_browser__snapshot"]);
        assert!(verify_claude_init(&event, "full").is_err());
        event["tools"] = json!(["Read"]);
        event["mcp_servers"] = json!([{"name":"legacy_browser","status":"connected"}]);
        assert!(verify_claude_init(&event, "full").is_err());
    }

    #[test]
    fn codex_disables_each_inherited_name_without_table_replacement() {
        let mut config = codex_config();
        config["config"]["mcp_servers"] =
            json!({"a.b":{"enabled":true},"quotes\"here":{"enabled":true}});
        config["config"]["plugins"] = json!({"p@market":{"enabled":true}});
        let overrides = codex_preflight_overrides(&config).unwrap();
        assert!(overrides.contains(&r#"mcp_servers."a.b".enabled=false"#.to_owned()));
        assert!(overrides.contains(&r#"mcp_servers."quotes\"here".enabled=false"#.to_owned()));
        assert!(overrides.contains(&r#"plugins."p@market".enabled=false"#.to_owned()));
        assert!(verify_codex_config(&config).is_err());
        assert!(!codex_base_overrides().contains(&"mcp_servers={}".to_owned()));
    }

    #[test]
    fn codex_rejects_routing_overrides_even_with_chatgpt_account() {
        for (key, value) in [
            (
                "chatgpt_base_url",
                json!("https://example.invalid/backend-api"),
            ),
            ("openai_base_url", json!("https://example.invalid/v1")),
            ("model_provider", json!("custom")),
            (
                "model_providers",
                json!({"openai":{"base_url":"https://example.invalid"}}),
            ),
        ] {
            let mut config = codex_config();
            config["config"][key] = value;
            assert!(codex_preflight_overrides(&config).is_err(), "{key}");
            assert!(verify_codex_config(&config).is_err(), "{key}");
        }
    }

    #[test]
    fn codex_verifies_effective_disabled_flags_and_notify() {
        let baseline = codex_config();
        assert!(verify_codex_config(&baseline).is_ok());
        for feature in DISABLED_CODEX_FEATURES {
            let mut config = baseline.clone();
            config["config"]["features"][*feature] = json!(true);
            assert!(verify_codex_config(&config).is_err(), "{feature}");
        }
        let mut config = baseline;
        config["config"]["notify"] = json!(["some-command"]);
        assert!(verify_codex_config(&config).is_err());
    }

    #[test]
    fn every_inherited_server_is_disabled_and_checked() {
        let mut config = codex_config();
        config["config"]["mcp_servers"]["legacy_browser"] = json!({
            "enabled":true, "command":"untrusted-helper", "args":[]
        });
        assert_eq!(
            codex_preflight_overrides(&config).unwrap(),
            [r#"mcp_servers."legacy_browser".enabled=false"#]
        );
        assert!(verify_codex_config(&config).is_err());
        config["config"]["mcp_servers"]["legacy_browser"]["enabled"] = json!(false);
        assert!(verify_codex_config(&config).is_ok());
    }

    #[test]
    fn codex_requires_chatgpt_and_explicit_auth_requirement() {
        assert!(
            verify_codex_account(&json!({
                "requiresOpenaiAuth":true,"account":{"type":"chatgpt"}
            }))
            .is_ok()
        );
        for account in [
            Value::Null,
            json!({"type":"apiKey"}),
            json!({"type":"amazonBedrock"}),
        ] {
            assert!(
                verify_codex_account(&json!({"requiresOpenaiAuth":true,"account":account}))
                    .is_err()
            );
        }
        assert!(
            verify_codex_account(&json!({
                "requiresOpenaiAuth":false,"account":{"type":"chatgpt"}
            }))
            .is_err()
        );
    }
}
