import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { River } from '../app/city/river.js';
import { riverSection } from '../app/city/river-path.js';

function fixture() {
  const context = new Proxy({ measureText: text => ({ width: text.length * 20 }) }, { get: (o, p) => o[p] || (() => {}) });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  const river = new River({ land: new THREE.Group(), half: 77.5, quality: 'high', reducedMotion: () => false }, { random: () => 0 });
  river.setProjects([{ id: 'project-a', name: 'Project A', stats: { git: { commits_7d: 2 } } }]);
  return river;
}

test('boat plaques raycast on both river faces and resolve a current focus target', () => {
  const river = fixture();
  river.update(0, 0, { reducedMotion: true });
  river.group.updateMatrixWorld(true);
  assert.equal(river.boats.length, 4);
  const labels = river.labelPickables();
  assert.ok(labels.length >= 8);
  for (const face of labels) {
    const point = face.getWorldPosition(new THREE.Vector3());
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(face.getWorldQuaternion(new THREE.Quaternion()));
    const ray = new THREE.Raycaster(point.clone().addScaledVector(normal, .1), normal.clone().negate());
    const hit = ray.intersectObject(face, false)[0];
    assert.ok(hit, `plaque does not raycast: ${face.userData.boatId}`);
    const boat = river.getBoat(hit.object.userData.boatId);
    assert.ok(boat && boat.userData.projectIds.includes(face.userData.projectId));
    assert.ok(boat.userData.loopSection.startsWith('moored-'));
  }
  river.group.visible = false;
  assert.deepEqual(river.labelPickables(), []);
  assert.equal(river.getBoat('moored-slot-0'), null);
  river.dispose();
});

test('boat focus IDs survive quality and lap replacements without retaining old plaque objects', () => {
  const river = fixture(), original = river.getBoat('loop-slot-0');
  const oldLabels = river.labelPickables();
  river.setQuality('low');
  const simplified = river.getBoat('loop-slot-0');
  assert.ok(simplified && simplified !== original);
  assert.equal(original.parent, null);
  assert.ok(river.labelPickables().every(label => !oldLabels.includes(label)));
  river.phase = .99999; river.slots.forEach((slot, i) => slot.lap = Math.floor(river.phase + i / river.fleetCount));
  river.update(1, 1, { reducedMotion: false });
  assert.ok(river.getBoat('loop-slot-0') !== simplified);
  assert.equal(simplified.parent, null);
  assert.equal(river.boats.length, 3);
  river.update(0, 1, { reducedMotion: true });
  assert.equal(river.getBoat('loop-slot-0'), null);
  assert.ok(river.getBoat('moored-slot-0'));
  river.dispose();
  assert.deepEqual(river.labelPickables(), []);
});

test('both bank faces block plaque selection without changing their render materials', () => {
  const river = fixture(); river.group.updateMatrixWorld(true);
  assert.equal(river.occluders().length, 4);
  const sides = river.occluders().map(node => node.material.side);
  const z = riverSection(0).waterMinZ;
  for (const y of [-.4, -6.8]) for (const direction of [-1, 1]) {
    const ray = new THREE.Raycaster(new THREE.Vector3(0, y, z - direction * 3), new THREE.Vector3(0, 0, direction));
    const hit = ray.intersectObjects(river.occluders(), false)[0];
    assert.ok(hit?.object.userData.occluder, `missing bank face at y${y}, direction${direction}`);
    assert.ok(Math.abs(hit.point.z - z) < .03);
  }
  assert.deepEqual(river.occluders().map(node => node.material.side), sides);
  river.group.visible = false; assert.deepEqual(river.occluders(), []);
  river.dispose(); assert.deepEqual(river.occluders(), []);
});
