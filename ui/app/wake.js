/* Wake on mail (0.4.1). A session with wake on gets its own board address; the engine checks the
 * inboxes of all such sessions every 60 s and sends each new message to its session as a turn.
 * The global switch (default on) can stop every wake; each session starts with wake off.
 *
 * Calls go through bridge.js desktop.* with feature detection (the engine track owns the wrappers):
 *   wakeSettingsGet() → { enabled }       wakeSettingsSet({ enabled }) → { enabled }
 *   sessionSetWake({ id, on }) → { session }  (records gain wake, mailboxAddress, wakes:{ hour, day, total })
 * Events: wake.on('change', fn). */
import { desktop } from './bridge.js';
import { sessions } from './sessions.js';

export const WAKE_LIMITS = { sessions: 5, perHour: 6, perDay: 30, pairPerHour: 3, pollSeconds: 60 };
export const WAKE_CAPS_TEXT = `Up to ${WAKE_LIMITS.sessions} sessions wake on mail, each at most ${WAKE_LIMITS.perHour} times an hour and ${WAKE_LIMITS.perDay} a day; two CodaClauda sessions wake each other at most ${WAKE_LIMITS.pairPerHour} times an hour (your owner messages skip only that limit).`;
export const WAKE_UNAVAILABLE_TEXT = 'Wake on mail needs CodaClauda 0.4.1 desktop';

class Wake extends EventTarget {
  constructor() {
    super();
    this.enabled = null;     // null = unknown (not loaded, or this build has no wake commands)
    this.error = '';
    this._loading = null;
  }

  on(name, fn) { const handler = event => fn(event.detail); this.addEventListener(name, handler); return () => this.removeEventListener(name, handler); }
  changed() { this.dispatchEvent(new CustomEvent('change')); }
  supported() { return typeof desktop.wakeSettingsGet === 'function' && typeof desktop.wakeSettingsSet === 'function'; }
  sessionSupported() { return typeof desktop.sessionSetWake === 'function'; }

  /** Reads the global switch; safe to call repeatedly. */
  async load() {
    if (!this.supported()) { if (this.enabled !== null) { this.enabled = null; this.changed(); } return; }
    if (this._loading) return this._loading;
    this._loading = (async () => {
      try { const data = await desktop.wakeSettingsGet(); this.enabled = data?.enabled !== false; this.error = ''; }
      catch (error) { this.enabled = null; this.error = error?.message || String(error); }
      finally { this._loading = null; }
      this.changed();
    })();
    return this._loading;
  }

  async setEnabled(enabled) {
    try {
      const data = await desktop.wakeSettingsSet({ enabled: Boolean(enabled) });
      if (typeof data?.enabled !== 'boolean') throw new Error('Wake settings did not confirm the change.');
      this.enabled = data.enabled;
      this.error = '';
      return this.enabled;
    } catch (error) {
      this.enabled = null;
      this.error = error?.message || String(error);
      throw error;
    } finally { this.changed(); }
  }

  /** Sessions with wake on, other than `exceptId`. */
  count(exceptId = null) { return sessions.list.filter(s => s.wake === true && s.id !== exceptId).length; }

  /** Turns one session's wake on or off → the updated session record. */
  async setSession(id, on) {
    if (on && this.count(id) >= WAKE_LIMITS.sessions) throw new Error(`At most ${WAKE_LIMITS.sessions} sessions can wake on mail. Turn it off in another session first.`);
    const data = await desktop.sessionSetWake({ id, on: Boolean(on) });
    const session = data?.session;
    if (!session || typeof session.id !== 'string') throw new Error('The session did not confirm the change.');
    sessions.upsert(session);
    this.changed();
    return session;
  }
}

/** "3/6 this hour · 5/30 today · 12 in all" for a session record. */
export function wakeCounts(session) {
  const w = session?.wakes && typeof session.wakes === 'object' ? session.wakes : {};
  const n = value => Math.max(0, Number(value) || 0);
  return `${n(w.hour)}/${WAKE_LIMITS.perHour} this hour · ${n(w.day)}/${WAKE_LIMITS.perDay} today · ${n(w.total)} in all`;
}

export const wake = new Wake();
