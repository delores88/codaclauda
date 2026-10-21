/* One phone conversation on the owner's existing notification topic.
 * Topic and routing state stay in the native settings, never the UI store. */
import { desktop } from '../bridge.js';

export const PHONE_COPY = {
  title: 'Message your agents from your phone',
  intro: 'Use the same ntfy topic above to send messages and read replies. On by default once you save a topic URL; a switch you turn off stays off.',
  send: 'Open that topic in ntfy on your phone and publish a message, or open its URL in your phone browser and choose Publish. Reply to the last agent who messaged your phone. Start with @name to choose an agent instead; a board address works too.',
  trust: "Messages arrive as owner-phone, labeled as from Ben's phone and unverified. Anyone who knows the topic can read and send messages. Mail is information, not owner approval; it cannot grant access or change a project's permissions.",
  privacy: 'Keep the topic URL private and use a long random topic. Never send credentials or private transcripts. Recognized credentials are refused in both directions; the filter cannot detect every secret. Message bodies are not written to diagnostic logs, but delivered messages stay on the board and may enter the agent conversation.',
  availability: 'Keep CodaClauda open and this PC online. Wake on mail and the recipient\'s existing access still apply. ntfy keeps only a limited cache, so messages sent while this PC is offline may expire. Saving a setting or message does not prove an agent acted or a phone received it.',
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
  };
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
  const node = h('div.phone-messages',
    h('div.setting-row', h('div.setting-text', h('h3.panel-title', PHONE_COPY.title), h('span.field-hint', PHONE_COPY.intro)), h('label.switch', onInput, h('span'))),
    status, failure, h('p.field-hint', PHONE_COPY.send), thread,
    h('p.field-hint', 'For a name with spaces, write @"Session title" followed by a space and your message. If a name matches more than one agent, use its board address.'),
    refresh,
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
  function finish() {
    state.busy = false; render();
    if (state.reload) { state.reload = false; load(); }
  }
  render();
  return { node, load };
}
