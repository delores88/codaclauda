/* District rules and plot enumeration. Pure: shared by placement, scenery and tests. */
import { riverZ, riverCellUsable, RIVER_GRID_PITCH } from './river-path.js';
import { riverLot } from './river-lots.js';
export const DOWNTOWN = 'downtown';
export const SUBURBS = 'suburbs';
export const DISTRICTS = [DOWNTOWN, SUBURBS];
export const MIN_EMPTY_PLOTS = 3;

const BANKS = Object.freeze(Object.fromEntries(DISTRICTS.map(largerDistrict => [largerDistrict, Object.freeze({
  largerDistrict, positiveZ: largerDistrict, negativeZ: largerDistrict === DOWNTOWN ? SUBURBS : DOWNTOWN,
  key: largerDistrict,
})])));

/** A fixed bank assignment for one city. Unconfigured callers retain the legacy orientation. */
export function districtBanks(largerDistrict = SUBURBS) {
  return BANKS[DISTRICTS.includes(largerDistrict) ? largerDistrict : SUBURBS];
}
const banksOf = banks => districtBanks(banks?.largerDistrict);

/** Choose once from the complete project inventory; later loads use the saved district. */
export function chooseLargerDistrict(projects, savedChoice) {
  if (DISTRICTS.includes(savedChoice)) return savedChoice;
  let downtown = 0, suburbs = 0;
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!projectIds(project).length) continue;
    if (districtOf(project) === DOWNTOWN) downtown++; else suburbs++;
  }
  return downtown >= suburbs ? DOWNTOWN : SUBURBS;
}

export function projectIds(project) {
  return [...new Set([project?.id, ...(Array.isArray(project?.ids) ? project.ids : [])].filter(id => typeof id === 'string'))];
}

/** A linked GitHub identity puts a project Downtown, including repos not cloned here. */
export function districtOf(project) {
  return projectIds(project).some(id => id.startsWith('gh:')) ? DOWNTOWN : SUBURBS;
}

export function isUnbuilt(project) {
  return districtOf(project) === DOWNTOWN && !(typeof project?.path === 'string' && project.path.trim());
}

/** HQ and river corridor cells have no project plot. Coordinates are lot indices. */
export function districtForCell(cell, banks) {
  if (!cell || !Number.isInteger(cell.i) || !Number.isInteger(cell.j) || (cell.i === 0 && cell.j === 0)) return null;
  const parcel = riverLot(cell.i, cell.j);
  if (!riverCellUsable(cell.i, cell.j) && !parcel?.eligible) return null;
  const configuration = banksOf(banks);
  return (parcel ? parcel.side < 0 : cell.j * RIVER_GRID_PITCH < riverZ(cell.i * RIVER_GRID_PITCH)) ? configuration.negativeZ : configuration.positiveZ;
}

// Enumeration is memoized separately for each immutable bank configuration.
const cache = new Map();
function bankCache(banks) {
  const configuration = banksOf(banks);
  if (!cache.has(configuration.key)) cache.set(configuration.key, { configuration, builtRings: 0, rings: { [DOWNTOWN]: [], [SUBURBS]: [] } });
  return cache.get(configuration.key);
}
function growDistricts(count, state) {
  while (state.builtRings < count) {
    const ring = ++state.builtRings;
    // Append each new perimeter without changing earlier plots. Each block extends
    // both along the river (x) and away from it (z).
    for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
      const cell = { i, j, ring };
      const district = districtForCell(cell, state.configuration);
      if (district) state.rings[district].push(cell);
    }
  }
}

/** Stable, inner-block-first plot order; callers receive copies, not shared cells. */
export function districtCells(count, district, banks) {
  if (!DISTRICTS.includes(district)) return [];
  count = Math.max(0, Math.floor(Number(count) || 0));
  const state = bankCache(banks);
  growDistricts(count, state);
  return state.rings[district].filter(cell => cell.ring <= count).map(cell => ({ ...cell }));
}

/** Plot indexed within one district's stable expansion order. */
export function districtSlot(slot, district, banks) {
  if (!DISTRICTS.includes(district) || !Number.isInteger(slot) || slot < 0) return null;
  const state = bankCache(banks);
  while (slot >= state.rings[district].length) growDistricts(state.builtRings + 1, state);
  return { ...state.rings[district][slot] };
}
