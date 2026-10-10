import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROYALE, ZOM, ZOMBIES } from '../src/shared/defs.ts';
import { addPlayer, canRespawn, setInput, step } from '../src/shared/sim.ts';
import { ABILITIES } from '../src/shared/sim/abilities.ts';
import { wallTier } from '../src/shared/sim/build.ts';
import { enterRoyale } from '../src/shared/sim/royale.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { setRangeLoadout } from '../src/shared/sim/targets.ts';
import { createWorld, newId, type World } from '../src/shared/sim/world.ts';
import { botThink, newBotMemory } from '../src/server/bots.ts';
import { arenaFor } from '../src/server/bot/arena.ts';
import { emptyWorld, press, run, spawnAt, TICK_MS } from './helpers.ts';

/** Bugs found across systems, each pinned where it was fixed. */

function royaleWorld(): World {
  const w = emptyWorld('BR');
  const r = w.royale!;
  r.caches = []; r.towers = []; r.drops = [];
  const big = { x: 1000, y: 1000, r: 5000 };
  r.ring = { k: 'waiting', phase: 0, circle: big, next: big, shrinkAt: Infinity };
  return w;
}

test('Last Standing: holding E takes one gun, and does not swap back and forth', () => {
  const w = royaleWorld();
  const p = spawnAt(w, 1000, 1000, { team: null });
  enterRoyale(w, p);
  const start = p.gun;
  w.royale!.guns.push({ id: 999_999, x: 1010, y: 1000, gun: 'shotgun' });
  p.input = { ...p.input, use: true };
  let took = 0;
  for (let t = 0; t < 2000; t += TICK_MS) { step(w, TICK_MS); took += w.events.filter((e) => e.e === 'took').length; }
  assert.equal(took, 1);
  assert.equal(p.gun, 'shotgun');
  p.input = { ...p.input, use: false };
  step(w, TICK_MS);
  p.input = { ...p.input, use: true };
  step(w, TICK_MS);
  assert.equal(p.gun, start, 'a fresh press takes again');
});

test('Last Standing: a gun taken mid-burst fires none of the old burst', () => {
  const w = royaleWorld();
  const p = spawnAt(w, 1000, 1000, { team: null });
  enterRoyale(w, p);
  p.gun = 'machinePistol';
  if (p.life.k === 'alive') { p.life.ammo = 24; p.life.shieldUntil = -Infinity; }
  w.royale!.guns.push({ id: 999_999, x: 1010, y: 1000, gun: 'sniper' });
  press(w, p, { angle: 0, fire: true, shots: 1, use: true });
  const shots: string[] = [];
  for (let t = 0; t < 3000; t += TICK_MS) {
    step(w, TICK_MS);
    if (t < TICK_MS) press(w, p, { angle: 0 });
    for (const e of w.events) if (e.e === 'shot' && e.owner === p.id) shots.push(e.gun ?? '');
  }
  assert.equal(p.gun, 'sniper');
  assert.ok(!shots.includes('sniper'), `the sniper never fired by itself: ${shots.join()}`);
});

test('Last Standing: taking a final-stage gun off the floor announces the holder as hunted', () => {
  const w = royaleWorld();
  const p = spawnAt(w, 1000, 1000, { team: null });
  enterRoyale(w, p);
  w.royale!.guns.push({ id: 999_999, x: 1010, y: 1000, gun: 'executioner' });
  p.input = { ...p.input, use: true };
  const seen: string[] = [];
  for (let t = 0; t < 300; t += TICK_MS) { step(w, TICK_MS); for (const e of w.events) seen.push(e.e); }
  assert.equal(p.gun, 'executioner');
  assert.ok(seen.includes('hunted'), seen.join());
});

test('a supply drop skips exactly one level, and a dead player\'s round does not crack it', () => {
  const w = royaleWorld();
  const p = spawnAt(w, 1000, 1000, { team: null });
  enterRoyale(w, p);
  p.score = 440; p.level = 1;
  w.crates = [...w.crates, { id: 777_777, x: 1060, y: 1000 - 32, size: ROYALE.dropSize, hp: 1, respawnAt: null, drop: true }];
  p.input = { ...p.input, angle: 0, fire: true, shots: 1 };
  run(w, 600);
  assert.equal(p.level, 2, 'the next pick, not the one after');

  const v = royaleWorld();
  const q = spawnAt(v, 1000, 1000, { team: null });
  enterRoyale(v, q);
  if (q.life.k === 'alive') q.life.shieldUntil = -Infinity;
  const crate = { id: 777_778, x: 1300, y: 1000 - 32, size: ROYALE.dropSize, hp: 1, respawnAt: null, drop: true as const };
  v.crates = [...v.crates, crate];
  q.input = { ...q.input, angle: 0, fire: true, shots: 1 };
  step(v, TICK_MS);
  q.input = { ...q.input, fire: false };
  q.life = { k: 'dead', respawnAt: Infinity };
  run(v, 1000);
  assert.equal(crate.respawnAt, null, 'still standing for the living');
});

test('Last Standing: a cache\'s opening progress reaches the wire in fiftieths', () => {
  const w = royaleWorld();
  const p = spawnAt(w, 1000, 1000, { team: null });
  enterRoyale(w, p);
  w.royale!.caches = [{ id: 1, x: 1000, y: 1000, tier: 0, open: false, by: p.id, since: w.now - 100 }];
  const view = snapshotFor(w, p.id).royale!.caches[0]!;
  assert.equal(view[5], 1, '100 ms of 5 s is one fiftieth, a whole number');
});

test('a bot fires out through its own one-way Shield', () => {
  const seeded = (seed: number) => { let x = seed; return () => ((x = (x * 16807) % 2147483647) / 2147483647); };
  const w = emptyWorld('FFA');
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  const foe = spawnAt(w, 1350, 1000);
  bot.angle = 0;
  ABILITIES.engineer(w, bot);
  const r = seeded(11);
  let mem = newBotMemory(r);
  for (let i = 0; i < 90; i++) {
    const d = botThink(snapshotFor(w, bot.id), arenaFor(w), mem, r);
    mem = d.mem;
    setInput(w, bot.id, i + 1, { ...d.input, up: false, down: false, left: false, right: false });
    step(w, TICK_MS);
    if (foe.life.k === 'alive') foe.life.hp = 100;
  }
  assert.ok(bot.fired > 5, `fired ${bot.fired}`);
});

test('the Range: picking armor fills its pool', () => {
  const w = createWorld('RNG', 1, 'range');
  const p = addPlayer(w, 'me', { weapon: 'assault', armor: 'none', color: 'red' }, { kind: 'human' });
  assert.ok(setRangeLoadout(w, p, { armor: 'heavy' }));
  assert.ok(p.life.k === 'alive' && p.life.armor > 0);
});

test('Zombies: the dead come back only through the run, never by respawning', () => {
  const w = createWorld('ZOM', 1, 'outpost');
  const p = spawnAt(w, 1000, 1000);
  p.life = { k: 'dead', respawnAt: 0 };
  assert.equal(canRespawn(w, p.id), false);
});

test('Zombies: a steel wall\'s armor turns aside part of a bite that would otherwise fell it', () => {
  const w = createWorld('ZOM', 1, 'outpost');
  w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  w.run!.core.hp = 1e9;
  for (let cy = 0; cy < 60; cy++) w.buildings.push({ id: newId(w), kind: 'wall', cx: 10, cy, hp: wallTier(3).hp, lv: 3 });
  w.buildingsVersion++;
  const wall = w.buildings.find((b) => b.cy === 30)!;
  wall.hp = 35;
  w.zombies.push({ id: newId(w), kind: 'brute', x: 10 * ZOM.cell - ZOMBIES.brute.radius - 2, y: 30.5 * ZOM.cell, hp: 1e9, attackAt: 0, vx: 0, vy: 0 });
  run(w, TICK_MS);
  assert.ok(w.buildings.includes(wall), 'it stands');
  assert.ok(Math.abs(wall.hp - (35 - ZOMBIES.brute.damage * (1 - wallTier(3).armor))) < 1e-6, `hp ${wall.hp}`);
});

test('client prediction stops at a barrel where the server does', async () => {
  const { solidsOf, predictInput, reconcile, selfMotion, NO_PREDICTION } = await import('../src/client/predict.ts');
  const { wallViews } = await import('../src/shared/sim/snapshot.ts');
  const { IDLE_INPUT } = await import('../src/shared/sim/world.ts');
  const { BARREL } = await import('../src/shared/defs.ts');
  const w = emptyWorld('FFA');
  w.barrels = [{ id: 9999, x: 800, y: 950, hp: BARREL.hp, fuseAt: null, respawnAt: null, by: null }];
  const p = spawnAt(w, 700, 950);
  const first = snapshotFor(w, p.id);
  const walls = wallViews(w);
  let pred = reconcile(NO_PREDICTION, selfMotion(first).at, first.ackSeq, solidsOf(walls, first), selfMotion(first).speed, 6000);
  for (let i = 1; i <= 30; i++) {
    const input = { ...IDLE_INPUT, right: true, angle: 0 };
    setInput(w, p.id, i, input);
    step(w, TICK_MS);
    pred = predictInput(pred, { seq: i, input, dtMs: TICK_MS, ability: null }, solidsOf(walls, first), selfMotion(first).speed, i * TICK_MS, 6000);
  }
  assert.ok(Math.abs(pred.afterNewest!.x - p.x) < 0.5, `predicted ${pred.afterNewest!.x}, server ${p.x}`);
});
