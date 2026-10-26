/* A City container for the existing Chat conversation. It owns presentation only:
 * history, live events, sending and owner checks remain in Chat and sessions.js. */
import { mount as mountChat } from '../views/chat.js';
import { sessions } from '../sessions.js';

/** Resolve only conversations the existing Chat view can actually display. */
export function sheetThread(target, store, client = sessions) {
  if (typeof target?.thread === 'string' && /^(sess|pair|mail|live):.+/.test(target.thread)) return target.thread;
  const sessionId = target?.sessionId;
  if (sessionId) {
    const session = client.session(sessionId);
    return session?.sharedId ? `pair:${session.sharedId}` : session ? `sess:${session.id}` : null;
  }
  const agent = target?.agent || store.agent(target?.agentId);
  if (!agent || agent.kind === 'external') return null;
  if (agent.sessionId) return sheetThread({ sessionId: agent.sessionId }, store, client);
  if (agent.kind === 'mailbox' && agent.address) return `mail:${agent.address}`;
  const endpointId = agent.endpointId;
  return endpointId ? store.threads().find(t => t.kind === 'live' && t.agentId === `endpoint:${endpointId}`)?.id || null : null;
}

export function mountChatSheet(host, ctx, { onChange = () => {}, mountConversation = mountChat, client = sessions } = {}) {
  const { h, icon, iconButton } = ctx.ui;
  let conversation = null, target = null, wanted = false, destroyed = false, returnFocus = null;
  const body = h('div.city-chat-content');
  const node = h('aside.city-chat-sheet', { hidden: true, 'aria-label': 'Project conversation' },
    h('header.city-chat-toolbar',
      h('strong', icon('chat'), 'Conversation'),
      h('button.btn.small.ghost', { type: 'button', onclick: () => {
        const thread = conversation?.threadId || target?.thread;
        if (!thread) return;
        const draft = conversation?.takeDraft?.();
        close(false);
        ctx.navigate('chat', { thread, ...(draft ? { draft } : {}) });
      } }, icon('external'), 'Open in Chat'),
      iconButton('close', 'Close chat pop-up', () => close(), 'city-chat-close')),
    body);
  // Keep typing, scrolling and Escape inside the sheet out of City's camera controls.
  node.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('dialog[open]')) { event.preventDefault(); close(); }
  });
  for (const name of ['keyup', 'pointerdown', 'pointerup', 'click', 'dblclick', 'wheel']) node.addEventListener(name, event => event.stopPropagation());
  host.append(node);

  function open(next) {
    if (destroyed) return false;
    const thread = sheetThread(next, ctx.store, client);
    if (!thread) { ctx.ui.toast('This agent has no conversation available in CodaClauda.'); return false; }
    if (node.hidden) returnFocus = document.activeElement;
    target = { thread };
    wanted = true;
    node.hidden = false;
    conversation ||= mountConversation(body, ctx, { embedded: true });
    conversation.show(target);
    onChange(true);
    return true;
  }
  function hide() {
    if (node.hidden) return;
    conversation?.hide();
    node.hidden = true;
    onChange(false);
  }
  function close(restoreFocus = true) {
    wanted = false;
    hide();
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  function show() { if (wanted && target) open(target); }
  function destroy() {
    if (destroyed) return;
    close(false);
    destroyed = true;
    conversation?.destroy();
    node.remove();
  }
  return { node, element: node, open, close, hide, show, destroy };
}
