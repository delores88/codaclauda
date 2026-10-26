import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { createBoat, addBoatNameLabel, sizeBoatNameLabel, BOAT_TYPES } from '../app/city/boat-models.js';
import { River } from '../app/city/river.js';
import { disposeAll } from '../app/city/fx.js';
import { WATER_Y, riverSection } from '../app/city/river-path.js';
import { RIVER_DECK_Y, riverLoopPose } from '../app/city/river-loop.js';

function canvasStub() {
  const context = new Proxy({ measureText: text => ({ width: text.length * 14 }) }, { get: (obj, name) => obj[name] || (() => {}) });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
}
function fixture() {
  canvasStub();
  const world = { land: new THREE.Group(), camera: new THREE.PerspectiveCamera(40, 16 / 9, .1, 3000), size: { w: 1600, h: 900 }, half: 77.5, quality: 'high', reducedMotion: () => false };
  const river = new River(world, { random: () => 0 });
  river.setProjects([{ id: 'project-one', name: 'A readable project', stats: { git: { commits_7d: 2 } } }]);
  return { world, river };
}
const close = (actual, expected, epsilon = 1e-5) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);

test('boat names retain 12px text at different distances, fields of view, viewports and island faces', () => {
  canvasStub();
  for (const type of BOAT_TYPES) {
    const boat = createBoat({ type, projectId: 'project-one', label: 'A readable project' }), label = addBoatNameLabel(boat);
    assert.equal(label.parent, boat.motion.model);
    boat.updateMatrixWorld(true);
    const probes = [];
    boat.motion.model.traverse(node => {
      if (!node.isMesh || node.userData.outline || node.material.transparent) return;
      const probe = new THREE.Mesh(node.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
      probe.applyMatrix4(node.matrixWorld); probes.push(probe);
    });
    probes.forEach(probe => probe.updateMatrixWorld(true));
    const hit = new THREE.Raycaster(new THREE.Vector3(label.position.x, 3, label.position.z), new THREE.Vector3(0, -1, 0)).intersectObjects(probes)[0];
    assert.ok(hit); close(label.position.y - hit.point.y, .014);
    probes.forEach(probe => probe.material.dispose());
    for (const height of [390, 900, 1800]) for (const fov of [35, 70]) for (const distance of [10, 150, 1200]) for (const underside of [false, true]) {
      const camera = new THREE.PerspectiveCamera(fov, 1.4, .1, 4000);
      boat.rotation.x = underside ? Math.PI : 0; boat.position.y = underside ? RIVER_DECK_Y - WATER_Y : WATER_Y;
      boat.updateMatrixWorld(true);
      const anchor = label.getWorldPosition(new THREE.Vector3()); camera.position.copy(anchor).add(new THREE.Vector3(0, 0, distance)); camera.lookAt(anchor); camera.updateMatrixWorld(true);
      sizeBoatNameLabel(boat, camera, height); boat.updateMatrixWorld(true);
      // Sprite's non-attenuated shader multiplies its scale by camera depth.
      const pixelHeight = label.scale.y * camera.projectionMatrix.elements[5] * height / 2;
      close(pixelHeight, label.userData.pixelHeight); close(label.userData.fontPixels, 12);
      const ndc = anchor.clone().project(camera); ndc.y += label.userData.pixelHeight / height;
      const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera);
      assert.equal(ray.intersectObject(label, false)[0]?.object, label, `${type} label remains pickable`);
    }
    disposeAll(boat);
  }
});

test('screen labels carry the current stable focus ID, respect bank occlusion and release private resources', () => {
  const { river, world } = fixture(); river.update(0, 0, { reducedMotion: true }); river.group.updateMatrixWorld(true);
  const labels = river.labelPickables().filter(label => label.userData.boatNameLabel);
  assert.equal(labels.length, 4);
  for (const label of labels) assert.equal(river.getBoat(label.userData.boatId).nameLabel, label);
  for (const label of [labels[0], labels[2]]) {
    const anchor = label.getWorldPosition(new THREE.Vector3());
    world.camera.position.set(anchor.x, anchor.y, riverSection(anchor.x).bankMinZ - 4);
    world.camera.lookAt(anchor); world.camera.updateMatrixWorld(true);
    const ndc = anchor.clone().project(world.camera); ndc.y += label.userData.pixelHeight / world.size.h;
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, world.camera);
    assert.equal(ray.intersectObject(label, false)[0]?.object, label);
    assert.equal(ray.intersectObjects([label, ...river.occluders()], false)[0]?.object.userData.occluder, true, 'nearer bank blocks the sprite on either island face');
  }
  const original = labels[0], resources = [original.geometry, original.material, original.material.map], released = new Set();
  resources.forEach(resource => resource.addEventListener('dispose', () => released.add(resource)));
  river.setQuality('low'); assert.equal(released.size, 3);
  const replacement = river.getBoat(original.userData.boatId).nameLabel;
  assert.ok(replacement !== original && river.labelPickables().includes(replacement));
  assert.equal(replacement.material.depthTest, true); assert.equal(replacement.material.depthWrite, false);
  river.group.visible = false; assert.deepEqual(river.labelPickables(), []);
  river.dispose(); assert.equal(world.land.children.length, 0);
});

test('every name row clears the boat own solid geometry on both faces and from all four viewing sides', () => {
  canvasStub();
  const projects = Array.from({ length: 4 }, (_, n) => ({ projectId: `project-${n}`, label: `Project ${n}` }));
  for (const type of BOAT_TYPES) for (const low of [false, true]) for (const underside of [false, true]) {
    const boat = createBoat({ type, projects, crateCount: 4 }, { low }), label = addBoatNameLabel(boat);
    boat.rotation.x = underside ? Math.PI : 0; boat.updateMatrixWorld(true);
    const probes = [];
    boat.traverse(node => {
      if (!node.isMesh || node.material.transparent) return;
      const probe = new THREE.Mesh(node.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
      probe.applyMatrix4(node.matrixWorld); probe.updateMatrixWorld(true); probes.push(probe);
    });
    const camera = new THREE.PerspectiveCamera(40, 16 / 9, .1, 1000), anchor = label.getWorldPosition(new THREE.Vector3()), height = 900;
    camera.up.y = underside ? -1 : 1;
    sizeBoatNameLabel(boat, camera, height); boat.updateMatrixWorld(true);
    for (const azimuth of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      camera.position.copy(anchor).add(new THREE.Vector3(Math.sin(.62) * Math.sin(azimuth), Math.cos(.62) * camera.up.y, Math.sin(.62) * Math.cos(azimuth)).multiplyScalar(10));
      camera.lookAt(anchor); camera.updateMatrixWorld(true);
      const projected = anchor.clone().project(camera);
      for (let row = 0; row < boat.projectLabels.length; row++) for (const across of [-.3, 0, .3]) {
        const ndc = projected.clone(); ndc.x += across * label.userData.pixelWidth * 2 / (height * camera.aspect);
        ndc.y += (6 + 11 + row * 22) * 2 / height;
        const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera);
        assert.ok(ray.intersectObjects([label, ...probes], false)[0]?.object === label, `${type} row ${row} self-occlusion, low=${low}, underside=${underside}, azimuth=${azimuth}`);
      }
    }
    probes.forEach(probe => probe.material.dispose()); disposeAll(boat);
  }
});

test('waterfalls are translucent blue fading white, with four downward streaks and foam at all four joins', () => {
  const { river } = fixture(); river.update(1, 1, { night: 0 });
  const falls = river.waterMeshes.filter(mesh => mesh.userData.riverSection % 2);
  for (const fall of falls) {
    assert.equal(fall.material.transparent, true); close(fall.material.opacity, .7); assert.equal(fall.material.depthWrite, false);
    assert.equal(fall.material.emissive.getHexString(), '6db9db'); close(fall.material.emissiveIntensity, .35);
    const colors = fall.geometry.getAttribute('color'), uv = fall.geometry.getAttribute('uv');
    const blue = new THREE.Color('#bfe6f5'), white = new THREE.Color('#ffffff');
    for (let n = 0; n < uv.count; n++) {
      const expected = blue.clone().lerp(white, uv.getX(n) * .78);
      close(colors.getX(n), expected.r); close(colors.getY(n), expected.g); close(colors.getZ(n), expected.b);
    }
    const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <color_fragment>' };
    fall.material.onBeforeCompile(shader);
    assert.ok(shader.fragmentShader.includes('lane < 4')); assert.ok(shader.fragmentShader.includes('riverUv.x-riverTime*.18'));
  }
  assert.equal(river.foam.count, 96);
  const matrix = new THREE.Matrix4(), point = new THREE.Vector3();
  for (let n = 0; n < river.foam.count; n++) {
    river.foam.getMatrixAt(n, matrix); point.setFromMatrixPosition(matrix);
    const join = riverLoopPose(river.loop, river.loop.joins[1 + Math.floor(n / 24)] / river.loop.length);
    close(point.y, join.position.y + join.up.y * .035, 1e-4);
  }
  const before = falls[0].material.userData.waterUniforms.riverTime.value;
  river.update(100, 101, { reducedMotion: true }); close(falls[0].material.userData.waterUniforms.riverTime.value, before);
  assert.equal(river.foam.visible, false);
  river.setQuality('low'); assert.equal(river.foam, null);
  river.dispose();
});
