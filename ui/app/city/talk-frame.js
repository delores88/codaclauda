/* Fit both conversation figures, including shoulders and feet, inside the available
 * canvas. Scene coordinates and the camera remain in island space. */
import { THREE } from './toon.js';
import { talkShot } from './talk.js';

/** Scenery disables pointer picking, but it can still obscure a conversation camera. */
export function talkSceneMeshes(root, ignored = []) {
  const meshes = [], skip = new Set(ignored.filter(Boolean));
  root?.updateWorldMatrix(true, true);
  root?.traverseVisible(node => {
    if (!node.isMesh || node.userData.outline) return;
    for (let parent = node; parent; parent = parent.parent) if (skip.has(parent)) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    if (materials.every(m => !m || m.visible === false || m.opacity < .45 || m.depthWrite === false)) return;
    meshes.push(node);
  });
  return meshes;
}

/** Rays cover the face silhouette, not only its centre: a narrow lamp can hide
 * an eye while missing a centre ray. Samples share a plane facing the camera. */
export function talkFigureTargets(eye, position, faceHeight) {
  const centre = new THREE.Vector3(position.x, (position.y || 0) + faceHeight, position.z);
  const normal = new THREE.Vector3(eye.x, eye.y, eye.z).sub(centre).normalize();
  const right = new THREE.Vector3(normal.z, 0, -normal.x);
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0); else right.normalize();
  const up = new THREE.Vector3().crossVectors(normal, right).normalize();
  const targets = [];
  for (const x of [-.5, -.25, 0, .25, .5]) for (const y of [-.35, 0, .35]) {
    targets.push(centre.clone().addScaledVector(right, x).addScaledVector(up, y));
  }
  for (const x of [-.45, 0, .45]) {
    targets.push(new THREE.Vector3(position.x, (position.y || 0) + Math.max(.35, faceHeight - .65), position.z).addScaledVector(right, x));
  }
  return targets;
}

export function talkSceneHits(meshes, eye, targets) {
  const found = new Set(), ray = new THREE.Raycaster(), origin = new THREE.Vector3(eye.x, eye.y, eye.z);
  for (const target of targets) {
    const direction = new THREE.Vector3(target.x, target.y, target.z).sub(origin);
    ray.near = .05; ray.far = Math.max(.05, direction.length() - .15); ray.set(origin, direction.normalize());
    for (const mesh of meshes) {
      if (found.has(mesh)) continue;
      const hits = [];
      // Call geometry intersection directly: decorative meshes deliberately opt out of pointer rays.
      (mesh.isInstancedMesh ? THREE.InstancedMesh.prototype.raycast : THREE.Mesh.prototype.raycast).call(mesh, ray, hits);
      if (hits.length) found.add(mesh);
    }
  }
  return found;
}

/** A temporary camera cutaway. Materials are cloned so shared city palettes stay intact. */
export function cutawayTalkMeshes(meshes) {
  const saved = [];
  for (const mesh of meshes) {
    const original = mesh.material, materials = Array.isArray(original) ? original : [original];
    const copies = materials.map(m => { const copy = m.clone(); copy.transparent = true; copy.opacity = .10; copy.depthWrite = false; return copy; });
    const outlines = mesh.children.filter(child => child.userData.outline && child.visible);
    if (mesh.isInstancedMesh) for (const sibling of mesh.parent?.children || []) {
      if (sibling.userData.outline && sibling.visible && sibling.instanceMatrix === mesh.instanceMatrix) outlines.push(sibling);
    }
    for (const child of outlines) child.visible = false;
    const replacement = Array.isArray(original) ? copies : copies[0];
    mesh.material = replacement; saved.push({ mesh, original, replacement, copies, outlines });
  }
  return () => {
    for (const { mesh, original, replacement, copies, outlines } of saved) {
      if (mesh.material === replacement) mesh.material = original;
      for (const child of outlines) child.visible = true;
      for (const material of copies) material.dispose();
    }
  };
}

/** Segment/slab test includes the final fitted camera, not just the short staging offset. */
export function talkWallHits(eye, targets, boxes) {
  let hits = 0;
  for (const target of targets) for (const box of boxes) {
    let lo = 0, hi = 1;
    for (const axis of ['x', 'y', 'z']) {
      const min = box[axis + '0'] ?? (axis === 'y' ? -Infinity : 0);
      const max = box[axis + '1'] ?? (axis === 'y' ? box.low ? .7 : Infinity : 0);
      const d = target[axis] - eye[axis];
      if (Math.abs(d) < 1e-8) { if (eye[axis] <= min || eye[axis] >= max) { hi = -1; break; } }
      else { const a = (min - eye[axis]) / d, b = (max - eye[axis]) / d; lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b)); }
    }
    if (hi > lo && lo < .97 && hi > .02) hits++;
  }
  return hits;
}

export function talkVisibleRect({ width, height, visibleWidth = width, visibleHeight = height, panel }) {
  const vis = { x0: 12, y0: Math.max(56, height * .08 + 10), x1: Math.min(width, visibleWidth) - 12, y1: Math.min(height * .92, visibleHeight) - 12 };
  if (panel?.width && panel?.height) {
    if (panel.top > height * .25) vis.y1 = Math.min(vis.y1, panel.top - 12);
    else vis.x1 = Math.min(vis.x1, panel.left - 12);
  }
  vis.x1 = Math.max(vis.x0 + 1, vis.x1); vis.y1 = Math.max(vis.y0 + 1, vis.y1);
  return vis;
}

export function fitTalkShot(spot, face, { width, height, vis, ownerHeight = 1.8, agentHeight = 1.8,
  ownerY = 0, agentY = 0, eyeY = ownerY + ownerHeight * 1.5, vfov = 40 } = {}) {
  const roomW = vis.x1 - vis.x0, roomH = vis.y1 - vis.y0;
  const mobile = roomW < 450;
  const nx = 2 * (vis.x0 + roomW * .68) / width - 1;
  const ny = 1 - 2 * (vis.y0 + roomH * (mobile ? .50 : .46)) / height;
  const camera = new THREE.PerspectiveCamera(vfov, width / height, .05, 10000);
  const figures = [];
  for (const [p, y, top] of [[spot, ownerY, ownerHeight], [face, agentY, agentHeight]]) {
    const points = [];
    for (const dx of [-.5, .5]) for (const dz of [-.5, .5]) for (const dy of [0, top]) points.push(new THREE.Vector3(p.x + dx, y + dy, p.z + dz));
    figures.push(points);
  }
  // Keeping a fixed shoulder offset while backing up puts Ben directly over the NPC.
  // Widen the shoulder angle as well as the distance; the two silhouettes then stay
  // separate, with Ben lower-left and the agent's face unobstructed on the right.
  const gap = Math.hypot(spot.x - face.x, spot.z - face.z);
  const back = Math.max(spot.back, gap * 1.1), side = Math.max(Math.abs(spot.side || 0), gap * 1.8) * (spot.side < 0 ? -1 : 1);
  const bounds = { x0: vis.x0 + roomW * .045, x1: vis.x1 - roomW * .045,
    y0: vis.y0 + Math.min(mobile ? 90 : 80, roomH * (mobile ? .4 : .30)), y1: vis.y1 - roomH * .055 };
  let shot;
  for (let step = 0; step < 48; step++) {
    const scale = 1.08 ** step;
    shot = talkShot({ ...spot, back: back * scale, side: side * scale }, face, { eyeY, nx, ny, vfov, aspect: width / height });
    camera.position.set(shot.eye.x, shot.eye.y, shot.eye.z);
    camera.lookAt(shot.look.x, shot.look.y, shot.look.z); camera.updateMatrixWorld(true);
    const inside = figures.flat().every(point => {
      const p = point.clone().project(camera), x = (p.x + 1) * width / 2, y = (1 - p.y) * height / 2;
      return p.z > -1 && p.z < 1 && x >= bounds.x0 && x <= bounds.x1 && y >= bounds.y0 && y <= bounds.y1;
    });
    if (inside) break;
  }
  return shot;
}
