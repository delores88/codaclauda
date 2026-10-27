import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { talkSignOverlap, talkTextBounds, betterTalkComposition } from '../app/city/talk-signs.js';
test('conversation composition penalizes signs behind heads while obstruction remains a separate check', () => {
  const shot = { eye: new THREE.Vector3(0, 1, 8), look: new THREE.Vector3(0, 1, 0) };
  const head = new THREE.Vector3(0, 1, 0);
  const sign = (x, z) => new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(x, 1, z), new THREE.Vector3(2, .8, .1));
  assert.ok(talkSignOverlap(shot, [head], [sign(0, -2)]) > 0);
  assert.equal(talkSignOverlap(shot, [head], [sign(5, -2)]), 0);
  assert.equal(talkSignOverlap(shot, [head], [sign(0, 2)]), 0, 'foreground sign is handled by obstruction rays');
  assert.equal(talkSignOverlap(shot, [head], [sign(0, 10)]), 0, 'behind-camera signs do not influence staging');
});

test('a sign above either face still penalizes the reserved speech bubble and tail zone', () => {
  const shot = { eye: new THREE.Vector3(0, 1, 8), look: new THREE.Vector3(0, 1, 0) };
  const heads = [new THREE.Vector3(-1.2, 1, 0), new THREE.Vector3(1.2, 1, 0)];
  const sign = (x, y) => new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(x, y, -2), new THREE.Vector3(.6, .2, .1));
  const left = talkSignOverlap(shot, heads, [sign(-1.5, 2)]), right = talkSignOverlap(shot, heads, [sign(1.5, 2)]);
  assert.ok(left > 0 && right > 0, 'both speakers reserve speech space even before messages arrive');
  assert.equal(talkSignOverlap(shot, heads, [sign(-1.5, 4), sign(1.5, 4)]), 0, 'text well above the conversation remains unconstrained');
  assert.ok(talkSignOverlap(shot, heads, [sign(-1.5, 2), sign(1.5, 2)]) >= left + right);
});

test('text collection includes transparent-depth tickers and mounted labels but ignores hidden and nontext canvas meshes', t => {
  const root = new THREE.Group(), hidden = new THREE.Group(); hidden.visible = false; root.add(hidden);
  const text = new THREE.Texture(); text.userData.cityText = true;
  const decoration = new THREE.Texture();
  const geometry = new THREE.PlaneGeometry(2, .5), materials = [];
  const add = (parent, map, depthWrite = true) => {
    const material = new THREE.MeshBasicMaterial({ map, depthWrite }); materials.push(material);
    const mesh = new THREE.Mesh(geometry, material); parent.add(mesh); return mesh;
  };
  add(root, text); add(root, text, false).position.x = 3;
  add(hidden, text); add(root, decoration);
  add(root, decoration).userData.mountedLabel = true;
  const boxes = talkTextBounds(root);
  assert.equal(boxes.length, 3);
  assert.ok(boxes.some(({ box }) => box.min.x === 2 && box.max.x === 4), 'world transforms apply to ticker bounds');
  t.after(() => { geometry.dispose(); text.dispose(); decoration.dispose(); materials.forEach(m => m.dispose()); });
});

test('visible text counts but a distant label hidden behind an opaque wall does not', t => {
  const shot = { eye: new THREE.Vector3(0, 1, 8), look: new THREE.Vector3(0, 1, 0) };
  const head = new THREE.Vector3(0, 1, 0), root = new THREE.Group();
  const texture = new THREE.Texture(); texture.userData.cityText = true;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2, .8), new THREE.MeshBasicMaterial({ map: texture }));
  sign.position.set(0, 1, -3); root.add(sign);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(4, 4, .3), new THREE.MeshBasicMaterial());
  wall.position.set(0, 1, -2); root.add(wall);
  const labels = talkTextBounds(root);
  assert.ok(talkSignOverlap(shot, [head], labels) > 0);
  assert.equal(talkSignOverlap(shot, [head], labels, { occluders: [wall] }), 0);
  wall.position.x = 4; root.updateWorldMatrix(true, true);
  assert.ok(talkSignOverlap(shot, [head], labels, { occluders: [wall] }) > 0);
  sign.rotation.y = Math.PI; root.updateWorldMatrix(true, true);
  assert.equal(talkSignOverlap(shot, [head], talkTextBounds(root)), 0, 'the back of a single-sided sign has no readable text');
  t.after(() => { texture.dispose(); for (const mesh of [sign, wall]) { mesh.geometry.dispose(); mesh.material.dispose(); } });
});

test('safe ground and solid-wall clearance outrank text, while clear text outranks temporary cutaways', () => {
  assert.equal(betterTalkComposition([0, 0, 0, 3], [0, 0, 1, 0]), true);
  assert.equal(betterTalkComposition([0, 1, 0, 0], [0, 0, 2, 4]), false);
  assert.equal(betterTalkComposition([1, 0, 0, 0], [0, 4, 2, 4]), false);
  assert.equal(betterTalkComposition([0, 0, 1.1, 2], [0, 0, 1.8, 0]), true);
  assert.equal(betterTalkComposition([0, 0, 0, 1], [0, 0, 0, 1]), false);
});
