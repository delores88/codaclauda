import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSymbol, symbolLabel, sceneFromSymbol, sceneFromChoice, weatherLook, NO_WEATHER, CHOICES, KINDS, windLevel,
  usesFahrenheit, formatTemp, normalizePrefs, normalizePlace, sceneFor, zonePlace, liveLocation, sameSpot, RENAMED_ZONES,
  nextPollDelay, retryDelay, chipText, POLL_MIN_MS, POLL_MAX_MS, round2, kindIcon,
} from '../app/weather.js';
import { TZ_CITIES } from '../app/city/tzcities.js';
import { parseIso6709, parseZoneTab, zoneLabel } from '../dev/tzcities-gen.mjs';

const kind = code => sceneFromSymbol(code).kind;

test('MET sky codes map to clear, partly, overcast and fog, with any suffix', () => {
  assert.equal(kind('clearsky_day'), 'clear');
  assert.equal(kind('clearsky_polartwilight'), 'clear');
  assert.equal(kind('fair_night'), 'partly');
  assert.equal(kind('partlycloudy_day'), 'partly');
  assert.equal(kind('cloudy'), 'overcast');
  assert.equal(kind('fog'), 'fog');
  assert.deepEqual(parseSymbol('fair_polartwilight'), { base: 'fair', variant: 'polartwilight', sky: 'fair' });
});

test('rain, sleet and snow keep their strength; showers are lighter on cloud', () => {
  const light = sceneFromSymbol('lightrain'), rain = sceneFromSymbol('rain'), heavy = sceneFromSymbol('heavyrain');
  assert.deepEqual([light.kind, rain.kind, heavy.kind], ['rain', 'rain', 'heavyrain']);
  assert.ok(light.intensity < rain.intensity && rain.intensity < heavy.intensity);
  assert.equal(kind('heavyrainshowers_day'), 'heavyrain');
  assert.equal(kind('lightrainshowers_night'), 'rain');
  assert.ok(sceneFromSymbol('rainshowers_day').clouds < sceneFromSymbol('rain').clouds);
  for (const code of ['lightsleet', 'sleet', 'heavysleetshowers_day']) assert.equal(kind(code), 'sleet', code);
  for (const code of ['lightsnow', 'snowshowers_night', 'heavysnow']) assert.equal(kind(code), 'snow', code);
  assert.equal(sceneFromSymbol('heavysnow').precip, 'snow');
});

test('every thunder variant is a storm, including MET\'s own "lights…" spellings', () => {
  const thunder = ['lightrainandthunder', 'rainandthunder', 'heavyrainandthunder', 'lightrainshowersandthunder_day', 'rainshowersandthunder_night',
    'heavyrainshowersandthunder_polartwilight', 'lightsleetandthunder', 'sleetandthunder', 'heavysleetandthunder', 'lightssleetshowersandthunder_day',
    'sleetshowersandthunder_night', 'heavysleetshowersandthunder_day', 'lightsnowandthunder', 'snowandthunder', 'heavysnowandthunder',
    'lightssnowshowersandthunder_day', 'snowshowersandthunder_night', 'heavysnowshowersandthunder_day'];
  for (const code of thunder) {
    const scene = sceneFromSymbol(code);
    assert.equal(scene.kind, 'storm', code);
    assert.equal(scene.thunder, true, code);
  }
  assert.equal(sceneFromSymbol('snowandthunder').precip, 'snow');
  assert.equal(sceneFromSymbol('lightssleetshowersandthunder_day').intensity, sceneFromSymbol('lightrain').intensity);
});

test('unknown, empty and malformed codes become partly cloudy', () => {
  for (const code of ['', null, undefined, 'tornado', 'rain_evening', 'RAIN!', 42]) {
    const scene = sceneFromSymbol(code);
    assert.equal(scene.kind, 'partly', String(code));
    assert.equal(scene.intensity, 0);
  }
  assert.equal(symbolLabel('volcano'), 'Partly cloudy');
});

test('labels follow MET wording', () => {
  assert.equal(symbolLabel('clearsky_day'), 'Clear sky');
  assert.equal(symbolLabel('lightrainshowersandthunder_day'), 'Light rain showers and thunder');
  assert.equal(symbolLabel('heavysnow'), 'Heavy snow');
  assert.equal(symbolLabel('fog'), 'Fog');
});

test('forecast details set wind and cloud cover', () => {
  const scene = sceneFromSymbol('rain', { wind_speed: 8, cloud_area_fraction: 64 });
  assert.equal(scene.wind, 0.5);
  assert.equal(scene.clouds, 0.64);
  assert.equal(sceneFromSymbol('rain', { cloud_area_fraction: null }).clouds, 0.95);
  assert.equal(windLevel(1), 0); assert.equal(windLevel(30), 1); assert.equal(windLevel(null), 0); assert.equal(windLevel('x'), 0);
});

test('every manual pick is a scene; Windy raises the wind', () => {
  assert.equal(CHOICES.length, 8);
  for (const [id] of CHOICES) {
    const scene = sceneFromChoice(id);
    assert.equal(scene.kind, id);
    assert.ok(KINDS.includes(scene.kind));
  }
  assert.ok(sceneFromChoice('snow', true).wind > sceneFromChoice('snow', false).wind);
  assert.equal(sceneFromChoice('storm').thunder, true);
  assert.equal(sceneFromChoice('nonsense').kind, 'clear');
});

test('looks stay in range and match the weather', () => {
  for (const id of KINDS) {
    const look = weatherLook({ kind: id, intensity: 1, wind: 1, clouds: 1, precip: id === 'snow' ? 'snow' : id === 'sleet' ? 'sleet' : /rain|storm/.test(id) ? 'rain' : null });
    for (const key of ['gloom', 'fog', 'clouds', 'amount', 'flakes', 'snowCover', 'wind']) assert.ok(look[key] >= 0 && look[key] <= 1, `${id}.${key}`);
  }
  assert.equal(weatherLook(null), NO_WEATHER);
  assert.equal(weatherLook({ kind: 'hail' }), NO_WEATHER);
  const clear = weatherLook(sceneFromChoice('clear')), heavy = weatherLook(sceneFromChoice('heavyrain')), fog = weatherLook(sceneFromChoice('fog'));
  assert.ok(clear.gloom < 0.05 && clear.precip === null && clear.fog === 0);
  assert.ok(heavy.gloom > weatherLook(sceneFromChoice('rain')).gloom);
  assert.ok(fog.fog > heavy.fog && fog.precip === null);
  assert.equal(weatherLook(sceneFromChoice('snow')).flakes, 1);
  assert.ok(weatherLook(sceneFromChoice('snow')).snowCover > 0);
  assert.equal(weatherLook(sceneFromSymbol('sleet')).flakes, 0.45);
  assert.equal(weatherLook(sceneFromChoice('storm')).lightning, true);
  assert.equal(weatherLook(sceneFromChoice('rain')).lightning, false);
  assert.equal(kindIcon('storm'), 'wx-storm'); assert.equal(kindIcon('mystery'), 'wx-partly');
});

test('Fahrenheit where it is the temperature norm (CLDR), Celsius elsewhere', () => {
  for (const locale of ['en-US', 'es-US', 'es-PR', 'en-BS', 'en-BZ', 'en-KY', 'en-PW']) assert.equal(usesFahrenheit(locale), true, locale);
  for (const locale of ['en-GB', 'en-CA', 'de-DE', 'fr', 'nb-NO', 'ja-JP', 'en-LR', 'my-MM', 'my', 'not a locale', '']) assert.equal(usesFahrenheit(locale), false, locale);
  assert.equal(formatTemp(12.4, 'en-GB'), '12°C');
  assert.equal(formatTemp(12.4, 'en-US'), '54°F');
  assert.equal(formatTemp(-0.3, 'de-DE'), '0°C');
  assert.equal(formatTemp(-17.8, 'en-US'), '0°F');
  assert.equal(formatTemp(null, 'en-US'), '');
  assert.equal(formatTemp('warm', 'en-US'), '');
});

test('preferences default to Off and drop bad values', () => {
  assert.deepEqual(normalizePrefs(undefined), { mode: 'off', source: 'timezone', place: null, manual: 'clear', windy: false });
  const prefs = normalizePrefs({ mode: 'live', source: 'place', place: { name: ' Oslo\u0007 ', display_name: 'Oslo, Norway', lat: 59.91387, lon: 10.75225 }, manual: 'snow', windy: true });
  assert.deepEqual(prefs, { mode: 'live', source: 'place', place: { name: 'Oslo', display_name: 'Oslo, Norway', lat: 59.91, lon: 10.75 }, manual: 'snow', windy: true });
  assert.equal(normalizePrefs({ mode: 'sometimes', manual: '__proto__', windy: 'yes' }).mode, 'off');
  assert.equal(normalizePrefs({ manual: '__proto__' }).manual, 'clear');
  assert.equal(normalizePrefs({ windy: 'yes' }).windy, false);
  for (const bad of [null, {}, { name: 'X', lat: '1', lon: 2 }, { name: 'X', lat: 91, lon: 0 }, { name: '', lat: 1, lon: 2 }, { name: 'X', lat: NaN, lon: 0 }]) assert.equal(normalizePlace(bad), null);
});

test('the scene follows the mode', () => {
  const live = { symbol_code: 'snow', air_temperature: -2, wind_speed: 3, cloud_area_fraction: 90 };
  assert.equal(sceneFor(normalizePrefs({ mode: 'off' }), live), null);
  assert.equal(sceneFor(normalizePrefs({ mode: 'live' }), null), null);
  assert.equal(sceneFor(normalizePrefs({ mode: 'live' }), live).kind, 'snow');
  assert.equal(sceneFor(normalizePrefs({ mode: 'manual', manual: 'fog' }), live).kind, 'fog');
});

test('time zones resolve to a city, through renames and canonical names', () => {
  assert.deepEqual(zonePlace('America/Denver', TZ_CITIES), { zone: 'America/Denver', lat: 39.7, lon: -105, name: 'Denver' });
  assert.equal(zonePlace('Asia/Calcutta', TZ_CITIES, () => 'Asia/Calcutta').name, 'Kolkata');
  assert.equal(zonePlace('US/Mountain', TZ_CITIES, () => 'America/Denver').name, 'Denver');
  assert.equal(zonePlace('America/Argentina/Buenos_Aires', TZ_CITIES).name, 'Buenos Aires');
  // Merged zones and UTC have no city of their own: "Set your city".
  assert.equal(zonePlace('Europe/Oslo', TZ_CITIES, () => 'Europe/Oslo'), null);
  assert.equal(zonePlace('UTC', TZ_CITIES), null);
  assert.equal(zonePlace('', TZ_CITIES), null);
  assert.equal(zonePlace('toString', TZ_CITIES, () => ''), null);
  for (const [from, to] of Object.entries(RENAMED_ZONES)) assert.ok(TZ_CITIES[to], `${from} → ${to} is in the table`);
});

test('the location comes from the chosen place or the time zone', () => {
  const zone = zonePlace('America/Denver', TZ_CITIES);
  assert.equal(liveLocation(normalizePrefs({}), zone).name, 'Denver');
  assert.equal(liveLocation(normalizePrefs({}), null), null);
  assert.equal(liveLocation(normalizePrefs({ source: 'place' }), zone), null);
  const place = liveLocation(normalizePrefs({ source: 'place', place: { name: 'Oslo', lat: 59.91, lon: 10.75 } }), zone);
  assert.deepEqual(place, { lat: 59.91, lon: 10.75, name: 'Oslo', source: 'place' });
  assert.ok(sameSpot({ lat: 59.911, lon: 10.749 }, place));
  assert.ok(!sameSpot(place, zone));
  assert.equal(round2(-0.001), 0);
});

test('polls wait 30–60 minutes with jitter and never before expiry', () => {
  const now = 1_000_000;
  assert.equal(nextPollDelay(now, now + 60e3, () => 0), POLL_MIN_MS);
  const late = nextPollDelay(now, NaN, () => 0.999999);
  assert.ok(late < POLL_MAX_MS && late > POLL_MAX_MS - 10);
  assert.equal(nextPollDelay(now, now + 90 * 60e3, () => 0.5), 90 * 60e3);
  assert.equal(nextPollDelay(now, now + 48 * 3600e3, () => 0), 6 * 3600e3);
  for (let k = 0; k < 50; k++) { const d = nextPollDelay(now, now - 1); assert.ok(d >= POLL_MIN_MS && d < POLL_MAX_MS); }
  assert.ok(retryDelay('WEATHER_RATE_LIMITED', () => 0) >= 60 * 60e3);
  assert.ok(retryDelay('WEATHER_UNAVAILABLE', () => 0.99) < 20 * 60e3);
});

test('the HUD chip reads like "Rain · 12°C · Denver"', () => {
  const live = { symbol_code: 'rain', air_temperature: 12.2 };
  assert.equal(chipText({ prefs: normalizePrefs({ mode: 'live' }), status: 'ok', live, place: 'Denver', locale: 'en-GB' }), 'Rain · 12°C · Denver');
  assert.equal(chipText({ prefs: normalizePrefs({ mode: 'manual', manual: 'snow' }) }), 'Your pick: Snow');
  assert.equal(chipText({ prefs: normalizePrefs({ mode: 'manual', manual: 'storm', windy: true }) }), 'Your pick: Thunderstorm · Windy');
  assert.equal(chipText({ prefs: normalizePrefs({}) }), 'Weather off');
  assert.equal(chipText({ prefs: normalizePrefs({ mode: 'live' }), status: 'noplace' }), 'Set your city');
  assert.equal(chipText({ prefs: normalizePrefs({ mode: 'live' }), status: 'error' }), 'Weather unavailable');
  assert.equal(chipText({ prefs: normalizePrefs({ mode: 'live' }), status: 'loading' }), 'Weather…');
});

test('the tzdb generator parses ISO 6709 and zone1970.tab rows', () => {
  assert.deepEqual(parseIso6709('+4230+00131').map(n => +n.toFixed(4)), [42.5, 1.5167]);
  assert.deepEqual(parseIso6709('+394421-1045903').map(n => +n.toFixed(4)), [39.7392, -104.9842]);
  assert.deepEqual(parseIso6709('-3352+15113').map(n => +n.toFixed(4)), [-33.8667, 151.2167]);
  assert.equal(parseIso6709('4230+00131'), null);
  assert.equal(parseIso6709('+9530+00131'), null);
  const sample = '# tzdb timezone descriptions\n#\nAD\t+4230+00131\tEurope/Andorra\nUS\t+394421-1045903\tAmerica/Denver\tMountain (most areas)\nXX\tbad\tNowhere/Bad\nUS\t+394421-1045903\tAmerica/Denver\tduplicate\n';
  const { rows, version } = parseZoneTab(sample);
  assert.deepEqual(rows, [{ zone: 'Europe/Andorra', lat: 42.5, lon: 1.5, label: 'Andorra' }, { zone: 'America/Denver', lat: 39.7, lon: -105, label: 'Denver' }]);
  assert.equal(version, '');
  assert.equal(zoneLabel('America/North_Dakota/New_Salem'), 'New Salem');
});

test('the generated table is sane', () => {
  const rows = Object.entries(TZ_CITIES);
  assert.ok(rows.length > 250);
  for (const [zone, [lat, lon, label]] of rows) {
    assert.ok(Math.abs(lat) <= 90 && Math.abs(lon) <= 180, zone);
    assert.equal(Math.round(lat * 10) / 10, lat, zone);
    assert.ok(typeof label === 'string' && label.length > 0, zone);
  }
});
