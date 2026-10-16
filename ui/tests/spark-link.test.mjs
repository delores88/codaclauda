import test from 'node:test';
import assert from 'node:assert/strict';
import { sparkLink, sparkFresh, SPARK_STALE_MS } from '../app/spark-link.js';

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
