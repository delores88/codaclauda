/* Tasks: one board for everything agents are doing with the owner — tasks the
 * owner sent, questions waiting on either side, dedicated requests and claimed
 * resources. Kanban (drag & drop, or the keyboard "Move to…" menu) or a sortable
 * table, plus a detail drawer. Task and question statuses can be overridden by
 * the owner; request and claim statuses always come from the agent's real state. */
import { renderMarkdown } from '../markdown.js';
import { agentAvatar } from '../avatar/spec.js';
import { providerOf } from '../store.js';

const OWNER = 'owner';
const NONE = '__none';
const COLUMNS = [
  { id: 'todo', label: 'To do', empty: 'Nothing queued', hint: 'Queued and not started yet.' },
  { id: 'in-progress', label: 'In progress', empty: 'Nothing in flight', hint: 'An agent has picked it up and is working on it.' },
  { id: 'waiting', label: 'Waiting on agent', empty: 'No one to wait on', hint: 'Sent, but the agent has not opened it yet. It sees it at its next inbox check; schedules vary.' },
  { id: 'needs-you', label: 'Needs you', empty: 'You are all caught up', hint: 'An agent asked you something, or a request is blocked until you act.' },
  { id: 'done', label: 'Done', empty: 'Nothing finished yet', hint: 'Answered, finished or closed.' },
];
const COLUMN = Object.fromEntries(COLUMNS.map((c, i) => [c.id, { ...c, index: i }]));
const TYPES = [
  { id: 'task', label: 'Task', icon: 'check' },
  { id: 'question', label: 'Question', icon: 'tk-question' },
  { id: 'request', label: 'Request', icon: 'bolt' },
  { id: 'claim', label: 'Claim', icon: 'tk-lock' },
];
const TYPE = Object.fromEntries(TYPES.map(t => [t.id, t]));
const MOVABLE = new Set(['task', 'question']);
const LOCKED_TIP = "Status comes from the agent's real state";
const REQUEST_STATE = { queued: 'Queued', delivered: 'Delivered', acknowledged: 'Acknowledged', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', 'needs-owner': 'Needs you' };
const DONE_PAGE = 30;
const TABLE_PAGE = 25;   // bounded pages: the table never grows past one page
const MODE_KEY = 'codaclauda.tasks.mode';
const HEADERS = [
  { key: 'title', label: 'Title' },
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
  { key: 'agent', label: 'Agent' },
  { key: 'project', label: 'Project' },
  { key: 'updated', label: 'Updated' },
];
const ICONS = {
  'tk-more': '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  'tk-question': '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4M12 17h.01"/>',
  'tk-lock': '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  'tk-info': '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  'tk-sort': '<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>',
  'tk-up': '<path d="m6 15 6-6 6 6"/>',
  'tk-down': '<path d="m6 9 6 6 6-6"/>',
};

const findKey = (container, key) => [...container.children].find(node => node.dataset.key === key);
const short = (text, n = 48) => (String(text).length > n ? `${String(text).slice(0, n - 1)}…` : String(text));

/** Keyed list update: keeps nodes whose signature is unchanged, rebuilds the rest in place, then orders them. */
function reconcile(container, cache, items, build) {
  const next = new Map();
  let cursor = container.firstChild;
  for (const item of items) {
    let entry = cache.get(item.key);
    if (!entry || entry.sig !== item.sig) {
      const node = build(item);
      node.dataset.key = item.key;
      if (entry?.node.parentNode === container) { if (cursor === entry.node) cursor = node; entry.node.replaceWith(node); }
      entry = { node, sig: item.sig };
    }
    next.set(item.key, entry);
    if (entry.node === cursor) cursor = cursor.nextSibling;
    else container.insertBefore(entry.node, cursor);
  }
  while (cursor) { const after = cursor.nextSibling; cursor.remove(); cursor = after; }
  cache.clear();
  for (const [key, entry] of next) cache.set(key, entry);
}

/** Runs fn() while keeping the first visible item in place and focus on the same control. */
function stable(scroller, container, fn) {
  const active = document.activeElement;
  const holder = active && container.contains(active) ? active.closest('[data-key]') : null;
  const focusKey = holder?.dataset.key, focusId = active?.dataset?.fid;
  let anchorKey = null, anchorTop = 0;
  if (scroller.scrollTop > 0) {
    const top = scroller.getBoundingClientRect().top;
    for (const child of container.children) {
      if (!child.dataset.key) continue;
      const rect = child.getBoundingClientRect();
      if (rect.bottom > top) { anchorKey = child.dataset.key; anchorTop = rect.top; break; }
    }
  }
  fn();
  if (anchorKey) {
    const node = findKey(container, anchorKey);
    if (node) { const delta = node.getBoundingClientRect().top - anchorTop; if (Math.abs(delta) > 0.5) scroller.scrollTop += delta; }
  }
  if (focusKey && !active.isConnected) {
    const node = findKey(container, focusKey);
    const pick = selector => (node?.matches(selector) ? node : node?.querySelector(selector));
    const target = (focusId && pick(`[data-fid="${CSS.escape(focusId)}"]`)) || pick('[data-fid]');
    target?.focus({ preventScroll: true });
  }
}

function readMode() { try { return localStorage.getItem(MODE_KEY) === 'table' ? 'table' : 'board'; } catch { return 'board'; } }
function saveMode(mode) { try { localStorage.setItem(MODE_KEY, mode); } catch { /* per-viewer convenience only */ } }

export function mount(root, ctx) {
  const { store, ui, navigate } = ctx;
  const { h, icon, iconButton, portrait, toast, timeAgo, fullTime, emptyState, clear, toMs, STATUS_LABEL } = ui;
  ui.registerIcons(ICONS);

  const state = {
    mode: readMode(),
    project: '', agent: '', type: '', search: '',
    sort: { key: 'updated', dir: -1 },
    doneLimit: DONE_PAGE, tablePage: 0, tableSig: '',
    drawer: null,
  };
  let visible = false, frame = 0, fallback = 0, dirty = false, searchTimer = 0;
  let drag = null, dropColumn = null, menu = null, pendingFocus = null, drawerReturn = null;
  const projectMemo = new Map();
  const avatarCache = new Map();

  /* ---------- lookups ---------- */
  function proj(id) {
    if (!id) return null;
    if (!projectMemo.has(id)) projectMemo.set(id, store.project(id) || null);
    return projectMemo.get(id);
  }
  function agentInfo(id) {
    const agent = store.agent(id);
    if (agent) return { id, name: agent.name, provider: agent.provider, status: agent.status, look: agent.look, known: true, kind: agent.kind };
    const raw = String(id || '');
    let name, provider;
    if (raw.startsWith('endpoint:')) {
      const endpoint = store.board.endpoints.find(e => e.id === raw.slice(9));
      name = endpoint?.label || raw.slice(9); provider = endpoint?.agent || providerOf(raw.slice(9));
    } else { name = store.addressLabel(raw); provider = providerOf(raw); }
    const key = `${raw}|${provider}|${name}`;
    if (!avatarCache.has(key)) avatarCache.set(key, agentAvatar(raw, provider, name));
    return { id: raw, name: name || 'Unknown agent', provider, status: undefined, look: avatarCache.get(key), known: raw.startsWith('endpoint:') };
  }
  const person = address => (address === OWNER ? { name: 'You', look: store.avatar || { name: 'You' } } : agentInfo(address));
  const face = (who, size, withStatus = false) => portrait(who.look, { size, provider: who.provider, status: withStatus ? who.status : undefined, title: who.name });
  const statusOf = task => (COLUMN[task.status] ? task.status : 'todo');
  const overrideOf = id => store.desktop?.tasks?.[id] || {};
  const reduceMotion = () => Boolean(store.prefs.reducedMotion) || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  /* ---------- small builders ---------- */
  const typePill = type => h(`span.tk-type.tk-t-${TYPE[type] ? type : 'task'}`, icon(TYPE[type]?.icon || 'check'), TYPE[type]?.label || type);
  const statusPill = status => h(`span.tk-status.tk-s-${status}`, h('span.tk-dot'), COLUMN[status]?.label || status);
  const projectChip = project => h('span.tk-project', { title: project.name }, h('span.tk-project-dot', { style: { '--dot': project.color } }), h('span.tk-project-name', project.name));
  function timeEl(value) {
    const ms = toMs(value);
    if (!Number.isFinite(ms) || !ms) return h('span.tk-time', '—');
    return h('time.tk-time', { dateTime: new Date(ms).toISOString(), title: fullTime(ms), dataset: { ts: String(ms) } }, timeAgo(ms));
  }
  function leftText(expires) {
    const min = Math.round((expires - Date.now()) / 60000);
    if (min <= 0) return 'Expiring';
    return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m left` : `${min} min left`;
  }
  const leftEl = expires => h('span.tk-left', { dataset: { expires: String(expires) } }, leftText(expires));
  function refreshClock() {
    for (const node of root.querySelectorAll('[data-ts]')) { const text = timeAgo(Number(node.dataset.ts)); if (node.textContent !== text) node.textContent = text; }
    for (const node of root.querySelectorAll('[data-expires]')) { const text = leftText(Number(node.dataset.expires)); if (node.textContent !== text) node.textContent = text; }
  }
  function cleanDetail(task) {
    let text = String(task.detail || '');
    if (task.type === 'task' && /Please reply on this thread with progress/.test(text)) {
      text = text.replace(/\n*Please reply on this thread with progress[\s\S]*$/, '').replace(/\n*Project: [^\n]*$/, '');
    }
    return text.trim();
  }
  const canChat = task => { const info = agentInfo(task.agentId); return info.known; };

  /* ---------- filtering ---------- */
  function boardTasks() {
    return store.tasks.filter(t => { const p = proj(t.projectId); return !p || p.visible.board; });
  }
  const projectMatches = (project, id) => project && (project.id === id || project.ids.includes(id));
  function applyFilters(list) {
    const q = state.search;
    return list.filter(t => {
      const project = proj(t.projectId);
      if (state.project === NONE && project) return false;
      if (state.project && state.project !== NONE && !projectMatches(project, state.project)) return false;
      if (state.agent && t.agentId !== state.agent) return false;
      if (state.type && t.type !== state.type) return false;
      if (q && !`${t.title}\n${t.detail}\n${agentInfo(t.agentId).name}\n${project?.name || ''}\n${t.from || ''}\n${t.to || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }
  const filtersActive = () => Boolean(state.project || state.agent || state.type || state.search);
  function clearFilters() {
    Object.assign(state, { project: '', agent: '', type: '', search: '' });
    searchInput.value = '';
    renderNow();
  }

  /* ---------- skeleton ---------- */
  const modeButtons = [['board', 'Board', 'kanban'], ['table', 'Table', 'table']].map(([id, label, iconName]) =>
    h('button', { type: 'button', 'aria-pressed': String(state.mode === id), title: `${label} view`, dataset: { mode: id }, onclick: () => setMode(id) }, icon(iconName), label));
  const projectSelect = h('select.select.tk-filter', { 'aria-label': 'Filter by project', onchange: event => { state.project = event.currentTarget.value; renderNow(); } });
  const agentSelect = h('select.select.tk-filter', { 'aria-label': 'Filter by agent', onchange: event => { state.agent = event.currentTarget.value; renderNow(); } });
  const typeSelect = h('select.select.tk-filter', { 'aria-label': 'Filter by type', onchange: event => { state.type = event.currentTarget.value; renderNow(); } },
    h('option', { value: '' }, 'All types'), TYPES.map(t => h('option', { value: t.id }, `${t.label}s`)));
  const searchInput = h('input.input.tk-search-input', { type: 'search', placeholder: 'Search tasks', 'aria-label': 'Search tasks', autocomplete: 'off', spellcheck: false,
    oninput: event => { clearTimeout(searchTimer); const value = event.currentTarget.value; searchTimer = setTimeout(() => { state.search = value.trim().toLowerCase(); renderNow(); }, 140); },
    onkeydown: event => { if (event.key === 'Escape' && event.currentTarget.value) { event.stopPropagation(); event.currentTarget.value = ''; state.search = ''; renderNow(); } } });
  const countLabel = h('span.tk-count-label', { 'aria-live': 'polite' });
  const clearButton = h('button.btn.ghost.small', { type: 'button', hidden: true, onclick: clearFilters }, icon('close'), 'Clear filters');

  const columnEls = new Map();
  const placeholder = h('div.tk-placeholder', { 'aria-hidden': 'true' });
  const board = h('div.tk-board', { role: 'region', 'aria-label': 'Task board' }, COLUMNS.map(col => {
    const list = h('div.tk-col-list', { role: 'list', 'aria-label': col.label });
    const empty = h('div.tk-col-empty', col.empty);
    const more = h('button.btn.ghost.small.tk-col-more', { type: 'button', hidden: true, onclick: () => { state.doneLimit += DONE_PAGE; renderNow(); } }, 'Show more');
    const count = h('span.tk-col-count');
    const body = h('div.tk-col-body', list, empty, more);
    const section = h(`section.tk-col.tk-s-${col.id}`, { dataset: { status: col.id } },
      h('header.tk-col-head', { title: col.hint }, h('span.tk-dot'), h('h3.tk-col-title', col.label), count, h('span.tk-spacer'), h('span.tk-col-info', { 'aria-label': col.hint, role: 'img' }, icon('tk-info'))),
      body);
    section.addEventListener('dragover', event => onDragOver(event, col.id));
    section.addEventListener('dragleave', event => { if (!section.contains(event.relatedTarget) && dropColumn === col.id) clearDropUI(); });
    section.addEventListener('drop', event => onDrop(event, col.id));
    columnEls.set(col.id, { section, list, empty, more, count, body, cache: new Map() });
    return section;
  }));

  const headerCells = new Map();
  const tbody = h('tbody');
  const pagePrev = h('button.btn.ghost.small', { type: 'button', 'aria-label': 'Previous page of tasks', onclick: () => { state.tablePage -= 1; renderNow(); } }, 'Previous');
  const pageNext = h('button.btn.ghost.small', { type: 'button', 'aria-label': 'Next page of tasks', onclick: () => { state.tablePage += 1; renderNow(); } }, 'Next');
  const pageRange = h('span.tk-pager-range', { 'aria-live': 'polite' });
  const tableMore = h('nav.tk-pager', { 'aria-label': 'Task table pages', hidden: true }, pageRange, h('div.tk-pager-controls', pagePrev, pageNext));
  const tableCache = new Map();
  const tableWrap = h('div.tk-table-wrap', { hidden: true },
    h('table.tk-table', h('thead', h('tr', HEADERS.map(col => {
      const th = h(`th.tk-th-${col.key}`, { scope: 'col', 'aria-sort': 'none' },
        h('button.tk-sort', { type: 'button', onclick: () => sortBy(col.key) }, h('span', col.label), h('span.tk-sort-icon', icon('tk-sort'))));
      headerCells.set(col.key, th);
      return th;
    }))), tbody),
    tableMore);
  const stageEmpty = h('div.tk-stage-empty', { hidden: true });

  const drawerHost = h('div.tk-drawer-host');
  const drawer = h('aside.tk-drawer', { role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Task details', inert: true }, drawerHost);
  const scrim = h('div.tk-scrim', { onclick: () => closeDrawer() });

  const page = h('div.tk-page',
    h('header.page-head.tk-head',
      h('div', h('h1', 'Tasks'), h('p', 'Everything in flight with your agents: tasks you sent, questions on either side, dedicated runs and claimed resources.')),
      h('div.tk-head-actions',
        h('div.segmented.tk-mode', { role: 'group', 'aria-label': 'View as' }, modeButtons),
        h('button.btn.primary', { type: 'button', onclick: () => openNewTask() }, icon('plus'), 'New task'))),
    h('div.tk-toolbar',
      h('div.tk-search', icon('search'), searchInput),
      projectSelect, agentSelect, typeSelect,
      clearButton,
      h('span.tk-spacer'),
      countLabel),
    h('div.tk-stage', board, tableWrap, stageEmpty));
  root.append(page, scrim, drawer);
  root.classList.add('tk-root');

  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode; saveMode(mode); closeMenu(false);
    renderNow();
  }
  function sortBy(key) {
    state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === 'updated' ? -1 : 1 };
    renderNow();
  }

  /* ---------- filter option lists (rebuilt only when their contents change) ---------- */
  function setOptions(select, options, value) {
    const sig = JSON.stringify(options);
    if (select.dataset.sig !== sig) {
      select.dataset.sig = sig;
      clear(select, options.map(([v, label, group]) => (group ? h('optgroup', { label }) : h('option', { value: v }, label))));
    }
    select.value = options.some(([v]) => v === value) ? value : '';
  }
  function syncFilterOptions(base) {
    const projects = store.visibleProjects('board');
    const current = projects.find(p => projectMatches(p, state.project));
    if (current) state.project = current.id;
    else if (state.project && state.project !== NONE && store.projects.length) state.project = '';
    setOptions(projectSelect, [['', 'All projects'], [NONE, 'No project'], ...projects.map(p => [p.id, p.name])], state.project);
    const ids = new Set([...base.map(t => t.agentId), ...store.agents.filter(a => a.kind === 'mailbox').map(a => a.id)]);
    if (state.agent) ids.add(state.agent);
    const agents = [...ids].filter(Boolean).map(id => [id, agentInfo(id).name]).sort((a, b) => a[1].localeCompare(b[1]));
    setOptions(agentSelect, [['', 'All agents'], ...agents], state.agent);
    typeSelect.value = state.type;
  }

  /* ---------- cards ---------- */
  function card(task) {
    const agent = agentInfo(task.agentId);
    const project = proj(task.projectId);
    const movable = MOVABLE.has(task.type);
    const replies = task.replies?.length || 0;
    const menuButton = h('button.icon-btn.tk-card-menu', { type: 'button', 'aria-label': `Actions for ${task.title}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: movable ? 'Move to… and more' : 'More', dataset: { fid: 'menu' },
      onclick: event => { event.stopPropagation(); toggleMenu(task, event.currentTarget); } }, icon('tk-more'));
    const node = h(`article.tk-card.tk-t-${task.type}${statusOf(task) === 'needs-you' ? '.needs-you' : ''}${movable ? '.movable' : '.locked'}`, {
      tabindex: 0, role: 'listitem', draggable: movable,
      title: movable ? null : LOCKED_TIP,
      'aria-label': `${TYPE[task.type]?.label || 'Item'}: ${task.title}. ${agent.name}. ${movable ? 'Press M to move.' : `${LOCKED_TIP}.`}`,
      dataset: { updated: String(task.updatedAt || 0), fid: 'card' },
      onclick: event => { if (!event.target.closest('.tk-card-menu')) openDrawer(task.id, node); },
      onkeydown: event => {
        if (event.target !== node) return;
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDrawer(task.id, node); }
        else if (event.key === 'm' || event.key === 'M' || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openMenu(task, menuButton); }
      },
      oncontextmenu: event => { event.preventDefault(); openMenu(task, menuButton); },
      ondragstart: event => onDragStart(event, task, node),
      ondragend: onDragEnd,
    },
      h('div.tk-card-top',
        typePill(task.type),
        task.type === 'request' && task.state ? h(`span.tk-card-state${task.state === 'failed' || task.state === 'needs-owner' ? '.bad' : ''}`, REQUEST_STATE[task.state] || task.state) : null,
        task.type === 'claim' && task.expiresAt ? h('span.tk-card-state', icon('clock'), leftEl(task.expiresAt)) : null,
        h('span.tk-spacer'),
        menuButton),
      h('h4.tk-card-title', task.title || '(untitled)'),
      project ? projectChip(project) : null,
      h('div.tk-card-foot',
        face(agent, 22),
        h('span.tk-card-agent', agent.name),
        h('span.tk-spacer'),
        replies ? h('span.tk-card-replies', { title: `${replies} repl${replies === 1 ? 'y' : 'ies'}` }, icon('reply'), String(replies)) : null,
        timeEl(task.updatedAt)));
    return node;
  }

  function row(task) {
    const agent = agentInfo(task.agentId);
    const project = proj(task.projectId);
    const replies = task.replies?.length || 0;
    const node = h(`tr.tk-row${statusOf(task) === 'needs-you' ? '.needs-you' : ''}`, { tabindex: 0, dataset: { fid: 'row' }, 'aria-label': `${task.title}, ${COLUMN[statusOf(task)].label}`,
      onclick: () => openDrawer(task.id, node),
      onkeydown: event => { if (event.target === node && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openDrawer(task.id, node); } } },
      h('td.tk-td-title', h('div.tk-cell-title', h('span.tk-row-title', { title: task.title }, task.title || '(untitled)'), replies ? h('span.tk-card-replies', icon('reply'), String(replies)) : null)),
      h('td', typePill(task.type)),
      h('td', statusPill(statusOf(task))),
      h('td', h('span.tk-cell-agent', face(agent, 22), h('span', { title: agent.name }, agent.name))),
      h('td', project ? projectChip(project) : h('span.muted', '—')),
      h('td.tk-td-updated', timeEl(task.updatedAt)));
    return node;
  }

  /* ---------- render ---------- */
  function lookSignature() { return JSON.stringify([store.agents.map(a => [a.id, a.name, a.look]), store.board.endpoints.map(e => [e.id, e.label])]); }
  function cardSig(task, looks) {
    const project = proj(task.projectId);
    return JSON.stringify([task.title, statusOf(task), task.type, task.state, task.expiresAt, project && [project.name, project.color], task.replies?.length || 0, task.updatedAt, task.agentId, looks]);
  }
  const SORT_VALUE = {
    title: t => String(t.title || '').toLowerCase(),
    type: t => TYPE[t.type]?.label || t.type,
    status: t => COLUMN[statusOf(t)].index,
    agent: t => agentInfo(t.agentId).name.toLowerCase(),
    project: t => (proj(t.projectId)?.name || '￿').toLowerCase(),
    updated: t => t.updatedAt || 0,
  };

  function renderBoard(tasks, looks) {
    for (const col of COLUMNS) {
      const el = columnEls.get(col.id);
      const all = tasks.filter(t => statusOf(t) === col.id);
      const shown = col.id === 'done' ? all.slice(0, state.doneLimit) : all;
      el.count.textContent = String(all.length);
      stable(el.body, el.list, () => reconcile(el.list, el.cache, shown.map(t => ({ key: t.id, task: t, sig: cardSig(t, looks) })), ({ task }) => card(task)));
      el.empty.hidden = shown.length > 0;
      el.more.hidden = all.length <= shown.length;
      el.more.textContent = `Show ${Math.min(DONE_PAGE, all.length - shown.length)} more`;
    }
  }
  function renderTable(tasks, looks) {
    const { key, dir } = state.sort;
    const value = SORT_VALUE[key];
    const sorted = [...tasks].sort((a, b) => { const x = value(a), y = value(b); return (x < y ? -1 : x > y ? 1 : (b.updatedAt || 0) - (a.updatedAt || 0)) * (x === y ? 1 : dir); });
    // Filter or sort changes return to the first page; data changes clamp to the last page.
    const sig = JSON.stringify([state.project, state.agent, state.type, state.search, state.sort]);
    if (sig !== state.tableSig) { state.tableSig = sig; state.tablePage = 0; }
    const pages = Math.max(1, Math.ceil(sorted.length / TABLE_PAGE));
    state.tablePage = Math.min(pages - 1, Math.max(0, state.tablePage));
    const first = state.tablePage * TABLE_PAGE;
    const shown = sorted.slice(first, first + TABLE_PAGE);
    for (const [col, th] of headerCells) {
      const on = col === key;
      th.setAttribute('aria-sort', on ? (dir > 0 ? 'ascending' : 'descending') : 'none');
      const holder = th.querySelector('.tk-sort-icon');
      const want = on ? (dir > 0 ? 'tk-up' : 'tk-down') : 'tk-sort';
      if (holder.dataset.icon !== want) { holder.dataset.icon = want; holder.replaceChildren(icon(want)); }
    }
    stable(tableWrap, tbody, () => reconcile(tbody, tableCache, shown.map(t => ({ key: t.id, task: t, sig: cardSig(t, looks) })), ({ task }) => row(task)));
    tableMore.hidden = sorted.length === 0;
    pageRange.textContent = `${sorted.length ? first + 1 : 0}–${first + shown.length} of ${sorted.length} · Page ${state.tablePage + 1} of ${pages}`;
    pagePrev.disabled = state.tablePage === 0;
    pageNext.disabled = state.tablePage >= pages - 1;
  }

  function render() {
    frame = 0;
    if (!visible || drag) { dirty = true; return; }
    dirty = false;
    projectMemo.clear();
    root.classList.toggle('tk-reduce-motion', reduceMotion());

    const base = boardTasks();
    syncFilterOptions(base);
    const tasks = applyFilters(base);
    const looks = lookSignature();
    for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
    clearButton.hidden = !filtersActive();
    const needsYou = tasks.filter(t => statusOf(t) === 'needs-you').length;
    countLabel.textContent = base.length ? `${tasks.length}${tasks.length !== base.length ? ` of ${base.length}` : ''} item${tasks.length === 1 ? '' : 's'}${needsYou ? ` · ${needsYou} need${needsYou === 1 ? 's' : ''} you` : ''}` : '';

    const loading = !store.sync.at && !base.length;
    let emptyKey = '';
    if (loading) emptyKey = 'loading';
    else if (!base.length) emptyKey = 'none';
    else if (!tasks.length) emptyKey = 'filtered';
    if (stageEmpty.dataset.key !== emptyKey) {
      stageEmpty.dataset.key = emptyKey;
      stageEmpty.replaceChildren(
        emptyKey === 'loading' ? h('div.tk-loading', h('span.spinner'), 'Loading tasks…')
          : emptyKey === 'none' ? emptyState('tasks', 'No tasks yet', 'Send an agent a task and it lands here. Questions agents ask you, dedicated requests and claimed resources show up here too.', h('button.btn.primary', { type: 'button', onclick: () => openNewTask() }, icon('plus'), 'New task'))
            : emptyKey === 'filtered' ? emptyState('search', 'Nothing matches these filters', 'Try another project, agent or type, or clear the search.', h('button.btn.ghost', { type: 'button', onclick: clearFilters }, 'Clear filters'))
              : '');
    }
    stageEmpty.hidden = !emptyKey;
    board.hidden = Boolean(emptyKey) || state.mode !== 'board';
    tableWrap.hidden = Boolean(emptyKey) || state.mode !== 'table';
    if (!emptyKey) { if (state.mode === 'board') renderBoard(tasks, looks); else renderTable(tasks, looks); }
    if (menu && !menu.anchor.isConnected) closeMenu(false);
    if (state.drawer) renderDrawer(false, looks);
    refreshClock();
    if (pendingFocus) {
      const target = root.querySelector(`.tk-stage [data-key="${CSS.escape(pendingFocus)}"]`);
      pendingFocus = null;
      if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' }); }
    }
  }
  function renderNow() { if (frame) cancelAnimationFrame(frame); clearTimeout(fallback); frame = 0; render(); }
  // rAF batches bursts of store events; the timeout covers windows where frames are paused (minimized/occluded).
  function schedule() {
    if (!visible || drag) { dirty = true; return; }
    if (frame) return;
    frame = requestAnimationFrame(renderNow);
    fallback = setTimeout(() => { if (frame) renderNow(); }, 400);
  }

  /* ---------- moving tasks ---------- */
  function moveTask(id, status) {
    const task = store.tasks.find(t => t.id === id);
    if (!task || !MOVABLE.has(task.type) || statusOf(task) === status) return;
    const previous = overrideOf(id).status;
    store.setTaskOverride(id, { status });
    toast(`Moved “${short(task.title)}” to ${COLUMN[status].label}.`, { kind: 'success', timeout: 5000, action: { label: 'Undo', run: () => store.setTaskOverride(id, { status: previous }) } });
  }

  function onDragStart(event, task, node) {
    if (!MOVABLE.has(task.type)) { event.preventDefault(); return; }
    closeMenu(false);
    drag = { id: task.id, from: statusOf(task), updatedAt: task.updatedAt || 0, height: node.offsetHeight, node };
    event.dataTransfer.effectAllowed = 'move';
    try { event.dataTransfer.setData('text/plain', task.title); } catch { /* some hosts refuse */ }
    board.classList.add('is-dragging');
    requestAnimationFrame(() => node.classList.add('dragging'));
  }
  function onDragEnd() {
    drag?.node.classList.remove('dragging');
    clearDropUI();
    drag = null;
    board.classList.remove('is-dragging');
    if (dirty) schedule();
  }
  function onDragOver(event, status) {
    if (!drag) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (dropColumn === status) return;
    clearDropUI();
    dropColumn = status;
    const el = columnEls.get(status);
    el.section.classList.add('drop-target');
    if (status === drag.from) return;
    // The card lands where the column's ordering (most recently updated first) will put it.
    placeholder.style.height = `${drag.height}px`;
    const before = [...el.list.children].find(n => n !== placeholder && Number(n.dataset.updated) < drag.updatedAt);
    el.list.insertBefore(placeholder, before || null);
    el.empty.hidden = true;
  }
  function onDrop(event, status) {
    event.preventDefault();
    if (!drag) return;
    const { id, from } = drag;
    clearDropUI();
    if (status !== from) { pendingFocus = id; moveTask(id, status); }
  }
  function clearDropUI() {
    placeholder.remove();
    for (const el of columnEls.values()) { el.section.classList.remove('drop-target'); el.empty.hidden = el.list.children.length > 0; }
    dropColumn = null;
  }

  /* ---------- card menu (keyboard alternative to drag & drop) ---------- */
  function toggleMenu(task, anchor) { if (menu?.anchor === anchor) closeMenu(true); else openMenu(task, anchor); }
  function openMenu(task, anchor) {
    closeMenu(false);
    const item = (lead, label, run) => h('button.tk-menu-item', { type: 'button', role: 'menuitem', tabindex: -1, onclick: () => { closeMenu(false); run(); } }, lead, h('span', label));
    const items = [];
    if (MOVABLE.has(task.type)) {
      items.push(h('div.tk-menu-label', 'Move to…'));
      for (const col of COLUMNS) if (col.id !== statusOf(task)) items.push(item(h(`span.tk-dot.tk-s-${col.id}`), col.label, () => { pendingFocus = task.id; moveTask(task.id, col.id); }));
    } else items.push(h('div.tk-menu-note', icon('tk-lock'), h('span', `${LOCKED_TIP}, so it can't be moved by hand.`)));
    items.push(h('div.tk-menu-sep', { role: 'separator' }));
    items.push(item(icon('eye'), 'Open details', () => openDrawer(task.id, anchor.closest('[data-key]'))));
    if (canChat(task)) items.push(item(icon('chat'), 'Open chat', () => navigate('chat', { agentId: task.agentId })));
    const node = h('div.tk-menu', { role: 'menu', 'aria-label': `Actions for ${task.title}`, onkeydown: menuKeys }, items);
    root.append(node);
    const rect = anchor.getBoundingClientRect();
    const width = node.offsetWidth, height = node.offsetHeight;
    const top = rect.bottom + 6 + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : rect.bottom + 6;
    node.style.top = `${top}px`;
    node.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    anchor.setAttribute('aria-expanded', 'true');
    menu = { node, anchor };
    node.querySelector('.tk-menu-item')?.focus();
  }
  function closeMenu(restoreFocus) {
    if (!menu) return;
    const { node, anchor } = menu;
    menu = null;
    node.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (restoreFocus && anchor.isConnected) anchor.focus();
  }
  function menuKeys(event) {
    const items = [...menu.node.querySelectorAll('.tk-menu-item')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); items.at(-1)?.focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
    else if (event.key === 'Tab') closeMenu(false);
  }

  /* ---------- detail drawer ---------- */
  function openDrawer(id, origin) {
    closeMenu(false);
    drawerReturn = origin?.dataset?.key || document.activeElement?.closest?.('[data-key]')?.dataset.key || null;
    state.drawer = id;
    drawer.inert = false;
    drawer.classList.add('open');
    scrim.classList.add('open');
    renderDrawer(true);
    requestAnimationFrame(() => drawer.querySelector('.tk-drawer-close')?.focus({ preventScroll: true }));
  }
  function closeDrawer() {
    if (!state.drawer) return;
    state.drawer = null;
    drawer.classList.remove('open');
    scrim.classList.remove('open');
    drawer.inert = true;
    const target = drawerReturn && root.querySelector(`.tk-stage [data-key="${CSS.escape(drawerReturn)}"]`);
    target?.focus({ preventScroll: true });
    drawerReturn = null;
  }
  function fact(label, ...value) { return [h('dt', label), h('dd', value)]; }
  function section(title, ...content) { return h('section.tk-section', h('h3', title), content); }
  function setStatus(task, status) { store.setTaskOverride(task.id, { status }); toast(status === 'done' ? 'Marked done.' : 'Reopened.', { kind: 'success', timeout: 2600 }); }

  function renderDrawer(force, looks = lookSignature()) {
    const task = state.drawer ? store.tasks.find(t => t.id === state.drawer) : null;
    const override = task ? overrideOf(task.id) : {};
    const project = task ? proj(task.projectId) : null;
    const sig = JSON.stringify([state.drawer, task && [task.title, task.detail, statusOf(task), task.state, task.updatedAt, task.projectId, task.expiresAt, task.source?.blocker, task.source?.answer, (task.replies || []).map(r => `${r.id}:${r.read_at ? 1 : 0}`)], override, project && [project.name, project.color], looks, store.visibleProjects('board').map(p => p.id)]);
    if (!force && drawer.dataset.sig === sig) return;
    drawer.dataset.sig = sig;
    const scroller = drawerHost.querySelector('.tk-drawer-scroll');
    const keep = !force && scroller ? scroller.scrollTop : 0;
    const hadFocus = drawer.contains(document.activeElement) ? document.activeElement.dataset.fid : null;
    clear(drawerHost, drawerContent(task, override, project));
    const next = drawerHost.querySelector('.tk-drawer-scroll');
    if (next) next.scrollTop = keep;
    if (hadFocus) drawerHost.querySelector(`[data-fid="${CSS.escape(hadFocus)}"]`)?.focus({ preventScroll: true });
  }

  function drawerContent(task, override, project) {
    const close = iconButton('close', 'Close details (Esc)', () => closeDrawer(), 'tk-drawer-close');
    close.dataset.fid = 'close';
    if (!task) {
      return [h('header.tk-drawer-head', h('span.tk-drawer-kicker', 'Details'), h('span.tk-spacer'), close),
        h('div.tk-drawer-scroll', emptyState('alert', 'This item is no longer on the board', 'It may have expired, been cancelled or been removed.'))];
    }
    const agent = agentInfo(task.agentId);
    const status = statusOf(task);
    const movable = MOVABLE.has(task.type);
    const isMail = task.id.startsWith('mail:');
    const source = task.source || {};
    const button = (label, iconName, run, kind = 'ghost', fid = label) => h(`button.btn.small.${kind}`, { type: 'button', dataset: { fid }, onclick: run }, icon(iconName), label);

    let projectControl;
    if (isMail) {
      const projects = store.visibleProjects('board');
      const select = h('select.select.tk-drawer-select', { 'aria-label': 'Project', dataset: { fid: 'project' }, onchange: event => store.setTaskOverride(task.id, { projectId: event.currentTarget.value || null }) },
        h('option', { value: '' }, override.projectId ? 'Detect from message' : `Detect from message${project ? ` (${project.name})` : ' (none found)'}`),
        projects.map(p => h('option', { value: p.id }, p.name)));
      const chosen = override.projectId ? projects.find(p => projectMatches(p, override.projectId)) : null;
      select.value = chosen ? chosen.id : '';
      projectControl = h('div.tk-project-control', project ? h('span.tk-project-dot', { style: { '--dot': project.color } }) : null, select);
    } else projectControl = project ? projectChip(project) : h('span.muted', 'No project');

    const statusControl = movable
      ? h('select.select.tk-drawer-select.tk-status-select', { 'aria-label': 'Status', dataset: { fid: 'status' }, onchange: event => moveTask(task.id, event.currentTarget.value) },
        COLUMNS.map(c => h('option', { value: c.id, selected: c.id === status }, c.label)))
      : null;

    const detail = cleanDetail(task);
    const replies = task.replies || [];
    return [
      h('header.tk-drawer-head',
        typePill(task.type), statusPill(status),
        override.status ? h('span.tk-override', { title: 'You set this status by hand.' }, 'Set by you') : null,
        h('span.tk-spacer'), close),
      h('div.tk-drawer-scroll',
        h('h2.tk-drawer-title', task.title || '(untitled)'),
        h('div.tk-drawer-actions',
          canChat(task) ? button('Open chat', 'chat', () => navigate('chat', { agentId: task.agentId }), 'primary', 'chat') : null,
          movable ? (status === 'done' ? button('Reopen', 'refresh', () => setStatus(task, 'in-progress'), 'ghost', 'done') : button('Mark done', 'check', () => setStatus(task, 'done'), 'ghost', 'done')) : null,
          task.type === 'request' ? h('a.btn.small.ghost', { href: 'classic.html', dataset: { fid: 'classic' } }, icon('external'), 'Open in Classic tools') : null),
        h('dl.tk-facts',
          fact('Agent', h('span.tk-fact-agent', face(agent, 24, true), h('span', agent.name), agent.status ? h('span.muted', `· ${STATUS_LABEL[agent.status]}`) : null)),
          isMail && task.from ? fact('From', `${task.from} → ${task.to || agent.name}`) : task.from ? fact('From', task.from) : null,
          fact('Status', statusControl || h('span.tk-locked', { title: LOCKED_TIP }, icon('tk-lock'), `${COLUMN[status].label} · ${LOCKED_TIP.toLowerCase()}`)),
          override.status ? fact('', h('button.tk-link', { type: 'button', dataset: { fid: 'reset' }, onclick: () => store.setTaskOverride(task.id, { status: undefined }) }, 'Reset to automatic status')) : null,
          fact('Project', projectControl),
          task.type === 'request' ? fact('Run state', h(`span.tk-run-state${task.state === 'failed' || task.state === 'needs-owner' ? '.bad' : ''}`, REQUEST_STATE[task.state] || task.state || '—')) : null,
          task.type === 'claim' && task.expiresAt ? fact('Expires', leftEl(task.expiresAt), h('span.muted', ` · ${fullTime(task.expiresAt)}`)) : null,
          fact('Created', h('span', { title: fullTime(task.createdAt) }, timeEl(task.createdAt), h('span.muted', ` · ${fullTime(task.createdAt)}`))),
          fact('Updated', timeEl(task.updatedAt))),
        status === 'waiting' ? h('div.tk-callout.info', icon('clock'), h('p', 'The agent has not opened this yet. It sees it at its next inbox check (schedules vary and sending does not wake it), so this is normal for a while.')) : null,
        task.type === 'request' && source.blocker ? h('div.tk-callout', icon('alert'), h('div', h('strong', 'Blocked'), h('p', typeof source.blocker === 'string' ? source.blocker : JSON.stringify(source.blocker)))) : null,
        task.type === 'request' && source.prompt ? section('Prompt', renderMarkdown(source.prompt, { compact: true })) : null,
        section(task.type === 'request' ? 'Expected result' : task.type === 'claim' ? 'Purpose' : 'Details', detail ? renderMarkdown(detail) : h('p.muted', 'No details.')),
        task.type === 'request' && source.answer ? section('Answer', renderMarkdown(source.answer)) : null,
        isMail ? section(`Replies${replies.length ? ` · ${replies.length}` : ''}`,
          replies.length ? h('div.tk-replies', replies.map(reply => {
            const who = person(reply.from);
            return h('article.tk-reply',
              face(who, 28),
              h('div.tk-reply-main',
                h('div.tk-reply-head', h('strong', who.name), timeEl(reply.created_at)),
                reply.subject && !/^re:/i.test(reply.subject) ? h('div.tk-reply-subject', reply.subject) : null,
                renderMarkdown(reply.body || '', { compact: true })));
          })) : h('p.muted', 'No replies yet.'),
          h('p.tk-drawer-note', icon('alert'), 'Replies are information, not permission. Only you authorize actions.')) : null,
        !movable ? h('p.tk-drawer-note', icon('tk-lock'), `${LOCKED_TIP}, so it can't be moved by hand.`) : null),
    ];
  }

  /* ---------- New task ---------- */
  function openNewTask() {
    const agents = store.agents.filter(a => a.kind === 'mailbox');
    if (!agents.length) { toast('No mailbox agents yet. Register an existing Claude or Codex chat in Classic tools, then send it tasks here.', { kind: 'error', timeout: 8000 }); return; }
    const groups = [['claude', 'Claude'], ['codex', 'Codex'], ['other', 'Other agents']];
    const groupOf = a => (a.provider === 'claude' || a.provider === 'codex' ? a.provider : 'other');
    const agentSelect = h('select.select#tk-new-agent', groups.map(([provider, label]) => {
      const list = agents.filter(a => groupOf(a) === provider);
      return list.length ? h('optgroup', { label }, list.map(a => h('option', { value: a.id }, `${a.name}  ·  ${STATUS_LABEL[a.status] || a.status}`))) : null;
    }));
    agentSelect.value = (agents.find(a => a.id === state.agent) || agents.find(a => a.status === 'active') || agents[0]).id;
    const agentCard = h('div.tk-agent-card', { 'aria-live': 'polite' });
    const projects = store.visibleProjects('board');
    const projectSelect = h('select.select#tk-new-project', h('option', { value: '' }, 'No project'), projects.map(p => h('option', { value: p.id }, p.name)));
    const preset = state.project && state.project !== NONE ? projects.find(p => projectMatches(p, state.project)) : null;
    if (preset) projectSelect.value = preset.id;
    let projectTouched = Boolean(preset);
    projectSelect.addEventListener('change', () => { projectTouched = true; });
    const syncAgent = () => {
      const agent = agents.find(a => a.id === agentSelect.value);
      if (!agent) return;
      clear(agentCard,
        face(agentInfo(agent.id), 40, true),
        h('div.tk-agent-card-text',
          h('strong', agent.name),
          h('span', `${STATUS_LABEL[agent.status] || agent.status}${agent.lastSeenAt ? ` · last active ${timeAgo(agent.lastSeenAt)}` : ''}`),
          h('span.mono', agent.address)));
      if (!projectTouched) projectSelect.value = projects.some(p => p.id === agent.homeProjectId) ? agent.homeProjectId : '';
    };
    agentSelect.addEventListener('change', syncAgent);
    syncAgent();
    const titleInput = h('input.input#tk-new-title', { type: 'text', maxlength: 200, placeholder: 'e.g. Add a jobs dashboard', autocomplete: 'off' });
    const detailInput = h('textarea.textarea#tk-new-detail', { rows: 6, placeholder: 'What should be done, and what does "done" look like? Markdown works.' });
    const error = h('p.tk-form-error', { role: 'alert', hidden: true });
    const body = h('div.tk-new',
      h('label.field', { for: 'tk-new-agent' }, 'Agent', agentSelect),
      agentCard,
      h('label.field', { for: 'tk-new-project' }, 'Project', projectSelect),
      h('label.field', { for: 'tk-new-title' }, 'Title', titleInput),
      h('label.field', { for: 'tk-new-detail' }, 'Details', detailInput),
      h('p.field-hint.tk-new-hint', icon('clock'), 'Sent as a mailbox message. The agent picks it up at its next inbox check (schedules vary); until then it shows as Waiting on agent. A task is information, not permission. Ctrl+Enter sends.'),
      error);
    const submit = async () => {
      const title = titleInput.value.trim();
      if (!title) { error.textContent = 'Give the task a short title.'; error.hidden = false; titleInput.focus(); return false; }
      const agent = agents.find(a => a.id === agentSelect.value);
      if (!agent) { error.textContent = 'Choose an agent.'; error.hidden = false; return false; }
      const project = projects.find(p => p.id === projectSelect.value) || null;
      try {
        await store.createTask({ agent, project, title, detail: detailInput.value.trim() });
        toast(`Task sent to ${agent.name}. It shows as Waiting until they check in.`, { kind: 'success', timeout: 7000 });
        return true;
      } catch (err) {
        error.textContent = `Could not send the task: ${err.message || 'the board is not reachable.'}`;
        error.hidden = false;
        return false;
      }
    };
    const dialog = ui.modal({ title: 'New task', body, actions: [{ label: 'Cancel' }, { label: 'Send task', kind: 'primary', run: submit }] });
    dialog.classList.add('tk-new-modal');
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); dialog.querySelector('.modal-actions .btn.primary')?.click(); }
    });
    setTimeout(() => titleInput.focus(), 40);
  }

  /* ---------- lifecycle ---------- */
  store.on('change', schedule);
  document.addEventListener('keydown', event => {
    if (!visible || event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (menu) { event.preventDefault(); closeMenu(true); return; }
    if (state.drawer) { event.preventDefault(); closeDrawer(); }
  });
  document.addEventListener('pointerdown', event => {
    if (menu && !menu.node.contains(event.target) && !menu.anchor.contains(event.target)) closeMenu(false);
  }, true);
  window.addEventListener('resize', () => closeMenu(false));

  return {
    show(params = {}) {
      visible = true;
      if (params.project !== undefined) state.project = params.project || '';
      if (params.agent !== undefined) state.agent = params.agent || '';
      if (params.type !== undefined) state.type = TYPE[params.type] ? params.type : '';
      if (params.project !== undefined || params.agent !== undefined || params.type !== undefined) { state.search = ''; searchInput.value = ''; }
      renderNow();
      if (params.task) openDrawer(params.task, null);
    },
    hide() {
      visible = false;
      closeMenu(false);
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
    },
  };
}
