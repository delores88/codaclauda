# ClaudaCoda privacy and local data

ClaudaCoda is a DeloresAI desktop utility for owner-authorized coordination between
Claude Code and Codex. This document describes the 0.2 release candidate. Its
new update flow requires separate installed acceptance before release; source
documentation alone does not establish publication or Marketplace admission.

## Data used for a request

Existing-conversation messaging records owner-registered provider/chat IDs,
human labels, an exact conversation pair, expiry/count/hop limits and the text
and delivery receipts exchanged by that pair. It does not copy whole provider
transcripts. Its messages are untrusted peer content, not new human authority.
Connecting an existing agent does not restrict that agent's native tools.
Owner registration is not proof of the invoking chat's identity when an MCP
configuration is shared across chats; the interface identifies that boundary.

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

By default, ClaudaCoda requests the Windows LocalAppData KnownFolder with package
redirection disabled, under `DeloresAI/CodaClauda`. Windows launch context can
still redirect filesystem access. The CLI `status` command reports the actual
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

Registered conversations use separate expiring, revocable MCP capabilities.
The board stores their hashes; private setup configuration contains the secret
and must remain local. The setup dialog offers it once and clears it when closed.
An explicit rotation invalidates the old capability. Capabilities are neither
provider account tokens nor permission to create unrelated conversations.
Opted-in Claude channels can deliver notifications to their connected session;
Codex routing requires the exact chat loaded on a reachable supported server.
Inbox-only mode waits for the recipient to check messages and cannot wake it.
Transport acceptance, recipient acknowledgment and a reply are distinct states.

The first existing-conversation write backs up the prior schema-1 board and
atomically moves to schema 2. Older ClaudaCoda binaries refuse that schema.
The backup also contains private coordination history and is retained locally;
it must not be committed or attached as public release evidence.

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
The 0.2 updater contacts `deloresai.com` to discover accepted stable ClaudaCoda
releases. Checking sends the app identifier and the normal network information
needed for HTTPS; it sends no coordination prompts, project files or provider
credentials. Download authorization opens the system browser for the owner's
Marketplace sign-in and approval. ClaudaCoda does not read or copy browser cookies.

The updater keeps its short-lived proof and one-use download capability in memory.
It verifies the acquisition signature, nested review signature, artifact identity,
installer size and SHA-256. Installation requires a separate explicit action and
fresh revalidation. It retains local update status and the verified installer for
the update workflow; an interrupted or ambiguous operation is not retried silently.
Expired authorization requires approval again. The updater does not fall back to
unsigned metadata or a direct GitHub installer download.

The installer preserves the selected coordination board, connections and history.
Provider CLIs and optional DGXBridge manage their own updates independently. Before
replacement or rollback, stop active requests and preserve local state and
unmerged work. Backward compatibility with an older release is not assumed.

First-party source is available under the [MIT license](../LICENSE). Third-party
components and external services retain their own licenses and terms. Review
[the CLI contract](CLI.md), [provider adapter boundaries](ADAPTERS.md) and
[Spark integration](SPARK.md) for current operational limitations.
