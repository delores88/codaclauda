/* Solid land on either bank of the river. This is real recessed geometry, so
 * neither water nor boats need depth-test tricks to hide an uncut island. */
import { THREE } from './toon.js';
import { riverBoundsAtX, riverRoadIntervals, RIVER_BANK_WIDTH } from './river-path.js';

export function riverLandGeometry(half, { top = 0, bottom = -1.25, mirror = false, step = 0.75 } = {}) {
  const positions = [], count = Math.max(2, Math.ceil(2 * half / step));
  const section = x => {
    const bounds = riverBoundsAtX(x), lo = mirror ? -bounds.max : bounds.min, hi = mirror ? -bounds.min : bounds.max;
    return [Math.max(-half, Math.min(half, lo)), Math.max(-half, Math.min(half, hi))];
  };
  const quad = (a, b, c, d) => positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let n = 0; n < count; n++) {
    const x0 = -half + n * half * 2 / count, x1 = -half + (n + 1) * half * 2 / count;
    const a = section(x0), b = section(x1);
    for (const [lo0, hi0, lo1, hi1] of [[-half, a[0], -half, b[0]], [a[1], half, b[1], half]]) {
      if (hi0 - lo0 < 1e-8 && hi1 - lo1 < 1e-8) continue;
      const p = [[x0, top, lo0], [x0, top, hi0], [x1, top, hi1], [x1, top, lo1]];
      const q = p.map(([x, , z]) => [x, bottom, z]);
      quad(...p); quad(q[3], q[2], q[1], q[0]);
      quad(p[0], p[3], q[3], q[0]); quad(p[2], p[1], q[1], q[2]);
      if (n === 0) quad(p[1], p[0], q[0], q[1]);
      if (n === count - 1) quad(p[3], p[2], q[2], q[3]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals(); return geometry;
}

/** Subtract closed intervals from a road line; adjoining bridge feet keep their
 * exact coordinates rather than being rounded onto a tessellation grid. */
export function outsideIntervals(min, max, cuts) {
  let pieces = [[min, max]];
  for (const [a, b] of cuts) pieces = pieces.flatMap(([lo, hi]) => [[lo, Math.min(hi, a)], [Math.max(lo, b), hi]].filter(([x, y]) => y - x > 1e-6));
  return pieces;
}

/** Preserve separate dry stretches where a winding river meets one street more
 * than once. Extra normal margin conservatively covers the strip's full width. */
export function riverCuts(axis, line, halfWidth = 0, half = 400) {
  return riverRoadIntervals(axis, line, RIVER_BANK_WIDTH + halfWidth + 0.03, half).map(({ min, max }) => [min, max]);
}

/** A perpendicular approach can overlap just one edge of another road. Keep its
 * remaining paved width instead of cutting a whole cross-street out. */
export function outsideRectangles(rectangles, cuts) {
  let pieces = rectangles;
  for (const cut of cuts) pieces = pieces.flatMap(r => {
    const x0 = Math.max(r.x0, cut.x0), x1 = Math.min(r.x1, cut.x1), z0 = Math.max(r.z0, cut.z0), z1 = Math.min(r.z1, cut.z1);
    if (x1 <= x0 || z1 <= z0) return [r];
    return [{ ...r, x1: x0 }, { ...r, x0: x1 }, { x0, x1, z0: r.z0, z1: z0 }, { x0, x1, z0: z1, z1: r.z1 }]
      .filter(p => p.x1 - p.x0 > 1e-6 && p.z1 - p.z0 > 1e-6);
  });
  return pieces;
}
