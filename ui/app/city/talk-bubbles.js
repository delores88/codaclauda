/** Place measured conversation bubbles above both heads, with a clear gutter.
 * x/y are the projected anchors; w/h include the rendered bubble padding. */
export function layoutTalkBubbles(bubbles, vis, headTop) {
  const edge = 8, gap = 10;
  const placed = bubbles.map(b => ({ ...b,
    anchorX: b.x,
    anchorY: b.y,
    // A falling avatar may briefly occupy the speech band. Wait for clearance
    // instead of drawing over its face or outside the visible canvas.
    visible: headTop - 12 >= vis.y0 + b.h,
    x: Math.max(vis.x0 + b.w / 2 + edge, Math.min(vis.x1 - b.w / 2 - edge, b.x)),
    y: Math.max(vis.y0 + b.h, Math.min(vis.y1 - edge, b.y - 12, headTop - 12)),
  })).sort((a, b) => a.x - b.x);
  if (placed.length === 2) {
    const [left, right] = placed, separation = (left.w + right.w) / 2 + gap;
    if (right.x - left.x < separation) {
      const center = (left.x + right.x) / 2;
      left.x = Math.max(vis.x0 + left.w / 2 + edge, center - separation / 2);
      right.x = left.x + separation;
      if (right.x + right.w / 2 > vis.x1 - edge) {
        right.x = vis.x1 - right.w / 2 - edge;
        left.x = right.x - separation;
      }
    }
  }
  return placed.map(b => {
    const tailX = b.anchorX - (b.x - b.w / 2);
    // Collision/clipping may move the balloon, but its tail still belongs to
    // the original figure. If that head is outside the balloon's safe span,
    // wait for framing rather than pointing a centred tail at somebody else.
    return { ...b, tailX, tailHeight: Math.max(7, b.anchorY - b.y - 5),
      visible: b.visible && tailX >= 8 && tailX <= b.w - 8 };
  });
}
