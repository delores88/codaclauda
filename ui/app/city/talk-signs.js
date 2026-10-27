import { THREE } from './toon.js';
import { layoutTalkBubbles } from './talk-bubbles.js';

/** Include text independently of obstruction materials: tickers do not write depth.
 * Explicit texture metadata avoids mistaking canvas glows, clocks or faces for labels. */
export function talkTextBounds(root) {
  const boxes = [];
  root?.updateWorldMatrix(true, true);
  root?.traverseVisible(mesh => {
    if (!mesh.isMesh || mesh.userData.outline) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (materials.some(m => m?.visible !== false && m?.opacity > .01
      && (m?.map?.userData.cityText || mesh.userData.mountedLabel))) boxes.push({ box: new THREE.Box3().setFromObject(mesh), mesh });
  });
  return boxes;
}

/** Compare placement, solid walls, text clutter, then temporary scenery cutaways. */
export function betterTalkComposition(rank, best) {
  if (!best) return true;
  const index = rank.findIndex((value, i) => value !== best[i]);
  return index >= 0 && rank[index] < best[index];
}

/** Reserve both full head silhouettes and the maximum speech band, including tails.
 * Foreground text stays in the obstruction checks; this scores background clutter. */
export function talkSignOverlap(shot, heads, signs, { vfov = 40, aspect = 1.6,
  width = 1600, height = width / aspect, vis = { x0: 0, y0: 0, x1: width, y1: height },
  tops = heads.map(head => head.clone().add(new THREE.Vector3(0, .5, 0))), occluders = [] } = {}) {
  if (!signs.length) return 0;
  const camera = new THREE.PerspectiveCamera(vfov, aspect, .05, 10000);
  camera.position.copy(shot.eye); camera.lookAt(shot.look); camera.updateMatrixWorld(true);
  const direction = camera.getWorldDirection(new THREE.Vector3());
  const ray = new THREE.Raycaster();
  const visibleText = (sign, overlap) => {
    if (!sign.mesh) return true; // Plain bounds also support source-only composition checks.
    // Probe the actual overlapping text surface. A far plaque hidden by a wall
    // must not outweigh the readable board immediately behind a speaker.
    for (const fx of [.5, .15, .85]) for (const fy of [.5, .15, .85]) {
      const x = overlap.x0 + (overlap.x1 - overlap.x0) * fx, y = overlap.y0 + (overlap.y1 - overlap.y0) * fy;
      ray.setFromCamera(new THREE.Vector2(x / width * 2 - 1, 1 - y / height * 2), camera);
      ray.near = .05; ray.far = Infinity;
      const textHits = [];
      THREE.Mesh.prototype.raycast.call(sign.mesh, ray, textHits);
      if (!textHits.length) continue;
      ray.far = Math.min(...textHits.map(hit => hit.distance)) - .02;
      let blocked = false;
      for (const mesh of occluders) {
        if (mesh === sign.mesh) continue;
        const hits = [];
        (mesh.isInstancedMesh ? THREE.InstancedMesh.prototype.raycast : THREE.Mesh.prototype.raycast).call(mesh, ray, hits);
        if (hits.length) { blocked = true; break; }
      }
      if (!blocked) return true;
    }
    return false;
  };
  const project = point => {
    const p = point.clone().project(camera);
    return { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2, z: p.z };
  };
  const bounds = box => {
    const points = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      points.push(project(new THREE.Vector3(x, y, z)));
    }
    if (!points.some(p => p.z > -1 && p.z < 1)) return null;
    return { x0: Math.min(...points.map(p => p.x)), x1: Math.max(...points.map(p => p.x)),
      y0: Math.min(...points.map(p => p.y)), y1: Math.max(...points.map(p => p.y)),
      depth: box.getCenter(new THREE.Vector3()).sub(camera.position).dot(direction) };
  };
  const faces = heads.map(head => bounds(new THREE.Box3().setFromCenterAndSize(head, new THREE.Vector3(1.2, 1.2, 1.2))));
  const headTop = Math.min(...tops.flatMap(top => [-.5, .5].flatMap(x => [-.5, .5].map(z => project(top.clone().add(new THREE.Vector3(x, 0, z))).y))));
  const bubbleWidth = Math.max(80, Math.min(280, (vis.x1 - vis.x0 - 28) / 2));
  const bubbles = layoutTalkBubbles(tops.map((top, i) => ({ ...project(top), i, w: bubbleWidth, h: 76 })), vis, headTop);
  const zones = faces.map((face, i) => {
    if (!face) return null;
    const bubble = bubbles.find(b => b.i === i);
    return { ...face, x0: Math.min(face.x0, bubble.x - bubble.w / 2) - 12,
      x1: Math.max(face.x1, bubble.x + bubble.w / 2) + 12,
      y0: Math.min(face.y0, bubble.y - bubble.h) - 12, y1: face.y1 + 12 };
  }).filter(Boolean);
  return signs.reduce((score, sign) => {
    const rect = bounds(sign.box || sign);
    if (!rect) return score;
    for (const zone of zones) {
      if (rect.depth <= zone.depth) continue;
      const intersection = { x0: Math.max(rect.x0, zone.x0), x1: Math.min(rect.x1, zone.x1),
        y0: Math.max(rect.y0, zone.y0), y1: Math.min(rect.y1, zone.y1) };
      const overlap = Math.max(0, intersection.x1 - intersection.x0) * Math.max(0, intersection.y1 - intersection.y0);
      // Count contacts first, then prefer the less cluttered option when neither is clear.
      if (overlap && visibleText(sign, intersection)) score += 1 + overlap / ((zone.x1 - zone.x0) * (zone.y1 - zone.y0));
    }
    return score;
  }, 0);
}
