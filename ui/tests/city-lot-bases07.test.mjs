import assert from 'node:assert/strict';
import test from 'node:test';
import { THREE } from '../app/city/toon.js';
import { Building } from '../app/city/buildings.js';
import { LOT_HALF } from '../app/city/layout.js';
import { riverSceneryClear } from '../app/city/scenery.js';

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

test('ghost lots have lawn and a street path instead of a solid pad; clone sign stays pickable', t => {
  const drawn = canvas(t), b = make(project());
  assert.ok(b.padGroup.getObjectByName('downtown-lawn'));
  assert.ok(b.padGroup.getObjectByName('downtown-entry-walk'));
  assert.equal(b.padGroup.getObjectByName('downtown-paving'), undefined);
  assert.ok(drawn.includes('Clone to build'));
  assert.ok(b.unbuilt && b.bodyMaterial.opacity < 0.25);
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
  for (const cell of [{ i: -4, j: -1 }, { i: -3, j: -1 }, { i: 0, j: -2 }, { i: 3, j: -1 }]) for (const footprint of [1, 2, 3]) for (const local of [false, true]) {
    const b = make(project(footprint, local), cell); b.group.updateMatrixWorld(true);
    b.padGroup.traverse(node => {
      if (!node.isMesh) return;
      const attr = node.geometry.attributes.position, index = node.geometry.index, p = new THREE.Vector3();
      for (let i = 0; i < (index?.count || attr.count); i += 3) {
        const box = new THREE.Box3();
        for (let n = 0; n < 3; n++) box.expandByPoint(p.fromBufferAttribute(attr, index ? index.getX(i + n) : i + n).applyMatrix4(node.matrixWorld));
        const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
        assert.ok(riverSceneryClear(center.x, center.z, Math.max(0, size.x / 2 - 1e-5), Math.max(0, size.z / 2 - 1e-5)), `${node.name}: river/bridge intrusion at ${cell.i},${cell.j}, footprint ${footprint}`);
        assert.ok(box.min.x >= cell.i * 16 - LOT_HALF && box.max.x <= cell.i * 16 + LOT_HALF, 'x remains in lot');
        assert.ok(box.min.z >= cell.j * 16 - LOT_HALF && box.max.z <= cell.j * 16 + LOT_HALF, 'z remains in lot');
      }
    });
    b.dispose();
  }
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
