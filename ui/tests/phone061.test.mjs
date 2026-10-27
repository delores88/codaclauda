import test from 'node:test';
import assert from 'node:assert/strict';
import { desktop } from '../app/bridge.js';
import { phoneSettings, phoneSettingsValue, phoneThreadText, PHONE_COPY } from '../app/views/settings-phone.js';

const TOPIC = 'https://ntfy.sh/example-phone-conversation';
const saved = patch => ({ enabled: true, topicUrl: null, lastRecipient: null, recipients: [{ address: 'codex-example', label: 'Example agent' }], lastError: null, ...patch });

// Run the real event handlers and inspect their rendered controls with a small
// UI adapter. No native service, network request, or browser state is needed.
function fixture(t, initial = saved(), handlers = {}) {
  let persisted = structuredClone(initial);
  const calls = [], nodes = [], notices = [];
  const methods = {
    phoneSettingsGet: async () => { calls.push(['get']); return structuredClone(persisted); },
    phoneSettingsSet: async args => { calls.push(['set', args]); persisted = { ...persisted, ...args }; return structuredClone(persisted); },
    ...handlers,
  };
  for (const [name, fn] of Object.entries(methods)) t.mock.method(desktop, name, fn);
  function h(tag, props, ...children) {
    if (!props || typeof props !== 'object' || props.node || Array.isArray(props)) { children.unshift(props); props = {}; }
    const node = { node: true, tag, value: '', checked: false, disabled: false, hidden: false, textContent: '', ...props,
      children: children.flat().filter(x => x != null) };
    nodes.push(node); return node;
  }
  const ui = { h, icon: () => null, toast: (...args) => notices.push(args) };
  const card = phoneSettings({ ui, store: { setPref() { throw new Error('Phone settings must not enter the UI store.'); } } });
  const control = label => nodes.find(n => n['aria-label'] === label);
  const button = label => nodes.find(n => n.tag.startsWith('button') && n.children.includes(label));
  const change = async enabled => {
    const node = control(PHONE_COPY.title);
    node.checked = enabled;
    await node.onchange({ currentTarget: node });
  };
  return { card, nodes, calls, notices, control, button, change, persisted: () => persisted,
    update: patch => { persisted = { ...persisted, ...patch }; },
    status: () => nodes.find(n => n.role === 'status').textContent,
    thread: () => nodes.find(n => n.tag.includes('phone-thread')).textContent };
}

test('one-topic phone settings use the saved URL with one switch and no setup or recipient controls', async t => {
  const f = fixture(t, saved({ topicUrl: TOPIC }));
  assert.equal(f.control(PHONE_COPY.title).disabled, true);
  await f.card.load();
  assert.deepEqual(f.calls, [['get']], 'opening settings does not save or generate anything');
  assert.equal(f.control(PHONE_COPY.title).checked, true);
  assert.equal(f.control(PHONE_COPY.title).disabled, false);
  assert.match(f.status(), /^On: send and receive messages in the same ntfy topic/);
  assert.equal(f.nodes.filter(n => n.tag === 'input').length, 2, 'one switch for messages, one for approvals (0.7.2)');
  assert.equal(f.nodes.some(n => n.tag.startsWith('select')), false);
  for (const oldAction of ['Set up phone messages', 'Copy', 'Regenerate']) assert.equal(f.button(oldAction), undefined);
  assert.equal(f.control('Private inbound topic URL'), undefined);
  assert.equal(f.control('Default phone message recipient'), undefined);
});

test('without a saved URL the phone screen reports no traffic and preserves an owner off switch', async t => {
  const f = fixture(t);
  await f.card.load();
  assert.match(f.status(), /No phone traffic is sent or received without a saved URL/);
  await f.change(false);
  assert.deepEqual(f.calls.at(-1), ['set', { enabled: false }]);
  f.update({ topicUrl: TOPIC });
  await f.card.load();
  assert.equal(f.control(PHONE_COPY.title).checked, false);
  assert.match(f.status(), /^Off:/);
  await f.change(true);
  assert.deepEqual(f.calls.at(-1), ['set', { enabled: true }]);
  assert.equal(f.persisted().topicUrl, TOPIC);
  assert.equal(f.control(PHONE_COPY.title).checked, true);
});

test('phone replies show the last sender and never silently select a recent active agent', async t => {
  const f = fixture(t, saved({ topicUrl: TOPIC }));
  await f.card.load();
  assert.match(f.thread(), /^Start with @name to choose an agent/);
  assert.match(f.thread(), /Example agent \(@codex-example\)/);
  assert.doesNotMatch(f.thread(), /Replies go to/);
  f.update({ lastRecipient: 'codex-example' });
  await f.card.load();
  assert.match(f.thread(), /^Replies go to Example agent \(codex-example\), the last agent who messaged your phone/);
  f.update({ topicUrl: 'https://ntfy.sh/another-example-conversation', lastRecipient: null });
  await f.card.load();
  assert.match(f.thread(), /^Start with @name/);
  assert.equal(f.calls.some(([kind]) => kind === 'set'), false);
});

test('a failed phone switch save restores its confirmed value and a read failure requires refresh', async t => {
  const f = fixture(t, saved({ topicUrl: TOPIC }), {
    phoneSettingsSet: async () => { throw new Error('PHONE_STORAGE_FAILED'); },
  });
  await f.card.load();
  await f.change(false);
  assert.equal(f.control(PHONE_COPY.title).checked, true);
  assert.match(f.notices.at(-1)[0], /PHONE_STORAGE_FAILED/);
  desktop.phoneSettingsGet = async () => { throw new Error('Could not read phone settings.'); };
  await f.card.load();
  assert.equal(f.control(PHONE_COPY.title).disabled, true);
  assert.equal(f.button('Refresh phone status').disabled, false);
  assert.equal(f.nodes.find(n => n.role === 'alert').textContent, 'Could not read phone settings.');
});

test('a URL save during a phone settings read queues a fresh read instead of keeping stale topic state', async t => {
  let release;
  let reads = 0;
  const f = fixture(t, saved(), { phoneSettingsGet: () => {
    reads++;
    return reads === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(saved({ topicUrl: TOPIC }));
  } });
  const pending = f.card.load();
  await f.card.load(); // Settings requests this refresh after saving notify.ntfyUrl.
  release(saved());
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.match(f.status(), /^On:/);
});

test('phone name hints are bounded plain text and malformed settings cannot enable edits', async t => {
  const recipients = [
    { address: 'codex-example', label: '<img src=x>' },
    { address: 'second-agent', label: 'Two word name' },
    { address: 'third-agent', label: '' },
    { address: 'fourth-agent', label: 'Hidden fourth' },
  ];
  const f = fixture(t, saved({ recipients }));
  await f.card.load();
  assert.match(f.thread(), /<img src=x> \(@codex-example\)/);
  assert.match(f.thread(), /Two word name \(@second-agent\)/);
  assert.match(f.thread(), /@third-agent/);
  assert.doesNotMatch(f.thread(), /Hidden fourth/);
  assert.match(phoneThreadText(saved({ recipients: [] })), /Open an agent chat/);
  assert.throws(() => phoneSettingsValue(null), /not confirmed/);
  assert.throws(() => phoneSettingsValue({ enabled: 'yes', recipients: [] }), /not confirmed/);
  desktop.phoneSettingsGet = async () => ({ enabled: true });
  await f.card.load();
  assert.equal(f.control(PHONE_COPY.title).disabled, true);
});

test('phone bridge exposes get and enabled-only set, with no regenerate or recipient setting', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI__: { core: { invoke: async (command, args) => {
    calls.push([command, args]); return { ok: true, data: saved() };
  } } } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'window', original); else delete globalThis.window; });
  await desktop.phoneSettingsGet();
  await desktop.phoneSettingsSet({ enabled: true, defaultRecipient: 'old-shape-is-ignored' });
  await desktop.phoneSettingsSet({ enabled: false });
  assert.deepEqual(calls, [
    ['phone_settings_get', {}], ['phone_settings_set', { enabled: true }], ['phone_settings_set', { enabled: false }],
  ]);
  assert.equal(desktop.phoneSettingsRegenerate, undefined);
});
