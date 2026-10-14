/* Photo → avatar colors, entirely on this PC. The image is decoded into a small
 * (≤256px) canvas and sampled with robust (trimmed-median) statistics; nothing is
 * uploaded or sent anywhere. Results are a best guess the owner fine-tunes.
 *
 * analyzePhoto(file|Blob|ImageBitmap, { current }) →
 *   { spec: Partial<AvatarSpec>, notes: string[], matched: string[],
 *     regions: { face, samples: [{ label, x, y, w, h, color }] }, method }
 * Region coordinates are normalized 0..1 so callers can draw an overlay. */
import { SKIN_TONES, HAIR_COLORS } from './spec.js';

const MAX_SIDE = 256;

/** Decode an image file (EXIF orientation applied). Throws a friendly Error. */
export async function decodePhoto(file) {
  if (typeof ImageBitmap !== 'undefined' && file instanceof ImageBitmap) return file;
  if (!(file instanceof Blob)) throw new Error('Choose an image file.');
  if (file.type && !file.type.startsWith('image/')) throw new Error('That file is not an image.');
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('Could not read that image. Try a JPG, PNG or WebP photo.'); }
}

/* ---------- pixel helpers ---------- */
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const chroma = ([r, g, b]) => ({ cb: 128 - 0.168736 * r - 0.331264 * g + 0.5 * b, cr: 128 + 0.5 * r - 0.418688 * g - 0.081312 * b });
const sat = ([r, g, b]) => { const max = Math.max(r, g, b), min = Math.min(r, g, b); return max ? (max - min) / max : 0; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** YCbCr skin range: works across light and dark skin tones under normal light. */
function isSkin(p) {
  const y = lum(p), { cb, cr } = chroma(p);
  return y > 30 && y < 248 && cr >= 134 && cr <= 182 && cb >= 72 && cb <= 132 && p[0] >= p[2];
}
const isLipRed = p => chroma(p).cr > 162;
const hex = rgb => `#${rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const fromHex = value => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));

/** Trimmed mean between the lo..hi luminance quantiles (robust to glare and shadow). */
function robust(pixels, lo = 0.3, hi = 0.7) {
  if (!pixels.length) return null;
  const sorted = pixels.map(p => [lum(p), p]).sort((a, b) => a[0] - b[0]);
  const start = Math.min(sorted.length - 1, Math.floor(sorted.length * lo));
  const end = Math.max(start + 1, Math.min(sorted.length, Math.ceil(sorted.length * hi)));
  let r = 0, g = 0, b = 0;
  for (let i = start; i < end; i++) { r += sorted[i][1][0]; g += sorted[i][1][1]; b += sorted[i][1][2]; }
  const n = end - start;
  return [r / n, g / n, b / n];
}
function nearest(palette, rgb) {
  let best = palette[0], bestDist = Infinity;
  for (const value of palette) { const d = dist(fromHex(value), rgb); if (d < bestDist) { bestDist = d; best = value; } }
  return { hex: best, dist: bestDist };
}
/** Lighten (amount > 0) or darken a color in HSL lightness. */
function adjust(rgb, amount) {
  const [r, g, b] = rgb.map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = Math.max(0, Math.min(1, l + amount));
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const channel = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
}
const lightness = rgb => (Math.max(...rgb) + Math.min(...rgb)) / 510;

/* ---------- image access ---------- */
function rasterize(bitmap) {
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(8, Math.round(bitmap.width * scale)), h = Math.max(8, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { canvas, w, h, data: ctx.getImageData(0, 0, w, h).data };
}
function collect(img, box) {
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(img.w, Math.ceil(box.x + box.w)), y1 = Math.min(img.h, Math.ceil(box.y + box.h));
  const out = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * img.w + x) * 4;
    if (img.data[i + 3] < 200) continue; // transparent PNG areas
    out.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
  }
  return out;
}

async function detectFace(canvas) {
  if (typeof window === 'undefined' || typeof window.FaceDetector !== 'function') return null;
  try {
    const detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 4 });
    const faces = await Promise.race([detector.detect(canvas), new Promise(resolve => setTimeout(() => resolve(null), 2500))]);
    const best = (faces || []).map(f => f.boundingBox).filter(b => b && b.width >= 14 && b.height >= 14).sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!best) return null;
    // Detector boxes usually start around the brows; extend up toward the hairline.
    return { x: best.x, y: best.y - best.height * 0.12, w: best.width, h: best.height * 1.12 };
  } catch { return null; }
}

/** Centered head-and-shoulders guess, nudged sideways toward the skin-colored area. */
function assumedFace(img) {
  const fh = 0.33 * img.h, fw = Math.min(0.34 * img.w, 0.85 * fh);
  let cx = img.w / 2;
  const xs = [];
  const y0 = Math.round(img.h * 0.3), y1 = Math.round(img.h * 0.52), x0 = Math.round(img.w * 0.15), x1 = Math.round(img.w * 0.85);
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const i = (y * img.w + x) * 4;
    if (isSkin([img.data[i], img.data[i + 1], img.data[i + 2]])) xs.push(x);
  }
  if (xs.length > ((x1 - x0) * (y1 - y0)) / 4 * 0.06) {
    xs.sort((a, b) => a - b);
    cx = Math.max(img.w * 0.35, Math.min(img.w * 0.65, xs[xs.length >> 1]));
  }
  return { x: cx - fw / 2, y: 0.25 * img.h, w: fw, h: fh };
}

/** Analyze a portrait photo. `current` (optional) is the draft spec, used to avoid needless changes. */
export async function analyzePhoto(file, { current } = {}) {
  const bitmap = await decodePhoto(file);
  const img = rasterize(bitmap);
  const notes = [], matched = [], samples = [];
  const spec = {};

  const detected = await detectFace(img.canvas);
  const face = detected || assumedFace(img);
  const strict = !detected; // a guessed face box needs stronger evidence
  notes.push(detected ? 'Found your face with the built-in face detector.' : 'Assumed a centered head-and-shoulders photo.');
  const { x: fx, y: fy, w: fw, h: fh } = face;
  const cx = fx + fw / 2;
  const box = (x, y, w, h) => ({ x, y, w, h });
  const sample = (label, b, rgb) => samples.push({ label, x: b.x / img.w, y: b.y / img.h, w: b.w / img.w, h: b.h / img.h, color: rgb ? hex(rgb) : null });

  /* Skin: both cheeks, skin-colored pixels only, brighter-middle quantiles (lit skin). */
  const cheekL = box(cx - 0.36 * fw, fy + 0.52 * fh, 0.22 * fw, 0.18 * fh);
  const cheekR = box(cx + 0.14 * fw, fy + 0.52 * fh, 0.22 * fw, 0.18 * fh);
  const cheekPixels = [...collect(img, cheekL), ...collect(img, cheekR)];
  const skinPixels = cheekPixels.filter(isSkin);
  const skinShare = cheekPixels.length ? skinPixels.length / cheekPixels.length : 0;
  let skinRgb = null, skinY = 0;
  if (skinPixels.length >= 12 && skinShare >= 0.25) {
    skinRgb = robust(skinPixels, 0.45, 0.85);
    skinY = lum(robust(skinPixels, 0.3, 0.7));
    const snap = nearest(SKIN_TONES, skinRgb);
    spec.skin = snap.dist < 30 ? snap.hex : hex(skinRgb);
    matched.push('skin');
    notes.push(snap.dist < 30 ? 'Skin tone matched to the closest palette shade.' : 'Skin tone sampled from your cheeks.');
  } else {
    notes.push('Could not find clear skin on the cheeks (black-and-white photo, strong filter or off-center face?), so skin was left unchanged.');
  }
  sample('Skin', cheekL, skinRgb); sample('Skin', cheekR, skinRgb);

  /* Background: top corners, used to tell hair apart from the wall or sky. */
  const corner = Math.max(4, Math.round(Math.min(img.w, img.h) * 0.12));
  const bgPixels = [...collect(img, box(0, 0, corner, corner)), ...collect(img, box(img.w - corner, 0, corner, corner))];
  const bgRgb = bgPixels.length ? robust(bgPixels, 0.25, 0.75) : null;

  /* Hair: band just above the top of the face box. */
  const hairBox = box(cx - 0.48 * fw, fy - 0.24 * fh, 0.96 * fw, 0.3 * fh);
  const band = collect(img, hairBox);
  let skinLike = 0, bright = 0;
  const hairPixels = [];
  for (const p of band) {
    const y = lum(p);
    if (y > 236 || (y > 212 && sat(p) < 0.1)) bright++;
    else if (skinRgb && isSkin(p) && dist(p, skinRgb) < 55 && Math.abs(y - skinY) < 45) skinLike++;
    else hairPixels.push(p);
  }
  const n = Math.max(1, band.length);
  let hairRgb = null, hairStyle = null;
  if (skinLike / n > 0.55) {
    hairStyle = 'bald';
    notes.push('The top of your head looks bare, so the hair style is Bald.');
  } else if ((skinLike + bright) / n > 0.6 && hairPixels.length / n < 0.35) {
    hairStyle = 'buzz';
    notes.push('Very little hair above the forehead, so the hair style is Buzz.');
  }
  if (hairPixels.length >= 10 && hairStyle !== 'bald') {
    const candidate = robust(hairPixels, 0.2, 0.6);
    if (bgRgb && dist(candidate, bgRgb) < 32 && hairPixels.length / n > 0.7) {
      notes.push('Your hair blends into the background, so hair color was left unchanged.');
    } else {
      hairRgb = candidate;
      const snap = nearest(HAIR_COLORS, hairRgb);
      spec.hair = { color: snap.dist < 30 ? snap.hex : hex(hairRgb) };
      matched.push('hair');
    }
  }
  sample('Hair', hairBox, hairRgb);

  /* Long hair: hair-colored areas beside the lower face on both sides. */
  if (hairRgb && !hairStyle && !(bgRgb && dist(hairRgb, bgRgb) < 45)) {
    const sideL = box(fx - 0.38 * fw, fy + 0.55 * fh, 0.34 * fw, 0.6 * fh);
    const sideR = box(fx + fw * 1.04, fy + 0.55 * fh, 0.34 * fw, 0.6 * fh);
    const share = b => { const px = collect(img, b); return px.length ? px.filter(p => dist(p, hairRgb) < 42).length / px.length : 0; };
    if (share(sideL) > 0.45 && share(sideR) > 0.45) { hairStyle = 'long'; notes.push('Hair reaches past your jaw on both sides, so the hair style is Long.'); }
  }
  if (hairStyle) spec.hair = { ...spec.hair, style: hairStyle };
  else if (hairRgb && ['bald', 'buzz'].includes(current?.hair?.style)) spec.hair = { ...spec.hair, style: 'short' };

  /* Facial hair: darkening of the upper lip, chin and jaw compared to cheek skin. */
  if (skinRgb && skinY > 25) {
    const lip = box(cx - 0.16 * fw, fy + 0.72 * fh, 0.32 * fw, 0.07 * fh);
    const chin = box(cx - 0.17 * fw, fy + 0.88 * fh, 0.34 * fw, 0.11 * fh);
    const jawL = box(cx - 0.42 * fw, fy + 0.74 * fh, 0.16 * fw, 0.18 * fh);
    const jawR = box(cx + 0.26 * fw, fy + 0.74 * fh, 0.16 * fw, 0.18 * fh);
    const score = boxes => {
      const px = boxes.flatMap(b => collect(img, b)).filter(p => !isLipRed(p));
      if (px.length < 6) return { dark: 0, mild: 0, px };
      return { dark: px.filter(p => lum(p) < 0.62 * skinY).length / px.length, mild: px.filter(p => lum(p) < 0.8 * skinY).length / px.length, px };
    };
    const lipS = score([lip]), chinS = score([chin]), jawS = score([jawL, jawR]);
    const strongT = strict ? 0.38 : 0.3, mildT = strict ? 0.5 : 0.4;
    const strong = s => s.dark > strongT, mild = s => s.mild > mildT;
    let style = 'none';
    if (strong(chinS) && (strong(lipS) || strong(jawS))) style = 'beard';
    else if (strong(lipS)) style = mild(chinS) || mild(jawS) ? 'mustache-stubble' : 'mustache';
    else if (strong(chinS)) style = 'goatee';
    else if (mild(lipS) && mild(chinS) && mild(jawS)) style = 'stubble';
    let color = hairRgb;
    if (!color && style !== 'none') {
      const dark = [...lipS.px, ...chinS.px, ...jawS.px].filter(p => lum(p) < 0.7 * skinY);
      color = dark.length >= 6 ? robust(dark, 0.2, 0.6) : null;
    }
    const colorHex = color ? (nearest(HAIR_COLORS, color).dist < 30 ? nearest(HAIR_COLORS, color).hex : hex(color)) : undefined;
    spec.facialHair = colorHex ? { style, color: colorHex } : { style };
    matched.push('facial hair');
    notes.push({
      none: 'No facial hair spotted.', stubble: 'Light stubble spotted.', mustache: 'Mustache spotted.',
      'mustache-stubble': 'Mustache with stubble spotted.', goatee: 'Goatee spotted.', beard: 'Beard spotted.',
    }[style] + (strict ? ' (A guess; check the Face section.)' : ''));
    sample('Lip', lip, null); sample('Chin', chin, null);
  } else {
    notes.push('Facial hair was left unchanged because the face was not clear enough.');
  }

  /* Shirt: bottom-center of the photo. */
  const shirtBox = box(img.w * 0.3, img.h * 0.82, img.w * 0.4, img.h * 0.16);
  const shirtPixels = collect(img, shirtBox);
  const bareShare = shirtPixels.length ? shirtPixels.filter(p => skinRgb && isSkin(p) && dist(p, skinRgb) < 50).length / shirtPixels.length : 1;
  let shirtRgb = null;
  if (shirtPixels.length >= 12 && bareShare < 0.6) {
    shirtRgb = robust(shirtPixels, 0.25, 0.75);
    spec.top = { color: hex(shirtRgb), accent: hex(adjust(shirtRgb, lightness(shirtRgb) < 0.75 ? 0.16 : -0.2)) };
    matched.push('shirt');
    notes.push('Shirt color taken from the bottom of the photo.');
  } else {
    notes.push('No shirt visible at the bottom of the photo, so the outfit was left unchanged.');
  }
  sample('Shirt', shirtBox, shirtRgb);

  return {
    spec, notes, matched, method: detected ? 'face-detector' : 'assumed',
    regions: { face: { x: fx / img.w, y: fy / img.h, w: fw / img.w, h: fh / img.h }, samples },
  };
}

/** "skin, hair, facial hair and shirt colors" style summary of `matched`. */
export function describeMatch(matched) {
  if (!matched.length) return '';
  const list = matched.length === 1 ? matched[0] : `${matched.slice(0, -1).join(', ')} and ${matched.at(-1)}`;
  return `Matched ${list}${matched.some(m => m !== 'facial hair') ? ' colors' : ''}`;
}
