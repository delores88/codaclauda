import test from 'node:test';
import assert from 'node:assert/strict';
import { grantLimits } from '../app/views/connect.js';
import { limitValue, LIMIT_RANGES } from '../app/views/settings-limits.js';

const form = { max_requests: '100', max_delegations: '20', max_hops: '2', run_hours: '8', max_turns: '200', expiry_days: '7' };

test('grant form sends generous defaults and converts hours and days to seconds', () => {
  assert.deepEqual(grantLimits(form), { max_requests: 100, max_delegations: 20, max_hops: 2, timeout_seconds: 28800, max_turns: 200, expires_seconds: 604800 });
  const top = grantLimits({ ...form, max_requests: '100000', max_hops: '16', run_hours: '720', max_turns: '10000', expiry_days: '365' });
  assert.equal(top.timeout_seconds, 2592000);
  assert.equal(top.expires_seconds, 31536000);
  assert.equal(grantLimits({ ...form, run_hours: '0.1', expiry_days: '0.1' }).timeout_seconds, 360);
  for (const [key, value] of [['max_requests', '100001'], ['max_hops', '17'], ['run_hours', '721'], ['max_turns', '1.5'], ['expiry_days', ''], ['max_delegations', '-1']]) {
    assert.throws(() => grantLimits({ ...form, [key]: value }), /must be/, key);
  }
});

test('Settings limits accept whole numbers within each owner range', () => {
  assert.equal(limitValue('6', LIMIT_RANGES.maxLive), 6);
  assert.equal(limitValue('32', LIMIT_RANGES.maxLive), 32);
  assert.equal(limitValue('64', LIMIT_RANGES.concurrent), 64);
  for (const bad of ['0', '33', '2.5', '', 'x']) assert.equal(limitValue(bad, LIMIT_RANGES.maxLive), null, bad);
});
