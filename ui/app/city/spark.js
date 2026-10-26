/* The Spark side: when the DGX Spark bridge is on, the floating island has a second face, the
 * "Spark city". The top face is this PC; the other face is the Spark. Every project lot above
 * gets a Spark building on the same lot of the other face (same footprint and height, built by
 * the same Building code with { mirror: true }), the HQ plaza's other side holds the "Spark
 * Foundry" hub for jobs without a linked project, and every active Spark job is a little runner
 * standing on that face. Active jobs on this PC show as spinning gears above the top city.
 *
 * Everything here lives in one group inside the island (world.land) at DECK_Y, turned a half
 * turn about x: local coordinates are the top city's (y = 0 is the deck surface, +y away from
 * it), the Spark side hangs below while This PC is up and stands upright, sunlit, once the
 * island is turned over. Island space ↔ local: y = DECK_Y - local y, z = -local z. */
import { THREE, toonMaterial, addOutline } from './toon.js';
import { RoundedBoxGeometry } from '../../vendor/three/addons/RoundedBoxGeometry.js';
import { BuildingManager, SPARK_MATERIALS, pulseSpark, setSparkOffline } from './buildings.js';
import { mergeParts, placed, plaqueTexture, sideTexture, disposeAll, Particles, instancedOutline } from './fx.js';
import { PITCH, LOT_HALF, islandHalf, cellCenter } from './layout.js';
import { GROUND_Y, buildSideSign, seeded, benchGeometry } from './scenery.js';
import { agentAvatar, hash } from '../avatar/spec.js';
import { riverCellUsable, riverFootprintClear } from './river-path.js';
import { riverLandGeometry, outsideIntervals, riverCuts } from './river-terrain.js';

export const DECK_Y = -7.2;          // island-space height of the Spark side's "ground"
export const RUNNER_CAP = 24;
export const FOUNDRY = 'foundry';
const HQ_GEAR = new THREE.Vector3(2.45, 9.3, -2.95);
const FOUNDRY_RINGS = [{ r: 4.1, n: 10 }, { r: 4.9, n: 12 }, { r: 5.5, n: 14 }];
const PLAZA_R = 6.4, PLAZA_TOP = 0.06;

/** Job runner label: "codex · rust · 16 cores" (client · runtime · reserved cores). */
export function jobLabel(job) {
  const cores = Number(job?.reserved_cpu ?? job?.cpu);
  return [job?.client, job?.runtime, Number.isFinite(cores) && cores > 0 ? `${cores % 1 ? cores.toFixed(1) : cores} core${cores === 1 ? '' : 's'}` : ''].filter(Boolean).map(String).join(' · ') || 'Spark job';
}

/* ---------- deck: a light circuit board with green traces, pale plots and the DGX SPARK emblem ---------- */
function buildDeck(rings, { districts = false } = {}) {
  const half = islandHalf(rings), size = half * 2, M = SPARK_MATERIALS;
  const group = new THREE.Group(); group.name = 'spark-deck';
  const plate = new THREE.Mesh(districts ? riverLandGeometry(half - 1.5, { top: 0.02, bottom: -0.8, mirror: true }) : placed(new RoundedBoxGeometry(size - 3, 0.8, size - 3, 2, 0.6), { y: -0.4 }), M.board);
  plate.name = districts ? 'spark-river-cut-deck' : 'spark-deck-plate';
  plate.userData.occluder = true;
  plate.castShadow = true; plate.receiveShadow = true;   // shades the face that's down, takes the Spark city's shadows when up
  addOutline(plate, { thickness: 0.08 });
  group.add(plate);
  // Plots are as tall as the top city's lawns, so Spark building pads sit on them (no gap).
  const plots = [], traces = [], vias = [], chips = [], pins = [];
  for (let i = -rings; i <= rings; i++) for (let j = -rings; j <= rings; j++) {
    if (!i && !j) continue;
    if (districts && !riverCellUsable(i, -j)) continue;
    const c = cellCenter(i, j);
    plots.push(placed(new THREE.BoxGeometry(LOT_HALF * 2 - 0.4, GROUND_Y, LOT_HALF * 2 - 0.4), { x: c.x, y: GROUND_Y / 2, z: c.z }));
  }
  const extent = (rings + 0.5) * PITCH;
  const trace = (axis, line, limit, width) => {
    const cuts = districts ? riverCuts(axis, line, width / 2) : [];
    for (const [a, b] of outsideIntervals(-limit, limit, cuts)) traces.push(placed(new THREE.BoxGeometry(axis === 'x' ? b - a : width, 0.05, axis === 'z' ? b - a : width),
      { x: axis === 'x' ? (a + b) / 2 : line, y: 0.025, z: -(axis === 'z' ? (a + b) / 2 : line) }));
  };
  for (let k = -rings - 1; k <= rings; k++) {
    const line = (k + 0.5) * PITCH;
    trace('z', line, extent, 0.34); trace('x', line, extent, 0.34);
    for (let q = -rings - 1; q <= rings; q++) {
      const z = (q + 0.5) * PITCH;
      if (!districts || riverFootprintClear(line, -z, 0.5, 0.5)) vias.push(placed(new THREE.CylinderGeometry(0.46, 0.46, 0.08, 12), { x: line, y: 0.04, z }));
    }
  }
  // Border trace round the rim, and a little IC package in each corner.
  const border = extent + 1.2;
  for (const s of [-1, 1]) {
    trace('x', s * border, border + 0.15, 0.3); trace('z', s * border, border + 0.15, 0.3);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (extent + 2.6), z = sz * (extent + 2.6);
    if (districts && !riverFootprintClear(x, -z, 1.25, 1.25)) continue;
    chips.push(placed(new RoundedBoxGeometry(1.8, 0.34, 1.8, 1, 0.1), { x, y: 0.17, z }));
    for (const o of [-0.55, 0, 0.55]) {
      pins.push(placed(new THREE.BoxGeometry(0.16, 0.06, 0.34), { x: x + o, y: 0.03, z: z + 1.05 }), placed(new THREE.BoxGeometry(0.16, 0.06, 0.34), { x: x + o, y: 0.03, z: z - 1.05 }));
      pins.push(placed(new THREE.BoxGeometry(0.34, 0.06, 0.16), { x: x + 1.05, y: 0.03, z: z + o }), placed(new THREE.BoxGeometry(0.34, 0.06, 0.16), { x: x - 1.05, y: 0.03, z: z + o }));
    }
  }
  const flat = (parts, material, { outline = 0 } = {}) => {
    const m = new THREE.Mesh(mergeParts(parts), material);
    m.raycast = () => {}; m.receiveShadow = true;
    if (outline) addOutline(m, { thickness: outline }); else m.userData.noOutline = true;
    group.add(m); return m;
  };
  if (plots.length) flat(plots, M.plot, { outline: 0.03 });
  flat(traces, M.glow);
  flat(vias, M.lime);
  flat([placed(new THREE.CylinderGeometry(PLAZA_R, PLAZA_R, PLAZA_TOP, 40), { y: PLAZA_TOP / 2 })], M.panel, { outline: 0.03 });
  flat(chips, M.dark, { outline: 0.03 }).castShadow = true;
  flat(pins, M.lime);
  // "DGX SPARK" emblem on the front rim (local +z faces the same way as the THIS PC sign once turned over).
  const sign = buildSideSign(sideTexture('spark'), { board: '#eef8e2', post: '#2f5a3c' });
  sign.position.set(0, 0, extent + 2.3);
  group.add(sign);
  return { group, plate, sign, signZ: extent + 2.3 };
}

/* ---------- the Spark Foundry, on the other side of the HQ plaza ---------- */
function buildFoundry() {
  const M = SPARK_MATERIALS;
  const group = new THREE.Group(); group.name = 'spark-foundry';
  const parts = { dark: [], panel: [], lime: [] };
  parts.dark.push(placed(new THREE.CylinderGeometry(3.0, 3.4, 0.5, 8), { y: PLAZA_TOP + 0.25 }));
  parts.panel.push(placed(new THREE.ConeGeometry(1.8, 2.6, 8), { y: 8.2 }));
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + k * Math.PI / 2, x = Math.sin(a) * 2.85, z = Math.cos(a) * 2.85;
    parts.dark.push(placed(new THREE.CylinderGeometry(0.38, 0.38, 3.4, 10), { x, y: 2.2, z }));
    parts.lime.push(placed(new THREE.CylinderGeometry(0.44, 0.44, 0.18, 10), { x, y: 3.95, z }));
  }
  const meshes = [];
  const add = (geometry, material, outline = 0.05) => { const m = new THREE.Mesh(geometry, material); m.castShadow = true; m.receiveShadow = true; if (outline) addOutline(m, { thickness: outline }); m.userData.sparkFoundry = true; group.add(m); meshes.push(m); return m; };
  add(mergeParts(parts.dark), M.dark);
  add(mergeParts(parts.panel), M.panel);
  const caps = add(mergeParts(parts.lime), M.lime, 0.03);
  const core = add(placed(new THREE.CylinderGeometry(1.8, 2.4, 6.4, 8), { y: 3.7 }), M.body, 0.06);
  const rings = add(mergeParts([2.0, 4.0, 6.0].map(y => placed(new THREE.TorusGeometry(2.4 - (y - 0.5) / 6.4 * 0.6 + 0.04, 0.16, 6, 28), { y, rx: Math.PI / 2 }))), M.glow, 0.03);
  const crystal = add(new THREE.OctahedronGeometry(0.75, 0), M.lime, 0.04);
  crystal.position.y = 10.25;
  // Name plaque (the Spark group is a proper half turn, so the texture reads as drawn).
  const plaque = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.85), new THREE.MeshBasicMaterial({ map: plaqueTexture('Spark Foundry', { accent: '#76b900' }), transparent: true }));
  plaque.position.set(0, 2.9, 2.32); plaque.userData.sparkFoundry = true;
  group.add(plaque); meshes.push(plaque);
  let active = null, spin = 0;
  return {
    group,
    plaque,
    pickables: meshes,
    setActive(on) {
      if (on === active) return;
      active = on;
      core.material = on ? M.bodyActive : M.body;
      rings.material = on ? M.glowActive : M.glow;
      caps.material = on ? M.limeActive : M.lime;
      crystal.material = on ? M.limeActive : M.lime;
    },
    update(dt, elapsed, env) {
      if (env.reducedMotion || env.offline) return;
      spin += dt * (active ? 1.6 : 0.5);
      crystal.rotation.y = spin;
      crystal.position.y = 10.25 + Math.sin(elapsed * 1.4) * 0.15;
    },
  };
}
/** Work spot k around the Foundry core (local coordinates), facing the core. */
function foundrySpot(k) {
  let ring = 0, index = k;
  while (ring < FOUNDRY_RINGS.length - 1 && index >= FOUNDRY_RINGS[ring].n) { index -= FOUNDRY_RINGS[ring].n; ring++; }
  const { r, n } = FOUNDRY_RINGS[ring];
  const a = (index % n) / n * Math.PI * 2 + ring * 0.31 + 0.2;
  const x = Math.sin(a) * r, z = Math.cos(a) * r;
  return { x, z, fx: -Math.sin(a), fz: -Math.cos(a) };
}

/* ---------- Spark greenery: the top city's toybox plants in the Spark's own lime / green ---------- */
const GREEN = {
  leaf: toonMaterial('#6fd34e', { emissive: '#1d4a10', emissiveIntensity: 0.18, cache: false }),
  lime: toonMaterial('#b4ee4c', { emissive: '#4a7a12', emissiveIntensity: 0.16, cache: false }),
  pine: toonMaterial('#3fbf62', { emissive: '#0f3d1c', emissiveIntensity: 0.16, cache: false }),
  trunk: toonMaterial('#5d4a33', { cache: false }),
  planter: toonMaterial('#2c3b30', { cache: false }),
  moss: toonMaterial('#9dff5a', { emissive: '#62d61e', emissiveIntensity: 0.6, cache: false }),
};
for (const m of Object.values(GREEN)) m.userData.shared = true;
let greensOffline = false;
/** Spark offline: the plants go the same flat grey as the rest of the Spark side (shared materials). */
function setGreensOffline(on) {
  on = Boolean(on);
  if (on === greensOffline) return;
  greensOffline = on;
  const hsl = {};
  for (const m of Object.values(GREEN)) {
    const keep = m.userData.online ||= { color: m.color.clone(), emissive: m.emissive.clone(), emissiveIntensity: m.emissiveIntensity };
    if (on) { keep.color.getHSL(hsl); m.color.setHSL(hsl.h, 0.03, 0.24 + hsl.l * 0.5); m.emissive.set('#000000'); m.emissiveIntensity = 0; }
    else { m.color.copy(keep.color); m.emissive.copy(keep.emissive); m.emissiveIntensity = keep.emissiveIntensity; }
  }
}
const Y_AXIS = new THREE.Vector3(0, 1, 0);
/** One InstancedMesh (plus ink outline) for a list of { x, y, z, s, ry } placements. */
function plantMesh(group, geometry, material, items, { outline = 0.04, cast = true } = {}) {
  if (!items.length) return;
  const inst = new THREE.InstancedMesh(geometry, material, items.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
  items.forEach((p, k) => { m4.compose(v.set(p.x, p.y, p.z), q.setFromAxisAngle(Y_AXIS, p.ry || 0), s.setScalar(p.s ?? 1)); inst.setMatrixAt(k, m4); });
  inst.castShadow = cast; inst.receiveShadow = true; inst.userData.noOutline = true;
  group.add(inst);
  if (outline) group.add(instancedOutline(inst, outline));
}
/** Plants on the Spark face (local coordinates: +y points away from the deck, so they stand on
 *  the Spark side only): little parks on lots without a Spark building, a bush or two behind the
 *  narrower buildings, planter boxes of glowing moss along the traces, bushes round the Foundry plaza. */
function buildGreenery(rings, buildings, { districts = false } = {}) {
  const group = new THREE.Group(); group.name = 'spark-greenery';
  const geo = {
    bush: placed(new THREE.IcosahedronGeometry(0.62, 1), { y: 0.44, sy: 0.78 }),
    trunk: placed(new THREE.CylinderGeometry(0.11, 0.16, 0.9, 6), { y: 0.45 }),
    cone: mergeParts([placed(new THREE.ConeGeometry(0.82, 1.35, 7), { y: 1.3 }), placed(new THREE.ConeGeometry(0.6, 1.05, 7), { y: 1.95 })]),
    planter: placed(new THREE.BoxGeometry(0.6, 0.36, 2.1), { y: 0.18 }),
    moss: placed(new THREE.BoxGeometry(0.46, 0.1, 1.96), { y: 0.39 }),
  };
  const leaf = [], lime = [], trunks = [], cones = [], planters = [];
  const byCell = new Map(buildings.map(b => [`${b.cell.i},${b.cell.j}`, b]));
  for (let i = -rings; i <= rings; i++) for (let j = -rings; j <= rings; j++) {
    const c = cellCenter(i, j);
    if (districts && !riverCellUsable(i, -j) && (i || j)) continue;
    for (const sx of [-1, 1]) for (const dz of [-2.7, 2.7]) {
      const x = c.x + sx * 6.7, z = c.z + dz;
      if (!districts || riverFootprintClear(x, -z, 0.35, 1.1)) planters.push({ x, y: 0, z });
    }
    if (!i && !j) continue;
    const r = seeded(`spark-lot:${i},${j}`), b = byCell.get(`${i},${j}`);
    if (!b) {
      const spots = [], span = LOT_HALF * 2 - 2.2;
      for (let n = 0, tries = 0; n < 7 && tries < 40; tries++) {
        const x = (r() - 0.5) * span, z = (r() - 0.5) * span;
        if (!spots.every(([px, pz]) => Math.hypot(px - x, pz - z) > 1.7)) continue;
        spots.push([x, z]); n++;
        const s = 0.7 + r() * 0.5, kind = r(), ry = r() * 6;
        if (kind < 0.4) { trunks.push({ x: c.x + x, y: GROUND_Y, z: c.z + z, s, ry }); cones.push({ x: c.x + x, y: GROUND_Y, z: c.z + z, s, ry }); }
        else (kind < 0.72 ? leaf : lime).push({ x: c.x + x, y: GROUND_Y, z: c.z + z, s: s * 1.1, ry });
      }
    } else if (b.size.W / 2 < LOT_HALF - 1.9) {
      for (const sx of [-1, 1]) (r() < 0.5 ? leaf : lime).push({ x: c.x + sx * (LOT_HALF - 0.95), y: GROUND_Y, z: c.z - (LOT_HALF - 0.95), s: 0.75 + r() * 0.3, ry: r() * 6 });
    }
  }
  // Round the Foundry plaza; the front (plaque, crew bench) stays open.
  for (let k = 0; k < 18; k++) {
    const a = (k + 0.5) / 18 * Math.PI * 2;
    if (Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) < 1.05) continue;
    (k % 3 ? leaf : lime).push({ x: Math.sin(a) * 5.95, y: PLAZA_TOP, z: Math.cos(a) * 5.95, s: 0.62 + (k % 4) * 0.06, ry: a });
  }
  plantMesh(group, geo.bush, GREEN.leaf, leaf);
  plantMesh(group, geo.bush, GREEN.lime, lime);
  plantMesh(group, geo.trunk, GREEN.trunk, trunks, { outline: 0.03 });
  plantMesh(group, geo.cone, GREEN.pine, cones);
  plantMesh(group, geo.planter, GREEN.planter, planters, { outline: 0.03, cast: false });
  plantMesh(group, geo.moss, GREEN.moss, planters, { outline: 0, cast: false });
  return group;
}

/* ---------- Spark crew: idle bots resting at the Foundry while no Spark job runs ---------- */
const CREW_BENCH = { a: 0.62, r: 5.85 }, CREW_STAND = { a: -0.62, r: 5.1 };
/** A bench for the crew and three bonsai on the Foundry's base ring (built once; never rebuilt). */
function buildFoundryGarden() {
  const group = new THREE.Group(); group.name = 'spark-foundry-garden';
  const { a, r } = CREW_BENCH;
  const bench = new THREE.Mesh(benchGeometry(), SPARK_MATERIALS.dark);
  bench.position.set(Math.sin(a) * r, PLAZA_TOP, Math.cos(a) * r); bench.rotation.y = a + Math.PI;
  bench.castShadow = true; bench.receiveShadow = true; addOutline(bench, { thickness: 0.03 });
  group.add(bench);
  const pots = [], trunks = [], puffs = [], base = PLAZA_TOP + 0.5;
  [-0.36, 0.36, Math.PI].forEach((ang, k) => {
    const x = Math.sin(ang) * 2.75, z = Math.cos(ang) * 2.75, lean = k % 2 ? 1 : -1;
    pots.push(placed(new THREE.CylinderGeometry(0.26, 0.2, 0.22, 10), { x, y: base + 0.11, z }));
    trunks.push(placed(new THREE.CylinderGeometry(0.05, 0.08, 0.6, 6), { x, y: base + 0.5, z, rz: lean * 0.25 }));
    puffs.push(placed(new THREE.IcosahedronGeometry(0.34, 1), { x: x - lean * 0.12, y: base + 0.86, z, sy: 0.6 }));
    puffs.push(placed(new THREE.IcosahedronGeometry(0.24, 1), { x: x + lean * 0.16, y: base + 0.66, z: z + 0.05, sy: 0.6 }));
  });
  for (const [parts, material, outline] of [[pots, SPARK_MATERIALS.dark, 0.02], [trunks, GREEN.trunk, 0], [puffs, GREEN.lime, 0.03]]) {
    const m = new THREE.Mesh(mergeParts(parts), material);
    m.castShadow = true; m.receiveShadow = true;
    if (outline) addOutline(m, { thickness: outline }); else m.userData.noOutline = true;
    group.add(m);
  }
  return group;
}
/** Crew places (local): two on the bench, one standing on the other side of the plaque; all face the Foundry. */
function crewSpots() {
  const { a, r } = CREW_BENCH, ry = a + Math.PI, fx = Math.sin(ry), fz = Math.cos(ry);
  const bx = Math.sin(a) * r, bz = Math.cos(a) * r, ox = Math.cos(ry) * 0.42, oz = -Math.sin(ry) * 0.42;
  return [
    { x: bx - ox, z: bz - oz, fx, fz, action: 'sit' },
    { x: bx + ox, z: bz + oz, fx, fz, action: 'sit' },
    { x: Math.sin(CREW_STAND.a) * CREW_STAND.r, z: Math.cos(CREW_STAND.a) * CREW_STAND.r, fx: -Math.sin(CREW_STAND.a), fz: -Math.cos(CREW_STAND.a), action: 'stand' },
  ];
}
function crewLook(k) {
  const spec = agentAvatar(`spark-crew:${k}`, 'other', 'Spark crew');
  spec.top = { style: k === 1 ? 'sweater' : 'hoodie', color: ['#76b900', '#5fa800', '#8fd12a'][k % 3], accent: '#1d3a0c', emblem: 'bolt' };
  spec.accessory = k === 1 ? 'cap' : 'headphones';
  spec.accessoryColor = '#203b14';
  return spec;
}
/** Turn a person to face (fx, fz) in its parent's space (people.js lookAt takes world coordinates). */
function face(person, fx, fz) {
  if ('_yawTarget' in person) { person._yawTarget = Math.atan2(fx, fz); person.object.rotation.y = person._yawTarget; }
  else { const p = person.object.position, w = person.object.parent ? person.object.parent.localToWorld(new THREE.Vector3(p.x + fx * 4, p.y, p.z + fz * 4)) : null; if (w) person.lookAt(w.x, w.z); }
}

/** Spark job id → the agent most likely driving it from this PC: same provider and on the job's
 *  project (awake first), else an active agent of that provider. Agents still free are preferred. */
export function matchAgents(spark, agents, idMap = new Map(), projectOf = job => job.projectId || null) {
  const out = new Map(), used = new Set();
  const list = (Array.isArray(agents) ? agents : []).filter(a => a && a.provider);
  const canon = id => (id && idMap.get(id)) || id || null;
  for (const job of spark) {
    const pid = projectOf(job), same = list.filter(a => a.provider === job.provider);
    const onProject = same.filter(a => pid && canon(a.currentProjectId) === pid);
    const ranked = [...onProject.filter(a => a.status !== 'offline'), ...onProject, ...same.filter(a => a.status === 'active')];
    const pick = ranked.find(a => !used.has(a.id)) || ranked[0];
    if (pick) { out.set(String(job.job), pick); used.add(pick.id); }
  }
  return out;
}

/* ---------- local-job gear badge (top city) ---------- */
let gearGeo = null, gearMat = null;
function makeGear() {
  if (!gearGeo) {
    const parts = [placed(new THREE.CylinderGeometry(0.5, 0.5, 0.18, 18), { rx: Math.PI / 2 })];
    for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; parts.push(placed(new THREE.BoxGeometry(0.24, 0.26, 0.18), { x: Math.sin(a) * 0.58, y: Math.cos(a) * 0.58, rz: -a })); }
    gearGeo = mergeParts(parts); gearGeo.userData.shared = true;
    gearMat = toonMaterial('#ffc94d', { emissive: '#ff9f1a', emissiveIntensity: 0.55, cache: false }); gearMat.userData.shared = true;
  }
  const mesh = new THREE.Mesh(gearGeo, gearMat);
  addOutline(mesh, { thickness: 0.04 });
  return mesh;
}

/* ---------- manager ---------- */
export class SparkCity {
  /** world: World; makePerson(spec, options) → person; topBuildings: the top city's BuildingManager. */
  constructor(world, { makePerson, reducedMotion, topBuildings }) {
    this.world = world;
    this.makePerson = makePerson;
    this.reducedMotion = reducedMotion;
    this.topBuildings = topBuildings;
    this.group = new THREE.Group(); this.group.name = 'spark-city';
    this.group.position.y = DECK_Y; this.group.rotation.x = Math.PI; this.group.visible = false;
    world.land.add(this.group);
    // The Spark side's own particles: their "down" is toward the Spark deck.
    this.particles = new Particles(320);
    this.group.add(this.particles.points);
    this.buildings = new BuildingManager(this.group, { mirror: true, deckY: DECK_Y, particles: this.particles, reducedMotion });
    this.foundry = buildFoundry(); this.group.add(this.foundry.group);
    this.garden = buildFoundryGarden(); this.group.add(this.garden);
    this.greenery = null; this.greenSig = '';
    this.crew = new Map();      // 'crew:k' → { id, person, crew: true, job: null, status, quality }
    this.agentFor = new Map();  // Spark job id → the agent most likely driving it (from this PC)
    this.drivingAgents = 0;
    this.badges = new THREE.Group(); this.badges.name = 'local-job-gears'; world.city.add(this.badges);
    this.gears = new Map();     // anchor (project id | 'hq') → { mesh, jobs, phase }
    this.runners = new Map();   // job id → { id, job, person, anchor, spot, quality }
    this.sparkByAnchor = new Map();
    this.jobIndex = new Map();
    this.deck = null; this.rings = 0; this.shown = false; this.hiddenRunners = 0;
    this._v = new THREE.Vector3(); this._cam = new THREE.Vector3();
  }

  /** shown: Spark side visible; gears: show local-job gears on the top city; offline: the Spark
   *  is configured but did not answer (side greyed out, no runners, no busy rigs). */
  sync({ shown, projects, cells, rings, machines, quality = 'high', peopleReady = false, gears = true, offline = false, agents = [] }) {
    this.offline = Boolean(offline);
    const jobs = Array.isArray(machines?.jobs) ? machines.jobs.filter(j => j && j.active && !(this.offline && j.machine === 'spark')) : [];
    const idMap = new Map();
    for (const p of projects) for (const id of p.ids?.length ? p.ids : [p.id]) idMap.set(id, p.id);
    const projectOf = job => (job.projectId && idMap.get(job.projectId)) || null;
    const groupBy = (list, keyOf) => { const map = new Map(); for (const job of list) { const key = keyOf(job); if (!map.has(key)) map.set(key, []); map.get(key).push(job); } return map; };
    const spark = jobs.filter(j => j.machine === 'spark'), local = jobs.filter(j => j.machine !== 'spark');
    this.jobIndex = new Map(jobs.map(j => [String(j.job), j]));
    this.sparkByAnchor = groupBy(spark, job => { const id = projectOf(job); return id && cells.has(id) ? id : FOUNDRY; });
    const localByAnchor = groupBy(local, job => { const id = projectOf(job); return id && this.topBuildings.get(id) ? id : 'hq'; });

    this.shown = Boolean(shown);
    this.group.visible = this.shown;
    if (this.shown) {
      if (rings !== this.rings || !this.deck || this.deckDistricts !== Boolean(this.world.districts)) this.buildDeck(rings);
      // The group is turned about x (local z = -island z): lot (i, -j) here is the other face of lot (i, j).
      const under = new Map();
      for (const [id, cell] of cells) under.set(id, { ...cell, j: -cell.j });
      const busy = new Set([...this.sparkByAnchor.keys()].filter(key => key !== FOUNDRY));
      this.buildings.sync(projects, under, busy, { animate: true });
      this.syncGreenery(rings);
      this.foundry.setActive(this.sparkByAnchor.has(FOUNDRY));
      this.agentFor = this.offline ? new Map() : matchAgents(spark, agents, idMap, projectOf);
      if (this.offline) { this.clearRunners(); this.particles.clear(); }
      else if (peopleReady) this.syncRunners(spark, projectOf, quality);
      // Never a dead side: with no Spark job running, the crew rests at the Foundry (asleep while offline).
      if (peopleReady) { if (this.offline || !spark.length) this.syncCrew(quality); else this.clearCrew(); }
    } else { this.clearRunners(); this.clearCrew(); this.particles.clear(); this.agentFor = new Map(); }
    this.drivingAgents = new Set([...this.runners.values()].map(r => r.agent?.id).filter(Boolean)).size;
    this.syncGears(gears ? localByAnchor : new Map());
    setSparkOffline(this.shown && this.offline);
    setGreensOffline(this.shown && this.offline);
    // Going offline: status first, so the grey copies are taken with the eyes shut and the offline gem;
    // coming back: originals first, then the idle status (its gem) goes on top.
    const crewStatus = this.offline ? 'offline' : 'idle';
    const setCrewStatus = () => { for (const c of this.crew.values()) if (c.status !== crewStatus) { c.status = crewStatus; c.person.setStatus(crewStatus); } };
    if (this.offline) setCrewStatus();
    this.tintSigns(this.shown && this.offline);
    setCrewStatus();
  }
  /** Plants follow the lots: rebuilt only when the rings or the Spark buildings' footprints change. */
  syncGreenery(rings) {
    const list = this.buildings.list || [];
    const sig = `${rings}|${Boolean(this.world.districts)}|${list.map(b => `${b.cell.i},${b.cell.j},${b.size.W.toFixed(1)}`).sort().join(';')}`;
    if (sig === this.greenSig && this.greenery) return;
    this.greenSig = sig;
    if (this.greenery) { this.greenery.removeFromParent(); disposeAll(this.greenery); }
    this.greenery = buildGreenery(rings, list, { districts: Boolean(this.world.districts) });
    this.group.add(this.greenery);
  }
  syncCrew(quality) {
    crewSpots().forEach((spot, k) => {
      const id = `crew:${k}`;
      let crew = this.crew.get(id);
      if (crew && crew.quality !== quality) { this.dropCrew(crew); crew = null; }
      if (crew) return;
      let person;
      try { person = this.makePerson(crewLook(k), { role: 'agent', provider: 'other', quality }); }
      catch (error) { console.error('City: could not create the Spark crew', error); return; }
      for (const mesh of person.pickable || []) { mesh.userData.person = person; mesh.userData.cityTarget = { kind: 'runner', id }; }
      this.group.add(person.object);
      person.object.position.set(spot.x, PLAZA_TOP + (spot.action === 'sit' ? 0.06 : 0.02), spot.z);
      face(person, spot.fx, spot.fz);
      person.setAction(spot.action);
      this.crew.set(id, { id, person, quality, crew: true, job: null, status: null });
    });
  }
  /** Back to its own materials before it goes (people's bodies are pooled and reused). */
  dropCrew(crew) { crew.person.object.traverse(node => this.swapGrey(node, false)); crew.person.object.removeFromParent(); crew.person.dispose(); this.crew.delete(crew.id); }
  clearCrew() { for (const crew of [...this.crew.values()]) this.dropCrew(crew); }

  buildDeck(rings) {
    if (this.deck) { this.tintSigns(false); this.dropGreys(); this.group.remove(this.deck.group); disposeAll(this.deck.group); }
    this.rings = rings;
    this.deckDistricts = Boolean(this.world.districts);
    this.deck = buildDeck(rings, { districts: this.deckDistricts });
    this.group.add(this.deck.group);
  }
  /** Offline: the DGX SPARK emblem and the Foundry plaque (their own, possibly cached, materials)
   *  swap to grey copies; online they get their originals back. */
  tintSigns(off) {
    const swap = node => this.swapGrey(node, off);
    this.deck?.sign.traverse(swap);
    this.foundry.plaque.traverse(swap);
    for (const crew of this.crew.values()) crew.person.object.traverse(swap);   // the crew sleeps grey too
  }
  swapGrey(node, off) {
    this.greys ||= new Map();
    if (!node.isMesh || node.userData.outline || !node.material) return;
    if (off && !node.userData.onlineMaterial) {
      const greyOf = material => {
        let grey = this.greys.get(material);
        if (!grey) {
          grey = material.clone(); grey.userData = { shared: true };   // never disposed with the mesh (its map belongs to the original)
          if (grey.map) grey.color?.set('#8e928e');
          else if (grey.color) { const hsl = {}; grey.color.getHSL(hsl); grey.color.setHSL(hsl.h, 0.03, 0.24 + hsl.l * 0.5); }
          if (grey.emissive) { grey.emissive.set('#000000'); grey.emissiveIntensity = 0; }
          this.greys.set(material, grey);
        }
        return grey;
      };
      // People's heads use a material array (skin + face): grey every slot, not just single-material meshes.
      node.userData.onlineMaterial = node.material;
      node.material = Array.isArray(node.material) ? node.material.map(greyOf) : greyOf(node.material);
    } else if (!off && node.userData.onlineMaterial) { node.material = node.userData.onlineMaterial; delete node.userData.onlineMaterial; }
  }
  dropGreys() { for (const grey of this.greys?.values() || []) grey.dispose(); this.greys?.clear(); }
  /** Island-space point just above the DGX SPARK emblem (the HTML "Offline" tag hangs there). */
  signPoint(out = new THREE.Vector3()) { return out.set(0, DECK_Y - 3.4, -(this.deck?.signZ || 0)); }
  /** The latest Spark job for a project (finished or not), from the status history; null when none. */
  lastSparkJob(machines, projectIds) {
    const ids = new Set(projectIds);
    const jobs = (Array.isArray(machines?.jobs) ? machines.jobs : []).filter(j => j && j.machine === 'spark' && ids.has(j.projectId));
    const when = j => Number(j.finished_at) || Number(j.started_at) || 0;
    return jobs.sort((a, b) => when(b) - when(a))[0] || null;
  }

  syncRunners(spark, projectOf, quality) {
    const sorted = [...spark].sort((a, b) => (Number(a.started_at) || 0) - (Number(b.started_at) || 0) || String(a.job).localeCompare(String(b.job)));
    const drawn = sorted.slice(0, RUNNER_CAP);
    const hidden = sorted.length - drawn.length;
    if (hidden !== this.hiddenRunners) {
      this.hiddenRunners = hidden;
      if (hidden > 0) console.info(`City: drawing ${RUNNER_CAP} Spark runners; ${hidden} more active Spark job${hidden === 1 ? ' is' : 's are'} not drawn.`);
    }
    const slots = new Map(), keep = new Set();
    for (const job of drawn) {
      const id = String(job.job);
      const pid = projectOf(job);
      const building = pid ? this.buildings.get(pid) : null;
      const anchor = building ? pid : FOUNDRY;
      const k = slots.get(anchor) || 0; slots.set(anchor, k + 1);
      const spot = building ? building.workSpot(k) : foundrySpot(k);
      // The runner wears the look of the agent most likely driving this job (from this PC), if any.
      const agent = this.agentFor.get(id) || null;
      const lookKey = agent ? `${agent.id}|${JSON.stringify(agent.look || null)}` : '';
      let runner = this.runners.get(id);
      if (runner && (runner.quality !== quality || runner.lookKey !== lookKey)) { this.dropRunner(runner); runner = null; }
      if (!runner) {
        const provider = job.provider === 'claude' || job.provider === 'codex' ? job.provider : 'other';
        let person;
        try { person = this.makePerson(agent?.look || agentAvatar(agent ? agent.id : `spark:${id}`, provider, agent?.name || job.client || 'Spark runner'), { role: 'agent', provider: agent?.provider || provider, quality }); }
        catch (error) { console.error('City: could not create a Spark runner', error); continue; }
        person.setStatus('active');
        person.setAction('work');
        for (const mesh of person.pickable || []) { mesh.userData.person = person; mesh.userData.cityTarget = { kind: 'runner', id }; }
        this.group.add(person.object);
        runner = { id, person, quality, lookKey, spot: null };
        this.runners.set(id, runner);
      }
      keep.add(id);
      runner.job = job; runner.anchor = anchor; runner.agent = agent;
      if (!runner.spot || runner.spot.x !== spot.x || runner.spot.z !== spot.z) {
        runner.spot = spot;
        // Feet on the surface: building work spots are on the lot (plot top), Foundry spots on its plaza.
        let y = PLAZA_TOP;
        if (building) { const c = cellCenter(building.cell.i, building.cell.j); y = Math.abs(spot.x - c.x) < LOT_HALF - 0.25 && Math.abs(spot.z - c.z) < LOT_HALF - 0.25 ? GROUND_Y : 0.05; }
        runner.person.object.position.set(spot.x, y, spot.z);
        face(runner.person, spot.fx, spot.fz);
      }
    }
    for (const runner of [...this.runners.values()]) if (!keep.has(runner.id)) this.dropRunner(runner);
  }
  dropRunner(runner) { runner.person.object.removeFromParent(); runner.person.dispose(); this.runners.delete(runner.id); }
  clearRunners() { for (const runner of [...this.runners.values()]) this.dropRunner(runner); }

  syncGears(byAnchor) {
    for (const [key, gear] of this.gears) if (!byAnchor.has(key)) { gear.mesh.removeFromParent(); this.gears.delete(key); }
    for (const [key, jobs] of byAnchor) {
      let gear = this.gears.get(key);
      if (!gear) {
        const mesh = makeGear();
        mesh.userData.gearId = key;
        this.badges.add(mesh);
        gear = { mesh, phase: (hash(key) % 628) / 100 };
        this.gears.set(key, gear);
      }
      gear.jobs = jobs;
      gear.mesh.scale.setScalar(Math.min(1.5, 0.85 + jobs.length * 0.15));
    }
  }

  update(dt, elapsed, env) {
    pulseSpark(elapsed, env);
    if (this.shown) {
      const particles = this.particles;
      particles.enabled = !env.reducedMotion;
      particles.material.uniforms.uScale.value = this.world.particles.material.uniforms.uScale.value;
      const local = { ...env, particles, offline: this.offline };
      this.buildings.update(dt, elapsed, local);
      this.foundry.update(dt, elapsed, local);
      for (const runner of this.runners.values()) runner.person.update(dt, elapsed);
      for (const crew of this.crew.values()) crew.person.update(dt, elapsed);
      particles.update(dt);
      const s = this.world.island?.group.scale.x || 1;   // follow the island's grow wobble
      if (this.deck) this.deck.group.scale.set(s, 1, s);
    }
    if (!this.gears.size) return;
    const cam = this.world.toLocal(this.world.camera.position, this._cam);   // gears turn to the camera in island space
    for (const [key, gear] of this.gears) {
      const mesh = gear.mesh;
      if (key === 'hq') mesh.position.copy(HQ_GEAR);
      else {
        const building = this.topBuildings.get(key);
        if (!building) { mesh.visible = false; continue; }
        mesh.position.copy(building.topPoint()).y += 0.75;
      }
      mesh.visible = true;
      mesh.rotation.y = Math.atan2(cam.x - mesh.position.x, cam.z - mesh.position.z);
      if (!env.reducedMotion) mesh.rotation.z = -(elapsed * 1.8 + gear.phase);
    }
  }

  /* ---------- queries for the view (points are island space unless noted) ---------- */
  pickables() {
    const out = [];
    if (this.shown) {
      out.push(...this.buildings.pickables(), ...this.foundry.pickables);
      for (const runner of this.runnerList) out.push(...(runner.person.pickable || []));
    }
    for (const gear of this.gears.values()) if (gear.mesh.visible) out.push(gear.mesh);
    return out;
  }
  occluders() { return this.shown && this.deck ? [this.deck.plate] : []; }
  setHover(id, on) { this.buildings.get(id)?.setHover(on); }
  job(id) { return this.jobIndex.get(String(id)) || null; }
  /** A Spark runner (job) or a crew bot ('crew:k', job: null). */
  runner(id) { return this.runners.get(String(id)) || this.crew.get(String(id)) || null; }
  get runnerList() { return [...this.runners.values(), ...this.crew.values()]; }
  /** Active Spark jobs hosted by a project's Spark building (or FOUNDRY). */
  sparkJobs(anchor) { return this.sparkByAnchor.get(anchor) || []; }
  gearJobs(key) { return this.gears.get(key)?.jobs || []; }
  /** WORLD point just over a runner's head (over its status gem, like the top city's people). */
  runnerHead(runner, out = new THREE.Vector3()) {
    const person = runner.person;
    person.object.updateWorldMatrix(true, false);
    const top = Number(person.topY);
    return person.object.localToWorld(out.set(0, (Number.isFinite(top) && top > 0.5 ? top : 1.8) + 0.62, 0));
  }
  foundryPoint() { return new THREE.Vector3(0, DECK_Y - 11.3, 0); }
  gearPoint(key) { const gear = this.gears.get(key); return gear?.mesh.visible ? gear.mesh.position.clone().add(new THREE.Vector3(0, 0.6, 0)) : null; }

  dispose() {
    this.clearRunners(); this.clearCrew();
    this.tintSigns(false); this.dropGreys(); setSparkOffline(false);
    this.buildings.dispose();
    for (const gear of this.gears.values()) gear.mesh.removeFromParent();
    this.gears.clear();
    disposeAll(this.badges); this.badges.removeFromParent();
    this.particles.dispose(); this.particles.points.removeFromParent();
    disposeAll(this.group); this.group.removeFromParent();
  }
}
