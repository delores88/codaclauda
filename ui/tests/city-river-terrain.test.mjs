import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { buildIsland } from '../app/city/scenery.js';
import { riverLandGeometry, riverCuts, outsideIntervals } from '../app/city/river-terrain.js';
import { sampleRiver, WATER_Y, riverSlope, riverContains } from '../app/city/river-path.js';
import { disposeAll } from '../app/city/fx.js';

function canvas(t) {
  const original = globalThis.document, gradient = { addColorStop() {} };
  const context = new Proxy({ measureText: text => ({ width: text.length * 20 }), createLinearGradient: () => gradient }, { get: (object, property) => object[property] || (() => {}) });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  t.after(() => { if (original) globalThis.document = original; else delete globalThis.document; });
}

test('actual island slabs leave a recessed navigable channel on both faces', t => {
  canvas(t);
  for (const rings of [3, 5]) {
    const { group, half } = buildIsland(rings, { districts: true }); group.updateMatrixWorld(true);
    const slabs = group.children.filter(node => node.userData.occluder);
    const topRay = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    const bottomRay = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
    let samples = 0;
    for (const p of sampleRiver(half - 4, 3)) {
      const slope = riverSlope(p.x), length = Math.hypot(1, slope);
      for (const offset of [-2, 0, 2]) {
        const x = p.x - offset * slope / length, z = p.z + offset / length;
        topRay.ray.origin.set(x, 5, z); bottomRay.ray.origin.set(x, -10, z);
        const top = topRay.intersectObjects(slabs, false)[0], bottom = bottomRay.intersectObjects(slabs, false)[0];
        assert.ok(!top || top.point.y < WATER_Y - 0.2, 'top channel has room for a submerged hull');
        assert.ok(!bottom || bottom.point.y > -7.2 - WATER_Y + 0.2, 'underside channel has room for an inverted hull');
        samples++;
      }
    }
    assert.ok(samples > 30); disposeAll(group);
  }
});

test('Spark deck cutout mirrors the top channel without reversing ground faces', () => {
  const half = 77.5, geometry = riverLandGeometry(half, { top: 0, bottom: -0.8, mirror: true });
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
  for (const p of sampleRiver(half - 3, 4)) {
    ray.ray.origin.set(p.x, 3, -p.z); assert.equal(ray.intersectObject(mesh).length, 0);
  }
  ray.ray.origin.set(0, 3, 0); assert.equal(ray.intersectObject(mesh)[0].point.y, 0);
  geometry.dispose(); mesh.material.dispose();
});

test('cut grid lines retain separate dry intervals while excluding the whole water corridor', () => {
  for (const axis of ['x', 'z']) for (const line of [-56, -40, -24, -8, 8, 24, 40, 56]) {
    const pieces = outsideIntervals(-77, 77, riverCuts(axis, line, 0.4));
    for (const [a, b] of pieces) for (let along = a + 0.03; along < b; along += 0.3) {
      const x = axis === 'x' ? along : line, z = axis === 'z' ? along : line;
      assert.equal(riverContains(x, z), false, `${axis} street at ${line} crosses water`);
    }
  }
});

test('underside river banks meet solid land even while the optional Spark deck is absent', async t => {
  canvas(t);
  const { riverBoundsAtX } = await import('../app/city/river-path.js');
  const { RIVER_DECK_Y } = await import('../app/city/river-loop.js');
  for (const rings of [3, 5]) {
    const { group, half } = buildIsland(rings, { districts: true }); group.updateMatrixWorld(true);
    const under = group.getObjectByName('river-cut-underland'), coordinates = under.geometry.getAttribute('position');
    const xs = [...new Set(Array.from({ length: coordinates.count }, (_, n) => coordinates.getX(n)))].sort((a, b) => a - b);
    const slabs = group.children.filter(node => node.userData.occluder), ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
    let checked = 0;
    for (let index = 1; index < xs.length - 1; index += Math.max(1, Math.floor(xs.length / 35))) {
      const x = xs[index], bank = riverBoundsAtX(x);
      for (const z of [bank.min - .01, bank.max + .01]) {
        if (Math.abs(z) >= half - .1) continue;
        ray.ray.origin.set(x, RIVER_DECK_Y - 1, z);
        const support = ray.intersectObjects(slabs, false)[0];
        assert.ok(support, 'each underside bank has adjoining land without a Spark deck');
        assert.ok(Math.abs(support.point.y - RIVER_DECK_Y) < 2e-6, 'land meets the mirrored bank edge at the same height');
        checked++;
      }
    }
    assert.ok(checked > 20); disposeAll(group);
  }
});
