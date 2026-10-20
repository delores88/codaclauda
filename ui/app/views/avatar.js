/* My avatar: a live 3D builder, local photo matching, and agent-designed avatars.
 * Left: a turntable stage (three.js, loaded lazily so the editor works even
 * without WebGL). Right: the editor card with a sticky save bar. The draft is
 * kept across store refreshes and view switches until it is saved or reset. */
import {
  defaultAvatar, normalizeAvatar, SKIN_TONES, HAIR_COLORS, HAIR_STYLES, FACIAL_HAIR,
  EYE_STYLES, MOUTHS, TOPS, BOTTOMS, EMBLEMS, ACCESSORIES,
} from '../avatar/spec.js';
import { analyzePhoto, decodePhoto, describeMatch } from '../avatar/photo.js';
import { designPrompt, avatarFromReply } from '../avatar/agent-design.js';
import { sessions } from '../sessions.js';

/* ---------- vocabulary ---------- */
const LABELS = {
  hair: { short: 'Short', messy: 'Messy', buzz: 'Buzz', curly: 'Curly', long: 'Long', ponytail: 'Ponytail', bun: 'Bun', mohawk: 'Mohawk', bald: 'Bald' },
  facialHair: { none: 'None', stubble: 'Stubble', mustache: 'Mustache', 'mustache-stubble': 'Mustache + stubble', goatee: 'Goatee', beard: 'Beard' },
  eyes: { round: 'Round', happy: 'Happy', sleepy: 'Sleepy' },
  mouth: { smile: 'Smile', grin: 'Grin', neutral: 'Neutral' },
  top: { tee: 'T-shirt', hoodie: 'Hoodie', jacket: 'Jacket', sweater: 'Sweater', tank: 'Tank top' },
  bottom: { jeans: 'Jeans', joggers: 'Joggers', shorts: 'Shorts', skirt: 'Skirt' },
  emblem: { none: 'None', claude: 'Claude', codex: 'Codex', star: 'Star', heart: 'Heart', bolt: 'Bolt' },
  accessory: { none: 'None', glasses: 'Glasses', sunglasses: 'Sunglasses', cap: 'Cap', beanie: 'Beanie', headphones: 'Headphones', crown: 'Crown' },
};
const labelOf = (group, value) => LABELS[group]?.[value] || String(value).replace(/(^|-)(\w)/g, (_, dash, c) => (dash ? ' ' : '') + c.toUpperCase());
const named = (colors, names) => colors.map((c, i) => [c, names[i] || `Color ${i + 1}`]);
const SKIN = named(SKIN_TONES, ['Porcelain', 'Fair', 'Light', 'Light medium', 'Medium', 'Tan', 'Brown', 'Deep brown', 'Deep']);
const HAIR = named(HAIR_COLORS, ['Black', 'Dark brown', 'Brown', 'Chestnut', 'Light brown', 'Caramel', 'Blonde', 'Platinum', 'Grey', 'Red', 'Blue', 'Pink']);
const EYE_COLORS = [['#3b2f2a', 'Dark brown'], ['#5a4636', 'Brown'], ['#7a5c3a', 'Hazel'], ['#3f6b45', 'Green'], ['#4b6a80', 'Blue-grey'], ['#5e7d91', 'Light blue'], ['#2f5d8a', 'Blue'], ['#6b7178', 'Grey']];
const CLOTHES = [['#2f6fed', 'Blue'], ['#e07a55', 'Coral'], ['#12a883', 'Teal'], ['#8b7bff', 'Violet'], ['#ff5d6c', 'Red'], ['#f5b544', 'Mustard'], ['#3ccf8e', 'Green'], ['#1f2937', 'Charcoal'], ['#f4f4f5', 'White'], ['#7c4a2d', 'Brown'], ['#2e3a4f', 'Navy'], ['#9aa0b5', 'Grey']];
const ACCENTS = [['#ffffff', 'White'], ['#1d1830', 'Ink'], ['#fbe7dc', 'Peach'], ['#d7f5ec', 'Mint'], ['#f5c542', 'Gold'], ['#ff8a5c', 'Orange'], ['#b276ff', 'Lilac'], ['#22c7a9', 'Aqua']];
const BOTTOM_COLORS = [['#2e3a4f', 'Denim'], ['#1f2a44', 'Dark denim'], ['#2b2b33', 'Black'], ['#4a3f35', 'Brown'], ['#6b7280', 'Grey'], ['#c9b28a', 'Khaki'], ['#3f5e3a', 'Olive'], ['#8b7bff', 'Violet']];
const SHOE_COLORS = [['#25262b', 'Black'], ['#f4f4f5', 'White'], ['#7c4a2d', 'Brown'], ['#e07a55', 'Coral'], ['#2f6fed', 'Blue'], ['#ff5d6c', 'Red'], ['#12a883', 'Teal']];
const ACCESSORY_COLORS = [['#222222', 'Black'], ['#3a2318', 'Tortoise'], ['#c0c4cc', 'Silver'], ['#f5c542', 'Gold'], ['#e07a55', 'Coral'], ['#2f6fed', 'Blue'], ['#12a883', 'Teal'], ['#ff6fae', 'Pink']];
const ACTIONS = [['stand', 'Stand', 'avatar'], ['wave', 'Wave', 'av-wave'], ['walk', 'Walk', 'av-walk'], ['work', 'Work', 'av-laptop'], ['sit', 'Sit', 'av-chair']];
const SECTIONS = [['photo', 'Photo'], ['agent', 'Agent'], ['basics', 'Basics'], ['hair', 'Hair'], ['face', 'Face'], ['outfit', 'Outfit'], ['extras', 'Extras'], ['build', 'Build']];

const ICONS = {
  'av-face': '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
  'av-drop': '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/>',
  'av-hair': '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1 20 20M8.1 15.9 20 4"/>',
  'av-glasses': '<circle cx="7" cy="14" r="3.5"/><circle cx="17" cy="14" r="3.5"/><path d="M10.5 14h3M3.5 14 5 8h2M20.5 14 19 8h-2"/>',
  'av-ruler': '<path d="M3 17 17 3l4 4L7 21Z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>',
  'av-upload': '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>',
  'av-undo': '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  'av-rotate': '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  'av-lock': '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  'av-wave': '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-5-2.7L3 14.5a1.5 1.5 0 0 1 2.5-1.6L8 15"/>',
  'av-walk': '<circle cx="13" cy="4" r="2"/><path d="m9 20 3-6 3 3v4M7 11l3-3 4 1 2 4 3 1M12 14l-1-5"/>',
  'av-laptop': '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
  'av-chair': '<path d="M7 3v9h10V3M5 12h14M7 12v9M17 12v9M7 17h10"/>',
  'av-tee': '<path d="M8 4 4 6.5 5.5 10H7.5V20h9V10h2L20 6.5 16 4c-.7 1.5-2.2 2.3-4 2.3S8.7 5.5 8 4Z"/>',
  'av-hoodie': '<path d="M8 5 4 7.5 5.5 11h2v9h9v-9h2L20 7.5 16 5"/><path d="M8 5c0-2 1.8-3 4-3s4 1 4 3-1.8 3.5-4 3.5S8 7 8 5ZM11 9v3M13 9v3"/>',
  'av-jacket': '<path d="M8 4 4 6.5 5.5 10h2v10h9V10h2L20 6.5 16 4"/><path d="m8 4 4 5 4-5M12 9v11"/>',
  'av-sweater': '<path d="M8 4 4 6v12h3.5v2h9v-2H20V6l-4-2c-.7 1.5-2.2 2.3-4 2.3S8.7 5.5 8 4Z"/><path d="M7.5 9v9M16.5 9v9M7.5 17h9"/>',
  'av-tank': '<path d="M9 3v3c0 2-2 3-2 5v9h10v-9c0-2-2-3-2-5V3"/><path d="M9 6c1 1.5 5 1.5 6 0"/>',
  'av-jeans': '<path d="M6 3h12l1 18h-5l-2-11-2 11H5Z"/><path d="M6 6h12"/>',
  'av-joggers': '<path d="M6 3h12l1 16-1 2h-4l-2-11-2 11H6l-1-2Z"/><path d="M5.5 18h4M14.5 18h4M6 6h12"/>',
  'av-shorts': '<path d="M5 5h14l1 11h-6l-2-6-2 6H4Z"/><path d="M5 8h14"/>',
  'av-skirt': '<path d="M8 4h8l4 15H4Z"/><path d="M8 7h8"/>',
  'av-none': '<circle cx="12" cy="12" r="8"/><path d="m6.5 17.5 11-11"/>',
  'av-claude': '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/>',
  'av-codex': '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12"/>',
  'av-star': '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/>',
  'av-heart': '<path d="M12 20s-7-4.4-9-9a5 5 0 0 1 9-4 5 5 0 0 1 9 4c-2 4.6-9 9-9 9Z"/>',
};
const TOP_ICONS = { tee: 'av-tee', hoodie: 'av-hoodie', jacket: 'av-jacket', sweater: 'av-sweater', tank: 'av-tank' };
const BOTTOM_ICONS = { jeans: 'av-jeans', joggers: 'av-joggers', shorts: 'av-shorts', skirt: 'av-skirt' };
const EMBLEM_ICONS = { none: 'av-none', claude: 'av-claude', codex: 'av-codex', star: 'av-star', heart: 'av-heart', bolt: 'bolt' };

/* ---------- small helpers ---------- */
const sig = spec => JSON.stringify(normalizeAvatar(spec));
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.'); const last = keys.pop(); let node = obj;
  for (const k of keys) node = node[k] && typeof node[k] === 'object' ? node[k] : (node[k] = {});
  node[last] = value;
}
function merge(base, partial) {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(partial || {})) out[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...out[key], ...value } : value;
  return out;
}
const round2 = n => Math.round(n * 100) / 100;
function randomSpec(base) {
  const pick = list => list[Math.floor(Math.random() * list.length)];
  const chance = p => Math.random() < p;
  const spec = normalizeAvatar(base);
  spec.skin = pick(SKIN_TONES);
  spec.blush = round2(0.1 + Math.random() * 0.5);
  spec.hair = { style: pick(HAIR_STYLES), color: chance(0.8) ? pick(HAIR_COLORS.slice(0, 9)) : pick(HAIR_COLORS.slice(9)) };
  spec.facialHair = { style: chance(0.55) ? 'none' : pick(FACIAL_HAIR.slice(1)), color: spec.hair.color };
  spec.eyes = { style: pick(EYE_STYLES), color: pick(EYE_COLORS)[0] };
  spec.brows = { thickness: round2(0.3 + Math.random() * 0.5) };
  spec.mouth = pick(MOUTHS);
  spec.top = { style: pick(TOPS), color: pick(CLOTHES)[0], accent: pick(ACCENTS)[0], emblem: pick(EMBLEMS) };
  spec.bottom = { style: pick(BOTTOMS), color: pick(BOTTOM_COLORS)[0] };
  spec.shoes = { color: pick(SHOE_COLORS)[0] };
  spec.accessory = chance(0.45) ? 'none' : pick(ACCESSORIES.slice(1));
  spec.accessoryColor = pick(ACCESSORY_COLORS)[0];
  spec.build = { height: round2(0.92 + Math.random() * 0.16), width: round2(0.92 + Math.random() * 0.18) };
  return spec;
}
const summary = spec => [`${labelOf('hair', spec.hair.style)} hair`, spec.facialHair.style !== 'none' ? labelOf('facialHair', spec.facialHair.style) : null, labelOf('top', spec.top.style), spec.accessory !== 'none' ? labelOf('accessory', spec.accessory) : null].filter(Boolean).join(' · ');
const replyNote = body => String(body || '').replace(/```[\s\S]*?```/g, ' ').replace(/[#*_>`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

/* ======================================================================== */
export function mount(root, ctx) {
  const { store, ui, navigate } = ctx;
  const { h, icon, iconButton, toast, portrait, timeAgo, clear, copyText, STATUS_LABEL, toMs, formatBytes } = ui;
  ui.registerIcons(ICONS);

  const reducedQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const reduced = () => Boolean(store.prefs.reducedMotion || reducedQuery?.matches);

  let draft = normalizeAvatar(store.avatar || defaultAvatar());
  let baselineSig = sig(store.avatar || defaultAvatar());
  let shown = false, greeted = false, lastReduced = reduced();
  let action = 'stand', autoRotate = !lastReduced;
  let photo = null;          // { file, bitmap, name, bytes, width, height }
  let match = null;          // { result, undo: spec | null }
  let analyzing = false, sending = false, selectedAgentId = null;
  let stage = null, stagePromise = null, stageFailed = false, stageInView = true;
  let flushQueued = false, forceSync = false, dynamicQueued = false;
  let savedPulse = 0;
  const syncers = [], previewGroups = [];
  const memo = {};

  /* ---------------- generic controls ---------------- */
  function roving(group) {
    group.addEventListener('keydown', event => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (!(event.key in keys) && event.key !== 'Home' && event.key !== 'End') return;
      const items = [...group.querySelectorAll('[role="radio"]:not(:disabled)')];
      const index = items.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + keys[event.key] + items.length) % items.length;
      items[next].focus(); items[next].click();
    });
  }
  function syncRadios(buttons, value) {
    let any = false;
    for (const b of buttons) { const on = b.dataset.value === value; any ||= on; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    if (!any && buttons[0]) buttons[0].tabIndex = 0;
  }
  function field(label, control, extra) {
    return h('div.av-field', h('div.av-field-head', h('span', label), extra || null), control);
  }
  /** Chip group bound to a spec path. preview: tiny portraits of the draft with each option. */
  function chips(path, group, values, { label, icons, preview } = {}) {
    const buttons = values.map(value => h(`button.av-chip${preview ? '.has-preview' : ''}`, { type: 'button', role: 'radio', 'aria-checked': 'false', dataset: { value }, onclick: () => edit(path, value) },
      preview ? h('span.av-chip-preview') : icons?.[value] ? icon(icons[value]) : null,
      h('span', labelOf(group, value))));
    const node = h('div.av-chips', { role: 'radiogroup', 'aria-label': label }, buttons);
    roving(node);
    syncers.push(() => syncRadios(buttons, getPath(draft, path)));
    if (preview) previewGroups.push({ path, group, values, buttons, sig: '' });
    return node;
  }
  /** Swatch row + custom color, wrapped in a labeled field that shows the hex value. */
  function colorField(label, path, palette, extra) {
    const buttons = palette.map(([value, name]) => h('button.av-swatch', { type: 'button', role: 'radio', 'aria-checked': 'false', title: name, 'aria-label': name, dataset: { value }, style: { '--swatch': value }, onclick: () => edit(path, value) }));
    const input = h('input', { type: 'color', 'aria-label': `Custom ${label.toLowerCase()}`, oninput: event => edit(path, event.currentTarget.value.toLowerCase()) });
    const custom = h('label.av-swatch.custom', { title: 'Custom color' }, input, icon('plus'));
    const row = h('div.av-swatches', { role: 'radiogroup', 'aria-label': label }, buttons, custom);
    roving(row);
    const hexOut = h('span.av-hex.mono');
    syncers.push(force => {
      const value = String(getPath(draft, path) || '').toLowerCase();
      syncRadios(buttons, value);
      const isCustom = !palette.some(([c]) => c === value);
      custom.classList.toggle('selected', isCustom);
      if (isCustom) custom.style.setProperty('--swatch', value); else custom.style.removeProperty('--swatch');
      if (force || document.activeElement !== input) input.value = value || '#000000';
      hexOut.textContent = value;
    });
    return field(label, row, h('span.av-field-extra', extra || null, hexOut));
  }
  function slider(label, path, { min, max, step = 0.01, format }) {
    const out = h('output.av-range-value');
    const input = h('input.av-range', { type: 'range', min, max, step, 'aria-label': label, oninput: event => edit(path, Number(event.currentTarget.value)) });
    syncers.push(force => {
      const value = Number(getPath(draft, path));
      if (force || document.activeElement !== input) input.value = String(value);
      input.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
      out.textContent = format(value);
      input.setAttribute('aria-valuetext', format(value));
    });
    return field(label, h('div.av-range-row', input, out));
  }
  function section(id, title, iconName, hint, ...children) {
    return h('section.av-section', { id: `av-sec-${id}`, dataset: { section: id }, 'aria-label': title },
      h('header.av-section-head', h('span.av-section-icon', icon(iconName)), h('div', h('h3', title), hint ? h('p', hint) : null)),
      ...children);
  }

  /* ---------------- draft editing ---------------- */
  function edit(path, value) {
    setPath(draft, path, value);
    if (match?.undo) { match.undo = null; renderPhoto(); }
    scheduleFlush();
  }
  function replaceDraft(spec) { draft = normalizeAvatar(spec); scheduleFlush(true); }
  function scheduleFlush(force = false) {
    forceSync ||= force;
    if (flushQueued) return;
    flushQueued = true;
    requestAnimationFrame(flush);
  }
  function flush() {
    flushQueued = false;
    const force = forceSync; forceSync = false;
    const spec = normalizeAvatar(draft);
    for (const sync of syncers) sync(force);
    updatePreviews(spec);
    if (stage) { try { stage.setSpec(spec); } catch (error) { console.warn('Avatar preview update failed', error); } }
    if (stageFailed) renderFallback(spec);
    stageName.textContent = spec.name;
    clear(footPortrait, portrait(spec, { size: 32, title: 'How you appear in chats and on the board' }));
    updateFooter();
    renderRequests();
  }
  function updatePreviews(spec) {
    for (const group of previewGroups) {
      const base = structuredClone(spec); setPath(base, group.path, null);
      const key = JSON.stringify(base);
      if (key === group.sig) continue;
      group.sig = key;
      group.values.forEach((value, i) => {
        const variant = structuredClone(spec); setPath(variant, group.path, value);
        clear(group.buttons[i].querySelector('.av-chip-preview'), portrait(variant, { size: 28, title: labelOf(group.group, value) }));
      });
    }
  }
  const isDirty = () => sig(draft) !== baselineSig;

  /* ---------------- stage (left) ---------------- */
  const stageHost = h('div.av-stage-canvas');
  const stageName = h('h2.av-stage-name');
  const stageLoading = h('div.av-stage-loading', h('span.spinner'), 'Building your 3D preview…');
  const stageFallback = h('div.av-stage-fallback', { hidden: true });
  const rotateBtn = h('button.icon-btn.av-glass-btn', { type: 'button', title: 'Auto-rotate', 'aria-label': 'Auto-rotate', 'aria-pressed': String(autoRotate), onclick: () => { autoRotate = !autoRotate; rotateBtn.setAttribute('aria-pressed', String(autoRotate)); stage?.setAutoRotate(autoRotate); } }, icon('av-rotate'));
  const resetViewBtn = iconButton('home', 'Reset view', () => stage?.resetView(), 'av-glass-btn');
  const actionButtons = ACTIONS.map(([id, text, iconName]) => h('button', { type: 'button', 'aria-pressed': String(id === action), dataset: { action: id }, onclick: () => setAction(id) }, icon(iconName), h('span', text)));
  const stageHint = h('p.av-stage-hint', 'Drag to turn · Scroll to zoom · Click me to wave');
  const stageTools = h('div.av-stage-tools', rotateBtn, resetViewBtn);
  const actionBar = h('div.segmented.av-actions', { role: 'group', 'aria-label': 'Pose' }, actionButtons);
  const stageCard = h('div.av-stage',
    stageHost, stageLoading, stageFallback,
    h('div.av-stage-top', h('div.av-stage-title', h('span.eyebrow', 'My avatar'), stageName), stageTools),
    h('div.av-stage-bottom', actionBar, stageHint));

  function setAction(id) {
    action = id;
    for (const b of actionButtons) b.setAttribute('aria-pressed', String(b.dataset.action === id));
    stage?.setAction(id);
  }
  function renderFallback(spec = normalizeAvatar(draft)) {
    clear(stageFallback, portrait(spec, { size: 188 }), h('strong', spec.name), h('span', '3D preview is unavailable on this PC, so this is your 2D portrait. Everything else works.'));
  }
  function ensureStage() {
    if (stage || stagePromise || stageFailed) return;
    stagePromise = createStage(stageHost, { spec: normalizeAvatar(draft), quality: store.prefs.cityQuality === 'low' ? 'low' : 'high' })
      .then(created => {
        stage = created;
        stageLoading.hidden = true;
        stage.setSpec(normalizeAvatar(draft));
        stage.setAction(action);
        stage.setAutoRotate(autoRotate);
        updateStageActive();
        if (shown && !greeted && !reduced()) { greeted = true; stage.greet(2600); }
      })
      .catch(error => {
        console.warn('Avatar 3D preview unavailable', error);
        stageFailed = true; stage = null;
        stageHost.replaceChildren();
        stageLoading.hidden = true;
        stageFallback.hidden = false;
        stageTools.hidden = true; actionBar.hidden = true; stageHint.hidden = true;
        renderFallback();
      });
  }
  const updateStageActive = () => stage?.setActive(shown && stageInView && !document.hidden);
  document.addEventListener('visibilitychange', updateStageActive);
  if ('IntersectionObserver' in window) new IntersectionObserver(entries => { stageInView = entries.some(e => e.isIntersecting); updateStageActive(); }).observe(stageCard);

  /* ---------------- photo ---------------- */
  const photoInput = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: event => { setPhoto(event.currentTarget.files?.[0]); event.currentTarget.value = ''; } });
  const jsonInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: event => { importJson(event.currentTarget.files?.[0]); event.currentTarget.value = ''; } });
  const photoBody = h('div.av-photo');

  async function setPhoto(file) {
    if (!file) return;
    const looksImage = file.type?.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name || '');
    if (!looksImage) { toast('That file is not an image. Try a JPG or PNG photo.', { kind: 'error' }); return; }
    if (file.size > 25 * 1024 * 1024) { toast('That photo is over 25 MB. Try a smaller copy.', { kind: 'error' }); return; }
    try {
      const bitmap = await decodePhoto(file);
      photo?.bitmap?.close?.();
      photo = { file, bitmap, name: file.name || 'photo', bytes: file.size, width: bitmap.width, height: bitmap.height };
      match = null;
      renderPhoto(); renderAgentSend();
    } catch (error) { toast(error.message, { kind: 'error' }); }
  }
  function removePhoto() { photo?.bitmap?.close?.(); photo = null; match = null; renderPhoto(); renderAgentSend(); }
  function drawThumb() {
    const canvas = h('canvas', { 'aria-label': 'Your photo', role: 'img' });
    const scale = Math.min(1, 264 / Math.max(photo.width, photo.height));
    const w = Math.max(1, Math.round(photo.width * scale)), hgt = Math.max(1, Math.round(photo.height * scale));
    canvas.width = w; canvas.height = hgt;
    const g = canvas.getContext('2d');
    g.drawImage(photo.bitmap, 0, 0, w, hgt);
    const regions = match?.result?.regions;
    if (regions) {
      g.lineWidth = 2;
      g.setLineDash([6, 4]); g.strokeStyle = 'rgba(255,255,255,.9)';
      g.strokeRect(regions.face.x * w, regions.face.y * hgt, regions.face.w * w, regions.face.h * hgt);
      g.setLineDash([]);
      for (const s of regions.samples) {
        if (!s.color) continue;
        g.fillStyle = s.color; g.globalAlpha = 0.55; g.fillRect(s.x * w, s.y * hgt, s.w * w, s.h * hgt);
        g.globalAlpha = 1; g.strokeStyle = 'rgba(255,255,255,.95)'; g.strokeRect(s.x * w, s.y * hgt, s.w * w, s.h * hgt);
      }
    }
    return canvas;
  }
  function renderPhoto() {
    if (!photo) {
      clear(photoBody, h('div.av-drop', { role: 'button', tabindex: '0', 'aria-label': 'Choose a photo of yourself', onclick: () => photoInput.click(), onkeydown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); photoInput.click(); } } },
        h('span.av-drop-art', icon('camera')),
        h('strong', 'Start from a photo'),
        h('span.muted', 'Drop a photo here, paste one with Ctrl+V, or browse. A front-facing head-and-shoulders shot works best.'),
        h('span.btn.small', icon('image'), 'Choose photo')));
      return;
    }
    const matchBtn = h('button.btn.gradient', { type: 'button', disabled: analyzing, onclick: runMatch }, analyzing ? h('span.spinner') : icon('sparkle'), analyzing ? 'Matching…' : match ? 'Match again' : 'Match my photo');
    clear(photoBody,
      h('div.av-photo-row',
        h('div.av-thumb', drawThumb(), iconButton('close', 'Remove photo', removePhoto, 'av-thumb-remove')),
        h('div.av-photo-meta',
          h('strong.av-photo-name', { title: photo.name }, photo.name),
          h('span.muted', `${photo.width} × ${photo.height} · ${formatBytes(photo.bytes)}`),
          h('div.av-photo-actions', matchBtn, h('button.btn.ghost.small', { type: 'button', onclick: () => photoInput.click() }, 'Replace')))),
      match ? matchSummary() : null);
  }
  function matchSummary() {
    const { result } = match;
    const spec = normalizeAvatar(draft);
    const mini = (text, color) => h('span.av-mini', color ? h('i', { style: { '--swatch': color } }) : null, text);
    const chipsOut = [];
    if (result.matched.includes('skin')) chipsOut.push(mini('Skin', spec.skin));
    if (result.matched.includes('hair')) chipsOut.push(mini(`Hair · ${labelOf('hair', spec.hair.style)}`, spec.hair.color));
    if (result.matched.includes('facial hair')) chipsOut.push(mini(`Facial hair · ${labelOf('facialHair', spec.facialHair.style)}`, spec.facialHair.style === 'none' ? null : spec.facialHair.color));
    if (result.matched.includes('shirt')) chipsOut.push(mini('Shirt', spec.top.color));
    return h('div.av-match', { role: 'status' },
      h('div.av-match-head',
        h('span.av-match-check', icon(result.matched.length ? 'check' : 'alert')),
        h('strong', result.matched.length ? `${describeMatch(result.matched)} — fine-tune below` : 'Nothing could be matched confidently from this photo — try a brighter, front-facing one.'),
        match.undo ? h('button.btn.ghost.small', { type: 'button', onclick: undoMatch }, icon('av-undo'), 'Undo') : null),
      chipsOut.length ? h('div.av-match-swatches', chipsOut) : null,
      h('details.av-match-notes', h('summary', 'How it was matched'), h('ul', result.notes.map(note => h('li', note)))));
  }
  async function runMatch() {
    if (!photo || analyzing) return;
    analyzing = true; renderPhoto();
    try {
      const result = await analyzePhoto(photo.bitmap, { current: normalizeAvatar(draft) });
      const before = structuredClone(draft);
      replaceDraft(merge(normalizeAvatar(draft), result.spec));
      match = { result, undo: before };
      if (!reduced()) stage?.greet();
    } catch (error) {
      toast(error.message || 'Could not analyze that photo.', { kind: 'error' });
    } finally { analyzing = false; renderPhoto(); }
  }
  function undoMatch() { if (!match?.undo) return; replaceDraft(match.undo); match = null; renderPhoto(); }
  function onPaste(event) {
    const item = [...(event.clipboardData?.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item) return;
    const blob = item.getAsFile(); if (!blob) return;
    event.preventDefault();
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    setPhoto(new File([blob], `avatar-photo-${stamp()}.${ext}`, { type: blob.type }));
  }

  /* ---------------- agent build ---------------- */
  const agentList = h('div.av-agents');
  const sendLabel = h('span.av-send-label');
  const sendIcon = h('span.av-send-icon');
  const sendBtn = h('button.btn.primary.av-send', { type: 'button', onclick: sendToAgent }, sendIcon, sendLabel);
  const sendHint = h('p.field-hint.av-send-hint');
  const requestsBox = h('div.av-requests', { 'aria-live': 'polite' });
  const agentBadge = h('span.av-nav-badge', { hidden: true });

  const mailboxAgents = () => store.agents.filter(a => a.kind === 'mailbox' && a.address);
  const selectedAgent = () => mailboxAgents().find(a => a.id === selectedAgentId) || null;
  const agentByAddress = address => store.agents.find(a => a.address === address);
  const agentName = address => agentByAddress(address)?.name || store.addressLabel(address);

  function keepFocus(container, render) {
    const active = document.activeElement;
    const key = container.contains(active) ? active.closest('[data-key]')?.dataset.key : null;
    render();
    if (key) container.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
  }
  function renderAgents() {
    const agents = mailboxAgents();
    const key = JSON.stringify(agents.map(a => [a.id, a.name, a.status, a.provider, Math.floor((Date.now() - a.lastSeenAt) / 60000), JSON.stringify(a.look)]));
    if (!agents.some(a => a.id === selectedAgentId)) {
      selectedAgentId = (agents.find(a => a.provider === 'claude' && a.status !== 'offline') || agents.find(a => a.status !== 'offline') || agents[0])?.id || null;
    }
    if (key === memo.agents) { syncAgentSelection(); return; }
    memo.agents = key;
    keepFocus(agentList, () => {
      if (!agents.length) {
        clear(agentList, h('div.av-agents-empty', icon('agents'), h('div', h('strong', 'No agents on the board yet'), h('span.muted', 'Claude and Codex chats appear here once they register a mailbox address.'))));
        return;
      }
      const groups = [['claude', 'Claude'], ['codex', 'Codex'], ['other', 'Other agents']]
        .map(([provider, label]) => [provider, label, agents.filter(a => (provider === 'other' ? !['claude', 'codex'].includes(a.provider) : a.provider === provider))])
        .filter(([, , list]) => list.length);
      clear(agentList, groups.map(([provider, label, list]) => h('div.av-agent-group',
        h('div.av-agent-group-head', h(`span.pill.${provider === 'other' ? 'accent' : provider}`, label), h('span.muted', `${list.length} ${list.length === 1 ? 'agent' : 'agents'}`)),
        h('div.av-agent-list', list.map(agent => h('button.av-agent', { type: 'button', 'aria-pressed': 'false', dataset: { key: `agent:${agent.id}`, id: agent.id }, onclick: () => { selectedAgentId = agent.id; syncAgentSelection(); renderAgentSend(); } },
          portrait(agent.look, { size: 34, provider: agent.provider, status: agent.status }),
          h('span.av-agent-text', h('strong', { title: agent.label || agent.name }, agent.name), h('span.muted', `${STATUS_LABEL[agent.status] || agent.status}${agent.lastSeenAt ? ` · last active ${timeAgo(agent.lastSeenAt)}` : ''}`)),
          h('span.av-agent-check', icon('check'))))))));
      syncAgentSelection();
    });
  }
  function syncAgentSelection() {
    for (const node of agentList.querySelectorAll('.av-agent')) node.setAttribute('aria-pressed', String(node.dataset.id === selectedAgentId));
  }
  function renderAgentSend() {
    const agent = selectedAgent();
    sendBtn.disabled = !agent || !photo || sending;
    clear(sendIcon, sending ? h('span.spinner') : icon('send'));
    sendLabel.textContent = sending ? 'Sending…' : agent ? `Send photo to ${agent.name}` : 'Send photo to an agent';
    sendBtn.title = sendLabel.textContent;
    sendHint.textContent = !mailboxAgents().length ? ''
      : !photo ? 'Add a photo above first. Your current draft goes along as a starting point.'
        : !agent ? 'Pick an agent.'
          : agent.status === 'offline' ? `${agent.name} looks powered down. It will see the request the next time it checks the board.`
            : `Sends your photo and current draft to ${agent.name}'s mailbox.`;
    renderDesign();   // its hint mentions the photo
  }
  async function sendToAgent() {
    const agent = selectedAgent();
    if (!agent || !photo || sending) return;
    sending = true; renderAgentSend();
    try {
      await store.requestAvatarBuild(agent.address, photo.file, normalizeAvatar(draft));
      toast(`Sent to ${agent.name}. Agents reply when they next check the board.`, { kind: 'success' });
    } catch (error) {
      toast(`Could not send the photo: ${error.message}`, { kind: 'error' });
    } finally { sending = false; renderAgentSend(); memo.requests = null; renderRequests(); }
  }
  function withName(spec) {
    const out = normalizeAvatar(spec);
    if (out.name === 'You' && draft.name && draft.name !== 'You') out.name = normalizeAvatar(draft).name;
    return out;
  }
  function previewReply(reply) {
    replaceDraft(withName(reply.spec));
    if (!reduced()) stage?.greet();
    toast(`Previewing ${agentName(reply.agent)}'s design. Save to keep it.`, { kind: 'info', timeout: 3500 });
  }
  function applyReply(reply) {
    const spec = withName(reply.spec);
    replaceDraft(spec);
    commitSave(spec);
    toast(`Applied ${agentName(reply.agent)}'s design.`, { kind: 'success' });
  }
  function dismissRequest(requestId) { store.updateDesktop(d => { delete d.avatarRequests?.[requestId]; }); }

  /* ---------------- agent design in a chat (0.5): Claude or Codex designs it now ---------------- */
  const NAMES = { claude: 'Claude', codex: 'Codex' };
  let design = null;   // { provider, state: 'starting' | 'waiting' | 'ready' | 'error', sessionId, turnId, spec, error, project }
  const designWish = h('input.input', { type: 'text', maxLength: 300, placeholder: 'Describe the look (optional), e.g. curly red hair and a green hoodie', 'aria-label': 'Describe the look you want (optional)', autocomplete: 'off', spellcheck: false });
  const designActions = h('div.av-design-actions');
  const designHint = h('p.field-hint.av-design-hint');
  const designStatus = h('div.av-design-status-box', { 'aria-live': 'polite' });
  const designBox = h('div.av-design', h('div.av-design-title', icon('sparkle'), h('strong', 'Design it with Claude or Codex now')), designWish, designActions, designHint, designStatus);
  const designProject = () => {
    const local = store.projects.filter(p => String(p.path || '').trim());
    const pref = store.prefs.chatProject;
    return local.find(p => pref && (p.id === pref || p.ids?.includes(pref))) || local[0] || null;
  };
  function designBlocked() {
    if (!sessions.supported() || sessions.available === false) return 'This needs CodaClauda desktop sessions (0.4 or later). You can still send your photo to a board agent below.';
    if (!designProject()) return 'Link a local project folder first: the design chat needs a working folder (it is Read only, so nothing there changes).';
    return '';
  }
  const designBusy = () => Boolean(design && (design.state === 'starting' || design.state === 'waiting'));
  async function startDesign(provider) {
    if (designBusy()) return;
    const blocked = designBlocked();
    if (blocked) { toast(blocked, { kind: 'error' }); return; }
    const project = designProject();
    design = { provider, state: 'starting', sessionId: null, turnId: null, spec: null, error: '', project: project.name };
    renderDesign();
    try {
      if (sessions.available !== true) await sessions.refresh();
      const session = await sessions.start({ provider, projectId: project.id, cwd: project.path, access: 'read', title: 'Avatar design', playwright: false });
      design.sessionId = session.id;
      let attachments = [];
      if (photo?.file) {
        try { const saved = await store.saveAttachment(photo.file); if (saved?.path) attachments = [{ path: saved.path, name: saved.name || photo.file.name }]; }
        catch { /* the design still works from the description and the current draft */ }
      }
      const sent = await sessions.send(session.id, designPrompt(normalizeAvatar(draft), { description: designWish.value, photo: attachments.length > 0 }), attachments);
      design.turnId = sent?.turnId || null;
      design.state = 'waiting';
      checkDesign();
    } catch (error) {
      design.state = 'error';
      design.error = `Couldn't start the design chat: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 200)}`;
    }
    renderDesign();
  }
  /** Reads the design chat's display log (sessions.js): the first usable avatar JSON in this turn's replies wins. */
  function checkDesign() {
    if (design?.state !== 'waiting' || !design.sessionId) return;
    const events = sessions.logs.get(design.sessionId)?.events || [];
    const mine = events.filter(e => !design.turnId || !e.turnId || e.turnId === design.turnId);
    const replies = mine.filter(e => e.kind === 'message' && typeof e.text === 'string');
    let problem = '';
    for (const reply of replies) {
      const result = avatarFromReply(reply.text);
      if (result.spec) { design.state = 'ready'; design.spec = withName(result.spec); renderDesign(); return; }
      problem ||= result.error;
    }
    const failed = mine.find(e => e.kind === 'error'), done = mine.find(e => e.kind === 'done');
    if (!failed && !done) return;
    const who = NAMES[design.provider] || 'The agent';
    design.state = 'error';
    design.error = problem ? `${who} replied, but the design can't be used: ${problem}`
      : failed ? `${who} couldn't answer: ${String(failed.error || failed.text || 'the turn failed').replace(/\s+/g, ' ').slice(0, 200)}`
        : `${who} finished without a reply.`;
    renderDesign();
  }
  sessions.on('change', () => { if (design?.state === 'waiting') checkDesign(); });
  function openDesignChat() { if (design?.sessionId) navigate('chat', { thread: `sess:${design.sessionId}` }); }
  function renderDesign() {
    const blocked = designBlocked(), busy = designBusy();
    const sigActions = JSON.stringify([blocked, busy]);
    if (memo.designActions !== sigActions) {
      memo.designActions = sigActions;
      clear(designActions, ['claude', 'codex'].map(provider => h(`button.btn.small${provider === 'claude' ? '.primary' : ''}`, { type: 'button', disabled: Boolean(blocked) || busy, dataset: { key: `design:${provider}` }, onclick: () => startDesign(provider) }, icon('sparkle'), `${NAMES[provider]}, design it`)));
    }
    const project = designProject();
    designHint.textContent = blocked || `Starts a Read only ${project ? `chat in ${project.name}` : 'chat'}${photo ? ' and attaches your photo' : ''}. The reply is a suggestion: nothing changes until you apply it.`;
    const applied = design?.spec ? sig(design.spec) === baselineSig : false;
    const previewing = design?.spec ? !applied && sig(design.spec) === sig(draft) : false;
    const sigStatus = JSON.stringify([design?.state, design?.error, design?.sessionId, applied, previewing]);
    if (memo.designStatus === sigStatus) return;
    memo.designStatus = sigStatus;
    const chatBtn = () => (design?.sessionId ? h('button.btn.small.ghost', { type: 'button', onclick: openDesignChat }, icon('chat'), 'Open chat') : null);
    if (!design) { clear(designStatus); return; }
    const who = NAMES[design.provider] || 'The agent';
    if (busy) {
      clear(designStatus, h('div.av-design-status', h('span.spinner'), h('span', design.state === 'starting' ? `Starting a ${who} chat in ${design.project}…` : `${who} is designing your avatar…`), chatBtn()));
    } else if (design.state === 'ready') {
      clear(designStatus, h('article.av-result.fresh',
        portrait(design.spec, { size: 56, provider: design.provider }),
        h('div.av-result-body',
          h('strong', `${who} designed an avatar`),
          h('span.muted', summary(design.spec)),
          h('div.av-result-actions',
            h('button.btn.small', { type: 'button', disabled: previewing || applied, onclick: () => { replaceDraft(design.spec); if (!reduced()) stage?.greet(); toast(`Previewing ${who}'s design. Apply to keep it.`, { kind: 'info', timeout: 3000 }); renderDesign(); } }, icon('eye'), previewing ? 'Previewing' : 'Preview'),
            h('button.btn.small.primary', { type: 'button', disabled: applied, onclick: () => { replaceDraft(design.spec); commitSave(design.spec); toast(`Applied ${who}'s design.`, { kind: 'success' }); renderDesign(); } }, applied ? [icon('check'), 'Applied'] : 'Apply & save'),
            chatBtn(),
            h('button.btn.small.ghost', { type: 'button', onclick: () => { design = null; renderDesign(); } }, 'Dismiss')))));
    } else {
      clear(designStatus, h('div.av-design-error', { role: 'alert' }, icon('alert'),
        h('div.av-design-error-body', h('span', design.error),
          h('div.av-result-actions', h('button.btn.small', { type: 'button', onclick: () => { const p = design.provider; design = null; startDesign(p); } }, icon('refresh'), 'Try again'), chatBtn(),
            h('button.btn.small.ghost', { type: 'button', onclick: () => { design = null; renderDesign(); } }, 'Dismiss')))));
    }
  }
  function renderRequests() {
    const requests = Object.entries(store.desktop.avatarRequests || {}).map(([id, info]) => ({ id, ...info })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const replies = store.avatarReplies().sort((a, b) => toMs(b.reply.created_at) - toMs(a.reply.created_at));
    const replyCounts = new Map();
    for (const m of store.mailboxMessages) if (m.reply_to && store.desktop.avatarRequests?.[m.reply_to]) replyCounts.set(m.reply_to, (replyCounts.get(m.reply_to) || 0) + 1);
    const draftSig = sig(draft);
    const key = JSON.stringify([requests.map(r => [r.id, r.agent, r.createdAt, store.messages.get(r.id)?.read_at || 0, replyCounts.get(r.id) || 0]), replies.map(r => r.reply.id), draftSig, baselineSig, Math.floor(Date.now() / 60000), store.agents.length]);
    if (key === memo.requests) return;
    memo.requests = key;
    const parsed = new Set(replies.map(r => r.requestId));
    let fresh = 0;
    keepFocus(requestsBox, () => {
      const nodes = [];
      if (replies.length) {
        nodes.push(h('h4.av-req-title', 'Designs from agents'));
        for (const reply of replies.slice(0, 6)) {
          const specSig = sig(withName(reply.spec));
          const applied = specSig === baselineSig;
          const previewing = !applied && specSig === draftSig;
          if (!applied && !previewing) fresh++;
          const agent = agentByAddress(reply.agent);
          const note = replyNote(reply.reply.body);
          nodes.push(h(`article.av-result${!applied && !previewing ? '.fresh' : ''}`,
            portrait(reply.spec, { size: 56, provider: agent?.provider }),
            h('div.av-result-body',
              h('strong', `${agentName(reply.agent)} designed an avatar`),
              h('span.muted', `${timeAgo(reply.reply.created_at)} · ${summary(reply.spec)}`),
              note ? h('p.av-result-note', { title: note }, note) : null,
              h('div.av-result-actions',
                h('button.btn.small', { type: 'button', dataset: { key: `preview:${reply.reply.id}` }, disabled: previewing || applied, onclick: () => previewReply(reply) }, icon('eye'), previewing ? 'Previewing' : 'Preview'),
                h('button.btn.small.primary', { type: 'button', dataset: { key: `apply:${reply.reply.id}` }, disabled: applied, onclick: () => applyReply(reply) }, applied ? [icon('check'), 'Applied'] : 'Apply & save'),
                h('button.btn.small.ghost', { type: 'button', dataset: { key: `dismiss:${reply.requestId}` }, title: 'Remove this request and its designs from the list', onclick: () => dismissRequest(reply.requestId) }, 'Dismiss')))));
        }
      }
      const waiting = requests.filter(r => !parsed.has(r.id)).slice(0, 6);
      if (waiting.length) {
        nodes.push(h('h4.av-req-title', 'Requests'));
        for (const r of waiting) {
          const agent = agentByAddress(r.agent);
          const replied = (replyCounts.get(r.id) || 0) > 0;
          const seen = Boolean(store.messages.get(r.id)?.read_at);
          nodes.push(h(`div.av-pending${replied ? '.replied' : ''}`,
            agent ? portrait(agent.look, { size: 28, provider: agent.provider, status: agent.status }) : h('span.av-pending-dot'),
            h('div.av-pending-text',
              h('strong', agentName(r.agent)),
              h('span.muted', replied ? 'Replied without an avatar design. Open the chat to see what they said.' : `Sent ${timeAgo(r.createdAt)} · ${seen ? 'seen, waiting for reply' : 'waiting for reply'}`)),
            replied
              ? h('button.btn.small', { type: 'button', dataset: { key: `chat:${r.id}` }, onclick: () => navigate('chat', { thread: `mail:${r.agent}` }) }, 'Open chat')
              : h('span.spinner.av-pending-spin', { title: 'Waiting for the agent' }),
            iconButton('close', 'Dismiss request', () => dismissRequest(r.id), 'av-pending-dismiss')));
          nodes[nodes.length - 1].querySelector('.av-pending-dismiss').dataset.key = `dismiss:${r.id}`;
        }
      }
      clear(requestsBox, nodes);
    });
    agentBadge.hidden = !fresh;
    agentBadge.textContent = String(fresh);
  }

  /* ---------------- editor (right) ---------------- */
  const nameInput = h('input.input', { type: 'text', maxLength: 40, placeholder: 'Your name', 'aria-label': 'Avatar name', autocomplete: 'off', spellcheck: false, oninput: event => edit('name', event.currentTarget.value) });
  syncers.push(force => { if (force || document.activeElement !== nameInput) nameInput.value = draft.name; });
  const sameAsHair = h('button.av-link-btn', { type: 'button', onclick: () => edit('facialHair.color', draft.hair.color) }, 'Same as hair');
  const pct = (words) => value => `${words[value < 0.96 ? 0 : value > 1.04 ? 2 : 1]} · ${Math.round(value * 100)}%`;

  const sections = [
    section('photo', 'Start from a photo', 'camera', 'Match your skin, hair, facial hair and shirt in one click.',
      photoBody,
      h('p.field-hint.av-privacy', icon('av-lock'), h('span', 'Your photo stays on this PC. If you ask an agent to build your avatar, the photo is saved to the board\'s attachments folder so that agent can open it.'))),
    section('agent', 'Have an agent build it', 'agents', 'Ask Claude or Codex to design it in a chat right now, or send your photo to a board agent, which replies when it next checks the board.',
      designBox,
      h('div.av-design-sep', h('span', 'or send your photo to a board agent')),
      agentList, h('div.av-send-row', sendBtn), sendHint, requestsBox,
      h('p.field-hint.av-agent-note', icon('clock'), h('span', 'Agents reply when they next check their inbox. Each agent has its own schedule and sending does not wake it, so this is not instant. A reply is a suggestion: nothing changes until you preview or apply it.'))),
    section('basics', 'Name & skin', 'av-drop', null,
      field('Name', nameInput),
      colorField('Skin tone', 'skin', SKIN)),
    section('hair', 'Hair', 'av-hair', null,
      field('Style', chips('hair.style', 'hair', HAIR_STYLES, { label: 'Hair style', preview: true })),
      colorField('Hair color', 'hair.color', HAIR)),
    section('face', 'Face', 'av-face', null,
      field('Eyes', chips('eyes.style', 'eyes', EYE_STYLES, { label: 'Eye style', preview: true })),
      colorField('Eye color', 'eyes.color', EYE_COLORS),
      field('Mouth', chips('mouth', 'mouth', MOUTHS, { label: 'Mouth', preview: true })),
      slider('Blush', 'blush', { min: 0, max: 1, format: v => (v < 0.05 ? 'None' : `${Math.round(v * 100)}%`) }),
      slider('Brows', 'brows.thickness', { min: 0, max: 1, format: v => (v < 0.34 ? 'Fine' : v > 0.66 ? 'Bold' : 'Medium') }),
      field('Facial hair', chips('facialHair.style', 'facialHair', FACIAL_HAIR, { label: 'Facial hair', preview: true })),
      colorField('Facial hair color', 'facialHair.color', HAIR, sameAsHair)),
    section('outfit', 'Outfit', 'av-tee', null,
      field('Top', chips('top.style', 'top', TOPS, { label: 'Top style', icons: TOP_ICONS })),
      colorField('Top color', 'top.color', CLOTHES),
      colorField('Accent color', 'top.accent', ACCENTS),
      field('Emblem', chips('top.emblem', 'emblem', EMBLEMS, { label: 'Emblem', icons: EMBLEM_ICONS })),
      field('Bottoms', chips('bottom.style', 'bottom', BOTTOMS, { label: 'Bottoms style', icons: BOTTOM_ICONS })),
      colorField('Bottoms color', 'bottom.color', BOTTOM_COLORS),
      colorField('Shoes', 'shoes.color', SHOE_COLORS)),
    section('extras', 'Accessory', 'av-glasses', null,
      field('Style', chips('accessory', 'accessory', ACCESSORIES, { label: 'Accessory', preview: true })),
      colorField('Accessory color', 'accessoryColor', ACCESSORY_COLORS)),
    section('build', 'Build', 'av-ruler', null,
      slider('Height', 'build.height', { min: 0.85, max: 1.15, format: pct(['Short', 'Average', 'Tall']) }),
      slider('Width', 'build.width', { min: 0.85, max: 1.2, format: pct(['Slim', 'Average', 'Broad']) })),
  ];
  const navButtons = SECTIONS.map(([id, text]) => h('button.av-nav-item', { type: 'button', dataset: { target: id }, onclick: () => jump(id) }, text, id === 'agent' ? agentBadge : null));
  const nav = h('nav.av-nav', { 'aria-label': 'Avatar sections' }, navButtons);
  const scroller = h('div.av-scroll', sections);

  function jump(id) {
    const target = sections.find(s => s.dataset.section === id);
    target?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
  }
  let navQueued = false;
  function updateNav() {
    navQueued = false;
    const line = nav.getBoundingClientRect().bottom + 48;
    let active = SECTIONS[0][0];
    for (const s of sections) if (s.getBoundingClientRect().top <= line) active = s.dataset.section;
    if (scroller.scrollHeight > scroller.clientHeight + 4 && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4) active = SECTIONS.at(-1)[0];
    for (const b of navButtons) { const on = b.dataset.target === active; b.classList.toggle('active', on); if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); }
  }
  const queueNav = () => { if (!navQueued) { navQueued = true; requestAnimationFrame(updateNav); } };
  scroller.addEventListener('scroll', queueNav, { passive: true });
  root.addEventListener('scroll', queueNav, { passive: true });

  /* ---------------- footer ---------------- */
  const diceBtn = h('button.btn.ghost.small.av-dice', { type: 'button', title: 'Randomize everything except your name', onclick: randomize }, icon('dice'), h('span', 'Randomize'));
  const resetBtn = iconButton('av-undo', 'Reset (discard unsaved changes)', () => replaceDraft(store.avatar || defaultAvatar()));
  const importBtn = iconButton('av-upload', 'Import avatar JSON', () => jsonInput.click());
  const exportBtn = iconButton('copy', 'Export avatar JSON (copies to clipboard)', () => copyText(JSON.stringify(normalizeAvatar(draft), null, 2), 'Avatar JSON copied'));
  const footPortrait = h('span.av-foot-portrait');
  const unsavedText = h('span.visually-hidden');
  const unsavedNote = h('span.av-unsaved', { role: 'status' }, unsavedText);
  const saveLabel = h('span');
  const saveIcon = h('span.av-save-icon');
  const saveBtn = h('button.btn.gradient.av-save', { type: 'button', onclick: () => commitSave(normalizeAvatar(draft)) }, saveIcon, saveLabel);
  const footer = h('footer.av-footer', h('div.av-foot-tools', diceBtn, resetBtn, importBtn, exportBtn), h('div.av-foot-save', unsavedNote, footPortrait, saveBtn));

  function updateFooter() {
    const dirty = isDirty(), hasSaved = Boolean(store.avatar);
    resetBtn.disabled = !dirty;
    const done = hasSaved && !dirty;
    saveBtn.disabled = done;
    saveBtn.classList.toggle('done', done);
    clear(saveIcon, done ? icon('check') : null);
    saveLabel.textContent = done ? 'Saved' : 'Save';
    saveBtn.title = done ? 'Your avatar is saved' : 'Save your avatar (Ctrl+S)';
    unsavedNote.hidden = !dirty && hasSaved;
    unsavedNote.classList.toggle('never', !dirty && !hasSaved);
    unsavedNote.title = unsavedText.textContent = dirty ? 'Unsaved changes' : hasSaved ? '' : 'Not saved yet';
  }
  function commitSave(spec) {
    store.saveAvatar(spec);
    draft = normalizeAvatar(spec);
    baselineSig = sig(spec);
    saveBtn.classList.remove('just-saved'); void saveBtn.offsetWidth; saveBtn.classList.add('just-saved');
    clearTimeout(savedPulse); savedPulse = setTimeout(() => saveBtn.classList.remove('just-saved'), 900);
    if (!reduced()) stage?.greet(1800);
    scheduleFlush(true);
  }
  function randomize() {
    replaceDraft(randomSpec(draft));
    diceBtn.classList.remove('rolling'); void diceBtn.offsetWidth; diceBtn.classList.add('rolling');
  }
  async function importJson(file) {
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('too large');
      let data = JSON.parse(await file.text());
      if (data && typeof data === 'object' && data.avatar && typeof data.avatar === 'object') data = data.avatar;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
      replaceDraft(normalizeAvatar(data));
      toast(`Imported “${normalizeAvatar(data).name}”. It is not saved yet.`, { kind: 'success' });
    } catch { toast('That file is not a valid avatar JSON.', { kind: 'error' }); }
  }

  /* ---------------- page ---------------- */
  root.classList.add('av-root');
  const dropOverlay = h('div.av-drop-overlay', { 'aria-hidden': 'true' }, icon('image'), 'Drop your photo to start');
  root.append(h('div.av-page',
    h('h1.visually-hidden', 'My avatar'),
    h('div.av-stage-col', stageCard),
    h('div.av-editor.card', nav, scroller, footer),
    dropOverlay, photoInput, jsonInput));

  const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;
  root.addEventListener('dragenter', event => { if (!hasFiles(event)) return; event.preventDefault(); dragDepth++; root.classList.add('av-dragging'); });
  root.addEventListener('dragover', event => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
  root.addEventListener('dragleave', event => { if (!hasFiles(event)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) root.classList.remove('av-dragging'); });
  root.addEventListener('drop', event => {
    if (!hasFiles(event)) return;
    event.preventDefault(); dragDepth = 0; root.classList.remove('av-dragging');
    const files = [...event.dataTransfer.files];
    const image = files.find(f => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name));
    const json = files.find(f => /\.json$/i.test(f.name) || f.type === 'application/json');
    if (image) { setPhoto(image); jump('photo'); } else if (json) importJson(json); else toast('Drop an image (JPG, PNG or WebP) or an avatar JSON file.', { kind: 'error' });
  });
  function onKeydown(event) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!saveBtn.disabled) commitSave(normalizeAvatar(draft));
    }
  }

  /* ---------------- store sync ---------------- */
  function refreshDynamic() {
    dynamicQueued = false;
    if (!shown) return;
    const savedSig = sig(store.avatar || defaultAvatar());
    if (savedSig !== baselineSig) {
      const wasClean = sig(draft) === baselineSig;
      baselineSig = savedSig;
      if (wasClean) replaceDraft(store.avatar || defaultAvatar());
    }
    const nowReduced = reduced();
    if (nowReduced !== lastReduced) {
      lastReduced = nowReduced; autoRotate = !nowReduced;
      rotateBtn.setAttribute('aria-pressed', String(autoRotate));
      stage?.setAutoRotate(autoRotate);
    }
    stage?.setQuality(store.prefs.cityQuality === 'low' ? 'low' : 'high');
    renderAgents(); renderAgentSend(); renderRequests(); updateFooter();
    if (design?.state === 'waiting') checkDesign();
  }
  store.on('change', () => {
    if (!shown || dynamicQueued) return;
    dynamicQueued = true;
    requestAnimationFrame(refreshDynamic);
  });

  renderPhoto();
  scheduleFlush(true);

  return {
    show() {
      if (!isDirty()) draft = normalizeAvatar(store.avatar || defaultAvatar());
      baselineSig = sig(store.avatar || defaultAvatar());
      shown = true;
      document.addEventListener('paste', onPaste);
      document.addEventListener('keydown', onKeydown);
      refreshDynamic();
      scheduleFlush(true);
      ensureStage();
      updateStageActive();
      if (stage && !greeted && !reduced()) { greeted = true; stage.greet(2600); }
      queueNav();
    },
    hide() {
      shown = false;
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('keydown', onKeydown);
      updateStageActive();
    },
  };
}

/* ======================================================================== */
/* 3D turntable stage: grass island, soft rim light, the owner's little person. */
const FOV = 30;
async function createStage(host, { spec, quality }) {
  const [{ THREE, toonMaterial, addOutline }, { OrbitControls }, people] = await Promise.all([
    import('../city/toon.js'),
    import('../../vendor/three/addons/OrbitControls.js'),
    import('../city/people.js'),
  ]);
  if (typeof people.createPerson !== 'function') throw new Error('3D people are not available.');

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  const pixelRatio = q => Math.min(window.devicePixelRatio || 1, q === 'low' ? 1.25 : 2);
  let currentQuality = quality;
  let raf = 0, last = 0, elapsed = 0;
  renderer.setPixelRatio(pixelRatio(quality));
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.classList.add('av-canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Your avatar in 3D. Drag or use the arrow keys to turn, plus and minus to zoom, Enter to wave.');
  host.append(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 80);
  scene.add(new THREE.HemisphereLight('#ffffff', '#6d62a8', 1.35));
  const key = new THREE.DirectionalLight('#fff3e6', 2.3); key.position.set(2.5, 4.5, 3.5); scene.add(key);
  const rim = new THREE.DirectionalLight('#b9a9ff', 2.2); rim.position.set(-3, 2.6, -3.6); scene.add(rim);
  const fill = new THREE.DirectionalLight('#9fe7d6', 0.7); fill.position.set(3.5, 1.2, -2); scene.add(fill);

  const blob = blobTexture(THREE);
  scene.add(buildPlatform(THREE, toonMaterial, addOutline));
  const groundShadow = shadowPlane(THREE, blob, 3.9, 1.5, 0.5); groundShadow.position.y = -0.62; scene.add(groundShadow);
  const footShadow = shadowPlane(THREE, blob, 0.95, 0.75, 0.85); footShadow.position.y = 0.006; scene.add(footShadow);

  const person = people.createPerson(spec, { role: 'owner', provider: 'other', quality });
  person.setStatus?.(null);
  scene.add(person.object);

  let targetY = 0.86 * spec.build.height;
  const controls = new OrbitControls(camera, canvas);
  Object.assign(controls, { enablePan: false, enableDamping: true, dampingFactor: 0.08, rotateSpeed: 0.75, zoomSpeed: 0.7, minPolarAngle: 0.95, maxPolarAngle: 1.62, autoRotateSpeed: 1.6 });
  controls.target.set(0, targetY, 0);
  const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const fitDistance = aspect => Math.max(2.55 / (2 * tan), 3.2 / (2 * tan * Math.max(aspect, 0.3)));
  let fit = fitDistance(1.2);
  const home = () => { camera.position.setFromSphericalCoords(fit, 1.3, 0.45).add(controls.target); controls.update(); };
  home();

  let wantAuto = true, resumeTimer = 0;
  const pauseAuto = (ms = 3500) => { controls.autoRotate = false; clearTimeout(resumeTimer); resumeTimer = setTimeout(() => { controls.autoRotate = wantAuto; }, ms); };
  controls.addEventListener('start', () => { controls.autoRotate = false; clearTimeout(resumeTimer); });
  controls.addEventListener('end', () => pauseAuto());

  let baseAction = 'stand', waveTimer = 0;
  const greet = (ms = 2200) => {
    clearTimeout(waveTimer);
    person.setAction('wave');
    waveTimer = setTimeout(() => { waveTimer = 0; person.setAction(baseAction); }, ms);
  };

  function setDistance(distance) {
    const offset = camera.position.clone().sub(controls.target);
    offset.setLength(Math.min(controls.maxDistance, Math.max(controls.minDistance, distance)));
    camera.position.copy(controls.target).add(offset);
    controls.update();
  }
  function resize() {
    const w = host.clientWidth, hgt = host.clientHeight;
    if (!w || !hgt) return;
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt; camera.updateProjectionMatrix();
    const ratio = camera.position.distanceTo(controls.target) / fit;
    fit = fitDistance(camera.aspect);
    controls.minDistance = fit * 0.55; controls.maxDistance = fit * 1.5;
    setDistance(fit * ratio);
    if (!raf) renderer.render(scene, camera);
  }
  new ResizeObserver(resize).observe(host);

  /* Keyboard: turn, zoom, wave. */
  const up = new THREE.Vector3(0, 1, 0);
  canvas.addEventListener('keydown', event => {
    const turn = { ArrowLeft: 0.3, ArrowRight: -0.3 }[event.key];
    const zoom = { ArrowUp: 0.88, '+': 0.88, '=': 0.88, ArrowDown: 1.12, '-': 1.12 }[event.key];
    if (turn) { const offset = camera.position.clone().sub(controls.target).applyAxisAngle(up, turn); camera.position.copy(controls.target).add(offset); controls.update(); pauseAuto(); }
    else if (zoom) setDistance(camera.position.distanceTo(controls.target) * zoom);
    else if (event.key === 'Enter' || event.key === ' ') greet();
    else return;
    event.preventDefault();
  });

  /* Click the person to wave; hover highlights them. */
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  const pickables = () => (person.pickable?.length ? person.pickable : [person.object]);
  const hitPerson = event => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(pickables(), true).length > 0;
  };
  let down = null, hovering = false;
  canvas.addEventListener('pointerdown', event => { down = { x: event.clientX, y: event.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', event => {
    if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 5 && performance.now() - down.t < 450 && hitPerson(event)) greet();
    down = null;
  });
  canvas.addEventListener('pointermove', event => {
    if (event.buttons) return;
    const over = hitPerson(event);
    if (over !== hovering) { hovering = over; person.setHighlight?.(over); canvas.classList.toggle('over-person', over); }
  });
  canvas.addEventListener('pointerleave', () => { if (hovering) { hovering = false; person.setHighlight?.(false); canvas.classList.remove('over-person'); } });

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now; elapsed += dt;
    const dy = (targetY - controls.target.y) * Math.min(1, dt * 6);
    controls.target.y += dy; camera.position.y += dy;
    controls.update(dt);
    try { person.update(dt, elapsed); } catch { /* keep rendering */ }
    renderer.render(scene, camera);
  }

  return {
    setSpec(next) {
      person.setSpec(next);
      targetY = 0.86 * next.build.height;
      footShadow.scale.set(next.build.width, 1, 1);
      if (!raf) renderer.render(scene, camera);
    },
    setAction(id) { baseAction = id; if (!waveTimer) person.setAction(id); },
    greet,
    setAutoRotate(on) { wantAuto = on; clearTimeout(resumeTimer); controls.autoRotate = on; },
    resetView() { home(); pauseAuto(2500); },
    setQuality(q) { if (q !== currentQuality) { currentQuality = q; renderer.setPixelRatio(pixelRatio(q)); resize(); } },
    setActive(on) {
      if (on && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
      else if (!on && raf) { cancelAnimationFrame(raf); raf = 0; }
    },
  };
}

function blobTexture(THREE) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const gradient = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(22,16,44,0.6)'); gradient.addColorStop(0.55, 'rgba(22,16,44,0.24)'); gradient.addColorStop(1, 'rgba(22,16,44,0)');
  g.fillStyle = gradient; g.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
function shadowPlane(THREE, map, w, d, opacity) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, opacity }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.userData.noOutline = true;
  mesh.raycast = () => {};
  return mesh;
}
/** A round grass island with a dirt skirt, tufts, flowers and pebbles (top surface at y = 0). */
function buildPlatform(THREE, toonMaterial, addOutline) {
  const group = new THREE.Group();
  const grass = toonMaterial('#86d46b'), grassSide = toonMaterial('#62b552'), dirt = toonMaterial('#9a6a45'), dirtDark = toonMaterial('#76503a');
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 0.98, 0.4, 48), [dirt, grass, dirtDark]);
  base.position.y = -0.24;
  const lip = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.28, 0.1, 48), [grassSide, grass, grassSide]);
  lip.position.y = -0.05;
  group.add(base, lip);
  const at = (angle, radius, y = 0) => new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
  const tuftGeo = new THREE.ConeGeometry(0.035, 0.15, 5), tuftMat = toonMaterial('#57a64a');
  for (const [angle, radius] of [[0.6, 1.0], [2.3, 0.92], [3.9, 1.05], [5.2, 0.86], [1.7, 1.12]]) {
    for (const [dx, dz, s] of [[0, 0, 1], [0.05, 0.03, 0.8], [-0.04, 0.04, 0.7]]) {
      const tuft = new THREE.Mesh(tuftGeo, tuftMat);
      tuft.position.copy(at(angle, radius, 0.07 * s)).add(new THREE.Vector3(dx, 0, dz));
      tuft.scale.setScalar(s); tuft.rotation.z = dx * 3;
      group.add(tuft);
    }
  }
  const stemGeo = new THREE.CylinderGeometry(0.009, 0.009, 0.12, 5), headGeo = new THREE.SphereGeometry(0.042, 10, 8), stemMat = toonMaterial('#4f9a43');
  for (const [angle, radius, color] of [[1.2, 1.08, '#ffd166'], [2.9, 1.1, '#ff8fab'], [4.6, 1.0, '#ffffff'], [5.8, 1.12, '#b8a8ff'], [0.15, 0.9, '#ff8fab']]) {
    const stem = new THREE.Mesh(stemGeo, stemMat); stem.position.copy(at(angle, radius, 0.06));
    const head = new THREE.Mesh(headGeo, toonMaterial(color)); head.position.copy(at(angle, radius, 0.13));
    group.add(stem, head);
  }
  const pebbleGeo = new THREE.SphereGeometry(0.07, 10, 8), pebbleMat = toonMaterial('#b9b4c7');
  for (const [angle, radius, s] of [[0.35, 1.12, 1], [3.4, 0.98, 0.8], [4.2, 1.15, 0.6]]) {
    const pebble = new THREE.Mesh(pebbleGeo, pebbleMat);
    pebble.position.copy(at(angle, radius, 0.015)); pebble.scale.set(s, s * 0.55, s * 0.8);
    group.add(pebble);
  }
  addOutline(group, { thickness: 0.025 });
  group.traverse(node => { if (node.isMesh) node.raycast = () => {}; });
  return group;
}
