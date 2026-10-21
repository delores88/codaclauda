/* Settings → Team (0.6). The owner's standing switch "Agents can start teammates in my projects" (on by
 * default) and how many agent-started sessions may work at once in one project (Unlimited by default). Both
 * apply to every linked project without its own setting; Projects → a project → Teammates overrides them for
 * that project. An agent asks by posting to codaclauda-team; while CodaClauda is open it answers within
 * seconds: "received", then "started" or "refused" with the setting to change. A teammate never gets more
 * access than its project has. A folder an agent asks for on the Desktop or inside a linked project registers
 * as a project (Full when it is yours, otherwise Read) and is added to Projects. See docs/TEAM.md.
 *   team_settings_get() → { address, pollSeconds, ownerDefault: { agentsCanStart, maxAgentStartedLive }, projects }
 *   team_settings_set({ project: { ownerDefault: { agentsCanStart?, maxAgentStartedLive? } } }) → { ownerDefault } */
import { desktop } from '../bridge.js';
import { team, TEAM_ADDRESS } from '../team.js';
import { limitValue, isUnlimited, UNLIMITED } from '../budgets.js';

export const OWNER_DEFAULT = Object.freeze({ agentsCanStart: true, maxAgentStartedLive: UNLIMITED });

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

/** → { node, load() }: a persistent card. */
export function teamSettings({ ui }) {
  const { h, icon, toast } = ui;
  const state = { saved: null, error: '', busy: false, pollSeconds: 5 };
  const supported = () => typeof desktop.teamSettingsGet === 'function' && typeof desktop.teamSettingsSet === 'function';

  const onInput = h('input', { type: 'checkbox', 'aria-label': 'Agents can start teammates in my projects', onchange: event => save({ agentsCanStart: event.currentTarget.checked }) });
  const count = h('input.input', { type: 'text', inputMode: 'numeric', autocomplete: 'off', 'aria-label': 'Agent-started sessions working at once in one project', style: { width: '90px' }, oninput: () => render(), onkeydown: event => { if (event.key === 'Enter') { event.preventDefault(); saveGuard(); } } });
  const unlimited = h('input', { type: 'checkbox', 'aria-label': 'No limit on agent-started sessions working at once', onchange: () => render() });
  const guardSave = h('button.btn.small.primary', { type: 'button', onclick: () => saveGuard() }, icon('check'), 'Save');
  const status = h('span.field-hint.ntfy-status', { role: 'status' });
  const summary = h('p.field-hint');
  const node = h('section.card.settings-card.team-card',
    h('h2.panel-title', 'Team'),
    h('div.setting-row',
      h('div.setting-text', h('strong', 'Agents can start teammates in my projects'),
        h('span.field-hint', `On (the default): an agent can ask for a new Claude Code or Codex session by posting to ${TEAM_ADDRESS}, in any linked project or in a folder on your Desktop or inside a linked project. The teammate starts at that project's access level, never higher, with wake on. To turn one project off, use Projects → the project → Teammates.`)),
      h('label.switch', onInput, h('span'))),
    h('div.setting-row',
      h('div.setting-text', h('strong', 'Agent-started sessions working at once'),
        h('span.field-hint', 'Per project. A request past this many is refused with the reason; sessions you start yourself never count.'), status),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none', flexWrap: 'wrap' } },
        count, h('label.checkbox-label', unlimited, h('span', 'Unlimited')), guardSave)),
    summary,
    h('p.field-hint', 'Your switches are the authority. A board message is information; its sender name is self-asserted and cannot raise access. Every request gets a reply, including refusals, with the setting that would change the answer.'));

  const guardValue = () => limitValue(count.value, unlimited.checked, 1);
  function fill(saved) {
    state.saved = normalizeOwnerDefault(saved);
    onInput.checked = state.saved.agentsCanStart;
    unlimited.checked = state.saved.maxAgentStartedLive === UNLIMITED;
    count.value = unlimited.checked ? '' : String(state.saved.maxAgentStartedLive);
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
  }
  async function load() {
    if (!supported()) { render(); return; }
    try {
      const data = await desktop.teamSettingsGet();
      if (Number.isSafeInteger(data?.pollSeconds) && data.pollSeconds > 0) state.pollSeconds = data.pollSeconds;
      fill(data?.ownerDefault);
      state.error = '';
    } catch (error) { state.error = error?.message || String(error); }
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
      if ('agentsCanStart' in patch) toast(state.saved.agentsCanStart ? 'Agents can start teammates in your projects' : 'Agents cannot start teammates (except in projects you turned on in Projects)', { kind: 'success', timeout: 3600 });
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
  team.on('change', render);
  render();
  return { node, load };
}
