/// <reference types="node" />
// Full-auto bloom, through the sim itself: a held trigger is punished standing as well as moving, taps and short bursts stay tight, a bipod
// tames a machine gun without taking its bloom away, and the Machine Pistol carries a real stage-1 punch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVOLUTIONS, GUN_IDS, GUNS, roundsPerSec, rulesOf, WORLD, type GunId } from '../src/shared/defs.ts';
import type { InputState } from '../src/shared/protocol.ts';
import { step } from '../src/shared/sim.ts';
import { easedSpread, spreadFor } from '../src/shared/sim/stats.ts';
import { emptyWorld, equip, press, run, spawnAt, TICK_MS } from './helpers.ts';

/** Every full-auto gun of the classes that have them (bursts and pellet guns aside): what a held trigger is about. */
const FULL_AUTO = GUN_IDS.filter((id) => GUNS[id].auto && !GUNS[id].burst && GUNS[id].pellets === 1);
/** Those that stand bare (a bipod gun stood still sets down: see the bipod test). */
const BARE = FULL_AUTO.filter((id) => !rulesOf(GUNS[id]).deploy);

/**
 * The spread each of the first `rounds` rounds of a held trigger flew with (the eased spread the sim gave the shot), a person standing
 * planted (and, with a bipod, set down) or walking. `rest` is how long to stand first; `tap` fires one press of `tap` rounds at a time with
 * `gapMs` of rest between them instead of holding.
 */
function held(gun: GunId, opts: { moving?: boolean; rounds?: number; rest?: number; tap?: { rounds: number; gapMs: number } } = {}): number[] {
  const w = emptyWorld();
  const p = spawnAt(w, 1500, 3000, { loadout: { weapon: GUNS[gun].base, armor: 'none' }, kind: 'human' });
  equip(p, gun);
  if (p.life.k === 'alive') p.life.ammo = 1e6;
  // Walking already when the first round goes, so round 1 has the walking cone too (the spread eases in over `SPREAD_EASE`).
  press(w, p, { angle: 0, right: opts.moving ?? false });
  run(w, opts.rest ?? 1000);
  const out: number[] = [];
  const want = opts.rounds ?? 20;
  let inTap = 0, restUntil = -Infinity;
  for (let t = 0; out.length < want && t < 30_000; t += TICK_MS) {
    const firing = !opts.tap || w.now >= restUntil;
    const input: Partial<InputState> = { angle: 0, fire: firing, shots: p.input.shots + (firing ? 1 : 0), right: opts.moving ?? false };
    press(w, p, input);
    const before = p.life.k === 'alive' ? p.life.ammo : 0;
    step(w, TICK_MS);
    if (p.life.k === 'alive' && p.life.ammo < before) {
      out.push(easedSpread(p.life.spreadHist));
      if (opts.tap && ++inTap >= opts.tap.rounds) { inTap = 0; restUntil = w.now + opts.tap.gapMs; }
    }
  }
  return out;
}

test('a held trigger blooms hard standing still, for every full-auto gun: noticeably by round 8, wide by round 20', () => {
  // Round 20 against round 1, standing: the class guns are pinned harder than the heavy evolutions (a drum SMG, a bipod gun stood up), which
  // soak more of the kick with their weight.
  const atLeast: Partial<Record<GunId, number>> = { assault: 3, lmg: 1.8, lightMg: 1.6, smg: 1.6, hailstorm: 2 };
  for (const gun of BARE) {
    const s = held(gun);
    const r1 = s[0]!, r8 = s[7]!, r20 = s[19]!;
    assert.ok(r8 >= 1.08 * r1, `${gun}: round 8 ${r8.toFixed(4)} vs round 1 ${r1.toFixed(4)}`);
    assert.ok(r20 >= (atLeast[gun] ?? 1.3) * r1, `${gun}: round 20 is ${(r20 / r1).toFixed(2)}x round 1 standing`);
    assert.ok(r8 > 1.5 * r1 || gun !== 'assault', 'an assault rifle sprayed is half as wide again by round 8: tap it');
  }
  // A bipod gun stood still but not yet set down blooms like any other.
  for (const gun of FULL_AUTO.filter((id) => rulesOf(GUNS[id]).deploy)) assert.ok(spreadFor(gun, {}, true, 20) >= 1.3 * spreadFor(gun, {}, true, 1), gun);
});

test('standing still helps only a little: a held trigger grows nearly as many times its first round standing as it does walking', () => {
  for (const gun of BARE) {
    const still = held(gun), moving = held(gun, { moving: true });
    const grows = (s: number[]) => s[19]! / s[0]!;
    assert.ok(grows(still) >= 0.75 * grows(moving), `${gun}: standing ${grows(still).toFixed(2)}x, walking ${grows(moving).toFixed(2)}x`);
    assert.ok(still[19]! < moving[19]!, `${gun}: but the standing cone stays the tighter`);
  }
});

test('tapping stays tight: single taps and short bursts of the free rounds never bloom past the first round', () => {
  for (const gun of FULL_AUTO) {
    const first = held(gun, { rounds: 1 })[0]!;
    const taps = held(gun, { tap: { rounds: 1, gapMs: 250 } });
    assert.ok(Math.max(...taps) <= first * 1.001, `${gun}: taps four a second stay at ${first.toFixed(4)} (widest ${Math.max(...taps).toFixed(4)})`);
    const free = rulesOf(GUNS[gun]).bloom!.free;
    const bursts = held(gun, { tap: { rounds: free, gapMs: 450 } });
    assert.ok(Math.max(...bursts) <= first * 1.001, `${gun}: bursts of ${free} stay at ${first.toFixed(4)} (widest ${Math.max(...bursts).toFixed(4)})`);
  }
  // The burst guns recover between bursts: a held Battle Rifle or Carbine never blooms.
  for (const gun of ['battleRifle', 'carbine', 'machinePistol'] as const) {
    const s = held(gun, { rounds: 18 });
    assert.ok(Math.max(...s) <= s[0]! * 1.001, `${gun}: held bursts stay tight`);
  }
});

test('a set-down bipod tames a machine gun but does not stop its bloom', () => {
  for (const gun of GUN_IDS.filter((id) => rulesOf(GUNS[id]).deploy)) {
    const deploy = rulesOf(GUNS[gun]).deploy!;
    const down = held(gun, { rest: deploy.ms + 600, rounds: 30 });
    const grows = down[29]! / down[0]!;
    assert.ok(grows >= 1.25, `${gun}: set down, round 30 still blooms to ${grows.toFixed(2)}x round 1`);
    // Against the same gun standing with the bipod up (the sim's spread for a planted, unbraced round 1 and round 30).
    const bare = (round: number) => spreadFor(gun, {}, true, round, 0, 0, false);
    assert.ok(grows < bare(30) / bare(1), `${gun}: set down it blooms ${grows.toFixed(2)}x, less than the ${(bare(30) / bare(1)).toFixed(2)}x standing without it`);
    assert.ok(down[29]! < 0.6 * bare(30), `${gun}: and its widest set-down cone is well inside the bare standing one`);
  }
});

test('the Machine Pistol sits in its class band: more damage a magazine and a second than the pistol, no more than its own evolutions', () => {
  const dps = (id: GunId) => GUNS[id].damage * GUNS[id].pellets * roundsPerSec(GUNS[id]);
  const perMag = (id: GunId) => GUNS[id].damage * GUNS[id].pellets * GUNS[id].mag;
  const kids = EVOLUTIONS.machinePistol;
  assert.ok(dps('machinePistol') >= 1.25 * dps('pistol') && dps('machinePistol') <= Math.max(...kids.map(dps)), `DPS ${dps('machinePistol').toFixed(0)}`);
  assert.ok(perMag('machinePistol') >= 2 * perMag('pistol') && perMag('machinePistol') <= Math.max(...kids.map(perMag)), `damage a magazine ${perMag('machinePistol')}`);
  assert.ok(dps('machinePistol') >= 0.9 * dps('handCannon'), 'it trades with its sibling, the Hand Cannon');
  const hits = (id: GunId) => Math.ceil(WORLD.baseHp / GUNS[id].damage - 1e-9);
  assert.ok(hits('machinePistol') <= hits('pistol') && hits('machinePistol') <= GUNS.machinePistol.burst!.count + 1, 'a burst and a round drop the unarmored');
});
