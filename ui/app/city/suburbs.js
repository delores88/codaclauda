/* Original modern homes for local projects. The project and its lot choose the
 * architecture (six shapes, five materials, accent doors and extras); project size
 * changes its footprint, never the number of storeys. Edge-neighbouring lots draw
 * from disjoint shape sets (architecture.js lotParity), so neighbours never match. */
import { THREE, toonMaterial, addOutline } from './toon.js';
import { hash } from '../avatar/spec.js';
import { mergeParts, placed } from './fx.js';
import { lotParity } from './architecture.js';

export const HOME_VARIANTS = ['cantilever', 'mono-pitch', 'l-ranch', 'butterfly', 'split-level', 'long-clerestory'];
const HOME_SETS = [[0, 1, 2], [3, 4, 5]];
const HOME_STOREYS = [2, 1, 1, 1, 2, 1];
// White render, warm timber cladding, charcoal panel, light brick, sage render.
export const HOME_BODY_COLORS = ['#ecebe6', '#c8956a', '#4a4f57', '#d9a58b', '#b9c9b0'];
export const HOME_DOOR_COLORS = ['#e0a03a', '#3f7fb5', '#c8553d', '#2f8f6f', '#314b61'];
export const HOME_WOOD = '#c89b6d';
export const HOME_ROOF = '#3d4350';
export const HOME_LOT_SIZE = 11.2;
const box = (w, h, d, x = 0, y = 0, z = 0) => placed(new THREE.BoxGeometry(w, h, d), { x, y, z });

/** The stable look of a home on a lot: shape, body material, roof and door colours, extras. */
export function homeLook(project, cell) {
  const id = String(project?.id || ''), lot = `${cell?.i || 0},${cell?.j || 0}`;
  const body = HOME_BODY_COLORS[hash(`homebody:${id}`) % HOME_BODY_COLORS.length];
  return {
    variant: HOME_SETS[lotParity(cell)][hash(`home:${id}:${lot}`) % 3], body,
    roof: body === '#4a4f57' ? '#c9ced2' : HOME_ROOF,
    door: HOME_DOOR_COLORS[hash(`homedoor:${id}`) % HOME_DOOR_COLORS.length],
    solar: hash(`homesolar:${id}`) % 2 === 0, balcony: hash(`homebalcony:${id}`) % 2 === 0,
  };
}

export function suburbPlan(project, cell) {
  const seed = hash(`suburb:${cell.i},${cell.j}`), look = homeLook(project, cell), variant = look.variant;
  const metrics = project.metrics || {};
  const sourceFloors = Math.max(1, Math.min(24, Math.round(Number(metrics.floors) || 1)));
  const tier = Math.max(1, Math.min(3, Math.max(Math.round(Number(metrics.footprint) || 1), Math.ceil(sourceFloors / 8))));
  const W = 6.6 + (tier - 1) * 0.9, D = 4.6 + (tier - 1) * 0.5;
  const blocks = [], add = (w, d, h, x, z, bottom = 0, garage = false, extra = {}) => { const b = { w, d, h, x, z, bottom, garage, ...extra }; blocks.push(b); return b; };
  let garage;
  if (variant === 0) {          // flat-roof box with a cantilevered upper floor
    add(W * 0.70, D, 2.05, -W * 0.13, -1);
    add(W * 0.80, D * 0.76, 1.65, -W * 0.02, -1.12, 2.05, false, { upper: true });
    garage = add(W * 0.35, D * 0.60, 1.9, W * 0.32, 0.5, 0, true);
  } else if (variant === 1) {   // mono-pitch (shed) roof rising toward the street
    add(W * 0.70, D * 0.96, 2.3, -W * 0.13, -1.05, 0, false, { roof: 'mono', rise: 0.75 });
    garage = add(W * 0.34, D * 0.60, 1.9, W * 0.33, 0.5, 0, true);
  } else if (variant === 2) {   // L-shape with a courtyard
    add(W * 0.43, D * 0.90, 2.12, -W * 0.285, -0.85);
    add(W, D * 0.52, 2.12, 0, -2);
    garage = add(W * 0.36, D * 0.62, 1.9, W * 0.32, 0.5, 0, true);
  } else if (variant === 3) {   // butterfly roof
    add(W * 0.72, D * 0.94, 2.2, -W * 0.13, -1.1, 0, false, { roof: 'butterfly', rise: 0.6 });
    garage = add(W * 0.34, D * 0.60, 1.9, W * 0.33, 0.5, 0, true);
  } else if (variant === 4) {   // split-level
    add(W * 0.58, D, 2.12, -W * 0.21, -1);
    add(W * 0.43, D * 0.70, 3.15, W * 0.285, -1.65);
    garage = add(W * 0.43, D * 0.48, 1.9, W * 0.285, 1.1, 0, true);
  } else {                      // long single storey with a clerestory
    add(W * 0.98, D * 0.62, 2.15, 0, -1.6, 0, false, { clerestory: true });
    garage = add(W * 0.34, D * 0.50, 1.9, W * 0.32, 0.75, 0, true);
  }
  const top = blocks.reduce((a, b) => b.bottom + b.h > a.bottom + a.h ? b : a);
  const entry = blocks[0], front = entry.z + entry.d / 2;
  const driveway = { x: garage.x, width: garage.w + 0.22, minZ: garage.z + garage.d / 2, maxZ: 5.85 };
  const trees = [{ x: -4.35, z: 3.65, radius: 0.73 }];
  if ((seed >>> 5) % 2) {
    const radius = 0.55;
    const x = [-0.55, -2.7, -3.0].find(candidate => Math.abs(candidate - entry.x) > radius + 0.5 && candidate + radius < driveway.x - driveway.width / 2 - 0.08 && Math.abs(candidate - trees[0].x) > radius + trees[0].radius + 0.12);
    if (x !== undefined) trees.push({ x, z: 4.55, radius });
  }
  const rise = top.rise || 0;
  return { variant, variantName: HOME_VARIANTS[variant], tier, W, D, H: top.bottom + top.h + rise, floors: HOME_STOREYS[variant],
    footprint: tier, body: look.body, roofColor: look.roof, doorColor: look.door,
    solar: look.solar && !top.roof && !top.clerestory, balcony: look.balcony && variant === 0,
    blocks, garage, top, entry, door: { x: entry.x, z: front + 0.10 }, driveway, trees, treeCount: trees.length };
}
/** Roof surface height above the block base at (dx, dz) from the block centre. */
function roofRise(b, dx, dz) {
  // A tilted 0.14 slab's top sits 0.07 / cos(slope) above its centre line.
  const lift = run => 0.07 * (1 / Math.cos(Math.atan2(b.rise, run)) - 1);
  if (b.roof === 'mono') return b.rise * Math.min(1, Math.max(0, (dz + b.d / 2) / b.d)) + lift(b.d);
  if (b.roof === 'butterfly') return b.rise * Math.min(1, Math.abs(dx) / (b.w / 2)) + lift(b.w / 2);
  return 0;
}

/** Merge static parts by material, including the owned hover/solar materials. */
class Parts {
  constructor() { this.groups = new Map(); }
  add(tint, geometry) {
    const material = typeof tint === 'string' ? toonMaterial(tint) : tint;
    if (!this.groups.has(material)) this.groups.set(material, []);
    this.groups.get(material).push(geometry);
  }
  build(parent, tag = {}, outline = 0.025) {
    const meshes = [];
    for (const [material, geometries] of this.groups) {
      const mesh = new THREE.Mesh(mergeParts(geometries), material);
      mesh.userData = { ...tag }; mesh.castShadow = true; mesh.receiveShadow = true;
      if (outline) addOutline(mesh, { thickness: outline });
      parent.add(mesh); meshes.push(mesh);
    }
    return meshes;
  }
}

export function buildSuburbHome(plan, { baseY, bodyMaterial, glassMaterial, wallLightMaterial, tag }) {
  const group = new THREE.Group(); group.name = `suburb-home:${plan.variantName}`;
  const parts = new Parts();
  const roofY = block => baseY + block.bottom + block.h + 0.14;
  const roofTint = plan.roofColor || HOME_ROOF;
  for (const b of plan.blocks) {
    parts.add(bodyMaterial, box(b.w, b.h, b.d, b.x, baseY + b.bottom + b.h / 2, b.z));
    const wallTop = baseY + b.bottom + b.h;
    if (b.roof === 'mono') {
      // Gable infill under the slope, then the sloped slab rising toward the street.
      const shape = new THREE.Shape([new THREE.Vector2(b.d / 2, 0), new THREE.Vector2(-b.d / 2, 0), new THREE.Vector2(-b.d / 2, b.rise)]);
      const fill = new THREE.ExtrudeGeometry(shape, { depth: b.w, bevelEnabled: false });
      fill.rotateY(Math.PI / 2); fill.translate(b.x - b.w / 2, wallTop, b.z);
      parts.add(bodyMaterial, fill);
      const slope = Math.atan2(b.rise, b.d), length = Math.hypot(b.d, b.rise) + 0.2;
      parts.add(roofTint, placed(new THREE.BoxGeometry(b.w + 0.16, 0.14, length), { x: b.x, y: wallTop + b.rise / 2 + 0.07, z: b.z, rx: -slope }));
    } else if (b.roof === 'butterfly') {
      for (const s of [-1, 1]) {
        const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(s * b.w / 2, 0), new THREE.Vector2(s * b.w / 2, b.rise)]);
        const fill = new THREE.ExtrudeGeometry(shape, { depth: b.d, bevelEnabled: false });
        fill.translate(b.x, wallTop, b.z - b.d / 2);
        parts.add(bodyMaterial, fill);
        const slope = Math.atan2(b.rise, b.w / 2), length = Math.hypot(b.w / 2, b.rise) + 0.12;
        parts.add(roofTint, placed(new THREE.BoxGeometry(length, 0.14, b.d + 0.16), { x: b.x + s * b.w / 4, y: wallTop + b.rise / 2 + 0.07, z: b.z, rz: s * slope }));
      }
    } else {
      parts.add(roofTint, box(b.w + 0.16, 0.14, b.d + 0.16, b.x, roofY(b) - 0.07, b.z));
    }
    if (b.clerestory) {
      const cw = b.w * 0.6, cd = b.d * 0.3, cz = b.z - b.d * 0.1, cy = roofY(b) + 0.275;
      parts.add(bodyMaterial, box(cw, 0.55, cd, b.x, cy, cz));
      parts.add(glassMaterial, box(cw - 0.12, 0.3, 0.04, b.x, cy + 0.02, cz + cd / 2 + 0.02));
      parts.add(roofTint, box(cw + 0.16, 0.1, cd + 0.16, b.x, cy + 0.325, cz));
    }
    if (b.garage) continue;
    const storeys = b.h > 3 ? 2 : 1, storyHeight = b.h / storeys;
    for (let floor = 0; floor < storeys; floor++) {
      const y = baseY + b.bottom + floor * storyHeight + storyHeight * 0.47;
      const windowH = Math.min(1.1, storyHeight * 0.54), windowW = Math.min(1.65, b.w * 0.32);
      for (const side of [-1, 1]) for (const shift of [-0.27, 0.27]) {
        const x = b.x + b.w * shift, z = b.z + side * (b.d / 2 + 0.035);
        parts.add(HOME_ROOF, box(windowW + 0.12, windowH + 0.12, 0.1, x, y, z));
        parts.add(glassMaterial, box(windowW, windowH, 0.035, x, y, z + side * 0.055));
        parts.add(HOME_ROOF, box(0.055, windowH, 0.04, x, y, z + side * 0.08));
      }
      for (const side of [-1, 1]) {
        const x = b.x + side * (b.w / 2 + 0.035);
        parts.add(HOME_ROOF, box(0.1, windowH + 0.12, Math.min(2.0, b.d * 0.55), x, y, b.z));
        parts.add(glassMaterial, box(0.035, windowH, Math.min(1.88, b.d * 0.55 - 0.12), x + side * 0.055, y, b.z));
      }
    }
  }
  const { entry, garage, door } = plan;
  const front = entry.z + entry.d / 2;
  parts.add(HOME_WOOD, box(1.12, Math.min(entry.h, 2.05), 0.10, entry.x, baseY + Math.min(entry.h, 2.05) / 2, front + 0.04));
  parts.add(HOME_WOOD, box(Math.min(1.65, entry.w * 0.65) + 0.05, 0.46, 0.10, entry.x, baseY + 1.82, front + 0.04));
  parts.add(plan.doorColor || HOME_ROOF, box(0.76, 1.55, 0.07, door.x, baseY + 0.775, door.z));
  if (plan.balcony) {
    const upper = plan.blocks.find(b => b.upper), z = upper.z + upper.d / 2;
    parts.add(roofTint, box(1.7, 0.1, 0.72, upper.x, baseY + upper.bottom + 0.05, z + 0.36));
    parts.add(glassMaterial, box(1.7, 0.5, 0.04, upper.x, baseY + upper.bottom + 0.35, z + 0.7));
  }
  parts.add('#bcc6c4', box(0.055, 0.27, 0.05, door.x + 0.25, baseY + 0.8, door.z + 0.05));
  parts.add('#c9ccca', box(1.15, 0.08, 0.5, door.x, baseY + 0.04, front + 0.25));
  const garageFront = garage.z + garage.d / 2;
  parts.add(HOME_ROOF, box(garage.w * 0.88, 1.5, 0.08, garage.x, baseY + 0.78, garageFront + 0.035));
  for (let y = 0.28; y < 1.55; y += 0.28) parts.add('#68717c', box(garage.w * 0.85, 0.025, 0.035, garage.x, baseY + y, garageFront + 0.085));
  // Compact wall sconces touch their facade; warm light is shared with day/night.
  for (const [x, z] of [[door.x + 0.69, front + 0.075], [garage.x + garage.w * 0.46, garageFront + 0.075]]) {
    parts.add(HOME_ROOF, box(0.15, 0.38, 0.14, x, baseY + 1.57, z));
    parts.add(wallLightMaterial, box(0.09, 0.23, 0.035, x, baseY + 1.57, z + 0.085));
  }
  const top = plan.top, surface = roofY(top);
  const solarMaterial = toonMaterial('#3e687a', { emissive: '#a7d5de', emissiveIntensity: 0.08, cache: false });
  if (plan.solar) {
    const sx = top.x - top.w * 0.12, sz = top.z - top.d * 0.10, sw = Math.min(1.9, top.w * 0.55), sd = Math.min(1.15, top.d * 0.48);
    parts.add('#8496a2', box(sw + 0.12, 0.08, sd + 0.12, sx, surface + 0.04, sz));
    parts.add(solarMaterial, box(sw, 0.035, sd, sx, surface + 0.095, sz));
    for (const offset of [-0.25, 0.25]) parts.add('#b1c1c6', box(0.022, 0.016, sd, sx + sw * offset, surface + 0.12, sz));
    parts.add('#b1c1c6', box(sw, 0.016, 0.022, sx, surface + 0.12, sz));
  }
  const meshes = parts.build(group, tag);
  // Sloped roofs carry the ticker on the walls below the eaves; indicators sit on the slope.
  const sloped = Boolean(top.roof), px = top.w * 0.31, pz = top.d * 0.26;
  return { group, meshes, body: meshes.find(m => m.material === bodyMaterial), solarMaterial,
    roofY: surface, roofPoint: new THREE.Vector3(top.x + px, surface + roofRise(top, px, pz), top.z + pz),
    ticker: sloped ? { W: top.w, D: top.d, x: top.x, z: top.z, y: baseY + top.bottom + top.h - 0.34, scaleY: 0.5 } : { W: top.w, D: top.d, x: top.x, z: top.z, y: surface + 0.03, scaleY: 0.58 },
    plaque: { x: door.x, y: baseY + 1.82, z: front + 0.091 }, door };
}

export function buildSuburbYard(plan, { baseY, tag, centerZ = 0.3 }) {
  const group = new THREE.Group(); group.name = 'suburb-yard';
  const parts = new Parts();
  parts.add('#a4bd83', box(HOME_LOT_SIZE, 0.12, HOME_LOT_SIZE, 0, baseY - 0.06, centerZ));
  const drive = plan.driveway;
  parts.add('#c7c9c5', box(drive.width, 0.03, drive.maxZ - drive.minZ, drive.x, baseY + 0.015, (drive.maxZ + drive.minZ) / 2));
  parts.add('#deded7', box(0.9, 0.025, drive.maxZ - plan.door.z, plan.door.x, baseY + 0.014, (drive.maxZ + plan.door.z) / 2));
  // Low horizontal-slat fence leaves both the front walk and driveway open.
  for (const x of [-5.35, 5.35]) {
    for (const z of [-5.2, -2.6, 0, 2.6, 5.2]) parts.add(HOME_ROOF, box(0.09, 0.72, 0.09, x, baseY + 0.36, z));
    for (const y of [0.24, 0.48, 0.69]) parts.add('#a9b0aa', box(0.08, 0.08, 10.4, x, baseY + y, 0));
  }
  for (const x of [-5.2, -2.6, 0, 2.6, 5.2]) parts.add(HOME_ROOF, box(0.09, 0.72, 0.09, x, baseY + 0.36, -5.2));
  for (const y of [0.24, 0.48, 0.69]) parts.add('#a9b0aa', box(10.4, 0.08, 0.08, 0, baseY + y, -5.2));
  for (const { x, z, radius } of plan.trees) {
    parts.add('#7d725a', placed(new THREE.CylinderGeometry(0.09, 0.13, 1.25, 6), { x, y: baseY + 0.625, z }));
    parts.add('#77986a', placed(new THREE.IcosahedronGeometry(radius, 1), { x, y: baseY + 1.35, z, sy: 1.1 }));
  }
  parts.build(group, tag);
  return group;
}

function beamBetween(a, b, width = 0.07) {
  const direction = b.clone().sub(a), geometry = new THREE.BoxGeometry(width, direction.length(), width);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()));
  geometry.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2); return geometry;
}

export function buildContractor(plan, { baseY, tag }) {
  const group = new THREE.Group(); group.name = 'suburb-contractor';
  const parts = new Parts(), ground = baseY + 0.03;
  const x = plan.driveway.x, z = Math.min(4.2, plan.driveway.minZ + 1.25);
  parts.add('#e8e4dc', box(1.12, 0.63, 1.72, x, ground + 0.60, z));
  parts.add('#e8e4dc', box(1.08, 0.35, 1.18, x, ground + 1.03, z - 0.20));
  parts.add('#476573', box(0.88, 0.28, 0.035, x, ground + 1.02, z + 0.41));
  parts.add('#68717c', box(1.18, 0.12, 0.12, x, ground + 0.35, z + 0.9));
  for (const side of [-1, 1]) for (const wheelZ of [-0.55, 0.55]) parts.add('#333d45', placed(new THREE.CylinderGeometry(0.22, 0.22, 0.12, 8), { x: x + side * 0.55, y: ground + 0.22, z: z + wheelZ, rz: Math.PI / 2 }));
  const amberMaterial = toonMaterial('#e6ab49', { emissive: '#ffb63d', emissiveIntensity: 0.75, cache: false });
  parts.add('#5e6670', box(0.36, 0.07, 0.18, x, ground + 1.24, z - 0.18));
  parts.add(amberMaterial, box(0.28, 0.13, 0.15, x, ground + 1.32, z - 0.18));
  const lx = plan.entry.x - plan.entry.w * 0.34, front = plan.entry.z + plan.entry.d / 2;
  const foot = new THREE.Vector3(lx, baseY + 0.01, front + 0.8), top = new THREE.Vector3(lx, baseY + 1.86, front + 0.015);
  for (const side of [-1, 1]) parts.add('#b6c0c1', beamBetween(foot.clone().add(new THREE.Vector3(side * 0.2, 0, 0)), top.clone().add(new THREE.Vector3(side * 0.2, 0, 0))));
  for (let t = 0.10; t < 0.98; t += 0.17) { const at = foot.clone().lerp(top, t); parts.add('#b6c0c1', box(0.4, 0.065, 0.065, at.x, at.y, at.z)); }
  const meshes = parts.build(group, tag, 0.018);
  group.userData.ladder = { foot: foot.toArray(), top: top.toArray() };
  return { group, meshes, amberMaterial };
}
