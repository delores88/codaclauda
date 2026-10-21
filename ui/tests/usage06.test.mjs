import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsageSettings, usageStatusText } from '../app/views/settings-usage.js';
import { buildTranscript } from '../app/session-model.js';

test('the usage setting is on unless saved off, and the plan line names credits and resets', () => {
  assert.deepEqual(normalizeUsageSettings(null), { codex: { useCredits: true, useResets: true }, claude: { useCredits: true }, error: null });
  assert.equal(normalizeUsageSettings({ codex: { useResets: false } }).codex.useResets, false);
  assert.equal(normalizeUsageSettings({ codex: { useCredits: 'no' } }).codex.useCredits, true);
  assert.equal(usageStatusText('codex', { snapshot: null }), '');
  // Recorded account/rateLimits/read shape (codex 0.163) after the weekly limit.
  const snapshot = { ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 1792573200 },
    secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1792832400 }, credits: { hasCredits: true, unlimited: false, balance: '11.86' }, spendControlReached: false },
  rateLimitResetCredits: { availableCount: 2 } };
  const line = usageStatusText('codex', { snapshot, limited: true });
  assert.match(line, /^Plan limit reached\. weekly 100% used, resets .+ · 5-hour 41% used/);
  assert.match(line, /credits balance 11\.86 · 2 weekly resets available$/);
  assert.match(usageStatusText('claude', { snapshot: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1792832400 }, overage: true }), /^Plan limit reached \(seven day\), resets .+ · on usage credits$/);
});

test('engine notices render as their own transcript lines with only an https link', () => {
  const { items } = buildTranscript([
    { id: 's', turnId: 't', kind: 'notice', at: 1, text: 'Plan limit reached; continuing on ChatGPT credits (balance 11.86).', tone: 'info' },
    { id: 's', turnId: 't', kind: 'notice', at: 2, text: 'Codex usage limit stopped this turn.', tone: 'warn', link: 'https://claude.ai/settings/usage' },
    { id: 's', turnId: 't', kind: 'notice', at: 3, text: 'x', tone: 'loud', link: 'javascript:alert(1)' },
  ], { provider: 'codex', sessionId: 's' });
  assert.deepEqual(items.map(i => [i.kind, i.tone, i.link]), [['notice', 'info', ''], ['notice', 'warn', 'https://claude.ai/settings/usage'], ['notice', 'info', '']]);
  assert.equal(new Set(items.map(i => i.key)).size, 3);
});
