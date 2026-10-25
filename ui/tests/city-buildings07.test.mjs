import assert from 'node:assert/strict';
import test from 'node:test';
import { THREE, addOutline } from '../app/city/toon.js';
import { Building, styleFor } from '../app/city/buildings.js';
import { ciMarker, CiBeacon, CityCi } from '../app/city/ci.js';
import { tickerSegments } from '../app/city/ticker.js';
import { instancedOutline, disposeAll } from '../app/city/fx.js';

const near = (a, b, epsilon = 1e-5) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
function fakeCanvas(t) {
  const original = globalThis.document;
  const gradient = { addColorStop() {} };
  const context = new Proxy({ measureText: text => ({ width: String(text).length * 20 }), createLinearGradient: () => gradient }, { get: (object, property) => property in object ? object[property] : () => {} });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  t.after(() => { if (original) globalThis.document = original; else delete globalThis.document; });
}
function fixture(project, { mirror = false, animateIn = false } = {}) {
  const particles = { emit() {}, enabled: false };
  return new Building(project, { i: 1, j: -1 }, { particles, reducedMotion: () => false, districts: true, mirror, animateIn });
}

test('CI selection is a rooftop beacon only for a failed summary and the ticker names it', () => {
  for (const summary of [null, undefined, {}, { failing: false }, { pending: true }, { failing: 'true' }]) {
    assert.equal(ciMarker(summary), null);
    assert.ok(!tickerSegments({ name: 'A' }, 'full', 0, summary).some(s => s.text === 'CI failing'));
  }
  assert.equal(ciMarker({ failing: true }), 'beacon');
  assert.equal(tickerSegments({ name: 'A' }, 'full', 0, { failing: true }).at(-1).text, 'CI failing');
});

test('a rooftop beacon stays attached during scale changes and disposes its geometry', () => {
  const building = { id: 'city', tower: new THREE.Group(), rooftopPoint: () => new THREE.Vector3(0, 30, 0) };
  const beacon = new CiBeacon(building);
  let disposed = 0;
  beacon.group.traverse(n => n.geometry?.addEventListener('dispose', () => disposed++));
  for (const scale of [0.02, 0.35, 1, 1.1]) {
    building.tower.scale.y = scale;
    building.tower.updateMatrixWorld(true);
    near(beacon.group.getWorldPosition(new THREE.Vector3()).y, 30 * scale);
  }
  beacon.update(1, 0, true); const still = beacon.material.emissiveIntensity;
  beacon.update(1, 100, true); assert.equal(beacon.material.emissiveIntensity, still);
  beacon.dispose();
  assert.equal(beacon.group.parent, null);
  assert.equal(disposed, 3);
});

test('CI sync removes stale beacons and replaces a roof rebuilt on the same building', () => {
  const building = { id: 'city', tower: new THREE.Group(), rooftopPoint: () => new THREE.Vector3(0, 20, 0) };
  let home = true;
  const buildings = new Map([['city', building]]);
  const ci = new CityCi({ buildings, home: () => home, reducedMotion: () => true, caller: () => null });
  ci.results.set('city', { summary: { failing: true } }); ci.sync();
  const old = ci.beacons.get('city');
  assert.equal(building.tower.children.length, 1);
  old.group.removeFromParent(); ci.sync();
  assert.notEqual(ci.beacons.get('city'), old);
  assert.equal(building.tower.children.length, 1);
  home = false; ci.sync();
  assert.equal(ci.beacons.size, 0); assert.equal(building.tower.children.length, 0);
  home = true; ci.sync(); buildings.delete('city'); ci.sync();
  assert.equal(ci.beacons.size, 0);
  ci.dispose();
});

test('an outline expands translated rooftop geometry about its own centre', () => {
  const geometry = new THREE.BoxGeometry(0.22, 0.1, 0.18);
  geometry.translate(-3.2, 40, 2.7);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  addOutline(mesh, { thickness: 0.04 });
  const hull = mesh.children[0];
  const parent = new THREE.Group(); parent.add(mesh); parent.rotation.y = 0.7;
  for (const scale of [0.02, 0.6, 1.12]) {
    parent.scale.set(1, scale, 1); parent.updateMatrixWorld(true);
    const original = geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    const outlined = geometry.boundingBox.clone().applyMatrix4(hull.matrixWorld);
    const a = original.getCenter(new THREE.Vector3()), b = outlined.getCenter(new THREE.Vector3());
    near(a.x, b.x); near(a.y, b.y); near(a.z, b.z);
    assert.ok(outlined.containsBox(original));
    near(outlined.max.y - original.max.y, 0.04 * scale);
  }
  geometry.dispose(); mesh.material.dispose();
});

test('district architecture ignores language while contributor architecture remains unchanged', () => {
  assert.equal(styleFor({ id: 'a', primaryLanguage: 'Rust' }, 'downtown').key, 'downtown');
  assert.equal(styleFor({ id: 'a', primaryLanguage: 'TypeScript' }, 'oldtown').key, 'oldtown');
  assert.equal(styleFor({ id: 'a', primaryLanguage: 'Rust' }).key, 'foundry');
});

test('instanced outlines preserve translated geometry centres and dispose their owned clones', () => {
  const geometry = new THREE.BoxGeometry(0.1, 0.2, 0.1); geometry.translate(5, 30, -8); geometry.userData.shared = true;
  const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), 1);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(20, 1, 6));
  const hull = instancedOutline(mesh, 0.03);
  hull.geometry.computeBoundingBox(); geometry.computeBoundingBox();
  const a = geometry.boundingBox.getCenter(new THREE.Vector3()), b = hull.geometry.boundingBox.getCenter(new THREE.Vector3());
  near(a.x, b.x); near(a.y, b.y); near(a.z, b.z);
  assert.equal(hull.instanceMatrix, mesh.instanceMatrix);
  assert.equal(hull.geometry.userData.shared, undefined);
  let disposed = 0; hull.geometry.addEventListener('dispose', () => disposed++);
  disposeAll(hull); assert.equal(disposed, 1);
  geometry.dispose(); mesh.dispose(); mesh.material.dispose();
});

test('unbuilt repositories stay pickable without a crane; local linking builds the tower', t => {
  fakeCanvas(t);
  const project = { id: 'gh:owner/demo', name: 'Demo', metrics: { floors: 4, footprint: 1 } };
  const building = fixture(project);
  assert.equal(building.unbuilt, true); assert.equal(building.bodyMaterial.opacity, 0.1);
  assert.ok(building.pickables.includes(building.body));
  building.setActive(true); assert.equal(building.active, false); assert.equal(building.scaffold, null);
  assert.equal(building.apply({ ...project, path: 'C:/demo' }), true);
  assert.equal(building.unbuilt, false); assert.equal(building.bodyMaterial.opacity, 1);
  building.dispose(); assert.equal(building.group.parent, null);
});

test('crane meshes and outlines stay inside the roof footprint during rotation and growth', t => {
  fakeCanvas(t);
  for (const mirror of [false, true]) {
    const building = fixture({ id: 'local:demo', name: 'Demo', path: 'C:/demo', metrics: { floors: 2, footprint: 1 } }, { mirror });
    building.setActive(true);
    const crane = building.jib.parent;
    for (const angle of [-1.2, 0, 1.2]) for (const scale of [0.02, 0.6, 1.12]) {
      building.jib.rotation.y = angle; building.tower.scale.y = scale;
      building.group.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(crane);
      assert.ok(box.min.x >= building.origin.x - building.size.W / 2);
      assert.ok(box.max.x <= building.origin.x + building.size.W / 2);
      assert.ok(box.min.z >= building.origin.z - building.size.D / 2);
      assert.ok(box.max.z <= building.origin.z + building.size.D / 2);
    }
    let disposed = 0; building.scaffold.traverse(n => n.geometry?.addEventListener('dispose', () => disposed++));
    building.setActive(false);
    assert.ok(disposed > 0); assert.equal(crane.parent.parent, null);
    building.dispose();
  }
});

test('scaffold sparks follow the scaled tower instead of appearing at its finished height', t => {
  fakeCanvas(t);
  const building = fixture({ id: 'local:scaffold', name: 'Scaffold', path: 'C:/scaffold', metrics: { floors: 12, footprint: 1 } });
  building.setActive(true); building.tower.scale.y = 0.2; building.elapsedEmit = 1;
  t.mock.method(Math, 'random', () => 0.5);
  const emissions = [];
  building.update(0.01, 0, { reducedMotion: false, particles: { enabled: true, emit: (...args) => emissions.push(args) } });
  const spark = emissions.find(([kind]) => kind === 'spark');
  assert.ok(spark);
  assert.ok(spark[1].y < building.scaffoldFront.y0);
  assert.ok(spark[1].y <= (building.scaffoldFront.top + 0.6) * building.tower.scale.y);
  building.dispose();
});
