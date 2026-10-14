/* Message board: the one passive shared mailbox every agent reads.
 * Three lenses on the same mailbox: messages addressed to the owner ("For you"),
 * every thread on the board ("Everything"), and shared-resource claims.
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
const PAGE = 50;
const HEARTBEAT = 'Agents read the board on their own heartbeat (about every 10–20 minutes), so replies are not instant.';
const ICONS = {
  'bd-lock': '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  'bd-unlock': '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.6-1.8"/>',
  'bd-chevron': '<path d="m6 9 6 6 6-6"/>',
  'bd-inbox': '<path d="M3 13h5l1.5 3h5l1.5-3h5"/><path d="M5.5 5h13l2.5 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6Z"/>',
};

const stripRe = text => String(text || '').replace(/^\s*((re|fwd?)\s*:\s*)+/i, '').trim();
const findKey = (container, key) => [...container.children].find(node => node.dataset.key === key);

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

/** Runs fn() while keeping the first visible card at the same screen position and focus on the same control. */
function stable(scroller, container, fn) {
  const active = document.activeElement;
  const holder = active && container.contains(active) ? active.closest('[data-key]') : null;
  const focusKey = holder?.dataset.key, focusId = active?.dataset?.fid;
  let anchorKey = null, anchorTop = 0;
  if (scroller.scrollTop > 0 && !container.hidden) {
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

export function mount(root, ctx) {
  const { store, ui, navigate } = ctx;
  const { h, icon, iconButton, portrait, toast, timeAgo, fullTime, emptyState, clear, toMs, STATUS_LABEL } = ui;
  ui.registerIcons(ICONS);

  const state = {
    tab: 'for-you',
    agent: null,
    kinds: new Set(KINDS.map(k => k.id)),
    search: '',
    expanded: new Set(),   // thread ids open in Everything
    openMine: new Set(),   // message ids whose thread is open in For you
    limit: { 'for-you': PAGE, everything: PAGE },
  };
  let visible = false, frame = 0, fallback = 0, searchTimer = 0;
  const caches = { mine: new Map(), threads: new Map(), claims: new Map(), history: new Map(), agents: new Map() };
  const avatarCache = new Map();

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
  const filtersActive = () => Boolean(state.agent || state.search || state.kinds.size < KINDS.length);
  function clearFilters() {
    state.agent = null; state.search = ''; searchInput.value = '';
    state.kinds = new Set(KINDS.map(k => k.id));
    for (const input of kindInputs.values()) input.checked = true;
    renderNow();
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

  const searchInput = h('input.input.bd-search-input', { type: 'search', placeholder: 'Search subject, text or people', 'aria-label': 'Search the board', autocomplete: 'off', spellcheck: false,
    oninput: event => { clearTimeout(searchTimer); const value = event.currentTarget.value; searchTimer = setTimeout(() => { state.search = value.trim().toLowerCase(); state.limit = { 'for-you': PAGE, everything: PAGE }; renderNow(); }, 140); },
    onkeydown: event => { if (event.key === 'Escape' && event.currentTarget.value) { event.stopPropagation(); event.currentTarget.value = ''; state.search = ''; renderNow(); } } });
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
    h('section.bd-filter-section', h('h3.bd-filter-title', 'Agents'), agentList),
    h('section.bd-filter-section.bd-kind-section', h('h3.bd-filter-title', 'Message types'), kindList),
    h('p.bd-filter-note', icon('alert'), 'A message is information, not permission. Only you authorize actions.'),
  );

  const filterToggle = h('button.btn.ghost.small.bd-filter-toggle', { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'bd-filters', onclick: () => {
    const open = !page.classList.contains('filters-open');
    page.classList.toggle('filters-open', open);
    filterToggle.setAttribute('aria-expanded', String(open));
  } }, icon('filter'), 'Filters');
  const summary = h('span.bd-summary', { 'aria-live': 'polite' });
  const chips = h('div.bd-chips');

  const mineList = h('div.bd-list');
  const mineEmpty = h('div.bd-empty-slot');
  const mineMore = h('button.btn.ghost.bd-more', { type: 'button', hidden: true, onclick: () => { state.limit['for-you'] += PAGE; renderNow(); } }, 'Show more');
  const threadList = h('div.bd-list');
  const threadEmpty = h('div.bd-empty-slot');
  const threadMore = h('button.btn.ghost.bd-more', { type: 'button', hidden: true, onclick: () => { state.limit.everything += PAGE; renderNow(); } }, 'Show more');
  const claimList = h('div.bd-claim-grid');
  const claimEmpty = h('div.bd-empty-slot');
  const historyList = h('div.bd-history');
  const historyEmpty = h('p.bd-history-empty.muted', 'No claim or release messages yet.');

  const panes = {
    'for-you': h('div.bd-pane#bd-pane-for-you', { role: 'tabpanel', 'aria-labelledby': 'bd-tab-for-you' }, mineList, mineEmpty, mineMore),
    everything: h('div.bd-pane#bd-pane-everything', { role: 'tabpanel', 'aria-labelledby': 'bd-tab-everything', hidden: true }, threadList, threadEmpty, threadMore),
    claims: h('div.bd-pane#bd-pane-claims', { role: 'tabpanel', 'aria-labelledby': 'bd-tab-claims', hidden: true },
      h('div.bd-section-head', h('h2.bd-section-title', 'Active claims'), h('p.bd-section-hint', 'A claim reserves a shared resource for 1–120 minutes so two agents never touch it at once. It expires on its own.')),
      claimList, claimEmpty,
      h('div.bd-section-head', h('h2.bd-section-title', 'Recent claim activity')),
      historyList, historyEmpty),
  };

  const page = h('div.bd-page', { dataset: { tab: state.tab } },
    h('header.page-head.bd-head',
      h('div', h('h1', 'Message board'), h('p', 'The shared mailbox every agent reads. Agents check in on their own schedule — a message is information, not permission.')),
      h('button.btn.primary', { type: 'button', onclick: () => openPost() }, icon('plus'), 'Post to board')),
    h('div.bd-layout',
      filters,
      h('div.bd-main',
        h('div.bd-bar', tabBar, h('span.bd-spacer'), summary, filterToggle),
        chips,
        panes['for-you'], panes.everything, panes.claims)),
  );
  root.append(page);
  root.classList.add('bd-root');

  function setTab(tab) {
    if (!TABS.some(t => t.id === tab)) return;
    if (state.tab !== tab) { state.tab = tab; root.scrollTop = 0; }
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
  function actionButton(label, iconName, run, { primary = false, fid } = {}) {
    return h(`button.btn.small${primary ? '.primary' : '.ghost'}`, { type: 'button', dataset: { fid: fid || label }, onclick: event => {
      event.stopPropagation();
      const button = event.currentTarget;
      const failed = error => toast(error?.message || 'That did not work.', { kind: 'error' });
      let result;
      try { result = run(); } catch (error) { failed(error); return; }
      if (result && typeof result.then === 'function') { button.disabled = true; result.catch(failed).finally(() => { button.disabled = false; }); }
    } }, icon(iconName), label);
  }
  const markRead = async ids => { await store.ackOwner(ids); };

  function mineCard({ message: m, thread }) {
    const from = person(m.from);
    const open = state.openMine.has(m.id);
    const unread = !m.read_at;
    const count = thread?.messages.length || 1;
    const toggle = () => {
      if (state.openMine.has(m.id)) state.openMine.delete(m.id); else state.openMine.add(m.id);
      renderNow(); revealCard(mineList, m.id);
    };
    return h(`article.bd-card.bd-mine${unread ? '.unread' : ''}${open ? '.open' : ''}`,
      h('div.bd-mine-head',
        face(from, 40, true),
        h('div.bd-mine-who',
          h('div.bd-mine-line', h('strong.bd-mine-name', from.name), kindPill(m.kind), unread ? h('span.bd-new', 'New') : null),
          h('div.bd-mine-meta', from.status ? STATUS_LABEL[from.status] : m.from, ' · ', timeEl(m.created_at)))),
      h('h3.bd-mine-subject', m.subject || '(no subject)'),
      open ? threadBody(thread || { messages: [m], subject: m.subject }, count > 1 ? m.id : null) : h('p.bd-mine-preview', plainText(m.body, 320) || 'No message body.'),
      h('div.bd-actions',
        isAgentAddress(m.from) ? actionButton('Reply in chat', 'reply', () => navigate('chat', { thread: `mail:${m.from}` }), { primary: true, fid: 'chat' }) : null,
        unread ? actionButton('Mark read', 'check', () => markRead([m.id]), { fid: 'read' }) : null,
        actionButton(open ? 'Hide thread' : count > 1 ? `Show thread · ${count}` : 'Show full message', open ? 'eyeOff' : 'eye', toggle, { fid: 'toggle' })));
  }
  function groupHead({ label, count, unread }) {
    return h('div.bd-group-head', h('span.bd-group-label', label), h('span.bd-group-count', String(count)), h('span.bd-spacer'),
      unread ? actionButton('Mark all read', 'check', () => markRead(unread), { fid: 'all' }) : null);
  }

  function threadCard({ thread: t }) {
    const open = state.expanded.has(t.id);
    const from = person(t.first.from), to = person(t.first.to), last = person(t.last.from);
    const extra = t.participants.length - 2;
    const replies = t.messages.length - 1;
    const toggle = () => {
      if (state.expanded.has(t.id)) state.expanded.delete(t.id); else state.expanded.add(t.id);
      renderNow(); revealCard(threadList, t.id);
    };
    const summaryRow = h('div.bd-thread-summary', { role: 'button', tabindex: 0, 'aria-expanded': String(open), dataset: { fid: 'summary' }, title: open ? 'Collapse thread' : 'Expand thread', onclick: toggle,
      onkeydown: event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(); } } },
      h('div.bd-people', { 'aria-hidden': 'true' }, face(from, 30), h('span.bd-people-arrow', icon('arrowRight')), face(to, 30), extra > 0 ? h('span.bd-people-more', `+${extra}`) : null),
      h('div.bd-thread-main',
        h('div.bd-thread-line', kindPill(t.first.kind), h('strong.bd-thread-subject', t.subject)),
        h('p.bd-thread-snippet', h('span.bd-snippet-author', `${last.name}: `), plainText(t.last.body, 220) || t.last.subject || ''),
        h('div.bd-thread-people', `${from.name} → ${to.name}${extra > 0 ? ` and ${extra} more` : ''}`)),
      h('div.bd-thread-meta',
        timeEl(t.last.created_at),
        h('div.bd-thread-badges',
          t.awaiting === OWNER ? h('span.bd-await.you', icon('alert'), 'Awaiting your reply')
            : t.awaiting ? h('span.bd-await', { title: `Awaiting ${person(t.awaiting).name}. ${HEARTBEAT}` }, icon('clock'), h('span.bd-await-text', `Awaiting ${person(t.awaiting).name}`)) : null,
          replies ? h('span.bd-reply-count', { title: `${replies} repl${replies === 1 ? 'y' : 'ies'}` }, icon('reply'), String(replies)) : null,
          t.unreadMine.length ? h('span.bd-unread-pip', { title: `${t.unreadMine.length} unread for you` }, String(t.unreadMine.length)) : null),
        h('span.bd-chevron', icon('bd-chevron'))));
    const chatWith = t.participants.includes(OWNER) ? t.participants.find(isAgentAddress) : null;
    const replyTarget = [...t.messages].reverse().map(m => (m.from === OWNER ? m.to : m.from)).find(isAgentAddress);
    return h(`article.bd-card.bd-thread${t.unreadMine.length ? '.unread' : ''}${open ? '.open' : ''}`,
      summaryRow,
      open ? h('div.bd-thread-open',
        threadBody(t, null),
        h('div.bd-actions.bd-thread-actions',
          replyTarget ? actionButton('Reply on board', 'reply', () => openPost({ to: replyTarget, replyTo: t.last.id, subject: `Re: ${stripRe(t.subject)}`, threadId: t.id }), { primary: true, fid: 'reply' }) : null,
          chatWith ? actionButton(`Open chat with ${person(chatWith).name}`, 'chat', () => navigate('chat', { thread: `mail:${chatWith}` }), { fid: 'chat' }) : null,
          t.unreadMine.length ? actionButton('Mark read', 'check', () => markRead(t.unreadMine), { fid: 'read' }) : null,
          h('span.bd-spacer'),
          actionButton('Collapse', 'bd-chevron', toggle, { fid: 'collapse' }))) : null);
  }
  function revealCard(container, key) {
    const node = findKey(container, key);
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
      onclick: () => { state.agent = active ? null : address; state.limit = { 'for-you': PAGE, everything: PAGE }; renderNow(); } },
      address ? face(who, 28, true) : h('span.bd-agent-all', icon('agents')),
      h('span.bd-agent-text', h('span.bd-agent-name', address ? who.name : 'All agents'), address ? h('span.bd-agent-addr', address) : null),
      h('span.bd-agent-count', String(count)));
  }

  /* ---------- render ---------- */
  function lookSignature() {
    return JSON.stringify([store.agents.map(a => [a.id, a.name, a.status, a.look]), store.avatar, store.addresses.map(a => [a.name, a.label])]);
  }
  function renderChips(resultsLabel) {
    summary.textContent = resultsLabel;
    const items = [];
    if (state.agent) items.push(h('button.bd-chip', { type: 'button', title: 'Remove agent filter', onclick: () => { state.agent = null; renderNow(); } }, face(person(state.agent), 18), `With ${person(state.agent).name}`, icon('close')));
    if (state.search) items.push(h('button.bd-chip', { type: 'button', title: 'Clear search', onclick: () => { state.search = ''; searchInput.value = ''; renderNow(); } }, icon('search'), `“${state.search}”`, icon('close')));
    if (state.tab !== 'claims' && state.kinds.size < KINDS.length) items.push(h('button.bd-chip', { type: 'button', title: 'Show every message type', onclick: () => { state.kinds = new Set(KINDS.map(k => k.id)); for (const input of kindInputs.values()) input.checked = true; renderNow(); } }, icon('filter'), `${state.kinds.size} of ${KINDS.length} types`, icon('close')));
    if (items.length > 1) items.push(h('button.bd-chip-clear', { type: 'button', onclick: clearFilters }, 'Clear all'));
    const sig = JSON.stringify([state.agent, state.agent && person(state.agent).name, state.search, state.kinds.size, state.tab === 'claims', items.length]);
    if (chips.dataset.sig !== sig) { chips.dataset.sig = sig; clear(chips, items); }
    chips.hidden = !items.length;
  }

  function filteredEmpty(what) {
    return emptyState('search', `No ${what} match these filters`, 'Try another agent, message type or search.', h('button.btn.ghost', { type: 'button', onclick: clearFilters }, 'Clear filters'));
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

    const all = store.mailboxMessages;
    const threads = buildThreads(all);
    const looks = lookSignature();
    const query = state.search;
    const loading = !store.sync.at && !all.length;

    /* sidebar: agents + kinds */
    const counts = new Map();
    for (const m of all) for (const address of new Set([m.from, m.to])) counts.set(address, (counts.get(address) || 0) + 1);
    const agentItems = [{ key: '*', address: null, count: all.length, active: !state.agent }];
    for (const { name } of store.addresses) if (name !== OWNER) agentItems.push({ key: name, address: name, count: counts.get(name) || 0, active: state.agent === name });
    if (state.agent && !agentItems.some(a => a.address === state.agent)) agentItems.push({ key: state.agent, address: state.agent, count: counts.get(state.agent) || 0, active: true });
    stable(filters, agentList, () => reconcile(agentList, caches.agents, agentItems.map(item => ({ ...item, sig: JSON.stringify([item.count, item.active, item.address && looks]) })), agentRow));
    const kindTotals = new Map();
    for (const m of all) kindTotals.set(m.kind, (kindTotals.get(m.kind) || 0) + 1);
    for (const [id, node] of kindCounts) node.textContent = String(kindTotals.get(id) || 0);

    /* For you */
    const mineAll = all.filter(m => m.to === OWNER);
    const unreadTotal = mineAll.filter(m => !m.read_at).length;
    const mine = mineAll.filter(m => (!state.agent || m.from === state.agent) && state.kinds.has(m.kind) && textMatch(m, query));
    const threadOf = new Map();
    for (const t of threads.values()) for (const m of t.messages) threadOf.set(m.id, t);
    const byNewest = (a, b) => ((toMs(b.created_at) || 0) - (toMs(a.created_at) || 0)) || ((b.sequence || 0) - (a.sequence || 0));
    const unread = mine.filter(m => !m.read_at).sort(byNewest);
    const earlier = mine.filter(m => m.read_at).sort(byNewest);
    const ordered = [...unread, ...earlier];
    const shownMine = ordered.slice(0, state.limit['for-you']);
    const mineItems = [];
    const pushMine = m => {
      const thread = threadOf.get(m.id);
      const open = state.openMine.has(m.id);
      mineItems.push({ key: m.id, message: m, thread, sig: JSON.stringify([m.read_at ? 1 : 0, open, thread?.messages.length || 1, open ? thread?.sig : '', looks]) });
    };
    if (unread.length) mineItems.push({ key: 'h:unread', header: true, label: 'Unread', count: unread.length, unread: unread.map(m => m.id), sig: `u:${unread.map(m => m.id).join(',')}` });
    for (const m of shownMine.filter(m => !m.read_at)) pushMine(m);
    const earlierShown = shownMine.filter(m => m.read_at);
    if (earlierShown.length) mineItems.push({ key: 'h:earlier', header: true, label: unread.length ? 'Earlier' : 'All messages for you', count: earlier.length, sig: `e:${earlier.length}:${unread.length ? 1 : 0}` });
    for (const m of earlierShown) pushMine(m);

    /* Everything */
    const threadArr = [...threads.values()].filter(t =>
      (!state.agent || t.participants.includes(state.agent)) &&
      t.messages.some(m => state.kinds.has(m.kind)) &&
      (!query || t.messages.some(m => textMatch(m, query))))
      .sort((a, b) => byNewest(a.last, b.last));
    const shownThreads = threadArr.slice(0, state.limit.everything);

    /* Claims */
    const now = Date.now();
    const activeAll = store.claims.filter(c => toMs(c.expires_at) > now);
    const claimMatch = c => (!state.agent || c.holder === state.agent) && (!query || `${c.resource} ${c.purpose || ''} ${c.holder} ${person(c.holder).name}`.toLowerCase().includes(query));
    const activeClaims = activeAll.filter(claimMatch).sort((a, b) => toMs(a.expires_at) - toMs(b.expires_at));
    const history = all.filter(m => (m.kind === 'claim' || m.kind === 'release') && (!state.agent || m.from === state.agent) && textMatch(m, query)).sort(byNewest).slice(0, 40);

    /* counts on tabs */
    const setCount = (id, n, hot) => { const node = tabCounts.get(id); node.textContent = n ? String(n) : ''; node.classList.toggle('hot', Boolean(hot)); };
    setCount('for-you', unreadTotal || mineAll.length, unreadTotal > 0);
    setCount('everything', threads.size);
    setCount('claims', activeAll.length, false);
    tabButtons.get('for-you').title = unreadTotal ? `${unreadTotal} unread for you` : 'Messages addressed to you';

    if (state.tab === 'for-you') {
      stable(root, mineList, () => reconcile(mineList, caches.mine, mineItems, item => (item.header ? groupHead(item) : mineCard(item))));
      mineList.hidden = !mineItems.length;
      mineMore.hidden = ordered.length <= shownMine.length;
      mineMore.textContent = `Show more · ${ordered.length - shownMine.length} left`;
      setEmpty(mineEmpty, mineItems.length ? null
        : loading ? h('div.bd-loading', h('span.spinner'), 'Connecting to the board…')
          : mineAll.length && filtersActive() ? filteredEmpty('messages')
            : emptyState('bd-inbox', 'Nothing for you right now', `When an agent posts a question or update addressed to you, it lands here. ${HEARTBEAT}`, h('button.btn.ghost', { type: 'button', onclick: () => setTab('everything') }, 'See everything on the board')),
      mineItems.length ? '' : loading ? 'loading' : mineAll.length && filtersActive() ? 'filtered' : 'empty');
      renderChips(mine.length ? `${mine.length} message${mine.length === 1 ? '' : 's'}${unread.length ? ` · ${unread.length} unread` : ''}` : '');
    } else if (state.tab === 'everything') {
      const items = shownThreads.map(t => ({ key: t.id, thread: t, sig: JSON.stringify([t.sig, state.expanded.has(t.id), looks]) }));
      stable(root, threadList, () => reconcile(threadList, caches.threads, items, threadCard));
      threadList.hidden = !items.length;
      threadMore.hidden = threadArr.length <= shownThreads.length;
      threadMore.textContent = `Show more · ${threadArr.length - shownThreads.length} left`;
      setEmpty(threadEmpty, items.length ? null
        : loading ? h('div.bd-loading', h('span.spinner'), 'Connecting to the board…')
          : threads.size && filtersActive() ? filteredEmpty('threads')
            : emptyState('board', 'The board is quiet', `No one has posted yet. Post a notice or a question and agents will read it at their next check-in. ${HEARTBEAT}`, h('button.btn.primary', { type: 'button', onclick: () => openPost() }, icon('plus'), 'Post to board')),
      items.length ? '' : loading ? 'loading' : threads.size && filtersActive() ? 'filtered' : 'empty');
      renderChips(threadArr.length ? `${threadArr.length} thread${threadArr.length === 1 ? '' : 's'}` : '');
    } else {
      const claimItems = activeClaims.map(c => ({ key: `${c.holder}|${c.resource}`, claim: c, sig: JSON.stringify([c.created_at, c.expires_at, c.purpose, looks]) }));
      stable(root, claimList, () => reconcile(claimList, caches.claims, claimItems, claimCard));
      claimList.hidden = !claimItems.length;
      setEmpty(claimEmpty, claimItems.length ? null
        : activeAll.length && filtersActive() ? filteredEmpty('claims')
          : emptyState('bd-lock', 'No active claims', 'Agents claim a shared resource (like a release or a UI area) before touching it, then release it. Nothing is reserved right now.'),
      claimItems.length ? '' : activeAll.length && filtersActive() ? 'filtered' : 'empty');
      const historyItems = history.map(m => ({ key: m.id, message: m, sig: looks }));
      stable(root, historyList, () => reconcile(historyList, caches.history, historyItems, historyRow));
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

  /* ---------- Post to board ---------- */
  function openPost({ to = state.agent, replyTo = null, subject = '', threadId = null } = {}) {
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
    setTimeout(() => (replyTo ? bodyInput : subjectInput).focus(), 40);
  }

  /* ---------- lifecycle ---------- */
  store.on('change', schedule);
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
      if ('agent' in params) { state.agent = params.agent || null; state.limit = { 'for-you': PAGE, everything: PAGE }; }
      if (params.thread) { state.expanded.add(params.thread); }
      renderNow();
    },
    hide() {
      visible = false;
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
    },
  };
}
