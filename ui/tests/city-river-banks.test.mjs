import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { River } from '../app/city/river.js';
import { districtBanks, DOWNTOWN, SUBURBS } from '../app/city/districts.js';
import { riverZ, riverSection } from '../app/city/river-path.js';
import { RIVER_DECK_Y } from '../app/city/river-loop.js';

function fixture(quality = 'high') {
  const context = new Proxy({ measureText: text => ({ width: text.length * 18 }) }, { get: (obj, name) => obj[name] || (() => {}) });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  const river = new River({ land: new THREE.Group(), half: 61.5, quality, reducedMotion: () => false }, { random: () => 0 });
  river.setProjects([{ id: 'project-one', name: 'Project One', stats: { git: { commits_7d: 1 } } }]);
  return river;
}
const near = (actual, expected, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('quay, grass, rail, lamp reflections and docks follow either saved bank on both island faces', () => {
  for (const larger of [DOWNTOWN, SUBURBS]) for (const quality of ['high', 'low']) {
    const river = fixture(quality), banks = districtBanks(larger), urbanSide = larger === DOWNTOWN ? 1 : -1;
    river.setBounds({ half: river.half, banks }); river.group.updateMatrixWorld(true);
    const top = river.landscape.getObjectByName('river-top-banks-bridges-docks'), underside = river.landscape.getObjectByName('river-underside-banks-bridges-docks');
    for (const [face, flipped] of [[top, false], [underside, true]]) {
      for (const [name, side, color] of [['downtown-stone-quay', urbanSide, 'c9c2b0'], ['suburbs-grassy-bank', -urbanSide, '7cc56a']]) {
        const mesh = face.getObjectByName(name), positions = mesh.geometry.getAttribute('position');
        assert.equal(mesh.material.color.getHexString(), color);
        for (let n = 0; n < positions.count; n++) assert.ok((positions.getZ(n) - riverZ(positions.getX(n))) * side > 4, `${name} remains on its configured physical bank`);
        const x = positions.getX(Math.floor(positions.count / 2)), section = riverSection(x), inner = side < 0 ? section.waterMinZ : section.waterMaxZ, outer = side < 0 ? section.bankMinZ : section.bankMaxZ;
        const urban = name.startsWith('downtown'), fraction = urban ? .14 : .7, z = inner + (outer - inner) * fraction;
        const ray = new THREE.Raycaster(new THREE.Vector3(x, flipped ? -20 : 20, z), new THREE.Vector3(0, flipped ? 1 : -1, 0));
        const hit = ray.intersectObject(mesh, false)[0]; assert.ok(hit, `${name} has a physical surface on ${flipped ? 'underside' : 'top'}`);
        const surface = urban ? .35 : -.58 * (1 - fraction) / .65;
        near(hit.point.y, flipped ? RIVER_DECK_Y - surface : surface, .001);
      }
      for (const [name, side, color] of [['downtown-stone-dock', urbanSide, 'c9c2b0'], ['suburbs-wood-dock', -urbanSide, 'b77a45']]) {
        const dock = face.getObjectByName(name), position = dock.getWorldPosition(new THREE.Vector3());
        assert.ok((position.z - riverZ(position.x)) * side > 5, `${name} follows the matching bank on both faces`);
        assert.equal(dock.getObjectByName('dock-planks').material.color.getHexString(), color);
        near(position.y, flipped ? RIVER_DECK_Y + .54 : -.54);
      }
      for (const [name, side] of [['quay-railing', urbanSide], ['quay-lamps', urbanSide], ['quay-light-streaks', urbanSide], ['bank-rocks', -urbanSide], ['bank-reeds', -urbanSide]]) {
        const mesh = face.getObjectByName(name); if (quality === 'low' && name === 'bank-reeds') { assert.equal(mesh, undefined); continue; }
        assert.ok(mesh, name);
        const positions = mesh.geometry.getAttribute('position');
        for (let n = 0; n < positions.count; n++) assert.ok((positions.getZ(n) - riverZ(positions.getX(n))) * side > 3.5, `${name} moves with its district`);
      }
    }
    assert.equal(river.occluders().length, 4); river.dispose();
  }
});

test('bank changes preserve bridge geometry, physical mooring slots, boat IDs and manifests, and dispose the old landscape', () => {
  const river = fixture(); river.update(0, 0, { reducedMotion: true });
  const snapshot = () => river.boats.map(boat => ({ id: boat.userData.boatId, position: boat.position.toArray(), quaternion: boat.quaternion.toArray(), projects: boat.userData.projectIds }));
  const before = snapshot(), entries = structuredClone(river.fleet), positions = river.bridges.map(mesh => Array.from(mesh.geometry.getAttribute('position').array));
  const resources = new Set(), released = new Set();
  river.landscape.traverse(node => { if (node.geometry && !node.geometry.userData.shared) resources.add(node.geometry); if (node.material && !node.material.userData.shared) resources.add(node.material); });
  resources.forEach(resource => resource.addEventListener('dispose', () => released.add(resource)));
  river.setBounds({ half: river.half, banks: districtBanks(DOWNTOWN) });
  assert.equal(released.size, resources.size); assert.deepEqual(snapshot(), before); assert.deepEqual(river.fleet, entries);
  assert.deepEqual(river.bridges.map(mesh => Array.from(mesh.geometry.getAttribute('position').array)), positions);
  const landscape = river.landscape; river.setBounds({ half: river.half, banks: districtBanks(DOWNTOWN) }); assert.equal(river.landscape, landscape);
  river.setQuality('low'); assert.equal(river.banks, districtBanks(DOWNTOWN)); assert.deepEqual(snapshot(), before); assert.deepEqual(river.fleet, entries);
  river.setBounds({ half: 77.5 }); assert.equal(river.banks, districtBanks(DOWNTOWN));
  assert.deepEqual(river.boats.map(boat => boat.userData.boatId), before.map(boat => boat.id));
  river.group.traverse(node => assert.equal(Boolean(node.castShadow), false));
  river.dispose();
});
