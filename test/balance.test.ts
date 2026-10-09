/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUN_IDS, GUNS, LEVELS, WORLD } from '../src/shared/defs.ts';
import { addPlayer, step } from '../src/shared/sim.ts';
import { effectiveStats, levelForScore } from '../src/shared/sim/stats.ts';
import { createWorld, rand } from '../src/shared/sim/world.ts';
import { ROTATION, type MapId } from '../src/shared/maps.ts';
import { newBotMemory, randomLoadout, type BotMemory } from '../src/server/bots.ts';
import { thinkBots } from '../src/server/bot/tick.ts';
import { emptyWorld, run, shootOnce, spawnAt, TICK_MS } from './helpers.ts';

test('a bolt-action hit kills an unarmored full-health player', () => {
  const w = emptyWorld();
  const sniper = spawnAt(w, 1000, 1000, { loadout: { weapon: 'sniper' } });
  const target = spawnAt(w, 1600, 1000, { loadout: { armor: 'none' } });
  // Planted first, so the round goes where it is aimed: a fresh spawn's unsettled spread can carry it 30 px wide at 600 px.
  run(w, 600);
  shootOnce(w, sniper, 0, 800);
  assert.equal(target.life.k, 'dead');
});

test('a point-blank shotgun blast kills an unarmored full-health player', () => {
  const w = emptyWorld();
  const shotgun = spawnAt(w, 1000, 1000, { loadout: { weapon: 'shotgun' } });
  const target = spawnAt(w, 1060, 1000, { loadout: { armor: 'none' } });
  shootOnce(w, shotgun, 0, 300);
  assert.equal(target.life.k, 'dead');
});

test('every gun that promises a kill in one or two hits keeps that promise through heavy armor, a pellet gun counting a point-blank blast as one hit', () => {
  for (const id of GUN_IDS.filter((g) => GUNS[g].breakpoint)) {
    const g = GUNS[id];
    const w = emptyWorld();
    const shooter = spawnAt(w, 1000, 1000, { loadout: { weapon: g.base } });
    shooter.gun = id;
    const target = spawnAt(w, 1000 + (g.pellets > 1 ? 60 : 300), 1000, { loadout: { armor: 'heavy' } });
    // Settled first, so the test is of damage, not of the spread a gun fired off the spawn has (a bot's is a person's: no tighter).
    run(w, 1000);
    for (let hit = 1; hit <= g.breakpoint!; hit++) shootOnce(w, shooter, 0, (g.burst ? g.burst.count * g.burst.gapMs : 0) + g.fireMs + (g.mag === 1 ? g.reloadMs : 0) + 100);
    assert.equal(target.life.k, 'dead', `${g.name} kills heavy armor in ${g.breakpoint}`);
  }
  const w = emptyWorld();
  const executioner = spawnAt(w, 1000, 1000, { loadout: { weapon: 'pistol' } });
  executioner.gun = 'executioner';
  const thick = spawnAt(w, 1300, 1000, { loadout: { armor: 'heavy' } });
  thick.perks[2] = 'thickSkin';
  if (thick.life.k === 'alive') thick.life.hp = effectiveStats(thick).maxHp;
  for (let hit = 0; hit < 2; hit++) shootOnce(w, executioner, 0, GUNS.executioner.fireMs + 100);
  assert.equal(thick.life.k, 'dead', 'two Executioner rounds drop heavy armor and Thick skin');
});

/** A fixed-seed FFA room of bots: the level each life ended at, and each kill's life score just after it over that life's kill count. */
function botRoom(seed: number, map: MapId, minutes: number): { levels: number[]; perKill: number[] } {
  const w = createWorld('FFA', seed, map);
  const r = () => rand(w);
  const bots = new Map<number, BotMemory>();
  for (let i = 0; i < WORLD.minPlayers; i++) bots.set(addPlayer(w, `bot${i}`, randomLoadout(r)).id, newBotMemory(r));
  const levels: number[] = [], perKill: number[] = [];
  for (let t = 0; t < minutes * 60_000; t += TICK_MS) {
    thinkBots(w, bots, r);
    step(w, TICK_MS);
    for (const e of w.events) {
      const p = e.e === 'kill' && e.killerId !== null && e.killerId !== e.victimId ? w.players.get(e.killerId) : undefined;
      if (p && p.life.k === 'alive' && p.lifeKills > 0) perKill.push(p.score / p.lifeKills);
    }
    for (const rec of w.lifeRecords.splice(0)) levels.push(levelForScore(rec.score));
  }
  return { levels, perKill };
}

test('in a room of bots, the score a kill really pays (medals and catch-up included) puts the first evolve at kill 2 to 3 and the second at kill 6 to 7', () => {
  // One room gives ~250 lives; ten rooms (~800 lives, ~800 kills) hold the median score per kill within a few points.
  const rooms = Array.from({ length: 10 }, (_, i) => botRoom(i + 1, ROTATION.FFA[i % ROTATION.FFA.length]!, 2));
  const levels = rooms.flatMap((room) => room.levels);
  const perKill = rooms.flatMap((room) => room.perKill).sort((a, b) => a - b);
  const typical = perKill[Math.floor(perKill.length / 2)]!;
  const [first, second] = LEVELS.flatMap((l) => (l.pick?.k === 'evolve' ? [l.score / typical] : []));
  const reach = (level: number) => levels.filter((l) => l >= level).length / levels.length;
  const firstEvolve = reach(LEVELS.findIndex((l) => l.pick?.k === 'evolve'));
  const ability = reach(LEVELS.findIndex((l) => l.pick?.k === 'perk' && l.pick.tier === 3));
  const shares = `a kill pays ${typical.toFixed(0)} (median of ${perKill.length}): first evolve at kill ${first!.toFixed(1)}, second at kill ${second!.toFixed(1)}; `
    + `first evolve reached by ${(firstEvolve * 100).toFixed(1)}%, ability by ${(ability * 100).toFixed(1)}% of ${levels.length} lives`;
  assert.ok(first! >= 2 && first! <= 3 && second! >= 6 && second! <= 7, shares);
  assert.ok(firstEvolve >= 0.03 && ability > 0, `progression has not stalled: ${shares}`);
  assert.ok(LEVELS[1]!.pick?.k === 'perk' && first! - LEVELS[1]!.score / typical >= 1, `the attachment comes a kill or more before the first evolve: ${shares}`);
});

test('no rifle out-damages the SMG at close range', () => {
  const dps = (id: keyof typeof GUNS) => (GUNS[id].damage * GUNS[id].pellets * 1000) / GUNS[id].fireMs;
  for (const id of ['assault', 'lmg', 'pistol'] as const) assert.ok(dps(id) < dps('smg'), `${id} ${dps(id).toFixed(0)} < smg ${dps('smg').toFixed(0)}`);
});
