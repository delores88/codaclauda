import test from 'node:test';
import assert from 'node:assert/strict';
import { desktop } from '../app/bridge.js';
import { CITY_HYDRATION_MS, PROJECT_REQUEST_MS, PROJECT_SCAN_CONCURRENCY, createRequestPool, withTimeout } from '../app/project-hydration.js';

globalThis.window = {};
globalThis.localStorage = { getItem: () => null, setItem() {} };
const { store: singleton } = await import('../app/store.js');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
const advance = async (t, ms) => { t.mock.timers.tick(ms); await flush(); };
function fixture(t, count = 0) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const store = new singleton.constructor();
  store.desktop.projects.local = Array.from({ length: count }, (_, n) => ({ path: `C:/project-${n}`, name: `Project ${n}` }));
  t.mock.method(desktop, 'loadManifest', async () => ({ manifest: null }));
  t.mock.method(desktop, 'scanProject', async () => ({ loc: 50, git: {} }));
  t.mock.method(desktop, 'githubRepos', async user => ({ user, repos: [] }));
  t.mock.method(desktop, 'saveState', async () => ({}));
  return store;
}

test('readiness has one three-second deadline even if the optional manifest never answers', async t => {
  const store = fixture(t), pending = deferred();
  desktop.loadManifest.mock.mockImplementation(() => pending.promise);
  let readinessEvents = 0; store.on('change', () => { if (store.cityProjectsReady) readinessEvents++; });
  const first = store.refreshManifest(); await flush();
  await advance(t, CITY_HYDRATION_MS - 1); assert.equal(store.cityProjectsReady, false);
  store.beginCityHydration(); const second = store.refreshManifest(); await flush();
  assert.equal(desktop.loadManifest.mock.callCount(), 1);
  await advance(t, 1); assert.equal(store.cityProjectsReady, true); assert.equal(readinessEvents, 1);
  await advance(t, PROJECT_REQUEST_MS); await Promise.all([first, second]);
  assert.equal(readinessEvents, 1); assert.equal(desktop.loadManifest.mock.callCount(), 1);
});

test('missing or rejected manifest does not block cached scans or early readiness', async t => {
  const store = fixture(t, 2);
  desktop.loadManifest.mock.mockImplementation(async () => { throw new Error('optional file absent'); });
  await store.refreshManifest(); await flush();
  assert.equal(desktop.scanProject.mock.callCount(), 2); assert.equal(store.cityProjectsReady, true);
  assert.ok(store.desktop.projects.local.every(p => p.scannedAt));
  assert.equal(Date.now(), 1000, 'successful hydration needs no timeout tick');
});

test('scan concurrency bounds actual invocations after waits expire and repeated adoption cannot multiply them', async t => {
  const store = fixture(t, 12), pending = Array.from({ length: 12 }, deferred);
  let active = 0, peak = 0;
  desktop.scanProject.mock.mockImplementation(path => {
    active++; peak = Math.max(peak, active);
    return pending[Number(path.split('-').at(-1))].promise.then(value => { active--; return value; }, error => { active--; throw error; });
  });
  const first = store.adoptManifest(); await flush();
  assert.equal(desktop.scanProject.mock.callCount(), PROJECT_SCAN_CONCURRENCY);
  assert.equal(store._scanPool.queued, 8);
  assert.equal(store.adoptManifest(), first, 'reentry shares the active adoption');
  await advance(t, CITY_HYDRATION_MS); assert.equal(store.cityProjectsReady, true);
  await advance(t, PROJECT_REQUEST_MS); await first;
  assert.equal(store._adopting, null); assert.equal(active, 4);
  const retry = store.adoptManifest(); await flush();
  assert.equal(desktop.scanProject.mock.callCount(), 4, 'timeout never releases an occupied native slot');
  pending[0].resolve({ loc: 90, git: { remote: 'git@github.com:Owner/Project.Zero.git' } }); await flush();
  assert.equal(desktop.scanProject.mock.callCount(), 5); assert.equal(active, 4); assert.equal(peak, 4);
  assert.equal(store.desktop.projects.local[0].stats.loc, 90, 'safe late metrics remain useful');
  assert.ok(store.projects.find(p => p.path === 'C:/project-0').ids.includes('gh:owner/project.zero'));
  await advance(t, PROJECT_REQUEST_MS); await retry;
  assert.equal(desktop.scanProject.mock.callCount(), 5);
});

test('a rejected initial scan can be retried explicitly without leaving adoption locked or auto-retrying', async t => {
  const store = fixture(t, 1);
  desktop.scanProject.mock.mockImplementationOnce(async () => { throw new Error('not available'); });
  await store.adoptManifest();
  assert.equal(store._adopting, null); assert.equal(store.cityProjectsReady, true);
  await flush(); assert.equal(desktop.scanProject.mock.callCount(), 1);
  await store.adoptManifest();
  assert.equal(desktop.scanProject.mock.callCount(), 2); assert.ok(store.desktop.projects.local[0].scannedAt);
  await store.adoptManifest(); assert.equal(desktop.scanProject.mock.callCount(), 2, 'completed folders are not scanned again');
});

test('a manifest arriving after readiness adds identities and adopts new folders once without resetting readiness', async t => {
  const store = fixture(t, 1), pending = deferred();
  desktop.loadManifest.mock.mockImplementation(() => pending.promise);
  const loading = store.refreshManifest(); await flush();
  assert.equal(desktop.scanProject.mock.callCount(), 1, 'cached scans start while manifest waits');
  await advance(t, CITY_HYDRATION_MS); assert.equal(store.cityProjectsReady, true);
  pending.resolve({ manifest: { projects: [{ name: 'Late', local_path: 'C:/late', github: 'Owner/Late.Repo' }] } });
  await loading; await flush();
  assert.equal(store.cityProjectsReady, true); assert.equal(desktop.scanProject.mock.callCount(), 2);
  const late = store.projects.find(p => p.path === 'C:/late'); assert.ok(late.ids.includes('gh:owner/late.repo'));
  assert.equal(store._adopting, null);
});

test('manifest changes during adoption queue one pass with the new inventory', async t => {
  const store = fixture(t, 1), pending = deferred();
  desktop.scanProject.mock.mockImplementationOnce(() => pending.promise);
  await store.refreshManifest(); await flush();
  desktop.loadManifest.mock.mockImplementation(async () => ({ manifest: { projects: [{ name: 'Added', local_path: 'C:/added' }] } }));
  await store.refreshManifest(); await flush();
  assert.equal(desktop.scanProject.mock.callCount(), 1);
  pending.resolve({ loc: 1, git: {} }); await flush();
  assert.equal(desktop.scanProject.mock.callCount(), 2); assert.equal(store.cityProjectsReady, true);
  assert.equal(store._adopting, null); assert.equal(store.desktop.projects.local.length, 2);
});

test('slow GitHub hydration settles City at three seconds, times out its caller, and safely accepts a late answer', async t => {
  const store = fixture(t), pending = deferred();
  store.manifest = { github_user: 'owner', projects: [] };
  desktop.githubRepos.mock.mockImplementation(() => pending.promise);
  const adoption = store.adoptManifest(); await flush();
  await advance(t, CITY_HYDRATION_MS); assert.equal(store.cityProjectsReady, true);
  await advance(t, PROJECT_REQUEST_MS); await adoption; assert.equal(store._adopting, null);
  const again = store.adoptManifest(); await flush(); assert.equal(desktop.githubRepos.mock.callCount(), 1);
  pending.resolve({ user: 'owner', repos: [{ full_name: 'Owner/Late.Repo', name: 'Late.Repo' }] });
  await again; assert.equal(store.projects[0].id, 'gh:owner/late.repo'); assert.equal(store.cityProjectsReady, true);
});

test('late scans cannot overwrite a removed/relinked folder or a newer stats snapshot', async t => {
  const store = fixture(t, 2), a = deferred(), b = deferred();
  desktop.scanProject.mock.mockImplementation(path => path.endsWith('-0') ? a.promise : b.promise);
  const scanning = store.adoptManifest(); await flush();
  const replacement = { path: 'C:/project-0', name: 'Relinked', stats: { loc: 999 }, scannedAt: 99 };
  store.desktop.projects.local[0] = replacement;
  store.desktop.projects.local[1].stats = { loc: 777 }; store.desktop.projects.local[1].scannedAt = 88;
  a.resolve({ loc: 1 }); b.resolve({ loc: 2 }); await scanning;
  assert.equal(store.desktop.projects.local[0], replacement); assert.equal(replacement.stats.loc, 999);
  assert.equal(store.desktop.projects.local[1].stats.loc, 777);
});

test('out-of-order GitHub replies retain the latest explicit account and automatic discovery cannot replace it', async t => {
  const store = fixture(t), a = deferred(), b = deferred();
  desktop.githubRepos.mock.mockImplementation(user => user === 'old' ? a.promise : b.promise);
  const old = store.linkGithub('old'), recent = store.linkGithub('new'); await flush();
  const automatic = store.linkGithub('manifest', { automatic: true }); await flush();
  assert.equal(desktop.githubRepos.mock.callCount(), 2);
  b.resolve({ user: 'new', repos: [{ full_name: 'new/repo', name: 'repo' }] }); await recent;
  a.resolve({ user: 'old', repos: [{ full_name: 'old/repo', name: 'repo' }] }); await Promise.all([old, automatic]);
  assert.equal(store.desktop.projects.github.user, 'new');
  assert.deepEqual(store.projects.map(p => p.id), ['gh:new/repo']);
});

test('pool rejects one operation without starving its queue, and bounded waits handle late rejection', async t => {
  fixture(t);
  const pool = createRequestPool(1), pending = deferred(), calls = [];
  const first = pool.run(() => { calls.push('first'); return pending.promise; });
  const wait = withTimeout(first, 10).catch(error => error.code);
  const next = pool.run(async () => { calls.push('next'); return 42; }); await flush();
  await advance(t, 10); assert.equal(await wait, 'TIMEOUT'); assert.deepEqual(calls, ['first']);
  pending.reject(new Error('late failure')); assert.equal(await next, 42);
  assert.equal(pool.active, 0); assert.equal(pool.queued, 0);
});

test('reselecting a pending GitHub account keeps the latest intent without duplicating its invocation', async t => {
  const store = fixture(t);
  for (const order of [['beta', 'alpha'], ['alpha', 'beta']]) {
    const pending = { alpha: deferred(), beta: deferred() };
    desktop.githubRepos.mock.mockImplementation(user => pending[user].promise);
    const before = desktop.githubRepos.mock.callCount();
    const a = store.linkGithub('alpha'), b = store.linkGithub('beta'), again = store.linkGithub('alpha'); await flush();
    assert.equal(desktop.githubRepos.mock.callCount() - before, 2);
    for (const user of order) { pending[user].resolve({ user, repos: [{ full_name: `${user}/repo`, name: 'repo' }] }); await flush(); }
    await Promise.all([a, b, again]); assert.equal(store.desktop.projects.github.user, 'alpha');
  }
  const a = deferred(), b = deferred();
  desktop.githubRepos.mock.mockImplementation(user => user === 'alpha' ? a.promise : b.promise);
  const first = store.linkGithub('alpha'), second = store.linkGithub('beta'); await flush();
  b.resolve({ user: 'beta', repos: [] }); await second;
  const reselected = store.linkGithub('alpha');
  a.resolve({ user: 'alpha', repos: [] }); await Promise.all([first, reselected]);
  assert.equal(store.desktop.projects.github.user, 'alpha', 'reselection also supersedes an already-completed other account');
});

test('a late same-account GitHub answer cannot resurrect a project explicitly removed from its snapshot', async t => {
  const store = fixture(t), pending = deferred();
  store.desktop.projects.github = { user: 'sample', repos: [
    { name: 'Removed.Name' }, { full_name: 'sample/kept', name: 'kept' },
  ] };
  desktop.githubRepos.mock.mockImplementation(() => pending.promise);
  const loading = store.linkGithub('sample'); await flush();
  store.unlinkProject({ id: 'gh:sample/removed.name', ids: [] });
  assert.deepEqual(store.projects.map(p => p.id), ['gh:sample/kept']);
  pending.resolve({ user: 'sample', repos: [{ full_name: 'sample/removed.name', name: 'Removed.Name' }] }); await loading;
  assert.deepEqual(store.projects.map(p => p.id), ['gh:sample/kept']);
});
