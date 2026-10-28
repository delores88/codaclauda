/* One phone conversation on the owner's existing notification topic.
 * Topic and routing state stay in the native settings, never the UI store. */
import { desktop } from '../bridge.js';

export const PHONE_COPY = {
  title: 'Message your agents from your phone',
  intro: 'Use the same ntfy topic above to send messages and read replies. On by default once you save a topic URL; a switch you turn off stays off.',
  send: 'Open that topic in ntfy on your phone and publish a message, or open its URL in your phone browser and choose Publish. Reply to the last agent who messaged your phone. Start with @name to choose an agent instead; a board address works too.',
  trust: 'Messages arrive as Ben (phone), using the owner-phone reply address. Your existing project access and owner controls still apply. Anyone who knows the topic can read and send messages.',
  privacy: 'Keep the topic URL private and use a long random topic. Never send credentials or private transcripts. Recognized credentials are refused in both directions; the filter cannot detect every secret. Message bodies are not written to diagnostic logs, but delivered messages stay on the board and may enter the agent conversation.',
  availability: 'Keep CodaClauda open and this PC online. Wake on mail and the recipient\'s existing access still apply. ntfy keeps only a limited cache, so messages sent while this PC is offline may expire. Saving a setting or message does not prove an agent acted or a phone received it.',
  approvalsTitle: 'Approve from your phone',
  approvalsIntro: 'When an agent sends you an APPROVAL REQUEST, your phone gets it with a one-time code, says which chat it is for (provider, project and chat) and shows the two lines you can send: approve or deny, each followed by that request\'s code. Copy the whole line into the topic or your Shortcut; words after the code reach the agent too. Approve and Deny buttons appear where your phone supports them. Your answer goes into that same chat as your words: CodaClauda chats, and Codex chats set to Wake by mail in Running. For Claude Code desktop chats, use Remote Control in the Claude app.',
  approvalsNotSent: 'A reply that is not a whole approve or deny line with a valid code is not sent to any agent; your phone gets a note saying so.',
  approvalsTrust: 'Each code works once, expires after 24 hours and lives only in CodaClauda\'s memory; after a restart, open requests are sent again with new codes. Five wrong codes lock phone approvals until you unlock them here. Anyone who can read your topic could approve, so keep it private.',
};

/** Require a confirmed native response before enabling edits. */
export function phoneSettingsValue(value) {
  if (!value || typeof value.enabled !== 'boolean' || !Array.isArray(value.recipients)) throw new Error('Phone settings were not confirmed. Refresh to try again.');
  const seen = new Set();
  const recipients = value.recipients.filter(row => {
    if (!row || typeof row.address !== 'string' || !row.address || seen.has(row.address)) return false;
    seen.add(row.address); return true;
  }).map(row => ({ address: row.address, label: typeof row.label === 'string' ? row.label : '' }));
  return {
    enabled: value.enabled,
    topicUrl: typeof value.topicUrl === 'string' && value.topicUrl ? value.topicUrl : null,
    lastRecipient: typeof value.lastRecipient === 'string' && value.lastRecipient ? value.lastRecipient : null,
    recipients,
    lastError: typeof value.lastError === 'string' && value.lastError ? value.lastError : null,
    // Older builds have no phone approvals: null hides the section.
    approvals: value.approvals && typeof value.approvals.enabled === 'boolean'
      ? { enabled: value.approvals.enabled, locked: value.approvals.locked === true, waiting: Number.isInteger(value.approvals.waiting) && value.approvals.waiting > 0 ? value.approvals.waiting : 0 }
      : null,
  };
}

export function phoneApprovalsText(saved) {
  const a = saved?.approvals;
  if (!a) return '';
  if (!saved.topicUrl) return 'Save your ntfy topic URL above first.';
  if (!saved.enabled) return 'Turn on phone messages above to approve from your phone.';
  if (a.locked) return 'Locked after five wrong codes. Nothing can be approved from the phone until you unlock it.';
  if (!a.enabled) return 'Off: approval requests stay in CodaClauda > Approvals.';
  return a.waiting ? `On: ${a.waiting} request${a.waiting === 1 ? ' is' : 's are'} waiting for your answer on the phone.` : 'On: new approval requests go to your phone.';
}

export function phoneThreadText(saved) {
  if (!saved) return '';
  if (saved.lastRecipient) {
    const recipient = saved.recipients.find(row => row.address === saved.lastRecipient);
    const name = recipient?.label && recipient.label !== saved.lastRecipient ? `${recipient.label} (${saved.lastRecipient})` : saved.lastRecipient;
    return `Replies go to ${name}, the last agent who messaged your phone. Use @name or @board-address to choose another agent.`;
  }
  const choices = saved.recipients.slice(0, 3).map(row => row.label && row.label !== row.address ? `${row.label} (@${row.address})` : `@${row.address}`);
  return `Start with @name to choose an agent.${choices.length ? ` Available: ${choices.join('; ')}.` : ' Open an agent chat in CodaClauda to get started.'}`;
}

export function phoneSettings({ ui }) {
  const { h, icon } = ui;
  const state = { saved: null, busy: false, reload: false, error: '' };
  const supported = () => ['phoneSettingsGet', 'phoneSettingsSet'].every(name => typeof desktop[name] === 'function');
  const onInput = h('input', { type: 'checkbox', 'aria-label': PHONE_COPY.title, onchange: event => save(event.currentTarget.checked) });
  const status = h('p.field-hint.ntfy-status', { role: 'status', 'aria-live': 'polite' });
  const thread = h('p.field-hint.phone-thread', { 'aria-live': 'polite' });
  const failure = h('p.inline-error', { role: 'alert', hidden: true });
  const refresh = h('button.btn.small.ghost', { type: 'button', onclick: () => load() }, icon('refresh'), 'Refresh phone status');
  const approvalsInput = h('input', { type: 'checkbox', 'aria-label': PHONE_COPY.approvalsTitle, onchange: event => saveApprovals(event.currentTarget.checked) });
  const approvalsStatus = h('p.field-hint.phone-approvals-status', { 'aria-live': 'polite' });
  const unlock = h('button.btn.small', { type: 'button', hidden: true, onclick: () => unlockApprovals() }, icon('lock'), 'Unlock phone approvals');
  const approvals = h('div.phone-approvals', { hidden: true },
    h('div.setting-row', h('div.setting-text', h('h3.panel-title', PHONE_COPY.approvalsTitle), h('span.field-hint', PHONE_COPY.approvalsIntro)), h('label.switch', approvalsInput, h('span'))),
    approvalsStatus, unlock, h('p.field-hint', PHONE_COPY.approvalsNotSent), h('p.field-hint', PHONE_COPY.approvalsTrust));
  const node = h('div.phone-messages',
    h('div.setting-row', h('div.setting-text', h('h3.panel-title', PHONE_COPY.title), h('span.field-hint', PHONE_COPY.intro)), h('label.switch', onInput, h('span'))),
    status, failure, h('p.field-hint', PHONE_COPY.send), thread,
    h('p.field-hint', 'For a name with spaces, write @"Session title" followed by a space and your message. If a name matches more than one agent, use its board address.'),
    refresh,
    approvals,
    h('details.phone-details', h('summary', 'Privacy and delivery'), h('p.field-hint', PHONE_COPY.trust), h('p.field-hint', PHONE_COPY.privacy), h('p.field-hint', PHONE_COPY.availability)));

  function render() {
    const loaded = Boolean(state.saved);
    const unavailable = !supported();
    onInput.checked = state.saved?.enabled === true;
    onInput.disabled = unavailable || !loaded || state.busy || Boolean(state.error);
    refresh.disabled = unavailable || state.busy;
    const error = state.error || state.saved?.lastError || '';
    failure.hidden = !error;
    failure.textContent = error;
    thread.textContent = phoneThreadText(state.saved);
    const phoneApprovals = state.saved?.approvals;
    approvals.hidden = !phoneApprovals || !['phoneApprovalsSet', 'phoneApprovalsUnlock'].every(name => typeof desktop[name] === 'function');
    approvalsInput.checked = phoneApprovals?.enabled === true;
    approvalsInput.disabled = !phoneApprovals || state.busy || !state.saved?.topicUrl || !state.saved?.enabled;
    approvalsStatus.textContent = phoneApprovalsText(state.saved);
    unlock.hidden = !phoneApprovals?.locked; unlock.disabled = state.busy;
    status.textContent = unavailable ? 'Phone messages need CodaClauda 0.6.1 desktop.'
      : state.busy ? 'Reading or saving phone settings...'
        : !loaded ? 'Phone settings have not been read. Choose Refresh phone status to try again.'
          : !state.saved.topicUrl ? 'Save your ntfy topic URL above to get started. No phone traffic is sent or received without a saved URL.'
            : state.saved.enabled ? 'On: send and receive messages in the same ntfy topic while CodaClauda is open.'
              : 'Off: phone messages and agent replies are not forwarded. Turn notifications follow their own switches above.';
  }
  async function load() {
    if (!supported()) { render(); return; }
    if (state.busy) { state.reload = true; return; }
    state.busy = true; render();
    try { state.saved = phoneSettingsValue(await desktop.phoneSettingsGet()); state.error = ''; }
    catch (error) { state.error = error?.message || String(error); }
    finally { finish(); }
  }
  async function save(enabled) {
    if (!state.saved || state.busy || state.error) { render(); return; }
    state.busy = true; render();
    try {
      state.saved = phoneSettingsValue(await desktop.phoneSettingsSet({ enabled }));
      ui.toast(state.saved.enabled ? 'Phone messages are on when a topic URL is saved' : 'Phone messages are off', { kind: 'success', timeout: 2600 });
    } catch (error) {
      ui.toast(`Couldn't save phone message settings: ${error?.message || error}`, { kind: 'error', timeout: 8000 });
    } finally { finish(); }
  }
  async function saveApprovals(enabled) {
    if (!state.saved || state.busy) { render(); return; }
    state.busy = true; render();
    try {
      state.saved = phoneSettingsValue(await desktop.phoneApprovalsSet({ enabled }));
      ui.toast(state.saved.approvals?.enabled ? 'Approval requests go to your phone' : 'Phone approvals are off', { kind: 'success', timeout: 2600 });
    } catch (error) {
      ui.toast(`Couldn't save phone approvals: ${error?.message || error}`, { kind: 'error', timeout: 8000 });
    } finally { finish(); }
  }
  async function unlockApprovals() {
    if (state.busy) return;
    state.busy = true; render();
    try {
      state.saved = phoneSettingsValue(await desktop.phoneApprovalsUnlock());
      ui.toast('Phone approvals unlocked', { kind: 'success', timeout: 2600 });
    } catch (error) {
      ui.toast(`Couldn't unlock phone approvals: ${error?.message || error}`, { kind: 'error', timeout: 8000 });
    } finally { finish(); }
  }
  function finish() {
    state.busy = false; render();
    if (state.reload) { state.reload = false; load(); }
  }
  render();
  return { node, load };
}
