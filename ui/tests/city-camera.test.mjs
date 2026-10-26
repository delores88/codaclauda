import assert from 'node:assert/strict';
import test from 'node:test';
import { THREE } from '../app/city/toon.js';
import { OrbitControls } from '../vendor/three/addons/OrbitControls.js';
import { World, PIVOT_Y, TILT_POLAR } from '../app/city/world.js';
import { islandFitDistance, boxFitDistance, cameraBounds, clampCameraTarget, cameraIdle } from '../app/city/camera-math.js';
import { islandHalf } from '../app/city/layout.js';

function cameraAt(distance, aspect, polar = .82, azimuth = .62, far = 10000) {
  const camera = new THREE.PerspectiveCamera(40, aspect, .25, far);
  camera.position.setFromSpherical(new THREE.Spherical(distance, polar, azimuth));
  camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true); return camera;
}
const near = (a, b, message = '') => assert.ok(Math.abs(a - b) < 1e-7, `${message}: ${a} != ${b}`);
function framed(camera, points, margin = .1) {
  let fullest = 0;
  for (const point of points) {
    const p = point.clone().project(camera);
    assert.ok(Math.abs(p.x) <= 1 / (1 + margin) + 1e-7 && Math.abs(p.y) <= 1 / (1 + margin) + 1e-7, `clipped corner ${p.toArray()}`);
    assert.ok(p.z > -1 && p.z < 1, 'corner lies between clipping planes');
    fullest = Math.max(fullest, Math.abs(p.x), Math.abs(p.y));
  }
  return fullest;
}
function volume(half, minY = -8, maxY = 40) {
  return [-half, half].flatMap(x => [minY, maxY].flatMap(y => [-half, half].map(z => new THREE.Vector3(x, y, z))));
}
function worldCamera(half = 93.5, aspect = 16 / 9) {
  const world = Object.create(World.prototype);
  Object.assign(world, { half, camera: cameraAt(80, aspect), rest: new THREE.Quaternion(), pivot: new THREE.Group(),
    _pv: new THREE.Vector3(), _qa: new THREE.Quaternion(), _qr: new THREE.Quaternion(), _qi: new THREE.Quaternion(),
    reducedMotion: () => false, pitchBias: 0, eyeRaise: 0, keys: new Set(), turn: null, raf: 1 });
  world.controls = new OrbitControls(world.camera); world.controls.minDistance = 3; world.limits();
  world.bindCameraActivity();
  return world;
}

test('overview fits every island corner including height, depth and river rim in wide and portrait views', () => {
  for (const rings of [1, 3, 6, 12, 24]) for (const aspect of [2.2, 16 / 9, 1, 320 / 900, .2]) {
    const half = islandHalf(rings), fit = islandFitDistance({ half, aspect }), bounds = cameraBounds(half, fit);
    const fullness = framed(cameraAt(fit, aspect, .82, .62, bounds.far), volume(half + 4));
    near(fullness, 1 / 1.1, 'fit is tight at the requested projected margin');
    assert.ok(bounds.maxDistance >= fit * 1.3); assert.ok(bounds.far > bounds.maxDistance);
  }
  assert.ok(islandFitDistance({ half: islandHalf(24), aspect: .2 }) > 3000);
});

test('selected-object fits preserve tall and wide model bounds without using a spherical approximation', () => {
  for (const size of [{ x: 4, y: 45, z: 8 }, { x: 20, y: 4, z: 17 }, { x: 1, y: 2, z: 1 }]) {
    for (const aspect of [.4, 1.8]) for (const polar of [.5, 1.1]) {
      const options = { aspect, polar, azimuth: -.3, margin: .2 }, fit = boxFitDistance(size, options);
      const points = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => new THREE.Vector3(x * size.x / 2, y * size.y / 2, z * size.z / 2))));
      framed(cameraAt(fit, aspect, polar, -.3), points, .2);
    }
  }
});

test('square pan bounds preserve every corner and clamp each axis independently without mutation', () => {
  const bounds = cameraBounds(93.5, 300), target = { x: 93.5, y: 2.6, z: 93.5 };
  assert.deepEqual(clampCameraTarget(target, bounds.pan), target);
  assert.deepEqual(clampCameraTarget({ x: bounds.pan + 20, y: -2, z: 12 }, bounds.pan), { x: bounds.pan, y: -2, z: 12 });
  assert.deepEqual(target, { x: 93.5, y: 2.6, z: 93.5 });
  assert.ok(cameraBounds(397.5, 1800).pan > bounds.pan);
});

test('automatic fitting resumes after thirty seconds and tolerates absent or reversed timestamps', () => {
  assert.equal(cameraIdle(0, undefined), true); assert.equal(cameraIdle(0, null), true);
  assert.equal(cameraIdle(29999, 0), false); assert.equal(cameraIdle(30000, 0), true);
  assert.equal(cameraIdle(59999, 30000), false); assert.equal(cameraIdle(100, 101), false);
  const world = worldCamera(); world.markCameraMoved(2000);
  assert.equal(world.canAutoRefit(31999), false); assert.equal(world.canAutoRefit(32000), true);
  for (const field of ['street', 'shot', 'controlsActive', 'pendingFlight']) { world[field] = true; assert.equal(world.canAutoRefit(32000), false); world[field] = null; }
});

test('real orbit controls retain fitted distances and corner targets on either yawed face', () => {
  for (const spark of [false, true]) {
    const world = worldCamera(islandHalf(24), 320 / 900), yaw = 1.2;
    world.rest.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    if (spark) world.rest.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
    world.pivot.quaternion.copy(world.rest); world.underside = spark;
    world.resetView({ instant: true, auto: true }); world.updatePitch(1); world.controls.update();
    near(world.distance, world.fitDistance()); near(world.polar, TILT_POLAR);
    const corners = volume(world.half + 4).map(p => p.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
    world.camera.updateMatrixWorld(true); framed(world.camera, corners);
    for (const x of [-world.half, world.half]) for (const z of [-world.half, world.half]) {
      const target = world.toWorld(new THREE.Vector3(x, .2, z));
      world.flyTo({ target, distance: 12 }, { instant: true, center: true });
      world.updatePitch(1); world.controls.update(); world.clampTarget();
      assert.ok(world.controls.target.distanceTo(target) < 1e-7, 'corner selection survives controls.update');
    }
    const overflow = world.toWorld(new THREE.Vector3(world.panLimit + 20, .2, world.half));
    const offset = world.camera.position.clone().sub(world.controls.target);
    world.controls.target.copy(overflow); world.camera.position.copy(overflow).add(offset); world.clampTarget();
    const bounded = world.toLocal(world.controls.target);
    near(bounded.x, world.panLimit); near(bounded.z, world.half);
    assert.ok(world.camera.position.clone().sub(world.controls.target).distanceTo(offset) < 1e-7);
  }
});

test('centered and free flights keep low object anchors after settling; ordinary close views keep eye lift', () => {
  const world = worldCamera(), target = new THREE.Vector3(10, .25, 14);
  for (const opts of [{ center: true }, { free: true }]) {
    world.flyTo({ target, distance: 3, polar: 1.3 }, { ...opts, instant: true });
    for (let n = 0; n < 120; n++) { world.updatePitch(1 / 60); world.controls.update(); world.clampTarget(); }
    assert.ok(world.controls.target.distanceTo(target) < 1e-7); near(world.eyeRaise, 0);
  }
  world.flyTo({ target, distance: 3 }, { instant: true }); world.updatePitch(1);
  assert.ok(world.controls.target.y > target.y + 1); assert.ok(world.eyeRaise > 1);
});

test('resize fits a current overview to portrait while retaining manual, street and talk cameras', () => {
  const world = worldCamera();
  Object.assign(world, { container: { clientWidth: 320, clientHeight: 900 }, renderer: { setSize() {}, getPixelRatio: () => 1 }, particles: { setViewport() {} } });
  world.resetView({ instant: true, auto: true }); world.resize(); near(world.distance, world.fitDistance());
  for (const mode of ['manual', 'street', 'shot']) {
    world.camera.position.set(40, 30, 50); world.controls.target.set(4, 3, 5);
    world.markCameraMoved(0); if (mode !== 'manual') world[mode] = true;
    const camera = world.camera.position.clone(), target = world.controls.target.clone();
    world.resize(); assert.deepEqual(world.camera.position, camera); assert.deepEqual(world.controls.target, target);
    if (mode !== 'manual') world[mode] = null;
  }
});

test('portrait-to-landscape resize preserves a manual camera through the next real controls update', () => {
  const world = worldCamera(islandHalf(24), .2);
  Object.assign(world, { container: { clientWidth: 1600, clientHeight: 900 }, renderer: { setSize() {}, getPixelRatio: () => 1 }, particles: { setViewport() {} } });
  world.resetView({ instant: true, auto: true }); world.markCameraMoved();
  const camera = world.camera.position.clone(), target = world.controls.target.clone(), distance = world.distance;
  assert.ok(distance > 3000);
  world.resize(); world.updatePitch(1 / 60); world.controls.update(); world.clampTarget();
  assert.ok(world.camera.position.distanceTo(camera) < 1e-7); assert.ok(world.controls.target.distanceTo(target) < 1e-7);
  near(world.distance, distance); assert.ok(world.controls.maxDistance >= distance); assert.ok(world.camera.far > distance + world.half);
  world.resetView({ instant: true, auto: true });
  assert.ok(world.distance < distance / 2, 'explicit reset may adopt the smaller landscape fit');
});

test('a recently requested Home overview continues fitting when resized in either direction', () => {
  const world = worldCamera(islandHalf(24), .2);
  Object.assign(world, { container: { clientWidth: 1600, clientHeight: 900 }, renderer: { setSize() {}, getPixelRatio: () => 1 }, particles: { setViewport() {} } });
  world.resetView({ instant: true });
  assert.equal(world.canAutoRefit(), false, 'Home still counts as recent movement for expansion');
  for (const [width, height] of [[1600, 900], [320, 900]]) {
    world.container.clientWidth = width; world.container.clientHeight = height;
    world.resize(); world.updatePitch(1 / 60); world.controls.update();
    near(world.distance, world.fitDistance()); world.camera.updateMatrixWorld(true);
    framed(world.camera, volume(world.half + 4));
  }
});

test('pointerup selection survives the following controls end event while real drag still releases focus', () => {
  const world = worldCamera(), target = new THREE.Vector3(12, .3, 10);
  world.controls.dispatchEvent({ type: 'start' });
  world.flyTo({ target, distance: 3 }, { instant: true, center: true });
  world.controls.dispatchEvent({ type: 'end' });
  for (let n = 0; n < 120; n++) { world.updatePitch(1 / 60); world.controls.update(); }
  assert.equal(world.centerTarget, true); assert.ok(world.controls.target.distanceTo(target) < 1e-7);
  assert.equal(world.canAutoRefit(), false, 'selection and gesture end record recent activity');
  world.controls.dispatchEvent({ type: 'start' }); world.controls._sphericalDelta.theta = .1;
  world.controls.update(); world.controls.dispatchEvent({ type: 'end' });
  assert.equal(world.centerTarget, false); assert.equal(world.controlsActive, false);
});

test('temporary street and talk views retain room to restore a saved portrait camera after resize', () => {
  for (const mode of ['street', 'shot']) {
    const world = worldCamera(islandHalf(24), .2);
    Object.assign(world, { container: { clientWidth: 1600, clientHeight: 900 }, renderer: { setSize() {}, getPixelRatio: () => 1 }, particles: { setViewport() {} } });
    world.resetView({ instant: true, auto: true });
    const eye = world.camera.position.clone(), target = world.controls.target.clone();
    const saved = new THREE.Spherical().setFromVector3(eye.clone().sub(target));
    world[mode] = true; world.flyTo({ target: new THREE.Vector3(12, 1, 8), distance: 6 }, { free: true, instant: true });
    world.resize(); assert.ok(world.controls.maxDistance >= saved.radius); assert.ok(world.camera.far > saved.radius + world.half);
    world[mode] = null; world.flyTo({ target, distance: saved.radius, polar: saved.phi, azimuth: saved.theta }, { center: true, instant: true });
    world.updatePitch(1 / 60); world.controls.update();
    assert.ok(world.camera.position.distanceTo(eye) < 1e-7); assert.ok(world.controls.target.distanceTo(target) < 1e-7);
  }
});
