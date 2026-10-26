/* Original Downtown pocket parks. Static toy geometry, batched across vacant lots.
 * No timers, textures, point lights or picking: the City's ground picker owns clicks. */
import { THREE, toonMaterial, addOutline } from './toon.js';
import { mergeParts, placed } from './fx.js';
import { hash } from '../avatar/spec.js';

export const PARK_TYPES = ['green-square', 'cafe-plaza', 'sports-court', 'playground', 'community-garden', 'sculpture-lawn'];
const Y = 0.18, EDGE = 5.5;
const C = { lawn: '#8aca70', grass: '#5b9f66', leaf: '#397854', stone: '#f1e6ce', wood: '#b77c4e', metal: '#424b61', pink: '#f4a6c1', yellow: '#ffd36b', white: '#fff6e7' };

/** Disjoint checkerboard pools guarantee different edge neighbours, even when
 * an occupied lot becomes vacant or the city expands. Hash picks within each pool. */
export function parkPlan(i, j) {
  const seed = hash(`park:${i},${j}`);
  const variant = ((i + j) % 2 + 2) % 2 * 3 + seed % 3;
  return { i, j, seed, variant, type: PARK_TYPES[variant] };
}

/** A single vertex-colour solid batch plus one ink batch for the entire district.
 * Expand each local shape before merging so outlines never inflate whole blocks. */
function batches(group) {
  const solids = [], ink = [], lamps = [], bulbs = [], glass = [];
  const add = (geometry, tint, at = {}, outline = true, list = solids) => {
    const g = placed(geometry, at);
    if (outline) {
      const temporary = new THREE.Mesh(g, toonMaterial(tint));
      addOutline(temporary, { thickness: 0.025 });
      const hull = temporary.children[0]; hull.updateMatrix();
      ink.push(g.clone().applyMatrix4(hull.matrix));
    }
    if (list === solids) {
      const color = new THREE.Color(tint), data = new Float32Array(g.attributes.position.count * 3);
      for (let k = 0; k < data.length; k += 3) { data[k] = color.r; data[k + 1] = color.g; data[k + 2] = color.b; }
      g.setAttribute('color', new THREE.BufferAttribute(data, 3));
    }
    list.push(g);
  };
  const finish = (lamp) => {
    // mergeParts intentionally discards colours; restore the flattened stream.
    const colors = [];
    for (const g of solids) {
      const attr = g.attributes.color;
      if (g.index) for (let n = 0; n < g.index.count; n++) { const k = g.index.getX(n); colors.push(attr.getX(k), attr.getY(k), attr.getZ(k)); }
      else colors.push(...attr.array);
    }
    const material = toonMaterial('#ffffff', { cache: false }); material.vertexColors = true;
    const attach = (parts, mat, name, shadows = false) => {
      if (!parts.length) return null;
      const mesh = new THREE.Mesh(mergeParts(parts), mat); mesh.name = name;
      mesh.castShadow = shadows; mesh.receiveShadow = shadows; mesh.raycast = () => {};
      group.add(mesh); return mesh;
    };
    const solid = attach(solids, material, 'park-solids', true);
    solid.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const inkMaterial = new THREE.MeshBasicMaterial({ color: '#1d1830', side: THREE.BackSide });
    attach(ink, inkMaterial, 'park-outlines');
    attach(lamps, lamp, 'park-lamps');
    if (glass.length) attach(glass, toonMaterial('#b9e6d0', { transparent: true, opacity: 0.36, cache: false, side: THREE.DoubleSide }), 'park-greenhouse-glass');
    if (bulbs.length) {
      const bulbMaterial = toonMaterial(C.white, { emissive: '#ffcf6b', emissiveIntensity: 0, cache: false });
      const lights = attach(bulbs, bulbMaterial, 'park-string-lights');
      // Read the actual renderer quality and shared day/night lamp value at draw
      // time: live quality changes need no rebuild and never animate the park.
      lights.onBeforeRender = renderer => { bulbMaterial.emissiveIntensity = renderer.shadowMap.enabled ? Math.max(0, lamp.emissiveIntensity - 0.1) : 0; };
    }
  };
  return { add, finish, lamps, bulbs, glass, parts: [solids, ink, lamps, bulbs, glass] };
}

function park(b, lot) {
  const { x, z } = lot, plan = parkPlan(lot.i, lot.j);
  const box = (w, h, d, color, px, py, pz, ry = 0, outline = true) => b.add(new THREE.BoxGeometry(w, h, d), color, { x: x + px, y: Y + py, z: z + pz, ry }, outline);
  const cyl = (r, rb, h, color, px, py, pz, n = 10, list, outline = true) => b.add(new THREE.CylinderGeometry(r, rb, h, n), color, { x: x + px, y: Y + py, z: z + pz }, outline, list);
  const ball = (r, color, px, py, pz, sx = 1, sy = 1, sz = 1, list, outline = true) => b.add(new THREE.IcosahedronGeometry(r, 1), color, { x: x + px, y: Y + py, z: z + pz, sx, sy, sz }, outline, list);
  const bar = (a, end, radius, color = C.metal) => {
    const start = new THREE.Vector3(...a), finish = new THREE.Vector3(...end), delta = finish.clone().sub(start);
    const geometry = new THREE.CylinderGeometry(radius, radius, delta.length(), 6);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()));
    const mid = start.add(finish).multiplyScalar(0.5);
    b.add(geometry, color, { x: x + mid.x, y: Y + mid.y, z: z + mid.z });
  };
  const tree = (px, pz, column = false) => {
    cyl(0.12, 0.19, 1.7, C.wood, px, 0.85, pz);
    ball(column ? 0.6 : 0.95, C.leaf, px, column ? 2.35 : 2.05, pz, 1, column ? 2.3 : 1, 1);
    if (!column) ball(0.65, C.grass, px + 0.22, 2.4, pz - 0.12);
  };
  const bench = (px, pz, ry = 0) => {
    const part = (w, h, d, color, dx, py, dz) => box(w, h, d, color, px + dx * Math.cos(ry) + dz * Math.sin(ry), py - 0.04, pz - dx * Math.sin(ry) + dz * Math.cos(ry), ry);
    part(1.7, 0.12, 0.55, C.wood, 0, 0.46, 0); part(1.7, 0.38, 0.1, C.wood, 0, 0.76, -0.25);
    for (const dx of [-0.65, 0.65]) part(0.12, 0.4, 0.42, C.metal, dx, 0.2, 0);
  };
  const shrub = (px, pz, color) => {
    box(1.2, 0.36, 1.15, C.stone, px, 0.18, pz);
    ball(0.58, C.grass, px, 0.59, pz, 1, 0.66, 1);
    for (const [dx, dz] of [[-0.3, 0.14], [0.25, 0.25], [0, -0.24]]) ball(0.15, color, px + dx, 0.93, pz + dz, 1, 0.7, 1, undefined, false);
  };
  const path = (w, d, px = 0, pz = 0) => box(w, 0.035, d, C.stone, px, 0.036, pz, 0, false);
  // A lawn covers the old concrete pad; the cafe also plants its paved interior.
  // Coverage tests include furniture and the uncovered edge of the entire lot.
  box(EDGE * 2, 0.06, EDGE * 2, C.lawn, 0, -0.005, 0, 0, false);
  // Keep the established NPC bench in its exact seat coordinates and ground height.
  // Empty Downtown NPCs may sit here; extra fountain seats face inward.
  const seatStarts = b.parts.map(parts => parts.length);
  bench(4, 4.85);
  b.parts.forEach((parts, n) => { for (let k = seatStarts[n]; k < parts.length; k++) parts[k].userData.fixedParkSeat = true; });
  const lampSpots = [[-4.85, 3.2], [4.85, -3.2]];
  for (const [px, pz] of lampSpots) {
    path(0.7, 1.8, px, pz);
    cyl(0.065, 0.1, 2.15, C.metal, px, 1.075, pz);
    cyl(0.3, 0.3, 0.08, C.metal, px, 2.4, pz);
    ball(0.23, C.white, px, 2.23, pz, 1, 1, 1, b.lamps, false);
  }
  if (plan.variant === 0) {
    path(0.8, 11); path(11, 0.8);
    // Four formal lawn quadrants with planting rows and an inward-facing bench pair.
    for (const px of [-4.1, 4.1]) for (const pz of [-3.6, -1.8, 1.8]) tree(px, pz, true);
    cyl(1.3, 1.4, 0.3, C.stone, 0, 0.2, 0, 20);
    cyl(1.12, 1.12, 0.04, '#79d9ea', 0, 0.37, 0, 20, undefined, false);
    cyl(0.14, 0.22, 0.85, C.stone, 0, 0.73, 0);
    cyl(0.65, 0.28, 0.22, C.stone, 0, 1.2, 0, 16);
    cyl(0.55, 0.55, 0.035, '#79d9ea', 0, 1.32, 0, 16, undefined, false);
    for (const dx of [-0.48, 0.48]) cyl(0.04, 0.06, 0.9, '#79d9ea', dx, 0.85, 0, 6, undefined, false);
    bench(0, 3.1, Math.PI); bench(-2.8, 0, Math.PI / 2);
  } else if (plan.variant === 1) {
    box(5.6, 0.035, 6, '#dfb989', -0.4, 0.036, 0, 0, false);
    for (const [px, pz] of [[-2.1, -1.5], [1.15, -1.5], [-2.1, 1.6], [1.15, 1.6]]) {
      cyl(0.55, 0.55, 0.12, C.wood, px, 0.95, pz); cyl(0.06, 0.09, 0.9, C.metal, px, 0.45, pz);
      for (const dx of [-0.85, 0.85]) { box(0.45, 0.12, 0.48, C.white, px + dx, 0.52, pz); cyl(0.06, 0.09, 0.47, C.metal, px + dx, 0.235, pz); }
      cyl(0.045, 0.045, 2.4, C.wood, px, 1.2, pz);
      for (let wedge = 0; wedge < 8; wedge++) b.add(new THREE.ConeGeometry(1.05, 0.48, 1, 1, false, wedge * Math.PI / 4, Math.PI / 4), wedge % 2 ? C.white : '#e8735a', { x: x + px, y: Y + 2.45, z: z + pz }, false);
    }
    box(1.8, 1.8, 1.4, '#729b7a', 2.85, 0.9, -3.65); box(2.1, 0.2, 1.8, C.wood, 2.85, 1.95, -3.65);
    box(1.25, 0.8, 0.04, '#30384c', 2.85, 1.05, -2.93, 0, false); box(1.45, 0.12, 0.4, C.stone, 2.85, 0.62, -2.8);
    for (const [px, pz, color] of [[-2.1, 0, C.pink], [1.15, 0, C.yellow], [-0.45, -2.65, C.pink], [-0.45, 2.65, C.yellow]]) shrub(px, pz, color);
    for (const px of [-3.8, 3.8]) cyl(0.07, 0.1, 3.3, C.wood, px, 1.65, 3.4);
    let last = [-3.8, 3.3, 3.4];
    for (let n = 1; n <= 12; n++) {
      const px = -3.8 + n * 7.6 / 12, py = 3.3 - 0.55 * Math.sin(n / 12 * Math.PI), next = [px, py, 3.4];
      bar(last, next, 0.022); ball(0.09, C.white, px, py - 0.12, 3.4, 1, 1.2, 1, b.bulbs, false); last = next;
    }
  } else if (plan.variant === 2) {
    box(4.6, 0.045, 6.6, '#3fa7a0', 0, 0.045, -0.2, 0, false);
    const line = (w, d, px, pz) => box(w, 0.012, d, C.white, px, 0.074, pz, 0, false);
    for (const px of [-2.12, 2.12]) line(0.065, 6.28, px, -0.2);
    for (const pz of [-3.3, -0.2, 2.9]) line(4.3, 0.065, 0, pz);
    b.add(new THREE.TorusGeometry(0.62, 0.032, 4, 24), C.white, { x, y: Y + 0.075, z: z - 0.2, rx: Math.PI / 2 }, false);
    for (const side of [-1, 1]) {
      const pz = -0.2 + side * 3.42;
      bar([0, 0, pz], [0, 2.3, pz], 0.075); box(1.05, 0.7, 0.08, C.white, 0, 2.3, pz - side * 0.2);
      bar([0, 2.3, pz], [0, 2.3, pz - side * 0.2], 0.055);
      bar([0, 2.1, pz - side * 0.2], [0, 2.1, pz - side * 0.5], 0.04, '#e8735a');
      box(0.45, 0.3, 0.02, C.metal, 0, 2.25, pz - side * 0.25, 0, false);
      b.add(new THREE.TorusGeometry(0.26, 0.045, 5, 12), '#e8735a', { x, y: Y + 2.1, z: z + pz - side * 0.5, rx: Math.PI / 2 });
      for (const px of [-0.21, 0.21]) bar([px, 2.08, pz - side * 0.5], [px * 0.65, 1.7, pz - side * 0.5], 0.018, C.white);
      for (const px of [-0.9, 0.9]) line(0.06, 1.6, px, -0.2 + side * 2.3);
      line(1.8, 0.06, 0, -0.2 + side * 1.5);
    }
    for (let row = 0; row < 2; row++) { box(0.48, 0.14, 2.5, C.wood, 3.1 + row * 0.65, 0.4 + row * 0.4, 0.1); for (const pz of [-0.8, 1]) box(0.12, 0.4 + row * 0.4, 0.12, C.metal, 3.1 + row * 0.65, 0.2 + row * 0.2, pz); }
    tree(-4, -3.6, true); tree(-4, 1.6, true); tree(4, -4, true);
  } else if (plan.variant === 3) {
    box(5.2, 0.05, 4.8, '#e8735a', -0.2, 0.045, 0, 0, false);
    box(1.6, 0.16, 1.6, '#ffd36b', -1.1, 1.45, -0.7);
    for (const px of [-1.75, -0.45]) for (const pz of [-1.35, -0.05]) cyl(0.07, 0.07, 2.3, '#398dcc', px, 1.15, pz);
    b.add(new THREE.ConeGeometry(1.35, 0.8, 4), '#f4ca45', { x: x - 1.1, y: Y + 2.65, z: z - 0.7, ry: Math.PI / 4 });
    for (let n = 0; n < 5; n++) bar([-1.75, 0.25 + n * 0.27, -1.4], [-0.45, 0.25 + n * 0.27, -1.4], 0.045, C.yellow);
    // Sloping chute, raised sides, and a ground-level runout all meet.
    b.add(new THREE.BoxGeometry(1, 0.1, 2.3), '#4b9fd3', { x: x - 1.1, y: Y + 0.77, z: z + 0.95, rx: 0.65 });
    for (const px of [-1.62, -0.58]) bar([px, 1.55, 0.04], [px, 0.18, 1.86], 0.09, '#ffd36b');
    for (const px of [0.8, 2.1]) for (const pz of [-1.7, 0.1]) cyl(0.06, 0.06, 1.8, '#f4ca45', px, 0.9, pz);
    for (let n = 0; n < 5; n++) bar([0.8, 1.8, -1.7 + n * 0.45], [2.1, 1.8, -1.7 + n * 0.45], 0.06, '#398dcc');
    for (const px of [0.8, 2.1]) bar([px, 1.8, -1.7], [px, 1.8, 0.1], 0.06, '#398dcc');
    tree(-3.9, -3.8); tree(3.85, 1.6); path(0.8, 2.7, 0, 4.1);
  } else if (plan.variant === 4) {
    path(0.8, 11);
    for (const px of [-2.4, 2.4]) for (const pz of [-0.7, 2.35]) {
      box(2.7, 0.38, 2, C.wood, px, 0.19, pz); box(2.45, 0.04, 1.75, '#654b3d', px, 0.4, pz, 0, false);
      for (let n = 0; n < 3; n++) for (const dz of [-0.45, 0.4]) {
        const cx = px - 0.85 + n * 0.85;
        ball(0.37, C.grass, cx, 0.62, pz + dz, 1, 0.7, 1);
        ball(0.17, [C.yellow, '#d77255', '#a586c4'][n], cx, 0.89, pz + dz, 1, 1, 1, undefined, false);
      }
    }
    // Transparent panes with a supported ridge and pitched glazing.
    const gx = -2.3, gz = -3.8;
    box(3.1, 0.15, 2.2, C.wood, gx, 0.1, gz);
    for (const px of [-3.75, -0.85]) for (const pz of [-4.8, -2.8]) bar([px, 0.2, pz], [px, 1.85, pz], 0.045, C.white);
    for (const pz of [-4.8, -2.8]) { bar([-3.75, 1.85, pz], [-2.3, 2.55, pz], 0.045, C.white); bar([-2.3, 2.55, pz], [-0.85, 1.85, pz], 0.045, C.white); }
    bar([-2.3, 2.55, -4.8], [-2.3, 2.55, -2.8], 0.045, C.white);
    for (const px of [-3.75, -0.85]) b.add(new THREE.BoxGeometry(0.025, 1.65, 2), C.white, { x: x + px, y: Y + 1.025, z: z + gz }, false, b.glass);
    for (const side of [-1, 1]) b.add(new THREE.BoxGeometry(1.62, 0.025, 2), C.white, { x: x + gx + side * 0.725, y: Y + 2.2, z: z + gz, rz: -side * 0.45 }, false, b.glass);
    for (const px of [-3.2, -1.5]) ball(0.4, C.grass, px, 0.55, gz);
    shrub(3.6, -3.8, C.yellow);
  } else {
    // Two narrow curved paths made from flat ribbons, with lawn between them.
    for (const side of [-1, 1]) {
      const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-5.4, 0, side * 3.8), new THREE.Vector3(-2, 0, side * 2.5), new THREE.Vector3(2, 0, side * 3), new THREE.Vector3(5.4, 0, side * 3.7)]);
      const points = curve.getPoints(20), positions = [];
      for (let n = 0; n < points.length - 1; n++) {
        const a = points[n], d = points[n + 1], normal = d.clone().sub(a).normalize(), nx = -normal.z * 0.35, nz = normal.x * 0.35;
        const v = [[a.x + nx, a.z + nz], [d.x + nx, d.z + nz], [d.x - nx, d.z - nz], [a.x - nx, a.z - nz]];
        for (const k of [0, 1, 2, 0, 2, 3]) positions.push(v[k][0], 0.04, v[k][1]);
      }
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.computeVertexNormals();
      b.add(geometry, C.stone, { x, y: Y, z }, false);
    }
    cyl(1, 1.1, 0.22, C.stone, 0, 0.14, 0, 12);
    b.add(new THREE.TorusKnotGeometry(0.83, 0.21, 36, 6, 2, 3), '#8b7bff', { x, y: Y + 1.53, z, ry: 0.4 });
    cyl(0.13, 0.18, 0.5, '#8b7bff', 0, 0.46, 0);
    for (const [px, pz] of [[-3.7, -0.5], [3.7, 0.9], [-2.3, 4.3], [1.7, -4.3]]) for (let n = 0; n < 5; n++) b.add(new THREE.ConeGeometry(0.12, 0.7 + n % 2 * 0.25, 4), n % 2 ? '#c4b86b' : C.grass, { x: x + px + (n - 2) * 0.16, y: Y + 0.4, z: z + pz + n % 2 * 0.2, rz: (n - 2) * 0.14 }, false);
  }
  return { ...plan, x, z };
}

export function buildDowntownParks(lots, { lampMaterial } = {}) {
  const group = new THREE.Group(); group.name = 'downtown-parks';
  if (!lots.length) return group;
  const b = batches(group);
  group.userData.parks = lots.map(lot => {
    const starts = b.parts.map(parts => parts.length), plan = park(b, lot);
    // A bridge approach may need a little extra lateral clearance. Fit only this
    // park's meshes, keeping its type stable and the road/river geometry untouched.
    if (lot.scaleX && lot.scaleX !== 1) b.parts.forEach((parts, n) => {
      for (let k = starts[n]; k < parts.length; k++) if (!parts[k].userData.fixedParkSeat) parts[k].translate(-lot.x, 0, 0).scale(lot.scaleX, 1, 1).translate(lot.x, 0, 0);
    });
    return { ...plan, scaleX: lot.scaleX || 1 };
  });
  b.finish(lampMaterial || toonMaterial('#fff6dd', { emissive: '#ffcf6b', emissiveIntensity: 0.1, cache: false }));
  return group;
}
