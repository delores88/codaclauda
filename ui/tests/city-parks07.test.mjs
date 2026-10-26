import assert from 'node:assert/strict';
import test from 'node:test';
import { THREE, toonMaterial } from '../app/city/toon.js';
import { PARK_TYPES, parkPlan, buildDowntownParks } from '../app/city/parks.js';
import { buildDecor } from '../app/city/scenery.js';
import { LOT_HALF, islandHalf } from '../app/city/layout.js';
import { disposeAll } from '../app/city/fx.js';

function examples() {
  const byType = new Map();
  for (let i = -12; i <= 12; i++) for (let j = -12; j < 0; j++) {
    const plan = parkPlan(i, j);
    if (!byType.has(plan.type)) byType.set(plan.type, { i, j, x: 0, z: 0 });
  }
  assert.equal(byType.size, 6);
  return [...byType];
}

test('six park types are deterministic and cardinal neighbours differ across signed coordinates', () => {
  const types = new Set();
  for (let i = -24; i <= 24; i++) for (let j = -24; j <= 24; j++) {
    const plan = parkPlan(i, j); types.add(plan.type);
    assert.deepEqual(parkPlan(i, j), plan);
    for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) assert.notEqual(parkPlan(i + di, j + dj).type, plan.type, `repeated neighbours at ${i},${j}`);
  }
  assert.deepEqual([...types].sort(), [...PARK_TYPES].sort());
});

test('expansion and occupying another lot preserve existing park choices', () => {
  const before = buildDecor(2, new Map(), islandHalf(2), { districts: true });
  const occupied = { i: 2, j: -2, padW: 5.8, padD: 5.4, cz: -0.3 };
  const after = buildDecor(4, new Map([['2,-2', occupied]]), islandHalf(4), { districts: true });
  const plans = after.getObjectByName('downtown-parks').userData.parks;
  for (const plan of before.getObjectByName('downtown-parks').userData.parks) {
    if (plan.i === occupied.i && plan.j === occupied.j) continue;
    assert.deepEqual(plans.find(p => p.i === plan.i && p.j === plan.j), plan);
  }
  assert.ok(!plans.some(p => p.i === occupied.i && p.j === occupied.j));
  disposeAll(before); disposeAll(after);
});

test('all six real models fit within a lot, have valid colour streams and never intercept picking', () => {
  const positions = new Set();
  for (const [type, lot] of examples()) {
    const group = buildDowntownParks([lot]); group.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(group);
    assert.ok(bounds.min.x >= -LOT_HALF && bounds.max.x <= LOT_HALF, `${type} x bounds`);
    assert.ok(bounds.min.z >= -LOT_HALF && bounds.max.z <= LOT_HALF, `${type} z bounds`);
    assert.ok(bounds.min.y >= 0, `${type} has no geometry below the island surface`);
    const solid = group.getObjectByName('park-solids'), geometry = solid.geometry;
    assert.equal(geometry.attributes.color.count, geometry.attributes.position.count);
    for (const value of geometry.attributes.position.array) assert.ok(Number.isFinite(value), `${type} has nonfinite geometry`);
    positions.add(geometry.attributes.position.count);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0));
    assert.deepEqual(ray.intersectObject(group, true), []);
    disposeAll(group);
  }
  assert.equal(positions.size, 6, 'six distinct model geometries');
});

test('each rendered park retains at least 60 percent green or planted coverage of the lot', t => {
  // Sample the actual topmost solid surface, including furniture, rather than
  // trusting a declared ratio or the lawn hidden under paving. Soil in raised
  // crop beds counts as planted; kiosk paint, court teal and umbrellas do not.
  const plantedColors = ['#8aca70', '#5b9f66', '#397854', '#654b3d', '#f4a6c1', '#d77255', '#a586c4', '#c4b86b'];
  const sameColor = (attr, index, color) => Math.abs(attr.getX(index) - color.r) < 1e-5 && Math.abs(attr.getY(index) - color.g) < 1e-5 && Math.abs(attr.getZ(index) - color.b) < 1e-5;
  const insufficient = [];
  for (const [type, lot] of examples()) for (const scaleX of [1, 0.94]) {
    const planted = [...plantedColors, ...(['cafe-plaza', 'community-garden'].includes(type) ? ['#ffd36b'] : [])].map(hex => new THREE.Color(hex));
    const group = buildDowntownParks([{ ...lot, scaleX }]);
    const source = group.getObjectByName('park-solids');
    const surface = new THREE.Mesh(source.geometry, source.material); surface.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    const count = 114; let green = 0; // 0.1-unit samples avoid aliasing narrow paths and planter edges
    for (let i = 0; i < count; i++) for (let j = 0; j < count; j++) {
      ray.ray.origin.set(-LOT_HALF + (i + 0.5) * LOT_HALF * 2 / count, 10, -LOT_HALF + (j + 0.5) * LOT_HALF * 2 / count);
      const hit = ray.intersectObject(surface, false)[0];
      // The thin uncovered lot rim is still gray below the park, so it counts
      // in the denominator instead of artificially inflating the planted ratio.
      if (hit && planted.some(color => sameColor(source.geometry.attributes.color, hit.face.a, color))) green++;
    }
    const coverage = green / (count * count);
    const measured = `${type} at width ${scaleX}: ${(100 * coverage).toFixed(2)}% green/planted`;
    t.diagnostic(measured);
    disposeAll(group);
    if (coverage < 0.6) insufficient.push(measured);
  }
  assert.deepEqual(insufficient, [], 'all park types retain enough planting beside bridge approaches');
});

test('string lamps follow day/night and disable their emission live in low quality without moving geometry', () => {
  const lot = examples().find(([type]) => type === 'cafe-plaza')[1];
  const lamp = toonMaterial('#fff6dd', { emissive: '#ffcf6b', emissiveIntensity: 0.1, cache: false });
  const group = buildDowntownParks([lot], { lampMaterial: lamp });
  const lights = group.getObjectByName('park-string-lights');
  const before = group.children.map(mesh => [...mesh.geometry.attributes.position.array]);
  const renderer = { shadowMap: { enabled: true } };
  lights.onBeforeRender(renderer); assert.equal(lights.material.emissiveIntensity, 0);
  lamp.emissiveIntensity = 1.7;
  lights.onBeforeRender(renderer); assert.ok(lights.material.emissiveIntensity > 1.5);
  renderer.shadowMap.enabled = false;
  lights.onBeforeRender(renderer); assert.equal(lights.material.emissiveIntensity, 0);
  assert.equal(group.getObjectByName('park-lamps').material.emissiveIntensity, 1.7, 'warm path lamps remain on');
  renderer.shadowMap.enabled = true;
  lights.onBeforeRender(renderer); assert.ok(lights.material.emissiveIntensity > 1.5);
  group.children.forEach((mesh, n) => assert.deepEqual([...mesh.geometry.attributes.position.array], before[n], 'lighting never moves static park geometry'));
  disposeAll(group);
});

test('batch draw count is independent of lot count and owned resources are released', () => {
  const sample = examples().map(([, lot], n) => ({ ...lot, x: n * 16 }));
  for (const repeats of [1, 4]) {
    const lots = Array.from({ length: repeats }, (_, row) => sample.map(lot => ({ ...lot, z: row * 16 }))).flat();
    const group = buildDowntownParks(lots);
    assert.equal(group.children.length, 5);
    const owned = new Set(), released = new Set();
    group.traverse(node => {
      if (node.geometry && !node.geometry.userData.shared) owned.add(node.geometry);
      if (node.material && !node.material.userData.shared) owned.add(node.material);
    });
    for (const resource of owned) resource.addEventListener('dispose', () => released.add(resource));
    disposeAll(group);
    assert.equal(released.size, owned.size);
  }
  const empty = buildDowntownParks([]); assert.equal(empty.children.length, 0); disposeAll(empty);
});
