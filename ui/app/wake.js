/* Wake on mail (0.4.1; 0.5 removed the caps). A session with wake on has its own board address; the engine
 * checks the inboxes of all such sessions every 60 s and sends each new message to its session as a turn.
 * New sessions start with wake on (0.5); the global switch (default on) can stop every wake. There is no
 * limit on how many sessions wake or how often, only the owner's loop guard: two CodaClauda sessions that
 * woke each other pairPerHour times in the last hour wait until older wakes age out, and the owner is told.
 *
 * Calls go through bridge.js desktop.* with feature detection:
 *   wakeSettingsGet() → { enabled, loopGuard: { on, pairPerHour } }
 *   wakeSettingsSet({ enabled?, loopGuard? }) → same
 *   sessionSetWake({ id, on }) → { session }  (records gain wake, mailboxAddress, wakes:{ hour, day, total })
 * Events: wake.on('change', fn). */
import { desktop } from './bridge.js';
import { sessions } from './sessions.js';

export const WAKE_POLL_SECONDS = 60;
export const LOOP_GUARD_DEFAULT = Object.freeze({ on: true, pairPerHour: 20 });
export const WAKE_UNAVAILABLE_TEXT = 'Wake on mail needs CodaClauda 0.4.1 desktop';

/** A saved guard, or the default for anything malformed. */
export function normalizeGuard(value) {
  const g = value && typeof value === 'object' ? value : {};
  const n = Number(g.pairPerHour);
  return { on: typeof g.on === 'boolean' ? g.on : LOOP_GUARD_DEFAULT.on, pairPerHour: Number.isSafeInteger(n) && n >= 1 ? n : LOOP_GUARD_DEFAULT.pairPerHour };
}

/** The one-line explanation of the guard shown in Settings. */
export function guardText(guard) {
  const g = normalizeGuard(guard);
  return g.on
    ? `Loop guard on: two CodaClauda sessions that woke each other ${g.pairPerHour} times in the last hour pause waking each other until older wakes age out, and you get a notice. Your own messages never count.`
    : 'Loop guard off: sessions can wake each other without any limit.';
}

class Wake extends EventTarget {
  constructor() {
    super();
    this.enabled = null;     // null = unknown (not loaded, or this build has no wake commands)
    this.loopGuard = null;   // { on, pairPerHour } once loaded
    this.error = '';
    this._loading = null;
  }

  on(name, fn) { const handler = event => fn(event.detail); this.addEventListener(name, handler); return () => this.removeEventListener(name, handler); }
  changed() { this.dispatchEvent(new CustomEvent('change')); }
  supported() { return typeof desktop.wakeSettingsGet === 'function' && typeof desktop.wakeSettingsSet === 'function'; }
  sessionSupported() { return typeof desktop.sessionSetWake === 'function'; }

  /** Reads the global switch and loop guard; safe to call repeatedly. */
  async load() {
    if (!this.supported()) { if (this.enabled !== null) { this.enabled = null; this.changed(); } return; }
    if (this._loading) return this._loading;
    this._loading = (async () => {
      try { this.apply(await desktop.wakeSettingsGet()); this.error = ''; }
      catch (error) { this.enabled = null; this.loopGuard = null; this.error = error?.message || String(error); }
      finally { this._loading = null; }
      this.changed();
    })();
    return this._loading;
  }

  apply(data) {
    this.enabled = data?.enabled !== false;
    this.loopGuard = normalizeGuard(data?.loopGuard);
  }

  async save(patch) {
    try {
      const data = await desktop.wakeSettingsSet(patch);
      if (typeof data?.enabled !== 'boolean') throw new Error('Wake settings did not confirm the change.');
      this.apply(data);
      this.error = '';
      return data;
    } catch (error) {
      this.enabled = null;
      this.error = error?.message || String(error);
      throw error;
    } finally { this.changed(); }
  }

  async setEnabled(enabled) { return (await this.save({ enabled: Boolean(enabled) })).enabled; }

  /** { on?, pairPerHour? } → the saved guard. */
  async setLoopGuard(guard) { await this.save({ loopGuard: guard }); return this.loopGuard; }

  /** Turns one session's wake on or off → the updated session record. */
  async setSession(id, on) {
    const data = await desktop.sessionSetWake({ id, on: Boolean(on) });
    const session = data?.session;
    if (!session || typeof session.id !== 'string') throw new Error('The session did not confirm the change.');
    sessions.upsert(session);
    this.changed();
    return session;
  }
}

/** "3 this hour · 5 today · 12 in all" for a session record. */
export function wakeCounts(session) {
  const w = session?.wakes && typeof session.wakes === 'object' ? session.wakes : {};
  const n = value => Math.max(0, Number(value) || 0);
  return `${n(w.hour)} this hour · ${n(w.day)} today · ${n(w.total)} in all`;
}

export const wake = new Wake();
