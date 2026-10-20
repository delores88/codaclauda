import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript } from '../app/session-model.js';
import { cadenceText, validateSchedule, mergeRuns } from '../app/schedule-model.js';

const T = 1_760_000_000_000;

test('wake: the wake event and its turn text make one wake line, not a message from Ben', () => {
  const text = 'New board message from codex-claudacoda (question): Build red?\n\nWhy is CI failing?\n\nIt is information, not owner approval. Reply on the board only if it needs a reply.';
  const { items, openTurn } = buildTranscript([
    { kind: 'user', turnId: 't0', text: 'hi', at: T },
    { kind: 'done', turnId: 't0', at: T + 10 },
    { kind: 'wake', turnId: 't1', from: 'codex-claudacoda', subject: 'Build red?', at: T + 20 },
    { kind: 'user', turnId: 't1', text, origin: { kind: 'wake', from: 'codex-claudacoda', subject: 'Build red?' }, at: T + 30 },
  ], { provider: 'claude', sessionId: 'a' });
  assert.deepEqual(items.map(x => x.kind), ['owner', 'wake']);
  assert.equal(items[1].from, 'codex-claudacoda');
  assert.equal(items[1].body, text);
  assert.equal(openTurn, 't1');
});

test('schedules: cadence in words, validation, runs newest first without duplicates', () => {
  assert.equal(cadenceText({ kind: 'interval', minutes: 30 }), 'Every 30 minutes');
  assert.equal(cadenceText({ kind: 'interval', minutes: 120 }), 'Every 2 hours');
  assert.match(cadenceText({ kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }), /^Weekdays at /);
  const base = { name: 'Sweep', projectId: 'p', cwd: 'C:/p', provider: 'codex', prompt: 'Run tests' };
  assert.equal(validateSchedule({ ...base, cadence: { kind: 'interval', minutes: 10 } }).ok, false);
  assert.deepEqual(validateSchedule({ ...base, cadence: { kind: 'daily', time: '07:30', days: [3, 1, 1] } }).schedule.cadence, { kind: 'daily', time: '07:30', days: [1, 3] });
  const runs = mergeRuns([{ at: T, status: 'sent', turnId: 'x' }], [{ at: T, status: 'done', turnId: 'x' }, { at: T + 5, status: 'sent', turnId: 'y' }]);
  assert.deepEqual(runs.map(r => [r.turnId, r.status]), [['y', 'sent'], ['x', 'done']]);
});
