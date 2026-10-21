import test from 'node:test';
import assert from 'node:assert/strict';
import { requestRows, pairRows, REQUEST_STATES } from '../app/team.js';
import { requestLine, pairLine } from '../app/views/settings-team.js';

// The preview backend keeps its state in localStorage; give it an in-memory one.
const saved = new Map();
globalThis.localStorage = { getItem: k => (saved.has(k) ? saved.get(k) : null), setItem: (k, v) => saved.set(k, String(v)), removeItem: k => saved.delete(k) };
const { mockHandlers } = await import('../dev/mock.js');
const { rpc, desktop, preview } = mockHandlers();

test('team request rows keep the honest order of states and only a queued one is cancellable', () => {
  assert.deepEqual(Object.keys(REQUEST_STATES).slice(0, 8), ['queued', 'starting', 'launching', 'admitted', 'completed', 'failed', 'refused', 'cancelled']);
  const rows = requestRows([
    { requestId: 'a', from: 'claude-app-0001', subject: 'Reviewer', status: 'admitted', at: 2, address: 'codex-app-0b1c', cancellable: true },
    { requestId: 'b', from: 'claude-app-0001', subject: 'Second', status: 'queued', at: 3, cancellable: true },
    { requestId: '', status: 'queued' }, null,
  ]);
  assert.deepEqual(rows.map(r => [r.requestId, r.label, r.cancellable]), [['b', 'Queued', true], ['a', 'Working', false]]);
  assert.equal(requestLine(rows[1]), 'claude-app-0001 · Reviewer · Working (codex-app-0b1c)');
  const pairs = pairRows([{ key: 'pair:a|b', a: 'a', b: 'b', lastHour: 2, paused: true }, { key: 'pair:c|d', a: 'c', b: 'd', lastHour: 9, reached: true }, { key: 'peer>s' }]);
  assert.deepEqual(pairs.map(p => p.key), ['pair:c|d', 'pair:a|b']);
  assert.equal(pairLine(pairs[0]), 'c ↔ d: 9 wakes in the last hour (guard reached)');
  assert.equal(pairLine(pairs[1]), 'a ↔ b: 2 wakes in the last hour · paused by you');
});

test('the preview mock has every changed command, with the engine shapes', () => {
  for (const command of ['team_settings_get', 'team_settings_set', 'wake_settings_get', 'wake_settings_set', 'desktop_bindings_get', 'desktop_bind', 'desktop_unbind', 'session_adopt', 'usage_settings_get', 'usage_settings_set', 'usage_status', 'session_continue', 'session_retry_held']) {
    assert.equal(typeof desktop[command], 'function', command);
  }
  for (const op of ['mailbox-post', 'mailbox-wait-reply']) assert.equal(typeof rpc[op], 'function', op);
  // A post: durable receipt, host lease, reader; a start request is queued and cancellable; a notice is passive.
  const start = JSON.stringify({ start: { provider: 'codex', project: 'app', prompt: 'Review.' } });
  const posted = rpc['mailbox-post']({ id: 'mock-req', from: 'owner', to: 'codaclauda-team', kind: 'question', subject: 'Need a reviewer', body: start });
  assert.deepEqual([posted.delivery.receipt, posted.delivery.host, posted.delivery.reader, posted.delivery.request.state, posted.delivery.request.requestId], ['saved', 'available', 'app', 'queued', 'mock-req']);
  assert.match(posted.delivery.request.cancel, /"cancel":\{"requestId":"mock-req"\}/);
  assert.equal(rpc['mailbox-post']({ id: 'mock-notice', from: 'owner', to: 'codaclauda-team', kind: 'notice', subject: 'x', body: start }).delivery.request.state, 'passive');
  // wait-reply: the first reply says it is an acknowledgement; terminal waits past it.
  rpc['mailbox-post']({ id: 'mock-ack', from: 'codaclauda-team', to: 'owner', kind: 'reply', reply_to: 'mock-req', subject: 'Re', body: JSON.stringify({ queued: { requestId: 'mock-req' } }) });
  assert.equal(rpc['mailbox-wait-reply']({ id: 'mock-req' }).reply_kind, 'acknowledgement');
  const waiting = rpc['mailbox-wait-reply']({ id: 'mock-req', terminal: true });
  assert.deepEqual([waiting.timed_out, waiting.acknowledgement.id], [true, 'mock-ack']);
  rpc['mailbox-post']({ id: 'mock-done', from: 'codaclauda-team', to: 'owner', kind: 'reply', reply_to: 'mock-req', subject: 'Re', body: JSON.stringify({ completed: { requestId: 'mock-req' } }) });
  assert.deepEqual([rpc['mailbox-wait-reply']({ id: 'mock-req', terminal: true }).reply.id, rpc['mailbox-wait-reply']({ id: 'mock-req', terminal: true }).reply_kind], ['mock-done', 'terminal']);
  // Team settings list requests and refuse cancelling one that is not queued.
  const team = desktop.team_settings_get();
  assert.ok(Array.isArray(team.requests) && 'inboxError' in team);
  assert.throws(() => desktop.team_settings_set({ project: { cancelRequest: 'missing' } }), e => e.code === 'REQUEST_NOT_FOUND');
  // Wake pairs: listed, and one pair can be paused and resumed.
  assert.ok(Array.isArray(desktop.wake_settings_get().pairs));
  assert.throws(() => desktop.wake_settings_set({ pair: { key: 'peer>s', paused: true } }), e => e.code === 'INVALID_ARGUMENTS');
  assert.equal(desktop.wake_settings_set({ pair: { key: 'pair:a-0001|b-0002', paused: true } }).pairs.find(p => p.key === 'pair:a-0001|b-0002').paused, true);
  assert.equal(desktop.wake_settings_set({ pair: { key: 'pair:a-0001|b-0002', paused: false } }).pairs.some(p => p.key === 'pair:a-0001|b-0002'), false);
  // Desktop bindings, with desktop_queue.rs's checks and codes: registered address, thread on this "PC", linked project.
  const row = desktop.external_sessions_list().sessions.find(s => s.provider === 'codex' && s.active);
  const thread = row.providerSessionId;
  const reason = (args, code) => assert.throws(() => desktop.desktop_bind(args), e => e.code === code, code);
  reason({ address: 'codex-desktop-chat', threadId: thread }, 'ADDRESS_UNKNOWN');
  rpc['mailbox-register']({ name: 'codex-desktop-chat', label: 'Codex desktop chat' });
  reason({ address: 'codex-desktop-chat', threadId: thread }, 'PROJECT_NOT_LINKED');
  saved.set('mock.desktop', JSON.stringify({ projects: { local: [{ path: 'C:\\Users\\Ben\\Desktop' }] } }));
  reason({ address: 'owner', threadId: thread }, 'ADDRESS_RESERVED');
  reason({ address: 'codex-desktop-chat', threadId: 'no-such-thread' }, 'INVALID_ARGUMENTS');
  reason({ address: 'codex-desktop-chat', threadId: '00000000-0000-4000-8000-000000000000' }, 'THREAD_NOT_FOUND');
  assert.equal(desktop.desktop_bindings_get().bindings.length, 0, 'a refusal saves nothing');
  const bound = desktop.desktop_bind({ address: 'codex-desktop-chat', threadId: thread });
  assert.deepEqual(Object.keys(bound.binding).sort(), ['address', 'boundAt', 'cursor', 'cwd', 'last', 'projectId', 'provider', 'threadId']);
  assert.equal(bound.binding.projectId, 'local:c:/users/ben/desktop');
  assert.deepEqual(desktop.desktop_bindings_get().bindings.map(b => b.address), ['codex-desktop-chat']);
  // Continue: bound is refused first, then recently active; Fork makes a labeled copy without provider ids.
  const cwd = row.cwd;
  assert.throws(() => desktop.session_adopt({ provider: 'codex', providerSessionId: thread, cwd }), e => e.code === 'CONVERSATION_BOUND');
  assert.deepEqual(desktop.desktop_unbind({ address: 'codex-desktop-chat' }), { unbound: true, bindings: [] });
  assert.throws(() => desktop.session_adopt({ provider: 'codex', providerSessionId: thread, cwd }), e => e.code === 'CONVERSATION_ACTIVE');
  const copy = desktop.session_adopt({ provider: 'codex', providerSessionId: thread, cwd, mode: 'fork' });
  assert.deepEqual([copy.copy, copy.session.title, copy.session.providerSessionId, copy.session.threadId, copy.session.forkFrom, copy.session.adoptedFrom.copy], [true, 'Codex conversation (copy)', null, null, thread, true]);
});

test('the preview mock holds, releases and continues turns like usage.rs', () => {
  const { session } = desktop.session_start({ args: { provider: 'codex', cwd: 'C:\\Users\\Ben\\Desktop\\CodaClauda', title: 'usage' } });
  assert.equal(desktop.session_list().sessions.find(s => s.id === session.id).held, null);
  assert.throws(() => desktop.session_retry_held({ id: session.id }), e => e.code === 'NOT_HELD');
  // Stop cancels a held turn; it was never sent.
  preview.usageHold(session.id);
  assert.equal(desktop.session_list().sessions.find(s => s.id === session.id).held.retryAt, null);
  desktop.session_stop({ id: session.id });
  assert.equal(desktop.session_list().sessions.find(s => s.id === session.id).held, null);
  // Try now releases the same turn id once.
  const held = preview.usageHold(session.id);
  assert.deepEqual(desktop.session_retry_held({ id: session.id }), { released: true, turnId: held.turnId });
  assert.throws(() => desktop.session_retry_held({ id: session.id }), e => e.code === 'NOT_HELD');
  desktop.session_stop({ id: session.id });
  // Continue is a new turn for the recorded stopped turn only, and only once.
  const stopped = preview.usageStop(session.id);
  assert.throws(() => desktop.session_continue({ id: session.id, turnId: 'other' }), e => e.code === 'NOT_STOPPED');
  const next = desktop.session_continue({ id: session.id, turnId: stopped.turnId });
  assert.equal(next.accepted, true);
  assert.notEqual(next.turnId, stopped.turnId);
  assert.throws(() => desktop.session_continue({ id: session.id, turnId: stopped.turnId }), e => e.code === 'NOT_STOPPED');
  desktop.session_close({ id: session.id });
});
