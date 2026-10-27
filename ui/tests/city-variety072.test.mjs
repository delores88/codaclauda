import assert from 'node:assert/strict';
import test from 'node:test';
import { THREE } from '../app/city/toon.js';
import { Building, buildingSize } from '../app/city/buildings.js';
import { towerLook, towerBlocks, TOWER_SILHOUETTES, TOWER_PALETTES, offsetPolygon, signedArea, roundedRectPoints } from '../app/city/architecture.js';
import { riverLot, riverfrontFootprintFor, pointInParcel, PARCEL_MARGIN } from '../app/city/river-lots.js';
import { riverContains } from '../app/city/river-path.js';

const particles = { enabled: false, emit() {} };
function canvas(t) {
  const previous = globalThis.document;
  const context = new Proxy({ measureText: v => ({ width: String(v).length * 20 }), createLinearGradient: () => ({ addColorStop() {} }) }, { get: (o, p) => o[p] || (() => {}) });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  t.after(() => { globalThis.document = previous; });
}
const repo = (n, floors = 8, footprint = 2) => ({ id: `gh:owner/repo-${n}`, path: `C:/repo-${n}`, name: `Repo ${n}`, primaryLanguage: 'TypeScript', source: 'both', metrics: { floors, footprint } });

test('Downtown looks are stable per project and lot, and edge neighbours never share a silhouette', () => {
  const seen = new Set(), palettes = new Set();
  for (let n = 0; n < 60; n++) {
    const a = repo(n), cell = { i: n % 7 - 3, j: -2 - (n % 3) };
    assert.deepEqual(towerLook(a, cell), towerLook({ ...a, name: 'Renamed', metrics: { floors: 20, footprint: 3 } }, cell));
    seen.add(towerLook(a, cell).silhouette); palettes.add(towerLook(a, cell).palette.name);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      assert.notEqual(towerLook(a, cell).silhouette, towerLook(repo(n + 100), { i: cell.i + di, j: cell.j + dj }).silhouette);
    }
  }
  assert.deepEqual(seen, new Set(TOWER_SILHOUETTES));
  assert.equal(palettes.size, TOWER_PALETTES.length);
});

test('every silhouette builds grounded blocks within the lot footprint from one to 24 floors', () => {
  for (const floors of [1, 2, 3, 6, 12, 24]) for (const footprint of [1, 3]) {
    const size = buildingSize({ metrics: { floors, footprint } });
    for (const silhouette of TOWER_SILHOUETTES) {
      const plan = towerBlocks(size, silhouette);
      assert.ok(plan.blocks.some(b => b.y === 0), `${silhouette} touches the ground`);
      for (const b of plan.blocks) {
        assert.ok(b.h > 0 && b.w > 0 && b.d > 0);
        assert.ok(Math.abs(b.x) + b.w / 2 <= size.W / 2 + 1e-9 && Math.abs(b.z) + b.d / 2 <= size.D / 2 + 1e-9, `${silhouette} stays inside its footprint`);
        assert.ok(b.y === 0 || plan.blocks.some(o => o !== b && Math.abs(o.y + o.h - b.y) < 1e-9), `${silhouette} upper blocks rest on a lower block`);
      }
      assert.ok(Math.abs(plan.H - size.H) < 1e-9, `${silhouette} keeps the project height`);
    }
  }
});

test('varied towers render opaque, carry a roofed CI point, and place the crane on the top block', t => {
  canvas(t);
  const found = new Set();
  for (let n = 0; n < 40 && found.size < TOWER_SILHOUETTES.length; n++) {
    const project = repo(n, 10, 2), cell = { i: 2 + (n % 4), j: -3 - (Math.floor(n / 4) % 2) };
    const b = new Building(project, cell, { districts: true, reducedMotion: () => true, animateIn: false, particles });
    if (!b.look) { b.dispose(); continue; }
    found.add(b.look.silhouette);
    b.setActive(true); b.group.updateMatrixWorld(true);
    b.tower.traverse(node => { if (node.isMesh && !node.isInstancedMesh) { assert.equal(node.material.transparent, false); assert.equal(node.material.opacity, 1); } });
    const point = b.rooftopPoint().add(new THREE.Vector3(b.origin.x, 0, b.origin.z));
    const hit = new THREE.Raycaster(point.clone().add(new THREE.Vector3(0, 0.6, 0)), new THREE.Vector3(0, -1, 0)).intersectObjects(b.pickables, false)[0];
    assert.ok(hit && hit.point.y >= point.y - 0.45, `${b.look.silhouette}: CI beacon point rests on the roof`);
    const top = b.towerPlan.top;
    assert.ok(Math.abs(b.jib.parent.position.x - top.x) < 1e-9 && Math.abs(b.jib.parent.position.z - top.z) < 1e-9, 'crane stands on the top block');
    b.dispose();
  }
  assert.deepEqual(found, new Set(TOWER_SILHOUETTES));
});

test('polygon helpers offset outward regardless of winding', () => {
  const square = [{ x: -1, z: -1 }, { x: 1, z: -1 }, { x: 1, z: 1 }, { x: -1, z: 1 }];
  for (const poly of [square, [...square].reverse()]) {
    const out = offsetPolygon(poly, 0.5);
    assert.ok(Math.abs(Math.abs(signedArea(out)) - 9) < 1e-6);
  }
  const rr = roundedRectPoints(4, 2, 0.6);
  assert.ok(Math.abs(signedArea(rr)) < 8 && Math.abs(signedArea(rr)) > 7.5);
});

test('riverfront footprints follow the bank curve, stay dry and keep a straight street front', () => {
  let curved = 0, checked = 0;
  for (let i = -24; i <= 24; i++) for (const j of [-1, 0]) {
    const parcel = riverLot(i, j); if (!parcel?.eligible) continue;
    for (const district of ['downtown', 'suburbs']) { const foot = riverfrontFootprintFor(parcel, district); assert.ok(foot, `${i},${j} ${district} has a footprint`); checked++;
    assert.ok(foot.x1 - foot.x0 >= 4 && foot.minDepth >= 2.2);
    for (const p of foot.points) {
      assert.ok(!riverContains(p.x, p.z, PARCEL_MARGIN - 0.01), 'footprint stays clear of the bank');
      assert.ok(p.x >= parcel.bounds.x0 && p.x <= parcel.bounds.x1 && p.z >= parcel.bounds.z0 && p.z <= parcel.bounds.z1);
    }
    for (const p of foot.points) assert.ok(pointInParcel({ x: p.x * 0.999 + (parcel.rect.x0 + parcel.rect.x1) / 2 * 0.001, z: p.z }, parcel) || Math.abs(p.z - foot.front) < 1e-9, 'water edge vertices lie on dry land');
    if (foot.maxDepth - foot.minDepth > 0.4) curved++; }
  }
  assert.ok(checked > 40);
  assert.ok(curved > checked / 4, 'many riverfront buildings visibly follow the curve');
});
