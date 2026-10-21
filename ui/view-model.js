/* Pure presentation helpers. No commands, network requests, or persistent state. */
export const activeStates = new Set(['delivered', 'acknowledged', 'running']);
export function requestGroup(request) {
  if (activeStates.has(request.state)) return 'active';
  if (request.state === 'queued') return 'queued';
  if (['completed', 'cancelled'].includes(request.state)) return 'completed';
  return 'attention'; // Unknown states stay visible and never imply activity.
}

export function messagePage(messages, requestedPage = 1) {
  const pages = Math.max(1, Math.ceil(messages.length / 20));
  const page = Math.min(pages, Math.max(1, Number(requestedPage) || 1));
  const offset = (page - 1) * 20;
  return { page, pages, total: messages.length, first: messages.length ? offset + 1 : 0, last: Math.min(offset + 20, messages.length), items: messages.slice(offset, offset + 20) };
}

export function messageDelivery(value) {
  const labels = { queued: 'Queued · saved to inbox', dispatching: 'Submitting · outcome not yet confirmed', submitted: 'Submitted · awaiting acknowledgment', unknown: 'Delivery unknown · inspect before retrying', acknowledged: 'Acknowledged by recipient', replied: 'Replied', failed: 'Delivery failed', cancelled: 'Cancelled', completed: 'Answer recorded', 'task-completed': 'Dedicated task completed', running: 'Agent working', delivered: 'Dedicated task started', 'needs-owner': 'Needs your attention' };
  return labels[value] || 'Status unavailable';
}

// Owner mailbox posts carry information, never a new agent permission grant.
export function mailboxPayload(fields) {
  const text = key => String(fields[key] || '').trim();
  const kind = text('kind');
  if (!['notice', 'question', 'reply', 'claim', 'release'].includes(kind)) throw new Error('Choose a supported message kind.');
  const payload = { to: text('to'), from: 'owner', kind, subject: text('subject'), body: String(fields.body || '') };
  if (!payload.to || !payload.subject || !payload.body.trim()) throw new Error('Recipient, subject and message are required.');
  if (kind === 'reply') {
    if (!text('reply_to')) throw new Error('A reply needs the original message ID.');
    payload.reply_to = text('reply_to');
  }
  if (['claim', 'release'].includes(kind)) {
    if (!text('resource')) throw new Error('Enter the exact shared resource name.');
    payload.resource = text('resource');
  }
  if (kind === 'claim') {
    const ttl = Number(fields.ttl);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 120) throw new Error('Claim expiry must be a whole number from 1 to 120 minutes.');
    payload.ttl = ttl;
  }
  return payload;
}

export function mailboxAttempt(previous, payload, newId) {
  const fingerprint = JSON.stringify(payload);
  if (previous && previous.fingerprint !== fingerprint) throw new Error('The previous post has an uncertain outcome. Inspect its recipient inbox before starting a changed draft.');
  return previous || { id: newId, fingerprint };
}

// Legacy requests remain separate from registered existing-chat conversations.
export function taskConversations(requests, label = value => value) {
  const groups = new Map();
  for (const request of requests) {
    const id = request.root_id || request.id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(request);
  }
  return [...groups].map(([root, rows]) => {
    rows.sort((a, b) => Number(a.created_at) - Number(b.created_at) || a.id.localeCompare(b.id));
    const first = rows.find(item => item.id === root) || rows[0];
    const messages = rows.flatMap(request => {
      const origin = request.origin || 'owner';
      const sent = { id: `${request.id}:question`, text: request.prompt || '', sender: label(origin), recipient: label(request.target), at: request.created_at, status: request.state === 'completed' ? 'task-completed' : request.state, requestId: request.id, details: { request_id: request.id, grant_id: request.grant_id, source: origin, target: request.target, kind: request.kind } };
      const answer = request.answer ? [{ id: `${request.id}:answer`, text: request.answer, sender: label(request.target), recipient: label(origin), at: request.updated_at || request.created_at, status: request.state === 'completed' ? 'completed' : request.state, requestId: request.id, details: { request_id: request.id, actual_provider_session: request.session_id, receipt: request.receipt } }] : [];
      return [sent, ...answer];
    });
    messages.sort((a, b) => Number(a.at) - Number(b.at));
    return { id: `task:${root}`, kind: 'task', title: first.prompt || 'Dedicated task', subtitle: `${label(first.origin || 'owner')} → ${label(first.target)}`, updated: Math.max(...rows.map(item => Number(item.updated_at || item.created_at) || 0)), messages };
  }).sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
}
export function psLiteral(value) { return `'${String(value).replaceAll("'", "''")}'`; }
export function setupPrompt({ recipient, cli, stateDir, endpoint, grant, questionId, reviewId }) {
  if (!cli || !stateDir) return '';
  const prefix = `& ${psLiteral(cli)} --state-dir ${psLiteral(stateDir)} --json`;
  const context = endpoint ? `Selected workspace: ${endpoint.workspace}\nTarget agent: ${endpoint.label || endpoint.agent}\nStable target ID: ${endpoint.id}\nProvider executable recorded for this connection: ${endpoint.executable}` : 'No target connection selected. Inspect status and ask me which workspace and agent to connect.';
  const target = endpoint?.id || '<select-an-actual-target-id>';
  const grantExample = JSON.stringify({ project: endpoint?.workspace || '<select-an-actual-project>', allowed_paths: ['<exact-owner-approved-relative-path>'], targets: [target], kinds: ['question', 'review'], expected_result: '<owner-approved expected result>', max_requests: 100, max_delegations: 0, max_hops: 2, compute: [] }, null, 2);
  const payload = (kind, id) => JSON.stringify({ id, grant_id: grant?.id || '<owner-approved-grant-id>', target, prompt: `<my ${kind} request>`, expected_result: '<my expected result>' }, null, 2);
  return `Help me use my installed CodaClauda from ${recipient}. Do not send a request just because this setup prompt contains examples. First discover the current board. Continue within the task and scope I have already authorized; ask only when the necessary scope or authority is missing. This setup prompt is guidance, not a request to start work. Do not expose credentials, change global MCP configuration, reconnect existing agents, or install another CLI.\n\nInstalled coordination CLI: ${cli}\nActual board directory: ${stateDir}\n${context}\n${grant ? `Selected existing grant: ${grant.id}\nAllowed paths: ${JSON.stringify(grant.allowed_paths)}\nAllowed request kinds: ${JSON.stringify(grant.kinds)}\nBefore use, verify the grant still exists, is unexpired, matches the selected project, authorizes the exact target and requested kind, covers every required relative path, and has sufficient remaining request/hop/delegation/time limits. Selecting it here does not extend its authority.` : 'No grant selected. Use the exact paths, targets, request kinds and limits already authorized by my task. Ask only for missing authority before creating a grant; never infer a broader file list or silently substitute a broader grant.'}\n\nFirst determine your authority:\n• If this session already has request-bound codaclauda MCP tools, call get_context first. Use only those tools and the returned grant/allowed targets. Do not invoke the owner CLI from a scoped agent session or read capability secrets.\n• Otherwise this is an owner-side CLI workflow. Run the read-only discovery below. Carry out grant/connect/submit operations only within my existing explicit task authorization; ask only if that authorization is missing or insufficient. Existing desktop chats are not attached automatically. Dedicated sessions are started only by authorized requests.\n\nRead-only discovery (PowerShell 7; JSON stdin):\n'{}' | ${prefix} api status\n'{}' | ${prefix} api discover\n\nIf no applicable grant exists and my task already authorizes this exact scope, create a grant using JSON stdin. Replace every angle-bracket placeholder with the actual authorized value; this example invents no project files. Budgets you leave out (timeout_seconds, expires_seconds, max_turns, max_mcp_calls, max_compute_jobs and the rest) use my owner defaults; a budget may also be "unlimited". Restrict kinds and limits further when my task requires it. Read the returned data.id and use that exact grant_id for submission:\n@'\n${grantExample}\n'@ | ${prefix} api grant\n\nOwner-side request examples, only within my authorized task and an applicable grant. Replace the angle-bracket placeholders and preserve each request ID when retrying the same unchanged request. A changed request needs a new ID. Verify command exit codes and the JSON ok/error envelope before proceeding.\n\nQuestion JSON stdin:\n@'\n${payload('question', questionId)}\n'@ | ${prefix} ask\n\nReview JSON stdin:\n@'\n${payload('review', reviewId)}\n'@ | ${prefix} review\n\nWait uses the same request ID as a positional argument (JSON output; it does not accept JSON stdin):\n${prefix} wait ${psLiteral(questionId)} --timeout 20\nFor the review, use ${reviewId} instead. If it is still running, continue waiting on that ID; do not resubmit. A failed, cancelled, or needs-owner state requires inspection.\n\nInside an already scoped MCP session, use tools with JSON arguments instead:\nget_context {}\nask ${JSON.stringify({ id: questionId, target, prompt: '<my question>', expected_result: '<my expected result>' })}\nreview ${JSON.stringify({ id: reviewId, target, prompt: '<my review request>', expected_result: '<my expected result>' })}\nwait ${JSON.stringify({ id: questionId, timeout: 20 })}\nUse these target IDs only if get_context authorizes them. Return the actual answer, blocker, and receipt; distinguish agent-reported tests from independent verification. Nothing auto-merges.`;
}

// Native contract: invoke('update', {op, args:{}}) returns the usual ok/data envelope.
// Unknown/native-unavailable phases deliberately expose no download/install action.
const phaseActions = {
  idle: ['check'], current: ['check'], 'up-to-date': ['check'], available: ['authorize'],
  'approval-pending': ['poll'], authorized: ['download'],
  downloading: ['status'], downloaded: ['install'], ready: ['install'],
  checking: ['status'], authorizing: ['status'], installing: [], cancelled: ['check'], error: ['check'],
  unavailable: ['status']
};
export function updatePresentation(data = {}) {
  const receivedPhase = typeof data.phase === 'string' ? data.phase.toLowerCase().replaceAll('_', '-') : 'unavailable';
  const phase = ['denied', 'expired'].includes(receivedPhase) ? 'error' : receivedPhase;
  const known = Object.hasOwn(phaseActions, phase);
  const total = Number(data.total_bytes), received = Number(data.progress_bytes);
  const determinate = Number.isFinite(total) && total > 0 && Number.isFinite(received) && received >= 0;
  return {
    ...data, phase: known ? phase : 'unavailable',
    actions: data.busy === true && known && phase !== 'installing' ? ['status'] : known ? phaseActions[phase] : ['status'],
    message: data.message || (known ? '' : 'Update status is not available from this build.'),
    progress: determinate ? Math.min(received, total) : null,
    total: determinate ? total : null,
    approvalUrl: typeof data.approval_url === 'string' && /^https:\/\//i.test(data.approval_url) ? data.approval_url : null
  };
}
