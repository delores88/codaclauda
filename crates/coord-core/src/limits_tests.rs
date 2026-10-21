//! 0.5 owner limits: budgets, policy, legacy grants, schema 3, revoke,
//! history bounds and the scheduler. Fixtures never launch providers.
use super::*;

const CLI: &str = "must-never-be-launched.exe";

fn fixture() -> (tempfile::TempDir, Store, Grant) {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let project = project.canonicalize().unwrap();
    let store = Store::new(Some(temp.path().join("state"))).unwrap();
    let grant = Grant {
        id: "grant-fixture".into(),
        project: project.to_string_lossy().into_owned(),
        allowed_paths: vec!["src".into()],
        targets: vec!["codex-fixture".into(), "claude-fixture".into()],
        kinds: vec!["question".into(), "review".into(), "delegate".into()],
        expected_result: "Unit test fixture only".into(),
        max_requests: Unlimited,
        max_delegations: Unlimited,
        max_hops: Unlimited,
        timeout_seconds: Finite(60),
        expires_at: Unlimited,
        compute: vec![],
        max_turns: Unlimited,
        max_mcp_calls: Finite(3),
        max_compute_jobs: Finite(0),
        policy_version: POLICY_VERSION,
        revoked_at: None,
    };
    store
        .transaction(|state| {
            state.grants.insert(grant.id.clone(), grant.clone());
            for agent in ["codex", "claude"] {
                let endpoint = Endpoint {
                    id: format!("{agent}-fixture"),
                    label: None,
                    agent: agent.into(),
                    executable: "not-an-executable-test-fixture".into(),
                    workspace: grant.project.clone(),
                    version: "test-fixture".into(),
                    auth_status: "unverified-test-fixture".into(),
                    mode: "new-session-v1".into(),
                };
                state.endpoints.insert(endpoint.id.clone(), endpoint);
            }
            Ok(())
        })
        .unwrap();
    (temp, store, grant)
}

fn ask(store: &Store, id: &str, target: &str, parent: Option<&str>) -> Result<Request> {
    submit(
        store,
        &json!({"id":id,"grant_id":"grant-fixture","target":target,"kind":"question","prompt":"Fixture question"}),
        parent,
    )
}

/// Mark a request as launched by a worker, holding `capability`.
fn running(store: &Store, id: &str, capability: &str) {
    store
        .transaction(|s| {
            let r = s.requests.get_mut(id).unwrap();
            r.worker_claim = Some(format!("claim-{id}"));
            r.capability_hash = hash(capability);
            r.state = "running".into();
            Ok(())
        })
        .unwrap();
}

fn until(mut condition: impl FnMut() -> bool) {
    let end = std::time::Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(std::time::Instant::now() < end, "condition not reached");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn legacy_grant_json(project: &str) -> Value {
    // The exact 0.4.0 shape: no policy_version, turns, tool calls or revocation.
    json!({"id":"legacy-grant","project":project,"allowed_paths":["src"],"targets":["codex-fixture"],
        "kinds":["question"],"expected_result":"0.4 fixture","max_requests":8,"max_delegations":2,
        "max_hops":2,"timeout_seconds":180,"expires_at":now() + 900,"compute":[]})
}

#[test]
fn budget_inputs_distinguish_zero_inherit_finite_and_unlimited() {
    let parse = |value: Value, field: &str, min: u64| budget::parse(&json!({ field: value }), field, min);
    assert_eq!(budget::parse(&json!({}), "max_hops", 0).unwrap(), None);
    assert_eq!(parse(Value::Null, "max_hops", 0).unwrap(), None);
    assert_eq!(parse(json!(0), "max_hops", 0).unwrap(), Some(Finite(0)));
    assert_eq!(parse(json!(7), "max_hops", 0).unwrap(), Some(Finite(7)));
    assert_eq!(parse(json!("unlimited"), "max_hops", 0).unwrap(), Some(Unlimited));
    assert_eq!(parse(json!(budget::JS_SAFE_MAX), "max_turns", 1).unwrap(), Some(Finite(budget::JS_SAFE_MAX)));
    assert_eq!(parse(json!("never"), "expires_seconds", 30).unwrap(), Some(Unlimited));
    let expected = "max_turns must be a whole number from 1 to 9007199254740991, or \"unlimited\"";
    for bad in [json!(0), json!(9_007_199_254_740_992u64), json!(1.5), json!(-1), json!("5"), json!("never"), json!("Unlimited"), json!([1])] {
        assert_eq!(parse(bad, "max_turns", 1).unwrap_err().to_string(), expected);
    }
    // Persisted form: a number or "unlimited", never null; nothing else reads.
    for (budget, text) in [(Finite(0), "0"), (Finite(42), "42"), (Unlimited, "\"unlimited\"")] {
        assert_eq!(serde_json::to_string(&budget).unwrap(), text);
        assert_eq!(serde_json::from_str::<Budget>(text).unwrap(), budget);
    }
    for bad in ["null", "-1", "1.5", "\"never\"", "\"Unlimited\""] {
        assert!(serde_json::from_str::<Budget>(bad).is_err(), "{bad}");
    }
    // Overflow is a named validation error, never a silent "unlimited".
    let (_temp, store, grant) = fixture();
    let spec = json!({"project":grant.project,"allowed_paths":["src"],"targets":["codex-fixture"],
        "kinds":["question"],"expected_result":"fixture","expires_seconds":budget::JS_SAFE_MAX});
    assert_eq!(
        create_grant(&store, &spec).unwrap_err().to_string(),
        "expires_seconds is too large to schedule; choose a smaller value or \"unlimited\""
    );
    assert!(budget::increment(u64::MAX, "mcp_calls_used").unwrap_err().to_string().contains("too large"));
}

#[test]
fn current_grant_missing_a_budget_fails_closed() {
    let (_temp, _store, grant) = fixture();
    let saved = serde_json::to_value(&grant).unwrap();
    assert_eq!(serde_json::from_value::<Grant>(saved.clone()).unwrap(), grant);
    for field in ["max_turns", "max_mcp_calls", "max_compute_jobs", "max_requests", "timeout_seconds", "expires_at"] {
        let mut missing = saved.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<Grant>(missing).is_err(), "missing {field}");
        let mut null = saved.clone();
        null[field] = Value::Null;
        assert!(serde_json::from_value::<Grant>(null).is_err(), "null {field}");
    }
    let mut future = saved;
    future["policy_version"] = json!(2);
    assert!(serde_json::from_value::<Grant>(future).is_err());
}

#[test]
fn persisted_policy_requires_complete_validated_values_without_rewriting() {
    let (_temp, store, _grant) = fixture();
    let path = store.root.join("policy.json");
    assert_eq!(policy::read(&store.root).unwrap(), policy::Policy::default());
    let mut full = serde_json::to_value(policy::Policy::default()).unwrap();
    full["concurrent"] = json!(2);
    full["grant_defaults"]["max_requests"] = json!(3);
    let mut missing_concurrent = full.clone();
    missing_concurrent.as_object_mut().unwrap().remove("concurrent");
    let mut missing_budget = full.clone();
    missing_budget["grant_defaults"].as_object_mut().unwrap().remove("max_requests");
    let mut invalid = vec![json!({}), missing_concurrent, missing_budget];
    for value in [Value::Null, json!(0), json!(budget::JS_SAFE_MAX + 1)] {
        let mut bad = full.clone();
        bad["grant_defaults"]["max_requests"] = value;
        invalid.push(bad);
    }
    let mut unknown = full.clone();
    unknown["schema_version"] = json!(999);
    invalid.push(unknown);
    for value in invalid {
        let original = serde_json::to_vec(&value).unwrap();
        fs::write(&path, &original).unwrap();
        assert!(policy::read(&store.root).is_err(), "{value}");
        assert!(policy::api(&store.root, "limits-set", &json!({"concurrent":1})).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
    }
    fs::write(&path, serde_json::to_vec(&full).unwrap()).unwrap();
    policy::api(&store.root, "policy-set", &json!({"grant_defaults":{"max_turns":40}})).unwrap();
    let stored = policy::read(&store.root).unwrap();
    assert_eq!(stored.concurrent, Finite(2));
    assert_eq!(stored.grant_defaults.max_requests, Finite(3));
    assert_eq!(stored.grant_defaults.max_turns, Finite(40));
}

#[test]
fn legacy_grant_keeps_its_0_4_limits_exactly() {
    let original = legacy_grant_json("C:/fixture");
    let legacy: Grant = serde_json::from_value(original.clone()).unwrap();
    assert!(legacy.is_legacy());
    // A legacy grant re-serializes in its original shape.
    assert_eq!(serde_json::to_value(&legacy).unwrap(), original);
    let e = legacy.effective();
    assert_eq!(
        (e.timeout_seconds, e.max_requests, e.max_delegations, e.max_hops),
        (Finite(180), Finite(8), Finite(2), Finite(2))
    );
    assert_eq!(
        (e.max_turns, e.max_mcp_calls, e.max_compute_jobs),
        (Finite(12), Finite(128), Finite(2))
    );
    assert_eq!(
        (e.file_bytes, e.provider_record_bytes, e.provider_output_bytes),
        (Finite(262_144), 1 << 20, Finite(8 << 20))
    );
    let public = legacy.public();
    assert_eq!(public["effective"]["policy_version"], 0);
    assert_eq!(public["effective"]["file_io"], "whole-file");
    assert!(public["revoked_at"].is_null());
    // A round-1 development grant: its stored 200 turns and 8 h run time do not apply.
    let mut round_one = original;
    round_one["max_turns"] = json!(200);
    round_one["revoked_at"] = Value::Null;
    round_one["timeout_seconds"] = json!(28_800);
    let round_one: Grant = serde_json::from_value(round_one).unwrap();
    assert_eq!(
        (round_one.effective().max_turns, round_one.effective().timeout_seconds),
        (Finite(12), Finite(3600))
    );
    // Legacy grants count every call, including polls, up to 128 with the old error.
    let mut r: Request = serde_json::from_value(json!({"id":"r","digest":"d","grant_id":"legacy-grant",
        "target":"codex-fixture","kind":"question","prompt":"p","expected_result":"e","origin":"owner",
        "origin_session":null,"parent_id":null,"root_id":"r","hop":0,"state":"running","created_at":1,
        "updated_at":1,"workspace":null,"session_id":null,"answer":null,"receipt":null,"blocker":null,
        "cancel_requested":false,"worker_claim":"c","capability_hash":"h",
        "events":(0..127).map(|seq| json!({"seq":seq,"at":1,"kind":"mcp-call","data":{}})).collect::<Vec<_>>()}))
    .unwrap();
    assert_eq!((r.mcp_calls_used(), r.next_seq()), (127, 127));
    r.count_mcp_call(&legacy, "wait").unwrap();
    let error = r.count_mcp_call(&legacy, "messages").unwrap_err();
    assert_eq!(error.to_string(), "Owner tool-call budget reached; stop and report remaining work");
    assert_eq!(r.mcp_calls_used, Some(128));
    assert!(legacy.ensure_compute_job(1).is_ok() && legacy.ensure_compute_job(2).is_err());
}

#[test]
fn current_grants_count_every_call_except_status_reads() {
    let (_temp, _store, grant) = fixture();
    let mut r = Request {
        mcp_calls_used: Some(0),
        ..serde_json::from_value(json!({"id":"r","digest":"d","grant_id":"g","target":"t","kind":"question",
            "prompt":"p","expected_result":"e","origin":"owner","origin_session":null,"parent_id":null,
            "root_id":"r","hop":0,"state":"running","created_at":1,"updated_at":1,"workspace":null,
            "session_id":null,"answer":null,"receipt":null,"blocker":null,"cancel_requested":false,
            "worker_claim":"c","capability_hash":"h","events":[]}))
        .unwrap()
    };
    for tool in ["get_context", "wait", "messages", "read_file", "wait", "ask"] {
        r.count_mcp_call(&grant, tool).unwrap();
    }
    assert_eq!(r.mcp_calls_used, Some(3));
    let error = r.count_mcp_call(&grant, "list_files").unwrap_err().to_string();
    assert_eq!(error, "OWNER_LIMIT: tool-call budget reached (max_mcp_calls 3 on this authorization). Create a new authorization with a higher Maximum tool calls.");
    r.count_mcp_call(&grant, "wait").unwrap();
    assert!(grant.ensure_compute_job(0).unwrap_err().to_string().contains("max_compute_jobs 0"));
}

#[test]
fn schema_3_migration_backs_up_exact_bytes_and_reads_1_2_3() {
    let (_temp, store, grant) = fixture();
    let state_file = store.root.join("state.json");
    // Start from a 0.4-shaped schema 1 board holding only a legacy grant.
    let mut legacy_board = serde_json::to_value(store.read().unwrap()).unwrap();
    legacy_board["schema_version"] = json!(1);
    legacy_board["grants"] = json!({"legacy-grant": legacy_grant_json(&grant.project)});
    let original = serde_json::to_vec_pretty(&legacy_board).unwrap();
    fs::write(&state_file, &original).unwrap();
    mailbox::api(&store, "post", &json!({"id":"note","from":"codex-claudacoda","to":"owner","kind":"notice","subject":"Fixture","body":"Passive"})).unwrap();
    let mailbox = fs::read(store.root.join("mailbox.json")).unwrap();
    assert_eq!(store.read().unwrap().schema_version, 1);
    store.transaction(|s| { s.paused = true; Ok(()) }).unwrap();
    assert_eq!(store.read().unwrap().schema_version, 1, "no 0.5 data, no upgrade");
    assert!(!store.root.join("state.schema1.backup.json").exists());
    let before = fs::read(&state_file).unwrap();
    store
        .transaction(|s| {
            s.grants.insert(grant.id.clone(), grant.clone());
            Ok(())
        })
        .unwrap();
    assert_eq!(fs::read(store.root.join("state.schema1.backup.json")).unwrap(), before);
    let migrated: Value = serde_json::from_slice(&fs::read(&state_file).unwrap()).unwrap();
    assert_eq!(migrated["schema_version"], 3);
    assert_eq!(migrated["grants"]["legacy-grant"], legacy_board["grants"]["legacy-grant"]);
    assert_eq!(fs::read(store.root.join("mailbox.json")).unwrap(), mailbox);
    // Schema 2 (registered sessions) upgrades with its own exact backup.
    let second = tempfile::tempdir().unwrap();
    let board = Store::new(Some(second.path().join("board"))).unwrap();
    session::owner_api(&board, "session-register", &json!({"id":"chat","provider":"claude","chat_id":"existing","label":"Existing","project":second.path(),"mode":"inbox"})).unwrap();
    let schema2 = fs::read(board.root.join("state.json")).unwrap();
    assert_eq!(board.read().unwrap().schema_version, 2);
    board.transaction(|s| { s.grants.insert(grant.id.clone(), grant.clone()); Ok(()) }).unwrap();
    assert_eq!(fs::read(board.root.join("state.schema2.backup.json")).unwrap(), schema2);
    assert_eq!(board.read().unwrap().schema_version, 3);
    // Reads accept 1, 2 and 3 only, and an old schema cannot carry 0.5 data.
    for (version, ok) in [(1, true), (2, true), (3, true), (4, false)] {
        let mut value = legacy_board.clone();
        value["schema_version"] = json!(version);
        fs::write(&state_file, serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(store.read().is_ok(), ok, "schema {version}");
    }
    let mut inconsistent = legacy_board;
    inconsistent["schema_version"] = json!(2);
    inconsistent["grants"]["grant-fixture"] = serde_json::to_value(&grant).unwrap();
    fs::write(&state_file, serde_json::to_vec(&inconsistent).unwrap()).unwrap();
    assert!(store.read().err().unwrap().to_string().contains("requires schema 3"));
}

#[test]
fn revoke_races_dispatch_and_stays_revoked_after_restart() {
    let (_temp, store, _grant) = fixture();
    for n in 0..24 {
        let target = if n % 2 == 0 { "codex-fixture" } else { "claude-fixture" };
        ask(&store, &format!("race-{n}"), target, None).unwrap();
    }
    let claims = |store: &Store| -> usize {
        store.read().unwrap().requests.values()
            .map(|r| r.events.iter().filter(|e| e.kind == "dispatch-claimed").count())
            .sum()
    };
    let dispatcher = store.clone();
    let racing = std::thread::spawn(move || dispatch(&dispatcher, Path::new(CLI)));
    let revoked = owner_api(&store, "grant-revoke", &json!({"id":"grant-fixture"}), Path::new(CLI)).unwrap();
    let claimed_at_revoke = claims(&store);
    racing.join().unwrap().unwrap();
    assert_eq!(claims(&store), claimed_at_revoke, "no claim after the revocation committed");
    assert_eq!(revoked["expires_at"], revoked["revoked_at"]);
    // A new Store over the same directory: still revoked, nothing relaunched.
    let reopened = Store::new(Some(store.root.clone())).unwrap();
    recover(&reopened).unwrap();
    dispatch(&reopened, Path::new(CLI)).unwrap();
    let state = reopened.read().unwrap();
    assert_eq!(state.grants["grant-fixture"].revoked_at, revoked["revoked_at"].as_u64());
    assert!(state.requests.values().all(|r| r.terminal()));
    assert_eq!(claims(&reopened), claimed_at_revoke);
    let again = owner_api(&reopened, "grant-revoke", &json!({"id":"grant-fixture"}), Path::new(CLI)).unwrap();
    assert_eq!(again["revoked_at"], revoked["revoked_at"]);
    let error = ask(&reopened, "after-restart", "codex-fixture", None).unwrap_err();
    assert_eq!(error.to_string(), EXPIRED);
}

#[test]
fn event_spill_keeps_monotonic_seq_and_lifetime_tool_calls() {
    let (_temp, store, grant) = fixture();
    ask(&store, "long", "codex-fixture", None).unwrap();
    // History and payload files are named by ID; Windows names ignore case.
    let error = ask(&store, "Long", "codex-fixture", None).unwrap_err().to_string();
    assert!(error.starts_with("ID_CONFLICT: request ID Long differs only in letter case from existing request long"));
    assert!(!store.read().unwrap().requests.contains_key("Long"));
    for batch in 0..25 {
        store
            .transaction(|s| {
                let r = s.requests.get_mut("long").unwrap();
                if batch < 2 {
                    r.count_mcp_call(&grant, "read_file")?;
                }
                for n in 0..100 {
                    r.event("provider-tool", json!({"batch":batch,"n":n}));
                }
                Ok(())
            })
            .unwrap();
    }
    let r = store.read().unwrap().requests["long"].clone();
    assert!(r.events.len() <= spool::RETAINED_EVENTS && r.spilled_through.is_some());
    assert_eq!((r.next_seq(), r.events_total(), r.mcp_calls_used()), (2501, 2501, 2));
    assert_eq!(r.events.first().unwrap().seq, r.spilled_through.unwrap() + 1);
    // A crash after the durable append but before the state commit leaves
    // uncommitted lines: here a phantom event the board never kept, duplicates
    // of retained events, and a torn last line with no newline.
    let history = spool::history_path(&store.root, "long").unwrap();
    let committed = fs::read(&history).unwrap();
    let through = r.spilled_through.unwrap();
    let mut file = fs::OpenOptions::new().append(true).open(&history).unwrap();
    writeln!(file, "{}", json!({"seq":through + 1,"at":1,"kind":"phantom","data":{}})).unwrap();
    for event in &r.events[..3] {
        writeln!(file, "{}", serde_json::to_string(event).unwrap()).unwrap();
    }
    write!(file, "{{\"seq\":{},\"at\":1,\"ki", through + 4).unwrap();
    drop(file);
    let all = |store: &Store| -> Vec<Value> {
        let (mut events, mut after) = (vec![], 0);
        loop {
            let page = owner_api(store, "messages", &json!({"id":"long","after":after}), Path::new(CLI)).unwrap();
            let batch = page["events"].as_array().unwrap().clone();
            if batch.is_empty() {
                return events;
            }
            assert_eq!(page["events_total"], store.read().unwrap().requests["long"].events_total());
            after = page["next_offset"].as_u64().unwrap();
            events.extend(batch);
        }
    };
    let seqs = |events: &[Value]| events.iter().map(|e| e["seq"].as_u64().unwrap()).collect::<Vec<u64>>();
    let events = all(&store);
    assert_eq!(seqs(&events), (0..2501).collect::<Vec<u64>>());
    assert!(events.iter().all(|e| e["kind"] != "phantom"));
    // New events continue the sequence; the lifetime tool-call count is unaffected.
    store.transaction(|s| { s.requests.get_mut("long").unwrap().event("after-spill", json!({})); Ok(()) }).unwrap();
    let r = store.read().unwrap().requests["long"].clone();
    assert_eq!((r.events.last().unwrap().seq, r.mcp_calls_used()), (2501, 2));
    // The next spill cuts the uncommitted bytes before appending, so the file
    // holds each committed event once and every line is complete.
    store
        .transaction(|s| {
            let r = s.requests.get_mut("long").unwrap();
            for n in 0..600 {
                r.event("provider-tool", json!({"late":n}));
            }
            Ok(())
        })
        .unwrap();
    let r = store.read().unwrap().requests["long"].clone();
    assert!(r.spilled_through.unwrap() > through);
    let text = fs::read(&history).unwrap();
    assert!(text.starts_with(&committed) && text.ends_with(b"\n"));
    assert_eq!(r.spilled_bytes, Some(text.len() as u64));
    let lines: Vec<Event> = text.split(|&b| b == b'\n').filter(|l| !l.is_empty())
        .map(|l| serde_json::from_slice(l).unwrap()).collect();
    assert_eq!(lines.iter().map(|e| e.seq).collect::<Vec<_>>(), (0..=r.spilled_through.unwrap()).collect::<Vec<_>>());
    let events = all(&store);
    assert_eq!(seqs(&events), (0..3102).collect::<Vec<u64>>());
    assert!(events.iter().all(|e| e["kind"] != "phantom"));
    // The byte bound applies too: large events spill long before 2000 of them.
    ask(&store, "wide", "codex-fixture", None).unwrap();
    for _ in 0..12 {
        store.transaction(|s| { s.requests.get_mut("wide").unwrap().event("provider-tool", json!({"text":"x".repeat(100 << 10)})); Ok(()) }).unwrap();
    }
    let wide = &store.read().unwrap().requests["wide"];
    assert!(serde_json::to_vec(&wide.events).unwrap().len() <= spool::RETAINED_BYTES);
    assert!(wide.spilled_through.is_some());
}

#[test]
fn large_answer_is_saved_beside_the_board_with_a_marked_preview() {
    let (_temp, store, _grant) = fixture();
    let small = "short answer".to_owned();
    assert_eq!(spool::inline_or_file(&store.root, "r1", "answer", small.clone()).unwrap(), (small, None));
    let text = "\u{20ac}".repeat(100_000); // 300,000 bytes; preview must end on a character
    let (inline, payload) = spool::inline_or_file(&store.root, "r1", "answer", text.clone()).unwrap();
    let payload = payload.unwrap();
    let path = store.root.join("requests").join("r1").join("answer.txt");
    assert_eq!(fs::read_to_string(&path).unwrap(), text);
    assert_eq!(payload.path, path.to_string_lossy());
    assert_eq!((payload.bytes, payload.sha256.as_str()), (300_000, hash(&text).as_str()));
    assert!(payload.preview_only && payload.preview.len() <= spool::PREVIEW_BYTES && text.starts_with(&payload.preview));
    assert!(payload.preview.len() > spool::PREVIEW_BYTES - 3);
    assert!(inline.starts_with(&payload.preview) && inline.contains("[Preview only") && inline.contains(&payload.path));
    assert!(spool::inline_or_file(&store.root, "../escape", "answer", text).is_err());
}

#[test]
fn nested_handoff_runs_in_the_slot_its_waiting_parent_frees() {
    let (_temp, store, _grant) = fixture();
    let cli = Path::new(CLI);
    owner_api(&store, "limits-set", &json!({"concurrent":1}), cli).unwrap();
    ask(&store, "parent", "codex-fixture", None).unwrap();
    running(&store, "parent", "parent-capability");
    ask(&store, "child", "claude-fixture", Some("parent")).unwrap();
    dispatch(&store, cli).unwrap();
    let request = owner_api(&store, "request", &json!({"id":"child"}), cli).unwrap();
    assert_eq!(request["queued_reason"], "waiting for a free slot (active 1 of 1)");
    let waiter = store.clone();
    let waiting = std::thread::spawn(move || wait_for(&waiter, "parent", "parent-capability", "child", 20));
    until(|| store.read().unwrap().requests["parent"].waiting_on.as_deref() == Some("child"));
    let limits = owner_api(&store, "status", &json!({}), cli).unwrap()["limits"].clone();
    assert_eq!((&limits["active"], &limits["waiting"], &limits["queued"]), (&json!(0), &json!(1), &json!(1)));
    assert_eq!(limits["concurrent"], 1);
    // The child takes the freed slot. This fixture CLI cannot start, so the
    // claimed child stops as needs-owner and the parent's wait returns.
    dispatch(&store, cli).unwrap();
    let result = waiting.join().unwrap().unwrap();
    assert_eq!(result["timed_out"], false);
    let state = store.read().unwrap();
    assert!(state.requests["child"].events.iter().any(|e| e.kind == "dispatch-claimed"));
    assert_eq!(state.requests["parent"].waiting_on, None);
    assert_eq!(scheduler::counts(&state), scheduler::Counts { active: 1, waiting: 0, queued: 0 });
}

#[test]
fn cross_tree_wait_cycles_are_refused_before_they_deadlock() {
    let (_temp, store, _grant) = fixture();
    ask(&store, "p1", "codex-fixture", None).unwrap();
    running(&store, "p1", "cap-one");
    ask(&store, "p2", "claude-fixture", None).unwrap();
    running(&store, "p2", "cap-two");
    ask(&store, "c1", "claude-fixture", Some("p1")).unwrap();
    ask(&store, "c2", "codex-fixture", Some("p2")).unwrap();
    // p1 waits on c1, which queues behind p2 on claude-fixture.
    store.transaction(|s| { s.requests.get_mut("p1").unwrap().waiting_on = Some("c1".into()); Ok(()) }).unwrap();
    // p2 waiting on c2 (queued behind p1) would close p2 → c2 → p1 → c1 → p2.
    let error = wait_for(&store, "p2", "cap-two", "c2", 20).unwrap_err().to_string();
    assert_eq!(error, "CYCLE: p2 → c2 → p1 → c1 → p2 ; answer from your own context or ask a different peer");
    assert_eq!(store.read().unwrap().requests["p2"].waiting_on, None);
    // A new child that could only run after its own parent is refused before creation.
    let error = ask(&store, "c3", "codex-fixture", Some("p2")).unwrap_err().to_string();
    assert_eq!(error, "CYCLE: p2 → c3 → p1 → c1 → p2 ; answer from your own context or ask a different peer");
    let error = ask(&store, "self", "codex-fixture", Some("p1")).unwrap_err().to_string();
    assert!(error.starts_with("CYCLE: p1 → self → p1 ;"));
    let state = store.read().unwrap();
    assert!(!state.requests.contains_key("c3") && !state.requests.contains_key("self"));
    let c1 = owner_api(&store, "request", &json!({"id":"c1"}), Path::new(CLI)).unwrap();
    assert_eq!(c1["queued_reason"], "endpoint claude-fixture busy with request p2");
}

#[test]
fn cancelling_a_waiting_parent_ends_its_wait_and_its_priority() {
    let (_temp, store, _grant) = fixture();
    // Same-second ties fall back to ID order, so "a-older" is the oldest either way.
    ask(&store, "a-older", "claude-fixture", None).unwrap();
    ask(&store, "parent", "codex-fixture", None).unwrap();
    running(&store, "parent", "parent-capability");
    ask(&store, "z-child", "claude-fixture", Some("parent")).unwrap();
    assert_eq!(scheduler::pick(&store.read().unwrap(), Unlimited).as_deref(), Some("a-older"));
    let waiter = store.clone();
    let waiting = std::thread::spawn(move || wait_for(&waiter, "parent", "parent-capability", "z-child", 30));
    until(|| store.read().unwrap().requests["parent"].waiting_on.is_some());
    // A child that a waiting parent needs goes first.
    assert_eq!(scheduler::pick(&store.read().unwrap(), Unlimited).as_deref(), Some("z-child"));
    let started = std::time::Instant::now();
    owner_api(&store, "cancel", &json!({"id":"parent"}), Path::new(CLI)).unwrap();
    let error = waiting.join().unwrap().unwrap_err().to_string();
    assert!(error.contains("no longer active") && started.elapsed() < Duration::from_secs(10));
    let state = store.read().unwrap();
    // Cancellation does not manufacture a free running slot. The worker will
    // clear this yielded state when it records its terminal outcome.
    assert_eq!(state.requests["parent"].waiting_on.as_deref(), Some("z-child"));
    assert_eq!(scheduler::counts(&state).waiting, 1);
    assert_eq!(scheduler::pick(&state, Unlimited).as_deref(), Some("a-older"));
}

#[test]
fn a_waiting_parent_cannot_resume_past_a_finite_limit() {
    let (_temp, store, _grant) = fixture();
    let cli = Path::new(CLI);
    owner_api(&store, "limits-set", &json!({"concurrent":1}), cli).unwrap();
    ask(&store, "parent", "codex-fixture", None).unwrap();
    running(&store, "parent", "parent-capability");
    ask(&store, "child", "claude-fixture", Some("parent")).unwrap();
    // The parent waits, and the child runs in the slot it freed.
    store.transaction(|s| { s.requests.get_mut("parent").unwrap().waiting_on = Some("child".into()); Ok(()) }).unwrap();
    running(&store, "child", "child-capability");
    // A wait that times out while the child runs keeps the parent waiting.
    let result = wait_for(&store, "parent", "parent-capability", "child", 0).unwrap();
    assert_eq!(result["timed_out"], true);
    assert_eq!(store.read().unwrap().requests["parent"].waiting_on.as_deref(), Some("child"));
    // Other work from the parent is refused while the only slot is busy, uncounted.
    let used = store.read().unwrap().requests["parent"].mcp_calls_used();
    let error = mcp::call(&store, "parent", "parent-capability", cli, "list_files", &json!({})).unwrap_err().to_string();
    assert!(error.starts_with("SLOT_BUSY"), "{error}");
    // `messages` is a poll and keeps the parent waiting.
    let polled = mcp::call(&store, "parent", "parent-capability", cli, "messages", &json!({"id":"child"}));
    assert!(polled.as_ref().err().is_none_or(|e| !e.to_string().starts_with("SLOT_BUSY")));
    let state = store.read().unwrap();
    assert_eq!(state.requests["parent"].waiting_on.as_deref(), Some("child"));
    assert_eq!(state.requests["parent"].mcp_calls_used(), used);
    assert_eq!(scheduler::counts(&state), scheduler::Counts { active: 1, waiting: 1, queued: 0 });
    drop(state);
    // Completion makes a slot available; resumption must still claim it.
    store.transaction(|s| { s.requests.get_mut("child").unwrap().transition("completed", json!({})); Ok(()) }).unwrap();
    assert_eq!(scheduler::counts(&store.read().unwrap()).active, 0);
    // Authorization succeeds now; the fixture's tool body itself may fail.
    let after = mcp::call(&store, "parent", "parent-capability", cli, "list_files", &json!({}));
    assert!(after.as_ref().err().is_none_or(|e| !e.to_string().starts_with("SLOT_BUSY")));
    let state = store.read().unwrap();
    assert_eq!(state.requests["parent"].waiting_on, None);
    assert_eq!(state.requests["parent"].mcp_calls_used(), used + 1);
    assert_eq!(scheduler::counts(&state), scheduler::Counts { active: 1, waiting: 0, queued: 0 });
}

#[test]
fn shared_terminal_descendant_does_not_resume_multiple_waiters_into_one_slot() {
    let (_temp, store, _grant) = fixture();
    policy::api(&store.root, "limits-set", &json!({"concurrent":1})).unwrap();
    store.transaction(|s| {
        let mut ep = s.endpoints["codex-fixture"].clone();
        ep.id = "third-fixture".into();
        s.endpoints.insert(ep.id.clone(), ep);
        s.grants.get_mut("grant-fixture").unwrap().targets.push("third-fixture".into());
        Ok(())
    }).unwrap();
    ask(&store, "a", "codex-fixture", None).unwrap();
    running(&store, "a", "cap-a");
    ask(&store, "b", "claude-fixture", Some("a")).unwrap();
    wait_for(&store, "a", "cap-a", "b", 0).unwrap();
    running(&store, "b", "cap-b");
    ask(&store, "c", "third-fixture", Some("b")).unwrap();
    wait_for(&store, "b", "cap-b", "c", 0).unwrap();
    running(&store, "c", "cap-c");
    wait_for(&store, "a", "cap-a", "c", 0).unwrap();
    assert_eq!(scheduler::counts(&store.read().unwrap()).active, 1);
    store.transaction(|s| { s.requests.get_mut("c").unwrap().transition("completed", json!({})); Ok(()) }).unwrap();
    assert_eq!(scheduler::counts(&store.read().unwrap()).active, 0);
    assert_eq!(wait_for(&store, "a", "cap-a", "c", 0).unwrap()["timed_out"], false);
    assert!(wait_for(&store, "b", "cap-b", "c", 0).unwrap_err().to_string().starts_with("SLOT_BUSY"));
    assert!(mcp::call(&store, "b", "cap-b", Path::new(CLI), "get_context", &json!({})).unwrap_err().to_string().starts_with("SLOT_BUSY"));
    let state = store.read().unwrap();
    assert_eq!(scheduler::counts(&state).active, 1);
    assert_eq!(state.requests["b"].waiting_on.as_deref(), Some("c"));
    store.transaction(|s| { s.requests.get_mut("a").unwrap().transition("completed", json!({})); Ok(()) }).unwrap();
    assert_eq!(wait_for(&store, "b", "cap-b", "c", 0).unwrap()["timed_out"], false);
    assert_eq!(scheduler::counts(&store.read().unwrap()).active, 1);
}

#[test]
fn migration_waits_for_a_running_0_4_worker_and_never_relaunches_it() {
    let (_temp, store, grant) = fixture();
    let cli = Path::new(CLI);
    let state_file = store.root.join("state.json");
    // A 0.4-shaped board: a legacy grant, a claimed running request and a finished one.
    let legacy_request = |id: &str, state: &str, claim: Option<&str>, answer: Option<&str>| Request {
        id: id.into(), digest: format!("digest-{id}"), grant_id: "legacy-grant".into(), target: "codex-fixture".into(),
        kind: "question".into(), prompt: "0.4 fixture".into(), expected_result: "0.4 fixture".into(), origin: "owner".into(),
        origin_session: None, parent_id: None, root_id: id.into(), hop: 0, state: state.into(), created_at: now(),
        updated_at: now(), workspace: None, session_id: None, answer: answer.map(String::from),
        receipt: answer.map(|_| json!({"stop_reason":"completed"})), blocker: None, cancel_requested: false,
        worker_claim: claim.map(String::from), capability_hash: String::new(), events: vec![], spark_jobs: vec![],
        next_seq: None, events_total: None, mcp_calls_used: None, spilled_through: None, spilled_bytes: None,
        waiting_on: None, payloads: Default::default(), context_read_spilled: false, touched: false,
    };
    let mut board = serde_json::to_value(store.read().unwrap()).unwrap();
    board["schema_version"] = json!(1);
    board["grants"] = json!({"legacy-grant": legacy_grant_json(&grant.project)});
    board["requests"] = json!({
        "old": legacy_request("old", "running", Some("claim-old"), None),
        "done": legacy_request("done", "completed", None, Some("finished under 0.4")),
    });
    fs::write(&state_file, serde_json::to_vec_pretty(&board).unwrap()).unwrap();
    assert_eq!(store.read().unwrap().schema_version, 1);
    // The 0.4 worker for "old" is alive: it holds its worker lock.
    let worker = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true)
        .open(store.root.join("worker-old.lock")).unwrap();
    worker.try_lock_exclusive().unwrap();
    // 0.4-compatible writes still work, so the old worker can finish.
    owner_api(&store, "pause", &json!({"paused":true}), cli).unwrap();
    assert_eq!(store.read().unwrap().schema_version, 1);
    // The installed new CLI can request cancellation without migrating beneath
    // the old worker. Its old reader still sees the original event/record shape.
    owner_api(&store, "cancel", &json!({"id":"old"}), cli).unwrap();
    let cancelled = store.read().unwrap();
    assert_eq!(cancelled.schema_version, 1);
    assert!(cancelled.requests["old"].cancel_requested);
    assert!(!cancelled.has_current_data());
    assert!(cancelled.requests["old"].events.iter().any(|e| e.kind == "cancel-requested"));
    let before = fs::read(&state_file).unwrap();
    // A write that needs schema 3 is refused and changes nothing.
    let side_effect = store.root.join("must-not-be-created");
    let error = store.transaction(|s| { fs::write(&side_effect, b"callback ran")?; s.grants.insert(grant.id.clone(), grant.clone()); Ok(()) }).unwrap_err().to_string();
    assert!(error.starts_with("MIGRATION_BUSY: request old"), "{error}");
    assert!(!side_effect.exists());
    assert_eq!(fs::read(&state_file).unwrap(), before);
    assert!(!store.root.join("state.schema1.backup.json").exists());
    // The worker ends without a receipt; migration reconciles it in the same write.
    drop(worker);
    store.transaction(|s| {
        // The migration owns the free worker lease before running its callback:
        // an old dispatch that has claimed but not spawned cannot enter now.
        let late_worker = fs::OpenOptions::new().read(true).write(true).open(store.root.join("worker-old.lock"))?;
        assert!(late_worker.try_lock_exclusive().is_err());
        s.grants.insert(grant.id.clone(), grant.clone()); s.paused = false; Ok(())
    }).unwrap();
    assert_eq!(fs::read(store.root.join("state.schema1.backup.json")).unwrap(), before);
    let state = store.read().unwrap();
    assert_eq!(state.schema_version, 3);
    let old = &state.requests["old"];
    assert_eq!(old.state, "needs-owner");
    assert!(old.blocker.as_deref().unwrap().contains("Not relaunched"));
    assert_eq!(old.worker_claim.as_deref(), Some("claim-old"));
    let done = &state.requests["done"];
    assert_eq!((done.state.as_str(), done.answer.as_deref()), ("completed", Some("finished under 0.4")));
    assert_eq!(done.receipt, Some(json!({"stop_reason":"completed"})));
    drop(state);
    // Dispatch never relaunches the original request ID.
    dispatch(&store, cli).unwrap();
    let old = &store.read().unwrap().requests["old"];
    assert!(!old.events.iter().any(|e| e.kind == "dispatch-claimed"));
    assert_eq!(old.state, "needs-owner");
}
