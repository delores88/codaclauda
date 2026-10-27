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

/** Maximal frontage rectangle for a sampled river boundary, with exact bridge cuts.
 * Between knots the boundary is linear: its extrema occur at the enumerated knots.
 * All x pairs are considered, not just a centred footprint or the parcel's corners. */
export function inscribedRectangle(bounds, edge, side, obstacles = []) {
  let best = null, area = 0;
  const xs = [...new Set([...edge.map(p => p.x), ...obstacles.flatMap(r => [r.x0, r.x1]).filter(x => x > bounds.x0 && x < bounds.x1)])].sort((a, b) => a - b);
  const edgeAt = x => {
    const n = edge.findIndex(p => p.x >= x);
    if (n <= 0) return edge[0].z;
    const a = edge[n - 1], b = edge[n]; return a.z + (b.z - a.z) * (x - a.x) / (b.x - a.x);
  };
  for (let a = 0; a < xs.length - 1; a++) {
    let boundary = edgeAt(xs[a]);
    for (let b = a + 1; b < xs.length; b++) {
      boundary = side > 0 ? Math.max(boundary, edgeAt(xs[b])) : Math.min(boundary, edgeAt(xs[b]));
      const r = { x0: xs[a], x1: xs[b], z0: side > 0 ? Math.max(bounds.z0, boundary) : bounds.z0, z1: side < 0 ? Math.min(bounds.z1, boundary) : bounds.z1 };
      for (const obstacle of obstacles) if (rectOverlap(r, obstacle)) {
        if (side > 0) r.z0 = Math.max(r.z0, obstacle.z1); else r.z1 = Math.min(r.z1, obstacle.z0);
      }
      const value = rectArea(r);
      if (value > area + EPS) { best = r; area = value; }
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
