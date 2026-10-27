# CodaClauda privacy and local data

CodaClauda is a DeloresAI desktop utility for owner-authorized coordination between
Claude Code and Codex. This document describes the 0.7.2 candidate source,
including the preserved scoped-request and mailbox tools. Source review does not
establish native acceptance, publication or Marketplace admission; those require
separate release evidence.

## Data used for a request

Passive mailboxes store plain address names and labels, message subjects and
bodies, reply links, read receipts and advisory resource claims on the selected
local board. Passive delivery does not itself launch a provider. The optional
owned-session wake watcher described below can consume a posted message and
send its content to the selected provider while the app is open. Sender names are self-asserted, not authenticated chat
identities. A message is information, not authority; only Ben authorizes actions.

Existing-conversation messaging records owner-registered provider/chat IDs,
human labels, an exact conversation pair, expiry/count/hop limits and the text
and delivery receipts exchanged by that pair. It does not copy whole provider
transcripts. Its messages are untrusted peer content, not new human authority.
Connecting an existing agent does not restrict that agent's native tools.
Owner registration is not proof of the invoking chat's identity when an MCP
configuration is shared across chats; the interface identifies that boundary.

The owner selects a project, allowed relative file paths, endpoints, request types
and limits. CodaClauda records the request prompt, scope, expected result and
coordination history. Its scoped MCP tools can read authorized UTF-8 project
text; delegated requests can write authorized files in their isolated worktree.
Questions and reviews are read-only. Incoming agent content cannot expand the
recorded owner grant.

The installed provider CLI sends request prompts, authorized project text,
handoff context and tool results needed for the workflow to its provider service.
Consequently, the two-agent workflow requires network access and is not an
offline or wholly on-device model workflow. Claude Code and Codex are separately
installed products with their own accounts, subscriptions, policies and retention.
CodaClauda bundles no model and does not require direct API credits as a fallback.

The Chat view distinguishes CodaClauda-owned sessions from passive desktop chats.
Owned sessions start the separately installed Claude Code or Codex CLI in the
chosen project. Prompts, included attachment text or paths, tool results and
provider conversation context can reach that provider. A later owner send
continues the saved provider conversation, including after idle shutdown or
restarting the app. The app does not attach to unrelated desktop conversations.
**Wake on mail** is on by default for every owned session created in 0.5 or
later (from Chat, a fork, a schedule, a hand-off or a team start); each gets its
own board address. Sessions from before 0.5 keep their setting. While the app is
open, its watcher can send message subjects, bodies and sender labels to that
provider, consuming provider usage, then acknowledge messages retained for
delivery. The per-session switch and the global switch in Settings control future
admission; sender labels never grant authority. There is no cap on how many
sessions wake or how often apart from owner concurrency settings and the loop guard (Settings →
Limits). A new guard defaults to Notify at 60 per pair per hour; it sends one
notice per pair and hour without pausing. Every saved pre-0.6 guard retains its
on/off choice, count and Pause behavior. Pause mode stops further wakes until
older counts age out; the owner can also pause a pair explicitly. When ntfy is
configured, its notice names the two addresses, never the message text. Wake
checks and the loop guard do not establish a sender's identity.

**Teammate starts** inherit Settings → Team for linked projects without a saved
override. The new owner default is On with Unlimited concurrency; existing
project Off, Read and finite guards are retained. The owner can change the
global default or set a project's override. Agents ask by posting to the address
`codaclauda-team`; the app reads that inbox while it is open. When the project's
switch is on and its guard allows, the app starts a new owned session at the
project's current access level (never higher) with wake on. The requested title
and prompt, written by an agent whose sender name is self-asserted, are sent to
the provider as that session's framed, untrusted first turn and can consume
usage. The app replies to the sender on the board with the new session's ID,
address, provider and project, or with a named refusal. A new wake-on session's
first turn is also preceded by a short framed note giving its board address, the
CLI and board paths, and how to wake teammates and post claims.

The project guard applies again when an agent-started session wakes or starts
another turn. Disabling teammates prevents further turns from those sessions;
an already running turn still needs Stop. Lowering project access prevents a
Full teammate from starting another turn at its previous level.

The 0.6 host lease records the bound board and installation, recent heartbeat
time and consumer status. A CLI post reports a saved receipt separately from
available, unavailable or unknown host state. A closed app cannot consume team
requests. A queued request can be cancelled and must not run after a terminal
refusal or cancellation. These receipts do not authenticate the sender.

**Continue as a copy** reads local conversation metadata to identify a source
and asks the installed provider to fork it on first launch. The separate copy
can send inherited conversation context to the same provider; the original is
not continued in place. Optional Codex desktop notification bindings store an
exact thread ID, board address, linked folder, cursor and delivery receipts.
Each notice contains message counts and sender names, not message bodies.
The provider may execute work after accepting a notice. Command acceptance
alone does not prove execution or that the recipient read the mailbox.

**Settings → Usage** applies to all CodaClauda-owned sessions, not other clients
or provider account settings. Credits and supported earned resets default on
for new settings; saved Off values are retained and unreadable policy fails
closed. Codex limit reads may report allowance, windows, credit balance, spend
control and earned reset availability. Reset redemption uses a durable attempt
key and a hashed account identifier to reconcile uncertain outcomes without
consuming another reset. A natural window reset does not redeem a credit.
Unknown provider fields remain unknown. Off is admission control, not a hard
billing cap: a turn crossing a limit or starting with unreported state may
still use credits. Claude extra usage depends on the provider's account
settings; no account switching, API profile or credential copying is performed.
Only definitively unstarted held work may retry automatically once. Partial
or unknown execution retains its original receipt for owner review.

Schedules store a prompt, project, provider, timing and optional catch-up setting.
Enabled schedules can consume provider plan usage without another click while
the app is open. They are not an operating-system task or a promise of execution
while the app is closed. Disable a schedule to prevent future runs; use Stop to
interrupt work already admitted. Interrupted or uncertain work is not silently
replayed after restart.

Owned Claude sessions support personal Pro or Max authentication only; Team,
Enterprise and unknown subscription types are unsupported. The app checks for
managed system files/directories, registry settings and the remote policy cache
in the configuration directory reported by Claude's supported login status.
It checks presence without reading policy contents and refuses launch when a
source is present or its absence cannot be verified. It does not change or
bypass managed policy.

A Both conversation contains one session per provider. A leading `@claude` or
`@codex` sends to that provider; `@both` or no mention sends to both. Bounded recent
peer replies and owner messages can be included in subsequent prompts, so
content from one provider can be sent to the other. Two targeted providers can
consume usage on both accounts. Peer text is untrusted context, not new owner
authorization.

Access is fixed when an owned session starts. Full enables provider-native
filesystem and command tools without permission prompts under the user's
account. Read only uses restricted provider tools and filesystem policy.
Scheduled runs also revalidate the current project access before dispatch.
These settings do not control terminal or desktop sessions started elsewhere,
and a spending prohibition is an owner instruction, not a payment-system block.
Owner-configured MCP servers are available only to Full sessions; Read sessions
refuse them. The app stores the selected command, arguments and environment
names and values in plaintext per project in `mcp-servers.json`. Per-session
Claude configuration refers to those variables by name, and their values travel
in the provider process environment. Do not enter credentials in these saved
settings; CodaClauda does not provide an encrypted secret store for them.
Browser and Windows-MCP tools are not bundled or installed by CodaClauda. Presets
show owner-run installation instructions and require confirmation of an existing
executable. Third-party tools run under the owner's account and may access the
filesystem, desktop or network according to their own implementation.

Optional phone notifications send the agent's session name and up to the first
300 characters of its final reply to the configured ntfy endpoint/topic.
The complete reply and name pass the mailbox credential scanner before clipping.
Successful turns started by another agent's board mail stay quiet; explicit
posts to `owner-phone` are still forwarded. Error notices contain a fixed
explanation, and wake loop warnings can include the two mailbox addresses.
A topic identifies the destination and may be visible to other subscribers
depending on the server's access rules. The service receives message content
and normal network information and follows its own data policy.

**Message your agents from your phone** is an owner setting, on by default.
Nothing is sent or polled without the owner's saved notification topic URL in
Settings > Phone. While enabled and the desktop app is open, it polls that same
topic for phone messages and sends replies there. Keep the topic name long and
random. Anyone who knows the topic can read or send its messages; the topic
does not authenticate Ben. Received text
becomes a local board notice from `owner-phone`, displayed as **Ben (phone)**
and handled as Ben's ordinary message on the owner-selected phone channel.
Existing wake settings may send that notice to the selected provider at its
current project access. Saved permissions and technical session bindings do
not change merely because a message arrives.

Board messages addressed to `owner-phone` send the sender address and the first
1,000 characters of the body to that same topic. Phone replies go to the agent
that most recently messaged the phone, unless the text begins with an explicit
`@address` or session name. If no agent has messaged the phone, the app asks for
a recipient and lists a few active session names. All app publications carry
an app tag and returned message identifiers are saved so its own notifications
are not processed as phone messages. These tags are not proof of identity.
Inbound text and complete outbound text are checked by the mailbox credential
scanner before forwarding, including text beyond that limit. Refusals use fixed
messages without echoing the input. This pattern scanner cannot identify every
secret. Do not put credentials in phone or board messages. The bridge does not
log message bodies; accepted messages still follow ordinary board and provider
history storage. ntfy receives message content and ordinary network information
and applies its own retention and service limits. See [Phone setup](PHONE.md).

The optional phone-approval feature also sends approval-request text and a
one-time answer code to that topic. Codes are held in native process memory,
expire after 24 hours and are not saved to the board or UI state. Five wrong
codes lock phone approvals until the owner unlocks them on the PC. A valid answer
is recorded on the board and may be delivered to the requester's managed chat
or an existing Codex desktop binding under the saved controls. Anyone who can
read the topic can use a code; this is not independent authentication of the
person answering. The board CLI and agent tools cannot post as `owner-phone`.

Earlier Live chat records remain readable. That separate workflow started a
fresh dedicated read-only request for each send, with up to 12 recent messages
truncated to 4,000 characters each and bounded attachments. Polling legacy
request receipts does not resume a provider.

Files attached in Chat are copied locally before sending. Small text attachments
may be included in the mailbox body or dedicated provider prompt; other files
are referenced by saved path. Overlong mailbox text can also be saved as a file
with a preview and local path in the message. A recipient agent may read those
files under its own permissions and provider policies. The mailbox credential
scan does not scan attachment bytes or desktop UI state: never attach secrets.

Markdown, code and math rendering use bundled libraries rather than a CDN.
Remote image previews are suppressed; following an HTTP(S) link opens the system
browser and contacts the chosen site under that browser's settings. Rendering
and sanitization do not change the rule that message content is untrusted.

Optional DGXBridge can transfer authorized project/build data to the
owner's configured compute target. It manages its own execution, networking,
logs, caches and retention. Its supported installed integration and shared-job
acceptance must be verified separately; configuring its executable is not proof
that a Spark job completed.

## Local storage and retention

By default, CodaClauda requests the Windows LocalAppData KnownFolder with package
redirection disabled, under `DeloresAI/CodaClauda`. Windows launch context can
still redirect filesystem access. The CLI `status` command reports the actual
resolved path. An owner can explicitly choose a different board with
`--state-dir`; its filesystem location and permissions then matter as well.

Local data includes connected executable/workspace paths, immutable grants,
request prompts, provider session IDs, messages, answers, state transitions,
MCP-call metadata, usage observations, diffs, test/job receipts, private request
configuration and isolated Git worktrees. CodaClauda retains this data until the
owner removes it. Grant expiry stops authorized work; it does not delete history.
There is no automatic retention period or purge for this legacy request history.
Since 0.5, older request events move to `requests/<id>.events.jsonl` and answers
or diffs over 256 KiB to `requests/<id>/` beside the board, with the same
retention. Running answer ingestion also retains private raw output for recovery;
it can contain sensitive provider text and is not a public or agent-readable
payload. Only the separately checked/redacted answer is returned. Staged file
writes live under `staging/` until they commit, abort or
the request ends. A provider record over 64 MiB is saved raw (not redacted) as
`oversized-<n>.jsonl` in that run's private directory.
The separate passive mailbox retains messages and read receipts for 30 days,
pruning expired messages during subsequent mailbox operations. Address entries
remain registered; claims expire after their chosen 1–120 minute lifetime.
The mailbox uses its own file and lock and does not migrate legacy request data.
Its body limit is 32 KiB of UTF-8. Recognized credential patterns are refused
before storage, but the scan cannot recognize every secret: never post credentials.

The desktop writes `<board>/desktop-ui/ui-state.json`, including UI chat
copies, linked project metadata, agent display preferences, task overrides,
avatar parameters, avatar-request references, City layout and preferences. It also
stores thread filing and pins, permission scopes and agent addresses, stated
limits, paste markers and notice references. Creating or revoking permission
records requires a successful native save; other UI state can fall back to
WebView localStorage if native UI-state access fails. State is
limited to 8 MiB; the optional `desktop-ui/projects.manifest.json` is limited to
2 MiB. The manifest can provide linked folders and a GitHub user for subsequent
metadata discovery/refresh. Attachment copies, up to 25 MiB each, are stored
under `desktop-ui/attachments/<date>/` with unique sanitized filenames.

Owned sessions additionally write `desktop-ui/sessions.json` and
`desktop-ui/sessions/<id>.jsonl`. These hold project paths, access settings,
provider conversation IDs, owner prompts, completed replies, tool summaries and
status/error events. Streamed text chunks are not individually persisted. When
a display log grows beyond 5 MiB, older complete entries are trimmed to retain
roughly the latest half; the local display log is therefore not a complete
audit transcript. The provider's independent conversation history may retain
more. Registry entries have no automatic expiry. Closing a session stops its
app-owned process and preserves its record and local history. Idle process
shutdown after ten minutes also preserves them. Interrupted turns are not
automatically replayed on restart.

The owned-session registry also retains accepted queue entries and their
outcomes. Wake and schedule configuration, deduplication records and run receipts
are stored under the same private desktop state. `desktop-ui/wake.json` holds the
wake switch, loop-guard setting and recent wake counts per session pair;
`desktop-ui/team.json` holds each project's teammate switch, guard, path and ids,
and the saved outcome and exact reply of every handled team request for 31 days;
`desktop-ui/session-limits.json` holds Agents at once. The board's `policy.json`
holds the owner's grant defaults and Board requests at once. These can contain
message IDs, mailbox addresses, prompts and project paths. They are separate from the passive
mailbox's 30-day pruning and must be included in any private board backup.

The desktop also retains `desktop-bindings.json` notification bindings/cursors
and bounded output receipts, `usage.json` owner policy, and held-turn state in
the session ledger. `usage-resets.json` and its lock in the app data folder
serialize redemption attempts across CodaClauda processes. These records can
contain account hashes, attempt IDs, provider outcomes and timing; they are
private local state, not public release evidence. The transient
`desktop-ui/host-heartbeat.json` is removed on a clean exit. Mailbox retention
does not purge these separate records.

Owned-session prompts, replies and tool summaries are not generally redacted
or screened by the mailbox credential scan before sending, display or local
storage. They can therefore contain secrets that an owner or provider included.
Keep these logs private and do not include secrets in a session.

Desktop state, WebView localStorage and attachment copies have no automatic
expiry, including permission records. Reported-use messages follow mailbox
retention and do not form a complete audit history. The mailbox's 30-day pruning
does not purge those copies or the legacy request history. Deleting a Live chat
from the UI removes that UI thread, not
its underlying requests or saved attachments. A board backup can therefore
include private text and files that no longer appear in a mailbox inbox.
The 30-day mailbox retention does not apply to owned session history or provider
history.

Before deleting local data, stop active requests and close CodaClauda, then
preserve any unmerged worktrees or receipts you need. Remove the selected board
directory using your normal filesystem tools when you intend to erase that
board. WebView's separately stored UI-state fallback must also be removed when
erasing all desktop history. Removing CodaClauda's data does not remove the
independent histories or data retained by Claude Code, Codex, GitHub, speech
services or DGXBridge. This
version does not promise that uninstalling the app deletes the board.

Do not publish local state, private receipts or provider transcripts as release
evidence. Public screenshots and evidence need a separate review for personal
information, private project content, tokens and pairing secrets.

## Projects, GitHub, avatars and dictation

Project discovery and scans run locally. Scans count filesystem metadata within
file and time budgets. The fallback directory walk also has a depth limit and
skips common generated directories and entries reported as symlinks; Git-tracked
scans can count tracked generated files. Cloud-placeholder metadata is allowed.
The file walk does not read source contents. Optional Git commands return
tracked paths, branch/status/history and remote metadata.
Displayed line counts are estimates derived from file sizes. Linked paths and
scan results can be saved in desktop state; linking a folder does not itself
grant a provider permission to edit it.

GitHub lookup/refresh uses the installed `gh` CLI and its existing sign-in. When
a public username is supplied and gh lookup fails, an anonymous request to
`https://api.github.com` can list that user's public repositories. Signed-in gh
may return private repository metadata accessible to the account. Explicit
repository creation sends the chosen name, description and visibility to GitHub
and clones the repository locally; cloning downloads files into a new child
folder beneath the selected parent. These are real remote/local changes, not
only UI entries. An ambiguous timeout or partial creation must be checked before
retrying. Selecting an existing signed-in account may ask `gh` for that account's
token in native process memory and supply it to the corresponding `gh` child
process. It is not sent to the UI or saved in CodaClauda state or logs. Account
names, repository metadata, linked paths and City layout preferences can be
saved locally. Cloning with a selected account uses an isolated child Git
configuration and that account's GitHub authorization. Other Git/gh operations
may use the owner's configured transport and have their own networking behavior.
Removing an account or building from the City
does not delete its local files or remote repositories.

Avatar editing and local photo matching run on the device. Photo matching uses
image analysis to suggest editable colors/features, not a bundled generative
model or identity verification. The local suggestion does not upload the photo.
Choosing to ask an agent for help saves a copy and posts its path and current
avatar parameters to that address's mailbox; a reading agent follows its own
provider policies. Applying a returned avatar remains an owner action.

Dictation invokes Windows voice typing, with browser SpeechRecognition fallback
where supported. Availability, microphone permissions, audio processing,
network access and retention follow that operating-system/browser speech service.
This is not a bundled offline speech model, and offline transcription is not
guaranteed. Recognized text enters the composer and follows the selected chat
mode's storage and delivery rules when sent.

Local mailbox delivery, saved project views and avatar editing can work without
a network. Provider work, GitHub operations, update acquisition and some speech
services require network access. There is no guarantee that all app features or
their external dependencies operate offline.

## City weather

Weather is off by default. **Pick my own** renders a local weather scene without
contacting a weather service. **Live** sends the selected approximate location
(city coordinates rounded to two decimal places, about 1 km or coarser) to MET Norway's
Locationforecast service at `api.met.no`. It refreshes periodically while the
City view is open in a visible window. Cache expiry, failure backoff and reopening the
City affect the timing; requests are not made on a fixed interval. Both
switching away from the City and hiding the app stop scheduled
refreshes. A request already in progress can still finish. Contributor islands
hide the weather display; Live checks for the selected city can continue while
visiting an island within the visible City view.

Searching for a place is explicit: the typed search text goes to OpenStreetMap
Nominatim at `nominatim.openstreetmap.org`, along with the requested language.
There is no search-as-you-type request.
Both services receive the IP address and ordinary HTTPS request information.
The app identifies itself in these requests. It does not send board messages,
provider credentials or project files to either service. The initial suggested
city comes from the device's time zone, not GPS or an IP-location lookup.

The chosen city, coordinates, weather mode and display preferences are saved in
local desktop UI state and follow its retention rules above. Weather response
and place-search caches stay in memory. External services have their own data
policies. Weather data is credited to MET Norway (CC BY 4.0); search data is
credited to OpenStreetMap contributors (ODbL). Attribution is also shown in the
City and Weather settings. Live weather and place search need network access.

## Credentials and local transport

Provider CLIs keep their own subscription authentication. CodaClauda probes their
supported login status rather than reading or exporting provider tokens, and it
does not copy authentication between products. API-key/provider environment
fallbacks are removed from launched provider environments. Sign-in and account
changes remain in each provider's official interface.

Each legacy scoped request gets a private capability for its stdio MCP server.
That capability authorizes only the active request and inherited owner grant;
it is not a provider credential. Known credential patterns and request
capabilities are redacted from returned text. Redaction is a secondary safeguard,
not a guarantee that arbitrary text contains no secret. Scoped file tools also
reject recognizable secret/internal paths and out-of-project references.
Those scoped-request safeguards do not describe the owned-session display logs.

Registered conversations use separate expiring, revocable MCP capabilities.
The board stores their hashes; private setup configuration contains the secret
and must remain local. The setup dialog offers it once and clears it when closed.
An explicit rotation invalidates the old capability. Capabilities are neither
provider account tokens nor permission to create unrelated conversations.
Opted-in Claude channels can deliver notifications to their connected session;
Codex routing requires the exact chat loaded on a reachable supported server.
Inbox-only mode waits for the recipient to check messages and cannot wake it.
Transport acceptance, recipient acknowledgment and a reply are distinct states.

The first compatible 0.5 board migration saves an exact backup and atomically
moves the board to schema 3. Migration waits while legacy workers may still need
to write their receipts. Existing grants keep their original resolved limits;
unfinished legacy claims are reconciled without relaunching them. Older binaries
refuse the new schema, so rollback cannot assume the current board is readable.
The backup also contains private coordination history and is retained locally;
it must not be committed or attached as public release evidence.

CodaClauda has no public coordination listener or independent always-on service.
Optional phone messaging uses the external ntfy topic as an inbox while the app
is open. It starts user-level workers for authorized requests and
scopes provider cancellation to its owned Windows process job. It does not need
administrator elevation. Normal operating-system access permissions still
apply to the selected state directory and the owner's other local processes.

## Telemetry, dependencies and updates

CodaClauda adds no independent analytics or telemetry. External provider CLIs,
their services, Git/gh, GitHub, speech services, Microsoft Edge WebView2 and optional DGXBridge retain
their own settings and policies. Provider account and usage statements should be
checked with those services; a locally reported cost estimate is not an invoice.

The Windows GUI requires Microsoft Edge WebView2 to be installed separately;
its 3D City and avatar preview use WebGL graphics support. The bundled UI
libraries do not download model weights. The updater in Settings contacts
`deloresai.com` to discover accepted stable CodaClauda
releases. Checking sends the app identifier and the normal network information
needed for HTTPS; it sends no coordination prompts, project files or provider
credentials. Download authorization opens the system browser for the owner's
Marketplace sign-in and approval. CodaClauda does not read or copy browser cookies.

The updater keeps its short-lived proof and one-use download capability in memory.
It verifies the acquisition signature, nested review signature, artifact identity,
installer size and SHA-256. Installation requires a separate explicit action and
fresh revalidation. It retains local update status and the verified installer for
the update workflow; an interrupted or ambiguous operation is not retried silently.
Expired authorization requires approval again. The updater does not fall back to
unsigned metadata or a direct GitHub installer download.

The installer is designed to preserve the selected coordination board,
connections and history; each version's upgrade requires its own installed receipt.
Provider CLIs and optional DGXBridge manage their own updates independently. Before
replacement or rollback, stop active requests and preserve local state and
unmerged work. Backward compatibility with an older release is not assumed.

First-party source is available under the [MIT license](../LICENSE). Third-party
components and external services retain their own licenses and terms. Review
[the CLI contract](CLI.md), [provider adapter boundaries](ADAPTERS.md) and
[Spark integration](SPARK.md) for current operational limitations.
