/* Is the DGX Spark reachable right now? Only an explicit, authenticated remote answer counts.
 * A local sparkdev reply that says remote_available: false, any remote_error, a missing or
 * unauthenticated transport, or a check older than SPARK_STALE_MS all read as offline:
 * unknown fails closed, so the City never lights the Spark side on a guess. Pure, no imports. */
export const SPARK_STALE_MS = 60000;   // four missed 15 s polls

export function sparkLink(status) {
  if (!status || typeof status !== 'object') return { reachable: false, error: 'DGXBridge returned no status.' };
  const remote = status.remote_error;
  const remoteError = remote ? String((typeof remote === 'object' ? remote.message || remote.code : remote) || 'The Spark is unavailable.') : '';
  const reachable = status.ok !== false && status.remote_available !== false && !remoteError && status.transport?.authenticated === true;
  if (reachable) return { reachable, error: '' };
  const error = remoteError
    || (status.ok === false ? String(status.error?.message || status.error || 'DGXBridge reported an error.') : '')
    || (status.remote_available === false ? 'The Spark is not reachable.' : 'The Spark did not confirm an authenticated connection.');
  return { reachable, error };
}

/** A check is current only if it finished within SPARK_STALE_MS. */
export function sparkFresh(checkedAt, now = Date.now()) {
  return Number(checkedAt) > 0 && now - Number(checkedAt) < SPARK_STALE_MS;
}

const DONE = new Set(['succeeded', 'failed', 'cancelled', 'canceled', 'timeout', 'timed_out', 'error', 'rejected', 'expired', 'completed']);
const onSpark = job => job?.where === 'spark' || job?.machine === 'spark';

/** Running now? Unfinished, and a Spark job only while the Spark is online: offline (failed, stale or
 *  remote-unavailable check), jobs kept from the last good check are history, not current work. */
export function jobRunning(job, online) {
  if (!job || job.finished_at || DONE.has(String(job.state || '').toLowerCase())) return false;
  return !onSpark(job) || Boolean(online);
}

/** End (seconds) for core-hour accounting: finished_at, else now; an unfinished Spark job stops
 *  accruing at the last confirmed check (lastOkAt, ms) while the Spark is offline. */
export function jobEndSec(job, { online, lastOkAt = 0, now }) {
  const finished = Number(job?.finished_at) || 0;
  if (finished) return finished;
  return onSpark(job) && !online ? (Number(lastOkAt) || 0) / 1000 : now;
}
