import test from 'node:test';
import assert from 'node:assert/strict';
import { requestGroup, activeStates, setupPrompt, psLiteral, updatePresentation, taskConversations, messagePage, messageDelivery } from '../view-model.js';

test('only dispatched states are active; queue and attention remain distinct', () => {
  for (const state of ['delivered', 'acknowledged', 'running']) {
    assert.equal(requestGroup({ state }), 'active'); assert.ok(activeStates.has(state));
  }
  assert.equal(requestGroup({ state: 'queued' }), 'queued');
  for (const state of ['failed', 'needs-owner', 'unrecognized']) assert.equal(requestGroup({ state }), 'attention');
  for (const state of ['completed', 'cancelled']) assert.equal(requestGroup({ state }), 'completed');
});
const context = { recipient: 'Codex', cli: "C:\\Apps\\Owner's app\\claudacoda-cli.exe", stateDir: 'C:\\Boards\\Current', endpoint: { id: 'claude-actual-id', agent: 'claude', label: 'Reviewer', workspace: 'C:\\Projects\\Current', executable: 'C:\\Tools\\claude.exe' }, questionId: 'fixed-question-id', reviewId: 'fixed-review-id' };
test('setup requires observed paths, uses exact endpoint IDs and actual CLI contracts', () => {
  assert.equal(setupPrompt({ ...context, cli: '' }), '');
  assert.equal(setupPrompt({ ...context, stateDir: '' }), '');
  const prompt = setupPrompt(context);
  assert.ok(prompt.includes("& 'C:\\Apps\\Owner''s app\\claudacoda-cli.exe'"));
  assert.ok(prompt.includes("--state-dir 'C:\\Boards\\Current' --json api discover"));
  assert.ok(prompt.includes('"target": "claude-actual-id"'));
  assert.ok(prompt.includes("wait 'fixed-question-id' --timeout 20"));
  assert.ok(prompt.includes('wait {"id":"fixed-question-id","timeout":20}'));
  assert.ok(prompt.includes('No grant selected'));
  assert.ok(prompt.includes('Do not invoke the owner CLI from a scoped agent session'));
  assert.ok(!prompt.includes('Benny')); assert.ok(prompt.includes('\u2022')); assert.ok(!prompt.includes('\u00e2\u20ac')); assert.ok(prompt.includes('max_requests')); assert.ok(prompt.includes('exact-owner-approved-relative-path')); assert.ok(prompt.includes('already authorized'));
  assert.equal(psLiteral("a'b"), "'a''b'");
});
test('selected grant is described without extending its authority', () => {
  const prompt = setupPrompt({ ...context, grant: { id: 'real-grant', allowed_paths: ['src'], kinds: ['review'] } });
  assert.ok(prompt.includes('"grant_id": "real-grant"'));
  assert.ok(prompt.includes('Allowed request kinds: ["review"]'));
  assert.ok(prompt.includes('covers every required relative path')); assert.ok(prompt.includes('sufficient remaining'));
});
test('updater actions fail closed and never infer an installed update', () => {
  for (const input of [{}, { phase: 'unexpected-success' }, { phase: 'unavailable' }]) assert.deepEqual(updatePresentation(input).actions, ['status']);
  assert.deepEqual(updatePresentation({ phase: 'available' }).actions, ['authorize']);
  assert.deepEqual(updatePresentation({ phase: 'idle', busy: true }).actions, ['status']);
  assert.deepEqual(updatePresentation({ phase: 'approval_pending' }).actions, ['poll']);
  assert.deepEqual(updatePresentation({ phase: 'authorized' }).actions, ['download']);
  assert.deepEqual(updatePresentation({ phase: 'downloaded' }).actions, ['install']);
  assert.deepEqual(updatePresentation({ phase: 'installing' }).actions, []);
  for (const phase of ['checking', 'downloading', 'authorizing', 'denied', 'expired']) assert.ok(!updatePresentation({ phase }).actions.includes('cancel'));
  for (const phase of ['denied', 'expired']) assert.deepEqual(updatePresentation({ phase }).actions, ['check']);
});

test('legacy root and peer requests form an ordered conversation without truncation', () => {
  const text = 'Full answer\n    indented code\n<script>literal text</script>\n' + 'detail '.repeat(500);
  const rows = [
    { id: 'root', root_id: 'root', prompt: 'Question', answer: text, origin: 'owner', target: 'codex', created_at: 10, updated_at: 30, state: 'completed' },
    { id: 'peer', root_id: 'root', prompt: 'Peer question', answer: 'Peer answer', origin: 'codex', target: 'claude', created_at: 20, updated_at: 25, state: 'completed' },
    { id: 'separate', root_id: 'separate', prompt: 'Independent', origin: 'owner', target: 'codex', created_at: 40, state: 'queued' }
  ];
  const groups = taskConversations(rows, id => ({ owner: 'You', codex: 'Codex reviewer', claude: 'Claude builder' })[id]);
  assert.equal(groups.length, 2);
  const messages = groups.find(item => item.id === 'task:root').messages;
  assert.deepEqual(messages.map(item => item.id), ['root:question', 'peer:question', 'peer:answer', 'root:answer']);
  assert.equal(messages[3].text, text); assert.equal(messages[1].sender, 'Codex reviewer'); assert.equal(messages[1].recipient, 'Claude builder');
  assert.equal(messages[3].status, 'completed');
  assert.equal(messages[0].status, 'task-completed');
});
test('same-time answer follows its question; message pages stay bounded and clamp', () => {
  const messages = taskConversations([{ id: 'same', prompt: 'Q', answer: 'A', created_at: 1, updated_at: 1, target: 'codex', state: 'completed' }])[0].messages;
  assert.deepEqual(messages.map(item => item.text), ['Q', 'A']);
  const many = Array.from({ length: 41 }, (_, id) => ({ id }));
  assert.equal(messagePage(many, 1).items.length, 20); assert.equal(messagePage(many, 2).items.length, 20);
  assert.equal(messagePage(many, 99).items[0].id, 40); assert.equal(messagePage([], 9).page, 1);
});
test('delivery states do not turn queued or submitted messages into acknowledgments', () => {
  assert.match(messageDelivery('queued'), /saved to inbox/);
  assert.match(messageDelivery('dispatching'), /not yet confirmed/);
  assert.match(messageDelivery('submitted'), /awaiting acknowledgment/);
  assert.match(messageDelivery('unknown'), /inspect before retrying/);
  assert.equal(messageDelivery('unexpected'), 'Status unavailable');
});
test('updater progress and approval URL use real bounded values', () => {
  const valid = updatePresentation({ phase: 'downloading', total_bytes: 100, progress_bytes: 120, approval_url: 'https://example.invalid/approve' });
  assert.equal(valid.progress, 100); assert.equal(valid.total, 100); assert.ok(valid.approvalUrl);
  for (const values of [{}, { total_bytes: 0, progress_bytes: 2 }, { total_bytes: 20, progress_bytes: -1 }]) assert.equal(updatePresentation(values).progress, null);
  assert.equal(updatePresentation({ approval_url: 'javascript:alert(1)' }).approvalUrl, null);
});
