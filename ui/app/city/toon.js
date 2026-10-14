/* Shared "toybox" look for the 3D city and avatars: stepped toon shading plus
 * inverted-hull ink outlines. Original CodaClauda style, built on three.js (MIT). */
import * as THREE from '../../vendor/three/three.module.min.js';

export { THREE };
export const INK = '#1d1830';

let gradient = null;
/** 4-step light ramp shared by every toon material (painted, chunky shading). */
export function gradientMap() {
  if (gradient) return gradient;
  const data = new Uint8Array([70, 70, 70, 255, 140, 140, 140, 255, 205, 205, 205, 255, 255, 255, 255, 255]);
  gradient = new THREE.DataTexture(data, 4, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter; gradient.magFilter = THREE.NearestFilter; gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

const materialCache = new Map();
/** Cached toon material. opts: { emissive, emissiveIntensity, transparent, opacity, map, side, cache=true } */
export function toonMaterial(color, opts = {}) {
  const key = opts.map || opts.cache === false ? null : JSON.stringify([color, opts.emissive, opts.emissiveIntensity, opts.transparent, opts.opacity, opts.side]);
  if (key && materialCache.has(key)) return materialCache.get(key);
  const material = new THREE.MeshToonMaterial({
    color: new THREE.Color(color), gradientMap: gradientMap(), map: opts.map || null,
    emissive: new THREE.Color(opts.emissive || '#000000'), emissiveIntensity: opts.emissiveIntensity ?? 1,
    transparent: !!opts.transparent, opacity: opts.opacity ?? 1, side: opts.side ?? THREE.FrontSide,
  });
  if (key) { material.userData.shared = true; materialCache.set(key, material); }
  return material;
}

const outlineMaterials = new Map();
function outlineMaterial(color) {
  if (!outlineMaterials.has(color)) {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), side: THREE.BackSide });
    m.userData.shared = true; m.userData.outline = true;
    outlineMaterials.set(color, m);
  }
  return outlineMaterials.get(color);
}

/** Adds an inverted-hull outline child to every mesh under `root` (skips sprites/outlines). */
export function addOutline(root, { color = INK, thickness = 0.04 } = {}) {
  const meshes = [];
  root.traverse(node => { if (node.isMesh && !node.userData.outline && !node.userData.noOutline) meshes.push(node); });
  for (const mesh of meshes) {
    const hull = new THREE.Mesh(mesh.geometry, outlineMaterial(color));
    hull.userData.outline = true; hull.raycast = () => {};
    const size = new THREE.Vector3();
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    mesh.geometry.boundingBox.getSize(size);
    // Scale so the hull grows by ~thickness world units regardless of mesh size.
    hull.scale.set(1 + thickness / Math.max(size.x, 1e-3) * 2, 1 + thickness / Math.max(size.y, 1e-3) * 2, 1 + thickness / Math.max(size.z, 1e-3) * 2);
    hull.castShadow = false; hull.receiveShadow = false;
    mesh.add(hull);
  }
  return root;
}

/** Dispose geometries, textures and non-shared materials under `root`. */
export function disposeObject(root) {
  root?.traverse(node => {
    if (node.geometry && !node.geometry.userData?.shared) node.geometry.dispose();
    const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const m of materials) {
      if (m.userData?.shared) continue;
      for (const value of Object.values(m)) if (value?.isTexture && value !== gradient) value.dispose();
      m.dispose();
    }
  });
}

/** Lighten/darken a hex color by amount (-1..1) for painted highlights and trims. */
export function shade(hex, amount) {
  const c = new THREE.Color(hex);
  const hsl = {}; c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.min(1, Math.max(0, hsl.l + amount)));
  return `#${c.getHexString()}`;
}
/** Pastel-ize a color for the toy look. */
export function pastel(hex, amount = 0.35) {
  return `#${new THREE.Color(hex).lerp(new THREE.Color('#ffffff'), amount).getHexString()}`;
}
