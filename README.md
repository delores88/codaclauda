# CodaClauda

An owner-controlled Windows desktop utility for asking Claude Code and Codex to
consult each other, review changes and perform bounded delegated work. Published
by **DeloresAI**. First-party source is [MIT licensed](LICENSE), copyright
Ben Van Dorn / DeloresAI. [Public source](https://github.com/delores88/codaclauda).

CodaClauda combines a Rust/Tauri desktop app, a JSON CLI and a request-bound stdio
MCP server. You choose the agent, project, allowed paths, request types and limits.
Questions and reviews are read-only. Delegated edits use a separate Git worktree;
the returned diff is never merged automatically. Requests and receipts remain on
the local coordination board.

## Current status

This is a development candidate. Real bidirectional provider exchange, delegated
edit/review, installed desktop acceptance, final installer verification and normal
Marketplace admission remain release gates until their receipts are recorded.
Source code, parser tests, a CLI log or a packaged GUI alone do not complete those
gates. Optional Spark Dev Bridge acceptance is tracked separately.

The release is intended for the ordinary, non-featured Marketplace catalog. No
Marketplace acceptance or available release download is implied by this README.

## Start on Windows

You need independently installed Claude Code and Codex native CLIs, signed into
their respective subscription accounts, plus Git for the worktree workflow.
The desktop requires Windows x64 and Microsoft Edge WebView2. The first-party
utility is free: it does not require direct API credits or bundle a model.
Claude/Codex subscriptions and optional Spark hardware are separate products
with their own costs and terms.

After a verified installer is available, launch CodaClauda, choose your repository
and connect the two discovered executable paths. Connection consent explicitly
authorizes **new dedicated sessions**. Version 1 does not attach to, send input
into or interrupt an existing desktop chat. Keep your ongoing work in those chats
and use dedicated CodaClauda requests for coordination.

The CLI example path below is a packaging placeholder; verify the actual installed
CLI path in the GUI settings before use:

```powershell
$Coda = Join-Path $env:LOCALAPPDATA 'CodaClauda\bin\codaclauda-cli.exe'
& $Coda --json discover
& $Coda --json status
```

Follow [the CLI walkthrough](docs/CLI.md) to connect both providers, create a
bounded owner grant and run questions, edits and reviews. Typical owner requests
are “Ask Claude why this test fails” and “Have Codex review Claude's patch.” The
grant, actual provider session IDs, MCP calls, answer and diff are available in
the request history. Reported tests remain distinct from real test receipts.

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

Spark Dev Bridge optionally runs authorized build/test commands and returns job
receipts through its public CLI. CodaClauda does not replace its runner, require
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
or their services. The PhaseForge and Spark Dev Bridge repositories are separate.

Local Cargo work on the owner's laptop must use the unchanged shared build gate
specified in [AGENTS.md](AGENTS.md), with this project's own target directory.
