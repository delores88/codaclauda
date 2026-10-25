import assert from 'node:assert/strict';
import test from 'node:test';
import { projectForCwd, sessionAgents, externalAgents, ciSummary, newlyPassed, repoOf } from '../app/city/agents-extra.js';
import { planAssign } from '../app/city/assign.js';
import { avatarFromReply, firstJsonBlock } from '../app/avatar/agent-design.js';

const projects = [
  { id: 'local:coda', ids: ['local:coda', 'gh:delores88/codaclauda'], name: 'CodaClauda', path: 'C:\\Users\\Benny\\OneDrive\\Desktop\\CodaClauda', repo: { full_name: 'Delores88/CodaClauda', default_branch: 'main' } },
  { id: 'gh:delores88/site', ids: ['gh:delores88/site'], name: 'site', path: '' },
];

test('zero-config agents: sessions keep an explicit status, desktop sessions are metadata only and deduped', () => {
  assert.equal(projectForCwd(projects, 'c:/users/benny/onedrive/desktop/codaclauda/src-tauri')?.id, 'local:coda');
  const own = sessionAgents([
    { id: 's1', provider: 'claude', projectId: 'local:coda', cwd: projects[0].path, status: 'running', title: 'Fix the build', lastActivityAt: Date.now() },
    { id: 's2', provider: 'codex', cwd: projects[0].path, status: 'error', lastActivityAt: 1 },
    { id: 's3', provider: 'codex', cwd: projects[0].path, status: 'stopped' },
  ], projects, { projectOf: id => projects.find(p => p.id === id) || null });
  assert.deepEqual(own.map(a => [a.id, a.status, a.currentProjectId]), [['sess:s1', 'active', 'local:coda'], ['sess:s2', 'error', 'local:coda']]);
  const ext = externalAgents([
    { provider: 'claude', cwd: 'C:\\Users\\Benny\\OneDrive\\Desktop\\CodaClauda', modifiedAt: Date.now(), active: true },   // the CodaClauda session itself
    { provider: 'codex', cwd: 'C:\\Users\\Benny\\OneDrive\\Desktop\\CodaClauda', modifiedAt: Date.now(), active: true },
    { provider: 'codex', cwd: 'C:/Users/Benny/OneDrive/Desktop/CodaClauda/', modifiedAt: Date.now() - 1000, active: true },
    { provider: 'claude', cwd: 'D:/elsewhere', modifiedAt: Date.now(), active: false },
  ], projects, { own: [{ provider: 'claude', cwd: projects[0].path, lastActivityAt: Date.now() }] });
  assert.deepEqual(ext.map(a => [a.name, a.currentProjectId, a.count]), [['Codex (desktop)', 'local:coda', 2]]);
});

test('ambient CI: failed latest run status, fireworks only for a new green default-branch run', () => {
  assert.equal(repoOf(projects[0]), 'Delores88/CodaClauda');
  assert.equal(repoOf({ stats: { git: { remote: 'git@github.com:owner/thing.git' } } }), 'owner/thing');
  const failing = ciSummary([{ status: 'completed', conclusion: 'failure', branch: 'feature', at: '2026-10-20T10:00:00Z' }, { status: 'completed', conclusion: 'success', branch: 'main', at: '2026-10-20T09:00:00Z', url: 'u1' }], 'main');
  assert.equal(failing.failing, true);
  assert.equal(newlyPassed(undefined, failing), false);   // first poll: baseline only
  const green = ciSummary([{ status: 'completed', conclusion: 'success', branch: 'main', at: '2026-10-20T11:00:00Z', url: 'u2' }], 'main');
  assert.equal(newlyPassed(failing.key, green), true);
  assert.equal(newlyPassed(green.key, green), false);
});

test('drag to assign: the open chat on that project, else a new one where the project has a folder', () => {
  const list = [{ id: 's1', provider: 'claude', projectId: 'local:coda', status: 'idle', lastActivityAt: 5 }];
  assert.equal(planAssign({ kind: 'mailbox', provider: 'claude' }, projects[0], list).existing?.id, 's1');
  const remote = planAssign({ kind: 'external', provider: 'codex' }, projects[1], list);
  assert.equal(remote.existing, null);
  assert.equal(remote.canStart, false);
});

test('agent-built avatar: the first JSON block is read, a bad reply is an error', () => {
  const ok = avatarFromReply('Here you go:\n```json\n{"hair":{"style":"curly","color":"#c44b2b"},"top":{"style":"hoodie","color":"#12a883"},"skin":"#d9a07c","accessory":"laser"}\n```\nEnjoy!');
  assert.equal(ok.spec.hair.style, 'curly');
  assert.equal(ok.spec.accessory, 'none');   // unknown values fall back
  assert.ok(avatarFromReply('I cannot do that.').error);
  assert.ok(avatarFromReply('```json\n{ nope \n```').error);
  assert.ok(avatarFromReply('```json\n{"hello": 1}\n```').error);
  assert.deepEqual(firstJsonBlock('first {"a": {"b": "}"}} then {"c": 2}').value, { a: { b: '}' } });
});
