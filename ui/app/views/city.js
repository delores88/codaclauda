/* City view: a playful 3D "project city". Every visible project is a building on a
 * floating island; agents walk between them as little people. HTML overlays (labels,
 * tags, bubbles, panels, toolbar) sit on top of the WebGL canvas. */
import { h, icon, iconButton, registerIcons, toast, portrait, timeAgo, fullTime, pill, plural, statusDot, STATUS_LABEL, formatNumber, formatBytes, clear } from '../ui.js';
import { PROVIDER_COLORS, defaultAvatar } from '../avatar/spec.js';
import { THREE } from '../city/toon.js';
import { World, webglAvailable, wheelZoomLog } from '../city/world.js';
import { BuildingManager } from '../city/buildings.js';
import { NpcManager, loadPeople, setPeopleReducedMotion, streetMove, groundY } from '../city/npc.js';
import { SlotMap, cellCenter, cellOf, cellKey, LOT_HALF } from '../city/layout.js';
import { buildPlotMarker, GROUND_Y } from '../city/scenery.js';
import { SparkCity, FOUNDRY, jobLabel } from '../city/spark.js';
import { TalkPanel, talkSpot, talkShot, sayLine, STAGE } from '../city/talk.js';
import { IslandMode } from '../city/portal.js';

registerIcons({
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
});

const HELP_KEY = 'codaclauda.city.help-dismissed';
const TIME_MODES = ['auto', 'day', 'night'];
const TIME_LABEL = { auto: 'Auto (your clock)', day: 'Always day', night: 'Always night' };
const PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex', other: 'Agent' };
const MACHINES_KEY = 'codaclauda.city.machines-collapsed';
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
const LABEL_PRIORITY = { active: 60, idle: 40, offline: 20 };
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

class CityView {
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
    this.street = null;              // street view state { heading, back, moving, turned } while it runs
    this.streetPending = false;      // waiting for the island to turn back to This PC side first
    this.streetKeys = new Set();
    this.talk = null;                // talk mode { id, back, phase: 'wait' | 'walk' | 'on', spot, … } (enterTalk)
    this.sparkOffline = false;
    root.classList.add('city-view');
    this.buildDom();
    if (!webglAvailable()) { this.fail('This computer could not start 3D graphics (WebGL is unavailable).'); return; }
    try { this.initWorld(); }
    catch (error) { console.error(error); this.fail(`The 3D view could not start: ${error.message}`); return; }
    this.islands = new IslandMode(this);   // contributor islands: route map, portal, current island (city/portal.js)
    this.store.on('change', () => { this.dirty = true; if (this.visible && !this.world.running) this.sync(); });
    loadPeople().then(create => { this.npcs.setCreate(create); this.peopleReady = true; this.dirty = true; if (this.visible) this.sync(); });
  }

  reduced() { return Boolean(this.store.prefs.reducedMotion) || Boolean(this.motionQuery?.matches); }

  /* ---------------- DOM skeleton ---------------- */
  buildDom() {
    this.stage = h('div.city-stage', { tabindex: '0', role: 'application', 'aria-label': 'Project city. Click an agent to talk to them. Drag to orbit, right-drag to pan, scroll to zoom. With the Spark side on, drag up or down to turn the island over, or press V to flip it. W A S D pan, Q and E rotate, F focuses the selection, H resets the view, M finds your avatar, G starts street view (W and S walk, A and D turn, Escape exits).' });
    this.tag = h('div.city-tag', { hidden: true, 'aria-hidden': 'true' });
    this.bubble = h('div.city-bubble', { hidden: true, role: 'status' });
    this.labelLayer = h('div.city-labels', { 'aria-hidden': 'true' });
    this.chipLayer = h('div.city-chips');   // wheel over a chip still zooms: see bindWheel
    this.clusterPop = h('div.city-cluster-pop.card', { hidden: true, role: 'dialog', 'aria-label': 'Agents at this spot' });
    this.sparkTag = h('div.city-offline-tag', { hidden: true, 'aria-hidden': 'true' }, 'Offline');   // over the DGX SPARK emblem
    // Talk mode: what you and the agent say, over your heads.
    this.talkBubbles = { owner: { node: h('div.city-bubble.city-talk-say.is-owner', { hidden: true, 'aria-hidden': 'true' }), until: 0, size: null }, agent: { node: h('div.city-bubble.city-talk-say', { hidden: true, 'aria-hidden': 'true' }), until: 0, size: null } };
    this.overlay = h('div.city-overlay', this.labelLayer, this.sparkTag, this.chipLayer, this.tag, this.bubble, this.talkBubbles.owner.node, this.talkBubbles.agent.node, this.clusterPop);

    this.stats = h('div.city-hud-stats');
    this.timeChip = h('span.city-chip');
    this.jump = h('select.select.city-jump', { 'aria-label': 'Jump to a building or agent', onchange: () => this.onJump() });
    // Which face of the island is up (shown while the Spark side exists).
    this.sideChip = h('span.city-side.is-pc', { hidden: true, role: 'status' });
    this.hud = h('header.city-hud',
      h('div.city-hud-title', h('span.eyebrow', 'Project city'), this.sideChip, this.stats),
      h('div.city-hud-row', this.timeChip, this.jump));

    this.legendSideText = h('span', 'Other side = DGX Spark');
    this.legendOffline = h('div.city-legend-row', { hidden: true }, h('span.city-gem.offline'), 'Grey Spark side = Spark offline');
    this.legendSpark = h('div.city-legend-extra', { hidden: true }, h('div.city-legend-sep'), h('div.city-legend-row', h('span.city-gem.spark'), this.legendSideText), this.legendOffline);
    this.legendGear = h('div.city-legend-note', { hidden: true }, 'Spinning gear = a job running on this PC');
    this.legend = h('div.city-legend', { 'aria-label': 'Legend' },
      h('div.city-legend-row', h('span.city-gem.active'), 'Working'),
      h('div.city-legend-row', h('span.city-gem.idle'), 'Awake'),
      h('div.city-legend-row', h('span.city-gem.offline'), 'Powered down'),
      h('div.city-legend-sep'),
      h('div.city-legend-note', 'Taller = more code & commits'),
      h('div.city-legend-note', 'Scaffolding = an agent is working there'),
      this.legendGear, this.legendSpark);

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
    this.streetHint = h('div.city-street-hint', { hidden: true, role: 'note' }, 'W/S walk · A/D turn · drag to look · Esc to exit');
    // Zoomed all the way in (This PC side up): one more zoom-in step drops into street view.
    this.zoomHint = h('div.city-zoom-hint', { hidden: true, role: 'status' }, icon('city-street'), 'Keep zooming → Street view');
    this.toolbar = h('div.city-toolbar', { role: 'toolbar', 'aria-label': 'City controls' },
      this.findBtn, this.streetBtn,
      this.flipBtn,
      iconButton('zoomIn', 'Zoom in', () => this.world?.zoomBy(0.72), 'city-tool'),
      iconButton('zoomOut', 'Zoom out', () => this.world?.zoomBy(1.38), 'city-tool'),
      iconButton('home', 'Reset view (H)', () => this.resetCamera(), 'city-tool'),
      this.followBtn, h('span.city-toolbar-sep'), this.timeBtn, this.qualityBtn, this.sparkBtn, this.helpBtn);

    this.help = h('div.city-help.card', { hidden: true, role: 'dialog', 'aria-label': 'City controls' },
      h('div.city-help-head', h('strong', 'Getting around'), iconButton('close', 'Close help', () => this.toggleHelp(false))),
      h('dl.city-help-list',
        ...[['M', 'Find me: fly to your avatar'], ['G', 'Street view behind your avatar (W/S walk, A/D turn, Esc exits)'], ['V', 'Flip to the other side'], ['Left-drag', 'Orbit'], ['Drag up / down', 'Turn the island over (Spark side on)'], ['Right-drag', 'Pan'], ['Scroll / pinch', 'Zoom toward the pointer; keep zooming in for street view'], ['W A S D / arrows', 'Move'], ['Q / E', 'Rotate'], ['Click an agent', 'Talk to them (Esc leaves)'], ['Click', 'Select a building or your avatar'], ['Click an empty plot', 'Start a new project there'], ['Double-click ground', 'Walk your avatar there'], ['F', 'Focus selection'], ['H', 'Reset view'], ['Esc', 'Deselect']]
          .flatMap(([k, v]) => [h('dt', h('kbd', k)), h('dd', v)])),
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
    });
    this.cityRoot = h('div.city-root', this.stage, ...this.bars, this.overlay, this.hud, this.legend, this.machinesCard, this.streetHint, this.zoomHint, this.toolbar, this.help, this.panel, this.empty, this.leaveBtn, this.talkPanel.node, this.fallback);
    this.root.append(this.cityRoot);
    if (!storage.get(HELP_KEY)) this.help.hidden = false;
  }

  fail(message) {
    this.failed = true;
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
    this.world.collide = p => this.solidAt(p);
    this.buildings = new BuildingManager(this.world.city, { particles: this.world.particles, reducedMotion: () => this.reduced() });
    this.npcs = new NpcManager(this.world.city, { buildings: this.buildings, particles: this.world.particles, reducedMotion: () => this.reduced() });
    this.spark = new SparkCity(this.world, { makePerson: (spec, options) => this.npcs.makePerson(spec, options), reducedMotion: () => this.reduced(), topBuildings: this.buildings });
    this.plotMarker = buildPlotMarker();
    this.world.city.add(this.plotMarker.group);
    this.world.onFrame((dt, elapsed, env) => this.frame(dt, elapsed, env));
    this.bindInput();
  }

  /** 'auto' (Spark side shown whenever DGXBridge is configured) or 'off'; an old stored 'on' counts as 'auto'. */
  sparkMode() { return this.store.prefs.citySpark === 'off' ? 'off' : 'auto'; }
  readMachines() {
    try { const m = this.store.machines; return m && typeof m === 'object' ? { ...EMPTY_MACHINES, ...m } : EMPTY_MACHINES; }
    catch (error) { console.error('City: machine status unavailable', error); return EMPTY_MACHINES; }
  }
  /** Pin projects that just got their first lot, so the layout survives other machines and reinstalls. */
  persistLots(fresh) {
    if (!fresh.length || typeof this.store.setCityLot !== 'function') return;
    const lots = fresh.map(f => ({ id: f.id, i: f.i, j: f.j }));
    setTimeout(() => {   // never re-enter sync() from inside sync()
      const pins = this.store.cityLots || {};
      const todo = lots.filter(f => !pins[f.id]);
      if (todo.length > 1 && typeof this.store.updateDesktop === 'function') this.store.updateDesktop(d => { d.cityLots = { ...(d.cityLots || {}) }; for (const f of todo) d.cityLots[f.id] = { i: f.i, j: f.j }; });
      else for (const f of todo) this.store.setCityLot(f.id, { i: f.i, j: f.j });
    }, 0);
  }

  sync() {
    if (this.failed || !this.world) return;
    this.dirty = false;
    this.root.classList.toggle('reduce-motion', this.reduced());
    const store = this.store;
    const projects = store.visibleProjects('city');
    const hold = Boolean(this.plotDialog && performance.now() - this.plotDialog.at < PLOT_HOLD_MS);
    const { cells, rings, fresh = [], reserved = new Map() } = this.slots.assign(projects, { pins: store.cityLots || {}, reserve: store.projects.filter(p => !p.visible.city), hold });
    this.cells = cells; this.rings = rings; this.reserved = reserved;
    this.occupied = new Set([...cells.values()].map(c => cellKey(c.i, c.j)));
    this.persistLots(fresh);
    const ringsChanged = this.world.setRings(rings, { animate: Boolean(this.firstSyncDone) });
    // Until the owner moves the camera, keep the whole (growing) island framed.
    if (ringsChanged && !this.world.userMoved && !this.pendingFocus && !this.talk) this.world.resetView({ instant: !this.firstSyncDone, auto: true });
    const agents = store.agents;
    const active = new Set(agents.filter(a => a.status === 'active' && a.currentProjectId).map(a => store.project(a.currentProjectId)?.id || a.currentProjectId));
    const lotsChanged = this.buildings.sync(projects, cells, active, { animate: true });
    if (lotsChanged || ringsChanged) this.world.setLots(this.buildings.lots());
    const quality = store.prefs.cityQuality === 'low' ? 'low' : 'high';
    if (this.world.quality !== quality) this.world.setQuality(quality);
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
    try { this.spark.sync({ shown: under, projects, cells, rings, machines, quality, peopleReady: Boolean(this.peopleReady), gears: mode !== 'off', offline, agents }); }
    catch (error) { console.error('City: could not build the Spark underside', error); }
    this.legendSpark.hidden = !under;
    this.legendOffline.hidden = !(under && offline);
    this.legendGear.hidden = !this.spark.gears.size;
    this.syncRunnerLabels();
    this.renderMachines(machines, mode);
    this.firstSyncDone = true;
    this.syncLabels(agents);
    this.renderHud(projects, agents);
    this.renderEmpty(projects);
    this.renderToolbarState();
    this.refreshPanel();
    if (this.talk) this.talkPanel.refresh();
    this.tryPendingFocus();
  }

  /* ---------------- per-frame ---------------- */
  frame(dt, elapsed, env) {
    if (this.dirty) this.sync();
    this.buildings.update(dt, elapsed, env);
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
    return world.settled && world.side === (SPARK_KINDS.has(target?.kind) ? 'spark' : 'pc');
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
    const agents = entry.members.map(id => this.store.agent(id)).filter(Boolean).sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
    if (!agents.length) return;
    clear(this.clusterPop,
      h('div.city-cluster-head', h('strong', `${agents.length} agents here`), iconButton('close', 'Close list', () => this.closeCluster(true))),
      h('div.city-cluster-list', ...agents.map(a => h('button.city-cluster-item', {
        type: 'button', title: `${a.name} · ${STATUS_LABEL[a.status] || a.status}`,
        onclick: () => this.pickFromCluster(a.id),
        onpointerenter: () => this.setHover({ kind: 'agent', id: a.id }),
        onpointerleave: () => { if (!this.pointer) this.setHover(null); },
      }, portrait(a.look, { size: 28, provider: a.provider, status: a.status }), h('span.city-cluster-name', a.name), h('span.city-cluster-status', STATUS_LABEL[a.status] || a.status)))));
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
    if (this.store.agent(id)) this.enterTalk(id);   // the same as clicking that agent
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
    canvas.addEventListener('pointerleave', () => { this.pointer = null; this.setHover(null); });
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
      clearTimeout(this.plotClickTimer); this.plotClickTimer = 0;   // a double-click on an empty plot walks, it doesn't open the dialog
      if (this.talk) return;   // talk mode: the camera is staged; clicks pick who to talk to
      const target = this.pick(event.clientX, event.clientY);
      if (target?.kind === 'runner' || target?.kind === 'foundry' || target?.kind === 'gear') return;
      if (target?.kind === 'spark') { if (!this.sparkOffline) this.select({ kind: 'building', id: target.id }); return; }
      if (this.street) return;   // street view: you walk with the keys
      if (target && target.kind !== 'owner' && target.kind !== 'plot') { this.select(target); this.focusSelection(); return; }
      const ground = this.world.groundAt(this.world.ndc(event.clientX, event.clientY));
      if (ground) this.npcs.walkOwner(ground.x, ground.z);
    });
    canvas.addEventListener('contextmenu', event => event.preventDefault());
    this.onKeyDown = event => this.keyDown(event);
    this.onKeyUp = event => { this.world.keyUp(event.code); this.streetKeys.delete(event.code); };
    this.onBlur = () => { this.world.clearKeys(); this.streetKeys.clear(); this.world.releaseTilt?.(); };   // a held drag lets go: the island settles flat
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
      const scroller = event.target instanceof Element ? event.target.closest('.city-panel, .city-help, .city-cluster-pop, .city-talk') : null;
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
    const hit = this.world.raycast(ndc, [...this.npcs.pickables(), ...this.buildings.pickables(), ...this.world.hq.pickables, ...this.spark.pickables(), ...this.world.occluders(), ...this.spark.occluders()]);
    if (!hit || hit.object.userData?.occluder) return this.plotAt(clientX, clientY);
    const object = hit.object;
    const person = this.npcs.targetOf(object);
    if (person) return person;
    for (let node = object; node; node = node.parent) {
      const data = node.userData || {};
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
    if ((!i && !j) || Math.max(Math.abs(i), Math.abs(j)) > this.rings) return null;
    const c = cellCenter(i, j);
    if (Math.abs(ground.x - c.x) > LOT_HALF - 0.15 || Math.abs(ground.z - c.z) > LOT_HALF - 0.15) return null;
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
    if (target.kind === 'agent') {
      const agent = this.store.agent(target.id);
      if (!agent) return null;
      const project = this.store.project(agent.currentProjectId);
      return { title: agent.name, status: agent.status, sub: `${STATUS_LABEL[agent.status] || agent.status}${project && agent.status !== 'offline' ? ` · ${project.name}` : ''}`, badge: agent.visiting ? 'visiting' : '' };
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
    else if (code === 'Escape') { if (this.street || this.streetPending) this.exitStreet(); else if (this.cluster) this.closeCluster(true); else if (!this.help.hidden) this.toggleHelp(false); else this.select(null); }
    else if (event.key === '+' || event.key === '=') this.world.zoomBy(0.75);
    else if (event.key === '-' || event.key === '_') this.world.zoomBy(1.33);
  }

  /* ---------------- selection ---------------- */
  onClick(target) {
    // Talk mode: another agent switches the conversation; empty ground (or anything else but you) leaves it.
    if (this.talk) { if (target?.kind === 'agent') this.enterTalk(target.id); else if (target?.kind !== 'owner') this.exitTalk(); return; }
    if (!target) { this.select(null); return; }
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
  }
  /** Fly to the selection. People, the HQ and your avatar live on This PC's face: if the Spark side
   *  is up, the island turns back over first. A building is framed on whichever face is up. */
  focusSelection() {
    const world = this.world, s = this.selection;
    if (this.street || this.streetPending) this.exitStreet({ fly: false });   // any framing flight leaves street view
    const fly = (x, y, z, distance, polar) => world.flyAfterTurn({ target: world.toWorld(new THREE.Vector3(x, y, z), { atRest: true }), distance, polar });
    const pcFirst = () => { if (world.underside) world.flipTo('pc'); };
    if (!s || s.kind === 'owner') { const owner = this.npcs.ownerPosition; if (owner) { pcFirst(); fly(owner.x, 1, owner.z, s ? 11 : 16, s ? 1.1 : 1.0); } return; }
    if (s.kind === 'agent') {
      const p = this.npcs.position(s);
      if (p) { pcFirst(); fly(p.x, 1, p.z, 15, 1.02); }
    } else if (s.kind === 'building') {
      const spark = world.restSide === 'spark' && this.spark.shown ? this.spark.buildings.get(s.id) : null;
      const b = spark || this.buildings.get(s.id);
      if (b) { const height = b.size.H, p = b.worldPoint(0, Math.min(14, height * 0.42), 0); fly(p.x, p.y, p.z, Math.max(20, height * 1.45 + b.size.W * 2.2), 1.0); }
    } else if (s.kind === 'hq') { pcFirst(); fly(0, 3, -0.5, 26, 1.0); }
    else if (s.kind === 'runner') {
      // Spark runners and crew live on the Spark face: roll it up first, then fly to where they'll be.
      const r = this.spark.runner(s.id);
      if (r) {
        const local = world.toLocal(r.person.object.getWorldPosition(new THREE.Vector3()));
        if (world.underside && world.restSide !== 'spark') world.flipTo('spark');
        world.flyAfterTurn({ target: world.toWorld(local, { atRest: true }), distance: 15, polar: 1.02 });
      }
    }
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
  onJump() {
    const value = this.jump.value;
    this.jump.value = '';
    if (!value) return;
    if (value === 'me') { this.findMe(); this.stage.focus({ preventScroll: true }); return; }
    const [kind, ...rest] = value.split(':');
    const id = rest.join(':');
    const target = kind === 'hq' ? { kind: 'hq' } : { kind, id };
    this.select(target);
    this.focusSelection();
    if (kind === 'agent') { const agent = this.store.agent(id); if (agent) this.showBubble(target, this.bubbleText(agent)); }
    this.stage.focus({ preventScroll: true });
  }

  /* ---------------- panels ---------------- */
  refreshPanel() {
    const s = this.selection;
    if (!s) { this.panel.hidden = true; this.root.classList.remove('city-has-panel'); this.panelSig = ''; return; }
    let sig, render;
    const island = this.islands?.panelFor(s);   // contributor island: repo and town-hall cards
    if (island) ({ sig, render } = island);
    else if (s.kind === 'agent') {
      const agent = this.store.agent(s.id);
      if (!agent) { this.select(null); return; }
      sig = JSON.stringify(['agent', agent.id, agent.name, agent.label, agent.status, agent.activity, agent.currentProjectId, agent.homeProjectId, agent.visiting, Math.floor((Date.now() - agent.lastSeenAt) / 60000), agent.unreadForOwner, agent.look, this.store.projects.map(p => [p.id, p.name])]);
      render = () => this.renderAgentPanel(agent);
    } else if (s.kind === 'building') {
      const project = this.store.project(s.id);
      if (!project || !project.visible.city) { this.select(null); return; }
      const here = this.agentsAt(project.id).map(a => [a.id, a.status, a.look]);
      const compute = [...this.spark.sparkJobs(project.id), ...this.spark.gearJobs(project.id)].map(j => [j.job, j.state, j.machine]);
      sig = JSON.stringify(['building', project.id, project.name, project.description, project.metrics, project.languages, project.source, project.private, project.path, project.url, here, compute, Math.floor(Date.now() / 60000)]);
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
      sig = JSON.stringify(['hq', this.store.agents.map(a => [a.id, a.status]), this.store.visibleProjects('city').length]);
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
    return this.store.agents.filter(a => (a.currentProjectId === projectId && a.status !== 'offline') || a.homeProjectId === projectId);
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
    const taskBtn = h('button.btn.small', { type: 'button', disabled: !isMailbox, title: isMailbox ? 'Post a task to this agent' : 'Dedicated agents take live chats instead', onclick: () => { this.taskFormFor = this.taskFormFor === agent.id ? null : agent.id; this.panelSig = ''; this.refreshPanel(); } }, icon('plus'), 'Assign a task here');
    clear(this.panel,
      this.panelHead(portrait(agent.look, { size: 52, provider, status: agent.status }), agent.name, agent.label && agent.label !== agent.name ? agent.label : null,
        iconButton('crosshair', 'Center view (F)', () => this.focusSelection())),
      h('div.city-panel-pills', pill(PROVIDER_LABEL[provider] || PROVIDER_COLORS[provider]?.label || 'Agent', provider === 'other' ? 'accent' : provider), pill(agent.kind === 'mailbox' ? 'Desktop chat · mailbox' : 'Live · dedicated', 'neutral')),
      h('section.city-panel-section', h('div.city-section-label', 'Doing'), agent.activity ? h('p.city-activity', String(agent.activity).slice(0, 400)) : h('p.muted', 'No recent activity on the board.')),
      facts,
      h('div.city-actions',
        h('button.btn.small.primary', { type: 'button', title: 'Walk over and talk here in the city', onclick: () => this.enterTalk(agent.id) }, icon('chat'), 'Talk'),
        h('button.btn.small', { type: 'button', onclick: () => this.ctx.navigate('chat', { agentId: agent.id }) }, icon('chat'), 'Open in Chat'),
        askBtn, taskBtn),
      this.taskFormFor === agent.id && isMailbox ? this.taskForm(agent, current || home) : null,
      h('p.city-note', isMailbox ? MAILBOX_NOTE : 'Live chats start a fresh dedicated agent session for each message (answers in about 30–90 seconds).'));
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
    const total = (project.languages || []).reduce((n, l) => n + (l.bytes || 0), 0);
    const langs = total ? [...project.languages].sort((a, b) => b.bytes - a.bytes) : [];
    const langBar = langs.length ? h('div.city-langbar', { role: 'img', 'aria-label': langs.slice(0, 5).map(l => `${l.name} ${Math.round(l.bytes / total * 100)}%`).join(', ') },
      ...langs.map(l => h('span.city-langbar-seg', { style: { flexGrow: String(Math.max(l.bytes, total * 0.004)), background: l.color }, title: `${l.name} ${Math.round(l.bytes / total * 100)}%` }))) : null;
    const langLegend = langs.length ? h('div.city-lang-legend', ...langs.slice(0, 4).map(l => h('span.city-lang', h('span.city-lang-dot', { style: { background: l.color } }), l.name, h('span.muted', ` ${Math.max(1, Math.round(l.bytes / total * 100))}%`)))) : h('p.muted', 'No language data yet.');
    const stat = (label, value, hint) => h('div.city-stat', h('div.city-stat-value', value), h('div.city-stat-label', label), hint ? h('div.city-stat-hint', hint) : null);
    const building = this.buildings.get(project.id);
    const here = this.agentsAt(project.id);
    const actions = [h('button.btn.small.primary', { type: 'button', onclick: () => this.ctx.navigate('tasks', { project: project.id }) }, icon('tasks'), 'Open tasks')];
    if (project.path) actions.push(h('button.btn.small', { type: 'button', onclick: () => this.open(project.path) }, icon('folder'), 'Open folder'));
    if (project.url) actions.push(h('button.btn.small', { type: 'button', onclick: () => this.open(project.url) }, icon('github'), 'Open on GitHub'));
    if (project.path) actions.push(h('button.btn.small', { type: 'button', onclick: event => this.rescan(project, event.currentTarget) }, icon('refresh'), 'Rescan'));
    actions.push(h('button.btn.small.ghost', { type: 'button', onclick: () => this.hideProject(project) }, icon('eyeOff'), 'Hide from city'));
    const jobRow = (job, spark) => h('div.city-job', h(`span.city-job-where.${spark ? 'spark' : 'local'}`, spark ? 'DGX Spark' : 'This PC'), h('span.city-job-label', jobLabel(job)), job.started_at ? h('span.city-job-time', timeAgo(job.started_at)) : null);
    const sparkJobs = this.spark.sparkJobs(project.id), localJobs = this.spark.gearJobs(project.id);
    const compute = sparkJobs.length || localJobs.length
      ? h('section.city-panel-section', h('div.city-section-label', 'Compute jobs running'), h('div.city-jobs', ...sparkJobs.map(j => jobRow(j, true)), ...localJobs.map(j => jobRow(j, false))))
      : null;
    clear(this.panel,
      this.panelHead(swatch, project.name, project.primaryLanguage ? `${project.primaryLanguage} · ${building?.size.floors || m.floors} floor${(building?.size.floors || m.floors) === 1 ? '' : 's'}` : null,
        iconButton('crosshair', 'Center view (F)', () => this.focusSelection())),
      sources.length ? h('div.city-panel-pills', sources) : null,
      project.description ? h('p.city-desc', project.description) : null,
      h('section.city-panel-section', h('div.city-section-label', 'Languages'), langBar, langLegend),
      h('div.city-stats',
        stat('Lines of code', formatNumber(m.loc || 0)),
        stat('Files', m.files ? formatNumber(m.files) : '—'),
        stat('Commits', m.commits ? formatNumber(m.commits) : '—', m.commits7d ? `+${m.commits7d} in 7 days` : null),
        stat('Last activity', m.lastActivityAt ? timeAgo(m.lastActivityAt) : '—', m.sizeBytes ? formatBytes(m.sizeBytes) : null)),
      h('section.city-panel-section', h('div.city-section-label', 'Agents here'),
        here.length ? h('div.city-people', ...here.map(a => h('button.city-person', { type: 'button', title: `${a.name} · ${STATUS_LABEL[a.status] || a.status}${a.homeProjectId === project.id ? ' · lives here' : ' · visiting'}`, onclick: () => { this.select({ kind: 'agent', id: a.id }); this.focusSelection(); } },
          portrait(a.look, { size: 34, provider: a.provider, status: a.status }), h('span', a.name))))
          : h('p.muted', 'Nobody is here right now. Assign one from an agent card.')),
      compute,
      h('div.city-actions.wrap', actions));
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
    const agents = this.store.agents;
    const count = status => agents.filter(a => a.status === status).length;
    clear(this.panel,
      this.panelHead(h('span.city-swatch.hq', icon('home')), 'CodaClauda HQ', 'Town hall and plaza'),
      h('p.city-desc', 'Agents without a home project gather here. Powered-down agents rest on the plaza benches; your avatar starts by the fountain.'),
      h('div.city-stats',
        h('div.city-stat', h('div.city-stat-value', String(count('active'))), h('div.city-stat-label', 'Working')),
        h('div.city-stat', h('div.city-stat-value', String(count('idle'))), h('div.city-stat-label', 'Awake')),
        h('div.city-stat', h('div.city-stat-value', String(count('offline'))), h('div.city-stat-label', 'Powered down')),
        h('div.city-stat', h('div.city-stat-value', String(this.store.visibleProjects('city').length)), h('div.city-stat-label', 'Buildings'))),
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
      if (!label) { label = { node: h('div.city-label', { hidden: true }), sig: '', kind: key === 'owner' ? 'owner' : 'agent', full: false, show: false, on: false, w: null }; this.labels.set(key, label); this.labelLayer.append(label.node); }
      label.agent = agent;
      label.name = String(agent ? agent.name : this.store.avatar?.name || 'You');
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
    const agents = this.store.agents || [];
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
    const sig = JSON.stringify([projects.length, agents.length, working, projects.map(p => [p.id, p.name]), agents.map(a => [a.id, a.name, a.status]), sparkPeople.map(r => [r.id, r.agent?.name || '', r.crew ? 1 : 0]), this.store.avatar?.name || '']);
    if (sig === this.hudSig) return;
    this.hudSig = sig;
    clear(this.stats,
      h('span', h('strong', String(projects.length)), ` building${projects.length === 1 ? '' : 's'}`),
      h('span.city-dot-sep', '·'),
      h('span', h('strong', String(agents.length)), ` agent${agents.length === 1 ? '' : 's'}`),
      working ? [h('span.city-dot-sep', '·'), h('span.city-working', h('span.city-gem.active'), `${working} working`)] : null);
    const sparkLabel = r => r.crew ? 'Spark crew — resting' : `${r.agent?.name || 'Spark runner'} — ${jobLabel(r.job)}`;
    clear(this.jump,
      h('option', { value: '' }, 'Jump to…'),
      h('option', { value: 'me' }, `📌 You (${this.store.avatar?.name || 'me'})`),
      h('option', { value: 'hq' }, 'CodaClauda HQ'),
      agents.length ? h('optgroup', { label: 'This PC — agents' }, ...agents.map(a => h('option', { value: `agent:${a.id}` }, `${a.name} — ${STATUS_LABEL[a.status] || a.status}`))) : null,
      sparkPeople.length ? h('optgroup', { label: 'DGX Spark — agents & crew' }, ...sparkPeople.map(r => h('option', { value: `runner:${r.id}` }, sparkLabel(r)))) : null,
      projects.length ? h('optgroup', { label: 'Buildings' }, ...[...projects].sort((a, b) => a.name.localeCompare(b.name)).map(p => h('option', { value: `building:${p.id}` }, p.name))) : null);
    this.jump.value = '';
  }
  renderTimeChip() {
    if (!this.world) return;
    const info = this.world.timeInfo();
    const text = `${info.phase} · ${info.mode === 'auto' ? new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : info.mode === 'day' ? 'Day lock' : 'Night lock'}`;
    if (this.timeChip.textContent !== text) clear(this.timeChip, icon(info.phase === 'Night' ? 'moon' : 'sun'), text);
  }
  renderToolbarState() {
    const mode = this.world.timeMode;
    this.timeBtn.replaceChildren(icon(mode === 'day' ? 'sun' : mode === 'night' ? 'moon' : 'clock'));
    const timeLabel = `Time of day: ${TIME_LABEL[mode]} — click to change`;
    this.timeBtn.title = timeLabel; this.timeBtn.setAttribute('aria-label', timeLabel);
    const high = this.world.quality !== 'low';
    const qualityLabel = high ? 'Shadows on (high quality) — click for faster' : 'Shadows off (fast) — click for high quality';
    this.qualityBtn.title = qualityLabel; this.qualityBtn.setAttribute('aria-label', qualityLabel);
    this.qualityBtn.setAttribute('aria-pressed', String(high));
    this.followBtn.setAttribute('aria-pressed', String(Boolean(this.following)));
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
    this.legendSideText.textContent = spark ? 'Other side = This PC' : 'Other side = DGX Spark';
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
      h('p', allHidden ? `${hiddenCount} linked project${hiddenCount === 1 ? ' is' : 's are'} hidden. Show them again from Projects.` : 'Link Desktop folders or GitHub repos and each project becomes a building here — or click an empty plot to start a brand-new project. Taller buildings mean more code and commits.'),
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
  /** Home / H: back to the framed overview, and let auto-framing follow the island again. */
  resetCamera() {
    if (!this.world) return;
    if (this.street || this.streetPending) this.exitStreet({ fly: false });
    if (this.following) this.toggleFollow(false);
    this.world.resetView({ auto: true });
    this.world.userMoved = false;
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
      world.flyTo({ target: back.target, distance: s.radius, polar: s.phi, azimuth: s.theta }, { duration: 0.85, instant });
    }
    this.renderToolbarState();
    this.refreshPanel();
  }
  /** Solid footprints for street walking (island space, grown by the walker's radius): every building
   *  standing on its lot plus the HQ town hall, fountain and planters. */
  streetBoxes() {
    const r = STREET.radius, out = HQ_BOXES.map(b => ({ x0: b.x0 - r, x1: b.x1 + r, z0: b.z0 - r, z1: b.z1 + r, low: Boolean(b.low) }));
    for (const b of this.buildings.list) {
      const hw = b.size.W / 2 + 0.14 + r, hd = b.size.D / 2 + 0.14 + r;
      out.push({ x0: b.origin.x - hw, x1: b.origin.x + hw, z0: b.origin.z - hd, z1: b.origin.z + hd });
    }
    return out;
  }
  /** Is an island-space point inside a building or the town hall (This PC side up)? Wheel zoom stops at walls. */
  solidAt(p) {
    if (this.world.side !== 'pc') return false;
    const r = STREET.radius, hall = HQ_BOXES[0];
    if (p.y < 11.5 && p.x > hall.x0 - r && p.x < hall.x1 + r && p.z > hall.z0 - r && p.z < hall.z1 + r) return true;
    return this.buildings.list.some(b => p.y < GROUND_Y + b.size.H + 0.6 && Math.abs(p.x - b.origin.x) < b.size.W / 2 + 0.14 + r && Math.abs(p.z - b.origin.z) < b.size.D / 2 + 0.14 + r);
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
    this.world.flip();
    this.stage.focus({ preventScroll: true });
  }

  /** Where the camera is (or where a flight under way is heading): { target, position }, world space. */
  cameraPose() {
    const world = this.world, tw = world.tween;
    return tw && !tw.free
      ? { target: tw.toTarget.clone(), position: new THREE.Vector3().setFromSpherical(tw.to).add(tw.toTarget) }
      : { target: world.controls.target.clone(), position: world.camera.position.clone() };
  }

  /* ---------------- talk mode ---------------- */
  /** Click an agent: your avatar walks over, the two face each other and the camera drops to an
   *  over-the-shoulder shot while the conversation opens on the right (city/talk.js). Esc, Leave or a
   *  click on empty ground ends it: the camera eases back, the HUD returns, the agent carries on.
   *  Agents live on This PC side: with the Spark side up the island turns over first. */
  enterTalk(id) {
    const world = this.world, agent = this.store.agent(id);
    if (!world || this.failed || !agent) return;
    if (this.talk?.id === id) { this.talkPanel.focus(); return; }
    const prev = this.talk;
    if (prev) this.releaseTalk(prev);   // another agent: keep where to go back to
    let back = prev?.back || null;
    if (this.street || this.streetPending) { back ||= this.streetReturn; this.exitStreet({ fly: false }); }   // street view: back to the overview it began from
    back ||= this.cameraPose();
    if (this.following) this.toggleFollow(false);
    this.closeCluster(); this.hideZoomHint(); this.setHover(null); this.select(null);
    this.bubble.hidden = true; this.bubbleTarget = null; this.bubbleUntil = 0;
    for (const b of Object.values(this.talkBubbles)) b.node.hidden = true;
    this.talk = { id, back, phase: 'wait', at: performance.now() };
    this.npcs.hold(id, true);
    if (world.underside && world.restSide !== 'pc') world.flipTo('pc');
    this.cityRoot.classList.add('is-talk');
    this.talkPanel.open(agent);
    this.talkPanel.focus();
    this.declutterAt = 0;
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
    if (t.back) {
      const s = new THREE.Spherical().setFromVector3(t.back.position.clone().sub(t.back.target));
      world.flyAfterTurn({ target: t.back.target, distance: s.radius, polar: s.phi, azimuth: s.theta }, { duration: 1, instant });
    }
    this.declutterAt = 0;
    this.renderToolbarState();
    if (!instant) this.stage.focus({ preventScroll: true });
  }
  releaseTalk(t) {
    this.npcs.hold(t.id, false);
    if (t.ownerPose && this.npcs.owner && !this.npcs.owner.path.length) this.npcs.act(OWNER_TARGET, 'stand');
  }
  /** Once a frame: wait for the island to settle (This PC side up), stage the scene, finish the walk-up,
   *  end timed gestures and re-aim the shot when the view or the panel changes size. */
  updateTalk() {
    const t = this.talk, world = this.world;
    if (!t) return;
    const now = performance.now();
    if (t.phase === 'wait') {
      if (!world.settled) return;   // still turning over
      if (world.side !== 'pc' && world.underside && now - t.at < 4000) { world.flipTo('pc'); return; }
      this.stageTalk(t);
    }
    const agentT = { kind: 'agent', id: t.id }, owner = this.npcs.owner;
    if (t.phase === 'walk') {
      if (owner && !t.seated) this.npcs.face(agentT, owner.pos.x, owner.pos.z);   // it watches you come over
      if (!owner || !owner.path.length || now - t.walkAt > 6000) this.arriveTalk(t);
    }
    for (const [key, target] of [['ownerPose', OWNER_TARGET], ['agentPose', agentT]]) {
      const pose = t[key];
      if (pose && now > pose.until) { t[key] = null; this.npcs.act(target, pose.next || 'stand'); }
    }
    if (t.spot && now > (t.frameCheck || 0)) {
      t.frameCheck = now + 400;
      if (this.talkFrameSig() !== t.frameSig) this.aimTalk(t, this.reduced() ? 0 : 0.45);
    }
  }
  /** Pick Ben's spot in front of the agent, send him there (briskly; reappearing close by when he is
   *  across town; snapping there with reduced motion) and fly the camera to the shot. */
  stageTalk(t) {
    const world = this.world, agentT = { kind: 'agent', id: t.id }, a = this.npcs.position(agentT), owner = this.npcs.owner;
    t.phase = 'on';
    if (!a || world.side !== 'pc') return;   // no figure to stage (yet): the conversation still works without the scene
    const reduced = this.reduced(), boxes = this.streetBoxes(), limit = world.half - 2;
    const near = owner && Math.hypot(owner.pos.x - a.x, owner.pos.z - a.z) < 9;
    t.seated = this.npcs.seated(t.id);
    // A bottom sheet leaves a short strip of the view: stand the camera further back so the two still fit.
    const vis = this.talkFraming().vis, k = Math.min(1.6, Math.max(1, Math.sqrt(world.size.h / Math.max(1, vis.y1 - vis.y0))));
    const spot = talkSpot(a, near ? owner.pos : this.cameraLocal(), { boxes, limit, facing: t.seated ? this.npcs.yaw(agentT) : null, back: STAGE.back * k, side: STAGE.side * k });
    t.spot = spot; t.a = { x: a.x, y: a.y, z: a.z };
    if (owner) {
      const far = Math.hypot(owner.pos.x - spot.x, owner.pos.z - spot.z);
      if (reduced || far < 0.25) this.npcs.driveOwner(spot.x, spot.z, spot.heading, false);
      else {
        if (far > 7) {
          const sx = spot.x + Math.sin(spot.yaw) * STAGE.approach, sz = spot.z + Math.cos(spot.yaw) * STAGE.approach;
          const open = Math.abs(sx) < limit && Math.abs(sz) < limit && !boxes.some(b => sx > b.x0 && sx < b.x1 && sz > b.z0 && sz < b.z1);
          world.particles.emit('sparkle', { x: owner.pos.x, y: owner.pos.y + 1, z: owner.pos.z }, 12, { spread: 0.5 });
          this.npcs.driveOwner(open ? sx : spot.x, open ? sz : spot.z, spot.heading, false);
        }
        this.npcs.walkOwner(spot.x, spot.z, { speed: 3.2, marker: false, direct: true });
        if (owner.path.length) { t.phase = 'walk'; t.walkAt = performance.now(); }
      }
    }
    if (t.phase === 'on') this.arriveTalk(t);
    this.aimTalk(t, reduced ? 0 : 1.25);
  }
  /** Ben is in place: the two face each other and the agent says hello. */
  arriveTalk(t) {
    t.phase = 'on';
    const agentT = { kind: 'agent', id: t.id }, owner = this.npcs.owner, a = this.npcs.position(agentT);
    if (owner && a) { this.npcs.face(OWNER_TARGET, a.x, a.z); if (!t.seated) this.npcs.face(agentT, owner.pos.x, owner.pos.z); }
    const agent = this.store.agent(t.id);
    if (!agent || t.greeted) return;
    t.greeted = true;
    this.npcs.act(agentT, 'wave'); t.agentPose = { until: performance.now() + 1600, next: 'stand' };
    this.talkSay('agent', this.bubbleText(agent));
  }
  /** Fly to (or, after a resize, re-aim) the over-the-shoulder shot. */
  aimTalk(t, duration) {
    const world = this.world, spot = t.spot;
    if (!spot) return;
    const frame = this.talkFraming();
    const face = { x: t.a.x, y: t.a.y + this.npcs.faceHeight({ kind: 'agent', id: t.id }), z: t.a.z };
    const shot = talkShot(spot, face, { eyeY: groundY(spot.x, spot.z) + this.npcs.topHeight(OWNER_TARGET) * 0.86, nx: frame.nx, ny: frame.ny, vfov: world.camera.fov, aspect: world.size.w / Math.max(1, world.size.h) });
    const v = p => world.toWorld(new THREE.Vector3(p.x, p.y, p.z), { atRest: true });
    world.setShot({ eye: v(shot.eye), look: v(shot.look) }, { duration, instant: !duration });
    t.frameSig = this.talkFrameSig(); t.vis = frame.vis;
  }
  /** Where the agent's face should land (NDC): in the part of the view the conversation leaves free
   *  (left of the docked panel, or above the bottom sheet on narrow windows). Layout boxes, not the
   *  panel's slide-in transform. */
  talkFraming() {
    const { w: W, h: H } = this.world.size, panel = this.talkPanel.node, vis = { x0: 0, x1: W, y0: 0, y1: H };
    if (!panel.hidden && panel.offsetWidth && panel.offsetHeight) {
      if (panel.offsetTop > H * 0.25) vis.y1 = Math.max(H * 0.3, panel.offsetTop);   // bottom sheet
      else vis.x1 = Math.max(W * 0.35, panel.offsetLeft);                             // docked on the right
    }
    const px = vis.x0 + (vis.x1 - vis.x0) * 0.56, py = vis.y0 + (vis.y1 - vis.y0) * 0.47;
    return { nx: 2 * px / W - 1, ny: 1 - 2 * py / H, vis };
  }
  talkFrameSig() { const p = this.talkPanel.node, { w, h } = this.world.size; return `${w}x${h}|${p.offsetLeft}|${p.offsetTop}`; }
  /** A speech bubble over you ('owner') or the agent ('agent'); '…' shows typing dots. */
  talkSay(who, text, ms = 7000) {
    const b = this.talkBubbles[who], typing = text === '…';
    if (!b || !text) return;
    if (typing) clear(b.node, h('span.typing-dots', h('i'), h('i'), h('i'))); else b.node.textContent = text;
    b.node.classList.toggle('is-typing', typing);
    b.node.hidden = false; b.until = performance.now() + ms; b.size = null;
  }
  talkSent(text) {
    const t = this.talk;
    if (!t) return;
    this.talkSay('owner', sayLine(text), 6000);
    this.npcs.act(OWNER_TARGET, 'talk'); t.ownerPose = { until: performance.now() + 2400, next: 'stand' };
  }
  talkHeard(text) {
    const t = this.talk;
    if (!t) return;
    this.talkSay('agent', text, 9000);
    this.npcs.act({ kind: 'agent', id: t.id }, 'talk'); t.agentPose = { until: performance.now() + 3400, next: 'stand' };
  }
  /** A live reply is being written: typing dots over the agent, which gets busy at its laptop. */
  talkThinking(on) {
    const t = this.talk, agentT = { kind: 'agent', id: t?.id };
    if (!t) return;
    if (on) { this.talkSay('agent', '…', 15 * 60e3); this.npcs.act(agentT, 'work'); t.agentPose = null; return; }
    const b = this.talkBubbles.agent;
    if (b.node.classList.contains('is-typing')) b.node.hidden = true;
    if (!t.agentPose) this.npcs.act(agentT, 'stand');   // a reply that just landed keeps its talk gesture
  }
  /** Talk bubbles ride above the two heads, kept inside the part of the view the panel leaves free. */
  placeTalkBubbles(scratch, point) {
    const t = this.talk, world = this.world, now = performance.now(), cam = world.camera;
    const dir = cam.getWorldDirection(this._talkDir ||= new THREE.Vector3());
    const { w: W, h: H } = world.size, vis = t.vis || { x0: 0, x1: W, y0: 0, y1: H }, bar = t.spot ? H * TALK_BAR : 0;
    for (const [who, b] of Object.entries(this.talkBubbles)) {
      if (b.node.hidden) continue;
      if (now > b.until) { b.node.hidden = true; continue; }
      const target = who === 'owner' ? OWNER_TARGET : { kind: 'agent', id: t.id };
      const pos = this.facesUp(target) ? this.npcs.position(target) : null;
      let on = Boolean(pos);
      if (pos) {
        world.toWorld(scratch.set(pos.x, pos.y + this.npcs.topHeight(target) + 0.3, pos.z), { out: scratch });
        on = (this._talkTo ||= new THREE.Vector3()).subVectors(scratch, cam.position).dot(dir) > 0.2;   // in front of the camera (off-screen is clamped in, below)
        world.project(scratch, point);
      }
      b.node.style.visibility = on ? '' : 'hidden';
      if (!on) continue;
      b.size ||= { w: b.node.offsetWidth, h: b.node.offsetHeight };
      const x = Math.max(vis.x0 + b.size.w / 2 + 10, Math.min(vis.x1 - b.size.w / 2 - 10, point.x));
      const y = Math.max(vis.y0 + bar + b.size.h + 12, Math.min(vis.y1 - bar - 12, point.y));
      b.node.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  }

  /* ---------------- empty plot → new project ---------------- */
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
      result = await openNewProjectDialog(this.ctx, { lot });
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
    for (const label of this.runnerLabels.values()) label.node.remove();
    this.runnerLabels.clear();
    clearTimeout(this.checkTimer);
    this.islands?.dispose();
    this.spark?.dispose(); this.npcs?.dispose(); this.buildings?.dispose(); this.world?.dispose();
    this.root.replaceChildren();
  }
  hide() {
    this.visible = false;
    if (this.failed || !this.world) return;
    this.exitTalk({ instant: true });
    this.exitStreet({ instant: true });   // coming back to the City starts from the overview
    this.world.releaseTilt?.();
    this.islands?.hide();
    this.world.stop();
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.closeCluster();
    this.setHover(null);
    clearTimeout(this.plotClickTimer); this.plotClickTimer = 0;
    this.bubble.hidden = true; this.bubbleTarget = null;
  }
}
