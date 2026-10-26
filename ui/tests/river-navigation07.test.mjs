import assert from 'node:assert/strict';
import test from 'node:test';
import { riverRoute, riverStep, riverWalkable, riverSegmentWalkable } from '../app/city/river-navigation.js';
import { riverZ, bridgeSpan, bridgeHeight } from '../app/city/river-path.js';
import { planPath } from '../app/city/layout.js';
import { districtCells, DISTRICTS } from '../app/city/districts.js';

const crossings = Array.from({ length: 10 }, (_, i) => (i - 4.5) * 16);
function supported(from, route) {
  for (const end of route) {
    assert.ok(riverSegmentWalkable(from, end, crossings), `unsupported segment ${JSON.stringify([from, end])}`);
    from = end;
  }
}

test('walking routes join districts only across supported bridges', () => {
  const cells = DISTRICTS.flatMap(d => districtCells(3, d));
  for (let i = 0; i < cells.length; i += 2) for (let j = 1; j < cells.length; j += 3) {
    const from = { x: cells[i].i * 16, z: cells[i].j * 16 + 5.8 };
    const to = { x: cells[j].i * 16, z: cells[j].j * 16 + 5.8 };
    const route = riverRoute(from, planPath(from, to), crossings);
    assert.deepEqual(route.at(-1), to);
    supported(from, route);
  }
});

test('bridge destinations and water clicks keep the walker on a supported surface', () => {
  const from = { x: 0, z: 4 };
  for (const x of crossings.slice(2, -2)) {
    const span = bridgeSpan(x);
    for (const z of [span.minZ + 1, riverZ(x), span.maxZ - 1]) {
      const to = { x, z }, route = riverRoute(from, planPath(from, to), crossings);
      assert.deepEqual(route.at(-1), to); supported(from, route);
      assert.ok(bridgeHeight(to.x, to.z, crossings) >= 0.14);
    }
  }
  const clamped = riverRoute(from, [{ x: 0, z: riverZ(0) }], crossings);
  assert.ok(riverWalkable(clamped.at(-1).x, clamped.at(-1).z, crossings));
  supported(from, clamped);
});

test('street controls cannot cross water or tunnel through it, and may cross a bridge', () => {
  const north = { x: 0, z: -16 }, south = { x: 0, z: 0 };
  assert.deepEqual(riverStep(north, south, crossings), north);
  const span = bridgeSpan(8), a = { x: 8, z: span.minZ - 1 }, b = { x: 8, z: span.maxZ + 1 };
  assert.deepEqual(riverStep(a, b, crossings), b);
  assert.deepEqual(riverRoute({ x: 20, z: 10 }, [{ x: 30, z: 10 }], crossings), [{ x: 30, z: 10 }]);
});

test('walkers approach elevated bridge destinations by ramps instead of side walls', () => {
  const span = bridgeSpan(8), to = { x: 8, z: span.deckMinZ + 0.2 };
  const from = { x: 12, z: to.z };
  assert.equal(riverSegmentWalkable(from, to, crossings), false);
  assert.deepEqual(riverStep(from, to, crossings), from);
  const route = riverRoute(from, [to], crossings);
  assert.ok(route.some(p => p.z < span.minZ));
  supported(from, route); supported(to, riverRoute(to, [from], crossings));
});

test('an explicitly empty bridge list cannot invent a crossing', () => {
  const from = { x: 0, z: 4 }, route = riverRoute(from, [{ x: 0, z: -24 }], []);
  assert.ok(route.at(-1).z > riverZ(route.at(-1).x));
  let previous = from;
  for (const point of route) { assert.ok(riverSegmentWalkable(previous, point, [])); previous = point; }
});
