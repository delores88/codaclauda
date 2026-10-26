import assert from 'node:assert/strict';
import test from 'node:test';
import { fitCameraBox, fitCameraPoints, largestFreeRect, buildingFocusDistance, OVERVIEW_POLAR, OVERVIEW_AZIMUTH } from '../app/city/camera.js';
import { THREE } from '../app/city/toon.js';

const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const area = r => r.width * r.height;
const box = (left, top, right, bottom) => ({ left, top, right, bottom });

test('tight camera box fit independently projects every corner inside the seven-percent margin', () => {
  for (const half of [29.5, 61.5, 93.5, 397.5]) for (const aspect of [.4, .75, 1.4, 2.4]) for (const fov of [25, 40, 65]) {
    const fit = fitCameraBox(half, fov, aspect);
    const camera = new THREE.PerspectiveCamera(fov, aspect, .1, fit.distance * 5);
    const offset = new THREE.Vector3().setFromSpherical(new THREE.Spherical(fit.distance, OVERVIEW_POLAR, OVERVIEW_AZIMUTH));
    camera.position.copy(offset); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const target = right.multiplyScalar(fit.offsetX).add(up.multiplyScalar(fit.offsetY));
    camera.position.add(target); camera.lookAt(target); camera.updateMatrixWorld();
    const projected = [];
    for (const x of [-half, half]) for (const z of [-half, half]) for (const y of [-13, 40]) {
      const point = new THREE.Vector3(x, y, z).project(camera);
      assert.ok(Math.abs(point.x) <= 1 / 1.07 + 1e-9 && Math.abs(point.y) <= 1 / 1.07 + 1e-9);
      assert.ok(point.z > -1 && point.z < 1);
      projected.push(point);
    }
    const spans = ['x', 'y'].map(axis => {
      const values = projected.map(p => p[axis]);
      return Math.max(...values) - Math.min(...values);
    });
    assert.ok(spans.some(span => Math.abs(span - 2 / 1.07) < 1e-8), 'one dimension fills both opposite margins');
  }
});

test('an off-center visible rectangle fits and centers correctly with a full-canvas projection', () => {
  const canvas = { width: 1524, height: 944 }, rect = { left: 14, top: 130, right: 1130, bottom: 850 };
  const width = rect.right - rect.left, height = rect.bottom - rect.top, fov = 40;
  const effectiveFov = Math.atan(Math.tan(fov * Math.PI / 360) * height / canvas.height) * 360 / Math.PI;
  const fit = fitCameraBox(93.5, effectiveFov, width / height);
  const camera = new THREE.PerspectiveCamera(fov, canvas.width / canvas.height, .1, 3000);
  camera.setViewOffset(canvas.width, canvas.height, canvas.width / 2 - (rect.left + rect.right) / 2, canvas.height / 2 - (rect.top + rect.bottom) / 2, canvas.width, canvas.height);
  camera.position.setFromSpherical(new THREE.Spherical(fit.distance, OVERVIEW_POLAR, OVERVIEW_AZIMUTH));
  camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const target = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(fit.offsetX)
    .add(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(fit.offsetY));
  camera.position.add(target); camera.lookAt(target); camera.updateMatrixWorld();
  const center = target.clone().project(camera);
  assert.ok(Math.abs((center.x + 1) * canvas.width / 2 - (rect.left + rect.right) / 2) < 1e-8);
  assert.ok(Math.abs((1 - center.y) * canvas.height / 2 - (rect.top + rect.bottom) / 2) < 1e-8);
  for (const x of [-93.5, 93.5]) for (const z of [-93.5, 93.5]) for (const y of [-13, 40]) {
    const projected = new THREE.Vector3(x, y, z).project(camera);
    const px = (projected.x + 1) * canvas.width / 2, py = (1 - projected.y) * canvas.height / 2;
    assert.ok(px > rect.left && px < rect.right && py > rect.top && py < rect.bottom);
  }
});

test('tight fit validates inputs and scales the full box without a distance ceiling', () => {
  const small = fitCameraBox(30, 40, 1.6, { minY: -5, maxY: 10 });
  const large = fitCameraBox(120, 40, 1.6, { minY: -20, maxY: 40 });
  for (const field of ['distance', 'offsetX', 'offsetY']) assert.ok(Math.abs(large[field] - small[field] * 4) < 1e-9);
  for (const args of [[0, 40, 1], [30, 180, 1], [30, 40, 0], [30, 40, NaN], [30, 40, 1, { minY: 3, maxY: 2 }], [30, 40, 1, { margin: .5 }]]) {
    assert.throws(() => fitCameraBox(...args), RangeError);
  }
});

test('actual slab and building corners fit tightly without reserving tower height on empty edge lots', () => {
  const points = [];
  const addBox = (minX, maxX, minY, maxY, minZ, maxZ) => {
    for (const x of [minX, maxX]) for (const y of [minY, maxY]) for (const z of [minZ, maxZ]) points.push({ x, y, z });
  };
  addBox(-93.5, 93.5, -7, .14, -93.5, 93.5); // The island's actual shallow slab.
  addBox(-30, -18, .14, 35, -22, -10); // A tall building at its occupied lot.
  addBox(29, 37, .14, 5, 28, 36); // A low house on the other district.
  const before = structuredClone(points);
  for (const aspect of [.45, 1, 1.6, 2.5]) for (const polar of [.65, OVERVIEW_POLAR, 1.05]) {
    const azimuth = -.42, margin = 1.07, fov = 40;
    const fit = fitCameraPoints(points, fov, aspect, { polar, azimuth, margin });
    const camera = new THREE.PerspectiveCamera(fov, aspect, .1, fit.distance * 5);
    camera.position.setFromSpherical(new THREE.Spherical(fit.distance, polar, azimuth));
    camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const target = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(fit.offsetX)
      .add(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(fit.offsetY));
    camera.position.add(target); camera.lookAt(target); camera.updateMatrixWorld();
    const projected = points.map(({ x, y, z }) => new THREE.Vector3(x, y, z).project(camera));
    for (const p of projected) {
      assert.ok(Math.abs(p.x) <= 1 / margin + 1e-9 && Math.abs(p.y) <= 1 / margin + 1e-9);
      assert.ok(p.z > -1 && p.z < 1);
    }
    const spans = ['x', 'y'].map(axis => Math.max(...projected.map(p => p[axis])) - Math.min(...projected.map(p => p[axis])));
    assert.ok(spans.some(span => Math.abs(span - 2 / margin) < 1e-8), 'actual geometry fills one dimension to both reserved margins');
    const imaginaryEdgeTowers = fitCameraBox(93.5, fov, aspect, { minY: -7, maxY: 35, polar, azimuth, margin });
    assert.ok(fit.distance < imaginaryEdgeTowers.distance, 'actual occupied lots allow a closer overview');
  }
  assert.deepEqual(points, before, 'scene bounds are not mutated');
});

test('point fit matches the box wrapper, accepts vectors and rejects missing or nonfinite scene bounds', () => {
  const points = [];
  for (const x of [-30, 30]) for (const z of [-30, 30]) for (const y of [-5, 10]) points.push(new THREE.Vector3(x, y, z));
  assert.deepEqual(fitCameraPoints(points, 40, 1.6), fitCameraBox(30, 40, 1.6, { minY: -5, maxY: 10 }));
  const small = fitCameraPoints(points, 40, 1.6);
  const large = fitCameraPoints(points.map(p => p.clone().multiplyScalar(4)), 40, 1.6);
  for (const field of ['distance', 'offsetX', 'offsetY']) assert.ok(Math.abs(large[field] - small[field] * 4) < 1e-9);
  const singleton = fitCameraPoints([{ x: 0, y: 0, z: 0 }], 40, 1.6);
  assert.deepEqual(singleton, { distance: .25, offsetX: 0, offsetY: 0 });
  for (const args of [
    [[], 40, 1], [null, 40, 1], [[null], 40, 1], [Array(1), 40, 1], [[{ x: 1, y: 2 }], 40, 1],
    [[{ x: Infinity, y: 2, z: 3 }], 40, 1], [points, 180, 1], [points, 40, 0],
    [points, 40, 1, { polar: NaN }], [points, 40, 1, { margin: .9 }],
  ]) assert.throws(() => fitCameraPoints(...args), RangeError);
});

test('largest free rectangle excludes navigation, HUD, Machines, toolbar and expanded legend', () => {
  const bounds = box(0, 0, 1600, 1000);
  const blockers = [box(0, 0, 76, 1000), box(90, 70, 520, 177), box(1286, 70, 1586, 410), box(877, 942, 1586, 986), box(90, 563, 413, 986)];
  const result = largestFreeRect(bounds, { blockers });
  assert.deepEqual(result, { left: 520, top: 0, right: 1286, bottom: 942, width: 766, height: 942 });
  assert.ok(blockers.every(blocker => !overlaps(result, blocker)));
  const collapsed = largestFreeRect(bounds, { blockers: [...blockers.slice(0, 4), box(90, 950, 172, 984)] });
  assert.ok(area(collapsed) > area(result));
});

test('panel and mobile layouts choose actual free pixels; fully covered or invalid bounds remain empty', () => {
  const result = largestFreeRect(box(0, 0, 1524, 944), { blockers: [box(1150, 0, 1524, 944), box(14, 14, 444, 121), box(490, 886, 1140, 930)] });
  assert.deepEqual(result, { left: 0, top: 121, right: 1150, bottom: 886, width: 1150, height: 765 });
  const mobile = largestFreeRect(box(0, 0, 390, 788), { blockers: [box(0, 0, 390, 130), box(0, 480, 390, 788)] });
  assert.deepEqual(mobile, { left: 0, top: 130, right: 390, bottom: 480, width: 390, height: 350 });
  assert.equal(area(largestFreeRect(box(0, 0, 390, 788), { blockers: [box(-10, -10, 400, 800)] })), 0);
  assert.equal(area(largestFreeRect(box(0, 0, 0, 0))), 0);
  assert.equal(area(largestFreeRect(null)), 0);
});

test('rectangles are clipped, invalid blockers ignored, and equal areas prefer the center', () => {
  const bounds = box(10, 20, 110, 120);
  assert.deepEqual(largestFreeRect(bounds, { blockers: [box(-20, -20, 25, 200), box(50, 50, 50, 80), box(NaN, 0, 20, 50), box(120, 0, 180, 50)] }), { left: 25, top: 20, right: 110, bottom: 120, width: 85, height: 100 });
  const centered = largestFreeRect(box(0, 0, 100, 100), { blockers: [box(20, 0, 40, 100), box(60, 0, 80, 100)] });
  assert.deepEqual(centered, { left: 40, top: 0, right: 60, bottom: 100, width: 20, height: 100 });
});

test('free rectangle area matches exhaustive edge candidates for overlapping obstacle layouts', () => {
  const bounds = box(0, 0, 200, 120);
  for (let n = 0; n < 12; n++) {
    const blockers = Array.from({ length: 5 }, (_, i) => {
      const x = (n * 17 + i * 41) % 165, y = (n * 31 + i * 19) % 90;
      return box(x, y, x + 20 + (i * 7) % 20, y + 15 + (i * 3) % 15);
    });
    const xs = [...new Set([0, 200, ...blockers.flatMap(b => [b.left, b.right])])];
    const ys = [...new Set([0, 120, ...blockers.flatMap(b => [b.top, b.bottom])])];
    let maximum = 0;
    for (const left of xs) for (const right of xs) for (const top of ys) for (const bottom of ys) {
      if (right <= left || bottom <= top) continue;
      const candidate = box(left, top, right, bottom);
      if (blockers.every(b => !overlaps(candidate, b))) maximum = Math.max(maximum, (right - left) * (bottom - top));
    }
    const result = largestFreeRect(bounds, { blockers });
    assert.equal(area(result), maximum);
    assert.ok(blockers.every(b => !overlaps(result, b)));
  }
});

test('building focus occupies at most 35 percent of visible height and preserves neighbour context', () => {
  for (const dimensions of [{ width: 8, height: 3, depth: 10 }, { width: 12, height: 35, depth: 12 }, { width: 20, height: 8, depth: 18 }]) {
    for (const aspect of [.4, 1, 1.6, 2.5]) {
      const distance = buildingFocusDistance(dimensions, 40, aspect);
      assert.ok(distance >= 32);
      const camera = new THREE.PerspectiveCamera(40, aspect, .1, distance * 4);
      camera.position.setFromSpherical(new THREE.Spherical(distance, OVERVIEW_POLAR, OVERVIEW_AZIMUTH));
      camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
      const projected = [];
      for (const x of [-dimensions.width / 2, dimensions.width / 2]) for (const y of [-dimensions.height / 2, dimensions.height / 2]) for (const z of [-dimensions.depth / 2, dimensions.depth / 2]) {
        projected.push(new THREE.Vector3(x, y, z).project(camera));
      }
      const minY = Math.min(...projected.map(p => p.y)), maxY = Math.max(...projected.map(p => p.y));
      assert.ok((maxY - minY) / 2 <= .35 + 1e-9);
      assert.ok(projected.every(p => Math.abs(p.x) <= .85 + 1e-9 && Math.abs(p.y) <= .35 + 1e-9));
      if (distance > 32 + 1e-9) assert.ok(Math.abs(Math.max(...projected.map(p => Math.max(Math.abs(p.y) / .35, Math.abs(p.x) / .85))) - 1) < 1e-9);
    }
  }
});

test('building focus scales with building dimensions and rejects invalid frame inputs', () => {
  const dimensions = { width: 16, height: 24, depth: 16 };
  const normal = buildingFocusDistance(dimensions, 40, 1.6);
  const larger = buildingFocusDistance({ width: 48, height: 72, depth: 48 }, 40, 1.6);
  assert.ok(Math.abs(larger - normal * 3) < 1e-9);
  assert.ok(buildingFocusDistance(dimensions, 40, .25) > normal);
  for (const args of [
    [{ width: 0, height: 2, depth: 2 }, 40, 1], [{ width: 2, height: NaN, depth: 2 }, 40, 1],
    [dimensions, 180, 1], [dimensions, 40, 0], [dimensions, 40, 1, { heightFraction: 0 }],
    [dimensions, 40, 1, { minDistance: -1 }],
  ]) assert.throws(() => buildingFocusDistance(...args), RangeError);
});
