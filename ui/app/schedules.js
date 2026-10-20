/* CodaClauda schedules client (0.4.1): the schedule list, each schedule's run history and the
 * 'schedule://event' feed. Schedules run in process, only while CodaClauda is open; each one reuses a
 * dedicated session (created on its first run at the project's access level).
 *
 * Calls go through bridge.js desktop.* with feature detection (the engine track owns the wrappers):
 *   scheduleList() → { schedules }          scheduleSave({ schedule }) → { schedule } (no id = create)
 *   scheduleDelete({ id }) → { deleted }    scheduleRunNow({ id }) → { run }
 *   scheduleRuns({ id, limit }) → { runs }  onScheduleEvent(cb) for { id, kind: 'run'|'error', run }
 * Without those helpers (or when the build refuses them) `available` is false and the view says so.
 * Events: schedules.on('change', fn), schedules.on('event', fn). */
import { desktop } from './bridge.js';
import { mergeRuns } from './schedule-model.js';

const NEEDED = ['scheduleList', 'scheduleSave', 'scheduleDelete', 'scheduleRunNow', 'scheduleRuns'];
export const SCHEDULES_UNAVAILABLE_TEXT = 'Schedules need CodaClauda 0.4.1 desktop';
export const RUNS_SHOWN = 20;
const ms = value => { if (value == null || value === '') return 0; const n = typeof value === 'number' ? value : Number.isFinite(Number(value)) ? Number(value) : Date.parse(value); return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : 0; };

class Schedules extends EventTarget {
  constructor() {
    super();
    this.available = null;   // null = not checked yet
    this.reason = '';
    this.list = [];
    this.runs = new Map();   // id -> { state: 'loading'|'loaded'|'error', runs, error, limit }
    this._listening = false;
    this._refreshing = null;
    this._timer = 0;
  }

  on(name, fn) { const handler = event => fn(event.detail); this.addEventListener(name, handler); return () => this.removeEventListener(name, handler); }
  changed() { this.dispatchEvent(new CustomEvent('change')); }
  supported() { return NEEDED.every(name => typeof desktop[name] === 'function'); }
  schedule(id) { return this.list.find(s => s.id === id) || null; }
  scheduleRefresh(delay = 1500) { clearTimeout(this._timer); this._timer = setTimeout(() => this.refresh(), delay); }

  /** Loads the list (and each schedule's newest run); safe to call repeatedly. */
  async refresh() {
    if (!this.supported()) {
      if (this.available !== false) { this.available = false; this.reason = 'This build has no schedule commands.'; this.changed(); }
      return;
    }
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      try {
        const data = await desktop.scheduleList();
        this.list = (Array.isArray(data?.schedules) ? data.schedules : []).filter(s => s && typeof s.id === 'string');
        this.available = true; this.reason = '';
        this.listen().catch(() => {});
        const ids = new Set(this.list.map(s => s.id));
        for (const id of [...this.runs.keys()]) if (!ids.has(id)) this.runs.delete(id);
        // The list shows each schedule's last run status: fetch it when the cached runs are older.
        const stale = this.list.filter(s => ms(s.lastRunAt) && ms(this.runs.get(s.id)?.runs?.[0]?.at) < ms(s.lastRunAt));
        await Promise.allSettled(stale.map(s => this.loadRuns(s.id, this.runs.get(s.id)?.limit || 1, { quiet: true })));
      } catch (error) {
        if (this.available !== true) { this.available = false; this.reason = error?.message || String(error); }
      } finally { this._refreshing = null; }
      this.changed();
    })();
    return this._refreshing;
  }

  async listen() {
    if (this._listening) return;
    this._listening = true;
    try {
      const handler = raw => this.onEvent(raw);
      if (typeof desktop.onScheduleEvent === 'function') this._unlisten = await desktop.onScheduleEvent(handler);
      else if (window.__TAURI__?.event?.listen) this._unlisten = await window.__TAURI__.event.listen('schedule://event', event => handler(event.payload));
    } catch (error) { this._listening = false; throw error; }
  }

  onEvent(raw) {
    const e = raw && typeof raw === 'object' && raw.payload && typeof raw.payload === 'object' ? raw.payload : raw;
    if (!e || typeof e.id !== 'string') return;
    if (e.run && typeof e.run === 'object') this.addRun(e.id, e.run);
    const s = this.schedule(e.id);
    if (s && e.run?.at && ms(e.run.at) > ms(s.lastRunAt)) s.lastRunAt = e.run.at;
    this.dispatchEvent(new CustomEvent('event', { detail: e }));
    this.scheduleRefresh();   // nextRunAt moves after each run
    this.changed();
  }

  addRun(id, run) {
    const entry = this.runs.get(id) || { state: 'loaded', runs: [], error: '', limit: 1 };
    entry.runs = mergeRuns(entry.runs, [run]).slice(0, Math.max(RUNS_SHOWN, entry.limit || 1));
    if (entry.state !== 'loaded' && entry.runs.length) entry.state = 'loaded';
    this.runs.set(id, entry);
  }

  /** Loads up to `limit` runs, newest first. */
  async loadRuns(id, limit = RUNS_SHOWN, { quiet = false } = {}) {
    const entry = this.runs.get(id) || { state: 'loading', runs: [], error: '', limit: 0 };
    entry.limit = Math.max(entry.limit || 0, limit);
    if (!entry.runs.length && entry.state !== 'loaded') entry.state = 'loading';
    this.runs.set(id, entry);
    if (!quiet) this.changed();
    try {
      const data = await desktop.scheduleRuns({ id, limit: entry.limit });
      entry.runs = mergeRuns([], Array.isArray(data?.runs) ? data.runs : []).slice(0, entry.limit);
      entry.state = 'loaded'; entry.error = '';
    } catch (error) {
      entry.state = 'error'; entry.error = error?.message || String(error);
    }
    if (!quiet) this.changed();
  }

  /** The newest known run of a schedule, or null. */
  lastRun(s) {
    const cached = this.runs.get(s.id)?.runs?.[0] || null;
    const own = s.lastRun && typeof s.lastRun === 'object' ? s.lastRun : null;
    if (own && (!cached || ms(own.at) > ms(cached.at))) return own;
    if (cached) return cached;
    return s.lastRunStatus ? { at: s.lastRunAt, status: s.lastRunStatus } : null;
  }

  async save(schedule) {
    const data = await desktop.scheduleSave({ schedule });
    const saved = data?.schedule;
    if (!saved || typeof saved.id !== 'string') throw new Error('The schedule was not saved.');
    this.list = this.schedule(saved.id) ? this.list.map(s => (s.id === saved.id ? saved : s)) : [...this.list, saved];
    this.changed();
    return saved;
  }

  async remove(id) {
    await desktop.scheduleDelete({ id });
    this.list = this.list.filter(s => s.id !== id);
    this.runs.delete(id);
    this.changed();
  }

  async runNow(id) {
    const data = await desktop.scheduleRunNow({ id });
    const run = data?.run && typeof data.run === 'object' ? data.run : null;
    if (run) {
      this.addRun(id, run);
      const s = this.schedule(id);
      if (s && run.at) s.lastRunAt = run.at;
    }
    this.changed();
    this.scheduleRefresh(800);
    return run;
  }
}

export const schedules = new Schedules();
