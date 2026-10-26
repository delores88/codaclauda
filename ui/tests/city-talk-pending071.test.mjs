import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { NpcManager } from '../app/city/npc.js';
import { Building } from '../app/city/buildings.js';

globalThis.window ||= {};
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
  const npcs = new NpcManager(new THREE.Group(), { buildings, reducedMotion: () => reduced });
  npcs.setCreate(() => ({ object: new THREE.Group(), pickable: [], setSpec() {}, setStatus() {}, setAction() {}, lookAt() {}, update() {}, dispose() {} }));
  npcs.sync(existing);
  const drop = npcs.dropOwner.bind(npcs);
  npcs.dropOwner = (...args) => { calls.drops.push(args); drop(...args); };
  t.after(() => npcs.dispose());
  const pose = { position: new THREE.Vector3(50, 60, 70), target: new THREE.Vector3(2, 0, 4), center: true, overview: false };
  const world = { camera: { fov: 40, position: pose.position.clone() }, controls: { target: pose.target.clone() },
    size: { w: 1500, h: 900 }, half: 90, side: 'pc', restSide: 'pc', settled: true, underside: false,
    centerTarget: pose.center, overview: pose.overview, toWorld: vector => vector.clone(),
    setShot: (...args) => calls.shots.push(args), flyAfterTurn: (...args) => calls.returns.push(args), flipTo() {} };
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
    setHover() {}, select() {}, updateCameraFrame() {}, renderToolbarState() {},
  });
  return { view, calls, pose, add(agent) { agents.push(agent); npcs.sync(agents); } };
}

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
