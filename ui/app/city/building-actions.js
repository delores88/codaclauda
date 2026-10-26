/* Owner session controls for a real building on This PC. Discovery checks the installed
 * CLIs and their own sign-in; it never starts provider work. No new native command. */
import { rpc } from '../bridge.js';
import { h, icon } from '../ui.js';
import { levelInfo } from '../access.js';
import { startProjectSession } from '../session-start.js';

const PROVIDERS = [{ id: 'claude', label: 'Claude', icon: 'sparkle' }, { id: 'codex', label: 'Codex', icon: 'terminal' }];

export function offersBuildingSession(project, { side = 'pc', remote = false } = {}) {
  return side === 'pc' && !remote && Boolean(project?.id && typeof project.path === 'string' && project.path.trim());
}

export function buildingProviders(found, phase = 'ready', available = true) {
  return PROVIDERS.map(provider => {
    const candidates = (Array.isArray(found) ? found : []).filter(item => item?.agent === provider.id && (item.executable || item.path));
    let reason = '';
    if (available !== true) reason = available === null ? 'Checking session support…' : 'Sessions are unavailable in this window.';
    else if (phase === 'idle' || phase === 'checking') reason = 'Checking installed CLI and sign-in…';
    else if (phase === 'error') reason = 'Could not check sign-in. Check agents again.';
    else if (!candidates.length) reason = `${provider.label} is not installed.`;
    else if (!candidates.some(item => item.supported === true)) reason = `Update the ${provider.label} CLI.`;
    else if (!candidates.some(item => item.supported === true && item.authenticated === true)) reason = `Sign in to ${provider.label}, then check agents again.`;
    return { ...provider, available: !reason, reason };
  });
}

/** Serialize one launch and retain its identity if opening the sheet or first send fails.
 * A retry is an explicit send to the existing session; it never repeats session_start. */
export class BuildingSessionLaunch {
  constructor({ store, sessions, onStarted = () => {}, onChange = () => {} }) {
    Object.assign(this, { store, sessions, onStarted, onChange });
    this.pending = null;
    this.recovery = new Map();
  }
  start(provider, project, prompt = '') {
    if (this.pending) return this.pending;
    const existing = this.recovery.get(project.id);
    if (existing) { this.open(existing); return Promise.resolve(existing); }
    const record = { projectId: project.id, session: null, prompt: String(prompt).trim(), error: '', openError: '' };
    this.pending = this.run(record, () => startProjectSession(this.store, this.sessions, provider, project));
    this.onChange();
    return this.pending;
  }
  async open(record) {
    try { await this.onStarted(record.session, { prompt: record.prompt, sendError: record.error }); record.openError = ''; }
    catch (error) { record.openError = `The session started, but its chat could not open: ${error?.message || error}`; }
  }
  async run(record, create = null) {
    try {
      if (create) {
        record.session = await create();
        this.recovery.set(record.projectId, record);
        await this.open(record);
      }
      if (record.prompt) {
        try { await this.sessions.send(record.session.id, record.prompt); record.prompt = ''; record.error = ''; }
        catch (error) {
          record.error = `Session started. The prompt was not sent: ${error?.message || error}`;
          await this.open(record); // the sheet also receives the failure and unsent draft
        }
      }
      if (!record.error && !record.openError) this.recovery.delete(record.projectId);
      return record;
    } finally { this.pending = null; this.onChange(); }
  }
  retry(projectId) {
    if (this.pending) return this.pending;
    const record = this.recovery.get(projectId);
    if (!record) return Promise.resolve(null);
    this.pending = this.run(record);
    this.onChange();
    return this.pending;
  }
}

/** Keep one instance per CityView. Its node and per-project draft survive panel refreshes. */
export class BuildingSessionActions {
  constructor({ store, sessions, onStarted, onStateChange = () => {}, discover = () => rpc('discover') }) {
    Object.assign(this, { store, sessions, discover, onStateChange });
    this.project = null; this.context = {}; this.phase = 'idle'; this.found = []; this.discovering = null;
    this.drafts = new Map(); this.selectedProvider = 'claude'; this.error = ''; this.destroyed = false;
    this.launch = new BuildingSessionLaunch({ store, sessions, onStarted, onChange: () => this.refresh() });
    this.buttons = PROVIDERS.map(provider => h(`button.btn.small.primary.city-session-provider.is-${provider.id}`, {
      type: 'button', dataset: { provider: provider.id }, onclick: () => this.start(provider.id),
    }, icon(provider.icon), provider.label));
    this.access = h('span.city-access-chip');
    this.input = h('input.input.city-session-prompt', {
      type: 'text', maxlength: 4000, placeholder: 'What should it work on? (optional)', 'aria-label': 'What should it work on? (optional)',
      oninput: () => { if (this.project) this.drafts.set(this.project.id, this.input.value); },
      onkeydown: event => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault(); event.stopPropagation(); this.start(this.selectedProvider);
      },
    });
    this.hint = h('span.city-session-hint');
    this.errorNode = h('p.city-session-error', { role: 'alert', hidden: true });
    this.retry = h('button.btn.small', { type: 'button', onclick: () => this.retryPrompt() }, 'Retry prompt');
    this.open = h('button.btn.small', { type: 'button', onclick: async () => {
      const record = this.launch.recovery.get(this.project?.id);
      if (record) {
        await this.launch.open(record);
        if (!record.error && !record.openError) this.launch.recovery.delete(record.projectId);
        this.refresh();
      }
    } }, 'Open session');
    this.recoveryNode = h('div.city-session-recovery', { hidden: true }, this.open, this.retry);
    this.check = h('button.city-link', { type: 'button', onclick: () => this.checkProviders(true) }, 'Check agents again');
    this.node = h('section.city-new-session', { hidden: true, 'aria-label': 'New session' },
      h('div.city-section-label', 'New session'), h('div.city-session-buttons', this.buttons, this.access),
      this.input, h('div.city-session-help', this.hint, this.check), this.errorNode, this.recoveryNode);
    this.off = sessions.on?.('change', () => this.refresh());
  }
  setProject(project, context = {}) {
    if (this.project?.id !== project?.id) { this.error = ''; this.input.value = this.drafts.get(project?.id) || ''; }
    this.project = project; this.context = context;
    this.refresh();
    if (offersBuildingSession(project, context) && this.phase === 'idle') this.checkProviders();
    return this.node;
  }
  async checkProviders(force = false) {
    if (this.discovering || (!force && this.phase !== 'idle')) return this.discovering;
    this.phase = 'checking'; this.refresh();
    this.discovering = (async () => {
      try { const result = await this.discover(); this.found = Array.isArray(result?.agents) ? result.agents : []; this.phase = 'ready'; }
      catch { this.found = []; this.phase = 'error'; }
      finally { this.discovering = null; this.refresh(); }
    })();
    return this.discovering;
  }
  refresh() {
    if (this.destroyed || !this.node) return;
    this.node.hidden = !offersBuildingSession(this.project, this.context);
    if (this.node.hidden) return;
    const providers = buildingProviders(this.found, this.phase, this.sessions.available);
    if (!providers.some(p => p.id === this.selectedProvider && p.available)) this.selectedProvider = providers.find(p => p.available)?.id || 'claude';
    const busy = Boolean(this.launch.pending), record = this.launch.recovery.get(this.project.id);
    for (const [i, button] of this.buttons.entries()) {
      const provider = providers[i]; button.disabled = busy || Boolean(record) || !provider.available;
      button.title = provider.reason || (busy ? 'Starting session…' : record ? 'Open the session already started for this prompt.' : `Start a new ${provider.label} session`);
    }
    const level = levelInfo(this.store.projectAccess(this.project.id)?.level);
    this.access.className = `city-access-chip is-${level.id}`; this.access.textContent = level.long; this.access.title = level.rule;
    this.input.disabled = busy || Boolean(record);
    this.hint.textContent = busy ? 'Starting…' : providers.some(p => p.available) ? `Enter starts ${PROVIDERS.find(p => p.id === this.selectedProvider).label}` : 'Set up an agent in Agent setup.';
    this.check.disabled = busy || this.phase === 'checking';
    const message = record?.error || record?.openError || this.error;
    this.errorNode.hidden = !message; this.errorNode.textContent = message;
    this.recoveryNode.hidden = !record || busy;
    this.retry.hidden = !record?.prompt || !record?.error; this.retry.disabled = busy;
    this.onStateChange();
  }
  async start(provider) {
    if (this.destroyed || this.launch.pending || !offersBuildingSession(this.project, this.context)) return;
    if (!buildingProviders(this.found, this.phase, this.sessions.available).find(p => p.id === provider)?.available) return;
    this.selectedProvider = provider; this.error = '';
    const project = this.store.project(this.project.id);
    if (!offersBuildingSession(project, this.context)) { this.error = 'This project no longer has a local folder.'; this.refresh(); return; }
    const prompt = this.drafts.get(project.id) || '';
    try {
      const record = await this.launch.start(provider, project, prompt);
      if (!record.error) { this.drafts.delete(project.id); if (this.project?.id === project.id) this.input.value = ''; }
    } catch (error) { this.error = `Could not start: ${error?.message || error}`; }
    finally { this.refresh(); }
  }
  async retryPrompt() {
    const projectId = this.project?.id;
    if (!projectId) return;
    const record = await this.launch.retry(projectId);
    if (record && !record.error) { this.drafts.delete(projectId); if (this.project?.id === projectId) this.input.value = ''; }
    this.refresh();
  }
  destroy() { this.destroyed = true; this.off?.(); this.node.remove(); }
}
