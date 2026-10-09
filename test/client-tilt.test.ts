/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildingSolid, crateSolid, createGroundCache, drawSolids, FACE, FOOT, LIGHT, LIP, MATERIALS, paintSolids, shadowHull, standsUp, wallSolids, type Solid } from '../src/client/tilt.ts';
import { ROYALE, WORLD } from '../src/shared/defs.ts';
import { MAPS } from '../src/shared/maps.ts';

type Call = { name: string; args: number[]; fill: unknown };

function recorder(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args: number[]) => { calls.push({ name: String(prop), args, fill: target.fillStyle }); return { width: 0, addColorStop() {} }; };
    },
    set(target, prop, value) { target[prop] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

Object.assign(globalThis, { document: { createElement: () => ({ getContext: () => recorder().ctx }) } });

test('a solid casts its shadow from its own rect, as far along the light as it is tall', () => {
  const wall: Solid = { kind: 'concrete', x: 100, y: 200, w: 60, h: 20 };
  const p = shadowHull(wall);
  const points = Array.from({ length: p.length / 2 }, (_, i) => [p[i * 2]!, p[i * 2 + 1]!]);
  for (const corner of [[100, 200], [160, 200], [100, 220]]) assert.ok(points.some(([x, y]) => x === corner[0] && y === corner[1]), `keeps the corner ${corner} where the wall stands`);
  const far = Math.max(...points.map(([x, y]) => x + y));
  const crate = shadowHull({ ...wall, kind: 'planter' });
  const crateFar = Math.max(...Array.from({ length: crate.length / 2 }, (_, i) => crate[i * 2]! + crate[i * 2 + 1]!));
  assert.ok(MATERIALS.concrete.height > MATERIALS.planter.height && far > crateFar, 'the taller wall reaches further');
  const [fx, fy] = points.find(([x, y]) => x + y === far)!;
  // The shadow starts where the wall meets the floor: the foot of its front face.
  const len = Math.hypot(fx! - 160, fy! - (220 + FACE.concrete));
  assert.ok(Math.abs((fx! - 160) / len - LIGHT.x / Math.hypot(LIGHT.x, LIGHT.y)) < 1e-9, 'it falls along the light');
  // The sun stands up-screen and a little left, the same for every solid: shadows fall down-screen, leaning right.
  const deg = (Math.atan2(fy! - (220 + FACE.concrete), fx! - 160) * 180) / Math.PI;
  assert.ok(deg > 45 && deg < 60, `the shadow falls ${deg.toFixed(1)} degrees below the horizontal`);
});

test('each top face is exactly its collision rect, and nothing of a solid is drawn past its lip, its front face and the rubble at its foot', () => {
  const { ctx, calls } = recorder();
  const solids: Solid[] = [
    { kind: 'concrete', x: 10, y: 20, w: 300, h: 40 },
    { kind: 'planter', x: 400, y: 80, w: 44, h: 44, wear: 0.5 },
    { kind: 'brick', x: 500, y: 500, w: 50, h: 50, wear: 0 },
  ];
  paintSolids(ctx, solids);
  for (const s of solids) {
    assert.ok(calls.some((c) => c.name === 'rect' && c.args.join() === [s.x, s.y, s.w, s.h].join()), `${s.kind} top at its rect`);
  }
  const reach = (x: number, y: number) => solids.some((s) => x >= s.x && x <= s.x + s.w + LIP && y >= s.y && y <= s.y + s.h + FOOT);
  for (const c of calls) {
    if (c.name === 'rect' || c.name === 'fillRect') assert.ok(reach(c.args[0]!, c.args[1]!) && reach(c.args[0]! + c.args[2]!, c.args[1]! + c.args[3]!), `${c.name} ${c.args} stays within the lip`);
    if (c.name === 'moveTo' || c.name === 'lineTo') assert.ok(reach(c.args[0]!, c.args[1]!), `${c.name} ${c.args} stays within the lip`);
  }
  const lip = calls.findIndex((c) => c.name === 'rect' && c.args[0] === 10 + LIP / 2);
  const top = calls.findIndex((c) => c.name === 'rect' && c.args.join() === '10,20,300,40');
  assert.ok(lip >= 0 && lip < top, 'the lips are laid before any top, so nearer solids cover the lips behind them');
});

test('drawSolids blits one cached sprite per solid, farthest first, and paints each solid only once', () => {
  const { ctx, calls } = recorder();
  const near: Solid = { kind: 'concrete', x: 0, y: 400, w: 100, h: 50 }, far: Solid = { kind: 'sandstone', x: 0, y: 100, w: 100, h: 50 };
  drawSolids(ctx, [near, far]);
  const images = calls.filter((c) => c.name === 'drawImage');
  assert.equal(images.length, 2);
  assert.ok(images[0]!.args[2]! < images[1]!.args[2]!, 'the farther wall is laid first');
  const strokes = calls.filter((c) => c.name === 'stroke').length;
  drawSolids(ctx, [near, far]);
  assert.equal(calls.filter((c) => c.name === 'drawImage').length, 4, 'the second frame blits again');
  assert.equal(calls.filter((c) => c.name === 'stroke').length, strokes, 'but paints nothing new');
});

test('the ground layer paints and traces the map once per layout and re-blurs only when the squad builds or loses something', () => {
  const { ctx } = recorder();
  Object.assign(globalThis, { document: { createElement: () => ({ getContext: () => ctx }) } });
  const cache = createGroundCache();
  let traced = 0;
  const map = [{ kind: 'concrete', x: 0, y: 0, w: 100, h: 20 }] satisfies Solid[];
  const statics = () => { traced++; return map; };
  const layout = {};
  const wall = (x: number): Solid => ({ kind: 'brick', x, y: 50, w: 50, h: 50 });
  cache.get(layout, 3000, statics, []);
  cache.get(layout, 3000, statics, []);
  assert.deepEqual([cache.bakes(), traced], [1, 1], 'an unchanged frame reuses the layer');
  cache.get(layout, 3000, statics, [wall(100)]);
  cache.get(layout, 3000, statics, [{ ...wall(100), wear: 0.8 }]);
  assert.deepEqual([cache.bakes(), traced], [2, 1], 'a new building re-blurs once; wear alone changes nothing; the map is not traced again');
  cache.get(layout, 3000, statics, []);
  assert.equal(cache.bakes(), 3, 'losing the building re-blurs');
  cache.get({}, 3000, statics, []);
  assert.deepEqual([cache.bakes(), traced], [4, 2], 'a new layout traces the map again');
});

test('a map wall is drawn in its own material whatever its shape, and a built wall in slate', () => {
  const long = { x: 0, y: 0, w: 400, h: 40 }, square = { x: 0, y: 0, w: 100, h: 100 };
  const kinds = wallSolids([
    { ...long, built: false, material: 'sandstone' }, { ...square, built: false, material: 'concrete' }, { ...square, built: true },
  ]).map((s) => s.kind);
  assert.deepEqual(kinds, ['sandstone', 'concrete', 'slate']);
  const poly = { ...square, built: false as const, material: 'concrete' as const, pts: [0, 0, 100, 0, 50, 80], pid: 0 };
  assert.deepEqual(wallSolids([poly, { ...long, built: false, material: 'sandstone' }]).map((s) => s.kind), ['sandstone'], 'a polygon part is left to the polygon art, never drawn as its bounding box');
});

test('crates show their wear, a squad wall its upgrade, and a spike strip lies flat', () => {
  assert.deepEqual(crateSolid({ id: 1, x: 10, y: 20, hp: WORLD.crateHp / 4, size: 40 }), { kind: 'crate', x: 10, y: 20, w: 40, h: 40, wear: 0.75 });
  assert.equal(crateSolid({ id: 2, x: 0, y: 0, hp: ROYALE.dropHp, size: 60, drop: true }).wear, 0, 'a full supply drop is unmarked');
  assert.equal(crateSolid({ id: 2, x: 0, y: 0, hp: ROYALE.dropHp, size: 60, drop: true }).kind, 'supply');
  const wall = (lv?: number) => buildingSolid({ kind: 'wall', cx: 3, cy: 4, hp: 10, ...(lv ? { lv } : {}) } as never).kind;
  assert.deepEqual([wall(), wall(2), wall(3)], ['wood', 'sandbag', 'steel']);
  assert.equal(buildingSolid({ kind: 'wall', cx: 3, cy: 4, hp: 4 } as never).wear, 0.6);
  assert.equal(standsUp({ kind: 'spikes', cx: 0, cy: 0, hp: 10 } as never), false);
  assert.equal(standsUp({ kind: 'wall', cx: 0, cy: 0, hp: 10 } as never), true);
});

test('Outpost keeps the look its shapes gave it: blocky walls sandstone, long walls concrete', () => {
  const kinds = new Map(wallSolids(MAPS.outpost.walls.map((w) => ({ ...w, built: false }))).map((s) => [`${s.w}x${s.h}`, s.kind]));
  assert.equal(kinds.get('100x100'), 'sandstone');
  assert.equal(kinds.get('150x50'), 'concrete');
  assert.equal(kinds.get('50x200'), 'concrete');
});

test('a static map\'s ground baked ahead in slices is taken whole by the cache, which then bakes nothing itself', async () => {
  const { prepareGround, mapSolids, groundLayerSide } = await import('../src/client/tilt.ts');
  const { floorPlanOf } = await import('../src/client/floor.ts');
  const made: { width: number; height: number }[] = [];
  const g = globalThis as Record<string, unknown>;
  const had = g.document;
  // Canvases that count themselves, with a context whose every call costs the clock a little and whose flush costs a lot.
  let t = 0;
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'getTransform') return () => ({ a: 0.5, b: 0, c: 0, d: 0.5, e: 60, f: 60 });
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'getImageData') return () => { t += 1; return { data: new Uint8ClampedArray(4) }; };
      if (typeof prop === 'string' && prop.startsWith('create')) return () => ({ addColorStop() {}, setTransform() {} });
      return () => { t += 0.0002; };
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  g.document = { createElement: () => { const c = { width: 0, height: 0, getContext: () => ctx }; made.push(c); return c; } };
  const hadPath = g.Path2D;
  g.Path2D = class { rect() {} };
  try {
    const walls = MAPS.oldtown.walls.map((w) => ({ ...w, built: false as const, material: 'concrete' as const }));
    const size = MAPS.oldtown.size;
    const prep = prepareGround(size, mapSolids(size, walls), floorPlanOf('oldtown'));
    let slices = 0, worst = 0;
    while (!prep.done && slices < 100_000) { const t0 = t; prep.step(4, () => t); worst = Math.max(worst, t - t0); slices++; }
    assert.equal(prep.done, true, `the bake finishes (${slices} slices)`);
    assert.ok(slices > 5, 'in many slices');
    assert.ok(worst <= 4 + 1, `each slice keeps to about its 4 ms (worst ${worst.toFixed(2)})`);
    const layer = made.find((c) => c.width === groundLayerSide(size))!;
    const before = made.length;
    const cache = createGroundCache();
    const got = cache.get('oldtown|walls', size, () => mapSolids(size, walls), 'static', floorPlanOf('Old Town'));
    assert.equal(got.canvas, layer, 'the cache takes the baked layer');
    assert.equal(made.length, before, 'and makes no canvas of its own: nothing is baked in the frame');
    const again = createGroundCache().get('oldtown|walls', size, () => mapSolids(size, walls), 'static', floorPlanOf('oldtown'));
    assert.notEqual(again.canvas, layer, 'a bake is taken once');
    assert.equal(made.filter((c, i) => i >= before && c.width === groundLayerSide(size)).length, 1, 'a ground nobody baked ahead is baked in one canvas, as before');
  } finally {
    g.document = had;
    g.Path2D = hadPath;
  }
});
