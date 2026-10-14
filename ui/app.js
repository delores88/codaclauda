/* First-party ClaudaCoda desktop UI. No remote content, dependencies, or seeded data. */
'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { endpoints: [], grants: [], requests: [], spark: null, paused: false };
const terminal = new Set(['completed', 'failed', 'cancelled', 'needs-owner']);
const names = { codex: 'Codex', claude: 'Claude Code' };
const kindIcons = { question: 'message', review: 'check', delegate: 'branch' };
let view = 'board';
let filter = 'all';
let selectedRequest = null;
let refreshing = false;
let discovered = [];
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
function labelFor(id) { const item = endpoint(id); return names[item?.agent] || id || 'Unknown endpoint'; }
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
  container.replaceChildren();
  for (const agent of ['codex', 'claude']) {
    const endpoints = state.endpoints.filter(item => item.agent === agent);
    const card = element('article', `connection-card ${agent}`);
    const top = element('div', 'connection-top');
    const glyph = element('div', `agent-icon ${agent}`, agent === 'codex' ? 'Cₓ' : 'C');
    const title = element('div', 'connection-title'); title.append(element('h2', '', names[agent]), element('span', '', agent === 'codex' ? 'OpenAI CLI' : 'Anthropic CLI'));
    top.append(glyph, title, badge(endpoints.length ? 'configured' : 'not connected')); card.append(top);
    if (!endpoints.length) {
      card.append(element('p', 'connection-description', 'Connect your CLI and choose a workspace to get started.'));
      const footer = element('div', 'connection-footer'); footer.append(element('span', 'connection-mode', 'Dedicated sessions'), button(`Connect ${names[agent]}`, 'button secondary small', () => openConnect(agent), 'plus')); card.append(footer);
    } else {
      for (const item of (settings ? endpoints : endpoints.slice(-1))) {
        const info = element('div', 'endpoint-info');
        const path = element('div', 'workspace-path'); path.title = item.workspace; path.append(icon('folder'), element('span', '', item.workspace));
        info.append(path, element('p', 'endpoint-meta', `${item.version || 'Version unavailable'} · Auth: ${readable(item.auth_status)}`));
        if (settings) info.append(element('code', 'endpoint-executable', item.executable));
        card.append(info);
      }
      const footer = element('div', 'connection-footer');
      footer.append(element('span', 'connection-mode', `${endpoints.length} workspace${endpoints.length === 1 ? '' : 's'} · new-session-v1`), button(settings ? 'Add workspace' : 'Manage', 'button subtle small', () => settings ? openConnect(agent) : switchView('connections'), settings ? 'plus' : 'arrow')); card.append(footer);
    }
    container.append(card);
  }
}
function emptyState(container, history = false) {
  const panel = element('div', 'empty-state');
  const illustration = element('div', 'empty-illustration'); illustration.append(icon(history ? 'history' : 'message'), element('span', 'empty-orbit one'), element('span', 'empty-orbit two')); panel.append(illustration);
  const connected = state.endpoints.length > 0;
  panel.append(element('h3', '', history ? 'Your history starts with a handoff.' : filter !== 'all' ? 'Nothing in this view.' : 'Good work starts with a clear question.'));
  panel.append(element('p', '', history ? 'Completed, cancelled, and blocked requests stay here with their receipts.' : filter !== 'all' ? 'The board will update when a request matches this filter.' : connected ? 'Ask an agent, request a review, or delegate a bounded change. Every request gets a durable record.' : 'Connect an agent above, then give it a question, a review, or a small piece of work.'));
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
function render() {
  renderConnections($('#connection-cards')); renderConnections($('#connection-settings'), true);
  $('#sidebar-agents').replaceChildren();
  for (const agent of ['codex', 'claude']) {
    const count = state.endpoints.filter(item => item.agent === agent).length;
    const row = button('', 'sidebar-agent', () => count ? switchView('connections') : openConnect(agent));
    row.append(element('span', `status-dot ${count ? '' : 'inactive'}`), element('span', '', names[agent]), element('small', '', count ? `${count} scope${count === 1 ? '' : 's'}` : 'Connect')); $('#sidebar-agents').append(row);
  }
  const inboxRequests = state.requests.filter(item => !terminal.has(item.state) || item.state === 'needs-owner');
  $('#active-count').textContent = inboxRequests.length; $('#history-count').textContent = state.requests.length;
  $('#inbox-count').textContent = inboxRequests.length;
  const sorted = [...state.requests].sort((left, right) => Number(right.created_at) - Number(left.created_at));
  const inbox = filter === 'active' ? sorted.filter(item => !terminal.has(item.state)) : filter === 'needs-owner' ? sorted.filter(item => item.state === 'needs-owner') : sorted.filter(item => !terminal.has(item.state) || item.state === 'needs-owner');
  renderRequests($('#request-list'), inbox);
  const query = $('#history-search').value.trim().toLowerCase();
  renderRequests($('#history-list'), sorted.filter(item => !query || `${item.prompt} ${item.id} ${item.state}`.toLowerCase().includes(query)), true);
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
async function discoverAgents() {
  const result = await rpc('discover');
  discovered = Array.isArray(result.agents) ? result.agents.filter(item => item.executable || item.path) : [];
  return discovered;
}
function renderDiscovered(agent) {
  const host = $('#discovered-options'); host.replaceChildren();
  const candidates = discovered.filter(item => item.agent === agent && (item.executable || item.path));
  for (const item of candidates) {
    const path = item.executable || item.path;
    host.append(button(`Use detected CLI${item.version ? ` · ${item.version}` : ''}`, 'detected-option', () => { $('#connect-form').elements.executable.value = path; }, 'check'));
  }
  const first = candidates[0];
  if (first && !$('#connect-form').elements.executable.value) $('#connect-form').elements.executable.value = first.executable || first.path;
}
function openConnect(agent) {
  const form = $('#connect-form'); form.reset(); form.elements.agent.value = agent;
  $('#connect-title').textContent = `Connect ${names[agent]}`;
  form.elements.executable.placeholder = `C:\\path\\to\\${agent}.exe`;
  const existing = state.endpoints.find(item => item.agent === agent);
  if (existing) { form.elements.executable.value = existing.executable; form.elements.workspace.value = existing.workspace; }
  clearError($('#connect-error')); renderDiscovered(agent); $('#connect-dialog').showModal();
  if (!discovered.length) discoverAgents().then(() => { if (form.elements.agent.value === agent) renderDiscovered(agent); }).catch(error => showError($('#connect-error'), error));
}
function updateScopeNote() {
  const kind = $('#compose-form').elements.kind.value;
  $('#scope-note span').textContent = kind === 'delegate' ? 'Scoped delegation. Changes are made in an isolated Git worktree and returned for review. Nothing auto-merges.' : `Read-only ${kind}. The grant allows file reads within your scope.`;
}
function openComposer(targetId) {
  if (!state.endpoints.length) { openConnect('codex'); return; }
  const form = $('#compose-form'); form.reset(); pendingSubmission = null;
  const select = form.elements.target; select.replaceChildren();
  for (const item of state.endpoints) {
    const option = element('option', '', `${names[item.agent] || item.agent} · ${item.workspace}`); option.value = item.id; select.append(option);
  }
  if (targetId) select.value = targetId;
  form.elements.project.value = endpoint(select.value)?.workspace || '';
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
  const signature = JSON.stringify(request);
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
    ['Request ID', request.id], ['Owner grant', request.grant_id], ['Project', grant?.project || request.project], ['Isolated worktree', request.workspace],
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
  const timeline = element('ol', 'timeline');
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
$('#history-search').addEventListener('input', render);
$('#inbox-filters').addEventListener('click', event => {
  const control = event.target.closest('[data-filter]'); if (!control) return;
  filter = control.dataset.filter; $$('#inbox-filters button').forEach(item => item.classList.toggle('selected', item === control)); render();
});
$('#pause').addEventListener('click', event => busy(event.currentTarget, async () => {
  try { await rpc('pause', { paused: !state.paused }); await refresh(); } catch (error) { showError($('#error-banner'), error); }
}));
$('#discover').addEventListener('click', event => busy(event.currentTarget, async () => {
  try { const agents = await discoverAgents(); toast(agents.length ? `Found ${agents.length} CLI candidate${agents.length === 1 ? '' : 's'}. Choose an agent connection to use one.` : 'No supported CLI was detected. Enter its executable path when connecting.'); } catch (error) { showError($('#error-banner'), error); }
}));
$('#connect-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const control = $('button[type=submit]', form); clearError($('#connect-error'));
  await busy(control, async () => {
    try {
      const agent = form.elements.agent.value;
      const workspace = form.elements.workspace.value.trim();
      const existing = state.endpoints.find(item => item.agent === agent && sameWorkspace(item.workspace, workspace));
      await rpc('connect', { id: existing?.id || `${agent}-${crypto.randomUUID()}`, agent, executable: form.elements.executable.value.trim(), workspace, dedicated_session_consent: form.elements.consent.checked });
      $('#connect-dialog').close(); toast(`${names[form.elements.agent.value]} connection recorded.`); await refresh();
    } catch (error) { showError($('#connect-error'), error); }
  });
});
$('#compose-form').elements.target.addEventListener('change', event => { $('#compose-form').elements.project.value = endpoint(event.target.value)?.workspace || ''; });
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
      const targets = state.endpoints.filter(item => sameWorkspace(item.workspace, values.project.trim())).map(item => item.id);
      if (!targets.includes(values.target)) throw new Error('The selected target must be connected to this workspace. Add a connection for this workspace first.');
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
setInterval(() => { if (!document.hidden) refresh(true); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
