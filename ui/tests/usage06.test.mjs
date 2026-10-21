import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsageSettings, usageStatusText, USAGE_COPY, billingLabel, creditEstimateText, usageBanner } from '../app/views/settings-usage.js';
import { buildTranscript } from '../app/session-model.js';
import { sessions as singleton } from '../app/sessions.js';
import { desktop } from '../app/bridge.js';

const T = 1_760_000_000_000;
// Recorded account/rateLimits/read shape (codex 0.163.0-alpha.10.2) after the weekly limit.
const LIMITED = { ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 1792573200 },
  secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1792832400 }, credits: { hasCredits: true, unlimited: false, balance: '11.86' }, spendControlReached: false },
rateLimitResetCredits: { availableCount: 2 } };

function stub(t, name, fn) {
  const had = Object.hasOwn(desktop, name), original = desktop[name];
  desktop[name] = fn;
  t.after(() => { if (had) desktop[name] = original; else delete desktop[name]; });
}

test('the usage setting is on unless saved off, and Claude has no reset switch', () => {
  assert.deepEqual(normalizeUsageSettings(null), { codex: { useCredits: true, useResets: true }, claude: { useCredits: true }, error: null });
  assert.equal(normalizeUsageSettings({ codex: { useResets: false } }).codex.useResets, false);
  assert.equal(normalizeUsageSettings({ codex: { useCredits: 'no' } }).codex.useCredits, true);
  assert.deepEqual(Object.keys(normalizeUsageSettings({ claude: { useResets: false } }).claude), ['useCredits']);
});

test('Settings > Usage states its scope, that off is an admission policy, and two kinds of reset', () => {
  assert.match(USAGE_COPY.intro, /only to the sessions CodaClauda owns/);
  assert.match(USAGE_COPY.intro, /not to other Codex or Claude apps and not to your provider account's own settings/);
  assert.match(USAGE_COPY.codexCredits.hint, /Off is an admission policy/);
  assert.match(USAGE_COPY.codexCredits.hint, /crosses the limit mid-run.+may still draw credits/);
  assert.match(USAGE_COPY.claudeCredits.hint.join(''), /admission policy too: a turn already running .+ may still use them/);
  assert.match(USAGE_COPY.claudeCredits.hint.join(''), /no earned reset credits, so there is no reset switch/);
  assert.match(USAGE_COPY.codexResets.hint, /something you redeem/);
  assert.match(USAGE_COPY.codexResets.hint, /different from the weekly window resetting on its own/);
  assert.match(USAGE_COPY.footer, /estimates, never an invoice/);
  assert.match(USAGE_COPY.footer, /credit units, not money/);
  const all = [USAGE_COPY.intro, USAGE_COPY.codexResets.hint, USAGE_COPY.codexCredits.hint, USAGE_COPY.claudeCredits.hint.join(''), USAGE_COPY.footer].join(' ');
  assert.doesNotMatch(all, /\$\s*\d/, 'no guessed prices');
});

test('the plan line separates the natural reset from earned reset credits and keeps unknown fields unknown', () => {
  assert.equal(usageStatusText('codex', { snapshot: null }), '');
  const line = usageStatusText('codex', { snapshot: LIMITED, state: 'limited', limited: true });
  assert.match(line, /^Plan limit reached\. weekly window 100% used, resets on its own .+ · 5-hour window 41% used, resets on its own /);
  assert.match(line, / · ChatGPT credit balance 11\.86 \(credit units, not money\) · 2 earned reset credits to redeem$/);
  assert.doesNotMatch(line, /\$/);
  // Absent ordinaryUsageAllowed, credits, spend cap and reset count: "not reported", never zero or "none".
  const sparse = usageStatusText('codex', { snapshot: { rateLimits: { primary: { usedPercent: 41, windowDurationMins: 300 } } }, limited: false });
  assert.match(sparse, /^Plan limit state not reported\. 5-hour window 41% used · ChatGPT credits not reported · spend-cap state not reported · earned reset credits not reported$/);
  assert.match(usageStatusText('claude', { snapshot: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1792832400 }, overage: true }),
    /^Plan limit reached \(seven day\), resets on its own .+ · on usage credits$/);
  assert.equal(usageStatusText('claude', { snapshot: {} }), 'Plan state not reported');
});

test('billing and per-turn credits are labeled as plan states and estimates, never money', () => {
  assert.equal(creditEstimateText({ turnId: 't', micros: 120000, estimate: true }), '≈0.12 credits (estimate, not an invoice)');
  assert.equal(creditEstimateText({ turnId: 't', micros: null }), 'Not reported');
  assert.equal(creditEstimateText(null), '');
  assert.match(billingLabel('reset'), /after redeeming an earned reset credit/);
  assert.match(billingLabel('unknown'), /did not report the limit state/);
  assert.equal(billingLabel(undefined), 'Your plan');
  for (const b of ['credits', 'usage-credits', 'reset', 'unknown', null]) assert.doesNotMatch(billingLabel(b), /\$/);
});

test('a held turn offers Try now and Stop; a sent turn stopped at the limit offers only Continue, once idle', () => {
  const held = { turnId: 't_a', text: "Codex's plan limit is reached and ChatGPT credits are off in Settings > Usage. Nothing was sent. Waiting for the plan to reset; check Settings > Usage.", retryAt: null };
  assert.deepEqual(usageBanner({ held }), { kind: 'held', turnId: 't_a', title: 'Held at the plan limit: not sent', text: held.text, actions: ['retry', 'cancel'] });
  const stopped = usageBanner({ usageStopped: { turnId: 't_b' } });
  assert.deepEqual([stopped.kind, stopped.turnId, stopped.actions], ['stopped', 't_b', ['continue']]);
  assert.match(stopped.text, /part of it may already have run\. Review what ran, then Continue/);
  assert.match(stopped.text, /Nothing is replayed/);
  assert.equal(usageBanner({ usageStopped: { turnId: 't_b' } }, { running: true }), null);
  assert.equal(usageBanner({ held, usageStopped: { turnId: 't_b' } }).kind, 'held');
  assert.equal(usageBanner({}), null);
});

test('the sessions client tracks held and stopped turns and sends the owner actions', async t => {
  const sessions = new singleton.constructor();
  sessions.list = [{ id: 'a', provider: 'codex', status: 'idle', lastActivityAt: T }];
  sessions.scheduleRefresh = () => {};
  sessions.onEvent({ id: 'a', kind: 'usage', usage: {}, held: { turnId: 't1', text: 'held' }, usageStopped: null });
  assert.equal(sessions.session('a').held.turnId, 't1');
  sessions.onEvent({ id: 'a', kind: 'usage', held: null, usageStopped: { turnId: 't2', provider: 'codex' } });
  assert.equal(sessions.session('a').held, null);
  assert.equal(sessions.session('a').usageStopped.turnId, 't2');
  const calls = [];
  stub(t, 'sessionContinue', async args => { calls.push(['continue', args]); return { accepted: true, turnId: 't3' }; });
  stub(t, 'sessionRetryHeld', async args => { calls.push(['retry', args]); return { released: true }; });
  await sessions.continueTurn('a', 't2');
  await sessions.retryHeld('a');
  assert.deepEqual(calls, [['continue', { id: 'a', turnId: 't2' }], ['retry', { id: 'a' }]]);
  assert.equal(sessions.session('a').usageStopped, null);
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
