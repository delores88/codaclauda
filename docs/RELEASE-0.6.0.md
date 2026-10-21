# CodaClauda 0.6.0 release scope

This is a source and acceptance plan, not a claim of build, installation or
publication. Exact builder handoff: `58712b2ef87878282bce9b2cc24079ec42667fad`,
descending from completed 0.5.0 source `c529dbba1287e73481ec39bb9184f996d5daa685`.
Earlier 0.6 handoffs were superseded before release gates. Preserve completed
release bytes and private historical receipts.

## Included behavior

- Owner-level teammate defaults within current linked project roots, preserving
  saved Off, Read, finite guards and revocation. Real child folders inherit the
  enclosing project's authority and access.
- Durable mailbox receipt and board-bound host availability; queued, admitted
  and terminal team outcomes; explicit cancellation and restart deduplication.
- Less ambiguous reply inference and fewer credential-filter false positives,
  retaining rejection of credential shapes and stream/file redaction.
- Owner-controlled Notify or Pause loop guards and visible pair counts. Saved
  pre-0.6 guards keep their previous behavior; explicit pair pause blocks queued
  wakes too.
- Copy-only continuation of external conversations, plus a separate explicit
  Codex desktop notification binding. Neither feature establishes arbitrary
  desktop-chat wake or Claude desktop push.
- Global owned-session usage settings, fresh limit decisions, durable earned
  reset reconciliation and cancellable retry of definitively unstarted turns.
  Credit-off admission is not a hard spending cap. No API profile is included.

## Required checks

Independently review current ownership, canonical path/access checks, cancellation
and revocation at dispatch, delivery receipt meanings, preserved policy,
per-account reset serialization and ambiguous outcomes. Deterministic fixtures
cover these boundaries without redeeming real credits or replaying partial work.

Freeze reviewed source before packaging. All local Cargo calls use unchanged
`python -I D:/PhaseForge-claude/scripts/buildlock.py -- cargo ...`, a target in
this C: project and the unchanged 10 GB threshold. Run required final workspace,
desktop and UI suites once on the frozen input; repeat only after relevant edits
or a failure. Validate package inventory and identity using the existing recipe.

Installation, preservation of board/binding/preferences, native UI acceptance,
provider execution, publication and Marketplace admission require separate
receipts. Native checks should cover the new settings, persisted Off/Read
choices, queued cancellation, pair pause, copy labeling and truthful delivery
status. Record actual provider execution separately from fixtures and GUI state.
Do not spend credits merely to poll or consume an earned reset without the
required direct per-use human confirmation. An unavailable supported endpoint
is a reported limitation, not permission to use hidden IPC or a fallback engine.

## Distribution

Preserve appId/slug `claudacoda`, publisher `idFUpIv8h0zRX8OxpjsAWgQk`, CodaClauda,
`com.deloresai.claudacoda`, MIT distribution, physical install paths and board
binding. Keep third-party notices and observed scan findings; never infer zero
vulnerabilities from a passing gate. Signing remains separately unestablished.
Publish a reviewed immutable version once; do not overwrite published bytes or
replay an unknown mutation. Exact artifact hashes, public evidence, Marketplace
admission, native listing and authenticated served bytes remain distinct layers.
