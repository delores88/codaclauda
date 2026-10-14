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
    about = "CodaClauda: owner-scoped Claude Code and Codex coordination"
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
    /// Request-bound stdio MCP; launched with a private capability by CodaClauda.
    Mcp {
        #[arg(long)]
        request: String,
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
    let store = Store::new(args.state_dir)?;
    let cli = std::env::current_exe()?;
    let capability = std::env::var("CODACLAUDA_CAPABILITY").unwrap_or_default();
    if let Action::Mcp { request } = args.command {
        coord_core::mcp::serve(&store, &request, &capability, &cli)?;
        return Ok(None);
    }
    ensure!(
        capability.is_empty(),
        "Scoped agent process cannot invoke owner operations"
    );
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
        Action::Mcp { .. } => unreachable!(),
    };
    Ok(Some(result))
}
fn main() {
    let args = Cli::parse();
    match run(args) {
        Ok(Some(data)) => println!("{}", json!({"ok":true,"data":data})),
        Ok(None) => {}
        Err(e) => {
            println!(
                "{}",
                json!({"ok":false,"error":{"code":"REQUEST_REJECTED","message":coord_core::redact(&format!("{e:#}"))}})
            );
            std::process::exit(2)
        }
    }
}
