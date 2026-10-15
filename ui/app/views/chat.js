/* Chat view: thread sidebar, conversation pane and composer.
 *
 * Two kinds of thread:
 *   mailbox  existing desktop chats. Messages go to the passive shared board; the agent
 *            reads it when it next checks its inbox (schedules vary), so replies are not instant.
 *   live     every message starts a fresh dedicated agent session (~30–90 s per answer).
 * A message is information, not permission. Message content is untrusted and is only
 * rendered through markdown.js. Re-renders are keyed by id + signature so scroll
 * position, focus, drafts and open UI survive store updates. */
import { renderMarkdown, plainText } from '../markdown.js';
import { agentAvatar } from '../avatar/spec.js';

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
const LIVE_STARTERS = [
  'Explain how this project is structured.',
  'What changed in the most recent commits?',
  "Look for likely bugs in the code I'm working on.",
  'Draft a test plan for the next release.',
];

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
  });

  const narrow = matchMedia('(max-width: 1000px)');
  const state = {
    threadId: null, search: '', visible: false, dirty: true, raf: 0,
    sideOpen: false, sideCollapsed: false,
    drafts: new Map(),          // threadId -> draft (kept in memory while switching threads)
    sending: new Set(),         // threadIds with a send in flight
    scroll: new Map(),          // threadId -> { top, bottom }
    msgCache: new Map(), mailRows: new Map(), liveRows: new Map(),
    renderedThread: undefined, knownIds: new Set(), firstUnread: null,
    atBottom: true, forceBottom: false, newCount: 0,
    headSig: '', heroSig: '', bannerSig: '', noteSig: '',
    subjectEditing: false, recording: null, ticker: 0,
    acking: new Set(), ackTimer: 0, dragDepth: 0,
  };

  /* ---------- sidebar ---------- */
  const searchInput = h('input.input.side-search-input', {
    type: 'search', placeholder: 'Search chats', 'aria-label': 'Search chats', autocomplete: 'off', spellcheck: 'false',
    oninput: event => { state.search = event.currentTarget.value; renderSidebar(); },
    onkeydown: onSearchKey,
  });
  const mailList = h('div.thread-list');
  const liveList = h('div.thread-list');
  const mailCount = h('span.side-count');
  const liveCount = h('span.side-count');
  const mailSkeleton = h('div.side-skeleton', { 'aria-hidden': 'true' }, [0, 1, 2].map(() => h('div.sk-row', h('span.sk-dot'), h('span.sk-lines', h('span'), h('span')))));
  const mailEmpty = h('div.side-empty', { hidden: true }, 'No desktop chats on the board yet. They appear here once an agent registers a mailbox.');
  const liveEmpty = h('div.side-empty', { hidden: true }, h('span', 'No live chats yet.'), h('button.link-btn', { type: 'button', onclick: () => openNewChat('live') }, 'Start one'));
  const searchEmpty = h('div.side-empty.search-empty', { hidden: true });
  const mailSection = h('section.side-section',
    h('header.side-section-head', h('span', 'Agent mailboxes'), mailCount),
    h('p.side-hint', 'Existing desktop chats · reply when they check in'),
    mailList, mailSkeleton, mailEmpty);
  const liveSection = h('section.side-section',
    h('header.side-section-head', h('span', 'Live chats'), liveCount, iconButton('plus', 'Start a live chat', () => openNewChat('live'), 'side-add')),
    h('p.side-hint', 'Fresh session per message · ~30–90 s'),
    liveList, liveEmpty);
  const side = h('aside.chat-side', { 'aria-label': 'Chats' },
    h('div.side-head', h('h2', 'Chats'), h('button.btn.primary.small.new-chat-btn', { type: 'button', title: 'Start a new conversation', onclick: () => openNewChat() }, icon('plus'), 'New chat')),
    h('div.side-search', icon('search'), searchInput, h('kbd', 'Ctrl K')),
    h('nav.side-scroll', { 'aria-label': 'Conversations', onkeydown: onListKey }, mailSection, liveSection, searchEmpty));

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
  const stopBtn = h('button.stop-btn', { type: 'button', 'aria-label': 'Stop the live reply', title: 'Stop', hidden: true, onclick: event => { const run = activeRun(state.threadId); if (run) stopRun(run.requestId, event.currentTarget); } }, icon('stop'));
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
  const shell = h('div.chat', side, scrim, main);
  root.append(shell);

  /* ---------- global listeners ---------- */
  store.on('change', schedule);
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
    renderSidebar();
    renderHead();
    renderThread();
    updateComposer({ load });
    syncTicker();
    scheduleAck();
  }

  function threadInfo(id = state.threadId) {
    if (!id) return null;
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

  function statusText(info) {
    if (info.kind === 'live') {
      if (activeRun(info.id)) return 'Working on your message';
      return info.missing ? 'This endpoint is no longer on the board' : 'Ready · starts a fresh session per message';
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

  function renderSidebar() {
    const q = state.search.trim().toLowerCase();
    const threads = store.threads();
    const mail = [], live = [];
    for (const t of threads) {
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
    reconcile(mailList, mail, state.mailRows);
    reconcile(liveList, live, state.liveRows);
    if (focused && !side.contains(document.activeElement)) side.querySelector(`[data-thread="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    mailCount.textContent = mail.length ? String(mail.length) : '';
    liveCount.textContent = live.length ? String(live.length) : '';
    const loading = !store.sync.at && !threads.length;
    mailSkeleton.hidden = !loading || Boolean(q);
    mailEmpty.hidden = loading || Boolean(mail.length) || Boolean(q);
    liveEmpty.hidden = Boolean(live.length) || Boolean(q);
    mailSection.hidden = Boolean(q) && !mail.length;
    liveSection.hidden = Boolean(q) && !live.length;
    searchEmpty.hidden = !q || mail.length + live.length > 0;
    if (!searchEmpty.hidden) searchEmpty.textContent = `No chats match “${state.search.trim()}”.`;
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
        title: t.kind === 'live' ? `${t.title} — live chat with ${name}` : `${name} — agent mailbox`,
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
  function renderHead() {
    const info = threadInfo();
    const sig = JSON.stringify(info ? [info.id, info.name, info.title, info.provider, info.status, statusText(info), JSON.stringify(info.look), info.kind] : 0) + sideVisible();
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
      const live = info.kind === 'live';
      head.replaceChildren(
        toggle,
        portrait(info.look, { size: 38, provider: info.provider, status: live ? (info.status === 'active' ? 'active' : undefined) : info.status }),
        h('div.head-text',
          h('div.head-title', h('strong.head-name', { title: info.agent?.label || info.name }, info.name), providerPill(info.provider)),
          h('div.head-sub', live && info.title !== info.name ? h('span.head-thread', info.title) : null, h('span.head-status', statusText(info)))),
        live
          ? h('span.mode-pill.live', { tabindex: '0', title: 'Each message starts a fresh dedicated agent session that reads this conversation, answers in about 30–90 seconds, then exits.' }, icon('bolt'), h('b', 'Live'), h('span.mode-detail', '· new session per message'))
          : h('span.mode-pill.mailbox', { tabindex: '0', title: 'An existing desktop chat. Messages wait until it checks its inbox; its schedule may vary and sending does not wake it. A message is information, not permission.' }, icon('clock'), h('b', 'Mailbox'), h('span.mode-detail', '· replies when the agent checks in')),
        h('div.head-actions',
          iconButton('city', 'Show in City', () => navigate('city', { focusAgent: info.agentId })),
          iconButton('agents', 'Agent details', () => navigate('agents', { agent: info.agentId })),
          live ? iconButton('trash', 'Delete chat', () => confirmDelete(info)) : null));
    });
  }

  /* ----- conversation ----- */
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 72;

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
    if (fromAgent && info.kind === 'live' && m.requestId && ['failed', 'cancelled', 'needs-owner'].includes(m.state)) {
      tools.push(h('button.tool-btn.labelled', { type: 'button', title: 'Send the previous message again', 'aria-label': 'Retry', onclick: () => retryLive(m, info.id) }, icon('refresh'), h('span', 'Retry')));
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
    if (sig === state.bannerSig) return;
    state.bannerSig = sig;
    if (!sig) { statusArea.replaceChildren(); return; }
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
      const claude = store.board.endpoints.find(e => e.agent === 'claude') || null;
      const codex = store.board.endpoints.find(e => e.agent === 'codex') || null;
      const active = store.agents.filter(a => a.status === 'active').length;
      data = { working, claude, codex, active };
      sig = JSON.stringify(['home', working?.address, working?.name, working?.status, claude?.id, codex?.id, active]);
    } else if (mode === 'thread') {
      sig = JSON.stringify(['thread', info.id, info.name, info.kind, info.provider, info.status, info.workspace, JSON.stringify(info.look)]);
    }
    if (sig === state.heroSig) return;
    state.heroSig = sig;
    shell.classList.toggle('is-home', mode === 'home');
    preserveFocus(heroArea, () => heroArea.replaceChildren(...(mode === 'home' ? [buildHome(data)] : mode === 'thread' ? [buildIntro(info)] : [])));
  }

  function buildHome({ working, claude, codex, active }) {
    const card = ({ iconName, tone, title, text, run }) => h(`button.hero-card.${tone}`, { type: 'button', 'aria-label': title, onclick: run },
      h('span.hero-card-icon', icon(iconName)), h('span.hero-card-text', h('strong', title), h('span', text)), icon('arrowRight', 'hero-card-arrow'));
    const liveCard = (endpoint, provider) => card({
      iconName: 'bolt', tone: provider, title: `Start a live chat with ${providerName(provider)}`,
      text: endpoint ? `Fresh ${provider === 'claude' ? 'Claude Code' : 'Codex'} session per message · ~30–90 s` : `Connect ${provider === 'claude' ? 'Claude Code' : 'Codex'} in Agent setup → Dedicated connections`,
      run: () => (endpoint ? startLive(endpoint.id) : navigate('settings')),
    });
    return h('div.chat-hero',
      h('div.hero-mark', icon('chat')),
      h('h1', 'Talk to your ', h('span.gradient-text', 'agents')),
      h('p.hero-lead', 'Message an existing desktop chat through the shared board — it replies when it next checks in — or start a live chat that spins up a fresh Claude or Codex session for every message.'),
      h('div.hero-grid',
        card({
          iconName: 'chat-inbox', tone: 'accent', title: 'Ask for a status update',
          text: working ? `${working.name} · ${STATUS_LABEL[working.status] || ''}` : 'Pick a desktop chat to ask',
          run: () => { if (!working) { openNewChat(); return; } select(`mail:${working.address}`); prefill(STATUS_PROMPT); },
        }),
        liveCard(claude, 'claude'),
        liveCard(codex, 'codex'),
        card({ iconName: 'city', tone: 'success', title: "See who's working in the City", text: active ? `${active} agent${active === 1 ? '' : 's'} working right now` : 'Walk the streets of your projects', run: () => navigate('city') })),
      h('p.hero-foot', 'A message is information, not permission — only you authorize actions.'));
  }

  function buildIntro(info) {
    const live = info.kind === 'live';
    const who = info.provider === 'other' ? info.name : providerName(info.provider);
    return h('div.thread-intro',
      portrait(info.look, { size: 72, provider: info.provider, status: live ? undefined : info.status }),
      h('h2', info.name),
      h('div.intro-mode', live ? pill('Live · ~30–90 s per reply', 'accent') : pill(`Mailbox · ${STATUS_LABEL[info.status] || 'Powered down'}`, info.status === 'active' ? 'success' : 'neutral')),
      h('p', live
        ? [`Each message starts a fresh ${who} session`, info.workspace ? [' in ', h('span.mono', info.workspace)] : '', '. It reads the recent conversation, answers in about 30–90 seconds, then exits.']
        : `${info.name} is an existing desktop chat. Your message is saved to the shared board and it waits until they check their inbox. Their schedule may vary and sending does not wake them.`),
      h('div.intro-chips', (live ? LIVE_STARTERS : MAIL_STARTERS).map(text => h('button.intro-chip', { type: 'button', onclick: () => prefill(text) }, text))));
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
    state.firstUnread = id ? store.threadMessages(id).find(m => m.role === 'agent' && m.status === 'unread')?.id || null : null;
    if (narrow.matches) state.sideOpen = false;
    applySide();
    renderAll({ load: true });
    if (focus && id) focusComposer();
  }

  function threadForAgent(agentId) {
    const agent = store.agent(agentId);
    if (agent?.kind === 'mailbox') return `mail:${agent.address}`;
    const endpointId = agent?.endpointId || (String(agentId).startsWith('endpoint:') ? String(agentId).slice(9) : null);
    if (endpointId) {
      const existing = store.threads().find(t => t.kind === 'live' && t.agentId === `endpoint:${endpointId}`);
      return existing ? existing.id : store.createLiveThread(endpointId);
    }
    return `mail:${agentId}`;
  }

  function startLive(endpointId) { select(store.createLiveThread(endpointId)); }

  function openNewChat(focus) {
    const mailAgents = store.agents.filter(a => a.kind === 'mailbox');
    const endpoints = store.board.endpoints;
    let dialog = null;
    const row = (look, provider, status, title, sub, extra, run) => h('button.newchat-row', { type: 'button', onclick: () => { dialog?.close(); run(); } },
      portrait(look, { size: 36, provider, status }), h('span.newchat-text', h('strong', title), h('span', sub)), extra, icon('arrowRight', 'newchat-arrow'));
    const mailboxSection = h('section.newchat-section',
      h('header', h('h3', 'Message an existing desktop chat'), pill('Async', 'neutral')),
      h('p.field-hint', 'Saved to the shared board. The chat reads it when it next checks its inbox (schedules vary) and replies there.'),
      mailAgents.length
        ? h('div.newchat-list', mailAgents.map(a => row(a.look, a.provider, a.status, a.name, `${STATUS_LABEL[a.status] || ''} · ${a.lastSeenAt ? `seen ${timeAgo(a.lastSeenAt)}` : 'not seen yet'}`, providerPill(a.provider), () => select(`mail:${a.address}`))))
        : h('div.newchat-empty', 'No desktop chats have registered a mailbox yet. An agent appears here after it runs the mailbox register command from docs/MAILBOX.md.'));
    const liveSectionNode = h('section.newchat-section',
      h('header', h('h3', 'Start a live chat'), pill('~30–90 s', 'accent')),
      h('p.field-hint', 'Each message starts a fresh dedicated session in the endpoint’s workspace, answers, then exits.'),
      endpoints.length
        ? h('div.newchat-list', endpoints.map(e => {
          const provider = e.agent === 'claude' || e.agent === 'codex' ? e.agent : 'other';
          const needsAuth = e.auth_status && e.auth_status !== 'authenticated';
          return row(store.agent(`endpoint:${e.id}`)?.look || agentAvatar(`endpoint:${e.id}`, provider, e.label || e.id), provider, undefined, e.label || e.id,
            `Fresh ${providerName(provider)} session per message, ~30–90 s${e.workspace ? ` · ${shownPath(e.workspace)}` : ''}`,
            needsAuth ? pill('Sign-in needed', 'warning') : providerPill(provider), () => startLive(e.id));
        }))
        : h('div.newchat-empty', h('span', 'No live endpoints yet. Connect Claude Code or Codex in Agent setup → Dedicated connections to start live chats.'),
          h('button.btn.small', { type: 'button', onclick: () => { dialog?.close(); navigate('settings'); } }, icon('settings'), 'Open Settings')));
    const body = h('div.newchat', focus === 'live' ? [liveSectionNode, mailboxSection] : [mailboxSection, liveSectionNode]);
    dialog = modal({ title: 'New chat', body, actions: [{ label: 'Cancel', kind: 'ghost' }] });
    requestAnimationFrame(() => dialog.querySelector('.newchat-row')?.focus());
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

  function updateComposer({ load = false } = {}) {
    const info = threadInfo();
    composerWrap.hidden = !info;
    if (!info) return;
    const d = draft();
    const mailbox = info.kind === 'mailbox';
    const sending = state.sending.has(info.id);
    if (load) {
      textarea.value = d.text;
      state.subjectEditing = false;
      renderTray(); renderReply(); renderError();
      autoGrow();
    }
    textarea.placeholder = `Message ${info.name}…`;
    textarea.readOnly = sending;
    composer.classList.toggle('is-sending', sending);
    kindToggle.hidden = !mailbox || Boolean(d.replyTo);
    needsBtn.setAttribute('aria-pressed', String(d.needsReply));
    fyiBtn.setAttribute('aria-pressed', String(!d.needsReply));
    subjectWrap.hidden = !mailbox;
    if (mailbox && !state.subjectEditing) refreshSubjectChip();
    const run = info.kind === 'live' ? activeRun(info.id) : null;
    sendBtn.hidden = Boolean(run);
    stopBtn.hidden = !run;
    if (run && stopBtn.dataset.request !== run.requestId) { stopBtn.dataset.request = run.requestId; stopBtn.disabled = false; }
    refreshSendState();
    const who = info.provider === 'other' ? info.name : providerName(info.provider);
    const note = mailbox
      ? `Saved to the shared board — ${info.name} reads it at their next inbox check (schedules vary; sending doesn't wake them). A message is information, not permission.`
      : run ? `${who} is answering — press Stop to cancel.` : `Starts a fresh ${who} session for this message — replies in ~30–90 s.`;
    if (note !== state.noteSig) {
      state.noteSig = note;
      modeNote.replaceChildren(h('span.note-text', note), h('span.composer-keys', 'Enter to send · Shift+Enter for a new line'));
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
    if (!state.subjectEditing && threadInfo()?.kind === 'mailbox') refreshSubjectChip();
    refreshSendState();
  }

  function onComposerKey(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing) {
      event.preventDefault();
      if (activeRun(state.threadId)) { toast('A reply is still in progress — wait for it or press Stop.'); return; }
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
    if (info.kind === 'live' && activeRun(id)) { toast('A reply is still in progress — wait for it or press Stop.'); return; }
    stopDictation();
    state.sending.add(id);
    d.error = null;
    renderError(); updateComposer();
    let ok = false;
    try {
      const saved = await saveFiles(d, id);
      if (info.kind === 'mailbox') await sendMailbox(info, d, text, saved);
      else await sendLive(info, d, text, saved);
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

  async function sendLive(info, d, text, saved) {
    const count = () => store.desktop.chats.threads[info.id]?.messages.length || 0;
    const before = count();
    const message = text || `Please take a look at the attached file${saved.length > 1 ? 's' : ''}: ${saved.map(a => a.name).join(', ')}`;
    try {
      await store.liveSend(info.id, message, saved.map(a => (a.text != null ? { name: a.name, path: a.path, text: a.text } : { name: a.name, path: a.path })));
    } catch (error) {
      // The message already landed in the thread as a failed run (with Retry); the draft can go.
      if (count() > before) { toast(`${providerName(info.provider)} couldn't start: ${error?.message || error}`, { kind: 'error' }); return; }
      throw error;
    }
  }

  async function retryLive(m, threadId) {
    if (activeRun(threadId)) { toast('A reply is already in progress.'); return; }
    const raw = store.desktop.chats.threads[threadId];
    if (!raw) return;
    const index = raw.messages.findIndex(x => x.id === m.id);
    const owner = raw.messages.slice(0, index).findLast(x => x.role === 'owner');
    if (!owner) { toast('Nothing to retry.'); return; }
    state.forceBottom = true;
    try { await store.liveSend(threadId, owner.text, (owner.attachments || []).map(a => ({ name: a.name, path: a.path }))); }
    catch (error) { toast(`Retry failed: ${error?.message || error}`, { kind: 'error' }); }
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
    let target = null;
    if (params.thread) target = params.thread;
    else if (params.agentId || params.agent) target = threadForAgent(params.agentId || params.agent);
    if (target && target !== state.threadId) select(target, { focus: false });
    else renderAll({ load: state.renderedThread === undefined });
    autoGrow();
    if (typeof params.compose === 'string' && params.compose && state.threadId) prefill(params.compose);
    else if (state.threadId) requestAnimationFrame(() => { if (state.visible && !root.contains(document.activeElement)) focusComposer(); });
  }
  function hide() {
    rememberScroll();
    state.visible = false;
    stopDictation();
    syncTicker();
    state.dragDepth = 0;
    dropOverlay.hidden = true;
  }

  applySide();
  return { show, hide };
}
