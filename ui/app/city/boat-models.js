/* Original low-poly river craft, facing +x with local y=0 at the waterline.
 * Static parts batch by material; moving parts pivot on physical supports. */
import { THREE, toonMaterial, addOutline } from './toon.js';
import { mergeParts, placed, plaqueTexture } from './fx.js';
import { BOAT_TYPES } from './boats.js';

export { BOAT_TYPES };
export const MODEL_MAX_TOP = 1.84; // mast + ink + maximum .03 local bob
export const BOAT_DIMENSIONS = Object.freeze({
  sailboat: { length: 2.2, width: 0.7 }, rowboat: { length: 1.4, width: 0.6 },
  tugboat: { length: 1.8, width: 0.78 }, barge: { length: 3.6, width: 1.2 },
  'paddle-steamer': { length: 3, width: 0.94 }, canoe: { length: 1.6, width: 0.45 },
});
const INK = 0.012;
const COLORS = { sailboat: '#f5f3e9', rowboat: '#a8774c', tugboat: '#bc4947', barge: '#638a61', 'paddle-steamer': '#eee4c9', canoe: '#e5bc4d' };
const box = (w, h, d, x = 0, y = 0, z = 0, rz = 0) => placed(new THREE.BoxGeometry(w, h, d), { x, y, z, rz });
const cylinder = (r, h, x, y, z, low, rx = 0) => placed(new THREE.CylinderGeometry(r, r, h, low ? 6 : 12), { x, y, z, rx });
const sphere = (r, x, y, z, low) => placed(new THREE.SphereGeometry(r, low ? 6 : 10, low ? 4 : 6), { x, y, z });

function mesh(parent, geometry, material, low, outline = true) {
  const node = new THREE.Mesh(geometry, material);
  node.castShadow = !low; node.receiveShadow = !low; node.raycast = () => {};
  if (outline) addOutline(node, { thickness: INK });
  parent.add(node); return node;
}
class Parts {
  constructor() { this.groups = new Map(); }
  add(tint, geometry) {
    const material = typeof tint === 'string' ? toonMaterial(tint) : tint;
    if (!this.groups.has(material)) this.groups.set(material, []);
    this.groups.get(material).push(geometry);
  }
  build(parent, low) { for (const [material, parts] of this.groups) mesh(parent, mergeParts(parts), material, low); }
}
function beam(a, b, width = 0.045) {
  const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b), direction = to.clone().sub(from);
  const geometry = new THREE.BoxGeometry(width, direction.length(), width);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()));
  geometry.translate(...from.add(to).multiplyScalar(0.5).toArray()); return geometry;
}
function hullGeometry(length, width, { pointed = false, low = false } = {}) {
  const tail = -length / 2, bow = length / 2, shoulder = bow - Math.min(0.36, length * 0.2), half = width / 2;
  const shape = new THREE.Shape(); shape.moveTo(tail, pointed ? 0 : -half * 0.8);
  if (pointed) shape.lineTo(tail + length * 0.22, -half);
  else if (!low) shape.lineTo(tail + 0.12, -half);
  shape.lineTo(shoulder, -half); shape.lineTo(bow, 0); shape.lineTo(shoulder, half);
  if (pointed) shape.lineTo(tail + length * 0.22, half);
  else { if (!low) shape.lineTo(tail + 0.12, half); shape.lineTo(tail, half * 0.8); }
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.26, bevelEnabled: false, curveSegments: 1 });
  geometry.rotateX(-Math.PI / 2); geometry.translate(0, -0.13, 0); return geometry;
}
function sailTriangle(vertices) {
  const shape = new THREE.Shape(); shape.moveTo(...vertices[0]); shape.lineTo(...vertices[1]); shape.lineTo(...vertices[2]); shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: false, curveSegments: 1 });
  geometry.translate(0, 0, -0.006); return geometry;
}

/** Labels always have a real board touching hull or cargo. Text is the only mesh
 * without ink: outlining a transparent text plane would cover its own glyphs. */
function labelBoards(parent, project, { x, y, z, width, height = 0.20, kind = 'hull', crate = null }, low, accent) {
  const depth = kind === 'crate' ? 0.035 : 0.06;
  for (const side of [-1, 1]) {
    const mount = new THREE.Group(); mount.name = `${kind}-label-board`;
    mount.userData = { labelMount: true, mountKind: kind, projectId: project.projectId, ...(crate ? { crate } : {}) };
    mount.position.set(x, y, side * z); parent.add(mount);
    mesh(mount, box(width + 0.03, height + 0.03, depth), toonMaterial('#eee1c4'), low);
    const face = mesh(mount, new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: plaqueTexture(project.label, { accent }), transparent: true, side: THREE.DoubleSide, toneMapped: false }), low, false);
    face.position.z = side * (depth / 2 + 0.001); if (side < 0) face.rotation.y = Math.PI;
    face.userData = { mountedLabel: true, projectId: project.projectId }; face.castShadow = false;
  }
}
function person(parts, low, x, shirt) {
  parts.add('#526377', box(0.27, 0.07, 0.21, x + 0.09, 0.275));
  parts.add(shirt, box(0.19, 0.30, 0.23, x, 0.45));
  parts.add('#d5aa7a', sphere(0.105, x, 0.70, 0, low));
  if (!low) parts.add('#54596e', box(0.20, 0.035, 0.22, x + 0.015, 0.78));
}

/** Entries are frozen policy choices: quality changes rebuild the same entry,
 * with no random draws or label/type decisions inside the model. */
export function createBoat(entry = {}, { low = false } = {}) {
  const type = BOAT_TYPES.includes(entry.type) ? entry.type : 'rowboat';
  const source = Array.isArray(entry.projects) && entry.projects.length ? entry.projects : entry.projectId ? [{ projectId: entry.projectId, label: entry.label || entry.projectId }] : [];
  const crateCount = type === 'barge' ? Math.max(2, Math.min(4, Math.round(Number(entry.crateCount) || Math.max(2, source.length)))) : 0;
  const seen = new Set(), projects = source.filter(item => item?.projectId && !seen.has(item.projectId) && seen.add(item.projectId)).slice(0, crateCount || 1).map(item => ({ projectId: item.projectId, label: String(item.label || item.projectId).slice(0, 40) }));
  const group = new THREE.Group(); group.name = `${type}:${projects[0]?.projectId || 'empty'}`;
  group.userData = { boatType: type, type, projectIds: projects.map(item => item.projectId), projectId: projects[0]?.projectId || null };
  const model = new THREE.Group(); model.name = 'boat-model'; group.add(model);
  const motion = { model, oars: [], paddles: [], wheel: null, smoke: [], lights: [], low }; group.motion = motion;
  const parts = new Parts(), { length, width } = BOAT_DIMENSIONS[type];
  const hull = mesh(model, hullGeometry(length, width, { pointed: type === 'canoe', low }), toonMaterial(COLORS[type]), low);
  hull.name = 'waterline-hull'; hull.userData.hull = true;
  const wood = '#c99b6a', dark = '#37434d', cream = '#eee4c9';

  if (type === 'sailboat') {
    parts.add(cream, box(1.55, 0.05, 0.52, -0.10, 0.155));
    parts.add(wood, cylinder(0.027, 1.6, -0.12, 0.98, 0, low));
    parts.add(wood, box(0.96, 0.04, 0.04, 0.34, 0.54));
    parts.add('#f3e8ca', sailTriangle([[-0.12, 1.72], [-0.12, 0.54], [0.81, 0.54]]));
    const violet = sailTriangle([[-0.12, 1.72], [-0.12, 1.15], [0.33, 1.15]]); violet.translate(0, 0, 0.008);
    parts.add('#9a87b8', violet);
    if (!low) { parts.add(dark, box(0.24, 0.06, 0.28, -0.60, 0.21)); parts.add(wood, box(0.06, 0.22, 0.06, -0.81, 0.20)); }
  } else if (type === 'rowboat') {
    parts.add('#79583e', box(0.98, 0.03, 0.43, -0.04, 0.145));
    for (const x of [-0.16, 0.34]) parts.add(wood, box(0.17, 0.10, 0.56, x, 0.20));
    person(parts, low, -0.16, '#728a9d');
    for (const side of [-1, 1]) {
      const pivot = [0.05, 0.31, side * 0.28];
      parts.add(dark, cylinder(0.035, 0.18, pivot[0], 0.22, pivot[2], low));
      parts.add('#d5aa7a', beam([-0.16, 0.53, side * 0.12], pivot));
      const oar = new THREE.Group(); oar.name = `rowing-oar:${side}`; oar.position.set(...pivot); model.add(oar);
      const oarParts = new Parts(); oarParts.add(wood, box(0.045, 0.045, 0.63, 0, 0, side * 0.18));
      oarParts.add(wood, box(0.13, 0.035, 0.23, 0, 0, side * 0.47)); oarParts.build(oar, low); motion.oars.push({ group: oar, side });
      if (!low) parts.add(cream, box(0.98, 0.04, 0.035, -0.06, 0.16, side * 0.29));
    }
  } else if (type === 'tugboat') {
    parts.add(cream, box(1.30, 0.05, 0.65, -0.05, 0.155));
    parts.add('#f0eee5', box(0.62, 0.50, 0.56, -0.28, 0.43));
    parts.add(dark, box(0.75, 0.06, 0.67, -0.28, 0.71));
    parts.add('#272d31', cylinder(0.095, 0.55, 0.42, 0.455, 0, low));
    parts.add('#272d31', cylinder(0.125, 0.07, 0.42, 0.765, 0, low));
    for (const side of [-1, 1]) parts.add('#92bcc5', box(0.42, 0.19, 0.022, -0.28, 0.52, side * 0.29));
    if (!low) {
      for (const side of [-1, 1]) for (const x of [-0.65, 0.54]) parts.add(dark, placed(new THREE.TorusGeometry(0.10, 0.035, 5, 8), { x, y: 0.10, z: side * 0.38 }));
      for (let n = 0; n < 3; n++) {
        const material = toonMaterial('#aab0ad', { transparent: true, opacity: 0.45, cache: false }); material.depthWrite = false;
        const puff = mesh(model, sphere(0.075, 0, 0, 0, false), material, true); puff.name = 'funnel-smoke'; puff.castShadow = false;
        motion.smoke.push(puff);
      }
    }
  } else if (type === 'barge') {
    parts.add(wood, box(3.04, 0.05, 1.08, -0.05, 0.155));
    for (const side of [-1, 1]) parts.add('#8da179', box(3.04, 0.15, 0.06, -0.05, 0.205, side * 0.56));
    const count = crateCount;
    group.userData.crateCount = count;
    for (let n = 0; n < count; n++) {
      const w = 2.8 / count - 0.08, x = (n - (count - 1) / 2) * (2.8 / count), crate = { x, y: 0.43, z: 0, w, h: 0.50, d: 0.94 };
      parts.add(n % 2 ? '#b68d5d' : '#c89b6c', box(w, crate.h, crate.d, x, crate.y));
      if (!low) for (const dx of [-w * 0.32, w * 0.32]) parts.add('#e2c394', box(0.035, 0.51, 0.95, x + dx, 0.43));
      if (projects[n]) labelBoards(model, projects[n], { x, y: 0.44, z: 0.477, width: w - 0.08, height: 0.22, kind: 'crate', crate }, low, COLORS[type]);
    }
  } else if (type === 'paddle-steamer') {
    parts.add(cream, box(2.45, 0.05, 0.86, -0.02, 0.155));
    parts.add(cream, box(1.80, 0.40, 0.75, 0.05, 0.38));
    parts.add('#c0aa87', box(2.10, 0.08, 0.92, 0.05, 0.62));
    parts.add(cream, box(1.23, 0.35, 0.61, 0.14, 0.835));
    parts.add('#c0aa87', box(1.52, 0.06, 0.78, 0.14, 1.04));
    for (const x of [-0.20, 0.33]) { parts.add('#34383c', cylinder(0.075, 0.43, x, 1.28, 0, low)); parts.add('#b95147', cylinder(0.10, 0.06, x, 1.51, 0, low)); }
    for (const side of [-1, 1]) {
      for (const x of [-0.55, 0.05, 0.65]) parts.add('#88b0ba', box(0.20, 0.18, 0.025, x, 0.43, side * 0.385));
      parts.add('#88b0ba', box(0.70, 0.17, 0.025, 0.14, 0.84, side * 0.316));
      parts.add(dark, box(0.74, 0.08, 0.06, -1.14, 0.24, side * 0.35));
      if (!low) { parts.add(cream, box(1.90, 0.035, 0.035, 0.05, 0.83, side * 0.44)); for (const x of [-0.85, 0.95]) parts.add(cream, box(0.035, 0.20, 0.035, x, 0.73, side * 0.44)); }
    }
    const wheel = new THREE.Group(); wheel.name = 'stern-paddle-wheel'; wheel.position.set(-1.42, 0.24, 0); model.add(wheel); motion.wheel = wheel;
    const wheelParts = new Parts();
    for (const side of [-1, 1]) wheelParts.add('#b95147', cylinder(0.29, 0.045, 0, 0, side * 0.29, low, Math.PI / 2));
    wheelParts.add(dark, cylinder(0.05, 0.74, 0, 0, 0, low, Math.PI / 2));
    const blades = low ? 4 : 8;
    for (let n = 0; n < blades; n++) { const a = n / blades * Math.PI * 2; wheelParts.add('#bf5749', box(0.08, 0.10, 0.66, Math.cos(a) * 0.29, Math.sin(a) * 0.29, 0, a)); }
    wheelParts.build(wheel, low);
  } else {
    parts.add('#9b753f', box(1.10, 0.03, 0.29, -0.03, 0.145));
    parts.add(wood, box(0.17, 0.10, 0.41, -0.16, 0.20));
    person(parts, low, -0.16, '#748f76');
    for (const side of [-1, 1]) {
      const stroke = new THREE.Group(); stroke.name = `canoe-stroke:${side}`; model.add(stroke);
      const armParts = new Parts(), grip = [0.14, 0.44, side * 0.21];
      for (const shoulder of [-1, 1]) armParts.add('#d5aa7a', beam([-0.16, 0.53, shoulder * 0.12], grip));
      armParts.build(stroke, low);
      const paddle = new THREE.Group(); paddle.position.set(...grip); stroke.add(paddle);
      const paddleParts = new Parts(); paddleParts.add(wood, beam([0, 0.06, 0], [0.02, -0.40, side * 0.27], 0.035));
      paddleParts.add(wood, box(0.13, 0.20, 0.04, 0.02, -0.38, side * 0.26)); paddleParts.build(paddle, low);
      motion.paddles.push({ group: stroke, paddle, side });
    }
    if (!low) for (const side of [-1, 1]) parts.add(cream, box(0.96, 0.035, 0.025, -0.04, 0.15, side * 0.215));
  }
  const light = toonMaterial('#f4d697', { emissive: '#efbd6c', emissiveIntensity: 0.05, cache: false });
  parts.add(dark, cylinder(0.04, 0.10, length / 2 - 0.27, 0.17, 0, low));
  parts.add(light, sphere(0.04, length / 2 - 0.27, 0.24, 0, low)); motion.lights.push(light);
  parts.build(model, low);
  if (type !== 'barge' && projects[0]) {
    const labelX = type === 'rowboat' || type === 'canoe' ? -0.40 : type === 'paddle-steamer' ? 0.62 : -0.18;
    const labelW = type === 'rowboat' || type === 'canoe' ? 0.42 : type === 'paddle-steamer' ? 0.64 : 0.80;
    labelBoards(model, projects[0], { x: labelX, y: 0.16, z: width / 2 + 0.005, width: labelW, height: 0.18 }, low, COLORS[type]);
  }
  updateBoat(group, 0, 0, { low, reducedMotion: false, night: 0 });
  group.userData.maxTop = MODEL_MAX_TOP;
  return group;
}

/** No allocations or random state during animation. Reduced motion freezes all
 * rigs/smoke/bob; night lighting is an environmental appearance change. */
export function updateBoat(boat, dt, elapsed, { night = 0, reducedMotion = false, low = false } = {}) {
  const motion = boat.motion; if (!motion) return;
  const still = Boolean(reducedMotion), time = !still && Number.isFinite(elapsed) ? elapsed : 0;
  motion.model.position.y = still || low ? 0 : Math.sin(time * 0.8) * 0.03;
  for (const { group, side } of motion.oars) group.rotation.y = still ? 0 : Math.sin(time * 1.5) * side * 0.32;
  if (motion.wheel) motion.wheel.rotation.z = still ? 0 : -time * 1.2;
  for (const { group, paddle, side } of motion.paddles) {
    group.visible = still ? side === 1 : (Math.sin(time * 1.4) >= 0 ? 1 : -1) === side;
    paddle.rotation.z = still ? 0 : Math.sin(time * 2.8) * 0.16;
  }
  for (let n = 0; n < motion.smoke.length; n++) {
    const puff = motion.smoke[n], phase = ((time * 0.45 + n / motion.smoke.length) % 1 + 1) % 1;
    puff.visible = !still && !low; puff.position.set(0.42 - phase * 0.14, 0.83 + phase * 0.50, 0);
    puff.scale.setScalar(0.6 + phase * 0.6); puff.material.opacity = 0.35 * (1 - phase);
  }
  for (const light of motion.lights) light.emissiveIntensity = 0.05 + Math.max(0, Math.min(1, Number(night) || 0)) * 1.3;
}
