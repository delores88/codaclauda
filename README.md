# ClaudaCoda

An owner-controlled Windows desktop utility for Claude and Codex coordination:
passive mailboxes for existing chats, and separate bounded delegated work. Published
by **DeloresAI**. First-party source is [MIT licensed](LICENSE), copyright
Ben Van Dorn / DeloresAI. [Public source](https://github.com/delores88/codaclauda).

ClaudaCoda combines a Rust/Tauri desktop app, a JSON CLI and a request-bound stdio
MCP server. You choose the agent, project, allowed paths, request types and limits.
Questions and reviews are read-only. Delegated edits use a separate Git worktree;
the returned diff is never merged automatically. Requests and receipts remain on
the local coordination board.

## Current status

[Version 0.1.0](https://github.com/delores88/codaclauda/releases/tag/v0.1.0)
was published and accepted into the ordinary, non-featured MIT Marketplace
catalog on October 14, 2026. Its installed GUI, real Claude/Codex exchanges,
delegated edit/review and one shared DGXBridge job have separate local acceptance
receipts. A Marketplace client download failure is being addressed separately;
catalog acceptance alone does not prove successful acquisition.

Version 0.2.0 is in development. Its primary workflow is a passive mailbox for
existing chats: named addresses, durable questions and replies, acknowledgments,
bounded waits, and atomic shared-resource claims. Messages wait until the recipient
checks. No session is launched, resumed or woken for delivery. The Mailbox view
provides readable message cards, 20-message pages, open claims and an owner post
box. See [the mailbox commands and etiquette](docs/MAILBOX.md).

The candidate also adds browser-approved updates and separates dedicated tasks
from existing-chat messages. The earlier candidate passed hosted packaging; the
new mailbox changes require their own process, installed UI and participation
acceptance before publication. Experimental registered-session push remains
separate and is not required for passive mailbox coordination. Automatic external
wakeup of arbitrary Claude desktop chats has not been established.

## Start on Windows

You need independently installed Claude Code and Codex native CLIs, signed into
their respective subscription accounts, plus Git for the worktree workflow.
The desktop requires Windows x64 and Microsoft Edge WebView2. The first-party
utility is free: it does not require direct API credits or bundle a model.
Claude/Codex subscriptions and optional Spark hardware are separate products
with their own costs and terms.

After installing a verified release, launch ClaudaCoda. It automatically
finds supported provider CLIs and checks their existing sign-in once at startup.
Choose your project with Browse and connect each provider; a detected, signed-in
CLI is selected automatically. Rescan after installing or signing in. Advanced
setup exposes an executable override if detection fails or needs a choice.
In the released 0.1.0 dedicated-task workflow, connection consent explicitly
authorizes **new dedicated sessions**. Version 1 does not attach to, send input
into or interrupt an existing desktop chat. Keep your ongoing work in those chats
and use dedicated ClaudaCoda requests for coordination. The 0.2 existing-chat
workflow is separate and never silently substitutes a new provider session.

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
can be renamed without changing permissions. The desktop keeps request lists
and the connection directory to six entries per page.
Each request selects a primary agent and up to three permitted peers in the same
workspace; an agent's directory contains only those selected connections.

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

Both agents receive a private MCP connection when ClaudaCoda launches their
request. No global `.mcp.json` or Codex configuration change is needed. A generic
global inbox server and automatic wakeup of existing chats are not implemented.

DGXBridge optionally runs authorized build/test commands and returns job
receipts through its public CLI. ClaudaCoda does not replace its runner, require
Spark for ordinary questions or claim a shared test passed before both real
callers and the job result have been verified. See [Spark integration](docs/SPARK.md).

## Privacy, source and evidence

The default board is under Windows LocalAppData at `DeloresAI/CodaClauda`; `status`
reports the resolved path. It retains prompts, answers, events, diffs and worktrees
locally. Allowed project content sent to a provider is processed under that
provider's account and privacy terms. Provider credentials remain with the
provider CLIs. Keep local state and private receipts out of public source and
Marketplace screenshots.

See [design and state machine](docs/DESIGN.md), [provider boundaries](docs/ADAPTERS.md),
[CLI operations](docs/CLI.md) and [source provenance](PROVENANCE.md). Third-party
dependencies retain their own licenses; MIT does not relicense the provider CLIs
or their services. The PhaseForge and DGXBridge repositories are separate.

Local Cargo work on the owner's laptop must use the unchanged shared build gate
specified in [AGENTS.md](AGENTS.md), with this project's own target directory.
