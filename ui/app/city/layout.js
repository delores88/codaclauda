/* City layout: the lot grid, stable lot assignment and road-network walking routes.
 * Pure math (no three.js) so it stays cheap and predictable.
 *
 * Grid: lot (i, j) is centred at (i * PITCH, j * PITCH). Lot (0, 0) is the HQ plaza.
 * Roads run along every grid line x = (k + .5) * PITCH and z = (k + .5) * PITCH, so any
 * two road points are joined by a Manhattan route through road intersections ("nodes").
 * Sidewalks sit SIDEWALK units either side of each road centre line. */
import { hash } from '../avatar/spec.js';
import { DISTRICTS, MIN_EMPTY_PLOTS, districtOf, districtForCell, districtCells, districtSlot, projectIds } from './districts.js';

export const PITCH = 16;            // distance between lot centres
export const ASPHALT = 3.0;         // drivable width
export const ROAD = 4.6;            // asphalt + both sidewalks
export const SIDEWALK = 1.95;       // sidewalk walking line, measured from a road centre line
export const LOT_HALF = (PITCH - ROAD) / 2;          // 5.7: usable half-size of a lot
export const WALK_HALF = PITCH / 2 - SIDEWALK;       // 6.05: sidewalk loop around a block
export const ISLAND_MARGIN = 5.5;   // grass rim outside the outer ring road
const LEGACY_CITY_SLOTS_STORAGE_NAME = 'codaclauda.city.slots.v1';   // 0.3 per-viewer memory; read once to migrate into pins
const MAX_PIN_RING = 24;

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

export const ringOf = (i, j) => Math.max(Math.abs(i), Math.abs(j));
/** A usable lot pin ({i, j} integers, not the HQ plaza, within reach) or null. */
export function cleanCell(value) {
  if (!value || typeof value !== 'object') return null;
  const i = Number(value.i), j = Number(value.j);
  if (!Number.isInteger(i) || !Number.isInteger(j) || (i === 0 && j === 0) || ringOf(i, j) > MAX_PIN_RING) return null;
  return { i, j };
}
/** The pin of a project under any of its ids (a project can be known as local:… and gh:…). */
export function pinOf(project, pins) {
  for (const id of projectIds(project)) { const cell = cleanCell(pins?.[id]); if (cell) return cell; }
  return null;
}

/** Stable project → lot assignment. Pins (store.cityLots, saved with the desktop state so a
 * layout survives other machines and reinstalls) are honoured first; a building that already
 * stands on a lot this session is never moved by automatic placement; everything else hashes
 * into the first ring and probes outward along the spiral, so adding a project never
 * reshuffles the others. assign() reports projects that got their first lot (`fresh`) so the
 * caller can pin them. */
export class SlotMap {
  constructor() {
    this.memo = new Map();   // project id → { i, j } placed this session
    this.rings = 1;
    this.legacy = {};
    try { const saved = JSON.parse(localStorage.getItem(LEGACY_CITY_SLOTS_STORAGE_NAME) || '{}'); if (saved && typeof saved === 'object') this.legacy = saved; } catch { /* nothing to migrate */ }
  }
  /** projects → { cells: Map(id → {i, j, ring}), rings, fresh: [{ id, i, j }], reserved: Map(cellKey → project) }
   *  pins: { [projectId]: {i, j} }; reserve: projects hidden from the city (their pinned lots stay free);
   *  hold: leave brand-new unpinned projects unplaced for now (a plot dialog is about to pin one). */
  assign(projects, options = {}) {
    return options.districts === false ? this.assignLegacy(projects, options) : this.assignDistricts(projects, options);
  }
  /** Home city: preserve safe matching pins and standing buildings, migrate other lots once.
   * `fresh` includes replacement pins with migrated:true; persist these even if a pin already
   * exists. `emptyPlots` excludes hidden reservations, and always has at least three per side.
   * Contributor islands use districts:false to retain their established compact layout. */
  assignDistricts(projects, { pins = {}, reserve = [], hold = false } = {}) {
    const cells = new Map(), taken = new Set(), fresh = [], reserved = new Map(), migrated = [], districts = new Map();
    const same = (a, b) => a && b && a.i === b.i && a.j === b.j;
    const memoOf = p => projectIds(p).map(id => this.memo.get(id)).find(Boolean) || null;
    const visible = new Set(projects.map(p => p.id));
    const info = [...projects.map(p => ({ p, hidden: false })), ...reserve.filter(p => !visible.has(p.id) && (pinOf(p, pins) || memoOf(p))).map(p => ({ p, hidden: true }))]
      .sort((a, b) => a.p.id.localeCompare(b.p.id)).map(x => {
        const district = districtOf(x.p), pin = pinOf(x.p, pins), mem = memoOf(x.p);
        return { ...x, district, oldPin: pin, oldMem: mem, pin: districtForCell(pin) === district ? pin : null, mem: districtForCell(mem) === district ? mem : null, done: false };
      });
    const claim = (x, c) => {
      const key = cellKey(c.i, c.j);
      if (taken.has(key) || districtForCell(c) !== x.district) return false;
      taken.add(key);
      const cell = { i: c.i, j: c.j, ring: ringOf(c.i, c.j) };
      if (x.hidden) reserved.set(key, x.p);
      else { cells.set(x.p.id, cell); districts.set(x.p.id, x.district); }
      for (const id of projectIds(x.p)) this.memo.set(id, cell);
      x.done = true;
      const previous = x.oldPin || x.oldMem;
      const moved = previous && !same(previous, cell);
      if (!x.oldPin || !same(x.oldPin, cell)) fresh.push({ id: x.p.id, i: c.i, j: c.j, ...(moved ? { migrated: true } : {}) });
      if (moved) migrated.push({ id: x.p.id, i: c.i, j: c.j, previous: { i: previous.i, j: previous.j } });
      return true;
    };
    // Standing buildings take priority. A deliberate, valid changed pin can still move one.
    for (const x of info) if (x.mem && (!x.pin || same(x.pin, x.mem))) claim(x, x.mem);
    for (const x of info) if (!x.done && x.pin) claim(x, x.pin);
    for (const x of info) if (!x.done && x.mem) claim(x, x.mem);
    // Migrate only usable legacy slots, keeping the new district boundary clear.
    for (const x of info) {
      const legacy = this.legacy[x.p.id];
      if (x.done || !Number.isInteger(legacy) || legacy < 0 || legacy >= (MAX_PIN_RING * 2 + 1) ** 2 - 1) continue;
      const c = slotCell(legacy);
      if (districtForCell(c) === x.district) claim(x, c);
    }
    const rest = info.filter(x => !x.done && !(hold && !x.oldPin && !x.oldMem)).sort((a, b) => hash(a.p.id) - hash(b.p.id) || a.p.id.localeCompare(b.p.id));
    for (const x of rest) {
      let firstRing = 1, initial = districtCells(firstRing, x.district).length;
      while (!initial) initial = districtCells(++firstRing, x.district).length;
      const start = hash(x.p.id) % initial;
      let slot = 0;
      while (!claim(x, districtSlot(slot < initial ? (slot + start) % initial : slot, x.district))) slot++;
    }
    let rings = this.rings;
    for (const c of cells.values()) rings = Math.max(rings, c.ring);
    for (const x of info) if (x.done) { const c = this.memo.get(x.p.id); rings = Math.max(rings, c.ring); }
    const free = district => districtCells(rings, district).filter(c => !taken.has(cellKey(c.i, c.j)));
    while (DISTRICTS.some(district => free(district).length < MIN_EMPTY_PLOTS)) rings++;
    this.rings = rings;
    const emptyPlots = Object.fromEntries(DISTRICTS.map(district => [district, free(district)]));
    return { cells, rings, fresh, reserved, districts, emptyPlots, migrated };
  }
  assignLegacy(projects, { pins = {}, reserve = [], hold = false } = {}) {
    const cells = new Map(), taken = new Set(), fresh = [], reserved = new Map();
    for (const p of reserve) { const c = pinOf(p, pins) || this.memo.get(p.id); if (c) reserved.set(cellKey(c.i, c.j), p); }
    const claim = (x, c) => {
      const key = cellKey(c.i, c.j);
      if (taken.has(key)) return false;
      taken.add(key);
      const cell = { i: c.i, j: c.j, ring: ringOf(c.i, c.j) };
      cells.set(x.p.id, cell); this.memo.set(x.p.id, cell); x.done = true;
      if (!x.pin) fresh.push({ id: x.p.id, i: c.i, j: c.j });
      return true;
    };
    const same = (a, b) => a && b && a.i === b.i && a.j === b.j;
    const info = [...projects].sort((a, b) => a.id.localeCompare(b.id)).map(p => ({ p, pin: pinOf(p, pins), mem: this.memo.get(p.id) || null, done: false }));
    // 1. Standing buildings stay put (a pin that matches, or no pin yet).
    for (const x of info) if (x.mem && (!x.pin || same(x.pin, x.mem))) claim(x, x.mem);
    // 2. Pins: plots chosen in the New Project dialog, or a layout saved earlier / elsewhere.
    for (const x of info) if (!x.done && x.pin) claim(x, x.pin);
    // 3. A re-pinned building whose plot is taken keeps its old lot.
    for (const x of info) if (!x.done && x.mem) claim(x, x.mem);
    // 4. One-time migration of the 0.3 per-viewer layout.
    for (const x of info) {
      if (x.done || !Number.isInteger(this.legacy[x.p.id])) continue;
      const c = slotCell(this.legacy[x.p.id]);
      if (!reserved.has(cellKey(c.i, c.j))) claim(x, c);
    }
    // 5. Everything else hashes into the first ring and probes outward.
    const rest = info.filter(x => !x.done && !(hold && !x.pin)).sort((a, b) => hash(a.p.id) - hash(b.p.id) || a.p.id.localeCompare(b.p.id));
    for (const x of rest) {
      let slot = hash(x.p.id) % 8;
      for (;;) { const c = slotCell(slot); if (!taken.has(cellKey(c.i, c.j)) && !reserved.has(cellKey(c.i, c.j))) { claim(x, c); break; } slot++; }
    }
    for (const key of taken) reserved.delete(key);
    let rings = 1;
    for (const c of cells.values()) rings = Math.max(rings, c.ring);
    return { cells, rings, fresh, reserved };
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
