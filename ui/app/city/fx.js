/* City effects and shared helpers: one-draw-call particle system (sparkles, dust,
 * smoke, sparks, motes), canvas-drawn textures (name plaques, flags, signs, face emblems),
 * geometry merging and outlines for instanced meshes. */
import { THREE, INK, disposeObject } from './toon.js';
import { mergeGeometries } from '../../vendor/three/addons/BufferGeometryUtils.js';

/* ---------- geometry ---------- */
/** Merge already-positioned geometries (mixed indexed / non-indexed) into one. */
export function mergeParts(parts) {
  const prepared = parts.map(g => {
    const flat = g.index ? g.toNonIndexed() : g;
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', flat.getAttribute('position'));
    out.setAttribute('normal', flat.getAttribute('normal'));
    return out;
  });
  const merged = mergeGeometries(prepared, false);
  for (const g of parts) g.dispose();
  merged.computeBoundingBox(); merged.computeBoundingSphere();
  return merged;
}
/** Geometry translated/rotated/scaled in place (returns it). */
export function placed(geometry, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  geometry.applyMatrix4(m);
  return geometry;
}
export function shared(geometry) { geometry.userData.shared = true; return geometry; }
/** disposeObject + release InstancedMesh instance buffers. */
export function disposeAll(root) {
  root?.traverse(node => { if (node.isInstancedMesh) node.dispose(); });
  disposeObject(root);
}

const inkMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(INK), side: THREE.BackSide });
inkMaterial.userData.shared = true; inkMaterial.userData.outline = true;
/** Ink outline for an InstancedMesh: a slightly inflated back-face copy sharing its instance matrices. */
export function instancedOutline(mesh, thickness = 0.05) {
  const geometry = mesh.geometry.clone();
  delete geometry.userData.shared;   // the outline owns this clone, even when the source is shared
  geometry.computeBoundingBox();
  const size = new THREE.Vector3(), center = new THREE.Vector3();
  geometry.boundingBox.getSize(size); geometry.boundingBox.getCenter(center);
  geometry.translate(-center.x, -center.y, -center.z);
  geometry.scale(1 + thickness * 2 / Math.max(size.x, 1e-3), 1 + thickness * 2 / Math.max(size.y, 1e-3), 1 + thickness * 2 / Math.max(size.z, 1e-3));
  geometry.translate(center.x, center.y, center.z);
  const hull = new THREE.InstancedMesh(geometry, inkMaterial, mesh.count);
  hull.instanceMatrix = mesh.instanceMatrix;
  hull.userData.outline = true; hull.raycast = () => {};
  hull.frustumCulled = mesh.frustumCulled;
  return hull;
}

/* ---------- canvas textures ---------- */
function canvasTexture(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const g = canvas.getContext('2d');
  draw(g, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); }
const FONT = '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';

/** Name plaque: cream board, ink border, bold name (shrinks to fit). Aspect 4:1. */
export function plaqueTexture(text, { accent = '#8b7bff', gradient = false } = {}) {
  return canvasTexture(512, 128, (g, w, h) => {
    roundRect(g, 6, 6, w - 12, h - 12, 26); g.fillStyle = '#fff7ea'; g.fill();
    g.lineWidth = 8; g.strokeStyle = INK; g.stroke();
    g.fillStyle = accent; roundRect(g, 22, h - 30, w - 44, 8, 4); g.fill();
    let size = 58; const label = String(text || '').slice(0, 40);
    do { g.font = `700 ${size}px ${FONT}`; size -= 2; } while (g.measureText(label).width > w - 64 && size > 22);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (gradient) {
      const grad = g.createLinearGradient(40, 0, w - 40, 0);
      grad.addColorStop(0, '#ff7a4d'); grad.addColorStop(0.5, '#9a5cff'); grad.addColorStop(1, '#12b89a');
      g.fillStyle = grad;
    } else g.fillStyle = INK;
    g.fillText(label, w / 2, h / 2 - 6);
  });
}
/** Little GitHub flag: dark cloth with the stroked mark (same path as the app icon). */
export function githubFlagTexture() {
  return canvasTexture(128, 96, (g, w, h) => {
    g.fillStyle = '#24292f'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#3a4048'; g.fillRect(0, h - 10, w, 10);
    g.save(); g.translate(w / 2 - 36, h / 2 - 38); g.scale(3, 3);
    g.strokeStyle = '#ffffff'; g.lineWidth = 2; g.lineCap = 'round'; g.lineJoin = 'round';
    g.stroke(new Path2D('M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21'));
    g.restore();
  });
}
/** Round sign with a padlock (private repos). */
export function lockTexture() {
  return canvasTexture(128, 128, (g, w, h) => {
    g.beginPath(); g.arc(w / 2, h / 2, 58, 0, Math.PI * 2); g.fillStyle = '#ffd36b'; g.fill();
    g.lineWidth = 7; g.strokeStyle = INK; g.stroke();
    g.lineWidth = 9; g.beginPath(); g.arc(w / 2, 54, 17, Math.PI, 0); g.stroke();
    roundRect(g, w / 2 - 28, 52, 56, 42, 8); g.fillStyle = INK; g.fill();
    g.beginPath(); g.arc(w / 2, 70, 6, 0, Math.PI * 2); g.fillStyle = '#ffd36b'; g.fill();
  });
}
/** Face emblem for the island's two sides (original marks, no product logos):
 *  'pc' → a simple laptop + "THIS PC"; 'spark' → a circuit chip in green + "DGX SPARK". Aspect 4:1. */
export function sideTexture(kind) {
  const spark = kind === 'spark';
  const edge = spark ? '#24461f' : INK;
  return canvasTexture(640, 160, (g, w, h) => {
    roundRect(g, 6, 6, w - 12, h - 12, 30); g.fillStyle = spark ? '#f1fae3' : '#fff7ea'; g.fill();
    g.lineWidth = 8; g.strokeStyle = edge; g.stroke();
    g.save(); g.translate(92, h / 2 - 2);
    g.lineJoin = 'round'; g.lineCap = 'round'; g.strokeStyle = edge;
    if (spark) {
      // Chip: pins on four sides, a green package and a pale die.
      g.lineWidth = 7;
      for (const o of [-21, -7, 7, 21]) {
        g.beginPath(); g.moveTo(o, -48); g.lineTo(o, -36); g.moveTo(o, 36); g.lineTo(o, 48);
        g.moveTo(-48, o); g.lineTo(-36, o); g.moveTo(36, o); g.lineTo(48, o); g.stroke();
      }
      roundRect(g, -36, -36, 72, 72, 9); g.fillStyle = '#76b900'; g.fill(); g.lineWidth = 6; g.stroke();
      roundRect(g, -16, -16, 32, 32, 5); g.fillStyle = '#e8ffc0'; g.fill(); g.lineWidth = 4; g.stroke();
    } else {
      // Laptop: open lid with a brand-gradient screen, and a flat base.
      roundRect(g, -44, -42, 88, 60, 8); g.fillStyle = '#ffffff'; g.fill(); g.lineWidth = 6; g.stroke();
      const grad = g.createLinearGradient(-34, -32, 34, 10);
      grad.addColorStop(0, '#ff7a4d'); grad.addColorStop(0.5, '#9a5cff'); grad.addColorStop(1, '#12b89a');
      roundRect(g, -34, -32, 68, 40, 4); g.fillStyle = grad; g.fill();
      g.beginPath(); g.moveTo(-56, 26); g.lineTo(56, 26); g.lineTo(48, 40); g.lineTo(-48, 40); g.closePath();
      g.fillStyle = '#d9dcec'; g.fill(); g.lineWidth = 6; g.stroke();
    }
    g.restore();
    const label = spark ? 'DGX SPARK' : 'THIS PC';
    let size = 76;
    do { g.font = `800 ${size}px ${FONT}`; size -= 2; } while (g.measureText(label).width > w - 210 && size > 30);
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillStyle = spark ? '#3c7a00' : INK;
    g.fillText(label, 168, h / 2 - 6);
    if (spark) g.fillStyle = '#76b900';
    else { const bar = g.createLinearGradient(168, 0, w - 40, 0); bar.addColorStop(0, '#ff7a4d'); bar.addColorStop(0.5, '#9a5cff'); bar.addColorStop(1, '#12b89a'); g.fillStyle = bar; }
    roundRect(g, 168, h - 36, w - 208, 9, 4.5); g.fill();
  });
}
/** Clock face for the HQ tower. */
export function clockTexture() {
  return canvasTexture(128, 128, (g, w) => {
    g.beginPath(); g.arc(w / 2, w / 2, 60, 0, Math.PI * 2); g.fillStyle = '#fffaf0'; g.fill();
    g.lineWidth = 6; g.strokeStyle = INK; g.stroke();
    for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2; g.beginPath(); g.moveTo(w / 2 + Math.sin(a) * 44, w / 2 - Math.cos(a) * 44); g.lineTo(w / 2 + Math.sin(a) * 52, w / 2 - Math.cos(a) * 52); g.lineWidth = k % 3 ? 3 : 6; g.stroke(); }
  });
}

/* ---------- particles ---------- */
const VERT = `
attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
uniform float uScale;
varying float vAlpha; varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
  vAlpha = aAlpha; vColor = aColor;
}`;
const FRAG = `
varying float vAlpha; varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5 || vAlpha <= 0.0) discard;
  gl_FragColor = vec4(vColor, (1.0 - smoothstep(0.18, 0.5, d)) * vAlpha);
  #include <colorspace_fragment>
}`;

/** Presets: velocity spread, gravity, growth, lifetime, size, colours. */
const KINDS = {
  sparkle: { life: [0.7, 1.2], size: [0.25, 0.45], speed: [1.5, 3.2], up: 2.4, gravity: -2.5, grow: -0.2, drag: 1.6, colors: ['#fff2a8', '#ffffff', '#ffd36b', '#b8a8ff'] },
  dust: { life: [0.9, 1.5], size: [0.8, 1.4], speed: [1.2, 2.4], up: 0.6, gravity: 0.4, grow: 1.4, drag: 2.4, colors: ['#e8d9bf', '#d9c7a6', '#f2e8d5'], alpha: 0.75 },
  smoke: { life: [2.6, 3.6], size: [0.6, 0.9], speed: [0.1, 0.3], up: 0.9, gravity: 0.15, grow: 0.9, drag: 0.4, colors: ['#e6e3ee', '#cfcad9', '#f4f2f8'], alpha: 0.7 },
  spark: { life: [0.35, 0.6], size: [0.12, 0.2], speed: [2, 4], up: 2, gravity: -9, grow: -0.1, drag: 0.5, colors: ['#ffd36b', '#ff9a4d', '#fff4c2'] },
  water: { life: [0.5, 0.8], size: [0.12, 0.2], speed: [0.3, 0.7], up: 3.0, gravity: -9, grow: 0, drag: 0.3, colors: ['#bfefff', '#ffffff', '#8fdcf0'], alpha: 0.85 },
  mote: { life: [2.2, 3.4], size: [0.18, 0.3], speed: [0.1, 0.4], up: 1.6, gravity: 0.2, grow: 0, drag: 0.2, colors: ['#ff8a5c', '#b276ff', '#22c7a9'] },
};
const rand = ([a, b]) => a + Math.random() * (b - a);

export class Particles {
  constructor(capacity = 700) {
    this.capacity = capacity;
    this.items = Array.from({ length: capacity }, () => ({ life: 0, max: 1, vx: 0, vy: 0, vz: 0, size: 0, grow: 0, drag: 0, gravity: 0, alpha: 1 }));
    this.cursor = 0; this.alive = 0;
    const geometry = new THREE.BufferGeometry();
    this.position = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.color = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.size = new THREE.BufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    this.alpha = new THREE.BufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.position); geometry.setAttribute('aColor', this.color);
    geometry.setAttribute('aSize', this.size); geometry.setAttribute('aAlpha', this.alpha);
    this.material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { uScale: { value: 400 } }, transparent: true, depthWrite: false });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false; this.points.renderOrder = 5;
    this.enabled = true;
    this._color = new THREE.Color();
  }
  setViewport(heightPx, fovDeg) { this.material.uniforms.uScale.value = heightPx / (2 * Math.tan(fovDeg * Math.PI / 360)); }
  /** emit('sparkle', {x,y,z}, count, { spread, colors }) */
  emit(kind, at, count = 1, options = {}) {
    if (!this.enabled) return;
    const preset = KINDS[kind] || KINDS.sparkle;
    for (let n = 0; n < count; n++) {
      const index = this.cursor; this.cursor = (this.cursor + 1) % this.capacity;
      const p = this.items[index];
      const angle = Math.random() * Math.PI * 2, speed = rand(preset.speed) * (options.speed ?? 1);
      const spread = options.spread ?? 0.3;
      p.max = p.life = rand(preset.life);
      p.vx = Math.cos(angle) * speed; p.vz = Math.sin(angle) * speed; p.vy = preset.up * (0.6 + Math.random() * 0.8);
      p.size = rand(preset.size) * (options.scale ?? 1); p.grow = preset.grow; p.drag = preset.drag; p.gravity = preset.gravity; p.alpha = options.alpha ?? preset.alpha ?? 1;
      this.position.setXYZ(index, at.x + (Math.random() - 0.5) * spread, at.y + (Math.random() - 0.5) * spread * 0.5, at.z + (Math.random() - 0.5) * spread);
      const colors = options.colors || preset.colors;
      this._color.set(colors[Math.floor(Math.random() * colors.length)]);
      this.color.setXYZ(index, this._color.r, this._color.g, this._color.b);
    }
    this.color.needsUpdate = true;
  }
  update(dt) {
    let alive = 0;
    const pos = this.position.array, size = this.size.array, alpha = this.alpha.array;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.items[i];
      if (p.life <= 0) { if (alpha[i] !== 0) { alpha[i] = 0; size[i] = 0; } continue; }
      alive++;
      p.life -= dt;
      const k = Math.max(0, 1 - p.drag * dt);
      p.vx *= k; p.vz *= k; p.vy = p.vy * Math.max(0, 1 - p.drag * 0.3 * dt) + p.gravity * dt;
      pos[i * 3] += p.vx * dt; pos[i * 3 + 1] += p.vy * dt; pos[i * 3 + 2] += p.vz * dt;
      p.size = Math.max(0.01, p.size + p.grow * dt);
      const t = Math.max(0, p.life / p.max);
      size[i] = p.size;
      alpha[i] = p.alpha * Math.min(1, t * 2.2) * Math.min(1, (1 - t) * 8 + 0.2);
    }
    if (alive || this.alive) { this.position.needsUpdate = true; this.size.needsUpdate = true; this.alpha.needsUpdate = true; }
    this.alive = alive;
  }
  clear() { for (const p of this.items) p.life = 0; }
  dispose() { this.points.geometry.dispose(); this.material.dispose(); }
}
