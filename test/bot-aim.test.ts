/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setInput, step } from '../src/shared/sim.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { botThink, newBotMemory, type BotMemory } from '../src/server/bots.ts';
import { drift, freshAim, HANDS, intercept, MUZZLE_PX, turn, wrapAngle, VETERAN, type AimState, type Hand } from '../src/server/bot/aim.ts';
import { GUNS, rulesOf } from '../src/shared/defs.ts';
import { flownAfter } from '../src/shared/sim/ballistics.ts';
import { arenaFor } from '../src/server/bot/arena.ts';
import { emptyWorld, spawnAt, TICK_MS } from './helpers.ts';

const DEG = Math.PI / 180;
const seeded = (seed: number) => { let x = seed; return () => ((x = (x * 16807) % 2147483647) / 2147483647); };

function flick(hand: Hand, to: number, hz: number, ms: number): AimState[] {
  const out: AimState[] = [];
  let aim = freshAim(0);
  for (let t = 0; t < (ms * hz) / 1000; t++) out.push((aim = turn(aim, to, 0, hand, 1000 / hz)));
  return out;
}

test('a gun turns no faster than its hand allows, and a flick still lands within a few hundred ms', () => {
  for (const [name, hand] of Object.entries(HANDS)) {
    const path = flick(hand, 170 * DEG, 30, 1500);
    let prev = 0;
    for (const a of path) {
      assert.ok(Math.abs(a.spin) <= hand.maxSpin + 1e-9, `${name}: spin ${(a.spin / DEG).toFixed(0)}°/s`);
      assert.ok(Math.abs(wrapAngle(a.angle - prev)) <= hand.maxSpin * (TICK_MS / 1000) + 1e-9, `${name}: one tick turned ${(wrapAngle(a.angle - prev) / DEG).toFixed(1)}°`);
      prev = a.angle;
    }
  }
  const landed = flick(HANDS.flick, 170 * DEG, 30, 1000).findIndex((a) => Math.abs(wrapAngle(a.angle - 170 * DEG)) < 2 * DEG);
  assert.ok(landed >= 0 && landed * TICK_MS <= 450, `a 170° flick lands after ${(landed * TICK_MS).toFixed(0)}ms`);
});

test('a flick overshoots by a hair at most and settles without swinging back and forth', () => {
  for (const deg of [20, 60, 120]) {
    const goal = deg * DEG;
    const path = flick(HANDS.flick, goal, 30, 1000);
    const over = Math.max(...path.map((a) => wrapAngle(a.angle - goal)));
    assert.ok(over <= 4 * DEG, `${deg}°: overshoot ${(over / DEG).toFixed(2)}°`);
    const visible = path.map((a) => wrapAngle(a.angle - goal)).filter((e) => Math.abs(e) > 0.1 * DEG);
    const crossings = visible.slice(1).filter((e, i) => Math.sign(e) !== Math.sign(visible[i]!)).length;
    assert.ok(crossings <= 1, `${deg}°: swung across its goal by more than 0.1° ${crossings} times`);
    assert.ok(Math.abs(wrapAngle(path[Math.round(500 / TICK_MS)]!.angle - goal)) < 0.5 * DEG, `${deg}°: settled by 500ms`);
  }
});

test('the same flick at 30Hz and 120Hz traces the same curve', () => {
  const at = (hz: number, ms: number) => flick(HANDS.flick, 90 * DEG, hz, ms).at(-1)!.angle;
  for (const ms of [100, 200, 300]) assert.ok(Math.abs(at(30, ms) - at(120, ms)) < 1 * DEG, `${ms}ms: ${(at(30, ms) / DEG).toFixed(1)}° vs ${(at(120, ms) / DEG).toFixed(1)}°`);
});

test('aim error wanders slowly with the same spread and memory at any tick rate', () => {
  const sigma = 0.05;
  const stats = (hz: number) => {
    const r = seeded(11);
    const dt = 1000 / hz, lag = Math.round(400 / dt);
    const xs: number[] = [];
    let e = 0;
    for (let i = 0; i < hz * 2000; i++) xs.push((e = drift(e, sigma, dt, r)));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length;
    let cov = 0;
    for (let i = lag; i < xs.length; i++) cov += (xs[i]! - mean) * (xs[i - lag]! - mean);
    const steps = xs.slice(1).map((x, i) => Math.abs(x - xs[i]!));
    return { sd: Math.sqrt(variance), corr400: cov / (xs.length - lag) / variance, stepPerSec: (steps.reduce((a, b) => a + b, 0) / steps.length) * hz };
  };
  for (const hz of [30, 120]) {
    const s = stats(hz);
    assert.ok(Math.abs(s.sd - sigma) < 0.1 * sigma, `${hz}Hz: spread ${s.sd.toFixed(4)} rad`);
    assert.ok(Math.abs(s.corr400 - Math.exp(-1)) < 0.06, `${hz}Hz: correlation over 400ms ${s.corr400.toFixed(2)}`);
  }
  const step30 = stats(30);
  assert.ok(step30.stepPerSec * (TICK_MS / 1000) < 0.4 * sigma, `30Hz: mean tick-to-tick step ${(step30.stepPerSec * TICK_MS / 1000).toFixed(4)} rad against a spread of ${sigma}`);
});

test('with nobody in view a bot keeps its gun on where it last saw an enemy while its legs go back and forth', () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  const r = seeded(4);
  const base = newBotMemory(r);
  const seen = { x: 1000, y: 500 };
  let mem: BotMemory = { ...base, awareness: { ...base.awareness, contacts: [{ id: 999, ...seen, seenTick: w.tick, gun: 'pistol' }] } };
  const bearings: number[] = [], angles: number[] = [], legs = new Set<string>();
  for (let i = 0; i < 90; i++) {
    const goal = Math.floor(i / 15) % 2 ? { x: 700, y: 1000 } : { x: 1300, y: 1000 };
    mem = { ...mem, intent: { k: 'patrol', goal, since: 0, holdUntil: 1e9 } };
    const d = botThink(snapshotFor(w, bot.id), arenaFor(w), mem, r);
    mem = d.mem;
    legs.add(`${+d.input.left}${+d.input.right}`);
    setInput(w, bot.id, i + 1, d.input);
    step(w, TICK_MS);
    angles.push(d.input.angle);
    bearings.push(Math.atan2(seen.y - bot.y, seen.x - bot.x));
  }
  assert.ok(legs.has('10') && legs.has('01'), 'walks both ways');
  for (let i = 20; i < angles.length; i++) assert.ok(Math.abs(wrapAngle(angles[i]! - bearings[i]!)) < 10 * DEG, `tick ${i}: gun ${(angles[i]! / DEG).toFixed(0)}° vs last seen at ${(bearings[i]! / DEG).toFixed(0)}°`);
  for (let i = 1; i < angles.length; i++) assert.ok(Math.abs(wrapAngle(angles[i]! - angles[i - 1]!)) <= HANDS.calm.maxSpin * (TICK_MS / 1000) + 1e-9, `tick ${i}: idle gun turned ${(wrapAngle(angles[i]! - angles[i - 1]!) / DEG).toFixed(1)}°`);
});

test('a bot fires only once its gun has come round onto the enemy, so a flick behind it costs time to the first shot', () => {
  const firstShot = (enemyAt: { x: number; y: number }, seed: number) => {
    const w = emptyWorld();
    const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
    const enemy = spawnAt(w, enemyAt.x, enemyAt.y);
    const r = seeded(seed);
    let mem = newBotMemory(r, { skill: VETERAN });
    for (let i = 0; i < 60; i++) {
      for (const p of [bot, enemy]) if (p.life.k === 'alive') p.life.hp = 100;
      const d = botThink(snapshotFor(w, bot.id), arenaFor(w), mem, r);
      mem = d.mem;
      const bearing = Math.atan2(enemy.y - bot.y, enemy.x - bot.x);
      if (d.input.fire) {
        assert.ok(Math.abs(wrapAngle(d.input.angle - bearing)) < 12 * DEG, `seed ${seed}: fired ${(wrapAngle(d.input.angle - bearing) / DEG).toFixed(0)}° off the enemy`);
        return i * TICK_MS;
      }
      setInput(w, bot.id, i + 1, d.input);
      step(w, TICK_MS);
    }
    return Infinity;
  };
  let ahead = 0, behind = 0;
  for (let seed = 1; seed <= 10; seed++) {
    ahead += firstShot({ x: 1400, y: 1000 }, seed);
    behind += firstShot({ x: 600, y: 1000 }, seed);
  }
  // Caught from behind it turns quickly (`HANDS.startle`) while it takes him in, but no 180-degree snap: the turn still costs it.
  assert.ok(behind / 10 >= ahead / 10 + 100, `first shot ${(ahead / 10).toFixed(0)}ms ahead vs ${(behind / 10).toFixed(0)}ms behind`);
});

test('a bot leads a moving target to where the round and the target meet, by the round\'s real flight', () => {
  for (const gun of ['pistol', 'lmg', 'sniper'] as const) {
    const cruise = GUNS[gun].bulletSpeed, boost = rulesOf(GUNS[gun]).muzzleBoost;
    for (const d of [150, 400, 800]) {
      const target = { x: d, y: 0, vx: 0, vy: 255 };
      const meet = intercept({ x: 0, y: 0 }, target, cruise, boost, MUZZLE_PX);
      const there = { x: target.x + target.vx * meet.sec, y: target.y + target.vy * meet.sec };
      const a = Math.atan2(meet.y, meet.x);
      const flown = MUZZLE_PX + flownAfter(cruise, meet.sec, 0, boost);
      const round = { x: Math.cos(a) * flown, y: Math.sin(a) * flown };
      assert.ok(Math.hypot(round.x - there.x, round.y - there.y) < 2, `${gun} at ${d}px: round ${Math.round(round.x)},${Math.round(round.y)} meets the target at ${Math.round(there.x)},${Math.round(there.y)}`);
    }
  }
  const still = intercept({ x: 0, y: 0 }, { x: 300, y: 0, vx: 0, vy: 0 }, 900, 4, MUZZLE_PX);
  assert.deepEqual([still.x, still.y], [300, 0], 'a still target needs no lead');
});
