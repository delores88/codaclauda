/* River-aware walking. Dry routes stay unchanged; blocked segments use the
 * existing street grid, whose supported edges include bridges in both axes. */
import { riverContains, riverFootprintClear, riverSide, riverBankPoint, bridgeAt, bridgeHeight, bridgeSpan, bridgeCrossings, RIVER_BANK_WIDTH, RIVER_GRID_PITCH } from './river-path.js';

export function riverWalkable(x, z, crossings = null) {
  const bridge = bridgeAt(x, z, crossings);
  if (bridge) {
    const across = bridge.axis === 'x' ? Math.abs(z - bridge.z) : Math.abs(x - bridge.x);
    if (across <= bridge.halfWidth - 0.25) return true;
    if (Array.isArray(crossings) && crossings.some(c => {
      const b = bridgeSpan(c);
      return b && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && (b.axis === 'x' ? Math.abs(z - b.z) : Math.abs(x - b.x)) <= b.halfWidth - 0.25;
    })) return true;
  }
  return !riverContains(x, z, RIVER_BANK_WIDTH + 0.25);
}
export function riverSegmentWalkable(a, b, crossings = null) {
  if (Array.isArray(crossings)) {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z);
    const touchesBridge = crossings.some(c => { const span = bridgeSpan(c); return span && x1 >= span.x0 && x0 <= span.x1 && z1 >= span.z0 && z0 <= span.z1; });
    if (!touchesBridge && riverFootprintClear((x0 + x1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (z1 - z0) / 2, RIVER_BANK_WIDTH + 0.25)) return true;
  }
  const distance = Math.hypot(b.x - a.x, b.z - a.z), count = Math.max(1, Math.ceil(distance / 0.25)), step = distance / count;
  let previousY = bridgeHeight(a.x, a.z, crossings) ?? 0.2;
  for (let i = 0; i <= count; i++) {
    const x = a.x + (b.x - a.x) * i / count, z = a.z + (b.z - a.z) * i / count;
    if (!riverWalkable(x, z, crossings)) return false;
    const y = bridgeHeight(x, z, crossings) ?? 0.2;
    if (Math.abs(y - previousY) > step * 0.65 + 0.08) return false;
    previousY = y;
  }
  return true;
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const graphCache = new Map();
function navigationGraph(half, crossings) {
  const signature = JSON.stringify([half, crossings.map(b => [b.id, b.axis, b.x, b.z, b.min, b.max])]);
  if (graphCache.has(signature)) return graphCache.get(signature);
  const first = Math.ceil((-half + 0.5) / RIVER_GRID_PITCH - 0.5), last = Math.floor((half - 0.5) / RIVER_GRID_PITCH - 0.5);
  const nodes = [], byCell = new Map();
  for (let i = first; i <= last; i++) for (let j = first; j <= last; j++) {
    const point = { x: (i + 0.5) * RIVER_GRID_PITCH, z: (j + 0.5) * RIVER_GRID_PITCH };
    if (!riverWalkable(point.x, point.z, crossings)) continue;
    byCell.set(`${i},${j}`, nodes.length); nodes.push({ ...point, i, j, edges: [] });
  }
  nodes.forEach((node, index) => {
    for (const [i, j] of [[node.i + 1, node.j], [node.i, node.j + 1]]) {
      const other = byCell.get(`${i},${j}`);
      if (other === undefined || !riverSegmentWalkable(node, nodes[other], crossings)) continue;
      node.edges.push({ index: other, cost: RIVER_GRID_PITCH }); nodes[other].edges.push({ index, cost: RIVER_GRID_PITCH });
    }
  });
  const graph = { nodes, crossings, half };
  if (graphCache.size >= 6) graphCache.delete(graphCache.keys().next().value);
  graphCache.set(signature, graph); return graph;
}
function connect(point, graph) {
  const ordered = graph.nodes.map((node, index) => ({ index, cost: distance(point, node) })).sort((a, b) => a.cost - b.cost);
  const connections = [];
  for (const edge of ordered.slice(0, 48)) {
    if (riverSegmentWalkable(point, graph.nodes[edge.index], graph.crossings)) connections.push(edge);
    if (connections.length >= 8) break;
  }
  return connections;
}
function push(heap, value) {
  let index = heap.length; heap.push(value);
  while (index > 0) { const parent = (index - 1) >> 1; if (heap[parent].score <= value.score) break; heap[index] = heap[parent]; index = parent; }
  heap[index] = value;
}
function pop(heap) {
  const first = heap[0], last = heap.pop();
  if (!heap.length) return first;
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    let child = index * 2 + 1;
    if (child + 1 < heap.length && heap[child + 1].score < heap[child].score) child++;
    if (heap[child].score >= last.score) break;
    heap[index] = heap[child]; index = child;
  }
  heap[index] = last; return first;
}
function supportedRoute(from, target, graph) {
  const start = connect(from, graph), finish = new Map(connect(target, graph).map(edge => [edge.index, edge.cost]));
  if (!start.length || !finish.size) return null;
  const costs = new Map(), previous = new Map(), heap = [];
  for (const edge of start) { costs.set(edge.index, edge.cost); previous.set(edge.index, -1); push(heap, { index: edge.index, cost: edge.cost, score: edge.cost + distance(graph.nodes[edge.index], target) }); }
  let best = null, bestCost = Infinity;
  while (heap.length) {
    const current = pop(heap);
    if (current.cost !== costs.get(current.index) || current.score >= bestCost) continue;
    if (finish.has(current.index)) { const total = current.cost + finish.get(current.index); if (total < bestCost) { bestCost = total; best = current.index; } }
    for (const edge of graph.nodes[current.index].edges) {
      const cost = current.cost + edge.cost;
      if (cost >= (costs.get(edge.index) ?? Infinity)) continue;
      costs.set(edge.index, cost); previous.set(edge.index, current.index);
      push(heap, { index: edge.index, cost, score: cost + distance(graph.nodes[edge.index], target) });
    }
  }
  if (best === null) return null;
  const route = [{ x: target.x, z: target.z }];
  for (let index = best; index !== -1; index = previous.get(index)) route.push({ x: graph.nodes[index].x, z: graph.nodes[index].z });
  route.reverse();
  // Remove unnecessary street corners only when the complete shortcut is supported.
  const compact = []; let anchor = from;
  for (let index = 0; index < route.length;) {
    let end = route.length - 1;
    while (end > index && !riverSegmentWalkable(anchor, route[end], graph.crossings)) end--;
    compact.push(route[end]); anchor = route[end]; index = end + 1;
  }
  return compact;
}
function effectiveGeometry(from, points, crossings) {
  const supplied = Array.isArray(crossings) ? crossings.map(bridgeSpan).filter(Boolean) : null;
  const explicitHalf = supplied?.find(span => Number.isFinite(span.islandHalf))?.islandHalf;
  const extent = Math.max(16, ...[from, ...points].flatMap(p => [Math.abs(p.x), Math.abs(p.z)]), ...(supplied || []).flatMap(b => [Math.abs(b.x0), Math.abs(b.x1), Math.abs(b.z0), Math.abs(b.z1)]));
  const half = explicitHalf || Math.ceil((extent + RIVER_GRID_PITCH) / RIVER_GRID_PITCH) * RIVER_GRID_PITCH;
  return { half, crossings: supplied || bridgeCrossings(half) };
}
/** Valid endpoints are preserved. Water targets clamp to a bank; an unreachable
 * target leaves the walker at its last supported point rather than crossing water. */
export function riverRoute(from, points, crossings = null) {
  if (!points.length) return [];
  const geometry = effectiveGeometry(from, points, crossings), bridges = geometry.crossings;
  const onIsland = p => Math.abs(p.x) <= geometry.half - 0.5 && Math.abs(p.z) <= geometry.half - 0.5;
  const goals = points.slice(0, -1).filter(p => onIsland(p) && riverWalkable(p.x, p.z, bridges));
  const last = points.at(-1), side = !bridges.length ? riverSide(from.x, from.z) : riverSide(last.x, last.z);
  const target = riverWalkable(last.x, last.z, bridges) && (bridges.length || side === riverSide(last.x, last.z)) ? last : riverBankPoint(last.x, side);
  // At a river outlet the nearest bank can lie beyond the island rim. Keep the
  // last supported waypoint instead of connecting a dry but unsupported shore.
  if (onIsland(target)) goals.push(target);
  const output = []; let at = { x: from.x, z: from.z }, graph;
  for (const goal of goals) {
    if (riverSegmentWalkable(at, goal, bridges)) { output.push({ x: goal.x, z: goal.z }); at = goal; continue; }
    graph ||= navigationGraph(geometry.half, bridges);
    const route = supportedRoute(at, goal, graph);
    if (route) { output.push(...route); at = route.at(-1); }
  }
  if (!output.length) return [{ x: from.x, z: from.z }];
  return output.filter((point, index) => index === 0 || distance(point, output[index - 1]) > 0.01);
}
/** Axis sliding prevents street controls and crowd separation entering water. */
export function riverStep(from, to, crossings = null) {
  if (riverSegmentWalkable(from, to, crossings)) return to;
  const xOnly = { x: to.x, z: from.z };
  if (riverSegmentWalkable(from, xOnly, crossings)) return xOnly;
  const zOnly = { x: from.x, z: to.z };
  return riverSegmentWalkable(from, zOnly, crossings) ? zOnly : { x: from.x, z: from.z };
}
