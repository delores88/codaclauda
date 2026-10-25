# 0.7 coordination fixes: evidence

Source branch: `codex/codaclauda-0.7-fixes`, based on `v0.6.2`.
The City changes are owned by a separate branch and are not included here.

## Implemented

- Mailbox wait-reply supports 0–3600 seconds through CLI, core and MCP. Numeric
  errors and help name the field and its range. MCP waits still recheck the
  request's authorization, and unrelated request waits remain bounded at 60 seconds.
- Team admitted/outcome replies include the readable `projectName` alongside
  the routing ID. Saved reply bytes remain stable across retries.
- Chat says “Agents CodaClauda runs” and explains that these span projects.
- Successful phone notifications use the readable session name and the first
  300 characters of the final assistant message, after the full credential
  scan. Peer-origin successful turns stay quiet; errors and explicit posts to
  `owner-phone` retain their existing delivery path. Ambiguous sends never replay.
- Desktop Codex rows show current endpoint evidence separately from queue
  receipts and exact board acknowledgment. The queue retains `--remote unix://`.
  Managed CodaClauda sessions are recommended for agents to wake each other.

## Review and deterministic checks

Mailbox and phone work received reciprocal independent review. The label work
was reviewed by the integrating agent, and desktop endpoint/receipt work by a
separate agent. Review found and resolved MCP timeout parity, Claude multi-block
reply previews, exact acknowledgment lookup, and stale/contradictory row labels.

- UI: `cd ui; node --test` — 117 passed, 0 failed.
- Rust workspace: blocked before Cargo started. The unchanged shared build gate
  reported 8.1–9.6 GiB free against its 10 GiB requirement throughout the wait;
  this run's waiting process was then stopped. No Rust test result is claimed.
- Tauri: not started; pending the same gate after workspace tests.
- `git diff --check`: passed.

All Cargo commands use `python -I D:/PhaseForge-claude/scripts/buildlock.py -- cargo ...`,
`CARGO_HOME=C:/Users/Benny/OneDrive/Desktop/CodaClauda/local/cargo-home`,
`RUSTUP_TOOLCHAIN=1.98.1`, and
`CARGO_TARGET_DIR=C:/Users/Benny/OneDrive/Desktop/CodaClauda/target/desktop`.
Remaining commands are `cargo test --workspace --locked`, then
`cargo test --manifest-path src-tauri/Cargo.toml --locked`, both through that gate.

## Actual acceptance remains separate

No installation, release, Marketplace admission, real phone delivery or native
UI acceptance was performed for these changes. On the development PC, a read-only
bundled Codex `app-server daemon version` check resolved the control socket to
`<normal CODEX_HOME>/app-server-control/app-server-control.sock`; metadata confirmed
that path absent. No server/model was launched and no desktop notice was sent.

Before release, verify the changed Chat/Running rows in the installed UI, an
owner-triggered final reply on the phone, a silent successful peer turn, an
explicit peer post to `owner-phone`, and an error notification. A real desktop
Codex wake needs its own endpoint/ownership/delivery evidence; a command's exit
status or a self-asserted board acknowledgment is not provider verification.
