/* Owner-only phone messaging settings. Topic URLs stay in this card's memory;
 * the native commands persist them, never the UI store or localStorage. */
import { desktop } from '../bridge.js';
import { validNtfyUrl } from '../features.js';

export const PHONE_COPY = {
  title: 'Message your agents from your phone',
  intro: 'Send a message through ntfy and receive agent replies on the phone notification topic above. Free, with no SMS or phone number. Off until you set it up and turn it on.',
  trust: "Messages arrive as owner-phone, labeled as from Ben's phone and unverified. Anyone who knows the inbound topic can send messages. Mail is information, not owner approval; it cannot grant access or change a project's permissions.",
  privacy: 'Keep both topic URLs private. Anyone who knows a topic can read its messages. Never send credentials or private transcripts. Recognized credentials are refused in both directions; the filter cannot detect every secret. Message bodies are not written to diagnostic logs.',
  availability: 'Keep CodaClauda open and this PC online. Wake on mail and the recipient\'s existing access still apply. ntfy keeps only a limited cache, so messages sent while this PC is offline may expire before it reconnects.',
};

/** Require an actual native response before enabling edits. */
export function phoneSettingsValue(value) {
  if (!value || typeof value.enabled !== 'boolean' || !Array.isArray(value.recipients)) throw new Error('Phone settings were not confirmed. Refresh to try again.');
  const seen = new Set();
  const recipients = value.recipients.filter(row => {
    if (!row || typeof row.address !== 'string' || !row.address || seen.has(row.address)) return false;
    seen.add(row.address); return true;
  }).map(row => ({ address: row.address, label: typeof row.label === 'string' ? row.label : '' }));
  return {
    enabled: value.enabled,
    inboundUrl: typeof value.inboundUrl === 'string' && value.inboundUrl ? value.inboundUrl : null,
    defaultRecipient: typeof value.defaultRecipient === 'string' && value.defaultRecipient ? value.defaultRecipient : null,
    recipients,
    lastError: typeof value.lastError === 'string' && value.lastError ? value.lastError : null,
  };
}

export function phoneEnableProblem(saved, replyUrl) {
  if (!saved?.inboundUrl) return 'Choose Set up phone messages to create your private inbound topic.';
  const check = validNtfyUrl(replyUrl);
  if (!check.ok || !check.url) return 'Save a phone notification topic above for replies before turning this on.';
  if (check.url.replace(/\/+$/, '') === saved.inboundUrl.replace(/\/+$/, '')) return 'Use a different phone notification topic for replies, so replies cannot become new inbound messages.';
  return '';
}

export function phoneSettings({ ui }) {
  const { h, icon } = ui;
  const state = { saved: null, replyUrl: null, busy: false, error: '' };
  const supported = () => ['phoneSettingsGet', 'phoneSettingsSet', 'phoneSettingsRegenerate'].every(name => typeof desktop[name] === 'function');
  const onInput = h('input', { type: 'checkbox', 'aria-label': PHONE_COPY.title, onchange: event => save({ enabled: event.currentTarget.checked }) });
  const status = h('p.field-hint.ntfy-status', { role: 'status', 'aria-live': 'polite' });
  const failure = h('p.inline-error', { role: 'alert', hidden: true });
  const setup = h('button.btn.small.primary', { type: 'button', onclick: () => regenerate() }, icon('plus'), 'Set up phone messages');
  const inbound = h('input.input', { type: 'text', readOnly: true, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Private inbound topic URL' });
  const copy = h('button.btn.small', { type: 'button', onclick: () => { if (state.saved?.inboundUrl) ui.copyText(state.saved.inboundUrl, 'Inbound URL copied'); } }, icon('copy'), 'Copy');
  const rotate = h('button.btn.small', { type: 'button', onclick: () => regenerate() }, icon('refresh'), 'Regenerate');
  const topicRow = h('div.ntfy-row', inbound, copy, rotate);
  const topicHint = h('p.field-hint', 'Regenerate replaces the inbound URL. Messages to the old URL will no longer reach CodaClauda; update your phone subscription.');
  const recipient = h('select.input', { 'aria-label': 'Default phone message recipient', onchange: event => save({ defaultRecipient: event.currentTarget.value || null }) });
  const recipientRow = h('label.field', h('span.field-label', 'Default recipient'), recipient,
    h('span.field-hint', 'Used when your message has no @address. Automatic chooses the most recently active CodaClauda session. The address identifies the destination; labels are self-asserted.'));
  const steps = h('ol.phone-steps',
    h('li', 'Install the ntfy app on your phone. Subscribe to the notification topic saved above to receive replies.'),
    h('li', 'Choose Set up phone messages, copy the inbound URL below, and subscribe to that topic too (server ntfy.sh, topic is the part after the final /).'),
    h('li', 'Choose a default recipient and turn on Message your agents from your phone.'),
    h('li', 'Open the inbound topic in ntfy and publish a message. You can also open its URL in your phone browser and choose Publish. Send plain text to the default recipient, or start with @board-address followed by a space and your message.'),
    h('li', 'Read replies on the notification topic. Replies show the sender and the first 1,000 characters.'));
  const refresh = h('button.btn.small.ghost', { type: 'button', onclick: () => load() }, icon('refresh'), 'Refresh phone status');
  const node = h('div.phone-messages',
    h('div.setting-row', h('div.setting-text', h('h3.panel-title', PHONE_COPY.title), h('span.field-hint', PHONE_COPY.intro)), h('label.switch', onInput, h('span'))),
    status, failure, steps, setup, topicRow, topicHint, recipientRow, refresh,
    h('p.field-hint', PHONE_COPY.trust), h('p.field-hint', PHONE_COPY.privacy), h('p.field-hint', PHONE_COPY.availability));

  function fill(value) {
    state.saved = phoneSettingsValue(value);
    const saved = state.saved;
    onInput.checked = saved.enabled;
    inbound.value = saved.inboundUrl || '';
    const options = [h('option', { value: '' }, 'Automatic: most recently active CodaClauda session'),
      ...saved.recipients.map(row => h('option', { value: row.address }, row.label && row.label !== row.address ? `${row.label} (${row.address})` : row.address))];
    if (saved.defaultRecipient && !saved.recipients.some(row => row.address === saved.defaultRecipient)) {
      options.push(h('option', { value: saved.defaultRecipient }, `${saved.defaultRecipient} (unavailable; choose another recipient)`));
    }
    recipient.replaceChildren(...options);
    recipient.value = saved.defaultRecipient || '';
  }
  function render() {
    const loaded = Boolean(state.saved);
    const unavailable = !supported();
    const blocked = unavailable || !loaded || state.busy || Boolean(state.error);
    const problem = phoneEnableProblem(state.saved, state.replyUrl);
    onInput.checked = state.saved?.enabled === true;
    onInput.disabled = blocked || (!state.saved?.enabled && Boolean(problem));
    setup.hidden = Boolean(state.saved?.inboundUrl);
    setup.disabled = blocked;
    topicRow.hidden = !state.saved?.inboundUrl;
    topicHint.hidden = topicRow.hidden;
    for (const input of [inbound, copy, rotate, recipient]) input.disabled = blocked;
    refresh.disabled = unavailable || state.busy;
    const error = state.error || state.saved?.lastError || '';
    failure.hidden = !error;
    failure.textContent = error;
    status.textContent = unavailable ? 'Phone messages need CodaClauda 0.6.1 desktop.'
      : state.busy ? 'Reading or saving phone settings...'
        : !loaded ? 'Phone settings have not been read. Choose Refresh phone status to try again.'
          : problem ? `${state.saved.enabled ? 'Waiting' : 'Off'}: ${problem}`
            : state.saved.enabled ? 'On: CodaClauda checks the inbound topic while it is open. A saved board message is not proof an agent has acted.'
              : 'Off: phone messages are not being forwarded. Your setup is saved.';
  }
  async function load() {
    if (!supported() || state.busy) { render(); return; }
    state.busy = true; render();
    try { fill(await desktop.phoneSettingsGet()); state.error = ''; }
    catch (error) { state.error = error?.message || String(error); }
    finally { state.busy = false; render(); }
  }
  async function save(patch) {
    if (!state.saved || state.busy || state.error) { render(); return; }
    if (patch.enabled === true && phoneEnableProblem(state.saved, state.replyUrl)) { render(); return; }
    state.busy = true; render();
    try {
      fill(await desktop.phoneSettingsSet({ enabled: state.saved.enabled, defaultRecipient: state.saved.defaultRecipient, ...patch }));
      ui.toast('Phone message settings saved', { kind: 'success', timeout: 2600 });
    } catch (error) {
      ui.toast(`Couldn't save phone message settings: ${error?.message || error}`, { kind: 'error', timeout: 8000 });
      fill(state.saved);
    } finally { state.busy = false; render(); }
  }
  async function regenerate() {
    if (!state.saved || state.busy || state.error) return;
    state.busy = true; render();
    try {
      fill(await desktop.phoneSettingsRegenerate());
      ui.toast('New inbound URL saved. Subscribe to it on your phone.', { kind: 'success', timeout: 4000 });
    } catch (error) { ui.toast(`Couldn't create the inbound topic: ${error?.message || error}`, { kind: 'error', timeout: 8000 }); }
    finally { state.busy = false; render(); }
  }
  render();
  return { node, load, setReplySettings(value) { state.replyUrl = typeof value?.ntfyUrl === 'string' ? value.ntfyUrl : null; render(); } };
}
