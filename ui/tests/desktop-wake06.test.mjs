import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, camel, wakeAddressChoices, normalizeBindings, deliveryText, continueBlock, CONTINUE_REFUSALS } from '../app/features.js';
import { desktop } from '../app/bridge.js';

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

test('receipts read as Codex reported them and Continue is blocked while bound or recently active', () => {
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

  assert.equal(continueBlock({ active: false }, binding).code, 'CONVERSATION_BOUND');
  assert.match(continueBlock({ active: true }, null).text, /Fork instead/);
  assert.equal(continueBlock({ active: false }, null), null);
  assert.deepEqual(CONTINUE_REFUSALS, ['CONVERSATION_ACTIVE', 'CONVERSATION_BOUND']);
});
