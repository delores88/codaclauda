import test from 'node:test';
import assert from 'node:assert/strict';
import { desktop } from '../app/bridge.js';
import { phoneSettings, phoneSettingsValue, phoneEnableProblem, PHONE_COPY } from '../app/views/settings-phone.js';

const INBOUND = `https://ntfy.sh/${'a'.repeat(32)}`;
const REPLY = 'https://ntfy.sh/example-replies';
const saved = patch => ({ enabled: false, inboundUrl: null, defaultRecipient: null, recipients: [{ address: 'codex-example', label: 'Example agent' }], lastError: null, ...patch });

// Small UI adapter: run the real event handlers and inspect their rendered controls.
// No DOM library, native service, network request, or browser state is needed.
function fixture(t, initial = saved(), handlers = {}) {
  let persisted = structuredClone(initial);
  const calls = [], nodes = [], notices = [], copies = [];
  const methods = {
    phoneSettingsGet: async () => { calls.push(['get']); return structuredClone(persisted); },
    phoneSettingsSet: async args => { calls.push(['set', args]); persisted = { ...persisted, ...args }; return structuredClone(persisted); },
    phoneSettingsRegenerate: async () => { calls.push(['regenerate']); persisted.inboundUrl = INBOUND; return structuredClone(persisted); },
    ...handlers,
  };
  for (const [name, fn] of Object.entries(methods)) t.mock.method(desktop, name, fn);
  function h(tag, props, ...children) {
    if (!props || typeof props !== 'object' || props.node || Array.isArray(props)) { children.unshift(props); props = {}; }
    const node = { node: true, tag, value: '', checked: false, disabled: false, hidden: false, textContent: '', ...props,
      children: children.flat().filter(x => x != null), replaceChildren(...items) { this.children = items; } };
    nodes.push(node); return node;
  }
  const ui = { h, icon: () => null, toast: (...args) => notices.push(args), copyText: (...args) => copies.push(args) };
  const card = phoneSettings({ ui, store: { setPref() { throw new Error('Phone settings must not enter the UI store.'); } } });
  const control = label => nodes.find(n => n['aria-label'] === label);
  const button = label => nodes.find(n => n.tag.startsWith('button') && n.children.includes(label));
  const change = async (label, value) => {
    const node = control(label);
    if (node.type === 'checkbox') node.checked = value; else node.value = value;
    await node.onchange({ currentTarget: node });
  };
  return { card, nodes, calls, notices, copies, control, button, change, persisted: () => persisted };
}

test('phone setup stays off and creates a topic only on the explicit setup action', async t => {
  const f = fixture(t);
  assert.equal(f.control(PHONE_COPY.title).disabled, true);
  await f.card.load();
  assert.deepEqual(f.calls, [['get']]);
  assert.equal(f.control(PHONE_COPY.title).checked, false);
  assert.equal(f.control(PHONE_COPY.title).disabled, true);
  assert.equal(f.button('Set up phone messages').disabled, false);
  await f.button('Set up phone messages').onclick();
  assert.deepEqual(f.calls, [['get'], ['regenerate']]);
  assert.equal(f.control('Private inbound topic URL').value, INBOUND);
  assert.equal(f.control(PHONE_COPY.title).checked, false);
  assert.equal(f.control(PHONE_COPY.title).disabled, true, 'the reply URL is still missing');
  f.card.setReplySettings({ ntfyUrl: REPLY });
  assert.equal(f.control(PHONE_COPY.title).disabled, false);
  await f.change(PHONE_COPY.title, true);
  assert.deepEqual(f.calls.at(-1), ['set', { enabled: true, defaultRecipient: null }]);
  assert.equal(f.control(PHONE_COPY.title).checked, true);
});

test('phone settings preserve a chosen recipient across reload and support the automatic default', async t => {
  const f = fixture(t, saved({ inboundUrl: INBOUND }));
  await f.card.load();
  await f.change('Default phone message recipient', 'codex-example');
  assert.deepEqual(f.calls.at(-1), ['set', { enabled: false, defaultRecipient: 'codex-example' }]);
  await f.card.load();
  assert.equal(f.control('Default phone message recipient').value, 'codex-example');
  await f.change('Default phone message recipient', '');
  assert.deepEqual(f.calls.at(-1), ['set', { enabled: false, defaultRecipient: null }]);
  assert.equal(f.persisted().defaultRecipient, null);
});

test('a failed phone save restores confirmed settings and a read failure requires refresh', async t => {
  const f = fixture(t, saved({ inboundUrl: INBOUND }), {
    phoneSettingsSet: async () => { throw new Error('PHONE_STORAGE_FAILED'); },
  });
  f.card.setReplySettings({ ntfyUrl: REPLY });
  await f.card.load();
  await f.change(PHONE_COPY.title, true);
  assert.equal(f.control(PHONE_COPY.title).checked, false);
  await f.change('Default phone message recipient', 'codex-example');
  assert.equal(f.control('Default phone message recipient').value, '');
  assert.match(f.notices.at(-1)[0], /PHONE_STORAGE_FAILED/);
  desktop.phoneSettingsGet = async () => { throw new Error('Could not read phone settings.'); };
  await f.card.load();
  assert.equal(f.control(PHONE_COPY.title).disabled, true);
  assert.equal(f.button('Regenerate').disabled, true);
  assert.equal(f.button('Refresh phone status').disabled, false);
  assert.equal(f.nodes.find(n => n.role === 'alert').textContent, 'Could not read phone settings.');
});

test('phone copy and regeneration use the native topic without writing UI preferences', async t => {
  const oldUrl = `https://ntfy.sh/${'b'.repeat(32)}`;
  const f = fixture(t, saved({ inboundUrl: oldUrl }));
  await f.card.load();
  await f.button('Copy').onclick();
  assert.deepEqual(f.copies, [[oldUrl, 'Inbound URL copied']]);
  await f.button('Regenerate').onclick();
  assert.equal(f.control('Private inbound topic URL').value, INBOUND);
  await f.button('Copy').onclick();
  assert.equal(f.copies.at(-1)[0], INBOUND);
  assert.deepEqual(f.calls, [['get'], ['regenerate']]);
});

test('phone enable requires distinct inbound and reply topics but can always be turned off', async t => {
  assert.match(phoneEnableProblem(saved(), REPLY), /Set up phone messages/);
  assert.match(phoneEnableProblem(saved({ inboundUrl: INBOUND }), 'http://ntfy.sh/example'), /Save a phone notification topic/);
  assert.match(phoneEnableProblem(saved({ inboundUrl: INBOUND }), `${INBOUND}/`), /different phone notification topic/);
  const f = fixture(t, saved({ enabled: true, inboundUrl: INBOUND }));
  await f.card.load();
  assert.equal(f.control(PHONE_COPY.title).disabled, false, 'missing outbound URL must not trap the enabled state');
  await f.change(PHONE_COPY.title, false);
  assert.deepEqual(f.calls.at(-1), ['set', { enabled: false, defaultRecipient: null }]);
});

test('recipient labels render as text and an unavailable saved address stays visible', async t => {
  const f = fixture(t, saved({ defaultRecipient: 'removed-agent', recipients: [{ address: 'codex-example', label: '<img src=x>' }] }));
  await f.card.load();
  const options = f.control('Default phone message recipient').children;
  assert.equal(options[1].children[0], '<img src=x> (codex-example)');
  assert.equal(options[2].children[0], 'removed-agent (unavailable; choose another recipient)');
  assert.equal(f.control('Default phone message recipient').value, 'removed-agent');
  assert.equal(f.calls.length, 1, 'opening settings does not silently choose a new recipient');
  assert.throws(() => phoneSettingsValue(null), /not confirmed/);
  assert.throws(() => phoneSettingsValue({ enabled: 'yes', recipients: [] }), /not confirmed/);
});

test('phone bridge uses only the three owner desktop commands with explicit settings arguments', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI__: { core: { invoke: async (command, args) => {
    calls.push([command, args]); return { ok: true, data: saved() };
  } } } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'window', original); else delete globalThis.window; });
  await desktop.phoneSettingsGet();
  await desktop.phoneSettingsRegenerate();
  await desktop.phoneSettingsSet({ enabled: true, defaultRecipient: 'codex-example' });
  await desktop.phoneSettingsSet({ enabled: false });
  assert.deepEqual(calls, [
    ['phone_settings_get', {}], ['phone_settings_regenerate', {}],
    ['phone_settings_set', { enabled: true, defaultRecipient: 'codex-example' }],
    ['phone_settings_set', { enabled: false, defaultRecipient: null }],
  ]);
});
