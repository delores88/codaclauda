import test from 'node:test';
import assert from 'node:assert/strict';
import { mountChatSheet, sheetThread } from '../app/city/chat-sheet.js';
import { mergeComposerDraft } from '../app/views/chat.js';

test('draft handoff preserves existing text and files while invalidating the old send payload', () => {
  const shared = { id: 'same', name: 'shared.txt' }, first = { id: 'first', name: 'first.txt' }, second = { id: 'second', name: 'second.txt' };
  const current = { text: 'Already in Chat', files: [shared, first], subject: 'Existing subject', replyTo: { id: 'old-reply' }, pending: { id: 'old-send' } };
  const incoming = { text: 'From the City', files: [shared, second], subject: 'City subject', replyTo: { id: 'other-reply' } };
  const merged = mergeComposerDraft(current, incoming);
  assert.equal(merged.text, 'Already in Chat\n\nFrom the City');
  assert.deepEqual(merged.files, [shared, first, second]);
  assert.equal(merged.subject, 'Existing subject');
  assert.equal(merged.replyTo, null);
  assert.equal(merged.pending, null);
  assert.equal(current.text, 'Already in Chat');
  assert.equal(incoming.text, 'From the City');
  assert.equal(mergeComposerDraft({ text: '', files: [] }, incoming), incoming);
  assert.equal(mergeComposerDraft(current, current), current);
});

test('sheet opens owned session and shared conversations, and only existing agent chats', () => {
  const records = [{ id: 'one' }, { id: 'two', sharedId: 'pair' }];
  const agents = [{ id: 'mail', kind: 'mailbox', address: 'agent-board' }, { id: 'worker', endpointId: 'endpoint-one' }, { id: 'unreadable', endpointId: 'endpoint-two' }, { id: 'desktop', kind: 'external' }];
  const store = { agent: id => agents.find(a => a.id === id), threads: () => [{ id: 'live:old', kind: 'live', agentId: 'endpoint:endpoint-one' }] };
  const client = { session: id => records.find(s => s.id === id) };
  assert.equal(sheetThread({ sessionId: 'one' }, store, client), 'sess:one');
  assert.equal(sheetThread({ sessionId: 'two' }, store, client), 'pair:pair');
  assert.equal(sheetThread({ agent: { kind: 'session', sessionId: 'two' } }, store, client), 'pair:pair');
  assert.equal(sheetThread({ agentId: 'mail' }, store, client), 'mail:agent-board');
  assert.equal(sheetThread({ agentId: 'worker' }, store, client), 'live:old');
  for (const target of [{ sessionId: 'missing' }, { agentId: 'unreadable' }, { agentId: 'desktop' }, { agentId: 'missing' }]) assert.equal(sheetThread(target, store, client), null);
});

function fixture(t) {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const events = [], changed = [], navigation = [], notices = [];
  const previousFocus = { isConnected: true, focus() { events.push('focus'); } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: previousFocus, querySelector: () => null } });
  t.after(() => { if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete globalThis.document; });
  const h = (tag, props, ...children) => {
    if (!props || typeof props !== 'object' || props.tag || Array.isArray(props)) { children.unshift(props); props = {}; }
    return { tag, ...props, children: children.flat(Infinity).filter(x => x != null), listeners: new Map(),
      append(child) { this.children.push(child); },
      addEventListener(name, fn) { this.listeners.set(name, fn); },
      remove() { this.removed = true; },
    };
  };
  const ui = { h, icon: () => null, iconButton: (icon, label, onclick) => h('button', { title: label, onclick }), toast: text => notices.push(text) };
  const host = h('div');
  let threadId = null;
  const view = { show(params) { threadId = params.thread; events.push(['show', params]); }, hide() { events.push('hide'); }, destroy() { events.push('destroy'); }, get threadId() { return threadId; } };
  const sheet = mountChatSheet(host, { ui, store: { agent: () => null }, navigate: (...args) => navigation.push(args) }, {
    client: { session: id => id === 'one' ? { id } : null, stop() { events.push('STOP'); }, close() { events.push('CLOSE'); } },
    onChange: open => changed.push(open), mountConversation(root, ctx, options) { events.push(['mount', options]); return view; },
  });
  return { sheet, events, changed, navigation, notices, view };
}

test('opening, hiding, restoring and closing the sheet reuse Chat without stopping a session', t => {
  const { sheet, events, changed } = fixture(t);
  assert.equal(sheet.node.hidden, true);
  assert.equal(sheet.open({ sessionId: 'one' }), true);
  assert.equal(sheet.node.hidden, false);
  assert.deepEqual(events.slice(0, 2), [['mount', { embedded: true }], ['show', { thread: 'sess:one' }]]);
  sheet.hide();
  assert.equal(sheet.node.hidden, true);
  sheet.show();
  assert.equal(sheet.node.hidden, false);
  assert.equal(events.filter(e => Array.isArray(e) && e[0] === 'mount').length, 1);
  sheet.close();
  sheet.show();
  assert.equal(sheet.node.hidden, true, 'explicit close does not reopen when City is shown');
  assert.deepEqual(changed, [true, false, true, false]);
  assert.ok(events.includes('focus'));
  assert.ok(!events.includes('STOP') && !events.includes('CLOSE'));
  sheet.destroy();
  assert.ok(events.includes('destroy'));
  assert.equal(sheet.node.removed, true);
  assert.equal(sheet.open({ sessionId: 'one' }), false);
});

test('Open in Chat navigates to the same thread and Escape stays out of City controls', t => {
  const { sheet, events, navigation } = fixture(t);
  sheet.open({ sessionId: 'one' });
  const toolbar = sheet.node.children[0];
  const openButton = toolbar.children.find(n => n.tag === 'button.btn.small.ghost');
  openButton.onclick();
  assert.deepEqual(navigation, [['chat', { thread: 'sess:one' }]]);
  assert.equal(sheet.node.hidden, true);
  sheet.open({ sessionId: 'one' });
  let stopped = 0, prevented = 0;
  sheet.node.listeners.get('keydown')({ key: 'Escape', stopPropagation: () => stopped++, preventDefault: () => prevented++ });
  assert.equal(stopped, 1);
  assert.equal(prevented, 1);
  assert.equal(sheet.node.hidden, true);
  assert.ok(!events.includes('STOP') && !events.includes('CLOSE'));
});

test('unsupported external or missing conversations never mount a fake live chat', t => {
  const { sheet, events, notices } = fixture(t);
  assert.equal(sheet.open({ sessionId: 'missing' }), false);
  assert.equal(sheet.open({ agent: { kind: 'external' } }), false);
  assert.equal(sheet.node.hidden, true);
  assert.equal(events.length, 0);
  assert.equal(notices.length, 2);
});

test('Open in Chat hands off an unsent draft through the existing view navigation', t => {
  const { sheet, navigation, view } = fixture(t);
  const draft = { text: 'Finish this thought', files: [{ id: 'attachment' }] };
  view.takeDraft = () => draft;
  sheet.open({ sessionId: 'one' });
  sheet.node.children[0].children.find(n => n.tag === 'button.btn.small.ghost').onclick();
  assert.deepEqual(navigation, [['chat', { thread: 'sess:one', draft }]]);
  assert.equal(sheet.node.hidden, true);
});
