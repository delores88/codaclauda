/* Message board: the one passive shared mailbox every agent reads.
 * Three lenses on the same mailbox: messages addressed to the owner ("For you"),
 * every thread on the board ("Everything"), and shared-resource claims.
 * Threads are organized into project lanes. A thread's project is auto-detected
 * (store.threadProject: [Project] tags, mentions, agent home project) unless the
 * owner filed it; owner filing and pins live in store.threadPrefs (local only).
 * Mailbox text is untrusted: bodies render only through markdown.js.
 * Re-renders are keyed and in place, so scroll, focus, expanded threads and the
 * search box survive store 'change' events. */
import { renderMarkdown, plainText } from '../markdown.js';
import { agentAvatar } from '../avatar/spec.js';
import { providerOf } from '../store.js';

const OWNER = 'owner';
const KINDS = [
  { id: 'question', label: 'Question' },
  { id: 'notice', label: 'Notice' },
  { id: 'reply', label: 'Reply' },
  { id: 'claim', label: 'Claim' },
  { id: 'release', label: 'Release' },
];
const KIND_LABEL = Object.fromEntries(KINDS.map(k => [k.id, k.label]));
const TABS = [
  { id: 'for-you', label: 'For you', icon: 'bell' },
  { id: 'everything', label: 'Everything', icon: 'board' },
  { id: 'claims', label: 'Claims', icon: 'bd-lock' },
];
const PAGE = 50;       // flat lists
const LANE_PAGE = 8;   // cards per project lane before "Show more"
const HEARTBEAT = 'Messages wait until each agent checks its inbox. Schedules vary and posting does not wake an agent, so replies are not instant.';
const LANE_HINT = {
  unfiled: 'No [Project] tag, project mention or home-project agent was found. Use ⋯ → Move to project to file a thread.',
  hidden: 'Threads for projects hidden from the board. They are kept here, not lost.',
};
const ICONS = {
  'bd-lock': '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  'bd-unlock': '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.6-1.8"/>',
  'bd-chevron': '<path d="m6 9 6 6 6-6"/>',
  'bd-inbox': '<path d="M3 13h5l1.5 3h5l1.5-3h5"/><path d="M5.5 5h13l2.5 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6Z"/>',
  'bd-pin': '<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3Z"/><path d="M12 14v7"/>',
  'bd-more': '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
};

const stripRe = text => String(text || '').replace(/^\s*((re|fwd?)\s*:\s*)+/i, '').trim();
const byAkey = (container, key) => container.querySelector(`[data-akey="${CSS.escape(key)}"]`);
/** Lane key for a project: 'p:<id>' when shown on the board, 'hidden' when hidden there, 'unfiled' when none. */
const laneKeyOf = project => (!project ? 'unfiled' : project.visible?.board === false ? 'hidden' : `p:${project.id}`);
const laneRank = key => (key === 'hidden' ? 2 : key === 'unfiled' ? 1 : 0);

/** Keyed list update: keeps nodes whose signature is unchanged, rebuilds the rest in place, then orders them.
 *  prefix (optional) stamps data-akey = prefix + key, which scroll anchoring and focus restore look up. */
function reconcile(container, cache, items, build, prefix = null) {
  const next = new Map();
  let cursor = container.firstChild;
  for (const item of items) {
    let entry = cache.get(item.key);
    if (!entry || entry.sig !== item.sig) {
      const node = build(item);
      node.dataset.key = item.key;
      if (prefix !== null) node.dataset.akey = prefix + item.key;
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

/** Runs fn() while keeping the first visible card at the same screen position and focus on the same control. */
function stable(scroller, container, fn) {
  const active = document.activeElement;
  const holder = active && container.contains(active) ? active.closest('[data-akey]') : null;
  const focusKey = holder?.dataset.akey, focusId = active?.dataset?.fid;
  let anchorKey = null, anchorTop = 0;
  if (scroller.scrollTop > 0 && !container.hidden) {
    const top = scroller.getBoundingClientRect().top;
    for (const node of container.querySelectorAll('[data-akey]')) {
      const rect = node.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > top) { anchorKey = node.dataset.akey; anchorTop = rect.top; break; }
    }
  }
  fn();
  if (anchorKey) {
    const node = byAkey(container, anchorKey);
    if (node) { const delta = node.getBoundingClientRect().top - anchorTop; if (Math.abs(delta) > 0.5) scroller.scrollTop += delta; }
  }
  if (focusKey && !active.isConnected) {
    const node = byAkey(container, focusKey);
    const pick = selector => (node?.matches(selector) ? node : node?.querySelector(selector));
    const target = (focusId && pick(`[data-fid="${CSS.escape(focusId)}"]`)) || pick('[data-fid]');
    target?.focus({ preventScroll: true });
  }
}

export function mount(root, ctx) {
  const { store, ui, navigate } = ctx;
  const { h, icon, portrait, toast, timeAgo, fullTime, emptyState, clear, toMs, STATUS_LABEL } = ui;
  ui.registerIcons(ICONS);

  const state = {
    tab: 'for-you',
    agent: null,
    project: null,         // lane key filter: 'p:<id>' | 'unfiled' | 'hidden' | null (all)
    kinds: new Set(KINDS.map(k => k.id)),
    search: '',
    expanded: new Set(),   // thread ids open in Everything
    openMine: new Set(),   // message ids whose thread is open in For you
    group: { 'for-you': true, everything: true },
    collapsed: new Map(),  // `${tab}:${laneKey}` → collapsed (in memory)
    limits: new Map(),     // `${tab}:${laneKey}` → cards shown
    reveal: null,          // { tab, id, focus } card to bring into view on the next render
  };
  let visible = false, frame = 0, fallback = 0, searchTimer = 0;
  const caches = { claims: new Map(), history: new Map(), agents: new Map(), projects: new Map() };
  const avatarCache = new Map();
  const projectMemo = new Map();   // thread id → { key, id } so project matching runs only when a thread changes
  let projectMemoSig = '';
  const resetPaging = () => state.limits.clear();

  /* ---------- people ---------- */
  function person(address) {
    if (address === OWNER) return { address, name: 'You', look: store.avatar || { name: 'You' }, provider: undefined, status: undefined };
    const agent = store.agent(address);
    const name = agent?.name || store.addressLabel(address);
    const provider = agent?.provider || providerOf(address);
    let look = agent?.look;
    if (!look) { const key = `${address}|${provider}|${name}`; if (!avatarCache.has(key)) avatarCache.set(key, agentAvatar(address, provider, name)); look = avatarCache.get(key); }
    return { address, name, look, provider, status: agent?.status };
  }
  const face = (who, size, withStatus = false) => portrait(who.look, { size, provider: who.provider, status: withStatus ? who.status : undefined, title: who.name });
  const isAgentAddress = address => address && address !== OWNER && store.addresses.some(a => a.name === address);
  const kindPill = kind => h(`span.bd-kind.bd-k-${KIND_LABEL[kind] ? kind : 'notice'}`, KIND_LABEL[kind] || kind || 'Message');
  function timeEl(value) {
    const ms = toMs(value);
    if (!Number.isFinite(ms)) return h('span.bd-time');
    return h('time.bd-time', { dateTime: new Date(ms).toISOString(), title: fullTime(ms), dataset: { ts: String(ms) } }, timeAgo(ms));
  }
  function leftText(expires) {
    const min = Math.round((expires - Date.now()) / 60000);
    if (min <= 0) return 'Expiring now';
    return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m left` : `${min} min left`;
  }
  function paintClaim(node) {
    const created = Number(node.dataset.created), expires = Number(node.dataset.expires);
    const total = Math.max(60e3, expires - created);
    const pct = Math.max(0, Math.min(1, (expires - Date.now()) / total));
    node.style.setProperty('--left', pct.toFixed(4));
    node.classList.toggle('low', pct < 0.2);
    const label = node.querySelector('.bd-claim-left');
    if (label) label.textContent = leftText(expires);
  }
  function refreshClock() {
    for (const node of root.querySelectorAll('[data-ts]')) { const text = timeAgo(Number(node.dataset.ts)); if (node.textContent !== text) node.textContent = text; }
    for (const node of root.querySelectorAll('.bd-claim[data-expires]')) paintClaim(node);
  }

  /* ---------- projects ---------- */
  const projectDot = project => (project ? h('span.bd-pdot', { style: { '--pc': project.color || 'var(--muted)' } }) : h('span.bd-pdot.none'));
  function laneLabel(key) {
    if (key === 'unfiled') return 'Unfiled';
    if (key === 'hidden') return 'Hidden projects';
    return store.project(key.slice(2))?.name || 'Project';
  }
  function laneMeta(key, project) {
    if (key === 'unfiled' || key === 'hidden') return { key, kind: key, label: laneLabel(key), project: null, hint: LANE_HINT[key] };
    return { key, kind: 'project', label: project?.name || laneLabel(key), project };
  }
  const projectPass = t => !state.project || t.lane === state.project;
  function projectsSignature() {
    return JSON.stringify([store.projects.map(p => [p.id, p.ids, p.aliases, p.visible.board]), store.agents.map(a => [a.address, a.homeProjectId])]);
  }
  /** Stamps each thread with project, lane, filed and pinned. Matching is memoized per thread. */
  function resolveProjects(threads) {
    const sig = projectsSignature();
    if (sig !== projectMemoSig) { projectMemo.clear(); projectMemoSig = sig; }
    const byId = new Map(store.projects.map(p => [p.id, p]));
    const prefs = store.threadPrefs;
    for (const t of threads.values()) {
      const pref = prefs[t.id] || {};
      const key = `${t.sig}|${pref.projectId || ''}`;
      let memo = projectMemo.get(t.id);
      if (!memo || memo.key !== key) { memo = { key, id: store.threadProject(t.id, t.messages)?.id || null }; projectMemo.set(t.id, memo); }
      t.project = (memo.id && byId.get(memo.id)) || null;
      t.filed = Boolean(pref.projectId);
      t.pinned = Boolean(pref.pinned);
      t.lane = laneKeyOf(t.project);
    }
  }
  /** Groups entries by their thread's lane: [{ key, kind, label, project, entries, latest }]. */
  function groupLanes(entries, threadFor, timeOf) {
    const lanes = new Map();
    for (const entry of entries) {
      const t = threadFor(entry);
      let lane = lanes.get(t.lane);
      if (!lane) lanes.set(t.lane, lane = { ...laneMeta(t.lane, t.project), entries: [], latest: 0 });
      lane.entries.push(entry);
      lane.latest = Math.max(lane.latest, timeOf(entry));
    }
    return [...lanes.values()];
  }
  function togglePin(rootId) {
    const pinned = Boolean(store.threadPrefs[rootId]?.pinned);
    store.setThreadPrefs(rootId, { pinned: !pinned });
  }

  /* ---------- data ---------- */
  function buildThreads(messages) {
    const byId = new Map(messages.map(m => [m.id, m]));
    const chrono = (a, b) => ((toMs(a.created_at) || 0) - (toMs(b.created_at) || 0)) || ((a.sequence || 0) - (b.sequence || 0));
    const rootOf = m => {
      let current = m;
      for (let hops = 0; current.reply_to && hops < 64; hops++) {
        const parent = byId.get(current.reply_to);
        if (!parent) return current.reply_to;
        current = parent;
      }
      return current.id;
    };
    const threads = new Map();
    for (const m of messages) {
      const id = rootOf(m);
      if (!threads.has(id)) threads.set(id, { id, messages: [] });
      threads.get(id).messages.push(m);
    }
    for (const t of threads.values()) {
      t.messages.sort(chrono);
      t.first = t.messages[0];
      t.last = t.messages.at(-1);
      t.subject = (byId.get(t.id) || t.first).subject || '(no subject)';
      t.participants = [...new Set(t.messages.flatMap(m => [m.from, m.to]))];
      t.unreadMine = t.messages.filter(m => m.to === OWNER && !m.read_at).map(m => m.id);
      t.awaiting = t.last.kind === 'question' ? t.last.to : null;
      t.sig = t.messages.map(m => `${m.id}:${m.read_at ? 1 : 0}`).join(',');
    }
    return threads;
  }
  function textMatch(m, query) {
    if (!query) return true;
    return `${m.subject}\n${m.body}\n${m.from} ${m.to} ${store.addressLabel(m.from)} ${store.addressLabel(m.to)} ${person(m.from).name} ${person(m.to).name}`.toLowerCase().includes(query);
  }
  const projectNameMatch = (t, query) => Boolean(query && t.project && t.project.name.toLowerCase().includes(query));
  const filtersActive = () => Boolean(state.agent || state.project || state.search || state.kinds.size < KINDS.length);
  function clearFilters() {
    state.agent = null; state.project = null; state.search = ''; searchInput.value = '';
    state.kinds = new Set(KINDS.map(k => k.id));
    for (const input of kindInputs.values()) input.checked = true;
    resetPaging();
    renderNow();
  }

  /* ---------- small popup menu (lives in <body>) ---------- */
  let menu = null;
  function closeMenu(refocus = false) {
    if (!menu) return;
    const { node, anchor } = menu;
    menu = null;
    node.remove();
    document.removeEventListener('pointerdown', onMenuPointer, true);
    document.removeEventListener('keydown', onMenuKey, true);
    window.removeEventListener('resize', onMenuClose);
    window.removeEventListener('blur', onMenuClose);
    if (anchor.isConnected) { anchor.setAttribute('aria-expanded', 'false'); if (refocus) anchor.focus(); }
  }
  const onMenuClose = () => closeMenu();
  const onMenuPointer = event => { if (menu && !menu.node.contains(event.target) && !menu.anchor.contains(event.target)) closeMenu(); };
  function onMenuKey(event) {
    if (!menu) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
    if (event.key === 'Tab') { closeMenu(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = [...menu.node.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    const down = event.key === 'ArrowDown';
    const next = index < 0 ? (down ? 0 : buttons.length - 1) : (index + (down ? 1 : buttons.length - 1)) % buttons.length;
    buttons[next]?.focus();
  }
  function showMenu(anchor, items) {
    if (menu?.anchor === anchor) { closeMenu(true); return; }
    closeMenu();
    const node = h('div.bd-menu', { role: 'menu' }, items.map(item => h('button.bd-menu-item', { type: 'button', role: 'menuitem', onclick: event => {
      event.stopPropagation();
      closeMenu(true); // refocus the ⋯ button so stable() can carry focus onto the rebuilt card
      const failed = error => toast(error?.message || 'That did not work.', { kind: 'error' });
      try { const result = item.run(); if (result && typeof result.catch === 'function') result.catch(failed); } catch (error) { failed(error); }
    } }, icon(item.icon), h('span', item.label))));
    document.body.append(node);
    const rect = anchor.getBoundingClientRect();
    const width = node.offsetWidth, height = node.offsetHeight;
    node.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width)))}px`;
    node.style.top = `${Math.round(rect.bottom + 4 + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : rect.bottom + 4)}px`;
    menu = { node, anchor };
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onMenuPointer, true);
    document.addEventListener('keydown', onMenuKey, true);
    window.addEventListener('resize', onMenuClose);
    window.addEventListener('blur', onMenuClose);
    node.querySelector('button')?.focus();
  }

  /* ---------- static skeleton (built once so inputs keep focus) ---------- */
  const tabButtons = new Map();
  const tabCounts = new Map();
  const tabBar = h('div.segmented.bd-tabs', { role: 'tablist', 'aria-label': 'Message board sections' },
    TABS.map(tab => {
      const count = h('span.count.bd-tab-count');
      tabCounts.set(tab.id, count);
      const button = h('button', { type: 'button', role: 'tab', 'aria-selected': 'false', 'aria-controls': `bd-pane-${tab.id}`, id: `bd-tab-${tab.id}`, onclick: () => setTab(tab.id), onkeydown: tabKeys }, icon(tab.icon), h('span', tab.label), count);
      tabButtons.set(tab.id, button);
      return button;
    }));
  function tabKeys(event) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = TABS.findIndex(t => t.id === state.tab);
    const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next.id); tabButtons.get(next.id).focus();
  }

  const searchInput = h('input.input.bd-search-input', { type: 'search', placeholder: 'Search subject, text, people or project', 'aria-label': 'Search the board', autocomplete: 'off', spellcheck: false,
    oninput: event => { clearTimeout(searchTimer); const value = event.currentTarget.value; searchTimer = setTimeout(() => { state.search = value.trim().toLowerCase(); resetPaging(); renderNow(); }, 140); },
    onkeydown: event => { if (event.key === 'Escape' && event.currentTarget.value) { event.stopPropagation(); event.currentTarget.value = ''; state.search = ''; renderNow(); } } });
  const projectList = h('div.bd-agent-list.bd-project-list', { role: 'group', 'aria-label': 'Filter by project' });
  const agentList = h('div.bd-agent-list', { role: 'group', 'aria-label': 'Filter by agent' });
  const kindInputs = new Map(), kindCounts = new Map();
  const kindList = h('div.bd-kind-list', KINDS.map(kind => {
    const input = h('input', { type: 'checkbox', checked: true, onchange: event => { if (event.currentTarget.checked) state.kinds.add(kind.id); else state.kinds.delete(kind.id); renderNow(); } });
    const count = h('span.bd-kind-count');
    kindInputs.set(kind.id, input); kindCounts.set(kind.id, count);
    return h('label.bd-kind-row', input, h(`span.bd-kind-dot.bd-k-${kind.id}`), h('span.bd-kind-name', kind.label), count);
  }));
  const filters = h('aside.bd-filters#bd-filters', { 'aria-label': 'Board filters' },
    h('div.bd-search', icon('search'), searchInput),
    h('section.bd-filter-section.bd-project-section', h('h3.bd-filter-title', 'Projects'), projectList),
    h('section.bd-filter-section', h('h3.bd-filter-title', 'Agents'), agentList),
    h('section.bd-filter-section.bd-kind-section', h('h3.bd-filter-title', 'Message types'), kindList),
    h('p.bd-filter-note', icon('alert'), 'A message is information, not permission. Only you authorize actions.'),
  );

  const filterToggle = h('button.btn.ghost.small.bd-filter-toggle', { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'bd-filters', onclick: () => {
    const open = !page.classList.contains('filters-open');
    page.classList.toggle('filters-open', open);
    filterToggle.setAttribute('aria-expanded', String(open));
  } }, icon('filter'), 'Filters');
  const groupToggle = h('button.btn.ghost.small.bd-group-toggle', { type: 'button', 'aria-pressed': 'true', title: 'Group threads under the projects they support', onclick: () => {
    if (!(state.tab in state.group)) return;
    state.group[state.tab] = !state.group[state.tab];
    resetPaging();
    renderNow();
  } }, icon('projects'), 'Group by project');
  const summary = h('span.bd-summary', { 'aria-live': 'polite' });
  const chips = h('div.bd-chips');

  const mineList = h('div.bd-lanes');
  const mineEmpty = h('div.bd-empty-slot');
  const threadList = h('div.bd-lanes');
  const threadEmpty = h('div.bd-empty-slot');
  const claimList = h('div.bd-claim-grid');
  const claimEmpty = h('div.bd-empty-slot');
  const historyList = h('div.bd-history');
  const historyEmpty = h('p.bd-history-empty.muted', 'No claim or release messages yet.');
  const lanes = {
    'for-you': { list: mineList, cache: new Map(), parts: new Map() },
    everything: { list: threadList, cache: new Map(), parts: new Map() },
  };

  const panes = {
    'for-you': h('div.bd-pane#bd-pane-for-you', { role: 'tabpanel', 'aria-labelledby': 'bd-tab-for-you' }, mineList, mineEmpty),
    everything: h('div.bd-pane#bd-pane-everything', { role: 'tabpanel', 'aria-labelledby': 'bd-tab-everything', hidden: true }, threadList, threadEmpty),
    claims: h('div.bd-pane#bd-pane-claims', { role: 'tabpanel', 'aria-labelledby': 'bd-tab-claims', hidden: true },
      h('div.bd-section-head', h('h2.bd-section-title', 'Active claims'), h('p.bd-section-hint', 'A claim reserves a shared resource for 1–120 minutes so two agents never touch it at once. It expires on its own.')),
      claimList, claimEmpty,
      h('div.bd-section-head', h('h2.bd-section-title', 'Recent claim activity')),
      historyList, historyEmpty),
  };

  const page = h('div.bd-page', { dataset: { tab: state.tab } },
    h('header.page-head.bd-head',
      h('div', h('h1', 'Message board'), h('p', 'The shared mailbox every agent reads, organized by the project each thread supports. Agents check in on their own schedule — a message is information, not permission.')),
      h('button.btn.primary', { type: 'button', onclick: () => openPost() }, icon('plus'), 'Post to board')),
    h('div.bd-layout',
      filters,
      h('div.bd-main',
        h('div.bd-bar', tabBar, h('span.bd-spacer'), summary, groupToggle, filterToggle),
        chips,
        panes['for-you'], panes.everything, panes.claims)),
  );
  root.append(page);
  root.classList.add('bd-root');

  function setTab(tab) {
    if (!TABS.some(t => t.id === tab)) return;
    if (state.tab !== tab) { state.tab = tab; root.scrollTop = 0; closeMenu(); }
    renderNow();
  }

  /* ---------- message + thread nodes ---------- */
  function readStatus(m) {
    const to = person(m.to).name;
    if (m.to === OWNER) return m.read_at ? h('span.bd-read', icon('check'), 'Read by you') : h('span.bd-read.unread', h('span.bd-unread-dot'), 'Unread');
    if (m.read_at) return h('span.bd-read', { title: 'Their inbox marked it read. That does not prove they acted on it.' }, icon('check'), `Read by ${to} · `, timeEl(m.read_at));
    return h('span.bd-read.pending', { title: HEARTBEAT }, icon('clock'), m.from === OWNER ? `Waiting for ${to} to check in` : `Not yet read by ${to}`);
  }
  function messageNode(m, threadSubject, focus) {
    const from = person(m.from), to = person(m.to);
    const showSubject = m.subject && stripRe(m.subject) !== stripRe(threadSubject);
    return h(`article.bd-msg${focus ? '.focus' : ''}${m.from === OWNER ? '.mine' : ''}`,
      h('header.bd-msg-head',
        face(from, 30),
        h('div.bd-msg-who', h('strong', from.name), h('span.bd-msg-to', icon('arrowRight'), to.name)),
        kindPill(m.kind),
        m.resource ? h('code.bd-resource', m.resource) : null,
        h('span.bd-spacer'),
        timeEl(m.created_at)),
      showSubject ? h('div.bd-msg-subject', m.subject) : null,
      h('div.bd-msg-body', m.body ? renderMarkdown(m.body, { compact: true }) : h('p.muted', '(empty message)')),
      h('footer.bd-msg-foot', readStatus(m)));
  }
  function threadBody(thread, focusId) {
    return h('div.bd-thread-body', thread.messages.map(m => messageNode(m, thread.subject, m.id === focusId)));
  }
  function actionButton(label, iconName, run, { primary = false, fid, title } = {}) {
    return h(`button.btn.small${primary ? '.primary' : '.ghost'}`, { type: 'button', title, dataset: { fid: fid || label }, onclick: event => {
      event.stopPropagation();
      const button = event.currentTarget;
      const failed = error => toast(error?.message || 'That did not work.', { kind: 'error' });
      let result;
      try { result = run(); } catch (error) { failed(error); return; }
      if (result && typeof result.then === 'function') { button.disabled = true; result.catch(failed).finally(() => { button.disabled = false; }); }
    } }, icon(iconName), label);
  }
  const markRead = async ids => { await store.ackOwner(ids); };

  /** Project chip with an auto/filed hint; clicking it opens the Move to project picker. */
  function projectChip(t) {
    const p = t.project;
    const how = t.filed ? 'filed' : p ? 'auto' : '';
    const where = p ? `${p.name}${p.visible?.board === false ? ' (hidden on the board)' : ''}` : 'no project';
    const title = t.filed ? `You filed this under ${where}. Click to move it.` : p ? `Auto-detected: ${where}. Click to file it elsewhere.` : 'No project detected. Click to file it under one.';
    return h(`button.bd-pchip${p ? '' : '.none'}`, { type: 'button', title, 'aria-label': `Project: ${where}${how ? `, ${how}` : ''}. Move to project`, dataset: { fid: 'project' },
      onclick: event => { event.stopPropagation(); openMove(t.id); } },
    projectDot(p), h('span.bd-pchip-name', p ? p.name : 'Unfiled'), how ? h(`span.bd-pchip-how.${how}`, how) : null);
  }
  function threadMenu(anchor, t) {
    showMenu(anchor, [
      { label: t.pinned ? 'Unpin thread' : 'Pin thread', icon: 'bd-pin', run: () => togglePin(t.id) },
      { label: 'Move to project…', icon: 'projects', run: () => openMove(t.id) },
      t.filed ? { label: 'Use the auto-detected project', icon: 'refresh', run: () => store.setThreadPrefs(t.id, { projectId: null }) } : null,
      t.unreadMine.length ? { label: 'Mark read', icon: 'check', run: () => markRead(t.unreadMine) } : null,
    ].filter(Boolean));
  }

  function mineCard({ message: m, thread, lane }) {
    const akey = `${lane}/${m.id}`;
    const from = person(m.from);
    const open = state.openMine.has(m.id);
    const unread = !m.read_at;
    const count = thread?.messages.length || 1;
    const toggle = () => {
      if (state.openMine.has(m.id)) state.openMine.delete(m.id); else state.openMine.add(m.id);
      renderNow(); revealIn(mineList, akey);
    };
    return h(`article.bd-card.bd-mine${unread ? '.unread' : ''}${open ? '.open' : ''}`,
      h('div.bd-mine-head',
        face(from, 40, true),
        h('div.bd-mine-who',
          h('div.bd-mine-line', h('strong.bd-mine-name', from.name), kindPill(m.kind), thread ? projectChip(thread) : null, unread ? h('span.bd-new', 'New') : null),
          h('div.bd-mine-meta', from.status ? STATUS_LABEL[from.status] : m.from, ' · ', timeEl(m.created_at)))),
      h('h3.bd-mine-subject', m.subject || '(no subject)'),
      open ? threadBody(thread || { messages: [m], subject: m.subject }, count > 1 ? m.id : null) : h('p.bd-mine-preview', plainText(m.body, 320) || 'No message body.'),
      h('div.bd-actions',
        isAgentAddress(m.from) ? actionButton('Reply in chat', 'reply', () => navigate('chat', { thread: `mail:${m.from}` }), { primary: true, fid: 'chat' }) : null,
        unread ? actionButton('Mark read', 'check', () => markRead([m.id]), { fid: 'read' }) : null,
        actionButton(open ? 'Hide thread' : count > 1 ? `Show thread · ${count}` : 'Show full message', open ? 'eyeOff' : 'eye', toggle, { fid: 'toggle' })));
  }

  function threadCard({ thread: t, lane }) {
    const akey = `${lane}/${t.id}`;
    const open = state.expanded.has(t.id);
    const from = person(t.first.from), to = person(t.first.to), last = person(t.last.from);
    const extra = t.participants.length - 2;
    const replies = t.messages.length - 1;
    const toggle = () => {
      if (state.expanded.has(t.id)) state.expanded.delete(t.id); else state.expanded.add(t.id);
      renderNow(); revealIn(threadList, akey);
    };
    const summaryRow = h('div.bd-thread-summary', { role: 'button', tabindex: 0, 'aria-expanded': String(open), dataset: { fid: 'summary' }, title: open ? 'Collapse thread' : 'Expand thread', onclick: toggle,
      onkeydown: event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(); } } },
      h('div.bd-people', { 'aria-hidden': 'true' }, face(from, 30), h('span.bd-people-arrow', icon('arrowRight')), face(to, 30), extra > 0 ? h('span.bd-people-more', `+${extra}`) : null),
      h('div.bd-thread-main',
        h('div.bd-thread-line', kindPill(t.first.kind), h('strong.bd-thread-subject', t.subject)),
        h('p.bd-thread-snippet', h('span.bd-snippet-author', `${last.name}: `), plainText(t.last.body, 220) || t.last.subject || ''),
        h('div.bd-thread-people', projectChip(t), h('span.bd-thread-names', `${from.name} → ${to.name}${extra > 0 ? ` and ${extra} more` : ''}`))),
      h('div.bd-thread-meta',
        timeEl(t.last.created_at),
        h('div.bd-thread-badges',
          t.awaiting === OWNER ? h('span.bd-await.you', icon('alert'), 'Awaiting your reply')
            : t.awaiting ? h('span.bd-await', { title: `Awaiting ${person(t.awaiting).name}. ${HEARTBEAT}` }, icon('clock'), h('span.bd-await-text', `Awaiting ${person(t.awaiting).name}`)) : null,
          replies ? h('span.bd-reply-count', { title: `${replies} repl${replies === 1 ? 'y' : 'ies'}` }, icon('reply'), String(replies)) : null,
          t.unreadMine.length ? h('span.bd-unread-pip', { title: `${t.unreadMine.length} unread for you` }, String(t.unreadMine.length)) : null),
        h('span.bd-chevron', icon('bd-chevron'))));
    const pinLabel = t.pinned ? 'Unpin thread' : 'Pin thread to the top of its project';
    const tools = h('div.bd-thread-tools',
      h(`button.icon-btn.bd-tool.bd-pin-btn${t.pinned ? '.on' : ''}`, { type: 'button', title: pinLabel, 'aria-label': 'Pin thread', 'aria-pressed': String(t.pinned), dataset: { fid: 'pin' },
        onclick: event => { event.stopPropagation(); togglePin(t.id); } }, icon('bd-pin')),
      h('button.icon-btn.bd-tool', { type: 'button', title: 'More actions', 'aria-label': `More actions for ${t.subject}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false', dataset: { fid: 'menu' },
        onclick: event => { event.stopPropagation(); threadMenu(event.currentTarget, t); } }, icon('bd-more')));
    const chatWith = t.participants.includes(OWNER) ? t.participants.find(isAgentAddress) : null;
    const replyTarget = [...t.messages].reverse().map(m => (m.from === OWNER ? m.to : m.from)).find(isAgentAddress);
    return h(`article.bd-card.bd-thread${t.unreadMine.length ? '.unread' : ''}${open ? '.open' : ''}${t.pinned ? '.pinned' : ''}`,
      h('div.bd-thread-top', summaryRow, tools),
      open ? h('div.bd-thread-open',
        threadBody(t, null),
        h('div.bd-actions.bd-thread-actions',
          replyTarget ? actionButton('Reply on board', 'reply', () => openPost({ to: replyTarget, replyTo: t.last.id, subject: `Re: ${stripRe(t.subject)}`, threadId: t.id }), { primary: true, fid: 'reply' }) : null,
          chatWith ? actionButton(`Open chat with ${person(chatWith).name}`, 'chat', () => navigate('chat', { thread: `mail:${chatWith}` }), { fid: 'chat' }) : null,
          t.unreadMine.length ? actionButton('Mark read', 'check', () => markRead(t.unreadMine), { fid: 'read' }) : null,
          h('span.bd-spacer'),
          actionButton('Collapse', 'bd-chevron', toggle, { fid: 'collapse' }))) : null);
  }
  /** Compact chip in the Pinned strip; jumps to (and opens) the thread in its project lane. */
  function pinChip({ thread: t }) {
    return h('button.bd-pin-item', { type: 'button', dataset: { fid: 'pin-item' }, title: `Open “${t.subject}”${t.project ? ` in ${t.project.name}` : ''}`,
      onclick: () => { state.expanded.add(t.id); state.reveal = { tab: 'everything', id: t.id, focus: true }; renderNow(); } },
    projectDot(t.project), h('span.bd-pin-subject', t.subject),
    t.unreadMine.length ? h('span.bd-unread-pip', { title: `${t.unreadMine.length} unread for you` }, String(t.unreadMine.length)) : null);
  }
  function revealIn(container, akey) {
    const node = byAkey(container, akey);
    if (!node) return;
    const box = root.getBoundingClientRect(), rect = node.getBoundingClientRect();
    if (rect.top < box.top || rect.top > box.bottom - 60) node.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
  }

  function claimCard({ claim: c }) {
    const holder = person(c.holder);
    const node = h('article.bd-card.bd-claim', { dataset: { created: String(toMs(c.created_at)), expires: String(toMs(c.expires_at)) } },
      h('div.bd-claim-head', h('span.bd-claim-icon', icon('bd-lock')), h('code.bd-claim-resource', { title: c.resource }, c.resource), h('span.bd-spacer'), h('span.bd-claim-left')),
      h('div.bd-claim-bar', { role: 'presentation' }, h('span.bd-claim-fill')),
      h('p.bd-claim-purpose', c.purpose || 'No purpose given.'),
      h('div.bd-claim-foot', face(holder, 26, true), h('strong', holder.name), h('span.bd-spacer'), h('span.bd-claim-since', 'claimed ', timeEl(c.created_at))));
    paintClaim(node);
    return node;
  }
  function historyRow({ message: m }) {
    const who = person(m.from);
    const claimed = m.kind === 'claim';
    return h('div.bd-history-row',
      h(`span.bd-history-icon${claimed ? '.claim' : '.release'}`, icon(claimed ? 'bd-lock' : 'bd-unlock')),
      face(who, 24),
      h('div.bd-history-text',
        h('div', h('strong', who.name), claimed ? ' claimed ' : ' released ', h('code.bd-resource', m.resource || stripRe(m.subject) || 'a resource')),
        m.subject ? h('div.bd-history-subject', m.subject) : null),
      timeEl(m.created_at));
  }

  function agentRow({ address, count, active }) {
    const who = person(address);
    return h(`button.bd-agent${active ? '.active' : ''}`, { type: 'button', 'aria-pressed': String(active), dataset: { fid: 'agent' }, title: active ? 'Show all agents' : `Show threads involving ${who.name}`,
      onclick: () => { state.agent = active ? null : address; resetPaging(); renderNow(); } },
    address ? face(who, 28, true) : h('span.bd-agent-all', icon('agents')),
    h('span.bd-agent-text', h('span.bd-agent-name', address ? who.name : 'All agents'), address ? h('span.bd-agent-addr', address) : null),
    h('span.bd-agent-count', String(count)));
  }
  function projectRow({ key, project, label, count, unread, active }) {
    const all = key === '*';
    const lead = all ? h('span.bd-agent-all', icon('projects')) : key === 'hidden' ? h('span.bd-agent-all', icon('eyeOff')) : h('span.bd-project-mark', projectDot(project));
    return h(`button.bd-agent.bd-project-row${active ? '.active' : ''}`, { type: 'button', 'aria-pressed': String(active), dataset: { fid: 'project' },
      title: all ? 'Show every project' : active ? 'Show all projects' : (LANE_HINT[key] || `Show only threads for ${label}`),
      onclick: () => { state.project = all || active ? null : key; resetPaging(); renderNow(); } },
    lead,
    h('span.bd-agent-text', h('span.bd-agent-name', label)),
    unread ? h('span.bd-unread-pip', { title: `${unread} unread for you` }, String(unread)) : null,
    h('span.bd-agent-count', { title: state.tab === 'for-you' ? `${count} message${count === 1 ? '' : 's'} to you` : `${count} thread${count === 1 ? '' : 's'}` }, String(count)));
  }

  /* ---------- lanes (project sections) ---------- */
  const laneId = (tab, s) => `${tab}:${s.key}`;
  const laneLimit = (tab, s) => state.limits.get(laneId(tab, s)) ?? s.page;
  function isCollapsed(tab, s) {
    if (s.kind === 'flat') return false;
    const id = laneId(tab, s);
    return state.collapsed.has(id) ? state.collapsed.get(id) : s.kind === 'hidden' && state.project !== 'hidden';
  }
  function makeLane(host, key) {
    const head = h('div.bd-lane-head', { dataset: { akey: `h:${key}` } });
    const body = h('div.bd-lane-body');
    const more = h('button.btn.ghost.small.bd-lane-more', { type: 'button', hidden: true });
    const node = h('section.bd-lane', head, body, more);
    const part = { node, head, body, more, cache: new Map(), headSig: '', section: null, tab: '' };
    more.addEventListener('click', () => {
      const s = part.section;
      if (!s) return;
      state.limits.set(laneId(part.tab, s), laneLimit(part.tab, s) + s.page);
      renderNow();
    });
    host.parts.set(key, part);
    return node;
  }
  function laneHead(part, collapsed) {
    const s = part.section;
    const lead = s.kind === 'project' ? projectDot(s.project)
      : s.kind === 'unfiled' ? projectDot(null)
        : h('span.bd-lane-icon', icon(s.kind === 'hidden' ? 'eyeOff' : s.kind === 'pinned' ? 'bd-pin' : s.key === 'unread' ? 'bell' : 'clock'));
    const unit = part.tab === 'for-you' ? 'message' : 'thread';
    return [
      h('button.bd-lane-toggle', { type: 'button', 'aria-expanded': String(!collapsed), dataset: { fid: 'lane' }, title: s.hint || `${collapsed ? 'Show' : 'Hide'} ${s.label}`,
        onclick: () => { const current = part.section; state.collapsed.set(laneId(part.tab, current), !isCollapsed(part.tab, current)); renderNow(); } },
      h('span.bd-lane-chev', icon('bd-chevron')), lead, h('span.bd-lane-name', s.label),
      h('span.bd-lane-count', { title: `${s.count} ${unit}${s.count === 1 ? '' : 's'}` }, String(s.count))),
      s.kind !== 'group' && s.unread ? h('span.bd-unread-pip', { title: `${s.unread} unread for you` }, String(s.unread)) : null,
      h('span.bd-spacer'),
      part.tab === 'for-you' && s.unreadIds?.length ? actionButton('Mark all read', 'check', () => markRead(part.section.unreadIds || []), { fid: 'all' }) : null,
      s.kind === 'project' ? actionButton('Post', 'plus', () => postIn(part.section.project), { fid: 'post', title: `Post to the board about ${s.label}` }) : null,
    ];
  }
  /** Renders sections [{ key, kind, label, project?, count, unread?, unreadIds?, page, items }] into a tab's lane host.
   *  Returns the data-akey of the card to reveal (state.reveal), if it is on screen now. */
  function renderLanes(tab, sections, build) {
    const host = lanes[tab];
    const reveal = state.reveal?.tab === tab ? state.reveal : null;
    let revealKey = null;
    stable(root, host.list, () => {
      reconcile(host.list, host.cache, sections.map(s => ({ key: s.key, sig: 'lane' })), item => makeLane(host, item.key));
      for (const key of [...host.parts.keys()]) if (!host.cache.has(key)) host.parts.delete(key);
      for (const s of sections) {
        const part = host.parts.get(s.key);
        if (!part) continue;
        part.section = s; part.tab = tab;
        if (reveal && !revealKey && s.kind !== 'pinned') {
          const index = s.items.findIndex(item => item.key === reveal.id);
          if (index >= 0) {
            state.collapsed.set(laneId(tab, s), false);
            if (index >= laneLimit(tab, s)) state.limits.set(laneId(tab, s), index + 1);
            revealKey = `${s.key}/${reveal.id}`;
          }
        }
        const collapsed = isCollapsed(tab, s);
        part.node.className = `bd-lane bd-lane-${s.kind}${collapsed ? ' collapsed' : ''}`;
        part.body.className = s.kind === 'pinned' ? 'bd-lane-body bd-pin-strip' : 'bd-lane-body bd-list';
        part.head.hidden = s.kind === 'flat';
        if (s.kind !== 'flat') {
          const headSig = JSON.stringify([tab, s.kind, s.label, s.count, s.unread || 0, Boolean(s.unreadIds?.length), collapsed, s.project?.color, s.hint]);
          if (part.headSig !== headSig) { part.headSig = headSig; clear(part.head, laneHead(part, collapsed)); }
        }
        part.body.hidden = collapsed;
        if (collapsed) { part.more.hidden = true; continue; }
        const shown = s.items.slice(0, laneLimit(tab, s));
        reconcile(part.body, part.cache, shown, build, `${s.key}/`);
        const left = s.items.length - shown.length;
        part.more.hidden = left <= 0;
        if (left > 0) part.more.textContent = `Show ${Math.min(left, s.page)} more · ${left} left`;
      }
    });
    return revealKey;
  }
  function finishReveal(tab, revealKey, dataReady) {
    if (!state.reveal || state.reveal.tab !== tab) return;
    if (revealKey) {
      const node = byAkey(lanes[tab].list, revealKey);
      if (node) {
        node.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
        if (state.reveal.focus) node.querySelector('[data-fid="summary"]')?.focus({ preventScroll: true });
      }
      state.reveal = null;
    } else if (dataReady) state.reveal = null;
  }

  /* ---------- render ---------- */
  function lookSignature(withStatus) {
    return JSON.stringify([store.agents.map(a => (withStatus ? [a.id, a.name, a.status, a.look] : [a.id, a.name, a.look])), store.avatar, store.addresses.map(a => [a.name, a.label])]);
  }
  function renderChips(resultsLabel) {
    summary.textContent = resultsLabel;
    const items = [];
    const onClaims = state.tab === 'claims';
    if (state.project && !onClaims) {
      const label = laneLabel(state.project);
      const lead = state.project.startsWith('p:') ? projectDot(store.project(state.project.slice(2))) : icon(state.project === 'hidden' ? 'eyeOff' : 'projects');
      items.push(h('button.bd-chip', { type: 'button', title: 'Remove project filter', onclick: () => { state.project = null; resetPaging(); renderNow(); } }, lead, `In ${label}`, icon('close')));
    }
    if (state.agent) items.push(h('button.bd-chip', { type: 'button', title: 'Remove agent filter', onclick: () => { state.agent = null; resetPaging(); renderNow(); } }, face(person(state.agent), 18), `With ${person(state.agent).name}`, icon('close')));
    if (state.search) items.push(h('button.bd-chip', { type: 'button', title: 'Clear search', onclick: () => { state.search = ''; searchInput.value = ''; renderNow(); } }, icon('search'), `“${state.search}”`, icon('close')));
    if (!onClaims && state.kinds.size < KINDS.length) items.push(h('button.bd-chip', { type: 'button', title: 'Show every message type', onclick: () => { state.kinds = new Set(KINDS.map(k => k.id)); for (const input of kindInputs.values()) input.checked = true; renderNow(); } }, icon('filter'), `${state.kinds.size} of ${KINDS.length} types`, icon('close')));
    if (items.length > 1) items.push(h('button.bd-chip-clear', { type: 'button', onclick: clearFilters }, 'Clear all'));
    const sig = JSON.stringify([state.project, state.project && !onClaims && laneLabel(state.project), state.agent, state.agent && person(state.agent).name, state.search, state.kinds.size, onClaims, items.length]);
    if (chips.dataset.sig !== sig) { chips.dataset.sig = sig; clear(chips, items); }
    chips.hidden = !items.length;
  }

  function filteredEmpty(what) {
    return emptyState('search', `No ${what} match these filters`, 'Try another project, agent, message type or search.', h('button.btn.ghost', { type: 'button', onclick: clearFilters }, 'Clear filters'));
  }
  function setEmpty(slot, node, key) {
    if (!node) { if (slot.firstChild) slot.replaceChildren(); slot.dataset.key = ''; return; }
    if (slot.dataset.key !== key) { slot.replaceChildren(node); slot.dataset.key = key; }
  }

  function render() {
    frame = 0;
    if (!visible) return;
    root.classList.toggle('bd-reduce-motion', reduceMotion());
    page.dataset.tab = state.tab;
    for (const [id, button] of tabButtons) { const on = id === state.tab; button.classList.toggle('selected', on); button.setAttribute('aria-selected', String(on)); button.tabIndex = on ? 0 : -1; }
    for (const [id, pane] of Object.entries(panes)) pane.hidden = id !== state.tab;
    const grouped = Boolean(state.group[state.tab]);
    groupToggle.hidden = state.tab === 'claims';
    groupToggle.setAttribute('aria-pressed', String(grouped));

    const all = store.mailboxMessages;
    const threads = buildThreads(all);
    resolveProjects(threads);
    const looks = lookSignature(true), faces = lookSignature(false);
    const query = state.search;
    const loading = !store.sync.at && !all.length;
    const byNewest = (a, b) => ((toMs(b.created_at) || 0) - (toMs(a.created_at) || 0)) || ((b.sequence || 0) - (a.sequence || 0));

    /* sidebar: projects — counts follow the open tab (For you counts messages to you; Everything counts threads) */
    const forYouTab = state.tab === 'for-you';
    const threadOfMsg = new Map();
    for (const t of threads.values()) for (const m of t.messages) threadOfMsg.set(m.id, t);
    const mineAllForCounts = all.filter(m => m.to === OWNER);
    const laneStats = new Map();
    const bump = (lane, project, n, unread, at) => {
      let s = laneStats.get(lane);
      if (!s) laneStats.set(lane, s = { key: lane, project: lane.startsWith('p:') ? project : null, count: 0, unread: 0, latest: 0 });
      s.count += n; s.unread += unread; s.latest = Math.max(s.latest, at);
    };
    if (forYouTab) for (const m of mineAllForCounts) { const t = threadOfMsg.get(m.id); if (t) bump(t.lane, t.project, 1, m.read_at ? 0 : 1, toMs(m.created_at) || 0); }
    else for (const t of threads.values()) bump(t.lane, t.project, 1, t.unreadMine.length, toMs(t.last.created_at) || 0);
    const projectItems = [{ key: '*', label: 'All projects', count: forYouTab ? mineAllForCounts.length : threads.size, unread: 0, active: !state.project }];
    for (const s of [...laneStats.values()].sort((a, b) => laneRank(a.key) - laneRank(b.key) || b.latest - a.latest)) {
      projectItems.push({ key: s.key, project: s.project, label: s.project?.name || laneLabel(s.key), count: s.count, unread: s.unread, active: state.project === s.key });
    }
    if (state.project && !laneStats.has(state.project)) projectItems.push({ key: state.project, project: state.project.startsWith('p:') ? store.project(state.project.slice(2)) : null, label: laneLabel(state.project), count: 0, unread: 0, active: true });
    stable(filters, projectList, () => reconcile(projectList, caches.projects, projectItems.map(item => ({ ...item, sig: JSON.stringify([item.label, item.count, item.unread, item.active, item.project?.color, state.tab]) })), projectRow, ''));

    /* sidebar: agents + kinds */
    const counts = new Map();
    const agentPool = forYouTab ? mineAllForCounts : all;
    for (const m of agentPool) for (const address of new Set([m.from, m.to])) counts.set(address, (counts.get(address) || 0) + 1);
    const agentItems = [{ key: '*', address: null, count: agentPool.length, active: !state.agent }];
    for (const { name } of store.addresses) if (name !== OWNER) agentItems.push({ key: name, address: name, count: counts.get(name) || 0, active: state.agent === name });
    if (state.agent && !agentItems.some(a => a.address === state.agent)) agentItems.push({ key: state.agent, address: state.agent, count: counts.get(state.agent) || 0, active: true });
    stable(filters, agentList, () => reconcile(agentList, caches.agents, agentItems.map(item => ({ ...item, sig: JSON.stringify([item.count, item.active, item.address && looks]) })), agentRow, ''));
    const kindTotals = new Map();
    for (const m of all) kindTotals.set(m.kind, (kindTotals.get(m.kind) || 0) + 1);
    for (const [id, node] of kindCounts) node.textContent = String(kindTotals.get(id) || 0);

    /* counts on tabs */
    const mineAll = all.filter(m => m.to === OWNER);
    const unreadTotal = mineAll.filter(m => !m.read_at).length;
    const now = Date.now();
    const activeAll = store.claims.filter(c => toMs(c.expires_at) > now);
    const setCount = (id, n, hot) => { const node = tabCounts.get(id); node.textContent = n ? String(n) : ''; node.classList.toggle('hot', Boolean(hot)); };
    setCount('for-you', unreadTotal || mineAll.length, unreadTotal > 0);
    setCount('everything', threads.size);
    setCount('claims', activeAll.length, false);
    tabButtons.get('for-you').title = unreadTotal ? `${unreadTotal} unread for you` : 'Messages addressed to you';

    if (state.tab === 'for-you') {
      const threadOf = new Map();
      for (const t of threads.values()) for (const m of t.messages) threadOf.set(m.id, t);
      const mine = mineAll.filter(m => {
        const t = threadOf.get(m.id);
        return (!state.agent || m.from === state.agent) && state.kinds.has(m.kind) && projectPass(t) && (textMatch(m, query) || projectNameMatch(t, query));
      });
      const mineItem = (m, lane) => {
        const t = threadOf.get(m.id);
        const open = state.openMine.has(m.id);
        return { key: m.id, message: m, thread: t, lane, sig: JSON.stringify([m.read_at ? 1 : 0, open, t.messages.length, open ? t.sig : '', t.lane, t.project?.name, t.project?.color, t.filed, looks]) };
      };
      const unreadFirst = (a, b) => ((a.read_at ? 1 : 0) - (b.read_at ? 1 : 0)) || byNewest(a, b);
      const unreadCount = mine.filter(m => !m.read_at).length;
      let sections = [];
      if (grouped) {
        const groups = groupLanes(mine, m => threadOf.get(m.id), m => toMs(m.created_at) || 0);
        for (const g of groups) g.unreadIds = g.entries.filter(m => !m.read_at).map(m => m.id);
        groups.sort((a, b) => ((a.key === 'hidden') - (b.key === 'hidden')) || ((b.unreadIds.length > 0) - (a.unreadIds.length > 0)) || b.latest - a.latest);
        sections = groups.map(g => ({ ...g, count: g.entries.length, unread: g.unreadIds.length, page: LANE_PAGE, items: [...g.entries].sort(unreadFirst).map(m => mineItem(m, g.key)) }));
      } else {
        const unread = mine.filter(m => !m.read_at).sort(byNewest);
        const earlier = mine.filter(m => m.read_at).sort(byNewest);
        if (unread.length) sections.push({ key: 'unread', kind: 'group', label: 'Unread', count: unread.length, unreadIds: unread.map(m => m.id), page: PAGE, items: unread.map(m => mineItem(m, 'unread')) });
        if (earlier.length) sections.push({ key: 'earlier', kind: 'group', label: unread.length ? 'Earlier' : 'All messages for you', count: earlier.length, page: PAGE, items: earlier.map(m => mineItem(m, 'earlier')) });
      }
      const revealKey = renderLanes('for-you', sections, mineCard);
      mineList.hidden = !sections.length;
      // Nothing addressed to you matches, but the same filters match threads on the whole board: offer them.
      const elsewhere = !sections.length && filtersActive() ? [...threads.values()].filter(t =>
        (!state.agent || t.participants.includes(state.agent)) && t.messages.some(m => state.kinds.has(m.kind)) && projectPass(t) &&
        (!query || projectNameMatch(t, query) || t.messages.some(m => textMatch(m, query)))).length : 0;
      setEmpty(mineEmpty, sections.length ? null
        : loading ? h('div.bd-loading', h('span.spinner'), 'Connecting to the board…')
          : elsewhere ? emptyState('bd-inbox', 'Nothing addressed to you here', `${elsewhere} thread${elsewhere === 1 ? '' : 's'} on the board match${elsewhere === 1 ? 'es' : ''} these filters — they're between agents or from you.`, h('button.btn.primary', { type: 'button', onclick: () => setTab('everything') }, `Show ${elsewhere} in Everything`))
          : mineAll.length && filtersActive() ? filteredEmpty('messages')
            : emptyState('bd-inbox', 'Nothing for you right now', `When an agent posts a question or update addressed to you, it lands here. ${HEARTBEAT}`, h('button.btn.ghost', { type: 'button', onclick: () => setTab('everything') }, 'See everything on the board')),
      sections.length ? '' : loading ? 'loading' : elsewhere ? `elsewhere:${elsewhere}` : mineAll.length && filtersActive() ? 'filtered' : 'empty');
      renderChips(mine.length ? `${mine.length} message${mine.length === 1 ? '' : 's'}${unreadCount ? ` · ${unreadCount} unread` : ''}` : '');
      finishReveal('for-you', revealKey, !loading);
    } else if (state.tab === 'everything') {
      const threadArr = [...threads.values()].filter(t =>
        (!state.agent || t.participants.includes(state.agent)) &&
        t.messages.some(m => state.kinds.has(m.kind)) &&
        projectPass(t) &&
        (!query || projectNameMatch(t, query) || t.messages.some(m => textMatch(m, query))))
        .sort((a, b) => byNewest(a.last, b.last));
      const pinnedFirst = list => [...list.filter(t => t.pinned), ...list.filter(t => !t.pinned)];
      const threadItem = (t, lane) => ({ key: t.id, thread: t, lane, sig: JSON.stringify([t.sig, state.expanded.has(t.id), t.pinned, t.lane, t.project?.name, t.project?.color, t.filed, faces]) });
      let sections = [];
      let projectLanes = 0;
      if (threadArr.length && grouped) {
        const groups = groupLanes(threadArr, t => t, t => toMs(t.last.created_at) || 0)
          .sort((a, b) => laneRank(a.key) - laneRank(b.key) || b.latest - a.latest);
        projectLanes = groups.filter(g => g.kind === 'project').length;
        sections = groups.map(g => ({ ...g, count: g.entries.length, unread: g.entries.reduce((n, t) => n + t.unreadMine.length, 0), page: LANE_PAGE, items: pinnedFirst(g.entries).map(t => threadItem(t, g.key)) }));
        const pins = filtersActive() ? [] : threadArr.filter(t => t.pinned);
        if (pins.length) {
          sections.unshift({ key: 'pinned', kind: 'pinned', label: 'Pinned', count: pins.length, unread: pins.reduce((n, t) => n + t.unreadMine.length, 0), page: Infinity,
            items: pins.map(t => ({ key: t.id, thread: t, lane: 'pinned', strip: true, sig: JSON.stringify([t.subject, t.unreadMine.length, t.project?.name, t.project?.color]) })) });
        }
      } else if (threadArr.length) sections = [{ key: 'all', kind: 'flat', label: '', count: threadArr.length, page: PAGE, items: pinnedFirst(threadArr).map(t => threadItem(t, 'all')) }];
      const revealKey = renderLanes('everything', sections, item => (item.strip ? pinChip(item) : threadCard(item)));
      threadList.hidden = !sections.length;
      setEmpty(threadEmpty, sections.length ? null
        : loading ? h('div.bd-loading', h('span.spinner'), 'Connecting to the board…')
          : threads.size && filtersActive() ? filteredEmpty('threads')
            : emptyState('board', 'The board is quiet', `No one has posted yet. Post a notice or a question and agents will read it at their next check-in. ${HEARTBEAT}`, h('button.btn.primary', { type: 'button', onclick: () => openPost() }, icon('plus'), 'Post to board')),
      sections.length ? '' : loading ? 'loading' : threads.size && filtersActive() ? 'filtered' : 'empty');
      renderChips(threadArr.length ? `${threadArr.length} thread${threadArr.length === 1 ? '' : 's'}${grouped && projectLanes ? ` · ${projectLanes} project${projectLanes === 1 ? '' : 's'}` : ''}` : '');
      finishReveal('everything', revealKey, !loading);
    } else {
      const claimMatch = c => (!state.agent || c.holder === state.agent) && (!query || `${c.resource} ${c.purpose || ''} ${c.holder} ${person(c.holder).name}`.toLowerCase().includes(query));
      const activeClaims = activeAll.filter(claimMatch).sort((a, b) => toMs(a.expires_at) - toMs(b.expires_at));
      const history = all.filter(m => (m.kind === 'claim' || m.kind === 'release') && (!state.agent || m.from === state.agent) && textMatch(m, query)).sort(byNewest).slice(0, 40);
      const claimItems = activeClaims.map(c => ({ key: `${c.holder}|${c.resource}`, claim: c, sig: JSON.stringify([c.created_at, c.expires_at, c.purpose, looks]) }));
      stable(root, claimList, () => reconcile(claimList, caches.claims, claimItems, claimCard, ''));
      claimList.hidden = !claimItems.length;
      const claimFilters = Boolean(state.agent || state.search);
      setEmpty(claimEmpty, claimItems.length ? null
        : activeAll.length && claimFilters ? filteredEmpty('claims')
          : emptyState('bd-lock', 'No active claims', 'Agents claim a shared resource (like a release or a UI area) before touching it, then release it. Nothing is reserved right now.'),
      claimItems.length ? '' : activeAll.length && claimFilters ? 'filtered' : 'empty');
      const historyItems = history.map(m => ({ key: m.id, message: m, sig: faces }));
      stable(root, historyList, () => reconcile(historyList, caches.history, historyItems, historyRow, ''));
      historyList.hidden = !historyItems.length;
      historyEmpty.hidden = Boolean(historyItems.length);
      renderChips(`${activeClaims.length} active`);
    }
    refreshClock();
  }
  function renderNow() { if (frame) cancelAnimationFrame(frame); clearTimeout(fallback); frame = 0; render(); }
  // rAF batches bursts of store events; the timeout covers windows where frames are paused (minimized/occluded).
  function schedule() {
    if (frame || !visible) return;
    frame = requestAnimationFrame(renderNow);
    fallback = setTimeout(() => { if (frame) renderNow(); }, 400);
  }
  const reduceMotion = () => Boolean(store.prefs.reducedMotion) || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Move to project ---------- */
  function openMove(rootId) {
    closeMenu();
    const thread = buildThreads(store.mailboxMessages).get(rootId);
    if (!thread) { toast('That thread is no longer on the board.', { kind: 'error' }); return; }
    const pref = store.threadPrefs[rootId] || {};
    const current = store.threadProject(rootId, thread.messages);
    const how = pref.projectId ? 'filed' : 'auto';
    const projects = store.visibleProjects('board').slice().sort((a, b) => a.name.localeCompare(b.name));
    let dialog = null;
    const choose = (projectId, label) => {
      store.setThreadPrefs(rootId, { projectId });
      dialog?.close();
      toast(projectId === null ? 'Back to the auto-detected project.' : projectId === 'none' ? 'Moved to Unfiled.' : `Filed under ${label}.`, { kind: 'success', timeout: 2400 });
    };
    const row = (lead, label, projectId, selected) => h(`button.bd-move-row${selected ? '.selected' : ''}`, { type: 'button', 'aria-pressed': String(selected), dataset: { name: label.toLowerCase() }, onclick: () => choose(projectId, label) },
      lead, h('span.bd-move-name', label), selected ? h('span.bd-move-note', how) : null, selected ? icon('check') : null);
    const projectRows = projects.map(p => row(projectDot(p), p.name, p.id, current?.id === p.id));
    const search = projects.length > 8 ? h('input.input.bd-move-search', { type: 'search', placeholder: 'Find a project', 'aria-label': 'Find a project', autocomplete: 'off',
      oninput: event => { const q = event.currentTarget.value.trim().toLowerCase(); for (const node of projectRows) node.hidden = Boolean(q) && !node.dataset.name.includes(q); } }) : null;
    const hiddenNote = current && current.visible?.board === false ? h('p.field-hint', `Now in ${current.name}, which is hidden on the board.`) : null;
    const body = h('div.bd-move',
      h('p.bd-move-subject', thread.subject),
      search,
      h('div.bd-move-list', { role: 'group', 'aria-label': 'Projects' },
        projectRows,
        projects.length ? null : h('p.field-hint', 'No projects are shown on the board yet. Link one in Projects first.'),
        h('div.bd-move-sep'),
        row(projectDot(null), 'Unfiled', 'none', !current),
        pref.projectId ? row(h('span.bd-lane-icon', icon('refresh')), 'Use the auto-detected project', null, false) : null),
      hiddenNote,
      h('p.field-hint', 'Filing only changes how your board is organized. Agents never see it.'));
    dialog = ui.modal({ title: 'Move to project', body, actions: [{ label: 'Cancel' }] });
    dialog.classList.add('bd-move-modal');
    setTimeout(() => (search || body.querySelector('.bd-move-row.selected') || body.querySelector('.bd-move-row'))?.focus(), 40);
  }
  function postIn(project) {
    const live = (project && store.project(project.id)) || project;
    if (!live) { openPost(); return; }
    const home = store.agents.find(a => a.address && a.homeProjectId && live.ids.includes(a.homeProjectId) && store.addresses.some(x => x.name === a.address));
    openPost({ to: state.agent || home?.address || null, subject: `[${live.name}] `, project: live });
  }

  /* ---------- Post to board ---------- */
  function openPost({ to = state.agent, replyTo = null, subject = '', threadId = null, project = null } = {}) {
    const agents = store.addresses.filter(a => a.name !== OWNER);
    if (!agents.length) { toast('No agents are registered on the board yet. Register an existing Claude or Codex chat in Classic tools first.', { kind: 'error' }); return; }
    let kind = replyTo ? 'reply' : 'question';
    const toSelect = h('select.select#bd-post-to', agents.map(a => h('option', { value: a.name }, `${person(a.name).name}  ·  ${a.name}`)));
    toSelect.value = agents.some(a => a.name === to) ? to : agents[0].name;
    const toFace = h('span.bd-post-face');
    const syncFace = () => clear(toFace, face(person(toSelect.value), 34, true));
    toSelect.addEventListener('change', syncFace);
    syncFace();

    const kindButtons = [['question', 'Question', 'needs a reply'], ['notice', 'Notice', 'FYI']].map(([id, label, hint]) => h('button', { type: 'button', 'aria-pressed': String(kind === id), onclick: () => { kind = id; for (const b of kindButtons) b.setAttribute('aria-pressed', String(b.dataset.kind === id)); }, dataset: { kind: id } }, h('strong', label), h('span.bd-seg-hint', ` · ${hint}`)));
    const subjectInput = h('input.input#bd-post-subject', { type: 'text', maxlength: 300, placeholder: 'What is this about?', autocomplete: 'off' });
    subjectInput.value = subject;
    const bodyInput = h('textarea.textarea.bd-post-body#bd-post-body', { rows: 8, placeholder: 'Write in Markdown. Code fences, lists, tables and $math$ all work.' });
    const preview = h('div.bd-post-preview', { hidden: true });
    let mode = 'write';
    const modeButtons = [['write', 'Write'], ['preview', 'Preview']].map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(id === mode), dataset: { mode: id }, onclick: () => {
      mode = id;
      for (const b of modeButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === id));
      bodyInput.hidden = id !== 'write'; preview.hidden = id !== 'preview';
      if (id === 'preview') clear(preview, bodyInput.value.trim() ? renderMarkdown(bodyInput.value) : h('p.muted', 'Nothing to preview yet.'));
      else bodyInput.focus();
    } }, label));
    const error = h('p.bd-post-error', { role: 'alert', hidden: true });
    const fail = message => { error.textContent = message; error.hidden = false; return false; };
    const thread = threadId ? buildThreads(store.mailboxMessages).get(threadId) : null;

    const form = h('div.bd-post',
      replyTo ? h('div.bd-post-replying', icon('reply'), h('span', 'Replying in thread ', h('strong', stripRe(thread?.subject || subject) || 'this thread'))) : null,
      !replyTo && project ? h('div.bd-post-replying', projectDot(project), h('span', 'Posting in ', h('strong', project.name), '. Keep the [', project.name, '] tag so the thread lands in this project.')) : null,
      h('label.field', { for: 'bd-post-to' }, 'To', h('div.bd-post-to', toFace, toSelect)),
      replyTo ? null : h('div.field', h('span', 'Type'), h('div.segmented.bd-post-kind', { role: 'group', 'aria-label': 'Message type' }, kindButtons)),
      h('label.field', { for: 'bd-post-subject' }, 'Subject', subjectInput),
      h('div.field',
        h('div.bd-post-body-head', h('label', { for: 'bd-post-body' }, 'Message'), h('div.segmented.bd-post-mode', { role: 'group', 'aria-label': 'Editor mode' }, modeButtons)),
        bodyInput, preview),
      h('p.field-hint.bd-post-hint', icon('clock'), `${HEARTBEAT} A message is information, not permission. Ctrl+Enter posts.`),
      error);

    const submit = async () => {
      const subjectText = subjectInput.value.trim(), bodyText = bodyInput.value.trim();
      const target = toSelect.value;
      if (!target) return fail('Choose who this message is for.');
      if (!subjectText && !bodyText) return fail('Add a subject or a message first.');
      error.hidden = true;
      try {
        const saved = await store.post({ to: target, kind, subject: subjectText || plainText(bodyText, 80), body: bodyText, replyTo });
        // A project-tagged post should land in that project even if its name is too short for auto-detection.
        if (project && saved?.id && !replyTo && subjectText.includes(`[${project.name}]`) && store.threadProject(saved.id, [saved])?.id !== project.id) {
          store.setThreadPrefs(saved.id, { projectId: project.id });
        }
        const name = person(target).name;
        toast(`Posted for ${name}. They will see it at their next check-in.`, { kind: 'success', action: { label: 'View', run: () => navigate('board', { tab: 'everything', agent: null, thread: threadId || saved?.id }) } });
        return true;
      } catch (err) {
        return fail(`Could not post: ${err.message || 'the board is not reachable.'}`);
      }
    };
    const dialog = ui.modal({ title: replyTo ? 'Reply on the board' : 'Post to board', body: form, actions: [{ label: 'Cancel' }, { label: replyTo ? 'Post reply' : 'Post to board', kind: 'primary', run: submit }] });
    dialog.classList.add('bd-post-modal');
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); dialog.querySelector('.modal-actions .btn.primary')?.click(); }
    });
    setTimeout(() => {
      if (replyTo) { bodyInput.focus(); return; }
      subjectInput.focus();
      const end = subjectInput.value.length;
      try { subjectInput.setSelectionRange(end, end); } catch { /* not a text input */ }
    }, 40);
  }

  /* ---------- lifecycle ---------- */
  store.on('change', schedule);
  root.addEventListener('scroll', onMenuClose, { passive: true });
  document.addEventListener('keydown', event => {
    if (!visible || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key !== '/' || document.querySelector('dialog[open]')) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;
    event.preventDefault();
    if (getComputedStyle(filters).display === 'none') { page.classList.add('filters-open'); filterToggle.setAttribute('aria-expanded', 'true'); }
    searchInput.focus();
  });

  return {
    show(params = {}) {
      visible = true;
      if (params.tab && TABS.some(t => t.id === params.tab) && params.tab !== state.tab) { state.tab = params.tab; root.scrollTop = 0; }
      if ('agent' in params) { state.agent = params.agent || null; resetPaging(); }
      if ('project' in params) {
        const p = params.project ? String(params.project) : '';
        const project = p && !['none', 'unfiled', 'hidden'].includes(p) ? store.project(p.replace(/^p:/, '')) : null;
        state.project = !p ? null : p === 'none' || p === 'unfiled' ? 'unfiled' : p === 'hidden' ? 'hidden' : project ? laneKeyOf(project) : null;
        resetPaging();
      }
      if (params.thread) { state.expanded.add(params.thread); state.reveal = { tab: 'everything', id: params.thread, focus: false }; }
      renderNow();
    },
    hide() {
      visible = false;
      closeMenu();
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
    },
  };
}
