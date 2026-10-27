import assert from 'node:assert/strict';
import test from 'node:test';
import { THREE } from '../app/city/toon.js';
import { Building, BuildingManager, buildingSize, MATERIALS, setBuildingNight } from '../app/city/buildings.js';
import { HOME_VARIANTS, HOME_BODY_COLORS, HOME_LOT_SIZE, suburbPlan } from '../app/city/suburbs.js';
import { tickerSegments } from '../app/city/ticker.js';
import { CiBeacon } from '../app/city/ci.js';
import { NpcManager, groundY } from '../app/city/npc.js';
import { bridgeSpan, riverZ } from '../app/city/river-path.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
const local = (floors = 1) => ({ id: 'local:home', path: 'C:/home', name: 'Garden Notes', primaryLanguage: 'Python', metrics: { floors, footprint: 1 } });
const samples = new Map();
for (let i = -8; i <= 8 && samples.size < 6; i++) for (let j = 1; j <= 4; j++) {
  const plan = suburbPlan(local(), { i, j }); if (!samples.has(plan.variantName)) samples.set(plan.variantName, { i, j });
}
function canvas(t) {
  const original = globalThis.document, gradient = { addColorStop() {} };
  const context = new Proxy({ measureText: text => ({ width: text.length * 20 }), createLinearGradient: () => gradient }, { get: (object, property) => object[property] || (() => {}) });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  t.after(() => { if (original) globalThis.document = original; else delete globalThis.document; });
}
const particles = { enabled: false, emit() {} };
function home(project, cell, options = {}) { return new Building(project, cell, { districts: true, reducedMotion: () => false, animateIn: false, particles, ...options }); }

test('people stand on rendered home surfaces and retain bridge, street and HQ heights', t => {
  canvas(t);
  const parent = new THREE.Group(), buildings = new BuildingManager(parent, { particles, reducedMotion: () => false });
  const cell = { i: 1, j: 1 }, project = local(24);
  buildings.sync([project], new Map([[project.id, cell]]), new Set(), { districts: true, animate: false });
  const people = new NpcManager(parent, { buildings, particles, reducedMotion: () => false, river: () => ({ crossings: [8] }) });
  const b = buildings.get(project.id);
  parent.updateMatrixWorld(true);
  for (const [x, z] of [[-4.6, 4.8], [b.suburbs.door.x, 5.3], [b.suburbs.driveway.x, 5.3]]) {
    const px = b.origin.x + x, pz = b.origin.z + z;
    const ray = new THREE.Raycaster(new THREE.Vector3(px, 2, pz), new THREE.Vector3(0, -1, 0));
    const surface = ray.intersectObject(b.padGroup, true)[0];
    assert.ok(surface); near(people.surfaceY(px, pz), surface.point.y);
  }
  const span = bridgeSpan(8); near(people.surfaceY(8, riverZ(8)), span.deckY);
  near(people.surfaceY(0, 0), groundY(0, 0)); near(people.surfaceY(8, 16), groundY(8, 16));
  people.dispose(); buildings.dispose();
});
function watchOwned(roots) {
  const resources = new Set(), disposed = new Set();
  for (const root of roots) root.traverse(node => {
    if (node.geometry && !node.geometry.userData.shared) resources.add(node.geometry);
    if (node.material && !node.material.userData.shared) {
      resources.add(node.material);
      if (node.material.map) resources.add(node.material.map);
    }
  });
  for (const resource of resources) resource.addEventListener('dispose', () => disposed.add(resource));
  return () => assert.equal(disposed.size, resources.size);
}

test('six modern home variants and materials are stable per project and lot, never by growth or renaming', () => {
  assert.deepEqual(new Set(samples.keys()), new Set(HOME_VARIANTS));
  for (const [name, cell] of samples) {
    const small = suburbPlan(local(1), cell), big = suburbPlan({ ...local(24), name: 'Renamed' }, cell);
    assert.equal(small.variantName, name); assert.equal(big.variantName, name);
    assert.equal(small.body, big.body); assert.ok(HOME_BODY_COLORS.includes(small.body));
    assert.equal(small.doorColor, big.doorColor);
    assert.ok(small.floors >= 1 && small.floors <= 2); assert.equal(big.floors, small.floors);
    assert.equal(big.H, small.H); assert.ok(big.W > small.W && big.D > small.D);
    assert.ok(big.garage.w > small.garage.w);
  }
});

test('edge-neighbouring lots never share a home shape', () => {
  for (let n = 0; n < 40; n++) {
    const a = { id: `local:a${n}`, metrics: { floors: 1, footprint: 1 } }, b = { id: `local:b${n}`, metrics: { floors: 1, footprint: 1 } };
    for (const [ci, cj] of [[0, 1], [3, 2], [-2, 1]]) for (const [di, dj] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      assert.notEqual(suburbPlan(a, { i: ci, j: cj }).variantName, suburbPlan(b, { i: ci + di, j: cj + dj }).variantName);
    }
  }
});

test('every home, garden and active contractor fits its lot with a low supported roof', t => {
  canvas(t);
  for (const cell of samples.values()) for (const floors of [1, 12, 24]) {
    const b = home(local(floors), cell); b.setActive(true); b.setTicker(tickerSegments(b.project, 'full', 1));
    const bounds = new THREE.Box3().setFromObject(b.group);
    assert.ok(bounds.max.y <= 4.7, `${b.suburbs.variantName} remains low-rise`);
    assert.ok(bounds.max.y <= buildingSize(local(12)).H / 3);
    assert.ok(bounds.min.x >= cell.i * 16 - 6.5 && bounds.max.x <= cell.i * 16 + 6.5);
    assert.ok(bounds.min.z >= cell.j * 16 - 6.5 && bounds.max.z <= cell.j * 16 + 6.5);
    assert.ok(bounds.min.y >= 0);
    assert.equal(b.lot.padW, HOME_LOT_SIZE); assert.equal(b.lot.padD, HOME_LOT_SIZE); assert.equal(b.lot.district, 'suburbs');
    assert.deepEqual(b.seats, [], 'agents do not sit at an omitted shared bench');
    assert.equal(b.jib, null); assert.equal(b.scaffold, null);
    const point = b.rooftopPoint().add(new THREE.Vector3(b.origin.x, 0, b.origin.z));
    b.group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(point.clone().add(new THREE.Vector3(0, 0.05, 0)), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObjects(b.home.meshes, false)[0];
    assert.ok(hit); near(hit.point.y, point.y);
    b.dispose();
  }
});

test('larger projects expand outward without adding floors, moving lots, or lifting the yard', t => {
  canvas(t);
  for (const cell of samples.values()) {
    const b = home(local(1), cell), position = b.group.position.clone(), before = { ...b.size }, roof = b.home.roofY;
    b.apply(local(24), { animate: true });
    assert.equal(b.size.floors, before.floors); assert.equal(b.home.roofY, roof);
    assert.ok(b.size.W > before.W && b.size.D > before.D);
    assert.equal(b.anim.kind, 'widen'); near(b.tower.scale.y, 1);
    b.group.updateMatrixWorld(true);
    const yard = new THREE.Box3().setFromObject(b.padGroup);
    for (let step = 0; step < 10; step++) { b.update(0.1, step * 0.1, { particles, reducedMotion: false }); near(b.tower.scale.y, 1); }
    assert.deepEqual(b.group.position, position); assert.equal(b.anim, null);
    assert.deepEqual(new THREE.Box3().setFromObject(b.padGroup), yard);
    b.dispose();
  }
});

test('street-facing garages and supported ladders avoid trees, fences, and shared curb lamps', t => {
  canvas(t);
  for (const cell of samples.values()) {
    const b = home(local(24), cell), plan = b.suburbs, drive = plan.driveway;
    assert.ok(drive.x - drive.width / 2 > 0, 'driveway is clear of the front-left streetlamp');
    assert.ok(drive.x + drive.width / 2 < 5.35, 'driveway clears side fence and streetlamp');
    assert.ok(drive.maxZ > drive.minZ && drive.maxZ < 5.9);
    for (const tree of plan.trees) {
      assert.ok(Math.abs(tree.x - plan.door.x) > tree.radius + 0.45, 'tree canopy clears the entry walk');
      assert.ok(tree.x + tree.radius < drive.x - drive.width / 2, 'tree canopy clears the driveway');
    }
    b.group.updateMatrixWorld(true);
    const yard = new THREE.Box3().setFromObject(b.padGroup);
    assert.ok(yard.min.z >= cell.j * 16 - 5.7 && yard.max.z <= cell.j * 16 + 5.7, 'yard stays off the surrounding sidewalks');
    b.setActive(true); b.group.updateMatrixWorld(true);
    const ladder = b.contractor.group.userData.ladder;
    const top = new THREE.Vector3(...ladder.top).add(new THREE.Vector3(b.origin.x, 0, b.origin.z));
    const towardWall = new THREE.Raycaster(top.clone().add(new THREE.Vector3(0, 0, 0.1)), new THREE.Vector3(0, 0, -1));
    const support = towardWall.intersectObjects(b.home.meshes, false)[0];
    assert.ok(support && support.distance < 0.16, 'ladder reaches the actual front facade');
    const foot = new THREE.Vector3(...ladder.foot).add(new THREE.Vector3(b.origin.x, 0, b.origin.z));
    const ground = new THREE.Raycaster(foot.clone().add(new THREE.Vector3(0, 0.05, 0)), new THREE.Vector3(0, -1, 0));
    const landed = ground.intersectObject(b.padGroup, true)[0];
    assert.ok(landed && landed.distance < 0.1, 'ladder feet reach yard ground');
    const wheels = b.contractor.meshes.find(mesh => mesh.material.color.getHexString() === '333d45');
    wheels.geometry.computeBoundingBox(); near(wheels.geometry.boundingBox.min.y, 0.29);
    const rails = b.contractor.meshes.find(mesh => mesh.material.color.getHexString() === 'b6c0c1');
    rails.geometry.computeBoundingBox(); assert.ok(rails.geometry.boundingBox.min.y <= 0.26);
    const plaque = b.plaque.getWorldPosition(new THREE.Vector3()), plaqueW = b.plaque.geometry.parameters.width;
    for (const dx of [-plaqueW * 0.49, 0, plaqueW * 0.49]) {
      const ray = new THREE.Raycaster(plaque.clone().add(new THREE.Vector3(dx, 0, 0)), new THREE.Vector3(0, 0, -1));
      const board = ray.intersectObjects(b.home.meshes, false)[0];
      assert.ok(board && board.distance < 0.002, 'name plaque is supported across its width');
    }
    b.dispose();
  }
});

test('home collision boxes cover the actual wings while leaving the open front yard traversable', t => {
  canvas(t);
  for (const cell of samples.values()) {
    const b = home(local(24), cell); b.group.updateMatrixWorld(true);
    const position = b.body.geometry.getAttribute('position');
    const contains = (box, p) => p.x >= box.x0 - 1e-5 && p.x <= box.x1 + 1e-5 && p.z >= box.z0 - 1e-5 && p.z <= box.z1 + 1e-5 && p.y >= box.y0 - 1e-5 && p.y <= box.y1 + 1e-5;
    for (let i = 0; i < position.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(b.body.matrixWorld);
      assert.ok(b.collisionBoxes.some(box => contains(box, p)), 'a rendered house wing must block entry');
    }
    assert.ok(!b.collisionBoxes.some(box => contains(box, new THREE.Vector3(b.origin.x - 1, 1, b.origin.z + 5.1))));
    const inactiveCount = b.collisionBoxes.length; b.setActive(true);
    assert.equal(b.collisionBoxes.length, inactiveCount + 1, 'the contractor van also blocks entry');
    b.setActive(false); assert.equal(b.collisionBoxes.length, inactiveCount); b.dispose();
  }
});

test('home walking heights match real lawn, walkway and driveway meshes throughout yard scaling', t => {
  canvas(t);
  const parent = new THREE.Group(), manager = new BuildingManager(parent, { particles, reducedMotion: () => false });
  for (const cell of samples.values()) {
    const project = local(24); manager.sync([project], new Map([[project.id, cell]]), new Set(), { districts: true, animate: false });
    const b = manager.get(project.id), plan = b.suburbs;
    for (const scale of [1, 0.6]) {
      b.padGroup.scale.setScalar(scale); parent.updateMatrixWorld(true);
      for (const [x, z] of [[-4.6, 4.8], [plan.door.x, 5.3], [plan.driveway.x, 5.3]]) {
        const px = b.origin.x + x * scale, pz = b.origin.z + z * scale;
        const ray = new THREE.Raycaster(new THREE.Vector3(px, 2, pz), new THREE.Vector3(0, -1, 0));
        const ground = ray.intersectObject(b.padGroup, true)[0];
        assert.ok(ground); near(manager.groundAt(px, pz), ground.point.y);
      }
      assert.equal(manager.groundAt(b.origin.x + 7, b.origin.z), null);
    }
  }
  manager.sync([], new Map(), new Set(), { districts: true, animate: false });
  assert.equal(manager.groundAt(0, 0), null); manager.dispose();
});

test('enabling reduced motion during a home expansion settles it without continued movement', t => {
  canvas(t);
  const b = home(local(1), samples.values().next().value);
  b.apply(local(24), { animate: true }); b.update(0.1, 0.1, { particles, reducedMotion: false });
  assert.ok(b.anim); assert.ok(b.tower.scale.x < 1);
  b.update(0.1, 0.2, { particles, reducedMotion: true });
  assert.equal(b.anim, null); assert.deepEqual(b.tower.scale.toArray(), [1, 1, 1]);
  b.update(10, 10.2, { particles, reducedMotion: true }); assert.deepEqual(b.tower.scale.toArray(), [1, 1, 1]);
  b.dispose();
});

test('busy homes use contractor activity and solar glints with steady reduced-motion lighting', t => {
  canvas(t);
  const b = home(local(), samples.values().next().value);
  assert.equal(b.contractor, null); b.setActive(true);
  const contractor = b.contractor, release = watchOwned([contractor.group]);
  b.update(0.1, 1, { particles, reducedMotion: true });
  const still = [b.home.solarMaterial.emissiveIntensity, contractor.amberMaterial.emissiveIntensity];
  b.update(100, 101, { particles, reducedMotion: true });
  assert.deepEqual([b.home.solarMaterial.emissiveIntensity, contractor.amberMaterial.emissiveIntensity], still);
  b.update(0.1, 0, { particles, reducedMotion: false }); const amber = contractor.amberMaterial.emissiveIntensity;
  b.update(0.1, 0.5, { particles, reducedMotion: false }); assert.notEqual(contractor.amberMaterial.emissiveIntensity, amber);
  b.setActive(false); release(); assert.equal(contractor.group.parent, null); assert.equal(b.contractor, null);
  b.update(0.1, 2, { particles, reducedMotion: false }); near(b.home.solarMaterial.emissiveIntensity, 0.08);
  setBuildingNight(0); const day = MATERIALS.wallLight.emissiveIntensity;
  setBuildingNight(1); assert.ok(MATERIALS.wallLight.emissiveIntensity > day); setBuildingNight(0);
  b.dispose();
});

test('home tickers and CI markers stay on their actual roof during animation and rebuild', t => {
  canvas(t);
  for (const cell of samples.values()) {
    const b = home(local(12), cell); b.setTicker(tickerSegments(b.project, 'full', 2, { failing: true }));
    const roof = b.home.ticker, beacon = new CiBeacon(b);
    assert.equal(b.ticker.mesh.position.x, roof.x); assert.equal(b.ticker.mesh.position.z, roof.z);
    assert.ok(b.ticker.mesh.scale.y < 1); assert.ok(b.pickables.includes(b.ticker.mesh));
    for (const scale of [0.1, 0.6, 1]) {
      b.tower.scale.y = scale; b.group.updateMatrixWorld(true);
      near(beacon.group.getWorldPosition(new THREE.Vector3()).y, b.home.roofPoint.y * scale);
    }
    beacon.dispose();
    const oldBand = b.ticker.mesh, oldHome = b.home.group, released = watchOwned([b.tower, b.padGroup]);
    b.apply(local(24));
    assert.equal(oldBand.parent, null); assert.equal(oldHome.parent, null); released();
    assert.ok(b.ticker); b.dispose();
  }
});

test('home removal releases owned assets and keeps Downtown, contributor and Spark architecture separate', t => {
  canvas(t);
  const cell = samples.values().next().value, b = home(local(24), cell); b.setActive(true);
  const release = watchOwned([b.group]); b.dispose(); release();
  for (const options of [{ districts: false }, { mirror: true }]) {
    const legacy = home(local(24), cell, options);
    assert.equal(legacy.suburbs, null); assert.equal(legacy.size.floors, 24); legacy.dispose();
  }
  const tower = home({ ...local(24), ids: ['local:home', 'gh:owner/home'] }, { i: 1, j: -2 });
  assert.equal(tower.suburbs, null); assert.equal(tower.style.key, 'downtown'); assert.equal(tower.size.floors, 24);
  tower.setActive(true); assert.ok(tower.jib); assert.equal(tower.contractor, null); tower.dispose();
});
