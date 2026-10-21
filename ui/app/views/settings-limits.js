/* Settings → Limits: owner settings, each a whole number or Unlimited (0.5).
 *   Agents at once          CodaClauda chat sessions working together (session_limits_get/set; default Unlimited)
 *   Board requests at once  dedicated board requests running together (rpc policy / policy-set → concurrent)
 *   Grant defaults          what a new grant uses for every budget it leaves out (policy.grant_defaults)
 *   Wake loop guard         two sessions waking each other too often pause (wake_settings loopGuard)
 * None is a safety boundary: scope, access and owner-only grants are unchanged. A grant keeps the budgets
 * it was created with; changing a default affects only grants created afterwards. */
import { has as hasFeature, call as callFeature } from '../features.js';
import { BUDGETS, UNLIMITED, budgetField, budgetValue, budgetText, limitValue, wholeNumber, isUnlimited } from '../budgets.js';
import { wake, normalizeGuard } from '../wake.js';

export const LIMIT_MIN = { maxLive: 1, concurrent: 1, pairPerHour: 1 };
const MEMORY_HINT = 'Each one is a full agent process, so more at once uses more memory.';

const unsupported = error => error?.code === 'UNSUPPORTED' || error?.code === 'MOCK_UNSUPPORTED' || /not found|unknown command|unsupported/i.test(String(error?.message || error || ''));
const shown = value => (isUnlimited(value) ? 'Unlimited' : String(value));

/** Board status counts → "2 active · 1 waiting · 3 queued" (empty when the board does not report them). */
export function boardLoadText(limits) {
  if (!limits || typeof limits !== 'object') return '';
  const n = key => (Number.isSafeInteger(limits[key]) ? limits[key] : null);
  const parts = [['active', n('active')], ['waiting on a teammate', n('waiting')], ['queued', n('queued')]].filter(([, v]) => v != null);
  return parts.length ? `Right now ${parts.map(([word, v]) => `${v} ${word}`).join(' · ')}.` : '';
}

/** Changed grant defaults only: { key: number|'unlimited' } from the form rows; throws on an invalid field. */
export function defaultsPatch(rows) {
  const patch = {};
  for (const row of rows) {
    if (row.text === row.loadedText && row.unlimited === row.loadedUnlimited) continue;
    patch[row.spec.key] = budgetValue(row.spec, row.text, row.unlimited, { inherit: false });
  }
  return patch;
}

/** → { node, load() }: a persistent card; load() re-reads every setting. */
export function limitsSettings({ ui, bridge, store }) {
  const { h, icon } = ui;
  const toast = ui.toast;

  /* ---------- number-or-Unlimited rows ---------- */
  const ROWS = [
    {
      key: 'maxLive', label: 'Agents at once',
      hint: `CodaClauda chat sessions that can work at the same time. Unlimited (the default) never closes one to make room; with a number, an idle one is closed first and a new turn waits for a free slot. ${MEMORY_HINT}`,
      supported: () => hasFeature('limitsGet') && hasFeature('limitsSet'),
      read: async () => (await callFeature('limitsGet'))?.maxLive,
      write: async v => (await callFeature('limitsSet', { maxLive: v }))?.maxLive,
    },
    {
      key: 'concurrent', label: 'Board requests at once',
      hint: `Dedicated board requests (questions, reviews, delegations) that run together; the rest wait in order. A request blocked waiting on a teammate it asked does not count, so nested handoffs keep moving; it resumes only into a free slot, so the total never passes this number. ${MEMORY_HINT}`,
      supported: () => true,
      read: async () => {
        try { return (await bridge.rpc('policy'))?.concurrent; }
        catch (error) { if (unsupported(error)) return (await bridge.rpc('limits'))?.concurrent; throw error; }
      },
      write: async v => (await bridge.rpc('policy-set', { concurrent: v }))?.concurrent,
      extra: () => boardLoadText(store?.board?.limits),
    },
  ];
  const rows = ROWS.map(spec => {
    const row = { spec, state: 'idle', saved: null, error: '', busy: false };
    row.input = h('input.input', {
      type: 'text', inputMode: 'numeric', 'aria-label': spec.label, style: { width: '120px' }, autocomplete: 'off',
      oninput: () => render(row), onkeydown: event => { if (event.key === 'Enter') { event.preventDefault(); save(row); } },
    });
    row.box = h('input', { type: 'checkbox', 'aria-label': `${spec.label}: unlimited`, onchange: () => render(row) });
    row.button = h('button.btn.small.primary', { type: 'button', onclick: () => save(row) }, icon('check'), 'Save');
    row.status = h('span.field-hint.ntfy-status', { role: 'status', style: { marginTop: '0' } });
    row.node = h('div.setting-row',
      h('div.setting-text', h('strong', spec.label), h('span.field-hint', spec.hint), row.status),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none', flexWrap: 'wrap' } },
        row.input, h('label.checkbox-label', row.box, h('span', 'Unlimited')), row.button));
    return row;
  });
  const value = row => limitValue(row.input.value, row.box.checked, LIMIT_MIN[row.spec.key]);
  function render(row) {
    row.node.hidden = row.state === 'hidden';
    if (row.state === 'hidden') return;
    const loaded = row.state === 'loaded';
    const v = value(row);
    const dirty = loaded && v !== row.saved;
    row.input.disabled = !loaded || row.busy || row.box.checked;
    row.box.disabled = !loaded || row.busy;
    row.button.disabled = !loaded || row.busy || !dirty || v == null;
    row.status.classList.toggle('bad', row.state === 'error' || (loaded && v == null));
    const extra = row.spec.extra?.() || '';
    row.status.textContent = row.state === 'error' ? `Couldn't read the setting: ${row.error}`
      : !loaded ? 'Reading…'
        : v == null ? `Enter a whole number from ${LIMIT_MIN[row.spec.key]} to ${Number.MAX_SAFE_INTEGER}, or tick Unlimited.`
          : row.busy ? 'Saving…'
            : dirty ? 'Not saved yet.' : `Now ${shown(row.saved)}.${extra ? ` ${extra}` : ''}`;
  }
  function show(row, saved) {
    row.saved = isUnlimited(saved) ? UNLIMITED : saved;
    row.box.checked = row.saved === UNLIMITED;
    row.input.value = row.saved === UNLIMITED ? '' : String(row.saved);
  }
  async function loadRow(row) {
    if (row.busy) return;
    if (!row.spec.supported()) { row.state = 'hidden'; render(row); return; }
    try {
      const saved = await row.spec.read();
      if (!isUnlimited(saved) && wholeNumber(saved, LIMIT_MIN[row.spec.key]) == null) throw new Error('The setting came back empty.');
      Object.assign(row, { state: 'loaded', error: '' });
      show(row, isUnlimited(saved) ? UNLIMITED : Number(saved));
    } catch (error) {
      if (row.spec.key === 'maxLive' && unsupported(error)) row.state = 'hidden';
      else Object.assign(row, { state: 'error', error: error?.message || String(error) });
    }
    render(row);
  }
  async function save(row) {
    const v = value(row);
    if (row.busy || row.state !== 'loaded' || v == null || v === row.saved) { render(row); return; }
    row.busy = true; render(row);
    try {
      const saved = await row.spec.write(v);
      show(row, saved === undefined ? v : saved);
      toast(`${row.spec.label}: ${shown(row.saved)}`, { kind: 'success', timeout: 2600 });
    } catch (error) {
      toast(`Couldn't save ${row.spec.label.toLowerCase()}: ${error?.message || error}`, { kind: 'error', timeout: 8000 });
    } finally { row.busy = false; render(row); }
  }

  /* ---------- grant defaults (policy.grant_defaults) ---------- */
  const defaults = { state: 'idle', error: '', busy: false };
  const fields = BUDGETS.map(spec => {
    const f = { spec, text: '', unlimited: false, loadedText: '', loadedUnlimited: false };
    f.input = h('input.input', { type: 'text', inputMode: spec.scale ? 'decimal' : 'numeric', autocomplete: 'off', 'aria-label': `Default ${spec.label.toLowerCase()}`, oninput: event => { f.text = event.currentTarget.value; renderDefaults(); } });
    f.box = h('input', { type: 'checkbox', 'aria-label': `Default ${spec.label.toLowerCase()}: ${spec.never ? 'never' : 'unlimited'}`, onchange: event => { f.unlimited = event.currentTarget.checked; renderDefaults(); } });
    f.node = h('div.field', h('span', spec.label), f.input, h('label.checkbox-label', f.box, h('span', spec.never ? 'Never' : 'Unlimited')));
    return f;
  });
  const defaultsStatus = h('span.field-hint.ntfy-status', { role: 'status' });
  const defaultsSave = h('button.btn.small.primary', { type: 'button', onclick: () => saveDefaults() }, icon('check'), 'Save defaults');
  const defaultsNode = h('div.setting-row', { style: { display: 'block' } },
    h('div.setting-text', h('strong', 'Grant defaults'),
      h('span.field-hint', 'What a new grant uses for each budget it leaves empty, including every live chat. A grant keeps the values it was created with; changing these affects only grants created afterwards.')),
    h('div.cx-form', { style: { marginTop: '10px' } }, ...fields.map(f => f.node)),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' } }, defaultsSave, defaultsStatus));
  function fill(saved) {
    for (const f of fields) {
      const { text, unlimited } = budgetField(f.spec, saved?.[f.spec.key]);
      Object.assign(f, { text, unlimited, loadedText: text, loadedUnlimited: unlimited });
      f.input.value = text; f.box.checked = unlimited;
    }
  }
  function renderDefaults() {
    defaultsNode.hidden = defaults.state === 'hidden';
    const loaded = defaults.state === 'loaded';
    let patch = null, problem = '';
    try { patch = loaded ? defaultsPatch(fields) : {}; } catch (error) { problem = error.message; }
    for (const f of fields) { f.input.disabled = !loaded || defaults.busy || f.unlimited; f.box.disabled = !loaded || defaults.busy; }
    defaultsSave.disabled = !loaded || defaults.busy || Boolean(problem) || !patch || !Object.keys(patch).length;
    defaultsStatus.classList.toggle('bad', defaults.state === 'error' || Boolean(problem));
    defaultsStatus.textContent = defaults.state === 'error' ? `Couldn't read the defaults: ${defaults.error}`
      : !loaded ? 'Reading…' : problem || (defaults.busy ? 'Saving…' : patch && Object.keys(patch).length ? 'Not saved yet.' : 'Saved.');
  }
  async function loadDefaults() {
    if (defaults.busy) return;
    try {
      const policy = await bridge.rpc('policy');
      if (!policy?.grant_defaults || typeof policy.grant_defaults !== 'object') throw new Error('The board did not report its grant defaults.');
      fill(policy.grant_defaults);
      Object.assign(defaults, { state: 'loaded', error: '' });
    } catch (error) {
      if (unsupported(error)) defaults.state = 'hidden';
      else Object.assign(defaults, { state: 'error', error: error?.message || String(error) });
    }
    renderDefaults();
  }
  async function saveDefaults() {
    let patch;
    try { patch = defaultsPatch(fields); } catch (error) { toast(error.message, { kind: 'error', timeout: 8000 }); return; }
    if (!Object.keys(patch).length || defaults.busy) return;
    defaults.busy = true; renderDefaults();
    try {
      const policy = await bridge.rpc('policy-set', { grant_defaults: patch });
      fill(policy?.grant_defaults || {});
      toast(`Grant defaults saved: ${Object.keys(patch).map(key => `${BUDGETS.find(b => b.key === key).label.toLowerCase()} ${budgetText(BUDGETS.find(b => b.key === key), patch[key])}`).join(', ')}`, { kind: 'success', timeout: 4200 });
    } catch (error) {
      toast(`Couldn't save the grant defaults: ${error?.message || error}`, { kind: 'error', timeout: 8000 });
    } finally { defaults.busy = false; renderDefaults(); }
  }

  /* ---------- wake loop guard ---------- */
  const guard = { busy: false };
  const guardOn = h('input', { type: 'checkbox', 'aria-label': 'Wake loop guard', onchange: () => renderGuard() });
  const guardCount = h('input.input', { type: 'text', inputMode: 'numeric', autocomplete: 'off', 'aria-label': 'Wakes per pair per hour', style: { width: '90px' }, oninput: () => renderGuard() });
  const guardSave = h('button.btn.small.primary', { type: 'button', onclick: () => saveGuard() }, icon('check'), 'Save');
  const guardStatus = h('span.field-hint.ntfy-status', { role: 'status', style: { marginTop: '0' } });
  const guardNode = h('div.setting-row',
    h('div.setting-text', h('strong', 'Wake loop guard'),
      h('span.field-hint', 'Two CodaClauda sessions that wake each other this many times in an hour pause waking each other until older wakes age out; their messages wait unread and you get a notice in that chat (and on your phone if push is set up). Your own messages never count. There is no other limit on how many sessions wake or how often.'),
      guardStatus),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none', flexWrap: 'wrap' } },
      h('label.switch', guardOn, h('span')), guardCount, h('span.muted', 'per hour'), guardSave));
  let guardSaved = null;
  function renderGuard() {
    const loaded = Boolean(guardSaved) && wake.supported();
    guardNode.hidden = !wake.supported();
    const count = wholeNumber(guardCount.value, LIMIT_MIN.pairPerHour);
    const dirty = loaded && (guardOn.checked !== guardSaved.on || count !== guardSaved.pairPerHour);
    guardOn.disabled = !loaded || guard.busy;
    guardCount.disabled = !loaded || guard.busy || !guardOn.checked;
    guardSave.disabled = !loaded || guard.busy || !dirty || count == null;
    guardStatus.classList.toggle('bad', loaded && count == null);
    guardStatus.textContent = !loaded ? (wake.error ? `Couldn't read the setting: ${wake.error}` : 'Reading…')
      : count == null ? 'Enter a whole number of wakes per hour (1 or more).'
        : guard.busy ? 'Saving…' : dirty ? 'Not saved yet.' : guardSaved.on ? `On, ${guardSaved.pairPerHour} per hour.` : 'Off.';
  }
  function syncGuard() {
    if (guard.busy || !wake.loopGuard) { renderGuard(); return; }
    const fresh = normalizeGuard(wake.loopGuard);
    if (!guardSaved || guardSaved.on !== fresh.on || guardSaved.pairPerHour !== fresh.pairPerHour) {
      guardSaved = fresh; guardOn.checked = fresh.on; guardCount.value = String(fresh.pairPerHour);
    }
    renderGuard();
  }
  async function saveGuard() {
    const count = wholeNumber(guardCount.value, LIMIT_MIN.pairPerHour);
    if (count == null || guard.busy) return;
    guard.busy = true; renderGuard();
    try {
      const saved = await wake.setLoopGuard({ on: guardOn.checked, pairPerHour: count });
      guardSaved = null; guard.busy = false; syncGuard();
      toast(saved.on ? `Wake loop guard: ${saved.pairPerHour} per hour` : 'Wake loop guard off', { kind: 'success', timeout: 3000 });
    } catch (error) {
      toast(`Couldn't save the wake loop guard: ${error?.message || error}`, { kind: 'error', timeout: 8000 });
    } finally { guard.busy = false; renderGuard(); }
  }
  wake.on('change', syncGuard);

  const node = h('section.card.settings-card.limits-card',
    h('h2.panel-title', 'Limits'),
    ...rows.map(row => row.node),
    defaultsNode,
    guardNode,
    h('p.field-hint', 'Each grant can still set its own budgets in Agent setup → Grant & send. Who may start teammates is a per-project switch in Projects.'));

  rows.forEach(render); renderDefaults(); renderGuard();
  // The board's active / waiting / queued counts arrive with each status poll.
  store?.on?.('change', () => { const board = rows.find(row => row.spec.key === 'concurrent'); if (board && !board.node.hidden) render(board); });
  return {
    node,
    load: () => Promise.all([...rows.map(loadRow), loadDefaults(), wake.load().then(syncGuard)]),
  };
}
