import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { NpcManager } from '../app/city/npc.js';
import { Building } from '../app/city/buildings.js';

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
