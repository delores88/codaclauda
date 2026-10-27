/* City conversations: one transcript and composer. Managed sessions use the same owner send
 * and display-log path as Chat; board agents keep their existing thread. A message is information, not permission. Message text is untrusted: it is only rendered
 * through markdown.js (or as plain text). */
import { h, icon, iconButton, toast, portrait, pill, clockTime, fullTime, timeAgo, formatBytes, STATUS_LABEL, modal } from '../ui.js';
import { renderMarkdown, plainText } from '../markdown.js';
import { agentAvatar } from '../avatar/spec.js';
import { sessions } from '../sessions.js';
import { call as callFeature } from '../features.js';
import { talkRoute, talkProject, talkMessages, sendTalkSession, continueTalkCopy } from './talk-model.js';
import { levelInfo, normalizeLevel } from '../access.js';

/* TALK-STAGE-BEGIN (pure: checked headless) */
/** Staging (island units): Ben stands `gap` in front of the agent; the camera sits `back` behind him
 *  and `side` off his right shoulder. A far-away Ben reappears `approach` short of his spot and walks in. */
export const STAGE = { gap: 2.4, back: 2.0, side: 1.5, approach: 3.2 };
const TRIES = [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4, 2, -2, Math.PI];
const inBox = (x, z, b) => x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1;
/** Where Ben stands to talk to an agent at a ({ x, z }, island space): `gap` from it on the side Ben
 * comes from (facing: a seated agent's yaw, so Ben stands in front of the bench), clear of every box
 * ({ x0, x1, z0, z1, low? }) and inside |x|, |z| <= limit, with room behind him for the camera (solid
 * boxes only; the camera pulls in when a wall is close). cameraClearance:false leaves camera clearance
 * to a caller fitting a different shot, while retaining standing-position checks. Returns { x, z, yaw, heading, back, side }: yaw
 * points from the agent to Ben (forward is (sin, cos)); heading is Ben's facing (toward the agent). */
export function talkSpot(a, from, { boxes = [], limit = Infinity, facing = null, gap = STAGE.gap, back = STAGE.back, side = STAGE.side, cameraClearance = true } = {}) {
  const out = (x, z, margin = 0) => Math.abs(x) > limit + margin || Math.abs(z) > limit + margin;
  const solid = boxes.filter(b => !b.low);
  const base = Number.isFinite(facing) ? facing : Math.atan2(from.x - a.x, from.z - a.z) || 0;
  let fallback = null;
  for (const turn of TRIES) {
    const yaw = base + turn, ux = Math.sin(yaw), uz = Math.cos(yaw);
    const x = a.x + ux * gap, z = a.z + uz * gap;
    if (out(x, z) || boxes.some(b => inBox(x, z, b))) continue;
    if (!cameraClearance) return { x, z, yaw, heading: yaw + Math.PI, back, side };
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

const BODY_LIMIT = 30 * 1000;   // the board caps bodies at 32 KiB; stay below 30 KB (as Chat does)
const SHOWN = 60;               // most recent messages in the panel; Chat has the rest
const PROVIDER_NAME = { claude: 'Claude', codex: 'Codex' };
const MAIL_STARTERS = ['What are you working on right now?', 'Is anything blocked that I can help with?', "Give me a short summary of today's progress."];
const FRESH_STARTERS = ['Review this project and suggest the next task', 'Run the tests and tell me what fails', 'Explain how this project is organized'];
const providerName = provider => PROVIDER_NAME[provider] || 'Agent';
const copySourceKey = agent => JSON.stringify([agent.id, agent.provider, agent.providerSessionId, agent.cwd]);
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
export function sayLine(text, limit = 80) {
  const prose = String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/\$[^$\n]+\$/g, '…');
  return prose.split('\n').map(line => plainText(line, limit)).find(Boolean) || plainText(text, limit);
}

/** The conversation panel. Callbacks: onLeave(), onSent(text), onAgentLine(text) when an agent reply
 * lands while it is open, onThinking(on) while a live reply is being written. */
export class TalkPanel {
  constructor({ store, navigate, onLeave, onSent, onAgentLine, onThinking, onAgentChanged, onNewSessionHere,
    canNewSessionHere = project => Boolean(project?.id && typeof project.path === 'string' && project.path.trim()),
    sessionClient = sessions, featureCall = callFeature }) {
    Object.assign(this, { store, navigate, onLeave, onSent, onAgentLine, onThinking, onAgentChanged, onNewSessionHere,
      canNewSessionHere, sessions: sessionClient, featureCall });
    this.agent = null;
    this.drafts = new Map(); this.cache = new Map(); this.heard = new Map(); this.freshSessions = new Set();
    this.head = h('header.city-talk-head');
    this.mode = h('div.city-talk-mode', { hidden: true });
    this.log = h('div.city-talk-log');
    this.status = h('div.city-talk-status', { role: 'status' });
    this.scroller = h('div.city-talk-scroll', { role: 'log', 'aria-label': 'Conversation', 'aria-relevant': 'additions' }, this.log, this.status);
    this.input = h('textarea.city-talk-input', { rows: 1, 'aria-label': 'Message', placeholder: 'Message...', oninput: () => this.onInput(), onkeydown: e => this.onKey(e) });
    this.sendBtn = h('button.city-talk-send', { type: 'button', 'aria-label': 'Send message', title: 'Send (Enter)', disabled: true, onclick: () => this.send() }, icon('send'));
    this.stopBtn = h('button.city-talk-stop', { type: 'button', 'aria-label': 'Stop the reply', title: 'Stop', hidden: true, onclick: e => this.stop(e.currentTarget) }, icon('stop'));
    this.error = h('div.city-talk-error', { hidden: true, role: 'alert' });
    this.note = h('p.city-talk-note');
    this.composer = h('footer.city-talk-composer', this.error, h('div.city-talk-box', this.input, this.sendBtn, this.stopBtn), this.note);
    this.node = h('aside.city-talk', { hidden: true, 'aria-label': 'Conversation' }, this.head, this.mode, this.scroller, this.composer);
  }
  get isOpen() { return Boolean(this.agent); }
  /** pending is settled by resolvePending(agent) or failPending(error), never by guessing a session. */
  open(agent, { pending = null } = {}) {
    this.releaseSession();
    this.agent = { ...agent };
    this.pendingStart = pending ? { ...pending, error: pending.error ? String(pending.error.message || pending.error) : '' } : null;
    this.thread = pending ? { kind: 'pending', id: agent.id } : this.pickThread(agent);
    this.cache.clear(); this.log.replaceChildren(); this.heard.clear(); this.thinking = false;
    this.sigs = { head: '', status: '', note: '' };
    this.node.hidden = false; this.input.value = this.draft().text;
    this.offSessions?.();
    this.offSessions = this.sessions.on('change', () => { if (this.isOpen) this.refresh(); });
    if (this.thread.kind === 'session') {
      this.sessions.viewing.add(this.thread.sessionId);
      this.sessions.unread.delete(this.thread.sessionId);
      this.sessions.load(this.thread.sessionId);
    }
    this.refresh({ bottom: true }); this.autoGrow();
    this.node.setAttribute('aria-label', 'Conversation with ' + this.agent.name);
  }
  resolvePending(agent) {
    if (!this.pendingStart || !agent) return false;
    if (this.pendingStart.fresh) this.freshSessions.add(agent.id);
    this.drafts.set(agent.id, this.draft()); this.open(agent); return true;
  }
  failPending(error) {
    if (!this.pendingStart) return false;
    this.pendingStart.error = String(error?.message || error || 'The session did not start.');
    this.refresh(); return true;
  }
  releaseSession() {
    if (this.thread?.kind === 'session') this.sessions.viewing.delete(this.thread.sessionId);
  }
  close() {
    this.releaseSession(); this.offSessions?.(); this.offSessions = null;
    this.agent = null; this.thread = null; this.pendingStart = null; this.node.hidden = true;
    clearTimeout(this.ackTimer); this.cache.clear(); this.log.replaceChildren();
    if (this.thinking) this.onThinking?.(false);
    this.thinking = false;
  }
  focus() { if (this.isOpen) this.input.focus({ preventScroll: true }); }
  pickThread(agent) { return talkRoute(agent, this.store); }
  info() {
    const t = this.thread, store = this.store;
    if (!t) return null;
    const agent = { ...(store.agent?.(this.agent.id) || {}), ...this.agent };
    const session = t.kind === 'session' ? this.sessions.session(t.sessionId) : null;
    const provider = session?.provider || agent.provider || providerOfName(t.address);
    const name = session?.title || agent.name || (t.address ? store.addressLabel(t.address) : providerName(provider));
    const status = t.kind === 'session' ? (this.sessions.running(t.sessionId) ? 'active' : session?.status === 'error' ? 'error' : session?.status === 'stopped' ? 'offline' : 'idle') : agent.status || 'offline';
    return { ...t, agent, session, provider, name, status, project: talkProject(agent, store),
      look: agent.look || agentAvatar(agent.id, provider, name) };
  }
  draft() {
    const who = this.agent?.id || '';
    if (!this.drafts.has(who)) this.drafts.set(who, { text: '', error: null, pending: null, sending: false });
    return this.drafts.get(who);
  }
  messages(info) {
    if (info.kind === 'session') return talkMessages(this.sessions.transcript(info.sessionId).items);
    if (info.kind === 'external') return talkMessages(info.agent.transcript || []);
    return info.kind === 'pending' || !info.id ? [] : this.store.threadMessages(info.id);
  }
  refresh({ bottom = false } = {}) {
    const info = this.info(); if (!info) return;
    const msgs = this.messages(info);
    const atBottom = bottom || this.forceBottom || this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 80;
    this.renderHead(info); this.renderMessages(info, msgs); this.renderStatus(info, msgs); this.renderComposer(info);
    if (atBottom) this.scroller.scrollTop = this.scroller.scrollHeight;
    this.forceBottom = false; this.listen(info, msgs); this.scheduleAck(info);
  }
  renderHead(info) {
    const title = providerName(info.provider) + (info.project ? ' · ' + info.project.name : ' · ' + info.name);
    const status = this.pendingStart ? (this.pendingStart.error ? 'Could not start' : 'Starting')
      : info.kind === 'session' && info.status === 'idle' ? 'Ready'
      : STATUS_LABEL[info.status] || (info.status === 'error' ? 'Needs attention' : 'Powered down');
    const activity = info.kind === 'external' ? 'Last activity: ' + (info.agent.lastSeenAt ? timeAgo(info.agent.lastSeenAt) : 'unknown') : '';
    const newSessionHere = Boolean(this.onNewSessionHere && info.project && this.canNewSessionHere(info.project, info.agent));
    const sig = JSON.stringify([title, info.name, info.provider, status, activity, info.agent.lastSeenAt, info.look, info.id, info.kind, info.project?.id, newSessionHere]);
    if (sig === this.sigs.head) return;
    this.sigs.head = sig;
    const chatParams = info.kind === 'session' ? { thread: info.session?.sharedId ? 'pair:' + info.session.sharedId : info.id }
      : info.kind === 'mailbox' || info.kind === 'live' ? { thread: info.id } : info.project ? { project: info.project.id } : {};
    const chat = iconButton('chat', 'Open in Chat', () => this.navigate('chat', chatParams), 'city-talk-open');
    const routeNote = info.kind === 'mailbox' ? 'Message board: it replies when it next checks the board.'
      : info.kind === 'session' ? 'Messages go to this CodaClauda session.'
      : info.kind === 'pending' ? (this.pendingStart?.error ? 'The session did not start.' : 'The session is starting.')
      : 'Continue as a labelled copy to send messages in a new CodaClauda session.';
    const statusTooltip = [routeNote, activity, info.kind === 'external' && info.agent.lastSeenAt
      ? 'Session file modified ' + fullTime(info.agent.lastSeenAt) : ''].filter(Boolean).join('\n');
    const detail = h('p.city-talk-presence', { tabindex: '0', title: statusTooltip, 'aria-label': status + '. ' + statusTooltip },
      h(`span.city-gem.${this.pendingStart?.error ? 'error' : info.status}`, { 'aria-hidden': 'true' }), h('span', status));
    // Keep the original scalar first argument; newer callers may use the second details argument.
    const newHere = newSessionHere ? iconButton('plus', 'New session here', () => this.onNewSessionHere(info.project.id, {
        projectId: info.project.id, provider: info.provider, agentId: info.agent.id,
      }), 'city-talk-new') : null;
    this.head.replaceChildren(portrait(info.look, { size: 38, provider: info.provider }),
      h('div.city-talk-title', h('h2', { title: title + '\n' + (info.agent.label || info.name) }, title), detail),
      h('div.city-talk-actions', newHere, chat, iconButton('close', 'Leave conversation (Esc)', () => this.onLeave?.())));
  }
  renderMessages(info, all) {
    const msgs = all.slice(-SHOWN), keep = new Set(), nodes = [];
    const lookSig = JSON.stringify(info.look);
    if (all.length > msgs.length) nodes.push(this.cached('more', String(all.length), () => h('button.city-talk-more', { type: 'button', onclick: () => this.navigate('chat', { thread: info.id }) }, (all.length - msgs.length) + ' earlier messages - open in Chat'), keep));
    if (all.length) this.freshSessions.delete(info.agent.id);
    if (!all.length && info.kind !== 'pending') nodes.push(this.cached('intro', JSON.stringify([info.kind, info.name,
      info.provider, info.project?.name, info.session?.access, info.agent.access, this.freshSessions.has(info.agent.id)]), () => this.buildIntro(info), keep));
    for (const m of msgs) {
      const sig = JSON.stringify([m.role, m.text, m.status, m.state, m.kind, m.at, m.queued, info.name, m.role === 'agent' ? lookSig : '']);
      nodes.push(this.cached('m:' + m.id, sig, () => this.buildMessage(m, info), keep));
    }
    for (const id of [...this.cache.keys()]) if (!keep.has(id)) this.cache.delete(id);
    if (nodes.length !== this.log.children.length || nodes.some((n, i) => this.log.children[i] !== n)) this.log.replaceChildren(...nodes);
  }
  cached(id, sig, build, keep) {
    keep.add(id); let entry = this.cache.get(id);
    if (!entry || entry.sig !== sig) { const node = build(); node.dataset.key = id; entry = { node, sig }; this.cache.set(id, entry); }
    return entry.node;
  }
  buildIntro(info) {
    const fresh = info.kind === 'session' && this.freshSessions.has(info.agent.id);
    const level = normalizeLevel(info.session?.access || info.agent.access);
    const intro = fresh ? h('div.city-talk-ready',
      h('h3', providerName(info.provider) + ' is ready' + (info.project ? ' in ' + info.project.name : '')),
      h('p.city-talk-access', level ? levelInfo(level).long : 'Access level unavailable'))
      : h('p', 'Talk with ' + info.name + ' about this project.');
    return h('div.city-talk-intro', intro,
      h('div.city-talk-chips', (fresh ? FRESH_STARTERS : MAIL_STARTERS).map(text => h('button.city-talk-chip', { type: 'button', onclick: () => this.prefill(text) }, text))));
  }
  buildMessage(m, info) {
    if (m.role === 'system') return h('div.city-talk-system', plainText(m.text, 800));
    const time = h('time.city-talk-time', { dateTime: isoTime(m.at), title: fullTime(m.at) }, clockTime(m.at));
    if (m.role === 'owner') {
      const receipt = m.queued ? 'Queued' : m.status === 'seen' ? 'Seen' : 'Sent';
      return h('div.city-talk-msg.owner', h('div.city-talk-bubble', renderMarkdown(m.text, { compact: true })),
        h('div.city-talk-meta', time, h('span.city-talk-receipt', icon(receipt === 'Seen' ? 'eye' : 'check'), receipt)));
    }
    const content = m.text?.trim() ? renderMarkdown(m.text, { compact: true }) : h('p.city-talk-muted', '(empty message)');
    const badge = info.kind === 'mailbox' && m.kind === 'question' ? pill('Asks you', 'warning') : null;
    return h('div.city-talk-msg.agent' + (m.streaming ? '.running' : ''), portrait(info.look, { size: 26, provider: info.provider }),
      h('div.city-talk-stack', h('div.city-talk-bubble', content), h('div.city-talk-meta', time, badge)));
  }
  renderStatus(info, msgs) {
    const transcript = info.kind === 'session' ? this.sessions.transcript(info.sessionId) : null;
    const running = info.kind === 'session' && this.sessions.running(info.sessionId), last = msgs.at(-1);
    const message = this.pendingStart ? this.pendingStart.error || 'Starting ' + providerName(info.provider) + (info.project ? ' in ' + info.project.name : '') + '...'
      : transcript?.state === 'error' ? "Couldn't load the conversation: " + transcript.error
      : transcript && ['none', 'loading'].includes(transcript.state) ? 'Loading conversation...'
      : running ? info.name + ' is working...'
      : info.kind === 'external' && !msgs.length ? `This conversation lives in the ${info.provider === 'codex' ? 'Codex' : info.provider === 'claude' ? 'Claude' : 'desktop'} app. Send to continue it here as a new session.`
      : info.kind === 'mailbox' && last?.role === 'owner' ? (last.status === 'seen' ? 'Seen. Waiting for a reply...' : 'Sent. Waiting for a reply...') : '';
    const pending = this.pendingStart, canRetry = Boolean(pending?.error && typeof pending.retry === 'function');
    const sig = message + '|' + Boolean(pending?.error) + '|' + canRetry + '|' + Boolean(pending?.retrying);
    if (sig === this.sigs.status) return;
    this.sigs.status = sig; this.status.setAttribute('role', this.pendingStart?.error ? 'alert' : 'status');
    const retry = canRetry ? h('button.btn.small.city-talk-retry', {
      type: 'button', disabled: Boolean(pending.retrying), onclick: () => this.retryPending(pending),
    }, 'Retry') : null;
    const indicator = pending && !pending.error ? h('span.spinner', { 'aria-hidden': 'true' }) : icon(pending?.error ? 'alert' : 'clock');
    this.status.replaceChildren(...(message ? [h('div.city-talk-wait' + (pending?.error ? '.danger' : ''), indicator, h('p', message), retry)] : []));
  }
  async retryPending(pending = this.pendingStart) {
    if (!this.isOpen || this.pendingStart !== pending || !pending?.error || pending.retrying || typeof pending.retry !== 'function') return false;
    pending.retrying = true; this.refresh();
    try { await pending.retry(); }
    catch (error) { if (this.pendingStart === pending) pending.error = String(error?.message || error); }
    finally { if (this.pendingStart === pending) { pending.retrying = false; this.refresh(); } }
    return true;
  }
  renderComposer(info) {
    const d = this.draft(), running = info.kind === 'session' && this.sessions.running(info.sessionId);
    const sending = Boolean(d.sending), pending = Boolean(this.pendingStart);
    this.input.placeholder = pending ? 'Waiting for the session...' : 'Message ' + info.name + '...';
    this.input.readOnly = sending || pending; this.input.disabled = pending;
    this.sendBtn.hidden = false; this.stopBtn.hidden = !running; this.stopBtn.disabled = false;
    this.sendBtn.disabled = sending || pending || !d.text.trim();
    const mode = sending ? 'sending' : 'idle';
    if (this.sendBtn.dataset.mode !== mode) {
      this.sendBtn.dataset.mode = mode; this.sendBtn.replaceChildren(sending ? h('span.spinner') : icon('send'));
      this.sendBtn.setAttribute('aria-label', sending ? 'Sending...' : 'Send message');
    }
    const note = pending ? (this.pendingStart.error ? 'Retry to start this session.' : 'You can write when the session is ready.')
      : info.kind === 'external' || info.kind === 'live' ? 'Sending offers Continue in a new session.'
      : running ? 'Your next message waits until this reply finishes.' : 'Enter to send - Shift+Enter for a new line';
    if (note !== this.sigs.note) { this.sigs.note = note; this.note.textContent = note; }
    this.error.hidden = !d.error;
    if (d.error && this.error.dataset.msg !== d.error.message) {
      this.error.dataset.msg = d.error.message;
      this.error.replaceChildren(icon('alert'), h('div.city-talk-error-text', h('strong', "Couldn't send. "), d.error.message, ' Your draft is safe.'),
        h('button.btn.small', { type: 'button', onclick: () => this.send() }, icon('refresh'), 'Retry'),
        iconButton('close', 'Dismiss error', () => { d.error = null; this.error.dataset.msg = ''; this.refresh(); }));
    }
  }
  listen(info, msgs) {
    const latest = msgs.filter(m => m.role === 'agent' && m.text?.trim()).at(-1);
    // Board presence can stay active after a reply; only managed sessions report live reply progress.
    const thinking = info.kind === 'session' && this.sessions.running(info.sessionId);
    if (thinking !== this.thinking) { this.thinking = thinking; this.onThinking?.(thinking); }
    if (!thinking && latest && this.heard.get(latest.id) !== latest.text) { this.heard.set(latest.id, latest.text); this.onAgentLine?.(sayLine(latest.text)); }
  }
  scheduleAck(info) {
    clearTimeout(this.ackTimer);
    if (info.kind !== 'mailbox' || !info.id) return;
    this.ackTimer = setTimeout(() => {
      if (!this.isOpen || this.thread?.id !== info.id || document.visibilityState !== 'visible' || !document.hasFocus()) return;
      const ids = this.store.threadMessages(info.id).filter(m => m.role === 'agent' && !m.raw?.read_at).map(m => m.id);
      if (ids.length) this.store.ackOwner(ids).catch(() => {});
    }, 700);
  }
  onInput() {
    const d = this.draft(); d.text = this.input.value; d.longFile = undefined; d.longSaved = undefined;
    this.autoGrow(); this.sendBtn.disabled = Boolean(d.sending || this.pendingStart) || !d.text.trim();
  }
  onKey(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing) { event.preventDefault(); this.send(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.onLeave?.(); }
  }
  prefill(text) {
    const d = this.draft(); d.text = d.text.trim() ? d.text.replace(/\s+$/, '') + '\n\n' + text : text;
    this.input.value = d.text; this.onInput(); this.focus(); this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }
  autoGrow() {
    if (this.node.hidden) return;
    this.input.style.height = 'auto'; this.input.style.height = Math.min(this.input.scrollHeight, 150) + 'px';
  }
  async send() {
    const info = this.info(), d = this.draft(), agentId = this.agent?.id;
    if (!info || d.sending || this.pendingStart) return;
    const text = d.text.trim(); if (!text) { this.focus(); return; }
    if (info.kind === 'external' || info.kind === 'live') {
      if (d.continuedCopy?.source === copySourceKey(info.agent)) await this.continueConversation(info, text);
      else this.offerContinue(info, text);
      return;
    }
    d.sending = true; d.error = null; this.error.dataset.msg = ''; this.renderComposer(info);
    let ok = false;
    try {
      if (info.kind === 'session') await sendTalkSession(this.sessions, info, text);
      else await this.sendMailbox(info, d, text);
      ok = true;
    } catch (error) { d.error = { message: error?.message || String(error || 'Unknown error') }; }
    finally { d.sending = false; }
    if (ok) Object.assign(d, { text: '', pending: null, longFile: undefined, longSaved: undefined, continuedCopy: null });
    if (this.agent?.id !== agentId) return;
    if (ok) { this.input.value = ''; this.autoGrow(); this.forceBottom = true; this.onSent?.(text); }
    this.refresh(); if (ok) this.focus();
  }
  offerContinue(info, text) {
    if (this.continueDialog) return;
    this.continueDialog = modal({
      title: 'Continue in a new session',
      body: 'Start a labelled copy of this ' + providerName(info.provider) + ' conversation' + (info.project ? ' in ' + info.project.name : '') + " with its context, then send your message. The copy uses the project's current access.",
      actions: [{ label: 'Cancel' }, { label: 'Continue in a new session', kind: 'primary', run: () => this.continueConversation(info, text) }],
      onClose: () => { this.continueDialog = null; },
    });
  }
  async continueConversation(info, text) {
    const originalId = info.agent.id, d = this.drafts.get(originalId) || this.draft();
    if (d.sending) return false;
    d.sending = true; d.error = null;
    if (this.agent?.id === originalId) this.renderComposer(info);
    try {
      const source = copySourceKey(info.agent);
      const s = d.continuedCopy?.source === source ? d.continuedCopy.session
        : await continueTalkCopy(info.agent, info.project, { call: this.featureCall, client: this.sessions });
      // Keep the admitted copy on the shared draft even if the owner leaves before its first send.
      d.continuedCopy = { source, session: s };
      const next = { id: 'sess:' + s.id, kind: 'session', sessionId: s.id, name: s.title || info.name, provider: s.provider,
        currentProjectId: info.project?.id || s.projectId, cwd: s.cwd, status: 'idle', look: info.look };
      this.drafts.set(next.id, d);
      if (this.agent?.id === originalId) {
        d.sending = false; // send() acquires its own lock for the displayed copy.
        this.onAgentChanged?.(next); if (this.agent?.id !== next.id) this.open(next);
        await this.send();
      } else {
        // Keep the lock while this background send is unresolved, including if the source reopens.
        await sendTalkSession(this.sessions, talkRoute(next, this.store), text);
        d.text = ''; d.continuedCopy = null;
      }
      return true;
    } catch (error) {
      d.error = { message: error?.message || String(error) };
      return true;
    } finally {
      d.sending = false;
      if (this.isOpen && this.draft() === d) {
        this.input.value = d.text; this.autoGrow(); this.refresh();
      }
    }
  }
  async sendMailbox(info, d, text) {
    let body = text;
    if (byteLength(body) >= BODY_LIMIT) {
      d.longFile ??= new File([text], 'message-' + stamp() + '.md', { type: 'text/markdown' });
      d.longSaved ??= await this.store.saveAttachment(d.longFile);
      const name = d.longSaved.name || d.longFile.name;
      body = text.slice(0, 3000).trimEnd() + '\n\n... (the full message is in the attached file ' + name + ')\n\nAttachments:\n- ' + name + ' (' + formatBytes(d.longFile.size) + ') - saved at ' + d.longSaved.path;
    }
    const payload = { to: info.address, kind: 'question', subject: autoSubject(text) || 'Note', body };
    const sig = JSON.stringify(payload);
    if (d.pending?.sig !== sig) d.pending = { sig, id: 'owner-' + crypto.randomUUID() };
    await this.store.post({ ...payload, id: d.pending.id });
  }
  async stop(button) {
    const id = this.thread?.kind === 'session' && this.thread.sessionId;
    if (!id) return;
    if (button) button.disabled = true;
    try { await this.sessions.stop(id); toast('Stopping the reply...', { timeout: 2200 }); }
    catch (error) { toast("Couldn't stop: " + (error?.message || error), { kind: 'error' }); }
    finally { if (button) button.disabled = false; }
  }
}
