/* City weather effects, This PC side only (the Spark side and anything else keeps clear weather):
 * - precipitation: ONE Points system, animated on the GPU (rain streaks that lean with the wind,
 *   drifting snowflakes, or both for sleet), in a box over the island around the orbit target,
 *   capped and scaled by the quality setting;
 * - lighting: a palette modifier (world.paletteMod) dims and desaturates whatever the day/night
 *   palette is, so weather and time of day combine; stars hide behind cloud;
 * - fog pulled in, more and darker clouds, a pale snow tint on the ground, lightning flashes
 *   (hemisphere/ambient pulse plus a brief sky flash, no sound), wind (faster clouds, trees lean).
 * Reduced motion: no falling particles, flashes or sway; the static tint, fog and clouds stay. */
import { THREE, toonMaterial } from './toon.js';
import { buildClouds, PALETTE, GROUND_Y } from './scenery.js';
import { disposeAll } from './fx.js';
import { PIVOT_Y } from './world.js';
import { NO_WEATHER } from '../weather.js';

const CAP = { high: 2600, low: 900 };     // particle budget by quality
const LOOP = 900;                         // s: the shader clock wraps (one unseen jump every 15 min)
const CLOUD_MARGIN = 10;                  // as world.js: extra clouds stay clear of the island's sweep
const C = hex => new THREE.Color(hex);
const WHITE = C('#ffffff'), CLOUD_DARK = C('#7b8292'), FLASH = C('#eef1ff'), SNOW_SKY = C('#f3f6ff'), SNOW_GROUND = C('#eef3f4');
const RAIN_DAY = C('#d4e1f4'), RAIN_NIGHT = C('#7f8fb4'), FLAKE_NIGHT = C('#c7d0ec');
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* aSeed: xyz = start in the unit box, w = which kind (flake if w < uMix) and a speed spread. Positions
 * wrap in island space; the fall uses a fixed span so a zoom (box size change) never jumps the drops. */
const VERT = `
attribute vec4 aSeed;
uniform float uTime, uHalf, uHeight, uRain, uSnow, uMix, uScale, uAspect;
uniform vec3 uCenter; uniform vec2 uWind;
varying float vFlake; varying float vPx; varying vec2 vDir;
const float SPAN = 30.0;
void main() {
  float flake = step(aSeed.w, uMix), r = fract(aSeed.w * 13.37);
  float speed = mix(uRain * (0.85 + 0.3 * r), uSnow * (0.7 + 0.6 * r), flake);
  vec2 wind = uWind * mix(1.0, 0.7, flake);
  float sway = flake * sin(uTime * (0.7 + r) + aSeed.x * 37.0) * 0.012;
  float y = fract(aSeed.y - uTime * speed / SPAN);
  vec2 xz = fract(aSeed.xz + wind * uTime / (2.0 * SPAN) + vec2(sway, sway * 0.6)) * 2.0 - 1.0;
  vec3 p = uCenter + vec3(xz.x * uHalf, y * uHeight, xz.y * uHalf);
  vec4 mv = modelViewMatrix * vec4(p, 1.0), clip = projectionMatrix * mv;
  gl_Position = clip;
  vec3 vel = vec3(wind.x * uHalf, -speed * uHeight, wind.y * uHalf) / SPAN;   // actual motion, for the streak's lean
  vec4 ahead = projectionMatrix * (modelViewMatrix * vec4(p + normalize(vel) * 0.6, 1.0));
  vec2 d = ahead.xy / ahead.w - clip.xy / clip.w; d.x *= uAspect;
  vDir = length(d) > 1e-6 ? normalize(vec2(d.x, -d.y)) : vec2(0.0, 1.0);
  vPx = clamp(mix(1.1, 0.24, flake) * (0.8 + 0.4 * r) * uScale / max(0.1, -mv.z), 2.0, 56.0);
  gl_PointSize = vPx;
  vFlake = flake;
}`;
const FRAG = `
uniform vec3 uColor, uFlake; uniform float uAlpha;
varying float vFlake; varying float vPx; varying vec2 vDir;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a;
  if (vFlake > 0.5) a = 1.0 - smoothstep(0.22, 0.5, length(c));
  else {
    float along = dot(c, vDir), across = abs(c.x * vDir.y - c.y * vDir.x), w = max(0.04, 1.3 / vPx);
    a = (1.0 - smoothstep(w * 0.5, w, across)) * (1.0 - smoothstep(0.3, 0.5, abs(along))) * (0.55 + 0.45 * smoothstep(-0.5, 0.5, along));
  }
  if (a <= 0.01) discard;
  gl_FragColor = vec4(mix(uColor, uFlake, vFlake), a * uAlpha);
  #include <colorspace_fragment>
}`;

function buildPrecip(capacity) {
  let s = 0x2f6b1d;
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const seeds = new Float32Array(capacity * 4).map(() => rnd());
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));   // unused; sets the count
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  const uniforms = {
    uTime: { value: 0 }, uHalf: { value: 20 }, uHeight: { value: 30 }, uRain: { value: 22 }, uSnow: { value: 1.4 }, uMix: { value: 0 },
    uScale: { value: 800 }, uAspect: { value: 1.6 }, uCenter: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2() },
    uColor: { value: RAIN_DAY.clone() }, uFlake: { value: WHITE.clone() }, uAlpha: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms, transparent: true, depthWrite: false, fog: false });
  const points = new THREE.Points(geometry, material);
  points.name = 'weather-precip'; points.frustumCulled = false; points.renderOrder = 6; points.visible = false; points.raycast = () => {};
  return { points, geometry, material, uniforms };
}

/** Tree InstancedMeshes (scenery.addTrees tags them) with a copy of their resting matrices. */
function collectTrees(...roots) {
  const out = [];
  for (const root of roots) root?.traverse(node => { if (node.isInstancedMesh && node.userData.tree) out.push({ mesh: node, base: node.instanceMatrix.array.slice(0, node.count * 16) }); });
  return out;
}

export class WeatherFx {
  constructor(world, { reducedMotion = () => false } = {}) {
    this.world = world;
    this.reduced = reducedMotion;
    this.look = NO_WEATHER;
    this.mix = 0; this.on = false; this.time = 0; this.home = true;
    this.precip = buildPrecip(CAP.high);
    world.land.add(this.precip.points);
    this.extra = null; this.extraSig = '';
    this.flash = { t: -1, next: 3 + Math.random() * 5, level: 0 };
    this.sway = { root: undefined, trees: [], active: false };
    this.grass = toonMaterial(PALETTE.grass); this.lawn = toonMaterial(PALETTE.lawn);   // the cached island materials
    this.grass0 = this.grass.color.clone(); this.lawn0 = this.lawn.color.clone(); this.groundK = 0;
    this.tmp = new THREE.Color(); this.v = new THREE.Vector3(); this.v2 = new THREE.Vector3();
    world.paletteMod = p => this.modPalette(p);
    world.beforeRender = (dt, reduced) => this.update(dt, reduced);
  }
  /** A look from weather.js weatherLook, or null for no weather. Lighting blends to it. */
  set(look) { this.look = look || NO_WEATHER; this.flash.next = Math.min(this.flash.next, 2.5); this.world.refreshLighting(); }
  /** Home city (true) or a contributor island (false, city/portal.js): islands get no weather. Leaving drops it at once (the portal hides the cut). */
  setHome(on) { if (this.home === on) return; this.home = on; if (!on) this.mix = 0; this.world.refreshLighting(); }
  /** Weather shows only in the home city with This PC side up (or on its way up). */
  get active() { return this.look !== NO_WEATHER && this.home && this.world.restSide === 'pc'; }

  /** Palette modifier: grey and dim the sky, weaken the sun, flatten the light; snow brightens the sky light. */
  modPalette(p) {
    if (!this.active) return;
    const L = this.look, g = L.gloom, t = this.tmp;
    const grey = (c, amount, dim = 1) => { const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722; c.lerp(t.setRGB(l, l, l), amount).multiplyScalar(dim); };
    grey(p.top, g * 0.85, 1 - g * 0.45); grey(p.horizon, g * 0.8, 1 - g * 0.3); grey(p.bottom, g * 0.8, 1 - g * 0.3);
    grey(p.fog, g * 0.8, 1 - g * 0.3); grey(p.hemiSky, g * 0.6, 1 - g * 0.15); grey(p.hemiGround, g * 0.5, 1 - g * 0.3); grey(p.sun, g * 0.5);
    p.sunI *= 1 - g * 0.85; p.glow *= 1 - g * 0.9; p.hemiI *= 1 - g * 0.28; p.ambient += g * 0.04;
    p.cloud.multiplyScalar(1 - g * 0.5);
    if (L.fog > 0) p.fog.lerp(p.horizon, L.fog * 0.6);
    if (L.snowCover > 0) { p.hemiSky.lerp(SNOW_SKY, L.snowCover * 0.5); p.hemiI += L.snowCover * 0.12; }
  }

  /** Once a frame, after lighting and fog are set and before the render (world.beforeRender). */
  update(dt, reduced) {
    const w = this.world, L = this.look, on = this.active;
    if (on !== this.on) { this.on = on; w.refreshLighting(); }
    const goal = on && w.side === 'pc' ? 1 : 0;
    this.mix = reduced ? goal : this.mix + (goal - this.mix) * Math.min(1, dt * 1.6);
    if (Math.abs(this.mix - goal) < 0.003) this.mix = goal;
    const m = this.mix;
    if (m > 0 && L.fog > 0) {
      const d = w.distance, f = L.fog * m, fog = w.scene.fog;
      fog.near += (d * 0.1 + 2 - fog.near) * f; fog.far += (d * 1.05 + 20 - fog.far) * f;
    }
    w.sky.stars.material.opacity = Math.max(0, (w.current.night - 0.35) / 0.65) * (1 - Math.min(1, L.gloom * 1.4) * m);
    w.clouds.material.color.copy(WHITE).lerp(CLOUD_DARK, L.gloom * m);
    w.cloudSpeed = 1 + L.wind * 3 * m;
    this.updateClouds(dt, reduced, m);
    this.updateGround(m);
    this.updateFlash(dt, reduced, goal === 1 && L.lightning);
    this.updatePrecip(dt, reduced, m);
    this.updateSway(reduced ? 0 : L.wind * m);
  }
  /** More cloud for cloudy weather: a second, seeded set (rebuilt only when its size changes). */
  updateClouds(dt, reduced, m) {
    const w = this.world, L = this.look;
    const count = m > 0.05 && L.clouds > 0.3 ? Math.round((L.clouds - 0.3) / 0.7 * (w.quality === 'low' ? 10 : 20)) : 0;
    const sig = count ? `${count}|${w.half}|${w.quality}` : '';
    if (sig !== this.extraSig) {
      this.extraSig = sig;
      if (this.extra) { this.extra.group.removeFromParent(); disposeAll(this.extra.group); this.extra = null; }
      if (count) {
        this.extra = buildClouds(w.half, w.quality, { center: PIVOT_Y, clear: w.sweepRadius() + CLOUD_MARGIN, island: w.half * 1.3, seed: 'weather-clouds', total: count });
        w.scene.add(this.extra.group);
      }
    }
    if (!this.extra) return;
    const a = this.extra.material, b = w.clouds.material;
    a.color.copy(b.color); a.emissive.copy(b.emissive); a.emissiveIntensity = b.emissiveIntensity;
    this.extra.update(reduced ? 0 : dt * w.cloudSpeed, w.camera.position, reduced);
  }
  /** Snow: the island's grass and lawns turn pale. */
  updateGround(m) {
    const k = this.look.snowCover * m;
    if (Math.abs(k - this.groundK) < 0.002 && (k > 0 || this.groundK === 0)) return;
    this.groundK = k < 0.002 ? 0 : k;
    this.grass.color.copy(this.grass0).lerp(SNOW_GROUND, this.groundK);
    this.lawn.color.copy(this.lawn0).lerp(SNOW_GROUND, Math.min(1, this.groundK * 1.1));
  }
  /** Storm: every 6–16 s a double flash, about 0.6 s long. Off with reduced motion. */
  updateFlash(dt, reduced, storm) {
    const w = this.world, f = this.flash, can = storm && !reduced;
    if (can) { f.next -= dt; if (f.next <= 0 && f.t < 0) { f.t = 0; f.next = 6 + Math.random() * 10; } }
    let level = 0;
    if (f.t >= 0) {
      f.t += dt;
      level = Math.exp(-f.t * 18) + (f.t > 0.16 ? 0.65 * Math.exp(-(f.t - 0.16) * 20) : 0);
      if (f.t > 0.7 || !can) { f.t = -1; level = 0; }
    }
    if (!level && !f.level) return;
    f.level = level;
    const c = w.current, u = w.sky.uniforms;
    w.hemi.intensity = c.hemiI + level * 1.4; w.ambient.intensity = c.ambient + level * 0.6;
    u.uTop.value.copy(c.top).lerp(FLASH, level * 0.4); u.uHorizon.value.copy(c.horizon).lerp(FLASH, level * 0.55); u.uBottom.value.copy(c.bottom).lerp(FLASH, level * 0.3);
  }
  updatePrecip(dt, reduced, m) {
    const w = this.world, L = this.look, P = this.precip;
    const show = Boolean(L.precip) && m > 0.02 && !reduced && w.settled && w.side === 'pc';
    P.points.visible = show;
    if (!show) return;
    const cap = w.quality === 'low' ? CAP.low : CAP.high, snow = L.flakes >= 1;
    P.geometry.setDrawRange(0, Math.round(cap * (snow ? 0.5 + 0.5 * L.amount : 0.3 + 0.7 * L.amount)));
    const u = P.uniforms;
    this.time = (this.time + dt) % LOOP;
    u.uTime.value = this.time;
    // The box: over the island around the orbit target (island space), sized by the zoom, never past the rim.
    const half = w.half - 1, box = Math.min(half, Math.max(12, w.distance * 0.55)), lim = Math.max(0, half - box);
    const target = w.toLocal(w.controls.target, this.v);
    u.uCenter.value.set(clamp(target.x, -lim, lim), GROUND_Y, clamp(target.z, -lim, lim));
    u.uHalf.value = box;
    u.uHeight.value = clamp(w.toLocal(w.camera.position, this.v2).y - GROUND_Y + 6, 14, 46);
    u.uMix.value = L.flakes;
    u.uRain.value = 19 + 7 * L.amount; u.uSnow.value = 1.3 + L.wind * 0.6;
    u.uWind.value.set(L.wind * 7, L.wind * 2);
    const night = w.current.night;
    u.uColor.value.copy(RAIN_DAY).lerp(RAIN_NIGHT, night).multiplyScalar(1 - L.gloom * 0.2);
    u.uFlake.value.copy(WHITE).lerp(FLAKE_NIGHT, night);
    u.uAlpha.value = (snow ? 0.92 : 0.4 + 0.32 * L.amount) * m;
    u.uScale.value = w.size.h * w.renderer.getPixelRatio() / (2 * Math.tan(w.camera.fov * Math.PI / 360));
    u.uAspect.value = w.size.w / Math.max(1, w.size.h);
  }
  /** Wind: every tree leans from its base, gusting (instance matrices; outlines share them). */
  updateSway(strength) {
    const w = this.world, s = this.sway;
    if (w.decor !== s.root) { this.restoreSway(); s.root = w.decor; s.trees = collectTrees(w.decor, w.hq?.group); }
    const amp = Math.max(0, strength - 0.25) * 0.1;
    if (!amp) { if (s.active) this.restoreSway(); return; }
    s.active = true;
    const t = w.elapsed;
    for (const { mesh, base } of s.trees) {
      const e = mesh.instanceMatrix.array;
      for (let o = 0; o < base.length; o += 16) {
        const phase = base[o + 12] * 0.37 + base[o + 14] * 0.53;
        const lean = amp * (0.65 + 0.35 * Math.sin(t * 1.9 + phase) + 0.25 * Math.sin(t * 4.3 + phase * 2.1));
        const cs = Math.cos(lean), sn = Math.sin(lean);
        // Lean toward +x (the wind): rotate each basis column about z, keep the trunk's foot in place.
        for (let j = 0; j < 12; j += 4) { const x = base[o + j], y = base[o + j + 1]; e[o + j] = x * cs + y * sn; e[o + j + 1] = y * cs - x * sn; e[o + j + 2] = base[o + j + 2]; e[o + j + 3] = base[o + j + 3]; }
        e[o + 12] = base[o + 12]; e[o + 13] = base[o + 13]; e[o + 14] = base[o + 14]; e[o + 15] = base[o + 15];
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
  restoreSway() {
    const s = this.sway;
    if (s.active) for (const { mesh, base } of s.trees) { mesh.instanceMatrix.array.set(base); mesh.instanceMatrix.needsUpdate = true; }
    s.active = false;
  }

  dispose() {
    const w = this.world;
    this.restoreSway();
    this.grass.color.copy(this.grass0); this.lawn.color.copy(this.lawn0);
    if (this.extra) { this.extra.group.removeFromParent(); disposeAll(this.extra.group); this.extra = null; }
    this.precip.points.removeFromParent(); this.precip.geometry.dispose(); this.precip.material.dispose();
    if (w.paletteMod) w.paletteMod = null;
    if (w.beforeRender) w.beforeRender = null;
    w.cloudSpeed = 1;
  }
}
