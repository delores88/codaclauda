/* Opt-in browser-preview scenarios. No native calls or bundled user inventory.
 * ?scanMode=slow&scanDelayMs=6000 (also githubMode / manifestMode)
 * Modes: slow, reject, never. Delays are clamped to 0..30000 ms.
 * ?fixture=/local-fixtures/city.json loads an untracked, same-origin fixture:
 * { projects: [{ name, path?, remote?, repo? }], githubUser? }.
 * Known remotes seed local metadata; ?deferRemotes=1 withholds them until scan.
 * Fixture state uses its own sessionStorage entry, never ordinary mock storage. */
const SERVICES = { project_scan: 'scan', github_repos: 'github', desktop_manifest_load: 'manifest' };
const FIXTURE_COMMANDS = new Set(['desktop_state_load', 'desktop_state_save', 'desktop_manifest_load', 'project_scan', 'github_repos', 'github_user', 'desktop_discover_projects']);
const normalizePath = value => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const error = (code, message) => Object.assign(new Error(message), { code });
const repoName = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/i.test(value) ? value : '';
const remoteRepo = value => repoName(/^(?:https:\/\/github\.com\/|git@github\.com:)([^\s?#]+?)(?:\.git)?\/?$/i.exec(value)?.[1]);

export function previewOptions(search = '') {
  const query = new URLSearchParams(search), faults = {};
  for (const service of ['scan', 'github', 'manifest']) {
    const value = query.get(`${service}Mode`), rawDelay = query.get(`${service}DelayMs`);
    const parsed = rawDelay == null || rawDelay.trim() === '' ? 6000 : Number(rawDelay);
    faults[service] = {
      mode: ['slow', 'reject', 'never'].includes(value) ? value : 'normal',
      delayMs: Math.min(30000, Math.max(0, Number.isFinite(parsed) ? parsed : 6000)),
    };
  }
  return { faults, fixture: query.get('fixture') || '', deferRemotes: query.get('deferRemotes') === '1' };
}

export function fixtureURL(path, baseURL) {
  if (!/^\/local-fixtures\/(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+\.json$/i.test(path)) throw error('MOCK_FIXTURE_INVALID', 'Preview fixtures must use a /local-fixtures/*.json path.');
  let base, target;
  try { base = new URL(baseURL); target = new URL(path, base); } catch { throw error('MOCK_FIXTURE_INVALID', 'Preview fixtures need an HTTP preview origin.'); }
  if (!['http:', 'https:'].includes(base.protocol) || target.origin !== base.origin) throw error('MOCK_FIXTURE_INVALID', 'Preview fixtures must stay on the preview origin.');
  return target.href;
}

export function normalizeFixture(input) {
  if (!input || !Array.isArray(input.projects) || input.projects.length > 500) throw error('MOCK_FIXTURE_INVALID', 'A preview fixture needs at most 500 projects.');
  const projects = input.projects.map(item => {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200) throw error('MOCK_FIXTURE_INVALID', 'Each preview project needs a short name.');
    const project = { name: item.name.trim() };
    for (const field of ['path', 'remote']) {
      if (item[field] != null && (typeof item[field] !== 'string' || item[field].length > 2048 || /[\r\n\0]/.test(item[field]))) throw error('MOCK_FIXTURE_INVALID', `Invalid preview project ${field}.`);
      if (item[field]?.trim()) project[field] = item[field].trim();
    }
    if (item.repo != null && !repoName(item.repo)) throw error('MOCK_FIXTURE_INVALID', 'Preview repo identities must use owner/name.');
    if (item.repo) project.repo = item.repo;
    if (!project.path && !project.repo) throw error('MOCK_FIXTURE_INVALID', 'Each preview project needs a local path or repository identity.');
    return project;
  });
  if (input.githubUser != null && (typeof input.githubUser !== 'string' || !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(input.githubUser))) throw error('MOCK_FIXTURE_INVALID', 'Invalid preview GitHub user.');
  return { projects, githubUser: input.githubUser || 'preview-owner' };
}

export function createPreviewScenario({ search = '', baseURL, fetchImpl = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), storage = globalThis.sessionStorage, statsForPath } = {}) {
  const options = previewOptions(search);
  let pendingFixture, fixtureState;
  const loadFixture = () => pendingFixture ||= (async () => {
    const url = fixtureURL(options.fixture, baseURL);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetchImpl(url, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal });
      if (!response.ok) throw error('MOCK_FIXTURE_LOAD', 'Could not load the requested preview fixture.');
      const text = await response.text();
      if (text.length > 1024 * 1024) throw error('MOCK_FIXTURE_INVALID', 'Preview fixture exceeds 1 MiB.');
      let data;
      try { data = JSON.parse(text); } catch { throw error('MOCK_FIXTURE_INVALID', 'Preview fixture is not valid JSON.'); }
      return normalizeFixture(data);
    } catch (cause) {
      if (cause.code?.startsWith?.('MOCK_')) throw cause;
      throw error('MOCK_FIXTURE_LOAD', 'Could not load the requested preview fixture.');
    } finally { clearTimeout(timeout); }
  })();
  return {
    async run(command, args, fallback) {
      const fault = options.faults[SERVICES[command]];
      if (fault?.mode === 'never') return new Promise(() => {});
      if (fault?.mode === 'reject') throw error('MOCK_SCENARIO_REJECTED', `Preview ${SERVICES[command]} failure requested by URL.`);
      if (fault?.mode === 'slow') await sleep(fault.delayMs);
      if (!options.fixture || !FIXTURE_COMMANDS.has(command)) return fallback(args);
      const fixture = await loadFixture(), projects = fixture.projects;
      const storageName = `mock.fixture:${fixtureURL(options.fixture, baseURL)}`;
      if (command === 'desktop_state_load') {
        if (!fixtureState) {
          try { const saved = JSON.parse(storage?.getItem(storageName) || 'null'); if (saved && typeof saved === 'object' && saved.projects) fixtureState = saved; } catch { /* isolated in-memory fallback */ }
          fixtureState ||= { version: 1, projects: { local: projects.filter(p => p.path).map(p => ({ name: p.name, path: p.path, ...(!options.deferRemotes && p.remote ? { stats: { git: { remote: p.remote } } } : {}) })), github: { user: '', repos: [] }, settings: {} }, prefs: {} };
        }
        return { state: structuredClone(fixtureState) };
      }
      if (command === 'desktop_state_save') {
        fixtureState = structuredClone(args.state);
        try { storage?.setItem(storageName, JSON.stringify(fixtureState)); } catch { /* isolated in-memory fallback */ }
        return { saved_at: Math.floor(Date.now() / 1000) };
      }
      if (command === 'desktop_manifest_load') return { path: options.fixture, manifest: { schema: 'codaclauda.projects/1', github_user: fixture.githubUser, projects: projects.map(p => ({ name: p.name, ...(p.path ? { local_path: p.path } : {}), ...(p.repo ? { github: p.repo } : {}) })) } };
      if (command === 'github_user') return { login: fixture.githubUser, source: 'mock-fixture' };
      if (command === 'github_repos') {
        const repos = new Map();
        for (const project of projects) {
          const full = project.repo || remoteRepo(project.remote || '');
          if (full && !repos.has(full.toLowerCase())) repos.set(full.toLowerCase(), { name: full.split('/')[1], full_name: full, url: `https://github.com/${full}` });
        }
        return { user: args.user || fixture.githubUser, source: 'mock-fixture', repos: [...repos.values()] };
      }
      if (command === 'project_scan') {
        const project = projects.find(p => p.path && normalizePath(p.path) === normalizePath(String(args.path || '')));
        const stats = statsForPath(args.path);
        return { ...stats, name: project?.name || stats.name, git: { ...stats.git, remote: project?.remote || (project?.repo ? `https://github.com/${project.repo}.git` : '') } };
      }
      return { projects: projects.filter(p => p.path).map(p => ({ name: p.name, path: p.path, is_git: Boolean(p.remote || p.repo), markers: [] })) };
    },
  };
}
