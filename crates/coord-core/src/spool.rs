//! Request history bounds (C6). Retained events per request stay within 2000
//! events and 1 MiB serialized. Older events are first appended durably to
//! <state>/requests/<id>.events.jsonl and only then removed from state, in the
//! same transaction that records `spilled_through`. A crash between the two may
//! duplicate events in the file; readers de-duplicate by sequence. Large texts
//! are written to <state>/requests/<id>/<name>.txt and kept as a Payload.
use crate::model::{Event, Payload, Request, State};
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub const RETAINED_EVENTS: usize = 2000;
pub const RETAINED_BYTES: usize = 1 << 20;
// Spill to a lower mark so a request at its bound does not sync on every event.
const LOW_EVENTS: usize = 1500;
const LOW_BYTES: usize = 768 << 10;
pub const INLINE_BYTES: usize = 256 << 10;
pub const PREVIEW_BYTES: usize = 16 << 10;

fn request_file_stem(root: &Path, request: &str) -> Result<PathBuf> {
    ensure!(
        !request.is_empty()
            && request.len() <= 80
            && request
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "Invalid request ID"
    );
    Ok(root.join("requests").join(request))
}

pub fn history_path(root: &Path, request: &str) -> Result<PathBuf> {
    Ok(request_file_stem(root, request)?.with_extension("events.jsonl"))
}

fn serialized_len(event: &Event) -> usize {
    serde_json::to_vec(event).map_or(0, |bytes| bytes.len() + 1)
}

/// Length of the file's complete lines, for a history written before the
/// board recorded `spilled_bytes`.
fn complete_len(file: &mut fs::File) -> Result<u64> {
    let mut end = file.metadata()?.len();
    let mut chunk = vec![0u8; 64 << 10];
    while end > 0 {
        let start = end.saturating_sub(chunk.len() as u64);
        let window = &mut chunk[..(end - start) as usize];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(window)?;
        if let Some(i) = window.iter().rposition(|&b| b == b'\n') {
            return Ok(start + i as u64 + 1);
        }
        end = start;
    }
    Ok(0)
}

/// Move the oldest events of every request changed in this transaction out of
/// state once it exceeds either bound. Counters are materialized first so the
/// sequence and lifetime tool-call count never depend on retained events.
pub fn spill_events(root: &Path, state: &mut State) -> Result<()> {
    let mut over = Vec::new();
    for r in state.requests.values().filter(|r| r.touched) {
        let sizes: Vec<usize> = r.events.iter().map(serialized_len).collect();
        let total: usize = sizes.iter().sum();
        if r.events.len() > RETAINED_EVENTS || total > RETAINED_BYTES {
            over.push((r.id.clone(), sizes, total));
        }
    }
    if over.is_empty() {
        return Ok(());
    }
    // History files are named by request ID, and Windows file names ignore
    // case. Submit refuses IDs that differ only in case; a pre-0.5 board may
    // still hold such a pair, and then their events stay in state rather than
    // share one file.
    let mut lowered: BTreeMap<String, usize> = BTreeMap::new();
    for key in state.requests.keys() {
        *lowered.entry(key.to_ascii_lowercase()).or_insert(0) += 1;
    }
    for (id, sizes, total) in over {
        if lowered[&id.to_ascii_lowercase()] > 1 {
            continue;
        }
        let r = state.requests.get_mut(&id).expect("request listed above");
        let (mut count, mut bytes, mut spill) = (r.events.len(), total, 0);
        while spill < sizes.len() && (count > LOW_EVENTS || bytes > LOW_BYTES) {
            count -= 1;
            bytes -= sizes[spill];
            spill += 1;
        }
        let path = history_path(root, &r.id)?;
        fs::create_dir_all(path.parent().unwrap())?;
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)?;
        // Bytes past the length the board recorded are left by a transaction
        // that crashed after its append: a torn line, or events that state
        // never committed. Cut them before appending, so the file holds each
        // committed event exactly once and always ends on a complete line.
        let committed = match (r.spilled_through, r.spilled_bytes) {
            (_, Some(length)) => length,
            (None, None) => 0,
            (Some(_), None) => complete_len(&mut file)?,
        };
        let length = file.metadata()?.len();
        ensure!(
            committed <= length,
            "Event history file {} is shorter than the board records; preserve the board and restore a known backup",
            path.display()
        );
        if committed < length {
            file.set_len(committed)?;
        }
        file.seek(SeekFrom::Start(committed))?;
        let mut lines = Vec::new();
        for event in &r.events[..spill] {
            serde_json::to_writer(&mut lines, event)?;
            lines.push(b'\n');
        }
        file.write_all(&lines)?;
        file.flush()?;
        file.sync_all()?;
        r.next_seq = Some(r.next_seq());
        r.events_total = Some(r.events_total());
        r.mcp_calls_used = Some(r.mcp_calls_used());
        if r.events[..spill].iter().any(|e| e.kind == "context-read") {
            r.context_read_spilled = true;
        }
        r.spilled_through = Some(r.events[spill - 1].seq);
        r.spilled_bytes = Some(
            committed
                .checked_add(lines.len() as u64)
                .context("Event history file is too large")?,
        );
        r.events.drain(..spill);
    }
    Ok(())
}

/// Up to `limit` events with seq >= `after`, oldest first, from the history
/// file and then the retained events, each sequence once.
pub fn page(root: &Path, r: &Request, after: u64, limit: usize) -> Result<(Vec<Event>, u64)> {
    let mut out: Vec<Event> = Vec::new();
    let mut last: Option<u64> = None;
    if let Some(through) = r.spilled_through.filter(|&through| after <= through) {
        let path = history_path(root, &r.id)?;
        let file = fs::File::open(&path)
            .with_context(|| format!("Event history file is missing: {}", path.display()))?;
        // Read only the committed bytes, up to `through`. Anything after them
        // is a crashed append or a spill running now (this reader holds no
        // lock); those events are still in the retained vector.
        let mut reader = BufReader::new(file.take(r.spilled_bytes.unwrap_or(u64::MAX)));
        let mut line = Vec::new();
        while out.len() < limit && last.is_none_or(|seen| seen < through) {
            line.clear();
            if reader.read_until(b'\n', &mut line)? == 0 || line.last() != Some(&b'\n') {
                break;
            }
            if line.trim_ascii().is_empty() {
                continue;
            }
            let event: Event = serde_json::from_slice(&line).context("Event history file is invalid")?;
            if event.seq > through {
                break;
            }
            if event.seq < after || last.is_some_and(|seen| event.seq <= seen) {
                continue;
            }
            last = Some(event.seq);
            out.push(event);
        }
    }
    for event in &r.events {
        if out.len() == limit {
            break;
        }
        if event.seq >= after && last.is_none_or(|seen| event.seq > seen) {
            last = Some(event.seq);
            out.push(event.clone());
        }
    }
    let next = last.map_or(after.min(r.next_seq()), |seq| seq + 1);
    Ok((out, next))
}

fn preview(text: &str) -> &str {
    let mut end = text.len().min(PREVIEW_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Keep `text` inline when it is at most 256 KiB. Otherwise write it to
/// <state>/requests/<id>/<name>.txt (durably, before any state references it)
/// and return a clearly marked 16 KiB preview plus its payload record.
pub fn inline_or_file(
    root: &Path,
    request: &str,
    name: &str,
    text: String,
) -> Result<(String, Option<Payload>)> {
    if text.len() <= INLINE_BYTES {
        return Ok((text, None));
    }
    ensure!(
        name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'),
        "Invalid payload name"
    );
    let directory = request_file_stem(root, request)?;
    fs::create_dir_all(&directory)?;
    let path = directory.join(format!("{name}.txt"));
    let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
    temporary.write_all(text.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary.persist(&path).map_err(|e| e.error)?;
    let payload = Payload {
        path: path.to_string_lossy().into_owned(),
        bytes: text.len() as u64,
        sha256: format!("{:x}", Sha256::digest(text.as_bytes())),
        preview: preview(&text).to_owned(),
        preview_only: true,
    };
    let inline = format!(
        "{}\n\n[Preview only: the first {} of {} bytes. The full text is saved at {} (sha256 {}).]",
        payload.preview,
        payload.preview.len(),
        payload.bytes,
        payload.path,
        payload.sha256
    );
    Ok((inline, Some(payload)))
}


/// Raw answer ingestion is durable during the run, not deferred until Outcome.
/// The private raw file is never returned as agent-readable payload. Only the
/// separately redacted output may be referenced by persisted request state.
#[derive(Default)]
pub(crate) struct AnswerSink {
    file: Option<std::fs::File>,
    path: Option<PathBuf>,
    start: u64,
    bytes: u64,
    capability: String,
}
impl AnswerSink {
    pub fn at(directory: &Path, capability: &str) -> Result<Self> {
        fs::create_dir_all(directory)?;
        let path = directory.join("answer.raw.private.txt");
        let file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)?;
        Ok(Self {
            file: Some(file),
            path: Some(path),
            start: 0,
            bytes: 0,
            capability: capability.into(),
        })
    }
    fn file(&mut self) -> Result<&mut std::fs::File> {
        if self.file.is_none() {
            self.file = Some(tempfile::tempfile()?);
        }
        Ok(self.file.as_mut().unwrap())
    }
    pub fn append(&mut self, text: &str) -> Result<()> {
        let sanitized;
        let text = if self.capability.is_empty() {
            text
        } else {
            sanitized = text.replace(&self.capability, "[REDACTED]");
            &sanitized
        };
        let file = self.file()?;
        file.seek(SeekFrom::End(0))?;
        file.write_all(text.as_bytes())?;
        file.sync_data()?;
        self.bytes = self
            .bytes
            .checked_add(text.len() as u64)
            .context("Answer size overflow")?;
        Ok(())
    }
    pub fn replace(&mut self, text: &str) -> Result<()> {
        // Preserve previous assistant records as private evidence even when a
        // provider terminal result replaces the answer selected for the owner.
        self.start = self.bytes;
        self.append(text)
    }
    pub fn is_empty(&self) -> bool {
        self.bytes == self.start
    }
    pub fn evidence_path(&self) -> Option<&Path> {
        self.path.as_deref()
    }
    pub fn finish(&mut self, clean: impl Fn(&str) -> String) -> Result<(String, Option<Payload>)> {
        let start = self.start;
        let path = self
            .path
            .as_ref()
            .context("Durable answer output directory unavailable")?
            .with_file_name("answer.redacted.txt");
        let mut output = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        crate::secrets::redact_file(
            self.file()?,
            start,
            output.as_file_mut(),
            crate::model::RECORD_FRAME_BYTES as usize,
            clean,
        )?;
        output.as_file().sync_all()?;
        let size = output.as_file().metadata()?.len();
        output.as_file_mut().seek(SeekFrom::Start(0))?;
        if size <= INLINE_BYTES as u64 {
            let mut text = String::new();
            output.as_file_mut().read_to_string(&mut text)?;
            return Ok((text.trim().to_owned(), None));
        }
        let mut digest = Sha256::new();
        let mut buffer = vec![0u8; 1 << 20];
        let mut preview_bytes = Vec::new();
        loop {
            let n = output.as_file_mut().read(&mut buffer)?;
            if n == 0 {
                break;
            }
            digest.update(&buffer[..n]);
            let keep = PREVIEW_BYTES.saturating_sub(preview_bytes.len()).min(n);
            preview_bytes.extend_from_slice(&buffer[..keep]);
        }
        // The prefix may end in a UTF-8 character; never manufacture replacement
        // characters or let this cosmetic boundary discard any payload bytes.
        while std::str::from_utf8(&preview_bytes).is_err() {
            preview_bytes.pop();
        }
        let preview = String::from_utf8(preview_bytes)?;
        let payload = Payload {
            path: path.to_string_lossy().into_owned(),
            bytes: size,
            sha256: format!("{:x}", digest.finalize()),
            preview,
            preview_only: true,
        };
        output.persist(&path).map_err(|e| e.error)?;
        let inline = format!(
            "{}\n\n[Preview only: the first {} of {} bytes. The full redacted text is saved at {} (sha256 {}).]",
            payload.preview,
            payload.preview.len(),
            payload.bytes,
            payload.path,
            payload.sha256
        );
        Ok((inline, Some(payload)))
    }
}

#[cfg(test)]
mod answer_tests {
    use super::*;
    #[test]
    fn durable_answers_spill_during_ingestion_and_redact_across_records() {
        let dir = tempfile::tempdir().unwrap();
        let mut sink = AnswerSink::at(dir.path(), "fixture-capability").unwrap();
        let block = "ordinary answer line, with a proven separator;\n".repeat(10_000);
        for _ in 0..4 {
            sink.append(&block).unwrap();
        }
        sink.append("password").unwrap();
        sink.append("=fixture-private-value;").unwrap();
        sink.append("fixture-capability;").unwrap();
        let raw = fs::read_to_string(sink.evidence_path().unwrap()).unwrap();
        assert!(raw.len() > INLINE_BYTES && !raw.contains("fixture-capability"));
        assert!(std::mem::size_of_val(&sink) < 1024); // no aggregate answer buffer
        let (inline, payload) = sink.finish(str::to_owned).unwrap();
        let payload = payload.unwrap();
        let text = fs::read_to_string(&payload.path).unwrap();
        assert!(text.starts_with(&block.repeat(4)));
        assert!(!text.contains("fixture-private-value"));
        assert_eq!(payload.bytes, text.len() as u64);
        assert_eq!(
            payload.sha256,
            format!("{:x}", Sha256::digest(text.as_bytes()))
        );
        assert!(inline.len() < PREVIEW_BYTES + 1024 && inline.contains("Preview only"));
    }
    #[test]
    fn provider_terminal_replacement_preserves_earlier_private_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let mut sink = AnswerSink::at(dir.path(), "").unwrap();
        sink.append("Earlier assistant text;\n").unwrap();
        sink.replace("Final answer;\n").unwrap();
        let (answer, payload) = sink.finish(str::to_owned).unwrap();
        assert_eq!(answer, "Final answer;");
        assert!(payload.is_none());
        assert!(
            fs::read_to_string(sink.evidence_path().unwrap())
                .unwrap()
                .contains("Earlier assistant text")
        );
    }
}
