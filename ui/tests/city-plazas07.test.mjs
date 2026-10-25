import assert from 'node:assert/strict';
import test from 'node:test';
import { THREE } from '../app/city/toon.js';
import { downtownPlazaPlan, buildDecor, BENCH_OFFSET } from '../app/city/scenery.js';
import { LOT_HALF, islandHalf } from '../app/city/layout.js';
import { disposeAll } from '../app/city/fx.js';

test('Downtown plaza plans are stable, varied, and stay inside their vacant lots', () => {
  const variants = new Set(); let fountains = 0;
  for (let i = -4; i <= 4; i++) for (let j = -4; j < 0; j++) {
    const plan = downtownPlazaPlan(i, j);
    assert.deepEqual(downtownPlazaPlan(i, j), plan);
    variants.add(plan.variant); fountains += Number(plan.fountain);
    assert.ok(plan.planters.length >= 2 && plan.planters.length <= 3);
    assert.ok(plan.benches.length >= 1 && plan.benches.length <= 2);
    for (const p of plan.planters) {
      assert.ok(Math.abs(p.x) + 0.725 < LOT_HALF);
      assert.ok(Math.abs(p.z) + 0.725 < LOT_HALF);
      assert.ok(p.scale <= 0.725);
      assert.ok(j * 16 + p.z + 0.725 < -10.3, 'planters never intrude into the railway corridor');
    }
  }
  assert.equal(variants.size, 4);
  assert.ok(fountains > 0 && fountains < 18, 'fountains are occasional');
});

test('occupied Downtown lots keep their existing bench and leave tower space clear', () => {
  const plan = downtownPlazaPlan(2, -1, true);
  assert.deepEqual(plan.planters, []);
  assert.equal(plan.fountain, false);
  assert.deepEqual(plan.benches, [[BENCH_OFFSET.x, BENCH_OFFSET.z, 0]]);
});

test('Downtown hardscape uses bounded merged draws, does not intercept picking, and disposes', () => {
  for (const rings of [1, 3]) {
    const decor = buildDecor(rings, new Map(), islandHalf(rings), { districts: true });
    const urban = decor.getObjectByName('downtown-plazas');
    assert.ok(urban);
    assert.ok(urban.children.length <= 6, 'hardscape batches do not grow with lot count');
    const hits = [];
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 20, -16), new THREE.Vector3(0, -1, 0));
    ray.intersectObject(decor, true, hits);
    assert.deepEqual(hits, []);
    let disposed = 0;
    for (const child of urban.children) child.geometry.addEventListener('dispose', () => disposed++);
    disposeAll(decor);
    assert.equal(disposed, urban.children.length);
  }
});

test('contributor islands retain the existing park scenery', () => {
  const decor = buildDecor(1, new Map(), islandHalf(1));
  assert.equal(decor.getObjectByName('downtown-plazas'), undefined);
  disposeAll(decor);
});
