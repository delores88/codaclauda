import { THREE } from './toon.js';

/** Prefer a clear background behind each face. Foreground geometry is handled
 * by the separate obstruction/cutaway checks; this is only a composition score. */
export function talkSignOverlap(shot, heads, signs, { vfov = 40, aspect = 1.6 } = {}) {
  if (!signs.length) return 0;
  const camera = new THREE.PerspectiveCamera(vfov, aspect, .05, 10000);
  camera.position.copy(shot.eye); camera.lookAt(shot.look); camera.updateMatrixWorld(true);
  const direction = camera.getWorldDirection(new THREE.Vector3());
  const bounds = box => {
    const points = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      points.push(new THREE.Vector3(x, y, z).project(camera));
    }
    if (!points.some(p => p.z > -1 && p.z < 1)) return null;
    return { x0: Math.min(...points.map(p => p.x)), x1: Math.max(...points.map(p => p.x)),
      y0: Math.min(...points.map(p => p.y)), y1: Math.max(...points.map(p => p.y)),
      depth: box.getCenter(new THREE.Vector3()).sub(camera.position).dot(direction) };
  };
  const faces = heads.map(head => bounds(new THREE.Box3().setFromCenterAndSize(head, new THREE.Vector3(1, 1, 1)))).filter(Boolean);
  return signs.reduce((score, sign) => {
    const rect = bounds(sign);
    return score + (rect ? faces.filter(face => rect.depth > face.depth && rect.x0 < face.x1 && rect.x1 > face.x0 && rect.y0 < face.y1 && rect.y1 > face.y0).length : 0);
  }, 0);
}
