/* CodaClauda 0.5 engine features, reached through bridge.js desktop.* with feature detection.
 * The engine track owns the Tauri commands and the desktop.* wrappers; each wrapper is the camelCase
 * of its command (session_fork → desktop.sessionFork). A missing wrapper means this build lacks the
 * feature, and the views hide or explain it instead of failing. Lookup happens at call time, so a
 * wrapper added later (or by a test) is picked up without a reload.
 *
 * Contract (names and shapes are fixed):
 *   fork               session_fork({ id }) → { session }
 *   handoff            session_handoff({ id, toProvider }) → { session }
 *   diff               session_diff({ id }) → { files:[{ path, status, additions, deletions }], patch, truncated }
 *   apply              session_worktree_apply({ id, message }) → { committed, merged, branch }
 *   discard            session_worktree_discard({ id }) → { discarded: true }
 *   prCreate           session_pr_create({ id, title, body }) → { url, number }
 *   prStatus           session_pr_status({ id }) → { url|null, state|null, checks:[{ name, status, conclusion }] }
 *   compact            session_compact({ id }) → { ok: true } | error COMPACT_UNSUPPORTED
 *   external           external_sessions_list() → { sessions:[{ provider, cwd, projectHint, modifiedAt, active }] }
 *   mcpGet / mcpSet    mcp_servers_get({ projectId }) / mcp_servers_set({ projectId, servers }) → { servers }
 *   notifyGet / notifySet  notify_settings_get() / notify_settings_set({ ntfyUrl, onFinish, onError }) → same
 *   notifyTest         notify_test() (optional; the Settings test button needs it)
 *   limitsGet / limitsSet  session_limits_get() / session_limits_set({ maxLive }) → { maxLive, queueMax }
 *   instructionsRead   project_instructions_read({ projectId, cwd, file }) → { text, exists }
 *   instructionsWrite  project_instructions_write({ projectId, cwd, file, text }) → { ok: true }
 *   ciStatus           ci_status({ projectId, repo }) → { runs:[{ name, status, conclusion, branch, url, at }] }
 * No imports besides bridge.js; the pure helpers at the bottom have no DOM. */
import { desktop } from './bridge.js';

export const COMMANDS = {
  fork: 'session_fork', handoff: 'session_handoff', diff: 'session_diff',
  apply: 'session_worktree_apply', discard: 'session_worktree_discard',
  prCreate: 'session_pr_create', prStatus: 'session_pr_status', compact: 'session_compact',
  external: 'external_sessions_list', mcpGet: 'mcp_servers_get', mcpSet: 'mcp_servers_set',
  notifyGet: 'notify_settings_get', notifySet: 'notify_settings_set', notifyTest: 'notify_test',
  instructionsRead: 'project_instructions_read', instructionsWrite: 'project_instructions_write',
  ciStatus: 'ci_status', limitsGet: 'session_limits_get', limitsSet: 'session_limits_set',
};
export const UNSUPPORTED_TEXT = 'Needs CodaClauda 0.5 desktop';

export const camel = command => String(command).replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

function wrapper(key) {
  const command = COMMANDS[key];
  if (!command) return null;
  const name = camel(command);
  for (const candidate of [name, name.replace(/Pr(?=[A-Z])/, 'PR')]) if (typeof desktop[candidate] === 'function') return desktop[candidate];
  return null;
}

/** True when this build has the feature's desktop.* wrapper. */
export const has = key => Boolean(wrapper(key));

/** Calls a feature; throws code UNSUPPORTED when this build lacks it. */
export async function call(key, args) {
  const fn = wrapper(key);
  if (!fn) {
    const error = new Error(`${UNSUPPORTED_TEXT} (${COMMANDS[key] || key}).`);
    error.code = 'UNSUPPORTED';
    throw error;
  }
  return args === undefined ? fn() : fn(args);
}

/* ---------- pure helpers (node tests import these) ---------- */

export const PROJECT_FILES = ['CLAUDE.md', 'AGENTS.md'];
export const INSTRUCTIONS_LIMIT = 200 * 1024;
export const utf8Length = text => new TextEncoder().encode(String(text ?? '')).length;

/** Usage record → { input, output, cached, total, costUsd|null, contextPct|null } with numbers only. */
export function normalizeUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const n = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  const input = n(u.input), output = n(u.output), cached = n(u.cached);
  const cost = Number(u.costUsd);
  const pct = Number(u.contextPct);
  return {
    input, output, cached, total: input + output,
    costUsd: u.costUsd != null && Number.isFinite(cost) && cost >= 0 ? cost : null,
    contextPct: u.contextPct != null && Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null,
  };
}

/** "12.3k" style token count. */
export function tokens(n) {
  const v = Number(n) || 0;
  return v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k` : String(Math.round(v));
}

/** "$0.042" / "$1.20" for a cost estimate. */
export const money = usd => `$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}`;

/** An ntfy topic URL is accepted only as https with a host and a topic path. '' clears it. */
export function validNtfyUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return { ok: true, url: '' };
  let url;
  try { url = new URL(text); } catch { return { ok: false, error: 'Enter a full URL, like https://ntfy.sh/your-topic.' }; }
  if (url.protocol !== 'https:') return { ok: false, error: 'The topic URL must start with https://.' };
  if (url.username || url.password) return { ok: false, error: 'Leave sign-in details out of the URL.' };
  if (!url.pathname.replace(/\/+$/, '') || url.pathname === '/') return { ok: false, error: 'Add the topic after the host, like https://ntfy.sh/your-topic.' };
  return { ok: true, url: url.href };
}

const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** Editor rows → { ok, servers, error }. Args are one per line; env is KEY=VALUE per line. */
export function parseServers(rows) {
  const servers = [];
  const names = new Set();
  for (const [i, row] of (Array.isArray(rows) ? rows : []).entries()) {
    const name = String(row?.name ?? '').trim();
    const command = String(row?.command ?? '').trim();
    if (!name && !command) continue;
    const where = name || `Server ${i + 1}`;
    if (!SERVER_NAME.test(name)) return { ok: false, error: `${where}: a name uses letters, digits, - or _ (at most 64).` };
    if (names.has(name.toLowerCase())) return { ok: false, error: `${name} is listed twice.` };
    if (name.toLowerCase() === 'codaclauda') return { ok: false, error: 'codaclauda is reserved for CodaClauda’s own board tools.' };
    if (!command) return { ok: false, error: `${name}: enter the command to run.` };
    names.add(name.toLowerCase());
    const args = Array.isArray(row.args) ? row.args.map(String) : String(row.args ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const env = {};
    const envLines = row.env && typeof row.env === 'object' && !Array.isArray(row.env) ? Object.entries(row.env).map(([k, v]) => `${k}=${v}`) : String(row.env ?? '').split(/\r?\n/);
    for (const line of envLines.map(s => s.trim()).filter(Boolean)) {
      const eq = line.indexOf('=');
      const key = eq > 0 ? line.slice(0, eq).trim() : '';
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { ok: false, error: `${name}: environment lines are NAME=value.` };
      env[key] = line.slice(eq + 1);
    }
    servers.push({ name, command, args, env });
  }
  return { ok: true, servers };
}

/** The GitHub owner/name for a project (its repo, or a gh: id), or ''. */
export function repoOf(project) {
  const full = project?.repo?.full_name || (Array.isArray(project?.ids) ? project.ids.find(id => typeof id === 'string' && id.startsWith('gh:'))?.slice(3) : '') || '';
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(full) ? full : '';
}

/** A unified diff → [{ kind: 'file'|'hunk'|'add'|'del'|'ctx'|'meta', text }] for display (capped). */
export function patchLines(patch, limit = 4000) {
  const out = [];
  for (const line of String(patch ?? '').split('\n')) {
    if (out.length >= limit) { out.push({ kind: 'meta', text: '… (more lines not shown)' }); break; }
    const kind = /^diff --git /.test(line) ? 'file' : line.startsWith('@@') ? 'hunk'
      : /^(\+\+\+|---) /.test(line) || /^(index|new file|deleted file|similarity|rename|old mode|new mode|Binary) /.test(line) ? 'meta'
        : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
    out.push({ kind, text: line });
  }
  while (out.length && out.at(-1).kind === 'ctx' && !out.at(-1).text) out.pop();
  return out;
}
