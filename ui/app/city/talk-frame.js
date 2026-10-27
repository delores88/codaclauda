/* Fit both conversation figures, including shoulders and feet, inside the available
 * canvas. Scene coordinates and the camera remain in island space. */
import { THREE } from './toon.js';

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
  // Only the Leave control and panel need clearance; there are no letterbox bars.
  const vis = { x0: 12, y0: 56, x1: Math.min(width, visibleWidth) - 12, y1: Math.min(height, visibleHeight) - 12 };
  if (panel?.width && panel?.height) {
    if (panel.top > height * .25) vis.y1 = Math.min(vis.y1, panel.top - 12);
    else vis.x1 = Math.min(vis.x1, panel.left - 12);
  }
  vis.x1 = Math.max(vis.x0 + 1, vis.x1); vis.y1 = Math.max(vis.y0 + 1, vis.y1);
  return vis;
}

/** An open conversational stance: still angled toward the partner, with the
 * camera seeing each face instead of the back of the owner's head. */
export function talkFacingPoint(position, partner, eye) {
  const toPartner = new THREE.Vector2(partner.x - position.x, partner.z - position.z).normalize();
  const toCamera = new THREE.Vector2(eye.x - position.x, eye.z - position.z).normalize();
  const facing = toPartner.add(toCamera);
  if (facing.lengthSq() < 1e-8) facing.set(partner.x - position.x, partner.z - position.z);
  facing.normalize();
  return { x: position.x + facing.x * 4, z: position.z + facing.y * 4 };
}

/** Chest-height RPG two-shot. The camera is beside the conversation line,
 * biased 25 degrees toward the owner's front; it fits both complete bodies in
 * the available panel/sheet rectangle without making one an oversized foreground. */
export function fitTalkShot(spot, face, { width, height, vis, ownerHeight = 1.8, agentHeight = 1.8,
  ownerY = 0, agentY = 0, eyeY = (ownerY + agentY) / 2 + (ownerHeight + agentHeight) * .31, vfov = 40 } = {}) {
  const roomW = vis.x1 - vis.x0, roomH = vis.y1 - vis.y0;
  const targetX = vis.x0 + roomW * .5, targetY = vis.y0 + roomH * .59;
  const nx = 2 * targetX / width - 1, ny = 1 - 2 * targetY / height;
  const tanV = Math.tan(vfov * Math.PI / 360), tanH = tanV * width / height;
  const focal = height / (2 * tanV);
  const camera = new THREE.PerspectiveCamera(vfov, width / height, .05, 10000);
  const figures = [];
  for (const [p, y, top] of [[spot, ownerY, ownerHeight], [face, agentY, agentHeight]]) {
    const points = [];
    for (const dx of [-.5, .5]) for (const dz of [-.4, .4]) for (const dy of [0, top]) points.push(new THREE.Vector3(p.x + dx, y + dy, p.z + dz));
    figures.push(points);
  }
  const line = new THREE.Vector2(spot.x - face.x, spot.z - face.z).normalize();
  if (!line.lengthSq()) line.set(Math.sin(spot.yaw || 0), Math.cos(spot.yaw || 0));
  const angle = 25 * Math.PI / 180;
  const direction = new THREE.Vector2(line.y * Math.cos(angle) - line.x * Math.sin(angle),
    -line.x * Math.cos(angle) - line.y * Math.sin(angle));
  const middle = new THREE.Vector3((spot.x + face.x) / 2,
    (ownerY + agentY) / 2 + (ownerHeight + agentHeight) * .25, (spot.z + face.z) / 2);
  const bounds = { x0: vis.x0 + roomW * .045, x1: vis.x1 - roomW * .045,
    y0: vis.y0 + Math.min(90, roomH * .30), y1: vis.y1 - roomH * .055 };
  let distance = (ownerHeight + agentHeight) / 2 * focal / (roomH * .50);
  let shot;
  const look = new THREE.Vector3();
  for (let step = 0; step < 36; step++) {
    const eye = new THREE.Vector3(middle.x + direction.x * distance, eyeY, middle.z + direction.y * distance);
    const to = middle.clone().sub(eye);
    let yaw = Math.atan2(to.x, to.z), pitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
    // Aim the pair's midpoint inside the free canvas, including a mobile shell
    // whose canvas is wider than the visible area. Iteration removes cross-axis
    // projection error instead of assuming a centred viewport.
    const aim = () => {
      look.set(eye.x + Math.sin(yaw) * Math.cos(pitch) * distance,
        eye.y + Math.sin(pitch) * distance, eye.z + Math.cos(yaw) * Math.cos(pitch) * distance);
      camera.position.copy(eye); camera.lookAt(look); camera.updateMatrixWorld(true);
    };
    for (let n = 0; n < 6; n++) {
      aim(); const p = middle.clone().project(camera);
      yaw -= Math.atan((p.x - nx) * tanH); pitch += Math.atan((p.y - ny) * tanV);
    }
    aim();
    const projected = figures.map(points => points.map(point => {
      const p = point.clone().project(camera);
      return { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2, z: p.z };
    }));
    const heights = projected.map(points => Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)));
    shot = { eye: { x: eye.x, y: eye.y, z: eye.z }, look: { x: look.x, y: look.y, z: look.z } };
    const average = (heights[0] + heights[1]) / 2;
    if (step === 0 || average > roomH * .51) { distance *= Math.max(1.005, average / (roomH * .50)); continue; }
    const inside = projected.flat().every(p => p.z > -1 && p.z < 1 && p.x >= bounds.x0 && p.x <= bounds.x1 && p.y >= bounds.y0 && p.y <= bounds.y1);
    if (inside) break;
    distance *= 1.035;
  }
  return shot;
}
