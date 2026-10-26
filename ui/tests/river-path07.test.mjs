import test from 'node:test';
import assert from 'node:assert/strict';
import { riverZ, riverSlope, riverRange, riverContains, riverFootprintClear, riverCellUsable, bridgeSpan, bridgeAt, bridgeHeight,
  RIVER_AMPLITUDE, RIVER_CENTER_Z, RIVER_WAVELENGTH, RIVER_HALF_WIDTH, RIVER_BANK_WIDTH, RIVER_LOT_HALF, BRIDGE_HALF_WIDTH, BRIDGE_DECK_Y, BRIDGE_GROUND_Y, WATER_Y } from '../app/city/river-path.js';

const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} approximately ${b}`);

test('fixed meander keeps HQ clear and its analytic tangent matches its path', () => {
  assert.equal(riverZ(0), -10.5);
  assert.ok(riverCellUsable(0, 0), 'the entire HQ lot and sidewalk remain dry');
  for (let x = -400; x <= 400; x += 2.5) {
    assert.ok(Math.abs(riverZ(x) - RIVER_CENTER_Z) <= RIVER_AMPLITUDE);
    near(riverSlope(x), (riverZ(x + .0001) - riverZ(x - .0001)) / .0002);
  }
  near(riverZ(29), riverZ(29 + 2 * Math.PI * RIVER_WAVELENGTH));
});

test('range checks include interior extrema rather than just endpoint heights', () => {
  const range = riverRange(-6.5, 6.5);
  assert.equal(range.min, -10.5);
  assert.ok(range.min < riverZ(-6.5));
  assert.deepEqual(riverRange(6.5, -6.5), range);
  assert.deepEqual(riverRange(-200, 200), { min: -10.5, max: -5.5 });
  assert.equal(riverRange(NaN, 0), null);
  for (const [lo, hi] of [[-110, -80], [24, 64], [-2, 3], [90, 140]]) {
    const span = riverRange(lo, hi);
    for (let x = lo; x <= hi; x += .1) assert.ok(riverZ(x) >= span.min - 1e-9 && riverZ(x) <= span.max + 1e-9);
  }
});

test('water, bank and whole-footprint queries agree at contact boundaries', () => {
  for (const x of [-50, -24, 0, 24, 50]) {
    const center = riverZ(x);
    assert.ok(riverContains(x, center));
    assert.ok(riverContains(x, center + RIVER_HALF_WIDTH - 1e-6));
    assert.equal(riverContains(x, center + RIVER_HALF_WIDTH + .1), false);
    assert.ok(riverContains(x, center + RIVER_HALF_WIDTH + .1, RIVER_BANK_WIDTH));
    assert.equal(riverFootprintClear(x, center, 0, 0), false);
    assert.equal(riverFootprintClear(x, center + 4, .5, .5), true);
  }
  assert.equal(riverCellUsable(0, -1), false);
  assert.equal(riverCellUsable(1, 0), false);
  assert.equal(riverCellUsable(0, -2), true);
  assert.equal(riverCellUsable(0, 1), true);
  assert.equal(riverCellUsable(.1, 1), false);
  assert.equal(riverFootprintClear(0, 0, -1), false);
});

test('every accepted full lot and sidewalk clears sampled water and banks across the city', () => {
  for (let i = -10; i <= 10; i++) for (let j = -4; j <= 4; j++) {
    if (!riverCellUsable(i, j)) continue;
    for (let dx = -RIVER_LOT_HALF; dx <= RIVER_LOT_HALF; dx += .5) for (let dz = -RIVER_LOT_HALF; dz <= RIVER_LOT_HALF; dz += .5) {
      assert.equal(riverContains(i * 16 + dx, j * 16 + dz, RIVER_BANK_WIDTH), false, `dry lot ${i},${j}`);
    }
  }
});

test('bridges cover the entire corridor and ramps meet the deck and ground continuously', () => {
  for (let crossing = -72; crossing <= 72; crossing += 16) {
    const span = bridgeSpan(crossing);
    near(bridgeHeight(crossing, span.minZ), BRIDGE_GROUND_Y);
    near(bridgeHeight(crossing, span.maxZ), BRIDGE_GROUND_Y);
    near(bridgeHeight(crossing, span.deckMinZ), BRIDGE_DECK_Y);
    near(bridgeHeight(crossing, span.deckMaxZ), BRIDGE_DECK_Y);
    for (let x = crossing - BRIDGE_HALF_WIDTH; x <= crossing + BRIDGE_HALF_WIDTH; x += .1) {
      assert.ok(riverZ(x) - RIVER_HALF_WIDTH - RIVER_BANK_WIDTH >= span.deckMinZ - 1e-8);
      assert.ok(riverZ(x) + RIVER_HALF_WIDTH + RIVER_BANK_WIDTH <= span.deckMaxZ + 1e-8);
      near(bridgeHeight(x, riverZ(x)), BRIDGE_DECK_Y);
    }
    assert.ok(BRIDGE_DECK_Y - .18 - (WATER_Y + 1.07) >= .5, 'boat envelope has headroom under the central slab');
    assert.equal(bridgeHeight(crossing, span.minZ - .01), null);
    assert.equal(bridgeHeight(crossing + BRIDGE_HALF_WIDTH + .01, span.centerZ), null);
  }
});

test('explicit crossing lists prevent navigation from inventing bridges outside the island', () => {
  const z = riverZ(24);
  assert.ok(bridgeAt(24, z));
  assert.equal(bridgeAt(24, z, [-8, 8]), null);
  assert.equal(bridgeHeight(24, z, []), null);
  assert.equal(bridgeHeight(24, z, [24]), BRIDGE_DECK_Y);
  assert.equal(bridgeSpan(Infinity), null);
  assert.equal(bridgeHeight(NaN, z), null);
});
