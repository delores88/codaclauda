import assert from 'node:assert/strict';
import test from 'node:test';
import { THREE } from '../app/city/toon.js';
import { downtownPlazaPlan, buildDecor, buildRoads, riverSceneryClear, BENCH_OFFSET } from '../app/city/scenery.js';
import { LOT_HALF, islandHalf } from '../app/city/layout.js';
import { disposeAll } from '../app/city/fx.js';
import { riverZ, riverCellUsable, riverFootprintClear, bridgeSpan } from '../app/city/river-path.js';

function fakeCanvas(t) {
  const original = globalThis.document;
  const gradient = { addColorStop() {} };
  const context = { createRadialGradient: () => gradient, fillRect() {} };
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  t.after(() => { if (original) globalThis.document = original; else delete globalThis.document; });
}

/** Inspect real render geometry; merged meshes are checked triangle by triangle,
 * and every instance uses its complete transformed bounds including outlines. */
function renderedBounds(root, visit) {
  root.updateMatrixWorld(true);
  const local = new THREE.Matrix4(), matrix = new THREE.Matrix4(), point = new THREE.Vector3();
  root.traverse(node => {
    if (!node.isMesh) return;
    const geometry = node.geometry;
    if (node.isInstancedMesh) {
      geometry.computeBoundingBox();
      for (let i = 0; i < node.count; i++) {
        node.getMatrixAt(i, local); matrix.multiplyMatrices(node.matrixWorld, local);
        visit(geometry.boundingBox.clone().applyMatrix4(matrix), node);
      }
      return;
    }
    const position = geometry.getAttribute('position'), index = geometry.index;
    for (let i = 0; i < (index?.count || position.count); i += 3) {
      const box = new THREE.Box3();
      for (let corner = 0; corner < 3; corner++) box.expandByPoint(point.fromBufferAttribute(position, index ? index.getX(i + corner) : i + corner).applyMatrix4(node.matrixWorld));
      visit(box, node);
    }
  });
}
const footprint = box => [(box.min.x + box.max.x) / 2, (box.min.z + box.max.z) / 2, Math.max(0, (box.max.x - box.min.x) / 2 - 1e-5), Math.max(0, (box.max.z - box.min.z) / 2 - 1e-5)];

test('Downtown plaza plans are stable, varied, and stay inside their vacant lots', () => {
  const variants = new Set(); let fountains = 0;
  for (let i = -4; i <= 4; i++) for (let j = -4; j < 0; j++) {
    const plan = downtownPlazaPlan(i, j);
    assert.deepEqual(downtownPlazaPlan(i, j), plan);
    variants.add(plan.variant); fountains += Number(plan.fountain);
    assert.ok(plan.planters.length >= 2 && plan.planters.length <= 3);
    assert.ok(plan.benches.length >= 1 && plan.benches.length <= 2);
    for (const p of plan.planters) {
      assert.ok(Math.abs(p.x) + 0.725 < LOT_HALF);
      assert.ok(Math.abs(p.z) + 0.725 < LOT_HALF);
      assert.ok(p.scale <= 0.725);
    }
  }
  assert.equal(variants.size, 4);
  assert.ok(fountains > 0 && fountains < 18, 'fountains are occasional');
});

test('occupied Downtown lots keep their existing bench and leave tower space clear', () => {
  const plan = downtownPlazaPlan(2, -1, true);
  assert.deepEqual(plan.planters, []);
  assert.equal(plan.fountain, false);
  assert.deepEqual(plan.benches, [[BENCH_OFFSET.x, BENCH_OFFSET.z, 0]]);
});

test('Downtown hardscape uses bounded merged draws, does not intercept picking, and disposes', () => {
  for (const rings of [2, 3]) {
    const decor = buildDecor(rings, new Map(), islandHalf(rings), { districts: true });
    const urban = decor.getObjectByName('downtown-plazas');
    assert.ok(urban);
    assert.ok(urban.children.length <= 6, 'hardscape batches do not grow with lot count');
    const hits = [];
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 20, -16), new THREE.Vector3(0, -1, 0));
    ray.intersectObject(decor, true, hits);
    assert.deepEqual(hits, []);
    let disposed = 0;
    for (const child of urban.children) child.geometry.addEventListener('dispose', () => disposed++);
    disposeAll(decor);
    assert.equal(disposed, urban.children.length);
  }
});

test('river clearings replace unsafe lots and every decor footprint clears water, banks, and bridge ramps', () => {
  for (const rings of [2, 4]) {
    const lots = new Map();
    for (let i = -rings; i <= rings; i++) for (let j = -rings; j <= rings; j++) if (riverCellUsable(i, j) && (i + j) % 3 === 0) lots.set(`${i},${j}`, { i, j, padW: 5.8, padD: 5.4, cz: -0.3 });
    const decor = buildDecor(rings, lots, islandHalf(rings), { districts: true });
    assert.ok(decor.getObjectByName('riparian-clearings'));
    assert.ok(decor.getObjectByName('downtown-plazas'));
    let pieces = 0;
    renderedBounds(decor, box => {
      pieces++;
      assert.ok(riverSceneryClear(...footprint(box)), `decoration intersects river/bridge: ${JSON.stringify(footprint(box))}`);
      assert.ok(box.min.x >= -islandHalf(rings) && box.max.x <= islandHalf(rings));
      assert.ok(box.min.z >= -islandHalf(rings) && box.max.z <= islandHalf(rings));
    });
    assert.ok(pieces > 100);
    disposeAll(decor);
  }
});

test('river roads and sidewalks end at bridge approaches with no submerged asphalt or crossing dashes', t => {
  fakeCanvas(t);
  for (const rings of [2, 4]) {
    const { group } = buildRoads(rings, { districts: true });
    renderedBounds(group, (box, node) => assert.ok(riverFootprintClear(...footprint(box)), `${node.name || node.type} intersects river banks: ${JSON.stringify(footprint(box))}`));
    for (const name of ['street-lamp-poles', 'street-lamp-heads']) {
      const lamps = group.getObjectByName(name);
      assert.ok(lamps.count > 0);
      renderedBounds(lamps, box => assert.ok(riverSceneryClear(...footprint(box)), 'street lamp overlaps a bridge approach'));
    }
    const asphalt = group.getObjectByName('road-asphalt');
    const vertical = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    const hit = (x, z, mesh = asphalt) => { vertical.ray.origin.set(x, 10, z); return vertical.intersectObject(mesh, false).length > 0; };
    const poles = group.getObjectByName('street-lamp-poles'), matrix = new THREE.Matrix4(), at = new THREE.Vector3();
    const sidewalk = group.getObjectByName('road-sidewalks');
    for (let index = 0; index < poles.count; index++) {
      poles.getMatrixAt(index, matrix); at.setFromMatrixPosition(matrix);
      for (const dx of [-0.13, 0.13]) for (const dz of [-0.13, 0.13]) assert.ok(hit(at.x + dx, at.z + dz, sidewalk), 'entire lamp base rests on a sidewalk');
    }
    for (let k = -rings - 1; k <= rings; k++) {
      const x = (k + 0.5) * 16, span = bridgeSpan(x);
      assert.equal(hit(x, riverZ(x)), false, 'river crossing contains no ground asphalt');
      assert.equal(hit(x, span.minZ - 0.1), true, 'north road meets bridge ramp');
      assert.equal(hit(x, span.maxZ + 0.1), true, 'south road meets bridge ramp');
      assert.equal(hit(x, span.minZ + 0.1), false, 'no hidden asphalt beneath ramp');
    }
    assert.equal(hit(0, -8), false, 'obsolete horizontal street is absent');
    disposeAll(group);
  }
});

test('clearance rejects a safe centre when a canopy or bridge-side footprint would intrude', () => {
  const x = 16, z = riverZ(x) + 3.2;
  assert.ok(riverFootprintClear(x, z, 0, 0));
  assert.equal(riverSceneryClear(x, z, 1, 1), false);
  const span = bridgeSpan(8);
  assert.equal(riverSceneryClear(span.x + span.halfWidth + 0.4, span.maxZ - 0.2, 0.3, 0.3), false);
  assert.equal(riverSceneryClear(0, 16, 1, 1), true);
});

test('river scenery releases owned geometry, instance buffers, and materials on rebuild', t => {
  fakeCanvas(t);
  for (const root of [buildDecor(2, new Map(), islandHalf(2), { districts: true }), buildRoads(2, { districts: true }).group]) {
    const resources = new Set(), released = new Set();
    root.traverse(node => {
      if (node.isInstancedMesh) resources.add(node);
      if (node.geometry && !node.geometry.userData.shared) resources.add(node.geometry);
      if (node.material && !node.material.userData.shared) resources.add(node.material);
    });
    for (const resource of resources) resource.addEventListener('dispose', () => released.add(resource));
    disposeAll(root);
    assert.equal(released.size, resources.size);
  }
});

test('contributor islands retain the existing park scenery', () => {
  const decor = buildDecor(1, new Map(), islandHalf(1));
  assert.equal(decor.getObjectByName('downtown-plazas'), undefined);
  disposeAll(decor);
});
