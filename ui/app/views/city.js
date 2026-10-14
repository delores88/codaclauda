/* City view: a playful 3D "project city". Every visible project is a building on a
 * floating island; agents walk between them as little people. HTML overlays (labels,
 * tags, bubbles, panels, toolbar) sit on top of the WebGL canvas. */
import { h, icon, iconButton, registerIcons, toast, portrait, timeAgo, fullTime, pill, plural, statusDot, STATUS_LABEL, formatNumber, formatBytes, clear } from '../ui.js';
import { PROVIDER_COLORS } from '../avatar/spec.js';
import { THREE } from '../city/toon.js';
import { World, webglAvailable } from '../city/world.js';
import { BuildingManager } from '../city/buildings.js';
import { NpcManager, loadPeople, setPeopleReducedMotion } from '../city/npc.js';
import { SlotMap, cellCenter, cellOf, cellKey, LOT_HALF } from '../city/layout.js';
import { buildPlotMarker, GROUND_Y } from '../city/scenery.js';
import { SparkCity, FOUNDRY, jobLabel } from '../city/spark.js';

registerIcons({
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.6 2.4c-.8.4-1.2.9-1.2 1.7v.4M12 17h.01"/>',
  crosshair: '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="1.4"/>',
  cube: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
  'city-chip': '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  'city-flip': '<path d="M3 12h18"/><path d="M8 8.5 12 4l4 4.5M8 15.5l4 4.5 4-4.5"/>',
  'city-chevron-up': '<path d="m6 15 6-6 6 6"/>',
  'city-chevron-down': '<path d="m6 9 6 6 6-6"/>',
});

const HELP_KEY = 'codaclauda.city.help-dismissed';
const TIME_MODES = ['auto', 'day', 'night'];
const TIME_LABEL = { auto: 'Auto (your clock)', day: 'Always day', night: 'Always night' };
const PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex', other: 'Agent' };
const SPARK_MODES = ['auto', 'on', 'off'];
const SPARK_LABEL = { auto: 'Auto (shown when the Spark bridge is on)', on: 'Always shown', off: 'Hidden' };
const MACHINES_KEY = 'codaclauda.city.machines-collapsed';
const UNDER_KINDS = new Set(['spark', 'runner', 'foundry']);
const PLOT_HOLD_MS = 10 * 60e3;
const EMPTY_MACHINES = { enabled: false, configured: false, error: '', local: { running: 0, cpuReserved: 0, cpuHours24h: 0 }, spark: { running: 0, cpuReserved: 0, cpuHours24h: 0 }, jobs: [] };
const fmtCores = n => (n % 1 ? n.toFixed(1) : String(n));
const fmtHours = n => (n < 10 ? n.toFixed(1) : String(Math.round(n)));
const ROUTE_CAPS = new Set(['lan', 'wan', 'ssh', 'vpn', 'usb', 'tcp', 'http', 'https', 'api']);
const prettyRoute = route => String(route || '').split(/[-_ ]+/).filter(Boolean).map((w, k) => (ROUTE_CAPS.has(w.toLowerCase()) ? w.toUpperCase() : k ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
const MAILBOX_NOTE = 'The board is a passive shared mailbox: messages wait until each desktop agent checks its inbox. Schedules vary and posting does not wake an agent. A message is information, not permission.';
const storage = { get(key) { try { return localStorage.getItem(key); } catch { return null; } }, set(key, value) { try { localStorage.setItem(key, value); } catch { /* optional */ } } };
// Name labels: screen-space declutter (see declutterLabels) re-run every DECLUTTER_MS.
const LABEL_MAX = 10;            // labels + cluster chips on screen at once (selected/hovered always show)
const DECLUTTER_MS = 120;
const LABEL_H = 22, CHIP_H = 24, LABEL_LIFT = 4, RUNNER_DROP = 4;   // match .city-label / .city-cluster in city.css
const LABEL_PRIORITY = { active: 60, idle: 40, offline: 20 };
const OWNER_PRIORITY = 55;       // "You": above idle people and idle groups (chips get +10), below working agents
const SHORT_NAME = 18;
const OWNER_TARGET = Object.freeze({ kind: 'owner' });
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
    root.classList.add('city-view');
    this.buildDom();
    if (!webglAvailable()) { this.fail('This computer could not start 3D graphics (WebGL is unavailable).'); return; }
    try { this.initWorld(); }
    catch (error) { console.error(error); this.fail(`The 3D view could not start: ${error.message}`); return; }
    this.store.on('change', () => { this.dirty = true; if (this.visible && !this.world.running) this.sync(); });
    loadPeople().then(create => { this.npcs.setCreate(create); this.peopleReady = true; this.dirty = true; if (this.visible) this.sync(); });
  }

  reduced() { return Boolean(this.store.prefs.reducedMotion) || Boolean(this.motionQuery?.matches); }

  /* ---------------- DOM skeleton ---------------- */
  buildDom() {
    this.stage = h('div.city-stage', { tabindex: '0', role: 'application', 'aria-label': 'Project city. Drag to orbit, right-drag to pan, scroll to zoom. W A S D pan, Q and E rotate, F focuses the selection, H resets the view.' });
    this.tag = h('div.city-tag', { hidden: true, 'aria-hidden': 'true' });
    this.bubble = h('div.city-bubble', { hidden: true, role: 'status' });
    this.labelLayer = h('div.city-labels', { 'aria-hidden': 'true' });
    this.chipLayer = h('div.city-chips');
    // Scrolling over a chip still zooms the city.
    this.chipLayer.addEventListener('wheel', event => { event.preventDefault(); this.world?.renderer.domElement.dispatchEvent(new WheelEvent('wheel', event)); }, { passive: false });
    this.clusterPop = h('div.city-cluster-pop.card', { hidden: true, role: 'dialog', 'aria-label': 'Agents at this spot' });
    this.overlay = h('div.city-overlay', this.labelLayer, this.chipLayer, this.tag, this.bubble, this.clusterPop);

    this.stats = h('div.city-hud-stats');
    this.timeChip = h('span.city-chip');
    this.jump = h('select.select.city-jump', { 'aria-label': 'Jump to a building or agent', onchange: () => this.onJump() });
    this.hud = h('header.city-hud',
      h('div.city-hud-title', h('span.eyebrow', 'Project city'), this.stats),
      h('div.city-hud-row', this.timeChip, this.jump));

    this.legendSpark = h('div.city-legend-extra', { hidden: true }, h('div.city-legend-sep'), h('div.city-legend-row', h('span.city-gem.spark'), 'Underside = DGX Spark'));
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
    this.sparkBtn = iconButton('city-chip', 'Spark underside', () => this.cycleSpark(), 'city-tool');
    this.flipLabel = h('span', 'Spark side');
    this.flipBtn = h('button.city-flip', { type: 'button', hidden: true, onclick: () => this.flipSide() }, icon('city-flip'), this.flipLabel);
    this.toolbar = h('div.city-toolbar', { role: 'toolbar', 'aria-label': 'City controls' },
      this.flipBtn,
      iconButton('zoomIn', 'Zoom in', () => this.world?.zoomBy(0.72), 'city-tool'),
      iconButton('zoomOut', 'Zoom out', () => this.world?.zoomBy(1.38), 'city-tool'),
      iconButton('home', 'Reset view (H)', () => this.resetCamera(), 'city-tool'),
      this.followBtn, h('span.city-toolbar-sep'), this.timeBtn, this.qualityBtn, this.sparkBtn, this.helpBtn);

    this.help = h('div.city-help.card', { hidden: true, role: 'dialog', 'aria-label': 'City controls' },
      h('div.city-help-head', h('strong', 'Getting around'), iconButton('close', 'Close help', () => this.toggleHelp(false))),
      h('dl.city-help-list',
        ...[['Left-drag', 'Orbit'], ['Right-drag', 'Pan'], ['Scroll wheel / pinch', 'Zoom toward the pointer'], ['W A S D / arrows', 'Move'], ['Q / E', 'Rotate'], ['Click', 'Select a person or building'], ['Click an empty plot', 'Start a new project there'], ['Double-click ground', 'Walk your avatar there'], ['F', 'Focus selection'], ['H', 'Reset view'], ['Esc', 'Deselect']]
          .flatMap(([k, v]) => [h('dt', h('kbd', k)), h('dd', v)])),
      h('button.btn.small.primary', { type: 'button', onclick: () => this.toggleHelp(false) }, 'Got it'));

    this.machinesCard = h('section.city-machines', { hidden: true, 'aria-label': 'Machine load' });
    this.panel = h('aside.city-panel.card', { hidden: true, 'aria-live': 'polite' });
    this.empty = h('div.city-empty.card', { hidden: true });
    this.fallback = h('div.city-fallback', { hidden: true });
    this.root.append(h('div.city-root', this.stage, this.overlay, this.hud, this.legend, this.machinesCard, this.toolbar, this.help, this.panel, this.empty, this.fallback));
    if (!storage.get(HELP_KEY)) this.help.hidden = false;
  }

  fail(message) {
    this.failed = true;
    for (const node of [this.hud, this.legend, this.toolbar, this.help, this.panel, this.empty, this.overlay, this.machinesCard]) node.hidden = true;
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
    this.buildings = new BuildingManager(this.world.city, { particles: this.world.particles, reducedMotion: () => this.reduced() });
    this.npcs = new NpcManager(this.world.city, { buildings: this.buildings, particles: this.world.particles, reducedMotion: () => this.reduced() });
    this.spark = new SparkCity(this.world, { makePerson: (spec, options) => this.npcs.makePerson(spec, options), particles: this.world.particles, reducedMotion: () => this.reduced(), topBuildings: this.buildings });
    this.plotMarker = buildPlotMarker();
    this.world.city.add(this.plotMarker.group);
    this.world.onFrame((dt, elapsed, env) => this.frame(dt, elapsed, env));
    this.bindInput();
  }

  sparkMode() { return SPARK_MODES.includes(this.store.prefs.citySpark) ? this.store.prefs.citySpark : 'auto'; }
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
    if (ringsChanged && !this.world.userMoved && !this.pendingFocus) this.world.resetView({ instant: !this.firstSyncDone, auto: true });
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
    const machines = this.readMachines();
    const mode = this.sparkMode();
    const under = mode === 'on' || (mode === 'auto' && Boolean(machines.enabled));
    this.machines = machines;
    this.world.setUnderside(under);
    try { this.spark.sync({ shown: under, projects, cells, rings, machines, quality, peopleReady: Boolean(this.peopleReady), gears: mode !== 'off' }); }
    catch (error) { console.error('City: could not build the Spark underside', error); }
    this.legendSpark.hidden = !under;
    this.legendGear.hidden = !this.spark.gears.size;
    this.syncRunnerLabels();
    this.renderMachines(machines, mode);
    this.firstSyncDone = true;
    this.syncLabels(agents);
    this.renderHud(projects, agents);
    this.renderEmpty(projects);
    this.renderToolbarState();
    this.refreshPanel();
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
    this.renderFlip();
    this.hoverTimer = (this.hoverTimer || 0) - dt;
    if (this.pointer && (this.hoverDirty || this.hoverTimer <= 0) && !this.dragging) { this.hoverDirty = false; this.hoverTimer = 0.2; this.updateHover(); }
    this.updateOverlays();
    if (this.bubbleUntil && performance.now() > this.bubbleUntil) { this.bubble.hidden = true; this.bubbleUntil = 0; this.bubbleTarget = null; }
    this.timeChipTimer = (this.timeChipTimer || 0) - dt;
    if (this.timeChipTimer <= 0) { this.timeChipTimer = 5; this.renderTimeChip(); }
  }

  updateOverlays() {
    const world = this.world, cam = world.camera;
    cam.updateMatrixWorld();
    const scratch = this.scratch ||= new THREE.Vector3(), point = { x: 0, y: 0, visible: false };
    const camPos = cam.position, under = world.isUnder;
    // 1. Project every name label (math only, no DOM). HTML labels ignore depth: top-city names only
    //    from above, Spark runner tags only from below.
    const projectLabel = (label, fadeFrom, fadeOver) => {
      world.project(scratch, point);
      label.dist = camPos.distanceTo(scratch);
      label.fade = Math.max(0, Math.min(1, fadeFrom - label.dist / fadeOver));
      label.on = point.visible && label.fade > 0.04;
      label.px = point.x; label.py = point.y;
    };
    for (const [id, label] of this.runnerLabels) {
      const runner = under ? this.spark.runner(id) : null;
      label.on = false;
      if (!runner) continue;
      this.spark.runnerHead(runner, scratch);
      projectLabel(label, 1.7, 130);
    }
    for (const [key, label] of this.labels) {
      const target = key === 'owner' ? OWNER_TARGET : { kind: 'agent', id: key };
      const pos = under ? null : this.npcs.position(target);
      label.on = false;
      if (!pos) continue;
      scratch.set(pos.x, pos.y + this.npcs.headroom(target), pos.z);
      projectLabel(label, 1.5, 110);
    }
    // 2. Throttled: decide which labels and cluster chips show (one read pass, then writes).
    const now = performance.now();
    if (now >= this.declutterAt) { this.declutterAt = now + DECLUTTER_MS; this.declutter(); }
    // 3. Every frame: shown labels and chips follow the heads.
    for (const label of this.runnerLabels.values()) this.placeLabel(label, 'translate(-50%, 0)');
    for (const label of this.labels.values()) this.placeLabel(label, 'translate(-50%, -100%)');
    this.placeChips();
    this.placeClusterPop();
    // Tags and bubbles sit just above a person's name label (offset in screen space) or above a roof.
    const place = (node, target) => {
      const person = target.kind === 'agent' || target.kind === 'owner';
      const below = UNDER_KINDS.has(target.kind);   // the Spark city hangs: its tags sit under the target
      const p = this.targetPoint(target, person || below ? 0 : 0.4);
      if (!p) { node.hidden = true; return; }
      world.project(p, point);
      node.hidden = !point.visible;
      node.classList.toggle('on-person', person);
      node.classList.toggle('is-under', below);
      node.style.transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0) ${below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)'}`;
    };
    const bubbleOnHover = this.bubbleTarget && this.hover && this.bubbleTarget.kind === this.hover.kind && this.bubbleTarget.id === this.hover.id;
    if (this.hover && this.hoverInfo && !bubbleOnHover) place(this.tag, this.hover);
    else this.tag.hidden = true;
    if (this.bubbleTarget) place(this.bubble, this.bubbleTarget);
  }
  /** Label declutter pass: reads first (panel rects, label sizes), then writes. */
  declutter() {
    const { w: W, h: H } = this.world.size;
    const base = this.overlay.getBoundingClientRect();
    const blockers = [];
    for (const node of [this.hud, this.legend, this.toolbar, this.machinesCard, this.panel, this.help, this.empty, this.tag, this.bubble, this.clusterPop]) {
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
      const top = runner ? label.py + RUNNER_DROP : label.py - LABEL_LIFT - LABEL_H;
      const priority = key === selected ? 100 : key === hovered ? 90 : key === 'owner' ? OWNER_PRIORITY : runner ? LABEL_PRIORITY.active : LABEL_PRIORITY[label.agent?.status] ?? 30;
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
    const agent = this.store.agent(id);
    if (!agent) return;
    const target = { kind: 'agent', id };
    this.select(target);
    this.focusSelection();
    this.npcs.greet(id, this.world.camera.position);
    this.showBubble(target, this.bubbleText(agent));
    this.stage.focus({ preventScroll: true });
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
  /** World point above a target (agents/owner: above the head; buildings: above the roof). */
  targetPoint(target, lift = 0) {
    if (!target) return null;
    if (target.kind === 'agent' || target.kind === 'owner') { const p = this.npcs.position(target); return p ? new THREE.Vector3(p.x, p.y + this.npcs.headroom(target) + lift, p.z) : null; }
    if (target.kind === 'building') { const b = this.buildings.get(target.id); return b ? b.topPoint().add(new THREE.Vector3(0, lift, 0)) : null; }
    if (target.kind === 'hq') return new THREE.Vector3(0, 11.4 + lift, -2.95);
    if (target.kind === 'spark') { const b = this.spark.buildings.get(target.id); return b ? b.topPoint() : null; }
    if (target.kind === 'runner') { const r = this.spark.runner(target.id); return r ? this.spark.runnerHead(r) : null; }
    if (target.kind === 'foundry') return this.spark.foundryPoint();
    if (target.kind === 'gear') return this.spark.gearPoint(target.id);
    if (target.kind === 'plot') { const c = cellCenter(target.i, target.j); return new THREE.Vector3(c.x, GROUND_Y + 1.4 + lift, c.z); }
    return null;
  }

  /* ---------------- input ---------------- */
  bindInput() {
    const canvas = this.world.renderer.domElement;
    canvas.addEventListener('pointermove', event => {
      this.pointer = { x: event.clientX, y: event.clientY };
      this.hoverDirty = true;
      if (this.down && Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 5) this.dragging = true;
    });
    canvas.addEventListener('pointerleave', () => { this.pointer = null; this.setHover(null); });
    canvas.addEventListener('pointerdown', event => { this.down = { x: event.clientX, y: event.clientY, t: performance.now(), button: event.button }; this.dragging = false; this.closeCluster(); this.stage.focus({ preventScroll: true }); });
    canvas.addEventListener('pointerup', event => {
      const down = this.down; this.down = null;
      const wasDrag = this.dragging; this.dragging = false;
      if (!down || wasDrag || down.button !== 0 || performance.now() - down.t > 600) return;
      this.onClick(this.pick(event.clientX, event.clientY));
    });
    canvas.addEventListener('dblclick', event => {
      clearTimeout(this.plotClickTimer); this.plotClickTimer = 0;   // a double-click on an empty plot walks, it doesn't open the dialog
      const target = this.pick(event.clientX, event.clientY);
      if (target?.kind === 'runner' || target?.kind === 'foundry' || target?.kind === 'gear') return;
      if (target?.kind === 'spark') { this.select({ kind: 'building', id: target.id }); return; }
      if (target && target.kind !== 'owner' && target.kind !== 'plot') { this.select(target); this.focusSelection(); return; }
      const ground = this.world.groundAt(this.world.ndc(event.clientX, event.clientY));
      if (ground) this.npcs.walkOwner(ground.x, ground.z);
    });
    canvas.addEventListener('contextmenu', event => event.preventDefault());
    this.onKeyDown = event => this.keyDown(event);
    this.onKeyUp = event => this.world.keyUp(event.code);
    this.onBlur = () => this.world.clearKeys();
  }
  pick(clientX, clientY) {
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
  /** An unoccupied lot of the top city under the pointer (roads, sidewalks and the HQ plaza excluded). */
  plotAt(clientX, clientY) {
    if (this.world.isUnder) return null;
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
    if (target.kind === 'owner') return { title: this.store.avatar?.name || 'You', sub: 'You · double-click to walk' };
    if (target.kind === 'building') {
      const project = this.store.project(target.id);
      if (!project) return null;
      const floors = this.buildings.get(target.id)?.size.floors || project.metrics.floors;
      return { title: project.name, sub: `${floors} floor${floors === 1 ? '' : 's'} · ${project.primaryLanguage}` };
    }
    if (target.kind === 'hq') return { title: 'CodaClauda HQ', sub: 'Town hall and plaza' };
    if (target.kind === 'plot') {
      if (!target.reservedBy) return { title: 'Empty plot', sub: 'Click to start a project here' };
      const owner = this.store.project(target.reservedBy);
      return { title: 'Reserved plot', sub: `${owner?.name || 'A project'} is hidden from the city · click to show it` };
    }
    if (target.kind === 'spark') {
      const project = this.store.project(target.id);
      if (!project) return null;
      const n = this.spark.sparkJobs(target.id).length;
      return { title: project.name, status: n ? 'active' : 'offline', sub: n ? `DGX Spark · ${plural(n, 'job')} running` : 'DGX Spark · idle', badge: 'Spark' };
    }
    if (target.kind === 'runner') {
      const runner = this.spark.runner(target.id);
      if (!runner?.job) return null;
      const project = runner.anchor !== FOUNDRY ? this.store.project(runner.anchor) : null;
      return { title: jobLabel(runner.job), status: 'active', sub: `DGX Spark · ${project?.name || 'Spark Foundry'}${runner.job.started_at ? ` · started ${timeAgo(runner.job.started_at)}` : ''}` };
    }
    if (target.kind === 'foundry') {
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
      if (!job) return 'This Spark job just finished.';
      const project = runner.anchor !== FOUNDRY ? this.store.project(runner.anchor) : null;
      const memory = Number(job.memory_gb ?? job.reserved_memory_gb);
      return `${jobLabel(job)}${memory > 0 ? ` · ${memory} GB` : ''} — ${job.state || 'running'} on the DGX Spark${project ? ` for ${project.name}` : ''}${job.started_at ? `, started ${timeAgo(job.started_at)}` : ''}.`;
    }
    if (target.kind === 'foundry') {
      const jobs = this.spark.sparkJobs(FOUNDRY);
      return jobs.length ? `Spark jobs not tied to a linked project: ${describeJobs(jobs)}.` : 'The Spark Foundry hosts DGX Spark jobs that are not tied to a linked project. Nothing is running here right now.';
    }
    if (target.kind === 'gear') {
      const jobs = this.spark.gearJobs(target.id);
      return jobs.length ? `Running on this PC: ${describeJobs(jobs)}.` : 'Nothing running on this PC right now.';
    }
    return '';
  }

  keyDown(event) {
    if (!this.visible || this.failed) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const t = event.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector('dialog[open]')) return;
    const code = event.code;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) {
      if (t?.tagName === 'BUTTON' && code.startsWith('Arrow')) return;
      event.preventDefault(); this.world.keyDown(code); return;
    }
    if (code === 'KeyF') { event.preventDefault(); this.focusSelection(); }
    else if (code === 'KeyH') { event.preventDefault(); this.resetCamera(); }
    else if (code === 'Escape') { if (this.cluster) this.closeCluster(true); else if (!this.help.hidden) this.toggleHelp(false); else this.select(null); }
    else if (event.key === '+' || event.key === '=') this.world.zoomBy(0.75);
    else if (event.key === '-' || event.key === '_') this.world.zoomBy(1.33);
  }

  /* ---------------- selection ---------------- */
  onClick(target) {
    if (!target) { this.select(null); return; }
    if (target.kind === 'plot') {
      clearTimeout(this.plotClickTimer);
      this.plotClickTimer = setTimeout(() => { this.plotClickTimer = 0; if (this.visible) this.startProjectOnPlot(target); }, 300);
      return;
    }
    if (target.kind === 'spark') { this.select({ kind: 'building', id: target.id }); return; }
    if (target.kind === 'runner' || target.kind === 'foundry' || target.kind === 'gear') { this.showBubble(target, this.computeText(target)); return; }
    if (target.kind === 'owner') {
      this.npcs.greetOwner(this.world.camera.position);
      this.showBubble(target, 'Hi! Double-click anywhere on the island to walk me there.');
      return;
    }
    this.select(target);
    if (target.kind === 'agent') {
      const agent = this.store.agent(target.id);
      this.npcs.greet(target.id, this.world.camera.position);
      if (agent) this.showBubble(target, this.bubbleText(agent));
    }
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
    if (prev?.kind === 'agent' && !(this.hover?.kind === 'agent' && this.hover.id === prev.id)) this.npcs.setHighlight(prev, false);
    this.selection = target && target.kind !== 'owner' ? target : null;
    this.declutterAt = 0;
    this.buildings.select(this.selection?.kind === 'building' ? this.selection.id : null);
    if (this.selection?.kind === 'agent') this.npcs.setHighlight(this.selection, true);
    if (!this.selection && this.bubbleTarget?.kind === 'agent') { this.bubble.hidden = true; this.bubbleTarget = null; }
    this.panelSig = '';
    this.taskFormFor = null;
    this.taskDraft = null;
    this.refreshPanel();
  }
  focusSelection() {
    const s = this.selection;
    if (!s) { const owner = this.npcs.ownerPosition; if (owner) this.world.flyTo({ target: new THREE.Vector3(owner.x, 1, owner.z), distance: 16, polar: 1.0 }); return; }
    if (s.kind === 'agent') {
      const p = this.npcs.position(s);
      if (p) this.world.flyTo({ target: new THREE.Vector3(p.x, 1, p.z), distance: 15, polar: 1.02 });
    } else if (s.kind === 'building') {
      const b = this.buildings.get(s.id);
      if (b) { const height = b.size.H; this.world.flyTo({ target: new THREE.Vector3(b.origin.x, Math.min(14, height * 0.42), b.origin.z), distance: Math.max(20, height * 1.45 + b.size.W * 2.2), polar: 1.0 }); }
    } else if (s.kind === 'hq') this.world.flyTo({ target: new THREE.Vector3(0, 3, -0.5), distance: 26, polar: 1.0 });
  }
  /** show({ focusProject }) / show({ focusAgent }) once those exist in the scene. */
  tryPendingFocus() {
    const pending = this.pendingFocus;
    if (!pending || !this.visible) return;
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
    if (s.kind === 'agent') {
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
        h('button.btn.small.primary', { type: 'button', onclick: () => this.ctx.navigate('chat', { agentId: agent.id }) }, icon('chat'), 'Chat'),
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
      const text = jobLabel(runner.job), provider = runner.job?.provider || 'other';
      const sig = `${text}|${provider}`;
      if (label.sig === sig) continue;
      label.sig = sig;
      label.w = null;
      label.estW = Math.round(31 + Math.min(String(text).length * 6.4, 210));
      label.node.className = `city-label is-runner provider-${provider}`;
      clear(label.node, h('span.city-gem.spark'), h('span.city-label-name', text));
    }
  }
  /** Machine load card (top right): this PC vs the DGX Spark. */
  renderMachines(m, mode) {
    const cores = Number(navigator.hardwareConcurrency) || 0;
    const local = m.local || {}, spark = m.spark || {};
    const sig = JSON.stringify([mode, this.machinesCollapsed, m.configured, m.enabled, m.error, local, { ...spark, hardware: null }, cores]);
    if (sig === this.machinesSig) return;
    this.machinesSig = sig;
    const card = this.machinesCard;
    card.hidden = mode === 'off';
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
    const summary = m.configured ? `This PC ${local.running || 0} · Spark ${spark.running || 0} running` : 'Spark not connected';
    const head = h('header.city-machines-head', h('span.city-machines-title', icon('city-chip'), 'Machines'), collapsed ? h('span.city-machines-summary', summary) : null, toggle);
    if (collapsed) { clear(card, head); return; }
    if (!m.configured) { clear(card, head, h('a.city-machines-chip', { href: 'classic.html' }, icon('link'), 'Spark not connected — set it up in Classic tools')); return; }
    const row = (label, data, total, extra, cls = '') => {
      const used = Number(data.cpuReserved) || 0, running = Number(data.running) || 0;
      const frac = total ? Math.min(1, used / total) : 0;
      return h(`div.city-machine${cls}`,
        h('div.city-machine-top', h('strong', label), h('span.city-machine-jobs', h(`span.city-gem.${running ? 'active' : 'offline'}`), `${running} running`)),
        h('div.city-meter', { role: 'img', 'aria-label': `${fmtCores(used)} of ${total || 'unknown'} cores reserved` }, h('span.city-meter-fill', { style: { width: `${(frac * 100).toFixed(1)}%` } })),
        h('div.city-machine-meta', h('span', `${fmtCores(used)}/${total || '—'} cores`), h('span', `${fmtHours(Number(data.cpuHours24h) || 0)} CPU-h in 24 h`), extra));
    };
    const healthy = spark.healthy === true;
    const route = h('span.city-machine-route', { title: healthy ? 'Spark scheduler healthy' : 'Spark scheduler not responding' },
      h(`span.city-health.${healthy ? 'ok' : 'bad'}`), prettyRoute(spark.route) || (spark.reachable ? 'Connected' : 'Not reachable'));
    const lh = Number(local.cpuHours24h) || 0, sh = Number(spark.cpuHours24h) || 0, total = lh + sh;
    const localPct = total ? Math.round(lh / total * 100) : 0;
    const split = total > 0
      ? h('div.city-split',
        h('div.city-split-label', `Work split (24 h): This PC ${localPct}% · Spark ${100 - localPct}%`),
        h('div.city-split-bar', { role: 'img', 'aria-label': `This PC ${localPct} percent, Spark ${100 - localPct} percent of CPU-hours in the last 24 hours` },
          h('span.city-split-local', { style: { flexGrow: String(lh) } }), h('span.city-split-spark', { style: { flexGrow: String(sh) } })))
      : h('div.city-split', h('div.city-split-label.muted', 'Work split (24 h): no compute jobs yet'));
    const error = m.error ? h('p.city-machines-error', icon('alert'), h('span', String(m.error).replace(/\s+/g, ' ').slice(0, 140))) : null;
    clear(card, head,
      row('This PC', local, cores, null),
      row('DGX Spark', spark, Number(spark.cpuTotal) || 0, route, '.is-spark'),
      error, split);
  }
  renderHud(projects, agents) {
    const working = agents.filter(a => a.status === 'active').length;
    const sig = JSON.stringify([projects.length, agents.length, working, projects.map(p => [p.id, p.name]), agents.map(a => [a.id, a.name])]);
    if (sig === this.hudSig) return;
    this.hudSig = sig;
    clear(this.stats,
      h('span', h('strong', String(projects.length)), ` building${projects.length === 1 ? '' : 's'}`),
      h('span.city-dot-sep', '·'),
      h('span', h('strong', String(agents.length)), ` agent${agents.length === 1 ? '' : 's'}`),
      working ? [h('span.city-dot-sep', '·'), h('span.city-working', h('span.city-gem.active'), `${working} working`)] : null);
    clear(this.jump,
      h('option', { value: '' }, 'Jump to…'),
      h('option', { value: 'hq' }, 'CodaClauda HQ'),
      projects.length ? h('optgroup', { label: 'Buildings' }, ...[...projects].sort((a, b) => a.name.localeCompare(b.name)).map(p => h('option', { value: `building:${p.id}` }, p.name))) : null,
      agents.length ? h('optgroup', { label: 'Agents' }, ...agents.map(a => h('option', { value: `agent:${a.id}` }, `${a.name} — ${STATUS_LABEL[a.status] || a.status}`))) : null);
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
    const sparkLabel = `Spark underside: ${SPARK_LABEL[this.sparkMode()]} — click to change`;
    this.sparkBtn.title = sparkLabel; this.sparkBtn.setAttribute('aria-label', sparkLabel);
    this.sparkBtn.setAttribute('aria-pressed', String(Boolean(this.world.underside)));
    this.flipBtn.hidden = !this.world.underside;
    this.renderFlip(true);
    this.renderTimeChip();
  }
  /** "Spark side" / "Laptop side" follows where the camera actually is. */
  renderFlip(force = false) {
    const under = this.world.isUnder;
    if (!force && under === this.flipUnder) return;
    this.flipUnder = under;
    this.flipLabel.textContent = under ? 'Laptop side' : 'Spark side';
    const label = under ? 'Fly back up to this PC (the top city)' : 'Fly under the island to the DGX Spark city';
    this.flipBtn.title = label; this.flipBtn.setAttribute('aria-label', label);
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
    this.following = force ?? !this.following;
    this.world.follow = this.following ? () => this.npcs.ownerPosition : null;
    if (this.following && this.reduced()) { const p = this.npcs.ownerPosition; if (p) this.world.flyTo({ target: new THREE.Vector3(p.x, 1, p.z), distance: 22 }, { instant: true }); }
    else if (this.following) { const p = this.npcs.ownerPosition; if (p) this.world.flyTo({ target: new THREE.Vector3(p.x, 1, p.z), distance: Math.min(this.world.distance, 34) }); }
    this.renderToolbarState();
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
    if (this.following) this.toggleFollow(false);
    this.world.resetView({ auto: true });
    this.world.userMoved = false;
  }
  cycleSpark() {
    const next = SPARK_MODES[(SPARK_MODES.indexOf(this.sparkMode()) + 1) % SPARK_MODES.length];
    this.store.setPref('citySpark', next);
    toast(`Spark underside: ${SPARK_LABEL[next]}`, { timeout: 2200 });
  }
  flipSide() {
    if (!this.world?.underside) return;
    if (this.following) this.toggleFollow(false);
    const azimuth = this.world.azimuth;
    if (this.world.isUnder) this.world.flyTo({ ...this.world.defaultView(), azimuth }, { duration: 1.4 });
    else this.world.flyTo(this.spark.view(azimuth), { duration: 1.4 });
    this.stage.focus({ preventScroll: true });
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
    this.world.flyTo({ target: new THREE.Vector3(c.x, 2, c.z), distance: 36, polar: 0.95 });
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
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.sync();
    this.world.resize();
    this.world.start();
    // Deep link #city?side=spark flies under the island once the Spark city is shown.
    if (params.side === 'spark') {
      const tryFlip = (attempt = 0) => { if (this.world.underside && !this.world.isUnder) this.flipSide(); else if (!this.world.underside && attempt < 40) setTimeout(() => tryFlip(attempt + 1), 250); };
      tryFlip();
    }
  }
  destroy() {
    this.hide();
    for (const label of this.runnerLabels.values()) label.node.remove();
    this.runnerLabels.clear();
    this.spark?.dispose(); this.npcs?.dispose(); this.buildings?.dispose(); this.world?.dispose();
    this.root.replaceChildren();
  }
  hide() {
    this.visible = false;
    if (this.failed || !this.world) return;
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
