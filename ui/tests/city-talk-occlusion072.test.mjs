import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
import { talkOccludingPeople } from '../app/city/talk-occlusion.js';

globalThis.window ||= {};
globalThis.document ||= { compatMode: 'CSS1Compat' };
globalThis.localStorage ||= { getItem: () => null };
const { CityView } = await import('../app/views/city.js');

test('moving bystanders cut away only while in front of a conversation participant', () => {
  const camera = new THREE.PerspectiveCamera(40, 1.6, .05, 100);
  camera.position.set(0, 1.2, 8); camera.lookAt(0, 1, 0);
  const person = (x, z) => { const object = new THREE.Group(); object.position.set(x, 0, z); return { object, topY: 1.8 }; };
  const owner = person(-1.2, 0), agent = person(1.2, 0);
  const crossing = person(1.0, 2), behind = person(1.2, -2), beside = person(-5, 0), offCamera = person(1.2, 12);
  assert.deepEqual([...talkOccludingPeople(camera, [owner, agent], [crossing, behind, beside, offCamera])], [crossing.object]);
  crossing.object.position.x = -1;
  assert.deepEqual([...talkOccludingPeople(camera, [owner, agent], [crossing])], [crossing.object], 'the same passer-by can cross in front of the owner');
  crossing.object.position.x = 5;
  assert.equal(talkOccludingPeople(camera, [owner, agent], [crossing]).size, 0, 'it returns when the shot is clear');
  const partial = person(1.65, -.1); partial.object.rotation.y = Math.PI / 2;
  assert.deepEqual([...talkOccludingPeople(camera, [owner, agent], [partial])], [partial.object],
    'a shoulder can cover the speaker even when the bystander centre is slightly behind it');
  assert.equal(crossing.object.visible, true, 'projection does not change simulation or visibility itself');
});

test('City restores a crossing figure after it clears the shot and when leaving talk', () => {
  const camera = new THREE.PerspectiveCamera(40, 1.6, .05, 100);
  camera.position.set(0, 1.2, 8); camera.lookAt(0, 1, 0);
  const person = (x, z) => { const object = new THREE.Group(); object.position.set(x, 0, z); return { object, topY: 1.8 }; };
  const owner = person(-1.2, 0), agent = person(1.2, 0), passer = person(1, 2), alreadyHidden = person(-1, 2);
  alreadyHidden.object.visible = false;
  const npcs = { owner: { person: owner, path: [] }, npcs: new Map([
    ['agent', { id: 'agent', person: agent }], ['passer', { id: 'passer', person: passer }],
    ['hidden', { id: 'hidden', person: alreadyHidden }],
  ]), personOf: () => agent, releaseTalkSpot() {}, hold() {} };
  const view = Object.assign(Object.create(CityView.prototype), { world: { camera, side: 'pc' }, npcs });
  const talk = { id: 'agent' };
  view.updateTalkPeople(talk);
  assert.equal(passer.object.visible, false); assert.equal(agent.object.visible, true); assert.equal(owner.object.visible, true);
  passer.object.position.x = 5; view.updateTalkPeople(talk);
  assert.equal(passer.object.visible, true, 'walking continues and the person returns after crossing');
  passer.object.position.x = 1; view.updateTalkPeople(talk); view.releaseTalk(talk);
  assert.equal(passer.object.visible, true, 'Leave restores the last crossing figure');
  assert.equal(alreadyHidden.object.visible, false, 'preexisting visibility is respected');
  assert.equal(talk.hiddenPeople.size, 0);
});
