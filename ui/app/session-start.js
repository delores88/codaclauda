/* Shared owner UI session start. The existing native session_start command remains the
 * authority for provider, project and access admission; this only assembles its payload. */
import { providerLabel } from './session-model.js';

export async function startProjectSession(store, sessions, provider, project, { title = '', model = '', effort = '', worktree = false } = {}) {
  if (!['claude', 'codex'].includes(provider)) throw new Error('Choose Claude or Codex.');
  if (!project?.id || typeof project.path !== 'string' || !project.path.trim()) throw new Error('Choose a project with a local folder.');
  const access = store.projectAccess(project.id);
  if (!['full', 'read'].includes(access?.level)) throw new Error('Project access is unavailable.');
  return sessions.start({
    projectId: project.id, cwd: project.path, access: access.level, playwright: false,
    ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(worktree ? { worktree: true } : {}),
    provider, title: title || `${providerLabel(provider, true)} · ${project.name}`,
  });
}
