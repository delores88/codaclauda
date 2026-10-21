use super::*;

fn fixture() -> (tempfile::TempDir, Store, Book) {
    let dir = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
    let store = Store::new(Some(dir.path().to_owned())).unwrap();
    for (address, label) in [(ADDRESS, "Ben's phone (unverified)"), ("codex-claudacoda", "Release reviewer"), ("claude-codaclauda", "Builder")] {
        mailbox::api(&store, "register", &json!({"name": address, "label": label})).unwrap();
    }
    let mut book = Book::default();
    book.bind(Some("https://ntfy.sh/fixture"), coord_core::now().saturating_sub(60)).unwrap();
    (dir, store, book)
}

fn incoming(id: &str, message: &str) -> Incoming {
    Incoming { id: id.into(), time: coord_core::now(), topic: "fixture".into(), message: message.into(), title: String::new(), tags: Vec::new() }
}

fn choices() -> Vec<Recipient> {
    vec![
        Recipient { address: "codex-claudacoda".into(), title: Some("Release reviewer".into()), active: true },
        Recipient { address: "claude-codaclauda".into(), title: Some("Builder".into()), active: true },
    ]
}

fn publication(id: &str, recipient: Option<&str>, body: &str) -> Publication {
    Publication { id: id.into(), title: recipient.unwrap_or("CodaClauda").into(), subject: "Reply".into(), body: body.into(), limit: 1000, tag: "", recipient: recipient.map(str::to_owned) }
}

fn receipt_id(book: &Book, id: &str) -> String {
    scoped(book.topic_digest.as_deref().unwrap(), id)
}

#[test]
fn recorded_ntfy_jsonl_preserves_titles_tags_and_text_without_control_events() {
    // Synthetic recording of the documented ntfy wire format, never a live topic.
    let recording = concat!(
        "{\"id\":\"opening\",\"time\":1800000000,\"event\":\"open\",\"topic\":\"fixture\"}\n",
        "{\"id\":\"messageone\",\"time\":1800000001,\"event\":\"message\",\"topic\":\"fixture\",\"title\":\"Review\",\"message\":\"@Release reviewer café ☕\\nsecond line\"}\n",
        "{\"id\":\"heartbeat\",\"time\":1800000002,\"event\":\"keepalive\",\"topic\":\"fixture\"}\n",
        "{\"id\":\"messagetwo\",\"time\":1800000003,\"event\":\"message\",\"topic\":\"fixture\",\"message\":\"Agent answer\",\"tags\":[\"codaclauda\",\"white_check_mark\"]}\n"
    );
    let parsed = parse_poll(recording.as_bytes(), "fixture").unwrap();
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].id, "messageone");
    assert_eq!(parsed[0].title, "Review");
    assert_eq!(parsed[0].message, "@Release reviewer café ☕\nsecond line");
    assert_eq!(parsed[1].tags, vec![APP_TAG.to_owned(), "white_check_mark".into()]);
    assert!(parse_poll(recording.as_bytes(), "different").is_err());
    for invalid in [b"{bad json}\n".as_slice(), b"{\"event\":\"unexpected\"}", b"{\"event\":\"message\",\"id\":\"bad/id\",\"time\":1,\"topic\":\"fixture\"}", &[0xff]] {
        assert!(parse_poll(invalid, "fixture").is_err());
    }
    assert_eq!(parse_poll(&vec![b'x'; POLL_BYTES + 1], "fixture").unwrap_err().0, "PHONE_POLL_TOO_LARGE");
    assert_eq!(published_id(b"{\"id\":\"pushreceipt\",\"event\":\"message\"}").unwrap(), "pushreceipt");
    assert_eq!(published_id(b"{\"id\":\"bad/id\"}").unwrap_err().0, "PHONE_PUSH_UNKNOWN");
}

#[test]
fn own_publications_are_skipped_by_tag_before_id_save_and_by_id_after_restart() {
    let (dir, _store, mut book) = fixture();
    let path = dir.path().join(FILE);
    let mut tagged = incoming("tagonly", "@Release reviewer This must never become a turn.");
    tagged.tags = vec![APP_TAG.into(), "white_check_mark".into()];
    assert!(book.published.is_empty(), "the crash window has no saved response id yet");
    assert!(!prepare(&mut book, &tagged, &choices(), |_| panic!("own message reached delivery routing")).unwrap());
    assert!(book.inbound.is_empty());
    assert_eq!(book.last_id.as_deref(), Some("tagonly"));

    let sent = publication("board:sent", Some("codex-claudacoda"), "Agent answer");
    assert!(begin_push(&mut book, &sent).unwrap().is_some());
    book.complete_push(&sent.id, Ok("savedpublication"), false, sent.recipient.as_deref());
    persist(&path, &book).unwrap();
    let mut restarted = read_book(&path).unwrap();
    let untagged_echo = incoming("savedpublication", "Agent answer");
    assert!(restarted.own(&untagged_echo));
    assert!(!prepare(&mut restarted, &untagged_echo, &choices(), |_| panic!("saved id reached delivery routing")).unwrap());
    assert!(restarted.inbound.is_empty());
    restarted.bind(Some("https://ntfy.sh/another-fixture"), coord_core::now()).unwrap();
    assert!(!restarted.own(&untagged_echo), "saved ntfy ids belong to their topic namespace");
    assert!(restarted.own(&tagged), "the application tag suppresses self traffic on every topic");
}

#[test]
fn route_resolves_addresses_longest_and_quoted_titles_without_ambiguous_matches() {
    let mut list = choices();
    list.push(Recipient { address: "short-reviewer".into(), title: Some("Release".into()), active: true });
    list.push(Recipient { address: "unicode-reviewer".into(), title: Some("Révision équipe".into()), active: true });
    for (body, address, text) in [
        ("@CODEX-CLAUDACODA inspect this", "codex-claudacoda", "inspect this"),
        ("@Release reviewer inspect this", "codex-claudacoda", "inspect this"),
        ("@\"Release reviewer\" inspect this", "codex-claudacoda", "inspect this"),
        ("  @Révision équipe café ☕", "unicode-reviewer", "café ☕"),
        ("@Release inspect this", "short-reviewer", "inspect this"),
        ("ordinary follow up", "claude-codaclauda", "ordinary follow up"),
    ] {
        let (to, offset) = route(body, Some("claude-codaclauda"), &list).unwrap();
        assert_eq!(to, address);
        assert_eq!(&body[offset..], text);
    }
    list.push(Recipient { address: "duplicate-reviewer".into(), title: Some("Release reviewer".into()), active: true });
    for body in ["@Release reviewer inspect", "@\"Release reviewer\" inspect"] {
        let error = route(body, None, &list).unwrap_err();
        assert!(error.contains("ambiguous") && error.contains("@codex-claudacoda") && error.contains("@duplicate-reviewer"));
    }
    // An address remains usable even when another session adopts it as a title.
    list.push(Recipient { address: "name-collision".into(), title: Some("codex-claudacoda".into()), active: true });
    for body in ["@codex-claudacoda inspect", "@\"codex-claudacoda\" inspect"] {
        assert_eq!(route(body, None, &list).unwrap().0, "codex-claudacoda");
    }
    assert!(route("@\"Release reviewer inspect", None, &list).is_err());
    assert!(route("@\"Release reviewer\"inspect", None, &list).is_err());
}

#[test]
fn missing_recipient_asks_for_active_names_and_unknown_or_self_routes_are_refused() {
    let mut list = choices();
    list.push(Recipient { address: "inactive-example".into(), title: Some("Inactive title".into()), active: false });
    let hint = route("What passed?", None, &list).unwrap_err();
    assert!(hint.starts_with("Start with @name to choose an agent"));
    assert!(hint.contains("Release reviewer") && hint.contains("@codex-claudacoda"));
    assert!(!hint.contains("inactive-example") && !hint.contains("Inactive title"));
    assert!(route("What passed?", Some("missing-agent"), &list).unwrap_err().starts_with("Start with @name"));
    assert!(route("@unknown What passed?", None, &list).unwrap_err().contains("unknown"));
    assert!(route("@codex-claudacoda", None, &list).is_err());
    assert!(route("\0", Some("codex-claudacoda"), &list).is_err());
    assert!(route(&"x".repeat(MESSAGE_BYTES + 1), Some("codex-claudacoda"), &list).is_err());
    list.push(Recipient { address: ADDRESS.into(), title: Some("Phone".into()), active: false });
    assert!(route("@owner-phone repeat", None, &list).is_err());
    assert!(route("repeat", Some(ADDRESS), &list).is_err());

    let directory = json!({"addresses": [{"name": "codex-claudacoda"}, {"name": "claude-codaclauda"}, {"name": ADDRESS}]});
    let records = vec![
        Record { mailbox_address: Some("codex-claudacoda".into()), title: "Release reviewer".into(), last_activity_at: 10, ..Record::default() },
        Record { mailbox_address: Some("claude-codaclauda".into()), title: "Closed latest chat".into(), last_activity_at: 20, status: "closed".into(), ..Record::default() },
    ];
    let resolved = recipients(&directory, &records);
    assert_eq!(resolved.iter().filter(|r| r.active).map(|r| r.address.as_str()).collect::<Vec<_>>(), vec!["codex-claudacoda"]);
    assert!(!resolved.iter().any(|r| r.address == ADDRESS));
    assert!(!choice_hint(&resolved).contains("Closed latest chat"));
}

#[test]
fn inbound_restart_posts_once_with_frozen_title_offset_recipient_and_unverified_sender() {
    let (dir, store, mut book) = fixture();
    let path = dir.path().join(FILE);
    let item = incoming("restart", "  @Release reviewer Please inspect this change.");
    assert!(prepare(&mut book, &item, &choices(), |_| None).unwrap());
    let id = receipt_id(&book, &item.id);
    let namespace = book.topic_digest.clone().unwrap();
    persist(&path, &book).unwrap(); // Crash after the frozen route is durable.
    let renamed = vec![Recipient { address: "claude-codaclauda".into(), title: Some("Release reviewer".into()), active: true }];
    let mut restored = read_book(&path).unwrap();
    restored.last_recipient = Some("claude-codaclauda".into());
    assert!(prepare(&mut restored, &item, &renamed, |_| None).unwrap());
    assert_eq!(restored.inbound[&id].to.as_deref(), Some("codex-claudacoda"));
    let first = mailbox::api(&store, "post", &post_args(&namespace, &item, &restored.inbound[&id])).unwrap();

    // Crash after the board saves, before the phone cursor advances. The renamed
    // session must neither steal the retry nor change the original message text.
    let mut restarted = read_book(&path).unwrap();
    assert!(prepare(&mut restarted, &item, &renamed, |_| None).unwrap());
    let again = mailbox::api(&store, "post", &post_args(&namespace, &item, &restarted.inbound[&id])).unwrap();
    assert_eq!(first["id"], again["id"]);
    assert_eq!(first["sequence"], again["sequence"]);
    assert_eq!(again["from"], ADDRESS);
    assert_ne!(again["from"], "owner");
    assert_eq!(again["kind"], "notice");
    let body = again["body"].as_str().unwrap();
    assert!(body.contains("Ben's phone (unverified)") && body.contains("anyone who knows the topic") && body.contains("not owner approval"));
    assert!(body.ends_with("Please inspect this change."));
    assert!(!body.contains("@Release reviewer"));
    restarted.inbound.get_mut(&id).unwrap().done = true;
    restarted.last_id = Some(item.id.clone());
    persist(&path, &restarted).unwrap();
    let mut completed = read_book(&path).unwrap();
    assert!(!prepare(&mut completed, &item, &renamed, |_| None).unwrap());
    assert_eq!(completed.last_id.as_deref(), Some("restart"));
    assert_eq!(mailbox::api(&store, "inbox", &json!({"addr": "codex-claudacoda"})).unwrap()["messages"].as_array().unwrap().len(), 1);
    assert!(!fs::read_to_string(&path).unwrap().contains("Please inspect this change."));
    let mut changed = item.clone();
    changed.title = "A different title for the same event".into();
    assert_eq!(prepare(&mut completed, &changed, &choices(), |_| None).unwrap_err().0, "PHONE_ID_COLLISION");
    let mut expired = incoming("expired", "@Builder Do not replay old work.");
    expired.time = coord_core::now().saturating_sub(RETENTION + 1);
    assert!(!prepare(&mut completed, &expired, &choices(), |_| None).unwrap());
}

#[test]
fn board_reply_forwards_sender_and_thousand_characters_but_never_replays_an_unknown_push() {
    let (dir, store, mut book) = fixture();
    let path = dir.path().join(FILE);
    let text = "é🙂".repeat(600);
    mailbox::api(&store, "post", &json!({"id": "outbound", "from": "codex-claudacoda", "to": ADDRESS, "kind": "notice", "subject": "Reply", "body": text})).unwrap();
    let item = mailbox::api(&store, "inbox", &json!({"addr": ADDRESS, "unread": true})).unwrap()["messages"][0].clone();
    let outgoing = publication("board:outbound", item["from"].as_str(), item["body"].as_str().unwrap());
    let prepared = begin_push(&mut book, &outgoing).unwrap().unwrap();
    assert_eq!(prepared.0, "codex-claudacoda");
    assert_eq!(prepared.1, "é🙂".repeat(500));
    assert!(!prepared.2);
    assert_eq!(book.outbound[&outgoing.id].state, "sending");
    persist(&path, &book).unwrap(); // Must precede any external HTTP side effect.
    let mut restored = read_book(&path).unwrap();
    assert_eq!(restored.last_error.as_deref(), Some(UNKNOWN_PUSH));
    assert!(begin_push(&mut restored, &outgoing).unwrap().is_none());
    let failed = failure("PHONE_PUSH_UNKNOWN", UNKNOWN_PUSH);
    restored.complete_push(&outgoing.id, Err(&failed), false, outgoing.recipient.as_deref());
    assert_eq!(restored.outbound[&outgoing.id].state, "unknown");
    assert!(restored.last_recipient.is_none());
    restored.bind(Some("https://ntfy.sh/another-fixture"), coord_core::now()).unwrap();
    assert!(begin_push(&mut restored, &outgoing).unwrap().is_none(), "a URL change cannot resend an ambiguous old reply");
    mailbox::api(&store, "ack", &json!({"addr": ADDRESS, "id": "outbound"})).unwrap();
    assert!(mailbox::api(&store, "inbox", &json!({"addr": ADDRESS, "unread": true})).unwrap()["messages"].as_array().unwrap().is_empty());
}

#[test]
fn only_confirmed_agent_publications_move_the_last_recipient_including_turn_notifications() {
    let (_dir, _store, mut book) = fixture();
    let reply = publication("board:reply", Some("codex-claudacoda"), "Here is the result.");
    begin_push(&mut book, &reply).unwrap();
    book.complete_push(&reply.id, Ok("replyposted"), false, reply.recipient.as_deref());
    assert_eq!(book.last_recipient.as_deref(), Some("codex-claudacoda"));
    let notification = Publication { id: "turn:session:finished".into(), title: "CodaClauda".into(), subject: "Builder".into(), body: "Builder finished a turn.".into(), limit: 160, tag: "white_check_mark", recipient: Some("claude-codaclauda".into()) };
    let prepared = begin_push(&mut book, &notification).unwrap().unwrap();
    book.complete_push(&notification.id, Ok("turnposted"), prepared.2, notification.recipient.as_deref());
    assert_eq!(book.last_recipient.as_deref(), Some("claude-codaclauda"));
    for (id, target, refused) in [("feedback:missing", None, false), ("warning:loop", None, false), ("board:owner", Some("owner"), false), ("board:phone", Some(ADDRESS), false), ("board:refused", Some("codex-claudacoda"), true)] {
        let fixed = publication(id, target, "A fixed system explanation.");
        begin_push(&mut book, &fixed).unwrap();
        book.complete_push(&fixed.id, Ok("fixedpublication"), refused, fixed.recipient.as_deref());
        assert_eq!(book.last_recipient.as_deref(), Some("claude-codaclauda"));
    }
    assert_eq!(book.outbound["board:refused"].state, "refused");
    assert_eq!(book.last_error.as_deref(), Some(SCAN_REFUSAL));
}

#[test]
fn scanner_checks_inbound_titles_and_whole_outbound_text_before_reply_or_notification_clipping() {
    let (_dir, _store, mut book) = fixture();
    let suspicious = format!("{}{}", "sk-", "a".repeat(24));
    assert!(mailbox_credential(&suspicious));
    assert_eq!(route(&format!("@Builder {suspicious}"), None, &choices()).unwrap_err(), SCAN_REFUSAL);
    for (id, body, title) in [("badbody", suspicious.as_str(), "Safe title"), ("badtitle", "@Builder Safe message", suspicious.as_str())] {
        let mut item = incoming(id, body);
        item.title = title.into();
        prepare(&mut book, &item, &choices(), |_| None).unwrap();
        let receipt = &book.inbound[&receipt_id(&book, id)];
        assert!(receipt.to.is_none());
        assert_eq!(receipt.feedback.as_deref(), Some(SCAN_REFUSAL));
    }
    let beyond_preview = format!("{} {suspicious}", "x".repeat(1100));
    let beyond_title_limit = format!("{} {suspicious}", "x".repeat(90));
    for (title, subject, body, limit) in [
        ("codex-claudacoda", "Reply", beyond_preview.as_str(), 1000),
        (beyond_title_limit.as_str(), "Reply", "Safe body", 1000),
        ("CodaClauda", beyond_preview.as_str(), "Clipped notification body", 160),
        ("CodaClauda", "Turn failed", beyond_preview.as_str(), 160),
    ] {
        let (title, text, refused) = outbound_text(title, subject, body, limit);
        assert!(refused);
        assert_eq!(title, "CodaClauda");
        assert_eq!(text, SCAN_REFUSAL);
        assert!(!text.contains(&suspicious));
    }
    let notification = Publication { id: "turn:unsafe:title".into(), title: "CodaClauda".into(), subject: beyond_preview, body: "A safe pre-clipped notification".into(), limit: 160, tag: "warning", recipient: Some("claude-codaclauda".into()) };
    assert!(begin_push(&mut book, &notification).unwrap().unwrap().2);
    assert!(!serde_json::to_string(&book).unwrap().contains(&suspicious), "receipts never retain refused input");
}

#[test]
fn default_on_requires_a_topic_and_saved_off_url_changes_and_storage_failure_revoke_old_polls() {
    let (dir, _store, mut book) = fixture();
    let path = dir.path().join(FILE);
    let fresh = read_book(&path).unwrap();
    assert!(fresh.enabled);
    assert!(!fresh.current(fresh.revision), "no URL means no poll or reply forwarding");
    let fetched_revision = book.revision;
    assert!(book.current(fetched_revision));
    book.settings(false).unwrap();
    persist(&path, &book).unwrap();
    let mut restored = read_book(&path).unwrap();
    assert!(!restored.enabled);
    assert!(!restored.current(fetched_revision));
    restored.settings(true).unwrap();
    assert!(!restored.current(fetched_revision), "off/on cannot revive an already fetched poll");
    let prior_url_revision = restored.revision;
    restored.last_id = Some("prior-topic-message".into());
    restored.last_recipient = Some("codex-claudacoda".into());
    restored.bind(Some("https://ntfy.sh/another-fixture"), coord_core::now()).unwrap();
    assert!(!restored.current(prior_url_revision));
    assert!(restored.last_id.is_none() && restored.last_recipient.is_none());
    restored.bind(None, coord_core::now()).unwrap();
    assert!(!restored.current(restored.revision));
    restored.storage_failed = true;
    assert!(restored.settings(true).is_err());
    assert!(restored.bind(Some("https://ntfy.sh/fixture"), coord_core::now()).is_err());
}

#[test]
fn draft_migration_preserves_off_and_receipt_evidence_without_reusing_generated_topic_or_route() {
    let (dir, _store, _book) = fixture();
    let path = dir.path().join(FILE);
    let at = coord_core::now();
    let old_receipt = json!({"digest": "retained-digest", "to": "codex-claudacoda", "feedback": "A fixed delivery explanation.", "feedbackAttempted": true, "feedbackState": "unknown", "done": false, "at": at});
    let draft = json!({"schema": 1, "enabled": false, "topic": "a".repeat(64), "defaultRecipient": "codex-claudacoda", "revision": 3, "createdAt": at, "lastId": "old-cursor", "inbound": {"old-incoming": old_receipt}, "outbound": {"old-reply": {"state": "sending", "at": at}, "old-sent": {"state": "sent", "at": at}}, "lastError": null});
    fs::write(&path, serde_json::to_vec(&draft).unwrap()).unwrap();
    let mut migrated = read_book(&path).unwrap();
    assert_eq!(migrated.schema, 2);
    assert!(!migrated.enabled);
    assert!(migrated.topic_digest.is_none() && migrated.last_recipient.is_none() && migrated.inbound.is_empty());
    assert_eq!(migrated.legacy_cursor.as_deref(), Some("old-cursor"));
    assert!(migrated.legacy_inbound.contains_key("old-incoming"));
    assert_eq!(migrated.outbound["board:old-reply"].state, "sending");
    assert_eq!(migrated.last_error.as_deref(), Some(UNKNOWN_PUSH));
    assert!(begin_push(&mut migrated, &publication("board:old-reply", Some("codex-claudacoda"), "Old reply")).unwrap().is_none());
    migrated.bind(Some("https://ntfy.sh/fixture"), at.saturating_sub(60)).unwrap();
    assert!(!migrated.enabled, "saving a URL does not erase explicit Off");
    persist(&path, &migrated).unwrap();
    let written: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert!(written.get("topic").is_none() && written.get("defaultRecipient").is_none());
    assert_eq!(written["legacyInbound"]["old-incoming"], old_receipt);
    let reread = read_book(&path).unwrap();
    assert_eq!(reread.legacy_cursor.as_deref(), Some("old-cursor"));
    assert_eq!(reread.legacy_inbound.len(), 1);
}

#[test]
fn receipt_capacity_refuses_before_send_or_new_delivery_and_keeps_saved_state_readable() {
    let (dir, _store, mut book) = fixture();
    let now = coord_core::now();
    for n in 0..RECEIPT_LIMIT {
        book.outbound.insert(format!("board:saved-{n}"), PushReceipt { state: "sent".into(), at: now });
    }
    let fresh = publication("board:new", Some("codex-claudacoda"), "Hello");
    assert_eq!(begin_push(&mut book, &fresh).unwrap_err().0, "PHONE_RECEIPT_LIMIT");
    assert_eq!(book.outbound.len(), RECEIPT_LIMIT);
    assert!(!book.outbound.contains_key(&fresh.id));
    assert!(begin_push(&mut book, &publication("board:saved-0", Some("codex-claudacoda"), "Hello")).unwrap().is_none());
    let path = dir.path().join(FILE);
    persist(&path, &book).unwrap();
    assert_eq!(read_book(&path).unwrap().outbound.len(), RECEIPT_LIMIT);

    book.outbound.clear();
    for n in 0..RECEIPT_LIMIT { book.published.insert(format!("posted-{n}"), now); }
    assert_eq!(begin_push(&mut book, &fresh).unwrap_err().0, "PHONE_RECEIPT_LIMIT");
    assert!(book.outbound.is_empty());
    book.published.clear();
    for n in 0..RECEIPT_LIMIT { book.inbound.insert(format!("received-{n}"), InboundReceipt { at: now, done: true, ..Default::default() }); }
    assert_eq!(prepare(&mut book, &incoming("new", "@Builder Hello"), &choices(), |_| None).unwrap_err().0, "PHONE_RECEIPT_LIMIT");
    assert_eq!(book.inbound.len(), RECEIPT_LIMIT);
}

#[test]
fn malformed_or_unsupported_phone_state_is_refused_without_replacing_its_bytes() {
    let (dir, _store, _book) = fixture();
    let path = dir.path().join(FILE);
    for bytes in [b"not json".as_slice(), b"{\"schema\":9,\"enabled\":true}", b"{\"schema\":2,\"enabled\":true,\"unexpectedBody\":\"keep original evidence\"}", b"{\"schema\":2,\"enabled\":\"yes\"}"] {
        fs::write(&path, bytes).unwrap();
        assert_eq!(read_book(&path).err().unwrap().0, "PHONE_STORAGE_FAILED");
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    let mut value = json!(Book::default());
    value["published"] = json!((0..=RECEIPT_LIMIT).map(|n| (format!("event-{n}"), coord_core::now())).collect::<BTreeMap<_, _>>());
    let bytes = serde_json::to_vec(&value).unwrap();
    fs::write(&path, &bytes).unwrap();
    assert_eq!(read_book(&path).err().unwrap().0, "PHONE_STORAGE_FAILED");
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

#[test]
fn manual_test_notice_is_tagged_receipted_once_and_never_changes_reply_routing() {
    let (dir, _store, mut book) = fixture();
    let path = dir.path().join(FILE);
    book.last_recipient = Some("codex-claudacoda".into());
    book.settings(false).unwrap(); // The owner's manual test is independent of this switch.
    let notice = notify::test_publication();
    assert!(notice.id.starts_with("test:"));
    assert_ne!(notice.id, notify::test_publication().id);
    assert!(notice.recipient.is_none());
    let (title, body, refused) = begin_push(&mut book, &notice).unwrap().unwrap();
    assert_eq!(title, "CodaClauda");
    assert_eq!(body, "CodaClauda phone notification test. If you can read this on your phone, this notice arrived.");
    assert!(!refused);
    assert_eq!(publish_tags(notice.tag), APP_TAG);
    persist(&path, &book).unwrap();
    assert_eq!(read_book(&path).unwrap().outbound[&notice.id].state, "sending");
    let accepted = response_outcome(200, Ok(br#"{"id":"testposted","event":"message"}"#));
    let receipt = accepted.receipt(&notice.id, refused);
    assert_eq!(receipt["status"], "sent");
    assert_eq!(receipt["httpStatus"], 200);
    assert_eq!(receipt["ntfyId"], "testposted");
    assert_eq!(receipt["attempted"], true);
    assert!(receipt["message"].as_str().unwrap().contains("not confirmed"));
    book.complete_push(&notice.id, accepted.result.as_deref(), refused, notice.recipient.as_deref());
    persist(&path, &book).unwrap();
    let mut restarted = read_book(&path).unwrap();
    assert!(begin_push(&mut restarted, &notice).unwrap().is_none());
    assert_eq!(restarted.last_recipient.as_deref(), Some("codex-claudacoda"));
    let echo = incoming("testposted", &body);
    assert!(restarted.own(&echo));
    assert!(!prepare(&mut restarted, &echo, &choices(), |_| panic!("test notice became a turn")).unwrap());
    assert!(restarted.inbound.is_empty());
}

#[test]
fn manual_test_http_failure_and_uncertainty_return_receipts_without_replaying_attempts() {
    let (dir, _store, mut book) = fixture();
    let path = dir.path().join(FILE);
    let outcomes = [
        (response_outcome(429, Ok(b"untrusted server body is never echoed")), "failed", Some(429)),
        (response_outcome(200, Ok(b"missing response id")), "unknown", Some(200)),
        (response_outcome(200, Err(failure("PHONE_RESPONSE_TOO_LARGE", "not forwarded"))), "unknown", Some(200)),
        (PushOutcome { result: Err(failure("PHONE_PUSH_UNKNOWN", UNKNOWN_PUSH)), http_status: None, attempted: true }, "unknown", None),
    ];
    for (outcome, status, http_status) in outcomes {
        let notice = notify::test_publication();
        begin_push(&mut book, &notice).unwrap().unwrap();
        persist(&path, &book).unwrap();
        let receipt = outcome.receipt(&notice.id, false);
        assert_eq!(receipt["status"], status);
        assert_eq!(receipt["httpStatus"], json!(http_status));
        assert_eq!(receipt["attempted"], true);
        assert!(receipt["ntfyId"].is_null());
        assert!(!receipt.to_string().contains("untrusted server body"));
        book.complete_push(&notice.id, outcome.result.as_deref(), false, None);
        persist(&path, &book).unwrap();
        book = read_book(&path).unwrap();
        assert_eq!(book.outbound[&notice.id].state, status);
        assert!(begin_push(&mut book, &notice).unwrap().is_none());
    }
    let refused = refused_publication("test:unsent", "Save an ntfy topic URL before sending a test. No notice was sent.");
    assert_eq!(refused["status"], "refused");
    assert_eq!(refused["attempted"], false);
    assert!(refused["httpStatus"].is_null());
}
