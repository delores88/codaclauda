/* Contributor islands route map: an airline-style map over the City. A stylised ocean, your home
 * city in the middle and one island per GitHub owner whose repos you can contribute to, joined to
 * home by thin curved flight arcs. New routes pulse. Hover / focus an island to see its repos;
 * click it (or Enter) to portal there. Esc or ✕ closes. SVG is built with createElementNS and all
 * names go in as text nodes (owner and repo names come from GitHub). */
import { h, icon, iconButton, clear, plural, timeAgo } from '../ui.js';
import { hash } from '../avatar/spec.js';
import { layoutIslands, repoKey, accessLabel } from '../islands.js';

const SVG = 'http://www.w3.org/2000/svg';
const W = 1000, H = 600;
const CARD_REPOS = 7;
const EMPTY_TEXT = 'No contributor islands yet. When someone adds you to a GitHub repo, a new route appears here.';
const fx = n => n.toFixed(1);

function s(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) if (value != null && value !== false) node.setAttribute(key, String(value));
  node.append(...children.flat().filter(c => c != null && c !== false));
  return node;
}
/** A soft, irregular island outline around (x, y) (seeded, so an island keeps its shape). */
export function blobPath(x, y, r, seed) {
  const n = 9, pts = [], turn = (seed % 100) / 100;
  for (let k = 0; k < n; k++) {
    const a = (k / n + turn / n) * Math.PI * 2, rr = r * (0.8 + ((seed >>> (k * 3)) & 7) / 7 * 0.34);
    pts.push([x + Math.cos(a) * rr * 1.2, y + Math.sin(a) * rr * 0.86]);
  }
  const mid = (a, b) => `${fx((a[0] + b[0]) / 2)} ${fx((a[1] + b[1]) / 2)}`;
  let d = `M${mid(pts[n - 1], pts[0])}`;
  for (let k = 0; k < n; k++) d += ` Q${fx(pts[k][0])} ${fx(pts[k][1])} ${mid(pts[k], pts[(k + 1) % n])}`;
  return `${d}Z`;
}
/** A flight arc from home's shore to the island's, bowing upward like a great circle on a flat map. */
function arcPath(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
  let nx = -uy, ny = ux;
  if (ny > 0) { nx = -nx; ny = -ny; }
  const sx = a.x + ux * a.r * 0.95, sy = a.y + uy * a.r * 0.7, ex = b.x - ux * b.r * 1.05, ey = b.y - uy * b.r * 0.8;
  const bow = len * 0.2;
  return `M${fx(sx)} ${fx(sy)} Q${fx((sx + ex) / 2 + nx * bow)} ${fx((sy + ey) / 2 + ny * bow)} ${fx(ex)} ${fx(ey)}`;
}

export class RouteMap {
  /** onPick(islandId | null for home), onClose(), onRefresh() */
  constructor({ onPick, onClose, onRefresh }) {
    Object.assign(this, { onPick, onClose, onRefresh });
    this.open = false;
    this.svg = s('svg', { class: 'city-routes-svg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', role: 'group', 'aria-label': 'Route map' });
    this.card = h('div.city-routes-card', { hidden: true, 'aria-hidden': 'true' });
    this.note = h('div.city-routes-note', { hidden: true, role: 'status' });
    this.mapBox = h('div.city-routes-map', this.svg, this.card, this.note);
    this.list = h('ul.city-routes-list', { 'aria-label': 'Islands' });
    this.side = h('aside.city-routes-side', h('div.city-routes-side-label', 'Islands'), this.list);
    this.foot = h('div.city-routes-foot');
    this.panel = h('div.city-routes-panel.card', { tabindex: '-1' },
      h('header.city-routes-head',
        h('span.city-routes-logo', icon('route')),
        h('div.city-routes-titles', h('h2#city-routes-title', 'Contributor islands'), h('p', 'Routes from your home city to GitHub repos other people added you to. Pick an island to fly there.')),
        iconButton('close', 'Close the route map (Esc)', () => this.close(), 'city-routes-close')),
      h('div.city-routes-body', this.mapBox, this.side),
      this.foot);
    this.node = h('div.city-routes', { hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'city-routes-title', onpointerdown: event => { if (event.target === this.node) this.close(); } }, this.panel);
    this.onKey = event => this.key(event);
  }

  show(data) {
    this.restore = document.activeElement;
    this.open = true;
    this.node.hidden = false;
    this.render(data);
    document.addEventListener('keydown', this.onKey, true);
    requestAnimationFrame(() => this.panel.focus({ preventScroll: true }));   // the dialog itself: Tab goes on to the islands
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.node.hidden = true;
    this.card.hidden = true;
    document.removeEventListener('keydown', this.onKey, true);
    this.onClose?.(this.restore);
  }
  /** Modal keys: Esc closes, Tab stays inside, nothing reaches the City's own shortcuts. */
  key(event) {
    if (!this.open) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); return; }
    if (event.key !== 'Tab') return;
    const items = [...this.panel.querySelectorAll('button:not([disabled]), [tabindex="0"]')].filter(n => n.getClientRects().length);
    if (!items.length) return;
    const first = items[0], last = items.at(-1), at = document.activeElement;
    if (!this.panel.contains(at) || (event.shiftKey && at === first) || (!event.shiftKey && at === last)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
  }

  /** data: { islands, fresh: Set<repo key>, current, homeCount, checked, loading, error, truncated, checkedAt } */
  render(data = this.data) {
    if (!data) return;
    this.data = data;
    // A re-render (a check finished) keeps keyboard focus on the same island, list row or button.
    const at = this.node.contains(document.activeElement) ? document.activeElement : null, id = at?.dataset?.id;
    const refocus = !at ? null : at.closest('.city-routes-foot') ? '.city-routes-foot .btn'
      : id && at.matches('.city-routes-item') ? `.city-routes-item[data-id="${CSS.escape(id)}"]`
        : id && at.matches('.city-routes-island, .city-routes-home') ? `.city-routes-island[data-id="${CSS.escape(id)}"], .city-routes-home[data-id="${CSS.escape(id)}"]` : null;
    const { islands, fresh, current } = data;
    const freshOf = island => island.repos.filter(r => fresh.has(repoKey(r))).length;
    const { home, spots } = layoutIslands(islands);
    this.spots = spots; this.home = home;
    // Ocean, graticule, a few wave marks.
    const sea = s('defs', {}, s('radialGradient', { id: 'city-routes-sea', cx: '50%', cy: '46%', r: '72%' }, s('stop', { offset: '0%', class: 'sea-a' }), s('stop', { offset: '100%', class: 'sea-b' })));
    const grid = s('g', { class: 'city-routes-grid' });
    for (let x = 100; x < W; x += 100) grid.append(s('line', { x1: x, y1: 0, x2: x, y2: H }));
    for (let y = 100; y < H; y += 100) grid.append(s('line', { x1: 0, y1: y, x2: W, y2: y }));
    const waves = s('g', { class: 'city-routes-waves' });
    for (let k = 0; k < 16; k++) {
      const seed = hash(`wave${k}`), x = 40 + seed % 920, y = 30 + (seed >>> 10) % 540;
      waves.append(s('path', { d: `M${x} ${y} q6 -5 12 0 t12 0` }));
    }
    const compass = s('g', { class: 'city-routes-compass', transform: `translate(${W - 52} ${H - 52})` }, s('circle', { r: 22 }), s('path', { d: 'M0 -17 L5 0 L0 17 L-5 0Z' }), s('text', { y: -25, 'text-anchor': 'middle' }, 'N'));
    const arcs = s('g', { class: 'city-routes-arcs' }), lands = s('g'), labels = s('g', { class: 'city-routes-labels' });
    // Home: your city. Clickable only from a contributor island (portal back).
    const away = Boolean(current);
    const homeG = s('g', { class: `city-routes-home${away ? ' is-link' : ' is-here'}`, tabindex: away ? '0' : null, role: away ? 'button' : null, 'aria-label': away ? 'Home city. Fly home.' : 'Home city, you are here', 'data-id': 'home' },
      s('path', { d: blobPath(home.x, home.y, home.r, hash('home')), class: 'city-routes-land' }),
      s('path', { d: blobPath(home.x, home.y + 2, home.r * 0.55, hash('home-hill')), class: 'city-routes-hill' }),
      s('g', { class: 'city-routes-skyline' }, ...[[-22, 13], [-11, 24], [1, 18], [12, 10]].map(([dx, hh]) => s('rect', { x: home.x + dx, y: home.y - hh + 6, width: 10, height: hh, rx: 1.5 }))));
    this.bindTarget(homeG, 'home');
    lands.append(homeG);
    labels.append(s('g', { class: 'city-routes-label is-home' },
      s('text', { x: home.x, y: home.y + home.r + 20, class: 'owner', 'text-anchor': 'middle' }, 'Home'),
      s('text', { x: home.x, y: home.y + home.r + 39, class: 'count', 'text-anchor': 'middle' }, away ? plural(data.homeCount, 'building') : 'You are here')));
    for (const island of islands) {
      const spot = spots.get(island.id);
      if (!spot) continue;
      const n = freshOf(island), here = current === island.id, cls = `${n ? ' is-new' : ''}${here ? ' is-here' : ''}`;
      arcs.append(s('path', { d: arcPath(home, spot), class: `city-routes-arc${cls}`, 'data-id': island.id }));
      const g = s('g', { class: `city-routes-island ${island.ownerType === 'Organization' ? 'is-org' : 'is-user'}${cls}`, tabindex: '0', role: 'button', 'data-id': island.id,
        'aria-label': `${island.owner} island, ${plural(island.repos.length, 'repo')}${n ? `, ${n} new` : ''}${here ? ', you are here' : ''}. Fly there.` },
      n ? s('circle', { cx: fx(spot.x), cy: fx(spot.y), r: fx(spot.r + 10), class: 'city-routes-pulse' }) : null,
      s('path', { d: blobPath(spot.x, spot.y, spot.r, spot.seed), class: 'city-routes-land' }),
      s('path', { d: blobPath(spot.x, spot.y + 1, spot.r * 0.5, spot.seed >>> 5), class: 'city-routes-hill' }),
      s('circle', { cx: fx(spot.x), cy: fx(spot.y), r: 6, class: 'city-routes-dot' }));
      this.bindTarget(g, island.id);
      lands.append(g);
      const label = s('g', { class: `city-routes-label${cls}`, 'data-id': island.id },
        s('text', { x: fx(spot.x), y: fx(spot.y + spot.r + 20), class: 'owner', 'text-anchor': 'middle' }, island.owner),
        s('text', { x: fx(spot.x), y: fx(spot.y + spot.r + 39), class: 'count', 'text-anchor': 'middle' }, here ? `You are here · ${plural(island.repos.length, 'repo')}` : plural(island.repos.length, 'repo')));
      if (n) {
        const text = n > 1 ? `${n} NEW` : 'NEW', bw = 18 + text.length * 9;
        label.append(s('g', { class: 'city-routes-badge' }, s('rect', { x: fx(spot.x - bw / 2), y: fx(spot.y - spot.r - 32), width: bw, height: 22, rx: 11 }), s('text', { x: fx(spot.x), y: fx(spot.y - spot.r - 16.5), 'text-anchor': 'middle' }, text)));
      }
      labels.append(label);
    }
    this.svg.replaceChildren(sea, s('rect', { x: 0, y: 0, width: W, height: H, class: 'city-routes-sea', fill: 'url(#city-routes-sea)' }), grid, waves, compass, arcs, lands, labels);
    this.renderList(islands, freshOf, current);
    this.renderNote(data);
    this.renderFoot(data, islands.length - spots.size);
    if (this.hot) this.hover(this.hot);
    if (refocus) this.node.querySelector(refocus)?.focus({ preventScroll: true });
  }
  renderList(islands, freshOf, current) {
    const order = [...islands].sort((a, b) => (freshOf(b) > 0) - (freshOf(a) > 0));
    const item = (id, art, name, count, extra, cls) => h('li', h(`button.city-routes-item${cls}`, { type: 'button', dataset: { id },
      onclick: () => this.pick(id), onpointerenter: () => this.hover(id), onpointerleave: () => this.hover(null), onfocus: () => this.hover(id), onblur: () => this.hover(null) },
    h('span.city-routes-item-art', icon(art)), h('span.city-routes-item-name', name), h('span.city-routes-item-count', count), extra));
    clear(this.list,
      current ? item('home', 'home', 'Home city', 'Fly home', null, '.is-home') : null,
      ...order.map(island => {
        const n = freshOf(island), here = island.id === current;
        return item(island.id, island.ownerType === 'Organization' ? 'agents' : 'avatar', island.owner, plural(island.repos.length, 'repo'),
          [n ? h('span.city-routes-new', n > 1 ? `${n} new` : 'new') : null, here ? h('span.city-routes-here', 'Here') : null], `${n ? '.is-new' : ''}${here ? '.is-here' : ''}`);
      }));
    this.side.hidden = !islands.length;
  }
  renderNote(data) {
    const text = data.islands.length ? '' : !data.checked && !data.error ? 'Looking for contributor islands on GitHub…' : EMPTY_TEXT;
    this.note.hidden = !text;
    if (!text) return;
    clear(this.note, h('strong', text), data.error && !data.islands.length ? h('span', `GitHub could not be checked: ${String(data.error).slice(0, 220)}`) : null);
  }
  renderFoot(data, offMap) {
    clear(this.foot,
      h('span.city-routes-legend', h('i.city-routes-key'), 'Route', h('i.city-routes-key.is-new'), 'New route'),
      offMap > 0 ? h('span', `${plural(offMap, 'more island')} in the list`) : null,
      data.truncated ? h('span', `Partial list from GitHub: showing ${plural(data.islands.reduce((n, i) => n + i.repos.length, 0), 'repo')}, some may be missing`) : null,
      data.error && data.islands.length ? h('span.city-routes-error', icon('alert'), `Last check failed: ${String(data.error).slice(0, 160)}`) : null,
      h('span.city-routes-spacer'),
      data.checkedAt ? h('span.muted', `Checked ${timeAgo(data.checkedAt)}`) : null,
      h('button.btn.small.ghost', { type: 'button', 'aria-disabled': data.loading ? 'true' : null, onclick: () => { if (!this.data?.loading) this.onRefresh?.(); } }, icon('refresh'), data.loading ? 'Checking…' : 'Check now'));   // stays focusable while checking
  }
  bindTarget(node, id) {
    node.addEventListener('pointerenter', () => this.hover(id));
    node.addEventListener('pointerleave', () => this.hover(null));
    node.addEventListener('focus', () => this.hover(id));
    node.addEventListener('blur', () => this.hover(null));
    node.addEventListener('click', () => this.pick(id));
    node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.pick(id); } });
  }
  pick(id) {
    if (id === 'home' && !this.data?.current) { this.close(); return; }   // already home
    this.onPick?.(id === 'home' ? null : id);
  }
  /** Highlight an island or 'home' (map, arc, label, list); an island also shows its repos beside it. */
  hover(id) {
    this.hot = id;
    for (const node of this.node.querySelectorAll('[data-id]')) node.classList.toggle('is-hot', id != null && node.dataset.id === id);
    const island = id && id !== 'home' ? this.data?.islands.find(i => i.id === id) : null;
    const spot = island ? this.spots?.get(id) : null;
    if (!island || !spot) { this.card.hidden = true; return; }
    const fresh = this.data.fresh, here = this.data.current === id;
    const shown = island.repos.slice(0, CARD_REPOS);
    clear(this.card,
      h('div.city-routes-card-head', h('strong', island.owner), h('span', island.ownerType === 'Organization' ? 'Organization' : 'Personal account')),
      h('ul.city-routes-repos', ...shown.map(repo => h('li',
        h('span.city-routes-repo-name', repo.name), repo.private ? icon('shield', 'city-routes-lock') : null,
        h('span.city-routes-access', accessLabel(repo.permissions)), fresh.has(repoKey(repo)) ? h('span.city-routes-new', 'new') : null))),
      island.repos.length > shown.length ? h('div.city-routes-more', `+${island.repos.length - shown.length} more`) : null,
      h('div.city-routes-card-hint', here ? 'You are here' : 'Click to fly there'));
    this.card.hidden = false;
    const box = this.mapBox, bw = box.clientWidth, bh = box.clientHeight, cw = this.card.offsetWidth, ch = this.card.offsetHeight;
    const scale = Math.min(bw / W, bh / H), ox = (bw - W * scale) / 2, oy = (bh - H * scale) / 2;
    const px = ox + spot.x * scale, py = oy + spot.y * scale, gap = spot.r * 1.25 * scale + 14;
    const left = px + gap + cw < bw - 8 ? px + gap : Math.max(8, px - gap - cw);
    this.card.style.left = `${Math.round(left)}px`;
    this.card.style.top = `${Math.round(Math.max(8, Math.min(bh - ch - 8, py - ch / 2)))}px`;
  }
}
