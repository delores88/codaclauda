import { riverLot, pointInParcel } from '../city/river-lots.js';
/* City view: a playful 3D "project city". Every visible project is a building on a
 * floating island; agents walk between them as little people. HTML overlays (labels,
 * tags, bubbles, panels, toolbar) sit on top of the WebGL canvas. */
import { h, icon, iconButton, registerIcons, toast, portrait, timeAgo, fullTime, pill, plural, statusDot, STATUS_LABEL, formatNumber, formatBytes, clear } from '../ui.js';
import { PROVIDER_COLORS, defaultAvatar } from '../avatar/spec.js';
import { THREE } from '../city/toon.js';
import { World, webglAvailable, wheelZoomLog } from '../city/world.js';
import { BuildingManager } from '../city/buildings.js';
import { NpcManager, loadPeople, setPeopleReducedMotion, streetMove } from '../city/npc.js';
import { SlotMap, cellCenter, cellOf, cellKey, LOT_HALF, PITCH } from '../city/layout.js';
import { DOWNTOWN, SUBURBS, districtOf, districtForCell, districtBanks, chooseLargerDistrict, isUnbuilt } from '../city/districts.js';
import { River } from '../city/river.js';
import { buildPlotMarker, GROUND_Y } from '../city/scenery.js';
import { SparkCity, FOUNDRY, DECK_Y, jobLabel } from '../city/spark.js';
import { TalkPanel, talkSpot, sayLine, STAGE } from '../city/talk.js';
import { fitTalkShot, talkVisibleRect, talkFigureTargets, talkWallHits, talkSceneMeshes, talkSceneHits, cutawayTalkMeshes } from '../city/talk-frame.js';
import { layoutTalkBubbles } from '../city/talk-bubbles.js';
import { IslandMode } from '../city/portal.js';
import { CityWeather } from '../city/weather-hud.js';
import { sessions } from '../sessions.js';
import { sessionAgents, externalAgents, SESSION_STATUS_LABEL, PROVIDER_NAME } from '../city/agents-extra.js';
import { openAssignDialog } from '../city/assign.js';
import { CityCi } from '../city/ci.js';
import { tickerBank, tickerSegments } from '../city/ticker.js';
import { buildingStreetBoxes, buildingSolidAt } from '../city/street-collision.js';
import { JumpToPicker } from '../city/jumpto.js';
import { largestFreeRect, buildingFocusDistance, boxFitDistance } from '../city/camera.js';
import { AGENT_PROJECT_PREF, AGENT_PROJECT_TIME_PREF, locateAgents } from '../city/agent-location.js';
import { BuildingSessionActions, offersBuildingSession } from '../city/building-actions.js';
import { buildingTalkCallbacks } from '../city/building-talk.js';

registerIcons({
  'city-pan': '<path d="M12 3v18M3 12h18M8 7l4-4 4 4M8 17l4 4 4-4M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.6 2.4c-.8.4-1.2.9-1.2 1.7v.4M12 17h.01"/>',
  crosshair: '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="1.4"/>',
  cube: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
  'city-chip': '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  'city-laptop': '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M2.5 18.5h19l-1.5-2.5H4Z"/>',
  'city-flip': '<path d="M3 12h18"/><path d="M8 8.5 12 4l4 4.5M8 15.5l4 4.5 4-4.5"/>',
  'city-chevron-up': '<path d="m6 15 6-6 6 6"/>',
  'city-chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'city-street': '<path d="M9.5 3 5 21M14.5 3 19 21"/><path d="M12 5v2.5M12 11v2.5M12 17v3"/>',
  'city-leave': '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  'city-boat': '<path d="M3 14h18l-3 5H6ZM12 3v11M12 4l6 7h-6M3 22l3-1 3 1 3-1 3 1 3-1 3 1"/>',
  'city-van': '<path d="M3 7h11v10H3ZM14 10h4l3 4v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
});

const HELP_KEY = 'codaclauda.city.help-dismissed';
const TIME_MODES = ['auto', 'day', 'night'];
const TIME_LABEL = { auto: 'Auto (your clock)', day: 'Always day', night: 'Always night' };
const PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex', other: 'Agent' };
const MACHINES_KEY = 'codaclauda.city.machines-collapsed';
const LEGEND_STORAGE = 'codaclauda.city.legend-expanded';
const SPARK_KINDS = new Set(['spark', 'runner', 'foundry']);   // targets on the Spark face (everything else is This PC's face)
const PLOT_HOLD_MS = 10 * 60e3;
const EMPTY_MACHINES = { enabled: false, online: false, offlineSince: null, configured: false, error: '', local: { running: 0, cpuReserved: 0, cpuHours24h: 0 }, spark: { running: 0, cpuReserved: 0, cpuHours24h: 0 }, jobs: [] };
/** "Offline since 3:40 PM" (date added when it wasn't today), or "Offline" when unknown. */
function offlineLabel(since) {
  const t = Number(since);
  if (!t) return 'Offline';
  const d = new Date(t), today = d.toDateString() === new Date().toDateString();
  return `Offline since ${today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}
/* Street view: a third-person camera behind your avatar (island units, seconds, radians). */
const STREET = { back: 3.2, min: 2.2, max: 6.5, up: 2.0, look: 1.3, walk: 2.6, backWalk: 1.5, turn: 2.2, drag: 0.006, radius: 0.35 };
const STREET_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
// Solid parts of the HQ plaza (island space): the town hall with its porch, the fountain, the two planters.
// low: below the street camera (it never has to pull in for these).
const HQ_BOXES = [{ x0: -3.5, x1: 3.5, z0: -5.2, z1: -0.35 }, { x0: -1.4, x1: 1.4, z0: 0.8, z1: 3.6, low: true }, { x0: 3.5, x1: 5.1, z0: -3.9, z1: -1.3, low: true }, { x0: -5.1, x1: -3.5, z0: -3.9, z1: -1.3, low: true }];
const fmtCores = n => (n % 1 ? n.toFixed(1) : String(n));
const fmtHours = n => (n < 10 ? n.toFixed(1) : String(Math.round(n)));
const ROUTE_CAPS = new Set(['lan', 'wan', 'ssh', 'vpn', 'usb', 'tcp', 'http', 'https', 'api']);
const prettyRoute = route => String(route || '').split(/[-_ ]+/).filter(Boolean).map((w, k) => (ROUTE_CAPS.has(w.toLowerCase()) ? w.toUpperCase() : k ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
const CORE_H_NOTE = 'Cores reserved by DGXBridge jobs × their run time. Not measured CPU usage; agent sessions themselves are not included.';
const MAILBOX_NOTE = 'The board is a passive shared mailbox: messages wait until each desktop agent checks its inbox. Schedules vary and posting does not wake an agent. A message is information, not permission.';
const storage = { get(key) { try { return localStorage.getItem(key); } catch { return null; } }, set(key, value) { try { localStorage.setItem(key, value); } catch { /* optional */ } } };
// Name labels: screen-space declutter (see declutterLabels) re-run every DECLUTTER_MS.
const LABEL_MAX = 10;            // labels + cluster chips on screen at once (selected/hovered always show)
const DECLUTTER_MS = 120;
const LABEL_H = 22, CHIP_H = 24, LABEL_LIFT = 4;   // match .city-label / .city-cluster in city.css
const LABEL_PRIORITY = { active: 60, error: 50, idle: 40, offline: 20 };
const EXTERNAL_POLL_MS = 60e3;   // Claude Code / Codex sessions outside CodaClauda (metadata only)
const DRAG_START_PX = 6;         // an agent pressed and moved this far is being dragged, not clicked
const extraKind = agent => agent?.kind === 'session' || agent?.kind === 'external';
/** Status words: CodaClauda sessions say Working / Idle / Error; desktop sessions Active; board agents as before. */
const statusText = agent => (agent?.kind === 'session' ? SESSION_STATUS_LABEL[agent.status] || agent.status : agent?.kind === 'external' ? 'Active' : STATUS_LABEL[agent?.status] || agent?.status || '');
const OWNER_PRIORITY = 55;       // "You": above idle people and idle groups (chips get +10), below working agents
const SHORT_NAME = 18;
const OWNER_TARGET = Object.freeze({ kind: 'owner' });
const TALK_BAR = 0.08;           // letterbox bar height (share of the view), as .city-bar in city.css
const shortName = name => (name.length > SHORT_NAME ? `${name.slice(0, SHORT_NAME - 1).trimEnd()}…` : name);
const chipWidth = n => Math.round(34 + `${n} agents`.length * 6.6);

/** Screen-space label declutter. Pure (no DOM), so it can be checked headless.
 * items: [{ key, rect: { left, top, right, bottom }, ax, ay, priority, dist, pinned, clusterable }]
 *   rect is where the label would sit; (ax, ay) is the projected head it hangs from.
 * Pinned items (selected / hovered) always show. Clusterable items whose anchors fall inside an
 * ellipse (radius.x by radius.y px) around a stronger neighbour become one chip (chipRect gives its
 * box). Everything else is placed greedily by priority, then nearest first, and stays hidden when it
 * would overlap a placed label, a chip, a blocker (HUD, legend, toolbar, panels) or once `max` entries
 * show; a hidden person whose label lands on (or who stands near) a chip joins that chip instead.
 * Returns { shown: Set<key>, chips: [{ key, members, anchors, dx, dy }], clusterOf: Map<key, chipKey> }. */
export function declutterLabels(items, {
  bounds = null, blockers = [], max = 10, gap = 3, radius = { x: 56, y: 28 }, stick = 1.3, minCluster = 2, chipRect = null, prev = null,
  chipBonus = 10,   // a chip stands for several people: it outranks one person of the same status
  nudges = [[0, 0], [0, -28], [0, 28], [-64, 0], [64, 0], [-64, -28], [64, -28], [-64, 28], [64, 28], [0, 56], [0, -56]],
} = {}) {
  const hit = (a, b) => a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom + gap && b.top < a.bottom + gap;
  const offscreen = r => Boolean(bounds) && (r.right <= bounds.left || r.left >= bounds.right || r.bottom <= bounds.top || r.top >= bounds.bottom);
  const order = (a, b) => (b.priority - a.priority) || (a.dist - b.dist) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const shown = new Set(), chips = [], clusterOf = new Map(), placed = [];
  for (const item of items.filter(i => i.pinned).sort(order)) { shown.add(item.key); placed.push({ rect: item.rect, chip: null }); }
  // People standing at one spot: the strongest unclaimed person gathers everyone inside its ellipse
  // (a little wider for last pass's cluster-mates, so groups don't flicker as people shuffle).
  const rest = items.filter(i => !i.pinned && !offscreen(i.rect)).sort(order);
  const taken = new Set(), entries = [];
  for (const seed of rest) {
    if (taken.has(seed.key)) continue;
    taken.add(seed.key);
    const group = [seed];
    if (seed.clusterable && chipRect) {
      const was = prev?.get(seed.key);
      for (const other of rest) {
        if (taken.has(other.key) || !other.clusterable) continue;
        const k = was && prev.get(other.key) === was ? stick : 1;
        const dx = (other.ax - seed.ax) / (radius.x * k), dy = (other.ay - seed.ay) / (radius.y * k);
        if (dx * dx + dy * dy <= 1) { group.push(other); taken.add(other.key); }
      }
    }
    if (group.length < minCluster) { entries.push(seed); continue; }
    const key = `cluster:${seed.key}`, anchors = group.map(m => m.key);
    for (const member of anchors) clusterOf.set(member, key);
    entries.push({ chip: true, key, members: [...anchors], anchors, ax: group.reduce((s, m) => s + m.ax, 0) / group.length, ay: Math.min(...group.map(m => m.ay)), dx: 0, dy: 0, priority: seed.priority + chipBonus, dist: seed.dist });
  }
  entries.sort(order);
  let count = placed.length;
  for (const entry of entries) {
    if (entry.chip) {
      // Next to a group that already has a chip: one chip for both. Otherwise nudge it clear of
      // labels and panels; with no room left it folds into a chip it would touch, or waits.
      const n = entry.members.length, spots = nudges.map(([dx, dy]) => ({ r: chipRect(entry.ax + dx, entry.ay + dy, n), dx, dy }));
      let host = placed.find(p => p.chip && hit(spots[0].r, p.rect));
      const spot = host || count >= max ? null : spots.find(s => !offscreen(s.r) && !blockers.some(b => hit(s.r, b)) && !placed.some(p => hit(s.r, p.rect)));
      if (spot) { entry.dx = spot.dx; entry.dy = spot.dy; placed.push({ rect: spot.r, chip: entry }); chips.push(entry); count++; continue; }
      host ||= placed.find(p => p.chip && spots.some(s => hit(s.r, p.rect)));
      if (host) host.chip.members.push(...entry.members);
      continue;
    }
    const r = entry.rect;
    const blocked = blockers.some(b => hit(r, b)), other = placed.find(p => hit(r, p.rect));
    if (!blocked && !other && count < max) { shown.add(entry.key); placed.push({ rect: r, chip: null }); count++; continue; }
    if (!entry.clusterable) continue;
    const near = p => p.chip && ((entry.ax - p.chip.ax) / (radius.x * 2)) ** 2 + ((entry.ay - p.chip.ay) / (radius.y * 2)) ** 2 <= 1;
    const host = other?.chip ? other : placed.find(near);
    if (host) host.chip.members.push(entry.key);
  }
  return { shown, chips, clusterOf };
}

export function mount(root, ctx) {
  const view = new CityView(root, ctx);
  if (!window.__TAURI__) window.__codaCity = view; // browser-preview debugging only
  return { show: params => view.show(params), hide: () => view.hide(), destroy: () => view.destroy() };
}

/** Visible geometry in the island's resting world frame. A new building is framed at its
 * settled size while its rise animation plays; no live transforms are changed. */
export function focusBounds(object, world, settled = []) {
  if (!object) return null;
  object.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3(), point = new THREE.Vector3(), matrices = new Map();
  const fullScale = new Set(settled), one = new THREE.Vector3(1, 1, 1);
  const matrixFor = node => {
    if (!node) return new THREE.Matrix4();
    if (!matrices.has(node)) {
      const local = fullScale.has(node) ? new THREE.Matrix4().compose(node.position, node.quaternion, one) : node.matrix;
      matrices.set(node, matrixFor(node.parent).clone().multiply(local));
    }
    return matrices.get(node);
  };
  object.traverseVisible(node => {
    if (!node.geometry) return;
    if (node.isInstancedMesh) node.computeBoundingBox();
    else if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
    const box = node.isInstancedMesh ? node.boundingBox : node.geometry.boundingBox;
    if (!box || box.isEmpty()) return;
    const matrix = matrixFor(node);
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      point.set(x, y, z).applyMatrix4(matrix);
      bounds.expandByPoint(world.toWorld(world.toLocal(point), { atRest: true }));
    }
  });
  return bounds.isEmpty() ? null : bounds;
}

export class CityView {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.store = ctx.store;
    this.visible = false;
    this.dirty = true;
    this.selection = null;
    this.hover = null;
    this.labels = new Map();
    this.runnerLabels = new Map();
    this.chips = new Map();          // cluster chips ("4 agents") by key
    this.cluster = null;             // the open cluster list { key, members, w, h }
    this.clusterOf = new Map();
    this.declutterAt = 0;
    this.motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.slots = new SlotMap();
    this.cells = new Map(); this.occupied = new Set(); this.reserved = new Map(); this.rings = 1;
    this.machines = EMPTY_MACHINES;
    this.machinesCollapsed = storage.get(MACHINES_KEY) === '1';
    this.legendExpanded = storage.get(LEGEND_STORAGE) === '1';
    this.street = null;              // street view state { heading, back, moving, turned } while it runs
    this.streetPending = false;      // waiting for the island to turn back to This PC side first
    this.streetKeys = new Set();
    this.talk = null;                // talk mode { id, back, phase: 'wait' | 'walk' | 'on', spot, … } (enterTalk)
    this.sparkOffline = false;
    this.external = [];              // external_sessions_list rows (metadata only)
    this.extraCache = null;          // zero-config agents (extraAgents)
    this.agentDrag = null;           // drag to assign { id, x, y, pointerId, moved, over }
    root.classList.add('city-view');
    this.buildDom();
    if (!webglAvailable()) { this.fail('This computer could not start 3D graphics (WebGL is unavailable).'); return; }
    try { this.initWorld(); }
    catch (error) { console.error(error); this.fail(`The 3D view could not start: ${error.message}`); return; }
    this.islands = new IslandMode(this);   // contributor islands: route map, portal, current island (city/portal.js)
    this.store.on('change', () => { this.extraCache = null; this.agentLocations = null; this.dirty = true; if (this.visible && !this.world.running) this.sync(); });
    this.offSessions = sessions.on('change', () => { this.extraCache = null; this.agentLocations = null; this.dirty = true; if (this.visible && !this.world.running) this.sync(); });
    loadPeople().then(create => { this.npcs.setCreate(create); this.peopleReady = true; this.dirty = true; if (this.visible) this.sync(); });
  }

  reduced() { return Boolean(this.store.prefs.reducedMotion) || Boolean(this.motionQuery?.matches); }

  /* ---------------- zero-config agents (0.5) ---------------- */
  /** CodaClauda's own sessions (working / idle / error) and active Claude Code / Codex sessions found
   *  on this PC, as City agents next to the board's. Home city only (contributor islands show theirs). */
  extraAgents() {
    if (this.islands?.current) return [];
    if (!this.extraCache) {
      const store = this.store, projects = store.projects;
      const own = sessions.available === false ? [] : sessionAgents(sessions.list, projects, { projectOf: id => (id ? store.project(id) : null), running: id => sessions.running(id) });
      this.extraCache = [...own, ...externalAgents(this.external, projects, { own: sessions.list })];
    }
    return this.extraCache;
  }
  allAgents() {
    // Contributor islands have their own remapped projects and must not share home placement memory.
    if (this.islands?.current) return this.store.agents.map(agent => ({ ...agent, cityProjectId: agent.currentProjectId }));
    if (this.agentLocations) return this.agentLocations.agents;
    const store = this.store, extra = this.extraAgents();
    const managedAddresses = new Set(extra.filter(a => a.kind === 'session').map(a => sessions.session(a.sessionId)?.mailboxAddress).filter(Boolean));
    const result = locateAgents([...store.agents.filter(a => !managedAddresses.has(a.address)), ...extra], {
      projects: store.projects, visibleProjects: store.visibleProjects('city'),
      remembered: store.prefs[AGENT_PROJECT_PREF], rememberedAt: store.prefs[AGENT_PROJECT_TIME_PREF],
      sessions: sessions.list, messages: store.mailboxMessages, assignments: store.tasks,
      matchProject: text => store.matchProject(text),
    });
    this.agentLocations = result;
    return result.agents;
  }
  agentById(id) { return this.allAgents().find(a => a.id === id || a.sessionId === id || a.address === id) || null; }
  /** external_sessions_list through bridge.js when this build has it (feature-detected). */
  externalCall() {
    const bridge = this.ctx.bridge, d = bridge.desktop;
    if (typeof d.externalSessionsList === 'function') return () => d.externalSessionsList();
    return bridge.isNative?.() ? () => bridge.invoke('external_sessions_list') : null;
  }
  async pollExternal() {
    const call = this.externalCall();
    if (!call || this.externalBusy) return;
    this.externalBusy = true;
    try { const data = await call(); this.external = Array.isArray(data?.sessions) ? data.sessions : []; }
    catch { this.external = []; }   // an older engine: no desktop sessions, nothing else changes
    finally { this.externalBusy = false; this.extraCache = null; this.agentLocations = null; this.dirty = true; }
  }
  /** ci_status through bridge.js when this build has it (feature-detected); null: no ambient CI. */
  ciCall() {
    const bridge = this.ctx.bridge, d = bridge.desktop;
    if (typeof d.ciStatus === 'function') return args => d.ciStatus(args);
    return bridge.isNative?.() ? args => bridge.invoke('ci_status', args) : null;
  }
  /** Access ticker segments per building (home city): name • Full access / Read only • who works there. */
  tickerMap(projects, agents) {
    const map = new Map();
    if (this.islands?.current || typeof this.store.projectAccess !== 'function') return map;
    const working = new Map();
    for (const a of agents) if (a.status === 'active' && a.currentProjectId) { const id = this.store.project(a.currentProjectId)?.id || a.currentProjectId; working.set(id, (working.get(id) || 0) + 1); }
    for (const p of projects) {
      let level = 'read';
      try { level = this.store.projectAccess(p).level; } catch { /* default */ }
      map.set(p.id, tickerSegments(p, level, working.get(p.id) || 0, this.ci?.status(p.id)?.summary));
    }
    return map;
  }

  /* ---------------- DOM skeleton ---------------- */
  buildDom() {
    this.stage = h('div.city-stage', { tabindex: '0', role: 'application', 'aria-label': 'Project city. Click an agent to talk to them. Drag to orbit, use Pan or P to drag the view, right-drag to pan, scroll to zoom. With the Spark side on, drag up or down to turn the island over, or press V to flip it. W A S D pan, Q and E rotate, F focuses the selection, H resets the view, M finds your avatar, G starts street view (W and S walk, A and D turn, Escape exits).' });
    this.tag = h('div.city-tag', { hidden: true, 'aria-hidden': 'true' });
    this.bubble = h('div.city-bubble', { hidden: true, role: 'status' });
    this.labelLayer = h('div.city-labels', { 'aria-label': 'People in the city' });
    this.chipLayer = h('div.city-chips');   // wheel over a chip still zooms: see bindWheel
    this.clusterPop = h('div.city-cluster-pop.card', { hidden: true, role: 'dialog', 'aria-label': 'Agents at this spot' });
    this.sparkTag = h('div.city-offline-tag', { hidden: true, 'aria-hidden': 'true' }, 'Offline');   // over the DGX SPARK emblem
    // Talk mode: what you and the agent say, over your heads.
    this.talkBubbles = { owner: { node: h('div.city-bubble.city-talk-say.is-owner', { hidden: true, 'aria-hidden': 'true' }), until: 0, size: null }, agent: { node: h('div.city-bubble.city-talk-say', { hidden: true, 'aria-hidden': 'true' }), until: 0, size: null } };
    this.overlay = h('div.city-overlay', this.labelLayer, this.sparkTag, this.chipLayer, this.tag, this.bubble, this.talkBubbles.owner.node, this.talkBubbles.agent.node, this.clusterPop);

    this.stats = h('div.city-hud-stats');
    this.timeChip = h('span.city-chip');
    this.jumpPicker = new JumpToPicker({ onSelect: target => this.onJump(target), onYou: () => this.findMe(), onHQ: () => this.onJump({ kind: 'hq' }) });
    this.jump = this.jumpPicker.root;
    // Which face of the island is up (shown while the Spark side exists).
    this.sideChip = h('span.city-side.is-pc', { hidden: true, role: 'status' });
    this.hud = h('header.city-hud',
      h('div.city-hud-title', h('span.eyebrow', 'Project city'), this.sideChip, this.stats),
      h('div.city-hud-row', this.timeChip, this.weatherSlot = h('div.city-weather-slot'), this.jump));   // weather chip: city/weather-hud.js

    const legendItem = (glyph, label, title = '') => h('div.city-legend-item', { title }, icon(glyph), typeof label === 'string' ? h('span', label) : label);
    this.legendSideText = h('span', 'Flip: DGX Spark');
    this.legendOffline = legendItem('power', 'Spark offline'); this.legendOffline.hidden = true;
    this.legendSpark = h('div.city-legend-extra', { hidden: true }, legendItem('city-flip', this.legendSideText), this.legendOffline);
    this.legendGear = legendItem('settings', 'Gear: PC job'); this.legendGear.hidden = true;
    this.legendLegacySize = legendItem('city', 'Height: activity'); this.legendLegacySize.hidden = true;
    this.legendCi = legendItem('alert', 'Red beacon: CI failing'); this.legendCi.hidden = true;
    this.legendScaffolding = h('span', 'Scaffold: working');
    this.legendContent = h('div.city-legend-content', { id: 'city-legend-content', hidden: !this.legendExpanded },
      h('div.city-legend-statuses',
        h('div.city-legend-row', h('span.city-gem.active'), 'Working'),
        h('div.city-legend-row', h('span.city-gem.idle'), 'Awake'),
        h('div.city-legend-row', { title: 'Powered down' }, h('span.city-gem.offline'), 'Off'),
        h('div.city-legend-row', h('span.city-gem.error'), 'Error')),
      h('div.city-legend-grid', this.legendLegacySize,
        this.legendDistricts = h('div.city-legend-extra',
          legendItem('city', 'Downtown', 'GitHub projects; taller towers reflect activity'),
          legendItem('home', 'Suburbs', 'Local folders; homes grow outward'),
          legendItem('download', 'Foundation + sign', 'Foundation + sign = repo to clone'),
          legendItem('city-boat', 'Boats: commits', 'Projects with recent commits'),
          legendItem('city-van', 'Van: working home'),
          legendItem('board', 'Clipboard: board agent')),
        this.legendCi, legendItem('agents', this.legendScaffolding), this.legendGear, this.legendSpark));
    this.legendToggle = h('button.city-legend-toggle', { type: 'button', 'aria-expanded': String(this.legendExpanded), 'aria-controls': 'city-legend-content', onclick: () => this.toggleLegend() }, icon('help'), 'Legend', icon('city-chevron-up'));
    this.legend = h('div.city-legend', { 'aria-label': 'Legend' }, this.legendContent, this.legendToggle);
    this.legend.classList.toggle('is-collapsed', !this.legendExpanded);

    this.followBtn = iconButton('crosshair', 'Follow my avatar', () => this.toggleFollow(), 'city-tool');
    this.timeBtn = iconButton('clock', 'Time of day', () => this.cycleTime(), 'city-tool');
    this.qualityBtn = iconButton('cube', 'Shadows', () => this.toggleQuality(), 'city-tool');
    this.helpBtn = iconButton('help', 'Controls help', () => this.toggleHelp(), 'city-tool');
    this.sparkBtn = iconButton('city-chip', 'Spark side', () => this.toggleSpark(), 'city-tool');
    // Turns the island over (label = where you'll go); see renderFlip.
    this.flipLabel = h('span', 'Spark side');
    this.flipBtn = h('button.city-flip', { type: 'button', hidden: true, onclick: () => this.flipSide() }, icon('city-chip'), this.flipLabel);
    // Find me: your portrait; flies to your avatar and opens its card.
    this.findArt = h('span.city-findme-art');
    this.findBtn = h('button.city-findme', { type: 'button', title: 'Find me (M)', 'aria-label': 'Find me: fly to your avatar (M)', onclick: () => this.findMe() }, this.findArt, h('span', 'Find me'));
    this.streetLabel = h('span', 'Street view');
    this.streetBtn = h('button.city-street-btn', { type: 'button', title: 'Street view (G)', 'aria-pressed': 'false', onclick: () => this.toggleStreet() }, icon('city-street'), this.streetLabel);
    this.panBtn = h('button.city-pan-btn', { type: 'button', title: 'Pan: drag to move the view (P)', 'aria-pressed': 'false', onclick: () => this.togglePan() }, icon('city-pan'), h('span', 'Pan'));
    this.streetHint = h('div.city-street-hint', { hidden: true, role: 'note' }, 'W/S walk · A/D turn · drag to look · Esc to exit');
    // Zoomed all the way in (This PC side up): one more zoom-in step drops into street view.
    this.zoomHint = h('div.city-zoom-hint', { hidden: true, role: 'status' }, icon('city-street'), 'Keep zooming → Street view');
    this.toolbar = h('div.city-toolbar', { role: 'toolbar', 'aria-label': 'City controls' },
      this.findBtn, this.streetBtn, this.panBtn,
      this.flipBtn,
      iconButton('zoomIn', 'Zoom in', () => this.world?.zoomBy(0.72), 'city-tool'),
      iconButton('zoomOut', 'Zoom out', () => this.world?.zoomBy(1.38), 'city-tool'),
      iconButton('home', 'Reset view (H)', () => this.resetCamera(), 'city-tool'),
      this.followBtn, h('span.city-toolbar-sep'), this.timeBtn, this.qualityBtn, this.sparkBtn, this.helpBtn);

    this.help = h('div.city-help.card', { hidden: true, role: 'dialog', 'aria-label': 'City controls' },
      h('div.city-help-head', h('strong', 'Getting around'), iconButton('close', 'Close help', () => this.toggleHelp(false))),
      h('dl.city-help-list',
        ...[['M', 'Find me: fly to your avatar'], ['G', 'Street view behind your avatar (W/S walk, A/D turn, Esc exits)'], ['V', 'Flip to the other side'], ['Left-drag', 'Orbit'], ['Drag up / down', 'Turn the island over (Spark side on)'], ['Pan / P', 'Toggle drag-to-pan mode'], ['Right-drag', 'Pan'], ['Scroll / pinch', 'Zoom toward the pointer; keep zooming in for street view'], ['W A S D / arrows', 'Move'], ['Q / E', 'Rotate'], ['Click an agent', 'Talk to them (Esc leaves)'], ['Drag an agent', 'Drop it on a building to give it a task there'], ['Click', 'Select a building or your avatar'], ['Click an empty plot', 'Start a new project there'], ['Double-click a building', 'Center it on either face'], ['Double-click ground', 'Walk your avatar there'], ['Click a boat label', 'Center that boat'], ['F / Focus', 'Center the selected building, agent or boat'], ['Jump', 'Select and center a building or agent'], ['H', 'Fit the whole island'], ['Esc', 'Deselect']]
          .flatMap(([k, v]) => [h('dt', h('kbd', k)), h('dd', v)])),
      h('p.city-note', 'A winding river connects Downtown (GitHub projects) and Suburbs (local folders without a repo). Road bridges link the districts. Foundation + sign = repo to clone. Click either to open Clone to build. Tickers sit on real buildings only. Both districts keep at least three empty plots and grow without moving placed buildings.'),
      h('p.city-note', 'Suburbs have low modern homes with at most two storeys. Larger projects add wings and a wider footprint; Downtown towers grow taller. A contractor van and ladder show an agent working at a home, and a solar-panel glint marks a busy home.'),
      h('p.city-note', 'Sailboats, rowboats, tugboats, barges, paddle steamers and canoes travel a continuous river loop, over the waterfalls and along the Spark face. Boat labels show projects with recent commits; barges carry several names on their crates. Reduced motion moors boats at the docks on both faces. Click a bridge to walk there. A red rooftop beacon and CI failing ticker mark failed builds; weather is independent.'),
      h('button.btn.small.primary', { type: 'button', onclick: () => this.toggleHelp(false) }, 'Got it'));

    this.machinesCard = h('section.city-machines', { hidden: true, 'aria-label': 'Machine load' });
    this.panel = h('aside.city-panel.card', { hidden: true, 'aria-live': 'polite' });
    this.empty = h('div.city-empty.card', { hidden: true });
    this.fallback = h('div.city-fallback', { hidden: true });
    // Talk mode: letterbox bars, the way out and the conversation (city/talk.js).
    this.bars = [h('div.city-bar.top', { 'aria-hidden': 'true' }), h('div.city-bar.bottom', { 'aria-hidden': 'true' })];
    this.leaveBtn = h('button.city-talk-leave', { type: 'button', title: 'Leave the conversation (Esc)', onclick: () => this.exitTalk() }, icon('city-leave'), h('span', 'Leave conversation'), h('kbd', 'Esc'));
    this.talkPanel = new TalkPanel({
      store: this.store, navigate: (view, params) => this.ctx.navigate(view, params),
      onLeave: () => this.exitTalk(),
      onSent: text => this.talkSent(text),
      onAgentLine: text => this.talkHeard(text),
      onThinking: on => this.talkThinking(on),
      onAgentChanged: agent => { this.extraCache = null; this.agentLocations = null; this.dirty = true; this.enterTalk(agent.id); },
      canNewSessionHere: project => !this.islands?.current && (!this.world?.underside || this.world.restSide === 'pc')
        && typeof project?.path === 'string' && Boolean(project.path.trim()),
    });
    this.newSessionHere = projectId => this.openBuildingSessionControls(projectId);
    // Drag to assign: the agent you're carrying, under the pointer (pointer-events: none).
    this.dragGhost = h('div.city-drag-ghost', { hidden: true, 'aria-hidden': 'true' });
    this.cityRoot = h('div.city-root', this.stage, ...this.bars, this.overlay, this.hud, this.legend, this.machinesCard, this.streetHint, this.zoomHint, this.toolbar, this.help, this.panel, this.empty, this.leaveBtn, this.talkPanel.node, this.fallback, this.dragGhost);
    this.root.append(this.cityRoot);
    this.buildingSessions = new BuildingSessionActions({ store: this.store, sessions,
      ...buildingTalkCallbacks(this),
    });
    if (!storage.get(HELP_KEY)) this.help.hidden = false;
  }

  fail(message) {
    this.failed = true;
    this.weather?.hide();
    if (this.talk) this.releaseTalk(this.talk);
    this.talkPanel.close();
    this.talk = null;
    this.cityRoot.classList.remove('is-talk');
    for (const node of [this.hud, this.legend, this.toolbar, this.help, this.panel, this.empty, this.overlay, this.machinesCard, this.leaveBtn, this.talkPanel.node, ...this.bars]) node.hidden = true;
    clear(this.fallback, h('div.city-fallback-card.card',
      h('div.empty-art', icon('city')),
      h('h3', 'The city needs 3D graphics'),
      h('p', message),
      h('p.muted', 'Everything the city shows is also available as lists:'),
      h('div.empty-actions',
        h('button.btn.primary', { type: 'button', onclick: () => this.ctx.navigate('agents') }, icon('agents'), 'Agents'),
        h('button.btn', { type: 'button', onclick: () => this.ctx.navigate('projects') }, icon('projects'), 'Projects'))));
    this.fallback.hidden = false;
  }

  /* ---------------- world + managers ---------------- */
  initWorld() {
    const prefs = this.store.prefs;
    this.world = new World(this.stage, { quality: prefs.cityQuality || 'high', reducedMotion: () => this.reduced(), timeMode: prefs.cityTime || 'auto' });
    this.world.onContextLost = () => this.fail('The graphics context was lost (the GPU may have been reset). Reload the window to bring the city back.');
    this.world.onKeyPan = () => { if (this.following) this.toggleFollow(false); };
    this.world.onResize = () => this.updateCameraFrame();
    this.cameraFrameObserver = new ResizeObserver(() => this.updateCameraFrame());
    for (const node of [this.hud, this.legend, this.toolbar, this.machinesCard, this.panel, this.stage]) this.cameraFrameObserver.observe(node);
    this.world.collide = p => this.solidAt(p);
    this.buildings = new BuildingManager(this.world.city, { particles: this.world.particles, reducedMotion: () => this.reduced() });
    this.river = new River(this.world);
    this.npcs = new NpcManager(this.world.city, { buildings: this.buildings, particles: this.world.particles, reducedMotion: () => this.reduced(), river: () => this.islands?.current ? null : this.river, resolveProjectId: id => this.store.project(id)?.id || id });
    this.spark = new SparkCity(this.world, { makePerson: (spec, options) => this.npcs.makePerson(spec, options), reducedMotion: () => this.reduced(), topBuildings: this.buildings });
    this.world.boundsPoints = () => this.cameraBounds();
    this.plotMarker = buildPlotMarker();
    this.world.city.add(this.plotMarker.group);
    this.world.onFrame((dt, elapsed, env) => this.frame(dt, elapsed, env));
    // Weather (This PC side only): effects, HUD chip + quick picker, live feed while the City is shown.
    this.weather = new CityWeather(this.world, { store: this.store, bridge: this.ctx.bridge, reducedMotion: () => this.reduced(), navigate: (view, params) => this.ctx.navigate(view, params) });
    this.weatherSlot.append(this.weather.node);
    // CI is a rooftop beacon, independent of weather; new green runs keep their celebration.
    this.ci = new CityCi({
      world: this.world, buildings: this.buildings, caller: () => this.ciCall(), reducedMotion: () => this.reduced(),
      projects: () => (this.islands?.current ? [] : this.store.visibleProjects('city')), home: () => !this.islands?.current,
      onChange: () => { this.panelSig = ''; this.dirty = true; },
    });
    this.legendCi.hidden = !this.ci.available;
    this.bindInput();
  }

  toggleLegend() {
    this.legendExpanded = !this.legendExpanded;
    storage.set(LEGEND_STORAGE, this.legendExpanded ? '1' : '0');
    this.legendContent.hidden = !this.legendExpanded;
    this.legend.classList.toggle('is-collapsed', !this.legendExpanded);
    this.legendToggle.setAttribute('aria-expanded', String(this.legendExpanded));
    this.updateCameraFrame();
  }
  /** Overview bounds use real roof locations instead of tall empty space at every corner. */
  cameraBounds() {
    const world = this.world, half = world.half, points = [];
    const add = p => points.push(world.toWorld(p, { atRest: true }));
    for (const x of [-half, half]) for (const z of [-half, half]) for (const y of [DECK_Y, GROUND_Y]) add(new THREE.Vector3(x, y, z));
    if (!world.underside && !world.districts) for (const x of [-half * 0.7, half * 0.7]) for (const z of [-half * 0.7, half * 0.7]) add(new THREE.Vector3(x, -13, z));
    const spark = world.restSide === 'spark';
    const buildings = spark ? this.spark.buildings.list : this.buildings.list;
    for (const b of buildings) {
      const height = b.unbuilt ? b.roofTop : Math.max(b.size.H + 1, b.roofTop || 0) + (b.jib ? 6 : 0);
      for (const x of [-b.size.W / 2 - 0.6, b.size.W / 2 + 0.6]) for (const z of [-b.size.D / 2 - 0.6, b.size.D / 2 + 0.6]) for (const y of [0, height]) add(b.worldPoint(x, y, z));
    }
    // The central HQ/foundry is present even with no project buildings.
    for (const x of [-5, 5]) for (const z of [-5, 5]) add(new THREE.Vector3(x, spark ? DECK_Y - 12 : 12, z));
    return points;
  }
  /** Read overlay bounds on layout/state changes, not on every animation frame. */
  updateCameraFrame() {
    const world = this.world;
    if (!world?.size || !this.visible) return;
    this.syncCameraFramingMode();
    const base = this.stage.getBoundingClientRect();
    const bounds = { left: Math.max(0, -base.left), top: Math.max(0, -base.top), right: Math.min(base.width, window.innerWidth - base.left), bottom: Math.min(base.height, window.innerHeight - base.top) };
    this.root.style.setProperty('--city-visible-width', `${bounds.right - bounds.left}px`);
    this.root.style.setProperty('--city-visible-height', `${bounds.bottom - bounds.top}px`);
    const blockers = [];
    for (const node of [this.hud, this.legend, this.toolbar, this.machinesCard, this.panel]) {
      if (node.hidden || !node.getClientRects().length) continue;
      const r = node.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      // Use layout coordinates for the panel: its opening animation translates it temporarily.
      const left = node === this.panel ? node.offsetLeft : r.left - base.left;
      const top = node === this.panel ? node.offsetTop : r.top - base.top;
      blockers.push({ left: left - 8, top: top - 8, right: left + r.width + 8, bottom: top + r.height + 8 });
    }
    this.cameraFreeRect = largestFreeRect(bounds, { blockers });
    world.setFramingRect(this.cameraFreeRect);
  }
  syncCameraFramingMode() {
    const enabled = !this.talk && !this.street && !this.streetPending;
    if (this.world && this.world.framingEnabled !== enabled) {
      this.world.framingEnabled = enabled;
      this.world.updateProjectionFrame();
    }
  }

  /** 'auto' (Spark side shown whenever DGXBridge is configured) or 'off'; an old stored 'on' counts as 'auto'. */
  sparkMode() { return this.store.prefs.citySpark === 'off' ? 'off' : 'auto'; }
  readMachines() {
    try { const m = this.store.machines; return m && typeof m === 'object' ? { ...EMPTY_MACHINES, ...m } : EMPTY_MACHINES; }
    catch (error) { console.error('City: machine status unavailable', error); return EMPTY_MACHINES; }
  }
  /** Save new lots and repair aliases, so a canonical-id change also survives reopening. */
  persistLots(fresh, pinRepairs = null) {
    if (typeof this.store.setCityLot !== 'function') return;
    const store = this.store;
    const lots = pinRepairs ?? fresh.flatMap(f => {
      const project = store.project(f.id);
      return [...new Set([f.id, ...(project?.ids || [])])].map(id => ({ ...f, id }));
    });
    if (!lots.length) return;
    setTimeout(() => {   // never re-enter sync() from inside sync()
      const pins = store.cityLots || {};
      const todo = lots.filter(f => !pins[f.id] || ((f.migrated || f.repair) && (pins[f.id].i !== f.i || pins[f.id].j !== f.j)));
      if (todo.length > 1 && typeof store.updateDesktop === 'function') store.updateDesktop(d => { d.cityLots = { ...(d.cityLots || {}) }; for (const f of todo) d.cityLots[f.id] = { i: f.i, j: f.j }; });
      else for (const f of todo) store.setCityLot(f.id, { i: f.i, j: f.j });
    }, 0);
  }

  /** Render immediately; save the first bank choice when hydration settles or its deadline expires. */
  ensureDistrictBanks(projects) {
    if (this.islands?.current || this.homeBanksFinal) return true;
    const store = this.store, saved = store.prefs.cityLargerDistrictV1;
    store.beginCityHydration?.();
    const final = [DOWNTOWN, SUBURBS].includes(saved) || store.cityProjectsReady !== false;
    const choice = final ? chooseLargerDistrict(projects, saved)
      : this.homeBanks?.largerDistrict || chooseLargerDistrict(projects);
    if (this.homeBanks?.largerDistrict !== choice) {
      this.homeBanks = districtBanks(choice);
      this.slots = new SlotMap({ banks: this.homeBanks });
      if (this.islands?.homeSlots) this.islands.homeSlots = this.slots;
    }
    if (final) {
      this.homeBanksFinal = true;
      if (saved !== choice) store.setPref('cityLargerDistrictV1', choice);
    }
    return true;
  }

  sync() {
    if (this.failed || !this.world) return;
    // Scene rebuilds must see original materials so their normal disposal owns them.
    if (this.talk?.restoreCutaway) {
      this.talk.restoreCutaway(); this.talk.restoreCutaway = null; this.talk.phase = 'wait';
    }
    this.dirty = false;
    this.root.classList.toggle('reduce-motion', this.reduced());
    const store = this.store;
    const projects = store.visibleProjects('city');
    const districts = !this.islands?.current;
    if (!this.ensureDistrictBanks(store.projects)) return;
    const hold = Boolean(this.plotDialog && performance.now() - this.plotDialog.at < PLOT_HOLD_MS);
    const { cells, rings, fresh = [], reserved = new Map(), emptyPlots, pinRepairs } = this.slots.assign(projects, { pins: store.cityLots || {}, reserve: store.projects.filter(p => !p.visible.city), hold, districts });
    this.emptyPlots = emptyPlots;
    this.cells = cells; this.rings = rings; this.reserved = reserved;
    this.occupied = new Set([...cells.values()].map(c => cellKey(c.i, c.j)));
    // Provisional plots stay interactive, but a temporary identity inventory
    // must not write migrated pins before the bounded first bank decision.
    if (!districts || (this.homeBanksFinal && store.cityProjectsReady !== false)) this.persistLots(fresh, pinRepairs);
    const ringsChanged = this.world.setRings(rings, { animate: Boolean(this.firstSyncDone), districts, banks: this.homeBanks });
    // A skipped expansion holds its old pose, including through later HUD resize
    // callbacks. It becomes an overview again when the owner explicitly asks.
    if (ringsChanged && this.firstSyncDone && (!this.world.canAutoRefit() || this.pendingFocus || this.talk || this.street || this.streetPending || this.following)) this.world.overview = false;
    // Expansion follows the island again once the owner's last camera input is 30 seconds old.
    const initialFit = !this.firstSyncDone;
    const agents = this.allAgents();   // the board's agents + CodaClauda sessions + desktop sessions (zero-config)
    const locations = this.agentLocations;
    if (locations?.changed && !this.islands?.current && store.cityProjectsReady !== false) {
      store.updateDesktop(desktop => {
        desktop.prefs[AGENT_PROJECT_PREF] = locations.remembered;
        desktop.prefs[AGENT_PROJECT_TIME_PREF] = locations.rememberedAt;
      });
    }
    const active = new Set(agents.filter(a => a.status === 'active' && a.currentProjectId).map(a => store.project(a.currentProjectId)?.id || a.currentProjectId));
    const lotsChanged = this.buildings.sync(projects, cells, active, { animate: true, tickers: this.tickerMap(projects, agents), districts });
    if (lotsChanged || ringsChanged) this.world.setLots(this.buildings.lots());
    this.ci?.sync();
    const quality = store.prefs.cityQuality === 'low' ? 'low' : 'high';
    if (this.world.quality !== quality) this.world.setQuality(quality);
    this.river.group.visible = districts;
    this.legendDistricts.hidden = !districts;
    this.legendLegacySize.hidden = districts;
    this.legendScaffolding.textContent = 'Scaffold: working';
    if (districts) {
      this.river.setQuality(quality);
      this.river.setBounds({ half: this.world.half, banks: this.homeBanks });
      this.river.setProjects(projects);
    }
    const timeMode = TIME_MODES.includes(store.prefs.cityTime) ? store.prefs.cityTime : 'auto';
    if (this.world.timeMode !== timeMode) { this.world.setTimeMode(timeMode); }
    if (this.peopleReady) {
      setPeopleReducedMotion(this.reduced());
      try { this.npcs.sync(agents, { avatar: store.avatar, quality }); }
      catch (error) { console.error('City: could not place agents', error); }
    }
    // The Spark underside (DGX Spark) and local-job gears (this PC).
    // Never an empty Spark side: it exists only while DGXBridge is configured (and not hidden).
    const machines = this.readMachines();
    const mode = this.sparkMode();
    const enabled = Boolean(machines.enabled);
    const under = enabled && mode !== 'off';
    const offline = enabled && !machines.online;
    this.machines = machines;
    this.sparkOffline = offline;
    this.offlineText = offline ? offlineLabel(machines.offlineSince) : '';
    if (this.sparkTag.textContent !== this.offlineText && offline) this.sparkTag.textContent = this.offlineText;
    this.world.setUnderside(under);
    try { this.spark.sync({ shown: under, projects, cells, rings, machines, quality, peopleReady: Boolean(this.peopleReady), gears: mode !== 'off', offline, agents: store.agents }); }
    catch (error) { console.error('City: could not build the Spark underside', error); }
    this.legendSpark.hidden = !under;
    this.legendOffline.hidden = !(under && offline);
    this.legendGear.hidden = !this.spark.gears.size;
    this.syncRunnerLabels();
    this.renderMachines(machines, mode);
    this.syncLabels(agents);
    this.weather?.setHome(!this.islands?.current);   // contributor islands (city/portal.js) have no weather; IslandMode.apply syncs after each switch
    this.renderHud(projects, agents);
    this.renderEmpty(projects);
    this.renderToolbarState();
    this.refreshPanel();
    this.updateCameraFrame();
    this.world.limits();
    this.refitForGrowth(initialFit || ringsChanged);
    this.firstSyncDone = true;
    if (this.talk) {
      this.resolvePendingTalk();
      const agent = !this.talk.pending && this.agentById(this.talk.id);
      if (agent) this.talkPanel.agent = { ...this.talkPanel.agent, ...agent };
      this.talkPanel.refresh();
    }
    this.tryPendingFocus();
  }

  refitForGrowth(changed) {
    if (changed && !this.pendingFocus && !this.talk && !this.street && !this.streetPending && !this.following && this.world.canAutoRefit()) {
      this.world.resetView({ instant: !this.firstSyncDone, auto: true });
    }
  }

  /* ---------------- per-frame ---------------- */
  frame(dt, elapsed, env) {
    if (this.dirty) this.sync();
    this.buildings.update(dt, elapsed, env);
    tickerBank.update(dt, env.reducedMotion);
    this.ci?.update(dt, elapsed);
    if (!this.islands?.current) this.river?.update(dt, elapsed, env);
    this.updateBoatFocus();
    try { this.npcs.update(dt, elapsed, env); }
    catch (error) { if (!this.npcError) { this.npcError = true; console.error('City: agent animation failed', error); } }
    try { this.spark.update(dt, elapsed, env); }
    catch (error) { if (!this.sparkError) { this.sparkError = true; console.error('City: Spark underside animation failed', error); } }
    this.plotMarker.update(elapsed, env.reducedMotion);
    // Street view starts once the island is still with This PC side up (it may have had to turn over first).
    if (this.streetPending && this.world.settled) {
      this.streetPending = false;
      if (this.world.side === 'pc' && this.npcs.owner) this.beginStreet(); else this.renderToolbarState();
    }
    if (this.street && !this.npcs.owner) this.exitStreet({ fly: true });
    this.updateTalk();
    this.refreshBuildingTalkAction();
    if (this.zoomHintAt && performance.now() - (this.zoomOverAt || 0) > 2500) this.hideZoomHint();
    this.renderFlip();
    // While the island turns: no hover, no tags (labels hide in updateOverlays); following stops on the Spark side.
    const still = this.world.settled;
    if (!still && this.hover) this.setHover(null);
    if (this.following && this.world.restSide !== 'pc') this.toggleFollow(false);
    this.hoverTimer = (this.hoverTimer || 0) - dt;
    if (still && this.pointer && (this.hoverDirty || this.hoverTimer <= 0) && !this.dragging) { this.hoverDirty = false; this.hoverTimer = 0.2; this.updateHover(); }
    this.updateOverlays();
    if (this.bubbleUntil && performance.now() > this.bubbleUntil) { this.bubble.hidden = true; this.bubbleUntil = 0; this.bubbleTarget = null; }
    this.timeChipTimer = (this.timeChipTimer || 0) - dt;
    if (this.timeChipTimer <= 0) { this.timeChipTimer = 5; this.renderTimeChip(); }
  }

  /** Is this target on the face that's up, with the island still? (Overlays only show then.) */
  facesUp(target) {
    const world = this.world;
    const boat = target?.kind === 'boat' ? this.river.getBoat(target.id) : null;
    if (target?.kind === 'boat' && !boat) return false;
    const side = boat ? (boat.position.y < -3.6 ? 'spark' : 'pc') : SPARK_KINDS.has(target?.kind) ? 'spark' : 'pc';
    return world.settled && world.side === side;
  }
  updateOverlays() {
    const world = this.world, cam = world.camera;
    cam.updateMatrixWorld();
    const scratch = this.scratch ||= new THREE.Vector3(), point = { x: 0, y: 0, visible: false };
    const camPos = cam.position;
    // 1. Project every name label from its WORLD position (math only, no DOM). HTML labels ignore
    //    depth, so only the face that's up shows names, and none show while the island turns.
    const still = world.settled, pcUp = still && world.side === 'pc', sparkUp = still && world.side === 'spark';
    const projectLabel = (label, fadeFrom, fadeOver) => {
      world.project(scratch, point);
      label.dist = camPos.distanceTo(scratch);
      label.fade = Math.max(0, Math.min(1, fadeFrom - label.dist / fadeOver));
      label.on = point.visible && label.fade > 0.04;
      label.px = point.x; label.py = point.y;
    };
    for (const [id, label] of this.runnerLabels) {
      const runner = sparkUp ? this.spark.runner(id) : null;
      label.on = false;
      if (!runner) continue;
      this.spark.runnerHead(runner, scratch);
      projectLabel(label, 1.7, 130);
    }
    for (const [key, label] of this.labels) {
      const target = key === 'owner' ? OWNER_TARGET : { kind: 'agent', id: key };
      const pos = pcUp && !(key === 'owner' && this.street) ? this.npcs.position(target) : null;   // street view: you are the one in front
      label.on = false;
      if (!pos) continue;
      world.toWorld(scratch.set(pos.x, pos.y + this.npcs.headroom(target), pos.z), { out: scratch });
      projectLabel(label, 1.5, 110);
    }
    // 2. Throttled: decide which labels and cluster chips show (one read pass, then writes).
    const now = performance.now();
    if (now >= this.declutterAt) { this.declutterAt = now + DECLUTTER_MS; this.declutter(); }
    // 3. Every frame: shown labels and chips follow the heads (Spark runners stand upright too once their side is up).
    for (const label of this.runnerLabels.values()) this.placeLabel(label, 'translate(-50%, -100%)');
    for (const label of this.labels.values()) this.placeLabel(label, 'translate(-50%, -100%)');
    this.placeChips();
    this.placeClusterPop();
    // Tags and bubbles sit just above a person's name label (offset in screen space) or above a roof,
    // only for targets on the face that's up.
    const place = (node, target) => {
      const person = target.kind === 'agent' || target.kind === 'owner' || target.kind === 'runner';
      const p = this.facesUp(target) ? this.targetPoint(target, person ? 0 : 0.4) : null;
      if (!p) { node.hidden = true; return; }
      world.project(p, point);
      node.hidden = !point.visible;
      node.classList.toggle('on-person', person);
      node.style.transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
    };
    const bubbleOnHover = this.bubbleTarget && this.hover && this.bubbleTarget.kind === this.hover.kind && this.bubbleTarget.id === this.hover.id;
    if (this.hover && this.hoverInfo && !bubbleOnHover) place(this.tag, this.hover);
    else this.tag.hidden = true;
    if (this.bubbleTarget) place(this.bubble, this.bubbleTarget);
    if (this.talk) this.placeTalkBubbles(scratch, point);
    // Spark offline: a small tag over the DGX SPARK emblem while that face is up.
    const tagOn = sparkUp && this.sparkOffline && this.spark.shown && Boolean(this.spark.deck);
    if (tagOn) { world.toWorld(this.spark.signPoint(scratch), { out: scratch }); world.project(scratch, point); }
    const showTag = tagOn && point.visible;
    if (this.sparkTag.hidden === showTag) this.sparkTag.hidden = !showTag;
    if (showTag) this.sparkTag.style.transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
  }
  /** Label declutter pass: reads first (panel rects, label sizes), then writes. */
  declutter() {
    const { w: W, h: H } = this.world.size;
    const base = this.overlay.getBoundingClientRect();
    const blockers = [];
    for (const node of [this.hud, this.legend, this.toolbar, this.machinesCard, this.panel, this.help, this.empty, this.tag, this.bubble, this.clusterPop, this.streetHint, this.zoomHint, this.sparkTag, this.talkPanel.node, this.leaveBtn]) {
      if (node.hidden) continue;
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) blockers.push({ left: r.left - base.left, top: r.top - base.top, right: r.right - base.left, bottom: r.bottom - base.top });
    }
    const labels = [...this.labels.entries(), ...[...this.runnerLabels].map(([id, label]) => [`runner:${id}`, label])];
    for (const [, label] of labels) if (label.w == null && !label.node.hidden) label.w = label.node.offsetWidth || null;
    // Writes from here on. The selected / hovered person gets the full label (name + activity).
    const pinKey = t => (t?.kind === 'agent' ? t.id : t?.kind === 'owner' ? 'owner' : t?.kind === 'runner' ? `runner:${t.id}` : null);
    const selected = pinKey(this.selection), hovered = pinKey(this.hover);
    for (const [key, label] of this.labels) {
      const full = key === selected || key === hovered;
      if (label.full !== full) { label.full = full; this.renderLabel(label); }
    }
    const items = [];
    for (const [key, label] of labels) {
      if (!label.on) continue;
      const runner = label.kind === 'runner', w = label.w ?? label.estW ?? 120;
      const top = label.py - LABEL_LIFT - LABEL_H;
      const priority = key === selected ? 100 : key === hovered ? 90 : key === 'owner' ? OWNER_PRIORITY : runner ? (key.startsWith('runner:crew:') ? LABEL_PRIORITY.idle : LABEL_PRIORITY.active) : LABEL_PRIORITY[label.agent?.status] ?? 30;
      items.push({
        key, rect: { left: label.px - w / 2, right: label.px + w / 2, top, bottom: top + LABEL_H }, ax: label.px, ay: label.py,
        priority: priority + (label.show ? 1 : 0),   // already showing wins ties: no swapping as the camera drifts
        dist: label.dist, pinned: key === selected || key === hovered, clusterable: !runner && Boolean(label.agent),
      });
    }
    const result = declutterLabels(items, {
      bounds: { left: 0, top: 0, right: W, bottom: H }, blockers, max: LABEL_MAX, prev: this.clusterOf,
      chipRect: (x, y, n) => { const w = chipWidth(n); return { left: x - w / 2, right: x + w / 2, top: y - LABEL_LIFT - CHIP_H, bottom: y - LABEL_LIFT }; },
    });
    this.clusterOf = result.clusterOf;
    for (const [key, label] of labels) label.show = result.shown.has(key);
    this.renderChips(result.chips);
  }
  placeLabel(label, shift) {
    const show = Boolean(label.on && label.show);
    if (label.node.hidden === show) label.node.hidden = !show;
    if (!show) return;
    label.node.style.transform = `translate3d(${label.px.toFixed(1)}px, ${label.py.toFixed(1)}px, 0) ${shift}`;
    label.node.style.opacity = label.fade.toFixed(2);
  }
  /** "4 agents" chips for people standing at one spot; clicking one lists them. */
  renderChips(chips) {
    const seen = new Set();
    for (const chip of chips) {
      const agents = chip.members.map(id => this.labels.get(id)?.agent).filter(Boolean);
      if (agents.length < 2) continue;
      const key = chip.key;
      seen.add(key);
      let entry = this.chips.get(key);
      if (!entry) {
        entry = { node: h('button.city-cluster', { type: 'button', hidden: true, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: event => this.toggleCluster(key, event) }), sig: '' };
        this.chips.set(key, entry);
        this.chipLayer.append(entry.node);
      }
      Object.assign(entry, { members: agents.map(a => a.id), anchors: chip.anchors, dx: chip.dx, dy: chip.dy });
      const best = ['active', 'idle'].find(s => agents.some(a => a.status === s)) || 'offline';
      const names = agents.map(a => a.name).join(', ');
      const sig = `${best}|${names}`;
      if (entry.sig === sig) continue;
      entry.sig = sig;
      clear(entry.node, h(`span.city-gem.${best}`), `${agents.length} agents`);
      entry.node.title = names;
      entry.node.setAttribute('aria-label', `${agents.length} agents here: ${names}. Show the list.`);
    }
    for (const [key, entry] of this.chips) {
      if (seen.has(key)) continue;
      if (entry.node === document.activeElement) this.stage.focus({ preventScroll: true });
      entry.node.remove();
      this.chips.delete(key);
    }
  }
  /** Centre of a group's heads in screen space (x: mean, y: the highest head). */
  groupPoint(keys) {
    let x = 0, y = Infinity, n = 0, fade = 0;
    for (const key of keys) {
      const label = this.labels.get(key);
      if (!label?.on) continue;
      x += label.px; y = Math.min(y, label.py); fade = Math.max(fade, label.fade); n++;
    }
    return n ? { x: x / n, y, fade } : null;
  }
  placeChips() {
    for (const entry of this.chips.values()) {
      const p = this.groupPoint(entry.anchors);
      if (entry.node.hidden === Boolean(p)) entry.node.hidden = !p;
      if (!p) continue;
      entry.node.style.transform = `translate3d(${(p.x + entry.dx).toFixed(1)}px, ${(p.y + entry.dy).toFixed(1)}px, 0) translate(-50%, -100%)`;
      entry.node.style.opacity = p.fade.toFixed(2);
    }
  }
  toggleCluster(key, event) {
    if (this.cluster?.key === key) { this.closeCluster(); return; }
    const entry = this.chips.get(key);
    if (!entry) return;
    this.closeCluster();
    const rank = a => LABEL_PRIORITY[a.status] ?? 0;
    const agents = entry.members.map(id => this.agentById(id)).filter(Boolean).sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
    if (!agents.length) return;
    if (agents.length === 1) { this.enterTalk(agents[0].id); return; }
    clear(this.clusterPop,
      h('div.city-cluster-head', h('strong', `${agents.length} agents here`), iconButton('close', 'Close list', () => this.closeCluster(true))),
      h('div.city-cluster-list', ...agents.map(a => h('button.city-cluster-item', {
        type: 'button', title: `${a.name} · ${statusText(a)}`,
        onclick: () => this.pickFromCluster(a.id),
        onpointerenter: () => this.setHover({ kind: 'agent', id: a.id }),
        onpointerleave: () => { if (!this.pointer) this.setHover(null); },
      }, portrait(a.look, { size: 28, provider: a.provider, status: a.status }), h('span.city-cluster-name', a.name), h('span.city-cluster-status', statusText(a))))));
    this.clusterPop.hidden = false;
    this.cluster = { key, members: agents.map(a => a.id), w: this.clusterPop.offsetWidth, h: this.clusterPop.offsetHeight };
    entry.node.setAttribute('aria-expanded', 'true');
    this.placeClusterPop();
    if (event?.detail === 0) this.clusterPop.querySelector('.city-cluster-item')?.focus({ preventScroll: true });   // opened from the keyboard
  }
  closeCluster(refocus = false) {
    if (!this.cluster) return;
    const chip = this.chips.get(this.cluster.key)?.node;
    chip?.setAttribute('aria-expanded', 'false');
    this.cluster = null;
    this.clusterPop.hidden = true;
    this.clusterPop.replaceChildren();
    if (!this.pointer && this.hover?.kind === 'agent') this.setHover(null);   // a row was hovered
    if (refocus) (chip?.isConnected ? chip : this.stage).focus({ preventScroll: true });
  }
  pickFromCluster(id) {
    this.closeCluster();
    if (this.agentById(id)) this.onClick({ kind: 'agent', id });   // the same as clicking that agent
  }
  /** The open cluster list rides above its group (below it near the top edge), kept inside the view. */
  placeClusterPop() {
    const pop = this.cluster;
    if (!pop) return;
    const p = this.groupPoint(pop.members);
    if (!p) { this.closeCluster(); return; }
    const { w: W, h: H } = this.world.size;
    const lift = LABEL_LIFT + CHIP_H + 8 - Math.min(0, this.chips.get(pop.key)?.dy || 0);
    const left = Math.max(8, Math.min(W - pop.w - 8, p.x - pop.w / 2));
    let top = p.y - lift - pop.h;
    if (top < 8) top = p.y + 12;
    top = Math.max(8, Math.min(H - pop.h - 8, top));
    this.clusterPop.style.transform = `translate3d(${left.toFixed(1)}px, ${top.toFixed(1)}px, 0)`;
  }
  /** WORLD point above a target (agents/owner: above the head; buildings: above the roof), so
   *  overlays track the island however it is turned. Spark points are "above" toward island -y. */
  targetPoint(target, lift = 0) {
    if (!target) return null;
    const world = this.world, at = (x, y, z) => world.toWorld(new THREE.Vector3(x, y, z));
    if (target.kind === 'agent' || target.kind === 'owner') { const p = this.npcs.position(target); return p ? at(p.x, p.y + this.npcs.headroom(target) + lift, p.z) : null; }
    if (target.kind === 'building') { const b = this.buildings.get(target.id), p = b?.topPoint(); return p ? at(p.x, p.y + lift, p.z) : null; }
    if (target.kind === 'hq') return at(0, 11.4 + lift, -2.95);
    if (target.kind === 'spark') { const b = this.spark.buildings.get(target.id), p = b?.topPoint(); return p ? at(p.x, p.y - lift, p.z) : null; }
    if (target.kind === 'runner') { const r = this.spark.runner(target.id); return r ? this.spark.runnerHead(r) : null; }
    if (target.kind === 'foundry') { const p = this.spark.foundryPoint(); return at(p.x, p.y - lift, p.z); }
    if (target.kind === 'gear') { const p = this.spark.gearPoint(target.id); return p ? at(p.x, p.y + lift, p.z) : null; }
    if (target.kind === 'plot') { const c = cellCenter(target.i, target.j); return at(c.x, GROUND_Y + 1.4 + lift, c.z); }
    if (target.kind === 'bridge') return at(target.x, this.npcs.surfaceY(target.x, target.z) + 0.5 + lift, target.z);
    if (target.kind === 'boat') { const boat = this.river.getBoat(target.id); return boat ? boat.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 1.4 + lift, 0)) : null; }
    return null;
  }
  /** The camera in island space (people turn to face it). */
  cameraLocal() { return this.world.toLocal(this.world.camera.position); }

  /* ---------------- input ---------------- */
  bindInput() {
    const canvas = this.world.renderer.domElement;
    canvas.addEventListener('pointermove', event => {
      const prev = this.pointer;
      this.pointer = { x: event.clientX, y: event.clientY };
      this.hoverDirty = true;
      if (this.down && Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 5) this.dragging = true;
      // Street view: a left-drag turns you (yaw only).
      if (this.street && this.down?.button === 0 && (event.buttons & 1) && prev) {   // button still held (an up lost off-canvas never keeps turning)
        const dx = event.clientX - prev.x;
        if (dx) { this.street.heading -= dx * STREET.drag; this.street.turned = true; }
      }
    });
    this.bindWheel();
    this.bindAgentDrag(canvas);
    canvas.addEventListener('pointerleave', () => { if (!this.agentDrag) { this.pointer = null; this.setHover(null); } });
    canvas.addEventListener('pointerdown', event => {
      this.down = { x: event.clientX, y: event.clientY, t: performance.now(), button: event.button }; this.dragging = false; this.closeCluster(); this.stage.focus({ preventScroll: true });
      // Street view: orbit controls are off, so nothing else captures the pointer; capture it so the up lands here.
      if (this.street) { try { canvas.setPointerCapture(event.pointerId); } catch { /* not capturable */ } }
    });
    canvas.addEventListener('pointerup', event => {
      const down = this.down; this.down = null;
      const wasDrag = this.dragging; this.dragging = false;
      if (!down || wasDrag || down.button !== 0 || performance.now() - down.t > 600 || !this.world.settled) return;
      this.onClick(this.pick(event.clientX, event.clientY));
    });
    canvas.addEventListener('dblclick', event => {
      this.onDoubleClick(this.pick(event.clientX, event.clientY), event.clientX, event.clientY);
    });
    canvas.addEventListener('contextmenu', event => event.preventDefault());
    this.onKeyDown = event => this.keyDown(event);
    this.onKeyUp = event => { this.world.keyUp(event.code); this.streetKeys.delete(event.code); };
    this.onBlur = () => { this.world.clearKeys(); this.streetKeys.clear(); this.world.releaseTilt?.(); };   // a held drag lets go: the island settles flat
  }
  onDoubleClick(target, clientX, clientY) {
    clearTimeout(this.plotClickTimer); this.plotClickTimer = 0;
    if (this.talk || !this.world.settled) return;
    if (target?.kind === 'foundry' || target?.kind === 'gear') return;
    if (target && !['owner', 'plot', 'bridge'].includes(target.kind)) {
      this.select(target.kind === 'spark' ? { kind: 'building', id: target.id } : target);
      this.focusSelection(); return;
    }
    if (this.street) return;
    if (target?.kind === 'bridge') { this.npcs.walkOwner(target.x, target.z); return; }
    const ground = this.world.groundAt(this.world.ndc(clientX, clientY));
    if (ground) this.npcs.walkOwner(ground.x, ground.z);
  }
  /** Drag to assign: a left press on an agent (This PC side up, island still, no talk / street view)
   *  is caught in the capture phase on the stage, before the orbit controls and the island tilt see
   *  it. A press that never moves is still a click on that agent; a drag carries the agent's ghost and
   *  a drop on a building opens "Give <agent> a task on <project>". */
  bindAgentDrag(canvas) {
    const end = () => {
      const d = this.agentDrag;
      if (!d) return null;
      this.agentDrag = null; this.dragging = false;
      this.dragGhost.hidden = true;
      this.stage.classList.remove('is-carrying');
      try { if (canvas.hasPointerCapture?.(d.pointerId)) canvas.releasePointerCapture(d.pointerId); } catch { /* released */ }
      return d;
    };
    this.stage.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || !event.isPrimary) return;
      if (event.target !== canvas || this.world.panMode || this.talk || this.street || this.streetPending || !this.world.settled || this.islands?.blocking || this.failed) return;
      const target = this.pick(event.clientX, event.clientY);
      if (target?.kind !== 'agent' || !this.agentById(target.id)) return;
      event.stopPropagation();   // no orbit, no tilt, no click handling below: this handler owns the gesture
      this.closeCluster(); this.stage.focus({ preventScroll: true });
      this.agentDrag = { id: target.id, x: event.clientX, y: event.clientY, pointerId: event.pointerId, moved: false, over: null };
      this.dragging = true;
      try { canvas.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
    }, { capture: true });
    canvas.addEventListener('pointermove', event => {
      const d = this.agentDrag;
      if (!d || event.pointerId !== d.pointerId) return;
      if (!d.moved && Math.hypot(event.clientX - d.x, event.clientY - d.y) < DRAG_START_PX) return;
      if (!d.moved) { d.moved = true; this.startCarry(d); }
      const base = this.cityRoot.getBoundingClientRect();
      this.dragGhost.style.transform = `translate3d(${(event.clientX - base.left).toFixed(1)}px, ${(event.clientY - base.top).toFixed(1)}px, 0)`;
      const target = this.pick(event.clientX, event.clientY);
      const over = target?.kind === 'building' ? target.id : null;
      if (over !== d.over) { d.over = over; this.setHover(over ? target : null); this.renderCarry(d); }
    });
    canvas.addEventListener('pointerup', event => {
      const d = this.agentDrag;
      if (!d || event.pointerId !== d.pointerId) return;
      end();
      this.setHover(null);
      if (!d.moved) { this.onClick({ kind: 'agent', id: d.id }); return; }   // a press without a drag: the usual click
      if (d.over) this.openAssign(d.id, d.over);
      else toast('Drop the agent on a building to give it a task there.', { timeout: 2600 });
    });
    canvas.addEventListener('pointercancel', () => { if (end()) this.setHover(null); });
    this.cancelAgentDrag = () => { if (end()) this.setHover(null); };
  }
  startCarry(d) {
    const agent = this.agentById(d.id);
    this.stage.classList.add('is-carrying');
    this.bubble.hidden = true; this.bubbleTarget = null;
    this.carrySig = '';
    this.renderCarry(d, agent);
    this.dragGhost.hidden = false;
  }
  renderCarry(d, agent = this.agentById(d.id)) {
    const project = d.over ? this.store.project(d.over) : null;
    const sig = `${d.id}|${d.over || ''}`;
    if (!agent || sig === this.carrySig) return;
    this.carrySig = sig;
    this.dragGhost.classList.toggle('is-over', Boolean(project));
    clear(this.dragGhost, portrait(agent.look, { size: 30, provider: agent.provider }),
      h('span.city-drag-text', project ? `Give ${shortName(agent.name)} a task on ${project.name}` : `Carrying ${shortName(agent.name)} · drop on a building`));
  }
  /** Wheel, touchpad scroll and pinch (WebView2 sends a pinch as Ctrl+wheel) zoom the city, handled
   *  ONCE here: a capture-phase listener on the whole City root, so labels, chips, the toolbar or
   *  the HUD under the pointer never swallow it and OrbitControls' own wheel zoom never runs too.
   *  Scrollable cards (side panel, help, cluster list) keep native scrolling, except for a pinch,
   *  which would otherwise zoom the whole app window. Safari-style gesture events zoom the same way. */
  bindWheel() {
    const root = this.cityRoot;
    root.addEventListener('wheel', event => {
      if (!this.visible || this.failed || !this.world || this.islands?.blocking) return;
      const scroller = event.target instanceof Element ? event.target.closest('.city-panel, .city-help, .city-cluster-pop, .city-talk, .city-jumpto-panel, .city-legend-content') : null;
      if (scroller && !event.ctrlKey) return;
      event.preventDefault(); event.stopPropagation();
      this.wheelZoom(wheelZoomLog(event), event.clientX, event.clientY);
    }, { capture: true, passive: false });
    let scale = 1;
    root.addEventListener('gesturestart', event => { event.preventDefault(); scale = 1; }, { passive: false });
    root.addEventListener('gesturechange', event => {
      event.preventDefault();
      const next = Number(event.scale) || 1;
      if (next > 0 && scale > 0) this.wheelZoom(Math.max(-0.6, Math.min(0.6, Math.log(scale / next))), event.clientX, event.clientY);
      scale = next;
    }, { passive: false });
    root.addEventListener('gestureend', event => event.preventDefault(), { passive: false });
  }
  /** One wheel / pinch step (log units, + = out). Street view: in stops at the closest follow
   *  distance, out past the farthest leaves. Overhead: smooth zoom toward the pointer; at the
   *  closest zoom with This PC side up, a hint, then one more step in starts street view. */
  wheelZoom(log, clientX, clientY) {
    if (!log) return;
    const now = performance.now(), world = this.world;
    if (now < (this.wheelMuteUntil || 0) || this.talk) return;   // let a street-view entry / exit flight play out; talk mode holds its shot
    if (this.street) {
      const back = this.street.back * Math.exp(log);
      if (back > STREET.max) { this.wheelMuteUntil = now + 700; this.exitStreet(); }
      else this.street.back = Math.max(STREET.min, back);
      return;
    }
    if (this.streetPending) return;
    const atMin = world.zoomGoal <= world.controls.minDistance * 1.06;
    world.queueZoom(log, clientX, clientY);
    const canStreet = world.settled && world.side === 'pc' && world.restSide === 'pc' && Boolean(this.npcs.owner);
    if (log > 0 || !canStreet || !atMin) { if (log > 0 || !canStreet) this.hideZoomHint(); return; }
    this.zoomOverAt = now;
    if (!this.zoomHintAt) { this.zoomHintAt = now; this.zoomOver = 0; this.zoomHint.hidden = false; return; }
    this.zoomOver = (this.zoomOver || 0) - log;
    if (now - this.zoomHintAt > 350 && this.zoomOver > 0.14) {
      this.hideZoomHint();
      this.wheelMuteUntil = now + 700;
      this.enterStreet();
    }
  }
  hideZoomHint() { this.zoomHintAt = 0; this.zoomOver = 0; if (!this.zoomHint.hidden) this.zoomHint.hidden = true; }
  /** What's under the pointer, on the face that's up only (a building hanging past the rim from the
   *  face that's down is not pickable), and nothing while the island is turning. */
  pick(clientX, clientY) {
    if (!this.world.settled) return null;
    const target = this.pickAny(clientX, clientY);
    return target && (target.kind === 'plot' || this.facesUp(target)) ? target : null;
  }
  pickAny(clientX, clientY) {
    const ndc = this.world.ndc(clientX, clientY);
    // Island slabs and the Spark deck are occluders: a ray never reaches through to the other side.
    const hit = this.world.raycast(ndc, [...this.npcs.pickables(), ...this.buildings.pickables(), ...this.world.hq.pickables, ...this.spark.pickables(), ...(!this.islands?.current ? [...this.river.pickables(), ...this.river.labelPickables(), ...this.river.occluders()] : []), ...this.world.occluders(), ...this.spark.occluders()]);
    if (!hit || hit.object.userData?.occluder) return this.plotAt(clientX, clientY);
    const object = hit.object;
    const person = this.npcs.targetOf(object);
    if (person) return person;
    for (let node = object; node; node = node.parent) {
      const data = node.userData || {};
      if (data.boatId) return this.river.getBoat(data.boatId) ? { kind: 'boat', id: data.boatId } : null;
      if (data.riverBridge) {
        const point = this.world.toLocal(hit.point.clone());
        return { kind: 'bridge', id: `bridge:${data.crossing?.id || data.crossingId || data.crossingX}`, x: point.x, z: point.z };
      }
      if (data.buildingId) return this.buildings.get(data.buildingId) ? { kind: 'building', id: data.buildingId } : null;
      if (data.sparkBuildingId) return this.spark.buildings.get(data.sparkBuildingId) ? { kind: 'spark', id: data.sparkBuildingId } : null;
      if (data.sparkFoundry) return { kind: 'foundry' };
      if (data.gearId) return { kind: 'gear', id: data.gearId };
      if (data.hq) return { kind: 'hq' };
    }
    return null;
  }
  /** An unoccupied lot of the top city under the pointer (roads, sidewalks and the HQ plaza excluded).
   *  Only while This PC side is up and the island is still. */
  plotAt(clientX, clientY) {
    if (!this.world.settled || this.world.side !== 'pc' || this.islands?.current) return null;   // no new projects on a contributor island
    const ground = this.world.groundAt(this.world.ndc(clientX, clientY));
    if (!ground) return null;
    const { i, j } = cellOf(ground.x, ground.z);
    if (!districtForCell({ i, j }, this.homeBanks)) return null;
    if ((!i && !j) || Math.max(Math.abs(i), Math.abs(j)) > this.rings) return null;
    const c = cellCenter(i, j);
    if (Math.abs(ground.x - c.x) > LOT_HALF - 0.15 || Math.abs(ground.z - c.z) > LOT_HALF - 0.15) return null;
    const parcel = riverLot(i, j);
    if (parcel && !pointInParcel(ground, parcel)) return null;
    const key = cellKey(i, j);
    if (this.occupied.has(key)) return null;
    const reservedBy = this.reserved.get(key);
    return { kind: 'plot', id: key, i, j, reservedBy: reservedBy ? reservedBy.id : null };
  }
  updateHover() { this.setHover(this.pointer ? this.pick(this.pointer.x, this.pointer.y) : null); }
  setHover(target) {
    const same = (a, b) => (a?.kind === b?.kind && a?.id === b?.id);
    if (same(target, this.hover)) { if (target) this.renderTag(target); return; }
    const prev = this.hover;
    if (prev?.kind === 'building') this.buildings.get(prev.id)?.setHover(false);
    if (prev?.kind === 'spark') this.spark.setHover(prev.id, false);
    if (prev?.kind === 'runner') this.spark.runner(prev.id)?.person.setHighlight(false);
    if (prev?.kind === 'plot') this.plotMarker.hide();
    if ((prev?.kind === 'agent' || prev?.kind === 'owner') && !same(prev, this.selection)) this.npcs.setHighlight(prev, false);
    this.hover = target;
    this.declutterAt = 0;   // expand the hovered person's label right away
    if (target?.kind === 'building') this.buildings.get(target.id)?.setHover(true);
    if (target?.kind === 'spark') this.spark.setHover(target.id, true);
    if (target?.kind === 'runner') this.spark.runner(target.id)?.person.setHighlight(true);
    if (target?.kind === 'plot' && !target.reservedBy) this.plotMarker.show(target.i, target.j);
    if (target?.kind === 'agent' || target?.kind === 'owner') this.npcs.setHighlight(target, true);
    this.stage.classList.toggle('is-pointing', Boolean(target));
    this.renderTag(target);
  }
  renderTag(target) {
    const info = this.describe(target);
    const sig = JSON.stringify(info);
    this.hoverInfo = info;
    if (!info) { this.tag.hidden = true; this.tagSig = ''; return; }
    if (sig === this.tagSig) return;
    this.tagSig = sig;
    clear(this.tag,
      info.status ? h(`span.city-gem.${info.status}`) : null,
      h('strong', info.title),
      info.sub ? h('span.city-tag-sub', info.sub) : null,
      info.badge ? h('span.city-tag-badge', info.badge) : null);
  }
  describe(target) {
    if (!target) return null;
    if (target.kind === 'bridge') return { title: 'River bridge', sub: 'Click to walk across the river' };
    if (target.kind === 'boat') return { title: 'River boat', sub: 'Click its label to center the boat' };
    if (target.kind === 'agent') {
      const agent = this.agentById(target.id);
      if (!agent) return null;
      const project = this.store.project(agent.currentProjectId);
      const badge = agent.kind === 'external' ? 'desktop' : agent.kind === 'session' ? 'CodaClauda' : agent.visiting ? 'visiting' : '';
      return { title: agent.name, status: agent.status, sub: `${statusText(agent)}${project && agent.status !== 'offline' ? ` · ${project.name}` : ''}`, badge };
    }
    if (target.kind === 'owner') return { title: this.store.avatar?.name || 'You', sub: this.street ? 'You · street view' : 'You · double-click to walk · G for street view' };
    if (target.kind === 'building') {
      const project = this.store.project(target.id);
      if (!project) return null;
      const floors = this.buildings.get(target.id)?.size.floors || project.metrics.floors;
      return { title: project.name, sub: `${floors} floor${floors === 1 ? '' : 's'} · ${project.primaryLanguage}` };
    }
    if (target.kind === 'hq') return this.islands?.hqInfo() || { title: 'CodaClauda HQ', sub: 'Town hall and plaza' };
    if (target.kind === 'plot') {
      if (!target.reservedBy) return { title: 'Empty plot', sub: 'Click to start a project here' };
      const owner = this.store.project(target.reservedBy);
      return { title: 'Reserved plot', sub: `${owner?.name || 'A project'} is hidden from the city · click to show it` };
    }
    if (target.kind === 'spark') {
      const project = this.store.project(target.id);
      if (!project) return null;
      if (this.sparkOffline) return { title: project.name, status: 'offline', sub: `DGX Spark · ${this.offlineText.replace(/^O/, 'o')} · click for last activity`, badge: 'Spark' };
      const n = this.spark.sparkJobs(target.id).length;
      return { title: project.name, status: n ? 'active' : 'offline', sub: n ? `DGX Spark · ${plural(n, 'job')} running` : 'DGX Spark · idle', badge: 'Spark' };
    }
    if (target.kind === 'runner') {
      const runner = this.spark.runner(target.id);
      if (runner?.crew) return { title: 'Spark crew', status: this.sparkOffline ? 'offline' : 'idle', sub: this.sparkOffline ? `DGX Spark ${this.offlineText.replace(/^O/, 'o')} · asleep` : 'Idle · no DGXBridge job running on the Spark' };
      if (!runner?.job) return null;
      const project = runner.anchor !== FOUNDRY ? this.store.project(runner.anchor) : null;
      return { title: runner.agent ? runner.agent.name : jobLabel(runner.job), status: 'active', sub: `DGX Spark · ${runner.agent ? `${jobLabel(runner.job)} · ` : ''}${project?.name || 'Spark Foundry'}${runner.job.started_at ? ` · started ${timeAgo(runner.job.started_at)}` : ''}` };
    }
    if (target.kind === 'foundry') {
      if (this.sparkOffline) return { title: 'Spark Foundry', status: 'offline', sub: `DGX Spark · ${this.offlineText.replace(/^O/, 'o')}` };
      const n = this.spark.sparkJobs(FOUNDRY).length;
      return { title: 'Spark Foundry', status: n ? 'active' : 'offline', sub: n ? `${plural(n, 'Spark job')} without a linked project` : 'Spark jobs without a linked project work here' };
    }
    if (target.kind === 'gear') {
      const jobs = this.spark.gearJobs(target.id);
      const project = target.id !== 'hq' ? this.store.project(target.id) : null;
      return { title: `This PC${project ? ` · ${project.name}` : ''}`, status: 'active', sub: `${plural(jobs.length, 'local job')}${jobs.length ? ` · ${jobs.slice(0, 2).map(jobLabel).join(', ')}` : ''}` };
    }
    return null;
  }
  /** Speech-bubble text for the Spark underside and local-job gears. */
  computeText(target) {
    const describeJobs = jobs => jobs.slice(0, 3).map(jobLabel).join('; ') + (jobs.length > 3 ? `; +${jobs.length - 3} more` : '');
    if (target.kind === 'runner') {
      const runner = this.spark.runner(target.id), job = runner?.job;
      if (runner?.crew) {
        const latest = (Array.isArray(this.machines.jobs) ? this.machines.jobs : []).filter(j => j && j.machine === 'spark').reduce((t, j) => Math.max(t, Number(j.finished_at) || Number(j.started_at) || 0), 0);
        if (this.sparkOffline) return `The Spark crew is asleep: the DGX Spark is ${this.offlineText.replace(/^O/, 'o')}.`;
        return `Spark crew, standing by. No DGXBridge job is running on the DGX Spark right now${latest ? ` (last one ${timeAgo(latest)})` : ''}. Agents always run on this PC; jobs they send to the Spark show up here.`;
      }
      if (!job) return 'This Spark job just finished.';
      const project = runner.anchor !== FOUNDRY ? this.store.project(runner.anchor) : null;
      const memory = Number(job.memory_gb ?? job.reserved_memory_gb);
      const who = runner.agent ? ` ${runner.agent.name} (running on this PC) most likely started it.` : '';
      return `${jobLabel(job)}${memory > 0 ? ` · ${memory} GB` : ''} — ${job.state || 'running'} on the DGX Spark${project ? ` for ${project.name}` : ''}${job.started_at ? `, started ${timeAgo(job.started_at)}` : ''}.${who}`;
    }
    if (target.kind === 'foundry') {
      if (this.sparkOffline) return `The Spark Foundry is dark: the DGX Spark is ${this.offlineText.replace(/^O/, 'o')}. Use “Check connection” in the Machines card to try again.`;
      const jobs = this.spark.sparkJobs(FOUNDRY);
      return jobs.length ? `Spark jobs not tied to a linked project: ${describeJobs(jobs)}.` : 'The Spark Foundry hosts DGX Spark jobs that are not tied to a linked project. Nothing is running here right now.';
    }
    if (target.kind === 'gear') {
      const jobs = this.spark.gearJobs(target.id);
      return jobs.length ? `Running on this PC: ${describeJobs(jobs)}.` : 'Nothing running on this PC right now.';
    }
    if (target.kind === 'spark') {
      // Spark offline: read-only, from the last status history the app still has.
      const project = this.store.project(target.id);
      const ids = [target.id, ...(project?.ids || [])];
      const job = this.spark.lastSparkJob(this.machines, ids);
      const when = job ? Number(job.finished_at) || Number(job.started_at) || 0 : 0;
      const last = job ? `Last Spark work: ${jobLabel(job)}${job.state ? ` (${job.state})` : ''}${when ? `, ${timeAgo(when)}` : ''}.` : 'No recent Spark work.';
      return `${project?.name || 'This building'} on the DGX Spark — ${this.offlineText.replace(/^O/, 'o')}. ${last}`;
    }
    return '';
  }

  keyDown(event) {
    if (!this.visible || this.failed || this.islands?.blocking) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const t = event.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector('dialog[open]')) return;
    const code = event.code;
    if (this.talk) { if (code === 'Escape') { event.preventDefault(); this.exitTalk(); } return; }   // talk mode: only Esc (the panel has the rest)
    if (STREET_KEYS.has(code)) {
      if (t?.tagName === 'BUTTON' && code.startsWith('Arrow')) return;
      event.preventDefault();
      if (this.street) this.streetKeys.add(code); else this.world.keyDown(code);
      return;
    }
    if (code === 'KeyF') { event.preventDefault(); this.focusSelection(); }
    else if (code === 'KeyH') { event.preventDefault(); this.resetCamera(); }
    else if (code === 'KeyV') { if (!event.repeat) { event.preventDefault(); this.flipSide(); } }
    else if (code === 'KeyM') { if (!event.repeat) { event.preventDefault(); this.findMe(); } }
    else if (code === 'KeyG') { if (!event.repeat) { event.preventDefault(); this.toggleStreet(); } }
    else if (code === 'KeyP') { if (!event.repeat) { event.preventDefault(); this.togglePan(); } }
    else if (code === 'Escape') { if (this.street || this.streetPending) this.exitStreet(); else if (this.cluster) this.closeCluster(true); else if (!this.help.hidden) this.toggleHelp(false); else this.select(null); }
    else if (event.key === '+' || event.key === '=') this.world.zoomBy(0.75);
    else if (event.key === '-' || event.key === '_') this.world.zoomBy(1.33);
  }

  /* ---------------- selection ---------------- */
  togglePan() {
    if (!this.world || this.street || this.streetPending || this.talk) return;
    if (this.following) this.toggleFollow(false);
    this.world.setPanMode(!this.world.panMode);
    this.renderToolbarState();
  }
  onClick(target) {
    // Talk mode: another agent switches the conversation; empty ground (or anything else but you) leaves it.
    if (this.talk) { if (target?.kind === 'agent') this.enterTalk(target.id); else if (target?.kind !== 'owner') this.exitTalk(); return; }
    if (target?.kind === 'building' && !this.islands?.current && this.world?.side === 'pc') {
      const project = this.buildings.get(target.id)?.project;
      if (project && isUnbuilt(project)) { this.cloneOutline(project); return; }
    }
    if (!target) { this.select(null); return; }
    if (target.kind === 'boat') { this.select(target); this.focusSelection(); return; }
    if (target.kind === 'bridge') { this.select(null); if (!this.street) this.npcs.walkOwner(target.x, target.z); return; }
    if (target.kind === 'plot') {
      clearTimeout(this.plotClickTimer);
      this.plotClickTimer = setTimeout(() => { this.plotClickTimer = 0; if (this.visible) this.startProjectOnPlot(target); }, 300);
      return;
    }
    if (target.kind === 'spark') {
      if (this.sparkOffline) { this.showBubble(target, this.computeText(target)); return; }   // read-only while the Spark is offline
      this.select({ kind: 'building', id: target.id }); return;
    }
    if (target.kind === 'runner' || target.kind === 'foundry' || target.kind === 'gear') { this.showBubble(target, this.computeText(target)); return; }
    if (target.kind === 'owner') {
      this.select(OWNER_TARGET);
      if (!this.street) this.npcs.greetOwner(this.cameraLocal());
      this.showBubble(OWNER_TARGET, this.street ? 'W/S to walk, A/D to turn. Esc takes you back up.' : 'Hi! Double-click anywhere on the island to walk me there, or press G for street view.');
      return;
    }
    if (target.kind === 'agent') { this.enterTalk(target.id); return; }   // agents: a conversation in the city
    this.select(target);
  }
  bubbleText(agent) {
    const project = this.store.project(agent.currentProjectId);
    const activity = String(agent.activity || '').replace(/\s+/g, ' ').trim();
    if (agent.kind === 'external') return `We can continue this conversation in a new session${project ? ` in ${project.name}` : ''}.`;
    if (agent.kind === 'session') {
      const where = project ? ` in ${project.name}` : '';
      if (agent.status === 'active') return `Working on a turn${where}.`;
      if (agent.status === 'error') return `My last turn${where} ended with an error. You can send me a follow-up here.`;
      return `Ready to talk${where}.`;
    }
    if (agent.status === 'offline') return `Powered down${activity ? ` — last: ${activity}` : ''}. I'll read the board on my next heartbeat.`;
    if (activity) return activity.length > 140 ? `${activity.slice(0, 137)}…` : activity;
    if (agent.status === 'active') return project ? `Working on ${project.name}.` : 'Working away!';
    return project ? `Hanging around ${project.name}.` : 'Just strolling the plaza.';
  }
  showBubble(target, text) {
    this.bubble.textContent = text;
    this.bubble.hidden = false;
    this.bubbleTarget = target;
    this.bubbleUntil = performance.now() + 6500;
  }
  select(target) {
    const prev = this.selection;
    const person = t => t?.kind === 'agent' || t?.kind === 'owner';
    if (person(prev) && !(this.hover?.kind === prev.kind && this.hover.id === prev.id)) this.npcs.setHighlight(prev, false);
    this.selection = target || null;
    this.declutterAt = 0;
    this.buildings.select(this.selection?.kind === 'building' ? this.selection.id : null);
    if (person(this.selection)) this.npcs.setHighlight(this.selection, true);
    if (!this.selection && person(this.bubbleTarget)) { this.bubble.hidden = true; this.bubbleTarget = null; }
    this.panelSig = '';
    this.taskFormFor = null;
    this.taskDraft = null;
    this.refreshPanel();
    this.updateCameraFrame();
  }
  /** Fly to the selection. People, the HQ and your avatar live on This PC's face: if the Spark side
   *  is up, the island turns back over first. A building is framed on whichever face is up. */
  focusSelection() {
    const world = this.world, s = this.selection;
    this.boatFocus = null;
    if (this.talk) this.exitTalk({ instant: true });
    if (this.street || this.streetPending) this.exitStreet({ fly: false });   // any framing flight leaves street view
    if (this.following) this.toggleFollow(false);
    this.updateCameraFrame();
    const fly = (x, y, z, distance, polar) => world.flyAfterTurn({ target: world.toWorld(new THREE.Vector3(x, y, z), { atRest: true }), distance, polar }, { center: true });
    const frame = (object, minimum = 12, settled = [], polar = 1, building = false, focusObject = object) => {
      const bounds = focusBounds(object, world, settled);
      if (!bounds) return false;
      const azimuth = world.azimuth;
      const size = bounds.getSize(new THREE.Vector3()), lens = world.framingLens?.() || { fov: world.camera.fov, aspect: world.camera.aspect };
      const focusSize = building ? (focusBounds(focusObject, world, settled)?.getSize(new THREE.Vector3()) || size) : size;
      const distance = building
        ? Math.max(buildingFocusDistance({ width: focusSize.x, height: focusSize.y, depth: focusSize.z }, lens.fov, lens.aspect, { polar, azimuth, minDistance: 32 }), boxFitDistance(size, { ...lens, polar, azimuth, margin: .25 }))
        : Math.max(minimum, boxFitDistance(size, { ...lens, polar, azimuth, margin: .25 }));
      world.flyAfterTurn({ target: bounds.getCenter(new THREE.Vector3()), distance, polar, azimuth }, { center: true });
      return true;
    };
    const pcFirst = () => { if (world.underside) world.flipTo('pc'); };
    if (!s || s.kind === 'owner') { const owner = this.npcs.ownerPosition; if (owner) { pcFirst(); if (!frame(this.npcs.owner?.person.object, s ? 11 : 16)) fly(owner.x, owner.y + 1, owner.z, s ? 11 : 16, s ? 1.1 : 1.0); } return; }
    if (s.kind === 'agent') {
      const p = this.npcs.position(s);
      if (p) { pcFirst(); if (!frame(this.npcs.npcs?.get(s.id)?.person.object, 13)) fly(p.x, p.y + 1, p.z, 13, 1.02); }
    } else if (s.kind === 'building' || s.kind === 'spark') {
      if (s.kind === 'spark' && world.underside) world.flipTo('spark');
      const spark = world.restSide === 'spark' && this.spark.shown ? this.spark.buildings.get(s.id) : null;
      const b = spark || this.buildings.get(s.id);
      if (b) frame(b.group, 32, [b.tower, b.padGroup], .82, true, b.tower);
    } else if (s.kind === 'boat') {
      const boat = this.river.getBoat(s.id);
      if (boat) {
        if (world.underside) world.flipTo(boat.position.y < -3.6 ? 'spark' : 'pc');
        // Water sits below the quay: look down past its rail instead of through it.
        frame(boat, 10, [], .62);
        if (world.settled && world.tween) this.boatFocus = { id: s.id, tween: world.tween };
      }
    } else if (s.kind === 'hq') { pcFirst(); if (!frame(world.hq.group, 26)) fly(0, 3, -.5, 26, 1); }
    else if (s.kind === 'runner') {
      // Spark runners and crew live on the Spark face: roll it up first, then fly to where they'll be.
      const r = this.spark.runner(s.id);
      if (r) {
        if (world.underside && world.restSide !== 'spark') world.flipTo('spark');
        frame(r.person.object, 13);
      }
    }
  }
  updateBoatFocus() {
    const focus = this.boatFocus, world = this.world;
    if (!focus) return;
    const tween = focus.tween, finished = !world.tween && tween.t >= 1;
    if ((!finished && world.tween !== tween) || !world.centerTarget || !world.settled || this.selection?.kind !== 'boat' || this.selection.id !== focus.id) { this.boatFocus = null; return; }
    const bounds = focusBounds(this.river.getBoat(focus.id), world);
    if (!bounds) { this.boatFocus = null; return; }
    tween.toTarget.copy(bounds.getCenter(new THREE.Vector3()));
    world.applyTween(tween, tween.t);
    if (finished) this.boatFocus = null;
  }
  /** show({ focusProject }) / show({ focusAgent }) once those exist in the scene. */
  tryPendingFocus() {
    const pending = this.pendingFocus;
    if (!pending || !this.visible || this.talk) return;   // talk mode holds its shot: the focus waits until the conversation ends
    if (performance.now() - pending.at > (pending.ttl || 15000)) { this.pendingFocus = null; return; }
    let target = null;
    if (pending.kind === 'building') { const id = this.store.project(pending.id)?.id || pending.id; if (this.buildings.get(id)) target = { kind: 'building', id }; }
    else if (pending.kind === 'agent' && this.npcs.position({ kind: 'agent', id: pending.id })) target = { kind: 'agent', id: pending.id };
    if (!target) return;
    this.pendingFocus = null;
    this.select(target);
    this.focusSelection();
  }
  onJump(target) {
    if (!target) return;
    if (target.kind === 'agent') { this.enterTalk(target.id); return; }
    if (this.talk) this.exitTalk({ instant: true });
    const { kind, id } = target;
    if (kind === 'spark' && !id) {
      if (this.street || this.streetPending) this.exitStreet({ fly: false });
      if (this.following) this.toggleFollow(false);
      this.select(null);
      this.world.flipTo('spark');
      this.world.resetView();
      this.stage.focus({ preventScroll: true });
      return;
    }
    this.select(target);
    this.focusSelection();
    if (kind === 'agent') { const agent = this.agentById(id); if (agent) this.showBubble(target, this.bubbleText(agent)); }
    this.stage.focus({ preventScroll: true });
  }

  /* ---------------- panels ---------------- */
  refreshBuildingTalkAction() {
    if (!this.talkPanel?.isOpen) return;
    const project = this.talkPanel.info()?.project;
    const action = offersBuildingSession(project, { side: this.world?.restSide, remote: Boolean(this.islands?.current) })
      ? this.newSessionHere : undefined;
    if (this.talkPanel.onNewSessionHere === action) return;
    // Bind the documented public hook only for the currently eligible project.
    // Eligibility can change as the island flips or project metadata refreshes.
    this.talkPanel.onNewSessionHere = action;
    this.talkPanel.refresh();
  }
  openBuildingSessionControls(projectId) {
    const project = this.store.project(projectId);
    if (!this.visible || !offersBuildingSession(project, { side: this.world?.restSide, remote: Boolean(this.islands?.current) })) return;
    this.exitTalk();
    this.select({ kind: 'building', id: project.id });
    this.focusSelection();
    this.buildingSessions.focus();
  }
  refreshPanel() {
    const s = this.selection;
    if (!s || s.kind === 'boat') { this.panel.hidden = true; this.root.classList.remove('city-has-panel'); this.panelSig = ''; return; }
    let sig, render;
    const island = this.islands?.panelFor(s);   // contributor island: repo and town-hall cards
    if (island) ({ sig, render } = island);
    else if (s.kind === 'agent') {
      const agent = this.agentById(s.id);
      if (!agent) { this.select(null); return; }
      sig = JSON.stringify(['agent', agent.id, agent.name, agent.label, agent.status, agent.activity, agent.currentProjectId, agent.homeProjectId, agent.visiting, Math.floor((Date.now() - agent.lastSeenAt) / 60000), agent.unreadForOwner, agent.look, this.store.projects.map(p => [p.id, p.name])]);
      render = () => (extraKind(agent) ? this.renderSessionPanel(agent) : this.renderAgentPanel(agent));
    } else if (s.kind === 'building') {
      const project = this.store.project(s.id);
      if (!project || !project.visible.city) { this.select(null); return; }
      const here = this.agentsAt(project.id).map(a => [a.id, a.status, a.look]);
      const compute = [...this.spark.sparkJobs(project.id), ...this.spark.gearJobs(project.id)].map(j => [j.job, j.state, j.machine]);
      const ci = this.ci?.status(project.id);
      let access = '';
      try { access = this.islands?.current ? '' : this.store.projectAccess(project).level; } catch { /* islands */ }
      sig = JSON.stringify(['building', project.id, project.name, project.description, project.metrics, project.languages, project.source, project.private, project.path, project.url, here, compute, ci ? [ci.at, ci.error] : null, access, this.world.restSide, Math.floor(Date.now() / 60000)]);
      render = () => this.renderBuildingPanel(project);
    } else if (s.kind === 'owner') {
      sig = JSON.stringify(['owner', this.store.avatar, Boolean(this.following), Boolean(this.street || this.streetPending)]);
      render = () => this.renderOwnerPanel();
    } else if (s.kind === 'runner') {
      // Spark runner or crew bot: its own card, never the HQ card. Gone (job finished, Spark hidden) → deselect.
      const runner = this.spark.runner(s.id);
      if (!runner || (!runner.crew && !runner.job)) { this.select(null); return; }
      const agent = runner.agent;
      sig = JSON.stringify(['runner', runner.id, Boolean(runner.crew), this.sparkOffline, this.computeText(s), agent ? [agent.id, agent.name, agent.status, agent.look] : null, Math.floor(Date.now() / 60000)]);
      render = () => this.renderRunnerPanel(runner, s);
    } else {
      sig = JSON.stringify(['hq', this.allAgents().map(a => [a.id, a.status]), this.store.visibleProjects('city').length]);
      render = () => this.renderHqPanel();
    }
    if (sig === this.panelSig) return;
    if (this.panel.contains(document.activeElement) && document.activeElement.matches('select, input, textarea')) return; // don't yank a control mid-edit
    this.panelSig = sig;
    this.panel.hidden = false;
    this.root.classList.add('city-has-panel');
    const scroll = this.panel.scrollTop;
    render();
    this.panel.scrollTop = scroll;
  }
  agentsAt(projectId) {
    const project = this.store.project(projectId), ids = new Set([projectId, ...(project?.ids || [])]);
    return this.allAgents().filter(a => ids.has(a.cityProjectId));
  }
  panelHead(art, title, sub, extra) {
    return h('header.city-panel-head', art, h('div.city-panel-title', h('h2', title), sub ? h('p', sub) : null),
      h('div.city-panel-head-actions', extra, iconButton('close', 'Close panel', () => this.select(null))));
  }

  renderAgentPanel(agent) {
    const store = this.store;
    const current = store.project(agent.currentProjectId), home = store.project(agent.homeProjectId);
    const provider = agent.provider || 'other';
    const isMailbox = agent.kind === 'mailbox' && agent.address;
    const homeSelect = h('select.select', { 'aria-label': 'Home project', onchange: event => { store.setAgentPrefs(agent.id, { home: event.target.value || null }); toast(event.target.value ? `${agent.name} now lives at ${store.project(event.target.value)?.name || 'that project'}` : `${agent.name}'s home is automatic again`, { kind: 'success', timeout: 2600 }); } },
      h('option', { value: '' }, 'Automatic (manifest / best match)'),
      ...[...store.projects].sort((a, b) => a.name.localeCompare(b.name)).map(p => h('option', { value: p.id }, p.name + (p.visible.city ? '' : ' (hidden)'))));
    homeSelect.value = store.desktop?.agents?.[agent.id]?.home && home ? home.id : '';
    const facts = h('dl.city-facts',
      h('dt', 'Status'), h('dd', statusDot(agent.status), ' ', STATUS_LABEL[agent.status] || agent.status),
      h('dt', 'Current project'), h('dd', current
        ? h('span.city-inline', h('button.city-link', { type: 'button', onclick: () => { this.select({ kind: 'building', id: current.id }); this.focusSelection(); } }, current.name), agent.visiting ? pill('Visiting', 'warning') : null)
        : h('span.muted', 'None right now')),
      h('dt', 'Home'), h('dd', homeSelect),
      h('dt', 'Last seen'), h('dd', agent.lastSeenAt ? h('span', { title: fullTime(agent.lastSeenAt) }, timeAgo(agent.lastSeenAt)) : h('span.muted', 'No activity yet')),
      h('dt', 'Unread for you'), h('dd', agent.unreadForOwner ? pill(`${agent.unreadForOwner} unread`, 'accent') : h('span.muted', 'None')));
    const askBtn = isMailbox ? h('button.btn.small', { type: 'button', onclick: event => this.askStatus(agent, event.currentTarget) }, icon('reply'), 'Ask for status') : null;
    const taskBtn = h('button.btn.small', { type: 'button', disabled: !isMailbox, title: isMailbox ? 'Post a task to this agent' : 'Dedicated workers take tasks from Agent setup; start a session in Chat to talk', onclick: () => { this.taskFormFor = this.taskFormFor === agent.id ? null : agent.id; this.panelSig = ''; this.refreshPanel(); } }, icon('plus'), 'Assign a task here');
    clear(this.panel,
      this.panelHead(portrait(agent.look, { size: 52, provider, status: agent.status }), agent.name, agent.label && agent.label !== agent.name ? agent.label : null,
        iconButton('crosshair', 'Center view (F)', () => this.focusSelection())),
      h('div.city-panel-pills', pill(PROVIDER_LABEL[provider] || PROVIDER_COLORS[provider]?.label || 'Agent', provider === 'other' ? 'accent' : provider), pill(agent.kind === 'mailbox' ? 'Desktop chat · mailbox' : 'Dedicated worker', 'neutral')),
      h('section.city-panel-section', h('div.city-section-label', 'Doing'), agent.activity ? h('p.city-activity', String(agent.activity).slice(0, 400)) : h('p.muted', 'No recent activity on the board.')),
      facts,
      h('div.city-actions',
        h('button.btn.small.primary', { type: 'button', title: 'Walk over and talk here in the city', onclick: () => this.enterTalk(agent.id) }, icon('chat'), 'Talk'),
        h('button.btn.small', { type: 'button', onclick: () => this.ctx.navigate('chat', { agentId: agent.id }) }, icon('chat'), 'Open in Chat'),
        askBtn, taskBtn,
        (current || home) && ['claude', 'codex'].includes(agent.provider)
          ? h('button.btn.small', { type: 'button', title: `Start a CodaClauda ${PROVIDER_NAME[agent.provider]} chat in ${(current || home).name} with a task (or drag ${agent.name} onto any building)`, onclick: () => this.openAssign(agent.id, (current || home).id) }, icon('play'), 'Give a task in a chat…')
          : null),
      this.taskFormFor === agent.id && isMailbox ? this.taskForm(agent, current || home) : null,
      h('p.city-note', isMailbox ? MAILBOX_NOTE : 'A dedicated worker runs one task per request. To talk with Claude Code or Codex, start a session in Chat.'));
  }
  /** A CodaClauda session or a desktop session (zero-config agents): status, folder and what you can do. */
  renderSessionPanel(agent) {
    const project = this.store.project(agent.currentProjectId);
    const session = agent.kind === 'session' ? sessions.session(agent.sessionId) : null;
    const who = PROVIDER_NAME[agent.provider] || 'Agent';
    const projectLink = project
      ? h('button.city-link', { type: 'button', onclick: () => { this.select({ kind: 'building', id: project.id }); this.focusSelection(); } }, project.name)
      : h('span.muted', agent.cwd ? 'Not a linked project' : 'Unknown folder');
    const giveBtn = h('button.btn.small', { type: 'button', disabled: !project, title: project ? `Give ${agent.name} a task on ${project.name}` : 'Drag this agent onto a building to give it a task there', onclick: () => project && this.openAssign(agent.id, project.id) }, icon('plus'), 'Give a task…');
    const facts = h('dl.city-facts',
      h('dt', 'Status'), h('dd', h(`span.city-gem.${agent.status}`), ' ', statusText(agent)),
      h('dt', 'Project'), h('dd', projectLink),
      agent.cwd ? [h('dt', 'Folder'), h('dd.city-path', { title: agent.cwd }, agent.cwd)] : null,
      session ? [h('dt', 'Access'), h('dd', session.access === 'full' ? 'Full access' : 'Read only')] : null,
      session?.worktreePath ? [h('dt', 'Worktree'), h('dd.city-path', { title: session.worktreePath }, session.branch || session.worktreePath)] : null,
      h('dt', agent.kind === 'external' ? 'File changed' : 'Last activity'), h('dd', agent.lastSeenAt ? h('span', { title: fullTime(agent.lastSeenAt) }, timeAgo(agent.lastSeenAt)) : h('span.muted', 'Unknown')));
    const actions = agent.kind === 'session'
      ? [h('button.btn.small.primary', { type: 'button', onclick: () => this.ctx.navigate('chat', { thread: session?.sharedId ? `pair:${session.sharedId}` : `sess:${agent.sessionId}` }) }, icon('chat'), 'Open in Chat'), giveBtn]
      : [giveBtn, h('button.btn.small', { type: 'button', onclick: () => this.ctx.navigate('chat') }, icon('chat'), 'Chat')];
    const note = agent.kind === 'external'
      ? `${who} is running on this PC outside CodaClauda (seen from its session file's timestamp; no conversation content is read). CodaClauda can't message it: a task you give it here starts a CodaClauda ${who} chat in that project instead.`
      : `A ${who} chat started from CodaClauda. Drag it onto another building to give it a task there (that starts a new chat in that project).`;
    clear(this.panel,
      this.panelHead(portrait(agent.look, { size: 52, provider: agent.provider, status: agent.status }), agent.name, agent.label,
        iconButton('crosshair', 'Center view (F)', () => this.focusSelection())),
      h('div.city-panel-pills', pill(who, agent.provider), pill(agent.kind === 'external' ? 'Desktop session' : 'CodaClauda session', 'neutral'), agent.status === 'error' ? pill('Error', 'danger') : null),
      h('section.city-panel-section', h('div.city-section-label', 'Doing'), h('p.city-activity', agent.activity || '')),
      facts,
      h('div.city-actions.wrap', actions),
      h('p.city-note', note));
  }
  /** Drag to assign / Give a task…: "Give <agent> a task on <project>" (city/assign.js). */
  openAssign(agentId, projectId) {
    const agent = this.agentById(agentId), project = this.store.project(projectId);
    if (!agent || !project) return;
    if (this.talk) this.exitTalk({ instant: true });
    openAssignDialog({ store: this.store, sessions, navigate: (view, params) => this.ctx.navigate(view, params) }, agent, project);
  }
  taskForm(agent, defaultProject) {
    this.taskDraft ||= { title: '', detail: '' };
    const title = h('input.input', { type: 'text', placeholder: 'What should they do?', 'aria-label': 'Task title', maxlength: '200', oninput: e => { this.taskDraft.title = e.target.value; } });
    const detail = h('textarea.textarea', { rows: 3, placeholder: 'Details (optional)', 'aria-label': 'Task details', oninput: e => { this.taskDraft.detail = e.target.value; } });
    title.value = this.taskDraft.title; detail.value = this.taskDraft.detail;
    const projectSelect = h('select.select', { 'aria-label': 'Project' }, h('option', { value: '' }, 'No specific project'), ...[...this.store.projects].sort((a, b) => a.name.localeCompare(b.name)).map(p => h('option', { value: p.id }, p.name)));
    projectSelect.value = defaultProject?.id || '';
    const submit = h('button.btn.small.primary', { type: 'submit' }, icon('send'), 'Send task');
    const form = h('form.city-task-form', {
      onsubmit: async event => {
        event.preventDefault();
        const text = title.value.trim();
        if (!text) { title.focus(); return; }
        submit.disabled = true;
        try {
          await this.store.createTask({ agent, project: this.store.project(projectSelect.value) || null, title: text, detail: detail.value.trim() });
          toast(`Task posted to ${agent.name}. They'll pick it up on their next board check.`, { kind: 'success' });
          this.taskDraft = null; this.taskFormFor = null; this.panelSig = ''; this.refreshPanel();
        } catch (error) { toast(`Could not post the task: ${error.message}`, { kind: 'error' }); submit.disabled = false; }
      },
    },
    h('label.field', 'Task', title),
    h('label.field', 'Details', detail),
    h('label.field', 'Project', projectSelect),
    h('div.city-form-actions', h('button.btn.small.ghost', { type: 'button', onclick: () => { this.taskFormFor = null; this.panelSig = ''; this.refreshPanel(); } }, 'Cancel'), submit));
    requestAnimationFrame(() => { if (!title.value) title.focus({ preventScroll: true }); });
    return form;
  }
  async askStatus(agent, button) {
    const project = this.store.project(agent.currentProjectId);
    button.disabled = true;
    try {
      await this.store.post({ to: agent.address, kind: 'question', subject: 'Status check' + (project ? ' [' + project.name + ']' : ''), body: 'Quick status check from the City view: what are you working on, and anything blocked?' });
      toast(`Asked ${agent.name} for a status update. It will see the question when it next checks its inbox.`, { kind: 'success', timeout: 7000 });
    } catch (error) { toast(`Could not post: ${error.message}`, { kind: 'error' }); }
    finally { button.disabled = false; }
  }

  renderBuildingPanel(project) {
    const store = this.store, m = project.metrics || {};
    const swatch = h('span.city-swatch', { style: { '--swatch': project.color } }, icon('city'));
    const sources = [];
    if (project.source === 'local' || project.source === 'both') sources.push(pill('Local folder', 'neutral'));
    if (project.source === 'github' || project.source === 'both') sources.push(h('span.pill.neutral', icon('github'), 'GitHub'));
    if (project.private) sources.push(pill('Private', 'warning'));
    if (m.commits7d) sources.push(pill('Active this week', 'success'));
    sources.push(pill(districtOf(project) === DOWNTOWN ? 'Downtown' : 'Suburbs', 'neutral'));
    if (isUnbuilt(project)) sources.push(pill('Unbuilt · not on this PC', 'neutral'));
    const total = (project.languages || []).reduce((n, l) => n + (l.bytes || 0), 0);
    const langs = total ? [...project.languages].sort((a, b) => b.bytes - a.bytes) : [];
    const langBar = langs.length ? h('div.city-langbar', { role: 'img', 'aria-label': langs.slice(0, 5).map(l => `${l.name} ${Math.round(l.bytes / total * 100)}%`).join(', ') },
      ...langs.map(l => h('span.city-langbar-seg', { style: { flexGrow: String(Math.max(l.bytes, total * 0.004)), background: l.color }, title: `${l.name} ${Math.round(l.bytes / total * 100)}%` }))) : null;
    const langLegend = langs.length ? h('div.city-lang-legend', ...langs.slice(0, 4).map(l => h('span.city-lang', h('span.city-lang-dot', { style: { background: l.color } }), l.name, h('span.muted', ` ${Math.max(1, Math.round(l.bytes / total * 100))}%`)))) : h('p.muted', 'No language data yet.');
    const stat = (label, value, hint) => h('div.city-stat', h('div.city-stat-value', value), h('div.city-stat-label', label), hint ? h('div.city-stat-hint', hint) : null);
    const building = this.buildings.get(project.id);
    const here = this.agentsAt(project.id);
    const actions = [h('button.btn.small', { type: 'button', onclick: () => this.ctx.navigate('tasks', { project: project.id }) }, icon('tasks'), 'Open tasks')];
    if (project.path) actions.push(h('button.btn.small', { type: 'button', onclick: () => this.open(project.path) }, icon('folder'), 'Open folder'));
    if (isUnbuilt(project)) actions.unshift(h('button.btn.small.primary', { type: 'button', onclick: () => this.cloneOutline(project) }, icon('folder'), 'Clone to this PC'));
    if (project.url) actions.push(h('button.btn.small', { type: 'button', onclick: () => this.open(project.url) }, icon('github'), 'Open on GitHub'));
    if (project.path) actions.push(h('button.btn.small', { type: 'button', onclick: event => this.rescan(project, event.currentTarget) }, icon('refresh'), 'Rescan'));
    actions.push(h('button.btn.small.ghost', { type: 'button', onclick: () => this.hideProject(project) }, icon('eyeOff'), 'Hide from city'));
    const jobRow = (job, spark) => h('div.city-job', h(`span.city-job-where.${spark ? 'spark' : 'local'}`, spark ? 'DGX Spark' : 'This PC'), h('span.city-job-label', jobLabel(job)), job.started_at ? h('span.city-job-time', timeAgo(job.started_at)) : null);
    const sparkJobs = this.spark.sparkJobs(project.id), localJobs = this.spark.gearJobs(project.id);
    const compute = sparkJobs.length || localJobs.length
      ? h('section.city-panel-section', h('div.city-section-label', 'Compute jobs running'), h('div.city-jobs', ...sparkJobs.map(j => jobRow(j, true)), ...localJobs.map(j => jobRow(j, false))))
      : null;
    const ci = this.ciSection(project);
    let accessRow = null;
    if (!this.islands?.current && typeof store.projectAccess === 'function') {
      const level = store.projectAccess(project).level;
      accessRow = h('div.city-access-row', h(`span.city-access-chip.is-${level}`, level === 'full' ? 'Full access' : 'Read only'),
        h('span.muted', level === 'full' ? 'Agents work without permission prompts' : 'Agents can read and explain, not change files'),
        h('button.city-link', { type: 'button', onclick: () => this.ctx.navigate('projects', { project: project.id }) }, 'Change'));
    }
    this.buildingSessions.setProject(project, { side: this.world.restSide, remote: Boolean(this.islands?.current) });
    const newSession = this.buildingSessions.node.hidden ? null : this.buildingSessions.node;
    clear(this.panel,
      this.panelHead(swatch, project.name, project.primaryLanguage ? `${project.primaryLanguage} · ${building?.size.floors || m.floors} floor${(building?.size.floors || m.floors) === 1 ? '' : 's'}` : null,
        iconButton('crosshair', 'Center view (F)', () => this.focusSelection())),
      sources.length ? h('div.city-panel-pills', sources) : null,
      newSession,
      newSession ? null : accessRow,
      h('div.city-actions.wrap', actions),
      project.description ? h('p.city-desc', project.description) : null,
      h('section.city-panel-section', h('div.city-section-label', 'Languages'), langBar, langLegend),
      h('div.city-stats',
        stat('Lines of code', formatNumber(m.loc || 0)),
        stat('Files', m.files ? formatNumber(m.files) : '—'),
        stat('Commits', m.commits ? formatNumber(m.commits) : '—', m.commits7d ? `+${m.commits7d} in 7 days` : null),
        stat('Last activity', m.lastActivityAt ? timeAgo(m.lastActivityAt) : '—', m.sizeBytes ? formatBytes(m.sizeBytes) : null)),
      h('section.city-panel-section', h('div.city-section-label', 'Agents here'),
        here.length ? h('div.city-people', ...here.map(a => h('button.city-person', { type: 'button', title: `Talk to ${a.name} · ${statusText(a)}${extraKind(a) ? '' : a.homeProjectId === project.id ? ' · lives here' : ' · visiting'}`, onclick: () => this.enterTalk(a.id) },
          portrait(a.look, { size: 34, provider: a.provider, status: a.status }), h('span', a.name))))
          : h('p.muted', newSession ? 'Nobody is here right now. Start a session above, or drag an agent here to give it a task.' : 'Nobody is here right now. Drag an agent onto this building to give it a task.')),
      ci,
      compute);
  }
  /** CI card section from the last ci_status poll (city/ci.js); null when there is nothing to say. */
  ciSection(project) {
    const r = this.ci?.status(project.id);
    if (!r) return null;
    const run = r.summary?.latest;
    const word = c => ({ success: 'Passed', failure: 'Failed', timed_out: 'Timed out', cancelled: 'Cancelled', skipped: 'Skipped', startup_failure: 'Failed to start' }[String(c || '').toLowerCase()] || String(c || 'Finished'));
    const row = run
      ? h('div.city-ci-row', h(`span.city-ci-dot.${r.summary.failing ? 'bad' : String(run.conclusion).toLowerCase() === 'success' ? 'ok' : 'neutral'}`),
        h('span.city-ci-text', h('strong', word(run.conclusion)), ` · ${String(run.name || 'Workflow').slice(0, 60)}${run.branch ? ` on ${String(run.branch).slice(0, 40)}` : ''}${run.at ? ` · ${timeAgo(run.at)}` : ''}`),
        /^https:\/\/github\.com\//.test(String(run.url || '')) ? h('button.city-link', { type: 'button', onclick: () => this.open(run.url) }, 'Open run') : null)
      : h('p.muted', r.error ? `Couldn't read CI: ${String(r.error).replace(/\s+/g, ' ').slice(0, 120)}` : 'No finished workflow runs yet.');
    return h('section.city-panel-section', h('div.city-section-label', 'CI', r.summary?.running ? h('span.muted', ' · a run is in progress') : null), row);
  }
  /** Your own card (Find me / clicking your avatar). */
  renderOwnerPanel() {
    const avatar = this.store.avatar;
    const inStreet = Boolean(this.street || this.streetPending);
    clear(this.panel,
      this.panelHead(portrait(avatar || { ...defaultAvatar(), name: 'You' }, { size: 52 }), avatar?.name || 'You', 'Your avatar',
        iconButton('crosshair', 'Center view (F)', () => this.focusSelection())),
      h('p.city-desc', 'This is you on the island. Double-click the ground to walk somewhere, or take a stroll at street level.'),
      h('div.city-actions.wrap',
        h('button.btn.small.primary', { type: 'button', onclick: () => this.toggleStreet() }, icon('city-street'), inStreet ? 'Exit street view' : 'Street view (G)'),
        h('button.btn.small', { type: 'button', 'aria-pressed': String(Boolean(this.following)), onclick: () => this.toggleFollow() }, icon('crosshair'), this.following ? 'Stop following' : 'Follow me'),
        h('button.btn.small', { type: 'button', onclick: () => this.ctx.navigate('avatar') }, icon('avatar'), avatar ? 'Edit avatar' : 'Create avatar')));
  }
  /** A Spark runner (one DGXBridge job) or the resting Spark crew (Jump to… → DGX Spark). */
  renderRunnerPanel(runner, target) {
    const job = runner.job, agent = runner.agent;
    const asleep = Boolean(runner.crew && this.sparkOffline);
    const center = iconButton('crosshair', 'Center view (F)', () => this.focusSelection());
    const machine = h('dd', h('span.city-job-where.spark', 'DGX Spark'), this.sparkOffline ? h('span.muted', ` ${this.offlineText.replace(/^O/, 'o')}`) : null);
    if (runner.crew) {
      clear(this.panel,
        this.panelHead(h('span.city-swatch', icon('city-chip')), 'Spark crew', asleep ? 'Asleep — Spark offline' : 'Resting — no Spark job running', center),
        h('p.city-desc', this.computeText(target)),
        h('dl.city-facts',
          h('dt', 'Machine'), machine,
          h('dt', 'Status'), h('dd', statusDot(asleep ? 'offline' : 'idle'), ' ', asleep ? 'Asleep — Spark offline' : 'Resting — no Spark job running')));
      return;
    }
    const project = runner.anchor !== FOUNDRY ? this.store.project(runner.anchor) : null;
    const cores = Number(job.reserved_cpu ?? job.cpu);
    const jobText = [job.runtime, Number.isFinite(cores) && cores > 0 ? `${fmtCores(cores)} core${cores === 1 ? '' : 's'}` : ''].filter(Boolean).map(String).join(' · ');
    const art = agent ? portrait(agent.look, { size: 52, provider: agent.provider || 'other', status: agent.status }) : h('span.city-swatch', icon('city-chip'));
    clear(this.panel,
      this.panelHead(art, agent ? agent.name : jobLabel(job), agent ? jobLabel(job) : 'DGX Spark job', center),
      h('p.city-desc', this.computeText(target)),
      h('dl.city-facts',
        h('dt', 'Machine'), machine,
        h('dt', 'Project'), h('dd', project
          ? h('button.city-link', { type: 'button', onclick: () => { this.select({ kind: 'building', id: project.id }); this.focusSelection(); } }, project.name)
          : 'Spark Foundry'),
        h('dt', 'Job'), h('dd', jobText || jobLabel(job)),
        h('dt', 'State'), h('dd', String(job.state || 'running')),
        h('dt', 'Started'), h('dd', job.started_at ? h('span', { title: fullTime(job.started_at) }, timeAgo(job.started_at)) : h('span.muted', 'Unknown')),
        agent ? [h('dt', 'Likely from'), h('dd', h('button.city-link', { type: 'button', onclick: () => { this.select({ kind: 'agent', id: agent.id }); this.focusSelection(); } }, agent.name), h('span.muted', ' · on this PC'))] : null));
  }
  renderHqPanel() {
    const agents = this.allAgents();
    const count = status => agents.filter(a => a.status === status).length;
    const own = agents.filter(a => a.kind === 'session').length, desktop = agents.filter(a => a.kind === 'external').length;
    clear(this.panel,
      this.panelHead(h('span.city-swatch.hq', icon('home')), 'CodaClauda HQ', 'Town hall and plaza'),
      h('p.city-desc', 'Agents without a home project gather here. Powered-down agents rest on the plaza benches; your avatar starts by the fountain.'),
      h('div.city-stats',
        h('div.city-stat', h('div.city-stat-value', String(count('active'))), h('div.city-stat-label', 'Working')),
        h('div.city-stat', h('div.city-stat-value', String(count('idle'))), h('div.city-stat-label', 'Awake')),
        h('div.city-stat', h('div.city-stat-value', String(count('offline'))), h('div.city-stat-label', 'Powered down')),
        h('div.city-stat', h('div.city-stat-value', String(this.store.visibleProjects('city').length)), h('div.city-stat-label', 'Buildings'))),
      own || desktop ? h('p.city-desc', `Also in town: ${[own ? plural(own, 'CodaClauda chat') : '', desktop ? `${plural(desktop, 'desktop session')} (Claude Code or Codex running outside CodaClauda, seen from session file times only)` : ''].filter(Boolean).join(' and ')}.`) : null,
      h('p.city-note', MAILBOX_NOTE),
      h('div.city-actions.wrap',
        h('button.btn.small.primary', { type: 'button', onclick: () => this.ctx.navigate('board') }, icon('board'), 'Message board'),
        h('button.btn.small', { type: 'button', onclick: () => this.ctx.navigate('agents') }, icon('agents'), 'Agents'),
        h('button.btn.small', { type: 'button', onclick: () => this.ctx.navigate('projects') }, icon('projects'), 'Projects')));
  }
  async open(target) {
    try { await this.ctx.bridge.desktop.openExternal(target); }
    catch (error) { toast(`Could not open: ${error.message}`, { kind: 'error' }); }
  }
  async rescan(project, button) {
    button.disabled = true;
    const label = button.lastChild; const before = label.textContent; label.textContent = 'Scanning…';
    try { await this.store.scanProject(project.path); toast(`${project.name} rescanned`, { kind: 'success', timeout: 2400 }); }
    catch (error) { toast(`Rescan failed: ${error.message}`, { kind: 'error' }); }
    finally { if (button.isConnected) { button.disabled = false; label.textContent = before; } }
  }
  hideProject(project) {
    this.store.setProjectSettings(project, { city: false });
    this.select(null);
    toast(`${project.name} is hidden from the city`, { kind: 'info', action: { label: 'Undo', run: () => this.store.setProjectSettings(project, { city: true }) } });
  }

  /* ---------------- HUD, labels, empty state ---------------- */
  syncLabels(agents) {
    const wanted = new Map(agents.map(a => [a.id, a]));
    if (this.npcs.owner) wanted.set('owner', null);
    for (const [key, label] of this.labels) if (!wanted.has(key) || (key !== 'owner' && !this.npcs.position({ kind: 'agent', id: key }))) { label.node.remove(); this.labels.delete(key); }
    for (const [key, agent] of wanted) {
      if (key !== 'owner' && !this.npcs.position({ kind: 'agent', id: key })) continue;
      let label = this.labels.get(key);
      if (!label) {
        const target = key === 'owner' ? OWNER_TARGET : { kind: 'agent', id: key };
        label = { node: h('button.city-label', { type: 'button', hidden: true,
          onclick: event => { event.stopPropagation(); this.onClick(target); } }),
          sig: '', kind: target.kind, full: false, show: false, on: false, w: null };
        this.labels.set(key, label); this.labelLayer.append(label.node);
      }
      label.agent = agent;
      label.name = String(agent ? agent.name : this.store.avatar?.name || 'You');
      label.node.setAttribute('aria-label', agent ? `Talk to ${label.name}` : 'Your avatar');
      this.renderLabel(label);
    }
    this.declutterAt = 0;
  }
  /** Compact label (status gem + short name) unless the person is selected or hovered: then the
   *  full name, "visiting" and what they're doing. */
  renderLabel(label) {
    const agent = label.agent, full = Boolean(label.full);
    const name = full || !agent ? label.name : shortName(label.name);
    const activity = full && agent ? String(agent.activity || '').replace(/\s+/g, ' ').trim().slice(0, 90) : '';
    const visiting = full && Boolean(agent?.visiting);
    const sig = JSON.stringify([agent ? agent.provider || 'other' : 'owner', agent?.status, name, full, visiting, activity]);
    if (label.sig === sig) return;
    label.sig = sig;
    label.w = null;   // measured on the next declutter pass once it shows; until then a guess
    label.estW = Math.round((agent ? 31 : 18) + Math.min(name.length * 6.6, full ? 240 : 150) + (visiting ? 61 : 0) + (agent ? 0 : 35) + (activity ? 5 + Math.min(activity.length * 6, 200) : 0));
    label.node.className = `city-label ${agent ? `provider-${agent.provider || 'other'}` : 'is-owner'}${full ? ' is-full' : ''}`;
    clear(label.node, agent ? h(`span.city-gem.${agent.status}`) : null, h('span.city-label-name', name),
      visiting ? h('span.city-label-tag', 'visiting') : null, agent ? null : h('span.city-label-tag.you', 'you'),
      activity ? h('span.city-label-activity', activity) : null);
  }
  /** Spark runner name tags: "codex · rust · 16 cores". */
  syncRunnerLabels() {
    const wanted = new Map(this.spark.shown ? this.spark.runnerList.map(r => [r.id, r]) : []);
    for (const [id, label] of this.runnerLabels) if (!wanted.has(id)) { label.node.remove(); this.runnerLabels.delete(id); }
    for (const [id, runner] of wanted) {
      let label = this.runnerLabels.get(id);
      if (!label) { label = { node: h('div.city-label', { hidden: true }), sig: '', kind: 'runner', show: false, on: false, w: null }; this.runnerLabels.set(id, label); this.labelLayer.append(label.node); }
      // Crew: "Idle" (asleep while the Spark is offline). A job with a likely agent: "Codex · chat — rust job".
      const asleep = runner.crew && this.sparkOffline;
      const text = runner.crew ? (asleep ? 'Asleep' : 'Idle') : runner.agent ? `${runner.agent.name.length > 30 ? `${runner.agent.name.slice(0, 29).trimEnd()}…` : runner.agent.name} — ${runner.job?.runtime || 'Spark'} job` : jobLabel(runner.job);
      const provider = runner.crew ? 'other' : runner.agent?.provider || runner.job?.provider || 'other';
      const gem = runner.crew ? (asleep ? 'offline' : 'idle') : 'spark';
      const sig = `${text}|${provider}|${gem}`;
      if (label.sig === sig) continue;
      label.sig = sig;
      label.w = null;
      label.estW = Math.round(31 + Math.min(String(text).length * 6.4, 210));
      label.node.className = `city-label is-runner${runner.crew ? ' is-crew' : ''} provider-${provider}`;
      clear(label.node, h(`span.city-gem.${gem}`), h('span.city-label-name', text));
    }
  }
  /** Machine load card (top right): this PC vs the DGX Spark. */
  renderMachines(m, mode) {
    const cores = Number(navigator.hardwareConcurrency) || 0;
    const local = m.local || {}, spark = m.spark || {};
    const offline = Boolean(m.enabled) && !m.online;
    // Agent sessions all run on this PC; the Spark only runs DGXBridge jobs (some started by those agents).
    const agents = this.allAgents() || [];
    const working = agents.filter(a => a.status === 'active').length, driving = this.spark?.drivingAgents || 0;
    const sparkJobs = (Array.isArray(m.jobs) ? m.jobs : []).filter(j => j && j.machine === 'spark');
    const when = j => Number(j.finished_at) || Number(j.started_at) || 0;
    const lastSpark = Number(spark.running) ? 0 : sparkJobs.reduce((t, j) => Math.max(t, when(j)), 0);
    const lastText = lastSpark ? `Last Spark job: ${timeAgo(lastSpark)}` : '';
    const sig = JSON.stringify([mode, this.machinesCollapsed, m.configured, m.enabled, m.online, m.offlineSince, m.error, local, { ...spark, hardware: null }, cores, Boolean(this.checking), this.checkResult || '', agents.length, working, driving, lastText]);
    if (sig === this.machinesSig) return;
    this.machinesSig = sig;
    const card = this.machinesCard;
    card.hidden = Boolean(m.enabled) && mode === 'off';   // not configured: always show the "set it up" chip
    if (card.hidden) return;
    const collapsed = this.machinesCollapsed;
    card.classList.toggle('is-collapsed', collapsed);
    const toggle = iconButton(collapsed ? 'city-chevron-down' : 'city-chevron-up', collapsed ? 'Show machine load' : 'Collapse machine load', () => {
      this.machinesCollapsed = !this.machinesCollapsed;
      storage.set(MACHINES_KEY, this.machinesCollapsed ? '1' : '0');
      this.machinesSig = '';
      this.renderMachines(this.machines, this.sparkMode());
    });
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const summary = !m.configured ? 'Spark not connected' : offline ? `This PC ${local.running || 0} running · Spark offline` : `This PC ${local.running || 0} · Spark ${spark.running || 0} running`;
    const head = h('header.city-machines-head', h('span.city-machines-title', icon('city-chip'), 'Machines'), collapsed ? h('span.city-machines-summary', summary) : null, toggle);
    if (collapsed) { clear(card, head); return; }
    if (!m.configured) { clear(card, head, h('p.city-machines-chip', icon('city-chip'), 'Spark not connected — set it up in the DGXBridge app')); return; }
    const row = (label, data, total, extra, cls = '') => {
      const used = Number(data.cpuReserved) || 0, running = Number(data.running) || 0;
      const frac = total ? Math.min(1, used / total) : 0;
      return h(`div.city-machine${cls}`,
        h('div.city-machine-top', h('strong', label), h('span.city-machine-jobs', h(`span.city-gem.${running ? 'active' : 'offline'}`), `${running} running`)),
        h('div.city-meter', { role: 'img', 'aria-label': `${fmtCores(used)} of ${total || 'unknown'} cores reserved` }, h('span.city-meter-fill', { style: { width: `${(frac * 100).toFixed(1)}%` } })),
        h('div.city-machine-meta', h('span', `${fmtCores(used)}/${total || '—'} cores`), h('span', { title: CORE_H_NOTE }, `${fmtHours(Number(data.cpuHours24h) || 0)} core-h reserved (24 h)`), extra));
    };
    const healthy = spark.healthy === true;
    const route = offline
      ? h('span.city-offline-badge', { title: m.offlineSince ? `Last answered ${fullTime(m.offlineSince)}` : 'The Spark has not answered yet' }, h('span.city-health.bad'), offlineLabel(m.offlineSince))
      : h('span.city-machine-route', { title: healthy ? 'Spark scheduler healthy' : 'Spark scheduler not responding' },
        h(`span.city-health.${healthy ? 'ok' : 'bad'}`), prettyRoute(spark.route) || (spark.reachable ? 'Connected' : 'Not reachable'));
    const check = offline || this.checkResult
      ? h('div.city-machines-check',
        h('button.btn.small', { type: 'button', disabled: Boolean(this.checking), onclick: () => this.checkConnection() },
          this.checking ? h('span.spinner', { 'aria-hidden': 'true' }) : icon('refresh'), this.checking ? 'Checking…' : 'Check connection'),
        this.checkResult ? h(`span.city-machines-result${this.checkOk ? '.ok' : ''}`, { role: 'status' }, this.checkResult) : null)
      : null;
    // Where agents run (all on this PC) and where DGXBridge jobs ran: two separate, labelled facts.
    const runsOn = h('div.city-split', { title: 'Every agent session (Claude, Codex, …) runs on this PC. The DGX Spark runs DGXBridge jobs; an agent shows on the Spark side while a job it likely started is running there.' },
      h('div.city-split-label', 'Agents run on'),
      h('div.city-split-row', h('span.city-split-key.local'), h('span', `This PC · ${plural(agents.length, 'agent')}${agents.length ? ` (${working} working)` : ''}`)),
      h('div.city-split-row', h('span.city-split-key.spark'), h('span', `DGX Spark · 0 agents${driving ? ` · ${plural(driving, 'agent')} driving jobs from this PC` : ''}`)));
    const sj = (Number(spark.finished24h) || 0) + (Number(spark.running) || 0), lj = (Number(local.finished24h) || 0) + (Number(local.running) || 0);
    const jobsLabel = `${sj} on Spark · ${lj} on This PC`;
    const split = sj + lj > 0
      ? h('div.city-split', { title: 'DGXBridge jobs finished in the last 24 hours plus those running now. Agent sessions are not jobs.' },
        h('div.city-split-label', 'Bridge jobs (24 h)'),
        h('div.city-split-bar', { role: 'img', 'aria-label': `Bridge jobs in the last 24 hours: ${jobsLabel}` },
          sj ? h('span.city-split-spark', { style: { flexGrow: String(sj) } }) : null, lj ? h('span.city-split-local', { style: { flexGrow: String(lj) } }) : null),
        h('div.city-split-legend', jobsLabel))
      : h('div.city-split', h('div.city-split-label', 'Bridge jobs (24 h)'), h('div.city-split-legend', 'No DGXBridge jobs in the last 24 h'));
    const last = lastText && !offline ? h('p.city-machines-last', { title: fullTime(lastSpark) }, lastText) : null;
    const error = m.error ? h('p.city-machines-error', icon('alert'), h('span', String(m.error).replace(/\s+/g, ' ').slice(0, 140))) : null;
    clear(card, head,
      row('This PC', local, cores, null),
      row('DGX Spark', spark, Number(spark.cpuTotal) || 0, route, offline ? '.is-spark.is-offline' : '.is-spark'),
      last, check, error, runsOn, split);
  }
  /** Machines card "Check connection": ask DGXBridge again now and say how it went. */
  async checkConnection() {
    if (this.checking) return;
    this.checking = true; this.checkResult = ''; this.checkOk = false;
    clearTimeout(this.checkTimer);
    this.machinesSig = ''; this.renderMachines(this.readMachines(), this.sparkMode());
    try {
      await this.store.refreshSpark();
      const m = this.readMachines();
      this.checkOk = Boolean(m.online);
      this.checkResult = !m.enabled ? 'DGXBridge is no longer configured.' : m.online ? 'Connected: the Spark is back online.' : `Still offline${m.error ? ` (${String(m.error).replace(/\s+/g, ' ').slice(0, 80)})` : ''}.`;
    } catch (error) { this.checkOk = false; this.checkResult = `Check failed: ${error?.message || error}`; }
    finally {
      this.checking = false; this.machinesSig = ''; this.dirty = true;
      if (this.visible && this.world && !this.world.running) this.sync(); else this.renderMachines(this.readMachines(), this.sparkMode());
      this.checkTimer = setTimeout(() => { this.checkResult = ''; this.machinesSig = ''; this.dirty = true; }, 9000);
    }
  }
  renderHud(projects, agents) {
    const working = agents.filter(a => a.status === 'active').length;
    const sparkPeople = this.spark?.shown ? this.spark.runnerList : [];
    const sig = JSON.stringify([projects.length, agents.length, working, projects.map(p => [p.id, p.name, p.path, p.source, p.ids]), agents.map(a => [a.id, a.name, a.status, a.provider, a.currentProjectId, a.homeProjectId, a.lastSeenAt]), sparkPeople.map(r => [r.id, r.agent?.name || '', r.crew ? 1 : 0]), this.store.avatar?.name || '', this.spark?.shown]);
    if (sig === this.hudSig) return;
    this.hudSig = sig;
    clear(this.stats,
      h('span', h('strong', String(projects.length)), ` building${projects.length === 1 ? '' : 's'}`),
      h('span.city-dot-sep', '·'),
      h('span', h('strong', String(agents.length)), ` agent${agents.length === 1 ? '' : 's'}`),
      working ? [h('span.city-dot-sep', '·'), h('span.city-working', h('span.city-gem.active'), `${working} working`)] : null);
    this.jumpPicker.update({ projects, agents, runners: sparkPeople, sparkEnabled: Boolean(this.spark?.shown) });
  }
  renderTimeChip() {
    if (!this.world) return;
    const info = this.world.timeInfo();
    const text = `${info.phase} · ${info.mode === 'auto' ? new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : info.mode === 'day' ? 'Day lock' : 'Night lock'}`;
    if (this.timeChip.textContent !== text) clear(this.timeChip, icon(info.phase === 'Night' ? 'moon' : 'sun'), text);
  }
  renderToolbarState() {
    this.syncCameraFramingMode();
    const mode = this.world.timeMode;
    this.timeBtn.replaceChildren(icon(mode === 'day' ? 'sun' : mode === 'night' ? 'moon' : 'clock'));
    const timeLabel = `Time of day: ${TIME_LABEL[mode]} — click to change`;
    this.timeBtn.title = timeLabel; this.timeBtn.setAttribute('aria-label', timeLabel);
    const high = this.world.quality !== 'low';
    const qualityLabel = high ? 'Shadows on (high quality) — click for faster' : 'Shadows off (fast) — click for high quality';
    this.qualityBtn.title = qualityLabel; this.qualityBtn.setAttribute('aria-label', qualityLabel);
    this.qualityBtn.setAttribute('aria-pressed', String(high));
    this.followBtn.setAttribute('aria-pressed', String(Boolean(this.following)));
    this.panBtn?.setAttribute('aria-pressed', String(Boolean(this.world.panMode)));
    this.helpBtn.setAttribute('aria-pressed', String(!this.help.hidden));
    // Show / Hide Spark side: only once DGXBridge is configured (otherwise there is no Spark side at all).
    const shown = this.sparkMode() !== 'off';
    this.sparkBtn.hidden = !this.machines.enabled;
    const sparkLabel = shown ? 'Hide the DGX Spark side' : 'Show the DGX Spark side';
    this.sparkBtn.title = sparkLabel; this.sparkBtn.setAttribute('aria-label', sparkLabel);
    this.sparkBtn.setAttribute('aria-pressed', String(shown));
    this.flipBtn.hidden = !this.world.underside;
    // Find me shows your portrait; street view names its way out while it runs.
    const avatarSig = JSON.stringify(this.store.avatar || null);
    if (avatarSig !== this.findSig) { this.findSig = avatarSig; clear(this.findArt, portrait(this.store.avatar || { ...defaultAvatar(), name: 'You' }, { size: 22, title: 'Find me (M)' })); }
    const inStreet = Boolean(this.street || this.streetPending);
    this.streetLabel.textContent = inStreet ? 'Exit street view' : 'Street view';
    const streetTitle = inStreet ? 'Exit street view (Esc or G)' : 'Street view: walk behind your avatar (G)';
    this.streetBtn.title = streetTitle; this.streetBtn.setAttribute('aria-label', streetTitle);
    this.streetBtn.setAttribute('aria-pressed', String(inStreet));
    this.streetHint.hidden = !this.street;
    this.cityRoot.classList.toggle('is-street', Boolean(this.street));
    this.renderFlip(true);
    this.renderTimeChip();
  }
  /** The flip button names where it will turn the island to; the HUD chip and legend name the face that's up. */
  renderFlip(force = false) {
    const world = this.world, on = Boolean(world.underside), rest = world.restSide, up = world.side;
    const offline = this.sparkOffline ? this.offlineText : '';
    const sig = `${on}|${rest}|${up}|${offline}`;
    if (!force && sig === this.flipSig) return;
    this.flipSig = sig;
    if (this.selection?.kind === 'building') this.refreshPanel();
    const toSpark = rest === 'pc';
    this.flipLabel.textContent = toSpark ? 'Spark side' : 'This PC side';
    this.flipBtn.replaceChildren(icon(toSpark ? 'city-chip' : 'city-laptop'), this.flipLabel);
    this.flipBtn.classList.toggle('to-pc', !toSpark);
    const label = toSpark ? 'Turn the island over to the DGX Spark side (V)' : 'Turn the island back over to This PC side (V)';
    this.flipBtn.title = label; this.flipBtn.setAttribute('aria-label', label);
    const spark = up === 'spark';
    this.sideChip.hidden = !on;
    this.sideChip.classList.toggle('is-spark', spark);
    this.sideChip.classList.toggle('is-pc', !spark);
    this.sideChip.classList.toggle('is-offline', Boolean(offline));
    clear(this.sideChip, icon(spark ? 'city-chip' : 'city-laptop'), spark ? 'DGX Spark' : 'This PC', offline ? h('span.city-side-badge', spark ? offline : offline.replace(/^Offline/, 'Spark offline')) : null);
    this.sideChip.title = `${spark ? 'The DGX Spark side of the island is up' : 'This PC side of the island is up'}${offline ? ` · DGX Spark ${offline.replace(/^O/, 'o')}` : ''}`;
    this.legendSideText.textContent = spark ? 'Flip: This PC' : 'Flip: DGX Spark';
  }
  renderEmpty(projects) {
    const hiddenCount = this.store.projects.length - projects.length;
    const loaded = this.store.sync.at > 0 || this.store.projects.length > 0;
    const empty = loaded && projects.length === 0;
    this.empty.hidden = !empty;
    if (!empty) return;
    const allHidden = hiddenCount > 0;
    const sig = allHidden ? 'hidden' : 'none';
    if (this.emptySig === sig) return;
    this.emptySig = sig;
    clear(this.empty,
      h('div.empty-art', icon('city')),
      h('h3', allHidden ? 'Every project is hidden from the city' : 'Your city is empty'),
      h('p', allHidden ? `${hiddenCount} linked project${hiddenCount === 1 ? ' is' : 's are'} hidden. Show them again from Projects.` : 'Link Desktop folders or GitHub repos and each project becomes a building here — or click an empty plot to start a brand-new project. More code and commits make Downtown towers taller and Suburbs homes grow outward.'),
      h('button.btn.gradient', { type: 'button', onclick: () => this.ctx.navigate('projects') }, icon('projects'), allHidden ? 'Manage projects' : 'Link projects'));
  }

  /* ---------------- toolbar actions ---------------- */
  toggleFollow(force) {
    const world = this.world;
    this.following = force ?? !this.following;
    if (this.following && (this.street || this.streetPending)) this.exitStreet({ fly: false });
    if (this.following && world.underside) world.flipTo('pc');   // your avatar lives on This PC side
    world.follow = this.following ? () => this.npcs.ownerPosition : null;
    const p = this.following ? this.npcs.ownerPosition : null;
    if (p) {
      const target = world.toWorld(new THREE.Vector3(p.x, 1, p.z), { atRest: true });
      if (this.reduced()) world.flyAfterTurn({ target, distance: 22 }, { instant: true });
      else world.flyAfterTurn({ target, distance: Math.min(world.distance, 34) });
    }
    this.renderToolbarState();
    this.refreshPanel();
  }
  cycleTime() {
    const next = TIME_MODES[(TIME_MODES.indexOf(this.world.timeMode) + 1) % TIME_MODES.length];
    this.world.setTimeMode(next);
    this.store.setPref('cityTime', next);
    this.renderToolbarState();
    toast(`City time: ${TIME_LABEL[next]}`, { timeout: 1800 });
  }
  toggleQuality() {
    const next = this.world.quality === 'low' ? 'high' : 'low';
    this.world.setQuality(next);
    this.store.setPref('cityQuality', next);
    this.renderToolbarState();
  }
  toggleHelp(force) {
    const open = force ?? this.help.hidden;
    this.help.hidden = !open;
    if (!open) storage.set(HELP_KEY, '1');
    this.renderToolbarState();
  }
  /** Home / H: fit the visible overview and start the camera-input grace period. */
  resetCamera() {
    if (!this.world) return;
    if (this.street || this.streetPending) this.exitStreet({ fly: false });
    if (this.following) this.toggleFollow(false);
    this.updateCameraFrame();
    this.world.resetView();
  }
  /** Show / Hide the DGX Spark side (only offered while DGXBridge is configured). */
  toggleSpark() {
    if (!this.machines.enabled) return;
    const next = this.sparkMode() === 'off' ? 'auto' : 'off';
    this.store.setPref('citySpark', next);
    toast(next === 'off' ? 'Spark side hidden' : 'Spark side shown', { timeout: 2000 });
  }
  /** Find me / M: back to This PC side if needed, fly close to your avatar and open its card. */
  findMe() {
    const world = this.world, owner = this.npcs?.ownerPosition;
    if (!world || this.failed) return;
    if (!owner) { toast('Your avatar is still on its way to the island.', { timeout: 2200 }); return; }
    if (this.street || this.streetPending) this.exitStreet({ fly: false });
    if (world.underside) world.flipTo('pc');
    const target = world.toWorld(new THREE.Vector3(owner.x, 1.1, owner.z), { atRest: true });
    world.flyAfterTurn({ target, distance: 10.5, polar: 1.12 }, { duration: 1.1 });
    this.select(OWNER_TARGET);
    this.npcs.greetOwner(this.cameraLocal());
    this.showBubble(OWNER_TARGET, `There you are${this.store.avatar?.name ? `, ${this.store.avatar.name}` : ''}! Press G to walk the streets, or double-click the ground to send me somewhere.`);
    this.stage.focus({ preventScroll: true });
  }

  /* ---------------- street view ---------------- */
  toggleStreet(force) {
    const on = force ?? !(this.street || this.streetPending);
    if (on) this.enterStreet(); else this.exitStreet();
  }
  /** Street view / G: This PC side first (the island turns over if the Spark side is up), then the
   *  camera drops in behind your avatar (frame() starts it once the island is still). */
  enterStreet() {
    const world = this.world;
    if (!world || this.failed || this.street || this.streetPending) return;
    if (!this.npcs.owner) { toast('Your avatar is still on its way to the island.', { timeout: 2200 }); return; }
    if (this.following) this.toggleFollow(false);
    this.closeCluster();
    if (world.underside && world.restSide !== 'pc') world.flipTo('pc');
    this.streetPending = true;
    this.renderToolbarState();
    this.refreshPanel();
    this.stage.focus({ preventScroll: true });
  }
  beginStreet() {
    const world = this.world;
    // Where to come back to: the overhead view (or where a flight under way was heading).
    this.streetReturn = this.cameraPose();
    this.street = { heading: this.npcs.ownerHeading, back: STREET.back, moving: false, turned: true };
    this.streetKeys.clear();
    this.hideZoomHint();   // G / the button at the closest zoom: the "Keep zooming" chip would sit on the street hint
    this.setHover(null);
    world.setStreet(dt => this.streetPose(dt));
    this.renderToolbarState();
    this.refreshPanel();
  }
  /** Leave street view; fly: ease back to the overhead view it started from (false: the caller flies elsewhere). */
  exitStreet({ fly = true, instant = false } = {}) {
    const wasPending = this.streetPending;
    this.streetPending = false;
    const st = this.street;
    if (!st) { if (wasPending) { this.renderToolbarState(); this.refreshPanel(); } return; }
    const world = this.world, back = this.streetReturn, owner = this.npcs.owner;
    this.street = null; this.streetReturn = null;
    this.streetKeys.clear();
    world.setStreet(null);
    if (owner) this.npcs.driveOwner(owner.pos.x, owner.pos.z, st.heading, false);
    if (fly && back) {
      const s = new THREE.Spherical().setFromVector3(back.position.clone().sub(back.target));
      world.flyTo({ target: back.target, distance: s.radius, polar: s.phi, azimuth: s.theta }, { duration: 0.85, instant, center: back.center });
      world.overview = Boolean(back.overview);
    }
    this.renderToolbarState();
    this.refreshPanel();
  }
  /** Solid footprints for street walking (island space, grown by the walker's radius): every building
   *  standing on its lot plus the HQ town hall, fountain and planters. */
  streetBoxes() {
    const r = STREET.radius, out = HQ_BOXES.map(b => ({ x0: b.x0 - r, x1: b.x1 + r, z0: b.z0 - r, z1: b.z1 + r, low: Boolean(b.low) }));
    for (const b of this.buildings.list) out.push(...buildingStreetBoxes(b, r, GROUND_Y));
    return out;
  }
  /** Is an island-space point inside a building or the town hall (This PC side up)? Wheel zoom stops at walls. */
  solidAt(p) {
    if (this.world.side !== 'pc') return false;
    const r = STREET.radius, hall = HQ_BOXES[0];
    if (p.y < 11.5 && p.x > hall.x0 - r && p.x < hall.x1 + r && p.z > hall.z0 - r && p.z < hall.z1 + r) return true;
    return this.buildings.list.some(b => buildingSolidAt(b, p, r, GROUND_Y));
  }
  /** Called by the world every frame in street view: walk / turn the avatar, return the camera pose. */
  streetPose(dt) {
    const st = this.street, owner = this.npcs.owner;
    if (!st || !owner) return null;
    const keys = this.streetKeys, has = (...codes) => codes.some(code => keys.has(code));
    const forward = (has('KeyW', 'ArrowUp') ? 1 : 0) - (has('KeyS', 'ArrowDown') ? 1 : 0);
    const turn = (has('KeyD', 'ArrowRight', 'KeyE') ? 1 : 0) - (has('KeyA', 'ArrowLeft', 'KeyQ') ? 1 : 0);
    st.heading -= turn * STREET.turn * dt;
    const boxes = this.streetBoxes(), pos = owner.pos;
    let x = pos.x, z = pos.z;
    const speed = forward > 0 ? STREET.walk : STREET.backWalk;
    if (forward) {
      const step = forward * speed * dt;
      ({ x, z } = streetMove(x, z, Math.sin(st.heading) * step, Math.cos(st.heading) * step, { limit: this.world.half - 2, boxes }));
    }
    if (forward || turn || st.turned || st.moving) this.npcs.driveOwner(x, z, st.heading, Boolean(forward), speed);
    st.moving = Boolean(forward); st.turned = false;
    // Pull the camera in when a wall stands right behind you.
    const fx = Math.sin(st.heading), fz = Math.cos(st.heading);
    let back = st.back;
    for (const f of [1, 0.6, 0.35]) {
      back = st.back * f;
      const cx = x - fx * back, cz = z - fz * back;
      if (!boxes.some(b => !b.low && cx > b.x0 && cx < b.x1 && cz > b.z0 && cz < b.z1)) break;
    }
    return { x, y: pos.y, z, heading: st.heading, back, up: STREET.up + (st.back - STREET.back) * 0.3, look: STREET.look };
  }
  /** Toolbar button / V: roll the island a half turn to its other face (the camera stays above). */
  flipSide() {
    if (!this.world?.underside || this.street) return;
    if (this.following) this.toggleFollow(false);
    this.world.markCameraMoved();
    this.world.flip();
    this.stage.focus({ preventScroll: true });
  }

  /** Save the actual pose and framing mode, including an in-progress flight's destination. */
  cameraPose() {
    const world = this.world, tw = world.tween;
    return tw && !tw.free
      ? { target: tw.toTarget.clone(), position: new THREE.Vector3().setFromSpherical(tw.to).add(tw.toTarget), center: Boolean(tw.center), overview: Boolean(world.overview) }
      : { target: world.controls.target.clone(), position: world.camera.position.clone(), center: Boolean(world.centerTarget), overview: Boolean(world.overview) };
  }

  /* ---------------- talk mode ---------------- */
  /** Click an agent: your avatar drops in, the two face each other and the camera drops to an
   *  over-the-shoulder shot while the conversation opens on the right (city/talk.js). Esc, Leave or a
   *  click on empty ground ends it: the camera eases back, the HUD returns, the agent carries on.
   *  Agents live on This PC side: with the Spark side up the island turns over first. */
  enterTalk(id, { pending = null } = {}) {
    const world = this.world;
    const project = pending && this.store.project(pending.projectId);
    const pendingId = pending && id == null ? `pending-talk:${this.talkSequence = (this.talkSequence || 0) + 1}` : id;
    const agent = pending ? { id: pendingId, kind: 'pending', provider: pending.provider, name: pending.label || 'New session',
      currentProjectId: project?.id || pending.projectId, cityProjectId: project?.id || null, status: 'idle' } : this.agentById(id);
    if (!world || this.failed || !agent) return;
    if (this.talk?.id === agent.id && !pending) { this.talkPanel.focus(); return this.talk.handle; }
    const prev = this.talk;
    if (prev) this.releaseTalk(prev);   // another agent: keep where to go back to
    let back = prev?.back || null;
    if (this.street || this.streetPending) { back ||= this.streetReturn; this.exitStreet({ fly: false }); }   // street view: back to the overview it began from
    back ||= this.cameraPose();
    if (this.following) this.toggleFollow(false);
    this.closeCluster(); this.hideZoomHint(); this.setHover(null); this.select(null);
    this.bubble.hidden = true; this.bubbleTarget = null; this.bubbleUntil = 0;
    for (const b of Object.values(this.talkBubbles)) b.node.hidden = true;
    const t = this.talk = { id: agent.id, back, phase: 'wait', at: performance.now(),
      pending: pending ? { ...pending, projectId: project?.id || pending.projectId } : null, expectedId: id };
    // A stale start finishing after Leave (or another conversation) never steals the camera.
    t.handle = {
      resolve: session => {
        if (this.talk !== t || !t.pending || t.failed) return false;
        const sessionId = typeof session === 'string' ? session : session?.sessionId || session?.id;
        if (typeof sessionId !== 'string' || !sessionId) return false;
        const expectedId = sessionId.startsWith('sess:') ? sessionId : `sess:${sessionId}`;
        if (t.admittedId && t.admittedId !== expectedId) return false;
        t.admittedId = t.expectedId = expectedId;
        this.extraCache = null; this.agentLocations = null; this.dirty = true;
        return this.resolvePendingTalk();
      },
      fail: error => {
        if (this.talk !== t || !t.pending || t.failed || t.admittedId) return false;
        this.npcs.releaseTalkSpot(t.pendingSpot);
        t.failed = true; this.talkPanel.failPending(error); return true;
      },
    };
    this.syncCameraFramingMode();
    this.npcs.hold(agent.id, true);
    if (world.underside && world.restSide !== 'pc') world.flipTo('pc');
    this.cityRoot.classList.add('is-talk');
    this.talkPanel.open(agent, { pending: t.pending });
    this.talkPanel.focus();
    this.declutterAt = 0;
    return t.handle;
  }
  /** Settle only the exact session named by the caller; concurrent starts at a project stay separate. */
  resolvePendingTalk() {
    const t = this.talk;
    if (!t?.pending || t.failed || !t.expectedId || !t.spot || !this.npcs.owner) return false;
    const agent = this.agentById(t.expectedId);
    if (agent?.kind !== 'session' || !this.npcs.position({ kind: 'agent', id: agent.id })) return false;
    if (t.pendingSpot && !this.npcs.stageTalkAgent(agent.id, t.pendingSpot)) return false;
    if (t.id !== agent.id) this.npcs.hold(t.id, false);
    t.id = agent.id; t.pending = null; t.phase = 'wait'; t.greeted = false;
    this.npcs.hold(t.id, true);
    this.talkPanel.resolvePending(agent);
    return true;
  }
  /** Public counterpart for callers which keep their own pending request record. */
  failTalk(id, error) {
    if (this.talk?.id === id || this.talk?.expectedId === id) return this.talk.handle.fail(error);
    return false;
  }
  /** Leave the conversation: the camera eases back to where it was, the HUD returns, the agent carries on. */
  exitTalk({ instant = false } = {}) {
    const t = this.talk, world = this.world;
    if (!t || !world) return;
    this.talk = null;
    this.releaseTalk(t);
    this.talkPanel.close();
    this.cityRoot.classList.remove('is-talk');
    for (const b of Object.values(this.talkBubbles)) b.node.hidden = true;
    world.setShot(null);
    this.updateCameraFrame();
    if (t.back) {
      const s = new THREE.Spherical().setFromVector3(t.back.position.clone().sub(t.back.target));
      world.flyAfterTurn({ target: t.back.target, distance: s.radius, polar: s.phi, azimuth: s.theta }, { duration: 1, instant, center: t.back.center });
      world.overview = Boolean(t.back.overview);
    }
    this.declutterAt = 0;
    this.renderToolbarState();
    if (!instant) this.stage.focus({ preventScroll: true });
  }
  releaseTalk(t) {
    t.restoreCutaway?.(); t.restoreCutaway = null;
    this.npcs.releaseTalkSpot(t.pendingSpot);
    this.npcs.hold(t.id, false);
    if (t.ownerPose && this.npcs.owner && !this.npcs.owner.path.length) this.npcs.act(OWNER_TARGET, 'stand');
  }
  /** Once a frame: wait for the island to settle (This PC side up), stage the scene, finish the walk-up,
   *  end timed gestures and re-aim the shot when the view or the panel changes size. */
  updateTalk() {
    const t = this.talk, world = this.world;
    if (!t) return;
    const now = performance.now();
    if (t.pending) this.resolvePendingTalk();
    if (t.phase === 'wait') {
      if (!this.peopleReady) return;
      if (!world.settled) return;   // still turning over
      if (world.side !== 'pc' && world.underside && now - t.at < 4000) { world.flipTo('pc'); return; }
      this.stageTalk(t);
    }
    const agentT = { kind: 'agent', id: t.id };
    for (const [key, target] of [['ownerPose', OWNER_TARGET], ['agentPose', agentT]]) {
      const pose = t[key];
      if (pose && now > pose.until) {
        t[key] = null;
        this.npcs.act(target, key === 'agentPose' && this.talkPanel.thinking ? 'talk' : pose.next || 'stand');
      }
    }
    if (t.spot && now > (t.frameCheck || 0)) {
      t.frameCheck = now + 400;
      if (this.talkFrameSig() !== t.frameSig) this.stageTalk(t);
    }
  }
  /** Stage the owner beside the target, including a pending session's project before it appears. */
  stageTalk(t) {
    const world = this.world, agentT = { kind: 'agent', id: t.id }, owner = this.npcs.owner;
    let a = this.npcs.position(agentT);
    if (!a && t.pending) {
      const building = this.buildings.get(t.pending.projectId);
      if (!t.failed) t.pendingSpot ||= this.npcs.reserveTalkSpot(t.pending.projectId);
      const point = t.pendingSpot || building?.workSpot(this.agentsAt(t.pending.projectId).length) || { x: -5.5, z: 5.5 };
      a = { x: point.x, y: this.npcs.surfaceY(point.x, point.z), z: point.z };
    }
    if (!a || !owner || world.side !== 'pc') return;
    t.restoreCutaway?.(); t.restoreCutaway = null;
    t.phase = 'on';
    this.npcs.hold(t.id, true);
    const reduced = this.reduced(), boxes = this.streetBoxes(), limit = world.half - 2;
    const near = owner && Math.hypot(owner.pos.x - a.x, owner.pos.z - a.z) < 9;
    t.seated = this.npcs.seated(t.id);
    // A bottom sheet leaves a short strip of the view: stand the camera further back so the two still fit.
    const vis = this.talkFraming().vis, k = Math.min(1.6, Math.max(1, Math.sqrt(world.size.h / Math.max(1, vis.y1 - vis.y0))));
    const from = near ? owner.pos : this.cameraLocal(), baseYaw = Math.atan2(from.x - a.x, from.z - a.z);
    const ground = this.npcs.surfaceY(a.x, a.z);
    const frame = this.talkFraming();
    const meshes = talkSceneMeshes(world.land, [owner.person.object, this.npcs.personOf(agentT)?.object]);
    const toWorld = p => world.toWorld(new THREE.Vector3(p.x, p.y, p.z), { atRest: true });
    let spot, bestScore = Infinity, obscures = new Set();
    // Narrow sheets need a longer shot. Choose a clear street direction using the
    // final fitted eye, so pulling back cannot silently place it inside a neighbour.
    for (const turn of [0, .5, -.5, 1, -1, 1.5, -1.5, 2, -2, 2.5, -2.5, Math.PI]) {
      const candidate = talkSpot(a, { x: a.x + Math.sin(baseYaw + turn) * 5, z: a.z + Math.cos(baseYaw + turn) * 5 },
        { boxes, limit, facing: t.seated ? this.npcs.yaw(agentT) : null, back: STAGE.back * k, side: STAGE.side * k });
      const shot = this.makeTalkShot(candidate, { ...a, y: ground }, frame);
      const targets = [
        ...talkFigureTargets(shot.eye, { ...a, y: ground }, this.npcs.faceHeight(agentT)),
        ...talkFigureTargets(shot.eye, { ...candidate, y: this.npcs.surfaceY(candidate.x, candidate.z) }, this.npcs.faceHeight(OWNER_TARGET)),
      ];
      const walls = talkWallHits(shot.eye, targets, boxes);
      if (walls * 100 > bestScore) continue;
      const hits = talkSceneHits(meshes, toWorld(shot.eye), targets.map(toWorld));
      const score = walls * 100 + hits.size;
      if (score < bestScore) { spot = candidate; bestScore = score; obscures = hits; }
      if (!score) break;
    }
    t.spot = spot; t.a = { x: a.x, y: this.npcs.surfaceY(a.x, a.z), z: a.z };
    if (obscures.size) t.restoreCutaway = cutawayTalkMeshes(obscures);
    if (t.ownerDropped) this.npcs.driveOwner(spot.x, spot.z, spot.heading, false);
    else { this.npcs.dropOwner(spot.x, spot.z, spot.heading); t.ownerDropped = true; }
    this.arriveTalk(t);
    this.aimTalk(t, reduced ? 0 : 0.85);
  }
  /** Ben is in place: the two face each other and the agent says hello. */
  arriveTalk(t) {
    t.phase = 'on';
    const agentT = { kind: 'agent', id: t.id }, owner = this.npcs.owner, a = this.npcs.position(agentT);
    if (owner && a) { this.npcs.face(OWNER_TARGET, a.x, a.z); if (!t.seated) this.npcs.face(agentT, owner.pos.x, owner.pos.z); }
    const agent = this.agentById(t.id);
    if (!agent || t.greeted) return;
    t.greeted = true;
    this.npcs.act(agentT, 'wave'); t.agentPose = { until: performance.now() + 1600, next: 'stand' };
    const messages = this.talkPanel.messages(this.talkPanel.info());
    for (const [role, who] of [['owner', 'owner'], ['agent', 'agent']]) {
      const line = messages.filter(m => m.role === role && m.text?.trim()).at(-1);
      if (line) this.talkSay(who, sayLine(line.text, 80));
      else if (who === 'agent') this.talkSay('agent', sayLine(this.bubbleText(agent), 80));
    }
  }
  makeTalkShot(spot, position, frame = this.talkFraming()) {
    const world = this.world, target = { kind: 'agent', id: this.talk.id };
    const face = { x: position.x, y: position.y + this.npcs.faceHeight(target), z: position.z };
    return fitTalkShot(spot, face, { width: world.size.w, height: world.size.h, vis: frame.vis,
      ownerY: this.npcs.surfaceY(spot.x, spot.z), agentY: position.y,
      ownerHeight: this.npcs.topHeight(OWNER_TARGET), agentHeight: this.npcs.topHeight(target), vfov: world.camera.fov });
  }
  /** Fly to (or, after a resize, re-aim) the over-the-shoulder shot. */
  aimTalk(t, duration) {
    const world = this.world, spot = t.spot;
    if (!spot) return;
    const frame = this.talkFraming();
    const shot = this.makeTalkShot(spot, t.a, frame);
    const v = p => world.toWorld(new THREE.Vector3(p.x, p.y, p.z), { atRest: true });
    world.setShot({ eye: v(shot.eye), look: v(shot.look) }, { duration, instant: !duration });
    t.frameSig = this.talkFrameSig(); t.vis = frame.vis;
  }
  /** Where the agent's face should land (NDC): in the part of the view the conversation leaves free
   *  (left of the docked panel, or above the bottom sheet on narrow windows). Layout boxes, not the
   *  panel's slide-in transform. */
  talkFraming() {
    const { w: W, h: H } = this.world.size, panel = this.talkPanel.node, base = this.stage.getBoundingClientRect();
    const vis = talkVisibleRect({ width: W, height: H,
      visibleWidth: Math.min(W, window.innerWidth - base.left), visibleHeight: Math.min(H, window.innerHeight - base.top),
      panel: !panel.hidden ? { left: panel.offsetLeft, top: panel.offsetTop, width: panel.offsetWidth, height: panel.offsetHeight } : null });
    return { vis };
  }
  talkFrameSig() { const p = this.talkPanel.node, { w, h } = this.world.size; return `${w}x${h}|${p.offsetLeft}|${p.offsetTop}`; }
  /** A speech bubble over you ('owner') or the agent ('agent'); '…' shows typing dots. */
  talkSay(who, text, ms = 7000) {
    const b = this.talkBubbles[who], typing = text === '…';
    if (!b || !text) return;
    if (typing) clear(b.node, h('span.typing-dots', h('i'), h('i'), h('i')));
    else clear(b.node, h('span.city-talk-line', text));
    b.node.classList.toggle('is-typing', typing);
    b.node.hidden = false; b.until = performance.now() + ms; b.size = null;
  }
  talkSent(text) {
    const t = this.talk;
    if (!t) return;
    this.talkSay('owner', sayLine(text), 6000);
    this.npcs.nodOwner(); t.ownerPose = { until: performance.now() + 1400, next: 'stand' };
    this.npcs.glance(t.id);
  }
  talkHeard(text) {
    const t = this.talk;
    if (!t) return;
    this.talkSay('agent', sayLine(text, 80), 9000);
    this.npcs.act({ kind: 'agent', id: t.id }, 'talk'); t.agentPose = { until: performance.now() + 3400, next: 'stand' };
  }
  /** A live reply is being written: typing dots over the agent, which gets busy at its laptop. */
  talkThinking(on) {
    const t = this.talk, agentT = { kind: 'agent', id: t?.id };
    if (!t) return;
    if (on) { this.talkSay('agent', '…', 15 * 60e3); this.npcs.act(agentT, 'talk'); t.agentPose = null; return; }
    const b = this.talkBubbles.agent;
    if (b.node.classList.contains('is-typing')) b.node.hidden = true;
    if (!t.agentPose) this.npcs.act(agentT, 'stand');   // a reply that just landed keeps its talk gesture
  }
  /** Talk bubbles ride above the two heads, kept inside the part of the view the panel leaves free. */
  placeTalkBubbles(scratch, point) {
    const t = this.talk, world = this.world, now = performance.now(), cam = world.camera;
    const dir = cam.getWorldDirection(this._talkDir ||= new THREE.Vector3());
    const { w: W, h: H } = world.size, vis = t.vis || { x0: 0, x1: W, y0: 0, y1: H };
    const width = Math.max(80, Math.min(280, (vis.x1 - vis.x0 - 28) / 2)), placed = [];
    // Reserve the silhouette of both heads even while only one bubble is showing.
    let headTop = vis.y1;
    for (const target of [OWNER_TARGET, { kind: 'agent', id: t.id }]) {
      const pos = this.npcs.position(target);
      if (!pos) continue;
      for (const dx of [-.5, .5]) for (const dz of [-.5, .5]) {
        world.toWorld(scratch.set(pos.x + dx, pos.y + this.npcs.topHeight(target), pos.z + dz), { out: scratch });
        world.project(scratch, point); headTop = Math.min(headTop, point.y);
      }
    }
    for (const [who, b] of Object.entries(this.talkBubbles)) {
      if (b.node.hidden) continue;
      if (now > b.until) { b.node.hidden = true; continue; }
      const target = who === 'owner' ? OWNER_TARGET : { kind: 'agent', id: t.id };
      const pos = this.facesUp(target) ? this.npcs.position(target) : null;
      let on = Boolean(pos);
      if (pos) {
        world.toWorld(scratch.set(pos.x, pos.y + this.npcs.topHeight(target), pos.z), { out: scratch });
        on = (this._talkTo ||= new THREE.Vector3()).subVectors(scratch, cam.position).dot(dir) > 0.2;   // in front of the camera (off-screen is clamped in, below)
        world.project(scratch, point);
      }
      b.node.style.visibility = on ? '' : 'hidden';
      if (!on) continue;
      if (b.maxWidth !== width) { b.maxWidth = width; b.node.style.maxWidth = `${width}px`; b.size = null; }
      b.size ||= { w: b.node.offsetWidth, h: b.node.offsetHeight };
      placed.push({ b, who, x: point.x, y: point.y, w: b.size.w, h: b.size.h });
    }
    for (const { b, x, y, tailX, tailHeight, visible } of layoutTalkBubbles(placed, vis, headTop)) {
      b.node.style.visibility = visible ? '' : 'hidden';
      b.node.style.setProperty('--talk-tail-x', `${tailX.toFixed(1)}px`);
      b.node.style.setProperty('--talk-tail-height', `${tailHeight.toFixed(1)}px`);
      b.node.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  }

  /* ---------------- empty plot → new project ---------------- */
  async cloneOutline(project) {
    try {
      const { openNewProjectDialog } = await import('../newproject.js');
      const repo = project.repo?.full_name || project.ids?.find(id => id.startsWith('gh:'))?.slice(3) || project.id.slice(3);
      const result = await openNewProjectDialog(this.ctx, { lot: this.cells.get(project.id), tab: 'clone', repo });
      if (result?.projectId) { this.pendingFocus = { kind: 'building', id: result.projectId, at: performance.now(), ttl: 90000 }; this.dirty = true; }
    } catch (error) { toast(`Could not open cloning: ${error?.message || error}`, { kind: 'error' }); }
  }
  async startProjectOnPlot(target) {
    if (target.reservedBy) {
      const owner = this.store.project(target.reservedBy);
      if (owner) { this.store.setProjectSettings(owner, { city: true }); toast(`${owner.name} is back on its plot`, { kind: 'success', timeout: 2600 }); }
      return;
    }
    if (this.plotDialog) return;
    const lot = { i: target.i, j: target.j };
    this.plotDialog = { ...lot, at: performance.now() };   // new unpinned projects wait until the dialog pins one here
    this.setHover(null);
    this.dirty = true;
    let result = null;
    try {
      const { openNewProjectDialog } = await import('../newproject.js');
      result = await openNewProjectDialog(this.ctx, { lot, tab: districtForCell(lot, this.homeBanks) === SUBURBS ? 'link' : 'create' });
    } catch (error) {
      console.error('City: New Project dialog failed', error);
      toast(`Could not start a project here: ${error?.message || error}`, { kind: 'error' });
    } finally {
      this.plotDialog = null;
      this.dirty = true;
      if (this.visible && this.world && !this.world.running) this.sync();
    }
    if (!result?.projectId || !this.visible) return;
    const c = cellCenter(lot.i, lot.j);
    this.select(null);
    if (this.street || this.streetPending) this.exitStreet({ fly: false });
    if (this.world.underside) this.world.flipTo('pc');
    this.world.flyAfterTurn({ target: this.world.toWorld(new THREE.Vector3(c.x, 2, c.z), { atRest: true }), distance: 36, polar: 0.95 });
    // Select and frame the new building as soon as it rises (cloning / scanning can take a while).
    this.pendingFocus = { kind: 'building', id: result.projectId, at: performance.now(), ttl: 90000 };
    this.tryPendingFocus();
  }

  /* ---------------- lifecycle ---------------- */
  show(params = {}) {
    this.visible = true;
    if (this.failed) return;
    if (params.focusProject) this.pendingFocus = { kind: 'building', id: params.focusProject, at: performance.now() };
    if (params.focusAgent) this.pendingFocus = { kind: 'agent', id: params.focusAgent, at: performance.now() };
    this.islands?.show(params);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.sync();
    this.world.resize();
    this.world.start();
    this.weather?.show();
    // Zero-config agents and ambient CI refresh only while the City is on screen.
    if (sessions.available === null) sessions.refresh().catch(() => {});
    this.pollExternal();
    clearInterval(this.externalTimer);
    if (this.externalCall()) this.externalTimer = setInterval(() => this.pollExternal(), EXTERNAL_POLL_MS);
    this.ci?.start();
    this.legendCi.hidden = !this.ci?.available;
    // Deep link #city?side=spark (or side=pc) turns the island to that face once the Spark side exists.
    if (params.side === 'spark' || params.side === 'pc') {
      const side = params.side;
      const tryFlip = (attempt = 0) => {
        if (!this.visible || this.failed) return;
        if (this.world.underside) this.world.flipTo(side);
        else if (side === 'spark' && attempt < 40) setTimeout(() => tryFlip(attempt + 1), 250);
      };
      tryFlip();
    }
  }
  destroy() {
    this.hide();
    this.cameraFrameObserver?.disconnect();
    this.jumpPicker?.destroy();
    for (const label of this.runnerLabels.values()) label.node.remove();
    this.runnerLabels.clear();
    clearTimeout(this.checkTimer);
    this.offSessions?.();
    this.buildingSessions?.destroy();
    this.ci?.dispose();
    this.river?.dispose();
    this.islands?.dispose();
    this.weather?.dispose();
    this.spark?.dispose(); this.npcs?.dispose(); this.buildings?.dispose(); this.world?.dispose();
    this.root.replaceChildren();
  }
  hide() {
    this.visible = false;
    this.jumpPicker?.close();
    clearInterval(this.externalTimer); this.externalTimer = 0;
    this.ci?.stop();
    if (this.failed || !this.world) return;
    this.cancelAgentDrag?.();
    this.exitTalk({ instant: true });
    this.exitStreet({ instant: true });   // coming back to the City starts from the overview
    this.world.releaseTilt?.();
    this.islands?.hide();
    this.world.stop();
    this.weather?.hide();
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.closeCluster();
    this.setHover(null);
    clearTimeout(this.plotClickTimer); this.plotClickTimer = 0;
    this.bubble.hidden = true; this.bubbleTarget = null;
  }
}
