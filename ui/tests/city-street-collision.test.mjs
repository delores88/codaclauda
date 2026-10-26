import assert from 'node:assert/strict';
import test from 'node:test';
import { Building } from '../app/city/buildings.js';
import { suburbPlan } from '../app/city/suburbs.js';
import { GROUND_Y } from '../app/city/scenery.js';
import { streetMove } from '../app/city/npc.js';
import { buildingStreetBoxes, buildingSolidAt } from '../app/city/street-collision.js';

const radius = 0.35, particles = { enabled: false, emit() {} };
function canvas(t) {
  const original = globalThis.document, gradient = { addColorStop() {} };
  const context = new Proxy({ measureText: text => ({ width: String(text).length * 20 }), createLinearGradient: () => gradient }, { get: (obj, prop) => prop in obj ? obj[prop] : () => {} });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  t.after(() => { if (original) globalThis.document = original; else delete globalThis.document; });
}
function home(t, variant, tier = 1) {
  const project = { id: 'local:street-home', name: 'Street home', metrics: { footprint: tier, floors: 1 } };
  let cell;
  for (let i = -12; i <= 12; i++) { const candidate = { i, j: 2 }; if (suburbPlan(project, candidate).variant === variant) { cell = candidate; break; } }
  assert.ok(cell);
  const building = new Building(project, cell, { particles, reducedMotion: () => false, districts: true, animateIn: false });
  t.after(() => building.dispose());
  return building;
}
const solid = (building, point) => buildingSolidAt(building, point, radius, GROUND_Y);

test('walking and zoom stop at offset home walls missed by the centered tower footprint', t => {
  canvas(t);
  let formerlyMissed = 0;
  for (const variant of [0, 1, 2, 3]) for (const tier of [1, 3]) {
    const building = home(t, variant, tier), blocks = building.suburbs.blocks;
    const back = blocks.reduce((a, b) => a.z - a.d / 2 < b.z - b.d / 2 ? a : b);
    const wall = { x: building.origin.x + back.x, z: building.origin.z + back.z - back.d / 2 + 0.02, y: 0.26 + back.bottom + back.h / 2 };
    if (Math.abs(wall.z - building.origin.z) > building.size.D / 2 + 0.14 + radius) formerlyMissed++;
    assert.ok(solid(building, wall), 'wheel zoom sees the actual rear wall');
    const boxes = buildingStreetBoxes(building, radius, GROUND_Y);
    let at = { x: wall.x, z: Math.min(...boxes.map(box => box.z0)) - 1 };
    for (let step = 0; step < 150; step++) at = streetMove(at.x, at.z, 0, 0.025, { boxes });
    assert.ok(at.z < wall.z - radius, 'walking cannot enter the rear wall');
  }
  assert.ok(formerlyMissed >= 6, 'fixtures exercise offset walls beyond the legacy centered footprint');
});

test('the L-shaped home leaves its actual open courtyard walkable', t => {
  canvas(t);
  const building = home(t, 1), point = { x: building.origin.x + 0.25, z: building.origin.z + 0.7, y: 1.2 };
  assert.ok(Math.abs(point.x - building.origin.x) < building.size.W / 2 && Math.abs(point.z - building.origin.z) < building.size.D / 2);
  assert.equal(solid(building, point), false);
  const moved = streetMove(point.x, point.z, 0, 0.2, { boxes: buildingStreetBoxes(building, radius, GROUND_Y) });
  assert.equal(moved.blocked, false);
});

test('the contractor van blocks walking only while it exists', t => {
  canvas(t);
  const building = home(t, 0), drive = building.suburbs.driveway;
  const point = { x: building.origin.x + drive.x, z: building.origin.z + Math.min(4.2, drive.minZ + 1.25), y: 0.9 };
  assert.equal(solid(building, point), false);
  building.setActive(true); assert.equal(solid(building, point), true);
  building.setActive(false); assert.equal(solid(building, point), false);
});

test('shrinking homes retain collision coverage of their currently visible walls', t => {
  canvas(t);
  const building = home(t, 2, 3);
  building.apply({ ...building.project, metrics: { footprint: 1, floors: 1 } });
  assert.equal(building.anim.kind, 'widen');
  const rear = building.suburbs.blocks.reduce((a, b) => a.z - a.d / 2 < b.z - b.d / 2 ? a : b);
  const point = { x: building.origin.x + rear.x * building.tower.scale.x,
    z: building.origin.z + (rear.z - rear.d / 2 + 0.02) * building.tower.scale.z, y: 0.9 };
  assert.ok(solid(building, point));
});

test('non-home walking and camera bounds keep their established dimensions', t => {
  canvas(t);
  for (const mode of [{ districts: true }, { districts: false }, { districts: true, mirror: true }]) {
    const building = new Building({ id: 'gh:owner/legacy', path: 'C:/legacy', name: 'Legacy', primaryLanguage: 'Rust', metrics: { floors: 5, footprint: 2 } }, { i: -1, j: -2 }, { particles, reducedMotion: () => false, animateIn: false, ...mode });
    t.after(() => building.dispose());
    assert.equal(building.collisionBoxes, null);
    for (const dx of [-5, -3, 0, 3, 5]) for (const dz of [-5, -3, 0, 3, 5]) for (const y of [1, 8, 30]) {
      const point = { x: building.origin.x + dx, z: building.origin.z + dz, y };
      const expected = y < GROUND_Y + building.size.H + 0.6 && Math.abs(dx) < building.size.W / 2 + 0.14 + radius && Math.abs(dz) < building.size.D / 2 + 0.14 + radius;
      assert.equal(solid(building, point), expected);
    }
  }
});
