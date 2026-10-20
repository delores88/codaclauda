/* Drag to assign (0.5): drop an agent on a building → "Give <agent> a task on <project>". The task
 * goes to that agent's CodaClauda session on the project when one is open, else a new CodaClauda
 * session starts there with the agent's provider at the project's access level. Everything runs
 * through sessions.js (desktop.sessionStart / desktop.sessionSend); a desktop session outside
 * CodaClauda is never messaged (its metadata is all the City has).
 * planAssign is pure (node tests import it); openAssignDialog builds the dialog. */
import { h, icon, modal, toast } from '../ui.js';
import { normPath, PROVIDER_NAME } from './agents-extra.js';

const LIVE = new Set(['idle', 'running', 'error', 'starting']);
const inProject = (s, project) => {
  if (!s || !project) return false;
  if (s.projectId && (s.projectId === project.id || (project.ids || []).includes(s.projectId))) return true;
  const root = normPath(project.path), cwd = normPath(s.cwd);
  return Boolean(root && cwd && (cwd === root || cwd.startsWith(`${root}/`)));
};

/** What dropping `agent` on `project` does:
 *  { provider|null, existing: session|null, canStart, reason } — existing: the session the task goes
 *  to by default (the agent's own session when it is on this project, else the newest open CodaClauda
 *  session of that provider there); canStart: the project has a local folder to start a session in. */
export function planAssign(agent, project, list = []) {
  const sessions = (Array.isArray(list) ? list : []).filter(s => s && LIVE.has(String(s.status || '').toLowerCase()) && !s.shared);
  const provider = agent?.provider === 'claude' || agent?.provider === 'codex' ? agent.provider : null;
  const own = agent?.kind === 'session' ? sessions.find(s => s.id === agent.sessionId) : null;
  let existing = own && inProject(own, project) ? own : null;
  if (!existing && provider) existing = sessions.filter(s => s.provider === provider && inProject(s, project)).sort((a, b) => (Number(b.lastActivityAt) || 0) - (Number(a.lastActivityAt) || 0))[0] || null;
  const canStart = Boolean(String(project?.path || '').trim());
  const reason = canStart ? '' : `${project?.name || 'This project'} has no local folder on this PC, so a session can't start there. Clone it from Projects first.`;
  return { provider, existing, canStart, reason };
}

const titleFrom = text => { const line = String(text || '').replace(/\s+/g, ' ').trim(); return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line || 'City task'; };

/** Opens the dialog. ctx: { store, sessions, navigate }. Resolves when it closes. */
export function openAssignDialog({ store, sessions, navigate }, agent, project) {
  if (!sessions?.supported?.()) { toast('Giving tasks from the City needs CodaClauda 0.4 desktop sessions.', { kind: 'error' }); return; }
  const plan = planAssign(agent, project, sessions.list);
  const access = store.projectAccess ? store.projectAccess(project) : { level: 'read' };
  const levelText = access.level === 'full' ? 'Full access' : 'Read only';
  const task = h('textarea.textarea', { rows: 4, maxlength: 20000, placeholder: `What should ${agent.provider === 'codex' ? 'Codex' : agent.provider === 'claude' ? 'Claude' : 'the agent'} do in ${project.name}?`, 'aria-label': 'Task' });
  const providerSelect = h('select.select', { 'aria-label': 'Agent to use' }, h('option', { value: 'claude' }, 'Claude Code'), h('option', { value: 'codex' }, 'Codex'));
  providerSelect.value = plan.provider || 'claude';
  const fresh = h('input', { type: 'checkbox' });
  const note = h('p.field-hint.city-assign-note');
  const error = h('p.city-assign-error', { hidden: true, role: 'alert' });
  const describe = () => {
    const provider = plan.provider || providerSelect.value;
    const sending = plan.existing && !fresh.checked;
    note.textContent = sending
      ? `Sends to the open chat “${plan.existing.title || 'session'}” (${plan.existing.access === 'full' ? 'Full access' : 'Read only'}). It queues if a turn is running.`
      : plan.canStart ? `Starts a new ${PROVIDER_NAME[provider] || 'agent'} chat in ${project.name} at ${levelText} (this project's access level).`
        : plan.reason;
  };
  fresh.addEventListener('change', describe); providerSelect.addEventListener('change', describe);
  describe();
  const external = agent.kind === 'external' ? h('p.field-hint.city-assign-ext', icon('plug'), ` ${agent.name} runs outside CodaClauda, so it can't be messaged from here. The task goes to a CodaClauda ${PROVIDER_NAME[agent.provider] || ''} chat instead.`) : null;
  const body = h('div.city-assign',
    h('label.field', 'Task', task),
    plan.provider ? null : h('label.field', 'Agent', providerSelect),
    plan.existing && plan.canStart ? h('label.city-assign-fresh', fresh, ' Start a new chat instead') : null,
    note, external, error);
  let started = null;
  const run = async () => {
    const text = task.value.trim();
    error.hidden = true;
    if (!text) { error.textContent = 'Type the task first.'; error.hidden = false; task.focus(); return false; }
    const sendTo = plan.existing && !fresh.checked ? plan.existing : null;
    if (!sendTo && !plan.canStart) { error.textContent = plan.reason; error.hidden = false; return false; }
    try {
      let session = sendTo;
      if (!session) {
        session = await sessions.start({ provider: plan.provider || providerSelect.value, projectId: project.id, cwd: project.path, access: access.level === 'full' ? 'full' : 'read', title: titleFrom(text), playwright: false });
      }
      await sessions.send(session.id, text);
      started = session;
      return true;
    } catch (e) {
      error.textContent = `Couldn't give the task: ${e?.message || e}`; error.hidden = false;
      return false;
    }
  };
  const possible = Boolean(plan.existing || plan.canStart);
  if (!possible) { task.disabled = true; providerSelect.disabled = true; }
  const dialog = modal({
    title: `Give ${agent.name} a task on ${project.name}`, body,
    actions: possible ? [{ label: 'Cancel', kind: 'ghost' }, { label: plan.existing ? 'Send task' : 'Start', kind: 'primary', run }]
      : [{ label: 'Projects', kind: 'ghost', run: () => navigate('projects', { project: project.id }) }, { label: 'Close', kind: 'primary' }],
    onClose: () => {
      if (!started) return;
      toast(`${project.name}: task sent to “${started.title || 'the chat'}”.`, { kind: 'success', timeout: 7000, action: { label: 'Open in Chat', run: () => navigate('chat', { thread: started.sharedId ? `pair:${started.sharedId}` : `sess:${started.id}` }) } });
    },
  });
  dialog.classList.add('city-assign-dialog');
  if (plan.existing) fresh.addEventListener('change', () => { const btn = dialog.querySelector('.modal-actions .btn.primary'); if (btn) btn.textContent = fresh.checked ? 'Start' : 'Send task'; });
  if (possible) requestAnimationFrame(() => task.focus());
  return dialog;
}
