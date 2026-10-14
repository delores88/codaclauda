/* Passive owner mailbox UI. No agent launch, automatic acknowledgment or polling. */
import { mailboxPayload, mailboxAttempt } from './view-model.js';

export function createMailbox({ rpc, renderMessageBody, localTime, toast }) {
  const $ = selector => document.querySelector(selector);
  const node = (tag, className, text) => { const value = document.createElement(tag); value.className = className; if (text != null) value.textContent = String(text); return value; };
  const control = (label, action) => { const value = node('button', 'button secondary small', label); value.type = 'button'; value.addEventListener('click', action); return value; };
  let addresses = [], claims = [], messages = [], selected = '', cursors = [0], page = 0, nextCursor = null, more = false;
  let generation = 0, reading = null, refreshing = false, claimsPage = 1, pending = null, posting = false;
  const form = $('#mailbox-post-form');
  const error = (selector, value) => { $(selector).textContent = value || ''; $(selector).hidden = !value; };
  const label = name => addresses.find(item => item.name === name)?.label || name;
  const addressText = name => label(name) === name ? name : `${label(name)} (${name})`;
  function renderDirectory() {
    const select = $('#mailbox-address');
    const signature = JSON.stringify(addresses);
    if (select.dataset.signature !== signature) {
      select.dataset.signature = signature; select.replaceChildren(); $('#mailbox-recipient-options').replaceChildren();
      for (const item of addresses) {
        const option = node('option', '', addressText(item.name)); option.value = item.name; select.append(option);
        const suggestion = node('option', '', item.label); suggestion.value = item.name; $('#mailbox-recipient-options').append(suggestion);
      }
    }
    if (!addresses.some(item => item.name === selected)) selected = addresses.find(item => item.name === 'owner')?.name || addresses[0]?.name || '';
    select.value = selected; select.disabled = !addresses.length;
    $('#mailbox-title').textContent = selected ? `${addressText(selected)} inbox` : 'Choose a mailbox';
  }
  function renderClaims() {
    const pages = Math.max(1, Math.ceil(claims.length / 3)); claimsPage = Math.min(pages, Math.max(1, claimsPage));
    const list = $('#mailbox-claims'); list.replaceChildren();
    for (const claim of claims.slice((claimsPage - 1) * 3, claimsPage * 3)) {
      const card = node('article', 'mailbox-claim');
      card.append(node('h3', '', claim.resource), node('p', '', claim.purpose || 'No purpose supplied'), node('p', 'field-hint', `Held by ${addressText(claim.holder)} · expires ${localTime(claim.expires_at)}`));
      list.append(card);
    }
    if (!claims.length) list.append(node('p', 'field-hint', 'No open resource claims in the last check.'));
    $('#mailbox-claims-page').textContent = `${claimsPage} / ${pages}`;
    $('#mailbox-claims-previous').disabled = claimsPage === 1; $('#mailbox-claims-next').disabled = claimsPage === pages;
  }
  function renderMessages() {
    const host = $('#mailbox-transcript'), selection = `${selected}:${page}:${$('#mailbox-unread').checked}`;
    const changed = host.dataset.selection !== selection, scroll = host.scrollTop;
    const anchor = [...host.children].find(item => item.offsetTop + item.offsetHeight > scroll);
    const anchorId = anchor?.dataset.id, anchorTop = anchor?.getBoundingClientRect().top;
    const existing = new Map([...host.children].map(item => [item.dataset.id, item]));
    const keep = new Set();
    messages.forEach((message, index) => {
      keep.add(message.id); const signature = JSON.stringify(message); let card = existing.get(message.id);
      if (!card || card.dataset.signature !== signature) {
        const fresh = node('article', 'conversation-message mailbox-message'); fresh.dataset.id = message.id; fresh.dataset.signature = signature;
        const heading = node('header', 'message-heading'); heading.append(node('strong', '', addressText(message.from)), node('span', 'message-route', `to ${addressText(message.to)} · ${message.kind}`), node('time', '', localTime(message.created_at)));
        const body = node('div', 'message-body'); renderMessageBody(body, message.body);
        const footer = node('div', 'mailbox-message-actions');
        footer.append(node('span', 'field-hint', message.read_at ? `Marked read ${localTime(message.read_at)}` : 'Unread'));
        if (!message.read_at) footer.append(control('Mark read', event => acknowledge(message, event.currentTarget)));
        if (message.to === 'owner') footer.append(control('Reply as owner', () => openComposer(message)));
        const details = node('details', 'message-details'); details.open = card?.querySelector('details')?.open || false;
        details.append(node('summary', '', 'Details'), node('pre', 'code-output', JSON.stringify(message, null, 2)));
        fresh.append(heading, node('h3', 'mailbox-subject', message.subject), body, footer, details);
        if (card) card.replaceWith(fresh); card = fresh;
      }
      if (host.children[index] !== card) host.insertBefore(card, host.children[index] || null);
    });
    for (const item of [...host.children]) if (!keep.has(item.dataset.id)) item.remove();
    if (!messages.length) {
      const empty = node('div', 'conversation-empty');
      empty.append(node('h3', '', selected ? 'No messages on this page' : 'No mailbox selected'), node('p', '', 'Check the inbox when you want an update. Reading does not mark a message read.'));
      host.replaceChildren(empty);
    }
    host.dataset.selection = selection;
    const nextAnchor = [...host.children].find(item => item.dataset.id === anchorId);
    host.scrollTop = changed ? 0 : scroll + (nextAnchor && anchorTop != null ? nextAnchor.getBoundingClientRect().top - anchorTop : 0);
    $('#mailbox-page').textContent = `Page ${page + 1} · ${messages.length} messages`;
    $('#mailbox-earlier').disabled = page === 0 || reading !== null; $('#mailbox-later').disabled = !more || reading !== null;
  }
  async function readInbox() {
    if (!selected) { messages = []; renderMessages(); return; }
    const token = ++generation, addr = selected, since = cursors[page], unread = $('#mailbox-unread').checked;
    reading = token; renderMessages();
    try {
      const data = await rpc('mailbox-inbox', { addr, since, unread, limit: 20 });
      if (generation !== token) return;
      if (!Array.isArray(data.messages) || data.messages.length > 20 || !Number.isSafeInteger(data.next_cursor) || data.next_cursor < since) throw new Error('The mailbox returned an invalid page.');
      messages = data.messages; nextCursor = data.next_cursor; more = data.has_more === true;
      error('#mailbox-error', ''); $('#mailbox-checked').textContent = `Checked ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · manual refresh`;
    } catch (failure) { if (generation === token) error('#mailbox-error', `Could not read this inbox: ${failure.message}. Previously shown messages may be stale.`); }
    finally { if (reading === token) reading = null; renderMessages(); }
  }
  async function refresh() {
    if (refreshing) return; refreshing = true; $('#mailbox-refresh').disabled = true;
    try {
      const results = await Promise.allSettled([rpc('mailbox-directory', {}), rpc('mailbox-claims', {})]);
      if (results[0].status === 'fulfilled' && Array.isArray(results[0].value.addresses)) { addresses = results[0].value.addresses; renderDirectory(); await readInbox(); }
      else error('#mailbox-error', `Mailbox directory unavailable: ${results[0].reason?.message || 'invalid response'}. No message was sent.`);
      if (results[1].status === 'fulfilled' && Array.isArray(results[1].value.claims)) { claims = results[1].value.claims; error('#mailbox-claims-error', ''); renderClaims(); }
      else error('#mailbox-claims-error', `Could not refresh claims: ${results[1].reason?.message || 'invalid response'}. Previously shown claims may be stale.`);
    } finally { refreshing = false; $('#mailbox-refresh').disabled = false; }
  }
  async function acknowledge(message, button) {
    if (button.disabled) return; button.disabled = true;
    try { await rpc('mailbox-ack', { addr: message.to, id: message.id }); if (selected === message.to) await readInbox(); }
    catch (failure) { error('#mailbox-error', `Read status was not confirmed: ${failure.message}`); }
    finally { button.disabled = false; }
  }
  function fields() { return Object.fromEntries(new FormData(form)); }
  function updateKind() {
    const kind = form.elements.kind.value;
    $('#mailbox-resource-field').hidden = !['claim', 'release'].includes(kind); form.elements.resource.required = ['claim', 'release'].includes(kind);
    $('#mailbox-ttl-field').hidden = kind !== 'claim'; form.elements.ttl.required = kind === 'claim';
    $('#mailbox-reply-field').hidden = kind !== 'reply'; form.elements.reply_to.required = kind === 'reply';
    $('#mailbox-kind-note').textContent = kind === 'claim' ? 'Claims are temporary coordination notices, not operating-system locks. Subject describes the purpose.' : kind === 'release' ? 'Release only a resource held by owner. This does not stop any running work.' : kind === 'reply' ? 'A reply must point to a message addressed to owner and return to its sender.' : 'This message is information. It does not grant an agent permission to run a command.';
  }
  function openComposer(reply) {
    if (!pending && !posting) {
      form.reset(); form.elements.to.value = reply ? reply.from : selected === 'owner' ? '' : selected;
      if (reply) { form.elements.kind.value = 'reply'; form.elements.subject.value = `Re: ${reply.subject}`; form.elements.reply_to.value = reply.id; }
      error('#mailbox-post-error', ''); $('#mailbox-new-id').hidden = true; updateKind();
    }
    $('#mailbox-post-dialog').showModal();
  }
  function resetPage() { generation++; reading = null; page = 0; cursors = [0]; nextCursor = null; more = false; messages = []; readInbox(); }
  $('#mailbox-address').addEventListener('change', () => { selected = $('#mailbox-address').value; renderDirectory(); resetPage(); });
  $('#mailbox-unread').addEventListener('change', resetPage);
  $('#mailbox-refresh').addEventListener('click', refresh); $('#mailbox-compose').addEventListener('click', () => openComposer());
  $('#mailbox-earlier').addEventListener('click', () => { if (page > 0 && reading === null) { page--; messages = []; readInbox(); } });
  $('#mailbox-later').addEventListener('click', () => { if (more && reading === null) { cursors[++page] = nextCursor; messages = []; readInbox(); } });
  for (const [direction, step] of [['previous', -1], ['next', 1]]) $('#mailbox-claims-' + direction).addEventListener('click', () => { claimsPage += step; renderClaims(); });
  form.elements.kind.addEventListener('change', updateKind);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (posting) return;
    const submit = $('#mailbox-post-submit'); posting = true; submit.disabled = true; error('#mailbox-post-error', '');
    try {
      const payload = mailboxPayload(fields()); pending = mailboxAttempt(pending, payload, crypto.randomUUID());
      const result = await rpc('mailbox-post', { ...payload, id: pending.id });
      if (result.id !== pending.id) throw new Error('The returned message ID did not match this post.');
      pending = null; form.reset(); $('#mailbox-new-id').hidden = true; $('#mailbox-post-dialog').close(); toast('Message saved. No agent was launched.');
      await refresh();
    } catch (failure) {
      error('#mailbox-post-error', `${failure.message}${pending ? ` Outcome unconfirmed for ${pending.id}. Inspect the recipient inbox. Retrying unchanged keeps this ID.` : ''}`);
      $('#mailbox-new-id').hidden = !pending;
    } finally { posting = false; submit.disabled = false; }
  });
  $('#mailbox-new-id').addEventListener('click', () => {
    if (!pending || posting) return;
    try {
      const payload = mailboxPayload(fields());
      if (JSON.stringify(payload) === pending.fingerprint) throw new Error('This draft is unchanged. Retry it with its existing ID to avoid a duplicate.');
      $('#mailbox-prior-id').textContent = pending.id; $('#mailbox-new-id-dialog').showModal();
    } catch (failure) { error('#mailbox-post-error', failure.message); }
  });
  $('#mailbox-confirm-new-id').addEventListener('click', () => { pending = null; $('#mailbox-new-id-dialog').close(); $('#mailbox-new-id').hidden = true; error('#mailbox-post-error', 'Changed draft prepared with a new ID on its next post. The earlier outcome remains unconfirmed.'); });
  renderDirectory(); renderClaims(); renderMessages(); updateKind();
  return { refresh, openComposer };
}
