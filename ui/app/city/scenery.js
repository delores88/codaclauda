/* Static-ish scenery for the project city: the floating island, road network,
 * lot lawns and sidewalks, trees/flowers/benches/lamps, the HQ plaza and the sky.
 * Builders return plain groups; world.js owns lifetime and lighting. */
import { THREE, toonMaterial, addOutline } from './toon.js';
import { RoundedBoxGeometry } from '../../vendor/three/addons/RoundedBoxGeometry.js';
import { hash } from '../avatar/spec.js';
import { mergeParts, placed, instancedOutline, plaqueTexture, clockTexture, sideTexture } from './fx.js';
import { PITCH, ASPHALT, LOT_HALF, islandHalf, cellCenter } from './layout.js';

export const PALETTE = {
  grass: '#93d46c', grassSide: '#7cc25a', lawn: '#9ddb74', dirt: '#bf8a5a', dirtDark: '#9c6b45', stone: '#a3aac6', stoneDark: '#858ca9',
  road: '#5f6684', sidewalk: '#f1e8d6', dash: '#fff1bd', plaza: '#f5e7cf', plazaRing: '#e9d3ae', root: '#7a5536', water: '#79d9ea',
};
const LAWN_TOP = 0.14, SIDEWALK_TOP = 0.2, ROAD_TOP = 0.07;
export const GROUND_Y = LAWN_TOP;

/** Seeded random in [0, 1) from text. */
export function seeded(text) { let s = hash(text) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; }; }
const rbox = (w, h, d, r = 0.15, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, r);
function mesh(geometry, material, { cast = true, receive = true, outline = 0.05 } = {}) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = cast; m.receiveShadow = receive;
  if (outline) addOutline(m, { thickness: outline });
  return m;
}

/* ---------- island ---------- */
/** The island's slabs, rim and (Spark side off) its tapering rock underside. The rim stays clean:
 *  grass top, layered soil edge, nothing dangling or floating. */
export function buildIsland(rings) {
  const half = islandHalf(rings), size = half * 2;
  const group = new THREE.Group(); group.name = 'island';
  const rnd = seeded(`island:${rings}`);
  // The three slabs block picking (a hover never reaches through the island to the other side).
  // The grass slab casts: once the island is turned over it shades the face that is now down.
  const slab = (...args) => { const m = mesh(...args); m.userData.occluder = true; return m; };
  group.add(slab(placed(rbox(size, 1.0, size, 1.6, 3), { y: -0.5 }), toonMaterial(PALETTE.grass), { cast: true, outline: 0.09 }));
  group.add(slab(placed(rbox(size - 0.9, 2.8, size - 0.9, 1.4, 2), { y: -2.1 }), toonMaterial(PALETTE.dirt), { cast: false, receive: false, outline: 0.09 }));
  group.add(slab(placed(rbox(size - 4, 3.4, size - 4, 1.4, 2), { y: -4.9 }), toonMaterial(PALETTE.stone), { cast: false, receive: false, outline: 0.09 }));
  // Tapering underside: a stack of stone chunks.
  const chunks = [[0.66, -7.6, 2.4], [0.42, -9.8, 2.2], [0.2, -11.8, 2]];
  for (const [k, y, h] of chunks) {
    const w = size * k * (0.9 + rnd() * 0.15), d = size * k * (0.9 + rnd() * 0.15);
    const chunk = mesh(placed(rbox(w, h, d, 1, 2), { x: (rnd() - 0.5) * 3, y, z: (rnd() - 0.5) * 3, ry: (rnd() - 0.5) * 0.3 }), toonMaterial(k < 0.3 ? PALETTE.stoneDark : PALETTE.stone), { cast: false, receive: false, outline: 0.08 });
    chunk.userData.taper = true;   // hidden while the Spark city hangs underneath
    group.add(chunk);
  }
  // Grass overhang drips along the rim (instanced).
  const drip = rbox(1, 1, 1, 0.3, 1);
  const perSide = Math.max(6, Math.round(size / 3.2));
  const drips = new THREE.InstancedMesh(drip, toonMaterial(PALETTE.grassSide, { cache: false }), perSide * 4);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
  let n = 0;
  for (let side = 0; side < 4; side++) for (let k = 0; k < perSide; k++) {
    const t = -half + 1.6 + (k + 0.5) * ((size - 3.2) / perSide);
    const out = half - 0.12, h = 0.7 + rnd() * 0.9;
    const [x, z, ry] = side === 0 ? [t, out, 0] : side === 1 ? [out, -t, Math.PI / 2] : side === 2 ? [-t, -out, 0] : [-out, t, Math.PI / 2];
    m4.compose(v.set(x, -0.7 - h / 2 + 0.3, z), q.setFromEuler(new THREE.Euler(0, ry, 0)), s.set(1.7 + rnd() * 1.6, h, 0.55));
    drips.setMatrixAt(n++, m4);
  }
  drips.count = n; drips.userData.noOutline = true;
  group.add(drips, instancedOutline(drips, 0.05));
  // "THIS PC" emblem on the front rim (shown while the Spark side exists, so you know which face is up).
  const sign = buildSideSign(sideTexture('pc'), { board: '#fff1de', post: '#9a6a45' });
  sign.position.set(0, 0, (rings + 0.5) * PITCH + 3.4);
  sign.userData.sideSign = true;
  group.add(sign);
  return { group, half };
}

/** A small standing sign for one face of the island (texture from fx.sideTexture). It faces +z,
 *  leans back a little toward a camera looking down, and never takes part in picking. */
export function buildSideSign(texture, { board = '#fff1de', post = '#8a6a4a', width = 7.4 } = {}) {
  const group = new THREE.Group(); group.name = 'side-sign';
  const height = width / 4, base = 1.0, lean = -0.24;
  const postH = base + height * 0.55;
  group.add(mesh(mergeParts([-1, 1].map(s => placed(new THREE.CylinderGeometry(0.1, 0.13, postH, 8), { x: s * width * 0.36, y: postH / 2, z: -0.16 }))), toonMaterial(post), { receive: false, outline: 0.03 }));
  const panel = new THREE.Group(); panel.position.y = base + height / 2; panel.rotation.x = lean; group.add(panel);
  panel.add(mesh(rbox(width + 0.34, height + 0.34, 0.2, 0.12), toonMaterial(board), { outline: 0.05 }));
  const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, transparent: true }));
  face.position.z = 0.112; face.userData.noOutline = true;
  panel.add(face);
  group.traverse(node => { if (node.isMesh) node.raycast = () => {}; });
  return group;
}

/* ---------- roads, sidewalks, lawns, lamps ---------- */
export function buildRoads(rings, { districts = false } = {}) {
  const group = new THREE.Group(); group.name = 'roads';
  const extent = (rings + 0.5) * PITCH;
  const asphalt = mesh(placed(rbox(extent * 2 + ASPHALT, 0.12, extent * 2 + ASPHALT, 1.2, 2), { y: ROAD_TOP - 0.06 }), toonMaterial(PALETTE.road), { cast: false, outline: 0.05 });
  group.add(asphalt);
  const walks = [], lawns = [], paved = [];
  const outer = PITCH / 2 - ASPHALT / 2, inner = LOT_HALF, band = outer - inner;
  for (let i = -rings; i <= rings; i++) for (let j = -rings; j <= rings; j++) {
    const { x, z } = cellCenter(i, j);
    const mid = (outer + inner) / 2;
    walks.push(placed(new THREE.BoxGeometry(outer * 2, SIDEWALK_TOP, band), { x, y: SIDEWALK_TOP / 2, z: z + mid }));
    walks.push(placed(new THREE.BoxGeometry(outer * 2, SIDEWALK_TOP, band), { x, y: SIDEWALK_TOP / 2, z: z - mid }));
    walks.push(placed(new THREE.BoxGeometry(band, SIDEWALK_TOP, inner * 2), { x: x + mid, y: SIDEWALK_TOP / 2, z }));
    walks.push(placed(new THREE.BoxGeometry(band, SIDEWALK_TOP, inner * 2), { x: x - mid, y: SIDEWALK_TOP / 2, z }));
    (districts && j < 0 ? paved : lawns).push(placed(new THREE.BoxGeometry(inner * 2, LAWN_TOP, inner * 2), { x, y: LAWN_TOP / 2, z }));
  }
  group.add(mesh(mergeParts(walks), toonMaterial(PALETTE.sidewalk), { cast: false, outline: 0 }));
  group.add(mesh(mergeParts(lawns), toonMaterial(PALETTE.lawn), { cast: false, outline: 0 }));
  if (paved.length) group.add(mesh(mergeParts(paved), toonMaterial('#d4dee0'), { cast: false, outline: 0 }));

  // Dashed centre lines between intersections.
  const dashes = [];
  for (let k = -rings - 1; k <= rings; k++) {
    const line = (k + 0.5) * PITCH;
    for (let seg = -rings; seg <= rings; seg++) {
      const centre = seg * PITCH;
      for (let d = -3; d <= 3; d++) {
        const along = centre + d * 1.6;
        dashes.push([line, along, true]);
        if (!districts || k !== -1) dashes.push([along, line, false]);
      }
    }
  }
  const dashMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.02, 0.8), toonMaterial(PALETTE.dash, { cache: false }), dashes.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), qr = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
  dashes.forEach(([x, z, vert], index) => { m4.compose(v.set(x, ROAD_TOP + 0.01, z), vert ? q.identity() : qr, one); dashMesh.setMatrixAt(index, m4); });
  dashMesh.receiveShadow = true; dashMesh.userData.noOutline = true;
  group.add(dashMesh);

  // Lamp posts: two per block along the curb; heads glow at night.
  const lampSpots = [];
  for (let i = -rings; i <= rings; i++) for (let j = -rings; j <= rings; j++) {
    const { x, z } = cellCenter(i, j);
    lampSpots.push([x - 3.2, z + 6.42], [x + 6.42, z + 2.8]);
  }
  const poles = new THREE.InstancedMesh(placed(new THREE.CylinderGeometry(0.07, 0.1, 2.6, 6), { y: 1.3 }), toonMaterial('#3f4560', { cache: false }), lampSpots.length);
  const heads = new THREE.InstancedMesh(placed(new THREE.SphereGeometry(0.24, 12, 8), { y: 2.75 }), lampMaterial(), lampSpots.length);
  const glow = [];
  lampSpots.forEach(([x, z], index) => {
    m4.compose(v.set(x, SIDEWALK_TOP, z), q.identity(), one);
    poles.setMatrixAt(index, m4); heads.setMatrixAt(index, m4);
    glow.push(x, SIDEWALK_TOP + 2.75, z);
  });
  poles.castShadow = true; poles.userData.noOutline = true; heads.userData.noOutline = true;
  group.add(poles, instancedOutline(poles, 0.03), heads);
  const glowGeometry = new THREE.BufferGeometry();
  glowGeometry.setAttribute('position', new THREE.Float32BufferAttribute(glow, 3));
  const glowPoints = new THREE.Points(glowGeometry, glowMaterial());
  glowPoints.renderOrder = 4;
  group.add(glowPoints);
  return { group, glow: glowPoints };
}
let lampMat = null;
export function lampMaterial() {
  if (!lampMat) { lampMat = toonMaterial('#fff4cf', { emissive: '#ffcf6b', emissiveIntensity: 0.1, cache: false }); lampMat.userData.shared = true; }
  return lampMat;
}
let glowTex = null;
export function glowTexture() {
  if (glowTex) return glowTex;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,240,200,1)'); grad.addColorStop(0.35, 'rgba(255,210,120,.45)'); grad.addColorStop(1, 'rgba(255,200,100,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(canvas); glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}
let glowMat = null;
export function glowMaterial() {
  if (!glowMat) {
    glowMat = new THREE.PointsMaterial({ size: 3.4, map: glowTexture(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, color: '#ffd98a' });
    glowMat.userData.shared = true;
  }
  return glowMat;
}

/* ---------- trees, flowers, benches, parks ---------- */
const CANOPY = ['#6fcf7f', '#8bd96b', '#4fbf8a', '#a5e07a', '#ffb3c7', '#ffc36b', '#7fd6b4'];
const FLOWERS = ['#ff7a9c', '#ffd23f', '#b98bff', '#ff9a5c', '#ffffff', '#6fb8ff'];
export const BENCH_OFFSET = { x: 4.0, z: 4.85 };   // lot bench, relative to lot centre (faces +z)

/** Seats on the bench of lot (i, j). */
export function lotSeats(i, j) {
  const c = cellCenter(i, j);
  return [{ x: c.x + BENCH_OFFSET.x - 0.42, z: c.z + BENCH_OFFSET.z, fx: 0, fz: 1 }, { x: c.x + BENCH_OFFSET.x + 0.42, z: c.z + BENCH_OFFSET.z, fx: 0, fz: 1 }];
}
let benchGeo = null;
export function benchGeometry() {
  if (!benchGeo) {
    benchGeo = mergeParts([
      placed(rbox(1.7, 0.12, 0.55, 0.05, 1), { y: 0.46 }),
      placed(rbox(1.7, 0.42, 0.1, 0.05, 1), { y: 0.78, z: -0.25, rx: -0.12 }),
      placed(new THREE.BoxGeometry(0.1, 0.42, 0.45), { x: -0.7, y: 0.21 }),
      placed(new THREE.BoxGeometry(0.1, 0.42, 0.45), { x: 0.7, y: 0.21 }),
    ]);
    benchGeo.userData.shared = true;
  }
  return benchGeo;
}

/** Small urban gardens belong to vacant lots only. Lot coordinates, rather than the
 * island's current size, seed the plan so expansion never reshuffles a plaza. */
export function downtownPlazaPlan(i, j, occupied = false) {
  if (occupied) return { variant: 0, planters: [], benches: [[BENCH_OFFSET.x, BENCH_OFFSET.z, 0]], fountain: false };
  const value = hash(`plaza:${i},${j}`), variant = value % 4;
  const corners = [[-3.55, -3.55], [3.55, 3.55], [3.55, -3.55], [-3.55, 3.55]];
  const start = (value >>> 3) % corners.length, count = variant % 2 ? 2 : 3;
  const planters = Array.from({ length: count }, (_, n) => {
    const [x, z] = corners[(start + n) % corners.length];
    return { x, z, scale: 0.62 + ((value >>> (n + 5)) % 4) * 0.035 };
  });
  const benches = [[BENCH_OFFSET.x, BENCH_OFFSET.z, 0]];
  if (variant % 2 === 0) benches.push([-4.55, 0, Math.PI / 2]);
  return { variant, planters, benches, fountain: variant === 0 };
}

/** All plaza hardscape shares a handful of merged draws. Trees and benches use the
 * city's existing instance batches; occupied lots get no new building obstruction. */
function addDowntownPlazas(group, plazas) {
  if (!plazas.length) return;
  const urban = new THREE.Group(); urban.name = 'downtown-plazas'; group.add(urban);
  const paving = [[], []], joints = [], stone = [], soil = [], water = [];
  for (const { x, z, plan } of plazas) {
    paving[plan.variant % 2].push(placed(new THREE.BoxGeometry(9.1, 0.018, 9.1), { x, y: LAWN_TOP + 0.01, z }));
    for (const offset of [-4.5, -2.25, 0, 2.25, 4.5]) {
      joints.push(placed(new THREE.BoxGeometry(0.035, 0.012, 9.1), { x: x + offset, y: LAWN_TOP + 0.026, z }));
      joints.push(placed(new THREE.BoxGeometry(9.1, 0.012, 0.035), { x, y: LAWN_TOP + 0.026, z: z + offset }));
    }
    for (const planter of plan.planters) {
      const px = x + planter.x, pz = z + planter.z;
      stone.push(placed(new THREE.BoxGeometry(1.45, 0.48, 1.45), { x: px, y: LAWN_TOP + 0.24, z: pz }));
      soil.push(placed(new THREE.BoxGeometry(1.19, 0.03, 1.19), { x: px, y: LAWN_TOP + 0.477, z: pz }));
    }
    if (plan.fountain) {
      // A compact two-tier fountain: supported bowls and short water falls, all
      // inside the vacant plot. Static water also respects reduced motion.
      stone.push(placed(new THREE.CylinderGeometry(1.55, 1.65, 0.28, 16), { x, y: LAWN_TOP + 0.18, z }));
      stone.push(placed(new THREE.CylinderGeometry(0.19, 0.25, 0.66, 10), { x, y: LAWN_TOP + 0.64, z }));
      stone.push(placed(new THREE.CylinderGeometry(0.67, 0.3, 0.25, 16), { x, y: LAWN_TOP + 1.03, z }));
      water.push(placed(new THREE.CylinderGeometry(1.37, 1.37, 0.035, 16), { x, y: LAWN_TOP + 0.33, z }));
      water.push(placed(new THREE.CylinderGeometry(0.59, 0.59, 0.025, 16), { x, y: LAWN_TOP + 1.16, z }));
      for (const [dx, dz] of [[-0.62, 0], [0.62, 0], [0, -0.62], [0, 0.62]]) water.push(placed(new THREE.CylinderGeometry(0.055, 0.075, 0.82, 6), { x: x + dx, y: LAWN_TOP + 0.75, z: z + dz }));
    }
  }
  for (const [parts, tint, cast] of [[paving[0], '#e5ecea', false], [paving[1], '#dce6e7', false], [joints, '#bccacc', false], [stone, '#a0b5b6', true], [soil, '#65786a', false], [water, '#72cbd3', false]]) {
    if (parts.length) urban.add(mesh(mergeParts(parts), toonMaterial(tint), { cast, receive: true, outline: 0 }));
  }
}

/** lots: Map(cellKey → { i, j, padW, padD, cz }) for occupied lots. */
export function buildDecor(rings, lots, half, { districts = false } = {}) {
  const group = new THREE.Group(); group.name = 'decor';
  const trees = [], flowers = [], benches = [], ponds = [], plazas = [];
  const rnd = seeded(`decor:${rings}`);
  const occupied = new Set([...lots.values()].map(l => `${l.i},${l.j}`));
  for (let i = -rings; i <= rings; i++) for (let j = -rings; j <= rings; j++) {
    if (i === 0 && j === 0) continue;
    const c = cellCenter(i, j), r = seeded(`lot:${i},${j}`);
    // Downtown's empty plots are small paved plazas. Their planters stay well
    // inside the lot, with clear crossings and no growth toward the railway.
    if (districts && j < 0) {
      const hasBuilding = occupied.has(`${i},${j}`), plan = downtownPlazaPlan(i, j, hasBuilding);
      for (const [x, z, ry] of plan.benches) benches.push([c.x + x, c.z + z, ry]);
      if (!hasBuilding) {
        plazas.push({ ...c, plan });
        for (const p of plan.planters) trees.push({ x: c.x + p.x, y: LAWN_TOP + 0.49, z: c.z + p.z, kind: 'ball', scale: p.scale, color: ['#65b691', '#7cc5a3', '#8abd86'][plan.variant % 3] });
      }
      continue;
    }
    if (!occupied.has(`${i},${j}`)) {
      // Park: a pond sometimes, trees, flowers.
      const spots = [];
      const free = (x, z, min) => spots.every(s => Math.hypot(s[0] - x, s[1] - z) > min);
      if (r() < 0.34) { const px = (r() - 0.5) * 3, pz = (r() - 0.5) * 3; ponds.push([c.x + px, c.z + pz, 1.4 + r() * 0.6]); spots.push([px, pz, 2.6]); }
      for (let n = 0, tries = 0; n < 6 && tries < 40; tries++) {
        const x = (r() - 0.5) * 9, z = (r() - 0.5) * 9;
        if (!spots.every(s => Math.hypot(s[0] - x, s[1] - z) > (s[2] || 1.9))) continue;
        spots.push([x, z]); trees.push({ x: c.x + x, z: c.z + z, kind: r() < 0.55 ? 'ball' : 'cone', scale: 0.8 + r() * 0.5, color: CANOPY[Math.floor(r() * CANOPY.length)] }); n++;
      }
      for (let n = 0; n < 2; n++) { const x = (r() - 0.5) * 8, z = (r() - 0.5) * 8; if (free(x, z, 1.2)) flowers.push({ x: c.x + x, z: c.z + z, seed: `${i},${j},${n}` }); }
    } else {
      const lot = lots.get(`${i},${j}`);
      const hw = lot.padW / 2, zf = lot.cz + lot.padD / 2, zb = lot.cz - lot.padD / 2;
      for (const sx of [-1, 1]) {
        if (hw < 3.9 && zb > -3.9) trees.push({ x: c.x + sx * 4.6, z: c.z - 4.6, kind: r() < 0.5 ? 'ball' : 'cone', scale: 0.75 + r() * 0.3, color: CANOPY[Math.floor(r() * CANOPY.length)] });
      }
      if (hw < 4.2 && zf < 4.0) flowers.push({ x: c.x - 4.3, z: c.z + 4.7, seed: `${i},${j},f` });
      benches.push([c.x + BENCH_OFFSET.x, c.z + BENCH_OFFSET.z, 0]);
    }
  }
  // Rim trees outside the ring road, rooted on the grass slab (y = 0); the front rim keeps room for the THIS PC sign.
  const ring = (rings + 0.5) * PITCH + 3.4;
  for (let side = 0; side < 4; side++) {
    for (let t = -ring + 2; t < ring - 2; t += 4.2 + rnd() * 2.5) {
      if (rnd() < 0.3) continue;
      const [x, z] = side === 0 ? [t, ring] : side === 1 ? [ring, -t] : side === 2 ? [-t, -ring] : [-ring, t];
      if (Math.abs(x) > half - 1.2 || Math.abs(z) > half - 1.2) continue;
      if (districts && (z < -8 || Math.abs(z + 8) < 3.5)) continue;
      if (side === 0 && Math.abs(t) < 5.6) continue;
      trees.push({ x: x + (rnd() - 0.5), y: 0, z: z + (rnd() - 0.5), kind: rnd() < 0.7 ? 'cone' : 'ball', scale: 0.8 + rnd() * 0.5, color: CANOPY[Math.floor(rnd() * 4)] });
    }
  }
  addDowntownPlazas(group, plazas);
  addTrees(group, trees);
  addFlowers(group, flowers);
  if (benches.length) {
    const inst = new THREE.InstancedMesh(benchGeometry(), toonMaterial('#c98a55', { cache: false }), benches.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
    benches.forEach(([x, z, ry], k) => { m4.compose(v.set(x, LAWN_TOP, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), one); inst.setMatrixAt(k, m4); });
    inst.castShadow = true; inst.receiveShadow = true; inst.userData.noOutline = true;
    group.add(inst, instancedOutline(inst, 0.03));
  }
  for (const [x, z, r] of ponds) {
    group.add(mesh(placed(new THREE.CylinderGeometry(r + 0.25, r + 0.35, 0.16, 24), { x, y: LAWN_TOP + 0.06, z }), toonMaterial('#e7dcc6'), { cast: false, outline: 0.03 }));
    group.add(mesh(placed(new THREE.CylinderGeometry(r, r, 0.08, 24), { x, y: LAWN_TOP + 0.12, z }), toonMaterial(PALETTE.water, { emissive: '#2aa7c4', emissiveIntensity: 0.15 }), { cast: false, outline: 0 }));
    for (let k = 0; k < 3; k++) { const a = k * 2.1 + x, rr = r * 0.55; group.add(mesh(placed(new THREE.CylinderGeometry(0.22, 0.22, 0.03, 10), { x: x + Math.cos(a) * rr, y: LAWN_TOP + 0.18, z: z + Math.sin(a) * rr }), toonMaterial('#5fbf6a'), { cast: false, outline: 0 })); }
  }
  // Scenery is decoration; the City's ground/lot picker owns empty-plot clicks.
  group.traverse(node => { if (node.isMesh) node.raycast = () => {}; });
  return group;
}

const trunkGeo = placed(new THREE.CylinderGeometry(0.13, 0.2, 1.1, 6), { y: 0.55 }); trunkGeo.userData.shared = true;
const ballGeo = placed(new THREE.IcosahedronGeometry(0.95, 1), { y: 1.75 }); ballGeo.userData.shared = true;
const coneGeo = mergeParts([placed(new THREE.ConeGeometry(0.95, 1.5, 7), { y: 1.55 }), placed(new THREE.ConeGeometry(0.72, 1.2, 7), { y: 2.25 })]); coneGeo.userData.shared = true;
const color = new THREE.Color();
export function addTrees(group, trees) {
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
  const trunks = new THREE.InstancedMesh(trunkGeo, toonMaterial('#9a6a45', { cache: false }), Math.max(1, trees.length));
  const balls = trees.filter(t => t.kind === 'ball'), cones = trees.filter(t => t.kind === 'cone');
  const ballMesh = new THREE.InstancedMesh(ballGeo, toonMaterial('#ffffff', { cache: false }), Math.max(1, balls.length));
  const coneMesh = new THREE.InstancedMesh(coneGeo, toonMaterial('#ffffff', { cache: false }), Math.max(1, cones.length));
  trees.forEach((t, k) => { m4.compose(v.set(t.x, t.y ?? LAWN_TOP, t.z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (t.x * 7 + t.z * 3) % 6), s.setScalar(t.scale)); trunks.setMatrixAt(k, m4); });
  for (const [list, inst] of [[balls, ballMesh], [cones, coneMesh]]) {
    list.forEach((t, k) => {
      m4.compose(v.set(t.x, t.y ?? LAWN_TOP, t.z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (t.x * 5 + t.z) % 6), s.setScalar(t.scale));
      inst.setMatrixAt(k, m4); inst.setColorAt(k, color.set(t.color));
    });
    inst.count = list.length;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  }
  trunks.count = trees.length;
  for (const inst of [trunks, ballMesh, coneMesh]) { inst.castShadow = true; inst.receiveShadow = true; inst.userData.noOutline = true; inst.userData.tree = true; group.add(inst, instancedOutline(inst, 0.045)); }   // tree: wind sway (city/weather.js)
}
const petalGeo = new THREE.IcosahedronGeometry(0.14, 0); petalGeo.userData.shared = true;
const moundGeo = placed(new THREE.SphereGeometry(0.75, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), { sy: 0.35 }); moundGeo.userData.shared = true;
export function addFlowers(group, patches) {
  if (!patches.length) return;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const mounds = new THREE.InstancedMesh(moundGeo, toonMaterial('#6cc35e', { cache: false }), patches.length);
  const petals = new THREE.InstancedMesh(petalGeo, toonMaterial('#ffffff', { cache: false }), patches.length * 7);
  let n = 0;
  patches.forEach((p, k) => {
    m4.compose(v.set(p.x, LAWN_TOP, p.z), q.identity(), one); mounds.setMatrixAt(k, m4);
    const r = seeded(p.seed), tint = FLOWERS[Math.floor(r() * FLOWERS.length)];
    for (let f = 0; f < 7; f++) {
      const a = f / 7 * Math.PI * 2 + r(), rr = 0.15 + r() * 0.45;
      m4.compose(v.set(p.x + Math.cos(a) * rr, LAWN_TOP + 0.25, p.z + Math.sin(a) * rr), q.identity(), one);
      petals.setMatrixAt(n, m4); petals.setColorAt(n, color.set(r() < 0.7 ? tint : FLOWERS[Math.floor(r() * FLOWERS.length)])); n++;
    }
  });
  petals.count = n; if (petals.instanceColor) petals.instanceColor.needsUpdate = true;
  mounds.receiveShadow = true; mounds.userData.noOutline = true; petals.userData.noOutline = true;
  group.add(mounds, instancedOutline(mounds, 0.03), petals);
}

/* ---------- HQ plaza ---------- */
export const HQ = {
  owner: { x: 0, z: 4.35 },
  seats: [
    ...[[-3.7, 1.5], [-3.7, 3.5]].flatMap(([x, z]) => [{ x, z: z - 0.42, fx: 1, fz: 0 }, { x, z: z + 0.42, fx: 1, fz: 0 }]),
    ...[[3.7, 1.5], [3.7, 3.5]].flatMap(([x, z]) => [{ x, z: z - 0.42, fx: -1, fz: 0 }, { x, z: z + 0.42, fx: -1, fz: 0 }]),
  ],
  work: [0, -1.45, 1.45, -2.9, 2.9].map(x => ({ x, z: 0.45, fx: 0, fz: -1 })),
  door: { x: 0, z: 0.2 },
};
export function buildHQ() {
  const group = new THREE.Group(); group.name = 'hq';
  const parts = new THREE.Group(); group.add(parts);       // the town hall itself (pickable)
  const plaza = new THREE.Group(); group.add(plaza);       // walkable plaza, fountain, benches (not pickable)
  const add = (geometry, colorHex, opts, into = parts) => { const m = mesh(geometry, typeof colorHex === 'string' ? toonMaterial(colorHex) : colorHex, opts); into.add(m); return m; };
  add(placed(new THREE.CylinderGeometry(5.5, 5.65, 0.14, 48), { y: LAWN_TOP + 0.07 }), PALETTE.plaza, { cast: false, outline: 0.04 }, plaza);
  add(placed(new THREE.TorusGeometry(4.2, 0.12, 6, 48), { y: LAWN_TOP + 0.15, rx: Math.PI / 2 }), PALETTE.plazaRing, { cast: false, outline: 0 }, plaza);
  add(placed(rbox(6.8, 0.5, 4.8, 0.15), { y: 0.45, z: -2.7 }), '#eadcc4');
  add(placed(rbox(5.8, 2.9, 3.8, 0.3), { y: 2.15, z: -2.75 }), '#fff1de');
  add(placed(rbox(6.5, 0.55, 4.5, 0.2), { y: 3.85, z: -2.75 }), '#ff8f6b');
  for (const x of [-2.15, -0.78, 0.78, 2.15]) add(placed(new THREE.CylinderGeometry(0.2, 0.24, 2.9, 10), { x, y: 2.15, z: -0.6 }), '#fffaf2');
  add(placed(rbox(1.25, 1.95, 0.3, 0.12), { y: 1.65, z: -0.82 }), '#7b6cf0');
  for (const sx of [-1, 1]) for (const z of [-3.6, -2.0]) add(placed(rbox(0.12, 1.0, 0.75, 0.05), { x: sx * 2.92, y: 2.3, z }), toonMaterial('#ffe3a3', { emissive: '#ffc766', emissiveIntensity: 0.6 }), { cast: false, outline: 0.02 });
  add(placed(rbox(2.1, 3.3, 2.1, 0.25), { y: 5.75, z: -2.95 }), '#ffe7c4');
  add(placed(new THREE.ConeGeometry(1.8, 1.9, 4), { y: 8.35, z: -2.95, ry: Math.PI / 4 }), '#8b7bff');
  // Clock with real hands.
  const clock = new THREE.Mesh(new THREE.CircleGeometry(0.66, 32), new THREE.MeshBasicMaterial({ map: clockTexture() }));
  clock.position.set(0, 6.35, -1.88); parts.add(clock);
  const hand = (len, w) => { const pivot = new THREE.Group(); const m = new THREE.Mesh(placed(new THREE.BoxGeometry(w, len, 0.03), { y: len / 2 }), new THREE.MeshBasicMaterial({ color: '#1d1830' })); pivot.add(m); pivot.position.set(0, 6.35, -1.86); parts.add(pivot); return pivot; };
  const hourHand = hand(0.36, 0.07), minuteHand = hand(0.52, 0.05);
  // Name plaque.
  const plaque = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.85), new THREE.MeshBasicMaterial({ map: plaqueTexture('CodaClauda HQ', { gradient: true }), transparent: true }));
  plaque.position.set(0, 3.88, -0.46); parts.add(plaque);
  // Beacon crystal with a coral → violet → teal gradient, and a soft light beam.
  const crystalGeo = new THREE.OctahedronGeometry(0.62, 0);
  gradientColors(crystalGeo, -0.62, 0.62, 3, 1);
  const beacon = new THREE.Mesh(crystalGeo, new THREE.MeshBasicMaterial({ vertexColors: true }));
  beacon.position.set(0, 10.05, -2.95); beacon.userData.hq = true; addOutline(beacon, { thickness: 0.04 });
  group.add(beacon);
  const beamGeo = new THREE.CylinderGeometry(0.28, 1.4, 18, 24, 6, true);
  gradientColors(beamGeo, -9, 9, 4, 0);
  const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  beam.position.set(0, 10.05 + 9.2, -2.95); beam.raycast = () => {};
  group.add(beam);
  const halo = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 10.05, -2.95], 3)), new THREE.PointsMaterial({ size: 6, map: glowTexture(), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, color: '#c9a8ff' }));
  group.add(halo);
  // Fountain.
  add(placed(new THREE.CylinderGeometry(1.25, 1.38, 0.5, 28), { y: LAWN_TOP + 0.25, z: 2.2 }), '#e3d6c0', undefined, plaza);
  add(placed(new THREE.CylinderGeometry(1.05, 1.05, 0.06, 28), { y: LAWN_TOP + 0.48, z: 2.2 }), toonMaterial(PALETTE.water, { emissive: '#2aa7c4', emissiveIntensity: 0.2 }), { cast: false, outline: 0 }, plaza);
  add(placed(new THREE.CylinderGeometry(0.16, 0.24, 1.0, 10), { y: LAWN_TOP + 0.9, z: 2.2 }), '#e3d6c0', undefined, plaza);
  add(placed(new THREE.CylinderGeometry(0.45, 0.2, 0.18, 16), { y: LAWN_TOP + 1.42, z: 2.2 }), '#e3d6c0', undefined, plaza);
  // Plaza benches and flower beds.
  const benchMat = toonMaterial('#c98a55');
  for (const [x, z, ry] of [[-3.7, 1.5, Math.PI / 2], [-3.7, 3.5, Math.PI / 2], [3.7, 1.5, -Math.PI / 2], [3.7, 3.5, -Math.PI / 2]]) {
    const b = new THREE.Mesh(benchGeometry(), benchMat); b.position.set(x, LAWN_TOP + 0.08, z); b.rotation.y = ry; b.castShadow = true; addOutline(b, { thickness: 0.03 }); plaza.add(b);
  }
  const beds = [];
  for (const sx of [-1, 1]) {
    add(placed(rbox(1.6, 0.4, 2.6, 0.12), { x: sx * 4.3, y: LAWN_TOP + 0.2, z: -2.6 }), '#d9c3a0', { cast: false, outline: 0.03 }, plaza);
    beds.push({ x: sx * 4.3, z: -3.1, seed: `hq${sx}a` }, { x: sx * 4.3, z: -2.1, seed: `hq${sx}b` });
  }
  const bedGroup = new THREE.Group(); bedGroup.position.y = 0.32; addFlowers(bedGroup, beds); group.add(bedGroup);
  addTrees(group, [{ x: -4.6, z: -4.9, kind: 'ball', scale: 0.9, color: '#ffb3c7' }, { x: 4.6, z: -4.9, kind: 'ball', scale: 0.9, color: '#ffb3c7' }]);

  const state = { spin: 0, beaconBase: beacon.position.y };
  const pickables = [...parts.children.filter(m => m.isMesh), beacon];
  for (const m of pickables) m.userData.hq = true;
  return {
    group, beacon, beam, halo, pickables,
    update(dt, elapsed, env) {
      const now = new Date();
      const minutes = now.getMinutes() + now.getSeconds() / 60, hours = (now.getHours() % 12) + minutes / 60;
      minuteHand.rotation.z = -minutes / 60 * Math.PI * 2; hourHand.rotation.z = -hours / 12 * Math.PI * 2;
      beam.material.opacity = 0.12 + env.night * 0.3;
      halo.material.opacity = 0.35 + env.night * 0.5;
      if (env.reducedMotion) return;
      state.spin += dt * 0.9;
      beacon.rotation.y = state.spin;
      beacon.position.y = state.beaconBase + Math.sin(elapsed * 1.6) * 0.18;
      halo.position.y = beacon.position.y - state.beaconBase;
      if (env.particles && Math.random() < dt * 2.2) env.particles.emit('mote', { x: (Math.random() - 0.5) * 0.6, y: beacon.position.y, z: -2.95 }, 1, { spread: 0.8 });
      if (env.particles && Math.random() < dt * 9) env.particles.emit('water', { x: 0, y: LAWN_TOP + 1.55, z: 2.2 }, 1, { spread: 0.15 });
    },
  };
}
/** Vertex colours along y: coral → violet → teal (alpha fades toward the top when fade = 1). */
function gradientColors(geometry, y0, y1, itemSize, fadeTop) {
  const pos = geometry.getAttribute('position');
  const stops = [new THREE.Color('#ff7a4d'), new THREE.Color('#9a6bff'), new THREE.Color('#1fc4a4')];
  const out = new Float32Array(pos.count * itemSize), c = new THREE.Color();
  for (let k = 0; k < pos.count; k++) {
    const t = Math.min(1, Math.max(0, (pos.getY(k) - y0) / (y1 - y0)));
    if (t < 0.5) c.copy(stops[0]).lerp(stops[1], t * 2); else c.copy(stops[1]).lerp(stops[2], (t - 0.5) * 2);
    out[k * itemSize] = c.r; out[k * itemSize + 1] = c.g; out[k * itemSize + 2] = c.b;
    if (itemSize === 4) out[k * itemSize + 3] = fadeTop === 0 ? Math.pow(1 - t, 1.4) : 1;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(out, itemSize));
}

/* ---------- clouds ---------- */
function cloudGeometry(seed) {
  const r = seeded(seed), parts = [];
  const count = 4 + Math.floor(r() * 3);
  for (let k = 0; k < count; k++) {
    const s = 1.4 + r() * 1.6;
    parts.push(placed(new THREE.IcosahedronGeometry(s, 1), { x: (k - count / 2) * 1.7 + r(), y: r() * 0.9, z: (r() - 0.5) * 1.8, sy: 0.72 }));
  }
  const g = mergeParts(parts); g.userData.shared = true; return g;
}
let cloudGeos = null;   // shared by every rebuild (rings change)
/** Clouds live in world space and never touch the island, whichever way it is turned: every cloud
 * keeps at least `clear` (the island's sweep radius plus a margin) plus its own size away from the
 * island centre (0, center, 0). They drift along +x, so that distance is measured in the y-z plane:
 * low clouds sit far below the centre, side clouds far out along ±z. A cloud shrinks away near the
 * wrap edges (no popping), and while it is close to the camera or in front of the island on screen.
 * `island` is the radius treated as "the island" for that screen test. `seed` / `total`: a second,
 * different set (the weather's extra clouds). */
export function buildClouds(half, quality = 'high', { center = 0, clear = half * 1.8, island = half * 1.3, seed = 'clouds', total: count } = {}) {
  const group = new THREE.Group(); group.name = 'clouds';
  const r = seeded(seed);
  const geos = cloudGeos ||= [cloudGeometry('a'), cloudGeometry('b'), cloudGeometry('c')];
  const radii = geos.map(g => (g.boundingSphere ? g.boundingSphere.center.length() + g.boundingSphere.radius : 7));
  const material = toonMaterial('#ffffff', { cache: false });
  const total = count ?? (quality === 'low' ? 12 : 22);
  const wrap = Math.max(half * 2.6, clear + 48);
  const clouds = [];
  for (let k = 0; k < total; k++) {
    const low = k % 3 !== 0, variant = k % 3;
    const scale = (low ? 1.6 : 1.1) + r() * 1.4, reach = radii[variant] * scale;
    const x = (r() * 2 - 1) * wrap;
    const y = low ? center - clear - reach - r() * 22 : center - 5 + r() * 15;
    const z = low ? (r() * 2 - 1) * (clear + half) : (r() < 0.5 ? -1 : 1) * (clear + reach + r() * half * 0.6);
    clouds.push({ variant, x, y, z, scale, reach, speed: 0.4 + r() * 0.7, ry: r() * Math.PI, vis: -1 });
  }
  const meshes = geos.map((g, v) => {
    const inst = new THREE.InstancedMesh(g, material, Math.max(1, clouds.filter(c => c.variant === v).length));
    inst.userData.noOutline = true; inst.frustumCulled = false;
    group.add(inst); return inst;
  });
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0);
  const centre = new THREE.Vector3(0, center, 0), toIsland = new THREE.Vector3(), rel = new THREE.Vector3();
  function layout() {
    const counters = [0, 0, 0];
    for (const c of clouds) {
      const edge = Math.min(1, Math.max(0, (wrap - Math.abs(c.x)) / (wrap * 0.18)));
      const shown = Math.max(0, c.vis), k = shown * shown * (3 - 2 * shown);
      m4.compose(v.set(c.x, c.y, c.z), q.setFromAxisAngle(yAxis, c.ry), s.setScalar(Math.max(1e-4, c.scale * edge * k)));
      meshes[c.variant].setMatrixAt(counters[c.variant]++, m4);
    }
    meshes.forEach((m, k) => { m.count = counters[k]; m.instanceMatrix.needsUpdate = true; });
  }
  layout();
  return {
    group, material,
    /** dt: drift time (0 = hold still); camera: world camera position; reduced: snap instead of easing. */
    update(dt, camera, reduced = false) {
      let L = 0, islandAngle = 0;
      if (camera) {
        toIsland.subVectors(centre, camera); L = toIsland.length();
        if (L > 1e-3) toIsland.divideScalar(L);
        islandAngle = Math.asin(Math.min(1, island / Math.max(L, 1e-3)));
      }
      for (const c of clouds) {
        if (dt > 0) { c.x += c.speed * dt; if (c.x > wrap) c.x = -wrap; }
        let hide = false;
        if (camera) {
          rel.set(c.x - camera.x, c.y - camera.y, c.z - camera.z);
          const d = rel.length(), along = rel.dot(toIsland);
          hide = d < c.reach + 14;
          if (!hide && along > 0 && along < L) {
            const angle = Math.acos(Math.min(1, along / Math.max(d, 1e-3)));
            hide = angle < islandAngle + Math.asin(Math.min(1, (c.reach * 0.8) / Math.max(d, 1e-3)));
          }
        }
        const goal = hide ? 0 : 1;
        c.vis = reduced || c.vis < 0 ? goal : c.vis + (goal - c.vis) * Math.min(1, dt > 0 ? dt * 3.5 : 0.2);
      }
      layout();
    },
  };
}

/* ---------- empty-plot hover marker ---------- */
let curtainTex = null;
function curtainTexture() {
  if (curtainTex) return curtainTex;
  const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 64;
  const g = canvas.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(0.7, 'rgba(255,255,255,.35)'); grad.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = grad; g.fillRect(0, 0, 4, 64);
  curtainTex = new THREE.CanvasTexture(canvas); curtainTex.colorSpace = THREE.SRGBColorSpace;
  return curtainTex;
}
/** Soft glowing outline for a hovered empty lot: a square ring on the lawn plus a short fading light curtain. */
export function buildPlotMarker() {
  const group = new THREE.Group(); group.name = 'plot-marker'; group.visible = false;
  const half = LOT_HALF - 0.3, radius = half * Math.SQRT2;
  const color = new THREE.Color('#b4a6ff');
  const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false });
  const fillMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false });
  const curtainMat = new THREE.MeshBasicMaterial({ color, map: curtainTexture(), transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.42, radius, 4, 1, Math.PI / 4), ringMat);
  ring.rotation.x = -Math.PI / 2; ring.position.y = GROUND_Y + 0.05;
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2), fillMat);
  fill.rotation.x = -Math.PI / 2; fill.position.y = GROUND_Y + 0.04;
  const curtain = new THREE.Mesh(new THREE.CylinderGeometry(radius - 0.2, radius - 0.2, 1.3, 4, 1, true), curtainMat);
  curtain.rotation.y = Math.PI / 4; curtain.position.y = GROUND_Y + 0.65;
  for (const m of [ring, fill, curtain]) { m.raycast = () => {}; m.renderOrder = 3; m.userData.noOutline = true; group.add(m); }
  return {
    group,
    show(i, j) { const c = cellCenter(i, j); group.position.set(c.x, 0, c.z); group.visible = true; },
    hide() { group.visible = false; },
    update(elapsed, reduced) {
      if (!group.visible) return;
      const k = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(elapsed * 3.2);
      ringMat.opacity = 0.6 + k * 0.35; curtainMat.opacity = 0.28 + k * 0.3; fillMat.opacity = 0.08 + k * 0.08;
    },
  };
}

/* ---------- sky dome and stars ---------- */
export function buildSky() {
  const uniforms = {
    uTop: { value: new THREE.Color('#5fb4ff') }, uHorizon: { value: new THREE.Color('#cfeaff') }, uBottom: { value: new THREE.Color('#e9f3ff') },
    uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.4).normalize() }, uSunColor: { value: new THREE.Color('#fff1d6') }, uSunGlow: { value: 0.6 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }',
    fragmentShader: `uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uBottom; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform float uSunGlow; varying vec3 vDir;
      void main(){ float h = normalize(vDir).y; vec3 col = h > 0.0 ? mix(uHorizon, uTop, pow(max(h, 0.0), 0.55)) : mix(uHorizon, uBottom, pow(max(-h, 0.0), 0.6));
        float sun = max(dot(normalize(vDir), normalize(uSunDir)), 0.0);
        col += uSunColor * (pow(sun, 18.0) * 0.35 + pow(sun, 600.0) * 1.2) * uSunGlow;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), material);
  dome.frustumCulled = false; dome.renderOrder = -10;
  const positions = [], r = seeded('stars');
  for (let k = 0; k < 900; k++) {
    const u = r() * Math.PI * 2, v = 0.06 + r() * 0.94, rad = 800;
    const cy = v, sy = Math.sqrt(1 - cy * cy);
    positions.push(Math.cos(u) * sy * rad, cy * rad, Math.sin(u) * sy * rad);
  }
  const stars = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)),
    new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, color: '#fffbe8', transparent: true, opacity: 0, depthWrite: false, fog: false }));
  stars.frustumCulled = false; stars.renderOrder = -9;
  const group = new THREE.Group(); group.add(dome, stars);
  return { group, uniforms, stars };
}

