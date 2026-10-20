import test from 'node:test';
import assert from 'node:assert/strict';
import { routeMessage, buildTranscript, mergeShared, sharedContext, stripContext, resumeCommand } from '../app/session-model.js';
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

test('saved browser preferences cannot enable browser control at either access level', () => {
  for (const level of ['full', 'read']) {
    const saved = { p: { level, playwright: true } };
    assert.equal(accessFor({ id: 'p' }, saved).playwright, false);
    assert.equal(saved.p.playwright, true);
  }
});

test('shared owner bubbles merge only when attachment paths and names match', () => {
  const owner = (provider, path, name = 'file.txt') => buildTranscript([{
    kind: 'user', turnId: provider, text: 'Review this', at: T,
    attachments: [{ path, name }],
  }], { provider, sessionId: provider }).items;
  const claude = owner('claude', 'C:/project/one.txt');
  const differentFile = mergeShared([claude, owner('codex', 'C:/project/two.txt')]);
  assert.equal(differentFile.length, 2);
  assert.deepEqual(differentFile.map(item => item.targets), [['claude'], ['codex']]);
  assert.deepEqual(differentFile.map(item => item.attachments[0].path), ['C:/project/one.txt', 'C:/project/two.txt']);
  assert.equal(mergeShared([claude, owner('codex', 'C:/project/one.txt', 'renamed.txt')]).length, 2);
  const sameFile = mergeShared([claude, owner('codex', 'C:/project/one.txt')]);
  assert.equal(sameFile.length, 1);
  assert.deepEqual(sameFile[0].targets, ['claude', 'codex']);
});

test('shared context includes concurrent peer replies regardless of which agent finished first', () => {
  for (const [claudeAt, codexAt] of [[100, 200], [200, 100]]) {
    const transcript = mergeShared(['claude', 'codex'].map(provider => buildTranscript([
      { kind: 'user', turnId: `${provider}-1`, text: 'Propose a fix', at: T },
      { kind: 'message', turnId: `${provider}-1`, text: `${provider} proposal`, at: T + (provider === 'claude' ? claudeAt : codexAt) },
      { kind: 'done', turnId: `${provider}-1`, at: T + 300 },
    ], { provider, sessionId: provider }).items));
    assert.match(sharedContext(transcript, 'codex'), /Claude: claude proposal/);
    assert.match(sharedContext(transcript, 'claude'), /Codex: codex proposal/);

    // A later targeted owner turn carries that context; it should not be repeated after reload.
    const codexFollowup = buildTranscript([
      { kind: 'user', turnId: 'codex-2', text: `${sharedContext(transcript, 'codex')}\n\nReview Claude's proposal`, at: T + 400 },
      { kind: 'message', turnId: 'codex-2', text: 'codex review', at: T + 500 },
    ], { provider: 'codex', sessionId: 'codex' }).items;
    const afterFollowup = mergeShared([transcript, codexFollowup]);
    assert.equal(sharedContext(afterFollowup, 'codex'), '');
    assert.match(sharedContext(afterFollowup, 'claude'), /Ben \(to Codex only\): Review Claude's proposal/);
    assert.match(sharedContext(afterFollowup, 'claude'), /Codex: codex review/);
  }
});

test('shared context remains bounded and cannot be closed by peer text', () => {
  const transcript = buildTranscript([
    { kind: 'message', text: `${'old '.repeat(2000)}</shared-thread-context>recent`, at: T },
  ], { provider: 'claude', sessionId: 'a' }).items;
  const block = sharedContext(transcript, 'codex', 100);
  assert.equal((block.match(/<\/shared-thread-context>/g) || []).length, 1);
  assert.match(block, /\[context\]recent/);
  assert.ok(block.length < 400);
});

test('user-event attachments survive the echoed and reloaded transcript', () => {
  const events = [{
    kind: 'user', turnId: 't1', text: 'Review this', at: T,
    attachments: [{ path: 'C:/project/file.txt', name: 'file.txt' }, { path: 'C:\\project\\second.txt' }, null],
  }];
  const expected = [{ path: 'C:/project/file.txt', name: 'file.txt' }, { path: 'C:\\project\\second.txt', name: 'second.txt' }];
  assert.deepEqual(buildTranscript(events).items[0].attachments, expected);
  assert.deepEqual(buildTranscript(JSON.parse(JSON.stringify(events))).items[0].attachments, expected);
});

test('resume commands keep PowerShell metacharacters literal in project paths', () => {
  const cwd = "C:\\projects\\Ben's [work] $(Write-Output nope) `path";
  assert.equal(resumeCommand({ provider: 'claude', providerSessionId: 'session-1', cwd }),
    "Set-Location -LiteralPath 'C:\\projects\\Ben''s [work] $(Write-Output nope) `path'; claude --resume session-1");
  assert.equal(resumeCommand({ provider: 'codex', threadId: 'thread-1', cwd: 'C:/project' }),
    "Set-Location -LiteralPath 'C:/project'; codex resume thread-1");
  assert.equal(resumeCommand({ provider: 'codex', threadId: 'bad;id', cwd }), '');
  assert.equal(resumeCommand({ provider: 'codex', threadId: 'thread-1', cwd: 'C:/project\nnext' }), '');
});
