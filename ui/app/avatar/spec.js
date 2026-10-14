/* Avatar spec: the single shared description of a little person. Used by the
 * 3D city (city/people.js), the 2D portrait chip (ui.js) and the avatar builder.
 * Specs are plain JSON so agents can author them in a mailbox reply. */

export const HAIR_STYLES = ['short', 'messy', 'buzz', 'curly', 'long', 'ponytail', 'bun', 'mohawk', 'bald'];
export const FACIAL_HAIR = ['none', 'stubble', 'mustache', 'mustache-stubble', 'goatee', 'beard'];
export const EYE_STYLES = ['round', 'happy', 'sleepy'];
export const MOUTHS = ['smile', 'grin', 'neutral'];
export const TOPS = ['tee', 'hoodie', 'jacket', 'sweater', 'tank'];
export const BOTTOMS = ['jeans', 'joggers', 'shorts', 'skirt'];
export const EMBLEMS = ['none', 'claude', 'codex', 'star', 'heart', 'bolt'];
export const ACCESSORIES = ['none', 'glasses', 'sunglasses', 'cap', 'beanie', 'headphones', 'crown'];

export const SKIN_TONES = ['#f6d7c3', '#efc3a4', '#e7b49b', '#d9a07c', '#c68863', '#a86b4a', '#8a5236', '#6b3d27', '#4a2a1b'];
export const HAIR_COLORS = ['#0f0c0b', '#2b1d16', '#3b2a20', '#5a3a26', '#8a5a33', '#b07a45', '#d9b26a', '#e8d6a8', '#b8b8b8', '#c44b2b', '#5b6cff', '#ff6fae'];

/** Schema version 1. Every field is required after normalize(). */
export function defaultAvatar() {
  return {
    version: 1,
    name: 'You',
    skin: '#e7b49b',
    blush: 0.3,
    hair: { style: 'short', color: '#3b2a20' },
    facialHair: { style: 'none', color: '#3b2a20' },
    eyes: { color: '#4b6a80', style: 'round' },
    brows: { thickness: 0.5 },
    mouth: 'smile',
    top: { style: 'tee', color: '#2f6fed', accent: '#ffffff', emblem: 'star' },
    bottom: { style: 'jeans', color: '#2e3a4f' },
    shoes: { color: '#25262b' },
    accessory: 'none',
    accessoryColor: '#222222',
    build: { height: 1, width: 1 },
  };
}

const isColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const pick = (value, list, fallback) => (list.includes(value) ? value : fallback);
const color = (value, fallback) => (isColor(value) ? value.toLowerCase() : fallback);
const clamp = (value, min, max, fallback) => (Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback);

/** Accepts untrusted JSON (e.g. from an agent) and returns a complete, valid spec. */
export function normalizeAvatar(input) {
  const base = defaultAvatar();
  const v = input && typeof input === 'object' ? input : {};
  return {
    version: 1,
    name: typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 40) : base.name,
    skin: color(v.skin, base.skin),
    blush: clamp(v.blush, 0, 1, base.blush),
    hair: { style: pick(v.hair?.style, HAIR_STYLES, base.hair.style), color: color(v.hair?.color, base.hair.color) },
    facialHair: { style: pick(v.facialHair?.style, FACIAL_HAIR, base.facialHair.style), color: color(v.facialHair?.color, color(v.hair?.color, base.facialHair.color)) },
    eyes: { color: color(v.eyes?.color, base.eyes.color), style: pick(v.eyes?.style, EYE_STYLES, base.eyes.style) },
    brows: { thickness: clamp(v.brows?.thickness, 0, 1, base.brows.thickness) },
    mouth: pick(v.mouth, MOUTHS, base.mouth),
    top: { style: pick(v.top?.style, TOPS, base.top.style), color: color(v.top?.color, base.top.color), accent: color(v.top?.accent, base.top.accent), emblem: pick(v.top?.emblem, EMBLEMS, base.top.emblem) },
    bottom: { style: pick(v.bottom?.style, BOTTOMS, base.bottom.style), color: color(v.bottom?.color, base.bottom.color) },
    shoes: { color: color(v.shoes?.color, base.shoes.color) },
    accessory: pick(v.accessory, ACCESSORIES, base.accessory),
    accessoryColor: color(v.accessoryColor, base.accessoryColor),
    build: { height: clamp(v.build?.height, 0.85, 1.15, 1), width: clamp(v.build?.width, 0.85, 1.2, 1) },
  };
}

/** Small deterministic hash so the same agent always looks the same. */
export function hash(text) {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const PROVIDER_COLORS = {
  claude: { main: '#d97757', accent: '#fbe7dc', label: 'Claude' },
  codex: { main: '#10a37f', accent: '#d7f5ec', label: 'Codex' },
  other: { main: '#7c6cf2', accent: '#e8e5ff', label: 'Agent' },
};

/** A friendly, deterministic look for an agent NPC. Provider sets the uniform. */
export function agentAvatar(id, provider = 'other', name = '') {
  const h = hash(id);
  const at = (list, shift) => list[(h >>> shift) % list.length];
  const palette = PROVIDER_COLORS[provider] || PROVIDER_COLORS.other;
  const spec = defaultAvatar();
  spec.name = name || id;
  spec.skin = at(SKIN_TONES, 3);
  spec.hair = { style: at(['short', 'messy', 'curly', 'bun', 'ponytail', 'buzz', 'long', 'mohawk'], 7), color: at(HAIR_COLORS.slice(0, 10), 11) };
  spec.facialHair = { style: at(['none', 'none', 'none', 'stubble', 'mustache', 'beard'], 13), color: spec.hair.color };
  spec.eyes = { color: at(['#3b2f2a', '#4b6a80', '#3f6b45', '#5a4636'], 17), style: at(EYE_STYLES, 19) };
  spec.mouth = at(MOUTHS, 21);
  spec.top = provider === 'codex'
    ? { style: 'hoodie', color: palette.main, accent: '#0b2e26', emblem: 'codex' }
    : provider === 'claude'
      ? { style: 'jacket', color: palette.main, accent: palette.accent, emblem: 'claude' }
      : { style: 'sweater', color: palette.main, accent: palette.accent, emblem: 'bolt' };
  spec.bottom = { style: at(['jeans', 'joggers'], 23), color: at(['#2e3a4f', '#2b2b33', '#4a3f35'], 25) };
  spec.accessory = at(['none', 'none', 'glasses', 'headphones', 'beanie', 'cap'], 27);
  spec.accessoryColor = provider === 'codex' ? '#0b2e26' : '#3a2318';
  spec.build = { height: 0.92 + ((h >>> 5) % 17) / 100, width: 0.95 + ((h >>> 9) % 15) / 100 };
  return spec;
}
