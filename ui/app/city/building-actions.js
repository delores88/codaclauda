/* Owner session controls for a real building on This PC. The managed session
 * backend resolves its provider; legacy board discovery cannot veto this route. */
import { h, icon } from '../ui.js';
import { levelInfo } from '../access.js';
import { startProjectSession } from '../session-start.js';

const PROVIDERS = [{ id: 'claude', label: 'Claude', icon: 'sparkle' }, { id: 'codex', label: 'Codex', icon: 'terminal' }];

export function offersBuildingSession(project, { side = 'pc', remote = false } = {}) {
  return side === 'pc' && !remote && Boolean(project?.id && typeof project.path === 'string' && project.path.trim());
}

export function buildingProviders(available = null) {
  return PROVIDERS.map(provider => {
    const reason = available === true ? '' : available === null ? 'Checking session support…' : 'Sessions are unavailable in this window.';
    return { ...provider, available: !reason, reason };
  });
}

/** Serialize one blank-session launch and retain its identity if its conversation cannot open.
 * Open session recovers that same session; sending and retry belong to TalkPanel.
 * Callback context is an opaque per-launch identity, suitable for a view-owned WeakMap. */
export class BuildingSessionLaunch {
  constructor({ store, sessions, onStarting = () => {}, onStarted = () => {}, onStartFailed = () => {}, onChange = () => {} }) {
    Object.assign(this, { store, sessions, onStarting, onStarted, onStartFailed, onChange });
    this.pending = null;
    this.recovery = new Map();
  }
  start(provider, project) {
    if (this.pending) return this.pending;
    const existing = this.recovery.get(project.id);
    if (existing) { this.open(existing); return Promise.resolve(existing); }
    const record = { projectId: project.id, session: null, openError: '' };
    return this.begin(record, () => {
      this.present(this.onStarting, { provider, project, context: record });
      return startProjectSession(this.store, this.sessions, provider, project);
    });
  }
  /** Presentation is observational: it cannot delay or repeat native work. */
  present(callback, ...args) {
    try { Promise.resolve(callback(...args)).catch(() => {}); } catch { /* presentation only */ }
  }
  begin(record, create) {
    // Reserve before calling any presentation callback, which may synchronously refresh UI.
    let resolve, reject;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    this.pending = pending;
    this.run(record, create).then(resolve, reject);
    this.onChange();
    return pending;
  }
  async open(record, origin = 'recovery') {
    const version = record.openVersion = (record.openVersion || 0) + 1;
    record.opening = true;
    try {
      await this.onStarted(record.session, { origin, context: record });
      if (version === record.openVersion) record.openError = '';
    } catch (error) {
      if (version === record.openVersion) {
        record.openError = `The session started, but its chat could not open: ${error?.message || error}`;
        this.recovery.set(record.projectId, record);
      }
    } finally {
      if (version === record.openVersion) {
        record.opening = false;
        if (!record.openError) this.recovery.delete(record.projectId);
        this.onChange();
      }
    }
  }
  async run(record, create) {
    try {
      try { record.session = await create(); }
      catch (error) { this.present(this.onStartFailed, error, { context: record }); throw error; }
      this.recovery.set(record.projectId, record);
      this.open(record, 'started');
      if (!record.openError && !record.opening) this.recovery.delete(record.projectId);
      return record;
    } finally { this.pending = null; this.onChange(); }
  }
}

/** Keep one instance per CityView. Prompts belong to the existing City TalkPanel. */
export class BuildingSessionActions {
  constructor({ store, sessions, onStarting, onStarted, onStartFailed, onStateChange = () => {} }) {
    Object.assign(this, { store, sessions, onStateChange });
    this.project = null; this.context = {}; this.error = ''; this.destroyed = false;
    this.launch = new BuildingSessionLaunch({ store, sessions, onStarting, onStarted, onStartFailed, onChange: () => this.refresh() });
    this.buttons = PROVIDERS.map(provider => h(`button.btn.small.primary.city-session-provider.is-${provider.id}`, {
      type: 'button', dataset: { provider: provider.id }, onclick: () => this.start(provider.id),
    }, icon(provider.icon), provider.label));
    this.access = h('span.city-access-chip');
    this.hint = h('span.city-session-hint');
    this.errorNode = h('p.city-session-error', { role: 'alert', hidden: true });
    this.open = h('button.btn.small', { type: 'button', onclick: async () => {
      const record = this.launch.recovery.get(this.project?.id);
      if (record) {
        await this.launch.open(record);
        this.refresh();
      }
    } }, 'Open session');
    this.recoveryNode = h('div.city-session-recovery', { hidden: true }, this.open);
    this.node = h('section.city-new-session', { hidden: true, 'aria-label': 'New session' },
      h('div.city-section-label', 'New session'), h('div.city-session-buttons', this.buttons, this.access),
      h('div.city-session-help', this.hint), this.errorNode, this.recoveryNode);
    this.off = sessions.on?.('change', () => this.refresh());
  }
  setProject(project, context = {}) {
    if (this.project?.id !== project?.id) this.error = '';
    this.project = project; this.context = context;
    this.refresh();
    return this.node;
  }
  focus() {
    this.buttons.find(button => !button.disabled)?.focus({ preventScroll: true });
  }
  refresh() {
    if (this.destroyed || !this.node) return;
    this.node.hidden = !offersBuildingSession(this.project, this.context);
    if (this.node.hidden) return;
    const providers = buildingProviders(this.sessions.available);
    const busy = Boolean(this.launch.pending), record = this.launch.recovery.get(this.project.id);
    for (const [i, button] of this.buttons.entries()) {
      const provider = providers[i]; button.disabled = busy || Boolean(record) || !provider.available;
      button.title = provider.reason || (busy ? 'Starting session…' : record ? 'Open the session already started.' : `Start a new ${provider.label} session`);
    }
    const level = levelInfo(this.store.projectAccess(this.project.id)?.level);
    this.access.className = `city-access-chip is-${level.id}`; this.access.textContent = level.long; this.access.title = level.rule;
    this.hint.textContent = busy ? 'Starting…' : providers[0].reason || 'Opens a conversation in City. Write your message there.';
    const message = record?.openError || this.error;
    this.errorNode.hidden = !message; this.errorNode.textContent = message;
    this.recoveryNode.hidden = !record || busy;
    this.onStateChange();
  }
  async start(provider) {
    if (this.destroyed || this.launch.pending || !offersBuildingSession(this.project, this.context)) return;
    if (!buildingProviders(this.sessions.available).find(p => p.id === provider)?.available) return;
    this.error = '';
    const project = this.store.project(this.project.id);
    if (!offersBuildingSession(project, this.context)) { this.error = 'This project no longer has a local folder.'; this.refresh(); return; }
    try {
      await this.launch.start(provider, project);
    } catch (error) {
      if (this.project?.id === project.id) this.error = `Could not start: ${error?.message || error}`;
    }
    finally { this.refresh(); }
  }
  destroy() { this.destroyed = true; this.off?.(); this.node.remove(); }
}
