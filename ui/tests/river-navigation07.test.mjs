import { riverLot } from '../app/city/river-lots.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { riverRoute, riverStep, riverWalkable, riverSegmentWalkable } from '../app/city/river-navigation.js';
import { riverZ, riverSide, riverContains, sampleRiver, bridgeCrossings, bridgeAt, bridgeHeight, RIVER_BANK_WIDTH } from '../app/city/river-path.js';
import { planPath } from '../app/city/layout.js';
import { districtCells, DISTRICTS } from '../app/city/districts.js';

const half = 93.5, crossings = bridgeCrossings(half);
function supported(from, route, bridges = crossings) {
  for (const end of route) {
    assert.ok(riverSegmentWalkable(from, end, bridges), `unsupported segment ${JSON.stringify([from, end])}`);
    const samples = Math.max(1, Math.ceil(Math.hypot(end.x - from.x, end.z - from.z) / .3));
    for (let n = 0; n <= samples; n++) {
      const x = from.x + (end.x - from.x) * n / samples, z = from.z + (end.z - from.z) * n / samples;
      assert.ok(Math.abs(x) <= half && Math.abs(z) <= half, 'route stays on the island');
      if (riverContains(x, z, RIVER_BANK_WIDTH)) assert.ok(bridgeAt(x, z, bridges), 'every water crossing has a real bridge');
    }
    from = end;
  }
}

test('routes between districts preserve dry endpoints and cross the river on supported bridges', () => {
  const cells = DISTRICTS.flatMap(d => districtCells(4, d));
  for (let i = 0; i < cells.length; i += 4) for (let j = 1; j < cells.length; j += 7) {
    const doorstep = c => { const p = riverLot(c.i, c.j); return { x: c.i * 16, z: c.j * 16 + (p?.side || 1) * 5.8 }; };
    const from = doorstep(cells[i]), to = doorstep(cells[j]);
    const route = riverRoute(from, planPath(from, to), crossings);
    assert.deepEqual(route.at(-1), to); supported(from, route);
  }
});

test('clicks on every perpendicular bridge reach the chosen deck or approach', () => {
  const from = { x: 0, z: 4 }, seen = new Set();
  for (const span of crossings) {
    seen.add(span.axis);
    for (const coordinate of [span.min + 1, (span.deckMin + span.deckMax) / 2, span.max - 1]) {
      const to = span.axis === 'x' ? { x: coordinate, z: span.z } : { x: span.x, z: coordinate };
      const route = riverRoute(from, planPath(from, to), crossings);
      assert.deepEqual(route.at(-1), to); supported(from, route);
      assert.ok(bridgeHeight(to.x, to.z, crossings) >= .14);
    }
  }
  assert.deepEqual(seen, new Set(['z']));
});

test('water clicks clamp to dry banks and street movement cannot tunnel across water', () => {
  const from = { x: 0, z: 4 }, water = { x: 0, z: riverZ(0) };
  const route = riverRoute(from, [water], crossings);
  assert.ok(riverWalkable(route.at(-1).x, route.at(-1).z, crossings)); supported(from, route);
  const a = { x: 0, z: riverZ(0) - 20 }, b = { x: 0, z: riverZ(0) + 20 };
  assert.deepEqual(riverStep(a, b, []), a);
  for (const bridge of crossings) {
    const from = { x: bridge.x, z: bridge.min - .1 }, to = { x: bridge.x, z: bridge.max + .1 };
    assert.deepEqual(riverStep(from, to, crossings), to);
  }
});

test('raised bridge destinations are approached through supported grades, never lateral walls', () => {
  const examples = new Map();
  for (const span of crossings) {
    for (const side of [-1, 1]) {
      if (examples.has(side)) continue;
      for (let coordinate = span.min + 1; coordinate < span.max - 1; coordinate += .5) {
        const to = { x: span.x, z: coordinate };
        const from = { x: span.x + side * (span.halfWidth + .6), z: coordinate };
        if ((bridgeHeight(to.x, to.z, crossings) || 0) < .7 || bridgeAt(from.x, from.z, crossings) || !riverWalkable(from.x, from.z, crossings)) continue;
        if (riverSegmentWalkable(from, to, crossings)) continue;
        examples.set(side, { from, to }); break;
      }
    }
  }
  assert.equal(examples.size, 2);
  for (const { from, to } of examples.values()) {
    assert.deepEqual(riverStep(from, to, crossings), from);
    const route = riverRoute(from, [to], crossings); assert.deepEqual(route.at(-1), to); supported(from, route);
    const reverse = riverRoute(to, [from], crossings); assert.deepEqual(reverse.at(-1), from); supported(to, reverse);
  }
});

test('explicit empty bridge lists stay on the initial bank instead of inventing crossings', () => {
  const from = { x: 0, z: 4 }, route = riverRoute(from, [{ x: 0, z: riverZ(0) - 20 }], []);
  assert.equal(riverSide(route.at(-1).x, route.at(-1).z), riverSide(from.x, from.z));
  supported(from, route, []);
});

test('outlet clicks never route onto a bank beyond the island rim', () => {
  const from = { x: 0, z: 4 };
  for (const edge of [29.5, 45.5, 61.5, 93.5]) {
    const bridges = bridgeCrossings(edge), river = sampleRiver(edge - 1, 2);
    for (const water of [river[0], river.at(-1)]) {
      for (const points of [[water], [{ x: 8, z: 8 }, water]]) {
        const route = riverRoute(from, points, bridges);
        let previous = from;
        for (const point of route) {
          assert.ok(Math.abs(point.x) <= edge - .5 && Math.abs(point.z) <= edge - .5, `outlet route escaped ${edge}: ${JSON.stringify(point)}`);
          assert.ok(riverSegmentWalkable(previous, point, bridges));
          previous = point;
        }
      }
    }
  }
});
