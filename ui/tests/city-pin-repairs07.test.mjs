import test from 'node:test';
import assert from 'node:assert/strict';
import { SlotMap } from '../app/city/layout.js';
import { DISTRICTS, DOWNTOWN, districtBanks } from '../app/city/districts.js';
import { riverCellUsable } from '../app/city/river-path.js';

globalThis.window = {};
globalThis.localStorage = { getItem: () => null };
const { CityView } = await import('../app/views/city.js');
const coordinates = ({ i, j }) => ({ i, j });
function writer(projects, pins) {
  const data = { cityLots: structuredClone(pins) }, writes = [];
  const store = {
    get cityLots() { return data.cityLots; },
    project: id => projects.find(p => p.id === id || p.ids?.includes(id)),
    setCityLot(id, cell) { writes.push({ kind: 'single', id }); data.cityLots[id] = cell; },
    updateDesktop(fn) { writes.push({ kind: 'batch' }); fn(data); },
  };
  return { store, writes, view: Object.assign(Object.create(CityView.prototype), { store }) };
}
function callbacks(t) {
  const queue = [];
  t.mock.method(globalThis, 'setTimeout', fn => { queue.push(fn); return queue.length; });
  return { queue, flush() { while (queue.length) queue.shift()(); } };
}

test('unchanged canonical-only pins persist missing aliases and reopen identically on either bank', t => {
  const timers = callbacks(t);
  for (const larger of DISTRICTS) {
    const banks = districtBanks(larger), pin = { i: 3, j: larger === DOWNTOWN ? 2 : -2 };
    const project = { id: 'local:existing', ids: ['gh:owner/existing'], path: 'C:/existing' };
    const f = writer([project], { [project.id]: pin }), slots = new SlotMap({ banks });
    const result = slots.assign([project], { pins: f.store.cityLots });
    assert.deepEqual(result.fresh, []); assert.deepEqual(result.migrated, []);
    f.view.persistLots(result.fresh, result.pinRepairs);
    assert.equal(f.store.cityLots['gh:owner/existing'], undefined, 'saving stays deferred beyond layout sync');
    timers.flush();
    assert.deepEqual(f.store.cityLots['gh:owner/existing'], pin);
    assert.deepEqual(f.store.cityLots[project.id], pin); assert.equal(f.writes.length, 1);
    const again = slots.assign([project], { pins: f.store.cityLots });
    f.view.persistLots(again.fresh, again.pinRepairs); timers.flush();
    assert.equal(f.writes.length, 1, 'settled aliases do not resave');
    const ghost = { id: 'gh:owner/existing', path: '' };
    const reopened = new SlotMap({ banks }).assign([ghost], { pins: f.store.cityLots });
    assert.deepEqual(coordinates(reopened.cells.get(ghost.id)), pin); assert.deepEqual(reopened.pinRepairs, []);
  }
});

test('river migration writes canonical and stale alias pins together while retaining fixed bank configuration', t => {
  const timers = callbacks(t);
  for (const larger of DISTRICTS) {
    const banks = districtBanks(larger), project = { id: 'local:move', ids: ['gh:owner/move'], path: 'C:/move' };
    const f = writer([project], { [project.id]: { i: 0, j: -1 }, 'gh:owner/move': { i: 1, j: -1 }, unrelated: { i: 24, j: 24 } });
    const result = new SlotMap({ banks }).assign([project], { pins: f.store.cityLots });
    assert.equal(result.migrated.length, 1); assert.equal(result.pinRepairs.length, 2);
    const destination = coordinates(result.cells.get(project.id));
    assert.ok(riverCellUsable(destination.i, destination.j));
    f.view.persistLots(result.fresh, result.pinRepairs); timers.flush();
    assert.deepEqual(f.writes, [{ kind: 'batch' }]);
    assert.deepEqual(f.store.cityLots[project.id], destination); assert.deepEqual(f.store.cityLots['gh:owner/move'], destination);
    assert.deepEqual(f.store.cityLots.unrelated, { i: 24, j: 24 });
    const next = new SlotMap({ banks }).assign([project], { pins: f.store.cityLots });
    assert.equal(next.banks, banks); assert.deepEqual(next.cells, result.cells);
    assert.deepEqual(next.migrated, []); assert.deepEqual(next.pinRepairs, []);
  }
});

test('shared aliases choose a stable owner without moving clones or repeatedly saving on either bank', t => {
  const timers = callbacks(t);
  for (const larger of DISTRICTS) {
    const banks = districtBanks(larger), z = larger === DOWNTOWN ? 2 : -2;
    const projects = ['a', 'b'].map(name => ({ id: `local:${name}`, ids: ['gh:owner/shared'], path: `C:/${name}` }));
    const f = writer(projects, { 'local:a': { i: -2, j: z }, 'local:b': { i: 2, j: z } });
    const slots = new SlotMap({ banks }), first = slots.assign(projects, { pins: f.store.cityLots });
    f.view.persistLots(first.fresh, first.pinRepairs); timers.flush();
    assert.deepEqual(f.store.cityLots['gh:owner/shared'], { i: -2, j: z });
    for (let n = 0; n < 4; n++) {
      const next = slots.assign(n % 2 ? projects : [...projects].reverse(), { pins: f.store.cityLots });
      assert.deepEqual(next.cells, first.cells); assert.deepEqual(next.pinRepairs, []);
      f.view.persistLots(next.fresh, next.pinRepairs); timers.flush();
    }
    assert.equal(f.writes.length, 1);
  }
});

test('a canonical alias owner retains its distant hidden reservation and determines the saved alias', () => {
  for (const larger of DISTRICTS) {
    const banks = districtBanks(larger), z = larger === DOWNTOWN ? 2 : -2;
    const hidden = { id: 'gh:owner/shared', path: '' };
    const clone = { id: 'local:clone', ids: [hidden.id], path: 'C:/clone' };
    const pins = { [hidden.id]: { i: 12, j: z }, [clone.id]: { i: 2, j: z } };
    const result = new SlotMap({ banks }).assign([clone], { pins, reserve: [hidden] });
    assert.equal(result.rings, 12, 'a shared memo alias cannot hide the reserved plot extent');
    assert.equal(result.reserved.get(`12,${z}`), hidden);
    assert.deepEqual(coordinates(result.cells.get(clone.id)), pins[clone.id]);
    assert.deepEqual(result.pinRepairs, []); assert.deepEqual(result.migrated, []);
  }
});

test('undefined repairs retain legacy fresh-pin saving and pending callbacks keep their original store', t => {
  const timers = callbacks(t), project = { id: 'local:legacy', ids: ['gh:owner/legacy'] };
  const f = writer([project], {}), destination = { i: 1, j: 1 };
  f.view.persistLots([{ id: project.id, ...destination }]);
  const other = writer([], {}); f.view.store = other.store;
  timers.flush();
  assert.deepEqual(f.store.cityLots, { [project.id]: destination, 'gh:owner/legacy': destination });
  assert.deepEqual(f.writes, [{ kind: 'batch' }]); assert.deepEqual(other.store.cityLots, {});
});
