import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { NpcManager } from '../app/city/npc.js';

globalThis.window ||= {};
globalThis.localStorage ||= { getItem: () => null, setItem() {} };
const { CityView } = await import('../app/views/city.js');
const { sessions } = await import('../app/sessions.js');

const projectId = 'gh:work/api';
const worker = { id: 'sess:worker', kind: 'session', status: 'active', cityProjectId: projectId, look: {} };
function fixture(t) {
  const buildings = new Map();
  const home = { id: projectId, cell: { i: 1, j: 1 }, seats: [],
    workSpot: () => ({ x: 16, z: 20, fx: 0, fz: -1 }) };
  let offsite = { x: 104, z: 5, face: { x: 104, z: 1 }, island: 'owned:work' };
  const neighbors = { spotFor: id => id === projectId ? offsite : null,
    islandAt: x => x > 70 ? 'owned:work' : null, contains: x => x > 70 };
  const people = new NpcManager(new THREE.Group(), { buildings, neighbors, reducedMotion: () => true });
  people.setCreate(() => ({ object: new THREE.Group(), pickable: [], setSpec() {}, setStatus() {},
    setAction() {}, lookAt() {}, update() {}, dispose() {} }));
  t.after(() => people.dispose());
  return { people, buildings, home, moveNeighbor: x => { offsite = { ...offsite, x, face: { x, z: 1 } }; } };
}
const atGoal = npc => assert.deepEqual([npc.pos.x, npc.pos.z], [npc.goal.point.x, npc.goal.point.z]);

test('settling an island view relocates an unchanged work goal, including an interrupted trip', t => {
  const f = fixture(t);
  f.buildings.set(projectId, f.home);
  f.people.sync([worker]);
  const npc = f.people.npcs.get(worker.id), priorKey = npc.goalKey;
  npc.place(104, 5);
  npc.path = [{ x: 100, z: 5 }];
  npc.trip = { legs: [], next: null };
  f.people.settle();
  f.people.sync([worker]);
  assert.equal(npc.goalKey, priorKey, 'same logical work slot in the new view');
  atGoal(npc);
  assert.equal(npc.trip, null);
  assert.deepEqual(npc.path, []);
});

test('an account project moves between its neighbor and home when layout changes without a portal', t => {
  const f = fixture(t);
  f.people.sync([worker]);
  const npc = f.people.npcs.get(worker.id);
  assert.ok(npc.goal.offsite); atGoal(npc);
  f.buildings.set(projectId, f.home);
  f.people.sync([worker]);
  assert.equal(Boolean(npc.goal.offsite), false); atGoal(npc);
  f.buildings.clear();
  f.people.sync([worker]);
  assert.equal(npc.goal.offsite, true); atGoal(npc);
});

test('a neighbor moving outward on city growth updates its agents instead of retaining stale coordinates', t => {
  const f = fixture(t);
  f.people.sync([worker]);
  const npc = f.people.npcs.get(worker.id);
  f.moveNeighbor(140);
  f.people.sync([worker]);
  assert.equal(npc.goal.point.x, 140); atGoal(npc);
});

test('owned islands show a managed session once and keep unrelated board agents', t => {
  const before = sessions.list;
  sessions.list = [{ id: 'worker', mailboxAddress: 'coda-session-worker' }];
  t.after(() => { sessions.list = before; });
  const project = { id: projectId };
  const base = [{ id: 'board:worker', address: 'coda-session-worker', currentProjectId: projectId },
    { id: 'board:independent', address: 'claude-reviewer', currentProjectId: projectId }];
  const managed = { ...worker, sessionId: 'worker', currentProjectId: projectId };
  const view = Object.assign(Object.create(CityView.prototype), {
    islands: { current: 'owned:work' }, store: { agents: base, project: id => id === projectId ? project : null },
    extraAgents: () => [managed],
  });
  assert.deepEqual(view.allAgents().map(a => a.id), ['board:independent', worker.id]);
  assert.equal(view.allAgents().find(a => a.id === worker.id).sessionId, 'worker', 'retain the exact managed route');
  view.islands.current = 'contributor:other';
  assert.deepEqual(view.allAgents().map(a => a.id), base.map(a => a.id), 'contributor handling stays unchanged');
});
