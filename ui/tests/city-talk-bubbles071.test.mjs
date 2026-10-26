import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutTalkBubbles } from '../app/city/talk-bubbles.js';

for (const [name, vis, headTop] of [
  ['desktop', { x0: 12, x1: 1050, y0: 80, y1: 850 }, 330],
  ['mobile', { x0: 12, x1: 378, y0: 68, y1: 380 }, 220],
]) test(`${name} bubbles clear both heads and each other even when anchors overlap`, () => {
  const w = Math.min(280, (vis.x1 - vis.x0 - 28) / 2);
  for (const anchor of [vis.x0, (vis.x0 + vis.x1) / 2, vis.x1]) {
    const placed = layoutTalkBubbles([
      { id: 'owner', x: anchor, y: headTop + 90, w, h: 70 },
      { id: 'agent', x: anchor + 1, y: headTop, w, h: 95 },
    ], vis, headTop);
    for (const p of placed) {
      assert.equal(p.visible, true);
      assert.ok(p.x - p.w / 2 >= vis.x0);
      assert.ok(p.x + p.w / 2 <= vis.x1);
      assert.ok(p.y - p.h >= vis.y0);
      assert.ok(p.y <= headTop - 12, 'bubble clears the higher head');
    }
    assert.ok(placed[0].x + placed[0].w / 2 + 9 < placed[1].x - placed[1].w / 2);
  }
});

test('bubbles wait through a drop-in when the head temporarily fills the speech band', () => {
  const vis = { x0: 12, x1: 378, y0: 68, y1: 380 };
  const bubble = { x: 200, y: 180, w: 150, h: 95 };
  assert.equal(layoutTalkBubbles([bubble], vis, 160)[0].visible, false);
  const settled = layoutTalkBubbles([bubble], vis, 220)[0];
  assert.equal(settled.visible, true);
  assert.ok(settled.y - settled.h >= vis.y0);
  assert.ok(settled.y <= 208);
});
