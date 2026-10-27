import assert from 'node:assert/strict';
import test from 'node:test';
import { THREE } from '../app/city/toon.js';
import { Building, BuildingManager } from '../app/city/buildings.js';
import { NpcManager, groundY } from '../app/city/npc.js';
import { LOT_HALF, PITCH, islandHalf } from '../app/city/layout.js';
import { buildDecor } from '../app/city/scenery.js';
import { districtForCell, districtBanks, DISTRICTS, DOWNTOWN } from '../app/city/districts.js';
import { PARK_TYPES } from '../app/city/parks.js';
import { riverZ, riverFootprintClear, bridgeCrossings } from '../app/city/river-path.js';
import { disposeAll } from '../app/city/fx.js';

function canvas(t) {
  const original = globalThis.document, text = [], gradient = { addColorStop() {} };
  const context = new Proxy({ measureText: value => ({ width: String(value).length * 20 }), createLinearGradient: () => gradient, fillText: value => text.push(value) }, { get: (object, property) => object[property] || (() => {}) });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  t.after(() => { if (original) globalThis.document = original; else delete globalThis.document; });
  return text;
}
const project = (footprint = 1, local = false) => ({ id: 'gh:owner/lot', name: 'Lot', ...(local ? { path: 'C:/lot' } : {}), metrics: { footprint, floors: 4 } });
const make = (p, cell = { i: 0, j: -2 }, options = {}) => new Building(p, cell, { particles: { emit() {} }, reducedMotion: () => true, districts: true, ...options });
const bounds = mesh => new THREE.Box3().setFromObject(mesh);

/** Each newly added column contributes its closest eligible Downtown lot to the
 * river. Eligibility, rather than an obsolete fixed row, follows the shared path. */
function boundaryLots(banks) {
  const seen = new Set(), groups = [];
  for (const rings of [2, 4, 8, 12]) {
    const cells = [];
    for (let i = -rings; i <= rings; i++) {
      const candidates = [];
      for (let j = -rings; j <= rings; j++) if (districtForCell({ i, j }, banks) === DOWNTOWN) candidates.push(j);
      candidates.sort((a, b) => Math.abs(a * PITCH - riverZ(i * PITCH)) - Math.abs(b * PITCH - riverZ(i * PITCH)));
      if (!candidates.length) continue;
      const j = candidates[0];
      const id = `${i},${j}`;
      if (!seen.has(id)) { seen.add(id); cells.push({ i, j }); }
    }
    assert.ok(cells.length > 0, `expansion to ring ${rings} contributes eligible river-side lots`);
    groups.push({ rings, cells });
  }
  return groups;
}

/** Check actual merged triangles, including every outline, against independent
 * water/bank footprints and the rendered bridge approaches. */
function auditTriangles(root, crossings, visit) {
  root.updateWorldMatrix(true, true);
  const point = new THREE.Vector3(), center = new THREE.Vector3(), size = new THREE.Vector3();
  let triangles = 0, outlineTriangles = 0;
  root.traverse(node => {
    if (!node.isMesh) return;
    assert.equal(Boolean(node.isInstancedMesh), false, 'these bases and parks use merged geometry');
    const attr = node.geometry.attributes.position, index = node.geometry.index;
    for (let i = 0; i < (index?.count || attr.count); i += 3) {
      const box = new THREE.Box3();
      for (let n = 0; n < 3; n++) box.expandByPoint(point.fromBufferAttribute(attr, index ? index.getX(i + n) : i + n).applyMatrix4(node.matrixWorld));
      box.getCenter(center); box.getSize(size);
      const halfX = Math.max(0, size.x / 2 - 1e-5), halfZ = Math.max(0, size.z / 2 - 1e-5);
      assert.ok(riverFootprintClear(center.x, center.z, halfX, halfZ), `${node.name || node.type}: water/bank intrusion at ${center.x},${center.z}`);
      for (const bridge of crossings) {
        const separate = center.x + halfX < bridge.x0 - .35 || center.x - halfX > bridge.x1 + .35 || center.z + halfZ < bridge.z0 - .35 || center.z - halfZ > bridge.z1 + .35;
        assert.ok(separate, `${node.name || node.type}: intrusion into ${bridge.id} or its rail clearance`);
      }
      visit(box, node);
      triangles++;
      if (node.userData.outline || node.name === 'park-outlines') outlineTriangles++;
    }
  });
  assert.ok(triangles > 0);
  return { triangles, outlineTriangles };
}

function insideLot(box, cell) {
  assert.ok(box.min.x >= cell.i * PITCH - LOT_HALF - 1e-5 && box.max.x <= cell.i * PITCH + LOT_HALF + 1e-5, 'x remains in the usable lot');
  assert.ok(box.min.z >= cell.j * PITCH - LOT_HALF - 1e-5 && box.max.z <= cell.j * PITCH + LOT_HALF + 1e-5, 'z remains in the usable lot');
}

test('ghost lots have lawn and a street path instead of a solid pad; clone sign stays pickable', t => {
  const drawn = canvas(t), b = make(project());
  assert.ok(b.padGroup.getObjectByName('downtown-lawn'));
  assert.ok(b.padGroup.getObjectByName('downtown-entry-walk'));
  assert.equal(b.padGroup.getObjectByName('downtown-paving'), undefined);
  assert.ok(drawn.includes('\u2193 Clone to build'));
  assert.ok(b.unbuilt && b.bodyMaterial.opacity === 1);
  assert.ok(b.pickables.includes(b.body) && b.pickables.includes(b.plaque));
  assert.equal(b.plaque.userData.buildingId, b.id);
  b.group.updateMatrixWorld(true);
  const lawn = bounds(b.padGroup.getObjectByName('downtown-lawn'));
  assert.ok(lawn.min.x <= -5.1 && lawn.max.x >= 5.1);
  assert.ok(Math.abs(lawn.getCenter(new THREE.Vector3()).z - b.cell.j * 16) < 1e-5, 'lawn is centred on the lot, not the offset tower');
  const walk = bounds(b.padGroup.getObjectByName('downtown-entry-walk'));
  assert.ok(walk.max.y > lawn.max.y + 0.005, 'path sits above the lawn without coplanar flicker');
  assert.ok(walk.max.z >= b.cell.j * 16 + 5.1, 'entry reaches the street edge of the lot');
  b.dispose();
});

test('tower paving stays close to its footprint while lawn survives outside it', t => {
  canvas(t);
  for (const footprint of [1, 2, 3]) {
    const b = make(project(footprint, true)); b.group.updateMatrixWorld(true);
    const paving = b.padGroup.getObjectByName('downtown-paving');
    assert.ok(paving && b.padGroup.getObjectByName('downtown-lawn'));
    assert.ok(b.padGroup.getObjectByName('downtown-entry-walk'));
    assert.ok(b.downtownBase.plants.length >= 2 && b.downtownBase.plants.length <= 4);
    const plants = b.padGroup.getObjectByName('downtown-planters');
    assert.ok(plants && plants.children.length <= 3, 'plants share material batches');
    const size = bounds(paving).getSize(new THREE.Vector3());
    assert.ok(size.x >= b.size.W && size.x <= b.size.W + 2.1);
    assert.ok(size.z >= b.size.D && size.z <= b.size.D + 2.1);
    assert.ok(Math.abs(bounds(paving).max.y - 0.26) < 0.04, 'tower platform height is preserved');
    assert.ok(size.x < LOT_HALF * 2 && size.z < LOT_HALF * 2);
    b.dispose();
  }
});

test('landscape geometry clears the lot and bridge approaches for all tower footprints', t => {
  canvas(t);
  let bases = 0, triangles = 0, outlines = 0;
  for (const larger of DISTRICTS) for (const { rings, cells } of boundaryLots(districtBanks(larger))) {
    const crossings = bridgeCrossings(islandHalf(rings));
    for (const cell of cells) for (const footprint of [1, 2, 3]) for (const local of [false, true]) {
      const b = make(project(footprint, local), cell);
      const audit = auditTriangles(b.padGroup, crossings, box => insideLot(box, cell));
      bases++; triangles += audit.triangles; outlines += audit.outlineTriangles;
      b.dispose();
    }
  }
  assert.ok(outlines > 0, 'real base outlines participate in the clearance audit');
  t.diagnostic(`${bases} ghost/tower bases; ${triangles} triangles, including ${outlines} outline triangles`);
});

test('all six parks produced by merged scenery clear the river and bridge approaches as the island expands', t => {
  let parks = 0, triangles = 0, outlines = 0;
  for (const larger of DISTRICTS) {
    const banks = districtBanks(larger), types = new Set();
    for (const { rings, cells } of boundaryLots(banks)) {
      const chosen = new Map(cells.map(cell => [`${cell.i},${cell.j}`, cell])), occupied = new Map();
      for (let i = -rings; i <= rings; i++) for (let j = -rings; j <= rings; j++) {
        if ((!i && !j) || !districtForCell({ i, j }, banks) || chosen.has(`${i},${j}`)) continue;
        occupied.set(`${i},${j}`, { i, j, padW: 5.8, padD: 5.4, cz: -.3 });
      }
      const decor = buildDecor(rings, occupied, islandHalf(rings), { districts: true, banks });
      const parkGroup = decor.getObjectByName('downtown-parks'); assert.ok(parkGroup);
      assert.equal(parkGroup.userData.parks.length, chosen.size, 'only the eligible vacant boundary lots become parks');
      for (const park of parkGroup.userData.parks) {
        assert.ok(chosen.has(`${park.i},${park.j}`)); types.add(park.type); parks++;
      }
      const audit = auditTriangles(parkGroup, bridgeCrossings(islandHalf(rings)), box => {
        const center = box.getCenter(new THREE.Vector3()), cell = { i: Math.round(center.x / PITCH), j: Math.round(center.z / PITCH) };
        assert.ok(chosen.has(`${cell.i},${cell.j}`), 'every merged park triangle belongs to a selected valid lot');
        insideLot(box, cell);
      });
      triangles += audit.triangles; outlines += audit.outlineTriangles;
      disposeAll(decor);
    }
    assert.deepEqual([...types].sort(), [...PARK_TYPES].sort(), `${larger} on the larger bank covers all six park designs`);
  }
  assert.ok(outlines > 0, 'merged park ink hulls participate in the clearance audit');
  t.diagnostic(`${parks} parks across all six types; ${triangles} triangles, including ${outlines} outline triangles`);
});

test('linking and unlinking a ghost rebuilds the base without moving its pin or leaking geometry', t => {
  canvas(t);
  const b = make(project()), cell = { ...b.cell }, origin = { ...b.origin }, at = b.group.position.toArray();
  for (const local of [true, false, true]) {
    const resources = new Set(), released = new Set();
    b.padGroup.traverse(node => { if (node.geometry && !node.geometry.userData.shared) resources.add(node.geometry); });
    for (const resource of resources) resource.addEventListener('dispose', () => released.add(resource));
    assert.equal(b.apply(project(1, local)), true);
    assert.equal(released.size, resources.size);
    assert.equal(b.unbuilt, !local);
    assert.equal(Boolean(b.padGroup.getObjectByName('downtown-paving')), local);
    assert.deepEqual(b.cell, cell); assert.deepEqual(b.origin, origin); assert.deepEqual(b.group.position.toArray(), at);
  }
  b.dispose();
});

test('Spark and contributor buildings retain their established base renderer', t => {
  canvas(t);
  for (const options of [{ mirror: true }, { districts: false }]) {
    const b = make(project(1, true), undefined, options);
    assert.equal(b.padGroup.getObjectByName('downtown-lawn'), undefined);
    assert.ok(b.pad.isMesh);
    assert.equal(b.groundAt(b.origin.x, b.origin.z), null, 'other island renderers retain their existing height lookup');
    b.dispose();
  }
});

test('initial metrics and reduced motion finish Downtown lawn arrival scale', t => {
  canvas(t);
  const particles = { emit() {}, enabled: false };
  for (const local of [false, true]) for (const reduced of [false, true]) {
    const initial = project(1, local);
    const b = make(initial, undefined, { animateIn: true, reducedMotion: () => false, particles });
    assert.deepEqual(b.padGroup.scale.toArray(), [0.6, 0.6, 0.6]);
    if (!reduced) {
      b.apply({ ...initial, metrics: { ...initial.metrics, floors: 8 } });
      assert.equal(b.anim.kind, 'grow');
      assert.deepEqual(b.padGroup.scale.toArray(), [1, 1, 1], 'floor growth must not strand an arrival-scaled lawn');
    }
    b.update(2, 2, { reducedMotion: reduced, particles });
    assert.equal(b.anim, null);
    assert.deepEqual(b.tower.scale.toArray(), [1, 1, 1]);
    assert.deepEqual(b.padGroup.scale.toArray(), [1, 1, 1]);
    b.dispose();
  }
});

test('Downtown walking heights match rendered ghost lawns, tower paving and entry paths during base scaling', t => {
  canvas(t);
  const particles = { emit() {}, enabled: false }, cell = { i: 0, j: -2 };
  for (const local of [false, true]) {
    const p = project(1, local), manager = new BuildingManager(new THREE.Group(), { particles, reducedMotion: () => false });
    manager.sync([p], new Map([[p.id, cell]]), new Set(), { districts: true, animate: false });
    const building = manager.get(p.id), plan = building.downtownBase;
    const npcs = new NpcManager(new THREE.Group(), { buildings: manager, particles, reducedMotion: () => true });
    const points = [
      { name: 'lawn', x: 4.8, z: plan.lawn.z },
      // The end of the path extends beyond the lawn and must remain walkable.
      { name: 'entry', x: 0, z: plan.entry.z + plan.entry.d * .49 },
    ];
    if (local) points.push({ name: 'paving', x: building.size.W / 2 + .5, z: 0 });
    for (const scale of [[1, 1, 1], [.6, .6, .6], [.82, .75, .74]]) {
      building.padGroup.scale.set(...scale); building.group.updateWorldMatrix(true, true);
      for (const point of points) {
        const x = building.origin.x + point.x * scale[0], z = building.origin.z + point.z * scale[2];
        const ray = new THREE.Raycaster(new THREE.Vector3(x, 10, z), new THREE.Vector3(0, -1, 0)), hits = [];
        building.padGroup.traverse(mesh => {
          if (mesh.isMesh && !mesh.userData.outline) THREE.Mesh.prototype.raycast.call(mesh, ray, hits);
        });
        hits.sort((a, b) => a.distance - b.distance); assert.ok(hits.length, `${point.name} has a rendered supporting surface`);
        const actual = hits[0].point.y;
        assert.ok(Math.abs(manager.groundAt(x, z) - actual) < 1e-6, `${local ? 'tower' : 'ghost'} ${point.name} height matches geometry at scale ${scale}`);
        assert.ok(Math.abs(npcs.surfaceY(x, z) - actual) < 1e-6, 'NPC integration uses the building surface');
      }
      const x = building.origin.x + 7 * scale[0], z = building.origin.z;
      assert.equal(manager.groundAt(x, z), null, 'outside the scaled base returns to the normal street surface');
      assert.equal(npcs.surfaceY(x, z), groundY(x, z));
    }
    npcs.dispose(); manager.dispose();
  }
});
