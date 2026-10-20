/* Settings: preferences, native updates, board details, and the way to Agent setup.
 * Updates port the 0.2 Updates view: the same native update ops, phase actions
 * (view-model updatePresentation), install confirmation and bounded status polling. */
import { updatePresentation } from '../../view-model.js';
import { weatherSettings } from './settings-weather.js';

const UPDATE_LABELS = { check: 'Check for updates', status: 'Read updater status', authorize: 'Approve in browser', poll: 'Check approval', download: 'Download update', install: 'Install update' };
const UPDATE_MESSAGES = {
  idle: 'Choose Check for updates to contact the release service.', current: 'The updater reports that this version is current.', 'up-to-date': 'The updater reports that this version is current.',
  available: 'A release is available. Approve access before downloading.', 'approval-pending': 'Complete the browser approval, then choose Check approval.',
  authorized: 'Access approved. The update is ready to download.', downloading: 'Downloading the installer.',
  downloaded: 'The native updater reports a downloaded installer. Choose Install when ready.', ready: 'The native updater reports an installer ready to install.',
  checking: 'Checking for a release…', authorizing: 'Preparing browser approval…',
  installing: 'The installer was requested. Follow its prompts; reopen the app to confirm the installed version.',
  cancelled: 'The update operation was cancelled.', unavailable: 'The native updater is unavailable in this build.', error: 'The update operation failed. Check the message before retrying.',
};
const PHASE_KIND = { available: 'accent', 'approval-pending': 'warning', authorized: 'accent', ready: 'success', downloaded: 'success', current: 'success', 'up-to-date': 'success', error: 'danger', unavailable: 'neutral' };
const POLL_LIMIT = 10 * 60e3;

export function mount(root, ctx) {
  const { store, ui, bridge, navigate } = ctx;
  const { h, icon } = ui;
  let visible = false;

  const toggle = (key, label, hint) => {
    const input = h('input', { type: 'checkbox', checked: Boolean(store.prefs[key]), onchange: event => store.setPref(key, event.currentTarget.checked) });
    return h('div.setting-row', h('div.setting-text', h('strong', label), hint ? h('span.field-hint', hint) : null), h('label.switch', { 'aria-label': label }, input, h('span')));
  };
  const info = (label, value) => h('div.info-row', h('dt', label), h('dd.mono', { title: value || '' }, value || '—'));
  const weatherCard = weatherSettings(ctx);   // persistent: keeps its search box and results

  /* ---------- Updates (persistent node; survives page re-renders) ---------- */
  const upd = { data: updatePresentation(), updating: false, reading: false, generation: 0, pollStarted: null, pollStopped: false, error: '' };
  const phaseNode = h('span.pill', 'Not checked');
  const versionsNode = h('p.muted.upd-versions', 'Installed version unavailable');
  const messageNode = h('p.upd-message', { role: 'status', 'aria-live': 'polite' }, 'Open Settings to read the local updater status. A release check starts only when you choose it.');
  const errorNode = h('div.upd-error', { role: 'alert', hidden: true });
  const codeNode = h('code.upd-code');
  const approvalLink = h('a.upd-link', { href: '#', hidden: true }, icon('external'), 'Open the approval page');
  const approvalNode = h('div.upd-approval', { hidden: true },
    h('span.eyebrow', 'Approve in your browser'),
    h('p', 'Use this code on the approval page opened by the updater.'),
    h('div.upd-code-row', codeNode, h('button.btn.small', { type: 'button', onclick: () => ui.copyText(upd.data.approval_code || '', 'Code copied') }, icon('copy'), 'Copy code')),
    approvalLink);
  const progressBar = h('progress.upd-progress');
  const progressText = h('span.muted');
  const progressNode = h('div.upd-progress-panel', { hidden: true }, h('div.upd-progress-label', h('span', 'Download progress'), progressText), progressBar);
  const actionsNode = h('div.upd-actions');
  const notesText = h('pre.upd-notes');
  const notesNode = h('details.upd-notes-panel', { hidden: true }, h('summary', 'Release notes'), notesText);
  const updatesCard = h('section.card.settings-card.updates-card', { 'aria-labelledby': 'upd-title' },
    h('div.upd-head', h('span.upd-art', icon('download')), h('div', h('h2.panel-title#upd-title', 'Updates'), versionsNode), phaseNode),
    messageNode, errorNode, approvalNode, progressNode, actionsNode, notesNode,
    h('p.field-hint', 'Updates use the native desktop updater. An available release or a download is not an installed update. Your running version changes after installation and restart.'));

  function renderUpdates() {
    const data = upd.data;
    phaseNode.textContent = String(data.phase).replaceAll('-', ' ');
    phaseNode.className = `pill ${PHASE_KIND[data.phase] || 'neutral'}`;
    versionsNode.textContent = `Installed ${data.current_version || store.prefsInfo?.version || 'version unavailable'}${data.available_version ? ` · Available ${data.available_version}` : ''}`;
    messageNode.textContent = data.message || UPDATE_MESSAGES[data.phase] || '';
    errorNode.hidden = !upd.error; errorNode.textContent = upd.error;
    approvalNode.hidden = !(data.phase === 'approval-pending' && data.approval_code);
    codeNode.textContent = data.approval_code || '';
    approvalLink.hidden = !data.approvalUrl;
    if (data.approvalUrl) { approvalLink.href = data.approvalUrl; approvalLink.title = data.approvalUrl; }
    progressNode.hidden = data.phase !== 'downloading';
    if (data.progress === null) { progressBar.removeAttribute('value'); progressText.textContent = 'Waiting for byte count'; }
    else { progressBar.max = data.total; progressBar.value = data.progress; progressText.textContent = `${(data.progress / 1e6).toFixed(1)} / ${(data.total / 1e6).toFixed(1)} MB`; }
    notesNode.hidden = !data.release_notes;
    notesText.textContent = typeof data.release_notes === 'string' ? data.release_notes : '';
    const operations = upd.pollStopped ? ['status', ...data.actions.filter(op => op !== 'status')] : data.actions;
    const signature = JSON.stringify([operations, upd.updating]);
    if (actionsNode.dataset.signature === signature) return;
    actionsNode.dataset.signature = signature;
    ui.clear(actionsNode, operations.map((op, index) => h(`button.btn${index === 0 && op !== 'status' ? '.primary' : ''}`, { type: 'button', disabled: upd.updating, dataset: { updateOp: op }, onclick: () => (op === 'install' ? confirmInstall() : updateOperation(op)) }, UPDATE_LABELS[op] || op)));
  }
  async function updateOperation(op, quiet = false) {
    if (upd.updating || (quiet && upd.reading)) return;
    if (quiet) upd.reading = true;
    else { upd.updating = true; upd.generation++; upd.pollStopped = false; upd.pollStarted = null; upd.error = ''; renderUpdates(); }
    const generation = upd.generation;
    try {
      const data = await bridge.desktop.update(op);
      if (generation === upd.generation) upd.data = updatePresentation(data);
    } catch (error) {
      if (generation === upd.generation) {
        upd.data = updatePresentation({ phase: 'unavailable', current_version: store.prefsInfo?.version, message: 'No update success was confirmed. The native updater could not complete this operation.' });
        upd.pollStopped = true; upd.error = error.message || String(error);
      }
    } finally { if (quiet) upd.reading = false; else upd.updating = false; renderUpdates(); }
  }
  function confirmInstall() {
    ui.modal({
      title: 'Install this update?',
      body: 'The native updater will validate the downloaded installer before launching it. Wait for active requests to finish or cancel them before proceeding. Pausing dispatch does not stop running requests. Disconnect this CodaClauda MCP server from each registered chat before installing, then reconnect it after the upgrade. Keep your provider apps and conversations open. Follow any installer prompts, then reopen CodaClauda to confirm the version.',
      actions: [{ label: 'Not now' }, { label: 'Install update', kind: 'primary', run: () => { if (upd.data.actions.includes('install')) updateOperation('install'); } }],
    });
  }
  // Bounded status polling while a check, approval or download is in progress (Settings visible only).
  setInterval(() => {
    if (!visible || document.hidden || upd.updating || upd.pollStopped) return;
    const pending = upd.data.busy === true || ['checking', 'authorizing', 'downloading'].includes(upd.data.phase);
    if (!pending) { upd.pollStarted = null; return; }
    upd.pollStarted ??= Date.now();
    if (Date.now() - upd.pollStarted > POLL_LIMIT) {
      upd.pollStopped = true;
      upd.error = 'Automatic status refresh stopped after 10 minutes. Read updater status to check again; no update action was retried.';
      renderUpdates(); return;
    }
    updateOperation('status', true);
  }, 2000);

  function render() {
    const p = store.prefsInfo || {};
    ui.clear(root, h('div.page.settings-page',
      h('header.page-head', h('div', h('span.eyebrow', 'CodaClauda'), h('h1', 'Settings'), h('p', 'Preferences for this PC. Agent accounts and billing stay with your own Claude and Codex apps.'))),
      h('section.card.settings-card',
        h('h2.panel-title', 'Appearance & alerts'),
        h('div.setting-row', h('div.setting-text', h('strong', 'Theme'), h('span.field-hint', 'Dark or light.')),
          h('div.segmented', ['dark', 'light'].map(theme => h('button', { type: 'button', 'aria-pressed': String(store.prefs.theme === theme), onclick: () => { document.documentElement.dataset.theme = theme; store.setPref('theme', theme); render(); } }, theme === 'dark' ? 'Dark' : 'Light')))),
        toggle('notify', 'Notify me about new messages', 'Shows a toast and flashes the taskbar when an agent messages you.'),
        toggle('sound', 'Notification sound', 'A short two-note chime.'),
        toggle('reducedMotion', 'Reduce motion', 'Calmer animations in the City and avatar preview.'),
        toggle('chatFirst', 'Chat-first layout', 'Hides the City and its "Show in City" buttons and opens CodaClauda on Chat. Turn it off to bring the City back.'),
        h('div.setting-row', h('div.setting-text', h('strong', 'City graphics'), h('span.field-hint', 'Low turns off shadows for slower PCs.')),
          h('div.segmented', ['high', 'low'].map(q => h('button', { type: 'button', 'aria-pressed': String(store.prefs.cityQuality === q), onclick: () => { store.setPref('cityQuality', q); render(); } }, q === 'high' ? 'High' : 'Low')))),
      ),
      weatherCard.node,
      updatesCard,
      h('section.card.settings-card',
        h('h2.panel-title', 'Agent setup'),
        h('p.muted', 'Bring new Claude Code or Codex desktop chats onto the board, copy a dedicated task prompt, and manage dedicated CLI connections. Sessions you start in Chat need no setup here.'),
        h('button.btn.primary', { type: 'button', onclick: () => navigate('connect') }, icon('agentAdd'), 'Open Agent setup'),
      ),
      h('section.card.settings-card',
        h('h2.panel-title', 'This board'),
        h('dl.info-grid', info('Version', p.version), info('Board folder', store.board.state_dir || p.state_dir), info('Coordination CLI', p.cli_path), info('Attachments', store.paths.attachments_dir), info('Project manifest', store.paths.manifest_path)),
        h('p.field-hint', 'A message on the board is information, not permission. Only you authorize actions.'),
      ),
      h('section.card.settings-card',
        h('h2.panel-title', 'About'),
        h('p.muted', 'Coordinates OpenAI Codex and Claude Code agents. Not affiliated with or endorsed by Anthropic or OpenAI.'),
      ),
      h('section.card.settings-card',
        h('h2.panel-title', 'Open-source credits'),
        h('p.muted', 'three.js (MIT), marked (MIT), DOMPurify (Apache-2.0 / MPL-2.0), KaTeX (MIT), highlight.js (BSD-3-Clause). License texts ship with the app under vendor/. No paid assets or keys.'),
      ),
    ));
    renderUpdates();
  }
  render();
  return {
    show() { visible = true; render(); updateOperation('status'); },
    hide() { visible = false; },
  };
}
