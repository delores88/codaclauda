import assert from 'node:assert/strict';
import test from 'node:test';
import { THREE, addOutline } from '../app/city/toon.js';
import { Building, BuildingManager, styleFor } from '../app/city/buildings.js';
import { ciMarker, CiBeacon, CityCi } from '../app/city/ci.js';
import { tickerSegments } from '../app/city/ticker.js';
import { instancedOutline, disposeAll } from '../app/city/fx.js';

const near = (a, b, epsilon = 1e-5) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
function fakeCanvas(t) {
  const original = globalThis.document;
  const gradient = { addColorStop() {} };
  const drawnText = [];
  const context = new Proxy({ measureText: text => ({ width: String(text).length * 20 }), createLinearGradient: () => gradient, fillText: text => drawnText.push(text) }, { get: (object, property) => property in object ? object[property] : () => {} });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  t.after(() => { if (original) globalThis.document = original; else delete globalThis.document; });
  return drawnText;
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
  assert.equal(styleFor({ id: 'a', primaryLanguage: 'TypeScript' }, 'suburbs').key, 'suburbs');
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
  const drawnText = fakeCanvas(t);
  const project = { id: 'gh:owner/demo', name: 'Demo', metrics: { floors: 4, footprint: 1 } };
  const building = fixture(project);
  assert.equal(building.unbuilt, true);
  assert.equal(building.bodyMaterial.opacity, 1);
  assert.equal(building.bodyMaterial.transparent, false);
  building.group.traverse(node => { if (node.material) { assert.equal(node.material.opacity, 1); assert.equal(node.material.transparent, false); } assert.ok(!node.isLineSegments); });
  building.body.geometry.computeBoundingBox();
  const height = building.body.geometry.boundingBox.getSize(new THREE.Vector3()).y;
  near(height, 0.15);
  assert.ok(building.pickables.includes(building.body));
  assert.ok(building.pickables.includes(building.plaque));
  assert.equal(building.plaque.userData.buildingId, project.id);
  assert.ok(drawnText.includes(project.name));
  assert.ok(drawnText.includes('\u2193 Clone to build'));
  const sign = building.unbuiltSign;
  assert.equal(sign.parent, building.group);
  building.setActive(true); assert.equal(building.active, false); assert.equal(building.scaffold, null);
  assert.equal(building.apply({ ...project, path: 'C:/demo' }), true);
  assert.equal(building.unbuilt, false); assert.equal(building.bodyMaterial.opacity, 1);
  assert.equal(sign.parent, null); assert.equal(building.unbuiltSign, null);
  building.dispose(); assert.equal(building.group.parent, null);
});

test('unbuilt construction, rebuilds and manager sync never mount a roof ticker; local buildings retain theirs', t => {
  fakeCanvas(t);
  const parent = new THREE.Group(), particles = { emit() {}, enabled: false };
  const manager = new BuildingManager(parent, { particles, reducedMotion: () => false });
  const project = { id: 'gh:owner/ticker', name: 'Remote ticker', metrics: { floors: 4 } };
  const cells = new Map([[project.id, { i: 1, j: -1 }]]), active = new Set();
  const tickers = new Map([[project.id, tickerSegments(project, 'full', 1)]]);
  const sync = (p, options = {}) => manager.sync([p], cells, active, { animate: false, districts: true, tickers, ...options });
  sync(project);
  const building = manager.get(project.id);
  assert.equal(building.ticker, null);
  building.mountTicker(); assert.equal(building.ticker, null);
  sync({ ...project, name: 'Renamed', metrics: { floors: 8 } });
  assert.equal(building.ticker, null); assert.ok(building.tickerInfo);
  const sign = building.unbuiltSign, at = new THREE.Box3().setFromObject(sign).getCenter(new THREE.Vector3());
  building.update(0.2, 0.2, { reducedMotion: false, particles });
  near(new THREE.Box3().setFromObject(sign).getCenter(new THREE.Vector3()).y, at.y);
  sync({ ...project, path: 'C:/ticker' });
  assert.ok(building.ticker); assert.equal(building.unbuiltSign, null);
  const oldTicker = building.ticker.mesh;
  sync(project);
  assert.equal(building.ticker, null); assert.equal(oldTicker.parent, null);
  sync(project, { tickers: null }); assert.equal(building.ticker, null);
  // The contributor path and Spark mirror keep their established real-building tickers.
  sync(project, { districts: false }); assert.ok(building.ticker);
  const mirror = fixture(project, { mirror: true }); mirror.setTicker(tickers.get(project.id));
  assert.ok(mirror.ticker); assert.equal(mirror.unbuilt, false); mirror.dispose();
  manager.dispose();
});

test('clone reservations keep a small centered pad, survey details and trees when project metrics grow', t => {
  fakeCanvas(t);
  for (const cell of [{ i: 0, j: -2 }, { i: 1, j: 0 }, { i: 3, j: -1 }]) {
    const project = { id: 'gh:owner/reservation', name: 'Reservation', metrics: { floors: 2, footprint: 1 } };
    const b = new Building(project, cell, { particles: { emit() {} }, reducedMotion: () => true, districts: true });
    const r = b.parcel?.rect || { x0: cell.i * 16 - 5.7, x1: cell.i * 16 + 5.7, z0: cell.j * 16 - 5.7, z1: cell.j * 16 + 5.7 };
    near(b.size.W / (r.x1 - r.x0), 0.52); near(b.size.D / (r.z1 - r.z0), 0.52);
    b.group.updateMatrixWorld(true); b.body.geometry.computeBoundingBox();
    const center = b.body.localToWorld(b.body.geometry.boundingBox.getCenter(new THREE.Vector3()));
    near(center.x, (r.x0 + r.x1) / 2); near(center.z, (r.z0 + r.z1) / 2);
    assert.equal(b.tower.children.filter(n => n.name === 'clone-survey-flag').length, 4);
    assert.ok(b.tower.getObjectByName('clone-tile-seams'));
    assert.ok(b.tower.getObjectByName('clone-curb-and-stakes'));
    assert.equal(b.padGroup.getObjectByName('clone-lot-trees').userData.count, 3);
    const before = [b.size.W, b.size.D, b.size.H];
    b.apply({ ...project, metrics: { floors: 20, footprint: 3 } });
    assert.deepEqual([b.size.W, b.size.D, b.size.H], before);
    assert.equal(b.group.getObjectByName('clone-sign-lamp').material.transparent, false);
    b.dispose();
  }
});

test('unbuilt signs and ghost resources are released on rebuild and animated removal', t => {
  fakeCanvas(t);
  const parent = new THREE.Group(), particles = { emit() {}, enabled: false };
  const manager = new BuildingManager(parent, { particles, reducedMotion: () => false });
  const project = { id: 'gh:owner/disposal', name: 'Disposable', metrics: { floors: 2 } };
  const cells = new Map([[project.id, { i: 1, j: -1 }]]);
  manager.sync([project], cells, new Set(), { animate: false, districts: true });
  const building = manager.get(project.id);
  const watch = roots => {
    const resources = new Set();
    for (const root of roots) root.traverse(node => {
      if (node.geometry && !node.geometry.userData.shared) resources.add(node.geometry);
      if (node.material && !node.material.userData.shared) { resources.add(node.material); if (node.material.map) resources.add(node.material.map); }
    });
    const disposed = new Set(); for (const resource of resources) resource.addEventListener('dispose', () => disposed.add(resource));
    return () => assert.equal(disposed.size, resources.size);
  };
  const oldSign = building.unbuiltSign, rebuilt = watch([building.tower, oldSign]);
  building.apply({ ...project, name: 'Rebuilt' }); rebuilt(); assert.equal(oldSign.parent, null);
  const sign = building.unbuiltSign, removed = watch([building.tower, sign, building.padGroup]);
  manager.sync([], cells, new Set(), { districts: true });
  assert.equal(manager.get(project.id), null);
  manager.update(0.45, 0.45, { reducedMotion: false, particles });
  assert.ok(sign.scale.y < 1);
  manager.update(0.5, 0.95, { reducedMotion: false, particles });
  removed(); assert.equal(building.group.parent, null); assert.equal(sign.parent, null);
  assert.equal(manager.removing.size, 0); manager.dispose();
});

test('CI remains in the panel for unbuilt repositories without a rooftop beacon', () => {
  const building = { id: 'ghost', unbuilt: true, tower: new THREE.Group(), rooftopPoint: () => new THREE.Vector3(0, 20, 0) };
  const ci = new CityCi({ buildings: new Map([['ghost', building]]), home: () => true, reducedMotion: () => true, caller: () => null });
  ci.results.set('ghost', { summary: { failing: true } }); ci.sync();
  assert.equal(ci.beacons.size, 0); assert.equal(ci.status('ghost').summary.failing, true);
  building.unbuilt = false; ci.sync(); assert.equal(ci.beacons.size, 1);
  const beacon = ci.beacons.get('ghost').group;
  building.unbuilt = true; ci.sync();
  assert.equal(ci.beacons.size, 0); assert.equal(beacon.parent, null);
  ci.dispose();
});

test('delayed CI celebrations stop if a linked building becomes unbuilt before the burst', t => {
  const building = { id: 'changing', unbuilt: false, topPoint: () => new THREE.Vector3(0, 20, 0) };
  const callbacks = [], emissions = [];
  t.mock.method(globalThis, 'setTimeout', callback => { callbacks.push(callback); return callbacks.length; });
  const ci = new CityCi({ buildings: new Map([[building.id, building]]), home: () => true, reducedMotion: () => false, caller: () => null, world: { particles: { enabled: true, emit: (...args) => emissions.push(args) } } });
  ci.fireworks(building.id);
  assert.equal(callbacks.length, 3);
  building.unbuilt = true;
  for (const callback of callbacks) callback();
  assert.equal(emissions.length, 0);
  ci.fireworks(building.id); assert.equal(callbacks.length, 3);
  ci.dispose();
});

test('crane meshes and outlines stay inside the roof footprint during rotation and growth', t => {
  fakeCanvas(t);
  for (const mirror of [false, true]) {
    const building = fixture({ id: 'local:demo', ids: ['local:demo', 'gh:owner/demo'], name: 'Demo', path: 'C:/demo', metrics: { floors: 2, footprint: 1 } }, { mirror });
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
  const building = fixture({ id: 'local:scaffold', ids: ['local:scaffold', 'gh:owner/scaffold'], name: 'Scaffold', path: 'C:/scaffold', metrics: { floors: 12, footprint: 1 } });
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
