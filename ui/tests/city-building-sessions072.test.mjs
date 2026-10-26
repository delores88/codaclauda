import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildingSessionLaunch, buildingProviders, offersBuildingSession } from '../app/city/building-actions.js';
import { startProjectSession } from '../app/session-start.js';

const project = { id: 'local:c:/sample/project', name: 'Sample', path: 'C:/sample/project' };
const found = ['claude', 'codex'].map(agent => ({ agent, executable: `${agent}.exe`, supported: true, authenticated: true }));
const store = { projectAccess: () => ({ level: 'read', playwright: true }) };

test('new sessions are offered only for real local buildings on This PC', () => {
  assert.equal(offersBuildingSession(project), true);
  assert.equal(offersBuildingSession({ ...project, ids: [project.id, 'gh:owner/sample'], source: 'both' }), true);
  for (const [candidate, context] of [
    [null, {}], [{ id: 'gh:owner/sample', path: '' }, {}], [{ ...project, path: ' ' }, {}],
    [project, { side: 'spark' }], [project, { remote: true }],
  ]) assert.equal(offersBuildingSession(candidate, context), false);
});

test('provider choices require installed, supported, explicitly authenticated CLIs', () => {
  assert.deepEqual(buildingProviders(found).map(p => p.available), [true, true]);
  const cases = [
    [[], /not installed/],
    [[{ ...found[0], authenticated: false }], /Sign in/],
    [[{ ...found[0], authenticated: undefined }], /Sign in/],
    [[{ ...found[0], supported: false }], /Update/],
    [[{ ...found[0], executable: '' }], /not installed/],
  ];
  for (const [candidates, reason] of cases) {
    const claude = buildingProviders(candidates)[0];
    assert.equal(claude.available, false); assert.match(claude.reason, reason);
  }
  assert.equal(buildingProviders([{ ...found[0], executable: '', path: 'claude.exe' }])[0].available, true);
});

test('unknown, checking, failed discovery and missing session support fail closed', () => {
  for (const phase of ['idle', 'checking', 'error']) {
    assert.equal(buildingProviders(found, phase).some(p => p.available), false);
    assert.ok(buildingProviders(found, phase).every(p => p.reason));
  }
  for (const availability of [false, null]) assert.equal(buildingProviders(found, 'ready', availability).some(p => p.available), false);
});

test('shared start helper preserves exact project and current saved access through existing start path', async () => {
  const calls = [], sessions = { start: async options => { calls.push(options); return { id: 'new', ...options }; } };
  let level = 'read';
  const accessStore = { projectAccess: id => { assert.equal(id, project.id); return { level, playwright: true }; } };
  await startProjectSession(accessStore, sessions, 'codex', project);
  assert.deepEqual(calls[0], { projectId: project.id, cwd: project.path, access: 'read', playwright: false, provider: 'codex', title: 'Codex · Sample' });
  level = 'full';
  await startProjectSession(accessStore, sessions, 'claude', project, { title: 'Title', model: 'sonnet', effort: 'high', worktree: true });
  assert.deepEqual(calls[1], { projectId: project.id, cwd: project.path, access: 'full', playwright: false, provider: 'claude', title: 'Title', model: 'sonnet', effort: 'high', worktree: true });
});

test('invalid local project, provider or access never reaches start', async () => {
  const sessions = { start: () => { assert.fail('start must not be called'); } };
  await assert.rejects(startProjectSession(store, sessions, 'other', project), /Choose Claude or Codex/);
  await assert.rejects(startProjectSession(store, sessions, 'codex', { ...project, path: '' }), /local folder/);
  await assert.rejects(startProjectSession({ projectAccess: () => ({}) }, sessions, 'codex', project), /access is unavailable/);
});

test('start opens the conversation before optional first prompt, and an empty prompt starts no turn', async () => {
  const events = [], sessions = { start: async () => { events.push('start'); return { id: 'a' }; }, send: async (id, text) => events.push(['send', id, text]) };
  const launch = new BuildingSessionLaunch({ store, sessions, onStarted: session => events.push(['open', session.id]) });
  await launch.start('codex', project, '  Work here  ');
  assert.deepEqual(events, ['start', ['open', 'a'], ['send', 'a', 'Work here']]);
  events.length = 0;
  await launch.start('claude', project, '  ');
  assert.deepEqual(events, ['start', ['open', 'a']]);
});

test('repeated clicks while start is pending reuse the same launch', async () => {
  let finish, starts = 0;
  const sessions = { start: () => { starts++; return new Promise(resolve => { finish = resolve; }); } };
  const launch = new BuildingSessionLaunch({ store, sessions });
  const first = launch.start('codex', project);
  assert.equal(launch.start('claude', project), first);
  assert.equal(starts, 1);
  finish({ id: 'a' }); await first;
  assert.equal(launch.pending, null);
});

test('a failed first send preserves session identity and draft, and retry sends without a second start', async () => {
  let fail = true, starts = 0;
  const sends = [], opens = [];
  const sessions = { start: async () => { starts++; return { id: 'a' }; }, send: async (...args) => { sends.push(args); if (fail) throw new Error('Unavailable'); } };
  const launch = new BuildingSessionLaunch({ store, sessions, onStarted: (session, meta) => opens.push([session.id, { ...meta }]) });
  const record = await launch.start('codex', project, 'Keep this prompt');
  assert.equal(record.session.id, 'a'); assert.equal(record.prompt, 'Keep this prompt'); assert.match(record.error, /Unavailable/);
  assert.equal(opens.length, 2); assert.match(opens[1][1].sendError, /Unavailable/);
  await launch.start('codex', project, 'A duplicate click');
  assert.equal(starts, 1);
  fail = false; await launch.retry(project.id);
  assert.equal(starts, 1); assert.deepEqual(sends, [['a', 'Keep this prompt'], ['a', 'Keep this prompt']]);
  assert.equal(launch.recovery.size, 0); assert.equal(record.prompt, ''); assert.equal(record.error, '');
});

test('opening failure is separate from native start and keeps the existing session recoverable', async () => {
  let starts = 0;
  const sessions = { start: async () => { starts++; return { id: 'a' }; }, send: async () => {} };
  const launch = new BuildingSessionLaunch({ store, sessions, onStarted: () => { throw new Error('UI unavailable'); } });
  const record = await launch.start('claude', project, 'First prompt');
  assert.equal(record.error, ''); assert.match(record.openError, /UI unavailable/); assert.equal(record.session.id, 'a');
  await launch.start('claude', project);
  assert.equal(starts, 1); assert.equal(launch.recovery.get(project.id), record);
});

test('native start refusal preserves no fictitious session and allows a later explicit attempt', async () => {
  let starts = 0;
  const launch = new BuildingSessionLaunch({ store, sessions: { start: async () => { starts++; throw new Error('Project revoked'); } } });
  await assert.rejects(launch.start('claude', project), /Project revoked/);
  assert.equal(launch.pending, null); assert.equal(launch.recovery.size, 0);
  await assert.rejects(launch.start('claude', project), /Project revoked/);
  assert.equal(starts, 2);
});

test('starting callback receives project and provider immediately before native start, once per launch', async () => {
  const events = [];
  let finish, nested, launch;
  launch = new BuildingSessionLaunch({
    store,
    sessions: { start: () => { events.push('native'); return new Promise(resolve => { finish = resolve; }); } },
    onStarting: info => { events.push(info); nested = launch.start('claude', project); },
  });
  const first = launch.start('codex', project);
  assert.equal(nested, first);
  assert.deepEqual(events, [{ provider: 'codex', project }, 'native']);
  finish({ id: 'a' }); await first;
});

test('presentation promises never delay native start or the first prompt', async () => {
  let finishOpening;
  const events = [];
  const launch = new BuildingSessionLaunch({
    store,
    sessions: { start: async () => { events.push('native'); return { id: 'a' }; }, send: async () => events.push('send') },
    onStarting: () => new Promise(() => {}),
    onStarted: () => new Promise(resolve => { finishOpening = resolve; }),
  });
  const record = await launch.start('codex', project, 'Work');
  assert.deepEqual(events, ['native', 'send']);
  assert.equal(launch.pending, null);
  assert.equal(record.opening, true);
  finishOpening(); await Promise.resolve();
  assert.equal(record.opening, false);
  assert.equal(launch.recovery.size, 0);
});

test('failed start callback preserves the original native error despite presentation exceptions', async () => {
  const refusal = new Error('Project revoked'), failures = [];
  let starts = 0;
  const launch = new BuildingSessionLaunch({
    store, sessions: { start: async () => { starts++; throw refusal; } },
    onStarting: () => { throw new Error('Pending UI unavailable'); },
    onStartFailed: error => { failures.push(error); return Promise.reject(new Error('Error UI unavailable')); },
  });
  await assert.rejects(launch.start('claude', project), error => error === refusal);
  assert.deepEqual(failures, [refusal]);
  assert.equal(starts, 1); assert.equal(launch.recovery.size, 0); assert.equal(launch.pending, null);
});

test('late conversation failure recovers the created session without repeating native work', async () => {
  let failOpening, starts = 0;
  const failures = [];
  const launch = new BuildingSessionLaunch({
    store, sessions: { start: async () => { starts++; return { id: 'a' }; }, send: async () => {} },
    onStarted: () => new Promise((_, reject) => { failOpening = reject; }), onStartFailed: error => failures.push(error),
  });
  const record = await launch.start('codex', project, 'Work');
  failOpening(new Error('Conversation unavailable')); await Promise.resolve();
  assert.match(record.openError, /Conversation unavailable/);
  await launch.start('codex', project);
  assert.equal(starts, 1); assert.deepEqual(failures, []);
  assert.equal(launch.recovery.get(project.id).session.id, 'a');
});
