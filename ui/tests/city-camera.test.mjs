import assert from 'node:assert/strict';
import test from 'node:test';
import { fitIslandDistance, cameraZoomLimit, panLimit, clampPanTarget, OVERVIEW_POLAR, OVERVIEW_AZIMUTH } from '../app/city/camera.js';
import { islandHalf } from '../app/city/layout.js';
import { THREE } from '../app/city/toon.js';
import { World, PIVOT_Y } from '../app/city/world.js';

test('a top-down square fits its narrower viewport dimension with 10% margin', () => {
  const half = 30, fov = 60;
  const expected = half * 1.1 / Math.tan(Math.PI / 6);
  assert.ok(Math.abs(fitIslandDistance(half, fov, 1, { polar: 0, azimuth: 0 }) - expected) < 1e-9);
  assert.ok(Math.abs(fitIslandDistance(half, fov, 0.5, { polar: 0, azimuth: 0 }) - expected * 2) < 1e-9);
});

test('overview fits all slab and building-height corners across island sizes and viewport shapes', () => {
  for (const rings of [1, 2, 6, 24]) for (const aspect of [0.4, 0.75, 1, 1.6, 3]) for (const fov of [30, 40, 65]) {
    const half = islandHalf(rings), opts = { minY: -13, maxY: 40 };
    const distance = fitIslandDistance(half, fov, aspect, opts);
    const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, distance * 4);
    camera.position.setFromSpherical(new THREE.Spherical(distance, OVERVIEW_POLAR, OVERVIEW_AZIMUTH));
    camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    let edge = 0;
    for (const x of [-half, half]) for (const z of [-half, half]) for (const y of [-13, 40]) {
      const p = new THREE.Vector3(x, y, z).project(camera);
      assert.ok(Math.abs(p.x) <= 1 / 1.1 + 1e-10 && Math.abs(p.y) <= 1 / 1.1 + 1e-10, `rings ${rings}, aspect ${aspect}, fov ${fov}`);
      assert.ok(p.z > -1 && p.z < 1, 'corner is in front of the camera');
      edge = Math.max(edge, Math.abs(p.x), Math.abs(p.y));
    }
    assert.ok(Math.abs(edge - 1 / 1.1) < 1e-9, 'fit is tight to the reserved margin');
  }
});

test('a flipped and yawed Spark footprint still fits the same overview bounds', () => {
  const half = islandHalf(5), aspect = 0.65, fov = 40, yaw = 1.3;
  const distance = fitIslandDistance(half, fov, aspect, { minY: -13, maxY: 40 });
  const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, distance * 4);
  camera.position.setFromSpherical(new THREE.Spherical(distance, OVERVIEW_POLAR, OVERVIEW_AZIMUTH + yaw));
  camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
  for (const x of [-half, half]) for (const z of [-half, half]) for (const y of [13, -40]) {
    const p = new THREE.Vector3(x, y, z).applyQuaternion(turn).project(camera);
    assert.ok(Math.abs(p.x) <= 1 / 1.1 + 1e-10 && Math.abs(p.y) <= 1 / 1.1 + 1e-10);
  }
});

test('fit and zoom limits scale without a fixed-distance ceiling', () => {
  const fit = fitIslandDistance(30, 40, 1.6);
  assert.ok(Math.abs(fitIslandDistance(120, 40, 1.6) / fit - 4) < 1e-9);
  for (const half of [20, 50, 100, 400]) {
    const d = fitIslandDistance(half, 40, 0.65), max = cameraZoomLimit(d);
    assert.ok(max >= d * 1.3);
    assert.equal(max, d * 1.5);
  }
  assert.ok(cameraZoomLimit(fitIslandDistance(400, 40, 1)) > 190);
});

test('pan bounds include every corner lot and use a margin proportional to the island', () => {
  for (const half of [30, 80, 200]) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const corner = { x: sx * half, y: 12, z: sz * half };
      assert.deepEqual(clampPanTarget(corner, half), corner);
    }
    assert.deepEqual(clampPanTarget({ x: half * 3, y: 7, z: -half * 3 }, half), { x: panLimit(half), y: 7, z: -panLimit(half) });
  }
  assert.equal(panLimit(120), panLimit(30) * 4);
});

test('pan clamp preserves height and can reuse its input without allocation', () => {
  const target = { x: 100, y: -9, z: 12 };
  assert.equal(clampPanTarget(target, 30, target), target);
  assert.deepEqual(target, { x: panLimit(30), y: -9, z: 12 });
});

test('invalid frustum inputs fail explicitly', () => {
  for (const args of [[0, 40, 1], [30, 0, 1], [30, 40, 0], [30, 40, NaN], [Infinity, 40, 1]]) {
    assert.throws(() => fitIslandDistance(...args), RangeError);
  }
});

test('World movement recency expires without keeping auto-fit disabled forever', () => {
  const world = Object.create(World.prototype);
  world.lastUserMoveAt = -Infinity;
  assert.equal(world.recentlyMoved(), false);
  world.markUserMoved();
  assert.equal(world.userMoved, true);
  assert.equal(world.recentlyMoved(), true);
  world.lastUserMoveAt = performance.now() - 29900;
  assert.equal(world.recentlyMoved(), true);
  world.lastUserMoveAt = performance.now() - 30100;
  assert.equal(world.recentlyMoved(), false);
});

test('focus queued during a flip immediately protects the owner choice from expansion', () => {
  const world = Object.create(World.prototype);
  world.turn = { mode: 'flip' };
  world.lastUserMoveAt = -Infinity;
  const view = { target: new THREE.Vector3(20, 1, 20) };
  world.flyAfterTurn(view);
  assert.equal(world.recentlyMoved(), true);
  assert.equal(world.pendingFlight[0], view);
  world.lastUserMoveAt = -Infinity;
  world.flyAfterTurn(view, { auto: true });
  assert.equal(world.recentlyMoved(), false);
});

function focusWorld(rest = new THREE.Quaternion()) {
  const world = Object.create(World.prototype);
  world.controls = { target: new THREE.Vector3(), minDistance: 3, maxDistance: 1000 };
  world.camera = new THREE.PerspectiveCamera(40, 1.6, .25, 3000);
  world.camera.position.set(40, 70, 60);
  world.rest = rest.clone();
  world.pivot = { quaternion: rest.clone() };
  world._pv = new THREE.Vector3();
  world._qa = new THREE.Quaternion(); world._qr = new THREE.Quaternion();
  world.reducedMotion = () => false;
  world.lastUserMoveAt = -Infinity;
  return world;
}

function pointAfterTurn(point, rotation) {
  const matrix = new THREE.Matrix4().makeTranslation(0, PIVOT_Y, 0)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(rotation))
    .multiply(new THREE.Matrix4().makeTranslation(0, -PIVOT_Y, 0));
  return new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(matrix);
}

function assertFocusLanding(world, expected, distance) {
  assert.ok(world.tween, 'focus starts an animated flight');
  world.applyTween(world.tween, 1);
  world.endTween(world.tween);
  assert.ok(world.controls.target.distanceTo(expected) < 1e-9);
  assert.ok(Math.abs(world.camera.position.distanceTo(expected) - distance) < 1e-9);
  world.camera.updateMatrixWorld();
  const projected = expected.clone().project(world.camera);
  assert.ok(Math.abs(projected.x) < 1e-9 && Math.abs(projected.y) < 1e-9, 'requested point lands at screen center');
}

test('focusPoint centers island-space positions on yawed PC and Spark faces at default or requested distance', () => {
  for (const flipped of [false, true]) for (const distance of [18, 42]) {
    const rest = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .8);
    if (flipped) rest.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
    const world = focusWorld(rest), point = { x: 64, y: flipped ? -12 : 2, z: -48 };
    const before = { ...point }, expected = pointAfterTurn(point, rest);
    const accepted = distance === 18 ? world.focusPoint(point) : world.focusPoint(point, { distance });
    assert.equal(accepted, true);
    assert.equal(world.recentlyMoved(), true);
    assert.deepEqual(point, before, 'caller coordinates are not mutated');
    assertFocusLanding(world, expected, distance);
  }
});

test('focusPoint during a flip queues the resting-face position and protects the owner choice immediately', () => {
  const world = focusWorld(), axis = new THREE.Vector3(1, 0, 0);
  world.turn = { mode: 'flip', axis, angle: Math.PI / 3, target: Math.PI };
  world.pivot.quaternion.setFromAxisAngle(axis, world.turn.angle);
  const point = { x: 24, y: -12, z: 32 };
  const finalRotation = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI);
  const expected = pointAfterTurn(point, finalRotation), before = world.controls.target.clone();
  assert.equal(world.focusPoint(point, { distance: 27 }), true);
  assert.equal(world.recentlyMoved(), true);
  assert.equal(world.tween, undefined, 'camera waits until the flip finishes');
  assert.ok(world.controls.target.distanceTo(before) < 1e-9);
  const [view, options] = world.pendingFlight;
  assert.ok(view.target.distanceTo(expected) < 1e-9, 'queued target uses final orientation, not the current tilt');
  world.turn = null; world.rest.copy(finalRotation); world.pivot.quaternion.copy(finalRotation);
  world.flyTo(view, options);
  assertFocusLanding(world, expected, 27);
});

test('World focus lands at the free viewport center and restores full projection for scripted modes', () => {
  const world = focusWorld();
  world.size = { w: 1600, h: 1000 };
  world.framingRect = { left: 0, top: 120, width: 1180, height: 800 };
  world.updateProjectionFrame();
  const point = { x: 24, y: 2, z: -32 };
  world.focusPoint(point, { distance: 42 });
  world.applyTween(world.tween, 1); world.endTween(world.tween);
  world.camera.updateMatrixWorld();
  const screen = () => new THREE.Vector3(point.x, point.y, point.z).project(world.camera);
  let projected = screen();
  assert.ok(Math.abs((projected.x + 1) * 800 - 590) < 1e-9);
  assert.ok(Math.abs((1 - projected.y) * 500 - 520) < 1e-9);
  for (const mode of ['street', 'shot']) {
    world[mode] = {};
    world.updateProjectionFrame();
    projected = screen();
    assert.ok(Math.abs(projected.x) < 1e-9 && Math.abs(projected.y) < 1e-9);
    world[mode] = null;
    world.updateProjectionFrame();
    assert.ok(Math.abs((screen().x + 1) * 800 - 590) < 1e-9);
  }
  world.framingEnabled = false; world.updateProjectionFrame();
  assert.ok(Math.abs(screen().x) < 1e-9);
  world.framingEnabled = true; world.updateProjectionFrame();
  assert.ok(Math.abs((screen().x + 1) * 800 - 590) < 1e-9);
});

test('flipping and settling refresh zoom limits for the destination face without a viewport resize', () => {
  const world = focusWorld();
  world.underside = true; world.half = 60;
  world.makeRoom = () => {};
  world.boundsPoints = () => {
    const top = world.restSide === 'spark' ? 140 : 12, points = [];
    for (const x of [-60, 60]) for (const z of [-60, 60]) for (const y of [0, top]) points.push(new THREE.Vector3(x, y, z));
    return points;
  };
  world.limits();
  const pcLimit = world.controls.maxDistance;
  world.flip();
  assert.equal(world.restSide, 'spark');
  assert.ok(world.controls.maxDistance > pcLimit);
  assert.ok(Math.abs(world.controls.maxDistance / world.fitDistance() - 1.5) < 1e-9);
  world.commitTurn();
  assert.ok(Math.abs(world.controls.maxDistance / world.fitDistance() - 1.5) < 1e-9);
  world.settleNow('pc');
  assert.ok(Math.abs(world.controls.maxDistance / world.fitDistance() - 1.5) < 1e-9);
});

test('focusPoint refuses invalid coordinates, distances and modes without replacing camera work', () => {
  const cases = [
    [null], [undefined], [{}], [{ x: 1, y: 2 }], [{ x: NaN, y: 2, z: 3 }],
    [{ x: 1, y: Infinity, z: 3 }], [{ x: 1, y: 2, z: '3' }],
    ...[0, -1, NaN, Infinity].map(distance => [{ x: 1, y: 2, z: 3 }, { distance }]),
  ];
  for (const args of cases) {
    const world = focusWorld(), existing = { id: 'existing-flight' };
    world.pendingFlight = existing;
    assert.equal(world.focusPoint(...args), false);
    assert.equal(world.pendingFlight, existing);
    assert.equal(world.recentlyMoved(), false);
  }
  for (const mode of ['street', 'shot', 'follow']) {
    const world = focusWorld(), existing = { id: 'existing-flight' };
    world[mode] = () => {};
    world.pendingFlight = existing;
    assert.equal(world.focusPoint({ x: 1, y: 2, z: 3 }), false);
    assert.equal(world.pendingFlight, existing);
    assert.equal(world.recentlyMoved(), false);
  }
});

test('World clamps in island space and preserves the camera offset on either face', () => {
  for (const flipped of [false, true]) {
    const world = Object.create(World.prototype);
    world.half = 60;
    world.pivot = { quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.2) };
    if (flipped) world.pivot.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
    world._pv = new THREE.Vector3(); world._qi = new THREE.Quaternion();
    const target = world.toWorld(new THREE.Vector3(180, PIVOT_Y + 2, -180));
    const offset = new THREE.Vector3(10, 20, 30);
    world.controls = { target };
    world.camera = { position: target.clone().add(offset) };
    world.clampPan();
    const local = world.toLocal(world.controls.target);
    assert.ok(Math.abs(local.x - panLimit(60)) < 1e-9 && Math.abs(local.z + panLimit(60)) < 1e-9);
    assert.ok(world.camera.position.clone().sub(world.controls.target).distanceTo(offset) < 1e-9);
    assert.ok(Math.abs(local.y - (PIVOT_Y + 2)) < 1e-9);
  }
});
