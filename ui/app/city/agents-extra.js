/* Zero-config agents for the City (0.5). Two sources become City agent records, so the NPC,
 * label and panel pipeline runs unchanged:
 *   - CodaClauda's own sessions (session_list), with an explicit status: working (a turn is
 *     running), idle or error. Stopped sessions are not shown.
 *   - Claude Code and Codex sessions already running on this machine (external_sessions_list).
 *     That list is METADATA ONLY (provider, folder, last-modified time, active flag): no transcript
 *     content ever reaches the City. Only the active ones (modified in the last 15 minutes) appear.
 * Pure (no DOM, no store): node tests import it. */
import { agentAvatar } from '../avatar/spec.js';

export const PROVIDER_NAME = { claude: 'Claude Code', codex: 'Codex' };
export const SESSION_STATUS_LABEL = { active: 'Working', idle: 'Idle', error: 'Error' };
const ACTIVE_MS = 15 * 60e3;
const MAX_SESSIONS = 16;   // the most recently active CodaClauda sessions shown as people

export const normPath = path => String(path || '').trim().replaceAll('\\', '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase();
const squash = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const ms = value => { const n = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : 0; };

/** Match only a linked checkout or its descendants, preserving path boundaries. */
function projectForFolder(projects, cwd) {
  const list = Array.isArray(projects) ? projects : [];
  const want = normPath(cwd);
  let best = null, depth = -1;
  if (want) for (const p of list) {
    // A canonical project may retain several local checkout aliases after its
    // local/GitHub identities merge. A nested worktree belongs to that checkout.
    const roots = [p?.path, ...(Array.isArray(p?.ids) ? p.ids : [])
      .filter(id => typeof id === 'string' && /^local:(?:[a-z]:[\\/]|\/\/)/i.test(id)).map(id => id.slice(6))];
    for (const path of roots) {
      const root = normPath(path);
      if (root && (want === root || want.startsWith(`${root}/`)) && root.length > depth) { best = p; depth = root.length; }
    }
  }
  return best;
}

/** The linked project for a working folder: the same folder or one inside it (the deepest project
 *  root wins), else a project whose name or folder name matches the hint / the folder's last part. */
export function projectForCwd(projects, cwd, hint = '') {
  const list = Array.isArray(projects) ? projects : [];
  const best = projectForFolder(list, cwd);
  if (best) return best;
  const want = normPath(cwd);
  const names = [hint, want.split('/').pop()].map(squash).filter(Boolean);
  if (!names.length) return null;
  return list.find(p => names.includes(squash(p?.name)) || (p?.path && names.includes(squash(normPath(p.path).split('/').pop())))) || null;
}

/** Exact folder evidence from any supplied path outranks a basename guess from another. */
export function projectForPaths(projects, paths) {
  const list = Array.isArray(paths) ? paths : [];
  return list.map(path => projectForFolder(projects, path)).find(Boolean)
    || list.map(path => projectForCwd(projects, path)).find(Boolean) || null;
}

/** 'active' | 'idle' | 'error' for a session record; null when it is not shown (stopped / closed). */
export function sessionCityStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'running' || s === 'starting' || s.startsWith('queued')) return 'active';
  if (s === 'error' || s === 'failed') return 'error';
  if (s === 'idle') return 'idle';
  return null;
}

/** CodaClauda sessions → City agents. projectOf(id) resolves a stored project id (store.project). */
export function sessionAgents(list, projects, { projectOf = () => null, running = () => false } = {}) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s.id !== 'string') continue;
    const status = running(s.id) ? 'active' : sessionCityStatus(s.status);
    if (!status) continue;
    const provider = s.provider === 'codex' ? 'codex' : s.provider === 'claude' ? 'claude' : 'other';
    const project = projectOf(s.projectId) || projectForPaths(projects, [s.cwd, s.worktreePath]);
    const who = PROVIDER_NAME[provider] || 'Agent';
    const title = String(s.title || '').replace(/\s+/g, ' ').trim().slice(0, 80) || `${who} session`;
    const at = ms(s.lastActivityAt) || ms(s.createdAt);
    const id = `sess:${s.id}`;
    out.push({
      id, kind: 'session', sessionId: s.id, provider, name: title, label: `${who} session in CodaClauda`,
      status, sessionStatus: s.status || '', access: s.access || '', worktree: Boolean(s.worktreePath),
      activity: status === 'active' ? 'Working on a turn' : status === 'error' ? 'The last turn ended with an error' : 'Idle, waiting for you',
      currentProjectId: project?.id || null, homeProjectId: project?.id || null, cwd: s.cwd || s.worktreePath || '', visiting: false,
      lastSeenAt: at, unreadForOwner: 0, look: agentAvatar(id, provider, title),
    });
  }
  return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, MAX_SESSIONS);
}

/** Active external sessions → City agents, one per provider and folder. A folder where one of
 *  CodaClauda's own sessions of that provider was busy in the last 15 minutes is skipped: that file
 *  is most likely the CodaClauda session itself (the metadata carries no session id to tell them apart). */
export function externalAgents(list, projects, { own = [], now = Date.now() } = {}) {
  const busyHere = new Set(own.filter(s => s && now - ms(s.lastActivityAt) < ACTIVE_MS).map(s => `${s.provider}|${normPath(s.cwd)}`));
  const byKey = new Map();
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || e.active !== true) continue;
    const provider = e.provider === 'codex' ? 'codex' : e.provider === 'claude' ? 'claude' : null;
    if (!provider) continue;
    const folder = normPath(e.cwd) || squash(e.projectHint);
    if (!folder || busyHere.has(`${provider}|${normPath(e.cwd)}`)) continue;
    const key = `${provider}|${folder}`;
    const at = ms(e.modifiedAt);
    const prev = byKey.get(key);
    if (prev && prev.lastSeenAt >= at) { prev.count++; continue; }
    const project = projectForCwd(projects, e.cwd, e.projectHint);
    const name = String(e.title || '').replace(/\s+/g, ' ').trim().slice(0, 80) || `${PROVIDER_NAME[provider]} (desktop)`;
    const id = `ext:${key}`;
    byKey.set(key, {
      id, kind: 'external', provider, name, label: `${PROVIDER_NAME[provider]} session on this PC, outside CodaClauda`,
      status: 'active', activity: `Active in ${project?.name || String(e.projectHint || '').slice(0, 60) || 'a folder'} (file changed in the last 15 min)`,
      currentProjectId: project?.id || null, homeProjectId: project?.id || null, cwd: String(e.cwd || ''), projectHint: String(e.projectHint || ''),
      providerSessionId: String(e.providerSessionId || ''),
      visiting: false, lastSeenAt: at, unreadForOwner: 0, look: agentAvatar(id, provider, name), count: (prev?.count || 0) + 1,
    });
  }
  return [...byKey.values()];
}

/** owner/name of a project's GitHub repo (repo.full_name, a gh:owner/name id or a scanned
 *  github.com origin remote), or ''. */
export function repoOf(project) {
  const ok = name => /^[\w.-]+\/[\w.-]+$/.test(name);
  const full = String(project?.repo?.full_name || '').trim();
  if (ok(full)) return full;
  const id = (Array.isArray(project?.ids) ? project.ids : []).find(x => typeof x === 'string' && ok(x.slice(3)) && x.startsWith('gh:'));
  if (id) return id.slice(3);
  const remote = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(String(project?.stats?.git?.remote || '').trim());
  return remote && ok(remote[1]) ? remote[1] : '';
}

const completed = r => String(r.status || '').toLowerCase() === 'completed';
const failedRun = r => ['failure', 'timed_out', 'startup_failure'].includes(String(r.conclusion || '').toLowerCase());
/** ci_status runs → { latest (newest finished run, any branch), failing (it failed), defaultDone (newest
 *  finished run on the default branch), passing (that one succeeded), key (identifies that run) }. */
export function ciSummary(runs, defaultBranch = '') {
  const list = (Array.isArray(runs) ? runs : []).filter(r => r && typeof r === 'object').map(r => ({ ...r, t: ms(r.at) })).sort((a, b) => b.t - a.t);
  const isDefault = r => (defaultBranch ? r.branch === defaultBranch : ['main', 'master'].includes(r.branch));
  const latest = list.find(completed) || null;
  const done = list.find(r => completed(r) && isDefault(r)) || null;
  return {
    latest, defaultDone: done, running: list.some(r => !completed(r)),
    failing: Boolean(latest && failedRun(latest)),
    passing: Boolean(done && String(done.conclusion || '').toLowerCase() === 'success'),
    key: done ? `${done.url || ''}|${done.t}` : '',
  };
}

/** A fireworks burst is due when the newest finished default-branch run is a different run from the
 *  one seen last poll and it succeeded. The first poll only records a baseline. */
export function newlyPassed(prevKey, summary) {
  return prevKey !== undefined && Boolean(summary?.passing) && Boolean(summary.key) && summary.key !== prevKey;
}
