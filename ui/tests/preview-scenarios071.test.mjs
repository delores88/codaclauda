import test from 'node:test';
import assert from 'node:assert/strict';
import { createMock, mockHandlers } from '../dev/mock.js';
import { fixtureURL, normalizeFixture, previewOptions } from '../dev/mock-scenarios.js';

const fixture = { githubUser: 'sample-owner', projects: [
  { name: 'Sample Local', path: 'C:/sample/local' },
  { name: 'Sample Linked', path: 'C:/sample/linked', remote: 'https://github.com/sample-owner/linked.git' },
  { name: 'Sample Ghost', repo: 'sample-owner/ghost' },
] };
const storage = () => { const entries = new Map(); return { entries, getItem: name => entries.get(name) || null, setItem: (name, value) => entries.set(name, value) }; };
const memory = storage();
globalThis.localStorage = memory;
function preview(options = {}) {
  const calls = [], sleep = async () => {};
  const fetch = async (url, settings) => { calls.push({ url, settings }); return { ok: true, text: async () => JSON.stringify(fixture) }; };
  const api = createMock({ baseURL: 'http://preview.invalid/index.html', sleep, fetch, timers: false, storage: storage(), ...options });
  return { api, calls };
}
const data = async (api, command, args) => { const result = await api.invoke(command, args); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('ordinary preview keeps the default manifest, scan and repository fixture and does not fetch', async () => {
  const { api, calls } = preview(), existing = mockHandlers().desktop;
  assert.deepEqual(await data(api, 'desktop_manifest_load'), existing.desktop_manifest_load());
  assert.deepEqual(await data(api, 'github_repos', { user: 'example' }), existing.github_repos({ user: 'example' }));
  const scan = await data(api, 'project_scan', { path: 'C:/sample/local' });
  assert.equal(scan.path, 'C:/sample/local'); assert.equal(scan.git.remote, '');
  assert.equal(calls.length, 0);
});

test('fault parsing accepts only explicit modes and bounds each service delay independently', () => {
  const options = previewOptions('?scanMode=slow&scanDelayMs=999999&githubMode=reject&githubDelayMs=-7&manifestMode=never&manifestDelayMs=NaN');
  assert.deepEqual(options.faults, { scan: { mode: 'slow', delayMs: 30000 }, github: { mode: 'reject', delayMs: 0 }, manifest: { mode: 'never', delayMs: 6000 } });
  assert.equal(previewOptions('?scanMode=unknown').faults.scan.mode, 'normal');
  assert.equal(previewOptions('?scanDelayMs=17').faults.scan.mode, 'normal');
  assert.equal(previewOptions('?deferRemotes=1').deferRemotes, true);
});

test('slow, rejected and never-resolving calls remain asynchronous and service-local', async () => {
  for (const [service, command, args] of [['scan', 'project_scan', { path: 'C:/sample/local' }], ['github', 'github_repos', {}], ['manifest', 'desktop_manifest_load', {}]]) {
    let release; const waits = [];
    const slow = preview({ search: `?${service}Mode=slow&${service}DelayMs=123`, sleep: ms => { waits.push(ms); return ms === 123 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(); } }).api;
    let done = false; const waiting = slow.invoke(command, args).then(result => { done = true; return result; });
    await tick(); assert.equal(done, false); assert.deepEqual(waits, [40, 123]);
    assert.equal((await slow.invoke('preferences')).ok, true, 'unrelated commands remain usable');
    release(); assert.equal((await waiting).ok, true);
    const rejected = await preview({ search: `?${service}Mode=reject` }).api.invoke(command, args);
    assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'MOCK_SCENARIO_REJECTED');
    const never = preview({ search: `?${service}Mode=never` }).api; let settled = false;
    never.invoke(command, args).then(() => { settled = true; }, () => { settled = true; });
    await tick(); await tick(); assert.equal(settled, false, 'never is not a Promise-cloning error');
    assert.equal((await never.invoke('preferences')).ok, true);
  }
});

test('fixture load is shared and known remotes are available before scans', async () => {
  const { api, calls } = preview({ search: '?fixture=/local-fixtures/city.json' });
  const [state, manifest, repos] = await Promise.all([data(api, 'desktop_state_load'), data(api, 'desktop_manifest_load'), data(api, 'github_repos')]);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'http://preview.invalid/local-fixtures/city.json');
  assert.equal(calls[0].settings.credentials, 'omit'); assert.equal(calls[0].settings.redirect, 'error');
  assert.equal(state.state.projects.local.length, 2); assert.equal(state.state.projects.local[1].scannedAt, undefined);
  assert.equal(state.state.projects.local[1].stats.git.remote, fixture.projects[1].remote);
  assert.equal(manifest.manifest.projects[1].github, undefined, 'remote-only identity is not fabricated in the manifest');
  assert.equal(manifest.manifest.projects[2].github, 'sample-owner/ghost');
  assert.deepEqual(repos.repos.map(repo => repo.full_name), ['sample-owner/linked', 'sample-owner/ghost']);
  const scan = await data(api, 'project_scan', { path: 'c:\\sample\\linked\\' });
  assert.equal(scan.git.remote, fixture.projects[1].remote); assert.equal(scan.name, 'Sample Linked');
  assert.ok(scan.loc > 0, 'fixture metrics remain synthetic');
  assert.equal(calls.length, 1);
});

test('deferred remotes exercise late identity discovery without changing explicit manifest repos', async () => {
  const { api } = preview({ search: '?fixture=/local-fixtures/city.json&deferRemotes=1' });
  const state = (await data(api, 'desktop_state_load')).state;
  assert.equal(state.projects.local[1].stats, undefined);
  const scan = await data(api, 'project_scan', { path: fixture.projects[1].path });
  assert.equal(scan.git.remote, fixture.projects[1].remote);
  assert.equal((await data(api, 'desktop_manifest_load')).manifest.projects[2].github, 'sample-owner/ghost');
});

test('fixture state survives a preview reload in its own session namespace and never changes default mock state', async () => {
  const isolated = storage(), defaultBefore = [...memory.entries];
  const options = { search: '?fixture=/local-fixtures/city.json', storage: isolated };
  const first = preview(options).api, saved = (await data(first, 'desktop_state_load')).state;
  saved.prefs.cityLargerDistrictV1 = 'suburbs';
  await data(first, 'desktop_state_save', { state: saved }); saved.prefs.cityLargerDistrictV1 = 'downtown';
  const reloaded = (await data(preview(options).api, 'desktop_state_load')).state;
  assert.equal(reloaded.prefs.cityLargerDistrictV1, 'suburbs');
  assert.deepEqual([...isolated.entries.keys()], ['mock.fixture:http://preview.invalid/local-fixtures/city.json']);
  assert.deepEqual([...memory.entries], defaultBefore);
  const other = (await data(preview({ ...options, search: '?fixture=/local-fixtures/other.json' }).api, 'desktop_state_load')).state;
  assert.equal(other.prefs.cityLargerDistrictV1, undefined);
});

test('fixture loader refuses other origins, traversal and unsupported shapes without fetching them', async () => {
  for (const path of ['https://other.invalid/city.json', '//other.invalid/city.json', '/private.json', '/local-fixtures/../private.json', '/local-fixtures/%2e%2e/private.json', '/local-fixtures/city.json?secret=x']) {
    assert.throws(() => fixtureURL(path, 'http://preview.invalid'), /Preview fixtures/);
    const { api, calls } = preview({ search: `?fixture=${encodeURIComponent(path)}` });
    const result = await api.invoke('desktop_state_load'); assert.equal(result.ok, false); assert.equal(calls.length, 0);
  }
  const normalized = normalizeFixture({ ...fixture, privateField: 'ignored', projects: [{ ...fixture.projects[0], transcript: 'ignored' }] });
  assert.deepEqual(normalized, { githubUser: fixture.githubUser, projects: [fixture.projects[0]] });
  assert.throws(() => normalizeFixture({ projects: [{ name: 'Invalid' }] }), /path or repository/);
  for (const fetch of [async () => ({ ok: false }), async () => ({ ok: true, text: async () => 'not json' }), async () => { throw new Error('unavailable'); }]) {
    const result = await preview({ search: '?fixture=/local-fixtures/city.json', fetch }).api.invoke('desktop_state_load');
    assert.equal(result.ok, false); assert.match(result.error.code, /^MOCK_FIXTURE_/);
  }
});
