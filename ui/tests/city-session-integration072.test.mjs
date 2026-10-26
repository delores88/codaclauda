import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = {};
globalThis.localStorage = { getItem: () => null };
const { CityView } = await import('../app/views/city.js');

test('a start finishing after City hides defers opening and viewing the conversation', () => {
  const opened = [], view = Object.create(CityView.prototype);
  Object.assign(view, { visible: false, chatSheet: { open: target => opened.push(target) } });
  const target = { sessionId: 'new-owner-session' };
  view.openCityChat(target);
  assert.equal(view.pendingCityChat, target);
  assert.deepEqual(opened, []);
  view.visible = true;
  view.openCityChat(target);
  assert.deepEqual(opened, [target]);
});

test('Agents here opens managed sessions while metadata-only external agents retain their detail flow', () => {
  const opened = [], selected = [], view = Object.create(CityView.prototype);
  let focused = 0;
  Object.assign(view, { openCityChat: target => opened.push(target), select: target => selected.push(target), focusSelection: () => focused++ });
  view.openAgentChat({ id: 'sess:one', kind: 'session', sessionId: 'one' });
  view.openAgentChat({ id: 'mail:helper', kind: 'mailbox', address: 'helper' });
  view.openAgentChat({ id: 'ext:metadata', kind: 'external' });
  assert.deepEqual(opened, [{ agentId: 'sess:one', sessionId: 'one' }, { agentId: 'mail:helper' }]);
  assert.deepEqual(selected, [{ kind: 'agent', id: 'ext:metadata' }]);
  assert.equal(focused, 1);
});

test('an open sheet suppresses the building panel without discarding the selection', () => {
  const view = Object.create(CityView.prototype), selection = { kind: 'building', id: 'local:project' };
  Object.assign(view, { selection, panel: { hidden: false }, root: { classList: { remove() {} } }, chatSheet: { node: { hidden: false } } });
  view.refreshPanel();
  assert.equal(view.panel.hidden, true);
  assert.equal(view.selection, selection);
});

test('camera framing excludes the desktop chat sheet using its viewport bounds', () => {
  const originalWindow = globalThis.window;
  globalThis.window = { innerWidth: 1440, innerHeight: 1000 };
  try {
    const view = Object.create(CityView.prototype), hidden = { hidden: true };
    const sheet = { hidden: false, getClientRects: () => [1], getBoundingClientRect: () => ({ left: 1020, top: 56, width: 420, height: 944 }) };
    Object.assign(view, {
      visible: true, world: { size: { w: 1364, h: 944 }, setFramingRect: rect => { view.actualFrame = rect; } },
      syncCameraFramingMode() {}, stage: { getBoundingClientRect: () => ({ left: 76, top: 56, width: 1364, height: 944 }) },
      root: { style: { setProperty() {} } }, hud: hidden, legend: hidden, toolbar: hidden, machinesCard: hidden, panel: hidden,
      chatSheet: { node: sheet },
    });
    view.updateCameraFrame();
    assert.equal(view.actualFrame.right, 936);
    assert.equal(view.actualFrame.left, 0);
    sheet.hidden = true;
    view.updateCameraFrame();
    assert.equal(view.actualFrame.right, 1364);
  } finally { globalThis.window = originalWindow; }
});
