import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRepos, groupIslands, diffRoutes, repoProject, layoutIslands, IslandRoutes } from '../app/islands.js';

const repo = (login, name, extra = {}) => ({ owner: { login, type: 'Organization' }, name, size_kb: 900, ...extra });

test('repos group into one island per owner; malformed and duplicate entries are dropped', () => {
  const repos = cleanRepos([repo('deloresai', 'web'), repo('deloresai', 'api'), repo('Mira', 'lab', { owner: { login: 'Mira', type: 'User' } }), repo('bad/owner', 'x'), repo('deloresai', 'WEB')]);
  const islands = groupIslands(repos);
  assert.deepEqual(islands.map(i => [i.id, i.ownerType, i.repos.length]), [['gh-owner:deloresai', 'Organization', 2], ['gh-owner:mira', 'User', 1]]);
});

test('new routes: names not seen at the last check stay fresh until seen', () => {
  const first = diffRoutes(cleanRepos([repo('a', 'one')]), null);
  assert.equal(first.firstEver, true);
  assert.deepEqual(first.added, ['a/one']);
  const next = diffRoutes(cleanRepos([repo('a', 'one'), repo('b', 'two')]), first.known, []);
  assert.deepEqual([next.firstEver, next.added, next.fresh], [false, ['b/two'], ['b/two']]);
  const gone = diffRoutes(cleanRepos([repo('a', 'one')]), next.known, next.fresh);
  assert.deepEqual([gone.added, gone.fresh], [[], []]);
});

test('a repo becomes a City project the building generator understands', () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  const p = repoProject(cleanRepos([repo('deloresai', 'web', { size_kb: 42000, pushed_at: '2026-10-15T00:00:00Z', language: 'TypeScript', permissions: { push: true } })])[0], { now });
  assert.equal(p.id, 'gh:deloresai/web');
  assert.equal(p.url, 'https://github.com/deloresai/web');
  assert.equal(p.visible.city, true);
  assert.equal(p.collab.access, 'Write');
  assert.ok(p.metrics.floors > 5 && p.metrics.floors <= 18);
  const { spots } = layoutIslands(groupIslands(cleanRepos([repo('a', 'x'), repo('b', 'y'), repo('c', 'z')])));
  assert.equal(spots.size, 3);
});

function routeStore(islands, ready = true) {
  const listeners = new Set();
  return {
    desktop: { islands }, sync: { at: ready ? 1 : 0 }, writes: 0,
    updateDesktop(fn) { this.writes++; fn(this.desktop); },
    on(name, fn) { assert.equal(name, 'sync'); listeners.add(fn); return () => listeners.delete(fn); },
    finishLoading(saved) { this.desktop.islands = saved; this.sync.at = 1; for (const fn of [...listeners]) fn(); },
  };
}

const savedRoutes = (user, repos) => ({ user, repos: cleanRepos(repos), known: cleanRepos(repos).map(r => r.full_name.toLowerCase()), fresh: [] });

test('a partial refresh keeps missing repos only for the same account; a complete check removes them', async () => {
  const store = routeStore(savedRoutes('Viewer', [repo('old-org', 'private', { private: true })]));
  let truncated = true;
  const routes = new IslandRoutes({ store, fetch: async () => ({ user: 'VIEWER', repos: [repo('new-org', 'new')], truncated }) });
  const partial = await routes.refresh();
  assert.equal(partial.firstEver, false);
  assert.deepEqual(routes.repos.map(r => r.full_name), ['new-org/new', 'old-org/private']);
  assert.deepEqual(partial.added, ['new-org/new']);
  assert.equal(store.desktop.islands.user, 'viewer');
  truncated = false;
  await routes.refresh({ force: true });
  assert.deepEqual(routes.repos.map(r => r.full_name), ['new-org/new']);
  assert.deepEqual(store.desktop.islands.known, ['new-org/new']);
});

test('switching accounts discards the former account cache even when only one API page succeeded', async () => {
  const saved = savedRoutes('previous-user', [repo('old-org', 'private', { private: true })]);
  saved.fresh = ['old-org/private'];
  const store = routeStore(saved);
  const page = Array.from({ length: 100 }, (_, i) => repo('new-org', `repo-${i}`));
  const routes = new IslandRoutes({ store, fetch: async () => ({ user: 'next-user', repos: page, truncated: true }) });
  const diff = await routes.refresh();
  assert.equal(diff.firstEver, true);
  assert.equal(routes.repos.length, 100);
  assert.equal(routes.island('gh-owner:old-org'), null);
  assert.equal(store.desktop.islands.user, 'next-user');
  assert.equal(store.desktop.islands.known.includes('old-org/private'), false);
  assert.equal(routes.fresh.has('old-org/private'), false);
});

test('a legacy cache with no account is replaced by the first identified partial result', async () => {
  const saved = savedRoutes(undefined, [repo('legacy-org', 'private', { private: true })]);
  const store = routeStore(saved);
  const routes = new IslandRoutes({ store, fetch: async () => ({ user: 'viewer', repos: [repo('current-org', 'repo')], truncated: true }) });
  const diff = await routes.refresh();
  assert.equal(diff.firstEver, true);
  assert.deepEqual(routes.repos.map(r => r.full_name), ['current-org/repo']);
  assert.deepEqual(store.desktop.islands.known, ['current-org/repo']);
  assert.equal(store.desktop.islands.user, 'viewer');
});

test('a delayed desktop load hydrates cached islands before an offline fetch without rewriting saved state', async () => {
  const store = routeStore(undefined, false);
  let fetches = 0;
  const routes = new IslandRoutes({ store, fetch: async () => {
    fetches++;
    assert.deepEqual(routes.repos.map(r => r.full_name), ['saved-org/private']);
    throw new Error('Offline');
  } });
  assert.deepEqual(routes.projects('gh-owner:saved-org'), []);
  const pending = routes.refresh();
  await Promise.resolve();
  assert.equal(fetches, 0);
  assert.equal(store.writes, 0);
  const saved = savedRoutes('viewer', [repo('saved-org', 'private', { private: true })]);
  saved.fresh = ['saved-org/private'];
  store.finishLoading(saved);
  assert.equal(await pending, null);
  assert.equal(fetches, 1);
  assert.equal(routes.error, 'Offline');
  assert.equal(routes.checked, true);
  assert.deepEqual(routes.projects('gh-owner:saved-org').map(p => p.collab.fullName), ['saved-org/private']);
  assert.equal(routes.fresh.has('saved-org/private'), true);
  assert.equal(store.writes, 0);
  assert.equal(store.desktop.islands, saved);
});

test('a response without a valid account cannot replace or claim the saved repository cache', async () => {
  const saved = savedRoutes('viewer', [repo('saved-org', 'private', { private: true })]);
  for (const user of [undefined, '', 'bad/account']) {
    const store = routeStore(saved);
    const routes = new IslandRoutes({ store, fetch: async () => ({ user, repos: [repo('other-org', 'repo')], truncated: true }) });
    assert.equal(await routes.refresh(), null);
    assert.match(routes.error, /identify the signed-in account/);
    assert.deepEqual(routes.repos.map(r => r.full_name), ['saved-org/private']);
    assert.equal(store.desktop.islands, saved);
    assert.equal(store.writes, 0);
  }
});
