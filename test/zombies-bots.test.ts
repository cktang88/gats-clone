import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILDINGS, ZOM } from '../src/shared/defs.ts';
import { MAPS } from '../src/shared/maps.ts';
import { setInput, step } from '../src/shared/sim.ts';
import { snapshotFor, wallViews } from '../src/shared/sim/snapshot.ts';
import { createWorld, newId, type Player, type World } from '../src/shared/sim/world.ts';
import { botThink, newBotMemory, type BotMemory } from '../src/server/bots.ts';
import { arenaFor } from '../src/server/bot/arena.ts';
import { thinkBots } from '../src/server/bot/tick.ts';
import { spawnAt, TICK_MS } from './helpers.ts';

const seeded = (seed: number) => { let x = seed; return () => ((x = (x * 16807) % 2147483647) / 2147483647); };
const CORE = { x: 1500, y: 1500 };

function nightWorld(): World {
  const w = createWorld('ZOM', 1, 'outpost');
  w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  w.run!.core.hp = 1e9;
  return w;
}

/** Steps the world with `bots` thinking each tick, until `done` or `ms` runs out; returns whether `done` came true. */
function play(w: World, bots: Player[], ms: number, done: () => boolean, seed = 3): boolean {
  const rand = seeded(seed);
  const mems = new Map<number, BotMemory>(bots.map((b) => [b.id, newBotMemory(rand)]));
  for (let t = 0; t < ms; t += TICK_MS) {
    for (const b of bots) {
      const d = botThink(snapshotFor(w, b.id), arenaFor(w), mems.get(b.id)!, rand);
      mems.set(b.id, d.mem);
      setInput(w, b.id, w.tick, d.input);
    }
    step(w, TICK_MS);
    if (done()) return true;
  }
  return false;
}

/** Keeps the night going without bothering anyone. */
const farZombie = (w: World) => w.zombies.push({ id: newId(w), kind: 'walker', x: 60, y: 60, hp: 1e9, attackAt: Infinity, vx: 0, vy: 0 });

test('a squad bot walks over to a downed human and holds use until they are up', () => {
  const w = nightWorld();
  farZombie(w);
  const bot = spawnAt(w, CORE.x - 300, CORE.y + 250);
  const human = spawnAt(w, CORE.x + 150, CORE.y + 200, { kind: 'human' });
  human.life = { k: 'downed', bleedOutAt: Infinity, reviveProgress: 0, hp: 0 };
  assert.ok(play(w, [bot], 15_000, () => human.life.k === 'alive'), 'the human got up');
  assert.equal(w.run!.stats.get(bot.id)?.revives, 1);
});

test('a squad bot shoots the zombies coming at the core', () => {
  const w = nightWorld();
  const bot = spawnAt(w, CORE.x, CORE.y + 320);
  w.zombies.push({ id: newId(w), kind: 'walker', x: CORE.x, y: CORE.y + 900, hp: 200, attackAt: 0, vx: 0, vy: 0 });
  let dealt = 0;
  assert.ok(play(w, [bot], 10_000, () => {
    dealt += w.events.filter((e) => e.e === 'dmg' && e.kind === 'zombie' && e.attacker === bot.id).reduce((sum, e) => sum + (e.e === 'dmg' ? e.amount : 0), 0);
    return w.zombies.length === 0;
  }), 'the zombie died');
  assert.ok(dealt >= 100, `the bot did most of it (${dealt.toFixed(0)} of 200), not just the Bastion's own gun`);
  assert.ok(Math.hypot(bot.x - CORE.x, bot.y - CORE.y) < 600, 'without leaving the core');
});

test('a squad bot mends a damaged wall near the core while no zombie is close', () => {
  const w = nightWorld();
  farZombie(w);
  const bot = spawnAt(w, CORE.x - 300, CORE.y);
  const wall = { id: newId(w), kind: 'wall' as const, cx: 30, cy: 25, hp: BUILDINGS.wall.hp - 400 };
  w.buildings.push(wall);
  w.buildingsVersion++;
  assert.ok(play(w, [bot], 15_000, () => wall.hp >= BUILDINGS.wall.hp * 0.9), `the wall is mended, at ${wall.hp.toFixed(0)}`);
  assert.ok(w.run!.scrap < ZOM.startScrap, 'for scrap');
  assert.equal(w.buildings.length, 1, 'and builds nothing new');
});

test('a squad bot reloads a turret short of ammo near the core while no zombie is close', () => {
  const w = nightWorld();
  farZombie(w);
  const bot = spawnAt(w, CORE.x - 300, CORE.y);
  const turret = { id: newId(w), kind: 'sentry' as const, cx: 30, cy: 25, hp: BUILDINGS.sentry.hp, owner: bot.id, ammo: 0, nextFireAt: 0 };
  w.buildings.push(turret);
  w.buildingsVersion++;
  assert.ok(play(w, [bot], 15_000, () => turret.ammo >= BUILDINGS.sentry.turret.ammo * 0.9), `the turret is reloaded, at ${turret.ammo.toFixed(0)}`);
  assert.ok(w.run!.scrap < ZOM.startScrap, 'for scrap');
  assert.equal(w.buildings.length, 1, 'and builds nothing new');
});

test('a squad bot mends the worn core while no zombie is close, spending the bank', () => {
  const w = nightWorld();
  farZombie(w);
  const bot = spawnAt(w, CORE.x - 300, CORE.y);
  w.run!.core.hp = ZOM.coreHp - 400;
  assert.ok(play(w, [bot], 15_000, () => w.run!.core.hp > ZOM.coreHp - 1), `the core is mended, at ${w.run!.core.hp.toFixed(1)}`);
  assert.ok(Math.abs(ZOM.startScrap - w.run!.scrap - 400 * ZOM.coreRepairScrapPerHp) < 0.5, 'for scrap');
});

test('a squad bot posts behind a squad wall on its bearing rather than out past it', () => {
  const w = nightWorld();
  farZombie(w);
  const bot = spawnAt(w, CORE.x, CORE.y);
  const out = (d: number) => ({ x: CORE.x + Math.cos(bot.id) * d, y: CORE.y + Math.sin(bot.id) * d });
  Object.assign(bot, out(100));
  const wallAt = out(170);
  w.buildings.push({ id: newId(w), kind: 'wall', cx: Math.floor(wallAt.x / ZOM.cell), cy: Math.floor(wallAt.y / ZOM.cell), hp: BUILDINGS.wall.hp });
  w.buildingsVersion++;
  play(w, [bot], 8000, () => false);
  const d = Math.hypot(bot.x - CORE.x, bot.y - CORE.y);
  assert.ok(d < 150, `the bot stays behind the wall, ${d.toFixed(0)}px from the core`);
});

test('a squad bot keeps firing into a crowd whose nearest zombie keeps changing', () => {
  const w = nightWorld();
  const bot = spawnAt(w, CORE.x, CORE.y + 320, { loadout: { weapon: 'smg' } });
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    w.zombies.push({ id: newId(w), kind: 'brute', x: bot.x + Math.cos(a) * (90 + (i % 3) * 15), y: bot.y + Math.sin(a) * (90 + (i % 3) * 15), hp: 1e9, attackAt: Infinity, vx: 0, vy: 0 });
  }
  const shots = () => w.events.filter((e) => e.e === 'shot').length;
  let fired = 0;
  play(w, [bot], 3000, () => { fired += shots(); bot.life.k === 'alive' && (bot.life.hp = 1e9); return false; });
  assert.ok(fired > 8, `${fired} shots in 3s`);
});

test('by day a squad bot walks round the core to put up the next turret of its plan, the first a sentry north of the core', () => {
  const w = createWorld('ZOM', 1, 'outpost');
  spawnAt(w, CORE.x, CORE.y + ZOM.coreHalf + 40);
  const rand = seeded(5);
  const mems = new Map([...w.players.keys()].map((id) => [id, newBotMemory(rand)]));
  for (let t = 0; t < 15_000 && w.buildings.length === 0; t += TICK_MS) {
    thinkBots(w, mems, rand, { respawn: false });
    step(w, TICK_MS);
  }
  assert.deepEqual(w.buildings.map((b) => [b.kind, b.cy < CORE.y / ZOM.cell - 1]), [['sentry', true]]);
  assert.equal(w.run!.scrap, ZOM.startScrap - BUILDINGS.sentry.cost);
});

test('squad bots leave the bank to a human in the squad', () => {
  const w = createWorld('ZOM', 1, 'outpost');
  spawnAt(w, CORE.x, CORE.y + ZOM.coreHalf + 40);
  const human = spawnAt(w, CORE.x - 200, CORE.y, { kind: 'human' });
  const rand = seeded(5);
  const mems = new Map([...w.players.keys()].filter((id) => id !== human.id).map((id) => [id, newBotMemory(rand)]));
  for (let t = 0; t < 15_000; t += TICK_MS) {
    thinkBots(w, mems, rand, { respawn: false });
    step(w, TICK_MS);
  }
  assert.deepEqual([w.buildings.length, w.run!.scrap], [0, ZOM.startScrap]);
});

test('a squad bot with the core between it and a worn turret walks round the core to mend it', () => {
  const w = nightWorld();
  farZombie(w);
  const bot = spawnAt(w, CORE.x + 25, CORE.y + ZOM.coreHalf + 40);
  const t = { id: newId(w), kind: 'sentry' as const, cx: 30, cy: 26, hp: 100, owner: bot.id, ammo: BUILDINGS.sentry.turret.ammo, nextFireAt: 0 };
  w.buildings.push(t);
  w.buildingsVersion++;
  assert.ok(play(w, [bot], 15_000, () => t.hp > 200), `the turret is mended, the bot at ${bot.x.toFixed(0)},${bot.y.toFixed(0)}`);
});

function besideIdleHuman(w: World, ms: number, each: () => void = () => {}) {
  for (let i = 0; i < 3; i++) spawnAt(w, CORE.x - 100 + i * 100, CORE.y + ZOM.coreHalf + 40);
  spawnAt(w, CORE.x - 200, CORE.y, { kind: 'human' });
  const rand = seeded(5);
  const mems = new Map([...w.players.values()].filter((p) => p.kind === 'bot').map((p) => [p.id, newBotMemory(rand)]));
  for (let t = 0; t < ms; t += TICK_MS) {
    each();
    thinkBots(w, mems, rand, { respawn: false });
    step(w, TICK_MS);
  }
}

test('beside a human, squad bots leave the human enough for any building, and tend by day only with what is above it', () => {
  const reserve = Math.max(...Object.values(BUILDINGS).map((b) => b.cost));
  const w = createWorld('ZOM', 1, 'outpost');
  w.run!.core.hp = 3000;
  w.run!.scrap = reserve - 20;
  w.buildings.push({ id: newId(w), kind: 'wall', cx: 27, cy: 33, hp: 500 });
  w.buildingsVersion++;
  besideIdleHuman(w, 10_000);
  assert.deepEqual([w.run!.scrap, w.run!.core.hp, w.buildings[0]!.hp], [reserve - 20, 3000, 500], 'nothing spent under the reserve');
  const rich = createWorld('ZOM', 1, 'outpost');
  rich.run!.core.hp = 3000;
  rich.run!.scrap = reserve + 60;
  besideIdleHuman(rich, 15_000);
  assert.ok(rich.run!.scrap < reserve + 60 && rich.run!.scrap >= reserve - 2, `spent down to the reserve and no further, ${rich.run!.scrap.toFixed(1)} left`);
});

test('beside a human, squad bots mend the core once it is in danger at night, and keep a dry turret firing', () => {
  const w = nightWorld();
  farZombie(w);
  w.run!.core.hp = ZOM.coreHp * 0.6;
  const dry = { id: newId(w), kind: 'sentry' as const, cx: 33, cy: 30, hp: BUILDINGS.sentry.hp, owner: -1, ammo: 0, nextFireAt: 0 };
  w.buildings.push(dry);
  w.buildingsVersion++;
  // A bank at the bots' reserve (enough for the priciest building) keeps them from spending it on anything but a dry turret.
  const bank = Math.max(...Object.values(BUILDINGS).map((b) => b.cost));
  w.run!.scrap = bank;
  besideIdleHuman(w, 8000, () => { w.run!.core.hp = Math.min(w.run!.core.hp, ZOM.coreHp * 0.6); });
  assert.ok(dry.ammo >= 1, `the dry sentry got rounds, ${dry.ammo.toFixed(1)}`);
  const spent = bank - w.run!.scrap;
  assert.ok(spent < 20, `and the bank barely moved for the core above half, ${spent.toFixed(1)} spent`);

  const dire = nightWorld();
  farZombie(dire);
  dire.run!.core.hp = ZOM.coreHp * 0.4;
  dire.run!.scrap = 200;
  besideIdleHuman(dire, 5000);
  assert.ok(dire.run!.core.hp > ZOM.coreHp * 0.4 + 100, `under half, a bot mends it: ${dire.run!.core.hp.toFixed(0)}`);
});

test('the squad bots\' plan stands as far from the core on every side', () => {
  const w = createWorld('ZOM', 1, 'outpost');
  for (let i = 0; i < 4; i++) spawnAt(w, CORE.x - 150 + i * 100, CORE.y + ZOM.coreHalf + 40);
  w.run!.scrap = 1e6;
  w.run!.phase = { k: 'day', endsAt: Infinity };
  const rand = seeded(5);
  const mems = new Map([...w.players.keys()].map((id) => [id, newBotMemory(rand)]));
  for (let t = 0; t < 120_000 && w.buildings.length < 12; t += TICK_MS) {
    thinkBots(w, mems, rand, { respawn: false });
    step(w, TICK_MS);
  }
  assert.equal(w.buildings.length, 12, 'the whole plan went up');
  const offsets = new Set(w.buildings.flatMap((b) => [Math.abs((b.cx + 0.5) * ZOM.cell - CORE.x), Math.abs((b.cy + 0.5) * ZOM.cell - CORE.y)]));
  assert.deepEqual([...offsets].sort((a, b) => a - b), [25, 175, 225]);
});
