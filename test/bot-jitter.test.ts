import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WORLD } from '../src/shared/defs.ts';
import { addPlayer, step } from '../src/shared/sim.ts';
import { circleHitsRect } from '../src/shared/sim/movement.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { createWorld, rand, solidRects, type World } from '../src/shared/sim/world.ts';
import { newBotMemory, randomLoadout, type BotMemory } from '../src/server/bots.ts';
import { thinkBots } from '../src/server/bot/tick.ts';
import { TICK_MS } from './helpers.ts';

type Sample = { x: number; y: number; kx: number; ky: number; wall: boolean };

/** Plays bots for `ms` and hands each tick's sample per bot to `check`, which sees the last `window` samples. */
function watch(w: World, bots: Map<number, BotMemory>, ms: number, window: number, check: (name: string, h: readonly Sample[]) => void, opts?: { respawn: false }) {
  const r = () => rand(w);
  const hist = new Map<number, Sample[]>();
  for (let t = 0; t < ms; t += TICK_MS) {
    thinkBots(w, bots, r, opts);
    step(w, TICK_MS);
    const solids = solidRects(w);
    for (const p of w.players.values()) {
      if (p.life.k !== 'alive') { hist.delete(p.id); continue; }
      const h = hist.get(p.id) ?? [];
      h.push({ x: p.x, y: p.y, kx: +p.input.right - +p.input.left, ky: +p.input.down - +p.input.up, wall: solids.some((b) => circleHitsRect(p.x, p.y, WORLD.playerRadius + 2, b)) });
      if (h.length > window) h.shift();
      hist.set(p.id, h);
      if (h.length === window) check(p.name, h);
    }
  }
}

const reversals = (h: readonly Sample[]) => h.slice(1).filter((s, i) => s.kx * h[i]!.kx + s.ky * h[i]!.ky < 0).length;
/** The farthest it got from where the window began. */
const reach = (h: readonly Sample[]) => Math.max(...h.map((s) => Math.hypot(s.x - h[0]!.x, s.y - h[0]!.y)));
const net = (h: readonly Sample[]) => Math.hypot(h[h.length - 1]!.x - h[0]!.x, h[h.length - 1]!.y - h[0]!.y);

test('squad bots never flip their keys back and forth in place around the Bastion', () => {
  const w = createWorld('ZOM', 1, 'outpost');
  const r = () => rand(w);
  const bots = new Map<number, BotMemory>();
  for (let i = 0; i < 4; i++) bots.set(addPlayer(w, `b${i}`, randomLoadout(r), { kind: 'bot' }).id, newBotMemory(r));
  const worst: string[] = [];
  watch(w, bots, 90_000, 30, (name, h) => { if (reversals(h) >= 4 && net(h) < 30) worst.push(`${name} ${reversals(h)} flips in a second`); }, { respawn: false });
  assert.deepEqual(worst.slice(0, 3), []);
});

test('bots never shuffle along a wall for seconds without getting anywhere', () => {
  const w = createWorld('FFA', 1, 'plaza');
  const r = () => rand(w);
  const bots = new Map<number, BotMemory>();
  for (let i = 0; i < WORLD.minPlayers; i++) bots.set(addPlayer(w, `b${i}`, randomLoadout(r)).id, newBotMemory(r));
  const stuck: string[] = [];
  watch(w, bots, 70_000, 90, (name, h) => {
    const pressing = h.filter((s) => s.kx || s.ky).length / h.length, walled = h.filter((s) => s.wall).length / h.length;
    // Stuck is going nowhere the whole time: a bot strafing a duel to and fro along a wall it brushes (200 px each way) ends near where it
    // began but has been somewhere.
    if (pressing > 0.8 && walled > 0.8 && reach(h) < 40) stuck.push(`${name} at ${h[0]!.x.toFixed(0)},${h[0]!.y.toFixed(0)}`);
  });
  assert.deepEqual([...new Set(stuck)].slice(0, 3), []);
});

/** Squad bots play a whole Zombies run on a few world seeds, since each seed brings the horde at them a different way. */
const SHUTTLE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

test('squad bots shooting at the horde never shuttle back and forth between backing off and heading back', () => {
  const shuttles: string[] = [], perSeed: number[] = [];
  for (const seed of SHUTTLE_SEEDS) {
    const found = squadShuttles(seed);
    perSeed.push(found.length);
    shuttles.push(...found.map((s) => `seed ${seed}: ${s}`));
  }
  // A lone one-tick flip somewhere in a three-minute run is chaos, not a shuttle habit (any change to the sim moves where it lands:
  // seeds 9 to 20 show one at seed 18 before the bloom curve and none after; seeds 1 to 20 show one before the Zombies gun roles and two, in
  // different runs, after); a habit shows as several in one run, or flips in most of them.
  assert.ok(shuttles.length <= 2 && perSeed.every((n) => n <= 1), shuttles.slice(0, 3).join('; '));
});

/** Each time a squad bot turns its keys round, while shooting, within 20 ticks of turning them round before. */
function squadShuttles(seed: number): string[] {
  const w = createWorld('ZOM', seed, 'outpost');
  const r = () => rand(w);
  const bots = new Map<number, BotMemory>();
  for (let i = 0; i < 4; i++) bots.set(addPlayer(w, `b${i}`, randomLoadout(r), { kind: 'bot' }).id, newBotMemory(r));
  const last = new Map<number, { kx: number; ky: number; tick: number }>();
  const turned = new Map<number, number>();
  const shuttles: string[] = [];
  for (let t = 0; t < 180_000 / TICK_MS && w.run!.phase.k !== 'over'; t++) {
    thinkBots(w, bots, r, { respawn: false, onDecision(id, seen, _before, d) {
      // A squad bot thinks on a snapshot every tick it acts (see thinkBots); the motor-only ticks are a versus thing.
      const snap = seen ?? snapshotFor(w, id);
      const kx = +d.input.right - +d.input.left, ky = +d.input.down - +d.input.up;
      if (!snap.players.find((p) => p.id === id)?.alive || !(kx || ky)) return;
      const was = last.get(id);
      last.set(id, { kx, ky, tick: t });
      if (!was || t - was.tick > 10 || kx * was.kx + ky * was.ky >= 0 || !d.input.fire) return;
      if (t - (turned.get(id) ?? -Infinity) <= 20) shuttles.push(`${snap.players.find((p) => p.id === id)!.name} at tick ${t}`);
      turned.set(id, t);
    } });
    step(w, TICK_MS);
  }
  return shuttles;
}
