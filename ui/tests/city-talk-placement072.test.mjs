import test from 'node:test';
import assert from 'node:assert/strict';
import { buildingSize, downtownBasePlan } from '../app/city/buildings.js';
import { cellCenter } from '../app/city/layout.js';
import { talkPlanterBoxes } from '../app/city/talk-placement.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const contains = (box, x, z) => x > box.x0 && x < box.x1 && z > box.z0 && z < box.z1;

test('the four actual Downtown planters keep separate footprints at their rendered positions', () => {
  const cell = { i: -4, j: 3 }, center = cellCenter(cell.i, cell.j);
  const plan = downtownBasePlan(buildingSize({ metrics: { footprint: 1 } }), cell);
  const building = { origin: { x: center.x, z: center.z - .3 }, downtownBase: plan };
  const boxes = talkPlanterBoxes([building]);
  assert.equal(boxes.length, 4);
  const positions = [[-3.7, 5.08], [1.9, 5.08], [-4.3, -4.95], [4.3, -4.95]];
  for (const [i, [x, z]] of positions.entries()) {
    close((boxes[i].x0 + boxes[i].x1) / 2, center.x + x);
    close((boxes[i].z0 + boxes[i].z1) / 2, center.z + z);
    assert.equal(boxes[i].low, true);
    assert.equal(boxes.filter(box => contains(box, center.x + x, center.z + z)).length, 1);
  }
  assert.equal(boxes.some(box => contains(box, center.x, center.z + 5.08)), false, 'the space between front beds remains usable');
  assert.deepEqual(talkPlanterBoxes([{ origin: building.origin }]), [], 'unplanted buildings add no footprint');
});

test('origin and current pad scale transform each planter without shifting its local offset twice', () => {
  const building = { origin: { x: 11, z: -7 }, padGroup: { scale: { x: .6, z: 1.4 } },
    downtownBase: { plants: [{ x: 2, z: 3, w: 2, d: 1, radius: .75 }] } };
  const [box] = talkPlanterBoxes([building], .5);
  close(box.x0, 11 + 2 * .6 - 1 * .6 - .5);
  close(box.x1, 11 + 2 * .6 + 1 * .6 + .5);
  close(box.z0, -7 + 3 * 1.4 - .75 * 1.4 - .5);
  close(box.z1, -7 + 3 * 1.4 + .75 * 1.4 + .5);
});

test('clearance stays in island units and covers both planter walls and wider foliage', () => {
  const building = { origin: { x: 0, z: 0 }, padGroup: { scale: { x: .5, z: .5 } },
    downtownBase: { plants: [{ x: 0, z: 0, w: 3, d: .4, radius: .8 }] } };
  const [plain] = talkPlanterBoxes([building], 0), [padded] = talkPlanterBoxes([building]);
  close(plain.x1, .75); close(plain.z1, .4);
  for (const axis of ['x', 'z']) {
    close(plain[axis + '0'] - padded[axis + '0'], .5);
    close(padded[axis + '1'] - plain[axis + '1'], .5);
  }
  assert.equal(contains(padded, .74, .89), true, 'a standing body cannot intersect the bed from an otherwise clear centre');
});
