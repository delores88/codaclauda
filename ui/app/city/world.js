/* The 3D world: renderer, camera + orbit controls, sky and day/night lighting synced to
 * the local clock, the floating island (grows with the city), clouds, particles and the
 * render loop. Buildings and NPCs live under world.city and are driven by their managers.
 *
 * Everything that belongs to the island (slabs, roads, decor, HQ, buildings, people, the
 * Spark side and their particles) sits under ONE pivot at the island's middle (world.pivot →
 * world.land). With the Spark side on, the island can be physically turned over: a vertical
 * left-drag tilts it about the camera's screen-right axis (horizontal drags still orbit), the
 * flip button / V rolls it a half turn, and on release it always settles flat with one face up.
 * Sky, sun/moon, clouds, lights and the camera stay in world space, so the face that is up is
 * the sunlit one and the face that is down is shaded. The camera never goes below the island.
 * world.land's local space is "island space" (top ground at y = GROUND_Y); toWorld / toLocal
 * convert, and the two agree while This PC is up and the island has not been turned. */
import { THREE } from './toon.js';
import { OrbitControls } from '../../vendor/three/addons/OrbitControls.js';
import { buildIsland, buildRoads, buildDecor, buildHQ, buildClouds, buildSky, lampMaterial, glowMaterial, GROUND_Y } from './scenery.js';
import { Particles, disposeAll } from './fx.js';
import { islandHalf } from './layout.js';
import { setBuildingNight } from './buildings.js';
import { DECK_Y } from './spark.js';

/* ---------- turning the island over ---------- */
/** Island-space height of the pivot: midway between the two faces, so either face rests at the same height. */
export const PIVOT_Y = (GROUND_Y + DECK_Y) / 2;
export const TILT_POLAR = 0.82;          // the overview's camera pitch (polar angle); closer in, see polarForDistance
const TILT_PX = 420;                     // vertical drag for a half turn
const TILT_DEADZONE = 8;                 // px before a vertical drag starts tilting (clicks stay clicks)
const FLIP_SECONDS = 0.9;
const SPRING_K = 95, SPRING_ZETA = 0.72; // settle spring: visibly flat in ~0.6 s, ~4 % overshoot
const SWEEP_RISE = 24;                   // how far buildings reach from the pivot, for the sweep radius
const CLOUD_MARGIN = 10;
const UP = new THREE.Vector3(0, 1, 0), X_AXIS = new THREE.Vector3(1, 0, 0);

/** Nearest flat resting angle (a multiple of π: one face exactly up) for a tilt angle; a flick
 * leads by its velocity, so a quick drag carries the island over. Pure. */
export function settleTarget(angle, velocity = 0, lead = 0.12) {
  const target = Math.round((angle + velocity * lead) / Math.PI) * Math.PI;
  return Object.is(target, -0) ? 0 : target;
}
/** One damped-spring step toward target (semi-implicit Euler, sub-stepped). Pure. */
export function springStep(angle, velocity, target, dt, k = SPRING_K, zeta = SPRING_ZETA) {
  const damping = 2 * zeta * Math.sqrt(k), steps = Math.max(1, Math.ceil(dt / 0.008)), h = dt / steps;
  for (let n = 0; n < steps; n++) { velocity += (-k * (angle - target) - damping * velocity) * h; angle += velocity * h; }
  const done = Math.abs(angle - target) < 0.0015 && Math.abs(velocity) < 0.02;
  return { angle: done ? target : angle, velocity: done ? 0 : velocity, done };
}
/** Flip curve 0 → 1: slow start, then an ease-out with a small settle overshoot (about 2.6 %). Pure. */
export function flipEase(t, c = 1.2) {
  t = Math.min(1, Math.max(0, t));
  if (t < 0.5) return 0.5 * Math.pow(2 * t, 3 + c);
  const v = 2 * t - 2;
  return 0.5 + 0.5 * (1 + (c + 1) * v * v * v + c * v * v);
}
/** World y of the island's up axis under orientation q: > 0 This PC face up, < 0 Spark face up. */
const upY = q => 1 - 2 * (q.x * q.x + q.z * q.z);
/** Snap an orientation to the exact flat one it is closest to: yaw, or yaw then a half turn about x. */
function flatten(q) {
  const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const out = new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(-x.z, x.x));
  if (upY(q) < 0) out.multiply(new THREE.Quaternion().setFromAxisAngle(X_AXIS, Math.PI));
  return out;
}

/* WHEEL-ZOOM-BEGIN (pure: checked headless) */
/** One wheel event → a zoom step in log units (+ zooms out, − zooms in). deltaMode 1 (lines) counts
 * 16 px, 2 (pages) 800 px; a pinch (ctrlKey: touchpad or Ctrl+wheel) is 4× stronger per unit than a
 * plain scroll. One event is capped so a burst of huge deltas can't throw the camera. */
export function wheelZoomLog({ deltaY = 0, deltaMode = 0, ctrlKey = false } = {}) {
  const d = Number(deltaY) * (deltaMode === 1 ? 16 : deltaMode === 2 ? 800 : 1);
  if (!Number.isFinite(d) || !d) return 0;
  return Math.max(-0.6, Math.min(0.6, d * (ctrlKey ? 0.0064 : 0.0016)));
}
/** Queue a zoom: add log to what is still pending, kept inside [min, max] distance so a zoom-in
 * that overshoots the limit never delays the next zoom-out. Pure. */
export function queueZoomLog(pending, log, distance, min, max) {
  const lo = Math.log(min / distance), hi = Math.log(max / distance);
  return Math.max(Math.min(lo, 0), Math.min(Math.max(hi, 0), pending + log));
}
/* WHEEL-ZOOM-END */

/* PITCH-BEGIN (pure: checked headless) */
/** Zoom-linked pitch (polar angle from straight down; π/2 is level). far: the overview (TILT_POLAR) at
 * farD and beyond; near: almost level at nearD (the closest zoom), so the view runs out across the
 * island. eye: how far the orbit target rises above the ground at nearD (standing height), fading out
 * by eyeD. up / down: how far a vertical drag may tilt away from the curve (Spark side off). */
export const ZOOM_PITCH = { far: TILT_POLAR, near: 1.48, farD: 40, nearD: 3, eye: 1.6, eyeD: 14, min: 0.12, max: 1.52, up: 0.4, down: 0.2, ease: 3.5 };
const smooth01 = t => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
/** Camera pitch for an orbit distance: smoothstep in log(distance) from near (nearD) to far (farD). Pure. */
export function polarForDistance(d, p = ZOOM_PITCH) {
  const u = Math.log(Math.max(1e-6, d) / p.nearD) / Math.log(p.farD / p.nearD);
  return p.near + (p.far - p.near) * smooth01(u);
}
/** How far the orbit target sits above the ground at an orbit distance (0 from eyeD out). Pure. */
export function eyeLiftForDistance(d, p = ZOOM_PITCH) {
  return p.eye * (1 - smooth01(Math.log(Math.max(1e-6, d) / p.nearD) / Math.log(p.eyeD / p.nearD)));
}
/* PITCH-END */

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
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.25, 3000);

    this.sky = buildSky(); scene.add(this.sky.group);
    this.hemi = new THREE.HemisphereLight('#e4f2ff', '#9a8862', 1.2);
    this.ambient = new THREE.AmbientLight('#ffffff', 0.3);
    this.sun = new THREE.DirectionalLight('#fff3dc', 2.2);
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 600;
    // Soft cool fill from below while the island can be turned over: the face that is down stays
    // readable, never pitch black (constant light count, no shader recompiles).
    this.underLight = new THREE.DirectionalLight('#9fb4ff', 0);
    this.underLight.position.set(40, -220, 70);
    scene.add(this.hemi, this.ambient, this.sun, this.sun.target, this.underLight, this.underLight.target);
    this.underside = false;

    // The island pivot (turns about the island's middle) and island space under it.
    this.pivot = new THREE.Group(); this.pivot.name = 'island-pivot'; this.pivot.position.set(0, PIVOT_Y, 0);
    this.land = new THREE.Group(); this.land.name = 'island-land'; this.land.position.set(0, -PIVOT_Y, 0);
    this.pivot.add(this.land); scene.add(this.pivot);
    this.rest = new THREE.Quaternion();   // settled orientation: always exactly flat
    this.turn = null;                      // a turn in progress: { mode: 'drag' | 'spring' | 'flip', axis, angle, … }
    this._pv = new THREE.Vector3(); this._qa = new THREE.Quaternion(); this._qr = new THREE.Quaternion(); this._qi = new THREE.Quaternion();
    this._g = new THREE.Vector3(); this._centre = new THREE.Vector3(0, PIVOT_Y, 0);

    this.particles = new Particles(800);
    this.land.add(this.particles.points);
    this.hq = buildHQ(); this.land.add(this.hq.group);
    this.city = new THREE.Group(); this.city.name = 'city'; this.land.add(this.city);
    this.rings = 0; this.half = islandHalf(1);
    this.setRings(1, { animate: false });
    this.setLots(new Map());
    // Zoom-linked pitch (updatePitch): how far the pitch sits off the curve, how far the orbit target
    // was raised toward eye height, and the distance it was last checked at.
    this.pitchBias = 0; this.eyeRaise = 0; this._pitchD = 0;
    this.shot = null;                      // talk mode's scripted camera (setShot)

    const controls = new OrbitControls(this.camera, renderer.domElement);
    // Wheel / touchpad scroll / pinch never reach OrbitControls: the City view catches every wheel
    // event over the stage and calls queueZoom (smooth, toward the pointer). enableZoom stays on for
    // middle-drag dolly and touchscreen pinch. minDistance 3: standing height, looking across the island.
    // The polar limits follow the zoom every frame (updatePitch).
    Object.assign(controls, { enableDamping: true, dampingFactor: 0.085, screenSpacePanning: false, minDistance: 3, maxPolarAngle: 1.3, minPolarAngle: 0.12, rotateSpeed: 0.55, enableZoom: true, zoomToCursor: true, zoomSpeed: 1.25, panSpeed: 0.95 });
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.addEventListener('start', () => { this.tween = null; this.pendingFlight = null; this.userMoved = true; });
    this.controls = controls;
    this.limits();
    this.resetView({ instant: true, auto: true });
    this.bindTilt();

    this.current = paletteAt(hourFor(timeMode));
    this.setQuality(quality);
    this.applyLighting(this.current);

    this.clock = new THREE.Clock(false);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  /* ---------- island lifecycle ---------- */
  setRings(rings, { animate = true, districts = false } = {}) {
    if (rings === this.rings && districts === this.districts) return false;
    const before = this.half;
    const grew = rings > this.rings;
    for (const key of ['island', 'roads', 'clouds']) if (this[key]) { this[key].group.removeFromParent(); disposeAll(this[key].group); }
    this.rings = rings; this.half = islandHalf(rings); this.districts = districts;
    this.island = buildIsland(rings); this.roads = buildRoads(rings, { districts });
    // Clouds stay in world space, outside the sphere the island sweeps when it turns over.
    this.clouds = buildClouds(this.half, this.quality, { center: PIVOT_Y, clear: this.sweepRadius() + CLOUD_MARGIN, island: this.half * 1.3 });
    this.land.add(this.island.group, this.roads.group);
    this.scene.add(this.clouds.group);
    this.applyTaper();
    if (this.controls) this.limits();
    this.fitShadow();
    if (animate && !this.reducedMotion() && before && grew) {
      this.islandAnim = { t: 0, from: Math.max(0.86, before / this.half) };
      for (const x of [-before, 0, before]) for (const z of [-before, before]) this.particles.emit('dust', new THREE.Vector3(x, GROUND_Y + 0.2, z), 12, { spread: 7 });
    }
    if (this.current) this.applyLighting(this.current);
    return true;
  }
  setLots(lots) {
    if (this.decor) { this.decor.removeFromParent(); disposeAll(this.decor); }
    this.decor = buildDecor(this.rings, lots, this.half, { districts: this.districts });
    this.land.add(this.decor);
  }
  /* ---------- Spark side ---------- */
  /** Turn the island's second face on or off. On: the tapering rock makes room for the Spark city,
   * the side emblems show, a soft fill comes on, the camera pitch is held on the zoom curve (vertical
   * drags turn the island instead). Off: the island snaps back to This PC side up and a vertical drag
   * tilts the view again (within a band around the curve). */
  setUnderside(on) {
    on = Boolean(on);
    if (on === this.underside) return false;
    this.underside = on;
    this.underLight.intensity = on ? 0.32 : 0;
    this.applyTaper();
    this.fitShadow();
    if (!on) this.settleNow('pc');
    this.applyPolarLimits();
    const goal = polarForDistance(this.distance);
    if (on && Math.abs(this.polar - goal) > 0.01 && !this.street && !this.shot) this.flyTo({ target: this.baseTarget(), polar: goal }, { auto: true, duration: 0.6 });
    return true;
  }
  applyTaper() {
    for (const child of this.island?.group.children || []) {
      if (child.userData.taper) child.visible = !this.underside;
      if (child.userData.sideSign) child.visible = this.underside;
    }
  }
  get azimuth() { return new THREE.Spherical().setFromVector3(new THREE.Vector3().subVectors(this.camera.position, this.controls.target)).theta; }
  get polar() { return new THREE.Spherical().setFromVector3(new THREE.Vector3().subVectors(this.camera.position, this.controls.target)).phi; }
  /** Island slabs: block picking so a hover never reaches through to the other side. */
  occluders() { return this.island ? this.island.group.children.filter(child => child.userData.occluder) : []; }

  limits() {
    this.controls.maxTargetRadius = this.half * 0.95;
    this.controls.maxDistance = 70 + this.half * 1.9;
    this.applyPolarLimits();
  }
  /** Polar limits for the current distance: held where it is while the island can be turned, else
   *  a band around the zoom curve (widened to the current pitch, so nothing snaps). updatePitch
   *  moves them every frame. */
  applyPolarLimits() {
    const c = this.controls;
    if (!c) return;
    const p = this.polar, curve = polarForDistance(this.distance);
    c.minPolarAngle = this.underside ? p : Math.min(p, Math.max(ZOOM_PITCH.min, curve - ZOOM_PITCH.up));
    c.maxPolarAngle = this.underside ? p : Math.max(p, Math.min(ZOOM_PITCH.max, curve + ZOOM_PITCH.down));
  }
  /** Zoom-linked pitch, once a frame before OrbitControls updates (not during flights, street view or
   *  talk shots). The farther out, the steeper (TILT_POLAR); the closer, the flatter, down to a
   *  near-level look across the island at the closest zoom, where the orbit target also rises to eye
   *  height so the view sits at standing height above the ground. A zoom (wheel, pinch, dolly) eases
   *  any offset from the curve away; with the Spark side off a vertical drag may tilt within a band. */
  updatePitch(dt) {
    const c = this.controls, cam = this.camera.position, t = c.target, P = ZOOM_PITCH;
    const off = (this._po ||= new THREE.Vector3()).subVectors(cam, t), s = (this._ps ||= new THREE.Spherical()).setFromVector3(off);
    const d = s.radius;
    if (d < 1e-6) return;
    const curve = polarForDistance(d), zoomed = this._pitchD ? Math.abs(Math.log(d / this._pitchD)) : 0;
    this._pitchD = d;
    if (zoomed > 1e-6) this.pitchBias *= Math.exp(-zoomed * P.ease);
    else if (!this.underside) this.pitchBias = s.phi - curve;   // an orbit drag (or a flight) put it here
    this.pitchBias = this.underside ? Math.max(-0.5, Math.min(0.5, this.pitchBias)) : Math.max(-P.up, Math.min(P.down, this.pitchBias));
    const goal = Math.max(P.min, Math.min(P.max, curve + this.pitchBias));
    const k = this.reducedMotion() ? 1 : 1 - Math.exp(-Math.max(0, dt) * 12);
    const phi = Math.abs(goal - s.phi) < 1e-4 ? goal : s.phi + (goal - s.phi) * k;
    if (phi !== s.phi) { s.phi = phi; s.makeSafe(); cam.copy(t).add(off.setFromSpherical(s)); }
    c.minPolarAngle = this.underside ? s.phi : Math.min(s.phi, Math.max(P.min, curve - P.up));
    c.maxPolarAngle = this.underside ? s.phi : Math.max(s.phi, Math.min(P.max, curve + P.down));
    // Eye height: raise a low orbit target as the camera closes in; lower it again (only what was raised) going out.
    const lift = eyeLiftForDistance(d), want = lift > 1e-3 ? GROUND_Y + lift : -Infinity;
    let dy = 0;
    if (t.y < want - 1e-4) dy = want - t.y;
    else if (this.eyeRaise > 1e-4 && t.y > want + 1e-4) dy = -Math.min(this.eyeRaise, t.y - want);
    if (dy) { t.y += dy; cam.y += dy; this.eyeRaise = Math.max(0, this.eyeRaise + dy); }
  }
  /** The orbit target without the eye-height raise (where a flight from here should aim). */
  baseTarget() { const t = this.controls.target.clone(); t.y -= this.eyeRaise || 0; return t; }
  /** Radius of the sphere the island (with its buildings) sweeps when it turns over. */
  sweepRadius() { return Math.hypot(Math.SQRT2 * this.half, SWEEP_RISE) + 2; }
  /** The sun's shadow box: the island's footprint, or the whole turning island while it can turn. */
  fitShadow() {
    const cam = this.sun.shadow.camera, r = this.underside ? Math.SQRT2 * this.half + 8 : this.half + 14;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.updateProjectionMatrix();
  }

  /* ---------- turning the island over ---------- */
  /** Orientation the island is resting at, or heading to once the current turn settles. */
  restQuaternion(out = new THREE.Quaternion()) {
    out.copy(this.rest);
    const t = this.turn;
    if (t) out.premultiply(this._qa.setFromAxisAngle(t.axis, t.target ?? settleTarget(t.angle)));
    return out;
  }
  /** Which face is up right now ('pc' | 'spark'). */
  get side() { return upY(this.pivot.quaternion) >= 0 ? 'pc' : 'spark'; }
  /** Which face is up once the island settles. */
  get restSide() { return upY(this.restQuaternion(this._qr)) >= 0 ? 'pc' : 'spark'; }
  /** True while the island is still (no drag, flip or settle in progress). */
  get settled() { return !this.turn; }
  /** Yaw of the resting island (turning it over about a different axis than before can leave it rotated). */
  restYaw() { const x = this._pv.set(1, 0, 0).applyQuaternion(this.rest); return Math.atan2(-x.z, x.x); }
  /** The camera's screen-right axis, flattened onto the ground plane: vertical drags roll the island about it. */
  tiltAxis() { const az = this.azimuth; return new THREE.Vector3(Math.cos(az), 0, -Math.sin(az)); }
  applyTurn() {
    const q = this.pivot.quaternion.copy(this.rest);
    if (this.turn) q.premultiply(this._qa.setFromAxisAngle(this.turn.axis, this.turn.angle));
  }
  /** Start a drag tilt. Grabbing the island mid-turn keeps that turn's axis, so it stays flat on release. */
  beginTilt() {
    if (!this.underside || this.street || this.shot) return false;
    const t = this.turn;
    if (t?.mode === 'drag') return true;
    const angle = t ? t.angle : 0;
    this.turn = { mode: 'drag', axis: t ? t.axis : this.tiltAxis(), angle, base: angle, velocity: 0, at: performance.now() };
    this.userMoved = true;
    this.makeRoom();
    return true;
  }
  /** dy: px dragged since the tilt began (down positive). Dragging up lifts the near edge, so the
   * face underneath swings up toward the camera; 420 px is a half turn. */
  dragTilt(dy) {
    const t = this.turn;
    if (t?.mode !== 'drag') return;
    const now = performance.now(), angle = t.base + dy / TILT_PX * Math.PI;
    const step = Math.max(4, now - t.at) / 1000;
    t.velocity = t.velocity * 0.35 + ((angle - t.angle) / step) * 0.65;
    t.angle = angle; t.at = now;
    this.applyTurn();
  }
  /** Let go: spring to the nearest flat orientation (one face exactly up). */
  endTilt() {
    const t = this.turn;
    if (t?.mode !== 'drag') return;
    const velocity = performance.now() - t.at > 90 ? 0 : Math.max(-12, Math.min(12, t.velocity));
    t.mode = 'spring'; t.velocity = velocity; t.target = settleTarget(t.angle, velocity);
    if (this.reducedMotion()) this.commitTurn();
  }
  /** Roll the island a half turn to its other face (toolbar button, V, deep links). */
  flip() {
    if (!this.underside || this.street || this.shot || this.turn?.mode === 'drag') return false;
    const t = this.turn;
    const from = t ? t.angle : 0, base = t ? (t.target ?? settleTarget(t.angle)) : 0;
    this.turn = { mode: 'flip', axis: t ? t.axis : this.tiltAxis(), from, angle: from, target: base - Math.PI, t: 0 };
    this.pendingFlight = null;   // a queued flight was aimed at the face this flip turns away
    if (this.reducedMotion()) { this.commitTurn(); return true; }
    this.makeRoom();
    return true;
  }
  flipTo(side) { return this.restSide !== side ? this.flip() : false; }
  /** Finish the current turn at its target and keep the result exactly flat. */
  commitTurn() {
    const t = this.turn;
    if (!t) return;
    this.rest.premultiply(this._qa.setFromAxisAngle(t.axis, t.target ?? settleTarget(t.angle)));
    this.rest.copy(flatten(this.rest));
    this.turn = null;
    this.applyTurn();
  }
  /** Jump to a face with no animation (keeps the island's yaw). */
  settleNow(side) {
    this.turn = null; this.pendingFlight = null;
    const flat = flatten(this.rest);
    if ((upY(flat) >= 0 ? 'pc' : 'spark') !== side) flat.multiply(this._qa.setFromAxisAngle(X_AXIS, Math.PI));
    this.rest.copy(flatten(flat));
    this.applyTurn();
  }
  updateTurn(dt) {
    const t = this.turn;
    if (!t || t.mode === 'drag') return;
    if (t.mode === 'flip') {
      t.t = Math.min(1, t.t + dt / FLIP_SECONDS);
      t.angle = t.from + (t.target - t.from) * flipEase(t.t);
      if (t.t >= 1) { this.commitTurn(); return; }
    } else {
      const s = springStep(t.angle, t.velocity, t.target, dt);
      t.angle = s.angle; t.velocity = s.velocity;
      if (s.done) { this.commitTurn(); return; }
    }
    this.applyTurn();
  }
  /** A camera inside the island's sweep would be passed through: back out to the whole island first. */
  makeRoom() {
    const room = this.sweepRadius() + 6, tw = this.tween;
    // A flight already under way counts by where it ends, not only where the camera is now.
    const end = tw ? this._pv.setFromSpherical(tw.to).add(tw.toTarget) : this.camera.position;
    if (this.camera.position.distanceTo(this._centre) >= room && end.distanceTo(this._centre) >= room) return;
    this.flyTo({ target: new THREE.Vector3(0, 0, 0), distance: room + 6 }, { duration: 0.6, auto: true });
  }
  /** Vertical left-drags on the canvas tilt the island (Spark side on); OrbitControls keeps the
   * horizontal part (orbit), right-drag pan and wheel / pinch zoom. Drags that start on an HTML
   * overlay never reach the canvas. A second finger (pinch / two-finger pan) ends the tilt. */
  bindTilt() {
    const canvas = this.renderer.domElement, pointers = new Set();
    let drag = null;
    const end = () => { if (drag) { drag = null; this.endTilt(); } };
    canvas.addEventListener('pointerdown', event => {
      if (event.isPrimary) pointers.clear();   // a new primary pointer: nothing else is down (no stale ids)
      pointers.add(event.pointerId);
      if (pointers.size > 1) { end(); return; }
      end();   // a drag whose up never arrived must not leave the island held mid-turn
      const rotate = event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey;
      drag = rotate && this.underside && !this.street && !this.shot && event.target === canvas ? { id: event.pointerId, x: event.clientX, y: event.clientY, tilting: false } : null;
      if (drag && !canvas.hasPointerCapture?.(event.pointerId)) { try { canvas.setPointerCapture(event.pointerId); } catch { /* not capturable */ } }
    });
    canvas.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dy = event.clientY - drag.y;
      if (!drag.tilting) {
        // A drag that goes sideways first is an orbit: it never tilts (and never backs the camera out).
        const dx = Math.abs(event.clientX - drag.x);
        if (dx >= TILT_DEADZONE && dx >= Math.abs(dy)) { drag = null; return; }
        if (Math.abs(dy) < TILT_DEADZONE) return;
        if (!this.beginTilt()) { drag = null; return; }
        drag.tilting = true; drag.y += Math.sign(dy) * TILT_DEADZONE;
      }
      this.dragTilt(event.clientY - drag.y);
    });
    const up = event => { pointers.delete(event.pointerId); if (drag && event.pointerId === drag.id) end(); };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('lostpointercapture', up);
    /** Window blur / view hidden: let go of any drag so the island settles flat. */
    this.releaseTilt = () => { pointers.clear(); end(); };
  }
  /** Island space → world space (atRest: where it will be once the island settles). */
  toWorld(v, { atRest = false, out = new THREE.Vector3() } = {}) {
    const q = atRest ? this.restQuaternion(this._qr) : this.pivot.quaternion;
    return out.set(v.x, v.y - PIVOT_Y, v.z).applyQuaternion(q).add(this._pv.set(0, PIVOT_Y, 0));
  }
  /** World space → island space (at the island's current orientation). */
  toLocal(v, out = new THREE.Vector3()) {
    const qi = this._qi.copy(this.pivot.quaternion).invert();
    return out.set(v.x, v.y - PIVOT_Y, v.z).applyQuaternion(qi).add(this._pv.set(0, PIVOT_Y, 0));
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
  /** Weather hook: paletteMod(target) adjusts each target palette in place (city/weather.js); refreshLighting blends to the new look. */
  refreshLighting() { this.blending = true; this.timeTick = 0; }
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
    this.paletteMod?.(target);
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
  /** The framed overview, from the front of whichever face is (or will be) up. */
  defaultView() {
    const x = this._pv.set(1, 0, 0).applyQuaternion(this.restQuaternion(this._qr)), yaw = Math.atan2(-x.z, x.x);
    const distance = Math.min(190, 34 + this.half * 1.75);
    return { target: new THREE.Vector3(0, 0, 0), distance, polar: polarForDistance(distance), azimuth: 0.62 + yaw };
  }
  resetView(opts = {}) { this.flyTo(this.defaultView(), opts); }
  /** flyTo now, or once the island has finished turning: a flight during a flip would carry the
   *  camera into the island's swing (makeRoom backs it out first). A newer flight, another flip or
   *  the owner grabbing the view drops it. */
  flyAfterTurn(view, opts) { if (this.turn) this.pendingFlight = [view, opts]; else this.flyTo(view, opts); }
  /** Ease the camera to { target, distance?, polar?, azimuth? }. Any flight that isn't the city's own
   * auto-framing (auto: true) counts as the owner moving the camera, so auto-framing stops overriding them.
   * No polar: the zoom curve at the new distance (an offset from it eases away with the zoom). An explicit
   * polar is kept (and held until the next zoom). A low target is raised to eye height for a close
   * landing. free: a scripted shot (talk mode), no distance / pitch limits and no eye-height raise. */
  flyTo({ target, distance, polar, azimuth }, { instant = false, duration = 0.95, auto = false, free = false } = {}) {
    this.pendingFlight = null; this.zoomPending = 0;   // a flight replaces any wheel zoom still playing out
    if (!auto) this.userMoved = true;
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls?.target || new THREE.Vector3());
    const from = new THREE.Spherical().setFromVector3(offset);
    if (!this.controls) { this.camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(new THREE.Spherical(distance, polar, azimuth))); return; }
    const P = ZOOM_PITCH, c = this.controls;
    const radius = free ? Math.max(0.5, distance ?? from.radius) : Math.min(c.maxDistance, Math.max(c.minDistance, distance ?? from.radius));
    let phi, bias = 0, raise = 0;
    if (free) phi = Math.min(Math.PI - 0.05, Math.max(0.05, polar ?? from.phi));
    else if (polar != null) { phi = Math.min(P.max, Math.max(P.min, polar)); bias = phi - polarForDistance(radius); }
    else {
      bias = (this.pitchBias || 0) * Math.exp(-Math.abs(Math.log(radius / Math.max(1e-6, from.radius))) * P.ease);
      phi = Math.min(P.max, Math.max(P.min, polarForDistance(radius) + bias));
    }
    const to = new THREE.Spherical(radius, phi, azimuth ?? from.theta);
    let dTheta = to.theta - from.theta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2; while (dTheta < -Math.PI) dTheta += Math.PI * 2;
    to.theta = from.theta + dTheta;
    const toTarget = target.clone();
    if (!free) { const lift = eyeLiftForDistance(radius); if (lift > 1e-3 && toTarget.y < GROUND_Y + lift) { raise = GROUND_Y + lift - toTarget.y; toTarget.y += raise; } }
    this.resetControlMomentum();
    this.eyeRaise = 0;   // the flight carries the target from its raised height (nothing left to lower if it is cut short)
    const tween = { t: 0, duration, fromTarget: this.controls.target.clone(), toTarget, from, to, bias, raise, free };
    if (instant || this.reducedMotion()) { this.tween = null; this.applyTween(tween, 1); this.endTween(tween); }
    else this.tween = tween;
  }
  /** A flight landed: its pitch offset holds until the next zoom; the eye-height raise is remembered. */
  endTween(tw) {
    if (this.tween === tw) this.tween = null;
    if (tw.free) return;
    this.pitchBias = tw.bias; this.eyeRaise = tw.raise; this._pitchD = 0;
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
  zoomBy(factor) { if (this.street || this.shot) return; this.zoomPending = 0; this.flyTo({ target: this.baseTarget(), distance: this.distance * factor }, { duration: 0.35 }); }
  /** Where the wheel zoom is heading (distance once the pending zoom has played out). */
  get zoomGoal() { return this.distance * Math.exp(this.zoomPending || 0); }
  /** Wheel / pinch: queue a multiplicative zoom (log units, + = out) toward a screen point; frame()
   *  plays it out smoothly (at once with reduced motion or while the loop is stopped). */
  queueZoom(log, clientX, clientY) {
    if (this.street || this.shot || !log) return;
    const c = this.controls;
    this.zoomPending = queueZoomLog(this.zoomPending || 0, log, this.distance, c.minDistance, c.maxDistance);
    this.zoomAnchor = Number.isFinite(clientX) && Number.isFinite(clientY) ? { x: clientX, y: clientY } : null;
    if (this.tween) this.tween = null;
    this.pendingFlight = null; this.userMoved = true;
    if (this.reducedMotion() || !this.raf) this.stepZoom(1);
  }
  stepZoom(k) {
    const log = (this.zoomPending || 0) * k;
    this.zoomPending = Math.abs(this.zoomPending - log) < 1e-4 ? 0 : this.zoomPending - log;
    this.zoomAt(Math.exp(log), this.zoomAnchor);
    if (!this.raf) { this.updatePitch(1); this.controls.update(); this.renderOnce(); }
  }
  /** Scale the camera's distance by factor about the ground point under the anchor (the point under
   *  the pointer stays put, like a map); about the orbit target when the pointer is on the sky. */
  zoomAt(factor, anchor) {
    const c = this.controls, cam = this.camera.position, d = this.distance;
    if (d < 1e-6) return;
    const f = Math.min(c.maxDistance, Math.max(c.minDistance, d * factor)) / d;
    if (Math.abs(f - 1) < 1e-6) return;
    const p = (this._zp ||= new THREE.Vector3()).copy(c.target);
    if (anchor) {
      this.raycaster ||= new THREE.Raycaster();
      this.raycaster.setFromCamera(this.ndc(anchor.x, anchor.y), this.camera);
      const hit = this.raycaster.ray.intersectPlane((this._zplane ||= new THREE.Plane()).set(UP, -c.target.y), this._zq ||= new THREE.Vector3());
      if (hit && hit.distanceTo(cam) < d * 4) p.copy(hit);
    }
    // Zooming in stops at a wall (collide: the City's buildings, island space) instead of diving inside.
    const next = (this._zc ||= new THREE.Vector3()).copy(cam).sub(p).multiplyScalar(f).add(p);
    if (f < 1 && this.collide?.(this.toLocal(next, this._zl ||= new THREE.Vector3()))) { this.zoomPending = 0; return; }
    c.target.sub(p).multiplyScalar(f).add(p);
    cam.copy(next);
  }
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
  /* ---------- street view ---------- */
  /** Third-person camera behind a walker. pose(dt) → { x, y, z, heading, back, up, look } in island
   *  space (heading: yaw, forward is (sin, cos)) or null. Orbit controls, tilting and flipping are
   *  off while it runs; null hands the camera back (the caller flies it to the overview). */
  setStreet(pose) {
    this.street = typeof pose === 'function' ? pose : null;
    this.zoomPending = 0;
    this.controls.enabled = !this.street && !this.shot;
    this.tween = null; this.pendingFlight = null;
    this.clearKeys(); this.resetControlMomentum();
    if (this.street) { this.userMoved = true; this.streetSnap = this.reducedMotion(); }
  }
  updateStreet(dt) {
    const s = this.street(dt);
    if (!s) return;
    const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
    const eye = this.toWorld((this._se ||= new THREE.Vector3()).set(s.x - fx * s.back, s.y + s.up, s.z - fz * s.back), { out: this._se });
    const look = this.toWorld((this._sl ||= new THREE.Vector3()).set(s.x + fx * 6, s.y + s.look, s.z + fz * 6), { out: this._sl });
    const k = this.streetSnap || this.reducedMotion() ? 1 : 1 - Math.exp(-dt * 7);
    this.streetSnap = false;
    this.camera.position.lerp(eye, k);
    this.controls.target.lerp(look, k);
    this.camera.lookAt(this.controls.target);
  }
  /* ---------- talk mode ---------- */
  /** A scripted camera for talk mode: view = { eye, look } (world space), eased there (a free flight)
   *  and held still. Orbit controls, wheel zoom, keys, tilting and flips are off while it runs; null
   *  hands the camera back (the caller flies it home). */
  setShot(view, { duration = 1.15, instant = false } = {}) {
    this.shot = view ? { eye: view.eye.clone(), look: view.look.clone() } : null;
    this.zoomPending = 0; this.pendingFlight = null;
    this.controls.enabled = !this.shot && !this.street;
    this.clearKeys(); this.resetControlMomentum();
    if (!view) { this._pitchD = 0; return; }
    const s = new THREE.Spherical().setFromVector3(new THREE.Vector3().subVectors(view.eye, view.look));
    this.flyTo({ target: view.look, distance: s.radius, polar: s.phi, azimuth: s.theta }, { duration, instant, free: true });
  }
  keyDown(code) { if (this.shot) return; this.keys.add(code); if (this.tween) this.tween = null; }
  keyUp(code) { this.keys.delete(code); }
  clearKeys() { this.keys.clear(); }
  applyKeys(dt) {
    if (!this.keys.size || this.shot) return;
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
    this.updateTurn(dt);
    if (this.pendingFlight && !this.turn && !this.street) { const [view, opts] = this.pendingFlight; this.flyTo(view, opts); }
    if (this.street) { this.tween = null; this.updateStreet(dt); }
    else if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.duration);
      this.applyTween(tw, tw.t);
      if (tw.t >= 1) this.endTween(tw);
    } else if (this.follow && !this.turn && this.side === 'pc' && !this.shot) {
      const p = this.follow();
      if (p) {
        const goal = this.toWorld(this._g.set(p.x, 1, p.z), { out: this._g });
        goal.y += this.eyeRaise || 0;   // keep updatePitch's eye-height raise instead of undoing it every frame
        const delta = goal.sub(this.controls.target).multiplyScalar(reduced ? 1 : Math.min(1, dt * 3));
        this.controls.target.add(delta); this.camera.position.add(delta);
      }
    }
    if (this.zoomPending && !this.tween && !this.street && !this.shot) this.stepZoom(reduced ? 1 : 1 - Math.exp(-dt * 14));
    if (!this.tween && !this.street && !this.shot) { this.updatePitch(dt); this.controls.update(); }
    const env = { night: this.current.night, reducedMotion: reduced, particles: this.particles, quality: this.quality };
    if (this.islandAnim) {
      const a = this.islandAnim; a.t = Math.min(1, a.t + dt / 0.9);
      const s = 1 + (a.from - 1) * Math.exp(-5 * a.t) * Math.cos(8 * a.t);
      // Keep river banks, bridges, roads and pinned buildings aligned throughout
      // growth. Stretch only the rock depth below ground in the home city.
      if (this.districts) this.island.group.scale.set(1, s, 1);
      else for (const g of [this.island.group, this.roads.group, this.decor]) g.scale.set(s, 1, s);
      if (a.t >= 1) { for (const g of [this.island.group, this.roads.group, this.decor]) g.scale.set(1, 1, 1); this.islandAnim = null; }
    }
    this.clouds.update(reduced ? 0 : dt * (this.cloudSpeed || 1), this.camera.position, reduced);   // cloudSpeed: weather wind
    this.hq.update(dt, this.elapsed, env);
    for (const fn of this.listeners) fn(dt, this.elapsed, env);
    this.particles.update(dt);
    // Fog follows the zoom so the island stays crisp and the clouds below melt into the sky.
    const d = this.distance;
    this.scene.fog.near = d * 1.1 + 20; this.scene.fog.far = d * 2.6 + 160;
    this.sky.group.position.copy(this.camera.position);
    this.beforeRender?.(dt, reduced);   // weather: fog, flashes, precipitation (after lighting and fog are set)
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
  /** Point (island space) on This PC's walkable ground under the cursor, or null. Only while This PC
   *  side is up and the island is still; either face rests with its ground at world y = GROUND_Y. */
  groundAt(ndc) {
    if (this.turn || this.side !== 'pc' || this.camera.position.y < GROUND_Y + 0.3) return null;
    this.raycaster ||= new THREE.Raycaster();
    this.raycaster.setFromCamera(ndc, this.camera);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -GROUND_Y), point)) return null;
    this.toLocal(point, point);
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
