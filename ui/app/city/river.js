/* Original City river. Fixed shoreline and walking queries are shared with
 * terrain and placement; hulls follow a continuous circuit around both faces. */
import { THREE, toonMaterial, addOutline, INK } from './toon.js';
import { disposeAll, mergeParts, placed, instancedOutline } from './fx.js';
import { riverSection, riverRoadIntervals, sampleRiver, RIVER_HALF_WIDTH, WATER_Y,
  bridgeSpan, bridgeHeight, bridgeAt, bridgeCrossings } from './river-path.js';
import { selectBoatManifest, chooseBoatTypes, boatFleet, loopTiming, loopPhase } from './boats.js';
import { createBoat, updateBoat, addBoatNameLabel, sizeBoatNameLabel } from './boat-models.js';
import { createRiverLoop, riverLoopPose, riverFrame, RIVER_DECK_Y } from './river-loop.js';

const SLAB = .18, RIPPLE_COUNT = 26;
const box = (w, h, d, x, y, z) => placed(new THREE.BoxGeometry(w, h, d), { x, y, z });
const vector = p => new THREE.Vector3(p.x, p.y, p.z);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
// A bank blocks selection from either direction. Raycasting is synchronous;
// restore the shared toon material before any render or another object's query.
function bankRaycast(raycaster, hits) {
  const side = this.material.side;
  try { this.material.side = THREE.DoubleSide; THREE.Mesh.prototype.raycast.call(this, raycaster, hits); }
  finally { this.material.side = side; }
}
function add(group, geometry, material, shadow = false, pickable = false, outline = true) {
  const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = shadow; mesh.receiveShadow = shadow;
  if (!pickable) mesh.raycast = () => {};
  if (outline) addOutline(mesh, { thickness: .012 });
  group.add(mesh); return mesh;
}
function solid(group, parts, color, name, low) {
  if (!parts.length) return null;
  const mesh = add(group, mergeParts(parts), toonMaterial(color), !low); mesh.name = name; return mesh;
}
function geometry(positions, indices, normals, uv) {
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geo.setIndex(indices);
  if (normals) geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3)); else geo.computeVertexNormals();
  if (uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeBoundingBox(); geo.computeBoundingSphere(); return geo;
}
function beam(a, b, width = .1, depth = width) {
  const start = vector(a), end = vector(b), direction = end.clone().sub(start);
  const geo = new THREE.BoxGeometry(width, direction.length(), depth);
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()));
  geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2); return geo;
}
function frameMatrix(pose, scale = 1) {
  return new THREE.Matrix4().makeBasis(vector(pose.forward), vector(pose.up), vector(pose.right))
    .scale(new THREE.Vector3(scale, scale, scale)).setPosition(vector(pose.position));
}
function waterfallRibbon(loop, start, end, step) {
  const count = Math.max(16, Math.ceil((end - start) / step)), positions = [], normals = [], uv = [], indices = [], across = 4;
  // The square island rim and the tangent-normal waterfall lip are different
  // lines. A flat collar joins them explicitly on each face, including Z exits.
  function rim(pose, fraction) {
    const p = pose.position, xEdge = Math.abs(loop.half - Math.abs(p.x)) <= Math.abs(loop.half - Math.abs(p.z));
    if (xEdge) {
      const x = Math.sign(p.x) * loop.half, section = riverSection(x), low = clamp(section.waterMinZ, -loop.half, loop.half), high = clamp(section.waterMaxZ, -loop.half, loop.half);
      const center = clamp(p.z, low, high), z = fraction <= .5 ? low + (center - low) * fraction * 2 : center + (high - center) * (fraction - .5) * 2;
      return { x, y: p.y, z };
    }
    const z = Math.sign(p.z) * loop.half, intervals = riverRoadIntervals('x', z, 0, loop.half);
    const interval = intervals.find(span => p.x >= span.min - .02 && p.x <= span.max + .02);
    const low = clamp(interval?.min ?? p.x - RIVER_HALF_WIDTH, -loop.half, loop.half), high = clamp(interval?.max ?? p.x + RIVER_HALF_WIDTH, -loop.half, loop.half);
    const center = clamp(p.x, low, high), across = pose.right.x >= 0 ? fraction : 1 - fraction;
    const x = across <= .5 ? low + (center - low) * across * 2 : center + (high - center) * (across - .5) * 2;
    return { x, y: p.y, z };
  }
  for (let i = -1; i <= count + 1; i++) {
    const distance = start + (end - start) * clamp(i, 0, count) / count, pose = riverLoopPose(loop, distance / loop.length);
    for (let j = 0; j <= across; j++) {
      const offset = (j / across * 2 - 1) * RIVER_HALF_WIDTH;
      const point = i === -1 || i === count + 1 ? rim(pose, j / across) : { x: pose.position.x + pose.right.x * offset, y: pose.position.y + pose.right.y * offset, z: pose.position.z + pose.right.z * offset };
      positions.push(point.x, point.y, point.z);
      normals.push(pose.up.x, pose.up.y, pose.up.z);
      uv.push(clamp((WATER_Y - point.y) / (2 * WATER_Y - RIVER_DECK_Y), 0, 1), j / across);
      if (i <= count && j < across) { const n = (i + 1) * (across + 1) + j; indices.push(n, n + 1, n + across + 1, n + 1, n + across + 2, n + across + 1); }
    }
  }
  // The rim connector folds in opposite directions on the two channel halves.
  // Keep each face winding aligned with its supplied outward normal so the
  // double-sided toon shader does not invert the lighting on one collar half.
  for (let n = 0; n < indices.length; n += 3) {
    const [a, b, c] = indices.slice(n, n + 3).map(index => index * 3);
    const ab = new THREE.Vector3(positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]);
    const ac = new THREE.Vector3(positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]);
    const outward = new THREE.Vector3(normals[a] + normals[b] + normals[c], normals[a + 1] + normals[b + 1] + normals[c + 1], normals[a + 2] + normals[b + 2] + normals[c + 2]);
    if (ab.cross(ac).dot(outward) < 0) [indices[n + 1], indices[n + 2]] = [indices[n + 2], indices[n + 1]];
  }
  return geometry(positions, indices, normals, uv);
}
function waterMaterial(low, half, fall = false) {
  const material = toonMaterial('#ffffff', { cache: false, side: THREE.DoubleSide, transparent: fall, opacity: fall ? .7 : 1 }); material.vertexColors = true;
  if (fall) { material.depthWrite = false; material.emissive.set('#6db9db'); material.emissiveIntensity = .35; }
  if (!low) {
    const uniforms = { riverTime: { value: 0 }, riverNight: { value: 0 }, riverMotion: { value: 1 }, riverHalf: { value: half } }; material.userData.waterUniforms = uniforms;
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = 'uniform float riverTime; uniform float riverNight; uniform float riverMotion; uniform float riverHalf; varying vec2 riverUv;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        riverUv = uv;
        float rimCalm=smoothstep(0.0,.8,riverHalf-max(abs(position.x),abs(position.z)));
        transformed += normal * sin(position.x*.3+position.z*.2-riverTime*.7)*.03*sin(uv.y*3.14159265)*riverMotion*(1.0-riverNight*.8)*rimCalm;`);
      if (fall) {
        shader.fragmentShader = 'uniform float riverTime; varying vec2 riverUv;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
          float streak = 0.0;
          for (int lane = 0; lane < 4; lane++) {
            float center = .17 + float(lane)*.22;
            float width = 1.0-smoothstep(.006,.019,abs(riverUv.y-center));
            float run = fract(riverUv.x-riverTime*.18+float(lane)*.19);
            float dash = smoothstep(.01,.08,run)*(1.0-smoothstep(.34,.55,run));
            streak = max(streak,width*dash);
          }
          diffuseColor.rgb = mix(diffuseColor.rgb,vec3(1.0),streak*.78);`);
      }
    };
    material.customProgramCacheKey = () => fall ? 'city-waterfall-streaks' : 'city-river-toon-wave';
  }
  return material;
}
/** Water is an open, double-sided sheet. An inflated BackSide hull can become
 * a large black face at a folded rim collar. Trace only its open boundary. */
function outlineWater(mesh) {
  const geo = mesh.geometry, position = geo.getAttribute('position'), normal = geo.getAttribute('normal'), index = geo.index;
  const edges = new Map();
  for (let n = 0; n < index.count; n += 3) {
    const corners = [index.getX(n), index.getX(n + 1), index.getX(n + 2)];
    for (let k = 0; k < 3; k++) {
      const a = corners[k], b = corners[(k + 1) % 3], id = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (edges.has(id)) edges.get(id).count++; else edges.set(id, { a, b, count: 1 });
    }
  }
  const vertices = [];
  for (const { a, b, count } of edges.values()) if (count === 1) {
    const pa = new THREE.Vector3().fromBufferAttribute(position, a), pb = new THREE.Vector3().fromBufferAttribute(position, b);
    if (pa.distanceToSquared(pb) < 1e-8) continue;
    for (const vertex of [a, b]) vertices.push(position.getX(vertex) + normal.getX(vertex) * .002,
      position.getY(vertex) + normal.getY(vertex) * .002, position.getZ(vertex) + normal.getZ(vertex) * .002);
  }
  const outlineGeometry = new THREE.BufferGeometry(); outlineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  const line = new THREE.LineSegments(outlineGeometry, new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: .8, depthWrite: false }));
  line.name = 'water-boundary-ink'; line.userData.outline = true; line.raycast = () => {}; mesh.add(line);
}
function waterColors(mesh, night) {
  const geo = mesh.geometry, uv = geo.getAttribute('uv'), fall = mesh.userData.riverSection % 2;
  let colors = geo.getAttribute('color'); if (!colors) { colors = new THREE.Float32BufferAttribute(new Float32Array(uv.count * 3), 3); geo.setAttribute('color', colors); }
  const underside = mesh.userData.riverSection === 2;
  const edge = new THREE.Color(underside ? '#64c1d0' : '#6cc0de'), center = new THREE.Color(underside ? '#358eac' : '#3f8fc0'), dusk = new THREE.Color('#1f3f66'), fallBlue = new THREE.Color('#bfe6f5'), white = new THREE.Color('#ffffff'), tint = new THREE.Color();
  for (let n = 0; n < uv.count; n++) {
    if (fall) tint.copy(fallBlue).lerp(white, uv.getX(n) * .78).lerp(dusk, night * .4);
    else tint.copy(edge).lerp(center, Math.sin(uv.getY(n) * Math.PI)).lerp(dusk, night);
    colors.setXYZ(n, tint.r, tint.g, tint.b);
  }
  colors.needsUpdate = true;
}

// All bank seams use the terrain's exact x-section envelope. The outer edge is
// y=0; quay parapets sit .35 above it and grassy banks descend to the water.
function bankGeometry(xs, side, half) {
  const positions = [], indices = [], columns = side < 0 ? 5 : 3;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], s = riverSection(x), inner = side < 0 ? s.waterMinZ : s.waterMaxZ, outer = side < 0 ? s.bankMinZ : s.bankMaxZ;
    const profile = side < 0 ? [[inner, WATER_Y - .1], [inner, .35], [inner + (outer - inner) * .28, .35], [inner + (outer - inner) * .28, .02], [outer, 0]]
      : [[inner, WATER_Y - .1], [inner + (outer - inner) * .35, WATER_Y + .18], [outer, 0]];
    for (const [z, y] of profile) positions.push(x, y, clamp(z, -half, half));
    if (i + 1 < xs.length) for (let j = 0; j + 1 < columns; j++) { const n = i * columns + j, next = n + columns;
      if (side > 0) indices.push(n, n + 1, next, n + 1, next + 1, next); else indices.push(n, next, n + 1, n + 1, next, next + 1);
    }
  }
  return geometry(positions, indices);
}
function riverWaterGeometry(xs, underside, half) {
  const positions = [], normals = [], uv = [], indices = [], across = 4, direction = underside ? -1 : 1;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], section = riverSection(x);
    for (let j = 0; j <= across; j++) {
      positions.push(x, underside ? RIVER_DECK_Y - WATER_Y : WATER_Y, clamp(section.waterMinZ + (section.waterMaxZ - section.waterMinZ) * j / across, -half, half));
      normals.push(0, direction, 0); uv.push(x, j / across);
      if (i + 1 < xs.length && j < across) { const n = i * (across + 1) + j, next = n + across + 1;
        const face = [n, n + 1, next, n + 1, next + 1, next];
        if (underside) for (let k = 0; k < face.length; k += 3) [face[k + 1], face[k + 2]] = [face[k + 2], face[k + 1]];
        indices.push(...face);
      }
    }
  }
  return geometry(positions, indices, normals, uv);
}
function bridgePoint(span, along, lateral) { return span.axis === 'x' ? { x: along, z: span.z + lateral } : { x: span.x + lateral, z: along }; }
function bridgeSurface(span, crossings, left, right, offset = 0, bottom = false) {
  const rows = Math.max(4, Math.ceil((span.max - span.min) / .4)), cols = Math.max(1, Math.ceil((right - left) / .4)), positions = [], indices = [];
  for (let i = 0; i <= rows; i++) for (let j = 0; j <= cols; j++) {
    const p = bridgePoint(span, span.min + (span.max - span.min) * i / rows, left + (right - left) * j / cols);
    positions.push(p.x, (bridgeHeight(p.x, p.z, crossings) ?? span.groundY) + offset, p.z);
    if (i < rows && j < cols) { const n = i * (cols + 1) + j, next = n + cols + 1;
      const face = span.axis === 'x' ? [n, n + 1, next, n + 1, next + 1, next] : [n, next, n + 1, n + 1, next, next + 1];
      if (bottom) for (let k = 0; k < face.length; k += 3) [face[k + 1], face[k + 2]] = [face[k + 2], face[k + 1]];
      indices.push(...face);
    }
  }
  return geometry(positions, indices);
}
function mirrorLandscape(top) {
  const result = top.clone(true); result.name = 'river-underside-banks-bridges-docks'; result.position.y = RIVER_DECK_Y; result.scale.y = -1;
  result.traverse(node => { if (node.geometry) node.geometry = node.geometry.clone();
    if (node.material && !node.material.userData.shared) node.material = node.material.clone();
    node.raycast = () => {}; if (node.userData.riverBridge) node.userData.riverBridge = false;
  }); return result;
}

export class River {
  constructor(world, { random = Math.random, now = Date.now } = {}) {
    this.world = world; this.random = random; this.now = now; this.quality = world.quality || 'high';
    this.group = new THREE.Group(); this.group.name = 'district-river'; world.land.add(this.group);
    this.projects = []; this.boats = []; this.slots = []; this.bridges = []; this.waterMeshes = []; this.phase = 0; this.waterTime = 0;
    this.elapsed = world.elapsed || 0; this.typeBag = []; this.lastBoatType = null; this.timingSample = this.random();
    this.fleetCount = this.quality === 'low' ? 2 : 3;
    this.setBounds({ half: world.half || 29.5 }); this.initFleet(); this.renderBoats(); this.placeBoats();
  }
  setBounds({ half, crossings } = {}) {
    if (!Number.isFinite(half) || half < 12) return;
    const spans = (crossings || bridgeCrossings(half)).map(bridgeSpan).filter(Boolean);
    const signature = JSON.stringify([half, spans, this.quality]); if (signature === this.boundsSignature) return;
    this.boundsSignature = signature; this.half = half; this.crossings = spans; this.loop = createRiverLoop(half);
    if (this.landscape) { this.landscape.removeFromParent(); disposeAll(this.landscape); }
    this.landscape = new THREE.Group(); this.landscape.name = 'river-landscape'; this.group.add(this.landscape);
    this.bridges = []; this.waterMeshes = []; this.lastNight = undefined;
    const low = this.quality === 'low', points = sampleRiver(half, low ? 1.6 : .55), count = Math.ceil(half * 2 / (low ? 1.6 : .55));
    const all = Array.from({ length: count + 1 }, (_, n) => -half + n / count * half * 2);
    const inside = x => { const section = riverSection(x); return section.bankMinZ < half && section.bankMaxZ > -half; };
    const xs = all.filter((x, n) => inside(x) || (n && inside(all[n - 1])) || (n < count && inside(all[n + 1]))), top = new THREE.Group(); top.name = 'river-top-banks-bridges-docks';
    this.landscape.add(top);
    add(top, bankGeometry(xs, -1, half), toonMaterial('#c9c2b0'), !low).name = 'downtown-stone-quay';
    add(top, bankGeometry(xs, 1, half), toonMaterial('#7cc56a'), !low).name = 'suburbs-grassy-bank';
    this.buildBanks(top, points, low); this.buildBridges(top, low); this.buildDocks(top, low); this.landscape.add(mirrorLandscape(top));
    this.bankOccluders = [];
    this.landscape.traverse(node => {
      if (node.name === 'downtown-stone-quay' || node.name === 'suburbs-grassy-bank') {
        node.raycast = bankRaycast; node.userData.occluder = true; this.bankOccluders.push(node);
      }
    });
    for (let i = 0; i < 4; i++) {
      const fall = i % 2 === 1, geo = fall ? waterfallRibbon(this.loop, this.loop.joins[i], this.loop.joins[i + 1], low ? 1 : .4) : riverWaterGeometry(xs, i === 2, half);
      const water = add(this.landscape, geo, waterMaterial(low, half, fall), false, false, false); outlineWater(water);
      if (fall) { const ink = water.children[0]; ink.material.color.set('#a8d8e9'); ink.material.opacity = .25; }
      water.name = ['river-water-top', 'river-waterfall-downstream', 'river-water-underside', 'river-waterfall-upstream'][i]; water.userData.riverSection = i; waterColors(water, 0); this.waterMeshes.push(water);
    }
    this.water = this.waterMeshes[0]; this.buildWaterDetails(low); this.refreshTiming(); this.placeBoats();
  }
  buildBanks(top, points, low) {
    const railing = [], posts = [], rocks = [], reeds = [], lamps = [], panels = [], streaks = [];
    const urban = x => ({ x, y: .35, z: riverSection(x).waterMinZ - .10 });
    for (let n = 1; n < points.length; n++) { const a = urban(points[n - 1].x), b = urban(points[n].x);
      if (Math.abs(a.z) < this.half && Math.abs(b.z) < this.half && !bridgeAt(a.x, a.z, this.crossings) && !bridgeAt(b.x, b.z, this.crossings)) railing.push(beam({ ...a, y: .88 }, { ...b, y: .88 }, .065));
    }
    for (let distance = 2; distance < this.loop.riverLength - 2; distance += low ? 5.5 : 3.3) {
      const x = riverLoopPose(this.loop, distance / this.loop.length).position.x, p = urban(x), section = riverSection(x);
      if (Math.abs(p.z) < this.half && !bridgeAt(p.x, p.z, this.crossings)) {
        posts.push(box(.08, .55, .08, p.x, .625, p.z));
        if (Math.floor(distance / (low ? 5.5 : 3.3)) % 4 === 0) {
          lamps.push(box(.08, 2.1, .08, p.x, 1.4, p.z), box(.35, .12, .24, p.x, 2.48, p.z));
          panels.push(box(.25, .025, .16, p.x, 2.4075, p.z));
          for (let k = 0; k < 3; k++) streaks.push(box(.65 - k * .14, .006, .06, p.x + k * .13, WATER_Y + .034, section.waterMinZ + .35 + k * .24));
        }
      }
      const z = section.waterMaxZ + (section.bankMaxZ - section.waterMaxZ) * .46;
      if (!bridgeAt(x, z, this.crossings)) {
        rocks.push(placed(new THREE.IcosahedronGeometry(.22, 0), { x, y: WATER_Y + .23, z, sy: .7, sx: 1.3 }));
        if (!low) for (let k = 0; k < 3; k++) reeds.push(box(.025, .32 + k * .04, .025, x + (k - 1) * .055, WATER_Y + .37, z + k * .035));
      }
    }
    solid(top, railing, '#53605d', 'quay-railing', low); solid(top, posts, '#67736a', 'quay-posts', low);
    solid(top, rocks, '#a6aea0', 'bank-rocks', low); solid(top, reeds, '#72924b', 'bank-reeds', low);
    solid(top, lamps, '#566361', 'quay-lamps', low);
    if (panels.length) add(top, mergeParts(panels), toonMaterial('#fff0c2', { emissive: '#ffdc91', emissiveIntensity: .3, cache: false })).name = 'bridge-lamp-panels';
    if (streaks.length) add(top, mergeParts(streaks), new THREE.MeshBasicMaterial({ color: '#ffdb8c', transparent: true, opacity: 0, depthWrite: false }), false, false, false).name = 'quay-light-streaks';
  }
  buildBridges(top, low) {
    const arches = [], rails = [], posts = [], lamps = [], bulbs = [], walks = [];
    for (const span of this.crossings) {
      const deck = add(top, bridgeSurface(span, this.crossings, -span.halfWidth, span.halfWidth), toonMaterial('#a7aaa2'), !low, true);
      deck.name = `river-bridge:${span.id}`; deck.userData.riverBridge = true; deck.userData.crossing = span; this.bridges.push(deck);
      add(top, bridgeSurface(span, this.crossings, -span.halfWidth, span.halfWidth, -SLAB, true), toonMaterial('#aaa28e'), !low).name = 'bridge-arch-underside';
      for (const side of [-1, 1]) {
        const lateral = side * (span.halfWidth - .10);
        walks.push(bridgeSurface(span, this.crossings, side < 0 ? -span.halfWidth : span.halfWidth - .48, side < 0 ? -span.halfWidth + .48 : span.halfWidth, .008));
        const segments = Math.ceil((span.max - span.min) / .6);
        for (let i = 0; i < segments; i++) {
          const a = bridgePoint(span, span.min + (span.max - span.min) * i / segments, lateral), b = bridgePoint(span, span.min + (span.max - span.min) * (i + 1) / segments, lateral);
          a.y = bridgeHeight(a.x, a.z, this.crossings) ?? span.groundY; b.y = bridgeHeight(b.x, b.z, this.crossings) ?? span.groundY;
          arches.push(beam({ ...a, y: a.y - SLAB / 2 }, { ...b, y: b.y - SLAB / 2 }, SLAB, .23));
          const junction = p => {
            const along = span.axis === 'x' ? p.x : p.z, street = (Math.round(along / 16 - .5) + .5) * 16;
            return Math.abs(along - street) < 3.1 || this.crossings.some(other => other.id !== span.id && p.x >= other.x0 - .2 && p.x <= other.x1 + .2 && p.z >= other.z0 - .2 && p.z <= other.z1 + .2);
          };
          if (a.y > .55 && b.y > .55 && !junction(a) && !junction(b)) rails.push(beam({ ...a, y: a.y + .65 }, { ...b, y: b.y + .65 }, .075));
          if (i % 3 === 0 && a.y > .55 && !junction(a)) posts.push(box(.08, .65, .08, a.x, a.y + .325, a.z));
        }
        for (const along of [span.min + .35, span.max - .35]) { const p = bridgePoint(span, along, lateral), y = bridgeHeight(p.x, p.z, this.crossings) ?? span.groundY;
          lamps.push(box(.10, 2, .10, p.x, y + 1, p.z), box(.38, .13, .30, p.x, y + 2.02, p.z)); bulbs.push(box(.28, .025, .20, p.x, y + 1.9475, p.z));
        }
      }
    }
    solid(top, arches, '#c9c2b0', 'stone-bridge-arches', low); solid(top, walks, '#ede2c8', 'cream-bridge-walks', low);
    solid(top, rails, '#586260', 'bridge-rails', low); solid(top, posts, '#727a70', 'bridge-posts', low); solid(top, lamps, '#566361', 'bridge-end-lamps', low);
    if (bulbs.length) add(top, mergeParts(bulbs), toonMaterial('#fff0c2', { emissive: '#ffdc91', emissiveIntensity: .3, cache: false })).name = 'bridge-lamp-panels';
  }
  buildDocks(top, low) {
    const start = this.loop.start.x + 4, end = this.loop.end.x - 4, center = clamp(0, start, end);
    const candidates = Array.from({ length: Math.max(2, Math.ceil((end - start) / .4) + 1) }, (_, n) => start + (end - start) * n / Math.max(1, Math.ceil((end - start) / .4))).sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
    const footprint = (pose, length, z0, z1) => {
      const corners = [-length / 2, length / 2].flatMap(x => [z0, z1].map(z => ({ x: pose.position.x + pose.forward.x * x + pose.right.x * z, z: pose.position.z + pose.forward.z * x + pose.right.z * z })));
      return { x0: Math.min(...corners.map(p => p.x)), x1: Math.max(...corners.map(p => p.x)), z0: Math.min(...corners.map(p => p.z)), z1: Math.max(...corners.map(p => p.z)) };
    };
    const clear = rect => rect.x0 > -this.half && rect.x1 < this.half && rect.z0 > -this.half && rect.z1 < this.half
      && !this.crossings.some(span => rect.x0 < span.x1 + .15 && rect.x1 > span.x0 - .15 && rect.z0 < span.z1 + .15 && rect.z1 > span.z0 - .15);
    this.moorings = []; this.dockXs = [];
    for (const side of [-1, 1]) {
      const dockX = candidates.find(x => clear(footprint(riverFrame(x, side * (RIVER_HALF_WIDTH + .04)), 6.9, side < 0 ? -1.3 : -.55, side > 0 ? 1.3 : .55))
        && clear(footprint(riverFrame(x, side * (RIVER_HALF_WIDTH - 1.18)), 3.8, -.92, .92))) ?? center;
      this.dockXs.push(dockX); this.dockX = this.dockXs[0];
      const dock = new THREE.Group(); dock.name = side < 0 ? 'downtown-stone-dock' : 'suburbs-wood-dock'; top.add(dock);
      const pose = riverFrame(dockX, side * (RIVER_HALF_WIDTH + .04), WATER_Y + .22); dock.position.copy(vector(pose.position)); dock.quaternion.setFromRotationMatrix(frameMatrix({ ...pose, position: { x: 0, y: 0, z: 0 } }));
      const deck = [], piles = [], stairs = [], color = side < 0 ? '#c9c2b0' : '#b77a45';
      if (low || side < 0) deck.push(box(6.7, .13, 1.05, 0, 0, 0)); else for (let x = -3.15; x <= 3.16; x += .45) deck.push(box(.43, .13, 1.05, x, 0, 0));
      for (const x of [-2.8, 2.8]) for (const z of [-.35, .35]) piles.push(box(.16, .80, .16, x, -.31, z));
      for (let k = 0; k < 4; k++) { const height = .13 + k * .14; stairs.push(box(1.05, height, .26, 0, height / 2 - .065, side * (.43 + k * .23))); }
      solid(dock, deck, color, 'dock-planks', low); solid(dock, piles, side < 0 ? '#a19a89' : '#806750', 'dock-piles', low); solid(dock, stairs, color, 'dock-steps', low);
      this.moorings.push(riverFrame(dockX, side * (RIVER_HALF_WIDTH - 1.18)));
    }
  }
  buildWaterDetails(low) {
    this.ripples = null; this.foam = null; this.rippleOutline = null; this.foamOutline = null; if (low) return;
    const dash = new THREE.BoxGeometry(.55, .008, .055);
    this.ripples = new THREE.InstancedMesh(dash, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: .35, side: THREE.DoubleSide, depthWrite: false }), RIPPLE_COUNT);
    this.ripples.name = 'river-ripples'; this.ripples.raycast = () => {}; this.ripples.frustumCulled = false; this.landscape.add(this.ripples);
    this.rippleOutline = instancedOutline(this.ripples, .004); this.rippleOutline.name = 'river-ripple-outlines'; this.landscape.add(this.rippleOutline);
    this.foam = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(.19, 0), new THREE.MeshBasicMaterial({ color: '#ffffff' }), 96);
    this.foam.name = 'waterfall-foam'; this.foam.raycast = () => {}; this.foam.frustumCulled = false; this.landscape.add(this.foam);
    this.foamOutline = instancedOutline(this.foam, .007); this.foamOutline.name = 'waterfall-foam-outlines'; this.landscape.add(this.foamOutline);
  }
  pickables() { return this.group.visible ? this.bridges : []; }
  occluders() { return this.group.visible ? this.bankOccluders || [] : []; }
  labelPickables() {
    if (!this.group.visible) return [];
    return this.boats.filter(boat => boat.visible).flatMap(boat => (boat.labelPickables || []).filter(label => label.visible));
  }
  getBoat(id) { return this.group.visible ? this.boats.find(boat => boat.userData.boatId === id) || null : null; }
  makeBoat(entry, index) {
    const boat = createBoat(entry, { low: this.quality === 'low' });
    addBoatNameLabel(boat); sizeBoatNameLabel(boat, this.world.camera, this.world.size?.h);
    const id = `${this.wasReduced ? 'moored' : 'loop'}-slot-${index}`, labels = [];
    boat.userData.boatId = id;
    boat.traverse(node => { if (node.userData.mountedLabel) { node.userData.boatId = id; labels.push(node); } });
    boat.labelPickables = labels;
    this.group.add(boat); return boat;
  }
  groundAt(x, z) { return this.group.visible ? bridgeHeight(x, z, this.crossings) : null; }
  refreshTiming() { if (this.loop) this.timing = loopTiming(this.loop.length, { sample: this.timingSample, types: this.slots.map(s => s.type) }); }
  nextType() { const choice = chooseBoatTypes(1, { bag: this.typeBag, previous: this.lastBoatType, random: this.random }); this.typeBag = choice.bag; this.lastBoatType = choice.lastType; return choice.types[0]; }
  entry(type, index) { const manifest = selectBoatManifest(this.projects, this.now()), pivot = index % Math.max(1, manifest.length); return boatFleet([...manifest.slice(pivot), ...manifest.slice(0, pivot)], [type], { random: this.random })[0]; }
  initFleet() { this.slots = Array.from({ length: this.fleetCount }, (_, index) => { const type = this.nextType(); return { type, entry: this.entry(type, index), lap: 0 }; }); this.refreshTiming(); }
  setProjects(projects = []) {
    this.projects = projects;
    if (this.wasReduced) { const signature = JSON.stringify(selectBoatManifest(projects, this.now())); if (signature !== this.mooredManifest) { this.mooredManifest = signature; this.mooredEntries = null; this.renderBoats(); this.placeBoats(); } }
    else if (this.phase === 0) { this.slots.forEach((slot, index) => { slot.entry = this.entry(slot.type, index); }); this.renderBoats(); this.placeBoats(); }
  }
  setQuality(quality) { if (quality === this.quality) return; this.quality = quality; this.setBounds({ half: this.half, crossings: this.crossings }); this.renderBoats(); this.placeBoats(); }
  renderBoats() {
    for (const boat of this.boats) { boat.removeFromParent(); disposeAll(boat); }
    if (this.wasReduced && !this.mooredEntries) { const pair = ['barge', 'sailboat'].map((type, n) => this.entry(type, n)); this.mooredEntries = [...pair, ...pair]; }
    const entries = this.wasReduced ? this.mooredEntries : this.slots.map(slot => slot.entry);
    this.boats = entries.map((entry, index) => this.makeBoat(entry, index)); this.fleet = entries; this.fleetTypes = entries.map(e => e.type);
  }
  placeBoats() {
    if (!this.loop) return;
    this.boats.forEach((boat, index) => { let pose;
      if (this.wasReduced) { pose = this.moorings[index % 2]; if (!pose) return;
        if (index >= 2) pose = { ...pose, position: { ...pose.position, y: RIVER_DECK_Y - WATER_Y }, forward: { x: -pose.forward.x, y: 0, z: -pose.forward.z }, up: { x: 0, y: -1, z: 0 } };
      } else pose = riverLoopPose(this.loop, loopPhase(this.phase, 1, index, this.fleetCount).phase);
      boat.position.copy(vector(pose.position)); boat.quaternion.setFromRotationMatrix(frameMatrix({ ...pose, position: { x: 0, y: 0, z: 0 } })); boat.visible = true; boat.userData.loopSection = pose.section || (index >= 2 ? 'moored-underside' : 'moored-top');
    });
  }
  update(dt, elapsed, env = {}) {
    this.elapsed = elapsed; if (env.quality && env.quality !== this.quality) this.setQuality(env.quality);
    const reduced = Boolean(env.reducedMotion ?? this.world.reducedMotion?.()), night = clamp(env.night ?? this.world.current?.night ?? 0, 0, 1), low = this.quality === 'low';
    if (reduced !== Boolean(this.wasReduced)) { this.wasReduced = reduced; this.mooredManifest = JSON.stringify(selectBoatManifest(this.projects, this.now())); this.mooredEntries = null; this.renderBoats(); }
    if (!reduced) {
      this.phase += Math.max(0, dt) * this.timing.speed / this.loop.length; this.waterTime += Math.max(0, dt) * (1 - night * .85);
      this.slots.forEach((slot, index) => { const { lap } = loopPhase(this.phase, 1, index, this.fleetCount);
        if (lap > slot.lap) { for (let turn = slot.lap; turn < lap; turn++) slot.type = this.nextType(); slot.lap = lap; slot.entry = this.entry(slot.type, index);
          const old = this.boats[index]; old.removeFromParent(); disposeAll(old); this.boats[index] = this.makeBoat(slot.entry, index); this.refreshTiming(); }
      }); this.fleet = this.slots.map(s => s.entry); this.fleetTypes = this.slots.map(s => s.type);
    }
    this.placeBoats(); this.boats.forEach(boat => {
      updateBoat(boat, reduced ? 0 : dt, this.waterTime, { night, reducedMotion: reduced, low });
      sizeBoatNameLabel(boat, this.world.camera, this.world.size?.h);
    });
    for (const water of this.waterMeshes) { const uniforms = water.material.userData.waterUniforms;
      if (water.userData.riverSection % 2) water.material.emissiveIntensity = .35 - night * .22;
      if (uniforms) { uniforms.riverTime.value = this.waterTime; uniforms.riverNight.value = night; uniforms.riverMotion.value = Number(!reduced); }
      if (this.lastNight === undefined || Math.abs(this.lastNight - night) > .004) waterColors(water, night);
    }
    if (this.lastNight === undefined || Math.abs(this.lastNight - night) > .004) this.lastNight = night;
    this.landscape.traverse(node => { if (node.name === 'bridge-lamp-panels') node.material.emissiveIntensity = .2 + night * .8; if (node.name === 'quay-light-streaks') node.material.opacity = night * .35; });
    if (this.ripples) { this.ripples.visible = !reduced; this.rippleOutline.visible = !reduced; this.ripples.material.opacity = .32 - night * .20;
      for (let n = 0; n < RIPPLE_COUNT; n++) { const distance = ((n * .6180339 + this.waterTime * .002) % 1) * (this.loop.riverLength - 4) + 2;
        const pose = riverLoopPose(this.loop, (n % 2 ? this.loop.riverLength + this.loop.arcLength + distance : distance) / this.loop.length), offset = Math.sin(n * 2.7) * (RIVER_HALF_WIDTH - 1);
        pose.position.x += pose.right.x * offset; pose.position.z += pose.right.z * offset; pose.position.y += pose.up.y * .045;
        this.ripples.setMatrixAt(n, frameMatrix(pose, .55 + (n % 4) * .22));
      } this.ripples.instanceMatrix.needsUpdate = true;
    }
    if (this.foam) { this.foam.visible = !reduced; this.foamOutline.visible = !reduced;
      // Four contact bands: both top lips and both joins onto the Spark face.
      // Foam stays on those joins instead of orbiting the whole waterfall curl.
      for (let n = 0; n < this.foam.count; n++) {
        const join = this.loop.joins[1 + Math.floor(n / 24)], across = ((n % 24) / 23 * 2 - 1) * (RIVER_HALF_WIDTH - .18);
        const pose = riverLoopPose(this.loop, join / this.loop.length), drift = Math.sin(n * 2.3 + this.waterTime) * .035;
        pose.position.x += pose.right.x * across + pose.up.x * .035 + pose.forward.x * drift;
        pose.position.z += pose.right.z * across + pose.up.z * .035 + pose.forward.z * drift;
        pose.position.y += pose.up.y * .035 + pose.forward.y * drift;
        const matrix = frameMatrix(pose); matrix.scale(new THREE.Vector3(1.1, .3, 1.2 + Math.sin(n * 1.7) * .15));
        this.foam.setMatrixAt(n, matrix);
      } this.foam.instanceMatrix.needsUpdate = true;
    }
  }
  dispose() { this.group.removeFromParent(); disposeAll(this.group); this.boats = []; this.bridges = []; this.bankOccluders = []; this.slots = []; this.projects = []; }
}
