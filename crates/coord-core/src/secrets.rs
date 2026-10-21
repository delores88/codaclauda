//! Credential recognition shared by every redaction and file check (C9).
//!
//! `redact` applies the single credential pattern to a whole text. File tools
//! see a file one window at a time, so they use two rules that give the same
//! or a stronger result without holding the whole file:
//!
//! Separator rule (every alternative except private-key blocks). The INLINE
//! alternatives are concatenations of these pieces:
//!   sk-(?:ant-)?[a-z0-9_-]{12,}    letters, digits, '_' and '-'
//!   gh[pousr]_[a-z0-9_]{15,}       letters, digits and '_'
//!   bearer\s+[a-z0-9._-]+          letters, whitespace, digits, '.', '_' and '-'
//!   (?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)
//!   ["']?\s*[:=]\s*["']?[^\s,;"'}]+
//!                                  letters, '_', '-', quotes, whitespace, ':' or
//!                                  '=', then a value class that explicitly
//!                                  excludes ',', ';' and '}'
//! None of these pieces can match ',', ';' or '}': `(?i)` adds only letter
//! variants (U+017F, U+212A), `\s` is Unicode White_Space (no ASCII
//! punctuation), and the only negated class lists all three. So no INLINE match
//! contains a separator byte, and because the separators are ASCII they never
//! occur inside a multi-byte character. The pattern has no anchors, word
//! boundaries or look-around, so whether a span matches depends only on its own
//! text, and a leftmost-first scan reaches the start of every separator-free
//! stretch with no match in progress. The INLINE matches of a whole text are
//! therefore exactly the INLINE matches of each separator-free stretch scanned
//! alone, and a window is redacted correctly when it is scanned together with
//! the stretches it touches: back to the previous separator and forward to the
//! next one (or the start/end of the file). If either separator is more than
//! 1 MiB away the read fails closed instead (READ_UNVERIFIABLE).
//!
//! Private-key rule. Only PEM_BLOCK (".*?" under (?s)) crosses separators and
//! lines. `PemScanner` streams the whole file with constant memory and finds
//! every "PRIVATE KEY-----" tail with the same case-insensitive matching as the
//! pattern. A tail is an END marker only when its exact run of ASCII letters
//! and spaces starts with "END " right after "-----"; any doubt (a run longer
//! than LOOKBACK, or a non-ASCII byte that could be U+017F or U+212A, which
//! (?i)[A-Z ] also accepts) makes it an opener instead, which only redacts
//! more. A block opened by a BEGIN marker (or by any doubtful tail) runs to the
//! first END marker that starts after the latest opening tail ends, or to the
//! end of the file. Every block that overlaps a window is redacted there. This
//! covers each PEM_BLOCK match: an END marker that would close a block early
//! would have to start inside the BEGIN marker, which the regex does not allow
//! either. Over-redaction is acceptable; a leak is not.
use anyhow::{Context, Result, anyhow, bail, ensure};
use regex::{Regex, bytes};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

/// A private-key block: a BEGIN marker, any text, and the first END marker.
const PEM_BLOCK: &str =
    r"-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----.*?-----END (?:[A-Z ]*PRIVATE KEY)-----";
/// Every other alternative; none can contain a separator (see above).
const INLINE: &str = r#"sk-(?:ant-)?[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{15,}|bearer\s+[a-z0-9._-]+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)["']?\s*[:=]\s*["']?[^\s,;"'}]+"#;
/// Bytes of a run searched backward from a tail to classify its marker.
const LOOKBACK: usize = 4096;
/// Longer than any spelling of "PRIVATE KEY-----" (at most 18 bytes).
const TAIL_SPAN: usize = 64;
const NOT_UTF8: &str = "File is not UTF-8";

pub(crate) fn pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(&format!("(?is)(?:{PEM_BLOCK}|{INLINE})")).unwrap())
}
fn inline() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(&format!("(?is)(?:{INLINE})")).unwrap())
}
fn tail() -> &'static bytes::Regex {
    static PATTERN: OnceLock<bytes::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| bytes::Regex::new("(?i)PRIVATE KEY-----").unwrap())
}

pub fn redact(text: &str) -> String {
    pattern().replace_all(text, "[REDACTED]").into_owned()
}

/// A byte no INLINE match can contain.
pub fn is_separator(byte: u8) -> bool {
    matches!(byte, b',' | b';' | b'}')
}

pub fn unverifiable(offset: u64) -> anyhow::Error {
    anyhow!(
        "READ_UNVERIFIABLE: cannot verify credential redaction around offset {offset} (no separator within 1 MiB); read from a different offset or ask the owner."
    )
}

enum Marker {
    Begin(u64),
    End(u64),
    Neither,
    Doubtful,
}

/// Streams a file once and records the private-key blocks that overlap
/// `[range.0, range.1)`. Memory is bounded by LOOKBACK plus one chunk.
pub struct PemScanner {
    keep: Vec<u8>,
    keep_start: u64,
    searched: u64,
    /// (block start, end of the latest opening tail)
    open: Option<(u64, u64)>,
    range: (u64, u64),
    blocks: Vec<(u64, u64)>,
}

impl PemScanner {
    pub fn new(start: u64, end: u64) -> Self {
        Self { keep: vec![], keep_start: 0, searched: 0, open: None, range: (start, end), blocks: vec![] }
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        self.keep.extend_from_slice(chunk);
        let from = (self.searched - self.keep_start) as usize;
        let found: Vec<(usize, usize)> = tail()
            .find_iter(&self.keep[from..])
            .map(|m| (from + m.start(), from + m.end()))
            .collect();
        for &(start, end) in &found {
            self.tail(start, end);
        }
        let stream_end = self.keep_start + self.keep.len() as u64;
        // A tail may straddle the end of this chunk; search its span again next time.
        let last = found.last().map_or(0, |&(_, end)| self.keep_start + end as u64);
        self.searched = self.searched.max(last).max(stream_end.saturating_sub(TAIL_SPAN as u64));
        let drop = self
            .searched
            .saturating_sub((LOOKBACK + TAIL_SPAN) as u64)
            .saturating_sub(self.keep_start) as usize;
        if drop > 0 {
            self.keep.drain(..drop);
            self.keep_start += drop as u64;
        }
    }

    /// The recorded blocks, with an unclosed one running to the end of the file.
    pub fn finish(mut self, size: u64) -> Vec<(u64, u64)> {
        if let Some((start, _)) = self.open.take() {
            self.record(start, size);
        }
        self.blocks
    }

    fn classify(&self, start: usize) -> Marker {
        let k = &self.keep;
        let run = |b: u8| b.is_ascii_alphabetic() || b == b' ';
        let mut i = start;
        while i > 0 && start - i < LOOKBACK && run(k[i - 1]) {
            i -= 1;
        }
        let file_start = self.keep_start == 0 && i == 0;
        if !file_start && (i == 0 || run(k[i - 1]) || k[i - 1] >= 0x80) {
            return Marker::Doubtful;
        }
        if i < 5 || &k[i - 5..i] != b"-----" {
            return if file_start || i >= 5 || self.keep_start == 0 { Marker::Neither } else { Marker::Doubtful };
        }
        let at = self.keep_start + (i - 5) as u64;
        let label = &k[i..start];
        if label.len() >= 6 && label[..6].eq_ignore_ascii_case(b"BEGIN ") {
            Marker::Begin(at)
        } else if label.len() >= 4 && label[..4].eq_ignore_ascii_case(b"END ") {
            Marker::End(at)
        } else {
            Marker::Neither
        }
    }

    fn tail(&mut self, start: usize, end: usize) {
        let tail_end = self.keep_start + end as u64;
        let opener = match self.classify(start) {
            Marker::End(at) => {
                if let Some((block, opened)) = self.open {
                    if at >= opened {
                        self.open = None;
                        self.record(block, tail_end);
                    }
                }
                return;
            }
            Marker::Neither => return,
            Marker::Begin(at) => at,
            Marker::Doubtful => self.keep_start + start as u64,
        };
        let block = self.open.map_or(opener, |(block, _)| block);
        self.open = Some((block, tail_end));
    }

    fn record(&mut self, start: u64, end: u64) {
        if start < self.range.1 && end > self.range.0 {
            self.blocks.push((start, end));
        }
    }
}

fn floor_boundary(text: &str, mut at: usize) -> usize {
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}
fn ceil_boundary(text: &str, mut at: usize) -> usize {
    while !text.is_char_boundary(at) {
        at += 1;
    }
    at
}

/// Redact `window`, the file bytes starting at `window_start`, scanned with its
/// separator-bounded neighbours `before` and `after` and with the private-key
/// `blocks` found by PemScanner.
pub fn redact_window(before: &[u8], window: &str, after: &[u8], window_start: u64, blocks: &[(u64, u64)]) -> String {
    let before = String::from_utf8_lossy(before);
    let joined = format!("{before}{window}{}", String::from_utf8_lossy(after));
    let (b, w) = (before.len(), window.len());
    let mut ranges: Vec<(usize, usize)> = inline()
        .find_iter(&joined)
        .filter_map(|m| {
            let (s, e) = (m.start().max(b), m.end().min(b + w));
            (s < e).then(|| (s - b, e - b))
        })
        .collect();
    for &(s, e) in blocks {
        let (s, e) = (s.max(window_start), e.min(window_start + w as u64));
        if s < e {
            ranges.push(((s - window_start) as usize, (e - window_start) as usize));
        }
    }
    ranges.sort_unstable();
    let mut out = String::with_capacity(w);
    let mut at = 0;
    let mut ranges = ranges.into_iter().peekable();
    while let Some((s, mut e)) = ranges.next() {
        while let Some(&(next, next_end)) = ranges.peek() {
            if next > e {
                break;
            }
            e = e.max(next_end);
            ranges.next();
        }
        let s = floor_boundary(window, s).max(at);
        let e = ceil_boundary(window, e);
        out.push_str(&window[at..s]);
        out.push_str("[REDACTED]");
        at = e;
    }
    out.push_str(&window[at..]);
    redact(&out)
}

pub struct Scanned {
    pub bytes: u64,
    pub sha256: String,
}

/// Streaming check of content to be written: valid UTF-8, no INLINE match in
/// any separator-free stretch and no private-key block, by the same rules as
/// reads. A stretch longer than `run_limit` cannot be verified and is refused.
pub struct WriteScan {
    pem: PemScanner,
    run: Vec<u8>,
    run_start: u64,
    position: u64,
    carry: Vec<u8>,
    run_limit: usize,
    digest: Sha256,
}

impl WriteScan {
    pub fn new(run_limit: usize) -> Self {
        Self {
            pem: PemScanner::new(0, u64::MAX),
            run: vec![],
            run_start: 0,
            position: 0,
            carry: vec![],
            run_limit,
            digest: Sha256::new(),
        }
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Result<()> {
        let pending = std::mem::take(&mut self.carry);
        let joined;
        let text = if pending.is_empty() {
            chunk
        } else {
            joined = [pending.as_slice(), chunk].concat();
            &joined
        };
        if let Err(error) = std::str::from_utf8(text) {
            ensure!(error.error_len().is_none(), NOT_UTF8);
            self.carry = text[error.valid_up_to()..].to_vec();
        }
        self.digest.update(chunk);
        self.pem.feed(chunk);
        if let Some(&(at, _)) = self.pem.blocks.first() {
            bail!(found(at));
        }
        // Matches never span a separator, so everything up to the chunk's last
        // separator is scanned at once and only the stretch after it is carried.
        match chunk.iter().rposition(|b| is_separator(*b)) {
            Some(i) => {
                self.run.extend_from_slice(&chunk[..=i]);
                self.check_run()?;
                self.run_start = self.position + i as u64 + 1;
                self.run.extend_from_slice(&chunk[i + 1..]);
            }
            None => self.run.extend_from_slice(chunk),
        }
        self.position += chunk.len() as u64;
        ensure!(
            self.run.len() <= self.run_limit,
            "WRITE_UNVERIFIABLE: cannot verify that the content has no credential: more than {} bytes without ',', ';' or '}}' after byte {}. Ask the owner.",
            self.run_limit,
            self.run_start
        );
        Ok(())
    }

    fn check_run(&mut self) -> Result<()> {
        let text = std::str::from_utf8(&self.run).ok().context(NOT_UTF8)?;
        if let Some(m) = inline().find(text) {
            bail!(found(self.run_start + m.start() as u64));
        }
        self.run.clear();
        Ok(())
    }

    pub fn finish(mut self) -> Result<Scanned> {
        ensure!(self.carry.is_empty(), NOT_UTF8);
        self.check_run()?;
        if let Some(&(at, _)) = self.pem.finish(self.position).first() {
            bail!(found(at));
        }
        Ok(Scanned { bytes: self.position, sha256: format!("{:x}", self.digest.finalize()) })
    }
}

fn found(at: u64) -> String {
    format!("File contains a recognizable credential near byte {at}; remove it and write again")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocks(text: &[u8], chunk: usize) -> Vec<(u64, u64)> {
        let mut scanner = PemScanner::new(0, u64::MAX);
        for piece in text.chunks(chunk.max(1)) {
            scanner.feed(piece);
        }
        scanner.finish(text.len() as u64)
    }
    fn marker(kind: &str, label: &str) -> String {
        format!("{dashes}{kind} {label}PRIVATE KEY{dashes}", dashes = "-".repeat(5))
    }

    #[test]
    fn pem_blocks_match_the_pattern_at_any_chunk_size() {
        let (begin, end) = (marker("BEGIN", "RSA "), marker("END", "RSA "));
        let text = format!("lead, {begin}\nbody;}}\n{end}, tail {}", marker("end", ""));
        let pem = pattern().find(&text).unwrap();
        for chunk in [1, 2, 7, 64, 4096] {
            assert_eq!(blocks(text.as_bytes(), chunk), [(pem.start() as u64, pem.end() as u64)], "chunk {chunk}");
        }
        // An END marker that shares the BEGIN marker's dashes does not close it.
        let shared = format!("{begin}END PRIVATE KEY-----\nhidden\n{end}");
        assert_eq!(blocks(shared.as_bytes(), 3), [(0, shared.len() as u64)]);
        assert_eq!(pattern().find(&shared).unwrap().range(), 0..shared.len());
        // Unclosed blocks run to the end of the file; a lone END or other prose opens nothing.
        let unclosed = format!("x {begin} hidden");
        assert_eq!(blocks(unclosed.as_bytes(), 5), [(2, unclosed.len() as u64)]);
        assert!(blocks(format!("{end} and a PRIVATE KEY----- mention").as_bytes(), 5).is_empty());
        // A Kelvin sign spells K under (?i); a non-ASCII label is treated as an opener.
        let kelvin = format!("{} x {}", marker("BEGIN", "").replace('K', "\u{212A}"), marker("END", ""));
        assert!(pattern().is_match(&kelvin));
        assert_eq!(blocks(kelvin.as_bytes(), 1), [(0, kelvin.len() as u64)]);
        let odd = format!("{} x {}", marker("BEGIN", "\u{17F}OME "), marker("END", ""));
        assert!(pattern().is_match(&odd) && !blocks(odd.as_bytes(), 2).is_empty());
    }

    #[test]
    fn write_scan_refuses_credentials_split_across_chunks() {
        let sample = format!("ok, x = {}{};", "sk-ant-", "abcdefghijklmnop");
        for chunk in 1..sample.len() {
            let mut scan = WriteScan::new(1 << 20);
            let result = sample.as_bytes().chunks(chunk).try_for_each(|piece| scan.feed(piece)).and_then(|()| scan.finish().map(|_| ()));
            assert!(result.unwrap_err().to_string().contains("near byte 8"), "chunk {chunk}");
        }
        let clean = "caf\u{e9}, ma\u{f1}ana; \u{20ac}\n".repeat(40);
        for chunk in [1, 2, 3, 5, 64] {
            let mut scan = WriteScan::new(64);
            clean.as_bytes().chunks(chunk).for_each(|piece| scan.feed(piece).unwrap());
            let scanned = scan.finish().unwrap();
            assert_eq!((scanned.bytes, scanned.sha256), (clean.len() as u64, format!("{:x}", Sha256::digest(&clean))));
        }
        let mut scan = WriteScan::new(8);
        assert!(scan.feed(b"abcdefghij").unwrap_err().to_string().contains("WRITE_UNVERIFIABLE"));
        let mut scan = WriteScan::new(8);
        scan.feed(&[b'a', 0xE2, 0x82]).unwrap();
        assert!(scan.finish().is_err(), "truncated character");
    }
}
