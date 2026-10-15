/* Owner approvals. An approval created in the CodaClauda Approvals view is Ben's own
 * authorization: it is saved in desktop state (store.desktop.approvals) and sent to
 * each named agent as ONE owner notice whose body starts with a strict, machine-readable
 * CODACLAUDA-APPROVAL v1 block. Agents record each use by replying "USED <id>: ...";
 * an owner "REVOKED <id>" notice cancels it.
 *
 * Record: { id, createdAt, expiresAt (ms), agents: [address], project: name|'', scope,
 *           actions: [ACTION ids], maxUses: number|null, revokedAt: ms|null,
 *           requestId?: mailbox id, messageIds: { [address]: mailbox id }, undelivered: [address] }
 * Pure helpers (no DOM, no imports) so they can be tested in node. */

export const OWNER = 'owner';
export const ACTIONS = [
  { id: 'build', label: 'Build & test' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'release', label: 'Publish a release' },
  { id: 'marketplace-retry', label: 'Marketplace retry/submission' },
  { id: 'spend', label: 'Spend money', warn: true },
];
export const ACTION_IDS = ACTIONS.map(a => a.id);
export const actionLabel = id => ACTIONS.find(a => a.id === id)?.label || id;
export const EXPIRY = [
  { id: '1h', label: '1 hour', ms: 3600e3 },
  { id: '4h', label: '4 hours', ms: 4 * 3600e3 },
  { id: '24h', label: '24 hours', ms: 24 * 3600e3 },
  { id: '3d', label: '3 days', ms: 3 * 86400e3 },
  { id: '7d', label: '7 days', ms: 7 * 86400e3 },
  { id: 'never', label: 'Until revoked', ms: null },
];
/** Actions a standing approval covers by default (spending money is never pre-selected). */
export const STANDING_ACTIONS = ['build', 'deploy', 'release', 'marketplace-retry'];
export const STANDING_SCOPE = "Standing approval: routine work Ben has asked for, or that his agents have coordinated on the CodaClauda board, on Ben's own projects: building and testing, deploying, publishing releases, and Marketplace submissions/retries. Not covered: spending money, changing shared resource limits, deleting data, accounts or credentials.";
const NOT_ALLOWED = "spending money unless 'spend' is listed; changing shared resource limits; anything outside the scope text";
const REQUEST_RE = /^\s*approval request/i;

const toMs = value => {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) { const n = Number(value); return n < 1e12 ? n * 1000 : n; }
  return new Date(value).getTime();
};
const isoUtc = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const oneLine = text => String(text || '').replace(/\s+/g, ' ').trim();
const escapeRe = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const shortScope = (scope, limit = 80) => { const s = oneLine(scope); return s.length > limit ? `${s.slice(0, limit - 1)}…` : s; };

/* ---------------- pure model ---------------- */
export function listApprovals(store) { return Array.isArray(store.desktop?.approvals) ? store.desktop.approvals : []; }

/** Uses = messages whose subject starts with "USED <id>" that reply to one of the approval's messages
 *  or come from one of its agents. Deduplicated by message id, oldest first. */
export function usesFor(approval, messages) {
  const ids = new Set(Object.values(approval.messageIds || {}));
  const agents = new Set(approval.agents || []);
  const re = new RegExp(`^\\s*USED\\s+${escapeRe(approval.id)}\\b`, 'i');
  const seen = new Set();
  return (messages || []).filter(m => {
    if (!m || seen.has(m.id) || m.from === OWNER || !re.test(m.subject || '')) return false;
    if (!(ids.has(m.reply_to) || agents.has(m.from))) return false;
    seen.add(m.id); return true;
  });
}

/** 'revoked' | 'expired' | 'used-up' | 'active' */
export function approvalStatus(approval, useCount = 0, now = Date.now()) {
  if (approval.revokedAt) return 'revoked';
  if (approval.expiresAt != null && !(Number(approval.expiresAt) > now)) return 'expired';
  if (approval.maxUses != null && useCount >= approval.maxUses) return 'used-up';
  return 'active';
}

/** Approvals with their uses and status, newest first. */
export function approvalsWithStatus(store, now = Date.now()) {
  const messages = store.mailboxMessages || [];
  return listApprovals(store).map(a => { const uses = usesFor(a, messages); return { ...a, uses, status: approvalStatus(a, uses.length, now) }; })
    .sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
}

/** Messages to the owner whose subject starts with APPROVAL REQUEST and that have no owner reply
 *  (and no approval created from them) yet. Oldest first. */
export function pendingRequests(messages, approvals = []) {
  const answered = new Set((messages || []).filter(m => m.from === OWNER && m.reply_to).map(m => m.reply_to));
  for (const a of approvals) if (a.requestId) answered.add(a.requestId);
  return (messages || []).filter(m => m.to === OWNER && m.from !== OWNER && REQUEST_RE.test(m.subject || '') && !answered.has(m.id));
}
export const requestTitle = subject => String(subject || '').replace(/^\s*approval request\s*[:\-–—]?\s*/i, '').trim() || '(no description)';

export function approvalBlock(a) {
  return [
    'CODACLAUDA-APPROVAL v1',
    `id: ${a.id}`,
    'granted_by: owner (created in the CodaClauda Approvals view)',
    `agents: ${a.agents.join(', ')}`,
    `project: ${oneLine(a.project) || 'any'}`,
    `allowed_actions: ${a.actions.join(', ')}`,
    `not_allowed: ${NOT_ALLOWED}`,
    `max_uses: ${a.maxUses == null ? 'unlimited' : a.maxUses}`,
    `expires_at: ${a.expiresAt == null ? 'never (valid until revoked)' : isoUtc(a.expiresAt)}`,
    `scope: ${oneLine(a.scope)}`,
  ].join('\n');
}
export function approvalBody(a) {
  return `${approvalBlock(a)}\n\nTo use: reply on this message with kind reply, subject "USED ${a.id}: <what you did>". Revocation: an owner message "REVOKED ${a.id}" cancels it.\n\nBen created this approval himself in the CodaClauda Approvals view. It covers only the scope, actions, use limit and expiry above.`;
}

/** Validates form fields and returns a new (unsaved) approval record. Throws Error with a readable message. */
export function buildApproval(fields, now = Date.now()) {
  const agents = [...new Set((fields.agents || []).map(String).filter(a => a && a !== OWNER))];
  const actions = ACTION_IDS.filter(id => (fields.actions || []).includes(id));
  const scope = String(fields.scope || '').trim();
  const expiry = EXPIRY.find(e => e.id === fields.expires) || null;
  const forever = expiry?.id === 'never';
  const ttl = forever ? Infinity : Number(fields.ttlMs) || expiry?.ms || 0;
  const rawMax = fields.maxUses;
  const maxUses = rawMax == null || rawMax === '' ? null : Number(rawMax);
  if (!agents.length) throw new Error('Choose at least one agent.');
  if (!actions.length) throw new Error('Choose at least one action.');
  if (!scope) throw new Error("Describe exactly what's approved.");
  if (!(ttl > 0)) throw new Error('Choose when the approval expires.');
  if (maxUses != null && !(Number.isInteger(maxUses) && maxUses >= 1)) throw new Error('Limit uses must be a whole number of at least 1, or empty for no limit.');
  return {
    id: `appr-${crypto.randomUUID()}`, createdAt: now, expiresAt: forever ? null : now + ttl,
    agents, project: String(fields.project || ''), scope: scope.slice(0, 4000), actions, maxUses,
    revokedAt: null, ...(fields.requestId ? { requestId: fields.requestId } : {}), messageIds: {}, undelivered: [],
  };
}

/* ---------------- actions (owner posts through store.post) ---------------- */
function saveApproval(store, record) {
  store.updateDesktop(d => {
    d.approvals = Array.isArray(d.approvals) ? d.approvals : [];
    const i = d.approvals.findIndex(a => a.id === record.id);
    if (i >= 0) d.approvals[i] = { ...d.approvals[i], ...record }; else d.approvals.push(record);
  });
}

/** Creates the approval and posts one owner notice per agent. Returns { approval, failed: [address] }.
 *  Throws (and saves nothing) only if no agent could be sent the notice. */
export async function createApproval(store, fields) {
  const approval = buildApproval(fields);
  const body = approvalBody(approval);
  const subject = `APPROVAL ${approval.id}: ${shortScope(approval.scope)}`;
  const results = await Promise.allSettled(approval.agents.map(to => store.post({ to, kind: 'notice', subject, body })));
  const failed = [];
  results.forEach((r, i) => { if (r.status === 'fulfilled' && r.value?.id) approval.messageIds[approval.agents[i]] = r.value.id; else failed.push(approval.agents[i]); });
  if (failed.length === approval.agents.length) {
    const reason = results.find(r => r.status === 'rejected')?.reason;
    throw new Error(`Could not send the approval: ${reason?.message || reason || 'mailbox unavailable'}`);
  }
  approval.undelivered = failed;
  saveApproval(store, approval);
  return { approval, failed };
}

/** Marks the approval revoked (immediately, locally) and sends "REVOKED <id>" to its agents. Returns { failed }. */
export async function revokeApproval(store, id) {
  const approval = listApprovals(store).find(a => a.id === id);
  if (!approval) throw new Error('Approval not found.');
  const revokedAt = approval.revokedAt || Date.now();
  saveApproval(store, { id, revokedAt });
  const body = `CODACLAUDA-APPROVAL-REVOKED v1\nid: ${id}\nrevoked_by: owner (CodaClauda Approvals view)\nrevoked_at: ${isoUtc(revokedAt)}\n\nREVOKED ${id}. Ben cancelled this approval. Do not start anything new under it; if you are mid-step, stop at a safe point and tell Ben where you left off.`;
  const results = await Promise.allSettled(approval.agents.map(to => store.post({ to, kind: 'notice', subject: `REVOKED ${id}`, body })));
  const failed = approval.agents.filter((_, i) => results[i].status !== 'fulfilled');
  return { failed };
}

/** Approves an agent's APPROVAL REQUEST: creates the approval (agents default to the sender only when
 *  the caller passes none at all; an explicitly empty list fails validation) and replies to it. */
export async function approveRequest(store, msg, fields) {
  const agents = Array.isArray(fields.agents) ? fields.agents : [msg.from];
  const { approval, failed } = await createApproval(store, { ...fields, agents, requestId: msg.id });
  let replyFailed = false;
  try {
    const reply = await store.post({ to: msg.from, kind: 'reply', replyTo: msg.id, subject: `Approved: ${approval.id}`, body: approvalBody(approval) });
    if (reply?.id) saveApproval(store, { id: approval.id, messageIds: { ...approval.messageIds, [`reply:${msg.from}`]: reply.id } });
  } catch { replyFailed = true; }
  return { approval, failed, replyFailed };
}

/** Denies a request with an optional reason (an owner reply on the request). */
export async function denyRequest(store, msg, reason = '') {
  const why = String(reason || '').trim();
  const body = `Ben denied this approval request.${why ? `\n\nReason: ${why}` : ''}\n\nDo not go ahead with the requested action. If you think it is still needed, send a new APPROVAL REQUEST with more detail.`;
  return store.post({ to: msg.from, kind: 'reply', replyTo: msg.id, subject: 'Denied', body });
}
