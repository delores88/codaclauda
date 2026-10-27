import test from 'node:test';
import assert from 'node:assert/strict';
import { createStandIn } from '../app/city/npc.js';
globalThis.window ||= {};
globalThis.document ||= { compatMode: 'CSS1Compat' };
globalThis.localStorage ||= { getItem: () => null, setItem() {} };
const { CityView } = await import('../app/views/city.js');

test('talk hides only its participants markers and restores current status on exit or switch', t => {
  const people = new Map(['owner', 'selected', 'neighbor'].map(id => [id, createStandIn({}, { role: id === 'owner' ? 'owner' : 'agent' })]));
  t.after(() => { for (const p of people.values()) p.dispose(); });
  const gem = id => people.get(id).object.children.find(n => n.geometry?.type === 'OctahedronGeometry');
  const view = Object.assign(Object.create(CityView.prototype), {
    npcs: { personOf: target => people.get(target.kind === 'owner' ? 'owner' : target.id) },
  });
  view.setTalkMarkers({ id: 'selected' }, true);
  assert.equal(gem('owner').visible, false);
  assert.equal(gem('selected').visible, false);
  assert.equal(gem('neighbor').visible, true);
  people.get('selected').setStatus('active');
  assert.equal(gem('selected').visible, false, 'a reply status change cannot restore the floating marker');
  view.setTalkMarkers({ id: 'selected' }, false);
  view.setTalkMarkers({ id: 'neighbor' }, true);
  assert.equal(gem('selected').visible, true);
  assert.equal(gem('neighbor').visible, false);
  assert.equal(gem('owner').visible, false, 'owner has no status marker to restore');
  view.setTalkMarkers({ id: 'neighbor' }, false);
  assert.equal(gem('neighbor').visible, true);
});
