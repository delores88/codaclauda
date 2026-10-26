import test from 'node:test';
import assert from 'node:assert/strict';
import { SlotMap } from '../app/city/layout.js';
import { DOWNTOWN, SUBURBS } from '../app/city/districts.js';

globalThis.window = {};
globalThis.localStorage = { getItem: () => null };
const { CityView } = await import('../app/views/city.js');
const projects = (repos, local) => [
  ...Array.from({ length: repos }, (_, n) => ({ id: `gh:owner/project-${n}` })),
  ...Array.from({ length: local }, (_, n) => ({ id: `local:project-${n}`, path: `C:/project-${n}` })),
];
function fixture({ saved, ready = true, current = null } = {}) {
  const writes = [], view = Object.create(CityView.prototype);
  const slots = new SlotMap();
  Object.assign(view, {
    slots, islands: { current, homeSlots: slots },
    store: { prefs: { cityLargerDistrictV1: saved }, cityProjectsReady: ready,
      setPref(name, value) { writes.push([name, value]); this.prefs[name] = value; } },
  });
  return { view, writes, slots };
}

test('provisional banks render immediately and the final inventory choice is saved once', () => {
  const { view, writes, slots } = fixture({ ready: false });
  assert.equal(view.ensureDistrictBanks(projects(0, 2)), true);
  assert.notEqual(view.slots, slots); assert.equal(view.homeBanks.positiveZ, SUBURBS);
  assert.deepEqual(writes, []);
  const provisional = view.slots;
  view.ensureDistrictBanks(projects(6, 2));
  assert.equal(view.slots, provisional, 'pending updates cannot flip provisional banks');
  view.store.cityProjectsReady = true;
  assert.equal(view.ensureDistrictBanks(projects(6, 2)), true);
  assert.equal(view.homeBanks.positiveZ, DOWNTOWN);
  assert.equal(view.slots, view.islands.homeSlots);
  assert.notEqual(view.slots, slots);
  assert.deepEqual(writes, [['cityLargerDistrictV1', DOWNTOWN]]);
  const first = view.slots;
  view.ensureDistrictBanks(projects(1, 20));
  assert.equal(view.slots, first); assert.equal(view.homeBanks.positiveZ, DOWNTOWN);
  assert.equal(writes.length, 1);
});

test('saved banks apply before hydration and survive reload with a new majority', () => {
  for (const saved of [DOWNTOWN, SUBURBS]) {
    const { view, writes } = fixture({ saved, ready: false });
    assert.equal(view.ensureDistrictBanks(projects(saved === DOWNTOWN ? 0 : 20, 5)), true);
    assert.equal(view.homeBanks.positiveZ, saved);
    assert.deepEqual(writes, []);
  }
});

test('invalid saved choices still render and are replaced once hydration finishes', () => {
  const { view, writes } = fixture({ saved: 'invalid', ready: false });
  assert.equal(view.ensureDistrictBanks([]), true);
  assert.deepEqual(writes, []);
  view.store.cityProjectsReady = true;
  assert.equal(view.ensureDistrictBanks(projects(2, 6)), true);
  assert.equal(view.homeBanks.positiveZ, SUBURBS);
  assert.deepEqual(writes, [['cityLargerDistrictV1', SUBURBS]]);
});

test('contributor visits cannot select home banks; returning updates the home slot pointer', () => {
  const { view, writes, slots } = fixture({ current: 'contributor', ready: true });
  assert.equal(view.ensureDistrictBanks(projects(0, 20)), true);
  assert.equal(view.slots, slots); assert.equal(view.homeBanks, undefined);
  assert.deepEqual(writes, []);
  view.islands.current = null;
  view.ensureDistrictBanks(projects(6, 2));
  assert.equal(view.homeBanks.positiveZ, DOWNTOWN);
  assert.equal(view.islands.homeSlots, view.slots);
});
