import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { NeighborIslands, neighborLayout, skylineBlocks } from '../app/city/neighbors.js';
import { flightWaypoints, flightSeconds } from '../app/city/airport.js';
import { NpcManager } from '../app/city/npc.js';
import { layoutIslands } from '../app/islands.js';

globalThis.window = {};
const context = new Proxy({ measureText: text => ({ width: text.length * 30 }) }, { get: (obj, prop) => obj[prop] || (() => {}) });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
const { store: singleton } = await import('../app/store.js');
const { defaultCloneDir, cloneDirFor, uncloned } = await import('../app/github-accounts.js');

const repo = (owner, name) => ({ name, full_name: `${owner}/${name}`, size_kb: 10 });
function accountsStore(layout = 'city') {
  const store = new singleton.constructor();
  store.desktop.projects.local = [{ path: 'C:/work/api', name: 'api', stats: { git: { remote: 'https://github.com/work-co/api.git' } } }];
  store.desktop.projects.github = { user: 'main-me', repos: [repo('main-me', 'site'), repo('work-co', 'shared')] };
  store.desktop.projects.githubAccounts = [{ user: 'work-co', repos: [repo('work-co', 'api'), repo('work-co', 'shared'), repo('work-co', 'billing')], fetchedAt: 1, source: 'gh' }];
  store.desktop.projects.accountLayout = layout;
  return store;
}

test('one layout choice decides where every other account appears; the main account is always the city', () => {
  const city = accountsStore('city');
  assert.equal(city.accountLayout, 'city');
  assert.ok(city.projects.every(p => !p.island), 'one big city: no project is on an island');
  assert.equal(city.visibleProjects('city').length, city.projects.length);

  const islands = accountsStore('islands');
  assert.equal(islands.accountLayout, 'islands');
  const onIsland = islands.islandProjects('owned:work-co').map(p => p.repo.name).sort();
  assert.deepEqual(onIsland, ['api', 'billing'], 'the extra account’s repos live on its island');
  assert.ok(islands.visibleProjects('city').every(p => !p.island), 'home never draws island projects');
  // The first account listing a repo owns it: work-co/shared is listed by the main account first.
  assert.equal(islands.projects.find(p => p.repo?.name === 'shared').island, null);
  assert.equal(islands.projects.find(p => p.repo?.name === 'api').path, 'C:/work/api', 'a clone stays linked to its folder on the island');
  assert.equal(islands.githubAccounts[0].main, true);
  assert.ok(islands.githubAccounts.every(a => !('mode' in a)), 'no per-account mode');
});

test('clone helpers suggest Desktop\\GitHub\\<account>, honour a chosen folder and list only repos not on this PC', () => {
  const store = accountsStore('islands');
  store.paths = { desktop_dir: 'C:\\Users\\me\\Desktop' };
  assert.equal(defaultCloneDir(store, 'work-co'), 'C:\\Users\\me\\Desktop\\GitHub\\work-co');
  assert.equal(cloneDirFor(store, 'work-co'), 'C:\\Users\\me\\Desktop\\GitHub\\work-co');
  store.desktop.prefs['cloneFolder:work-co'] = 'D:\\Code';
  assert.equal(cloneDirFor(store, 'Work-Co'), 'D:\\Code');
  assert.deepEqual(uncloned(store, 'work-co').map(r => r.name).sort(), ['billing', 'shared'], 'api is already cloned');
  assert.deepEqual(uncloned(store, 'nobody'), []);
});

test('account islands sit beside home on the same level, alternating sides, with open air between', () => {
  const spots = neighborLayout([{ id: 'owned:a', count: 4 }, { id: 'owned:b', count: 30 }, { id: 'owned:c', count: 1 }], 60);
  assert.deepEqual(spots.map(s => s.side), [1, -1, 1]);
  for (const s of spots) assert.ok(Math.abs(s.x) - s.half >= 60 + 25, `${s.id} leaves room for the airfield and air`);
  assert.ok(spots[2].x - spots[2].half > spots[0].x + spots[0].half, 'a third island goes further out, not on top');
  assert.ok(spots.every(s => s.z === 0));
  // Contributor islands stay below, owned islands share the home row on the route map.
  const { home, spots: mapSpots } = layoutIslands([{ id: 'contrib', owner: 'x', repos: [] }], { owned: [{ id: 'owned:a', owner: 'a', repos: [] }] });
  assert.equal(mapSpots.get('owned:a').y, home.y, 'your account island is level with home');
  assert.ok(mapSpots.get('contrib').y > home.y + home.r, 'a contributor island is below');
});

test('island skylines keep clear of the airstrip; agents get a spot beside their project and know the island', t => {
  const spot = { id: 'owned:a', x: 100, z: 0, half: 16, side: 1 };
  const blocks = skylineBlocks(spot, Array.from({ length: 9 }, (_, k) => ({ id: `gh:a/p${k}`, path: k % 2 ? 'C:/p' : '' })));
  assert.ok(blocks.every(b => b.z + b.w / 2 < spot.z + spot.half - 5), 'blocks end north of the strip');
  const parent = new THREE.Group(), neighbors = new NeighborIslands(parent);
  t.after(() => neighbors.dispose());
  neighbors.sync([{ id: 'owned:a', owner: 'a', projects: [{ id: 'gh:a/p0', path: '' }, { id: 'gh:a/p1', path: 'C:/p1', metrics: { floors: 3 } }] }], 60);
  const at = neighbors.spotFor('gh:a/p1', 0);
  assert.equal(at.island, 'owned:a');
  assert.equal(neighbors.islandAt(at.x, at.z), 'owned:a');
  assert.equal(neighbors.islandAt(0, 0), null, 'home is not a neighbour');
  const strip = neighbors.airportFor('owned:a');
  assert.ok(strip && strip.land.start && strip.apron);
  assert.ok(Math.abs(strip.land.start.x - 60) < Math.abs(strip.land.end.x - 60), 'arrivals land heading away from home');
  assert.equal(neighbors.sync([{ id: 'owned:a', owner: 'a', projects: [{ id: 'gh:a/p0', path: '' }, { id: 'gh:a/p1', path: 'C:/p1', metrics: { floors: 3 } }] }], 60), false, 'unchanged islands are not rebuilt');
});

test('a flight taxis from one apron, climbs over the gap and lands on the other strip, ending at its apron', () => {
  const home = { land: { start: { x: 70, z: 18 }, end: { x: 70, z: -4 } }, depart: { start: { x: 70, z: 18 }, end: { x: 70, z: -4 } }, apron: { x: 64, z: 9 } };
  const away = { land: { start: { x: 95, z: 14 }, end: { x: 117, z: 14 } }, depart: { start: { x: 117, z: 14 }, end: { x: 95, z: 14 } }, apron: { x: 115, z: 12 } };
  const points = flightWaypoints(home, away, 0.06);
  assert.deepEqual([points[0].x, points[0].z], [64, 9]);
  assert.deepEqual([points.at(-1).x, points.at(-1).z], [115, 12]);
  assert.ok(Math.max(...points.map(p => p.y)) >= 8, 'cruises well above the islands');
  assert.ok(points.every(p => p.y >= 0.06 - 1e-9));
  assert.ok(flightSeconds(10) >= 4 && flightSeconds(1e4) <= 11);
});

test('an agent whose project is on an account island walks to the airfield, flies, lands and walks to work', t => {
  const parent = new THREE.Group(), neighbors = new NeighborIslands(parent);
  neighbors.sync([{ id: 'owned:a', owner: 'a', projects: [{ id: 'gh:a/api', path: 'C:/api' }] }], 61.5);
  const homeStrip = { land: { start: { x: 69, z: 18 }, end: { x: 69, z: -4 } }, depart: { start: { x: 69, z: 18 }, end: { x: 69, z: -4 } }, apron: { x: 64, z: 9 }, gate: { x: 58, z: 9 } };
  const people = new NpcManager(parent, { buildings: new Map(), reducedMotion: () => false, neighbors });
  people.airports = id => (id ? neighbors.airportFor(id) : homeStrip);
  people.setCreate(() => ({ object: new THREE.Group(), pickable: [], setSpec() {}, setStatus() {}, setAction() {}, lookAt() {}, update() {}, dispose() {} }));
  t.after(() => { people.dispose(); neighbors.dispose(); });
  people.sync([{ id: 'codex-1', status: 'active', provider: 'codex', cityProjectId: 'gh:a/api', look: {} }]);
  const npc = people.npcs.get('codex-1');
  // First placement drops straight at the goal; a later move makes the trip.
  assert.equal(npc.goal.island, 'owned:a');
  npc.place(40, 9); npc.goalKey = '';
  npc.goal = { ...npc.goal, offsite: false, island: null };   // pretend it was at home
  people.assignGoals();
  assert.deepEqual(npc.trip.legs.map(l => l.kind), ['walk', 'fly', 'walk']);
  let sawPlane = false, maxY = 0;
  for (let k = 0; k < 60 * 60 && npc.trip; k++) {
    people.update(1 / 60, k / 60, { reducedMotion: false });
    if (npc.trip?.legs[0]?.plane) { sawPlane = true; assert.equal(npc.person.object.visible, false, 'the agent rides inside'); maxY = Math.max(maxY, npc.pos.y); }
  }
  assert.ok(sawPlane && maxY > 6, 'it flew, high over the gap');
  assert.equal(npc.trip, null);
  assert.equal(npc.person.object.visible, true);
  const goal = neighbors.spotFor('gh:a/api', 0);
  assert.ok(Math.hypot(npc.pos.x - goal.x, npc.pos.z - goal.z) < 1e-6, 'ends beside its project');
  assert.equal(people.planes().length, 0, 'no plane left behind');
});
