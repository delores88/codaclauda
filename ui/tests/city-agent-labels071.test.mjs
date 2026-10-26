import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ||= {};
globalThis.document ||= { compatMode: 'CSS1Compat' };
globalThis.localStorage ||= { getItem: () => null, setItem() {} };
const { declutterLabels } = await import('../app/views/city.js');
const chipRect = (x, y, n) => ({ left: x - (34 + `${n} agents`.length * 6.6) / 2,
  right: x + (34 + `${n} agents`.length * 6.6) / 2, top: y - 28, bottom: y - 4 });
const item = (key, ax, ay, extra = {}) => ({ key, ax, ay, priority: 40, dist: 100, clusterable: true,
  rect: { left: ax - 64, right: ax + 64, top: ay - 26, bottom: ay - 4 }, ...extra });
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test('unknown HQ agents whose projected labels collide form one selectable count chip', () => {
  const people = [item('unknown-a', 300, 240), item('unknown-b', 322, 246), item('unknown-c', 285, 254), item('unknown-d', 304, 259)];
  const result = declutterLabels(people, { chipRect, bounds: { left: 0, top: 0, right: 900, bottom: 600 } });
  assert.equal(result.shown.size, 0);
  assert.equal(result.chips.length, 1);
  assert.deepEqual(new Set(result.chips[0].members), new Set(people.map(p => p.key)), 'the existing picker receives every agent identity');
  for (const person of people) assert.equal(result.clusterOf.get(person.key), result.chips[0].key);
});

test('agent labels and nearby cluster chips leave each other and the HUD clear', () => {
  const people = [item('unknown-a', 300, 240), item('unknown-b', 320, 246),
    item('building-a', 400, 240), item('building-b', 422, 246), item('separate', 650, 360)];
  const blocker = { left: 240, right: 450, top: 204, bottom: 230 };
  const result = declutterLabels(people, { chipRect, blockers: [blocker], bounds: { left: 0, top: 0, right: 900, bottom: 600 } });
  const rects = [...people.filter(p => result.shown.has(p.key)).map(p => p.rect),
    ...result.chips.map(c => chipRect(c.ax + c.dx, c.ay + c.dy, c.members.length))];
  assert.ok(result.chips.length > 0);
  for (let i = 0; i < rects.length; i++) {
    assert.equal(overlaps(rects[i], blocker), false);
    for (let j = 0; j < i; j++) assert.equal(overlaps(rects[i], rects[j]), false);
  }
  assert.ok(result.shown.has('separate'), 'a resolvable isolated agent keeps its direct label');
});
