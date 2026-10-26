import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { buildHQ } from '../app/city/scenery.js';
import { SparkCity } from '../app/city/spark.js';
import { riverFootprintClear, bridgeCrossings } from '../app/city/river-path.js';
import { islandHalf } from '../app/city/layout.js';
import { disposeAll } from '../app/city/fx.js';

function canvas(t) {
  const previous = globalThis.document, gradient = { addColorStop() {} };
  const context = new Proxy({ measureText: text => ({ width: text.length * 20 }), createLinearGradient: () => gradient, createRadialGradient: () => gradient }, { get: (object, property) => object[property] || (() => {}) });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
}

/** Transform every rendered vertex, including outline hulls, into island space.
 * The resulting envelope protects more than the central building's origin. */
function renderedEnvelope(roots) {
  const box = new THREE.Box3(), point = new THREE.Vector3(), instance = new THREE.Matrix4(), matrix = new THREE.Matrix4(); let vertices = 0, outlines = 0;
  for (const root of roots) {
    root.updateWorldMatrix(true, true);
    root.traverse(node => {
      if (!node.isMesh) return;
      if (node.userData.outline) outlines++;
      const position = node.geometry.getAttribute('position');
      for (let index = 0; index < (node.isInstancedMesh ? node.count : 1); index++) {
        if (node.isInstancedMesh) { node.getMatrixAt(index, instance); matrix.multiplyMatrices(node.matrixWorld, instance); }
        else matrix.copy(node.matrixWorld);
        for (let n = 0; n < position.count; n++) {
          box.expandByPoint(point.fromBufferAttribute(position, n).applyMatrix4(matrix)); vertices++;
        }
      }
    });
  }
  assert.ok(vertices > 1000 && outlines > 0, 'inspect real geometry and its ink outlines');
  return { box, vertices, outlines };
}

function assertDry(envelope, name, t) {
  const { box, vertices, outlines } = envelope, center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  assert.ok(riverFootprintClear(center.x, center.z, size.x / 2, size.z / 2), `${name} full rendered footprint intersects the river or bank`);
  for (const rings of [2, 4, 12, 24]) for (const bridge of bridgeCrossings(islandHalf(rings))) {
    assert.ok(box.max.x < bridge.x0 || box.min.x > bridge.x1 || box.max.z < bridge.z0 || box.min.z > bridge.z1, `${name} intersects bridge ${bridge.id}, including its approaches`);
  }
  t.diagnostic(`${name}: ${vertices} vertices, ${outlines} outlines; island x=[${box.min.x.toFixed(4)},${box.max.x.toFixed(4)}], z=[${box.min.z.toFixed(4)},${box.max.z.toFixed(4)}]`);
}

test('the complete rendered HQ plaza, building and outlines remain clear of water, banks and bridges', t => {
  canvas(t); const hq = buildHQ(); t.after(() => disposeAll(hq.group));
  assertDry(renderedEnvelope([hq.group]), 'HQ', t);
});

test('the Spark Foundry and fixed crew garden clear the same physical corridor after the underside transform', t => {
  canvas(t);
  const world = { land: new THREE.Group(), city: new THREE.Group() };
  const spark = new SparkCity(world, { makePerson() { throw new Error('No people are needed for the landmark audit'); }, reducedMotion: () => true, topBuildings: { get() { return null; } } });
  t.after(() => spark.dispose());
  const envelope = renderedEnvelope([spark.foundry.group, spark.garden]);
  assert.ok(envelope.box.max.y < -7, 'bounds include the real inverted Spark transform');
  assertDry(envelope, 'Spark Foundry and crew garden', t);
});
