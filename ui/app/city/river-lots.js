/* Dry riverfront parcels. Pure geometry shared by allocation, scenery and picking.
 * The curved edge uses quarter-unit sections with a conservative .03-unit inset.
 * Rectangles retain the dry street edge; bridge envelopes include both ramps. */
import { riverBoundsAtX, riverCellUsable, riverFootprintClear, bridgeSpan, RIVER_BANK_WIDTH } from './river-path.js';

export const PARCEL_HALF = 5.7;
export const PARCEL_MARGIN = RIVER_BANK_WIDTH + 1;
const STEP = 0.25, INSET = 0.03, EPS = 1e-7;
const cache = new Map();
export const rectArea = r => r ? Math.max(0, r.x1 - r.x0) * Math.max(0, r.z1 - r.z0) : 0;
export const rectOverlap = (a, b) => a.x0 < b.x1 - EPS && a.x1 > b.x0 + EPS && a.z0 < b.z1 - EPS && a.z1 > b.z0 + EPS;
export function polygonArea(points) {
  return Math.abs(points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.z - q.x * p.z; }, 0)) / 2;
}
export function clipPolygon(points, axis, edge, keepAbove) {
  const output = [], inside = p => keepAbove ? p[axis] >= edge : p[axis] <= edge;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], ai = inside(a), bi = inside(b);
    if (ai) output.push(a);
    if (ai !== bi) { const t = (edge - a[axis]) / (b[axis] - a[axis]); output.push({ x: a.x + t * (b.x - a.x), z: a.z + t * (b.z - a.z) }); }
  }
  return output;
}
export function subtractRect(polygon, rect) {
  let remainder = polygon;
  const output = [];
  for (const [axis, edge, above] of [['x', rect.x0, false], ['x', rect.x1, true], ['z', rect.z0, false], ['z', rect.z1, true]]) {
    const piece = clipPolygon(remainder, axis, edge, above);
    if (polygonArea(piece) > EPS) output.push(piece);
    remainder = clipPolygon(remainder, axis, edge, !above);
  }
  return output;
}
export function parcelEligible(rect, dryArea, fullArea = (PARCEL_HALF * 2) ** 2) {
  if (!rect) return false;
  const w = rect.x1 - rect.x0, d = rect.z1 - rect.z0;
  return Math.min(w, d) >= 4 - EPS && Math.max(w, d) >= 6 - EPS && dryArea >= fullArea * 0.35 - EPS;
}
export function riverfrontShape(rect, district) {
  const wide = (rect.x1 - rect.x0) / (rect.z1 - rect.z0) >= 1.6;
  return district === 'downtown' ? wide ? 'terraced' : 'slim' : wide ? 'deck-house' : 'townhouse';
}
export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.z > point.z) !== (b.z > point.z) && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
export const pointInParcel = (point, parcel) => parcel?.polygons.some(p => pointInPolygon(point, p)) || false;

/** Largest frontage rectangle in the clipped polygon. Sweep river-edge heights:
 * each connected dry interval has width linear in height between polygon vertices.
 * Its area is quadratic, so check endpoints and its interior stationary point. */
export function inscribedRectangle(bounds, edge, side, obstacles = []) {
  const front = side > 0 ? bounds.z1 : -bounds.z0, back = side > 0 ? bounds.z0 : -bounds.z1;
  const xs = [...new Set([...edge.map(p => p.x), ...obstacles.flatMap(r => [r.x0, r.x1]).filter(x => x > bounds.x0 && x < bounds.x1)])].sort((a, b) => a - b);
  const edgeAt = x => {
    const n = edge.findIndex(p => p.x >= x);
    if (n <= 0) return side * edge[0].z;
    const a = edge[n - 1], b = edge[n]; return side * (a.z + (b.z - a.z) * (x - a.x) / (b.x - a.x));
  };
  const segments = [];
  for (let n = 1; n < xs.length; n++) {
    const x0 = xs[n - 1], x1 = xs[n], mid = (x0 + x1) / 2;
    const floor = Math.max(back, ...obstacles.filter(o => mid > o.x0 && mid < o.x1 && o.z1 > bounds.z0 && o.z0 < bounds.z1).map(o => side > 0 ? o.z1 : -o.z0));
    const a = edgeAt(x0), b = edgeAt(x1), cuts = [x0, x1];
    for (const height of [floor, front]) if (height > Math.min(a, b) && height < Math.max(a, b)) cuts.push(x0 + (x1 - x0) * (height - a) / (b - a));
    cuts.sort((a, b) => a - b);
    const at = x => Math.min(front, Math.max(floor, a + (b - a) * (x - x0) / (x1 - x0)));
    for (let k = 1; k < cuts.length; k++) segments.push({ x0: cuts[k - 1], x1: cuts[k], y0: at(cuts[k - 1]), y1: at(cuts[k]) });
  }
  const spans = height => {
    const runs = [];
    for (const s of segments) {
      if (Math.min(s.y0, s.y1) > height + EPS) continue;
      let left = s.x0, right = s.x1;
      if (s.y0 > height) left += (s.x1 - s.x0) * (s.y0 - height) / (s.y0 - s.y1);
      if (s.y1 > height) right = s.x0 + (s.x1 - s.x0) * (height - s.y0) / (s.y1 - s.y0);
      if (right - left <= EPS) continue;
      const prior = runs.at(-1);
      if (prior && left <= prior.x1 + EPS) prior.x1 = right; else runs.push({ x0: left, x1: right });
    }
    return runs;
  };
  let best = null, area = 0;
  const consider = height => {
    for (const run of spans(height)) {
      const value = (run.x1 - run.x0) * (front - height);
      if (value > area + EPS) { best = { ...run, z0: side > 0 ? height : -front, z1: side > 0 ? front : -height }; area = value; }
    }
  };
  const levels = [...new Set([back, front, ...segments.flatMap(s => [s.y0, s.y1])])].sort((a, b) => a - b);
  for (const level of levels) consider(level);
  for (let n = 1; n < levels.length; n++) {
    const lo = levels[n - 1], hi = levels[n]; if (hi - lo < EPS) continue;
    const a = lo + (hi - lo) / 3, b = lo + 2 * (hi - lo) / 3, first = spans(a), last = spans(b);
    for (let k = 0; k < first.length; k++) {
      if (!last[k]) continue;
      const width = first[k].x1 - first[k].x0, slope = ((last[k].x1 - last[k].x0) - width) / (b - a);
      if (slope <= EPS) continue;
      const height = (front - (width - slope * a) / slope) / 2;
      if (height > lo && height < hi) consider(height);
    }
  }
  return best;
}

export function riverLot(i, j) {
  if (!Number.isInteger(i) || !Number.isInteger(j) || (!i && !j) || riverCellUsable(i, j)) return null;
  const name = `${i},${j}`;
  if (cache.has(name)) return cache.get(name);
  const x = i * 16, z = j * 16, h = PARCEL_HALF;
  const bounds = { x0: x - h, x1: x + h, z0: z - h, z1: z + h };
  const obstacles = [-8, 8].map(dx => bridgeSpan(x + dx)).filter(Boolean).map(b => ({ x0: b.x0 - 0.36, x1: b.x1 + 0.36, z0: b.z0 - 0.36, z1: b.z1 + 0.36 })).filter(b => rectOverlap(bounds, b));
  const count = Math.ceil(2 * h / STEP), sections = Array.from({ length: count + 1 }, (_, n) => {
    const at = bounds.x0 + n * 2 * h / count; return { x: at, ...riverBoundsAtX(at, PARCEL_MARGIN + INSET) };
  });
  const sides = [-1, 1].map(side => {
    const edge = sections.map(s => ({ x: s.x, z: side < 0 ? s.min - INSET : s.max + INSET }));
    let polygon = [{ x: bounds.x0, z: side < 0 ? bounds.z0 : bounds.z1 }, ...edge, { x: bounds.x1, z: side < 0 ? bounds.z0 : bounds.z1 }];
    polygon = clipPolygon(clipPolygon(polygon, 'z', bounds.z0, true), 'z', bounds.z1, false);
    let polygons = polygonArea(polygon) > EPS ? [polygon] : [];
    for (const obstacle of obstacles) polygons = polygons.flatMap(p => subtractRect(p, obstacle));
    const dryArea = polygons.reduce((sum, p) => sum + polygonArea(p), 0);
    const rect = inscribedRectangle(bounds, edge, side, obstacles);
    const clear = rect && riverFootprintClear((rect.x0 + rect.x1) / 2, (rect.z0 + rect.z1) / 2, (rect.x1 - rect.x0) / 2, (rect.z1 - rect.z0) / 2, PARCEL_MARGIN);
    return { i, j, kind: 'riverfront', side, bounds, polygons, dryArea, rect, obstacles, eligible: Boolean(clear && parcelEligible(rect, dryArea)) };
  });
  const parcel = sides.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.dryArea - a.dryArea)[0];
  cache.set(name, parcel); return parcel;
}
