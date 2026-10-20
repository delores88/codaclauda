import test from 'node:test';
import assert from 'node:assert/strict';
import { routeMessage, buildTranscript, mergeShared, sharedContext, stripContext } from '../app/session-model.js';
import { accessFor } from '../app/access.js';

const T = 1_760_000_000_000;   // event times are milliseconds

test('routing: a leading mention picks the agent and is stripped; none or @both goes to both', () => {
  assert.deepEqual(routeMessage('@claude fix the build'), { targets: ['claude'], text: 'fix the build', mention: 'claude' });
  assert.deepEqual(routeMessage('@Codex, what failed?').targets, ['codex']);
  assert.deepEqual(routeMessage('@both review this').targets, ['claude', 'codex']);
  assert.deepEqual(routeMessage('ask @claude later').targets, ['claude', 'codex']);
});

test('transcript: deltas stream, message replaces them, shared context carries the other agent', () => {
  const claude = buildTranscript([
    { kind: 'user', turnId: 't1', text: 'hi', at: T },
    { kind: 'delta', turnId: 't1', text: 'Hel', at: T + 100 },
    { kind: 'delta', turnId: 't1', text: 'lo', at: T + 200 },
  ], { provider: 'claude', sessionId: 'a' });
  assert.equal(claude.items[1].text, 'Hello');
  assert.equal(claude.items[1].streaming, true);
  assert.equal(claude.openTurn, 't1');
  const done = buildTranscript([
    { kind: 'user', turnId: 't1', text: 'hi', at: T },
    { kind: 'message', turnId: 't1', text: 'Hello Ben', at: T + 300 },
    { kind: 'done', turnId: 't1', at: T + 400 },
  ], { provider: 'claude', sessionId: 'a' });
  const codex = buildTranscript([{ kind: 'user', turnId: 'u1', text: 'hi', at: T + 50 }], { provider: 'codex', sessionId: 'b' });
  const merged = mergeShared([done.items, codex.items]);
  assert.deepEqual(merged[0].targets, ['claude', 'codex']);   // one owner bubble for both
  const block = sharedContext(merged, 'codex');
  assert.match(block, /Claude: Hello Ben/);
  assert.equal(stripContext(`${block}\n\nnext`), 'next');
  assert.equal(sharedContext(merged, 'claude'), '');
});

test('access: own projects default to full, others read; a stored level wins', () => {
  assert.equal(accessFor({ id: 'local:c:/x', ids: ['local:c:/x'], path: 'C:/x' }, {}).level, 'full');
  assert.equal(accessFor({ id: 'gh:delores88/app', ids: ['gh:delores88/app'], path: '' }, {}).level, 'full');
  assert.equal(accessFor({ id: 'gh:someone/lib', ids: ['gh:someone/lib'], path: '' }, {}).level, 'read');
  assert.equal(accessFor({ id: 'local:c:/x', ids: ['local:c:/x'], path: 'C:/x' }, { 'local:c:/x': { level: 'read' } }).level, 'read');
});
