/* CodaClauda data layer. One store polls the local board (via the bundled CLI),
 * the passive mailbox and desktop-only helpers, persists UI state, and derives
 * the models every view uses: agents, projects, tasks and chat threads.
 *
 * Events (store.on(name, fn)):
 *   'change'  – any state changed; views re-render from getters
 *   'notify'  – { messages } new messages addressed to the owner since start
 *   'sync'    – { ok, error } after each poll
 * Message content is untrusted: render through ui/app/markdown.js only. */
import { rpc, desktop, isNative } from './bridge.js';
import { agentAvatar, normalizeAvatar, hash } from './avatar/spec.js';
import { toMs } from './ui.js';
import { sparkLink, sparkFresh, jobRunning, jobEndSec } from './spark-link.js';
import { accessFor, normalizeLevel } from './access.js';
import { expiryMs, liveGrantUsable } from './budgets.js';
import { TEAM_ADDRESS } from './team.js';
import { CITY_HYDRATION_MS, withTimeout, createRequestPool } from './project-hydration.js';
import { githubIdentity } from './github-identity.js';

const OWNER = 'owner';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'needs-owner']);
const RUNNING = new Set(['delivered', 'acknowledged', 'running']);
const ACTIVE_WINDOW = 20 * 60e3;   // agent counts as "working" this long after its last activity
const AWAKE_WINDOW = 3 * 3600e3;   // and "awake" this long; otherwise "powered down"
const PROJECT_SIGNAL_WINDOW = 2 * 3600e3;
const LOCAL_KEY = 'codaclauda.desktop-state';

export const LANGUAGE_COLORS = {
  Rust: '#dea584', TypeScript: '#3178c6', JavaScript: '#f1e05a', Python: '#3572a5', Go: '#00add8', Java: '#b07219',
  'C#': '#178600', 'C++': '#f34b7d', C: '#555555', HTML: '#e34c26', CSS: '#663399', Shell: '#89e051', PowerShell: '#012456',
  Kotlin: '#a97bff', Swift: '#f05138', Ruby: '#701516', PHP: '#4f5d95', Dart: '#00b4ab', Lua: '#000080', Vue: '#41b883',
  Svelte: '#ff3e00', Markdown: '#083fa1', JSON: '#292929', TOML: '#9c4221', YAML: '#cb171e', 'Jupyter Notebook': '#da5b0b',
  GLSL: '#5686a5', Blender: '#f5792a', Other: '#8b8fa3',
};
export const languageColor = name => LANGUAGE_COLORS[name] || `hsl(${hash(name || 'x') % 360} 55% 55%)`;

const LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/i;
/** Saved extra GitHub accounts, dropping malformed rows. */
function cleanAccounts(list) {
  return (Array.isArray(list) ? list : []).filter(a => a && LOGIN.test(String(a.user || ''))).map(a => ({
    user: String(a.user), repos: Array.isArray(a.repos) ? a.repos : [], fetchedAt: Number(a.fetchedAt) || 0, source: String(a.source || ''),
  }));
}

function emptyDesktop() {
  return {
    version: 1,
    // githubAccounts: more owned GitHub accounts [{ user, repos, fetchedAt, source }]. accountLayout, one
    // choice for all of them: 'city' (one big city) or 'islands' (each its own island beside the city).
    projects: { local: [], github: { user: '', repos: [], fetchedAt: 0, source: '' }, githubAccounts: [], accountLayout: 'city', settings: {} },
    agents: {},
    avatar: null,
    avatarRequests: {},
    chats: { threads: {} },
    tasks: {},
    projectAccess: {},   // { [projectId]: { level: 'full'|'read', playwright, updatedAt } } (see access.js)
    prefs: { theme: 'dark', notify: true, sound: true, cityQuality: 'high', cityTime: 'auto', citySpark: 'auto', reducedMotion: false, chatFirst: false, chatProject: '' },
  };
}
const normalizePath = path => String(path || '').replaceAll('\\', '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase();
const tokenize = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const squash = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
export const providerOf = name => (/^claude/i.test(name) ? 'claude' : /^codex/i.test(name) ? 'codex' : 'other');

class Store extends EventTarget {
  constructor() {
    super();
    this.native = isNative();
    this.board = { endpoints: [], grants: [], requests: [], paused: false, state_dir: '' };
    this.addresses = [];
    this.messages = new Map();      // id -> mailbox message (all inboxes merged)
    this.cursors = {};              // addr -> next_cursor
    this.claims = [];
    this.manifest = null;
    this.cityProjectsReady = false; // first bank choice waits for the initial project inventory
    this._manifestRevision = 0;
    this._scanRequests = new Map();
    this._scanPool = createRequestPool();
    this._githubRequests = new Map();
    this._githubAccountRequests = new Map();
    this.paths = {};
    this.prefsInfo = {};
    this.desktop = emptyDesktop();
    this.sync = { ok: false, at: 0, error: '' };
    this.startSeq = null;           // owner messages above this sequence notify
    this.liveRuns = new Map();      // requestId -> poll handle
    this.spark = { configured: false, ok: false, at: 0, error: '', jobs: [], laptopJobs: [], limits: null, hardware: null, scheduler: null, transport: null };
    this.sparkHashes = new Map();    // sha256(project root as sparkdev sees it) -> project id
    this._timers = [];
    this._saveTimer = null;
    this._derived = null;
  }

  /* ---------------- events ---------------- */
  on(name, fn) { const handler = event => fn(event.detail); this.addEventListener(name, handler); return () => this.removeEventListener(name, handler); }
  emit(name, detail) { if (name === 'change') this._derived = null; this.dispatchEvent(new CustomEvent(name, { detail })); }

  /* ---------------- lifecycle ---------------- */
  async start() {
    if (!this._desktopLoaded) await this.loadDesktop();
    const inventory = this.refreshManifest();
    try { this.paths = await desktop.paths(); } catch { this.paths = {}; }
    try { this.prefsInfo = await desktop.preferences(); } catch { this.prefsInfo = {}; }
    await Promise.allSettled([this.refreshBoard(), this.refreshMail(true), inventory]);
    this.startSeq = Math.max(0, ...[...this.messages.values()].map(m => m.sequence || 0));
    this.resumeLiveRuns();
    this.emit('change');
    const every = (ms, fn) => this._timers.push(setInterval(() => fn().catch(() => {}), ms));
    every(6000, () => this.refreshMail(false));
    every(15000, () => this.refreshBoard());
    every(60000, () => this.refreshMail(true));
    every(60000, () => this.refreshManifest());
    every(15000, () => this.refreshSpark());
    this.refreshSpark();
    every(30000, async () => this.emit('change')); // keeps "x minutes ago" and statuses fresh
  }

  async refreshBoard() {
    try {
      const data = await rpc('status');
      this.board = { endpoints: data.endpoints || [], grants: data.grants || [], requests: data.requests || [], paused: !!data.paused, state_dir: data.state_dir || '', spark: data.spark || null, limits: data.limits || null };
      this.setSync(true);
    } catch (error) { this.setSync(false, error); }
  }

  /** Incremental by default; `full` re-reads every inbox so read receipts refresh. */
  async refreshMail(full = false) {
    try {
      const [directory, claims] = await Promise.all([
        full || !this.addresses.length ? rpc('mailbox-directory', {}) : null,
        rpc('mailbox-claims', {}),
      ]);
      if (directory) this.addresses = directory.addresses || [];
      this.claims = claims?.claims || [];
      const before = this.messages.size;
      const fresh = [];
      await Promise.all(this.addresses.map(async ({ name }) => {
        let since = full ? 0 : this.cursors[name] || 0;
        for (let page = 0; page < 20; page++) {
          const data = await rpc('mailbox-inbox', { addr: name, since, limit: 100 });
          for (const message of data.messages || []) {
            const known = this.messages.get(message.id);
            if (!known) fresh.push(message);
            this.messages.set(message.id, message);
          }
          since = data.next_cursor ?? since;
          if (!data.has_more) break;
        }
        this.cursors[name] = since;
      }));
      this.setSync(true);
      if (this.startSeq != null) {
        const incoming = fresh.filter(m => m.to === OWNER && (m.sequence || 0) > this.startSeq);
        if (incoming.length) { this.startSeq = Math.max(this.startSeq, ...incoming.map(m => m.sequence || 0)); this.emit('notify', { messages: incoming }); }
      }
      if (this.messages.size !== before || full) this.emit('change');
    } catch (error) { this.setSync(false, error); }
  }

  /** Directory only (cheap): Agent setup polls this while a new chat is joining. */
  async refreshDirectory() {
    const directory = await rpc('mailbox-directory', {});
    const next = directory?.addresses || [];
    if (JSON.stringify(next) !== JSON.stringify(this.addresses)) { this.addresses = next; this.emit('change'); }
    return next;
  }

  /** Arm once, including when City renders before Store.start. Metadata can arrive later. */
  beginCityHydration() {
    if (!this._cityHydration) {
      this._cityHydration = new Promise(resolve => { this._cityHydrationDone = resolve; });
      if (this.cityProjectsReady) this._cityHydrationDone();
      else this._cityHydrationTimer = setTimeout(() => this.finishCityHydration(), CITY_HYDRATION_MS);
    }
    return this._cityHydration;
  }
  finishCityHydration() {
    if (this.cityProjectsReady) return;
    clearTimeout(this._cityHydrationTimer); this._cityHydrationTimer = null;
    this.cityProjectsReady = true; this._cityHydrationDone?.(); this.emit('change');
  }
  async refreshManifest() {
    this.beginCityHydration();
    if (!this._manifestRequest) {
      const request = Promise.resolve().then(() => desktop.loadManifest());
      this._manifestRequest = request;
      // Keep the actual invocation in flight after its bounded wait expires.
      request.then(data => {
        if (this._manifestRequest !== request) return;
        this._manifestRequest = null;
        const next = data?.manifest || null, changed = JSON.stringify(next) !== JSON.stringify(this.manifest);
        if (changed) { this.manifest = next; this._manifestRevision++; this.emit('change'); this.adoptManifest(); }
        else if (!this._adopting) this.finishCityHydration();
      }, () => {
        if (this._manifestRequest !== request) return;
        this._manifestRequest = null;
        if (!this._adopting) this.finishCityHydration();
      });
    }
    // Cached folders are useful immediately; a slow optional manifest must not
    // prevent their scans. A changed manifest queues one further adoption pass.
    this.adoptManifest();
    try { await withTimeout(this._manifestRequest); } catch { /* optional file */ }
  }

  /** Agent-written manifest: link its local folders (scanned in the background) and its GitHub user once. */
  adoptManifest() {
    this.beginCityHydration();
    if (this._adopting) {
      this._adoptAgain ||= this._adoptRevision !== this._manifestRevision;
      return this._adopting;
    }
    this._adoptRevision = this._manifestRevision;
    const run = Promise.resolve().then(async () => {
      const items = Array.isArray(this.manifest?.projects) ? this.manifest.projects : [];
      const known = new Set(this.desktop.projects.local.map(p => normalizePath(p.path)));
      const fresh = items.filter(item => {
        if (typeof item?.local_path !== 'string' || !item.local_path) return false;
        const path = normalizePath(item.local_path); if (known.has(path)) return false;
        known.add(path); return true;
      });
      if (fresh.length) this.updateDesktop(d => { for (const item of fresh) d.projects.local.push({ path: item.local_path, name: item.name, addedAt: Date.now(), fromManifest: true }); });
      const user = /^[A-Za-z0-9-]{1,39}$/.test(this.manifest?.github_user || '') ? this.manifest.github_user : '';
      const work = this.desktop.projects.local.filter(p => !p.scannedAt).map(item => this.scanProject(item.path));
      if (user && !this.desktop.projects.github.user) work.push(this.linkGithub(user, { automatic: true }));
      await Promise.allSettled(work);
    });
    this._adopting = run.catch(() => {}).then(() => {
      this._adopting = null;
      if (this._adoptAgain) { this._adoptAgain = false; return this.adoptManifest(); }
      if (!this._manifestRequest) this.finishCityHydration();
    });
    return this._adopting;
  }

  /** DGXBridge (sparkdev) status through the board's owner-only, read-only Spark status call. */
  async refreshSpark() {
    if (!this.board.spark?.executable) {
      if (this.spark.configured) { this.spark = { ...this.spark, configured: false, ok: false }; this.emit('change'); }
      return;
    }
    try {
      const d = await rpc('spark', { operation: 'status', arguments: {} });
      const link = sparkLink(d);   // only an authenticated remote answer counts; unknown fails closed
      this.spark = {
        configured: true, ok: link.reachable, at: Date.now(), error: link.error,
        lastOkAt: link.reachable ? Date.now() : this.spark.lastOkAt || 0,
        jobs: link.reachable && Array.isArray(d.jobs) ? d.jobs : [], laptopJobs: Array.isArray(d.laptop_jobs) ? d.laptop_jobs : [],
        limits: d.limits || null, hardware: d.hardware || null, scheduler: d.scheduler || null, transport: d.transport || null,
      };
      await this.mapSparkProjects();
    } catch (error) {
      this.spark = { ...this.spark, configured: true, ok: false, at: Date.now(), error: error.message || String(error) };
    }
    this.emit('change');
  }
  /** sparkdev identifies a job's project as sha256 of the project root path; hash our linked paths the same ways. */
  async mapSparkProjects() {
    if (!globalThis.crypto?.subtle) return;
    const digest = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
    for (const project of this.projects) {
      if (!project.path || [...this.sparkHashes.values()].includes(project.id)) continue;
      const win = String(project.path).replaceAll('/', '\\').replace(/^\\\\\?\\/, '').replace(/\\+$/, '');
      for (const variant of new Set([win, `\\\\?\\${win}`, win.toLowerCase(), win.replaceAll('\\', '/')])) this.sparkHashes.set(await digest(variant), project.id);
    }
  }
  /** Work per machine: running jobs, reserved cores/memory, last-24h CPU-hours, plus per-project activity. */
  get machines() {
    const now = Date.now() / 1000;
    const online = Boolean(this.spark.configured && this.spark.ok && sparkFresh(this.spark.at));   // stale or unknown = offline
    // Offline, Spark jobs kept from the last good check are history, not running work: they never
    // count as active and an unfinished one stops accruing core-hours at the last confirmed check.
    const cpuHours = jobs => jobs.reduce((sum, j) => {
      const start = Number(j.started_at) || 0; if (!start) return sum;
      const end = jobEndSec(j, { online, lastOkAt: this.spark.lastOkAt, now }); if (end < now - 86400) return sum;
      return sum + (Number(j.reserved_cpu ?? j.cpu) || 0) * Math.max(0, end - Math.max(start, now - 86400)) / 3600;
    }, 0);
    const all = [...this.spark.jobs, ...this.spark.laptopJobs.map(j => ({ ...j, where: j.where || 'laptop' }))];
    const byId = new Map(all.map(j => [j.job, j]));
    const jobs = [...byId.values()].map(j => ({ ...j, machine: j.where === 'spark' ? 'spark' : 'local', projectId: this.sparkHashes.get(j.project) || null, active: jobRunning(j, online), provider: providerOf(j.client || '') }));
    const summarize = list => ({ running: list.filter(j => j.active).length, cpuReserved: list.filter(j => j.active).reduce((n, j) => n + (Number(j.reserved_cpu ?? j.cpu) || 0), 0), memReservedGb: list.filter(j => j.active).reduce((n, j) => n + (Number(j.reserved_memory_gb ?? j.memory_gb) || 0), 0), cpuHours24h: cpuHours(list), finished24h: list.filter(j => Number(j.finished_at) > now - 86400).length });
    const spark = jobs.filter(j => j.machine === 'spark'), local = jobs.filter(j => j.machine === 'local');
    const transport = this.spark.transport || {};
    return {
      // The Spark side exists whenever DGXBridge is configured; `online` says whether it answered the last check.
      enabled: this.spark.configured,
      online,
      offlineSince: this.spark.configured && !online ? (this.spark.lastOkAt || null) : null,
      configured: this.spark.configured, error: this.spark.error, checkedAt: this.spark.at,
      local: { name: 'This PC', ...summarize(local) },
      spark: { name: 'DGX Spark', ...summarize(spark), reachable: online, route: transport.route || '', healthy: this.spark.scheduler?.healthy === true, cpuTotal: this.spark.limits?.cpu_total ?? null, memTotalGb: this.spark.limits?.memory_gb_total ?? null, hardware: this.spark.hardware },
      jobs, // [{ job, machine:'spark'|'local', projectId|null, active, provider, client, runtime, state, cpu, memory_gb, started_at, finished_at, exit_code }]
    };
  }

  setSync(ok, error) {
    const changed = this.sync.ok !== ok;
    this.sync = { ok, at: Date.now(), error: ok ? '' : error?.message || String(error || '') };
    this.emit('sync', this.sync);
    if (changed) this.emit('change');
  }

  /* ---------------- desktop (UI) state persistence ---------------- */
  async loadDesktop() {
    this._desktopLoaded = true;
    let saved = null;
    try { saved = (await desktop.loadState())?.state || null; } catch { /* fall back */ }
    if (!saved) { try { saved = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null'); } catch { saved = null; } }
    const base = emptyDesktop();
    if (saved && typeof saved === 'object') {
      this.desktop = { ...base, ...saved, projects: { ...base.projects, ...saved.projects, github: { ...base.projects.github, ...saved.projects?.github }, githubAccounts: cleanAccounts(saved.projects?.githubAccounts), accountLayout: saved.projects?.accountLayout === 'islands' ? 'islands' : 'city' }, prefs: { ...base.prefs, ...saved.prefs }, chats: { threads: { ...saved.chats?.threads } } };
    }
  }
  /** Mutate desktop state through fn(draft); saved (debounced) and broadcast. */
  updateDesktop(fn) {
    fn(this.desktop);
    this.emit('change');
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveDesktop(), 400);
  }
  async saveDesktop() {
    try { await desktop.saveState(this.desktop); }
    catch { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(this.desktop)); } catch { /* best effort */ } }
  }
  /** Durable save for records that must not silently fall back (standing permissions):
   *  writes to the native desktop state file now and throws if that fails. */
  async saveDesktopStrict() {
    clearTimeout(this._saveTimer); this._saveTimer = null;
    await desktop.saveState(this.desktop);
  }
  get prefs() { return this.desktop.prefs; }
  setPref(key, value) { this.updateDesktop(d => { d.prefs[key] = value; }); }

  /* ---------------- derived models ---------------- */
  derived() {
    if (!this._derived) {
      const projects = this.computeProjects();
      const agents = this.computeAgents(projects);
      this._derived = { projects, agents, tasks: this.computeTasks(projects, agents) };
    }
    return this._derived;
  }
  /** All linked projects, including hidden ones. Use visibleProjects(surface) for the board/city. */
  get projects() { return this.derived().projects; }
  get agents() { return this.derived().agents; }
  get tasks() { return this.derived().tasks; }
  /** Home City excludes projects of accounts shown as their own island (IslandMode portals there). */
  visibleProjects(surface /* 'board' | 'city' */) { return this.projects.filter(p => p.visible[surface] && !(surface === 'city' && p.island)); }
  /** Projects of one owned account shown as its own island, with that account's island id. */
  islandProjects(id) { return this.projects.filter(p => p.visible.city && p.island === id); }
  /** Owned accounts: the main one (always part of the city) plus linked extras. */
  get githubAccounts() {
    const main = this.desktop.projects.github || {};
    const extra = this.desktop.projects.githubAccounts || [];
    return [...(main.user ? [{ user: main.user, main: true, repos: main.repos || [], fetchedAt: main.fetchedAt, source: main.source }] : []), ...extra];
  }
  /** One choice for every extra account: 'city' (one big city) or 'islands' (each its own island). */
  get accountLayout() { return this.desktop.projects.accountLayout === 'islands' ? 'islands' : 'city'; }
  setAccountLayout(layout) { this.updateDesktop(d => { d.projects.accountLayout = layout === 'islands' ? 'islands' : 'city'; }); }
  project(id) { return this.projects.find(p => p.id === id || p.ids.includes(id)); }
  agent(id) { return this.agents.find(a => a.id === id); }
  get mailboxMessages() { return [...this.messages.values()].sort((a, b) => (a.sequence || 0) - (b.sequence || 0)); }
  get ownerUnread() { return this.mailboxMessages.filter(m => m.to === OWNER && !m.read_at).length; }
  addressLabel(name) { if (name === OWNER) return 'You'; return this.addresses.find(a => a.name === name)?.label || name; }
  get avatar() { return this.desktop.avatar ? normalizeAvatar(this.desktop.avatar) : null; }

  computeProjects() {
    const d = this.desktop.projects;
    const settings = d.settings || {};
    const byKey = new Map();
    const add = project => { byKey.set(project.id, project); return project; };
    const blank = (id, name) => ({ id, ids: [id], name, source: 'local', path: '', repo: null, aliases: [], description: '', stats: {}, homeAgents: [] });

    for (const item of d.local || []) {
      const id = `local:${normalizePath(item.path)}`;
      const project = add({ ...blank(id, item.name || item.path.split(/[\\/]/).pop()), path: item.path, stats: item.stats || {}, scannedAt: item.scannedAt || 0, aliases: item.aliases || [] });
      const gh = githubIdentity(item.stats?.git?.remote);
      if (gh) project.ids.push(gh);
    }
    const manifestProjects = Array.isArray(this.manifest?.projects) ? this.manifest.projects : [];
    // Local entries go first so a matching remote-only row cannot hide their path.
    for (const item of [...manifestProjects].sort((a, b) => Number(Boolean(b?.local_path)) - Number(Boolean(a?.local_path)))) {
      if (!item || typeof item.name !== 'string') continue;
      const localId = item.local_path ? `local:${normalizePath(item.local_path)}` : null;
      const ghId = githubIdentity(item.github, { allowSlug: true });
      let project = (localId && byKey.get(localId)) || [...byKey.values()].find(p => ghId && p.ids.includes(ghId) && (!localId || !p.path || normalizePath(p.path) === normalizePath(item.local_path)));
      if (!project) project = add({ ...blank(localId || ghId || `manifest:${squash(item.name)}`, item.name), path: item.local_path || '', fromManifest: true });
      if (localId && !project.ids.includes(localId)) project.ids.push(localId);
      if (ghId && !project.ids.includes(ghId)) project.ids.push(ghId);
      if (localId && !project.path) project.path = item.local_path;
      project.name = item.name;
      project.description ||= String(item.description || '').slice(0, 300);
      project.aliases.push(...(Array.isArray(item.aliases) ? item.aliases.map(String) : []));
      project.homeAgents.push(...(Array.isArray(item.agents) ? item.agents.map(String) : []));
    }
    // The main account's repos, then each extra owned account's. A project remembers its
    // account; with the islands layout, an extra account's repos live on that account's island.
    const islands = d.accountLayout === 'islands';
    const sources = [{ user: d.github?.user, main: true, repos: d.github?.repos || [] }, ...(d.githubAccounts || [])];
    for (const account of sources) for (const repo of account.repos || []) {
      const owner = repo.owner?.login || account.user;
      const ghId = githubIdentity(repo.full_name || (owner && repo.name ? `${owner}/${repo.name}` : repo.name), { allowSlug: true });
      if (!ghId) continue;
      let project = [...byKey.values()].find(p => p.ids.includes(ghId));
      if (!project) project = add({ ...blank(ghId, repo.name), source: 'github' });
      else if (project.repo) continue;   // the first account listing a repo owns it
      else project.source = project.path ? 'both' : 'github';
      if (!project.ids.includes(ghId)) project.ids.push(ghId);
      project.repo = repo;
      project.account = String(account.user || '').toLowerCase();
      project.island = islands && !account.main && account.user ? `owned:${String(account.user).toLowerCase()}` : null;
      project.description ||= repo.description || '';
      project.aliases.push(repo.name);
    }

    return [...byKey.values()].map(project => {
      const setting = project.ids.map(id => settings[id]).find(Boolean) || {};
      const stats = project.stats || {};
      const repo = project.repo;
      const languages = stats.languages?.length ? stats.languages
        : repo?.languages?.length ? repo.languages
          : repo?.language ? [{ name: repo.language, bytes: (repo.size_kb || 1) * 1024 }] : [];
      // GitHub language bytes are exact source sizes; diskUsage includes git history, so it is only a rough fallback.
      const languageBytes = (repo?.languages || []).reduce((sum, l) => sum + (Number(l.bytes) || 0), 0);
      const loc = stats.loc || (languageBytes ? Math.round(languageBytes / 38) : repo?.size_kb ? Math.round(repo.size_kb * 1024 / 120) : 0);
      const commits = stats.git?.commits || repo?.commit_count || 0;
      const lastActivityAt = Math.max(toMs(stats.git?.last_commit_at) || 0, toMs(repo?.pushed_at) || 0);
      const recent = stats.git?.commits_7d ?? (lastActivityAt && Date.now() - lastActivityAt < 7 * 86400e3 ? 3 : 0);
      const floors = Math.min(18, Math.max(1, 1 + Math.floor(Math.log2(1 + loc / 2000)) + Math.floor(Math.log2(1 + commits / 50))));
      const files = stats.files || 0;
      const footprint = files > 800 || loc > 80000 ? 3 : files > 120 || loc > 12000 ? 2 : 1;
      const primary = languages[0]?.name || repo?.language || 'Other';
      return {
        ...project,
        name: setting.name || project.name,
        aliases: [...new Set([project.name, ...project.aliases, ...(setting.aliases || []), project.path.split(/[\\/]/).pop()].filter(Boolean))],
        visible: { board: setting.board !== false, city: setting.city !== false },
        languages: languages.map(l => ({ ...l, color: languageColor(l.name) })),
        primaryLanguage: primary,
        color: languageColor(primary),
        metrics: { loc, files, commits, commits7d: recent, floors, footprint, lastActivityAt, glow: Math.min(1, recent / 10), sizeBytes: stats.bytes || (repo?.size_kb || 0) * 1024 },
        url: repo?.url || '',
        private: !!repo?.private,
      };
    }).sort((a, b) => b.metrics.loc - a.metrics.loc || a.name.localeCompare(b.name));
  }

  /** Find the project a piece of text refers to (tags like [Name], "Project: Name", or a name/alias mention).
   *  preferId: an explicit [tag] always wins; otherwise a mention of the preferred (home) project beats other mentions. */
  matchProject(text, projects = this.projects, preferId = null) {
    const raw = String(text || '');
    const tag = /\[([^\]]{2,60})\]|project\s*:\s*([^\n,;]{2,60})/i.exec(raw);
    const words = ` ${tokenize(raw)} `, joined = squash(raw);
    let best = null, bestScore = 0;
    for (const project of projects) {
      for (const alias of project.aliases) {
        const a = tokenize(alias), s = squash(alias);
        if (s.length < 4) continue;
        let score = 0;
        if (tag && squash(tag[1] || tag[2]) === s) score = 100;
        else if (words.includes(` ${a} `)) score = 50 + s.length;
        else if (joined.includes(s)) score = 20 + s.length;
        if (score === 100) return project; // explicit [tag] / "Project:" line wins outright
        if (score && preferId && project.ids.includes(preferId)) score += 1000;
        if (score > bestScore) { bestScore = score; best = project; }
      }
    }
    return best;
  }

  computeAgents(projects) {
    const now = Date.now();
    const messages = this.mailboxMessages;
    const agents = [];
    const agentPrefs = this.desktop.agents || {};
    for (const address of this.addresses) {
      // The desktop's team inbox (codaclauda-team) is a service address, not an agent.
      if (address.name === OWNER || address.name === TEAM_ADDRESS) continue;
      const id = address.name, provider = providerOf(id);
      const sent = messages.filter(m => m.from === id);
      const involved = messages.filter(m => m.from === id || m.to === id);
      const claims = this.claims.filter(c => c.holder === id && toMs(c.expires_at) > now);
      const lastSent = sent.at(-1);
      const lastAt = Math.max(toMs(lastSent?.created_at) || 0, ...claims.map(c => toMs(c.created_at) || 0));
      const status = claims.length || now - lastAt < ACTIVE_WINDOW ? 'active' : now - lastAt < AWAKE_WINDOW ? 'idle' : 'offline';
      agents.push(this.agentRecord({ id, address: id, provider, kind: 'mailbox', name: address.label || id, status, lastAt, claims, involved, sent, projects, agentPrefs }));
    }
    for (const endpoint of this.board.endpoints) {
      const requests = this.board.requests.filter(r => r.target === endpoint.id);
      const running = requests.filter(r => RUNNING.has(r.state));
      const lastAt = Math.max(0, ...requests.map(r => toMs(r.updated_at) || 0));
      // Dedicated endpoints are on-demand workers: show them only when they have recent work.
      if (!running.length && now - lastAt > AWAKE_WINDOW) continue;
      const status = running.length ? 'active' : now - lastAt < AWAKE_WINDOW ? 'idle' : 'offline';
      const workspaceProject = projects.find(p => p.path && normalizePath(p.path) === normalizePath(endpoint.workspace));
      agents.push(this.agentRecord({ id: `endpoint:${endpoint.id}`, endpointId: endpoint.id, provider: endpoint.agent, kind: 'dedicated', name: endpoint.label || endpoint.id, status, lastAt, claims: [], involved: [], sent: [], projects, agentPrefs, requests, running, workspaceProject, cwd: endpoint.workspace }));
    }
    return agents.sort((a, b) => ({ active: 0, idle: 1, offline: 2 }[a.status] - { active: 0, idle: 1, offline: 2 }[b.status]) || a.name.localeCompare(b.name));
  }

  agentRecord({ id, address, endpointId, provider, kind, name, status, lastAt, claims, involved, sent, projects, agentPrefs, requests = [], running = [], workspaceProject, cwd }) {
    const pref = agentPrefs[id] || {};
    const now = Date.now();
    const manifestHome = projects.find(p => p.homeAgents.includes(id));
    const home = pref.home === 'hq' ? null : (pref.home && projects.find(p => p.ids.includes(pref.home))) || manifestHome || workspaceProject || this.matchProject(name, projects) || null;
    // Current project: most recent signal (claims, own messages, running requests) within the window.
    let current = null, activity = '', projectObservedAt = 0;
    const signals = [
      ...claims.map(c => ({ at: toMs(c.created_at), text: `${c.resource} ${c.purpose || ''}`, label: `Holding ${c.resource}` })),
      ...sent.slice(-8).map(m => ({ at: toMs(m.created_at), text: `${m.subject}\n${m.body}`, label: m.subject })),
      ...running.map(r => ({ at: toMs(r.updated_at), project: workspaceProject, label: r.prompt?.slice(0, 80) || 'Dedicated request' })),
    ].filter(s => now - s.at < PROJECT_SIGNAL_WINDOW).sort((a, b) => b.at - a.at);
    for (const signal of signals) {
      const project = signal.project || this.matchProject(signal.text, projects, home?.id);
      if (project) { current = project; projectObservedAt = signal.at; activity = signal.label; break; }
    }
    if (!activity) activity = signals[0]?.label || (sent.at(-1)?.subject ?? '');
    const look = pref.look ? normalizeAvatar(pref.look) : agentAvatar(id, provider, pref.nickname || name);
    return {
      id, address, endpointId, provider, kind, cwd: typeof cwd === 'string' ? cwd : '',
      name: pref.nickname || name, label: name,
      status, lastSeenAt: lastAt || 0,
      homeProjectId: home?.id || null,
      currentProjectId: (status !== 'offline' && current?.id) || home?.id || null,
      // City remembers real work separately from the legacy status/home fallback.
      observedProjectId: current?.id || null, projectObservedAt,
      visiting: Boolean(current && home && current.id !== home.id && status !== 'offline'),
      activity,
      claims, requests,
      unreadForOwner: involved.filter(m => m.from === id && m.to === OWNER && !m.read_at).length,
      look,
    };
  }

  computeTasks(projects, agents) {
    const tasks = [];
    const overrides = this.desktop.tasks || {};
    const agentFor = name => agents.find(a => a.address === name || a.id === name);
    const requestColumn = state => (state === 'queued' ? 'todo' : RUNNING.has(state) ? 'in-progress' : state === 'completed' || state === 'cancelled' ? 'done' : 'needs-you');
    for (const r of this.board.requests) {
      const endpoint = this.board.endpoints.find(e => e.id === r.target);
      const project = projects.find(p => p.path && endpoint && normalizePath(p.path) === normalizePath(endpoint.workspace));
      tasks.push({ id: `request:${r.id}`, type: 'request', title: (r.prompt || r.expected_result || r.id).split('\n')[0].slice(0, 140), detail: r.expected_result || '', status: requestColumn(r.state), state: r.state, agentId: `endpoint:${r.target}`, from: r.origin === OWNER ? 'You' : r.origin, projectId: project?.id || null, createdAt: toMs(r.created_at), updatedAt: toMs(r.updated_at), source: r });
    }
    const all = this.mailboxMessages;
    const replies = new Map();
    for (const m of all) if (m.reply_to) { if (!replies.has(m.reply_to)) replies.set(m.reply_to, []); replies.get(m.reply_to).push(m); }
    for (const m of all) {
      const isTask = m.from === OWNER && /^task:/i.test(m.subject || '');
      if (m.kind !== 'question' && !isTask) continue;
      const answers = replies.get(m.id) || [];
      const agentName = m.from === OWNER ? m.to : m.from;
      let status = answers.length ? 'done' : m.to === OWNER ? 'needs-you' : m.read_at ? 'in-progress' : 'waiting';
      if (isTask && answers.length && !answers.some(a => /\b(done|complete[d]?|finished|shipped|merged)\b/i.test(`${a.subject} ${a.body}`))) status = 'in-progress';
      const override = overrides[`mail:${m.id}`];
      if (override?.status) status = override.status;
      const project = override?.projectId === 'none' ? null : (override?.projectId && projects.find(p => p.ids.includes(override.projectId))) || this.matchProject(`${m.subject}\n${m.body}`, projects);
      tasks.push({ id: `mail:${m.id}`, type: isTask ? 'task' : 'question', title: (m.subject || '').replace(/^task:\s*/i, '') || '(no subject)', detail: m.body, status, agentId: agentFor(agentName)?.id || agentName, from: m.from === OWNER ? 'You' : this.addressLabel(m.from), to: this.addressLabel(m.to), projectId: project?.id || null, createdAt: toMs(m.created_at), updatedAt: Math.max(toMs(m.created_at), ...answers.map(a => toMs(a.created_at))), replies: answers, source: m });
    }
    for (const c of this.claims) {
      if (toMs(c.expires_at) <= Date.now()) continue;
      const project = this.matchProject(`${c.resource} ${c.purpose || ''}`, projects);
      tasks.push({ id: `claim:${c.holder}:${c.resource}`, type: 'claim', title: `${c.resource}`, detail: c.purpose || '', status: 'in-progress', agentId: agentFor(c.holder)?.id || c.holder, from: this.addressLabel(c.holder), projectId: project?.id || null, createdAt: toMs(c.created_at), updatedAt: toMs(c.created_at), expiresAt: toMs(c.expires_at), source: c });
    }
    return tasks.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /* ---------------- chat threads ---------------- */
  /** Thread list: one mailbox thread per agent address + saved live threads. */
  threads() {
    const list = [];
    for (const agent of this.agents.filter(a => a.kind === 'mailbox')) {
      const msgs = this.mailboxMessages.filter(m => (m.from === OWNER && m.to === agent.address) || (m.from === agent.address && m.to === OWNER));
      const last = msgs.at(-1);
      list.push({ id: `mail:${agent.address}`, kind: 'mailbox', title: agent.name, agentId: agent.id, provider: agent.provider, lastAt: toMs(last?.created_at) || 0, unread: agent.unreadForOwner, preview: last ? `${last.from === OWNER ? 'You: ' : ''}${last.subject}` : 'No messages yet', status: agent.status });
    }
    for (const thread of Object.values(this.desktop.chats.threads)) {
      const last = thread.messages.at(-1);
      const endpoint = this.board.endpoints.find(e => e.id === thread.endpointId);
      list.push({ id: thread.id, kind: 'live', title: thread.title || 'Live chat', agentId: `endpoint:${thread.endpointId}`, provider: endpoint?.agent || thread.provider || 'other', lastAt: last?.at || thread.createdAt, unread: 0, preview: last ? String(last.text || '').slice(0, 90) : 'New live chat', status: last?.state && !TERMINAL.has(last.state) && last.role === 'agent' ? 'active' : 'idle' });
    }
    return list.sort((a, b) => b.lastAt - a.lastAt);
  }
  /** Normalized messages for a thread: { id, role: 'owner'|'agent'|'system', author, text, at, status, attachments, raw } */
  threadMessages(threadId) {
    if (threadId.startsWith('mail:')) {
      const address = threadId.slice(5);
      return this.mailboxMessages.filter(m => (m.from === OWNER && m.to === address) || (m.from === address && m.to === OWNER)).map(m => ({
        id: m.id, role: m.from === OWNER ? 'owner' : 'agent', author: this.addressLabel(m.from), subject: m.subject, text: m.body, at: toMs(m.created_at), kind: m.kind,
        status: m.from === OWNER ? (m.read_at ? 'seen' : 'saved') : m.read_at ? 'read' : 'unread', replyTo: m.reply_to, raw: m,
      }));
    }
    const thread = this.desktop.chats.threads[threadId];
    return (thread?.messages || []).map(m => ({ ...m, author: m.role === 'owner' ? 'You' : thread.title, status: m.state || 'sent' }));
  }

  /* ---------------- actions ---------------- */
  /** Post as the owner. kind: notice|question|reply|claim|release. Returns the saved message. */
  async post({ to, kind = 'notice', subject, body, replyTo, resource, ttl, id }) {
    const payload = { id: id || `owner-${crypto.randomUUID()}`, from: OWNER, to, kind, subject: String(subject || '').slice(0, 300) || '(no subject)', body: String(body || ''), };
    if (kind === 'reply') payload.reply_to = replyTo;
    if (resource) payload.resource = resource;
    if (kind === 'claim') payload.ttl = ttl || 30;
    const saved = await rpc('mailbox-post', payload);
    this.messages.set(saved.id, saved);
    this.emit('change');
    return saved;
  }
  /** Mark messages to the owner as read (e.g. when a thread is opened). */
  async ackOwner(ids) {
    const unread = ids.map(id => this.messages.get(id)).filter(m => m && m.to === OWNER && !m.read_at);
    await Promise.allSettled(unread.map(async m => { const r = await rpc('mailbox-ack', { addr: OWNER, id: m.id }); this.messages.set(m.id, { ...m, read_at: r?.read_at || Math.floor(Date.now() / 1000) }); }));
    if (unread.length) this.emit('change');
  }
  /** Saves a file into the board's attachments folder so local agents can open it. */
  async saveAttachment(file) {
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
    return desktop.saveAttachment(file.name, data);
  }

  /* Projects */
  async linkFolder(path) {
    if (!path) { const picked = await desktop.pickFolder(); if (!picked?.path) return null; path = picked.path; }
    const key = normalizePath(path);
    if (!this.desktop.projects.local.some(p => normalizePath(p.path) === key)) this.updateDesktop(d => { d.projects.local.push({ path, name: path.split(/[\\/]/).pop(), addedAt: Date.now() }); });
    await this.scanProject(path);
    return path;
  }
  async scanProject(path) {
    const name = normalizePath(path);
    let request = this._scanRequests.get(name);
    if (!request) {
      const original = this.desktop.projects.local.find(p => normalizePath(p.path) === name);
      const previousStats = original?.stats, previousScan = original?.scannedAt;
      request = this._scanPool.run(async () => {
        const stats = await desktop.scanProject(path);
        const current = this.desktop.projects.local.find(p => normalizePath(p.path) === name);
        // Removal/relink or a newer state snapshot invalidates this old answer.
        if (current && current === original && current.stats === previousStats && current.scannedAt === previousScan) {
          this.updateDesktop(() => { current.stats = stats; current.scannedAt = Date.now(); });
        }
        return stats;
      });
      this._scanRequests.set(name, request);
      const clear = () => { if (this._scanRequests.get(name) === request) this._scanRequests.delete(name); };
      request.then(clear, clear);
    }
    return withTimeout(request);
  }
  async discoverDesktop() { return desktop.discoverDesktop(); }
  async linkGithub(user, { automatic = false } = {}) {
    const name = String(user || this.desktop.projects.github.user || '').toLowerCase();
    if (automatic && this._githubManualRequest) return withTimeout(this._githubManualRequest);
    let entry = this._githubRequests.get(name);
    if (!entry) {
      entry = { previous: this.desktop.projects.github };
      entry.promise = Promise.resolve().then(() => desktop.githubRepos(user || this.desktop.projects.github.user || '')).then(result => {
        if (this._githubSelection === entry && this.desktop.projects.github === entry.previous) {
          this.updateDesktop(d => { d.projects.github = { user: result.user, repos: result.repos || [], fetchedAt: Date.now(), source: result.source }; });
        }
        return result;
      });
      this._githubRequests.set(name, entry);
      this._githubSelection = entry;
      const clear = () => {
        if (this._githubRequests.get(name) === entry) this._githubRequests.delete(name);
        if (this._githubManualRequest === entry.promise) this._githubManualRequest = null;
      };
      entry.promise.then(clear, clear);
    }
    if (!automatic) {
      // A -> B -> A reuses A's invocation but gives the latest explicit choice
      // selection precedence, including if B completed before that choice.
      entry.previous = this.desktop.projects.github;
      this._githubSelection = entry; this._githubManualRequest = entry.promise;
    }
    return withTimeout(entry.promise);
  }
  /** Link (or refresh) another owned GitHub account; where it appears follows accountLayout. */
  async linkGithubAccount(user) {
    const login = String(user || '').trim().replace(/^@/, '');
    if (!LOGIN.test(login)) throw new Error('Enter a GitHub username (letters, numbers and dashes).');
    const key = login.toLowerCase();
    if (key === String(this.desktop.projects.github?.user || '').toLowerCase()) throw new Error(`@${login} is already your main account.`);
    const previous = this.desktop.projects.githubAccounts.find(a => a.user.toLowerCase() === key);
    const request = { previous };
    this._githubAccountRequests.set(key, request);
    try {
      const result = await withTimeout(desktop.githubRepos(login));
      const current = this.desktop.projects.githubAccounts.find(a => a.user.toLowerCase() === key);
      // Removal, unlink, relink, a newer refresh or a main-account change wins.
      if (this._githubAccountRequests.get(key) === request && current === previous
          && key !== String(this.desktop.projects.github?.user || '').toLowerCase()) {
        this.updateDesktop(d => {
          const list = d.projects.githubAccounts;
          const at = list.findIndex(a => a.user.toLowerCase() === key);
          const entry = { user: result.user || login, repos: result.repos || [], fetchedAt: Date.now(), source: result.source || '' };
          if (at >= 0) list[at] = entry; else list.push(entry);
        });
      }
      return result;
    } finally {
      if (this._githubAccountRequests.get(key) === request) this._githubAccountRequests.delete(key);
    }
  }
  removeGithubAccount(user) {
    this._githubAccountRequests.delete(String(user).toLowerCase());
    this.updateDesktop(d => { d.projects.githubAccounts = (d.projects.githubAccounts || []).filter(a => a.user.toLowerCase() !== String(user).toLowerCase()); });
  }
  /* Repos being cloned right now (ghId -> { state: 'queued' | 'cloning' | 'failed', message? }). The City
   * shows a "Cloning…" sign on their lots. In memory only. */
  get cloning() { return this._cloning ||= new Map(); }
  setCloning(ghId, state) {
    if (state) this.cloning.set(ghId, state); else this.cloning.delete(ghId);
    this.emit('change');
  }
  unlinkProject(project) {
    const ids = new Set([project.id, ...(project.ids || [])]);
    const removed = { local: [], accounts: [] };
    this.updateDesktop(d => {
      removed.local = d.projects.local.filter(p => ids.has(`local:${normalizePath(p.path)}`));
      d.projects.local = d.projects.local.filter(p => !ids.has(`local:${normalizePath(p.path)}`));
      const withoutProject = (account, main) => {
        const matches = repo => {
          const owner = repo.owner?.login || account.user;
          return ids.has(githubIdentity(repo.full_name || (owner && repo.name ? `${owner}/${repo.name}` : repo.name), { allowSlug: true }));
        };
        const repos = (account.repos || []).filter(matches);
        if (repos.length) removed.accounts.push({ user: account.user, main, repos });
        // Replacement invalidates a pending refresh of the affected snapshot.
        return main || repos.length ? { ...account, repos: (account.repos || []).filter(r => !matches(r)) } : account;
      };
      d.projects.github = withoutProject(d.projects.github, true);
      d.projects.githubAccounts = d.projects.githubAccounts.map(a => withoutProject(a, false));
    });
    return removed;
  }
  restoreProjectLinks(removed) {
    this.updateDesktop(d => {
      for (const item of removed.local || []) {
        if (!d.projects.local.some(p => normalizePath(p.path) === normalizePath(item.path))) d.projects.local.push(item);
      }
      for (const saved of removed.accounts || []) {
        const key = String(saved.user).toLowerCase();
        const current = saved.main ? d.projects.github : d.projects.githubAccounts.find(a => a.user.toLowerCase() === key);
        // Undo project removal cannot restore an account the owner removed/switched.
        if (!current || String(current.user).toLowerCase() !== key) continue;
        const identity = repo => githubIdentity(repo.full_name || `${repo.owner?.login || current.user}/${repo.name}`, { allowSlug: true });
        const repos = [...(current.repos || [])];
        for (const repo of saved.repos) if (!repos.some(r => identity(r) === identity(repo))) repos.push(repo);
        const restored = { ...current, repos };
        if (saved.main) d.projects.github = restored;
        else d.projects.githubAccounts = d.projects.githubAccounts.map(a => a === current ? restored : a);
      }
    });
  }
  /** visibility: { board?: boolean, city?: boolean, name?, aliases? } */
  setProjectSettings(project, patch) {
    this.updateDesktop(d => {
      const merged = Object.assign({}, ...project.ids.map(id => d.projects.settings[id]).filter(Boolean).reverse(), patch);
      for (const id of project.ids) delete d.projects.settings[id];
      d.projects.settings[project.id] = merged;
    });
  }
  setAgentPrefs(agentId, patch) { this.updateDesktop(d => { d.agents[agentId] = { ...d.agents[agentId], ...patch }; }); }
  setTaskOverride(taskId, patch) { this.updateDesktop(d => { d.tasks[taskId] = { ...d.tasks[taskId], ...patch }; }); }
  saveAvatar(spec) { this.updateDesktop(d => { d.avatar = normalizeAvatar(spec); }); }
  /** Message-board threads filed under projects. Key = thread root message id.
   *  { projectId: string|'none', pinned: boolean } — projectId overrides auto-detection. */
  get threadPrefs() { return this.desktop.threadPrefs || {}; }
  setThreadPrefs(rootId, patch) { this.updateDesktop(d => { d.threadPrefs = { ...(d.threadPrefs || {}) }; d.threadPrefs[rootId] = { ...d.threadPrefs[rootId], ...patch }; }); }
  /** Project for a mailbox thread: owner override → [tag]/"Project:" or name mention in any message → the agent's home project. */
  threadProject(rootId, messages) {
    const pref = this.threadPrefs[rootId];
    if (pref?.projectId === 'none') return null;
    if (pref?.projectId) return this.project(pref.projectId) || null;
    // Home project of the agents in this thread; a mention of it beats mentions of other projects.
    let home = null;
    for (const m of messages) { const agent = this.agents.find(a => a.address === m.from || a.address === m.to); home = agent?.homeProjectId && this.project(agent.homeProjectId); if (home) break; }
    // The thread's first message (usually where the [Project] tag or topic is) decides first.
    for (const m of messages) { const p = this.matchProject(`${m.subject}\n${m.body}`, this.projects, home?.id || null); if (p) return p; }
    return home || null;
  }
  /* Project access for sessions CodaClauda starts (access.js): Full or Read only, plus Playwright. */
  projectAccess(projectId) { const p = typeof projectId === 'object' ? projectId : this.project(projectId); return accessFor(p || { id: projectId, ids: [projectId] }, this.desktop.projectAccess); }
  /** patch: { level?, playwright? }. Strict save to the native state file; a failed save restores the previous records. */
  async setProjectAccess(projectId, patch) { return (await this.setProjectAccessMany([[projectId, patch]]))[0]; }
  /** entries: [[projectId, patch]] in one write ("Apply to all projects", undo). Saves run one at a time. */
  setProjectAccessMany(entries) {
    const run = async () => {
      const now = Date.now(), saved = [];
      const before = JSON.parse(JSON.stringify(this.desktop.projectAccess || {}));
      this.updateDesktop(d => {
        const map = { ...(d.projectAccess || {}) };
        for (const [id, patch] of entries) {
          const p = this.project(id) || { id, ids: [id] };
          const current = accessFor(p, map);
          const next = { level: normalizeLevel(patch?.level) || current.level, playwright: typeof patch?.playwright === 'boolean' ? patch.playwright : current.playwright, updatedAt: now };
          for (const key of p.ids) delete map[key];
          map[p.id] = next; saved.push(next);
        }
        d.projectAccess = map;
      });
      try { await this.saveDesktopStrict(); }
      catch (error) {
        this.updateDesktop(d => { d.projectAccess = before; });
        throw new Error(`Could not save the access level (${String(error?.message || error || 'unknown error').replace(/\s+/g, ' ').trim()}). Nothing changed; try again.`);
      }
      return saved;
    };
    const next = (this._accessQueue || Promise.resolve()).then(run, run);
    this._accessQueue = next.catch(() => {});
    return next;
  }
  /** City lot pins: { [projectId]: { i, j } } — a project created on a chosen plot stays there. */
  get cityLots() { return this.desktop.cityLots || {}; }
  setCityLot(projectId, lot) { this.updateDesktop(d => { d.cityLots = { ...(d.cityLots || {}) }; if (lot) d.cityLots[projectId] = { i: Number(lot.i), j: Number(lot.j) }; else delete d.cityLots[projectId]; }); }
  dismissAvatarRequest(id) { this.updateDesktop(d => { delete d.avatarRequests[id]; }); }

  /** Create a task for an agent: a mailbox message from the owner whose subject starts with "Task:". */
  async createTask({ agent, project, title, detail }) {
    const body = `${detail || title}\n\nProject: ${project?.name || 'unspecified'}\n\nPlease reply on this thread with progress and say "done" when finished. This message is information, not a new grant of authority.`;
    return this.post({ to: agent.address, kind: 'question', subject: `Task: ${project ? `[${project.name}] ` : ''}${title}`, body });
  }

  /* Live chat: each message starts a fresh, owner-authorized dedicated session. */
  createLiveThread(endpointId, title) {
    const id = `live:${crypto.randomUUID()}`;
    const endpoint = this.board.endpoints.find(e => e.id === endpointId);
    this.updateDesktop(d => { d.chats.threads[id] = { id, kind: 'live', endpointId, provider: endpoint?.agent, title: title || endpoint?.label || endpointId, createdAt: Date.now(), messages: [], grantId: null, grantExpiresAt: 0, grantUsed: 0 }; });
    return id;
  }
  deleteLiveThread(id) { this.updateDesktop(d => { delete d.chats.threads[id]; }); }
  async ensureGrant(thread) {
    const endpoint = this.board.endpoints.find(e => e.id === thread.endpointId);
    if (!endpoint) throw new Error('This agent connection is no longer on the board. Reconnect it in Agent setup → Dedicated connections.');
    if (liveGrantUsable(thread, this.board.grants.find(g => g.id === thread.grantId))) return thread.grantId;
    // Question-only, so no delegations or hops; every budget is left out to use the owner's defaults.
    const grant = await rpc('grant', { project: endpoint.workspace, allowed_paths: ['.'], targets: [endpoint.id], kinds: ['question'], expected_result: 'Reply to the owner in the CodaClauda live chat.', max_delegations: 0, max_hops: 0, compute: [] });
    const expires = expiryMs(grant.expires_at);
    this.updateDesktop(d => { Object.assign(d.chats.threads[thread.id], { grantId: grant.id, grantExpiresAt: expires === Infinity ? 'never' : expires, grantUsed: 0 }); });
    return grant.id;
  }
  /** attachments: [{ name, path, text? }] (text inlined when small). */
  async liveSend(threadId, text, attachments = []) {
    const thread = this.desktop.chats.threads[threadId];
    if (!thread) throw new Error('Chat not found');
    const grantId = await this.ensureGrant(thread);
    const history = thread.messages.slice(-12).map(m => `${m.role === 'owner' ? 'Owner' : 'You (assistant)'}: ${String(m.text || '').slice(0, 4000)}`).join('\n\n');
    const files = attachments.map(a => a.text != null ? `--- Attached file: ${a.name} ---\n${a.text.slice(0, 60000)}\n--- end ${a.name} ---` : `Attached file saved at: ${a.path}`).join('\n\n');
    const prompt = [
      'You are replying inside the CodaClauda desktop chat. Answer the owner directly in GitHub-flavored Markdown (code fences with languages, $math$ allowed). Be concise and complete.',
      history ? `Conversation so far:\n${history}` : '',
      files ? `Attachments:\n${files}` : '',
      `Owner's new message:\n${text}`,
    ].filter(Boolean).join('\n\n').slice(0, 200000);
    const id = crypto.randomUUID();
    const ownerMessage = { id: `m-${crypto.randomUUID()}`, role: 'owner', text, at: Date.now(), attachments: attachments.map(({ name, path }) => ({ name, path })) };
    const agentMessage = { id: `m-${id}`, role: 'agent', text: '', at: Date.now(), requestId: id, state: 'queued' };
    this.updateDesktop(d => { const t = d.chats.threads[threadId]; t.messages.push(ownerMessage, agentMessage); t.grantUsed += 1; if (!t.titled) { t.title = text.slice(0, 48) || t.title; t.titled = true; } });
    try {
      await rpc('submit', { id, grant_id: grantId, target: thread.endpointId, kind: 'question', prompt, expected_result: 'A helpful, complete chat reply in Markdown.' });
    } catch (error) {
      this.patchLive(threadId, id, { state: 'failed', text: `Could not start the agent: ${error.message}` });
      throw error;
    }
    this.pollLive(threadId, id);
    return id;
  }
  patchLive(threadId, requestId, patch) {
    this.updateDesktop(d => { const m = d.chats.threads[threadId]?.messages.find(x => x.requestId === requestId); if (m) Object.assign(m, patch); });
  }
  pollLive(threadId, requestId) {
    if (this.liveRuns.has(requestId)) return;
    const tick = async () => {
      try {
        const r = await rpc('request', { id: requestId });
        const done = TERMINAL.has(r.state);
        const text = r.answer || (done ? (r.blocker ? `**Blocked:** ${typeof r.blocker === 'string' ? r.blocker : JSON.stringify(r.blocker)}` : '_No answer was recorded._') : '');
        this.patchLive(threadId, requestId, { state: r.state, text, sessionId: r.session_id || null, cost: r.receipt?.estimated_cost_usd ?? null, ...(done ? { finishedAt: toMs(r.updated_at) || Date.now() } : {}) });
        if (done) { clearInterval(this.liveRuns.get(requestId)); this.liveRuns.delete(requestId); }
      } catch { /* keep polling; the board may be briefly locked */ }
    };
    this.liveRuns.set(requestId, setInterval(tick, 2000));
    tick();
  }
  resumeLiveRuns() {
    for (const thread of Object.values(this.desktop.chats.threads)) for (const m of thread.messages) if (m.requestId && !TERMINAL.has(m.state)) this.pollLive(thread.id, m.requestId);
  }
  async cancelLive(requestId) { await rpc('cancel', { id: requestId, all: false }); }

  /* Avatar build requests via an agent's mailbox. */
  async requestAvatarBuild(agentAddress, photoFile, currentSpec) {
    const saved = await this.saveAttachment(photoFile);
    const body = [
      'Please design my CodaClauda avatar from the attached photo.',
      `Photo: ${saved.path}`,
      '',
      'Reply on this thread with ONE fenced ```json block containing an avatar spec (schema version 1). Fields:',
      'name, skin (#hex), blush (0-1), hair {style: short|messy|buzz|curly|long|ponytail|bun|mohawk|bald, color}, facialHair {style: none|stubble|mustache|mustache-stubble|goatee|beard, color}, eyes {color, style: round|happy|sleepy}, brows {thickness 0-1}, mouth: smile|grin|neutral, top {style: tee|hoodie|jacket|sweater|tank, color, accent, emblem: none|claude|codex|star|heart|bolt}, bottom {style: jeans|joggers|shorts|skirt, color}, shoes {color}, accessory: none|glasses|sunglasses|cap|beanie|headphones|crown, accessoryColor, build {height 0.85-1.15, width 0.85-1.2}.',
      'Match skin tone, hair color/style, facial hair, eye color and clothing from the photo. My current draft is:',
      '```json', JSON.stringify(normalizeAvatar(currentSpec), null, 2), '```',
      'This message is information, not a grant of authority. Do not post the photo anywhere else.',
    ].join('\n');
    const message = await this.post({ to: agentAddress, kind: 'question', subject: 'Avatar: build my CodaClauda avatar from a photo', body });
    this.updateDesktop(d => { d.avatarRequests[message.id] = { agent: agentAddress, createdAt: Date.now(), photoPath: saved.path }; });
    return message;
  }
  /** Replies to avatar requests that contain a parseable spec. */
  avatarReplies() {
    const out = [];
    for (const [requestId, info] of Object.entries(this.desktop.avatarRequests || {})) {
      for (const reply of this.mailboxMessages.filter(m => m.reply_to === requestId)) {
        const block = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply.body || '');
        if (!block) continue;
        try { out.push({ requestId, agent: info.agent, reply, spec: normalizeAvatar(JSON.parse(block[1])) }); } catch { /* not JSON */ }
      }
    }
    return out;
  }
}

export const store = new Store();
