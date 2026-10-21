/* Settings → Usage (0.6). One owner setting for the whole app, never per project and never reachable from an
 * agent's tools (src-tauri/src/session_host/usage.rs). When a provider's plan limit is reached:
 *   Codex   use an earned weekly reset first (when allowed and one is available), else continue on ChatGPT
 *           credits (when allowed, credits remain and the spend cap is not reached), else wait and send the
 *           turn once at the reset. All on by default.
 *   Claude  continue on Claude usage credits (claude.ai Settings > Usage) unless turned off; then the turn waits
 *           for the reset. Claude has no weekly resets.
 * The same subscription sign-in is used throughout: CodaClauda never reads credentials, changes sign-in or
 * handles a key, and nothing spends with these switched off.
 *   usage_settings_get() → { codex: { useCredits, useResets }, claude: { useCredits }, error|null }
 *   usage_settings_set({ provider, useCredits?, useResets? }) → same
 *   usage_status({ provider }) → { snapshot|null, at|null, limited, resetsAt|null, overage? } */
import { desktop } from '../bridge.js';

const WINDOW_NAMES = { 300: '5-hour', 10080: 'weekly' };
const when = secs => {
  const at = Number(secs) * 1000;
  if (!Number.isFinite(at) || at <= 0) return '';
  return new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

/** A saved setting, with every flag true unless it is exactly false. */
export function normalizeUsageSettings(value) {
  const v = value && typeof value === 'object' ? value : {};
  const flag = x => x !== false;
  return { codex: { useCredits: flag(v.codex?.useCredits), useResets: flag(v.codex?.useResets) }, claude: { useCredits: flag(v.claude?.useCredits) }, error: typeof v.error === 'string' && v.error ? v.error : null };
}

/** One plain line about the latest plan snapshot, or '' when there is none yet. */
export function usageStatusText(provider, status) {
  const snap = status?.snapshot;
  if (!snap || typeof snap !== 'object') return '';
  if (provider === 'codex') {
    const limits = snap.rateLimits && typeof snap.rateLimits === 'object' ? snap.rateLimits : {};
    const parts = [];
    for (const key of ['secondary', 'primary']) {
      const w = limits[key];
      if (!w || !Number.isFinite(Number(w.usedPercent))) continue;
      const name = WINDOW_NAMES[w.windowDurationMins] || (w.windowDurationMins ? `${w.windowDurationMins}-minute` : key);
      const reset = when(w.resetsAt);
      parts.push(`${name} ${Math.round(Number(w.usedPercent))}% used${reset ? `, resets ${reset}` : ''}`);
    }
    const credits = limits.credits;
    if (credits?.unlimited === true) parts.push('credits unlimited');
    else if (credits && (credits.hasCredits === true || credits.balance != null)) parts.push(`credits ${credits.hasCredits === true ? `balance ${credits.balance ?? 'not reported'}` : 'none left'}`);
    if (limits.spendControlReached === true) parts.push('spend cap reached');
    const resets = Number(snap.rateLimitResetCredits?.availableCount);
    if (Number.isFinite(resets)) parts.push(`${resets} weekly reset${resets === 1 ? '' : 's'} available`);
    return `${status.limited ? 'Plan limit reached. ' : ''}${parts.join(' · ')}`.trim();
  }
  const reset = when(snap.resetsAt);
  const state = snap.status === 'rejected' ? 'Plan limit reached' : snap.status === 'allowed_warning' ? 'Close to the plan limit' : 'Within the plan';
  return `${state}${snap.rateLimitType ? ` (${String(snap.rateLimitType).replaceAll('_', ' ')})` : ''}${reset ? `, resets ${reset}` : ''}${status.overage ? ' · on usage credits' : ''}`;
}

/** → { node, load() }: a persistent card. */
export function usageSettings({ ui, bridge }) {
  const { h, toast } = ui;
  const state = { saved: null, error: '', busy: false, status: { codex: null, claude: null } };
  const supported = () => typeof desktop.usageSettingsGet === 'function' && typeof desktop.usageSettingsSet === 'function';

  const sw = (label, onchange) => h('input', { type: 'checkbox', 'aria-label': label, onchange });
  const codexCredits = sw('Codex: continue on ChatGPT credits', event => save('codex', { useCredits: event.currentTarget.checked }));
  const codexResets = sw('Codex: use my earned weekly resets', event => save('codex', { useResets: event.currentTarget.checked }));
  const claudeCredits = sw('Claude: continue on usage credits', event => save('claude', { useCredits: event.currentTarget.checked }));
  const codexStatus = h('span.field-hint');
  const claudeStatus = h('span.field-hint');
  const problem = h('p.field-hint.bad', { role: 'status', hidden: true });
  const row = (title, hint, input, extra) => h('div.setting-row', h('div.setting-text', h('strong', title), h('span.field-hint', hint), extra || null), h('label.switch', input, h('span')));
  const claudeLink = h('a', { href: 'https://claude.ai/settings/usage', onclick: event => { event.preventDefault(); bridge?.desktop?.openExternal?.('https://claude.ai/settings/usage'); } }, 'claude.ai Settings > Usage');
  const node = h('section.card.settings-card.usage-card',
    h('h2.panel-title', 'Usage'),
    h('p.muted', 'What CodaClauda does when a plan limit is reached, for every chat in every project. Your Claude and Codex sign-ins are used as they are; nothing here handles a key or changes an account.'),
    row('Codex: use my earned weekly resets', 'When the plan limit is reached and a reset is available, CodaClauda redeems one before sending (one per limit episode). Off: resets stay unused.', codexResets),
    row('Codex: continue on ChatGPT credits', 'After the plan limit, turns draw on your ChatGPT credits while any remain and the spend cap is not reached (set the cap in ChatGPT Settings > Usage). Off: the turn waits and is sent once at the reset.', codexCredits, codexStatus),
    row('Claude: continue on usage credits', h('span', 'After the plan limit, chats carry on with Claude usage credits when they are turned on in ', claudeLink, '. Off: the turn waits and is sent once at the reset. Claude has no weekly resets.'), claudeCredits, claudeStatus),
    problem,
    h('p.field-hint', 'A turn the provider stops for its limit is explained in the chat and sent again once: now when a reset or credits can cover it, otherwise at the reported reset, while CodaClauda stays open.'));

  function fill(saved) {
    state.saved = normalizeUsageSettings(saved);
    codexCredits.checked = state.saved.codex.useCredits;
    codexResets.checked = state.saved.codex.useResets;
    claudeCredits.checked = state.saved.claude.useCredits;
  }
  function render() {
    node.hidden = !supported();
    const ready = Boolean(state.saved) && !state.busy;
    for (const input of [codexCredits, codexResets, claudeCredits]) input.disabled = !ready;
    const issue = state.error ? `Couldn't read the setting: ${state.error}` : state.saved?.error || '';
    problem.hidden = !issue; problem.textContent = issue;
    codexStatus.textContent = usageStatusText('codex', state.status.codex) || 'Plan details appear once a Codex chat has started.';
    claudeStatus.textContent = usageStatusText('claude', state.status.claude) || 'Plan details appear after a Claude reply.';
  }
  async function load() {
    if (!supported()) { render(); return; }
    try { fill(await desktop.usageSettingsGet()); state.error = ''; }
    catch (error) { state.error = error?.message || String(error); }
    if (typeof desktop.usageStatus === 'function') {
      for (const provider of ['codex', 'claude']) {
        try { state.status[provider] = await desktop.usageStatus({ provider }); } catch { state.status[provider] = null; }
      }
    }
    render();
  }
  async function save(provider, patch) {
    if (state.busy || !state.saved) return;
    state.busy = true; render();
    try { fill(await desktop.usageSettingsSet({ provider, ...patch })); toast('Usage setting saved', { kind: 'success', timeout: 2400 }); }
    catch (error) { toast(`Couldn't save the usage setting: ${error?.message || error}`, { kind: 'error', timeout: 8000 }); fill(state.saved); }
    finally { state.busy = false; render(); }
  }
  render();
  return { node, load };
}
