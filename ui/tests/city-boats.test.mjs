import assert from 'node:assert/strict';
import test from 'node:test';
import { boatInterval, nextBoatAt, selectBoatManifest, boatPass, BOAT_TYPES, chooseBoatTypes, boatFleet } from '../app/city/boats.js';

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

test('a hundred shuffled choices cover every six-type bag with no immediate boundary repeats', () => {
  const samples = [0, 1, NaN, .3, .9, .1, .6], sequence = [];
  let call = 0, bag = [], previous = null;
  const random = () => samples[call++ % samples.length];
  for (let n = 0; n < 100; n++) {
    const result = chooseBoatTypes(1, { bag, previous, random });
    assert.equal(result.types.length, 1);
    assert.notEqual(result.types[0], previous);
    sequence.push(result.types[0]); bag = result.bag; previous = result.lastType;
  }
  for (let start = 0; start + 6 <= sequence.length; start += 6) assert.deepEqual(new Set(sequence.slice(start, start + 6)), new Set(BOAT_TYPES));
});

test('bag continuation handles varying fleet sizes and never mutates its input', () => {
  let bag = [], previous = null, chosen = [];
  for (const count of [2, 3, 6, 1, 5, 4, 6, 3]) {
    const before = [...bag]; Object.freeze(bag);
    const result = chooseBoatTypes(count, { bag, previous, random: () => .7 });
    assert.deepEqual(bag, before);
    assert.equal(result.types.length, count);
    chosen.push(...result.types); bag = result.bag; previous = result.lastType;
  }
  for (let n = 1; n < chosen.length; n++) assert.notEqual(chosen[n], chosen[n - 1]);
  for (let start = 0; start + 6 <= chosen.length; start += 6) assert.equal(new Set(chosen.slice(start, start + 6)).size, 6);
});

test('injected random bounds and malformed tails still return bounded valid type choices', () => {
  for (const sample of [0, 1, NaN, -2, 5, Infinity]) {
    const result = chooseBoatTypes(60, { random: () => sample });
    assert.equal(result.types.length, 6); assert.equal(result.bag.length, 0);
    assert.deepEqual(new Set(result.types), new Set(BOAT_TYPES));
  }
  let calls = 0;
  const empty = chooseBoatTypes(0, { bag: ['canoe'], previous: 'tugboat', random: () => { calls++; return .5; } });
  assert.deepEqual(empty, { types: [], bag: ['canoe'], lastType: 'tugboat' }); assert.equal(calls, 0);
  for (const count of [-1, NaN, Infinity]) assert.deepEqual(chooseBoatTypes(count).types, []);
  assert.equal(chooseBoatTypes(2.9, { random: () => .5 }).types.length, 2);
  for (const bag of [['canoe'], ['canoe', 'canoe', 'invalid'], ['canoe', 'tugboat']]) {
    const result = chooseBoatTypes(1, { bag, previous: 'canoe', random: () => 1 });
    assert.notEqual(result.types[0], 'canoe');
    assert.ok(BOAT_TYPES.includes(result.types[0]));
  }
});

test('each hull may carry recent activity and barges carry three distinct existing labels', () => {
  const manifest = Array.from({ length: 6 }, (_, n) => Object.freeze({ projectId: `project-${n}`, label: `Recent ${n}` }));
  Object.freeze(manifest);
  const types = Object.freeze([...BOAT_TYPES]), fleet = boatFleet(manifest, types);
  assert.equal(fleet.length, types.length);
  for (const [index, boat] of fleet.entries()) {
    assert.equal(boat.type, types[index]); assert.equal(boat.projectId, manifest[index].projectId); assert.equal(boat.label, manifest[index].label);
    assert.equal(boat.projects.length, boat.type === 'barge' ? 3 : 1);
    assert.equal(boat.projects[0].projectId, boat.projectId);
    for (const p of boat.projects) assert.ok(manifest.some(m => m.projectId === p.projectId && m.label === p.label));
  }
  const barge = fleet.find(b => b.type === 'barge'); assert.equal(new Set(barge.projects.map(p => p.projectId)).size, 3);
  barge.projects[0].label = 'Edited copy'; assert.equal(manifest[3].label, 'Recent 3');
});

test('fleet labels omit no-activity placeholders and preserve recent-manifest filtering', () => {
  const recent = selectBoatManifest([project('fresh', { last_commit_at: '2026-10-25T11:00:00Z' }), project('stale', { last_commit_at: '2026-10-20T11:00:00Z', commits_7d: 8 })], now);
  const fleet = boatFleet(recent, ['rowboat', 'canoe']);
  assert.equal(fleet[0].projectId, 'fresh'); assert.deepEqual(fleet[1], { type: 'canoe', projectId: null, label: '', projects: [] });
  assert.ok(fleet.every(b => b.projects.every(p => p.projectId === 'fresh')));
  for (const boat of boatFleet(selectBoatManifest([], now), BOAT_TYPES)) assert.deepEqual(boat.projects, []);
  const barge = boatFleet([{ projectId: null, label: 'Empty' }, { projectId: 'a', label: 'First' }, { projectId: 'a', label: 'Duplicate' }, { projectId: 'b', label: 'Second' }, { projectId: 'c', label: 'Third' }, { projectId: 'd', label: 'Fourth' }], ['barge'])[0];
  assert.deepEqual(barge.projects.map(p => p.projectId), ['a', 'b', 'c']);
  assert.deepEqual(boatFleet([null, {}, { projectId: 'missing', label: '' }], ['sailboat'])[0].projects, []);
});
