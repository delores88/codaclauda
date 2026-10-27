/* CodaClauda little people: original "soft-block chibi" characters for the 3D
 * City (many NPCs) and the avatar builder (one big turntable preview).
 *
 * Look: a big soft-cornered cube head (~40% of height), a compact rounded
 * torso, stubby block limbs with mitten hands, toon shading and thin ink
 * outlines. Faces and chest badges are painted on small canvases; every mesh
 * shape is a cached, shared geometry so a crowd stays cheap. Agents carry a
 * floating "spark gem" (faceted gem + orbiting provider-coloured ring) that
 * shows Working / Awake / Powered down at a glance.
 *
 * API
 *   createPerson(spec, { role, provider, quality, faceSize }) -> Person
 *   Person: object, pickable[], setStatus, setAction, setHighlight, lookAt,
 *           update(dt), setSpec, dispose, plus topY / headCenterY getters,
 *           shadow (blob mesh, hide it if the scene has real shadows) and
 *           walkCadence (walk cycles per second, default 1 = 2 steps/s).
 *   defaultOwnerSpec(), headshot(spec, size) -> Promise<dataURL>,
 *   setReducedMotion(bool), PERSON_HEIGHT, SEAT_HEIGHT, WALK_SPEED, ACTIONS.
 *
 * Built on three.js (MIT). */
import { THREE, toonMaterial, addOutline, shade, INK, gradientMap } from './toon.js';
import { RoundedBoxGeometry } from '../../vendor/three/addons/RoundedBoxGeometry.js';
import { mergeGeometries } from '../../vendor/three/addons/BufferGeometryUtils.js';
import { normalizeAvatar, defaultAvatar, hash } from '../avatar/spec.js';

export const PERSON_HEIGHT = 1.7;
/** Top of a bench seat that setAction('sit') rests the hips on. */
export const SEAT_HEIGHT = 0.45;
/** Ground speed (units/s) that matches the walk cycle at walkCadence 1. */
export const WALK_SPEED = 0.85;
export const ACTIONS = ['stand', 'walk', 'work', 'sit', 'wave', 'talk'];

const ACCENT = '#a597ff';
const STATUS_COLORS = { active: '#3ccf8e', idle: '#f5b544', offline: '#7d8299', error: '#ff5d6c' };   // error: a CodaClauda session whose last turn failed
const RING_COLORS = { claude: '#d97757', codex: '#10a37f', other: '#a597ff' };
const GEM_MOTION = {
  active: { spin: 2.4, ring: 2.6, bob: 0.045, bobRate: 3.2, drop: 0, glow: 0.62 },
  idle: { spin: 0.7, ring: 0.9, bob: 0.022, bobRate: 1.4, drop: 0, glow: 0.42 },
  offline: { spin: 0.12, ring: 0.25, bob: 0.008, bobRate: 0.8, drop: 0.05, glow: 0 },
  error: { spin: 0.3, ring: 0.4, bob: 0.03, bobRate: 4.2, drop: 0, glow: 0.5 },
};
const BLEND = 0.25; // seconds to cross-fade between actions

// Proportions (units; the whole person is ~1.7 tall with feet at y = 0).
const HEAD = { w: 0.68, h: 0.66, d: 0.6, r: 0.16 };
const TORSO = { w: 0.54, h: 0.4, d: 0.34, r: 0.11 };
const PELVIS = { w: 0.46, h: 0.17, d: 0.3, r: 0.07 };
const LEG = { thigh: 0.23, shin: 0.22, ankle: 0.11, x: 0.12 };
const ARM = { upper: 0.17, fore: 0.14 };

// The face canvas is planar-mapped across the head's front face (out to the
// 45-degree point of each rounded edge). These convert head-local units to
// canvas units so 3D glasses line up with painted eyes.
const FACE_EX = HEAD.w / 2 - HEAD.r + HEAD.r * Math.SQRT1_2;
const FACE_EY = HEAD.h / 2 - HEAD.r + HEAD.r * Math.SQRT1_2;
const fx = x => 0.5 + x / (2 * FACE_EX);
const fy = y => 0.5 - (y - HEAD.h / 2) / (2 * FACE_EY);
const EYE_WORLD = { x: 0.115, y: 0.32 };
const EYE_X = [fx(-EYE_WORLD.x), fx(EYE_WORLD.x)];
const EYE_Y = fy(EYE_WORLD.y);

// Highest point of each hair style (head-local), for the gem and hats.
const HAIR_TOP = { short: 0.72, messy: 0.83, buzz: 0.69, curly: 0.84, long: 0.72, ponytail: 0.72, bun: 0.91, mohawk: 0.9, bald: 0.66 };
const CROWN_BASE = { short: 0.7, messy: 0.73, buzz: 0.67, curly: 0.76, long: 0.7, ponytail: 0.7, bun: 0.7, mohawk: 0.65, bald: 0.645 };

let reducedMotion = (() => {
  try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
})();
/** Calmer idle motion, no gem spin-up pop, static "z"s. Call with store.prefs.reducedMotion. */
export function setReducedMotion(on) { reducedMotion = !!on; }

/* ---------- small helpers ---------- */
const smooth = w => w * w * (3 - 2 * w);
function wrapAngle(a) { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; }
function easeOutBack(x) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2; }
function rgb(hex) { const n = parseInt(String(hex).slice(1), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgba(hex, a) { const [r, g, b] = rgb(hex); return `rgba(${r},${g},${b},${a})`; }
function luminance(hex) { const [r, g, b] = rgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }
function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeCanvas(size) { const c = document.createElement('canvas'); c.width = size; c.height = size; return c; }
function canvasTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  return tex;
}
const noRaycast = () => {};

/* ---------- shared geometry ---------- */
const geoCache = new Map();
function cachedGeo(key, make) {
  let geo = geoCache.get(key);
  if (geo === undefined) {
    geo = make() || null;
    if (geo) { geo.computeBoundingBox(); geo.computeBoundingSphere(); geo.userData.shared = true; }
    geoCache.set(key, geo);
  }
  return geo;
}
const segs = q => (q === 'low' ? 1 : 2);
const box = (w, h, d, r, q) => cachedGeo(`box|${w}|${h}|${d}|${r}|${q}`, () => new RoundedBoxGeometry(w, h, d, segs(q), r));
const cyl = (rt, rb, h, q) => cachedGeo(`cyl|${rt}|${rb}|${h}|${q}`, () => new THREE.CylinderGeometry(rt, rb, h, q === 'low' ? 8 : 14));
const ball = (r, q) => cachedGeo(`ball|${r}|${q}`, () => new THREE.SphereGeometry(r, q === 'low' ? 8 : 12, q === 'low' ? 6 : 9));

/** Shape placed for merging: scale, then rotate X, Y, Z, then translate. */
function place(geo, t = {}) {
  let g = geo;
  if (g.index) { g = geo.toNonIndexed(); geo.dispose(); }
  if (t.sx || t.sy || t.sz) g.scale(t.sx ?? 1, t.sy ?? 1, t.sz ?? 1);
  if (t.rx) g.rotateX(t.rx);
  if (t.ry) g.rotateY(t.ry);
  if (t.rz) g.rotateZ(t.rz);
  g.translate(t.x ?? 0, t.y ?? 0, t.z ?? 0);
  return g;
}
const pBox = (w, h, d, r, t, q) => place(new RoundedBoxGeometry(w, h, d, segs(q), r), t);
const pBall = (r, t, q) => place(new THREE.SphereGeometry(r, q === 'low' ? 8 : 14, q === 'low' ? 6 : 10), t);
const pCone = (r, h, t, q) => place(new THREE.ConeGeometry(r, h, q === 'low' ? 5 : 7), t);
const pCyl = (rt, rb, h, t, q) => place(new THREE.CylinderGeometry(rt, rb, h, q === 'low' ? 8 : 14), t);
const pTorus = (R, tube, t, q, arc = Math.PI * 2) => place(new THREE.TorusGeometry(R, tube, q === 'low' ? 5 : 8, q === 'low' ? 16 : 28, arc), t);

function merge(parts) {
  const list = parts.flat().filter(Boolean);
  if (!list.length) return null;
  for (const g of list) {
    g.clearGroups();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  if (list.length === 1) return list[0];
  const merged = mergeGeometries(list, false);
  list.forEach(g => g.dispose());
  return merged;
}
/** Cached merged shape, re-centred so ink outlines scale evenly; userData.offset restores its place. */
function composite(key, q, build) {
  return cachedGeo(`${key}|${q}`, () => {
    const g = merge(build(q));
    if (!g) return null;
    g.computeBoundingBox();
    const c = g.boundingBox.getCenter(new THREE.Vector3());
    g.translate(-c.x, -c.y, -c.z);
    g.userData.offset = c;
    return g;
  });
}

function headGeometry(q) {
  return cachedGeo(`head|${q}`, () => {
    const g = new RoundedBoxGeometry(HEAD.w, HEAD.h, HEAD.d, q === 'low' ? 2 : 3, HEAD.r);
    // Planar UVs on the front (+Z, material group 4) so the painted face maps predictably.
    const front = g.groups.find(group => group.materialIndex === 4);
    const pos = g.attributes.position, uv = g.attributes.uv;
    if (front) for (let i = front.start; i < front.start + front.count; i++) uv.setXY(i, 0.5 + pos.getX(i) / (2 * FACE_EX), 0.5 + pos.getY(i) / (2 * FACE_EY));
    uv.needsUpdate = true;
    return g;
  });
}

/* ---------- hair (head-local: head spans y 0..0.66, face at z +0.3) ---------- */
function hairParts(style, q) {
  const cap = () => pBox(0.74, 0.24, 0.68, 0.11, { y: 0.6, z: -0.01 }, q);
  const back = (h = 0.42, y = 0.43) => pBox(0.72, h, 0.26, 0.1, { y, z: -0.19 }, q);
  const bang = (w, x, y, rz, h = 0.12) => pBox(w, h, 0.09, 0.045, { x, y, z: 0.31, rz }, q);
  const under = () => pBox(0.74, 0.2, 0.52, 0.08, { y: 0.44, z: -0.08 }, q);
  const longBack = () => [
    pBox(0.76, 0.86, 0.22, 0.1, { y: 0.26, z: -0.24 }, q),
    ...[1, -1].map(s => pBox(0.11, 0.6, 0.3, 0.05, { x: s * 0.365, y: 0.31, z: -0.02 }, q)),
  ];
  switch (style) {
    case 'short':
      return [cap(), back(), bang(0.26, -0.17, 0.53, 0.28), bang(0.3, 0.05, 0.535, -0.12), bang(0.2, 0.25, 0.55, -0.4, 0.11),
        ...[1, -1].map(s => pBox(0.07, 0.2, 0.22, 0.03, { x: s * 0.35, y: 0.42 }, q))];
    case 'messy': {
      const parts = [pBox(0.73, 0.2, 0.66, 0.09, { y: 0.6, z: -0.01 }, q), back(0.36, 0.45)];
      const spikes = [[-0.22, 0.7, 0.1, 0.35, 0.6], [0, 0.74, 0.12, 0.45, 0], [0.22, 0.7, 0.08, 0.35, -0.6],
        [-0.15, 0.73, -0.13, -0.45, 0.4], [0.16, 0.73, -0.13, -0.45, -0.4], [0, 0.66, -0.27, -1.05, 0]];
      for (const [x, y, z, rx, rz] of spikes) parts.push(pCone(0.088, 0.22, { x, y, z, rx, rz }, q));
      for (const [x, rz] of [[-0.17, 0.3], [0.02, 0.25], [0.2, 0.2]]) parts.push(pCone(0.078, 0.2, { x, y: 0.54, z: 0.3, rx: 2.3, rz }, q));
      return parts;
    }
    case 'buzz':
      return [pBox(0.7, 0.3, 0.62, 0.15, { y: 0.535, z: -0.015 }, q)];
    case 'curly': {
      const parts = [pBox(0.72, 0.3, 0.64, 0.15, { y: 0.55, z: -0.02 }, q)];
      const rows = q === 'low' ? [[0.1, 6, 0.12], [0.65, 5, 0.12], [1.2, 3, 0.12]] : [[0.1, 10, 0.105], [0.62, 8, 0.11], [1.1, 5, 0.11]];
      rows.forEach(([e, n, r], row) => {
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + row * 0.4;
          const x = 0.36 * Math.cos(e) * Math.sin(a), y = 0.47 + 0.26 * Math.sin(e), z = -0.03 + 0.33 * Math.cos(e) * Math.cos(a);
          if (z > 0.12 && y < 0.6) continue; // keep the face clear
          parts.push(pBall(r, { x, y, z }, q));
        }
      });
      parts.push(pBall(0.12, { y: 0.72, z: -0.03 }, q));
      for (const x of q === 'low' ? [-0.15, 0.15] : [-0.21, -0.07, 0.07, 0.21]) parts.push(pBall(0.085, { x, y: 0.55 + Math.abs(x) * 0.08, z: 0.27 }, q));
      return parts;
    }
    case 'long':
      return [cap(), ...longBack(), bang(0.34, -0.15, 0.535, 0.2), bang(0.34, 0.15, 0.535, -0.2)];
    case 'ponytail':
      return [cap(), back(0.36, 0.46), bang(0.42, -0.08, 0.535, 0.16, 0.13), bang(0.18, 0.24, 0.555, -0.3, 0.1), pBall(0.06, { y: 0.5, z: -0.33 }, q)];
    case 'bun':
      return [cap(), back(), bang(0.3, -0.13, 0.535, 0.18), bang(0.3, 0.15, 0.535, -0.18),
        pBall(0.15, { y: 0.76, z: -0.12 }, q), pTorus(0.1, 0.028, { rx: Math.PI / 2 - 0.3, y: 0.655, z: -0.1 }, q)];
    case 'mohawk':
      return [[0.15, 0.22, 0.35], [0.2, 0.11, 0.2], [0.23, -0.01, 0.05], [0.2, -0.13, -0.12], [0.15, -0.24, -0.28]]
        .map(([h, z, rx]) => pBox(0.11, h + 0.06, 0.15, 0.045, { y: 0.63 + h / 2, z, rx }, q));
    case 'hat': return [under()];
    case 'long-hat': return [under(), ...longBack()];
    case 'ponytail-hat': return [under(), pBall(0.06, { y: 0.5, z: -0.33 }, q)];
    default: return [];
  }
}
const hatHair = style => (style === 'bald' ? 'bald' : style === 'long' ? 'long-hat' : style === 'ponytail' ? 'ponytail-hat' : 'hat');
const hairGeometry = (variant, q) => (variant === 'bald' ? null : composite(`hair|${variant}`, q, qq => hairParts(variant, qq)));
const tailGeometry = q => composite('tail', q, qq => [
  pBall(0.1, { y: -0.03, z: -0.03 }, qq), pCone(0.105, 0.36, { y: -0.21, z: -0.05, rx: Math.PI }, qq), pBall(0.045, { y: -0.37, z: -0.05 }, qq),
]);

/* ---------- accessories (head-local) ---------- */
const glassesGeometry = (q, tube) => composite(`glasses|${tube}`, q, qq => {
  const parts = [pBox(0.07, 0.018, 0.018, 0.008, { y: EYE_WORLD.y + 0.015, z: 0.318 }, qq)];
  for (const s of [1, -1]) {
    parts.push(pTorus(0.07, tube, { sx: 1.12, x: s * EYE_WORLD.x, y: EYE_WORLD.y, z: 0.318 }, qq));
    // Temple arm wraps the rounded corner of the head, then runs back along the side.
    parts.push(pTorus(0.18, tube * 0.8, { rx: Math.PI / 2, ry: s > 0 ? 0 : -Math.PI / 2, x: s * 0.18, y: EYE_WORLD.y + 0.01, z: 0.14 }, qq, Math.PI / 2));
    parts.push(pBox(0.018, 0.018, 0.25, 0.008, { x: s * 0.36, y: EYE_WORLD.y + 0.01, z: 0.015 }, qq));
  }
  return parts;
});
const lensGeometry = q => composite('lens', q, qq => [1, -1].map(s => pCyl(0.066, 0.066, 0.012, { sx: 1.12, rx: Math.PI / 2, x: s * EYE_WORLD.x, y: EYE_WORLD.y, z: 0.322 }, qq)));
const glintGeometry = q => composite('glint', q, qq => [1, -1].map(s => pBox(0.085, 0.014, 0.004, 0.002, { rz: 0.6, x: s * EYE_WORLD.x + 0.012, y: EYE_WORLD.y + 0.015, z: 0.33 }, qq)));
const capGeometry = q => composite('cap', q, qq => [
  pBox(0.75, 0.26, 0.7, 0.12, { y: 0.62, z: -0.01 }, qq), pBall(0.035, { y: 0.755, z: -0.01 }, qq),
  pBox(0.58, 0.035, 0.26, 0.017, { rx: -0.12, y: 0.505, z: 0.4 }, qq),
]);
const beanieGeometry = q => composite('beanie', q, qq => [pBox(0.76, 0.32, 0.7, 0.15, { y: 0.62, z: -0.01 }, qq), pBall(0.075, { y: 0.8, z: -0.01 }, qq)]);
const beanieCuffGeometry = q => composite('beanie-cuff', q, qq => [pBox(0.79, 0.11, 0.73, 0.05, { y: 0.5, z: -0.01 }, qq)]);
const headphonesGeometry = (q, R) => composite(`headphones|${R}`, q, qq => {
  const cupX = Math.max(0.375, R - 0.02);
  return [pTorus(R, 0.032, { y: 0.36 }, qq, Math.PI), ...[1, -1].map(s => pBox(0.1, 0.2, 0.2, 0.05, { x: s * cupX, y: 0.33 }, qq))];
});
const crownGeometry = q => composite('crown', q, qq => {
  const parts = [pCyl(0.2, 0.185, 0.1, { y: 0.05 }, qq)];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    parts.push(pCone(0.045, 0.11, { x: 0.19 * Math.sin(a), y: 0.15, z: 0.19 * Math.cos(a) }, qq));
    parts.push(pBall(0.024, { x: 0.19 * Math.sin(a), y: 0.21, z: 0.19 * Math.cos(a) }, qq));
  }
  return parts;
});

/* ---------- torso shapes (chest-local: torso spans y 0..0.4) ---------- */
const torsoGeometry = (style, q) => composite(`torso|${style}`, q, qq => {
  const parts = [pBox(TORSO.w, TORSO.h, TORSO.d, TORSO.r, { y: TORSO.h / 2 }, qq)];
  if (style === 'hoodie') parts.push(pBox(0.42, 0.2, 0.16, 0.07, { rx: 0.3, y: TORSO.h - 0.03, z: -TORSO.d / 2 - 0.035 }, qq));
  if (style === 'jacket') parts.push(pBox(0.42, 0.08, 0.2, 0.03, { y: TORSO.h + 0.01, z: -0.05 }, qq));
  return parts;
});
const collarGeometry = (R, tube, q) => composite(`collar|${R}|${tube}`, q, qq => [pTorus(R, tube, { rx: Math.PI / 2, y: TORSO.h - 0.005 }, qq)]);

/* ---------- painted face ---------- */
const oval = (g, x, y, rx, ry) => { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); };

function paintFace(canvas, spec, closed) {
  const S = canvas.width, g = canvas.getContext('2d');
  g.setTransform(S, 0, 0, S, 0, 0);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.fillStyle = spec.skin;
  g.fillRect(0, 0, 1, 1);
  const chin = g.createLinearGradient(0, 0.84, 0, 1);
  chin.addColorStop(0, rgba(INK, 0));
  chin.addColorStop(1, rgba(INK, 0.1));
  g.fillStyle = chin;
  g.fillRect(0, 0.84, 1, 0.16);
  paintHairline(g, spec);
  paintBlush(g, spec.blush);
  const fh = spec.facialHair.style;
  const rand = prng(hash(`${spec.skin}|${spec.facialHair.color}|${fh}`));
  if (fh === 'stubble' || fh === 'mustache-stubble') paintStubble(g, spec.facialHair.color, rand);
  if (fh === 'beard') paintBeard(g, spec, rand);
  for (const x of EYE_X) paintEye(g, x, EYE_Y, spec, closed);
  paintBrows(g, spec);
  const mouthBottom = paintMouth(g, spec.mouth);
  if (fh === 'goatee') paintGoatee(g, spec.facialHair.color, mouthBottom);
  if (fh === 'mustache' || fh === 'mustache-stubble' || fh === 'beard') paintMustache(g, spec.facialHair.color);
}

function paintHairline(g, spec) {
  const st = spec.hair.style;
  if (st === 'bald') return;
  g.fillStyle = spec.hair.color;
  if (st === 'mohawk') {
    g.beginPath(); g.moveTo(0.42, 0); g.lineTo(0.58, 0); g.lineTo(0.56, 0.13); g.quadraticCurveTo(0.5, 0.15, 0.44, 0.13); g.closePath(); g.fill();
    g.fillStyle = rgba(spec.hair.color, 0.2); g.fillRect(0, 0, 1, 0.12); // shaved sides
    return;
  }
  const d = st === 'buzz' ? 0.15 : 0.2;
  g.beginPath();
  g.moveTo(0, 0); g.lineTo(1, 0); g.lineTo(1, d + 0.02);
  g.quadraticCurveTo(0.86, d - 0.06, 0.72, d - 0.03);
  g.quadraticCurveTo(0.6, d - 0.02, 0.5, d + 0.03);
  g.quadraticCurveTo(0.4, d - 0.02, 0.28, d - 0.03);
  g.quadraticCurveTo(0.14, d - 0.06, 0, d + 0.02);
  g.closePath(); g.fill();
}

function paintBlush(g, amount) {
  if (amount < 0.03) return;
  for (const x of [0.2, 0.8]) {
    const y = 0.635;
    const grad = g.createRadialGradient(x, y, 0, x, y, 0.085);
    grad.addColorStop(0, `rgba(255,105,125,${(0.55 * amount).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(255,105,125,0)');
    g.save();
    g.translate(x, y); g.scale(1, 0.6); g.translate(-x, -y);
    g.fillStyle = grad; g.fillRect(x - 0.1, y - 0.1, 0.2, 0.2);
    g.restore();
  }
}

function paintEye(g, x, y, spec, closed) {
  const style = spec.eyes.style;
  g.strokeStyle = INK;
  if (style === 'happy') {
    g.lineWidth = 0.026;
    g.beginPath(); g.moveTo(x - 0.06, y + 0.024); g.quadraticCurveTo(x, y - 0.062, x + 0.06, y + 0.024); g.stroke();
    return;
  }
  if (closed) {
    g.lineWidth = 0.022;
    g.beginPath(); g.moveTo(x - 0.062, y + 0.004); g.quadraticCurveTo(x, y + 0.046, x + 0.062, y + 0.004); g.stroke();
    return;
  }
  const rx = 0.068, ry = 0.084, iris = spec.eyes.color;
  oval(g, x, y, rx, ry); g.fillStyle = INK; g.fill();
  oval(g, x, y + 0.007, rx - 0.014, ry - 0.016); g.fillStyle = iris; g.fill();
  g.save();
  oval(g, x, y + 0.007, rx - 0.014, ry - 0.016); g.clip();
  g.fillStyle = rgba(shade(iris, -0.22), 0.85); g.fillRect(x - rx, y - ry, rx * 2, ry * 0.8);
  oval(g, x, y + 0.055, 0.036, 0.016); g.fillStyle = rgba(shade(iris, 0.22), 0.9); g.fill();
  g.restore();
  oval(g, x, y + 0.012, 0.028, 0.036); g.fillStyle = '#120e18'; g.fill();
  g.fillStyle = '#ffffff';
  oval(g, x + 0.022, y - 0.028, 0.02, 0.02); g.fill();
  oval(g, x - 0.02, y + 0.03, 0.009, 0.009); g.fill();
  g.lineWidth = 0.018;
  g.beginPath(); g.ellipse(x, y, rx, ry, 0, Math.PI * 1.08, Math.PI * 1.92); g.stroke();
  if (style === 'sleepy') {
    g.save();
    oval(g, x, y, rx + 0.006, ry + 0.006); g.clip();
    g.fillStyle = shade(spec.skin, -0.05); g.fillRect(x - rx - 0.01, y - ry - 0.01, rx * 2 + 0.02, ry * 0.95 + 0.01);
    g.restore();
    g.lineWidth = 0.02;
    g.beginPath(); g.moveTo(x - rx - 0.004, y - 0.006); g.quadraticCurveTo(x, y + 0.01, x + rx + 0.004, y - 0.006); g.stroke();
  }
}

function paintBrows(g, spec) {
  const thick = spec.brows.thickness;
  if (thick < 0.03) return;
  const base = spec.hair.style === 'bald' ? spec.facialHair.color : spec.hair.color;
  const st = spec.eyes.style;
  const y = st === 'happy' ? 0.37 : st === 'sleepy' ? 0.405 : 0.385;
  const arch = st === 'happy' ? 0.03 : st === 'sleepy' ? 0.006 : 0.02;
  g.strokeStyle = shade(base, -0.1);
  g.lineWidth = 0.008 + thick * 0.032;
  EYE_X.forEach((x, i) => {
    const out = i === 0 ? -1 : 1;
    g.beginPath();
    g.moveTo(x - out * 0.048, y + 0.006);
    g.quadraticCurveTo(x, y - arch, x + out * 0.058, y + (st === 'sleepy' ? 0.018 : 0.008));
    g.stroke();
  });
}

/** Paints the mouth; returns its lowest canvas y so a goatee can sit below it. */
function paintMouth(g, mouth) {
  const lip = '#4a1f2b';
  if (mouth === 'grin') {
    const shape = () => {
      g.beginPath(); g.moveTo(0.43, 0.7); g.quadraticCurveTo(0.5, 0.712, 0.57, 0.7);
      g.quadraticCurveTo(0.565, 0.79, 0.5, 0.79); g.quadraticCurveTo(0.435, 0.79, 0.43, 0.7); g.closePath();
    };
    shape(); g.fillStyle = lip; g.fill();
    g.save(); shape(); g.clip();
    g.fillStyle = '#fffaf2'; g.fillRect(0.4, 0.69, 0.2, 0.036);
    oval(g, 0.5, 0.795, 0.05, 0.03); g.fillStyle = '#ff7f93'; g.fill();
    g.restore();
    shape(); g.strokeStyle = '#2e1220'; g.lineWidth = 0.01; g.stroke();
    return 0.79;
  }
  g.strokeStyle = lip;
  if (mouth === 'neutral') {
    g.lineWidth = 0.017;
    g.beginPath(); g.moveTo(0.462, 0.722); g.quadraticCurveTo(0.5, 0.73, 0.538, 0.72); g.stroke();
    return 0.73;
  }
  g.lineWidth = 0.018;
  g.beginPath(); g.moveTo(0.445, 0.706); g.quadraticCurveTo(0.5, 0.762, 0.555, 0.706); g.stroke();
  return 0.74;
}

function jawPath(g, top) {
  g.beginPath();
  g.moveTo(0.03, top);
  g.bezierCurveTo(0.04, 0.9, 0.26, 1.02, 0.5, 1.02);
  g.bezierCurveTo(0.74, 1.02, 0.96, 0.9, 0.97, top);
  g.bezierCurveTo(0.9, top + 0.03, 0.8, 0.665, 0.66, 0.668);
  g.quadraticCurveTo(0.5, 0.64, 0.34, 0.668);
  g.bezierCurveTo(0.2, 0.665, 0.1, top + 0.03, 0.03, top);
  g.closePath();
}

function paintStubble(g, color, rand) {
  g.save();
  jawPath(g, 0.6); g.fillStyle = rgba(color, 0.16); g.fill(); g.clip();
  g.fillStyle = rgba(color, 0.42);
  g.beginPath();
  for (let i = 0; i < 900; i++) {
    const x = 0.03 + rand() * 0.94, y = 0.6 + rand() * 0.42, r = 0.0025 + rand() * 0.003;
    g.moveTo(x + r, y); g.arc(x, y, r, 0, Math.PI * 2);
  }
  g.fill();
  g.restore();
}

function paintBeard(g, spec, rand) {
  const c = spec.facialHair.color;
  g.save();
  jawPath(g, 0.5); g.fillStyle = c; g.fill(); g.clip();
  g.strokeStyle = rgba(shade(c, 0.14), 0.55); g.lineWidth = 0.008;
  for (let i = 0; i < 60; i++) {
    const x = 0.05 + rand() * 0.9, y = 0.6 + rand() * 0.38;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 0.012, y + 0.02, x + 0.004, y + 0.04); g.stroke();
  }
  g.restore();
  oval(g, 0.5, 0.728, 0.078, 0.042); g.fillStyle = shade(spec.skin, -0.06); g.fill(); // lip opening
}

function paintMustache(g, color) {
  g.beginPath();
  g.moveTo(0.5, 0.668);
  g.bezierCurveTo(0.53, 0.655, 0.58, 0.655, 0.61, 0.672);
  g.quadraticCurveTo(0.635, 0.69, 0.628, 0.708);
  g.quadraticCurveTo(0.58, 0.693, 0.5, 0.698);
  g.quadraticCurveTo(0.42, 0.693, 0.372, 0.708);
  g.quadraticCurveTo(0.365, 0.69, 0.39, 0.672);
  g.bezierCurveTo(0.42, 0.655, 0.47, 0.655, 0.5, 0.668);
  g.closePath();
  g.fillStyle = color; g.fill();
  g.strokeStyle = shade(color, -0.2); g.lineWidth = 0.004; g.stroke();
}

function paintGoatee(g, color, mouthBottom) {
  const y = mouthBottom + 0.018;
  g.beginPath();
  g.moveTo(0.445, y); g.quadraticCurveTo(0.5, y - 0.012, 0.555, y);
  g.lineTo(0.54, y + 0.09); g.quadraticCurveTo(0.5, y + 0.13, 0.46, y + 0.09);
  g.closePath();
  g.fillStyle = color; g.fill();
}

/* ---------- chest badge (shared per emblem + badge colour) ---------- */
const emblemCache = new Map();
function emblemMaterial(emblem, badge) {
  const key = `${emblem}|${badge}`;
  if (emblemCache.has(key)) return emblemCache.get(key);
  const c = makeCanvas(128), g = c.getContext('2d');
  g.setTransform(128, 0, 0, 128, 0, 0);
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.arc(0.5, 0.5, 0.44, 0, Math.PI * 2);
  g.fillStyle = badge; g.fill();
  g.lineWidth = 0.06; g.strokeStyle = INK; g.stroke();
  paintGlyph(g, emblem, badge);
  const material = toonMaterial('#ffffff', { map: canvasTexture(c) });
  material.alphaTest = 0.5;
  material.userData.shared = true;
  emblemCache.set(key, material);
  return material;
}

function paintGlyph(g, emblem, badge) {
  const light = luminance(badge) > 0.55;
  const readable = color => (Math.abs(luminance(color) - luminance(badge)) < 0.2 ? (light ? INK : '#ffffff') : color);
  const filled = (color, points) => {
    g.beginPath(); points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
    g.fillStyle = color; g.fill(); g.lineWidth = 0.035; g.strokeStyle = INK; g.stroke();
  };
  switch (emblem) {
    case 'claude': // coral sparkle burst
      g.strokeStyle = readable('#d97757');
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 + 0.15, len = i % 2 ? 0.2 : 0.3;
        g.lineWidth = i % 2 ? 0.055 : 0.075;
        g.beginPath(); g.moveTo(0.5 + Math.cos(a) * 0.05, 0.5 + Math.sin(a) * 0.05); g.lineTo(0.5 + Math.cos(a) * len, 0.5 + Math.sin(a) * len); g.stroke();
      }
      break;
    case 'codex': // terminal prompt
      g.strokeStyle = readable(light ? '#0e8f6f' : '#5fe0b9'); g.lineWidth = 0.085;
      g.beginPath(); g.moveTo(0.27, 0.34); g.lineTo(0.45, 0.5); g.lineTo(0.27, 0.66); g.stroke();
      g.beginPath(); g.moveTo(0.53, 0.67); g.lineTo(0.73, 0.67); g.stroke();
      break;
    case 'star': {
      const pts = [];
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 0.13 : 0.3; pts.push([0.5 + Math.cos(a) * r, 0.52 + Math.sin(a) * r]); }
      filled('#f5c542', pts);
      break;
    }
    case 'heart':
      g.beginPath();
      g.moveTo(0.5, 0.74);
      g.bezierCurveTo(0.2, 0.56, 0.22, 0.3, 0.38, 0.3);
      g.bezierCurveTo(0.45, 0.3, 0.5, 0.36, 0.5, 0.4);
      g.bezierCurveTo(0.5, 0.36, 0.55, 0.3, 0.62, 0.3);
      g.bezierCurveTo(0.78, 0.3, 0.8, 0.56, 0.5, 0.74);
      g.closePath();
      g.fillStyle = '#ff5d7a'; g.fill(); g.lineWidth = 0.035; g.strokeStyle = INK; g.stroke();
      break;
    case 'bolt':
      filled('#ffcf3f', [[0.56, 0.18], [0.3, 0.54], [0.48, 0.54], [0.42, 0.82], [0.72, 0.42], [0.54, 0.42], [0.62, 0.18]]);
      break;
    default:
  }
}

/* ---------- shared materials and sprites ---------- */
const basicCache = new Map();
function basic(color, opts = {}) {
  const key = JSON.stringify([color, opts.side, opts.opacity]);
  let m = basicCache.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), ...opts });
    m.userData.shared = true;
    basicCache.set(key, m);
  }
  return m;
}
let highlightHull = null;
function highlightOutline() {
  if (!highlightHull) {
    highlightHull = new THREE.MeshBasicMaterial({ color: new THREE.Color(ACCENT), side: THREE.BackSide });
    highlightHull.userData.shared = true; highlightHull.userData.outline = true;
  }
  return highlightHull;
}

function radialTexture(stops) {
  const c = makeCanvas(64), g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 1, 32, 32, 31);
  for (const [at, alpha] of stops) grad.addColorStop(at, `rgba(255,255,255,${alpha})`);
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  const tex = canvasTexture(c);
  tex.userData.shared = true;
  return tex;
}
let blobMat = null, ringMat = null, glowTex = null, zTex = null;
const glowMats = {}, gemMats = {};
function blobMaterial() {
  if (!blobMat) {
    blobMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(INK), map: radialTexture([[0, 1], [0.55, 0.55], [1, 0]]), transparent: true, opacity: 0.32,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    blobMat.userData.shared = true;
  }
  return blobMat;
}
function selectionMaterial() {
  if (!ringMat) {
    ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(ACCENT), transparent: true, opacity: 0.9, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    ringMat.userData.shared = true;
  }
  return ringMat;
}
function glowMaterial(status) {
  if (!glowMats[status]) {
    glowTex ||= radialTexture([[0, 0.9], [0.35, 0.35], [1, 0]]);
    glowMats[status] = new THREE.SpriteMaterial({
      map: glowTex, color: new THREE.Color(STATUS_COLORS[status]), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: status === 'active' ? 0.75 : 0.4,
    });
    glowMats[status].userData.shared = true;
  }
  return glowMats[status];
}
function gemMaterial(status) {
  if (!gemMats[status]) {
    const c = new THREE.Color(STATUS_COLORS[status]);
    gemMats[status] = new THREE.MeshToonMaterial({
      color: c, emissive: c, emissiveIntensity: status === 'active' ? 0.6 : status === 'idle' || status === 'error' ? 0.4 : 0.06,
      gradientMap: gradientMap(),
    });
    gemMats[status].userData.shared = true;
  }
  return gemMats[status];
}
function zTexture() {
  if (zTex) return zTex;
  const c = makeCanvas(64), g = c.getContext('2d');
  g.font = '900 52px system-ui, "Segoe UI", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
  g.lineWidth = 9; g.strokeStyle = INK; g.strokeText('z', 32, 34);
  g.fillStyle = '#ffffff'; g.fillText('z', 32, 34);
  zTex = canvasTexture(c);
  zTex.userData.shared = true;
  return zTex;
}
const gemGeometry = q => cachedGeo(`gem|${q}`, () => {
  const pts = [[0, -0.135], [0.046, -0.088], [0.08, -0.022], [0.086, 0.004], [0.078, 0.03], [0.046, 0.062], [0, 0.076]];
  // Non-indexed + recomputed normals = one flat normal per facet (toon materials have no flatShading).
  const g = new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), q === 'low' ? 6 : 8).toNonIndexed();
  g.computeVertexNormals();
  g.translate(0, 0.03, 0);
  return g;
});
const gemRingGeometry = q => cachedGeo(`gem-ring|${q}`, () => new THREE.TorusGeometry(0.14, 0.0075, 5, q === 'low' ? 28 : 48));
const blobGeometry = () => cachedGeo('blob', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
const selectionGeometry = () => cachedGeo('selection', () => new THREE.RingGeometry(0.44, 0.53, 48).rotateX(-Math.PI / 2));
const emblemGeometry = () => cachedGeo('emblem', () => new THREE.PlaneGeometry(0.15, 0.15));

/* ---------- building one body ---------- */
function buildBody(spec, quality, faceSize) {
  const q = quality, low = q === 'low';
  const hs = spec.build.height, ws = spec.build.width;
  const wsD = 1 + (ws - 1) * 0.6, hsT = 1 + (hs - 1) * 0.8, hsA = 1 + (hs - 1) * 0.7;
  const armW = 1 + (ws - 1) * 0.5, legW = Math.sqrt(ws);
  const headS = 1 + (ws - 1) * 0.12 + (hs - 1) * 0.1;
  const thighLen = LEG.thigh * hs, shinLen = LEG.shin * hs;
  const hipY = LEG.ankle + thighLen + shinLen;
  const torsoH = TORSO.h * hsT;
  const neckY = 0.04 + torsoH, headY = neckY + 0.02;
  const shoulderY = 0.04 + torsoH - 0.07, shoulderX = (TORSO.w * ws) / 2 + 0.05;
  const upperLen = ARM.upper * hsA, foreLen = ARM.fore * hsA;
  const thickness = low ? 0.022 : 0.018;

  const pickable = [], owned = { materials: [], textures: [] };
  const M = color => toonMaterial(color);
  const skin = M(spec.skin), top = M(spec.top.color), accent = M(spec.top.accent), bottom = M(spec.bottom.color);
  const hairMat = M(spec.hair.color), shoes = M(spec.shoes.color);

  const add = (parent, geo, material, o = {}) => {
    if (!geo) return null;
    const mesh = new THREE.Mesh(geo, material);
    const sx = o.sx ?? 1, sy = o.sy ?? 1, sz = o.sz ?? 1, off = geo.userData.offset;
    mesh.scale.set(sx, sy, sz);
    mesh.position.set((o.x ?? 0) + (off ? off.x * sx : 0), (o.y ?? 0) + (off ? off.y * sy : 0), (o.z ?? 0) + (off ? off.z * sz : 0));
    mesh.castShadow = !low && o.shadow !== false;
    if (o.outline === false) mesh.userData.noOutline = true;
    if (o.pick !== false) pickable.push(mesh);
    parent.add(mesh);
    return mesh;
  };

  const root = new THREE.Group();
  root.name = 'person-body';
  const rig = new THREE.Group();
  root.add(rig);
  const hips = new THREE.Group();
  hips.position.y = hipY;
  rig.add(hips);

  // Hips and legs
  const bs = spec.bottom.style;
  add(hips, box(PELVIS.w, PELVIS.h, PELVIS.d, PELVIS.r, q), bottom, { sx: ws, sz: wsD });
  if (bs === 'skirt') add(hips, cyl(0.25, 0.34, 0.27, q), bottom, { y: -0.05, sx: ws, sz: wsD });
  const soleColor = luminance(spec.shoes.color) > 0.75 ? shade(spec.shoes.color, -0.25) : '#f3efe8';
  const legs = {};
  for (const side of [1, -1]) {
    const leg = new THREE.Group();
    leg.position.x = side * LEG.x * ws;
    hips.add(leg);
    const bareThigh = bs === 'skirt' || (bs === 'shorts' && !low);
    const bareShin = bs === 'skirt' || bs === 'shorts';
    add(leg, box(0.18, 0.27, 0.19, 0.07, q), bareThigh ? skin : bottom, { y: -thighLen / 2, sx: legW, sy: hs, sz: legW });
    if (bs === 'shorts' && !low) add(leg, box(0.2, 0.2, 0.21, 0.07, q), bottom, { y: -0.075 * hs, sx: legW, sy: hs, sz: legW });
    const knee = new THREE.Group();
    knee.position.y = -thighLen;
    leg.add(knee);
    add(knee, box(0.16, 0.26, 0.17, 0.065, q), bareShin ? skin : bottom, { y: -shinLen / 2, sx: legW, sy: hs, sz: legW });
    if (!low) {
      const cuff = { y: -shinLen + 0.03, sx: legW, sz: legW, pick: false };
      if (bs === 'joggers') add(knee, box(0.175, 0.055, 0.185, 0.025, q), M(shade(spec.bottom.color, -0.12)), cuff);
      if (bs === 'jeans') add(knee, box(0.172, 0.045, 0.182, 0.02, q), M(shade(spec.bottom.color, 0.1)), { ...cuff, y: -shinLen + 0.035 });
      if (bareShin) add(knee, box(0.165, 0.06, 0.175, 0.025, q), M('#f3efe8'), { ...cuff, y: -shinLen + 0.035 });
    }
    const foot = new THREE.Group();
    foot.position.y = -shinLen;
    knee.add(foot);
    add(foot, box(0.19, 0.12, 0.27, 0.05, q), shoes, { y: -0.045, z: 0.045 });
    if (!low) add(foot, box(0.2, 0.035, 0.28, 0.015, q), M(soleColor), { y: -0.093, z: 0.045, pick: false });
    legs[side > 0 ? 'L' : 'R'] = { leg, knee, foot };
  }

  // Torso (chest group carries the build scale and the breathing)
  const ts = spec.top.style;
  const spine = new THREE.Group();
  hips.add(spine);
  const chest = new THREE.Group();
  chest.position.y = 0.04;
  chest.scale.set(ws, hsT, wsD);
  spine.add(chest);
  add(chest, torsoGeometry(ts, q), top);
  if (ts === 'tee' && !low) add(chest, collarGeometry(0.1, 0.022, q), accent, { outline: false, pick: false });
  if (ts === 'tank') {
    if (!low) add(chest, collarGeometry(0.125, 0.02, q), accent, { outline: false, pick: false });
    add(chest, composite('tank-shoulders', q, qq => [1, -1].map(s => pBox(0.13, 0.05, 0.28, 0.025, { x: s * 0.2, y: TORSO.h - 0.012 }, qq))), skin, { pick: false });
  }
  if (ts === 'hoodie') {
    add(chest, composite('hoodie-trim', q, qq => [
      pBox(0.3, 0.12, 0.04, 0.03, { y: 0.12, z: TORSO.d / 2 }, qq),
      pBox(TORSO.w + 0.02, 0.06, TORSO.d + 0.02, 0.03, { y: 0.03 }, qq),
    ]), M(shade(spec.top.color, -0.07)), { pick: false });
    if (!low) add(chest, composite('drawstrings', q, qq => [1, -1].map(s => pCyl(0.008, 0.008, 0.11, { x: s * 0.05, y: TORSO.h - 0.09, z: TORSO.d / 2 + 0.008 }, qq))), accent, { outline: false, pick: false });
  }
  if (ts === 'jacket') {
    add(chest, box(0.15, TORSO.h - 0.06, 0.03, 0.012, q), accent, { y: TORSO.h / 2 + 0.01, z: TORSO.d / 2 - 0.004, pick: false });
    add(chest, composite('jacket-trim', q, qq => [
      ...(qq === 'low' ? [] : [1, -1].map(s => pBox(0.075, 0.17, 0.03, 0.012, { rz: -s * 0.35, x: s * 0.105, y: TORSO.h - 0.1, z: TORSO.d / 2 + 0.004 }, qq))),
      pBox(TORSO.w + 0.02, 0.06, TORSO.d + 0.02, 0.03, { y: 0.03 }, qq),
    ]), M(shade(spec.top.color, -0.1)), { pick: false });
  }
  if (ts === 'sweater') {
    add(chest, box(TORSO.w + 0.025, 0.075, TORSO.d + 0.025, 0.035, q), accent, { y: 0.035, pick: false });
    if (!low) add(chest, collarGeometry(0.105, 0.03, q), accent, { outline: false, pick: false });
  }
  if (spec.top.emblem !== 'none') {
    const ex = ts === 'jacket' ? 0.14 : 0;
    const ey = ts === 'jacket' ? 0.15 : ts === 'hoodie' ? TORSO.h * 0.66 : TORSO.h * 0.6;
    add(chest, emblemGeometry(), emblemMaterial(spec.top.emblem, spec.top.accent), { x: ex, y: ey, z: TORSO.d / 2 + 0.004, outline: false, pick: false, shadow: false });
  }
  if (!low) add(spine, cyl(0.085, 0.095, 0.1, q), skin, { y: neckY, outline: false, pick: false });

  // Head, face, hair, accessories
  const head = new THREE.Group();
  head.position.y = headY;
  head.scale.setScalar(headS);
  spine.add(head);
  const faceCanvas = makeCanvas(faceSize);
  paintFace(faceCanvas, spec, false);
  const faceOpen = canvasTexture(faceCanvas);
  const faceMat = toonMaterial('#ffffff', { map: faceOpen });
  owned.textures.push(faceOpen);
  owned.materials.push(faceMat);
  add(head, headGeometry(q), [skin, skin, skin, skin, faceMat, skin], { y: HEAD.h / 2 });

  const acc = spec.accessory;
  const hatted = acc === 'cap' || acc === 'beanie';
  add(head, hairGeometry(hatted ? hatHair(spec.hair.style) : spec.hair.style, q), hairMat);
  let tail = null;
  if (spec.hair.style === 'ponytail') {
    tail = new THREE.Group();
    tail.position.set(0, 0.5, -0.35);
    head.add(tail);
    add(tail, tailGeometry(q), hairMat);
  }
  const fhMat = M(spec.facialHair.color);
  if (spec.facialHair.style === 'beard') add(head, box(0.56, 0.2, 0.16, 0.07, q), fhMat, { y: 0.03, z: 0.245 });
  if (spec.facialHair.style === 'goatee') add(head, box(0.13, 0.11, 0.08, 0.035, q), fhMat, { y: 0.055, z: 0.29, pick: false });

  const accMat = M(spec.accessoryColor);
  const hairTop = hatted ? 0.6 : HAIR_TOP[spec.hair.style] ?? 0.72;
  let accTop = hairTop;
  if (acc === 'glasses' || acc === 'sunglasses') {
    add(head, glassesGeometry(q, acc === 'sunglasses' ? 0.014 : 0.012), accMat, { outline: false, pick: false });
    if (acc === 'sunglasses') {
      add(head, lensGeometry(q), M('#16141d'), { pick: false });
      if (!low) add(head, glintGeometry(q), basic('#ffffff'), { outline: false, pick: false, shadow: false });
    }
  } else if (acc === 'cap') {
    add(head, capGeometry(q), accMat);
    accTop = 0.79;
  } else if (acc === 'beanie') {
    add(head, beanieGeometry(q), accMat);
    add(head, beanieCuffGeometry(q), M(shade(spec.accessoryColor, -0.12)));
    accTop = 0.875;
  } else if (acc === 'headphones') {
    const R = Math.round(Math.max(0.4, hairTop - 0.36 + 0.035) * 100) / 100;
    add(head, headphonesGeometry(q, R), accMat);
    accTop = Math.max(hairTop, 0.36 + R + 0.032);
  } else if (acc === 'crown') {
    const base = CROWN_BASE[spec.hair.style] ?? 0.7;
    const crown = new THREE.Group();
    crown.position.y = base;
    crown.rotation.set(-0.06, 0, 0.12);
    head.add(crown);
    add(crown, crownGeometry(q), M('#f5c542'));
    add(crown, ball(0.034, q), accMat, { y: 0.05, z: 0.198, pick: false, outline: false });
    accTop = Math.max(hairTop, base + 0.23);
  }

  // Arms
  const arms = {};
  const longSleeves = ts === 'hoodie' || ts === 'jacket' || ts === 'sweater';
  const splitSleeve = ts === 'tee' && !low;
  for (const side of [1, -1]) {
    const arm = new THREE.Group();
    arm.position.set(side * shoulderX, shoulderY, 0);
    spine.add(arm);
    const armScale = { sx: armW, sy: hsA, sz: armW };
    add(arm, box(0.15, 0.21, 0.15, 0.06, q), ts === 'tank' || splitSleeve ? skin : top, { ...armScale, y: -0.075 * hsA });
    if (splitSleeve) add(arm, box(0.172, 0.15, 0.172, 0.065, q), top, { ...armScale, y: -0.04 * hsA });
    const elbow = new THREE.Group();
    elbow.position.y = -upperLen;
    arm.add(elbow);
    add(elbow, box(0.135, 0.18, 0.135, 0.055, q), longSleeves ? top : skin, { ...armScale, y: -0.07 * hsA });
    if (longSleeves && !low) add(elbow, box(0.152, 0.045, 0.152, 0.02, q), ts === 'sweater' ? accent : M(shade(spec.top.color, -0.1)), { sx: armW, sz: armW, y: -foreLen + 0.012, pick: false });
    add(elbow, box(0.13, 0.125, 0.12, 0.05, q), skin, { y: -foreLen - 0.045 });
    arms[side > 0 ? 'L' : 'R'] = { arm, elbow };
  }

  addOutline(root, { thickness });
  const hulls = [];
  root.traverse(node => { if (node.isMesh && node.userData.outline) hulls.push(node); });

  let faceClosed = null;
  const closedFace = () => {
    if (spec.eyes.style === 'happy') return faceOpen;
    if (!faceClosed) {
      const c = makeCanvas(faceSize);
      paintFace(c, spec, true);
      faceClosed = canvasTexture(c);
      owned.textures.push(faceClosed);
    }
    return faceClosed;
  };

  return {
    root, pickable, owned, hulls, tail, faceMat, faceOpen, closedFace, thickness,
    canBlink: spec.eyes.style !== 'happy',
    hipY, thighLen, shinLen,
    sitDrop: SEAT_HEIGHT + PELVIS.h / 2 - hipY,
    topY: hipY + headY + accTop * headS,
    headCenterY: hipY + headY + (HEAD.h / 2) * headS,
    neckWorldY: hipY + headY,
    j: {
      rig, spine, chest, head, chestScaleY: hsT, headY, shoulderY, torsoH,
      armL: arms.L.arm, armR: arms.R.arm, elbowL: arms.L.elbow, elbowR: arms.R.elbow,
      legL: legs.L.leg, legR: legs.R.leg, kneeL: legs.L.knee, kneeR: legs.R.knee, footL: legs.L.foot, footR: legs.R.foot,
    },
  };
}

function releaseBody(body) {
  body.owned.materials.forEach(m => m.dispose());
  body.owned.textures.forEach(t => t.dispose());
  body.owned.materials.length = 0;
  body.owned.textures.length = 0;
}

/* ---------- status gem ---------- */
function buildGem(provider, quality, owned) {
  const group = new THREE.Group();
  group.name = 'status-gem';
  const spin = new THREE.Group();
  group.add(spin);
  const core = new THREE.Mesh(gemGeometry(quality), gemMaterial('idle'));
  spin.add(core);
  addOutline(spin, { thickness: 0.012 });
  const tilt = new THREE.Group();
  tilt.rotation.set(1.2, 0, 0.3);
  group.add(tilt);
  const ringMaterial = basic(RING_COLORS[provider] || ACCENT);
  const ring = new THREE.Mesh(gemRingGeometry(quality), ringMaterial);
  tilt.add(ring);
  const bead = new THREE.Mesh(ball(0.02, 'low'), ringMaterial);
  bead.position.x = 0.14;
  ring.add(bead);
  const glow = new THREE.Sprite(glowMaterial('active'));
  glow.scale.setScalar(0.6);
  group.add(glow);
  const zs = [];
  for (let i = 0; i < 3; i++) {
    const material = new THREE.SpriteMaterial({ map: zTexture(), color: new THREE.Color('#cfd3e6'), transparent: true, depthWrite: false, opacity: 0 });
    owned.push(material);
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    group.add(sprite);
    zs.push(sprite);
  }
  group.traverse(node => { node.raycast = noRaycast; });
  return { group, spin, core, tilt, ring, glow, zs };
}

/* ---------- procedural poses ---------- */
const ROOT_Y = 0, ROOT_Z = 1, SPINE_X = 2, SPINE_Y = 3, SPINE_Z = 4, HEAD_X = 5, HEAD_Y = 6, HEAD_Z = 7,
  ARM_LX = 8, ARM_LZ = 9, ELB_LX = 10, ELB_LZ = 11, ARM_RX = 12, ARM_RZ = 13, ELB_RX = 14, ELB_RZ = 15,
  LEG_LX = 16, LEG_LZ = 17, KNEE_L = 18, LEG_RX = 19, LEG_RZ = 20, KNEE_R = 21, BREATHE = 22, N = 23;
// Conventions: "L" is the character's left (+X). Negative X rotation swings a
// limb forward (+Z); positive HEAD_X / SPINE_X tips forward.

const POSES = {
  stand(p, t, a, s) {
    const k = s.seed * 10;
    p[BREATHE] = 0.016 * Math.sin(t * 2.1) * a;
    p[SPINE_Z] = 0.018 * Math.sin(t * 0.7 + k) * a;
    p[HEAD_X] = -0.02 + 0.025 * Math.sin(t * 0.9 + k) * a;
    p[HEAD_Y] = 0.24 * Math.sin(t * 0.33 + k) * Math.max(0, Math.sin(t * 0.17 + k * 2)) * a;
    p[HEAD_Z] = 0.03 * Math.sin(t * 0.5 + k) * a;
    p[ARM_LX] = 0.03; p[ARM_RX] = 0.03;
    p[ARM_LZ] = 0.1 + 0.02 * Math.sin(t * 2.1) * a; p[ARM_RZ] = -p[ARM_LZ];
    p[ELB_LX] = -0.12; p[ELB_RX] = -0.12;
    p[LEG_LZ] = 0.02; p[LEG_RZ] = -0.02;
  },
  walk(p, t, a, s) {
    const b = s.body, ph = t * Math.PI * 2 * s.walkCadence, sn = Math.sin(ph), cs = Math.cos(ph);
    p[LEG_LX] = -0.45 * sn; p[LEG_RX] = 0.45 * sn;
    p[KNEE_L] = 0.1 + 0.8 * Math.max(0, cs); p[KNEE_R] = 0.1 + 0.8 * Math.max(0, -cs);
    p[ARM_LX] = 0.5 * sn; p[ARM_RX] = -0.5 * sn;
    p[ELB_LX] = -0.3 - 0.3 * Math.max(0, -sn); p[ELB_RX] = -0.3 - 0.3 * Math.max(0, sn);
    p[ARM_LZ] = 0.12; p[ARM_RZ] = -0.12;
    // Plant the longer (stance) leg on the ground, plus a little springy bounce.
    const reach = (hip, knee) => b.thighLen * Math.cos(hip) + b.shinLen * Math.cos(hip + knee);
    p[ROOT_Y] = Math.max(reach(p[LEG_LX], p[KNEE_L]), reach(p[LEG_RX], p[KNEE_R])) - (b.thighLen + b.shinLen) + 0.012 * Math.abs(cs) * a;
    p[ROOT_Z] = 0.025 * sn * a;
    p[SPINE_X] = 0.06; p[SPINE_Y] = 0.1 * sn * a;
    p[HEAD_X] = -0.02; p[HEAD_Y] = -0.08 * sn * a;
    p[BREATHE] = 0.01 * Math.sin(t * 2.3) * a;
  },
  work(p, t, a, s) {
    const k = s.seed * 6;
    const tap = Math.sin(t * 15 + k);
    const burst = Math.max(0, Math.sin(t * 1.3 + k)) ** 8; // an emphatic "enter" now and then
    p[SPINE_X] = 0.12;
    p[HEAD_X] = 0.2 + (0.06 * Math.max(0, Math.sin(t * 2.6)) + 0.08 * burst) * a;
    p[HEAD_Y] = 0.05 * Math.sin(t * 0.4 + k) * a;
    p[ARM_LX] = -0.7; p[ARM_RX] = -0.7 - 0.55 * burst * a;
    p[ARM_LZ] = -0.08; p[ARM_RZ] = 0.08;
    p[ELB_LX] = -0.85 + 0.16 * tap * a;
    p[ELB_RX] = -0.85 - 0.16 * tap * a - 0.6 * burst * a;
    p[BREATHE] = 0.012 * Math.sin(t * 2.4) * a;
  },
  sit(p, t, a, s) {
    const k = s.seed * 5, swing = 0.16 * Math.sin(t * 1.9 + k) * a;
    p[ROOT_Y] = s.body.sitDrop;
    p[LEG_LX] = -Math.PI / 2 + 0.05; p[LEG_RX] = -Math.PI / 2 + 0.05;
    p[LEG_LZ] = 0.06; p[LEG_RZ] = -0.06;
    p[KNEE_L] = 1.45 + swing; p[KNEE_R] = 1.45 - swing; // little dangling feet
    p[SPINE_X] = -0.04;
    p[BREATHE] = 0.016 * Math.sin(t * 1.8) * a;
    p[ARM_LX] = -0.5; p[ARM_RX] = -0.5; p[ELB_LX] = -0.55; p[ELB_RX] = -0.55;
    p[ARM_LZ] = 0.14; p[ARM_RZ] = -0.14;
    p[HEAD_X] = 0.03; p[HEAD_Y] = 0.25 * Math.sin(t * 0.27 + k) * a;
  },
  wave(p, t, a) {
    const w = Math.sin(t * 10) * Math.max(a, 0.4);
    p[ARM_RZ] = -2.5 + 0.06 * w; p[ARM_RX] = -0.2;
    p[ELB_RZ] = 0.45 * w; p[ELB_RX] = -0.25;
    p[ARM_LX] = 0.03; p[ARM_LZ] = 0.12; p[ELB_LX] = -0.15;
    p[SPINE_Z] = -0.04; p[HEAD_Z] = 0.1; p[HEAD_X] = -0.06;
    p[BREATHE] = 0.014 * Math.sin(t * 2.2) * a;
    p[ROOT_Y] = 0.008 * Math.abs(Math.sin(t * 5)) * a;
  },
  talk(p, t, a, s) {
    const k = s.seed * 7;
    p[HEAD_X] = -0.02 + 0.05 * Math.sin(t * 5.2 + k) * a;
    p[HEAD_Y] = 0.12 * Math.sin(t * 0.8 + k) * a;
    p[HEAD_Z] = 0.06 * Math.sin(t * 1.9 + k) * a;
    p[ARM_RX] = -0.55 + 0.22 * Math.sin(t * 2.6 + k) * a; p[ARM_RZ] = -0.22 - 0.1 * Math.sin(t * 1.7 + k) * a;
    p[ELB_RX] = -1.0 + 0.35 * Math.sin(t * 3.4 + k) * a;
    p[ARM_LX] = -0.3 + 0.15 * Math.sin(t * 2.1 + k + 1) * a; p[ARM_LZ] = 0.16;
    p[ELB_LX] = -0.7 + 0.25 * Math.sin(t * 2.9 + k + 2) * a;
    p[SPINE_X] = 0.02; p[SPINE_Y] = 0.05 * Math.sin(t * 0.9 + k) * a;
    p[BREATHE] = 0.02 * Math.sin(t * 2.6) * a;
    p[ROOT_Y] = 0.008 * Math.abs(Math.sin(t * 5.2 + k)) * a;
  },
};

/* ---------- the Person ---------- */
const _target = new THREE.Vector3();

class Person {
  constructor(spec, { role = 'agent', provider = 'other', quality = 'high', faceSize = 256 } = {}) {
    this.role = role === 'owner' ? 'owner' : 'agent';
    this.provider = RING_COLORS[provider] ? provider : 'other';
    this.quality = quality === 'low' ? 'low' : 'high';
    this.faceSize = Math.max(128, Math.min(1024, Math.round(Number(faceSize)) || 256));
    this.object = new THREE.Group();
    this.object.name = 'person';
    this.object.userData.person = this;
    this.pickable = [];
    this.spec = null;
    this.body = null;
    this.status = undefined;
    this.action = 'stand';
    this.highlighted = false;
    this.walkCadence = 1;
    this.weights = Object.fromEntries(ACTIONS.map(a => [a, a === 'stand' ? 1 : 0]));
    this.seed = Math.random();
    this.t = this.seed * 60;
    this._pose = new Float32Array(N);
    this._tmp = new Float32Array(N);
    this._yawTarget = null;
    this._blinkIn = 1 + this.seed * 4;
    this._blinkLeft = 0;
    this._sleep = 0;
    this._pop = 1;
    this._owned = [];
    this._specKey = '';

    this.shadow = new THREE.Mesh(blobGeometry(), blobMaterial());
    this.shadow.position.y = 0.004;
    this.shadow.raycast = noRaycast;
    this.selection = new THREE.Mesh(selectionGeometry(), selectionMaterial());
    this.selection.position.y = 0.008;
    this.selection.visible = false;
    this.selection.raycast = noRaycast;
    this.gem = buildGem(this.provider, this.quality, this._owned);
    this.object.add(this.shadow, this.selection, this.gem.group);

    this.setSpec(spec);
    this.setStatus(this.role === 'agent' ? 'idle' : null);
    this.update(0);
  }

  /** World-space height of the top of the head/hair/hat when standing (labels go above this). */
  get topY() { return this.body ? this.body.topY : PERSON_HEIGHT; }
  get headCenterY() { return this.body ? this.body.headCenterY : 1.35; }

  setSpec(input) {
    if (this._disposed) return;
    const spec = normalizeAvatar(input);
    const key = JSON.stringify(spec);
    if (this.body && key === this._specKey) return;
    this._specKey = key;
    this.spec = spec;
    const old = this.body;
    this.body = buildBody(spec, this.quality, this.faceSize);
    if (old) { this.object.remove(old.root); releaseBody(old); }
    this.object.add(this.body.root);
    this.pickable.length = 0; // mutated in place so callers' references stay valid
    for (const mesh of this.body.pickable) { mesh.userData.person = this; this.pickable.push(mesh); }
    const footprint = 0.85 * spec.build.width;
    this.shadow.scale.set(footprint, 1, footprint);
    if (this.highlighted) this._outline(true);
    this._syncFace();
    if (old) this._applyPose(this._pose);
  }

  setStatus(status) {
    const s = STATUS_COLORS[status] ? status : null;
    if (s === this.status) return;
    this.status = s;
    const g = this.gem;
    g.group.visible = !!s && !this.inConversation;
    if (s) {
      g.core.material = gemMaterial(s);
      g.glow.material = glowMaterial(s);
      g.glow.visible = s !== 'offline';
      for (const z of g.zs) z.visible = s === 'offline';
      this._pop = reducedMotion ? 1 : 0;
      if (reducedMotion) g.group.scale.setScalar(1);
    }
    this._syncFace();
  }

  setAction(action) { this.action = ACTIONS.includes(action) ? action : 'stand'; }

  setConversation(on) {
    this.inConversation = Boolean(on);
    this.gem.group.visible = Boolean(this.status) && !this.inConversation;
    this.selection.visible = this.highlighted && !this.inConversation;
  }

  setHighlight(on) {
    on = !!on;
    if (on === this.highlighted) return;
    this.highlighted = on;
    this.selection.visible = on && !this.inConversation;
    this._outline(on);
  }

  lookAt(x, z) {
    const o = this.object;
    _target.set(Number(x) || 0, 0, Number(z) || 0);
    if (o.parent) { o.parent.updateWorldMatrix(true, false); o.parent.worldToLocal(_target); }
    const dx = _target.x - o.position.x, dz = _target.z - o.position.z;
    if (dx * dx + dz * dz < 1e-6) return;
    this._yawTarget = Math.atan2(dx, dz);
  }

  /** Advance animation. dt in seconds; each person keeps its own clock so crowds never move in lockstep. */
  update(dt = 1 / 60) {
    const b = this.body;
    if (!b) return;
    dt = Math.min(0.1, Math.max(0, Number(dt) || 0));
    this.t += dt;
    const t = this.t, amp = reducedMotion ? 0.25 : 1;

    // Cross-fade action weights, then blend the poses.
    const step = dt / BLEND;
    let sum = 0;
    for (const a of ACTIONS) {
      const target = a === this.action ? 1 : 0, w = this.weights[a];
      this.weights[a] = target > w ? Math.min(target, w + step) : Math.max(target, w - step);
      sum += smooth(this.weights[a]);
    }
    const p = this._pose.fill(0), tmp = this._tmp;
    for (const a of ACTIONS) {
      const w = smooth(this.weights[a]) / (sum || 1);
      if (w < 1e-3) continue;
      tmp.fill(0);
      POSES[a](tmp, t, amp, this);
      for (let i = 0; i < N; i++) p[i] += tmp[i] * w;
    }
    // "Powered down": a sleepy droop of the head.
    const sleepy = this.status === 'offline' && this.action !== 'walk' ? 1 : 0;
    this._sleep += (sleepy - this._sleep) * Math.min(1, dt * 2.5);
    if (this._sleep > 1e-3) { p[HEAD_X] += 0.22 * this._sleep; p[HEAD_Z] += 0.08 * this._sleep; p[SPINE_X] += 0.04 * this._sleep; }
    this._applyPose(p);

    if (b.tail) {
      const walk = smooth(this.weights.walk), ph = t * Math.PI * 2 * this.walkCadence;
      b.tail.rotation.x = 0.3 - p[HEAD_X] * 0.5 + (0.12 * Math.sin(ph * 2) * walk + 0.035 * Math.sin(t * 1.6 + this.seed * 9)) * amp;
      b.tail.rotation.z = (0.2 * Math.sin(ph) * walk + 0.03 * Math.sin(t * 1.1)) * amp;
    }

    if (this._yawTarget !== null) {
      const r = this.object.rotation, diff = wrapAngle(this._yawTarget - r.y);
      if (Math.abs(diff) < 0.003) { r.y = this._yawTarget; this._yawTarget = null; } else r.y += diff * (1 - Math.exp(-dt * 9));
    }

    if (this.quality === 'high' && b.canBlink && this.status !== 'offline') {
      if (this._blinkLeft > 0) {
        this._blinkLeft -= dt;
        if (this._blinkLeft <= 0) { this._blinkLeft = 0; this._syncFace(); }
      } else if ((this._blinkIn -= dt) <= 0) {
        this._blinkLeft = 0.12;
        this._blinkIn = Math.random() < 0.2 ? 0.28 : 2.4 + Math.random() * 3.6;
        this._syncFace();
      }
    }

    this._updateGem(dt, t, amp, p[ROOT_Y]);
    if (this.highlighted) {
      const k = (1 + 0.05 * Math.sin(t * 4) * amp) * this.spec.build.width;
      this.selection.scale.set(k, 1, k);
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.object.parent?.remove(this.object);
    if (this.body) { this.object.remove(this.body.root); releaseBody(this.body); }
    this._owned.forEach(m => m.dispose());
    this._owned.length = 0;
    this.pickable.length = 0;
    this.body = null;
  }

  _applyPose(p) {
    const j = this.body.j;
    j.rig.position.y = p[ROOT_Y];
    j.rig.rotation.z = p[ROOT_Z];
    j.spine.rotation.set(p[SPINE_X], p[SPINE_Y], p[SPINE_Z]);
    j.chest.scale.y = j.chestScaleY * (1 + p[BREATHE]);
    const lift = p[BREATHE] * j.torsoH;
    j.head.position.y = j.headY + lift;
    j.head.rotation.set(p[HEAD_X], p[HEAD_Y], p[HEAD_Z]);
    j.armL.position.y = j.shoulderY + lift * 0.8;
    j.armR.position.y = j.armL.position.y;
    j.armL.rotation.set(p[ARM_LX], 0, p[ARM_LZ]);
    j.armR.rotation.set(p[ARM_RX], 0, p[ARM_RZ]);
    j.elbowL.rotation.set(p[ELB_LX], 0, p[ELB_LZ]);
    j.elbowR.rotation.set(p[ELB_RX], 0, p[ELB_RZ]);
    j.legL.rotation.set(p[LEG_LX], 0, p[LEG_LZ]);
    j.legR.rotation.set(p[LEG_RX], 0, p[LEG_RZ]);
    j.kneeL.rotation.x = p[KNEE_L];
    j.kneeR.rotation.x = p[KNEE_R];
    j.footL.rotation.x = -(p[LEG_LX] + p[KNEE_L]) * 0.85;
    j.footR.rotation.x = -(p[LEG_RX] + p[KNEE_R]) * 0.85;
  }

  _updateGem(dt, t, amp, rootY) {
    const s = this.status, g = this.gem;
    if (!s) return;
    const m = GEM_MOTION[s], calm = reducedMotion ? 0.3 : 1;
    g.spin.rotation.y += m.spin * dt * calm;
    g.ring.rotation.z += m.ring * dt * calm;
    g.tilt.rotation.y += 0.35 * dt * calm;
    g.group.position.y = this.body.topY + 0.3 + rootY - m.drop + Math.sin(t * m.bobRate) * m.bob * amp;
    if (this._pop < 1) {
      this._pop = Math.min(1, this._pop + dt / 0.45);
      g.group.scale.setScalar(Math.max(0.01, easeOutBack(this._pop)));
    }
    if (g.glow.visible) g.glow.scale.setScalar(m.glow * (1 + 0.12 * Math.sin(t * 3.6) * amp));
    if (s === 'offline') {
      g.zs.forEach((z, i) => {
        const u = reducedMotion ? (i + 0.5) / 3 : (t * 0.36 + i / 3) % 1;
        z.position.set(0.12 + Math.sin(u * 5 + i) * 0.035, -0.08 + u * 0.46, 0.04);
        z.material.opacity = reducedMotion ? 0.75 : Math.sin(u * Math.PI) * 0.95;
        z.scale.setScalar(0.07 + u * 0.08);
      });
    }
  }

  _syncFace() {
    const b = this.body;
    if (!b) return;
    const closed = this.status === 'offline' || this._blinkLeft > 0;
    const map = closed ? b.closedFace() : b.faceOpen;
    if (b.faceMat.map !== map) b.faceMat.map = map;
  }

  _outline(on) {
    const b = this.body;
    if (!b) return;
    const k = (b.thickness + 0.012) / b.thickness; // a little thicker while highlighted
    for (const hull of b.hulls) {
      const d = hull.userData;
      if (!d.base) d.base = { material: hull.material, scale: hull.scale.clone() };
      if (on) {
        hull.material = highlightOutline();
        hull.scale.set(1 + (d.base.scale.x - 1) * k, 1 + (d.base.scale.y - 1) * k, 1 + (d.base.scale.z - 1) * k);
      } else {
        hull.material = d.base.material;
        hull.scale.copy(d.base.scale);
      }
    }
  }

  /** Freeze into a neutral, front-facing pose (used by headshot). */
  _portraitPose() {
    this.seed = 0;
    this.t = 0;
    this._blinkLeft = 0;
    this.action = 'stand';
    for (const a of ACTIONS) this.weights[a] = a === 'stand' ? 1 : 0;
    this.update(0);
  }
}

/**
 * createPerson(spec, { role: 'agent'|'owner', provider: 'claude'|'codex'|'other', quality: 'high'|'low', faceSize })
 * Agents start with an "Awake" (idle) gem; owners start with none.
 */
export function createPerson(spec, options = {}) {
  return new Person(spec, options);
}

export function defaultOwnerSpec() {
  return normalizeAvatar(defaultAvatar());
}

/* ---------- headshot: quick head-and-shoulders PNG ---------- */
let shot = null;
function shotStage() {
  if (!shot) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#fff6ee', '#6d6a8f', 1.5));
    const key = new THREE.DirectionalLight('#ffffff', 2.4);
    key.position.set(1.2, 2.6, 3);
    scene.add(key);
    shot = { renderer, scene, camera: new THREE.PerspectiveCamera(26, 1, 0.1, 30), timer: 0 };
  }
  clearTimeout(shot.timer);
  return shot;
}
function releaseStageSoon() {
  const stage = shot;
  if (!stage) return;
  stage.timer = setTimeout(() => {
    if (shot !== stage) return;
    shot = null;
    stage.renderer.dispose();
    stage.renderer.forceContextLoss();
  }, 4000);
}

/**
 * Renders a transparent head-and-shoulders portrait of `spec` and resolves a PNG data URL.
 * Uses a temporary WebGL renderer that is disposed a few seconds after the last call
 * (so a batch of headshots shares one context). Rejects if WebGL is unavailable.
 */
export async function headshot(spec, size = 128) {
  const px = Math.max(16, Math.min(1024, Math.round(Number(size)) || 128));
  const stage = shotStage();
  const person = createPerson(spec, { role: 'owner', quality: 'high', faceSize: px > 192 ? 512 : 256 });
  try {
    person.shadow.visible = false;
    person._portraitPose();
    person.object.rotation.y = -0.3;
    stage.scene.add(person.object);
    const top = person.topY + 0.06, bottom = person.body.neckWorldY - 0.24;
    const height = top - bottom, center = (top + bottom) / 2;
    const fov = THREE.MathUtils.degToRad(stage.camera.fov);
    const distance = (height / 2 / Math.tan(fov / 2)) * 1.08;
    stage.camera.position.set(0, center + 0.12, distance);
    stage.camera.lookAt(0, center, 0);
    stage.camera.updateProjectionMatrix();
    stage.renderer.setSize(px * 2, px * 2, false);
    stage.renderer.render(stage.scene, stage.camera);
    const out = makeCanvas(px);
    const g = out.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(stage.renderer.domElement, 0, 0, px, px);
    return out.toDataURL('image/png');
  } finally {
    person.dispose();
    releaseStageSoon();
  }
}
