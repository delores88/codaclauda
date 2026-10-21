import test from 'node:test';
import assert from 'node:assert/strict';
import { grantLimits, expiresText } from '../app/views/connect.js';
import { defaultsPatch, boardLoadText, LIMIT_MIN } from '../app/views/settings-limits.js';
import { BUDGETS, budget, budgetValue, budgetField, budgetText, compareGrants, grantActive, grantState, grantLimitsText, liveGrantUsable, limitValue, wholeNumber, LEGACY_TEXT, MAX_SAFE } from '../app/budgets.js';
import { teamFor, teamPayload, TEAM_DEFAULTS } from '../app/team.js';
import { normalizeGuard, guardText, wakeCounts, LOOP_GUARD_DEFAULT } from '../app/wake.js';

const NOW = 1_760_000_000_000;

test('grant form converts hours and days to whole seconds and leaves empty fields to the owner default', () => {
  assert.deepEqual(grantLimits({}), {});
  assert.deepEqual(grantLimits({ max_requests: '100', max_delegations: '0', timeout_seconds: '8', expires_seconds: '7' }),
    { max_requests: 100, max_delegations: 0, timeout_seconds: 28800, expires_seconds: 604800 });
  assert.equal(grantLimits({ timeout_seconds: '1.5' }).timeout_seconds, 5400);
  assert.equal(grantLimits({ expires_seconds: '0.5' }).expires_seconds, 43200);
  assert.equal(grantLimits({ timeout_seconds: '0.0028' }).timeout_seconds, 10);   // the 10-second minimum
  // Far beyond the old 720 h / 365 d / 100000 ceilings: any whole safe value is fine.
  assert.equal(grantLimits({ timeout_seconds: '100000' }).timeout_seconds, 360_000_000);
  assert.equal(grantLimits({ max_requests: String(MAX_SAFE) }).max_requests, MAX_SAFE);
  for (const [key, text] of [['max_requests', '0'], ['max_requests', '1.5'], ['max_requests', '-1'], ['max_requests', '1e3'], ['max_requests', String(MAX_SAFE + 1)],
    ['max_turns', '0'], ['max_mcp_calls', '0'], ['timeout_seconds', '0.001'], ['timeout_seconds', 'abc'], ['expires_seconds', '-2'], ['timeout_seconds', '9'.repeat(16)]]) {
    assert.throws(() => grantLimits({ [key]: text }), new RegExp(budget(key).label), `${key}=${text}`);
  }
});

test('zero, inherit, finite and unlimited stay distinct through the form and back', () => {
  for (const spec of BUDGETS) {
    const finite = spec.scale ? 2 * spec.scale : Math.max(spec.min, 3);
    const cases = [[undefined, { text: '', unlimited: false }], ['unlimited', { text: '', unlimited: true }], [finite, budgetField(spec, finite)]];
    if (spec.min === 0) cases.push([0, { text: '0', unlimited: false }]);
    for (const [wire, form] of cases) {
      assert.deepEqual(budgetField(spec, wire), form, `${spec.key} ${wire}`);
      assert.equal(budgetValue(spec, form.text, form.unlimited), wire, `${spec.key} ${wire}`);
    }
  }
  assert.deepEqual(budgetField(budget('expires_seconds'), 'never'), { text: '', unlimited: true });
  assert.deepEqual(grantLimits({ max_hops: '0', max_turns_unlimited: true, expires_seconds_unlimited: true }), { max_hops: 0, max_turns: 'unlimited', expires_seconds: 'unlimited' });
  // Settings defaults cannot inherit: empty means "enter a value or tick Unlimited".
  assert.throws(() => budgetValue(budget('max_turns'), '', false, { inherit: false }), /enter a value or tick Unlimited/);
  assert.equal(budgetText(budget('timeout_seconds'), 28800), '8 h');
  assert.equal(budgetText(budget('expires_seconds'), 'unlimited'), 'never');
  assert.equal(budgetText(budget('max_turns'), 'unlimited'), 'unlimited');
});

test('never-expiring and legacy grants display and count correctly; revoked ones never do', () => {
  const never = { id: 'g1', policy_version: 1, expires_at: 'never', revoked_at: null, effective: { max_requests: 'unlimited', max_turns: 40, timeout_seconds: 86400, expires_seconds: 'unlimited' } };
  assert.ok(grantActive(never, NOW));
  assert.equal(expiresText(never, () => 'x', NOW), 'never expires');
  assert.equal(grantLimitsText(never), 'unlimited requests · 24 h per run · 40 turns');
  assert.equal(grantLimitsText({ policy_version: 1, effective: { max_hops: 1, timeout_seconds: 45 } }), '1 hop · 45 s per run');
  assert.equal(budgetText(budget('expires_seconds'), 3600), '1 h');
  const revoked = { ...never, revoked_at: NOW / 1000 - 5, expires_at: NOW / 1000 - 5 };
  assert.equal(grantState(revoked, NOW), 'revoked');
  assert.equal(grantState({ expires_at: NOW / 1000 - 1 }, NOW), 'expired');
  const legacy = { id: 'old', expires_at: NOW / 1000 + 600, max_requests: 16, timeout_seconds: 600 };
  assert.equal(grantLimitsText({ ...legacy, effective: { max_requests: 16, timeout_seconds: 600, max_turns: 12, max_mcp_calls: 128, max_compute_jobs: 2 } }), `${LEGACY_TEXT} · 16 requests · 10 min per run · 2 compute jobs`);
  assert.ok(grantLimitsText(legacy).startsWith(`${LEGACY_TEXT} · 16 requests · 10 min per run`));
  // The live chat reuses a never-expiring or unlimited grant, and replaces a revoked or exhausted one.
  const thread = { grantId: 'g1', grantUsed: 500, grantExpiresAt: 'never' };
  assert.ok(liveGrantUsable(thread, never, NOW));
  assert.ok(!liveGrantUsable(thread, revoked, NOW));
  assert.ok(!liveGrantUsable(thread, { ...never, effective: { max_requests: 501 } }, NOW));
  assert.ok(liveGrantUsable(thread, { ...never, effective: { max_requests: 502 } }, NOW));
  assert.ok(liveGrantUsable(thread, undefined, NOW));
  assert.ok(!liveGrantUsable({ grantId: 'g', grantExpiresAt: NOW + 60e3 }, undefined, NOW));
  assert.ok(!liveGrantUsable({ grantId: null }, never, NOW));
  // Authorizations sort by what the board reports (no created_at): active first, latest expiry, then id.
  const soon = { id: 'a-soon', expires_at: NOW / 1000 + 60 }, later = { id: 'z-later', expires_at: NOW / 1000 + 6000 };
  const expired = { id: 'b-old', expires_at: NOW / 1000 - 60 };
  const order = [expired, soon, revoked, legacy, later, { ...never, id: 'g0' }, never].sort((a, b) => compareGrants(a, b, NOW)).map(g => g.id);
  assert.deepEqual(order, ['g0', 'g1', 'z-later', 'old', 'a-soon', 'g1', 'b-old']);
});

test('Settings limits take a whole number or Unlimited and save only changed defaults', () => {
  assert.deepEqual(LIMIT_MIN, { maxLive: 1, concurrent: 1, pairPerHour: 1 });
  assert.equal(limitValue('6', false), 6);
  assert.equal(limitValue(String(MAX_SAFE), false), MAX_SAFE);
  assert.equal(limitValue('', true), 'unlimited');
  for (const bad of ['0', '2.5', '', 'x', '-1', String(MAX_SAFE + 1), '07e1']) assert.equal(limitValue(bad, false), null, bad);
  assert.equal(wholeNumber('0', 0), 0);
  const rows = BUDGETS.map(spec => { const f = budgetField(spec, spec.key === 'timeout_seconds' ? 86400 : 'unlimited'); return { spec, ...f, loadedText: f.text, loadedUnlimited: f.unlimited }; });
  assert.deepEqual(defaultsPatch(rows), {});
  rows.find(r => r.spec.key === 'max_turns').unlimited = false;
  rows.find(r => r.spec.key === 'max_turns').text = '250';
  rows.find(r => r.spec.key === 'timeout_seconds').unlimited = true;
  assert.deepEqual(defaultsPatch(rows), { max_turns: 250, timeout_seconds: 'unlimited' });
  rows.find(r => r.spec.key === 'max_hops').unlimited = false;
  assert.throws(() => defaultsPatch(rows), /Maximum hops: enter a value/);
  assert.equal(boardLoadText({ concurrent: 'unlimited', active: 2, waiting: 1, queued: 3 }), 'Right now 2 active · 1 waiting on a teammate · 3 queued.');
  assert.equal(boardLoadText(null), '');
});

test('team and wake settings have stable shapes and no wake caps', () => {
  const project = { id: 'local:c:/work/app', ids: ['local:c:/work/app', 'gh:ben/app'], name: 'App', path: 'C:\\work\\app' };
  assert.deepEqual(teamFor(null, project), { key: project.id, ...TEAM_DEFAULTS });
  assert.deepEqual(teamFor({ 'gh:ben/app': { agentsCanStart: true, maxAgentStartedLive: 'unlimited' } }, project), { key: 'gh:ben/app', agentsCanStart: true, maxAgentStartedLive: 'unlimited' });
  assert.equal(teamFor({ [project.id]: { agentsCanStart: true, maxAgentStartedLive: 0 } }, project).maxAgentStartedLive, 8);
  assert.deepEqual(teamPayload(project, { agentsCanStart: true, maxAgentStartedLive: 3 }), { projectId: project.id, cwd: project.path, name: 'App', ids: project.ids, agentsCanStart: true, maxAgentStartedLive: 3 });
  assert.deepEqual(normalizeGuard(undefined), LOOP_GUARD_DEFAULT);
  assert.deepEqual(normalizeGuard({ on: false, pairPerHour: 5 }), { on: false, pairPerHour: 5 });
  assert.deepEqual(normalizeGuard({ on: 'yes', pairPerHour: 0 }), LOOP_GUARD_DEFAULT);
  assert.match(guardText({ on: true, pairPerHour: 20 }), /woke each other 20 times in the last hour/);
  assert.match(guardText({ on: false, pairPerHour: 20 }), /without any limit/);
  // Counters only: no "/6 this hour" or "/30 today" caps.
  assert.equal(wakeCounts({ wakes: { hour: 40, day: 300, total: 900 } }), '40 this hour · 300 today · 900 in all');
});
