import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { OrbitControls } from '../vendor/three/addons/OrbitControls.js';
import { World } from '../app/city/world.js';
import { cameraBounds, clampPanTarget, panLimit } from '../app/city/camera.js';
import { islandHalf } from '../app/city/layout.js';

function fixture(t, half) {
  const root = new EventTarget(), canvas = new EventTarget();
  Object.assign(canvas, { style: {}, clientWidth: 1200, clientHeight: 800, getRootNode: () => root,
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false,
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 1200, height: 800 }) });
  const camera = new THREE.PerspectiveCamera(40, 1.5, .25, 3000);
  camera.position.set(45, 55, 65); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const world = Object.assign(Object.create(World.prototype), { half, rings: undefined, camera, pivot: new THREE.Group(), rest: new THREE.Quaternion(),
    _pv: new THREE.Vector3(), _qa: new THREE.Quaternion(), _qr: new THREE.Quaternion(), _qi: new THREE.Quaternion(),
    reducedMotion: () => false, keys: new Set(), renderer: { domElement: canvas }, underside: true, pitchBias: 0, eyeRaise: 0 });
  world.controls = new OrbitControls(camera, canvas); world.controls.screenSpacePanning = false;
  world.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  world.bindCameraActivity(); world.bindTilt(); world.limits();
  const pointer = (type, values = {}) => {
    const event = new Event(type, { cancelable: true }); Object.assign(event, { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: 200, clientY: 200, pageX: 200, pageY: 200, ...values });
    canvas.dispatchEvent(event);
  };
  t.after(() => world.controls.dispose());
  return { world, pointer };
}

test('unknown or invalid island dimensions retain finite usable bounds before layout', t => {
  for (const half of [undefined, null, NaN, 0, -1, Infinity, -Infinity]) {
    const limit = panLimit(half), bounds = cameraBounds(half, NaN, Infinity);
    assert.equal(limit, islandHalf(1) * 1.12); assert.ok(Object.values(bounds).every(Number.isFinite));
    assert.deepEqual(clampPanTarget({ x: 8, y: 2, z: -6 }, half), { x: 8, y: 2, z: -6 });
    const { world } = fixture(t, half);
    assert.ok(world.overviewPoints().every(p => p.toArray().every(Number.isFinite)));
    world.panBy(3, 2); assert.ok(world.controls.target.length() > 3);
    world.panBy(1e5, 1e5); assert.ok(Math.abs(world.controls.target.x) <= limit + 1e-8 && Math.abs(world.controls.target.z) <= limit + 1e-8);
    assert.ok(world.camera.position.toArray().every(Number.isFinite));
  }
});

test('right drag and modified left drag pan before layout without triggering island tilt', t => {
  for (const modifiers of [{ button: 2 }, { button: 0, shiftKey: true }, { button: 0, ctrlKey: true }, { button: 0, metaKey: true }]) {
    const { world, pointer } = fixture(t, undefined), before = world.camera.position.clone();
    pointer('pointerdown', modifiers); pointer('pointermove', { ...modifiers, clientX: 270, clientY: 230, pageX: 270, pageY: 230 });
    pointer('pointerup', modifiers); world.clampPan();
    assert.ok(world.controls.target.length() > 1, 'gesture translates orbit target');
    assert.ok(world.camera.position.distanceTo(before) > 1); assert.ok(!world.turn);
    assert.equal(world.controlsActive, false); assert.equal(world.recentlyMoved(), true);
  }
});

test('two-finger pan and keyboard movement work before project geometry exists', t => {
  const { world, pointer } = fixture(t, 0);
  pointer('pointerdown', { pointerType: 'touch', pointerId: 1 });
  pointer('pointerdown', { pointerType: 'touch', pointerId: 2, isPrimary: false, clientX: 300, pageX: 300 });
  pointer('pointermove', { pointerType: 'touch', pointerId: 1, clientX: 240, pageX: 240 });
  pointer('pointermove', { pointerType: 'touch', pointerId: 2, isPrimary: false, clientX: 340, pageX: 340 });
  pointer('pointerup', { pointerType: 'touch', pointerId: 1 }); pointer('pointerup', { pointerType: 'touch', pointerId: 2, isPrimary: false });
  world.clampPan(); assert.ok(world.controls.target.length() > 1); assert.ok(!world.turn);
  const before = world.controls.target.clone(); world.keyDown('KeyW'); world.applyKeys(.05); world.keyUp('KeyW');
  assert.ok(world.controls.target.distanceTo(before) > 1); assert.equal(world.recentlyMoved(), true);
});

test('explicit Pan mode maps plain drag and one finger to pan and restores normal controls', t => {
  for (const pointerType of ['mouse', 'touch']) {
    const { world, pointer } = fixture(t, undefined);
    world.pendingFlight = {}; world.tween = {}; world.controls._panOffset.set(3, 0, 4);
    assert.equal(world.setPanMode(true), true); assert.equal(world.setPanMode(true), false);
    assert.equal(world.pendingFlight, null); assert.equal(world.tween, null); assert.equal(world.controls._panOffset.length(), 0);
    pointer('pointerdown', { pointerType });
    pointer('pointermove', { pointerType, clientX: 205, pageX: 205, clientY: 270, pageY: 270 });
    pointer('pointerup', { pointerType }); world.clampPan();
    assert.ok(world.controls.target.length() > 1); assert.ok(!world.turn, 'vertical pan must not flip the island');
    assert.equal(world.controls.mouseButtons.RIGHT, THREE.MOUSE.PAN);
    assert.equal(world.controls.touches.TWO, THREE.TOUCH.DOLLY_PAN);
    assert.equal(world.setPanMode(false), true);
    assert.equal(world.controls.mouseButtons.LEFT, THREE.MOUSE.ROTATE); assert.equal(world.controls.touches.ONE, THREE.TOUCH.ROTATE);
  }
});
