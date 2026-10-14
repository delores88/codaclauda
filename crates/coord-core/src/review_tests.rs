//! Regression tests for local authority and durability boundaries.
//! Fixtures never launch provider sessions and are not acceptance evidence.
use super::*;

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
        max_requests: 16,
        max_delegations: 4,
        max_hops: 3,
        timeout_seconds: 60,
        expires_at: now() + 300,
        compute: vec![],
    };
    store
        .transaction(|state| {
            state.grants.insert(grant.id.clone(), grant.clone());
            for agent in ["codex", "claude"] {
                let endpoint = Endpoint {
                    id: format!("{agent}-fixture"),
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
