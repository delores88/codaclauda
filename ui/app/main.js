/* CodaClauda app shell: navigation rail, top bar, lazy view loading, notifications. */
import { store } from './store.js';
import * as ui from './ui.js';
import * as bridge from './bridge.js';
import { pendingRequests } from './approvals.js';
const { h, icon, $, clear, portrait, toast, timeAgo } = ui;

const VIEWS = [
  { id: 'chat', label: 'Chat', icon: 'chat', load: () => import('./views/chat.js') },
  { id: 'board', label: 'Message board', icon: 'board', load: () => import('./views/board.js') },
  { id: 'tasks', label: 'Tasks', icon: 'tasks', load: () => import('./views/tasks.js') },
  { id: 'city', label: 'City', icon: 'city', load: () => import('./views/city.js') },
  { id: 'agents', label: 'Agents', icon: 'agents', load: () => import('./views/agents.js') },
  { id: 'connect', label: 'Agent setup', icon: 'agentAdd', load: () => import('./views/connect.js') },
  { id: 'projects', label: 'Projects', icon: 'projects', load: () => import('./views/projects.js') },
  { id: 'approvals', label: 'Approvals', icon: 'shield', load: () => import('./views/approvals.js') },
];
const FOOTER_VIEWS = [
  { id: 'avatar', label: 'My avatar', icon: 'avatar', load: () => import('./views/avatar.js') },
  { id: 'settings', label: 'Settings', icon: 'settings', load: () => import('./views/settings.js') },
];
const ALL = [...VIEWS, ...FOOTER_VIEWS];
const mounted = new Map();   // id -> { root, api }
let current = null;

const ctx = { store, ui, bridge, navigate, get view() { return current; } };

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

/** Rail views: Chat-first layout (Settings) hides the City; navigate('city') still works. */
const railViews = () => VIEWS.filter(view => !(store.prefs.chatFirst && view.id === 'city'));
let railSig = '';

function renderRail() {
  const rail = $('#rail');
  const views = railViews();
  railSig = views.map(v => v.id).join();
  const item = view => h('button.rail-item', { type: 'button', dataset: { view: view.id }, title: view.label, 'aria-label': view.label, onclick: () => navigate(view.id) }, icon(view.icon), h('span.rail-label', view.label), h('span.rail-badge', { hidden: true }));
  clear(rail,
    h('a.rail-brand', { href: '#', title: 'CodaClauda', onclick: event => { event.preventDefault(); navigate('chat'); } }, h('img', { src: 'brand.svg', alt: '', width: 34, height: 34 })),
    h('div.rail-group', views.map(item)),
    h('div.rail-spacer'),
    h('div.rail-group', FOOTER_VIEWS.map(item)),
  );
}

function renderTopbar() {
  const bar = $('#topbar');
  const active = ALL.find(v => v.id === current);
  const unread = store.ownerUnread;
  const me = store.avatar;
  const working = store.agents.filter(a => a.status === 'active').length;
  clear(bar,
    h('div.topbar-title', h('span.wordmark', 'Coda', h('b', 'Clauda')), h('span.crumb-sep', '/'), h('strong', active?.label || '')),
    h('div.topbar-actions',
      h(`span.sync-pill.${store.sync.ok ? 'ok' : 'bad'}`, { title: store.sync.ok ? `Board synced ${timeAgo(store.sync.at)}` : store.sync.error || 'Connecting…' },
        h('span.sync-dot'), store.sync.ok ? `${working} agent${working === 1 ? '' : 's'} working` : store.sync.at ? 'Board offline' : 'Connecting…'),
      h('button.icon-btn.bell', { type: 'button', title: unread ? `${unread} unread for you` : 'Messages for you', 'aria-label': 'Messages for you', onclick: () => navigate('board', { tab: 'for-you' }) }, icon('bell'), unread ? h('span.bell-count', unread > 99 ? '99+' : unread) : null),
      ui.iconButton(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 'Toggle theme', () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; applyTheme(next); store.setPref('theme', next); renderTopbar(); }),
      h('button.me-chip', { type: 'button', title: 'My avatar', onclick: () => navigate('avatar') }, portrait(me || { name: 'You' }, { size: 30 }), h('span', me?.name || 'Create avatar')),
    ),
  );
}

function updateBadges() {
  const chatUnread = store.threads().reduce((n, t) => n + (t.unread || 0), 0);
  const needsYou = store.tasks.filter(t => t.status === 'needs-you').length;
  const approvalRequests = pendingRequests(store.mailboxMessages, store.desktop.approvals || []).length;
  const counts = { chat: chatUnread, tasks: needsYou, approvals: approvalRequests };
  for (const node of document.querySelectorAll('.rail-item')) {
    const badge = node.querySelector('.rail-badge'); const n = counts[node.dataset.view] || 0;
    badge.hidden = !n; badge.textContent = n > 99 ? '99+' : String(n);
    node.classList.toggle('active', node.dataset.view === current);
  }
}

export async function navigate(id, params = {}) {
  const view = ALL.find(v => v.id === id) || VIEWS[0];
  if (current && current !== view.id) mounted.get(current)?.api?.hide?.();
  current = view.id;
  for (const [key, entry] of mounted) entry.root.hidden = key !== view.id;
  let entry = mounted.get(view.id);
  if (!entry) {
    const root = h(`section.view.view-${view.id}`, { 'aria-label': view.label });
    $('#views').append(root);
    entry = { root, api: null };
    mounted.set(view.id, entry);
    root.append(h('div.view-loading', h('span.spinner'), 'Loading…'));
    try {
      const module = await view.load();
      root.replaceChildren();
      entry.api = module.mount(root, ctx) || {};
    } catch (error) {
      console.error(error);
      clear(root, ui.emptyState('alert', `${view.label} could not load`, error.message));
    }
  }
  entry.root.hidden = false;
  entry.api?.show?.(params);
  try { history.replaceState(null, '', `#${view.id}`); } catch { /* file preview */ }
  renderTopbar(); updateBadges();
}

/* Gentle two-note chime made with WebAudio (no audio assets). */
let audio;
function chime() {
  if (!store.prefs.sound) return;
  try {
    audio ||= new AudioContext();
    const now = audio.currentTime;
    for (const [i, freq] of [[0, 784], [1, 1046.5]]) {
      const osc = audio.createOscillator(), gain = audio.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.12); gain.gain.exponentialRampToValueAtTime(0.12, now + i * 0.12 + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.35);
      osc.connect(gain).connect(audio.destination); osc.start(now + i * 0.12); osc.stop(now + i * 0.12 + 0.4);
    }
  } catch { /* audio optional */ }
}

function onNotify({ messages }) {
  if (!store.prefs.notify) return;
  chime();
  bridge.desktop.attention().catch(() => {});
  const first = messages[0];
  const from = store.addressLabel(first.from);
  toast(messages.length > 1 ? `${messages.length} new messages for you` : `${from}: ${first.subject}`, {
    kind: 'info', timeout: 9000,
    action: { label: 'Open', run: () => navigate('chat', { thread: `mail:${first.from}` }) },
  });
}

async function boot() {
  applyTheme('dark');
  renderRail(); renderTopbar();
  store.on('change', () => {
    document.documentElement.classList.toggle('chat-first', Boolean(store.prefs.chatFirst));
    if (railViews().map(v => v.id).join() !== railSig) renderRail();
    renderTopbar(); updateBadges();
  });
  store.on('sync', () => renderTopbar());
  store.on('notify', onNotify);
  // Pinch / Ctrl+wheel never zooms the whole app window (the City handles its own zoom).
  document.addEventListener('wheel', event => { if (event.ctrlKey) event.preventDefault(); }, { capture: true, passive: false });
  // Safety net: an external http(s) link anywhere in the app opens in the browser, never inside this window.
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link || event.defaultPrevented) return;
    const href = link.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) { event.preventDefault(); bridge.desktop.openExternal(href).catch(() => ui.copyText(href, 'Link copied')); }
  });
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const index = Number(event.key) - 1, views = railViews();
    if (index >= 0 && index < views.length) { event.preventDefault(); navigate(views[index].id); }
  });
  // Deep links: #view or #view?key=value&key2=value2 (e.g. #chat?thread=mail:codex-claudacoda)
  const [initial, query = ''] = location.hash.slice(1).split('?');
  const initialParams = Object.fromEntries(new URLSearchParams(query));
  // Views render immediately and fill in as the store loads (they listen for 'change').
  // A #city deep link waits for the saved prefs: the Chat-first layout opens Chat instead.
  const known = ALL.some(v => v.id === initial);
  if (initial === 'city') await store.loadDesktop();
  navigate(known && !(initial === 'city' && store.prefs.chatFirst) ? initial : 'chat', initialParams);
  if (initial !== 'city') await store.loadDesktop();
  applyTheme(store.prefs.theme || 'dark');
  store.emit('change');
  store.start().then(() => {
    // First launch with agents but no approvals yet: offer the one-click standing approval once.
    const agents = store.agents.filter(a => a.kind === 'mailbox');
    if (!store.desktop.approvalsPrompted && !(store.desktop.approvals || []).length && agents.length) {
      store.updateDesktop(d => { d.approvalsPrompted = true; });
      toast(`Let your ${agents.length} agents do routine work while you're away? Set up standing permissions once and paste them into each chat.`, { kind: 'info', timeout: 15000, action: { label: 'Set up', run: () => navigate('approvals') } });
    }
  }).catch(error => toast(`Could not reach the local board: ${error.message}`, { kind: 'error' }));
}

boot();
