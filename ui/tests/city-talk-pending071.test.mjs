import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { NpcManager } from '../app/city/npc.js';
import { Building } from '../app/city/buildings.js';

globalThis.window ||= {};
globalThis.window.removeEventListener ||= () => {};
globalThis.document ||= { compatMode: 'CSS1Compat', removeEventListener() {} };
globalThis.localStorage ||= { getItem: () => null, setItem() {} };
const { CityView } = await import('../app/views/city.js');
const { sessions } = await import('../app/sessions.js');
const project = { id: 'local:alpha', name: 'Alpha', ids: ['local:alpha', 'gh:team/alpha'] };
const session = id => ({ id: `sess:${id}`, sessionId: id, kind: 'session', provider: 'codex', name: id,
  currentProjectId: project.id, cityProjectId: project.id, status: 'active', look: {} });

function fixture(t, { existing = [], reduced = true } = {}) {
  const building = { ...project, cell: { i: 2, j: 1 }, origin: { x: 32, z: 15.7 }, size: { W: 2.6, D: 3 },
    door: { x: 30, z: 18 }, seats: [], workSpot: Building.prototype.workSpot };
  const buildings = new Map([[project.id, building]]), calls = { open: [], live: [], failed: [], drops: [], shots: [], returns: [] };
  buildings.dispose = () => {};
  const npcs = new NpcManager(new THREE.Group(), { buildings, reducedMotion: () => reduced });
  npcs.setCreate(() => ({ object: new THREE.Group(), pickable: [], setSpec() {}, setStatus() {}, setAction() {}, lookAt() {}, update() {}, dispose() {} }));
  npcs.sync(existing);
  const drop = npcs.dropOwner.bind(npcs);
  npcs.dropOwner = (...args) => { calls.drops.push(args); drop(...args); };
  t.after(() => npcs.dispose());
  const pose = { position: new THREE.Vector3(50, 60, 70), target: new THREE.Vector3(2, 0, 4), center: true, overview: false };
  const camera = new THREE.PerspectiveCamera(40, 1500 / 900, .05, 10000);
  camera.position.copy(pose.position); camera.lookAt(pose.target);
  const world = { camera, controls: { target: pose.target.clone() },
    size: { w: 1500, h: 900 }, half: 90, side: 'pc', restSide: 'pc', settled: true, underside: false,
    centerTarget: pose.center, overview: pose.overview, toWorld: vector => vector.clone(),
    setShot: (...args) => calls.shots.push(args), flyAfterTurn: (...args) => calls.returns.push(args), flipTo() {}, stop() {}, dispose() {} };
  const panel = { open: (...args) => calls.open.push(args), focus() {}, close() { calls.closed = true; }, messages: () => [], info: () => ({}),
    resolvePending: agent => calls.live.push(agent), failPending: error => calls.failed.push(error) };
  let agents = [...existing];
  const view = Object.assign(Object.create(CityView.prototype), {
    world, buildings, npcs, peopleReady: true, talkPanel: panel, talkBubbles: { owner: { node: { hidden: true } }, agent: { node: { hidden: true } } },
    bubble: { hidden: true }, cityRoot: { classList: { add() {}, remove() {} } }, stage: { focus() {} },
    store: { project: id => project.ids.includes(id) ? project : null }, reduced: () => reduced,
    allAgents: () => agents, agentById: id => agents.find(a => a.id === id || a.sessionId === id),
    agentsAt: id => agents.filter(a => a.cityProjectId === id), streetBoxes: () => [], cameraLocal: () => ({ x: 0, z: 50 }),
    talkFraming: () => ({ vis: { x0: 20, x1: 1000, y0: 30, y1: 860 } }), talkFrameSig: () => 'fixture',
    bubbleText: () => 'Hello', talkSay() {}, syncCameraFramingMode() {}, closeCluster() {}, hideZoomHint() {},
    setHover() {}, select() {}, updateCameraFrame() {}, renderToolbarState() {}, cancelAgentDrag() {}, exitStreet() {},
    runnerLabels: new Map(), root: { replaceChildren() {} },
  });
  return { view, calls, pose, add(agent, { sync = true } = {}) { agents.push(agent); if (sync) npcs.sync(agents); }, syncAgents() { npcs.sync(agents); } };
}

test('null-id pending hook returns a synchronous handle and waits for the first staged frame', t => {
  const f = fixture(t);
  const handle = f.view.enterTalk(null, { pending: { provider: 'codex', projectId: project.id, label: 'Starting helper' } });
  assert.equal(typeof handle.resolve, 'function'); assert.equal(typeof handle.fail, 'function');
  assert.equal(handle.then, undefined, 'caller receives the handle immediately, before starting its provider request');
  assert.equal(f.calls.open.length, 1); assert.ok(f.view.talk.pending);
  f.add(session('fast'));
  assert.equal(handle.resolve('fast'), false, 'a fast session cannot settle before the owner is staged');
  assert.ok(f.view.talk.pending); assert.equal(f.view.talk.spot, undefined);
  assert.equal(f.calls.live.length, 0); assert.equal(f.calls.drops.length, 0);
  f.view.updateTalk();
  assert.ok(f.view.talk.spot); assert.equal(f.calls.drops.length, 1);
  f.view.updateTalk();
  assert.equal(f.view.talk.pending, null); assert.equal(f.view.talk.id, 'sess:fast');
  assert.equal(f.calls.live.length, 1); assert.equal(f.calls.drops.length, 1);
});

test('a resolved record waits for NPC sync, and repeated successful resolve or fail calls are harmless', t => {
  const f = fixture(t);
  const handle = f.view.enterTalk(null, { pending: { provider: 'codex', projectId: project.id } });
  f.view.updateTalk();
  const stagedPosition = { ...f.view.talk.pendingSpot };
  f.add(session('fast'), { sync: false });
  assert.equal(handle.resolve({ id: 'fast' }), false);
  assert.equal(handle.resolve({ id: 'fast' }), false);
  assert.equal(handle.resolve({ id: 'someone-else' }), false, 'admission cannot switch while its NPC is still absent');
  assert.equal(handle.fail(new Error('first prompt failed')), false, 'an admitted session is no longer a creation failure');
  assert.equal(f.view.talk.expectedId, 'sess:fast');
  assert.equal(f.calls.failed.length, 0);
  assert.ok(f.view.talk.pending); assert.equal(f.calls.live.length, 0);
  assert.equal(f.view.npcs.npcs.has('sess:fast'), false);
  f.syncAgents();
  assert.equal(handle.resolve({ id: 'fast' }), true);
  const npc = f.view.npcs.npcs.get('sess:fast');
  assert.equal(npc.pos.x, stagedPosition.x); assert.equal(npc.pos.z, stagedPosition.z);
  assert.equal(handle.resolve({ id: 'fast' }), false);
  assert.equal(handle.resolve({ id: 'someone-else' }), false);
  assert.equal(handle.fail(new Error('late rejection')), false);
  assert.equal(f.calls.live.length, 1); assert.equal(f.calls.failed.length, 0);
  assert.equal(f.view.talk.id, 'sess:fast');
});

test('successive null-id starts use separate pending identities and reject the older handle', t => {
  const f = fixture(t), options = { pending: { provider: 'codex', projectId: project.id } };
  const first = f.view.enterTalk(null, options);
  const firstId = f.view.talk.id;
  f.view.updateTalk();
  const second = f.view.enterTalk(null, options);
  const secondId = f.view.talk.id;
  assert.ok(firstId); assert.ok(secondId); assert.notEqual(secondId, firstId);
  assert.notEqual(second, first);
  assert.deepEqual(f.calls.open.map(([agent]) => agent.id), [firstId, secondId], 'panel drafts receive distinct identities');
  assert.equal(first.resolve('old-session'), false);
  assert.equal(first.fail(new Error('old rejection')), false);
  assert.equal(f.view.talk.expectedId, null); assert.equal(f.calls.failed.length, 0);
  f.view.updateTalk(); f.add(session('second-session'));
  assert.equal(second.resolve('second-session'), true);
  assert.equal(f.view.talk.id, 'sess:second-session');
  assert.equal(f.calls.live.length, 1);
});

test('pending failure settles once and repeated failure or success cannot replace it', t => {
  const f = fixture(t);
  const handle = f.view.enterTalk(null, { pending: { provider: 'codex', projectId: project.id } });
  f.view.updateTalk();
  assert.ok(f.view.npcs.talkReservation);
  assert.equal(handle.fail(new Error('first rejection')), true);
  assert.equal(f.view.npcs.talkReservation, null);
  assert.equal(handle.fail(new Error('second rejection')), false);
  f.add(session('too-late'));
  assert.equal(handle.resolve('too-late'), false);
  assert.equal(f.calls.failed.length, 1); assert.equal(f.calls.failed[0].message, 'first rejection');
  assert.equal(f.calls.live.length, 0); assert.equal(f.view.talk.failed, true);
});

for (const lifecycle of ['hide', 'destroy']) test(`${lifecycle} leaves late pending resolve and failure callbacks as no-ops`, t => {
  const f = fixture(t);
  const handle = f.view.enterTalk(null, { pending: { provider: 'codex', projectId: project.id } });
  f.view.updateTalk();
  assert.ok(f.view.npcs.talkReservation);
  f.view[lifecycle]();
  assert.equal(f.view.talk, null); assert.equal(f.view.npcs.talkReservation, null);
  assert.equal(f.calls.closed, true);
  const counts = { shots: f.calls.shots.length, returns: f.calls.returns.length, opens: f.calls.open.length };
  f.add(session('late'), { sync: false });
  assert.equal(handle.resolve('late'), false);
  assert.equal(handle.fail(new Error('late rejection')), false);
  assert.equal(f.calls.live.length, 0); assert.equal(f.calls.failed.length, 0);
  assert.deepEqual({ shots: f.calls.shots.length, returns: f.calls.returns.length, opens: f.calls.open.length }, counts);
});

test('pending starts at its canonical building and goes live only for the exact named session', t => {
  const f = fixture(t, { existing: [session('already-here')] });
  const handle = f.view.enterTalk('request-a', { pending: { provider: 'codex', projectId: 'gh:team/alpha', label: 'New helper' } });
  assert.equal(f.view.talk.pending.projectId, project.id);
  f.view.updateTalk();
  assert.equal(f.view.talk.phase, 'on'); assert.ok(f.view.npcs.owner.pos.x > 20);
  const pendingPosition = f.view.talk.pendingSpot && { ...f.view.talk.pendingSpot };
  const ownerPosition = f.view.npcs.owner.pos.clone();
  assert.equal(f.calls.drops.length, 1); assert.equal(f.calls.open[0][1].pending.label, 'New helper');
  f.add(session('unrelated'));
  assert.equal(f.view.resolvePendingTalk(), false);
  assert.equal(handle.resolve('wanted'), false, 'name is remembered while the target has not appeared yet');
  f.add(session('wanted'));
  assert.equal(f.view.resolvePendingTalk(), true);
  assert.equal(f.view.talk.id, 'sess:wanted'); assert.equal(f.view.talk.pending, null);
  f.view.updateTalk();
  assert.equal(f.calls.live[0].sessionId, 'wanted'); assert.equal(f.calls.drops.length, 1);
  assert.ok(f.view.npcs.owner.pos.x > 20); assert.ok(f.view.npcs.npcs.get('sess:wanted').held);
  assert.ok(pendingPosition);
  assert.equal(f.view.npcs.npcs.get('sess:wanted').pos.x, pendingPosition.x);
  assert.equal(f.view.npcs.npcs.get('sess:wanted').pos.z, pendingPosition.z);
  assert.ok(f.view.npcs.owner.pos.distanceTo(ownerPosition) < 1e-8, 'owner stays in the staged conversation spot');
});

test('pending id can name the exact future session and automatically resolves on appearance', t => {
  const f = fixture(t);
  f.view.enterTalk('sess:expected', { pending: { provider: 'codex', projectId: project.id } });
  f.view.updateTalk(); f.add(session('expected')); f.view.updateTalk();
  assert.equal(f.view.talk.id, 'sess:expected'); assert.equal(f.view.talk.pending, null);
  assert.equal(f.calls.live.length, 1);
  assert.equal(f.view.npcs.npcs.get('sess:expected').talkStaged, true);
});

test('failure remains visible and later arrival cannot revive a failed pending conversation', t => {
  const f = fixture(t);
  const handle = f.view.enterTalk('request-a', { pending: { provider: 'codex', projectId: project.id } });
  assert.equal(handle.fail(new Error('Start refused')), true);
  f.add(session('wanted'));
  assert.equal(handle.resolve('wanted'), false);
  f.view.updateTalk();
  assert.equal(f.calls.live.length, 0); assert.match(f.calls.failed[0].message, /Start refused/);
  assert.equal(f.view.talk.failed, true);
});

test('leaving or switching conversations makes a former start handle harmless', t => {
  const f = fixture(t, { existing: [session('already-here')] });
  const handle = f.view.enterTalk('request-a', { pending: { provider: 'codex', projectId: project.id } });
  f.view.exitTalk({ instant: true });
  assert.equal(handle.resolve('wanted'), false); assert.equal(handle.fail(new Error('late error')), false);
  assert.equal(f.view.talk, null); assert.equal(f.calls.failed.length, 0);
  const next = f.view.enterTalk('request-b', { pending: { provider: 'codex', projectId: project.id } });
  f.view.enterTalk('sess:already-here');
  assert.equal(next.resolve('wanted'), false); assert.equal(next.fail('late error'), false);
  assert.equal(f.view.talk.id, 'sess:already-here');
});

test('exit restores the original camera after pending-to-live and targets resting ground during drop', t => {
  const f = fixture(t, { reduced: false });
  const handle = f.view.enterTalk('request-a', { pending: { provider: 'codex', projectId: project.id } });
  f.view.updateTalk(); f.add(session('wanted')); handle.resolve('wanted'); f.view.updateTalk();
  const npc = f.view.npcs.npcs.get('sess:wanted');
  assert.ok(npc.drop, 'the new agent is still dropping');
  assert.equal(f.view.talk.a.y, f.view.npcs.surfaceY(npc.pos.x, npc.pos.z), 'shot aims at resting face height');
  f.view.exitTalk({ instant: true });
  assert.equal(npc.held, false); assert.equal(f.calls.closed, true);
  assert.equal(f.calls.shots.at(-1)[0], null);
  const [returnPose, options] = f.calls.returns.at(-1);
  assert.deepEqual(returnPose.target.toArray(), f.pose.target.toArray());
  assert.ok(Math.abs(returnPose.distance - f.pose.position.distanceTo(f.pose.target)) < 1e-9);
  assert.equal(options.center, f.pose.center); assert.equal(f.view.world.overview, f.pose.overview);
});

test('managed session replaces its board duplicate while the address remains resolvable', t => {
  const before = sessions.list;
  t.after(() => { sessions.list = before; });
  sessions.list = [{ id: 'managed', mailboxAddress: 'board-managed', provider: 'codex', title: 'Managed',
    projectId: project.id, status: 'idle', lastActivityAt: Date.now() }];
  const board = { id: 'board-managed', address: 'board-managed', kind: 'mailbox', currentProjectId: project.id };
  const unrelated = { ...board, id: 'board-other', address: 'board-other' };
  const store = { agents: [board, unrelated], projects: [project], prefs: {}, mailboxMessages: [], tasks: [],
    project: id => project.ids.includes(id) ? project : null, visibleProjects: () => [project], matchProject: () => null };
  const view = Object.assign(Object.create(CityView.prototype), { store, external: [], islands: { current: null } });
  const agents = view.allAgents();
  assert.equal(agents.length, 2);
  assert.equal(agents.some(a => a.id === 'board-managed'), false);
  assert.equal(view.agentById('board-managed').id, 'sess:managed');
  assert.equal(view.allAgents(), agents, 'per-frame lookups reuse the location snapshot');
});

test('contributor islands use their own mapped agents without borrowing the home location cache', () => {
  const homeAgents = [{ id: 'home-worker', cityProjectId: 'local:home' }];
  const islandAgent = { id: 'island-worker', currentProjectId: 'gh:team/island', observedProjectId: 'local:other' };
  const view = Object.assign(Object.create(CityView.prototype), { agentLocations: { agents: homeAgents },
    islands: { current: 'contributor' }, store: { agents: [islandAgent] } });
  const island = view.allAgents();
  assert.equal(island.length, 1); assert.equal(island[0].id, islandAgent.id);
  assert.equal(island[0].cityProjectId, 'gh:team/island');
  assert.equal(view.agentLocations.agents, homeAgents, 'visiting an island cannot overwrite home placement memory');
  view.islands.current = null;
  assert.equal(view.allAgents(), homeAgents);
});
