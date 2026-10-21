/* Agent-started teammates (0.5). Per project, the owner's switch "Agents can start teammates" (off by default)
 * and a guard on how many agent-started sessions may work there at once (8 by default, or unlimited). Agents
 * ask by posting a question to the board address codaclauda-team; the desktop answers with the new session's
 * address or a named refusal. The switch is the authority; a message is information and its sender is
 * self-asserted. See docs/TEAM.md.
 *   teamSettingsGet() → { address, projects: { [projectId]: { name, cwd, ids, agentsCanStart, maxAgentStartedLive } }, defaults }
 *   teamSettingsSet({ projectId, cwd, name, ids, agentsCanStart?, maxAgentStartedLive? }) → { projectId, project }
 * Events: team.on('change', fn). */
import { desktop } from './bridge.js';

export const TEAM_ADDRESS = 'codaclauda-team';
export const TEAM_DEFAULTS = Object.freeze({ agentsCanStart: false, maxAgentStartedLive: 8 });

/** A project's saved team setting, found under its id or any of its other ids; defaults when none. */
export function teamFor(projects, project) {
  const map = projects && typeof projects === 'object' ? projects : {};
  const ids = project ? [project.id, ...(Array.isArray(project.ids) ? project.ids : [])] : [];
  const found = ids.map(id => (Object.prototype.hasOwnProperty.call(map, id) ? [id, map[id]] : null)).find(Boolean);
  const saved = found?.[1] && typeof found[1] === 'object' ? found[1] : {};
  const guard = saved.maxAgentStartedLive;
  return {
    key: found?.[0] || project?.id || '',
    agentsCanStart: saved.agentsCanStart === true,
    maxAgentStartedLive: guard === 'unlimited' || (Number.isSafeInteger(guard) && guard >= 1) ? guard : TEAM_DEFAULTS.maxAgentStartedLive,
  };
}

/** The payload that saves one project's setting (the engine keeps the folder and ids it needs to match requests). */
export function teamPayload(project, patch, key = project?.id) {
  return { projectId: key, cwd: project?.path || '', name: project?.name || '', ids: [...new Set([project?.id, ...(project?.ids || [])].filter(Boolean))].slice(0, 32), ...patch };
}

class Team extends EventTarget {
  constructor() { super(); this.projects = null; this.error = ''; this._loading = null; }
  on(name, fn) { const handler = event => fn(event.detail); this.addEventListener(name, handler); return () => this.removeEventListener(name, handler); }
  changed() { this.dispatchEvent(new CustomEvent('change')); }
  supported() { return typeof desktop.teamSettingsGet === 'function' && typeof desktop.teamSettingsSet === 'function'; }

  async load() {
    if (!this.supported()) return;
    if (this._loading) return this._loading;
    this._loading = (async () => {
      try { const data = await desktop.teamSettingsGet(); this.projects = data?.projects && typeof data.projects === 'object' ? data.projects : {}; this.error = ''; }
      catch (error) { this.error = error?.message || String(error); }
      finally { this._loading = null; }
      this.changed();
    })();
    return this._loading;
  }

  get(project) { return teamFor(this.projects, project); }

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
