import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRepos, groupIslands, diffRoutes, repoProject, layoutIslands } from '../app/islands.js';

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
