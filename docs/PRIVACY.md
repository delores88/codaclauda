# ClaudaCoda privacy and local data

ClaudaCoda is a DeloresAI desktop utility for owner-authorized coordination between
Claude Code and Codex. This document describes the version-1 implementation. It
does not claim that a development candidate has completed installed acceptance,
been published or obtained Marketplace admission.

## Data used for a request

The owner selects a project, allowed relative file paths, endpoints, request types
and limits. ClaudaCoda records the request prompt, scope, expected result and
coordination history. Its scoped MCP tools can read authorized UTF-8 project
text; delegated requests can write authorized files in their isolated worktree.
Questions and reviews are read-only. Incoming agent content cannot expand the
recorded owner grant.

The installed provider CLI sends request prompts, authorized project text,
handoff context and tool results needed for the workflow to its provider service.
Consequently, the two-agent workflow requires network access and is not an
offline or wholly on-device model workflow. Claude Code and Codex are separately
installed products with their own accounts, subscriptions, policies and retention.
ClaudaCoda bundles no model and does not require direct API credits as a fallback.

Optional DGXBridge can transfer authorized project/build data to the
owner's configured compute target. It manages its own execution, networking,
logs, caches and retention. Its supported installed integration and shared-job
acceptance must be verified separately; configuring its executable is not proof
that a Spark job completed.

## Local storage and retention

By default, ClaudaCoda uses the Windows LocalAppData KnownFolder, without package
redirection, under `DeloresAI/CodaClauda`. The CLI `status` command reports the
resolved path. An owner can explicitly choose a different board with
`--state-dir`; its filesystem location and permissions then matter as well.

Local data includes connected executable/workspace paths, immutable grants,
request prompts, provider session IDs, messages, answers, state transitions,
MCP-call metadata, usage observations, diffs, test/job receipts, private request
configuration and isolated Git worktrees. ClaudaCoda retains this data until the
owner removes it. Grant expiry stops authorized work; it does not delete history.
There is no automatic retention period or purge.

Before deleting local data, stop active requests and close ClaudaCoda, then
preserve any unmerged worktrees or receipts you need. Remove the selected board
directory using your normal filesystem tools when you intend to erase that
board. Removing ClaudaCoda's data does not remove the independent histories or
data retained by Claude Code, Codex, their services or DGXBridge. This
version does not promise that uninstalling the app deletes the board.

Do not publish local state, private receipts or provider transcripts as release
evidence. Public screenshots and evidence need a separate review for personal
information, private project content, tokens and pairing secrets.

## Credentials and local transport

Provider CLIs keep their own subscription authentication. ClaudaCoda probes their
supported login status rather than reading or exporting provider tokens, and it
does not copy authentication between products. API-key/provider environment
fallbacks are removed from launched provider environments. Sign-in and account
changes remain in each provider's official interface.

Each ClaudaCoda-owned request gets a private capability for its stdio MCP server.
That capability authorizes only the active request and inherited owner grant;
it is not a provider credential. Known credential patterns and request
capabilities are redacted from returned text. Redaction is a secondary safeguard,
not a guarantee that arbitrary text contains no secret. Scoped file tools also
reject recognizable secret/internal paths and out-of-project references.

ClaudaCoda has no public coordination listener, cloud inbox or independent
always-on service. It starts user-level workers for authorized requests and
scopes provider cancellation to its owned Windows process job. It does not need
administrator elevation. Normal operating-system access permissions still
apply to the selected state directory and the owner's other local processes.

## Telemetry, dependencies and updates

ClaudaCoda adds no independent analytics or telemetry. External provider CLIs,
their services, Git, Microsoft Edge WebView2 and optional DGXBridge retain
their own settings and policies. Provider account and usage statements should be
checked with those services; a locally reported cost estimate is not an invoice.

The Windows GUI requires Microsoft Edge WebView2 to be installed separately.
ClaudaCoda does not contain a runtime executable downloader or self-updater.
Approved ClaudaCoda package updates use the normal Marketplace installation
workflow; other installed tools manage their own updates independently. Before
replacing or rolling back a release, stop active requests and back up local state
and unmerged work. Cross-release data compatibility is not assumed.

First-party source is available under the [MIT license](../LICENSE). Third-party
components and external services retain their own licenses and terms. Review
[the CLI contract](CLI.md), [provider adapter boundaries](ADAPTERS.md) and
[Spark integration](SPARK.md) for current operational limitations.
