import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUNS, WORLD } from '../src/shared/defs.ts';
import type { GameEvent } from '../src/shared/protocol.ts';
import { removePlayer, setInput, step } from '../src/shared/sim.ts';
import { explode } from '../src/shared/sim/combat.ts';
import { IDLE_INPUT, type Player, type World } from '../src/shared/sim/world.ts';
import { emptyWorld, equip, hpOf, press, run, spawnAt, TICK_MS } from './helpers.ts';

function pressAndCollect(w: World, shooter: Player, ms: number): GameEvent[] {
  const events: GameEvent[] = [];
  press(w, shooter, { angle: 0, shots: shooter.input.shots + 1 });
  step(w, TICK_MS);
  events.push(...w.events);
  press(w, shooter, { angle: 0 });
  for (let t = 0; t < ms; t += TICK_MS) { step(w, TICK_MS); events.push(...w.events); }
  return events;
}

const ammoOf = (p: Player) => (p.life.k === 'alive' ? p.life.ammo : 0);

test('one press of a burst gun fires its burst, one round of ammo each, then waits out the cooldown', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500);
  equip(a, 'machinePistol');
  const burst = { count: GUNS.machinePistol.burst?.count ?? 1 };
  const shots = (events: GameEvent[]) => events.filter((e) => e.e === 'shot').length;
  assert.equal(shots(pressAndCollect(w, a, GUNS.machinePistol.fireMs + 200)), burst.count, 'a single press');
  assert.equal(ammoOf(a), GUNS.machinePistol.mag - burst.count);
  assert.equal(shots(pressAndCollect(w, a, GUNS.machinePistol.fireMs + 200)), burst.count, 'the next press after the cooldown');
  assert.equal(ammoOf(a), GUNS.machinePistol.mag - 2 * burst.count);
});

test('a penetrating round hits one more player than it can pass through, then stops', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500);
  equip(a, 'executioner');
  const line = [700, 800, 900].map((x) => spawnAt(w, x, 500));
  pressAndCollect(w, a, 500);
  assert.equal(GUNS.executioner.penetrate, 1);
  assert.deepEqual(line.map((p) => WORLD.baseHp - hpOf(p)), [GUNS.executioner.damage, GUNS.executioner.damage, 0]);
  assert.equal(w.bullets.length, 0);
});

test('a blast round damages bodies within its radius where it stops: at a wall, or at the end of its range', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500);
  equip(a, 'boomSlug');
  w.walls.push({ x: 800, y: 300, w: 20, h: 400, built: false, material: 'concrete', expiresAt: Infinity });
  const nearWall = spawnAt(w, 770, 545);
  const clear = spawnAt(w, 770, 680);
  pressAndCollect(w, a, GUNS.boomSlug.fireMs + 50);
  assert.ok(hpOf(nearWall) < WORLD.baseHp, 'a body beside the impact takes splash');
  assert.equal(hpOf(clear), WORLD.baseHp, 'a body outside the radius does not');

  w.walls = [];
  const rangeEnd = a.x + WORLD.playerRadius + 4 + GUNS.boomSlug.range;
  const atRangeEnd = spawnAt(w, rangeEnd, 560);
  pressAndCollect(w, a, 1000);
  assert.ok(hpOf(atRangeEnd) < WORLD.baseHp, 'a spent round still bursts');
});

test('a blast never reaches a body on the far side of a wall, the struck wall included', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 300, 500);
  equip(a, 'artillery');
  w.walls.push({ x: 600, y: 400, w: 40, h: 200, built: false, material: 'concrete', expiresAt: Infinity });
  w.walls.push({ x: 520, y: 600, w: 60, h: 20, built: true, expiresAt: Infinity });
  const behindStruck = spawnAt(w, 680, 500);
  const besideImpact = spawnAt(w, 560, 540);
  const behindBuilt = spawnAt(w, 560, 650);
  pressAndCollect(w, a, 600);
  assert.equal(hpOf(behindStruck), WORLD.baseHp, 'the wall the shell hit shelters the far side');
  assert.equal(hpOf(behindBuilt), WORLD.baseHp, 'a built wall between the blast and a body shelters it');
  assert.ok(hpOf(besideImpact) < WORLD.baseHp, 'a body in the open on the near side takes splash');
});

test('a blast hurts crates less the farther they sit from its center', () => {
  const w = emptyWorld();
  const near = { id: 1, x: 500, y: 490, size: 20, hp: WORLD.crateHp, respawnAt: null };
  const far = { id: 2, x: 550, y: 490, size: 20, hp: WORLD.crateHp, respawnAt: null };
  w.crates.push(near, far);
  explode(w, 480, 500, 100, 30, { attacker: null, team: null, label: 'test' });
  assert.equal(near.hp, WORLD.crateHp - 30 * (1 - 20 / 100));
  assert.equal(far.hp, WORLD.crateHp - 30 * (1 - 70 / 100));
});

test('a lag-compensated blast round bursts on the victim where the shooter saw them, not where they stand now', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500);
  equip(a, 'boomSlug');
  const victim = spawnAt(w, 700, 500);
  run(w, 500);
  const sawAt = w.now - 200;
  victim.y = 800;
  step(w, TICK_MS);
  setInput(w, a.id, 1_000_000, { ...IDLE_INPUT, angle: 0, shots: a.input.shots + 1 }, sawAt);
  run(w, 300);
  const lost = WORLD.baseHp - hpOf(victim);
  assert.ok(lost > GUNS.boomSlug.damage + GUNS.boomSlug.blast!.damage * 0.9, `took the round and the burst around the rewound pose (lost ${lost})`);
});

test('a blast hurts its owner for half, never a teammate, and a self-kill earns nothing', () => {
  const w = emptyWorld('TDM');
  const owner = spawnAt(w, 500, 500, { team: 'red' });
  const mate = spawnAt(w, 540, 540, { team: 'red' });
  explode(w, 500, 540, 100, 40, { attacker: owner, team: owner.team, label: 'Grenade' });
  assert.ok(Math.abs(WORLD.baseHp - hpOf(owner) - 40 * (1 - (40 - WORLD.playerRadius) / 100) * 0.5) < 1e-9, 'half what an enemy there would take');
  assert.equal(hpOf(mate), WORLD.baseHp, 'a teammate takes nothing');
  const shooter = spawnAt(w, 300, 900, { team: 'red' });
  equip(shooter, 'artillery');
  w.walls.push({ x: 340, y: 800, w: 40, h: 200, built: false, material: 'concrete', expiresAt: Infinity });
  const before = hpOf(shooter);
  pressAndCollect(w, shooter, 300);
  assert.ok(hpOf(shooter) < before, 'firing artillery into a wall at point blank hurts the shooter');
  if (owner.life.k === 'alive') owner.life.hp = 1;
  explode(w, 500, 500, 100, 40, { attacker: owner, team: owner.team, label: 'Grenade' });
  assert.equal(owner.life.k, 'dead');
  assert.deepEqual([owner.kills, owner.score, w.teamScore.red], [0, 0, 0], 'no kill, score or team point for blowing yourself up');
});

test('a round or grenade from a player who left still spares their old team', () => {
  const w = emptyWorld('TDM');
  const shooter = spawnAt(w, 500, 500, { team: 'red' });
  const mate = spawnAt(w, 900, 500, { team: 'red' });
  const enemy = spawnAt(w, 1200, 500, { team: 'blue' });
  press(w, shooter, { angle: 0, shots: 1 });
  step(w, TICK_MS);
  w.thrown.push({ id: 999, kind: 'fragGrenade', owner: shooter.id, team: shooter.team, x: 900, y: 560, vx: 0, vy: 0, explodeAt: w.now + 100 });
  removePlayer(w, shooter.id);
  run(w, 900);
  assert.equal(hpOf(mate), WORLD.baseHp, 'neither the round nor the blast hurt a teammate');
  assert.ok(hpOf(enemy) < WORLD.baseHp, 'the round flew on to the enemy');
});

test('a silenced gun fires without revealing the shooter, like the silencer perk', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500);
  equip(a, 'phantom');
  const shot = pressAndCollect(w, a, 100).find((e) => e.e === 'shot');
  assert.ok(shot?.e === 'shot' && shot.silenced);
  assert.ok(w.now >= a.revealedUntil);
});
