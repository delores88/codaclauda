/* First-party ClaudaCoda desktop UI. No remote content, dependencies, or seeded data. */
'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { endpoints: [], grants: [], requests: [], spark: null, paused: false };
const terminal = new Set(['completed', 'failed', 'cancelled', 'needs-owner']);
const names = { codex: 'Codex', claude: 'Claude Code' };
const kindIcons = { question: 'message', review: 'check', delegate: 'branch' };
const pageSize = 6;
const requestPages = { inbox: 1, history: 1 };
const connectionPages = { codex: 1, claude: 1 };
let view = 'board';
let filter = 'all';
let selectedRequest = null;
let refreshing = false;
let discovered = [];
let discoveryPhase = 'idle';
let discoveryPromise = null;
let toastTimer;
let pendingSubmission = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function icon(name) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('class', 'icon'); node.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`); node.append(use); return node;
}
function button(label, classes, action, iconName) {
  const node = element('button', classes, label); node.type = 'button';
  if (iconName) node.prepend(icon(iconName));
  node.addEventListener('click', action); return node;
}
function badge(value) {
  const known = ['completed', 'running', 'queued', 'delivered', 'acknowledged', 'failed', 'cancelled', 'needs-owner'];
  return element('span', `badge ${known.includes(value) ? value : 'neutral'}`, readable(value));
}
function readable(value) { return String(value ?? 'Unavailable').replaceAll('_', ' ').replaceAll('-', ' '); }
function endpoint(id) { return state.endpoints.find(item => item.id === id); }
function endpointLabel(item) { return item?.label?.trim() || names[item?.agent] || item?.id || 'Unknown agent'; }
function labelFor(id) {
  if (id === 'owner') return 'You';
  const item = endpoint(id); if (!item) return id || 'Unknown agent';
  const label = endpointLabel(item); const provider = names[item.agent] || item.agent;
  return label === provider ? label : `${label} · ${provider}`;
}
function compact(value, limit = 130) { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; }
function when(value) {
  if (!value) return 'Time unavailable';
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function showError(target, error) { target.textContent = error.message || String(error); target.classList.remove('hidden'); }
function clearError(target) { target.textContent = ''; target.classList.add('hidden'); }
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.remove('hidden'); toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 4800); }
async function invoke(command, arguments_) {
  const api = window.__TAURI__?.core;
  if (!api) throw new Error('Open the installed ClaudaCoda desktop application to connect to your local board. This browser preview has no coordination service.');
  const result = await api.invoke(command, arguments_);
  if (!result || result.ok !== true) {
    const error = new Error(result?.error?.message || 'The local operation failed.');
    error.code = result?.error?.code || 'UNKNOWN_ERROR'; throw error;
  }
  return result.data;
}
async function rpc(op, args = {}) { return invoke('rpc', { op, args }); }
async function busy(control, action) {
  const original = control.disabled; control.disabled = true; control.classList.add('busy');
  try { return await action(); } finally { control.disabled = original; control.classList.remove('busy'); }
}
function switchView(next) {
  view = next;
  $$('.page-view').forEach(node => node.classList.toggle('hidden', node.id !== `view-${next}`));
  $$('.nav-item').forEach(node => node.classList.toggle('active', node.dataset.view === next));
  $('#view-label').textContent = { board: 'Workbench', history: 'History', connections: 'Connections' }[next];
  render();
}
function renderConnections(container, settings = false) {
  const providers = ['codex', 'claude'];
  const pages = {};
  for (const agent of providers) {
    pages[agent] = pageSlice(state.endpoints.filter(item => item.agent === agent), connectionPages[agent]);
    connectionPages[agent] = pages[agent].page;
  }
  const signature = JSON.stringify([state.endpoints, settings ? connectionPages : null, discoveryPhase, discovered]);
  if (container.dataset.signature === signature) return;
  const focused = container.contains(document.activeElement) ? document.activeElement.id : null;
  container.dataset.signature = signature;
  container.replaceChildren();
  for (const agent of providers) {
    const endpoints = state.endpoints.filter(item => item.agent === agent);
    const card = element('article', `connection-card ${agent}`);
    const top = element('div', 'connection-top');
    const glyph = element('div', `agent-icon ${agent}`, agent === 'codex' ? 'Cₓ' : 'C');
    const title = element('div', 'connection-title'); title.append(element('h2', '', names[agent]), element('span', '', agent === 'codex' ? 'OpenAI CLI' : 'Anthropic CLI'));
    const detection = detectionFor(agent);
    top.append(glyph, title, badge(detection.status)); card.append(top);
    card.append(element('p', 'connection-detection', detection.message));
    if (!endpoints.length) {
      const footer = element('div', 'connection-footer'); footer.append(element('span', 'connection-mode', 'Dedicated sessions'), button(`Connect ${names[agent]}`, 'button secondary small', () => openConnect(agent), 'plus')); card.append(footer);
    } else {
      const workspaces = element('div', settings ? 'endpoint-list' : '');
      if (settings) { workspaces.id = `${agent}-connection-list`; workspaces.tabIndex = 0; workspaces.setAttribute('role', 'region'); workspaces.setAttribute('aria-label', `${names[agent]} connections`); }
      for (const item of (settings ? pages[agent].items : endpoints.slice(-1))) {
        const info = element('div', 'endpoint-info');
        const identity = element('div', 'endpoint-identity'); identity.append(element('h3', '', labelFor(item.id)));
        if (settings) identity.append(button('Rename', 'button subtle small', () => openLabelEditor(item)));
        info.append(identity);
        const path = element('div', 'workspace-path'); path.title = item.workspace; path.append(icon('folder'), element('span', '', item.workspace));
        info.append(path, element('p', 'endpoint-meta', `${item.version || 'Version unavailable'} · Last connection: ${readable(item.auth_status)}`));
        if (settings) info.append(element('code', 'endpoint-id', `Agent ID: ${item.id}`), element('code', 'endpoint-executable', item.executable));
        workspaces.append(info);
      }
      card.append(workspaces);
      if (settings) {
        const slice = pages[agent];
        const pagination = element('nav', 'request-pagination connection-pagination'); pagination.setAttribute('aria-label', `${names[agent]} connection pages`);
        const summary = element('span', 'page-summary', `${slice.first}–${slice.last} of ${slice.total} connection${slice.total === 1 ? '' : 's'}`); summary.setAttribute('aria-live', 'polite'); summary.setAttribute('aria-atomic', 'true');
        const controls = element('div', 'page-controls');
        for (const [direction, step] of [['Previous', -1], ['Next', 1]]) {
          if (step === 1) controls.append(element('span', 'page-position', `Page ${slice.page} of ${slice.pages}`));
          const control = button(direction, 'button secondary small', () => { connectionPages[agent] += step; renderConnections(container, true); });
          control.id = `${agent}-connection-${direction.toLowerCase()}`; control.disabled = step === -1 ? slice.page === 1 : slice.page === slice.pages;
          control.setAttribute('aria-label', `${direction} ${names[agent]} connections page`); control.setAttribute('aria-controls', workspaces.id); controls.append(control);
        }
        pagination.append(summary, controls); card.append(pagination);
      }
      const footer = element('div', 'connection-footer');
      footer.append(element('span', 'connection-mode', `${endpoints.length} connection${endpoints.length === 1 ? '' : 's'}`), button(settings ? 'Add connection' : 'Manage', 'button subtle small', () => settings ? openConnect(agent) : switchView('connections'), settings ? 'plus' : 'arrow')); card.append(footer);
    }
    container.append(card);
  }
  if (focused) {
    const control = document.getElementById(focused);
    (control?.disabled ? control.closest('.page-controls')?.querySelector('button:not(:disabled)') : control)?.focus({ preventScroll: true });
  }
}
function emptyState(container, history = false) {
  const panel = element('div', 'empty-state');
  const illustration = element('div', 'empty-illustration'); illustration.append(icon(history ? 'history' : 'message'), element('span', 'empty-orbit one'), element('span', 'empty-orbit two')); panel.append(illustration);
  const connected = state.endpoints.length > 0;
  const searching = history && $('#history-search').value.trim();
  panel.append(element('h3', '', searching ? 'No matching requests.' : history ? 'Your history starts with a handoff.' : filter !== 'all' ? 'Nothing in this view.' : 'Good work starts with a clear question.'));
  panel.append(element('p', '', searching ? 'Try a different search or clear it to see all requests.' : history ? 'Completed, cancelled, and blocked requests stay here with their receipts.' : filter !== 'all' ? 'The board will update when a request matches this filter.' : connected ? 'Ask an agent, request a review, or delegate a bounded change. Every request gets a durable record.' : 'Connect an agent above, then give it a question, a review, or a small piece of work.'));
  if (!history && filter === 'all') panel.append(button(connected ? 'Create your first request' : 'Connect your first agent', 'button secondary', () => connected ? openComposer() : openConnect('codex'), 'plus'));
  container.append(panel);
}
function renderRequests(container, requests, history = false) {
  container.replaceChildren();
  if (!requests.length) { emptyState(container, history); return; }
  for (const request of requests) {
    const card = button('', 'request-card', () => openRequest(request.id));
    const mark = element('div', `request-kind ${request.kind === 'delegate' ? 'delegate' : ''}`); mark.append(icon(kindIcons[request.kind] || 'message'));
    const body = element('div', 'request-body');
    const heading = element('div', 'request-heading'); heading.append(element('h3', '', compact(request.prompt, 110)), badge(request.state));
    body.append(heading, element('p', 'request-expectation', compact(request.blocker || request.expected_result, 150)));
    const meta = element('div', 'request-meta'); meta.append(element('span', 'kind-label', readable(request.kind)), element('span', '', `${request.origin === 'owner' ? 'You' : labelFor(request.origin)} → ${labelFor(request.target)}`), element('span', '', when(request.created_at)), element('code', '', request.id.slice(0, 8)));
    body.append(meta); card.append(mark, body, icon('arrow')); container.append(card);
  }
}
function pageSlice(items, requestedPage) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(pages, Math.max(1, requestedPage));
  const offset = (page - 1) * pageSize;
  return { page, pages, total: items.length, first: items.length ? offset + 1 : 0, last: Math.min(offset + pageSize, items.length), items: items.slice(offset, offset + pageSize) };
}
function renderRequestPage(name, requests) {
  const slice = pageSlice(requests, requestPages[name]);
  requestPages[name] = slice.page;
  renderRequests($(name === 'inbox' ? '#request-list' : '#history-list'), slice.items, name === 'history');
  const summary = $(`#${name}-page-summary`);
  const text = slice.total ? `${slice.first}–${slice.last} of ${slice.total} request${slice.total === 1 ? '' : 's'}` : '0 requests';
  // The controls stay mounted so polling does not move keyboard focus.
  if (summary.textContent !== text) summary.textContent = text;
  $(`#${name}-page-position`).textContent = `Page ${slice.page} of ${slice.pages}`;
  $(`#${name}-page-position`).hidden = !slice.total;
  $(`#${name}-previous`).disabled = slice.page === 1;
  $(`#${name}-next`).disabled = slice.page === slice.pages;
}
function render() {
  renderConnections($('#connection-cards')); renderConnections($('#connection-settings'), true);
  $('#sidebar-agents').replaceChildren();
  for (const agent of ['codex', 'claude']) {
    const count = state.endpoints.filter(item => item.agent === agent).length;
    const row = button('', 'sidebar-agent', () => count ? switchView('connections') : openConnect(agent));
    row.append(element('span', `status-dot ${count ? '' : 'inactive'}`), element('span', '', names[agent]), element('small', '', count ? `${count} connection${count === 1 ? '' : 's'}` : 'Connect')); $('#sidebar-agents').append(row);
  }
  const inboxRequests = state.requests.filter(item => !terminal.has(item.state) || item.state === 'needs-owner');
  $('#active-count').textContent = inboxRequests.length; $('#history-count').textContent = state.requests.length;
  $('#inbox-count').textContent = inboxRequests.length;
  const sorted = [...state.requests].sort((left, right) => Number(right.created_at) - Number(left.created_at) || String(left.id).localeCompare(String(right.id)));
  const inbox = filter === 'active' ? sorted.filter(item => !terminal.has(item.state)) : filter === 'needs-owner' ? sorted.filter(item => item.state === 'needs-owner') : sorted.filter(item => !terminal.has(item.state) || item.state === 'needs-owner');
  renderRequestPage('inbox', inbox);
  const query = $('#history-search').value.trim().toLowerCase();
  renderRequestPage('history', sorted.filter(item => !query || `${item.prompt} ${item.id} ${item.state}`.toLowerCase().includes(query)));
  $('#paused-banner').classList.toggle('hidden', !state.paused);
  $('#pause span').textContent = state.paused ? 'Resume dispatch' : 'Pause dispatch';
  $('#pause use').setAttribute('href', state.paused ? '#i-play' : '#i-pause');
  $('#spark-state').textContent = state.spark?.executable ? `Configured: ${state.spark.executable}` : 'No supported executable configured.';
}
async function refresh(silent = false) {
  if (refreshing) return; refreshing = true;
  try {
    const data = await rpc('status');
    Object.assign(state, data, { endpoints: data.endpoints || [], requests: data.requests || [], grants: data.grants || [] });
    $('#local-health').textContent = state.paused ? 'Paused' : 'Ready';
    $('#sync-label').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    clearError($('#error-banner')); render();
    if (selectedRequest && $('#detail-dialog').open) {
      const request = state.requests.find(item => item.id === selectedRequest);
      if (request) renderDetail(request);
    }
  } catch (error) {
    $('#local-health').textContent = 'Unavailable'; $('#sync-label').textContent = 'Local board unavailable';
    if (!silent || !$('#error-banner').textContent) showError($('#error-banner'), error);
  } finally { refreshing = false; }
}
function detectionFor(agent) {
  const candidates = discovered.filter(item => item.agent === agent && (item.executable || item.path));
  const ready = candidates.filter(item => item.supported === true && item.authenticated === true);
  const result = { candidates, selected: ready.length === 1 ? ready[0] : null, manual: false };
  if (discoveryPhase === 'idle' || discoveryPhase === 'checking') return { ...result, selected: null, status: 'Checking', message: 'Checking the installed CLI and its existing sign-in…' };
  if (discoveryPhase === 'error') return { ...result, selected: null, manual: true, status: 'Check failed', message: 'Automatic detection could not finish. Rescan or choose the executable in Advanced setup.' };
  if (ready.length === 1) return { ...result, status: 'Signed in', message: `${names[agent]} detected and authenticated. Choose a workspace to connect.` };
  if (ready.length > 1) return { ...result, manual: true, status: 'Choose CLI', message: 'Multiple authenticated CLIs were detected. Choose the one to use in Advanced setup.' };
  if (!candidates.length) return { ...result, manual: true, status: 'Not found', message: `Install the official ${names[agent]} CLI, then rescan. You can also choose its executable in Advanced setup.` };
  if (candidates.some(item => item.supported === true)) return { ...result, status: 'Sign in needed', message: `CLI detected. Sign in through ${names[agent]}’s official login using your ${agent === 'codex' ? 'ChatGPT' : 'Claude'} account, then rescan.` };
  return { ...result, manual: true, status: 'Update needed', message: `The detected CLI does not support this connection. Update the official ${names[agent]} CLI and rescan, or choose another executable.` };
}
async function discoverAgents(force = false) {
  if (discoveryPromise) return discoveryPromise;
  if (!force && discoveryPhase !== 'idle') return discovered;
  discoveryPhase = 'checking'; render();
  if ($('#connect-dialog').open) renderDiscovered($('#connect-form').elements.agent.value);
  $$('#discover, #connect-rescan').forEach(control => { control.disabled = true; });
  discoveryPromise = (async () => {
    try {
      const result = await rpc('discover');
      discovered = Array.isArray(result.agents) ? result.agents.filter(item => item && names[item.agent]) : [];
      discoveryPhase = 'ready'; return discovered;
    } catch (error) { discoveryPhase = 'error'; throw error; }
    finally {
      discoveryPromise = null;
      $$('#discover, #connect-rescan').forEach(control => { control.disabled = false; });
      render();
      if ($('#connect-dialog').open) renderDiscovered($('#connect-form').elements.agent.value);
    }
  })();
  return discoveryPromise;
}
function renderDiscovered(agent) {
  const form = $('#connect-form'); const detection = detectionFor(agent);
  const manual = form.dataset.manual === 'true';
  $('#connect-detection-title').textContent = detection.status;
  $('#connect-detection-message').textContent = detection.message;
  const selected = detection.selected || (detection.candidates.length === 1 ? detection.candidates[0] : null);
  $('#detected-executable').textContent = selected ? `${selected.version || 'Version unavailable'}\n${selected.executable || selected.path}` : 'No single supported, signed-in CLI selected.';
  if (!manual) form.elements.executable.value = detection.selected ? detection.selected.executable || detection.selected.path : '';
  if (manual || discoveryPhase !== 'checking') $('#manual-executable').hidden = !manual && !detection.manual;
  if (detection.manual) $('#connect-advanced').open = true;
  $('#connect-selection').textContent = manual ? 'Manual selection · checked when connecting' : detection.selected ? 'Detected CLI selected automatically' : 'Choose a CLI or complete its official sign-in';
  const host = $('#discovered-options'); host.replaceChildren();
  for (const item of detection.candidates) {
    const path = item.executable || item.path;
    const option = button(`${item.supported && item.authenticated ? 'Signed in' : item.supported ? 'Sign in needed' : 'Unsupported'} · ${item.version || path}`, 'detected-option', () => {
      form.dataset.manual = 'true'; form.elements.executable.value = path; renderDiscovered(agent);
    });
    option.title = path; host.append(option);
  }
}
function openConnect(agent) {
  const form = $('#connect-form'); form.reset(); form.elements.agent.value = agent;
  form.dataset.manual = 'false'; form.elements.label.placeholder = `${names[agent]} (default)`;
  $('#connect-advanced').open = false; $('#connect-label-details').open = false;
  $('#manual-executable').hidden = true;
  $('#connect-title').textContent = `Connect ${names[agent]}`;
  form.elements.executable.placeholder = `C:\\path\\to\\${agent}.exe`;
  clearError($('#connect-error')); renderDiscovered(agent); $('#connect-dialog').showModal();
}
function openLabelEditor(item) {
  const form = $('#label-form'); form.reset(); form.elements.id.value = item.id; form.elements.label.value = endpointLabel(item);
  clearError($('#label-error')); $('#label-dialog').showModal(); form.elements.label.focus(); form.elements.label.select();
}
function updateScopeNote() {
  const kind = $('#compose-form').elements.kind.value;
  $('#scope-note span').textContent = kind === 'delegate' ? 'Scoped delegation. Changes are made in an isolated Git worktree and returned for review. Nothing auto-merges.' : `Read-only ${kind}. The grant allows file reads within your scope.`;
}
function updatePeerTargets(useDefaults = false) {
  const form = $('#compose-form');
  const peers = state.endpoints.filter(item => item.id !== form.elements.target.value && sameWorkspace(item.workspace, form.elements.project.value.trim()));
  ['peer_one', 'peer_two', 'peer_three'].forEach((name, index) => {
    const select = form.elements[name]; const previous = select.value;
    const none = element('option', '', 'None'); none.value = ''; select.replaceChildren(none);
    for (const peer of peers) { const option = element('option', '', `${labelFor(peer.id)} · ${peer.id}`); option.value = peer.id; select.append(option); }
    select.value = useDefaults ? (peers.length <= 3 ? peers[index]?.id || '' : '') : (peers.some(item => item.id === previous) ? previous : '');
    select.disabled = peers.length === 0;
  });
  $('#peer-target-hint').textContent = peers.length > 3 ? `Choose up to three of ${peers.length} connections in this workspace. Only the selected peers may receive handoffs.` : peers.length ? 'Only the selected peers may receive handoffs. Choose None to remove a peer from this grant.' : 'No other connections are available in this workspace. This grant will authorize only the primary agent.';
}
function openComposer(targetId) {
  if (!state.endpoints.length) { openConnect('codex'); return; }
  const form = $('#compose-form'); form.reset(); pendingSubmission = null;
  const select = form.elements.target; select.replaceChildren();
  for (const item of state.endpoints) {
    const option = element('option', '', `${labelFor(item.id)} · ${item.workspace} · ${item.id}`); option.value = item.id; select.append(option);
  }
  if (targetId) select.value = targetId;
  form.elements.project.value = endpoint(select.value)?.workspace || '';
  updatePeerTargets(true);
  clearError($('#compose-error')); updateScopeNote(); $('#compose-dialog').showModal();
}
function section(title, content) { const node = element('section', 'detail-section'); node.append(element('h3', '', title), content); return node; }
function keyValues(entries) {
  const dl = element('dl', 'info-grid');
  for (const [key, value] of entries) { dl.append(element('dt', '', key), element('dd', '', value ?? 'Unavailable')); }
  return dl;
}
function jsonBlock(value) { return element('pre', 'code-output', typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }
function renderDetail(request) {
  // Do not replace a focused control or a user-selected receipt during polling.
  const host = $('#detail-content');
  const signature = JSON.stringify([request, state.endpoints.map(item => [item.id, item.label, item.agent])]);
  if (host.dataset.signature === signature) return;
  const scroll = $('#detail-dialog').scrollTop;
  host.dataset.signature = signature; host.replaceChildren();
  $('#detail-title').textContent = `${readable(request.kind)} for ${labelFor(request.target)}`;
  $('#detail-eyebrow').textContent = `REQUEST ${request.id.slice(0, 8)}`;
  const status = element('div', 'detail-status'); status.append(badge(request.state), element('span', 'muted', when(request.updated_at || request.created_at))); host.append(status);
  host.append(section('Request', element('p', 'preserve-lines', request.prompt)), section('Expected result', element('p', 'preserve-lines', request.expected_result)));
  if (request.blocker) { const blocked = element('div', 'banner error'); blocked.append(element('strong', '', 'Needs attention'), element('p', '', typeof request.blocker === 'string' ? request.blocker : JSON.stringify(request.blocker))); host.append(blocked); }
  if (request.answer) host.append(section('Agent answer', element('div', 'answer-content preserve-lines', request.answer)));
  else host.append(section('Agent answer', element('p', 'muted', terminal.has(request.state) ? 'No answer was recorded.' : 'Waiting for the agent’s response.')));
  const grant = state.grants.find(item => item.id === request.grant_id);
  const details = element('details', 'receipt-details'); details.open = true; details.append(element('summary', '', 'Scope & limits'));
  details.append(keyValues([
    ['Request ID', request.id], ['From', labelFor(request.origin)], ['Target agent', labelFor(request.target)], ['Target agent ID', request.target], ['Owner grant', request.grant_id], ['Project', grant?.project || request.project], ['Isolated worktree', request.workspace],
    ['Allowed paths', (grant?.allowed_paths || request.allowed_paths || []).join('\n') || 'See receipt'],
    ['Allowed targets', (grant?.targets || []).map(labelFor).join(', ') || 'See grant'],
    ['Limits', grant ? `${grant.max_requests} requests · ${grant.max_delegations} delegations · ${grant.max_hops} hops · ${grant.timeout_seconds}s/run` : 'Grant not in current snapshot'],
    ['Grant expires', when(grant?.expires_at)], ['Root request', request.root_id], ['Hop', request.hop], ['Actual provider session', request.session_id || 'No session event recorded'],
    ['Hard token / dollar caps', 'Unavailable in this adapter']
  ])); host.append(details);
  const receipt = request.receipt;
  if (receipt) {
    host.append(section('Recorded outcome', keyValues([
      ['Process exit', receipt.exit_code], ['Verification', receipt.verification || 'No independent verification recorded'],
      ['Provider cost estimate', receipt.estimated_cost_usd == null ? 'Unavailable' : `$${receipt.estimated_cost_usd} (estimate, not an invoice)`],
      ['Observed cost', receipt.observed_cost_usd == null ? 'Unavailable' : `$${receipt.observed_cost_usd}`]
    ])));
    const changed = receipt.changed_files || receipt.files_changed;
    if (changed) host.append(section('Changed files', jsonBlock(changed)));
    if (receipt.diff) host.append(section('Proposed diff · not merged', jsonBlock(receipt.diff)));
    const verification = receipt.tests_run?.length ? receipt.tests_run : receipt.externally_recorded_tests || receipt.external_tests;
    if (verification) host.append(section('Externally recorded verification', jsonBlock(verification)));
    const tests = receipt.tests_reported || receipt.agent_reported_tests || receipt.tests;
    if (tests) host.append(section('Agent-reported tests · not independent verification', jsonBlock(tests)));
    const usage = receipt.usage || receipt.observed_usage;
    if (usage) host.append(section('Observed provider usage', jsonBlock(usage)));
    const raw = element('details', 'receipt-details'); raw.append(element('summary', '', 'Full recorded receipt'), jsonBlock(receipt)); host.append(raw);
  } else host.append(section('Receipt', element('p', 'muted', 'A receipt will appear when the worker records an outcome. An agent answer alone is not independent verification.')));
  if (grant?.compute?.length) host.append(section('Owner-authorized external compute commands', jsonBlock(grant.compute)));
  if (request.spark_jobs?.length) host.append(section('Recorded Spark jobs', jsonBlock(request.spark_jobs)));
  const events = element('details', 'receipt-details'); events.append(element('summary', '', `Event timeline · ${(request.events || []).length} events`));
  const timeline = element('ol', 'timeline'); timeline.tabIndex = 0; timeline.setAttribute('aria-label', 'Request events');
  for (const event of request.events || []) {
    const item = element('li'); const title = element('div', 'timeline-title'); title.append(element('strong', '', readable(event.kind)), element('time', '', when(event.at)));
    item.append(title); if (event.data !== undefined) item.append(jsonBlock(event.data)); timeline.append(item);
  }
  events.append(timeline); host.append(events);
  const actions = element('div', 'detail-actions');
  if (!terminal.has(request.state)) {
    actions.append(button(request.cancel_requested ? 'Cancellation requested' : 'Cancel this request', 'button secondary', event => cancelRequest(request.id, false, event.currentTarget)));
    if (request.cancel_requested) actions.lastChild.disabled = true;
    actions.append(button('Stop entire request tree', 'button danger', event => cancelRequest(request.root_id || request.id, true, event.currentTarget)));
  }
  actions.append(button('Refresh receipt', 'button subtle', async event => {
    await busy(event.currentTarget, async () => {
      try { const fresh = await rpc('request', { id: request.id }); renderDetail(fresh); } catch (error) { toast(error.message); }
    });
  }, 'refresh')); host.append(actions); $('#detail-dialog').scrollTop = scroll;
}
async function openRequest(id) {
  selectedRequest = id; $('#detail-content').dataset.signature = '';
  const request = state.requests.find(item => item.id === id);
  if (request) renderDetail(request);
  $('#detail-dialog').showModal();
  try { const fresh = await rpc('request', { id }); if (selectedRequest === id) renderDetail(fresh); } catch (error) { toast(error.message); }
}
async function cancelRequest(id, all, control) {
  await busy(control, async () => {
    try { await rpc('cancel', { id, all }); toast(all ? 'Stop requested for this request tree.' : 'Cancellation requested.'); await refresh(); }
    catch (error) { toast(error.message); }
  });
}
function sameWorkspace(left, right) {
  const normalize = value => String(value).replaceAll('\\', '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').replace(/\/$/, '').toLowerCase();
  return normalize(left) === normalize(right);
}

$$('.nav-item').forEach(node => node.addEventListener('click', () => switchView(node.dataset.view)));
$('.brand').addEventListener('click', event => { event.preventDefault(); switchView('board'); });
$$('[data-close]').forEach(node => node.addEventListener('click', () => $(`#${node.dataset.close}`).close()));
$('#detail-dialog').addEventListener('close', () => { selectedRequest = null; });
$('#new-request').addEventListener('click', () => openComposer());
$('#refresh').addEventListener('click', event => busy(event.currentTarget, () => refresh()));
$('#history-search').addEventListener('input', () => { requestPages.history = 1; render(); });
$('#inbox-filters').addEventListener('click', event => {
  const control = event.target.closest('[data-filter]'); if (!control) return;
  if (filter !== control.dataset.filter) requestPages.inbox = 1;
  filter = control.dataset.filter;
  $$('#inbox-filters button').forEach(item => { item.classList.toggle('selected', item === control); item.setAttribute('aria-pressed', String(item === control)); }); render();
});
for (const name of ['inbox', 'history']) {
  for (const [direction, step] of [['previous', -1], ['next', 1]]) {
    $(`#${name}-${direction}`).addEventListener('click', () => { requestPages[name] += step; render(); });
  }
}
$('#pause').addEventListener('click', event => busy(event.currentTarget, async () => {
  try { await rpc('pause', { paused: !state.paused }); await refresh(); } catch (error) { showError($('#error-banner'), error); }
}));
$$('#discover, #connect-rescan').forEach(control => control.addEventListener('click', async () => {
  clearError($('#connect-dialog').open ? $('#connect-error') : $('#error-banner'));
  try { await discoverAgents(true); toast('CLI detection updated. Sign-in status is shown on each agent.'); }
  catch (error) { showError($('#connect-dialog').open ? $('#connect-error') : $('#error-banner'), error); }
}));
$('#change-executable').addEventListener('click', () => {
  const form = $('#connect-form'); form.dataset.manual = 'true'; renderDiscovered(form.elements.agent.value); form.elements.executable.focus();
});
$('#connect-form').elements.executable.addEventListener('input', () => {
  $('#connect-form').dataset.manual = 'true'; $('#connect-selection').textContent = 'Manual selection · checked when connecting';
});
$$('[data-pick-workspace]').forEach(control => control.addEventListener('click', () => busy(control, async () => {
  const form = control.form; const error = form.id === 'connect-form' ? $('#connect-error') : $('#compose-error');
  clearError(error);
  try {
    const result = await invoke('pick_workspace');
    if (result.cancelled === true) return;
    if (typeof result.path !== 'string' || !result.path) throw new Error('The folder picker did not return a workspace.');
    const input = form.elements[control.dataset.pickWorkspace]; input.value = result.path;
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (failure) { showError(error, failure); }
})));
$('#connect-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const control = $('button[type=submit]', form); clearError($('#connect-error'));
  await busy(control, async () => {
    try {
      const agent = form.elements.agent.value;
      const label = form.elements.label.value.trim() || names[agent];
      const workspace = form.elements.workspace.value.trim();
      if (!form.elements.executable.value.trim()) {
        const detection = detectionFor(agent);
        if (detection.status === 'Sign in needed') throw new Error(detection.message);
        $('#connect-advanced').open = true; $('#manual-executable').hidden = false;
        throw new Error('Choose a detected CLI or enter its executable in Advanced setup.');
      }
      const matches = state.endpoints.filter(item => item.agent === agent && sameWorkspace(item.workspace, workspace) && endpointLabel(item) === label);
      if (matches.length > 1) throw new Error('Multiple connections share this label; choose a unique label for a new connection.');
      const existing = matches[0];
      await rpc('connect', { id: existing?.id || `${agent}-${crypto.randomUUID()}`, agent, label, executable: form.elements.executable.value.trim(), workspace, dedicated_session_consent: form.elements.consent.checked });
      $('#connect-dialog').close(); toast(`${label} connection recorded.`); await refresh();
    } catch (error) { showError($('#connect-error'), error); }
  });
});
$('#label-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; clearError($('#label-error'));
  await busy($('button[type=submit]', form), async () => {
    try { await rpc('rename-agent', { id: form.elements.id.value, label: form.elements.label.value.trim() }); $('#label-dialog').close(); toast('Agent label saved.'); await refresh(); }
    catch (error) { showError($('#label-error'), error); }
  });
});
$('#compose-form').elements.target.addEventListener('change', event => { $('#compose-form').elements.project.value = endpoint(event.target.value)?.workspace || ''; updatePeerTargets(true); });
$('#compose-form').elements.project.addEventListener('change', () => updatePeerTargets());
$$('input[name=kind]').forEach(node => node.addEventListener('change', updateScopeNote));
$('#compose-form').addEventListener('input', () => { if (pendingSubmission) pendingSubmission.dirty = true; });
$('#compose-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const control = $('button[type=submit]', form); clearError($('#compose-error'));
  await busy(control, async () => {
    try {
      if (!form.elements.grant_consent.checked) throw new Error('Authorize the scope and limits before sending.');
      const values = Object.fromEntries(new FormData(form));
      const paths = [...new Set(values.allowed_paths.split(/\r?\n/).map(path => path.trim()).filter(Boolean))];
      if (!paths.length) throw new Error('Enter at least one allowed relative path.');
      let compute;
      try { compute = JSON.parse(values.compute || '[]'); } catch { throw new Error('Compute commands must be a valid JSON array. Leave [] for no external jobs.'); }
      if (!Array.isArray(compute) || compute.length > 4) throw new Error('Authorize up to four exact external compute commands in a JSON array.');
      for (const permission of compute) {
        if (!permission || Array.isArray(permission) || !Array.isArray(permission.argv) || !permission.argv.length || permission.argv.some(item => typeof item !== 'string') || !['auto', 'laptop', 'spark'].includes(permission.placement) || !['python', 'node', 'rust'].includes(permission.runtime) || Object.keys(permission).some(key => !['argv', 'placement', 'runtime'].includes(key))) {
          throw new Error('Each compute permission needs argv (a nonempty string array), placement (auto, laptop, or spark), and runtime (python, node, or rust).');
        }
      }
      if (compute.length && !form.elements.compute_consent.checked) throw new Error('Explicitly authorize external job execution for the listed commands.');
      const targets = [...new Set([values.target, values.peer_one, values.peer_two, values.peer_three].filter(Boolean))];
      if (targets.some(id => !endpoint(id) || !sameWorkspace(endpoint(id).workspace, values.project.trim()))) throw new Error('Every selected agent must be connected to this workspace. Update the target and peer selections first.');
      const payload = { target: values.target, kind: values.kind, prompt: values.prompt.trim(), expected_result: values.expected_result.trim() };
      const fingerprint = JSON.stringify({ values, paths, targets });
      if (pendingSubmission && pendingSubmission.fingerprint !== fingerprint) throw new Error('The previous submission had an uncertain outcome. Close this form and inspect History before starting a changed request.');
      if (!pendingSubmission) {
        const grant = await rpc('grant', { project: values.project.trim(), allowed_paths: paths, targets, kinds: values.kind === 'delegate' ? ['question', 'review', 'delegate'] : ['question', 'review'], expected_result: values.expected_result.trim(), max_requests: Number(values.max_requests), max_delegations: values.kind === 'delegate' ? Number(values.max_delegations) : 0, max_hops: Number(values.max_hops), timeout_seconds: Number(values.timeout_seconds), expires_seconds: Number(values.expiry_minutes) * 60, compute });
        pendingSubmission = { id: crypto.randomUUID(), grant_id: grant.id, fingerprint, dirty: false };
      }
      const request = await rpc('submit', { ...payload, id: pendingSubmission.id, grant_id: pendingSubmission.grant_id });
      pendingSubmission = null; $('#compose-dialog').close(); toast('Request recorded. Follow its progress in the inbox.'); await refresh(); await openRequest(request.id);
    } catch (error) {
      if (pendingSubmission) error.message += ` Request ID: ${pendingSubmission.id}. Retrying unchanged uses the same ID; check History before creating another request.`;
      showError($('#compose-error'), error);
    }
  });
});
$('#spark-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  await busy($('button[type=submit]', form), async () => {
    try { await rpc('spark-config', { executable: form.elements.executable.value.trim() }); toast('Spark executable saved.'); await refresh(); }
    catch (error) { showError($('#error-banner'), error); }
  });
});
$('#spark-status').addEventListener('click', event => busy(event.currentTarget, async () => {
  try { const result = await rpc('spark', { operation: 'status', arguments: {} }); $('#spark-output').textContent = JSON.stringify(result, null, 2); $('#spark-output').classList.remove('hidden'); }
  catch (error) { showError($('#error-banner'), error); }
}));
$('#reconnect').addEventListener('click', event => busy(event.currentTarget, async () => {
  try { const result = await rpc('reconnect'); toast(result?.message || 'Recovery checked. Inspect request blockers before retrying interrupted work.'); await refresh(); }
  catch (error) { showError($('#error-banner'), error); }
}));
function applyTheme(theme) { document.documentElement.dataset.theme = theme; try { localStorage.setItem('codaclauda.theme', theme); } catch { /* Theme persistence is optional. */ } }
$('#theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
try { const saved = localStorage.getItem('codaclauda.theme'); if (saved === 'light' || saved === 'dark') applyTheme(saved); } catch { /* No local preferences available. */ }
document.addEventListener('keydown', event => {
  if (event.key.toLowerCase() !== 'n' || event.ctrlKey || event.metaKey || event.altKey || $('dialog[open]') || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  event.preventDefault(); openComposer();
});
render();
invoke('preferences').then(data => { $('#cli-path').textContent = data.cli_path; $('#app-version').textContent = data.version || '0.1.0'; }).catch(error => { $('#cli-path').textContent = error.message; });
refresh();
discoverAgents().catch(() => { /* Cards show the failed check; the owner can rescan or choose a CLI. */ });
setInterval(() => { if (!document.hidden) refresh(true); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
