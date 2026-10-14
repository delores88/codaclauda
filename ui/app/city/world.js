/* The 3D world: renderer, camera + orbit controls, sky and day/night lighting synced to
 * the local clock, the floating island (grows with the city), clouds, particles and the
 * render loop. Buildings and NPCs live under world.city and are driven by their managers. */
import { THREE } from './toon.js';
import { OrbitControls } from '../../vendor/three/addons/OrbitControls.js';
import { buildIsland, buildRoads, buildDecor, buildHQ, buildClouds, buildSky, lampMaterial, glowMaterial, GROUND_Y } from './scenery.js';
import { Particles, disposeAll } from './fx.js';
import { islandHalf } from './layout.js';
import { setBuildingNight } from './buildings.js';

export function webglAvailable() {
  try { const canvas = document.createElement('canvas'); return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl')); }
  catch { return false; }
}

/* ---------- time of day ---------- */
const PALETTES = {
  night: { top: '#0d1233', horizon: '#2e3466', bottom: '#151a3a', sun: '#aab8ff', sunI: 0.7, hemiSky: '#7882d8', hemiGround: '#2b2545', hemiI: 0.9, ambient: 0.35, fog: '#272c58', night: 1, glow: 0.25, cloud: '#2b3060' },
  dawn: { top: '#6a86dc', horizon: '#ffb592', bottom: '#f6cdb9', sun: '#ffc49c', sunI: 1.7, hemiSky: '#ffdccb', hemiGround: '#6e5c84', hemiI: 0.95, ambient: 0.28, fog: '#f1c2b2', night: 0.3, glow: 0.9, cloud: '#3a2a3a' },
  day: { top: '#62b6ff', horizon: '#d4ecff', bottom: '#eaf4ff', sun: '#fff3dc', sunI: 2.0, hemiSky: '#e4f2ff', hemiGround: '#9a8862', hemiI: 1.0, ambient: 0.25, fog: '#d4ecff', night: 0, glow: 0.55, cloud: '#000000' },
  dusk: { top: '#4b52ad', horizon: '#ff9d7a', bottom: '#ffc6a6', sun: '#ffa070', sunI: 1.55, hemiSky: '#ffb8a0', hemiGround: '#5c4c74', hemiI: 0.9, ambient: 0.26, fog: '#e9a08c', night: 0.5, glow: 1, cloud: '#3a2440' },
};
const KEYFRAMES = [[0, 'night'], [5.2, 'night'], [6.6, 'dawn'], [8.4, 'day'], [16.9, 'day'], [18.6, 'dusk'], [20.2, 'night'], [24, 'night']];
const COLOR_KEYS = ['top', 'horizon', 'bottom', 'sun', 'hemiSky', 'hemiGround', 'fog', 'cloud'];
const NUM_KEYS = ['sunI', 'hemiI', 'ambient', 'night', 'glow'];

export function hourFor(mode, date = new Date()) {
  if (mode === 'day') return 14.5;
  if (mode === 'night') return 22.5;
  return date.getHours() + date.getMinutes() / 60;
}
export function phaseName(hour) { return hour >= 5.2 && hour < 8 ? 'Dawn' : hour >= 8 && hour < 17.6 ? 'Day' : hour >= 17.6 && hour < 20.2 ? 'Dusk' : 'Night'; }
function paletteAt(hour) {
  let k = 0;
  while (k < KEYFRAMES.length - 2 && hour >= KEYFRAMES[k + 1][0]) k++;
  const [h0, a] = KEYFRAMES[k], [h1, b] = KEYFRAMES[k + 1];
  const t = h1 > h0 ? Math.min(1, Math.max(0, (hour - h0) / (h1 - h0))) : 0;
  const s = t * t * (3 - 2 * t), out = {};
  for (const key of COLOR_KEYS) out[key] = new THREE.Color(PALETTES[a][key]).lerp(new THREE.Color(PALETTES[b][key]), s);
  for (const key of NUM_KEYS) out[key] = PALETTES[a][key] + (PALETTES[b][key] - PALETTES[a][key]) * s;
  // Sun arcs from the front-right; the moon hangs high on the left.
  const p = Math.min(1, Math.max(0, (hour - 5.5) / 13.5));
  const az = 0.6 - 1.25 + 2.5 * p, elev = 0.28 + 0.82 * Math.sin(Math.PI * p);
  const sunDir = new THREE.Vector3(Math.sin(az) * Math.cos(elev), Math.sin(elev), Math.cos(az) * Math.cos(elev));
  out.sunDir = sunDir.lerp(new THREE.Vector3(-0.45, 0.82, 0.38).normalize(), out.night).normalize();
  return out;
}

const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class World {
  constructor(container, { quality = 'high', reducedMotion = () => false, timeMode = 'auto' } = {}) {
    this.container = container;
    this.reducedMotion = reducedMotion;
    this.quality = quality;
    this.timeMode = timeMode;
    this.listeners = [];
    this.keys = new Set();
    this.elapsed = 0;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.classList.add('city-canvas');
    renderer.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); this.stop(); this.onContextLost?.(); });
    this.renderer = renderer;
    container.append(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog('#d4ecff', 120, 420);
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 3000);

    this.sky = buildSky(); scene.add(this.sky.group);
    this.hemi = new THREE.HemisphereLight('#e4f2ff', '#9a8862', 1.2);
    this.ambient = new THREE.AmbientLight('#ffffff', 0.3);
    this.sun = new THREE.DirectionalLight('#fff3dc', 2.2);
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 600;
    // Cool bounce light from below: only lit while the Spark underside is shown (constant light count, no shader recompiles).
    this.underLight = new THREE.DirectionalLight('#8d9cff', 0);
    this.underLight.position.set(40, -220, 70);
    scene.add(this.hemi, this.ambient, this.sun, this.sun.target, this.underLight, this.underLight.target);
    this.underside = false;

    this.particles = new Particles(800);
    scene.add(this.particles.points);
    this.hq = buildHQ(); scene.add(this.hq.group);
    this.city = new THREE.Group(); this.city.name = 'city'; scene.add(this.city);
    this.rings = 0; this.half = islandHalf(1);
    this.setRings(1, { animate: false });
    this.setLots(new Map());

    const controls = new OrbitControls(this.camera, renderer.domElement);
    // Mouse wheel and touchpad/mouse pinch (Ctrl+wheel) zoom toward the pointer, like a map.
    Object.assign(controls, { enableDamping: true, dampingFactor: 0.085, screenSpacePanning: false, minDistance: 7, maxPolarAngle: 1.3, minPolarAngle: 0.12, rotateSpeed: 0.55, enableZoom: true, zoomToCursor: true, zoomSpeed: 1.25, panSpeed: 0.95 });
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.addEventListener('start', () => { this.tween = null; this.userMoved = true; });
    this.controls = controls;
    this.limits();
    this.resetView({ instant: true, auto: true });

    this.current = paletteAt(hourFor(timeMode));
    this.setQuality(quality);
    this.applyLighting(this.current);

    this.clock = new THREE.Clock(false);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  /* ---------- island lifecycle ---------- */
  setRings(rings, { animate = true } = {}) {
    if (rings === this.rings) return false;
    const before = this.half;
    for (const key of ['island', 'roads', 'clouds']) if (this[key]) { this.scene.remove(this[key].group); disposeAll(this[key].group); }
    this.rings = rings; this.half = islandHalf(rings);
    this.island = buildIsland(rings); this.roads = buildRoads(rings);
    this.clouds = buildClouds(this.half, this.quality, { under: this.underside });
    this.scene.add(this.island.group, this.roads.group, this.clouds.group);
    this.applyTaper();
    if (this.controls) this.limits();
    this.fitShadow();
    if (animate && !this.reducedMotion() && before) this.islandAnim = { t: 0, from: Math.max(0.86, before / this.half) };
    if (this.current) this.applyLighting(this.current);
    return true;
  }
  setLots(lots) {
    if (this.decor) { this.scene.remove(this.decor); disposeAll(this.decor); }
    this.decor = buildDecor(this.rings, lots, this.half);
    this.scene.add(this.decor);
  }
  /* ---------- Spark underside ---------- */
  /** Show/hide the underside mode: the camera may orbit below the island, the tapering rock under
   * the island makes room for the hanging Spark city, low clouds move aside, a bounce light comes on. */
  setUnderside(on) {
    on = Boolean(on);
    if (on === this.underside) return false;
    this.underside = on;
    this.controls.maxPolarAngle = on ? 2.85 : 1.3;
    this.underLight.intensity = on ? 1.05 : 0;
    this.applyTaper();
    if (this.clouds) {
      this.scene.remove(this.clouds.group); disposeAll(this.clouds.group);
      this.clouds = buildClouds(this.half, this.quality, { under: on });
      this.scene.add(this.clouds.group);
      if (this.current) this.applyLighting(this.current);
    }
    if (!on && this.isUnder) this.flyTo({ ...this.defaultView(), azimuth: this.azimuth }, { auto: true });
    return true;
  }
  applyTaper() { for (const child of this.island?.group.children || []) if (child.userData.taper) child.visible = !this.underside; }
  /** True while the camera is below the island (looking at the Spark side). */
  get isUnder() { return this.camera.position.y < -3; }
  get azimuth() { return new THREE.Spherical().setFromVector3(new THREE.Vector3().subVectors(this.camera.position, this.controls.target)).theta; }
  /** Island slabs: block picking so a hover never reaches through to the other side. */
  occluders() { return this.island ? this.island.group.children.filter(child => child.userData.occluder) : []; }

  limits() {
    this.controls.maxTargetRadius = this.half * 0.95;
    this.controls.maxDistance = 70 + this.half * 1.9;
  }
  fitShadow() {
    const cam = this.sun.shadow.camera, r = this.half + 14;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.updateProjectionMatrix();
  }

  /* ---------- quality and time ---------- */
  setQuality(quality) {
    this.quality = quality;
    const high = quality !== 'low';
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, high ? 2 : 1));
    if (this.renderer.shadowMap.enabled !== high) {
      this.renderer.shadowMap.enabled = high;
      this.sun.castShadow = high;
      this.scene.traverse(node => { const list = Array.isArray(node.material) ? node.material : node.material ? [node.material] : []; for (const m of list) m.needsUpdate = true; });
    }
    this.sun.castShadow = high;
    this.resize();
  }
  setTimeMode(mode) { this.timeMode = mode; this.blending = true; this.timeTick = 0; }
  timeInfo() { const hour = hourFor(this.timeMode); return { mode: this.timeMode, phase: phaseName(hour), night: this.current.night }; }
  applyLighting(p) {
    const u = this.sky.uniforms;
    u.uTop.value.copy(p.top); u.uHorizon.value.copy(p.horizon); u.uBottom.value.copy(p.bottom);
    u.uSunDir.value.copy(p.sunDir); u.uSunColor.value.copy(p.sun); u.uSunGlow.value = p.glow * (1 - p.night * 0.6);
    this.sun.color.copy(p.sun); this.sun.intensity = p.sunI;
    this.sun.position.copy(p.sunDir).multiplyScalar(220); this.sun.target.position.set(0, 0, 0);
    this.hemi.color.copy(p.hemiSky); this.hemi.groundColor.copy(p.hemiGround); this.hemi.intensity = p.hemiI;
    this.ambient.intensity = p.ambient;
    this.scene.fog.color.copy(p.fog);
    this.sky.stars.material.opacity = Math.max(0, (p.night - 0.35) / 0.65);
    const lamp = lampMaterial(); lamp.emissiveIntensity = 0.1 + p.night * 1.6;
    glowMaterial().opacity = Math.max(0, p.night - 0.15) * 0.95;
    if (this.clouds) { this.clouds.material.emissive.copy(p.cloud); this.clouds.material.emissiveIntensity = 0.5; }
    setBuildingNight(p.night);
  }
  /** Lighting follows the clock (checked once a second); a mode switch blends over ~1.5 s. */
  updateTime(dt) {
    this.timeTick = (this.timeTick ?? 0) - dt;
    if (this.timeTick > 0 && !this.blending) return;
    this.timeTick = 1;
    const target = paletteAt(hourFor(this.timeMode));
    const k = this.blending && !this.reducedMotion() ? Math.min(1, dt * 2.5) : 1;
    const c = this.current;
    let delta = 0;
    for (const key of COLOR_KEYS) { c[key].lerp(target[key], k); delta += Math.abs(c[key].r - target[key].r) + Math.abs(c[key].g - target[key].g) + Math.abs(c[key].b - target[key].b); }
    for (const key of NUM_KEYS) { c[key] += (target[key] - c[key]) * k; delta += Math.abs(c[key] - target[key]); }
    c.sunDir.lerp(target.sunDir, k).normalize();
    if (this.blending && delta < 0.02) this.blending = false;
    this.applyLighting(c);
  }

  /* ---------- camera ---------- */
  defaultView() { return { target: new THREE.Vector3(0, 0, 0), distance: Math.min(190, 34 + this.half * 1.75), polar: 0.82, azimuth: 0.62 }; }
  resetView(opts = {}) { this.flyTo(this.defaultView(), opts); }
  /** Ease the camera to { target, distance?, polar?, azimuth? }. Any flight that isn't the city's own
   * auto-framing (auto: true) counts as the owner moving the camera, so auto-framing stops overriding them. */
  flyTo({ target, distance, polar, azimuth }, { instant = false, duration = 0.95, auto = false } = {}) {
    if (!auto) this.userMoved = true;
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls?.target || new THREE.Vector3());
    const from = new THREE.Spherical().setFromVector3(offset);
    if (!this.controls) { this.camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(new THREE.Spherical(distance, polar, azimuth))); return; }
    const to = new THREE.Spherical(
      Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, distance ?? from.radius)),
      Math.min(this.controls.maxPolarAngle, Math.max(this.controls.minPolarAngle, polar ?? from.phi)),
      azimuth ?? from.theta,
    );
    let dTheta = to.theta - from.theta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2; while (dTheta < -Math.PI) dTheta += Math.PI * 2;
    to.theta = from.theta + dTheta;
    this.resetControlMomentum();
    const tween = { t: 0, duration, fromTarget: this.controls.target.clone(), toTarget: target.clone(), from, to };
    if (instant || this.reducedMotion()) { this.applyTween(tween, 1); this.tween = null; }
    else this.tween = tween;
  }
  applyTween(tw, t) {
    const e = easeInOut(t);
    this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
    const s = new THREE.Spherical(tw.from.radius + (tw.to.radius - tw.from.radius) * e, tw.from.phi + (tw.to.phi - tw.from.phi) * e, tw.from.theta + (tw.to.theta - tw.from.theta) * e);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(s));
    this.camera.lookAt(this.controls.target);
  }
  resetControlMomentum() { this.controls?._sphericalDelta?.set(0, 0, 0); this.controls?._panOffset?.set(0, 0, 0); if (this.controls) this.controls._scale = 1; }
  get distance() { return this.camera.position.distanceTo(this.controls.target); }
  zoomBy(factor) { this.flyTo({ target: this.controls.target.clone(), distance: this.distance * factor }, { duration: 0.35 }); }
  rotateBy(angle) {
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    this.camera.position.copy(this.controls.target).add(offset);
  }
  panBy(right, forward) {
    const dir = new THREE.Vector3().subVectors(this.controls.target, this.camera.position); dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const move = side.multiplyScalar(right).add(dir.multiplyScalar(forward));
    this.controls.target.add(move); this.camera.position.add(move);
  }
  keyDown(code) { this.keys.add(code); if (this.tween) this.tween = null; }
  keyUp(code) { this.keys.delete(code); }
  clearKeys() { this.keys.clear(); }
  applyKeys(dt) {
    if (!this.keys.size) return;
    const k = this.keys, speed = this.distance * 0.75 * dt;
    const right = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const forward = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    if (right || forward) { this.panBy(right * speed, forward * speed); this.userMoved = true; this.onKeyPan?.(); }
    const spin = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    if (spin) { this.rotateBy(spin * dt * 1.4); this.userMoved = true; }
  }

  /* ---------- loop ---------- */
  onFrame(fn) { this.listeners.push(fn); }
  get running() { return Boolean(this.raf); }
  start() {
    if (this.raf) return;
    this.clock.start();
    const loop = () => { this.raf = requestAnimationFrame(loop); this.frame(); };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; this.clock.stop(); this.keys.clear(); }
  frame() {
    const dt = Math.min(0.05, this.clock.getDelta() || 0.016);
    this.elapsed += dt;
    const reduced = this.reducedMotion();
    this.particles.enabled = !reduced;
    this.updateTime(dt);
    this.applyKeys(dt);
    if (this.tween) {
      this.tween.t = Math.min(1, this.tween.t + dt / this.tween.duration);
      this.applyTween(this.tween, this.tween.t);
      if (this.tween.t >= 1) this.tween = null;
    } else if (this.follow) {
      const p = this.follow();
      if (p) {
        const goal = new THREE.Vector3(p.x, 1, p.z), delta = goal.sub(this.controls.target).multiplyScalar(reduced ? 1 : Math.min(1, dt * 3));
        this.controls.target.add(delta); this.camera.position.add(delta);
      }
    }
    if (!this.tween) this.controls.update();
    const env = { night: this.current.night, reducedMotion: reduced, particles: this.particles, quality: this.quality };
    if (this.islandAnim) {
      const a = this.islandAnim; a.t = Math.min(1, a.t + dt / 0.9);
      const s = 1 + (a.from - 1) * Math.exp(-5 * a.t) * Math.cos(8 * a.t);
      for (const g of [this.island.group, this.roads.group, this.decor]) g.scale.set(s, 1, s);
      if (a.t >= 1) { for (const g of [this.island.group, this.roads.group, this.decor]) g.scale.set(1, 1, 1); this.islandAnim = null; }
    }
    if (!reduced) {
      for (const child of this.island.group.children) if (child.userData.float) child.position.y = child.userData.float.base + Math.sin(this.elapsed * 0.6 + child.userData.float.phase) * 0.35;
      this.clouds.update(dt);
    }
    this.hq.update(dt, this.elapsed, env);
    for (const fn of this.listeners) fn(dt, this.elapsed, env);
    this.particles.update(dt);
    // Fog follows the zoom so the island stays crisp and the clouds below melt into the sky.
    const d = this.distance;
    this.scene.fog.near = d * 1.1 + 20; this.scene.fog.far = d * 2.6 + 160;
    this.sky.group.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.particles.setViewport(h * this.renderer.getPixelRatio(), this.camera.fov);
    this.size = { w, h };
    if (this.raf === 0 && this.scene) this.renderOnce();
  }
  renderOnce() { try { this.renderer.render(this.scene, this.camera); } catch { /* not ready */ } }

  /* ---------- picking and projection ---------- */
  ndc(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }
  raycast(ndc, objects) {
    this.raycaster ||= new THREE.Raycaster();
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.intersectObjects(objects, false)[0] || null;
  }
  /** Point on the walkable ground under the cursor (inside the island), or null. */
  groundAt(ndc) {
    if (this.camera.position.y < GROUND_Y + 0.3) return null;   // looking up at the underside
    this.raycaster ||= new THREE.Raycaster();
    this.raycaster.setFromCamera(ndc, this.camera);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -GROUND_Y), point)) return null;
    const limit = this.half - 2;
    return Math.abs(point.x) < limit && Math.abs(point.z) < limit ? point : null;
  }
  /** World → container pixels; visible=false when behind the camera or off-screen. */
  project(vector, out = { x: 0, y: 0, visible: false }) {
    this._v ||= new THREE.Vector3();
    this._v.copy(vector).project(this.camera);
    out.x = (this._v.x + 1) / 2 * this.size.w; out.y = (1 - this._v.y) / 2 * this.size.h;
    out.visible = this._v.z < 1 && out.x > -60 && out.x < this.size.w + 60 && out.y > -60 && out.y < this.size.h + 60;
    return out;
  }

  dispose() {
    this.stop();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    disposeAll(this.scene);
    this.particles.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.renderer.domElement.remove();
  }
}
