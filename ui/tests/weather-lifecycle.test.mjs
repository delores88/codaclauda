import test from 'node:test';
import assert from 'node:assert/strict';
import { CityWeather } from '../app/city/weather-hud.js';

const reading = () => ({ symbol_code: 'rain', expires: new Date(Date.now() + 3600e3).toISOString() });
const settle = () => new Promise(resolve => setImmediate(resolve));

// Exercise the real controller without constructing its DOM or WebGL effects.
function fixture(t, { hidden = false, request = async () => reading() } = {}) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const document = new EventTarget();
  document.hidden = hidden;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  const requests = [];
  const weather = Object.create(CityWeather.prototype);
  Object.assign(weather, {
    store: { prefs: { cityWeather: { mode: 'live', source: 'place', place: { name: 'Denver', lat: 39.74, lon: -104.98 } } } },
    bridge: { desktop: { weatherNow: (...coords) => { requests.push(coords); return request(); } } },
    visible: false, live: null, status: 'off', error: '', timer: 0, seq: 0, pending: null, retry: null,
    apply() {}, togglePicker() {}, fx: { dispose() {} }, node: { remove() {} },
  });
  const setHidden = value => { document.hidden = value; document.dispatchEvent(new Event('visibilitychange')); };
  t.after(() => {
    weather.dispose();
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  });
  return { weather, document, requests, setHidden };
}

test('opening City while hidden does not request weather; restoring starts one check', async t => {
  const { weather, requests, setHidden } = fixture(t, { hidden: true });
  weather.show();
  await weather.poll();   // all entry points must enforce the window visibility boundary
  assert.equal(requests.length, 0);
  assert.equal(weather.timer, 0);
  setHidden(false);
  await settle();
  assert.deepEqual(requests, [[39.74, -104.98]]);
  assert.equal(weather.status, 'ok');
  assert.ok(weather.timer);
});

test('a response finishing while hidden schedules nothing; restoring reuses the fresh reading', async t => {
  let respond;
  const { weather, requests, setHidden } = fixture(t, { request: () => new Promise(resolve => { respond = resolve; }) });
  weather.show();
  assert.equal(requests.length, 1);
  setHidden(true);
  respond(reading());
  await settle();
  assert.equal(weather.timer, 0);
  setHidden(false);
  await settle();
  assert.equal(requests.length, 1);
  assert.ok(weather.timer);
  setHidden(true);
  assert.equal(weather.timer, 0);
});

test('visibility changes preserve rate-limit backoff and resume after it expires', async t => {
  let attempt = 0;
  const { weather, requests, setHidden } = fixture(t, { request: async () => {
    if (++attempt === 1) throw Object.assign(new Error('Slow down'), { code: 'WEATHER_RATE_LIMITED' });
    return reading();
  } });
  weather.show();
  await settle();
  const retryAt = weather.retry.at;
  assert.ok(retryAt > Date.now() + 59 * 60e3);
  setHidden(true);
  assert.equal(weather.timer, 0);
  setHidden(false);
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(weather.retry.at, retryAt);
  assert.ok(weather.timer);
  setHidden(true);
  weather.retry.at = Date.now() - 1;
  setHidden(false);
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(weather.status, 'ok');
});

test('restoring with weather off or manual does not start a request', async t => {
  const { weather, requests, setHidden } = fixture(t, { hidden: true });
  weather.show();
  for (const mode of ['off', 'manual']) {
    setHidden(true);
    weather.store.prefs.cityWeather.mode = mode;
    weather.refresh();
    setHidden(false);
    await settle();
    assert.equal(requests.length, 0);
    assert.equal(weather.timer, 0);
  }
});

test('leaving City removes the visibility listener and its timer', async t => {
  const { weather, document } = fixture(t);
  const removed = t.mock.method(document, 'removeEventListener');
  weather.show();
  await settle();
  assert.ok(weather.timer);
  weather.hide();
  assert.equal(weather.timer, 0);
  assert.ok(removed.mock.calls.some(({ arguments: args }) => args[0] === 'visibilitychange' && args[1] === weather.onVisibility));
});
