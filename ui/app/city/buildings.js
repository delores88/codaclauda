/* Procedural project buildings. A building is a stack of floors whose height comes
 * from project.metrics.floors and footprint from metrics.footprint; its architecture
 * is keyed to the primary language. BuildingManager diffs by project.id so a store
 * change never rebuilds the whole city: new lots rise with a dust puff, extra floors
 * spring in with sparkles, removed/hidden projects sink away. */
import { THREE, toonMaterial, addOutline, shade, pastel } from './toon.js';
import { RoundedBoxGeometry } from '../../vendor/three/addons/RoundedBoxGeometry.js';
import { mergeParts, placed, plaqueTexture, githubFlagTexture, lockTexture, disposeAll as disposeObject } from './fx.js';
import { cellCenter, cellKey } from './layout.js';
import { GROUND_Y, seeded, lotSeats } from './scenery.js';
import { Ticker, TICKER } from './ticker.js';
import { districtOf, isUnbuilt } from './districts.js';
import { suburbPlan, buildSuburbHome, buildSuburbYard, buildContractor, HOME_BODY_COLORS, HOME_WOOD, HOME_ROOF, HOME_LOT_SIZE } from './suburbs.js';

export const GF = 2.6;           // ground floor height
export const FH = 1.3;           // upper floor height
const PAD_TOP = GROUND_Y + 0.12;
const CZ = -0.3;                 // building centre offset inside its lot (front yard toward +z)
const rbox = (w, h, d, r = 0.15, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, r);

export function buildingSize(project) {
  const m = project.metrics || {};
  const floors = Math.max(1, Math.min(24, Math.round(m.floors || 1)));
  const footprint = Math.max(1, Math.min(3, Math.round(m.footprint || 1)));
  const W = 2.6 + footprint * 2.2, D = 2.4 + footprint * 1.9;
  return { floors, footprint, W, D, H: GF + (floors - 1) * FH };
}

/* ---------- architecture styles ---------- */
const LANG_STYLE = {
  Rust: 'foundry', Python: 'python', 'Jupyter Notebook': 'python',
  TypeScript: 'glass', JavaScript: 'glass', Vue: 'glass', Svelte: 'glass',
  Shell: 'workshop', PowerShell: 'workshop', Batchfile: 'workshop', Dockerfile: 'workshop', Makefile: 'workshop', Nix: 'workshop',
  HTML: 'storefront', CSS: 'storefront', SCSS: 'storefront', Less: 'storefront',
};
/** Project colours may be CSS hsl() strings (unknown languages); three.js wants hex. */
function toHex(color, fallback = '#8b8fa3') {
  const value = String(color || '');
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i.exec(value);
  return m ? `#${new THREE.Color().setHSL(Number(m[1]) / 360 % 1, Number(m[2]) / 100, Number(m[3]) / 100).getHexString()}` : fallback;
}
export function styleFor(project, district = null) {
  const lang = project.primaryLanguage || 'Other';
  if (district === 'downtown') return {
    key: 'downtown', body: '#92bbd4', trim: '#d6e6ef', plinth: '#526a7b', door: '#314b61', roof: '#b9ccd9',
    window: { w: 0.94, h: 0.98, spacing: 1.08 }, glass: true,
  };
  if (district === 'suburbs') return { key: 'suburbs', body: HOME_BODY_COLORS[0], trim: HOME_WOOD, plinth: '#c7c9c5', door: HOME_ROOF, roof: HOME_ROOF };
  const key = LANG_STYLE[lang] || 'generic';
  const base = { key, window: { w: 0.55, h: 0.72, spacing: 1.2 }, door: '#6b4a8f', trim: null };
  switch (key) {
    case 'foundry': return { ...base, body: '#d27a5c', trim: '#e3a06b', plinth: '#8a4a3a', door: '#5a3428', roof: '#7a4436' };
    case 'python': return { ...base, body: '#6f9fe6', trim: '#ffd866', plinth: '#3f69b5', door: '#2f4f8f', roof: '#ffd866' };
    case 'glass': {
      const js = lang === 'JavaScript';
      return { ...base, body: js ? '#ffeaa0' : '#a9d0ff', trim: js ? '#e8c75a' : '#7aa8e6', plinth: '#5e6a8a', door: '#3c4f7a', roof: '#e9eef8', window: { w: 0.92, h: 0.98, spacing: 1.06 }, glass: true };
    }
    case 'workshop': {
      const ps = lang === 'PowerShell';
      return { ...base, body: '#d3a676', trim: '#9b6d45', plinth: '#7d5a3c', door: '#6a4a2e', roof: ps ? '#6c96ef' : '#7ccf6a' };
    }
    case 'storefront': {
      const css = /css|less/i.test(lang);
      return { ...base, body: css ? '#cdb8ff' : '#ffb79f', trim: css ? '#9e86ef' : '#ff8a6b', plinth: '#7b6a8a', door: '#4f3a6a', roof: '#fff1de', awning: css ? ['#9e86ef', '#fff7ea'] : ['#ff7a5c', '#fff7ea'] };
    }
    default: {
      const tint = toHex(project.color);
      const body = pastel(tint, 0.45);
      return { ...base, body, trim: shade(body, -0.12), plinth: shade(body, -0.3), door: shade(tint, -0.15), roof: shade(body, 0.08) };
    }
  }
}

/* ---------- shared materials (one instance for every building) ---------- */
function sharedMat(material) { material.userData.shared = true; return material; }
export const MATERIALS = {
  windowLit: sharedMat(toonMaterial('#ffe7a8', { emissive: '#ffbf5a', emissiveIntensity: 0.2, cache: false })),
  windowDark: sharedMat(toonMaterial('#5d6f9c', { emissive: '#1b2240', emissiveIntensity: 0.2, cache: false })),
  glassLit: sharedMat(toonMaterial('#c4ebfa', { emissive: '#91d5f5', emissiveIntensity: 0.2, cache: false })),
  glassDark: sharedMat(toonMaterial('#4c7c9a', { emissive: '#1e455e', emissiveIntensity: 0.08, cache: false })),
  wallLight: sharedMat(toonMaterial('#ffe1a4', { emissive: '#ffc168', emissiveIntensity: 0.1, cache: false })),
  homeGlass: sharedMat(toonMaterial('#7d9da8', { emissive: '#f3d5a1', emissiveIntensity: 0.04, cache: false })),
  shop: sharedMat(toonMaterial('#fff2c9', { emissive: '#ffcf7a', emissiveIntensity: 0.4, cache: false })),
  pad: sharedMat(toonMaterial('#e9dfcb', { cache: false })),
  scaffold: sharedMat(toonMaterial('#ffc94d', { cache: false })),
  plank: sharedMat(toonMaterial('#c48a52', { cache: false })),
  crane: sharedMat(toonMaterial('#ffb238', { cache: false })),
};
/** Day/night: night ∈ [0, 1]. */
export function setBuildingNight(night) {
  MATERIALS.windowLit.emissiveIntensity = 0.18 + night * 1.25;
  MATERIALS.windowDark.emissiveIntensity = 0.05 + night * 0.25;
  MATERIALS.shop.emissiveIntensity = 0.35 + night * 1.1;
  MATERIALS.glassLit.emissiveIntensity = 0.18 + night * 1.1;
  MATERIALS.glassDark.emissiveIntensity = 0.05 + night * 0.2;
  MATERIALS.wallLight.emissiveIntensity = 0.08 + night * 1.9;
  MATERIALS.homeGlass.emissiveIntensity = 0.04 + night * 0.55;
}

/* ---------- Spark side palette ----------
 * Buildings for the DGX Spark city reuse the same Building code with { mirror: true }: each is
 * the same building as its This PC twin (same style, footprint, height, windows, roof and props,
 * name plaque) on the other face of the same lot, so turning the island over shows a mirror
 * image. Only the palette changes, deterministically: the body is the PC body mixed toward a
 * light green-grey, trims glow green, roofs go leaf green, dark parts go deep green, bright
 * accents lime. All Spark parts share a few materials (body tones are cached per colour), so
 * busy pulsing and the offline grey reach every part at once. */
export const SPARK_GREEN = '#76b900';
export const SPARK = { body: '#c3efd9', panel: '#eef6e7', dark: '#2f5a3c', pad: '#d4e6c8', glow: 'spark:glow', lime: 'spark:lime', leaf: 'spark:leaf' };
const SPARK_SET = new Set(Object.values(SPARK));
const sparkToon = (color, emissive, intensity) => sharedMat(toonMaterial(color, { emissive, emissiveIntensity: intensity, cache: false }));
export const SPARK_MATERIALS = {
  body: sparkToon('#c3efd9', '#123d1a', 0.12),
  bodyActive: sparkToon('#dcffa4', SPARK_GREEN, 0.4),
  bodyHover: sparkToon('#eaffd6', '#9be04a', 0.42),
  panel: sparkToon(SPARK.panel, '#123d1a', 0.08),
  dark: sparkToon(SPARK.dark, '#0b2410', 0.22),
  pad: sparkToon(SPARK.pad, '#123d1a', 0.08),
  board: sparkToon('#c2d8b4', '#16361a', 0.12),
  plot: sparkToon('#e0edd6', '#16361a', 0.06),
  glow: sparkToon(SPARK_GREEN, SPARK_GREEN, 0.2),
  glowActive: sparkToon('#b8ff3e', '#8fe000', 1.0),
  lime: sparkToon('#c8ef58', '#a6e22e', 0.14),
  limeActive: sparkToon('#e8ff80', '#c8ff3a', 1.0),
  leaf: sparkToon('#9ccc3c', '#3f7a12', 0.12),
  winLit: sparkToon('#effed6', '#9be04a', 0.34),
  winLitActive: sparkToon('#fbffc6', '#c6ff4a', 1.1),
  winDark: sparkToon('#46705a', '#0e2a1c', 0.22),
};
export const SPARK_SPARKS = ['#b6ff3a', SPARK_GREEN, '#f3ffe0'];
/* Spark offline: every shared Spark material turns a flat grey with its glow off (they are used
 * by the Spark side only, so changing them in place greys the whole side at once). Textured signs
 * (name plaques, flags, locks) dim to the same grey as the Foundry plaque. */
let sparkOffline = false;
const SPARK_ALL = new Set(Object.values(SPARK_MATERIALS));
const SPARK_SIGNS = new Set();
const SIGN_GREY = '#8e928e';
const greyHsl = {};
function greySpark(m, on) {
  const keep = m.userData.online ||= { color: m.color.clone(), emissive: m.emissive.clone(), emissiveIntensity: m.emissiveIntensity };
  if (on) { keep.color.getHSL(greyHsl); m.color.setHSL(greyHsl.h, 0.03, 0.24 + greyHsl.l * 0.5); m.emissive.set('#000000'); m.emissiveIntensity = 0; }
  else { m.color.copy(keep.color); m.emissive.copy(keep.emissive); m.emissiveIntensity = keep.emissiveIntensity; }
}
export function setSparkOffline(on) {
  on = Boolean(on);
  if (on === sparkOffline) return false;
  sparkOffline = on;
  for (const m of SPARK_ALL) greySpark(m, on);
  for (const m of SPARK_SIGNS) m.color.set(on ? SIGN_GREY : '#ffffff');
  return true;
}
/** Shared Spark body tone for a PC body colour: mixed 55% toward a light green-grey (cached). */
const SPARK_MIX = 0xdfe8d8;
const sparkBodies = new Map();
function sparkBodyMaterial(hex) {
  let m = sparkBodies.get(hex);
  if (!m) {
    const n = parseInt(toHex(hex).slice(1), 16);
    let mixed = 0;
    for (const s of [16, 8, 0]) mixed |= Math.round((n >> s & 255) * 0.45 + (SPARK_MIX >> s & 255) * 0.55) << s;
    m = sparkToon(`#${mixed.toString(16).padStart(6, '0')}`, '#123d1a', 0.12);
    if (sparkOffline) greySpark(m, true);
    SPARK_ALL.add(m); sparkBodies.set(hex, m);
  }
  return m;
}
/** Spark sign material (texture board); shared ones (flag, lock) are made once. */
function sparkSign(map, options = {}) {
  const m = new THREE.MeshBasicMaterial({ map, ...options });
  if (sparkOffline) m.color.set(SIGN_GREY);
  SPARK_SIGNS.add(m);
  return m;
}
const sparkShared = {};
const sparkFlag = () => sparkShared.flag ||= sharedMat(sparkSign(githubFlagTexture(), { side: THREE.DoubleSide }));
const sparkLock = () => sparkShared.lock ||= sharedMat(sparkSign(lockTexture(), { transparent: true }));
export const sparkIsOffline = () => sparkOffline;
/** Breathing glow for busy Spark buildings and the day/night glow of the Spark side (shared
 * materials: one update per frame for the whole side). */
export function pulseSpark(elapsed, { reducedMotion = false, night = 0 } = {}) {
  if (sparkOffline) return;   // greyed out: no glow, no breathing
  const k = reducedMotion ? 0.6 : 0.5 + 0.5 * Math.sin(elapsed * 2.6);
  const M = SPARK_MATERIALS;
  M.bodyActive.emissiveIntensity = 0.24 + k * 0.4 + night * 0.15;
  M.glowActive.emissiveIntensity = 0.7 + k * 0.7 + night * 0.3;
  M.limeActive.emissiveIntensity = 0.7 + k * 0.6 + night * 0.3;
  M.winLitActive.emissiveIntensity = 0.9 + k * 0.5 + night * 0.4;
  M.glow.emissiveIntensity = 0.18 + night * 0.6;
  M.lime.emissiveIntensity = 0.12 + night * 0.4;
  M.leaf.emissiveIntensity = 0.1 + night * 0.3;
  M.winLit.emissiveIntensity = 0.3 + night * 0.95;
}
/** Map any facade / prop colour onto the few Spark tones: dark parts deep green, bright saturated
 * accents lime, mid saturated parts leaf green, the rest a pale panel. Deterministic. */
function sparkTone(color) {
  if (SPARK_SET.has(color)) return color;
  const n = /^#[0-9a-f]{6}$/i.test(color) ? parseInt(color.slice(1), 16) : 0x808080;
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), light = (max + min) / 2, sat = max - min;
  if (light < 0.4) return SPARK.dark;
  if (sat > 0.4 && light > 0.62) return SPARK.lime;
  if (sat > 0.25 && light <= 0.62) return SPARK.leaf;
  return SPARK.panel;
}
function sparkMaterial(tone, active) {
  const M = SPARK_MATERIALS;
  if (tone === SPARK.glow) return active ? M.glowActive : M.glow;
  if (tone === SPARK.lime) return active ? M.limeActive : M.lime;
  if (tone === SPARK.leaf) return M.leaf;
  if (tone === SPARK.dark) return M.dark;
  if (tone === SPARK.pad) return M.pad;
  return M.panel;
}
/** The PC twin's style with the Spark palette: same key, windows and shape; body keeps the PC
 * hue mixed toward green-grey (see sparkBodyMaterial), trims glow, roofs leaf, plinth/door dark. */
function sparkStyle(style) {
  return { ...style, body: toHex(style.body), trim: SPARK.glow, plinth: SPARK.dark, door: SPARK.dark, roof: SPARK.leaf, awning: [SPARK.lime, SPARK.panel] };
}
const windowGeos = new Map();
function windowGeometry(w, h) {
  const key = `${w}x${h}`;
  if (!windowGeos.has(key)) { const g = new THREE.BoxGeometry(w, h, 0.1); g.userData.shared = true; windowGeos.set(key, g); }
  return windowGeos.get(key);
}

/** Collects static parts by colour and merges each colour into one outlined mesh. */
class Batch {
  /** tone(color) → colour key (the Spark underside collapses its palette to a few tones). */
  constructor(tone = null) { this.parts = new Map(); this.tone = tone; }
  add(color, geometry) { const key = this.tone ? this.tone(color) : color; if (!this.parts.has(key)) this.parts.set(key, []); this.parts.get(key).push(geometry); return this; }
  build(group, { cast = true, receive = true, outline = 0.04, tag, materialFor = null } = {}) {
    const meshes = [];
    for (const [color, list] of this.parts) {
      const m = new THREE.Mesh(mergeParts(list), materialFor?.(color) || toonMaterial(color));
      m.castShadow = cast; m.receiveShadow = receive;
      if (outline) addOutline(m, { thickness: outline });
      m.userData.paint = color;
      Object.assign(m.userData, tag || {});
      group.add(m); meshes.push(m);
    }
    this.parts.clear();
    return meshes;
  }
}

const easeOutBack = t => { const c = 1.6; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const easeIn = t => t * t * t;

/** A quiet two-line ground sign: texture belongs to this repository's sign. */
function unbuiltSignTexture(name) {
  const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = 192;
  const context = canvas.getContext('2d');
  context.fillStyle = '#e7edf0'; context.fillRect(0, 0, 768, 192);
  context.strokeStyle = '#91a7b3'; context.lineWidth = 6; context.strokeRect(3, 3, 762, 186);
  context.textAlign = 'center'; context.textBaseline = 'middle';
  const label = String(name || 'Repository').replace(/\s+/g, ' ').trim();
  let fontSize = 48;
  do { context.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`; fontSize -= 2; } while (context.measureText(label).width > 704 && fontSize > 22);
  context.fillStyle = '#425967'; context.fillText(label, 384, 66, 704);
  context.font = '30px "Segoe UI", system-ui, sans-serif'; context.fillStyle = '#586d79';
  context.fillText('Not on this PC · click to clone', 384, 132, 704);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/* ---------- one building ---------- */
export class Building {
  /** env: { particles, reducedMotion(), animateIn, stagger(), mirror?, deckY? }. With mirror the
   * building lives in the Spark side group: that group is turned a half turn about x at deckY
   * (island space y = deckY - local y, z = -local z), so it hangs below the island while This PC
   * is up and stands upright when the island is turned over. Its particles are the group's own. */
  constructor(project, cell, env) {
    this.id = project.id;
    this.cell = cell;
    this.env = env;
    this.mirror = Boolean(env.mirror);
    const c = cellCenter(cell.i, cell.j);
    this.origin = { x: c.x, z: c.z + CZ };
    this.group = new THREE.Group(); this.group.name = `building:${project.id}`;
    this.group.position.set(this.origin.x, 0, this.origin.z);
    this.tower = new THREE.Group(); this.group.add(this.tower);
    this.padGroup = new THREE.Group(); this.group.add(this.padGroup);
    this.pickables = [];
    this.anim = null;
    this.hover = false; this.active = false;
    this.removing = false;
    this.elapsedEmit = 0;
    this.ticker = null; this.tickerInfo = null;   // { segments, paused } from the view (see setTicker)
    this.apply(project, { animate: env.animateIn });
  }

  /** Re-apply a project; returns true if the lot footprint changed. */
  apply(project, { animate = false } = {}) {
    this.project = project;
    const district = !this.mirror && this.env.districts ? districtOf(project) : null;
    const unbuilt = Boolean(district && isUnbuilt(project));
    const homePlan = district === 'suburbs' ? suburbPlan(project, this.cell) : null;
    const size = homePlan ? { W: homePlan.W, D: homePlan.D, H: homePlan.H, floors: homePlan.floors, footprint: homePlan.footprint, variant: homePlan.variant, variantName: homePlan.variantName } : buildingSize(project);
    const style = this.mirror ? sparkStyle(styleFor(project)) : styleFor(project, district);
    if (homePlan) style.body = homePlan.body;
    const m = project.metrics || {};
    const litFrac = Math.max(0.08, Math.min(0.92, 0.12 + (m.glow || 0) * 0.55 + Math.min(m.commits7d || 0, 30) / 60));
    const sig = JSON.stringify([size.floors, size.footprint, style.key, style.body, project.name, Math.round(litFrac * 20), (m.commits7d || 0) > 0, project.source, !!project.private, unbuilt]);
    if (sig === this.sig) return false;
    const previous = this.size;
    const footprintChanged = !previous || previous.footprint !== size.footprint || this.district !== district || this.unbuilt !== unbuilt;
    this.sig = sig; this.size = size; this.style = style; this.litFrac = litFrac; this.district = district; this.unbuilt = unbuilt; this.suburbs = homePlan;
    this.clearTower();
    this.buildTower();
    if (footprintChanged) this.buildPad();
    if (this.active && !this.unbuilt) { if (homePlan) this.buildHomeActivity(); else this.buildScaffold(); }
    const reduced = this.env.reducedMotion();
    if (!previous && animate && !reduced) {
      this.anim = { kind: 'rise', t: 0, delay: this.env.stagger?.() || 0 };
      this.tower.scale.y = 0.02; this.padGroup.scale.setScalar(0.6);
    } else if (previous && homePlan && (previous.W !== size.W || previous.D !== size.D) && !reduced) {
      this.anim = { kind: 'widen', t: 0, fromX: previous.W / size.W, fromZ: previous.D / size.D };
      this.tower.scale.set(this.anim.fromX, 1, this.anim.fromZ);
    } else if (previous && previous.floors !== size.floors && !reduced) {
      this.anim = { kind: 'grow', t: 0, from: previous.H / size.H, up: size.floors > previous.floors };
      this.tower.scale.y = previous.H / size.H;
      if (this.anim.up && !this.mirror) this.env.particles.emit('sparkle', this.topPoint(), 26, { spread: size.W * 0.8 });
    }
    return footprintChanged;
  }

  clearTower() {
    this.dropTicker();
    if (this.unbuiltSign) { this.unbuiltSign.removeFromParent(); disposeObject(this.unbuiltSign); this.unbuiltSign = null; }
    for (const child of [...this.tower.children]) { this.tower.remove(child); disposeObject(child); }
    this.pickables = []; this.gear = null; this.flag = null; this.beaconLight = null; this.jib = null; this.chimneyTop = null; this.scaffold = null;
    this.paintMeshes = []; this.litWindows = null; this.litPanes = []; this.rigTip = null; this.plaque = null; this.roofSurface = null; this.scaffoldFront = null; this.home = null; this.contractor = null;
    for (const m of this.signs || []) SPARK_SIGNS.delete(m);
    this.signs = [];
  }
  /** Spark side: put a mesh on a shared Spark tone (repainted with the busy state). */
  sparkPaint(mesh, tone) {
    mesh.userData.paint = tone; mesh.material = sparkMaterial(tone, this.active);
    this.paintMeshes.push(mesh);
    return mesh;
  }

  buildTower() {
    if (this.unbuilt) { this.buildUnbuilt(); return; }
    if (this.suburbs) { this.buildHome(); return; }
    const { W, D, H, floors } = this.size, s = this.style, mirror = this.mirror;
    const tag = mirror ? { sparkBuildingId: this.id } : { buildingId: this.id };
    const top = PAD_TOP + H;
    if (mirror) this.sparkBase = sparkBodyMaterial(s.body);
    this.bodyMaterial = mirror ? this.sparkBody() : toonMaterial(s.body, { cache: false });
    const body = new THREE.Mesh(placed(rbox(W, H, D, 0.22), { y: PAD_TOP + H / 2 }), this.bodyMaterial);
    body.castShadow = true; body.receiveShadow = true; body.userData = { ...tag };
    addOutline(body, { thickness: 0.06 });
    this.tower.add(body);
    this.body = body;

    const batch = new Batch(mirror ? sparkTone : null);
    batch.add(s.plinth, placed(rbox(W + 0.28, 0.38, D + 0.28, 0.1), { y: PAD_TOP + 0.19 }));
    for (let f = 1; f < floors; f++) {
      const y = PAD_TOP + GF + (f - 1) * FH;
      if (!s.glass || f % 4 === 0) batch.add(s.trim, placed(rbox(W + 0.16, 0.13, D + 0.16, 0.05, 1), { y }));
    }
    batch.add(s.trim, placed(rbox(W + 0.34, 0.3, D + 0.34, 0.1), { y: top - 0.05 }));
    // Door, step and a tiny lamp.
    batch.add(s.door, placed(rbox(1.15, 1.75, 0.24, 0.1), { y: PAD_TOP + 0.875, z: D / 2 + 0.03 }));
    batch.add('#e6dccb', placed(rbox(1.7, 0.14, 0.6, 0.05), { y: PAD_TOP + 0.07, z: D / 2 + 0.3 }));
    batch.add('#ffd98a', placed(new THREE.BoxGeometry(0.1, 0.1, 0.1), { x: 0.75, y: PAD_TOP + 1.5, z: D / 2 + 0.06 }));

    let roofTop = top + 0.1;
    const r = seeded(this.id);
    if (s.key === 'downtown') {
      // Flat roof, steel corner mullions and a compact connected antenna.
      batch.add(s.roof, placed(new THREE.BoxGeometry(W + 0.22, 0.2, D + 0.22), { y: top + 0.1 }));
      for (const x of [-W / 2 + 0.08, W / 2 - 0.08]) for (const z of [-D / 2 + 0.08, D / 2 - 0.08]) batch.add(s.trim, placed(new THREE.BoxGeometry(0.14, H, 0.14), { x, y: PAD_TOP + H / 2, z }));
      batch.add('#6f8799', placed(new THREE.BoxGeometry(W * 0.3, 0.42, D * 0.26), { x: -W * 0.2, y: top + 0.41, z: -D * 0.18 }));
      batch.add('#6f8799', placed(new THREE.CylinderGeometry(0.07, 0.1, 1.35, 6), { x: W * 0.23, y: top + 0.85, z: -D * 0.2 }));
      batch.add('#b9ccd9', placed(new THREE.BoxGeometry(0.65, 0.1, 0.1), { x: W * 0.23, y: top + 1.1, z: -D * 0.2 }));
      roofTop = top + 1.55;
      this.roofSurface = top + 0.2;
    } else if (s.key === 'foundry') {
      const cx = W / 2 - 0.85, cz = -D / 2 + 0.85;
      batch.add(s.plinth, placed(new THREE.CylinderGeometry(0.42, 0.5, 2.9, 12), { x: cx, y: top + 1.45, z: cz }));
      batch.add('#5a3428', placed(new THREE.CylinderGeometry(0.52, 0.52, 0.22, 12), { x: cx, y: top + 2.8, z: cz }));
      roofTop = top + 3;
      if (!mirror) this.chimneyTop = new THREE.Vector3(cx, top + 3.05, cz);   // smoke on the PC side only
      // Gear sign on the facade.
      const gearParts = [placed(new THREE.CylinderGeometry(0.6, 0.6, 0.16, 18), { rx: Math.PI / 2 })];
      for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; gearParts.push(placed(new THREE.BoxGeometry(0.26, 0.3, 0.16), { x: Math.sin(a) * 0.68, y: Math.cos(a) * 0.68, rz: -a })); }
      const gear = new THREE.Mesh(mergeParts(gearParts), toonMaterial('#e3a06b'));
      const hub = new THREE.Mesh(placed(new THREE.CylinderGeometry(0.2, 0.2, 0.2, 10), { rx: Math.PI / 2 }), toonMaterial('#7a4436'));
      gear.add(hub); addOutline(gear, { thickness: 0.03 });
      gear.position.set(-W / 2 + 0.95, floors >= 2 ? top - 0.85 : PAD_TOP + 1.45, D / 2 + 0.16);
      gear.userData = { ...tag }; this.gear = gear; this.tower.add(gear); this.pickables.push(gear);
      if (mirror) { this.sparkPaint(gear, SPARK.glow); this.sparkPaint(hub, SPARK.dark); }
    } else if (s.key === 'python') {
      const radius = Math.min(W, D) * 0.42;
      batch.add(s.roof, placed(new THREE.SphereGeometry(radius, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2), { y: top + 0.1, sy: 0.78 }));
      batch.add('#3f69b5', placed(new THREE.CylinderGeometry(0.07, 0.07, 0.8, 6), { y: top + radius * 0.78 + 0.45 }));
      batch.add('#ffd866', placed(new THREE.SphereGeometry(0.2, 10, 8), { y: top + radius * 0.78 + 0.9 }));
      roofTop = top + radius * 0.78 + 1.1;
      // Tiled bands: alternating yellow stripes on every third floor.
      for (let f = 2; f < floors; f += 3) batch.add('#ffe38f', placed(rbox(W + 0.06, 0.36, D + 0.06, 0.05, 1), { y: PAD_TOP + GF + (f - 1) * FH + 0.2 }));
    } else if (s.key === 'glass') {
      batch.add(s.roof, placed(rbox(W * 0.45, 0.8, D * 0.45, 0.12), { x: -W * 0.12, y: top + 0.4, z: -D * 0.1 }));
      batch.add('#8d96b0', placed(new THREE.CylinderGeometry(0.06, 0.1, 2.8, 6), { x: W * 0.22, y: top + 1.4, z: -D * 0.18 }));
      batch.add('#8d96b0', placed(new THREE.BoxGeometry(0.7, 0.05, 0.05), { x: W * 0.22, y: top + 1.9, z: -D * 0.18 }));
      this.addBeacon(new THREE.Vector3(W * 0.22, top + 2.9, -D * 0.18), (this.project.metrics?.commits7d || 0) > 0);
      roofTop = top + 3;
    } else if (s.key === 'workshop') {
      const shape = new THREE.Shape([new THREE.Vector2(-D / 2 - 0.35, 0), new THREE.Vector2(D / 2 + 0.35, 0), new THREE.Vector2(0, Math.min(2.2, 0.9 + D * 0.18))]);
      const roof = new THREE.ExtrudeGeometry(shape, { depth: W + 0.4, bevelEnabled: false });
      roof.translate(0, 0, -(W + 0.4) / 2); roof.rotateY(Math.PI / 2); roof.translate(0, top - 0.05, 0);
      batch.add(s.roof, roof);
      batch.add('#8a8f9e', placed(new THREE.CylinderGeometry(0.15, 0.15, 1.4, 8), { x: W / 2 - 0.8, y: top + 1.0, z: -D * 0.2 }));
      roofTop = top + Math.min(2.2, 0.9 + D * 0.18);
      // Workbench, crate and barrel beside the shed.
      batch.add('#a8774a', placed(rbox(1.3, 0.12, 0.6, 0.04, 1), { x: W / 2 + 0.25, y: PAD_TOP + 0.75, z: D / 2 - 0.6 }));
      batch.add('#7d5a3c', placed(new THREE.BoxGeometry(1.2, 0.7, 0.5), { x: W / 2 + 0.25, y: PAD_TOP + 0.35, z: D / 2 - 0.6 }));
      batch.add('#c48a52', placed(rbox(0.6, 0.6, 0.6, 0.06), { x: -W / 2 - 0.1, y: PAD_TOP + 0.3, z: D / 2 - 0.3, ry: 0.4 }));
      batch.add('#5f7fb0', placed(new THREE.CylinderGeometry(0.3, 0.3, 0.75, 12), { x: -W / 2 - 0.15, y: PAD_TOP + 0.37, z: D / 2 - 1.2 }));
    } else if (s.key === 'storefront') {
      const stripes = 7, aw = Math.min(W - 0.4, 4.6), sw = aw / stripes;
      for (let k = 0; k < stripes; k++) batch.add(s.awning[k % 2], placed(new THREE.BoxGeometry(sw, 0.08, 1.0), { x: -aw / 2 + sw * (k + 0.5), y: PAD_TOP + 1.95, z: D / 2 + 0.45, rx: 0.32 }));
      for (const sx of [-1, 1]) {
        const pw = Math.max(0.6, (W - 1.6) / 2 - 0.4);
        const paneMaterial = mirror ? (this.active ? SPARK_MATERIALS.winLitActive : SPARK_MATERIALS.winLit) : MATERIALS.shop;
        const pane = new THREE.Mesh(placed(new THREE.BoxGeometry(pw, 1.05, 0.1), { x: sx * (0.75 + pw / 2 + 0.05), y: PAD_TOP + 0.95, z: D / 2 + 0.02 }), paneMaterial);
        this.tower.add(pane);
        if (mirror) this.litPanes.push(pane);
      }
      for (let k = 0; k < 3; k++) batch.add(['#6cc35e', '#8bd96b', '#4fbf8a'][k], placed(new THREE.IcosahedronGeometry(0.42 + r() * 0.2, 1), { x: (k - 1) * W * 0.28, y: top + 0.45, z: -D * 0.2 + r() * 0.5 }));
      batch.add('#c48a52', placed(rbox(W * 0.8, 0.3, 0.5, 0.06), { y: top + 0.15, z: -D * 0.2 }));
      roofTop = top + 1;
    } else {
      batch.add(shade(s.body, -0.2), placed(rbox(1.0, 0.6, 0.8, 0.1), { x: W / 2 - 0.9, y: top + 0.3, z: D / 2 - 0.9 }));
      if (floors >= 4) {
        const tx = -W / 2 + 1.1, tz = -D / 2 + 1.1;
        for (const [dx, dz] of [[-0.35, -0.35], [0.35, -0.35], [-0.35, 0.35], [0.35, 0.35]]) batch.add('#7d6a5a', placed(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 5), { x: tx + dx, y: top + 0.45, z: tz + dz }));
        batch.add('#b9875a', placed(new THREE.CylinderGeometry(0.55, 0.55, 0.9, 14), { x: tx, y: top + 1.35, z: tz }));
        batch.add('#8a5a3a', placed(new THREE.ConeGeometry(0.62, 0.45, 14), { x: tx, y: top + 2.02, z: tz }));
        roofTop = top + 2.3;
      }
    }
    // Generic roof props (the Spark twin carries the same props in its own palette).
    const m = this.project.metrics || {};
    if (!this.district && (m.commits7d || 0) > 0 && s.key !== 'glass') {
      const ax = -W / 2 + 0.6, az = D / 2 - 0.6;
      batch.add('#8d96b0', placed(new THREE.CylinderGeometry(0.05, 0.07, 1.7, 6), { x: ax, y: top + 0.85, z: az }));
      this.addBeacon(new THREE.Vector3(ax, top + 1.8, az), true);
      roofTop = Math.max(roofTop, top + 1.9);
    }
    if (!this.district && (this.project.source === 'github' || this.project.source === 'both')) {
      const fx = -W / 2 + 0.55, fz = -D / 2 + 0.55;
      batch.add('#d8dbe6', placed(new THREE.CylinderGeometry(0.04, 0.05, 2.2, 6), { x: fx, y: top + 1.1, z: fz }));
      const flag = new THREE.Group();
      flag.position.set(fx, top + 1.85, fz);
      const cloth = new THREE.Mesh(placed(new THREE.PlaneGeometry(0.95, 0.68), { x: 0.5 }), mirror ? sparkFlag() : new THREE.MeshBasicMaterial({ map: githubFlagTexture(), side: THREE.DoubleSide }));
      flag.add(cloth); this.flag = flag; this.tower.add(flag);
      roofTop = Math.max(roofTop, top + 2.3);
    }
    if (this.project.private) {
      const sign = new THREE.Mesh(new THREE.CircleGeometry(0.38, 24), mirror ? sparkLock() : new THREE.MeshBasicMaterial({ map: lockTexture(), transparent: true }));
      sign.position.set(W / 2 - 0.55, top + 0.75, D / 2 - 0.1);
      batch.add('#7d6a5a', placed(new THREE.BoxGeometry(0.08, 0.5, 0.08), { x: W / 2 - 0.55, y: top + 0.25, z: D / 2 - 0.15 }));
      this.tower.add(sign);
    }
    const parts = batch.build(this.tower, mirror ? { tag, materialFor: tone => sparkMaterial(tone, this.active) } : { tag });
    if (mirror) this.paintMeshes.push(...parts);
    this.pickables.push(body, ...parts);
    this.roofTop = roofTop;

    // Name plaque above the door (Spark: the same name on the Spark plaque style).
    const plaqueW = Math.min(W * 0.84, 3.4), plaqueH = plaqueW / 4;
    let plaqueMaterial;
    if (mirror) { plaqueMaterial = sparkSign(plaqueTexture(this.project.name, { accent: SPARK_GREEN }), { transparent: true }); this.signs.push(plaqueMaterial); }
    else plaqueMaterial = new THREE.MeshBasicMaterial({ map: plaqueTexture(this.project.name, { accent: this.project.color }), transparent: true });
    const plaque = new THREE.Mesh(new THREE.PlaneGeometry(plaqueW, plaqueH), plaqueMaterial);
    // One floor: the ticker band crosses the sign's top, so the sign stands just in front of it.
    plaque.position.set(0, PAD_TOP + (s.key === 'storefront' ? 2.32 : 2.18), D / 2 + (floors === 1 && this.tickerInfo ? TICKER.off + 0.05 : 0.07));
    plaque.userData = { ...tag };
    this.tower.add(plaque); this.pickables.push(plaque); this.plaque = plaque;

    this.buildWindows();
    this.mountTicker();
  }

  buildHome() {
    const tag = { buildingId: this.id };
    this.bodyMaterial = toonMaterial(this.suburbs.body, { cache: false });
    this.home = buildSuburbHome(this.suburbs, { baseY: PAD_TOP, bodyMaterial: this.bodyMaterial, glassMaterial: MATERIALS.homeGlass, wallLightMaterial: MATERIALS.wallLight, tag });
    this.tower.add(this.home.group); this.body = this.home.body; this.pickables.push(...this.home.meshes);
    this.roofTop = this.home.roofY + 0.15; this.roofSurface = this.home.roofY;
    const width = Math.min(1.65, this.suburbs.entry.w * 0.65);
    const plaque = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 4), new THREE.MeshBasicMaterial({ map: plaqueTexture(this.project.name, { accent: HOME_WOOD }), transparent: true }));
    plaque.position.copy(this.home.plaque); plaque.userData = tag;
    this.tower.add(plaque); this.pickables.push(plaque); this.plaque = plaque;
    this.mountTicker();
  }

  buildHomeActivity() {
    if (this.contractor) { this.contractor.group.removeFromParent(); disposeObject(this.contractor.group); }
    this.contractor = buildContractor(this.suburbs, { baseY: PAD_TOP, tag: { buildingId: this.id } });
    this.tower.add(this.contractor.group);
  }

  /** Remote-only repositories are clickable plans, with no working construction rig. */
  buildUnbuilt() {
    const { W, D, H } = this.size, tag = { buildingId: this.id };
    const ghostHeight = H * 0.83;
    const geometry = placed(new THREE.BoxGeometry(W, ghostHeight, D), { y: PAD_TOP + ghostHeight / 2 });
    this.bodyMaterial = toonMaterial('#b9d4e4', { transparent: true, opacity: 0.23, cache: false });
    this.bodyMaterial.depthWrite = false;
    const body = new THREE.Mesh(geometry, this.bodyMaterial);
    body.userData = { ...tag, noOutline: true };
    const frame = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: '#a6bdcb', transparent: true, opacity: 0.18, depthWrite: false }));
    frame.raycast = () => {};
    this.tower.add(body, frame); this.body = body; this.pickables.push(body);
    const sign = new THREE.Group(); sign.name = `unbuilt-sign:${this.id}`;
    sign.position.set(0, PAD_TOP, D / 2 + 0.33);
    const plaqueW = Math.min(W * 0.8, 4.6), plaqueH = plaqueW / 4;
    for (const x of [-plaqueW * 0.35, plaqueW * 0.35]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1, 0.12), toonMaterial('#788d99'));
      post.position.set(x, 0.5, 0); sign.add(post);
    }
    const backing = new THREE.Mesh(new THREE.BoxGeometry(plaqueW + 0.1, plaqueH + 0.1, 0.1), toonMaterial('#91a7b3'));
    backing.position.y = 1.1; backing.userData = { ...tag }; sign.add(backing);
    const plaque = new THREE.Mesh(new THREE.PlaneGeometry(plaqueW, plaqueH), new THREE.MeshBasicMaterial({ map: unbuiltSignTexture(this.project.name) }));
    plaque.position.set(0, 1.1, 0.056); plaque.userData = { ...tag };
    sign.add(plaque); this.group.add(sign); this.unbuiltSign = sign;
    this.pickables.push(backing, plaque); this.plaque = plaque;
    this.roofTop = this.roofSurface = PAD_TOP + ghostHeight;
  }

  /* Access ticker: segments from ticker.js tickerSegments (null: none); paused: grey and still. */
  setTicker(segments, paused = false) {
    const had = Boolean(this.tickerInfo);
    this.tickerInfo = segments ? { segments, paused: Boolean(paused) } : null;
    if (!segments || this.unbuilt) { this.dropTicker(); return; }
    if (this.ticker) this.ticker.set(segments, { grey: Boolean(paused) }); else this.mountTicker();
    if (!had && !this.suburbs && this.size?.floors === 1 && this.plaque) this.plaque.position.z = this.size.D / 2 + TICKER.off + 0.05;
  }
  mountTicker() {
    if (this.unbuilt || !this.tickerInfo || this.ticker || !this.size) return;
    const { W, D, H } = this.size;
    // Picking the band picks the building (same tag as its walls).
    const home = this.home?.ticker;
    this.ticker = new Ticker({ W: home?.W || W, D: home?.D || D, top: home ? 0 : PAD_TOP + H, tag: this.mirror ? { sparkBuildingId: this.id } : { buildingId: this.id } });
    if (home) { this.ticker.mesh.position.set(home.x, home.y, home.z); this.ticker.mesh.scale.y = home.scaleY; }
    this.ticker.set(this.tickerInfo.segments, { grey: this.tickerInfo.paused });
    this.tower.add(this.ticker.mesh); this.pickables.push(this.ticker.mesh);
  }
  dropTicker() {
    if (!this.ticker) return;
    const mesh = this.ticker.mesh;
    this.pickables = this.pickables.filter(m => m !== mesh);
    this.ticker.dispose(); this.ticker = null;
  }

  /* Spark side: shared materials swap with hover / busy state. */
  sparkBody() { const M = SPARK_MATERIALS; return this.hover ? M.bodyHover : this.active ? M.bodyActive : this.sparkBase || M.body; }
  paintSpark() {
    if (this.body) this.body.material = this.bodyMaterial = this.sparkBody();
    for (const mesh of this.paintMeshes || []) mesh.material = sparkMaterial(mesh.userData.paint, this.active);
    const lit = this.active ? SPARK_MATERIALS.winLitActive : SPARK_MATERIALS.winLit;
    if (this.litWindows) this.litWindows.material = lit;
    for (const pane of this.litPanes || []) pane.material = lit;
  }
  /** A compact crane rig on the roof of a busy Spark building. */
  buildRig() {
    if (this.scaffold) { this.tower.remove(this.scaffold); disposeObject(this.scaffold); }
    const { W, D, H } = this.size, M = SPARK_MATERIALS;
    const group = new THREE.Group();
    const crane = new THREE.Group(); crane.position.set(0, this.roofSurface || PAD_TOP + H, 0);
    const mast = new THREE.Mesh(placed(new THREE.BoxGeometry(0.24, 2.8, 0.24), { y: 1.4 }), M.panel);
    const collar = new THREE.Mesh(placed(new THREE.BoxGeometry(0.42, 0.16, 0.42), { y: 1.9 }), M.glowActive);
    const jib = new THREE.Group(); jib.position.y = 2.8;
    const reach = Math.min(W, D) * 0.34;
    jib.add(new THREE.Mesh(placed(new THREE.BoxGeometry(reach * 1.5, 0.2, 0.2), { x: -reach * 0.25 }), M.glowActive));
    jib.add(new THREE.Mesh(placed(new THREE.BoxGeometry(0.45, 0.35, 0.38), { x: reach * 0.38, y: -0.08 }), M.dark));
    crane.add(mast, collar, jib); addOutline(crane, { thickness: 0.025 });
    group.add(crane);
    this.jib = jib;
    this.rigTip = new THREE.Vector3(crane.position.x, crane.position.y + 2.9, crane.position.z);
    this.scaffoldFront = null;
    this.scaffold = group;
    this.tower.add(group);
  }

  addBeacon(at, blinking) {
    if (this.mirror) {   // Spark: a lime (or pale) lamp on the shared materials; it pulses with the busy state, no per-building blink
      const tone = blinking ? SPARK.lime : SPARK.panel;
      const ball = this.sparkPaint(new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), sparkMaterial(tone, this.active)), tone);
      ball.position.copy(at); this.tower.add(ball);
      return;
    }
    const material = toonMaterial(blinking ? '#ff6b7a' : '#c9cedd', { emissive: blinking ? '#ff3b5c' : '#000000', emissiveIntensity: blinking ? 1 : 0, cache: false });
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), material);
    ball.position.copy(at); this.tower.add(ball);
    if (blinking) this.beaconLight = ball;
  }

  buildWindows() {
    const { W, D, floors } = this.size, s = this.style;
    const geo = windowGeometry(s.window.w, s.window.h);
    const lit = [], dark = [];
    const r = seeded(`${this.id}:windows`);
    const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const sides = [
      { len: W, n: [0, 0, 1], at: t => [t, D / 2 + 0.02], rot: 0 },
      { len: W, n: [0, 0, -1], at: t => [-t, -D / 2 - 0.02], rot: Math.PI },
      { len: D, n: [1, 0, 0], at: t => [W / 2 + 0.02, -t], rot: Math.PI / 2 },
      { len: D, n: [-1, 0, 0], at: t => [-W / 2 - 0.02, t], rot: -Math.PI / 2 },
    ];
    for (let f = 0; f < floors; f++) {
      const y = f === 0 ? PAD_TOP + 1.3 : PAD_TOP + GF + (f - 1) * FH + FH * 0.54;
      sides.forEach((side, sideIndex) => {
        const n = Math.max(1, Math.floor((side.len - 0.9) / s.window.spacing));
        for (let k = 0; k < n; k++) {
          const t = (k - (n - 1) / 2) * s.window.spacing;
          if (f === 0 && sideIndex === 0 && (Math.abs(t) < 1.15 || s.key === 'storefront')) continue;
          if (f === 0 && s.key === 'foundry' && sideIndex === 0 && t < -W / 2 + 1.7) continue;
          const [x, z] = side.at(t);
          const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q.setFromAxisAngle(up, side.rot), new THREE.Vector3(1, 1, 1));
          (r() < this.litFrac ? lit : dark).push(matrix);
        }
      });
    }
    const S = SPARK_MATERIALS;
    const sets = this.mirror ? [[lit, this.active ? S.winLitActive : S.winLit, true], [dark, S.winDark]] : this.district === 'downtown' ? [[lit, MATERIALS.glassLit], [dark, MATERIALS.glassDark]] : [[lit, MATERIALS.windowLit], [dark, MATERIALS.windowDark]];
    for (const [list, material, isLit] of sets) {
      if (!list.length) continue;
      const inst = new THREE.InstancedMesh(geo, material, list.length);
      list.forEach((matrix, k) => inst.setMatrixAt(k, matrix));
      inst.userData.noOutline = true;
      this.tower.add(inst);
      if (isLit) this.litWindows = inst;
    }
  }

  buildPad() {
    for (const child of [...this.padGroup.children]) { this.padGroup.remove(child); disposeObject(child); }
    if (this.suburbs) {
      const yard = buildSuburbYard(this.suburbs, { baseY: PAD_TOP, tag: { buildingId: this.id }, centerZ: -CZ });
      this.padGroup.add(yard); this.pad = yard; return;
    }
    const { W, D } = this.size;
    const padMaterial = this.mirror ? SPARK_MATERIALS.pad : this.district === 'downtown' ? toonMaterial('#9daeb9') : MATERIALS.pad;
    const pad = new THREE.Mesh(placed(new RoundedBoxGeometry(W + 1.2, 0.14, D + 1.2, 1, 0.12), { y: GROUND_Y + 0.05 }), padMaterial);
    pad.receiveShadow = true; pad.userData = this.mirror ? { sparkBuildingId: this.id } : { buildingId: this.id };
    addOutline(pad, { thickness: 0.03 });
    this.padGroup.add(pad);
    this.pad = pad;
  }

  setActive(on) {
    on = Boolean(on && !this.unbuilt);
    if (on === this.active) return;
    this.active = on;
    if (this.mirror) this.paintSpark();
    if (this.suburbs) {
      if (on) this.buildHomeActivity();
      else if (this.contractor) { this.contractor.group.removeFromParent(); disposeObject(this.contractor.group); this.contractor = null; }
      return;
    }
    if (on) this.buildScaffold();
    else if (this.scaffold) { this.tower.remove(this.scaffold); disposeObject(this.scaffold); this.scaffold = null; this.jib = null; this.rigTip = null; }
  }
  buildScaffold() {
    if (this.suburbs) { if (this.active) this.buildHomeActivity(); return; }
    if (this.mirror) { this.buildRig(); return; }
    if (this.scaffold) { this.tower.remove(this.scaffold); disposeObject(this.scaffold); }
    const { W, D, H } = this.size;
    const group = new THREE.Group();
    const top = PAD_TOP + H, y0 = Math.max(PAD_TOP, top - FH * 6), z = D / 2 + 0.5, width = W + 0.5;
    const poles = [], planks = [];
    const cols = Math.max(2, Math.round(width / 1.6));
    for (let k = 0; k <= cols; k++) poles.push(placed(new THREE.BoxGeometry(0.09, top + 0.7 - y0, 0.09), { x: -width / 2 + (k / cols) * width, y: (y0 + top + 0.7) / 2, z }));
    for (let y = y0 + 0.9; y <= top + 0.4; y += FH * 1.5) {
      poles.push(placed(new THREE.BoxGeometry(width, 0.07, 0.07), { y: y + 0.55, z: z + 0.22 }));
      planks.push(placed(new THREE.BoxGeometry(width, 0.07, 0.55), { y, z: z - 0.05 }));
      for (const x of [-W * 0.35, W * 0.35]) poles.push(placed(new THREE.BoxGeometry(0.1, 0.1, 0.65), { x, y, z: D / 2 + 0.25 }));
    }
    for (const [list, material] of [[poles, MATERIALS.scaffold], [planks, MATERIALS.plank]]) {
      const m = new THREE.Mesh(mergeParts(list), material); m.castShadow = true; addOutline(m, { thickness: 0.02 }); group.add(m);
    }
    // Little roof crane with a rotating jib.
    const crane = new THREE.Group(); crane.position.set(0, this.roofSurface || top, 0);
    const mast = new THREE.Mesh(placed(new THREE.BoxGeometry(0.26, 3.4, 0.26), { y: 1.7 }), MATERIALS.crane);
    const jib = new THREE.Group(); jib.position.y = 3.4;
    const reach = Math.min(W, D) * 0.34;
    jib.add(new THREE.Mesh(placed(new THREE.BoxGeometry(reach * 1.5, 0.22, 0.22), { x: -reach * 0.25 }), MATERIALS.crane));
    jib.add(new THREE.Mesh(placed(new THREE.BoxGeometry(0.48, 0.38, 0.4), { x: reach * 0.38, y: -0.1 }), toonMaterial('#6b6f80')));
    crane.add(mast, jib); addOutline(crane, { thickness: 0.025 });
    group.add(crane);
    this.jib = jib;
    this.scaffoldFront = { y0, top, z, width };
    this.scaffold = group;
    this.tower.add(group);
  }

  setHover(on) {
    if (this.hover === on) return;
    this.hover = on;
    if (this.mirror) { this.paintSpark(); return; }
    if (this.unbuilt) { this.bodyMaterial.color.set(on ? '#cce2ee' : '#b9d4e4'); return; }
    this.bodyMaterial.emissive.set(on ? '#5b4bd6' : '#000000');
    this.bodyMaterial.emissiveIntensity = on ? 0.22 : 1;
  }

  remove() {
    if (this.removing) return;
    this.removing = true;
    if (this.env.reducedMotion()) { this.anim = { kind: 'sink', t: 1 }; return; }
    this.anim = { kind: 'sink', t: 0 };
    if (!this.mirror) this.env.particles.emit('dust', this.localPoint(0, PAD_TOP + 0.4, 0), 18, { spread: this.size.W });
  }

  /* Points for NPCs, overlays and particles.
   * localPoint: in the parent group (where this building's particles live).
   * worldPoint: in island space (world.land); Spark points hang below the deck while This PC is up.
   * The view turns island space into world space (world.toWorld) for the camera and HTML overlays. */
  localPoint(x, y, z) { return new THREE.Vector3(this.origin.x + x, y, this.origin.z + z); }
  worldPoint(x, y, z) { return this.mirror ? new THREE.Vector3(this.origin.x + x, (this.env.deckY || 0) - y, -(this.origin.z + z)) : this.localPoint(x, y, z); }
  topPoint() { return this.worldPoint(0, (this.roofTop || PAD_TOP + this.size.H) * this.tower.scale.y + 0.6, 0); }
  /** Local roof contact for attached indicators. It scales with the tower during rise/grow/sink. */
  rooftopPoint() {
    if (this.home) return this.home.roofPoint.clone();
    return new THREE.Vector3(-this.size.W * 0.25, this.roofSurface || PAD_TOP + this.size.H + 0.12, this.size.D * 0.2);
  }
  get center() { return { x: this.origin.x, z: this.origin.z }; }
  get door() { return this.home ? { x: this.origin.x + this.home.door.x, z: this.origin.z + this.home.door.z + 0.2 } : { x: this.origin.x, z: this.origin.z + this.size.D / 2 + 0.3 }; }
  /** Work spot k in front of the facade, facing the building. */
  workSpot(k) {
    if (this.home) return { x: this.door.x + ((k % 3) - 1) * 0.4, z: this.door.z + 0.6 + Math.floor(k / 3) * 0.5, fx: 0, fz: -1 };
    const offsets = [0, -1.3, 1.3, -2.6, 2.6, -0.65, 0.65, -1.95, 1.95];
    const limit = this.size.W / 2 - 0.25;
    const x = Math.max(-limit, Math.min(limit, offsets[k % offsets.length]));
    return { x: this.origin.x + x, z: this.origin.z + this.size.D / 2 + 0.95 + Math.floor(k / offsets.length) * 0.8, fx: 0, fz: -1 };
  }
  get seats() { return this.suburbs ? [] : lotSeats(this.cell.i, this.cell.j); }
  get lot() { return { i: this.cell.i, j: this.cell.j, padW: this.suburbs ? HOME_LOT_SIZE : this.size.W + 1.2, padD: this.suburbs ? HOME_LOT_SIZE : this.size.D + 1.2, cz: this.suburbs ? 0 : CZ, district: this.district, ...(this.suburbs ? { driveway: { ...this.suburbs.driveway } } : {}) }; }
  /** Surface height in island coordinates, including the animated yard scale. */
  groundAt(x, z) {
    if (!this.suburbs || !this.padGroup) return null;
    const scale = this.padGroup.scale;
    if (scale.x <= 0 || scale.z <= 0) return null;
    const localX = (x - this.origin.x) / scale.x, localZ = (z - this.origin.z) / scale.z;
    if (Math.abs(localX) > HOME_LOT_SIZE / 2 || Math.abs(localZ + CZ) > HOME_LOT_SIZE / 2) return null;
    const { driveway: drive, door } = this.suburbs;
    let top = PAD_TOP;
    if (Math.abs(localX - door.x) <= 0.45 && localZ >= door.z && localZ <= drive.maxZ) top = PAD_TOP + 0.0265;
    if (Math.abs(localX - drive.x) <= drive.width / 2 && localZ >= drive.minZ && localZ <= drive.maxZ) top = PAD_TOP + 0.03;
    return top * scale.y;
  }
  /** Actual home wings in island coordinates for walking and wheel-zoom collision. */
  get collisionBoxes() {
    if (!this.suburbs) return null;
    const boxes = this.suburbs.blocks.map(b => ({ x0: this.origin.x + b.x - b.w / 2 - 0.14, x1: this.origin.x + b.x + b.w / 2 + 0.14,
      z0: this.origin.z + b.z - b.d / 2 - 0.14, z1: this.origin.z + b.z + b.d / 2 + 0.14, y0: PAD_TOP + b.bottom, y1: PAD_TOP + b.bottom + b.h + 0.2 }));
    if (this.contractor) { const drive = this.suburbs.driveway, z = Math.min(4.2, drive.minZ + 1.25); boxes.push({ x0: this.origin.x + drive.x - 0.65, x1: this.origin.x + drive.x + 0.65,
      z0: this.origin.z + z - 0.98, z1: this.origin.z + z + 0.98, y0: PAD_TOP, y1: PAD_TOP + 1.45 }); }
    return boxes;
  }

  /** Returns false when a sink animation has finished and the building can be disposed. */
  update(dt, elapsed, env) {
    if (this.suburbs && env.reducedMotion && this.anim) {
      if (this.anim.kind === 'sink') return false;
      this.anim = null; this.tower.scale.set(1, 1, 1); this.padGroup.scale.setScalar(1);
    }
    if (this.anim) {
      const a = this.anim;
      if (a.delay > 0) { a.delay -= dt; return true; }
      if (a.kind === 'rise') {
        if (a.t === 0 && !this.mirror) env.particles.emit('dust', this.localPoint(0, PAD_TOP + 0.3, 0), 22, { spread: this.size.W });
        a.t = Math.min(1, a.t + dt / 1.1);
        this.tower.scale.y = Math.max(0.02, easeOutBack(a.t));
        this.padGroup.scale.setScalar(0.6 + 0.4 * Math.min(1, a.t * 2.5));
        if (a.t >= 1) { this.tower.scale.y = 1; this.padGroup.scale.setScalar(1); this.anim = null; }
      } else if (a.kind === 'widen') {
        a.t = Math.min(1, a.t + dt / 0.8);
        const k = 1 - Math.pow(1 - a.t, 3);
        this.tower.scale.set(a.fromX + (1 - a.fromX) * k, 1, a.fromZ + (1 - a.fromZ) * k);
        if (a.t >= 1) { this.tower.scale.set(1, 1, 1); this.anim = null; }
      } else if (a.kind === 'grow') {
        a.t += dt;
        this.tower.scale.y = 1 + (a.from - 1) * Math.exp(-4.5 * a.t) * Math.cos(10 * a.t);
        if (a.up && !this.mirror && a.t < 0.6 && Math.random() < dt * 30) env.particles.emit('sparkle', this.localPoint(0, (this.roofTop || PAD_TOP + this.size.H) * this.tower.scale.y + 0.6, 0), 2, { spread: this.size.W });
        if (a.t > 1.4) { this.tower.scale.y = 1; this.anim = null; }
      } else if (a.kind === 'sink') {
        a.t = Math.min(1, a.t + dt / 0.9);
        const k = easeIn(a.t);
        this.tower.scale.set(1 - k * 0.15, Math.max(0.001, 1 - k), 1 - k * 0.15);
        this.padGroup.scale.setScalar(Math.max(0.001, 1 - k));
        if (this.unbuiltSign) this.unbuiltSign.scale.copy(this.padGroup.scale);
        if (a.t >= 1) return false;
      }
    }
    if (this.home) {
      // "Busy" means this project's existing active-agent state. No invented work
      // signal; reduced motion leaves panels and the contractor beacon steady.
      this.home.solarMaterial.emissiveIntensity = this.active ? env.reducedMotion ? 0.12 : 0.08 + Math.max(0, Math.sin(elapsed * 0.7 + this.suburbs.variant) - 0.82) * 1.5 : 0.08;
      if (this.contractor) this.contractor.amberMaterial.emissiveIntensity = env.reducedMotion ? 0.7 : (elapsed * 1.4) % 1 < 0.5 ? 1.1 : 0.2;
    }
    if (env.reducedMotion) return true;
    if (this.mirror && env.offline) return true;   // Spark offline: its twins stand still (no gear, flag, beacon or sparks)
    if (this.gear) this.gear.rotation.z -= dt * 0.8;
    if (this.flag) this.flag.rotation.y = Math.sin(elapsed * 2.2 + this.origin.x) * 0.3;
    if (this.beaconLight) this.beaconLight.material.emissiveIntensity = (elapsed * 1.4 + this.origin.z) % 1 < 0.5 ? 1.4 : 0.1;
    if (this.jib) this.jib.rotation.y = Math.sin(elapsed * 0.35 + this.origin.x) * 1.2;
    if (env.particles.enabled && !this.removing) {
      this.elapsedEmit += dt;
      if (this.chimneyTop && Math.random() < dt * 1.6) env.particles.emit('smoke', this.localPoint(this.chimneyTop.x, this.chimneyTop.y * this.tower.scale.y, this.chimneyTop.z), 1, { spread: 0.25 });
      // Busy Spark buildings shed a few green / lime sparks from their rig (into the Spark group's own particles,
      // so they fall back toward the Spark deck whichever way the island is turned).
      if (this.rigTip && Math.random() < dt * 2.4) env.particles.emit('spark', this.localPoint(this.rigTip.x, this.rigTip.y * this.tower.scale.y, this.rigTip.z), 3, { spread: 0.3, colors: SPARK_SPARKS });
      if (this.active && this.scaffoldFront && this.elapsedEmit > 0.28) {
        this.elapsedEmit = 0;
        const f = this.scaffoldFront;
        const y = f.y0 + 0.9 + Math.floor(Math.random() * Math.max(1, (f.top - f.y0) / (FH * 1.5))) * FH * 1.5;
        env.particles.emit('spark', this.localPoint((Math.random() - 0.5) * f.width * 0.8, (y + 0.15) * this.tower.scale.y, f.z), 6, { spread: 0.2 });
      }
    }
    return true;
  }

  dispose() { this.clearTower(); disposeObject(this.padGroup); this.group.removeFromParent(); }
}

/* ---------- manager ---------- */
export class BuildingManager {
  constructor(parent, env) {
    this.parent = parent;
    this.env = env;               // { particles, reducedMotion(), animateIn, stagger() }
    this.items = new Map();
    this.removing = new Set();
    this.selection = this.makeRing();
    parent.add(this.selection);
  }
  makeRing() {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.0, 64), new THREE.MeshBasicMaterial({ color: '#8b7bff', transparent: true, opacity: 0.85, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.visible = false; ring.renderOrder = 3; ring.raycast = () => {};
    return ring;
  }
  get(id) { const b = this.items.get(id); return b && !b.removing ? b : null; }
  get list() { return [...this.items.values()].filter(b => !b.removing); }
  groundAt(x, z) {
    for (const b of this.items.values()) { if (!b.removing) { const y = b.groundAt(x, z); if (y !== null) return y; } }
    return null;
  }

  /** projects + their cells (Map id → cell) + Set of project ids with active agents.
   * tickers: Map project id → access ticker segments (omitted: leave tickers as they are); paused:
   * tickers grey and still. Returns true when lot footprints changed (decor needs rebuilding). */
  sync(projects, cells, activeIds, { animate = true, tickers = null, paused = false, districts = false } = {}) {
    let lotsChanged = false, staggerIndex = 0;
    const seen = new Set();
    for (const project of projects) {
      const cell = cells.get(project.id);
      if (!cell) continue;
      seen.add(project.id);
      let building = this.items.get(project.id);
      if (building && (building.removing || building.cell.i !== cell.i || building.cell.j !== cell.j)) {
        if (!building.removing) building.remove();
        this.removing.add(building); this.items.delete(project.id); building = null;
      }
      if (!building) {
        const index = staggerIndex++;
        building = new Building(project, cell, { ...this.env, districts, animateIn: animate, stagger: () => (animate ? index * 0.08 : 0) });
        this.items.set(project.id, building);
        this.parent.add(building.group);
        lotsChanged = true;
      } else { building.env.districts = districts; if (building.apply(project, { animate })) lotsChanged = true; }
      building.setActive(activeIds.has(project.id));
      if (tickers) building.setTicker(tickers.get(project.id) || null, paused);
    }
    for (const [id, building] of this.items) {
      if (seen.has(id)) continue;
      building.remove(); this.removing.add(building); this.items.delete(id); lotsChanged = true;
    }
    return lotsChanged;
  }
  lots() { const map = new Map(); for (const b of this.items.values()) map.set(cellKey(b.cell.i, b.cell.j), b.lot); return map; }
  pickables() { const out = []; for (const b of this.items.values()) out.push(...b.pickables); return out; }
  select(id) {
    const b = id && this.get(id);
    this.selection.visible = !!b;
    if (b) {
      this.selection.position.set(b.origin.x, GROUND_Y + 0.2, b.origin.z);
      this.selection.scale.set((b.size.W + 1.6) * 0.62, (b.size.D + 1.6) * 0.62, 1);
    }
  }
  update(dt, elapsed, env) {
    for (const b of this.items.values()) b.update(dt, elapsed, env);
    for (const b of this.removing) if (!b.update(dt, elapsed, env)) { b.dispose(); this.removing.delete(b); }
    if (this.selection.visible) this.selection.material.opacity = env.reducedMotion ? 0.85 : 0.6 + Math.sin(elapsed * 4) * 0.25;
  }
  dispose() {
    for (const b of [...this.items.values(), ...this.removing]) b.dispose();
    this.items.clear(); this.removing.clear();
    disposeObject(this.selection); this.selection.removeFromParent();
  }
}
