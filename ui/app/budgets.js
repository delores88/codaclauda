/* Grant budgets (0.5 contract C1/C2), shared by Agent setup → Grant & send, Settings → Limits and the
 * live chat. Wire values are a whole number from the budget's minimum to 9007199254740991, the string
 * "unlimited", or omitted (a grant then inherits the owner's default from policy.grant_defaults).
 * expires_seconds also takes "never" (sent as "unlimited"). Run time and expiry are entered in hours and
 * days and sent as whole seconds. Pure helpers (no DOM) so node can test them. */

export const MAX_SAFE = Number.MAX_SAFE_INTEGER;   // 9007199254740991, the board's largest finite value
export const UNLIMITED = 'unlimited';

/** In form order. `scale` converts the entered unit to seconds. */
export const BUDGETS = [
  { key: 'max_requests', label: 'Maximum requests', short: 'requests', min: 1 },
  { key: 'max_delegations', label: 'Maximum delegations', short: 'delegations', min: 0 },
  { key: 'max_hops', label: 'Maximum hops', short: 'hops', min: 0 },
  { key: 'timeout_seconds', label: 'Hours per run', short: 'per run', min: 10, scale: 3600, unit: 'h' },
  { key: 'max_turns', label: 'Maximum turns per run', short: 'turns', min: 1 },
  { key: 'max_mcp_calls', label: 'Maximum tool calls', short: 'tool calls', min: 1 },
  { key: 'max_compute_jobs', label: 'Maximum compute jobs', short: 'compute jobs', min: 0 },
  { key: 'expires_seconds', label: 'Days until it expires', short: 'expires', min: 30, scale: 86400, unit: 'days', never: true },
];
export const budget = key => BUDGETS.find(b => b.key === key);

/** Owner defaults when the board has no policy.json (C2). */
export const POLICY_DEFAULTS = Object.freeze({
  concurrent: UNLIMITED,
  grant_defaults: Object.freeze({ timeout_seconds: 86400, expires_seconds: 604800, max_requests: UNLIMITED, max_delegations: UNLIMITED, max_hops: UNLIMITED, max_turns: UNLIMITED, max_mcp_calls: UNLIMITED, max_compute_jobs: UNLIMITED }),
});

/** A 0.4 grant (no policy_version) keeps its implicit 0.4 limits. */
export const LEGACY_TEXT = '0.4 grant: 12 turns, 128 tool calls, 256 KiB files';

export const isUnlimited = value => value === UNLIMITED || value === 'never';

/** A whole number from min to MAX_SAFE, or null. Digits only: no signs, exponents or fractions. */
export function wholeNumber(text, min = 0) {
  const s = String(text ?? '').trim();
  if (!/^\d{1,16}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= min ? n : null;
}

/** Form text + Unlimited checkbox → wire value. Empty text → undefined (inherit) when allowed.
 *  Throws an Error naming the field for anything else. */
export function budgetValue(spec, text, unlimited, { inherit = true } = {}) {
  if (unlimited) return UNLIMITED;
  const raw = String(text ?? '').trim();
  if (!raw) {
    if (inherit) return undefined;
    throw new Error(`${spec.label}: enter a value or tick ${spec.never ? 'Never' : 'Unlimited'}.`);
  }
  const range = spec.scale ? `a positive number (at least ${spec.min} seconds)` : `a whole number from ${spec.min} to ${MAX_SAFE}`;
  const problem = () => new Error(`${spec.label} must be ${range}, or ${spec.never ? 'Never' : 'Unlimited'}.`);
  if (!spec.scale) {
    const n = wholeNumber(raw, spec.min);
    if (n == null) throw problem();
    return n;
  }
  if (!/^\d+(\.\d+)?$/.test(raw)) throw problem();
  const seconds = Math.round(Number(raw) * spec.scale);
  if (!Number.isFinite(seconds) || seconds < spec.min) throw problem();
  if (!Number.isSafeInteger(seconds)) throw new Error(`${spec.label} is too large to schedule; choose a smaller value or ${spec.never ? 'Never' : 'Unlimited'}.`);
  return seconds;
}

/** Wire value → form state. Seconds come back in hours/days (at most 4 decimals). */
export function budgetField(spec, value) {
  if (isUnlimited(value)) return { text: '', unlimited: true };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { text: '', unlimited: false };
  if (!spec.scale) return { text: String(value), unlimited: false };
  return { text: String(Number((value / spec.scale).toFixed(4))), unlimited: false };
}

const round = n => Number(n.toFixed(2));

/** One budget for display: "unlimited", "never", "45 s", "10 min", "8 h", "7 days" or "100". */
export function budgetText(spec, value) {
  if (isUnlimited(value)) return spec.never ? 'never' : 'unlimited';
  if (typeof value !== 'number' || !Number.isFinite(value)) return '?';
  if (!spec.scale) return String(value);
  if (value < 60) return `${value} s`;
  if (value < 3600) return `${round(value / 60)} min`;
  if (spec.unit === 'h' || value < 86400) return `${round(value / 3600)} h`;
  const days = round(value / 86400);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** "100 requests · unlimited turns · 8 h per run · expires after 7 days" from a set of budgets. */
export function budgetSummary(values, skip = []) {
  const v = values && typeof values === 'object' ? values : {};
  return BUDGETS.filter(b => v[b.key] !== undefined && v[b.key] !== null && !skip.includes(b.key)).map(b => {
    const text = budgetText(b, v[b.key]);
    if (b.key === 'expires_seconds') return isUnlimited(v[b.key]) ? 'never expires' : `expires after ${text}`;
    if (b.key === 'timeout_seconds') return `${text} per run`;
    return `${text} ${v[b.key] === 1 ? b.short.replace(/s$/, '') : b.short}`;
  }).join(' · ');
}

/** The limits a grant actually enforces: `effective` from the board, else its stored fields. Expiry is
 *  shown separately; a 0.4 grant leads with its implicit limits instead of repeating them. */
export function grantLimitsText(grant) {
  if (!grant) return '';
  const values = grant.effective && typeof grant.effective === 'object' ? grant.effective : grant;
  if (grant.policy_version) return budgetSummary(values, ['expires_seconds']);
  return [LEGACY_TEXT, budgetSummary(values, ['expires_seconds', 'max_turns', 'max_mcp_calls'])].filter(Boolean).join(' · ');
}

/** Epoch ms of a board timestamp (seconds or ms), Infinity for "never", NaN when absent. */
export function expiryMs(value) {
  if (isUnlimited(value)) return Infinity;
  if (value == null || value === '') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : new Date(value).getTime();
}

/** Usable now: not revoked, and never-expiring or expiring in the future. */
export function grantActive(grant, now = Date.now()) {
  return Boolean(grant) && !grant.revoked_at && expiryMs(grant.expires_at) > now;
}

/** 'active' | 'revoked' | 'expired'. */
export function grantState(grant, now = Date.now()) {
  if (grant?.revoked_at) return 'revoked';
  return grantActive(grant, now) ? 'active' : 'expired';
}

/** Authorizations order from fields the board reports (grants carry no creation time): active
 *  first, then the latest expiry ("never" first; a revoke moves expiry to the revocation), then id. */
export function compareGrants(a, b, now = Date.now()) {
  const rank = g => (grantActive(g, now) ? 0 : 1);
  const at = g => { const ms = expiryMs(g?.expires_at); return Number.isNaN(ms) ? -Infinity : ms; };
  return rank(a) - rank(b) || (at(a) === at(b) ? 0 : at(a) < at(b) ? 1 : -1) || String(a?.id).localeCompare(String(b?.id));
}

/** Whether a live chat can keep using its grant: the board's copy wins (a revoke sets revoked_at and
 *  moves expires_at to now, so a new grant is created); a never-expiring grant stays usable; a finite
 *  max_requests keeps one spare. Without a board copy, the thread's saved expiry decides. */
export function liveGrantUsable(thread, boardGrant, now = Date.now()) {
  if (!thread?.grantId) return false;
  if (boardGrant) {
    if (!grantActive(boardGrant, now) || expiryMs(boardGrant.expires_at) - now <= 120e3) return false;
    const max = (boardGrant.effective || boardGrant).max_requests;
    return typeof max !== 'number' || (Number(thread.grantUsed) || 0) < max - 1;
  }
  const at = thread.grantExpiresAt === 'never' ? Infinity : Number(thread.grantExpiresAt);
  return at - now > 120e3;
}

/** Number or "unlimited" setting (Agents at once, Board requests at once, the team guard). */
export function limitValue(text, unlimited, min = 1) {
  if (unlimited) return UNLIMITED;
  return wholeNumber(text, min);
}
