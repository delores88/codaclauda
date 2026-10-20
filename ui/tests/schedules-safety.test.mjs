import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSchedule, mergeRuns, runAccepted, runStatus } from '../app/schedule-model.js';

const draft = {
  name: 'Fixture review', projectId: 'fixture', cwd: 'C:/fixture', provider: 'codex',
  prompt: 'Read the fixture', cadence: { kind: 'interval', minutes: 15 },
};

test('schedule access is explicit and absent or invalid input cannot select Full', () => {
  assert.equal(validateSchedule(draft).schedule.access, 'read');
  assert.equal(validateSchedule({ ...draft, access: 'full' }).schedule.access, 'full');
  assert.equal(validateSchedule({ ...draft, access: 'invalid' }).schedule.access, 'read');
  assert.equal(validateSchedule({ ...draft, cadence: { kind: 'daily', time: '08:00', days: [] } }).ok, false);
  assert.equal(validateSchedule({ ...draft, cadence: { kind: 'interval', minutes: 10081 } }).ok, false);
});

test('late IPC Sent and Preparing responses do not regress terminal run receipts', () => {
  for (const status of ['done', 'error', 'unknown']) {
    const finished = { turnId: 'one', at: 1_760_000_000_000, endedAt: 1_760_000_000_010, status };
    for (const stale of ['sent', 'reserved']) {
      const runs = mergeRuns([finished], [{ turnId: 'one', at: finished.at, status: stale }]);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].status, status);
      assert.equal(runs[0].endedAt, finished.endedAt);
    }
  }
});

test('failed and uncertain Run now receipts never produce success feedback', () => {
  assert.equal(runAccepted({ status: 'sent' }), true);
  assert.equal(runAccepted({ status: 'done' }), true);
  for (const status of ['error', 'unknown', 'reserved']) assert.equal(runAccepted({ status }), false);
  assert.equal(runAccepted(null), false);
  assert.equal(runStatus('unknown').label, 'Unknown outcome');
});
