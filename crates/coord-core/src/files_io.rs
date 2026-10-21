//! Project file tools for MCP (C9). A read streams the whole file once for its
//! version and private-key markers and keeps only the window and its redaction
//! context. Writes are checked by the same credential rules and replace the
//! file atomically; staged uploads carry a file of any size in frames of at most
//! 8 MiB. Grants created before 0.5 keep their whole-file 256 KiB tools (C3).
use super::*;
use anyhow::anyhow;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::io::{self, Read};

pub const READ_DEFAULT: u64 = 64 << 10;
/// Largest window and largest single write body: the 8 MiB transport frame.
pub const FRAME: u64 = 8 << 20;
/// Distance searched for a separator on each side of a read window.
const CONTEXT: u64 = 1 << 20;
const STREAM: usize = 1 << 20;
/// Longest separator-free stretch a write may contain (bounded scan memory).
const WRITE_RUN_LIMIT: usize = 8 << 20;
const STAGED_ONLY: &str = "is not available to an authorization created before CodaClauda 0.5; use write_file (at most 256 KiB) or create a new authorization";

#[derive(Clone, PartialEq)]
enum Identity {
    Absent,
    /// "sha256:<hex>"
    Version(String),
}
impl Identity {
    fn label(&self) -> &str {
        match self {
            Identity::Absent => "absent",
            Identity::Version(version) => version,
        }
    }
}

fn expect_version(a: &Value, absent: bool) -> Result<Option<Identity>> {
    let Some(value) = a.get("expect_version").filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let text = value.as_str().unwrap_or_default();
    if absent && text == "absent" {
        return Ok(Some(Identity::Absent));
    }
    match text.strip_prefix("sha256:") {
        Some(hex) if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) => {
            Ok(Some(Identity::Version(format!("sha256:{}", hex.to_ascii_lowercase()))))
        }
        _ if absent => bail!("expect_version must be \"sha256:<64 hex digits>\" from read_file, or \"absent\" for a new file"),
        _ => bail!("expect_version must be \"sha256:<64 hex digits>\" from read_file"),
    }
}

fn file_version(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; STREAM];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => digest.update(&buffer[..n]),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
}

fn identity(path: &Path) -> Result<Identity> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Identity::Absent),
        Err(e) => Err(e.into()),
        Ok(meta) if meta.is_file() => Ok(Identity::Version(file_version(path)?)),
        Ok(_) => bail!("Write target is not a regular file"),
    }
}

/// Grants created before 0.5: whole files of at most 256 KiB, as in 0.4.0.
pub(crate) fn legacy_read(workspace: &Path, g: &Grant, a: &Value) -> Result<Value> {
    let path = paths::authorized(workspace, field(a, "path")?, &g.allowed_paths, false)?;
    ensure!(
        path.is_file() && fs::metadata(&path)?.len() <= LEGACY_FILE_BYTES,
        "Read requires a UTF-8 file of at most 256 KiB"
    );
    let text = String::from_utf8(fs::read(&path)?).context("File is not UTF-8")?;
    Ok(json!({"path":a["path"],"content":redact(&text)}))
}

pub(crate) fn read(workspace: &Path, g: &Grant, a: &Value, measure: &dyn Fn(&Value) -> usize) -> Result<Value> {
    let display = field(a, "path")?;
    let path = paths::authorized(workspace, display, &g.allowed_paths, false)?;
    ensure!(path.is_file(), "Read requires a UTF-8 file");
    let offset = bound(a, "offset", 0, 0, u64::MAX)?;
    let max_bytes = bound(a, "max_bytes", READ_DEFAULT, 1, FRAME)?;
    let expect = match expect_version(a, false)? {
        Some(Identity::Version(version)) => Some(version),
        _ => None,
    };
    read_window(&path, display, offset, max_bytes, expect.as_deref(), measure)
}

/// End of a window of at most `limit` bytes from `from` (indices into `kept`).
/// Before the end of the file it stops after its last line break, else on a
/// character boundary, and it always advances.
fn window_end(kept: &[u8], from: usize, limit: u64, offset: u64, size: u64) -> usize {
    let continuation = |i: usize| kept.get(i).is_some_and(|b| b & 0xC0 == 0x80);
    let mut end = (from + limit as usize).min(kept.len());
    if offset + ((end - from) as u64) < size {
        if let Some(newline) = kept[from..end].iter().rposition(|b| *b == b'\n') {
            end = from + newline + 1;
        } else {
            let mut boundary = end;
            while boundary > from && continuation(boundary) {
                boundary -= 1;
            }
            if boundary == from {
                boundary = end;
                while continuation(boundary) {
                    boundary += 1;
                }
            }
            end = boundary;
        }
    }
    end
}

/// One redacted window. `measure` gives the size of the MCP response line that
/// would carry it; the window shrinks until that fits the transport frame.
pub(crate) fn read_window(
    path: &Path,
    display: &str,
    offset: u64,
    max_bytes: u64,
    expect: Option<&str>,
    measure: &dyn Fn(&Value) -> usize,
) -> Result<Value> {
    let reach = offset.saturating_add(max_bytes).saturating_add(3);
    let (lo, hi) = (offset.saturating_sub(CONTEXT), reach.saturating_add(CONTEXT));
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut pem = secrets::PemScanner::new(offset, reach);
    let mut kept = Vec::new();
    let mut size = 0u64;
    let mut buffer = vec![0; STREAM];
    loop {
        let n = match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.into()),
        };
        let chunk = &buffer[..n];
        digest.update(chunk);
        pem.feed(chunk);
        let end = size + n as u64;
        let (a, b) = (size.max(lo), end.min(hi));
        if a < b {
            kept.extend_from_slice(&chunk[(a - size) as usize..(b - size) as usize]);
        }
        size = end;
    }
    let blocks = pem.finish(size);
    let version = format!("sha256:{:x}", digest.finalize());
    if let Some(expected) = expect {
        ensure!(
            expected == version,
            "FILE_CHANGED: {display} changed since you started reading; start again from offset 0."
        );
    }
    ensure!(offset <= size, "offset {offset} is beyond the end of the file (size {size} bytes)");
    if offset == size {
        return Ok(json!({"path":display,"content":"","offset":offset,"next_offset":null,"size":size,"eof":true,"version":version}));
    }
    let from = (offset - lo) as usize;
    ensure!(
        offset == 0 || kept[from] & 0xC0 != 0x80,
        "offset {offset} is inside a UTF-8 character; continue from a returned next_offset"
    );
    let separator = |b: &u8| secrets::is_separator(*b);
    let context_start = if secrets::is_separator(kept[from]) {
        from
    } else {
        match kept[..from].iter().rposition(separator) {
            Some(i) => i + 1,
            None if lo == 0 => 0,
            None => return Err(secrets::unverifiable(offset)),
        }
    };
    let mut limit = max_bytes.min(size - offset);
    let mut previous = usize::MAX;
    loop {
        let mut end = window_end(&kept, from, limit, offset, size);
        let context_end = if lo + end as u64 == size || secrets::is_separator(kept[end - 1]) {
            end
        } else {
            let ahead = &kept[end..kept.len().min(end + CONTEXT as usize)];
            match ahead.iter().position(separator) {
                Some(i) => end + i,
                None if lo + (end + ahead.len()) as u64 == size => end + ahead.len(),
                // Stop just after the window's last separator so the read still advances.
                None => match kept[from..end].iter().rposition(separator) {
                    Some(i) => {
                        end = from + i + 1;
                        end
                    }
                    None => return Err(secrets::unverifiable(lo + end as u64)),
                },
            }
        };
        ensure!(end - from < previous, "read_file window cannot fit the response frame");
        previous = end - from;
        let text = std::str::from_utf8(&kept[from..end]).ok().context("File is not UTF-8")?;
        let content = secrets::redact_window(&kept[context_start..from], text, &kept[end..context_end], offset, &blocks);
        let next = offset + (end - from) as u64;
        let eof = next >= size;
        let value = json!({"path":display,"content":content,"offset":offset,"next_offset":if eof {Value::Null} else {json!(next)},"size":size,"eof":eof,"version":version});
        let used = measure(&value);
        if used as u64 <= FRAME {
            return Ok(value);
        }
        // JSON escaping grew the response past the frame: shrink in proportion.
        let len = (end - from) as u64;
        limit = ((len as u128 * FRAME as u128 * 9 / 10 / used as u128) as u64).clamp(1, len.saturating_sub(1).max(1));
    }
}

fn ensure_running(s: &State, request: &str) -> Result<()> {
    let rr = s.requests.get(request).context("Request scope unavailable")?;
    ensure!(
        !rr.cancel_requested
            && !rr.terminal()
            && s.grants.get(&rr.grant_id).is_some_and(|g| g.is_active(now())),
        "Request stopped"
    );
    Ok(())
}

fn check_identity(path: &Path, display: &str, expected: &Identity) -> Result<()> {
    let current = identity(path)?;
    ensure!(
        &current == expected,
        "FILE_CHANGED: {display} is {} but expect_version is {}; read it again before writing.",
        current.label(),
        expected.label()
    );
    Ok(())
}

/// One-frame write. Legacy grants keep the 0.4.0 checks and response.
pub(crate) fn write(store: &Store, request: &str, g: &Grant, workspace: &Path, a: &Value) -> Result<Value> {
    let content = a["content"].as_str().context("content must be text")?;
    let legacy = g.is_legacy();
    let expect = if legacy {
        ensure!(
            content.len() as u64 <= LEGACY_FILE_BYTES && redact(content) == content,
            "File too large or contains a recognizable credential"
        );
        None
    } else {
        ensure!(
            content.len() as u64 <= FRAME,
            "write_file content is {} bytes; one write_file is limited to 8 MiB ({FRAME} bytes). Use write_begin, write_chunk and write_commit for larger files.",
            content.len()
        );
        let mut scan = secrets::WriteScan::new(usize::MAX);
        scan.feed(content.as_bytes())?;
        scan.finish()?;
        expect_version(a, true)?
    };
    let display = field(a, "path")?;
    let path = paths::authorized(workspace, display, &g.allowed_paths, true)?;
    // Serialize against cancellation and revocation so a stopped request cannot start another write.
    store.transaction(|s| {
        ensure_running(s, request)?;
        if let Some(expected) = &expect {
            check_identity(&path, display, expected)?;
        }
        let mut temporary = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        temporary.write_all(content.as_bytes())?;
        temporary.as_file().sync_all()?;
        temporary.persist(&path).map_err(|e| e.error)?;
        s.requests.get_mut(request).unwrap().event(
            "file-written",
            json!({"path":a["path"],"sha256":hash(content),"bytes":content.len()}),
        );
        Ok(())
    })?;
    let mut result = json!({"path":a["path"],"sha256":hash(content),"bytes":content.len(),"merged":false});
    if !legacy {
        result["version"] = json!(format!("sha256:{}", hash(content)));
    }
    Ok(result)
}

/// A staged upload, bound to its grant, request, authorized path and the
/// identity the target had at write_begin.
#[derive(Serialize, Deserialize)]
struct Upload {
    grant_id: String,
    request_id: String,
    path: String,
    target: PathBuf,
    base: String,
    created_at: u64,
    #[serde(default)]
    outcome: Option<Value>,
}
impl Upload {
    fn base(&self) -> Identity {
        if self.base == "absent" {
            Identity::Absent
        } else {
            Identity::Version(self.base.clone())
        }
    }
}

// One cross-process lock also covers cleanup. Always acquire it before state.lock.
fn staging_lock(root: &Path) -> Result<fs::File> {
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("staging.lock"))?;
    FileExt::lock_exclusive(&lock)?;
    Ok(lock)
}

fn outcome_path(root: &Path, request: &str, upload_id: &str) -> PathBuf {
    root.join("write-results")
        .join(request)
        .join(format!("{upload_id}.json"))
}

fn save_upload(path: &Path, upload: &Upload) -> Result<()> {
    let parent = path.parent().context("Missing upload parent")?;
    fs::create_dir_all(parent)?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(&mut tmp, upload)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

fn staging(root: &Path, request: &str) -> PathBuf {
    root.join("staging").join(request)
}

fn load(root: &Path, r: &Request, upload_id: &str) -> Result<(Upload, PathBuf, PathBuf)> {
    let unknown = || anyhow!("Unknown upload_id {upload_id}; start again with write_begin");
    safe_id(upload_id).map_err(|_| unknown())?;
    let directory = staging(root, &r.id);
    let result = outcome_path(root, &r.id, upload_id);
    let meta = if result.exists() {
        result
    } else {
        directory.join(format!("{upload_id}.json"))
    };
    let upload: Upload = serde_json::from_slice(&fs::read(&meta).map_err(|_| unknown())?)?;
    ensure!(
        upload.request_id == r.id && upload.grant_id == r.grant_id,
        "Upload belongs to a different request"
    );
    Ok((upload, directory.join(format!("{upload_id}.part")), meta))
}

pub(crate) fn begin(
    store: &Store,
    request: &str,
    g: &Grant,
    workspace: &Path,
    a: &Value,
) -> Result<Value> {
    let _staging_lock = staging_lock(&store.root)?;
    ensure!(!g.is_legacy(), "write_begin {STAGED_ONLY}");
    let display = field(a, "path")?;
    let base = expect_version(a, true)?.context(
        "write_begin requires expect_version: \"sha256:<hex>\" from read_file, or \"absent\" for a new file",
    )?;
    let target = paths::authorized(workspace, display, &g.allowed_paths, true)?;
    check_identity(&target, display, &base)?;
    let upload_id = id();
    store.transaction(|s| {
        ensure_running(s, request)?;
        s.requests.get_mut(request).unwrap().event(
            "write-begin",
            json!({"upload_id":upload_id,"path":display,"expect_version":base.label()}),
        );
        Ok(())
    })?;
    let directory = staging(&store.root, request);
    fs::create_dir_all(&directory)?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join(format!("{upload_id}.part")))?;
    let upload = Upload {
        grant_id: g.id.clone(),
        request_id: request.into(),
        path: display.into(),
        target,
        base: base.label().into(),
        created_at: now(),
        outcome: None,
    };
    let mut meta = tempfile::NamedTempFile::new_in(&directory)?;
    serde_json::to_writer(&mut meta, &upload)?;
    meta.as_file().sync_all()?;
    meta.persist(directory.join(format!("{upload_id}.json")))
        .map_err(|e| e.error)?;
    Ok(json!({"upload_id":upload_id,"path":display,"expect_version":upload.base,"staged_bytes":0}))
}

pub(crate) fn chunk(store: &Store, r: &Request, a: &Value) -> Result<Value> {
    let _staging_lock = staging_lock(&store.root)?;
    store.transaction(|state| {
    ensure_running(state, &r.id)?;
    let root = &store.root;
    let upload_id = field(a, "upload_id")?;
    let offset = a.get("offset").and_then(Value::as_u64).context("offset must be a whole number")?;
    let content = a["content"].as_str().context("content must be text")?;
    ensure!(
        content.len() as u64 <= FRAME,
        "write_chunk content is {} bytes; each chunk is limited to 8 MiB ({FRAME} bytes)",
        content.len()
    );
    let (upload, part, _) = load(root, r, upload_id)?;
    ensure!(upload.outcome.is_none(), "Upload already committed or has an unknown outcome; inspect write_commit.");
    let mut file = fs::OpenOptions::new().append(true).open(&part)?;
    let staged = file.metadata()?.len();
    ensure!(
        offset == staged,
        "write_chunk offset {offset} does not match the {staged} bytes staged so far; continue from offset {staged}."
    );
    let total = staged
        .checked_add(content.len() as u64)
        .ok_or_else(|| budget::too_large("offset"))?;
    file.write_all(content.as_bytes())?;
    file.sync_all()?;
    Ok(json!({"upload_id":upload_id,"staged_bytes":total}))
    })
}

fn scan_staged(part: &Path) -> Result<secrets::Scanned> {
    let mut file = fs::File::open(part)?;
    let mut scan = secrets::WriteScan::new(WRITE_RUN_LIMIT);
    let mut buffer = vec![0; STREAM];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => scan.feed(&buffer[..n])?,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e.into()),
        }
    }
    scan.finish()
}

/// Atomic replace. The staged file normally shares the target's volume; if not,
/// it is copied to a hidden temporary file beside the target first.
fn replace(staged: &Path, target: &Path) -> Result<()> {
    fs::OpenOptions::new()
        .write(true)
        .open(staged)?
        .sync_all()?;
    match fs::rename(staged, target) {
        Err(e) if e.kind() == io::ErrorKind::CrossesDevices => {
            let parent = target.parent().context("Missing parent")?;
            let mut temporary = tempfile::Builder::new()
                .prefix(".codaclauda-")
                .tempfile_in(parent)?;
            io::copy(&mut fs::File::open(staged)?, temporary.as_file_mut())?;
            temporary.as_file().sync_all()?;
            temporary.persist(target).map_err(|e| e.error)?;
            Ok(())
        }
        result => Ok(result?),
    }
}

/// Freeze staged bytes through scan and replacement. A durable applying intent
/// precedes the external effect; an ambiguous retry never performs it again.
pub(crate) fn commit(
    store: &Store,
    request: &str,
    r: &Request,
    workspace: &Path,
    a: &Value,
) -> Result<Value> {
    let _staging_lock = staging_lock(&store.root)?;
    let upload_id = field(a, "upload_id")?;
    let (mut upload, part, meta) = load(&store.root, r, upload_id)?;
    let receipt = outcome_path(&store.root, request, upload_id);
    let mut attempted = upload.outcome.is_some();
    let result = (|| {
        // staging.lock freezes the upload, while revocation/cancellation and
        // heartbeat transactions remain available during an unbounded scan.
        let scanned = if upload.outcome.is_none() {
            Some(scan_staged(&part).with_context(|| format!("{} was not written", upload.path))?)
        } else { None };
        store.transaction(|s| {
        ensure_running(s, request)?;
        if let Some(outcome) = &upload.outcome {
            ensure!(outcome["status"] == "completed",
                "WRITE_OUTCOME_UNKNOWN: upload {upload_id} may already have changed {}; inspect the file and retained write receipt before creating another upload.", upload.path);
            // This is the retained result of an earlier effect, not another write.
            let mut result = outcome["result"].clone();
            result["replayed_receipt"] = json!(true);
            return Ok(result);
        }
        let allowed = &s.grants[&r.grant_id].allowed_paths;
        let target = paths::authorized(workspace, &upload.path, allowed, true)?;
        ensure!(target == upload.target,
            "FILE_CHANGED: {} no longer resolves to the authorized location; start a new upload.", upload.path);
        let current = identity(&target)?;
        ensure!(current == upload.base(),
            "FILE_CHANGED: {} changed since write_begin (expected {}, now {}); read it again and start a new upload.",
            upload.path, upload.base, current.label());
        // Target identity verification can itself take time; finite grant
        // expiry must still be checked at the actual replacement boundary.
        ensure_running(s, request)?;
        let scanned = scanned.as_ref().context("Missing frozen upload scan")?;
        let reply = json!({"path":upload.path,"sha256":scanned.sha256,"bytes":scanned.bytes,
            "version":format!("sha256:{}",scanned.sha256),"merged":false});
        upload.outcome = Some(json!({"status":"applying","result":reply}));
        save_upload(&receipt, &upload)?;
        attempted = true;
        replace(&part, &target).with_context(|| format!(
            "WRITE_OUTCOME_UNKNOWN: upload {upload_id} has a retained intent; inspect the target before retrying"))?;
        upload.outcome = Some(json!({"status":"completed","result":reply}));
        save_upload(&receipt, &upload).context("WRITE_OUTCOME_UNKNOWN: file replacement returned success but its completion receipt could not be persisted")?;
        s.requests.get_mut(request).unwrap().event("file-written",
            json!({"path":upload.path,"sha256":scanned.sha256,"bytes":scanned.bytes,"upload_id":upload_id}));
        Ok(reply)
        })
    })();
    if result.is_ok() || !attempted {
        let _ = fs::remove_file(&part);
        // Never remove the durable outcome during ordinary staging cleanup.
        if meta != receipt {
            let _ = fs::remove_file(&meta);
        }
    }
    result.map_err(|e| if attempted {
        e.context(format!("WRITE_OUTCOME_RETAINED: inspect write-results/{request}/{upload_id}.json; do not repeat the effect blindly"))
    } else { e })
}

pub(crate) fn abort(store: &Store, request: &str, r: &Request, a: &Value) -> Result<Value> {
    let _staging_lock = staging_lock(&store.root)?;
    let upload_id = field(a, "upload_id")?;
    store.transaction(|s| {
        ensure_running(s, request)?;
        let (upload, part, meta) = load(&store.root, r, upload_id)?;
        ensure!(
            upload.outcome.is_none(),
            "Upload has a retained write outcome; abort cannot erase it."
        );
        let _ = fs::remove_file(&part);
        fs::remove_file(&meta)?;
        s.requests
            .get_mut(request)
            .unwrap()
            .event("write-aborted", json!({"upload_id":upload_id}));
        Ok(json!({"upload_id":upload_id,"aborted":true}))
    })
}

pub(crate) fn staged_tool(
    store: &Store,
    request: &str,
    name: &str,
    r: &Request,
    g: &Grant,
    workspace: &Path,
    a: &Value,
) -> Result<Value> {
    ensure!(!g.is_legacy(), "{name} {STAGED_ONLY}");
    match name {
        "write_begin" => begin(store, request, g, workspace, a),
        "write_chunk" => chunk(store, r, a),
        "write_commit" => commit(store, request, r, workspace, a),
        "write_abort" => abort(store, request, r, a),
        _ => bail!("Unknown CodaClauda tool"),
    }
}

/// Remove a request's staged uploads (terminal state, launch failure).
pub fn remove_staging(root: &Path, request: &str) -> Result<()> {
    let _staging_lock = staging_lock(root)?;
    match fs::remove_dir_all(staging(root, request)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// recover(): remove staged uploads of every request that is finished or unknown.
pub fn sweep_staging(root: &Path, state: &State) -> Result<()> {
    let _staging_lock = staging_lock(root)?;
    let entries = match fs::read_dir(root.join("staging")) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        entries => entries?,
    };
    for entry in entries {
        let entry = entry?;
        let live = entry
            .file_name()
            .to_str()
            .and_then(|name| state.requests.get(name))
            .is_some_and(|r| !r.terminal());
        if !live {
            fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}
