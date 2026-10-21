/* Agent-started teammates (0.5; 0.6 defaults). Per project, the switch "Agents can start teammates" and a guard
 * on how many agent-started sessions may work there at once. A project without its own setting follows the
 * owner's standing default (Settings > Team: on, Unlimited). Agents ask by posting to the board address
 * codaclauda-team; the desktop answers "received", then the new session's address or a named refusal. The
 * switch is the authority; a message is information and its sender is self-asserted. See docs/TEAM.md.
 *   teamSettingsGet() → { address, ownerDefault, projects: { [projectId]: { name, cwd, ids, agentsCanStart, maxAgentStartedLive, followsDefault } } }
 *   teamSettingsSet({ projectId, cwd, name, ids, agentsCanStart?, maxAgentStartedLive? }) → { projectId, project }
 * Events: team.on('change', fn). */
import { desktop } from './bridge.js';

export const TEAM_ADDRESS = 'codaclauda-team';
export const TEAM_DEFAULTS = Object.freeze({ agentsCanStart: true, maxAgentStartedLive: 'unlimited' });
const validGuard = guard => guard === 'unlimited' || (Number.isSafeInteger(guard) && guard >= 1);

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
  constructor() { super(); this.projects = null; this.ownerDefault = null; this.error = ''; this._loading = null; }
  on(name, fn) { const handler = event => fn(event.detail); this.addEventListener(name, handler); return () => this.removeEventListener(name, handler); }
  changed() { this.dispatchEvent(new CustomEvent('change')); }
  supported() { return typeof desktop.teamSettingsGet === 'function' && typeof desktop.teamSettingsSet === 'function'; }

  async load() {
    if (!this.supported()) return;
    if (this._loading) return this._loading;
    this._loading = (async () => {
      try {
        const data = await desktop.teamSettingsGet();
        this.projects = data?.projects && typeof data.projects === 'object' ? data.projects : {};
        this.ownerDefault = data?.ownerDefault && typeof data.ownerDefault === 'object' ? data.ownerDefault : null;
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
}

export const team = new Team();
