# CodaClauda 0.4.1 release scope

Status: candidate review and correction, 2026-10-20. This document records scope
and required checks; it does not assert completed installation or publication.
Ben directly authorized review, necessary corrections, build, installation and
Marketplace publication. The separate 0.4.0 served-file check does not gate this
release. Exact handoff: `23d01bc08b117921c2397c237e239baf4d99d1d7`, based on
published 0.4.0 source `6d8c02b383df175e76dc769f549fe9658aee2ece`.

## Scope

- Queued sends to busy app-owned Claude Code and Codex sessions.
- Optional mailbox wake for an explicitly selected owned session, with a global
  switch and bounded automatic delivery.
- In-app interval and daily schedules, optional catch-up and run receipts.
- Preserve the existing owned-session configuration isolation, Full/Read access,
  shared Both chat, passive desktop-chat mailboxes, installation and board paths.

Browser acquisition remains unavailable. Windows MCP, worktree/PR workflows and
the broader limits redesign belong to a later exact handoff. This release does
not widen owner grants, attach to arbitrary desktop chats or run an OS scheduler.
Wake and schedules can use provider subscriptions while the app is open.
Messages remain untrusted information and never independent owner authority.

## Release-critical corrections and checks

Accepted queued work needs durable identity and status before success is
reported. Restart must expose interrupted or uncertain work without automatic
provider replay. Stop, close and late output must retain correct turn attribution.
Mailbox acknowledgement must follow durable admission, and a repeated message
must not cause duplicate provider work. Current opt-out and configuration-write
failures must prevent new automatic dispatch.

Schedules need durable admission and run outcomes, current enablement and access
checks, and protection against overlapping or stale dispatch. Changing a linked
project from Full to Read must not silently reuse Full for a future scheduled run.
Unknown outcomes must remain visible and must not trigger an automatic retry.

Independently review the final changes and focused deterministic tests before
freezing a clean source commit. Build once with `scripts/release.ps1`; every local
Cargo invocation uses unchanged
`python -I D:/PhaseForge-claude/scripts/buildlock.py -- cargo ...`, a target under
this project's C: directory and the unchanged 10 GB gate.

Use separate exact-source evidence for package integrity, protected-state
preservation and actual installed acceptance. Native checks should exercise a
real queued follow-up, a bounded opted-in mailbox delivery, schedule Run now and
disabled behavior, and interruption/reopen reporting. Preserve limitations;
unit tests do not establish native workflow acceptance or provider isolation.
Use supported native Computer Use, coordinate UI claims and respect owner input.
Escape stops native work until direct human continuation.

## Publication

Preserve appId/slug `claudacoda`, publisher `idFUpIv8h0zRX8OxpjsAWgQk`, display
name CodaClauda, ordinary MIT distribution, `com.deloresai.claudacoda`, existing
installation/CLI paths and board binding. Do not change other products or their
trust, scanner or catalog policies.

Review public evidence for private data, publish each immutable version once
with exact asset pins and retain Marketplace findings. Pending is not rejection.
Keep source, build/package, installed workflow, publication, Marketplace decision,
listing and authenticated served-file evidence distinct. Never reuse historical
0.4.0 or 0.3.x receipts as evidence for the new binaries.

When 0.4.1 is live, notify Claude through the passive board, acknowledge the handled
handoff and inspect the fresh exact 0.5 handoff. Ben has authorized that next
review, necessary corrections, installation and publication without another
permission request. The existing Claude builder owns the limits implementation;
do not duplicate it. Release shared claims promptly and retain the standing
board-coordination heartbeat.
