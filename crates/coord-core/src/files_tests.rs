//! C9 file tools: windowed reads with credential redaction across window
//! boundaries, staged writes with identity checks, and tool-call accounting.
//! Fixtures never launch providers.
use super::*;

const CLI: &str = "must-never-be-launched.exe";
const CAPABILITY: &str = "unit-files-capability";

fn fixture(legacy: bool, max_mcp_calls: Budget) -> (tempfile::TempDir, Store, Grant) {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(project.join("src")).unwrap();
    let project = project.canonicalize().unwrap();
    let store = Store::new(Some(temp.path().join("state"))).unwrap();
    let grant = Grant {
        id: "files-grant".into(),
        project: project.to_string_lossy().into_owned(),
        allowed_paths: vec!["src".into()],
        targets: vec!["codex-fixture".into()],
        kinds: vec!["question".into(), "delegate".into()],
        expected_result: "Unit test fixture only".into(),
        max_requests: Unlimited,
        max_delegations: Unlimited,
        max_hops: Unlimited,
        timeout_seconds: Finite(60),
        expires_at: Unlimited,
        compute: vec![],
        max_turns: if legacy { Finite(LEGACY_MAX_TURNS) } else { Unlimited },
        max_mcp_calls: if legacy { Finite(LEGACY_MAX_MCP_CALLS) } else { max_mcp_calls },
        max_compute_jobs: if legacy { Finite(LEGACY_MAX_COMPUTE_JOBS) } else { Unlimited },
        policy_version: if legacy { 0 } else { POLICY_VERSION },
        revoked_at: None,
    };
    store
        .transaction(|s| {
            s.grants.insert(grant.id.clone(), grant.clone());
            Ok(())
        })
        .unwrap();
    (temp, store, grant)
}

/// A request launched by a worker in the project directory, holding CAPABILITY.
fn running(store: &Store, grant: &Grant, id: &str, kind: &str) {
    submit(store, &json!({"id":id,"grant_id":grant.id,"target":"codex-fixture","kind":kind,"prompt":"Fixture"}), None).unwrap();
    store
        .transaction(|s| {
            let r = s.requests.get_mut(id).unwrap();
            r.worker_claim = Some(format!("claim-{id}"));
            r.capability_hash = hash(CAPABILITY);
            r.workspace = Some(grant.project.clone());
            r.state = "running".into();
            Ok(())
        })
        .unwrap();
}

fn tool(store: &Store, id: &str, name: &str, args: Value) -> Result<Value> {
    mcp::call(store, id, CAPABILITY, Path::new(CLI), name, &args)
}

fn sha(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// One credential of every pattern alternative, assembled at run time.
fn credentials() -> Vec<String> {
    let dashes = "-".repeat(5);
    let mut list: Vec<String> = [
        "sk-abcdefghijklmn",
        "sk-ant-abcdefghijklmnop",
        "\u{17F}k-abcdefghijklmn",
        "ghp_abcdefghijklmnopq",
        "gho_abcdefghijklmnopq",
        "ghu_abcdefghijklmnopq",
        "ghs_abcdefghijklmnopq",
        "ghr_abcdefghijklmnopq",
        "bearer abc.def-ghi",
        "Bearer\n\t xyz_uvw",
    ]
    .map(String::from)
    .to_vec();
    for name in ["api_key", "apikey", "API-KEY", "access_token", "access-token", "refresh_token", "refreshtoken", "password", "client_secret", "client-secret"] {
        list.push(format!("{name}=abc"));
    }
    list.push("password\": \"p\u{e4}ss\u{20ac}w\u{f6}rd".into());
    list.push("client_secret\n:\n'v\u{e9}rit\u{e9}".into());
    list.push(format!("{dashes}BEGIN EC PRIVATE KEY{dashes}\nMHcCAQEE\u{e9}IabcXYZ\n{dashes}END EC PRIVATE KEY{dashes}"));
    list.push(format!("{dashes}begin private \u{212A}ey{dashes}\nbody\n{dashes}END PRIVATE KEY{dashes}"));
    list
}

/// The text of [start, end) with the credential span replaced, as redact() would.
fn expected(text: &str, span: std::ops::Range<usize>, start: usize, end: usize) -> String {
    let (s, e) = (span.start.clamp(start, end), span.end.clamp(start, end));
    if s == e {
        return text[start..end].to_owned();
    }
    format!("{}[REDACTED]{}", &text[start..s], &text[e..end])
}

/// Read windows that end inside, start inside and lie inside `credential` at
/// every byte, with `lead` before it and `tail` after it.
fn check_splits(path: &Path, lead: &str, credential: &str, tail: &str) {
    let unlimited = |_: &Value| 0;
    let text = format!("{lead}{credential}{tail}");
    fs::write(path, &text).unwrap();
    let span = secrets::pattern().find(&text).expect(credential).range();
    assert_eq!(span, lead.len()..lead.len() + credential.len(), "{credential:?}");
    let read = |offset: usize, max: usize| files_io::read_window(path, "sample.txt", offset as u64, max as u64, None, &unlimited);
    let window = |offset: usize, max: usize| {
        let w = read(offset, max).unwrap();
        let end = w["next_offset"].as_u64().map_or(text.len(), |n| n as usize);
        (w["content"].as_str().unwrap().to_owned(), end)
    };
    for split in span.start + 1..span.end {
        if !text.is_char_boundary(split) {
            assert!(read(split, 64).unwrap_err().to_string().contains("inside a UTF-8 character"));
            let (content, end) = window(0, split);
            assert!(text.is_char_boundary(end) && end < split + 4);
            assert_eq!(content, expected(&text, span.clone(), 0, end), "{credential:?} before {split}");
            continue;
        }
        let (content, end) = window(0, split);
        assert_eq!(content, expected(&text, span.clone(), 0, end), "{credential:?} ending at {split}");
        let (content, end) = window(split, 4096);
        assert_eq!(content, expected(&text, span.clone(), split, end), "{credential:?} from {split}");
        let (content, end) = window(split, 2);
        assert_eq!(content, expected(&text, span.clone(), split, end), "{credential:?} inside at {split}");
    }
}

#[test]
fn every_credential_split_at_every_byte_stays_redacted() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("sample.txt");
    for credential in credentials() {
        // No separator nearby, so the context must reach back to the file start.
        check_splits(&path, "lead ", &credential, "' tail\n");
        // Separators right beside the credential bound the context on both sides.
        check_splits(&path, "x, ", &credential, "; y\n");
    }
    // More than 1 MiB before the window, so the backward search starts past the
    // file start and must stop at the separator, not at the window.
    check_splits(&path, &"ab,".repeat(400_000), "sk-ant-abcdefghijklmnop", "} y\n");
}

#[test]
fn private_key_block_spanning_many_windows_is_never_returned() {
    let (_temp, store, grant) = fixture(false, Unlimited);
    running(&store, &grant, "reader", "question");
    let dashes = "-".repeat(5);
    let body = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo+/abcdefghijklmnopqrstuvwxyzABCD\n".repeat(4000);
    let text = format!("lead\n{dashes}BEGIN RSA PRIVATE KEY{dashes}\n{body}{dashes}END RSA PRIVATE KEY{dashes}\ntail\n");
    fs::write(Path::new(&grant.project).join("src/key.txt"), &text).unwrap();
    let (mut offset, mut joined, mut version) = (0u64, String::new(), None);
    loop {
        let w = tool(&store, "reader", "read_file", json!({"path":"src/key.txt","offset":offset,"expect_version":version})).unwrap();
        assert_eq!(w["version"], sha(text.as_bytes()));
        version = Some(w["version"].clone());
        let content = w["content"].as_str().unwrap();
        assert!(content.len() <= 64 << 10 && !content.contains("QUJD") && !content.contains("wxyz"));
        joined.push_str(content);
        match w["next_offset"].as_u64() {
            Some(next) => offset = next,
            None => break,
        }
    }
    while joined.contains("[REDACTED][REDACTED]") {
        joined = joined.replace("[REDACTED][REDACTED]", "[REDACTED]");
    }
    assert_eq!(joined, "lead\n[REDACTED]\ntail\n");
    // A file changed between windows is refused rather than mixed.
    fs::write(Path::new(&grant.project).join("src/key.txt"), "replaced\n").unwrap();
    let error = tool(&store, "reader", "read_file", json!({"path":"src/key.txt","offset":0,"expect_version":version})).unwrap_err();
    assert_eq!(error.to_string(), "FILE_CHANGED: src/key.txt changed since you started reading; start again from offset 0.");
}

#[test]
fn reads_fail_closed_without_a_nearby_separator_and_fit_the_frame() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("long.txt");
    let text = format!("a,{} ,b", "x".repeat(3 << 19));
    fs::write(&path, &text).unwrap();
    let read = |offset: u64, max: u64| files_io::read_window(&path, "long.txt", offset, max, None, &|_: &Value| 0);
    let error = read(1_300_000, 1000).unwrap_err().to_string();
    assert!(error.starts_with("READ_UNVERIFIABLE: cannot verify credential redaction around offset 1300000"), "{error}");
    // A window may stop just after its last separator, so reading still advances.
    let first = read(0, 65536).unwrap();
    assert_eq!((first["content"].as_str(), first["next_offset"].as_u64()), (Some("a,"), Some(2)));
    assert!(read(2, 65536).unwrap_err().to_string().contains("READ_UNVERIFIABLE"));
    let whole = read(2, files_io::FRAME).unwrap();
    assert_eq!((whole["eof"].as_bool(), whole["content"].as_str().map(str::len)), (Some(true), Some(text.len() - 2)));
    // Content that needs JSON escaping comes back in smaller windows that fit 8 MiB.
    let control = temp.path().join("control.txt");
    fs::write(&control, "\u{1}".repeat(1 << 20)).unwrap();
    let mut offset = 0;
    while offset < 1 << 20 {
        let w = files_io::read_window(&control, "control.txt", offset, files_io::FRAME, None, &mcp::response_bytes).unwrap();
        assert!(mcp::response_bytes(&w) as u64 <= files_io::FRAME);
        let next = w["next_offset"].as_u64().unwrap_or(1 << 20);
        assert!(next > offset && next - offset < 1 << 20);
        offset = next;
    }
}

fn commit_upload(store: &Store, id: &str, path: &str, base: &str, parts: &[&str]) -> Result<Value> {
    let begun = tool(store, id, "write_begin", json!({"path":path,"expect_version":base}))?;
    let upload = begun["upload_id"].as_str().unwrap().to_owned();
    let mut offset = 0;
    for part in parts {
        let staged = tool(store, id, "write_chunk", json!({"upload_id":upload,"offset":offset,"content":part}))?;
        offset = staged["staged_bytes"].as_u64().unwrap();
    }
    tool(store, id, "write_commit", json!({"upload_id":upload}))
}

fn staged_files(store: &Store, id: &str) -> usize {
    fs::read_dir(store.root.join("staging").join(id)).map_or(0, |d| d.count())
}

#[test]
fn staged_write_of_18_mib_round_trips_atomically() {
    let (_temp, store, grant) = fixture(false, Unlimited);
    running(&store, &grant, "writer", "delegate");
    let line = "journal entry, steady payload text for the chunked write test;\n";
    let content = line.repeat((18 << 20) / line.len() + 1);
    let parts: Vec<&str> = content.as_bytes().chunks(6 << 20).map(|c| std::str::from_utf8(c).unwrap()).collect();
    let committed = commit_upload(&store, "writer", "src/journal.txt", "absent", &parts).unwrap();
    let target = Path::new(&grant.project).join("src/journal.txt");
    assert!(fs::read(&target).unwrap() == content.as_bytes());
    assert_eq!(committed["version"], sha(content.as_bytes()));
    assert_eq!(committed["bytes"], content.len());
    assert_eq!(staged_files(&store, "writer"), 0);
    let tail = tool(&store, "writer", "read_file", json!({"path":"src/journal.txt","offset":content.len() - line.len(),"expect_version":committed["version"]})).unwrap();
    assert_eq!((tail["content"].as_str(), tail["eof"].as_bool()), (Some(line), Some(true)));
    // Appends must be exact, and a stale base is refused before anything is staged.
    let begun = tool(&store, "writer", "write_begin", json!({"path":"src/journal.txt","expect_version":committed["version"]})).unwrap();
    let upload = begun["upload_id"].as_str().unwrap();
    let error = tool(&store, "writer", "write_chunk", json!({"upload_id":upload,"offset":5,"content":"x"})).unwrap_err();
    assert!(error.to_string().contains("continue from offset 0"));
    tool(&store, "writer", "write_abort", json!({"upload_id":upload})).unwrap();
    assert!(tool(&store, "writer", "write_begin", json!({"path":"src/journal.txt","expect_version":"absent"})).unwrap_err().to_string().starts_with("FILE_CHANGED"));
    assert_eq!(staged_files(&store, "writer"), 0);
    // Credentials are refused at commit, wherever the chunks split them.
    let error = commit_upload(&store, "writer", "src/other.txt", "absent", &["ok, sk-ant-abcd", "efghijklmnop;"]).unwrap_err();
    assert!(format!("{error:#}").contains("recognizable credential near byte 4"), "{error:#}");
    assert!(!Path::new(&grant.project).join("src/other.txt").exists());
}

#[test]
fn commit_refuses_changed_targets_swapped_paths_and_revocation() {
    let (temp, store, grant) = fixture(false, Unlimited);
    running(&store, &grant, "writer", "delegate");
    let project = Path::new(&grant.project);
    // Same size, preserved mtime: only the digest can tell.
    let data = project.join("src/data.txt");
    fs::write(&data, "alpha, one\n").unwrap();
    let version = tool(&store, "writer", "read_file", json!({"path":"src/data.txt"})).unwrap()["version"].clone();
    let begun = tool(&store, "writer", "write_begin", json!({"path":"src/data.txt","expect_version":version})).unwrap();
    let upload = begun["upload_id"].as_str().unwrap().to_owned();
    tool(&store, "writer", "write_chunk", json!({"upload_id":upload,"offset":0,"content":"beta\n"})).unwrap();
    let modified = fs::metadata(&data).unwrap().modified().unwrap();
    fs::write(&data, "alpha, two\n").unwrap();
    fs::File::options().write(true).open(&data).unwrap().set_modified(modified).unwrap();
    assert_eq!(fs::metadata(&data).unwrap().modified().unwrap(), modified);
    let error = tool(&store, "writer", "write_commit", json!({"upload_id":upload})).unwrap_err();
    assert!(error.to_string().starts_with("FILE_CHANGED: src/data.txt changed since write_begin"), "{error}");
    assert_eq!(fs::read_to_string(&data).unwrap(), "alpha, two\n");
    let error = tool(&store, "writer", "write_file", json!({"path":"src/data.txt","content":"gamma\n","expect_version":version})).unwrap_err();
    assert!(error.to_string().starts_with("FILE_CHANGED"));
    // A file created by someone else after an "absent" begin.
    let created = project.join("src/new.txt");
    let begun = tool(&store, "writer", "write_begin", json!({"path":"src/new.txt","expect_version":"absent"})).unwrap();
    let upload = begun["upload_id"].as_str().unwrap().to_owned();
    tool(&store, "writer", "write_chunk", json!({"upload_id":upload,"offset":0,"content":"mine\n"})).unwrap();
    fs::write(&created, "theirs\n").unwrap();
    assert!(tool(&store, "writer", "write_commit", json!({"upload_id":upload})).unwrap_err().to_string().starts_with("FILE_CHANGED"));
    assert_eq!(fs::read_to_string(&created).unwrap(), "theirs\n");
    // A directory swapped for a link to somewhere outside between begin and commit.
    fs::create_dir(project.join("src/sub")).unwrap();
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let begun = tool(&store, "writer", "write_begin", json!({"path":"src/sub/file.txt","expect_version":"absent"})).unwrap();
    let upload = begun["upload_id"].as_str().unwrap().to_owned();
    tool(&store, "writer", "write_chunk", json!({"upload_id":upload,"offset":0,"content":"x\n"})).unwrap();
    fs::rename(project.join("src/sub"), project.join("src/sub-moved")).unwrap();
    // mklink needs ordinary (not \\?\) paths.
    #[cfg(windows)]
    assert!(Command::new("cmd").args(["/C", "mklink", "/J"]).arg(temp.path().join(r"project\src\sub")).arg(&outside).stdout(Stdio::null()).status().unwrap().success());
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, project.join("src/sub")).unwrap();
    let error = tool(&store, "writer", "write_commit", json!({"upload_id":upload})).unwrap_err().to_string();
    assert!(error.contains("Reparse points") || error.contains("Symbolic links"), "{error}");
    assert!(fs::read_dir(&outside).unwrap().next().is_none());
    assert_eq!(staged_files(&store, "writer"), 0);
    // Revocation between the last chunk and the commit.
    let begun = tool(&store, "writer", "write_begin", json!({"path":"src/late.txt","expect_version":"absent"})).unwrap();
    let upload = begun["upload_id"].as_str().unwrap().to_owned();
    tool(&store, "writer", "write_chunk", json!({"upload_id":upload,"offset":0,"content":"late\n"})).unwrap();
    owner_api(&store, "grant-revoke", &json!({"id":grant.id}), Path::new(CLI)).unwrap();
    assert!(tool(&store, "writer", "write_commit", json!({"upload_id":upload})).is_err());
    // Even past tool authorization, the commit rechecks the persisted grant.
    let r = store.read().unwrap().requests["writer"].clone();
    let error = files_io::commit(&store, "writer", &r, project, &json!({"upload_id":upload})).unwrap_err();
    assert_eq!(error.to_string(), "Request stopped");
    assert!(!project.join("src/late.txt").exists());
    // The worker's final transition, then recover(), leave no staged data behind.
    let second = tool(&store, "writer", "write_begin", json!({"path":"src/x.txt","expect_version":"absent"}));
    assert!(second.is_err());
    fs::create_dir_all(store.root.join("staging/writer")).unwrap();
    fs::write(store.root.join("staging/writer/orphan.part"), "left").unwrap();
    store.transaction(|s| { s.requests.get_mut("writer").unwrap().transition("cancelled", json!({})); Ok(()) }).unwrap();
    recover(&store).unwrap();
    assert!(!store.root.join("staging/writer").exists());
}

#[test]
fn tool_calls_are_counted_and_legacy_grants_keep_04_file_tools() {
    let (_temp, store, grant) = fixture(false, Finite(2));
    running(&store, &grant, "counted", "question");
    fs::write(Path::new(&grant.project).join("src/a.txt"), "a, b\n").unwrap();
    let read = json!({"path":"src/a.txt"});
    tool(&store, "counted", "read_file", read.clone()).unwrap();
    tool(&store, "counted", "messages", json!({"id":"counted"})).unwrap();
    tool(&store, "counted", "read_file", read.clone()).unwrap();
    let error = tool(&store, "counted", "read_file", read.clone()).unwrap_err().to_string();
    assert_eq!(error, "OWNER_LIMIT: tool-call budget reached (max_mcp_calls 2 on this authorization). Create a new authorization with a higher Maximum tool calls.");
    let r = store.read().unwrap().requests["counted"].clone();
    assert_eq!((r.mcp_calls_used, r.events.iter().filter(|e| e.kind == "mcp-call").count()), (Some(2), 3));
    assert!(tool(&store, "counted", "write_file", json!({"path":"src/a.txt","content":"x"})).unwrap_err().to_string().contains("budget reached"));

    let (_temp, store, grant) = fixture(true, Unlimited);
    running(&store, &grant, "legacy", "delegate");
    let src = Path::new(&grant.project).join("src");
    fs::write(src.join("big.txt"), "x".repeat(262_145)).unwrap();
    fs::write(src.join("small.txt"), "x, y\n").unwrap();
    assert_eq!(tool(&store, "legacy", "read_file", json!({"path":"src/big.txt"})).unwrap_err().to_string(), "Read requires a UTF-8 file of at most 256 KiB");
    assert_eq!(tool(&store, "legacy", "read_file", json!({"path":"src/small.txt","offset":2})).unwrap(), json!({"path":"src/small.txt","content":"x, y\n"}));
    let error = tool(&store, "legacy", "write_file", json!({"path":"src/big.txt","content":"x".repeat(262_145)})).unwrap_err();
    assert_eq!(error.to_string(), "File too large or contains a recognizable credential");
    let written = tool(&store, "legacy", "write_file", json!({"path":"src/small.txt","content":"z\n"})).unwrap();
    assert_eq!(written, json!({"path":"src/small.txt","sha256":hash("z\n"),"bytes":2,"merged":false}));
    let error = tool(&store, "legacy", "write_begin", json!({"path":"src/n.txt","expect_version":"absent"})).unwrap_err();
    assert!(error.to_string().starts_with("write_begin is not available to an authorization created before CodaClauda 0.5"));
    let names = |legacy| mcp::tools_list(legacy).as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert!(names(false).contains(&"write_commit".to_owned()) && !names(true).iter().any(|n| n.starts_with("write_") && n != "write_file"));
    // 128 calls, counting polls such as messages.
    store.transaction(|s| { s.requests.get_mut("legacy").unwrap().mcp_calls_used = Some(127); Ok(()) }).unwrap();
    tool(&store, "legacy", "messages", json!({"id":"legacy"})).unwrap();
    let error = tool(&store, "legacy", "messages", json!({"id":"legacy"})).unwrap_err();
    assert_eq!(error.to_string(), "Owner tool-call budget reached; stop and report remaining work");
}
