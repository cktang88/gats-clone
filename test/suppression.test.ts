import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARMOR_IDS, ARMORS, GUNS, loadoutWalkMul, minSpreadOf, rulesOf, SUPPRESSION, type GunId } from '../src/shared/defs.ts';
import { step } from '../src/shared/sim.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { effectiveStats, spreadFor, suppressionMul } from '../src/shared/sim/stats.ts';
import { fillSnapshot, makeSnapshotEncoder } from '../src/shared/wire.ts';
import type { Player } from '../src/shared/sim/world.ts';
import { emptyWorld, equip, press, run, spawnAt, TICK_MS } from './helpers.ts';

const life = (p: Player) => {
  if (p.life.k !== 'alive') throw new Error('not alive');
  return p.life;
};

function fire(w: ReturnType<typeof emptyWorld>, p: Player) {
  press(w, p, { angle: 0, fire: true, shots: p.input.shots + 1 });
  step(w, TICK_MS);
  press(w, p, { angle: 0 });
}

/** Fires `gun` from (300, 500) past a target standing just off the line, for `ms`, and returns the target's suppression after each tick. */
function sprayPast(gun: GunId, ms: number) {
  const w = emptyWorld();
  const shooter = spawnAt(w, 300, 500);
  const target = spawnAt(w, 650, 500 + 24 + SUPPRESSION.px / 2);
  equip(shooter, gun);
  if (shooter.life.k === 'alive') shooter.life.ammo = 999;
  const trace: number[] = [];
  for (let t = 0; t < ms; t += TICK_MS) {
    press(w, shooter, { angle: 0, fire: true, shots: shooter.input.shots + 1 });
    step(w, TICK_MS);
    trace.push(life(target).suppression);
  }
  press(w, shooter, { angle: 0 });
  return { w, target, trace };
}

test('a round passing close suppresses an enemy, they are told over the wire, and it fades', () => {
  const { w, target, trace } = sprayPast('lmg', 600);
  assert.equal(life(target).hp, effectiveStats(target).maxHp, 'every round missed');
  assert.ok(Math.max(...trace) > 0.5, 'a burst of near misses suppresses');
  const wire = fillSnapshot(JSON.parse(makeSnapshotEncoder()(snapshotFor(w, target.id))), null);
  assert.equal(wire?.self.suppression, Math.round(life(target).suppression * 100) / 100, 'the client gets it to the hundredth');
  run(w, 3000);
  assert.equal(life(target).suppression, 0, 'suppression fades');
});

test('a machine gun pins a target down, while a pistol or a sniper only makes them flinch', () => {
  const peak = (gun: GunId) => Math.max(...sprayPast(gun, 2000).trace);
  const settled = (gun: GunId) => sprayPast(gun, 2000).trace.at(-1)!;
  assert.equal(peak('lmg'), 1, 'two seconds of LMG fire suppresses fully');
  assert.ok(peak('pistol') < 0.25 && settled('pistol') < 0.15, `a pistol barely stacks (${peak('pistol')})`);
  assert.ok(peak('sniper') <= rulesOf(GUNS.sniper).suppress + 1e-9, 'sniper shots never stack');
  const sniper = sprayPast('sniper', 100);
  run(sniper.w, 600);
  assert.equal(life(sniper.target).suppression, 0, 'a sniper crack is shaken off within about half a second');
  const lmg = sprayPast('lmg', 1000);
  run(lmg.w, 1000);
  assert.ok(life(lmg.target).suppression > 0, 'machine gun suppression lingers past a second');
});

test('suppression breaks a planted sniper\'s pinpoint', () => {
  assert.equal(spreadFor('sniper', {}, true, 0, 0), minSpreadOf(GUNS.sniper), 'pinpoint, down to its floor');
  assert.ok(spreadFor('sniper', {}, true, 0, 0.5) > GUNS.sniper.spread, 'a suppressed sniper wavers');
  assert.ok(spreadFor('assault', {}, true, 0, 1) > spreadFor('assault', {}, true, 0, 0));
});

test('suppression widens spread, up to its cap', () => {
  assert.equal(suppressionMul(0), 1);
  assert.equal(suppressionMul(1), 1 + SUPPRESSION.spread);
});

test('a round passing far off, or a teammate\'s, does not suppress', () => {
  const w = emptyWorld('TDM');
  const shooter = spawnAt(w, 300, 500, { team: 'red' });
  const far = spawnAt(w, 700, 500 + 24 + SUPPRESSION.px + 40, { team: 'blue' });
  const mate = spawnAt(w, 700, 500 + 40, { team: 'red' });
  // A control: an enemy just as close to the line as the teammate, so a shot that never flew cannot pass for one that spared them.
  const near = spawnAt(w, 900, 500 - 40, { team: 'blue' });
  equip(shooter, 'sniper');
  run(w, 600);
  fire(w, shooter);
  // Suppression fades within a second, so take the most each felt while the round flew.
  const peak = { near: 0, far: 0, mate: 0 };
  for (let t = 0; t < 700; t += TICK_MS) {
    step(w, TICK_MS);
    peak.near = Math.max(peak.near, life(near).suppression);
    peak.far = Math.max(peak.far, life(far).suppression);
    peak.mate = Math.max(peak.mate, life(mate).suppression);
  }
  assert.ok(peak.near > 0, 'the round flew and suppressed the near enemy');
  assert.equal(peak.far, 0);
  assert.equal(peak.mate, 0);
});

test('heavier armor and heavier guns slow you down more', () => {
  const speeds = ARMOR_IDS.map((a) => loadoutWalkMul(GUNS.assault, a));
  for (let i = 1; i < speeds.length; i++) assert.ok(speeds[i]! < speeds[i - 1]!, 'each armor tier is slower than the one below');
  assert.ok(loadoutWalkMul(GUNS.pistol, 'heavy') <= 0.75, 'heavy armor is a real burden');
  assert.ok(GUNS.lmg.moveMul < GUNS.assault.moveMul && GUNS.assault.moveMul < GUNS.smg.moveMul);
  assert.ok(GUNS.juggernaut.moveMul < GUNS.lmg.moveMul);
});

test('most rounds fly slow enough to sidestep at range, while sniper rounds stay fast', () => {
  for (const gun of ['pistol', 'smg', 'shotgun', 'assault', 'lmg'] as const) assert.ok(GUNS[gun].bulletSpeed <= 1100, `${gun} ${GUNS[gun].bulletSpeed}px/s`);
  assert.ok(GUNS.sniper.bulletSpeed >= 1600);
});
