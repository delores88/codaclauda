/* Browser-preview backend. Loaded ONLY when the page runs outside the CodaClauda
 * desktop window (no window.__TAURI__). Synthetic data; it never touches a real board. */
import { createPreviewScenario } from './mock-scenarios.js';
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
  globalThis.codaMock = { join: register, teamStart: projectId => mockTeamStart(projectId), usageHold: (id, text) => mockUsageHold(id, text), usageStop: id => mockUsageStop(id), sparkOffline: on => { sparkRemoteDown = on === 'throw' ? 'throw' : Boolean(on); }, addCollaborator, weather: code => { weatherForced = code || null; }, weatherFail: on => { weatherFails = Boolean(on); } };
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
  { id: 'req-3', kind: 'question', origin: 'owner', target: 'codex-claudacoda', state: 'queued', prompt: 'List the files the installer bundles.', expected_result: 'A file list.', created_at: ago(6), updated_at: ago(6), queued_reason: 'endpoint codex-claudacoda busy with request req-live' },
];
// grant-demo is a 0.4 grant (no policy_version): its effective limits include the implicit 0.4 ones.
const grants = [{ id: 'grant-demo', project: endpoints[1].workspace, targets: ['codex-claudacoda'], kinds: ['question', 'review'], allowed_paths: ['README.md', 'ui/'], expected_result: 'Preview grant', expires_at: now() + 3600, revoked_at: null,
  max_requests: 16, max_delegations: 0, max_hops: 1, timeout_seconds: 600,
  effective: { max_requests: 16, max_delegations: 0, max_hops: 1, timeout_seconds: 600, max_turns: 12, max_mcp_calls: 128, max_compute_jobs: 2, expires_seconds: 3600 } }];
const liveRequests = new Map();
let boardPaused = false, sparkExecutable = 'C:\\mock\\sparkdev.exe';
/* Owner policy (C2): defaults when the board has no policy.json. */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const BUDGET_MIN = { timeout_seconds: 10, expires_seconds: 30, max_requests: 1, max_delegations: 0, max_hops: 0, max_turns: 1, max_mcp_calls: 1, max_compute_jobs: 0 };
const policy = { concurrent: 'unlimited', grant_defaults: { timeout_seconds: 86400, expires_seconds: 604800, max_requests: 'unlimited', max_delegations: 'unlimited', max_hops: 'unlimited', max_turns: 'unlimited', max_mcp_calls: 'unlimited', max_compute_jobs: 'unlimited' } };
/** Like coord-core: a whole number from the minimum, "unlimited" (expires_seconds also "never"); null/omitted only where inherit is allowed. */
function budget(field, value, min) {
  if (value === 'unlimited' || (field === 'expires_seconds' && value === 'never')) return 'unlimited';
  if (Number.isSafeInteger(value) && value >= min && value <= MAX_SAFE) return value;
  throw coded('INVALID_ARGUMENTS', `${field} must be a whole number from ${min} to ${MAX_SAFE}, or "unlimited"`);
}
function grantFrom(args) {
  const resolved = {};
  for (const [field, min] of Object.entries(BUDGET_MIN)) resolved[field] = args[field] == null ? policy.grant_defaults[field] : budget(field, args[field], min);
  const at = now();
  const g = { ...args, ...resolved, id: `grant-${grants.length + 1}`, policy_version: 1, revoked_at: null,
    expires_at: resolved.expires_seconds === 'unlimited' ? 'never' : at + resolved.expires_seconds, effective: { ...resolved } };
  grants.push(g);
  return g;
}
function boardLoad() {
  const all = [...requests, ...liveRequests.values()];
  return { concurrent: policy.concurrent, active: all.filter(r => ['delivered', 'acknowledged', 'running'].includes(r.state)).length, waiting: 0, queued: all.filter(r => r.state === 'queued').length };
}

const repos = [
  ['codaclauda', 'Owner-scoped Claude Code and Codex coordination', 'Rust', 2400, 160, 0.2],
  ['phaseforge', 'Procedural Blender pipeline with agent chat', 'Python', 58000, 1240, 0.1],
  ['deloresai-marketplace', 'DeloresAI app marketplace', 'TypeScript', 31000, 610, 2],
  ['dgxbridge', 'Spark dev bridge for DGX', 'Rust', 9800, 280, 5],
  ['tuningspork', 'Audio tuning toy', 'JavaScript', 1200, 48, 40],
  ['dotfiles', 'Machine setup', 'Shell', 90, 12, 200],
].map(([name, description, language, size_kb, commit_count, days]) => ({ name, full_name: `delores88/${name}`, description, language, size_kb, commit_count, url: `https://github.com/delores88/${name}`, private: name === 'phaseforge', pushed_at: new Date(Date.now() - days * 86400e3).toISOString(), stars: Math.round(size_kb / 900), default_branch: 'main' }));

/* A second GitHub account signed into the mock GitHub CLI (multi-account preview). */
const workRepos = [
  ['ledger-api', 'Billing and invoices service', 'Go', 7200, 340, 1],
  ['ops-dashboard', 'Fleet health dashboard', 'TypeScript', 5400, 220, 3],
  ['ml-pipelines', 'Training and eval pipelines', 'Python', 21000, 510, 6],
  ['brand-site', 'Marketing site', 'Astro', 1800, 90, 12],
].map(([name, description, language, size_kb, commit_count, days]) => ({ name, full_name: `deloresai-work/${name}`, description, language, size_kb, commit_count, url: `https://github.com/deloresai-work/${name}`, private: name !== 'brand-site', pushed_at: new Date(Date.now() - days * 86400e3).toISOString(), stars: 0, default_branch: 'main' }));

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

const TEAM_INBOX = 'codaclauda-team';
/** Like coord-core's reply_kind: a one-key JSON body queued / admitted (0.6.0: received) is an acknowledgement. */
function replyKind(message) {
  try {
    const body = JSON.parse(message.body);
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
    return keys.length === 1 && ['queued', 'admitted', 'received'].includes(keys[0]) ? 'acknowledgement' : 'terminal';
  } catch { return 'terminal'; }
}
/** Like heartbeat.rs + mailbox.rs: the durable receipt, the preview app's host lease (always available here),
 *  who reads the address, and for a start request its queued state. */
function mockDelivery(m) {
  const team = m.to === TEAM_INBOX;
  const session = (sessionStore?.sessions || []).some(s => s.wake && s.mailboxAddress === m.to);
  const reader = team ? 'app' : session ? 'session' : 'agent';
  const delivery = { receipt: 'saved', board: 'C:\\mock\\board', host: 'available', hostDetail: null, installation: 'preview-installation', reader,
    pickupSeconds: reader === 'agent' ? null : team ? 5 : 10,
    note: reader === 'agent' ? `${m.to} reads its inbox when it next checks. Saved is not read; a message is information, not authority.`
      : `CodaClauda is running on this board and reads ${m.to} every ${team ? 5 : 10} s (preview).` };
  if (team) {
    let body = null;
    try { body = JSON.parse(m.body); } catch { /* not JSON */ }
    if (body?.start && typeof body.start === 'object') {
      delivery.request = m.kind === 'question'
        ? { state: 'queued', requestId: m.id, cancel: `To cancel it before a teammate launches, post --kind notice to ${TEAM_INBOX} with body {"cancel":{"requestId":"${m.id}"}} and a new --id. Ben can cancel it in Settings > Team.`, note: 'Nothing has started yet. Replies follow: queued, then admitted once a teammate actually launches, then the outcome.' }
        : { state: 'passive', note: 'A notice never starts a teammate. Post the same body with --kind question to ask for one.' };
    } else if (typeof body?.cancel?.requestId === 'string') delivery.request = { state: 'cancel-requested', requestId: body.cancel.requestId };
  }
  return delivery;
}

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
  status: () => ({ endpoints, grants, requests: [...requests, ...liveRequests.values()], paused: boardPaused, state_dir: 'C:\\mock\\board', spark: { executable: sparkExecutable }, limits: boardLoad() }),
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
  'mailbox-post': payload => {
    const m = { ...msg(payload.from, payload.to, payload.kind, payload.subject, payload.body, 0), ...payload, id: payload.id || `mock-${seq}` };
    messages.push(m);
    if (payload.to !== 'owner' && payload.to !== TEAM_INBOX) mockReply(payload.to, payload.subject);
    return { ...m, delivery: mockDelivery(m) };
  },
  /* Like coord-core: the first reply of any kind, or with terminal the first that is not an acknowledgement
   * (queued / admitted) plus the latest acknowledgement. The preview never waits. */
  'mailbox-wait-reply': ({ id, terminal = false }) => {
    if (!messages.some(m => m.id === id)) throw new Error('Original mailbox message is unavailable');
    if (typeof terminal !== 'boolean') throw new Error('terminal must be boolean');
    const replies = messages.filter(m => m.reply_to === id).sort((a, b) => a.sequence - b.sequence);
    const reply = (terminal ? replies.find(m => replyKind(m) === 'terminal') : replies[0]) || null;
    const out = { timed_out: !reply, reply_kind: reply ? replyKind(reply) : null, reply };
    if (terminal) out.acknowledgement = [...replies].reverse().find(m => replyKind(m) === 'acknowledgement') || null;
    return out;
  },
  'mailbox-ack': ({ id }) => { const m = messages.find(x => x.id === id); if (m) m.read_at = now(); return { read_at: now() }; },
  grant: args => grantFrom(args),
  'grant-revoke': ({ id }) => { // like coord-core: idempotent, ends the grant now (old readers see expiry too)
    const g = grants.find(x => x.id === id);
    if (!g) throw new Error('Owner grant not found');
    g.revoked_at ??= now(); g.expires_at = g.expires_at === 'never' ? now() : Math.min(g.expires_at, now());
    return g;
  },
  policy: () => structuredClone(policy),
  'policy-set': ({ concurrent, grant_defaults: defaults } = {}) => {
    const next = structuredClone(policy);
    if (concurrent !== undefined) next.concurrent = budget('concurrent', concurrent, 1);
    for (const [field, value] of Object.entries(defaults || {})) {
      if (!(field in BUDGET_MIN)) throw coded('INVALID_ARGUMENTS', `Unknown grant default ${field}`);
      next.grant_defaults[field] = budget(field, value, BUDGET_MIN[field]);
    }
    Object.assign(policy, next);
    return structuredClone(policy);
  },
  // Round 1 aliases of policy.concurrent.
  limits: () => ({ concurrent: policy.concurrent }),
  'limits-set': ({ concurrent }) => { policy.concurrent = budget('concurrent', concurrent, 1); return { concurrent: policy.concurrent }; },
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

/* 0.4 agent sessions: an echo agent that streams fake deltas over 'session://event'. Sessions and
 * their display logs persist in localStorage (mock.sessions), so a reload shows resume-after-restart.
 * 0.4.1: a busy session queues sends (up to 50, kind 'queued'); wake-enabled sessions get a fake
 * board message every 30 s (kind 'wake', then a wake turn); schedules "run" into a dedicated session. */
const SESSIONS_KEY = 'mock.sessions';
const SCHEDULES_KEY = 'mock.schedules';
const QUEUE_MAX = 50;
const emptyUsage = () => ({ input: 0, output: 0, cached: 0, costUsd: null, contextPct: null });
/** Like the engine's error codes (bridge.js puts .code on the thrown Error). */
const coded = (code, message) => Object.assign(new Error(message), { code });
const sessionListeners = new Set();
const scheduleListeners = new Set();
const sessionTurns = new Map(); // id → { timers, turnId, origin }
const sessionQueues = new Map(); // id → [{ turnId, text, attachments, origin }]
const hex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
let sessionStore = null;
function sessions() {
  if (sessionStore) return sessionStore;
  try { sessionStore = JSON.parse(localStorage.getItem(SESSIONS_KEY) || 'null'); } catch { sessionStore = null; }
  sessionStore ||= { sessions: [], logs: {} };
  sessionStore.wakeEnabled ??= true;
  for (const s of sessionStore.sessions) {
    if (s.status === 'running') s.status = 'idle'; // the "app" restarted mid-reply
    s.wake ??= false; s.mailboxAddress ??= null; s.wakes ??= { hour: 0, day: 0, total: 0 };
    s.worktreePath ??= null; s.branch ??= null; s.usage ??= emptyUsage();
  }
  return sessionStore;
}
const saveSessions = () => { try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions())); } catch { /* preview only */ } };
function sessionEmit(payload, persist = !['delta', 'status', 'queued'].includes(payload.kind)) {
  const event = { turnId: null, at: Date.now(), ...payload };
  if (persist) { (sessions().logs[event.id] ||= []).push(event); saveSessions(); }
  for (const cb of sessionListeners) { try { cb(structuredClone(event)); } catch (error) { console.error(error); } }
}
function findSession(id) {
  const session = sessions().sessions.find(s => s.id === id);
  if (!session) throw new Error('That chat no longer exists.');
  return session;
}
function sessionStatus(session, status) {
  Object.assign(session, { status, lastActivityAt: Date.now() });
  saveSessions();
  sessionEmit({ id: session.id, kind: 'status', status });
}
const agentName = provider => (provider === 'claude' ? 'Claude Code' : 'Codex');
const queuedEvent = (id, count) => sessionEmit({ id, kind: 'queued', count, status: `queued (${count})` });

function runTurn(session, { turnId, text, attachments = [], origin = null }) {
  const id = session.id;
  if (!session.providerSessionId) {
    session.providerSessionId = session.provider === 'claude' ? `${hex(4)}-${hex(2)}-4${hex(2).slice(1)}-a${hex(2).slice(1)}-${hex(6)}` : `thread-${hex(8)}`;
    if (session.provider === 'codex') session.threadId = session.providerSessionId;
  }
  sessionEmit({ id, turnId, kind: 'user', text, attachments, ...(origin ? { origin } : {}) });
  sessionStatus(session, 'running');
  const heard = origin?.kind === 'wake' ? `a board message from ${origin.from}: "${origin.subject}"` : origin?.kind === 'schedule' ? `the scheduled task "${origin.name}"` : null;
  const reply = heard
    ? `Preview ${agentName(session.provider)} (${session.access} access) woke for ${heard}.\n\nNothing ran; this is **mock** data.`
    : `Preview ${agentName(session.provider)} (${session.access} access) heard:\n\n> ${String(text).split('\n').join('\n> ')}\n\nNothing ran; this is **mock** data.`;
  const chunks = reply.match(/[\s\S]{1,12}/g) || [];
  const timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  later(300, () => sessionEmit({ id, turnId, kind: 'tool', tool: session.provider === 'claude' ? { name: 'Read', summary: `${session.cwd}\\README.md` } : { name: 'shell', summary: 'Get-ChildItem' } }));
  chunks.forEach((chunk, i) => later(500 + i * 50, () => sessionEmit({ id, turnId, kind: 'delta', text: chunk })));
  const end = 550 + chunks.length * 50;
  later(end, () => sessionEmit({ id, turnId, kind: 'message', text: reply }));
  later(end + 20, () => {
    // Fake usage: Claude reports an estimated cost, Codex never does (as in the engine).
    const u = session.usage || emptyUsage(), input = 1800 + String(text).length * 4, output = Math.round(reply.length / 4);
    session.usage = { input: u.input + input, output: u.output + output, cached: u.cached + Math.round(input * 0.6), costUsd: session.provider === 'claude' ? Math.round(((u.costUsd || 0) + input * 3e-6 + output * 15e-6) * 1e4) / 1e4 : null, contextPct: Math.min(100, Math.round(((u.contextPct || 2) + 3.7) * 10) / 10) };
    saveSessions();
    sessionEmit({ id, turnId, kind: 'usage', usage: session.usage, ...(session.provider === 'codex' ? { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 7200 }, secondary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: null }, planType: 'plus', at: Date.now() } } : {}) }, false);
  });
  later(end + 40, () => finishTurn(session, 'completed'));
  sessionTurns.set(id, { timers, turnId, origin });
}

/** Ends the current turn; each 'done' starts the next queued turn, in order. */
function finishTurn(session, status) {
  const turn = sessionTurns.get(session.id);
  if (!turn) return;
  turn.timers.forEach(clearTimeout);
  sessionTurns.delete(session.id);
  sessionEmit({ id: session.id, turnId: turn.turnId, kind: 'done', status });
  sessionStatus(session, session.status === 'stopped' ? 'stopped' : 'idle');
  if (turn.origin?.kind === 'schedule') scheduleFinished(turn.origin.scheduleId, turn.turnId, status);
  const queue = sessionQueues.get(session.id);
  if (queue?.length) { runTurn(session, queue.shift()); queuedEvent(session.id, queue.length); }
}

/** Shared by session_send, mock wakes and mock schedules. */
function submit(id, text, attachments = [], origin = null) {
  const session = findSession(id);
  if (!String(text).trim() && !attachments.length) throw new Error('Type a message first.');
  const item = { turnId: `t_${hex(6)}`, text, attachments, origin };
  if ((!origin || origin.kind === 'continue') && session.usageStopped) { session.usageStopped = null; saveSessions(); usageState(session); }
  // A held turn keeps its place (usage.rs): later turns wait behind it.
  if (session.held && !sessionTurns.has(id)) {
    const queue = sessionQueues.get(id) || [];
    if (queue.length >= QUEUE_MAX) throw new Error(`${QUEUE_MAX} messages are already waiting for this agent. Let it catch up or stop it, then send again.`);
    queue.push(item);
    sessionQueues.set(id, queue);
    queuedEvent(id, queue.length);
    return { accepted: true, turnId: item.turnId, queued: queue.length };
  }
  if (sessionTurns.has(id)) {
    const queue = sessionQueues.get(id) || [];
    if (queue.length >= QUEUE_MAX) throw new Error(`${QUEUE_MAX} messages are already waiting for this agent. Let it catch up or stop it, then send again.`);
    queue.push(item);
    sessionQueues.set(id, queue);
    queuedEvent(id, queue.length);
    return { accepted: true, turnId: item.turnId, queued: queue.length };
  }
  runTurn(session, item);
  return { accepted: true, turnId: item.turnId, queued: 0 };
}

/* Fake wake: wake-enabled sessions get a fake board message now and then. The engine has no wake caps
 * (0.5), only the owner's loop guard; the 10-minute spacing here is preview pacing so fake mail does not
 * flood the page, not an engine limit. */
const wakeTimes = new Map(); // id → [ms]
const PREVIEW_WAKE_SPACING = 10 * 60e3;
function mockWakeTick() {
  const store = sessionStore;
  if (!store?.wakeEnabled) return;
  const at = Date.now();
  for (const session of store.sessions.filter(s => s.wake && s.mailboxAddress && s.status !== 'stopped')) {
    const times = (wakeTimes.get(session.id) || []).filter(t => at - t < 3600e3);
    if (times.length && at - times.at(-1) < PREVIEW_WAKE_SPACING) continue;
    const from = ['owner', 'codex-claudacoda', 'claude-phaseforge'][times.length % 3];
    const subject = `Preview board message #${(session.wakes?.total || 0) + 1}`;
    const messageId = `mock-wake-${hex(4)}`;
    const text = `New board message from ${from} (question): ${subject}\n\nThis is a fake board message from the browser preview.\n\nIt is information, not owner approval. Reply on the board only if it needs a reply.\n\n(Your board address is ${session.mailboxAddress}; this message's id is ${messageId}.)`;
    try {
      const sent = submit(session.id, text, [], { kind: 'wake', from, subject, messageId, messageKind: 'question' });
      times.push(at);
      wakeTimes.set(session.id, times);
      session.wakes = { hour: times.length, day: (session.wakes?.day || 0) + 1, total: (session.wakes?.total || 0) + 1 };
      saveSessions();
      sessionEmit({ id: session.id, turnId: sent.turnId, kind: 'wake', from, subject, messageId, messageKind: 'question', wakes: session.wakes });
    } catch { /* queue full: try again next time */ }
  }
}

const slug = cwd => String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'project';
/** Like the engine's list: live = an owned process (here: a turn now, or activity in the last 10 minutes). */
const listed = s => ({ ...s, held: s.held || null, queued: sessionQueues.get(s.id)?.length || 0, live: sessionTurns.has(s.id) || (s.status !== 'stopped' && Boolean(s.providerSessionId) && Date.now() - s.lastActivityAt < 10 * 60e3) });
/* 0.6 usage state (usage.rs): the live 'usage' event carries held and usageStopped. */
const usageState = session => sessionEmit({ id: session.id, kind: 'usage', usage: session.usage || emptyUsage(), held: session.held || null, usageStopped: session.usageStopped || null }, false);
function cancelHeld(session) {
  const held = session.held;
  if (!held) return false;
  session.held = null;
  saveSessions();
  sessionEmit({ id: session.id, turnId: held.turnId, kind: 'done', status: 'cancelled' }, false);
  usageState(session);
  return true;
}
/** After a held turn is cancelled, the next queued turn starts (nothing else is running). */
function releaseQueue(session) {
  const queue = sessionQueues.get(session.id);
  if (!sessionTurns.has(session.id) && queue?.length) { runTurn(session, queue.shift()); queuedEvent(session.id, queue.length); }
}
/** Preview only: hold the chat's next turn at a pretend plan limit (never sent) with no usable reset reported. */
function mockUsageHold(id, text = 'A turn held at the preview plan limit.') {
  const session = findSession(id);
  session.held = { turnId: `t_${hex(6)}`, provider: session.provider, reason: 'no credits or reset could be used', retryAt: null, retried: false, since: Date.now(), payload: text,
    text: `${agentName(session.provider)}'s plan limit is reached and no credits or reset could be used. Nothing was sent. No usable reset time was reported, so no retry is scheduled. Waiting for the plan to reset; check Settings > Usage. Try now sends it when you choose; Stop cancels it.` };
  saveSessions();
  usageState(session);
  return session.held;
}
/** Preview only: mark the chat's last turn as stopped by the provider at its usage limit after it was sent. */
function mockUsageStop(id) {
  const session = findSession(id);
  const last = [...(sessions().logs[id] || [])].reverse().find(ev => ev.kind === 'user');
  session.usageStopped = { turnId: last?.turnId || `t_${hex(6)}`, provider: session.provider, at: Date.now() };
  saveSessions();
  usageState(session);
  return session.usageStopped;
}
const sessionHandlers = {
  session_list: () => ({ sessions: sessions().sessions.map(listed) }),
  session_start: ({ args = {} }) => {
    if (!['claude', 'codex'].includes(args.provider)) throw new Error('provider must be claude or codex.');
    if (!args.cwd) throw new Error('cwd must be the project folder.');
    const at = Date.now(), id = `s_${hex(8)}`, short = id.slice(2, 10);
    // Preview: any folder named like a project counts as a git repository.
    const repoName = String(args.cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'project';
    const worktreePath = args.worktree ? `C:\\mock\\board\\desktop-ui\\worktrees\\${short}\\${repoName}` : null;
    // 0.5: wake on by default with its own board address; startedBy only for a team start.
    const address = `${args.provider}-${slug(worktreePath || args.cwd)}-${hex(2)}`;
    register(address, `CodaClauda ${agentName(args.provider)} session: ${args.title || 'chat'}`.slice(0, 110));
    const session = { id, provider: args.provider, projectId: args.projectId || args.cwd, cwd: worktreePath || args.cwd, title: args.title || `${agentName(args.provider)} chat`, access: args.access === 'full' ? 'full' : 'read', threadId: null, providerSessionId: null, status: 'idle', createdAt: at, lastActivityAt: at, shared: Boolean(args.sharedId), sharedId: args.sharedId || null, playwright: false, wake: true, mailboxAddress: address, wakes: { hour: 0, day: 0, total: 0 }, worktreePath, branch: worktreePath ? `codaclauda/${short}` : null, usage: emptyUsage(), teamNote: true, ...(args.startedBy ? { startedBy: args.startedBy } : {}), ...(worktreePath ? { repoRoot: args.cwd, baseBranch: 'main' } : {}) };
    sessions().sessions.push(session);
    saveSessions();
    return { session };
  },
  session_send: ({ id, text = '', attachments = [] }) => submit(id, text, attachments),
  session_stop: ({ id }) => {
    const session = findSession(id);
    if (cancelHeld(session)) { releaseQueue(session); return { stopped: true }; }
    if (sessionTurns.has(id)) finishTurn(session, 'interrupted');
    return { stopped: true };
  },
  session_close: ({ id }) => {
    const session = findSession(id);
    const dropped = sessionQueues.get(id) || [];
    sessionQueues.delete(id);
    session.status = 'stopped';
    cancelHeld(session);
    if (sessionTurns.has(id)) finishTurn(session, 'interrupted');
    for (const item of dropped) {
      sessionEmit({ id, turnId: item.turnId, kind: 'done', status: 'cancelled' }, false);
      if (item.origin?.kind === 'schedule') scheduleFinished(item.origin.scheduleId, item.turnId, 'cancelled');
    }
    if (dropped.length) queuedEvent(id, 0);
    sessionStatus(session, 'stopped');
    return { closed: true };
  },
  session_history: ({ id, limit = 500 }) => { findSession(id); return { events: (sessions().logs[id] || []).slice(-limit) }; },
  session_set_wake: ({ id, on }) => {   // no cap on how many sessions wake (0.5)
    const session = findSession(id);
    if (on && !session.mailboxAddress) { session.mailboxAddress = `${session.provider}-${slug(session.cwd)}-${hex(2)}`; register(session.mailboxAddress, session.title); }
    session.wake = Boolean(on);
    saveSessions();
    sessionEmit({ id, kind: 'status', status: session.status });
    return { session: listed(session) };
  },
  wake_settings_get: () => ({ enabled: sessions().wakeEnabled !== false, loopGuard: loopGuard(), pairs: mockPairs() }),
  /* Like wake.rs: { enabled?, loopGuard?, pair?: { key, paused } }; a paused pair stays paused until resumed. */
  wake_settings_set: ({ enabled, loopGuard: guard, pair } = {}) => {
    const store = sessions();
    const next = loopGuard();
    if (guard !== undefined) {
      if (!guard || typeof guard !== 'object') throw coded('INVALID_ARGUMENTS', 'loopGuard must be an object with on, mode and pairPerHour.');
      if (guard.on !== undefined) { if (typeof guard.on !== 'boolean') throw coded('INVALID_ARGUMENTS', 'loopGuard.on must be true or false.'); next.on = guard.on; }
      if (guard.mode !== undefined) { if (!['notify', 'pause'].includes(guard.mode)) throw coded('INVALID_ARGUMENTS', 'loopGuard.mode must be "notify" or "pause".'); next.mode = guard.mode; }
      if (guard.pairPerHour !== undefined) { if (!Number.isSafeInteger(guard.pairPerHour) || guard.pairPerHour < 1) throw coded('INVALID_ARGUMENTS', 'pairPerHour must be a whole number from 1 to 9007199254740991.'); next.pairPerHour = guard.pairPerHour; }
    }
    if (pair !== undefined) {
      if (!pair || typeof pair.key !== 'string' || !pair.key.startsWith('pair:') || !pair.key.includes('|')) throw coded('INVALID_ARGUMENTS', 'pair.key must be a pair key from wake_settings_get.');
      if (typeof pair.paused !== 'boolean') throw coded('INVALID_ARGUMENTS', 'pair.paused must be true or false.');
      store.pausedPairs ||= {};
      if (pair.paused) store.pausedPairs[pair.key] = Date.now(); else delete store.pausedPairs[pair.key];
    }
    if (enabled !== undefined) store.wakeEnabled = Boolean(enabled);
    store.loopGuard = next;
    saveSessions();
    return { enabled: store.wakeEnabled !== false, loopGuard: { ...next }, pairs: mockPairs() };
  },
  /* 0.6 team starts: the owner's standing switch (on, Unlimited by default) covers every linked project
   * without its own entry; an entry may override it. Like team.rs, get lists every linked project with its
   * effective setting, followsDefault and autoRegistered. */
  team_settings_get: () => {
    const book = teamBook();
    return { address: 'codaclauda-team', pollSeconds: 5, ownerDefault: { ...book.ownerDefault }, defaults: { ...book.ownerDefault }, projects: teamTargets(book), requests: teamRequests(), inboxError: null };
  },
  team_settings_set: ({ project = {} }) => {
    const book = teamBook();
    if (project.cancelRequest !== undefined) {   // like team.rs: only a queued request can be cancelled
      teamRequests();
      const request = mockRequests.find(r => r.requestId === project.cancelRequest);
      if (!request) throw coded('REQUEST_NOT_FOUND', 'That team request is not saved.');
      if (request.status !== 'queued') throw coded('REQUEST_NOT_CANCELLABLE', request.sessionId ? `Its teammate already launched as session ${request.sessionId}; Stop it in Running instead.` : `It already ended (${request.status}).`);
      Object.assign(request, { status: 'cancelled', cancellable: false, at: Date.now() });
      writeJson(TEAM_REQUESTS_KEY, mockRequests);
      return { cancelled: true, requestId: request.requestId, requests: teamRequests() };
    }
    if (project.ownerDefault !== undefined) {
      const next = { ...book.ownerDefault }, input = project.ownerDefault;
      if (!input || typeof input !== 'object') throw coded('INVALID_ARGUMENTS', 'ownerDefault must be an object with agentsCanStart and maxAgentStartedLive.');
      if (input.agentsCanStart !== undefined) { if (typeof input.agentsCanStart !== 'boolean') throw coded('INVALID_ARGUMENTS', 'agentsCanStart must be true or false.'); next.agentsCanStart = input.agentsCanStart; }
      if (input.maxAgentStartedLive !== undefined) next.maxAgentStartedLive = budget('maxAgentStartedLive', input.maxAgentStartedLive, 1);
      book.ownerDefault = next;
      writeJson(TEAM_KEY, book);
      return { ownerDefault: { ...next } };
    }
    const id = String(project.projectId || '').trim();
    if (!id) throw coded('INVALID_ARGUMENTS', 'projectId must name the project.');
    const entry = { name: '', cwd: '', ids: [], ...book.projects[id] };
    if (project.cwd) entry.cwd = String(project.cwd);
    if (project.name) entry.name = String(project.name);
    if (Array.isArray(project.ids)) entry.ids = project.ids.map(String).slice(0, 32);
    if (project.useDefault === true) { delete entry.agentsCanStart; delete entry.maxAgentStartedLive; }
    if (project.agentsCanStart !== undefined) { if (typeof project.agentsCanStart !== 'boolean') throw coded('INVALID_ARGUMENTS', 'agentsCanStart must be true or false.'); entry.agentsCanStart = project.agentsCanStart; }
    if (project.maxAgentStartedLive !== undefined) entry.maxAgentStartedLive = budget('maxAgentStartedLive', project.maxAgentStartedLive, 1);
    if (entry.agentsCanStart === true && !entry.cwd) throw coded('PROJECT_MISSING', 'The project needs a local folder.');
    entry.updatedAt = Date.now();
    const follows = entry.agentsCanStart === undefined && entry.maxAgentStartedLive === undefined && !entry.autoAccess;
    if (project.remove === true || follows) delete book.projects[id]; else book.projects[id] = entry;
    writeJson(TEAM_KEY, book);
    const view = teamTargets(book)[id] || teamView(book, entry);
    return { projectId: id, project: project.remove === true ? { ...view, removed: true } : view };
  },
};
const loopGuard = () => ({ on: true, mode: 'notify', pairPerHour: 60, ...(sessions().loopGuard || {}) });
/** Preview pairs: the first two wake-on sessions, as if they had woken each other a few times this hour, plus any paused pair. */
function mockPairs() {
  const store = sessions(), paused = store.pausedPairs || {};
  const addresses = store.sessions.filter(s => s.wake && s.mailboxAddress).map(s => s.mailboxAddress).slice(0, 2).sort();
  const keys = new Set(Object.keys(paused));
  if (addresses.length === 2) keys.add(`pair:${addresses[0]}|${addresses[1]}`);
  const guard = loopGuard();
  return [...keys].map(key => {
    const [a, b] = key.slice('pair:'.length).split('|');
    const lastHour = addresses.length === 2 && key === `pair:${addresses[0]}|${addresses[1]}` ? 3 : 0;
    return { key, a, b, lastHour, reached: guard.on && lastHour >= guard.pairPerHour, paused: Boolean(paused[key]) };
  }).sort((x, y) => y.lastHour - x.lastHour);
}
const TEAM_KEY = 'mock.team';
const TEAM_REQUESTS_KEY = 'mock.teamRequests';
let mockRequests = null;
/** Recent team requests, newest first, as team_settings_get lists them. */
const teamRequests = () => {
  mockRequests ||= readJson(TEAM_REQUESTS_KEY, null) || [];
  return [...mockRequests].sort((a, b) => b.at - a.at).slice(0, 50).map(r => ({ ...r, cancellable: r.status === 'queued' }));
};
const teamBook = () => { const book = readJson(TEAM_KEY, null) || {}; book.projects ||= {}; book.ownerDefault = { agentsCanStart: true, maxAgentStartedLive: 'unlimited', ...(book.ownerDefault || {}) }; return book; };
const mockPath = path => String(path || '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const teamView = (book, p) => ({
  name: p.name, cwd: p.cwd, ids: p.ids || [], agentsCanStart: p.agentsCanStart ?? book.ownerDefault.agentsCanStart,
  maxAgentStartedLive: p.maxAgentStartedLive ?? book.ownerDefault.maxAgentStartedLive,
  followsDefault: p.agentsCanStart === undefined && p.maxAgentStartedLive === undefined, autoRegistered: Boolean(p.autoAccess), ...(p.autoAccess ? { access: p.autoAccess } : {}),
});
/** Entries first, then the preview's linked folders (mock desktop state) that no entry covers. */
function teamTargets(book) {
  const out = Object.fromEntries(Object.entries(book.projects).map(([id, p]) => [id, teamView(book, p)]));
  const local = readJson('mock.desktop', null)?.projects?.local || [];
  for (const item of local) {
    const id = `local:${mockPath(item.path)}`;
    if (Object.entries(out).some(([key, p]) => key === id || p.ids.includes(id) || mockPath(p.cwd) === mockPath(item.path))) continue;
    out[id] = teamView(book, { name: item.name || item.path.split(/[\\/]/).pop(), cwd: item.path, ids: [id] });
  }
  return out;
}
/** Preview: an agent's codaclauda-team request starting a teammate (codaMock.teamStart()). It is listed queued,
 *  then admitted, then completed, as team.rs answers. A folder path inside a preview linked folder registers like
 *  team.rs does (Read unless it is under C:\Users\Ben); a folder elsewhere is refused (existing is not enough). */
function mockTeamStart(projectId) {
  const book = teamBook();
  const linkedRoots = (readJson('mock.desktop', null)?.projects?.local || []).map(item => mockPath(item.path));
  const underLinked = path => linkedRoots.some(root => mockPath(path).startsWith(`${root}/`));
  if (projectId && /^[A-Za-z]:\\/.test(projectId) && !teamTargets(book)[`local:${mockPath(projectId)}`]) {
    if (!underLinked(projectId)) return `Agents cannot start teammates in ${projectId}: it is not a linked project, nor a real folder inside one.`;
    book.projects[`local:${mockPath(projectId)}`] = { name: projectId.split('\\').pop(), cwd: projectId, ids: [`local:${mockPath(projectId)}`], autoAccess: /^c:\\users\\ben\\/i.test(projectId) ? 'full' : 'read', updatedAt: Date.now() };
    writeJson(TEAM_KEY, book);
  }
  const [id, entry] = Object.entries(teamTargets(book)).find(([key, p]) => p.agentsCanStart && (!projectId || key === projectId || key === `local:${mockPath(projectId)}`)) || [];
  if (!id) return 'Agents cannot start teammates there: turn on Settings → Team, or the project in Projects → Teammates.';
  const requestId = `mock-team-${hex(3)}`;
  teamRequests();
  const request = { requestId, from: 'claude-codaclauda', subject: 'Need a reviewer', status: 'queued', at: Date.now(), sessionId: null, address: null, code: null };
  mockRequests.push(request);
  const { session } = sessionHandlers.session_start({ args: { provider: 'codex', projectId: id, cwd: entry.cwd, access: entry.access || 'read', title: 'Reviewer (started by an agent)', startedBy: { address: 'claude-codaclauda', messageId: requestId, at: Date.now() } } });
  Object.assign(request, { status: 'launching', sessionId: session.id, address: session.mailboxAddress, at: Date.now() });
  writeJson(TEAM_REQUESTS_KEY, mockRequests);
  submit(session.id, 'claude-codaclauda asked CodaClauda to start you. Review the diff.', [], { kind: 'team', from: 'claude-codaclauda', messageId: requestId });
  setTimeout(() => { Object.assign(request, { status: 'admitted', at: Date.now() }); writeJson(TEAM_REQUESTS_KEY, mockRequests); }, 400);
  setTimeout(() => { Object.assign(request, { status: 'completed', at: Date.now() }); writeJson(TEAM_REQUESTS_KEY, mockRequests); }, 2500);
  return session.mailboxAddress;
}

/* Mock schedules (localStorage mock.schedules). Due checks run every 10 s; a run reuses one dedicated session. */
let scheduleStore = null;
function schedules() {
  if (scheduleStore) return scheduleStore;
  try { scheduleStore = JSON.parse(localStorage.getItem(SCHEDULES_KEY) || 'null'); } catch { scheduleStore = null; }
  scheduleStore ||= { schedules: [], runs: {} };
  // A run missed while the preview was closed: catchUp runs it once on the next tick, otherwise skip it.
  const at = Date.now();
  for (const s of scheduleStore.schedules) if (s.enabled && s.nextRunAt && s.nextRunAt <= at && !s.catchUp) s.nextRunAt = nextRun(s.cadence, at);
  return scheduleStore;
}
const saveSchedules = () => { try { localStorage.setItem(SCHEDULES_KEY, JSON.stringify(schedules())); } catch { /* preview only */ } };
const scheduleEmit = (id, kind, run) => { for (const cb of scheduleListeners) { try { cb(structuredClone({ id, kind, run })); } catch (error) { console.error(error); } } };
function findSchedule(id) {
  const schedule = schedules().schedules.find(s => s.id === id);
  if (!schedule) throw new Error('That schedule no longer exists.');
  return schedule;
}
function nextRun(cadence, after) {
  if (cadence.kind === 'interval') return after + cadence.minutes * 60e3;
  const [h, m] = cadence.time.split(':').map(Number);
  for (let offset = 0; offset <= 7; offset++) {
    const d = new Date(after);
    d.setDate(d.getDate() + offset);
    d.setHours(h, m, 0, 0);
    if ((!cadence.days.length || cadence.days.includes(d.getDay())) && d.getTime() > after) return d.getTime();
  }
  return null;
}
function parseCadence(c = {}) {
  if (c.kind === 'interval') {
    const minutes = Number(c.minutes);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 10080) throw new Error('An interval must be 15 to 10080 minutes.');
    return { kind: 'interval', minutes };
  }
  if (c.kind === 'daily') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(c.time || ''))) throw new Error('A daily time must be HH:MM (24-hour).');
    const days = [...new Set(Array.isArray(c.days) ? c.days : [])];
    if (days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Days must be 0 (Sunday) to 6 (Saturday).');
    return { kind: 'daily', time: c.time, days: days.sort((a, b) => a - b) };
  }
  throw new Error('cadence.kind must be interval or daily.');
}
function appendRun(id, run) {
  const runs = (schedules().runs[id] ||= []);
  runs.push(run);
  if (runs.length > 500) runs.splice(0, runs.length - 500);
  saveSchedules();
}
function scheduleFinished(id, turnId, status) {
  const run = (schedules().runs[id] || []).findLast(r => r.turnId === turnId);
  if (!run) return;
  Object.assign(run, { status: status === 'completed' ? 'done' : 'error', endedAt: Date.now(), ...(status === 'completed' ? {} : { error: `The turn ended: ${status}.` }) });
  saveSchedules();
  scheduleEmit(id, run.status === 'done' ? 'run' : 'error', run);
}
function fireSchedule(id, trigger) {
  const schedule = findSchedule(id), at = Date.now();
  schedule.lastRunAt = at;
  if (trigger !== 'manual' || !schedule.nextRunAt) schedule.nextRunAt = schedule.enabled ? nextRun(schedule.cadence, at) : null;
  if (!schedule.sessionId || !sessions().sessions.some(s => s.id === schedule.sessionId)) {
    schedule.sessionId = sessionHandlers.session_start({ args: { provider: schedule.provider, projectId: schedule.projectId, cwd: schedule.cwd, access: schedule.access || 'full', title: `${schedule.name} (scheduled)` } }).session.id;
  }
  saveSchedules();
  // Record the run before the turn can end, as the engine does.
  const origin = { kind: 'schedule', scheduleId: id, name: schedule.name, trigger };
  let run;
  try {
    if (trigger !== 'manual' && (sessionTurns.has(schedule.sessionId) || sessionQueues.get(schedule.sessionId)?.length)) throw new Error('Skipped: the session was still working on an earlier turn.');
    const sent = submit(schedule.sessionId, schedule.prompt, [], origin);
    run = { at, status: 'sent', sessionId: schedule.sessionId, turnId: sent.turnId, trigger };
  } catch (error) {
    run = { at, status: 'error', sessionId: schedule.sessionId, turnId: null, trigger, error: error.message };
  }
  appendRun(id, run);
  scheduleEmit(id, run.status === 'error' ? 'error' : 'run', run);
  return run;
}
function mockScheduleTick() {
  if (!scheduleStore) return;
  const at = Date.now();
  for (const s of scheduleStore.schedules) if (s.enabled && s.nextRunAt && s.nextRunAt <= at) fireSchedule(s.id, at - s.nextRunAt > 20e3 ? 'catch-up' : 'timer');
}
let mockTimers = false;
/** Fake wakes every 30 s and schedule due checks every 10 s, started once by createMock(). */
function startMockTimers() {
  if (mockTimers) return;
  mockTimers = true;
  setInterval(mockWakeTick, 30e3);
  setInterval(mockScheduleTick, 10e3);
}
const scheduleHandlers = {
  schedule_list: () => ({ schedules: schedules().schedules }),
  schedule_save: ({ schedule: input = {} }) => {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('Give the schedule a name.');
    if (!['claude', 'codex'].includes(input.provider)) throw new Error('provider must be claude or codex.');
    if (!String(input.cwd || '').trim()) throw new Error('cwd must be the project folder.');
    if (!String(input.prompt || '').trim()) throw new Error('Write the prompt the schedule sends.');
    const cadence = parseCadence(input.cadence), enabled = input.enabled !== false, at = Date.now();
    const fields = { name, provider: input.provider, cwd: input.cwd, projectId: input.projectId || input.cwd, prompt: input.prompt, cadence, enabled, catchUp: Boolean(input.catchUp), ...(input.access === 'read' || input.access === 'full' ? { access: input.access } : {}) };
    if (input.id) {
      const existing = findSchedule(input.id);
      if (existing.provider !== fields.provider || existing.cwd !== fields.cwd) existing.sessionId = null;
      const retime = JSON.stringify(existing.cadence) !== JSON.stringify(cadence) || !existing.enabled || !existing.nextRunAt;
      Object.assign(existing, fields);
      existing.nextRunAt = !enabled ? null : retime ? nextRun(cadence, at) : existing.nextRunAt;
      saveSchedules();
      return { schedule: existing };
    }
    if (schedules().schedules.length >= 50) throw new Error('CodaClauda keeps at most 50 schedules.');
    const schedule = { id: `sch_${hex(4)}`, ...fields, lastRunAt: null, nextRunAt: enabled ? nextRun(cadence, at) : null, sessionId: null, createdAt: at };
    schedules().schedules.push(schedule);
    saveSchedules();
    return { schedule };
  },
  schedule_delete: ({ id }) => {
    findSchedule(id);
    schedules().schedules = schedules().schedules.filter(s => s.id !== id);
    delete schedules().runs[id];
    saveSchedules();
    return { deleted: true };
  },
  schedule_run_now: ({ id }) => ({ run: fireSchedule(id, 'manual') }),
  schedule_runs: ({ id, limit = 50 }) => { findSchedule(id); return { runs: (schedules().runs[id] || []).slice(-Math.min(500, Math.max(1, limit))).reverse() }; },
};

/* 0.5 mocks: fork, hand-off, worktree diff/apply/discard/PR, compact, external sessions, MCP servers,
 * phone push settings, CLAUDE.md/AGENTS.md editor and CI runs. Nothing here touches git, gh or the network. */
const MCP_KEY = 'mock.mcp', NOTIFY_KEY = 'mock.notify', INSTRUCTIONS_KEY = 'mock.instructions', LIMITS_KEY = 'mock.sessionLimits';
const readJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } };
const writeJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* preview only */ } };
const MCP_PRESETS = [
  { id: 'playwright', label: 'Playwright MCP (browser automation)', name: 'playwright', command: 'cmd', args: ['/c', 'playwright-mcp'], env: {}, install: 'npm i -g @playwright/mcp', notes: 'Preview copy of the engine preset: install it yourself first; the npm bin is playwright-mcp, run through cmd /c on Windows.', source: 'https://registry.npmjs.org/@playwright/mcp/latest' },
  { id: 'windows-mcp', label: 'Windows-MCP (desktop control, CursorTouch)', name: 'windows-mcp', command: 'windows-mcp', args: ['serve'], env: {}, install: 'uv tool install windows-mcp', notes: 'Preview copy of the engine preset: install it yourself first with uv tool install windows-mcp; CodaClauda never runs uvx or downloads it.', source: 'https://github.com/CursorTouch/Windows-MCP#readme' },
];
const FAKE_EXTERNAL_IDS = ['3f1c2a9e-7b4d-4e21-9a0c-5d8e6f1b2c3a', 'a7e9d1c4-2b6f-4a83-8c15-9e0d3b7f4a62', '0199c3b2-5e7a-7d41-b8f0-2c6a9e4d1f73', '0199b8e1-4c2d-7a95-a3e6-8f1d0c5b7e24', 'c2d4e6f8-1a3b-4c5d-8e7f-9a0b1c2d3e4f'];
const USAGE_KEY = 'mock.usage';
const BINDINGS_KEY = 'mock.desktopBindings';
const mockBindings = () => (readJson(BINDINGS_KEY, []) || []).filter(b => b && typeof b.address === 'string');
/* Like usage.rs: every flag is on unless saved exactly false. */
const usageSettings = () => {
  const saved = readJson(USAGE_KEY, {}) || {};
  const on = value => value !== false;
  return { codex: { useCredits: on(saved.codex?.useCredits), useResets: on(saved.codex?.useResets) }, claude: { useCredits: on(saved.claude?.useCredits) }, error: null };
};
const busy = id => sessionTurns.has(id) || Boolean(sessionQueues.get(id)?.length);
const needsWorktree = session => { if (!session.worktreePath) throw coded('NO_WORKTREE', 'This chat does not have its own worktree.'); };
const MOCK_PATCH = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,4 @@\n # Project\n-Old line\n+New line from the agent\n+Another added line\n \n diff --git a/src/new.js b/src/new.js\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.js\n@@ -0,0 +1,2 @@\n+export const hello = () => \'preview\';\n+// mock data\n';
const v05Handlers = {
  session_fork: ({ id }) => {
    const source = findSession(id);
    const from = source.provider === 'codex' ? source.threadId : source.providerSessionId;
    if (!from && !source.forkFrom) throw coded('NOTHING_TO_FORK', 'Send a message in this chat before forking it.');
    const at = Date.now(), newId = `s_${hex(8)}`, title = `Fork of ${source.title}`.slice(0, 200);
    // Like fork.rs: a fork is a new session, so wake is on with its own board address.
    const address = `${source.provider}-${slug(source.cwd)}-${hex(2)}`;
    register(address, `CodaClauda ${agentName(source.provider)} session: ${title}`.slice(0, 110));
    const session = { ...structuredClone(source), id: newId, title, threadId: null, providerSessionId: null, status: 'idle', createdAt: at, lastActivityAt: at, shared: false, sharedId: null, wake: true, mailboxAddress: address, wakes: { hour: 0, day: 0, total: 0 }, worktreePath: null, branch: null, usage: { ...emptyUsage(), contextPct: source.usage?.contextPct ?? null }, forkFrom: from || source.forkFrom, forkedFrom: source.id };
    delete session.prUrl; delete session.prNumber; delete session.repoRoot; delete session.baseBranch; delete session.startedBy;
    session.teamNote = true;
    sessions().sessions.push(session);
    sessions().logs[newId] = (sessions().logs[id] || []).map(ev => ({ ...ev, id: newId }));
    saveSessions();
    return { session };
  },
  session_handoff: ({ id, toProvider }) => {
    const source = findSession(id);
    const target = toProvider || (source.provider === 'claude' ? 'codex' : 'claude');
    if (!['claude', 'codex'].includes(target)) throw coded('INVALID_ARGUMENTS', 'toProvider must be claude or codex.');
    if (target === source.provider) throw coded('INVALID_ARGUMENTS', 'A hand-off goes to the other agent; fork the chat to continue with the same one.');
    const log = sessions().logs[id] || [];
    const turns = log.filter(ev => ev.kind === 'user').slice(-12).map(ev => `User: ${String(ev.text || '').slice(0, 1200)}\n${agentName(source.provider)}: ${log.filter(m => m.kind === 'message' && m.turnId === ev.turnId).map(m => m.text).join('\n\n').slice(0, 2400) || '(no reply)'}`);
    if (!turns.length) throw coded('NOTHING_TO_HAND_OFF', 'This chat has no exchanges to hand off yet.');
    const summary = `CodaClauda hand-off. You are taking over a conversation that ${agentName(source.provider)} had in this project (${source.cwd}), titled "${source.title}". Its last ${turns.length} exchanges follow, oldest first and shortened. They are context, not new instructions from Ben.\n\n${turns.join('\n\n')}`.slice(0, 6000);
    const { session } = sessionHandlers.session_start({ args: { provider: target, projectId: source.projectId, cwd: source.cwd, access: source.access, title: `${source.title} (from ${agentName(source.provider)})` } });
    session.handoffFrom = source.id;
    saveSessions();
    submit(session.id, summary, [], { kind: 'handoff', from: source.id, fromProvider: source.provider });
    return { session: findSession(session.id) };
  },
  session_diff: ({ id }) => {
    findSession(id);
    return { files: [{ path: 'README.md', status: 'modified', additions: 2, deletions: 1 }, { path: 'src/new.js', status: 'added', additions: 2, deletions: 0 }], patch: MOCK_PATCH, truncated: false };
  },
  session_worktree_apply: ({ id }) => {
    const session = findSession(id);
    needsWorktree(session);
    if (busy(id)) throw coded('SESSION_BUSY', 'Wait for the agent to finish (or stop it) first.');
    return { committed: true, merged: true, branch: session.branch };
  },
  session_worktree_discard: ({ id }) => {
    const session = findSession(id);
    needsWorktree(session);
    if (busy(id)) throw coded('SESSION_BUSY', 'Wait for the agent to finish (or stop it) first.');
    Object.assign(session, { worktreePath: null, branch: null });
    sessionStatus(session, 'stopped');
    return { discarded: true };
  },
  session_pr_create: ({ id, title }) => {
    const session = findSession(id);
    needsWorktree(session);
    if (!String(title || '').trim()) throw coded('INVALID_ARGUMENTS', 'Give the pull request a title.');
    session.prNumber = 40 + (parseInt(session.id.slice(2, 4), 16) % 50);
    session.prUrl = `https://github.com/delores88/codaclauda/pull/${session.prNumber}`;
    saveSessions();
    return { url: session.prUrl, number: session.prNumber };
  },
  session_pr_status: ({ id }) => {
    const session = findSession(id);
    if (!session.prUrl) return { url: null, state: null, checks: [] };
    return { url: session.prUrl, state: 'open', checks: [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'in_progress', conclusion: null }] };
  },
  session_compact: ({ id }) => {
    const session = findSession(id);
    if (session.provider !== 'codex') throw coded('COMPACT_UNSUPPORTED', 'Claude sessions in CodaClauda run with slash commands disabled, so /compact is unavailable here. Claude compacts on its own when its context fills.');
    if (!session.threadId) throw coded('NOTHING_TO_COMPACT', 'Send a message first; this chat has no Codex thread yet.');
    submit(id, 'Compact this conversation\'s context.', [], { kind: 'compact' });
    session.usage = { ...(session.usage || emptyUsage()), contextPct: 8 };
    saveSessions();
    return { ok: true };
  },
  external_sessions_list: () => {
    const at = Date.now(), owned = new Set(sessions().sessions.flatMap(s => [s.providerSessionId, s.threadId]).filter(Boolean));
    const fake = [
      ['claude', 'C:\\Users\\Ben\\Desktop\\CodaClauda', 3], ['claude', 'D:\\PhaseForge-claude', 40], ['codex', 'C:\\Users\\Ben\\Desktop\\CodaClauda', 9],
      ['codex', 'C:\\Users\\Ben\\Desktop\\DGXBridge', 300], ['claude', 'C:\\Users\\Ben\\Desktop\\TuningSpork', 2900],
    ].map(([provider, cwd, minutesAgo], i) => ({ provider, cwd, projectHint: cwd.split('\\').pop(), modifiedAt: at - minutesAgo * 60e3, active: minutesAgo < 15, owned: owned.has(FAKE_EXTERNAL_IDS[i]), providerSessionId: FAKE_EXTERNAL_IDS[i] }));
    const mine = sessions().sessions.filter(s => s.providerSessionId && !FAKE_EXTERNAL_IDS.includes(s.providerSessionId)).map(s => ({ provider: s.provider, cwd: s.cwd, projectHint: s.cwd.split(/[\\/]/).pop(), modifiedAt: s.lastActivityAt, active: at - s.lastActivityAt < 15 * 60e3, owned: owned.has(s.providerSessionId), providerSessionId: s.providerSessionId }));
    return { sessions: [...fake, ...mine].sort((a, b) => b.modifiedAt - a.modifiedAt) };
  },
  /* 0.6 (H6): Continue as a copy, like external.rs. The default (or mode 'fork') starts a separate copy as a
   * CodaClauda session, wake on, at the project's current access (Read when the folder is not a linked project):
   * no provider ids, forkFrom = the original, adoptedFrom.copy; the original is never touched. Mode 'continue'
   * is always refused with OWNERSHIP_UNKNOWN (an id match is not ownership provenance). */
  session_adopt: input => {
    const a = input?.args && typeof input.args === 'object' ? input.args : input || {};
    if (!['claude', 'codex'].includes(a.provider)) throw coded('INVALID_ARGUMENTS', 'provider must be claude or codex.');
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(a.providerSessionId || ''))) throw coded('INVALID_ARGUMENTS', 'That is not a Claude Code or Codex conversation id.');
    if (a.mode != null && !['', 'continue', 'fork'].includes(String(a.mode).trim())) throw coded('INVALID_ARGUMENTS', 'mode must be continue or fork.');
    const fork = String(a.mode || '').trim() !== 'continue';
    if (!fork) throw coded('OWNERSHIP_UNKNOWN', `CodaClauda can't establish who owns this ${agentName(a.provider)} conversation, so it never continues it in place. Continue makes a separate, labeled copy instead; the original stays as it is in its own app.`);
    const row = v05Handlers.external_sessions_list().sessions.find(e => e.provider === a.provider && e.providerSessionId === a.providerSessionId);
    if (!row) throw coded('SESSION_NOT_FOUND', `That ${agentName(a.provider)} conversation is no longer on this PC.`);
    if (!/^[A-Za-z]:\\/.test(String(a.cwd || ''))) throw coded('PROJECT_MISSING', `${a.cwd || 'That folder'} is not an existing project folder.`);
    const linked = (readJson('mock.desktop', null)?.projects?.local || []).find(p => mockPath(p.path) === mockPath(a.cwd));
    const level = linked ? readJson('mock.desktop', null)?.projectAccess?.[`local:${mockPath(a.cwd)}`]?.level || 'full' : 'read';
    const title = String(a.title || '').trim().slice(0, 200) || `${agentName(a.provider)} conversation (copy)`;
    const { session } = sessionHandlers.session_start({ args: { provider: a.provider, projectId: linked ? `local:${mockPath(a.cwd)}` : a.cwd, cwd: a.cwd, access: level, title } });
    const record = findSession(session.id);
    Object.assign(record, { forkFrom: a.providerSessionId, adoptedFrom: { provider: a.provider, providerSessionId: a.providerSessionId, copy: true } });
    saveSessions();
    return { session: listed(record), copy: true };
  },
  /* 0.6 Wake by mail for an existing Codex desktop chat (desktop_queue.rs). Owner only. Like the engine: the address
   * must be registered on the board, not reserved and not a CodaClauda session's; the thread must be a Codex
   * conversation on this "PC" whose folder is inside a linked project and that no CodaClauda session writes.
   * A refusal saves nothing; rebinding the same pair keeps its cursor and receipt. The preview never runs codex. */
  desktop_bindings_get: () => ({ bindings: mockBindings(), wakeEnabled: sessions().wakeEnabled !== false, pollSeconds: 10 }),
  desktop_bind: ({ address, threadId } = {}) => {
    const name = String(address || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{1,80}$/.test(name)) throw coded('INVALID_ARGUMENTS', 'address must be a board address (letters, digits, dots, underscores or hyphens).');
    if (['owner', TEAM_INBOX].includes(name)) throw coded('ADDRESS_RESERVED', `${name} is not a chat's own inbox; pick the address that Codex chat registered.`);
    if (sessions().sessions.some(s => s.mailboxAddress === name)) throw coded('ADDRESS_TAKEN', `${name} belongs to a CodaClauda session, which wakes by mail on its own.`);
    if (!addresses.some(a => a.name === name)) throw coded('ADDRESS_UNKNOWN', `${name} is not registered on the board. Have that chat register it with its usual mailbox command first.`);
    const thread = String(threadId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(thread)) throw coded('INVALID_ARGUMENTS', 'threadId must be a Codex conversation id.');
    const found = v05Handlers.external_sessions_list().sessions.find(c => c.provider === 'codex' && c.providerSessionId === thread);
    if (!found) throw coded('THREAD_NOT_FOUND', 'No Codex conversation with that id is on this PC.');
    const root = (readJson('mock.desktop', null)?.projects?.local || []).map(p => p.path).filter(p => mockPath(found.cwd) === mockPath(p) || mockPath(found.cwd).startsWith(`${mockPath(p)}/`)).sort((x, y) => y.length - x.length)[0];
    if (!root) throw coded('PROJECT_NOT_LINKED', `That Codex conversation works in ${found.cwd}, which is not inside one of your linked projects. Link the project in Projects first.`);
    if (found.owned) throw coded('CONTINUED_IN_CODACLAUDA', 'A CodaClauda session already writes this conversation and wakes by mail itself. Two writers would interleave; use that chat instead.');
    const kept = mockBindings().find(b => b.address === name && b.threadId === thread);
    const binding = kept ? { ...kept, cwd: found.cwd, projectId: `local:${mockPath(root)}` } : { address: name, provider: 'codex', threadId: thread, cwd: found.cwd, projectId: `local:${mockPath(root)}`, boundAt: Date.now(), cursor: 0, last: null };
    const bindings = [...mockBindings().filter(b => b.address !== name), binding];
    writeJson(BINDINGS_KEY, bindings);
    return { binding, bindings };
  },
  desktop_unbind: ({ address } = {}) => {
    const name = String(address || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{1,80}$/.test(name)) throw coded('INVALID_ARGUMENTS', 'address must be a board address.');
    const before = mockBindings(), bindings = before.filter(b => b.address !== name);
    writeJson(BINDINGS_KEY, bindings);
    return { unbound: bindings.length !== before.length, bindings };
  },
  /* 0.6 usage limits (usage.rs). A held turn never reached a provider: Try now releases it through normal admission
   * (the preview has no plan limit, so it is sent); Stop or close cancels it. Continue is a new owner turn for the
   * recorded usageStopped turn once it has ended (origin { kind: 'continue', turnId }); nothing is replayed.
   * Preview only: codaMock.usageHold(id) / codaMock.usageStop(id) put a chat into those states. */
  session_retry_held: ({ id }) => {
    const session = findSession(id);
    const held = session.held;
    if (!held) throw coded('NOT_HELD', 'This chat has no held turn.');
    if (session.status === 'stopped') throw coded('SESSION_CLOSED', 'This chat is closed; its held turn was not sent.');
    session.held = null;
    saveSessions();
    usageState(session);
    const item = { turnId: held.turnId, text: held.payload || held.text, attachments: [], origin: null };
    if (sessionTurns.has(id)) { const queue = sessionQueues.get(id) || []; queue.unshift(item); sessionQueues.set(id, queue); queuedEvent(id, queue.length); } else runTurn(session, item);
    return { released: true, turnId: held.turnId };
  },
  session_continue: ({ id, turnId }) => {
    const session = findSession(id);
    if (session.usageStopped?.turnId !== turnId) throw coded('NOT_STOPPED', 'That turn is not the one stopped at the usage limit.');
    if (sessionTurns.get(id)?.turnId === turnId) throw coded('SESSION_BUSY', 'Wait for the stopped turn to finish before continuing.');
    return { ...submit(id, `Continue from turn ${turnId}, which stopped at the usage limit after it was sent. Part of it may already have run: check what was done before repeating any step.`, [], { kind: 'continue', turnId }), duplicate: false };
  },
  /* 0.6 usage setting (usage.rs): app-wide, all on by default; the preview never contacts a provider. */
  usage_settings_get: () => usageSettings(),
  usage_settings_set: input => {
    const a = input?.args && typeof input.args === 'object' ? input.args : input || {};
    if (!['claude', 'codex'].includes(a.provider)) throw coded('INVALID_ARGUMENTS', 'provider must be claude or codex.');
    if (a.provider === 'claude' && a.useResets != null) throw coded('INVALID_ARGUMENTS', 'Claude has no weekly-reset credits.');
    if ([a.useCredits, a.useResets].some(v => v != null && typeof v !== 'boolean')) throw coded('INVALID_ARGUMENTS', 'Each switch must be true or false.');
    const settings = usageSettings();
    if (a.useCredits != null) settings[a.provider].useCredits = a.useCredits;
    if (a.provider === 'codex' && a.useResets != null) settings.codex.useResets = a.useResets;
    writeJson(USAGE_KEY, { codex: settings.codex, claude: settings.claude });
    return settings;
  },
  usage_status: input => {
    const provider = (input?.args && typeof input.args === 'object' ? input.args : input || {}).provider;
    if (provider === 'claude') return { provider, snapshot: null, at: null, limited: false, overage: false, resetsAt: null, resets: 'unsupported' };
    if (provider !== 'codex') throw coded('INVALID_ARGUMENTS', 'provider must be claude or codex.');
    const at = Date.now(), soon = Math.round(at / 1000) + 3 * 3600;
    return { provider, at, state: 'allowed', limited: false, resetsAt: null, resetCredits: 1, accountReported: true, snapshot: { ordinaryUsageAllowed: true, rateLimits: { planType: 'pro', primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: soon }, secondary: { usedPercent: 76, windowDurationMins: 10080, resetsAt: soon + 3 * 86400 }, credits: { hasCredits: true, unlimited: false, balance: '11.86' }, spendControlReached: false, rateLimitReachedType: null }, rateLimitResetCredits: { availableCount: 1 } } };
  },
  mcp_servers_get: ({ projectId }) => ({ servers: readJson(MCP_KEY, {})[projectId] || [], presets: structuredClone(MCP_PRESETS) }),
  mcp_servers_set: ({ projectId, servers = [] }) => {
    if (!Array.isArray(servers) || servers.length > 12) throw coded('INVALID_ARGUMENTS', 'A project can have at most 12 MCP servers.');
    const names = new Set();
    const clean = servers.map(s => {
      const name = String(s?.name || '').trim(), command = String(s?.command || '').trim();
      if (!/^[A-Za-z0-9_-]{1,48}$/.test(name)) throw coded('INVALID_ARGUMENTS', 'Name each MCP server with 1-48 letters, digits, \'_\' or \'-\'.');
      if (name.toLowerCase() === 'codaclauda' || names.has(name.toLowerCase())) throw coded('INVALID_ARGUMENTS', `The MCP server name ${name} is reserved or already used.`);
      if (!command) throw coded('INVALID_ARGUMENTS', `Give ${name} the program to run (one line, at most 1024 characters).`);
      names.add(name.toLowerCase());
      return { name, command, args: (s.args || []).map(String), env: { ...(s.env || {}) } };
    });
    const book = readJson(MCP_KEY, {});
    if (clean.length) book[projectId] = clean; else delete book[projectId];
    writeJson(MCP_KEY, book);
    return { servers: clean };
  },
  session_limits_get: () => ({ maxLive: readJson(LIMITS_KEY, 'unlimited'), queueMax: QUEUE_MAX }),
  session_limits_set: ({ maxLive }) => {
    const value = budget('Agents at once', maxLive, 1);
    writeJson(LIMITS_KEY, value);
    return { maxLive: value, queueMax: QUEUE_MAX };
  },
  notify_settings_get: () => readJson(NOTIFY_KEY, { ntfyUrl: null, onFinish: true, onError: true }),   // 0.6: on until a URL is the only step
  notify_settings_set: ({ ntfyUrl = null, onFinish = false, onError = false }) => {
    const url = String(ntfyUrl || '').trim();
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch { throw coded('INVALID_ARGUMENTS', 'Enter the full ntfy topic URL, for example https://ntfy.sh/your-topic.'); }
      if (parsed.protocol !== 'https:') throw coded('INVALID_ARGUMENTS', 'The ntfy topic URL must start with https://.');
      if (parsed.username || parsed.password) throw coded('INVALID_ARGUMENTS', 'Leave sign-in details out of the URL; use a hard-to-guess topic name instead.');
      if (!parsed.pathname.replace(/\//g, '')) throw coded('INVALID_ARGUMENTS', 'Add your topic to the URL, for example https://ntfy.sh/your-topic.');
    }
    const settings = { ntfyUrl: url ? new URL(url).toString() : null, onFinish: Boolean(onFinish), onError: Boolean(onError) };
    writeJson(NOTIFY_KEY, settings);
    return settings;
  },
  project_instructions_read: ({ cwd, file }) => {
    if (!['CLAUDE.md', 'AGENTS.md'].includes(file)) throw coded('INVALID_ARGUMENTS', 'file must be CLAUDE.md or AGENTS.md.');
    const text = readJson(INSTRUCTIONS_KEY, {})[`${cwd}|${file}`];
    return text == null ? { text: '', exists: false } : { text, exists: true };
  },
  project_instructions_write: ({ cwd, file, text = '' }) => {
    if (!['CLAUDE.md', 'AGENTS.md'].includes(file)) throw coded('INVALID_ARGUMENTS', 'file must be CLAUDE.md or AGENTS.md.');
    if (new TextEncoder().encode(String(text)).length > 200 * 1024) throw coded('FILE_TOO_LARGE', `${file} is limited to 200 KB here.`);
    const book = readJson(INSTRUCTIONS_KEY, {});
    book[`${cwd}|${file}`] = String(text);
    writeJson(INSTRUCTIONS_KEY, book);
    return { ok: true };
  },
  ci_status: ({ repo }) => {
    if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(String(repo || ''))) throw coded('INVALID_ARGUMENTS', 'repo must be owner/name.');
    const at = Date.now(), url = n => `https://github.com/${repo}/actions/runs/${n}`;
    const failing = /phaseforge|dgx/i.test(repo);
    return { runs: [
      { name: 'CI', title: 'Merge codaclauda/5f1c9a2e', status: 'completed', conclusion: failing ? 'failure' : 'success', branch: 'main', url: url(103), at: at - 25 * 60e3 },
      { name: 'CI', title: 'UI 0.5 polish', status: 'in_progress', conclusion: null, branch: 'claude/codaclauda-0.5', url: url(104), at: at - 4 * 60e3 },
      { name: 'Release', title: 'v0.4.0', status: 'completed', conclusion: 'success', branch: 'main', url: url(99), at: at - 26 * 3600e3 },
    ] };
  },
};

const desktopHandlers = {
  ...sessionHandlers,
  ...scheduleHandlers,
  ...v05Handlers,
  desktop_paths:() => ({ state_dir: 'C:\\mock\\board', ui_dir: 'C:\\mock\\board\\desktop-ui', attachments_dir: 'C:\\mock\\board\\desktop-ui\\attachments', manifest_path: 'C:\\mock\\board\\desktop-ui\\projects.manifest.json', desktop_dir: 'C:\\Users\\Ben\\Desktop' }),
  desktop_state_load: () => ({ state: JSON.parse(localStorage.getItem('mock.desktop') || 'null') }),
  desktop_state_save: ({ state }) => { localStorage.setItem('mock.desktop', JSON.stringify(state)); return { saved_at: now() }; },
  desktop_manifest_load: () => ({ path: 'C:\\mock\\manifest.json', manifest: { schema: 'codaclauda.projects/1', github_user: 'delores88', projects: [
    { name: 'CodaClauda', local_path: 'C:\\Users\\Ben\\Desktop\\CodaClauda', github: 'delores88/codaclauda', aliases: ['ClaudaCoda'], agents: ['claude-codaclauda', 'codex-claudacoda'] },
    { name: 'PhaseForge', local_path: 'D:\\PhaseForge-claude', github: 'delores88/phaseforge', agents: ['claude-phaseforge'] },
    { name: 'DeloresAI Marketplace', github: 'delores88/deloresai-marketplace', aliases: ['marketplace'], agents: ['codex-marketplace'] },
    { name: 'DGXBridge', github: 'delores88/dgxbridge', aliases: ['spark dev bridge', 'sparkdev'], agents: ['codex-dgxbridge'] },
    // Three City states on first load: linked repos above, remote-only outlines,
    // and these local folders with no GitHub identity in Suburbs.
    { name: 'Garden Notes', local_path: 'C:\\Users\\Ben\\Desktop\\GardenNotes' },
    { name: 'Workshop', local_path: 'C:\\Users\\Ben\\Desktop\\Workshop' },
  ] } }),
  project_scan: ({ path }) => stats(path, 14000 + (path.length * 997) % 40000, 180, 160, [['Rust', 0.55], ['JavaScript', 0.3], ['CSS', 0.15]]),
  desktop_discover_projects: () => ({ projects: [
    { name: 'CodaClauda', path: 'C:\\Users\\Ben\\Desktop\\CodaClauda', is_git: true, markers: ['Cargo.toml', 'package.json'] },
    { name: 'TuningSpork', path: 'C:\\Users\\Ben\\Desktop\\TuningSpork', is_git: true, markers: ['package.json'] },
    { name: 'scratch', path: 'C:\\Users\\Ben\\Desktop\\scratch', is_git: false, markers: [] },
  ] }),
  github_user: () => ({ login: 'delores88', source: 'mock' }),
  github_accounts: () => ({ accounts: [{ login: 'delores88', active: true }, { login: 'deloresai-work', active: false }] }),
  github_repos: ({ user }) => ({ user: user || 'delores88', source: 'mock', repos: String(user || '').toLowerCase() === 'deloresai-work' ? workRepos : repos }),
  github_clone_repo: async ({ fullName, parentDir }) => {
    await new Promise(resolve => setTimeout(resolve, 900 + Math.random() * 900));
    const name = String(fullName).split('/')[1];
    return { path: `${String(parentDir).replace(/[\/]+$/, '')}\${name}`, full_name: fullName, url: `https://github.com/${fullName}` };
  },
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

/** For node tests: the handler tables, without starting the preview timers. */
export const mockHandlers = () => ({ rpc: handlers, desktop: desktopHandlers, preview: { usageHold: mockUsageHold, usageStop: mockUsageStop } });

export function createMock({ search = globalThis.location?.search || '', baseURL = globalThis.location?.href, fetch: fetchImpl = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), storage = globalThis.sessionStorage, timers = true } = {}) {
  if (timers) { simulateJoins(); startMockTimers(); }
  const scenario = createPreviewScenario({ search, baseURL, fetchImpl, sleep, storage, statsForPath: path => desktopHandlers.project_scan({ path }) });
  return {
    async invoke(command, args = {}) {
      await sleep(40);
      try {
        if (command === 'rpc') {
          const fn = handlers[args.op];
          if (!fn) return { ok: false, error: { code: 'MOCK_UNSUPPORTED', message: `Preview has no mock for ${args.op}` } };
          return { ok: true, data: structuredClone(await fn(args.args || {})) };
        }
        const fn = desktopHandlers[command];
        if (!fn) return { ok: false, error: { code: 'MOCK_UNSUPPORTED', message: `Preview has no mock for ${command}` } };
        return { ok: true, data: structuredClone(await scenario.run(command, args, fn)) };
      } catch (error) { return { ok: false, error: { code: error.code || 'MOCK_ERROR', message: error.message } }; }
    },
    /** Mirrors Tauri's event listen for 'session://event' and 'schedule://event'; returns an unlisten function. */
    listen(event, cb) {
      const listeners = event === 'session://event' ? sessionListeners : event === 'schedule://event' ? scheduleListeners : null;
      if (!listeners) return () => {};
      if (event === 'session://event') sessions(); // loads the store, so fake wakes can start
      else schedules(); // loads the store, so due schedules run
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
