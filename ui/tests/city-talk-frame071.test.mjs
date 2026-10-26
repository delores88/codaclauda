import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from '../app/city/toon.js';
globalThis.window = {};
globalThis.localStorage = { getItem: () => null };
const { fitTalkShot, talkVisibleRect, talkWallHits, talkFigureTargets, talkSceneMeshes, talkSceneHits, cutawayTalkMeshes } = await import('../app/city/talk-frame.js');
const { talkSpot } = await import('../app/city/talk.js');

test('both full figures fit left of desktop chat and above the visible phone sheet', () => {
  for (const [width, height, visibleWidth, panel] of [
    [1524, 900, 1524, { left: 1124, top: 0, width: 400, height: 900 }],
    [1280, 800, 1280, { left: 880, top: 0, width: 400, height: 800 }],
    [640, 760, 390, { left: 0, top: 334, width: 390, height: 426 }],
    [640, 760, 320, { left: 0, top: 334, width: 320, height: 426 }],
  ]) for (const yaw of [0, .7, -1.9]) {
    const agent = { x: 12, y: .24, z: 22 }, ownerHeight = 2.1, agentHeight = 1.9;
    const spot = talkSpot(agent, { x: agent.x + Math.sin(yaw) * 4, z: agent.z + Math.cos(yaw) * 4 });
    const vis = talkVisibleRect({ width, height, visibleWidth, panel });
    const face = { ...agent, y: agent.y + 1.6 };
    const shot = fitTalkShot(spot, face, { width, height, vis, ownerHeight, agentHeight, ownerY: .24, agentY: .24 });
    const camera = new THREE.PerspectiveCamera(40, width / height, .05, 10000);
    camera.position.set(shot.eye.x, shot.eye.y, shot.eye.z); camera.lookAt(shot.look.x, shot.look.y, shot.look.z); camera.updateMatrixWorld(true);
    for (const [p, top] of [[spot, ownerHeight], [agent, agentHeight]]) for (const x of [-.5, .5]) for (const z of [-.4, .4]) for (const y of [0, top]) {
      const n = new THREE.Vector3(p.x + x, .24 + y, p.z + z).project(camera);
      const px = (n.x + 1) * width / 2, py = (1 - n.y) * height / 2;
      assert.ok(px >= vis.x0 && px <= vis.x1 && py >= vis.y0 && py <= vis.y1, `${width}/${visibleWidth}: ${px}, ${py} outside ${JSON.stringify(vis)}`);
    }
  }
});

test('wider shoulder shot separates both head silhouettes and reserves space for bubbles', () => {
  for (const [width, height, visibleWidth, panel] of [
    [1524, 944, 1524, { left: 1124, top: 0, width: 400, height: 944 }],
    [1280, 800, 1280, { left: 880, top: 0, width: 400, height: 800 }],
    [640, 788, 314, { left: 0, top: 347, width: 314, height: 441 }],
    [640, 760, 320, { left: 0, top: 334, width: 320, height: 426 }],
  ]) for (const [ownerHeight, agentHeight] of [[1.74, 1.98], [2.1, 1.9], [1.8, 2.4]]) for (const yaw of [0, .7, -1.9]) {
    const agent = { x: 12, z: 22 }, ground = .24;
    const spot = talkSpot(agent, { x: agent.x + Math.sin(yaw) * 4, z: agent.z + Math.cos(yaw) * 4 });
    const face = { ...agent, y: ground + agentHeight * .72 };
    const vis = talkVisibleRect({ width, height, visibleWidth, panel });
    const shot = fitTalkShot(spot, face, { width, height, vis, ownerHeight, agentHeight, ownerY: ground, agentY: ground });
    const camera = new THREE.PerspectiveCamera(40, width / height, .05, 10000);
    camera.position.set(shot.eye.x, shot.eye.y, shot.eye.z); camera.lookAt(shot.look.x, shot.look.y, shot.look.z); camera.updateMatrixWorld(true);
    const heads = [[spot, ownerHeight], [agent, agentHeight]].map(([p, top]) => {
      const pixels = [];
      for (const dx of [-.5, .5]) for (const dz of [-.5, .5]) for (const dy of [top * .6, top]) {
        const n = new THREE.Vector3(p.x + dx, ground + dy, p.z + dz).project(camera);
        pixels.push({ x: (n.x + 1) * width / 2, y: (1 - n.y) * height / 2 });
      }
      return { left: Math.min(...pixels.map(p => p.x)), right: Math.max(...pixels.map(p => p.x)), top: Math.min(...pixels.map(p => p.y)) };
    });
    const [owner, npc] = heads, roomW = vis.x1 - vis.x0, roomH = vis.y1 - vis.y0;
    assert.ok(owner.right + 8 < npc.left, 'the owner head must not cover the agent face or upper body');
    assert.ok((owner.left + owner.right) / 2 < vis.x0 + roomW * .46, 'owner stays in the left part of the free view');
    assert.ok((npc.left + npc.right) / 2 > vis.x0 + roomW * .6, 'agent stays centre-right');
    assert.ok(Math.min(owner.top, npc.top) >= vis.y0 + Math.min(roomW < 450 ? 90 : 80, roomH * (roomW < 450 ? .4 : .3)), 'space above both heads is reserved for bubbles');
    assert.ok(shot.eye.y > ground + ownerHeight, 'camera looks down slightly from above the owner');
  }
});

test('talk spot avoids occupied walls and remains inside the island', () => {
  const boxes = [{ x0: -1, x1: 1, z0: 1, z1: 4 }];
  const spot = talkSpot({ x: 0, z: 0 }, { x: 0, z: 5 }, { boxes, limit: 8 });
  assert.ok(Math.abs(spot.x) <= 8 && Math.abs(spot.z) <= 8);
  assert.ok(!boxes.some(b => spot.x > b.x0 && spot.x < b.x1 && spot.z > b.z0 && spot.z < b.z1));
});

test('final camera and sightline collision detect a wall even when the short staging spot was clear', () => {
  const boxes = [{ x0: -2, x1: 2, y0: 0, y1: 8, z0: 3, z1: 6 }];
  const head = { x: 0, y: 1.5, z: 0 };
  assert.equal(talkWallHits({ x: 0, y: 1.5, z: 2 }, [head], boxes), 0);
  assert.equal(talkWallHits({ x: 0, y: 1.5, z: 5 }, [head], boxes), 1);
  assert.equal(talkWallHits({ x: 0, y: 1.5, z: 9 }, [head], boxes), 1);
  assert.equal(talkWallHits({ x: 6, y: 1.5, z: 2 }, [head], boxes), 0);
});

test('decorative geometry remains an occluder even when pointer picking is disabled; cutaway restores shared materials', () => {
  const root = new THREE.Group(), material = new THREE.MeshBasicMaterial({ color: 'green' });
  const foliage = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 1), material);
  foliage.position.set(0, 1.5, 3); foliage.raycast = () => {};
  const outline = new THREE.Mesh(foliage.geometry, material); outline.userData.outline = true; foliage.add(outline);
  const ignored = new THREE.Group(), actor = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 1), material);
  actor.position.set(0, 1.5, 1); ignored.add(actor); root.add(foliage, ignored);
  const meshes = talkSceneMeshes(root, [ignored]); assert.deepEqual(meshes, [foliage]);
  const hits = talkSceneHits(meshes, { x: 0, y: 1.5, z: 8 }, [{ x: 0, y: 1.5, z: 0 }]);
  assert.deepEqual([...hits], [foliage]);
  const restore = cutawayTalkMeshes(hits), copy = foliage.material; let disposed = 0;
  copy.addEventListener('dispose', () => disposed++);
  assert.equal(copy.opacity, .10); assert.equal(material.opacity, 1); assert.equal(outline.visible, false);
  assert.equal(actor.material, material);
  restore(); assert.equal(foliage.material, material); assert.equal(outline.visible, true); assert.equal(disposed, 1);
  foliage.geometry.dispose(); actor.geometry.dispose(); material.dispose();
});

test('face silhouette rays detect a narrow off-centre lamp that the face-centre ray misses', () => {
  const eye = { x: 0, y: 1.5, z: 8 }, position = { x: 0, y: 0, z: 0 }, face = { x: 0, y: 1.5, z: 0 };
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(.09, 2, .15), new THREE.MeshBasicMaterial());
  lamp.position.set(.125, 1.2, 4); lamp.raycast = () => {};
  const root = new THREE.Group(); root.add(lamp);
  const meshes = talkSceneMeshes(root), targets = talkFigureTargets(eye, position, 1.5);
  assert.equal(talkSceneHits(meshes, eye, [face]).size, 0, 'a single centre ray misses the lamp beside the eye');
  assert.deepEqual([...talkSceneHits(meshes, eye, targets)], [lamp], 'silhouette rays include the obscured half of the face');
  const restore = cutawayTalkMeshes(talkSceneHits(meshes, eye, targets));
  assert.equal(lamp.material.opacity, .10);
  restore(); assert.equal(lamp.material.opacity, 1);
  lamp.geometry.dispose(); lamp.material.dispose();
});
