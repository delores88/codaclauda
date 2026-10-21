import test from 'node:test';
import assert from 'node:assert/strict';
import * as features from '../app/features.js';
import { desktop } from '../app/bridge.js';

const { COMMANDS, camel, wakeAddressChoices, normalizeBindings, deliveryText } = features;
// The preview backend keeps its state in localStorage; give it an in-memory one.
const saved = new Map();
globalThis.localStorage = { getItem: k => (saved.has(k) ? saved.get(k) : null), setItem: (k, v) => saved.set(k, String(v)), removeItem: k => saved.delete(k) };
const { mockHandlers } = await import('../dev/mock.js');
const mock = mockHandlers().desktop;

test('Wake by mail wrappers exist under the camelCase of their commands', () => {
  for (const key of ['desktopBindings', 'desktopBind', 'desktopUnbind', 'adopt']) assert.equal(typeof desktop[camel(COMMANDS[key])], 'function', key);
});

test('a Codex chat can bind any known board address except reserved and CodaClauda ones, likely ones first', () => {
  const addresses = [
    { name: 'owner', label: 'Ben' }, { name: 'codaclauda-team', label: 'team' }, { name: 'claude-phaseforge', label: 'Claude Code PhaseForge release session' },
    { name: 'codex-marketplace', label: 'Rebuild DeloresAI marketplace' }, { name: 'codex-claudacoda', label: 'CodaClauda Codex chat' },
    { name: 'codex-codaclauda-1a2b', label: 'CodaClauda Codex session: x' }, { name: 'codex-claudacoda', label: 'duplicate' },
  ];
  const choices = wakeAddressChoices(addresses, { taken: ['codex-codaclauda-1a2b'], folder: 'CodaClauda' });
  assert.deepEqual(choices.map(c => [c.name, c.likely]), [['codex-claudacoda', true], ['codex-marketplace', true], ['claude-phaseforge', false]]);
  assert.deepEqual(wakeAddressChoices(null), []);
});

test('receipts read as Codex reported them', () => {
  const [binding] = normalizeBindings([{ address: 'codex-desk', threadId: 't1', cwd: 'C:\\w', boundAt: 1,
    last: { at: 5, status: 'unreachable', exitCode: 1, messages: 2, senders: ['owner', 'claude-phaseforge'], detail: 'Codex could not reach that chat: thread not loaded: t1', stderr: 'Error: thread not loaded: t1' } }, { address: 'x' }]);
  assert.equal(binding.last.status, 'unreachable');
  const shown = deliveryText(binding.last);
  assert.equal(shown.tone, 'warn');
  assert.equal(shown.text, '2 messages: Codex could not reach that chat: thread not loaded: t1');
  assert.match(shown.title, /exit 1\nstderr: Error: thread not loaded/);
  assert.equal(deliveryText({ ...binding.last, status: 'queued', messages: 1, senders: ['owner'] }).text, 'Queued in that chat: 1 message from owner');
  assert.equal(deliveryText(null).text, 'No new mail since it was bound.');
  assert.equal(deliveryText({ ...binding.last, status: 'sending' }).tone, 'warn');
});

test('Continue makes a separate copy, and continuing in place without known ownership is refused', () => {
  // The in-place refusal helpers are gone: there is no in-place Continue to refuse.
  assert.equal('continueBlock' in features || 'CONTINUE_REFUSALS' in features, false);
  const row = mock.external_sessions_list().sessions.find(s => s.provider === 'claude' && s.active);
  const args = { provider: 'claude', providerSessionId: row.providerSessionId, cwd: row.cwd };
  assert.throws(() => mock.session_adopt({ ...args, mode: 'continue' }),
    e => e.code === 'OWNERSHIP_UNKNOWN' && /this Claude Code conversation/.test(e.message) && /separate, labeled copy/.test(e.message));
  // A recently active conversation is copied, never refused; the default and 'fork' are the same copy.
  for (const mode of [undefined, 'fork']) {
    const copy = mock.session_adopt({ ...args, mode });
    assert.deepEqual([copy.copy, copy.existing, copy.session.title, copy.session.providerSessionId, copy.session.threadId, copy.session.forkFrom, copy.session.adoptedFrom.copy],
      [true, undefined, 'Claude Code conversation (copy)', null, null, row.providerSessionId, true]);
  }
  assert.throws(() => mock.session_adopt({ ...args, mode: 'resume-original' }), e => e.code === 'INVALID_ARGUMENTS');
});
