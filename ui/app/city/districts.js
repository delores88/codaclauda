/* District rules and plot enumeration. Pure: shared by placement, scenery and tests. */
export const DOWNTOWN = 'downtown';
export const OLD_TOWN = 'oldtown';
export const DISTRICTS = [DOWNTOWN, OLD_TOWN];
export const MIN_EMPTY_PLOTS = 3;
// The railway follows the street immediately behind HQ, between lot rows -1 and 0.
export const TRACK_Z = -8;

export function projectIds(project) {
  return [...new Set([project?.id, ...(Array.isArray(project?.ids) ? project.ids : [])].filter(id => typeof id === 'string'))];
}

/** A linked GitHub identity puts a project Downtown, including repos not cloned here. */
export function districtOf(project) {
  return projectIds(project).some(id => id.startsWith('gh:')) ? DOWNTOWN : OLD_TOWN;
}

export function isUnbuilt(project) {
  return districtOf(project) === DOWNTOWN && !(typeof project?.path === 'string' && project.path.trim());
}

/** HQ has no district plot. Coordinates are lot indices, not world positions. */
export function districtForCell(cell) {
  if (!cell || !Number.isInteger(cell.i) || !Number.isInteger(cell.j) || (cell.i === 0 && cell.j === 0)) return null;
  return cell.j < 0 ? DOWNTOWN : OLD_TOWN;
}

const rings = { [DOWNTOWN]: [], [OLD_TOWN]: [] };
let builtRings = 0;
function growDistricts(count) {
  while (builtRings < count) {
    const ring = ++builtRings;
    // Append each new perimeter without changing earlier plots. Each block extends
    // both along the railway (x) and away from it (z).
    for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
      const cell = { i, j, ring };
      rings[districtForCell(cell)].push(cell);
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
