import test from 'node:test';
import assert from 'node:assert/strict';
import { SlotMap, cellKey, pinOf, slotCell } from '../app/city/layout.js';
import { DOWNTOWN, SUBURBS, DISTRICTS, districtOf, districtForCell, districtCells, isUnbuilt } from '../app/city/districts.js';
import { riverCellUsable } from '../app/city/river-path.js';

const local = (name, extra = {}) => ({ id: `local:${name}`, path: `C:/projects/${name}`, ...extra });
const repo = (name, extra = {}) => ({ id: `gh:owner/${name}`, path: '', ...extra });
const both = name => local(name, { ids: [`local:${name}`, `gh:owner/${name}`] });
const coordinates = c => ({ i: c.i, j: c.j });
const savedPins = result => Object.fromEntries(result.fresh.map(({ id, i, j }) => [id, { i, j }]));
function checkFree(result) {
  const occupied = new Set([...result.cells.values()].map(c => cellKey(c.i, c.j)));
  for (const district of DISTRICTS) {
    assert.ok(result.emptyPlots[district].length >= 3, `${district} has at least three free plots`);
    for (const c of result.emptyPlots[district]) {
      assert.equal(districtForCell(c), district);
      assert.ok(riverCellUsable(c.i, c.j));
      assert.ok(!occupied.has(cellKey(c.i, c.j)));
      assert.ok(!result.reserved.has(cellKey(c.i, c.j)));
    }
  }
}

test('districts distinguish local-only, linked GitHub, and unbuilt GitHub projects', () => {
  assert.equal(SUBURBS, 'suburbs');
  assert.deepEqual(DISTRICTS, [DOWNTOWN, SUBURBS]);
  assert.equal(districtOf(local('garden')), 'suburbs');
  assert.equal(districtOf(both('tower')), 'downtown');
  assert.equal(districtOf(repo('outline')), 'downtown');
  assert.equal(districtOf(repo('canonical', { ids: ['local:alias'] })), 'downtown');
  assert.equal(isUnbuilt(repo('outline')), true);
  assert.equal(isUnbuilt(repo('spaces', { path: '   ' })), true);
  assert.equal(isUnbuilt(both('tower')), false);
  assert.equal(isUnbuilt(local('garden')), false);
  assert.equal(districtForCell({ i: 0, j: 0 }), null);
  assert.equal(districtForCell({ i: 1, j: 1 }), 'suburbs');
  assert.equal(districtForCell({ i: 2, j: -2 }), 'downtown');
  assert.equal(districtForCell({ i: 1, j: -1 }), null);
  assert.equal(districtForCell({ i: 1, j: 0 }), null);
});

test('the empty city has at least three safe free plots in each river district', () => {
  const result = new SlotMap().assign([]);
  assert.equal(result.rings, 3);
  checkFree(result);
  assert.equal(result.emptyPlots.downtown.length, 6);
  assert.equal(result.emptyPlots.suburbs.length, 25);
});

test('the Suburbs name preserves existing coordinate pins through reload and expansion', () => {
  // Saved desktop lots contain project IDs and coordinates, with no district names.
  const projects = [local('saved-home'), local('saved-home-alias', { ids: ['local:older-home-name'] }), both('saved-tower')];
  const pins = JSON.parse('{"local:saved-home":{"i":0,"j":1},"local:older-home-name":{"i":-2,"j":1},"local:saved-tower":{"i":2,"j":-2}}');
  const originalPins = structuredClone(pins), slots = new SlotMap();
  for (const project of projects) slots.memo.set(project.id, pinOf(project, pins));
  const current = slots.assign(projects, { pins });
  const reopened = new SlotMap().assign(projects, { pins });
  for (const result of [current, reopened]) {
    assert.deepEqual(result.fresh, []);
    assert.deepEqual(result.migrated, []);
    for (const project of projects) assert.deepEqual(coordinates(result.cells.get(project.id)), pinOf(project, pins));
    assert.equal(result.districts.get(projects[0].id), SUBURBS);
    assert.equal(result.districts.get(projects[1].id), SUBURBS);
    assert.equal(result.districts.get(projects[2].id), DOWNTOWN);
    checkFree(result);
  }
  const expanded = slots.assign([...projects, ...Array.from({ length: 24 }, (_, n) => local(`new-home-${n}`))], { pins });
  assert.deepEqual(expanded.migrated, []);
  for (const project of projects) assert.deepEqual(expanded.cells.get(project.id), current.cells.get(project.id));
  assert.deepEqual(pins, originalPins);
  checkFree(expanded);
});

test('growth leaves every standing and pinned project in place and keeps spare plots', () => {
  const slots = new SlotMap(), projects = [both('pinned-tower'), local('pinned-house')];
  const pins = { [projects[0].id]: { i: 2, j: -2 }, [projects[1].id]: { i: 1, j: 1 } };
  let result = slots.assign(projects, { pins });
  const standing = new Map(result.cells);
  checkFree(result);
  for (let n = 0; n < 80; n++) {
    projects.push(n % 2 ? both(`tower-${n}`) : local(`house-${n}`));
    result = slots.assign(projects, { pins });
    for (const [id, cell] of standing) assert.deepEqual(result.cells.get(id), cell, `${id} stays put`);
    for (const [id, cell] of result.cells) {
      standing.set(id, cell);
      assert.equal(districtForCell(cell), districtOf(projects.find(p => p.id === id)));
    }
    checkFree(result);
  }
  assert.ok(result.rings > 2);
  const size = result.rings;
  assert.equal(slots.assign(projects.slice(0, 2), { pins }).rings, size, 'removals do not shrink established blocks');
});

test('growth extends the perimeter along and away from the river without reordering old plots', () => {
  for (const district of DISTRICTS) {
    const small = districtCells(1, district), large = districtCells(2, district);
    assert.deepEqual(large.slice(0, small.length), small);
    assert.ok(large.some(c => Math.abs(c.i) === 2));
    assert.ok(large.some(c => c.j === (district === 'downtown' ? -2 : 2)));
  }
});

test('safe matching pins survive exactly; district changes migrate and persist once', () => {
  const projects = [both('keep-tower'), local('keep-house'), both('move-tower'), local('move-house')];
  const pins = {
    [projects[0].id]: { i: 2, j: -2 }, [projects[1].id]: { i: -2, j: 1 },
    [projects[2].id]: { i: 1, j: 1 }, [projects[3].id]: { i: 0, j: -4 },
  };
  const slots = new SlotMap(), first = slots.assign(projects, { pins });
  assert.deepEqual(coordinates(first.cells.get(projects[0].id)), pins[projects[0].id]);
  assert.deepEqual(coordinates(first.cells.get(projects[1].id)), pins[projects[1].id]);
  assert.deepEqual(new Set(first.migrated.map(p => p.id)), new Set(projects.slice(2).map(p => p.id)));
  for (const change of first.fresh) assert.equal(change.migrated, true);
  for (const p of projects) assert.equal(districtForCell(first.cells.get(p.id)), districtOf(p));
  // Even a sync before the async desktop save must not move the building a second time.
  assert.deepEqual(slots.assign(projects, { pins }).cells, first.cells);
  Object.assign(pins, savedPins(first));
  const next = slots.assign(projects, { pins });
  assert.deepEqual(next.cells, first.cells);
  assert.deepEqual(next.migrated, []);
  assert.deepEqual(next.fresh, []);
  assert.deepEqual(new SlotMap().assign(projects, { pins }).cells, first.cells, 'saved migration survives reopening');
});

test('linking a repository moves a local project once; cloning an outline keeps its plot', () => {
  const slots = new SlotMap(), project = local('changing');
  const first = slots.assign([project]), pins = savedPins(first);
  project.ids = [project.id, 'gh:owner/changing'];
  const linked = slots.assign([project], { pins });
  assert.equal(linked.migrated.length, 1);
  assert.equal(districtForCell(linked.cells.get(project.id)), 'downtown');
  Object.assign(pins, savedPins(linked));
  assert.deepEqual(slots.assign([project], { pins }).migrated, []);

  const outline = repo('soon-local'), beforeClone = slots.assign([project, outline], { pins });
  outline.path = 'C:/projects/soon-local';
  const cloned = slots.assign([project, outline], { pins });
  assert.deepEqual(cloned.cells.get(outline.id), beforeClone.cells.get(outline.id));
});

test('hidden reservations stay unavailable and conflicting district pins are corrected', () => {
  const hidden = [repo('hidden-one'), repo('hidden-two'), local('hidden-house')];
  const pins = { [hidden[0].id]: { i: 0, j: -4 }, [hidden[1].id]: { i: 1, j: -4 }, [hidden[2].id]: { i: 2, j: -2 } };
  const result = new SlotMap().assign([both('visible'), local('visible-house')], { pins, reserve: hidden });
  assert.equal(result.reserved.size, 3);
  assert.equal(result.cells.size, 2);
  assert.ok(result.fresh.find(f => f.id === hidden[2].id && f.migrated));
  for (const [cell, project] of result.reserved) {
    const [i, j] = cell.split(',').map(Number);
    assert.equal(districtForCell({ i, j }), districtOf(project));
  }
  checkFree(result);
});

test('aliases preserve saved plots, including a canonical ID missing from the alias array', () => {
  const project = local('alias', { ids: ['gh:owner/alias'] });
  const pin = { i: 3, j: -2 };
  assert.deepEqual(pinOf(project, { [project.id]: pin }), pin);
  assert.deepEqual(coordinates(new SlotMap().assign([project], { pins: { 'gh:owner/alias': pin } }).cells.get(project.id)), pin);
  const slots = new SlotMap();
  const first = slots.assign([project]);
  const renamed = { ...project, id: 'gh:owner/alias', ids: ['gh:owner/alias', project.id] };
  assert.deepEqual(slots.assign([renamed]).cells.get(renamed.id), first.cells.get(project.id));
});

test('plot-dialog hold postpones only genuinely new unpinned projects', () => {
  const slots = new SlotMap(), projects = [both('existing'), local('new')];
  const initial = slots.assign([projects[0]]);
  const held = slots.assign(projects, { hold: true });
  assert.deepEqual(held.cells.get(projects[0].id), initial.cells.get(projects[0].id));
  assert.equal(held.cells.has(projects[1].id), false);
  checkFree(held);
  const pin = { i: 1, j: 1 };
  const pinned = slots.assign(projects, { hold: true, pins: { [projects[1].id]: pin } });
  assert.deepEqual(coordinates(pinned.cells.get(projects[1].id)), pin);
});

test('contributor islands retain legacy pins and do not require spare district blocks', () => {
  const projects = [repo('contributor')], pin = { i: 0, j: 1 };
  const result = new SlotMap().assign(projects, { districts: false, pins: { [projects[0].id]: pin } });
  assert.deepEqual(coordinates(result.cells.get(projects[0].id)), pin);
  assert.equal(result.rings, 1);
  assert.equal(result.emptyPlots, undefined);
  const slots = new SlotMap();
  slots.legacy = { [projects[0].id]: 0 };
  assert.deepEqual(slots.assign(projects, { districts: false }).cells.get(projects[0].id), slotCell(0));
});

test('placement order is deterministic and duplicate pins resolve without overlapping buildings', () => {
  const projects = [both('a'), both('b'), local('c'), local('d')];
  const pins = { [projects[0].id]: { i: 2, j: -2 }, [projects[1].id]: { i: 2, j: -2 } };
  const forward = new SlotMap().assign(projects, { pins }), reverse = new SlotMap().assign([...projects].reverse(), { pins });
  assert.deepEqual(forward.cells, reverse.cells);
  assert.equal(new Set([...forward.cells.values()].map(c => cellKey(c.i, c.j))).size, projects.length);
  assert.equal(forward.migrated.length, 1);
  checkFree(forward);
});

test('river migration relocates intersecting footprints once and preserves every safe pin', () => {
  const projects = [both('river-tower'), local('river-house'), both('safe-tower'), local('safe-house')];
  const pins = { [projects[0].id]: { i: 0, j: -1 }, [projects[1].id]: { i: 1, j: 0 }, [projects[2].id]: { i: 2, j: -2 }, [projects[3].id]: { i: 0, j: 1 } };
  const slots = new SlotMap();
  // Existing standing cells can predate the river update, as can persisted pins.
  for (const project of projects) slots.memo.set(project.id, pins[project.id]);
  const first = slots.assign(projects, { pins });
  assert.deepEqual(new Set(first.migrated.map(m => m.id)), new Set(projects.slice(0, 2).map(p => p.id)));
  for (const project of projects.slice(2)) assert.deepEqual(coordinates(first.cells.get(project.id)), pins[project.id]);
  for (const cell of first.cells.values()) assert.ok(riverCellUsable(cell.i, cell.j));
  Object.assign(pins, savedPins(first));
  const expanded = [...projects, ...Array.from({ length: 220 }, (_, n) => n % 2 ? local(`river-expansion-${n}`) : both(`river-expansion-${n}`))];
  const next = slots.assign(expanded, { pins });
  assert.deepEqual(next.migrated, []);
  for (const [id, cell] of first.cells) assert.deepEqual(next.cells.get(id), cell);
  for (const cell of next.cells.values()) assert.ok(riverCellUsable(cell.i, cell.j));
  checkFree(next);
  Object.assign(pins, savedPins(next));
  const reopened = new SlotMap().assign(expanded, { pins });
  assert.deepEqual(reopened.cells, next.cells);
  assert.deepEqual(reopened.migrated, []);
});

test('an initially empty district ring does not prevent deterministic assignment', () => {
  assert.equal(districtCells(1, 'downtown').length, 0);
  const projects = Array.from({ length: 60 }, (_, n) => both(`first-ring-${n}`));
  const result = new SlotMap().assign(projects);
  assert.equal(result.cells.size, projects.length);
  assert.equal(new Set([...result.cells.values()].map(c => cellKey(c.i, c.j))).size, projects.length);
  for (const cell of result.cells.values()) assert.equal(districtForCell(cell), 'downtown');
  checkFree(result);
});

test('the diagonal river migrates dry district-mismatched pins once and preserves correct-side pins', () => {
  const projects = [both('diagonal-tower'), local('diagonal-home'), both('fixed-tower'), local('fixed-home')];
  const pins = { [projects[0].id]: { i: -1, j: -1 }, [projects[1].id]: { i: 8, j: 1 }, [projects[2].id]: { i: 2, j: -2 }, [projects[3].id]: { i: 0, j: 1 } };
  for (const pin of Object.values(pins)) assert.ok(riverCellUsable(pin.i, pin.j), 'this migration is caused by district membership, not water');
  const first = new SlotMap().assign(projects, { pins });
  assert.deepEqual(new Set(first.migrated.map(change => change.id)), new Set(projects.slice(0, 2).map(p => p.id)));
  for (const project of projects.slice(2)) assert.deepEqual(coordinates(first.cells.get(project.id)), pins[project.id]);
  Object.assign(pins, savedPins(first));
  const reopened = new SlotMap().assign(projects, { pins });
  assert.deepEqual(reopened.cells, first.cells); assert.deepEqual(reopened.migrated, []);
  checkFree(reopened);
});
