/* Pure railway policy. Times used by the schedule are elapsed seconds; commit times
 * are wall-clock milliseconds. Keeping the two separate makes preview/tests repeatable. */
export const TRAIN_MIN_INTERVAL = 90;
export const TRAIN_MAX_INTERVAL = 180;
export const TRAIN_WARNING_SECONDS = 4;
export const TRAIN_SPEED = 8;
export const TRAIN_MAX_CARS = 6;
export const TRAIN_CAR_PITCH = 3.4;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Sample one interval. The random sample is supplied so boundaries are testable. */
export function trainInterval(sample = 0.5) {
  const value = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
  return TRAIN_MIN_INTERVAL + value * (TRAIN_MAX_INTERVAL - TRAIN_MIN_INTERVAL);
}

export function nextTrainAt(elapsed, sample = 0.5) {
  return (Number.isFinite(elapsed) ? elapsed : 0) + trainInterval(sample);
}

function commitTime(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return NaN;
  return Date.parse(value);
}

/** Up to six distinct projects, newest first. A real last-commit date is authoritative;
 * projects whose provider omitted the date can use its seven-day count as a fallback.
 * No activity returns three empty wagons, not invented project activity. */
export function selectTrainCars(projects = [], now = Date.now(), limit = TRAIN_MAX_CARS) {
  const count = Math.min(TRAIN_MAX_CARS, Math.max(0, Math.floor(Number(limit) || 0)));
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
  if (!candidates.length) return Array.from({ length: Math.min(3, count) }, () => ({ projectId: null, label: '' }));
  return candidates.slice(0, count).map(({ projectId, label }) => ({ projectId, label }));
}

/** Train nose position during a pass. Both ends include enough run-in for all wagons
 * to emerge from, then clear, the portals without appearing beyond the island. */
export function trainPass(elapsed, startedAt, half, cars) {
  const length = Math.max(0, Math.min(TRAIN_MAX_CARS, cars)) * TRAIN_CAR_PITCH + 3.2;
  const x = -half - 3.2 + Math.max(0, elapsed - startedAt) * TRAIN_SPEED;
  return { x, length, done: x - length > half + 3.2 };
}

/** Warn only shortly before a train reaches each crossing, until its last car clears.
 * For a future pass, startedAt is its scheduled departure time. */
export function crossingWarning(elapsed, startedAt, crossingX, half, cars) {
  if (!Number.isFinite(startedAt)) return false;
  const arrival = startedAt + (crossingX + half + 3.2) / TRAIN_SPEED;
  const clear = arrival + (Math.min(TRAIN_MAX_CARS, Math.max(0, cars)) * TRAIN_CAR_PITCH + 4.8) / TRAIN_SPEED;
  return elapsed >= arrival - TRAIN_WARNING_SECONDS && elapsed <= clear;
}
