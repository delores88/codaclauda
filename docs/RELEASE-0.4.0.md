# CodaClauda 0.4.0 release scope

Status: source review and release preparation, 2026-10-20. Version 0.3.3 remains
the completed immutable release. Build, installation, native workflow acceptance,
publication and Marketplace acceptance for 0.4.0 require separate receipts.

## Lean scope

The handoff at `cd2f8f01c80f23ed6710e88b79e774e2768dbc7a` adds CodaClauda-owned
Claude Code and Codex CLI sessions. The desktop owns their child processes,
streams replies and tool activity, and retains provider conversation IDs so
later sends can continue them. It does not attach to desktop-app conversations.

- Start a Claude, Codex or shared Both conversation in a local project.
- Send follow-ups, interrupt a reply, close a process and reopen saved history.
- Route shared messages with `@claude`, `@codex` or `@both`; bounded recent peer
  context is sent to the target as untrusted conversation content.
- Set Full or Read only access for new sessions in a project. Full exposes
  native provider tools without permission prompts under the user's account.
  Access is fixed for a session; changing project preferences affects new ones.
- Preserve passive desktop-chat mailboxes, projects, City, avatars, legacy scoped
  requests, existing installation paths, CLI identity and board binding.

Browser control is not available in 0.4.0. Browser MCP launches and package
downloads are disabled, including when a saved project preference requests them.
Ask me, Work freely, schedules, automatic mailbox wake, tickers and Windows MCP
are also outside 0.4.0. The broader `DESIGN-0.4.md` remains a proposal for later
work. A mailbox post is information, never independent owner authority.

## Release-critical review

Review the final source for process ownership and shutdown, generation/turn
attribution, concurrent launch limits, registry exclusivity, durable history
failures, ambiguous dispatch, interrupted-run recovery and updater exclusion.
Verify provider configuration and subscription authentication before dispatch:
an empty Codex MCP table does not clear inherited servers, and a Claude plan
prompt alone is not a read-only tool boundary. Browser MCP and runtime package
download paths must remain disabled. Credentials and local transcripts stay private.

Owned Claude sessions support personal Pro or Max accounts only. Team,
Enterprise and unknown subscription types are unsupported. Refuse launch if a
managed system file/directory, registry settings value or remote policy cache is
present or its absence cannot be verified; do not change or bypass the policy.
The cache check uses the configuration directory reported by clean Claude login
status. Owned-session prompts, replies and tool summaries are not generally
redacted or mailbox-scanned, so public evidence must exclude their private data.

The shared-chat path must preserve peer context regardless of reply order, wait
for restored history before dispatch, retain attachment metadata and tolerate
terminal events arriving before a command response. Copied terminal commands
must quote literal paths. Deterministic regression tests establish these source
properties; they do not establish a usable installed workflow.

## Build and installed acceptance

Freeze independently reviewed clean source before final packaging. Every local
Cargo invocation uses the unchanged shared gate:

```powershell
python -I D:/PhaseForge-claude/scripts/buildlock.py -- cargo ...
```

Keep the target within this project's C: directory and the 10 GB memory gate
unchanged. Use `scripts/release.ps1` for the final build, with exact package
versions, lockfiles, notices, source/payload inventories and installer identity.
Keep appId/slug `claudacoda`, publisher `idFUpIv8h0zRX8OxpjsAWgQk`, display name
CodaClauda, ordinary MIT distribution and `com.deloresai.claudacoda`.

Native acceptance must inspect the actual installed app, preserve the existing
board and verify a bounded real conversation and follow-up with both providers,
shared routing/context, Read access, stop/reopen behavior and visible errors.
Inspect the Browser unavailable state and confirm saved preferences cannot
enable it. Do not infer network or filesystem enforcement from a label or
mocked preview. Record any unperformed checks explicitly.
Use supported native Computer Use; respect shared UI claims and owner input.
Escape stops native work until a new direct human continuation.

## Publication

After successful required checks, publish one immutable version with exact
installer and evidence pins. Review public screenshots and receipts for private
data. Keep source/build/package, installed workflow, publication, Marketplace
decision, native listing and authenticated served-file hash evidence separate.
Pending or unavailable is not rejection; preserve actual rejection findings and
make corrections in a new immutable version when necessary.

Do not repeat any 0.3.3 build, install, upload, scan, transfer or publication.
Its accepted artifact has a documented external presentation exception: the
Marketplace carousel selected it, and the deployed catalog has no stored
featured flag. Do not claim `featured=false` or change Marketplace policy here.

On completion, notify Claude through the passive mailbox, acknowledge the
handled handoff, release intake/packaging/UI claims and stop release-specific
monitors. The standing board-coordination heartbeat remains active.
