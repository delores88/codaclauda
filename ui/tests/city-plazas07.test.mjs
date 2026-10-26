import assert from 'node:assert/strict';
import test from 'node:test';
import { THREE } from '../app/city/toon.js';
import { buildDecor, buildRoads, riverSceneryClear, BENCH_OFFSET } from '../app/city/scenery.js';
import { islandHalf } from '../app/city/layout.js';
import { disposeAll } from '../app/city/fx.js';
import { riverZ, riverSide, riverBankPoint, riverCellUsable, riverFootprintClear, bridgeSpan, bridgeCrossings, bridgeAt } from '../app/city/river-path.js';

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

test('occupied Downtown lots keep their existing bench and leave tower space clear', () => {
  const lot = { i: 2, j: -2, padW: 5.8, padD: 5.4, cz: -0.3 };
  const decor = buildDecor(3, new Map([['2,-2', lot]]), islandHalf(3), { districts: true });
  assert.ok(!decor.getObjectByName('downtown-parks').userData.parks.some(p => p.i === lot.i && p.j === lot.j));
  const tower = new THREE.Box3(new THREE.Vector3(29.2, 0.2, -34.8), new THREE.Vector3(34.8, 6, -29.8));
  renderedBounds(decor, box => assert.ok(!box.intersectsBox(tower), 'park geometry intrudes into an occupied tower'));
  const matrix = new THREE.Matrix4(), at = new THREE.Vector3(); let benchFound = false;
  decor.traverse(node => {
    if (!node.isInstancedMesh) return;
    for (let n = 0; n < node.count; n++) {
      node.getMatrixAt(n, matrix); at.setFromMatrixPosition(matrix);
      if (Math.abs(at.x - (32 + BENCH_OFFSET.x)) < 1e-5 && Math.abs(at.z - (-32 + BENCH_OFFSET.z)) < 1e-5) benchFound = true;
    }
  });
  assert.ok(benchFound, 'established NPC bench remains on the occupied lot');
  disposeAll(decor);
});

test('Downtown parks use bounded merged draws, does not intercept picking, and disposes', () => {
  for (const rings of [2, 3]) {
    const decor = buildDecor(rings, new Map(), islandHalf(rings), { districts: true });
    const urban = decor.getObjectByName('downtown-parks');
    assert.ok(urban);
    assert.ok(urban.children.length <= 5, 'park batches do not grow with lot count');
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
  for (const rings of [3, 4]) {
    const lots = new Map();
    for (let i = -rings; i <= rings; i++) for (let j = -rings; j <= rings; j++) if (riverCellUsable(i, j) && (i + j) % 3 === 0) lots.set(`${i},${j}`, { i, j, padW: 5.8, padD: 5.4, cz: -0.3 });
    const decor = buildDecor(rings, lots, islandHalf(rings), { districts: true });
    assert.ok(decor.getObjectByName('riparian-clearings'));
    assert.ok(decor.getObjectByName('downtown-parks'));
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
    for (const name of ['street-lamp-poles', 'street-lamp-heads', 'suburbs-lamp-poles', 'suburbs-lamp-housings', 'suburbs-lamp-panels']) {
      const lamps = group.getObjectByName(name);
      assert.ok(lamps.count > 0);
      renderedBounds(lamps, box => assert.ok(riverSceneryClear(...footprint(box)), 'street lamp overlaps a bridge approach'));
    }
    const asphalt = group.getObjectByName('road-asphalt');
    const vertical = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    const hit = (x, z, mesh = asphalt) => { vertical.ray.origin.set(x, 10, z); return vertical.intersectObject(mesh, false).length > 0; };
    const matrix = new THREE.Matrix4(), at = new THREE.Vector3();
    const sidewalk = group.getObjectByName('road-sidewalks');
    for (const name of ['street-lamp-poles', 'suburbs-lamp-poles']) {
      const poles = group.getObjectByName(name);
      for (let index = 0; index < poles.count; index++) {
        poles.getMatrixAt(index, matrix); at.setFromMatrixPosition(matrix);
        for (const dx of [-0.13, 0.13]) for (const dz of [-0.13, 0.13]) assert.ok(hit(at.x + dx, at.z + dz, sidewalk), `entire lamp base rests on a sidewalk: ${at.x},${at.z} offset ${dx},${dz}`);
      }
    }
    const crossings = bridgeCrossings(islandHalf(rings));
    for (const span of crossings) {
      const at = along => span.axis === 'x' ? [along, span.z] : [span.x, along];
      assert.equal(hit(span.x, span.z), false, 'river crossing contains no ground asphalt');
      for (const end of [span.min - 0.1, span.max + 0.1]) {
        const [x, z] = at(end);
        if (!bridgeAt(x, z, crossings) && Math.max(Math.abs(x), Math.abs(z)) < (rings + 0.5) * 16) assert.equal(hit(x, z), true, `road meets the bridge approach ${span.id} at ${x},${z}`);
      }
      assert.equal(hit(...at(span.min + 0.1)), false, 'no hidden asphalt beneath ramp');
    }
    for (const z of [-40, 8]) for (const x of [-16, 0, 16]) {
      assert.ok(riverFootprintClear(x, z, 1.5, 1.5), 'connectivity probe is on dry land');
      assert.equal(hit(x, z), true, 'dry horizontal streets remain connected in both districts');
    }
    disposeAll(group);
  }
});

test('clearance rejects a safe centre when a canopy or bridge-side footprint would intrude', () => {
  const x = 16, { z } = riverBankPoint(x, 1, 0.1);
  assert.ok(riverFootprintClear(x, z, 0, 0));
  assert.equal(riverSceneryClear(x, z, 1, 1), false);
  const span = bridgeSpan(8);
  assert.equal(riverSceneryClear(span.x + span.halfWidth + 0.4, span.max - 0.2, 0.3, 0.3), false);
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
  assert.equal(decor.getObjectByName('downtown-parks'), undefined);
  disposeAll(decor);
});

test('occupied Suburbs plots contain no shared decor while vacant parks and Downtown parks survive', () => {
  const rings = 3, occupied = new Map();
  for (let i = -rings; i <= rings; i++) for (let j = 0; j <= rings; j++) if ((i || j) && riverCellUsable(i, j)) occupied.set(`${i},${j}`, { i, j, district: 'suburbs', padW: 11.2, padD: 11.2, cz: -0.3 });
  const homes = buildDecor(rings, occupied, islandHalf(rings), { districts: true });
  const parks = buildDecor(rings, new Map(), islandHalf(rings), { districts: true });
  let vacantParkParts = 0;
  for (const lot of occupied.values()) {
    const area = new THREE.Box3(new THREE.Vector3(lot.i * 16 - 5.6, -0.01, lot.j * 16 - 5.6), new THREE.Vector3(lot.i * 16 + 5.6, 10, lot.j * 16 + 5.6));
    renderedBounds(homes, box => assert.ok(!box.intersectsBox(area), `shared decor intrudes into home lot ${lot.i},${lot.j}`));
    renderedBounds(parks, box => { if (box.intersectsBox(area)) vacantParkParts++; });
  }
  assert.ok(vacantParkParts > 100, 'vacant Suburbs lots retain trees and grassy parks');
  const before = parks.getObjectByName('downtown-parks'), after = homes.getObjectByName('downtown-parks');
  assert.equal(before.children.length, after.children.length);
  before.children.forEach((mesh, index) => assert.deepEqual(after.children[index].geometry.attributes.position.array, mesh.geometry.attributes.position.array, 'Downtown park geometry stays unchanged'));
  disposeAll(homes); disposeAll(parks);
});

test('Suburbs lamps use grounded slim poles and attached flat warm panels', t => {
  fakeCanvas(t);
  const { group } = buildRoads(2, { districts: true }), poles = group.getObjectByName('suburbs-lamp-poles'), housings = group.getObjectByName('suburbs-lamp-housings'), panels = group.getObjectByName('suburbs-lamp-panels');
  assert.ok(poles.count > 0); assert.equal(poles.count, housings.count); assert.equal(poles.count, panels.count);
  for (const lamp of [poles, housings, panels]) lamp.geometry.computeBoundingBox();
  assert.ok(Math.abs(poles.geometry.boundingBox.min.y) < 1e-6, 'pole starts at the supporting sidewalk');
  assert.ok(poles.geometry.boundingBox.max.x - poles.geometry.boundingBox.min.x < 0.16, 'modern pole is slim');
  assert.ok(poles.geometry.boundingBox.intersectsBox(housings.geometry.boundingBox), 'housing is attached to pole');
  assert.ok(housings.geometry.boundingBox.intersectsBox(panels.geometry.boundingBox), 'light panel is mounted in housing');
  assert.ok(panels.geometry.boundingBox.max.y - panels.geometry.boundingBox.min.y < 0.03, 'luminaire is a flat panel');
  assert.equal(panels.material.emissive.getHexString(), 'ffcf6b');
  const matrix = new THREE.Matrix4(), at = new THREE.Vector3();
  for (let index = 0; index < poles.count; index++) { poles.getMatrixAt(index, matrix); at.setFromMatrixPosition(matrix); assert.equal(riverSide(at.x, at.z), 1, 'modern lamps stay on the Suburbs bank'); assert.ok(Math.abs(at.y - 0.2) < 1e-6); }
  disposeAll(group);
  const island = buildRoads(1).group; assert.equal(island.getObjectByName('suburbs-lamp-panels'), undefined); disposeAll(island);
});
