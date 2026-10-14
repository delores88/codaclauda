# CodaClauda CLI, contract version 1

These examples describe the implemented interface, not completed release
acceptance. They require Windows x64, native provider executables, independent
subscription sign-ins and an existing Git repository. Replace every example
project path. The installed CLI path is a packaging placeholder: check the actual
path in the GUI settings after installation.

```powershell
$Coda = Join-Path $env:LOCALAPPDATA 'CodaClauda\bin\codaclauda-cli.exe'
$Project = (Resolve-Path 'C:\Projects\YourRepo').Path
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
```

`--state-dir <absolute-path>` selects a separate local board; supply the same value
to every command that should share that board. Without it, CodaClauda uses the
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
its connection can be changed. Sign in using the provider's own CLI; CodaClauda
does not copy tokens or replace subscription authentication with API billing.

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
    prompt = 'Read README.md. Use the CodaClauda ask tool to ask claude for one clarity improvement. Poll for its actual reply and report the reply and your assessment. Do not edit.'
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
    prompt = "Review the actual diff and receipt for request $EditId using CodaClauda messages. Assess correctness and any unsupported claims. Report actionable findings; do not edit or merge."
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
"%LOCALAPPDATA%\CodaClauda\bin\codaclauda-cli.exe" --json ask < question.json
"%LOCALAPPDATA%\CodaClauda\bin\codaclauda-cli.exe" --json wait owner-question-001 --timeout 60
```

Git Bash, using its `cygpath` utility:

```bash
CODACLAUDA_CLI="$(cygpath -u "$LOCALAPPDATA")/CodaClauda/bin/codaclauda-cli.exe"
"$CODACLAUDA_CLI" --json ask < question.json
"$CODACLAUDA_CLI" --json wait owner-question-001 --timeout 60
```

PowerShell can use the same file:

```powershell
Get-Content -Raw -Encoding UTF8 -LiteralPath .\question.json | & $Coda --json ask
```

These forms demonstrate the intended argument/data boundary. Cross-shell runtime
acceptance must still be recorded for the final installed executable.

## MCP registration for both agents

Version 1 registers MCP **inside each CodaClauda-owned request**, not globally.
The worker creates a private request capability and invokes the installed CLI as
the sole stdio server with this argument vector:

```text
["--state-dir", "<private-state-directory>", "mcp", "--request", "<request-id>"]
```

`CODACLAUDA_CAPABILITY` is supplied privately to that server. Without the matching
active request, the server rejects access. Do not paste its capability into a
chat, source file or global configuration. There is no supported generic
`codaclauda-cli mcp` server that an arbitrary existing chat can register.

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

## Optional Spark build/test permissions

Spark Dev Bridge must first have its own supported installed executable and
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
job. CodaClauda passes the workload using an argv-JSON file, not a shell string.
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
