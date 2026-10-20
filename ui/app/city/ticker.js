/* Access ticker: a thin, full-colour stock-ticker band that wraps all four sides of a building just
 * under its roof cornice and shows the project's access level (../access.js, two levels: Full and
 * Read only): the name, the level label in its colour and how many agents are working there,
 * separated by bullets. Ported from claude/033-access-ticker (2cfb1a4) and simplified.
 *
 * Each distinct text + palette is drawn once into a CanvasTexture and shared by every building that
 * shows it; it scrolls by moving that texture's offset, so a frame costs one offset per distinct
 * ticker and each building is one mesh. Static under reduced motion and while paused (grey). A
 * texture is disposed once no building uses it. */
import { THREE } from './toon.js';
import { levelInfo } from '../access.js';

export const PAUSED_COLOR = '#8a8f9c';

/** Segments for one building: name • Full access / Read only (in the level colour) • who works there. */
export function tickerSegments(project, level, working = 0) {
  const info = levelInfo(level);
  const name = String(project?.name || '').replace(/\s+/g, ' ').trim();
  const n = Math.max(0, Math.floor(Number(working) || 0));
  return [
    { text: name.length > 40 ? `${name.slice(0, 39).trimEnd()}…` : name || 'Project', tone: 'name' },
    { text: info.long, tone: 'level', color: info.color },
    { text: n ? `${n} agent${n === 1 ? '' : 's'} working` : 'No agents working', tone: 'info' },
  ];
}

/** World units: panel height, distance out from the walls (clear of windows and floor trims),
 *  gap below the top of the walls (the roof cornice sits there) and scroll speed per second. */
export const TICKER = { band: 0.62, off: 0.13, below: 0.2, speed: 0.9 };
const TEX_H = 96, PANEL_Y = 14, PANEL_H = 68;     // canvas rows: glow margin, panel, glow margin
const GEO_H = TICKER.band * TEX_H / PANEL_H;      // band height including its glow margins
const MAX_W = 4096, GAP = 24, STRIP = 8;         // widest tile (px); space either side of a bullet; edge strips
const FONT = '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
const PALETTE = {
  live: { panel: ['#232a3d', '#11141f', '#06080d'], name: '#ffffff', info: '#c9cfe1', action: '#eef1f8', paused: '#d4d6dc', glow: 0.95, sheen: 0.17, wash: 0.3 },
  grey: { panel: ['#24262c', '#16171b', '#0b0c0f'], name: '#c9ccd4', info: '#a3a8b3', action: '#b5b9c3', paused: '#d4d6dc', glow: 0, sheen: 0.1, wash: 0.08 },
};
const rgba = (hex, a) => { const n = parseInt(String(hex).slice(1), 16) || 0; return `rgba(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}, ${a})`; };
const lighten = (hex, t) => { const n = parseInt(String(hex).slice(1), 16) || 0; return `#${[16, 8, 0].map(s => Math.round((n >> s & 255) + (255 - (n >> s & 255)) * t).toString(16).padStart(2, '0')).join('')}`; };
export const tileSig = (segments, grey) => JSON.stringify([grey ? 1 : 0, (segments || []).map(s => [s.text, s.tone, s.color || ''])]);

/** One tile: [gap/2] seg [gap] • [gap] seg … seg [gap] • [gap/2], so tiles repeat seamlessly. */
function drawTile(segments, grey, anisotropy) {
  const pal = grey ? PALETTE.grey : PALETTE.live;
  const accent = grey ? PAUSED_COLOR : segments.find(s => s.tone === 'level')?.color || '#8b7bff';
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  const fontOf = (tone, px) => `${tone === 'name' || tone === 'level' ? 700 : 600} ${px}px ${FONT}`;
  let px = 40, items = [], bullet = 0, width = 0;
  for (;;) {   // shrink the type until the tile fits a texture
    g.font = fontOf('info', px); bullet = g.measureText('•').width;
    items = segments.map(s => { g.font = fontOf(s.tone, px); return { ...s, w: g.measureText(s.text).width }; });
    width = Math.ceil(items.reduce((sum, s) => sum + s.w + GAP * 2 + bullet, 0));
    if (width <= MAX_W || px <= 20) break;
    px -= 2;
  }
  canvas.width = Math.max(64, Math.min(MAX_W, width)); canvas.height = TEX_H;   // resets the context
  const w = canvas.width, y0 = PANEL_Y, y1 = PANEL_Y + PANEL_H, mid = y0 + PANEL_H / 2;
  // Soft glow in the margins: the shadow of a panel drawn wider than the tile, so tile edges stay seamless.
  if (pal.glow) { g.save(); g.shadowColor = rgba(accent, pal.glow); g.shadowBlur = 18; g.fillStyle = '#06080d'; for (let k = 0; k < 2; k++) g.fillRect(-48, y0 + 2, w + 96, PANEL_H - 4); g.restore(); }
  // Dark glossy panel: deep vertical gradient, a sheen over the upper half, a faint level-coloured wash below.
  const body = g.createLinearGradient(0, y0, 0, y1);
  body.addColorStop(0, pal.panel[0]); body.addColorStop(0.46, pal.panel[1]); body.addColorStop(1, pal.panel[2]);
  g.fillStyle = body; g.fillRect(0, y0, w, PANEL_H);
  const sheen = g.createLinearGradient(0, y0, 0, mid);
  sheen.addColorStop(0, `rgba(255, 255, 255, ${pal.sheen})`); sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
  g.fillStyle = sheen; g.fillRect(0, y0, w, PANEL_H / 2);
  const wash = g.createLinearGradient(0, mid, 0, y1);
  wash.addColorStop(0, rgba(accent, 0)); wash.addColorStop(1, rgba(accent, pal.wash));
  g.fillStyle = wash; g.fillRect(0, mid, w, PANEL_H / 2);
  // Level-coloured gradient strips along both edges (colour → light → colour, so tiles join seamlessly).
  const strip = g.createLinearGradient(0, 0, w, 0);
  strip.addColorStop(0, accent); strip.addColorStop(0.5, lighten(accent, grey ? 0.15 : 0.5)); strip.addColorStop(1, accent);
  g.fillStyle = strip; g.fillRect(0, y0, w, STRIP); g.fillRect(0, y1 - STRIP, w, STRIP);   // thick enough to read the colour from afar
  g.fillStyle = 'rgba(255, 255, 255, .22)'; g.fillRect(0, y0 + STRIP, w, 1);
  // Text: crisp, with a soft drop shadow; the level label glows in its colour.
  g.textBaseline = 'middle'; g.textAlign = 'left';
  const color = s => (s.tone === 'level' ? accent : pal[s.tone] || pal.info);
  let x = GAP / 2;
  for (const s of items) {
    g.save();
    g.font = fontOf(s.tone, px);
    if (s.tone === 'level' && pal.glow) { g.shadowColor = rgba(accent, 0.75); g.shadowBlur = 12; }
    else { g.shadowColor = 'rgba(0, 0, 0, .55)'; g.shadowBlur = 3; g.shadowOffsetY = 1; }
    g.fillStyle = color(s); g.fillText(s.text, x, mid + 1);
    g.restore();
    x += s.w + GAP;
    g.font = fontOf('info', px); g.fillStyle = rgba(accent, grey ? 0.6 : 0.9); g.fillText('•', x, mid + 1);
    x += bullet + GAP;
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = anisotropy;
  const aspect = w / TEX_H;
  return { texture, aspect, rate: TICKER.speed / (GEO_H * aspect), still: Boolean(grey), refs: 0 };
}

/** Shared tiles (one texture per distinct text + palette) and the per-frame scroll. */
export class TickerBank {
  constructor() { this.tiles = new Map(); this.anisotropy = 4; }
  setAnisotropy(n) { this.anisotropy = Math.max(1, Math.min(8, Math.floor(Number(n) || 4))); }
  acquire(segments, grey = false) {
    const sig = tileSig(segments, grey);
    let tile = this.tiles.get(sig);
    if (!tile) { tile = drawTile(segments, grey, this.anisotropy); tile.sig = sig; this.tiles.set(sig, tile); }
    tile.refs++;
    return tile;
  }
  /** Unused tiles are disposed on the next update / sweep (a tower rebuilt in the same frame reuses its tile). */
  release(tile) { if (tile) tile.refs = Math.max(0, tile.refs - 1); }
  sweep() { for (const [sig, tile] of this.tiles) if (tile.refs <= 0) { tile.texture.dispose(); this.tiles.delete(sig); } }
  update(dt, reduced = false) {
    this.sweep();
    for (const tile of this.tiles.values()) {
      const offset = tile.texture.offset;
      if (tile.still || reduced) { if (offset.x) offset.x = 0; continue; }
      offset.x = (offset.x + dt * tile.rate) % 1;
    }
  }
  get size() { return this.tiles.size; }
  dispose() { for (const tile of this.tiles.values()) tile.texture.dispose(); this.tiles.clear(); }
}
export const tickerBank = new TickerBank();

/** The band (four outward faces, left → right as seen from outside: front +z, right +x, back -z,
 *  left -x) so the text runs on round the corners. UVs are set per tile in Ticker.fit. */
function bandGeometry(a, b, y) {
  const y0 = y - GEO_H / 2, y1 = y + GEO_H / 2;
  const faces = [[-a, b, a, b, 0, 1], [a, b, a, -b, 1, 0], [a, -b, -a, -b, 0, -1], [-a, -b, -a, b, -1, 0]];
  const position = [], normal = [], index = [];
  faces.forEach(([xa, za, xb, zb, nx, nz], k) => {
    position.push(xa, y0, za, xb, y0, zb, xb, y1, zb, xa, y1, za);
    for (let i = 0; i < 4; i++) normal.push(nx, 0, nz);
    index.push(k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(32).fill(0), 2));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
}

/** One building's ticker band. top: height of the top of the walls (local y); W, D: wall footprint. */
export class Ticker {
  constructor({ W, D, top, tag = {}, bank = tickerBank }) {
    this.bank = bank;
    this.a = W / 2 + TICKER.off; this.b = D / 2 + TICKER.off;
    this.geometry = bandGeometry(this.a, this.b, top - TICKER.below - TICKER.band / 2);
    this.material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
    this.material.userData.shared = true;   // disposed here, never with the tower (its map belongs to the bank)
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.userData = { ...tag, noOutline: true };
    this.mesh.renderOrder = 2;
    this.tile = null; this.sig = '';
  }
  /** Show these segments (access.js tickerSegments); grey: paused palette, no scrolling. Redraws only on change. */
  set(segments, { grey = false } = {}) {
    const sig = tileSig(segments, grey);
    if (sig === this.sig) return;
    const tile = this.bank.acquire(segments, grey);
    this.bank.release(this.tile);
    this.tile = tile; this.sig = sig;
    const first = !this.material.map;
    this.material.map = tile.texture;
    if (first) this.material.needsUpdate = true;
    this.fit(tile.aspect);
  }
  /** A whole number of tiles round the band, so the text joins up at the front-left corner. */
  fit(aspect) {
    const { a, b } = this, around = 4 * (a + b), n = Math.max(1, Math.round(around / (GEO_H * aspect)));
    const edges = [0, 2 * a, 2 * a + 2 * b, 4 * a + 2 * b, around];
    const uv = this.geometry.getAttribute('uv');
    for (let k = 0; k < 4; k++) {
      const u0 = edges[k] / around * n, u1 = edges[k + 1] / around * n;
      uv.setXY(k * 4, u0, 0); uv.setXY(k * 4 + 1, u1, 0); uv.setXY(k * 4 + 2, u1, 1); uv.setXY(k * 4 + 3, u0, 1);
    }
    uv.needsUpdate = true;
  }
  setHover(on) { this.material.color.setScalar(on ? 1.45 : 1); }
  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose(); this.material.dispose();
    this.bank.release(this.tile); this.tile = null; this.sig = '';
  }
}
