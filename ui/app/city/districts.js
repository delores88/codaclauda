/* District rules and plot enumeration. Pure: shared by placement, scenery and tests. */
import { riverZ, riverCellUsable, RIVER_GRID_PITCH } from './river-path.js';
export const DOWNTOWN = 'downtown';
export const SUBURBS = 'suburbs';
export const DISTRICTS = [DOWNTOWN, SUBURBS];
export const MIN_EMPTY_PLOTS = 3;

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
export function districtForCell(cell) {
  if (!cell || !Number.isInteger(cell.i) || !Number.isInteger(cell.j) || (cell.i === 0 && cell.j === 0)) return null;
  if (!riverCellUsable(cell.i, cell.j)) return null;
  return cell.j * RIVER_GRID_PITCH < riverZ(cell.i * RIVER_GRID_PITCH) ? DOWNTOWN : SUBURBS;
}

const rings = { [DOWNTOWN]: [], [SUBURBS]: [] };
let builtRings = 0;
function growDistricts(count) {
  while (builtRings < count) {
    const ring = ++builtRings;
    // Append each new perimeter without changing earlier plots. Each block extends
    // both along the river (x) and away from it (z).
    for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
      const cell = { i, j, ring };
      const district = districtForCell(cell);
      if (district) rings[district].push(cell);
    }
  }
}

/** Stable, inner-block-first plot order; callers receive copies, not shared cells. */
export function districtCells(count, district) {
  if (!DISTRICTS.includes(district)) return [];
  count = Math.max(0, Math.floor(Number(count) || 0));
  growDistricts(count);
  return rings[district].filter(cell => cell.ring <= count).map(cell => ({ ...cell }));
}

/** Plot indexed within one district's stable expansion order. */
export function districtSlot(slot, district) {
  if (!DISTRICTS.includes(district) || !Number.isInteger(slot) || slot < 0) return null;
  while (slot >= rings[district].length) growDistricts(builtRings + 1);
  return { ...rings[district][slot] };
}
