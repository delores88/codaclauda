/* Fixed Catmull-Rom river. Shared tube sections align banks, terrain, placement
 * and walking. Expansion clips a longer piece; it never changes the interior. */
export const RIVER_GRID_PITCH = 16;
export const RIVER_CENTER_Z = -26;
export const RIVER_AMPLITUDE = 9.6;
export const RIVER_HALF_WIDTH = 5.5;
export const RIVER_BANK_WIDTH = 0.8;
export const WATER_Y = -0.76;
export const RIVER_LOT_HALF = 6.5;
export const RIVER_LOT_MARGIN = 1;
export const BRIDGE_HALF_WIDTH = 2.3;
export const BRIDGE_GROUND_Y = 0.14;
export const BRIDGE_DECK_Y = 1.7;
export const BRIDGE_CLEAR_Y = 1.6;
export const BRIDGE_RAMP_LENGTH = 5;
const CORE_START = -48, CORE_END = 80, KNOT_STEP = 16, BASE_SLOPE = 0.6;
const SAMPLE_STEP = 0.5, CURVE_ERROR = 0.01, EPS = 1e-8;
const offsets = [0, 1, 0, -1, 0, 1, 0, -1, 0];
export const RIVER_CONTROL_POINTS = Object.freeze(offsets.map((offset, index) => {
  const x = CORE_START + index * KNOT_STEP;
  return Object.freeze({ x, z: BASE_SLOPE * x + RIVER_CENTER_Z + offset * RIVER_AMPLITUDE });
}));
export function catmullRom(p0, p1, p2, p3, t) {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}
const coefficients = offsets.slice(0, -1).map((_, index) => {
  // Mirrored residual controls give straight diagonal tangents at the ends.
  const [p0, p1, p2, p3] = [index - 1, index, index + 1, index + 2].map(i => {
    const residual = i < 0 ? offsets[1] : i >= offsets.length ? offsets.at(-2) : offsets[i];
    return BASE_SLOPE * (CORE_START + i * KNOT_STEP) + RIVER_CENTER_Z + residual * RIVER_AMPLITUDE;
  });
  return [p1, (p2 - p0) / 2, (2 * p0 - 5 * p1 + 4 * p2 - p3) / 2, (3 * (p1 - p2) + p3 - p0) / 2];
});
function segmentAt(x) {
  const index = Math.min(coefficients.length - 1, Math.max(0, Math.floor((x - CORE_START) / KNOT_STEP)));
  return { c: coefficients[index], t: (x - CORE_START - index * KNOT_STEP) / KNOT_STEP };
}
export function riverZ(x) {
  if (!Number.isFinite(x)) return NaN;
  if (x <= CORE_START || x >= CORE_END) return BASE_SLOPE * x + RIVER_CENTER_Z;
  const { c, t } = segmentAt(x); return c[0] + t * (c[1] + t * (c[2] + t * c[3]));
}
export function riverSlope(x) {
  if (!Number.isFinite(x)) return NaN;
  if (x <= CORE_START || x >= CORE_END) return BASE_SLOPE;
  const { c, t } = segmentAt(x); return (c[1] + t * (2 * c[2] + t * 3 * c[3])) / KNOT_STEP;
}
export function riverFrame(x) {
  const slope = riverSlope(x), length = Math.hypot(1, slope), tx = 1 / length, tz = slope / length;
  return { x, z: riverZ(x), slope, tx, tz, nx: -tz, nz: tx, tangent: { x: tx, z: tz }, normal: { x: -tz, z: tx } };
}
export const riverSide = (x, z) => z < riverZ(x) ? -1 : 1;

/** Exact cubic extrema include local reversals between control points. */
export function riverRange(minX, maxX) {
  if (![minX, maxX].every(Number.isFinite)) return null;
  if (minX > maxX) [minX, maxX] = [maxX, minX];
  const values = [riverZ(minX), riverZ(maxX)];
  coefficients.forEach((c, index) => {
    const start = CORE_START + index * KNOT_STEP, low = Math.max(0, (minX - start) / KNOT_STEP), high = Math.min(1, (maxX - start) / KNOT_STEP);
    if (low > high) return;
    const roots = [], a = 3 * c[3], b = 2 * c[2], d = c[1];
    if (Math.abs(a) < EPS) { if (Math.abs(b) > EPS) roots.push(-d / b); }
    else { const discriminant = b * b - 4 * a * d; if (discriminant >= 0) roots.push((-b - Math.sqrt(discriminant)) / (2 * a), (-b + Math.sqrt(discriminant)) / (2 * a)); }
    for (const t of [low, high, ...roots]) if (t >= low && t <= high) values.push(c[0] + t * (c[1] + t * (c[2] + t * c[3])));
  });
  return { min: Math.min(...values), max: Math.max(...values) };
}
const core = Array.from({ length: (CORE_END - CORE_START) / SAMPLE_STEP + 1 }, (_, n) => {
  const x = CORE_START + n * SAMPLE_STEP; return Object.freeze({ x, z: riverZ(x) });
});
function pointsBetween(minX, maxX) {
  const points = [{ x: minX, z: riverZ(minX) }];
  const start = Math.max(0, Math.floor((minX - CORE_START) / SAMPLE_STEP) + 1), end = Math.min(core.length - 1, Math.ceil((maxX - CORE_START) / SAMPLE_STEP) - 1);
  for (let i = start; i <= end; i++) points.push(core[i]);
  points.push({ x: maxX, z: riverZ(maxX) }); return points;
}
function pointSegmentDistance(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, denominator = dx * dx + dz * dz;
  const t = denominator ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / denominator)) : 0;
  return Math.hypot(x - a.x - t * dx, z - a.z - t * dz);
}
export function riverDistance(x, z, limit = Infinity) {
  if (![x, z].every(Number.isFinite)) return Infinity;
  const vertical = Math.abs(z - riverZ(x));
  // Every cubic slope is below 2; this Lipschitz lower bound cheaply rejects
  // distant land without walking any centerline segments.
  if (vertical > limit * Math.sqrt(5)) return vertical / Math.sqrt(5);
  const reach = Math.min(vertical, limit) + 1, points = pointsBetween(x - reach, x + reach);
  let distance = vertical;
  for (let n = 1; n < points.length; n++) distance = Math.min(distance, pointSegmentDistance(x, z, points[n - 1], points[n]));
  return distance;
}
export function riverContains(x, z, margin = 0) {
  if (![x, z, margin].every(Number.isFinite)) return false;
  const radius = RIVER_HALF_WIDTH + Math.max(0, margin);
  return riverDistance(x, z, radius) <= radius + EPS;
}
function mergeIntervals(intervals) {
  const merged = [];
  for (const interval of intervals.sort((a, b) => a.min - b.min)) {
    const previous = merged.at(-1);
    if (previous && interval.min <= previous.max + EPS) previous.max = Math.max(previous.max, interval.max);
    else merged.push({ ...interval });
  }
  return merged;
}
function capsuleSection(a, b, line, axis, radius) {
  const uv = p => axis === 'z' ? { u: p.z, v: p.x } : { u: p.x, v: p.z };
  const p = uv(a), q = uv(b), values = [];
  for (const end of [p, q]) if (Math.abs(line - end.v) <= radius) {
    const half = Math.sqrt(Math.max(0, radius * radius - (line - end.v) ** 2)); values.push(end.u - half, end.u + half);
  }
  const du = q.u - p.u, dv = q.v - p.v, length = Math.hypot(du, dv);
  if (length > EPS) {
    const nu = -dv / length * radius, nv = du / length * radius;
    const corners = [{ u: p.u + nu, v: p.v + nv }, { u: q.u + nu, v: q.v + nv }, { u: q.u - nu, v: q.v - nv }, { u: p.u - nu, v: p.v - nv }];
    for (let n = 0; n < 4; n++) {
      const a = corners[n], b = corners[(n + 1) % 4];
      if (line < Math.min(a.v, b.v) - EPS || line > Math.max(a.v, b.v) + EPS) continue;
      if (Math.abs(b.v - a.v) < EPS) values.push(a.u, b.u);
      else values.push(a.u + (b.u - a.u) * (line - a.v) / (b.v - a.v));
    }
  }
  return values.length ? { min: Math.min(...values), max: Math.max(...values) } : null;
}
/** axis means road travel. margin adds distance beyond water: 0=water, default=bank. */
export function riverRoadIntervals(axis, line, margin = RIVER_BANK_WIDTH) {
  if (!['x', 'z'].includes(axis) || ![line, margin].every(Number.isFinite) || margin < 0) return [];
  const radius = RIVER_HALF_WIDTH + margin;
  const minX = axis === 'z' ? line - radius - 1 : Math.min(CORE_START, (line - radius - RIVER_CENTER_Z) / BASE_SLOPE) - radius - 1;
  const maxX = axis === 'z' ? line + radius + 1 : Math.max(CORE_END, (line + radius - RIVER_CENTER_Z) / BASE_SLOPE) + radius + 1;
  const points = pointsBetween(minX, maxX), intervals = [];
  for (let n = 1; n < points.length; n++) { const section = capsuleSection(points[n - 1], points[n], line, axis, radius); if (section) intervals.push(section); }
  return mergeIntervals(intervals);
}
export function riverRoadInterval(axis, line, margin = RIVER_BANK_WIDTH) {
  const intervals = riverRoadIntervals(axis, line, margin);
  return intervals.length ? { min: intervals[0].min, max: intervals.at(-1).max } : null;
}
export const riverBoundsAtX = (x, margin = RIVER_BANK_WIDTH) => riverRoadInterval('z', x, margin);
export function riverSection(x) {
  const water = riverBoundsAtX(x, 0), bank = riverBoundsAtX(x);
  return { waterMinZ: water.min, waterMaxZ: water.max, bankMinZ: bank.min, bankMaxZ: bank.max };
}
export function riverBankPoint(x, side, margin = 0.65) {
  const edge = riverBoundsAtX(x, RIVER_BANK_WIDTH + margin);
  return { x, z: side < 0 ? edge.min : edge.max };
}
function segmentRectDistance(a, b, rect) {
  let enter = 0, leave = 1;
  for (const [start, delta, min, max] of [[a.x, b.x - a.x, rect.x0, rect.x1], [a.z, b.z - a.z, rect.z0, rect.z1]]) {
    if (Math.abs(delta) < EPS) { if (start < min || start > max) { enter = 2; break; } }
    else { const t0 = (min - start) / delta, t1 = (max - start) / delta; enter = Math.max(enter, Math.min(t0, t1)); leave = Math.min(leave, Math.max(t0, t1)); }
  }
  if (enter <= leave && leave >= 0 && enter <= 1) return 0;
  const toRect = p => Math.hypot(Math.max(rect.x0 - p.x, 0, p.x - rect.x1), Math.max(rect.z0 - p.z, 0, p.z - rect.z1));
  let distance = Math.min(toRect(a), toRect(b));
  for (const x of [rect.x0, rect.x1]) for (const z of [rect.z0, rect.z1]) distance = Math.min(distance, pointSegmentDistance(x, z, a, b));
  return distance;
}
export function riverFootprintClear(x, z, halfX = 0, halfZ = halfX, margin = RIVER_BANK_WIDTH) {
  if (![x, z, halfX, halfZ, margin].every(Number.isFinite) || Math.min(halfX, halfZ, margin) < 0) return false;
  const radius = RIVER_HALF_WIDTH + margin + CURVE_ERROR, rect = { x0: x - halfX, x1: x + halfX, z0: z - halfZ, z1: z + halfZ };
  const range = riverRange(rect.x0 - radius, rect.x1 + radius);
  if (rect.z1 < range.min - radius || rect.z0 > range.max + radius) return true;
  const points = pointsBetween(rect.x0 - radius - 1, rect.x1 + radius + 1);
  for (let n = 1; n < points.length; n++) if (segmentRectDistance(points[n - 1], points[n], rect) <= radius) return false;
  return true;
}
const usableCells = new Map();
export function riverCellUsable(i, j) {
  if (!Number.isInteger(i) || !Number.isInteger(j)) return false;
  const name = `${i},${j}`;
  if (!usableCells.has(name)) usableCells.set(name, riverFootprintClear(i * RIVER_GRID_PITCH, j * RIVER_GRID_PITCH, RIVER_LOT_HALF + RIVER_LOT_MARGIN));
  return usableCells.get(name);
}
/** Centerline endpoints lie on the island rim, without moving any control point. */
export function sampleRiver(half, step = 1) {
  if (!Number.isFinite(half) || half <= 0) return [];
  const samples = pointsBetween(-half, half), clipped = [];
  for (let n = 1; n < samples.length; n++) {
    const a = samples[n - 1], b = samples[n]; let lo = 0, hi = 1;
    for (const [v, delta] of [[a.x, b.x - a.x], [a.z, b.z - a.z]]) {
      if (Math.abs(delta) < EPS) { if (v < -half || v > half) { lo = 2; break; } }
      else { const t0 = (-half - v) / delta, t1 = (half - v) / delta; lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1)); }
    }
    if (lo > hi || hi < 0 || lo > 1) continue;
    const start = { x: a.x + (b.x - a.x) * lo, z: a.z + (b.z - a.z) * lo }, end = { x: a.x + (b.x - a.x) * hi, z: a.z + (b.z - a.z) * hi };
    if (!clipped.length) clipped.push(start);
    const count = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.z - start.z) / Math.max(0.1, Number(step) || 1)));
    for (let k = 1; k <= count; k++) clipped.push({ x: start.x + (end.x - start.x) * k / count, z: start.z + (end.z - start.z) * k / count });
  }
  return clipped;
}
function makeSpan(axis, line, interval, index = 0) {
  const center = (interval.min + interval.max) / 2;
  const foot = riverRoadIntervals(axis, line, RIVER_BANK_WIDTH + BRIDGE_RAMP_LENGTH + BRIDGE_HALF_WIDTH).find(range => range.min <= center && range.max >= center);
  const min = foot?.min ?? interval.min - 20, max = foot?.max ?? interval.max + 20;
  const span = { id: `${axis}:${line}:${index}`, axis, x: axis === 'z' ? line : center, z: axis === 'x' ? line : center,
    min, max, deckMin: interval.min, deckMax: interval.max, halfWidth: BRIDGE_HALF_WIDTH, groundY: BRIDGE_GROUND_Y, deckY: BRIDGE_DECK_Y,
    x0: axis === 'z' ? line - BRIDGE_HALF_WIDTH : min, x1: axis === 'z' ? line + BRIDGE_HALF_WIDTH : max,
    z0: axis === 'x' ? line - BRIDGE_HALF_WIDTH : min, z1: axis === 'x' ? line + BRIDGE_HALF_WIDTH : max };
  if (axis === 'z') Object.assign(span, { centerZ: center, minZ: min, maxZ: max, deckMinZ: span.deckMin, deckMaxZ: span.deckMax });
  return span;
}
const spanCache = new Map();
export function bridgeSpan(crossing) {
  if (crossing && typeof crossing === 'object' && Number.isFinite(crossing.min) && Number.isFinite(crossing.max)) return crossing;
  const axis = typeof crossing === 'number' ? 'z' : crossing?.axis, line = typeof crossing === 'number' ? crossing : axis === 'z' ? crossing?.x : crossing?.z;
  if (!['x', 'z'].includes(axis) || !Number.isFinite(line)) return null;
  const name = `${axis}:${line}`;
  if (spanCache.has(name)) return spanCache.get(name);
  const intervals = riverRoadIntervals(axis, line, RIVER_BANK_WIDTH + BRIDGE_HALF_WIDTH);
  const span = intervals.length ? makeSpan(axis, line, intervals[0]) : null;
  spanCache.set(name, span); return span;
}
export function bridgeCrossings(half) {
  if (!Number.isFinite(half) || half <= 0) return [];
  const output = [], first = Math.ceil(-half / RIVER_GRID_PITCH - 0.5), last = Math.floor(half / RIVER_GRID_PITCH - 0.5);
  for (const axis of ['x', 'z']) for (let k = first; k <= last; k++) {
    const line = (k + 0.5) * RIVER_GRID_PITCH, feet = riverRoadIntervals(axis, line, RIVER_BANK_WIDTH + BRIDGE_RAMP_LENGTH + BRIDGE_HALF_WIDTH);
    const deckIntervals = riverRoadIntervals(axis, line, RIVER_BANK_WIDTH + BRIDGE_HALF_WIDTH);
    feet.forEach((foot, index) => {
      const decks = deckIntervals.filter(d => d.min <= foot.max && d.max >= foot.min);
      if (!decks.length) return;
      const span = makeSpan(axis, line, { min: decks[0].min, max: decks.at(-1).max }, index);
      span.islandHalf = half;
      // Edge outlets have no bridge until both approaches have supporting land.
      if (span.x0 >= -half && span.x1 <= half && span.z0 >= -half && span.z1 <= half) output.push(span);
    });
  }
  return output;
}
function candidatesAt(x, z, crossings) {
  if (Array.isArray(crossings)) return crossings;
  const line = value => (Math.round(value / RIVER_GRID_PITCH - 0.5) + 0.5) * RIVER_GRID_PITCH;
  return [bridgeSpan(line(x)), bridgeSpan({ axis: 'x', z: line(z) })].filter(Boolean);
}
export function bridgeAt(x, z, crossings = null) {
  if (![x, z].every(Number.isFinite)) return null;
  for (const crossing of candidatesAt(x, z, crossings)) {
    const b = bridgeSpan(crossing);
    if (b && x >= b.x0 - EPS && x <= b.x1 + EPS && z >= b.z0 - EPS && z <= b.z1 + EPS) return b;
  }
  return null;
}
/** The shared profile joins perpendicular road bridges at identical heights. */
export function bridgeProfileHeight(x, z) {
  const corridor = RIVER_HALF_WIDTH + RIVER_BANK_WIDTH, distance = riverDistance(x, z, corridor + BRIDGE_RAMP_LENGTH + 1);
  if (distance <= corridor) return BRIDGE_CLEAR_Y + (BRIDGE_DECK_Y - BRIDGE_CLEAR_Y) * (1 - distance / corridor) ** 2;
  const t = Math.max(0, Math.min(1, (distance - corridor) / BRIDGE_RAMP_LENGTH)), smooth = t * t * (3 - 2 * t);
  return BRIDGE_GROUND_Y + (BRIDGE_CLEAR_Y - BRIDGE_GROUND_Y) * (1 - smooth);
}
export function bridgeHeight(x, z, crossings = null) {
  return bridgeAt(x, z, crossings) ? bridgeProfileHeight(x, z) : null;
}
