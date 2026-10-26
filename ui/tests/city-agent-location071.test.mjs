import test from 'node:test';
import assert from 'node:assert/strict';
import { locateAgents, AGENT_PROJECT_PREF, AGENT_PROJECT_TIME_PREF } from '../app/city/agent-location.js';

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
