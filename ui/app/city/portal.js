/* Contributor islands in the City: the Islands toolbar button, the route map (routemap.js), the
 * portal transition and the "current island". Home is the existing city. On a contributor island
 * the City view's store is swapped for a thin view of the real one whose projects come from that
 * owner's repos (lots from their own SlotMap) and whose agents are only those working on one of
 * them, so the World / building / people pipeline runs unchanged. There is no Spark side there.
 * Building and town-hall cards show repo info with Open on GitHub. */
import { h, icon, iconButton, registerIcons, toast, timeAgo, fullTime, pill, plural, portrait, formatBytes, formatNumber, clear, STATUS_LABEL } from '../ui.js';
import { languageColor } from '../store.js';
import { IslandRoutes, POLL_MS, QUIET_FIRST } from '../islands.js';
import { RouteMap } from './routemap.js';
import { SlotMap } from './layout.js';
import { HQ } from './scenery.js';

registerIcons({ route: '<circle cx="5.5" cy="18" r="2.3"/><circle cx="18.5" cy="6" r="2.3"/><path d="M7.4 16.4C9.5 9.5 13.5 14.5 16.6 7.7" stroke-dasharray="2.4 2.4"/>' });

const NO_MACHINES = Object.freeze({ enabled: false, configured: false, online: false, offlineSince: null, error: '', jobs: [] });
const ACCESS_NOTE = { Admin: 'Admin: full control', Maintain: 'Maintain: manage without admin', Write: 'Write: push to branches', Triage: 'Triage: issues and pull requests', Read: 'Read: view and clone' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const noAccess = () => Promise.reject(new Error('Access levels are set on home projects, not contributor islands.'));

/** The real store, seen from an island (functions stay bound to the real store). Owned-account
 * islands hold your own projects, so their access levels stay editable. */
function islandStore(store, mode) {
  const own = {
    get projects() { return mode.projects(); },
    visibleProjects: () => mode.projects(),
    project: id => mode.projects().find(p => p.id === id) || null,
    get agents() { return mode.agents(); },
    agent: id => mode.agents().find(a => a.id === id) || null,
    cityLots: {},
    setCityLot: undefined,   // island layouts are hashed per island, never pinned into the home city's lots
    // Access levels belong to home projects: an island repo never writes one (or a home clone's).
    get setProjectAccess() { return mode.owned() ? store.setProjectAccess.bind(store) : noAccess; },
    get setProjectAccessMany() { return mode.owned() ? store.setProjectAccessMany.bind(store) : noAccess; },
    get machines() { return NO_MACHINES; },
  };
  return new Proxy(store, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(own, prop)) return own[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export class IslandMode {
  constructor(view) {
    this.view = view;
    this.home = view.store;
    this.current = null;            // island id, or null at home
    this.slotMaps = new Map();
    this.routes = new IslandRoutes({ store: this.home, fetch: () => view.ctx.bridge.desktop.githubCollabRepos(), colorOf: languageColor, onChange: () => this.changed() });
    this.map = new RouteMap({ onPick: id => this.portal(id), onClose: restore => this.mapClosed(restore), onRefresh: () => this.poll(true) });
    this.badge = h('span.city-islands-badge', { hidden: true });
    this.button = h('button.city-islands-btn', { type: 'button', onclick: () => this.openMap() }, icon('route'), h('span', 'Islands'), this.badge);
    view.toolbar.insertBefore(this.button, view.flipBtn);
    this.eyebrow = view.hud.querySelector('.eyebrow');
    this.chip = h('div.city-island-chip', { hidden: true });
    view.hud.append(this.chip);
    this.fxText = h('div.city-portal-text');
    this.fx = h('div.city-portal', { hidden: true, 'aria-hidden': 'true' }, h('div.city-portal-swirl'), h('div.city-portal-flash'), this.fxText);
    view.cityRoot.append(this.map.node, this.fx);
    this.timer = setInterval(() => this.poll(true), POLL_MS);
    this.renderButton();
  }
  /** The map or a portal owns the keyboard and wheel. */
  get blocking() { return this.map.open || Boolean(this.busy); }
  /** True on an island of one of your own GitHub accounts (beside home, same level). */
  owned(id = this.current) { return Boolean(id) && String(id).startsWith('owned:'); }
  /** Your other GitHub accounts shown as their own islands: [{ id: 'owned:<login>', owner, owned: true, repos }]. */
  ownedIslands() {
    return (this.home.accountLayout === 'islands' ? this.home.githubAccounts || [] : []).filter(a => !a.main)
      .map(a => ({ id: `owned:${String(a.user).toLowerCase()}`, owner: a.user, ownerType: 'Owned', owned: true, repos: a.repos || [] }));
  }
  island(id = this.current) {
    if (!id) return null;
    return this.owned(id) ? this.ownedIslands().find(i => i.id === id) || null : this.routes.island(id);
  }
  projects() {
    if (!this.current) return [];
    return this.owned() ? this.home.islandProjects(this.current) : this.routes.projects(this.current);
  }
  /** Agents whose current project is one of this island's repos, re-pointed at its buildings. */
  agents() {
    const real = this.home.agents, projects = this.projects();
    const c = this.agentCache;
    if (c && c.real === real && c.projects === projects) return c.list;
    const byId = new Map(projects.map(p => [p.id, p]));
    const match = id => { const p = id && this.home.project(id); return p ? p.ids.map(x => byId.get(x)).find(Boolean) || null : null; };
    const list = [];
    for (const agent of real) {
      const here = match(agent.currentProjectId);
      if (here) list.push({ ...agent, currentProjectId: here.id, homeProjectId: (match(agent.homeProjectId) || here).id, visiting: false });
    }
    this.agentCache = { real, projects, list };
    return list;
  }

  /* ---------- polling ---------- */
  async poll(force = false) {
    await this.routes.ready();
    if (force) this.loading = true;
    if (this.map.open) this.renderMap();
    const diff = await this.routes.refresh({ force });
    this.loading = false;
    if (this.map.open) this.renderMap();
    // New routes open the map once; a first-ever check with many routes, or a cut-short list (an old
    // repo pushed into the top 500 looks new), only badges the button.
    if (diff?.added.length && !this.routes.truncated && (!diff.firstEver || diff.added.length <= QUIET_FIRST)) this.autoOpen();
  }
  autoOpen() {
    const v = this.view;
    const typing = document.activeElement?.matches?.('input, textarea, select, [contenteditable="true"]');
    if (v.visible && !this.blocking && !v.talk && !v.street && !v.streetPending && !typing) this.openMap();
    else this.pendingOpen = true;
  }
  changed() {
    this.agentCache = null;
    const v = this.view;
    v.dirty = true;
    this.renderButton();
    if (this.current && !this.island()) {   // gone from the list: back home (a cut-short list keeps what it lacks, so only past 500)
      const stillLinked = this.owned() && (this.home.githubAccounts || []).some(a => `owned:${String(a.user).toLowerCase()}` === this.current);
      toast(this.owned() ? (stillLinked ? 'Your accounts are one big city now, so you are back home.' : 'That account was removed from CodaClauda, so you are back home.')
        : this.routes.truncated ? 'GitHub returned a partial list (500 repos at most) without that contributor island, so you are back home.'
          : 'That contributor island is gone: you no longer have access to its repos.', { kind: 'info' });
      this.apply(null);
    } else if (this.current) this.renderChip();
  }

  /* ---------- route map ---------- */
  openMap() {
    if (this.busy || !this.view.world) return;
    this.pendingOpen = false;
    const v = this.view;
    if (v.talk) v.exitTalk({ instant: true });
    if (v.street || v.streetPending) v.exitStreet();
    v.closeCluster(); v.closeAccess?.(); v.setHover(null);
    this.map.show(this.mapData());
    if (!this.routes.checked && !this.routes.pending) this.poll();
  }
  mapData() {
    const r = this.routes;
    return { islands: r.islands, owned: this.ownedIslands().map(i => ({ ...i, count: this.home.islandProjects(i.id).length })), fresh: r.fresh, current: this.current, homeCount: this.home.visibleProjects('city').length, checked: r.checked, loading: Boolean(this.loading || r.pending), error: r.error, truncated: r.truncated, checkedAt: r.at };
  }
  renderMap() { if (this.map.open) this.map.render(this.mapData()); }
  mapClosed(restore) {
    this.routes.markSeen();
    this.renderButton();
    if (!this.busy) (restore?.isConnected && this.view.cityRoot.contains(restore) ? restore : this.button).focus({ preventScroll: true });
  }
  renderButton() {
    const fresh = this.routes.fresh, n = this.routes.islands.filter(i => i.repos.some(r => fresh.has(r.full_name.toLowerCase()))).length;
    this.badge.hidden = !n;
    this.badge.textContent = String(n);
    const label = `Contributor islands: route map${n ? ` (${plural(n, 'island')} with new routes)` : ''}`;
    this.button.title = label; this.button.setAttribute('aria-label', label);
    this.button.classList.toggle('has-new', Boolean(n));
  }

  /* ---------- portal ---------- */
  /** Map pick / Home: close the map, play the portal and rebuild the city for that island. */
  async portal(id) {
    const target = id ? this.island(id) : null;
    if ((id && !target) || this.busy) return;
    if ((target?.id || null) === this.current) { this.map.close(); return; }
    const v = this.view, world = v.world, reduced = v.reduced();
    this.busy = true;
    this.map.close();
    if (v.talk) v.exitTalk({ instant: true });
    if (v.street || v.streetPending) v.exitStreet({ fly: false, instant: true });
    if (v.following) v.toggleFollow(false);
    v.closeCluster(); v.closeAccess?.(); v.setHover(null); v.select(null);
    // Your own accounts' islands sit beside home on the same level: glide across. Contributor
    // islands lie below: the portal dives.
    const across = this.owned(target?.id) || (!target && this.owned());
    this.fxText.textContent = target ? (across ? `Crossing to @${target.owner}'s island…` : `Flying to ${target.owner} island…`) : across ? 'Crossing home…' : 'Flying home…';
    this.fx.className = `city-portal ${reduced || across ? 'is-plain' : 'is-swirl'} is-in`;
    this.fx.hidden = false;
    if (!reduced) {
      const base = world.baseTarget();
      if (across) { const side = base.clone(); side.x += (target ? 1 : -1) * Math.max(30, world.distance * 0.6); world.flyTo({ target: side, distance: world.distance }, { duration: 0.55, auto: true }); }
      else world.flyTo({ target: base, distance: Math.max(6, world.distance * 0.28) }, { duration: 0.55, auto: true });
    }
    try {
      await wait(reduced ? 220 : 560);
      this.apply(target);
      await wait(reduced ? 40 : 260);
      this.fx.classList.replace('is-in', 'is-out');
      await wait(reduced ? 280 : 680);
    } finally {
      this.fx.hidden = true;
      this.busy = false;
      v.stage.focus({ preventScroll: true });
    }
  }
  /** Rebuild the City for an island (or home): store view, lots, Spark UI, your avatar, the camera. */
  apply(island) {
    const v = this.view, world = v.world;
    this.current = island?.id || null;
    this.agentCache = null;
    this.homeSlots ||= v.slots;
    v.slots = island ? this.slotsFor(island.id) : this.homeSlots;
    v.store = island ? (this.islandView ||= islandStore(this.home, this)) : this.home;
    v.extraCache = null; v.agentLocations = null;
    v.npcs?.settle();   // no plane is mid-air across a view switch: everyone starts at their goal there
    v.cityRoot.classList.toggle('is-island', Boolean(island));
    v.select(null);
    v.hudSig = ''; v.panelSig = ''; v.emptySig = ''; v.machinesSig = '';
    v.sync();
    for (const b of v.buildings.removing) b.dispose();      // the city you left is gone at once (no sinking towers on arrival)
    v.buildings.removing.clear();
    v.npcs.driveOwner(HQ.owner.x, HQ.owner.z, 0, false);   // you arrive on the plaza
    world.userMoved = false;
    const home = world.defaultView();
    if (!v.reduced()) world.flyTo({ ...home, distance: home.distance * 0.45 }, { instant: true, auto: true });
    world.resetView({ auto: true, duration: 1.3, instant: v.reduced() });
    this.renderChip();
    this.renderButton();
  }
  slotsFor(id) {
    if (!this.slotMaps.has(id)) { const slots = new SlotMap(); slots.legacy = {}; this.slotMaps.set(id, slots); }
    return this.slotMaps.get(id);
  }
  renderChip() {
    const island = this.island();
    this.chip.hidden = !island;
    if (this.eyebrow) this.eyebrow.textContent = !island ? 'Project city' : island.owned ? 'Your island' : 'Contributor island';
    if (!island) { this.chip.replaceChildren(); return; }
    clear(this.chip,
      h('span.city-island-name', icon(island.owned ? 'github' : 'route'), h('strong', island.owned ? `@${island.owner}` : `${island.owner} island`), h('span.muted', island.owned ? `${plural(this.projects().length, 'building')} · beside home` : plural(island.repos.length, 'repo'))),
      h('button.btn.small.city-island-home', { type: 'button', title: 'Portal back to your home city', onclick: () => this.portal(null) }, icon('home'), 'Home'));
  }

  /* ---------- City hooks ---------- */
  /** HUD tag for the town hall on a contributor island. */
  hqInfo() { const island = this.island(); return island ? { title: island.owned ? `@${island.owner}` : `${island.owner} island`, sub: `Town hall · ${plural(island.owned ? this.projects().length : island.repos.length, island.owned ? 'building' : 'repo')} · click for the list` } : null; }
  /** Side cards on a contributor island: { sig, render } for a building or the town hall, else null. */
  panelFor(target) {
    const island = this.island();
    if (!island || !target) return null;
    if (target.kind === 'hq') return { sig: JSON.stringify(['island', island.id, island.repos.map(r => r.full_name), Math.floor(Date.now() / 60000)]), render: () => this.renderIslandPanel(island) };
    if (target.kind !== 'building' || island.owned) return null;   // your own buildings use the home panel
    const project = this.projects().find(p => p.id === target.id);
    if (!project) return null;
    const here = this.view.agentsAt(project.id).map(a => [a.id, a.status, a.look]);
    return { sig: JSON.stringify(['repo', project.id, project.metrics, project.collab, here, Math.floor(Date.now() / 60000)]), render: () => this.renderRepoPanel(project) };
  }
  renderRepoPanel(project) {
    const v = this.view, c = project.collab, m = project.metrics, building = v.buildings.get(project.id);
    const floors = building?.size.floors || m.floors;
    const stat = (label, value, hint) => h('div.city-stat', h('div.city-stat-value', value), h('div.city-stat-label', label), hint ? h('div.city-stat-hint', hint) : null);
    const here = v.agentsAt(project.id);
    clear(v.panel,
      v.panelHead(h('span.city-swatch', { style: { '--swatch': project.color } }, icon('github')), project.name, `${c.fullName} · ${floors} floor${floors === 1 ? '' : 's'}`,
        iconButton('crosshair', 'Center view (F)', () => v.focusSelection())),
      h('div.city-panel-pills', pill(c.access, c.access === 'Read' ? 'neutral' : 'accent'), pill(project.private ? 'Private' : 'Public', project.private ? 'warning' : 'neutral'),
        c.archived ? pill('Archived', 'neutral') : null, c.fork ? pill('Fork', 'neutral') : null, c.fresh ? pill('New route', 'success') : null),
      h('div.city-stats',
        stat('Size', m.sizeBytes ? formatBytes(m.sizeBytes) : '—', 'on GitHub, with history'),
        stat('Stars', formatNumber(c.stars)),
        stat('Last push', m.lastActivityAt ? timeAgo(m.lastActivityAt) : '—', m.lastActivityAt ? fullTime(m.lastActivityAt) : null),
        stat('Language', project.primaryLanguage)),
      h('dl.city-facts',
        h('dt', 'Owner'), h('dd', c.owner),
        h('dt', 'Your access'), h('dd', ACCESS_NOTE[c.access] || c.access),
        h('dt', 'Default branch'), h('dd', c.branch || h('span.muted', 'Unknown'))),
      here.length ? h('section.city-panel-section', h('div.city-section-label', 'Agents here'),
        h('div.city-people', ...here.map(a => h('button.city-person', { type: 'button', title: `${a.name} · ${STATUS_LABEL[a.status] || a.status}`, onclick: () => { v.select({ kind: 'agent', id: a.id }); v.focusSelection(); } },
          portrait(a.look, { size: 34, provider: a.provider, status: a.status }), h('span', a.name))))) : null,
      h('div.city-actions.wrap',
        h('button.btn.small.primary', { type: 'button', onclick: () => v.open(project.url) }, icon('github'), 'Open on GitHub'),
        h('button.btn.small', { type: 'button', onclick: () => this.openMap() }, icon('route'), 'Route map'),
        h('button.btn.small', { type: 'button', onclick: () => this.portal(null) }, icon('home'), 'Back home')),
      h('p.city-note', 'A contributor island: each building is a GitHub repo someone added you to (or one of your organizations). Heights are estimated from repo size and recent pushes.'));
  }
  renderIslandPanel(island) {
    const v = this.view;
    if (island.owned) {
      clear(v.panel,
        v.panelHead(h('span.city-swatch.hq', icon('github')), `@${island.owner}`, `Your account · ${plural(this.projects().length, 'building')} · beside your main city`),
        h('p.city-desc', `Repos of @${island.owner}. Cloned ones are buildings; the rest are lots with a Clone to build sign. To fold this account into your main city, open Projects, GitHub accounts.`),
        h('div.city-island-repos', ...this.projects().map(p => h('button.city-link', { type: 'button', title: p.repo?.full_name || p.name, onclick: () => { v.select({ kind: 'building', id: p.id }); v.focusSelection(); } },
          h('span.city-lang-dot', { style: { background: p.color } }), p.name))),
        h('div.city-actions.wrap',
          h('button.btn.small.primary', { type: 'button', onclick: () => v.open(`https://github.com/${island.owner}`) }, icon('github'), 'Account on GitHub'),
          h('button.btn.small', { type: 'button', onclick: () => this.openMap() }, icon('route'), 'Island map'),
          h('button.btn.small', { type: 'button', onclick: () => this.portal(null) }, icon('home'), 'Back home')));
      return;
    }
    clear(v.panel,
      v.panelHead(h('span.city-swatch.hq', icon('route')), `${island.owner} island`, `${island.ownerType === 'Organization' ? 'Organization' : 'Personal account'} · ${plural(island.repos.length, 'repo')}`),
      h('p.city-desc', `Repos ${island.owner} shares with you. Agents show up here while they work on one of them.`),
      h('div.city-island-repos', ...this.projects().map(p => h('button.city-link', { type: 'button', title: p.collab.fullName, onclick: () => { v.select({ kind: 'building', id: p.id }); v.focusSelection(); } },
        h('span.city-lang-dot', { style: { background: p.color } }), p.name, p.collab.fresh ? h('span.city-routes-new', 'new') : null))),
      h('div.city-actions.wrap',
        h('button.btn.small.primary', { type: 'button', onclick: () => v.open(`https://github.com/${island.owner}`) }, icon('github'), 'Owner on GitHub'),
        h('button.btn.small', { type: 'button', onclick: () => this.openMap() }, icon('route'), 'Route map'),
        h('button.btn.small', { type: 'button', onclick: () => this.portal(null) }, icon('home'), 'Back home')));
  }

  /** City show({ focusProject | focusAgent | side }) is about the home city: go home first. */
  show(params = {}) {
    if (this.current && (params.focusProject || params.focusAgent || params.side)) this.apply(null);
    this.poll();
    if (this.pendingOpen) { this.pendingOpen = false; setTimeout(() => { if (this.view.visible) this.autoOpen(); }, 700); }
  }
  hide() { this.map.close(); }
  dispose() { clearInterval(this.timer); this.map.close(); }
}
