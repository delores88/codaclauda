/* Original City river. Its path is fixed in island coordinates, so expanding the
 * island extends the banks without moving bridges, boats or established lots. */
import { THREE, toonMaterial } from './toon.js';
import { disposeAll, mergeParts, placed, plaqueTexture } from './fx.js';
import { PITCH } from './layout.js';
import { riverZ, riverSlope, RIVER_HALF_WIDTH, RIVER_BANK_WIDTH, WATER_Y, bridgeSpan, bridgeHeight } from './river-path.js';
import { nextBoatAt, selectBoatManifest, boatPass } from './boats.js';

const box = (w, h, d, x, y, z) => placed(new THREE.BoxGeometry(w, h, d), { x, y, z });
const SLAB = 0.18;
function add(group, geometry, material, shadow = false, pickable = false) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = shadow; mesh.receiveShadow = shadow;
  if (!pickable) mesh.raycast = () => {};
  group.add(mesh); return mesh;
}
const solid = (group, geometry, tint, shadow = false) => add(group, geometry, toonMaterial(tint), shadow);

/** A ribbon samples the stable path, with no shared geometries to retain on resize. */
function ribbon(half, a, b, y, step = 1.5) {
  const count = Math.max(2, Math.ceil(half * 2 / step)), positions = [], uv = [], indices = [];
  for (let i = 0; i <= count; i++) {
    const x = -half + i / count * half * 2, z = riverZ(x);
    positions.push(x, y, z + a, x, y, z + b); uv.push(x, 0, x, 1);
    if (i < count) { const n = i * 2; indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2); }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals(); return geometry;
}

function bankGeometry(half, side, step) {
  const count = Math.max(2, Math.ceil(half * 2 / step)), positions = [], indices = [];
  for (let i = 0; i <= count; i++) {
    const x = -half + i / count * half * 2, z = riverZ(x), a = z + side * RIVER_HALF_WIDTH, b = z + side * (RIVER_HALF_WIDTH + RIVER_BANK_WIDTH);
    positions.push(x, WATER_Y + 0.10, a, x, 0.14, b, x, 0, a, x, 0, b);
    if (i < count) {
      const n = i * 4;
      const faces = [n, n + 1, n + 4, n + 1, n + 5, n + 4, n, n + 4, n + 2, n + 2, n + 4, n + 6, n + 1, n + 3, n + 5, n + 3, n + 7, n + 5];
      if (side < 0) for (let k = 0; k < faces.length; k += 3) [faces[k + 1], faces[k + 2]] = [faces[k + 2], faces[k + 1]];
      indices.push(...faces);
    }
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geo.setIndex(indices); geo.computeVertexNormals(); return geo;
}

function waterMaterial(low) {
  if (low) return new THREE.MeshBasicMaterial({ color: '#72bdc8' });
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, night: { value: 0 } },
    vertexShader: 'varying vec2 waterUv; void main(){waterUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `varying vec2 waterUv; uniform float time; uniform float night;
      void main(){
        float shore = smoothstep(0.0,0.17,waterUv.y)*smoothstep(0.0,0.17,1.0-waterUv.y);
        float ripple = sin(waterUv.x*1.6-time*.4+waterUv.y*9.0)*sin(waterUv.x*.7+waterUv.y*18.0+time*.2);
        vec3 day=mix(vec3(.56,.79,.78),vec3(.28,.62,.70),shore);
        vec3 dusk=mix(vec3(.28,.43,.49),vec3(.13,.30,.42),shore);
        vec3 tint=mix(day,dusk,night)+ripple*.024*(1.0-night*.8);
        gl_FragColor=vec4(tint,1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/** Triangular-prism ramp from the ground to the deck, so the rendered walking
 * surface and the pure bridgeHeight query use exactly the same linear slope. */
function rampGeometry(span, near, far, nearY, farY) {
  const positions = [], indices = [], left = span.x - span.halfWidth, right = span.x + span.halfWidth;
  positions.push(left, nearY, near, right, nearY, near, left, farY, far, right, farY, far);
  positions.push(left, 0, near, right, 0, near, left, 0, far, right, 0, far);
  indices.push(0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7);
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geo.setIndex(indices); geo.computeVertexNormals();
  return geo;
}

function beamBetween(a, b, width = 0.10) {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), middle = start.clone().add(end).multiplyScalar(0.5);
  const geometry = new THREE.BoxGeometry(width, start.distanceTo(end), width);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.sub(start).normalize()));
  geometry.translate(middle.x, middle.y, middle.z); return geometry;
}

function makeBoat(manifest, low) {
  const group = new THREE.Group(); group.name = manifest.projectId ? `project-boat:${manifest.projectId}` : 'river-boat';
  group.userData.projectId = manifest.projectId;
  // The keel is below y=0, the deck above it. Group y remains WATER_Y at all times.
  const shape = new THREE.Shape(); shape.moveTo(-1.3, -0.51); shape.lineTo(0.9, -0.55); shape.lineTo(1.55, 0); shape.lineTo(0.9, 0.55); shape.lineTo(-1.3, 0.51); shape.closePath();
  const hull = new THREE.ExtrudeGeometry(shape, { depth: 0.35, bevelEnabled: false, curveSegments: 1 }); hull.rotateX(-Math.PI / 2); hull.translate(0, -0.17, 0);
  solid(group, hull, '#477b8a', !low);
  solid(group, mergeParts([box(2.0, 0.07, 0.9, -0.1, 0.23, 0), box(0.65, 0.5, 0.72, -0.75, 0.51, 0)]), '#efe2c7', !low);
  solid(group, mergeParts([box(0.85, 0.08, 0.88, -0.75, 0.80, 0), box(0.42, 0.22, 0.03, -0.75, 0.59, 0.37), box(0.42, 0.22, 0.03, -0.75, 0.59, -0.37)]), '#405e72', !low);
  if (manifest.projectId) {
    solid(group, box(0.9, 0.38, 0.72, 0.3, 0.46, 0), '#c79c69', !low);
    for (const side of [-1, 1]) {
      const material = new THREE.MeshBasicMaterial({ map: plaqueTexture(manifest.label, { accent: '#498697' }), transparent: true, side: THREE.DoubleSide, toneMapped: false });
      const label = add(group, new THREE.PlaneGeometry(2.2, 0.55), material);
      label.position.set(0, 0.5, side * 0.57); if (side < 0) label.rotation.y = Math.PI;
    }
  }
  return group;
}

export class River {
  constructor(world, { random = Math.random, now = Date.now } = {}) {
    this.world = world; this.random = random; this.now = now; this.quality = world.quality || 'high';
    this.group = new THREE.Group(); this.group.name = 'district-river'; world.land.add(this.group);
    this.projects = []; this.boats = []; this.bridges = []; this.elapsed = world.elapsed || 0; this.waterTime = 0;
    this.nextAt = nextBoatAt(this.elapsed, this.random()); this.startedAt = null;
    this.setBounds({ half: world.half || 29.5 }); this.buildBoats(selectBoatManifest([], this.now()));
  }

  setBounds({ half, crossings } = {}) {
    if (!Number.isFinite(half) || half < 12) return;
    const first = Math.ceil((-half + 3) / PITCH - 0.5), last = Math.floor((half - 3) / PITCH - 0.5);
    const xs = crossings || Array.from({ length: Math.max(0, last - first + 1) }, (_, n) => (first + n + 0.5) * PITCH);
    const signature = JSON.stringify([half, xs, this.quality]); if (signature === this.boundsSignature) return;
    this.boundsSignature = signature; this.half = half; this.crossings = xs;
    if (this.landscape) { this.landscape.removeFromParent(); disposeAll(this.landscape); }
    this.landscape = new THREE.Group(); this.landscape.name = 'river-banks-bridges-dock'; this.group.add(this.landscape); this.bridges = [];
    const low = this.quality === 'low', edge = half - 0.5, step = low ? 3 : 1.2;
    this.water = add(this.landscape, ribbon(edge, -RIVER_HALF_WIDTH, RIVER_HALF_WIDTH, WATER_Y, step), waterMaterial(low)); this.water.name = 'river-water';
    const stones = [];
    for (const side of [-1, 1]) {
      solid(this.landscape, bankGeometry(edge, side, step), '#9abd89');
      for (let x = -edge + 1; x < edge - 0.5; x += low ? 4.2 : 2.7) stones.push(placed(new THREE.IcosahedronGeometry(0.25, 0), { x, y: 0.15, z: riverZ(x) + side * (RIVER_HALF_WIDTH + 0.2), sy: 0.65, sx: 1.35 }));
    }
    if (stones.length) solid(this.landscape, mergeParts(stones), '#a8afa1');
    const supports = [], rails = [], posts = [];
    for (const x of xs) {
      const span = bridgeSpan(x), deckLength = span.deckMaxZ - span.deckMinZ;
      const bridge = new THREE.Group(); bridge.name = `river-bridge:${x}`; this.landscape.add(bridge);
      // A two-millimetre seam overlap prevents Float32 rounding from opening a
      // ray-picking crack where the exact ramp end meets the flat deck.
      const surfaces = [box(span.halfWidth * 2, SLAB, deckLength + 0.004, x, span.deckY - SLAB / 2, (span.deckMinZ + span.deckMaxZ) / 2),
        rampGeometry(span, span.minZ, span.deckMinZ, span.groundY, span.deckY), rampGeometry(span, span.deckMaxZ, span.maxZ, span.deckY, span.groundY)];
      const deck = add(bridge, mergeParts(surfaces), toonMaterial('#c8c9b7'), !low, true);
      deck.userData.riverBridge = true; deck.userData.crossingX = x; this.bridges.push(deck);
      for (const z of [span.deckMinZ - 0.18, span.deckMaxZ + 0.18]) supports.push(box(span.halfWidth * 2, span.deckY - SLAB, 0.35, x, (span.deckY - SLAB) / 2, z));
      for (const side of [-1, 1]) {
        const sx = x + side * (span.halfWidth - 0.10), zs = [span.minZ, span.deckMinZ, span.deckMaxZ, span.maxZ], ys = [span.groundY, span.deckY, span.deckY, span.groundY];
        for (let n = 0; n < 3; n++) {
          rails.push(beamBetween([sx, ys[n] + 0.55, zs[n]], [sx, ys[n + 1] + 0.55, zs[n + 1]], 0.10));
          const segments = Math.ceil((zs[n + 1] - zs[n]) / 1.5);
          for (let k = 0; k < segments; k++) {
            const t = k / segments, z = zs[n] + (zs[n + 1] - zs[n]) * t, y = ys[n] + (ys[n + 1] - ys[n]) * t;
            posts.push(box(0.10, 0.55, 0.10, sx, y + 0.275, z));
          }
        }
        posts.push(box(0.10, 0.55, 0.10, sx, span.groundY + 0.275, span.maxZ));
      }
    }
    if (supports.length) solid(this.landscape, mergeParts(supports), '#9aab9f', !low);
    if (rails.length) solid(this.landscape, mergeParts(rails), '#526f69', !low);
    if (posts.length) solid(this.landscape, mergeParts(posts), '#7b8d80', !low);
    // A dock on each bank at x=0 keeps moored boats between the two nearest bridges.
    const docks = [], piles = [];
    for (const side of [-1, 1]) {
      const z = riverZ(0) + side * (RIVER_HALF_WIDTH + 0.03);
      docks.push(box(5.2, 0.12, 0.74, 0, WATER_Y + 0.20, z));
      for (const x of [-2.2, 2.2]) piles.push(box(0.18, WATER_Y + 0.55, 0.18, x, (WATER_Y + 0.55) / 2, z));
    }
    solid(this.landscape, mergeParts(docks), '#b79873', !low); solid(this.landscape, mergeParts(piles), '#776451', !low);
  }

  pickables() { return this.group.visible ? this.bridges : []; }
  groundAt(x, z) { return this.group.visible ? bridgeHeight(x, z, this.crossings) : null; }

  setProjects(projects = []) {
    this.projects = projects;
    if (this.wasReduced) {
      const manifest = selectBoatManifest(projects, this.now());
      if (JSON.stringify(manifest) !== JSON.stringify(this.manifest)) this.buildBoats(manifest);
    }
  }
  setQuality(quality) {
    if (quality === this.quality) return; this.quality = quality;
    this.setBounds({ half: this.half, crossings: this.crossings }); this.buildBoats(this.manifest || selectBoatManifest(this.projects, this.now()));
  }
  buildBoats(manifest) {
    for (const boat of this.boats) { boat.removeFromParent(); disposeAll(boat); }
    this.manifest = manifest; this.boats = manifest.map(item => makeBoat(item, this.quality === 'low'));
    for (const boat of this.boats) { boat.visible = false; this.group.add(boat); }
  }

  update(dt, elapsed, env = {}) {
    this.elapsed = elapsed; if (env.quality && env.quality !== this.quality) this.setQuality(env.quality);
    const reduced = env.reducedMotion ?? this.world.reducedMotion?.() ?? false, night = Math.max(0, Math.min(1, env.night ?? this.world.current?.night ?? 0));
    if (reduced !== this.wasReduced) { this.startedAt = null; this.nextAt = nextBoatAt(elapsed, this.random()); if (reduced) this.buildBoats(selectBoatManifest(this.projects, this.now())); this.wasReduced = reduced; }
    if (!reduced && this.startedAt === null && elapsed >= this.nextAt) { this.startedAt = elapsed; this.nextAt = nextBoatAt(elapsed, this.random()); this.buildBoats(selectBoatManifest(this.projects, this.now())); }
    if (!reduced) this.waterTime += Math.max(0, dt) * (1 - night * 0.85);
    if (this.water.material.uniforms) { this.water.material.uniforms.time.value = this.waterTime; this.water.material.uniforms.night.value = night; }
    else this.water.material.color.setRGB(0.45 - night * 0.27, 0.74 - night * 0.39, 0.78 - night * 0.35);
    let allDone = this.startedAt !== null;
    this.boats.forEach((boat, index) => {
      let x, offset = 0;
      if (reduced) { x = 0; offset = (index ? -1 : 1) * 1.35; boat.visible = index < 2; }
      else if (this.startedAt !== null) { const pass = boatPass(elapsed, this.startedAt, this.half, index); x = pass.x; boat.visible = pass.visible; if (!pass.done) allDone = false; }
      else { boat.visible = false; return; }
      boat.position.set(x, WATER_Y, riverZ(x) + offset); boat.rotation.y = -Math.atan(riverSlope(x));
    });
    if (allDone) this.startedAt = null;
  }

  dispose() { this.group.removeFromParent(); disposeAll(this.group); this.boats = []; this.bridges = []; this.projects = []; }
}
