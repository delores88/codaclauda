/* River-aware walking: keep existing routes where dry, and join the banks via a
 * road bridge when a segment would enter the water. Contributor islands opt out. */
import { riverZ, riverContains, bridgeAt, bridgeSpan, bridgeHeight, BRIDGE_HALF_WIDTH, RIVER_HALF_WIDTH, RIVER_BANK_WIDTH, RIVER_GRID_PITCH } from './river-path.js';

export function riverWalkable(x, z, crossings = null) {
  const bridge = bridgeAt(x, z, crossings);
  if (bridge && Math.abs(x - bridge.x) <= BRIDGE_HALF_WIDTH - 0.25) return true;
  return !riverContains(x, z, RIVER_BANK_WIDTH + 0.25);
}

export function riverSegmentWalkable(a, b, crossings = null) {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.2));
  let previousY = bridgeHeight(a.x, a.z, crossings) ?? 0.2;
  const step = Math.hypot(b.x - a.x, b.z - a.z) / n;
  for (let i = 0; i <= n; i++) {
    const x = a.x + (b.x - a.x) * i / n, z = a.z + (b.z - a.z) * i / n;
    if (!riverWalkable(x, z, crossings)) return false;
    const y = bridgeHeight(x, z, crossings) ?? 0.2;
    if (Math.abs(y - previousY) > step * 0.6 + 0.08) return false; // no lateral jumps through a bridge wall
    previousY = y;
  }
  return true;
}

const sideOf = p => p.z < riverZ(p.x) ? -1 : 1;
const nearestCrossing = x => (Math.round(x / RIVER_GRID_PITCH - 0.5) + 0.5) * RIVER_GRID_PITCH;

function bankPoint(x, side, crossings) {
  let z = riverZ(x) + side * (RIVER_HALF_WIDTH + RIVER_BANK_WIDTH + 0.65);
  // Walk around each approach's foot instead of stepping sideways onto a raised ramp.
  const bx = (crossings || [nearestCrossing(x)]).find(v => Math.abs(v - x) < 5);
  if (bx !== undefined) {
    const span = bridgeSpan(bx), end = side < 0 ? span.minZ - 0.35 : span.maxZ + 0.35;
    const blend = Math.min(1, (5 - Math.abs(x - bx)) / 2.4);
    z += side * Math.max(0, side * (end - z)) * blend;
  }
  return { x, z };
}

function bankRoute(a, b, side, crossings) {
  const n = Math.max(1, Math.ceil(Math.abs(b.x - a.x) / 0.5));
  return Array.from({ length: n + 1 }, (_, i) => bankPoint(a.x + (b.x - a.x) * i / n, side, crossings));
}

/** Unsupported intermediate waypoints are discarded; endpoints are clamped to a
 * bank. Every generated crossing runs along an actual bridge's centerline. */
export function riverRoute(from, points, crossings = null) {
  if (!points.length) return [];
  const last = points.at(-1), target = riverWalkable(last.x, last.z, crossings) ? last : bankPoint(last.x, sideOf(last), crossings);
  const goals = [...points.slice(0, -1).filter(p => riverWalkable(p.x, p.z, crossings)), target];
  const output = []; let a = from;
  for (const b of goals) {
    if (riverSegmentWalkable(a, b, crossings)) output.push({ x: b.x, z: b.z });
    else {
      const sa = sideOf(a), sb = sideOf(b);
      if (sa !== sb && Array.isArray(crossings) && crossings.length === 0) {
        const end = bankPoint(b.x, sa, crossings);
        output.push(...bankRoute(a, end, sa, crossings)); a = end; continue;
      }
      const aBridge = bridgeAt(a.x, a.z, crossings), bBridge = bridgeAt(b.x, b.z, crossings);
      const ap = aBridge ? { x: aBridge.x, z: sa < 0 ? aBridge.minZ - 0.35 : aBridge.maxZ + 0.35 } : a;
      const bp = bBridge ? { x: bBridge.x, z: sb < 0 ? bBridge.minZ - 0.35 : bBridge.maxZ + 0.35 } : b;
      if (aBridge) output.push({ x: a.x, z: ap.z }, ap);
      if (sa === sb) output.push(...bankRoute(ap, bp, sa, crossings));
      else {
        const mid = (ap.x + bp.x) / 2;
        const bx = crossings?.length ? crossings.reduce((best, x) => Math.abs(x - mid) < Math.abs(best - mid) ? x : best) : nearestCrossing(mid);
        const bridge = { x: bx, z: riverZ(bx) };
        output.push(...bankRoute(ap, bridge, sa, crossings), bankPoint(bx, sb, crossings), ...bankRoute(bridge, bp, sb, crossings));
      }
      if (bBridge) output.push(bp, { x: b.x, z: bp.z });
      output.push({ x: b.x, z: b.z });
    }
    a = b;
  }
  return output.filter((p, i) => i === 0 || Math.hypot(p.x - output[i - 1].x, p.z - output[i - 1].z) > 0.01);
}

/** Axis sliding prevents street controls and crowd separation entering the water. */
export function riverStep(from, to, crossings = null) {
  if (riverSegmentWalkable(from, to, crossings)) return to;
  const xOnly = { x: to.x, z: from.z };
  if (riverSegmentWalkable(from, xOnly, crossings)) return xOnly;
  const zOnly = { x: from.x, z: to.z };
  return riverSegmentWalkable(from, zOnly, crossings) ? zOnly : { x: from.x, z: from.z };
}
