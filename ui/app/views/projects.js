/* Projects: link Desktop folders and GitHub repos, then choose where each one
 * shows up (a lane on the Board, a building in the City). Rows are keyed by
 * project id and rebuilt only when their content changes; the Board/City
 * switches are updated in place so long lists stay fast and focus is kept.
 * Each row also shows the project's access level for sessions CodaClauda starts (access.js:
 * Full or Read only), and the toolbar can apply one level to every matching project.
 * 0.5: each project with a folder opens its MCP tools (Full access only) and its CLAUDE.md / AGENTS.md
 * editor (project-tools.js) from the access line or the row menu, and its Teammates switch: whether
 * agents may start teammates there (team.js). 0.6: a project follows Settings → Team (on, Unlimited by
 * default) unless it has its own setting here; folders an agent's request registered are added to the
 * list at the level they were registered at, and unlinking one forgets the registration. The Teammates
 * form opens only once the saved settings are read, so it can never replace a project's own setting
 * with the default. */
import { openNewProjectDialog } from '../newproject.js';
import { openGithubAccounts, openCloneRepos, uncloned } from '../github-accounts.js';
import { LEVELS, ACCESS_NOTE, BROWSER_UNAVAILABLE, levelInfo } from '../access.js';
import { openInstructions, openMcpTools, MCP_NOTE } from '../project-tools.js';
import { has as hasFeature } from '../features.js';
import { team, TEAM_ADDRESS } from '../team.js';
import { limitValue } from '../budgets.js';
import { teamAdoptions } from './settings-team.js';

const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'local', label: 'Desktop', test: p => Boolean(p.path) },
  { id: 'github', label: 'GitHub', test: p => Boolean(p.repo) || p.ids.some(id => id.startsWith('gh:')) },
  { id: 'hidden', label: 'Hidden', test: p => !p.visible.board || !p.visible.city },
];
const SORTS = {
  size: null, // store order: biggest first
  name: (a, b) => a.name.localeCompare(b.name),
  activity: (a, b) => (b.metrics.lastActivityAt || 0) - (a.metrics.lastActivityAt || 0) || a.name.localeCompare(b.name),
};
const PAGE_SIZE = 20;     // bounded pages: the list never grows past one page
const SURFACE_TEXT = { board: { on: 'on the Board', from: 'from the Board' }, city: { on: 'in the City', from: 'from the City' } };
const MANIFEST_EXAMPLE = `{
  "schema": "codaclauda.projects/1",
  "projects": [
    {
      "name": "PhaseForge",
      "local_path": "D:\\\\PhaseForge",
      "github": "owner/phaseforge",
      "aliases": ["forge"],
      "agents": ["claude-phaseforge"]
    }
  ]
}`;

const normalizePath = path => String(path || '').replaceAll('\\', '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase();
const squash = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const baseName = path => String(path || '').split(/[\\/]/).filter(Boolean).pop() || String(path || '');
function shortPath(path) {
  const sep = String(path).includes('\\') ? '\\' : '/';
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…${sep}${parts.slice(-2).join(sep)}` : String(path);
}
function describeSource(source) {
  if (/gh|cli/i.test(source || '')) return 'GitHub CLI';
  if (/api|public/i.test(source || '')) return 'public GitHub API';
  if (/mock/i.test(source || '')) return 'preview data';
  return source || '';
}

export function mount(root, ctx) {
  const { store, ui, bridge, navigate } = ctx;
  const { h, icon, iconButton, toast, modal, copyText, timeAgo, fullTime, emptyState, clear, formatNumber, formatBytes, plural, portrait } = ui;

  ui.registerIcons({
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    unlink: '<path d="M9.5 14.5a4 4 0 0 0 5.5.5l3-3a4 4 0 0 0-5.7-5.7l-1 1M14.5 9.5A4 4 0 0 0 9 9l-3 3a4 4 0 0 0 5.7 5.7l1-1"/><path d="M4 4l16 16"/>',
    tag: '<path d="M3 12V4h8l10 10-8 8Z"/><circle cx="7.5" cy="8.5" r="1.3"/>',
  });

  const state = { filter: 'all', query: '', sort: 'size', visible: false, dirty: true, frame: 0, page: 0, pageSig: '', focusId: null };
  const rows = new Map();         // project id -> { node, sig, board, city } (off-page rows stay cached, detached)
  const scanning = new Set();     // normalized paths being scanned right now
  const sigs = new WeakMap();     // slot -> last signature
  let shownProjects = [];
  let op = null;                  // bulk scan in progress: { title, total, done, current, cancelled }
  let menuState = null;

  /* ---------- small helpers ---------- */
  const linkedLocalPaths = () => new Set((store.desktop.projects.local || []).map(p => normalizePath(p.path)));
  const isLinkedLocal = (project, linked = linkedLocalPaths()) => Boolean(project.path) && linked.has(normalizePath(project.path));
  function manifestIds() {
    const ids = new Set();
    for (const item of Array.isArray(store.manifest?.projects) ? store.manifest.projects : []) {
      if (!item || typeof item.name !== 'string') continue;
      if (item.local_path) ids.add(`local:${normalizePath(item.local_path)}`);
      if (item.github) ids.add(`gh:${String(item.github).toLowerCase()}`);
      ids.add(`manifest:${squash(item.name)}`);
    }
    return ids;
  }
  const isFromManifest = (project, ids = manifestIds()) => Boolean(project.fromManifest) || project.ids.some(id => ids.has(id));
  const pendingGithub = project => (!project.repo ? project.ids.find(id => id.startsWith('gh:'))?.slice(3) : null);
  const currentProject = id => store.projects.find(p => p.id === id);

  /** Settings are read from the first of project.ids that has any; carry them forward so a write never drops older values. */
  function effectiveSettings(project) {
    const all = store.desktop.projects.settings || {};
    return project.ids.map(id => all[id]).find(Boolean) || {};
  }
  function saveSettings(project, patch) {
    store.setProjectSettings(project, { ...effectiveSettings(project), ...patch });
  }
  /** One store write for many projects (a single 'change' instead of N). */
  function saveMany(projects, patchFor) {
    if (typeof store.updateDesktop === 'function') {
      const merged = projects.map(p => [p.id, { ...effectiveSettings(p), ...patchFor(p) }]);
      store.updateDesktop(d => { d.projects.settings ||= {}; for (const [id, value] of merged) d.projects.settings[id] = value; });
    } else for (const p of projects) saveSettings(p, patchFor(p));
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    button.disabled = busy;
    button.classList.toggle('busy', busy);
    if (busy) {
      button.dataset.label = button.dataset.label || button.lastChild?.textContent || '';
      button.prepend(h('span.spinner.btn-spinner'));
      if (label && button.lastChild?.nodeType === Node.TEXT_NODE) button.lastChild.textContent = label;
    } else {
      button.querySelector('.btn-spinner')?.remove();
      if (button.dataset.label && button.lastChild?.nodeType === Node.TEXT_NODE) button.lastChild.textContent = button.dataset.label;
    }
  }

  /** Rebuild a small region only when its signature changes; restore focus by data-fk. */
  function patch(slot, sig, build) {
    if (sigs.get(slot) === sig) return;
    const active = document.activeElement;
    const inside = active && slot.contains(active);
    if (inside && active.matches('input, select, textarea')) return;
    const key = inside ? active.dataset.fk : null;
    sigs.set(slot, sig);
    clear(slot, build());
    if (key) slot.querySelector(`[data-fk="${key}"]`)?.focus({ preventScroll: true });
  }

  /* ---------- popover menu ---------- */
  function closeMenu(returnFocus = false) {
    if (!menuState) return;
    const { menu, anchor, cleanup } = menuState;
    menuState = null;
    cleanup();
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (returnFocus && anchor.isConnected) anchor.focus();
  }
  function openMenu(anchor, items, label) {
    if (menuState?.anchor === anchor) { closeMenu(true); return; }
    closeMenu();
    const menu = h('div.proj-menu', { role: 'menu', 'aria-label': label });
    if (store.prefs.reducedMotion) menu.classList.add('reduce-motion');
    for (const item of items.filter(Boolean)) {
      if (item === 'sep') { menu.append(h('div.proj-menu-sep', { role: 'separator' })); continue; }
      // Visual scope note; the menu's aria-label and item labels carry the same scope for screen readers.
      if (item.hint) { menu.append(h('div.proj-menu-hint', { 'aria-hidden': 'true' }, item.hint)); continue; }
      menu.append(h(`button.proj-menu-item${item.danger ? '.danger' : ''}`, {
        type: 'button', role: 'menuitem', disabled: Boolean(item.disabled), title: item.title || '',
        onclick: () => { closeMenu(); item.run(); },
      }, item.swatch ? h('span.proj-menu-swatch', { 'aria-hidden': 'true', style: { '--lc': item.swatch } }) : icon(item.icon), h('span', item.label)));
    }
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth, height = menu.offsetHeight;
    let top = rect.bottom + 6;
    if (top + height > innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    const left = Math.max(8, Math.min(rect.right - width, innerWidth - width - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    anchor.setAttribute('aria-expanded', 'true');

    const items$ = () => [...menu.querySelectorAll('.proj-menu-item:not(:disabled)')];
    const onPointer = event => { if (!menu.contains(event.target) && !anchor.contains(event.target)) closeMenu(); };
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); return; }
      if (event.key === 'Tab') { closeMenu(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const list = items$(); const index = list.indexOf(document.activeElement);
        const next = event.key === 'ArrowDown' ? (index + 1) % list.length : (index - 1 + list.length) % list.length;
        list[next]?.focus();
      }
    };
    const onScroll = () => closeMenu();
    document.addEventListener('pointerdown', onPointer, true);
    menu.addEventListener('keydown', onKey);
    root.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    menuState = { menu, anchor, cleanup: () => {
      document.removeEventListener('pointerdown', onPointer, true);
      root.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    } };
    items$()[0]?.focus();
  }

  /* ---------- static skeleton ---------- */
  const newButton = h('button.btn.primary', { type: 'button', title: 'Create a GitHub repo, clone one of yours, or link a folder', onclick: () => newProject() }, icon('plus'), 'New project');
  const linkButton = h('button.btn', { type: 'button', onclick: event => linkFolder(event.currentTarget) }, icon('folder'), 'Link folder');
  const scanButton = h('button.btn', { type: 'button', onclick: event => scanDesktop(event.currentTarget) }, icon('search'), 'Scan my Desktop');
  const githubButton = h('button.btn', { type: 'button', onclick: () => connectGithub() }, icon('github'), 'Connect GitHub');
  const rescanButton = h('button.btn.ghost', { type: 'button', onclick: () => rescanAll() }, icon('refresh'), 'Rescan all');
  const accountsButton = h('button.btn', { type: 'button', title: 'Add more GitHub accounts and choose one big city or an island per account', onclick: () => openGithubAccounts({ store, bridge }) }, icon('github'), 'GitHub accounts');
  const cloneButton = h('button.btn', { type: 'button', title: 'Clone repos that are not on this PC yet, one by one or all at once', onclick: () => openCloneRepos({ store, bridge }) }, icon('download'), 'Clone repos');

  const progressLabel = h('span.proj-progress-label');
  const progressFill = h('div.proj-progress-fill');
  const progressNode = h('div.proj-progress.card', { hidden: true, role: 'status', 'aria-live': 'polite' },
    h('span.spinner'), progressLabel,
    h('div.proj-progress-bar', progressFill),
    h('button.btn.small.ghost', { type: 'button', onclick: () => { if (op) { op.cancelled = true; progressLabel.textContent = 'Stopping after this project…'; } } }, 'Stop'));

  const sourcesSlot = h('div.proj-sources');
  const manifestSlot = h('div.proj-manifest-slot');

  const countNodes = {};
  const filterButtons = FILTERS.map(filter => {
    const count = h('span.count', '0');
    countNodes[filter.id] = count;
    return h('button', { type: 'button', 'aria-pressed': String(filter.id === state.filter), dataset: { filter: filter.id }, onclick: () => setFilter(filter.id) }, filter.label, count);
  });
  const searchInput = h('input.input', {
    type: 'search', placeholder: 'Search name, path, repo, language…', 'aria-label': 'Search projects', autocomplete: 'off',
    oninput: event => { state.query = event.currentTarget.value; schedule(); },
    onkeydown: event => { if (event.key === 'Escape' && event.currentTarget.value) { event.currentTarget.value = ''; state.query = ''; schedule(); } },
  });
  const countsNode = h('span.proj-counts');
  const bulkButton = h('button.btn.small', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: event => openBulkMenu(event.currentTarget) }, icon('eye'), h('span.bulk-label', 'Visibility'), icon('chevronDown'));
  const accessButton = h('button.btn.small', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: event => openAccessMenu(event.currentTarget) }, icon('shield'), h('span.bulk-label', 'Apply to all projects'), icon('chevronDown'));

  const sortButton = (key, label) => h('button.proj-sort', { type: 'button', dataset: { sort: key }, onclick: () => { state.sort = state.sort === key ? 'size' : key; schedule(); } }, label, icon('arrowDown', 'proj-sort-icon'));
  const headCells = {
    name: h('div.proj-hcell.col-name', { role: 'columnheader' }, sortButton('name', 'Project')),
    source: h('div.proj-hcell.col-source', { role: 'columnheader' }, 'Source'),
    code: h('div.proj-hcell.col-code', { role: 'columnheader' }, sortButton('size', 'Code')),
    activity: h('div.proj-hcell.col-activity', { role: 'columnheader' }, sortButton('activity', 'Activity')),
    board: h('div.proj-hcell.col-switch', { role: 'columnheader', title: 'Show as a lane on the Board' }, icon('board'), 'Board'),
    city: h('div.proj-hcell.col-switch', { role: 'columnheader', title: 'Show as a building in the City' }, icon('city'), 'City'),
    menu: h('div.proj-hcell.col-menu', { role: 'columnheader' }, h('span.visually-hidden', 'Actions')),
  };
  const rowsNode = h('div.proj-rows', { role: 'rowgroup' });
  const listNode = h('div.proj-list', { role: 'table', 'aria-label': 'Linked projects' },
    h('div.proj-head', { role: 'row' }, Object.values(headCells)),
    rowsNode);
  const toolbar = h('div.proj-toolbar',
    h('div.segmented', { role: 'group', 'aria-label': 'Filter projects' }, filterButtons),
    h('div.proj-search', icon('search'), searchInput),
    h('div.proj-toolbar-end', countsNode, accessButton, bulkButton));
  const pagePrev = h('button.btn.ghost.small', { type: 'button', 'aria-label': 'Previous page of projects', onclick: () => goPage(-1) }, 'Previous');
  const pageNext = h('button.btn.ghost.small', { type: 'button', 'aria-label': 'Next page of projects', onclick: () => goPage(1) }, 'Next');
  const pageRange = h('span.proj-pager-range', { 'aria-live': 'polite' });
  const pager = h('nav.proj-pager', { 'aria-label': 'Project list pages', hidden: true }, pageRange, h('div.proj-pager-controls', pagePrev, pageNext));
  const listEmpty = h('div.proj-list-empty', { hidden: true });
  const accessNote = h('p.proj-access-note', icon('shield'), h('span', h('strong', 'Access'), ' is Full (no prompts) for your own projects and Read only for anyone else\'s by default. ', ACCESS_NOTE, ' A change applies to the next session started in the project.'));
  const mainArea = h('div.proj-main', accessNote, toolbar, listNode, pager, listEmpty);
  const firstRun = h('div.proj-first-run', { hidden: true });

  root.classList.add('projects-view');
  clear(root, h('div.page.projects-page',
    h('header.page-head.proj-page-head',
      h('div',
        h('span.eyebrow', 'Workspace'),
        h('h1', 'Projects'),
        h('p', 'Each project is a building in your City and a lane on your Board. Link Desktop folders and GitHub repos, then choose where each one shows up.'),
      ),
      h('div.proj-actions', newButton, linkButton, scanButton, githubButton, accountsButton, cloneButton, rescanButton),
    ),
    progressNode,
    sourcesSlot,
    manifestSlot,
    mainArea,
    firstRun,
  ));

  /* ---------- rendering ---------- */
  function schedule() {
    if (!state.visible) { state.dirty = true; return; }
    if (!state.frame) state.frame = requestAnimationFrame(render);
  }
  function setFilter(id) {
    state.filter = id;
    for (const button of filterButtons) button.setAttribute('aria-pressed', String(button.dataset.filter === id));
    schedule();
  }
  function goPage(delta) {
    state.page += delta;
    if (state.frame) { cancelAnimationFrame(state.frame); state.frame = 0; }
    render();
    // Paging from the bottom pager: bring the top of the new page back into view.
    const top = listNode.getBoundingClientRect().top;
    if (top < root.getBoundingClientRect().top || top < 0) listNode.scrollIntoView({ block: 'start', behavior: store.prefs.reducedMotion ? 'auto' : 'smooth' });
  }
  function haystack(p) {
    return [p.name, p.description, p.path, p.repo?.full_name, p.primaryLanguage, ...p.aliases, ...p.languages.map(l => l.name)].filter(Boolean).join(' ').toLowerCase();
  }

  function render() {
    state.frame = 0;
    if (!state.visible) { state.dirty = true; return; }
    state.dirty = false;
    root.classList.toggle('reduce-motion', Boolean(store.prefs.reducedMotion));

    const projects = store.projects;
    const linked = linkedLocalPaths();
    const fromManifest = manifestIds();
    const agentsByHome = new Map();
    for (const agent of store.agents) {
      if (!agent.homeProjectId) continue;
      if (!agentsByHome.has(agent.homeProjectId)) agentsByHome.set(agent.homeProjectId, []);
      agentsByHome.get(agent.homeProjectId).push(agent);
    }

    renderSources(projects);
    renderManifest();

    const hasAny = projects.length > 0;
    mainArea.hidden = !hasAny;
    firstRun.hidden = hasAny;
    if (!hasAny) {
      patch(firstRun, 'empty', () => emptyState('projects', 'No projects linked yet',
        'Start a new GitHub repo, link a folder from your PC, scan your Desktop for repos, or connect GitHub. Each project becomes a building in your City and a lane on your Board.',
        h('button.btn.primary', { type: 'button', dataset: { fk: 'new' }, onclick: () => newProject() }, icon('plus'), 'New project'),
        h('button.btn', { type: 'button', dataset: { fk: 'link' }, onclick: event => linkFolder(event.currentTarget) }, icon('folder'), 'Link folder'),
        h('button.btn', { type: 'button', dataset: { fk: 'scan' }, onclick: event => scanDesktop(event.currentTarget) }, icon('search'), 'Scan my Desktop'),
        h('button.btn', { type: 'button', dataset: { fk: 'github' }, onclick: () => connectGithub() }, icon('github'), 'Connect GitHub')));
    }

    for (const filter of FILTERS) countNodes[filter.id].textContent = String(projects.filter(filter.test).length);
    const inCity = projects.filter(p => p.visible.city).length, onBoard = projects.filter(p => p.visible.board).length;
    countsNode.textContent = `${inCity} in City · ${onBoard} on Board`;
    countsNode.title = `${plural(projects.length, 'linked project')}`;

    const query = state.query.trim().toLowerCase();
    const filterTest = FILTERS.find(f => f.id === state.filter)?.test || (() => true);
    let shown = projects.filter(p => filterTest(p) && (!query || haystack(p).includes(query)));
    if (SORTS[state.sort]) shown = [...shown].sort(SORTS[state.sort]);
    shownProjects = shown; // every match across all pages: bulk actions apply to all of them
    bulkButton.disabled = !shown.length;
    bulkButton.querySelector('.bulk-label').textContent = shown.length === projects.length ? 'Visibility' : `Visibility (${shown.length} matching)`;
    bulkButton.title = `Show or hide all ${shown.length === projects.length ? plural(shown.length, 'project') : `${shown.length} matching ${shown.length === 1 ? 'project' : 'projects'}`} at once${shown.length > PAGE_SIZE ? ', on every page' : ''}`;
    accessButton.disabled = !shown.length;
    accessButton.querySelector('.bulk-label').textContent = shown.length === projects.length ? 'Apply to all projects' : `Apply to ${shown.length} matching`;
    accessButton.title = `Set the access level of ${shown.length === projects.length ? `all ${plural(shown.length, 'project')}` : `all ${shown.length} matching`} at once`;

    // Filter, search or sort changes return to the first page; data changes clamp to the last page.
    const pageSig = JSON.stringify([state.filter, query, state.sort]);
    if (pageSig !== state.pageSig) { state.pageSig = pageSig; state.page = 0; }
    if (state.focusId) {
      const at = shown.findIndex(p => p.id === state.focusId);
      if (at >= 0) state.page = Math.floor(at / PAGE_SIZE);
      state.focusId = null;
    }
    const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
    state.page = Math.min(pages - 1, Math.max(0, state.page));
    const first = state.page * PAGE_SIZE;
    const pageRows = shown.slice(first, first + PAGE_SIZE);
    for (const [key, cell] of Object.entries(headCells)) {
      if (!(key in SORTS) && key !== 'code') continue;
      const sortKey = key === 'code' ? 'size' : key;
      cell.setAttribute('aria-sort', state.sort === sortKey ? (sortKey === 'name' ? 'ascending' : 'descending') : 'none');
      cell.classList.toggle('sorted', state.sort === sortKey);
    }

    const keep = new Set();
    pageRows.forEach((project, index) => {
      keep.add(project.id);
      const info = { linked: isLinkedLocal(project, linked), manifest: isFromManifest(project, fromManifest), agents: agentsByHome.get(project.id) || [], scanning: Boolean(project.path && scanning.has(normalizePath(project.path))), access: store.projectAccess(project.id), team: team.get(project), teamDefault: teamFollowsDefault(project) };
      const sig = rowSignature(project, info);
      let entry = rows.get(project.id);
      if (!entry || entry.sig !== sig) {
        const active = document.activeElement;
        const inside = Boolean(entry && active && entry.node.contains(active));
        const built = buildRow(project, info);
        if (entry) {
          const key = inside ? active.dataset.fk : null;
          entry.node.replaceWith(built.node);
          if (key) built.node.querySelector(`[data-fk="${key}"]`)?.focus({ preventScroll: true });
        }
        entry = { ...built, sig };
        rows.set(project.id, entry);
      }
      // Visibility changes are applied in place: no rebuild, no lost focus.
      if (entry.board.checked !== project.visible.board) entry.board.checked = project.visible.board;
      if (entry.city.checked !== project.visible.city) entry.city.checked = project.visible.city;
      const hiddenBoth = !project.visible.board && !project.visible.city;
      entry.node.classList.toggle('dim', hiddenBoth);
      if (entry.hiddenTag) entry.hiddenTag.hidden = !hiddenBoth;
      const at = rowsNode.children[index];
      if (at !== entry.node) rowsNode.insertBefore(entry.node, at || null);
    });
    // Off-page rows are detached but stay cached so paging back reuses them; unlinked projects are dropped.
    const exists = new Set(projects.map(p => p.id));
    for (const [id, entry] of rows) {
      if (keep.has(id)) continue;
      if (menuState && entry.node.contains(menuState.anchor)) closeMenu();
      entry.node.remove();
      if (!exists.has(id)) rows.delete(id);
    }

    const focused = document.activeElement;
    pager.hidden = !shown.length;
    pageRange.textContent = `${shown.length ? first + 1 : 0}–${first + pageRows.length} of ${shown.length} · Page ${state.page + 1} of ${pages}`;
    pagePrev.disabled = state.page === 0;
    pageNext.disabled = state.page >= pages - 1;
    // Keep keyboard focus in the pager when the button that was pressed becomes disabled.
    if ((focused === pageNext || focused === pagePrev) && focused.disabled) (focused === pageNext ? pagePrev : pageNext).focus({ preventScroll: true });

    listNode.hidden = !shown.length;
    listEmpty.hidden = Boolean(shown.length) || !hasAny;
    if (!shown.length && hasAny) {
      patch(listEmpty, `${state.filter}|${query}`, () => state.filter === 'hidden' && !query
        ? emptyState('eye', 'Nothing hidden', 'Every project shows up on both the Board and in the City.')
        : emptyState('search', 'No projects match', 'Try another filter or search term.',
          h('button.btn', { type: 'button', onclick: () => { searchInput.value = ''; state.query = ''; setFilter('all'); } }, 'Clear filters')));
    }
  }

  function renderSources(projects) {
    const gh = store.desktop.projects.github || {};
    const localCount = (store.desktop.projects.local || []).length;
    const extra = store.desktop.projects.githubAccounts || [];
    const sig = JSON.stringify([localCount, gh.user, gh.repos?.length || 0, gh.fetchedAt ? timeAgo(gh.fetchedAt) : '', gh.source, projects.length, extra.map(a => [a.user, a.mode, a.repos?.length || 0])]);
    patch(sourcesSlot, sig, () => projects.length || gh.fetchedAt ? [
      h('span.proj-source-chip', { title: 'Folders on this PC linked to CodaClauda' }, icon('folder'), plural(localCount, 'Desktop folder')),
      gh.fetchedAt
        ? h('span.proj-source-chip', { title: `Fetched ${fullTime(gh.fetchedAt)}${gh.source ? ` via ${describeSource(gh.source)}` : ''}` },
          icon('github'), h('span', `@${gh.user} · ${plural(gh.repos?.length || 0, 'repo')} · synced ${timeAgo(gh.fetchedAt)}`),
          h('button.proj-chip-btn', { type: 'button', dataset: { fk: 'gh-refresh' }, 'aria-label': 'Refresh GitHub repositories', title: 'Refresh GitHub repositories', onclick: event => refreshGithub(event.currentTarget) }, icon('refresh')))
        : h('button.proj-source-chip.as-button', { type: 'button', dataset: { fk: 'gh-connect' }, onclick: () => connectGithub() }, icon('github'), 'GitHub not connected'),
      ...extra.map(a => h('button.proj-source-chip.as-button', { type: 'button', title: `@${a.user}: ${store.accountLayout === 'islands' ? 'its own island beside your city' : 'part of your one big city'}. Manage GitHub accounts.`, onclick: () => openGithubAccounts({ store, bridge }) },
        icon('github'), h('span', `@${a.user} · ${plural(a.repos?.length || 0, 'repo')} · ${store.accountLayout === 'islands' ? 'own island' : 'in city'}`))),
    ] : null);
  }

  function renderManifest() {
    const list = Array.isArray(store.manifest?.projects) ? store.manifest.projects : [];
    const path = store.paths?.manifest_path || '';
    patch(manifestSlot, JSON.stringify([list.length, path]), () => list.length ? h('section.card.proj-manifest',
      h('span.proj-manifest-icon', icon('link')),
      h('div.proj-manifest-body',
        h('strong', `${plural(list.length, 'project')} ${list.length === 1 ? 'was' : 'were'} linked by an agent`),
        h('p', 'Codex or Claude can write this file to link projects (and their home agents) automatically. CodaClauda re-reads it every minute.'),
        path ? h('div.proj-manifest-path', h('code.mono', { title: path }, path), iconButton('copy', 'Copy manifest path', () => copyText(path, 'Manifest path copied'))) : null,
        h('details.proj-manifest-format', h('summary', 'File format'), h('pre.mono', MANIFEST_EXAMPLE)),
      ),
    ) : null);
  }

  /* ---------- row ---------- */
  function rowSignature(p, info) {
    const m = p.metrics;
    return JSON.stringify([
      p.name, p.description, p.source, p.path, p.repo?.full_name, p.repo?.private, pendingGithub(p), p.url,
      p.languages.slice(0, 4).map(l => [l.name, l.bytes]), p.primaryLanguage, p.color,
      m.loc, m.files, m.commits, m.commits7d, m.floors, m.footprint, m.glow, m.lastActivityAt ? timeAgo(m.lastActivityAt) : '',
      p.scannedAt || 0, Boolean(p.stats?.git), info.linked, info.manifest, info.scanning,
      info.agents.map(a => [a.id, a.name, a.provider, a.look]),
      info.access.level, info.access.explicit,
      team.supported(), team.loaded(), info.team.agentsCanStart, info.team.maxAgentStartedLive, info.teamDefault,
    ]);
  }

  function building(p) {
    const floors = Math.max(1, Math.min(24, p.metrics.floors || 1));
    const node = h(`span.proj-bldg.fp-${p.metrics.footprint || 1}`, { title: `${plural(floors, 'floor')} in the City` });
    node.style.setProperty('--pc', p.color);
    const bars = Math.ceil(floors / 2);
    for (let i = 0; i < bars; i++) node.append(h('i'));
    if (p.metrics.glow > 0.05) node.classList.add('lit');
    return node;
  }

  function languageBar(p) {
    const langs = [...p.languages].sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
    const total = langs.reduce((sum, l) => sum + (l.bytes || 0), 0);
    const bar = h('div.proj-langbar', { 'aria-hidden': 'true' });
    if (!total) { bar.classList.add('empty'); return bar; }
    let rest = total;
    for (const lang of langs.slice(0, 3)) {
      const seg = h('span', { title: `${lang.name} ${Math.round((lang.bytes / total) * 100)}%` });
      seg.style.setProperty('--c', lang.color);
      seg.style.flexGrow = String(lang.bytes || 0);
      bar.append(seg);
      rest -= lang.bytes || 0;
    }
    if (rest > total * 0.01) { const seg = h('span.other', { title: `Other ${Math.round((rest / total) * 100)}%` }); seg.style.flexGrow = String(rest); bar.append(seg); }
    return bar;
  }

  function buildRow(p, info) {
    const m = p.metrics;
    const ghPending = pendingGithub(p);
    const node = h('div.proj-row', { role: 'row', dataset: { id: p.id } });

    // Project
    const stack = info.agents.length ? h('span.proj-agents', { title: `Home of ${info.agents.map(a => a.name).join(', ')}` },
      info.agents.slice(0, 3).map(a => portrait(a.look, { size: 20, provider: a.provider, title: a.name })),
      info.agents.length > 3 ? h('span.proj-agents-more', `+${info.agents.length - 3}`) : null) : null;
    const nameCell = h('div.proj-cell.col-name', { role: 'cell' },
      building(p),
      h('div.proj-ident',
        h('div.proj-name-line',
          h('strong.proj-name', { title: p.name }, p.name),
          info.manifest ? h('span.pill.accent.proj-tag', { title: 'Linked by an agent through the project manifest' }, 'agent-linked') : null,
          h('span.pill.proj-tag.proj-hidden-tag', { hidden: true, title: 'Hidden from both the Board and the City' }, 'hidden')),
        h('div.proj-desc', { title: p.description || '' }, p.description || (p.path ? baseName(p.path) : p.repo?.full_name || ghPending || '')),
        stack));

    // Source
    const sources = [];
    if (p.path) sources.push(h('span.proj-src', { title: info.linked ? p.path : `${p.path}\nListed by an agent — not scanned on this PC yet` },
      icon('folder'), h('span.proj-src-text', shortPath(p.path)), info.linked ? null : h('span.proj-src-note', 'not linked')));
    if (p.repo) sources.push(h('span.proj-src', { title: `${p.repo.full_name}${p.repo.private ? ' (private)' : ''}` },
      icon('github'), h('span.proj-src-text', p.repo.full_name), p.repo.private ? icon('lock', 'proj-src-lock') : null));
    else if (ghPending) sources.push(h('span.proj-src.pending', { title: 'Listed by an agent. Connect GitHub to load repository stats.' }, icon('github'), h('span.proj-src-text', ghPending)));
    const sourceCell = h('div.proj-cell.col-source', { role: 'cell' }, sources.length ? sources : h('span.muted', '—'));

    // Code
    const scannedNever = info.linked && !p.scannedAt;
    const codeCell = h('div.proj-cell.col-code', { role: 'cell' },
      info.scanning
        ? h('div.proj-scanning', h('span.spinner'), 'Scanning…')
        : scannedNever || (!info.linked && p.path && !p.repo && !m.loc)
          ? h('button.proj-link-btn', { type: 'button', dataset: { fk: 'scan-now' }, onclick: () => rescanOne(p) }, icon('refresh'), info.linked ? 'Not scanned — scan now' : 'Link & scan this folder')
          : [
            languageBar(p),
            h('div.proj-code-line',
              h('span.proj-lang', h('span.proj-lang-dot', { 'aria-hidden': 'true' }), p.primaryLanguage),
              m.loc ? h('span.muted', { title: m.sizeBytes ? formatBytes(m.sizeBytes) : '' }, ` · ${formatNumber(m.loc)} lines (est.)`) : null),
            h('div.proj-sub',
              m.files ? `${plural(m.files, 'file')}` : p.repo ? `${formatBytes((p.repo.size_kb || 0) * 1024)} on GitHub` : '',
              h('span.proj-narrow-activity', m.lastActivityAt ? ` · updated ${timeAgo(m.lastActivityAt)}` : '')),
          ]);
    codeCell.querySelector('.proj-lang-dot')?.style.setProperty('--c', p.color);

    // Activity
    const exactRecent = p.stats?.git?.commits_7d != null;
    const activityCell = h('div.proj-cell.col-activity', { role: 'cell' },
      h('div.proj-commits',
        m.commits ? `${formatNumber(m.commits)} commit${m.commits === 1 ? '' : 's'}` : h('span.muted', 'Commits —'),
        m.commits7d ? h('span.proj-recent', { title: exactRecent ? 'Commits in the last 7 days' : 'Pushed in the last 7 days' }, exactRecent ? `+${m.commits7d} this week` : 'active this week') : null),
      h('div.proj-sub', { title: m.lastActivityAt ? fullTime(m.lastActivityAt) : '' }, m.lastActivityAt ? `last ${timeAgo(m.lastActivityAt)}` : 'no activity yet'));

    // Switches
    const switchFor = surface => {
      const input = h('input', {
        type: 'checkbox', checked: p.visible[surface], dataset: { fk: surface },
        'aria-label': `Show ${p.name} ${SURFACE_TEXT[surface].on}`,
        onchange: event => {
          const project = currentProject(p.id);
          if (!project) return;
          saveSettings(project, { [surface]: event.currentTarget.checked });
        },
      });
      return [h('label.switch', { title: `Show ${SURFACE_TEXT[surface].on}` }, input, h('span')), input];
    };
    const [boardSwitch, boardInput] = switchFor('board');
    const [citySwitch, cityInput] = switchFor('city');

    const menuButton = iconButton('more', `More actions for ${p.name}`, event => openRowMenu(event.currentTarget, p.id));
    menuButton.dataset.fk = 'menu';
    menuButton.setAttribute('aria-haspopup', 'menu');
    menuButton.setAttribute('aria-expanded', 'false');

    node.append(nameCell, sourceCell, codeCell, activityCell,
      h('div.proj-cell.col-switch', { role: 'cell' }, boardSwitch),
      h('div.proj-cell.col-switch', { role: 'cell' }, citySwitch),
      h('div.proj-cell.col-menu', { role: 'cell' }, menuButton),
      accessStrip(p, info));
    return { node, board: boardInput, city: cityInput, hiddenTag: node.querySelector('.proj-hidden-tag') };
  }

  /** Second line of a row: the access level for sessions CodaClauda starts here. */
  function accessStrip(p, info) {
    const a = info.access;
    const levels = h('div.acc-levels', { role: 'group', 'aria-label': `Access level for ${p.name}` }, LEVELS.map(level => h(`button.acc-level.${level.id}`, {
      type: 'button', 'aria-pressed': String(a.level === level.id), dataset: { fk: `lvl-${level.id}` }, style: { '--lc': level.color },
      title: a.level === level.id ? `${level.long} (current): ${level.rule}` : `Set ${p.name} to ${level.long}: ${level.rule}`,
      onclick: () => { if (store.projectAccess(p.id).level !== level.id) saveAccess([p], { level: level.id }, `${p.name}: ${level.long}`); },
    }, h('span.acc-dot', { 'aria-hidden': 'true' }), h('span', level.label))));
    const tools = hasFeature('mcpGet') || hasFeature('instructionsRead');
    return h('div.proj-access', { role: 'cell', 'aria-label': `Access for ${p.name}: ${levelInfo(a.level).long}` },
      h('span.proj-access-label', icon('shield'), 'Access'), levels,
      h('span.proj-access-hint', a.explicit ? levelInfo(a.level).rule : `${levelInfo(a.level).rule} Default for ${a.level === 'full' ? 'your own projects' : "projects you don't own"}.`),
      tools ? null : h('span.proj-access-hint', BROWSER_UNAVAILABLE),
      p.path ? null : h('span.proj-access-hint', 'No local folder: clone it to run sessions.'),
      tools && p.path ? h('span.proj-tools',
        hasFeature('mcpGet') ? h('button.btn.small.ghost', { type: 'button', dataset: { fk: 'mcp' }, title: MCP_NOTE, onclick: () => openMcpTools(ctx, currentProject(p.id) || p) }, icon('plug'), 'MCP tools') : null,
        hasFeature('instructionsRead') ? h('button.btn.small.ghost', { type: 'button', dataset: { fk: 'instructions' }, title: 'Edit CLAUDE.md and AGENTS.md at the project root', onclick: () => openInstructions(ctx, currentProject(p.id) || p) }, icon('file'), 'Instructions') : null) : null,
      team.supported() && p.path ? h('button.btn.small.ghost', { type: 'button', dataset: { fk: 'team' }, 'aria-pressed': String(info.team.agentsCanStart),
        title: !team.loaded() ? 'Reading the team settings…' : `${info.team.agentsCanStart ? `Agents can start teammates here (${info.team.maxAgentStartedLive === 'unlimited' ? 'no limit' : `at most ${info.team.maxAgentStartedLive} working at once`})` : 'Agents cannot start teammates here'}${info.teamDefault ? ', following Settings → Team' : ', this project\'s own setting'}`,
        onclick: () => openTeam(currentProject(p.id) || p) }, icon('agents'), !team.loaded() ? 'Teammates' : info.team.agentsCanStart ? 'Teammates: on' : 'Teammates: off') : null);
  }

  /** Whether agents may start teammates in one project, and how many of them may work at once:
   *  Settings → Team for every project, unless this project has its own setting. */
  function openTeam(p) {
    // Until the saved settings are read, a project's own setting is unknown: never offer a form that could replace it.
    if (!team.loaded()) {
      Promise.resolve(team.load()).then(() => (team.loaded() ? openTeam(p)
        : toast(`Couldn't read the team settings${team.error ? `: ${team.error}` : ''}. Nothing was changed.`, { kind: 'error', timeout: 8000 })));
      return;
    }
    const current = team.get(p);
    const follows = h('input', { type: 'checkbox', checked: teamFollowsDefault(p), 'aria-label': 'Use my setting from Settings → Team', onchange: () => sync() });
    const on = h('input', { type: 'checkbox', checked: current.agentsCanStart, 'aria-label': `Agents can start teammates in ${p.name}` });
    const unlimited = h('input', { type: 'checkbox', checked: current.maxAgentStartedLive === 'unlimited', 'aria-label': 'No limit on agent-started sessions working at once', onchange: () => sync() });
    const count = h('input.input', { type: 'text', inputMode: 'numeric', autocomplete: 'off', style: { width: '90px' }, 'aria-label': 'Agent-started sessions working at once', value: current.maxAgentStartedLive === 'unlimited' ? '' : String(current.maxAgentStartedLive) });
    const error = h('p.inline-error', { role: 'alert', hidden: true });
    const sync = () => { on.disabled = follows.checked; unlimited.disabled = follows.checked; count.disabled = follows.checked || unlimited.checked; };
    sync();
    modal({
      title: `Teammates · ${p.name}`,
      body: h('div.pt-body',
        h('div.setting-row', h('div.setting-text', h('strong', 'Use my setting from Settings → Team'),
          h('span.field-hint', 'On: this project follows Agents can start teammates in my projects. Off: the two settings below apply to this project only.')),
          h('label.switch', follows, h('span'))),
        h('div.setting-row', h('div.setting-text', h('strong', 'Agents can start teammates'),
          h('span.field-hint', `When on, a CodaClauda agent can ask for a new Claude Code or Codex session here by posting to ${TEAM_ADDRESS}. It starts at this project's access level (${levelInfo(store.projectAccess(p.id).level).long}), never higher, with wake on and the request as its first message, and the asker gets its board address.`)),
          h('label.switch', on, h('span'))),
        h('div.setting-row', h('div.setting-text', h('strong', 'Agent-started sessions working at once'),
          h('span.field-hint', 'A request past this many is refused with a reason; sessions you start yourself never count.')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, count, h('label.checkbox-label', unlimited, h('span', 'Unlimited')))),
        h('p.field-hint', 'Your switch is the authority. A board message is information; its sender name is self-asserted and cannot raise access. Every request gets a reply on the board.'),
        error),
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', run: async () => {
        const guard = limitValue(count.value, unlimited.checked, 1);
        if (!follows.checked && guard == null) { error.hidden = false; error.textContent = 'Enter a whole number of sessions (1 or more), or tick Unlimited.'; return false; }
        try {
          const saved = await team.set(p, follows.checked ? { useDefault: true } : { agentsCanStart: on.checked, maxAgentStartedLive: guard });
          const limit = saved.maxAgentStartedLive === 'unlimited' ? 'no limit' : `at most ${saved.maxAgentStartedLive} at once`;
          toast(`${p.name}: ${saved.agentsCanStart ? `agents can start teammates (${limit})` : 'agents cannot start teammates'}${follows.checked ? ', as in Settings → Team' : ''}.`, { kind: 'success', timeout: 4200 });
          return true;
        } catch (failure) { error.hidden = false; error.textContent = failure?.message || String(failure); return false; }
      } }],
    });
  }

  /** The project has no Teammates setting of its own (it follows Settings → Team). */
  function teamFollowsDefault(p) {
    const saved = team.projects?.[team.get(p).key];
    return !saved || saved.followsDefault !== false;
  }

  /** Folders an agent's start request registered join Projects at the level they were registered at. Only a
   *  Read level is written: a linked folder is Full by default anyway, and a written Full could outrank a Read
   *  you saved under another id of the same project. An existing record is never replaced. */
  function adoptTeamFolders() {
    if (typeof store.updateDesktop !== 'function') return;
    const fresh = teamAdoptions(team.projects, store.desktop.projects.local);
    if (!fresh.length) return;
    store.updateDesktop(d => {
      d.projectAccess ||= {};
      for (const f of fresh) {
        d.projects.local.push({ path: f.path, name: f.name, addedAt: Date.now(), fromTeam: true });
        if (f.level === 'read' && !d.projectAccess[f.id]) d.projectAccess[f.id] = { level: 'read', playwright: false, updatedAt: Date.now() };
      }
    });
    toast(`Added ${fresh.map(f => `${f.name} (${levelInfo(f.level).long})`).join(', ')}: an agent asked to start a teammate there.`, { timeout: 7000 });
  }

  function openAccessMenu(anchor) {
    const n = shownProjects.length, everything = n === store.projects.length;
    const scope = everything ? `all ${n}` : `all ${n} matching`;
    const hint = `Applies to ${everything ? `all ${plural(n, 'project')}` : `all ${n} matching ${n === 1 ? 'project' : 'projects'}`}${n > PAGE_SIZE ? ', on every page' : ''}, from the next session started in each.`;
    openMenu(anchor, [
      { hint },
      ...LEVELS.map(level => ({ swatch: level.color, label: `Set ${scope} to ${level.long}`, run: () => bulkAccess({ level: level.id }, `Set to ${level.long}`) })),
    ], `Access: ${hint.charAt(0).toLowerCase()}${hint.slice(1)}`);
  }

  async function saveAccess(list, patch, what) {
    try { await store.setProjectAccessMany(list.map(p => [p.id, patch])); toast(`${what}. Applies to the next session started there.`, { kind: 'success', timeout: 4000 }); return true; }
    catch (error) { toast(error.message || String(error), { kind: 'error', timeout: 8000 }); return false; }
  }

  /** One strict save for every matching project, with Undo back to each one's own level. */
  async function bulkAccess(patch, what) {
    const list = shownProjects.slice();
    if (!list.length) return;
    const before = list.map(p => [p.id, store.projectAccess(p.id).level]);
    try { await store.setProjectAccessMany(list.map(p => [p.id, patch])); }
    catch (error) { toast(error.message || String(error), { kind: 'error', timeout: 8000 }); return; }
    toast(`${what}: ${plural(list.length, 'project')}. Applies to the next session started in each.`, {
      kind: 'success', timeout: 7000,
      action: { label: 'Undo', run: () => store.setProjectAccessMany(before.map(([id, level]) => [id, { level }])).catch(error => toast(error.message || String(error), { kind: 'error', timeout: 8000 })) },
    });
  }

  function openRowMenu(anchor, id) {
    const p = currentProject(id);
    if (!p) return;
    const linked = isLinkedLocal(p);
    const busy = Boolean(p.path && scanning.has(normalizePath(p.path)));
    openMenu(anchor, [
      p.path ? { icon: 'refresh', label: linked ? 'Rescan' : 'Link & scan folder', disabled: busy, run: () => rescanOne(p) } : null,
      p.path ? { icon: 'folder', label: 'Open folder', run: () => openExternal(p.path) } : null,
      p.url || p.repo || pendingGithub(p) ? { icon: 'external', label: 'Open on GitHub', run: () => openExternal(p.url || `https://github.com/${p.repo?.full_name || pendingGithub(p)}`) } : null,
      { icon: 'tag', label: 'Rename & aliases', run: () => renameProject(p) },
      p.path ? { icon: 'file', label: 'Edit CLAUDE.md / AGENTS.md', run: () => openInstructions(ctx, p) } : null,
      { icon: 'plug', label: 'MCP tools (Full access only)', run: () => openMcpTools(ctx, p) },
      store.prefs.chatFirst ? null : { icon: 'city', label: 'Show in City', disabled: !p.visible.city, title: p.visible.city ? '' : 'Hidden from the City', run: () => navigate('city', { focusProject: p.id }) },
      'sep',
      { icon: 'unlink', label: 'Unlink…', danger: true, run: () => unlinkProject(p) },
    ], `Actions for ${p.name}`);
  }

  function openBulkMenu(anchor) {
    // Scope is every project matching the current filter and search, on all pages, not just the visible page.
    const n = shownProjects.length;
    const everything = n === store.projects.length;
    const scope = everything ? `all ${n}` : `all ${n} matching`;
    const multiPage = n > PAGE_SIZE;
    const hint = everything
      ? `Applies to all ${plural(n, 'project')}${multiPage ? ', on every page' : ''}`
      : `Applies to all ${n} matching ${n === 1 ? 'project' : 'projects'}${multiPage ? ', on every page' : ''}`;
    openMenu(anchor, [
      { hint },
      { icon: 'eye', label: `Show ${scope} in City`, run: () => bulk('city', true) },
      { icon: 'eyeOff', label: `Hide ${scope} from City`, run: () => bulk('city', false) },
      'sep',
      { icon: 'eye', label: `Show ${scope} on Board`, run: () => bulk('board', true) },
      { icon: 'eyeOff', label: `Hide ${scope} from Board`, run: () => bulk('board', false) },
    ], `Visibility: ${hint.charAt(0).toLowerCase()}${hint.slice(1)}`);
  }

  function bulk(surface, value) {
    const changed = shownProjects.filter(p => p.visible[surface] !== value);
    if (!changed.length) { toast(`All ${plural(shownProjects.length, 'project')} already ${value ? 'shown' : 'hidden'} ${value ? SURFACE_TEXT[surface].on : SURFACE_TEXT[surface].from}`, { timeout: 2600 }); return; }
    const before = new Map(changed.map(p => [p.id, p.visible[surface]]));
    saveMany(changed, () => ({ [surface]: value }));
    toast(`${value ? 'Showing' : 'Hid'} ${plural(changed.length, 'project')} ${value ? SURFACE_TEXT[surface].on : SURFACE_TEXT[surface].from}`, {
      kind: 'success', timeout: 7000,
      action: { label: 'Undo', run: () => {
        const projects = [...before.keys()].map(currentProject).filter(Boolean);
        saveMany(projects, p => ({ [surface]: before.get(p.id) }));
      } },
    });
  }

  /* ---------- actions ---------- */
  async function newProject() {
    let result = null;
    try { result = await openNewProjectDialog(ctx); }
    catch (error) { toast(`Could not open New project: ${error.message}`, { kind: 'error' }); return; }
    // Bring the new row into view and flash it (show() handles both).
    if (result?.projectId && state.visible) navigate('projects', { project: result.projectId });
  }

  async function openExternal(target) {
    try { await bridge.desktop.openExternal(target); }
    catch (error) { toast(`Could not open ${target}: ${error.message}`, { kind: 'error' }); }
  }

  async function linkFolder(button) {
    setBusy(button, true);
    try {
      const path = await store.linkFolder();
      if (path) toast(`Linked ${baseName(path)} — it's on your Board and in your City now`, { kind: 'success' });
    } catch (error) {
      toast(`Could not link that folder: ${error.message}`, { kind: 'error' });
    } finally { setBusy(button, false); }
  }

  async function scanOne(path) {
    const key = normalizePath(path);
    scanning.add(key); schedule();
    try { return await store.scanProject(path); }
    finally { scanning.delete(key); schedule(); }
  }

  async function rescanOne(p) {
    const key = normalizePath(p.path);
    if (scanning.has(key)) return;
    try {
      if (isLinkedLocal(p)) { await scanOne(p.path); toast(`Rescanned ${p.name}`, { kind: 'success', timeout: 2400 }); }
      else {
        scanning.add(key); schedule();
        try { await store.linkFolder(p.path); } finally { scanning.delete(key); schedule(); }
        toast(`Linked and scanned ${p.name}`, { kind: 'success' });
      }
    } catch (error) { toast(`Could not scan ${p.name}: ${error.message}`, { kind: 'error' }); }
  }

  function showProgress() {
    progressNode.hidden = !op;
    if (!op) return;
    if (!op.cancelled) progressLabel.textContent = `${op.title} ${Math.min(op.done + 1, op.total)} of ${op.total}${op.current ? ` · ${op.current}` : ''}`;
    progressFill.style.width = `${Math.round((op.done / op.total) * 100)}%`;
  }

  async function rescanAll() {
    if (op) { toast('A rescan is already running'); return; }
    const paths = (store.desktop.projects.local || []).map(p => p.path);
    if (!paths.length) {
      toast(store.projects.length ? 'Only GitHub projects are linked — refresh them from the GitHub chip.' : 'Link a folder first, then rescan.', { timeout: 4000 });
      return;
    }
    op = { title: 'Rescanning', total: paths.length, done: 0, current: '', cancelled: false };
    rescanButton.disabled = true;
    let ok = 0;
    const failed = [];
    for (const path of paths) {
      if (op.cancelled) break;
      op.current = baseName(path);
      showProgress();
      try { await scanOne(path); ok++; } catch { failed.push(baseName(path)); }
      op.done++;
      showProgress();
    }
    const cancelled = op.cancelled;
    op = null;
    showProgress();
    rescanButton.disabled = false;
    if (failed.length) toast(`Rescanned ${ok} of ${paths.length}. Could not scan: ${failed.join(', ')}`, { kind: 'error', timeout: 8000 });
    else toast(cancelled ? `Stopped after ${plural(ok, 'project')}` : `Rescanned ${plural(ok, 'project')}`, { kind: 'success' });
  }

  async function scanDesktop(button) {
    if (op) { toast('Wait for the current rescan to finish'); return; }
    setBusy(button, true, 'Scanning…');
    let found;
    try { found = (await store.discoverDesktop())?.projects || []; }
    catch (error) { toast(`Could not scan your Desktop: ${error.message}`, { kind: 'error' }); return; }
    finally { setBusy(button, false); }

    const desktopDir = store.paths?.desktop_dir || 'your Desktop';
    if (!found.length) {
      modal({
        title: 'Scan my Desktop',
        body: emptyState('folder', 'No project folders found', `Nothing in ${desktopDir} looked like a project. Use Link folder to pick one anywhere on your PC.`),
        actions: [{ label: 'Close' }, { label: 'Link folder…', kind: 'primary', run: () => { linkFolder(linkButton); } }],
      });
      return;
    }

    const linked = linkedLocalPaths();
    const choices = found.map(item => {
      const already = linked.has(normalizePath(item.path));
      return { ...item, already, checked: !already && Boolean(item.is_git) };
    });
    const selectable = choices.filter(c => !c.already);
    const progressBar = h('div.proj-progress-fill');
    const progressText = h('span.scan-progress-label');
    const progress = h('div.scan-progress', { hidden: true, role: 'status', 'aria-live': 'polite' }, progressText, h('div.proj-progress-bar', progressBar));
    const boxes = [];
    let dialog;
    const count = () => choices.filter(c => c.checked && !c.already).length;
    const syncButton = () => {
      const button = dialog?.querySelector('.modal-actions .btn.primary');
      if (!button) return;
      const n = count();
      button.textContent = n ? `Link ${plural(n, 'folder')}` : 'Link folders';
      button.disabled = !n;
    };
    const setAll = value => { for (const [index, c] of choices.entries()) if (!c.already) { c.checked = value; boxes[index].checked = value; } syncButton(); };

    const list = h('ul.scan-list', choices.map((c, index) => {
      const box = h('input', { type: 'checkbox', checked: c.checked, disabled: c.already, onchange: event => { c.checked = event.currentTarget.checked; syncButton(); } });
      boxes[index] = box;
      return h(`li.scan-item${c.already ? '.linked' : ''}`, h('label',
        box,
        h('span.scan-icon', icon(c.is_git ? 'github' : 'folder')),
        h('span.scan-text',
          h('span.scan-name-line',
            h('strong', c.name || baseName(c.path)),
            c.is_git ? h('span.pill.success', 'Git') : null,
            (c.markers || []).slice(0, 4).map(marker => h('span.pill.scan-marker', marker)),
            c.already ? h('span.pill.accent', 'Linked') : null),
          h('span.scan-path.mono', { title: c.path }, c.path))));
    }));

    const body = h('div.scan-modal',
      h('p.muted', `Found ${plural(found.length, 'folder')} in ${desktopDir}. Git repositories are pre-selected; already linked folders are greyed out.`),
      selectable.length > 1 ? h('div.scan-tools',
        h('button.btn.small.ghost', { type: 'button', onclick: () => setAll(true) }, 'Select all'),
        h('button.btn.small.ghost', { type: 'button', onclick: () => setAll(false) }, 'Select none')) : null,
      list,
      progress);

    dialog = modal({
      title: 'Scan my Desktop',
      wide: true,
      body,
      actions: [
        { label: 'Cancel' },
        { label: 'Link folders', kind: 'primary', run: async () => {
          const picks = choices.filter(c => c.checked && !c.already);
          if (!picks.length) return false;
          for (const b of boxes) b.disabled = true;
          progress.hidden = false;
          let ok = 0;
          const failed = [];
          for (const [index, c] of picks.entries()) {
            progressText.textContent = `Linking ${c.name || baseName(c.path)} (${index + 1} of ${picks.length})…`;
            progressBar.style.width = `${Math.round((index / picks.length) * 100)}%`;
            const key = normalizePath(c.path);
            scanning.add(key);
            try { await store.linkFolder(c.path); ok++; } catch { failed.push(c.name || baseName(c.path)); }
            finally { scanning.delete(key); schedule(); }
          }
          progressBar.style.width = '100%';
          if (failed.length) toast(`Linked ${ok} of ${picks.length}. Could not link: ${failed.join(', ')}`, { kind: 'error', timeout: 8000 });
          else toast(`Linked ${plural(ok, 'folder')} — they're on your Board and in your City now`, { kind: 'success' });
          return true;
        } },
      ],
    });
    syncButton();
  }

  function connectGithub() {
    const gh = store.desktop.projects.github || {};
    const input = h('input.input', { type: 'text', value: gh.user || '', placeholder: 'GitHub username', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'GitHub username' });
    const error = h('p.proj-error', { hidden: true, role: 'alert' });
    const body = h('div.gh-modal',
      h('label.field', 'GitHub username', input,
        h('span.field-hint', "Uses the GitHub CLI if you're signed in (includes private repos); otherwise the public GitHub API.")),
      gh.fetchedAt
        ? h('div.gh-status', icon('check'), h('span', `Last synced ${timeAgo(gh.fetchedAt)} as @${gh.user} · ${plural(gh.repos?.length || 0, 'repository', 'repositories')}${gh.source ? ` via ${describeSource(gh.source)}` : ''}.`))
        : null,
      h('p.field-hint', 'Each repository becomes a project. Hide the ones you don\'t want on the Board or in the City.'),
      error);
    if (!input.value) {
      Promise.resolve().then(() => bridge.desktop.githubUser()).then(result => {
        const login = typeof result === 'string' ? result : result?.login || result?.user || '';
        if (login && !input.value) input.value = login;
      }).catch(() => { /* not signed in to the GitHub CLI — type it instead */ });
    }
    const dialog = modal({
      title: gh.fetchedAt ? 'GitHub repositories' : 'Connect GitHub',
      body,
      actions: [
        { label: 'Cancel' },
        { label: gh.fetchedAt ? 'Refresh' : 'Link repositories', kind: 'primary', run: async () => {
          const user = input.value.trim().replace(/^@/, '');
          if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(user)) { error.textContent = 'Enter a GitHub username (letters, numbers and dashes).'; error.hidden = false; input.focus(); return false; }
          error.hidden = true;
          try {
            const result = await store.linkGithub(user);
            const repos = result?.repos || [];
            const privateCount = repos.filter(r => r.private).length;
            toast(`Linked ${plural(repos.length, 'repository', 'repositories')} from @${result?.user || user}${privateCount ? ` (${privateCount} private)` : ''}`, { kind: 'success' });
            return true;
          } catch (err) {
            error.textContent = `Could not load repositories: ${err.message}`;
            error.hidden = false;
            return false;
          }
        } },
      ],
    });
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); dialog.querySelector('.modal-actions .btn.primary')?.click(); } });
    input.focus();
  }

  async function refreshGithub(button) {
    const user = store.desktop.projects.github?.user;
    if (!user) { connectGithub(); return; }
    button.disabled = true;
    button.classList.add('spinning');
    try {
      const result = await store.linkGithub(user);
      toast(`GitHub refreshed · ${plural(result?.repos?.length || 0, 'repository', 'repositories')}`, { kind: 'success', timeout: 2600 });
    } catch (error) {
      toast(`Could not refresh GitHub: ${error.message}`, { kind: 'error' });
    } finally {
      if (button.isConnected) { button.disabled = false; button.classList.remove('spinning'); }
    }
  }

  function renameProject(p) {
    const own = effectiveSettings(p);
    const original = p.aliases[0] || p.name;
    const custom = Array.isArray(own.aliases) ? own.aliases : [];
    const derived = p.aliases.filter(a => !custom.includes(a));
    const nameInput = h('input.input', { type: 'text', value: p.name, placeholder: original, maxLength: 80, 'aria-label': 'Display name' });
    const aliasInput = h('input.input', { type: 'text', value: custom.join(', '), placeholder: 'e.g. forge, pf-release', 'aria-label': 'Aliases' });
    const body = h('div.rename-modal',
      h('label.field', 'Display name', nameInput, h('span.field-hint', `Shown on the Board and on the building. Leave empty to use “${original}”.`)),
      h('label.field', 'Aliases', aliasInput, h('span.field-hint', 'Other names agents might use, comma-separated. Messages tagged [Alias] or "Project: Alias" land here.')),
      derived.length ? h('p.field-hint', 'Already matched by: ', derived.map((a, i) => [i ? ', ' : '', h('code', a)])) : null);
    const dialog = modal({
      title: `Rename ${p.name}`,
      body,
      actions: [
        { label: 'Cancel' },
        { label: 'Save', kind: 'primary', run: () => {
          const name = nameInput.value.trim();
          const aliases = [...new Set(aliasInput.value.split(',').map(a => a.trim()).filter(Boolean))].slice(0, 20);
          const project = currentProject(p.id) || p;
          saveSettings(project, { name: name && name !== original ? name.slice(0, 80) : undefined, aliases });
          toast(`Saved ${name || original}`, { kind: 'success', timeout: 2200 });
        } },
      ],
    });
    for (const input of [nameInput, aliasInput]) input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); dialog.querySelector('.modal-actions .btn.primary')?.click(); } });
    nameInput.focus();
    nameInput.select();
  }

  function unlinkProject(p) {
    const manifest = isFromManifest(p);
    const what = [p.path ? 'folder link' : null, p.repo ? 'GitHub listing' : null].filter(Boolean).join(' and ') || 'link';
    const body = h('div.unlink-modal',
      h('p', `CodaClauda will forget the ${what} for ${p.name}. Your files and repository are not touched.`),
      manifest
        ? h('div.proj-callout', icon('alert'), h('span', 'An agent listed this project in the project manifest, so it will reappear while it is listed there. To keep it out of sight, hide it from the Board and City instead.'))
        : p.repo ? h('p.field-hint', 'Refreshing GitHub lists every repository again — hide it instead if you want it gone for good.') : null);
    modal({
      title: `Unlink ${p.name}?`,
      body,
      actions: [
        { label: 'Cancel' },
        { label: 'Hide everywhere instead', kind: manifest ? 'primary' : 'ghost', run: () => {
          saveSettings(currentProject(p.id) || p, { board: false, city: false });
          toast(`${p.name} is hidden from the Board and City`, { kind: 'success', action: { label: 'Undo', run: () => saveSettings(currentProject(p.id) || p, { board: p.visible.board, city: p.visible.city }) } });
        } },
        { label: 'Unlink', kind: 'danger', run: () => {
          const d = store.desktop.projects;
          const localEntries = (d.local || []).filter(item => p.ids.includes(`local:${normalizePath(item.path)}`));
          const repoEntries = (d.github?.repos || []).filter(r => p.ids.includes(`gh:${String(r.full_name || r.name).toLowerCase()}`));
          store.unlinkProject(p);
          // A folder an agent registered is forgotten too, so it does not come back on its own.
          if (team.projects?.[team.get(p).key]?.autoRegistered) team.set(p, { remove: true }).catch(error => toast(`Couldn't forget the teammate registration: ${error?.message || error}`, { kind: 'error', timeout: 8000 }));
          const canUndo = typeof store.updateDesktop === 'function' && (localEntries.length || repoEntries.length);
          toast(`Unlinked ${p.name}`, { kind: 'success', timeout: 7000, action: canUndo ? { label: 'Undo', run: () => store.updateDesktop(draft => {
            draft.projects.local.push(...localEntries);
            draft.projects.github.repos.push(...repoEntries);
          }) } : undefined });
        } },
      ],
    });
  }

  store.on('change', schedule);
  team.on('change', schedule);

  return {
    show(params = {}) {
      state.visible = true;
      Promise.resolve(team.load()).then(adoptTeamFolders);
      if (params.filter && FILTERS.some(f => f.id === params.filter)) setFilter(params.filter);
      if (state.frame) { cancelAnimationFrame(state.frame); state.frame = 0; }
      const target = params.project || params.projectId;
      const targetId = target ? store.project(target)?.id : null;
      state.focusId = targetId || null; // render() turns to the page that holds it
      render();
      const entry = targetId && rows.get(targetId);
      if (entry?.node.isConnected) {
        entry.node.scrollIntoView({ block: 'center', behavior: store.prefs.reducedMotion ? 'auto' : 'smooth' });
        entry.node.classList.remove('flash');
        void entry.node.offsetWidth;
        entry.node.classList.add('flash');
        setTimeout(() => entry.node.classList.remove('flash'), 2600);
      }
    },
    hide() {
      state.visible = false;
      closeMenu();
      if (state.frame) { cancelAnimationFrame(state.frame); state.frame = 0; state.dirty = true; }
    },
  };
}
