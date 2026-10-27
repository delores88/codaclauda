/* Your other GitHub accounts' islands, seen from home: smaller islands floating on their own on the
 * same level beside the main one (no bridge: agents fly across in little planes, see airport.js and
 * npc.js trips), each with an airstrip, a low-detail skyline of that account's buildings and a name label. Click one to cross
 * (IslandMode.portal). Contributor islands are not drawn here: they lie a level below. Geometry is
 * merged per island; everything is opaque. */
import { THREE, toonMaterial, addOutline } from './toon.js';
import { placed, mergeParts, disposeAll } from './fx.js';
import { RoundedBoxGeometry } from '../../vendor/three/addons/RoundedBoxGeometry.js';
import { TOWER_PALETTES } from './architecture.js';
import { PALETTE } from './scenery.js';
import { hash } from '../avatar/spec.js';
import { h } from '../ui.js';
import { airstrip } from './airport.js';

const GAP = 30;            // open air between the main island and a neighbour (the home airfield juts 12 into it)
const rbox = (w, h, d, r = 0.4, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01));

/** Where each neighbour sits: alternately right and left of home, further out as they add up. */
export function neighborLayout(islands, homeHalf) {
  const out = [], reach = [homeHalf, homeHalf];
  islands.slice(0, 6).forEach((island, k) => {
    const side = k % 2 ? -1 : 1, n = island.count || 0;
    const half = Math.max(10, Math.min(24, 9 + Math.sqrt(n) * 4));
    const at = reach[side > 0 ? 0 : 1] + GAP + half;
    reach[side > 0 ? 0 : 1] = at + half;
    out.push({ ...island, x: side * at, z: 0, half, side });
  });
  return out;
}

/** One block per project on a loose grid inside the island, north of its airstrip: { id, x, z, w, built }. */
export function skylineBlocks(spot, projects) {
  const size = spot.half * 2, list = projects.slice(0, 25), per = Math.max(1, Math.ceil(Math.sqrt(list.length)));
  const cellX = (size - 4) / per, cellZ = (size - 10) / per;
  return list.map((p, k) => {
    const row = Math.floor(k / per), col = k % per;
    return { id: p.id, x: spot.x - size / 2 + 2 + cellX * (col + 0.5), z: spot.z - size / 2 + 2 + cellZ * (row + 0.5), w: Math.min(cellX, cellZ) * 0.55, built: Boolean(p.path), project: p };
  });
}

export class NeighborIslands {
  constructor(parent) {
    this.group = new THREE.Group(); this.group.name = 'neighbor-islands';
    parent.add(this.group);
    this.sig = '';
    this.items = [];
    this.blocks = new Map();     // project id -> its block on a neighbour island (agents work beside it)
    this.strips = new Map();     // island id -> its airstrip (airport.js)
    this.layer = null; this.onPick = null;
    this.point = new THREE.Vector3();
  }
  /** Floating "@account" labels (clickable: cross to that island). */
  attachLabels(layer, onPick) { this.layer = layer; this.onPick = onPick; }
  /** islands: [{ id, owner, projects: [{ id, metrics, name, path }] }]; homeHalf: main island half size. */
  sync(islands, homeHalf) {
    const sig = JSON.stringify([homeHalf, islands.map(i => [i.id, i.owner, (i.projects || []).map(p => [p.id, p.metrics?.floors || 1, Boolean(p.path)])])]);
    if (sig === this.sig) return false;
    this.sig = sig;
    this.clear();
    for (const spot of neighborLayout(islands.map(i => ({ ...i, count: (i.projects || []).length })), homeHalf)) this.items.push(this.build(spot));
    return true;
  }
  build(spot) {
    const g = new THREE.Group(); g.name = `neighbor:${spot.id}`;
    const tag = { ownedIsland: spot.id };
    const size = spot.half * 2;
    const part = (geometry, color, outline = 0.05) => {
      const mesh = new THREE.Mesh(geometry, toonMaterial(color)); mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData = { ...tag }; if (outline) addOutline(mesh, { thickness: outline }); g.add(mesh); return mesh;
    };
    // A floating island: grass top level with the main island, dirt, and a tapering stone underside.
    part(placed(rbox(size, 1.0, size, 1.4, 3), { x: spot.x, y: -0.5, z: spot.z }), PALETTE.grass, 0.08);
    part(placed(rbox(size - 0.9, 2.6, size - 0.9, 1.2, 2), { x: spot.x, y: -2.0, z: spot.z }), PALETTE.dirt, 0.07);
    part(placed(rbox(size * 0.62, 2.6, size * 0.62, 1, 2), { x: spot.x, y: -4.6, z: spot.z }), PALETTE.stone, 0.06);
    part(placed(rbox(size * 0.3, 2.2, size * 0.3, 0.8, 2), { x: spot.x, y: -6.8, z: spot.z }), PALETTE.stone, 0.05);
    // Skyline: one block per project, height from its floors, colour from its palette (pads until cloned).
    const blocks = new Map();
    for (const b of skylineBlocks(spot, spot.projects || [])) {
      const palette = TOWER_PALETTES[hash(`palette:${b.id}`) % TOWER_PALETTES.length];
      const height = b.built ? Math.min(14, 1.6 + (b.project.metrics?.floors || 1) * 1.1) : 0.18;
      const color = b.built ? palette.body : '#d9d4c7';
      if (!blocks.has(color)) blocks.set(color, []);
      blocks.get(color).push(placed(new THREE.BoxGeometry(b.w, height, b.w), { x: b.x, y: height / 2, z: b.z }));
      this.blocks.set(b.id, { ...b, island: spot.id });
    }
    for (const [color, list] of blocks) part(mergeParts(list), color, 0.04);
    this.strips.set(spot.id, airstrip(g, spot, tag));
    this.group.add(g);
    let label = null;
    if (this.layer) {
      const count = (spot.projects || []).length;
      label = h('button.city-label.is-island-label', { type: 'button', hidden: true, title: `Visit @${spot.owner}'s island`,
        onclick: event => { event.stopPropagation(); this.onPick?.(spot.id); } }, `@${spot.owner} · ${count} ${count === 1 ? 'repo' : 'repos'}`);
      this.layer.append(label);
    }
    return { id: spot.id, group: g, spot, label };
  }
  /** Where agent number k working on an island project stands: in front of its block, facing it. */
  spotFor(projectId, k = 0) {
    const b = this.blocks.get(projectId);
    if (!b) return null;
    const x = b.x + ((k % 3) - 1) * 0.85, z = b.z + b.w / 2 + 0.9 + Math.floor(k / 3) * 0.85;
    return { x, z, fx: 0, fz: -1, face: { x, z: z - 4 }, island: b.island };
  }
  /** The neighbour island under (x, z) (island-local coordinates), or null (home). */
  islandAt(x, z) { return this.items.find(({ spot }) => Math.abs(x - spot.x) <= spot.half + 0.5 && Math.abs(z - spot.z) <= spot.half + 0.5)?.id || null; }
  contains(x, z) { return Boolean(this.islandAt(x, z)); }
  airportFor(id) { return this.strips.get(id) || null; }
  updateLabels(world, enabled) {
    for (const item of this.items) {
      if (!item.label) continue;
      const p = enabled && this.group.visible ? world.project(world.toWorld(this.point.set(item.spot.x, 3.2, item.spot.z), { out: this.point })) : null;
      item.label.hidden = !p?.visible;
      if (p?.visible) item.label.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  }
  pickables() { return this.group.visible ? this.items.flatMap(i => i.group.children.filter(c => c.isMesh)) : []; }
  setVisible(on) { this.group.visible = Boolean(on); }
  clear() { for (const item of this.items) { item.group.removeFromParent(); disposeAll(item.group); item.label?.remove(); } this.items = []; this.blocks.clear(); this.strips.clear(); }
  dispose() { this.clear(); this.group.removeFromParent(); }
}
