import test from 'node:test';
import assert from 'node:assert/strict';
import { desktop } from '../app/bridge.js';
import { phoneSettings, phoneSettingsValue, phoneApprovalsText, PHONE_COPY } from '../app/views/settings-phone.js';

const TOPIC = 'https://ntfy.sh/example-phone-conversation';
const saved = patch => ({ enabled: true, topicUrl: TOPIC, lastRecipient: null, recipients: [], lastError: null,
  approvals: { enabled: true, locked: false, waiting: 0 }, ...patch });

function fixture(t, initial = saved()) {
  let persisted = structuredClone(initial);
  const calls = [], nodes = [], notices = [];
  const methods = {
    phoneSettingsGet: async () => { calls.push(['get']); return structuredClone(persisted); },
    phoneSettingsSet: async args => { calls.push(['set', args]); persisted = { ...persisted, ...args }; return structuredClone(persisted); },
    phoneApprovalsSet: async ({ enabled }) => { calls.push(['approvals', enabled]); persisted.approvals = { ...persisted.approvals, enabled }; return structuredClone(persisted); },
    phoneApprovalsUnlock: async () => { calls.push(['unlock']); persisted.approvals = { ...persisted.approvals, locked: false }; return structuredClone(persisted); },
  };
  for (const [name, fn] of Object.entries(methods)) t.mock.method(desktop, name, fn);
  function h(tag, props, ...children) {
    if (!props || typeof props !== 'object' || props.node || Array.isArray(props)) { children.unshift(props); props = {}; }
    const node = { node: true, tag, value: '', checked: false, disabled: false, hidden: false, textContent: '', ...props, children: children.flat().filter(x => x != null) };
    nodes.push(node); return node;
  }
  const ui = { h, icon: () => null, toast: (...args) => notices.push(args) };
  const card = phoneSettings({ ui, store: {} });
  return {
    card, calls, notices, update: patch => { persisted = { ...persisted, ...patch }; },
    section: () => nodes.find(n => n.tag === 'div.phone-approvals'),
    toggle: () => nodes.find(n => n['aria-label'] === PHONE_COPY.approvalsTitle),
    unlock: () => nodes.find(n => n.tag.startsWith('button') && n.children.includes('Unlock phone approvals')),
    status: () => nodes.find(n => n.tag.includes('phone-approvals-status')).textContent,
  };
}

test('phone approvals show on a build that has them, on by default, and the switch saves only that setting', async t => {
  const f = fixture(t);
  await f.card.load();
  assert.equal(f.section().hidden, false);
  assert.equal(f.toggle().checked, true);
  assert.match(f.status(), /^On: new approval requests go to your phone/);
  assert.equal(f.unlock().hidden, true);
  f.toggle().checked = false;
  await f.toggle().onchange({ currentTarget: f.toggle() });
  assert.deepEqual(f.calls.at(-1), ['approvals', false]);
  assert.match(f.status(), /^Off: approval requests stay in CodaClauda > Approvals/);
  assert.equal(f.calls.some(c => c[0] === 'set'), false, 'messaging is untouched');
});

test('locked after wrong codes: the owner unlocks on the PC; the switch needs messaging and a topic', async t => {
  const f = fixture(t, saved({ approvals: { enabled: true, locked: true, waiting: 2 } }));
  await f.card.load();
  assert.match(f.status(), /^Locked after five wrong codes/);
  assert.equal(f.unlock().hidden, false);
  await f.unlock().onclick();
  assert.deepEqual(f.calls.at(-1), ['unlock']);
  assert.match(f.status(), /^On: 2 requests are waiting/);
  assert.equal(f.unlock().hidden, true);
  f.update({ enabled: false });
  await f.card.load();
  assert.equal(f.toggle().disabled, true);
  assert.match(f.status(), /Turn on phone messages above/);
});

test('an older build without phone approvals hides the section', async t => {
  const f = fixture(t, saved({ approvals: undefined }));
  await f.card.load();
  assert.equal(f.section().hidden, true);
  assert.equal(phoneSettingsValue({ enabled: true, recipients: [] }).approvals, null);
  assert.equal(phoneApprovalsText({ approvals: null }), '');
});

test('the copy names what the phone can reach and what it cannot, and that codes are one-time', () => {
  assert.match(PHONE_COPY.approvalsIntro, /says which chat it is for/);
  assert.match(PHONE_COPY.approvalsIntro, /Copy the whole line/);
  assert.match(PHONE_COPY.approvalsNotSent, /not sent to any agent/);
  for (const text of Object.values(PHONE_COPY)) assert.doesNotMatch(text, /[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/, 'no example code Ben could paste literally');
  assert.match(PHONE_COPY.approvalsIntro, /Codex chats set to Wake by mail/);
  assert.match(PHONE_COPY.approvalsIntro, /Remote Control/);
  assert.match(PHONE_COPY.approvalsTrust, /works once, expires after 24 hours/);
  assert.match(PHONE_COPY.approvalsTrust, /Five wrong codes lock/);
});
