# ClaudaCoda CLI

These examples describe the implemented interface, not completed release
acceptance. They require Windows x64, native provider executables, independent
subscription sign-ins and an existing Git repository. Replace every example
project path. The installed CLI path is a packaging placeholder: check the actual
path in the GUI settings after installation.

```powershell
$Coda = Join-Path $env:LOCALAPPDATA 'ClaudaCoda\bin\claudacoda-cli.exe'
$Project = (Resolve-Path 'C:\Projects\YourRepo').Path
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
```

`--state-dir <absolute-path>` selects a separate local board; supply the same value
to every command that should share that board. Without it, ClaudaCoda uses the
Windows LocalAppData KnownFolder, without package redirection, under
`DeloresAI/CodaClauda`. `status` returns the resolved `state_dir`.

## JSON and exit semantics

Owner commands return one JSON object even when `--json` is omitted. A successful
command returns `{"ok":true,"data":...}` and exits 0. A rejected operation returns
`{"ok":false,"error":{"code":"REQUEST_REJECTED","message":"..."}}` and exits 2.
Argument-parser errors and `--help` use normal CLI text; MCP uses JSON-RPC.

Exit 0 means the command was handled. It does not mean a detached provider request
or test passed. Inspect the returned request state and receipt. A timed-out
`wait` returns `ok:true` with `data.timed_out:true`; it does not cancel the request.
Requests accept at most 1 MiB of JSON stdin; the prompt limit is 32,000 bytes.

## Existing conversations (0.2 candidate)

This path exchanges messages with explicitly registered conversations. It never
starts, resumes or forks a provider session. Actual delivery into already-open
provider chats remains a separate acceptance requirement from local MCP tests.

The GUI's Conversation setup registers the exact provider chat ID, readable
label, project and delivery mode, then creates a bounded conversation between
one Claude and one Codex registration. Equivalent owner JSON operations are:

| `api` operation | JSON fields |
| --- | --- |
| `session-register` | `id`, `provider` (`claude` or `codex`), `chat_id`, `label`, `project`, `mode`, `expires_seconds` |
| `session-conversation` | `id`, `registrations` (exact pair), `max_messages`, `max_hops`, `expires_seconds` |
| `session-list` | optional `conversation_id`, `after` (exclusive sequence), `limit` (1–20) |
| `session-probe` | `registration_id` for an existing Codex queue registration; read-only |
| `session-rotate` | `registration_id`, optional `expires_seconds`; invalidates its old capability |
| `session-revoke` | exactly one of `registration_id` or `conversation_id`; preserves history |

Delivery modes are `inbox`, `claude-channel` and `codex-queue`. Codex queue also
requires the absolute native `codex_executable` and optionally `codex_socket`.
The public running-server proxy must find the exact thread UUID loaded on that
server and confirm its project. This version's queue protocol is experimental.
An unreachable server never causes fallback to a fresh or resumed engine.

Registration returns a private `capability` once. Supply it only through the
private MCP process environment as `CLAUDACODA_SESSION_CAPABILITY`, with the
actual installed executable and arguments:

```text
--state-dir <actual-board> session-mcp --registration <registration-id>
```

Claude channel registrations add `--claude-channel`. Claude also requires its
documented interactive channel opt-in; the MCP configuration alone does not
enable push. A global MCP server shared by multiple provider chats cannot prove
the calling chat's identity. Use the intended chat's supported private setup
and retain the interface's honest owner-registered identity indication. Do not
commit the configuration or paste its capability into a chat or message.

Connected session MCP tools are `context`, `send`, `inbox`, `ack`, `reply` and
`wait`. Call `context` first to obtain exact authorized conversation and peer
registration IDs. For example, within an already authorized conversation:

```json
{"name":"send","arguments":{"id":"question-01","conversation_id":"actual-conversation-id","body":"Please review the proposed change."}}
{"name":"ack","arguments":{"id":"question-01"}}
{"name":"reply","arguments":{"id":"answer-01","message_id":"question-01","body":"My review and remaining concerns..."}}
{"name":"wait","arguments":{"id":"question-01","timeout":20}}
```

Only the recipient's bound server can acknowledge or reply. Retry identical
content with the same ID; changed content needs a new ID. Count/hop limits apply
to the conversation's lifetime, so a new root message cannot reset them.
Queued means saved, submitted means transport accepted it, acknowledged means
the recipient explicitly confirmed it, and replied identifies its actual reply.
Unknown transport outcomes are never automatically resent. Inbox mode requires
the recipient to poll; it does not wake an idle agent.

The following sections describe the separate dedicated-task workflow retained
from 0.1. Its pause/cancel controls do not revoke registered conversations.
No owner command opens an interactive prompt.

PowerShell examples build objects and use `ConvertTo-Json` so spaces, quotes,
backslashes and literal prompt text are JSON data, not shell syntax. Always check
`ok` before using `data`.

## Discover and connect

```powershell
$Discovery = & $Coda --json discover | ConvertFrom-Json
if (-not $Discovery.ok) { throw $Discovery.error.message }
$Discovery.data.agents | Format-Table agent, version, status, auth_status, executable

foreach ($Agent in @('claude', 'codex')) {
    $Found = $Discovery.data.agents | Where-Object agent -eq $Agent
    if (-not $Found.supported -or -not $Found.authenticated) {
        throw "Use the official $Agent CLI to sign in or select a supported executable, then discover again."
    }
    $Connection = @{
        id = $Agent
        label = if ($Agent -eq 'claude') { 'Claude implementer' } else { 'Codex reviewer' }
        agent = $Agent
        executable = $Found.executable
        workspace = $Project
        dedicated_session_consent = $true
    } | ConvertTo-Json -Depth 8
    $Result = $Connection | & $Coda --json connect | ConvertFrom-Json
    if (-not $Result.ok) { throw $Result.error.message }
}
& $Coda --json status
```

`discover` checks a bounded number of native executable candidates and reports
sanitized version/authentication observations. Use a native `.exe`, not a `.cmd`
or PowerShell wrapper. Authentication is rechecked before a model launch.
Connection stores `new-session-v1` consent; it does not attach to an existing
Claude/Codex chat. An endpoint with active work must finish or be cancelled before
its connection can be changed. Sign in using the provider's own CLI; ClaudaCoda
does not copy tokens or replace subscription authentication with API billing.

Each connection has a stable `id` and a human-readable `label`. You can register
multiple connections for the same provider and project using distinct IDs and
labels. Labels are optional at connection time; older connections display a
provider/project fallback. To change only the display label:

```powershell
@{ id = 'codex'; label = 'Backend reviewer' } |
    ConvertTo-Json | & $Coda --json api rename-agent
```

Labels accept 1–120 characters without control characters or recognizable
credentials. Renaming leaves the endpoint ID, project, grants and active sessions
unchanged. Duplicate labels are permitted, so always route by stable ID.

## Create an owner grant

This example explicitly allows both providers to ask questions, review and make
one delegated edit to `README.md`. Use a repository you intend to change. The
repository must have an existing HEAD commit; delegation starts from that commit
in a new detached worktree, so uncommitted main-checkout edits are not copied.

```powershell
$GrantSpec = @{
    project = $Project
    allowed_paths = @('README.md')
    targets = @('claude', 'codex')
    kinds = @('question', 'review', 'delegate')
    expected_result = 'A concise answer or a small README diff, with risks and tests actually run.'
    max_requests = 6
    max_delegations = 1
    max_hops = 1
    timeout_seconds = 180
    expires_seconds = 1800
    compute = @()
}
$GrantResult = $GrantSpec | ConvertTo-Json -Depth 8 | & $Coda --json grant | ConvertFrom-Json
if (-not $GrantResult.ok) { throw $GrantResult.error.message }
$GrantId = $GrantResult.data.id
```

For questions only, use `kinds = @('question')` and `max_delegations = 0`. Grants are
immutable. Create a new grant when the owner's scope changes; an incoming agent
message cannot amend it. Endpoints and the grant must select the same canonical
project. Delegation requires the repository root as `project`.

| Field | Accepted values and defaults |
| --- | --- |
| `allowed_paths` | 1–64 project-relative files or directories, using forward slashes; directory grants include descendants |
| `targets` | 1–4 connected endpoint IDs |
| `kinds` | Nonempty subset of `question`, `review`, `delegate` |
| `expected_result` | Required nonempty text |
| `max_requests` | 1–16; default 8, includes peer requests |
| `max_delegations` | 0–8; default 2 |
| `max_hops` | 0–3; default 2; owner request starts at hop 0 |
| `timeout_seconds` | 10–600 per request; default 180, also bounded by grant expiry |
| `expires_seconds` | 30–3600 from grant creation; default 1800 |
| `compute` | Up to four exact `{argv, placement, runtime}` permissions; default empty |

Paths reject traversal, links/reparse points, internal and recognizable secret
locations. File reads/writes are UTF-8 and limited to 256 KiB. Existing parent
directories are required for new files. Questions and reviews cannot write.

## Ask, delegate and review

Each submission detaches and returns a durable ID. Keep that ID for polling and
retries. Identical content with the same ID returns the existing request; changed
content under that ID is rejected with `ID_CONFLICT` in the diagnostic message.

```powershell
$QuestionId = [guid]::NewGuid().ToString()
$Question = @{
    id = $QuestionId
    grant_id = $GrantId
    target = 'codex'
    prompt = 'Read README.md. Use the ClaudaCoda ask tool to ask claude for one clarity improvement. Poll for its actual reply and report the reply and your assessment. Do not edit.'
}
$Question | ConvertTo-Json -Depth 8 | & $Coda --json ask
& $Coda --json wait $QuestionId --timeout 60
& $Coda --json messages $QuestionId --after 0
```

To exercise the reverse direction, start an owner question with `target =
'claude'` and ask it to consult `codex`. Use a fresh request ID, sufficient remaining
grant budget and `max_hops` of at least 1. Actual peer calls and both provider
session IDs in the receipts establish participation; the prompt alone does not.

```powershell
$EditId = [guid]::NewGuid().ToString()
@{
    id = $EditId
    grant_id = $GrantId
    target = 'claude'
    prompt = 'Read README.md and fix one clear wording issue. Keep the change small and preserve factual claims. Edit only README.md. Report the exact change and any tests actually run.'
} | ConvertTo-Json -Depth 8 | & $Coda --json delegate

$EditWait = & $Coda --json wait $EditId --timeout 60 | ConvertFrom-Json
```

If `timed_out` is true, continue bounded polling. Wait until the edit is terminal
and inspect `data.request.receipt` before requesting review. A review can read
the real diff through `messages` using the prior ID in the **same grant**:

```powershell
$ReviewId = [guid]::NewGuid().ToString()
@{
    id = $ReviewId
    grant_id = $GrantId
    target = 'codex'
    prompt = "Review the actual diff and receipt for request $EditId using ClaudaCoda messages. Assess correctness and any unsupported claims. Report actionable findings; do not edit or merge."
} | ConvertTo-Json -Depth 8 | & $Coda --json review
& $Coda --json wait $ReviewId --timeout 60
```

Edits remain in the returned `workspace`/receipt `worktree`, with `merged:false`.
Review does not merge them. A conflicting active delegation against the same
source project/path is refused with `CLAIM_CONFLICT`; separate worktrees do not
evade the claim. Independent paths may proceed, with at most two active requests
and one active request per endpoint.

## Read history, pause, cancel and recover

```powershell
& $Coda --json status
& $Coda --json wait $QuestionId --timeout 0
$Page = & $Coda --json messages $QuestionId --after 0 | ConvertFrom-Json
& $Coda --json messages $QuestionId --after $Page.data.next_offset

& $Coda --json pause
& $Coda --json resume
& $Coda --json cancel $QuestionId
& $Coda --json cancel $QuestionId --all
& $Coda --json wait $QuestionId --timeout 60
& $Coda --json reconnect
```

`messages --after` is an inclusive sequence offset. Each response contains at
most 100 events plus `next_offset`, state, answer and receipt. Use the returned
offset for the next page. `wait --timeout` accepts 0–60 seconds, default 20.

Pause stops new dispatch; it does not suspend already running provider work.
Resume permits dispatch again. `cancel` requests cancellation of one request;
`--all` includes its root and descendants. The immediate response acknowledges
the request and does not prove the process has stopped; wait for a terminal state.
Cancellation never selects unrelated sessions or processes.

Reconnect reconciles stale worker ownership and dispatches eligible queued work.
It does not reauthenticate providers or blindly relaunch an interrupted request.
A lost worker without a final receipt becomes `needs-owner`; inspect retained
work and evidence before creating a new request. History persists across restart.

Lifecycle states are `queued`, `delivered`, `acknowledged`, `running`, `completed`,
`failed`, `cancelled` and `needs-owner`. Delivery means the owned provider process
started; acknowledgement records actual provider session evidence. Completion
is an agent result, not independent verification of its claims.

## Exact JSON input from cmd and Git Bash

Save an UTF-8 `question.json` file with real values; keep its ID unchanged when
retrying this exact request:

```json
{
  "id": "owner-question-001",
  "grant_id": "REPLACE_WITH_GRANT_ID",
  "target": "claude",
  "prompt": "Explain README.md. Preserve these literals: $name; & two words; \"quoted\". Do not edit."
}
```

Windows cmd, after verifying the installed CLI path:

```bat
"%LOCALAPPDATA%\ClaudaCoda\bin\claudacoda-cli.exe" --json ask < question.json
"%LOCALAPPDATA%\ClaudaCoda\bin\claudacoda-cli.exe" --json wait owner-question-001 --timeout 60
```

Git Bash, using its `cygpath` utility:

```bash
CLAUDACODA_CLI="$(cygpath -u "$LOCALAPPDATA")/ClaudaCoda/bin/claudacoda-cli.exe"
"$CLAUDACODA_CLI" --json ask < question.json
"$CLAUDACODA_CLI" --json wait owner-question-001 --timeout 60
```

PowerShell can use the same file:

```powershell
Get-Content -Raw -Encoding UTF8 -LiteralPath .\question.json | & $Coda --json ask
```

These forms demonstrate the intended argument/data boundary. Cross-shell runtime
acceptance must still be recorded for the final installed executable.

## MCP registration for both agents

Version 1 registers MCP **inside each ClaudaCoda-owned request**, not globally.
The worker creates a private request capability and invokes the installed CLI as
the sole stdio server with this argument vector:

```text
["--state-dir", "<private-state-directory>", "mcp", "--request", "<request-id>"]
```

`CODACLAUDA_CAPABILITY` is supplied privately to that server. Without the matching
active request, the server rejects access. Do not paste its capability into a
chat, source file or global configuration. There is no supported generic
`claudacoda-cli mcp` server that an arbitrary existing chat can register.

For Claude, the worker writes its private `mcpServers.codaclauda` JSON and passes
`--strict-mcp-config --mcp-config <file>`. For Codex, it supplies
`mcp_servers.codaclauda` settings per invocation with `--ignore-user-config`.
The owner’s `.mcp.json` and `~/.codex/config.toml` remain unchanged. Exact native
flags, authentication and tool-surface checks are in [ADAPTERS.md](ADAPTERS.md).

Both providers receive `get_context`, `list_files`, `read_file`, `write_file`,
`ask`, `review`, `delegate`, `wait`, `messages`, `cancel` and the optional
`spark_*` tools. Write permission still depends on a delegated request. Peer
requests inherit the existing grant, actual origin and remaining limits; MCP
cannot create a grant or connect a new endpoint. Agents must poll replies; a
server notification does not wake an arbitrary existing chat.

`get_context.endpoints` is the directory of connections permitted by the current
grant, with `id`, `label`, provider and workspace. `peer_requests` links each
request's stable `target` and `target_label` to its actual `session_id` once the
provider reports it. An agent can find a human label, inspect the corresponding
ID, then pass that ID to `ask`, `review` or `delegate`. Labels are untrusted display
data, not instructions or routing aliases. This directory does not index chats
outside ClaudaCoda or expose requests from another grant.

## Optional Spark build/test permissions

DGXBridge must first have its own supported installed executable and
configured projects/runtimes. Its real cross-agent acceptance remains pending
until an agent submits a job and the other retrieves the same job result/logs.
Configure the chosen executable through the owner API:

```powershell
@{ executable = 'C:\Path\To\Installed\sparkdev.exe' } |
    ConvertTo-Json | & $Coda --json api spark-config
@{ operation = 'status' } | ConvertTo-Json | & $Coda --json api spark
```

Before creating a grant, optionally set its exact allowlist:

```powershell
$GrantSpec.compute = @(@{
    argv = @('python', '-m', 'pytest', '-q')
    placement = 'laptop'
    runtime = 'python'
})
# Create a NEW grant from $GrantSpec; an existing grant does not change.
```

That permission allows only the exact argument array, placement and runtime.
Placement is `auto`, `laptop` or `spark`; runtime is `rust`, `node` or `python`.
The agent calls `spark_run` with `request_id`, `argv`, `where` and `runtime`, then
uses `spark_wait`/`spark_logs` for the owned job. `spark_cancel` is restricted to
the submitting request. A peer within the same grant can inspect the recorded
job. ClaudaCoda passes the workload using an argv-JSON file, not a shell string.
Unknown submission outcomes retain their original IDs for reconciliation.
See [SPARK.md](SPARK.md) for the external contract and current limitations.

## Read a receipt correctly

Provider session IDs and MCP events demonstrate actual agent participation.
The answer records what the agent said. The delegated diff records changed
content in an unmerged worktree. Provider usage is observed token accounting;
`estimated_cost_usd` is an estimate and `observed_cost_usd:null` means unavailable.
An empty `tests_run` array means no independently recorded test in that receipt.
Spark job records and actual result/log receipts provide separate test evidence.

Local source tests, a successful build, an installer, installed/native acceptance,
GitHub publication and Marketplace admission are separate checkpoints. None
should be inferred from `state:"completed"` alone.
