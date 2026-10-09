/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TURRET_KINDS, ZOM, type BuildingKind } from '../src/shared/defs.ts';
import type { BuildingView, GameEvent, RunView, Snapshot } from '../src/shared/protocol.ts';
import { createPool } from '../src/client/particles.ts';
import { BAD_AT, drawTurret, lampStutters, turretBakes, wearStage, WORN_AT } from '../src/client/turretart.ts';
import { drawSiegeTops } from '../src/client/siege.ts';
import { createSiegeFx, SIEGE_CAP, updateBuildings, updateWrecks, WRECK_SMOKE_PER_SEC } from '../src/client/siegefx.ts';
import { drawWrecks, noteWrecks, WRECK, wreckAlpha, wreckHeat, type Wreck } from '../src/client/wrecks.ts';

/** A 2D context that only notes calls, and a document whose canvases hand it out. */
function fakeCanvas() {
  const calls: string[] = [];
  const ctx: CanvasRenderingContext2D = new Proxy({} as Record<string, unknown>, {
    get: (_, name: string) => {
      if (name === 'canvas') return { width: 64, height: 64 };
      if (name === 'getTransform') return () => ({ a: 2 });
      return (...args: unknown[]) => { calls.push(name); void args; return { addColorStop() {} }; };
    },
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
  Object.assign(globalThis, { document: { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) } });
  return { ctx, calls };
}

const run = (phase: RunView['phase']) => ({ phase } as RunView);
const snap = (phase: RunView['phase'], buildings: BuildingView[], events: GameEvent[] = []) => ({ run: run(phase), buildings, events } as Pick<Snapshot, 'run' | 'buildings' | 'events'>);
const b = (kind: BuildingKind, cx: number, cy: number, hp = 1): BuildingView => ({ kind, cx, cy, hp, ...(kind !== 'wall' && kind !== 'depot' && kind !== 'post' && kind !== 'spikes' && { ammo: 5 }) }) as BuildingView;
const boomAt = (cx: number, cy: number): GameEvent => ({ e: 'boom', x: (cx + 0.5) * ZOM.cell, y: (cy + 0.5) * ZOM.cell, r: ZOM.cell / 2 }) as GameEvent;
const view = { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 };

test('each health band maps to its state: sound over half, worn at half, badly damaged at 30% and under', () => {
  assert.equal(WORN_AT, 5);
  assert.equal(BAD_AT, 3);
  assert.deepEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(wearStage), [0, 0, 0, 0, 0, 1, 1, 2, 2, 2]);
});

test('a building the horde brings down leaves a wreck; one demolished by day, or a spike strip worn away, leaves none', () => {
  const before = [b('sentry', 3, 3), b('wall', 4, 4), b('depot', 5, 5), b('spikes', 6, 6)];
  const night = noteWrecks([], snap('night', before), snap('night', []), 1000);
  assert.deepEqual(night.map((w) => [w.kind, w.cx, w.cy, w.born]).sort(), [['depot', 5, 5, 1000], ['sentry', 3, 3, 1000], ['wall', 4, 4, 1000]]);
  assert.deepEqual(noteWrecks([], snap('day', before), snap('day', []), 1000), [], 'demolished by day');
  // A building blown up with the sim's boom on its cell is a wreck whatever the phase (the night's last tick may land at dawn).
  const blown = noteWrecks([], snap('night', [b('cannon', 3, 3, 1)]), snap('day', [], [boomAt(3, 3)]), 1000);
  assert.deepEqual(blown.map((w) => w.kind), ['cannon']);
  assert.deepEqual(noteWrecks([], snap('day', [b('cannon', 3, 3)]), snap('day', [], [boomAt(9, 9)]), 1000), [], 'a boom elsewhere is not its end');
});

test('a wreck is cleared when something is built on its cell, and otherwise expires after it has lain its time', () => {
  const list = noteWrecks([], snap('night', [b('scatter', 3, 3), b('mortar', 7, 7)]), snap('night', []), 0);
  assert.equal(list.length, 2);
  const rebuilt = noteWrecks(list, snap('day', []), snap('day', [b('wall', 3, 3, 10)]), 60_000);
  assert.deepEqual(rebuilt.map((w) => [w.cx, w.cy]), [[7, 7]], 'the rebuilt cell is clear');
  assert.equal(noteWrecks(rebuilt, snap('day', []), snap('day', []), WRECK.keepMs + WRECK.fadeMs - 1).length, 1);
  assert.equal(noteWrecks(rebuilt, snap('day', []), snap('day', []), WRECK.keepMs + WRECK.fadeMs).length, 0, 'expired');
  assert.equal(wreckAlpha({ born: 0 }, WRECK.keepMs), 1);
  assert.ok(wreckAlpha({ born: 0 }, WRECK.keepMs + WRECK.fadeMs / 2) > 0.4 && wreckAlpha({ born: 0 }, WRECK.keepMs + WRECK.fadeMs / 2) < 0.6);
  // A new run, or no run at all, starts with a clean field.
  assert.deepEqual(noteWrecks(rebuilt, snap('over', []), snap('day', []), 1), []);
  assert.deepEqual(noteWrecks(rebuilt, snap('night', []), { run: null, buildings: [], events: [] } as never, 1), []);
  // At most `cap` are kept, the newest.
  let many: Wreck[] = [];
  for (let i = 0; i < WRECK.cap + 10; i++) many = noteWrecks(many, snap('night', [b('wall', i, 0)]), snap('night', []), i);
  assert.equal(many.length, WRECK.cap);
  assert.equal(many[0]!.cx, 10);
});

test('a wreck smokes thick, thins over 20 to 30 s, then lies cold', () => {
  assert.equal(wreckHeat({ born: 0 }, 0), 1);
  assert.equal(wreckHeat({ born: 0 }, 3000), 1);
  const curve = [5000, 10_000, 15_000, 20_000].map((t) => wreckHeat({ born: 0 }, t));
  for (let i = 1; i < curve.length; i++) assert.ok(curve[i]! < curve[i - 1]!, curve.join(','));
  assert.ok(WRECK.smokeMs >= 20_000 && WRECK.smokeMs <= 30_000);
  assert.equal(wreckHeat({ born: 0 }, WRECK.smokeMs), 0);
});

test('damage-state art is baked once per state: steady frames, worn and wrecked bases and wrecks paint nothing new', () => {
  const { ctx } = fakeCanvas();
  const all: BuildingView[] = [];
  for (const kind of [...TURRET_KINDS, 'depot', 'post'] as const) for (const hp of [10, 5, 2]) all.push(b(kind, all.length, 0, hp));
  const list = noteWrecks([], snap('night', all.map((x, i) => ({ ...x, cx: i, cy: 9 }))), snap('night', []), 0);
  const frame = (now: number) => {
    drawSiegeTops(ctx, all, new Map(), new Map(), { x: 0, y: 0 }, now, 2);
    drawWrecks(ctx, list, view, now, 2);
  };
  frame(0);
  const bakes = turretBakes.count;
  // Each kind bakes a different sprite per state: three states, so three bases (and heads) per kind.
  const before = turretBakes.count;
  for (const hp of [10, 5, 2]) drawTurret(ctx, { kind: 'cannon', lv: 3, hp, x: 0, y: 0, angle: 1, sinceShot: Infinity }, 2);
  assert.equal(turretBakes.count - before, 6, 'a base and a head for each of three states');
  for (let f = 1; f < 40; f++) frame(f * 16);
  for (const hp of [10, 5, 2]) drawTurret(ctx, { kind: 'cannon', lv: 3, hp, x: 0, y: 0, angle: 1, sinceShot: Infinity }, 2);
  assert.equal(turretBakes.count, bakes + 6, 'nothing re-baked per frame');
});

test('wreck smoke draws on one budget and the siege pool never grows past its cap, however many wrecks smoke', () => {
  const fx = createSiegeFx();
  const list: Wreck[] = Array.from({ length: WRECK.cap }, (_, i) => ({ id: i + 1, cx: i, cy: 0, kind: 'sentry', lv: 1, born: 0 }));
  // Count every puff with a pool too big to wrap, then check the real one holds its cap.
  const counting = { ...fx, pool: createPool(1_000_000) };
  let seed = 1;
  const rand = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const secs = 10;
  for (let t = 0; t <= secs * 1000; t += 16) updateWrecks(counting, list, view, t, 16, rand);
  const palls = counting.pool.slots.filter((p) => p.shape === 'smoke' && p.life >= 2600).length;
  assert.ok(palls > secs * WRECK_SMOKE_PER_SEC * 0.6, `${palls} puffs: the budget is spent`);
  assert.ok(palls <= secs * WRECK_SMOKE_PER_SEC + WRECK_SMOKE_PER_SEC, `${palls} puffs within the budget`);
  // Short of budget, every wreck still smokes: none is starved by its place in the list.
  const each = list.map((w) => counting.pool.slots.filter((p) => p.shape === 'smoke' && p.life >= 2600 && Math.abs(p.x - (w.cx + 0.5) * ZOM.cell) < 12).length);
  assert.ok(Math.min(...each) >= 0.6 * Math.max(...each), `every wreck smokes alike: ${each.join(',')}`);
  for (let t = 0; t <= 5000; t += 16) updateWrecks(fx, list, view, t, 16, rand);
  assert.equal(fx.pool.slots.length, SIEGE_CAP);
  // Smoke drifts on the breeze: a puff ends up down-wind of where it was born.
  const puff = counting.pool.slots.find((p) => p.shape === 'smoke' && p.wind)!;
  assert.ok(puff.wind![0] > 0);
});

test('reduced motion flies no smoke or sparks off wrecks or damaged buildings, and holds the lamps steady', () => {
  const fx = createSiegeFx();
  const list: Wreck[] = [{ id: 1, cx: 0, cy: 0, kind: 'cannon', lv: 1, born: 0 }];
  for (let t = 0; t < 3000; t += 16) {
    updateWrecks(fx, list, view, t, 16, Math.random, true);
    updateBuildings(fx, [b('sentry', 2, 2, 2), b('wall', 3, 3, 4)], view, t, 16, Math.random, true);
  }
  assert.ok(fx.pool.slots.every((p) => p.born === -Infinity), 'nothing emitted');
  const busy = createSiegeFx();
  for (let t = 0; t < 3000; t += 16) updateBuildings(busy, [b('sentry', 2, 2, 2)], view, t, 16, Math.random);
  assert.ok(busy.pool.slots.some((p) => p.born > -Infinity), 'without it, a badly damaged gun smokes');
  // A battered lamp drops out now and then; a sound one never does.
  const drops = (wear: 0 | 1 | 2) => Array.from({ length: 2000 }, (_, i) => lampStutters(7, i * 5, wear)).filter(Boolean).length;
  assert.equal(drops(0), 0);
  assert.ok(drops(1) > 0 && drops(2) > drops(1));
});
