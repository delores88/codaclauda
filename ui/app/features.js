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
 *   external           external_sessions_list() → { sessions:[{ provider, cwd, projectHint, modifiedAt, active, owned, providerSessionId }] }
 *   adopt              session_adopt({ provider, providerSessionId, cwd, title?, mode?: 'fork'|'continue' }) → { session, copy: true } (0.6);
 *                      the default (or 'fork') makes a separate, labeled copy; 'continue' is always error OWNERSHIP_UNKNOWN
 *   desktopBindings    desktop_bindings_get() → { bindings:[{ address, provider, threadId, cwd, projectId, boundAt, cursor, last }], wakeEnabled, pollSeconds } (0.6)
 *   desktopBind        desktop_bind({ address, threadId }) → { binding, bindings } (0.6, owner only)
 *   desktopUnbind      desktop_unbind({ address }) → { unbound, bindings } (0.6)
 *   usageGet / usageSet  usage_settings_get() / usage_settings_set({ provider, useCredits?, useResets? }) → { codex, claude, error } (0.6)
 *   usageStatus        usage_status({ provider }) → { snapshot, at, limited, resetsAt, state?, resetCredits? } (0.6)
 *   continue           session_continue({ id, turnId }) → { accepted, turnId, queued } (0.6; the recorded usageStopped turn, once ended)
 *   retryHeld          session_retry_held({ id }) → { released, turnId? } (0.6; Try now for a held turn)
 *   mcpGet / mcpSet    mcp_servers_get({ projectId }) / mcp_servers_set({ projectId, servers }) → { servers }
 *   notifyGet / notifySet  notify_settings_get() / notify_settings_set({ ntfyUrl, onFinish, onError }) → same
 *   notifyTest         notify_test() (optional; the Settings test button needs it)
 *   limitsGet / limitsSet  session_limits_get() / session_limits_set({ maxLive: n|'unlimited' }) → { maxLive, queueMax }
 *   teamGet / teamSet  team_settings_get() → { address, projects, defaults } / team_settings_set({ project }) → { projectId, project }
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
  teamGet: 'team_settings_get', teamSet: 'team_settings_set',
  adopt: 'session_adopt', usageGet: 'usage_settings_get', usageSet: 'usage_settings_set', usageStatus: 'usage_status',
  desktopBindings: 'desktop_bindings_get', desktopBind: 'desktop_bind', desktopUnbind: 'desktop_unbind',
  continue: 'session_continue', retryHeld: 'session_retry_held',
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

/* ---------- 0.6 Wake by mail for Codex desktop chats ---------- */

/** Board addresses that are never a desktop chat's own inbox. */
export const RESERVED_ADDRESSES = ['owner', 'codaclauda-team'];
const squash = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The board addresses a Codex desktop chat can be woken through: every known address except the reserved ones and
 *  CodaClauda sessions' own (`taken`). Likely ones come first: the folder's name in the address or its label, then codex-*.
 *  → [{ name, label, likely }] (labels are self-asserted display text). */
export function wakeAddressChoices(addresses, { taken = [], folder = '' } = {}) {
  const skip = new Set([...RESERVED_ADDRESSES, ...taken].map(a => String(a).toLowerCase()));
  const hint = squash(folder);
  const seen = new Set();
  const rows = [];
  for (const a of Array.isArray(addresses) ? addresses : []) {
    const name = typeof a?.name === 'string' ? a.name.trim().toLowerCase() : '';
    if (!name || skip.has(name) || seen.has(name)) continue;
    seen.add(name);
    const label = typeof a.label === 'string' && a.label.trim() !== a.name ? a.label.trim() : '';
    const named = hint.length >= 3 && (squash(name).includes(hint) || squash(label).includes(hint));
    const score = (named ? 2 : 0) + (name.startsWith('codex-') ? 1 : 0);
    rows.push({ name, label, likely: score > 0, score });
  }
  rows.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name));
  return rows.map(({ score, ...row }) => row);
}

const RECEIPT_TONE = { queued: 'warn', sending: 'warn', timeout: 'warn', unknown: 'warn', unreachable: 'warn', cancelled: 'neutral' };
const RECEIPT_LABEL = {
  queued: 'Command accepted', sending: 'Outcome unknown', unreachable: "Codex couldn't reach that chat", failed: 'Codex failed',
  timeout: 'No answer from Codex', cancelled: 'Stopped', 'not-started': "Codex didn't start", refused: 'Not sent', unknown: 'Outcome unknown',
};

/** desktop_bindings_get → bindings with plain fields only. */
export function normalizeBindings(list) {
  const text = v => (typeof v === 'string' ? v : '');
  return (Array.isArray(list) ? list : []).filter(b => b && typeof b === 'object' && text(b.address) && text(b.threadId)).map(b => {
    const r = b.last && typeof b.last === 'object' ? b.last : null;
    return {
      address: b.address, threadId: b.threadId, cwd: text(b.cwd), projectId: text(b.projectId), boundAt: Number(b.boundAt) || 0,
      endpoint: b.endpoint && typeof b.endpoint === 'object' ? { state: text(b.endpoint.state), detail: text(b.endpoint.detail), path: text(b.endpoint.path) } : null,
      reachability: b.reachability && typeof b.reachability === 'object' ? { state: text(b.reachability.state), detail: text(b.reachability.detail), recipientAcknowledged: b.reachability.recipientAcknowledged === true } : null,
      last: r ? { at: Number(r.at) || 0, status: text(r.status) || 'unknown', exitCode: Number.isInteger(r.exitCode) ? r.exitCode : null,
        messages: Number(r.messages) || 0, more: r.more === true, senders: Array.isArray(r.senders) ? r.senders.filter(s => typeof s === 'string') : [],
        detail: text(r.detail), stdout: text(r.stdout), stderr: text(r.stderr) } : null,
    };
  });
}

export const MANAGED_WAKE_HINT = 'CodaClauda-managed sessions are recommended for agents to wake each other.';
export const NO_CODEX_ENDPOINT = 'not reachable on this PC right now: the Codex app exposes no local endpoint';

/** Current route evidence is separate from the historical command receipt. */
export function bindingState(binding, endpoint = binding?.endpoint, loaded = true) {
  if (!loaded) return { state: 'unknown', tone: 'warn', text: 'Binding status unavailable', detail: 'Refresh to check the current binding and endpoint.' };
  if (!binding) return { state: 'unbound', tone: 'neutral', text: 'Unbound', detail: endpoint?.state === 'unavailable' ? NO_CODEX_ENDPOINT : 'No board address is bound to this desktop chat.' };
  if (endpoint?.state === 'unavailable') return { state: 'endpoint-unavailable', tone: 'warn', text: 'Endpoint unavailable', detail: NO_CODEX_ENDPOINT };
  const reach = binding.reachability;
  if (reach?.state === 'recipient-acknowledged') return { state: reach.state, tone: 'ok', text: 'Recipient acknowledged', detail: reach.detail };
  if (reach?.state === 'command-accepted' || binding.last?.status === 'queued') return { state: 'command-accepted', tone: 'warn', text: 'Command accepted', detail: 'Recipient acknowledgment and server/thread ownership remain unverified.' };
  return { state: 'ownership-unverified', tone: 'warn', text: 'Server/thread ownership unverified', detail: endpoint?.detail || 'A binding or conversation file does not establish that a server owns this chat.' };
}

/** A binding's last delivery receipt → { tone: 'ok'|'warn'|'bad'|'neutral', text, title } for one line under its row. */
export function deliveryText(receipt) {
  if (!receipt) return { tone: 'neutral', text: 'No new mail since it was bound.', title: '' };
  const label = RECEIPT_LABEL[receipt.status] || 'Outcome unknown';
  const count = `${receipt.messages}${receipt.more ? '+' : ''} message${receipt.messages === 1 && !receipt.more ? '' : 's'}`;
  const from = receipt.senders.length ? ` from ${receipt.senders.slice(0, 3).join(', ')}${receipt.senders.length > 3 ? ` +${receipt.senders.length - 3}` : ''}` : '';
  const text = receipt.status === 'queued' ? `${label}: ${count}${from}` : `${count}: ${receipt.detail || label}`;
  const title = [receipt.detail, receipt.exitCode == null ? '' : `exit ${receipt.exitCode}`, receipt.stdout && `stdout: ${receipt.stdout}`, receipt.stderr && `stderr: ${receipt.stderr}`]
    .filter(Boolean).join('\n');
  return { tone: RECEIPT_TONE[receipt.status] || 'bad', text, title };
}
