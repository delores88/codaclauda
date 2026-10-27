import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { NpcManager } from '../app/city/npc.js';
import { Building, buildingSize, downtownBasePlan } from '../app/city/buildings.js';
import { talkPlanterBoxes } from '../app/city/talk-placement.js';

const project = { id: 'local:alpha', cell: { i: 2, j: 1 }, origin: { x: 32, z: 15.7 }, size: { W: 2.6, D: 3 },
  door: { x: 30, z: 18 }, seats: [], workSpot: Building.prototype.workSpot };
const agent = (id, kind = 'mailbox', status = 'idle') => ({ id, kind, status, currentProjectId: project.id, look: {} });
function manager(t, reduced = true) {
  const dust = [];
  const people = new NpcManager(new THREE.Group(), { buildings: new Map([[project.id, project]]), reducedMotion: () => reduced,
    particles: { emit: (...args) => dust.push(args) } });
  people.setCreate(() => ({ object: new THREE.Group(), pickable: [], setSpec() {}, setStatus() {}, setAction() {}, lookAt() {}, update() {}, dispose() {} }));
  t.after(() => people.dispose());
  return { people, dust };
}

test('awake agents at the same building have distinct person-sized slots', t => {
  const { people } = manager(t);
  people.sync(Array.from({ length: 30 }, (_, n) => agent(`worker-${n}`)));
  const points = people.entries().map(n => n.pos);
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++)
    assert.ok(points[i].distanceTo(points[j]) >= .72 - 1e-9, `slots ${i} and ${j} overlap`);
});

test('explicit hidden location prevents NPC home fallback, and current wins for offline agents', t => {
  const { people } = manager(t);
  people.sync([{ ...agent('hidden'), cityProjectId: null, homeProjectId: project.id },
    { ...agent('offline', 'mailbox', 'offline'), homeProjectId: 'missing' }]);
  assert.match(people.npcs.get('hidden').goalKey, /:hq:/);
  assert.match(people.npcs.get('offline').goalKey, /local:alpha/);
});

test('new session drops directly at its building even when talk holds it immediately', t => {
  const { people, dust } = manager(t, false);
  people.sync([]);
  people.sync([agent('new-session', 'session', 'active')]);
  const npc = people.npcs.get('new-session');
  assert.equal(npc.pos.x, npc.goal.point.x); assert.equal(npc.pos.z, npc.goal.point.z);
  assert.ok(npc.pos.x > 20 && npc.drop && npc.path.length === 0);
  people.hold(npc.id, true);
  people.update(.5, .5, { reducedMotion: false });
  assert.equal(npc.pos.y, people.surfaceY(npc.pos.x, npc.pos.z));
  assert.equal(npc.drop, null);
  assert.equal(dust.filter(([kind]) => kind === 'dust').length, 1);
  people.update(.5, 1, { reducedMotion: false });
  assert.equal(dust.filter(([kind]) => kind === 'dust').length, 1);
});

test('owner fallback and reduced-motion drop work with no custom avatar', t => {
  const { people, dust } = manager(t);
  people.sync([]);
  assert.equal(people.owner.name, 'You');
  people.dropOwner(30, 18, 1);
  assert.equal(people.owner.pos.x, 30); assert.equal(people.owner.pos.z, 18);
  assert.equal(people.owner.pos.y, people.surfaceY(30, 18));
  assert.equal(people.owner.drop, null); assert.equal(dust.length, 0);
});

test('only board agents carry pickable outlined clipboards; removal disposes the prop', t => {
  const { people } = manager(t);
  people.sync([agent('board'), agent('session', 'session'), agent('desktop', 'external')]);
  const prop = people.npcs.get('board').clipboard;
  assert.ok(prop && prop.children.some(n => n.children.some(c => c.userData.outline)));
  assert.equal(people.npcs.get('session').clipboard, undefined);
  assert.equal(people.npcs.get('desktop').clipboard, undefined);
  assert.ok(people.pickables().some(n => n.parent === prop));
  assert.deepEqual(people.targetOf(prop.children[0]), { kind: 'agent', id: 'board' });
  let disposed = 0; prop.children[0].geometry.addEventListener('dispose', () => disposed++);
  people.sync([agent('session', 'session')]);
  assert.ok(disposed > 0); assert.equal(prop.parent, null);
});

test('clipboard glance and owner nod briefly animate head joints without changing talk action', t => {
  const { people } = manager(t, false);
  people.sync([agent('board')]);
  const npc = people.npcs.get('board');
  npc.person.body = { j: { head: new THREE.Group() } };
  people.owner.person.body = { j: { head: new THREE.Group() } };
  people.hold('board', true); people.act({ kind: 'agent', id: 'board' }, 'talk');
  people.glance('board'); people.nodOwner(); people.update(.1, .1, { reducedMotion: false });
  assert.ok(npc.person.body.j.head.rotation.x > 0);
  assert.ok(people.owner.person.body.j.head.rotation.x > 0);
  assert.equal(npc.action, 'talk');
  people.update(1, 1.1, { reducedMotion: false });
  assert.equal(npc.glanceLeft, 0); assert.equal(people.owner.nodLeft, 0);
});

test('pending reserves a clear building spot and the live session replaces it without relocation', t => {
  const { people } = manager(t, false);
  people.sync([agent('already-here', 'session', 'active')]);
  const reservation = people.reserveTalkSpot(project.id);
  assert.ok(reservation && reservation.x > 20);
  for (const npc of people.entries()) assert.ok(Math.hypot(npc.pos.x - reservation.x, npc.pos.z - reservation.z) >= .8);
  assert.equal(people.stageTalkAgent('not-yet-created', reservation), false);
  assert.equal(people.talkReservation, reservation, 'keep the pending spot until the NPC exists');
  people.sync([agent('already-here', 'session', 'active'), agent('interloper', 'session', 'active'), agent('wanted', 'session')]);
  for (const npc of people.entries()) assert.ok(Math.hypot(npc.goal.point.x - reservation.x, npc.goal.point.z - reservation.z) >= .8 - 1e-9);
  const wanted = people.npcs.get('wanted'), originalGoal = wanted.goal;
  people.update(.1, .1, { reducedMotion: false });
  const lift = wanted.pos.y - people.surfaceY(wanted.pos.x, wanted.pos.z), elapsed = wanted.drop.elapsed;
  assert.equal(people.stageTalkAgent('wanted', reservation), true);
  assert.equal(wanted.pos.x, reservation.x); assert.equal(wanted.pos.z, reservation.z);
  assert.equal(wanted.pos.y - people.surfaceY(wanted.pos.x, wanted.pos.z), lift);
  assert.equal(wanted.drop.elapsed, elapsed); assert.equal(wanted.goal, originalGoal); assert.deepEqual(wanted.path, []);
  assert.equal(people.talkReservation, null);
  people.update(.5, .6, { reducedMotion: false });
  people.sync([agent('already-here', 'session', 'active'), agent('interloper', 'session', 'active'), agent('wanted', 'session'), agent('later', 'session')]);
  assert.equal(wanted.pos.x, reservation.x); assert.equal(wanted.pos.z, reservation.z);
  assert.equal(wanted.goal, originalGoal, 'held stage survives source refreshes');
  for (const npc of people.entries().filter(n => n !== wanted)) assert.ok(Math.hypot(npc.goal.point.x - reservation.x, npc.goal.point.z - reservation.z) >= .8 - 1e-9);
  people.hold('wanted', false);
  assert.equal(wanted.talkStaged, false); assert.equal(wanted.held, false);
});

test('pending cancellation releases only its matching spot reservation', t => {
  const { people } = manager(t);
  people.sync([]);
  const first = people.reserveTalkSpot(project.id), second = people.reserveTalkSpot(project.id);
  people.releaseTalkSpot(first); assert.equal(people.talkReservation, second);
  people.releaseTalkSpot(second); assert.equal(people.talkReservation, null);
  assert.equal(people.reserveTalkSpot('missing'), null);
});

test('a seated board agent stands at its canonical building for talk and returns to its exact bench goal', t => {
  const { people } = manager(t);
  const bench = { x: 29, z: 18, fx: 0, fz: 1 };
  const otherBench = { x: 35, z: 18, fx: 0, fz: 1 };
  people.buildings.set(project.id, { ...project, seats: [bench, otherBench] });
  people.resolveProjectId = id => id === 'gh:sample/alpha' ? project.id : id;
  const board = { ...agent('seated-board', 'mailbox', 'offline'), currentProjectId: 'missing',
    cityProjectId: 'gh:sample/alpha' };
  const neighbor = agent('z-neighbor', 'mailbox', 'offline');
  people.sync([board, neighbor]);
  const npc = people.npcs.get(board.id), goal = npc.goal;
  assert.equal(npc.action, 'sit'); assert.equal(goal.type, 'sit');
  people.hold(npc.id, true);
  assert.equal(people.prepareTalk(npc.id), true);
  assert.equal(npc.action, 'stand'); assert.equal(npc.goal, goal); assert.equal(npc.goalKey, goal.key);
  assert.ok(npc.pos.x > 20 && Math.hypot(npc.pos.x - bench.x, npc.pos.z - bench.z) >= .8);
  assert.equal(npc.held, true); assert.equal(npc.talkStaged, true); assert.equal(people.talkReservation, null);
  const standing = npc.pos.clone();
  assert.equal(people.prepareTalk(npc.id), false, 'reframing does not move an already standing partner');
  people.act({ kind: 'agent', id: npc.id }, 'talk');
  assert.equal(npc.action, 'talk');
  people.sync([board, neighbor]);
  assert.equal(npc.goal, goal); assert.deepEqual(npc.pos, standing);
  assert.equal(people.npcs.get(neighbor.id).goal.point.x, otherBench.x, 'the speaker keeps its bench while standing beside it');
  people.hold(npc.id, false);
  assert.equal(npc.action, 'sit'); assert.equal(npc.goal, goal);
  assert.equal(npc.pos.x, bench.x); assert.equal(npc.pos.z, bench.z);
  assert.equal(npc.held, false); assert.equal(npc.talkStaged, false);
});

test('seated talk uses the last known building and resumes its current status after Leave', t => {
  const { people } = manager(t);
  people.buildings.set(project.id, { ...project, seats: [{ x: 29, z: 18, fx: 0, fz: 1 }] });
  const board = { ...agent('last-known', 'mailbox', 'offline'), currentProjectId: 'missing', lastKnownProjectId: project.id };
  people.sync([board]);
  const npc = people.npcs.get('last-known'), goal = npc.goal;
  assert.equal(people.prepareTalk(npc.id), true);
  assert.equal(npc.action, 'stand'); assert.equal(npc.goal, goal); assert.ok(npc.pos.x > 20);
  const working = { ...board, status: 'active' };
  people.sync([working]); assert.equal(npc.goal, goal); assert.equal(npc.status, 'active');
  people.hold(npc.id, false); people.sync([working]);
  assert.equal(npc.goal.type, 'work'); assert.equal(npc.status, 'active'); assert.equal(npc.action, 'walk');
});

for (const condition of ['hidden', 'deleted', 'no-slot']) test(`seated talk safely stays seated with ${condition} project placement`, t => {
  const { people } = manager(t);
  people.buildings.set(project.id, { ...project, seats: [{ x: 29, z: 18, fx: 0, fz: 1 }] });
  people.sync([agent('seated', 'mailbox', 'offline')]);
  const npc = people.npcs.get('seated'), goal = npc.goal, position = npc.pos.clone(), path = npc.path;
  if (condition === 'hidden') npc.agent.cityProjectId = null;
  if (condition === 'deleted') people.buildings.delete(project.id);
  if (condition === 'no-slot') people.reserveTalkSpot = () => null;
  assert.equal(people.prepareTalk(npc.id), false);
  assert.equal(npc.action, 'sit'); assert.equal(npc.goal, goal); assert.equal(npc.path, path);
  assert.deepEqual(npc.pos, position); assert.equal(Boolean(npc.held), false);
  assert.equal(people.prepareTalk('missing'), false);
});

test('talk reservation skips a real Downtown work spot that overlaps a planter', t => {
  const { people } = manager(t), size = buildingSize({ metrics: { footprint: 3 } });
  const planted = { ...project, size, downtownBase: downtownBasePlan(size, project.cell),
    workSpot(slot) { return Building.prototype.workSpot.call(this, slot + 2); } };
  people.buildings.set(project.id, planted); people.sync([]);
  const boxes = talkPlanterBoxes([planted]), blocked = p => boxes.some(b => p.x > b.x0 && p.x < b.x1 && p.z > b.z0 && p.z < b.z1);
  const first = planted.workSpot(0);
  assert.equal(blocked(first), true, 'actual workSpot(2) intersects the front planter with avatar clearance');
  const reservation = people.reserveTalkSpot(project.id);
  assert.ok(reservation); assert.equal(blocked(reservation), false);
  assert.notEqual(reservation.x, first.x);
});

test('talk moves an existing standing partner out of a planter without changing its normal goal', t => {
  const { people } = manager(t), size = buildingSize({ metrics: { footprint: 3 } });
  const planted = { ...project, size, downtownBase: downtownBasePlan(size, project.cell),
    workSpot(slot) { return Building.prototype.workSpot.call(this, slot + 2); } };
  people.buildings.set(project.id, planted);
  const worker = agent('standing', 'session', 'active'); people.sync([worker]);
  const npc = people.npcs.get(worker.id), originalGoal = npc.goal, originalPosition = npc.pos.clone();
  const boxes = talkPlanterBoxes([planted]), blocked = p => boxes.some(b => p.x > b.x0 && p.x < b.x1 && p.z > b.z0 && p.z < b.z1);
  assert.equal(blocked(npc.pos), true, 'normal NPC placement has not been changed by the talk-only guard');
  assert.equal(people.prepareTalk(npc.id), true);
  assert.equal(blocked(npc.pos), false); assert.notDeepEqual(npc.pos, originalPosition);
  assert.equal(npc.action, 'stand'); assert.equal(npc.goal, originalGoal); assert.equal(npc.talkStaged, true);
  people.sync([worker]); assert.equal(npc.goal, originalGoal);
  const safePosition = npc.pos.clone();
  assert.equal(people.prepareTalk(npc.id), false, 'a clear standing partner is never moved again');
  assert.deepEqual(npc.pos, safePosition);
});

test('hidden bystanders and their clipboard props cannot steal picking from visible figures', t => {
  const { people } = manager(t);
  people.sync([agent('hidden-board'), agent('visible-board')]);
  const hidden = people.npcs.get('hidden-board'), visible = people.npcs.get('visible-board');
  for (const actor of [hidden, visible, people.owner]) {
    const body = new THREE.Object3D(); actor.person.object.add(body); actor.person.pickable.push(body);
  }
  const before = people.pickables(), hiddenProp = hidden.clipboard.children[0];
  assert.ok(before.includes(hidden.person.pickable[0]) && before.includes(hiddenProp));
  hidden.person.object.visible = false;
  const during = people.pickables();
  assert.equal(during.includes(hidden.person.pickable[0]), false); assert.equal(during.includes(hiddenProp), false);
  assert.ok(during.includes(visible.person.pickable[0]) && during.includes(visible.clipboard.children[0]));
  assert.ok(during.includes(people.owner.person.pickable[0]));
  people.owner.person.object.visible = false;
  assert.equal(people.pickables().includes(people.owner.person.pickable[0]), false);
  hidden.person.object.visible = true; people.owner.person.object.visible = true;
  assert.deepEqual(people.pickables(), before, 'restoring the figures restores their exact pick targets');
});
