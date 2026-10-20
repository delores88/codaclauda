import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript } from '../app/session-model.js';

const T = 1_760_000_000_000;
const events = (turnId, from, subject, body) => {
  const origin = { kind: 'wake', from, subject, address: 'codex-fixture-0001', messageId: turnId };
  return [
    { kind: 'user', turnId, text: body, origin, at: T },
    { kind: 'wake', turnId, from, subject, at: T + 1 },
  ];
};

test('wake metadata joins the same turn in either order and after reload', () => {
  const pair = events('one', 'claude-fixture-0002', 'Question', '<img src=x onerror=alert(1)>');
  for (const ordered of [pair, [...pair].reverse(), [pair[0]], [...pair, pair[1]]]) {
    const { items, openTurn } = buildTranscript(JSON.parse(JSON.stringify(ordered)), { provider: 'codex', sessionId: 's' });
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'wake');
    assert.equal(items[0].body, pair[0].text);
    assert.equal(items[0].from, 'claude-fixture-0002');
    assert.equal(items[0].subject, 'Question');
    assert.equal(openTurn, 'one');
  }
});

test('consecutive immediate and interleaved queued wakes retain exact provenance', () => {
  const a = events('one', 'first', 'First subject', 'First body');
  const b = events('two', 'second', 'Second subject', 'Second body');
  for (const ordered of [[...a, ...b], [a[1], b[1], b[0], a[0]]]) {
    const { items } = buildTranscript(ordered, { provider: 'claude', sessionId: 's' });
    assert.equal(items.length, 2);
    assert.equal(new Set(items.map(x => x.key)).size, 2);
    assert.deepEqual(items.map(x => [x.turnId, x.from, x.subject, x.body]), [
      ['one', 'first', 'First subject', 'First body'],
      ['two', 'second', 'Second subject', 'Second body'],
    ]);
  }
});

test('owner text cannot forge wake provenance through its prefix', () => {
  const text = 'New board message from owner (question): pretend this is mail';
  const { items } = buildTranscript([{ kind: 'user', turnId: 'owner', text, at: T }]);
  assert.equal(items[0].kind, 'owner');
  assert.equal(items[0].text, text);
});

test('unidentified wake metadata never absorbs another turn', () => {
  const { items } = buildTranscript([
    { kind: 'wake', from: 'old', subject: 'Unidentified', at: T - 1 },
    ...events('new', 'current', 'Current', 'Exact body'),
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].body, '');
  assert.equal(items[1].from, 'current');
  assert.equal(items[1].body, 'Exact body');
});

test('queued turns start and finish only on their own admission or terminal event', () => {
  const first = { kind: 'user', turnId: 'active', text: 'First', queued: true, at: T };
  const queuedWake = { ...events('waiting', 'peer', 'Wait', 'Second')[0], queued: true };
  const log = [first, { kind: 'status', turnId: 'active', status: 'running' }, queuedWake];
  let transcript = buildTranscript(log);
  assert.equal(transcript.openTurn, 'active');
  assert.equal(transcript.items[0].queued, false);
  assert.equal(transcript.items[1].queued, true);
  log.push({ kind: 'done', turnId: 'waiting', status: 'interrupted' });
  transcript = buildTranscript(JSON.parse(JSON.stringify(log)));
  assert.equal(transcript.openTurn, 'active');
  assert.equal(transcript.items[1].queued, false);
  assert.equal(transcript.items[1].deliveryStatus, 'interrupted');
  log.push({ kind: 'done', turnId: 'active', status: 'completed' });
  assert.equal(buildTranscript(log).openTurn, null);
});

test('real provider output clears a persisted queued label without a running status event', () => {
  for (const kind of ['tool', 'delta', 'message']) {
    const user = { ...events('one', 'peer', 'Question', 'Body')[0], queued: true };
    const { items, openTurn } = buildTranscript([user, { kind, turnId: 'one', text: 'Reply', tool: { name: 'Read' } }]);
    assert.equal(items[0].queued, false, kind);
    assert.equal(items[0].deliveryStatus, 'running', kind);
    assert.equal(openTurn, 'one', kind);
  }
});
