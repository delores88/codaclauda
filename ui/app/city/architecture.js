/* Building variety for the City: Downtown tower silhouettes, palettes, window
 * styles and roof features, plus polygon helpers for plot-shaped riverfront
 * buildings. Every choice is a stable hash of the project id and its lot, so a
 * building never changes look on refresh or rename. Edge-neighbouring lots differ
 * in (i + j) parity and draw from disjoint silhouette sets, so neighbours never
 * share a silhouette. Pure data and geometry helpers; no scene state. */
import { THREE } from './toon.js';
import { hash } from '../avatar/spec.js';

export const GF = 2.6, FH = 1.3;   // mirrors buildings.js floor heights

export const TOWER_SILHOUETTES = ['slab', 'twin', 'l-shape', 'setback', 'rounded', 'crown'];
const SILHOUETTE_SETS = [['slab', 'twin', 'l-shape'], ['setback', 'rounded', 'crown']];
export const TOWER_PALETTES = [
  { name: 'blue-glass', body: '#92bbd4', trim: '#d6e6ef', roof: '#b9ccd9', plinth: '#526a7b', accent: '#3f7fb5', door: '#314b61' },
  { name: 'teal-glass', body: '#8fcac3', trim: '#e2f2ef', roof: '#b4d9d3', plinth: '#3f6b66', accent: '#2f8f86', door: '#24514d' },
  { name: 'silver', body: '#dfe4ea', trim: '#8f9aa6', roof: '#c6ced6', plinth: '#5b6672', accent: '#5b7fa3', door: '#3d4856' },
  { name: 'smoked-copper', body: '#56677a', trim: '#c98a5a', roof: '#73808c', plinth: '#3a4450', accent: '#c98a5a', door: '#2b333d' },
  { name: 'sandstone', body: '#e3d3b5', trim: '#b49770', roof: '#cfbd99', plinth: '#8a7457', accent: '#5f93b8', door: '#4c3f30' },
];
export const WINDOW_STYLES = {
  grid: { w: 0.94, h: 0.98, spacing: 1.08 },
  bands: { w: 1.16, h: 0.62, spacing: 1.2 },
  fins: { w: 0.4, h: 1.08, spacing: 0.62 },
};
export const ROOF_FEATURES = ['garden', 'helipad', 'spire', 'tank', 'solar', 'cap'];

export const lotParity = cell => (((cell?.i || 0) + (cell?.j || 0)) % 2 + 2) % 2;
const pick = (list, key) => list[hash(key) % list.length];

/** The stable look of a Downtown building on a lot. */
export function towerLook(project, cell) {
  const id = String(project?.id || ''), lot = `${cell?.i || 0},${cell?.j || 0}`;
  return {
    silhouette: pick(SILHOUETTE_SETS[lotParity(cell)], `tower:${id}:${lot}`),
    palette: pick(TOWER_PALETTES, `palette:${id}`),
    windows: pick(Object.keys(WINDOW_STYLES), `windows:${id}`),
    roof: pick(ROOF_FEATURES, `roof:${id}`),
  };
}

/** Height of `floors` floors from the ground (ground floor taller). */
export const floorsHeight = n => n <= 0 ? 0 : GF + (n - 1) * FH;
/** Floor count whose height is closest to h (at least 1). */
const floorsFor = h => Math.max(1, Math.round((h - GF) / FH) + 1);

/** Blocks for a tower of size { W, D, H, floors } and a silhouette. Each block is
 * { w, d, h, x, z, y, floor0, floors, rounded? } with y the base above the pad;
 * `floor0` is the index of its first floor so windows line up across blocks. */
export function towerBlocks(size, silhouette) {
  const { W, D, H, floors } = size;
  const blocks = [];
  const add = (w, d, x, z, floor0, count, extra = {}) => {
    const y = floorsHeight(floor0), h = floorsHeight(floor0 + count) - y;
    blocks.push({ w, d, x, z, y, h, floor0, floors: count, ...extra }); return blocks.at(-1);
  };
  if (silhouette === 'setback' && floors >= 2) {
    const tiers = floors >= 6 ? 3 : 2;
    const cuts = tiers === 3 ? [Math.max(1, Math.round(floors * 0.5)), Math.max(2, Math.round(floors * 0.8))] : [Math.max(1, floors - Math.max(1, Math.round(floors * 0.35)))];
    const edges = [0, ...cuts.filter((c, k, a) => c > (a[k - 1] || 0) && c < floors), floors];
    for (let k = 0; k < edges.length - 1; k++) {
      const s = 1 - k * 0.2;
      add(W * s, D * s, 0, -D * 0.09 * k, edges[k], edges[k + 1] - edges[k]);
    }
  } else if (silhouette === 'twin' && floors >= 2) {
    add(W, D, 0, 0, 0, 1, { podium: true });
    const upper = floors - 1, short = Math.max(1, Math.round(upper * 0.72));
    add(W * 0.38, D * 0.68, W * 0.26, -D * 0.1, 1, upper);
    add(W * 0.38, D * 0.68, -W * 0.26, -D * 0.1, 1, short);
  } else if (silhouette === 'l-shape') {
    const wing = Math.max(1, Math.min(floors, Math.round(floors * 0.55)));
    add(W, D * 0.52, 0, -D * 0.24, 0, floors);
    add(W * 0.46, D * 0.5, -W * 0.27, D * 0.25, 0, wing, { wing: true });
  } else if (silhouette === 'rounded') {
    add(W, D, 0, 0, 0, floors, { rounded: Math.min(W, D) * 0.3 });
  } else {
    add(W, D, 0, 0, 0, floors);
  }
  // Highest block carries the roof feature, ticker and CI beacon.
  const top = blocks.reduce((a, b) => b.y + b.h > a.y + a.h + 1e-6 ? b : a);
  // Entrance: the frontmost ground block covering the centre line (or the wing).
  const ground = blocks.filter(b => b.y === 0);
  const entryBlock = ground.find(b => b.wing) || ground.reduce((a, b) => b.z + b.d / 2 > a.z + a.d / 2 ? b : a);
  const entry = { x: entryBlock.x, z: entryBlock.z + entryBlock.d / 2, w: entryBlock.w, block: entryBlock };
  return { blocks, top, entry, H: Math.max(...blocks.map(b => b.y + b.h)) };
}

/* ---------- polygons (x/z island or local coordinates) ---------- */
export function signedArea(points) {
  let s = 0;
  for (let i = 0; i < points.length; i++) { const p = points[i], q = points[(i + 1) % points.length]; s += p.x * q.z - q.x * p.z; }
  return s / 2;
}
/** Offset a simple polygon outward (d > 0) or inward (d < 0) by about d. */
export function offsetPolygon(points, d) {
  const n = points.length, ccw = signedArea(points) > 0;
  const normal = (a, b) => {
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    // Outward normal: for positive signed area (counter-clockwise in x/z) it is (dz, -dx).
    return ccw ? { x: dz / len, z: -dx / len } : { x: -dz / len, z: dx / len };
  };
  return points.map((p, i) => {
    const a = normal(points[(i - 1 + n) % n], p), b = normal(p, points[(i + 1) % n]);
    let nx = a.x + b.x, nz = a.z + b.z; const len = Math.hypot(nx, nz) || 1; nx /= len; nz /= len;
    const cos = Math.max(0.35, nx * b.x + nz * b.z);
    return { x: p.x + nx * d / cos, z: p.z + nz * d / cos };
  });
}
/** Vertical prism over a polygon from y0 to y0 + h. */
export function prismGeometry(points, y0, h) {
  const shape = new THREE.Shape(points.map(p => new THREE.Vector2(p.x, -p.z)));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1, steps: 1 });
  geometry.rotateX(-Math.PI / 2); geometry.translate(0, y0, 0);
  return geometry;
}
/** Rectangle w by d centred at (x, z) with vertical corners rounded by r. */
export function roundedRectPoints(w, d, r, x = 0, z = 0, seg = 5) {
  r = Math.max(0, Math.min(r, w / 2 - 0.01, d / 2 - 0.01));
  const points = [];
  for (const [cx, cz, a0] of [[w / 2 - r, d / 2 - r, 0], [-w / 2 + r, d / 2 - r, Math.PI / 2], [-w / 2 + r, -d / 2 + r, Math.PI], [w / 2 - r, -d / 2 + r, Math.PI * 1.5]]) {
    for (let k = 0; k <= seg; k++) { const a = a0 + (k / seg) * Math.PI / 2; points.push({ x: x + cx + Math.cos(a) * r, z: z + cz + Math.sin(a) * r }); }
  }
  return points;
}
/** A band of width w along an open polyline (ordered points), as a polygon. */
export function stripPolygon(line, w, toward) {
  const inner = line.map(p => ({ x: p.x + toward.x * w, z: p.z + toward.z * w }));
  return [...line, ...inner.reverse()];
}
