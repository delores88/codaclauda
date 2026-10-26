import test from 'node:test';
import assert from 'node:assert/strict';
import { locateAgents, AGENT_PROJECT_PREF, AGENT_PROJECT_TIME_PREF } from '../app/city/agent-location.js';
import { projectForCwd, sessionAgents } from '../app/city/agents-extra.js';

const projects = [
  { id: 'local:alpha', ids: ['local:alpha', 'gh:team/alpha'], path: 'C:/work/alpha', name: 'Alpha' },
  { id: 'local:beta', ids: ['local:beta', 'gh:team/beta'], path: 'C:/work/beta', name: 'Beta' },
];
const a = fields => ({ id: 'board-worker', address: 'board-worker', status: 'idle', ...fields });
const locate = (agent, options = {}) => locateAgents([agent], { projects, now: 2000000000000, ...options });

test('current project beats last known for working, awake and powered-down agents', () => {
  for (const status of ['active', 'idle', 'offline']) {
    const result = locate(a({ status, currentProjectId: 'gh:team/beta' }), { remembered: { 'board-worker': 'local:alpha' } });
    assert.equal(result.agents[0].cityProjectId, 'local:beta');
    assert.equal(result.remembered['board-worker'], 'local:beta');
  }
});

test('canonical location and observation persist through a prefs reload without poll churn', () => {
  const first = locate(a({ currentProjectId: 'gh:team/alpha' }));
  const prefs = JSON.parse(JSON.stringify({ [AGENT_PROJECT_PREF]: first.remembered, [AGENT_PROJECT_TIME_PREF]: first.rememberedAt }));
  const next = locate(a({}), { remembered: prefs[AGENT_PROJECT_PREF], rememberedAt: prefs[AGENT_PROJECT_TIME_PREF] });
  assert.equal(next.agents[0].cityProjectId, 'local:alpha');
  assert.equal(next.agents[0].lastKnownProjectId, 'local:alpha');
  assert.equal(next.changed, false);
});

test('legacy home fallback cannot erase an idle or offline agent last workplace', () => {
  for (const status of ['idle', 'offline']) {
    const result = locate(a({ status, observedProjectId: null, currentProjectId: 'local:alpha', homeProjectId: 'local:alpha' }), {
      remembered: { 'board-worker': 'local:beta' }, rememberedAt: { 'board-worker': 2000000000000 },
    });
    assert.equal(result.agents[0].cityProjectId, 'local:beta');
    assert.equal(result.remembered['board-worker'], 'local:beta');
    assert.equal(result.changed, false);
  }
});

test('production Store work observation survives its offline home fallback and a reload', async () => {
  globalThis.window ||= {};
  globalThis.localStorage ||= { getItem: () => null, setItem() {} };
  const { store } = await import('../app/store.js');
  const known = projects.map(p => ({ ...p, homeAgents: [], aliases: [p.name] }));
  const inputs = { id: 'board-worker', address: 'board-worker', provider: 'codex', kind: 'mailbox', name: 'Worker',
    status: 'active', lastAt: Date.now(), claims: [], involved: [], projects: known, agentPrefs: { 'board-worker': { home: 'local:alpha' } },
    sent: [{ subject: '[Beta] work', body: '', created_at: Math.floor(Date.now() / 1000) }] };
  const observed = store.agentRecord(inputs);
  assert.equal(observed.observedProjectId, 'local:beta');
  const first = locate(observed);
  const prefs = JSON.parse(JSON.stringify(first));
  const offline = store.agentRecord({ ...inputs, status: 'offline', sent: [] });
  assert.equal(offline.currentProjectId, 'local:alpha', 'production legacy field falls back to configured home');
  assert.equal(offline.observedProjectId, null);
  const next = locate(offline, { remembered: prefs.remembered, rememberedAt: prefs.rememberedAt });
  assert.equal(next.agents[0].cityProjectId, 'local:beta');
  assert.equal(next.changed, false);
});

test('an older saved alias becomes the current canonical project id', () => {
  const result = locate(a({}), { remembered: { 'board-worker': 'gh:team/alpha' } });
  assert.equal(result.agents[0].cityProjectId, 'local:alpha');
  assert.equal(result.remembered['board-worker'], 'local:alpha');
});

test('hidden or deleted saved projects fall back to HQ, keeping memory for an unhide', () => {
  for (const remembered of [{ 'board-worker': 'local:beta' }, { 'board-worker': 'local:deleted' }]) {
    const result = locate(a({ homeProjectId: 'local:alpha' }), { visibleProjects: [projects[0]], remembered });
    assert.equal(result.agents[0].cityProjectId, null);
    assert.deepEqual(result.remembered, remembered);
  }
  assert.equal(locate(a({}), { remembered: { 'board-worker': 'local:beta' } }).agents[0].cityProjectId, 'local:beta');
});

test('unknown agents use HQ and never create an empty saved entry', () => {
  const result = locate(a({ currentProjectId: 'missing' }));
  assert.equal(result.agents[0].cityProjectId, null);
  assert.deepEqual(result.remembered, {});
});

test('session cwd resolves the deepest project and persists by its mailbox address', () => {
  const result = locate({ id: 'sess:session-a', kind: 'session', sessionId: 'session-a' }, {
    sessions: [{ id: 'session-a', mailboxAddress: 'session-worker', cwd: 'C:/work/beta/src', lastActivityAt: 2000000000000 }],
  });
  assert.equal(result.agents[0].cityProjectId, 'local:beta');
  assert.equal(result.remembered['session-worker'], 'local:beta');
  assert.equal(result.agents[0].address, 'session-worker');
});

test('subfolders and nested worktrees resolve the canonical parent with path boundaries', () => {
  const aliases = [{ ...projects[0], ids: [...projects[0].ids, 'local:D:/checkouts/alpha'] }, projects[1]];
  for (const cwd of ['C:/work/alpha/src', 'C:/work/alpha/local/worktrees/071-talk/ui',
    '\\\\?\\C:\\WORK\\ALPHA\\local\\worktrees\\review\\ui', 'd:/checkouts/alpha/local/worktrees/review']) {
    assert.equal(projectForCwd(aliases, cwd)?.id, 'local:alpha', cwd);
  }
  assert.equal(projectForCwd(aliases, 'C:/work/alphabet/src'), null, 'a shared path prefix is not a parent');
  const nested = { id: 'nested', name: 'Nested', path: 'C:/work/alpha/vendor/nested' };
  assert.equal(projectForCwd([...aliases, nested], `${nested.path}/src`)?.id, nested.id, 'a separately linked deeper project still owns its folder');
});

test('worktree-only session and turn or assignment folders recover known projects', () => {
  const session = { id: 'tree-session', status: 'idle', provider: 'codex', worktreePath: 'C:/work/alpha/local/worktrees/review',
    mailboxAddress: 'tree-worker', lastActivityAt: 2000000000000 };
  const [managed] = sessionAgents([session], projects);
  assert.equal(managed.currentProjectId, 'local:alpha');
  assert.equal(managed.cwd, session.worktreePath);
  const result = locateAgents([managed], { projects, sessions: [session] });
  assert.equal(result.agents[0].cityProjectId, 'local:alpha');
  assert.equal(result.remembered['tree-worker'], 'local:alpha');
  for (const fields of [
    { worktreePath: session.worktreePath },
    { lastTurn: { cwd: 'C:/work/alpha/src', at: 2000000000000 } },
    { lastAssignment: { workspace: 'C:/work/alpha/local/worktrees/assigned', at: 2000000000000 } },
    { lastTurn: { cwd: 'C:/unlinked-folder', worktreePath: session.worktreePath, at: 2000000000000 } },
  ]) assert.equal(locate(a(fields)).agents[0].cityProjectId, 'local:alpha');
});

test('exact workspace or worktree folders outrank another path basename guess', () => {
  const cwd = 'C:/unlinked/beta', worktreePath = 'C:/work/alpha/local/worktrees/review';
  assert.equal(projectForCwd(projects, cwd)?.id, 'local:beta', 'single-path legacy name hints still work');
  const session = { id: 'exact-tree', status: 'idle', provider: 'codex', cwd, worktreePath };
  assert.equal(sessionAgents([session], projects)[0].currentProjectId, 'local:alpha');
  assert.equal(locate(a({ cwd, worktreePath })).agents[0].cityProjectId, 'local:alpha');
  assert.equal(locate(a({ cwd, workspace: worktreePath })).agents[0].cityProjectId, 'local:alpha');
  assert.equal(locate(a({ lastAssignment: { cwd, worktreePath } })).agents[0].cityProjectId, 'local:alpha');
  assert.equal(locate({ id: 'sess:exact-tree', sessionId: session.id }, { sessions: [session] }).agents[0].cityProjectId, 'local:alpha');
  assert.equal(sessionAgents([{ ...session, cwd: 'C:/work/beta/src' }], projects)[0].currentProjectId, 'local:beta', 'exact cwd retains precedence over exact worktree');
});

test('production dedicated endpoints retain nested workspace metadata for City placement', async () => {
  globalThis.window ||= {};
  globalThis.localStorage ||= { getItem: () => null, setItem() {} };
  const { store } = await import('../app/store.js');
  const known = projects.map(p => ({ ...p, aliases: [p.name], homeAgents: [] }));
  const now = Math.floor(Date.now() / 1000);
  const host = { mailboxMessages: [], addresses: [], desktop: { agents: {} }, claims: [],
    board: { endpoints: [{ id: 'nested-endpoint', agent: 'codex', workspace: 'C:/work/alpha/local/worktrees/review/ui' }],
      requests: [{ target: 'nested-endpoint', state: 'running', updated_at: now }] },
    agentRecord: store.agentRecord, matchProject: () => null };
  const records = store.computeAgents.call(host, known);
  assert.equal(records.length, 1);
  assert.equal(records[0].cwd, host.board.endpoints[0].workspace);
  assert.equal(records[0].currentProjectId, null, 'the legacy exact-project field is unchanged');
  const result = locateAgents(records, { projects: known });
  assert.equal(result.agents[0].cityProjectId, 'local:alpha');
  assert.deepEqual(result.remembered, { 'endpoint:nested-endpoint': 'local:alpha' });
  assert.ok(!JSON.stringify(result.remembered).includes('/worktrees/'), 'preferences retain only canonical ids');
});

test('newest dated turn, assignment or board signal wins and retained old history cannot undo it', () => {
  const result = locate(a({ lastTurn: { projectId: 'local:alpha', at: 2000000001000 } }), {
    remembered: { 'board-worker': 'local:alpha' }, rememberedAt: { 'board-worker': 2000000000000 },
    assignments: [{ agentId: 'board-worker', projectId: 'gh:team/beta', at: 2000000002000 }],
    messages: [{ from: 'board-worker', projectId: 'local:alpha', created_at: 1999999900000 }],
  });
  assert.equal(result.agents[0].cityProjectId, 'local:beta');
  assert.equal(result.rememberedAt['board-worker'], 2000000002000);
  const repeat = locate(a({}), { remembered: result.remembered, rememberedAt: result.rememberedAt,
    messages: [{ from: 'board-worker', projectId: 'local:alpha', created_at: 1999999900000 }] });
  assert.equal(repeat.agents[0].cityProjectId, 'local:beta');
  assert.equal(repeat.changed, false);
});

test('board-history inference is scoped to the agent address and stores no prose', () => {
  const result = locate(a({}), {
    messages: [{ from: 'someone-else', body: 'Beta', created_at: 2000000002000 }, { to: 'board-worker', body: 'Alpha', created_at: 2000000001000 }],
    matchProject: text => projects.find(p => text.includes(p.name)),
  });
  assert.equal(result.agents[0].cityProjectId, 'local:alpha');
  assert.deepEqual(result.remembered, { 'board-worker': 'local:alpha' });
});

test('a session and its board address cannot cause redundant preference writes', () => {
  const options = { projects, now: 2000000000000,
    sessions: [{ id: 'session-a', mailboxAddress: 'board-worker', projectId: 'local:beta' }],
    remembered: { 'board-worker': 'local:beta' }, rememberedAt: { 'board-worker': 1999999990000 } };
  const result = locateAgents([a({ currentProjectId: 'local:alpha' }),
    { id: 'sess:session-a', sessionId: 'session-a', currentProjectId: 'local:beta' }], options);
  assert.deepEqual(result.remembered, options.remembered);
  assert.equal(result.changed, false);
});
