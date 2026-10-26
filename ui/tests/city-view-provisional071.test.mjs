import test from 'node:test';
import assert from 'node:assert/strict';
import { SlotMap } from '../app/city/layout.js';
import { DOWNTOWN, districtBanks } from '../app/city/districts.js';

globalThis.window = {};
globalThis.localStorage = { getItem: () => null };
const { CityView } = await import('../app/views/city.js');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const project = (id, ids = [id]) => ({ id, ids, path: id.startsWith('local:') ? `C:/${id.slice(6)}` : '', visible: { city: true } });

test('provisional rendering preserves pins and keeps rendered capacity; resolved reloads stay stable', async () => {
  const repos = Array.from({ length: 6 }, (_, n) => project(`gh:owner/project-${n}`));
  const linked = repos.slice(0, 2).map((p, n) => project(`local:linked-${n}`, [`local:linked-${n}`, p.id]));
  const local = Array.from({ length: 10 }, (_, n) => project(`local:home-${n}`));
  const complete = [...linked, ...repos.slice(2), ...local], transient = [...linked.map(p => project(p.id)), ...repos, ...local];
  const original = new SlotMap({ banks: districtBanks(DOWNTOWN) }).assign(complete);
  assert.equal(original.rings, 3);
  const pins = Object.fromEntries(original.pinRepairs.map(({ id, i, j }) => [id, { i, j }]));
  const initialPins = structuredClone(pins), writes = [];
  const store = {
    projects: transient, prefs: { cityLargerDistrictV1: DOWNTOWN }, cityProjectsReady: false,
    desktop: { cityLots: pins }, get cityLots() { return this.desktop.cityLots; },
    visibleProjects() { return this.projects; }, project(id) { return this.projects.find(p => p.ids.includes(id)); },
    setPref(name, value) { writes.push(['preference', name, value]); this.prefs[name] = value; },
    setCityLot(id, cell) { writes.push(['pin', id]); this.desktop.cityLots[id] = cell; },
    updateDesktop(fn) { writes.push(['desktop']); fn(this.desktop); },
  };
  const placed = new Error('placement complete');
  const createView = () => {
    const slots = new SlotMap();
    return Object.assign(Object.create(CityView.prototype), {
      store, slots, islands: { current: null, homeSlots: slots },
      root: { classList: { toggle() {} } }, reduced: () => false,
      world: { setRings() { throw placed; } },
    });
  };
  const view = createView();
  const syncPlacement = () => assert.throws(() => view.sync(), error => error === placed);
  syncPlacement(); await tick();
  assert.equal(view.cells.size, 18, 'pending inventory is rendered, not a frozen HQ-only scene');
  const provisionalRing = view.rings;
  assert.deepEqual(store.cityLots, initialPins); assert.deepEqual(writes, [], 'provisional migrations never write pins');
  store.projects = complete; store.cityProjectsReady = true;
  syncPlacement(); await tick();
  assert.deepEqual(store.cityLots, initialPins, 'every canonical and alias pin survives finalization');
  assert.deepEqual(view.cells, original.cells);
  // Immediate rendering may need spare capacity for identities that later
  // merge. The accepted contract retains that rendered edge within this view;
  // it never shrinks the island or guesses aliases to obtain a smaller fit.
  assert.equal(view.rings, provisionalRing);
  const settledRing = view.rings;
  syncPlacement(); await tick(); assert.equal(view.rings, settledRing);
  assert.equal(view.homeBanks.positiveZ, DOWNTOWN); assert.equal(view.islands.homeSlots, view.slots);
  // With resolved metadata already available on later opens, there is no
  // duplicate inventory to inflate capacity. Saved cells, not old empty
  // capacity, determine the initial size; repeated resolved opens agree.
  for (let n = 0; n < 2; n++) {
    const reopened = createView();
    assert.throws(() => reopened.sync(), error => error === placed); await tick();
    assert.deepEqual(reopened.cells, original.cells); assert.deepEqual(store.cityLots, initialPins);
    assert.equal(reopened.rings, original.rings);
  }
});

test('Pan shortcut respects typing, modal, portal and street/talk guards and toggles only once per press', t => {
  const before = globalThis.document; let modal = false, toggles = 0;
  globalThis.document = { querySelector: () => modal ? {} : null };
  t.after(() => { if (before) globalThis.document = before; else delete globalThis.document; });
  const view = Object.assign(Object.create(CityView.prototype), {
    visible: true, islands: {}, world: {}, togglePan() { toggles++; },
  });
  const press = patch => view.keyDown({ code: 'KeyP', key: 'p', target: { tagName: 'DIV' }, preventDefault() {}, ...patch });
  press(); assert.equal(toggles, 1); press({ repeat: true }); assert.equal(toggles, 1);
  for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { isContentEditable: true }]) press({ target });
  press({ ctrlKey: true }); press({ metaKey: true }); press({ altKey: true });
  modal = true; press(); modal = false;
  view.islands.blocking = true; press(); view.islands.blocking = false;
  view.talk = {}; press(); view.talk = null;
  view.visible = false; press(); view.visible = true;
  assert.equal(toggles, 1);
  view.togglePan = CityView.prototype.togglePan; view.toggleFollow = () => {};
  view.world.setPanMode = () => { toggles++; }; view.renderToolbarState = () => {};
  for (const guard of ['street', 'streetPending', 'talk']) { view[guard] = {}; press(); view[guard] = null; }
  assert.equal(toggles, 1); press(); assert.equal(toggles, 2);
});
