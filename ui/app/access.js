/* Project access for the sessions CodaClauda starts (0.4.0). Two levels only:
 *   full  agents work without permission prompts;
 *   read  agents may read, search and explain, but not change files, commit or push.
 * Default: full for Ben's own projects (a local folder, or a GitHub repo owned by delores88),
 * read for anything else. Spending is never allowed at any level.
 * The level is fixed when a session starts; a change applies to the next session started in
 * the project. Desktop chats and sessions opened in a terminal are outside it and follow their
 * own app's permissions. A mailbox message never grants or changes a level.
 *
 * Record (desktop.projectAccess[projectId]): { level: 'full'|'read', playwright: boolean, updatedAt }.
 * Pure helpers (no DOM, no imports) so node can test them. Adapted, simplified to two levels,
 * from the claude/033-access-ticker access model. */

export const OWNER_GITHUB = 'delores88';
export const LEVELS = [
  { id: 'full', label: 'Full', long: 'Full access', color: '#ff6b3d', rule: 'Agents work without permission prompts.' },
  { id: 'read', label: 'Read only', long: 'Read only', color: '#4f8cff', rule: 'Agents can read, search and explain, but not change files, commit or push.' },
];
export const LEVEL_IDS = LEVELS.map(l => l.id);
export const ACCESS_NOTE = "Access is enforced for sessions CodaClauda starts. Desktop chats and sessions you open in a terminal follow their own app's permissions. Spending is never allowed.";
export const levelInfo = id => LEVELS.find(l => l.id === id) || LEVELS[1];

/** 'full' | 'read' for a stored value (older 'read-only' reads as 'read'); anything else → null. */
export function normalizeLevel(value) {
  if (value === 'full') return 'full';
  if (value === 'read' || value === 'read-only') return 'read';
  return null;
}

/** GitHub owners a project is linked to (from its repo and gh:owner/name ids), lower case. */
export function githubOwners(project) {
  const names = [project?.repo?.full_name, ...(Array.isArray(project?.ids) ? project.ids : []).filter(id => typeof id === 'string' && id.startsWith('gh:')).map(id => id.slice(3))];
  return [...new Set(names.map(name => String(name || '').split('/')[0].trim().toLowerCase()).filter(Boolean))];
}

/** Ben's own: a local folder, or a GitHub repo owned by delores88. */
export function ownedByBen(project) {
  if (!project) return false;
  if (String(project.path || '').trim()) return true;
  return githubOwners(project).includes(OWNER_GITHUB);
}
export const defaultLevel = project => (ownedByBen(project) ? 'full' : 'read');

/** The project's access from the map ({ [projectId]: record }); the first of project.ids with a record wins. */
export function accessFor(project, map) {
  const m = map && typeof map === 'object' ? map : {};
  const ids = project ? (Array.isArray(project.ids) && project.ids.length ? project.ids : [project.id]) : [];
  const own = id => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(m, id) ? m[id] : undefined);
  const record = ids.map(own).find(r => r && typeof r === 'object') || null;
  const stored = normalizeLevel(record?.level);
  const at = Number(record?.updatedAt);
  return { level: stored || defaultLevel(project), playwright: record?.playwright === true, explicit: Boolean(stored), updatedAt: Number.isFinite(at) && at > 0 ? at : 0 };
}
