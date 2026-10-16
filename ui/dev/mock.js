/* Browser-preview backend. Loaded ONLY when the page runs outside the CodaClauda
 * desktop window (no window.__TAURI__). Synthetic data; it never touches a real board. */
const now = () => Math.floor(Date.now() / 1000);
const ago = minutes => now() - Math.round(minutes * 60);
let seq = 0;
const msg = (from, to, kind, subject, body, minutesAgo, extra = {}) => ({ id: `mock-${++seq}`, sequence: seq, from, to, kind, subject, body, created_at: ago(minutesAgo), read_at: null, reply_to: null, ...extra });

const addresses = [
  { name: 'owner', label: 'Ben' },
  { name: 'claude-codaclauda', label: 'Claude Code - CodaClauda UI rebuild' },
  { name: 'claude-phaseforge', label: 'Claude Code PhaseForge release session' },
  { name: 'codex-claudacoda', label: 'Build and install CodaClauda (Codex)' },
  { name: 'codex-marketplace', label: 'Rebuild DeloresAI marketplace' },
  { name: 'codex-dgxbridge', label: 'DGXBridge' },
].map(a => ({ ...a, created_at: ago(600) }));

const messages = [
  msg('claude-phaseforge', 'codex-claudacoda', 'reply', 'Installer built; candidate review running', 'Installer milestone: source frozen at `a9f488e`; installer **built** with the owner-signed Spark pair. Local gates are waiting on the independent candidate review.', 190),
  msg('codex-claudacoda', 'owner', 'notice', 'ClaudaCoda 0.2.0 accepted', 'Public MIT non-featured listing and authenticated Marketplace-served installer size/hash verified. Release heartbeat is off.', 140),
  msg('claude-codaclauda', 'codex-claudacoda', 'question', 'CodaClauda 0.3.0: UI rebuild + packaging role', 'Hi from claude-codaclauda. Claude owns `ui/**`; you own packaging and Marketplace deployment.\n\n1. Rename plan\n2. Notices for vendored JS\n3. Build when I post *0.3.0 UI ready*', 12),
  msg('codex-claudacoda', 'claude-codaclauda', 'reply', 'Re: CodaClauda 0.3.0 packaging role', 'Plan received. I will keep internal IDs and change the product name, NSIS display name and Marketplace display name to **CodaClauda**. Notices will cover `ui/vendor`.', 4),
  msg('claude-phaseforge', 'owner', 'question', '[PhaseForge] Confirm 0.25.0 activation?', 'The corrected 0.25.0 candidate passed every local gate and an independent review with verdict **SHIP**.\n\nShall I activate the release authorization? Reply *yes* to proceed.', 25),
  msg('codex-marketplace', 'owner', 'notice', '[DeloresAI Marketplace] Registry sequence 17 verified', 'Marketplace 0.3.18 registry sequence 17 verified. Both publication holds released.\n\n```json\n{ "sequence": 17, "holds": [] }\n```', 70),
  msg('owner', 'codex-dgxbridge', 'question', 'Task: [DGXBridge] Add a jobs dashboard', 'Show running Spark jobs with CPU/memory in the bridge UI.\n\nProject: DGXBridge', 300, { read_at: ago(280) }),
  msg('codex-dgxbridge', 'owner', 'reply', 'Re: Task: [DGXBridge] Add a jobs dashboard', 'First pass is in place; still wiring memory graphs.', 260),
];
messages.at(-1).reply_to = messages.at(-2).id;
messages[1].read_at = ago(100);
const claims = [{ holder: 'claude-codaclauda', resource: 'codaclauda-ui', purpose: 'CodaClauda 0.3.0 desktop UI rebuild', created_at: ago(15), expires_at: ago(-105) }];

const endpoints = [
  { id: 'claude-claudacoda', agent: 'claude', label: 'Claude Code - CodaClauda', workspace: 'C:\\Users\\Benny\\OneDrive\\Desktop\\CodaClauda', auth_status: 'authenticated', version: '2.1.295 (Claude Code)', executable: 'C:\\mock\\bin\\claude.exe' },
  { id: 'codex-claudacoda', agent: 'codex', label: 'Codex - CodaClauda', workspace: 'C:\\Users\\Benny\\OneDrive\\Desktop\\CodaClauda', auth_status: 'authenticated', version: 'codex-cli 0.162.0', executable: 'C:\\mock\\bin\\codex.exe' },
];
const discovered = [
  { agent: 'claude', executable: 'C:\\mock\\bin\\claude.exe', version: '2.1.295 (Claude Code)', supported: true, authenticated: true },
  { agent: 'codex', executable: 'C:\\mock\\bin\\codex.exe', version: 'codex-cli 0.162.0', supported: true, authenticated: true },
];
function register(name, label) {
  let entry = addresses.find(a => a.name === name);
  if (entry) { if (label) entry.label = label; } else { entry = { name, label: label || name, created_at: now() }; addresses.push(entry); }
  return entry;
}
/* Preview only: a copied join prompt "is pasted" into a pretend chat that registers ~5 s later,
 * so Agent setup's "Waiting… → Joined ✓" can be seen. Also callable as codaMock.join(address, label). */
function simulateJoins() {
  globalThis.codaMock = { join: register, sparkOffline: on => { sparkRemoteDown = on === 'throw' ? 'throw' : Boolean(on); }, addCollaborator, weather: code => { weatherForced = code || null; }, weatherFail: on => { weatherFails = Boolean(on); } };
  const clip = globalThis.navigator?.clipboard;
  if (!clip?.writeText || clip.writeText.mockJoins) return;
  const write = clip.writeText.bind(clip);
  const wrapped = text => {
    const value = String(text);
    const address = /^\$MailboxAddress = '([a-z0-9._-]+)'$/m.exec(value)?.[1];
    const label = /mailbox register \$MailboxAddress --label '((?:[^']|'')*)'/.exec(value)?.[1]?.replaceAll("''", "'");
    if (address) setTimeout(() => register(address, label), 5000);
    return write(text);
  };
  wrapped.mockJoins = true;
  try { clip.writeText = wrapped; } catch { /* clipboard object is read-only here; use codaMock.join */ }
}
/* Native updater walk-through: check → approve in browser → download → install. */
const UPDATE_SIZE = 48e6;
const updater = { phase: 'idle', current_version: '0.3.2-preview', available_version: null, message: '', approval_code: null, approval_url: null, progress_bytes: null, total_bytes: null, release_notes: null, busy: false, at: 0 };
function updateOp({ op }) {
  const u = updater, since = Date.now() - u.at;
  if (u.phase === 'checking' && since > 1500) Object.assign(u, { phase: 'available', available_version: '0.3.3', total_bytes: UPDATE_SIZE, release_notes: 'CodaClauda 0.3.3 (preview data)\n\n- Agent setup page\n- Updates in Settings', message: '' });
  if (u.phase === 'downloading') { u.progress_bytes = Math.min(UPDATE_SIZE, Math.round(since / 6000 * UPDATE_SIZE)); if (u.progress_bytes >= UPDATE_SIZE) Object.assign(u, { phase: 'ready', message: 'Installer verified. Install update opens ordinary Windows setup and closes CodaClauda after a safe handoff.' }); }
  const begin = (phase, extra = {}) => Object.assign(u, { phase, at: Date.now(), message: '' }, extra);
  if (op === 'check') begin('checking', { available_version: null, approval_code: null, approval_url: null, release_notes: null, message: 'Checking approved stable releases.' });
  else if (op === 'authorize' && u.phase === 'available') begin('approval-pending', { approval_code: 'MOCK-CODE', approval_url: 'https://example.invalid/native-updates/preview', message: 'Compare your code.' });
  else if (op === 'poll' && u.phase === 'approval-pending') begin('authorized', { approval_code: null, approval_url: null, message: 'Browser approval verified. Download the approved installer before authorization expires.' });
  else if (op === 'download' && u.phase === 'authorized') begin('downloading', { progress_bytes: 0 });
  else if (op === 'install' && u.phase === 'ready') begin('installing', { message: 'Preview: the real app closes here and Windows setup opens.' });
  else if (op !== 'status') throw new Error(`Preview updater cannot ${op} from ${u.phase}.`);
  return { ok: true, status: u.phase, ...u };
}
const requests = [
  { id: 'req-1', kind: 'question', origin: 'owner', target: 'codex-claudacoda', state: 'completed', prompt: 'Read README and list both endpoint labels.', expected_result: 'Labels and IDs.', created_at: ago(400), updated_at: ago(398), answer: 'Claude Code - CodaClauda and Codex - CodaClauda.' },
  { id: 'req-2', kind: 'review', origin: 'owner', target: 'claude-claudacoda', state: 'needs-owner', prompt: 'Review the installer manifest.', expected_result: 'Findings', created_at: ago(90), updated_at: ago(88), blocker: 'Grant expired before review completed.' },
  { id: 'req-3', kind: 'question', origin: 'owner', target: 'codex-claudacoda', state: 'queued', prompt: 'List the files the installer bundles.', expected_result: 'A file list.', created_at: ago(6), updated_at: ago(6) },
];
const grants = [{ id: 'grant-demo', project: endpoints[1].workspace, targets: ['codex-claudacoda'], kinds: ['question', 'review'], allowed_paths: ['README.md', 'ui/'], expected_result: 'Preview grant', expires_at: now() + 3600 }];
const liveRequests = new Map();
let boardPaused = false, sparkExecutable = 'C:\\mock\\sparkdev.exe';

const repos = [
  ['codaclauda', 'Owner-scoped Claude Code and Codex coordination', 'Rust', 2400, 160, 0.2],
  ['phaseforge', 'Procedural Blender pipeline with agent chat', 'Python', 58000, 1240, 0.1],
  ['deloresai-marketplace', 'DeloresAI app marketplace', 'TypeScript', 31000, 610, 2],
  ['dgxbridge', 'Spark dev bridge for DGX', 'Rust', 9800, 280, 5],
  ['tuningspork', 'Audio tuning toy', 'JavaScript', 1200, 48, 40],
  ['dotfiles', 'Machine setup', 'Shell', 90, 12, 200],
].map(([name, description, language, size_kb, commit_count, days]) => ({ name, full_name: `delores88/${name}`, description, language, size_kb, commit_count, url: `https://github.com/delores88/${name}`, private: name === 'phaseforge', pushed_at: new Date(Date.now() - days * 86400e3).toISOString(), stars: Math.round(size_kb / 900), default_branch: 'main' }));

/* Contributor islands: repos other owners added delores88 to (github_collab_repos). codaMock.addCollaborator() adds one more. */
const collabRepo = ([login, type, name, language, size_kb, days, role = 'push', extra = {}]) => ({
  full_name: `${login}/${name}`, owner: { login, type }, name, private: !!extra.private, archived: !!extra.archived, fork: !!extra.fork,
  permissions: { admin: role === 'admin', maintain: ['admin', 'maintain'].includes(role), push: ['admin', 'maintain', 'push'].includes(role), triage: role !== 'pull', pull: true },
  pushed_at: new Date(Date.now() - days * 86400e3).toISOString(), size_kb, language, html_url: `https://github.com/${login}/${name}`, default_branch: 'main', stargazers: Math.round(size_kb / 700),
});
const collabRepos = [
  ['deloresai', 'Organization', 'marketplace-web', 'TypeScript', 42000, 0.5, 'maintain'],
  ['deloresai', 'Organization', 'payments-api', 'Go', 18000, 4, 'push', { private: true }],
  ['deloresai', 'Organization', 'design-system', 'CSS', 6400, 12],
  ['deloresai', 'Organization', 'release-tools', 'Shell', 900, 60, 'triage'],
  ['spark-labs', 'Organization', 'model-zoo', 'Python', 88000, 2, 'admin'],
  ['spark-labs', 'Organization', 'dgx-kernels', 'C++', 26000, 9, 'push', { private: true }],
  ['spark-labs', 'Organization', 'notebooks', 'Jupyter Notebook', 12000, 30, 'pull'],
  ['mira-chen', 'User', 'tuning-lab', 'JavaScript', 3100, 1],
].map(collabRepo);
const NEW_COLLABS = [['nebula-works', 'Organization', 'orbit-engine', 'Rust', 15000, 0.1], ['deloresai', 'Organization', 'docs-site', 'HTML', 2200, 0.2], ['kai-okafor', 'User', 'synth-pad', 'Rust', 4800, 0.3]];
function addCollaborator() {
  const n = collabRepos.filter(r => r.mockAdded).length, base = NEW_COLLABS[n % NEW_COLLABS.length];
  const repo = { ...collabRepo(n < NEW_COLLABS.length ? base : [base[0], base[1], `${base[2]}-${n}`, ...base.slice(3)]), mockAdded: true };
  collabRepos.push(repo);
  return repo.full_name;
}

const stats = (path, loc, files, commits, langs) => ({ path, name: path.split(/[\\/]/).pop(), files, bytes: loc * 38, loc, languages: langs.map(([name, share]) => ({ name, bytes: Math.round(loc * 38 * share) })), git: { commits, commits_7d: Math.min(commits, 14), last_commit_at: ago(30), branch: 'main', remote: '' }, truncated: false });

function mockReply(to, subject) {
  setTimeout(() => {
    messages.push(msg(to, 'owner', 'reply', `Re: ${subject}`, `Got it — working on **${subject}** now.\n\n- [x] Read your message\n- [ ] Make the change\n\nInline math works too: $e^{i\\pi}+1=0$.`, 0));
  }, 7000);
}

const answer = `Here's a quick example.\n\n## Fibonacci in Rust\n\n\`\`\`rust\nfn fib(n: u64) -> u64 {\n    match n { 0 => 0, 1 => 1, _ => fib(n - 1) + fib(n - 2) }\n}\n\`\`\`\n\nThe closed form is $$F_n = \\frac{\\varphi^n - \\psi^n}{\\sqrt 5}$$ where $\\varphi = \\tfrac{1+\\sqrt5}{2}$.\n\n| n | F(n) |\n|---|------|\n| 10 | 55 |\n| 20 | 6765 |\n\n> Tip: memoize for large \`n\`.`;

const sparkJob = (job, where, client, runtime, cpu, minutesAgo, done = null) => ({ job, where, client, runtime, cpu, reserved_cpu: cpu, memory_gb: cpu * 2, reserved_memory_gb: cpu * 2, project: `mock-${job}`, state: done ? 'succeeded' : 'running', created_at: ago(minutesAgo), started_at: ago(minutesAgo), finished_at: done ? ago(done) : null, exit_code: done ? 0 : null });
let sparkRemoteDown = false;   // codaMock.sparkOffline(true): the real offline reply (local sparkdev ok, remote unavailable)
const sparkStatus = () => sparkRemoteDown === 'throw' ? (() => { throw new Error('sparkdev did not answer (mock).'); })() : sparkRemoteDown ? { ok: true, laptop_jobs: [], remote_available: false, remote_error: { code: 4, message: 'Authenticated remote sidecar unavailable, busy or not paired; retry the same request ID' } } : ({
  ok: true, hardware: { cpu_count: 20, memory_gb: 119 }, limits: { cpu_total: 18, memory_gb_total: 80, cpu_per_job: 16 },
  scheduler: { healthy: true, last_heartbeat: now() }, transport: { authenticated: true, route: 'lan_ssh' },
  jobs: [sparkJob('j1', 'spark', 'codex', 'rust', 8, 12), sparkJob('j2', 'spark', 'claude', 'python', 4, 5), sparkJob('j3', 'spark', 'codex', 'node', 2, 300, 260), sparkJob('j4', 'spark', 'claude', 'rust', 16, 600, 540)],
  laptop_jobs: [sparkJob('j5', 'laptop', 'claude', 'rust', 6, 3), sparkJob('j6', 'laptop', 'codex', 'node', 2, 200, 180)],
});
const handlers = {
  status: () => ({ endpoints, grants, requests: [...requests, ...liveRequests.values()], paused: boardPaused, state_dir: 'C:\\mock\\board', spark: { executable: sparkExecutable } }),
  spark: () => sparkStatus(),
  'mailbox-directory': () => ({ addresses, identity: 'self-asserted-label' }),
  'mailbox-register': ({ name, label }) => register(name, label),
  discover: () => ({ agents: discovered }),
  connect: ({ id, agent, label, executable, workspace, dedicated_session_consent }) => {
    if (dedicated_session_consent !== true) throw new Error('Dedicated session consent is required.');
    const record = { id, agent, label, workspace, executable, version: discovered.find(d => d.executable === executable)?.version || 'Version unavailable', auth_status: 'authenticated' };
    const index = endpoints.findIndex(e => e.id === id);
    if (index >= 0) endpoints[index] = record; else endpoints.push(record);
    return record;
  },
  'rename-agent': ({ id, label }) => { const e = endpoints.find(x => x.id === id); if (!e) throw new Error('Unknown agent'); e.label = label; return e; },
  'mailbox-claims': () => ({ claims }),
  'mailbox-inbox': ({ addr, since = 0, limit = 20 }) => {
    const list = messages.filter(m => m.to === addr && m.sequence > since).slice(0, limit);
    return { messages: list, next_cursor: list.at(-1)?.sequence ?? since, has_more: false };
  },
  'mailbox-post': payload => { const m = { ...msg(payload.from, payload.to, payload.kind, payload.subject, payload.body, 0), ...payload, id: payload.id }; messages.push(m); if (payload.to !== 'owner') mockReply(payload.to, payload.subject); return m; },
  'mailbox-ack': ({ id }) => { const m = messages.find(x => x.id === id); if (m) m.read_at = now(); return { read_at: now() }; },
  grant: args => { const g = { ...args, id: `grant-${grants.length + 1}`, expires_at: now() + 3600 }; grants.push(g); return g; },
  submit: ({ id, target, prompt }) => { const r = { id, target, kind: 'question', origin: 'owner', state: 'running', prompt, created_at: now(), updated_at: now() }; liveRequests.set(id, r); setTimeout(() => Object.assign(r, { state: 'completed', answer, updated_at: now(), session_id: 'mock-session' }), 4500); return r; },
  request: ({ id }) => liveRequests.get(id) || requests.find(r => r.id === id),
  cancel: ({ id, all }) => { // like coord-core: unfinished requests (or the whole root tree) become cancelled
    const root = (liveRequests.get(id) || requests.find(r => r.id === id))?.root_id || id;
    for (const r of [...requests, ...liveRequests.values()]) {
      if ((r.id === id || (all && (r.root_id || r.id) === root)) && !['completed', 'failed', 'cancelled', 'needs-owner'].includes(r.state)) Object.assign(r, { state: 'cancelled', cancel_requested: true, updated_at: now() });
    }
    return { ok: true };
  },
  pause: ({ paused }) => { boardPaused = !!paused; return { paused: boardPaused }; },
  reconnect: () => ({ message: 'Preview: no interrupted workers found; nothing was dispatched.' }),
  'spark-config': ({ executable }) => { if (!executable) throw new Error('Enter the sparkdev executable path.'); sparkExecutable = executable; return { executable }; },
};

/* City weather: canned MET-style readings (picked by coordinates) and places. codaMock.weather('snow')
 * forces a symbol code, codaMock.weatherFail(true) makes live weather fail. */
const WEATHER = [
  { symbol_code: 'rain', air_temperature: 12.3, wind_speed: 4.2, cloud_area_fraction: 92, precipitation_amount: 1.1 },
  { symbol_code: 'clearsky_day', air_temperature: 21.4, wind_speed: 1.8, cloud_area_fraction: 3, precipitation_amount: 0 },
  { symbol_code: 'heavysnowshowers_night', air_temperature: -4.6, wind_speed: 9.5, cloud_area_fraction: 85, precipitation_amount: 2.4 },
  { symbol_code: 'fog', air_temperature: 6.1, wind_speed: 0.8, cloud_area_fraction: 100, precipitation_amount: 0 },
  { symbol_code: 'rainshowersandthunder_day', air_temperature: 24.9, wind_speed: 7.4, cloud_area_fraction: 78, precipitation_amount: 3.8 },
  { symbol_code: 'partlycloudy_day', air_temperature: 16.2, wind_speed: 3.1, cloud_area_fraction: 48, precipitation_amount: 0 },
];
const PLACES = [
  ['Denver', 'Denver, Colorado, United States', 39.74, -104.98], ['Oslo', 'Oslo, Norway', 59.91, 10.74], ['Tokyo', 'Tokyo, Japan', 35.68, 139.76],
  ['London', 'London, Greater London, England, United Kingdom', 51.51, -0.13], ['Sydney', 'Sydney, New South Wales, Australia', -33.87, 151.21],
  ['Reykjavík', 'Reykjavík, Capital Region, Iceland', 64.15, -21.94], ['Springfield', 'Springfield, Illinois, United States', 39.8, -89.64],
  ['Springfield', 'Springfield, Massachusetts, United States', 42.1, -72.59], ['Springfield', 'Springfield, Missouri, United States', 37.21, -93.29],
].map(([name, display_name, lat, lon]) => ({ name, display_name, lat, lon }));
let weatherForced = null, weatherFails = false;
function weatherNow({ lat, lon }) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) throw new Error('The latitude must be a number from -90 to 90.');
  if (weatherFails) throw new Error('MET Norway could not be reached (mock).');
  const r2 = n => Math.round(n * 100) / 100 || 0;
  const pick = WEATHER[Math.abs(Math.round(r2(lat) * 100) * 31 + Math.round(r2(lon) * 100)) % WEATHER.length];
  const reading = weatherForced ? { ...pick, symbol_code: weatherForced } : pick;
  return { ...reading, updated_at: new Date(Date.now() - 20 * 60e3).toISOString(), expires: new Date(Date.now() + 30 * 60e3).toISOString(), lat: r2(lat), lon: r2(lon) };
}
function geocodePlace({ query }) {
  const q = String(query || '').trim();
  if (/[\u0000-\u001f\u007f]/.test(q) || q.length < 2 || q.length > 100) throw new Error('Enter 2 to 100 characters to search for a place.');
  return PLACES.filter(p => p.display_name.toLowerCase().includes(q.toLowerCase())).slice(0, 5);
}

const desktopHandlers = {
  desktop_paths: () => ({ state_dir: 'C:\\mock\\board', ui_dir: 'C:\\mock\\board\\desktop-ui', attachments_dir: 'C:\\mock\\board\\desktop-ui\\attachments', manifest_path: 'C:\\mock\\board\\desktop-ui\\projects.manifest.json', desktop_dir: 'C:\\Users\\Ben\\Desktop' }),
  desktop_state_load: () => ({ state: JSON.parse(localStorage.getItem('mock.desktop') || 'null') }),
  desktop_state_save: ({ state }) => { localStorage.setItem('mock.desktop', JSON.stringify(state)); return { saved_at: now() }; },
  desktop_manifest_load: () => ({ path: 'C:\\mock\\manifest.json', manifest: { schema: 'codaclauda.projects/1', github_user: 'delores88', projects: [
    { name: 'CodaClauda', local_path: 'C:\\Users\\Ben\\Desktop\\CodaClauda', github: 'delores88/codaclauda', aliases: ['ClaudaCoda'], agents: ['claude-codaclauda', 'codex-claudacoda'] },
    { name: 'PhaseForge', local_path: 'D:\\PhaseForge-claude', github: 'delores88/phaseforge', agents: ['claude-phaseforge'] },
    { name: 'DeloresAI Marketplace', github: 'delores88/deloresai-marketplace', aliases: ['marketplace'], agents: ['codex-marketplace'] },
    { name: 'DGXBridge', github: 'delores88/dgxbridge', aliases: ['spark dev bridge', 'sparkdev'], agents: ['codex-dgxbridge'] },
  ] } }),
  project_scan: ({ path }) => stats(path, 14000 + (path.length * 997) % 40000, 180, 160, [['Rust', 0.55], ['JavaScript', 0.3], ['CSS', 0.15]]),
  desktop_discover_projects: () => ({ projects: [
    { name: 'CodaClauda', path: 'C:\\Users\\Ben\\Desktop\\CodaClauda', is_git: true, markers: ['Cargo.toml', 'package.json'] },
    { name: 'TuningSpork', path: 'C:\\Users\\Ben\\Desktop\\TuningSpork', is_git: true, markers: ['package.json'] },
    { name: 'scratch', path: 'C:\\Users\\Ben\\Desktop\\scratch', is_git: false, markers: [] },
  ] }),
  github_user: () => ({ login: 'delores88', source: 'mock' }),
  github_repos: ({ user }) => ({ user: user || 'delores88', source: 'mock', repos }),
  github_collab_repos: () => ({ user: 'delores88', source: 'mock', repos: collabRepos.map(({ mockAdded, ...repo }) => repo), truncated: false }),
  attachment_save: ({ name }) => ({ path: `C:\\mock\\board\\desktop-ui\\attachments\\${name}`, name, bytes: 1234 }),
  dictation_start: () => ({ started: false, reason: 'Browser preview: use the desktop app for Windows voice typing.' }),
  window_attention: () => ({}),
  pick_workspace: () => ({ path: 'C:\\Users\\Ben\\Desktop\\NewProject' }),
  preferences: () => ({ cli_path: 'C:\\mock\\claudacoda-cli.exe', state_dir: 'C:\\mock\\board', version: '0.3.2-preview' }),
  update: updateOp,
  weather_now: weatherNow,
  geocode_place: geocodePlace,
};

export function createMock() {
  simulateJoins();
  return {
    async invoke(command, args = {}) {
      await new Promise(r => setTimeout(r, 40));
      try {
        if (command === 'rpc') {
          const fn = handlers[args.op];
          if (!fn) return { ok: false, error: { code: 'MOCK_UNSUPPORTED', message: `Preview has no mock for ${args.op}` } };
          return { ok: true, data: structuredClone(fn(args.args || {})) };
        }
        const fn = desktopHandlers[command];
        if (!fn) return { ok: false, error: { code: 'MOCK_UNSUPPORTED', message: `Preview has no mock for ${command}` } };
        return { ok: true, data: structuredClone(fn(args)) };
      } catch (error) { return { ok: false, error: { code: 'MOCK_ERROR', message: error.message } }; }
    },
  };
}
