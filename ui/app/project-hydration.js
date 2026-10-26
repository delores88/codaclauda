/* Bounded UI waits. Native invocations cannot be cancelled: a timed-out wait must
 * not release its physical request slot or spawn another copy of the operation. */
export const CITY_HYDRATION_MS = 3000;
export const PROJECT_REQUEST_MS = 10000;
export const PROJECT_SCAN_CONCURRENCY = 4;

export function withTimeout(promise, milliseconds = PROJECT_REQUEST_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('Project metadata request timed out.');
      error.code = 'TIMEOUT'; reject(error);
    }, milliseconds);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/** Limit actual operations, including those whose UI wait has already expired. */
export function createRequestPool(concurrency = PROJECT_SCAN_CONCURRENCY) {
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1)), queue = [];
  let active = 0;
  const drain = () => {
    while (active < limit && queue.length) {
      const { operation, resolve, reject } = queue.shift(); active++;
      Promise.resolve().then(operation).then(
        value => { active--; resolve(value); drain(); },
        error => { active--; reject(error); drain(); },
      );
    }
  };
  return {
    run(operation) { return new Promise((resolve, reject) => { queue.push({ operation, resolve, reject }); drain(); }); },
    get active() { return active; }, get queued() { return queue.length; },
  };
}
