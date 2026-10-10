/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WORLD } from '../src/shared/defs.ts';
import { addPlayer, step } from '../src/shared/sim.ts';
import { createWorld, rand, type World } from '../src/shared/sim/world.ts';
import { newBotMemory, randomLoadout, type BotMemory } from '../src/server/bots.ts';
import { aimSigma, BOT_SKILL, engage, handFor, HANDS, sharpnessAgainst, SHARPNESS, skilled, skillFor, skillKnobs, skillOf, slowHand, VETERAN, type Engagement } from '../src/server/bot/aim.ts';
import { PERSONALITIES, skilledPersona } from '../src/server/bot/intent.ts';
import { thinkBots } from '../src/server/bot/tick.ts';
import { duels } from '../scripts/bench-bots.ts';

const NAMES = Array.from({ length: 40 }, (_, i) => `player_${i}`);

test('a bot\'s skill is hashed from its name and the room\'s seed: the same each time, and not the same in every room', () => {
  for (const name of NAMES) assert.deepEqual(skillFor(name, 1234), skillFor(name, 1234), name);
  const a = NAMES.map((n) => skillFor(n, 1).value), b = NAMES.map((n) => skillFor(n, 2).value);
  assert.notDeepEqual(a, b, 'another room deals other skills');
  assert.ok(new Set(a.map((v) => v.toFixed(6))).size === a.length, 'every name its own value');
  // A bot that leaves and comes back under its name is the same player.
  const r = () => 0.5;
  assert.deepEqual(newBotMemory(r, { name: 'TheoPlays', seed: 99 }).skill, newBotMemory(r, { name: 'TheoPlays', seed: 99 }).skill);
  // Without a name (benches and scripts), it is drawn from the seeded stream: the same seed deals the same skills.
  const deal = (seed: number) => { const w = createWorld('FFA', seed, 'plaza'); return Array.from({ length: 10 }, () => newBotMemory(() => rand(w)).skill); };
  assert.deepEqual(deal(5), deal(5));
});

test('a bot keeps its skill across its deaths and respawns', () => {
  const w: World = createWorld('FFA', 3, 'plaza');
  const r = () => rand(w);
  const mems = new Map<number, BotMemory>();
  for (let i = 0; i < WORLD.minPlayers; i++) {
    const name = `bot${i}`;
    mems.set(addPlayer(w, name, randomLoadout(r)).id, newBotMemory(r, { name, seed: 3 }));
  }
  const first = new Map([...mems].map(([id, m]) => [id, m.skill]));
  let respawns = 0;
  for (let t = 0; t < 30 * 90 && respawns < 3; t++) {
    respawns += thinkBots(w, mems, r).respawned.length;
    step(w, 1000 / WORLD.tickHz);
  }
  assert.ok(respawns >= 1, `someone died and came back (${respawns})`);
  for (const [id, m] of mems) assert.deepEqual(m.skill, first.get(id), `bot ${id} keeps its skill`);
});

test('skills fall in the bands: about a quarter rookies, a bit over half regulars, a fifth veterans', () => {
  const n = 20_000, count = { rookie: 0, regular: 0, veteran: 0 };
  for (let i = 0; i < n; i++) count[skillFor(`name${i}`, 77).tier]++;
  const { bands } = BOT_SKILL;
  const want = { rookie: bands.rookie, regular: bands.regular - bands.rookie, veteran: 1 - bands.regular };
  for (const tier of ['rookie', 'regular', 'veteran'] as const) assert.ok(Math.abs(count[tier] / n - want[tier]) < 0.015, `${tier}: ${count[tier] / n} vs ${want[tier]}`);
  for (const [tier, share] of [['rookie', 0.25], ['regular', 0.55], ['veteran', 0.2]] as const) assert.ok(Math.abs(want[tier] - share) < 1e-9, tier);
});

test('skill is continuous: knobs move steadily from the worst rookie to a veteran, and every veteran is today\'s bot', () => {
  let prev = skillKnobs(skillOf(0));
  for (let v = 0.01; v < 1; v += 0.01) {
    const k = skillKnobs(skillOf(v));
    assert.ok(k.aimMul <= prev.aimMul + 1e-9 && k.reactMul <= prev.reactMul + 1e-9 && k.turnMul >= prev.turnMul - 1e-9, `v ${v.toFixed(2)}`);
    assert.ok(Math.abs(k.aimMul - prev.aimMul) < 0.05, 'no jump at a band edge');
    prev = k;
  }
  assert.equal(skillKnobs(skillOf(0.85)), BOT_SKILL.veteran);
  assert.equal(skillKnobs(VETERAN), BOT_SKILL.veteran);
  assert.equal(skilled(SHARPNESS[0]!, BOT_SKILL.veteran), SHARPNESS[0], 'a veteran aims as bots did');
  assert.equal(skilledPersona(PERSONALITIES.cautious, BOT_SKILL.veteran), PERSONALITIES.cautious, 'and plays its temper as they did');
});

test('a rookie\'s aim error is at least 1.25 times a veteran\'s, and it is slower to take an enemy in, turn and read his motion', () => {
  const rookie = skillKnobs(skillOf(0.1)), veteran = skillKnobs(skillOf(0.9));
  const enemy = { id: 4, x: 400, y: 0 };
  for (const row of SHARPNESS) {
    const r = skilled(row, rookie), v = skilled(row, veteran);
    const e: Engagement = { id: 4, x: 400, y: 0, vx: 0, vy: 220, acquiredTick: 0, noticeAtTick: 10, leadMul: 1, at: 30 };
    for (const tick of [10, 30, 100]) {
      const ratio = aimSigma(e, { x: 0, y: 0 }, r, tick) / aimSigma(e, { x: 0, y: 0 }, v, tick);
      assert.ok(ratio >= 1.25, `aim error ${ratio.toFixed(2)}x at tick ${tick}`);
    }
    const mid = () => 0.5;
    assert.ok(engage(null, enemy, r, 0, mid).noticeAtTick > engage(null, enemy, v, 0, mid).noticeAtTick, 'slower on the draw');
    assert.ok(handFor(r).omega < handFor(v).omega && handFor(r).maxSpin < handFor(v).maxSpin, 'a slower hand');
  }
  assert.ok(slowHand(HANDS.startle, rookie.turnMul).omega < HANDS.startle.omega, 'a slower startled turn');
  // Tracking lag: a target that turns, read by each over the same ticks; the rookie's read of his speed trails further behind.
  const read = (k: typeof rookie) => {
    const s = skilled(sharpnessAgainst({ kind: 'bot' } as never), k);
    let e = engage(null, { id: 1, x: 300, y: 0 }, s, 0, () => 0.5);
    for (let t = 1; t <= 6; t++) e = engage(e, { id: 1, x: 300, y: t * 8 }, s, t, () => 0.5);
    return e.vy;
  };
  assert.ok(read(rookie) < read(veteran), `rookie reads ${read(rookie).toFixed(0)} px/s of 240, veteran ${read(veteran).toFixed(0)}`);
  assert.ok(rookie.lead.mean < veteran.lead.mean && rookie.lead.spread > veteran.lead.spread, 'under-leads, and guesses wider');
  // Fire discipline and tactics.
  assert.ok(rookie.sprayMul > 1 && rookie.patienceMul < 1, 'sprays longer, waits less on its bloom');
  const p = skilledPersona(PERSONALITIES.cautious, rookie);
  assert.ok(p.takesOdds < PERSONALITIES.cautious.takesOdds && p.flankOdds < PERSONALITIES.cautious.flankOdds, 'takes worse fights, flanks less');
  assert.ok(rookie.readsHeld < 1 && rookie.flankRead < 1, 'peeks held angles more, sees a flank later');
});

test('seeded bench: the scripted human beats rookies more easily than veterans, one bot at a time', () => {
  const sum = (skill: 'rookie' | 'veteran') => [1, 2, 3, 4].map((seed) => duels(skill, seed, 60)).reduce((a, d) => ({ k: a.k + d.kills, d: a.d + d.deaths, dmg: a.dmg + d.damageTaken }), { k: 0, d: 0, dmg: 0 });
  const rookie = sum('rookie'), veteran = sum('veteran');
  const kd = (x: typeof rookie) => x.k / Math.max(1, x.d);
  assert.ok(kd(rookie) > 1.5 * kd(veteran), `K/D ${kd(rookie).toFixed(2)} (rookies) vs ${kd(veteran).toFixed(2)} (veterans)`);
  assert.ok(rookie.dmg < veteran.dmg, `damage taken ${rookie.dmg.toFixed(0)} vs ${veteran.dmg.toFixed(0)}`);
});
