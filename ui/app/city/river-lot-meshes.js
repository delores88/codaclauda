/* Opaque, district-coloured architecture and planted dry parcels. Original geometry. */
import { THREE, toonMaterial, addOutline } from './toon.js';
import { placed, mergeParts } from './fx.js';
import { pointInParcel, riverfrontShape, clipPolygon, polygonArea } from './river-lots.js';

const TOP = 0.24;
function box(group, w, h, d, x, y, z, material, name, outline = 0.025) {
  const mesh = new THREE.Mesh(placed(new THREE.BoxGeometry(w, h, d), { x, y, z }), typeof material === 'string' ? toonMaterial(material) : material);
  mesh.name = name; mesh.castShadow = true; mesh.receiveShadow = true;
  if (outline) addOutline(mesh, { thickness: outline });
  group.add(mesh); return mesh;
}

export function riverBuildingPlan(project, parcel, district) {
  const r = parcel.rect, shape = riverfrontShape(r, district), side = parcel.side;
  const origin = { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 };
  const width = r.x1 - r.x0, depth = r.z1 - r.z0;
  const tier = Math.max(1, Math.min(3, Math.round(project.metrics?.footprint || 1)));
  const W = Math.min(width - 0.8, shape === 'slim' || shape === 'townhouse' ? 4 + tier * 0.65 : 6.8 + tier);
  const D = Math.min(depth - 1.6, 4.6 + tier * 0.7);
  const sourceFloors = Math.max(1, Math.min(24, Math.round(project.metrics?.floors || 1)));
  const H = district === 'downtown' ? Math.min(2.6 + (sourceFloors - 1) * 1.3, Math.min(W, D) * 2.4, 18) : shape === 'townhouse' ? 3.8 : 2.2;
  const floors = district === 'downtown' ? Math.max(1, Math.floor((H - 2.6) / 1.3) + 1) : shape === 'townhouse' ? 2 : 1;
  const blocks = shape === 'terraced' ? [0, 1, 2].map(n => ({ w: W, d: D * (1 - n * 0.22), h: H / 3, y: n * H / 3, z: side * D * n * 0.11 })) : [{ w: W, d: D, h: H, y: 0, z: 0 }];
  return { W, D, H, floors, footprint: tier, shape, blocks, origin, side, streetZ: side * (depth / 2 - 0.3), parcel };
}

export function buildRiverBuilding(plan, material, district, tag) {
  const group = new THREE.Group(); group.name = `riverfront-${plan.shape}`;
  const trim = district === 'downtown' ? '#d6e6ef' : '#3d4350';
  for (const b of plan.blocks) {
    box(group, b.w, b.h, b.d, 0, TOP + b.y + b.h / 2, b.z, material, 'riverfront-wall');
    box(group, b.w + 0.08, 0.12, b.d + 0.08, 0, TOP + b.y + b.h, b.z, trim, 'riverfront-roof');
    // Both banks get windows on the water and street facades.
    for (const face of [-1, 1]) for (let x = -b.w / 2 + 0.65; x < b.w / 2 - 0.35; x += 1.15) {
      const height = Math.max(0.5, b.h - 0.55);
      box(group, 0.72, height, 0.05, x, TOP + b.y + b.h / 2, b.z + face * (b.d / 2 + 0.035), '#526f84', 'riverfront-window', 0.01);
      if (district === 'downtown') for (let y = 1.25; y < height; y += 1.3) box(group, 0.74, 0.055, 0.06, x, TOP + b.y + 0.27 + y, b.z + face * (b.d / 2 + 0.04), trim, 'riverfront-mullion', 0);
    }
    if (plan.shape === 'terraced' && b !== plan.blocks.at(-1)) {
      const z = b.z - plan.side * (b.d / 2 - 0.16);
      box(group, b.w * 0.65, 0.2, 0.25, 0, TOP + b.y + b.h + 0.15, z, '#76ac70', 'water-facing-terrace');
    }
  }
  if (plan.shape === 'deck-house') {
    const z = -plan.side * (plan.D / 2 + 0.33);
    box(group, plan.W, 0.12, 0.6, 0, TOP + 0.06, z, '#c89b6d', 'water-facing-deck');
    box(group, plan.W, 0.08, 0.08, 0, TOP + 0.72, z - plan.side * 0.23, '#c89b6d', 'deck-rail');
    for (const x of [-plan.W / 2 + 0.08, 0, plan.W / 2 - 0.08]) box(group, 0.07, 0.65, 0.07, x, TOP + 0.36, z - plan.side * 0.23, '#c89b6d', 'deck-post');
  }
  box(group, 0.85, 1.65, 0.09, 0, TOP + 0.825, plan.side * (plan.D / 2 + 0.06), '#314b61', 'riverfront-door');
  group.traverse(node => { if (node.isMesh) Object.assign(node.userData, tag); });
  return group;
}

/** Every dry polygon gets lawn; small remnants get a path, bench and reeds when
 * those individual footprints fit. Geometry never crosses into the excluded bank. */
export function buildRiverLandscape(parcel, { origin = { x: 0, z: 0 }, building = null } = {}) {
  const group = new THREE.Group(); group.name = 'riverfront-landscape'; group.userData.parcel = parcel;
  for (const polygon of parcel.polygons) {
    // Narrow strips follow the curved edge without long triangles spanning a
    // bend; each rendered triangle's complete footprint clears the bank too.
    const strips = [];
    for (let x = parcel.bounds.x0; x < parcel.bounds.x1; x += 0.5) {
      const piece = clipPolygon(clipPolygon(polygon, 'x', x, true), 'x', Math.min(x + 0.5, parcel.bounds.x1), false);
      if (polygonArea(piece) < 1e-8) continue;
      const shape = new THREE.Shape(piece.map(p => new THREE.Vector2(p.x - origin.x, -(p.z - origin.z))));
      strips.push(new THREE.ShapeGeometry(shape));
    }
    if (!strips.length) continue;
    const geometry = mergeParts(strips); geometry.rotateX(-Math.PI / 2); geometry.translate(0, TOP - 0.04, 0);
    const lawn = new THREE.Mesh(geometry, toonMaterial('#8aca70')); lawn.receiveShadow = true; lawn.name = 'riverfront-lawn'; group.add(lawn);
  }
  const fits = (x, z, hx, hz) => [-1, 1].every(dx => [-1, 1].every(dz => pointInParcel({ x: x + dx * hx, z: z + dz * hz }, parcel)));
  const r = parcel.rect;
  if (r) {
    const x = (r.x0 + r.x1) / 2, z = parcel.side > 0 ? r.z1 - 0.35 : r.z0 + 0.35;
    if (fits(x, z, (r.x1 - r.x0) / 2 - 0.15, 0.24)) box(group, r.x1 - r.x0 - 0.3, 0.04, 0.48, x - origin.x, TOP, z - origin.z, '#f1e6ce', 'riverfront-path', 0);
  }
  let bench = false;
  for (let x = parcel.bounds.x0 + 0.65; x < parcel.bounds.x1 - 0.5; x += 1.1) {
    for (let z = parcel.bounds.z0 + 0.6; z < parcel.bounds.z1 - 0.5; z += 1.05) {
      if (!fits(x, z, 0.5, 0.4)) continue;
      if (building && Math.abs(x - building.origin.x) < building.W / 2 + 0.75 && Math.abs(z - building.origin.z) < building.D / 2 + 0.9) continue;
      if (r && Math.abs(z - (parcel.side > 0 ? r.z1 : r.z0)) < 0.9) continue;
      const lx = x - origin.x, lz = z - origin.z;
      if (!bench) {
        box(group, 0.9, 0.1, 0.45, lx, TOP + 0.4, lz, '#c89b6d', 'riverfront-bench');
        box(group, 0.9, 0.36, 0.08, lx, TOP + 0.62, lz + parcel.side * 0.2, '#c89b6d', 'riverfront-bench-back');
        for (const dx of [-0.3, 0.3]) box(group, 0.08, 0.4, 0.32, lx + dx, TOP + 0.2, lz, '#526a60', 'bench-leg');
        bench = true;
      } else {
        for (const dx of [-0.15, 0.08, 0.22]) box(group, 0.06, 0.4 + dx, 0.06, lx + dx, TOP + (0.4 + dx) / 2, lz, '#6b9e55', 'riverfront-reeds', 0);
      }
    }
  }
  group.traverse(node => { if (node.isMesh) node.raycast = () => {}; });
  return group;
}
