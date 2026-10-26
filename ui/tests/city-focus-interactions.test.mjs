import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { Building } from '../app/city/buildings.js';
import { World, PIVOT_Y } from '../app/city/world.js';
import { OrbitControls } from '../vendor/three/addons/OrbitControls.js';
import { cameraIdle } from '../app/city/camera-math.js';

globalThis.window = {};
globalThis.localStorage = { getItem: () => null };
const { CityView, focusBounds } = await import('../app/views/city.js');
const close = (actual, expected) => assert.ok(actual.distanceTo(expected) < 1e-6, `${actual.toArray()} != ${expected.toArray()}`);

function canvas(t) {
  const previous = globalThis.document;
  const context = new Proxy({ measureText: text => ({ width: text.length * 20 }), createLinearGradient: () => ({ addColorStop() {} }) }, { get: (o, p) => o[p] || (() => {}) });
  globalThis.document = { createElement: () => ({ getContext: () => context }), querySelector: () => null };
  t.after(() => globalThis.document = previous);
}

function fixture({ spark = false, aspect = 1.6 } = {}) {
  const scene = new THREE.Group(), pivot = new THREE.Group(), land = new THREE.Group();
  scene.add(pivot); pivot.add(land); pivot.position.y = PIVOT_Y; land.position.y = -PIVOT_Y;
  pivot.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), .7);
  if (spark) pivot.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
  const rest = pivot.quaternion.clone(), buildings = new Map(), mirrors = new Map(), boats = new Map();
  const view = Object.create(CityView.prototype), flights = [], walks = [];
  const world = {
    camera: new THREE.PerspectiveCamera(40, aspect, .25, 10000), azimuth: .62, settled: true, side: spark ? 'spark' : 'pc', restSide: spark ? 'spark' : 'pc', underside: true,
    toWorld: (p, { atRest = false } = {}) => p.clone().sub(new THREE.Vector3(0, PIVOT_Y, 0)).applyQuaternion(atRest ? rest : pivot.quaternion).add(new THREE.Vector3(0, PIVOT_Y, 0)),
    toLocal: p => p.clone().sub(new THREE.Vector3(0, PIVOT_Y, 0)).applyQuaternion(pivot.quaternion.clone().invert()).add(new THREE.Vector3(0, PIVOT_Y, 0)),
    flipTo(side) { this.restSide = side; },
    flyAfterTurn(shot, options) { flights.push({ ...shot, options }); },
    ndc: (x, y) => new THREE.Vector2(x, y), groundAt: () => new THREE.Vector3(4, .2, 7),
  };
  Object.assign(view, { world, buildings: { get: id => buildings.get(id) }, spark: { shown: spark, buildings: mirrors }, river: { getBoat: id => boats.get(id) }, npcs: { walkOwner: (x, z) => walks.push([x, z]) }, stage: { focus() {} } });
  view.select = target => view.selection = target;
  return { view, world, scene, pivot, land, rest, buildings, mirrors, boats, flights, walks };
}

function assertFramed(world, shot, object) {
  assert.equal(shot.options.center, true);
  const camera = world.camera;
  camera.position.setFromSpherical(new THREE.Spherical(shot.distance, shot.polar, shot.azimuth)).add(shot.target);
  camera.lookAt(shot.target); camera.updateMatrixWorld(true);
  object.updateWorldMatrix(true, true);
  const rendered = new THREE.Box3().setFromObject(object);
  close(shot.target, rendered.getCenter(new THREE.Vector3()));
  for (const x of [rendered.min.x, rendered.max.x]) for (const y of [rendered.min.y, rendered.max.y]) for (const z of [rendered.min.z, rendered.max.z]) {
    const p = new THREE.Vector3(x, y, z).project(camera);
    assert.ok(Math.abs(p.x) <= .801 && Math.abs(p.y) <= .801, `focus clips visible bounds: ${p.toArray()}`);
  }
}

test('Focus frames tall towers, wide homes and ghost signs at corner lots on both faces and narrow screens', t => {
  canvas(t);
  const projects = [
    { id: 'gh:owner/tower', path: 'C:/tower', name: 'Tower', metrics: { floors: 24, footprint: 3 } },
    { id: 'local:home', path: 'C:/home', name: 'Home', metrics: { floors: 24, footprint: 3 } },
    { id: 'gh:owner/ghost', name: 'Ghost', metrics: { floors: 24, footprint: 3 } },
  ];
  for (const spark of [false, true]) for (const aspect of [.4, 1.6]) for (const project of projects) {
    const f = fixture({ spark, aspect }), parent = new THREE.Group(); f.land.add(parent);
    if (spark) { parent.rotation.x = Math.PI; parent.position.y = -7.2; }
    const b = new Building(project, { i: 24, j: 24 }, { districts: true, mirror: spark, deckY: -7.2, particles: { emit() {}, enabled: false }, reducedMotion: () => false });
    parent.add(b.group); (spark ? f.mirrors : f.buildings).set(project.id, b);
    f.view.selection = { kind: 'building', id: project.id }; f.view.focusSelection();
    assertFramed(f.world, f.flights.at(-1), b.group); b.dispose();
  }
});

test('focus anticipates rise/growth without changing live scales or including hidden meshes', t => {
  canvas(t); const f = fixture(), project = { id: 'gh:a/b', name: 'Rise', path: 'C:/b', metrics: { floors: 18, footprint: 2 } };
  const b = new Building(project, { i: 3, j: -3 }, { districts: true, animateIn: true, reducedMotion: () => false, particles: { emit() {}, enabled: false } });
  f.land.add(b.group); f.buildings.set(b.id, b); f.view.selection = { kind: 'building', id: b.id };
  const scale = b.tower.scale.clone(); f.view.focusSelection(); close(b.tower.scale, scale);
  b.tower.scale.setScalar(1); b.padGroup.scale.setScalar(1); assertFramed(f.world, f.flights.at(-1), b.group);
  const before = focusBounds(b.group, f.world), hidden = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000), new THREE.MeshBasicMaterial());
  hidden.visible = false; b.group.add(hidden); const after = focusBounds(b.group, f.world);
  close(before.min, after.min); close(before.max, after.max); b.dispose();
});

test('Jump and F focus people at their actual bridge height and retain full IDs', t => {
  canvas(t);
  const f = fixture(), position = new THREE.Vector3(18, 1.7, -8);
  f.view.npcs.position = () => position;
  f.view.agentById = () => null;
  f.view.onJump({ kind: 'agent', id: 'agent:with:colons' }); assert.deepEqual(f.view.selection, { kind: 'agent', id: 'agent:with:colons' });
  close(f.flights.at(-1).target, f.world.toWorld(position.clone().add(new THREE.Vector3(0, 1, 0)), { atRest: true }));
  assert.equal(f.flights.at(-1).options.center, true);
  f.view.visible = true; f.view.keyDown({ code: 'KeyF', preventDefault() {} }); assert.equal(f.flights.length, 2);
});

test('double-click centers both building faces, while open ground and bridges keep walking', () => {
  const f = fixture(); let focused = 0; f.view.focusSelection = () => focused++;
  for (const kind of ['building', 'spark', 'agent', 'boat']) f.view.onDoubleClick({ kind, id: 'same' }, 0, 0);
  assert.equal(focused, 4);
  f.view.sparkOffline = true; f.view.onDoubleClick({ kind: 'spark', id: 'offline' }, 0, 0); assert.equal(focused, 5);
  f.view.onDoubleClick({ kind: 'plot', id: 'empty' }, 0, 0); f.view.onDoubleClick(null, 0, 0); f.view.onDoubleClick({ kind: 'bridge', x: 1, z: 2 }, 0, 0);
  assert.deepEqual(f.walks, [[4, 7], [4, 7], [1, 2]]);
  f.view.street = {}; f.view.onDoubleClick(null, 0, 0); assert.equal(f.walks.length, 3);
});

test('boat label click and repeated Focus resolve the current slot on its actual face', () => {
  const f = fixture(), boat = new THREE.Mesh(new THREE.BoxGeometry(3, 1, 1), new THREE.MeshBasicMaterial());
  boat.position.set(22, -.76, -8); f.land.add(boat); f.boats.set('loop-slot-1', boat);
  f.view.onClick({ kind: 'boat', id: 'loop-slot-1' }); assert.equal(f.flights.length, 1); assert.equal(f.view.facesUp(f.view.selection), true);
  assert.ok(f.flights.at(-1).polar >= .55 && f.flights.at(-1).polar <= .65, 'boat focus looks down into the recessed river beyond quay rails');
  close(f.flights.at(-1).target, boat.getWorldPosition(new THREE.Vector3()));
  const next = boat.clone(); next.position.set(-20, -6.44, 8); f.land.add(next); f.boats.set('loop-slot-1', next); f.view.focusSelection();
  assert.equal(f.world.restSide, 'spark'); assert.equal(f.view.facesUp(f.view.selection), false);
  close(f.flights.at(-1).target, next.getWorldPosition(new THREE.Vector3()));
  f.boats.clear(); assert.equal(f.view.facesUp(f.view.selection), false); f.view.focusSelection(); assert.equal(f.flights.length, 2);
  boat.geometry.dispose(); boat.material.dispose();
});

test('boat picking uses the shared nearest-hit raycast and never pierces island or quay occluders', () => {
  const f = fixture(), label = new THREE.Mesh(); label.userData.boatId = 'loop-slot-1'; const hull = new THREE.Group(); f.boats.set('loop-slot-1', hull);
  Object.assign(f.view.npcs, { pickables: () => [], targetOf: () => null }); f.view.buildings.pickables = () => [];
  const quay = new THREE.Mesh(); quay.userData.occluder = true;
  Object.assign(f.view.spark, { pickables: () => [], occluders: () => [] }); Object.assign(f.view.river, { pickables: () => [], labelPickables: () => [label], occluders: () => [quay] });
  f.world.hq = { pickables: [] }; const slab = new THREE.Mesh(); slab.userData.occluder = true; f.world.occluders = () => [slab]; f.view.plotAt = () => null;
  f.world.raycast = (ndc, objects) => { assert.ok(objects.includes(label) && objects.includes(slab) && objects.includes(quay)); return { object: slab }; };
  assert.equal(f.view.pickAny(0, 0), null);
  f.world.raycast = () => ({ object: quay }); assert.equal(f.view.pickAny(0, 0), null);
  f.world.raycast = () => ({ object: label }); assert.deepEqual(f.view.pickAny(0, 0), { kind: 'boat', id: 'loop-slot-1' });
});

test('moving-boat centering follows only its own flight and ends at landing or interruption', () => {
  const f = fixture(), boat = new THREE.Mesh(new THREE.BoxGeometry(3, 1, 1), new THREE.MeshBasicMaterial());
  f.land.add(boat); f.boats.set('loop-slot-0', boat); f.view.selection = { kind: 'boat', id: 'loop-slot-0' };
  const tween = { t: .5, toTarget: new THREE.Vector3() }; f.world.tween = tween; f.world.centerTarget = true;
  const applied = []; f.world.applyTween = (shot, progress) => applied.push([shot.toTarget.clone(), progress]);
  f.view.boatFocus = { id: 'loop-slot-0', tween }; boat.position.set(20, -.76, -9); f.view.updateBoatFocus();
  close(applied.at(-1)[0], boat.getWorldPosition(new THREE.Vector3()));
  tween.t = 1; f.world.tween = null; boat.position.x += .1; f.view.updateBoatFocus();
  close(applied.at(-1)[0], boat.getWorldPosition(new THREE.Vector3())); assert.equal(f.view.boatFocus, null);
  boat.position.x++; f.view.updateBoatFocus(); assert.equal(applied.length, 2, 'no permanent follow');
  f.view.boatFocus = { id: 'loop-slot-0', tween }; f.world.tween = { t: 0 }; f.view.updateBoatFocus();
  assert.equal(f.view.boatFocus, null); assert.equal(applied.length, 2, 'another camera action wins');
  boat.geometry.dispose(); boat.material.dispose();
});

test('growth fits only when idle at that expansion and explicit focus, talk or street take priority', () => {
  const f = fixture(); let now = 29999, lastMoved = 0, resets = 0;
  f.world.canAutoRefit = () => cameraIdle(now, lastMoved); f.world.resetView = options => { resets++; assert.equal(options.auto, true); };
  f.view.refitForGrowth(true); assert.equal(resets, 0);
  now = 30000; f.view.refitForGrowth(false); assert.equal(resets, 0, 'no deferred reset after skipped growth');
  f.view.refitForGrowth(true); assert.equal(resets, 1);
  for (const field of ['pendingFocus', 'talk', 'street', 'streetPending', 'following']) { f.view[field] = {}; f.view.refitForGrowth(true); assert.equal(resets, 1); f.view[field] = null; }
  f.world.markCameraMoved = () => lastMoved = now; f.world.flip = () => {}; f.view.flipSide();
  now++; f.view.refitForGrowth(true); assert.equal(resets, 1, 'an explicit flip protects its camera from growth');
});

test('street and talk restore an exact centered boat pose through real controls updates', () => {
  const world = Object.create(World.prototype), view = Object.create(CityView.prototype);
  Object.assign(world, { half: 93.5, camera: new THREE.PerspectiveCamera(40, 1.6, .25, 10000), rest: new THREE.Quaternion(), pivot: new THREE.Group(),
    _pv: new THREE.Vector3(), _qa: new THREE.Quaternion(), _qr: new THREE.Quaternion(), _qi: new THREE.Quaternion(), reducedMotion: () => false,
    pitchBias: 0, eyeRaise: 0, keys: new Set(), turn: null, raf: 1 });
  world.camera.position.set(0, 30, 50); world.controls = new OrbitControls(world.camera); world.controls.minDistance = 3; world.limits();
  Object.assign(view, { world, npcs: {}, streetKeys: new Set(), renderToolbarState() {}, refreshPanel() {}, releaseTalk() {}, talkPanel: { close() {} }, cityRoot: { classList: { remove() {} } }, talkBubbles: {} });
  const target = new THREE.Vector3(20, -.76, -8);
  for (const underside of [false, true]) for (const polar of [1, .62]) for (const mode of ['street', 'talk']) {
    world.underside = underside;
    world.flyTo({ target, distance: 10, polar }, { instant: true, center: true });
    const pose = view.cameraPose(); assert.equal(pose.center, true);
    for (let n = 0; n < 120; n++) { world.updatePitch(1 / 60); world.controls.update(); }
    close(world.controls.target, pose.target); close(world.camera.position, pose.position);
    world.flyTo({ target: new THREE.Vector3(1, 2, 3), distance: 20, polar: .8 }, { instant: true });
    if (mode === 'street') { view.street = {}; view.streetReturn = pose; view.exitStreet({ instant: true }); }
    else { view.talk = { back: pose }; view.exitTalk({ instant: true }); }
    for (let n = 0; n < 120; n++) { world.updatePitch(1 / 60); world.controls.update(); }
    close(world.controls.target, pose.target); close(world.camera.position, pose.position); assert.equal(world.centerTarget, true);
    if (polar === .62) {
      world.markCameraMoved();
      for (let n = 0; n < 120; n++) { world.updatePitch(1 / 60); world.controls.update(); }
      assert.equal(world.centerTarget, false);
      assert.ok(world.camera.position.distanceTo(pose.position) > .01, 'owner input releases the explicit angle to normal pitch limits');
    }
  }
});
