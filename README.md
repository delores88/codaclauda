# CodaClauda

An owner-controlled Windows desktop utility for Claude and Codex coordination:
passive mailboxes for existing chats, and separate bounded delegated work. Published
by **DeloresAI**. First-party source is [MIT licensed](LICENSE), copyright
Ben Van Dorn / DeloresAI. [Public source](https://github.com/delores88/codaclauda).

CodaClauda combines a Rust/Tauri desktop app, a JSON CLI and a request-bound stdio
MCP server. You choose the agent, project, allowed paths, request types and limits.
Questions and reviews are read-only. Delegated edits use a separate Git worktree;
the returned diff is never merged automatically. Requests and receipts remain on
the local coordination board.

## Current status

[Version 0.2.0](https://github.com/delores88/codaclauda/releases/tag/v0.2.0)
is the published release, under the former name ClaudaCoda. It was accepted into
the ordinary, non-featured MIT Marketplace catalog on October 14, 2026. The
installed mailbox exchange and authenticated Marketplace-served installer hash
have separate acceptance receipts.

Version 0.3.0 source includes the restored name **CodaClauda** and a new desktop
interface. Source review and tests do not establish installed acceptance: its
UI, installer upgrade and owner preview are not yet accepted. Publication waits
until Ben sees the candidate running and says **“ship it” in the release chat**.
The live Marketplace display rename is coordinated separately; changing local
branding does not publish it. See [the 0.3.0 release plan](docs/RELEASE-0.3.md).

The released passive mailbox supports named addresses, durable questions and
replies, acknowledgments, bounded waits and atomic shared-resource claims.
Messages wait until the recipient checks; delivery starts no provider session.
See [the mailbox commands and etiquette](docs/MAILBOX.md). Dedicated tasks and
experimental registered-session push remain separate. Automatic external wakeup
of arbitrary Claude desktop chats has not been established.

The upgrade is designed to retain the existing physical directory, executable
names, coordination board binding and Marketplace identity when the display name changes.
The CLI remains `bin/claudacoda-cli.exe`. Do not move the installation or rewrite
an existing profile to match the new display spelling.

## Start on Windows

For dedicated provider tasks, install the Claude Code and Codex native CLIs and
sign into their respective subscription accounts. Git is needed for the worktree
workflow. Passive mailbox delivery needs no provider login or model session.
The desktop requires Windows x64 and Microsoft Edge WebView2; its 3D views use
WebGL graphics support. No discrete or model GPU is specified. The first-party
utility is free: it does not require direct API credits or bundle a model.
Claude/Codex subscriptions and optional Spark hardware are separate products
with their own costs and terms.

In the 0.3 interface, open **Settings → Open Classic tools** for Agent setup,
grants, delegated tasks, registered-session experiments, DGXBridge and Updates.
Classic setup automatically finds supported provider CLIs and checks their existing sign-in.
Choose your project with Browse and connect each provider; a detected, signed-in
CLI is selected automatically. Rescan after installing or signing in. Advanced
setup exposes an executable override if detection fails or needs a choice.
In the dedicated-task workflow, connection consent explicitly
authorizes **new dedicated sessions**. Version 1 does not attach to, send input
into or interrupt an existing desktop chat. Keep your ongoing work in those chats
and use dedicated CodaClauda requests for coordination. The passive existing-chat
mailbox is separate and never silently substitutes a new provider session.

The CLI is bundled in `bin/claudacoda-cli.exe` beside the installed desktop
executable. Use the actual installed path shown by the app. `--json discover`
checks available providers; `--json status` reports connections and the resolved
coordination board. When using another launch context, pass the reported board
explicitly with `--state-dir` so both clients use the same history.

Follow [the CLI walkthrough](docs/CLI.md) to connect both providers, create a
bounded owner grant and run questions, edits and reviews. Typical owner requests
are “Ask Claude why this test fails” and “Have Codex review Claude's patch.” The
grant, actual provider session IDs, MCP calls, answer and diff are available in
the request history. Reported tests remain distinct from real test receipts.

Give connections readable labels such as “Claude implementer” and “Codex
reviewer.” Both agents can look up the connections allowed for their request and
their actual provider session IDs. Stable connection IDs route requests; labels
can be renamed without changing permissions. Classic tools keeps request lists
and the connection directory to six entries per page, and its Mailbox to 20 messages.
Each request selects a primary agent and up to three permitted peers in the same
workspace; an agent's directory contains only those selected connections.

## The 0.3 desktop interface

The new Chat view renders Markdown, code and math with bundled libraries and
supports file attachments. **Mailbox** conversations remain passive. **Live**
chat is a different workflow: each send starts a fresh dedicated read-only
provider request, including up to 12 prior messages with bounded text. It does
not attach to an existing chat or keep a continuous provider session alive.

Projects links local folders, scans filesystem and optional Git metadata, and
can list GitHub repositories. Line counts are estimates, not a source-code
analysis. Optional create/clone actions use the separately installed, signed-in
`gh` CLI and Git; creating a repository changes GitHub and clones it into a new
folder under the selected parent. Named public-user lookup can use the GitHub
API without `gh`.

Tasks and the 3D City organize project, message, request and claim records. Agent
activity includes recency heuristics and task status can include owner overrides;
these displays are not independent proof that an agent is present or a task
completed. Spark status is reported by the configured DGXBridge CLI. The new
views do not establish additional compute or GPU acceptance.

Avatars are editable procedural models. Local photo matching suggests colors and
features without uploading the image. Asking an agent to help saves the photo
and posts its local path to that agent's mailbox. Dictation invokes Windows
voice typing or supported browser speech recognition, with the service's own
permissions and network behavior; no offline speech model is bundled.

## How coordination stays bounded

- The owner creates an immutable grant. An agent cannot expand it or impersonate
  the owner by sending a message.
- Retrying identical content with the same request ID returns the existing
  request. Ambiguous worker recovery does not automatically duplicate work.
- Overlapping delegated file claims are refused. Independent claims may run
  within the two-worker limit, with one active request per endpoint.
- Pause holds new dispatch. Cancel stops an owned request; stop-all is limited to
  that request's root and descendants. Neither control targets unrelated agents.
- Hop, request, delegation, deadline and output limits are enforced. Codex dollar
  cost and hard token caps are unavailable; Claude-reported cost is an estimate.

Both agents receive a private MCP connection when CodaClauda launches their
request. No global `.mcp.json` or Codex configuration change is needed. A generic
global inbox server and automatic wakeup of existing chats are not implemented.

DGXBridge optionally runs authorized build/test commands and returns job
receipts through its public CLI. CodaClauda does not replace its runner, require
Spark for ordinary questions or claim a shared test passed before both real
callers and the job result have been verified. See [Spark integration](docs/SPARK.md).

## Privacy, source and evidence

The default board is under Windows LocalAppData at `DeloresAI/CodaClauda`; `status`
reports the resolved path. Mailbox messages expire after 30 days during subsequent
mailbox operations. Legacy requests, desktop chat copies, project metadata, avatar
settings and attachment copies have no automatic expiry. Attachments are copied
under the board's `desktop-ui/attachments` directory, up to 25 MiB each; small text
may be included in messages or provider prompts. The mailbox credential scan
does not scan attachment bytes or desktop UI state. Never post or attach secrets.

Local mailboxes, saved project views and avatar editing can work offline.
Provider tasks, GitHub operations, update acquisition and some dictation services
need network access. Provider and GitHub credentials remain with their CLIs.
Content an agent reads follows its provider's policies. See [privacy and local
data](docs/PRIVACY.md) for storage, network and deletion details. Keep local state
and private receipts out of public source and Marketplace screenshots.

See [design and state machine](docs/DESIGN.md), [provider boundaries](docs/ADAPTERS.md),
[CLI operations](docs/CLI.md) and [source provenance](PROVENANCE.md). Third-party
dependencies retain their own licenses; MIT does not relicense the provider CLIs
or their services. The PhaseForge and DGXBridge repositories are separate.

Local Cargo work on the owner's laptop must use the unchanged shared build gate
specified in [AGENTS.md](AGENTS.md), with this project's own target directory.
