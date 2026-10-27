/* Opaque, district-coloured architecture and planted dry parcels. Original geometry.
 * Riverfront buildings take the shape of their plot: a straight street front and a
 * water side that follows the bank curve (river-lots.js riverfrontFootprint). */
import { THREE, toonMaterial, addOutline } from './toon.js';
import { placed, mergeParts } from './fx.js';
import { pointInParcel, clipPolygon, polygonArea, riverfrontFootprintFor } from './river-lots.js';
import { towerLook, floorsHeight, prismGeometry, offsetPolygon, stripPolygon, GF, FH } from './architecture.js';
import { homeLook } from './suburbs.js';
import { hash } from '../avatar/spec.js';

const TOP = 0.24;
const WOOD = '#c89b6d', PLANTER = '#76ac70';
function box(group, w, h, d, x, y, z, material, name, outline = 0.025) {
  const mesh = new THREE.Mesh(placed(new THREE.BoxGeometry(w, h, d), { x, y, z }), typeof material === 'string' ? toonMaterial(material) : material);
  mesh.name = name; mesh.castShadow = true; mesh.receiveShadow = true;
  if (outline) addOutline(mesh, { thickness: outline });
  group.add(mesh); return mesh;
}
function bounds(points) {
  const xs = points.map(p => p.x), zs = points.map(p => p.z);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  return { x0, x1, z0, z1, x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 };
}
/** Street edge then water edge, the order riverfrontFootprint produces. */
function footprintPolygon(foot, front, back) {
  const street = foot.side > 0 ? [{ x: foot.x1, z: front }, { x: foot.x0, z: front }] : [{ x: foot.x0, z: front }, { x: foot.x1, z: front }];
  return [...street, ...(foot.side > 0 ? back : [...back].reverse())];
}

export function riverBuildingPlan(project, parcel, district) {
  const r = parcel.rect, side = parcel.side;
  const origin = { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 };
  const local = p => ({ x: p.x - origin.x, z: p.z - origin.z });
  const tier = Math.max(1, Math.min(3, Math.round(project.metrics?.footprint || 1)));
  const sourceFloors = Math.max(1, Math.min(24, Math.round(project.metrics?.floors || 1)));
  const lot = { i: parcel.i, j: parcel.j };
  let foot = riverfrontFootprintFor(parcel, district);
  if (!foot) {   // Defensive: an eligible parcel always has room for its frontage rectangle.
    const front = side > 0 ? r.z1 - 1.3 : r.z0 + 1.3, backZ = front - side * Math.min(4, r.z1 - r.z0 - 1.6);
    const back = [{ x: r.x0 + 0.6, z: backZ }, { x: r.x1 - 0.6, z: backZ }];
    foot = { side, front, back, x0: r.x0 + 0.6, x1: r.x1 - 0.6, minDepth: Math.abs(front - backZ) };
  }
  const front = foot.front - origin.z, back = foot.back.map(local);
  const footLocal = { side, x0: foot.x0 - origin.x, x1: foot.x1 - origin.x };
  const points = footprintPolygon(footLocal, front, back);
  const tiers = [];
  let floors, H, shape, palette, storeys = 1;
  if (district === 'downtown') {
    const look = towerLook(project, lot); palette = look.palette;
    floors = Math.min(sourceFloors, 13, Math.max(1, Math.floor((foot.minDepth * 3.4 - GF) / FH) + 1));
    H = floorsHeight(floors);
    const terrace = floors >= 4 && foot.minDepth >= 4.6;
    if (terrace) {
      const lower = Math.max(2, Math.round(floors * 0.6));
      const back2 = back.map(p => ({ x: p.x, z: p.z + side * 1.6 }));
      tiers.push({ points, back, floor0: 0, floors: lower, y: 0, h: floorsHeight(lower) });
      tiers.push({ points: footprintPolygon(footLocal, front, back2), back: back2, floor0: lower, floors: floors - lower, y: floorsHeight(lower), h: H - floorsHeight(lower) });
      shape = 'curved-terrace';
    } else {
      tiers.push({ points, back, floor0: 0, floors, y: 0, h: H });
      shape = 'curved-slim';
    }
  } else {
    const look = homeLook(project, lot); palette = { body: look.body, trim: look.roof, roof: look.roof, accent: look.door, door: look.door };
    storeys = foot.x1 - foot.x0 < 7.5 ? 2 : 1;
    H = storeys === 2 ? 3.8 : 2.3; floors = storeys;
    tiers.push({ points, back, floor0: 0, floors: storeys, y: 0, h: H, storeys });
    shape = storeys === 2 ? 'curved-townhouse' : 'curved-deck-house';
  }
  const blocks = tiers.map(t => { const b = bounds(t.points); return { w: b.w, d: b.d, h: t.h, y: t.y, x: b.x, z: b.z }; });
  // The inscribed rectangle of the top tier carries the ticker and roof indicators.
  const topTier = tiers.at(-1), topBack = topTier.back.map(p => p.z);
  const coreBack = side > 0 ? Math.max(...topBack) : Math.min(...topBack);
  const core = { x: (footLocal.x0 + footLocal.x1) / 2, w: footLocal.x1 - footLocal.x0, z: (front + coreBack) / 2, d: Math.abs(front - coreBack) };
  const all = bounds(points), deck = district === 'suburbs' ? 0.85 : 0;
  const bbox = { x0: origin.x + all.x0, x1: origin.x + all.x1, z0: origin.z + all.z0 - (side > 0 ? deck : 0), z1: origin.z + all.z1 + (side < 0 ? deck : 0) };
  return { W: all.w, D: all.d, H, floors, storeys, footprint: tier, shape, tiers, blocks, core, palette, district,
    origin, side, front, entryX: core.x, streetZ: side * ((r.z1 - r.z0) / 2 - 0.3), parcel, bbox, seed: hash(`river:${project.id}`) };
}

export function buildRiverBuilding(plan, material, district, tag, glass = {}) {
  const group = new THREE.Group(); group.name = `riverfront-${plan.shape}`;
  const palette = plan.palette || {}, side = plan.side;
  const trim = palette.trim || (district === 'downtown' ? '#d6e6ef' : '#3d4350');
  const litFrac = glass.litFrac ?? 0.4;
  const walls = [], caps = [], lit = [], dark = [], trims = [], planters = [], wood = [];
  for (const t of plan.tiers) {
    walls.push(prismGeometry(t.points, TOP + t.y, t.h));
    caps.push(prismGeometry(offsetPolygon(t.points, 0.08), TOP + t.y + t.h - 0.02, 0.16));
    if (district === 'downtown') {
      for (let k = t.floor0; k < t.floor0 + t.floors; k++) {
        const base = floorsHeight(k), y = k === 0 ? base + 0.95 : base + 0.28, h = k === 0 ? 1.15 : 0.74;
        if (y + h > t.y + t.h - 0.05) continue;
        ((hash(`${plan.seed}:${k}`) % 100) / 100 < litFrac ? lit : dark).push(prismGeometry(offsetPolygon(t.points, 0.04), TOP + y, h));
        if (k > t.floor0) trims.push(prismGeometry(offsetPolygon(t.points, 0.06), TOP + base - 0.05, 0.1));
      }
    } else {
      const storey = t.h / (t.storeys || 1);
      for (let k = 0; k < (t.storeys || 1); k++) {
        ((hash(`${plan.seed}:${k}`) % 100) / 100 < litFrac + 0.2 ? lit : dark).push(prismGeometry(offsetPolygon(t.points, 0.04), TOP + k * storey + 0.72, Math.min(0.9, storey - 1.0)));
        if (k > 0) wood.push(prismGeometry(offsetPolygon(t.points, 0.06), TOP + k * storey - 0.06, 0.12));
      }
    }
    // Planted water-facing edge on each roof: the terrace and the rooftop deck.
    if (district === 'downtown') planters.push(prismGeometry(stripPolygon(t.back, 0.45, { x: 0, z: side }), TOP + t.y + t.h + 0.14, 0.3));
  }
  if (district === 'suburbs') {
    // A curved timber deck along the bank, with posts and a rail on its outer edge.
    const tier0 = plan.tiers[0], outer = tier0.back.map(p => ({ x: p.x, z: p.z - side * 0.85 }));
    wood.push(prismGeometry(stripPolygon(tier0.back, 0.85, { x: 0, z: -side }), TOP, 0.12));
    wood.push(prismGeometry(stripPolygon(outer, 0.07, { x: 0, z: side }), TOP + 0.64, 0.07));
    for (let n = 0; n < outer.length; n += 2) wood.push(placed(new THREE.BoxGeometry(0.07, 0.6, 0.07), { x: outer[n].x, y: TOP + 0.37, z: outer[n].z + side * 0.04 }));
  }
  const mesh = (list, mat, name, outline = 0.03) => {
    if (!list.length) return null;
    const geometry = mergeParts(list); geometry.clearGroups();
    const m = new THREE.Mesh(geometry, typeof mat === 'string' ? toonMaterial(mat) : mat);
    m.name = name; m.castShadow = true; m.receiveShadow = true;
    if (outline) addOutline(m, { thickness: outline });
    group.add(m); return m;
  };
  mesh(walls, material, 'riverfront-wall', 0.04);
  mesh(caps, palette.roof || trim, 'riverfront-roof');
  mesh(lit, glass.lit || '#a9cddd', 'riverfront-window', 0);
  mesh(dark, glass.dark || '#7899b0', 'riverfront-window-dark', 0);
  mesh(trims, trim, 'riverfront-floor-trim', 0);
  mesh(planters, PLANTER, 'water-facing-terrace');
  mesh(wood, WOOD, district === 'suburbs' ? 'water-facing-deck' : 'riverfront-timber');
  const doorZ = plan.front + side * 0.06;
  box(group, 0.85, 1.65, 0.09, plan.entryX, TOP + 0.825, doorZ, palette.door || '#314b61', 'riverfront-door');
  if (district === 'downtown') box(group, 1.9, 0.09, 0.7, plan.entryX, TOP + 1.84, plan.front + side * 0.35, palette.accent || '#3f7fb5', 'riverfront-canopy');
  group.traverse(node => { if (node.isMesh) Object.assign(node.userData, tag); });
  return group;
}

/** Every dry polygon gets lawn; small remnants get a path, bench and reeds when
 * those individual footprints fit. Geometry never crosses into the excluded bank. */
export function buildRiverLandscape(parcel, { origin = { x: 0, z: 0 }, building = null } = {}) {
  const group = new THREE.Group(); group.name = 'riverfront-landscape'; group.userData.parcel = parcel;
  for (const polygon of parcel.polygons) {
    // Narrow strips follow the curved edge without long triangles spanning a
    // bend; each rendered triangle's complete footprint clears the bank too.
    const strips = [];
    for (let x = parcel.bounds.x0; x < parcel.bounds.x1; x += 0.5) {
      const piece = clipPolygon(clipPolygon(polygon, 'x', x, true), 'x', Math.min(x + 0.5, parcel.bounds.x1), false);
      if (polygonArea(piece) < 1e-8) continue;
      const shape = new THREE.Shape(piece.map(p => new THREE.Vector2(p.x - origin.x, -(p.z - origin.z))));
      strips.push(new THREE.ShapeGeometry(shape));
    }
    if (!strips.length) continue;
    const geometry = mergeParts(strips); geometry.rotateX(-Math.PI / 2); geometry.translate(0, TOP - 0.04, 0);
    const lawn = new THREE.Mesh(geometry, toonMaterial('#8aca70')); lawn.receiveShadow = true; lawn.name = 'riverfront-lawn'; group.add(lawn);
  }
  const fits = (x, z, hx, hz) => [-1, 1].every(dx => [-1, 1].every(dz => pointInParcel({ x: x + dx * hx, z: z + dz * hz }, parcel)));
  const r = parcel.rect;
  if (r) {
    const x = (r.x0 + r.x1) / 2, z = parcel.side > 0 ? r.z1 - 0.35 : r.z0 + 0.35;
    if (fits(x, z, (r.x1 - r.x0) / 2 - 0.15, 0.24)) box(group, r.x1 - r.x0 - 0.3, 0.04, 0.48, x - origin.x, TOP, z - origin.z, '#f1e6ce', 'riverfront-path', 0);
  }
  if (r && r.z1 - r.z0 > 1.3) {
    const x = (r.x0 + r.x1) / 2, z = parcel.side > 0 ? r.z0 + 0.3 : r.z1 - 0.3;
    if (fits(x, z, (r.x1 - r.x0) / 2 - 0.15, 0.19)) box(group, r.x1 - r.x0 - 0.3, 0.035, 0.38, x - origin.x, TOP, z - origin.z, '#e9ddc4', 'riverside-path', 0);
  }
  let bench = false, planted = 0;
  for (let x = parcel.bounds.x0 + 0.65; x < parcel.bounds.x1 - 0.5; x += 1.65) {
    for (let z = parcel.bounds.z0 + 0.6; z < parcel.bounds.z1 - 0.5; z += 1.6) {
      if (!fits(x, z, 0.5, 0.4)) continue;
      if (building?.bbox && x > building.bbox.x0 - 0.75 && x < building.bbox.x1 + 0.75 && z > building.bbox.z0 - 0.9 && z < building.bbox.z1 + 0.9) continue;
      if (building && !building.bbox && Math.abs(x - building.origin.x) < building.W / 2 + 0.75 && Math.abs(z - building.origin.z) < building.D / 2 + 0.9) continue;
      if (r && Math.abs(z - (parcel.side > 0 ? r.z1 : r.z0)) < 0.9) continue;
      const lx = x - origin.x, lz = z - origin.z;
      if (!bench) {
        box(group, 0.9, 0.1, 0.45, lx, TOP + 0.4, lz, '#c89b6d', 'riverfront-bench');
        box(group, 0.9, 0.36, 0.08, lx, TOP + 0.62, lz + parcel.side * 0.2, '#c89b6d', 'riverfront-bench-back');
        for (const dx of [-0.3, 0.3]) box(group, 0.08, 0.4, 0.32, lx + dx, TOP + 0.2, lz, '#526a60', 'bench-leg');
        bench = true;
      } else if (!pointInParcel({ x, z: z - parcel.side * 1.25 }, parcel)) {
        for (const dx of [-0.15, 0.08, 0.22]) box(group, 0.06, 0.4 + dx, 0.06, lx + dx, TOP + (0.4 + dx) / 2, lz, '#6b9e55', 'riverfront-reeds', 0);
      } else if (planted < 6 && (Math.abs(x - parcel.bounds.x0) < 1.5 || Math.abs(x - parcel.bounds.x1) < 1.5)) {
        const shrub = new THREE.Mesh(placed(new THREE.IcosahedronGeometry(0.32, 1), { x: lx, y: TOP + 0.25, z: lz, sy: 0.8 }), toonMaterial('#5b9f66'));
        shrub.name = 'riverfront-shrub'; addOutline(shrub, { thickness: 0.02 }); group.add(shrub);
        const flower = new THREE.Mesh(placed(new THREE.IcosahedronGeometry(0.12, 0), { x: lx + 0.12, y: TOP + 0.5, z: lz }), toonMaterial(planted % 2 ? '#ffd23f' : '#ff9db9'));
        flower.name = 'riverfront-flowers'; group.add(flower); planted++;
      }
    }
  }
  group.traverse(node => { if (node.isMesh) node.raycast = () => {}; });
  return group;
}
