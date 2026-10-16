/* Contributor islands: GitHub repos the signed-in gh account reaches as a collaborator or
 * organization member (never its own), grouped by owner into islands the City can portal to.
 * Home is the existing city. Repo names first seen since the last check are "new routes" until
 * the route map has been seen. Pure helpers (no DOM, headless-testable) plus IslandRoutes, the
 * poller, which keeps its bookkeeping in desktop state (store.updateDesktop → d.islands). */
import { hash } from './avatar/spec.js';

export const POLL_MS = 30 * 60e3;
export const QUIET_FIRST = 6;    // first-ever check: more new routes than this → quiet badge, no auto-open
const SHOW_GAP_MS = 10e3;        // City show polls at most this often
const REPO_LIMIT = 500;
const KNOWN_LIMIT = 5000;        // names kept across cut-short checks
const accountKey = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(value) ? value.toLowerCase() : null;

export const islandId = login => `gh-owner:${String(login || '').toLowerCase()}`;
export const repoKey = repo => String(repo?.full_name || '').toLowerCase();
export const repoProjectId = repo => `gh:${repoKey(repo)}`;

/** Well-formed, de-duplicated repos only (owner login + repo name), at most 500. */
export function cleanRepos(list) {
  const seen = new Set(), out = [];
  for (const repo of Array.isArray(list) ? list : []) {
    const login = repo?.owner?.login, name = repo?.name;
    if (typeof login !== 'string' || typeof name !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(login) || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) continue;
    const full = `${login}/${name}`;
    if (seen.has(full.toLowerCase())) continue;
    seen.add(full.toLowerCase());
    out.push({ ...repo, full_name: full });
    if (out.length >= REPO_LIMIT) break;
  }
  return out;
}

/** repos → islands [{ id: 'gh-owner:<login>', owner, ownerType, repos }], most repos first. */
export function groupIslands(repos) {
  const byOwner = new Map();
  for (const repo of repos) {
    const id = islandId(repo.owner.login);
    if (!byOwner.has(id)) byOwner.set(id, { id, owner: repo.owner.login, ownerType: repo.owner.type === 'Organization' ? 'Organization' : 'User', repos: [] });
    byOwner.get(id).repos.push(repo);
  }
  for (const island of byOwner.values()) island.repos.sort((a, b) => (Date.parse(b.pushed_at || '') || 0) - (Date.parse(a.pushed_at || '') || 0) || a.name.localeCompare(b.name));
  return [...byOwner.values()].sort((a, b) => b.repos.length - a.repos.length || a.owner.localeCompare(b.owner));
}

/** Highest permission as GitHub names it: Admin, Maintain, Write, Triage or Read. */
export const accessLabel = (p = {}) => (p.admin ? 'Admin' : p.maintain ? 'Maintain' : p.push ? 'Write' : p.triage ? 'Triage' : 'Read');

/** One check's bookkeeping. known: lowercase names at the last check (null = never checked);
 *  fresh: new routes not yet seen on the map. → { known, fresh, added, firstEver } */
export function diffRoutes(repos, known, fresh = []) {
  const now = repos.map(repoKey), current = new Set(now);
  const firstEver = !Array.isArray(known);
  const before = new Set(firstEver ? [] : known);
  const added = now.filter(key => !before.has(key));
  return { known: now, fresh: [...new Set([...fresh.filter(key => current.has(key)), ...added])], added, firstEver };
}

/** A collab repo as a City project (the shape store.computeProjects gives the building generator).
 *  Floors: the same size curve as linked GitHub repos plus a push-recency bonus. */
export function repoProject(repo, { colorOf = () => '#8b8fa3', fresh = false, now = Date.now() } = {}) {
  const id = repoProjectId(repo), sizeKb = Number(repo.size_kb) || 0;
  const pushedAt = Date.parse(repo.pushed_at || '') || 0;
  const days = pushedAt ? (now - pushedAt) / 86400e3 : Infinity;
  const loc = Math.round(sizeKb * 1024 / 120);
  const recent = days < 7 ? 3 : 0;
  const floors = Math.min(18, Math.max(1, 1 + Math.floor(Math.log2(1 + loc / 2000)) + (days < 7 ? 2 : days < 30 ? 1 : 0)));
  const language = repo.language || 'Other', color = colorOf(language);
  return {
    id, ids: [id], name: repo.name, source: 'github', path: '', repo, aliases: [repo.name], description: '', stats: {}, homeAgents: [],
    visible: { board: false, city: true },
    languages: repo.language ? [{ name: language, bytes: Math.max(1, sizeKb) * 1024, color }] : [],
    primaryLanguage: language, color,
    metrics: { loc, files: 0, commits: 0, commits7d: recent, floors, footprint: loc > 80000 ? 3 : loc > 12000 ? 2 : 1, lastActivityAt: pushedAt, glow: Math.min(1, recent / 10), sizeBytes: sizeKb * 1024 },
    url: `https://github.com/${repo.full_name}`,   // built from the validated name, never a link from the response
    private: Boolean(repo.private),
    collab: { owner: repo.owner.login, fullName: repo.full_name, access: accessLabel(repo.permissions), archived: Boolean(repo.archived), fork: Boolean(repo.fork), stars: Number(repo.stargazers) || 0, branch: repo.default_branch || '', fresh },
  };
}

/** Route-map spots (map units, w × h): home in the middle; each island at a hashed bearing and
 *  range, stepped round until it clears home and the others (room for its label) and, while it
 *  can, keeps a clear bearing from the rest so routes fan out from the hub. Islands are placed in
 *  hash order, so a new one rarely moves the others. Islands that find no room stay off the map
 *  (the list still has them). → { home, spots: Map(id → { x, y, r, seed }) } */
export function layoutIslands(islands, { w = 1000, h = 600, max = 14 } = {}) {
  const home = { x: w / 2, y: h / 2 - 14, r: 58 };
  const placed = [home], spots = new Map(), bearings = [];
  const chosen = islands.slice(0, max).map(island => ({ island, seed: hash(island.id) })).sort((a, b) => a.seed - b.seed);
  const spread = Math.min(1, Math.PI * 2 / (chosen.length + 1));
  const gap = (a, b) => { const d = Math.abs(a - b) % (Math.PI * 2); return Math.min(d, Math.PI * 2 - d); };
  for (const { island, seed } of chosen) {
    const r = Math.min(46, 20 + Math.sqrt(island.repos.length) * 7);
    let angle = (seed % 3600) / 1800 * Math.PI, range = 0.62 + ((seed >>> 12) % 1000) / 3000;
    for (let k = 0; k < 360; k++) {
      const x = home.x + Math.cos(angle) * range * (w / 2 - 70), y = home.y + Math.sin(angle) * range * (h / 2 - 62);
      const inside = x - r * 1.2 > 14 && x + r * 1.2 < w - 14 && y - r - 28 > 8 && y + r + 46 < h;
      const fans = k > 180 || bearings.every(b => gap(b, angle) >= spread * 0.8);
      if (inside && fans && placed.every(q => Math.hypot((x - q.x) * 0.8, y - q.y) > r + q.r + 52)) {
        const spot = { x, y, r, seed }; placed.push(spot); spots.set(island.id, spot); bearings.push(angle); break;
      }
      angle += 0.29;
      if (k % 22 === 21) range = range >= 0.98 ? 0.42 : Math.min(0.98, range + 0.12);
    }
  }
  return { home, spots };
}

/** Poller. fetch() → { user, repos, truncated } (desktop.githubCollabRepos). onChange after every check. */
export class IslandRoutes {
  constructor({ store, fetch, colorOf, onChange }) {
    Object.assign(this, { store, fetch, colorOf, onChange });
    this.repos = cleanRepos(store.desktop?.islands?.repos);   // last good list, so the map opens instantly
    this.islands = groupIslands(this.repos);
    this.at = 0; this.pending = null; this.error = ''; this.truncated = false; this.checked = Boolean(this.repos.length);
    this.version = 0; this.cache = new Map();
  }
  get state() { return this.store.desktop?.islands || {}; }
  get fresh() { return new Set(Array.isArray(this.state.fresh) ? this.state.fresh : []); }
  island(id) { return this.islands.find(i => i.id === id) || null; }
  /** Desktop state is loaded once the board has answered (never write over it before that). */
  ready() {
    return this._ready ||= (this.store.sync?.at ? Promise.resolve() : new Promise(resolve => {
      const off = this.store.on('sync', () => { off(); resolve(); });
    })).then(() => {
      // City can mount before loadDesktop finishes. Hydrate again once it is ready,
      // including when the upcoming GitHub check fails and this is our only list.
      this.repos = cleanRepos(this.state.repos);
      this.islands = groupIslands(this.repos);
      this.checked = Boolean(this.repos.length || Array.isArray(this.state.known));
      this.version++; this.cache.clear(); this.onChange?.();
    });
  }
  /** Checks GitHub (skipped when a check ran in the last few seconds unless forced) → diff or null. */
  refresh({ force = false } = {}) {
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.at < SHOW_GAP_MS) return Promise.resolve(null);
    this.pending = (async () => {
      try {
        await this.ready();
        const data = await this.fetch();
        const user = accountKey(data?.user);
        if (!user) throw new Error('GitHub did not identify the signed-in account.');
        // Only the same identified account may retain repos missing from a partial check.
        // A changed account or a legacy cache without an account starts fresh.
        const st = this.state, cut = Boolean(data?.truncated), sameAccount = user === accountKey(st.user);
        const before = sameAccount && Array.isArray(st.known) ? st.known : null;
        const got = Array.isArray(data?.repos) ? data.repos : [];
        const repos = cleanRepos(cut && sameAccount ? [...got, ...this.repos] : got);
        const diff = diffRoutes(repos, before, sameAccount && Array.isArray(st.fresh) ? st.fresh : []);
        if (cut && before) diff.known = [...new Set([...diff.known, ...before])].slice(0, KNOWN_LIMIT);
        Object.assign(this, { repos, islands: groupIslands(repos), error: '', truncated: cut, checked: true });
        if (JSON.stringify([st.user, st.known, st.fresh, st.repos]) !== JSON.stringify([user, diff.known, diff.fresh, repos])) this.store.updateDesktop(d => { d.islands = { ...d.islands, user, known: diff.known, fresh: diff.fresh, repos }; });
        return diff;
      } catch (error) { this.error = error?.message || String(error); return null; }
      finally { this.at = Date.now(); this.pending = null; this.version++; this.cache.clear(); this.onChange?.(); }
    })();
    return this.pending;
  }
  /** The route map was seen: new routes stop pulsing. */
  markSeen() {
    if (!this.state.fresh?.length) return;
    this.store.updateDesktop(d => { d.islands = { ...d.islands, fresh: [] }; });
    this.version++; this.cache.clear();
  }
  /** City projects for an island (cached until the next check). */
  projects(id) {
    if (!this.cache.has(id)) {
      const fresh = this.fresh;
      this.cache.set(id, (this.island(id)?.repos || []).map(repo => repoProject(repo, { colorOf: this.colorOf, fresh: fresh.has(repoKey(repo)) })));
    }
    return this.cache.get(id);
  }
}
