/* Settings → Usage (0.6). One owner setting for the whole app, never per project and never reachable from an
 * agent's tools (src-tauri/src/session_host/usage.rs). It applies only to the sessions CodaClauda owns: not to
 * other Codex or Claude clients and not to the provider account's own settings. When a plan limit is reached:
 *   Codex   redeem one earned reset credit (at most one per limit episode for the account, however many chats hit
 *           the limit), else keep going on ChatGPT credits (only when Codex reports credits left and the spend cap
 *           not reached), else hold the turn. All on by default.
 *   Claude  keep going on Claude usage credits unless turned off, else hold the turn. Claude has no reset credits.
 * Off is an admission policy: a turn already running when the limit is crossed may still draw credits.
 * A held turn was never sent: it is sent once at a reset the provider reported, or when the owner presses Try now;
 * Stop cancels it. A turn the provider stopped after it was sent is never replayed: the owner may Continue.
 * Unknown provider fields are shown as not reported, never as zero; credit amounts are never shown as money.
 *   usage_settings_get() → { codex: { useCredits, useResets }, claude: { useCredits }, error|null }
 *   usage_settings_set({ provider, useCredits?, useResets? }) → same
 *   usage_status({ provider }) → { snapshot|null, at|null, state?, limited, resetsAt|null, resetCredits?, overage? } */
import { desktop } from '../bridge.js';

const WINDOW_NAMES = { 300: '5-hour', 10080: 'weekly' };
const when = secs => {
  const at = Number(secs) * 1000;
  if (!Number.isFinite(at) || at <= 0) return '';
  return new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const obj = v => (v && typeof v === 'object' ? v : {});

/** The card's wording, kept here so it can be checked without a DOM. */
export const USAGE_COPY = {
  intro: 'What CodaClauda does when a plan limit is reached. These switches apply only to the sessions CodaClauda owns (every chat in every project here), not to other Codex or Claude apps and not to your provider account\'s own settings. Your sign-ins are used as they are; nothing here handles a key or changes an account.',
  codexResets: {
    title: 'Codex: redeem my earned reset credits',
    hint: 'An earned reset credit is something you redeem: it resets the limited window now. CodaClauda redeems at most one per limit episode for your account, even when several chats hit the limit at once. That is different from the weekly window resetting on its own at its scheduled time, which uses no credit. Off: earned credits stay unused.',
  },
  codexCredits: {
    title: 'Codex: keep going on ChatGPT credits',
    hint: 'After the plan limit, CodaClauda starts a turn on ChatGPT credits only when Codex reports credits left and the spend cap not reached (set the cap in ChatGPT Settings > Usage). Off is an admission policy: CodaClauda does not start a turn while the limit is known to be reached, but a turn that crosses the limit mid-run, or starts while the limit state is not reported, may still draw credits.',
  },
  claudeCredits: {
    title: 'Claude: keep going on usage credits',
    hint: ['After the plan limit, chats carry on with Claude usage credits when they are turned on in ', '. Off is an admission policy too: a turn already running when the limit is crossed may still use them. Claude has no earned reset credits, so there is no reset switch.'],
  },
  footer: 'A turn held before it was sent keeps its place: it is sent once at a reset time the provider reported, otherwise it waits until you press Try now in the chat; Stop cancels it. A turn the provider stops after it was sent is never sent again by itself: review what ran, then press Continue. Credit costs shown in chats are the provider\'s estimates, never an invoice, and credit balances are credit units, not money.',
};

/** A saved setting, with every flag true unless it is exactly false. */
export function normalizeUsageSettings(value) {
  const v = value && typeof value === 'object' ? value : {};
  const flag = x => x !== false;
  return { codex: { useCredits: flag(v.codex?.useCredits), useResets: flag(v.codex?.useResets) }, claude: { useCredits: flag(v.claude?.useCredits) }, error: typeof v.error === 'string' && v.error ? v.error : null };
}

/** One plain line about the latest plan snapshot, or '' when there is none yet. Absent fields read "not reported". */
export function usageStatusText(provider, status) {
  const snap = status?.snapshot;
  if (!snap || typeof snap !== 'object') return '';
  if (provider === 'codex') {
    const limits = obj(snap.rateLimits);
    const parts = [];
    for (const key of ['secondary', 'primary']) {
      const w = limits[key];
      if (!w || !Number.isFinite(Number(w.usedPercent))) continue;
      const name = WINDOW_NAMES[w.windowDurationMins] || (w.windowDurationMins ? `${w.windowDurationMins}-minute` : key);
      const reset = when(w.resetsAt);
      parts.push(`${name} window ${Math.round(Number(w.usedPercent))}% used${reset ? `, resets on its own ${reset}` : ''}`);
    }
    const credits = limits.credits;
    if (credits?.unlimited === true) parts.push('ChatGPT credits unlimited');
    else if (credits?.hasCredits === true) parts.push(`ChatGPT credit balance ${credits.balance ?? 'not reported'} (credit units, not money)`);
    else if (credits?.hasCredits === false) parts.push('no ChatGPT credits left');
    else parts.push('ChatGPT credits not reported');
    if (limits.spendControlReached === true) parts.push('spend cap reached');
    else if (limits.spendControlReached !== false) parts.push('spend-cap state not reported');
    const count = snap.rateLimitResetCredits?.availableCount;
    parts.push(Number.isInteger(count) ? `${count} earned reset credit${count === 1 ? '' : 's'} to redeem` : 'earned reset credits not reported');
    const state = status.state || (status.limited ? 'limited' : snap.ordinaryUsageAllowed === true ? 'allowed' : 'unknown');
    const lead = state === 'limited' ? 'Plan limit reached. ' : state === 'unknown' ? 'Plan limit state not reported. ' : '';
    return `${lead}${parts.join(' · ')}`;
  }
  const reset = when(snap.resetsAt);
  const state = snap.status === 'rejected' ? 'Plan limit reached' : snap.status === 'allowed_warning' ? 'Close to the plan limit' : snap.status === 'allowed' ? 'Within the plan' : 'Plan state not reported';
  return `${state}${snap.rateLimitType ? ` (${String(snap.rateLimitType).replaceAll('_', ' ')})` : ''}${reset ? `, resets on its own ${reset}` : ''}${status.overage ? ' · on usage credits' : ''}`;
}

/** Where a chat's turns are billed (Settings > Usage decides what happens at the plan limit). */
export function billingLabel(billing) {
  switch (billing) {
    case 'credits': return 'ChatGPT credits (plan limit reached)';
    case 'usage-credits': return 'Claude usage credits (plan limit reached)';
    case 'reset': return 'Your plan, after redeeming an earned reset credit';
    case 'unknown': return 'Your plan (Codex did not report the limit state)';
    default: return 'Your plan';
  }
}

/** A Codex turn's credit share: the provider's estimate, never an invoice and never money. '' when there is none. */
export function creditEstimateText(last) {
  if (!last || typeof last !== 'object') return '';
  const micros = last.micros;
  if (micros == null || !Number.isFinite(Number(micros)) || Number(micros) < 0) return 'Not reported';
  return `≈${(Number(micros) / 1e6).toFixed(2)} credits (estimate, not an invoice)`;
}

/** The chat's usage banner: a held turn (never sent) or a sent turn stopped at the usage limit → null | { kind, turnId, title, text, actions }. */
export function usageBanner(session, { running = false } = {}) {
  const held = session?.held;
  if (held && typeof held === 'object' && typeof held.turnId === 'string') {
    return { kind: 'held', turnId: held.turnId, title: 'Held at the plan limit: not sent',
      text: String(held.text || 'This turn was not sent. Waiting for the plan to reset; check Settings > Usage.'), actions: ['retry', 'cancel'] };
  }
  const stopped = session?.usageStopped;
  if (!running && stopped && typeof stopped === 'object' && typeof stopped.turnId === 'string') {
    return { kind: 'stopped', turnId: stopped.turnId, title: 'Stopped at the usage limit',
      text: 'The provider stopped this turn after it was sent, so part of it may already have run. Review what ran, then Continue: a new turn that names the original. Nothing is replayed by itself.', actions: ['continue'] };
  }
  return null;
}

/** → { node, load() }: a persistent card. */
export function usageSettings({ ui, bridge }) {
  const { h, toast } = ui;
  const state = { saved: null, error: '', busy: false, status: { codex: null, claude: null } };
  const supported = () => typeof desktop.usageSettingsGet === 'function' && typeof desktop.usageSettingsSet === 'function';
  const copy = USAGE_COPY;

  const sw = (label, onchange) => h('input', { type: 'checkbox', 'aria-label': label, onchange });
  const codexResets = sw(copy.codexResets.title, event => save('codex', { useResets: event.currentTarget.checked }));
  const codexCredits = sw(copy.codexCredits.title, event => save('codex', { useCredits: event.currentTarget.checked }));
  const claudeCredits = sw(copy.claudeCredits.title, event => save('claude', { useCredits: event.currentTarget.checked }));
  const codexStatus = h('span.field-hint');
  const claudeStatus = h('span.field-hint');
  const problem = h('p.field-hint.bad', { role: 'status', hidden: true });
  const row = (title, hint, input, extra) => h('div.setting-row', h('div.setting-text', h('strong', title), h('span.field-hint', hint), extra || null), h('label.switch', input, h('span')));
  const claudeLink = h('a', { href: 'https://claude.ai/settings/usage', onclick: event => { event.preventDefault(); bridge?.desktop?.openExternal?.('https://claude.ai/settings/usage'); } }, 'claude.ai Settings > Usage');
  const node = h('section.card.settings-card.usage-card',
    h('h2.panel-title', 'Usage'),
    h('p.muted', copy.intro),
    row(copy.codexResets.title, copy.codexResets.hint, codexResets),
    row(copy.codexCredits.title, copy.codexCredits.hint, codexCredits, codexStatus),
    row(copy.claudeCredits.title, h('span', copy.claudeCredits.hint[0], claudeLink, copy.claudeCredits.hint[1]), claudeCredits, claudeStatus),
    problem,
    h('p.field-hint', copy.footer));

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
