/* Airports and little planes for trips between your islands (home and your other GitHub accounts'
 * islands, all on the same level; see neighbors.js). Agents never walk across open air: they walk to
 * an airport, board a little prop plane (striped in their provider's colour), fly, land, taxi, get
 * off and walk on (npc.js trips).
 *   Home: an airfield attached to the island's rim, outside the lot grid, so it is never a building
 *   plot and cannot be removed. It shows whenever your accounts are separate islands.
 *   Account islands: an airstrip along their near edge (built by neighbors.js with airstrip()).
 * A strip is { land: { start, end }, depart: { start, end }, apron } in island-local coordinates. */
import { THREE, toonMaterial, addOutline } from './toon.js';
import { placed, mergeParts, disposeAll, plaqueTexture, shared } from './fx.js';
import { RoundedBoxGeometry } from '../../vendor/three/addons/RoundedBoxGeometry.js';
import { PALETTE } from './scenery.js';

export const AIRFIELD = { w: 12, d: 26 };          // home airfield: x out from the rim, z along it
const ASPHALT = '#585f78', PAINT = '#f7f3e8', APRON = '#c9c4b8';
const rbox = (w, h, d, r = 0.3, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01));
const box = (w, h, d, at) => placed(new THREE.BoxGeometry(w, h, d), at);
const cyl = (r0, r1, h, at, seg = 12) => placed(new THREE.CylinderGeometry(r0, r1, h, seg), at);

/** Paint, tower, windsock and terminal shared by both airport kinds; adds meshes to group. */
function airportParts(group, tag, { runway, along, terminal, tower, sock }) {
  const part = (geometry, color, outline = 0.03) => {
    const mesh = new THREE.Mesh(geometry, toonMaterial(color)); mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData = { ...tag }; if (outline) addOutline(mesh, { thickness: outline }); group.add(mesh); return mesh;
  };
  // Runway with a dashed centre line and threshold bars at both ends.
  const { cx, cz, length, width, y } = runway, ax = along === 'x';
  part(box(ax ? length : width, 0.06, ax ? width : length, { x: cx, y, z: cz }), ASPHALT, 0);
  const dashes = [], bars = [];
  for (let s = -length / 2 + 3; s <= length / 2 - 3; s += 1.6) dashes.push(box(ax ? 0.8 : 0.12, 0.02, ax ? 0.12 : 0.8, { x: cx + (ax ? s : 0), y: y + 0.04, z: cz + (ax ? 0 : s) }));
  for (const end of [-1, 1]) for (let k = -2; k <= 2; k++) {
    if (!k) continue;
    const s = end * (length / 2 - 1), o = k * width * 0.17;
    bars.push(box(ax ? 1.1 : 0.16, 0.02, ax ? 0.16 : 1.1, { x: cx + (ax ? s : o), y: y + 0.04, z: cz + (ax ? o : s) }));
  }
  part(mergeParts([...dashes, ...bars]), PAINT, 0);
  // Terminal: a low cream building with a blue glass band and a sign.
  const t = terminal;
  part(placed(rbox(t.w, 1.5, t.d, 0.18), { x: t.x, y: 0.75, z: t.z }), '#f4ead8', 0.04);
  part(placed(rbox(t.w + 0.3, 0.22, t.d + 0.3, 0.1), { x: t.x, y: 1.6, z: t.z }), '#5d86b8', 0.03);
  part(box(t.face.x ? 0.06 : t.w * 0.8, 0.55, t.face.x ? t.d * 0.8 : 0.06, { x: t.x + t.face.x * (t.w / 2 + 0.01), y: 0.95, z: t.z + t.face.z * (t.d / 2 + 0.01) }), '#7cc0e6', 0);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.65), new THREE.MeshBasicMaterial({ map: plaqueTexture('✈ Airport', { accent: '#5d86b8' }) }));
  sign.position.set(t.x + t.face.x * (t.w / 2 + 0.05), 2.15, t.z + t.face.z * (t.d / 2 + 0.05));
  sign.rotation.y = Math.atan2(t.face.x, t.face.z); sign.userData = { ...tag }; group.add(sign);
  // Control tower: a slim shaft, a glass cab and a cap.
  part(cyl(0.32, 0.42, 3.4, { x: tower.x, y: 1.7, z: tower.z }), '#eee6d6', 0.03);
  part(cyl(0.78, 0.7, 0.75, { x: tower.x, y: 3.75, z: tower.z }, 10), '#7cc0e6', 0.03);
  part(cyl(0.88, 0.88, 0.16, { x: tower.x, y: 4.2, z: tower.z }, 10), '#5d86b8', 0.03);
  // Windsock: pole and an orange-and-white cone pointing downwind.
  part(cyl(0.05, 0.05, 2.4, { x: sock.x, y: 1.2, z: sock.z }, 6), '#9aa0b2', 0.02);
  part(placed(new THREE.ConeGeometry(0.24, 1.1, 10, 1, true), { x: sock.x + 0.55, y: 2.25, z: sock.z, rz: Math.PI / 2 + 0.25 }), '#ff8a3d', 0.02);
}

/** The home airfield, attached to the rim at x = +half; rebuilt when the island grows. */
export class Airfield {
  constructor(parent) {
    this.group = new THREE.Group(); this.group.name = 'airfield';
    parent.add(this.group);
    this.key = ''; this.strip = null; this.parked = null;
  }
  /** show: are there islands to fly to; avoidZ: where the river leaves the east rim (null without a river). */
  sync({ half, show, avoidZ = null }) {
    const key = JSON.stringify([Boolean(show), half, avoidZ == null ? null : Math.round(avoidZ)]);
    if (key === this.key) return;
    this.key = key; this.clear();
    if (!show) return;
    const { w, d } = AIRFIELD, x0 = half - 0.6, cx = x0 + w / 2;
    const cz = avoidZ == null ? 0 : avoidZ > 0 ? avoidZ - (d / 2 + 4) : avoidZ + (d / 2 + 4);
    const tag = { airport: 'home' };
    const part = (geometry, color, outline = 0.06) => {
      const mesh = new THREE.Mesh(geometry, toonMaterial(color)); mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData = { ...tag, occluder: true }; if (outline) addOutline(mesh, { thickness: outline }); this.group.add(mesh); return mesh;
    };
    // Land: the island's own layers, so the airfield reads as part of it.
    part(placed(rbox(w, 1.0, d, 1.2, 3), { x: cx, y: -0.5, z: cz }), PALETTE.grass, 0.07);
    part(placed(rbox(w - 0.8, 2.4, d - 0.8, 1, 2), { x: cx, y: -2.0, z: cz }), PALETTE.dirt, 0.06);
    part(placed(rbox(w * 0.55, 2.2, d * 0.55, 0.8, 2), { x: cx + 0.6, y: -4.2, z: cz }), PALETTE.stone, 0.05);
    part(box(4.2, 0.05, 7, { x: x0 + 3, y: 0.02, z: cz + 2.5 }), APRON, 0);
    const rx = x0 + w * 0.68;
    airportParts(this.group, tag, {
      runway: { cx: rx, cz, length: d - 2, width: 2.6, y: 0.03 }, along: 'z',
      terminal: { x: x0 + 2.4, z: cz - 3.6, w: 3.2, d: 4.6, face: { x: 1, z: 0 } },
      tower: { x: x0 + 2.0, z: cz + 8.2 }, sock: { x: x0 + w - 1.1, z: cz - d / 2 + 2.2 },
    });
    const start = { x: rx, z: cz + d / 2 - 2 }, end = { x: rx, z: cz - d / 2 + 2 };
    // gate: on the outer ring road's island-side sidewalk, opposite the apron (walkers leave the streets there).
    this.strip = { land: { start, end }, depart: { start, end }, apron: { x: x0 + 3.2, z: cz + 2.2 }, gate: { x: half - 3.55, z: cz + 2.2 } };
    this.parked = makePlane('#8e7bff');
    this.parked.position.set(x0 + 3.4, 0.05, cz + 4.6); this.parked.rotation.y = Math.PI / 2;
    this.parked.traverse(m => { if (m.isMesh) m.userData = { ...m.userData, ...tag }; });
    this.group.add(this.parked);
  }
  pickables() { return this.group.visible ? this.group.children.flatMap(c => (c.isMesh ? [c] : c.children.filter(m => m.isMesh))) : []; }
  setVisible(on) { this.group.visible = Boolean(on); }
  clear() { for (const child of [...this.group.children]) { child.removeFromParent(); if (child !== this.parked) disposeAll(child); } this.strip = null; this.parked = null; }
  dispose() { this.clear(); this.group.removeFromParent(); }
}

/** An account island's airstrip along its edge nearest home (side: +1 east of home, -1 west).
 * Arrivals land heading away from home; departures take off heading home. */
export function airstrip(group, spot, tag) {
  const size = spot.half * 2, length = Math.min(size - 4, 24), z = spot.z + spot.half - 2.6;
  const inner = spot.x - spot.side * (spot.half - 2), outer = inner + spot.side * length;
  const cx = (inner + outer) / 2;
  airportParts(group, tag, {
    runway: { cx, cz: z, length, width: 2.4, y: 0.03 }, along: 'x',
    terminal: { x: outer + spot.side * -1.6, z: z - 3.2, w: 2.6, d: 2.4, face: { x: 0, z: 1 } },
    tower: { x: outer - spot.side * 4.2, z: z - 3.4 }, sock: { x: inner + spot.side * 1.2, z: z - 2 },
  });
  const a = { x: inner + spot.side * 1, z }, b = { x: outer - spot.side * 1, z };
  return { land: { start: a, end: b }, depart: { start: b, end: a }, apron: { x: outer - spot.side * 1.6, z: z - 1.6 } };
}

/* ---------- planes ---------- */
const PLANE_GEOMETRY = new Map();
function planeGeometry(key, make) { if (!PLANE_GEOMETRY.has(key)) PLANE_GEOMETRY.set(key, shared(make())); return PLANE_GEOMETRY.get(key); }
/** A little prop plane, nose along +z, about 2.8 long; accent: the provider colour. */
export function makePlane(accent = '#8e7bff') {
  const g = new THREE.Group(); g.name = 'plane';
  const add = (geometry, color, outline = 0.025) => { const m = new THREE.Mesh(geometry, toonMaterial(color)); m.castShadow = true; addOutline(m, { thickness: outline }); g.add(m); return m; };
  add(planeGeometry('body', () => mergeParts([placed(rbox(0.62, 0.62, 2.3, 0.28, 3), { y: 0.62, z: -0.05 }), placed(rbox(0.36, 0.36, 0.7, 0.17, 2), { y: 0.72, z: -1.2 })])), '#fbf8f2');
  add(planeGeometry('trim', () => mergeParts([
    placed(new THREE.ConeGeometry(0.3, 0.42, 12), { y: 0.62, z: 1.28, rx: Math.PI / 2 }),
    box(3.0, 0.07, 0.62, { y: 0.5, z: 0.15 }),
    box(0.07, 0.62, 0.46, { y: 1.05, z: -1.35 }),
    box(1.2, 0.06, 0.34, { y: 0.78, z: -1.4 }),
  ])), accent);
  add(planeGeometry('glass', () => box(0.46, 0.2, 0.42, { y: 0.98, z: 0.42 })), '#5a8fc2', 0.015);
  add(planeGeometry('gear', () => mergeParts([box(0.12, 0.2, 0.2, { x: -0.42, y: 0.16, z: 0.35 }), box(0.12, 0.2, 0.2, { x: 0.42, y: 0.16, z: 0.35 }), box(0.1, 0.16, 0.16, { y: 0.16, z: -1.15 })])), '#3f4458', 0.01);
  const prop = add(planeGeometry('prop', () => mergeParts([box(1.0, 0.1, 0.03), box(0.1, 1.0, 0.03)])), '#3f4458', 0.01);
  prop.position.set(0, 0.62, 1.52);
  g.userData.spin = dt => { prop.rotation.z += dt * 40; };
  return g;
}

/* TRIP-BEGIN (pure: checked headless) */
/** Waypoints of a flight from one strip's apron to another's: taxi out, a take-off roll, a climb, a cruise high over the gap, a descent, touchdown, roll-out and taxi. */
export function flightWaypoints(from, to, ground = 0.05) {
  const dir = (a, b) => { const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1; return { x: dx / l, z: dz / l }; };
  const out = dir(from.depart.start, from.depart.end), into = dir(to.land.start, to.land.end);
  const lift = { x: from.depart.start.x + (from.depart.end.x - from.depart.start.x) * 0.62, z: from.depart.start.z + (from.depart.end.z - from.depart.start.z) * 0.62 };
  const climb = { x: from.depart.end.x + out.x * 7, z: from.depart.end.z + out.z * 7 };
  const approach = { x: to.land.start.x - into.x * 9, z: to.land.start.z - into.z * 9 };
  const gap = Math.hypot(approach.x - climb.x, approach.z - climb.z), cruise = 8 + Math.min(10, gap * 0.08);
  const roll = { x: to.land.start.x + (to.land.end.x - to.land.start.x) * 0.55, z: to.land.start.z + (to.land.end.z - to.land.start.z) * 0.55 };
  return [
    { ...from.apron, y: ground }, { ...from.depart.start, y: ground }, { ...lift, y: ground + 0.05 }, { ...climb, y: ground + 4.5 },
    { x: (climb.x + approach.x) / 2, z: (climb.z + approach.z) / 2, y: ground + cruise },
    { ...approach, y: ground + 4 }, { ...to.land.start, y: ground + 0.05 }, { ...roll, y: ground }, { ...to.apron, y: ground },
  ];
}
/** Seconds a flight takes along a path of this length (slow roll, quick cruise). */
export const flightSeconds = length => Math.max(4, Math.min(11, 2.5 + length / 14));
/* TRIP-END */

/** A smooth path through the waypoints (arc-length parameterised by getPointAt). */
export function flightCurve(points) { return new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p.x, p.y, p.z)), false, 'centripetal'); }
