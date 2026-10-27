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
  /** Clones owner/name into parentDir\name with the GitHub CLI, as `account` when that is another signed-in account → { path, full_name, url }. */
  cloneRepo: ({ fullName, parentDir, account = null, createParent = false }) => invoke('github_clone_repo', { fullName, parentDir, account, createParent }),
  /** Logins signed into the GitHub CLI on this PC (never tokens) → { accounts: [{ login, active }] }. */
  githubAccounts: () => invoke('github_accounts'),
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

  /* 0.4.1 wake on mail (src-tauri/src/session_host/wake.rs). Records gain wake, mailboxAddress|null, wakes { hour, day, total }.
   * 0.5: new sessions start with wake on; no session or rate caps, only the owner's loop guard. Records also gain
   * live (an owned process is running or starting) and startedBy { address, messageId, at } for team starts. */
  /** Turns wake on mail on or off for one session (on: registers its board address) → { session } */
  sessionSetWake: ({ id, on }) => invoke('session_set_wake', { id, on: Boolean(on) }),
  /** Global switch and loop guard → { enabled, loopGuard: { on, pairPerHour, mode }, pairs (0.6): [{ key, a, b, lastHour, reached, paused }] } */
  wakeSettingsGet: () => invoke('wake_settings_get'),
  /** Accepts a boolean, { enabled }, { loopGuard: { on?, pairPerHour? } } and/or (0.6) { pair: { key, paused } } to pause or
   *  resume one pair of sessions waking each other; omitted fields stay → same shape */
  wakeSettingsSet: arg => {
    const value = arg && typeof arg === 'object' ? arg : { enabled: arg };
    const args = {};
    if (value.enabled !== undefined) args.enabled = Boolean(value.enabled);
    if (value.loopGuard && typeof value.loopGuard === 'object') args.loopGuard = value.loopGuard;
    if (value.pair && typeof value.pair === 'object') args.pair = { key: String(value.pair.key || ''), paused: Boolean(value.pair.paused) };
    return invoke('wake_settings_set', args);
  },
  /** 0.5 team starts (src-tauri/src/session_host/team.rs) → { address: 'codaclauda-team', pollSeconds, ownerDefault (0.6: on, 'unlimited'),
   *  projects: { [projectId]: { name, cwd, ids, agentsCanStart, maxAgentStartedLive (effective), followsDefault, autoRegistered, access?, updatedAt } },
   *  requests (0.6, newest first): [{ requestId, from, subject, status: 'queued'|'admitted'|'completed'|'failed'|'refused'|'cancelled'|…, at, address?, cancellable }],
   *  inboxError (0.6): string|null } */
  teamSettingsGet: () => invoke('team_settings_get'),
  /** { projectId, cwd, name?, ids?, agentsCanStart?, maxAgentStartedLive?: number|'unlimited', useDefault?, remove? } → { projectId, project };
   *  { ownerDefault: { agentsCanStart?, maxAgentStartedLive? } } → { ownerDefault } (0.6);
   *  { cancelRequest: requestId } → { cancelled, requestId, requests } (0.6; only a queued request) */
  teamSettingsSet: project => invoke('team_settings_set', { project }),

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
  /** 0.6: continue a conversation found on this PC as a separate, labeled copy (Claude --resume --fork-session /
   *  Codex thread/fork), wake on, at the project's current access (Read outside linked or own folders) → { session, copy: true }.
   *  The original is never changed and its app is not woken. mode 'continue' is always refused with OWNERSHIP_UNKNOWN,
   *  because CodaClauda can't establish who owns another app's conversation (an id match is not provenance). */
  sessionAdopt: ({ provider, providerSessionId, cwd, title = null, mode = null }) => invoke('session_adopt', { provider, providerSessionId, cwd, title: title || null, mode: mode || null }),
  /** 0.6 Wake by mail for an existing Codex desktop chat (src-tauri/src/session_host/desktop_queue.rs). New board mail for a
   *  bound address runs Codex's own `codex queue --thread <id> --message <notice>` once per batch: counts and sender names only,
   *  nothing acknowledged → { bindings: [{ address, provider, threadId, cwd, projectId, boundAt, cursor, last }], wakeEnabled, pollSeconds }.
   *  last: { at, status: 'queued'|'unreachable'|'failed'|'timeout'|'cancelled'|'not-started'|'refused'|'unknown'|'sending',
   *          exitCode|null, messages, more, through, senders, detail, stdout, stderr } | null */
  desktopBindingsGet: () => invoke('desktop_bindings_get'),
  /** Owner only. Verifies the thread is a Codex conversation on this PC inside a linked project → { binding, bindings } */
  desktopBind: ({ address, threadId }) => invoke('desktop_bind', { address, threadId }),
  /** Stops a delivery in progress for it → { unbound, bindings } */
  desktopUnbind: arg => invoke('desktop_unbind', { address: arg && typeof arg === 'object' ? arg.address : arg }),
  /** 0.6 usage setting (src-tauri/src/session_host/usage.rs), app-wide, owner only →
   *  { codex: { useCredits, useResets }, claude: { useCredits }, error|null } (every flag defaults to true) */
  usageSettingsGet: () => invoke('usage_settings_get'),
  /** { provider:'codex'|'claude', useCredits?, useResets? (Codex only) } → same shape */
  usageSettingsSet: ({ provider, useCredits, useResets } = {}) => invoke('usage_settings_set', { provider, useCredits: useCredits ?? null, useResets: useResets ?? null }),
  /** The latest plan snapshot → { provider, snapshot|null, at|null, limited, resetsAt (unix s)|null, ... }
   *  (Codex also state: 'allowed'|'limited'|'unknown', resetCredits|null, accountReported; Claude overage, resets: 'unsupported') */
  usageStatus: arg => invoke('usage_status', { provider: arg && typeof arg === 'object' ? arg.provider : arg }),
  /** 0.6 Continue after a usage-limit stop: a new owner turn (origin { kind: 'continue', turnId }, keyed continue:<turnId>)
   *  for the chat's recorded usageStopped turn once it has ended; never a replay → { accepted, turnId, queued, duplicate }.
   *  Errors NOT_STOPPED, SESSION_BUSY. Session records and 'usage' events carry held and usageStopped. */
  sessionContinue: ({ id, turnId }) => invoke('session_continue', { id, turnId }),
  /** 0.6 Try now for the chat's held turn (never sent): normal admission, then the usage gate with fresh state →
   *  { released: true, turnId } | { released: false }. Error NOT_HELD. Stop or close cancels a held turn instead. */
  sessionRetryHeld: arg => invoke('session_retry_held', { id: sessionId(arg) }),
  /** → { servers: [{ name, command, args, env }], presets: [{ id, label, name, command, args, env, install, notes, source }] }.
   *  Servers reach sessions only at Full access; CodaClauda never installs them (presets are text). */
  mcpServersGet: arg => invoke('mcp_servers_get', { projectId: arg && typeof arg === 'object' ? arg.projectId : arg }),
  /** Replaces the project's list (validated: names [A-Za-z0-9_-], ≤ 12 servers) → { servers } */
  mcpServersSet: ({ projectId, servers = [] }) => invoke('mcp_servers_set', { projectId, servers }),
  /** Phone push → { ntfyUrl|null, onFinish, onError } */
  notifySettingsGet: () => invoke('notify_settings_get'),
  /** ntfyUrl must be https (null or '' turns push off) → { ntfyUrl, onFinish, onError } */
  notifySettingsSet: ({ ntfyUrl = null, onFinish = false, onError = false } = {}) => invoke('notify_settings_set', { ntfyUrl: ntfyUrl || null, onFinish: Boolean(onFinish), onError: Boolean(onError) }),
  /** One owner-triggered synthetic test to the saved URL; no destination/body arguments. Returns a durable send receipt, not phone delivery. */
  notifyTest: () => invoke('notify_test'),
  /** Owner-only phone messaging (0.6.1): { enabled, topicUrl|null, lastRecipient|null, recipients:[{address,label}], lastError|null }. Uses notify.ntfyUrl. */
  phoneSettingsGet: () => invoke('phone_settings_get'),
  phoneSettingsSet: ({ enabled } = {}) => invoke('phone_settings_set', { enabled: Boolean(enabled) }),
  /** Owner setting: CodaClauda sessions working at once (Settings → Limits) → { maxLive, queueMax } */
  sessionLimitsGet: () => invoke('session_limits_get'),
  /** maxLive is a whole number ≥ 1 or 'unlimited' (the default) → { maxLive, queueMax } */
  sessionLimitsSet: ({ maxLive } = {}) => invoke('session_limits_set', { maxLive: maxLive === 'unlimited' ? 'unlimited' : Number(maxLive) }),
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
