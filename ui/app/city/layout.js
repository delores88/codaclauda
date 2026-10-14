/* City layout: the lot grid, stable lot assignment and road-network walking routes.
 * Pure math (no three.js) so it stays cheap and predictable.
 *
 * Grid: lot (i, j) is centred at (i * PITCH, j * PITCH). Lot (0, 0) is the HQ plaza.
 * Roads run along every grid line x = (k + .5) * PITCH and z = (k + .5) * PITCH, so any
 * two road points are joined by a Manhattan route through road intersections ("nodes").
 * Sidewalks sit SIDEWALK units either side of each road centre line. */
import { hash } from '../avatar/spec.js';

export const PITCH = 16;            // distance between lot centres
export const ASPHALT = 3.0;         // drivable width
export const ROAD = 4.6;            // asphalt + both sidewalks
export const SIDEWALK = 1.95;       // sidewalk walking line, measured from a road centre line
export const LOT_HALF = (PITCH - ROAD) / 2;          // 5.7: usable half-size of a lot
export const WALK_HALF = PITCH / 2 - SIDEWALK;       // 6.05: sidewalk loop around a block
export const ISLAND_MARGIN = 5.5;   // grass rim outside the outer ring road
const SLOT_KEY = 'codaclauda.city.slots.v1';

/* ---------- spiral slots ---------- */
const spiral = [];
let spiralRings = 0;
function growSpiral(rings) {
  while (spiralRings < rings) {
    const r = ++spiralRings, ring = [];
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) if (Math.max(Math.abs(i), Math.abs(j)) === r) ring.push({ i, j, ring: r });
    // Start straight in front of the plaza (toward the default camera, +z) and go round.
    const angle = c => { const a = Math.atan2(c.i, c.j); return a < 0 ? a + Math.PI * 2 : a; };
    ring.sort((a, b) => angle(a) - angle(b) || a.i - b.i);
    spiral.push(...ring);
  }
}
growSpiral(6);
export function slotCell(slot) {
  while (slot >= spiral.length) growSpiral(spiralRings + 1);
  return spiral[slot];
}

/** Stable project → lot assignment. A project keeps its lot for as long as it exists
 * (remembered per viewer), new projects hash into the first ring and linearly probe
 * outward along the spiral, so adding a project never reshuffles the others. */
export class SlotMap {
  constructor() {
    this.memo = {};
    try { const saved = JSON.parse(localStorage.getItem(SLOT_KEY) || '{}'); if (saved && typeof saved === 'object') this.memo = saved; } catch { /* per-viewer convenience only */ }
  }
  save() {
    try {
      const entries = Object.entries(this.memo);
      if (entries.length > 400) this.memo = Object.fromEntries(entries.slice(-400));
      localStorage.setItem(SLOT_KEY, JSON.stringify(this.memo));
    } catch { /* storage unavailable */ }
  }
  /** projects → { cells: Map(id → {i, j, ring, slot}), rings } */
  assign(projects) {
    const cells = new Map(), taken = new Set(), fresh = [];
    const keep = projects.filter(p => Number.isInteger(this.memo[p.id]) || (fresh.push(p), false));
    keep.sort((a, b) => this.memo[a.id] - this.memo[b.id] || a.id.localeCompare(b.id));
    for (const p of keep) {
      const slot = this.memo[p.id];
      if (taken.has(slot)) { fresh.push(p); continue; }
      taken.add(slot); cells.set(p.id, { ...slotCell(slot), slot });
    }
    fresh.sort((a, b) => hash(a.id) - hash(b.id) || a.id.localeCompare(b.id));
    for (const p of fresh) {
      let slot = hash(p.id) % 8;
      while (taken.has(slot)) slot++;
      taken.add(slot); this.memo[p.id] = slot; cells.set(p.id, { ...slotCell(slot), slot });
    }
    if (fresh.length) this.save();
    let rings = 1;
    for (const c of cells.values()) rings = Math.max(rings, c.ring);
    return { cells, rings };
  }
}

/* ---------- geometry helpers ---------- */
export const cellKey = (i, j) => `${i},${j}`;
export const cellCenter = (i, j) => ({ x: i * PITCH, z: j * PITCH });
export const cellOf = (x, z) => ({ i: Math.round(x / PITCH), j: Math.round(z / PITCH) });
export const islandHalf = rings => (rings + 0.5) * PITCH + ISLAND_MARGIN;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const near = (a, b) => Math.abs(a - b) < 1e-3;

/** Point on the sidewalk loop of lot (i, j) at perimeter parameter t ∈ [0, 4). */
export function perimeterPoint(i, j, t) {
  const c = cellCenter(i, j), h = WALK_HALF;
  const corners = [[-h, h], [h, h], [h, -h], [-h, -h]];
  const k = Math.floor(((t % 4) + 4) % 4), f = (((t % 4) + 4) % 4) - k;
  const [ax, az] = corners[k], [bx, bz] = corners[(k + 1) % 4];
  return { x: c.x + ax + (bx - ax) * f, z: c.z + az + (bz - az) * f };
}
/** Closest perimeter parameter for a point (used to join a block's sidewalk loop). */
export function perimeterParam(i, j, p) {
  const c = cellCenter(i, j), h = WALK_HALF;
  const x = Math.max(-h, Math.min(h, p.x - c.x)), z = Math.max(-h, Math.min(h, p.z - c.z));
  const d = [Math.abs(z - h), Math.abs(x - h), Math.abs(z + h), Math.abs(x + h)];
  const side = d.indexOf(Math.min(...d));
  const f = side === 0 ? (x + h) / (2 * h) : side === 1 ? (h - z) / (2 * h) : side === 2 ? (h - x) / (2 * h) : (z + h) / (2 * h);
  return side + Math.max(0, Math.min(0.999, f));
}
/** Walk along a block's sidewalk loop from t0 to t1 (shorter way round). */
export function perimeterRoute(i, j, t0, t1) {
  let delta = ((t1 - t0) % 4 + 4) % 4;
  const dir = delta <= 2 ? 1 : -1;
  if (dir < 0) delta = 4 - delta;
  const points = [];
  let t = t0;
  while (delta > 1e-6) {
    const next = dir > 0 ? Math.floor(t + 1e-6) + 1 : Math.ceil(t - 1e-6) - 1;
    const step = Math.min(delta, Math.abs(next - t));
    t += dir * step; delta -= step;
    points.push(perimeterPoint(i, j, t));
  }
  return points;
}

/** Nearest road centre-line point from p; vert = road runs along z (constant x). */
export function exitToRoad(p) {
  const { i, j } = cellOf(p.x, p.z);
  const options = [
    { x: (i - 0.5) * PITCH, z: p.z, vert: true }, { x: (i + 0.5) * PITCH, z: p.z, vert: true },
    { x: p.x, z: (j - 0.5) * PITCH, vert: false }, { x: p.x, z: (j + 0.5) * PITCH, vert: false },
  ];
  return options.reduce((best, o) => (dist(o, p) < dist(best, p) ? o : best));
}
function nodesAround(p) {
  if (p.vert) { const k = Math.floor(p.z / PITCH - 0.5); return [{ x: p.x, z: (k + 0.5) * PITCH }, { x: p.x, z: (k + 1.5) * PITCH }]; }
  const k = Math.floor(p.x / PITCH - 0.5);
  return [{ x: (k + 0.5) * PITCH, z: p.z }, { x: (k + 1.5) * PITCH, z: p.z }];
}
/** Shortest Manhattan route between two road points through intersections. */
export function roadRoute(a, b) {
  if ((a.vert && b.vert && near(a.x, b.x)) || (!a.vert && !b.vert && near(a.z, b.z))) return [a, b];
  let best = null;
  for (const na of nodesAround(a)) for (const nb of nodesAround(b)) {
    for (const corner of [{ x: na.x, z: nb.z }, { x: nb.x, z: na.z }]) {
      const length = dist(a, na) + dist(na, corner) + dist(corner, nb) + dist(nb, b);
      if (!best || length < best.length) best = { length, points: [a, na, corner, nb, b] };
    }
  }
  return best.points;
}
function dedupe(points) {
  const out = [];
  for (const p of points) if (!out.length || dist(out.at(-1), p) > 0.05) out.push({ x: p.x, z: p.z });
  const last = points.at(-1);
  if (last && out.length) out[out.length - 1] = { x: last.x, z: last.z };   // always end exactly at the goal
  return out;
}

/** Walking route from `from` to `to` (both {x, z}). Stays on sidewalks: joins the
 * current block's loop, follows roads (sidewalk side picked by `lane` ±1 per axis),
 * then walks the target block's loop to the destination. */
export function planPath(from, to, lane = { x: 1, z: 1 }) {
  const fc = cellOf(from.x, from.z), tc = cellOf(to.x, to.z);
  if (fc.i === tc.i && fc.j === tc.j) {
    const t0 = perimeterParam(fc.i, fc.j, from), t1 = perimeterParam(tc.i, tc.j, to);
    const start = perimeterPoint(fc.i, fc.j, t0), end = perimeterPoint(tc.i, tc.j, t1);
    // Short hops inside a lot go straight; longer ones walk the block's sidewalk.
    if (dist(from, to) < 3.2) return dedupe([to]);
    return dedupe([start, ...perimeterRoute(fc.i, fc.j, t0, t1), end, to]);
  }
  const a = exitToRoad(from), b = exitToRoad(to);
  const route = roadRoute(a, b);
  // Entry/exit points sit on the near sidewalk of their own blocks; intersections use the lane's corner.
  const pull = (road, p) => road.vert ? { x: road.x + Math.sign(p.x - road.x || 1) * SIDEWALK, z: road.z } : { x: road.x, z: road.z + Math.sign(p.z - road.z || 1) * SIDEWALK };
  const middle = route.slice(1, -1).map(n => ({ x: n.x + lane.x * SIDEWALK, z: n.z + lane.z * SIDEWALK }));
  return dedupe([pull(a, from), ...middle, pull(b, to), to]);
}
