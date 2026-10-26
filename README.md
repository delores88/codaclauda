# CodaClauda

An owner-controlled Windows desktop workspace for Claude and Codex:
owned CLI sessions, passive mailboxes for existing chats, and bounded delegated work. Published
by **DeloresAI**. First-party source is [MIT licensed](LICENSE), copyright
Ben Van Dorn / DeloresAI. [Public source](https://github.com/delores88/codaclauda).

Coordinates OpenAI Codex and Claude Code agents. Not affiliated with or endorsed
by Anthropic or OpenAI.

CodaClauda combines a Rust/Tauri desktop app, a JSON CLI and a request-bound stdio
MCP server. Owned sessions keep a Claude Code or Codex conversation inside the app,
with the project and access level chosen when the session starts. The separate
scoped-request workflow lets you choose allowed paths, request types and limits.
Its questions and reviews are read-only. Its delegated edits use a separate Git worktree;
the returned diff is never merged automatically. Requests and receipts remain on
the local coordination board.

## Current status

[Version 0.6.2](https://github.com/delores88/codaclauda/releases/tag/v0.6.2)
is installed, published and accepted in the Marketplace. Its phone poll correction
preserves ordered durable cursors across ntfy control events. One owner-driven
phone turn completed and outbound transport receipts advanced; physical iPhone
reply display and actual provider cost were not established by that acceptance.

This **0.7.0 source** adds a river City with Downtown towers, Suburbs homes, parks,
commit boats, camera controls and searchable project navigation. It also adds
clearer team and desktop delivery status, longer mailbox waits, and scanned phone
reply previews. See the [0.7.0 release scope](docs/RELEASE-0.7.0.md).
Source review and synthetic previews remain separate from installed acceptance,
phone delivery and Marketplace admission. Native Marketplace UI and authenticated
served bytes remain separate evidence limits.

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

Owned Claude sessions currently support personal Claude Pro or Max accounts.
Team, Enterprise and unknown subscription types are unsupported. Launch is
refused when a managed settings source or remote policy cache is present, or
its absence cannot be verified. CodaClauda does not change or bypass that policy.

For a new owned conversation, link a local folder under **Projects**, then open
**Chat → Start a session**. Choose Claude, Codex or Both. Replies and tool activity
stream into the app. A follow-up continues the same provider conversation; it
does not attach to an existing desktop-app chat. In Both, a leading `@claude` or
`@codex` targets one provider; `@both` or no mention targets both and can consume
usage on both plans. Recent peer replies are included as untrusted context.
Owned-session prompts, replies and tool summaries are stored locally without
general secret redaction or the mailbox credential scan; never include secrets.

New sessions inherit the project's **Full** or **Read only** setting. Full allows
the provider's native tools without permission prompts, including file changes
and commands under your account. Read only restricts the provider's available
tools and filesystem writes. Local folders and `delores88` repositories default
to Full; other projects default to Read only. Changing a project's setting applies
to new sessions, not an already-running conversation or another app.
Browser and desktop tools are optional owner-configured MCP servers at Full
access only; Read sessions refuse all MCP servers. CodaClauda bundles and
installs none of them. Presets show installation instructions for the owner to
run separately, then require confirmation of an already-installed executable.
The app does not run `npx` or `uvx` to acquire tools.

A send to a busy owned session waits in its queue, up to ten waiting messages.
Queued work is not automatically replayed after an interrupted app run.
**Wake on mail** is on by default for each new owned session, which gets its own
board address; turn it off per session in the chat, or for all sessions with the
global switch in Settings. The owner's wake loop guard and applicable concurrency
settings still apply. While on, the open app can send incoming mailbox content to that
owned provider session. Sender labels are not verified identities, and incoming
messages do not grant new permissions. Turn wake off when you do not want it to
consume provider usage. Existing desktop-chat mailboxes remain passive unless
the owner explicitly binds the separate Codex notification route described below.

**Settings → Usage** controls whether CodaClauda-owned sessions may use supported
provider credits or earned Codex resets when a plan is limited. New settings
default on; saved Off choices are retained. Off controls admission, not the
provider's billing system: a turn crossing a limit or starting with unreported
limit state can still use credits. Balances are credit units and per-turn costs
are estimates. A definitively unstarted held turn can be cancelled or retried
once at a validated reset time. Partially executed work is never replayed
automatically. No API profile or account switching is involved.

**Settings → Phone** uses one saved ntfy HTTPS topic for phone messages,
agent replies and turn notifications. Subscribe to that topic on your phone,
then publish `@name Your message` to choose an agent; ordinary follow-ups go to
the last agent that successfully messaged that topic. Ben's phone messages use
the distinct `owner-phone` address and enter as ordinary owner messages under
his direct authorization. Existing project access and session controls still
apply. **Send test** sends one fixed notice without starting an agent; ntfy
acceptance and display on the phone are separate outcomes. Keep the app open
and the PC online. See [phone setup, routing and privacy](docs/PHONE.md).

**Running → On this PC → Continue as a copy** creates a separate owned
conversation through the provider's fork operation. The original is not resumed
in place. Optional **Wake by mail** binds a registered address to one existing
Codex thread in a currently Full-access linked project. Read or unverifiable
project access refuses delivery because the external thread's sandbox cannot be
enforced by the queue command. It attempts a counts-only notice through the
supported local queue endpoint. Binding and command acceptance do not prove
execution or recipient acknowledgment; an unavailable endpoint is reported.
Claude desktop push remains unavailable. See [the copy and notification
boundaries](docs/ADOPT.md).

**Schedules** can send a saved prompt to an owned provider session at an interval
or a daily local time. They run only while CodaClauda is open; there is no operating
system background scheduler. Catch-up is optional. Review the selected project,
provider and access before enabling a schedule. Disabling future runs does not
replace Stop for an already-running turn.

For an existing desktop chat, open **Agent setup** in the sidebar. Choose an agent label
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

## The 0.6.1 desktop interface

Use the left sidebar to move between these views:

| View | What you can do |
| --- | --- |
| **Chat** | Start or continue an owned Claude/Codex session, route a shared Both chat, or send a passive message to a registered desktop chat. Read Markdown, highlighted code, math and attachments. Earlier Live chats remain readable. |
| **Schedules** | Configure an owned-session prompt, interval or daily time, optional catch-up and future-run enablement; inspect run outcomes. |
| **Message board** | Read messages grouped by project, follow reply threads, file or pin threads locally, and post a message. |
| **Approvals** | Save standing-permission records, prepare text to paste into each agent's chat, and review requests and reported uses. |
| **Tasks** | Review work and resource claims in a board or a paginated table. Active dedicated-request details offer **Cancel request** and **Stop request tree**. |
| **City** | Explore linked projects and agent activity in 3D, or open passive Mailbox Talk. Earlier Live chats remain read-only; start new owned conversations in Chat. The Spark side reports configured DGXBridge status. |
| **Agents** | Find agent labels, addresses and connection status, then open a conversation. |
| **Agent setup** | Prepare a passive mailbox join prompt; use Advanced for dedicated connections, task prompts, Grant & send and Board controls. |
| **Projects** | Link local folders, inspect metadata, set access for new owned sessions and choose projects for the City. Bulk actions apply to all matching projects, including other pages. |
| **My avatar** | Customize your local avatar, suggest its appearance from a photo, or explicitly ask an agent to help. |
| **Settings** | Change appearance and alerts, owner limits and MCP tools; configure phone conversations and Send test, or use Updates to acquire and explicitly install an available update. |
| **Running** | Inspect app-owned sessions, their activity and mailbox addresses. |

**Mailbox** conversations remain passive. Messages wait until the recipient
checks its inbox; schedules vary and posting does not wake it. **CodaClauda
sessions** instead own a provider process and continue its conversation. The owner
can set **Agents at once** to a finite value or Unlimited; idle processes close after ten minutes
and a later send resumes their saved provider conversation. Stop interrupts only
the app-owned work; closing a session preserves history. After an interrupted
app run, unfinished turns are reported as interrupted and are not replayed.
Earlier **Live** chats used a fresh read-only request per send and remain a
separate history. Check the conversation label before sending.
A saved mailbox message is not evidence of a reply, and a
downloaded update is not installed until setup and restart succeed.

Settings → Team supplies an owner default for linked projects without a saved
override: teammate starts on, with Unlimited agent-started sessions. Existing
project Off, Read and finite guard settings are retained. Projects → Teammates
can override the default. Requests can register real child folders only within
currently linked project roots and never raise their access. Durable receipts
separate queued, admitted and terminal outcomes; queued requests can be cancelled.
The configured concurrency guard also applies when those sessions wake again.
Disabling it prevents further turns from agent-started sessions; it does not
claim to stop a turn already running. Use Stop for active work. A stricter project
access level requires a new teammate at that level. See [team behavior](docs/TEAM.md).

Fork and Hand off create a new app-owned conversation. Optional Git worktree
chats expose diff, Apply, Discard and explicit GitHub PR actions. Review these
actions before using them: Apply changes the original checkout, Discard removes
the managed worktree, and creating a PR pushes commits to the configured origin.
Conflicting or uncertain Git outcomes remain available for inspection.

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

The 0.3.3 City adds contributor islands and a route map for repositories reported
by the signed-in GitHub CLI. Viewing an island does not grant access or change a
repository. Optional weather starts **Off**. **Pick my own** draws a local scene;
**Live** contacts MET Norway for the selected approximate location while the City
is open. Explicit place searches contact OpenStreetMap Nominatim. Both services
see the IP address; see the [weather privacy details](docs/PRIVACY.md#city-weather).

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
- New grants resolve the owner's finite or Unlimited budgets and keep those
  exact values; changing defaults does not expand existing grants. Runtime grant
  revocation is durable and distinct from cancelling one request. Finite board
  concurrency requires a free slot when a waiting request resumes. Transport and
  memory are bounded independently of total-work settings. Codex has no equivalent
  CLI turn-limit flag; its turn count is not enforced like Claude's. Codex dollar
  cost and hard token caps are unavailable; Claude-reported cost is an estimate.

Both agents receive a private MCP connection when CodaClauda launches their
request. No global `.mcp.json` or Codex configuration change is needed. A generic
global inbox server is not implemented. The separate, explicitly bound Codex
notification route does not establish automatic delivery to arbitrary chats.

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
