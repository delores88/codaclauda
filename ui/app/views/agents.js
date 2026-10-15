/* Agents roster: everyone who works on Ben's projects. Status, home and "now at"
 * come from the shared board (passive mailbox + dedicated endpoints).
 * Cards are keyed by agent id and rebuilt only when their content signature
 * changes, so focus, open selects and in-progress nickname edits survive the
 * store's frequent 'change' events. */
import { HAIR_STYLES, HAIR_COLORS, ACCESSORIES, normalizeAvatar } from '../avatar/spec.js';

const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'active', label: 'Working', test: a => a.status === 'active' },
  { id: 'idle', label: 'Awake', test: a => a.status === 'idle' },
  { id: 'offline', label: 'Powered down', test: a => a.status === 'offline' },
];
const PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex', other: 'Agent' };
const PROVIDER_PILL = { claude: 'claude', codex: 'codex', other: 'accent' };
const HAIR_LABEL = { short: 'Short', messy: 'Messy', buzz: 'Buzz', curly: 'Curly', long: 'Long', ponytail: 'Ponytail', bun: 'Bun', mohawk: 'Mohawk', bald: 'Bald' };
const ACCESSORY_LABEL = { none: 'None', glasses: 'Glasses', sunglasses: 'Shades', cap: 'Cap', beanie: 'Beanie', headphones: 'Headphones', crown: 'Crown' };
const TOP_COLORS = ['#d97757', '#10a37f', '#7c6cf2', '#2f6fed', '#e0475b', '#f5b544', '#3ccf8e', '#22c7a9', '#ff6fae', '#2b2b33', '#f2f2f5', '#5a3a26'];
const ACCESSORY_COLORS = ['#222222', '#3a2318', '#0b2e26', '#5b6cff', '#d97757', '#e0475b', '#f2f2f5'];
const ASK_COOLDOWN = 30 * 60e3;
const HEARTBEAT_COPY = 'Desktop chats see new messages when they next check their inbox. Each one has its own schedule and sending does not wake it, so replies are not instant.';

const normalizePath = path => String(path || '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const pickRandom = list => list[Math.floor(Math.random() * list.length)];
const providerKey = provider => (provider in PROVIDER_LABEL ? provider : 'other');

export function mount(root, ctx) {
  const { store, ui, navigate } = ctx;
  const { h, icon, portrait, toast, modal, timeAgo, fullTime, emptyState, clear, toMs, STATUS_LABEL } = ui;

  ui.registerIcons({
    pulse: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  });

  const state = { filter: 'all', query: '', visible: false, dirty: true, frame: 0 };
  const cards = new Map();      // agent id -> { node, sig }
  let statusChecks = new Map(); // mailbox address -> { at, read } for an unanswered "Status check"

  /* ---------- static skeleton ---------- */
  const countNodes = {};
  const filterButtons = FILTERS.map(filter => {
    const count = h('span.count', '0');
    countNodes[filter.id] = count;
    return h('button', { type: 'button', 'aria-pressed': String(filter.id === state.filter), dataset: { filter: filter.id }, onclick: () => setFilter(filter.id) }, filter.label, count);
  });
  const searchInput = h('input.input', {
    type: 'search', placeholder: 'Search agents, projects, activity…', 'aria-label': 'Search agents', autocomplete: 'off',
    oninput: event => { state.query = event.currentTarget.value; schedule(); },
    onkeydown: event => { if (event.key === 'Escape' && event.currentTarget.value) { event.currentTarget.value = ''; state.query = ''; schedule(); } },
  });
  const grid = h('div.agents-grid', { role: 'list', 'aria-label': 'Agents', onfocusout: () => schedule() });
  const emptySlot = h('div.agents-empty', { hidden: true });

  root.classList.add('agents-view');
  clear(root, h('div.page.agents-page',
    h('header.page-head',
      h('div',
        h('span.eyebrow', 'Team'),
        h('h1', 'Agents'),
        h('p', 'Everyone who works on your projects. Status comes from the shared board: Working = active in the last 20 min or holding a claim; Awake = active in the last 3 h; Powered down = quiet longer.'),
      ),
      h('button.btn.primary', { type: 'button', onclick: () => navigate('connect') }, icon('agentAdd'), 'Add a desktop chat'),
    ),
    h('div.agents-toolbar',
      h('div.segmented', { role: 'group', 'aria-label': 'Filter by status' }, filterButtons),
      h('div.agents-search', icon('search'), searchInput),
    ),
    grid,
    emptySlot,
    h('div.agents-tips',
      h('aside.card.agents-tip',
        h('span.agents-tip-icon', icon('pin')),
        h('div',
          h('strong', 'Where agents work'),
          h('p', 'Agents tell CodaClauda where they\'re working by putting ', h('code', '[Project Name]'), ' in a message subject or a ', h('code', 'Project: Name'), ' line — their character walks to that building.'),
        ),
      ),
      h('aside.card.agents-tip',
        h('span.agents-tip-icon', icon('clock')),
        h('div',
          h('strong', 'How fast they answer'),
          h('p', `${HEARTBEAT_COPY} Live workers start a fresh session for each message and usually answer in 30–90 s. A message is information, not permission.`),
        ),
      ),
    ),
  ));

  /* ---------- rendering ---------- */
  function schedule() {
    if (!state.visible) { state.dirty = true; return; }
    if (!state.frame) state.frame = requestAnimationFrame(render);
  }

  function setFilter(id) {
    state.filter = id;
    for (const button of filterButtons) button.setAttribute('aria-pressed', String(button.dataset.filter === id));
    schedule();
  }

  function projectName(id) { return id ? store.project(id)?.name || '' : ''; }

  function haystack(agent) {
    return [agent.name, agent.label, agent.address, agent.endpointId, PROVIDER_LABEL[providerKey(agent.provider)], STATUS_LABEL[agent.status],
      agent.activity, projectName(agent.homeProjectId), projectName(agent.currentProjectId), ...agent.claims.map(c => c.resource)]
      .filter(Boolean).join(' ').toLowerCase();
  }

  /** Latest unanswered owner "Status check" per mailbox address (computed once per render). */
  function indexStatusChecks() {
    const messages = store.mailboxMessages;
    const answered = new Set(messages.filter(m => m.reply_to).map(m => m.reply_to));
    const latest = new Map();
    for (const m of messages) {
      if (m.from === 'owner' && m.kind === 'question' && /status check/i.test(m.subject || '')) latest.set(m.to, m);
    }
    const out = new Map();
    for (const [address, m] of latest) if (!answered.has(m.id)) out.set(address, { at: toMs(m.created_at), read: Boolean(m.read_at) });
    return out;
  }

  function seenText(agent) {
    if (agent.lastSeenAt) return `seen ${timeAgo(agent.lastSeenAt)}`;
    return agent.kind === 'dedicated' ? 'no recent runs' : 'not seen on the board yet';
  }

  function claimExpiry(claim) {
    const minutes = Math.round((toMs(claim.expires_at) - Date.now()) / 60e3);
    if (!Number.isFinite(minutes)) return '';
    if (minutes < 1) return 'expires now';
    return minutes < 60 ? `${minutes} min left` : `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
  }

  /** What "Automatic" resolves to when Ben has not picked a home (mirrors store.agentRecord). */
  function autoHome(agent, projects) {
    const manifest = projects.find(p => p.homeAgents.includes(agent.id));
    if (manifest) return manifest;
    if (agent.kind === 'dedicated') {
      const endpoint = store.board.endpoints.find(e => e.id === agent.endpointId);
      const workspace = normalizePath(endpoint?.workspace);
      const match = workspace && projects.find(p => p.path && normalizePath(p.path) === workspace);
      if (match) return match;
    }
    return store.matchProject(agent.label, projects) || null;
  }

  function signature(agent, projectSig) {
    const check = statusChecks.get(agent.address);
    const recent = Boolean(check && Date.now() - check.at < ASK_COOLDOWN);
    return JSON.stringify([
      agent.name, agent.label, agent.provider, agent.kind, agent.address, agent.endpointId, agent.status, seenText(agent),
      agent.homeProjectId, agent.currentProjectId, agent.visiting, agent.activity, agent.unreadForOwner,
      agent.claims.map(c => [c.resource, c.purpose, claimExpiry(c)]), agent.look, projectSig,
      store.desktop.agents?.[agent.id]?.home || '', recent && [timeAgo(check.at), check.read],
    ]);
  }

  function render() {
    state.frame = 0;
    if (!state.visible) { state.dirty = true; return; }
    state.dirty = false;
    root.classList.toggle('reduce-motion', Boolean(store.prefs.reducedMotion));

    const agents = store.agents;
    const projects = store.projects;
    statusChecks = indexStatusChecks();
    for (const filter of FILTERS) countNodes[filter.id].textContent = String(agents.filter(filter.test).length);

    const query = state.query.trim().toLowerCase();
    const filterTest = FILTERS.find(f => f.id === state.filter)?.test || (() => true);
    const shown = agents.filter(a => filterTest(a) && (!query || haystack(a).includes(query)));
    const projectSig = projects.map(p => `${p.id}=${p.name}`).join('|');

    const keep = new Set();
    shown.forEach((agent, index) => {
      keep.add(agent.id);
      const sig = signature(agent, projectSig);
      let entry = cards.get(agent.id);
      if (!entry || entry.sig !== sig) {
        const active = document.activeElement;
        const focusInside = Boolean(entry && active && entry.node.contains(active));
        // Never yank an open <select> or an in-progress nickname edit; retry after focus leaves.
        if (!(focusInside && active.matches('input, select, textarea'))) {
          const node = buildCard(agent, projects);
          if (entry) {
            const key = focusInside ? active.dataset.fk : null;
            entry.node.replaceWith(node);
            if (key) node.querySelector(`[data-fk="${key}"]`)?.focus({ preventScroll: true });
          }
          entry = { node, sig };
          cards.set(agent.id, entry);
        }
      }
      const at = grid.children[index];
      if (at !== entry.node) grid.insertBefore(entry.node, at || null);
    });
    for (const [id, entry] of cards) if (!keep.has(id)) { entry.node.remove(); cards.delete(id); }

    grid.hidden = !shown.length;
    emptySlot.hidden = Boolean(shown.length);
    if (!shown.length) {
      const key = agents.length ? 'filtered' : 'none';
      if (emptySlot.dataset.kind !== key) {
        emptySlot.dataset.kind = key;
        clear(emptySlot, agents.length
          ? emptyState('search', 'No agents match', 'Try another status or search term.', h('button.btn', { type: 'button', onclick: () => { searchInput.value = ''; state.query = ''; setFilter('all'); } }, 'Clear filters'))
          : emptyState('agents', 'No agents on the board yet',
            'Agents appear here when a Claude or Codex desktop chat registers a mailbox on the board, or when a connected agent runs a live chat.',
            h('button.btn.primary', { type: 'button', onclick: () => navigate('chat') }, icon('chat'), 'Start a chat'),
            h('button.btn', { type: 'button', onclick: () => navigate('connect') }, icon('agentAdd'), 'Connect agents')));
      }
    } else emptySlot.dataset.kind = '';
  }

  /* ---------- card ---------- */
  function buildCard(agent, projects) {
    const provider = providerKey(agent.provider);
    const current = agent.currentProjectId ? store.project(agent.currentProjectId) : null;
    const home = agent.homeProjectId ? store.project(agent.homeProjectId) : null;

    const node = h(`article.card.agent-card.status-${agent.status}.provider-${provider}`, {
      role: 'listitem', tabIndex: -1, dataset: { agentId: agent.id }, 'aria-label': `${agent.name}, ${STATUS_LABEL[agent.status] || agent.status}`,
    });

    const avatarButton = h('button.agent-avatar', { type: 'button', title: 'Customize look', 'aria-label': `Customize ${agent.name}'s look`, dataset: { fk: 'avatar' }, onclick: () => openLookEditor(agent) },
      portrait(agent.look, { size: 56, provider, status: agent.status, title: agent.name }),
      h('span.agent-avatar-edit', icon('edit')));

    const kindLine = agent.kind === 'mailbox'
      ? h('div.agent-kind', { title: `Existing desktop chat that reads mailbox "${agent.address}" on its heartbeat` }, 'Desktop chat · mailbox ', h('code', agent.address))
      : h('div.agent-kind', { title: 'Dedicated worker: each message starts a fresh, owner-authorized session' }, 'Live worker · ', h('code', agent.endpointId));

    const top = h('div.agent-top',
      avatarButton,
      h('div.agent-ident',
        h('div.agent-name-row', nameEditor(agent), h(`span.pill.${PROVIDER_PILL[provider]}`, PROVIDER_LABEL[provider])),
        agent.name !== agent.label ? h('div.agent-label', { title: `Original name: ${agent.label}` }, agent.label) : null,
        kindLine,
      ),
      agent.unreadForOwner
        ? h('button.agent-unread', { type: 'button', dataset: { fk: 'unread' }, title: `${agent.unreadForOwner} unread message${agent.unreadForOwner === 1 ? '' : 's'} for you`, 'aria-label': `${agent.unreadForOwner} unread from ${agent.name}. Open chat`, onclick: () => navigate('chat', { agentId: agent.id }) }, `${agent.unreadForOwner > 99 ? '99+' : agent.unreadForOwner} new`)
        : null,
    );

    const statusLine = h('div.agent-status', { title: agent.lastSeenAt ? `Last activity ${fullTime(agent.lastSeenAt)}` : '' },
      h(`span.status-dot.${agent.status}`),
      h(`strong.status-word.${agent.status}`, STATUS_LABEL[agent.status] || agent.status),
      h('span.muted', `· ${seenText(agent)}`));

    const facts = h('dl.agent-facts',
      h('div.agent-fact', h('dt', 'Home'), h('dd', homeSelect(agent, projects))),
      h('div.agent-fact', h('dt', 'Now at'), h('dd',
        current
          ? h('span.agent-place', { title: current.path || current.repo?.full_name || current.name }, icon(current.id === home?.id ? 'home' : 'pin'), h('span.agent-place-name', current.name))
          : h('span.agent-place.muted', icon('home'), h('span.agent-place-name', 'HQ')),
        agent.visiting ? h('span.pill.accent.agent-visiting', { title: home ? `Visiting from ${home.name}` : 'Away from home' }, 'visiting') : null)),
      h('div.agent-fact', h('dt', 'Doing'), h('dd',
        agent.activity
          ? h('span.agent-activity', { title: agent.activity }, agent.activity)
          : h('span.agent-activity.muted', agent.status === 'offline' ? 'Nothing recent' : 'Nothing reported yet'))),
      agent.claims.length ? h('div.agent-fact', h('dt', 'Holding'), h('dd.agent-claims',
        agent.claims.map(claim => h('span.pill.agent-claim', { title: [claim.purpose, claimExpiry(claim)].filter(Boolean).join(' · ') }, icon('lock'), claim.resource)))) : null,
    );

    const actions = h('div.agent-actions',
      h('button.btn.small.primary', { type: 'button', dataset: { fk: 'chat' }, onclick: () => navigate('chat', { agentId: agent.id }) }, icon('chat'), 'Chat'),
      h('button.btn.small', { type: 'button', dataset: { fk: 'city' }, onclick: () => navigate('city', { focusAgent: agent.id }) }, icon('city'), 'Show in City'),
      agent.kind === 'mailbox' ? askButton(agent) : null,
      h('button.btn.small.ghost', { type: 'button', dataset: { fk: 'look' }, onclick: () => openLookEditor(agent) }, icon('sparkle'), 'Customize look'),
    );

    node.append(top, statusLine, facts, actions);
    return node;
  }

  function homeSelect(agent, projects) {
    const chosen = store.desktop.agents?.[agent.id]?.home;
    const manual = chosen ? projects.find(p => p.ids.includes(chosen)) : null;
    const auto = autoHome(agent, projects);
    return h('select.select.agent-home', {
      'aria-label': `Home project for ${agent.name}`, dataset: { fk: 'home' },
      title: manual ? 'Chosen by you' : auto ? 'Detected from the manifest, workspace or name' : 'No home project',
      onchange: event => {
        const value = event.currentTarget.value || null;
        store.setAgentPrefs(agent.id, { home: value });
        event.currentTarget.blur();
      },
    },
    h('option', { value: '', selected: !manual }, auto ? `Automatic · ${auto.name}` : 'None (HQ)'),
    projects.map(p => h('option', { value: p.id, selected: manual?.id === p.id }, p.name)));
  }

  function nameEditor(agent) {
    const wrap = h('h3.agent-name');
    const showName = () => clear(wrap, h('button.agent-name-btn', { type: 'button', title: 'Rename (nickname only — routing is unchanged)', 'aria-label': `Rename ${agent.name}`, dataset: { fk: 'name' }, onclick: edit },
      h('span.agent-name-text', agent.name), icon('edit', 'agent-name-icon')));
    function edit() {
      let done = false;
      const input = h('input.input.agent-name-input', {
        value: agent.name, maxLength: 40, placeholder: agent.label, 'aria-label': `Nickname for ${agent.label}. Leave empty to use the original name.`,
        onkeydown: event => {
          if (event.key === 'Enter') { event.preventDefault(); commit(true, true); }
          else if (event.key === 'Escape') { event.preventDefault(); commit(false, true); }
        },
        onblur: () => commit(true, false),
      });
      function commit(save, refocus) {
        if (done) return;
        done = true;
        const value = input.value.trim();
        showName();
        if (refocus) wrap.querySelector('button')?.focus();
        if (!save) return;
        const nickname = value && value !== agent.label ? value : null;
        const previous = store.desktop.agents?.[agent.id]?.nickname || null;
        if (nickname !== previous) {
          store.setAgentPrefs(agent.id, { nickname });
          toast(nickname ? `Renamed to ${nickname}` : `Back to ${agent.label}`, { kind: 'success', timeout: 2200 });
        }
      }
      clear(wrap, input);
      input.focus();
      input.select();
    }
    showName();
    return wrap;
  }

  function askButton(agent) {
    const check = statusChecks.get(agent.address);
    const recent = check && Date.now() - check.at < ASK_COOLDOWN;
    return h('button.btn.small', {
      type: 'button', dataset: { fk: 'ask' }, disabled: Boolean(recent),
      title: recent
        ? `You asked ${timeAgo(check.at)} — ${check.read ? 'they have read it and a reply is pending' : 'not read yet'}. ${HEARTBEAT_COPY}`
        : `Posts a short status question to ${agent.address}. ${HEARTBEAT_COPY}`,
      onclick: event => askStatus(agent, event.currentTarget),
    }, icon('pulse'), recent ? (check.read ? 'Read · reply pending' : `Asked ${timeAgo(check.at)}`) : 'Ask for status');
  }

  async function askStatus(agent, button) {
    const project = agent.currentProjectId ? store.project(agent.currentProjectId) : null;
    const subject = `${project ? `[${project.name}] ` : ''}Status check`;
    const body = [
      `Hi ${agent.name}, quick status check from Ben.`,
      '',
      '- What are you working on right now?',
      '- What is next?',
      '- Is anything blocked or waiting on me?',
      '',
      project ? `Project: ${project.name}` : null,
      'Please reply on this thread when you next check the board. This message is information, not a new grant of authority.',
    ].filter(line => line !== null).join('\n');
    button.disabled = true;
    try {
      await store.post({ to: agent.address, kind: 'question', subject, body });
      toast(`Asked ${agent.name} for a status update. ${HEARTBEAT_COPY}`, { kind: 'success', timeout: 7000 });
    } catch (error) {
      button.disabled = false;
      toast(`Could not post the status check: ${error.message}`, { kind: 'error' });
    }
  }

  /* ---------- look editor ---------- */
  function openLookEditor(agent) {
    const provider = providerKey(agent.provider);
    let spec = normalizeAvatar(agent.look);
    const groups = []; // { nodes, get } kept in sync after every change
    const previewSlot = h('div.look-preview');
    const paint = () => {
      clear(previewSlot, portrait(spec, { size: 112, provider, status: agent.status, title: agent.name }));
      for (const group of groups) group.sync();
    };
    const update = fn => { const draft = structuredClone(spec); fn(draft); spec = normalizeAvatar(draft); paint(); };

    const chips = (label, list, labels, get, set) => {
      const buttons = list.map(value => h('button.look-chip', { type: 'button', role: 'radio', dataset: { value }, onclick: () => update(d => set(d, value)) }, labels[value] || value));
      groups.push({ sync: () => { for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === get(spec))); } });
      return h('div.look-section', h('span.look-label', label), h('div.look-chips', { role: 'radiogroup', 'aria-label': label }, buttons));
    };
    const swatches = (label, colors, get, set) => {
      const buttons = colors.map(color => {
        const b = h('button.look-swatch', { type: 'button', role: 'radio', title: color, 'aria-label': `${label} ${color}`, dataset: { value: color }, onclick: () => update(d => set(d, color)) });
        b.style.setProperty('--swatch', color);
        return b;
      });
      const custom = h('input.look-color', { type: 'color', title: 'Custom color', 'aria-label': `Custom ${label.toLowerCase()}`, oninput: event => update(d => set(d, event.currentTarget.value)) });
      groups.push({ sync: () => {
        const value = get(spec);
        for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === value));
        if (custom.value !== value) custom.value = value;
      } });
      return h('div.look-section', h('span.look-label', label), h('div.look-swatches', { role: 'radiogroup', 'aria-label': label }, buttons, custom));
    };

    const randomize = () => update(d => {
      d.hair.style = pickRandom(HAIR_STYLES);
      d.hair.color = pickRandom(HAIR_COLORS);
      d.top.color = pickRandom(TOP_COLORS);
      d.accessory = pickRandom(ACCESSORIES);
      d.accessoryColor = pickRandom(ACCESSORY_COLORS);
    });

    const body = h('div.look-editor',
      h('div.look-preview-pane',
        previewSlot,
        h('strong.look-name', agent.name),
        h('button.btn.small', { type: 'button', onclick: randomize }, icon('dice'), 'Randomize'),
        h('p.field-hint', 'Also changes their character in the City.'),
      ),
      h('div.look-controls',
        chips('Hair style', HAIR_STYLES, HAIR_LABEL, s => s.hair.style, (d, v) => { d.hair.style = v; }),
        swatches('Hair color', HAIR_COLORS, s => s.hair.color, (d, v) => { d.hair.color = v; }),
        swatches('Top color', TOP_COLORS, s => s.top.color, (d, v) => { d.top.color = v; }),
        chips('Accessory', ACCESSORIES, ACCESSORY_LABEL, s => s.accessory, (d, v) => { d.accessory = v; }),
      ),
    );
    paint();

    modal({
      title: `Customize ${agent.name}`,
      body,
      actions: [
        { label: 'Reset to default', kind: 'ghost.look-reset', run: () => { store.setAgentPrefs(agent.id, { look: null }); toast(`${agent.name} is back to their default look`, { kind: 'success', timeout: 2400 }); } },
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Save look', kind: 'primary', run: () => { store.setAgentPrefs(agent.id, { look: { ...spec, name: agent.name } }); toast(`Saved ${agent.name}'s look`, { kind: 'success', timeout: 2400 }); } },
      ],
    });
  }

  /* ---------- deep links ---------- */
  function focusAgent(target) {
    const agent = store.agents.find(a => a.id === target || a.address === target || a.endpointId === target || `endpoint:${target}` === a.id);
    const entry = agent && cards.get(agent.id);
    if (!entry) return;
    const reduce = Boolean(store.prefs.reducedMotion) || matchMedia('(prefers-reduced-motion: reduce)').matches;
    entry.node.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    entry.node.focus({ preventScroll: true });
    entry.node.classList.remove('flash');
    void entry.node.offsetWidth; // restart the highlight animation
    entry.node.classList.add('flash');
    setTimeout(() => entry.node.classList.remove('flash'), 2600);
  }

  store.on('change', schedule);

  return {
    show(params = {}) {
      state.visible = true;
      const target = params.agent || params.agentId || params.focusAgent;
      if (target) { searchInput.value = ''; state.query = ''; setFilter('all'); }
      if (state.frame) { cancelAnimationFrame(state.frame); state.frame = 0; }
      render();
      if (target) focusAgent(target);
    },
    hide() {
      state.visible = false;
      if (state.frame) { cancelAnimationFrame(state.frame); state.frame = 0; state.dirty = true; }
    },
  };
}
