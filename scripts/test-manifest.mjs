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
    installer: { assetId: 202, filename: 'CodaClauda_0.3.0_x64-setup.exe', signingStatus: 'unsigned' },
    artwork: { icon: { url: `${art}icon.png` }, thumbnail: { url: `${art}thumbnail.png` }, screenshots: [{ url: `${art}mailbox.png`, alt: 'Synthetic test screenshot metadata' }] },
    requirements: { minimumOs: '10.0.26200', memoryGb: 32, diskMb: 18, gpu: null, runtimes: ['Microsoft Edge WebView2'], distributions: [] },
    functionalTest: 'Synthetic metadata validation only; not installed acceptance.',
    ...overrides,
  };
}

test('a new product version and installer name do not implicitly rename the live listing', () => {
  const manifest = makeManifest(input());
  assert.equal(manifest.name, 'ClaudaCoda');
  assert.equal(manifest.appId, 'claudacoda');
  assert.equal(manifest.slug, 'claudacoda');
  assert.equal(manifest.release.version, '0.3.0');
  assert.equal(manifest.artifacts[0].filename, 'CodaClauda_0.3.0_x64-setup.exe');
});

test('explicit display rename preserves every release and upgrade identity', () => {
  const before = makeManifest(input());
  const after = makeManifest(input({ marketplaceDisplayName: 'CodaClauda' }));
  assert.equal(after.name, 'CodaClauda');
  for (const field of ['appId', 'slug', 'publisherId', 'repository', 'release', 'artifacts', 'artwork', 'screenshots']) {
    assert.deepEqual(after[field], before[field], field);
  }
  assert.doesNotMatch(JSON.stringify(after), /ClaudaCoda/);
});

test('invalid display selections and changed routing identities fail closed', () => {
  for (const marketplaceDisplayName of ['', 'codaclauda', ' ClaudaCoda ', null, true, {}]) {
    assert.throws(() => makeManifest(input({ marketplaceDisplayName })), /marketplaceDisplayName/);
  }
  assert.throws(() => makeManifest(input({ appId: 'codaclauda' })), /existing Marketplace appId/);
  assert.throws(() => makeManifest(input({ slug: 'codaclauda' })), /existing Marketplace slug/);
});

test('disclosures describe passive polling, bounded retention and separate provider costs', () => {
  const manifest = makeManifest(input());
  assert.match(manifest.description, /does not wake an idle chat/);
  assert.match(manifest.description, /self-asserted names, not authenticated provider identities/);
  assert.match(manifest.description, /Messages are information, not owner approval/);
  assert.match(manifest.privacy.retention, /30 days.*subsequent mailbox operations/);
  assert.match(manifest.privacy.retention, /Legacy request.*until the owner removes them/);
  assert.match(manifest.rollback.notes, /separate mailbox.json.*schema 2/);
  assert.equal(manifest.offline, true);
  assert.deepEqual(manifest.integrations.filter(({ required }) => required).map(({ name }) => name), ['Microsoft Edge WebView2']);
  assert.equal(manifest.updater.mode, 'coordinated');
  assert.deepEqual(manifest.permissions.domains, ['deloresai.com']);
  assert.doesNotMatch(manifest.description, /Claude push requires|Codex push requires|3D project city|photo-to-avatar/);
});

test('signing disclosure follows the supplied release evidence status', () => {
  assert.match(makeManifest(input()).description, /installer itself is unsigned/);
  const signed = makeManifest(input({ installer: { ...input().installer, signingStatus: 'signed' } }));
  assert.match(signed.description, /installer is signed; see the release signing receipt/);
  assert.doesNotMatch(signed.description, /installer itself is unsigned/);
  assert.throws(() => makeManifest(input({ installer: { ...input().installer, signingStatus: 'unknown' } })), /actual installer signing status/);
});

const checkout = process.env.CODACLAUDA_MARKETPLACE_CONTRACTS;
test('both display names satisfy the current read-only Marketplace contract', { skip: !checkout }, async () => {
  process.env.TSX_DISABLE_CACHE = '1';
  const { tsImport } = await import(pathToFileURL(path.join(checkout, 'node_modules/tsx/dist/esm/api/index.mjs')).href);
  const { manifestSchema } = await tsImport(pathToFileURL(path.join(checkout, 'packages/contracts/src/index.ts')).href, { parentURL: import.meta.url, tsconfig: false });
  const { publicationArtworkIssues } = await tsImport(pathToFileURL(path.join(checkout, 'packages/contracts/src/artwork.ts')).href, { parentURL: import.meta.url, tsconfig: false });
  for (const marketplaceDisplayName of ['ClaudaCoda', 'CodaClauda']) {
    const parsed = manifestSchema.safeParse(makeManifest(input({ marketplaceDisplayName })));
    assert(parsed.success, JSON.stringify(parsed.error?.issues));
    assert.deepEqual(publicationArtworkIssues(parsed.data), []);
  }
});
