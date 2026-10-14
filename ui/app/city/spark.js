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
import { BuildingManager, SPARK_MATERIALS, pulseSpark } from './buildings.js';
import { mergeParts, placed, plaqueTexture, sideTexture, disposeAll, Particles } from './fx.js';
import { PITCH, LOT_HALF, islandHalf, cellCenter } from './layout.js';
import { GROUND_Y, buildSideSign } from './scenery.js';
import { agentAvatar, hash } from '../avatar/spec.js';

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
function buildDeck(rings) {
  const half = islandHalf(rings), size = half * 2, M = SPARK_MATERIALS;
  const group = new THREE.Group(); group.name = 'spark-deck';
  const plate = new THREE.Mesh(placed(new RoundedBoxGeometry(size - 3, 0.8, size - 3, 2, 0.6), { y: -0.4 }), M.board);
  plate.userData.occluder = true;
  plate.castShadow = true; plate.receiveShadow = true;   // shades the face that's down, takes the Spark city's shadows when up
  addOutline(plate, { thickness: 0.08 });
  group.add(plate);
  // Plots are as tall as the top city's lawns, so Spark building pads sit on them (no gap).
  const plots = [], traces = [], vias = [], chips = [], pins = [];
  for (let i = -rings; i <= rings; i++) for (let j = -rings; j <= rings; j++) {
    if (!i && !j) continue;
    const c = cellCenter(i, j);
    plots.push(placed(new THREE.BoxGeometry(LOT_HALF * 2 - 0.4, GROUND_Y, LOT_HALF * 2 - 0.4), { x: c.x, y: GROUND_Y / 2, z: c.z }));
  }
  const extent = (rings + 0.5) * PITCH;
  for (let k = -rings - 1; k <= rings; k++) {
    const line = (k + 0.5) * PITCH;
    traces.push(placed(new THREE.BoxGeometry(0.34, 0.05, extent * 2), { x: line, y: 0.025 }));
    traces.push(placed(new THREE.BoxGeometry(extent * 2, 0.05, 0.34), { z: line, y: 0.025 }));
    for (let q = -rings - 1; q <= rings; q++) vias.push(placed(new THREE.CylinderGeometry(0.46, 0.46, 0.08, 12), { x: line, y: 0.04, z: (q + 0.5) * PITCH }));
  }
  // Border trace round the rim, and a little IC package in each corner.
  const border = extent + 1.2;
  for (const s of [-1, 1]) {
    traces.push(placed(new THREE.BoxGeometry(border * 2 + 0.3, 0.05, 0.3), { z: s * border, y: 0.025 }));
    traces.push(placed(new THREE.BoxGeometry(0.3, 0.05, border * 2 + 0.3), { x: s * border, y: 0.025 }));
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (extent + 2.6), z = sz * (extent + 2.6);
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
  return { group, plate };
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
      if (env.reducedMotion) return;
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
    this.badges = new THREE.Group(); this.badges.name = 'local-job-gears'; world.city.add(this.badges);
    this.gears = new Map();     // anchor (project id | 'hq') → { mesh, jobs, phase }
    this.runners = new Map();   // job id → { id, job, person, anchor, spot, quality }
    this.sparkByAnchor = new Map();
    this.jobIndex = new Map();
    this.deck = null; this.rings = 0; this.shown = false; this.hiddenRunners = 0;
    this._v = new THREE.Vector3(); this._cam = new THREE.Vector3();
  }

  /** shown: Spark side visible; gears: show local-job gears on the top city. */
  sync({ shown, projects, cells, rings, machines, quality = 'high', peopleReady = false, gears = true }) {
    const jobs = Array.isArray(machines?.jobs) ? machines.jobs.filter(j => j && j.active) : [];
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
      if (rings !== this.rings || !this.deck) this.buildDeck(rings);
      // The group is turned about x (local z = -island z): lot (i, -j) here is the other face of lot (i, j).
      const under = new Map();
      for (const [id, cell] of cells) under.set(id, { ...cell, j: -cell.j });
      const busy = new Set([...this.sparkByAnchor.keys()].filter(key => key !== FOUNDRY));
      this.buildings.sync(projects, under, busy, { animate: true });
      this.foundry.setActive(this.sparkByAnchor.has(FOUNDRY));
      if (peopleReady) this.syncRunners(spark, projectOf, quality);
    } else { this.clearRunners(); this.particles.clear(); }
    this.syncGears(gears ? localByAnchor : new Map());
  }

  buildDeck(rings) {
    if (this.deck) { this.group.remove(this.deck.group); disposeAll(this.deck.group); }
    this.rings = rings;
    this.deck = buildDeck(rings);
    this.group.add(this.deck.group);
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
      let runner = this.runners.get(id);
      if (runner && runner.quality !== quality) { this.dropRunner(runner); runner = null; }
      if (!runner) {
        const provider = job.provider === 'claude' || job.provider === 'codex' ? job.provider : 'other';
        let person;
        try { person = this.makePerson(agentAvatar(`spark:${id}`, provider, job.client || 'Spark runner'), { role: 'agent', provider, quality }); }
        catch (error) { console.error('City: could not create a Spark runner', error); continue; }
        person.setStatus('active');
        person.setAction('work');
        for (const mesh of person.pickable || []) { mesh.userData.person = person; mesh.userData.cityTarget = { kind: 'runner', id }; }
        this.group.add(person.object);
        runner = { id, person, quality, spot: null };
        this.runners.set(id, runner);
      }
      keep.add(id);
      runner.job = job; runner.anchor = anchor;
      if (!runner.spot || runner.spot.x !== spot.x || runner.spot.z !== spot.z) {
        runner.spot = spot;
        // Feet on the surface: building work spots are on the lot (plot top), Foundry spots on its plaza.
        let y = PLAZA_TOP;
        if (building) { const c = cellCenter(building.cell.i, building.cell.j); y = Math.abs(spot.x - c.x) < LOT_HALF - 0.25 && Math.abs(spot.z - c.z) < LOT_HALF - 0.25 ? GROUND_Y : 0.05; }
        runner.person.object.position.set(spot.x, y, spot.z);
        runner.person.lookAt(spot.x + spot.fx * 4, spot.z + spot.fz * 4);
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
      const local = { ...env, particles };
      this.buildings.update(dt, elapsed, local);
      this.foundry.update(dt, elapsed, local);
      for (const runner of this.runners.values()) runner.person.update(dt, elapsed);
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
      for (const runner of this.runners.values()) out.push(...(runner.person.pickable || []));
    }
    for (const gear of this.gears.values()) if (gear.mesh.visible) out.push(gear.mesh);
    return out;
  }
  occluders() { return this.shown && this.deck ? [this.deck.plate] : []; }
  setHover(id, on) { this.buildings.get(id)?.setHover(on); }
  job(id) { return this.jobIndex.get(String(id)) || null; }
  runner(id) { return this.runners.get(String(id)) || null; }
  get runnerList() { return [...this.runners.values()]; }
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
    this.clearRunners();
    this.buildings.dispose();
    for (const gear of this.gears.values()) gear.mesh.removeFromParent();
    this.gears.clear();
    disposeAll(this.badges); this.badges.removeFromParent();
    this.particles.dispose(); this.particles.points.removeFromParent();
    disposeAll(this.group); this.group.removeFromParent();
  }
}
