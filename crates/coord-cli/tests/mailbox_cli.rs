//! Real CLI processes against isolated passive boards; no providers or models.
use serde_json::Value;
use std::{fs, path::PathBuf, process::Command, time::{SystemTime, UNIX_EPOCH}};

struct Fixture { root: PathBuf, parent: PathBuf }
impl Fixture {
    fn new() -> Self {
        let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../local/mailbox-cli-tests");
        fs::create_dir_all(&parent).unwrap();
        let parent = parent.canonicalize().unwrap();
        let root = parent.join(format!("{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&root).unwrap();
        Self { root, parent }
    }
    fn run(&self, args: &[&str]) -> (i32, Value) {
        let output = Command::new(env!("CARGO_BIN_EXE_claudacoda-cli"))
            .arg("--state-dir").arg(self.root.join("board")).arg("--json")
            .args(args).env_remove("CODACLAUDA_CAPABILITY")
            .env_remove("CLAUDACODA_SESSION_CAPABILITY").output().unwrap();
        let value = serde_json::from_slice(&output.stdout).expect("Every non-help CLI response is JSON");
        (output.status.code().unwrap(), value)
    }
    fn post(&self, id: &str, from: &str, to: &str, kind: &str, bytes: &[u8], extra: &[&str]) -> (i32, Value) {
        let body = self.root.join(format!("{id}.txt"));
        fs::write(&body, bytes).unwrap();
        let path = body.to_str().unwrap();
        let mut args = vec!["post", "--id", id, "--from", from, "--to", to, "--kind", kind, "--subject", "CLI fixture", "--body-file", path];
        args.extend_from_slice(extra);
        self.run(&args)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Delete only the exact fresh fixture directory under this repository.
        if let Ok(resolved) = self.root.canonicalize() {
            if resolved.parent() == Some(self.parent.as_path()) {
                let _ = fs::remove_dir_all(resolved);
            }
        }
    }
}

#[test]
fn process_round_trip_preserves_utf8_idempotence_cursor_ack_and_reply() {
    let f = Fixture::new();
    for (name, label) in [("alpha-agent", "Alpha"), ("beta-agent", "Beta")] {
        assert_eq!(f.run(&["mailbox", "register", name, "--label", label]).0, 0);
    }
    let (code, first) = f.post("question-one", "alpha-agent", "beta-agent", "question", "\u{feff}Can you review café?\n".as_bytes(), &[]);
    assert_eq!(code, 0);
    assert_eq!(first["data"]["body"], "Can you review café?\n");
    let repeated = f.post("question-one", "alpha-agent", "beta-agent", "question", "\u{feff}Can you review café?\n".as_bytes(), &[]);
    assert_eq!(repeated.0, 0);
    assert_eq!(repeated.1["data"]["id"], first["data"]["id"]);
    assert_eq!(f.post("question-one", "alpha-agent", "beta-agent", "question", b"changed", &[]).0, 2);
    let (code, inbox) = f.run(&["inbox", "beta-agent", "--unread", "--limit", "1"]);
    assert_eq!(code, 0);
    assert_eq!(inbox["data"]["messages"].as_array().unwrap().len(), 1);
    let cursor = inbox["data"]["next_cursor"].as_u64().unwrap().to_string();
    assert!(f.run(&["inbox", "beta-agent", "--since", &cursor]).1["data"]["messages"].as_array().unwrap().is_empty());
    let (code, ack) = f.run(&["ack", "beta-agent", "question-one"]);
    assert_eq!(code, 0);
    assert!(ack["data"]["read_at"].is_number());
    assert!(f.run(&["inbox", "beta-agent", "--unread"]).1["data"]["messages"].as_array().unwrap().is_empty());
    let timeout = f.run(&["wait-reply", "question-one", "--timeout", "0"]);
    assert_eq!(timeout.0, 0);
    assert_eq!(timeout.1["data"]["timed_out"], true);
    assert_eq!(f.post("reply-one", "beta-agent", "alpha-agent", "reply", b"Reviewed.", &["--reply-to", "question-one"]).0, 0);
    let result = f.run(&["wait-reply", "question-one", "--timeout", "0"]);
    assert_eq!(result.0, 0);
    assert_eq!(result.1["data"]["reply"]["id"], "reply-one");
    assert_eq!(result.1["data"]["timed_out"], false);
    assert!(!f.root.join("board/state.json").exists(), "Mailbox must not change coordination schema");
}

#[test]
fn claims_have_distinct_conflict_exit_and_release_allows_next_holder() {
    let f = Fixture::new();
    for name in ["alpha-agent", "beta-agent"] { assert_eq!(f.run(&["mailbox", "register", name, "--label", name]).0, 0); }
    assert_eq!(f.post("claim-one", "alpha-agent", "owner", "claim", b"Bounded test", &["--resource", "test-ui", "--ttl", "1"]).0, 0);
    let (code, conflict) = f.post("claim-two", "beta-agent", "owner", "claim", b"Bounded test", &["--resource", "test-ui", "--ttl", "1"]);
    assert_eq!(code, 3);
    assert_eq!(conflict["error"]["code"], "CLAIM_CONFLICT");
    assert_eq!(conflict["error"]["current_holder"]["holder"], "alpha-agent");
    assert_eq!(f.run(&["claims", "--resource", "test-ui"]).1["data"]["claims"].as_array().unwrap().len(), 1);
    assert_eq!(f.post("release-one", "alpha-agent", "owner", "release", b"Done", &["--resource", "test-ui"]).0, 0);
    assert_eq!(f.post("claim-two", "beta-agent", "owner", "claim", b"Bounded test", &["--resource", "test-ui", "--ttl", "1"]).0, 0);
}

#[test]
fn invalid_utf8_oversize_and_malformed_commands_return_json_exit_two() {
    let f = Fixture::new();
    for (id, bytes) in [("bad-utf8", vec![0xff]), ("too-large", vec![b'x'; 32_769])] {
        let (code, error) = f.post(id, "codex-claudacoda", "owner", "notice", &bytes, &[]);
        assert_eq!(code, 2);
        assert_eq!(error["error"]["code"], "REQUEST_REJECTED");
    }
    for args in [&["not-a-command"][..], &["post", "--kind", "unknown"][..], &["inbox", "owner", "--since", "negative"][..], &["wait-reply", "missing", "--timeout", "61"][..]] {
        let (code, error) = f.run(args);
        assert_eq!(code, 2);
        assert_eq!(error["ok"], false);
    }
}
