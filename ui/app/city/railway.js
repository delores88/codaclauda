/* Original City railway: one straight pair of rails separates the districts.
 * The track furniture is instanced or merged; no sound, physics or extra shadows
 * in low quality. This manager owns and disposes every geometry/label it creates. */
import { THREE, toonMaterial } from './toon.js';
import { disposeAll, mergeParts, placed, plaqueTexture } from './fx.js';
import { PITCH, ROAD } from './layout.js';
import { GROUND_Y } from './scenery.js';
import { nextTrainAt, selectTrainCars, trainPass, crossingWarning, TRAIN_CAR_PITCH } from './train.js';

const TRACK_Z = -PITCH / 2;
const COLORS = { bed: '#777d83', rail: '#c4ced4', timber: '#6d5143', dark: '#273748', cream: '#f4dbb6', engine: '#237e9c', cargo: '#d58b53', roof: '#315169' };
const box = (w, h, d, x, y, z) => placed(new THREE.BoxGeometry(w, h, d), { x, y, z });

function addMesh(group, geometry, material, shadow = false) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = shadow; mesh.receiveShadow = shadow;
  mesh.raycast = () => {};
  group.add(mesh); return mesh;
}
function solid(group, geometry, color, shadow = false) { return addMesh(group, geometry, toonMaterial(color), shadow); }

function instances(group, positions, geometry, material) {
  if (!positions.length) { geometry.dispose(); if (!material.userData.shared) material.dispose(); return null; }
  const mesh = new THREE.InstancedMesh(geometry, material, positions.length), matrix = new THREE.Matrix4();
  positions.forEach(([x, y, z], i) => { matrix.makeTranslation(x, y, z); mesh.setMatrixAt(i, matrix); });
  mesh.instanceMatrix.needsUpdate = true; mesh.raycast = () => {};
  group.add(mesh); return mesh;
}

function sign(group, text, x, y, z, width = 4, accent = '#237e9c') {
  const material = new THREE.MeshBasicMaterial({ map: plaqueTexture(text, { accent }), transparent: true, side: THREE.DoubleSide, toneMapped: false });
  const mesh = addMesh(group, new THREE.PlaneGeometry(width, width / 4), material);
  mesh.position.set(x, y, z); return mesh;
}

function wheelGeometry(low, x, z) {
  if (low) return box(0.46, 0.46, 0.2, x, 0.47, z);
  return placed(new THREE.CylinderGeometry(0.26, 0.26, 0.18, 10), { x, y: 0.47, z, rx: Math.PI / 2 });
}

function rollingStock(car, index, low) {
  const group = new THREE.Group(), engine = index === 0;
  group.name = engine ? 'city-locomotive' : car.projectId ? `commit-car:${car.projectId}` : 'empty-car';
  group.userData.projectId = car.projectId;
  const wheels = [box(2.9, 0.22, 1.12, 0, 0.64, 0)];
  for (const x of [-0.9, 0.9]) for (const z of [-0.62, 0.62]) wheels.push(wheelGeometry(low, x, z));
  wheels.push(box(0.4, 0.12, 0.18, -1.65, 0.62, 0));
  solid(group, mergeParts(wheels), COLORS.dark, !low);
  if (engine) {
    solid(group, mergeParts([
      box(1.8, 0.9, 1.12, 0.4, 1.14, 0), box(1.0, 1.38, 1.25, -0.92, 1.38, 0),
    ]), COLORS.engine, !low);
    solid(group, mergeParts([
      box(1.22, 0.14, 1.44, -0.92, 2.13, 0), box(0.3, 0.38, 0.32, 0.85, 1.77, 0),
      box(0.55, 0.4, 0.025, -0.92, 1.75, 0.64), box(0.55, 0.4, 0.025, -0.92, 1.75, -0.64),
    ]), COLORS.dark, !low);
    solid(group, box(0.11, 0.2, 1.16, 1.35, 0.82, 0), COLORS.cream, !low);
    const lightMaterial = new THREE.MeshBasicMaterial({ color: '#fff0bd', toneMapped: false });
    const light = addMesh(group, new THREE.CircleGeometry(0.2, low ? 6 : 12), lightMaterial);
    light.rotation.y = Math.PI / 2; light.position.set(1.36, 1.27, 0);
    // A translucent ground wedge communicates the headlight without adding a scene light.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([1.4, 0.22, -0.2, 8, 0.22, -1.3, 8, 0.22, 1.3, 1.4, 0.22, 0.2], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]); geometry.computeVertexNormals();
    const beam = addMesh(group, geometry, new THREE.MeshBasicMaterial({ color: '#fff0ad', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    beam.visible = false; group.userData.headlight = light; group.userData.beam = beam;
  } else {
    const parts = [box(2.7, 0.18, 1.22, 0, 0.84, 0)];
    for (const z of [-0.58, 0.58]) parts.push(box(2.7, 0.35, 0.1, 0, 1.06, z));
    for (const x of [-1.3, 1.3]) parts.push(box(0.1, 0.35, 1.2, x, 1.06, 0));
    solid(group, mergeParts(parts), car.projectId ? COLORS.cargo : COLORS.cream, !low);
    if (car.projectId) {
      solid(group, box(2.25, 0.65, 1.0, 0, 1.27, 0), index % 2 ? '#688b91' : '#b98e66', !low);
      sign(group, car.label, 0, 1.33, 0.64, 2.7, COLORS.engine);
      const back = sign(group, car.label, 0, 1.33, -0.64, 2.7, COLORS.engine); back.rotation.y = Math.PI;
    }
  }
  group.position.x = -index * TRAIN_CAR_PITCH;
  return group;
}

export class Railway {
  constructor(world, { random = Math.random, now = Date.now } = {}) {
    this.world = world; this.random = random; this.now = now;
    this.group = new THREE.Group(); this.group.name = 'district-railway'; world.land.add(this.group);
    this.quality = world.quality || 'high'; this.projects = []; this.signals = []; this.cars = [];
    this.nextAt = nextTrainAt(world.elapsed || 0, this.random()); this.startedAt = null; this.elapsed = world.elapsed || 0;
    this.setBounds({ half: world.half || 29.5 });
    this.buildTrain(selectTrainCars([], this.now()));
  }

  setBounds({ half, trackZ = TRACK_Z, crossings } = {}) {
    if (!Number.isFinite(half) || half < 12) return;
    const first = Math.ceil((-half + 2) / PITCH - 0.5), last = Math.floor((half - 2) / PITCH - 0.5);
    const xs = crossings || Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => (first + i + 0.5) * PITCH);
    const signature = JSON.stringify([half, trackZ, xs, this.quality]);
    if (signature === this.boundsSignature) return;
    this.boundsSignature = signature; this.half = half; this.trackZ = trackZ; this.crossings = xs;
    if (this.track) { this.track.removeFromParent(); disposeAll(this.track); }
    this.track = new THREE.Group(); this.track.name = 'rails-crossings-station'; this.group.add(this.track);
    this.track.position.set(0, GROUND_Y, trackZ); this.signals = [];
    const low = this.quality === 'low', span = half * 2 - 1;
    solid(this.track, box(span, 0.1, 3.5, 0, 0.06, 0), COLORS.bed);
    const sleepers = [];
    for (let x = -half + 0.7; x < half - 0.5; x += low ? 1.35 : 0.95) sleepers.push([x, 0.15, 0]);
    instances(this.track, sleepers, new THREE.BoxGeometry(0.24, 0.13, 2.15), toonMaterial(COLORS.timber));
    solid(this.track, mergeParts([box(span, 0.14, 0.13, 0, 0.24, -0.64), box(span, 0.14, 0.13, 0, 0.24, 0.64)]), COLORS.rail);
    const poles = [], housings = [], signs = [], planks = [], signalPositions = [];
    for (const x of xs) {
      // Flush timber deck crosses the ballast; rail heads remain visible through it.
      planks.push(box(ROAD, 0.09, 3.9, x, 0.2, 0));
      for (const side of [-1, 1]) {
        const sx = x + side * (ROAD / 2 + 0.28), sz = side * 1.92;
        poles.push(box(0.12, 1.6, 0.12, sx, 0.8, sz));
        housings.push(box(0.7, 0.32, 0.2, sx, 1.52, sz));
        for (let bulb = 0; bulb < 2; bulb++) {
          signalPositions.push([sx + (bulb ? 0.18 : -0.18), 1.52, sz + side * 0.13]);
          this.signals.push({ x, bulb, index: this.signals.length, lit: false });
        }
        for (const angle of [-0.7, 0.7]) signs.push(placed(new THREE.BoxGeometry(0.65, 0.11, 0.11), { x: sx, y: 1.93, z: sz, rz: angle }));
      }
    }
    if (planks.length) solid(this.track, mergeParts(planks), '#a3947c');
    if (poles.length) solid(this.track, mergeParts(poles), COLORS.cream, !low);
    if (housings.length) solid(this.track, mergeParts(housings), COLORS.dark);
    if (signs.length) solid(this.track, mergeParts(signs), '#e8c97e');
    this.signalMesh = instances(this.track, signalPositions, new THREE.SphereGeometry(0.105, low ? 4 : 8, low ? 3 : 6), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }));
    this.signalColor = new THREE.Color('#653c3b');
    if (this.signalMesh) for (const signal of this.signals) this.signalMesh.setColorAt(signal.index, this.signalColor);
    // Portal shelters keep entering/leaving cars within the island footprint.
    const portals = [];
    for (const side of [-1, 1]) {
      const x = side * (half - 2);
      portals.push(box(3.7, 0.28, 2.7, x, 2.6, 0));
      for (const z of [-1.18, 1.18]) portals.push(box(3.7, 2.6, 0.28, x, 1.3, z));
    }
    solid(this.track, mergeParts(portals), '#6b7a89', !low);
    // The short platform fits between road crossings and inside the rail corridor.
    const stationX = -half + 10.5;
    solid(this.track, box(5.1, 0.22, 0.7, stationX, 0.23, 1.66), '#d3c5ad');
    solid(this.track, mergeParts([box(0.12, 2.05, 0.12, stationX - 2.2, 1.2, 1.78), box(0.12, 2.05, 0.12, stationX + 2.2, 1.2, 1.78)]), COLORS.cream, !low);
    solid(this.track, box(5.2, 0.16, 1.0, stationX, 2.26, 1.6), COLORS.roof, !low);
    sign(this.track, 'City Station', stationX, 1.92, 2.12, 3.4);
    if (this.train) this.train.position.z = trackZ;
  }

  setProjects(projects = []) {
    this.projects = projects;
    if (this.wasReduced) {
      const manifest = selectTrainCars(this.projects, this.now());
      if (JSON.stringify(manifest) !== JSON.stringify(this.manifest)) this.buildTrain(manifest);
    }
  }

  setQuality(quality) {
    if (this.quality === quality) return;
    this.quality = quality;
    this.setBounds({ half: this.half, trackZ: this.trackZ, crossings: this.crossings });
    this.buildTrain(this.manifest || selectTrainCars(this.projects, this.now()));
  }

  buildTrain(manifest) {
    if (this.train) { this.train.removeFromParent(); disposeAll(this.train); }
    this.manifest = manifest; this.train = new THREE.Group(); this.train.name = 'commit-train'; this.group.add(this.train);
    this.train.position.set(0, GROUND_Y, this.trackZ);
    this.cars = [{ projectId: null, label: '' }, ...manifest].map((car, i) => rollingStock(car, i, this.quality === 'low'));
    this.train.add(...this.cars); this.train.visible = false;
  }

  update(dt, elapsed, env = {}) {
    this.elapsed = elapsed;
    if (env.quality && env.quality !== this.quality) this.setQuality(env.quality);
    const reduced = env.reducedMotion ?? this.world.reducedMotion?.() ?? false;
    if (reduced !== this.wasReduced) {
      this.startedAt = null; this.nextAt = nextTrainAt(elapsed, this.random());
      if (reduced) this.buildTrain(selectTrainCars(this.projects, this.now()));
      this.wasReduced = reduced;
    }
    if (!reduced && this.startedAt === null && elapsed >= this.nextAt) {
      this.startedAt = elapsed; this.nextAt = nextTrainAt(elapsed, this.random());
      this.buildTrain(selectTrainCars(this.projects, this.now()));
    }
    const count = this.manifest.length;
    if (reduced) {
      // Entire consist stays on the island, immediately beside the platform.
      this.train.position.x = -this.half + 5 + count * TRAIN_CAR_PITCH;
      this.train.visible = true; for (const car of this.cars) car.visible = true;
    } else if (this.startedAt !== null) {
      const pass = trainPass(elapsed, this.startedAt, this.half, count);
      this.train.position.x = pass.x; this.train.visible = !pass.done;
      if (pass.done) this.startedAt = null;
      for (const car of this.cars) car.visible = Math.abs(pass.x + car.position.x) <= this.half - 2;
    } else this.train.visible = false;
    const night = Math.max(0, Math.min(1, env.night ?? this.world.current?.night ?? 0));
    const engine = this.cars[0], headlight = engine.userData.headlight, beam = engine.userData.beam;
    headlight.material.color.set(night > 0.2 ? '#fff0bd' : '#b9c4c6');
    beam.visible = night > 0.2 && engine.visible && this.quality !== 'low' && this.train.position.x < this.half - 10;
    beam.material.opacity = night * 0.15;
    const departure = this.startedAt ?? this.nextAt, blink = Math.floor(elapsed * 3) % 2;
    let signalsChanged = false;
    for (const signal of this.signals) {
      const warning = !reduced && crossingWarning(elapsed, departure, signal.x, this.half, count);
      const lit = warning && signal.bulb === blink;
      if (lit !== signal.lit) {
        signal.lit = lit; signalsChanged = true;
        this.signalMesh.setColorAt(signal.index, this.signalColor.set(lit ? '#ff433e' : '#653c3b'));
      }
    }
    if (signalsChanged) this.signalMesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.group.removeFromParent(); disposeAll(this.group);
    this.cars = []; this.signals = []; this.projects = [];
  }
}
