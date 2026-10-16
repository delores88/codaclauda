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
