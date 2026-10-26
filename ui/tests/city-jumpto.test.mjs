import test from 'node:test';
import assert from 'node:assert/strict';
import { jumpToGroups } from '../app/city/jumpto.js';

const projects = [
  { id: 'local:tower-z', ids: ['local:tower-z', 'gh:owner/tower-z'], name: 'Zebra Tower', path: 'C:/projects/tower-z' },
  { id: 'local:tower-a', ids: ['local:tower-a', 'gh:owner/tower-a'], name: 'Alpha Tower', path: 'C:/projects/tower-a' },
  { id: 'local:home-a', name: 'Alpha Home', path: 'C:/projects/home-a' },
  { id: 'local:home-z', name: 'Zebra Home', path: 'C:/projects/home-z' },
  { id: 'gh:owner/ghost-z', name: 'Zebra Ghost', path: '' },
  { id: 'gh:owner/ghost-a', name: 'Alpha Ghost', path: '' },
];
const agents = [
  { id: 'worker-old', name: 'Ada', status: 'active', provider: 'claude', currentProjectId: 'gh:owner/tower-z', lastSeenAt: '2026-10-25T10:00:00Z' },
  { id: 'worker-new', name: 'Zoe', status: 'active', provider: 'codex', currentProjectId: 'local:home-z', lastSeenAt: '2026-10-25T11:00:00Z' },
  { id: 'worker-ghost', name: 'Ghost visitor', status: 'active', currentProjectId: 'gh:owner/ghost-z', lastSeenAt: 1 },
  { id: 'idle', name: 'Waiting', status: 'idle', currentProjectId: 'local:tower-a' },
  { id: 'error', name: 'Attention', status: 'error', currentProjectId: 'local:home-a' },
  { id: 'off', name: 'Sleeping', status: 'offline', homeProjectId: 'local:home-a' },
];

test('working agents lead by recency, followed by grouped projects, awake and collapsed powered down', () => {
  const snapshot = structuredClone({ projects, agents });
  const groups = jumpToGroups({ projects, agents });
  assert.deepEqual(groups.map(g => g.id), ['working', 'projects', 'awake', 'powered']);
  assert.deepEqual(groups.map(g => g.count), [3, 6, 2, 1]);
  assert.deepEqual(groups[0].rows.map(a => a.id), ['worker-new', 'worker-old', 'worker-ghost']);
  assert.deepEqual(groups[1].subgroups.map(g => g.label), ['Downtown', 'Suburbs', 'Not on this PC']);
  assert.deepEqual(groups[1].subgroups.map(g => g.rows.map(p => p.name)), [['Zebra Tower', 'Alpha Tower'], ['Zebra Home', 'Alpha Home'], ['Zebra Ghost', 'Alpha Ghost']]);
  assert.equal(groups[3].collapsed, true);
  assert.deepEqual({ projects, agents }, snapshot, 'grouping never mutates store data');
});

test('project aliases resolve agent locations and count agents only at their present project', () => {
  const groups = jumpToGroups({ projects, agents: [...agents, { id: 'visiting', name: 'Visitor', status: 'idle', homeProjectId: 'local:tower-z', currentProjectId: 'local:home-z' }] });
  assert.equal(groups[0].rows.find(a => a.id === 'worker-old').projectName, 'Zebra Tower');
  const rows = groups.find(g => g.id === 'projects').rows;
  assert.equal(rows.find(p => p.id === 'local:tower-z').agentCount, 1);
  assert.equal(rows.find(p => p.id === 'local:home-z').agentCount, 2);
  assert.equal(rows.find(p => p.id === 'local:home-a').agentCount, 2);
  assert.deepEqual(rows.find(p => p.id === 'gh:owner/ghost-z').target, { kind: 'building', id: 'gh:owner/ghost-z' });
});

test('search matches agent or project names, hides empty sections and keeps working order', () => {
  const zebra = jumpToGroups({ projects, agents, query: '  zEbRa  ' });
  assert.deepEqual(zebra.map(g => [g.id, g.count]), [['working', 3], ['projects', 3]]);
  assert.deepEqual(zebra[0].rows.map(a => a.name), ['Zoe', 'Ada', 'Ghost visitor']);
  const named = jumpToGroups({ projects, agents, query: 'ada' });
  assert.deepEqual(named.map(g => [g.id, g.count]), [['working', 1], ['projects', 1]]);
  assert.equal(named[1].rows[0].name, 'Zebra Tower');
  const asleep = jumpToGroups({ projects, agents, query: 'sleeping' });
  assert.deepEqual(asleep.map(g => g.id), ['projects', 'powered']);
  assert.deepEqual(jumpToGroups({ projects, agents, query: 'no such project' }), []);
  assert.deepEqual(jumpToGroups(), []);
});

test('mixed timestamp formats sort consistently and ties fall back to names', () => {
  const rows = jumpToGroups({ agents: [
    { id: 'b', name: 'Beta', status: 'active', lastSeenAt: 1792929600000 },
    { id: 'a', name: 'Alpha', status: 'active', lastSeenAt: '2026-10-25T12:00:00Z' },
    { id: 'c', name: 'Older', status: 'active', lastSeenAt: 1792929599 },
    { id: 'd', name: 'Unknown', status: 'active', lastSeenAt: 'invalid' },
  ] })[0].rows;
  assert.deepEqual(rows.map(a => a.id), ['a', 'b', 'c', 'd']);
});

test('Spark navigation retains runner targets after the requested PC sections', () => {
  const groups = jumpToGroups({ projects, agents, runners: [{ id: 'crew', crew: true }, { id: 'run', agent: { name: 'Build worker', provider: 'codex' }, job: { project: 'CodaClauda' } }] });
  assert.equal(groups.at(-1).id, 'spark');
  assert.deepEqual(groups.at(-1).rows[0].target, { kind: 'runner', id: 'run' });
  const found = jumpToGroups({ runners: [{ id: 'run', agent: { name: 'Build worker' }, job: { project: 'CodaClauda' } }], query: 'codaclauda' });
  assert.equal(found[0].count, 1);
});
