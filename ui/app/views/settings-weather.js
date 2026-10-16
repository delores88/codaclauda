/* Settings → City weather: Off (default) / Live / Pick my own. Live reads MET Norway for the time
 * zone's city (approximate) or a city the owner searches for (OpenStreetMap Nominatim, only when
 * Search is chosen, never per keystroke). Pick my own uses no network at all. Saved as
 * store.prefs.cityWeather, the same pref the City's quick picker writes. Place names from the
 * search are untrusted text and only ever rendered as textContent. */
import { TZ_CITIES } from '../city/tzcities.js';
import { CHOICES, normalizePrefs, normalizePlace, zonePlace, systemZone, kindIcon } from '../weather.js';

const PRIVACY = 'Live sends approximate city coordinates (about 1 km or coarser) to MET Norway while the City window is visible. MET also sees your IP address. Checks are periodic; caching, retry delays and reopening the City affect their timing.';
const MODE_LABEL = { off: 'Off', live: 'Live', manual: 'Pick my own' };

/** → { node, render() }: a persistent card that re-renders itself when its pref changes. */
export function weatherSettings({ store, ui, bridge }) {
  const { h, icon } = ui;
  const search = { results: null, busy: false, message: '', error: false };
  const node = h('section.card.settings-card.wx-settings', { 'aria-labelledby': 'wx-title' });
  const input = h('input.input.wx-search-input', { type: 'search', placeholder: 'City or town, e.g. Denver', maxlength: 100, 'aria-label': 'Search for a city', dataset: { wx: 'query' }, onkeydown: event => { if (event.key === 'Enter') { event.preventDefault(); find(); } } });
  const prefs = () => normalizePrefs(store.prefs.cityWeather);
  const save = patch => store.setPref('cityWeather', { ...prefs(), ...patch });

  async function find() {
    const query = input.value.trim();
    if (search.busy) return;
    if (query.length < 2 || query.length > 100) { Object.assign(search, { results: null, message: 'Enter 2 to 100 characters, then choose Search.', error: true }); render(true); return; }
    Object.assign(search, { busy: true, message: 'Searching…', error: false }); render(true);
    try {
      const found = await bridge.desktop.geocodePlace(query);
      const places = (Array.isArray(found) ? found : []).map(normalizePlace).filter(Boolean);
      Object.assign(search, { results: places, message: places.length ? '' : `No places found for “${query}”.`, error: false });
    } catch (error) {
      Object.assign(search, { results: null, message: `Place search failed: ${error?.message || error}`, error: true });
    } finally { search.busy = false; render(true); }
  }
  function choose(place) {
    Object.assign(search, { results: null, message: '', error: false });
    save({ source: 'place', place });
  }

  let sig = '';
  function render(force = false) {
    const p = prefs(), zone = systemZone(), hit = zonePlace(zone, TZ_CITIES);
    const next = JSON.stringify([p, zone, hit, search]);
    if (next === sig && !force) return;
    sig = next;
    const focused = node.contains(document.activeElement) ? document.activeElement.dataset.wx : null;
    const segment = (mode, label) => h('button', { type: 'button', 'aria-pressed': String(p.mode === mode), dataset: { wx: `mode:${mode}` }, onclick: () => save({ mode }) }, label);
    const radio = (source, label, detail) => h('label.wx-radio',
      h('input', { type: 'radio', name: 'wx-source', value: source, checked: p.source === source, dataset: { wx: `source:${source}` }, onchange: () => save({ source }) }),
      h('span.wx-radio-text', h('strong', label), detail ? h('span.field-hint', detail) : null));
    const zoneText = hit ? `${hit.name} (${hit.zone})` : `Your time zone${zone ? ` (${zone})` : ''} has no city of its own. Set your city: choose “A city I choose”.`;
    const live = p.mode !== 'live' ? null : h('div.wx-live',
      h('div.wx-sources', { role: 'radiogroup', 'aria-label': 'Location for live weather' },
        radio('timezone', 'My time zone\'s city (approximate)', zoneText),
        radio('place', 'A city I choose', p.place ? `Chosen: ${p.place.display_name}` : 'Search, then choose a place.')),
      p.source !== 'place' ? null : h('div.wx-search',
        h('div.wx-search-row', input, h('button.btn', { type: 'button', disabled: search.busy, dataset: { wx: 'search' }, onclick: find }, icon('search'), 'Search')),
        h('p.field-hint', 'Searching sends what you type (and, like any web request, your IP address) to OpenStreetMap’s Nominatim.'),
        search.message ? h(`p.wx-search-status${search.error ? '.is-error' : ''}`, { role: 'status' }, search.message) : null,
        search.results?.length ? h('ul.wx-results', { 'aria-label': 'Places found' }, search.results.map((place, k) => h('li',
          h('button.wx-result', { type: 'button', dataset: { wx: `result:${k}` }, onclick: () => choose(place) }, icon('pin'), h('span', h('strong', place.name), h('span.muted', place.display_name)))))) : null,
        p.place ? h('p.wx-chosen', icon('pin'), h('span', 'Chosen: ', h('strong', p.place.name), h('span.muted', ` · ${p.place.display_name}`))) : null),
      h('p.field-hint.wx-privacy', icon('shield'), PRIVACY));
    const manual = p.mode !== 'manual' ? null : h('div.wx-manual',
      h('div.wx-choices', { role: 'group', 'aria-label': 'Your weather' }, CHOICES.map(([id, label]) => h('button.wx-choice', { type: 'button', 'aria-pressed': String(p.manual === id), dataset: { wx: `pick:${id}` }, onclick: () => save({ manual: id }) }, icon(kindIcon(id)), h('span', label)))),
      h('div.setting-row', h('div.setting-text', h('strong', 'Windy'), h('span.field-hint', 'Faster clouds and swaying trees.')),
        h('label.switch', { 'aria-label': 'Windy' }, h('input', { type: 'checkbox', checked: p.windy, dataset: { wx: 'windy' }, onchange: event => save({ windy: event.currentTarget.checked }) }), h('span'))),
      h('p.field-hint', 'Your own pick uses no network at all.'));
    ui.clear(node,
      h('h2.panel-title#wx-title', 'City weather'),
      h('div.setting-row', h('div.setting-text', h('strong', 'Weather in the City'), h('span.field-hint', 'Shown on This PC side of the island. Off by default.')),
        h('div.segmented', { role: 'group', 'aria-label': 'City weather' }, Object.entries(MODE_LABEL).map(([mode, label]) => segment(mode, label)))),
      live, manual,
      h('p.field-hint.wx-attribution', 'Weather data: ', h('a', { href: 'https://api.met.no/doc/License', rel: 'noopener' }, 'MET Norway (CC BY 4.0)'), '. Place search: ', h('a', { href: 'https://www.openstreetmap.org/copyright', rel: 'noopener' }, '© OpenStreetMap contributors (ODbL)'), '.'));   // external links open in the browser (app-wide guard)
    if (focused) node.querySelector(`[data-wx="${CSS.escape(focused)}"]`)?.focus();
  }
  store.on('change', () => render());
  render(true);
  return { node, render };
}
