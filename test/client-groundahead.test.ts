/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { peekWorld } from '../src/client/attractsim.ts';
import { createGroundAhead, type GroundWorkerLike } from '../src/client/groundahead.ts';
import type { FromGround, ToGround } from '../src/client/groundworker.ts';
import type { GroundPrep } from '../src/client/tilt.ts';

function fakeWorker() {
  const sent: ToGround[] = [];
  const w: GroundWorkerLike & { sent: ToGround[]; reply(m: FromGround): void; terminated: boolean } = {
    sent, terminated: false, onmessage: null, onerror: null,
    postMessage(m) { sent.push(m); },
    terminate() { this.terminated = true; },
    reply(m) { this.onmessage?.({ data: m }); },
  };
  return w;
}
const image = () => { const i = { closed: false, close() { i.closed = true; } }; return i as unknown as ImageBitmap & { closed: boolean }; };
const slicedLog: string[] = [];
const sliced = (w: { map: string }): GroundPrep => { slicedLog.push(w.map); let left = 3; return { step: () => --left <= 0, get done() { return left <= 0; }, last: undefined, cancel() {} }; };

test('the ground bakes in a worker: the page does no work for it but take the finished bitmap', () => {
  const wk = fakeWorker();
  const offered: unknown[] = [];
  const ahead = createGroundAhead({ spawn: () => wk, sliced, offer: (_w, img) => { offered.push(img); return () => {}; } });
  const world = peekWorld({ seed: 1, map: 'plaza', bots: 8 });
  const prep = ahead.prepare(world);
  assert.equal(wk.sent.length, 1);
  assert.deepEqual([wk.sent[0]!.t, wk.sent[0]!.map, wk.sent[0]!.size], ['bake', 'plaza', world.worldSize]);
  assert.equal(prep.step(4, () => 0), false, 'a step does nothing while the worker bakes');
  assert.equal(prep.done, false);
  const img = image();
  wk.reply({ t: 'baked', id: wk.sent[0]!.id, image: img, ms: 900 });
  assert.equal(prep.done, true);
  assert.deepEqual(offered, [img], 'the bitmap goes to the ground cache');
  assert.equal(prep.via, 'worker');
  assert.equal(slicedLog.length, 0, 'nothing was baked on the page');
  // A bake let go before the worker answers frees its bitmap and offers nothing.
  const late = ahead.prepare(peekWorld({ seed: 1, map: 'museum', bots: 8 }));
  late.cancel();
  const img2 = image();
  wk.reply({ t: 'baked', id: wk.sent[1]!.id, image: img2, ms: 900 });
  assert.equal(img2.closed, true);
  assert.equal(offered.length, 1);
  ahead.close();
  assert.equal(wk.terminated, true);
});

test('without a 2D OffscreenCanvas, or when the worker fails, the ground bakes on the page in slices instead', () => {
  slicedLog.length = 0;
  const none = createGroundAhead({ spawn: () => null, sliced, offer: () => () => {} });
  const a = none.prepare(peekWorld({ seed: 1, map: 'oldtown', bots: 8 }));
  assert.equal(a.via, 'slices');
  assert.deepEqual(slicedLog, ['oldtown']);
  while (!a.done) a.step(4, () => 0);
  const wk = fakeWorker();
  const failing = createGroundAhead({ spawn: () => wk, sliced, offer: () => () => {} });
  const b = failing.prepare(peekWorld({ seed: 1, map: 'subpen', bots: 8 }));
  wk.reply({ t: 'error', id: wk.sent[0]!.id, message: 'no 2d OffscreenCanvas' });
  assert.equal(b.via, 'slices', 'an error falls back');
  assert.equal(wk.terminated, true, 'and the worker is not asked again');
  failing.prepare(peekWorld({ seed: 1, map: 'market', bots: 8 }));
  assert.deepEqual(slicedLog, ['oldtown', 'subpen', 'market']);
  assert.equal(wk.sent.length, 1);
});

test('the worker\'s floor plan comes back with its bitmap, so the page never plans a big map\'s decor in a frame', async () => {
  const { MAPS } = await import('../src/shared/maps.ts');
  const { floorPlan, floorPlanOf, portablePlan } = await import('../src/client/floor.ts');
  const made = floorPlan(MAPS.oldtown);
  assert.ok(made.decor, 'Old Town has decor to plan (the dear part)');
  const wk = fakeWorker();
  const ahead = createGroundAhead({ spawn: () => wk, sliced, offer: () => () => {} });
  ahead.prepare(peekWorld({ seed: 1, map: 'oldtown', bots: 8 }));
  wk.reply({ t: 'baked', id: wk.sent[0]!.id, image: image(), ms: 1, plan: structuredClone(portablePlan(made)) });
  const t0 = performance.now();
  const byName = floorPlanOf(MAPS.oldtown.name)!;
  assert.ok(performance.now() - t0 < 20, 'taken, not planned again');
  assert.equal(byName.walls, MAPS.oldtown.walls, 'with the map\'s own walls, which the ground cache knows a layer by');
  assert.deepEqual(byName.decor!.fixtures, made.decor!.fixtures);
  assert.deepEqual(byName.decor!.marks, made.decor!.marks);
  assert.equal(floorPlanOf('oldtown'), byName, 'one plan per map, by id or by name');
});
