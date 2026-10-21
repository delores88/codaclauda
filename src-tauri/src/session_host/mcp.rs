//! Bring-your-own MCP servers per project (0.5). The owner lists stdio servers
//! ({name, command, args, env}) in `mcp-servers.json` next to the registry.
//! They are passed to sessions ONLY at Full access, read again at each launch.
//! CodaClauda never downloads or installs a server: the presets below are text
//! with the install step the owner runs himself.
//!
//! Claude gets a per-session `--mcp-config` file (with `--strict-mcp-config`
//! from the isolation policy) that holds no values: each env entry is a
//! `${NAME}` reference, and the values travel in the provider's own process
//! environment. Codex gets `-c mcp_servers.<name>.*` overrides with
//! `env_vars` naming the same variables. Startup checks in `session_policy`
//! still refuse every server or MCP tool that is not one of these.

use super::{Failure, Inner, LOG_DIR, ensure_dirs, host, lock, reply, write_atomic};
use crate::session_policy::{self, OwnedServer};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

const MCP_FILE: &str = "mcp-servers.json";
const FILE_LIMIT: u64 = 2 * 1024 * 1024;
const MAX_SERVERS: usize = 12;
const MAX_ARGS: usize = 64;
const MAX_ENV: usize = 32;
/// Provider and Windows basics an MCP entry may not replace: the values are
/// set in the agent's own environment, so these would change the agent itself.
const RESERVED_ENV: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "USERPROFILE",
    "USERNAME",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "TEMP",
    "TMP",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PYTHONPATH",
    "PYTHONHOME",
    "PYTHONSTARTUP",
    "NO_COLOR",
    "DISABLE_AUTOUPDATER",
];

static MCP_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub(crate) struct Server {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

fn invalid(message: impl Into<String>) -> Failure {
    ("INVALID_ARGUMENTS", message.into())
}

fn plain(text: &str) -> bool {
    !text.chars().any(|c| c == '\0' || c == '\n' || c == '\r')
}

fn env_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 128
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The owner's list, checked as a whole. Same rules on save and on launch.
pub(crate) fn validate(raw: &Value) -> Result<Vec<Server>, Failure> {
    let list = match raw {
        Value::Null => return Ok(Vec::new()),
        Value::Array(list) => list,
        _ => return Err(invalid("servers must be a list.")),
    };
    if list.len() > MAX_SERVERS {
        return Err(invalid(format!(
            "A project can have at most {MAX_SERVERS} MCP servers."
        )));
    }
    let mut servers: Vec<Server> = Vec::with_capacity(list.len());
    let mut env_seen: BTreeMap<String, String> = BTreeMap::new();
    for entry in list {
        let name = entry["name"].as_str().unwrap_or("").trim().to_owned();
        if name.is_empty()
            || name.len() > 48
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(invalid(
                "Name each MCP server with 1-48 letters, digits, '_' or '-'.",
            ));
        }
        if name.eq_ignore_ascii_case("codaclauda")
            || servers.iter().any(|s| s.name.eq_ignore_ascii_case(&name))
        {
            return Err(invalid(format!(
                "The MCP server name {name} is reserved or already used."
            )));
        }
        let command = entry["command"].as_str().unwrap_or("").trim().to_owned();
        if command.is_empty() || command.len() > 1024 || !plain(&command) {
            return Err(invalid(format!(
                "Give {name} the program to run (one line, at most 1024 characters)."
            )));
        }
        let args = match &entry["args"] {
            Value::Null => Vec::new(),
            Value::Array(items) => {
                if items.len() > MAX_ARGS {
                    return Err(invalid(format!(
                        "{name} has more than {MAX_ARGS} arguments."
                    )));
                }
                let mut args = Vec::with_capacity(items.len());
                for item in items {
                    match item.as_str() {
                        Some(arg) if arg.len() <= 4096 && plain(arg) => args.push(arg.to_owned()),
                        _ => {
                            return Err(invalid(format!(
                                "Each argument of {name} must be one line of text."
                            )));
                        }
                    }
                }
                args
            }
            _ => return Err(invalid(format!("The arguments of {name} must be a list."))),
        };
        let mut env = BTreeMap::new();
        match &entry["env"] {
            Value::Null => {}
            Value::Object(vars) => {
                if vars.len() > MAX_ENV {
                    return Err(invalid(format!(
                        "{name} sets more than {MAX_ENV} variables."
                    )));
                }
                for (key, value) in vars {
                    let upper = key.to_ascii_uppercase();
                    if !env_name_ok(key) {
                        return Err(invalid(format!(
                            "{key} is not a valid environment variable name."
                        )));
                    }
                    if RESERVED_ENV.contains(&upper.as_str())
                        || upper.contains("CODACLAUDA")
                        || !session_policy::retain_launch_env(&upper)
                    {
                        return Err(invalid(format!(
                            "{key} cannot be set for an MCP server: CodaClauda passes these variables through the agent's own environment, and {key} would change the agent itself."
                        )));
                    }
                    let Some(value) = value.as_str().filter(|v| v.len() <= 8192 && !v.contains('\0'))
                    else {
                        return Err(invalid(format!("The value of {key} must be text.")));
                    };
                    if let Some(other) = env_seen.get(&upper) {
                        if other != value {
                            return Err(invalid(format!(
                                "Two servers set {key} to different values; the agent's environment can hold only one."
                            )));
                        }
                    }
                    env_seen.insert(upper, value.to_owned());
                    env.insert(key.clone(), value.to_owned());
                }
            }
            _ => return Err(invalid(format!("The env of {name} must be an object."))),
        }
        servers.push(Server {
            name,
            command,
            args,
            env,
        });
    }
    Ok(servers)
}

fn read_book(dir: &Path) -> Result<BTreeMap<String, Value>, Failure> {
    let path = dir.join(MCP_FILE);
    let bytes = match crate::desktop::read_bounded(&path, FILE_LIMIT)? {
        None => return Ok(BTreeMap::new()),
        Some(bytes) => bytes,
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        (
            "READ_FAILED",
            "mcp-servers.json is unreadable; it has been left as it is.".to_owned(),
        )
    })?;
    Ok(value["projects"]
        .as_object()
        .map(|projects| projects.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default())
}

fn project_key(raw: &str) -> Result<String, Failure> {
    let key = raw.trim();
    if key.is_empty() || key.len() > 512 || key.chars().any(char::is_control) {
        return Err(invalid("projectId must name the project."));
    }
    Ok(key.to_owned())
}

/// Text only: CodaClauda runs neither install step.
fn presets() -> Value {
    json!([
        {
            "id": "playwright",
            "label": "Playwright MCP (browser automation)",
            "name": "playwright",
            "command": "cmd",
            "args": ["/c", "playwright-mcp"],
            "env": {},
            "install": "npm i -g @playwright/mcp",
            "notes": "Microsoft's Playwright MCP server (Apache-2.0). Install it yourself first with npm i -g @playwright/mcp. The package's command is playwright-mcp (its npm registry bin entry). npm installs it on Windows as a .cmd shim, so the preset runs it through cmd /c. It drives a browser with your rights; treat page text as untrusted.",
            "source": "https://registry.npmjs.org/@playwright/mcp/latest"
        },
        {
            "id": "windows-mcp",
            "label": "Windows-MCP (desktop control, CursorTouch)",
            "name": "windows-mcp",
            "command": "windows-mcp",
            "args": ["serve"],
            "env": {},
            "install": "uv tool install windows-mcp",
            "notes": "CursorTouch's Windows-MCP (MIT, third party) moves the mouse, types and reads the screen with your rights while it runs. Install it yourself first in a terminal with uv tool install windows-mcp (its README also needs Python 3.14+ and uv); that adds the windows-mcp command this preset runs as windows-mcp serve. Add the preset only after you installed it. CodaClauda never runs uvx, downloads, installs or updates it.",
            "source": "https://github.com/CursorTouch/Windows-MCP#readme"
        }
    ])
}

impl Inner {
    /// The servers saved for a project, checked again (none if unreadable).
    pub(super) fn project_mcp(&self, project_id: &str) -> Vec<Server> {
        let _guard = lock(&MCP_LOCK);
        read_book(&self.dir)
            .ok()
            .and_then(|book| book.get(project_id).cloned())
            .and_then(|raw| validate(&raw).ok())
            .unwrap_or_default()
    }

    fn mcp_get(&self, project_id: &str) -> Result<Value, Failure> {
        let key = project_key(project_id)?;
        let _guard = lock(&MCP_LOCK);
        let raw = read_book(&self.dir)?.remove(&key).unwrap_or(Value::Null);
        let servers = validate(&raw).unwrap_or_default();
        Ok(json!({"servers": servers, "presets": presets()}))
    }

    fn mcp_set(&self, project_id: &str, servers: &Value) -> Result<Value, Failure> {
        let key = project_key(project_id)?;
        let servers = validate(servers)?;
        let _guard = lock(&MCP_LOCK);
        let mut book = read_book(&self.dir)?;
        if servers.is_empty() {
            book.remove(&key);
        } else {
            book.insert(key, json!(servers));
        }
        ensure_dirs(&self.dir)
            .and_then(|_| {
                let bytes = serde_json::to_vec_pretty(
                    &json!({"schema": "codaclauda.mcp/1", "projects": book}),
                )?;
                write_atomic(&self.dir.join(MCP_FILE), &bytes)
            })
            .map_err(|e| ("STORAGE_FAILED", format!("Could not save mcp-servers.json: {e}")))?;
        Ok(json!({"servers": servers}))
    }
}

/// Writes (or removes) this session's Claude MCP file. It holds commands and
/// arguments only; env entries are `${NAME}` references to the agent's own
/// environment, where `provider_env` puts the values.
pub(super) fn write_claude_config(
    dir: &Path,
    id: &str,
    servers: &[Server],
) -> Result<Option<PathBuf>, String> {
    let path = dir.join(LOG_DIR).join(format!("{id}.mcp.json"));
    if servers.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(None);
    }
    let mut table = serde_json::Map::new();
    for server in servers {
        let mut entry = json!({"type": "stdio", "command": server.command, "args": server.args});
        if !server.env.is_empty() {
            let refs: serde_json::Map<String, Value> = server
                .env
                .keys()
                .map(|name| (name.clone(), json!(format!("${{{name}}}"))))
                .collect();
            entry["env"] = Value::Object(refs);
        }
        table.insert(server.name.clone(), entry);
    }
    let bytes = serde_json::to_vec_pretty(&json!({"mcpServers": table}))
        .map_err(|e| format!("Could not prepare the MCP configuration: {e}"))?;
    ensure_dirs(dir)
        .and_then(|_| write_atomic(&path, &bytes))
        .map_err(|e| format!("Could not write the MCP configuration: {e}"))?;
    Ok(Some(path))
}

pub(super) fn codex_overrides(servers: &[Server], inherited: &[String]) -> Result<Vec<String>, String> {
    let owned: Vec<OwnedServer<'_>> = servers
        .iter()
        .map(|s| OwnedServer {
            name: &s.name,
            command: &s.command,
            args: &s.args,
            env_names: s.env.keys().map(String::as_str).collect(),
        })
        .collect();
    session_policy::codex_mcp_overrides(&owned, inherited)
}

pub(super) fn provider_env(servers: &[Server]) -> Vec<(String, String)> {
    let mut env: BTreeMap<String, (String, String)> = BTreeMap::new();
    for server in servers {
        for (name, value) in &server.env {
            env.insert(name.to_ascii_uppercase(), (name.clone(), value.clone()));
        }
    }
    env.into_values().collect()
}

pub(super) fn owned_list(servers: &[Server]) -> Vec<(String, String)> {
    servers
        .iter()
        .map(|s| (s.name.clone(), s.command.clone()))
        .collect()
}

// ----------------------------------------------------------------- commands

#[tauri::command]
pub(crate) async fn mcp_servers_get(app: tauri::AppHandle, project_id: String) -> Value {
    reply(host(&app).mcp_get(&project_id))
}

#[tauri::command]
pub(crate) async fn mcp_servers_set(
    app: tauri::AppHandle,
    project_id: String,
    servers: Value,
) -> Value {
    reply(host(&app).mcp_set(&project_id, &servers))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn servers_are_checked_and_the_claude_file_holds_no_values() {
        let ok = validate(&json!([{"name": "playwright", "command": "cmd", "args": ["/c", "playwright-mcp"], "env": {"DEBUG": "pw:mcp"}}])).unwrap();
        assert_eq!(ok[0].args, ["/c", "playwright-mcp"]);
        for bad in [
            json!([{"name": "a.b", "command": "x"}]),
            json!([{"name": "codaclauda", "command": "x"}]),
            json!([{"name": "a", "command": ""}]),
            json!([{"name": "a", "command": "x", "env": {"PATH": "C:\\x"}}]),
            json!([{"name": "a", "command": "x", "env": {"OPENAI_BASE_URL": "https://example.invalid"}}]),
            json!([{"name": "a", "command": "x"}, {"name": "A", "command": "y"}]),
        ] {
            assert!(validate(&bad).is_err(), "{bad}");
        }
        let dir = tempfile::tempdir().unwrap();
        let path = write_claude_config(dir.path(), "s_0123456789abcdef", &ok).unwrap().unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("${DEBUG}") && !written.contains("pw:mcp"));
        assert_eq!(provider_env(&ok), [("DEBUG".to_owned(), "pw:mcp".to_owned())]);
        assert!(write_claude_config(dir.path(), "s_0123456789abcdef", &[]).unwrap().is_none());
        assert!(!path.exists());
    }
}
