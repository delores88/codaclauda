import test from 'node:test';
import assert from 'node:assert/strict';
import { githubIdentity } from '../app/github-identity.js';

globalThis.window = {};
const { store: singleton } = await import('../app/store.js');

test('SSH, SCP, git and HTTPS remotes normalize exactly, including dotted names and case', () => {
  for (const remote of ['git@github.com:Owner/Repo.Name.git', 'ssh://git@github.com/Owner/Repo.Name.git', 'ssh://git@github.com:22/Owner/Repo.Name', 'https://GITHUB.COM/Owner/Repo.Name.git/', 'https://github.com/OWNER/REPO.NAME', 'git://github.com/Owner/Repo.Name.git']) {
    assert.equal(githubIdentity(remote), 'gh:owner/repo.name', remote);
  }
  assert.equal(githubIdentity('Owner/Repo.Name', { allowSlug: true }), 'gh:owner/repo.name');
  assert.equal(githubIdentity('gh:OWNER/Repo.Name', { allowSlug: true }), 'gh:owner/repo.name');
  assert.equal(githubIdentity('Owner/Repo.Name'), null);
  assert.notEqual(githubIdentity('git@github.com:fork/Repo.Name.git'), githubIdentity('git@github.com:upstream/Repo.Name.git'));
});

test('lookalike hosts, extra paths, malformed names and non-GitHub remotes never become GitHub aliases', () => {
  for (const remote of ['https://github.com.evil.invalid/owner/repo', 'https://example.com/github.com/owner/repo', 'git@notgithub.com:owner/repo', 'https://github.com/owner/repo/tree/main', 'https://github.com/owner/repo?foo=bar', 'https://github.com/owner/repo#readme', 'file://github.com/owner/repo', 'C:/projects/repo', 'https://github.com/owner/%2frepo', 'https://github.com/owner/..', '', null, {}]) {
    assert.equal(githubIdentity(remote), null, String(remote));
  }
});

test('dotted SSH remotes merge only their exact fetched repo and retain the known local path and alias', () => {
  const store = new singleton.constructor();
  store.desktop.projects.local = [{ path: 'C:/repo', name: 'Local', stats: { git: { remote: 'ssh://git@github.com/Owner/Repo.Name.git' } } }];
  store.desktop.projects.github = { user: 'Owner', repos: [
    { full_name: 'OWNER/REPO.NAME', name: 'Repo.Name' }, { full_name: 'fork/Repo.Name', name: 'Repo.Name' },
  ] };
  const projects = store.computeProjects();
  assert.equal(projects.length, 2);
  const local = projects.find(p => p.path === 'C:/repo');
  assert.equal(local.id, 'local:c:/repo'); assert.equal(local.source, 'both');
  assert.deepEqual(local.ids, ['local:c:/repo', 'gh:owner/repo.name']);
  const fork = projects.find(p => p.id === 'gh:fork/repo.name'); assert.equal(fork.path, '');
});

test('manifest aliases never hide a known local path, regardless of row order or scan availability', () => {
  for (const reverse of [false, true]) {
    const store = new singleton.constructor();
    const rows = [{ name: 'Remote', github: 'Owner/Repo.Name' }, { name: 'Local', local_path: 'C:/repo', github: 'owner/repo.name' }];
    store.manifest = { projects: reverse ? rows.reverse() : rows };
    const projects = store.computeProjects(); assert.equal(projects.length, 1);
    assert.equal(projects[0].path, 'C:/repo'); assert.equal(projects[0].id, 'local:c:/repo');
    assert.ok(projects[0].ids.includes('gh:owner/repo.name'));
  }
});

test('two local clones keep distinct paths while sharing the exact repository alias', () => {
  const store = new singleton.constructor();
  store.desktop.projects.local = ['a', 'b'].map(name => ({ path: `C:/${name}`, name, stats: { git: { remote: 'git@github.com:Owner/Repo.git' } } }));
  store.manifest = { projects: [{ name: 'A', local_path: 'C:/a', github: 'OWNER/REPO' }, { name: 'B', local_path: 'C:/b', github: 'owner/repo' }] };
  store.desktop.projects.github = { user: 'owner', repos: [{ name: 'Repo', full_name: 'owner/repo' }] };
  const projects = store.computeProjects(); assert.equal(projects.length, 2);
  assert.deepEqual(new Set(projects.map(p => p.path)), new Set(['C:/a', 'C:/b']));
  for (const p of projects) assert.ok(p.ids.includes('gh:owner/repo'));
});
