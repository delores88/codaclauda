# Provider adapters, contract 1

CodaClauda starts dedicated new sessions through the provider's native executable.
It never resumes a session implicitly or uses `--last`, screen scraping, terminal
automation, hidden IPC, credential copying, or API billing as a fallback.
The owner chooses the executable and workspace. `discover` finds binary paths;
`probe` separately checks version, supported flags and subscription authentication.
An available executable is not an online session.

The initial verified interfaces are Codex CLI `0.162.0-alpha.17.2` and Claude Code
`2.1.295`. Other versions must pass the feature probe and real acceptance before
being advertised as compatible. Probe results are observations at that time, not
a guarantee that a subsequent request will authenticate or finish.

## Transport and controls

The agent prompt goes over stdin. Windows arguments are quoted using the native
CRT argument convention and passed straight to `CreateProcessW`, with the exact
executable supplied separately. Neither PowerShell nor cmd parses a request.
No synthetic client name is used as evidence that another agent participated.

The process starts suspended. Before its primary thread resumes, CodaClauda puts
it in a Windows Job Object with `KILL_ON_JOB_CLOSE`; inherited handles are limited
to its stdin/stdout/stderr pipes. Failure to contain the suspended process aborts
launch. Cancellation, deadline, output overflow, supervisor callback failure and
normal completion end the owned job, including its remaining descendants. No
process is selected by name or recycled PID. The adapter does not stop another
provider process, session or build. Hosts without this Windows containment fail
closed in version 1.

The run time and turn limit come from the owner's authorization. The run time
is the smaller of the grant's `timeout_seconds` and its remaining lifetime;
`"unlimited"` on both means no deadline. The deadline is computed with checked
arithmetic before launch, so an unrepresentable one is refused with
`timeout_seconds is too large to schedule; choose a smaller value or
"unlimited"` rather than treated as unlimited.

Current (policy_version 1) grants have no total-output cap. Provider stdout is
split into newline-terminated records as it arrives; a record up to 64 MiB is
parsed normally. A single record larger than that frame is streamed, with
bounded memory, to `<run_dir>/oversized-<n>.jsonl` in the request's private run
directory, and the run is stopped with `stop_reason`
`provider_record_too_large` and the blocker `Provider sent a single record
larger than 64 MiB; it was saved to <path> and the run was stopped so no result
is lost. Inspect it, then retry.` A record is never skipped while a run reports
success. That file is raw provider output kept owner-local with the board.

Grants created before 0.5 keep their 0.4.0 supervisor limits: at most 3600
seconds and 12 turns, a 1 MiB unfinished stream line
(`provider_line_limit_exceeded`) and 8 MiB of combined output
(`output_limit_exceeded`), each of which stops the run.

Provider probes have independent ten-second timeouts and a 1 MiB output cap.
They make no model requests. A heartbeat is emitted while the model runs. A
clean process exit without an actual session ID and provider terminal event is
a failure, not an answer receipt. Unknown launch outcomes must be reconciled by
the durable worker; this module never automatically retries.

Only metadata is emitted for provider/tool events; full tool arguments and
provider transcripts are not copied into public receipts. Known credential
patterns and the request capability are redacted from returned text. Redaction
is defense in depth: the core file tools must reject secrets and out-of-scope
paths before content reaches an agent.

## Claude Code

The adapter uses:

```text
--print --restricted --strict-mcp-config --mcp-config <private-json>
--tools "" --allowedTools mcp__codaclauda__*
--permission-mode dontAsk --permission-prompts none
--disable-slash-commands --no-chrome
--output-format stream-json --verbose [--max-turns <limit>]
--session-id <new-uuid>
```

`--tools ""` removes all built-in tools. The sole MCP server invokes the installed
CodaClauda CLI with `--state-dir <state> mcp --request <id>` and the request-bound
`CODACLAUDA_CAPABILITY` environment variable. Its JSON configuration is created
exclusively inside the worker's private directory; the core must protect that
directory with owner-only access and retain/delete it according to local policy.
Restricted mode ignores ordinary user/project/local settings; managed policy
still applies. Existing owner configuration is never overwritten.

The initial `system/init` event must list exactly the connected `codaclauda`
server and no tools outside `mcp__codaclauda__*` and the discovery-only
`ToolSearch`. Missing or unexpected inventories abort the request. Later
unauthorized tool-use events also abort it.

`--bare` is deliberately excluded: it does not use subscription login. The probe
requires the official `auth status` result to report `loggedIn: true` and
`authMethod: "claude.ai"`. API key/provider environment overrides are removed
from child environments without inspecting their values.

The UUID passed at launch is only a proposal until a real provider event reports
the session ID. Result events supply success/error, token/model usage, turn count
and optional `total_cost_usd`. That dollar value is a provider estimate, not an
invoice. A finite owner turn limit is passed as `--max-turns`; an unlimited one
omits the flag, so Claude applies no turn cap. The supervisor deadline applies
separately. No hard dollar or token limit is advertised.

Reference: [Claude CLI](https://code.claude.com/docs/en/cli-reference),
[programmatic runs](https://code.claude.com/docs/en/headless),
[MCP configuration](https://code.claude.com/docs/en/mcp).

## Codex

The adapter uses `--no-daemon exec --ignore-user-config --strict-config --json
--sandbox read-only --color never -C <workspace> -` with per-invocation settings.
Authentication remains owned by Codex and is restricted to `chatgpt`. The
adapter marks this workspace untrusted for this invocation to skip project
configuration, disables project instruction discovery, and configures only
CodaClauda's required MCP server. No user configuration is rewritten.

Provider approval is scoped to that server and an explicit list of its known
tools. `approval_policy="never"` remains in force globally. The invocation sets
`mcp_servers.codaclauda.default_tools_approval_mode="prompt"`, sets
`enabled_tools` to `get_context`, `list_files`, `read_file`, `write_file`, `ask`,
`review`, `delegate`, `wait`, `messages`, `cancel`, `spark_status`, `spark_run`,
`spark_wait`, `spark_logs`, and `spark_cancel`, plus `write_begin`,
`write_chunk`, `write_commit` and `write_abort` for grants created by 0.5 or
later (a 0.4 grant keeps exactly the earlier list), then sets each listed tool's
`mcp_servers.codaclauda.tools.<tool>.approval_mode="approve"`. This allows only
those owned tools to reach the server without another provider prompt. The
server still validates the capability, grant scope, allowed paths, request kind,
expiry, budgets and compute allowlist; provider approval does not expand the
owner grant. New server tools receive no implicit approval or exposure.

The installed CLI accepted the full allowlist and all per-tool policies in a
non-model parser check. The preceding live run successfully called context and
file-read tools but its peer `ask` was rejected upstream under the default MCP
approval policy. Acceptance of a real peer handoff with the explicit policies
remains a separate release check.

Shell execution, additional agents, apps, plugins, hooks, goals, memories, image
view/generation, browser/computer use, skill discovery/install and other external
tool surfaces are disabled using the installed CLI's feature switches. Native
tools also require the following per-invocation settings:

```toml
features.code_mode = { enabled = true, excluded_tool_namespaces = ["functions"] }
features.code_mode_only = true
features.code_mode_host = { enabled = true, disable_in_process_fallback = true }
```

The code-mode host carries MCP discovery and must stay enabled. Disabling it
caused the first live Codex request to return a blocked answer without making a
CodaClauda MCP call. The retired `tool_search` and
`tool_search_always_defer_mcp_tools` switches are not substitutes.

The native `functions` namespace is excluded from the code-mode nested tool map;
code-mode-only exposure hides those native tools from the direct model surface.
CodaClauda's MCP namespace remains available through the code-mode wrapper.
This combination matters because `shell_tool=false` alone does not remove
native `apply_patch`. Native writes are additionally denied by the read-only
sandbox. The installed CLI accepted these structured settings during a
non-model feature probe; the corrected combination still requires real
acceptance before a release can claim a working provider boundary.

The event parser aborts on native command/file-change/search/image events,
unexpected tool-event types, or an MCP call whose server is not `codaclauda`.
This is an observed-event guard: an event may arrive after an operation starts
or finishes, so stopping the job cannot undo an operation. Provider configuration
and the sandbox are the primary boundary; event rejection is additional failure
detection. Effective tool exposure must be checked in real acceptance for every
supported CLI revision. A change in provider behavior is a compatibility
failure, not permission to widen access.

`thread.started.thread_id` supplies actual session identity. Agent-message items
supply the answer; MCP items supply tool-call evidence; `turn.completed.usage`
supplies observed token usage. The CLI does not provide this adapter with a
reliable dollar cost or hard per-request turn/token ceiling: `codex exec --help`
of codex-cli 0.163.0-alpha.10.2 lists no turn-limit option, so `max_turns` is
not enforced for Codex runs. Those fields are unavailable. Owner grant limits
still bound peer requests, hops, tool calls, concurrency and wall time in the
CodaClauda core.

Reference: [noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
[MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[official tool exposure implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/spec_plan.rs),
[official configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json).

## Existing chats and acceptance

The official Claude `agents --json` interface can inventory existing sessions.
The documented Codex app-server has supported thread inventory and turn controls.
They are future adapter options; version 1 does not attach to an existing chat
or claim that an MCP notification wakes it. An already connected external agent
must call the CodaClauda tools and poll for a reply itself.

Tests of parsers, quoting and supervision do not establish provider acceptance.
Release evidence must include real calls by both agents, provider session IDs,
MCP call receipts, a scoped delegated change and independent review, plus
restart/idempotency, cancellation and budget/claim-conflict checks. Subscriptions,
network availability, provider policy and installed CLI compatibility are
external prerequisites. Optional Spark acceptance is tracked separately.
