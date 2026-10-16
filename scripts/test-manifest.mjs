import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { makeManifest } from './manifest.mjs';

// Synthetic metadata only: no GitHub reads, uploads, installer builds or output files.
function input(overrides = {}) {
  const art = 'https://raw.githubusercontent.com/delores88/codaclauda/1234567890abcdef1234567890abcdef12345678/assets/';
  return {
    appId: 'claudacoda', slug: 'claudacoda', publisherId: 'synthetic-publisher',
    release: { id: 101, tag: 'v0.3.0', version: '0.3.0', channel: 'stable', sourceCommit: '1234567890abcdef1234567890abcdef12345678' },
    installer: { assetId: 202, filename: 'ClaudaCoda_0.3.0_x64-setup.exe', signingStatus: 'unsigned' },
    artwork: { icon: { url: `${art}icon.png` }, thumbnail: { url: `${art}thumbnail.png` }, screenshots: [{ url: `${art}mailbox.png`, alt: 'Synthetic test screenshot metadata' }] },
    requirements: { minimumOs: '10.0.26200', memoryGb: 32, diskMb: 18, gpu: null, runtimes: ['Microsoft Edge WebView2'], distributions: [] },
    functionalTest: 'Synthetic metadata validation only; not installed acceptance.',
    ...overrides,
  };
}

test('a new product version does not implicitly rename the live listing', () => {
  const manifest = makeManifest(input());
  assert.equal(manifest.name, 'ClaudaCoda');
  assert.equal(manifest.appId, 'claudacoda');
  assert.equal(manifest.slug, 'claudacoda');
  assert.equal(manifest.release.version, '0.3.0');
  assert.equal(manifest.artifacts[0].filename, 'ClaudaCoda_0.3.0_x64-setup.exe');
});

test('explicit display rename preserves every release and upgrade identity', () => {
  const before = makeManifest(input());
  const after = makeManifest(input({ marketplaceDisplayName: 'CodaClauda' }));
  assert.equal(after.name, 'CodaClauda');
  for (const field of ['appId', 'slug', 'publisherId', 'repository', 'release', 'artifacts', 'artwork', 'screenshots']) {
    assert.deepEqual(after[field], before[field], field);
  }
  assert.doesNotMatch(JSON.stringify({ ...after, artifacts: [] }), /ClaudaCoda/);
});

test('installer names preserve discovery by installed 0.2 clients and bind the exact version', () => {
  for (const filename of ['CodaClauda_0.3.0_x64-setup.exe', 'ClaudaCoda_0.2.0_x64-setup.exe', '../ClaudaCoda_0.3.0_x64-setup.exe', 'ClaudaCoda_0.3.0_arm64-setup.exe']) {
    assert.throws(() => makeManifest(input({ installer: { ...input().installer, filename } })), /historical installer filename and exact version/);
  }
});

test('invalid display selections and changed routing identities fail closed', () => {
  for (const marketplaceDisplayName of ['', 'codaclauda', ' ClaudaCoda ', null, true, {}]) {
    assert.throws(() => makeManifest(input({ marketplaceDisplayName })), /marketplaceDisplayName/);
  }
  assert.throws(() => makeManifest(input({ appId: 'codaclauda' })), /existing Marketplace appId/);
  assert.throws(() => makeManifest(input({ slug: 'codaclauda' })), /existing Marketplace slug/);
});

test('disclosures separate passive delivery, dedicated chat, local copies and external services', () => {
  const manifest = makeManifest(input());
  assert.match(manifest.description, /does not wake an idle chat/);
  assert.match(manifest.description, /self-asserted names, not authenticated provider identities/);
  assert.match(manifest.description, /Messages are information, not owner approval/);
  assert.match(manifest.privacy.retention, /30 days.*subsequent mailbox operations/);
  assert.match(manifest.privacy.retention, /Legacy request.*until the owner removes them/);
  assert.match(manifest.privacy.retention, /attachment copies.*no automatic expiry/);
  assert.match(manifest.description, /Live chat mode starts a fresh dedicated read-only provider request for each send/);
  assert.match(manifest.description, /not independent proof of agent presence or task completion/);
  assert.match(manifest.description, /Attachments and desktop chat copies.*not covered by the mailbox credential scan/);
  assert.match(manifest.privacy.dataLeavesDevice, /creation sends the chosen name, description and visibility to GitHub/);
  assert.match(manifest.privacy.dataLeavesDevice, /dictation.*may send audio.*not guaranteed offline/);
  assert.match(manifest.rollback.notes, /separate mailbox.json.*schema 2/);
  assert.equal(manifest.offline, true);
  assert.deepEqual(manifest.integrations.filter(({ required }) => required).map(({ name }) => name), ['Microsoft Edge WebView2']);
  assert.equal(manifest.updater.mode, 'coordinated');
  assert.deepEqual(manifest.permissions.domains, ['deloresai.com', 'api.github.com', 'github.com']);
  assert.match(manifest.description, /3D project city/);
  assert.match(manifest.privacy.dataLeavesDevice, /Local photo matching.*explicit avatar-help request saves the photo and shares its local path/);
  assert.doesNotMatch(manifest.description, /Claude push requires|Codex push requires/);
});

test('signing disclosure follows the supplied release evidence status', () => {
  assert.match(makeManifest(input()).description, /installer itself is unsigned/);
  const signed = makeManifest(input({ installer: { ...input().installer, signingStatus: 'signed' } }));
  assert.match(signed.description, /installer is signed; see the release signing receipt/);
  assert.doesNotMatch(signed.description, /installer itself is unsigned/);
  assert.throws(() => makeManifest(input({ installer: { ...input().installer, signingStatus: 'unknown' } })), /actual installer signing status/);
});

test('known and unspecified minimum requirements are preserved without inferring test-host values', () => {
  for (const [minimumOs, memoryGb] of [['10.0', 8], ['0', 0], ['10.0', 0], ['0', 8]]) {
    const requirements = { ...input().requirements, minimumOs, memoryGb };
    assert.deepEqual(makeManifest(input({ requirements })).artifacts[0].requirements, requirements);
  }
});

test('invalid OS, negative or nonfinite memory, and invalid footprint fail closed', () => {
  for (const memoryGb of [-1, NaN, Infinity, -Infinity, 4097, '0', null, undefined]) {
    assert.throws(() => makeManifest(input({ requirements: { ...input().requirements, memoryGb } })), /memoryGb/);
  }
  for (const minimumOs of [-1, NaN, Infinity, '', 'unknown', '10..0', '10.0.1.2.3', null, undefined]) {
    assert.throws(() => makeManifest(input({ requirements: { ...input().requirements, minimumOs } })), /minimumOs/);
  }
  for (const diskMb of [-1, 0, NaN, Infinity, -Infinity]) {
    assert.throws(() => makeManifest(input({ requirements: { ...input().requirements, diskMb } })), /diskMb/);
  }
});

const checkout = process.env.CODACLAUDA_MARKETPLACE_CONTRACTS;
test('both display names and known or unspecified minimums satisfy the read-only Marketplace contract', { skip: !checkout }, async () => {
  process.env.TSX_DISABLE_CACHE = '1';
  const { tsImport } = await import(pathToFileURL(path.join(checkout, 'node_modules/tsx/dist/esm/api/index.mjs')).href);
  const { manifestSchema } = await tsImport(pathToFileURL(path.join(checkout, 'packages/contracts/src/index.ts')).href, { parentURL: import.meta.url, tsconfig: false });
  const { publicationArtworkIssues } = await tsImport(pathToFileURL(path.join(checkout, 'packages/contracts/src/artwork.ts')).href, { parentURL: import.meta.url, tsconfig: false });
  for (const marketplaceDisplayName of ['ClaudaCoda', 'CodaClauda']) {
    for (const minimums of [{ minimumOs: '10.0', memoryGb: 8 }, { minimumOs: '0', memoryGb: 0 }]) {
      const parsed = manifestSchema.safeParse(makeManifest(input({ marketplaceDisplayName, requirements: { ...input().requirements, ...minimums } })));
      assert(parsed.success, JSON.stringify(parsed.error?.issues));
      assert.deepEqual(publicationArtworkIssues(parsed.data), []);
    }
  }
});
