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

  appId: "codaclauda"; slug: "codaclauda"; publisherId: actual publisher ID
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

All SHA-256 values are lowercase 64-hex; commits are lowercase 40-hex. Numeric IDs,
size and tested requirements must be real. Required committed lock sourcePaths:
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

function makeManifest(input) {
  return {
    schemaVersion: 1, appId: input.appId, name: 'CodaClauda', slug: input.slug,
    publisherId: input.publisherId, repository, release: input.release,
    summary: 'Ask Claude Code and Codex to consult, review and delegate bounded work with owner-controlled scope and local receipts.',
    description: 'CodaClauda is a Windows desktop utility, JSON CLI and request-bound stdio MCP server for coordination between independently installed Claude Code and Codex CLIs. The owner selects the provider, project, allowed paths and limits. Questions and reviews are read-only; delegated edits use isolated Git worktrees and return an unmerged diff. Each request records actual provider session evidence, history and receipts. New dedicated sessions are supported; arbitrary existing desktop chats are not attached or automatically awakened. Provider subscriptions and internet connectivity are required for the two-agent workflow. No models are bundled and no direct API credits are mandatory. Optional Spark Dev Bridge handles separately authorized build/test commands through its public CLI; its supported installed integration and shared-job acceptance remain pending. CodaClauda has no independent listening service, telemetry, elevation requirement or built-in executable downloader/updater. Install Microsoft Edge WebView2 and the provider CLIs separately before use. Reported agent answers are distinct from independently recorded test results.',
    category: 'automation', sourceVisibility: 'public', license: 'MIT',
    distributionAuthorization: { freeUse: true, marketplaceDistribution: true },
    free: { price: 0, trial: false, paidUnlocks: false, mandatoryDeveloperCredits: false },
    intelligence: {
      capabilities: [
        'Coordinate dedicated Claude Code and Codex sessions through bounded owner grants and request-bound MCP tools.',
        'Exchange questions and reviews with actual session evidence, durable history and bounded polling.',
        'Delegate scoped edits to isolated Git worktrees and return a diff without automatically merging it.',
      ], functionalTest: input.functionalTest,
    },
    execution: 'hybrid', offline: false,
    integrations: [
      { name: 'Claude Code', required: true, purpose: 'Runs dedicated Claude sessions using the separately installed native CLI and its existing subscription sign-in.', costDisclosure: 'A separately obtained eligible Claude subscription is required for this adapter. CodaClauda does not provide the subscription or require direct API credits.', url: 'https://code.claude.com/docs/en/overview' },
      { name: 'Codex', required: true, purpose: 'Runs dedicated Codex sessions using the separately installed native CLI and its existing ChatGPT sign-in.', costDisclosure: 'Separately obtained eligible ChatGPT/Codex access is required. CodaClauda does not provide the subscription or require direct API credits.', url: 'https://learn.chatgpt.com/docs/non-interactive-mode' },
      { name: 'Git', required: true, purpose: 'Lists project files and creates isolated worktrees for delegated edits.', costDisclosure: 'Git is a separately installed free dependency; third-party licensing applies.', url: 'https://git-scm.com/' },
      { name: 'Microsoft Edge WebView2', required: true, purpose: 'Hosts the Windows desktop interface. Must already be installed; this package does not download it.', costDisclosure: 'Separately installed Microsoft runtime; no CodaClauda developer credits or paid unlock is required.', url: 'https://developer.microsoft.com/microsoft-edge/webview2/' },
      { name: 'Spark Dev Bridge', required: false, purpose: 'Optional public-CLI integration for exact owner-authorized build/test jobs and shared result receipts. Supported installed integration acceptance is pending.', costDisclosure: 'Separate software, configuration and optional owner-provided Spark hardware are required for this optional workflow. Hardware, network and external service costs are separate.', url: 'https://github.com/delores88/nvidialink' },
    ],
    privacy: {
      dataLeavesDevice: 'Authorized project text, request prompts, handoff context and result content are sent by the installed Claude Code/Codex CLIs to their provider services under the owner account. Optional Spark Dev Bridge may transfer authorized project/build data to its configured compute target. CodaClauda does not host a public coordination endpoint.',
      retention: 'CodaClauda retains local request history, prompts, answers, events, receipts, configuration and delegated worktrees until the owner removes them. There is no automatic retention expiry or purge. Provider CLIs and optional Spark Dev Bridge keep their own independent histories and retention policies.',
      telemetry: 'CodaClauda adds no independent telemetry or analytics. External provider CLIs, their services, WebView2 and optional Spark Dev Bridge follow their own settings and policies.',
      policyUrl: `https://github.com/${repoName}/blob/${input.release.sourceCommit}/docs/PRIVACY.md`,
    },
    permissions: {
      filesystem: ['Owner-selected project paths for scoped UTF-8 reads and delegated edits.', 'LocalAppData/DeloresAI/CodaClauda for durable history, private configuration and isolated worktrees.', 'Read separately installed native provider and optional Spark Dev Bridge executables.'],
      credentials: ['Provider CLIs use their own saved subscription authentication; CodaClauda does not read or copy provider tokens.', 'Private local request capabilities scope CodaClauda MCP tools; no public listener.'],
      domains: [], elevation: false, backgroundServices: false,
    },
    models: [], executableDownloads: [],
    updater: { mode: 'marketplace-only', coordination: 'CodaClauda contains no self-updater or runtime executable downloader. Install approved release packages through the normal Marketplace workflow. Provider CLIs and optional Spark Dev Bridge update independently.' },
    rollback: { dataCompatible: false, backupRequired: true, notes: 'First schema-version-1 release. No compatibility with another release is claimed. Stop active requests and preserve the local state directory and delegated worktrees before replacement or rollback; never replay an ambiguous request automatically.' },
    artwork: { iconUrl: input.artwork.icon.url, thumbnailUrl: input.artwork.thumbnail.url },
    screenshots: input.artwork.screenshots.map(({ url, alt }) => ({ url, alt })),
    artifacts: [{ os: 'windows', architectures: ['x64'], format: 'nsis', assetId: input.installer.assetId,
      filename: input.installer.filename, installationAdapter: 'windows-nsis', preferred: true, requirements: input.requirements }],
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
  assert.equal(input.appId, 'codaclauda'); assert.equal(input.slug, 'codaclauda');
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
  assert(Number.isFinite(input.requirements.memoryGb) && input.requirements.memoryGb > 0, 'Supply actual tested positive client memoryGb');
  assert(Number.isFinite(input.requirements.diskMb) && input.requirements.diskMb > 0, 'Supply actual tested installed diskMb');
  assert.deepEqual(input.requirements.runtimes, ['Microsoft Edge WebView2'], 'Windows runtime must be the separately installed Microsoft Edge WebView2 recognized by Marketplace');
  assert.deepEqual(input.requirements.distributions, [], 'Windows distributions must be empty');
  assert.equal(input.requirements.gpu, null, 'This utility does not require a client GPU');
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
    marketplace: { submitted: false, accepted: false, featured: false },
    limitation: 'Preparation validates supplied evidence bytes and current structure, not the truth of screenshot/receipt claims or scanner/native acceptance. Keep this receipt private; publish only reviewed release artifacts.' }));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: 'MANIFEST_PREPARATION_REJECTED', message: error.message }));
  process.exitCode = 1;
});
