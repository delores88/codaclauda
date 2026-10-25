import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../app/views/chat.js';

test('Chat distinguishes agents it runs across projects from existing desktop chats', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => ({ matches: false }) });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'matchMedia', previous);
    else delete globalThis.matchMedia;
  });
  const sidebarReady = new Error('Sidebar captured');
  let sidebar;
  const h = (tag, props, ...children) => {
    if (!props || typeof props !== 'object' || props.tag || Array.isArray(props)) { children.unshift(props); props = {}; }
    const node = { tag, props, children: children.flat().filter(child => child != null) };
    if (tag === 'aside.chat-side') { sidebar = node; throw sidebarReady; }
    return node;
  };
  // Exercise the actual sidebar construction; stop before mounting the unrelated
  // transcript/composer, which needs a WebView and session subscriptions.
  assert.throws(() => mount({}, {
    store: { prefs: {} },
    ui: { h, registerIcons() {}, icon: () => null,
      iconButton: (icon, label, onclick) => h('button', { title: label, onclick }) },
  }), error => error === sidebarReady);
  const nodes = node => typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : [];
  const text = node => typeof node === 'object' ? node.children.map(text).join(' ') : String(node);
  const sections = nodes(sidebar).filter(node => node.tag === 'section.side-section');
  const managed = sections.find(section => text(section).includes('Agents CodaClauda runs'));
  const desktop = sections.find(section => text(section).includes('Desktop chats'));
  assert.ok(managed && desktop && managed !== desktop);
  assert.match(text(managed), /across your projects/);
  assert.match(text(managed), /replies stream here/);
  assert.ok(nodes(managed).some(node => node.props.title === 'Start a session'));
  assert.match(text(desktop), /replies when it checks in/);
  assert.doesNotMatch(text(sidebar), /CodaClauda sessions/);
});
