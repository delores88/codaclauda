/* Fixed bridge to the native CodaClauda shell. There is no generic shell or
 * filesystem command: every call is one named Tauri command. Outside the
 * desktop app (browser preview) a local mock backend is loaded instead. */

const tauri = () => window.__TAURI__?.core;
let mockBackend = null;

export const isNative = () => Boolean(tauri());

async function backend() {
  if (tauri()) return tauri();
  if (!mockBackend) mockBackend = (await import('../dev/mock.js')).createMock();
  return mockBackend;
}

export async function invoke(command, args = {}) {
  const api = await backend();
  const result = await api.invoke(command, args);
  if (!result || result.ok !== true) {
    const error = new Error(result?.error?.message || 'The local operation failed.');
    error.code = result?.error?.code || 'UNKNOWN_ERROR';
    throw error;
  }
  return result.data;
}

/** Coordination board operation through the bundled CLI (JSON in, JSON out). */
export const rpc = (op, args = {}) => invoke('rpc', { op, args });

/* Session commands accept { id } or a bare id. */
const sessionId = arg => (arg && typeof arg === 'object' ? arg.id : arg);

/** Desktop-only helpers implemented in src-tauri/src/desktop.rs. */
export const desktop = {
  paths: () => invoke('desktop_paths'),
  loadState: () => invoke('desktop_state_load'),
  saveState: state => invoke('desktop_state_save', { state }),
  loadManifest: () => invoke('desktop_manifest_load'),
  scanProject: path => invoke('project_scan', { path }),
  discoverDesktop: () => invoke('desktop_discover_projects'),
  githubUser: () => invoke('github_user'),
  githubRepos: user => invoke('github_repos', { user }),
  /** Repos the signed-in gh account reaches as a collaborator / org member (never its own) → { user, repos, truncated }. */
  githubCollabRepos: () => invoke('github_collab_repos'),
  /** Creates a repo (with a README) in the GitHub CLI's signed-in account and clones it into parentDir\name → { path, full_name, url }. */
  createRepo: ({ name, description = '', private: isPrivate = true, parentDir }) => invoke('github_create_repo', { name, description, private: isPrivate, parentDir }),
  /** Clones owner/name into parentDir\name with the GitHub CLI → { path, full_name, url }. */
  cloneRepo: ({ fullName, parentDir }) => invoke('github_clone_repo', { fullName, parentDir }),
  saveAttachment: (name, dataBase64) => invoke('attachment_save', { name, dataBase64 }),
  startDictation: () => invoke('dictation_start'),
  attention: () => invoke('window_attention'),
  /** Opens an http(s) URL in the default browser or an existing folder in Explorer. */
  openExternal: target => invoke('open_external', { target }),
  pickFolder: () => invoke('pick_workspace'),
  preferences: () => invoke('preferences'),
  /** Native updater: op is check | status | authorize | poll | download | install (no other args). */
  update: op => invoke('update', { op, args: {} }),
  /** MET Norway current weather; coordinates are rounded to 2 decimals natively → { symbol_code, air_temperature, wind_speed, cloud_area_fraction, precipitation_amount, updated_at, expires, lat, lon }. */
  weatherNow: (lat, lon) => invoke('weather_now', { lat, lon }),
  /** OpenStreetMap Nominatim search, on an explicit search only → [{ name, display_name, lat, lon }]. */
  geocodePlace: query => invoke('geocode_place', { query, language: globalThis.navigator?.language || 'en' }),

  /* 0.4 agent sessions (src-tauri/src/session_host.rs). Times are epoch milliseconds. */
  /** → { sessions: [{ id, provider, projectId, cwd, title, access, threadId, providerSessionId, status, createdAt, lastActivityAt, shared, sharedId }] } */
  sessionList: () => invoke('session_list'),
  /** { provider:'claude'|'codex', projectId, cwd, access:'full'|'read', title, playwright, model?, effort?, sharedId?, worktree? } → { session } */
  sessionStart: options => invoke('session_start', { args: options || {} }),
  /** → { accepted: true, turnId, queued }. A busy session queues the turn (up to 50 waiting; queued = how many wait,
   *  0 when it started now) and emits kind 'queued' { count }. The 'user' event arrives when the turn starts.
   *  Replies stream on desktop.onSessionEvent. */
  sessionSend: ({ id, text = '', attachments = [] }) => invoke('session_send', { id, text, attachments }),
  /** Interrupts the current turn; the session stays resumable → { stopped: true } */
  sessionStop: arg => invoke('session_stop', { id: sessionId(arg) }),
  /** Ends the provider process and keeps the history → { closed: true } */
  sessionClose: arg => invoke('session_close', { id: sessionId(arg) }),
  /** Display log → { events: [...] } */
  sessionHistory: arg => invoke('session_history', arg?.limit == null ? { id: sessionId(arg) } : { id: sessionId(arg), limit: arg.limit }),
  /** cb(payload) for every 'session://event' ({ id, turnId, kind, text?, tool?, status?, error?, at }). Resolves to an unlisten function.
   *  0.4.1 kinds: 'wake' { from, subject, messageId, messageKind, wakes } and 'queued' { count, status: 'queued (n)' }.
   *  A 'user' event for a wake or scheduled turn carries origin { kind: 'wake'|'schedule', ... }; owner turns have none. */
  onSessionEvent: cb => listenTo('session://event', cb),

  /* 0.4.1 wake on mail (src-tauri/src/session_host/wake.rs). Records gain wake, mailboxAddress|null, wakes { hour, day, total }. */
  /** Turns wake on mail on or off for one session (on: registers its board address) → { session } */
  sessionSetWake: ({ id, on }) => invoke('session_set_wake', { id, on: Boolean(on) }),
  /** Global kill switch → { enabled } */
  wakeSettingsGet: () => invoke('wake_settings_get'),
  /** Accepts { enabled } or a boolean → { enabled } */
  wakeSettingsSet: arg => invoke('wake_settings_set', { enabled: Boolean(arg && typeof arg === 'object' ? arg.enabled : arg) }),

  /* 0.4.1 scheduled tasks (src-tauri/src/session_host/schedule.rs); they run only while the app is open.
   * Schedule: { id, name, projectId, cwd, provider, prompt, cadence, enabled, catchUp, lastRunAt, nextRunAt, sessionId, access? }
   * cadence: { kind:'interval', minutes >= 15 } | { kind:'daily', time:'HH:MM', days:[0-6] } (0 = Sunday; [] = every day).
   * Run: { at, status:'sent'|'done'|'error', sessionId, turnId, trigger:'timer'|'catch-up'|'manual', endedAt?, error? } */
  /** → { schedules: [...] } */
  scheduleList: () => invoke('schedule_list'),
  /** Creates when there is no id, else updates → { schedule } */
  scheduleSave: arg => invoke('schedule_save', { schedule: (arg && typeof arg.schedule === 'object' ? arg.schedule : arg) || {} }),   // accepts {schedule} or the bare schedule
  /** → { deleted: true } */
  scheduleDelete: arg => invoke('schedule_delete', { id: sessionId(arg) }),
  /** Runs once now, whatever the cadence → { run } */
  scheduleRunNow: arg => invoke('schedule_run_now', { id: sessionId(arg) }),
  /** Newest first → { runs: [...] } */
  scheduleRuns: arg => invoke('schedule_runs', arg?.limit == null ? { id: sessionId(arg) } : { id: sessionId(arg), limit: arg.limit }),
  /** cb(payload) for every 'schedule://event' ({ id, kind: 'run'|'error', run }). Resolves to an unlisten function. */
  onScheduleEvent: cb => listenTo('schedule://event', cb),

  /* 0.5 (src-tauri/src/session_host/{fork,worktree,external,mcp,notify}.rs, src-tauri/src/project_tools.rs).
   * sessionStart also takes worktree:boolean (git projects only; error NOT_A_GIT_REPO otherwise).
   * Records gain worktreePath|null, branch|null and usage { input, output, cached, costUsd|null, contextPct|null };
   * optionally forkedFrom, handoffFrom, prUrl, prNumber, rateLimits (Codex: { primary, secondary, planType, at }).
   * 'session://event' gains kind 'usage' { usage, rateLimits? } (not persisted). costUsd is Claude's own estimate; Codex never has one. */
  /** Copies the whole conversation into a new chat (Claude --resume --fork-session / Codex thread/fork on its first send) → { session }.
   *  Error NOTHING_TO_FORK before the first reply. */
  sessionFork: arg => invoke('session_fork', { id: sessionId(arg) }),
  /** Starts the other agent in the same folder; its first turn is a summary of the last ~12 exchanges (≤ ~6,000 chars) → { session } */
  sessionHandoff: ({ id, toProvider }) => invoke('session_handoff', { id, toProvider: toProvider || null }),
  /** Changes vs the worktree's base (or vs HEAD for a chat without a worktree) → { files: [{ path, status, additions, deletions }], patch, truncated } */
  sessionDiff: arg => invoke('session_diff', { id: sessionId(arg) }),
  /** Commits the worktree and merges codaclauda/<short> into the original branch → { committed, merged, branch }.
   *  Errors: SESSION_BUSY, NO_WORKTREE, BASE_NOT_CHECKED_OUT, MERGE_FAILED (merge aborted). */
  sessionWorktreeApply: ({ id, message = '' }) => invoke('session_worktree_apply', { id, message }),
  /** Removes the worktree and its branch; the chat stays readable but stopped → { discarded: true } */
  sessionWorktreeDiscard: arg => invoke('session_worktree_discard', { id: sessionId(arg) }),
  /** Commits, pushes the branch and runs gh pr create → { url, number } */
  sessionPrCreate: ({ id, title, body = '' }) => invoke('session_pr_create', { id, title, body }),
  /** gh pr view for the chat's branch → { url|null, state|null ('open'|'merged'|'closed'), checks: [{ name, status, conclusion }] } (lowercase) */
  sessionPrStatus: arg => invoke('session_pr_status', { id: sessionId(arg) }),
  /** Codex compact-now (queued as a turn) → { ok: true }. Claude: error COMPACT_UNSUPPORTED (slash commands are disabled). */
  sessionCompact: arg => invoke('session_compact', { id: sessionId(arg) }),
  /** Other Claude Code / Codex sessions on this machine, metadata only →
   *  { sessions: [{ provider, cwd, projectHint, modifiedAt, active (modified < 15 min ago), owned (started by CodaClauda) }] } */
  externalSessionsList: () => invoke('external_sessions_list'),
  /** → { servers: [{ name, command, args, env }], presets: [{ id, label, name, command, args, env, install, notes, source }] }.
   *  Servers reach sessions only at Full access; CodaClauda never installs them (presets are text). */
  mcpServersGet: arg => invoke('mcp_servers_get', { projectId: arg && typeof arg === 'object' ? arg.projectId : arg }),
  /** Replaces the project's list (validated: names [A-Za-z0-9_-], ≤ 12 servers) → { servers } */
  mcpServersSet: ({ projectId, servers = [] }) => invoke('mcp_servers_set', { projectId, servers }),
  /** Phone push → { ntfyUrl|null, onFinish, onError } */
  notifySettingsGet: () => invoke('notify_settings_get'),
  /** ntfyUrl must be https (null or '' turns push off) → { ntfyUrl, onFinish, onError } */
  notifySettingsSet: ({ ntfyUrl = null, onFinish = false, onError = false } = {}) => invoke('notify_settings_set', { ntfyUrl: ntfyUrl || null, onFinish: Boolean(onFinish), onError: Boolean(onError) }),
  /** Owner setting: CodaClauda sessions working at once (Settings → Limits) → { maxLive, queueMax } */
  sessionLimitsGet: () => invoke('session_limits_get'),
  /** maxLive is a whole number 1-32 (default 6) → { maxLive, queueMax } */
  sessionLimitsSet: ({ maxLive } = {}) => invoke('session_limits_set', { maxLive: Number(maxLive) }),
  /** file: 'CLAUDE.md' | 'AGENTS.md' at the project root (≤ 200 KB) → { text, exists } */
  projectInstructionsRead: ({ projectId = null, cwd, file }) => invoke('project_instructions_read', { projectId, cwd, file }),
  /** → { ok: true } */
  projectInstructionsWrite: ({ projectId = null, cwd, file, text = '' }) => invoke('project_instructions_write', { projectId, cwd, file, text }),
  /** gh run list for repo 'owner/name' → { runs: [{ name, title, status, conclusion, branch, url, at }] } (lowercase; at = epoch ms) */
  ciStatus: ({ projectId = null, repo }) => invoke('ci_status', { projectId, repo }),
};

async function listenTo(name, cb) {
  const events = window.__TAURI__?.event;
  if (tauri() && events?.listen) return events.listen(name, event => cb(event.payload));
  const api = await backend();
  return api.listen ? api.listen(name, cb) : () => {};
}
