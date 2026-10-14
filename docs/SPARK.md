# Optional DGXBridge integration

CodaClauda coordinates agents without a Spark. The optional adapter invokes the
owner-selected `sparkdev` native executable through its public JSON CLI. Configure
DGXBridge separately using its own supported setup. CodaClauda does not
read or copy its configuration, credentials, pairing records or job database.

The core authorizes each operation against an owner grant before calling the
adapter. It records the coordination request, project, immutable Spark request ID
and returned job ID. Only recorded owned jobs can be cancelled. Client labels
`codex` and `claude` identify accounting origin; they do not prove that either
agent actually called a tool. `human` is reserved for owner-origin operations.

## Contract version 1

The adapter always launches the executable directly, without a shell. Arguments
are fixed from the allowed operation and typed JSON fields. The core supplies the
workspace; incoming tool arguments cannot select a different directory or client.

| Operation | Accepted arguments | Executable operation |
| --- | --- | --- |
| `run` | required `argv` string array and `request_id`; optional `where`, `runtime`, `no_cache` | `run PROJECT --detach --where auto\|laptop\|spark --request-id ID --argv-json FILE` |
| `status` | empty object | `status --all` |
| `wait` | required `job`; optional integer `timeout` 0–60, default 10 | `wait JOB --timeout SECONDS` |
| `logs` | required `job`; optional integer `since` and `limit` 1–1048576 | `logs JOB --since OFFSET --limit BYTES` |
| `cancel` | required `job` | `cancel JOB` |

Every command starts with `--json --client IDENTITY`. Unknown fields and
operations are rejected. Identifiers contain at most 128 ASCII letters, numbers,
hyphens or underscores. Runtime names use the same characters, with a 64-character
maximum. Workload argv has 1–1024 strings, at most 65536 UTF-8 bytes, no NUL and a
nonempty executable. Empty later arguments, spaces, quotes and shell punctuation
are preserved in a generated JSON array rather than interpolated into shell text.

The temporary argv file is created exclusively in the owner's protected
CodaClauda scratch directory outside the submitted project. Windows files inherit
that directory's user protection; Unix files use mode 0600. CodaClauda removes only
the exact file it created on completion or error. It never recursively clears
scratch. Abrupt process termination can leave an owner-private argv file for
later owner inspection; do not place secrets in workload arguments.

## Bounds and outcomes

Run has a 120-second adapter deadline. Status, logs and cancel have 45-second
deadlines. Wait permits the requested delay plus 30 seconds of connection
overhead, capped at 75 seconds. Combined stdout and stderr are capped at 4 MiB.
No process launch prompts or terminal window are requested. Malformed responses
and provider diagnostics are withheld from error strings. Valid provider output
remains untrusted content and passes through the core's receipt redaction.

The adapter terminates only its owned CLI process handle after a timeout or capture
failure. It does not terminate a process tree or alter a Spark service. Spark Dev
Bridge owns detached worker and job lifetimes. In-flight transport children may
finish under their own upstream bounds after the CLI ends. A timeout can leave an
unknown submission outcome: retain the exact request ID, inspect the board and
retry only the same immutable request. Never replace its ID to force a retry.

Detached submission success is not workload success. Preserve `job`, `request_id`,
`state`, `exit_code`, placement, transport and cache fields. Use base64 `data` and
byte `next_offset` for lossless logs; `text` is presentation only. A
`cancel_pending` result is a pending cancellation. A `lease_lost` state or
`remote_available:false` is not successful completion. Unexpected states remain
visible rather than being converted to success.

Spark's current laptop runner obtains a shared lease from its authenticated Spark
scheduler, so laptop placement currently depends on that connection. The adapter
does not duplicate the runner or bypass the lease. Some nominally read-only
Spark commands also flush cancellations already queued by DGXBridge.

## Evidence and readiness

Initial read-only inspection observed NVIDIALink HEAD
`86c95438a114af4c8649e1121d79f3dc43826f04`; much of the CLI/core remained untracked
in its active development checkout. Its `evidence/cli-spark-acceptance.json`
recorded successful physical-Spark SSH, exact argv, idempotency, incremental logs
and cache checks, but had an overall failed result with a queued job. That receipt
excluded actual Claude Code invocation and native desktop/hotspot acceptance.
This historical inspection is not a current release or installation claim.

The adapter's parameter-validation tests establish local behavior only. Real
acceptance remains pending until a supported DGXBridge installation is
connected, an actual agent submits a bounded build/test, and the other actual
agent retrieves and attributes that job's logs and result. Synthetic subprocesses,
MCP clients and client labels cannot substitute for those receipts.

No Spark source was copied into this adapter. The public CLI contract was used as
a reference; licensing and provenance remain in the root project records.
