/* Original closed river circuit. A boat's forward/up frame follows the water
 * around each island edge; neither hulls nor the water teleport between faces. */
import { riverZ, riverSlope, sampleRiver, WATER_Y } from './river-path.js';

export const RIVER_DECK_Y = -7.2;
const unit = (x, y, z) => { const size = Math.hypot(x, y, z) || 1; return { x: x / size, y: y / size, z: z / size }; };
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

export function createRiverLoop(half, { waterY = WATER_Y, deckY = RIVER_DECK_Y, step = 0.65 } = {}) {
  const edge = Math.max(12, Number(half) || 12), source = sampleRiver(edge, Math.max(0.25, step));
  const samples = []; let distance = 0;
  for (const point of source) {
    const { x, z } = point, previous = samples.at(-1);
    if (previous) distance += Math.hypot(x - previous.x, z - previous.z);
    samples.push({ x, z, distance });
  }
  const radius = (waterY * 2 - deckY) / 2, arcLength = Math.PI * radius;
  return { half: edge, waterY, deckY, radius, arcLength, riverLength: distance,
    length: distance * 2 + arcLength * 2, samples, start: samples[0], end: samples.at(-1),
    joins: [0, distance, distance + arcLength, distance * 2 + arcLength, distance * 2 + arcLength * 2] };
}

function riverPose(loop, distance, underside) {
  const target = Math.max(0, Math.min(loop.riverLength, distance)), points = loop.samples;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const middle = (lo + hi) >> 1; if (points[middle].distance < target) lo = middle; else hi = middle; }
  const a = points[lo], b = points[hi], fraction = (target - a.distance) / (b.distance - a.distance || 1);
  const x = a.x + (b.x - a.x) * fraction, direction = underside ? -1 : 1;
  return { position: { x, y: underside ? loop.deckY - loop.waterY : loop.waterY, z: riverZ(x) },
    forward: unit(direction, 0, riverSlope(x) * direction), up: { x: 0, y: direction, z: 0 },
    section: underside ? 'underside' : 'top' };
}

/** `phase` wraps smoothly. At each seam both position and orientation agree. */
export function riverLoopPose(loop, phase) {
  const wrapped = ((Number(phase) || 0) % 1 + 1) % 1, distance = wrapped * loop.length;
  const { riverLength, arcLength, radius } = loop;
  let pose;
  if (distance <= riverLength) pose = riverPose(loop, distance, false);
  else if (distance >= riverLength + arcLength && distance <= riverLength * 2 + arcLength) {
    pose = riverPose(loop, riverLength * 2 + arcLength - distance, true);
  } else {
    const downstream = distance < riverLength + arcLength, x = (downstream ? loop.end : loop.start).x;
    const tangent = unit(1, 0, riverSlope(x)), start = downstream ? riverLength : riverLength * 2 + arcLength;
    const angle = (distance - start) / radius, sin = Math.sin(angle), cos = Math.cos(angle), sign = downstream ? 1 : -1;
    pose = { position: { x: x + sign * tangent.x * radius * sin, y: loop.deckY / 2 + sign * radius * cos,
      z: riverZ(x) + sign * tangent.z * radius * sin },
      forward: { x: sign * tangent.x * cos, y: -sign * sin, z: sign * tangent.z * cos },
      up: { x: sign * tangent.x * sin, y: sign * cos, z: sign * tangent.z * sin },
      section: downstream ? 'downstream-fall' : 'upstream-fall' };
  }
  pose.right = cross(pose.forward, pose.up); pose.phase = wrapped; return pose;
}

/** Cross-channel frame shared by banks, docks, waves and their attached boats. */
export function riverFrame(x, offset = 0, y = WATER_Y) {
  const forward = unit(1, 0, riverSlope(x)), right = { x: -forward.z, y: 0, z: forward.x };
  return { position: { x: x + right.x * offset, y, z: riverZ(x) + right.z * offset }, forward, up: { x: 0, y: 1, z: 0 }, right };
}
