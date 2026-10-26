import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE, toonMaterial } from '../app/city/toon.js';
import { instancedOutline, disposeAll } from '../app/city/fx.js';

globalThis.window = {};
globalThis.localStorage = { getItem: () => null };
const { cutawayTalkMeshes } = await import('../app/city/talk-frame.js');
const { CityView } = await import('../app/views/city.js');
const { TalkPanel } = await import('../app/city/talk.js');

function scenery(t) {
  const root = new THREE.Group(), material = toonMaterial('#778899', { cache: false });
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 3, 2), material, 2);
  const outline = instancedOutline(mesh), hidden = instancedOutline(mesh); hidden.visible = false;
  const unrelated = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, 1);
  const otherOutline = instancedOutline(unrelated);
  root.add(mesh, outline, hidden, unrelated, otherOutline);
  t.after(() => disposeAll(root));
  return { root, mesh, material, outline, hidden, otherOutline };
}

test('cutaway hides the matching sibling instanced outline and preserves unrelated or already hidden hulls', t => {
  const { mesh, material, outline, hidden, otherOutline } = scenery(t);
  const restore = cutawayTalkMeshes([mesh]), copy = mesh.material; let disposed = 0;
  copy.addEventListener('dispose', () => disposed++);
  assert.equal(copy.opacity, .1); assert.equal(material.opacity, 1);
  assert.equal(outline.visible, false); assert.equal(hidden.visible, false); assert.equal(otherOutline.visible, true);
  restore();
  assert.equal(mesh.material, material); assert.equal(outline.visible, true); assert.equal(hidden.visible, false);
  assert.equal(otherOutline.visible, true); assert.equal(disposed, 1);
});

test('cutaway cleanup cannot overwrite a material replaced by another scene update', t => {
  const { mesh } = scenery(t), replacement = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  const restore = cutawayTalkMeshes([mesh]), copy = mesh.material; let disposed = 0;
  copy.addEventListener('dispose', () => disposed++);
  mesh.material = replacement; restore();
  assert.equal(mesh.material, replacement); assert.equal(disposed, 1);
});

test('City sync restores original materials before geometry rebuild disposal and schedules talk restaging', t => {
  const { root, mesh, material } = scenery(t); let disposed = 0;
  material.addEventListener('dispose', () => disposed++);
  const talk = { phase: 'on', restoreCutaway: cutawayTalkMeshes([mesh]) };
  const rebuilt = new Error('rebuild observed');
  const view = Object.assign(Object.create(CityView.prototype), {
    talk, root: { classList: { toggle() {} } }, reduced: () => false,
    store: { projects: [], visibleProjects: () => [], cityLots: {}, cityProjectsReady: true },
    ensureDistrictBanks: () => true, persistLots() {},
    slots: { assign: () => ({ cells: new Map(), rings: 1 }) },
    world: { setRings() { assert.equal(mesh.material, material); disposeAll(root); throw rebuilt; } },
  });
  assert.throws(() => view.sync(), error => error === rebuilt);
  assert.equal(talk.restoreCutaway, null); assert.equal(talk.phase, 'wait');
  assert.ok(disposed > 0, 'normal disposal reaches original nonshared material');
});

class ElementStub {
  constructor() { this.children = []; this.hidden = false; this.classList = { add() {}, remove() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  addEventListener() {}
}

test('graphics-context failure restores cutaways, releases the NPC and closes session viewing/listeners', t => {
  const before = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = ElementStub;
  globalThis.document = { createElement: () => new ElementStub(), createElementNS: () => new ElementStub(), createTextNode: () => new ElementStub() };
  t.after(() => { globalThis.document = before.document; globalThis.Node = before.Node; });
  const { mesh, material, outline } = scenery(t);
  let unsubscribed = 0, holds = [], releasedSpots = [];
  const pendingSpot = { x: 1, z: 2 };
  const viewing = new Set(['managed']);
  const panel = Object.assign(Object.create(TalkPanel.prototype), {
    sessions: { viewing }, thread: { kind: 'session', sessionId: 'managed' }, agent: { id: 'sess:managed' },
    offSessions: () => unsubscribed++, node: new ElementStub(), log: new ElementStub(), cache: new Map(),
  });
  const view = Object.assign(Object.create(CityView.prototype), {
    talk: { id: 'sess:managed', pendingSpot, restoreCutaway: cutawayTalkMeshes([mesh]) }, talkPanel: panel,
    npcs: { hold: (...args) => holds.push(args), releaseTalkSpot: id => releasedSpots.push(id) }, cityRoot: new ElementStub(),
    hud: {}, legend: {}, toolbar: {}, help: {}, panel: {}, empty: {}, overlay: {}, machinesCard: {}, leaveBtn: {}, bars: [],
    fallback: new ElementStub(), ctx: { navigate() {} },
  });
  view.fail('Graphics context lost');
  assert.equal(view.failed, true); assert.equal(view.talk, null); assert.equal(panel.isOpen, false);
  assert.equal(mesh.material, material); assert.equal(outline.visible, true);
  assert.deepEqual(holds, [['sess:managed', false]]); assert.equal(viewing.size, 0); assert.equal(unsubscribed, 1);
  assert.deepEqual(releasedSpots, [pendingSpot]);
  assert.equal(view.fallback.hidden, false);
});
