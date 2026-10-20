/* Pure helpers for CodaClauda sessions (no DOM, no imports; node tests import this file).
 *
 * Display events (Tauri 'session://event' and session_history):
 *   { id, turnId, kind: 'user'|'delta'|'message'|'tool'|'status'|'error'|'done', text?, tool?{name,summary}, status?, error?, at }
 * buildTranscript turns one session's events into display items; mergeShared joins the two
 * sessions of a shared project thread into one conversation; routeMessage and sharedContext
 * implement the @claude / @codex / @both routing and the "what the other agent said" block. */

export const PROVIDERS = {
  claude: { id: 'claude', name: 'Claude', long: 'Claude Code' },
  codex: { id: 'codex', name: 'Codex', long: 'Codex' },
};
export const providerLabel = (provider, long = false) => PROVIDERS[provider]?.[long ? 'long' : 'name'] || 'Agent';
export const CONTEXT_LIMIT = 4000;
const CONTEXT_TAG = 'shared-thread-context';
const CONTEXT_RE = new RegExp(`^\\s*<${CONTEXT_TAG}>[\\s\\S]*?</${CONTEXT_TAG}>\\s*`);
const OWNER_MERGE_MS = 15e3;

/** Event time → ms (accepts ms, seconds or an ISO string). */
export function toMs(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) { const n = Number(value); return n < 1e12 ? n * 1000 : n; }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/** "@claude fix it" → { targets: ['claude'], text: 'fix it', mention: 'claude' }. @both or no mention → both. */
export function routeMessage(input) {
  const raw = String(input ?? '');
  const m = /^\s*@(claude|codex|both)(?![\w-])[\s,:]*/i.exec(raw);
  if (!m) return { targets: ['claude', 'codex'], text: raw.trim(), mention: null };
  const who = m[1].toLowerCase();
  return { targets: who === 'both' ? ['claude', 'codex'] : [who], text: raw.slice(m[0].length).trim(), mention: who };
}

/** The owner text without a leading shared-thread context block. */
export const stripContext = text => String(text ?? '').replace(CONTEXT_RE, '');

/** Drop streamed deltas that a finished 'message' of the same turn already covers. */
export function compactEvents(events) {
  const lastMessage = new Map();
  events.forEach((e, i) => { if (e?.kind === 'message') lastMessage.set(e.turnId ?? '', i); });
  return events.filter((e, i) => !(e?.kind === 'delta' && i < (lastMessage.get(e.turnId ?? '') ?? -1)));
}

/** One session's events → { items, openTurn, lastAt }.
 *  items: { key, kind: 'owner'|'agent'|'tools'|'error', provider, sessionId, turnId, at, text?, streaming?, tools?, targets? }.
 *  openTurn: the turnId of a user turn with no 'done' yet (null when none). */
export function buildTranscript(events, { provider = '', sessionId = '' } = {}) {
  const items = [];
  const turns = new Map();   // turnId -> { agent: n, tools: n, err: n, last: item, done }
  let openTurn = null, lastAt = 0, users = 0;
  const turnOf = id => { const key = id ?? ''; if (!turns.has(key)) turns.set(key, { agent: 0, tools: 0, err: 0, last: null, done: false }); return turns.get(key); };
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue;
    const at = toMs(e.at), turnId = e.turnId ?? '';
    const t = turnOf(turnId);
    if (at) lastAt = Math.max(lastAt, at);
    const base = { provider, sessionId, turnId, at };
    if (e.kind === 'user') {
      const item = { ...base, key: `${sessionId}:u:${turnId || users}`, kind: 'owner', text: stripContext(e.text), targets: [provider] };
      users += 1;
      items.push(item); t.last = item; t.done = false; openTurn = turnId || openTurn;
    } else if (e.kind === 'delta') {
      if (t.last?.kind === 'agent' && t.last.streaming) t.last.text += String(e.text ?? '');
      else { const item = { ...base, key: `${sessionId}:${turnId}:a${t.agent++}`, kind: 'agent', text: String(e.text ?? ''), streaming: true }; items.push(item); t.last = item; }
    } else if (e.kind === 'message') {
      const streaming = [...items].reverse().find(x => x.kind === 'agent' && x.turnId === turnId && x.streaming && x.sessionId === sessionId);
      if (streaming) { streaming.text = String(e.text ?? streaming.text); streaming.streaming = false; streaming.at = at || streaming.at; }
      else { const item = { ...base, key: `${sessionId}:${turnId}:a${t.agent++}`, kind: 'agent', text: String(e.text ?? ''), streaming: false }; items.push(item); t.last = item; }
    } else if (e.kind === 'tool') {
      const tool = { name: String(e.tool?.name || 'tool'), summary: String(e.tool?.summary ?? e.text ?? '') };
      if (t.last?.kind === 'tools') t.last.tools.push(tool);
      else { const item = { ...base, key: `${sessionId}:${turnId}:t${t.tools++}`, kind: 'tools', tools: [tool] }; items.push(item); t.last = item; }
    } else if (e.kind === 'error') {
      const item = { ...base, key: `${sessionId}:${turnId}:e${t.err++}`, kind: 'error', text: String(e.error || e.text || 'The session reported an error.') };
      items.push(item); t.last = item;
    } else if (e.kind === 'done') {
      t.done = true;
      for (const x of items) if (x.turnId === turnId && x.sessionId === sessionId && x.streaming) x.streaming = false;
      if (openTurn === turnId) openTurn = null;
    }
  }
  if (openTurn != null && turns.get(openTurn)?.done) openTurn = null;
  return { items, openTurn, lastAt };
}

/** Two sessions' items → one conversation sorted by time. The same owner text sent to both within a few
 *  seconds becomes one bubble with both targets. */
export function mergeShared(lists) {
  const all = lists.flat().sort((a, b) => a.at - b.at || (a.kind === 'owner' ? -1 : 0) - (b.kind === 'owner' ? -1 : 0));
  const out = [];
  for (const item of all) {
    if (item.kind === 'owner') {
      const twin = out.findLast(x => x.kind === 'owner' && x.text === item.text && Math.abs(x.at - item.at) < OWNER_MERGE_MS && !x.targets.includes(item.provider));
      if (twin) { twin.targets = [...twin.targets, item.provider]; continue; }
      out.push({ ...item, targets: [...item.targets] });
    } else out.push(item);
  }
  return out;
}

/** The context block for `target` in a shared thread: what the other agent said (and what Ben asked only
 *  it) since `target` last replied, newest kept, capped near `limit` characters. '' when there is nothing new. */
export function sharedContext(items, target, limit = CONTEXT_LIMIT) {
  const other = target === 'claude' ? 'codex' : 'claude';
  let since = -1;
  items.forEach((x, i) => { if (x.kind === 'agent' && x.provider === target && !x.streaming) since = i; });
  const clean = text => String(text ?? '').replace(new RegExp(`</?${CONTEXT_TAG}>`, 'g'), '[context]').trim();
  const lines = [];
  for (const x of items.slice(since + 1)) {
    if (x.kind === 'agent' && x.provider === other && x.text.trim()) lines.push(`${providerLabel(other)}: ${clean(x.text)}`);
    else if (x.kind === 'owner' && x.text.trim() && !x.targets.includes(target)) lines.push(`Ben (to ${providerLabel(other)} only): ${clean(x.text)}`);
  }
  if (!lines.length) return '';
  let body = lines.join('\n\n');
  if (body.length > limit) body = `…${body.slice(body.length - limit + 1)}`;
  return `<${CONTEXT_TAG}>\nBen is talking with you and ${providerLabel(other)} in one shared CodaClauda thread. Since your last reply:\n\n${body}\n</${CONTEXT_TAG}>`;
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** "cd "<cwd>"; claude --resume <id>" / "...; codex resume <threadId>", or '' until the provider id is known. */
export function resumeCommand(session) {
  if (!session) return '';
  const id = session.provider === 'claude' ? session.providerSessionId : session.threadId || session.providerSessionId;
  if (!id || !SAFE_ID.test(String(id))) return '';
  const cwd = String(session.cwd || '');
  const cd = cwd && !/["\r\n]/.test(cwd) ? `cd "${cwd}"; ` : '';
  return session.provider === 'claude' ? `${cd}claude --resume ${id}` : `${cd}codex resume ${id}`;
}
