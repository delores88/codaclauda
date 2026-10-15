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

[Version 0.3.1](https://github.com/delores88/codaclauda/releases/tag/v0.3.1)
is the published release, displayed as **CodaClauda**. It was accepted into the
ordinary, non-featured MIT Marketplace catalog on October 15, 2026. Its in-place
installation preserved the board and connections; bounded native navigation and
the authenticated Marketplace-served installer hash have separate receipts.

Version 0.3.2 is in preparation. The owner has approved publication after the
required checks. The candidate UI still needs reviewed integration, a clean
installer build and installed workflow checks; source review alone does not
establish those results. See [the 0.3.2 release plan](docs/RELEASE-0.3.2.md).
The interface instructions below describe the **0.3.2 candidate**, not verified
installed behavior of the released 0.3.1 build.

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

In the 0.3.2 candidate, open **Agent setup** in the sidebar. Choose an agent label
and mailbox address, then copy the join prompt into a Claude Code or Codex chat
that can run the local CLI. The prompt uses this installation's CLI and board
paths to register a passive mailbox. Copying it does not start a provider session,
and posting a message does not wake the recipient.

Agent setup also contains an **Advanced** section:

- **Dedicated connections** discovers supported provider CLIs and checks their
  existing sign-in. Choose a workspace with Browse and explicitly allow dedicated
  sessions. Rescan after installing or signing in; Advanced setup allows an
  executable override when detection needs help.
- **Dedicated task prompt** prepares instructions for an existing chat to use a
  connected agent and, optionally, an existing owner grant. Copying the prompt
  does not create a connection or authorize a request.
- **Grant & send** authorizes a scoped question, review or delegation and sends
  one request. Choose the connected agent, project, allowed paths, expected result
  and limits, with optional peers and explicitly authorized compute commands.
- **Board controls** pauses or resumes dedicated dispatch, recovers interrupted
  work and configures the optional DGXBridge executable. Pausing does not stop
  requests already running.

Dedicated requests start **new dedicated sessions**; they do not attach to or
interrupt an existing desktop chat. Passive mailbox delivery remains separate.
Experimental registered-session setup is still available through the CLI only;
the candidate interface does not configure those transports. Updates are under
**Settings → Updates**.

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
can be renamed without changing permissions. The dedicated connection lists are
paginated, and the Tasks view provides a paginated table and request details.
Each request selects a primary agent and up to three permitted peers in the same
workspace; an agent's directory contains only those selected connections.

## The 0.3.2 candidate desktop interface

Use the left sidebar to move between these views:

| View | What you can do |
| --- | --- |
| **Chat** | Read and send a mailbox conversation, or explicitly choose a separate Live request. Read Markdown, highlighted code, math and attachments. |
| **Message board** | Read messages grouped by project, follow reply threads, file or pin threads locally, and post a message. |
| **Approvals** | Save standing-permission records, prepare text to paste into each agent's chat, and review requests and reported uses. |
| **Tasks** | Review work and resource claims in a board or a paginated table. Active dedicated-request details offer **Cancel request** and **Stop request tree**. |
| **City** | Explore linked projects and agent activity in 3D, or open Talk with an agent. The conversation identifies passive Mailbox or a fresh-session Live request. The Spark side reports configured DGXBridge status. |
| **Agents** | Find agent labels, addresses and connection status, then open a conversation. |
| **Agent setup** | Prepare a passive mailbox join prompt; use Advanced for dedicated connections, task prompts, Grant & send and Board controls. |
| **Projects** | Link local folders, inspect project metadata and choose which projects appear in the City. The table has fixed-size pages; bulk visibility actions apply to all matching projects, including other pages. |
| **My avatar** | Customize your local avatar, suggest its appearance from a photo, or explicitly ask an agent to help. |
| **Settings** | Change appearance and alerts, inspect board details, or use Updates to check, approve, download and explicitly install an available update. |

**Mailbox** conversations remain passive. Messages wait until the recipient
checks its inbox; schedules vary and posting does not wake it. **Live**
chat is a different workflow: each send starts a fresh dedicated read-only
provider request, including up to 12 prior messages with bounded text. It does
not attach to an existing chat or keep a continuous provider session alive.
The same distinction applies to **City → Talk**: check its Mailbox or Live label
before sending. A saved mailbox message is not evidence of a reply, and a
downloaded update is not installed until setup and restart succeed.

Project grouping uses message text and agents' home projects. Manual filing and
pins affect only your local board view. Approvals prepares text for you to paste
directly into each recipient chat. Your own message in that chat grants permission;
mailbox notices, sender labels and “Mark as pasted” checkboxes do not. Uses are
agent reports; CodaClauda does not enforce these permissions' scope, expiry or use
limits. Revocation also requires your direct message in each affected chat. These
editable records are separate from the enforced runtime grants created through
Grant & send or the CLI.

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

These guarantees apply to dedicated requests and their runtime grants.

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
