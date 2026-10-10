/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTROLS, assembleInput, actionForKey } from '../src/client/input.ts';
import { stepTrigger, NO_FIRING, settle, settleOf, spreadOf, type ServerGun } from '../src/client/fire.ts';
import { NO_STICKS, dragStick, pressStick, touchMoves } from '../src/client/touch.ts';
import { ARMORS, GUN_IDS, GUNS, LOAD_SPEED_FLOOR, minSpreadOf, rulesOf, settleRulesOf, SPREAD_EASE, SPRINT, WORLD, type GunId } from '../src/shared/defs.ts';
import { parseClientMsg } from '../src/shared/protocol.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { easeDownTicks, easedSpread, easeSpread, effectiveStats, postSprintSpread, SPREAD_EASE_TICKS, spreadEaseDownMs, spreadFor } from '../src/shared/sim/stats.ts';
import { loadOf, sprintShareOf } from '../src/shared/handling.ts';
import type { Player } from '../src/shared/sim/world.ts';
import { botThink, newBotMemory } from '../src/server/bots.ts';
import { arenaFor } from '../src/server/bot/arena.ts';
import { emptyWorld, equip, grantPerks, press, run, spawnAt, TICK_MS } from './helpers.ts';

/** Distance a player covers in `ms` holding right, sprinting or not. */
function travelled(sprint: boolean, ms: number, loadout: Parameters<typeof spawnAt>[3] = {}, perks: Parameters<typeof grantPerks>[2] = []) {
  const w = emptyWorld();
  const p = spawnAt(w, 500, 500, loadout);
  if (perks.length) grantPerks(w, p, perks);
  press(w, p, { right: true, sprint });
  run(w, ms);
  return p.x - 500;
}

/** How much faster than a walk a pistol with no armor sprints: the bonus, by the share its light load keeps (see handling.ts). */
const PISTOL_SPRINT = 1 + (SPRINT.speedMul - 1) * sprintShareOf(loadOf(GUNS.pistol.kg, GUNS.pistol.cm, 0));

test('sprinting moves the bonus its load allows faster than walking, and only while moving', () => {
  const walk = travelled(false, 1000), sprint = travelled(true, 1000);
  assert.ok(Math.abs(sprint / walk - PISTOL_SPRINT) < 0.03, `sprint ${sprint.toFixed(1)} vs walk ${walk.toFixed(1)}`);
  const w = emptyWorld();
  const p = spawnAt(w, 500, 500);
  press(w, p, { sprint: true });
  run(w, 500);
  assert.equal(p.x, 500, 'holding sprint standing still goes nowhere');
  assert.equal(snapshotFor(w, p.id).self.sprint, false, 'and is not a sprint');
});

test('sprint multiplies the loadout speed after the 58% floor by the share its load allows, and Lightweight stacks with it', () => {
  const heavy = { weapon: 'lmg', armor: 'heavy' } as const;
  const base = WORLD.baseSpeed * LOAD_SPEED_FLOOR;
  const lmgSprint = 1 + (SPRINT.speedMul - 1) * sprintShareOf(loadOf(GUNS.lmg.kg, GUNS.lmg.cm, ARMORS.heavy.kg));
  assert.ok(Math.abs(travelled(true, 1000, { loadout: heavy }) - base * lmgSprint) < 4, 'the heaviest loadout still sprints above its floor speed, if barely');
  assert.ok(lmgSprint < 1.2, 'an LMG in heavy armor barely sprints');
  const light = travelled(true, 1000, {}, ['lightweight']), share = sprintShareOf(loadOf(GUNS.pistol.kg, GUNS.pistol.cm, 0));
  assert.ok(share > 1, 'a pistol with no armor sprints harder than the plain bonus');
  assert.ok(Math.abs(light - WORLD.baseSpeed * GUNS.pistol.moveMul * 1.25 * (1 + (SPRINT.speedMul - 1) * share)) < 4, `Lightweight sprint ${light.toFixed(1)}`);
});

test('a sprinting player cannot fire; a click ends the sprint and fires at once', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500, { loadout: { weapon: 'assault' } });
  spawnAt(w, 1500, 900);
  press(w, a, { right: true, sprint: true });
  run(w, 400);
  assert.equal(snapshotFor(w, a.id).self.sprint, true);
  const shots = () => w.events.filter((e) => e.e === 'shot' && e.owner === a.id).length;
  press(w, a, { right: true, sprint: true, fire: true, shots: a.input.shots + 1 });
  run(w, TICK_MS);
  assert.equal(shots(), 1, 'the click\'s own tick fires: no wait for the gun to come up');
  assert.equal(snapshotFor(w, a.id).self.sprint, false, 'the click ended the sprint even with the key still held');
});

test('sprinting never fires, however long the trigger is held without a click ending it', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500, { loadout: { weapon: 'lmg' } });
  press(w, a, { right: true, sprint: true });
  run(w, 600);
  assert.equal(w.events.filter((e) => e.e === 'shot').length, 0);
  assert.equal(snapshotFor(w, a.id).self.ammo, snapshotFor(w, a.id).self.mag);
});

test('reloading while sprinting is allowed', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500);
  if (a.life.k === 'alive') a.life.ammo = 1;
  press(w, a, { right: true, sprint: true, reload: true });
  run(w, TICK_MS * 3);
  const self = snapshotFor(w, a.id).self;
  assert.equal(self.reloading, true);
  assert.equal(self.sprint, true, 'the sprint carried on through the reload');
});

/** The spread player `p`'s next shot gets right now (the eased spread, see `easeSpread`). */
const easedOf = (p: Player): number => (p.life.k === 'alive' ? easedSpread(p.life.spreadHist) : 0);
/** Its target this tick, still or on the move, with `settle` of the post-sprint bloom left. */
const moving = (gun: GunId) => GUNS[gun].spread + rulesOf(GUNS[gun]).movingSpreadAdd;

test('leaving sprint throws the post-sprint bloom: ~4x the gun\'s moving spread, easing out over its settle to whatever the stance gives', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500, { loadout: { weapon: 'assault' } });
  const { ms: settleMs } = settleRulesOf(GUNS.assault);
  press(w, a, { right: true, sprint: true });
  run(w, 600);
  assert.equal(snapshotFor(w, a.id).self.settle, 1, 'full while sprinting');
  press(w, a, {});
  run(w, TICK_MS);
  const early = snapshotFor(w, a.id).self;
  assert.equal(early.settleMs, settleMs);
  assert.ok(early.settle! > 0.97, `it starts in full the moment the sprint ends (${early.settle})`);
  const peak = easedOf(a);
  assert.ok(Math.abs(peak / (SPRINT.settleMul * moving('assault')) - 1) < 0.02, `the eased spread is already at the peak (sprinting built it): ${peak}`);
  run(w, settleMs / 2);
  const mid = snapshotFor(w, a.id).self.settle!;
  assert.ok(Math.abs(mid - 0.5) < 0.04, `half the settle time, half the settle (${mid})`);
  run(w, settleMs / 2 + TICK_MS);
  assert.equal(snapshotFor(w, a.id).self.settle, 0, 'gone once the settle has run');
  run(w, SPREAD_EASE.ms + 100);
  assert.ok(Math.abs(easedOf(a) - spreadFor('assault', {}, true)) < 1e-9, 'and the spread is back to the standing spread');
  // The curve: quadratic ease-out from the peak to the stance's own.
  assert.equal(postSprintSpread(0.02, 0.05, 1, 4), 0.2);
  assert.equal(postSprintSpread(0.02, 0.05, 0, 4), 0.02);
  assert.ok(Math.abs(postSprintSpread(0.02, 0.05, 0.5, 4) - (0.02 + 0.18 * 0.25)) < 1e-12, 'most of the bloom is gone half-way');
  assert.equal(postSprintSpread(0.3, 0.05, 1, 4), 0.3, 'never tighter than the stance');
  for (const still of [true, false]) {
    assert.ok(Math.abs(spreadFor('assault', {}, still, 0, 0, 1) - SPRINT.settleMul * moving('assault')) < 1e-9, `${still ? 'standing' : 'walking'}: the peak is 4x the moving spread`);
    assert.equal(spreadFor('assault', {}, still, 0, 0, 0), spreadFor('assault', {}, still), 'and it settles to the stance\'s');
  }
});

test('every class blooms to ~4x off a sprint, wider than walking; the pistol and SMG settle far faster than the long guns', () => {
  for (const gun of ['pistol', 'smg', 'shotgun', 'assault', 'sniper', 'lmg'] as const) {
    const peak = spreadFor(gun, {}, false, 0, 0, 1), walk = spreadFor(gun, {}, false);
    assert.ok(peak / moving(gun) >= 3.9 && peak / moving(gun) <= 4.1, `${gun} peaks at x${(peak / moving(gun)).toFixed(2)} of its moving spread`);
    assert.ok(peak > walk * 2, `${gun}: far wider than walking`);
  }
  const ms = (gun: GunId) => settleRulesOf(GUNS[gun]).ms;
  assert.ok(ms('pistol') <= 550 && ms('smg') <= 650, `the sidearm and the rusher settle in about half a second (${ms('pistol')}, ${ms('smg')})`);
  assert.ok(ms('gunslinger') <= 400 && ms('skirmisher') <= 400, 'their quickest variants faster still');
  assert.ok(ms('shotgun') >= 1100 && ms('shotgun') <= 1400, `the shotgun's one exception: quicker off a sprint than its build gives (${ms('shotgun')})`);
  assert.ok(ms('shotgun') > ms('smg') && ms('shotgun') < ms('assault'), 'between the rusher and the anchor');
  assert.ok(ms('assault') >= 1900 && ms('assault') <= 2100, 'the anchor takes ~2 s');
  assert.ok(ms('sniper') >= 2200 && ms('lmg') >= 2200 && ms('sniper') <= 2500 && ms('lmg') <= 2500, 'the long guns longest');
  assert.ok(ms('smg') * 3 <= ms('assault'), 'quick off a sprint is the SMG\'s edge');
});

for (const gun of ['pistol', 'smg', 'shotgun', 'assault', 'sniper', 'lmg'] as const) {
  test(`${gun}: a click ends a sprint and the round leaves at once, wide with the post-sprint bloom`, () => {
    const w = emptyWorld();
    const a = spawnAt(w, 500, 500, { loadout: { weapon: gun } });
    press(w, a, { right: true, sprint: true });
    run(w, 400);
    const shots = () => w.events.filter((e) => e.e === 'shot' && e.owner === a.id).length;
    press(w, a, { right: true, sprint: true, fire: true, shots: a.input.shots + 1 });
    run(w, TICK_MS);
    assert.equal(shots(), 1, 'fired on the click\'s tick');
    assert.ok(easedOf(a) >= 3.9 * moving(gun), `at the full post-sprint bloom (${easedOf(a).toFixed(3)})`);
  });
}

test('the bloom also breaks a planted sniper\'s pinpoint, and suppression still stacks on top', () => {
  assert.equal(spreadFor('sniper', {}, true), minSpreadOf(GUNS.sniper));
  assert.ok(spreadFor('sniper', {}, true, 0, 0, 1) > GUNS.sniper.spread, 'a just-sprinted sniper rifle is not pinpoint');
  const base = spreadFor('assault', {}, true, 0, 0, 0.6);
  assert.ok(spreadFor('assault', {}, true, 0, 1, 0.6) > base, 'suppression stacks on the bloom');
  assert.ok(spreadFor('sniper', {}, true, 2, 0, 0.5) > spreadFor('sniper', {}, true, 0, 0, 0.5), 'a bolt\'s kick composes with it');
});

/** Steps `p` tick by tick on `input` for `ms`, the eased spread after each tick. */
function trace(w: ReturnType<typeof emptyWorld>, p: Player, ms: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < ms - 1e-6; t += TICK_MS) { run(w, TICK_MS); out.push(easedOf(p)); }
  return out;
}
/** How long (ms) a trace takes to come within 1% of the way from `from` to `to` (Infinity if it never does). */
const arrival = (xs: number[], from: number, to: number) => {
  const i = xs.findIndex((x) => Math.abs(x - to) <= Math.abs(to - from) * 0.01);
  return i < 0 ? Infinity : (i + 1) * TICK_MS;
};

test('spread never jumps: a stance change, a sprint, suppression or a gun swap each ease in over at least SPREAD_EASE.ms, and settle after', () => {
  const ease = SPREAD_EASE.ms;
  // `delayMs`: how long the target itself waits to change (an assault rifle's `steadyMs` before its still spread takes hold).
  const check = (what: string, xs: number[], from: number, to: number, delayMs = 0) => {
    const at = arrival(xs, from, to);
    assert.ok(at >= ease + delayMs, `${what}: done after ${at.toFixed(0)} ms, under ${ease}`);
    assert.ok(at <= ease + delayMs + 3 * TICK_MS, `${what}: still not settled ${at.toFixed(0)} ms in`);
    for (let i = 1; i < xs.length; i++) assert.ok((xs[i] - xs[i - 1]) * Math.sign(to - from) >= -1e-12, `${what}: monotone`);
  };
  // Walking to standing (an assault rifle tightens a lot when planted).
  let w = emptyWorld();
  let a = spawnAt(w, 500, 500, { loadout: { weapon: 'assault' } });
  press(w, a, { right: true });
  run(w, 600);
  const walk = easedOf(a), stand = spreadFor('assault', {}, true);
  assert.ok(Math.abs(walk - spreadFor('assault', {}, false)) < 1e-9);
  press(w, a, {});
  check('walk to stand', trace(w, a, 600), walk, stand, rulesOf(GUNS.assault).steadyMs - TICK_MS);
  // Standing to walking.
  press(w, a, { right: true });
  check('stand to walk', trace(w, a, 600), stand, walk);
  // Into a sprint: the reticle opens to the bloom it will have when the sprint ends, eased.
  press(w, a, { right: true, sprint: true });
  check('into a sprint', trace(w, a, 600), walk, SPRINT.settleMul * moving('assault'));
  // A gun swap.
  w = emptyWorld();
  a = spawnAt(w, 500, 500, { loadout: { weapon: 'assault' } });
  run(w, 600);
  equip(a, 'smg');
  check('gun swap', trace(w, a, 600), spreadFor('assault', {}, true), spreadFor('smg', {}, true));
  // Suppression arriving all at once.
  w = emptyWorld();
  a = spawnAt(w, 500, 500, { loadout: { weapon: 'assault' } });
  run(w, 600);
  const calm = easedOf(a);
  if (a.life.k === 'alive') { a.life.suppression = 1; a.life.suppressedAt = Infinity; }
  check('suppression', trace(w, a, 600), calm, spreadFor('assault', {}, true, 1, 1));
});

test('a shot\'s bloom kick lands at once and eases back out at the gun\'s own pace: never at once, a sniper\'s over the whole SPREAD_EASE.ms', () => {
  /** A gun planted, one shot (a sniper) or a short spray (`rounds`), then a reload drops the bloom to nothing at once: the eased spread's drop. */
  const drop = (gun: GunId, rounds: number) => {
    const w = emptyWorld();
    const a = spawnAt(w, 500, 500, { loadout: { weapon: GUNS[gun].base } });
    equip(a, gun);
    spawnAt(w, 1500, 900);
    run(w, 1000);
    const rest = easedOf(a);
    press(w, a, { fire: true, shots: a.input.shots + 1 });
    run(w, TICK_MS * rounds);
    press(w, a, { fire: false });
    run(w, TICK_MS);
    const kicked = easedOf(a), target = spreadFor(gun, {}, true, a.life.k === 'alive' ? a.life.spray + 1 : 0);
    if (a.life.k === 'alive') a.life.ammo = 0;
    const xs = trace(w, a, 600);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i]! <= xs[i - 1]! + 1e-12, `${gun}: the drop is monotone`);
    assert.ok(Math.abs(xs.at(-1)! - rest) < 1e-9, `${gun}: and lands on the rested spread`);
    return { rest, kicked, target, at: arrival(xs, kicked, rest), first: kicked - xs[0]! };
  };
  const sniper = drop('sniper', 1);
  assert.equal(sniper.rest, minSpreadOf(GUNS.sniper), 'planted: pinpoint');
  assert.ok(sniper.kicked > sniper.rest * 5 && Math.abs(sniper.kicked - sniper.target) < sniper.target * 0.05, `the kick is on the reticle the tick after the shot (${sniper.kicked} vs ${sniper.target})`);
  // The sniper's own recovery is slow anyway: its cone comes down over the whole ease.
  assert.ok(sniper.at >= SPREAD_EASE.ms, `the sniper's drop takes at least ${SPREAD_EASE.ms} ms (${sniper.at})`);
  // An SMG's comes down in about its own recovery time: well under the full ease, but over several ticks, never in one.
  const smg = drop('smg', 8);
  assert.ok(smg.kicked > smg.rest * 1.2, `the SMG has bloomed (${smg.kicked} vs ${smg.rest})`);
  assert.ok(smg.at >= SPREAD_EASE.downMinMs && smg.at >= spreadEaseDownMs('smg') && smg.at < SPREAD_EASE.ms, `the SMG's drop takes ${smg.at.toFixed(0)} ms`);
  assert.ok(smg.first <= (smg.kicked - smg.rest) / 2, `and its first tick takes off no more than half of it (${smg.first} of ${smg.kicked - smg.rest})`);
});

test('the eased spread: falling bloom ramps out over the gun\'s own ticks, never at once; a rise, or any change of the base spread, over the whole SPREAD_EASE.ms', () => {
  /** Ticks (from 1) until a trace is within 1% of the way from `from` to `to`. */
  const ticks = (xs: number[], from: number, to: number) => xs.findIndex((x) => Math.abs(x - to) <= Math.abs(to - from) * 0.01) + 1;
  /** Settled on `start` (a base and a bloom), then held on `end`'s: the eased spread each tick. */
  const eased = (down: number, start: readonly [number, number], end: readonly [number, number]) => {
    let h = easeSpread([], start[0] + start[1], 0, start[0], down);
    const xs: number[] = [];
    for (let i = 0; i < 2 * SPREAD_EASE_TICKS; i++) { h = easeSpread(h, end[0] + end[1], 0, end[0], down); xs.push(easedSpread(h)); }
    return xs;
  };
  const base = 0.05, bloom = 0.1, full = SPREAD_EASE_TICKS * TICK_MS;
  assert.ok(full >= SPREAD_EASE.ms);
  const seen = new Set<number>();
  for (const gun of GUN_IDS) {
    const k = easeDownTicks(gun);
    seen.add(k);
    assert.ok(k >= 2 && k <= SPREAD_EASE_TICKS && (k - 1) * TICK_MS >= spreadEaseDownMs(gun) - 1e-9, `${gun}: ${k} ticks for ${spreadEaseDownMs(gun)} ms`);
    // Bloom falling: over k ticks, never more than a 1/(k-1) of it in one, and monotone.
    const fall = eased(k, [base, bloom], [base, 0]);
    assert.ok(ticks(fall, base + bloom, base) * TICK_MS >= Math.max(SPREAD_EASE.downMinMs, spreadEaseDownMs(gun)), `${gun}: bloom falls in ${ticks(fall, base + bloom, base)} ticks`);
    [base + bloom, ...fall].forEach((x, i, xs) => { if (i > 0) assert.ok(xs[i - 1]! - x >= -1e-12 && xs[i - 1]! - x <= bloom / (k - 1) + 1e-12, `${gun}: tick ${i} of the fall drops ${xs[i - 1]! - x}`); });
    // Bloom rising without a kick (a bloomed gun walked off), the base rising (a sprint, suppression) or falling (planting your feet): the whole ease.
    for (const [what, from, to] of [['bloom rising', [base, 0], [base, bloom]], ['base rising', [base, bloom], [base * 3, bloom]], ['base falling', [base * 3, bloom], [base, bloom]]] as const) {
      const xs = eased(k, from, to);
      assert.ok(ticks(xs, from[0] + from[1], to[0] + to[1]) * TICK_MS >= SPREAD_EASE.ms, `${gun}: ${what} in ${ticks(xs, from[0] + from[1], to[0] + to[1])} ticks`);
    }
  }
  assert.ok(seen.size >= 3, 'small, middling and heavy guns ease their bloom out at different paces');
  assert.equal(easeDownTicks('smg'), Math.ceil(SPREAD_EASE.downMinMs / TICK_MS) + 1, 'an SMG at the quickest');
  assert.equal(easeDownTicks('lmg'), SPREAD_EASE_TICKS, 'an LMG over the whole ease');
});

test('a sprint ending mid-settle restarts it, and sprint speed appears in the self snapshot', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500);
  const s = effectiveStats(a);
  assert.ok(Math.abs(s.sprintSpeed - s.speed * PISTOL_SPRINT) < 1e-9);
  press(w, a, { right: true, sprint: true });
  run(w, TICK_MS * 2);
  assert.equal(snapshotFor(w, a.id).self.sprintSpeed, s.sprintSpeed);
  assert.equal(snapshotFor(w, a.id).players.find((p) => p.id === a.id)?.sprint, true, 'others see a sprint pose');
});

const SERVER: ServerGun = { gun: 'assault', mag: GUNS.assault.mag, reloadMs: GUNS.assault.reloadMs, ammo: GUNS.assault.mag, reloading: false, reloadFrac: 0, alive: true, armed: true };

test('the client trigger mirrors the sprint and the eased spread tick for tick: no shot while sprinting, a click fires at once, the reticle reads what the sim fires', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500, { loadout: { weapon: 'assault' } });
  let t = settle(NO_FIRING, { ...SERVER }, 0, 0, []).firing.trigger;
  const script: Array<[number, { right?: boolean; sprint?: boolean; fire?: boolean; click?: boolean }]> = [
    [10, { right: true }], [8, {}], [20, { right: true, sprint: true }], [1, { right: true, sprint: true, fire: true, click: true }],
    [12, { right: true, fire: true }], [30, {}], [6, { fire: true }], [40, {}],
  ];
  let shots = 0, now = 0, sawSprint = false;
  for (const [ticks, keys] of script) {
    for (let i = 0; i < ticks; i++) {
      if (keys.click && i === 0) shots++;
      const input = { up: false, down: false, left: false, right: !!keys.right, sprint: !!keys.sprint, fire: !!keys.fire, reload: false, shots };
      press(w, a, input);
      const before = w.events.length;
      run(w, TICK_MS);
      now += TICK_MS;
      const step = stepTrigger(t, input, now);
      t = step.t;
      const simFired = w.events.slice(before).some((e) => e.e === 'shot' && e.owner === a.id);
      assert.equal(step.fired, simFired, `fires on the same tick (${now.toFixed(0)} ms)`);
      if (t.sprint) { sawSprint = true; assert.equal(step.fired, false); }
      assert.ok(Math.abs(spreadOf({ ...NO_FIRING, trigger: t }) - easedOf(a)) < 1e-9, `the same eased spread at ${now.toFixed(0)} ms`);
    }
  }
  assert.ok(sawSprint);
  assert.ok(settleOf({ ...NO_FIRING, trigger: t }) === 0, 'the bloom has run out');
});

test('input parsing keeps sprint, and Shift and the move stick\'s outer ring both sprint', () => {
  const input = assembleInput(new Set(['right', 'sprint'] as const), false, 0, { dx: 1, dy: 0 });
  assert.equal(input.sprint, true);
  const parsed = parseClientMsg(JSON.stringify({ t: 'input', seq: 1, input }));
  assert.equal(parsed?.t === 'input' && parsed.input.sprint, true);
  const junk = parseClientMsg(JSON.stringify({ t: 'input', seq: 1, input: { ...input, sprint: 'yes' } }));
  assert.equal(junk?.t === 'input' && junk.input.sprint, false, 'only a real true sprints');
  assert.equal(actionForKey('ShiftLeft'), 'sprint');
  assert.equal(actionForKey('ShiftRight'), 'sprint');
  assert.ok(CONTROLS.some(([key, what]) => key === 'Shift' && /sprint/i.test(what)), 'the controls table lists Shift');
  let s = pressStick(NO_STICKS, 1, 100, 400, 800);
  s = dragStick(s, 1, 100 + 40, 400);
  assert.deepEqual(touchMoves(s), ['right'], 'a thumb inside the ring walks');
  s = dragStick(s, 1, 100 + 70, 400);
  assert.deepEqual(touchMoves(s), ['right'], 'a full push to the walking ring still walks');
  s = dragStick(s, 1, 100 + 95, 400);
  assert.deepEqual(touchMoves(s).sort(), ['right', 'sprint'], 'a thumb out on the outer ring sprints');
});

test('a bot sprints to travel and walks the moment an enemy is in sight, so it can fire', () => {
  const r = (() => { let x = 11; return () => ((x = (x * 16807) % 2147483647) / 2147483647); })();
  const alone = emptyWorld();
  const bot = spawnAt(alone, 1000, 1000, { loadout: { weapon: 'assault' } });
  let mem = newBotMemory(r);
  let sprinted = 0, moved = 0;
  for (let i = 0; i < 120; i++) {
    const d = botThink(snapshotFor(alone, bot.id), arenaFor(alone), mem, r);
    mem = d.mem;
    const walking = d.input.up || d.input.down || d.input.left || d.input.right;
    if (walking) moved++;
    if (d.input.sprint) { sprinted++; assert.ok(walking, 'never sprints standing still'); assert.equal(d.input.fire, false); }
    press(alone, bot, d.input);
    run(alone, TICK_MS);
  }
  assert.ok(moved > 20 && sprinted > moved / 2, `a bot with nobody in sight sprints as it travels (${sprinted}/${moved})`);

  const fight = emptyWorld();
  const shooter = spawnAt(fight, 1000, 1000, { loadout: { weapon: 'assault' } });
  const target = spawnAt(fight, 1350, 1000);
  if (target.life.k === 'alive') target.life.hp = 1e9;
  mem = newBotMemory(r);
  let fires = 0;
  for (let i = 0; i < 90; i++) {
    if (target.life.k === 'alive') target.life.hp = 1e9;
    const d = botThink(snapshotFor(fight, shooter.id), arenaFor(fight), mem, r);
    mem = d.mem;
    if (d.input.fire) { fires++; assert.ok(!d.input.sprint, 'a bot never fires while sprinting'); }
    if (d.input.sprint && i > 5) assert.fail(`sprinting with an enemy in sight at tick ${i}`);
    press(fight, shooter, d.input);
    run(fight, TICK_MS);
  }
  assert.ok(fires > 0, 'it fought');
});

test('a sprint started mid-burst drops the rest of the burst: no round leaves on its own once the sprint ends', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500);
  equip(a, 'machinePistol');
  let fired = 0;
  const tick = () => { run(w, TICK_MS); fired += w.events.filter((e) => e.e === 'shot' && e.owner === a.id).length; };
  // A tap starts a three-round burst; the very next sample lets go of the trigger and holds sprint.
  press(w, a, { right: true, shots: a.input.shots + 1 });
  tick();
  assert.equal(fired, 1, 'the tap fired the burst\'s first round');
  press(w, a, { right: true, sprint: true, shots: a.input.shots });
  for (let i = 0; i < 45; i++) tick();
  assert.equal(snapshotFor(w, a.id).self.sprint, true);
  assert.equal(fired, 1, 'the lowered gun cut the burst');
  press(w, a, { right: true, shots: a.input.shots });
  for (let i = 0; i < Math.ceil(1000 / TICK_MS); i++) tick();
  assert.equal(fired, 1, 'no click, no shot: the cut burst does not resume when the sprint ends');
});
