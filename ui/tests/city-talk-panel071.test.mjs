import test from 'node:test';
import assert from 'node:assert/strict';
import { talkRoute, talkProject, talkMessages, continueTalkCopy } from '../app/city/talk-model.js';

globalThis.window = {};
const { TalkPanel, sayLine } = await import('../app/city/talk.js');

// Small DOM fixture for panel state and controls. Markdown rendering is covered by browser preview.
class ElementStub {
  constructor(tag = 'div', text = '') {
    this.tagName = tag; this.parts = []; this.value = ''; this.hidden = false; this.disabled = false;
    this.dataset = {}; this.style = { setProperty() {} }; this.attrs = {}; this.events = {}; this.classes = new Set();
    this.classList = { add: c => this.classes.add(c) }; this.ownText = text;
    this.scrollHeight = 200; this.scrollTop = 0; this.clientHeight = 200;
  }
  get children() { return this.parts; }
  append(...parts) { this.parts.push(...parts); }
  replaceChildren(...parts) { this.parts = parts; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.events[k] = fn; }
  set textContent(text) { this.ownText = text; this.parts = []; }
  get textContent() { return this.ownText + this.parts.map(n => n.textContent || '').join(''); }
  focus() {}
  setSelectionRange() {}
}
globalThis.Node = ElementStub;
globalThis.document = {
  createElement: tag => new ElementStub(tag), createElementNS: (_, tag) => new ElementStub(tag),
  createTextNode: text => new ElementStub('#text', text), visibilityState: 'hidden', hasFocus: () => false,
};
const find = (node, cls) => node.classes?.has(cls) ? node : node.children?.map(n => find(n, cls)).find(Boolean);
const project = { id: 'local:demo', ids: ['local:demo', 'gh:owner/demo'], name: 'Demo', path: 'C:/demo' };

function fixture(t, overrides = {}) {
  const calls = [], handlers = new Set();
  const registry = [{ id: 'managed', provider: 'codex', title: 'Builder', status: 'idle', projectId: project.id }];
  const transcripts = new Map();
  const client = {
    viewing: new Set(), unread: new Set(), list: registry,
    on: (_, fn) => { handlers.add(fn); return () => handlers.delete(fn); },
    session: id => registry.find(s => s.id === id), running: id => registry.find(s => s.id === id)?.status === 'running',
    load: id => calls.push(['load', id]), transcript: id => ({ state: 'loaded', items: transcripts.get(id) || [] }),
    send: async (id, text) => { calls.push(['send', id, text]); },
    stop: async id => calls.push(['stop', id]),
    adopt: data => { registry.push(data.session); return data.session; },
  };
  const store = {
    project: id => project.ids.includes(id) ? project : null, agent: () => null,
    threadMessages: id => { calls.push(['thread', id]); return []; },
    threads: () => [], addressLabel: id => id, post: async payload => calls.push(['post', payload]),
  };
  const panel = new TalkPanel({ store, sessionClient: client, navigate() {}, ...overrides });
  panel.buildMessage = m => new ElementStub('message', m.text);
  t.after(() => panel.close());
  const managed = { id: 'sess:managed', kind: 'session', sessionId: 'managed', provider: 'codex', name: 'Builder', currentProjectId: project.id };
  return { panel, store, client, calls, handlers, transcripts, registry, managed };
}

test('routing prioritizes the exact managed session over its optional board address', () => {
  assert.deepEqual(talkRoute({ id: 'sess:managed', kind: 'session', sessionId: 'managed', address: 'wake-address' }), { kind: 'session', sessionId: 'managed', id: 'sess:managed' });
  assert.equal(talkRoute({ id: 'desktop', kind: 'external' }).kind, 'external');
  assert.equal(talkRoute({ id: 'unknown' }).kind, 'external', 'unknown ids never become invented mailbox addresses');
  assert.deepEqual(talkRoute({ id: 'board', address: 'codex-board' }), { kind: 'mailbox', address: 'codex-board', id: 'mail:codex-board' });
});

test('managed conversation displays its stream and sends each owner message to the same session', async t => {
  const { panel, managed, calls, transcripts, client, handlers } = fixture(t);
  transcripts.set('managed', [{ key: 'a', kind: 'agent', text: 'Live answer', streaming: true, at: 1 }]);
  panel.open(managed);
  assert.equal(panel.log.textContent, 'Live answer');
  assert.equal(panel.messages(panel.info())[0].streaming, true);
  assert.ok(client.viewing.has('managed'));
  panel.input.value = 'First message'; panel.onInput(); await panel.send();
  panel.input.value = 'Second message'; panel.onInput(); await panel.send();
  assert.deepEqual(calls.filter(c => c[0] === 'send'), [['send', 'managed', 'First message'], ['send', 'managed', 'Second message']]);
  assert.equal(calls.some(c => ['post', 'thread'].includes(c[0])), false);
  transcripts.set('managed', [{ key: 'a', kind: 'agent', text: 'Finished answer', streaming: false }]);
  for (const fn of handlers) fn();
  assert.equal(panel.log.textContent, 'Finished answer');
  panel.close(); assert.equal(handlers.size, 0); assert.equal(client.viewing.has('managed'), false);
});

test('board send retries preserve the exact mailbox post id and use one uniform composer', async t => {
  const { panel, calls, store } = fixture(t);
  panel.open({ id: 'board', kind: 'mailbox', address: 'codex-board', name: 'Builder', provider: 'codex' });
  let attempts = 0;
  store.post = async payload => { calls.push(['post', payload]); if (++attempts === 1) throw new Error('Temporary failure'); };
  panel.input.value = 'Review the change'; panel.onInput(); await panel.send();
  assert.equal(panel.draft().text, 'Review the change');
  await panel.send();
  const posts = calls.filter(c => c[0] === 'post').map(c => c[1]);
  assert.equal(posts.length, 2); assert.deepEqual(posts[0], posts[1]); assert.equal(posts[0].to, 'codex-board');
  assert.equal(panel.mode.hidden, true);
  assert.equal(find(panel.head, 'city-talk-routing').attrs.title, 'Message board: it replies when it next checks the board.');
  assert.equal(panel.draft().text, '');
});

test('pending starts keep a draft, transition explicitly to the exact live session, and expose errors', t => {
  const { panel, managed, client } = fixture(t);
  const ghost = { id: 'starting', name: 'Builder', provider: 'codex', currentProjectId: 'gh:owner/demo' };
  panel.open(ghost, { pending: { provider: 'codex', projectId: project.id, label: 'Builder' } });
  assert.match(panel.status.textContent, /Starting Codex in Demo/); assert.equal(panel.sendBtn.disabled, true);
  panel.input.value = 'Keep this draft'; panel.onInput();
  assert.equal(panel.resolvePending(managed), true);
  assert.equal(panel.pendingStart, null); assert.equal(panel.thread.sessionId, 'managed'); assert.equal(panel.input.value, 'Keep this draft');
  assert.ok(client.viewing.has('managed'));
  panel.open(ghost, { pending: { provider: 'codex', projectId: project.id } });
  panel.failPending(new Error('Provider unavailable'));
  assert.match(panel.status.textContent, /Provider unavailable/); assert.equal(panel.status.attrs.role, 'alert'); assert.equal(panel.sendBtn.disabled, true);
});

test('optional New session here calls the canonical observed City project and otherwise stays hidden', t => {
  const chosen = [], details = [], { panel, managed } = fixture(t, { onNewSessionHere: (id, context) => { chosen.push(id); details.push(context); } });
  panel.open({ ...managed, currentProjectId: null, cityProjectId: 'gh:owner/demo' });
  find(panel.head, 'city-talk-new').events.click(); assert.deepEqual(chosen, [project.id]);
  assert.deepEqual(details, [{ projectId: project.id, provider: 'codex', agentId: managed.id }]);
  assert.equal(talkProject({ cityProjectId: 'gh:owner/demo' }, panel.store), project);
  panel.onNewSessionHere = null; panel.refresh(); assert.equal(find(panel.head, 'city-talk-new'), undefined);
});

test('New session here eligibility is shared across board and session agents and updates with scene context', t => {
  let allowed = true;
  const checked = [], selected = [], { panel, managed, store } = fixture(t, {
    onNewSessionHere: (id, details) => selected.push([id, details]),
    canNewSessionHere: (project, agent) => { checked.push([project.id, agent.id]); return Boolean(project.path) && allowed; },
  });
  for (const agent of [managed, { id: 'board', kind: 'mailbox', address: 'claude-board', provider: 'claude', name: 'Board agent', currentProjectId: project.id }]) {
    panel.open(agent);
    assert.ok(find(panel.head, 'city-talk-new'));
    find(panel.head, 'city-talk-new').events.click();
    assert.deepEqual(selected.at(-1), [project.id, { projectId: project.id, provider: agent.provider, agentId: agent.id }]);
    allowed = false; panel.refresh(); assert.equal(find(panel.head, 'city-talk-new'), undefined);
    allowed = true; panel.refresh(); assert.ok(find(panel.head, 'city-talk-new'));
    assert.ok(checked.some(([id, who]) => id === project.id && who === agent.id));
  }
  store.project = () => ({ id: 'gh:owner/uncloned', name: 'Uncloned', path: '' });
  panel.refresh(); assert.equal(find(panel.head, 'city-talk-new'), undefined);
});

test('New session here defaults to projects with a local folder without restricting the agent kind or status', t => {
  const { panel, managed, store } = fixture(t, { onNewSessionHere() {} });
  panel.open({ ...managed, status: 'active' }); assert.ok(find(panel.head, 'city-talk-new'));
  store.project = () => ({ ...project, path: '' }); panel.refresh();
  assert.equal(find(panel.head, 'city-talk-new'), undefined);
});

test('desktop continuation is explicit and uses a labelled fork with context before sending to the copy', async t => {
  let offered = 0;
  const { panel, calls, registry } = fixture(t, { featureCall: async (name, args) => {
    calls.push(['feature', name, args]); return { session: { id: 'copy', provider: 'codex', title: 'Demo (copy)', status: 'idle', cwd: project.path } };
  } });
  panel.open({ id: 'desktop', kind: 'external', name: 'Desktop', provider: 'codex', providerSessionId: 'provider-conversation', cwd: project.path, currentProjectId: project.id });
  panel.offerContinue = () => { offered++; };
  panel.input.value = 'Continue this task'; panel.onInput(); await panel.send();
  assert.equal(offered, 1); assert.equal(panel.input.readOnly, false); assert.equal(calls.some(c => c[0] === 'feature'), false);
  await panel.continueConversation(panel.info(), panel.draft().text);
  const adoption = calls.find(c => c[0] === 'feature');
  assert.deepEqual(adoption, ['feature', 'adopt', { provider: 'codex', providerSessionId: 'provider-conversation', cwd: project.path, title: 'Demo (copy)', mode: 'fork' }]);
  assert.ok(registry.some(s => s.id === 'copy')); assert.equal(panel.thread.sessionId, 'copy');
  assert.deepEqual(calls.filter(c => c[0] === 'send'), [['send', 'copy', 'Continue this task']]);
  assert.equal(calls.some(c => c[0] === 'post'), false);
});

test('desktop without a provider conversation never invents an id or claims transcript availability', async () => {
  await assert.rejects(continueTalkCopy({ kind: 'external', provider: 'codex', cwd: project.path }, project, { call() { assert.fail('no native call'); } }), /no copy route/);
  assert.deepEqual(talkMessages([{ key: 'owner', kind: 'owner', text: 'Question' }, { key: 'reply', kind: 'agent', text: 'Answer', streaming: true }]).map(m => [m.role, m.text, m.state]), [['owner', 'Question', 'completed'], ['agent', 'Answer', 'running']]);
  assert.ok(sayLine('This is a long reply. '.repeat(20)).length <= 80);
});

test('a send completing after a conversation switch cannot clear the new draft or emit its bubble', async t => {
  const spoken = [], { panel, client, managed, calls } = fixture(t, { onSent: text => spoken.push(text) });
  let finish;
  client.send = (id, text) => { calls.push(['send', id, text]); return new Promise(resolve => { finish = resolve; }); };
  panel.open(managed); panel.input.value = 'Original question'; panel.onInput();
  const sending = panel.send();
  panel.open({ id: 'board', kind: 'mailbox', address: 'codex-board', name: 'Board agent' });
  panel.input.value = 'Unsent second draft'; panel.onInput();
  finish(); await sending;
  assert.equal(panel.agent.id, 'board'); assert.equal(panel.input.value, 'Unsent second draft');
  assert.equal(panel.draft().text, 'Unsent second draft'); assert.deepEqual(spoken, []);
  assert.deepEqual(calls.filter(c => c[0] === 'send'), [['send', 'managed', 'Original question']]);
});

test('a delayed desktop copy sends its approved message without reopening after Leave', async t => {
  let finish;
  const changes = [], { panel, calls } = fixture(t, {
    featureCall: () => new Promise(resolve => { finish = resolve; }), onAgentChanged: agent => changes.push(agent.id),
  });
  panel.open({ id: 'desktop', kind: 'external', name: 'Desktop', provider: 'codex', providerSessionId: 'provider-conversation', cwd: project.path });
  panel.input.value = 'Carry on'; panel.onInput();
  const adopting = panel.continueConversation(panel.info(), 'Carry on');
  panel.close();
  finish({ session: { id: 'copy', provider: 'codex', title: 'Conversation (copy)', status: 'idle' } });
  await adopting;
  assert.equal(panel.isOpen, false); assert.deepEqual(changes, []);
  assert.deepEqual(calls.filter(c => c[0] === 'send'), [['send', 'copy', 'Carry on']]);
});

test('failure sending into an adopted copy retries that same copy rather than starting another', async t => {
  const { panel, client, calls } = fixture(t, { featureCall: async (name, args) => {
    calls.push(['feature', name, args]); return { session: { id: 'copy', provider: 'codex', status: 'idle' } };
  } });
  let attempts = 0;
  client.send = async (id, text) => { calls.push(['send', id, text]); if (++attempts === 1) throw new Error('Temporary failure'); };
  panel.open({ id: 'desktop', kind: 'external', name: 'Desktop', provider: 'codex', providerSessionId: 'provider-conversation', cwd: project.path });
  panel.input.value = 'Carry on'; panel.onInput();
  await panel.continueConversation(panel.info(), 'Carry on');
  assert.equal(panel.thread.sessionId, 'copy'); assert.equal(panel.draft().text, 'Carry on');
  await panel.send();
  assert.equal(calls.filter(c => c[0] === 'feature').length, 1);
  assert.deepEqual(calls.filter(c => c[0] === 'send').map(c => c[1]), ['copy', 'copy']);
});

for (const transition of ['leave', 'switch']) test(`desktop copy first-send failure after ${transition} retries its admitted copy`, async t => {
  let finishAdopt;
  const { panel, client, calls, registry, managed } = fixture(t, { featureCall: (name, args) => {
    calls.push(['feature', name, args]); return new Promise(resolve => { finishAdopt = resolve; });
  } });
  const external = { id: 'desktop', kind: 'external', name: 'Desktop', provider: 'codex',
    providerSessionId: 'provider-conversation', cwd: project.path };
  let attempts = 0, offers = 0;
  client.send = async (id, text) => {
    calls.push(['send', id, text]);
    if (++attempts === 1) throw new Error('First send failed');
  };
  panel.offerContinue = () => { offers++; };
  panel.open(external); panel.input.value = 'Carry on'; panel.onInput();
  const continuing = panel.continueConversation(panel.info(), 'Carry on');
  if (transition === 'leave') panel.close();
  else { panel.open(managed); panel.input.value = 'Other draft'; panel.onInput(); }
  finishAdopt({ session: { id: 'copy-A', provider: 'codex', title: 'Conversation (copy)', status: 'idle' } });
  await continuing;
  assert.equal(registry.filter(s => s.id === 'copy-A').length, 1);
  if (transition === 'leave') assert.equal(panel.isOpen, false);
  else { assert.equal(panel.agent.id, managed.id); assert.equal(panel.input.value, 'Other draft'); }
  panel.open(external);
  assert.equal(panel.draft().text, 'Carry on'); assert.match(panel.draft().error.message, /First send failed/);
  await panel.send();
  assert.equal(offers, 0, 'retry does not offer another fork');
  assert.equal(calls.filter(c => c[0] === 'feature').length, 1);
  assert.deepEqual(calls.filter(c => c[0] === 'send'), [['send', 'copy-A', 'Carry on'], ['send', 'copy-A', 'Carry on']]);
  assert.equal(panel.thread.sessionId, 'copy-A'); assert.equal(panel.draft().text, '');
  assert.equal(panel.draft().continuedCopy, null);
  if (transition === 'switch') {
    panel.open(managed); assert.equal(panel.input.value, 'Other draft');
  }
});

test('reopening an external source while its copy sends keeps the lock until the outcome', async t => {
  let finishAdopt, finishSend, signalSending;
  const sendingStarted = new Promise(resolve => { signalSending = resolve; });
  const { panel, client, calls } = fixture(t, { featureCall: (name, args) => {
    calls.push(['feature', name, args]); return new Promise(resolve => { finishAdopt = resolve; });
  } });
  const external = { id: 'desktop', kind: 'external', name: 'Desktop', provider: 'codex',
    providerSessionId: 'provider-conversation', cwd: project.path };
  let offers = 0;
  panel.offerContinue = () => { offers++; };
  client.send = (id, text) => {
    calls.push(['send', id, text]); signalSending();
    return new Promise(resolve => { finishSend = resolve; });
  };
  panel.open(external); panel.input.value = 'Carry on'; panel.onInput();
  const continuing = panel.continueConversation(panel.info(), 'Carry on');
  panel.close();
  finishAdopt({ session: { id: 'copy-A', provider: 'codex', title: 'Conversation (copy)', status: 'idle' } });
  await sendingStarted;
  try {
    panel.open(external);
    assert.equal(panel.draft().sending, true); assert.equal(panel.input.readOnly, true); assert.equal(panel.sendBtn.disabled, true);
    await panel.send();
    assert.equal(offers, 0); assert.equal(calls.filter(c => c[0] === 'feature').length, 1);
    assert.deepEqual(calls.filter(c => c[0] === 'send'), [['send', 'copy-A', 'Carry on']]);
  } finally { finishSend(); await continuing; }
  assert.equal(panel.agent.id, external.id, 'completion does not reopen the copy');
  assert.equal(panel.draft().sending, false); assert.equal(panel.draft().continuedCopy, null);
  assert.equal(panel.draft().text, ''); assert.equal(panel.input.value, ''); assert.equal(panel.input.readOnly, false);
});

for (const [field, value] of [['providerSessionId', 'other-conversation'], ['cwd', 'C:/other-project'], ['provider', 'claude'], ['id', 'other-desktop']]) {
  test(`copy recovery does not reuse an admitted route after ${field} changes`, async t => {
    const { panel, client, calls } = fixture(t, { featureCall: async (name, args) => {
      calls.push(['feature', name, args]);
      return { session: { id: 'copy-A', provider: 'codex', title: 'Conversation (copy)', status: 'idle' } };
    } });
    const external = { id: 'desktop', kind: 'external', name: 'Desktop', provider: 'codex',
      providerSessionId: 'provider-conversation', cwd: project.path };
    client.send = async (id, text) => { calls.push(['send', id, text]); throw new Error('First send failed'); };
    panel.open(external); panel.input.value = 'Carry on'; panel.onInput();
    await panel.continueConversation(panel.info(), 'Carry on');
    assert.equal(panel.draft().continuedCopy.session.id, 'copy-A');
    let offers = 0;
    panel.offerContinue = () => { offers++; };
    panel.open({ ...external, [field]: value });
    panel.input.value = 'Confirm a different source'; panel.onInput();
    await panel.send();
    assert.equal(offers, 1, 'a changed source needs explicit continuation confirmation');
    assert.equal(calls.filter(c => c[0] === 'feature').length, 1, 'no automatic new copy');
    assert.deepEqual(calls.filter(c => c[0] === 'send'), [['send', 'copy-A', 'Carry on']], 'no send to the old copy');
  });
}
