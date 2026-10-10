import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WORLD } from '../src/shared/defs.ts';
import { step } from '../src/shared/sim.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import type { Player, World } from '../src/shared/sim/world.ts';
import { emptyWorld, grantPerks, hpOf, press, run, spawnAt, TICK_MS } from './helpers.ts';

const R = WORLD.playerRadius;
const builtWalls = (w: World) => w.walls.filter((x) => x.built);
const overlaps = (p: Player, r: { x: number; y: number; w: number; h: number }) =>
  Math.hypot(p.x - Math.max(r.x, Math.min(p.x, r.x + r.w)), p.y - Math.max(r.y, Math.min(p.y, r.y + r.h))) < R;

test('an engineer wall never spawns on a player, keeps the cooldown ready, and builds once the spot clears', () => {
  const w = emptyWorld();
  const builder = spawnAt(w, 500, 500);
  const enemy = spawnAt(w, 580, 500);
  grantPerks(w, builder, ['extended', 'thickSkin', 'engineer']);
  press(w, builder, { ability: true, angle: 0 });
  run(w, 500);
  assert.equal(builtWalls(w).length, 0, 'no wall over the enemy');
  assert.equal(snapshotFor(w, builder.id).self.abilityReadyIn, 0, 'cooldown not spent');

  enemy.y = 800;
  run(w, TICK_MS * 2);
  const [wall] = builtWalls(w);
  assert.ok(wall, 'the held key builds as soon as the spot is clear');
  for (const p of w.players.values()) assert.ok(!overlaps(p, wall), `wall clear of player ${p.id}`);
  assert.ok(snapshotFor(w, builder.id).self.abilityReadyIn > 0, 'cooldown spent on the build');
});

function knifer(w: World, x = 500, y = 500): Player {
  const p = spawnAt(w, x, y);
  grantPerks(w, p, ['extended', 'thickSkin', 'knife']);
  return p;
}

function slash(w: World, p: Player, angle = 0) {
  press(w, p, { ability: true, angle });
  step(w, TICK_MS);
  const events = w.events;
  press(w, p, { angle });
  return events.filter((e) => e.e === 'slash');
}

test('a knife lunge stops at a wall and cannot reach an enemy behind it', () => {
  const w = emptyWorld();
  const p = knifer(w);
  const enemy = spawnAt(w, 600, 500);
  w.walls.push({ x: 540, y: 400, w: 24, h: 200, built: true, expiresAt: Infinity });
  slash(w, p);
  assert.ok(p.x <= 540 - R + 1e-6, `stopped on the near side (x ${p.x})`);
  assert.equal(hpOf(enemy), WORLD.baseHp, 'enemy behind the wall untouched');
});

test('a knife hits a point-blank enemy without lunging past them', () => {
  const w = emptyWorld();
  const p = knifer(w);
  const enemy = spawnAt(w, 550, 500);
  slash(w, p);
  assert.ok(hpOf(enemy) < WORLD.baseHp, `enemy hit (hp ${hpOf(enemy)})`);
  assert.equal(p.x, 500, 'no lunge needed');
});

test('a knife lunge stops at the first enemy it reaches and hits only them', () => {
  const w = emptyWorld();
  const p = knifer(w);
  const first = spawnAt(w, 640, 500);
  const second = spawnAt(w, 700, 500);
  const [ev] = slash(w, p, 0);
  assert.ok(hpOf(first) < WORLD.baseHp, 'first enemy hit');
  assert.equal(hpOf(second), WORLD.baseHp, 'second enemy spared');
  assert.ok(p.x > 500 && p.x < first.x - 2 * R, `lunged toward but not into the first enemy (x ${p.x})`);
  assert.deepEqual(ev, { e: 'slash', x: p.x, y: p.y, angle: 0, owner: p.id });
});

test('a whiffed knife still lunges the full distance and emits a slash', () => {
  const w = emptyWorld();
  const p = knifer(w);
  const events = slash(w, p, Math.PI / 2);
  assert.ok(Math.abs(p.y - 590) < 1e-6, `lunged 90px (y ${p.y})`);
  assert.equal(events.length, 1);
});

function dasher(w: World, x = 500, y = 500): Player {
  const p = spawnAt(w, x, y);
  grantPerks(w, p, ['extended', 'thickSkin', 'dash']);
  return p;
}

test('dash with no movement keys bursts about 240px along the aim', () => {
  const w = emptyWorld();
  const p = dasher(w);
  press(w, p, { ability: true, angle: Math.PI / 2 });
  run(w, 600);
  assert.ok(Math.abs(p.x - 500) < 1e-9, `no sideways drift (x ${p.x})`);
  assert.ok(p.y - 500 >= 220 && p.y - 500 <= 260, `moved ${p.y - 500}px down the aim`);
});

test('dash follows the movement keys over the aim', () => {
  const w = emptyWorld();
  const p = dasher(w);
  const walker = spawnAt(w, 500, 1500);
  press(w, p, { right: true, ability: true, angle: Math.PI / 2 });
  press(w, walker, { right: true });
  run(w, 600);
  assert.ok(Math.abs(p.y - 500) < 1e-9, `stays on the movement line (y ${p.y})`);
  assert.ok(p.x - walker.x >= 150, `dash added ${p.x - walker.x}px over walking`);
});

test('a dash stops at a thin built wall instead of passing through it', () => {
  const w = emptyWorld();
  const p = dasher(w);
  w.walls.push({ x: 540, y: 400, w: 24, h: 200, built: true, expiresAt: Infinity });
  press(w, p, { ability: true, angle: 0 });
  run(w, 600);
  assert.ok(p.x <= 540 - R + 1e-6, `stopped on the near side (x ${p.x})`);
});

test('an owner keeps at most two mines, the third replacing the oldest, and loses them all on death', () => {
  const w = emptyWorld();
  const miner = spawnAt(w, 500, 500);
  grantPerks(w, miner, ['extended', 'thickSkin', 'claymore']);
  const plant = (x: number) => {
    miner.x = x;
    miner.abilityReadyAt = 0;
    press(w, miner, { ability: true });
    step(w, TICK_MS);
    press(w, miner, {});
  };
  const mineXs = () => w.thrown.filter((t) => t.kind === 'claymore').map((t) => t.x);
  plant(500);
  plant(700);
  plant(900);
  assert.deepEqual(mineXs(), [700, 900]);
  miner.life = { k: 'dead', respawnAt: w.now + WORLD.respawnMs };
  step(w, TICK_MS);
  assert.deepEqual(mineXs(), [], 'a dead owner leaves no mines behind');
});
