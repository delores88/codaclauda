/* CodaClauda sessions client: the session registry (session_list), each opened session's display
 * log (session_history, then live 'session://event' events) and the start/send/stop/close calls.
 * All calls go through bridge.js desktop.session* (Tauri commands owned by the engine track).
 * Outside a 0.4 desktop build those helpers are missing or refuse, and `available` is false.
 *
 * Events: sessions.on('change', fn). Agent text is untrusted; views render it through
 * markdown.js or textContent only. Transcripts never go through the desktop UI state file. */
import { desktop } from './bridge.js';
import { buildTranscript, compactEvents, stripContext, toMs } from './session-model.js';

const NEEDED = ['sessionList', 'sessionStart', 'sessionSend', 'sessionStop', 'sessionClose', 'sessionHistory', 'onSessionEvent'];
const HISTORY_LIMIT = 4000;
const MAX_EVENTS = 8000;
export const UNAVAILABLE_TEXT = 'Sessions need CodaClauda 0.4 desktop';

const eventSig = e => `${e.kind}|${e.turnId ?? ''}|${e.at ?? ''}|${String(e.text ?? '').length}|${e.tool?.name ?? ''}|${e.status ?? ''}`;

class Sessions extends EventTarget {
  constructor() {
    super();
    this.available = null;      // null = not checked yet
    this.reason = '';
    this.list = [];
    this.logs = new Map();      // id -> { state: 'loading'|'loaded'|'error', events, buffer, version, error, cache }
    this.pending = new Map();   // id -> [{ localId, text, attachments, at, turnId, done }]
    this.unread = new Set();
    this.viewing = new Set();   // session ids open in Chat (not marked unread)
    this._listening = false;
    this._refreshTimer = 0;
    this._refreshing = null;
  }

  on(name, fn) { const handler = event => fn(event.detail); this.addEventListener(name, handler); return () => this.removeEventListener(name, handler); }
  changed() { this.dispatchEvent(new CustomEvent('change')); }
  supported() { return NEEDED.every(name => typeof desktop[name] === 'function'); }

  /** Loads the registry; safe to call repeatedly (each call refreshes). */
  async refresh() {
    if (!this.supported()) {
      if (this.available !== false) { this.setAvailable(false, 'This build has no session commands.'); this.changed(); }
      return;
    }
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      try {
        const data = await desktop.sessionList();
        const fresh = Array.isArray(data?.sessions) ? data.sessions.filter(s => s && typeof s.id === 'string') : [];
        // Keep a locally newer status (from live events) when the registry lags behind.
        const known = new Map(this.list.map(s => [s.id, s]));
        this.list = fresh.map(s => { const old = known.get(s.id); return old && toMs(old.lastActivityAt) > toMs(s.lastActivityAt) ? { ...s, status: old.status, lastActivityAt: old.lastActivityAt } : s; });
        this.setAvailable(true);
        await this.listen();
      } catch (error) {
        if (this.available !== true) this.setAvailable(false, error?.message || String(error));
      } finally { this._refreshing = null; }
      this.changed();
    })();
    return this._refreshing;
  }
  setAvailable(ok, reason = '') { this.available = ok; this.reason = ok ? '' : reason; }
  scheduleRefresh(ms = 1200) { clearTimeout(this._refreshTimer); this._refreshTimer = setTimeout(() => this.refresh(), ms); }

  async listen() {
    if (this._listening) return;
    this._listening = true;
    try { this._unlisten = await desktop.onSessionEvent(raw => this.onEvent(raw)); }
    catch (error) { this._listening = false; throw error; }
  }

  session(id) { return this.list.find(s => s.id === id) || null; }

  onEvent(raw) {
    const e = raw && typeof raw === 'object' && raw.payload && typeof raw.payload === 'object' ? raw.payload : raw;
    if (!e || typeof e.id !== 'string' || typeof e.kind !== 'string') return;
    const s = this.session(e.id);
    if (s) {
      s.lastActivityAt = e.at || Date.now();
      if (e.kind === 'status' && typeof e.status === 'string') s.status = e.status;
      else if (e.kind === 'done') { if (s.status === 'running') s.status = 'idle'; }
      else if (e.kind === 'user' || e.kind === 'delta' || e.kind === 'tool') s.status = 'running';
    }
    if (!s || e.kind === 'done' || e.kind === 'status') this.scheduleRefresh();   // provider ids arrive after the first turn
    const pending = this.pending.get(e.id);
    if (pending?.length) {
      if (e.kind === 'user') {
        const i = pending.findIndex(p => p.turnId && p.turnId === e.turnId);
        pending.splice(i >= 0 ? i : Math.max(0, pending.findIndex(p => !p.turnId)), 1);
      } else if (e.kind === 'done' || e.kind === 'error') for (const p of pending) if (p.turnId && p.turnId === e.turnId) p.done = true;
    }
    const log = this.logs.get(e.id);
    if (log?.state === 'loaded') this.append(log, e);
    else if (log?.state === 'loading') log.buffer.push(e);
    if (!this.viewing.has(e.id) && (e.kind === 'message' || e.kind === 'done' || e.kind === 'error')) this.unread.add(e.id);
    this.changed();
  }

  append(log, e) {
    if (e.kind === 'message') log.events = log.events.filter(x => !(x.kind === 'delta' && (x.turnId ?? '') === (e.turnId ?? '')));
    log.events.push(e);
    if (log.events.length > MAX_EVENTS) log.events.splice(0, log.events.length - MAX_EVENTS);
    log.version += 1;
  }

  /** Loads a session's display log once (then live events keep it current). A failed load retries after 15 s at most. */
  async load(id) {
    const existing = this.logs.get(id);
    if (existing && (existing.state !== 'error' || Date.now() - existing.failedAt < 15e3)) return;
    const log = { state: 'loading', events: [], buffer: [], version: 0, error: '', cache: null };
    this.logs.set(id, log);
    this.changed();
    try {
      const data = await desktop.sessionHistory({ id, limit: HISTORY_LIMIT });
      const events = (Array.isArray(data?.events) ? data.events : []).filter(e => e && typeof e === 'object');
      const seen = new Set(events.map(eventSig));
      log.events = compactEvents([...events, ...log.buffer.filter(e => !seen.has(eventSig(e)))]);
      log.state = 'loaded';
    } catch (error) {
      log.state = 'error'; log.error = error?.message || String(error); log.failedAt = Date.now();
    }
    log.buffer = []; log.version += 1;
    this.changed();
  }

  /** { items, openTurn, lastAt } for a loaded session, plus its pending (sent, not yet echoed) messages. */
  transcript(id) {
    const s = this.session(id), log = this.logs.get(id);
    const pending = this.pending.get(id) || [];
    const sig = `${log?.version ?? -1}|${pending.length}`;
    if (log && log.cache?.sig === sig) return log.cache.value;
    const built = log?.state === 'loaded' ? buildTranscript(log.events, { provider: s?.provider || '', sessionId: id }) : { items: [], openTurn: null, lastAt: 0 };
    for (const p of pending) built.items.push({ key: `${id}:p:${p.localId}`, kind: 'owner', provider: s?.provider || '', sessionId: id, turnId: p.turnId || '', at: p.at, text: stripContext(p.text), attachments: p.attachments, targets: [s?.provider || ''], pending: true });
    const value = { ...built, state: log?.state || 'none', error: log?.error || '' };
    if (log) log.cache = { sig, value };
    return value;
  }

  running(id) {
    const s = this.session(id);
    return s?.status === 'running' || (this.pending.get(id) || []).some(p => !p.done);
  }

  /** { provider, projectId, cwd, access, title, playwright, model?, effort?, sharedId? } → session */
  async start(options) {
    const data = await desktop.sessionStart(options);
    const s = data?.session;
    if (!s || typeof s.id !== 'string') throw new Error('The session did not start.');
    this.list = [...this.list.filter(x => x.id !== s.id), s];
    this.logs.set(s.id, { state: 'loaded', events: [], buffer: [], version: 1, error: '', cache: null });
    this.changed();
    return s;
  }

  async send(id, text, attachments = []) {
    const entry = { localId: crypto.randomUUID(), text, attachments, at: Date.now(), turnId: null, done: false };
    if (!this.pending.has(id)) this.pending.set(id, []);
    this.pending.get(id).push(entry);
    this.changed();
    try {
      const data = await desktop.sessionSend({ id, text, ...(attachments.length ? { attachments } : {}) });
      entry.turnId = data?.turnId || null;
      const s = this.session(id);
      if (s && s.status !== 'running') { s.status = 'running'; s.lastActivityAt = Date.now(); }
      return data;
    } catch (error) {
      const list = this.pending.get(id) || [];
      list.splice(list.indexOf(entry), 1);
      throw error;
    } finally { this.changed(); }
  }

  async stop(id) { await desktop.sessionStop({ id }); }

  async close(id) {
    await desktop.sessionClose({ id });
    const s = this.session(id);
    if (s) s.status = 'stopped';
    this.changed();
    this.scheduleRefresh(300);
  }

  /** The session ids open in Chat right now: their replies are not marked unread. */
  view(ids) { this.viewing = new Set(ids); for (const id of ids) this.unread.delete(id); }
}

export const sessions = new Sessions();
