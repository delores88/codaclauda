import test from 'node:test';
import assert from 'node:assert/strict';
import { desktop } from '../app/bridge.js';
import { cloneAndLinkRepo } from '../app/github-accounts.js';

globalThis.window = {};
globalThis.localStorage = { getItem: () => null, setItem() {} };
const { store: singleton } = await import('../app/store.js');
const repo = (owner, name = 'api') => ({ name, full_name: `${owner}/${name}` });
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  t.mock.method(desktop, 'saveState', async () => ({}));
  t.mock.method(desktop, 'githubRepos', async user => ({ user, repos: [] }));
  const store = new singleton.constructor();
  store.desktop.projects.github = { user: 'main', repos: [repo('main')] };
  store.desktop.projects.githubAccounts = [{ user: 'extra', repos: [repo('extra'), repo('extra', 'kept')] }];
  return store;
}

test('main and extra clone requests bind the selected account even if another account is active', async () => {
  const calls = [], linked = [];
  const bridge = { desktop: { cloneRepo: async args => { calls.push(args); return { path: `C:/clones/${args.account}/api` }; } } };
  const store = { linkFolder: async path => linked.push(path) };
  for (const account of ['main', 'extra']) {
    await cloneAndLinkRepo({ store, bridge, repo: repo(account), parentDir: `C:/clones/${account}`, account, row: {} });
  }
  assert.deepEqual(calls.map(call => call.account), ['main', 'extra']);
  assert.deepEqual(linked, ['C:/clones/main/api', 'C:/clones/extra/api']);
});

test('clone refusal never links an arbitrary existing or partial folder', async () => {
  for (const code of ['FOLDER_EXISTS', 'GH_ACCOUNT_UNAVAILABLE']) {
    let linkCalls = 0;
    const row = {};
    const bridge = { desktop: { cloneRepo: async () => { throw Object.assign(new Error(code), { code }); } } };
    await assert.rejects(cloneAndLinkRepo({ store: { linkFolder: async () => { linkCalls++; } }, bridge, repo: repo('extra'), parentDir: 'C:/clones', account: 'extra', row }), { code });
    assert.equal(linkCalls, 0);
    assert.equal(row.path, undefined);
  }
});

test('failed linking preserves the successful clone path and retry never clones again', async () => {
  let cloneCalls = 0;
  const paths = [], row = {};
  const bridge = { desktop: { cloneRepo: async () => { cloneCalls++; return { path: 'C:/exact-clone/api' }; } } };
  const store = { linkFolder: async path => { paths.push(path); if (paths.length === 1) throw new Error('scan failed'); } };
  const input = { store, bridge, repo: repo('extra'), parentDir: 'C:/exact-clone', account: 'extra', row };
  await assert.rejects(cloneAndLinkRepo(input), /scan failed/);
  assert.equal(row.path, 'C:/exact-clone/api');
  // Folder preference may change while recovery is pending; retry retains the admitted path.
  await cloneAndLinkRepo({ ...input, parentDir: 'D:/new-choice' });
  assert.equal(cloneCalls, 1);
  assert.deepEqual(paths, ['C:/exact-clone/api', 'C:/exact-clone/api']);
});

test('extra-account project unlink and Undo restore exact owner entries once', t => {
  const store = fixture(t);
  const beforeSettings = { 'gh:extra/api': { name: 'Custom name', city: false } };
  store.desktop.projects.settings = beforeSettings;
  const removed = store.unlinkProject(store.projects.find(p => p.id === 'gh:extra/api'));
  assert.deepEqual(store.projects.map(p => p.id).sort(), ['gh:extra/kept', 'gh:main/api']);
  store.restoreProjectLinks(removed);
  store.restoreProjectLinks(removed);
  assert.deepEqual(store.projects.map(p => p.id).sort(), ['gh:extra/api', 'gh:extra/kept', 'gh:main/api']);
  assert.equal(store.desktop.projects.githubAccounts[0].repos.length, 2);
  assert.equal(store.desktop.projects.settings, beforeSettings);
  assert.equal(store.projects.find(p => p.id === 'gh:extra/api').name, 'Custom name');
});

test('local-plus-extra project unlink removes both links without changing another account', t => {
  const store = fixture(t);
  store.desktop.projects.local = [{ path: 'C:/code/api', name: 'api', stats: { git: { remote: 'https://github.com/extra/api.git' } } }];
  const project = store.projects.find(p => p.path === 'C:/code/api');
  const removed = store.unlinkProject(project);
  assert.equal(store.desktop.projects.local.length, 0);
  assert.deepEqual(store.desktop.projects.githubAccounts[0].repos.map(r => r.full_name), ['extra/kept']);
  assert.deepEqual(store.desktop.projects.github.repos.map(r => r.full_name), ['main/api']);
  store.restoreProjectLinks(removed);
  assert.equal(store.projects.find(p => p.ids.includes('gh:extra/api')).path, 'C:/code/api');
});

test('project Undo cannot recreate an account removed after unlink', t => {
  const store = fixture(t);
  const removed = store.unlinkProject(store.projects.find(p => p.id === 'gh:extra/api'));
  store.removeGithubAccount('extra');
  store.restoreProjectLinks(removed);
  assert.equal(store.desktop.projects.githubAccounts.length, 0);
  assert.deepEqual(store.projects.map(p => p.id), ['gh:main/api']);
});

test('an extra-account refresh cannot resurrect its removed account', async t => {
  const store = fixture(t), pending = deferred();
  desktop.githubRepos.mock.mockImplementation(() => pending.promise);
  const refresh = store.linkGithubAccount('extra');
  store.removeGithubAccount('extra');
  pending.resolve({ user: 'extra', repos: [repo('extra', 'late')] }); await refresh;
  assert.equal(store.desktop.projects.githubAccounts.length, 0);
});

test('only the latest extra-account refresh can replace inventory', async t => {
  const store = fixture(t), old = deferred(), recent = deferred();
  let calls = 0;
  desktop.githubRepos.mock.mockImplementation(() => ++calls === 1 ? old.promise : recent.promise);
  const first = store.linkGithubAccount('extra'), second = store.linkGithubAccount('extra');
  recent.resolve({ user: 'extra', repos: [repo('extra', 'recent')] }); await second;
  old.resolve({ user: 'extra', repos: [repo('extra', 'old')] }); await first;
  assert.deepEqual(store.desktop.projects.githubAccounts[0].repos.map(r => r.name), ['recent']);
});

test('pending extra-account refresh cannot restore a project explicitly unlinked', async t => {
  const store = fixture(t), pending = deferred();
  desktop.githubRepos.mock.mockImplementation(() => pending.promise);
  const refresh = store.linkGithubAccount('extra');
  store.unlinkProject(store.projects.find(p => p.id === 'gh:extra/api'));
  pending.resolve({ user: 'extra', repos: [repo('extra')] }); await refresh;
  assert.deepEqual(store.desktop.projects.githubAccounts[0].repos.map(r => r.name), ['kept']);
});

test('remove then explicitly re-add an account rejects the old in-flight inventory', async t => {
  const store = fixture(t), old = deferred(), recent = deferred();
  let calls = 0;
  desktop.githubRepos.mock.mockImplementation(() => ++calls === 1 ? old.promise : recent.promise);
  const first = store.linkGithubAccount('extra');
  store.removeGithubAccount('extra');
  const second = store.linkGithubAccount('extra');
  recent.resolve({ user: 'extra', repos: [repo('extra', 'readded')] }); await second;
  old.resolve({ user: 'extra', repos: [repo('extra', 'old')] }); await first;
  assert.deepEqual(store.desktop.projects.githubAccounts[0].repos.map(r => r.name), ['readded']);
});
