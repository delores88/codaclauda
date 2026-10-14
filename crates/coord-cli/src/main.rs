use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use coord_core::{owner_api, store::Store};
use serde_json::{Value, json};
use std::{
    io::{self, Read},
    path::PathBuf,
};

#[derive(Parser)]
#[command(
    version,
    about = "ClaudaCoda: owner-scoped Claude Code and Codex coordination"
)]
struct Cli {
    #[arg(long, global = true)]
    state_dir: Option<PathBuf>,
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Action,
}
#[derive(Subcommand)]
enum Action {
    /// Structured owner operation; reads one JSON object from stdin.
    Api {
        op: String,
    },
    Discover,
    Status,
    /// Read JSON connection details from stdin; requires dedicated_session_consent.
    Connect,
    /// Read an immutable owner grant from stdin.
    Grant,
    /// Read JSON id/grant_id/target/prompt from stdin. Returns immediately.
    Ask,
    Review,
    Delegate,
    Wait {
        id: String,
        #[arg(long, default_value_t = 20)]
        timeout: u64,
    },
    Messages {
        id: String,
        #[arg(long, default_value_t = 0)]
        after: u64,
    },
    Cancel {
        id: String,
        #[arg(long)]
        all: bool,
    },
    Pause,
    Resume,
    Reconnect,
    /// Request-bound stdio MCP; launched with a private capability by ClaudaCoda.
    Mcp {
        #[arg(long)]
        request: String,
    },
    /// MCP bound to one owner-registered existing conversation; never launches a provider.
    SessionMcp {
        #[arg(long)]
        registration: String,
        /// Advertise Claude's opt-in channel extension; does not enable it in Claude.
        #[arg(long)]
        claude_channel: bool,
    },
    #[command(hide = true)]
    Worker {
        #[arg(long)]
        id: String,
        #[arg(long)]
        claim: String,
    },
}
fn input() -> Result<Value> {
    let mut data = String::new();
    io::stdin().take(1048577).read_to_string(&mut data)?;
    ensure!(data.len() <= 1048576, "Input exceeds 1 MiB");
    serde_json::from_str(&data).context("Expected a JSON object on stdin")
}
fn run(args: Cli) -> Result<Option<Value>> {
    let request_present = std::env::var_os("CODACLAUDA_CAPABILITY").is_some();
    let session_present = std::env::var_os("CLAUDACODA_SESSION_CAPABILITY").is_some();
    enforce_capability_boundary(&args.command, request_present, session_present)?;
    let store = Store::new(args.state_dir)?;
    let cli = std::env::current_exe()?;
    let capability = std::env::var("CODACLAUDA_CAPABILITY").unwrap_or_default();
    if let Action::Mcp { request } = args.command {
        coord_core::mcp::serve(&store, &request, &capability, &cli)?;
        return Ok(None);
    }
    if let Action::SessionMcp {
        registration,
        claude_channel,
    } = args.command
    {
        let capability = std::env::var("CLAUDACODA_SESSION_CAPABILITY").map_err(|_| {
            anyhow::anyhow!("Session capability must be supplied through the private environment")
        })?;
        coord_core::session_mcp::serve(&store, &registration, &capability, claude_channel)?;
        return Ok(None);
    }
    let result = match args.command {
        Action::Api { op } => owner_api(&store, &op, &input()?, &cli)?,
        Action::Discover => owner_api(&store, "discover", &json!({}), &cli)?,
        Action::Status => owner_api(&store, "status", &json!({}), &cli)?,
        Action::Connect => owner_api(&store, "connect", &input()?, &cli)?,
        Action::Grant => owner_api(&store, "grant", &input()?, &cli)?,
        Action::Ask | Action::Review | Action::Delegate => {
            let mut a = input()?;
            a["kind"] = json!(match args.command {
                Action::Ask => "question",
                Action::Review => "review",
                _ => "delegate",
            });
            owner_api(&store, "submit", &a, &cli)?
        }
        Action::Wait { id, timeout } => coord_core::wait(&store, &id, timeout)?,
        Action::Messages { id, after } => {
            owner_api(&store, "messages", &json!({"id":id,"after":after}), &cli)?
        }
        Action::Cancel { id, all } => {
            owner_api(&store, "cancel", &json!({"id":id,"all":all}), &cli)?
        }
        Action::Pause | Action::Resume => owner_api(
            &store,
            "pause",
            &json!({"paused":matches!(args.command,Action::Pause)}),
            &cli,
        )?,
        Action::Reconnect => owner_api(&store, "reconnect", &json!({}), &cli)?,
        Action::Worker { id, claim } => {
            let mut token = String::new();
            io::stdin().take(256).read_to_string(&mut token)?;
            coord_core::worker(&store, &id, &claim, &token, &cli)?;
            return Ok(None);
        }
        Action::Mcp { .. } | Action::SessionMcp { .. } => unreachable!(),
    };
    Ok(Some(result))
}
fn enforce_capability_boundary(
    command: &Action,
    request_present: bool,
    session_present: bool,
) -> Result<()> {
    match command {
        Action::Mcp { .. } => ensure!(
            request_present && !session_present,
            "Request MCP requires its own private capability only"
        ),
        Action::SessionMcp { .. } => ensure!(
            session_present && !request_present,
            "Session MCP requires its own private capability only"
        ),
        _ => ensure!(
            !request_present && !session_present,
            "Scoped agent process cannot invoke owner operations"
        ),
    }
    Ok(())
}
fn main() {
    let args = Cli::parse();
    let mcp_transport = matches!(
        &args.command,
        Action::Mcp { .. } | Action::SessionMcp { .. }
    );
    match run(args) {
        Ok(Some(data)) => println!("{}", json!({"ok":true,"data":data})),
        Ok(None) => {}
        Err(e) => {
            if mcp_transport {
                let message: String = coord_core::redact(&format!("{e:#}"))
                    .chars()
                    .take(1024)
                    .collect();
                eprintln!("ClaudaCoda MCP stopped: {message}");
                std::process::exit(2);
            }
            println!(
                "{}",
                json!({"ok":false,"error":{"code":"REQUEST_REJECTED","message":coord_core::redact(&format!("{e:#}"))}})
            );
            std::process::exit(2)
        }
    }
}

#[cfg(test)]
mod boundary_tests {
    use super::*;

    #[test]
    fn either_capability_presence_denies_owner_and_worker_commands() {
        for command in [
            Action::Status,
            Action::Api {
                op: "session-register".into(),
            },
            Action::Worker {
                id: "x".into(),
                claim: "y".into(),
            },
        ] {
            assert!(enforce_capability_boundary(&command, false, false).is_ok());
            for (request, session) in [(true, false), (false, true), (true, true)] {
                assert!(enforce_capability_boundary(&command, request, session).is_err());
            }
        }
    }

    #[test]
    fn capabilities_cannot_cross_mcp_modes() {
        let request = Action::Mcp {
            request: "r".into(),
        };
        let session = Action::SessionMcp {
            registration: "s".into(),
            claude_channel: false,
        };
        assert!(enforce_capability_boundary(&request, true, false).is_ok());
        assert!(enforce_capability_boundary(&session, false, true).is_ok());
        for command in [&request, &session] {
            assert!(enforce_capability_boundary(command, false, false).is_err());
            assert!(enforce_capability_boundary(command, true, true).is_err());
        }
        assert!(enforce_capability_boundary(&request, false, true).is_err());
        assert!(enforce_capability_boundary(&session, true, false).is_err());
    }
}
