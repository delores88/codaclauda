# CodaClauda 0.5.0 release scope

This document describes reviewed source scope and release requirements. It does
not assert completed installation, native acceptance or Marketplace publication.
Incoming source: `2321e001875a7842c4dadbab0733f9d473ed8b6b`, including corrected
0.4.1 source `7b23669d05c8bf3890f73ed62d11de4027d6e2bd`. Ben directly authorized
necessary corrections, build, installation on this PC and publication after
required checks. The separate 0.4.0 served-file check does not gate this release.

## Included behavior

- Owned Claude/Codex sessions, forks and hand-offs, model/effort selection,
  usage displays, session search, pins, sections and Running view.
- Optional managed Git worktrees, diff, explicit Apply/Discard and GitHub PR
  actions. Mutations reserve affected folders and preserve unrelated Git work.
- Owner-configured MCP tools at Full access only; Read refuses all MCP servers.
  Presets provide owner-run install instructions. No automatic `npx` or `uvx`
  acquisition, bundled browser or Windows-MCP executable.
- Optional ntfy notices and project instruction editing, plus City/onboarding
  improvements. External providers and services retain their own policies.
- Explicit finite or Unlimited owner budgets, immutable resolved grants, durable
  grant revocation, schema-3 migration with compatible legacy completion,
  chunked scoped files and durable output. Transport and memory bounds remain
  distinct from total-work budgets.
- Wake on by default for new owned sessions, preserving existing settings.
  Agent-started teammates require a per-project owner switch, off by default.
  Their finite/Unlimited guard, current access and durable admission are checked
  before new work. Mailbox addresses remain self-asserted information.

## Required release checks

Independent review covers grant scope/revocation, preserved legacy budgets,
migration and unknown outcomes, strict finite concurrency including nested waits,
bounded output, staged file integrity, Full/Read tool configuration, and Git
operation identity. Deterministic regressions cover corrections; no multi-hour
provider run is required to demonstrate a numeric setting.

Freeze clean reviewed source before the release recipe. Run final workspace,
desktop and UI suites once on that source, repeating only for relevant changes
or failures. Every local Cargo invocation uses the unchanged shared gate:
`python -I D:/PhaseForge-claude/scripts/buildlock.py -- cargo ...`, a target under
this project's C: directory and the unchanged 10 GB threshold.

Keep package integrity, installed payload/state preservation and actual native
workflows as separate evidence. Bounded native acceptance must cover both
providers and follow-up, a new fork or hand-off, a worktree flow, owner limits,
team/wake admission and Read refusal of configured MCP tools. Record exactly
what was observed; no blanket OS/network isolation or crash-recovery claim.
Restore temporary preferences and avoid changing provider settings.

## Distribution

Preserve appId/slug `claudacoda`, publisher `idFUpIv8h0zRX8OxpjsAWgQk`, display
name CodaClauda, ordinary MIT distribution, `com.deloresai.claudacoda`, existing
installation/CLI paths and board binding. Signed installers, account setup and
renaming physical paths are outside this release.

Review public evidence before publication. Publish each immutable version once
with exact source and artifact pins; never overwrite published bytes or replay
unknown mutations. Keep Marketplace findings, including any nonblocking advisory.
Source tests, installed workflow, publication, Marketplace admission, listing and
authenticated served-file bytes are distinct evidence layers. Pending is not
rejection. Notify Claude through the passive board when live, acknowledge handled
requests, release shared claims and stop release-specific monitoring.
