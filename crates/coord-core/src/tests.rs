use super::*;

#[test]
fn secrets_are_redacted_in_json_and_pem() {
    let json_secret = r#"{"password":"example-secret","api_key":"example-api"}"#;
    let clean = redact(json_secret);
    assert!(!clean.contains("example-secret"));
    assert!(!clean.contains("example-api"));
    assert!(
        !redact("-----BEGIN PRIVATE KEY-----\nprivate-bytes\n-----END PRIVATE KEY-----")
            .contains("private-bytes")
    );
}

fn fixture() -> (tempfile::TempDir, Store, String) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::new(Some(directory.path().join("state"))).unwrap();
    let grant = Grant {
        id: "grant".into(),
        project: directory.path().to_string_lossy().into(),
        allowed_paths: vec!["answer.txt".into()],
        targets: vec!["codex".into(), "claude".into()],
        kinds: vec!["question".into(), "delegate".into(), "review".into()],
        expected_result: "Bounded unit fixture".into(),
        max_requests: 8,
        max_delegations: 2,
        max_hops: 1,
        timeout_seconds: 20,
        expires_at: now() + 600,
        compute: vec![],
    };
    store
        .transaction(|s| {
            s.grants.insert(grant.id.clone(), grant);
            Ok(())
        })
        .unwrap();
    (directory, store, "grant".into())
}
fn request(id: &str, kind: &str) -> Value {
    json!({"id":id,"grant_id":"grant","target":"claude","kind":kind,"prompt":"Bounded fixture request"})
}

#[test]
fn idempotent_retries_survive_restart_and_conflicts_do_not_duplicate() {
    let (dir, store, _) = fixture();
    let a = request("same", "question");
    let first = submit(&store, &a, None).unwrap();
    let reopened = Store::new(Some(dir.path().join("state"))).unwrap();
    let second = submit(&reopened, &a, None).unwrap();
    assert_eq!(first.id, second.id);
    let mut different = a.clone();
    different["prompt"] = json!("different");
    assert!(submit(&store, &different, None).is_err());
    assert_eq!(store.read().unwrap().requests.len(), 1);
}

#[test]
fn concurrent_same_file_delegations_refuse_one() {
    let (_dir, store, _) = fixture();
    let s1 = store.clone();
    let s2 = store.clone();
    let a = std::thread::spawn(move || submit(&s1, &request("one", "delegate"), None));
    let b = std::thread::spawn(move || submit(&s2, &request("two", "delegate"), None));
    assert_eq!(
        usize::from(a.join().unwrap().is_ok()) + usize::from(b.join().unwrap().is_ok()),
        1
    );
    assert_eq!(store.read().unwrap().requests.len(), 1);
}

#[test]
fn independent_claims_proceed() {
    let (_dir, store, _) = fixture();
    submit(&store, &request("one", "delegate"), None).unwrap();
    store
        .transaction(|s| {
            let mut grant = s.grants["grant"].clone();
            grant.id = "independent".into();
            grant.allowed_paths = vec!["different.txt".into()];
            s.grants.insert(grant.id.clone(), grant);
            Ok(())
        })
        .unwrap();
    let mut a = request("two", "delegate");
    a["grant_id"] = json!("independent");
    assert!(submit(&store, &a, None).is_ok());
}

#[test]
fn cancelled_parent_cannot_create_a_late_child() {
    let (_dir, store, _) = fixture();
    submit(&store, &request("parent", "question"), None).unwrap();
    cancel(&store, "parent", true).unwrap();
    assert!(submit(&store, &request("late", "question"), Some("parent")).is_err());
    assert_eq!(store.read().unwrap().requests.len(), 1);
}

#[test]
fn hop_limit_stops_ping_pong() {
    let (_dir, store, _) = fixture();
    submit(&store, &request("root", "question"), None).unwrap();
    submit(&store, &request("child", "question"), Some("root")).unwrap();
    assert!(submit(&store, &request("grandchild", "question"), Some("child")).is_err());
}

#[test]
fn expired_scope_cannot_start() {
    let (_dir, store, _) = fixture();
    store
        .transaction(|s| {
            s.grants.get_mut("grant").unwrap().expires_at = now() - 1;
            Ok(())
        })
        .unwrap();
    assert!(submit(&store, &request("expired", "question"), None).is_err());
}

#[test]
fn read_only_tools_refuse_writes_and_foreign_receipts() {
    let (dir, store, _) = fixture();
    submit(&store, &request("read", "question"), None).unwrap();
    store
        .transaction(|s| {
            let r = s.requests.get_mut("read").unwrap();
            r.workspace = Some(dir.path().to_string_lossy().into());
            r.capability_hash = hash("cap");
            Ok(())
        })
        .unwrap();
    let result = mcp::call(
        &store,
        "read",
        "cap",
        Path::new("unused"),
        "write_file",
        &json!({"path":"answer.txt","content":"change"}),
    );
    assert!(result.unwrap_err().to_string().contains("READ_ONLY"));
    assert!(!dir.path().join("answer.txt").exists());
    assert!(
        mcp::call(
            &store,
            "read",
            "wrong",
            Path::new("unused"),
            "get_context",
            &json!({})
        )
        .is_err()
    );
}
