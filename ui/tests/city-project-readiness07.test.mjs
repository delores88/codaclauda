import test from 'node:test';
import assert from 'node:assert/strict';
import { desktop } from '../app/bridge.js';
import { DOWNTOWN, SUBURBS, districtOf } from '../app/city/districts.js';
import { SlotMap } from '../app/city/layout.js';

globalThis.window = {};
globalThis.localStorage = { getItem: () => null, setItem() {} };
const { store: singleton } = await import('../app/store.js');
const { CityView } = await import('../app/views/city.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const repos = () => Array.from({ length: 6 }, (_, n) => ({ name: `repo-${n}`, full_name: `owner/repo-${n}` }));
const folders = () => Array.from({ length: 8 }, (_, n) => ({ name: `folder-${n}`, path: `C:/projects/folder-${n}` }));
const scanStats = path => {
  const index = Number(path.split('-').at(-1));
  return { git: { remote: index < 6 ? `https://github.com/owner/repo-${index}.git` : '' } };
};

function fixture(t) {
  const store = new singleton.constructor();
  t.mock.method(desktop, 'loadManifest', async () => ({ manifest: null }));
  t.mock.method(desktop, 'githubRepos', async () => ({ user: 'owner', repos: repos() }));
  t.mock.method(desktop, 'scanProject', async path => scanStats(path));
  t.mock.method(desktop, 'saveState', async () => ({}));
  t.after(() => { clearTimeout(store._saveTimer); for (const timer of store._timers) clearInterval(timer); });
  let adoption;
  const adopt = store.adoptManifest.bind(store);
  t.mock.method(store, 'adoptManifest', (...args) => { const active = store._adopting, result = adopt(...args); if (!active) adoption = result; return result; });
  const writes = t.mock.method(store, 'setPref');
  const view = Object.assign(Object.create(CityView.prototype), { store, slots: new SlotMap(), islands: { homeSlots: null } });
  const off = store.on('change', () => view.ensureDistrictBanks(store.projects));
  t.after(off);
  return { store, view, writes, done: async () => { await adoption; await tick(); } };
}

test('first manifest hydration waits for fetched repos and local remote identities before persisting bank choice', async t => {
  const f = fixture(t), github = deferred(), scanning = deferred();
  t.after(() => { github.resolve({ user: 'owner', repos: repos() }); scanning.resolve(); });
  const manifest = { github_user: 'owner', projects: folders().map(p => ({ name: p.name, local_path: p.path })) };
  desktop.loadManifest.mock.mockImplementation(async () => ({ manifest }));
  desktop.githubRepos.mock.mockImplementation(() => github.promise);
  desktop.scanProject.mock.mockImplementation(async path => { await scanning.promise; return scanStats(path); });
  await f.store.refreshManifest();
  assert.equal(f.store.cityProjectsReady, false); assert.equal(f.view.homeBanks, undefined);
  assert.equal(f.writes.mock.callCount(), 0);
  github.resolve({ user: 'owner', repos: repos() }); await tick();
  assert.equal(f.store.projects.length, 14, 'unscanned folders and their repos have not merged yet');
  assert.equal(f.store.cityProjectsReady, false); assert.equal(f.writes.mock.callCount(), 0);
  scanning.resolve(); await f.done();
  assert.equal(f.store.cityProjectsReady, true); assert.equal(f.store.projects.length, 8);
  assert.equal(f.store.projects.filter(p => districtOf(p) === DOWNTOWN).length, 6);
  assert.equal(f.view.homeBanks.largerDistrict, DOWNTOWN); assert.equal(f.writes.mock.callCount(), 1);
  assert.deepEqual(f.writes.mock.calls[0].arguments, ['cityLargerDistrictV1', DOWNTOWN]);
});

test('an absent manifest still hydrates saved unscanned folder identities before choosing banks', async t => {
  const f = fixture(t), scanning = deferred(); t.after(() => scanning.resolve());
  f.store.desktop.projects.local = folders();
  f.store.desktop.projects.github = { user: 'owner', repos: repos() };
  desktop.scanProject.mock.mockImplementation(async path => { await scanning.promise; return scanStats(path); });
  await f.store.refreshManifest();
  assert.equal(f.store.cityProjectsReady, false); assert.equal(f.writes.mock.callCount(), 0);
  assert.equal(f.store.projects.length, 14);
  scanning.resolve(); await f.done();
  assert.equal(desktop.scanProject.mock.callCount(), 8);
  assert.equal(f.store.projects.length, 8); assert.equal(f.store.cityProjectsReady, true);
  assert.equal(f.view.homeBanks.largerDistrict, DOWNTOWN); assert.equal(f.writes.mock.callCount(), 1);
});

test('an optional manifest read failure still hydrates saved inventory and releases first layout', async t => {
  const f = fixture(t), scanning = deferred(); t.after(() => scanning.resolve());
  f.store.desktop.projects.local = folders();
  f.store.desktop.projects.github = { user: 'owner', repos: repos() };
  desktop.loadManifest.mock.mockImplementation(async () => { throw new Error('optional manifest unavailable'); });
  desktop.scanProject.mock.mockImplementation(async path => { await scanning.promise; return scanStats(path); });
  await f.store.refreshManifest();
  assert.equal(f.store.cityProjectsReady, false); assert.equal(f.writes.mock.callCount(), 0);
  scanning.resolve(); await f.done();
  assert.equal(f.store.cityProjectsReady, true); assert.equal(f.store.projects.length, 8);
  assert.equal(f.view.homeBanks.largerDistrict, DOWNTOWN); assert.equal(f.writes.mock.callCount(), 1);
});

test('failed repo and folder lookups finish initial hydration without freezing the City loading state', async t => {
  const f = fixture(t);
  const manifest = { github_user: 'owner', projects: [{ name: 'Local garden', local_path: 'C:/garden' }, { name: 'Known repo', github: 'owner/known' }] };
  desktop.loadManifest.mock.mockImplementation(async () => ({ manifest }));
  desktop.githubRepos.mock.mockImplementation(async () => { throw new Error('offline'); });
  desktop.scanProject.mock.mockImplementation(async () => { throw new Error('folder unavailable'); });
  await f.store.refreshManifest(); await f.done();
  assert.equal(f.store.cityProjectsReady, true);
  assert.equal(desktop.githubRepos.mock.callCount(), 1); assert.equal(desktop.scanProject.mock.callCount(), 1);
  assert.equal(f.store.projects.length, 2);
  assert.equal(f.view.homeBanks.largerDistrict, DOWNTOWN, 'the available inventory ties');
  assert.equal(f.writes.mock.callCount(), 1);
});

test('empty and already-scanned inventories become ready without redundant folder work', async t => {
  for (const populated of [false, true]) {
    const f = fixture(t);
    if (populated) f.store.desktop.projects.local = [{ name: 'Garden', path: 'C:/garden', scannedAt: 1, stats: {} }];
    await f.store.refreshManifest(); await f.done();
    assert.equal(f.store.cityProjectsReady, true); assert.equal(desktop.scanProject.mock.callCount(), 0);
    assert.equal(f.view.homeBanks.largerDistrict, populated ? SUBURBS : DOWNTOWN);
    assert.equal(f.writes.mock.callCount(), 1);
  }
});

test('saved bank choice applies before hydration and does not get overwritten after counts change', async t => {
  const f = fixture(t);
  f.store.desktop.prefs.cityLargerDistrictV1 = SUBURBS;
  assert.equal(f.view.ensureDistrictBanks(f.store.projects), true);
  const slots = f.view.slots, banks = f.view.homeBanks;
  assert.equal(f.store.cityProjectsReady, false); assert.equal(banks.largerDistrict, SUBURBS);
  f.store.desktop.projects.github = { user: 'owner', repos: repos() };
  await f.store.refreshManifest(); await f.done();
  assert.equal(f.store.cityProjectsReady, true); assert.equal(f.view.homeBanks, banks);
  assert.equal(f.view.slots, slots); assert.equal(f.writes.mock.callCount(), 0);
});

test('City sync offers the complete inventory to bank selection, including hidden projects', () => {
  const visible = [{ id: 'local:garden', visible: { city: true } }];
  const all = [...visible, ...repos().map(p => ({ id: `gh:${p.full_name}`, visible: { city: false } }))];
  let offered;
  const view = Object.assign(Object.create(CityView.prototype), {
    world: {}, root: { classList: { toggle() {} } }, reduced: () => false,
    store: { visibleProjects: () => visible, projects: all },
    ensureDistrictBanks(projects) { offered = projects; return false; },
  });
  view.sync(); assert.equal(offered, all);
});

test('saved home layouts wait for merged identities so reload cannot spuriously grow another ring', () => {
  const transient = folders().map(p => ({ ...p, id: `local:${p.path}`, visible: { city: true } }));
  const store = { prefs: { cityLargerDistrictV1: DOWNTOWN }, cityProjectsReady: false,
    projects: transient, visibleProjects: () => transient };
  const view = Object.assign(Object.create(CityView.prototype), {
    store, world: {}, root: { classList: { toggle() {} } }, reduced: () => false,
    islands: { current: null }, slots: new SlotMap(),
  });
  view.ensureDistrictBanks(transient);
  let assigned = 0;
  view.slots.assign = () => { assigned++; throw new Error('assignment reached'); };
  view.sync(); assert.equal(assigned, 0, 'transient home identities must not allocate plots');
  store.cityProjectsReady = true;
  assert.throws(() => view.sync(), /assignment reached/);
  assert.equal(assigned, 1, 'complete inventory releases layout');
  store.cityProjectsReady = false; view.islands.current = 'contributor';
  assert.throws(() => view.sync(), /assignment reached/);
  assert.equal(assigned, 2, 'contributor layout does not depend on home hydration');
});
