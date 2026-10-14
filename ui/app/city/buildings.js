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
function styleFor(project) {
  const lang = project.primaryLanguage || 'Other';
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
}
const windowGeos = new Map();
function windowGeometry(w, h) {
  const key = `${w}x${h}`;
  if (!windowGeos.has(key)) { const g = new THREE.BoxGeometry(w, h, 0.1); g.userData.shared = true; windowGeos.set(key, g); }
  return windowGeos.get(key);
}

/** Collects static parts by colour and merges each colour into one outlined mesh. */
class Batch {
  constructor() { this.parts = new Map(); }
  add(color, geometry) { if (!this.parts.has(color)) this.parts.set(color, []); this.parts.get(color).push(geometry); return this; }
  build(group, { cast = true, outline = 0.04, tag } = {}) {
    const meshes = [];
    for (const [color, list] of this.parts) {
      const m = new THREE.Mesh(mergeParts(list), toonMaterial(color));
      m.castShadow = cast; m.receiveShadow = true;
      if (outline) addOutline(m, { thickness: outline });
      Object.assign(m.userData, tag || {});
      group.add(m); meshes.push(m);
    }
    this.parts.clear();
    return meshes;
  }
}

const easeOutBack = t => { const c = 1.6; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const easeIn = t => t * t * t;

/* ---------- one building ---------- */
export class Building {
  constructor(project, cell, env) {
    this.id = project.id;
    this.cell = cell;
    this.env = env;
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
    this.apply(project, { animate: env.animateIn });
  }

  /** Re-apply a project; returns true if the lot footprint changed. */
  apply(project, { animate = false } = {}) {
    this.project = project;
    const size = buildingSize(project);
    const style = styleFor(project);
    const m = project.metrics || {};
    const litFrac = Math.max(0.08, Math.min(0.92, 0.12 + (m.glow || 0) * 0.55 + Math.min(m.commits7d || 0, 30) / 60));
    const sig = JSON.stringify([size.floors, size.footprint, style.key, style.body, project.name, Math.round(litFrac * 20), (m.commits7d || 0) > 0, project.source, !!project.private]);
    if (sig === this.sig) return false;
    const previous = this.size;
    const footprintChanged = !previous || previous.footprint !== size.footprint;
    this.sig = sig; this.size = size; this.style = style; this.litFrac = litFrac;
    this.clearTower();
    this.buildTower();
    if (footprintChanged) this.buildPad();
    if (this.active) this.buildScaffold();
    const reduced = this.env.reducedMotion();
    if (!previous && animate && !reduced) {
      this.anim = { kind: 'rise', t: 0, delay: this.env.stagger?.() || 0 };
      this.tower.scale.y = 0.02; this.padGroup.scale.setScalar(0.6);
    } else if (previous && previous.floors !== size.floors && !reduced) {
      this.anim = { kind: 'grow', t: 0, from: previous.H / size.H, up: size.floors > previous.floors };
      this.tower.scale.y = previous.H / size.H;
      if (this.anim.up) this.env.particles.emit('sparkle', this.topPoint(), 26, { spread: size.W * 0.8 });
    }
    return footprintChanged;
  }

  clearTower() {
    for (const child of [...this.tower.children]) { this.tower.remove(child); disposeObject(child); }
    this.pickables = []; this.gear = null; this.flag = null; this.beaconLight = null; this.jib = null; this.chimneyTop = null; this.scaffold = null;
  }

  buildTower() {
    const { W, D, H, floors } = this.size, s = this.style;
    const tag = { buildingId: this.id };
    const top = PAD_TOP + H;
    this.bodyMaterial = toonMaterial(s.body, { cache: false });
    const body = new THREE.Mesh(placed(rbox(W, H, D, 0.22), { y: PAD_TOP + H / 2 }), this.bodyMaterial);
    body.castShadow = true; body.receiveShadow = true; body.userData = { ...tag };
    addOutline(body, { thickness: 0.06 });
    this.tower.add(body);
    this.body = body;

    const batch = new Batch();
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
    if (s.key === 'foundry') {
      const cx = W / 2 - 0.85, cz = -D / 2 + 0.85;
      batch.add(s.plinth, placed(new THREE.CylinderGeometry(0.42, 0.5, 2.9, 12), { x: cx, y: top + 1.45, z: cz }));
      batch.add('#5a3428', placed(new THREE.CylinderGeometry(0.52, 0.52, 0.22, 12), { x: cx, y: top + 2.8, z: cz }));
      this.chimneyTop = new THREE.Vector3(cx, top + 3.05, cz);
      roofTop = top + 3;
      // Gear sign on the facade.
      const gearParts = [placed(new THREE.CylinderGeometry(0.6, 0.6, 0.16, 18), { rx: Math.PI / 2 })];
      for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; gearParts.push(placed(new THREE.BoxGeometry(0.26, 0.3, 0.16), { x: Math.sin(a) * 0.68, y: Math.cos(a) * 0.68, rz: -a })); }
      const gear = new THREE.Mesh(mergeParts(gearParts), toonMaterial('#e3a06b'));
      const hub = new THREE.Mesh(placed(new THREE.CylinderGeometry(0.2, 0.2, 0.2, 10), { rx: Math.PI / 2 }), toonMaterial('#7a4436'));
      gear.add(hub); addOutline(gear, { thickness: 0.03 });
      gear.position.set(-W / 2 + 0.95, floors >= 2 ? top - 0.85 : PAD_TOP + 1.45, D / 2 + 0.16);
      gear.userData = { ...tag }; this.gear = gear; this.tower.add(gear); this.pickables.push(gear);
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
        const pane = new THREE.Mesh(placed(new THREE.BoxGeometry(pw, 1.05, 0.1), { x: sx * (0.75 + pw / 2 + 0.05), y: PAD_TOP + 0.95, z: D / 2 + 0.02 }), MATERIALS.shop);
        this.tower.add(pane);
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
    // Generic roof props.
    const m = this.project.metrics || {};
    if ((m.commits7d || 0) > 0 && s.key !== 'glass') {
      const ax = -W / 2 + 0.6, az = D / 2 - 0.6;
      batch.add('#8d96b0', placed(new THREE.CylinderGeometry(0.05, 0.07, 1.7, 6), { x: ax, y: top + 0.85, z: az }));
      this.addBeacon(new THREE.Vector3(ax, top + 1.8, az), true);
      roofTop = Math.max(roofTop, top + 1.9);
    }
    if (this.project.source === 'github' || this.project.source === 'both') {
      const fx = -W / 2 + 0.55, fz = -D / 2 + 0.55;
      batch.add('#d8dbe6', placed(new THREE.CylinderGeometry(0.04, 0.05, 2.2, 6), { x: fx, y: top + 1.1, z: fz }));
      const flag = new THREE.Group();
      flag.position.set(fx, top + 1.85, fz);
      const cloth = new THREE.Mesh(placed(new THREE.PlaneGeometry(0.95, 0.68), { x: 0.5 }), new THREE.MeshBasicMaterial({ map: githubFlagTexture(), side: THREE.DoubleSide }));
      flag.add(cloth); this.flag = flag; this.tower.add(flag);
      roofTop = Math.max(roofTop, top + 2.3);
    }
    if (this.project.private) {
      const sign = new THREE.Mesh(new THREE.CircleGeometry(0.38, 24), new THREE.MeshBasicMaterial({ map: lockTexture(), transparent: true }));
      sign.position.set(W / 2 - 0.55, top + 0.75, D / 2 - 0.1);
      batch.add('#7d6a5a', placed(new THREE.BoxGeometry(0.08, 0.5, 0.08), { x: W / 2 - 0.55, y: top + 0.25, z: D / 2 - 0.15 }));
      this.tower.add(sign);
    }
    this.pickables.push(body, ...batch.build(this.tower, { tag }));
    this.roofTop = roofTop;

    // Name plaque above the door.
    const plaqueW = Math.min(W * 0.84, 3.4), plaqueH = plaqueW / 4;
    const plaque = new THREE.Mesh(new THREE.PlaneGeometry(plaqueW, plaqueH), new THREE.MeshBasicMaterial({ map: plaqueTexture(this.project.name, { accent: this.project.color }), transparent: true }));
    plaque.position.set(0, PAD_TOP + (s.key === 'storefront' ? 2.32 : 2.18), D / 2 + 0.07);
    plaque.userData = { ...tag };
    this.tower.add(plaque); this.pickables.push(plaque);

    this.buildWindows();
  }

  addBeacon(at, blinking) {
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
    for (const [list, material] of [[lit, MATERIALS.windowLit], [dark, MATERIALS.windowDark]]) {
      if (!list.length) continue;
      const inst = new THREE.InstancedMesh(geo, material, list.length);
      list.forEach((matrix, k) => inst.setMatrixAt(k, matrix));
      inst.userData.noOutline = true;
      this.tower.add(inst);
    }
  }

  buildPad() {
    for (const child of [...this.padGroup.children]) { this.padGroup.remove(child); disposeObject(child); }
    const { W, D } = this.size;
    const pad = new THREE.Mesh(placed(new RoundedBoxGeometry(W + 1.2, 0.14, D + 1.2, 1, 0.12), { y: GROUND_Y + 0.05 }), MATERIALS.pad);
    pad.receiveShadow = true; pad.userData = { buildingId: this.id };
    addOutline(pad, { thickness: 0.03 });
    this.padGroup.add(pad);
    this.pad = pad;
  }

  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    if (on) this.buildScaffold();
    else if (this.scaffold) { this.tower.remove(this.scaffold); disposeObject(this.scaffold); this.scaffold = null; this.jib = null; }
  }
  buildScaffold() {
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
    }
    for (const [list, material] of [[poles, MATERIALS.scaffold], [planks, MATERIALS.plank]]) {
      const m = new THREE.Mesh(mergeParts(list), material); m.castShadow = true; addOutline(m, { thickness: 0.02 }); group.add(m);
    }
    // Little roof crane with a rotating jib.
    const crane = new THREE.Group(); crane.position.set(W / 2 - 0.7, top, D / 2 - 0.9);
    const mast = new THREE.Mesh(placed(new THREE.BoxGeometry(0.26, 3.4, 0.26), { y: 1.7 }), MATERIALS.crane);
    const jib = new THREE.Group(); jib.position.y = 3.4;
    jib.add(new THREE.Mesh(placed(new THREE.BoxGeometry(4.2, 0.22, 0.22), { x: -1.4 }), MATERIALS.crane));
    jib.add(new THREE.Mesh(placed(new THREE.BoxGeometry(0.6, 0.45, 0.45), { x: 0.95, y: -0.1 }), toonMaterial('#6b6f80')));
    jib.add(new THREE.Mesh(placed(new THREE.BoxGeometry(0.03, 1.6, 0.03), { x: -3.2, y: -0.8 }), toonMaterial('#3f4560')));
    jib.add(new THREE.Mesh(placed(new THREE.BoxGeometry(0.3, 0.22, 0.3), { x: -3.2, y: -1.65 }), toonMaterial('#ffd36b')));
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
    this.bodyMaterial.emissive.set(on ? '#5b4bd6' : '#000000');
    this.bodyMaterial.emissiveIntensity = on ? 0.22 : 1;
  }

  remove() {
    if (this.removing) return;
    this.removing = true;
    if (this.env.reducedMotion()) { this.anim = { kind: 'sink', t: 1 }; return; }
    this.anim = { kind: 'sink', t: 0 };
    this.env.particles.emit('dust', this.worldPoint(0, PAD_TOP + 0.4, 0), 18, { spread: this.size.W });
  }

  /* World-space helpers for NPCs and overlays. */
  worldPoint(x, y, z) { return new THREE.Vector3(this.origin.x + x, y, this.origin.z + z); }
  topPoint() { return this.worldPoint(0, (this.roofTop || PAD_TOP + this.size.H) * this.tower.scale.y + 0.6, 0); }
  get center() { return { x: this.origin.x, z: this.origin.z }; }
  get door() { return { x: this.origin.x, z: this.origin.z + this.size.D / 2 + 0.3 }; }
  /** Work spot k in front of the facade, facing the building. */
  workSpot(k) {
    const offsets = [0, -1.3, 1.3, -2.6, 2.6, -0.65, 0.65, -1.95, 1.95];
    const limit = this.size.W / 2 - 0.25;
    const x = Math.max(-limit, Math.min(limit, offsets[k % offsets.length]));
    return { x: this.origin.x + x, z: this.origin.z + this.size.D / 2 + 0.95 + Math.floor(k / offsets.length) * 0.8, fx: 0, fz: -1 };
  }
  get seats() { return lotSeats(this.cell.i, this.cell.j); }
  get lot() { return { i: this.cell.i, j: this.cell.j, padW: this.size.W + 1.2, padD: this.size.D + 1.2, cz: CZ }; }

  /** Returns false when a sink animation has finished and the building can be disposed. */
  update(dt, elapsed, env) {
    if (this.anim) {
      const a = this.anim;
      if (a.delay > 0) { a.delay -= dt; return true; }
      if (a.kind === 'rise') {
        if (a.t === 0) env.particles.emit('dust', this.worldPoint(0, PAD_TOP + 0.3, 0), 22, { spread: this.size.W });
        a.t = Math.min(1, a.t + dt / 1.1);
        this.tower.scale.y = Math.max(0.02, easeOutBack(a.t));
        this.padGroup.scale.setScalar(0.6 + 0.4 * Math.min(1, a.t * 2.5));
        if (a.t >= 1) { this.tower.scale.y = 1; this.padGroup.scale.setScalar(1); this.anim = null; }
      } else if (a.kind === 'grow') {
        a.t += dt;
        this.tower.scale.y = 1 + (a.from - 1) * Math.exp(-4.5 * a.t) * Math.cos(10 * a.t);
        if (a.up && a.t < 0.6 && Math.random() < dt * 30) env.particles.emit('sparkle', this.topPoint(), 2, { spread: this.size.W });
        if (a.t > 1.4) { this.tower.scale.y = 1; this.anim = null; }
      } else if (a.kind === 'sink') {
        a.t = Math.min(1, a.t + dt / 0.9);
        const k = easeIn(a.t);
        this.tower.scale.set(1 - k * 0.15, Math.max(0.001, 1 - k), 1 - k * 0.15);
        this.padGroup.scale.setScalar(Math.max(0.001, 1 - k));
        if (a.t >= 1) return false;
      }
    }
    if (env.reducedMotion) return true;
    if (this.gear) this.gear.rotation.z -= dt * 0.8;
    if (this.flag) this.flag.rotation.y = Math.sin(elapsed * 2.2 + this.origin.x) * 0.3;
    if (this.beaconLight) this.beaconLight.material.emissiveIntensity = (elapsed * 1.4 + this.origin.z) % 1 < 0.5 ? 1.4 : 0.1;
    if (this.jib) this.jib.rotation.y = Math.sin(elapsed * 0.35 + this.origin.x) * 1.2;
    if (env.particles.enabled && !this.removing) {
      this.elapsedEmit += dt;
      if (this.chimneyTop && Math.random() < dt * 1.6) env.particles.emit('smoke', this.worldPoint(this.chimneyTop.x, this.chimneyTop.y * this.tower.scale.y, this.chimneyTop.z), 1, { spread: 0.25 });
      if (this.active && this.scaffoldFront && this.elapsedEmit > 0.28) {
        this.elapsedEmit = 0;
        const f = this.scaffoldFront;
        const y = f.y0 + 0.9 + Math.floor(Math.random() * Math.max(1, (f.top - f.y0) / (FH * 1.5))) * FH * 1.5;
        env.particles.emit('spark', this.worldPoint((Math.random() - 0.5) * f.width * 0.8, y + 0.15, f.z), 6, { spread: 0.2 });
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

  /** projects + their cells (Map id → cell) + Set of project ids with active agents.
   * Returns true when lot footprints changed (decor needs rebuilding). */
  sync(projects, cells, activeIds, { animate = true } = {}) {
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
        building = new Building(project, cell, { ...this.env, animateIn: animate, stagger: () => (animate ? index * 0.08 : 0) });
        this.items.set(project.id, building);
        this.parent.add(building.group);
        lotsChanged = true;
      } else if (building.apply(project, { animate })) lotsChanged = true;
      building.setActive(activeIds.has(project.id));
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
