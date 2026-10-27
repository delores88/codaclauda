/* A moving passer-by can enter a settled conversation shot. Cut it away only
 * while it covers a participant; its simulation and destination keep running. */
import { THREE } from './toon.js';

function projectedPerson(person, camera, forward) {
  const object = person?.object;
  if (!object) return null;
  object.updateWorldMatrix(true, false);
  const points = [];
  let near = Infinity, far = -Infinity;
  const height = Number(person.topY) || 1.8;
  for (const x of [-.6, .6]) for (const z of [-.5, .5]) for (const y of [0, height + .12]) {
    const world = new THREE.Vector3(x, y, z).applyMatrix4(object.matrixWorld);
    const depth = (world.x - camera.position.x) * forward.x + (world.y - camera.position.y) * forward.y
      + (world.z - camera.position.z) * forward.z;
    near = Math.min(near, depth); far = Math.max(far, depth);
    points.push(world.project(camera));
  }
  if (far <= camera.near || !points.some(p => p.z > -1 && p.z < 1)) return null;
  return { x0: Math.min(...points.map(p => p.x)), x1: Math.max(...points.map(p => p.x)),
    y0: Math.min(...points.map(p => p.y)), y1: Math.max(...points.map(p => p.y)), near, far };
}

export function talkOccludingPeople(camera, participants, bystanders) {
  camera.updateMatrixWorld(true);
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const targets = participants.map(p => projectedPerson(p, camera, forward)).filter(Boolean);
  const hidden = new Set();
  for (const person of bystanders) {
    const box = projectedPerson(person, camera, forward);
    if (box && targets.some(target => box.near < target.far && box.x0 < target.x1
      && box.x1 > target.x0 && box.y0 < target.y1 && box.y1 > target.y0)) hidden.add(person.object);
  }
  return hidden;
}
