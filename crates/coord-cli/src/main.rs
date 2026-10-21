use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use coord_core::{owner_api, store::Store};
use serde_json::{Value, json};
use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
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
    /// Manage passive, self-asserted mailbox addresses. Never starts an agent.
    Mailbox {
        #[command(subcommand)]
        command: MailboxAction,
    },
    /// Save a passive message. Its contents do not grant task authority.
    /// The result's "delivery" says whether a running CodaClauda app will pick it up.
    Post {
        #[arg(long)]
        to: String,
        #[arg(long)]
        from: String,
        #[arg(long, value_parser = ["notice", "question", "reply", "claim", "release"])]
        kind: String,
        #[arg(long)]
        subject: String,
        #[arg(long)]
        body_file: PathBuf,
        /// Message being answered. A reply without it answers the newest message from --to to --from.
        #[arg(long)]
        reply_to: Option<String>,
        #[arg(long)]
        id: Option<String>,
        #[arg(long)]
        resource: Option<String>,
        /// Advisory claim lifetime in minutes, from 1 to 120.
        #[arg(long)]
        ttl: Option<u64>,
    },
    Inbox {
        addr: String,
        #[arg(long, default_value_t = 0)]
        since: u64,
        #[arg(long)]
        unread: bool,
        #[arg(long, default_value_t = 20)]
        limit: u64,
    },
    Ack { addr: String, id: String },
    WaitReply {
        id: String,
        #[arg(long, default_value_t = 20)]
        timeout: u64,
    },
    Claims {
        #[arg(long)]
        resource: Option<String>,
    },
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
#[derive(Subcommand)]
enum MailboxAction {
    Register {
        name: String,
        #[arg(long)]
        label: String,
    },
    Directory,
}

fn read_mailbox_body(path: &Path) -> Result<String> {
    let mut bytes = Vec::new();
    File::open(path)
        .context("Could not open the mailbox body file")?
        .take(32_772)
        .read_to_end(&mut bytes)
        .context("Could not read the mailbox body file")?;
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    ensure!(bytes.len() <= 32_768, "Mailbox body file exceeds 32768 bytes");
    String::from_utf8(bytes.to_vec()).context("Mailbox body file must be UTF-8")
}

fn input() -> Result<Value> {
    let mut data = String::new();
    io::stdin().take(1048577).read_to_string(&mut data)?;
    ensure!(data.len() <= 1048576, "Input exceeds 1 MiB");
    let value: Value = serde_json::from_str(&data).context("Expected a JSON object on stdin")?;
    ensure!(value.is_object(), "Expected a JSON object on stdin");
    Ok(value)
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
        Action::Mailbox { command } => match command {
            MailboxAction::Register { name, label } => owner_api(&store, "mailbox-register", &json!({"name":name,"label":label}), &cli)?,
            MailboxAction::Directory => owner_api(&store, "mailbox-directory", &json!({}), &cli)?,
        },
        Action::Post { to, from, kind, subject, body_file, reply_to, id, resource, ttl } => {
            let mut input = json!({"to":to,"from":from,"kind":kind,"subject":subject,"body":read_mailbox_body(&body_file)?});
            if let Some(value) = reply_to { input["reply_to"] = json!(value); }
            if let Some(value) = id { input["id"] = json!(value); }
            if let Some(value) = resource { input["resource"] = json!(value); }
            if let Some(value) = ttl { input["ttl"] = json!(value); }
            owner_api(&store, "mailbox-post", &input, &cli)?
        }
        Action::Inbox { addr, since, unread, limit } => owner_api(&store, "mailbox-inbox", &json!({"addr":addr,"since":since,"unread":unread,"limit":limit}), &cli)?,
        Action::Ack { addr, id } => owner_api(&store, "mailbox-ack", &json!({"addr":addr,"id":id}), &cli)?,
        Action::WaitReply { id, timeout } => owner_api(&store, "mailbox-wait-reply", &json!({"id":id,"timeout":timeout}), &cli)?,
        Action::Claims { resource } => {
            let mut input = json!({});
            if let Some(value) = resource { input["resource"] = json!(value); }
            owner_api(&store, "mailbox-claims", &input, &cli)?
        }
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
    let args = match Cli::try_parse() {
        Ok(args) => args,
        Err(error) if matches!(error.kind(), clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion) => {
            let _ = error.print();
            return;
        }
        Err(error) => {
            println!("{}", json!({"ok":false,"error":{"code":"REQUEST_REJECTED","message":coord_core::redact(&error.to_string())}}));
            std::process::exit(2);
        }
    };
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
                eprintln!("CodaClauda MCP stopped: {message}");
                std::process::exit(2);
            }
            let (body, code) = error_envelope(&e);
            println!("{body}");
            std::process::exit(code)
        }
    }
}

fn error_envelope(error: &anyhow::Error) -> (Value, i32) {
    if let Some(conflict) = error.downcast_ref::<coord_core::mailbox::ClaimConflict>() {
        return (json!({"ok":false,"error":{"code":"CLAIM_CONFLICT","message":coord_core::redact(&error.to_string()),"current_holder":conflict.current_holder}}), 3);
    }
    (json!({"ok":false,"error":{"code":"REQUEST_REJECTED","message":coord_core::redact(&format!("{error:#}"))}}), 2)
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
            Action::Api {
                op: "grant-revoke".into(),
            },
            Action::Api {
                op: "limits-set".into(),
            },
            Action::Api {
                op: "policy-set".into(),
            },
            Action::Api {
                op: "policy".into(),
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
