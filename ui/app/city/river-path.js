/* Fixed world-coordinate river and bridge geometry. Pure; shared by placement,
 * scenery, navigation and the renderer so city growth never changes a shoreline. */
export const RIVER_CENTER_Z = -8;
export const RIVER_AMPLITUDE = 2.5;
export const RIVER_WAVELENGTH = 17; // cosine's x scale, not its full period
export const RIVER_HALF_WIDTH = 2.2;
export const RIVER_BANK_WIDTH = 0.6;
export const WATER_Y = 0.18;
export const RIVER_LOT_HALF = 6.5; // entire lot plus sidewalk, up to the road edge
export const RIVER_GRID_PITCH = 16;
export const BRIDGE_HALF_WIDTH = 2.3;
export const BRIDGE_DECK_Y = 1.95;
export const BRIDGE_GROUND_Y = 0.14;
export const BRIDGE_RAMP_LENGTH = 4.2;
const EDGE_EPSILON = 1e-8;

export const riverZ = x => RIVER_CENTER_Z - RIVER_AMPLITUDE * Math.cos(x / RIVER_WAVELENGTH);
export const riverSlope = x => RIVER_AMPLITUDE / RIVER_WAVELENGTH * Math.sin(x / RIVER_WAVELENGTH);

/** Exact extrema across an x interval, including cosine extrema between endpoints. */
export function riverRange(minX, maxX) {
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
  if (minX > maxX) [minX, maxX] = [maxX, minX];
  let min = Math.min(riverZ(minX), riverZ(maxX)), max = Math.max(riverZ(minX), riverZ(maxX));
  const step = Math.PI * RIVER_WAVELENGTH;
  const first = Math.ceil(minX / step), last = Math.floor(maxX / step);
  if (last >= first) {
    // Two consecutive extrema contain both limits, regardless of interval size.
    if (last > first) { min = RIVER_CENTER_Z - RIVER_AMPLITUDE; max = RIVER_CENTER_Z + RIVER_AMPLITUDE; }
    else if (Math.abs(first % 2) === 0) min = RIVER_CENTER_Z - RIVER_AMPLITUDE;
    else max = RIVER_CENTER_Z + RIVER_AMPLITUDE;
  }
  return { min, max };
}

/** Water test; add RIVER_BANK_WIDTH as margin to include the full river corridor. */
export function riverContains(x, z, margin = 0) {
  if (![x, z, margin].every(Number.isFinite)) return false;
  return Math.abs(z - riverZ(x)) <= RIVER_HALF_WIDTH + Math.max(0, margin);
}

/** True only when a whole axis-aligned footprint clears water and the banks. */
export function riverFootprintClear(x, z, halfX = 0, halfZ = halfX, margin = RIVER_BANK_WIDTH) {
  if (![x, z, halfX, halfZ, margin].every(Number.isFinite) || halfX < 0 || halfZ < 0 || margin < 0) return false;
  const range = riverRange(x - halfX, x + halfX), edge = RIVER_HALF_WIDTH + margin;
  return z + halfZ < range.min - edge || z - halfZ > range.max + edge;
}

export function riverCellUsable(i, j) {
  return Number.isInteger(i) && Number.isInteger(j) && riverFootprintClear(i * RIVER_GRID_PITCH, j * RIVER_GRID_PITCH, RIVER_LOT_HALF);
}

/** A bridge follows a fixed vertical road. Deck covers both banks across its full
 * width; approaches meet ground at minZ/maxZ. Geometry is independent of island size. */
export function bridgeSpan(x) {
  if (!Number.isFinite(x)) return null;
  const range = riverRange(x - BRIDGE_HALF_WIDTH, x + BRIDGE_HALF_WIDTH);
  const deckMinZ = range.min - RIVER_HALF_WIDTH - RIVER_BANK_WIDTH;
  const deckMaxZ = range.max + RIVER_HALF_WIDTH + RIVER_BANK_WIDTH;
  return { x, centerZ: riverZ(x), minZ: deckMinZ - BRIDGE_RAMP_LENGTH, maxZ: deckMaxZ + BRIDGE_RAMP_LENGTH,
    deckMinZ, deckMaxZ, halfWidth: BRIDGE_HALF_WIDTH, deckY: BRIDGE_DECK_Y, groundY: BRIDGE_GROUND_Y };
}

/** An explicit crossing list bounds bridges to the current island. Without one,
 * use the nearest fixed-grid road; useful for navigation while the island grows. */
export function bridgeAt(x, z, crossings = null) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const candidates = Array.isArray(crossings) ? crossings : [(Math.round(x / RIVER_GRID_PITCH - 0.5) + 0.5) * RIVER_GRID_PITCH];
  for (const crossing of candidates) {
    if (!Number.isFinite(crossing) || Math.abs(x - crossing) > BRIDGE_HALF_WIDTH + EDGE_EPSILON) continue;
    const span = bridgeSpan(crossing);
    if (z >= span.minZ - EDGE_EPSILON && z <= span.maxZ + EDGE_EPSILON) return span;
  }
  return null;
}

/** Walkable top surface, including linear approaches; null outside the bridge. */
export function bridgeHeight(x, z, crossings = null) {
  const span = bridgeAt(x, z, crossings);
  if (!span) return null;
  if (z >= span.deckMinZ && z <= span.deckMaxZ) return span.deckY;
  const rise = z < span.deckMinZ ? (z - span.minZ) / BRIDGE_RAMP_LENGTH
    : z > span.deckMaxZ ? (span.maxZ - z) / BRIDGE_RAMP_LENGTH : 1;
  return span.groundY + (span.deckY - span.groundY) * Math.max(0, Math.min(1, rise));
}
