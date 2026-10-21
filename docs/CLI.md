# CodaClauda CLI

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

Mailbox `post` (0.6) adds `data.delivery`: `received` with `pickup_seconds`
when the running app polls the recipient, `app_not_running` with a `fix` when
the recipient is `codaclauda-team` or one of the app's sessions and the app is
not running, otherwise `passive`. The message is saved in every case. A
`--kind reply` without `--reply-to` answers the newest message from `--to` to
`--from`, or is refused naming `--reply-to`. See MAILBOX.md.

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
| `session-list` | optional `conversation_id`, `after` (exclusive sequence), `limit` (1–100, default 20) |
| `session-probe` | `registration_id` for an existing Codex queue registration; read-only |
| `session-rotate` | `registration_id`, optional `expires_seconds`; invalidates its old capability |
| `session-revoke` | exactly one of `registration_id` or `conversation_id`; preserves history |

Registration `expires_seconds` is 30–2592000 (30 days), default 86400. A
conversation accepts `max_messages` 1–10000 (default 64), `max_hops` 0–16
(default 8) and `expires_seconds` 30–2592000 (default 86400), never outliving
either registration. The session `inbox` page limit is 1–100 (default 20) and
`wait` accepts 0–300 seconds (default 20); a client's own tool timeout may end a
long wait sooner. Codex stops MCP calls after 60 seconds by default; for waits
longer than 55 seconds set `tool_timeout_sec = 330` on the CodaClauda session
server's `[mcp_servers.<name>]` entry in Codex's `config.toml`.

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
its connection can be changed. Sign in using the provider's own CLI; CodaClauda
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
    max_delegations = 1
    max_hops = 'unlimited'
    timeout_seconds = 3600
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
| `targets` | One or more connected endpoint IDs; no product cap |
| `kinds` | Nonempty subset of `question`, `review`, `delegate` |
| `expected_result` | Required nonempty text |
| `timeout_seconds` | Run time per request, at least 10; also bounded by the grant's remaining lifetime |
| `expires_seconds` | Grant lifetime from creation, at least 30; `"never"` is a synonym of `"unlimited"` |
| `max_requests` | At least 1; includes peer requests |
| `max_delegations` | At least 0; 0 allows none |
| `max_hops` | At least 0; the owner request is hop 0, so 0 allows no peer requests |
| `max_turns` | Provider turns per run, at least 1 |
| `max_mcp_calls` | CodaClauda tool calls per request, at least 1; `wait` and `messages` are not counted |
| `max_compute_jobs` | Owned Spark jobs per request, at least 0 |
| `compute` | Up to four exact `{argv, placement, runtime}` permissions; default empty |

Every budget accepts a JSON whole number from its minimum to 9007199254740991
(the largest integer JavaScript represents exactly), the string `"unlimited"`,
or omission/`null`, which inherits the owner's default (below). Anything else is
refused with an error naming the field, for example `max_turns must be a whole
number from 1 to 9007199254740991, or "unlimited"`. Zero is a real limit where
the minimum is 0. A lifetime whose expiry time would exceed that range is refused
with `expires_seconds is too large to schedule; choose a smaller value or
"unlimited"`; nothing is silently rounded into unlimited.

The grant stores every budget resolved at creation (`policy_version: 1`), so a
later change to the owner's defaults never changes an issued grant. The returned
grant adds `expires_at` (Unix time or `"never"`), `policy_version`, `revoked_at`
(`null` until revoked) and `effective`, the limits actually enforced.

Grants created before 0.5 have no `policy_version` (version 0) and keep exactly
their 0.4.0 behavior: their stored request, delegation, hop, run-time and expiry
values; 12 turns; 128 tool calls counting every call including `wait` and
`messages`; whole-file `read_file`/`write_file` of at most 256 KiB; a 1 MiB
provider stream line and 8 MiB total provider output, either of which stops the
run; at most 3600 seconds per run; and 2 Spark jobs per request. Their
`effective` field lists these.

These are owner choices, not product ceilings. When work reaches one, the error
or blocker names the limit and the setting that raises it, for example
`OWNER_LIMIT: request budget reached (max_requests 100 on this authorization).
Create a new authorization with a higher Maximum requests.` A run stopped by its
time limit reports `Run time limit reached (timeout_seconds N). Create a new
authorization with a longer run time.`; one stopped by its turn limit names
`max_turns`, and the tool-call budget names `max_mcp_calls`. These end as
`needs-owner`, and the receipt keeps the machine `stop_reason` beside the
readable `stop_message`.

Paths reject traversal, links/reparse points, internal and recognizable secret
locations. Files are UTF-8 and have no size cap: `read_file` returns one window
at a time, `write_file` takes one body of up to 8 MiB, and staged writes
(`write_begin`/`write_chunk`/`write_commit`) carry a file of any size (see MCP
below). Existing parent directories are required for new files. Questions and
reviews cannot write.

### Owner policy, board limits and revocation

```powershell
@{} | ConvertTo-Json | & $Coda --json api policy
@{ concurrent = 6; grant_defaults = @{ max_turns = 400; timeout_seconds = 'unlimited' } } |
    ConvertTo-Json -Depth 4 | & $Coda --json api policy-set
@{ concurrent = 'unlimited' } | ConvertTo-Json | & $Coda --json api limits-set
@{ id = $GrantId } | ConvertTo-Json | & $Coda --json api grant-revoke
```

The owner policy is `policy.json` in the board directory, written atomically
under its own `policy.lock`. `policy` returns `{"concurrent", "grant_defaults"}`.
`policy-set` accepts `concurrent` and/or a partial `grant_defaults` object with
any of the grant budgets above; omitted fields keep their current value and the
full policy is returned. Unknown fields are refused. Without a policy file the
defaults are: `concurrent` `"unlimited"`, `timeout_seconds` 86400 (one day),
`expires_seconds` 604800 (seven days), and every count `"unlimited"`.
`limits`/`limits-set` read and write only `concurrent` (a whole number of at
least 1, or `"unlimited"`). Raising it dispatches eligible queued work; lowering
it never stops running work.

`grant-revoke` records `revoked_at` once and moves `expires_at` to that moment,
so older readers also see an expired grant. Its queued requests become
`needs-owner`, running requests are cancel-flagged and their owned Spark jobs
cancelled. Admission, dispatch, every worker heartbeat and every MCP tool call
check the current saved grant and refuse with `OWNER_LIMIT: authorization
expired or revoked; create a new authorization`. Revoking again returns the same
grant; a revoked grant is never restored.

Policy, limits and revocation are owner operations: a process holding a scoped
request or session capability is refused.

## Scheduling

`concurrent` bounds **active** requests: claimed by a worker, not finished, and
not waiting. A request is **waiting** while it is blocked in the MCP `wait` tool
on one of its own descendants; its slot is then free for other work, which is
how a parent at `concurrent = 1` can hand work to a child and resume. Starting a
wait records `waiting_on` with the child's ID. It is cleared when the child
finishes (the child's slot passes to the parent) or when the parent makes another
tool call while a slot is free. A wait that times out while the child still runs
leaves the parent waiting, and any other tool call it makes while every slot is
busy is refused with `SLOT_BUSY` (not counted against `max_mcp_calls`); the parent
calls `wait` again. `messages` is a poll and never changes this. A request never runs while another request holds
its endpoint: one request per endpoint.

Dispatch first launches queued requests that a waiting request is blocked on
(oldest first), then everything else oldest first, while a slot and the target
endpoint are free. A finite `concurrent` is never exceeded. `status`
reports `limits: {"concurrent", "active", "waiting", "queued"}`, and each
queued request has `queued_reason`: `waiting for a free slot
(active N of M)`, `endpoint <id> busy with request <rid>`, `dispatch is paused
by the owner` or `ready to dispatch`.

Waits form a graph: a waiting request points at the request it waits on, and a
queued request points at the request running on its endpoint. A wait that would
close a cycle in that graph, across all request trees, returns at once with
`CYCLE: <a> → <b> → … ; answer from your own context or ask a different peer`.
A peer request whose endpoint chain leads back to its own parent (for example a
child addressed to the parent's own endpoint) is refused with the same error
before anything is created.

## Ask, delegate and review

Each submission detaches and returns a durable ID. Keep that ID for polling and
retries. Identical content with the same ID returns the existing request; changed
content under that ID is rejected with `ID_CONFLICT` in the diagnostic message.
An ID that differs from an existing one only in letter case is also rejected with
`ID_CONFLICT`, because Windows file names (history, payloads, staging) ignore case.

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
evade the claim. Independent paths may proceed, within the board's `concurrent`
setting (default unlimited) and one active request per endpoint.

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
most 100 events plus `next_offset`, `events_total`, state, answer, receipt and
`payloads`. Use the returned offset for the next page until `events` is empty.
`wait --timeout` accepts 0–60 seconds, default 20. `wait` returns the request
without its event log, plus `events_total`; read the events with `messages`.

A request keeps at most 2000 recent events, and at most 1 MiB of them, in the
board. Older events are first appended durably to `requests/<id>.events.jsonl`
in the board directory and then removed from `state.json`; `spilled_through`
records the last moved sequence and `spilled_bytes` the file length at that point.
Bytes after that length (a torn or uncommitted append from a crash) are never read
and are cut before the next append. Sequence numbers (`next_seq`) and the lifetime
tool-call count (`mcp_calls_used`) never depend on the retained events, and
`messages` pages across the file and the board in sequence order, each event
once. An answer, diff or changed-file summary larger than 256 KiB is written in
full to `requests/<id>/<name>.txt`; the request keeps a clearly marked 16 KiB
preview and `payloads.<name>` records its `path`, `bytes` and `sha256`. Nothing
is silently truncated.

The first change that saves 0.5-only data (a current grant, a revocation, an
unlimited budget or the request fields above) upgrades `state.json` to schema 3,
first saving the exact previous bytes as `state.schema<old>.backup.json`. 0.4
clients refuse schema 3 (`unsupported state schema; upgrade CodaClauda`), and
their running workers and MCP servers stop at their next board read.
`mailbox.json` is not changed.

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

Version 1 registers MCP **inside each CodaClauda-owned request**, not globally.
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
`write_begin`, `write_chunk`, `write_commit`, `write_abort` (not for grants
created before 0.5), `ask`, `review`, `delegate`, `wait`, `messages`, `cancel`
and the optional `spark_*` tools. Write permission still depends on a delegated request. Peer
requests inherit the existing grant, actual origin and remaining limits; MCP
cannot create a grant or connect a new endpoint. Agents must poll replies; a
server notification does not wake an arbitrary existing chat.

Every tool call except `wait` and `messages` (status reads) counts against the
grant's `max_mcp_calls`; the count (`mcp_calls_used`) is kept for the request's
lifetime, independent of retained events. Over the budget a call fails with
`OWNER_LIMIT: tool-call budget reached (max_mcp_calls N on this authorization).
Create a new authorization with a higher Maximum tool calls.` Grants created
before 0.5 keep 128 calls, counting every call.

`list_files` returns a page: optional `offset` (default 0) and `limit` (default
1000, 1–10000), with `files`, `offset`, `limit`, `total` and `next_offset`
(`null` on the last page).

`read_file` takes `path`, optional `offset` in bytes (default 0), optional
`max_bytes` (default 65536, 1–8388608) and optional `expect_version`. It returns
`path`, `content`, `offset`, `next_offset` (`null` at end of file), `size`,
`eof` and `version`, the `sha256:<hex>` digest of the whole file. A window that
stops before the end ends after its last line break, or on a character boundary
when it has none, and always advances. The whole MCP response line stays within
the 8 MiB transport frame, so text that needs heavy JSON escaping comes back in a
shorter window. Continue from `next_offset`; an offset past the end or inside a
character is refused. Passing the first window's `version` as `expect_version`
makes a later window fail with `FILE_CHANGED: <path> changed since you started
reading; start again from offset 0.` if the file changed in between.

Each window is redacted as if the whole file were redacted at once. No
credential form except a private-key block can contain `,`, `;` or `}`, so the
window is matched together with its text back to the previous and forward to
the next of those characters; if either is more than 1 MiB away the read fails
with `READ_UNVERIFIABLE: cannot verify credential redaction around offset X (no
separator within 1 MiB); read from a different offset or ask the owner.`
Private-key blocks are found by streaming the file for their BEGIN/END markers,
and any part of a block inside the window is redacted, including a block with
no END marker (to the end of the file). Redaction may remove slightly more than
`redact` on the whole text; it never removes less. Key prefixes (`sk-`, `gh?_`,
`Bearer`) count only at the start of a word or after `_`, so `task-...` and
`desk-...` are ordinary text.

`write_file` (delegations only) takes `path`, `content` (at most 8 MiB) and
optional `expect_version`: `"sha256:<hex>"` from `read_file`, or `"absent"` for
a file that must not exist yet. A mismatch fails with `FILE_CHANGED` and writes
nothing. The content must be UTF-8 with no recognizable credential; it replaces
the file atomically and returns `path`, `sha256`, `bytes`, `version` and
`merged: false`.

Larger files use a staged write:

1. `write_begin {path, expect_version}` checks the path and the file's current
   identity and returns an `upload_id` bound to this grant, request, path and
   identity.
2. `write_chunk {upload_id, offset, content}` appends up to 8 MiB; `offset` must
   equal the bytes staged so far (`staged_bytes` from the previous call, 0 first).
3. `write_commit {upload_id}` checks the staged content (UTF-8, no credential,
   by the same rules as reads), then, under the board lock, that the grant is
   still active and the request not cancelled or finished, that the path still
   resolves to the same authorized location with no link or reparse point, and
   that the file still has the identity `write_begin` saw (same digest, or still
   absent). Only then does it replace the file atomically. Any change, including
   same-size content with an unchanged timestamp, fails with `FILE_CHANGED`.
4. `write_abort {upload_id}` discards the upload.

Staged data lives in the board's `staging/<request>/` directory, beside the
delegated worktree, so the final rename stays on one volume (otherwise it is
first copied to a hidden temporary file beside the target). A commit consumes
the upload whether or not it succeeds. Uploads are removed when the request
finishes, and `reconnect` (recover) removes any left for finished requests.
Grants created before 0.5 keep whole-file `read_file`/`write_file` of at most
256 KiB with their 0.4 errors and no staged writes.

`get_context.endpoints` is the directory of connections permitted by the current
grant, with `id`, `label`, provider and workspace. `peer_requests` links each
request's stable `target` and `target_label` to its actual `session_id` once the
provider reports it. An agent can find a human label, inspect the corresponding
ID, then pass that ID to `ask`, `review` or `delegate`. Labels are untrusted display
data, not instructions or routing aliases. This directory does not index chats
outside CodaClauda or expose requests from another grant.

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
