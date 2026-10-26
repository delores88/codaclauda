import assert from 'node:assert/strict';
import test from 'node:test';
import { THREE } from '../app/city/toon.js';
import { River } from '../app/city/river.js';
import { WATER_Y, riverZ, riverContains, bridgeSpan, bridgeHeight } from '../app/city/river-path.js';

function canvasStub() {
  const ctx = new Proxy({ measureText: text => ({ width: text.length * 30 }) }, { get: (obj, property) => obj[property] || (() => {}) });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
}
function makeRiver(quality = 'high') {
  canvasStub();
  const world = { land: new THREE.Group(), quality, half: 45.5, elapsed: 0, reducedMotion: () => false };
  const river = new River(world, { random: () => 0, now: () => 1000000 });
  river.setProjects(Array.from({ length: 6 }, (_, n) => ({ id: `project-${n}`, name: `Project ${n}`, stats: { git: { commits_7d: 6 - n } } })));
  return { world, river };
}

test('every bridge raycasts at its pure walking height, including both approaches', () => {
  const { river } = makeRiver(); river.group.updateMatrixWorld(true);
  assert.equal(river.pickables().length, river.crossings.length);
  for (const x of river.crossings) {
    const span = bridgeSpan(x);
    for (const z of [span.minZ + 0.5, span.deckMinZ, span.centerZ, span.deckMaxZ, span.maxZ - 0.5]) {
      const ray = new THREE.Raycaster(new THREE.Vector3(x, 8, z), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObjects(river.pickables())[0];
      assert.ok(hit?.object.userData.riverBridge, `clickable bridge at ${x},${z}`);
      assert.ok(Math.abs(hit.point.y - bridgeHeight(x, z, river.crossings)) < 1e-5);
      assert.equal(river.groundAt(x, z), bridgeHeight(x, z, river.crossings));
    }
  }
  river.group.visible = false; assert.deepEqual(river.pickables(), []); assert.equal(river.groundAt(8, riverZ(8)), null);
  river.dispose();
});

test('boats stay on fixed water height, remain inside the water and clear all bridge decks', () => {
  const { river } = makeRiver(); river.update(0, 0, { reducedMotion: false }); river.update(0.1, 90, { reducedMotion: false });
  assert.equal(river.boats.length, 6);
  for (let time = 91; time < 132; time += 0.5) {
    river.update(0.5, time, { reducedMotion: false }); river.group.updateMatrixWorld(true);
    for (const boat of river.boats.filter(b => b.visible)) {
      assert.equal(boat.position.y, WATER_Y);
      const bounds = new THREE.Box3().setFromObject(boat);
      assert.ok(bounds.min.y < WATER_Y && bounds.max.y > WATER_Y, 'hull crosses the waterline');
      assert.ok(bounds.max.y < 1.95 - 0.18 - 0.5, 'bridge underside clearance exceeds half a unit');
      assert.ok(bounds.min.x >= -river.half + 0.5 && bounds.max.x <= river.half - 0.5);
      for (const x of [bounds.min.x, bounds.max.x]) for (const z of [bounds.min.z, bounds.max.z]) assert.ok(riverContains(x, z), 'entire hull remains in water');
    }
  }
  river.dispose();
});

test('reduced motion moors two boats with no movement or water animation', () => {
  const { river } = makeRiver(); river.update(1, 10, { reducedMotion: true });
  const visible = river.boats.filter(b => b.visible), positions = visible.map(b => b.position.clone()), phase = river.waterTime;
  assert.equal(visible.length, 2);
  const original = river.boats[0]; river.setProjects(river.projects); assert.equal(river.boats[0], original);
  river.update(100, 110, { reducedMotion: true });
  assert.equal(river.waterTime, phase);
  visible.forEach((boat, n) => assert.deepEqual(boat.position, positions[n]));
  river.dispose();
});

test('night water slows, low quality has no shaders or shadow casters, owned geometry is released', () => {
  const { river, world } = makeRiver(); river.update(1, 0, { night: 0 }); const day = river.waterTime;
  river.update(1, 1, { night: 1 }); assert.ok(river.waterTime - day < day / 4);
  river.setQuality('low'); assert.ok(!river.water.material.isShaderMaterial);
  let shadows = 0; const geometries = new Set();
  river.group.traverse(node => { if (node.castShadow) shadows++; if (node.geometry && !node.geometry.userData.shared) geometries.add(node.geometry); });
  assert.equal(shadows, 0);
  let disposed = 0; for (const geometry of geometries) geometry.addEventListener('dispose', () => disposed++);
  river.dispose(); assert.equal(disposed, geometries.size); assert.equal(world.land.children.length, 0);
});

test('growth extends water while preserving all existing bridge spans and height queries', () => {
  const { river } = makeRiver(); const previous = river.crossings.map(x => ({ x, span: bridgeSpan(x), y: river.groundAt(x, riverZ(x)) }));
  river.setBounds({ half: 61.5 });
  for (const before of previous) { assert.deepEqual(bridgeSpan(before.x), before.span); assert.equal(river.groundAt(before.x, riverZ(before.x)), before.y); }
  river.dispose();
});
