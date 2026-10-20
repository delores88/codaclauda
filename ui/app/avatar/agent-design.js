/* Agent-built avatars, end to end (0.5): the prompt a Claude Code or Codex session gets, and how its
 * reply becomes a spec. The reply is untrusted text: only the FIRST JSON block in it is read, it must
 * look like an avatar, and normalizeAvatar (spec.js) clamps every field. Pure: node tests import it. */
import {
  normalizeAvatar, HAIR_STYLES, FACIAL_HAIR, EYE_STYLES, MOUTHS, TOPS, BOTTOMS, EMBLEMS, ACCESSORIES, SKIN_TONES, HAIR_COLORS,
} from './spec.js';

const KNOWN = ['name', 'skin', 'blush', 'hair', 'facialHair', 'eyes', 'brows', 'mouth', 'top', 'bottom', 'shoes', 'accessory', 'accessoryColor', 'build'];
const list = values => values.map(v => `"${v}"`).join(' | ');

/** The first turn of the design chat. draft: the current (normalized) spec; description: what Ben
 *  typed (optional); photo: a photo is attached. */
export function designPrompt(draft, { description = '', photo = false } = {}) {
  const spec = normalizeAvatar(draft);
  const wish = String(description || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  return [
    'Please design my avatar for the CodaClauda City (a small cartoon person).',
    `This is a design task only: do not change any files or run commands${photo ? ' (the attached photo is the only file to open)' : ''}. Reply with ONE fenced \`\`\`json code block holding the avatar spec below, then at most two short sentences about your choices.`,
    photo ? 'A photo of me is attached: match my skin tone, hair style and colour, facial hair and clothes as closely as the options allow.' : null,
    wish ? `What I'd like: ${wish}` : null,
    '',
    'Avatar spec (version 1). Colours are "#rrggbb" hex strings. Allowed values:',
    `- skin: a hex colour (typical: ${SKIN_TONES.join(', ')}); blush: 0 to 1`,
    `- hair: { style: ${list(HAIR_STYLES)}, color: hex (typical: ${HAIR_COLORS.slice(0, 9).join(', ')}) }`,
    `- facialHair: { style: ${list(FACIAL_HAIR)}, color: hex }`,
    `- eyes: { style: ${list(EYE_STYLES)}, color: hex }; brows: { thickness: 0 to 1 }; mouth: ${list(MOUTHS)}`,
    `- top: { style: ${list(TOPS)}, color: hex, accent: hex, emblem: ${list(EMBLEMS)} }`,
    `- bottom: { style: ${list(BOTTOMS)}, color: hex }; shoes: { color: hex }`,
    `- accessory: ${list(ACCESSORIES)}; accessoryColor: hex`,
    '- build: { height: 0.85 to 1.15, width: 0.85 to 1.2 }; name: keep mine',
    '',
    'My current avatar, to start from:',
    '```json',
    JSON.stringify(spec, null, 2),
    '```',
  ].filter(line => line !== null).join('\n');
}

/** The first balanced {...} starting at index i (strings and escapes respected), or ''. */
function balanced(text, i) {
  let depth = 0, inString = false, escaped = false;
  for (let k = i; k < text.length; k++) {
    const c = text[k];
    if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(i, k + 1);
  }
  return '';
}

/** The first JSON block of a reply: the first fenced code block when the reply has one, else the
 *  first balanced {...} object. → { value } | { error } (error: 'none' | 'invalid'). */
export function firstJsonBlock(text) {
  const s = String(text || '');
  const fence = /```[ \t]*([a-z0-9_-]*)[^\n]*\n([\s\S]*?)```/i.exec(s);
  let raw = '';
  if (fence) raw = fence[2].trim();
  else { const start = s.indexOf('{'); raw = start >= 0 ? balanced(s, start) : ''; }
  if (!raw) return { error: 'none' };
  try { return { value: JSON.parse(raw) }; }
  catch {
    // A fence with prose around the object inside it: try the object itself.
    const start = raw.indexOf('{'), inner = start >= 0 ? balanced(raw, start) : '';
    if (inner && inner !== raw) { try { return { value: JSON.parse(inner) }; } catch { /* below */ } }
    return { error: 'invalid' };
  }
}

/** A reply → { spec } (normalized) | { error: a sentence to show }. Accepts { avatar: {...} } too. */
export function avatarFromReply(text) {
  const block = firstJsonBlock(text);
  if (block.error === 'none') return { error: "The reply has no JSON avatar spec in it." };
  if (block.error) return { error: "The reply's first JSON block isn't valid JSON." };
  let value = block.value;
  if (value && typeof value === 'object' && !Array.isArray(value) && value.avatar && typeof value.avatar === 'object') value = value.avatar;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: "The reply's first JSON block isn't an avatar spec." };
  const hits = KNOWN.filter(key => key in value).length;
  if (hits < 3) return { error: "The reply's JSON doesn't look like an avatar spec (too few avatar fields)." };
  return { spec: normalizeAvatar(value) };
}
