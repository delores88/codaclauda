# ClaudaCoda design — contract version 1

Owner-approved scope, 2026-10-13. Windows first, standalone MIT desktop/CLI/MCP
coordination. DGXBridge remains an optional external compute provider.
Owner renamed the product to ClaudaCoda before its first release. The existing
GitHub repository, private MCP namespace and local state directory retain their
original identifiers so recorded requests and permissions remain intact.
No public listening service and no dependency on Spark for agent questions.

## Verified interfaces and reuse decision

The public repository is delores88/codaclauda, GitHub ID 1418202657.
Codex's installed native CLI 0.162.0-alpha.17.2 supports exec JSONL,
ignore-user-config, read-only sandbox and per-invocation MCP configuration.
Its supported login status confirms ChatGPT authentication. Claude Code 2.1.295
supports print/stream-json, restricted mode, strict MCP configuration, session
inventory and subscription authentication. Owner completed its official login.
Existing Claude sessions were inventoried through `agents --json` and untouched.

Sources: https://learn.chatgpt.com/docs/non-interactive-mode,
https://learn.chatgpt.com/docs/app-server,
https://learn.chatgpt.com/docs/config-file/config-reference,
https://code.claude.com/docs/en/cli-reference,
https://code.claude.com/docs/en/headless.

Initial adapter `new-session-v1` starts dedicated, explicitly owner-authorized
sessions. It does not attach to or wake arbitrary existing desktop chats.
MCP clients poll durable messages; MCP itself is not a proactive transport.
Every launch records the actual session ID returned by the provider, version,
workspace, process outcome and observed usage. A client label is not acceptance.
No credentials are inspected/copied; provider CLIs use their own existing login.
API billing environment fallbacks are removed from children. Claude bare mode
is forbidden because it bypasses subscription authentication.

NVIDIALink source is actively changing and not installed/accepted yet. Integrate
only its public CLI. No copied runner/transport/database modules are necessary;
see PROVENANCE.md. Source, build, installer, native workflow, publication and
Marketplace admission are separate evidence layers.

## Components and local authority

Rust coord-core owns durable state, validation, allowed paths, grants, claims,
adapter supervision and receipt normalization. coord-cli provides claudacoda-cli
with JSON commands and a newline-delimited stdio MCP server. Tauri's GUI binary
is claudacoda.exe; it invokes only the bundled CLI using structured stdin/argv.
The GUI has no remote content or unrestricted shell bridge.

Default state uses the Windows LocalAppData KnownFolder with package redirection
disabled so Explorer, Codex and Claude see one owner-local board. State lives
under DeloresAI/CodaClauda, never in another product's directories. Exclusive OS
file locking plus atomic replacement serializes mutation. No network listener.
State/config/log artifacts are owner-local and are not published.

Owner-only GUI/CLI operations connect endpoints and create an immutable grant:
canonical project, exact allowed relative paths, allowed targets and request
types, expected outcome, maximum requests/delegations/hops, deadline and per-run
timeout. MCP cannot create/expand grants, connect endpoints, publish, deploy or
purchase. Each MCP process is bound to a request capability; an incoming message
cannot supply a different origin/owner/grant. Handoffs are untrusted data.

Endpoints have immutable routing IDs and optional owner-assigned display labels.
Legacy records receive a readable provider/project label without rewriting state.
Owner `rename-agent` changes only the label. MCP `get_context` exposes the granted
endpoint directory and same-grant request/session mappings with effective labels;
it does not index unrelated chats. Labels may repeat, are untrusted display data,
and never replace endpoint IDs for routing or authorization. Inbox, history and
the connection directory use bounded six-item pages with clamped page controls.

Agent capabilities consist of ClaudaCoda file reads, bounded file writes for
delegation, peer requests and receipt retrieval. Direct shell tools and other
MCP servers are disabled. Questions/reviews have no file writes. File operations
reject traversal, secrets, links/reparse points, .git and artifacts outside the
recorded project. Delegation executes in its own Git worktree. Claim conflicts
refer to the original source project + overlapping allowed paths, so separate
worktrees do not silently allow competing edits to the same file. Independent
nonoverlapping claims may proceed. Nothing auto-merges.

## Durable request state machine

Requests contain schema_version, immutable ID and content digest, owner grant,
origin endpoint/session, target endpoint, question/review/delegate kind, scope,
allowed paths, project/worktree, context/artifact references, expected result,
parent/root ID, hop count and budget. Same ID + same content returns its record;
different content with the same ID fails without launch.

Transitions: queued -> delivered (owned child successfully started) -> acknowledged
(actual provider session event) -> running -> completed/failed/cancelled/needs-owner.
Dispatch is claimed durably before spawn. Ambiguous interrupted dispatch or a
stale worker becomes needs-owner, never an automatic duplicate. Workers detach
immediately, heartbeat while supervising, and persist terminal receipts. Wait is
bounded to 60 seconds; message history uses sequence offsets. Pause prevents
new dispatch; cancellation requests stop only owned processes/descendants and
owned Spark jobs. Windows Job Objects contain descendants. Stop-all is rooted
at one owner request/grant, not a machine-wide process kill.

Concurrent runs, hops, delegation count, wall time and output bytes are enforced.
Claude turn count is bounded by its supported flag. Codex token usage is observed;
hard token/dollar caps unavailable in this adapter are displayed as unavailable,
never invented. Claude's reported dollar estimate is an estimate, not an invoice.
Reaching a cap creates a specific needs-owner blocker; no recursive auto-review.

Receipts distinguish agent answer/proposals from changed files/diff and actual
verification. They include actual session evidence, process exit, observed usage,
MCP calls, tests reported by agents versus externally recorded tests, Spark job
IDs, blockers and risks. No confident answer alone establishes verification.

## Spark adapter v1

Owner chooses a supported sparkdev executable. Public contract:
`--json --client codex|claude run PROJECT --where auto|laptop|spark --detach
--request-id ID --argv-json FILE`, `status --all`, `wait JOB --timeout 0..60`,
`logs JOB --since OFFSET --limit 1048576`, `cancel JOB`.
Persist the request ID and owning coordination request before submission.
Unknown outcomes retain the ID. Cancellation is restricted to recorded owned
jobs. Preserve placement/transport/cache/exit state and bounded log cursors.
Actual cross-agent Spark acceptance stays pending until its supported release
and both real callers are available. No direct access to its state database.

## Distribution and acceptance

Per-user x64 NSIS, asInvoker/uiAccess=false, GUI plus CLI, original icon and
normal shortcuts/uninstall. Retain cargo-auditable dependency metadata in both
executables and inspect extracted payload inventory before admission. All local
Cargo commands use the unchanged shared buildlock, own C: target/cache.

Marketplace appId/slug proposed claudacoda; publisher ID must be read from the
existing profile, with current GitHub App grant checked. Public MIT, free-use
and distribution authorization, ordinary non-featured listing; PhaseForge stays
featured. No placeholder publication. Complete real bidirectional requests,
delegated diff + other-agent review, collision/restart/cancel/loop boundaries,
installed native workflow and screenshot, then exact clean release/manifest,
normal scanner admission and authenticated served-download hash.

Native Computer Use policy blocks, authentication failures and Spark readiness
remain explicit limitations; they are never replaced by fabricated acceptance.
