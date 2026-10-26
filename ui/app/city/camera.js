/* Pure overview and navigation math. Distances are island units; FOV is degrees. */
import { islandHalf } from './layout.js';
export const OVERVIEW_POLAR = 0.82;
export const OVERVIEW_AZIMUTH = 0.62;
export const CAMERA_IDLE_MS = 30_000;
export const OVERVIEW_MARGIN = 0.1;

/** Fit every corner of an island-aligned box inside the perspective frustum.
 * The margin reserves about 10% extra space in each projected dimension. Unlike
 * a bounding sphere this keeps a wide viewport useful, while portrait views
 * automatically back out far enough to include both districts. */
export function fitIslandDistance(half, fov, aspect, {
  polar = OVERVIEW_POLAR, azimuth = OVERVIEW_AZIMUTH,
  minY = 0, maxY = 0, targetY = 0, margin = 1.1,
} = {}) {
  if (![half, targetY, minY, maxY].every(Number.isFinite) || half <= 0 || minY > maxY) throw new RangeError('Positive finite island size and ordered height bounds required');
  const points = [];
  for (const x of [-half, half]) for (const z of [-half, half]) for (const height of [minY, maxY]) points.push({ x, y: height - targetY, z });
  return fitCameraPoints(points, fov, aspect, { polar, azimuth, margin, centered: true }).distance;
}

/** Tight point-cloud fit with a translated camera target. A fixed origin wastes
 * space because perspective makes the near island edge larger than its far edge.
 * Offsets are camera-right/up distances, applied to camera and target together.
 * FOV/aspect describe the available rectangle, rather than the full canvas.
 * Use actual slab and building corners, so tall buildings only reserve space
 * where they stand instead of imposing their height across the entire island. */
export function fitCameraPoints(points, fov, aspect, {
  polar = OVERVIEW_POLAR, azimuth = OVERVIEW_AZIMUTH,
  margin = 1.07, centered = false,
} = {}) {
  if (!Array.isArray(points) || !points.length ||
    ![fov, aspect, polar, azimuth, margin].every(Number.isFinite) ||
    fov <= 0 || fov >= 180 || aspect <= 0 || margin < 1) {
    throw new RangeError('Finite nonempty points, positive aspect, FOV below 180 and margin at least one required');
  }
  const vertical = Math.tan(fov * Math.PI / 360) / margin, horizontal = vertical * aspect;
  const sp = Math.sin(polar), cp = Math.cos(polar), sa = Math.sin(azimuth), ca = Math.cos(azimuth);
  let rightLower = -Infinity, rightUpper = Infinity, upLower = -Infinity, upUpper = Infinity, near = -Infinity, centeredDistance = 0.25;
  for (const point of points) {
    if (!point || ![point.x, point.y, point.z].every(Number.isFinite)) throw new RangeError('Finite scene points required');
    const { x, y, z } = point;
    const right = x * ca - z * sa;
    const up = -x * cp * sa + y * sp - z * cp * ca;
    const depth = x * sp * sa + y * cp + z * sp * ca;
    rightLower = Math.max(rightLower, right + horizontal * depth);
    rightUpper = Math.min(rightUpper, right - horizontal * depth);
    upLower = Math.max(upLower, up + vertical * depth);
    upUpper = Math.min(upUpper, up - vertical * depth);
    near = Math.max(near, depth + 0.25);
    if (centered) centeredDistance = Math.max(centeredDistance, depth + Math.abs(right) / horizontal, depth + Math.abs(up) / vertical);
  }
  if (centered) return { distance: Math.max(near, centeredDistance), offsetX: 0, offsetY: 0 };
  return {
    distance: Math.max(0.25, near, (rightLower - rightUpper) / (2 * horizontal), (upLower - upUpper) / (2 * vertical)),
    offsetX: (rightLower + rightUpper) / 2,
    offsetY: (upLower + upUpper) / 2,
  };
}

/** Centered model framing, sharing the same frustum solver as the overview.
 * The legacy options express margin as extra space (0.1 means ten percent). */
export function boxFitDistance(size, { fov = 40, aspect = 1, polar = OVERVIEW_POLAR, azimuth = OVERVIEW_AZIMUTH, margin = OVERVIEW_MARGIN } = {}) {
  const half = axis => Math.max(.01, Number(size?.[axis]) || .01) / 2;
  const points = [];
  for (const x of [-half('x'), half('x')]) for (const y of [-half('y'), half('y')]) for (const z of [-half('z'), half('z')]) points.push({ x, y, z });
  return fitCameraPoints(points, Math.max(1, Math.min(175, fov)), Math.max(.01, Number(aspect) || 1), { polar, azimuth, margin: 1 + Math.max(0, margin), centered: true }).distance;
}

/** Compatibility entry point for the original island fit callers. */
export function islandFitDistance({ half, fov = 40, aspect = 1, polar = OVERVIEW_POLAR, azimuth = OVERVIEW_AZIMUTH,
  margin = OVERVIEW_MARGIN, minY = -8, maxY = 40, edge = 4 } = {}) {
  const extent = Math.max(1, Number(half) || 1) + Math.max(0, edge);
  return fitIslandDistance(extent, Math.max(1, Math.min(175, fov)), Math.max(.01, Number(aspect) || 1), { polar, azimuth, margin: 1 + Math.max(0, margin), minY, maxY });
}

/** Convenience wrapper for callers that have an island-aligned bounding box. */
export function fitCameraBox(half, fov, aspect, {
  polar = OVERVIEW_POLAR, azimuth = OVERVIEW_AZIMUTH,
  minY = -13, maxY = 40, margin = 1.07,
} = {}) {
  if (![half, minY, maxY].every(Number.isFinite) || half <= 0 || minY > maxY) {
    throw new RangeError('Finite box bounds and positive island size required');
  }
  const corners = [];
  for (const x of [-half, half]) for (const z of [-half, half]) for (const y of [minY, maxY]) corners.push({ x, y, z });
  return fitCameraPoints(corners, fov, aspect, { polar, azimuth, margin });
}

/** Overhead selection framing: reserve most of the view for neighbouring lots.
 * The caller aims at the building's box center and supplies the visible
 * rectangle's effective FOV/aspect. Street view remains the close-up mode. */
export function buildingFocusDistance({ width, height, depth }, fov, aspect, {
  polar = OVERVIEW_POLAR, azimuth = OVERVIEW_AZIMUTH,
  heightFraction = 0.35, minDistance = 32,
} = {}) {
  if (![width, height, depth, fov, aspect, polar, azimuth, heightFraction, minDistance].every(Number.isFinite) ||
    width <= 0 || height <= 0 || depth <= 0 || fov <= 0 || fov >= 180 || aspect <= 0 ||
    heightFraction <= 0 || heightFraction > 1 || minDistance <= 0) {
    throw new RangeError('Finite positive building dimensions, frustum and distance; height fraction within (0, 1] required');
  }
  const tanV = Math.tan(fov * Math.PI / 360), tanH = tanV * aspect;
  const sp = Math.sin(polar), cp = Math.cos(polar), sa = Math.sin(azimuth), ca = Math.cos(azimuth);
  let distance = minDistance;
  for (const x of [-width / 2, width / 2]) for (const y of [-height / 2, height / 2]) for (const z of [-depth / 2, depth / 2]) {
    const right = x * ca - z * sa;
    const up = -x * cp * sa + y * sp - z * cp * ca;
    const toward = x * sp * sa + y * cp + z * sp * ca;
    distance = Math.max(distance, toward + Math.abs(up) / (tanV * heightFraction), toward + Math.abs(right) / (tanH * 0.85));
  }
  return distance;
}

const rectangle = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });

/** Largest unoccluded axis-aligned rectangle, using only layout-change work.
 * Blockers are clipped to bounds; touching an edge is allowed. For each pair
 * of vertical edges, occupied y intervals leave the maximal free gaps. Equal
 * areas prefer the rectangle closest to the viewport center. No free pixels
 * returns a zero-area rectangle at the center, not an overlapping fallback. */
export function largestFreeRect(bounds, { blockers = [] } = {}) {
  const { left, top, right, bottom } = bounds || {};
  if (![left, top, right, bottom].every(Number.isFinite)) return rectangle(0, 0, 0, 0);
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  if (right <= left || bottom <= top) return rectangle(cx, cy, cx, cy);
  const clipped = [];
  for (const b of blockers) {
    if (!b || ![b.left, b.top, b.right, b.bottom].every(Number.isFinite)) continue;
    const box = rectangle(Math.max(left, b.left), Math.max(top, b.top), Math.min(right, b.right), Math.min(bottom, b.bottom));
    if (box.width > 0 && box.height > 0) clipped.push(box);
  }
  const edges = [...new Set([left, right, ...clipped.flatMap(b => [b.left, b.right])])].sort((a, b) => a - b);
  let best = rectangle(cx, cy, cx, cy), area = 0, centerDistance = Infinity;
  const consider = (x0, y0, x1, y1) => {
    const nextArea = (x1 - x0) * (y1 - y0);
    if (nextArea <= 0 || nextArea < area) return;
    const distance = ((x0 + x1) / 2 - cx) ** 2 + ((y0 + y1) / 2 - cy) ** 2;
    if (nextArea === area && distance >= centerDistance) return;
    best = rectangle(x0, y0, x1, y1); area = nextArea; centerDistance = distance;
  };
  for (let a = 0; a < edges.length - 1; a++) for (let b = a + 1; b < edges.length; b++) {
    const x0 = edges[a], x1 = edges[b];
    const occupied = clipped.filter(box => box.left < x1 && box.right > x0).sort((p, q) => p.top - q.top);
    let y = top;
    for (const box of occupied) {
      if (box.top > y) consider(x0, y, x1, box.top);
      y = Math.max(y, box.bottom);
    }
    if (y < bottom) consider(x0, y, x1, bottom);
  }
  return best;
}

export const cameraZoomLimit = fitDistance => fitDistance * 1.5;
/** Inventory can still be loading while camera gestures are already available. */
export const cameraIslandHalf = half => Number.isFinite(half) && half > 0 ? half : islandHalf(1);
export const panLimit = half => cameraIslandHalf(half) * 1.12;

/** Retain manual and saved temporary views when a new viewport has a nearer fit. */
export function cameraBounds(half, fitDistance, preserveDistance = 0) {
  const pan = panLimit(half);
  const fit = Number.isFinite(fitDistance) && fitDistance > 0 ? fitDistance : pan * 4;
  const held = Number.isFinite(preserveDistance) && preserveDistance > 0 ? preserveDistance : 0;
  const maxDistance = Math.max(cameraZoomLimit(fit), held);
  return { pan, maxDistance, far: Math.max(3000, maxDistance + 2 * Math.SQRT2 * pan + 100) };
}

export function cameraIdle(now, lastMoved, delay = CAMERA_IDLE_MS) {
  if (!Number.isFinite(lastMoved)) return true;
  return Number.isFinite(now) && now >= lastMoved && now - lastMoved >= delay;
}

/** A square includes the corner lots that a radius around the origin cuts off.
 * `out` lets the render loop reuse its scratch vector without allocating. */
export function clampPanTarget(target, half, out = {}) {
  return clampCameraTarget(target, panLimit(half), out);
}

export function clampCameraTarget(target, limit, out = {}) {
  limit = Math.max(0, Number(limit) || 0);
  out.x = Math.max(-limit, Math.min(limit, target.x));
  out.y = target.y;
  out.z = Math.max(-limit, Math.min(limit, target.z));
  return out;
}
