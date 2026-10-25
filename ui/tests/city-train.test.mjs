import assert from 'node:assert/strict';
import test from 'node:test';
import { trainInterval, nextTrainAt, selectTrainCars, trainPass, crossingWarning } from '../app/city/train.js';

const now = Date.parse('2026-10-25T12:00:00Z');
const project = (id, git) => ({ id, name: `Project ${id}`, stats: { git } });

test('train schedule samples the entire 90 to 180 second range deterministically', () => {
  assert.equal(trainInterval(0), 90);
  assert.equal(trainInterval(0.5), 135);
  assert.equal(trainInterval(1), 180);
  assert.equal(trainInterval(-1), 90);
  assert.equal(trainInterval(2), 180);
  assert.equal(trainInterval(NaN), 135);
  assert.equal(nextTrainAt(50, 0), 140);
  assert.equal(nextTrainAt(50, 1), 230);
});

test('train cars prefer fresh dated commits and fall back only when a commit date is unavailable', () => {
  const input = [
    project('old', { last_commit_at: '2026-10-23T12:00:00Z', commits_7d: 20 }),
    project('weekly', { commits_7d: 5 }),
    project('recent', { last_commit_at: '2026-10-25T11:00:00Z', commits_7d: 1 }),
    project('boundary', { last_commit_at: '2026-10-24T12:00:00Z' }),
    project('future', { last_commit_at: '2026-10-26T12:00:00Z', commits_7d: 10 }),
    project('invalid', { last_commit_at: 'bad date', commits_7d: 2 }),
    project('empty', { commits_7d: 0 }),
  ];
  assert.deepEqual(selectTrainCars(input, now).map(c => c.projectId), ['recent', 'boundary', 'weekly', 'invalid']);
  assert.equal(input[0].id, 'old');
});

test('train loads at most six distinct project cars and accepts timestamp seconds', () => {
  const input = Array.from({ length: 9 }, (_, i) => project(`p${i}`, { last_commit_at: now / 1000 - i }));
  assert.equal(selectTrainCars([...input, input[0]], now).length, 6);
  assert.deepEqual(selectTrainCars(input, now, 2).map(c => c.projectId), ['p0', 'p1']);
  assert.deepEqual(selectTrainCars(input, now, 0), []);
});

test('no activity pulls empty wagons and does not imply commits', () => {
  assert.deepEqual(selectTrainCars([project('none', {})], now), [
    { projectId: null, label: '' }, { projectId: null, label: '' }, { projectId: null, label: '' },
  ]);
  assert.deepEqual(selectTrainCars([], now, 1), [{ projectId: null, label: '' }]);
});

test('crossing lights start four seconds before arrival and stop after the last wagon', () => {
  const startedAt = 100, half = 30, crossing = 0, cars = 6;
  const arrival = startedAt + (crossing + half + 3.2) / 8;
  assert.equal(crossingWarning(arrival - 4.01, startedAt, crossing, half, cars), false);
  assert.equal(crossingWarning(arrival - 4, startedAt, crossing, half, cars), true);
  assert.equal(crossingWarning(arrival, startedAt, crossing, half, cars), true);
  assert.equal(crossingWarning(arrival + 4, startedAt, crossing, half, cars), false);
  assert.equal(crossingWarning(arrival, NaN, crossing, half, cars), false);
});

test('a pass completes only when the trailing wagon clears the far portal', () => {
  const first = trainPass(100, 100, 30, 6);
  assert.equal(first.x, -33.2);
  assert.equal(first.done, false);
  assert.equal(trainPass(110, 100, 30, 6).done, false);
  assert.equal(trainPass(113, 100, 30, 6).done, true);
});
