/* City weather: the HUD chip ("Rain · 12°C · Denver", "Your pick: Snow"), its quick picker and the
 * live feed. Live polls MET Norway (through the native weather_now command) only while the City is
 * shown and the mode is Live: on show, then every 30–60 minutes with jitter, never before the
 * reading expires. Errors stay a quiet chip state, never a modal. The picker saves the same pref
 * as Settings (store.prefs.cityWeather). Untrusted text (place names) is only ever textContent. */
import { h, icon, registerIcons, clear } from '../ui.js';
import { WeatherFx } from './weather.js';
import { TZ_CITIES } from './tzcities.js';
import { CHOICES, normalizePrefs, sceneFor, weatherLook, liveLocation, zonePlace, systemZone, sameSpot, nextPollDelay, retryDelay, chipText, symbolLabel, formatTemp, kindIcon } from '../weather.js';

const CLOUD = 'M7 15h10a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.7 1.3A2.9 2.9 0 0 0 7 15Z';
registerIcons({
  'wx-sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  'wx-partly': '<path d="M9 2.5V4M3.5 8.5H2M4.6 4.1l1 1M13.4 4.1l-1 1"/><path d="M12.6 9.8A4 4 0 1 0 6 12.6"/><path d="M9.5 21h8a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6 1.3A2.9 2.9 0 0 0 9.5 21Z"/>',
  'wx-cloud': `<path d="${CLOUD}" transform="translate(0 3)"/>`,
  'wx-rain': `<path d="${CLOUD}"/><path d="m8 18-1 3M12 18l-1 3M16 18l-1 3"/>`,
  'wx-snow': `<path d="${CLOUD}"/><path d="M8 18.5h.01M12 18.5h.01M16 18.5h.01M10 21.5h.01M14 21.5h.01"/>`,
  'wx-fog': `<path d="${CLOUD}"/><path d="M4 18.5h16M7 21.5h10"/>`,
  'wx-storm': `<path d="${CLOUD}"/><path d="m12.5 15-2 3.5h3l-2 3.5"/>`,
  'wx-off': `<path d="${CLOUD}" transform="translate(0 3)"/><path d="m3 3 18 18"/>`,
});
const STALE_MS = 3 * 3600e3;   // after a failed check, an older reading than this is dropped
const locale = () => globalThis.navigator?.language || 'en';

export class CityWeather {
  constructor(world, { store, bridge, reducedMotion, navigate }) {
    this.store = store; this.bridge = bridge; this.navigate = navigate;
    this.fx = new WeatherFx(world, { reducedMotion });
    this.visible = false; this.live = null; this.status = 'off'; this.error = ''; this.timer = 0; this.seq = 0; this.pending = null; this.retry = null;
    this.text = h('span.city-weather-text');
    this.chip = h('button.city-chip.city-weather-chip', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => this.togglePicker() }, icon('wx-off'), this.text);
    this.picker = h('div.city-weather-pick.card', { hidden: true, role: 'dialog', 'aria-label': 'City weather', onkeydown: event => { if (event.key === 'Escape') { event.stopPropagation(); this.togglePicker(false); this.chip.focus(); } } });
    this.node = h('div.city-weather', this.chip, this.picker);
    this.onOutside = event => { if (!this.node.contains(event.target)) this.togglePicker(false); };
    this.off = store.on('change', () => this.refresh());
    this.refresh();
  }
  get prefs() { return normalizePrefs(this.store.prefs.cityWeather); }
  save(patch) { this.store.setPref('cityWeather', { ...this.prefs, ...patch }); }

  /** Prefs (or visibility) changed: pick the scene, start or stop the live feed. Cheap when nothing changed. */
  refresh(force = false) {
    const prefs = this.prefs;
    const loc = prefs.mode === 'live' ? liveLocation(prefs, prefs.source === 'place' ? null : zonePlace(systemZone(), TZ_CITIES)) : null;
    const sig = JSON.stringify([prefs, loc, this.visible]);
    if (sig === this.sig && !force) return;
    this.sig = sig; this.now = prefs; this.loc = loc;
    if (this.live && !sameSpot(this.live.loc, loc)) this.live = null;   // another place: the old reading no longer applies
    clearTimeout(this.timer); this.timer = 0;
    if (prefs.mode !== 'live') this.status = prefs.mode;
    else if (!loc) this.status = 'noplace';
    else {
      const waiting = this.retry && sameSpot(this.retry.loc, loc) && Date.now() < this.retry.at;   // a failed check is still backing off
      this.status = waiting ? 'error' : this.live ? 'ok' : 'loading';
      if (this.visible) this.poll();
    }
    this.apply();
  }
  apply() {
    const prefs = this.now, scene = sceneFor(prefs, prefs.mode === 'live' ? this.live?.data : null);
    const look = scene ? weatherLook(scene) : null, sig = JSON.stringify(look);
    if (sig !== this.lookSig) { this.lookSig = sig; this.fx.set(look); }
    this.renderChip(scene);
    if (!this.picker.hidden) this.renderPicker();
  }
  async poll() {
    const loc = this.loc;
    if (!this.visible || this.now.mode !== 'live' || !loc) return;
    const now = Date.now();
    if (this.live && sameSpot(this.live.loc, loc) && now < this.live.expiresAt) { this.schedule(nextPollDelay(now, this.live.expiresAt)); return; }
    if (this.pending && sameSpot(this.pending, loc)) return;
    // After a failure (MET may have asked us to back off) the retry waits, even across hide/show.
    if (this.retry && sameSpot(this.retry.loc, loc) && now < this.retry.at) { this.schedule(this.retry.at - now); return; }
    const seq = ++this.seq;
    this.pending = loc;
    try {
      const data = await this.bridge.desktop.weatherNow(loc.lat, loc.lon);
      if (seq !== this.seq) return;
      const expires = Date.parse(data?.expires);
      this.live = { data, loc, at: Date.now(), expiresAt: Number.isFinite(expires) ? expires : Date.now() + 30 * 60e3 };
      this.status = 'ok'; this.error = ''; this.retry = null;
      this.schedule(nextPollDelay(Date.now(), this.live.expiresAt));
    } catch (error) {
      if (seq !== this.seq) return;
      this.status = 'error'; this.error = error?.message || String(error);
      if (this.live && Date.now() - this.live.at > STALE_MS) this.live = null;
      const wait = retryDelay(error?.code);
      this.retry = { loc, at: Date.now() + wait };
      this.schedule(wait);
    } finally { if (seq === this.seq) this.pending = null; }
    this.apply();
  }
  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = this.visible && this.now.mode === 'live' ? setTimeout(() => { this.timer = 0; this.poll(); }, ms) : 0;
  }
  show() { this.visible = true; this.refresh(true); }
  hide() { this.visible = false; clearTimeout(this.timer); this.timer = 0; this.togglePicker(false); this.sig = ''; }

  /* ---------- chip ---------- */
  renderChip(scene) {
    const prefs = this.now, live = prefs.mode === 'live' ? this.live?.data : null;
    const text = chipText({ prefs, status: this.status, live, place: this.loc?.name, locale: locale() });
    const name = prefs.mode === 'off' || (prefs.mode === 'live' && !live && this.status !== 'loading') ? 'wx-off' : prefs.mode === 'live' && !live ? 'wx-cloud' : kindIcon(scene?.kind);
    const title = this.describe(prefs, live);
    const sig = [text, name, title].join('|');
    if (sig === this.chipSig) return;
    this.chipSig = sig;
    this.text.textContent = text;
    this.chip.firstChild.replaceWith(icon(name));
    this.chip.title = title;
    this.chip.setAttribute('aria-label', `City weather: ${text}. Change the weather.`);
    this.chip.classList.toggle('is-off', prefs.mode === 'off');
    this.chip.classList.toggle('is-quiet', prefs.mode === 'live' && !live && this.status !== 'loading');
  }
  describe(prefs, live) {
    if (prefs.mode === 'manual') return 'Your own pick: no network. Click to change the weather.';
    if (prefs.mode === 'off') return 'City weather is off. Click to turn it on.';
    if (this.status === 'noplace') return prefs.source === 'place' ? 'Choose a city in Weather settings.' : 'Your time zone has no city of its own. Choose a city in Weather settings.';
    if (!live) return this.status === 'error' ? `Weather unavailable. ${this.error}`.trim() : 'Checking the weather…';
    const place = this.loc ? `${this.loc.name}${this.loc.source === 'timezone' ? ' (from your time zone)' : ''}` : '';
    const wind = Number.isFinite(live.wind_speed) ? `wind ${Math.round(live.wind_speed)} m/s` : '';
    const when = Date.parse(live.updated_at);
    const updated = Number.isFinite(when) ? `, updated ${new Date(when).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
    return [[symbolLabel(live.symbol_code), formatTemp(live.air_temperature, locale()), wind, place].filter(Boolean).join(' · '),
      `Weather data: MET Norway (CC BY 4.0)${updated}`, this.status === 'error' ? 'The last check failed; this is the previous reading.' : ''].filter(Boolean).join('\n');
  }

  /* ---------- quick picker ---------- */
  togglePicker(force) {
    const open = force ?? this.picker.hidden;
    if (open === !this.picker.hidden) return;
    this.picker.hidden = !open;
    this.chip.setAttribute('aria-expanded', String(open));
    if (open) {
      this.renderPicker();
      document.addEventListener('pointerdown', this.onOutside, true);
      (this.picker.querySelector('[aria-pressed="true"]') || this.picker.querySelector('button'))?.focus();
    } else document.removeEventListener('pointerdown', this.onOutside, true);
  }
  renderPicker() {
    const prefs = this.now, focused = this.picker.contains(document.activeElement) ? document.activeElement.dataset.wx : null;
    const opt = (key, label, pressed, run, iconName) => h('button.city-weather-opt', { type: 'button', 'aria-pressed': String(pressed), dataset: { wx: key }, onclick: run }, icon(iconName), h('span', label));
    const live = prefs.mode === 'live';
    clear(this.picker,
      h('div.city-weather-row',
        opt('live', 'Live', live, () => this.save({ mode: 'live' }), 'wx-partly'),
        opt('off', 'Off', prefs.mode === 'off', () => this.save({ mode: 'off' }), 'wx-off')),
      live ? h('p.city-weather-note', this.status === 'noplace' ? 'Live needs a city: choose one in Weather settings.' : 'Live sends your approximate location (about 1 km) to MET Norway every 30–60 minutes. Weather data: MET Norway (CC BY 4.0).') : null,
      h('span.city-weather-label', 'Pick my own'),
      h('div.city-weather-grid', CHOICES.map(([id, label]) => opt(`pick:${id}`, label, prefs.mode === 'manual' && prefs.manual === id, () => this.save({ mode: 'manual', manual: id }), kindIcon(id)))),
      h('label.city-weather-windy', { title: prefs.mode === 'manual' ? null : 'Windy applies to your own pick' }, h('input', { type: 'checkbox', checked: prefs.windy, disabled: prefs.mode !== 'manual', dataset: { wx: 'windy' }, onchange: event => this.save({ windy: event.currentTarget.checked }) }), h('span', 'Windy')),
      h('button.city-weather-more', { type: 'button', dataset: { wx: 'settings' }, onclick: () => { this.togglePicker(false); this.navigate('settings'); } }, 'Weather settings…'));
    if (focused) this.picker.querySelector(`[data-wx="${CSS.escape(focused)}"]`)?.focus();
  }

  dispose() {
    this.hide();
    this.off?.();
    this.fx.dispose();
    this.node.remove();
  }
}
