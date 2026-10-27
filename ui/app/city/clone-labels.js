/* Clone reservations reuse the City's pill name-label treatment at overview zoom.
 * Their DOM and picking stay separate from agent labels and conversation routing. */
import { h } from '../ui.js';
import { THREE } from './toon.js';

export class CloneLotLabels {
  constructor(layer, onClick, layout) {
    this.layer = layer; this.onClick = onClick; this.layout = layout; this.items = new Map();
    this.point = new THREE.Vector3();
  }
  sync(buildings) {
    const wanted = new Set();
    for (const building of buildings) {
      if (!building.unbuilt) continue;
      wanted.add(building.id);
      let label = this.items.get(building.id);
      if (!label) {
        const node = h('button.city-label.is-clone-lot', { type: 'button', hidden: true,
          onclick: event => { event.stopPropagation(); this.onClick(building.id); } });
        label = { node }; this.items.set(building.id, label); this.layer.append(node);
      }
      label.building = building;
      const text = `${building.project.name} - Clone to build`;
      if (label.text !== text) { label.text = text; label.node.textContent = text; label.node.title = text; label.width = null; }
    }
    for (const [id, label] of this.items) if (!wanted.has(id)) { label.node.remove(); this.items.delete(id); }
  }
  update(world, enabled, blockers = []) {
    const candidates = [], points = new Map();
    for (const [id, label] of this.items) {
      if (!enabled) { label.node.hidden = true; continue; }
      const b = label.building;
      world.toWorld(b.worldPoint(0, b.roofTop + 0.2, b.unbuiltSign?.position.z || 0), { out: this.point });
      const p = world.project(this.point), distance = world.camera.position.distanceTo(this.point);
      // Near the lot, the physical board is the label. At overview it gets a
      // constant-size, fully opaque label instead of fading out with distance.
      if (!p.visible || distance < 40) { label.node.hidden = true; continue; }
      label.node.hidden = false;
      label.width ||= label.node.offsetWidth || Math.min(370, label.text.length * 7 + 20);
      points.set(id, p);
      candidates.push({ key: id, rect: { left: p.x - label.width / 2, right: p.x + label.width / 2, top: p.y - 26, bottom: p.y },
        ax: p.x, ay: p.y, priority: 1, dist: distance, pinned: false, clusterable: false });
    }
    const shown = this.layout(candidates, { bounds: { left: 0, top: 0, right: world.size.w, bottom: world.size.h }, blockers, max: 20, gap: 4, nudges: [[0, 0]] }).shown;
    for (const [id, label] of this.items) {
      const p = points.get(id); label.node.hidden = !p || !shown.has(id);
      if (!label.node.hidden) label.node.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  }
  dispose() { for (const label of this.items.values()) label.node.remove(); this.items.clear(); }
}
