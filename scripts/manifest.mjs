#!/usr/bin/env node
/** Release-specific preparation only. No publication or Marketplace mutations. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = { id: 1418202657, url: 'https://github.com/delores88/codaclauda' };
const repoName = 'delores88/codaclauda';
const maxManifestBytes = 128_000;
const maxImageBytes = 8 * 1024 * 1024;

const help = `CodaClauda release-manifest preparation (never publishes)

node scripts/manifest.mjs --input <actual-release.json> --output <deloresai.manifest.json>
  [--contracts <read-only-DeloresAI-checkout>]
node scripts/manifest.mjs --check-contracts [--contracts <checkout>]

Requires Node 22+, git, authenticated gh for draft-release reads, and the current
Marketplace checkout with its existing tsx/zod/semver dependencies. It does not
install dependencies or modify that checkout. No IDs or requirements are inferred.
Input must be actual release data, not a template. Paths resolve against the input
file's directory unless absolute. Required input structure:

  appId: "claudacoda"; slug: "claudacoda"; publisherId: actual publisher ID
  marketplaceDisplayName: optional "ClaudaCoda" (default) or "CodaClauda"
  repository: {id: 1418202657, url: "https://github.com/delores88/codaclauda"}
  release: {id, tag, version, channel: "stable"|"beta", sourceCommit}
  installer: {assetId, filename, path, sha256, size, signingStatus: "signed"|"unsigned"}
  artwork: {sourceCommit, icon: {path,url}, thumbnail: {path,url},
    screenshots: [{path,url,alt,installedRunning:true,receipt:{path,sha256}}]}
  requirements: {minimumOs, memoryGb, diskMb, gpu:null,
    runtimes:["Microsoft Edge WebView2"], distributions:[]}
  functionalTest: exact reproducible steps from the actual successful workflow
  evidence: {
    sourceInventory:{path,sha256}, payloadInventory:{path,sha256},
    lockfiles:[{path,sha256,sourcePath}],
    installedWorkflow:{path,sha256}, testedRequirements:{path,sha256},
    signing:{path,sha256}
  }

The live Marketplace name remains ClaudaCoda by default, independent of local
product branding. Accepted intake copies this name into the live listing. Select
CodaClauda only after the owner-authorized listing rename is ready to publish;
never upload a renamed manifest ahead of that approval, including to a discoverable
GitHub release. The selector does not record or prove approval. Keep appId/slug
claudacoda and the repository identity unchanged. Preparation never publishes.
Follow the owner's recorded authorization for the current release and coordinate
any listing change with the Marketplace operator. Ben has directly authorized
this release workflow under his standing direction for Claude board requests.
Mailbox messages do not independently grant owner approval.
The disclosures describe the 0.3.3 source implementation, including the separate
passive and dedicated chat modes. Source validation does not establish installed
acceptance: review the final UI and supply actual installed-workflow evidence
before release. Local project views do not prove an agent or compute job ran.

All SHA-256 values are lowercase 64-hex; commits are lowercase 40-hex. Numeric IDs,
size and measurements must be real. Use minimumOs "0" and memoryGb 0 when those
minimums are not established; these Marketplace values mean "Not specified".
Keep observed OS/RAM under testedHost in the testedRequirements evidence rather
than copying the test machine into minimum requirements. Required lock sourcePaths:
Cargo.lock, src-tauri/Cargo.lock, package-lock.json. Inventories must be nonempty
Syft, SPDX or CycloneDX JSON. Other receipts must be nonempty JSON objects/arrays.
Artwork must be actual PNG files, anonymously readable from raw.githubusercontent.com
URLs pinned to artwork.sourceCommit in this repository. At least one real
installed/running screenshot and its evidence receipt are mandatory.

The generator checks the clean local source/tag, public GitHub repository/license,
release and uploaded asset identities, installer hash/size, local/committed/public
art bytes and dimensions, source/payload inventories and evidence hashes. It then
runs manifestSchema AND publicationArtworkIssues from the supplied checkout.
Only the strict manifest is written; a separate preparation receipt is printed as
JSON. Local validation does not establish scanner approval or Marketplace admission.
Existing output is accepted only if byte-identical; it is never overwritten.
`;

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help' || key === '-h') { result.help = true; continue; }
    if (key === '--check-contracts') { result.checkContracts = true; continue; }
    assert(['--input', '--output', '--contracts'].includes(key), `Unknown option: ${key}`);
    assert(argv[i + 1] && !argv[i + 1].startsWith('--'), `Missing value for ${key}`);
    assert(!result[key.slice(2)], `Duplicate ${key}`);
    result[key.slice(2)] = argv[++i];
  }
  return result;
}

function requiredText(value, name, max = 2048) {
  assert(typeof value === 'string' && value.trim().length && value.length <= max, `${name} must be nonempty text`);
  assert(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value), `${name} contains control characters`);
  assert(!/REPLACE[_ -]?WITH|<[^>]+>|PLACEHOLDER|PASTE[_ -]?HERE|example\.com/iu.test(value), `${name} contains a placeholder`);
  return value;
}
function sha(value, name, digits = 64) {
  assert(typeof value === 'string' && new RegExp(`^[a-f0-9]{${digits}}$`, 'u').test(value), `${name} must be lowercase ${digits}-hex`);
  assert(!/^([0-9a-f])\1+$/u.test(value), `${name} must not be a placeholder digest`);
  return value;
}
function positive(value, name) {
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer`);
  return value;
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function exec(program, args, maxBuffer = 16 * 1024 * 1024) {
  const result = spawnSync(program, args, { cwd: root, encoding: null, windowsHide: true, timeout: 30_000, maxBuffer, shell: false });
  // Do not echo provider stderr, which may contain account or authentication data.
  assert(!result.error && result.status === 0, `${program} read-only identity check failed; inspect it directly before retrying`);
  return result.stdout;
}
function git(args, maxBuffer) { return exec('git', ['-C', root, ...args], maxBuffer); }
function github(route) {
  return JSON.parse(exec('gh', ['api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', route]).toString('utf8'));
}
async function hashedFile(file, base, name, maximum = 2_000_000_000) {
  assert(file && typeof file === 'object', `${name} must be a file descriptor`);
  const filename = path.resolve(base, requiredText(file.path, `${name}.path`));
  const stat = await fs.stat(filename);
  assert(stat.isFile() && stat.size > 0 && stat.size <= maximum, `${name} is empty, too large or not a regular file`);
  const hasher = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hasher.update(chunk);
  const actual = hasher.digest('hex');
  assert.equal(actual, sha(file.sha256, `${name}.sha256`), `${name} SHA-256 mismatch`);
  return { path: filename, sha256: actual, size: stat.size };
}
async function jsonEvidence(file, base, name, inventory = false) {
  const verified = await hashedFile(file, base, name, 128 * 1024 * 1024);
  const data = JSON.parse(await fs.readFile(verified.path, 'utf8'));
  assert(data && typeof data === 'object' && Object.keys(data).length, `${name} must contain nonempty JSON evidence`);
  if (inventory) {
    const rows = data.artifacts ?? data.packages ?? data.components;
    assert(Array.isArray(rows) && rows.length > 0, `${name} needs nonempty dependency coverage`);
    assert(rows.some((row) => row && typeof row.name === 'string' && row.name.length), `${name} has no named dependency records`);
    verified.dependencies = rows.length;
  }
  return verified;
}

async function contracts(checkout) {
  const index = path.join(checkout, 'packages/contracts/src/index.ts');
  const artwork = path.join(checkout, 'packages/contracts/src/artwork.ts');
  const loader = path.join(checkout, 'node_modules/tsx/dist/esm/api/index.mjs');
  await Promise.all([fs.access(index), fs.access(artwork), fs.access(loader)]);
  process.env.TSX_DISABLE_CACHE = '1';
  const { tsImport } = await import(pathToFileURL(loader).href);
  const schemaModule = await tsImport(pathToFileURL(index).href, { parentURL: import.meta.url, tsconfig: false });
  const artworkModule = await tsImport(pathToFileURL(artwork).href, { parentURL: import.meta.url, tsconfig: false });
  const { valid: semverValid } = createRequire(path.join(checkout, 'package.json'))('semver');
  assert(typeof schemaModule.manifestSchema?.safeParse === 'function', 'Current Marketplace manifestSchema is unavailable');
  assert(typeof artworkModule.publicationArtworkIssues === 'function', 'Current Marketplace publicationArtworkIssues is unavailable');
  return { schema: schemaModule.manifestSchema, artworkIssues: artworkModule.publicationArtworkIssues, semverValid,
    source: { indexSha256: digest(await fs.readFile(index)), artworkSha256: digest(await fs.readFile(artwork)) } };
}

function pngInfo(bytes, label) {
  assert(bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${label} must be a PNG raster`);
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR', `${label} has no PNG IHDR`);
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  assert(width > 0 && height > 0 && width <= 4096 && height <= 4096, `${label} dimensions exceed Marketplace limits`);
  assert(width * height * 4 <= 64 * 1024 * 1024, `${label} exceeds decoded allocation limit`);
  return { width, height };
}
async function anonymousBytes(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Accept: 'image/png' } });
  assert(response.ok, 'Pinned artwork is not anonymously readable');
  assert(response.headers.get('content-type')?.toLowerCase().startsWith('image/png'), 'Pinned artwork did not return image/png');
  assert(response.body, 'Pinned artwork response has no body');
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    assert(length <= maxImageBytes, 'Remote artwork exceeds 8 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function verifyArt(input, base, commit, name, size) {
  const filename = path.resolve(base, requiredText(input?.path, `${name}.path`));
  const bytes = await fs.readFile(filename);
  assert(bytes.length > 0 && bytes.length <= maxImageBytes, `${name} must be at most 8 MiB`);
  const dimensions = pngInfo(bytes, name);
  if (size) assert(dimensions.width === size[0] && dimensions.height === size[1], `${name} must be ${size[0]}x${size[1]}`);
  const url = new URL(requiredText(input.url, `${name}.url`));
  assert(url.protocol === 'https:' && url.hostname === 'raw.githubusercontent.com' && !url.port && !url.username && !url.password && !url.search && !url.hash, `${name} needs an immutable anonymous raw GitHub URL`);
  const prefix = `/${repoName}/${commit}/`;
  assert(url.pathname.startsWith(prefix) && url.pathname.endsWith('.png'), `${name} URL must pin the artwork commit in this repository`);
  const sourcePath = decodeURIComponent(url.pathname.slice(prefix.length));
  assert(sourcePath && !sourcePath.split('/').some((part) => ['', '.', '..'].includes(part)) && !sourcePath.includes('\\'), `${name} has an unsafe source path`);
  assert.equal(digest(git(['show', `${commit}:${sourcePath}`], maxImageBytes + 1024)), digest(bytes), `${name} differs from committed artwork`);
  const remote = await anonymousBytes(url.href);
  assert.equal(digest(remote), digest(bytes), `${name} anonymous URL differs from local artwork`);
  return { url: url.href, path: filename, sourcePath, sha256: digest(bytes), bytes: bytes.length, ...dimensions };
}

// Branding is an explicit release input because accepted intake can rename the live listing.
// Preparing this object does not establish owner approval or authorize publication.
export function makeManifest(input) {
  const displayName = input.marketplaceDisplayName === undefined ? 'ClaudaCoda' : input.marketplaceDisplayName;
  assert(['ClaudaCoda', 'CodaClauda'].includes(displayName), 'marketplaceDisplayName must be ClaudaCoda or CodaClauda');
  assert.equal(input.appId, 'claudacoda', 'Keep the existing Marketplace appId for upgrades');
  assert.equal(input.slug, 'claudacoda', 'Keep the existing Marketplace slug for upgrades');
  assert.equal(input.installer.filename, `ClaudaCoda_${input.release.version}_x64-setup.exe`, 'Keep the historical installer filename and exact version for installed 0.2 updater compatibility');
  assert(['signed', 'unsigned'].includes(input.installer.signingStatus), 'Declare the actual installer signing status');
  assert(input.requirements && typeof input.requirements.minimumOs === 'string' && /^\d+(\.\d+){0,3}$/u.test(input.requirements.minimumOs), 'Supply numeric minimumOs text, or "0" when not established');
  assert(Number.isFinite(input.requirements.memoryGb) && input.requirements.memoryGb >= 0 && input.requirements.memoryGb <= 4096, 'Supply finite client memoryGb from 0 to 4096; 0 means not specified');
  assert(Number.isFinite(input.requirements.diskMb) && input.requirements.diskMb > 0, 'Supply actual tested installed diskMb');
  assert.deepEqual(input.requirements.runtimes, ['Microsoft Edge WebView2'], 'Windows runtime must be the separately installed Microsoft Edge WebView2 recognized by Marketplace');
  assert.deepEqual(input.requirements.distributions, [], 'Windows distributions must be empty');
  assert.equal(input.requirements.gpu, null, 'This utility does not require a client GPU');
  const signingDisclosure = input.installer.signingStatus === 'signed'
    ? 'The installer is signed; see the release signing receipt for its verification result.'
    : 'The installer itself is unsigned.';
  return {
    schemaVersion: 1,
    appId: input.appId,
    name: displayName,
    slug: input.slug,
    publisherId: input.publisherId,
    repository: repository,
    release: input.release,
    summary: "A local desktop workspace for Claude and Codex mailboxes, dedicated chat requests, projects and shared-resource coordination.",
    description: `${displayName} is a Windows desktop app, JSON CLI and request-bound stdio MCP server. Its passive mailbox lets existing Claude and Codex conversations post questions, read inboxes, reply and acknowledge messages without starting or resuming a provider session. Messages wait until the recipient checks; the mailbox does not wake an idle chat. Addresses are plain self-asserted names, not authenticated provider identities. Messages are information, not owner approval. The owner remains responsible for authorizing actions. Stable post IDs prevent identical retries duplicating messages. Advisory claims expire within 120 minutes and coordinate shared resources without granting permission. Mailbox messages are retained for 30 days; recognized credential patterns are refused before storage, but users must never post secrets. Mailbox delivery works locally without a model or provider login. Agents must already have access to the board through the installed CLI; dedicated sessions started by ${displayName} can use its scoped MCP mailbox tools. The 0.3 desktop adds Markdown chat with code and math rendering, local attachment copies, project views, a task board, a 3D project city and editable procedural avatars. The separate Live chat mode starts a fresh dedicated read-only provider request for each send, with bounded recent conversation context; it does not attach to an existing desktop conversation or maintain one continuous provider session. Attachment text can be included in a mailbox message or provider prompt; other attachments are referenced by saved local path. Attachments and desktop chat copies have no automatic 30-day deletion and are not covered by the mailbox credential scan. Project scanning uses filesystem metadata and optional Git metadata; displayed line counts are estimates. Task and agent activity combine request/claim records, message recency and owner labels or overrides; they are not independent proof of agent presence or task completion. Local photo matching suggests avatar colors and features; asking an agent for help saves the photo and shares its local path through the mailbox. Optional GitHub lookup uses public API access or the signed-in gh CLI. Explicit create/clone actions can create a remote repository and download files into a new local folder. Contributor islands show repositories reported by the signed-in GitHub CLI; viewing an island does not grant repository access. City weather is off by default. Manual weather is local; optional Live weather periodically sends approximate coordinates to MET Norway while the City view is visible, including visits to contributor islands where the weather display is hidden. An explicit place search sends typed text to OpenStreetMap Nominatim; both services see the IP address. Dictation uses Windows voice typing or a supported browser speech service, not a bundled offline speech model. Agent setup provides passive mailbox join prompts, dedicated provider connections, scoped Grant & send requests and optional DGXBridge configuration. City Talk identifies passive Mailbox delivery separately from fresh-session Live requests. Tasks provides request cancellation controls, and Settings contains Updates. Experimental registered-session setup remains available through the CLI. Separately authorized dedicated work remains available: the owner chooses project paths and limits, questions and reviews are read-only, and delegated edits return unmerged Git worktree diffs. Provider workflows require separately installed CLIs, eligible accounts and network access. Local mailboxes, saved project views and avatar editing work offline; provider work, GitHub operations, update acquisition and some speech services need network access. No models are bundled and no direct API credits are mandatory. Optional DGXBridge runs separately authorized compute jobs through its public CLI; the desktop displays its reported status without proving broader workload or GPU acceptance. The native updater checks accepted stable Marketplace releases, requires browser approval for acquisition, verifies signed Marketplace envelopes and exact installer hashes, and requires a separate explicit install action. ${signingDisclosure} ${displayName} has no public coordination listener, independent telemetry or elevation requirement. Microsoft Edge WebView2 must be installed separately for the GUI; 3D views need usable WebGL graphics support, not a separately specified discrete or model GPU. Minimum OS and RAM are not specified when their manifest fields use the Marketplace unknown values; this does not assert compatibility with every system. The tested-requirements receipt records the observed test host separately, not empirically determined minimum hardware or software requirements. The app footprint is rounded up in decimal MB and excludes provider CLIs, Git/gh, WebView2, user data and temporary installation space.`,
    category: "automation",
    sourceVisibility: "public",
    license: "MIT",
    distributionAuthorization: {
      freeUse: true,
      marketplaceDistribution: true
    },
    free: {
      price: 0,
      trial: false,
      paidUnlocks: false,
      mandatoryDeveloperCredits: false
    },
    intelligence: {
      capabilities: [
        "Exchange durable questions and replies between existing conversations through a passive local mailbox without launching another session.",
        "Coordinate shared resources with atomic advisory claims, expiry, explicit release and visible current holders.",
        "Read Markdown conversations with local attachments, acknowledgments and stable retry IDs; use bounded message views and paginated task and connection lists.",
        "Run separately owner-authorized Claude Code/Codex requests; each Live chat send starts a new read-only dedicated request.",
        "Organize project metadata and task records in lists and a 3D city, with editable avatars and explicitly requested GitHub actions."
      ],
      functionalTest: input.functionalTest
    },
    execution: "hybrid",
    offline: true,
    integrations: [
      {
        name: "Claude Code",
        required: false,
        purpose: "Optional dedicated Claude sessions use the separately installed native CLI and its existing subscription sign-in. Passive mailbox delivery itself does not require a provider login.",
        costDisclosure: `A separately obtained eligible Claude subscription is required for this adapter. ${displayName} does not provide the subscription or require direct API credits.`,
        url: "https://code.claude.com/docs/en/overview"
      },
      {
        name: "Codex",
        required: false,
        purpose: "Optional dedicated Codex sessions use the separately installed native CLI and its existing ChatGPT sign-in. Passive mailbox delivery itself does not require a provider login.",
        costDisclosure: `Separately obtained eligible ChatGPT/Codex access is required. ${displayName} does not provide the subscription or require direct API credits.`,
        url: "https://learn.chatgpt.com/docs/non-interactive-mode"
      },
      {
        name: "Git",
        required: false,
        purpose: "Used for optional project metadata, GitHub cloning and isolated delegated worktrees; not required to exchange passive mailbox messages.",
        costDisclosure: "Git is a separately installed free dependency; third-party licensing applies.",
        url: "https://git-scm.com/"
      },
      {
        name: "GitHub CLI and GitHub",
        required: false,
        purpose: "The separately installed, signed-in gh CLI lists accessible repositories and performs owner-selected repository creation/cloning. Named public-user lookup can fall back to api.github.com without gh.",
        costDisclosure: "GitHub accounts, hosting limits and terms are separate. The app adds no developer-credit requirement for this optional integration.",
        url: "https://cli.github.com/"
      },
      {
        name: "Microsoft Edge WebView2",
        required: true,
        purpose: "Hosts the Windows desktop interface. Must already be installed; this package does not download it. The 3D City and avatar preview use WebGL graphics support.",
        costDisclosure: `Separately installed Microsoft runtime; no ${displayName} developer credits or paid unlock is required.`,
        url: "https://developer.microsoft.com/microsoft-edge/webview2/"
      },
      {
        name: "Windows voice typing or browser speech recognition",
        required: false,
        purpose: "Optional dictation invokes Windows voice typing, with browser SpeechRecognition fallback where available. Microphone permissions, availability and network behavior belong to that service; offline transcription is not guaranteed.",
        costDisclosure: "No speech model or speech subscription is bundled. Operating-system/browser service terms apply.",
        url: "https://support.microsoft.com/windows"
      },
      {
        name: "DGXBridge",
        required: false,
        purpose: "Optional public-CLI integration for exact owner-authorized build/test jobs and shared result receipts. Earlier installed acceptance covered one shared Python unittest; this release does not claim GPU or broader workload acceptance.",
        costDisclosure: "Separate software, configuration and optional owner-provided Spark hardware are required for this optional workflow. Hardware, network and external service costs are separate.",
        url: "https://github.com/delores88/nvidialink"
      }
    ],
    privacy: {
      dataLeavesDevice: `Passive mailbox delivery stays on the selected board and does not launch a provider; existing agents reading it follow their own provider policies. Dedicated requests, including each Live chat send, pass prompts, bounded recent chat context, included attachment text, saved attachment paths and authorized project/tool content through installed provider CLIs. Local photo matching does not upload an image; an explicit avatar-help request saves the photo and shares its local path with the selected agent. Project metadata scans run locally. GitHub lookup/refresh uses api.github.com or gh; creation sends the chosen name, description and visibility to GitHub, and cloning downloads repository files through gh/Git. City weather is off by default. Live sends selected coordinates rounded to two decimal places (about 1 km or coarser) to api.met.no periodically while the City view is open in a visible window, including visits to contributor islands where weather is hidden; caching, expiry and failure backoff change the timing. An explicit place search sends typed text and the requested language to nominatim.openstreetmap.org. Both services see the IP address and an identifying User-Agent; no board content or provider credentials are sent. The initial suggested city comes from the device time zone, not GPS or an IP-location lookup. Manual weather needs no service request. External links open in the system browser. Optional dictation follows OS/browser speech-service permissions and policies and may send audio to that service; it is not guaranteed offline. Optional DGXBridge may transfer authorized project/build data to its compute target. Update discovery and approval contact deloresai.com with app/artifact identifiers, ordinary HTTPS network information and temporary authorization proof; no coordination content or provider credentials are sent to Marketplace. ${displayName} has no public coordination endpoint.`,
      retention: "Passive mailbox messages and read receipts expire after 30 days and are pruned during subsequent mailbox operations. Address registrations remain; advisory claims expire after their chosen 1-120 minute TTL. Legacy request prompts, answers, events, receipts, private configuration and worktrees remain until the owner removes them. Desktop UI state, Live chat copies, project metadata, avatar settings, attachment copies and WebView localStorage fallback have no automatic expiry. Deleting a UI chat does not remove its underlying requests or attachments. Registered-session data and backups may contain private history. Local update status and verified installers support the update workflow; temporary proof and one-use download capability stay in memory. Selected city, coordinates, weather mode and preferences remain in local desktop UI state. Weather-response and place-search caches stay in process memory. Provider CLIs, GitHub, MET Norway, OpenStreetMap Nominatim, speech services, WebView2 and DGXBridge have independent retention. Uninstalling does not promise deletion of the board.",
      telemetry: `${displayName} adds no independent telemetry or analytics. External provider CLIs, Git/gh, GitHub, MET Norway, OpenStreetMap Nominatim, speech services, WebView2 and optional DGXBridge follow their own settings and policies.`,
      policyUrl: `https://github.com/${repoName}/blob/${input.release.sourceCommit}/docs/PRIVACY.md`
    },
    permissions: {
      filesystem: [
        "The selected local board for passive addresses, messages, read receipts, advisory claims, private configuration and legacy request history.",
        "Owner-selected project paths for scoped UTF-8 reads and delegated edits; isolated Git worktrees for delegated tasks.",
        "Bounded local project discovery and filesystem/Git metadata scans; GitHub create/clone writes a new folder under the selected parent.",
        "The board's desktop-ui directory for UI state, project manifests and attachment copies up to 25 MiB each; WebView localStorage as a UI-state fallback.",
        "Read separately installed native provider and optional DGXBridge executables and their supported status outputs.",
        "A sibling per-installation settings directory stores the selected board pointer across updates.",
        `Private update staging and the existing per-user ${displayName} installation for verified, explicitly approved replacement.`
      ],
      credentials: [
        `Provider CLIs use their own saved authentication; ${displayName} does not read or copy provider tokens.`,
        "GitHub operations use gh's existing sign-in; the app does not import GitHub credentials. Public-user repository lookup can use an anonymous API request.",
        "Private local capabilities scope dedicated-session and registered-conversation MCP tools; no public listener.",
        "Marketplace browser approval grants temporary memory-only proof and download capability; no browser cookies are imported.",
        "Mailbox names are self-asserted. Never post or attach secrets: the pattern scan is incomplete and excludes attachment bytes and desktop UI state."
      ],
      domains: [
        "deloresai.com",
        "api.github.com",
        "github.com",
        "api.met.no",
        "nominatim.openstreetmap.org"
      ],
      elevation: false,
      backgroundServices: false
    },
    models: [],
    executableDownloads: [],
    updater: {
      mode: "coordinated",
      coordination: "Settings > Updates discovers accepted stable Windows x64 NSIS releases through deloresai.com. The owner approves acquisition in the system browser, then separately chooses Install. The updater verifies pinned acquisition and nested review signatures, exact app/publisher/repository/source/artifact/platform bindings, size and SHA-256, and revalidates before setup. Temporary S256 proof and one-use capability stay in memory. Expired, interrupted or ambiguous authorization requires explicit approval again. There is no cookie import, direct-GitHub fallback or silent install. The helper preserves the selected board and physical per-user installation and refuses active coordination work. Provider CLIs and DGXBridge update independently. No fixed additional executable downloads are bundled."
    },
    rollback: {
      dataCompatible: false,
      backupRequired: true,
      notes: "Passive mailboxes use a separate mailbox.json and do not migrate legacy state.json. Registered-conversation writes can back up schema 1 and upgrade the legacy board to schema 2, which older binaries refuse. Preserve the actual selected board including desktop-ui state and attachments, WebView UI-state fallback, per-installation binding and unmerged worktrees before replacement or rollback. Stop active requests and never replay an ambiguous request automatically. No older-version compatibility guarantee is made."
    },
    artwork: { iconUrl: input.artwork.icon.url, thumbnailUrl: input.artwork.thumbnail.url },
    screenshots: input.artwork.screenshots.map(({ url, alt }) => ({ url, alt })),
    artifacts: [{ os: 'windows', architectures: ['x64'], format: 'nsis', assetId: input.installer.assetId,
      filename: input.installer.filename, installationAdapter: 'windows-nsis', preferred: true, requirements: input.requirements }]
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(help); return; }
  const checkout = path.resolve(args.contracts ?? path.join(root, '..', 'DeloresAI'));
  const validator = await contracts(checkout);
  if (args.checkContracts) {
    assert(!args.input && !args.output, '--check-contracts cannot generate a manifest');
    assert.equal(validator.schema.safeParse({}).success, false, 'Runtime schema unexpectedly accepts an empty manifest');
    const issues = validator.artworkIssues({ screenshots: [] });
    assert(issues.length >= 3, 'Runtime artwork checker did not require icon, thumbnail and screenshot');
    console.log(JSON.stringify({ ok: true, operation: 'contracts-read-only-check', source: validator.source, manifestCreated: false }));
    return;
  }
  assert(args.input && args.output, 'Both --input and --output are required; use --help for the input contract');
  const inputPath = path.resolve(args.input); const base = path.dirname(inputPath);
  const inputBytes = await fs.readFile(inputPath);
  assert(inputBytes.length <= 2 * 1024 * 1024, 'Release input exceeds 2 MiB');
  const input = JSON.parse(inputBytes.toString('utf8'));
  assert.equal(input.appId, 'claudacoda'); assert.equal(input.slug, 'claudacoda');
  requiredText(input.publisherId, 'publisherId', 128);
  assert.deepEqual(input.repository, repository, 'Repository identity must be the independent CodaClauda repository');
  assert(input.release && input.installer && input.artwork && input.requirements && input.evidence, 'Release identity, installer, artwork, requirements and evidence are all required');
  positive(input.release.id, 'release.id'); positive(input.installer.assetId, 'installer.assetId'); positive(input.installer.size, 'installer.size');
  const sourceCommit = sha(input.release.sourceCommit, 'release.sourceCommit', 40);
  const artCommit = sha(input.artwork.sourceCommit, 'artwork.sourceCommit', 40);
  requiredText(input.release.tag, 'release.tag', 100); requiredText(input.release.version, 'release.version', 100);
  assert.equal(validator.semverValid(input.release.version), input.release.version, 'Release version must be canonical semver');
  requiredText(input.functionalTest, 'functionalTest', 2000);
  assert(['signed', 'unsigned'].includes(input.installer.signingStatus), 'Declare the actual installer signing status');
  assert(/\.exe$/iu.test(requiredText(input.installer.filename, 'installer.filename', 255)), 'Installer must be the NSIS .exe asset');
  const outputPath = path.resolve(args.output);
  assert.equal(path.basename(outputPath), 'deloresai.manifest.json', 'Use the exact Marketplace manifest asset filename');

  const manifest = makeManifest(input);
  const parsed = validator.schema.safeParse(manifest);
  assert(parsed.success, `Marketplace runtime schema rejected the candidate: ${JSON.stringify(parsed.error?.issues)}`);
  assert.deepEqual(validator.artworkIssues(parsed.data), [], 'Marketplace publication artwork checks failed');
  assert(Array.isArray(input.artwork.screenshots) && input.artwork.screenshots.length >= 1 && input.artwork.screenshots.length <= 10, 'One to ten real installed screenshots are required');

  assert.equal(git(['rev-parse', 'HEAD']).toString('utf8').trim(), sourceCommit, 'Build/release source must match the checked-out commit');
  assert.equal(git(['status', '--porcelain', '--untracked-files=normal']).toString('utf8').trim(), '', 'Commit the complete candidate source and keep release inputs in ignored/private storage before generation');
  assert.equal(git(['rev-parse', `${input.release.tag}^{commit}`]).toString('utf8').trim(), sourceCommit, 'Local immutable release tag must identify sourceCommit');
  const license = git(['show', `${sourceCommit}:LICENSE`]).toString('utf8');
  assert(license.includes('MIT License') && license.includes('Ben Van Dorn') && license.includes('DeloresAI'), 'Committed first-party license must be MIT with the owner attribution');
  assert(git(['show', `${sourceCommit}:Cargo.toml`]).toString('utf8').includes('license = "MIT"'), 'Cargo metadata must declare MIT');
  assert.equal(JSON.parse(git(['show', `${sourceCommit}:package.json`]).toString('utf8')).license, 'MIT', 'Package metadata must declare MIT');

  const repo = github(`repos/${repoName}`);
  assert(repo.id === repository.id && repo.private === false && repo.html_url.toLowerCase() === repository.url.toLowerCase(), 'GitHub repository is not the expected public source');
  assert.equal(repo.license?.spdx_id, 'MIT', 'GitHub must detect the public source as MIT');
  const release = github(`repos/${repoName}/releases/${input.release.id}`);
  assert.equal(release.id, input.release.id); assert.equal(release.tag_name, input.release.tag);
  const prerelease = input.release.version.includes('-');
  assert.equal(input.release.channel, prerelease ? 'beta' : 'stable', 'Channel must match semantic-version prerelease status');
  assert.equal(release.prerelease, prerelease, 'GitHub prerelease flag must match manifest channel');
  const ref = github(`repos/${repoName}/git/ref/tags/${encodeURIComponent(input.release.tag)}`);
  let tag = ref.object;
  for (let depth = 0; tag.type === 'tag' && depth < 5; depth += 1) tag = github(`repos/${repoName}/git/tags/${tag.sha}`).object;
  assert(tag.type === 'commit' && tag.sha === sourceCommit, 'Remote tag does not identify the exact source commit');
  const asset = release.assets?.find((row) => row.id === input.installer.assetId);
  assert(asset && asset.name === input.installer.filename && asset.size === input.installer.size && asset.state === 'uploaded', 'Uploaded release installer identity/name/size is inconsistent');
  assert.equal(asset.digest, `sha256:${sha(input.installer.sha256, 'installer.sha256')}`, 'GitHub asset SHA-256 must match the final installer bytes');
  assert(asset.browser_download_url?.startsWith(`${repository.url}/releases/download/`), 'Installer must have its canonical GitHub release URL');
  const installer = await hashedFile(input.installer, base, 'installer');
  assert.equal(installer.size, input.installer.size, 'Final installer size mismatch');

  const evidence = {};
  for (const name of ['sourceInventory', 'payloadInventory', 'installedWorkflow', 'testedRequirements', 'signing']) {
    evidence[name] = await jsonEvidence(input.evidence[name], base, `evidence.${name}`, name.endsWith('Inventory'));
  }
  assert(Array.isArray(input.evidence.lockfiles), 'Provide source lockfile evidence');
  const expectedLocks = ['Cargo.lock', 'src-tauri/Cargo.lock', 'package-lock.json'];
  assert.deepEqual(input.evidence.lockfiles.map((file) => file.sourcePath).sort(), expectedLocks.sort(), 'Provide exactly the committed workspace, desktop and npm lockfiles');
  evidence.lockfiles = [];
  for (const file of input.evidence.lockfiles) {
    const checked = await hashedFile(file, base, `lockfile ${file.sourcePath}`, 16 * 1024 * 1024);
    assert.equal(digest(git(['show', `${sourceCommit}:${file.sourcePath}`])), checked.sha256, 'Lockfile differs from pinned source');
    evidence.lockfiles.push({ ...checked, sourcePath: file.sourcePath });
  }
  const artwork = {
    icon: await verifyArt(input.artwork.icon, base, artCommit, 'icon', [1024, 1024]),
    thumbnail: await verifyArt(input.artwork.thumbnail, base, artCommit, 'thumbnail', [1600, 900]),
    screenshots: [],
  };
  for (let i = 0; i < input.artwork.screenshots.length; i += 1) {
    const screenshot = input.artwork.screenshots[i];
    assert.equal(screenshot.installedRunning, true, 'Concept artwork cannot stand in for an installed/running screenshot');
    requiredText(screenshot.alt, `screenshots[${i}].alt`, 240);
    artwork.screenshots.push({ ...await verifyArt(screenshot, base, artCommit, `screenshots[${i}]`),
      receipt: await jsonEvidence(screenshot.receipt, base, `screenshots[${i}].receipt`), alt: screenshot.alt });
  }
  const bytes = Buffer.from(`${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
  assert(bytes.length > 0 && bytes.length <= maxManifestBytes, 'Manifest exceeds the release-asset size limit');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  let unchanged = false;
  try { await fs.writeFile(outputPath, bytes, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert((await fs.readFile(outputPath)).equals(bytes), 'Output exists with different bytes; use a new preparation directory');
    unchanged = true;
  }
  console.log(JSON.stringify({ ok: true, operation: 'manifest-prepared', manifest: { path: outputPath, sha256: digest(bytes), size: bytes.length, unchanged },
    release: { id: release.id, url: release.html_url, draft: release.draft, sourceCommit }, installer: { ...installer, assetId: asset.id, signingStatus: input.installer.signingStatus },
    artwork, evidence, contracts: validator.source, sourceVisibility: 'public', license: 'MIT',
    marketplace: { displayName: parsed.data.name, listingRenameRequested: parsed.data.name === 'CodaClauda', submitted: false, accepted: false, featured: false },
    limitation: 'Preparation validates supplied evidence bytes and current structure, not the truth of screenshot/receipt claims or scanner/native acceptance. Keep this receipt private; publish only reviewed release artifacts.' }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: 'MANIFEST_PREPARATION_REJECTED', message: error.message }));
    process.exitCode = 1;
  });
}
