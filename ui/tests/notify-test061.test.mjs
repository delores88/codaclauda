import test from 'node:test';
import assert from 'node:assert/strict';
import { desktop } from '../app/bridge.js';
import { phoneTestAction, phoneTestReady, phoneTestResult } from '../app/views/settings.js';

const TOPIC = 'https://ntfy.sh/example-test-topic';
const sent = () => ({ id: 'test-receipt', status: 'sent', message: 'Accepted by ntfy.', ntfyId: 'ntfyreceipt', httpStatus: 200, attempted: true });
const state = () => ({ state: 'loaded', saved: { ntfyUrl: TOPIC }, busy: '', testResult: null });

test('Send test handler waits for a click, calls once with no arguments, and blocks a double click while pending', async t => {
  let finish;
  const calls = [], renders = [], notices = [];
  t.mock.method(desktop, 'notifyTest', (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); });
  const note = state();
  const click = phoneTestAction(note, () => TOPIC, () => renders.push(phoneTestReady(note, TOPIC)), (...args) => notices.push(args));
  assert.deepEqual(calls, [], 'constructing or rendering the action does not send');
  const first = click();
  assert.equal(phoneTestReady(note, TOPIC), false);
  await click();
  assert.deepEqual(calls, [[]]);
  finish(sent());
  await first;
  assert.deepEqual(renders, [false, true]);
  assert.equal(note.testResult.status, 'sent');
  assert.match(note.testResult.text, /ntfy accepted the test \(HTTP 200\)/);
  assert.match(notices[0][0], /phone delivery is not confirmed/);
  assert.equal(notices[0][1].kind, 'success');
  assert.equal(calls.length, 1, 'completion does not trigger another test');
});

test('Send test refuses an unsaved URL, empty destination, unread settings, and other pending saves', async t => {
  let calls = 0;
  t.mock.method(desktop, 'notifyTest', async () => { calls++; return sent(); });
  const note = state();
  let visible = 'https://ntfy.sh/unsaved-example';
  const click = phoneTestAction(note, () => visible, () => {}, () => {});
  assert.equal(phoneTestReady(note, visible), false);
  await click();
  visible = TOPIC; note.saved.ntfyUrl = null;
  await click();
  note.saved.ntfyUrl = TOPIC; note.state = 'error';
  await click();
  note.state = 'loaded'; note.busy = 'Saving…';
  await click();
  assert.equal(calls, 0);
  note.busy = '';
  await click();
  assert.equal(calls, 1, 'only an explicit eligible click sends');
});

test('unknown receipts and invoke failures remain unknown and never automatically retry', async t => {
  const note = state(), notices = [];
  const cases = [
    async () => ({ id: 'test-unknown', status: 'unknown', message: 'No response.', ntfyId: null, httpStatus: null, attempted: true }),
    async () => { throw new Error('IPC failed after dispatch'); },
    async () => ({ ok: true }),
    async () => ({ status: 'sent', attempted: true }),
  ];
  for (const result of cases) {
    let calls = 0;
    const mock = t.mock.method(desktop, 'notifyTest', async () => { calls++; return result(); });
    const click = phoneTestAction(note, () => TOPIC, () => {}, (...args) => notices.push(args));
    await click();
    assert.equal(calls, 1);
    assert.equal(note.testResult.status, 'unknown');
    assert.match(note.testResult.text, /may have been sent/);
    assert.match(note.testResult.text, /No automatic retry/);
    assert.doesNotMatch(note.testResult.text, /didn't send|could not be sent|delivered/);
    assert.equal(notices.at(-1)[1].kind, 'error');
    mock.mock.restore();
  }
});

test('test refusal and unsuccessful HTTP response remain distinct from acceptance or an unknown outcome', () => {
  const refused = phoneTestResult({ status: 'refused', attempted: false, message: 'Save a topic URL first.', httpStatus: null });
  assert.equal(refused.status, 'refused');
  assert.match(refused.text, /Test refused before sending/);
  assert.match(refused.text, /Save a topic URL first/);
  const failed = phoneTestResult({ status: 'failed', attempted: true, message: 'Topic access was refused.', httpStatus: 403 });
  assert.equal(failed.status, 'failed');
  assert.match(failed.text, /ntfy returned an unsuccessful HTTP response \(HTTP 403\)/);
  assert.match(failed.text, /No automatic retry/);
  for (const patch of [{ attempted: false }, { id: '' }, { id: ' ' }, { ntfyId: null }, { ntfyId: 'bad/id' }, { ntfyId: 'x'.repeat(129) }, { httpStatus: null }, { httpStatus: 500 }]) {
    assert.equal(phoneTestResult({ ...sent(), ...patch }).status, 'unknown', 'unconfirmed or malformed acceptance cannot become success');
  }
  const serverError = phoneTestResult({ status: 'failed', attempted: true, httpStatus: 500 });
  assert.match(serverError.text, /unsuccessful HTTP response \(HTTP 500\); check your phone/);
  assert.doesNotMatch(serverError.text, /rejected|didn't send/);
});

test('notifyTest bridge invokes only notify_test with no destination or content arguments', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI__: { core: { invoke: async (command, args) => {
    calls.push([command, args]); return { ok: true, data: sent() };
  } } } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'window', original); else delete globalThis.window; });
  const receipt = await desktop.notifyTest({ ntfyUrl: 'https://ntfy.sh/ignored', body: 'Not permitted' });
  assert.deepEqual(calls, [['notify_test', {}]]);
  assert.equal(receipt.status, 'sent');
});
