import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';

globalThis.window ||= {};
globalThis.document ||= { compatMode: 'CSS1Compat' };
globalThis.localStorage ||= { getItem: () => null, setItem() {} };
const { CityView } = await import('../app/views/city.js');

function bubble() {
  const style = { setProperty(name, value) { this[name] = value; } };
  return { node: { hidden: false, style, dataset: {}, offsetWidth: 150, offsetHeight: 50 }, until: Infinity };
}

function fixture({ ownerX = 350, selectedX = 55, selected = 'sess:selected' } = {}) {
  // Distinct projected positions make an unrelated nearby person an observable
  // wrong anchor. Keep it first in the registry to catch first-agent fallback.
  const positions = new Map([
    ['decoy', { x: -1, y: 0, z: 0 }],
    ['owner', { x: (ownerX - 200) / 40, y: 0, z: 0 }],
    ['sess:selected', { x: (selectedX - 200) / 40, y: 0, z: 0 }],
    ['sess:second', { x: -.5, y: 0, z: 0 }],
  ]);
  const queried = [], bubbles = { owner: bubble(), agent: bubble() };
  const camera = new THREE.PerspectiveCamera(40, 1, .05, 100);
  camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const project = (p, out) => { out.x = p.x * 40 + 200; out.y = 300 - p.y * 20; return out; };
  const view = Object.assign(Object.create(CityView.prototype), {
    talk: { id: selected, vis: { x0: 20, x1: 380, y0: 40, y1: 380 } },
    talkBubbles: bubbles, facesUp: () => true,
    allAgents: () => [...positions.keys()].filter(id => id !== 'owner').map(id => ({ id })),
    npcs: {
      position(target) { const id = target.kind === 'owner' ? 'owner' : target.id; queried.push(id); return positions.get(id) || null; },
      topHeight: target => target.kind === 'owner' ? 1.8 : 2.2,
    },
    world: { camera, size: { w: 400, h: 400 }, toWorld(p, { out }) { return out.copy(p); }, project },
  });
  return { view, bubbles, positions, queried,
    place() { queried.length = 0; view.placeTalkBubbles(new THREE.Vector3(), { x: 0, y: 0 }); },
    projectedX(id) { return project(positions.get(id), {}).x; },
    projectedHeadY(id) { const p = positions.get(id); return project({ ...p, y: p.y + (id === 'owner' ? 1.8 : 2.2) }, {}).y; },
  };
}

function tailX(b) {
  const centre = Number(b.node.style.transform.match(/translate3d\(([-.\d]+)px/)[1]);
  const offset = Number.parseFloat(b.node.style['--talk-tail-x']);
  assert.ok(Number.isFinite(offset), 'the tail must have an explicit anchor-derived offset');
  return centre - b.node.offsetWidth / 2 + offset;
}

function tailY(b) {
  const bottom = Number(b.node.style.transform.match(/translate3d\([-.\d]+px, ([-.\d]+)px/)[1]);
  const height = Number.parseFloat(b.node.style['--talk-tail-height']);
  assert.ok(Number.isFinite(height), 'the tail must reach its head instead of stopping at a fixed length');
  return bottom + height;
}

for (const [ownerX, selectedX] of [[70, 330], [350, 55]]) {
  test(`production bubbles keep owner and selected-agent anchors through clamping and sorting (${ownerX}, ${selectedX})`, () => {
    const f = fixture({ ownerX, selectedX }); f.place();
    assert.deepEqual(new Set(f.queried), new Set(['owner', 'sess:selected']));
    for (const [who, id] of [['owner', 'owner'], ['agent', 'sess:selected']]) {
      assert.notEqual(f.bubbles[who].node.style.visibility, 'hidden');
      assert.ok(Math.abs(tailX(f.bubbles[who]) - f.projectedX(id)) < .15, `${who} points to its own figure`);
      assert.ok(Math.abs(tailY(f.bubbles[who]) - (f.projectedHeadY(id) - 5)) < .15, `${who} tail ends just above its own head`);
      assert.ok(Math.abs(tailX(f.bubbles[who]) - f.projectedX('decoy')) > 20, 'a nearby figure never acquires the bubble');
    }
  });
}

test('pending talk without its NPC keeps the owner anchor and hides the missing-agent bubble', () => {
  const f = fixture({ selected: 'pending-talk:1' });
  f.view.talk.pending = { projectId: 'local:fixture' }; f.place();
  assert.deepEqual(new Set(f.queried), new Set(['owner', 'pending-talk:1']));
  assert.notEqual(f.bubbles.owner.node.style.visibility, 'hidden');
  assert.ok(Math.abs(tailX(f.bubbles.owner) - f.projectedX('owner')) < .15);
  assert.ok(Math.abs(tailY(f.bubbles.owner) - (f.projectedHeadY('owner') - 5)) < .15);
  assert.equal(f.bubbles.agent.node.style.visibility, 'hidden');
  assert.equal(f.bubbles.agent.node.style.transform, undefined, 'no stale owner/nearby position is used for an absent NPC');
});

test('switching conversations reanchors only the agent bubble to the new exact NPC', () => {
  const f = fixture(); f.place();
  const ownerBefore = tailX(f.bubbles.owner), priorAgent = tailX(f.bubbles.agent);
  f.view.talk.id = 'sess:second'; f.place();
  assert.deepEqual(new Set(f.queried), new Set(['owner', 'sess:second']));
  assert.ok(Math.abs(tailX(f.bubbles.owner) - ownerBefore) < .15);
  assert.ok(Math.abs(tailX(f.bubbles.agent) - f.projectedX('sess:second')) < .15);
  assert.ok(Math.abs(tailY(f.bubbles.owner) - (f.projectedHeadY('owner') - 5)) < .15);
  assert.ok(Math.abs(tailY(f.bubbles.agent) - (f.projectedHeadY('sess:second') - 5)) < .15);
  assert.ok(Math.abs(tailX(f.bubbles.agent) - priorAgent) > 100);
});
