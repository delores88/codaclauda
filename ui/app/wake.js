/* Wake on mail (0.4.1; 0.5 removed the caps). A session with wake on has its own board address; the engine
 * checks the inboxes of all such sessions every 10 s (0.6) and sends each new message to its session as a turn.
 * New sessions start with wake on (0.5); the global switch (default on) can stop every wake. There is no
 * limit on how many sessions wake or how often, only the owner's loop guard: when two CodaClauda sessions
 * woke each other pairPerHour times in the last hour the owner is told; in 'pause' mode (0.5) they also wait
 * until older wakes age out, in 'notify' mode (0.6 default) they keep going.
 *
 * Calls go through bridge.js desktop.* with feature detection:
 *   wakeSettingsGet() → { enabled, loopGuard: { on, mode: 'notify'|'pause', pairPerHour } }
 *   wakeSettingsSet({ enabled?, loopGuard? }) → same
 *   sessionSetWake({ id, on }) → { session }  (records gain wake, mailboxAddress, wakes:{ hour, day, total })
 * Events: wake.on('change', fn). */
import { desktop } from './bridge.js';
import { sessions } from './sessions.js';

export const WAKE_POLL_SECONDS = 10;
export const LOOP_GUARD_DEFAULT = Object.freeze({ on: true, mode: 'notify', pairPerHour: 60 });
export const WAKE_UNAVAILABLE_TEXT = 'Wake on mail needs CodaClauda 0.4.1 desktop';

/** A saved guard, or the default for anything malformed. */
export function normalizeGuard(value) {
  const g = value && typeof value === 'object' ? value : {};
  const n = Number(g.pairPerHour);
  return {
    on: typeof g.on === 'boolean' ? g.on : LOOP_GUARD_DEFAULT.on,
    mode: g.mode === 'pause' || g.mode === 'notify' ? g.mode : LOOP_GUARD_DEFAULT.mode,
    pairPerHour: Number.isSafeInteger(n) && n >= 1 ? n : LOOP_GUARD_DEFAULT.pairPerHour,
  };
}

/** The one-line explanation of the guard shown in Settings. */
export function guardText(guard) {
  const g = normalizeGuard(guard);
  if (!g.on) return 'Loop guard off: sessions can wake each other without any limit or notice.';
  return g.mode === 'pause'
    ? `Loop guard on, Pause: two CodaClauda sessions that woke each other ${g.pairPerHour} times in the last hour pause waking each other until older wakes age out, and you get a notice. Your own messages never count.`
    : `Loop guard on, Notify: when two CodaClauda sessions woke each other ${g.pairPerHour} times in the last hour you get one notice; they keep waking each other. Your own messages never count.`;
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
