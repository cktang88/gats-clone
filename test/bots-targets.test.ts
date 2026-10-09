/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WallView } from '../src/shared/protocol.ts';
import { MAPS } from '../src/shared/maps.ts';
import { setInput, step } from '../src/shared/sim.ts';
import { IDLE_INPUT } from '../src/shared/sim/world.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import type { World } from '../src/shared/sim/world.ts';
import { botThink, newBotMemory } from '../src/server/bots.ts';
import { arenaFor } from '../src/server/bot/arena.ts';
import { emptyWorld, equip, hpOf, setWalls, spawnAt, TICK_MS } from './helpers.ts';

const CRATE = 40;
const addCrate = (w: World, cx: number, cy: number) => w.crates.push({ id: 9000 + w.crates.length, x: cx - CRATE / 2, y: cy - CRATE / 2, size: CRATE, hp: 40, respawnAt: null });

const seeded = (seed: number) => { let x = seed; return () => ((x = (x * 16807) % 2147483647) / 2147483647); };

function think(w: World, botId: number, seed: number, ticks: number) {
  const r = seeded(seed);
  let mem = newBotMemory(r);
  for (let i = 1; i < ticks; i++) {
    mem = botThink(snapshotFor(w, botId), arenaFor(w), mem, r).mem;
    step(w, TICK_MS);
  }
  return botThink(snapshotFor(w, botId), arenaFor(w), mem, r).input;
}

test('a bot aims at a hunted enemy in view over a nearer ordinary one', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const w = emptyWorld();
    const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
    spawnAt(w, 1200, 1000);
    equip(spawnAt(w, 1000, 1400), 'executioner');
    const angle = think(w, bot.id, seed, 20).angle;
    assert.ok(Math.abs(angle - Math.PI / 2) < 0.3, `seed ${seed}: aims down at the hunted enemy, angle ${angle.toFixed(2)}`);
  }
});

test('a bot with nobody in view heads for the hunted marker on its minimap', () => {
  for (let seed = 1; seed <= 5; seed++) {
    for (const corner of [{ x: 100, y: 100 }, { x: 2900, y: 2900 }]) {
      const w = emptyWorld();
      const bot = spawnAt(w, 1500, 1500);
      equip(spawnAt(w, corner.x, corner.y), 'executioner');
      step(w, TICK_MS);
      const input = think(w, bot.id, seed, 1);
      const toward = corner.x < 1500 ? input.left && input.up : input.right && input.down;
      assert.ok(toward, `seed ${seed}: moves toward the marker at (${corner.x}, ${corner.y})`);
    }
  }
});

test('a bot chases the nearer of two hunted markers', () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 1500, 1500);
  equip(spawnAt(w, 200, 1500), 'executioner');
  equip(spawnAt(w, 2900, 2900), 'executioner');
  step(w, TICK_MS);
  const input = think(w, bot.id, 1, 1);
  assert.ok(input.left && !input.right && !input.down, 'heads left to the marker 1300px away, not the one 1980px away');
});

test('a bot with nobody in view shoots a crate in the clear and scores for it', () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  addCrate(w, 1300, 1000);
  const r = seeded(1);
  let mem = newBotMemory(r);
  for (let i = 0; i < 90; i++) {
    const d = botThink(snapshotFor(w, bot.id), arenaFor(w), mem, r);
    mem = d.mem;
    setInput(w, bot.id, i + 1, d.input);
    step(w, TICK_MS);
  }
  assert.ok(bot.score > 0, `scored ${bot.score} from the crate`);
});

test('a bot holds fire at a crate behind a wall', () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000);
  addCrate(w, 1300, 1000);
  const wall: WallView = { x: 1130, y: 900, w: 40, h: 200, built: false, material: 'concrete' };
  const r = seeded(1);
  setWalls(w, [wall]);
  assert.ok(!botThink(snapshotFor(w, bot.id), arenaFor(w), newBotMemory(r), r).input.fire, 'no shots into the wall');
});

test('a bot keeps half a magazine for enemies instead of emptying it into crates', () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  addCrate(w, 1300, 1000);
  if (bot.life.k === 'alive') bot.life.ammo = 5;
  const r = seeded(1);
  const input = botThink(snapshotFor(w, bot.id), arenaFor(w), newBotMemory(r), r).input;
  assert.ok(!input.fire && input.reload, 'reloads rather than shooting the crate');
});

test('a bot fights an enemy in view before shooting crates', () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  addCrate(w, 1300, 1000);
  spawnAt(w, 1000, 1350);
  const angle = think(w, bot.id, 1, 20).angle;
  assert.ok(Math.abs(angle - Math.PI / 2) < 0.3, `aims down at the enemy, angle ${angle.toFixed(2)}`);
});

test('a bot passes over an enemy behind a crate for one in the clear', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const w = emptyWorld();
    const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
    addCrate(w, 1150, 1000);
    spawnAt(w, 1300, 1000);
    spawnAt(w, 1000, 1400);
    const angle = think(w, bot.id, seed, 20).angle;
    assert.ok(Math.abs(angle - Math.PI / 2) < 0.3, `seed ${seed}: aims down at the enemy in the clear, angle ${angle.toFixed(2)}`);
  }
});

test('a bot aims at the highest-level human in view over a nearer fresh enemy', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const w = emptyWorld();
    const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
    spawnAt(w, 1200, 1000);
    spawnAt(w, 1000, 1400, { kind: 'human' }).level = 3;
    const angle = think(w, bot.id, seed, 20).angle;
    assert.ok(Math.abs(angle - Math.PI / 2) < 0.3, `seed ${seed}: aims down at the level-3 human, angle ${angle.toFixed(2)}`);
  }
});

test('a bot aims at the nearer of two bots whatever their levels', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const w = emptyWorld();
    const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
    spawnAt(w, 1200, 1000);
    spawnAt(w, 1000, 1400).level = 3;
    const angle = think(w, bot.id, seed, 20).angle;
    assert.ok(Math.abs(angle) < 0.3, `seed ${seed}: aims right at the nearer level-0 bot, angle ${angle.toFixed(2)}`);
  }
});

/** Holds an automatic's trigger down, so the shooter keeps firing (and being heard) while the bot thinks. */
const firing = (w: World, x: number, y: number) => {
  const p = spawnAt(w, x, y, { loadout: { weapon: 'assault' } });
  setInput(w, p.id, 1, { ...IDLE_INPUT, fire: true, angle: Math.PI / 2, shots: 1 });
  return p;
};

test('a bot with nobody in view heads for gunfire it hears (never a minimap dot), the hunted first', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const w = emptyWorld();
    const bot = spawnAt(w, 1500, 1500);
    firing(w, 700, 900);
    const input = think(w, bot.id, seed, 6);
    assert.equal(snapshotFor(w, bot.id).minimap.length, 0, 'the shooter is not on its minimap');
    assert.ok(input.left && input.up, `seed ${seed}: moves toward the shots it heard from (700, 900)`);
  }
  const w = emptyWorld();
  const bot = spawnAt(w, 1500, 1500);
  firing(w, 400, 1500);
  equip(spawnAt(w, 2900, 2900), 'executioner');
  step(w, TICK_MS);
  const input = think(w, bot.id, 1, 6);
  assert.ok(input.right && input.down, 'passes over a nearer shooter it hears for the hunted one');
});

test('a bot walled off from a hunted marker walks around the wall and fights instead of pinning against it', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const w = emptyWorld();
    w.walls.push({ x: 1100, y: 1000, w: 50, h: 1000, built: false, material: 'concrete', expiresAt: Infinity });
    const bot = spawnAt(w, 1050, 1500);
    const hunted = spawnAt(w, 1200, 1500, { kind: 'human' });
    equip(hunted, 'executioner');
    const fullHp = hpOf(hunted);
    const r = seeded(seed);
    let mem = newBotMemory(r);
    for (let i = 1; i <= 20 * 30 && hpOf(hunted) === fullHp; i++) {
      const d = botThink(snapshotFor(w, bot.id), arenaFor(w), mem, r);
      mem = d.mem;
      setInput(w, bot.id, i, d.input);
      step(w, TICK_MS);
    }
    assert.ok(hpOf(hunted) < fullHp, `seed ${seed}: reached a line of fire within 20s; ended at (${Math.round(bot.x)}, ${Math.round(bot.y)})`);
  }
});
