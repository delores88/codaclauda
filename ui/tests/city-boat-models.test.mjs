import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE, gradientMap } from '../app/city/toon.js';
import { createBoat, updateBoat, BOAT_TYPES, BOAT_DIMENSIONS, MODEL_MAX_TOP } from '../app/city/boat-models.js';
import { BOAT_TYPES as POLICY_BOAT_TYPES } from '../app/city/boats.js';
import { disposeAll } from '../app/city/fx.js';

const context = new Proxy({ measureText: text => ({ width: text.length * 30 }) }, { get: (obj, prop) => obj[prop] || (() => {}) });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
const projects = Array.from({ length: 4 }, (_, n) => ({ projectId: `project-${n}`, label: `Project ${n}` }));
const meshes = root => { const result = []; root.traverse(node => { if (node.isMesh) result.push(node); }); return result; };

test('six boat types in both qualities cross the waterline and fit the river and bridge envelope', () => {
  for (const type of BOAT_TYPES) for (const low of [false, true]) {
    const boat = createBoat({ type, projects }, { low });
    const hull = boat.getObjectByName('waterline-hull'); hull.geometry.computeBoundingBox();
    const hullSize = hull.geometry.boundingBox.getSize(new THREE.Vector3());
    assert.ok(Math.abs(hullSize.x - BOAT_DIMENSIONS[type].length) < 1e-6, `${type} exact hull length`);
    assert.ok(Math.abs(hullSize.z - BOAT_DIMENSIONS[type].width) < 1e-6, `${type} exact hull width`);
    for (let time = 0; time < 20; time += .25) {
      updateBoat(boat, .25, time, { low });
      const bounds = new THREE.Box3().setFromObject(boat, true);
      assert.ok(bounds.min.y < 0 && bounds.max.y > 0, `${type} crosses the waterline`);
      assert.ok(bounds.min.x >= -1.84 && bounds.max.x <= 1.84, `${type} length including sternwheel`);
      assert.ok(bounds.min.z >= -.92 && bounds.max.z <= .92, `${type} width including moving oars`);
      assert.ok(bounds.max.y <= MODEL_MAX_TOP, `${type} animated bridge envelope`);
    }
    assert.equal(boat.userData.boatType, type); assert.equal(boat.userData.type, type);
    assert.deepEqual(boat.userData.projectIds, projects.slice(0, type === 'barge' ? 4 : 1).map(p => p.projectId));
    if (low) for (const mesh of meshes(boat)) assert.ok(!mesh.castShadow && !mesh.receiveShadow);
    disposeAll(boat);
  }
});

test('every project plaque is mounted on hull or its own supported cargo crate', () => {
  for (const type of BOAT_TYPES) {
    const boat = createBoat({ type, projects }); boat.updateMatrixWorld(true);
    const hull = new THREE.Box3().setFromObject(boat.getObjectByName('waterline-hull'));
    const faces = meshes(boat).filter(mesh => mesh.userData.mountedLabel);
    assert.equal(faces.length, type === 'barge' ? 8 : 2);
    for (const face of faces) {
      const mount = face.parent; assert.ok(mount.userData.labelMount);
      assert.equal(mount.userData.projectId, face.userData.projectId);
      const backing = mount.children.find(child => !child.userData.mountedLabel);
      backing.geometry.computeBoundingBox();
      const backingBounds = backing.geometry.boundingBox.clone().applyMatrix4(backing.matrixWorld), faceBounds = new THREE.Box3().setFromObject(face);
      if (type === 'barge') {
        assert.equal(mount.userData.mountKind, 'crate');
        const c = mount.userData.crate, crateBounds = new THREE.Box3(new THREE.Vector3(c.x - c.w / 2, c.y - c.h / 2, -c.d / 2), new THREE.Vector3(c.x + c.w / 2, c.y + c.h / 2, c.d / 2));
        assert.ok(backingBounds.intersectsBox(crateBounds), 'each project label contacts its own crate');
        assert.ok(Math.abs(crateBounds.min.y - .18) < 1e-6, 'crate rests on barge deck');
      } else assert.ok(backingBounds.intersectsBox(hull), `${type} label backing contacts hull`);
      assert.ok(faceBounds.min.x >= backingBounds.min.x && faceBounds.max.x <= backingBounds.max.x);
      assert.ok(faceBounds.min.y >= backingBounds.min.y && faceBounds.max.y <= backingBounds.max.y);
      assert.ok(Math.min(Math.abs(faceBounds.min.z - backingBounds.min.z), Math.abs(faceBounds.min.z - backingBounds.max.z)) <= 0.002);
    }
    disposeAll(boat);
  }
});

test('silhouettes differ geometrically and low quality reduces every model', () => {
  const signatures = new Set();
  for (const type of BOAT_TYPES) {
    const high = createBoat({ type }), low = createBoat({ type }, { low: true });
    const vertices = root => meshes(root).reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0);
    const size = new THREE.Box3().setFromObject(high).getSize(new THREE.Vector3());
    signatures.add(JSON.stringify([...size.toArray(), vertices(high)]));
    assert.ok(vertices(low) < vertices(high), `${type} simplifies in low quality`);
    disposeAll(high); disposeAll(low);
  }
  assert.equal(signatures.size, 6);
});

test('boat removal releases each owned geometry, plaque material and texture', () => {
  for (const type of BOAT_TYPES) for (const low of [false, true]) {
    const boat = createBoat({ type, projects }, { low }), resources = new Set();
    for (const node of meshes(boat)) {
      if (!node.geometry.userData.shared) resources.add(node.geometry);
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        if (material.userData.shared) continue;
        resources.add(material);
        for (const value of Object.values(material)) if (value?.isTexture && value !== gradientMap()) resources.add(value);
      }
    }
    const released = new Set(); for (const resource of resources) resource.addEventListener('dispose', () => released.add(resource));
    disposeAll(boat); assert.equal(released.size, resources.size, `${type} disposes all owned resources`);
  }
});

test('single-project fallback and empty craft keep metadata and labels honest', () => {
  const solo = createBoat({ type: 'canoe', projectId: 'local:one', label: 'One' });
  assert.deepEqual(solo.userData.projectIds, ['local:one']); assert.equal(meshes(solo).filter(mesh => mesh.userData.mountedLabel).length, 2);
  const empty = createBoat({ type: 'sailboat' }); assert.deepEqual(empty.userData.projectIds, []); assert.equal(meshes(empty).filter(mesh => mesh.userData.mountedLabel).length, 0);
  disposeAll(solo); disposeAll(empty);
  for (const crateCount of [2, 3, 4]) {
    const barge = createBoat({ type: 'barge', projects, crateCount });
    assert.equal(barge.userData.crateCount, crateCount);
    assert.equal(barge.userData.projectIds.length, crateCount);
    assert.equal(meshes(barge).filter(mesh => mesh.userData.mountedLabel).length, crateCount * 2);
    disposeAll(barge);
  }
});

test('oars, sternwheel and alternating paddles move on supported pivots, then freeze for reduced motion', () => {
  for (const type of ['rowboat', 'paddle-steamer', 'canoe']) {
    const boat = createBoat({ type }), pivots = [...boat.motion.oars.map(oar => oar.group), ...(boat.motion.wheel ? [boat.motion.wheel] : []), ...boat.motion.paddles.map(paddle => paddle.paddle)];
    const origins = pivots.map(pivot => pivot.position.toArray());
    const state = () => JSON.stringify(pivots.map(pivot => [pivot.rotation.toArray(), pivot.parent.visible]));
    updateBoat(boat, .1, .5, {}); const first = state();
    updateBoat(boat, .1, 3, {}); assert.notEqual(state(), first, `${type} animates`);
    assert.deepEqual(pivots.map(pivot => pivot.position.toArray()), origins, 'moving rigs retain their supported pivot');
    updateBoat(boat, .1, 4, { reducedMotion: true }); const frozen = state();
    updateBoat(boat, 20, 24, { reducedMotion: true }); assert.equal(state(), frozen);
    assert.equal(boat.motion.model.position.y, 0);
    if (type === 'canoe') assert.equal(boat.motion.paddles.filter(paddle => paddle.group.visible).length, 1);
    disposeAll(boat);
  }
});

test('low quality suppresses smoke and bob; reduced motion and quality rebuilds retain labels and night lights', () => {
  for (const type of BOAT_TYPES) {
    const entry = { type, projects, crateCount: 4 }, high = createBoat(entry), low = createBoat(entry, { low: true });
    const original = high.userData.projectIds.slice();
    updateBoat(high, .1, 2, { night: 0 }); const day = high.motion.lights[0].emissiveIntensity;
    updateBoat(high, .1, 3, { night: 1 }); assert.ok(high.motion.lights[0].emissiveIntensity > day);
    updateBoat(low, .1, 3, { night: 1, low: true }); assert.equal(low.motion.model.position.y, 0); assert.equal(low.motion.smoke.length, 0);
    updateBoat(high, .1, 4, { reducedMotion: true, night: 1 });
    const pose = meshes(high).map(node => [...node.position.toArray(), ...node.scale.toArray(), node.visible]);
    updateBoat(high, 50, 54, { reducedMotion: true, night: 1 });
    assert.deepEqual(meshes(high).map(node => [...node.position.toArray(), ...node.scale.toArray(), node.visible]), pose);
    assert.ok(high.motion.smoke.every(puff => !puff.visible));
    assert.deepEqual(high.userData.projectIds, original); assert.deepEqual(low.userData.projectIds, original);
    disposeAll(high); disposeAll(low);
  }
});

test('models reuse the policy boat types and single-project plaques are unobstructed from either side', () => {
  assert.equal(BOAT_TYPES, POLICY_BOAT_TYPES);
  for (const type of ['rowboat', 'paddle-steamer']) for (const low of [false, true]) {
    const boat = createBoat({ type, projectId: 'project-visible', label: 'GardenNotes' }, { low }); boat.updateMatrixWorld(true);
    const all = meshes(boat), faces = all.filter(mesh => mesh.userData.mountedLabel);
    // Decoration deliberately disables picking in the City; restore the base
    // raycast here to check actual visibility against the model's geometry.
    for (const node of all) node.raycast = THREE.Mesh.prototype.raycast;
    for (const face of faces) {
      const side = Math.sign(face.getWorldPosition(new THREE.Vector3()).z);
      // Keep samples off the plane's triangle seam to avoid ambiguous edge hits.
      for (const x of [-0.34, 0.02, 0.34]) for (const y of [-0.24, 0.01, 0.24]) {
        const point = face.localToWorld(new THREE.Vector3(x * face.geometry.parameters.width, y * face.geometry.parameters.height, 0));
        for (const rise of [0, 0.5, 1]) {
          const origin = point.clone().add(new THREE.Vector3(0, rise, side * 2));
          const ray = new THREE.Raycaster(origin, point.clone().sub(origin).normalize());
          const first = ray.intersectObjects(all, false)[0];
          assert.ok(first?.object === face, `${type} ${low ? 'low' : 'high'} plaque unobstructed at ${x},${y},${rise}`);
        }
      }
    }
    disposeAll(boat);
  }
});
