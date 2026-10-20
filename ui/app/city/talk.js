/* Talk mode for the City: the conversation panel docked on the right (a bottom sheet on narrow
 * windows) plus the pure staging math for the over-the-shoulder shot. The thread, composer and send
 * path mirror the Chat view (views/chat.js): a mailbox thread posts to the passive shared board and
 * the agent answers when it next checks its inbox; a live thread starts a fresh dedicated session per
 * message. A message is information, not permission. Message text is untrusted: it is only rendered
 * through markdown.js (or as plain text). */
import { h, icon, iconButton, toast, portrait, pill, clockTime, fullTime, timeAgo, formatBytes, STATUS_LABEL } from '../ui.js';
import { renderMarkdown, plainText } from '../markdown.js';
import { agentAvatar } from '../avatar/spec.js';

/* TALK-STAGE-BEGIN (pure: checked headless) */
/** Staging (island units): Ben stands `gap` in front of the agent; the camera sits `back` behind him
 *  and `side` off his right shoulder. A far-away Ben reappears `approach` short of his spot and walks in. */
export const STAGE = { gap: 2.4, back: 2.0, side: 1.5, approach: 3.2 };
const TRIES = [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4, 2, -2, Math.PI];
const inBox = (x, z, b) => x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1;
/** Where Ben stands to talk to an agent at a ({ x, z }, island space): `gap` from it on the side Ben
 * comes from (facing: a seated agent's yaw, so Ben stands in front of the bench), clear of every box
 * ({ x0, x1, z0, z1, low? }) and inside |x|, |z| <= limit, with room behind him for the camera (solid
 * boxes only; the camera pulls in when a wall is close). Returns { x, z, yaw, heading, back, side }: yaw
 * points from the agent to Ben (forward is (sin, cos)); heading is Ben's facing (toward the agent). */
export function talkSpot(a, from, { boxes = [], limit = Infinity, facing = null, gap = STAGE.gap, back = STAGE.back, side = STAGE.side } = {}) {
  const out = (x, z, margin = 0) => Math.abs(x) > limit + margin || Math.abs(z) > limit + margin;
  const solid = boxes.filter(b => !b.low);
  const base = Number.isFinite(facing) ? facing : Math.atan2(from.x - a.x, from.z - a.z) || 0;
  let fallback = null;
  for (const turn of TRIES) {
    const yaw = base + turn, ux = Math.sin(yaw), uz = Math.cos(yaw);
    const x = a.x + ux * gap, z = a.z + uz * gap;
    if (out(x, z) || boxes.some(b => inBox(x, z, b))) continue;
    for (const k of [1, 0.75, 0.5]) {
      const cx = x + ux * back * k + uz * side, cz = z + uz * back * k - ux * side;   // behind Ben, off his right shoulder
      if (!out(cx, cz, 6) && !solid.some(b => inBox(cx, cz, b))) return { x, z, yaw, heading: yaw + Math.PI, back: back * k, side };
    }
    fallback ||= { x, z, yaw, heading: yaw + Math.PI, back: back * 0.5, side };
  }
  return fallback || { x: a.x + Math.sin(base) * gap, z: a.z + Math.cos(base) * gap, yaw: base, heading: base + Math.PI, back: back * 0.5, side };
}
/** The over-the-shoulder shot for a spot (talkSpot): the eye behind Ben's right shoulder at height
 * eyeY, looking past him at the agent's face ({ x, y, z }) so the face lands at (nx, ny) in normalized
 * device coordinates (the part of the canvas the chat panel leaves free). vfov in degrees, aspect =
 * width / height. Returns { eye, look } in island space. */
export function talkShot(spot, face, { eyeY = 1.5, nx = 0, ny = 0, vfov = 40, aspect = 1.6, side = spot.side ?? STAGE.side } = {}) {
  const ux = Math.sin(spot.yaw), uz = Math.cos(spot.yaw);
  const eye = { x: spot.x + ux * spot.back + uz * side, y: eyeY, z: spot.z + uz * spot.back - ux * side };
  const dx = face.x - eye.x, dy = face.y - eye.y, dz = face.z - eye.z, flat = Math.hypot(dx, dz) || 1e-6, dist = Math.hypot(flat, dy);
  const tv = Math.tan(vfov * Math.PI / 360), th = tv * aspect;
  const yaw = Math.atan2(dx, dz) + Math.atan(nx * th);       // turn right (yaw down) to put the face left of centre
  const pitch = Math.atan2(dy, flat) - Math.atan(ny * tv);   // and down to put it above centre
  return { eye, look: { x: eye.x + Math.sin(yaw) * Math.cos(pitch) * dist, y: eye.y + Math.sin(pitch) * dist, z: eye.z + Math.cos(yaw) * Math.cos(pitch) * dist } };
}
/* TALK-STAGE-END */

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'needs-owner']);
const BODY_LIMIT = 30 * 1000;   // the board caps bodies at 32 KiB; stay below 30 KB (as Chat does)
const SHOWN = 60;               // most recent messages in the panel; Chat has the rest
const PROVIDER_NAME = { claude: 'Claude', codex: 'Codex' };
const MAIL_STARTERS = ['What are you working on right now?', 'Is anything blocked that I can help with?', "Give me a short summary of today's progress."];
const LIVE_STARTERS = ['Explain how this project is structured.', 'What changed in the most recent commits?', 'Draft a test plan for the next release.'];
const providerName = provider => PROVIDER_NAME[provider] || 'Agent';
const providerOfName = name => (/^claude/i.test(name) ? 'claude' : /^codex/i.test(name) ? 'codex' : 'other');
const byteLength = text => new TextEncoder().encode(String(text)).length;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const isoTime = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : '');
/** Subject from the first line of a message (as Chat's automatic subject). */
function autoSubject(text) {
  const line = String(text || '').split('\n').map(l => l.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, '').replace(/[*_`~]/g, '').trim()).find(Boolean) || '';
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}
/** A short spoken line for an in-world speech bubble: the first line of prose (code and math left out). */
export function sayLine(text, limit = 110) {
  const prose = String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/\$[^$\n]+\$/g, '…');
  return prose.split('\n').map(line => plainText(line, limit)).find(Boolean) || plainText(text, limit);
}

/** The conversation panel. Callbacks: onLeave(), onSent(text), onAgentLine(text) when an agent reply
 * lands while it is open, onThinking(on) while a live reply is being written. */
export class TalkPanel {
  constructor({ store, navigate, onLeave, onSent, onAgentLine, onThinking }) {
    Object.assign(this, { store, navigate, onLeave, onSent, onAgentLine, onThinking });
    this.agent = null;
    this.drafts = new Map();   // agent id -> { text, error, pending, sending, longFile, longSaved }
    this.cache = new Map();    // message id -> { node, sig }
    this.heard = new Set();
    this.head = h('header.city-talk-head');
    this.mode = h('div.city-talk-mode');
    this.log = h('div.city-talk-log');
    this.status = h('div.city-talk-status', { role: 'status' });
    this.scroller = h('div.city-talk-scroll', { role: 'log', 'aria-label': 'Conversation', 'aria-relevant': 'additions' }, this.log, this.status);
    this.input = h('textarea.city-talk-input', { rows: 1, 'aria-label': 'Message', placeholder: 'Message…', oninput: () => this.onInput(), onkeydown: event => this.onKey(event) });
    this.sendBtn = h('button.city-talk-send', { type: 'button', 'aria-label': 'Send message', title: 'Send (Enter)', disabled: true, onclick: () => this.send() }, icon('send'));
    this.stopBtn = h('button.city-talk-stop', { type: 'button', 'aria-label': 'Stop the live reply', title: 'Stop', hidden: true, onclick: event => { const run = this.activeRun(); if (run) this.stop(run.requestId, event.currentTarget); } }, icon('stop'));
    this.error = h('div.city-talk-error', { hidden: true, role: 'alert' });
    this.note = h('p.city-talk-note');
    this.composer = h('footer.city-talk-composer', this.error, h('div.city-talk-box', this.input, this.sendBtn, this.stopBtn), this.note);
    this.node = h('aside.city-talk', { hidden: true, 'aria-label': 'Conversation' }, this.head, this.mode, this.scroller, this.composer);
  }
  get isOpen() { return Boolean(this.agent); }

  /** Open the conversation with an agent (a store agent record; kept as a snapshot if it leaves the board). */
  open(agent) {
    this.agent = { ...agent };
    this.thread = this.pickThread(agent);
    this.cache.clear(); this.log.replaceChildren(); this.heard.clear(); this.primed = false; this.thinking = false;
    this.sigs = { head: '', mode: '', status: '', note: '' };
    this.node.hidden = false;
    this.input.value = this.draft().text;
    this.refresh({ bottom: true });
    this.autoGrow();
    this.node.setAttribute('aria-label', `Conversation with ${this.agent.name}`);
  }
  close() {
    this.agent = null; this.thread = null;
    this.node.hidden = true;
    clearTimeout(this.ackTimer);
    this.cache.clear(); this.log.replaceChildren();
  }
  focus() { if (this.isOpen) this.input.focus({ preventScroll: true }); }

  /** The thread the Chat view would pick for this agent: mail:<address>, or the agent's most recent
   *  live thread (none yet: Chat makes one; here it is made on the first send). */
  pickThread(agent) {
    if (agent.kind === 'mailbox' && agent.address) return { kind: 'mailbox', id: `mail:${agent.address}`, address: agent.address };
    const endpointId = agent.endpointId || (String(agent.id).startsWith('endpoint:') ? String(agent.id).slice(9) : null);
    if (endpointId) {
      const existing = this.store.threads().find(t => t.kind === 'live' && t.agentId === `endpoint:${endpointId}`);
      return { kind: 'live', id: existing?.id || null, endpointId };
    }
    return { kind: 'mailbox', id: `mail:${agent.id}`, address: agent.id };
  }
  /** Thread facts (mirrors Chat's threadInfo). */
  info() {
    const t = this.thread, store = this.store;
    if (!t) return null;
    const agent = store.agent(this.agent.id) || this.agent;
    if (t.kind === 'live') {
      if (t.id && !store.desktop.chats.threads[t.id]) t.id = null;   // deleted in Chat
      const endpoint = store.board.endpoints.find(e => e.id === t.endpointId) || null;
      const provider = endpoint?.agent || agent.provider || 'other';
      const name = agent.name || endpoint?.label || t.endpointId;
      return { kind: 'live', id: t.id, endpointId: t.endpointId, agent, endpoint, provider, name, look: agent.look || agentAvatar(agent.id, provider, name), missing: !endpoint && store.sync.ok };
    }
    const provider = agent.provider || providerOfName(t.address);
    const name = agent.name || store.addressLabel(t.address);
    return { kind: 'mailbox', id: t.id, address: t.address, agent, provider, name, look: agent.look || agentAvatar(t.address, provider, name), status: agent.status || 'offline', lastSeenAt: agent.lastSeenAt || 0 };
  }
  activeRun(id = this.thread?.id) {
    const raw = id && this.store.desktop.chats.threads[id];
    if (!raw) return null;
    for (let i = raw.messages.length - 1; i >= 0; i--) { const m = raw.messages[i]; if (m.role === 'agent' && m.requestId) return TERMINAL.has(m.state) ? null : m; }
    return null;
  }
  draft() {
    const who = this.agent?.id || '';
    let d = this.drafts.get(who);
    if (!d) { d = { text: '', error: null, pending: null, sending: false }; this.drafts.set(who, d); }
    return d;
  }

  /* ---------- rendering ---------- */
  /** Re-render from the store (on every change event while open). */
  refresh({ bottom = false } = {}) {
    const info = this.info();
    if (!info) return;
    const msgs = info.id ? this.store.threadMessages(info.id) : [];
    const atBottom = bottom || this.forceBottom || this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 80;
    this.renderHead(info);
    this.renderMessages(info, msgs);
    this.renderStatus(info, msgs);
    this.renderComposer(info);
    if (atBottom) this.scroller.scrollTop = this.scroller.scrollHeight;
    this.forceBottom = false;
    this.listen(info, msgs);
    this.scheduleAck(info);
  }
  renderHead(info) {
    const agent = info.agent, project = this.store.project(agent.currentProjectId);
    const status = info.kind === 'live' ? (this.activeRun(info.id) ? 'active' : agent.status) : info.status;
    const sub = `${STATUS_LABEL[status] || 'Powered down'}${project && status !== 'offline' ? ` · ${project.name}` : project ? ` · home: ${project.name}` : ''}`;
    const sig = JSON.stringify([info.name, info.provider, status, sub, info.look, info.id, info.kind]);
    if (sig !== this.sigs.head) {
      this.sigs.head = sig;
      const chat = h('button.btn.small.city-talk-open', { type: 'button', title: 'Open this conversation in Chat', onclick: () => this.navigate('chat', info.id ? { thread: info.id } : { agentId: agent.id }) }, icon('chat'), 'Open in Chat');
      this.head.replaceChildren(
        portrait(info.look, { size: 46, provider: info.provider, status }),
        h('div.city-talk-title', h('h2', { title: agent.label || info.name }, info.name), h('p', sub)),
        h('div.city-talk-actions', chat, iconButton('close', 'Leave conversation (Esc)', () => this.onLeave?.())));
    }
    const live = info.kind === 'live';
    const modeSig = `${live}|${info.missing}`;
    if (modeSig !== this.sigs.mode) {
      this.sigs.mode = modeSig;
      this.mode.replaceChildren(live
        ? h('span.city-talk-pill.live', { title: 'Live chats were replaced by CodaClauda sessions in 0.4. Earlier live chats stay readable in Chat.' }, icon('clock'), h('b', 'Earlier live chat'), ' · read only')
        : h('span.city-talk-pill.mailbox', { title: 'An existing desktop chat. Messages wait until it checks its inbox; its schedule may vary and sending does not wake it. A message is information, not permission.' }, icon('clock'), h('b', 'Mailbox'), ' · replies when it checks in'),
      ...(info.missing ? [pill('Endpoint no longer on the board', 'warning')] : []));
    }
  }
  renderMessages(info, all) {
    const msgs = all.slice(-SHOWN), keep = new Set(), nodes = [];
    const lookSig = JSON.stringify(info.look);
    if (all.length > msgs.length) nodes.push(this.cached('more', String(all.length - msgs.length), () => h('button.city-talk-more', { type: 'button', onclick: () => this.navigate('chat', { thread: info.id }) }, `${all.length - msgs.length} earlier message${all.length - msgs.length === 1 ? '' : 's'} · open in Chat`), keep));
    if (!all.length) nodes.push(this.cached('intro', `${info.kind}|${info.name}`, () => this.buildIntro(info), keep));
    for (const m of msgs) {
      const sig = JSON.stringify([m.role, m.text, m.status, m.state, m.kind, m.at, info.kind, info.name, m.role === 'agent' ? lookSig : '']);
      nodes.push(this.cached(`m:${m.id}`, sig, () => this.buildMessage(m, info), keep));
    }
    for (const key of [...this.cache.keys()]) if (!keep.has(key)) this.cache.delete(key);
    if (nodes.length !== this.log.children.length || nodes.some((n, i) => this.log.children[i] !== n)) this.log.replaceChildren(...nodes);
  }
  cached(key, sig, build, keep) {
    keep.add(key);
    let entry = this.cache.get(key);
    if (!entry || entry.sig !== sig) { const node = build(); node.dataset.key = key; entry = { node, sig }; this.cache.set(key, entry); }
    return entry.node;
  }
  buildIntro(info) {
    const live = info.kind === 'live';
    return h('div.city-talk-intro',
      h('p', live
        ? `Each message starts a fresh ${info.provider === 'other' ? info.name : providerName(info.provider)} session that reads this conversation and answers in about 30–90 seconds.`
        : `${info.name} is an existing desktop chat. Your message is saved to the shared board and waits until they check their inbox — their schedule varies and sending doesn't wake them.`),
      h('div.city-talk-chips', (live ? LIVE_STARTERS : MAIL_STARTERS).map(text => h('button.city-talk-chip', { type: 'button', onclick: () => this.prefill(text) }, text))));
  }
  buildMessage(m, info) {
    if (m.role === 'system') return h('div.city-talk-system', plainText(m.text, 400));
    const time = h('time.city-talk-time', { dateTime: isoTime(m.at), title: fullTime(m.at) }, clockTime(m.at));
    if (m.role === 'owner') {
      const status = info.kind === 'mailbox'
        ? (m.status === 'seen' ? h('span.city-talk-receipt.seen', icon('eye'), `Seen by ${info.name}`) : h('span.city-talk-receipt', { title: 'Saved on the shared board. The agent reads it at its next check-in.' }, icon('check'), 'Saved to board'))
        : h('span.city-talk-receipt', icon('check'), 'Sent');
      return h('div.city-talk-msg.owner', h('div.city-talk-bubble', renderMarkdown(m.text, { compact: true })), h('div.city-talk-meta', time, status));
    }
    const live = info.kind === 'live', running = live && m.requestId && !TERMINAL.has(m.state);
    let content;
    if (running) {
      const who = info.provider === 'other' ? info.name : providerName(info.provider);
      content = h(`div.city-talk-typing.${info.provider}`, h('span.typing-dots', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        h('span', m.state === 'queued' ? `Queued — starting a fresh ${who} session…` : `${who} is working…`),
        h('button.btn.small.ghost', { type: 'button', 'aria-label': 'Stop this reply', onclick: event => this.stop(m.requestId, event.currentTarget) }, icon('stop'), 'Stop'));
    } else if (live && (m.state === 'failed' || m.state === 'needs-owner')) {
      content = h(`div.city-talk-callout.${m.state === 'failed' ? 'danger' : 'warning'}`, icon('alert'), renderMarkdown(m.text?.trim() || (m.state === 'failed' ? 'The run failed before an answer was recorded.' : 'The run needs your attention.'), { compact: true }));
    } else if (live && m.state === 'cancelled' && (!m.text?.trim() || /^_No answer was recorded\._$/.test(m.text.trim()))) {
      content = h('p.city-talk-muted', 'Stopped before an answer was recorded.');
    } else content = m.text?.trim() ? renderMarkdown(m.text, { compact: true }) : h('p.city-talk-muted', '(empty message)');
    const badge = info.kind === 'mailbox' && m.kind === 'question' ? pill('Asks you', 'warning') : null;
    return h(`div.city-talk-msg.agent${running ? '.running' : ''}`,
      portrait(info.look, { size: 26, provider: info.provider }),
      h('div.city-talk-stack', running ? content : h('div.city-talk-bubble', content), running ? null : h('div.city-talk-meta', time, badge)));
  }
  /** Waiting for a mailbox reply: an honest note (agents read the board when they check in). */
  renderStatus(info, msgs) {
    const last = msgs.at(-1);
    const sig = info.kind === 'mailbox' && last?.role === 'owner' ? JSON.stringify([info.name, last.status, info.status, info.lastSeenAt ? timeAgo(info.lastSeenAt) : '']) : '';
    if (sig === this.sigs.status) return;
    this.sigs.status = sig;
    if (!sig) { this.status.replaceChildren(); return; }
    const seen = last.status === 'seen';
    this.status.replaceChildren(h(`div.city-talk-wait${seen ? '.seen' : ''}`, icon(seen ? 'eye' : 'clock'),
      h('div', h('strong', seen ? `Seen — ${info.name} has read your message` : `Sent — ${info.name} reads the board when it next checks in`),
        h('p', seen ? 'Their reply appears here when they post it.' : "Its schedule varies and sending doesn't wake it."),
        info.status === 'offline' && !seen ? h('p', `${info.name} looks powered down${info.lastSeenAt ? ` (last seen ${timeAgo(info.lastSeenAt)})` : ''}. The message waits on the board.`) : null)));
  }
  renderComposer(info) {
    const d = this.draft(), run = info.kind === 'live' ? this.activeRun(info.id) : null;
    const sending = Boolean(d.sending);   // per agent: a send still finishing for another agent never locks this composer
    this.input.placeholder = `Message ${info.name}…`;
    this.input.readOnly = sending;
    this.sendBtn.hidden = Boolean(run);
    this.stopBtn.hidden = !run;
    if (run && this.stopBtn.dataset.request !== run.requestId) { this.stopBtn.dataset.request = run.requestId; this.stopBtn.disabled = false; }
    this.sendBtn.disabled = sending || !d.text.trim();
    const mode = sending ? 'sending' : 'idle';
    if (this.sendBtn.dataset.mode !== mode) { this.sendBtn.dataset.mode = mode; this.sendBtn.replaceChildren(sending ? h('span.spinner') : icon('send')); this.sendBtn.setAttribute('aria-label', sending ? 'Sending…' : 'Send message'); }
    const who = info.provider === 'other' ? info.name : providerName(info.provider);
    const note = info.kind === 'mailbox'
      ? `Saved to the shared board — ${info.name} reads it at their next inbox check. A message is information, not permission.`
      : run ? `${who} is answering — press Stop to cancel.` : `Starts a fresh ${who} session for this message — replies in ~30–90 s.`;
    if (note !== this.sigs.note) { this.sigs.note = note; this.note.textContent = note; }
    this.error.hidden = !d.error;
    if (d.error && this.error.dataset.msg !== d.error.message) {
      this.error.dataset.msg = d.error.message;
      this.error.replaceChildren(icon('alert'), h('div.city-talk-error-text', h('strong', "Couldn't send. "), d.error.message, ' Your draft is safe.'),
        h('button.btn.small', { type: 'button', onclick: () => this.send() }, icon('refresh'), 'Retry'),
        iconButton('close', 'Dismiss error', () => { d.error = null; this.error.dataset.msg = ''; this.refresh(); }));
    }
  }
  /** In-world feedback: a reply that lands while the conversation is open (not the history) and a
   *  live reply being written. */
  listen(info, msgs) {
    for (const m of msgs) {
      if (m.role !== 'agent') continue;
      const done = info.kind === 'mailbox' || TERMINAL.has(m.state);
      const mark = `${m.id}|${done ? 'done' : 'run'}`;
      if (this.heard.has(mark)) continue;
      this.heard.add(mark);
      if (this.primed && done && m.text?.trim() && !(info.kind === 'live' && m.state !== 'completed')) this.onAgentLine?.(sayLine(m.text));
    }
    this.primed = true;
    const thinking = info.kind === 'live' && Boolean(this.activeRun(info.id));
    if (thinking !== this.thinking) { this.thinking = thinking; this.onThinking?.(thinking); }
  }
  /** Read receipts, as Chat does for the open thread. */
  scheduleAck(info) {
    clearTimeout(this.ackTimer);
    if (info.kind !== 'mailbox' || !info.id) return;
    this.ackTimer = setTimeout(() => {
      if (!this.isOpen || this.thread?.id !== info.id || document.visibilityState !== 'visible' || !document.hasFocus()) return;
      const ids = this.store.threadMessages(info.id).filter(m => m.role === 'agent' && !m.raw?.read_at).map(m => m.id);
      if (ids.length) this.store.ackOwner(ids).catch(() => {});
    }, 700);
  }

  /* ---------- composer ---------- */
  onInput() {
    const d = this.draft();
    d.text = this.input.value;
    d.longFile = undefined; d.longSaved = undefined;
    this.autoGrow();
    this.sendBtn.disabled = Boolean(d.sending) || !d.text.trim();
  }
  onKey(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing) {
      event.preventDefault();
      if (this.thread?.kind === 'live' && this.activeRun()) { toast('A reply is still in progress — wait for it or press Stop.'); return; }
      this.send();
    } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.onLeave?.(); }
  }
  prefill(text) {
    const d = this.draft();
    d.text = d.text.trim() ? `${d.text.replace(/\s+$/, '')}\n\n${text}` : text;
    this.input.value = d.text;
    this.onInput();
    this.input.focus({ preventScroll: true });
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }
  autoGrow() {
    if (this.node.hidden) return;
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 150)}px`;
  }
  async send() {
    const info = this.info(), d = this.draft(), agentId = this.agent?.id;
    if (!info || d.sending) return;
    const text = d.text.trim();
    if (!text) { this.focus(); return; }
    if (info.kind === 'live' && info.id && this.activeRun(info.id)) { toast('A reply is still in progress — wait for it or press Stop.'); return; }
    d.sending = true; d.error = null; this.error.dataset.msg = '';
    this.renderComposer(info);
    let ok = false;
    try {
      if (info.kind === 'mailbox') await this.sendMailbox(info, d, text);
      else await this.sendLive(info, d, text);
      ok = true;
    } catch (error) { d.error = { message: error?.message || String(error || 'Unknown error') }; }
    finally { d.sending = false; }
    if (ok) Object.assign(d, { text: '', pending: null, longFile: undefined, longSaved: undefined });
    if (this.agent?.id !== agentId) return;   // left (or switched) while it was sending
    if (ok) { this.input.value = ''; this.autoGrow(); this.forceBottom = true; this.onSent?.(text); }
    this.refresh();
    if (ok) this.focus();
  }
  async sendMailbox(info, d, text) {
    let body = text;
    if (byteLength(body) >= BODY_LIMIT) {
      // Too long for one board message: keep the full text as an attachment and post a preview (as Chat does).
      d.longFile ??= new File([text], `message-${stamp()}.md`, { type: 'text/markdown' });
      d.longSaved ??= await this.store.saveAttachment(d.longFile);
      const name = d.longSaved.name || d.longFile.name;
      body = `${text.slice(0, 3000).trimEnd()}\n\n… (the full message is in the attached file \`${name}\`)\n\n**Attachments:**\n- \`${name}\` (${formatBytes(d.longFile.size)}) — saved at \`${d.longSaved.path}\``;
    }
    const payload = { to: info.address, kind: 'question', subject: autoSubject(text) || 'Note', body };
    const sig = JSON.stringify(payload);
    if (d.pending?.sig !== sig) d.pending = { sig, id: `owner-${crypto.randomUUID()}` };   // a retry of the same message is idempotent on the board
    await this.store.post({ ...payload, id: d.pending.id });
  }
  async sendLive() {
    // Live chats were replaced by sessions (0.4): earlier ones stay readable; a new conversation starts a session in Chat.
    throw new Error('Live chats were replaced by sessions. Start one in Chat → New chat.');
  }
  async stop(requestId, button) {
    if (button) button.disabled = true;
    try { await this.store.cancelLive(requestId); toast('Stopping the reply…', { timeout: 2200 }); }
    catch (error) { toast(`Couldn't stop: ${error?.message || error}`, { kind: 'error' }); if (button) button.disabled = false; }
  }
}
