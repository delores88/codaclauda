//! Regression tests for local authority and durability boundaries.
//! Fixtures never launch provider sessions and are not acceptance evidence.
use super::*;

#[cfg(windows)]
#[test]
fn git_windows_worktree_accepts_canonical_and_rejects_overlong_destination() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("source repo");
    fs::create_dir(&repository).unwrap();
    let repository = repository.canonicalize().unwrap();
    git(&repository, &["init", "--quiet"]).unwrap();
    fs::write(repository.join("baseline.txt"), "unchanged baseline").unwrap();
    git(&repository, &["add", "baseline.txt"]).unwrap();
    git(
        &repository,
        &[
            "-c",
            "user.name=CodaClauda Unit Test",
            "-c",
            "user.email=unit@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=",
            "commit",
            "--quiet",
            "-m",
            "Isolated worktree baseline",
        ],
    )
    .unwrap();
    let destination = temp
        .path()
        .canonicalize()
        .unwrap()
        .join("canonical worktree");
    assert!(destination.to_str().unwrap().starts_with(r"\\?\"));
    add_worktree(&repository, &destination).unwrap();
    assert_eq!(
        fs::read_to_string(destination.join("baseline.txt")).unwrap(),
        "unchanged baseline"
    );
    let parent = temp.path().canonicalize().unwrap();
    let padding = 215 - paths::git_argument(&parent).unwrap().len() - "/b215".len() - 1;
    let boundary_parent = parent.join("p".repeat(padding));
    fs::create_dir(&boundary_parent).unwrap();
    let boundary = boundary_parent.join("b215");
    assert_eq!(paths::git_argument(&boundary).unwrap().len(), 215);
    add_worktree(&repository, &boundary).unwrap();
    let one_too_long = boundary_parent.join("b216x");
    assert_eq!(paths::git_argument(&one_too_long).unwrap().len(), 216);
    assert!(
        add_worktree(&repository, &one_too_long)
            .unwrap_err()
            .to_string()
            .contains("choose a shorter CodaClauda state directory")
    );
    assert!(!one_too_long.exists());
    let mut long_parent = temp.path().canonicalize().unwrap();
    for _ in 0..5 {
        long_parent.push("long-worktree-parent-segment-0123456789abcdef");
    }
    fs::create_dir_all(&long_parent).unwrap();
    let long_destination = long_parent.join("long destination");
    assert!(long_destination.to_str().unwrap().len() > 260);
    let error = add_worktree(&repository, &long_destination).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("choose a shorter CodaClauda state directory")
    );
    assert!(!long_destination.exists());
    assert_eq!(git(&repository, &["status", "--porcelain"]).unwrap(), "");
    git(
        &repository,
        &[
            "worktree",
            "remove",
            &paths::git_argument(&boundary).unwrap(),
        ],
    )
    .unwrap();
    git(
        &repository,
        &[
            "worktree",
            "remove",
            &paths::git_argument(&destination).unwrap(),
        ],
    )
    .unwrap();
}

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
        max_requests: Finite(16),
        max_delegations: Finite(4),
        max_hops: Finite(3),
        timeout_seconds: Finite(60),
        expires_at: Finite(now() + 300),
        compute: vec![],
        max_turns: Finite(200),
        max_mcp_calls: Unlimited,
        max_compute_jobs: Unlimited,
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

fn input(id: &str, grant: &Grant) -> Value {
    json!({"id":id,"grant_id":grant.id,"target":"codex-fixture","kind":"question","prompt":"Inspect the authorized fixture"})
}

#[test]
fn request_retry_survives_store_reopen_without_duplicate_work() {
    let (_temp, store, grant) = fixture();
    let original = submit(&store, &input("retry-one", &grant), None).unwrap();
    let reopened = Store::new(Some(store.root.clone())).unwrap();
    let repeated = submit(&reopened, &input("retry-one", &grant), None).unwrap();
    assert_eq!(original.digest, repeated.digest);
    assert_eq!(reopened.read().unwrap().requests.len(), 1);
    let mut changed = input("retry-one", &grant);
    changed["prompt"] = json!("Different work must use a different identity");
    assert!(
        submit(&reopened, &changed, None)
            .unwrap_err()
            .to_string()
            .contains("ID_CONFLICT")
    );
    assert_eq!(reopened.read().unwrap().requests.len(), 1);
}

#[test]
fn cancellation_rejects_stale_descendant_submission_and_preserves_other_roots() {
    let (_temp, store, grant) = fixture();
    let parent = submit(&store, &input("parent-one", &grant), None).unwrap();
    let unrelated = submit(&store, &input("other-root", &grant), None).unwrap();
    let child = submit(&store, &input("child-one", &grant), Some(&parent.id)).unwrap();
    cancel(&store, &parent.id, true).unwrap();
    assert!(submit(&store, &input("late-child", &grant), Some(&parent.id)).is_err());
    assert!(submit(&store, &input("late-grandchild", &grant), Some(&child.id)).is_err());
    let state = store.read().unwrap();
    assert_eq!(state.requests[&parent.id].state, "cancelled");
    assert_eq!(state.requests[&child.id].state, "cancelled");
    assert_eq!(state.requests[&unrelated.id].state, "queued");
    assert!(!state.requests[&unrelated.id].cancel_requested);
    assert_eq!(state.requests.len(), 3);
}

#[test]
fn incoming_handoff_cannot_impersonate_origin_or_change_its_grant() {
    let (_temp, store, grant) = fixture();
    let parent = submit(&store, &input("bound-parent", &grant), None).unwrap();
    store
        .transaction(|state| {
            state.requests.get_mut(&parent.id).unwrap().session_id =
                Some("unit-fixture-session".into());
            Ok(())
        })
        .unwrap();
    let mut handoff = input("bound-child", &grant);
    handoff["origin"] = json!("owner");
    handoff["origin_session"] = json!("spoofed-session");
    handoff["grant_id"] = json!("spoofed-grant");
    let child = submit(&store, &handoff, Some(&parent.id)).unwrap();
    assert_eq!(child.origin, "codex-fixture");
    assert_eq!(
        child.origin_session.as_deref(),
        Some("unit-fixture-session")
    );
    assert_eq!(child.grant_id, grant.id);
    assert_eq!(child.parent_id.as_deref(), Some(parent.id.as_str()));
}

#[test]
fn interrupted_claim_needs_owner_and_is_never_automatically_dispatched_again() {
    let (_temp, store, grant) = fixture();
    let request = submit(&store, &input("interrupted-one", &grant), None).unwrap();
    store
        .transaction(|state| {
            let request = state.requests.get_mut(&request.id).unwrap();
            request.worker_claim = Some("unit-fixture-claim".into());
            request.state = "running".into();
            request.updated_at = now().saturating_sub(120);
            Ok(())
        })
        .unwrap();
    recover(&store).unwrap();
    dispatch(&store, Path::new("must-never-be-launched.exe")).unwrap();
    let state = store.read().unwrap();
    let recovered = &state.requests[&request.id];
    assert_eq!(recovered.state, "needs-owner");
    assert_eq!(
        recovered.worker_claim.as_deref(),
        Some("unit-fixture-claim")
    );
    assert!(
        recovered
            .events
            .iter()
            .all(|event| event.kind != "dispatch-claimed")
    );
}

#[test]
fn mcp_peer_submission_only_queues_outside_provider_process_lifecycle() {
    let (_temp, store, grant) = fixture();
    let parent = submit(&store, &input("mcp-parent", &grant), None).unwrap();
    let capability = "unit-fixture-capability";
    store
        .transaction(|state| {
            let request = state.requests.get_mut(&parent.id).unwrap();
            request.capability_hash = hash(capability);
            request.workspace = Some(grant.project.clone());
            request.state = "running".into();
            request.worker_claim = Some("unit-fixture-worker".into());
            Ok(())
        })
        .unwrap();
    mcp::call(&store, &parent.id, capability, Path::new("must-never-be-launched.exe"), "ask",
        &json!({"id":"queued-peer","target":"claude-fixture","prompt":"Read-only unit fixture question"})).unwrap();
    let state = store.read().unwrap();
    let peer = &state.requests["queued-peer"];
    assert_eq!(peer.state, "queued");
    assert!(peer.worker_claim.is_none());
    assert!(peer.capability_hash.is_empty());
}

#[test]
fn json_credentials_and_private_key_blocks_are_removed_before_exposure() {
    let content = r#"{"password":"unit-fixture-password","api_key":"unit-fixture-key","refresh_token":"unit-fixture-token"}"#;
    let redacted = redact(content);
    for value in [
        "unit-fixture-password",
        "unit-fixture-key",
        "unit-fixture-token",
    ] {
        assert!(!redacted.contains(value));
    }
    let pem = [
        "-----BEGIN ",
        "PRIVATE KEY-----\nunit-fixture-only\n-----END ",
        "PRIVATE KEY-----",
    ]
    .concat();
    assert!(!redact(&pem).contains("unit-fixture-only"));
}

#[test]
fn delegation_from_repository_subdirectory_is_rejected_before_worktree_creation() {
    let (temp, store, _grant) = fixture();
    let repository = temp.path().join("git-fixture");
    fs::create_dir(&repository).unwrap();
    git(&repository, &["init", "--quiet"]).unwrap();
    git(
        &repository,
        &[
            "-c",
            "user.name=CodaClauda Unit Test",
            "-c",
            "user.email=unit@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=",
            "commit",
            "--allow-empty",
            "--quiet",
            "-m",
            "Unit fixture only",
        ],
    )
    .unwrap();
    let subdirectory = repository.join("subdirectory");
    fs::create_dir(&subdirectory).unwrap();
    let error = create_grant(
        &store,
        &json!({"project":subdirectory,"allowed_paths":["a.rs"],
        "targets":["codex-fixture"],"kinds":["delegate"],"expected_result":"Unit fixture only"}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("repository root"));
    assert!(!store.root.join("worktrees").exists());
}

fn cancelled_spark_fixture(known_job: bool) -> (tempfile::TempDir, Store, String) {
    let (temp, store, grant) = fixture();
    let request = submit(&store, &input("cancel-spark-fixture", &grant), None).unwrap();
    store
        .transaction(|state| {
            state.spark = Some("unlaunched-unit-fixture.exe".into());
            let request = state.requests.get_mut(&request.id).unwrap();
            request.cancel_requested = true;
            request.spark_jobs.push(
                json!({"request_id":"local-fixture-id", "provider_request_id":"provider-fixture-id",
            "job":if known_job {json!("owned-job-fixture")} else {Value::Null}, "state":"unknown"}),
            );
            Ok(())
        })
        .unwrap();
    (temp, store, request.id)
}

#[test]
fn unknown_cancellation_never_runs_work_and_retries_when_job_becomes_known() {
    let (_temp, store, request) = cancelled_spark_fixture(false);
    cancel_owned_spark_with(&store, &request, |_, _, _, _| {
        panic!("Unknown jobs must not invoke a provider operation")
    })
    .unwrap();
    assert_eq!(
        store.read().unwrap().requests[&request].spark_jobs[0]["cancellation"]["cancel_pending"],
        true
    );
    store
        .transaction(|state| {
            state.requests.get_mut(&request).unwrap().spark_jobs[0]["job"] =
                json!("owned-job-fixture");
            Ok(())
        })
        .unwrap();
    let mut calls = 0;
    cancel_owned_spark_with(&store, &request, |_, _, job, _| {
        calls += 1;
        assert_eq!(job, "owned-job-fixture");
        Ok(json!({"ok":true,"job":job,"state":"cancelled"}))
    })
    .unwrap();
    assert_eq!(calls, 1);
    cancel_owned_spark_with(&store, &request, |_, _, _, _| {
        panic!("Confirmed terminal cancellation must not be repeated")
    })
    .unwrap();
}

#[test]
fn failed_and_pending_spark_cancellations_remain_retryable() {
    let (_temp, store, request) = cancelled_spark_fixture(true);
    cancel_owned_spark_with(&store, &request, |_, _, _, _| {
        Err(anyhow::anyhow!("synthetic transport error"))
    })
    .unwrap();
    assert_eq!(
        store.read().unwrap().requests[&request].spark_jobs[0]["cancellation"]["cancel_pending"],
        true
    );
    let mut calls = 0;
    cancel_owned_spark_with(&store, &request, |_, _, job, _| {
        calls += 1;
        Ok(json!({"ok":true,"job":job,"state":"cancel_pending"}))
    })
    .unwrap();
    cancel_owned_spark_with(&store, &request, |_, _, job, _| {
        calls += 1;
        Ok(json!({"ok":true,"job":job,"state":"cancelled"}))
    })
    .unwrap();
    assert_eq!(calls, 2);
    assert_eq!(
        store.read().unwrap().requests[&request].spark_jobs[0]["cancellation"]["state"],
        "cancelled"
    );
}

#[test]
fn spark_receipts_omit_raw_log_encoding_and_preserve_usage_and_cursors() {
    let cleaned = sanitized_spark(&json!({"ok":true,"password":"unit-fixture-password",
        "nested":{"access_token":"unit-fixture-access", "private_key":"unit-fixture-private"},
        "usage":{"input_tokens":123,"output_tokens":17,"total_tokens":140,"token":140},
        "data":"dW5pdC1maXh0dXJlLW9ubHk=", "text":"password=unit-fixture-log", "since":10, "next_offset":41}));
    assert!(cleaned.get("data").is_none());
    assert_eq!(cleaned["raw_data_withheld"], true);
    assert_eq!(cleaned["password"], "[REDACTED]");
    assert_eq!(cleaned["nested"]["access_token"], "[REDACTED]");
    assert_eq!(cleaned["nested"]["private_key"], "[REDACTED]");
    assert!(
        !cleaned["text"]
            .as_str()
            .unwrap()
            .contains("unit-fixture-log")
    );
    assert_eq!(
        cleaned["usage"],
        json!({"input_tokens":123,"output_tokens":17,"total_tokens":140,"token":140})
    );
    assert_eq!(cleaned["since"], 10);
    assert_eq!(cleaned["next_offset"], 41);
}

#[test]
fn scoped_context_read_is_recorded_only_after_authorized_context_generation() {
    let (_temp, store, grant) = fixture();
    let parent = submit(&store, &input("context-fixture", &grant), None).unwrap();
    let capability = "unit-context-capability";
    store
        .transaction(|state| {
            let request = state.requests.get_mut(&parent.id).unwrap();
            request.capability_hash = hash(capability);
            request.workspace = Some(grant.project.clone());
            request.state = "running".into();
            request.worker_claim = Some("unit-context-worker".into());
            Ok(())
        })
        .unwrap();
    let cli = Path::new("must-never-be-launched.exe");
    assert!(
        mcp::call(
            &store,
            &parent.id,
            "incorrect-fixture",
            cli,
            "get_context",
            &json!({})
        )
        .is_err()
    );
    assert!(
        store.read().unwrap().requests[&parent.id]
            .events
            .iter()
            .all(|event| event.kind != "context-read")
    );
    mcp::call(
        &store,
        &parent.id,
        capability,
        cli,
        "get_context",
        &json!({}),
    )
    .unwrap();
    assert_eq!(
        store.read().unwrap().requests[&parent.id]
            .events
            .iter()
            .filter(|event| event.kind == "context-read")
            .count(),
        1
    );
    cancel(&store, &parent.id, false).unwrap();
    assert!(
        mcp::call(
            &store,
            &parent.id,
            capability,
            cli,
            "get_context",
            &json!({})
        )
        .is_err()
    );
    assert_eq!(
        store.read().unwrap().requests[&parent.id]
            .events
            .iter()
            .filter(|event| event.kind == "context-read")
            .count(),
        1
    );
}

#[test]
fn legacy_endpoint_labels_are_readable_without_rewriting_saved_authority() {
    let (_temp, store, _) = fixture();
    let state_file = store.root.join("state.json");
    let before = fs::read(&state_file).unwrap();
    let legacy: Value = serde_json::from_slice(&before).unwrap();
    assert!(legacy["endpoints"]["codex-fixture"].get("label").is_none());
    let decoded: Endpoint =
        serde_json::from_value(legacy["endpoints"]["codex-fixture"].clone()).unwrap();
    assert!(decoded.label.is_none());
    let status = owner_api(&store, "status", &json!({}), Path::new("unused")).unwrap();
    let endpoints = status["endpoints"].as_array().unwrap();
    assert_eq!(
        endpoints
            .iter()
            .find(|e| e["id"] == "codex-fixture")
            .unwrap()["label"],
        "Codex · project"
    );
    assert_eq!(
        endpoints
            .iter()
            .find(|e| e["id"] == "claude-fixture")
            .unwrap()["label"],
        "Claude Code · project"
    );
    assert_eq!(fs::read(state_file).unwrap(), before);
    let mut windows_legacy = decoded;
    windows_legacy.workspace = r"\\?\C:\projects\Example App\".into();
    assert_eq!(
        effective_endpoint_label(&windows_legacy),
        "Codex · Example App"
    );
    windows_legacy.workspace = "/".into();
    assert_eq!(
        effective_endpoint_label(&windows_legacy),
        "Codex · codex-fixture"
    );
}

#[test]
fn endpoint_labels_validate_before_connect_probe_and_rename_preserves_authority() {
    let (_temp, store, grant) = fixture();
    submit(&store, &input("labeled-active", &grant), None).unwrap();
    let cli = Path::new("must-never-be-launched.exe");
    let before = serde_json::to_value(store.read().unwrap()).unwrap();
    for label in [
        "".to_owned(),
        "   ".into(),
        "a".repeat(121),
        "Reviewer\nAdmin".into(),
        "Reviewer\tRole".into(),
        "Reviewer\u{0085}Role".into(),
        "password=unit-fixture-secret".into(),
        "sk-unit-fixture-only-value".into(),
    ] {
        let invalid = json!({"id":"codex-fixture","label":label,"dedicated_session_consent":true});
        // Missing executable/agent is deliberate: labels must fail before probing.
        let error = owner_api(&store, "connect", &invalid, cli)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("Label"),
            "unexpected connect validation: {error}"
        );
        assert!(owner_api(&store, "rename-agent", &invalid, cli).is_err());
        assert_eq!(serde_json::to_value(store.read().unwrap()).unwrap(), before);
    }
    for label in [Value::Null, json!(5), json!(["Reviewer"])] {
        let error = owner_api(
            &store,
            "connect",
            &json!({"label":label,"dedicated_session_consent":true}),
            cli,
        )
        .unwrap_err();
        assert!(error.to_string().contains("Label must be text"));
    }
    let result = owner_api(
        &store,
        "rename-agent",
        &json!({"id":"codex-fixture","label":"  Fixture reviewer  "}),
        cli,
    )
    .unwrap();
    assert_eq!(result["label"], "Fixture reviewer");
    assert_eq!(result["id"], "codex-fixture");
    let mut expected = before;
    expected["endpoints"]["codex-fixture"]["label"] = json!("Fixture reviewer");
    assert_eq!(
        serde_json::to_value(store.read().unwrap()).unwrap(),
        expected
    );
    assert_eq!(
        validate_endpoint_label(&"界".repeat(120))
            .unwrap()
            .chars()
            .count(),
        120
    );
    assert!(
        owner_api(
            &store,
            "rename-agent",
            &json!({"id":"unknown","label":"Reviewer"}),
            cli
        )
        .is_err()
    );
}

#[test]
fn scoped_label_directory_maps_real_session_fields_and_routes_only_by_id() {
    let (_temp, store, grant) = fixture();
    let parent = submit(&store, &input("directory-parent", &grant), None).unwrap();
    let mut peer_input = input("directory-peer", &grant);
    peer_input["target"] = json!("claude-fixture");
    let peer = submit(&store, &peer_input, Some(&parent.id)).unwrap();
    let capability = "unit-label-capability";
    store
        .transaction(|state| {
            for endpoint in state.endpoints.values_mut() {
                endpoint.label = Some("Reviewer".into());
            }
            let mut foreign_endpoint = state.endpoints["codex-fixture"].clone();
            foreign_endpoint.id = "foreign-endpoint".into();
            foreign_endpoint.label = Some("Private unrelated role".into());
            state
                .endpoints
                .insert(foreign_endpoint.id.clone(), foreign_endpoint);
            let mut foreign_grant = grant.clone();
            foreign_grant.id = "foreign-grant".into();
            foreign_grant.targets = vec!["foreign-endpoint".into()];
            state.grants.insert(foreign_grant.id.clone(), foreign_grant);
            let r = state.requests.get_mut(&parent.id).unwrap();
            r.workspace = Some(grant.project.clone());
            r.capability_hash = hash(capability);
            r.session_id = Some("unit-actual-codex-session".into());
            r.state = "running".into();
            state.requests.get_mut(&peer.id).unwrap().session_id =
                Some("unit-actual-claude-session".into());
            Ok(())
        })
        .unwrap();
    submit(&store, &json!({"id":"foreign-request","grant_id":"foreign-grant","target":"foreign-endpoint","kind":"question","prompt":"Unrelated owner work"}), None).unwrap();
    let cli = Path::new("must-never-be-launched.exe");
    let context = mcp::call(
        &store,
        &parent.id,
        capability,
        cli,
        "get_context",
        &json!({}),
    )
    .unwrap();
    let directory = context["endpoints"].as_array().unwrap();
    assert_eq!(directory.len(), 2);
    assert!(directory.iter().all(|e| e["label"] == "Reviewer"));
    assert!(directory.iter().all(|e| e["id"] != "foreign-endpoint"));
    let peers = context["peer_requests"].as_array().unwrap();
    assert_eq!(peers.len(), 2);
    let linked = peers.iter().find(|p| p["id"] == peer.id).unwrap();
    assert_eq!(linked["target"], "claude-fixture");
    assert_eq!(linked["target_label"], "Reviewer");
    assert_eq!(linked["session_id"], "unit-actual-claude-session");
    assert!(!context.to_string().contains("Private unrelated role"));
    assert!(!context.to_string().contains("foreign-request"));
    let wrong = mcp::call(&store, &parent.id, capability, cli, "ask", &json!({"id":"label-routing-refused","target":"Reviewer","prompt":"Do not resolve a duplicate display label"})).unwrap_err();
    assert!(wrong.to_string().contains("OWNER_SCOPE"));
    assert!(
        !store
            .read()
            .unwrap()
            .requests
            .contains_key("label-routing-refused")
    );
    let routed = mcp::call(&store, &parent.id, capability, cli, "ask", &json!({"id":"stable-id-routed","target":"claude-fixture","prompt":"Use the granted stable endpoint ID"})).unwrap();
    assert_eq!(routed["target"], "claude-fixture");
    assert_eq!(routed["origin_session"], "unit-actual-codex-session");
    assert!(
        mcp::call(
            &store,
            &parent.id,
            capability,
            cli,
            "rename-agent",
            &json!({"id":"claude-fixture","label":"Agent-changed role"})
        )
        .is_err()
    );
    assert_eq!(
        store.read().unwrap().endpoints["claude-fixture"]
            .label
            .as_deref(),
        Some("Reviewer")
    );
}

fn question_grant(store: &Store, project: &str, extra: Value) -> Result<Value> {
    let mut spec = json!({"project":project,"allowed_paths":["src"],"targets":["codex-fixture"],
        "kinds":["question"],"expected_result":"Unit fixture only"});
    spec.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    create_grant(store, &spec)
}

#[test]
fn new_grants_inherit_owner_defaults_and_keep_them_when_policy_changes() {
    let (_temp, store, grant) = fixture();
    let cli = Path::new("must-never-be-launched.exe");
    let made = question_grant(&store, &grant.project, json!({})).unwrap();
    assert_eq!(made["policy_version"], 1);
    assert_eq!(made["timeout_seconds"], 86_400);
    for field in ["max_requests", "max_delegations", "max_hops", "max_turns", "max_mcp_calls", "max_compute_jobs"] {
        assert_eq!(made[field], "unlimited", "{field}");
        assert_eq!(made["effective"][field], "unlimited", "{field}");
    }
    assert!(made["expires_at"].as_u64().unwrap() >= now() + 604_800 - 5);
    assert!(made["revoked_at"].is_null());
    let never = question_grant(&store, &grant.project, json!({"expires_seconds":"never","max_turns":0}));
    assert!(never.unwrap_err().to_string().contains("max_turns must be a whole number from 1"));
    let never = question_grant(&store, &grant.project, json!({"expires_seconds":"never","max_delegations":0})).unwrap();
    assert_eq!((&never["expires_at"], &never["max_delegations"]), (&json!("never"), &json!(0)));
    owner_api(&store, "policy-set", &json!({"grant_defaults":{"max_turns":40,"timeout_seconds":"unlimited"}}), cli).unwrap();
    let after = question_grant(&store, &grant.project, json!({})).unwrap();
    assert_eq!((&after["max_turns"], &after["timeout_seconds"]), (&json!(40), &json!("unlimited")));
    let id = made["id"].as_str().unwrap();
    let kept = &store.read().unwrap().grants[id];
    assert_eq!((kept.max_turns, kept.timeout_seconds), (Unlimited, Finite(86_400)));
}

#[test]
fn grant_revoke_stops_queued_work_and_new_requests() {
    let (_temp, store, grant) = fixture();
    let cli = Path::new("must-never-be-launched.exe");
    submit(&store, &input("revoked-queued", &grant), None).unwrap();
    submit(&store, &input("revoked-running", &grant), None).unwrap();
    store
        .transaction(|state| {
            state.spark = Some("unlaunched-unit-fixture.exe".into());
            let r = state.requests.get_mut("revoked-running").unwrap();
            r.worker_claim = Some("unit-fixture-claim".into());
            r.state = "running".into();
            // Unknown submission outcome: cancellation records it without invoking Spark.
            r.spark_jobs.push(json!({"request_id":"build","provider_request_id":"provider-build","job":null,"state":"unknown"}));
            Ok(())
        })
        .unwrap();
    let revoked = owner_api(&store, "grant-revoke", &json!({"id":grant.id}), cli).unwrap();
    assert!(revoked["revoked_at"].is_u64());
    assert!(revoked["expires_at"].as_u64().unwrap() <= now());
    dispatch(&store, cli).unwrap();
    let state = store.read().unwrap();
    let request = &state.requests["revoked-queued"];
    assert_eq!(request.state, "needs-owner");
    assert_eq!(request.blocker.as_deref(), Some(EXPIRED));
    assert!(request.events.iter().all(|e| e.kind != "dispatch-claimed"));
    // Running work and its detached Spark jobs stop as with an owner cancel.
    let running = &state.requests["revoked-running"];
    assert!(running.cancel_requested);
    assert!(running.events.iter().any(|e| e.kind == "cancel-requested" && e.data["scope"] == "revoked"));
    assert_eq!(running.spark_jobs[0]["cancellation"]["cancel_pending"], true);
    let error = submit(&store, &input("after-revoke", &grant), None).unwrap_err();
    assert!(error.to_string().contains("expired or revoked"));
    let again = owner_api(&store, "grant-revoke", &json!({"id":grant.id}), cli).unwrap();
    assert_eq!(again["revoked_at"], revoked["revoked_at"]);
    let missing = owner_api(&store, "grant-revoke", &json!({"id":"unknown"}), cli).unwrap_err();
    assert!(missing.to_string().contains("Owner grant not found"));
}

#[test]
fn wait_omits_the_growing_event_log() {
    let (_temp, store, grant) = fixture();
    submit(&store, &input("waited", &grant), None).unwrap();
    let waited = wait(&store, "waited", 0).unwrap();
    assert_eq!(waited["timed_out"], true);
    assert!(waited["request"].get("events").is_none());
    assert_eq!(waited["request"]["events_total"], 1);
    assert_eq!(waited["request"]["state"], "queued");
}

#[test]
fn owner_concurrency_setting_gates_dispatch() {
    let (_temp, store, grant) = fixture();
    let cli = Path::new("must-never-be-launched.exe");
    assert_eq!(
        owner_api(&store, "limits", &json!({}), cli).unwrap()["concurrent"],
        "unlimited"
    );
    owner_api(&store, "limits-set", &json!({"concurrent":2}), cli).unwrap();
    for id in ["active-one", "active-two"] {
        submit(&store, &input(id, &grant), None).unwrap();
    }
    store
        .transaction(|state| {
            for id in ["active-one", "active-two"] {
                let r = state.requests.get_mut(id).unwrap();
                r.worker_claim = Some("unit-fixture-claim".into());
                r.state = "running".into();
            }
            Ok(())
        })
        .unwrap();
    let mut waiting = input("waiting", &grant);
    waiting["target"] = json!("claude-fixture");
    submit(&store, &waiting, None).unwrap();
    dispatch(&store, cli).unwrap();
    assert_eq!(store.read().unwrap().requests["waiting"].state, "queued");
    let status = owner_api(&store, "status", &json!({}), cli).unwrap();
    let queued = status["requests"].as_array().unwrap().iter().find(|r| r["id"] == "waiting").unwrap();
    assert_eq!(queued["queued_reason"], "waiting for a free slot (active 2 of 2)");
    let raised = owner_api(&store, "limits-set", &json!({"concurrent":"unlimited"}), cli).unwrap();
    assert_eq!(raised["concurrent"], "unlimited");
    // The fixture CLI cannot launch, so the claimed request records that and stops.
    let state = store.read().unwrap();
    assert!(
        state.requests["waiting"]
            .events
            .iter()
            .any(|e| e.kind == "dispatch-claimed")
    );
    let status = owner_api(&store, "status", &json!({}), cli).unwrap();
    assert_eq!(status["limits"]["concurrent"], "unlimited");
    assert_eq!((&status["limits"]["active"], &status["limits"]["queued"]), (&json!(2), &json!(0)));
    for bad in [json!(0), json!(1.5), json!("lots"), json!(null), json!(9_007_199_254_740_992u64)] {
        let error = owner_api(&store, "limits-set", &json!({"concurrent":bad}), cli).unwrap_err();
        assert!(error.to_string().contains("concurrent must be a whole number from 1"), "{error}");
    }
    assert_eq!(owner_api(&store, "policy", &json!({}), cli).unwrap()["concurrent"], "unlimited");
}

fn running_reader(store: &Store, grant: &Grant, capability: &str) -> String {
    let request = submit(store, &input("window-reader", grant), None).unwrap();
    store
        .transaction(|state| {
            let r = state.requests.get_mut(&request.id).unwrap();
            r.capability_hash = hash(capability);
            r.workspace = Some(grant.project.clone());
            r.state = "running".into();
            Ok(())
        })
        .unwrap();
    request.id
}

#[test]
fn read_file_windows_end_on_lines_and_characters_and_stay_redacted() {
    let (_temp, store, grant) = fixture();
    let source = Path::new(&grant.project).join("src");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("text.txt"), "one\n\u{20ac}\u{20ac}x").unwrap();
    fs::write(source.join("notes.txt"), "x sk-ant-abcdefghijklmnopqrst y").unwrap();
    let request = running_reader(&store, &grant, "unit-window-capability");
    let read = |path: &str, offset: u64, max_bytes: u64| {
        mcp::call(
            &store,
            &request,
            "unit-window-capability",
            Path::new("unused"),
            "read_file",
            &json!({"path":path,"offset":offset,"max_bytes":max_bytes}),
        )
    };
    let mut windows = vec![];
    for (offset, max_bytes) in [(0, 6), (4, 4), (7, 1), (10, 5)] {
        let window = read("src/text.txt", offset, max_bytes).unwrap();
        assert_eq!(window["offset"], offset);
        let content = window["content"].as_str().unwrap().to_owned();
        windows.push((content, window["next_offset"].clone()));
    }
    // A line break ends the first window; the others back off to, or complete, a character.
    let euro = "\u{20ac}".to_owned();
    assert_eq!(
        windows,
        [
            ("one\n".to_owned(), json!(4)),
            (euro.clone(), json!(7)),
            (euro, json!(10)),
            ("x".to_owned(), Value::Null)
        ]
    );
    let last = read("src/text.txt", 10, 5).unwrap();
    assert_eq!((&last["eof"], &last["size"]), (&json!(true), &json!(11)));
    let inside = read("src/text.txt", 5, 4).unwrap_err().to_string();
    assert!(inside.contains("inside a UTF-8 character"));
    assert!(read("src/text.txt", 12, 4).unwrap_err().to_string().contains("size 11"));
    // Neither half of a credential split across two windows is returned.
    let first = read("src/notes.txt", 0, 12).unwrap();
    let second = read("src/notes.txt", 12, 64).unwrap();
    assert_eq!(first["content"], "x [REDACTED]");
    let second = second["content"].as_str().unwrap();
    assert!(!second.contains("defghijk") && second.ends_with(" y"));
}

#[test]
fn list_files_pages_through_the_allowed_scope() {
    let (_temp, store, grant) = fixture();
    let project = Path::new(&grant.project);
    git(project, &["init", "--quiet"]).unwrap();
    fs::create_dir(project.join("src")).unwrap();
    for name in ["src/a.txt", "src/b.txt", "src/c.txt", "outside.txt"] {
        fs::write(project.join(name), "fixture").unwrap();
    }
    let request = running_reader(&store, &grant, "unit-list-capability");
    let list = |args: Value| {
        mcp::call(
            &store,
            &request,
            "unit-list-capability",
            Path::new("unused"),
            "list_files",
            &args,
        )
        .unwrap()
    };
    let first = list(json!({"limit":2}));
    assert_eq!(first["files"], json!(["src/a.txt", "src/b.txt"]));
    assert_eq!((&first["total"], &first["next_offset"]), (&json!(3), &json!(2)));
    let rest = list(json!({"offset":2,"limit":2}));
    assert_eq!(rest["files"], json!(["src/c.txt"]));
    assert!(rest["next_offset"].is_null());
    assert_eq!(list(json!({}))["limit"], 1000);
}
