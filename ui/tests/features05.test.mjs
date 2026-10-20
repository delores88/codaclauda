import test from 'node:test';
import assert from 'node:assert/strict';
import { validNtfyUrl, parseServers, normalizeUsage, patchLines, camel } from '../app/features.js';
import { searchTranscript } from '../app/session-model.js';

test('0.5 helpers: ntfy URLs are https only, MCP rows parse, usage is clamped', () => {
  assert.equal(validNtfyUrl('').ok, true);
  assert.equal(validNtfyUrl('http://ntfy.sh/topic').ok, false);
  assert.equal(validNtfyUrl('https://ntfy.sh/').ok, false);
  assert.equal(validNtfyUrl('https://ntfy.sh/ben-builds').url, 'https://ntfy.sh/ben-builds');
  const parsed = parseServers([{ name: 'playwright', command: 'playwright-mcp', args: '--headless\n\n', env: 'A=1' }, { name: '', command: '' }]);
  assert.deepEqual(parsed.servers, [{ name: 'playwright', command: 'playwright-mcp', args: ['--headless'], env: { A: '1' } }]);
  assert.equal(parseServers([{ name: 'codaclauda', command: 'x' }]).ok, false);
  assert.deepEqual(normalizeUsage({ input: 10, output: 5, costUsd: null, contextPct: 140 }), { input: 10, output: 5, cached: 0, total: 15, costUsd: null, contextPct: 100 });
  assert.equal(camel('session_worktree_apply'), 'sessionWorktreeApply');
  assert.deepEqual(patchLines('diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n').map(l => l.kind), ['file', 'hunk', 'del', 'add']);
});

test('history search finds the newest matching item with a snippet', () => {
  const items = [
    { kind: 'owner', text: 'Fix the flaky login test', provider: 'claude' },
    { kind: 'agent', text: 'The login test was flaky because of a timer.', provider: 'claude' },
  ];
  const hit = searchTranscript(items, 'LOGIN');
  assert.equal(hit.item, items[1]);
  assert.match(hit.snippet, /login test/);
  assert.equal(searchTranscript(items, 'nothing here'), null);
});
