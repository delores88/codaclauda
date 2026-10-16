import test from 'node:test';
import assert from 'node:assert/strict';
import { sparkLink, sparkFresh, SPARK_STALE_MS, jobRunning, jobEndSec } from '../app/spark-link.js';

const healthy = { ok: true, transport: { authenticated: true, route: 'lan_ssh' }, jobs: [] };

test('an authenticated remote answer is reachable', () => {
  assert.deepEqual(sparkLink(healthy), { reachable: true, error: '' });
});

test('the real offline reply (local ok, remote unavailable) is offline', () => {
  const offline = { ok: true, laptop_jobs: [], remote_available: false, remote_error: { code: 4, message: 'Authenticated remote sidecar unavailable, busy or not paired; retry the same request ID' } };
  const link = sparkLink(offline);
  assert.equal(link.reachable, false);
  assert.match(link.error, /sidecar unavailable/);
});

test('unknown fails closed: missing transport or authentication is offline', () => {
  assert.equal(sparkLink({ ok: true }).reachable, false);
  assert.equal(sparkLink({ ok: true, transport: {} }).reachable, false);
  assert.equal(sparkLink({ ok: true, transport: { authenticated: false } }).reachable, false);
  assert.equal(sparkLink(null).reachable, false);
});

test('remote_available false or a remote_error overrides an authenticated transport', () => {
  assert.equal(sparkLink({ ...healthy, remote_available: false }).reachable, false);
  assert.equal(sparkLink({ ...healthy, remote_error: 'busy' }).reachable, false);
  assert.equal(sparkLink({ ...healthy, ok: false }).reachable, false);
});

test('a check older than the stale window is not current', () => {
  const now = 1_000_000;
  assert.equal(sparkFresh(now - 1000, now), true);
  assert.equal(sparkFresh(now - SPARK_STALE_MS, now), false);
  assert.equal(sparkFresh(0, now), false);
});

// Regression (0.3.2 review): a Spark job kept from the last good check must not stay "running" or keep
// reserving / accruing cores once the Spark is offline, whether the check threw or went stale.
const remote = { job: 'j1', where: 'spark', state: 'running', started_at: 1000, reserved_cpu: 8 };
const laptop = { job: 'j5', where: 'laptop', state: 'running', started_at: 1000, reserved_cpu: 6 };

test('online: an unfinished Spark job is running and accrues to now', () => {
  assert.equal(jobRunning(remote, true), true);
  assert.equal(jobEndSec(remote, { online: true, lastOkAt: 2_000_000, now: 5000 }), 5000);
});

test('check threw (online false): the retained Spark job is history, stopped at the last good check', () => {
  const online = Boolean(true && /* ok after a throw */ false && sparkFresh(4_900_000, 5_000_000));
  assert.equal(jobRunning(remote, online), false);
  assert.equal(jobEndSec(remote, { online, lastOkAt: 2_000_000, now: 5000 }), 2000);
});

test('stale for 61 s (online false): same, and This PC jobs are unaffected', () => {
  const lastCheck = 1_000_000, now = lastCheck + 61_000;
  const online = Boolean(true && true && sparkFresh(lastCheck, now));
  assert.equal(online, false);
  assert.equal(jobRunning(remote, online), false);
  assert.equal(jobRunning(laptop, online), true);
  assert.equal(jobEndSec(laptop, { online, lastOkAt: lastCheck, now: now / 1000 }), now / 1000);
});

test('finished jobs never run and keep their own end time', () => {
  const done = { ...remote, state: 'succeeded', finished_at: 1500 };
  assert.equal(jobRunning(done, true), false);
  assert.equal(jobEndSec(done, { online: false, lastOkAt: 0, now: 5000 }), 1500);
});
