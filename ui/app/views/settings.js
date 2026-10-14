/* Settings: preferences, board details, and the Classic tools for advanced setup. */
export function mount(root, ctx) {
  const { store, ui } = ctx;
  const { h, icon } = ui;

  const toggle = (key, label, hint) => {
    const input = h('input', { type: 'checkbox', checked: Boolean(store.prefs[key]), onchange: event => store.setPref(key, event.currentTarget.checked) });
    return h('div.setting-row', h('div.setting-text', h('strong', label), hint ? h('span.field-hint', hint) : null), h('label.switch', { 'aria-label': label }, input, h('span')));
  };
  const info = (label, value) => h('div.info-row', h('dt', label), h('dd.mono', { title: value || '' }, value || '—'));

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
        h('div.setting-row', h('div.setting-text', h('strong', 'City graphics'), h('span.field-hint', 'Low turns off shadows for slower PCs.')),
          h('div.segmented', ['high', 'low'].map(q => h('button', { type: 'button', 'aria-pressed': String(store.prefs.cityQuality === q), onclick: () => { store.setPref('cityQuality', q); render(); } }, q === 'high' ? 'High' : 'Low')))),
      ),
      h('section.card.settings-card',
        h('h2.panel-title', 'Advanced tools'),
        h('p.muted', 'Connect Claude Code / Codex CLIs, create scoped grants, run dedicated tasks, register existing chats, configure DGXBridge, and check for updates.'),
        h('a.btn.primary', { href: 'classic.html' }, icon('settings'), 'Open Classic tools'),
      ),
      h('section.card.settings-card',
        h('h2.panel-title', 'This board'),
        h('dl.info-grid', info('Version', p.version), info('Board folder', store.board.state_dir || p.state_dir), info('Coordination CLI', p.cli_path), info('Attachments', store.paths.attachments_dir), info('Project manifest', store.paths.manifest_path)),
        h('p.field-hint', 'A message on the board is information, not permission. Only you authorize actions.'),
      ),
      h('section.card.settings-card',
        h('h2.panel-title', 'Open-source credits'),
        h('p.muted', 'three.js (MIT), marked (MIT), DOMPurify (Apache-2.0 / MPL-2.0), KaTeX (MIT), highlight.js (BSD-3-Clause). License texts ship with the app under vendor/. No paid assets or keys.'),
      ),
    ));
  }
  render();
  return { show: render, hide() {} };
}
