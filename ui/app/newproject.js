/* New project dialog: create a GitHub repo and clone it, clone one of your
 * repos, or link a folder that is already on this PC.
 *
 *   openNewProjectDialog(ctx, { lot }) → Promise<{ projectId, path, fullName } | null>
 *
 * GitHub access goes through the GitHub CLI's own sign-in (gh auth login);
 * CodaClauda never asks for a password or token. When `lot` ({ i, j }) is
 * given, the new project is pinned to that City plot before resolving.
 * CSP: classes and CSSOM only, never inline style attributes. */
import { languageColor } from './store.js';
import { cloneableRepos } from './newproject-repos.js';

const NAME_LIMIT = 100;
const DESCRIPTION_LIMIT = 350;
const LIST_LIMIT = 300;
const REPOS_STALE_MS = 10 * 60e3;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const TABS = [
  { id: 'create', label: 'New GitHub repo', icon: 'github' },
  { id: 'clone', label: 'Clone one of my repos', icon: 'clone' },
  { id: 'link', label: 'Link an existing folder', icon: 'folder' },
];
const ICONS = {
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  clone: '<path d="M12 3v11M7.5 9.5 12 14l4.5-4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M12.5 15H17"/>',
};

/** Same normalization as the store: forward slashes, no \\?\ prefix, lowercase, no trailing slash. */
const normalizePath = path => String(path || '').replaceAll('\\', '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase();
const baseName = path => String(path || '').split(/[\\/]/).filter(Boolean).pop() || String(path || '');
const withSep = parent => { const sep = parent.includes('/') && !parent.includes('\\') ? '/' : '\\'; return `${String(parent).replace(/[\\/]+$/, '')}${sep}`; };

/** Mirrors the native check (desktop.rs valid_new_repo_name). '' means valid. */
function nameProblem(name) {
  if (!name) return '';
  if (name.length > NAME_LIMIT) return `Use ${NAME_LIMIT} characters or fewer.`;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return "Use letters, digits, '.', '-' or '_' only.";
  if (/^[.-]/.test(name)) return "Can't start with '.' or '-'.";
  if (name.endsWith('.')) return "Can't end with '.'.";
  if (RESERVED.test(name.split('.')[0])) return `"${name.split('.')[0]}" is a reserved Windows name.`;
  return '';
}

let pending = null; // one dialog at a time; a second call shares the first one's result

export async function openNewProjectDialog(ctx, { lot = null, tab = 'create', repo = '' } = {}) {
  if (pending) return pending;
  pending = new Promise(resolve => build(ctx, lot, resolve, { tab, repo })).finally(() => { pending = null; });
  return pending;
}

function build({ store, ui, bridge }, lot, resolve, initial) {
  const { h, icon, iconButton, toast, timeAgo, copyText } = ui;
  ui.registerIcons(ICONS);
  const opener = document.activeElement;
  const gh = () => store.desktop.projects.github || {};

  const state = {
    tab: 'create',
    account: 'checking',     // checking | ok | error
    login: '',
    accountError: '',
    parent: String(store.prefs?.newProjectParent || store.paths?.desktop_dir || store.paths?.home_dir || ''),
    busy: false,
    repos: null,             // fetched directly when GitHub isn't linked in the store yet
    loadingRepos: false,
    reposLoadedAt: 0,
    selected: initial.repo,
    query: '',
    result: null,
  };
  const locations = [];      // "Local folder" fields (create + clone tabs) share state.parent

  /* ---------- skeleton ---------- */
  const dialog = h('dialog.modal.wide.np-dialog', { 'aria-labelledby': 'np-title' });
  if (store.prefs?.reducedMotion) dialog.classList.add('reduce-motion');

  const tabButtons = TABS.map(tab => h('button.np-tab', {
    type: 'button', role: 'tab', id: `np-tab-${tab.id}`, 'aria-controls': `np-panel-${tab.id}`, 'aria-selected': 'false', tabIndex: -1,
    dataset: { tab: tab.id }, onclick: () => selectTab(tab.id), onkeydown: onTabKey,
  }, icon(tab.icon), h('span', tab.label)));

  const primary = h('button.btn.primary.np-primary', { type: 'button', onclick: () => submit() });
  const cancel = h('button.btn.ghost', { type: 'button', onclick: () => close() }, 'Cancel');
  const footNote = h('span.np-foot-note', { role: 'status', 'aria-live': 'polite' });
  const closeButton = iconButton('close', 'Close', () => close());

  /* ---------- tab 1: new GitHub repo ---------- */
  const accountSlot = h('div.np-account-slot');
  const nameInput = h('input.input.np-name-input', {
    id: 'np-name', type: 'text', placeholder: 'my-new-project', maxLength: NAME_LIMIT, autocomplete: 'off', spellcheck: 'false',
    'aria-describedby': 'np-name-msg np-url', oninput: onNameInput, onkeydown: submitOnEnter,
  });
  const nameMsg = h('span.np-msg#np-name-msg');
  const urlOwner = h('strong');
  const urlName = h('strong');
  const urlPreview = h('span.np-url#np-url', icon('github'), h('span.np-url-text', 'github.com/', urlOwner, '/', urlName));
  const descInput = h('input.input', {
    id: 'np-desc', type: 'text', placeholder: 'One line about the project (optional)', maxLength: DESCRIPTION_LIMIT, autocomplete: 'off',
    oninput: () => { clearError('create'); refreshCreate(); }, onkeydown: submitOnEnter,
  });
  const descCount = h('span.np-count');
  const privateInput = h('input', { type: 'checkbox', checked: true, 'aria-describedby': 'np-private-hint', onchange: () => refreshCreate() });
  const privacyTitle = h('strong');
  const privacyHint = h('span#np-private-hint');
  const privacyIcon = h('span.np-toggle-icon');
  const privacyRow = h('label.np-toggle', privacyIcon, h('span.np-toggle-text', privacyTitle, privacyHint), h('span.switch', privateInput, h('span')));

  const sumRepo = h('span.np-step-text.mono');
  const sumVisibility = h('span.pill.np-vis-pill');
  const sumFolder = h('span.np-step-text.mono');
  const createError = errorBox();
  const createPanel = h('section.np-panel', { id: 'np-panel-create', role: 'tabpanel', 'aria-labelledby': 'np-tab-create' },
    accountSlot,
    h('div.np-create-grid',
      h('div.np-form',
        h('div.np-field',
          h('label.np-label', { for: 'np-name' }, 'Repository name'),
          nameInput,
          urlPreview,
          nameMsg),
        h('div.np-field',
          h('div.np-label-row', h('label.np-label', { for: 'np-desc' }, 'Description'), descCount),
          descInput),
        privacyRow,
        locationField(() => nameState().name)),
      h('aside.np-summary', { 'aria-label': 'What happens' },
        h('div.np-summary-head', icon('info'), h('span', 'This creates a repository in your GitHub account and clones it here.')),
        h('ol.np-steps',
          h('li', h('span.np-step-icon', icon('github')), h('div.np-step-body', h('strong', 'Create it on GitHub'), h('span.np-step-line', sumRepo, sumVisibility))),
          h('li', h('span.np-step-icon', icon('clone')), h('div.np-step-body', h('strong', 'Clone it to this PC'), sumFolder)),
          h('li', h('span.np-step-icon', icon('city')), h('div.np-step-body',
            h('strong', lot ? 'Rise on your plot' : 'Join your City'),
            h('span.np-step-text', lot ? 'A new building on the plot you picked.' : 'A building in your City and a lane on your Board.')))),
        h('p.np-summary-foot', 'Uses your existing GitHub CLI sign-in. CodaClauda never sees your password or token.'))),
    createError.node);

  /* ---------- tab 2: clone one of my repos ---------- */
  const searchInput = h('input.input', {
    type: 'search', placeholder: 'Search your repositories…', 'aria-label': 'Search your repositories', autocomplete: 'off',
    oninput: event => { state.query = event.currentTarget.value; renderRepos(); },
    // Esc clears the search first instead of closing the dialog.
    onkeydown: event => { if (event.key === 'Escape' && event.currentTarget.value) { event.preventDefault(); event.stopPropagation(); event.currentTarget.value = ''; state.query = ''; renderRepos(); } },
  });
  const repoCount = h('span.np-repo-count');
  const reloadButton = iconButton('refresh', 'Reload my repositories from GitHub', () => loadRepos());
  reloadButton.classList.add('np-reload');
  const repoList = h('div.np-repos', { role: 'radiogroup', 'aria-label': 'Your GitHub repositories' });
  const cloneError = errorBox();
  const clonePanel = h('section.np-panel', { id: 'np-panel-clone', role: 'tabpanel', 'aria-labelledby': 'np-tab-clone', hidden: true },
    h('div.np-repo-tools', h('div.np-search', icon('search'), searchInput), repoCount, reloadButton),
    repoList,
    locationField(() => selectedRepo()?.name || ''),
    cloneError.node);

  /* ---------- tab 3: link an existing folder ---------- */
  const linkError = errorBox();
  const linkPanel = h('section.np-panel', { id: 'np-panel-link', role: 'tabpanel', 'aria-labelledby': 'np-tab-link', hidden: true },
    h('div.np-link',
      h('div.np-link-art', icon('folder')),
      h('h3', 'Link a folder that is already on this PC'),
      h('p', 'Pick any project folder. CodaClauda reads file sizes and git history (metadata only) and adds it as a project. Nothing is uploaded or changed.'),
      h('div.np-link-facts',
        h('span.np-fact', icon('check'), 'Git repos and plain folders'),
        h('span.np-fact', icon('check'), 'GitHub remotes are detected'),
        h('span.np-fact', icon('check'), lot ? 'Built on your plot' : 'Appears in your City')),
      h('button.btn.np-link-btn', { type: 'button', onclick: () => submit() }, icon('folder'), 'Choose folder…')),
    linkError.node);

  const panels = { create: createPanel, clone: clonePanel, link: linkPanel };
  const body = h('div.modal-body.np-body', createPanel, clonePanel, linkPanel);
  const tabs = h('div.np-tabs', { role: 'tablist', 'aria-label': 'How to start the project' }, tabButtons);

  dialog.append(
    h('header.modal-head.np-head',
      h('div.np-title',
        h('span.np-title-icon', icon('plus')),
        h('div',
          h('h2#np-title', 'New project'),
          h('p', 'Start a repo, clone one, or link a folder. It becomes a building in your City.'))),
      lot ? h('span.np-lot', { title: 'The project will be built on the City plot you chose' }, icon('pin'), 'Your plot') : null,
      closeButton),
    tabs,
    body,
    h('footer.modal-actions.np-foot', footNote, cancel, primary));

  dialog.addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    dialog.remove();
    resolve(state.result);
    if (opener?.isConnected) opener.focus?.({ preventScroll: true });
  });

  /* ---------- shared pieces ---------- */
  function errorBox() {
    const text = h('span.np-error-text');
    const actions = h('span.np-error-actions');
    const node = h('div.np-error', { role: 'alert', hidden: true }, icon('alert'), text, actions);
    return { node, text, actions };
  }
  function showError(tab, message, action) {
    const box = { create: createError, clone: cloneError, link: linkError }[tab];
    box.text.textContent = message;
    box.actions.replaceChildren(action ? h('button.btn.small', { type: 'button', onclick: action.run }, action.label) : '');
    box.node.hidden = false;
  }
  function clearError(tab) {
    const box = { create: createError, clone: cloneError, link: linkError }[tab];
    box.node.hidden = true;
  }

  function locationField(nameOf) {
    const parentText = h('span.np-path-parent');
    const nameText = h('span.np-path-name');
    const box = h('div.np-path', icon('folder'), h('span.np-path-text', parentText, nameText));
    const node = h('div.np-field',
      h('span.np-label', 'Local folder'),
      h('div.np-path-row', box, h('button.btn.small', { type: 'button', onclick: changeParent }, 'Change…')),
      h('span.field-hint', 'A new folder is created inside this location.'));
    locations.push({ parentText, nameText, box, nameOf });
    return node;
  }
  function syncLocations() {
    for (const { parentText, nameText, box, nameOf } of locations) {
      const name = nameOf();
      box.classList.toggle('empty', !state.parent);
      parentText.textContent = state.parent ? withSep(state.parent) : 'Choose a location…';
      nameText.textContent = state.parent ? name || '' : '';
      box.title = state.parent ? `${withSep(state.parent)}${name || ''}` : '';
    }
  }
  async function changeParent(event) {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const picked = await bridge.desktop.pickFolder();
      if (picked?.path) {
        state.parent = String(picked.path);
        store.setPref?.('newProjectParent', state.parent);
        clearError(state.tab);
        syncLocations();
        refresh();
      }
    } catch (error) {
      showError(state.tab, `Could not open the folder picker: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  function setBusy(on, label = '', note = '') {
    state.busy = on;
    dialog.classList.toggle('is-busy', on);
    body.inert = on;
    tabs.inert = on;
    cancel.disabled = on;
    closeButton.disabled = on;
    if (on) {
      primary.disabled = true;
      primary.replaceChildren(h('span.spinner'), label);
      setNote(note, true);
    } else {
      refresh();
    }
  }
  function setNote(text, spinning = false) {
    footNote.replaceChildren(spinning && text ? icon('clock') : '', text || '');
  }

  function close() {
    if (state.busy) return;
    dialog.close();
  }

  /* ---------- tabs ---------- */
  function selectTab(id, { focus = false } = {}) {
    if (state.busy || !panels[id]) return;
    state.tab = id;
    for (const button of tabButtons) {
      const on = button.dataset.tab === id;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      if (on && focus) button.focus();
    }
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== id;
    if (id === 'clone') {
      renderRepos();
      const fetchedAt = state.repos ? state.reposLoadedAt : gh().fetchedAt || 0;
      if (Date.now() - fetchedAt > REPOS_STALE_MS) loadRepos();
    }
    syncLocations();
    refresh();
  }
  function onTabKey(event) {
    const order = TABS.map(t => t.id);
    const index = order.indexOf(state.tab);
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: order.length - 1 }[event.key];
    if (next == null) return;
    event.preventDefault();
    selectTab(order[(next + order.length) % order.length], { focus: true });
  }

  /* ---------- footer state ---------- */
  function refresh() {
    if (state.busy) return;
    let label, iconName, ready, note = '';
    if (state.tab === 'create') {
      const { name, ok } = nameState();
      label = 'Create repo & local folder'; iconName = 'github';
      ready = state.account === 'ok' && ok && Boolean(state.parent);
      note = state.account === 'checking' ? 'Checking your GitHub sign-in…'
        : state.account !== 'ok' ? 'Sign in with the GitHub CLI to create repositories.'
          : !name ? 'Name your repository to continue.'
            : !state.parent ? 'Choose where the local folder goes.' : '';
    } else if (state.tab === 'clone') {
      const repo = selectedRepo();
      const short = repo && repo.name.length > 26 ? `${repo.name.slice(0, 25)}…` : repo?.name;
      label = repo ? `Clone ${short}` : 'Clone repo'; iconName = 'clone';
      ready = Boolean(repo && state.parent);
      note = !repo ? 'Pick a repository to clone.' : !state.parent ? 'Choose where the local folder goes.' : '';
    } else {
      label = 'Choose folder…'; iconName = 'folder'; ready = true;
    }
    primary.replaceChildren(icon(iconName), label);
    primary.disabled = !ready;
    setNote(note);
  }

  /* ---------- create tab ---------- */
  function ownRepos() {
    const prefix = `${state.login.toLowerCase()}/`;
    return state.login ? (state.repos || gh().repos || []).filter(r => String(r?.full_name || '').toLowerCase().startsWith(prefix)) : [];
  }
  function nameState() {
    const name = nameInput.value.trim();
    const problem = nameProblem(name);
    const conflict = !problem && name ? ownRepos().find(r => String(r.name).toLowerCase() === name.toLowerCase()) : null;
    return { name, problem, conflict, ok: Boolean(name) && !problem && !conflict };
  }
  function onNameInput() {
    // GitHub turns spaces into dashes; do it as you type (same length, so the caret stays put).
    if (/\s/.test(nameInput.value)) {
      const at = nameInput.selectionStart;
      nameInput.value = nameInput.value.replace(/\s/g, '-');
      nameInput.setSelectionRange(at, at);
    }
    nameInput.classList.remove('invalid');
    clearError('create');
    refreshCreate();
  }
  function submitOnEnter(event) {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); if (!primary.disabled) submit(); }
  }
  function refreshCreate() {
    const { name, problem, conflict } = nameState();
    urlOwner.textContent = state.login || 'you';
    urlName.textContent = name || 'repository-name';
    urlPreview.classList.toggle('placeholder', !name);
    nameMsg.className = 'np-msg';
    nameMsg.replaceChildren();
    if (problem) { nameMsg.classList.add('error'); nameMsg.textContent = problem; }
    else if (conflict) {
      const linked = !cloneable().some(r => r.full_name === conflict.full_name);
      nameMsg.classList.add('error');
      nameMsg.append(`You already have ${conflict.full_name} on GitHub. `, linked ? 'It is already linked on this PC.'
        : h('button.np-inline-link', { type: 'button', onclick: () => { state.selected = conflict.full_name; selectTab('clone'); } }, 'Clone it instead'));
    } else if (!name) nameMsg.textContent = "Letters, digits, '.', '-' and '_'. Spaces become dashes.";
    nameInput.classList.toggle('invalid', Boolean(problem || conflict));
    nameInput.setAttribute('aria-invalid', String(Boolean(problem || conflict)));

    const length = descInput.value.length;
    descCount.textContent = length > DESCRIPTION_LIMIT - 70 ? `${length}/${DESCRIPTION_LIMIT}` : '';

    const isPrivate = privateInput.checked;
    privacyRow.classList.toggle('private', isPrivate);
    privacyIcon.replaceChildren(icon(isPrivate ? 'lock' : 'globe'));
    privacyTitle.textContent = isPrivate ? 'Private repository' : 'Public repository';
    privacyHint.textContent = isPrivate ? 'Only you and people you invite can see it.' : 'Anyone on the internet can see it.';
    sumRepo.textContent = `${state.login || 'your account'}/${name || 'repository-name'}`;
    sumVisibility.textContent = isPrivate ? 'Private' : 'Public';
    sumVisibility.classList.toggle('warning', isPrivate);
    sumFolder.textContent = state.parent ? `${withSep(state.parent)}${name || 'repository-name'}` : 'Choose a location below';
    sumFolder.title = sumFolder.textContent;
    syncLocations();
    refresh();
  }

  function renderAccount() {
    if (state.account === 'checking') {
      accountSlot.replaceChildren(h('div.np-account', h('span.spinner'), h('span', 'Checking your GitHub sign-in…')));
      return;
    }
    if (state.account === 'ok') {
      accountSlot.replaceChildren(h('div.np-account.ok',
        h('span.np-account-icon', icon('github')),
        h('span.np-account-text', 'Signed in to GitHub as ', h('strong', state.login)),
        h('span.pill.success', icon('check'), 'GitHub CLI')));
      return;
    }
    const missing = /not installed|not on path/i.test(state.accountError);
    const command = 'gh auth login';
    accountSlot.replaceChildren(h('div.np-signin',
      h('span.np-signin-icon', icon('terminal')),
      h('div.np-signin-body',
        h('strong', 'Sign in with the GitHub CLI'),
        h('p', missing ? 'Install the GitHub CLI, then open a terminal and run ' : 'Open a terminal and run ',
          h('span.np-cmd', h('code', command), iconButton('copy', 'Copy command', () => copyText(command, 'Command copied'))),
          ', then click Check again.'),
        h('p.np-signin-note', 'CodaClauda never asks for your GitHub password or token; the GitHub CLI keeps its own sign-in.'),
        state.accountError ? h('p.np-signin-detail', state.accountError) : null,
        h('div.np-signin-actions',
          h('button.btn.small', { type: 'button', onclick: () => checkAccount() }, icon('refresh'), 'Check again'),
          missing ? h('button.btn.small.ghost', { type: 'button', onclick: () => bridge.desktop.openExternal('https://cli.github.com/').catch(error => toast(`Could not open the link: ${error.message}`, { kind: 'error' })) }, icon('external'), 'Get the GitHub CLI') : null))));
  }

  async function checkAccount() {
    state.account = 'checking';
    renderAccount(); refreshCreate();
    try {
      const result = await bridge.desktop.githubUser();
      state.login = String(result?.login || '');
      state.account = state.login ? 'ok' : 'error';
      state.accountError = state.login ? '' : 'The GitHub CLI did not report a signed-in account.';
    } catch (error) {
      state.account = 'error';
      state.login = '';
      state.accountError = error?.message || String(error);
    }
    if (!dialog.isConnected) return;
    renderAccount(); refreshCreate();
    // Warm the repository list: it powers the name-clash check and the Clone tab.
    if (state.account === 'ok' && !(state.repos || gh().repos || []).length) loadRepos();
  }

  async function submitCreate() {
    const { name, ok } = nameState();
    if (!ok || state.account !== 'ok' || !state.parent) return;
    clearError('create');
    const fullName = `${state.login}/${name}`;
    setBusy(true, 'Creating…', `Creating ${fullName} on GitHub and cloning it…`);
    let created;
    try {
      created = await bridge.desktop.createRepo({ name, description: descInput.value.trim(), private: privateInput.checked, parentDir: state.parent });
    } catch (error) {
      setBusy(false);
      onCreateError(error, fullName);
      return;
    }
    await finish(created.path, created.full_name || fullName, 'Created');
  }
  function onCreateError(error, fullName) {
    const message = error?.message || String(error);
    switch (error?.code) {
      case 'GH_UNAVAILABLE':
        state.account = 'error'; state.login = ''; state.accountError = message;
        renderAccount(); refreshCreate();
        showError('create', 'The GitHub CLI needs you to sign in. See the steps above.');
        break;
      case 'REPO_EXISTS':
        showError('create', message, { label: 'Clone it instead', run: () => { state.selected = fullName; selectTab('clone'); loadRepos(); } });
        markName();
        break;
      case 'INVALID_NAME': case 'FOLDER_EXISTS':
        showError('create', message);
        markName();
        break;
      case 'CLONE_FAILED':
        // The repository exists on GitHub now; cloning can be retried from the next tab.
        showError('create', message, { label: 'Retry from Clone', run: () => { state.selected = fullName; selectTab('clone'); loadRepos(); } });
        break;
      default:
        showError('create', message);
    }
  }
  function markName() { nameInput.classList.add('invalid'); nameInput.focus(); nameInput.select(); }

  /* ---------- clone tab ---------- */
  function cloneable() {
    return cloneableRepos(state.repos || gh().repos || [], store.projects, initial.repo);
  }
  function selectedRepo() { return state.selected ? cloneable().find(r => String(r.full_name).toLowerCase() === state.selected.toLowerCase()) || null : null; }

  async function loadRepos() {
    if (state.loadingRepos) return;
    state.loadingRepos = true;
    reloadButton.classList.add('spinning');
    reloadButton.disabled = true;
    renderRepos();
    try {
      const user = gh().user;
      if (user) { await store.linkGithub(user); state.repos = null; }
      else { const result = await bridge.desktop.githubRepos(state.login || ''); state.repos = Array.isArray(result?.repos) ? result.repos : []; state.reposLoadedAt = Date.now(); }
      if (state.tab === 'clone') clearError('clone');
    } catch (error) {
      showError('clone', `Could not load your repositories: ${error?.message || error}`, { label: 'Try again', run: () => loadRepos() });
    } finally {
      state.loadingRepos = false;
      reloadButton.classList.remove('spinning');
      reloadButton.disabled = false;
      if (dialog.isConnected) { renderRepos(); refreshCreate(); }
    }
  }

  function renderRepos() {
    const all = cloneable();
    const query = state.query.trim().toLowerCase();
    const shown = query ? all.filter(r => [r.name, r.full_name, r.description, r.language].filter(Boolean).join(' ').toLowerCase().includes(query)) : all;
    const total = (state.repos || gh().repos || []).length;
    repoCount.textContent = all.length ? (query ? `${shown.length} of ${all.length}` : `${all.length} to clone`) : '';
    const keepFocus = repoList.contains(document.activeElement);

    let content;
    if (!all.length && state.loadingRepos) content = h('div.np-repos-state', h('span.spinner'), 'Loading your repositories…');
    else if (!all.length && !total) content = h('div.np-repos-state.column',
      h('div.np-state-art', icon('github')),
      h('strong', 'No repositories loaded yet'),
      h('span', 'Uses the GitHub CLI sign-in, or the public GitHub API for public repositories.'),
      h('button.btn.small', { type: 'button', onclick: () => loadRepos() }, icon('refresh'), 'Load my repositories'));
    else if (!all.length) content = h('div.np-repos-state.column',
      h('div.np-state-art', icon('check')),
      h('strong', 'Every repository is already on this PC'),
      h('span', 'Create a new one from the first tab instead.'));
    else if (!shown.length) content = h('div.np-repos-state', 'No repositories match that search.');
    else content = shown.slice(0, LIST_LIMIT).map(repoRow);
    repoList.replaceChildren(...[content].flat());
    if (shown.length > LIST_LIMIT) repoList.append(h('div.np-repos-more', `Showing ${LIST_LIMIT} of ${shown.length}. Search to narrow the list.`));
    if (keepFocus) (repoList.querySelector('input:checked') || repoList.querySelector('input'))?.focus({ preventScroll: true });
  }

  function repoRow(repo) {
    const radio = h('input', {
      type: 'radio', name: 'np-repo', value: repo.full_name, checked: String(repo.full_name).toLowerCase() === state.selected.toLowerCase(),
      onchange: () => { state.selected = repo.full_name; clearError('clone'); syncLocations(); refresh(); },
      onkeydown: event => { if (event.key === 'Enter') { event.preventDefault(); state.selected = repo.full_name; if (!primary.disabled) submit(); } },
    });
    const lang = repo.language ? h('span.np-lang', h('span.np-lang-dot'), repo.language) : null;
    lang?.firstChild.style.setProperty('--c', languageColor(repo.language));
    return h('label.np-repo', { title: repo.full_name, ondblclick: () => { state.selected = repo.full_name; refresh(); if (!primary.disabled) submit(); } },
      radio,
      h('span.np-repo-icon', icon(repo.private ? 'lock' : 'github')),
      h('span.np-repo-main',
        h('span.np-repo-line',
          h('strong', repo.name || repo.full_name),
          repo.private ? h('span.pill.warning.np-tag', 'Private') : null,
          repo.fork ? h('span.pill.np-tag', 'Fork') : null,
          repo.archived ? h('span.pill.np-tag', 'Archived') : null),
        h('span.np-repo-desc', repo.description || repo.full_name)),
      h('span.np-repo-meta', lang, repo.pushed_at ? h('span', { title: `Last pushed ${new Date(repo.pushed_at).toLocaleString()}` }, timeAgo(repo.pushed_at)) : null));
  }

  async function submitClone() {
    const repo = selectedRepo();
    if (!repo || !state.parent) return;
    clearError('clone');
    setBusy(true, 'Cloning…', `Cloning ${repo.full_name}…`);
    let cloned;
    try {
      // Bind the selected account even when it is the UI's main account.
      const owner = store.projects.find(p => p.ids.includes(`gh:${String(repo.full_name).toLowerCase()}`))?.account;
      const main = String(store.desktop?.projects?.github?.user || '').toLowerCase();
      cloned = await bridge.desktop.cloneRepo({ fullName: repo.full_name, parentDir: state.parent, account: owner || main || null });
    } catch (error) {
      setBusy(false);
      if (error?.code === 'GH_UNAVAILABLE') { state.account = 'error'; state.accountError = error.message; renderAccount(); }
      showError('clone', error?.message || String(error));
      return;
    }
    await finish(cloned.path, cloned.full_name || repo.full_name, 'Cloned');
  }

  /* ---------- link tab ---------- */
  async function submitLink() {
    clearError('link');
    setBusy(true, 'Linking…', 'Pick a folder in the window that opened. Scanning starts right after.');
    let path;
    try {
      path = await store.linkFolder();
    } catch (error) {
      setBusy(false);
      showError('link', `Could not link that folder: ${error?.message || error}`);
      return;
    }
    if (!path) { setBusy(false); return; } // picker cancelled
    const project = findProject(path);
    const fullName = project?.repo?.full_name || project?.ids.find(id => id.startsWith('gh:'))?.slice(3) || null;
    done(path, fullName, project, `Linked ${baseName(path)}`);
  }

  /* ---------- success ---------- */
  function findProject(path, fullName = null) {
    const key = `local:${normalizePath(path)}`;
    const ghId = fullName ? `gh:${String(fullName).toLowerCase()}` : null;
    return store.projects.find(p => p.ids.includes(key)) || (ghId && store.projects.find(p => p.ids.includes(ghId))) || null;
  }

  async function finish(path, fullName, verb) {
    let scanProblem = '';
    try {
      setBusy(true, 'Linking…', `Linking and scanning ${baseName(path)}…`);
      try { await store.linkFolder(path); } catch (error) { scanProblem = error?.message || String(error); }
      setBusy(true, 'Finishing…', 'Refreshing your GitHub repositories…');
      await store.linkGithub(gh().user || state.login).catch(() => {});
    } finally {
      const project = findProject(path, fullName);
      done(path, fullName, project, `${verb} ${fullName}`);
      if (scanProblem) toast(`The first scan of ${baseName(path)} did not finish (${scanProblem}). Rescan it from Projects.`, { kind: 'error', timeout: 8000 });
    }
  }

  function done(path, fullName, project, headline) {
    const projectId = project?.id || `local:${normalizePath(path)}`;
    if (lot && typeof store.setCityLot === 'function') store.setCityLot(projectId, lot);
    toast(`${headline} — ${lot ? "it's rising on your plot" : "it's on your Board and in your City now"}`, { kind: 'success', timeout: 6500 });
    state.result = { projectId, path, fullName: fullName || null };
    state.busy = false;
    if (dialog.open) dialog.close();
  }

  function submit() {
    if (state.busy) return;
    if (state.tab === 'create') submitCreate();
    else if (state.tab === 'clone') submitClone();
    else submitLink();
  }

  /* ---------- open ---------- */
  document.body.append(dialog);
  dialog.showModal();
  selectTab(TABS.some(tab => tab.id === initial.tab) ? initial.tab : 'create');
  refreshCreate();
  renderAccount();
  if (state.tab === 'create') nameInput.focus();
  checkAccount();
}
