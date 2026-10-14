/* Shared DOM helpers for the CodaClauda desktop UI. No dependencies.
 * CSP note: never set inline style attributes in markup or via setAttribute('style');
 * use element.style.prop = value (CSSOM), classes, or CSS custom properties. */
import { normalizeAvatar, PROVIDER_COLORS } from './avatar/spec.js';

/** Hyperscript: h('button.primary#send', {onclick, title}, 'Send', childNode) */
export function h(tag, props, ...children) {
  const [, name = 'div', rest = ''] = /^([a-z0-9-]+)?(.*)$/i.exec(tag);
  const node = document.createElement(name);
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') node.classList.add(part.slice(1)); else node.id = part.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { children.unshift(props); props = null; }
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class' || key === 'className') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') for (const [k, v] of Object.entries(value)) k.startsWith('--') ? node.style.setProperty(k, v) : (node.style[k] = v);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  append(node, children);
  return node;
}
function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export function clear(node, ...children) { node.replaceChildren(); append(node, children); return node; }

/* ---------- Icons (24px stroke icons, original paths) ---------- */
const ICONS = {
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.7A8 8 0 1 1 21 12Z"/>',
  board: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h10M7 13h6M7 17h8"/>',
  tasks: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
  city: '<path d="M3 21V10l5-3v14M8 21V4l7 3v14M15 21V11l6 2v8M2 21h20"/><path d="M11 10h1M11 13h1M11 16h1M18 15h1M18 18h1"/>',
  projects: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M8 13h8"/>',
  agents: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17.5" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 0 1 6 5.3"/>',
  avatar: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  send: '<path d="m4 12 16-8-6 16-2.5-6.5Z"/><path d="m11.5 13.5 4-4"/>',
  paperclip: '<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 3v5h5M4 13a8 8 0 0 0 14.3 4.9L20 16m0 5v-5h-5"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  github: '<path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5Z"/>',
  power: '<path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
  kanban: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8Z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v4"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.2"/><circle cx="16" cy="16" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="16" cy="8" r="1.2"/><circle cx="8" cy="16" r="1.2"/>',
  pin: '<path d="M12 22s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z"/><circle cx="12" cy="10" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17h.01"/>',
  play: '<path d="m7 4 13 8-13 8Z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6M11 8v6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6"/>',
  home: '<path d="m3 11 9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z"/>',
  link: '<path d="M10 14a4 4 0 0 0 6 .5l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-6-.5l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/>',
};
/** Feature modules may add icons: registerIcons({ name: '<path .../>' }). */
export function registerIcons(map) { Object.assign(ICONS, map); }
export function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon ${className}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || ICONS.sparkle;
  return svg;
}
/** Icon-only button with an accessible label and tooltip. */
export function iconButton(name, label, onclick, className = '') {
  return h(`button.icon-btn${className ? '.' + className.split(' ').join('.') : ''}`, { type: 'button', title: label, 'aria-label': label, onclick }, icon(name));
}

/* ---------- Time ---------- */
export function toMs(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) { const n = Number(value); return n < 1e12 ? n * 1000 : n; }
  return new Date(value).getTime();
}
export function timeAgo(value) {
  const ms = toMs(value); if (!Number.isFinite(ms)) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
export function clockTime(value) {
  const ms = toMs(value); if (!Number.isFinite(ms)) return '';
  const date = new Date(ms), today = new Date();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toDateString() === today.toDateString() ? time : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}
export function fullTime(value) { const ms = toMs(value); return Number.isFinite(ms) ? new Date(ms).toLocaleString() : ''; }

/* ---------- Feedback ---------- */
let toastHost;
/** toast('Saved', { kind: 'success'|'error'|'info', action: { label, run }, timeout }) */
export function toast(message, options = {}) {
  toastHost ||= document.getElementById('toasts') || document.body.appendChild(h('div#toasts.toasts'));
  const node = h(`div.toast.${options.kind || 'info'}`, { role: 'status' }, h('span.toast-text', message));
  if (options.action) node.append(h('button.toast-action', { type: 'button', onclick: () => { options.action.run(); node.remove(); } }, options.action.label));
  node.append(iconButton('close', 'Dismiss', () => node.remove(), 'toast-close'));
  toastHost.append(node);
  setTimeout(() => { node.classList.add('leaving'); setTimeout(() => node.remove(), 300); }, options.timeout || 5200);
  return node;
}
export async function copyText(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(String(text)); toast(label, { kind: 'success', timeout: 1800 }); return true; }
  catch { toast('Clipboard unavailable', { kind: 'error' }); return false; }
}
/** modal({ title, body: Node|string, actions: [{label, kind:'primary'|'danger'|'ghost', run: () => bool|Promise}], wide }) → closes on action unless run returns false. */
export function modal({ title, body, actions = [{ label: 'Close' }], wide = false, onClose }) {
  const dialog = h(`dialog.modal${wide ? '.wide' : ''}`);
  const footer = h('footer.modal-actions');
  for (const action of actions) {
    footer.append(h(`button.btn.${action.kind || 'ghost'}`, { type: 'button', onclick: async event => {
      const control = event.currentTarget; control.disabled = true;
      try { if ((await action.run?.()) !== false) dialog.close(); } finally { control.disabled = false; }
    } }, action.label));
  }
  dialog.append(h('header.modal-head', h('h2', title), iconButton('close', 'Close', () => dialog.close())), h('div.modal-body', typeof body === 'string' ? h('p', body) : body), footer);
  dialog.addEventListener('close', () => { onClose?.(); dialog.remove(); });
  document.body.append(dialog); dialog.showModal();
  return dialog;
}
export function emptyState(iconName, title, text, ...actions) {
  return h('div.empty', h('div.empty-art', icon(iconName)), h('h3', title), text ? h('p', text) : null, actions.length ? h('div.empty-actions', actions) : null);
}
export function pill(text, kind = 'neutral') { return h(`span.pill.${kind}`, text); }

export const STATUS_LABEL = { active: 'Working', idle: 'Awake', offline: 'Powered down' };
export function statusDot(status) { return h(`span.status-dot.${status || 'offline'}`, { title: STATUS_LABEL[status] || status }); }

/* ---------- 2D portrait from an avatar spec (SVG) ---------- */
const SVG = 'http://www.w3.org/2000/svg';
function s(tag, attrs) { const n = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; }
/** portrait(spec, { size, provider, status }) → <span.portrait> containing an SVG head-and-shoulders chip. */
export function portrait(specInput, { size = 36, provider, status, title } = {}) {
  const spec = normalizeAvatar(specInput);
  const ring = PROVIDER_COLORS[provider]?.main || 'var(--accent)';
  const svg = s('svg', { viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': 'true' });
  svg.append(s('circle', { cx: 32, cy: 32, r: 31, fill: 'var(--portrait-bg)' }));
  svg.append(s('path', { d: 'M10 64c2-13 11-19 22-19s20 6 22 19Z', fill: spec.top.color }));
  if (spec.top.emblem !== 'none') svg.append(s('circle', { cx: 32, cy: 56, r: 3, fill: spec.top.accent }));
  svg.append(s('rect', { x: 27, y: 38, width: 10, height: 9, rx: 3, fill: spec.skin }));
  svg.append(s('ellipse', { cx: 32, cy: 27, rx: 15, ry: 16, fill: spec.skin }));
  const hair = spec.hair.color, st = spec.hair.style;
  const hairPaths = {
    short: 'M17 26c0-10 7-15 15-15s15 5 15 15c-3-4-8-7-15-7s-12 3-15 7Z',
    messy: 'M16 27c-1-11 7-17 16-17 10 0 17 6 16 17l-3-6-3 3-3-5-4 3-3-4-4 4-3-3-4 4Z',
    buzz: 'M18 24c1-8 7-12 14-12s13 4 14 12c-4-3-9-4-14-4s-10 1-14 4Z',
    curly: 'M15 28c-3-12 6-19 17-19s20 7 17 19c-2-3-3-6-6-6-1-3-5-4-7-2-3-2-7-1-8 2-3 0-5 3-7 6Z',
    long: 'M15 44c-2-8-2-14-1-20 1-9 8-14 18-14s17 5 18 14c1 6 1 12-1 20l-4-1V24c-4-3-8-4-13-4s-9 1-13 4v19Z',
    ponytail: 'M17 26c0-10 7-15 15-15s15 5 15 15c-3-4-8-7-15-7s-12 3-15 7ZM46 20c6 2 8 9 5 16-1-5-3-8-6-10Z',
    bun: 'M17 26c0-10 7-15 15-15s15 5 15 15c-3-4-8-7-15-7s-12 3-15 7ZM26 9a6 6 0 1 1 12 0 6 6 0 0 1-12 0Z',
    mohawk: 'M28 20c0-6 2-12 4-14 2 2 4 8 4 14-3-1-5-1-8 0Z',
    bald: '',
  };
  if (hairPaths[st]) svg.append(s('path', { d: hairPaths[st], fill: hair }));
  const eyeY = 28;
  for (const x of [26, 38]) {
    if (spec.eyes.style === 'happy') svg.append(s('path', { d: `M${x - 2.5} ${eyeY + 1}q2.5-3 5 0`, stroke: '#2a1d18', 'stroke-width': 1.8, fill: 'none', 'stroke-linecap': 'round' }));
    else svg.append(s('ellipse', { cx: x, cy: eyeY, rx: 2.2, ry: spec.eyes.style === 'sleepy' ? 1.1 : 2.6, fill: '#231915' }));
  }
  if (spec.blush > 0.05) for (const x of [22, 42]) { const c = s('ellipse', { cx: x, cy: 33, rx: 3, ry: 1.8, fill: '#ff7b7b' }); c.setAttribute('opacity', String(0.12 + spec.blush * 0.35)); svg.append(c); }
  const fh = spec.facialHair.style;
  if (fh === 'stubble' || fh === 'mustache-stubble' || fh === 'beard') { const b = s('path', { d: 'M19 31c1 9 6 13 13 13s12-4 13-13c-2 4-6 7-13 7s-11-3-13-7Z', fill: spec.facialHair.color }); b.setAttribute('opacity', fh === 'beard' ? '1' : '0.28'); svg.append(b); }
  if (fh === 'goatee') svg.append(s('path', { d: 'M29 39h6l-1 4h-4Z', fill: spec.facialHair.color }));
  const mouthY = 36;
  svg.append(s('path', { d: spec.mouth === 'neutral' ? `M28 ${mouthY + 1}h8` : spec.mouth === 'grin' ? `M26 ${mouthY - 1}q6 7 12 0Z` : `M27 ${mouthY - 0.5}q5 5 10 0`, stroke: '#7a2e2e', 'stroke-width': 1.8, fill: spec.mouth === 'grin' ? '#fff' : 'none', 'stroke-linecap': 'round' }));
  if (fh === 'mustache' || fh === 'mustache-stubble') svg.append(s('path', { d: 'M25 35c2-3 5-3 7-1.5 2-1.5 5-1.5 7 1.5-2 0-4-1-7-.3-3-.7-5 .3-7 .3Z', fill: spec.facialHair.color }));
  if (spec.accessory === 'glasses' || spec.accessory === 'sunglasses') {
    const fill = spec.accessory === 'sunglasses' ? '#111' : 'none';
    for (const x of [26, 38]) svg.append(s('circle', { cx: x, cy: eyeY, r: 4.5, fill, stroke: spec.accessoryColor, 'stroke-width': 1.6 }));
    svg.append(s('path', { d: `M30.5 ${eyeY}h3`, stroke: spec.accessoryColor, 'stroke-width': 1.6 }));
  }
  if (spec.accessory === 'cap') svg.append(s('path', { d: 'M16 22c1-8 8-12 16-12s15 4 16 12Zm28 0h9c0 2-2 3-9 3Z', fill: spec.accessoryColor }));
  if (spec.accessory === 'beanie') svg.append(s('path', { d: 'M16 23c0-9 7-14 16-14s16 5 16 14Z', fill: spec.accessoryColor }));
  if (spec.accessory === 'headphones') svg.append(s('path', { d: 'M15 28a17 17 0 0 1 34 0', stroke: spec.accessoryColor, 'stroke-width': 3, fill: 'none' }), s('rect', { x: 12, y: 25, width: 6, height: 10, rx: 2, fill: spec.accessoryColor }), s('rect', { x: 46, y: 25, width: 6, height: 10, rx: 2, fill: spec.accessoryColor }));
  if (spec.accessory === 'crown') svg.append(s('path', { d: 'M20 14l4 6 4-7 4 7 4-7 4 7 4-6v8H20Z', fill: '#f5c542' }));
  const node = h('span.portrait', { title: title || spec.name, style: { '--ring': ring, width: `${size}px`, height: `${size}px` } }, svg);
  if (status) node.append(statusDot(status));
  return node;
}

/** Escape text for safe interpolation where a string is required. Prefer h(). */
export function escapeHtml(text) { return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function plural(n, word, many = `${word}s`) { return `${n} ${n === 1 ? word : many}`; }
export function formatNumber(n) { if (!Number.isFinite(n)) return '—'; return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)); }
export function formatBytes(n) { if (!Number.isFinite(n)) return '—'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`; }
