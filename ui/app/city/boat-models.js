/* Original low-poly river craft. Every model faces +x; local y=0 is the fixed
 * waterline. Compact sails, oars and wheels fit the same channel/bridge envelope. */
import { THREE, toonMaterial } from './toon.js';
import { mergeParts, placed, plaqueTexture } from './fx.js';
import { BOAT_TYPES } from './boats.js';

export { BOAT_TYPES };
const box = (w, h, d, x = 0, y = 0, z = 0, rz = 0) => placed(new THREE.BoxGeometry(w, h, d), { x, y, z, rz });
const cylinder = (r, h, x, y, z, low, rx = 0) => placed(new THREE.CylinderGeometry(r, r, h, low ? 5 : 10), { x, y, z, rx });

function mesh(group, geometry, material, low) {
  const part = new THREE.Mesh(geometry, material);
  part.castShadow = !low; part.receiveShadow = !low; part.raycast = () => {};
  group.add(part); return part;
}

function hullGeometry(length, width, { pointed = false, low = false } = {}) {
  const tail = -length / 2, bow = length / 2, shoulder = bow - 0.48, half = width / 2;
  const shape = new THREE.Shape(); shape.moveTo(tail, pointed ? 0 : -half * 0.78);
  if (pointed) shape.lineTo(tail + 0.5, -half);
  else if (!low) shape.lineTo(tail + 0.18, -half);
  shape.lineTo(shoulder, -half); shape.lineTo(bow, 0); shape.lineTo(shoulder, half);
  if (pointed) shape.lineTo(tail + 0.5, half);
  else { if (!low) shape.lineTo(tail + 0.18, half); shape.lineTo(tail, half * 0.78); }
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.34, bevelEnabled: false, curveSegments: 1 });
  geometry.rotateX(-Math.PI / 2); geometry.translate(0, -0.17, 0); return geometry;
}

/** Plaques sit on backing boards whose inner edges overlap the hull. The face is
 * a child of that physical mount, never a detached sprite or floating label. */
function labels(group, projects, halfWidth, low, accent) {
  const steamer = group.userData.boatType === 'paddle-steamer';
  const count = Math.min(3, projects.length), width = steamer ? 0.70 : count === 1 ? 1.65 : count === 2 ? 0.95 : 0.69;
  const spacing = count === 2 ? 1.06 : 0.82;
  for (let index = 0; index < count; index++) {
    // The steamer's bow has clear hull beyond the paddle wheel. Extra plaques
    // stack there on backing boards extended down to the same hull contact.
    const item = projects[index], x = steamer ? 0.72 : (index - (count - 1) / 2) * spacing, lift = steamer ? index * 0.25 : 0;
    for (const side of [-1, 1]) {
      const mount = new THREE.Group(); mount.name = 'hull-label-board'; mount.userData.labelMount = true; mount.userData.projectId = item.projectId;
      mount.position.set(x, 0.255 + lift, side * (halfWidth - 0.015)); group.add(mount);
      mesh(mount, box(width + 0.07, 0.28 + lift, 0.07, 0, -lift / 2), toonMaterial('#eadcc3'), low);
      const material = new THREE.MeshBasicMaterial({ map: plaqueTexture(item.label, { accent }), transparent: true, side: THREE.DoubleSide, toneMapped: false });
      const face = mesh(mount, new THREE.PlaneGeometry(width, 0.24), material, low);
      face.position.z = side * 0.036; if (side < 0) face.rotation.y = Math.PI;
      face.userData.mountedLabel = true; face.userData.projectId = item.projectId; face.castShadow = false;
    }
  }
}

/** entry: { type, projectId, label, projects:[{projectId,label}] }. Empty boats
 * carry no project label. At most three mounted project plaques per side. */
export function createBoat(entry = {}, { low = false } = {}) {
  const type = BOAT_TYPES.includes(entry.type) ? entry.type : 'rowboat';
  const source = entry.projects?.length ? entry.projects : entry.projectId ? [{ projectId: entry.projectId, label: entry.label || entry.projectId }] : [];
  const seen = new Set(), projects = source.filter(item => item?.projectId && !seen.has(item.projectId) && seen.add(item.projectId)).slice(0, 3).map(item => ({ projectId: item.projectId, label: String(item.label || item.projectId).slice(0, 40) }));
  const group = new THREE.Group(); group.name = `${type}:${projects[0]?.projectId || 'empty'}`;
  group.userData.boatType = type; group.userData.type = type; group.userData.projectIds = projects.map(item => item.projectId); group.userData.projectId = projects[0]?.projectId || null;
  const batches = new Map();
  const part = (tint, geometry) => { if (!batches.has(tint)) batches.set(tint, []); batches.get(tint).push(geometry); };
  const colors = { sailboat: '#79aaa8', rowboat: '#bb805a', tugboat: '#d19056', barge: '#5e8293', 'paddle-steamer': '#d3e0d5', canoe: '#bd6559' };
  const widths = { sailboat: 0.94, rowboat: 0.9, tugboat: 1.1, barge: 1.22, 'paddle-steamer': 0.96, canoe: 0.62 };
  const lengths = { sailboat: 2.85, rowboat: 2.6, tugboat: 2.8, barge: 3.15, 'paddle-steamer': 2.95, canoe: 3.0 };
  const hull = mesh(group, hullGeometry(lengths[type], widths[type], { pointed: type === 'canoe', low }), toonMaterial(colors[type]), low);
  hull.name = 'waterline-hull'; hull.userData.hull = true;
  const timber = '#d9b98a', dark = '#385461', cream = '#f3e7cc';

  if (type === 'sailboat') {
    part(cream, box(1.9, 0.07, 0.73, -0.08, 0.205));
    part(timber, cylinder(0.042, 1.14, -0.12, 0.78, 0, low)); // mast enters deck, top 1.35
    part(timber, box(1.1, 0.05, 0.05, 0.39, 0.47));
    const sail = new THREE.BufferGeometry(); sail.setAttribute('position', new THREE.Float32BufferAttribute([-0.10, 1.30, 0, -0.10, 0.49, 0, 0.90, 0.49, 0], 3)); sail.computeVertexNormals();
    mesh(group, sail, toonMaterial('#fff0c6', { side: THREE.DoubleSide }), low).name = 'triangular-sail';
    if (!low) {
      const stripe = new THREE.BufferGeometry(); stripe.setAttribute('position', new THREE.Float32BufferAttribute([-0.09, 0.78, 0.002, -0.09, 0.66, 0.002, 0.67, 0.66, 0.002, 0.52, 0.78, 0.002], 3)); stripe.setIndex([0, 1, 2, 0, 2, 3]); stripe.computeVertexNormals();
      mesh(group, stripe, toonMaterial('#dc9d6b', { side: THREE.DoubleSide }), low).name = 'sail-stripe';
      part(dark, box(0.22, 0.21, 0.05, -1.18, 0.18));
    }
  } else if (type === 'rowboat') {
    part('#765948', box(1.82, 0.035, 0.68, -0.08, 0.181));
    for (const x of [-0.57, 0.4]) part(timber, box(0.20, 0.10, 0.86, x, 0.245));
    // Oars rest across inboard rowlocks, clear of both hull-side name boards.
    for (const side of [-1, 1]) {
      part(timber, box(0.72, 0.055, 0.055, 0.14, 0.30, side * 0.25));
      part(timber, box(0.31, 0.045, 0.17, 0.50, 0.30, side * 0.25));
      part(dark, box(0.08, 0.16, 0.08, -0.04, 0.24, side * 0.25));
      if (!low) part('#eee0bd', box(2.05, 0.055, 0.045, -0.08, 0.22, side * 0.42));
    }
  } else if (type === 'tugboat') {
    part(cream, box(1.95, 0.07, 0.94, -0.08, 0.205));
    part(cream, box(0.88, 0.59, 0.82, -0.55, 0.51));
    part(dark, box(1.04, 0.09, 0.97, -0.55, 0.85));
    part(dark, cylinder(0.12, 0.66, 0.48, 0.56, 0, low));
    part('#c56349', cylinder(0.16, 0.13, 0.48, 0.91, 0, low));
    for (const side of [-1, 1]) part('#8fc9d2', box(0.55, 0.23, 0.025, -0.55, 0.63, side * 0.42));
    if (!low) for (const side of [-1, 1]) for (const x of [-0.9, 0.8]) part(dark, placed(new THREE.TorusGeometry(0.13, 0.055, 5, 8), { x, y: 0.16, z: side * 0.55 }));
  } else if (type === 'barge') {
    part(timber, box(2.45, 0.045, 1.06, -0.08, 0.19));
    for (const side of [-1, 1]) part('#8da0a3', box(2.5, 0.23, 0.08, -0.08, 0.295, side * 0.57));
    for (const x of [-1.28, 1.08]) part('#8da0a3', box(0.08, 0.23, 1.14, x, 0.295));
    for (let n = 0; n < Math.max(1, projects.length); n++) {
      const x = -0.82 + n * 0.80;
      part(n % 2 ? '#ac8d65' : '#98a975', box(0.64, 0.42, 0.85, x, 0.42));
      if (!low) part('#ded0a3', box(0.065, 0.43, 0.87, x, 0.425));
    }
  } else if (type === 'paddle-steamer') {
    part(cream, box(2.25, 0.07, 0.84, -0.08, 0.205));
    part(cream, box(1.28, 0.48, 0.72, -0.25, 0.48));
    part('#bd7866', box(1.55, 0.08, 0.91, -0.25, 0.76));
    for (const x of [0.22, 0.54]) { part(dark, cylinder(0.10, 0.54, x, 0.91, 0, low)); part('#c17654', cylinder(0.13, 0.09, x, 1.21, 0, low)); }
    for (const side of [-1, 1]) {
      part('#bf8056', cylinder(0.35, 0.16, -0.20, 0.33, side * 0.56, low, Math.PI / 2));
      part(dark, cylinder(0.09, 0.19, -0.20, 0.33, side * 0.56, low, Math.PI / 2));
      const blades = low ? 4 : 8;
      for (let n = 0; n < blades; n++) { const a = n / blades * Math.PI * 2; part(timber, box(0.13, 0.11, 0.18, -0.2 + Math.cos(a) * 0.32, 0.33 + Math.sin(a) * 0.32, side * 0.56, a)); }
      if (!low) for (const x of [-0.63, -0.14, 0.35]) part('#7faeb7', box(0.19, 0.17, 0.025, x, 0.53, side * 0.37));
    }
  } else {
    part('#785548', box(1.78, 0.025, 0.40, -0.02, 0.18));
    for (const x of [-0.55, 0.5]) part(timber, box(0.15, 0.10, 0.56, x, 0.235));
    part(timber, box(1.45, 0.045, 0.055, -0.02, 0.30, 0.08));
    part(timber, box(0.32, 0.045, 0.15, 0.78, 0.30, 0.08));
    if (!low) for (const side of [-1, 1]) part(cream, box(1.95, 0.05, 0.04, -0.03, 0.205, side * 0.29));
  }
  for (const [tint, parts] of batches) mesh(group, mergeParts(parts), toonMaterial(tint), low);
  labels(group, projects, widths[type] / 2, low, colors[type]);
  return group;
}
