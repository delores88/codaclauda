/* City weather model. Pure (no DOM, no network): MET Norway symbol codes → the scene the City
 * draws, manual picks, what each scene looks like, temperature units by locale, HUD text, poll
 * timing, saved preferences and the time-zone default location. Checked in tests/weather.test.mjs.
 * Live data: MET Norway (CC BY 4.0). Place search: © OpenStreetMap contributors (ODbL). */

export const KINDS = ['clear', 'partly', 'overcast', 'rain', 'heavyrain', 'snow', 'sleet', 'fog', 'storm'];
export const MODES = ['off', 'live', 'manual'];
/** Manual picks (Settings and the City's quick picker), in display order. No network at all. */
export const CHOICES = [['clear', 'Clear'], ['partly', 'Partly cloudy'], ['overcast', 'Overcast'], ['rain', 'Rain'], ['heavyrain', 'Heavy rain'], ['snow', 'Snow'], ['fog', 'Fog'], ['storm', 'Thunderstorm']];
export const CHOICE_LABEL = Object.fromEntries(CHOICES);
export const DEFAULT_PREFS = Object.freeze({ mode: 'off', source: 'timezone', place: null, manual: 'clear', windy: false });
export const POLL_MIN_MS = 30 * 60e3, POLL_MAX_MS = 60 * 60e3;
const POLL_CAP_MS = 6 * 3600e3;

const clamp01 = n => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
/** 2 decimals (about 1 km), never -0. The native side rounds the same way before any request. */
export const round2 = n => { const r = Math.round(n * 100) / 100; return r === 0 ? 0 : r; };

/* ---------- MET symbol codes ---------- */
const SKY = { clearsky: 'clear', fair: 'partly', partlycloudy: 'partly', cloudy: 'overcast', fog: 'fog' };
const SKY_CLOUDS = { clearsky: 0.05, fair: 0.25, partlycloudy: 0.5, cloudy: 0.95, fog: 0.75 };
const SKY_LABEL = { clearsky: 'Clear sky', fair: 'Fair', partlycloudy: 'Partly cloudy', cloudy: 'Cloudy', fog: 'Fog' };
const PRECIP = /^(light|heavy)?(rain|sleet|snow)(showers)?(andthunder)?$/;
const LEVEL = { light: 0.35, '': 0.6, heavy: 0.9 };
/** 'lightrainshowersandthunder_day' → { base, variant, sky } | { base, variant, precip, level, showers, thunder } | null.
 *  The _day / _night / _polartwilight suffix is kept as variant; MET's own 'lightssleet…' / 'lightssnow…' spellings count as light. */
export function parseSymbol(code) {
  const m = /^([a-z]+)(?:_(day|night|polartwilight))?$/.exec(String(code ?? '').trim().toLowerCase());
  if (!m) return null;
  const base = m[1].replace(/^lights(?=sleet|snow)/, 'light'), variant = m[2] || '';
  if (SKY[base]) return { base, variant, sky: base };
  const p = PRECIP.exec(base);
  return p ? { base, variant, precip: p[2], level: p[1] || '', showers: Boolean(p[3]), thunder: Boolean(p[4]) } : null;
}
/** MET's English wording: 'Light rain showers and thunder'. Unknown codes read as partly cloudy. */
export function symbolLabel(code) {
  const s = parseSymbol(code);
  if (!s) return CHOICE_LABEL.partly;
  if (s.sky) return SKY_LABEL[s.sky];
  const text = `${s.level ? `${s.level} ` : ''}${s.precip}${s.showers ? ' showers' : ''}${s.thunder ? ' and thunder' : ''}`;
  return text[0].toUpperCase() + text.slice(1);
}
/** Wind speed (m/s) → 0..1: calm under 2 m/s, full gale feel from 14 m/s. */
export const windLevel = ms => (ms == null || ms === '' ? 0 : clamp01((Number(ms) - 2) / 12));

/** Scene the City draws: { kind, intensity 0..1, wind 0..1, clouds 0..1, precip: rain|snow|sleet|null, thunder }.
 *  details: MET fields (wind_speed m/s, cloud_area_fraction %). Unknown codes become partly cloudy. */
export function sceneFromSymbol(code, details = {}) {
  const s = parseSymbol(code);
  let kind = 'partly', intensity = 0, clouds = 0.45, precip = null, thunder = false;
  if (s?.sky) { kind = SKY[s.sky]; clouds = SKY_CLOUDS[s.sky]; intensity = kind === 'fog' ? 0.7 : 0; }
  else if (s) {
    intensity = LEVEL[s.level]; precip = s.precip; thunder = s.thunder; clouds = s.showers ? 0.75 : 0.95;
    kind = thunder ? 'storm' : precip === 'rain' ? (s.level === 'heavy' ? 'heavyrain' : 'rain') : precip;
  }
  const cover = details?.cloud_area_fraction;
  if (cover != null && cover !== '' && Number.isFinite(Number(cover))) clouds = clamp01(Number(cover) / 100);
  return { kind, intensity, wind: windLevel(details?.wind_speed), clouds, precip, thunder };
}
// [intensity, clouds, precip] for each manual pick.
const PICK = { clear: [0, 0.05], partly: [0, 0.5], overcast: [0, 0.95], rain: [0.6, 0.92, 'rain'], heavyrain: [0.95, 1, 'rain'], snow: [0.65, 0.92, 'snow'], fog: [0.8, 0.75], storm: [0.85, 1, 'rain'] };
export function sceneFromChoice(id, windy = false) {
  const kind = Object.hasOwn(PICK, id) ? id : 'clear', [intensity, clouds, precip = null] = PICK[kind];
  return { kind, intensity, wind: windy ? 0.8 : 0.1, clouds, precip, thunder: kind === 'storm' };
}

/* ---------- what a scene looks like ---------- */
const GLOOM = { clear: 0, partly: 0.1, overcast: 0.5, rain: 0.56, heavyrain: 0.78, snow: 0.38, sleet: 0.58, fog: 0.42, storm: 0.86 };
const HAZE = { clear: 0, partly: 0, overcast: 0.06, rain: 0.2, heavyrain: 0.42, snow: 0.3, sleet: 0.28, fog: 0.85, storm: 0.38 };
export const NO_WEATHER = Object.freeze({ gloom: 0, fog: 0, clouds: 0, precip: null, amount: 0, flakes: 0, lightning: false, snowCover: 0, wind: 0 });
/** Scene → render parameters (all 0..1): gloom (dim + desaturate), fog, clouds, precip + amount,
 *  flakes (share of snowflakes among the particles), lightning, snowCover (pale ground), wind. */
export function weatherLook(scene) {
  if (!scene || !KINDS.includes(scene.kind)) return NO_WEATHER;
  const k = scene.kind, i = clamp01(scene.intensity), c = clamp01(scene.clouds);
  const precip = ['rain', 'snow', 'sleet'].includes(scene.precip) ? scene.precip : null;
  const sky = k === 'clear' || k === 'partly';
  return {
    gloom: clamp01(GLOOM[k] + (sky ? c * 0.18 : (c - 0.9) * 0.3) + (precip ? (i - 0.6) * 0.2 : 0)),
    fog: clamp01(HAZE[k] * (k === 'fog' ? 0.6 + 0.5 * i : precip ? 0.6 + 0.6 * i : 1)),
    clouds: c, precip, amount: precip ? Math.max(0.15, i) : 0,
    flakes: precip === 'snow' ? 1 : precip === 'sleet' ? 0.45 : 0,
    lightning: k === 'storm' || Boolean(scene.thunder),
    snowCover: precip === 'snow' ? 0.3 + 0.4 * i : precip === 'sleet' ? 0.1 : 0,
    wind: clamp01(scene.wind),
  };
}
/** Icon name (registered by the City HUD) for a scene kind. */
export const kindIcon = kind => ({ clear: 'wx-sun', partly: 'wx-partly', overcast: 'wx-cloud', rain: 'wx-rain', heavyrain: 'wx-rain', sleet: 'wx-rain', snow: 'wx-snow', fog: 'wx-fog', storm: 'wx-storm' }[kind] || 'wx-partly');

/* ---------- units ---------- */
const FAHRENHEIT = new Set(['US', 'PR', 'BS', 'BZ', 'KY', 'PW']);   // CLDR temperature preference, not measurement system
/** Region of a locale tag ('en-US' → 'US'; a bare language uses its likely region). */
export function regionOf(locale) {
  try { const l = new Intl.Locale(locale); return String(l.region || l.maximize().region || '').toUpperCase(); }
  catch { return ''; }
}
export const usesFahrenheit = locale => FAHRENHEIT.has(regionOf(locale));
/** 12.4 °C → '12°C', or '54°F' where Fahrenheit is the norm (US, Puerto Rico, Bahamas, Belize, Cayman Islands, Palau). '' when unknown. */
export function formatTemp(celsius, locale) {
  if (celsius == null || celsius === '' || !Number.isFinite(Number(celsius))) return '';
  const c = Number(celsius), value = usesFahrenheit(locale) ? Math.round(c * 9 / 5 + 32) : Math.round(c);
  return `${value === 0 ? 0 : value}°${usesFahrenheit(locale) ? 'F' : 'C'}`;
}

/* ---------- preferences ---------- */
const cleanText = (value, limit) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, limit) : '');
/** A chosen place { name, display_name, lat, lon } (2-decimal coordinates) or null. */
export function normalizePlace(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.lat !== 'number' || typeof raw.lon !== 'number') return null;
  const name = cleanText(raw.name, 120), { lat, lon } = raw;
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { name, display_name: cleanText(raw.display_name, 300) || name, lat: round2(lat), lon: round2(lon) };
}
/** prefs.cityWeather → { mode: off|live|manual, source: timezone|place, place, manual, windy }. */
export function normalizePrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return { mode: MODES.includes(p.mode) ? p.mode : 'off', source: p.source === 'place' ? 'place' : 'timezone', place: normalizePlace(p.place), manual: Object.hasOwn(PICK, p.manual) ? p.manual : 'clear', windy: p.windy === true };
}
/** The City's scene for these prefs: a manual pick, the live reading, or null (no weather). */
export function sceneFor(prefs, live) {
  if (prefs.mode === 'manual') return sceneFromChoice(prefs.manual, prefs.windy);
  if (prefs.mode === 'live' && live) return sceneFromSymbol(live.symbol_code, live);
  return null;
}

/* ---------- time-zone default location ---------- */
/** Renamed zones whose old (or CLDR) spelling a runtime may still report → the zone1970.tab name.
 *  Zones merged into another (Europe/Oslo → Berlin, …) are not listed: they fall back to "Set your city". */
const RENAMED = {
  'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Dacca': 'Asia/Dhaka', 'Asia/Ulan_Bator': 'Asia/Ulaanbaatar', 'Asia/Thimbu': 'Asia/Thimphu', 'Asia/Macao': 'Asia/Macau',
  'Asia/Ujung_Pandang': 'Asia/Makassar', 'Europe/Kiev': 'Europe/Kyiv', 'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Indianapolis': 'America/Indiana/Indianapolis', 'America/Louisville': 'America/Kentucky/Louisville', 'America/Godthab': 'America/Nuuk',
  'Atlantic/Faeroe': 'Atlantic/Faroe', 'Pacific/Enderbury': 'Pacific/Kanton',
};
export const RENAMED_ZONES = RENAMED;
export const zoneLabel = zone => String(zone || '').split('/').pop().replaceAll('_', ' ');
/** The runtime's canonical name for a zone ('US/Mountain' → 'America/Denver'), or ''. */
export function canonicalZone(zone) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone || ''; } catch { return ''; }
}
export function systemZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}
/** Approximate place for an IANA zone from the generated table (zone → [lat, lon, label]):
 *  the zone itself, its renamed form, then the runtime's canonical name. null → "Set your city". */
export function zonePlace(zone, table, canonical = canonicalZone) {
  if (!zone || !table) return null;
  const tried = new Set(), c = canonical(zone);
  for (const name of [zone, RENAMED[zone], c, RENAMED[c]]) {
    if (!name || tried.has(name)) continue;
    tried.add(name);
    const row = Object.hasOwn(table, name) ? table[name] : null;
    if (Array.isArray(row) && Number.isFinite(row[0]) && Number.isFinite(row[1])) return { zone: name, lat: row[0], lon: row[1], name: row[2] || zoneLabel(name) };
  }
  return null;
}
/** Where live weather is read: the chosen place, or the time zone's city. null → "Set your city". */
export function liveLocation(prefs, zoneHit) {
  if (prefs.source === 'place') return prefs.place ? { lat: prefs.place.lat, lon: prefs.place.lon, name: prefs.place.name, source: 'place' } : null;
  return zoneHit ? { lat: zoneHit.lat, lon: zoneHit.lon, name: zoneHit.name, source: 'timezone', zone: zoneHit.zone } : null;
}
export const sameSpot = (a, b) => Boolean(a && b) && round2(a.lat) === round2(b.lat) && round2(a.lon) === round2(b.lon);

/* ---------- polling and HUD ---------- */
/** Next live check: 30–60 minutes from now with random jitter, never before the reading expires (capped at 6 h). */
export function nextPollDelay(now, expiresAt, rand = Math.random) {
  const jitter = POLL_MIN_MS + Math.floor(clamp01(rand()) * (POLL_MAX_MS - POLL_MIN_MS));
  const wait = Number.isFinite(expiresAt) ? Math.min(POLL_CAP_MS, expiresAt - now) : 0;
  return Math.max(jitter, wait);
}
/** After a failure: 15–20 minutes, or 60–75 when the service asked us to back off. */
export function retryDelay(code, rand = Math.random) {
  const slow = code === 'WEATHER_RATE_LIMITED' || code === 'WEATHER_FORBIDDEN';
  return (slow ? 60 : 15) * 60e3 + Math.floor(clamp01(rand()) * (slow ? 15 : 5) * 60e3);
}
/** The HUD chip: 'Rain · 12°C · Denver', 'Your pick: Snow', 'Weather off', 'Set your city', 'Weather unavailable'. */
export function chipText({ prefs, status, live, place, locale }) {
  if (prefs.mode === 'manual') return `Your pick: ${CHOICE_LABEL[prefs.manual] || 'Clear'}${prefs.windy ? ' · Windy' : ''}`;
  if (prefs.mode !== 'live') return 'Weather off';
  if (status === 'noplace') return 'Set your city';
  if (!live) return status === 'error' ? 'Weather unavailable' : 'Weather…';
  return [symbolLabel(live.symbol_code), formatTemp(live.air_temperature, locale), place].filter(Boolean).join(' · ');
}
