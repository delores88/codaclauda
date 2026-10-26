import assert from 'node:assert/strict';
import test from 'node:test';
import { boatInterval, nextBoatAt, selectBoatManifest, boatPass } from '../app/city/boats.js';

const now = Date.parse('2026-10-25T12:00:00Z');
const project = (id, git) => ({ id, name: `Project ${id}`, stats: { git } });

test('boat schedule samples the entire 90 to 180 second range deterministically', () => {
  assert.equal(boatInterval(0), 90);
  assert.equal(boatInterval(0.5), 135);
  assert.equal(boatInterval(1), 180);
  assert.equal(boatInterval(-1), 90);
  assert.equal(boatInterval(2), 180);
  assert.equal(boatInterval(NaN), 135);
  assert.equal(nextBoatAt(50, 0), 140);
  assert.equal(nextBoatAt(50, 1), 230);
});

test('boats prefer fresh dated commits and fall back only when a commit date is unavailable', () => {
  const input = [
    project('old', { last_commit_at: '2026-10-23T12:00:00Z', commits_7d: 20 }),
    project('weekly', { commits_7d: 5 }),
    project('recent', { last_commit_at: '2026-10-25T11:00:00Z', commits_7d: 1 }),
    project('boundary', { last_commit_at: '2026-10-24T12:00:00Z' }),
    project('future', { last_commit_at: '2026-10-26T12:00:00Z', commits_7d: 10 }),
    project('invalid', { last_commit_at: 'bad date', commits_7d: 2 }),
    project('empty', { commits_7d: 0 }),
  ];
  assert.deepEqual(selectBoatManifest(input, now).map(c => c.projectId), ['recent', 'boundary', 'weekly', 'invalid']);
  assert.equal(input[0].id, 'old');
});

test('boat loads at most six distinct project boats and accepts timestamp seconds', () => {
  const input = Array.from({ length: 9 }, (_, i) => project(`p${i}`, { last_commit_at: now / 1000 - i }));
  assert.equal(selectBoatManifest([...input, input[0]], now).length, 6);
  assert.deepEqual(selectBoatManifest(input, now, 2).map(c => c.projectId), ['p0', 'p1']);
  assert.deepEqual(selectBoatManifest(input, now, 0), []);
});

test('no activity sends unlabelled boats and does not imply commits', () => {
  assert.deepEqual(selectBoatManifest([project('none', {})], now), [
    { projectId: null, label: '' }, { projectId: null, label: '' },
  ]);
  assert.deepEqual(selectBoatManifest([], now, 1), [{ projectId: null, label: '' }]);
});

test('independent boats have spatial separation and stay inside the island', () => {
  assert.deepEqual(boatPass(100, 100, 30), { x: -27.5, visible: true, done: false });
  const first = boatPass(108, 100, 30, 0), second = boatPass(108, 100, 30, 1);
  assert.equal(first.x - second.x, 7);
  assert.equal(boatPass(100, 100, 30, 1).visible, false);
  assert.equal(boatPass(120, 100, 30).done, true);
  assert.equal(boatPass(120, 100, 30).visible, false);
});

test('all six boats clear the maximum pinned island before the next departure, preserving ordinary speed', () => {
  const startedAt = 100, maximumHalf = (24 + 0.5) * 16 + 5.5;
  for (let index = 0; index < 6; index++) {
    const pass = boatPass(startedAt + 80, startedAt, maximumHalf, index);
    assert.equal(pass.done, true, `boat ${index} clears before the 90-second minimum interval`);
    assert.equal(pass.visible, false);
  }
  for (const half of [29.5, 45.5, 61.5, 93.5]) {
    assert.equal(boatPass(startedAt + 10, startedAt, half).x - boatPass(startedAt, startedAt, half).x, 30, `preview half ${half} retains speed 3`);
  }
});
