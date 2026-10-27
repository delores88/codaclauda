//! Optional Spark Dev Bridge integration through its public executable only.
//!
//! The caller owns authorization, durable request IDs, job ownership and receipt
//! redaction. This module never opens Spark Dev Bridge's configuration or state.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Map, Value};
use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
const LOG_LIMIT: u64 = 1024 * 1024;
static FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

// A child can retain Windows filesystem redirection even when
// GetCurrentPackageFullName reports APPMODEL_ERROR_NO_PACKAGE. Compare the
// owner's recorded target with the actual resolved file, not package identity
// or two freshly canonicalized paths (both could resolve to the stale copy).
#[cfg(windows)]
fn windows_path_key(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let path: Vec<_> = path
        .as_os_str()
        .encode_wide()
        .map(|c| if c == b'/' as u16 { b'\\' as u16 } else { c })
        .collect();
    if path.len() >= 8
        && windows_path_equal(&path[..8], &r"\\?\UNC\".encode_utf16().collect::<Vec<_>>())
    {
        [vec![b'\\' as u16; 2], path[8..].to_vec()].concat()
    } else if path.starts_with(&r"\\?\".encode_utf16().collect::<Vec<_>>()) {
        path[4..].to_vec()
    } else {
        path
    }
}

#[cfg(windows)]
fn windows_path_equal(left: &[u16], right: &[u16]) -> bool {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CompareStringOrdinal(
            a: *const u16,
            a_len: i32,
            b: *const u16,
            b_len: i32,
            ignore_case: i32,
        ) -> i32;
    }
    let (Ok(a_len), Ok(b_len)) = (i32::try_from(left.len()), i32::try_from(right.len())) else {
        return false;
    };
    // CSTR_EQUAL. An API failure also fails closed. Keep UTF-16 intact, including
    // filenames that cannot be represented by a lossless Rust String.
    unsafe { CompareStringOrdinal(left.as_ptr(), a_len, right.as_ptr(), b_len, 1) == 2 }
}

#[cfg(windows)]
fn package_cache_path(path: &Path) -> bool {
    let path = windows_path_key(path);
    let parts: Vec<_> = path.split(|c| *c == b'\\' as u16).collect();
    let matches = |part: &[u16], expected: &str| {
        windows_path_equal(part, &expected.encode_utf16().collect::<Vec<_>>())
    };
    parts.windows(5).any(|p| {
        matches(p[0], "appdata")
            && matches(p[1], "local")
            && matches(p[2], "packages")
            && !p[3].is_empty()
            && matches(p[4], "localcache")
    })
}

#[cfg(windows)]
fn check_windows_target(requested: &Path, resolved: &Path, configuring: bool) -> Result<()> {
    let same = windows_path_equal(&windows_path_key(requested), &windows_path_key(resolved));
    if configuring {
        ensure!(
            same || !package_cache_path(resolved),
            "Windows redirected the selected DGXBridge executable into a packaged app's private LocalCache. The saved bridge path was not changed. When existing chats are idle, close CodaClauda and open its installed shortcut from Windows Explorer, then save the installed bridge executable again."
        );
    } else {
        ensure!(
            same,
            "Windows resolved the saved DGXBridge executable to a different file. CodaClauda did not start that copy. When existing chats are idle, close CodaClauda and open its installed shortcut from Windows Explorer, then check the bridge connection. If the installed bridge moved, explicitly save its new executable in Agent setup."
        );
    }
    Ok(())
}

pub(crate) fn configured_executable(requested: &Path) -> Result<PathBuf> {
    let resolved = requested
        .canonicalize()
        .context("Could not resolve Spark executable")?;
    ensure!(resolved.is_file(), "Spark executable missing");
    #[cfg(windows)]
    check_windows_target(requested, &resolved, true)?;
    Ok(resolved)
}

struct Prepared {
    argv: Vec<OsString>,
    workload: Option<Vec<String>>,
    timeout: Duration,
}

fn string<'a>(object: &'a Map<String, Value>, field: &str) -> Result<&'a str> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .with_context(|| format!("Spark argument {field} must be a nonempty string without NUL"))
}

fn identifier(value: &str, label: &str, maximum: usize) -> Result<()> {
    ensure!(
        !value.is_empty()
            && !value.starts_with('-')
            && value.len() <= maximum
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "Invalid Spark {label}"
    );
    Ok(())
}

fn number(object: &Map<String, Value>, field: &str, default: u64, max: u64) -> Result<u64> {
    match object.get(field) {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .filter(|value| *value <= max)
            .with_context(|| format!("Spark argument {field} must be an integer from 0 to {max}")),
    }
}

fn prepare(client: &str, operation: &str, arguments: &Value, workspace: &Path) -> Result<Prepared> {
    ensure!(
        matches!(client, "codex" | "claude" | "human"),
        "Unsupported Spark client identity"
    );
    let allowed: &[&str] = match operation {
        "run" => &["argv", "where", "runtime", "request_id", "no_cache"],
        "status" => &[],
        "wait" => &["job", "timeout"],
        "logs" => &["job", "since", "limit"],
        "cancel" => &["job"],
        _ => bail!("Unsupported Spark operation"),
    };
    let object = arguments
        .as_object()
        .context("Spark arguments must be a JSON object")?;
    ensure!(
        object.keys().all(|key| allowed.contains(&key.as_str())),
        "Unexpected Spark argument"
    );
    let mut argv: Vec<OsString> = ["--json", "--client", client, operation]
        .into_iter()
        .map(OsString::from)
        .collect();
    let mut workload = None;
    let timeout = match operation {
        "run" => {
            let requested = string(object, "request_id")?;
            identifier(requested, "request identifier", 128)?;
            let placement = match object.get("where") {
                None => "auto",
                Some(_) => string(object, "where")?,
            };
            ensure!(
                matches!(placement, "auto" | "laptop" | "spark"),
                "Invalid Spark placement"
            );
            let values = object
                .get("argv")
                .and_then(Value::as_array)
                .filter(|values| !values.is_empty() && values.len() <= 1024)
                .context("Spark argv must contain 1 to 1024 strings")?;
            let mut bytes = 0usize;
            let mut exact = Vec::with_capacity(values.len());
            for (index, value) in values.iter().enumerate() {
                let arg = value.as_str().context("Spark argv must contain strings")?;
                ensure!(
                    !arg.contains('\0') && (index != 0 || !arg.is_empty()),
                    "Spark argv contains an invalid argument"
                );
                bytes = bytes
                    .checked_add(arg.len())
                    .context("Spark argv is too large")?;
                ensure!(bytes <= 65536, "Spark argv exceeds 65536 bytes");
                exact.push(arg.to_owned());
            }
            argv.push(workspace.as_os_str().to_owned());
            argv.extend(
                ["--detach", "--where", placement, "--request-id", requested].map(OsString::from),
            );
            if object.contains_key("runtime") {
                let runtime = string(object, "runtime")?;
                identifier(runtime, "runtime name", 64)?;
                argv.extend([OsString::from("--runtime"), OsString::from(runtime)]);
            }
            match object.get("no_cache") {
                Some(Value::Bool(true)) => argv.push(OsString::from("--no-cache")),
                Some(Value::Bool(false)) | None => {}
                Some(_) => bail!("Spark no_cache must be boolean"),
            }
            workload = Some(exact);
            Duration::from_secs(120)
        }
        "status" => {
            argv.push(OsString::from("--all"));
            Duration::from_secs(45)
        }
        _ => {
            let job = string(object, "job")?;
            identifier(job, "job identifier", 128)?;
            argv.push(OsString::from(job));
            if operation == "wait" {
                let seconds = number(object, "timeout", 10, 60)?;
                argv.extend([
                    OsString::from("--timeout"),
                    OsString::from(seconds.to_string()),
                ]);
                // Spark also performs connection setup. This adapter retains its
                // own stricter upper bound even if upstream transport is slower.
                Duration::from_secs((seconds + 30).min(75))
            } else {
                if operation == "logs" {
                    let since = number(object, "since", 0, u64::MAX)?;
                    let limit = number(object, "limit", LOG_LIMIT, LOG_LIMIT)?;
                    ensure!(limit > 0, "Spark log limit must be positive");
                    argv.extend([
                        OsString::from("--since"),
                        OsString::from(since.to_string()),
                        OsString::from("--limit"),
                        OsString::from(limit.to_string()),
                    ]);
                }
                Duration::from_secs(45)
            }
        }
    };
    Ok(Prepared {
        argv,
        workload,
        timeout,
    })
}

/// Only this successfully created file is removed; scratch itself is preserved.
struct ArgFile(PathBuf);
impl Drop for ArgFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn arg_file(scratch: &Path, workload: &[String]) -> Result<ArgFile> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("System clock is unavailable")?
        .as_nanos();
    let serial = FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = scratch.join(format!(
        "spark-argv-{}-{stamp}-{serial}.json",
        std::process::id()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    // Windows inherits the owner's protected CodaClauda state-directory ACL.
    // The caller must not supply a shared or project-owned scratch directory.
    let mut file: File = options
        .open(&path)
        .context("Could not create private Spark argv file")?;
    let guard = ArgFile(path);
    let bytes = serde_json::to_vec(workload).context("Could not encode Spark argv")?;
    file.write_all(&bytes)
        .context("Could not write Spark argv file")?;
    file.sync_all()
        .context("Could not persist Spark argv file")?;
    drop(file);
    Ok(guard)
}

fn read_pipe(
    mut pipe: impl Read + Send + 'static,
    count: Arc<AtomicUsize>,
    exceeded: Arc<AtomicBool>,
) -> mpsc::Receiver<io::Result<Vec<u8>>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let result = (|| {
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 8192];
            loop {
                let n = match pipe.read(&mut buffer) {
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    other => other?,
                };
                if n == 0 {
                    return Ok(bytes);
                }
                let previous = count.fetch_add(n, Ordering::Relaxed);
                if previous.saturating_add(n) > OUTPUT_LIMIT {
                    exceeded.store(true, Ordering::Release);
                    return Err(io::Error::other("Spark output limit exceeded"));
                }
                bytes.extend_from_slice(&buffer[..n]);
            }
        })();
        let _ = sender.send(result);
    });
    receiver
}

fn poll_pipe(
    receiver: &mpsc::Receiver<io::Result<Vec<u8>>>,
    value: &mut Option<Vec<u8>>,
) -> Result<()> {
    if value.is_none() {
        match receiver.try_recv() {
            Ok(Ok(bytes)) => *value = Some(bytes),
            Ok(Err(_)) => bail!("Could not capture bounded Spark output"),
            Err(mpsc::TryRecvError::Empty) => {}
            Err(mpsc::TryRecvError::Disconnected) => {
                bail!("Spark output reader stopped unexpectedly")
            }
        }
    }
    Ok(())
}

fn decode(status: ExitStatus, stdout: &[u8]) -> Result<Value> {
    // Neither malformed stdout nor stderr is copied into errors: it can contain
    // project input, command arguments or provider diagnostics with credentials.
    ensure!(
        status.success(),
        "Spark control request failed (process exit {:?}); retain the request ID and inspect job status before retrying",
        status.code()
    );
    let value: Value = serde_json::from_slice(stdout)
        .context("Spark returned malformed JSON; response withheld")?;
    ensure!(
        value.is_object(),
        "Spark returned an unexpected JSON shape; response withheld"
    );
    ensure!(
        value.get("ok") == Some(&Value::Bool(true)),
        "Spark reported a control error; response withheld"
    );
    Ok(value)
}

/// Invoke a bounded operation using exact argv and the owner's chosen executable.
///
/// The caller MUST validate scope and job ownership, persist request_id before
/// submission, and redact returned provider content before exposing receipts.
/// Scratch MUST be an owner-private state directory outside the project.
/// Timeout does not imply the submitted job stopped or never started.
pub fn invoke(
    executable: &Path,
    client: &str,
    operation: &str,
    arguments: &Value,
    workspace: &Path,
    scratch: &Path,
) -> Result<Value> {
    ensure!(
        executable.is_absolute() && executable.is_file(),
        "Configure an absolute Spark executable path"
    );
    #[cfg(windows)]
    {
        ensure!(
            executable
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("exe")),
            "Spark executable must be a native Windows executable"
        );
        let resolved = executable
            .canonicalize()
            .context("Could not resolve saved Spark executable")?;
        check_windows_target(executable, &resolved, false)?;
    }
    ensure!(
        workspace.is_absolute() && workspace.is_dir(),
        "Spark workspace must be an absolute project directory"
    );
    let workspace = fs::canonicalize(workspace).context("Could not resolve Spark workspace")?;
    let mut prepared = prepare(client, operation, arguments, &workspace)?;
    let _arg_guard = if let Some(workload) = prepared.workload.as_ref() {
        ensure!(
            scratch.is_absolute() && scratch.is_dir(),
            "Spark scratch must be an existing private directory"
        );
        let scratch = fs::canonicalize(scratch)
            .context("Could not resolve private Spark scratch directory")?;
        ensure!(
            !scratch.starts_with(&workspace),
            "Spark scratch must be outside the submitted project"
        );
        let file = arg_file(&scratch, workload)?;
        prepared.argv.push(OsString::from("--argv-json"));
        prepared.argv.push(file.0.as_os_str().to_owned());
        Some(file)
    } else {
        None
    };
    let mut command = Command::new(executable);
    command
        .args(&prepared.argv)
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Spark owns its authentication. It has no need for the coordination
    // capability or any other private CodaClauda runtime environment fields.
    for (name, _) in std::env::vars_os() {
        if name
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("CODACLAUDA_")
        {
            command.env_remove(name);
        }
    }
    command.env_remove("CODACLAUDA_CAPABILITY");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .context("Could not start the configured Spark executable")?;
    let count = Arc::new(AtomicUsize::new(0));
    let exceeded = Arc::new(AtomicBool::new(false));
    let stdout = read_pipe(
        child
            .stdout
            .take()
            .context("Spark stdout pipe is unavailable")?,
        count.clone(),
        exceeded.clone(),
    );
    let stderr = read_pipe(
        child
            .stderr
            .take()
            .context("Spark stderr pipe is unavailable")?,
        count,
        exceeded.clone(),
    );
    let started = Instant::now();
    let mut output = None;
    let mut diagnostic = None;
    let result = (|| {
        let mut exit = None;
        loop {
            ensure!(
                !exceeded.load(Ordering::Acquire),
                "Spark output exceeded the 4 MiB limit; response withheld"
            );
            ensure!(
                started.elapsed() < prepared.timeout,
                "Spark adapter timeout; submission outcome may be unknown. Retain the same request ID and inspect status before retrying"
            );
            poll_pipe(&stdout, &mut output)?;
            poll_pipe(&stderr, &mut diagnostic)?;
            if exit.is_none() {
                exit = child
                    .try_wait()
                    .context("Could not inspect owned Spark CLI process")?;
            }
            if let (Some(status), Some(output), Some(_)) =
                (exit, output.as_ref(), diagnostic.as_ref())
            {
                return decode(status, output);
            }
            thread::sleep(Duration::from_millis(20));
        }
    })();
    if result.is_err() {
        // This is the owned CLI handle only. Spark owns detached workers/jobs.
        // Do not kill a process tree or close a kill-on-close job on normal exit.
        let _ = child.kill();
        // Reap without extending the public deadline if the OS delays shutdown.
        thread::spawn(move || {
            let _ = child.wait();
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[cfg(windows)]
    mod windows_targets {
        use super::*;
        const ORDINARY: &str = r"C:\Users\Owner\AppData\Local\DGXBridge\bin\sparkdev.exe";
        const REDIRECTED: &str = r"\\?\C:\Users\Owner\AppData\Local\Packages\Example.Host_123\LocalCache\Local\DGXBridge\bin\sparkdev.exe";
        fn check_windows_target(requested: &str, resolved: &str, configuring: bool) -> Result<()> {
            super::check_windows_target(Path::new(requested), Path::new(resolved), configuring)
        }
        fn package_cache_path(path: &str) -> bool {
            super::package_cache_path(Path::new(path))
        }

        #[test]
        fn rejects_redirected_binding_before_bridge_launch() {
            let error = check_windows_target(ORDINARY, REDIRECTED, false).unwrap_err();
            assert!(error.to_string().contains("did not start that copy"));
            assert!(check_windows_target(REDIRECTED, ORDINARY, false).is_err());
        }

        #[test]
        fn configuration_does_not_silently_save_package_cache_redirection() {
            let error = check_windows_target(ORDINARY, REDIRECTED, true).unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("saved bridge path was not changed")
            );
            // Explicit owner choices remain explicit; there is no inferred fallback.
            assert!(check_windows_target(REDIRECTED, REDIRECTED, true).is_ok());
            assert!(
                check_windows_target(
                    REDIRECTED,
                    &REDIRECTED.replace("Example.Host_123", "Other.Host_456"),
                    true
                )
                .is_err()
            );
            assert!(check_windows_target(ORDINARY, ORDINARY, true).is_ok());
        }

        #[test]
        fn binding_identity_allows_windows_case_and_verbatim_prefixes_only() {
            assert!(
                check_windows_target(
                    ORDINARY,
                    &format!(r"\\?\{}", ORDINARY.to_uppercase()),
                    false
                )
                .is_ok()
            );
            assert!(
                check_windows_target(
                    "C:/Bridge/sparkdev.exe",
                    r"\\?\c:\bridge\sparkdev.exe",
                    false
                )
                .is_ok()
            );
            assert!(
                check_windows_target(
                    r"\\server\share\sparkdev.exe",
                    r"\\?\UNC\SERVER\share\sparkdev.exe",
                    false
                )
                .is_ok()
            );
            assert!(check_windows_target(ORDINARY, r"C:\Other\sparkdev.exe", false).is_err());
            assert!(
                check_windows_target(
                    ORDINARY,
                    r"\\localhost\C$\Users\Owner\AppData\Local\DGXBridge\bin\sparkdev.exe",
                    false
                )
                .is_err()
            );
        }

        #[test]
        fn package_cache_detection_uses_components_and_preserves_normal_links() {
            assert!(package_cache_path(
                &REDIRECTED.to_uppercase().replace('\\', "/")
            ));
            assert!(!package_cache_path(
                r"C:\work\packages\Example\LocalCache\sparkdev.exe"
            ));
            assert!(!package_cache_path(
                r"C:\Users\Owner\AppData\Local\Packages\Example\LocalCacheBackup\sparkdev.exe"
            ));
            assert!(check_windows_target(r"C:\BridgeLink\sparkdev.exe", ORDINARY, true).is_ok());
        }

        #[test]
        fn windows_identity_preserves_non_ascii_and_unpaired_utf16() {
            use std::os::windows::ffi::OsStringExt;
            assert!(
                check_windows_target(r"C:\Üser\sparkdev.exe", r"\\?\c:\üser\SPARKDEV.EXE", false)
                    .is_ok()
            );
            let left = PathBuf::from(OsString::from_wide(&[67, 58, 92, 0xd800, 92, 97]));
            let right = PathBuf::from(OsString::from_wide(&[67, 58, 92, 0xd801, 92, 97]));
            assert!(super::check_windows_target(&left, &left, false).is_ok());
            assert!(super::check_windows_target(&left, &right, false).is_err());
        }
    }

    #[test]
    fn prepares_exact_workload_without_shell_interpolation() {
        let values = json!({"request_id":"request-1","where":"laptop","runtime":"python","argv":["python","-c","print('$literal; & text')","","two words","quotes\"inside"]});
        let result = prepare("codex", "run", &values, Path::new("C:/project with spaces")).unwrap();
        assert_eq!(
            result.workload.unwrap(),
            vec![
                "python",
                "-c",
                "print('$literal; & text')",
                "",
                "two words",
                "quotes\"inside"
            ]
        );
        assert_eq!(result.argv[4], OsString::from("C:/project with spaces"));
        assert!(result.argv.contains(&OsString::from("--detach")));
        assert_eq!(result.timeout, Duration::from_secs(120));
    }

    #[test]
    fn rejects_scope_override_and_unbounded_parameters() {
        let root = Path::new("C:/project");
        for (operation, values) in [
            ("status", json!({"client":"claude"})),
            ("cancel", json!({"job":"--help"})),
            ("wait", json!({"job":"--version"})),
            ("wait", json!({"job":"abc","timeout":61})),
            ("wait", json!({"job":"abc","timeout":-1})),
            ("logs", json!({"job":"abc","limit":1048577})),
            ("logs", json!({"job":"abc","limit":0})),
            (
                "run",
                json!({"argv":["python"],"request_id":"one","dir":"another-project"}),
            ),
            ("run", json!({"argv":["python"]})),
            ("run", json!({"argv":["python",null],"request_id":"one"})),
            ("run", json!({"argv":["python"],"request_id":"--help"})),
            (
                "run",
                json!({"argv":["python"],"request_id":"one","runtime":"--help"}),
            ),
        ] {
            assert!(
                prepare("codex", operation, &values, root).is_err(),
                "accepted invalid {operation} fixture"
            );
        }
        assert!(prepare("codex", "setup", &json!({}), root).is_err());
        assert!(prepare("owner-admin", "status", &json!({}), root).is_err());
    }

    #[test]
    fn bounds_wait_and_log_cursors_without_truncation() {
        let root = Path::new("C:/project");
        let wait = prepare("claude", "wait", &json!({"job":"abc","timeout":60}), root).unwrap();
        assert_eq!(wait.timeout, Duration::from_secs(75));
        let logs = prepare(
            "claude",
            "logs",
            &json!({"job":"abc","since":u64::MAX,"limit":1}),
            root,
        )
        .unwrap();
        assert!(logs.argv.contains(&OsString::from(u64::MAX.to_string())));
    }

    #[test]
    fn rejects_oversized_and_nul_workloads() {
        let root = Path::new("C:/project");
        for argv in [
            json!(["python", "bad\u{0}argument"]),
            json!(["python", "x".repeat(65536)]),
            json!([""]),
        ] {
            assert!(
                prepare(
                    "codex",
                    "run",
                    &json!({"argv":argv,"request_id":"one"}),
                    root
                )
                .is_err()
            );
        }
    }
}
