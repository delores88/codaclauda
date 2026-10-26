/* Pure river-boat policy. Times used by the schedule are elapsed seconds; commit times
 * are wall-clock milliseconds. Keeping the two separate makes preview/tests repeatable. */
export const BOAT_MIN_INTERVAL = 90;
export const BOAT_MAX_INTERVAL = 180;
export const BOAT_SPEED = 3;
export const BOAT_MAX_COUNT = 6;
export const BOAT_SPACING = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Sample one interval. The random sample is supplied so boundaries are testable. */
export function boatInterval(sample = 0.5) {
  const value = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
  return BOAT_MIN_INTERVAL + value * (BOAT_MAX_INTERVAL - BOAT_MIN_INTERVAL);
}

export function nextBoatAt(elapsed, sample = 0.5) {
  return (Number.isFinite(elapsed) ? elapsed : 0) + boatInterval(sample);
}

function commitTime(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return NaN;
  return Date.parse(value);
}

/** Up to six distinct projects, newest first. A real last-commit date is authoritative;
 * projects whose provider omitted the date can use its seven-day count as a fallback.
 * No activity returns two unlabelled boats, not invented project activity. */
export function selectBoatManifest(projects = [], now = Date.now(), limit = BOAT_MAX_COUNT) {
  const count = Math.min(BOAT_MAX_COUNT, Math.max(0, Math.floor(Number(limit) || 0)));
  if (!count) return [];
  const seen = new Set(), candidates = [];
  for (const project of projects) {
    if (!project?.id || seen.has(project.id)) continue;
    seen.add(project.id);
    const git = project.stats?.git || {}, at = commitTime(git.last_commit_at);
    const dated = Number.isFinite(at), recent = dated && at <= now && now - at <= DAY_MS;
    const weekly = Number(git.commits_7d);
    if (!recent && (dated || !Number.isFinite(weekly) || weekly <= 0)) continue;
    candidates.push({ projectId: project.id, label: String(project.name || project.id).slice(0, 40), at: recent ? at : 0, weekly: Number.isFinite(weekly) ? weekly : 0 });
  }
  candidates.sort((a, b) => b.at - a.at || b.weekly - a.weekly || a.projectId.localeCompare(b.projectId));
  if (!candidates.length) return Array.from({ length: Math.min(2, count) }, () => ({ projectId: null, label: '' }));
  return candidates.slice(0, count).map(({ projectId, label }) => ({ projectId, label }));
}

/** Independent barges follow the same fixed river path with generous spacing.
 * A hull is visible only when all of it is over water inside the island rim. */
export function boatPass(elapsed, startedAt, half, index = 0) {
  // Even the longest six-boat pass clears in under 75 seconds, leaving room
  // before the minimum 90-second departure interval. Ordinary cities stay slow.
  const speed = Math.max(BOAT_SPEED, (half * 2 + (BOAT_MAX_COUNT - 1) * BOAT_SPACING) / 75);
  const x = -half + 2.5 + Math.max(0, elapsed - startedAt) * speed - index * BOAT_SPACING;
  return { x, visible: x >= -half + 2.5 && x <= half - 2.5, done: x > half - 2.5 };
}
