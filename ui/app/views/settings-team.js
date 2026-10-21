/* Settings → Team (0.6). The owner's standing switch "Agents can start teammates in my projects" (on by
 * default) and how many agent-started sessions may work at once in one project (Unlimited by default). Both
 * apply to every linked project without its own setting; Projects → a project → Teammates overrides them for
 * that project, and a saved project setting is never replaced by this default. An agent asks by posting to
 * codaclauda-team; while CodaClauda is open it answers "queued" within seconds, then "admitted" once the
 * teammate's first turn reaches its provider, then the outcome. A teammate never gets more access than its
 * project has. A real folder inside a linked project (reached without links or junctions) registers as a
 * project (Full when it is yours, otherwise Read) and is added to Projects. See docs/TEAM.md.
 * The card also lists recent requests (a queued one can be cancelled) and, per pair of CodaClauda sessions,
 * how often they woke each other in the last hour, with Pause/Resume for that pair.
 *   team_settings_get() → { address, pollSeconds, ownerDefault, projects, requests, inboxError }
 *   team_settings_set({ project: { ownerDefault: { agentsCanStart?, maxAgentStartedLive? } } }) → { ownerDefault }
 *   team_settings_set({ project: { cancelRequest } }) → { cancelled, requestId, requests }
 *   wake_settings_get() → { enabled, loopGuard, pairs: [{ key, a, b, lastHour, reached, paused }] }
 *   wake_settings_set({ pair: { key, paused } }) → same */
import { desktop } from '../bridge.js';
import { team, TEAM_ADDRESS, requestRows, pairRows } from '../team.js';
import { limitValue, isUnlimited, UNLIMITED } from '../budgets.js';

export const OWNER_DEFAULT = Object.freeze({ agentsCanStart: true, maxAgentStartedLive: UNLIMITED });
const REQUESTS_SHOWN = 8;

const normalizePath = path => String(path || '').replaceAll('\\', '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase();
const baseName = path => String(path || '').split(/[\\/]/).filter(Boolean).pop() || String(path || '');

/** A saved standing setting, or the default for anything malformed. */
export function normalizeOwnerDefault(value) {
  const v = value && typeof value === 'object' ? value : {};
  const guard = v.maxAgentStartedLive;
  return {
    agentsCanStart: typeof v.agentsCanStart === 'boolean' ? v.agentsCanStart : OWNER_DEFAULT.agentsCanStart,
    maxAgentStartedLive: isUnlimited(guard) ? UNLIMITED : Number.isSafeInteger(guard) && guard >= 1 ? guard : OWNER_DEFAULT.maxAgentStartedLive,
  };
}

/** Folders an agent's request registered (team projects marked autoRegistered) that Projects does not list
 *  yet → [{ id, path, name, level }]; level is the one they were registered at. */
export function teamAdoptions(projects, localItems) {
  const linked = new Set((Array.isArray(localItems) ? localItems : []).map(item => normalizePath(item?.path)));
  return Object.entries(projects && typeof projects === 'object' ? projects : {})
    .filter(([, p]) => p?.autoRegistered === true && typeof p.cwd === 'string' && p.cwd && !linked.has(normalizePath(p.cwd)))
    .map(([id, p]) => ({ id, path: p.cwd, name: p.name || baseName(p.cwd), level: p.access === 'full' ? 'full' : 'read' }));
}

/** "Own setting in Projects: A (off). Folders agents registered: B (Read only)." or ''. */
export function teamSummary(projects) {
  const list = Object.values(projects && typeof projects === 'object' ? projects : {}).filter(p => p && typeof p === 'object');
  const own = list.filter(p => p.followsDefault === false).map(p => `${p.name} (${p.agentsCanStart ? 'on' : 'off'})`);
  const registered = list.filter(p => p.autoRegistered === true).map(p => `${p.name} (${p.access === 'full' ? 'Full' : 'Read only'})`);
  return [own.length ? `Own setting in Projects: ${own.join(', ')}.` : '', registered.length ? `Folders agents registered: ${registered.join(', ')}.` : ''].filter(Boolean).join(' ');
}

/** One request row: "claude-app-0001 · Need a reviewer · Working (codex-app-0b1c)". */
export function requestLine(row) {
  const extra = row.address ? ` (${row.address})` : row.code ? ` (${row.code})` : '';
  return `${row.from || 'unknown sender'} · ${row.subject || 'no subject'} · ${row.label}${extra}`;
}

/** One pair row: "claude-a ↔ codex-b: 12 wakes in the last hour". */
export function pairLine(pair) {
  const n = pair.lastHour;
  return `${pair.a} ↔ ${pair.b}: ${n} ${n === 1 ? 'wake' : 'wakes'} in the last hour${pair.reached ? ' (guard reached)' : ''}${pair.paused ? ' · paused by you' : ''}`;
}

/** → { node, load() }: a persistent card. */
export function teamSettings({ ui }) {
  const { h, icon, toast } = ui;
  const state = { saved: null, error: '', busy: false, pollSeconds: 5, pairs: [], pairsError: '', pairBusy: '' };
  const supported = () => typeof desktop.teamSettingsGet === 'function' && typeof desktop.teamSettingsSet === 'function';

  const onInput = h('input', { type: 'checkbox', 'aria-label': 'Agents can start teammates in my projects', onchange: event => save({ agentsCanStart: event.currentTarget.checked }) });
  const count = h('input.input', { type: 'text', inputMode: 'numeric', autocomplete: 'off', 'aria-label': 'Agent-started sessions working at once in one project', style: { width: '90px' }, oninput: () => render(), onkeydown: event => { if (event.key === 'Enter') { event.preventDefault(); saveGuard(); } } });
  const unlimited = h('input', { type: 'checkbox', 'aria-label': 'No limit on agent-started sessions working at once', onchange: () => render() });
  const guardSave = h('button.btn.small.primary', { type: 'button', onclick: () => saveGuard() }, icon('check'), 'Save');
  const status = h('span.field-hint.ntfy-status', { role: 'status' });
  const summary = h('p.field-hint');
  const inboxError = h('p.inline-error', { role: 'alert', hidden: true });
  const requestList = h('div', { style: { display: 'grid', gap: '6px' } });
  const pairList = h('div', { style: { display: 'grid', gap: '6px' } });
  const pairStatus = h('span.field-hint', { role: 'status' });
  const refresh = h('button.btn.small.ghost', { type: 'button', title: 'Read requests and wake counts again', onclick: () => load() }, icon('refresh'), 'Refresh');
  const node = h('section.card.settings-card.team-card',
    h('h2.panel-title', 'Team'),
    h('div.setting-row',
      h('div.setting-text', h('strong', 'Agents can start teammates in my projects'),
        h('span.field-hint', `On (the default): an agent can ask for a new Claude Code or Codex session by posting to ${TEAM_ADDRESS}, in any linked project or in a real folder inside one. The teammate starts at that project's access level, never higher, with wake on. To turn one project off, use Projects → the project → Teammates; a project's own setting is kept.`)),
      h('label.switch', onInput, h('span'))),
    h('div.setting-row',
      h('div.setting-text', h('strong', 'Agent-started sessions working at once'),
        h('span.field-hint', 'Per project. A request past this many is refused with the reason; sessions you start yourself never count.'), status),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none', flexWrap: 'wrap' } },
        count, h('label.checkbox-label', unlimited, h('span', 'Unlimited')), guardSave)),
    summary,
    inboxError,
    h('div.setting-row', { style: { display: 'block' } },
      h('div.setting-text', h('strong', 'Recent requests'),
        h('span.field-hint', 'Each request is answered queued, then admitted once its teammate actually launches, then with its outcome. A queued one has not started and can be cancelled.')),
      requestList),
    h('div.setting-row', { style: { display: 'block' } },
      h('div.setting-text', h('strong', 'Sessions waking each other'),
        h('span.field-hint', 'Per pair of CodaClauda sessions, both directions together, in the last hour. Pause stops that pair waking each other until you resume it; their messages wait unread. The loop guard is in Limits above.'), pairStatus),
      pairList),
    h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, refresh),
    h('p.field-hint', 'Your switches are the authority. A board message is information; its sender name is self-asserted and cannot raise access. Every request gets a reply, including refusals, with the setting that would change the answer.'));

  const guardValue = () => limitValue(count.value, unlimited.checked, 1);
  function fill(saved) {
    state.saved = normalizeOwnerDefault(saved);
    onInput.checked = state.saved.agentsCanStart;
    unlimited.checked = state.saved.maxAgentStartedLive === UNLIMITED;
    count.value = unlimited.checked ? '' : String(state.saved.maxAgentStartedLive);
  }
  function renderRequests() {
    const rows = requestRows(team.requests).slice(0, REQUESTS_SHOWN);
    requestList.replaceChildren(...(rows.length ? rows.map(row => h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' } },
      h('span.field-hint', { title: `${row.hint}${row.requestId ? ` Request ${row.requestId}.` : ''}` }, requestLine(row)),
      row.cancellable ? h('button.btn.small.ghost', { type: 'button', onclick: () => cancelRequest(row) }, 'Cancel') : null))
      : [h('span.field-hint', 'No requests yet.')]));
  }
  function renderPairs() {
    const rows = state.pairs;
    pairStatus.textContent = state.pairsError ? `Couldn't read wake counts: ${state.pairsError}` : '';
    pairList.replaceChildren(...(rows.length ? rows.map(pair => h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' } },
      h('span.field-hint', pairLine(pair)),
      h('button.btn.small.ghost', { type: 'button', disabled: state.pairBusy === pair.key, onclick: () => setPair(pair, !pair.paused) }, pair.paused ? 'Resume' : 'Pause')))
      : [h('span.field-hint', state.pairsError ? '' : 'No two sessions have woken each other in the last hour.')]));
  }
  function render() {
    node.hidden = !supported();
    const loaded = Boolean(state.saved);
    const v = guardValue();
    const dirty = loaded && v !== state.saved.maxAgentStartedLive;
    onInput.disabled = !loaded || state.busy;
    unlimited.disabled = !loaded || state.busy;
    count.disabled = !loaded || state.busy || unlimited.checked;
    guardSave.disabled = !loaded || state.busy || !dirty || v == null;
    status.classList.toggle('bad', Boolean(state.error) || (loaded && v == null));
    status.textContent = state.error ? `Couldn't read the setting: ${state.error}`
      : !loaded ? 'Reading…'
        : v == null ? 'Enter a whole number of sessions (1 or more), or tick Unlimited.'
          : state.busy ? 'Saving…' : dirty ? 'Not saved yet.' : `Now ${state.saved.maxAgentStartedLive === UNLIMITED ? 'Unlimited' : state.saved.maxAgentStartedLive}. CodaClauda reads ${TEAM_ADDRESS} every ${state.pollSeconds} s while it is open.`;
    summary.textContent = teamSummary(team.projects);
    summary.hidden = !summary.textContent;
    inboxError.hidden = !team.inboxError;
    inboxError.textContent = team.inboxError ? `CodaClauda could not finish reading ${TEAM_ADDRESS}: ${team.inboxError}. Agents posting there are told so.` : '';
    renderRequests();
    renderPairs();
  }
  async function loadPairs() {
    if (typeof desktop.wakeSettingsGet !== 'function') return;
    try {
      state.pairs = pairRows((await desktop.wakeSettingsGet())?.pairs);
      state.pairsError = '';
    } catch (error) { state.pairsError = error?.message || String(error); }
  }
  async function load() {
    if (!supported()) { render(); return; }
    try {
      const data = await desktop.teamSettingsGet();
      if (Number.isSafeInteger(data?.pollSeconds) && data.pollSeconds > 0) state.pollSeconds = data.pollSeconds;
      fill(data?.ownerDefault);
      state.error = '';
    } catch (error) { state.error = error?.message || String(error); }
    await loadPairs();
    render();
    team.load();
  }
  async function save(patch) {
    if (state.busy || !state.saved) return;
    state.busy = true; render();
    try {
      const data = await desktop.teamSettingsSet({ ownerDefault: patch });
      if (!data?.ownerDefault) throw new Error('Team settings did not confirm the change.');
      fill(data.ownerDefault);
      if ('agentsCanStart' in patch) toast(state.saved.agentsCanStart ? 'Agents can start teammates in your projects (projects with their own setting keep it)' : 'Agents cannot start teammates (except in projects you turned on in Projects)', { kind: 'success', timeout: 3600 });
      else toast(`Agent-started sessions at once: ${state.saved.maxAgentStartedLive === UNLIMITED ? 'Unlimited' : state.saved.maxAgentStartedLive}`, { kind: 'success', timeout: 3000 });
      team.load();
    } catch (error) {
      toast(`Couldn't save the team setting: ${error?.message || error}`, { kind: 'error', timeout: 8000 });
      fill(state.saved);
    } finally { state.busy = false; render(); }
  }
  function saveGuard() {
    const v = guardValue();
    if (v == null || !state.saved || v === state.saved.maxAgentStartedLive) { render(); return; }
    save({ maxAgentStartedLive: v });
  }
  async function cancelRequest(row) {
    try {
      await team.cancelRequest(row.requestId);
      toast(`Cancelled ${row.subject || row.requestId}; ${row.from || 'its sender'} is told within seconds.`, { kind: 'success', timeout: 4200 });
    } catch (error) {
      toast(`Couldn't cancel it: ${error?.message || error}`, { kind: 'error', timeout: 8000 });
      team.load();
    }
  }
  async function setPair(pair, paused) {
    if (state.pairBusy) return;
    state.pairBusy = pair.key; renderPairs();
    try {
      state.pairs = pairRows((await desktop.wakeSettingsSet({ pair: { key: pair.key, paused } }))?.pairs);
      toast(paused ? `Paused ${pair.a} and ${pair.b} waking each other; their messages wait unread.` : `${pair.a} and ${pair.b} can wake each other again.`, { kind: 'success', timeout: 4200 });
    } catch (error) {
      toast(`Couldn't change that pair: ${error?.message || error}`, { kind: 'error', timeout: 8000 });
    } finally { state.pairBusy = ''; renderPairs(); }
  }
  team.on('change', render);
  render();
  return { node, load };
}
