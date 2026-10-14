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
  { id: 'claude-claudacoda', agent: 'claude', label: 'Claude Code - CodaClauda', workspace: 'C:\\Users\\Benny\\OneDrive\\Desktop\\CodaClauda', auth_status: 'authenticated' },
  { id: 'codex-claudacoda', agent: 'codex', label: 'Codex - CodaClauda', workspace: 'C:\\Users\\Benny\\OneDrive\\Desktop\\CodaClauda', auth_status: 'authenticated' },
];
const requests = [
  { id: 'req-1', kind: 'question', origin: 'owner', target: 'codex-claudacoda', state: 'completed', prompt: 'Read README and list both endpoint labels.', expected_result: 'Labels and IDs.', created_at: ago(400), updated_at: ago(398), answer: 'Claude Code - CodaClauda and Codex - CodaClauda.' },
  { id: 'req-2', kind: 'review', origin: 'owner', target: 'claude-claudacoda', state: 'needs-owner', prompt: 'Review the installer manifest.', expected_result: 'Findings', created_at: ago(90), updated_at: ago(88), blocker: 'Grant expired before review completed.' },
];
const grants = [];
const liveRequests = new Map();

const repos = [
  ['codaclauda', 'Owner-scoped Claude Code and Codex coordination', 'Rust', 2400, 160, 0.2],
  ['phaseforge', 'Procedural Blender pipeline with agent chat', 'Python', 58000, 1240, 0.1],
  ['deloresai-marketplace', 'DeloresAI app marketplace', 'TypeScript', 31000, 610, 2],
  ['dgxbridge', 'Spark dev bridge for DGX', 'Rust', 9800, 280, 5],
  ['tuningspork', 'Audio tuning toy', 'JavaScript', 1200, 48, 40],
  ['dotfiles', 'Machine setup', 'Shell', 90, 12, 200],
].map(([name, description, language, size_kb, commit_count, days]) => ({ name, full_name: `delores88/${name}`, description, language, size_kb, commit_count, url: `https://github.com/delores88/${name}`, private: name === 'phaseforge', pushed_at: new Date(Date.now() - days * 86400e3).toISOString(), stars: Math.round(size_kb / 900), default_branch: 'main' }));

const stats = (path, loc, files, commits, langs) => ({ path, name: path.split(/[\\/]/).pop(), files, bytes: loc * 38, loc, languages: langs.map(([name, share]) => ({ name, bytes: Math.round(loc * 38 * share) })), git: { commits, commits_7d: Math.min(commits, 14), last_commit_at: ago(30), branch: 'main', remote: '' }, truncated: false });

function mockReply(to, subject) {
  setTimeout(() => {
    messages.push(msg(to, 'owner', 'reply', `Re: ${subject}`, `Got it — working on **${subject}** now.\n\n- [x] Read your message\n- [ ] Make the change\n\nInline math works too: $e^{i\\pi}+1=0$.`, 0));
  }, 7000);
}

const answer = `Here's a quick example.\n\n## Fibonacci in Rust\n\n\`\`\`rust\nfn fib(n: u64) -> u64 {\n    match n { 0 => 0, 1 => 1, _ => fib(n - 1) + fib(n - 2) }\n}\n\`\`\`\n\nThe closed form is $$F_n = \\frac{\\varphi^n - \\psi^n}{\\sqrt 5}$$ where $\\varphi = \\tfrac{1+\\sqrt5}{2}$.\n\n| n | F(n) |\n|---|------|\n| 10 | 55 |\n| 20 | 6765 |\n\n> Tip: memoize for large \`n\`.`;

const sparkJob = (job, where, client, runtime, cpu, minutesAgo, done = null) => ({ job, where, client, runtime, cpu, reserved_cpu: cpu, memory_gb: cpu * 2, reserved_memory_gb: cpu * 2, project: `mock-${job}`, state: done ? 'succeeded' : 'running', created_at: ago(minutesAgo), started_at: ago(minutesAgo), finished_at: done ? ago(done) : null, exit_code: done ? 0 : null });
const sparkStatus = () => ({
  ok: true, hardware: { cpu_count: 20, memory_gb: 119 }, limits: { cpu_total: 18, memory_gb_total: 80, cpu_per_job: 16 },
  scheduler: { healthy: true, last_heartbeat: now() }, transport: { authenticated: true, route: 'lan_ssh' },
  jobs: [sparkJob('j1', 'spark', 'codex', 'rust', 8, 12), sparkJob('j2', 'spark', 'claude', 'python', 4, 5), sparkJob('j3', 'spark', 'codex', 'node', 2, 300, 260), sparkJob('j4', 'spark', 'claude', 'rust', 16, 600, 540)],
  laptop_jobs: [sparkJob('j5', 'laptop', 'claude', 'rust', 6, 3), sparkJob('j6', 'laptop', 'codex', 'node', 2, 200, 180)],
});
const handlers = {
  status: () => ({ endpoints, grants, requests: [...requests, ...liveRequests.values()], paused: false, state_dir: 'C:\\mock\\board', spark: { executable: 'C:\\mock\\sparkdev.exe' } }),
  spark: () => sparkStatus(),
  'mailbox-directory': () => ({ addresses }),
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
  cancel: ({ id }) => { const r = liveRequests.get(id); if (r) r.state = 'cancelled'; return { ok: true }; },
};

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
  attachment_save: ({ name }) => ({ path: `C:\\mock\\board\\desktop-ui\\attachments\\${name}`, name, bytes: 1234 }),
  dictation_start: () => ({ started: false, reason: 'Browser preview: use the desktop app for Windows voice typing.' }),
  window_attention: () => ({}),
  pick_workspace: () => ({ path: 'C:\\Users\\Ben\\Desktop\\NewProject' }),
  preferences: () => ({ cli_path: 'C:\\mock\\claudacoda-cli.exe', state_dir: 'C:\\mock\\board', version: '0.3.0-preview' }),
};

export function createMock() {
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
