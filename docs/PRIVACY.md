# CodaClauda privacy and local data

CodaClauda is a DeloresAI desktop utility for owner-authorized coordination between
Claude Code and Codex. This document describes the 0.4.0 candidate source,
including the preserved scoped-request and mailbox tools. Source review does not
establish native acceptance, publication or Marketplace admission; those require
separate release evidence.

## Data used for a request

Passive mailboxes store plain address names and labels, message subjects and
bodies, reply links, read receipts and advisory resource claims on the selected
local board. Delivery does not launch or wake a provider session or send content
to a provider service. Sender names are self-asserted, not authenticated chat
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
There is no automatic mailbox wake or scheduled model work in this release.

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
These settings do not control terminal or desktop sessions started elsewhere,
and a spending prohibition is an owner instruction, not a payment-system block.
Browser control is not available in 0.4.0. This release does not launch a browser
MCP server or acquire its executable packages. No Windows MCP is included.

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
retrying. CodaClauda does not import or copy gh credentials. Git/gh may use the
owner's configured GitHub transport and have their own networking behavior.

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

The first existing-conversation write backs up the prior schema-1 board and
atomically moves to schema 2. Older CodaClauda binaries refuse that schema.
The backup also contains private coordination history and is retained locally;
it must not be committed or attached as public release evidence.

CodaClauda has no public coordination listener, cloud inbox or independent
always-on service. It starts user-level workers for authorized requests and
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
libraries do not download model weights. The updater in Classic tools contacts
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
