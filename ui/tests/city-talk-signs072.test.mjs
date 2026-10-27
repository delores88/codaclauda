import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { talkSignOverlap } from '../app/city/talk-signs.js';
test('conversation composition penalizes signs behind heads while obstruction remains a separate check', () => {
  const shot = { eye: new THREE.Vector3(0, 1, 8), look: new THREE.Vector3(0, 1, 0) };
  const head = new THREE.Vector3(0, 1, 0);
  const sign = (x, z) => new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(x, 1, z), new THREE.Vector3(2, .8, .1));
  assert.equal(talkSignOverlap(shot, [head], [sign(0, -2)]), 1);
  assert.equal(talkSignOverlap(shot, [head], [sign(5, -2)]), 0);
  assert.equal(talkSignOverlap(shot, [head], [sign(0, 2)]), 0, 'foreground sign is handled by obstruction rays');
  assert.equal(talkSignOverlap(shot, [head], [sign(0, 10)]), 0, 'behind-camera signs do not influence staging');
});
