/* Pure helpers for CodaClauda scheduled tasks (0.4.1). No DOM, no imports; node tests import this file.
 *
 * Schedule: { id, name, projectId, cwd, provider: 'claude'|'codex', prompt, cadence, enabled, catchUp, lastRunAt, nextRunAt }
 * Cadence:  { kind: 'interval', minutes >= 15 } | { kind: 'daily', time: 'HH:MM', days: [0-6] } (0 = Sunday, local time)
 * Run:      { at, status: 'sent'|'done'|'error', sessionId, turnId, error? } */

export const MIN_INTERVAL = 15;
export const MAX_INTERVAL = 7 * 24 * 60;
export const NAME_LIMIT = 80;
export const PROMPT_LIMIT = 8000;
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Display order of the weekday chips: Monday first. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const RUN_STATUS = {
  reserved: { label: 'Preparing', tone: 'neutral' },
  sent: { label: 'Sent', tone: 'accent' },
  unknown: { label: 'Unknown outcome', tone: 'danger' },
  done: { label: 'Done', tone: 'success' },
  error: { label: 'Error', tone: 'danger' },
};
export const runStatus = status => RUN_STATUS[status] || { label: String(status || 'Unknown'), tone: 'neutral' };
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const uniqueDays = days => [...new Set((Array.isArray(days) ? days : []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);

/** "09:30" → "9:30 AM" in the viewer's locale (falls back to the raw text). */
export function timeLabel(hhmm, locale) {
  const m = TIME_RE.exec(String(hhmm || ''));
  if (!m) return String(hhmm || '');
  try { return new Date(2000, 0, 1, Number(m[1]), Number(m[2])).toLocaleTimeString(locale || [], { hour: 'numeric', minute: '2-digit' }); }
  catch { return String(hhmm); }
}

/** A cadence in words: "Every 30 minutes", "Every 2 hours", "Weekdays at 9:00 AM", "Mon, Wed at 18:00". */
export function cadenceText(cadence, locale) {
  if (!cadence || typeof cadence !== 'object') return 'No cadence';
  if (cadence.kind === 'interval') {
    const n = Number(cadence.minutes);
    if (!Number.isFinite(n) || n <= 0) return 'No cadence';
    if (n % 1440 === 0) return n === 1440 ? 'Every day' : `Every ${n / 1440} days`;
    if (n % 60 === 0) return n === 60 ? 'Every hour' : `Every ${n / 60} hours`;
    return `Every ${n} minutes`;
  }
  if (cadence.kind === 'daily') {
    const days = uniqueDays(cadence.days);
    const at = `at ${timeLabel(cadence.time, locale)}`;
    if (!days.length) return `Never (no days picked) ${at}`;
    if (days.length === 7) return `Daily ${at}`;
    if (days.join() === '1,2,3,4,5') return `Weekdays ${at}`;
    if (days.join() === '0,6') return `Weekends ${at}`;
    return `${WEEK_ORDER.filter(d => days.includes(d)).map(d => DAY_SHORT[d]).join(', ')} ${at}`;
  }
  return 'No cadence';
}

/** "in 5 min", "in 3 h", "in 2 d", "due now" for a future time in ms. */
export function untilText(ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const min = Math.round((ms - now) / 60e3);
  if (min <= 0) return 'due now';
  if (min < 60) return `in ${min} min`;
  if (min < 48 * 60) { const hours = Math.floor(min / 60), rest = min % 60; return rest && hours < 6 ? `in ${hours} h ${rest} min` : `in ${Math.round(min / 60)} h`; }
  return `in ${Math.round(min / 1440)} d`;
}

/** The editor's fields → { ok: true, schedule } or { ok: false, error, field }. */
export function validateSchedule(input) {
  const d = input && typeof input === 'object' ? input : {};
  const name = String(d.name ?? '').trim();
  const prompt = String(d.prompt ?? '').trim();
  if (!name) return { ok: false, field: 'name', error: 'Give the schedule a short name.' };
  if (name.length > NAME_LIMIT) return { ok: false, field: 'name', error: `Keep the name under ${NAME_LIMIT} characters.` };
  if (!d.projectId || !String(d.cwd || '').trim()) return { ok: false, field: 'project', error: 'Pick a project with a local folder.' };
  if (d.provider !== 'claude' && d.provider !== 'codex') return { ok: false, field: 'provider', error: 'Pick Claude Code or Codex.' };
  if (!prompt) return { ok: false, field: 'prompt', error: 'Write the prompt each run sends.' };
  if (prompt.length > PROMPT_LIMIT) return { ok: false, field: 'prompt', error: `Keep the prompt under ${PROMPT_LIMIT} characters.` };
  let cadence;
  const c = d.cadence || {};
  if (c.kind === 'interval') {
    const minutes = Number(c.minutes);
    if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL) return { ok: false, field: 'cadence', error: `Run at most every ${MIN_INTERVAL} minutes (a whole number of ${MIN_INTERVAL} or more).` };
    if (minutes > MAX_INTERVAL) return { ok: false, field: 'cadence', error: 'Run at least once a week (10080 minutes).' };
    cadence = { kind: 'interval', minutes };
  } else if (c.kind === 'daily') {
    if (!TIME_RE.test(String(c.time || ''))) return { ok: false, field: 'cadence', error: 'Pick a time of day (HH:MM).' };
    const days = uniqueDays(c.days);
    if (!days.length) return { ok: false, field: 'cadence', error: 'Pick at least one weekday.' };
    cadence = { kind: 'daily', time: String(c.time), days };
  } else return { ok: false, field: 'cadence', error: 'Pick how often it runs.' };
  return {
    ok: true,
    schedule: { name, projectId: String(d.projectId), cwd: String(d.cwd), provider: d.provider, prompt, cadence, access: d.access === 'full' ? 'full' : 'read', enabled: d.enabled !== false, catchUp: d.catchUp === true },
  };
}

/** Runs newest first, without duplicates (a run's later record replaces its 'sent' record). */
export function mergeRuns(existing, incoming) {
  const keyOf = r => (r.turnId ? `t:${r.turnId}` : `a:${r.at}|${r.sessionId ?? ''}`);
  const map = new Map();
  for (const r of [...(existing || []), ...(incoming || [])]) if (r && typeof r === 'object') {
    const previous = map.get(keyOf(r));
    // An IPC response can arrive after the completion event for the same turn.
    // Never replace an already terminal receipt with a stale Preparing/Sent row.
    const terminal = value => value && !['reserved', 'sent'].includes(value.status);
    if (terminal(previous) && ['reserved', 'sent'].includes(r.status)) continue;
    map.set(keyOf(r), { ...previous, ...r });
  }
  const ms = v => { const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : 0; };
  return [...map.values()].sort((a, b) => ms(b.at) - ms(a.at));
}

/** Run now may return a persisted refusal rather than throw. */
export const runAccepted = run => Boolean(run && ['sent', 'done'].includes(run.status));
