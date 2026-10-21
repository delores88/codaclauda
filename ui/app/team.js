/* Agent-started teammates (0.5; 0.6 defaults). Per project, the switch "Agents can start teammates" and a guard
 * on how many agent-started sessions may work there at once. A project without its own setting follows the
 * owner's standing default (Settings > Team: on, Unlimited); a saved project setting is never replaced by it.
 * Agents ask by posting a question to the board address codaclauda-team. The desktop answers "queued" (saved,
 * nothing started), then "admitted" once the teammate's first turn actually reached its provider, then one
 * outcome: completed, failed, refused or cancelled. A queued request can be cancelled by its sender or here.
 * The switch is the authority; a message is information and its sender is self-asserted. See docs/TEAM.md.
 *   teamSettingsGet() → { address, ownerDefault, projects: { [projectId]: { name, cwd, ids, agentsCanStart, maxAgentStartedLive, followsDefault } },
 *                         requests: [{ requestId, from, subject, status, at, sessionId, address, code, cancellable }], inboxError }
 *   teamSettingsSet({ projectId, cwd, name, ids, agentsCanStart?, maxAgentStartedLive? }) → { projectId, project }
 *   teamSettingsSet({ cancelRequest: requestId }) → { cancelled, requestId, requests }
 * Events: team.on('change', fn). */
import { desktop } from './bridge.js';

export const TEAM_ADDRESS = 'codaclauda-team';
export const TEAM_DEFAULTS = Object.freeze({ agentsCanStart: true, maxAgentStartedLive: 'unlimited' });
const validGuard = guard => guard === 'unlimited' || (Number.isSafeInteger(guard) && guard >= 1);

/** What each saved request state means, in the order a request moves through them. */
export const REQUEST_STATES = Object.freeze({
  queued: { label: 'Queued', hint: 'Saved; nothing has started yet.', tone: 'neutral' },
  starting: { label: 'Starting', hint: 'CodaClauda is creating the teammate.', tone: 'neutral' },
  launching: { label: 'Waiting to launch', hint: 'The session exists; its first turn has not reached its provider yet.', tone: 'neutral' },
  admitted: { label: 'Working', hint: 'Its first turn reached its provider.', tone: 'ok' },
  completed: { label: 'Finished first turn', hint: 'Its first turn finished; it stays available at its address.', tone: 'ok' },
  failed: { label: 'Failed', hint: 'It did not finish its first turn; the reply says why.', tone: 'bad' },
  refused: { label: 'Refused', hint: 'Nothing started; the reply names the setting that would change it.', tone: 'bad' },
  cancelled: { label: 'Cancelled', hint: 'Cancelled while queued; nothing started.', tone: 'neutral' },
  started: { label: 'Started (0.6.0)', hint: 'Answered by CodaClauda 0.6.0.', tone: 'ok' },
});

/** team_settings_get requests → plain rows, newest first, with a label for each state. */
export function requestRows(requests) {
  const text = v => (typeof v === 'string' ? v : '');
  return (Array.isArray(requests) ? requests : [])
    .filter(r => r && typeof r === 'object' && text(r.requestId))
    .map(r => {
      const state = REQUEST_STATES[r.status] || { label: text(r.status) || 'Unknown', hint: '', tone: 'neutral' };
      return { requestId: r.requestId, from: text(r.from), subject: text(r.subject), status: text(r.status), label: state.label, hint: state.hint, tone: state.tone,
        at: Number(r.at) || 0, sessionId: text(r.sessionId), address: text(r.address), code: text(r.code), cancellable: r.cancellable === true && r.status === 'queued' };
    })
    .sort((a, b) => b.at - a.at);
}

/** wake_settings_get pairs → [{ key, a, b, lastHour, reached, paused }], busiest first. */
export function pairRows(pairs) {
  return (Array.isArray(pairs) ? pairs : [])
    .filter(p => p && typeof p.key === 'string' && p.key.startsWith('pair:'))
    .map(p => ({ key: p.key, a: String(p.a || ''), b: String(p.b || ''), lastHour: Number.isSafeInteger(p.lastHour) && p.lastHour > 0 ? p.lastHour : 0, reached: p.reached === true, paused: p.paused === true }))
    .sort((x, y) => y.lastHour - x.lastHour || x.key.localeCompare(y.key));
}

/** A project's team setting, found under its id or any of its other ids; the owner's standing default
 *  (`fallback`, as team_settings_get reports it) when it has none. */
export function teamFor(projects, project, fallback = TEAM_DEFAULTS) {
  const map = projects && typeof projects === 'object' ? projects : {};
  const ids = project ? [project.id, ...(Array.isArray(project.ids) ? project.ids : [])] : [];
  const found = ids.map(id => (Object.prototype.hasOwnProperty.call(map, id) ? [id, map[id]] : null)).find(Boolean);
  const saved = found?.[1] && typeof found[1] === 'object' ? found[1] : null;
  const base = fallback && typeof fallback === 'object' ? fallback : TEAM_DEFAULTS;
  const guard = saved?.maxAgentStartedLive;
  return {
    key: found?.[0] || project?.id || '',
    agentsCanStart: saved ? saved.agentsCanStart === true : base.agentsCanStart === true,
    maxAgentStartedLive: validGuard(guard) ? guard : validGuard(base.maxAgentStartedLive) ? base.maxAgentStartedLive : TEAM_DEFAULTS.maxAgentStartedLive,
  };
}

/** The payload that saves one project's setting (the engine keeps the folder and ids it needs to match requests). */
export function teamPayload(project, patch, key = project?.id) {
  return { projectId: key, cwd: project?.path || '', name: project?.name || '', ids: [...new Set([project?.id, ...(project?.ids || [])].filter(Boolean))].slice(0, 32), ...patch };
}

class Team extends EventTarget {
  constructor() { super(); this.projects = null; this.ownerDefault = null; this.requests = []; this.inboxError = ''; this.error = ''; this._loading = null; }
  on(name, fn) { const handler = event => fn(event.detail); this.addEventListener(name, handler); return () => this.removeEventListener(name, handler); }
  changed() { this.dispatchEvent(new CustomEvent('change')); }
  supported() { return typeof desktop.teamSettingsGet === 'function' && typeof desktop.teamSettingsSet === 'function'; }
  /** True once the saved settings were read: before that, a project's own setting is unknown. */
  loaded() { return this.projects !== null && !this.error; }

  async load() {
    if (!this.supported()) return;
    if (this._loading) return this._loading;
    this._loading = (async () => {
      try {
        const data = await desktop.teamSettingsGet();
        this.projects = data?.projects && typeof data.projects === 'object' ? data.projects : {};
        this.ownerDefault = data?.ownerDefault && typeof data.ownerDefault === 'object' ? data.ownerDefault : null;
        this.requests = requestRows(data?.requests);
        this.inboxError = typeof data?.inboxError === 'string' ? data.inboxError : '';
        this.error = '';
      }
      catch (error) { this.error = error?.message || String(error); }
      finally { this._loading = null; }
      this.changed();
    })();
    return this._loading;
  }

  get(project) { return teamFor(this.projects, project, this.ownerDefault || TEAM_DEFAULTS); }

  async set(project, patch) {
    const current = this.get(project);
    const data = await desktop.teamSettingsSet(teamPayload(project, patch, current.key));
    if (!data?.project || typeof data.projectId !== 'string') throw new Error('Team settings did not confirm the change.');
    this.projects = { ...(this.projects || {}), [data.projectId]: data.project };
    this.changed();
    return data.project;
  }

  /** Owner cancel of a queued request; its sender gets the "cancelled" reply within seconds. */
  async cancelRequest(requestId) {
    const data = await desktop.teamSettingsSet({ cancelRequest: requestId });
    if (data?.cancelled !== true) throw new Error('Team settings did not confirm the cancel.');
    if (Array.isArray(data.requests)) this.requests = requestRows(data.requests);
    this.changed();
    return data;
  }
}

export const team = new Team();
