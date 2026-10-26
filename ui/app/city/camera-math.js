/* Pure perspective framing and owner-camera policy; distances use city units. */
export const CAMERA_IDLE_MS = 30_000;
export const OVERVIEW_MARGIN = 0.1;

/** Fit every corner of a square island volume in the perspective frustum. The
 * depth term matters: the near corners project larger than the far corners. */
export function islandFitDistance({ half, fov = 40, aspect = 1, polar = .82, azimuth = .62,
  margin = OVERVIEW_MARGIN, minY = -8, maxY = 40, edge = 4 } = {}) {
  const extent = Math.max(1, Number(half) || 1) + Math.max(0, edge);
  return fitCorners([-extent, extent], [minY, maxY], [-extent, extent], { fov, aspect, polar, azimuth, margin });
}

/** A centered rendered-object box. Size contains full x/y/z dimensions. */
export function boxFitDistance(size, { fov = 40, aspect = 1, polar = .82, azimuth = .62, margin = .1 } = {}) {
  const half = axis => Math.max(.01, Number(size?.[axis]) || .01) / 2;
  return fitCorners([-half('x'), half('x')], [-half('y'), half('y')], [-half('z'), half('z')], { fov, aspect, polar, azimuth, margin });
}

function fitCorners(xs, ys, zs, { fov, aspect, polar, azimuth, margin }) {
  const tanY = Math.tan(Math.max(1, Math.min(175, fov)) * Math.PI / 360);
  const tanX = tanY * Math.max(.01, Number(aspect) || 1), pad = 1 + Math.max(0, margin);
  const sp = Math.sin(polar), cp = Math.cos(polar), st = Math.sin(azimuth), ct = Math.cos(azimuth);
  let distance = 0;
  for (const x of xs) for (const y of ys) for (const z of zs) {
    const depth = x * sp * st + y * cp + z * sp * ct;
    const right = x * ct - z * st, up = -x * cp * st + y * sp - z * cp * ct;
    distance = Math.max(distance, depth + pad * Math.abs(right) / tanX, depth + pad * Math.abs(up) / tanY);
  }
  return distance;
}

export function cameraBounds(half, fitDistance, preserveDistance = 0) {
  const extent = Math.max(1, Number(half) || 1), fit = Math.max(1, Number(fitDistance) || 1);
  const pan = extent + Math.max(4, extent * .1);
  const maxDistance = Math.max(70 + extent * 1.9, fit * 1.3, Number(preserveDistance) || 0);
  return { pan, maxDistance, far: Math.max(3000, maxDistance + 2 * Math.SQRT2 * pan + 100) };
}

/** Clamp in island space, independently per axis; square corner lots stay reachable. */
export function clampCameraTarget(target, limit) {
  const bound = Math.max(0, Number(limit) || 0);
  return { x: Math.max(-bound, Math.min(bound, target.x)), y: target.y, z: Math.max(-bound, Math.min(bound, target.z)) };
}

export function cameraIdle(now, lastMoved, delay = CAMERA_IDLE_MS) {
  if (!Number.isFinite(lastMoved)) return true;
  return Number.isFinite(now) && now >= lastMoved && now - lastMoved >= delay;
}
