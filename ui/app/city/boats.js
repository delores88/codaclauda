/* Pure river-boat policy. Loop time is monotonic elapsed seconds; commit times are
 * wall-clock milliseconds. Quality changes reuse the existing slots and type bag. */
export const BOAT_MIN_LAP = 240;
export const BOAT_MAX_LAP = 360;
export const BOAT_MIN_SPEED = 0.8;
export const BOAT_MAX_SPEED = 3;
export const BOAT_MAX_COUNT = 6;
export const BOAT_TYPES = Object.freeze(['sailboat', 'rowboat', 'tugboat', 'barge', 'paddle-steamer', 'canoe']);
export const BOAT_TYPE_SPEEDS = Object.freeze({ sailboat: 1, rowboat: 0.96, tugboat: 1.02, barge: 0.86, 'paddle-steamer': 0.9, canoe: 1.14 });
const DAY_MS = 24 * 60 * 60 * 1000;
const unit = sample => Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;

export function lapDuration(sample = 0.5) { return BOAT_MIN_LAP + unit(sample) * (BOAT_MAX_LAP - BOAT_MIN_LAP); }

/** The whole fleet shares a speed so its spacing cannot collapse. Type mix biases
 * its target within 240–360 s. At extreme route lengths the .8–3 speed bound wins;
 * returning the actual duration makes that unavoidable exception explicit. */
export function loopTiming(length, { sample = 0.5, types = [] } = {}) {
  const distance = Number.isFinite(length) && length > 0 ? length : 1;
  const relative = types.filter(type => BOAT_TYPES.includes(type)).map(type => BOAT_TYPE_SPEEDS[type]);
  const mean = relative.length ? relative.reduce((sum, speed) => sum + speed, 0) / relative.length : 1;
  const desiredDuration = Math.max(BOAT_MIN_LAP, Math.min(BOAT_MAX_LAP, lapDuration(sample) / mean));
  const speed = Math.max(BOAT_MIN_SPEED, Math.min(BOAT_MAX_SPEED, distance / desiredDuration));
  return { desiredDuration, duration: distance / speed, speed };
}

/** A slot is always present, including on its wrapping edge. Renderers can pass
 * an accumulated cycle count as elapsed with duration=1 to preserve positions
 * when route length/type mix changes. Only a lap change consumes a new type. */
export function loopPhase(elapsed, duration, slot = 0, count = 3) {
  const slots = Math.max(2, Math.min(3, Math.floor(Number(count) || 3)));
  const index = Math.max(0, Math.min(slots - 1, Math.floor(Number(slot) || 0)));
  const cycle = Number.isFinite(elapsed) ? Math.max(0, elapsed) / (Number.isFinite(duration) && duration > 0 ? duration : 1) : 0;
  const offset = cycle + index / slots, lap = Math.floor(offset);
  return { phase: offset - lap, lap };
}

/** Consume types only when creating a new fleet. The returned bag is the remaining
 * queue; quality rebuilds reuse their fleet and never call this helper. Each new
 * bag visits all six types once and its first choice cannot repeat the last one. */
export function chooseBoatTypes(count, { bag = [], previous = null, random = Math.random } = {}) {
  const amount = Number(count), limit = Number.isFinite(amount) ? Math.min(BOAT_MAX_COUNT, Math.max(0, Math.floor(amount))) : 0;
  let remaining = [...new Set((Array.isArray(bag) ? bag : []).filter(type => BOAT_TYPES.includes(type)))];
  let lastType = BOAT_TYPES.includes(previous) ? previous : null;
  const types = [];
  while (types.length < limit) {
    // A one-item tail equal to the previous type is malformed external state;
    // repair it with a fresh bag instead of producing an immediate repeat.
    if (!remaining.length || (remaining.length === 1 && remaining[0] === lastType)) {
      remaining = [...BOAT_TYPES];
      for (let i = remaining.length - 1; i > 0; i--) {
        const sample = typeof random === 'function' ? random() : 0.5;
        const unit = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
        const j = Math.min(i, Math.floor(unit * (i + 1)));
        [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
      }
    }
    if (remaining[0] === lastType) [remaining[0], remaining[1]] = [remaining[1], remaining[0]];
    lastType = remaining.shift(); types.push(lastType);
  }
  return { types, bag: remaining, lastType };
}

/** Sample labels only at a slot's upstream boundary, then retain the returned
 * entry through remeshing. Non-barges have one label with 50% probability;
 * barges have 2–4 crates, each labelled when a distinct recent project exists. */
export function boatFleet(manifest = [], types = [], { random = Math.random } = {}) {
  const projects = [], seen = new Set();
  for (const item of Array.isArray(manifest) ? manifest : []) {
    const projectId = typeof item?.projectId === 'string' ? item.projectId.trim() : '';
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    if (!projectId || !label || seen.has(projectId)) continue;
    seen.add(projectId); projects.push({ projectId, label });
  }
  return (Array.isArray(types) ? types : []).filter(type => BOAT_TYPES.includes(type)).slice(0, BOAT_MAX_COUNT).map((type, index) => {
    const sample = unit(typeof random === 'function' ? random() : 0.5);
    const first = projects.length ? projects[index % projects.length] : null;
    const crateCount = type === 'barge' ? Math.min(4, 2 + Math.floor(sample * 3)) : 0;
    const cargo = type === 'barge' ? [...(first ? [first] : []), ...projects.filter(p => p !== first)].slice(0, crateCount)
      : first && sample < 0.5 ? [first] : [];
    const primary = cargo[0];
    return { type, projectId: primary?.projectId || null, label: primary?.label || '', projects: cargo.map(p => ({ ...p })), ...(crateCount ? { crateCount } : {}) };
  });
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
