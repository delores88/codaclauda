import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildingSessionActions, BuildingSessionLaunch, buildingProviders, offersBuildingSession } from '../app/city/building-actions.js';
import { startProjectSession } from '../app/session-start.js';

const project = { id: 'local:c:/sample/project', name: 'Sample', path: 'C:/sample/project' };
const store = { projectAccess: () => ({ level: 'read', playwright: true }) };

// Exercise the component's real refresh/start methods with only their DOM property surface.
function actionState(candidate, sessions) {
  const actions = Object.assign(Object.create(BuildingSessionActions.prototype), {
    project: candidate, context: { side: 'pc', remote: false }, sessions,
    store: { ...store, project: id => id === candidate.id ? candidate : null, agents: [{ id: 'busy-agent', status: 'active', currentProjectId: candidate.id }] },
    error: '', destroyed: false,
    node: { hidden: true }, buttons: ['claude', 'codex'].map(provider => ({ hidden: false, dataset: { provider } })),
    access: {}, hint: {}, errorNode: {}, recoveryNode: {}, onStateChange: () => {},
  });
  actions.launch = new BuildingSessionLaunch({ store: actions.store, sessions, onChange: () => actions.refresh() });
  return actions;
}

test('new sessions are offered only for real local buildings on This PC', () => {
  assert.equal(offersBuildingSession(project), true);
  assert.equal(offersBuildingSession({ ...project, ids: [project.id, 'gh:owner/sample'], source: 'both' }), true);
  for (const [candidate, context] of [
    [null, {}], [{ id: 'gh:owner/sample', path: '' }, {}], [{ ...project, path: ' ' }, {}],
    [project, { side: 'spark' }], [project, { remote: true }],
  ]) assert.equal(offersBuildingSession(candidate, context), false);
});

test('both provider choices use managed session availability without claiming CLI detection', () => {
  assert.deepEqual(buildingProviders(true).map(p => [p.id, p.available, p.reason]), [
    ['claude', true, ''], ['codex', true, ''],
  ]);
});

test('unknown and unavailable managed session support disable both choices and starts', async () => {
  for (const available of [false, null, undefined]) {
    const actions = actionState(project, { available, start: () => assert.fail('Unavailable engine cannot start') });
    actions.refresh();
    assert.ok(actions.buttons.every(button => button.disabled && button.title));
    await actions.start('claude');
    await actions.start('codex');
  }
});

test('occupied and busy local projects retain the visible New session block and both ready providers', () => {
  const running = { id: 'already-running', projectId: project.id, provider: 'claude', status: 'running' };
  for (const status of ['idle', 'active', 'busy']) {
    const candidate = { ...project, status, agents: ['busy-agent'], metrics: { running: 2 } };
    const actions = actionState(candidate, { available: true, list: [running], running: () => true });
    assert.equal(offersBuildingSession(candidate, actions.context), true);
    actions.refresh();
    assert.equal(actions.node.hidden, false);
    assert.deepEqual(actions.buttons.map(button => [button.dataset.provider, button.hidden, button.disabled]), [
      ['claude', false, false], ['codex', false, false],
    ]);
  }
});

test('missing legacy Claude discovery cannot veto an explicit blank managed session', async () => {
  const starts = [], opens = [], sends = [];
  const actions = actionState({ ...project, status: 'busy' }, {
    available: true,
    start: async options => { starts.push(options); return { id: 'managed-claude', ...options }; },
    send: async (...args) => sends.push(args),
  });
  // The old board adapter may see only Codex; it is not the managed resolver.
  actions.found = [
    { agent: 'codex', executable: 'codex.exe', supported: true, authenticated: true },
    { agent: 'claude', executable: null, supported: false, authenticated: false },
  ];
  actions.discover = () => assert.fail('Building controls must not probe the legacy board adapter');
  actions.launch.onStarted = session => opens.push(session.id);
  actions.setProject(project);
  actions.refresh();
  assert.equal(actions.node.hidden, false);
  assert.ok(actions.buttons.every(button => !button.hidden && !button.disabled));
  assert.deepEqual(starts, [], 'opening or refreshing controls never starts a session');
  assert.deepEqual(sends, []);
  await actions.start('claude');
  assert.deepEqual(starts, [{ projectId: project.id, cwd: project.path, access: 'read', playwright: false, provider: 'claude', title: 'Claude Code · Sample' }]);
  assert.deepEqual(opens, ['managed-claude']);
  assert.deepEqual(sends, [], 'the owner writes in TalkPanel after the blank session opens');
});

test('the building menu has only provider controls and each click opens one blank conversation', async t => {
  const before = { document: globalThis.document, Node: globalThis.Node }, nodes = [];
  class Element {
    constructor(tag) { this.tag = tag; this.dataset = {}; this.children = []; this.handlers = {}; this.classList = { add() {} }; nodes.push(this); }
    append(child) { this.children.push(child); }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
  }
  globalThis.Node = Element;
  globalThis.document = { createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), createTextNode: () => new Element('#text') };
  t.after(() => { globalThis.document = before.document; globalThis.Node = before.Node; });
  const starts = [], opens = [], sends = [];
  const actions = new BuildingSessionActions({
    store: { ...store, project: () => project },
    sessions: {
      available: true,
      start: async options => { starts.push(options); return { id: `session-${starts.length}`, ...options }; },
      send: async (...args) => sends.push(args),
    },
    discover: () => assert.fail('The menu must not invoke legacy discovery'),
    onStarted: (session, meta) => opens.push([session.id, meta.origin]),
  });
  actions.setProject(project); actions.refresh();
  assert.ok(nodes.every(node => !['input', 'textarea'].includes(node.tag)), 'write in the existing conversation, not the building menu');
  assert.deepEqual(starts, []); assert.deepEqual(opens, []); assert.deepEqual(sends, []);
  for (const [i, button] of actions.buttons.entries()) {
    await button.handlers.click();
    assert.equal(starts.length, i + 1);
    assert.equal(starts[i].provider, button.dataset.provider);
    assert.equal(starts[i].projectId, project.id);
    assert.equal(starts[i].access, 'read');
    assert.deepEqual(opens[i], [`session-${i + 1}`, 'started']);
    assert.deepEqual(sends, []);
  }
});

test('another explicit launch remains available after admission while existing project sessions are still running', async () => {
  const starts = [], sends = [];
  const sessions = {
    available: true, list: [{ id: 'existing', projectId: project.id, provider: 'claude', status: 'running' }],
    running: () => true,
    start: async options => { const session = { ...options, id: `new-${starts.length + 1}`, status: 'running' }; starts.push(options); sessions.list.push(session); return session; },
    send: async (id, text) => { sends.push([id, text]); },
  };
  const actions = actionState({ ...project, status: 'busy' }, sessions);
  await actions.start('claude');
  actions.refresh();
  assert.equal(actions.launch.pending, null);
  assert.equal(actions.node.hidden, false);
  assert.ok(actions.buttons.every(button => !button.hidden && !button.disabled));
  assert.ok(sessions.list.every(session => session.status === 'running'));
  await actions.start('codex');
  assert.deepEqual(starts.map(options => [options.provider, options.projectId]), [['claude', project.id], ['codex', project.id]]);
  assert.deepEqual(sends, [], 'both explicit provider choices open blank sessions');
  assert.equal(sessions.list.length, 3);
  assert.ok(sessions.list.every(session => session.status === 'running'));
});

test('a refused start cannot display its error after selecting another building', async () => {
  const other = { id: 'local:c:/sample/other', name: 'Other', path: 'C:/sample/other' };
  const refusal = new Error('Sample admission refused'), failures = [];
  let rejectStart, starts = 0;
  const sessions = {
    available: true,
    start: () => { starts++; return new Promise((_, reject) => { rejectStart = reject; }); },
    send: () => assert.fail('A refused session cannot receive a prompt'),
  };
  const actions = actionState(project, sessions);
  actions.launch.onStartFailed = error => failures.push(error);
  const operation = actions.start('codex');
  actions.setProject(other, { side: 'pc', remote: false });
  rejectStart(refusal);
  await operation;
  assert.equal(starts, 1);
  assert.deepEqual(failures, [refusal], 'the original launch still receives its actual refusal');
  assert.equal(actions.project.id, other.id);
  assert.equal(actions.error, '');
  assert.equal(actions.errorNode.hidden, true);
  assert.equal(actions.errorNode.textContent, '');
  assert.equal(actions.launch.pending, null);
  assert.equal(actions.launch.recovery.size, 0);
});

test('managed provider refusal is displayed without an invented session or send', async () => {
  let starts = 0;
  const actions = actionState(project, {
    available: true,
    start: async () => { starts++; throw Object.assign(new Error('Claude Code could not be found.'), { code: 'AGENT_UNAVAILABLE' }); },
    send: () => assert.fail('A refused session cannot receive a prompt'),
  });
  await actions.start('claude');
  assert.equal(starts, 1);
  assert.match(actions.errorNode.textContent, /Could not start: Claude Code could not be found/);
  assert.equal(actions.errorNode.hidden, false);
  assert.equal(actions.launch.pending, null);
  assert.equal(actions.launch.recovery.size, 0);
  assert.ok(actions.buttons.every(button => !button.disabled));
});

test('focus moves to an enabled provider without starting a session', () => {
  const focused = [], actions = actionState(project, { available: true });
  actions.buttons.forEach(button => { button.focus = options => focused.push([button.dataset.provider, options]); });
  actions.refresh(); actions.focus();
  assert.deepEqual(focused, [['claude', { preventScroll: true }]]);
  actions.sessions.available = false; actions.refresh(); actions.focus();
  assert.equal(focused.length, 1);
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

test('launcher opens a blank conversation without sending a turn', async () => {
  const events = [], sessions = { start: async () => { events.push('start'); return { id: 'a' }; }, send: async (id, text) => events.push(['send', id, text]) };
  const launch = new BuildingSessionLaunch({ store, sessions, onStarted: session => events.push(['open', session.id]) });
  await launch.start('codex', project);
  assert.deepEqual(events, ['start', ['open', 'a']]);
  events.length = 0;
  await launch.start('claude', project);
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

test('opening failure keeps the exact blank session recoverable without another start or send', async () => {
  let starts = 0, fail = true;
  const opens = [], contexts = [];
  const sessions = { start: async () => { starts++; return { id: 'a' }; }, send: () => assert.fail('Opening a blank session cannot send') };
  const launch = new BuildingSessionLaunch({ store, sessions,
    onStarting: ({ context }) => contexts.push(context),
    onStarted: (session, meta) => { opens.push([session.id, meta]); if (fail) throw new Error('UI unavailable'); },
  });
  const record = await launch.start('claude', project);
  assert.match(record.openError, /UI unavailable/); assert.equal(record.session.id, 'a');
  await launch.start('claude', project);
  assert.equal(starts, 1); assert.equal(launch.recovery.get(project.id), record);
  fail = false;
  await launch.open(record);
  assert.equal(starts, 1); assert.equal(record.openError, ''); assert.equal(launch.recovery.size, 0);
  assert.deepEqual(opens.map(([id, meta]) => [id, meta.origin]), [['a', 'started'], ['a', 'recovery'], ['a', 'recovery']]);
  assert.equal(contexts.length, 1);
  assert.ok(opens.every(([, meta]) => meta.context === contexts[0]));
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
  assert.equal(events.length, 2);
  assert.deepEqual({ ...events[0], context: undefined }, { provider: 'codex', project, context: undefined });
  assert.ok(events[0].context && typeof events[0].context === 'object');
  assert.equal(events[1], 'native');
  finish({ id: 'a' }); await first;
});

test('presentation promises never delay blank-session admission or trigger a send', async () => {
  let finishOpening;
  const events = [];
  const launch = new BuildingSessionLaunch({
    store,
    sessions: { start: async () => { events.push('native'); return { id: 'a' }; }, send: async () => events.push('send') },
    onStarting: () => new Promise(() => {}),
    onStarted: () => new Promise(resolve => { finishOpening = resolve; }),
  });
  const record = await launch.start('codex', project);
  assert.deepEqual(events, ['native']);
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
  const record = await launch.start('codex', project);
  failOpening(new Error('Conversation unavailable')); await Promise.resolve();
  assert.match(record.openError, /Conversation unavailable/);
  await launch.start('codex', project);
  assert.equal(starts, 1); assert.deepEqual(failures, []);
  assert.equal(launch.recovery.get(project.id).session.id, 'a');
});

test('creation failure carries its own launch context, distinct from a later attempt', async () => {
  const refusal = new Error('Creation refused'), starting = [], failed = [], admitted = [];
  let attempts = 0;
  const launch = new BuildingSessionLaunch({
    store, sessions: { start: async () => { if (++attempts === 1) throw refusal; return { id: 'a' }; } },
    onStarting: ({ context }) => starting.push(context),
    onStartFailed: (error, { context }) => failed.push({ error, context }),
    onStarted: (session, meta) => admitted.push({ session, ...meta }),
  });
  await assert.rejects(launch.start('codex', project), error => error === refusal);
  await launch.start('codex', project);
  assert.equal(starting.length, 2); assert.notEqual(starting[0], starting[1]);
  assert.deepEqual(failed, [{ error: refusal, context: starting[0] }]);
  assert.equal(admitted.length, 1); assert.equal(admitted[0].context, starting[1]);
  assert.equal(admitted[0].origin, 'started');
});

test('a presentation callback settling late retains its original launch context', async () => {
  const notifications = [], starting = [];
  let nextId = 0, settleFirst;
  const launch = new BuildingSessionLaunch({
    store, sessions: { start: async () => ({ id: `s${++nextId}` }) },
    onStarting: ({ context }) => starting.push(context),
    onStarted: async (session, meta) => {
      if (session.id === 's1') await new Promise(resolve => { settleFirst = resolve; });
      notifications.push({ id: session.id, ...meta });
    },
  });
  await launch.start('claude', project);
  await launch.start('codex', { ...project, id: 'local:c:/sample/second', path: 'C:/sample/second' });
  assert.deepEqual(notifications.map(item => item.id), ['s2']);
  settleFirst(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(notifications.map(item => item.id), ['s2', 's1']);
  assert.equal(notifications[0].context, starting[1]);
  assert.equal(notifications[1].context, starting[0]);
  assert.notEqual(starting[0], starting[1]);
  assert.ok(notifications.every(item => item.origin === 'started'));
});
