import assert from 'node:assert/strict';
import test from 'node:test';
import { createRiverLoop, riverLoopPose, RIVER_DECK_Y } from '../app/city/river-loop.js';
import { WATER_Y } from '../app/city/river-path.js';
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

test('every circuit seam preserves position and the boat forward/up frame', () => {
  for (const half of [29.5, 45.5, 61.5, 93.5, 397.5]) {
    const loop = createRiverLoop(half);
    for (const join of loop.joins) {
      const before = riverLoopPose(loop, (join - .00001) / loop.length), after = riverLoopPose(loop, (join + .00001) / loop.length);
      assert.ok(distance(before.position, after.position) < .00003);
      assert.ok(distance(before.forward, after.forward) < .0001); assert.ok(distance(before.up, after.up) < .0001);
    }
  }
});

test('waterfall centers remain outside the rim while frames stay orthonormal', () => {
  const loop = createRiverLoop(61.5);
  for (let n = 0; n < 1000; n++) {
    const pose = riverLoopPose(loop, n / 1000);
    for (const basis of [pose.forward, pose.up, pose.right]) assert.ok(Math.abs(dot(basis, basis) - 1) < 1e-10);
    assert.ok(Math.abs(dot(pose.forward, pose.up)) < 1e-10); assert.ok(Math.abs(dot(pose.forward, pose.right)) < 1e-10);
    if (pose.section.endsWith('fall')) assert.ok(Math.max(Math.abs(pose.position.x), Math.abs(pose.position.z)) >= loop.half - .005);
    if (pose.section === 'top') assert.equal(pose.position.y, WATER_Y);
    if (pose.section === 'underside') { assert.equal(pose.position.y, RIVER_DECK_Y - WATER_Y); assert.equal(pose.up.y, -1); }
  }
});

test('extending the river keeps the existing top centerline and underside aligned', () => {
  const small = createRiverLoop(61.5), large = createRiverLoop(93.5);
  for (const sample of small.samples.filter((_, n) => n % 20 === 0)) {
    const found = large.samples.findIndex(point => point.x >= sample.x), a = large.samples[Math.max(0, found - 1)], b = large.samples[found];
    const d = a.distance + (b.distance - a.distance) * (sample.x - a.x) / (b.x - a.x);
    const top = riverLoopPose(large, d / large.length), bottom = riverLoopPose(large, (large.riverLength * 2 + large.arcLength - d) / large.length);
    assert.ok(Math.abs(top.position.x - sample.x) < .00001); assert.ok(Math.abs(top.position.z - bottom.position.z) < .00001);
    assert.ok(Math.abs(top.position.y + bottom.position.y - RIVER_DECK_Y) < .00001);
  }
});
