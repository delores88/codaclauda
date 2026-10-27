import test from 'node:test';
import assert from 'node:assert/strict';
import { riverLot, polygonArea, subtractRect, inscribedRectangle, parcelEligible, riverfrontShape, pointInParcel, rectOverlap, PARCEL_MARGIN } from '../app/city/river-lots.js';
import { riverFootprintClear, riverCellUsable, bridgeSpan, riverContains, BRIDGE_CLEAR_Y } from '../app/city/river-path.js';
import { SlotMap } from '../app/city/layout.js';
import { districtBanks, districtCells, districtForCell, DISTRICTS } from '../app/city/districts.js';
import { Building } from '../app/city/buildings.js';
import { buildRiverLandscape } from '../app/city/river-lot-meshes.js';
import { THREE } from '../app/city/toon.js';
import { disposeAll } from '../app/city/fx.js';
globalThis.window ||= {};
globalThis.localStorage ||= { getItem: () => null };
const { CityView } = await import('../app/views/city.js');

function canvas(t) {
  const previous = globalThis.document;
  const context = new Proxy({ measureText: value => ({ width: value.length * 20 }), createLinearGradient: () => ({ addColorStop() {} }) }, { get: (o, p) => o[p] || (() => {}) });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  t.after(() => { globalThis.document = previous; });
}
test('polygon clipping subtracts ramps without double-counting area', () => {
  const polygon = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
  const pieces = subtractRect(polygon, { x0: 4, x1: 6, z0: 2, z1: 8 });
  assert.equal(pieces.reduce((sum, p) => sum + polygonArea(p), 0), 88);
  for (const p of pieces) for (const v of p) assert.ok(!(v.x > 4 && v.x < 6 && v.z > 2 && v.z < 8));
});
test('inscribed rectangle keeps frontage, chooses an offset maximum and excludes ramps', () => {
  const bounds = { x0: 0, x1: 10, z0: 0, z1: 10 };
  const edge = [{ x: 0, z: 7 }, { x: 4, z: 7 }, { x: 5, z: 2 }, { x: 10, z: 2 }];
  assert.deepEqual(inscribedRectangle(bounds, edge, 1), { x0: 5, x1: 10, z0: 2, z1: 10 });
  assert.deepEqual(inscribedRectangle(bounds, [{ x: 0, z: 0 }, { x: 10, z: 10 }], 1), { x0: 0, x1: 5, z0: 5, z1: 10 }, 'the maximum can fall between polygon vertices');
  const obstacle = { x0: 8, x1: 10, z0: 0, z1: 10 };
  const rect = inscribedRectangle(bounds, edge, 1, [obstacle]);
  assert.equal(rect.z1, 10); assert.ok(!rectOverlap(rect, obstacle));
});
test('eligibility enforces both dimensions and the independent 35 percent area threshold', () => {
  assert.equal(parcelEligible({ x0: 0, x1: 4, z0: 0, z1: 6 }, 35, 100), true);
  assert.equal(parcelEligible({ x0: 0, x1: 4, z0: 0, z1: 6 }, 34.99, 100), false);
  assert.equal(parcelEligible({ x0: 0, x1: 3.99, z0: 0, z1: 12 }, 80, 100), false);
  assert.equal(parcelEligible({ x0: 0, x1: 5.99, z0: 0, z1: 5.99 }, 80, 100), false);
  for (const district of DISTRICTS) {
    assert.equal(riverfrontShape({ x0: 0, x1: 10, z0: 0, z1: 4 }, district), district === 'downtown' ? 'terraced' : 'deck-house');
    assert.equal(riverfrontShape({ x0: 0, x1: 4, z0: 0, z1: 8 }, district), district === 'downtown' ? 'slim' : 'townhouse');
  }
});
test('all supported riverfront rectangles clear the curved corridor and the complete bridge approaches', () => {
  const sides = new Set(); let eligible = 0, slivers = 0;
  for (let i = -24; i <= 24; i++) for (const j of [-1, 0]) {
    const p = riverLot(i, j); if (!p) continue;
    if (!p.eligible) { slivers++; continue; }
    eligible++; sides.add(p.side); const r = p.rect;
    assert.ok(riverFootprintClear((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, (r.x1 - r.x0) / 2, (r.z1 - r.z0) / 2, PARCEL_MARGIN));
    for (const dx of [-8, 8]) assert.ok(!rectOverlap(r, bridgeSpan(i * 16 + dx)));
    assert.ok(pointInParcel({ x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 }, p));
    assert.equal(p.side > 0 ? r.z1 : r.z0, p.side > 0 ? p.bounds.z1 : p.bounds.z0);
  }
  assert.ok(eligible > 40 && slivers > 10); assert.deepEqual(sides, new Set([-1, 1]));
  assert.equal(BRIDGE_CLEAR_Y, 1.6, 'boat clearance is retained');
});
test('full lots fill before riverfront lots; saved riverfront pins and hidden reservations survive growth', () => {
  for (const choice of DISTRICTS) {
    const banks = districtBanks(choice), district = banks.positiveZ, slots = new SlotMap({ banks }); slots.rings = 3;
    const full = districtCells(3, district, banks).filter(c => riverCellUsable(c.i, c.j));
    const project = n => ({ id: `${district === 'downtown' ? 'gh:owner/' : 'local:'}parcel-${n}`, path: 'C:/sample' });
    const projects = full.map((_, n) => project(n));
    const first = slots.assign(projects);
    for (const c of first.cells.values()) assert.ok(riverCellUsable(c.i, c.j));
    const extra = project('extra'), next = slots.assign([...projects, extra]);
    const pin = next.cells.get(extra.id); assert.ok(riverLot(pin.i, pin.j)?.eligible);
    for (const [id, cell] of first.cells) assert.deepEqual(next.cells.get(id), cell);
    const pins = Object.fromEntries([...next.cells].map(([id, c]) => [id, { i: c.i, j: c.j }]));
    const expanded = [...projects, extra, ...Array.from({ length: 70 }, (_, n) => project(`new-${n}`))];
    assert.deepEqual(new SlotMap({ banks }).assign(expanded, { pins }).cells.get(extra.id), pin);
    const hidden = new SlotMap({ banks }).assign(projects, { pins, reserve: [extra] });
    assert.equal(hidden.reserved.get(`${pin.i},${pin.j}`).id, extra.id);
    for (const d of DISTRICTS) assert.ok(hidden.emptyPlots[d].length >= 3);
  }
});
test('actual riverfront meshes, outlines and landscapes fit both banks and have opaque building materials', t => {
  canvas(t); const shapes = new Set();
  for (const district of DISTRICTS) for (const cell of [{ i: 3, j: -1 }, { i: -3, j: -1 }, { i: 2, j: 0 }, { i: -1, j: 0 }]) {
    const p = riverLot(cell.i, cell.j); assert.ok(p.eligible);
    for (const unbuilt of district === 'downtown' ? [false, true] : [false]) {
      const project = { id: district === 'downtown' ? 'gh:sample/river' : 'local:river', name: 'River', path: unbuilt ? '' : 'C:/sample/river', metrics: { floors: 24, footprint: 3 } };
      const b = new Building(project, cell, { districts: true, particles: { emit() {} }, reducedMotion: () => true });
      shapes.add(b.riverPlan.shape); b.group.updateMatrixWorld(true);
      b.group.traverse(node => {
        if (!node.isMesh) return;
        assert.equal(node.material.transparent, false); assert.equal(node.material.opacity, 1);
        const a = node.geometry.attributes.position, v = new THREE.Vector3();
        for (let n = 0; n < a.count; n++) {
          v.fromBufferAttribute(a, n).applyMatrix4(node.matrixWorld);
          assert.ok(!riverContains(v.x, v.z, 0.8), `${node.name}: river intrusion`);
          assert.ok(v.x >= p.bounds.x0 - 0.001 && v.x <= p.bounds.x1 + 0.001 && v.z >= p.bounds.z0 - 0.001 && v.z <= p.bounds.z1 + 0.001, `${node.name}: outside cell`);
          for (const obstacle of p.obstacles) assert.ok(!(v.x > obstacle.x0 + 0.001 && v.x < obstacle.x1 - 0.001 && v.z > obstacle.z0 + 0.001 && v.z < obstacle.z1 - 0.001), `${node.name}: bridge intrusion`);
        }
      });
      if (unbuilt) { assert.equal(b.body.name, 'clone-foundation'); assert.deepEqual(b.seats, []);
        const visitor = b.workSpot(0); assert.ok(Math.abs(visitor.z - (b.origin.z + b.unbuiltSign.position.z)) < 0.5);
        b.update(0, 0, { reducedMotion: true, night: 0 }); const day = b.signLamp.material.emissiveIntensity;
        b.update(0, 0, { reducedMotion: true, night: 1 }); assert.ok(b.signLamp.material.emissiveIntensity > day);
        assert.ok(b.pickables.includes(b.body) && b.pickables.includes(b.plaque)); }
      b.dispose();
    }
  }
  assert.deepEqual(shapes, new Set(['terraced', 'slim', 'deck-house', 'townhouse']));
  const sliver = riverLot(2, -1), garden = buildRiverLandscape(sliver);
  assert.equal(sliver.eligible, false); assert.ok(garden.getObjectByName('riverfront-lawn')); assert.ok(garden.getObjectByName('riverfront-bench')); assert.ok(garden.getObjectByName('riverfront-reeds')); disposeAll(garden);
});
test('empty dry riverfront plot clicks use Create/Link, while bank and occupied points are rejected', async () => {
  const parcel = riverLot(3, -1), r = parcel.rect; let ground = { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 };
  const v = Object.assign(Object.create(CityView.prototype), { visible: true, world: { settled: true, side: 'pc', ndc() {}, groundAt: () => ground }, rings: 3, homeBanks: districtBanks(), occupied: new Set(), reserved: new Map() });
  const target = v.plotAt(0, 0); assert.equal(target.kind, 'plot'); assert.equal(target.i, 3); assert.equal(target.j, -1);
  let clicked; v.startProjectOnPlot = t => { clicked = t; }; v.onClick(target); await new Promise(resolve => setTimeout(resolve, 320)); assert.equal(clicked, target);
  v.occupied.add('3,-1'); assert.equal(v.plotAt(0, 0), null); v.occupied.clear(); ground = { x: 48, z: -16 }; assert.equal(v.plotAt(0, 0), null);
});
test('both clone foundation and sign ray hits route to the preselected repo Clone action', t => {
  canvas(t); const p = { id: 'gh:sample/clone', name: 'Clone', path: '', metrics: {} };
  const b = new Building(p, { i: 1, j: -2 }, { districts: true, particles: { emit() {} }, reducedMotion: () => true });
  let cloned; const v = Object.assign(Object.create(CityView.prototype), { world: { side: 'pc' }, buildings: { get: () => b }, cloneOutline: p => { cloned = p; } });
  for (const mesh of [b.body, b.plaque]) { v.onClick({ kind: 'building', id: mesh.userData.buildingId }); assert.equal(cloned, p); }
  b.dispose();
});
