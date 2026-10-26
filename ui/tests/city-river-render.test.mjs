import assert from 'node:assert/strict';
import test from 'node:test';
import { THREE } from '../app/city/toon.js';
import { River } from '../app/city/river.js';
import { WATER_Y, riverSection, bridgeHeight, bridgeAt } from '../app/city/river-path.js';
import { MODEL_MAX_TOP } from '../app/city/boat-models.js';
import { riverLoopPose, RIVER_DECK_Y } from '../app/city/river-loop.js';

function canvasStub() {
  const ctx = new Proxy({ measureText: text => ({ width: text.length * 30 }) }, { get: (obj, property) => obj[property] || (() => {}) });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
}
function makeRiver(quality = 'high', half = 61.5) {
  canvasStub(); const world = { land: new THREE.Group(), quality, half, elapsed: 0, reducedMotion: () => false };
  const river = new River(world, { random: () => 0, now: () => 1000000 });
  river.setProjects(Array.from({ length: 6 }, (_, n) => ({ id: `project-${n}`, name: `Project ${n}`, stats: { git: { commits_7d: 6 - n } } })));
  return { world, river };
}
const near = (a, b, epsilon = 1e-6) => assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);
const snapshot = river => river.boats.map(boat => ({ position: boat.position.toArray(), quaternion: boat.quaternion.toArray(), type: boat.userData.boatType, projects: boat.userData.projectIds }));

test('both bridge directions raycast at their shared humped walking heights', () => {
  const { river } = makeRiver(); river.group.updateMatrixWorld(true);
  assert.deepEqual(new Set(river.crossings.map(span => span.axis)), new Set(['x', 'z']));
  assert.equal(river.pickables().length, river.crossings.length);
  for (const span of river.crossings) for (const fraction of [.01, .16, .35, .5, .65, .84, .99]) {
    const along = span.min + (span.max - span.min) * fraction;
    const x = span.axis === 'x' ? along : span.x, z = span.axis === 'z' ? along : span.z;
    const ray = new THREE.Raycaster(new THREE.Vector3(x, 10, z), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObjects(river.pickables())[0]; assert.ok(hit?.object.userData.riverBridge);
    near(hit.point.y, bridgeHeight(x, z, river.crossings), .008); near(river.groundAt(x, z), bridgeHeight(x, z, river.crossings));
  }
  river.group.visible = false; assert.deepEqual(river.pickables(), []); assert.equal(river.groundAt(8, -8), null); river.dispose();
});

test('the top and mirrored water share terrain sections and recessed heights', () => {
  const { river } = makeRiver();
  for (const index of [0, 2]) {
    const water = river.waterMeshes[index], position = water.geometry.getAttribute('position'), color = water.geometry.getAttribute('color');
    assert.ok(water.material.isMeshToonMaterial && water.material.vertexColors); assert.equal(color.count, position.count);
    for (let n = 0; n < position.count; n += 5) {
      const x = position.getX(n), section = riverSection(x);
      near(position.getY(n), index ? RIVER_DECK_Y - WATER_Y : WATER_Y);
      near(position.getZ(n), Math.max(-river.half, Math.min(river.half, section.waterMinZ)), .0001);
      near(position.getZ(n + 4), Math.max(-river.half, Math.min(river.half, section.waterMaxZ)), .0001);
    }
  }
  river.dispose();
});

test('joining collars physically close the oblique waterfall gaps at X and Z rims on both faces', () => {
  const { river } = makeRiver(); let checks = 0;
  assert.ok(Math.abs(river.loop.start.z) === river.half && river.loop.end.x === river.half);
  for (const index of [1, 3]) {
    const waterfall = river.waterMeshes[index], geo = waterfall.geometry, positions = geo.getAttribute('position');
    const probe = new THREE.Mesh(geo, waterfall.material); probe.updateMatrixWorld(true);
    const rows = positions.count / 5;
    for (const [aRow, bRow] of [[0, 1], [rows - 2, rows - 1]]) {
      const y = positions.getY(aRow * 5), top = Math.abs(y - WATER_Y) < .001;
      for (let column = 0; column < 4; column++) for (const across of [.2, .5, .8]) {
        const a = new THREE.Vector3().fromBufferAttribute(positions, aRow * 5 + column).lerp(new THREE.Vector3().fromBufferAttribute(positions, aRow * 5 + column + 1), across);
        const b = new THREE.Vector3().fromBufferAttribute(positions, bRow * 5 + column).lerp(new THREE.Vector3().fromBufferAttribute(positions, bRow * 5 + column + 1), across);
        if (a.distanceTo(b) < .03) continue;
        for (const along of [.2, .5, .8]) {
          const point = a.clone().lerp(b, along), direction = new THREE.Vector3(0, top ? -1 : 1, 0);
          const ray = new THREE.Raycaster(point.clone().addScaledVector(direction, -1), direction);
          const hit = ray.intersectObject(probe, false)[0]; assert.ok(hit, `water collar missing at ${point.toArray()}`); near(hit.point.y, y); checks++;
        }
      }
    }
  }
  assert.ok(checks >= 100); river.dispose();
});

test('the fleet remains present and evenly spaced on both faces and both waterfall arcs', () => {
  const { river } = makeRiver(); const seen = new Set();
  for (let n = 0; n <= 180; n++) {
    river.phase = n / 180; river.placeBoats(); river.group.updateMatrixWorld(true);
    assert.equal(river.boats.length, 3);
    river.boats.forEach((boat, index) => {
      assert.equal(boat.visible, true); seen.add(boat.userData.loopSection);
      const pose = riverLoopPose(river.loop, river.phase + index / 3), actualForward = new THREE.Vector3(1, 0, 0).applyQuaternion(boat.quaternion), actualUp = new THREE.Vector3(0, 1, 0).applyQuaternion(boat.quaternion);
      near(boat.position.distanceTo(new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z)), 0);
      near(actualForward.distanceTo(new THREE.Vector3(pose.forward.x, pose.forward.y, pose.forward.z)), 0);
      near(actualUp.distanceTo(new THREE.Vector3(pose.up.x, pose.up.y, pose.up.z)), 0);
      if (pose.section === 'top') {
        near(boat.position.y, WATER_Y); const height = bridgeHeight(boat.position.x, boat.position.z, river.crossings);
        if (height !== null) assert.ok(height - .18 - (WATER_Y + MODEL_MAX_TOP) >= .3);
      }
    });
  }
  assert.deepEqual(seen, new Set(['top', 'downstream-fall', 'underside', 'upstream-fall'])); river.dispose();
});

test('only upstream laps consume type choices; all six types cycle without adjacent repeats', () => {
  const { river } = makeRiver(), history = river.slots.map(slot => slot.type);
  river.update(0, 0, {}); const firstBag = [...river.typeBag]; river.update(.01, .01, {}); assert.deepEqual(river.typeBag, firstBag);
  for (let n = 0; n < 15; n++) {
    const previous = river.slots.map(slot => ({ type: slot.type, lap: slot.lap }));
    river.update(river.loop.length / river.timing.speed / 3 + .01, n + 1, {});
    river.slots.forEach((slot, index) => { if (slot.lap !== previous[index].lap) history.push(slot.type); else assert.equal(slot.type, previous[index].type); });
  }
  assert.equal(new Set(history.slice(0, 6)).size, 6); assert.ok(history.every((type, n) => !n || type !== history[n - 1])); river.dispose();
});

test('quality remeshing retains moving slots, phase, labels, crates and the type bag', () => {
  const { river } = makeRiver(); river.update(6, 6, {});
  const before = snapshot(river), entries = structuredClone(river.fleet), bag = [...river.typeBag], phase = river.phase;
  river.setQuality('low'); assert.deepEqual(snapshot(river), before); assert.deepEqual(river.fleet, entries); assert.deepEqual(river.typeBag, bag); near(river.phase, phase);
  assert.equal(river.boats.length, 3); river.dispose();
  const initialLow = makeRiver('low').river; assert.equal(initialLow.boats.length, 2); initialLow.dispose();
});

test('reduced motion moors a barge and sailboat on each face and freezes all motion', () => {
  const { river } = makeRiver(); river.update(1, 10, { reducedMotion: true });
  assert.deepEqual(river.boats.map(b => b.userData.boatType), ['barge', 'sailboat', 'barge', 'sailboat']);
  const before = snapshot(river), phase = river.phase, time = river.waterTime, entries = structuredClone(river.fleet), bag = [...river.typeBag];
  river.setProjects(river.projects); river.setQuality('low'); river.update(100, 110, { reducedMotion: true, quality: 'low' });
  assert.deepEqual(snapshot(river), before); assert.deepEqual(river.fleet, entries); assert.deepEqual(river.typeBag, bag); near(river.phase, phase); near(river.waterTime, time);
  river.boats.forEach((boat, index) => { near(boat.position.y, index < 2 ? WATER_Y : RIVER_DECK_Y - WATER_Y); assert.ok(!bridgeAt(boat.position.x, boat.position.z, river.crossings)); });
  river.dispose();
});

test('moored hulls clear bridges and island edges on small and expanded cities', () => {
  for (const half of [29.5, 93.5, 397.5]) {
    const { river } = makeRiver('low', half); river.update(0, 0, { reducedMotion: true }); river.group.updateMatrixWorld(true);
    for (const boat of river.boats.slice(0, 2)) {
      const bounds = new THREE.Box3().setFromObject(boat);
      assert.ok(bounds.min.x > -half && bounds.max.x < half && bounds.min.z > -half && bounds.max.z < half);
      for (const span of river.crossings) assert.ok(bounds.max.x <= span.x0 || bounds.min.x >= span.x1 || bounds.max.z <= span.z0 || bounds.min.z >= span.z1, `mooring overlaps ${span.id}`);
    }
    river.dispose();
  }
});

test('night calms water, dash ripples and warm lamp streaks; low removes foam and shadows', () => {
  const { river } = makeRiver(); river.update(1, 1, { night: 0 }); const day = river.waterTime;
  assert.equal(river.ripples.count, 26); assert.equal(river.ripples.material.color.getHexString(), 'ffffff');
  assert.ok(river.water.children.some(child => child.userData.outline)); assert.equal(river.rippleOutline.instanceMatrix, river.ripples.instanceMatrix);
  const bounds = river.ripples.geometry.boundingBox || (river.ripples.geometry.computeBoundingBox(), river.ripples.geometry.boundingBox);
  assert.ok(bounds.max.x - bounds.min.x > (bounds.max.z - bounds.min.z) * 5);
  river.update(1, 2, { night: 1 }); assert.ok(river.waterTime - day < day / 4);
  const streak = river.landscape.getObjectByName('quay-light-streaks'); if (streak) assert.ok(streak.material.opacity > 0);
  river.update(10, 12, { reducedMotion: true }); assert.equal(river.ripples.visible, false); assert.equal(river.foam.visible, false);
  river.setQuality('low'); assert.equal(river.ripples, null); assert.equal(river.foam, null);
  river.group.traverse(node => assert.equal(Boolean(node.castShadow), false)); river.dispose();
});

test('all geometry, private materials and textures are released on rebuild and disposal', () => {
  const { river, world } = makeRiver();
  const watch = root => {
    const owned = new Set(), released = new Set();
    root.traverse(node => { if (node.geometry && !node.geometry.userData.shared) owned.add(node.geometry);
      if (node.material && !node.material.userData.shared) { owned.add(node.material); if (node.material.map) owned.add(node.material.map); }
    });
    for (const resource of owned) resource.addEventListener('dispose', () => released.add(resource)); return () => assert.equal(released.size, owned.size);
  };
  const landscapeReleased = watch(river.landscape); river.setBounds({ half: 77.5 }); landscapeReleased();
  const released = watch(river.group); river.dispose(); released(); assert.equal(world.land.children.length, 0);
});
