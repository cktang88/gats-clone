/// <reference types="node" />
// Full-auto bloom, through the sim itself: a held trigger bites at once and slows as it nears its cap (never past it), it is punished standing
// as well as moving, taps stay tight, a bipod tames a machine gun without taking its bloom away, the page's prediction and a bot's read of its
// own bloom are the sim's, and the Machine Pistol carries a real stage-1 punch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVOLUTIONS, GUN_IDS, GUNS, handlingOfGun, roundsPerSec, rulesOf, SPREAD_EASE, WORLD, type GunId } from '../src/shared/defs.ts';
import { IDLE_INPUT } from '../src/shared/sim/world.ts';
import type { InputState } from '../src/shared/protocol.ts';
import { setInput, step } from '../src/shared/sim.ts';
import { easeDownTicks, easedSpread, easeSpread, spreadFor } from '../src/shared/sim/stats.ts';
import { bloomShare, pullTrigger, sprayCap } from '../src/shared/sim/trigger.ts';
import { NO_FIRING, settle, stepTrigger, type TriggerInput } from '../src/client/fire.ts';
import { fireRhythm, ownBloom } from '../src/server/bot/motor.ts';
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

test('the bloom curve: each round past the free ones adds less than the one before, and the cone lands on its cap without passing it', () => {
  for (const gun of GUN_IDS) {
    const bloom = rulesOf(GUNS[gun]).bloom!;
    const shares = Array.from({ length: Math.ceil(sprayCap(bloom)) + 4 }, (_, k) => bloomShare(bloom, k));
    for (let k = 1; k < shares.length; k++) {
      assert.ok(shares[k]! <= 1 && shares[k]! >= shares[k - 1]!, `${gun}: round ${k} at ${shares[k]} of the cap`);
      if (k > bloom.free + 1) assert.ok(shares[k]! - shares[k - 1]! <= shares[k - 1]! - shares[k - 2]! + 1e-12, `${gun}: round ${k} adds more than round ${k - 1}`);
    }
    assert.equal(shares.at(-1), 1, `${gun}: a long spray reaches the cap`);
    assert.equal(bloomShare(bloom, sprayCap(bloom) + 50), 1, `${gun}: and stays on it`);
  }
  // Through the sim: a held trigger's rounds, standing and walking, each widen the cone by no more than the round before, up to the cap.
  for (const gun of BARE) {
    for (const moving of [false, true]) {
      const s = held(gun, { moving, rounds: 40 });
      const cap = spreadFor(gun, {}, !moving, 1e6);
      const free = rulesOf(GUNS[gun]).bloom!.free;
      for (let i = free + 1; i < s.length; i++) assert.ok(s[i]! - s[i - 1]! <= s[i - 1]! - s[i - 2]! + 1e-9, `${gun}${moving ? ' walking' : ''}: round ${i + 1} adds more than round ${i}`);
      assert.ok(Math.max(...s) <= cap + 1e-9, `${gun}: never past its cap`);
      assert.ok(s[39]! > 0.97 * cap, `${gun}: forty rounds all but reach it`);
    }
  }
});

test('a held trigger bites at once and then slows: round 3 already shows a clear rise for every full-auto gun, and it is wide by round 20', () => {
  // Round 20 against round 1, standing: the class guns are pinned harder than the heavy evolutions (a drum SMG, a bipod gun stood up), which
  // soak more of the kick with their weight. A light, short gun's whole bloom is held to its reach (`HANDLING.capReach`), so an SMG's widens
  // less than a rifle's.
  const atLeast: Partial<Record<GunId, number>> = { assault: 3, lmg: 1.8, lightMg: 1.6, smg: 1.5, hailstorm: 1.75 };
  const classGuns: readonly GunId[] = ['assault', 'smg', 'lmg', 'hailstorm', 'skirmisher', 'ranger'];
  for (const gun of BARE) {
    for (const moving of [false, true]) {
      const s = held(gun, { moving, rounds: 20 });
      const r1 = s[0]!, r3 = s[2]!, r5 = s[4]!, r10 = s[9]!, r20 = s[19]!;
      assert.ok(r3 >= 1.05 * r1, `${gun}: round 3 ${(r3 / r1).toFixed(2)}x round 1`);
      if (classGuns.includes(gun)) assert.ok(r3 >= 1.15 * r1, `${gun}: a light or class gun snaps up, round 3 ${(r3 / r1).toFixed(2)}x round 1`);
      assert.ok((r5 - r1) / 4 > (r20 - r10) / 10, `${gun}: the first rounds climb faster than rounds 10 to 20`);
      if (!moving) assert.ok(r20 >= (atLeast[gun] ?? 1.3) * r1, `${gun}: round 20 is ${(r20 / r1).toFixed(2)}x round 1 standing`);
    }
  }
  assert.ok(held('assault')[4]! > 1.8 * held('assault')[0]!, 'an assault rifle sprayed is nearly twice as wide by round 5: tap it');
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

test('tapping stays tight: single taps never bloom past the first round, and each short tap starts back on it', () => {
  for (const gun of FULL_AUTO) {
    const first = held(gun, { rounds: 1 })[0]!;
    // A round's kick lands on the cone at once and eases back out over `SPREAD_EASE` once the gun cools: four taps a second stay within a
    // sixth of the first round, and a tap every half second is back on it every time.
    const taps = held(gun, { tap: { rounds: 1, gapMs: 250 } });
    assert.ok(Math.max(...taps) <= first * 1.15, `${gun}: taps four a second stay near ${first.toFixed(4)} (widest ${Math.max(...taps).toFixed(4)})`);
    const paced = held(gun, { tap: { rounds: 1, gapMs: 500 } });
    assert.ok(Math.max(...paced) <= first * 1.001, `${gun}: a tap every half second stays at ${first.toFixed(4)} (widest ${Math.max(...paced).toFixed(4)})`);
    const tap = rulesOf(GUNS[gun]).bloom!.tap;
    const bursts = held(gun, { tap: { rounds: tap, gapMs: 500 }, rounds: 4 * tap });
    for (let i = 0; i < bursts.length; i += tap) assert.ok(bursts[i]! <= first * 1.001, `${gun}: tap ${i / tap + 1} of ${tap} starts at ${bursts[i]!.toFixed(4)}, not ${first.toFixed(4)}`);
    // A rev-up gun's fresh spray fires its first rounds slower than the bloom's settle and cools a hair between them, so its later taps (the
    // gun still part spun) may land a whisker past it.
    const slack = rulesOf(GUNS[gun]).spinUp ? 1.01 : 1.001;
    assert.ok(Math.max(...bursts) <= held(gun, { rounds: tap })[tap - 1]! * slack, `${gun}: and no tap blooms past a fresh one`);
  }
  // A burst flies on its first round's cone, and the burst guns recover between bursts: a held Battle Rifle or Carbine never blooms.
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

test('the page predicts the sim\'s spread, and a bot reckons the sim\'s bloom, through one implementation of the curve', () => {
  for (const gun of ['assault', 'smg', 'skirmisher', 'lmg', 'heavyLmg', 'minigun', 'battleRifle', 'sniper', 'semiAuto'] as const) {
    for (const moving of [false, true]) {
      const w = emptyWorld();
      const p = spawnAt(w, 1500, 3000, { loadout: { weapon: GUNS[gun].base, armor: 'none' }, kind: 'human' });
      equip(p, gun);
      if (p.life.k === 'alive') p.life.ammo = 1e6;
      const ready = { gun, mag: 1e6, reloadMs: GUNS[gun].reloadMs, ammo: 1e6, reloading: false, reloadFrac: 0, alive: true, armed: true };
      let t = settle(NO_FIRING, ready, 0, 0, []).firing.trigger;
      const rhythm = fireRhythm(gun, false, 1);
      let tap: Parameters<typeof ownBloom>[2] = { since: null, pauseUntil: -Infinity, spray: 0, firedTick: -Infinity, ammo: 1e6 };
      // Held, let go, tapped, held again: every tick the page's eased spread is the sim's, and a tapping bot's reckoned bloom (it sees a round
      // leave a snapshot late) is within one tick's cooling of it.
      const pattern = 'P' + 'h'.repeat(45) + '.'.repeat(8) + 'P...P...P....' + 'P' + 'h'.repeat(30) + '.'.repeat(40);
      let shots = 0, fire = false;
      [...pattern].forEach((c, i) => {
        if (c === 'P') { shots++; fire = true; } else if (c === '.') fire = false;
        const input: TriggerInput = { fire, shots, reload: false, right: moving };
        setInput(w, p.id, i + 1, { ...IDLE_INPUT, ...input, angle: 0 });
        step(w, TICK_MS);
        t = stepTrigger(t, input, w.now).t;
        if (p.life.k !== 'alive') return;
        assert.ok(Math.abs(easedSpread(t.spreadHist) - easedSpread(p.life.spreadHist)) < 1e-12, `${gun}${moving ? ' walking' : ''}: the page's spread after input ${i + 1}`);
        if (!rhythm) return;
        const own = ownBloom(rhythm, gun, tap, p.life.ammo, i + 1);
        tap = { since: null, pauseUntil: -Infinity, spray: own.spray, firedTick: own.firedTick, ammo: p.life.ammo };
        const tick = (sprayCap(rulesOf(GUNS[gun]).bloom!) * TICK_MS) / rulesOf(GUNS[gun]).bloom!.recoverMs;
        assert.ok(Math.abs(own.spray - p.life.spray) <= tick + 1e-9, `${gun}: the bot reckons ${own.spray.toFixed(3)}, the sim has ${p.life.spray.toFixed(3)} after input ${i + 1}`);
      });
    }
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

/**
 * The expected hits a second over the first two seconds of fire on a standing body `d` px away, the shooter standing and aiming dead on: each
 * round's odds are the body's half-width over the cone it flew with (rounds spread evenly across the cone), through the sim's own trigger,
 * spread and easing. `burst` fires that many rounds and lets go for `pauseMs` between them; without it the trigger is held.
 */
function hitsPerSec(gun: GunId, d: number, burst?: { rounds: number; pauseMs: number }): number {
  const g = GUNS[gun], half = Math.atan(WORLD.playerRadius / d);
  const s = { ammo: g.mag, reloadUntil: null as number | null, nextFireAt: 0, burstLeft: 0, pressUntil: -Infinity, spray: 0, firedAt: -Infinity, spin: 0 };
  let hist: number[] = [], spreadShot = 0, inBurst = 0, restUntil = -Infinity, was = false, hits = 0;
  for (let now = 0; now < 2000; now += TICK_MS) {
    const fire = now >= restUntil, pressed = fire && !was;
    was = fire;
    const fired = pullTrigger(s, { def: g, mag: g.mag, reloadMs: g.reloadMs, armed: true }, { fire, reload: false, pressed }, now, TICK_MS);
    const shot = fired ? s.spray : s.spray + 1, at = (k: number) => spreadFor(gun, {}, true, k);
    hist = easeSpread(hist, at(shot), shot > spreadShot && hist.length > 0 ? at(shot) - at(spreadShot) : 0, at(0), easeDownTicks(gun));
    spreadShot = shot;
    if (!fired) continue;
    hits += Math.min(1, half / easedSpread(hist));
    if (burst && ++inBurst >= burst.rounds) { inBurst = 0; restUntil = now + TICK_MS + burst.pauseMs; }
  }
  return hits / 2;
}

test('bursting beats spraying at range, spraying wins up close, and the bloom comes down fast on a small gun and slower on a big one', () => {
  // At 450 px four rounds and a 150 ms let-go land more a second than a held trigger: the bloom is back down by the next burst.
  for (const gun of ['assault', 'lmg'] as const) {
    for (const d of [450, 750]) {
      const held = hitsPerSec(gun, d), burst = hitsPerSec(gun, d, { rounds: 4, pauseMs: 150 });
      assert.ok(burst > held, `${gun} at ${d} px: bursts land ${burst.toFixed(2)} a second, a held trigger ${held.toFixed(2)}`);
    }
  }
  assert.ok(hitsPerSec('assault', 450, { rounds: 4, pauseMs: 150 }) > 1.2 * hitsPerSec('assault', 450), 'an assault rifle bursts clearly better');
  // An SMG is not made to burst at 450 px (past its falloff, its rest cone twice a body): its bloom is small and gone so soon that a held
  // trigger loses little there, and its quick bursts land within a tenth of it.
  const smgHeld = hitsPerSec('smg', 450), smgBurst = hitsPerSec('smg', 450, { rounds: 4, pauseMs: 100 });
  assert.ok(Math.abs(smgBurst / smgHeld - 1) < 0.1, `SMG at 450 px: quick bursts ${smgBurst.toFixed(2)}, held ${smgHeld.toFixed(2)}`);
  // Up close the cone swallows the bloom and the held trigger's rate wins.
  for (const gun of ['assault', 'smg', 'lmg'] as const) {
    assert.ok(hitsPerSec(gun, 150) > hitsPerSec(gun, 150, { rounds: 4, pauseMs: 150 }), `${gun}: spraying wins at 150 px`);
  }
  // A full spray's heat clears in half the time on an SMG it takes on an LMG (from its build: a light, short gun is brought back fastest).
  const recover = (id: GunId) => rulesOf(GUNS[id]).bloom!.recoverMs;
  assert.ok(recover('smg') < 0.5 * recover('lmg') && recover('skirmisher') < 0.5 * recover('minigun'), `SMG ${recover('smg')} ms, LMG ${recover('lmg')} ms`);
  // The scoped guns keep their slow per-shot settle: a sniper's bloom takes its seconds to come back down whatever the hip guns are tuned to.
  const scoped: Partial<Record<GunId, number>> = { sniper: 2984, longshot: 3884, piercer: 3834, artillery: 3834, semiAuto: 1593, ghost: 1594, repeater: 1257 };
  for (const [id, ms] of Object.entries(scoped)) assert.equal(handlingOfGun(GUNS[id as GunId]).recoverMs, ms, `${id} recovers as it did`);
});

/** How long (ms) after a held trigger at its cap is let go the reticle (the eased spread) is back within 10% of its rest, standing. */
function capToRestMs(gun: GunId): number {
  const w = emptyWorld();
  const p = spawnAt(w, 1500, 3000, { loadout: { weapon: GUNS[gun].base, armor: 'none' }, kind: 'human' });
  equip(p, gun);
  const eased = () => (p.life.k === 'alive' ? easedSpread(p.life.spreadHist) : NaN);
  press(w, p, { angle: 0 });
  run(w, 2000);
  const rest = eased();
  press(w, p, { angle: 0, fire: true, shots: p.input.shots + 1 });
  for (let t = 0; t < 3000; t += TICK_MS) { if (p.life.k === 'alive') p.life.ammo = 1e6; step(w, TICK_MS); }
  assert.ok(eased() > rest * 1.2, `${gun}: a long spray has bloomed`);
  press(w, p, { angle: 0, fire: false });
  for (let t = TICK_MS; t < 3000; t += TICK_MS) { step(w, TICK_MS); if (eased() <= rest * 1.1) return t; }
  return Infinity;
}

test('what you see recovers at the gun\'s pace: an SMG\'s reticle is back on its rest in under half an LMG\'s time, and only a big gun takes the whole ease', () => {
  const ms = Object.fromEntries((['smg', 'skirmisher', 'assault', 'lmg', 'minigun'] as const).map((id) => [id, capToRestMs(id)]));
  const shown = JSON.stringify(ms);
  assert.ok(ms.smg! <= 0.5 * ms.lmg!, `SMG against LMG: ${shown}`);
  assert.ok(ms.skirmisher! <= 0.5 * ms.minigun!, `Skirmisher against Minigun: ${shown}`);
  assert.ok(ms.smg! < ms.assault! && ms.assault! < ms.lmg!, `smallest to biggest: ${shown}`);
  // Never a snap: the cone holds through the bloom's settle and then comes down over ticks, not at once (see sprint.test.ts for the ease itself).
  for (const [id, t] of Object.entries(ms)) assert.ok(t >= rulesOf(GUNS[id as GunId]).bloom!.settleMs + SPREAD_EASE.downMinMs / 2, `${id}: ${t} ms`);
});
