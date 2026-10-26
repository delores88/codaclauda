import test from 'node:test';
import assert from 'node:assert/strict';
import { BuildingSessionLaunch } from '../app/city/building-actions.js';
import { buildingTalkCallbacks } from '../app/city/building-talk.js';

globalThis.window ||= {};
globalThis.localStorage ||= { getItem: () => null, setItem() {} };
const { CityView } = await import('../app/views/city.js');
const { TalkPanel } = await import('../app/city/talk.js');

const project = { id: 'local:c:/sample/alpha', ids: ['local:c:/sample/alpha', 'gh:sample/alpha'], name: 'Alpha', path: 'C:/sample/alpha' };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const agent = id => ({ id: `sess:${id}`, sessionId: id, kind: 'session', provider: 'codex', name: id,
  currentProjectId: project.id, cityProjectId: project.id, status: 'active' });

// Use the real City pending handles and exit lifecycle. Rendering and NPC geometry
// are bounded fakes here; their independent acceptance is in the City talk tests.
function fixture() {
  const events = [], starts = [], sends = [], notices = [], failures = [], resolved = [];
  const native = deferred(), agents = [agent('already-running')];
  const store = { project: id => project.ids.includes(id) ? project : null, projectAccess: () => ({ level: 'read' }) };
  let view;
  view = Object.assign(Object.create(CityView.prototype), {
    visible: true, failed: false, store, world: { restSide: 'pc', setShot: value => events.push(['shot', value]) },
    islands: { current: null }, npcs: { hold() {}, releaseTalkSpot() {} },
    talkPanel: {
      open: (who, options) => events.push(['open', who, options]), focus() {},
      close: () => events.push(['close']),
      resolvePending: who => { resolved.push(who); events.push(['resolved', who.sessionId]); },
      failPending: error => { failures.push(error); events.push(['failed', error]); },
    },
    cityRoot: { classList: { add() {}, remove() {} } }, bubble: { hidden: true }, talkBubbles: {},
    agentById: id => agents.find(a => a.id === id || a.sessionId === id), cameraPose: () => null,
    syncCameraFramingMode() {}, closeCluster() {}, hideZoomHint() {}, setHover() {}, updateCameraFrame() {}, renderToolbarState() {},
    select: target => { view.selection = target; events.push(['select', target]); },
    focusSelection: () => events.push(['focus-selection']), stage: { focus: () => events.push(['stage-focus']) },
    buildingSessions: { input: { focus: options => events.push(['input-focus', options]) }, start: () => assert.fail('Opening controls must never launch') },
  });
  const client = {
    start: options => { starts.push(options); events.push(['native', options]); return native.promise; },
    send: async (id, text) => { sends.push([id, text]); events.push(['send', id, text]); },
  };
  const launch = new BuildingSessionLaunch({ store, sessions: client,
    ...buildingTalkCallbacks(view, { notice: message => notices.push(message) }) });
  return { view, store, client, launch, native, agents, events, starts, sends, notices, failures, resolved,
    add: id => { const next = agent(id); agents.push(next); return next; } };
}

test('building start enters pending talk before native start and resolves only the admitted session', async () => {
  const f = fixture();
  const operation = f.launch.start('codex', project, '  Work here  ');
  const pending = f.view.talk;
  assert.ok(f.launch.pending);
  assert.deepEqual(pending.pending, { provider: 'codex', projectId: project.id, label: 'New session' });
  assert.ok(f.events.findIndex(e => e[0] === 'open') < f.events.findIndex(e => e[0] === 'native'));
  assert.equal(f.launch.start('claude', project, 'second click'), operation);
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.starts[0], { projectId: project.id, cwd: project.path, access: 'read', playwright: false, provider: 'codex', title: 'Codex · Alpha' });
  f.add('unrelated');
  assert.equal(f.view.resolvePendingTalk(), false);
  const expectedAgent = f.add('admitted');
  const actual = { id: 'admitted', provider: 'codex', projectId: project.id };
  f.native.resolve(actual);
  const record = await operation;
  assert.equal(record.session, actual);
  assert.equal(f.view.talk, pending, 'pending presentation stays the same conversation');
  assert.equal(f.view.talk.id, expectedAgent.id);
  assert.equal(f.view.talk.pending, null);
  assert.deepEqual(f.resolved, [expectedAgent]);
  assert.deepEqual(f.sends, [['admitted', 'Work here']]);
  assert.equal(f.events.filter(e => e[0] === 'open').length, 1);
});

test('the exact admitted id remains pending until its own registry row arrives', async () => {
  const f = fixture();
  const operation = f.launch.start('claude', project);
  f.native.resolve({ id: 'expected' });
  await operation;
  assert.equal(f.view.talk.expectedId, 'sess:expected');
  assert.ok(f.view.talk.pending);
  f.add('different');
  assert.equal(f.view.resolvePendingTalk(), false);
  const expected = f.add('expected');
  assert.equal(f.view.resolvePendingTalk(), true);
  assert.deepEqual(f.resolved, [expected]);
  assert.equal(f.sends.length, 0, 'an empty initial prompt starts no turn');
});

for (const action of ['close', 'switch', 'hide', 'graphics-failure']) {
  test(`late native admission after ${action} cannot reopen or replace the current conversation`, async () => {
    const f = fixture();
    const operation = f.launch.start('codex', project);
    if (action === 'switch') f.view.enterTalk('sess:already-running');
    else { f.view.exitTalk({ instant: true }); if (action === 'hide') f.view.visible = false; if (action === 'graphics-failure') f.view.failed = true; }
    const current = f.view.talk, opens = f.events.filter(e => e[0] === 'open').length;
    f.add('late'); f.native.resolve({ id: 'late' });
    const record = await operation;
    assert.equal(record.session.id, 'late', 'admitted session remains recorded even when its view is stale');
    assert.equal(f.view.talk, current);
    assert.equal(f.events.filter(e => e[0] === 'open').length, opens);
    assert.equal(f.resolved.length, 0);
    assert.equal(f.failures.length, 0);
  });
}

for (const action of ['close', 'switch']) {
  test(`late native refusal after ${action} cannot mark the next conversation as failed`, async () => {
    const f = fixture(), refusal = new Error('Project admission refused');
    const operation = f.launch.start('codex', project);
    if (action === 'close') f.view.exitTalk({ instant: true });
    else f.view.enterTalk('sess:already-running');
    const current = f.view.talk;
    f.native.reject(refusal);
    await assert.rejects(operation, error => error === refusal);
    assert.equal(f.view.talk, current);
    assert.equal(f.failures.length, 0);
    assert.equal(f.launch.recovery.size, 0);
  });
}

test('native refusal fails pending talk without inventing a session or send', async () => {
  const f = fixture(), refusal = new Error('Provider unavailable');
  const operation = f.launch.start('claude', project, 'Keep the owner prompt');
  f.native.reject(refusal);
  await assert.rejects(operation, error => error === refusal);
  assert.equal(f.view.talk.failed, true);
  assert.deepEqual(f.failures, [refusal]);
  assert.equal(f.resolved.length, 0);
  assert.equal(f.sends.length, 0);
  assert.equal(f.launch.pending, null);
  assert.equal(f.launch.recovery.size, 0);
});

test('first-send failure preserves the live session; explicit recovery and retry never restart it', async () => {
  const f = fixture(), delivery = deferred(), sendReached = deferred();
  f.client.send = (id, text) => { f.sends.push([id, text]); sendReached.resolve(); return delivery.promise; };
  const operation = f.launch.start('codex', project, 'Keep this prompt');
  f.add('admitted'); f.native.resolve({ id: 'admitted' });
  await sendReached.promise;
  assert.equal(f.view.talk.id, 'sess:admitted');
  f.view.exitTalk({ instant: true });
  const opens = f.events.filter(e => e[0] === 'open').length;
  delivery.reject(new Error('Send temporarily unavailable'));
  const record = await operation;
  assert.equal(f.view.talk, null, 'a send-error notification cannot reopen a closed conversation');
  assert.equal(f.events.filter(e => e[0] === 'open').length, opens);
  assert.equal(f.failures.length, 0, 'a send error is not a session-start failure');
  assert.match(record.error, /Session started.*Send temporarily unavailable/);
  assert.equal(record.prompt, 'Keep this prompt');
  assert.equal(f.launch.recovery.get(project.id), record);
  assert.deepEqual(f.notices, [record.error]);
  await f.launch.open(record);
  assert.equal(f.view.talk.id, 'sess:admitted');
  assert.equal(f.view.talk.pending, null, 'Open session uses its known identity, not another pending start');
  f.client.send = async (id, text) => { f.sends.push([id, text]); };
  await f.launch.retry(project.id);
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.sends, [['admitted', 'Keep this prompt'], ['admitted', 'Keep this prompt']]);
  assert.equal(record.prompt, ''); assert.equal(record.error, '');
  assert.equal(f.launch.recovery.size, 0);
  assert.equal(f.view.talk.id, 'sess:admitted');
});

test('a hidden start cannot attach itself to an unrelated conversation when City becomes visible', async () => {
  const f = fixture(); f.view.visible = false;
  const operation = f.launch.start('codex', project);
  assert.equal(f.view.talk, undefined);
  f.view.visible = true; f.view.enterTalk('sess:already-running');
  const current = f.view.talk;
  f.add('hidden-start'); f.native.resolve({ id: 'hidden-start' });
  await operation;
  assert.equal(f.view.talk, current);
  assert.equal(f.resolved.length, 0);
});

test('New session here reopens controls at the canonical local building without launching', () => {
  const f = fixture(); f.view.enterTalk('sess:already-running'); f.events.length = 0;
  f.view.openBuildingSessionControls('gh:sample/alpha');
  assert.equal(f.view.talk, null);
  assert.deepEqual(f.view.selection, { kind: 'building', id: project.id });
  assert.deepEqual(f.events.filter(e => ['close', 'select', 'focus-selection', 'input-focus'].includes(e[0])), [
    ['close'], ['select', { kind: 'building', id: project.id }], ['focus-selection'], ['input-focus', { preventScroll: true }],
  ]);
  assert.equal(f.starts.length, 0);
  assert.equal(f.sends.length, 0);
});

test('header controls leave the active talk untouched for hidden, ghost, Spark, remote or removed projects', () => {
  for (const state of ['hidden', 'ghost', 'spark', 'remote', 'removed']) {
    const f = fixture(); f.view.enterTalk('sess:already-running');
    if (state === 'hidden') f.view.visible = false;
    if (state === 'ghost') f.store.project = () => ({ id: 'gh:sample/ghost', path: '' });
    if (state === 'spark') f.view.world.restSide = 'spark';
    if (state === 'remote') f.view.islands.current = 'contributor';
    if (state === 'removed') f.store.project = () => null;
    const current = f.view.talk; f.events.length = 0;
    f.view.openBuildingSessionControls(project.id);
    assert.equal(f.view.talk, current, state);
    assert.deepEqual(f.events, [], state);
    assert.equal(f.starts.length, 0);
  }
});

// Exercise the caller's public callback binding against the real panel project
// resolver. The upstream panel tests cover rendering that optional callback.
function headerFixture(kind = 'session') {
  let currentProject = project, refreshes = 0;
  const store = { project: id => project.ids.includes(id) ? currentProject : null };
  const who = kind === 'session' ? agent('already-running')
    : { id: 'board-agent', kind: 'mailbox', address: 'codex-board', provider: 'codex', name: 'Reviewer', currentProjectId: 'gh:sample/alpha' };
  const panel = Object.assign(Object.create(TalkPanel.prototype), {
    store, agent: who,
    sessions: { session: () => ({ provider: 'codex', status: 'running' }), running: () => true },
    refresh: () => { refreshes++; },
  });
  panel.thread = panel.pickThread(who);
  const view = Object.assign(Object.create(CityView.prototype), {
    talkPanel: panel, world: { restSide: 'pc' }, islands: { current: null },
    newSessionHere: () => assert.fail('Updating header eligibility must not launch or open controls'),
  });
  return { view, panel, setProject: value => { currentProject = value; }, refreshes: () => refreshes };
}

test('local board and managed conversations share the stable New session here header action', () => {
  for (const kind of ['mailbox', 'session']) {
    const f = headerFixture(kind);
    assert.equal(f.panel.info().project.id, project.id, 'the panel resolves the canonical local project');
    f.view.refreshBuildingTalkAction();
    assert.equal(f.panel.onNewSessionHere, f.view.newSessionHere);
    assert.equal(f.refreshes(), 1);
    f.view.refreshBuildingTalkAction();
    f.view.refreshBuildingTalkAction();
    assert.equal(f.refreshes(), 1, 'unchanged eligible frames do not rebuild the header');
  }
});

test('header eligibility removes ghost, Spark, remote and removed-project actions and restores local access', () => {
  for (const state of ['ghost', 'spark', 'remote', 'removed']) {
    const f = headerFixture();
    f.view.refreshBuildingTalkAction();
    if (state === 'ghost') f.setProject({ id: 'gh:sample/alpha', name: 'Ghost', path: '' });
    if (state === 'spark') f.view.world.restSide = 'spark';
    if (state === 'remote') f.view.islands.current = 'contributor';
    if (state === 'removed') f.setProject(null);
    f.view.refreshBuildingTalkAction();
    assert.equal(f.panel.onNewSessionHere, undefined, state);
    assert.equal(f.refreshes(), 2, state);
    f.view.refreshBuildingTalkAction();
    assert.equal(f.refreshes(), 2, 'unchanged ineligible frames do not rebuild the header');
    f.setProject(project); f.view.world.restSide = 'pc'; f.view.islands.current = null;
    f.view.refreshBuildingTalkAction();
    assert.equal(f.panel.onNewSessionHere, f.view.newSessionHere, state);
    assert.equal(f.refreshes(), 3, state);
  }
});

test('closed or absent talk panels do not trigger a header refresh', () => {
  const f = headerFixture();
  f.panel.agent = null;
  f.panel.info = () => assert.fail('A closed panel has no header context to resolve');
  f.view.refreshBuildingTalkAction();
  assert.equal(f.refreshes(), 0);
  f.view.talkPanel = null;
  assert.doesNotThrow(() => f.view.refreshBuildingTalkAction());
});
