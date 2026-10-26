import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { createBoat, BOAT_TYPES } from '../app/city/boat-models.js';
import { BOAT_TYPES as POLICY_BOAT_TYPES } from '../app/city/boats.js';
import { disposeAll } from '../app/city/fx.js';

const context = new Proxy({ measureText: text => ({ width: text.length * 30 }) }, { get: (obj, prop) => obj[prop] || (() => {}) });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
const projects = Array.from({ length: 3 }, (_, n) => ({ projectId: `project-${n}`, label: `Project ${n}` }));
const meshes = root => { const result = []; root.traverse(node => { if (node.isMesh) result.push(node); }); return result; };

test('six boat types in both qualities cross the waterline and fit the river and bridge envelope', () => {
  for (const type of BOAT_TYPES) for (const low of [false, true]) {
    const boat = createBoat({ type, projects }, { low });
    const bounds = new THREE.Box3().setFromObject(boat);
    assert.ok(bounds.min.y < 0 && bounds.max.y > 0, `${type} crosses the waterline`);
    assert.ok(bounds.min.x >= -1.65 && bounds.max.x <= 1.65, `${type} length`);
    assert.ok(bounds.min.z >= -0.72 && bounds.max.z <= 0.72, `${type} width including oars, wheels, labels`);
    assert.ok(bounds.max.y <= 1.40, `${type} bridge clearance`);
    assert.ok(1.77 - (bounds.max.y + 0.18) >= 0.19);
    assert.equal(boat.userData.boatType, type); assert.equal(boat.userData.type, type);
    assert.deepEqual(boat.userData.projectIds, projects.map(p => p.projectId));
    if (low) for (const mesh of meshes(boat)) assert.ok(!mesh.castShadow && !mesh.receiveShadow);
    disposeAll(boat);
  }
});

test('every project plaque is mounted on a backing board that touches the hull', () => {
  for (const type of BOAT_TYPES) {
    const boat = createBoat({ type, projects }); boat.updateMatrixWorld(true);
    const hull = new THREE.Box3().setFromObject(boat.getObjectByName('waterline-hull'));
    const faces = meshes(boat).filter(mesh => mesh.userData.mountedLabel);
    assert.equal(faces.length, 6);
    for (const face of faces) {
      const mount = face.parent; assert.ok(mount.userData.labelMount);
      assert.equal(mount.userData.projectId, face.userData.projectId);
      const backing = mount.children.find(child => !child.userData.mountedLabel);
      const backingBounds = new THREE.Box3().setFromObject(backing), faceBounds = new THREE.Box3().setFromObject(face);
      assert.ok(backingBounds.intersectsBox(hull), `${type} label backing contacts hull`);
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
        for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
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
