import test from 'node:test';
import assert from 'node:assert/strict';
import { sessions as singleton } from '../app/sessions.js';
import { desktop } from '../app/bridge.js';

const T = 1_760_000_000_000;

function client() {
  const sessions = new singleton.constructor();
  sessions.list = [{ id: 'a', provider: 'claude', status: 'idle', lastActivityAt: T }];
  sessions.scheduleRefresh = () => {};
  return sessions;
}

function stub(t, name, fn) {
  const original = desktop[name];
  desktop[name] = fn;
  t.after(() => { desktop[name] = original; });
}

test('a terminal event arriving before the send response keeps the session available for follow-up', async t => {
  const sessions = client();
  let terminal;
  stub(t, 'sessionSend', async () => {
    sessions.onEvent({ id: 'a', kind: 'user', turnId: 't1', text: 'hi', at: T + 1 });
    sessions.onEvent({ id: 'a', kind: 'status', turnId: 't1', status: terminal, at: T + 2 });
    sessions.onEvent({ id: 'a', kind: 'done', turnId: 't1', at: T + 3 });
    return { accepted: true, turnId: 't1' };
  });
  for (terminal of ['idle', 'failed', 'stopped']) {
    await sessions.send('a', 'hi');
    assert.equal(sessions.session('a').status, terminal);
    assert.equal(sessions.running('a'), false);
    assert.equal(sessions.pending.get('a').length, 0);
  }
});

test('an accepted send remains busy until its user echo and terminal event', async t => {
  const sessions = client();
  stub(t, 'sessionSend', async () => ({ accepted: true, turnId: 't1' }));
  await sessions.send('a', 'hi');
  assert.equal(sessions.running('a'), true);
  sessions.onEvent({ id: 'a', kind: 'user', turnId: 't1', text: 'hi', at: T + 1 });
  sessions.onEvent({ id: 'a', kind: 'done', turnId: 't1', at: T + 2 });
  assert.equal(sessions.running('a'), false);
});

test('shared prompt preparation waits for an already-loading history and includes buffered events', async t => {
  const sessions = client();
  let finish, calls = 0;
  stub(t, 'sessionHistory', () => {
    calls += 1;
    return new Promise(resolve => { finish = resolve; });
  });
  const opening = sessions.load('a');
  let ready = false;
  const preparing = sessions.loadedTranscript('a').then(history => { ready = true; return history; });
  await Promise.resolve();
  assert.equal(ready, false);
  assert.equal(calls, 1);
  sessions.onEvent({ id: 'a', kind: 'message', turnId: 't1', text: 'Peer proposal', at: T + 2 });
  finish({ events: [{ id: 'a', kind: 'user', turnId: 't1', text: 'Propose a fix', at: T + 1 }] });
  await opening;
  const history = await preparing;
  assert.equal(history.state, 'loaded');
  assert.deepEqual(history.items.map(item => item.text), ['Propose a fix', 'Peer proposal']);
});

test('a history failure prevents preparing a shared prompt with silently empty context', async t => {
  const sessions = client();
  stub(t, 'sessionHistory', async () => { throw new Error('History read failed'); });
  await assert.rejects(sessions.loadedTranscript('a'), /History read failed/);
  assert.equal(sessions.transcript('a').state, 'error');
});
