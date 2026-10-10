import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOOT, TOWER, WORLD } from '../src/shared/defs.ts';
import { step } from '../src/shared/sim.ts';
import type { World } from '../src/shared/sim/world.ts';
import { newBotMemory, type BotMemory } from '../src/server/bots.ts';
import { takesTower } from '../src/server/bot/royale.ts';
import { thinkBots } from '../src/server/bot/tick.ts';
import { emptyWorld, spawnAt, TICK_MS } from './helpers.ts';

/** A Last Standing world with no caches, towers or drops, and a ring that will not move for a long while: the test adds what it needs. */
function soloWorld(): World {
  const w = emptyWorld('BR');
  const r = w.royale!;
  r.caches = [];
  r.towers = [];
  r.drops = [];
  const c = { x: 1500, y: 1500, r: 5000 };
  r.ring = { k: 'waiting', phase: 0, circle: c, next: { ...c, r: 4000 }, shrinkAt: w.now + 10 * 60_000 };
  return w;
}

function drive(w: World, mems: Map<number, BotMemory>, ms: number, until: () => boolean): number {
  let seq = 0;
  const r = () => ((seq = (seq * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
  for (let t = 0; t < ms; t += TICK_MS) {
    thinkBots(w, mems, r, { respawn: false });
    step(w, TICK_MS);
    if (until()) return t;
  }
  return Infinity;
}

test('Last Standing is solo: a bot is on no team, and with nobody about it walks to a nearby rare cache and opens it', () => {
  const w = soloWorld();
  const bot = spawnAt(w, 1200, 1200, { kind: 'bot' });
  assert.equal(bot.team, null);
  assert.equal(bot.loadout.armor, 'none', 'a life starts with no armor');
  w.royale!.caches = [{ id: 900_001, x: 1700, y: 1450, tier: 1, open: false }];
  const mems = new Map([[bot.id, newBotMemory(() => 0.5)]]);
  const took = drive(w, mems, 12_000, () => w.royale!.caches[0]!.open);
  assert.ok(took < 12_000, 'opened the cache within 12 s');
  assert.ok(Math.hypot(bot.x - 1700, bot.y - 1450) <= LOOT.openPx + WORLD.playerRadius + 40, 'it walked there itself');
  assert.notEqual(bot.loadout.armor, 'none', 'a rare cache put its armor up a tier');
});

test('a bot goes for the rare cache over a nearer common one, then loots the common one after it', () => {
  const w = soloWorld();
  const bot = spawnAt(w, 1500, 1500, { kind: 'bot' });
  w.royale!.caches = [{ id: 900_001, x: 1350, y: 1500, tier: 0, open: false }, { id: 900_002, x: 1900, y: 1500, tier: 1, open: false }];
  const mems = new Map([[bot.id, newBotMemory(() => 0.5)]]);
  const [common, rare] = w.royale!.caches;
  drive(w, mems, 12_000, () => rare!.open || common!.open);
  assert.ok(rare!.open && !common!.open, 'the rare one first');
  assert.ok(drive(w, mems, 12_000, () => common!.open) < 12_000, 'then the common one');
});

test('with no enemy in sight a bot near a ready tower takes it, and its holder sees who is around', () => {
  const w = soloWorld();
  const bot = spawnAt(w, 1300, 1300, { kind: 'bot' });
  // A tower spot this bot is one to take (half of them are, by id and tower).
  let tower = { x: 1700, y: 1500 };
  for (let i = 0; !takesTower(bot.id, tower); i++) tower = { x: 1700 + (i % 20) * 7, y: 1500 + Math.floor(i / 20) * 7 };
  w.royale!.towers = [{ ...tower, readyAt: 0, holder: null, since: 0 }];
  // Someone far off (out of its sight, inside the tower's reveal): an idle player who never comes near.
  const far = spawnAt(w, tower.x + 1700, tower.y + 900, { kind: 'human', name: 'faraway' });
  const mems = new Map([[bot.id, newBotMemory(() => 0.5)]]);
  const t0 = w.now;
  const took = drive(w, mems, 15_000, () => w.royale!.towers[0]!.readyAt > w.now);
  assert.ok(took < 15_000, 'took the tower within 15 s');
  assert.ok(Math.hypot(bot.x - tower.x, bot.y - tower.y) <= TOWER.radius, 'it held it from inside its circle');
  assert.ok(w.now - t0 >= TOWER.holdMs, 'by holding it for the full hold');
  const life = bot.life;
  assert.equal(life.k, 'alive');
  if (life.k === 'alive') assert.ok((life.tracks[far.id] ?? 0) > w.now, 'the far player is marked on its map');
});

test('a bot outside the safe circle walks back into it rather than looting outside', () => {
  const w = soloWorld();
  const bot = spawnAt(w, 400, 400, { kind: 'bot' });
  const c = { x: 1800, y: 1800, r: 700 };
  w.royale!.ring = { k: 'waiting', phase: 1, circle: c, next: { ...c, r: 500 }, shrinkAt: w.now + 60_000 };
  w.royale!.caches = [{ id: 900_001, x: 250, y: 600, tier: 2, open: false }];
  const mems = new Map([[bot.id, newBotMemory(() => 0.5)]]);
  const back = drive(w, mems, 20_000, () => Math.hypot(bot.x - c.x, bot.y - c.y) < c.r - 100);
  assert.ok(back < 20_000, 'back inside within 20 s');
  assert.ok(!w.royale!.caches[0]!.open, 'it left the epic cache outside the circle alone');
});
