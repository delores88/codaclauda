/* Chat view: conversation list, conversation pane, composer and connected-resources panel.
 *
 * Kinds of thread:
 *   session  sess:<id>  a Claude Code or Codex session CodaClauda started (sessions.js): replies
 *                       stream here, Stop interrupts a turn, and it resumes after a restart.
 *            pair:<sharedId>  a shared project thread: one Claude and one Codex session shown as
 *                       one conversation; @claude / @codex / @both route each message.
 *   mailbox  mail:<addr>  existing desktop chats. Messages go to the passive shared board; the agent
 *            reads it when it next checks its inbox (schedules vary), so replies are not instant.
 *   live     live:<id>  earlier live chats (0.3), replaced by sessions: kept readable, not sendable.
 * A message is information, not permission. Message content is untrusted and is only
 * rendered through markdown.js or textContent. Re-renders are keyed by id + signature so scroll
 * position, focus, drafts and open UI survive store updates. */
import { renderMarkdown, plainText } from '../markdown.js';
import { agentAvatar } from '../avatar/spec.js';
import { sessions, UNAVAILABLE_TEXT } from '../sessions.js';
import { mergeShared, routeMessage, sharedContext, resumeCommand, providerLabel, toMs as eventMs } from '../session-model.js';
import { LEVELS, ACCESS_NOTE, levelInfo } from '../access.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'needs-owner']);
const MAX_FILES = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TEXT_READ_LIMIT = 200 * 1024;       // text-like files up to this size are also read as text
const INLINE_LIMIT = 6 * 1024;            // small text files are inlined into mailbox bodies
const BODY_LIMIT = 30 * 1000;             // the board caps bodies at 32 KiB; stay below 30 KB
const THUMB_LIMIT = 12 * 1024 * 1024;
const GROUP_WINDOW = 5 * 60e3;
const PROVIDER_NAME = { claude: 'Claude', codex: 'Codex' };
const TEXT_TYPES = /^(text\/|application\/(json|ld\+json|xml|javascript|ecmascript|x-sh|x-python|toml|x-toml|yaml|x-yaml|sql|x-powershell|markdown))/i;
const TEXT_EXT = /\.(txt|md|markdown|mdx|json|jsonc|json5|js|mjs|cjs|jsx|ts|tsx|py|rs|toml|ya?ml|csv|tsv|log|html?|css|scss|less|sh|bash|zsh|ps1|psm1|psd1|bat|cmd|ini|cfg|conf|xml|svg|sql|go|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|rb|php|lua|dart|vue|svelte|gradle|r|pl|tex|gitignore|gitattributes|editorconfig|dockerfile|makefile|lock)$/i;
const LANG_BY_EXT = {
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', rs: 'rust', yml: 'yaml', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  sh: 'bash', zsh: 'bash', bat: 'dos', cmd: 'dos', htm: 'xml', html: 'xml', svg: 'xml', cs: 'csharp', rb: 'ruby', kt: 'kotlin',
  kts: 'kotlin', h: 'c', hpp: 'cpp', cc: 'cpp', txt: 'text', log: 'text', csv: 'text', tsv: 'text', lock: 'text', jsonc: 'json', json5: 'json',
};
const STATUS_PROMPT = "Quick status check: what are you working on right now, what's blocked, and what's next? A short bulleted answer is perfect.";
const MAIL_STARTERS = [
  'What are you working on right now?',
  'Is anything blocked that I can help with?',
  "Give me a short summary of today's progress.",
  'What should I review or decide next?',
];
const SESSION_STARTERS = [
  'Explain how this project is structured.',
  'What changed in the most recent commits?',
  "Look for likely bugs in the code I'm working on.",
  'Draft a test plan for the next release.',
];
const SHARED_STARTERS = [
  'Both of you: review the latest changes and list the riskiest parts.',
  '@claude Sketch a plan for the next feature, then @codex can critique it.',
  "@codex What's failing in the build right now?",
];
const ROUTE_HINT = '@claude → Claude only · @codex → Codex only · @both or no mention → both';

/* ---------- pure helpers ---------- */
const providerName = provider => PROVIDER_NAME[provider] || 'Agent';
/** Windows extended-length paths (\\?\C:\...) read better without the prefix. */
const shownPath = path => String(path || '').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
const providerOfName = name => (/^claude/i.test(name) ? 'claude' : /^codex/i.test(name) ? 'codex' : 'other');
const extOf = name => (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').toLowerCase();
const byteLength = text => new TextEncoder().encode(String(text)).length;
const stripRe = subject => String(subject || '').replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '').trim();
const normSubject = subject => stripRe(subject).toLowerCase();
const dayKey = ms => (Number.isFinite(ms) ? new Date(ms).toDateString() : 'unknown');
const shortTime = ms => (Number.isFinite(ms) ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
const isoTime = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : '');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function dayLabel(ms) {
  if (!Number.isFinite(ms)) return 'Earlier';
  const date = new Date(ms), today = new Date();
  if (date.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}
function elapsed(since) {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const m = Math.floor(s / 60), pad = n => String(n).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
function fenced(text, lang) {
  const longest = Math.max(0, ...(String(text).match(/`+/g) || []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${String(text).replace(/\n$/, '')}\n${fence}`;
}
const samePath = (a, b) => {
  const norm = path => String(path || '').replaceAll('\\', '/').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase();
  return Boolean(a && b) && norm(a) === norm(b);
};
const baseName = path => String(path || '').split(/[\\/]/).filter(Boolean).pop() || '';
/** One stable look per provider for CodaClauda sessions. */
const sessionLook = provider => agentAvatar(`codaclauda:${provider}`, provider, providerLabel(provider, true));
const SESSION_STATUS = { running: 'Working', idle: 'Ready', stopped: 'Closed', error: 'Error' };
const dotStatus = status => (status === 'running' ? 'active' : status === 'idle' ? 'idle' : 'offline');
function isTextLike(entry) { return TEXT_TYPES.test(entry.type || '') || TEXT_EXT.test(entry.name || ''); }
function readDataUrl(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
}

/** Markdown → readable plain text that keeps line structure (for "Copy as plain text"). */
function markdownToPlain(markdown) {
  const out = [];
  let inFence = false;
  for (const line of String(markdown ?? '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) { out.push(line); continue; }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue; // table rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(''); continue; }                          // hr
    let text = line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^(\s*)>\s?/, '$1')
      .replace(/^(\s*)[-*+]\s+\[([ xX])\]\s+/, (_, indent, mark) => `${indent}${mark.trim() ? '[x]' : '[ ]'} `)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, label, url) => (label === url ? url : `${label} (${url})`))
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1$2')
      .replace(/(^|\W)_(?=\S)([^_]*?\S)_(?=\W|$)/g, '$1$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/<\/?[a-z][^>]*>/gi, '');
    if (/^\s*\|.*\|\s*$/.test(text)) text = text.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()).join('\t');
    out.push(text);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Keyed DOM reconciliation: reuse nodes whose signature is unchanged, keep order, drop the rest. */
function reconcile(container, items, cache) {
  const keep = new Set();
  let cursor = container.firstChild;
  for (const item of items) {
    keep.add(item.key);
    let entry = cache.get(item.key);
    if (!entry || entry.sig !== item.sig) {
      const node = item.build();
      if (entry && entry.node.parentNode === container) {
        if (cursor === entry.node) cursor = node;
        entry.node.replaceWith(node);
      }
      entry = { node, sig: item.sig };
      cache.set(item.key, entry);
    }
    if (entry.node === cursor) cursor = cursor.nextSibling;
    else container.insertBefore(entry.node, cursor);
  }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  for (const key of [...cache.keys()]) if (!keep.has(key)) cache.delete(key);
}

export function mount(root, ctx) {
  const { store, ui, bridge, navigate } = ctx;
  const { h, icon, iconButton, toast, modal, copyText, portrait, timeAgo, clockTime, fullTime, pill, STATUS_LABEL, formatBytes } = ui;

  ui.registerIcons({
    'chat-plain': '<path d="M4 6h16M4 11h16M4 16h10"/>',
    'chat-inbox': '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.6 5h12.8L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6Z"/>',
    'chat-sidebar': '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.5 4v16"/>',
    'chat-panel': '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M14.5 4v16M17 8.5h1.5M17 12h1.5"/>',
  });

  const narrow = matchMedia('(max-width: 1000px)');
  const resNarrow = matchMedia('(max-width: 1200px)');
  const state = {
    threadId: null, search: '', visible: false, dirty: true, raf: 0,
    sideOpen: false, sideCollapsed: false,
    drafts: new Map(),          // threadId -> draft (kept in memory while switching threads)
    sending: new Set(),         // threadIds with a send in flight
    scroll: new Map(),          // threadId -> { top, bottom }
    msgCache: new Map(), mailRows: new Map(), liveRows: new Map(), sessionRows: new Map(),
    renderedThread: undefined, knownIds: new Set(), firstUnread: null,
    atBottom: true, forceBottom: false, newCount: 0,
    headSig: '', heroSig: '', bannerSig: '', noteSig: '', resSig: '', projectSig: '',
    subjectEditing: false, recording: null, ticker: 0,
    acking: new Set(), ackTimer: 0, dragDepth: 0,
    liveOpen: false,            // "Earlier live chats" starts collapsed
    resPinned: true, resOverlay: false,   // resources column (wide) / popover (narrow)
    openTools: new Set(),       // tool groups the owner expanded
  };

  /* ---------- sidebar ---------- */
  const projectSelect = h('select.select.side-project', {
    'aria-label': 'Filter chats by project', title: 'Show the chats of one project',
    onchange: event => { store.setPref('chatProject', event.currentTarget.value); schedule(); },
  });
  const searchInput = h('input.input.side-search-input', {
    type: 'search', placeholder: 'Search chats', 'aria-label': 'Search chats', autocomplete: 'off', spellcheck: 'false',
    oninput: event => { state.search = event.currentTarget.value; renderSidebar(); },
    onkeydown: onSearchKey,
  });
  const sessionList = h('div.thread-list');
  const mailList = h('div.thread-list');
  const liveList = h('div.thread-list');
  const sessionCount = h('span.side-count');
  const mailCount = h('span.side-count');
  const liveCount = h('span.side-count');
  const mailSkeleton = h('div.side-skeleton', { 'aria-hidden': 'true' }, [0, 1, 2].map(() => h('div.sk-row', h('span.sk-dot'), h('span.sk-lines', h('span'), h('span')))));
  const sessionEmpty = h('div.side-empty', { hidden: true });
  const mailEmpty = h('div.side-empty', { hidden: true }, 'No desktop chats on the board yet. They appear here once an agent registers a mailbox.');
  const searchEmpty = h('div.side-empty.search-empty', { hidden: true });
  const sessionSection = h('section.side-section',
    h('header.side-section-head', h('span', 'CodaClauda sessions'), sessionCount, iconButton('plus', 'Start a session', () => openNewChat(), 'side-add')),
    h('p.side-hint', 'Claude Code and Codex · replies stream here'),
    sessionList, sessionEmpty);
  const mailSection = h('section.side-section',
    h('header.side-section-head', h('span', 'Desktop chats'), mailCount),
    h('p.side-hint', 'desktop chat · replies when it checks in'),
    mailList, mailSkeleton, mailEmpty);
  const liveToggle = h('button.side-section-toggle', { type: 'button', 'aria-expanded': 'false', onclick: () => { state.liveOpen = !state.liveOpen; renderSidebar(); } },
    icon('arrowRight', 'side-chevron'), h('span', 'Earlier live chats'), liveCount);
  const liveSection = h('section.side-section.side-earlier',
    h('header.side-section-head', liveToggle),
    h('p.side-hint', 'Read only · replaced by sessions in 0.4'),
    liveList);
  const side = h('aside.chat-side', { 'aria-label': 'Chats' },
    h('div.side-head', h('h2', 'Chats'), h('button.btn.primary.small.new-chat-btn', { type: 'button', title: 'Start a new conversation', onclick: () => openNewChat() }, icon('plus'), 'New chat')),
    h('div.side-filter', icon('projects'), projectSelect),
    h('div.side-search', icon('search'), searchInput, h('kbd', 'Ctrl K')),
    h('nav.side-scroll', { 'aria-label': 'Conversations', onkeydown: onListKey }, sessionSection, mailSection, liveSection, searchEmpty));

  /* ---------- conversation ---------- */
  const head = h('header.chat-head');
  const heroArea = h('div.chat-hero-area');
  const log = h('div.chat-log', { role: 'log', 'aria-label': 'Messages', 'aria-relevant': 'additions' });
  const statusArea = h('div.chat-status-area');
  const scroller = h('div.chat-scroll', { onscroll: onScroll }, h('div.chat-column', heroArea, log, statusArea));
  const jumpLabel = h('span', 'Jump to latest');
  const jumpBtn = h('button.jump-latest', { type: 'button', hidden: true, onclick: () => scrollToBottom(true) }, jumpLabel, icon('arrowDown'));
  const chatBody = h('div.chat-body', scroller, jumpBtn);

  /* ---------- composer ---------- */
  const textarea = h('textarea.composer-input', { rows: 1, 'aria-label': 'Message', placeholder: 'Message…', oninput: onInput, onkeydown: onComposerKey, onpaste: onPaste });
  const replyChip = h('div.composer-reply', { hidden: true });
  const tray = h('div.attach-tray', { hidden: true, 'aria-label': 'Attachments' });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, tabindex: '-1', onchange: event => { addFiles([...event.currentTarget.files]); event.currentTarget.value = ''; } });
  const attachBtn = iconButton('paperclip', 'Attach files', () => fileInput.click(), 'composer-tool');
  const micBtn = iconButton('mic', 'Dictate', toggleDictation, 'composer-tool mic-btn');
  micBtn.setAttribute('aria-pressed', 'false');
  const subjectWrap = h('div.subject-chip-wrap');
  const needsBtn = h('button', { type: 'button', title: 'Ask for a reply (sent as a question)', onclick: () => setNeedsReply(true) }, 'Needs reply');
  const fyiBtn = h('button', { type: 'button', title: 'Just so they know (sent as a notice)', onclick: () => setNeedsReply(false) }, 'FYI');
  const kindToggle = h('div.segmented.kind-toggle', { role: 'group', 'aria-label': 'Message type' }, needsBtn, fyiBtn);
  const sendBtn = h('button.send-btn', { type: 'button', 'aria-label': 'Send message', title: 'Send (Enter)', disabled: true, onclick: () => send() }, icon('send'));
  const stopBtn = h('button.stop-btn', { type: 'button', 'aria-label': 'Stop the reply', title: 'Stop', hidden: true, onclick: event => {
    const info = threadInfo();
    if (info?.kind === 'session') { stopSessions(info.sessions.filter(s => sessions.running(s.id)), event.currentTarget); return; }
    const run = activeRun(state.threadId); if (run) stopRun(run.requestId, event.currentTarget);
  } }, icon('stop'));
  const composer = h('div.composer', replyChip, tray, textarea,
    h('div.composer-bar', h('div.composer-left', attachBtn, micBtn, subjectWrap, kindToggle), h('div.composer-right', sendBtn, stopBtn)),
    fileInput);
  const errorBox = h('div.composer-error', { hidden: true, role: 'alert' });
  const modeNote = h('div.composer-note');
  const composerWrap = h('footer.composer-wrap', { hidden: true }, errorBox, composer, modeNote);

  const dropOverlay = h('div.drop-overlay', { hidden: true, 'aria-hidden': 'true' },
    h('div.drop-card', icon('paperclip'), h('strong', 'Drop files to attach'), h('span', `Up to ${MAX_FILES} files, 25 MB each`)));
  const main = h('div.chat-main', head, chatBody, composerWrap, dropOverlay);
  const scrim = h('div.side-scrim', { onclick: () => setSide(false) });
  const resPanel = h('aside.chat-resources', { 'aria-label': 'Connected resources', hidden: true });
  const shell = h('div.chat', side, scrim, main, resPanel);
  root.append(shell);

  /* ---------- global listeners ---------- */
  store.on('change', schedule);
  sessions.on('change', schedule);
  resNarrow.addEventListener('change', () => { state.resOverlay = false; renderHead(true); renderResources(); });
  new ResizeObserver(() => { if (state.visible && state.atBottom && state.threadId) scroller.scrollTop = scroller.scrollHeight; }).observe(scroller);
  narrow.addEventListener('change', () => { if (!narrow.matches) state.sideOpen = false; applySide(); });
  window.addEventListener('focus', scheduleAck);
  document.addEventListener('visibilitychange', scheduleAck);
  document.addEventListener('keydown', event => {
    if (!state.visible || root.hidden || document.querySelector('dialog[open]')) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (narrow.matches) setSide(true); else if (state.sideCollapsed) { state.sideCollapsed = false; applySide(); }
      searchInput.focus(); searchInput.select();
    } else if (event.key === 'Escape' && state.sideOpen && narrow.matches) setSide(false);
    else if (event.key === 'Escape' && state.resOverlay && resNarrow.matches) { state.resOverlay = false; renderHead(); renderResources(); }
  });
  const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  main.addEventListener('dragenter', event => { if (!hasFiles(event)) return; event.preventDefault(); if (!state.threadId) return; state.dragDepth += 1; dropOverlay.hidden = false; });
  main.addEventListener('dragover', event => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = state.threadId ? 'copy' : 'none'; });
  main.addEventListener('dragleave', event => { if (!hasFiles(event)) return; state.dragDepth = Math.max(0, state.dragDepth - 1); if (!state.dragDepth) dropOverlay.hidden = true; });
  main.addEventListener('drop', event => {
    if (!hasFiles(event)) return;
    event.preventDefault(); state.dragDepth = 0; dropOverlay.hidden = true;
    if (!state.threadId) { toast('Open a chat first, then drop files to attach.'); return; }
    addFiles(Array.from(event.dataTransfer.files || []));
  });
  // Never let a stray drop navigate the window to the file.
  root.addEventListener('dragover', event => { if (hasFiles(event)) event.preventDefault(); });
  root.addEventListener('drop', event => { if (hasFiles(event)) event.preventDefault(); });

  /* ---------- rendering ---------- */
  function schedule() {
    if (!state.visible) { state.dirty = true; return; }
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => { state.raf = 0; renderAll(); });
  }

  function renderAll({ load = false } = {}) {
    state.dirty = false;
    if (state.threadId?.startsWith('live:') && !store.desktop.chats.threads[state.threadId]) { state.threadId = null; load = true; }
    root.classList.toggle('reduce-motion', Boolean(store.prefs.reducedMotion));
    markViewing();
    renderSidebar();
    renderHead();
    renderThread();
    updateComposer({ load });
    renderResources();
    syncTicker();
    scheduleAck();
  }

  /* ----- sessions → conversations ----- */
  const isSessionThread = id => Boolean(id) && (id.startsWith('sess:') || id.startsWith('pair:'));
  const threadIdFor = s => (s.sharedId ? `pair:${s.sharedId}` : `sess:${s.id}`);
  function conversations() {
    const map = new Map();
    for (const s of sessions.list) {
      const id = threadIdFor(s);
      if (!map.has(id)) map.set(id, { id, shared: Boolean(s.sharedId), sessions: [] });
      map.get(id).sessions.push(s);
    }
    return [...map.values()].map(finishConversation).sort((a, b) => b.lastAt - a.lastAt);
  }
  function conversation(id) {
    if (!isSessionThread(id)) return null;
    const list = sessions.list.filter(s => threadIdFor(s) === id);
    return list.length ? finishConversation({ id, shared: id.startsWith('pair:'), sessions: list }) : null;
  }
  function finishConversation(c) {
    c.sessions.sort((a, b) => (a.provider === 'claude' ? 0 : 1) - (b.provider === 'claude' ? 0 : 1));
    const first = c.sessions[0];
    c.title = first.title || (c.shared ? 'Shared thread' : `${providerLabel(first.provider, true)} session`);
    c.projectId = first.projectId; c.cwd = first.cwd; c.access = first.access === 'read' ? 'read' : 'full';
    c.lastAt = Math.max(0, ...c.sessions.map(s => eventMs(s.lastActivityAt) || eventMs(s.createdAt)));
    c.running = c.sessions.some(s => sessions.running(s.id));
    c.unread = c.sessions.some(s => sessions.unread.has(s.id));
    c.status = c.running ? 'running' : c.sessions.some(s => s.status === 'error') ? 'error' : c.sessions.every(s => s.status === 'stopped') ? 'stopped' : 'idle';
    c.project = store.project(c.projectId) || store.projects.find(p => p.path && samePath(p.path, c.cwd)) || null;
    return c;
  }

  function threadInfo(id = state.threadId) {
    if (!id) return null;
    if (isSessionThread(id)) {
      const conv = conversation(id);
      if (!conv) return null;
      const provider = conv.shared ? 'both' : conv.sessions[0].provider;
      return {
        id, kind: 'session', conv, shared: conv.shared, sessions: conv.sessions, provider, title: conv.title, name: conv.title,
        agentName: conv.shared ? 'Claude + Codex' : providerLabel(provider, true), look: sessionLook(conv.shared ? 'claude' : provider),
        status: dotStatus(conv.status), sessionStatus: conv.status, running: conv.running, project: conv.project, cwd: conv.cwd,
        workspace: shownPath(conv.cwd), access: conv.access,
      };
    }
    if (id.startsWith('live:')) {
      const raw = store.desktop.chats.threads[id];
      if (!raw) return null;
      const endpoint = store.board.endpoints.find(e => e.id === raw.endpointId) || null;
      const agentId = `endpoint:${raw.endpointId}`;
      const agent = store.agent(agentId) || null;
      const provider = endpoint?.agent || raw.provider || agent?.provider || 'other';
      const name = agent?.name || endpoint?.label || raw.endpointId;
      return {
        id, kind: 'live', title: raw.title || name, agentId, agent, provider, name, endpoint, endpointId: raw.endpointId,
        workspace: shownPath(endpoint?.workspace), status: activeRun(id) ? 'active' : 'idle', lastSeenAt: agent?.lastSeenAt || 0,
        look: agent?.look || agentAvatar(agentId, provider, name), missing: !endpoint && store.sync.ok,
      };
    }
    if (!id.startsWith('mail:')) return null;
    const address = id.slice(5);
    const agent = store.agents.find(a => a.kind === 'mailbox' && a.address === address) || null;
    const name = agent?.name || store.addressLabel(address);
    const provider = agent?.provider || providerOfName(address);
    return {
      id, kind: 'mailbox', title: name, agentId: agent?.id || address, agent, provider, name, address,
      status: agent?.status || 'offline', lastSeenAt: agent?.lastSeenAt || 0, look: agent?.look || agentAvatar(address, provider, name),
    };
  }

  function activeRun(id) {
    const raw = id && store.desktop.chats.threads[id];
    if (!raw) return null;
    for (let i = raw.messages.length - 1; i >= 0; i--) {
      const m = raw.messages[i];
      if (m.role === 'agent' && m.requestId) return TERMINAL.has(m.state) ? null : m;
    }
    return null;
  }

  function sessionState(s) {
    if (sessions.running(s.id)) return 'Working…';
    if (s.status === 'stopped') return 'Closed · sending resumes it';
    if (s.status === 'error') return 'Error · see the latest message';
    return 'Ready';
  }
  function statusText(info) {
    if (info.kind === 'session') {
      const where = info.project?.name || baseName(info.cwd);
      if (info.shared) return info.sessions.map(s => `${providerLabel(s.provider)}: ${sessionState(s)}`).join(' · ');
      return `${sessionState(info.sessions[0])}${where ? ` · ${where}` : ''}`;
    }
    if (info.kind === 'live') {
      if (activeRun(info.id)) return 'Finishing an earlier reply';
      return 'Earlier live chat · read only';
    }
    return `${STATUS_LABEL[info.status] || 'Powered down'} · ${info.lastSeenAt ? `seen ${timeAgo(info.lastSeenAt)}` : 'not seen yet'}`;
  }

  const providerPill = provider => (provider === 'claude' || provider === 'codex' ? pill(providerName(provider), provider) : pill('Agent', 'neutral'));

  function preserveFocus(container, fn) {
    const active = document.activeElement;
    const label = active && container.contains(active) ? active.getAttribute('aria-label') : null;
    fn();
    if (label) container.querySelector(`[aria-label="${CSS.escape(label)}"]`)?.focus({ preventScroll: true });
  }

  /* ----- sidebar ----- */
  function highlight(text, q) {
    const value = String(text || '');
    const i = q ? value.toLowerCase().indexOf(q) : -1;
    return i < 0 ? [value] : [value.slice(0, i), h('mark', value.slice(i, i + q.length)), value.slice(i + q.length)];
  }
  function snippetAround(text, q) {
    const plain = plainText(text, 4000);
    const i = plain.toLowerCase().indexOf(q);
    if (i < 0) return plainText(text, 90);
    const start = Math.max(0, i - 28);
    return `${start ? '…' : ''}${plain.slice(start, i + q.length + 60)}`;
  }

  /* Project dropdown: "All projects" plus every linked project; the choice is a top-level pref. */
  function filterProject() {
    const id = store.prefs.chatProject;
    return id ? store.project(id) || null : null;
  }
  function renderProjectSelect() {
    const options = [{ value: '', label: 'All projects' }, ...store.projects.map(p => ({ value: p.id, label: p.path ? p.name : `${p.name} (GitHub)` }))];
    const current = filterProject()?.id || '';
    const sig = JSON.stringify([options, current]);
    if (sig === state.projectSig) return;
    state.projectSig = sig;
    projectSelect.replaceChildren(...options.map(o => h('option', { value: o.value }, o.label)));
    projectSelect.value = current;
  }
  function inProject(project, { projectId, cwd, agentId, endpointId }) {
    if (!project) return true;
    if (projectId && (project.id === projectId || project.ids.includes(projectId))) return true;
    if (cwd && project.path && samePath(cwd, project.path)) return true;
    if (agentId) { const a = store.agent(agentId); if (a && (a.homeProjectId === project.id || a.currentProjectId === project.id)) return true; }
    if (endpointId) { const e = store.board.endpoints.find(x => x.id === endpointId); if (e?.workspace && project.path && samePath(e.workspace, project.path)) return true; }
    return false;
  }

  function renderSidebar() {
    renderProjectSelect();
    const q = state.search.trim().toLowerCase();
    const project = filterProject();
    const threads = store.threads();
    const mail = [], live = [], owned = [];
    for (const c of conversations()) {
      if (!inProject(project, { projectId: c.projectId, cwd: c.cwd })) continue;
      if (q && !`${c.title}\n${c.project?.name || ''}\n${c.cwd || ''}\n${c.sessions.map(s => s.provider).join(' ')}`.toLowerCase().includes(q)) continue;
      owned.push(sessionRowItem(c, q));
    }
    for (const t of threads) {
      if (!inProject(project, t.kind === 'live' ? { endpointId: String(t.agentId).replace(/^endpoint:/, '') } : { agentId: t.agentId })) continue;
      let snippet = '';
      if (q) {
        const agent = store.agent(t.agentId);
        const hay = `${t.title}\n${t.preview}\n${agent?.label || ''}\n${agent?.address || ''}`.toLowerCase();
        if (!hay.includes(q)) {
          const hit = store.threadMessages(t.id).findLast(m => `${m.subject || ''}\n${m.text || ''}`.toLowerCase().includes(q));
          if (!hit) continue;
          snippet = snippetAround(`${hit.subject ? `${hit.subject} — ` : ''}${hit.text || ''}`, q);
        }
      }
      (t.kind === 'live' ? live : mail).push(rowItem(t, snippet, q));
    }
    const focused = side.contains(document.activeElement) ? document.activeElement.dataset?.thread : null;
    const liveShown = state.liveOpen || Boolean(q) || live.some(item => item.key === state.threadId);
    reconcile(sessionList, owned, state.sessionRows);
    reconcile(mailList, mail, state.mailRows);
    reconcile(liveList, liveShown ? live : [], state.liveRows);
    if (focused && !side.contains(document.activeElement)) side.querySelector(`[data-thread="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    sessionCount.textContent = owned.length ? String(owned.length) : '';
    mailCount.textContent = mail.length ? String(mail.length) : '';
    liveCount.textContent = live.length ? String(live.length) : '';
    liveToggle.setAttribute('aria-expanded', String(liveShown));
    const loading = !store.sync.at && !threads.length;
    mailSkeleton.hidden = !loading || Boolean(q);
    mailEmpty.hidden = loading || Boolean(mail.length) || Boolean(q);
    mailEmpty.textContent = project && threads.some(t => t.kind === 'mailbox')
      ? `No desktop chats work on ${project.name} right now.`
      : 'No desktop chats on the board yet. They appear here once an agent registers a mailbox.';
    const emptySig = JSON.stringify([sessions.available, Boolean(project), owned.length, Boolean(q)]);
    if (sessionEmpty.dataset.sig !== emptySig) {
      sessionEmpty.dataset.sig = emptySig;
      sessionEmpty.replaceChildren(...(sessions.available === false
        ? [h('span', `${UNAVAILABLE_TEXT}.`), h('span.side-empty-sub', 'Desktop chats below still work.')]
        : sessions.available === null ? [h('span', 'Loading sessions…')]
          : [h('span', project ? 'No sessions in this project yet.' : 'No sessions yet.'), h('button.link-btn', { type: 'button', onclick: () => openNewChat() }, 'Start one')]));
    }
    sessionEmpty.hidden = Boolean(owned.length) || Boolean(q);
    sessionSection.hidden = Boolean(q) && !owned.length;
    mailSection.hidden = Boolean(q) && !mail.length;
    liveSection.hidden = !live.length;
    searchEmpty.hidden = !q || owned.length + mail.length + live.length > 0;
    if (!searchEmpty.hidden) searchEmpty.textContent = `No chats match “${state.search.trim()}”.`;
  }

  function pairPortraits(size, status) {
    const node = h('span.pair-portraits', portrait(sessionLook('claude'), { size, provider: 'claude' }), portrait(sessionLook('codex'), { size, provider: 'codex' }));
    if (status) node.append(ui.statusDot(status));
    return node;
  }
  function lastAgentText(c) {
    let best = null;
    for (const s of c.sessions) {
      const t = sessions.transcript(s.id);
      const last = t.items.findLast(x => x.kind === 'agent' && x.text.trim());
      if (last && (!best || last.at > best.at)) best = last;
    }
    return best ? `${c.shared ? `${providerLabel(best.provider)}: ` : ''}${plainText(best.text, 90)}` : '';
  }
  function sessionRowItem(c, q) {
    const selected = c.id === state.threadId;
    const d = state.drafts.get(c.id);
    const draftText = !selected && d?.text.trim() ? plainText(d.text, 70) : '';
    const who = c.shared ? 'Claude + Codex' : providerLabel(c.sessions[0].provider, true);
    const where = c.project?.name || baseName(c.cwd);
    const preview = c.running ? `${who} is working…` : lastAgentText(c) || `${who}${where ? ` · ${where}` : ''}`;
    const time = c.lastAt ? timeAgo(c.lastAt) : '';
    const status = dotStatus(c.status);
    const level = levelInfo(c.access);
    const sig = JSON.stringify([c.title, preview, time, c.unread, status, selected, draftText, q, c.shared, c.sessions[0].provider, c.access]);
    return {
      key: c.id, sig,
      build: () => {
        const tag = h(`span.acc-tag.${level.id}`, { title: `${level.long}: ${level.rule}` }, level.label);
        return h(`button.thread-row.session-row${selected ? '.selected' : ''}${c.unread ? '.unread' : ''}`, {
          type: 'button', 'aria-current': selected ? 'true' : null, dataset: { thread: c.id },
          title: `${c.title} — ${who}${where ? ` in ${where}` : ''} · ${level.long}`,
          onclick: () => select(c.id),
        },
        c.shared ? pairPortraits(24, status) : portrait(sessionLook(c.sessions[0].provider), { size: 36, provider: c.sessions[0].provider, status }),
        h('span.thread-text',
          h('span.thread-top', h('span.thread-title', highlight(c.title, q)), h('span.thread-time', time)),
          h('span.thread-bottom',
            draftText ? h('span.thread-preview', h('span.draft-tag', 'Draft: '), draftText) : h('span.thread-preview', preview),
            tag,
            c.unread ? h('span.unread-dot', { 'aria-label': 'New reply' }) : null)));
      },
    };
  }

  function rowItem(t, snippet, q) {
    const agent = store.agent(t.agentId);
    const endpoint = t.kind === 'live' ? store.board.endpoints.find(e => `endpoint:${e.id}` === t.agentId) : null;
    const name = agent?.name || endpoint?.label || t.title;
    const look = agent?.look || agentAvatar(t.agentId, t.provider, name);
    const selected = t.id === state.threadId;
    const d = state.drafts.get(t.id);
    const draftText = !selected && d?.text.trim() ? plainText(d.text, 70) : '';
    const preview = snippet || plainText(t.preview, 90);
    const time = t.lastAt ? timeAgo(t.lastAt) : '';
    const status = t.kind === 'mailbox' ? t.status : t.status === 'active' ? 'active' : undefined;
    const sig = JSON.stringify([t.title, preview, time, t.unread, status, selected, draftText, q, t.provider, name, JSON.stringify(look)]);
    return {
      key: t.id, sig,
      build: () => h(`button.thread-row${selected ? '.selected' : ''}${t.unread ? '.unread' : ''}`, {
        type: 'button', 'aria-current': selected ? 'true' : null, dataset: { thread: t.id },
        title: t.kind === 'live' ? `${t.title} — earlier live chat with ${name} (read only)` : `${name} — desktop chat · replies when it checks in. CodaClauda can't wake or stream this chat.`,
        onclick: () => select(t.id),
      },
      portrait(look, { size: 36, provider: t.provider, status }),
      h('span.thread-text',
        h('span.thread-top', h('span.thread-title', highlight(t.title, q)), h('span.thread-time', time)),
        h('span.thread-bottom',
          draftText ? h('span.thread-preview', h('span.draft-tag', 'Draft: '), draftText) : h('span.thread-preview', highlight(preview, q)),
          t.unread ? h('span.unread-badge', { 'aria-label': `${t.unread} unread` }, t.unread > 99 ? '99+' : String(t.unread)) : null))),
    };
  }

  function onSearchKey(event) {
    if (event.key === 'Escape' && searchInput.value) {
      event.preventDefault(); event.stopPropagation();
      searchInput.value = ''; state.search = ''; renderSidebar();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault(); side.querySelector('.thread-row')?.focus();
    } else if (event.key === 'Enter') {
      const first = side.querySelector('.thread-row');
      if (first) { event.preventDefault(); select(first.dataset.thread); }
    }
  }
  function onListKey(event) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = Array.from(side.querySelectorAll('.thread-row'));
    const index = rows.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) searchInput.focus(); else rows[Math.min(rows.length - 1, next)].focus();
  }

  const sideVisible = () => (narrow.matches ? state.sideOpen : !state.sideCollapsed);
  function setSide(open) { state.sideOpen = open; applySide(); }
  function toggleSide() {
    if (narrow.matches) { setSide(!state.sideOpen); if (state.sideOpen) requestAnimationFrame(() => searchInput.focus({ preventScroll: true })); }
    else { state.sideCollapsed = !state.sideCollapsed; applySide(); }
  }
  function applySide() {
    shell.classList.toggle('side-open', state.sideOpen && narrow.matches);
    shell.classList.toggle('side-collapsed', state.sideCollapsed && !narrow.matches);
    renderHead();
  }

  /* ----- header ----- */
  const resVisible = () => (resNarrow.matches ? state.resOverlay : state.resPinned);
  function toggleResources() {
    if (resNarrow.matches) state.resOverlay = !state.resOverlay; else state.resPinned = !state.resPinned;
    state.resSig = '';
    renderHead(); renderResources();
  }

  function renderHead() {
    const info = threadInfo();
    const chatFirst = Boolean(store.prefs.chatFirst);
    const sig = JSON.stringify(info ? [info.id, info.name, info.title, info.provider, info.status, statusText(info), JSON.stringify(info.look), info.kind, info.access, info.running] : 0) + sideVisible() + resVisible() + chatFirst;
    if (sig === state.headSig) return;
    state.headSig = sig;
    preserveFocus(head, () => {
      const toggle = iconButton('chat-sidebar', 'Toggle chat list', toggleSide, 'side-toggle');
      toggle.setAttribute('aria-expanded', String(sideVisible()));
      if (!info) {
        head.replaceChildren(toggle, h('div.head-text', h('div.head-title', h('strong.head-name', 'Chat')), h('div.head-sub', 'Pick a conversation or start a new one')),
          h('button.btn.small.gradient', { type: 'button', onclick: () => openNewChat() }, icon('plus'), 'New chat'));
        return;
      }
      if (info.kind === 'session') {
        const level = levelInfo(info.access);
        const res = iconButton('chat-panel', resVisible() ? 'Hide connected resources' : 'Show connected resources', toggleResources, 'res-toggle');
        res.setAttribute('aria-expanded', String(resVisible()));
        const accessPill = h(`span.mode-pill.access.${level.id}`, { tabindex: '0', title: `${level.long}: ${level.rule} Set when the session started. ${ACCESS_NOTE}` }, icon('shield'), h('b', level.label), h('span.mode-detail', '· CodaClauda session'));
        head.replaceChildren(
          toggle,
          info.shared ? pairPortraits(30, info.status) : portrait(info.look, { size: 38, provider: info.provider, status: info.status }),
          h('div.head-text',
            h('div.head-title', h('strong.head-name', { title: info.title }, info.title), ...(info.shared ? info.sessions.map(s => providerPill(s.provider)) : [providerPill(info.provider)])),
            h('div.head-sub', h('span.head-status', statusText(info)))),
          accessPill,
          h('div.head-actions', res, iconButton('power', info.shared ? 'Close both sessions' : 'Close session', () => confirmClose(info))));
        return;
      }
      const live = info.kind === 'live';
      head.replaceChildren(
        toggle,
        portrait(info.look, { size: 38, provider: info.provider, status: live ? (info.status === 'active' ? 'active' : undefined) : info.status }),
        h('div.head-text',
          h('div.head-title', h('strong.head-name', { title: info.agent?.label || info.name }, info.name), providerPill(info.provider)),
          h('div.head-sub', live && info.title !== info.name ? h('span.head-thread', info.title) : null, h('span.head-status', statusText(info)))),
        live
          ? h('span.mode-pill.live', { tabindex: '0', title: 'An earlier live chat from CodaClauda 0.3. Live chats were replaced by sessions; this one stays readable.' }, icon('clock'), h('b', 'Earlier live chat'), h('span.mode-detail', '· read only'))
          : h('span.mode-pill.mailbox', { tabindex: '0', title: "An existing desktop chat. Messages wait until it checks its inbox; its schedule may vary, and CodaClauda can't wake or stream it. A message is information, not permission." }, icon('clock'), h('b', 'Desktop chat'), h('span.mode-detail', '· replies when it checks in')),
        h('div.head-actions',
          chatFirst ? null : iconButton('city', 'Show in City', () => navigate('city', { focusAgent: info.agentId })),
          iconButton('agents', 'Agent details', () => navigate('agents', { agent: info.agentId })),
          live ? iconButton('trash', 'Delete chat', () => confirmDelete(info)) : null));
    });
  }

  /* ----- connected resources (sessions only): a right column, or a popover on narrow windows ----- */
  function renderResources() {
    const info = threadInfo();
    const show = info?.kind === 'session' && resVisible();
    shell.classList.toggle('has-res', Boolean(show) && !resNarrow.matches);
    shell.classList.toggle('res-overlay', Boolean(show) && resNarrow.matches);
    resPanel.hidden = !show;
    if (!show) { state.resSig = ''; return; }
    const project = info.project;
    const access = project ? store.projectAccess(project.id) : null;
    const sig = JSON.stringify([info.id, project?.id, project?.name, project?.path, project?.url, access?.level, access?.playwright, info.access,
      info.sessions.map(s => [s.id, s.provider, s.status, s.access, s.playwright, s.providerSessionId, s.threadId, s.cwd, sessions.running(s.id)])]);
    if (sig === state.resSig) return;
    state.resSig = sig;
    const block = (iconName, title, ...body) => h('section.res-block', h('h4', icon(iconName), title), ...body);
    const cwd = info.cwd || project?.path || '';
    const level = levelInfo(info.access);
    const levelPicker = project ? h('div.segmented.res-levels', { role: 'group', 'aria-label': `Access level for ${project.name}` }, LEVELS.map(l => h(`button.res-level.${l.id}`, {
      type: 'button', 'aria-pressed': String(access.level === l.id), title: l.rule,
      onclick: () => { if (store.projectAccess(project.id).level !== l.id) saveAccess(project, { level: l.id }, `${project.name}: ${l.long}. Applies to the next session started there.`); },
    }, l.label))) : null;
    const playwright = project ? h('label.switch', { title: 'Playwright MCP browser control' },
      h('input', { type: 'checkbox', checked: access.playwright, 'aria-label': `Browser control (Playwright) for ${project.name}`,
        onchange: event => saveAccess(project, { playwright: event.currentTarget.checked }, `Browser control ${event.currentTarget.checked ? 'on' : 'off'} for ${project.name}. Applies to the next session started there.`) }),
      h('span')) : null;
    const sessionCard = s => {
      const command = resumeCommand(s);
      const providerId = s.provider === 'claude' ? s.providerSessionId : s.threadId || s.providerSessionId;
      return h('section.res-block.res-session',
        h('h4', providerPill(s.provider), h('span.res-status', h(`span.status-dot.${dotStatus(sessions.running(s.id) ? 'running' : s.status)}`), SESSION_STATUS[sessions.running(s.id) ? 'running' : s.status] || s.status)),
        h('dl.res-facts',
          h('dt', 'Session ID'),
          h('dd', providerId ? h('code.res-id', { title: String(providerId) }, String(providerId)) : h('span.muted', 'Known after the first reply')),
          h('dt', 'Access'), h('dd', levelInfo(s.access).long),
          h('dt', 'Browser'), h('dd', s.playwright ? 'Playwright on' : 'Off')),
        h('div.res-actions',
          h('button.btn.small', { type: 'button', disabled: !command, title: command || 'Available after the first reply', onclick: () => copyText(command, 'Resume command copied') }, icon('terminal'), 'Copy resume command')));
    };
    preserveFocus(resPanel, () => resPanel.replaceChildren(
      h('header.res-head', h('h3', 'Connected resources'), iconButton('close', 'Hide connected resources', toggleResources, 'res-close')),
      block('folder', 'Workspace',
        cwd ? h('code.res-path', { title: shownPath(cwd) }, shownPath(cwd)) : h('p.muted', 'No folder recorded'),
        cwd ? h('div.res-actions', h('button.btn.small', { type: 'button', onclick: () => bridge.desktop.openExternal(cwd).catch(() => copyText(cwd, 'Path copied')) }, icon('folder'), 'Open folder'),
          h('button.btn.small.ghost', { type: 'button', onclick: () => copyText(shownPath(cwd), 'Path copied') }, icon('copy'), 'Copy path')) : null),
      project?.url || project?.repo ? block('github', 'GitHub',
        h('a.res-link', { href: project.url || `https://github.com/${project.repo.full_name}`, title: project.url || '' }, project.repo?.full_name || project.url)) : null,
      block('shield', 'Access',
        levelPicker || h('p', level.long),
        h('p.field-hint', `This chat runs with ${level.long.toLowerCase()} (${level.rule.toLowerCase().replace(/\.$/, '')}).`,
          project && access.level !== info.access ? h('strong.res-pending', ` ${project.name} is now ${levelInfo(access.level).long}: applies to the next session started there.`) : ' A change applies to the next session started in this project, not to this one.')),
      project ? block('external', 'Browser control',
        h('div.res-row', h('span', 'Playwright MCP'), playwright),
        h('p.field-hint', 'Lets agents drive a browser. Off by default; applies to the next session started in this project.')) : null,
      ...info.sessions.map(sessionCard),
      h('p.res-note', icon('alert'), h('span', "A session you open in a terminal with the resume command runs outside CodaClauda's access level and its stop and memory limits.")),
      h('div.res-actions.res-end', h('button.btn.small.ghost', { type: 'button', onclick: () => confirmClose(info) }, icon('power'), info.shared ? 'Close both sessions' : 'Close session'))));
  }
  async function saveAccess(project, patch, message) {
    try { await store.setProjectAccess(project.id, patch); toast(message, { kind: 'success', timeout: 4200 }); }
    catch (error) { toast(error?.message || String(error), { kind: 'error', timeout: 8000 }); }
    state.resSig = '';
    renderResources();
  }

  /* ----- conversation ----- */
  const nearBottom =() => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 72;

  function renderThread() {
    const id = state.threadId;
    const info = threadInfo(id);
    if (!id || !info) {
      if (state.renderedThread !== null) {
        log.replaceChildren(); statusArea.replaceChildren();
        state.msgCache = new Map(); state.renderedThread = null; state.bannerSig = '';
      }
      renderHero('home');
      jumpBtn.hidden = true;
      return;
    }
    const switched = state.renderedThread !== id;
    const wasBottom = switched || nearBottom();
    if (switched) {
      log.replaceChildren(); statusArea.replaceChildren();
      state.msgCache = new Map(); state.knownIds = new Set(); state.newCount = 0; state.bannerSig = ''; state.renderedThread = id;
    }
    if (info.kind === 'session') { renderSessionThread(info, { switched, wasBottom }); return; }
    const msgs = store.threadMessages(id);
    renderHero(msgs.length ? null : 'thread', info);

    const byId = new Map(msgs.map(m => [m.id, m]));
    const lookSig = JSON.stringify(info.look);
    const items = [];
    let prev = null, prevDay = '';
    for (const m of msgs) {
      const day = dayKey(m.at);
      const sameDay = day === prevDay;
      if (!sameDay) {
        const label = dayLabel(m.at);
        items.push({ key: `day:${day}`, sig: label, build: () => h('div.day-sep', { role: 'separator' }, h('span', label)) });
        prevDay = day;
      }
      if (m.id === state.firstUnread) items.push({ key: 'new-divider', sig: 'new', build: () => h('div.new-divider', { role: 'separator' }, h('span', 'New')) });
      const continued = Boolean(sameDay && prev && prev.role === m.role && prev.author === m.author && m.at - prev.at < GROUP_WINDOW && m.id !== state.firstUnread);
      const showSubject = info.kind === 'mailbox' && subjectVisible(m, prev, byId);
      const replyRef = info.kind === 'mailbox' ? replyRefFor(m, prev, byId) : null;
      items.push(messageItem(m, { info, continued, showSubject, replyRef, lookSig }));
      prev = m;
    }
    reconcile(log, items, state.msgCache);
    renderBanner(info, msgs);

    const fresh = msgs.filter(m => !state.knownIds.has(m.id));
    for (const m of fresh) state.knownIds.add(m.id);
    if (switched || state.restoreOnShow) restoreScroll(id);
    else if (state.forceBottom || wasBottom) scrollToBottom(false);
    else if (fresh.length) state.newCount += fresh.length;
    state.forceBottom = false;
    state.restoreOnShow = false;
    updateJump();
  }

  /* ----- session conversation: history from the display log, then live events ----- */
  function renderSessionThread(info, { switched, wasBottom }) {
    for (const s of info.sessions) sessions.load(s.id);
    const lists = info.sessions.map(s => sessions.transcript(s.id));
    const all = info.shared ? mergeShared(lists.map(l => l.items)) : lists[0].items;
    const loading = lists.some(l => l.state === 'loading' || l.state === 'none');
    const failed = lists.filter(l => l.state === 'error');
    renderHero(all.length || loading || failed.length ? null : 'thread', info);
    const items = [];
    if (loading && !all.length) items.push({ key: 'loading', sig: 'loading', build: () => h('div.msg-system', 'Loading the conversation…') });
    failed.forEach((l, i) => items.push({ key: `load-error:${i}`, sig: l.error, build: () => h('div.msg-callout.danger.session-callout', icon('alert'), h('div', h('strong', "Couldn't load this history. "), l.error)) }));
    let prev = null, prevDay = '';
    for (const item of all) {
      const day = dayKey(item.at);
      if (day !== prevDay) {
        const label = dayLabel(item.at);
        items.push({ key: `day:${day}`, sig: label, build: () => h('div.day-sep', { role: 'separator' }, h('span', label)) });
        prevDay = day; prev = null;
      }
      const continued = Boolean(prev && prev.kind === item.kind && (item.kind === 'agent' || item.kind === 'owner') && prev.provider === item.provider
        && item.at - prev.at < GROUP_WINDOW && (item.kind !== 'owner' || prev.targets.join() === item.targets.join()));
      items.push(sessionItem(item, { info, continued }));
      prev = item;
    }
    for (const s of info.sessions) {
      if (!sessions.running(s.id)) continue;
      const mine = all.filter(x => x.sessionId === s.id);
      if (mine.at(-1)?.kind === 'agent' && mine.at(-1).streaming) continue;
      const since = mine.findLast(x => x.kind === 'owner')?.at || 0;
      items.push({ key: `working:${s.id}`, sig: JSON.stringify([s.provider, since]), build: () => sessionWorkingRow(s, since) });
    }
    reconcile(log, items, state.msgCache);
    // Streamed text is updated in place, so a long reply is not rebuilt on every chunk.
    for (const item of all) {
      if (item.kind !== 'agent' || !item.streaming) continue;
      const node = state.msgCache.get(`s:${item.key}`)?.node?.querySelector('.stream-text');
      if (node && node.textContent !== item.text) node.textContent = item.text;
    }
    if (state.bannerSig) { statusArea.replaceChildren(); state.bannerSig = ''; }
    const fresh = all.filter(x => !state.knownIds.has(x.key));
    for (const x of fresh) state.knownIds.add(x.key);
    if (switched || state.restoreOnShow) restoreScroll(info.id);
    else if (state.forceBottom || wasBottom) scrollToBottom(false);
    else if (fresh.length) state.newCount += fresh.length;
    state.forceBottom = false;
    state.restoreOnShow = false;
    updateJump();
  }

  function sessionItem(item, opts) {
    const key = `s:${item.key}`;
    if (item.kind === 'agent' && item.streaming) return { key, sig: JSON.stringify(['stream', item.provider, opts.continued, opts.info.shared]), build: () => buildSessionAgent(item, opts) };
    const sig = JSON.stringify([item.kind, item.text, item.tools, item.targets, item.pending, Boolean(item.turnId), item.attachments, opts.continued, opts.info.shared, clockTime(item.at)]);
    const build = { owner: buildSessionOwner, agent: buildSessionAgent, tools: buildTools, error: buildSessionError }[item.kind] || buildSessionError;
    return { key, sig, build: () => build(item, opts) };
  }

  function buildSessionOwner(item, { info, continued }) {
    const m = { id: item.key, role: 'owner', text: item.text };
    const time = h('time.msg-time', { dateTime: isoTime(item.at), title: fullTime(item.at) }, clockTime(item.at));
    const to = info.shared ? h('span.msg-route', `To ${item.targets.length > 1 ? 'Claude + Codex' : providerLabel(item.targets[0])}`) : null;
    const status = item.pending && !item.turnId ? h('span.msg-status', icon('clock'), 'Sending…') : h('span.msg-status', icon('check'), 'Sent');
    return h(`article.msg.owner${continued ? '.continued' : ''}`, { dataset: { id: item.key } },
      h('div.msg-stack',
        h('div.bubble', item.text.trim() ? renderMarkdown(item.text) : h('p.msg-muted', '(attachments only)')),
        attachmentList(item.attachments),
        h('div.msg-meta', toolbar(m, info), to, time, status)));
  }

  function buildSessionAgent(item, { info, continued }) {
    const provider = item.provider;
    const time = h('time.msg-time', { dateTime: isoTime(item.at), title: fullTime(item.at) }, clockTime(item.at));
    const content = item.streaming
      ? h('div.stream-text', item.text)
      : item.text.trim() ? renderMarkdown(item.text) : h('p.msg-muted', '(empty message)');
    const m = { id: item.key, role: 'agent', text: item.streaming ? '' : item.text };
    return h(`article.msg.agent.session-msg${continued ? '.continued' : ''}${item.streaming ? '.running' : ''}`, { dataset: { id: item.key } },
      h('div.msg-avatar', continued ? h('time.msg-gutter-time', { title: fullTime(item.at) }, shortTime(item.at)) : portrait(sessionLook(provider), { size: 32, provider })),
      h('div.msg-main',
        continued ? null : h('div.msg-head', h('strong.msg-author', providerLabel(provider, true)), time, info.shared ? providerPill(provider) : null),
        h('div.msg-content', content),
        item.streaming ? null : h('div.msg-foot', toolbar(m, info))));
  }

  function buildTools(item) {
    const names = [...new Set(item.tools.map(t => t.name))];
    const details = h('details.tool-group', {
      open: state.openTools.has(item.key),
      ontoggle: event => { if (event.currentTarget.open) state.openTools.add(item.key); else state.openTools.delete(item.key); },
    },
    h('summary', icon('terminal'), h('span.tool-count', item.tools.length === 1 ? '1 tool call' : `${item.tools.length} tool calls`),
      h('span.tool-names', names.slice(0, 4).join(', ') + (names.length > 4 ? '…' : ''))),
    h('ol.tool-lines', item.tools.map(t => h('li', h('code.tool-name', t.name), t.summary ? h('span.tool-summary', String(t.summary).slice(0, 400)) : null))));
    return h('div.tool-row', { dataset: { id: item.key } }, details);
  }

  function buildSessionError(item, { info }) {
    return h('div.tool-row', { dataset: { id: item.key } },
      h('div.msg-callout.danger.session-callout', icon('alert'), h('div', info.shared ? h('strong', `${providerLabel(item.provider)}: `) : null, String(item.text || 'The session reported an error.'))));
  }

  function sessionWorkingRow(s, since) {
    return h('article.msg.agent.session-msg.running',
      h('div.msg-avatar', portrait(sessionLook(s.provider), { size: 32, provider: s.provider })),
      h('div.msg-main', h(`div.working-row.${s.provider}`,
        h('span.typing-dots', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        h('span.working-label', `${providerLabel(s.provider, true)} is working…`),
        since ? h('span.elapsed', { 'aria-hidden': 'true', dataset: { since: String(since) } }, elapsed(since)) : null,
        h('button.btn.small.ghost.stop-inline', { type: 'button', 'aria-label': `Stop ${providerLabel(s.provider)}`, onclick: event => stopSessions([s], event.currentTarget) }, icon('stop'), 'Stop'))));
  }

  function subjectVisible(m, prev, byId) {
    const subject = String(m.subject || '').trim();
    if (!subject || subject === '(no subject)') return false;
    const ref = (m.replyTo && byId.get(m.replyTo)) || prev;
    if (/^\s*(re|fwd?|fw)\s*:/i.test(subject) && ref && normSubject(ref.subject) === normSubject(subject)) return false;
    // Owner subjects default to the first line of the body; don't show the same words twice.
    const squash = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const core = squash(stripRe(subject).replace(/…$/, ''));
    return !(core && squash(String(m.text || '').slice(0, 400)).startsWith(core));
  }
  function replyRefFor(m, prev, byId) {
    if (!m.replyTo || (prev && prev.id === m.replyTo)) return null;
    const target = byId.get(m.replyTo) || store.messages?.get?.(m.replyTo);
    if (!target) return null;
    const subject = target.subject || '';
    const text = target.text ?? target.body ?? '';
    return { id: m.replyTo, label: `Reply to: ${stripRe(subject) || plainText(text, 60) || 'an earlier message'}` };
  }

  function messageItem(m, opts) {
    const { info, continued, showSubject, replyRef, lookSig } = opts;
    const sig = JSON.stringify([
      m.role, m.text, m.role === 'owner' || info.kind === 'live' ? m.status : '', m.state, m.subject, m.attachments, m.cost ?? null, m.kind,
      continued, showSubject, replyRef?.label, info.name, info.provider, info.kind, m.role === 'agent' ? lookSig : '', clockTime(m.at),
    ]);
    return { key: `m:${m.id}`, sig, build: () => buildMessage(m, opts) };
  }

  function buildMessage(m, { info, continued, showSubject, replyRef }) {
    if (m.role === 'system') return h('div.msg-system', { dataset: { id: m.id } }, plainText(m.text, 400));
    const time = h('time.msg-time', { dateTime: isoTime(m.at), title: fullTime(m.at) }, clockTime(m.at));
    const subject = showSubject ? h('div.msg-subject', m.subject) : null;
    const ref = replyRef ? h('button.msg-ref', { type: 'button', title: 'Show the message this replies to', onclick: () => revealMessage(replyRef.id) }, icon('reply'), h('span', replyRef.label)) : null;
    if (m.role === 'owner') {
      return h(`article.msg.owner${continued ? '.continued' : ''}`, { dataset: { id: m.id } },
        h('div.msg-stack', ref, subject,
          h('div.bubble', renderMarkdown(m.text)),
          attachmentList(m.attachments),
          h('div.msg-meta', toolbar(m, info), time, ownerStatus(m, info))));
    }
    const live = info.kind === 'live';
    const running = live && m.requestId && !TERMINAL.has(m.state);
    let content;
    if (running) content = workingRow(m, info);
    else if (live && (m.state === 'failed' || m.state === 'needs-owner')) {
      content = h(`div.msg-callout.${m.state === 'failed' ? 'danger' : 'warning'}`, icon('alert'),
        renderMarkdown(m.text?.trim() || (m.state === 'failed' ? 'The run failed before an answer was recorded.' : 'The run needs your attention.')));
    } else if (live && m.state === 'cancelled' && (!m.text?.trim() || /^_No answer was recorded\._$/.test(m.text.trim()))) {
      content = h('p.msg-muted', 'Stopped before an answer was recorded.');
    } else content = m.text?.trim() ? renderMarkdown(m.text) : h('p.msg-muted', '(empty message)');
    const badge = kindBadge(m, info);
    return h(`article.msg.agent${continued ? '.continued' : ''}${running ? '.running' : ''}`, { dataset: { id: m.id } },
      h('div.msg-avatar', continued ? h('time.msg-gutter-time', { title: fullTime(m.at) }, shortTime(m.at)) : portrait(info.look, { size: 32, provider: info.provider })),
      h('div.msg-main',
        continued ? null : h('div.msg-head', h('strong.msg-author', info.name), time, badge),
        ref, subject,
        h('div.msg-content', content),
        running ? null : h('div.msg-foot', toolbar(m, info), continued ? badge : null, liveStatus(m, info))));
  }

  function kindBadge(m, info) {
    if (info.kind !== 'mailbox') return null;
    if (m.kind === 'question') return pill('Asks you', 'warning');
    if (m.kind === 'claim') return pill(`Claimed ${m.raw?.resource || 'a resource'}`, 'accent');
    if (m.kind === 'release') return pill(`Released ${m.raw?.resource || 'a resource'}`, 'success');
    return null;
  }

  function ownerStatus(m, info) {
    if (info.kind === 'mailbox') {
      return m.status === 'seen'
        ? h('span.msg-status.seen', { title: m.raw?.read_at ? `Seen ${fullTime(m.raw.read_at)}` : 'Seen' }, icon('eye'), `Seen by ${info.name}`)
        : h('span.msg-status', { title: 'Saved on the shared board. The agent reads it at its next check-in.' }, icon('check'), 'Saved to board');
    }
    return h('span.msg-status', icon('check'), 'Sent');
  }

  function liveStatus(m, info) {
    if (info.kind !== 'live' || !m.requestId) return null;
    const map = { completed: ['Done', 'success', 'check'], failed: ['Failed', 'danger', 'alert'], cancelled: ['Cancelled', 'plain', 'stop'], 'needs-owner': ['Needs you', 'warning', 'alert'] };
    const [label, tone, iconName] = map[m.state] || ['Working…', 'plain', 'clock'];
    const cost = Number(m.cost);
    return h(`span.msg-status.${tone}`, icon(iconName), label, Number.isFinite(cost) && cost > 0 ? h('span.msg-cost', ` · $${cost.toFixed(cost < 0.1 ? 3 : 2)}`) : null);
  }

  function workingRow(m, info) {
    const who = info.provider === 'other' ? info.name : providerName(info.provider);
    const label = m.state === 'queued' ? `Queued — starting a fresh ${who} session…` : `${who} is working…`;
    return h(`div.working-row.${info.provider}`,
      h('span.typing-dots', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      h('span.working-label', label),
      h('span.elapsed', { 'aria-hidden': 'true', dataset: { since: String(m.at) } }, elapsed(m.at)),
      h('button.btn.small.ghost.stop-inline', { type: 'button', 'aria-label': 'Stop this reply', onclick: event => stopRun(m.requestId, event.currentTarget) }, icon('stop'), 'Stop'));
  }

  function toolbar(m, info) {
    const fromAgent = m.role === 'agent';
    const tools = [];
    if (m.text?.trim()) {
      tools.push(h(`button.tool-btn${fromAgent ? '.labelled' : ''}`, { type: 'button', title: 'Copy (Markdown)', 'aria-label': 'Copy message', onclick: event => copyWithFeedback(event.currentTarget, m.text, 'Copied') },
        icon('copy'), fromAgent ? h('span', 'Copy') : null));
      tools.push(h('button.tool-btn', { type: 'button', title: 'Copy as plain text', 'aria-label': 'Copy as plain text', onclick: event => copyWithFeedback(event.currentTarget, markdownToPlain(m.text), 'Copied as plain text') }, icon('chat-plain')));
    }
    if (fromAgent && info.kind === 'mailbox') {
      tools.push(h('button.tool-btn.labelled', { type: 'button', title: 'Reply to this message', 'aria-label': 'Reply to this message', onclick: () => startReply(m, info) }, icon('reply'), h('span', 'Reply')));
    }
    return tools.length ? h('div.msg-tools', { role: 'toolbar', 'aria-label': 'Message actions' }, tools) : null;
  }

  async function copyWithFeedback(button, text, label) {
    if (!(await copyText(text, label)) || button.classList.contains('copied')) return;
    const original = button.firstElementChild;
    if (!original) return;
    const check = icon('check');
    button.classList.add('copied');
    original.replaceWith(check);
    setTimeout(() => { button.classList.remove('copied'); check.replaceWith(original); }, 1500);
  }

  function attachmentList(list) {
    if (!list?.length) return null;
    return h('div.msg-attachments', list.map(a => h('button.msg-attachment', { type: 'button', title: `${a.path}\nOpen the containing folder`, onclick: () => openFolder(a.path) }, icon('file'), h('span', a.name))));
  }
  function openFolder(path) {
    const dir = String(path || '').replace(/[\\/][^\\/]*$/, '');
    bridge.desktop.openExternal(dir).catch(() => copyText(path, 'Path copied'));
  }

  function revealMessage(id) {
    const node = log.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!node) { toast('That message is in another conversation.'); return; }
    scroller.scrollTo({ top: scroller.scrollTop + node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 90, behavior: reduceMotion() ? 'auto' : 'smooth' });
    node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1700);
  }

  function renderBanner(info, msgs) {
    const last = msgs.at(-1);
    let sig = '';
    if (info.kind === 'mailbox' && last?.role === 'owner') sig = JSON.stringify([info.name, last.status, info.status, info.lastSeenAt ? timeAgo(info.lastSeenAt) : '']);
    if (info.kind === 'live') sig = 'live-read-only';
    if (sig === state.bannerSig) return;
    state.bannerSig = sig;
    if (!sig) { statusArea.replaceChildren(); return; }
    if (info.kind === 'live') {
      statusArea.replaceChildren(h('div.wait-banner', { role: 'status' },
        h('span.wait-icon', icon('clock')),
        h('div.wait-text',
          h('strong', 'An earlier live chat, kept readable'),
          h('p', 'Live chats were replaced by CodaClauda sessions in 0.4: replies stream, Stop interrupts, and a session resumes after a restart. Start one to keep going.'),
          h('button.btn.small.primary.wait-action', { type: 'button', onclick: () => openNewChat({ agent: info.provider === 'codex' ? 'codex' : 'claude' }) }, icon('plus'), 'Start a session'))));
      return;
    }
    const seen = last.status === 'seen';
    const offline = info.status === 'offline';
    statusArea.replaceChildren(h(`div.wait-banner${seen ? '.seen' : ''}`, { role: 'status' },
      h('span.wait-icon', icon(seen ? 'eye' : 'clock')),
      h('div.wait-text',
        h('strong', seen ? `${info.name} has seen your message` : `Waiting for ${info.name} to check the board`),
        h('p', seen
          ? "Their reply will appear here when they post it — you'll be notified."
          : "Messages wait until the agent checks its inbox. Its schedule may vary and sending doesn't wake it. You'll be notified here when it replies."),
        offline && !seen ? h('p.wait-extra', `${info.name} looks powered down${info.lastSeenAt ? ` (last seen ${timeAgo(info.lastSeenAt)})` : ''}. The message waits on the board until they're back.`) : null)));
  }

  function renderHero(mode, info) {
    let sig = '';
    let data = null;
    if (mode === 'home') {
      const mailAgents = store.agents.filter(a => a.kind === 'mailbox');
      const working = mailAgents.find(a => a.status === 'active') || mailAgents.find(a => a.status === 'idle') || mailAgents[0] || null;
      const active = store.agents.filter(a => a.status === 'active').length;
      const chatFirst = Boolean(store.prefs.chatFirst);
      data = { working, active, chatFirst, available: sessions.available };
      sig = JSON.stringify(['home', working?.address, working?.name, working?.status, active, chatFirst, sessions.available]);
    } else if (mode === 'thread') {
      sig = JSON.stringify(['thread', info.id, info.name, info.kind, info.provider, info.status, info.workspace, info.access, info.project?.name, JSON.stringify(info.look)]);
    }
    if (sig === state.heroSig) return;
    state.heroSig = sig;
    shell.classList.toggle('is-home', mode === 'home');
    preserveFocus(heroArea, () => heroArea.replaceChildren(...(mode === 'home' ? [buildHome(data)] : mode === 'thread' ? [buildIntro(info)] : [])));
  }

  function buildHome({ working, active, chatFirst, available }) {
    const card = ({ iconName, tone, title, text, run }) => h(`button.hero-card.${tone}`, { type: 'button', 'aria-label': title, onclick: run },
      h('span.hero-card-icon', icon(iconName)), h('span.hero-card-text', h('strong', title), h('span', text)), icon('arrowRight', 'hero-card-arrow'));
    const off = available === false ? UNAVAILABLE_TEXT : '';
    return h('div.chat-hero',
      h('div.hero-mark', icon('chat')),
      h('h1', 'Talk to your ', h('span.gradient-text', 'agents')),
      h('p.hero-lead', 'Start a Claude Code or Codex session that works in your project and streams its replies here, put both in one shared thread, or message an existing desktop chat. It replies when it next checks in.'),
      h('div.hero-grid',
        card({ iconName: 'bolt', tone: 'claude', title: 'Start a Claude Code session', text: off || 'Streams here · Stop any time · resumes after a restart', run: () => openNewChat({ agent: 'claude' }) }),
        card({ iconName: 'bolt', tone: 'codex', title: 'Start a Codex session', text: off || 'Streams here · Stop any time · resumes after a restart', run: () => openNewChat({ agent: 'codex' }) }),
        card({ iconName: 'agents', tone: 'accent', title: 'Both: shared project thread', text: off || 'Claude and Codex in one thread · @claude / @codex to pick', run: () => openNewChat({ agent: 'both' }) }),
        card({
          iconName: 'chat-inbox', tone: 'success', title: 'Ask a desktop chat for a status update',
          text: working ? `${working.name} · ${STATUS_LABEL[working.status] || ''}` : 'Pick a desktop chat to ask',
          run: () => { if (!working) { openNewChat(); return; } select(`mail:${working.address}`); prefill(STATUS_PROMPT); },
        }),
        chatFirst ? null : card({ iconName: 'city', tone: 'neutral', title: "See who's working in the City", text: active ? `${active} agent${active === 1 ? '' : 's'} working right now` : 'Walk the streets of your projects', run: () => navigate('city') })),
      h('p.hero-foot', 'A message is information, not permission — only you authorize actions. ', ACCESS_NOTE));
  }

  function buildIntro(info) {
    if (info.kind === 'session') {
      const level = levelInfo(info.access);
      const where = info.workspace ? [' in ', h('span.mono', info.workspace)] : '';
      return h('div.thread-intro',
        info.shared ? pairPortraits(56) : portrait(info.look, { size: 72, provider: info.provider }),
        h('h2', info.title),
        h('div.intro-mode', h(`span.acc-tag.${level.id}`, level.long), info.project ? pill(info.project.name, 'neutral') : null),
        h('p', info.shared
          ? ['Claude Code and Codex share this thread', where, '. Start a message with @claude or @codex to talk to one; otherwise both answer, and each one is told what the other said since it last spoke.']
          : [`${providerLabel(info.provider, true)} works`, where, ` with ${level.long.toLowerCase()} access. Replies stream here; Stop interrupts a turn and the session stays resumable.`]),
        h('div.intro-chips', (info.shared ? SHARED_STARTERS : SESSION_STARTERS).map(text => h('button.intro-chip', { type: 'button', onclick: () => prefill(text) }, text))));
    }
    const live = info.kind === 'live';
    return h('div.thread-intro',
      portrait(info.look, { size: 72, provider: info.provider, status: live ? undefined : info.status }),
      h('h2', info.name),
      h('div.intro-mode', live ? pill('Earlier live chat · read only', 'neutral') : pill(`Desktop chat · ${STATUS_LABEL[info.status] || 'Powered down'}`, info.status === 'active' ? 'success' : 'neutral')),
      h('p', live
        ? 'This live chat has no messages. Live chats were replaced by CodaClauda sessions; start a session from New chat.'
        : `${info.name} is an existing desktop chat. Your message is saved to the shared board and it waits until they check their inbox. Their schedule may vary and sending does not wake them.`),
      live ? null : h('div.intro-chips', MAIL_STARTERS.map(text => h('button.intro-chip', { type: 'button', onclick: () => prefill(text) }, text))));
  }

  /* ----- scrolling ----- */
  function onScroll() {
    state.atBottom = nearBottom();
    if (state.atBottom) state.newCount = 0;
    if (state.threadId && state.renderedThread === state.threadId) state.scroll.set(state.threadId, { top: scroller.scrollTop, bottom: state.atBottom });
    updateJump();
  }
  function updateJump() {
    const far = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 240;
    const show = Boolean(state.threadId) && !state.atBottom && (far || state.newCount > 0);
    jumpBtn.hidden = !show;
    jumpBtn.classList.toggle('has-new', state.newCount > 0);
    jumpLabel.textContent = state.newCount > 0 ? `Jump to latest (${state.newCount} new)` : 'Jump to latest';
  }
  function scrollToBottom(smooth) {
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth && !reduceMotion() ? 'smooth' : 'auto' });
    state.atBottom = true; state.newCount = 0;
    updateJump();
  }
  function restoreScroll(id) {
    const saved = state.scroll.get(id);
    const divider = log.querySelector('.new-divider');
    if (saved && !saved.bottom) scroller.scrollTop = saved.top;
    else if (divider && !saved) scroller.scrollTop += divider.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 80;
    else scroller.scrollTop = scroller.scrollHeight;
    state.atBottom = nearBottom();
  }
  function rememberScroll() {
    if (state.renderedThread && state.renderedThread === state.threadId) state.scroll.set(state.renderedThread, { top: scroller.scrollTop, bottom: nearBottom() });
  }
  const reduceMotion = () => Boolean(store.prefs.reducedMotion) || matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ----- live timers ----- */
  function syncTicker() {
    const need = state.visible && Boolean(log.querySelector('.elapsed[data-since]'));
    if (need && !state.ticker) state.ticker = setInterval(() => { for (const node of log.querySelectorAll('.elapsed[data-since]')) node.textContent = elapsed(Number(node.dataset.since)); }, 1000);
    else if (!need && state.ticker) { clearInterval(state.ticker); state.ticker = 0; }
  }

  /* ----- read receipts ----- */
  function scheduleAck() { clearTimeout(state.ackTimer); state.ackTimer = setTimeout(ackVisible, 700); }
  function ackVisible() {
    const id = state.threadId;
    if (!state.visible || root.hidden || !id?.startsWith('mail:')) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const ids = store.threadMessages(id).filter(m => m.role === 'agent' && !m.raw?.read_at && !state.acking.has(m.id)).map(m => m.id);
    if (!ids.length) return;
    ids.forEach(x => state.acking.add(x));
    store.ackOwner(ids).catch(() => {}).finally(() => ids.forEach(x => state.acking.delete(x)));
  }

  /* ---------- thread selection ---------- */
  function select(id, { focus = true } = {}) {
    if (id && id === state.threadId) { if (narrow.matches) setSide(false); if (focus) focusComposer(); return; }
    rememberScroll();
    stopDictation();
    state.threadId = id || null;
    state.subjectEditing = false;
    state.resOverlay = false;
    markViewing();
    state.firstUnread = id && !isSessionThread(id) ? store.threadMessages(id).find(m => m.role === 'agent' && m.status === 'unread')?.id || null : null;
    if (narrow.matches) state.sideOpen = false;
    applySide();
    renderAll({ load: true });
    if (focus && id) focusComposer();
  }

  function markViewing() {
    const info = state.visible && !root.hidden ? threadInfo() : null;
    sessions.view(info?.kind === 'session' ? info.sessions.map(s => s.id) : []);
  }

  function threadForAgent(agentId) {
    const agent = store.agent(agentId);
    if (agent?.kind === 'mailbox') return `mail:${agent.address}`;
    const endpointId = agent?.endpointId || (String(agentId).startsWith('endpoint:') ? String(agentId).slice(9) : null);
    if (endpointId) {
      // Live chats were replaced by sessions: open an earlier one if it exists, never make a new one.
      const existing = store.threads().find(t => t.kind === 'live' && t.agentId === `endpoint:${endpointId}`);
      return existing ? existing.id : null;
    }
    return `mail:${agentId}`;
  }

  const segmented = (items, current, onpick, label) => {
    const buttons = items.map(item => h('button', { type: 'button', 'aria-pressed': String(item.id === current), dataset: { id: item.id }, title: item.title || '', onclick: () => { for (const b of buttons) b.setAttribute('aria-pressed', String(b === buttons[items.indexOf(item)])); onpick(item.id); } }, item.label));
    return h('div.segmented', { role: 'group', 'aria-label': label }, buttons);
  };

  /** New chat: a CodaClauda session (Claude Code, Codex or both in one shared thread) or an existing desktop chat. */
  function openNewChat(preset = {}) {
    const mailAgents = store.agents.filter(a => a.kind === 'mailbox');
    const projects = store.projects;
    const filtered = filterProject();
    const pick = {
      agent: ['claude', 'codex', 'both'].includes(preset.agent) ? preset.agent : 'claude',
      projectId: (filtered?.path && filtered.id) || projects.find(p => p.path)?.id || '',
      title: '',
    };
    let dialog = null, starting = false;
    const row = (look, provider, status, title, sub, extra, run) => h('button.newchat-row', { type: 'button', onclick: () => { dialog?.close(); run(); } },
      portrait(look, { size: 36, provider, status }), h('span.newchat-text', h('strong', title), h('span', sub)), extra, icon('arrowRight', 'newchat-arrow'));

    const accessLine = h('div.newchat-access');
    const errorLine = h('p.newchat-error', { role: 'alert', hidden: true });
    const startBtn = h('button.btn.primary.newchat-start', { type: 'button', onclick: () => start() }, icon('play'), 'Start');
    const projectPicker = h('select.select', { 'aria-label': 'Project', onchange: event => { pick.projectId = event.currentTarget.value; refresh(); } },
      projects.map(p => h('option', { value: p.id, disabled: !p.path }, p.path ? p.name : `${p.name} · no local folder (clone it in Projects)`)));
    projectPicker.value = pick.projectId;
    const titleInput = h('input.input', { type: 'text', maxLength: 120, placeholder: 'Optional', 'aria-label': 'Title', oninput: event => { pick.title = event.currentTarget.value; },
      onkeydown: event => { if (event.key === 'Enter') { event.preventDefault(); start(); } } });
    function refresh() {
      const project = store.project(pick.projectId);
      const access = project ? store.projectAccess(project.id) : null;
      const level = levelInfo(access?.level);
      accessLine.replaceChildren(...(project
        ? [h(`span.acc-tag.${level.id}`, level.long), h('span', ` ${level.rule} Browser control (Playwright) ${access.playwright ? 'on' : 'off'}. Change both in the chat's resources panel or in Projects; a change applies to the next session.`)]
        : [h('span', 'Pick a project with a local folder.')]));
      startBtn.disabled = starting || sessions.available !== true || !project?.path;
    }
    async function start() {
      const project = store.project(pick.projectId);
      if (starting || sessions.available !== true || !project?.path) return;
      starting = true; errorLine.hidden = true; refresh();
      startBtn.replaceChildren(h('span.spinner'), 'Starting…');
      try {
        const id = await startConversation(pick.agent, project, pick.title.trim());
        dialog?.close();
        if (id) select(id);
      } catch (error) {
        errorLine.hidden = false; errorLine.textContent = `Couldn't start: ${error?.message || error}`;
      } finally {
        starting = false; startBtn.replaceChildren(icon('play'), 'Start'); refresh();
      }
    }

    const agentPicker = segmented([
      { id: 'claude', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
      { id: 'both', label: 'Both: shared thread', title: 'One Claude Code and one Codex session in one conversation' },
    ], pick.agent, id => { pick.agent = id; }, 'Agent');
    const localCount = projects.filter(p => p.path).length;
    const sessionBody = sessions.available === false
      ? h('div.newchat-empty', h('strong', `${UNAVAILABLE_TEXT}.`), h('span', 'This window has no session engine, so it can only message desktop chats.'), sessions.reason ? h('span.field-hint', sessions.reason) : null)
      : !localCount
        ? h('div.newchat-empty', h('span', 'Sessions run in a project folder on this PC. Link a folder or clone a repo first.'),
          h('button.btn.small', { type: 'button', onclick: () => { dialog?.close(); navigate('projects'); } }, icon('projects'), 'Open Projects'))
        : h('div.newchat-form',
          h('div.field', h('span', 'Agent'), agentPicker),
          h('label.field', h('span', 'Project'), projectPicker),
          h('label.field', h('span', 'Title'), titleInput),
          accessLine, errorLine,
          h('div.newchat-actions', startBtn));
    const sessionSection = h('section.newchat-section',
      h('header', h('h3', 'Start a CodaClauda session'), pill('Streams here', 'accent')),
      h('p.field-hint', 'Runs Claude Code or Codex in the project folder on your own subscription. Stop interrupts a turn; the session resumes after a restart.'),
      sessionBody);
    const mailboxSection = h('section.newchat-section',
      h('header', h('h3', 'Message an existing desktop chat'), pill('Async', 'neutral')),
      h('p.field-hint', "Saved to the shared board. The chat reads it when it next checks its inbox (schedules vary) and replies there. CodaClauda can't wake or stream it."),
      mailAgents.length
        ? h('div.newchat-list', mailAgents.map(a => row(a.look, a.provider, a.status, a.name, `${STATUS_LABEL[a.status] || ''} · ${a.lastSeenAt ? `seen ${timeAgo(a.lastSeenAt)}` : 'not seen yet'}`, providerPill(a.provider), () => select(`mail:${a.address}`))))
        : h('div.newchat-empty', 'No desktop chats have registered a mailbox yet. An agent appears here after it runs the mailbox register command from docs/MAILBOX.md.'));
    refresh();
    dialog = modal({ title: 'New chat', body: h('div.newchat', sessionSection, mailboxSection), actions: [{ label: 'Cancel', kind: 'ghost' }], wide: true });
    requestAnimationFrame(() => (dialog.querySelector('.newchat-form .segmented [aria-pressed="true"]') || dialog.querySelector('.newchat-row'))?.focus());
  }

  /** Starts one session, or two with one sharedId for "Both"; returns the thread id to open. */
  async function startConversation(agent, project, title) {
    const access = store.projectAccess(project.id);
    const base = { projectId: project.id, cwd: project.path, access: access.level, playwright: access.playwright };
    if (agent !== 'both') {
      const s = await sessions.start({ ...base, provider: agent, title: title || `${providerLabel(agent, true)} · ${project.name}` });
      return threadIdFor(s);
    }
    const sharedId = crypto.randomUUID();
    const results = await Promise.allSettled(['claude', 'codex'].map(provider => sessions.start({ ...base, provider, title: title || `${project.name} · shared thread`, sharedId })));
    const started = results.filter(r => r.status === 'fulfilled');
    const failed = results.map((r, i) => (r.status === 'rejected' ? `${providerLabel(i ? 'codex' : 'claude')}: ${r.reason?.message || r.reason}` : null)).filter(Boolean);
    if (!started.length) throw new Error(failed.join(' · '));
    if (failed.length) toast(`Only one agent started. ${failed.join(' · ')}`, { kind: 'error', timeout: 9000 });
    return `pair:${sharedId}`;
  }

  function confirmClose(info) {
    const both = info.sessions.length > 1;
    modal({
      title: both ? 'Close both sessions?' : 'Close this session?',
      body: `This ends the agent process${both ? 'es' : ''} now${info.running ? ' and stops the reply in progress' : ''}. The history stays here, and sending a new message resumes the session.`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: both ? 'Close both' : 'Close session', kind: 'danger', run: async () => {
          const results = await Promise.allSettled(info.sessions.map(s => sessions.close(s.id)));
          const failed = results.filter(r => r.status === 'rejected');
          if (failed.length) toast(`Couldn't close: ${failed[0].reason?.message || failed[0].reason}`, { kind: 'error' });
          else toast(both ? 'Both sessions closed' : 'Session closed', { kind: 'success', timeout: 2200 });
        } },
      ],
    });
  }

  async function stopSessions(list, button) {
    if (!list.length) return;
    if (button) button.disabled = true;
    const results = await Promise.allSettled(list.map(s => sessions.stop(s.id)));
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) { toast(`Couldn't stop: ${failed[0].reason?.message || failed[0].reason}`, { kind: 'error' }); if (button) button.disabled = false; }
    else toast('Stopping…', { timeout: 1800 });
  }

  function confirmDelete(info) {
    const run = activeRun(info.id);
    modal({
      title: 'Delete this live chat?',
      body: `“${info.title}” will be removed from this PC.${run ? ' The reply in progress will be stopped.' : ''} Finished runs keep their receipts on the board.`,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Delete chat', kind: 'danger', run: () => {
          if (run) store.cancelLive(run.requestId).catch(() => {});
          state.drafts.delete(info.id); state.scroll.delete(info.id);
          store.deleteLiveThread(info.id);
          select(null, { focus: false });
          toast('Live chat deleted', { kind: 'success', timeout: 2200 });
        } },
      ],
    });
  }

  /* ---------- composer ---------- */
  function draft(id = state.threadId) {
    if (!id) return null;
    let d = state.drafts.get(id);
    if (!d) { d = { text: '', subject: '', subjectEdited: false, needsReply: true, replyTo: null, files: [], error: null, pending: null }; state.drafts.set(id, d); }
    return d;
  }

  /** Single session: busy while its turn runs. Shared thread: busy only when every target of the draft is. */
  function sessionBusy(info, text = draft(info.id)?.text || '') {
    if (info?.kind !== 'session') return false;
    if (!info.shared) return sessions.running(info.sessions[0].id);
    const targets = info.sessions.filter(s => routeMessage(text).targets.includes(s.provider));
    return targets.length > 0 && targets.some(s => sessions.running(s.id));
  }
  function routeNote(info) {
    const route = routeMessage(draft(info.id)?.text || '');
    const present = new Set(info.sessions.map(s => s.provider));
    const to = route.targets.filter(t => present.has(t));
    const label = to.length > 1 ? 'Claude + Codex' : to.length ? providerLabel(to[0]) : 'nobody (that agent is not in this thread)';
    return `Sends to ${label}. ${ROUTE_HINT}`;
  }

  function updateComposer({ load = false } = {}) {
    const info = threadInfo();
    composerWrap.hidden = !info || info.kind === 'live';
    if (!info || info.kind === 'live') return;
    const d = draft();
    const mailbox = info.kind === 'mailbox';
    const session = info.kind === 'session';
    const sending = state.sending.has(info.id);
    if (load) {
      textarea.value = d.text;
      state.subjectEditing = false;
      renderTray(); renderReply(); renderError();
      autoGrow();
    }
    textarea.placeholder = session
      ? info.shared ? 'Message both, or start with @claude or @codex…' : `Message ${providerLabel(info.provider, true)}…`
      : `Message ${info.name}…`;
    textarea.readOnly = sending;
    composer.classList.toggle('is-sending', sending);
    kindToggle.hidden = !mailbox || Boolean(d.replyTo);
    needsBtn.setAttribute('aria-pressed', String(d.needsReply));
    fyiBtn.setAttribute('aria-pressed', String(!d.needsReply));
    subjectWrap.hidden = !mailbox;
    if (mailbox && !state.subjectEditing) refreshSubjectChip();
    const running = session && info.running;
    const busy = session && sessionBusy(info);
    sendBtn.hidden = Boolean(busy && !info.shared);
    stopBtn.hidden = !running;
    if (running && stopBtn.dataset.request !== info.id) { stopBtn.dataset.request = info.id; stopBtn.disabled = false; }
    if (!running) stopBtn.dataset.request = '';
    refreshSendState();
    const level = session ? levelInfo(info.access) : null;
    const note = mailbox
      ? `Saved to the shared board — ${info.name} reads it at their next inbox check (schedules vary; sending doesn't wake them). A message is information, not permission.`
      : info.shared ? routeNote(info)
        : running ? `${providerLabel(info.provider, true)} is answering — press Stop to interrupt. The session stays resumable.`
          : `${providerLabel(info.provider, true)}${info.project ? ` in ${info.project.name}` : ''} · ${level.long}${info.sessionStatus === 'stopped' ? ' · closed: sending resumes it' : ''}`;
    if (note !== state.noteSig) {
      state.noteSig = note;
      modeNote.replaceChildren(h(`span.note-text${info.shared ? '.route-hint' : ''}`, note), h('span.composer-keys', 'Enter to send · Shift+Enter for a new line'));
    }
  }

  function refreshSendState() {
    const d = draft();
    const sending = state.sending.has(state.threadId);
    const empty = !d || (!d.text.trim() && !d.files.length);
    sendBtn.disabled = empty || sending;
    const mode = sending ? 'sending' : 'idle';
    if (sendBtn.dataset.mode !== mode) {
      sendBtn.dataset.mode = mode;
      sendBtn.replaceChildren(sending ? h('span.spinner') : icon('send'));
      sendBtn.setAttribute('aria-label', sending ? 'Sending…' : 'Send message');
    }
    for (const button of tray.querySelectorAll('.attach-remove')) button.disabled = sending;
  }

  function autoGrow() {
    if (root.hidden || !main.clientHeight) return;
    const max = Math.max(96, Math.round(main.clientHeight * 0.4));
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, max)}px`;
    textarea.classList.toggle('scrolling', textarea.scrollHeight > max);
  }

  function focusComposer(toEnd = false) {
    if (composerWrap.hidden) return;
    textarea.focus({ preventScroll: true });
    if (toEnd) textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  function prefill(text) {
    const d = draft();
    if (!d) return;
    d.text = d.text.trim() ? `${d.text.replace(/\s+$/, '')}\n\n${text}` : text;
    textarea.value = d.text;
    d.longFile = undefined; d.longSaved = undefined;
    onDraftChanged();
    focusComposer(true);
  }

  function onInput() {
    const d = draft();
    if (!d) return;
    d.text = textarea.value;
    d.longFile = undefined; d.longSaved = undefined;
    onDraftChanged();
  }
  function onDraftChanged() {
    autoGrow();
    const info = threadInfo();
    if (!state.subjectEditing && info?.kind === 'mailbox') refreshSubjectChip();
    if (info?.kind === 'session') updateComposer(); else refreshSendState();
  }

  function onComposerKey(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing) {
      event.preventDefault();
      const info = threadInfo();
      if (info?.kind === 'session' ? sessionBusy(info) : activeRun(state.threadId)) { toast('A reply is still in progress — wait for it or press Stop.'); return; }
      send();
    } else if (event.key === 'Escape') {
      const d = draft();
      if (state.recording) { event.preventDefault(); stopDictation(); }
      else if (d?.replyTo) { event.preventDefault(); cancelReply(); }
      else if (d?.error) { event.preventDefault(); d.error = null; renderError(); }
    }
  }

  function setNeedsReply(value) {
    const d = draft();
    if (!d) return;
    d.needsReply = value;
    needsBtn.setAttribute('aria-pressed', String(value));
    fyiBtn.setAttribute('aria-pressed', String(!value));
  }

  /* subject */
  function autoSubject(text, files) {
    const line = String(text || '').split('\n').map(l => l.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, '').replace(/[*_`~]/g, '').trim()).find(Boolean) || '';
    if (line) return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
    if (files?.length) { const s = `Attachments: ${files.map(f => f.name).join(', ')}`; return s.length > 80 ? `${s.slice(0, 79)}…` : s; }
    return '';
  }
  function currentSubject(d) {
    if (d.subjectEdited && d.subject.trim()) return d.subject.trim().slice(0, 200);
    if (d.replyTo) return `Re: ${stripRe(d.replyTo.subject) || 'your message'}`.slice(0, 200);
    return autoSubject(d.text, d.files);
  }
  function refreshSubjectChip() {
    const d = draft();
    if (!d) return;
    const subject = currentSubject(d);
    const sig = JSON.stringify([subject, d.subjectEdited]);
    if (subjectWrap.dataset.sig === sig && subjectWrap.querySelector('.subject-chip')) return;
    subjectWrap.dataset.sig = sig;
    preserveFocus(subjectWrap, () => subjectWrap.replaceChildren(h(`button.subject-chip${subject ? '' : '.auto'}`, {
      type: 'button', title: 'Edit the subject line', 'aria-label': 'Edit subject', onclick: editSubject,
    }, h('span.subject-key', 'Subject'), h('span.subject-val', subject || 'first line of your message'), d.subjectEdited ? h('span.subject-flag', 'edited') : null)));
  }
  function editSubject() {
    const d = draft();
    if (!d) return;
    state.subjectEditing = true;
    const input = h('input.subject-input', {
      type: 'text', value: currentSubject(d), maxLength: 200, 'aria-label': 'Subject', placeholder: 'Subject',
      oninput: event => { d.subject = event.currentTarget.value; d.subjectEdited = true; },
      onkeydown: event => {
        if (event.key === 'Enter') { event.preventDefault(); textarea.focus(); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); d.subject = ''; d.subjectEdited = false; textarea.focus(); }
      },
      onblur: () => { state.subjectEditing = false; if (!d.subject.trim()) { d.subject = ''; d.subjectEdited = false; } refreshSubjectChip(); },
    });
    const reset = d.subjectEdited ? h('button.subject-reset', { type: 'button', title: 'Use the first line again', onmousedown: event => event.preventDefault(), onclick: () => { d.subject = ''; d.subjectEdited = false; input.value = currentSubject(d); input.focus(); } }, 'Auto') : null;
    subjectWrap.replaceChildren(h('span.subject-edit', h('span.subject-key', 'Subject'), input, reset));
    input.focus(); input.select();
  }

  /* reply */
  function startReply(m, info) {
    const d = draft();
    if (!d) return;
    d.replyTo = { id: m.id, subject: m.subject || '', author: info.name, preview: plainText(m.text, 80) };
    if (!d.subjectEdited) d.subject = '';
    renderReply(); updateComposer(); focusComposer(true);
  }
  function cancelReply() {
    const d = draft();
    if (!d) return;
    d.replyTo = null;
    renderReply(); updateComposer(); focusComposer();
  }
  function renderReply() {
    const d = draft();
    replyChip.hidden = !d?.replyTo;
    if (!d?.replyTo) { replyChip.replaceChildren(); return; }
    replyChip.replaceChildren(icon('reply'),
      h('span.reply-text', h('span.reply-label', 'Replying to '), h('strong', d.replyTo.author), h('span.reply-subject', ` · ${stripRe(d.replyTo.subject) || d.replyTo.preview}`)),
      iconButton('close', 'Cancel reply', cancelReply, 'reply-cancel'));
  }

  /* attachments */
  function addFiles(list) {
    const d = draft();
    if (!d) { toast('Open a chat first.'); return; }
    if (state.sending.has(state.threadId)) { toast('Wait for the current message to finish sending.'); return; }
    const problems = [];
    for (const file of list) {
      if (!file) continue;
      if (d.files.length >= MAX_FILES) { problems.push(`only ${MAX_FILES} files fit in one message`); break; }
      if (file.size > MAX_FILE_BYTES) { problems.push(`${file.name} is larger than 25 MB`); continue; }
      if (!file.size && !file.type && !extOf(file.name)) { problems.push(`${file.name || 'that item'} looks like a folder`); continue; }
      if (d.files.some(f => f.name === file.name && f.size === file.size && f.file.lastModified === file.lastModified)) continue;
      const entry = { id: crypto.randomUUID(), file, name: file.name || 'attachment', size: file.size, type: file.type || '', thumb: null, saved: null, state: '' };
      d.files.push(entry);
      if (/^image\//i.test(entry.type) && file.size <= THUMB_LIMIT) {
        readDataUrl(file).then(url => { if (/^data:image\//i.test(url)) { entry.thumb = url; if (draft() === d) renderTray(); } }).catch(() => {});
      }
    }
    if (problems.length) toast(`Couldn't attach: ${problems.join('; ')}.`, { kind: 'error', timeout: 6500 });
    renderTray(); onDraftChanged(); focusComposer();
  }
  function removeFile(id) {
    const d = draft();
    if (!d || state.sending.has(state.threadId)) return;
    d.files = d.files.filter(f => f.id !== id);
    renderTray(); onDraftChanged(); focusComposer();
  }
  function renderTray() {
    const files = draft()?.files || [];
    tray.hidden = !files.length;
    tray.replaceChildren(...files.map(entry => h(`div.attach-chip${entry.state ? `.${entry.state}` : ''}`, { title: `${entry.name} · ${formatBytes(entry.size)}` },
      entry.thumb ? h('img.attach-thumb', { src: entry.thumb, alt: '' }) : h('span.attach-icon', icon(/^image\//i.test(entry.type) ? 'image' : 'file'), h('span.attach-ext', extOf(entry.name).slice(0, 4))),
      h('span.attach-text', h('span.attach-name', entry.name),
        h('span.attach-size', entry.state === 'saving' ? 'Saving…' : entry.state === 'error' ? 'Not saved' : formatBytes(entry.size))),
      iconButton('close', `Remove ${entry.name}`, () => removeFile(entry.id), 'attach-remove'))));
    for (const button of tray.querySelectorAll('.attach-remove')) button.disabled = state.sending.has(state.threadId);
  }
  function onPaste(event) {
    const files = Array.from(event.clipboardData?.files || []);
    if (!files.length) return;
    if (!Array.from(event.clipboardData.types || []).includes('text/plain')) event.preventDefault();
    const when = stamp();
    addFiles(files.map((file, i) => {
      if (file.name && !/^image\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) return file;
      const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*$/, '');
      return new File([file], `pasted-${when}${i ? `-${i + 1}` : ''}.${ext}`, { type: file.type, lastModified: Date.now() });
    }));
  }

  /* error */
  function renderError() {
    const d = draft();
    errorBox.hidden = !d?.error;
    if (!d?.error) { errorBox.replaceChildren(); return; }
    errorBox.replaceChildren(icon('alert'),
      h('div.error-text', h('strong', "Couldn't send. "), d.error.message, h('span.error-safe', ' Your draft is safe.')),
      h('button.btn.small', { type: 'button', onclick: () => send() }, icon('refresh'), 'Retry'),
      iconButton('close', 'Dismiss error', () => { d.error = null; renderError(); }, 'error-close'));
  }

  /* ---------- sending ---------- */
  async function send() {
    const id = state.threadId;
    const info = threadInfo(id);
    const d = draft(id);
    if (!info || !d || state.sending.has(id)) return;
    const text = d.text.trim();
    if (!text && !d.files.length) { focusComposer(); return; }
    if (info.kind === 'live') { toast('Earlier live chats are read only. Start a session from New chat.'); return; }
    if (info.kind === 'session' && sessionBusy(info, text)) { toast('A reply is still in progress — wait for it or press Stop.'); return; }
    stopDictation();
    state.sending.add(id);
    d.error = null;
    renderError(); updateComposer();
    let ok = false;
    try {
      const saved = await saveFiles(d, id);
      if (info.kind === 'mailbox') await sendMailbox(info, d, text, saved);
      else await sendSession(info, text, saved);
      ok = true;
    } catch (error) {
      d.error = { message: error?.message || String(error || 'Unknown error') };
    } finally {
      state.sending.delete(id);
    }
    if (ok) Object.assign(d, { text: '', subject: '', subjectEdited: false, replyTo: null, files: [], pending: null, longFile: undefined, longSaved: undefined });
    if (state.threadId === id) {
      if (ok) state.forceBottom = true;
      updateComposer({ load: true });
      if (ok) focusComposer();
    }
    schedule();
  }

  async function saveFiles(d, id) {
    const out = [];
    for (const entry of d.files) {
      if (!entry.saved) {
        entry.state = 'saving';
        if (state.threadId === id) renderTray();
        try {
          const result = await store.saveAttachment(entry.file);
          entry.saved = { path: result.path, name: result.name || entry.name };
          entry.state = 'saved';
        } catch (error) {
          entry.state = 'error';
          if (state.threadId === id) renderTray();
          throw new Error(`Couldn't save ${entry.name}: ${error?.message || error}`);
        }
      }
      let text = null;
      if (isTextLike(entry) && entry.size <= TEXT_READ_LIMIT) {
        try { entry.text ??= await entry.file.text(); text = entry.text; } catch { text = null; }
      }
      out.push({ name: entry.saved.name, path: entry.saved.path, size: entry.size, text });
    }
    if (d.files.length && state.threadId === id) renderTray();
    return out;
  }

  function mailboxBody(text, saved) {
    let body = text;
    if (!saved.length) return body;
    body += `${body ? '\n\n' : ''}**Attachments:**\n${saved.map(a => `- \`${a.name}\` (${formatBytes(a.size)}) — saved at \`${a.path}\``).join('\n')}`;
    for (const a of saved) {
      if (a.text == null || byteLength(a.text) > INLINE_LIMIT) continue;
      const block = `\n\n\`${a.name}\`:\n${fenced(a.text, LANG_BY_EXT[extOf(a.name)] || extOf(a.name))}`;
      if (byteLength(body + block) < BODY_LIMIT) body += block;
    }
    return body;
  }

  async function sendMailbox(info, d, text, saved) {
    let body = mailboxBody(text, saved);
    if (byteLength(body) >= BODY_LIMIT) {
      // Too long for one board message: keep the full text as an attachment and post a preview.
      d.longFile ??= new File([text], `message-${stamp()}.md`, { type: 'text/markdown' });
      d.longSaved ??= await store.saveAttachment(d.longFile);
      const name = d.longSaved.name || d.longFile.name;
      const preview = `${text.slice(0, 3000).trimEnd()}\n\n… (the full message is in the attached file \`${name}\`)`;
      body = mailboxBody(preview, [{ name, path: d.longSaved.path, size: d.longFile.size, text: null }, ...saved.map(a => ({ ...a, text: null }))]);
    }
    const kind = d.replyTo ? 'reply' : d.needsReply ? 'question' : 'notice';
    const payload = { to: info.address, kind, subject: currentSubject(d) || 'Note', body, replyTo: d.replyTo?.id };
    const sig = JSON.stringify(payload);
    // A stable id per unchanged payload makes a retry idempotent on the board.
    if (d.pending?.sig !== sig) d.pending = { sig, id: `owner-${crypto.randomUUID()}` };
    await store.post({ ...payload, id: d.pending.id });
  }

  /** Sends to a session, or routes a shared-thread message (@claude / @codex / @both) and gives each
   *  target a short block of what the other agent said since it last spoke. */
  async function sendSession(info, text, saved) {
    const attachments = saved.map(a => ({ path: a.path, name: a.name }));
    const filesNote = saved.length ? `Please take a look at the attached file${saved.length > 1 ? 's' : ''}: ${saved.map(a => a.name).join(', ')}` : '';
    if (!info.shared) { await sessions.send(info.sessions[0].id, text || filesNote, attachments); return; }
    const route = routeMessage(text);
    const body = route.text || filesNote;
    if (!body) throw new Error('Write a message after the @mention.');
    const targets = info.sessions.filter(s => route.targets.includes(s.provider));
    if (!targets.length) throw new Error(`${providerLabel(route.mention)} isn't in this thread.`);
    const transcript = mergeShared(info.sessions.map(s => sessions.transcript(s.id).items));
    const results = await Promise.allSettled(targets.map(s => {
      const context = sharedContext(transcript, s.provider);
      return sessions.send(s.id, context ? `${context}\n\n${body}` : body, attachments);
    }));
    const failed = results.map((r, i) => (r.status === 'rejected' ? `${providerLabel(targets[i].provider)}: ${r.reason?.message || r.reason}` : null)).filter(Boolean);
    if (failed.length === targets.length) throw new Error(failed.join(' · '));
    if (failed.length) toast(`Not delivered to ${failed.join(' · ')}`, { kind: 'error', timeout: 9000 });
  }

  async function stopRun(requestId, button) {
    if (button) button.disabled = true;
    try { await store.cancelLive(requestId); toast('Stopping the reply…', { timeout: 2200 }); }
    catch (error) { toast(`Couldn't stop: ${error?.message || error}`, { kind: 'error' }); if (button) button.disabled = false; }
  }

  /* ---------- dictation ---------- */
  function setRecording(recording) {
    state.recording = recording;
    micBtn.classList.toggle('recording', Boolean(recording));
    micBtn.setAttribute('aria-pressed', String(Boolean(recording)));
    micBtn.title = recording ? 'Stop dictation' : 'Dictate';
  }
  const dictationHelp = () => toast('Press Win+H to dictate with Windows voice typing', { kind: 'info', timeout: 6500 });
  async function toggleDictation() {
    if (state.recording) { stopDictation(); return; }
    if (!state.threadId || composerWrap.hidden) return;
    textarea.focus();
    let result = null;
    try { result = await bridge.desktop.startDictation(); } catch { result = null; }
    if (result?.started) {
      setRecording({ kind: 'native', timer: setTimeout(stopDictation, 120e3) });
      toast('Windows voice typing is listening — speak now. Click the mic or press Esc when done.', { timeout: 3500 });
      return;
    }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { dictationHelp(); return; }
    let rec;
    try { rec = new Recognition(); } catch { dictationHelp(); return; }
    const base = textarea.value;
    let finals = '';
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = event => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finals += result[0].transcript; else interim += result[0].transcript;
      }
      const spoken = `${finals}${interim}`.trim();
      textarea.value = base && spoken ? `${base}${/\s$/.test(base) ? '' : ' '}${spoken}` : base || spoken;
      onInput();
    };
    rec.onerror = event => {
      if (state.recording?.rec === rec) setRecording(null);
      if (event.error !== 'aborted' && event.error !== 'no-speech') dictationHelp();
    };
    rec.onend = () => { if (state.recording?.rec === rec) setRecording(null); };
    try { rec.start(); setRecording({ kind: 'speech', rec }); } catch { dictationHelp(); }
  }
  function stopDictation() {
    const recording = state.recording;
    if (!recording) return;
    setRecording(null);
    if (recording.timer) clearTimeout(recording.timer);
    try { recording.rec?.stop(); } catch { /* already stopped */ }
  }

  /* ---------- view contract ---------- */
  function show(params = {}) {
    state.visible = true;
    state.restoreOnShow = true; // a hidden scroller can lose its offset; put it back from memory
    sessions.refresh();
    let target = null;
    if (params.thread) target = params.thread;
    else if (params.agentId || params.agent) target = threadForAgent(params.agentId || params.agent);
    if (target && target !== state.threadId) select(target, { focus: false });
    else renderAll({ load: state.renderedThread === undefined });
    if ((params.agentId || params.agent) && !target) openNewChat();
    autoGrow();
    if (typeof params.compose === 'string' && params.compose && state.threadId) prefill(params.compose);
    else if (state.threadId) requestAnimationFrame(() => { if (state.visible && !root.contains(document.activeElement)) focusComposer(); });
  }
  function hide() {
    rememberScroll();
    state.visible = false;
    sessions.view([]);
    stopDictation();
    syncTicker();
    state.dragDepth = 0;
    dropOverlay.hidden = true;
  }

  applySide();
  return { show, hide };
}
