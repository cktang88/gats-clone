import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { nightOf, ZOM, ZOMBIES, type ZombieKind } from '../src/shared/defs.ts';
import { MAPS } from '../src/shared/maps.ts';
import { step } from '../src/shared/sim.ts';
import { createWorld, newId, type World, type Zombie } from '../src/shared/sim/world.ts';
import { spawnAt, TICK_MS } from './helpers.ts';

const CORE = MAPS.outpost.siege!.core;

/** A night with nothing left to spawn, so only the zombies a test places walk. */
function nightWorld(seed = 1): World {
  const w = createWorld('ZOM', seed, 'outpost');
  w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  w.run!.core.hp = 1e9;
  return w;
}

function addZombie(w: World, kind: ZombieKind, x: number, y: number, pack?: number): Zombie {
  const z: Zombie = { id: newId(w), kind, x, y, hp: 1e9, attackAt: Infinity, vx: 0, vy: 0, pack };
  w.zombies.push(z);
  return z;
}

function stepFor(w: World, ms: number, each: () => void = () => {}) {
  for (let t = 0; t < ms; t += TICK_MS) { step(w, TICK_MS); each(); }
}

const sd = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

test('separation keeps a crowd apart: a stack of walkers spreads until none overlap', () => {
  const w = nightWorld();
  const r = ZOMBIES.walker.radius;
  const zs = Array.from({ length: 30 }, (_, i) => addZombie(w, 'walker', 1475 + (i % 3) * 4, 2300 + Math.floor(i / 3) * 4, 1));
  stepFor(w, 4000);
  let closest = Infinity;
  for (const a of zs) for (const b of zs) if (a !== b) closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y));
  assert.ok(closest >= r * 2 * 0.85, `closest pair ${closest.toFixed(1)}px apart`);
});

test('a brute shoves a walker aside more than the walker moves it', () => {
  const w = nightWorld();
  const brute = addZombie(w, 'brute', 1000, 2200), walker = addZombie(w, 'walker', 1010, 2200);
  const at = { b: { x: brute.x, y: brute.y }, w: { x: walker.x, y: walker.y } };
  stepFor(w, 200);
  const movedBrute = Math.hypot(brute.x - at.b.x, brute.y - at.b.y), movedWalker = Math.hypot(walker.x - at.w.x, walker.y - at.w.y);
  assert.ok(Math.hypot(brute.x - walker.x, brute.y - walker.y) >= ZOMBIES.brute.radius + ZOMBIES.walker.radius - 1, 'they part');
  assert.ok(movedWalker > movedBrute, `the walker gave way (${movedWalker.toFixed(1)} vs ${movedBrute.toFixed(1)})`);
});

/** The sideways drift of a zombie placed due south of the core, with a player `side` px to its east standing still. */
function drift(kind: ZombieKind, side: number, ms: number) {
  const w = nightWorld();
  spawnAt(w, 1475 + side, 2300);
  const z = addZombie(w, kind, 1475, 2300);
  stepFor(w, ms);
  return { dx: z.x - 1475, dy: z.y - 2300, z, w };
}

test('a very near player pulls a walker off the core path, while a brute keeps on and a far player does nothing', () => {
  const walker = drift('walker', 200, 2500);
  assert.equal(walker.z.ai?.tgt, 'player');
  assert.ok(walker.dx > 100, `the walker turned east, ${walker.dx.toFixed(0)}px`);
  const far = drift('walker', 700, 2500);
  assert.equal(far.z.ai?.tgt, 'core');
  assert.ok(far.dy < -100 && far.dx < walker.dx - 40, `a distant player leaves it on its way north (${far.dx.toFixed(0)}, ${far.dy.toFixed(0)})`);
  const brute = drift('brute', 200, 1500);
  assert.equal(brute.z.ai?.tgt, 'core');
  assert.ok(brute.dy < -60 && brute.dx < 100, `the brute marched on, (${brute.dx.toFixed(0)}, ${brute.dy.toFixed(0)})`);
  // A runner is drawn from farther than a walker is.
  const runner = drift('runner', 340, 800), walkerFar = drift('walker', 380, 800);
  assert.equal(runner.z.ai?.tgt, 'player');
  assert.equal(walkerFar.z.ai?.tgt, 'core');
});

test('a zombie does not flip-flop: a player hovering at the edge of its pull is held, not swapped for the core every tick', () => {
  const w = nightWorld();
  const p = spawnAt(w, 1475 + 270, 2300);
  const z = addZombie(w, 'walker', 1475, 2300);
  let flips = 0, last = z.ai?.tgt ?? 'core';
  stepFor(w, 12_000, () => {
    // The player jitters about, so the zombie's score for it rises and falls around the core's.
    p.x = 1475 + 270 + 30 * Math.sin(w.now / 150);
    p.y = 2300 - 40 * Math.cos(w.now / 230);
    const t = z.ai!.tgt;
    if (t !== last) { flips++; last = t; }
  });
  assert.ok(flips <= 3, `${flips} changes of mind in twelve seconds`);
});

test('two players about equally near do not trade a zombie back and forth', () => {
  const w = nightWorld();
  const a = spawnAt(w, 1475 + 180, 2300 - 60), b = spawnAt(w, 1475 - 180, 2300 - 60);
  const z = addZombie(w, 'walker', 1475, 2300);
  let swaps = 0, pid = 0;
  stepFor(w, 6000, () => {
    a.x += Math.sin(w.now / 300) * 1.5;
    b.x -= Math.sin(w.now / 300) * 1.5;
    if (z.ai?.tgt === 'player') { if (pid && z.ai.pid !== pid) swaps++; pid = z.ai.pid; }
  });
  assert.ok(swaps <= 1, `${swaps} swaps`);
});

test('a zombie that loses its player goes back to the core', () => {
  const w = nightWorld();
  const p = spawnAt(w, 1475 + 200, 2300);
  const z = addZombie(w, 'walker', 1475, 2300);
  stepFor(w, 800);
  assert.equal(z.ai?.tgt, 'player');
  // The player runs off faster than it can follow.
  let tgt: string | undefined;
  stepFor(w, 6000, () => { p.x += 7; p.y -= 3; tgt = z.ai?.tgt; });
  assert.equal(tgt, 'core');
  const before = Math.hypot(z.x - CORE.x, z.y - CORE.y);
  stepFor(w, 3000);
  assert.ok(Math.hypot(z.x - CORE.x, z.y - CORE.y) < before - 100, 'it marches on the core again');
  // Once the leash has snapped it is not at once drawn by a player right beside it.
  assert.equal(z.ai?.pid, 0);
});

test('a horde walks in as a ragged front rather than a column', () => {
  const w = nightWorld();
  // Forty walkers lined up single file, due south of the core, as a conga line would run.
  const zs = Array.from({ length: 40 }, (_, i) => addZombie(w, 'walker', 1475, 2900 - i * 34, 1 + Math.floor(i / 6)));
  stepFor(w, 9000);
  const spread = sd(zs.map((z) => z.x));
  assert.ok(spread > 45, `lateral spread ${spread.toFixed(0)}px`);
});

test('a night walks in from its forecast sides only, and a pack is split along the edge', () => {
  const w = createWorld('ZOM', 7, 'outpost');
  const run = w.run!;
  for (let i = 0; i < 4; i++) spawnAt(w, 1450 + i * 30, 1400);
  run.night = 3;
  run.phase = { k: 'day', endsAt: 0 };
  const sides = nightOf(3).from;
  const strips = sides.map((s) => MAPS.outpost.siege!.horde[s]);
  const seen: Zombie[] = [], first = new Set<number>();
  for (let i = 0; i < 30 * 80; i++) {
    step(w, TICK_MS);
    for (const z of w.zombies) if (!seen.includes(z) && !first.has(z.id)) { first.add(z.id); seen.push({ ...z }); }
  }
  assert.ok(seen.length > 20, `${seen.length} zombies walked in`);
  assert.ok(seen.every((z) => strips.some((s) => z.x >= s.x - 130 && z.x <= s.x + s.w + 130 && z.y >= s.y - 130 && z.y <= s.y + s.h + 130)), 'all came in from the forecast sides');
  const packs = new Map<number, Zombie[]>();
  for (const z of seen) if (z.pack !== undefined) packs.set(z.pack, [...(packs.get(z.pack) ?? []), z]);
  assert.ok(packs.size > seen.length / (ZOM.maxAlive / 10), 'packs are tagged');
  // On the side the most walked in from, so a night split over several sides still has a side with packs enough to judge.
  const onStrip = strips.map((s) => seen.filter((z) => z.x >= s.x && z.x <= s.x + s.w && z.y >= s.y && z.y <= s.y + s.h));
  const busiest = onStrip.reduce((a, b, i) => (b.length > onStrip[a]!.length ? i : a), 0);
  const along = (z: Zombie) => (strips[busiest]!.w > strips[busiest]!.h ? z.x : z.y);
  const spread = sd(onStrip[busiest]!.map(along));
  assert.ok(spread > 300, `entry points spread along the edge (${spread.toFixed(0)} px over ${onStrip[busiest]!.length})`);
});

test('the horde near the core spreads round it rather than stacking on one face', () => {
  const w = nightWorld();
  const zs = Array.from({ length: 24 }, (_, i) => addZombie(w, 'walker', 1470 + (i % 6) * 8, 2250 + Math.floor(i / 6) * 8));
  stepFor(w, 20_000);
  const angles = zs.map((z) => Math.atan2(z.y - CORE.y, z.x - CORE.x));
  assert.ok(sd(angles) > 0.35, `angular spread ${sd(angles).toFixed(2)} rad`);
});

test('a run with boids replays exactly from its seed', () => {
  const play = (seed: number) => {
    const w = nightWorld(seed);
    spawnAt(w, 1600, 2000);
    for (let i = 0; i < 20; i++) addZombie(w, (['walker', 'runner', 'brute', 'plated'] as const)[i % 4]!, 400 + (i * 97) % 700, 2600, 1 + (i % 3));
    stepFor(w, 8000);
    return createHash('sha256').update(JSON.stringify(w.zombies.map((z) => [z.id, z.x, z.y, z.ai?.tgt]))).digest('hex');
  };
  assert.equal(play(3), play(3));
});
