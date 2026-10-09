/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_DAMAGE_TO_HUMAN, type GunId, type PlayerKind } from '../src/shared/defs.ts';
import type { InputState } from '../src/shared/protocol.ts';
import { step } from '../src/shared/sim.ts';
import { easedSpread, effectiveStats } from '../src/shared/sim/stats.ts';
import { emptyWorld, equip, press, spawnAt, TICK_MS } from './helpers.ts';

/**
 * One fixed run of a soldier `kind` against a victim `victim`, in a fresh world: the same loadout, perks, spot and inputs every time, a
 * walk, a sprint, a spray on the move and a planted one, a reload. Everything the sim decides is recorded tick by tick: where he stands,
 * his bloom and eased spread, his magazine and reload, each round's heading and speed (spread), and the victim's health (damage).
 */
function trace(kind: PlayerKind, gun: GunId, victim: PlayerKind = 'bot') {
  const w = emptyWorld();
  const me = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault', armor: 'medium' }, kind });
  const foe = spawnAt(w, 1250, 1000, { loadout: { armor: 'heavy' }, kind: victim });
  // Heavy armor and Thick Skin, topped back up every tick (below): no single tick's rounds drop him, so every round's damage counts.
  foe.perks = { 2: 'thickSkin' };
  if (foe.life.k === 'alive') foe.life.hp = effectiveStats(foe).maxHp;
  equip(me, gun);
  me.perks = { 2: 'steadyHands' };
  const stats = effectiveStats(me);
  const rows: unknown[] = [];
  const plan: [number, Partial<InputState>][] = [
    [20, { right: true }], [25, { right: true, sprint: true }], [6, {}], [30, { up: true, fire: true }],
    [40, { fire: true }], [30, {}], [5, { reload: true }], [50, {}], [30, { down: true, left: true, fire: true }],
  ];
  let shots = 0, dealt = 0;
  for (const [ticks, input] of plan) {
    for (let i = 0; i < ticks; i++) {
      if (input.fire) shots++;
      press(w, me, { ...input, angle: Math.atan2(foe.y - me.y, foe.x - me.x) + 0.01 * Math.sin(i), shots, aimDist: 400 });
      step(w, TICK_MS);
      const hit = foe.life.k === 'alive' ? effectiveStats(foe).maxHp - foe.life.hp : NaN;
      dealt += hit;
      if (foe.life.k === 'alive') foe.life.hp = effectiveStats(foe).maxHp;
      const life = me.life.k === 'alive' ? me.life : null;
      rows.push({
        x: me.x, y: me.y, spray: life?.spray, spread: life ? easedSpread(life.spreadHist) : null, ammo: life?.ammo, reload: life?.reloadUntil,
        rounds: w.bullets.filter((b) => b.owner === me.id).map((b) => [b.vx, b.vy, b.damage, b.left]), hit,
      });
    }
  }
  return { stats, rows, dealt };
}

test('a bot and a person with the same loadout, perks, spot and inputs get the same stats, movement, spread, bloom and damage through the sim', () => {
  for (const gun of ['assault', 'smg', 'sniper', 'lmg', 'shotgun', 'pistol'] as const satisfies readonly GunId[]) {
    const person = trace('human', gun), bot = trace('bot', gun);
    assert.deepEqual(bot.stats, person.stats, `${gun}: every stat the same (speed, health, magazine, reload, view, regen)`);
    assert.ok(person.dealt > 0, `${gun}: the run lands rounds`);
    assert.deepEqual(bot.rows, person.rows, `${gun}: tick for tick the same`);
  }
});

test('the one rule between them: a bot\'s damage to a person counts 0.8, every other pairing full', () => {
  const on = (shooter: PlayerKind, victim: PlayerKind) => trace(shooter, 'assault', victim).dealt;
  const base = on('bot', 'bot');
  assert.ok(base > 0);
  assert.equal(on('human', 'human'), base, 'person on person');
  assert.equal(on('human', 'bot'), base, 'person on bot');
  assert.ok(Math.abs(on('bot', 'human') - BOT_DAMAGE_TO_HUMAN * base) < 1e-6, `bot on person ${on('bot', 'human')} vs ${BOT_DAMAGE_TO_HUMAN} x ${base}`);
});
