/* City placement memory. Only project identifiers are persisted, never message text.
 * These are visual hints; a mailbox address and its history grant no authority. */
import { projectForCwd } from './agents-extra.js';

export const AGENT_PROJECT_PREF = 'cityAgentProjectsV1';
export const AGENT_PROJECT_TIME_PREF = 'cityAgentProjectsObservedV1';
const stamp = value => {
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : 0;
};
const recordTime = record => stamp(record?.updatedAt ?? record?.updated_at ?? record?.at ?? record?.createdAt ?? record?.created_at);
const list = value => Array.isArray(value) ? value : [];

/** Current project wins. Otherwise use the newest known cwd, turn, assignment or board
 * signal, then the saved address -> project map. Hidden/deleted last locations stay saved
 * but render at HQ, so hiding a building never relocates its agent to an unrelated one. */
export function locateAgents(agents, {
  projects = [], visibleProjects = projects, remembered = {}, sessions = [], messages = [],
  assignments = [], matchProject = () => null, rememberedAt = {}, now = Date.now(),
} = {}) {
  const canonical = new Map();
  for (const p of projects) for (const id of [p.id, ...list(p.ids)]) canonical.set(id, p);
  const visible = new Set(visibleProjects.map(p => canonical.get(p.id)?.id || p.id));
  const resolve = id => canonical.get(id) || null;
  const saved = { ...remembered };
  const observed = { ...rememberedAt };
  let changed = false;
  const located = list(agents).map(agent => {
    const session = list(sessions).find(s => s.id === agent.sessionId);
    const address = agent.address || session?.mailboxAddress || agent.mailboxAddress || agent.id;
    // Store's legacy currentProjectId also contains a configured-home fallback. The
    // explicit observation field keeps that fallback from erasing the last workplace.
    const current = resolve('observedProjectId' in agent ? agent.observedProjectId : agent.currentProjectId);
    const previous = typeof remembered[address] === 'string' ? remembered[address] : null;
    const previousAt = Number(rememberedAt[address]) || 0;
    const signals = [];
    const add = (record, time = 0) => {
      if (!record) return;
      const project = resolve(record.projectId || record.project_id || record.project?.id)
        || projectForCwd(projects, record.cwd || record.workspace || record.worktreePath)
        || matchProject(`${record.subject || ''}\n${record.body || record.prompt || record.text || ''}`, projects);
      if (project) signals.push({ project, at: recordTime(record) || time });
    };
    add({ cwd: agent.cwd || session?.cwd, projectId: session?.projectId }, stamp(agent.lastSeenAt) || recordTime(session));
    for (const record of [agent.lastTurn, session?.lastTurn, agent.lastAssignment, session?.lastAssignment, ...list(agent.requests)]) add(record);
    for (const record of list(assignments)) if ([record.agentId, record.address, record.assignee, record.to].includes(address) || record.agentId === agent.id) add(record);
    for (const record of list(messages)) if (record.from === address || record.to === address) add(record);
    signals.sort((a, b) => b.at - a.at);
    const newest = signals[0];
    const newer = newest && (!previous || newest.at > previousAt);
    const last = newer ? newest.project : previous ? resolve(previous) : resolve(agent.lastKnownProjectId) || resolve(agent.homeProjectId);
    const knownId = current?.id || last?.id || previous || null;
    const currentAt = current && Math.max(stamp(agent.projectObservedAt), ...signals.filter(s => s.project.id === current.id).map(s => s.at));
    const at = current ? Math.max(previousAt, currentAt || 0, resolve(previous)?.id === current.id ? 0 : now)
      : newer ? newest.at : previousAt;
    if (knownId && saved[address] !== knownId) { saved[address] = knownId; changed = true; }
    if (knownId && at > 0) observed[address] = at;
    const location = current || last;
    const projectId = location && visible.has(location.id) ? location.id : null;
    return { ...agent, address: agent.address || session?.mailboxAddress || agent.mailboxAddress,
      currentProjectId: current?.id || null, lastKnownProjectId: last?.id || previous || null,
      cityProjectId: projectId };
  });
  // A managed session and its board address can both be visible. Compare the final
  // maps so their intermediate hints do not create an endless prefs change loop.
  const differs = (a, b) => Object.keys(a).length !== Object.keys(b).length || Object.keys(a).some(id => a[id] !== b[id]);
  changed = differs(saved, remembered) || differs(observed, rememberedAt);
  return { agents: located, remembered: saved, rememberedAt: observed, changed };
}
