import test from 'node:test';
import assert from 'node:assert/strict';
import { riverZ, riverSlope, riverRange, riverFrame, riverSection, riverRoadIntervals, riverBoundsAtX, riverContains,
  riverFootprintClear, riverCellUsable, sampleRiver, bridgeCrossings, bridgeSpan, bridgeAt, bridgeHeight,
  RIVER_CENTER_Z, RIVER_WAVELENGTH, RIVER_AMPLITUDE, RIVER_HALF_WIDTH, RIVER_BANK_WIDTH, RIVER_LOT_HALF, RIVER_LOT_MARGIN,
  BRIDGE_GROUND_Y, BRIDGE_CLEAR_Y, WATER_Y } from '../app/city/river-path.js';
import { MODEL_MAX_TOP } from '../app/city/boat-models.js';
const near = (a, b, epsilon = 1e-7) => assert.ok(Math.abs(a - b) <= epsilon, `${a} approximately ${b}`);

test('the fixed gentle cosine crosses from X rim to X rim and protects headquarters', () => {
  near(RIVER_AMPLITUDE, 2.5); near(RIVER_WAVELENGTH, 17);
  for (let x = -400; x <= 400; x += .25) {
    near(riverZ(x), RIVER_CENTER_Z - 2.5 * Math.cos(x / 17));
    near(riverZ(x), riverZ(-x));
    assert.ok(Math.abs(riverSlope(x)) <= 2.5 / 17 + 1e-8);
  }
  for (const x of [-400, -80, -32, 0, 19, 64, 110, 400]) near(riverSlope(x), (riverZ(x + .00001) - riverZ(x - .00001)) / .00002, 1e-5);
  near(riverSlope(0), 0);
  assert.ok(riverCellUsable(0, 0));
  assert.ok(riverFootprintClear(0, 0, 7.5), 'HQ and its complete sidewalk have extra clearance');
});

test('cosine range queries include interior extrema and expansion preserves every previous interior point', () => {
  for (const [min, max] of [[-75, 90], [-36, -10], [17, 67], [-400, 400]]) {
    const range = riverRange(min, max); assert.deepEqual(riverRange(max, min), range);
    for (let x = min; x <= max; x += .05) assert.ok(riverZ(x) >= range.min - 1e-7 && riverZ(x) <= range.max + 1e-7);
  }
  assert.equal(riverRange(NaN, 0), null);
  const before = Array.from({ length: 81 }, (_, i) => ({ x: i - 40, z: riverZ(i - 40), section: riverSection(i - 40) }));
  for (const half of [61.5, 93.5, 397.5]) {
    const points = sampleRiver(half);
    assert.ok(points.length > 2);
    for (const p of points) { assert.ok(Math.abs(p.x) <= half + 1e-8 && Math.abs(p.z) <= half + 1e-8); near(p.z, riverZ(p.x), .011); }
    near(points[0].x, -half); near(points.at(-1).x, half);
    for (const p of before) { near(riverZ(p.x), p.z); assert.deepEqual(riverSection(p.x), p.section); }
  }
});

test('normal-width water and shared terrain sections agree in both road orientations', () => {
  const frame = riverFrame(-200);
  for (const side of [-1, 1]) {
    assert.ok(riverContains(frame.x + frame.nx * side * 5.49, frame.z + frame.nz * side * 5.49));
    assert.equal(riverContains(frame.x + frame.nx * side * 5.6, frame.z + frame.nz * side * 5.6), false);
  }
  near(riverSection(0).waterMaxZ - riverSection(0).waterMinZ, 11, .001);
  for (const axis of ['x', 'z']) for (let line = -72; line <= 88; line += 16) {
    for (const interval of riverRoadIntervals(axis, line, RIVER_BANK_WIDTH, 125.5)) {
      for (const coordinate of [interval.min + .05, (interval.min + interval.max) / 2, interval.max - .05]) {
        const [x, z] = axis === 'x' ? [coordinate, line] : [line, coordinate];
        assert.ok(riverContains(x, z, RIVER_BANK_WIDTH), `${axis} road interval matches the bank tube`);
      }
    }
  }
  const partial = riverRoadIntervals('x', RIVER_CENTER_Z + RIVER_HALF_WIDTH, 0, 200);
  assert.ok(partial.length >= 3, 'bounded horizontal queries preserve repeated separated dry stretches');
  assert.ok(partial.every(p => p.min >= -200 && p.max <= 200));
  for (const x of [-40, 0, 32, 85]) {
    const section = riverSection(x), bounds = riverBoundsAtX(x);
    near(section.bankMinZ, bounds.min); near(section.bankMaxZ, bounds.max);
    assert.ok(section.bankMinZ < section.waterMinZ && section.bankMaxZ > section.waterMaxZ);
  }
});

test('full lots plus one unit clear the tube; center-only placement is rejected', () => {
  let marginReservations = 0;
  for (let i = -8; i <= 8; i++) for (let j = -5; j <= 5; j++) {
    const x = i * 16, z = j * 16, usable = riverCellUsable(i, j);
    if (riverFootprintClear(x, z, RIVER_LOT_HALF) && !usable) marginReservations++;
    if (!usable) continue;
    const half = RIVER_LOT_HALF + RIVER_LOT_MARGIN;
    for (let dx = -half; dx <= half; dx += 1) for (let dz = -half; dz <= half; dz += 1) assert.equal(riverContains(x + dx, z + dz, RIVER_BANK_WIDTH), false);
  }
  assert.ok(marginReservations > 0, 'the extra one-unit lot clearance reserves otherwise dry footprints');
  const edge = riverBoundsAtX(0).max;
  assert.equal(riverContains(0, edge + 1, RIVER_BANK_WIDTH), false);
  assert.equal(riverFootprintClear(0, edge + 1, 2, 2), false);
  assert.equal(riverCellUsable(.1, 1), false);
  assert.equal(riverFootprintClear(0, 0, -1), false);
});

test('each perpendicular street has one grounded humped bridge with no overlapping crossings', () => {
  const half = 93.5, crossings = bridgeCrossings(half);
  assert.deepEqual(new Set(crossings.map(b => b.axis)), new Set(['z']));
  assert.deepEqual(crossings.map(b => b.x), Array.from({ length: 12 }, (_, n) => -88 + n * 16));
  assert.equal(new Set(crossings.map(b => b.id)).size, crossings.length);
  for (const span of crossings) {
    assert.equal(bridgeSpan(span), span);
    assert.ok(span.x0 >= -half && span.x1 <= half && span.z0 >= -half && span.z1 <= half);
    for (const along of [span.min, span.max]) {
      const [x, z] = span.axis === 'x' ? [along, span.z] : [span.x, along];
      near(bridgeHeight(x, z, crossings), BRIDGE_GROUND_Y);
    }
    for (let along = span.min; along <= span.max; along += .5) {
      const [x, z] = span.axis === 'x' ? [along, span.z] : [span.x, along];
      const height = bridgeHeight(x, z, crossings);
      assert.ok(height >= BRIDGE_GROUND_Y);
      if (riverContains(x, z, RIVER_BANK_WIDTH)) assert.ok(height >= BRIDGE_CLEAR_Y);
    }
  }
  assert.ok(BRIDGE_CLEAR_Y - .18 - (WATER_Y + MODEL_MAX_TOP) >= .3, 'the tallest animated model has at least .3 under the slab');
  near(WATER_Y, BRIDGE_GROUND_Y - .9);
  for (let n = 1; n < crossings.length; n++) assert.ok(crossings[n - 1].x1 < crossings[n].x0, 'bridge slabs never overlap');
  assert.equal(bridgeSpan({ axis: 'x', z: -8 }), null, 'no bridge runs along the river');
});

test('explicit crossing lists do not invent bridges and edge approaches remain supported', () => {
  const span = bridgeCrossings(61.5)[0], along = (span.deckMin + span.deckMax) / 2;
  const [x, z] = span.axis === 'x' ? [along, span.z] : [span.x, along];
  assert.ok(bridgeAt(x, z, [span])); assert.equal(bridgeHeight(x, z, []), null);
  assert.equal(bridgeSpan(Infinity), null); assert.equal(bridgeHeight(NaN, z), null);
  const small = bridgeCrossings(61.5), large = bridgeCrossings(93.5);
  for (const before of small) {
    const after = large.find(b => b.id === before.id); assert.ok(after);
    for (const field of ['x0', 'x1', 'z0', 'z1', 'deckMin', 'deckMax']) near(after[field], before[field]);
  }
});
