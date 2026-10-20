/* Settings → Limits: owner settings for how much runs at the same time.
 *   Agents at once          CodaClauda chat sessions (desktop.sessionLimitsGet/Set; hidden on a build without them)
 *   Board requests at once  dedicated board requests the coordinator runs together (rpc limits / limits-set)
 * Neither is a safety boundary: scope, access and owner-only grants are unchanged. */
import { has as hasFeature, call as callFeature } from '../features.js';

export const LIMIT_RANGES = { maxLive: { min: 1, max: 32 }, concurrent: { min: 1, max: 64 } };
const MEMORY_HINT = 'Each one is a full agent process, so more at once uses more memory.';

/** A whole number within { min, max }, or null. */
export function limitValue(value, { min, max }) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,6}$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

const unsupported = error => error?.code === 'UNSUPPORTED' || error?.code === 'MOCK_UNSUPPORTED' || /not found|unknown command/i.test(String(error?.message || error || ''));

/** → { node, load() }: a persistent card; load() re-reads both settings. */
export function limitsSettings({ ui, bridge }) {
  const { h, icon } = ui;
  const ROWS = [
    {
      key: 'maxLive', label: 'Agents at once',
      hint: `CodaClauda chat sessions that can work at the same time. An idle one is closed to make room; when all are busy, a new turn is refused until one finishes. ${MEMORY_HINT}`,
      supported: () => hasFeature('limitsGet') && hasFeature('limitsSet'),
      read: async () => (await callFeature('limitsGet'))?.maxLive,
      write: async n => (await callFeature('limitsSet', { maxLive: n }))?.maxLive,
    },
    {
      key: 'concurrent', label: 'Board requests at once',
      hint: `Dedicated board requests (questions, reviews, delegations) that run together; the rest wait in order. ${MEMORY_HINT}`,
      supported: () => true,
      read: async () => (await bridge.rpc('limits'))?.concurrent,
      write: async n => (await bridge.rpc('limits-set', { concurrent: n }))?.concurrent,
    },
  ];
  const rows = ROWS.map(spec => {
    const range = LIMIT_RANGES[spec.key];
    const row = { spec, range, state: 'idle', saved: null, error: '', busy: false };
    row.input = h('input.input', {
      type: 'number', min: range.min, max: range.max, step: 1, 'aria-label': spec.label, style: { width: '96px' },
      oninput: () => render(row), onkeydown: event => { if (event.key === 'Enter') { event.preventDefault(); save(row); } },
    });
    row.button = h('button.btn.small.primary', { type: 'button', onclick: () => save(row) }, icon('check'), 'Save');
    row.status = h('span.field-hint.ntfy-status', { role: 'status', style: { marginTop: '0' } });
    row.node = h('div.setting-row',
      h('div.setting-text', h('strong', spec.label), h('span.field-hint', spec.hint), row.status),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none' } }, row.input, row.button));
    return row;
  });
  const node = h('section.card.settings-card.limits-card',
    h('h2.panel-title', 'Limits'),
    ...rows.map(row => row.node),
    h('p.field-hint', 'Per-request budgets (requests, hops, run time, turns, expiry) are set on each authorization in Agent setup → Grant & send.'));

  function render(row) {
    const hidden = row.state === 'hidden';
    row.node.hidden = hidden;
    if (hidden) return;
    const loaded = row.state === 'loaded';
    const value = limitValue(row.input.value, row.range);
    const dirty = loaded && value !== row.saved;
    row.input.disabled = !loaded || row.busy;
    row.button.disabled = !loaded || row.busy || !dirty || value == null;
    row.status.classList.toggle('bad', row.state === 'error' || (loaded && value == null));
    row.status.textContent = row.state === 'error' ? `Couldn't read the setting: ${row.error}`
      : !loaded ? 'Reading…'
        : value == null ? `Enter a whole number from ${row.range.min} to ${row.range.max}.`
          : row.busy ? 'Saving…'
            : dirty ? 'Not saved yet.' : `Now ${row.saved}.`;
  }
  async function loadRow(row) {
    if (!row.spec.supported()) { row.state = 'hidden'; render(row); return; }
    try {
      const n = Number(await row.spec.read());
      if (!Number.isInteger(n)) throw new Error('The setting came back empty.');
      Object.assign(row, { state: 'loaded', saved: n, error: '' });
      row.input.value = String(n);
    } catch (error) {
      if (row.spec.key === 'maxLive' && unsupported(error)) row.state = 'hidden';
      else Object.assign(row, { state: 'error', error: error?.message || String(error) });
    }
    render(row);
  }
  async function save(row) {
    const value = limitValue(row.input.value, row.range);
    if (row.busy || row.state !== 'loaded' || value == null || value === row.saved) { render(row); return; }
    row.busy = true; render(row);
    try {
      const n = Number(await row.spec.write(value));
      row.saved = Number.isInteger(n) ? n : value;
      row.input.value = String(row.saved);
      ui.toast(`${row.spec.label}: ${row.saved}`, { kind: 'success', timeout: 2600 });
    } catch (error) {
      ui.toast(`Couldn't save ${row.spec.label.toLowerCase()}: ${error?.message || error}`, { kind: 'error', timeout: 8000 });
    } finally { row.busy = false; render(row); }
  }
  rows.forEach(render);
  return { node, load: () => Promise.all(rows.filter(row => !row.busy).map(loadRow)) };
}
