import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { NpcManager, groundY } from '../app/city/npc.js';
import { Building } from '../app/city/buildings.js';
import { WALK_HALF } from '../app/city/layout.js';
import { riverContains } from '../app/city/river-path.js';

const agent = (id, status = 'active', currentProjectId = null, homeProjectId = null) => ({ id, status, currentProjectId, homeProjectId, look: {} });
function manager(t, entries = [], resolveProjectId = id => id) {
  const parent = new THREE.Group(), buildings = new Map(entries.map(b => [b.id, b]));
  const npcs = new NpcManager(parent, { buildings, resolveProjectId, reducedMotion: () => true });
  npcs.setCreate(() => ({ object: new THREE.Group(), pickable: [], setSpec() {}, setStatus() {}, setAction() {}, lookAt() {}, update() {}, dispose() {} }));
  t.after(() => npcs.dispose());
  return npcs;
}
function building(id, home = false) {
  return { id, home, cell: { i: 2, j: 1 }, origin: { x: 32, z: 15.7 }, size: { W: 2.6, D: 3 }, door: { x: 30, z: 18 },
    seats: [], workSpot: Building.prototype.workSpot };
}
const positions = npcs => Object.fromEntries([...npcs.npcs].map(([id, n]) => [id, [n.pos.x, n.pos.y, n.pos.z]]));
function separated(points, minimum = .72) {
  for (let a = 0; a < points.length; a++) for (let b = a + 1; b < points.length; b++) {
    assert.ok(Math.hypot(points[a].x - points[b].x, points[a].z - points[b].z) >= minimum - 1e-9, `agents ${a} and ${b} overlap`);
  }
}

test('current and home aliases resolve to their canonical building for every activity state', t => {
  const b = building('local:project'); b.seats = [{ x: 29, z: 19, fx: 1, fz: 0 }];
  const people = manager(t, [b], id => ['gh:owner/project', 'local:former'].includes(id) ? b.id : id);
  people.sync([agent('working', 'active', 'gh:owner/project'), agent('idle', 'idle', null, 'local:former'), agent('offline', 'offline', null, 'gh:owner/project')]);
  assert.match(people.npcs.get('working').goalKey, /work:local:project:/);
  assert.deepEqual(people.npcs.get('idle').goal.cell, b.cell);
  assert.match(people.npcs.get('offline').goalKey, /sit:lot:local:project:/);
  assert.deepEqual(people.npcs.get('offline').goal.point, { ...b.seats[0], key: `lot:${b.id}:0` });
  assert.ok(people.npcs.get('working').pos.x > 20 && people.npcs.get('idle').pos.x > 20);
});

test('many workers at narrow tower and home doorways use distinct person-sized slots', t => {
  for (const home of [false, true]) {
    const b = building(home ? 'local:house' : 'gh:owner/tower', home), people = manager(t, [b]);
    const agents = Array.from({ length: 32 }, (_, n) => agent(`worker-${String(n).padStart(2, '0')}`, 'active', b.id));
    people.sync(agents);
    const points = [...people.npcs.values()].map(n => n.goal.point);
    separated(points);
    assert.ok(points.every(p => Math.abs(p.x - 32) <= WALK_HALF + 1e-8 && Math.abs(p.z - 16) <= WALK_HALF + 1e-8), 'overflow stays at its own lot');
    const before = positions(people); people.sync([...agents].reverse());
    assert.deepEqual(positions(people), before, 'source order does not reshuffle slots');
  }
});

test('unassigned mixed-status agents form a deterministic, dry HQ perimeter instead of stacking', t => {
  const people = manager(t), agents = Array.from({ length: 32 }, (_, n) => agent(`unassigned-${String(n).padStart(2, '0')}`, ['active', 'idle', 'offline'][n % 3], n % 2 ? 'missing:project' : null));
  people.sync(agents);
  const points = [...people.npcs.values()].map(n => n.pos);
  separated(points, .9);
  for (const p of points) {
    assert.equal(Math.max(Math.abs(p.x), Math.abs(p.z)), WALK_HALF);
    assert.equal(p.y, groundY(p.x, p.z)); assert.equal(riverContains(p.x, p.z, .3), false);
    assert.ok(Math.hypot(p.x, p.z - 4.35) > .72, 'owner spawn stays free');
  }
  const before = positions(people); people.sync([...agents].reverse()); assert.deepEqual(positions(people), before);
  people.sync(agents, { quality: 'low' }); assert.deepEqual(positions(people), before, 'quality remesh does not spawn people together at HQ door');
});

test('a resolved building replaces fallback goals, and no-seat offline homes keep people at their project', t => {
  const b = building('local:project', true); let canonical = false;
  const people = manager(t, [b], id => canonical && id === 'gh:owner/project' ? b.id : id);
  const agents = [agent('a', 'active', 'gh:owner/project'), agent('b', 'offline', null, 'gh:owner/project')];
  people.sync(agents); assert.ok(people.npcs.get('a').goalKey.includes(':hq:'));
  canonical = true; people.sync(agents);
  assert.ok(people.npcs.get('a').goalKey.includes(b.id)); assert.ok(people.npcs.get('b').goalKey.includes(b.id));
  assert.equal(people.npcs.get('b').goal.type, 'rest'); separated(agents.map(a => people.npcs.get(a.id).goal.point));
  assert.ok(people.npcs.get('a').path.length && people.npcs.get('b').path.length, 'existing people walk to newly resolved building');
});
