import { riverLot } from '../app/city/river-lots.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SlotMap, cellKey } from '../app/city/layout.js';
import { DOWNTOWN, SUBURBS, DISTRICTS, chooseLargerDistrict, districtBanks, districtOf, districtForCell, districtCells, districtSlot } from '../app/city/districts.js';
import { riverCellUsable } from '../app/city/river-path.js';

const repo = n => ({ id: `gh:owner/repo-${n}`, path: '' });
const local = n => ({ id: `local:folder-${n}`, path: `C:/projects/folder-${n}` });
const inventory = (repos, folders) => [...Array.from({ length: repos }, (_, n) => repo(n)), ...Array.from({ length: folders }, (_, n) => local(n))];
const coords = ({ i, j }) => ({ i, j });
const pinsFor = result => Object.fromEntries([...result.cells].map(([id, cell]) => [id, coords(cell)]));
function assertLayout(result, projects) {
  const occupied = new Set([...result.cells.values()].map(c => cellKey(c.i, c.j)));
  assert.equal(occupied.size, result.cells.size);
  for (const project of projects) {
    const cell = result.cells.get(project.id);
    assert.equal(districtForCell(cell, result.banks), districtOf(project));
    assert.ok(riverCellUsable(cell.i, cell.j) || riverLot(cell.i, cell.j)?.eligible);
  }
  for (const district of DISTRICTS) {
    assert.ok(result.emptyPlots[district].length >= 3);
    for (const cell of result.emptyPlots[district]) {
      assert.equal(districtForCell(cell, result.banks), district);
      assert.ok(!occupied.has(cellKey(cell.i, cell.j)));
      assert.ok(!result.reserved.has(cellKey(cell.i, cell.j)));
    }
  }
}

test('the initial majority chooses the larger bank, including ghosts, with Downtown winning ties', () => {
  for (const [repos, folders, expected] of [[6, 2, DOWNTOWN], [2, 6, SUBURBS], [2, 2, DOWNTOWN], [0, 0, DOWNTOWN]]) {
    const projects = inventory(repos, folders), before = structuredClone(projects);
    assert.equal(chooseLargerDistrict(projects), expected);
    assert.equal(chooseLargerDistrict([...projects].reverse()), expected);
    assert.deepEqual(projects, before);
  }
  const linked = { ...local('linked'), ids: ['local:folder-linked', 'gh:owner/linked'] };
  assert.equal(chooseLargerDistrict([linked, repo('ghost'), local('home')]), DOWNTOWN);
  assert.equal(chooseLargerDistrict([null, {}, local('home')]), SUBURBS);
});

test('a valid saved choice wins over changed counts; invalid saved values do not choose a bank', () => {
  assert.equal(chooseLargerDistrict(inventory(0, 40), DOWNTOWN), DOWNTOWN);
  assert.equal(chooseLargerDistrict(inventory(40, 0), SUBURBS), SUBURBS);
  for (const invalid of [undefined, null, '', 'constructor', '__proto__', { positiveZ: DOWNTOWN }]) {
    assert.equal(chooseLargerDistrict(inventory(6, 2), invalid), DOWNTOWN);
    assert.equal(chooseLargerDistrict(inventory(2, 6), invalid), SUBURBS);
  }
});

test('bank configurations are immutable and their plot caches remain independent when interleaved', () => {
  const downtown = districtBanks(DOWNTOWN), suburbs = districtBanks(SUBURBS);
  assert.ok(Object.isFrozen(downtown)); assert.ok(Object.isFrozen(suburbs));
  assert.equal(downtown.positiveZ, DOWNTOWN); assert.equal(downtown.negativeZ, SUBURBS);
  assert.equal(suburbs.positiveZ, SUBURBS); assert.equal(suburbs.negativeZ, DOWNTOWN);
  assert.throws(() => { downtown.positiveZ = SUBURBS; }, TypeError);
  assert.deepEqual(districtBanks(), suburbs, 'unconfigured independent callers retain their established orientation');
  for (const ring of [2, 7, 3, 5, 2]) {
    const d = districtCells(ring, DOWNTOWN, downtown), s = districtCells(ring, SUBURBS, suburbs);
    assert.deepEqual(d, s, 'semantic district changes do not change physical plot order');
    assert.ok(d.length > districtCells(ring, SUBURBS, downtown).length, 'positive-z bank has more plots');
    for (let n = 0; n < d.length; n++) assert.deepEqual(districtSlot(n, DOWNTOWN, downtown), d[n]);
    d[0].i = 500;
    assert.notEqual(districtCells(ring, DOWNTOWN, downtown)[0].i, 500);
    assert.equal(districtForCell({ i: 2, j: 1 }, downtown), DOWNTOWN);
    assert.equal(districtForCell({ i: 2, j: 1 }, suburbs), SUBURBS);
    assert.equal(districtForCell({ i: 2, j: -2 }, downtown), SUBURBS);
    assert.equal(districtForCell({ i: 2, j: -2 }, suburbs), DOWNTOWN);
  }
});

test('six-to-two, two-to-six and tied inventories start at the smallest ring with three spare plots', () => {
  for (const [repos, folders, expectedRing, expectedFree] of [[6, 2, 2, [8, 3]], [2, 6, 2, [3, 8]], [2, 2, 2, [12, 3]], [4, 4, 3, [23, 12]]]) {
    const projects = inventory(repos, folders), banks = districtBanks(chooseLargerDistrict(projects));
    const result = new SlotMap({ banks }).assign(projects);
    assert.equal(result.banks, banks); assert.equal(result.rings, expectedRing);
    assert.deepEqual(DISTRICTS.map(d => result.emptyPlots[d].length), expectedFree);
    assert.ok(DISTRICTS.some(d => districtCells(result.rings - 1, d, banks).length - projects.filter(p => districtOf(p) === d).length < 3));
    assertLayout(result, projects);
  }
});

test('a layout retains its chosen banks and every placed pin as the project majority changes and after reload', () => {
  for (const initialChoice of DISTRICTS) {
    const projects = initialChoice === DOWNTOWN ? inventory(6, 2) : inventory(2, 6);
    const banks = districtBanks(chooseLargerDistrict(projects)), slots = new SlotMap({ banks });
    const initial = slots.assign(projects), pins = pinsFor(initial), before = structuredClone(pins);
    assert.throws(() => { slots.banks = districtBanks(banks.negativeZ); }, TypeError);
    const added = Array.from({ length: 80 }, (_, n) => initialChoice === DOWNTOWN ? local(`new-${n}`) : repo(`new-${n}`));
    let result = initial;
    for (const project of added) {
      projects.push(project); result = slots.assign(projects, { pins });
      assert.equal(result.banks, banks); assert.deepEqual(result.migrated, []);
      for (const [id, cell] of initial.cells) assert.deepEqual(result.cells.get(id), cell);
      assertLayout(result, projects);
    }
    assert.notEqual(chooseLargerDistrict(projects), initialChoice, 'the majority changed during growth');
    const savedChoice = JSON.parse(JSON.stringify(initialChoice));
    const restoredBanks = districtBanks(chooseLargerDistrict(projects, savedChoice));
    const reopened = new SlotMap({ banks: restoredBanks }).assign(projects, { pins: pinsFor(result) });
    assert.deepEqual(reopened.cells, result.cells); assert.deepEqual(reopened.migrated, []);
    assert.equal(reopened.banks, banks); assert.deepEqual(pins, before);
    const reduced = slots.assign(projects.slice(0, 1), { pins });
    assert.equal(reduced.rings, result.rings); assert.equal(reduced.banks, banks);
  }
});

test('first-load migration preserves correct-bank pins and hidden reservations, then persists once', () => {
  const projects = [repo('keep'), local('keep'), repo('move'), local('move')];
  const hidden = repo('hidden'), banks = districtBanks(DOWNTOWN);
  const pins = {
    [projects[0].id]: { i: 2, j: 1 }, [projects[1].id]: { i: 2, j: -2 },
    [projects[2].id]: { i: -2, j: -2 }, [projects[3].id]: { i: -2, j: 1 },
    [hidden.id]: { i: 0, j: 2 },
  };
  const slots = new SlotMap({ banks }), first = slots.assign(projects, { pins, reserve: [hidden] });
  for (const project of projects.slice(0, 2)) assert.deepEqual(coords(first.cells.get(project.id)), pins[project.id]);
  assert.deepEqual(new Set(first.migrated.map(p => p.id)), new Set(projects.slice(2).map(p => p.id)));
  assert.equal(first.reserved.get('0,2'), hidden);
  assert.deepEqual(slots.assign(projects, { pins, reserve: [hidden] }).cells, first.cells, 'pending persistence cannot cause another move');
  Object.assign(pins, Object.fromEntries(first.fresh.map(({ id, i, j }) => [id, { i, j }])));
  const reopened = new SlotMap({ banks }).assign(projects, { pins, reserve: [hidden] });
  assert.deepEqual(reopened.cells, first.cells); assert.deepEqual(reopened.fresh, []); assert.deepEqual(reopened.migrated, []);
  assertLayout(reopened, projects);
});

test('contributor assignment ignores home-bank configuration and preserves its existing compact pins', () => {
  const project = repo('contributor'), pin = { i: 0, j: 1 };
  for (const largerDistrict of DISTRICTS) {
    const result = new SlotMap({ banks: districtBanks(largerDistrict) }).assign([project], { districts: false, pins: { [project.id]: pin } });
    assert.deepEqual(coords(result.cells.get(project.id)), pin);
    assert.equal(result.rings, 1); assert.equal(result.emptyPlots, undefined);
  }
});
