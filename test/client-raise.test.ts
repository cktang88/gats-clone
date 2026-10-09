/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boltLeftOf, NO_FIRING, settle, settleOf, spreadOf, stepTrigger, type ServerGun } from '../src/client/fire.ts';
import { CARRY, carryAt, createRaiseWatch, gunPhaseOf, RETICLE_BOLT, reticleLook, stepCarry, swingMsOf } from '../src/client/raise.ts';
import { GUN_IDS, GUNS, rulesOf, SPRINT, WORLD } from '../src/shared/defs.ts';
import { spreadFor } from '../src/shared/sim/stats.ts';

const TICK_MS = 1000 / WORLD.tickHz;
const moving = { up: false, down: false, left: false, right: true, reload: false };
const SERVER: ServerGun = { gun: 'assault', mag: GUNS.assault.mag, reloadMs: GUNS.assault.reloadMs, ammo: GUNS.assault.mag, reloading: false, reloadFrac: 0, alive: true, armed: true };

test('a sprint never holds the gun down: the click that ends it fires on the same input, and the watch never denies it', () => {
  let f = settle(NO_FIRING, SERVER, 0, 0, []).firing;
  const watch = createRaiseWatch();
  let now = TICK_MS;
  for (let i = 0; i < 10; i++, now += TICK_MS) f = { ...f, trigger: stepTrigger(f.trigger, { ...moving, fire: false, shots: 0, sprint: true }, now).t };
  assert.equal(f.trigger.sprint, true);
  watch.step(f, now);
  assert.equal(watch.phase, 'ready', 'a sprint is no phase of its own');
  assert.equal(watch.click(f, now), false, 'a click while sprinting is never a "not yet"');
  const step = stepTrigger(f.trigger, { ...moving, fire: true, shots: 1, sprint: true }, now);
  assert.equal(step.fired, true, 'the click ends the sprint and fires');
  assert.equal(step.t.sprint, false);
  assert.ok(settleOf({ ...f, trigger: step.t }) > 0.95, 'with the post-sprint bloom all but in full');
});

test('the predicted reticle shows the post-sprint bloom: it opens while sprinting, then tightens tick by tick back to the stance\'s spread', () => {
  let f = settle(NO_FIRING, SERVER, 0, 0, []).firing;
  let now = 0;
  const go = (input: Parameters<typeof stepTrigger>[1]) => { now += TICK_MS; f = { ...f, trigger: stepTrigger(f.trigger, input, now).t }; return spreadOf(f); };
  for (let i = 0; i < 20; i++) go({ ...moving, fire: false, shots: 0 });
  const walk = spreadOf(f);
  for (let i = 0; i < 20; i++) go({ ...moving, fire: false, shots: 0, sprint: true });
  const peak = spreadOf(f);
  const moveSpread = GUNS.assault.spread + rulesOf(GUNS.assault).movingSpreadAdd;
  assert.ok(Math.abs(peak - SPRINT.settleMul * moveSpread) < 1e-9 && peak > 3 * walk, `wide while sprinting (${peak} vs walking ${walk})`);
  const after: number[] = [];
  for (let i = 0; i < 90; i++) after.push(go({ ...moving, right: false, fire: false, shots: 0 }));
  for (let i = 1; i < after.length; i++) assert.ok(after[i]! <= after[i - 1]! + 1e-12, 'only tightens');
  assert.ok(after[15]! > walk, 'still wider than walking half a second in');
  assert.ok(Math.abs(after.at(-1)! - spreadFor('assault', {}, true)) < 1e-9, 'and back to the standing spread');
});

test('the reticle draws the spread it is given: no lowered, grey or dotless look for a sprint; a click a bolt is not ready for shakes it', () => {
  assert.deepEqual(reticleLook('ready', 80, Infinity, Infinity), { gap: 80, alpha: 1, grey: false, dot: 1, flash: 0, shake: 0 });
  assert.deepEqual(reticleLook('ready', 10, 5000, Infinity), { gap: 10, alpha: 1, grey: false, dot: 1, flash: 0, shake: 0 });
  const shaken = [10, 30, 60, 100].map((ms) => reticleLook('cycling', 10, -Infinity, ms).shake);
  assert.ok(shaken.some((x) => Math.abs(x) > 1), 'a click on a worked bolt shakes it');
  assert.equal(reticleLook('cycling', 10, -Infinity, RETICLE_BOLT.shakeMs).shake, 0);
});

test('the soldier\'s gun swings up from the carry in a short, cosmetic swing (light guns flick, heavy ones swing), overshoots a hair, and settles on the aim', () => {
  for (const id of GUN_IDS) assert.ok(swingMsOf(id) >= CARRY.swingMinMs && swingMsOf(id) <= CARRY.swingMaxMs, `${id}: ${swingMsOf(id)} ms`);
  assert.ok(swingMsOf('pistol') < swingMsOf('assault') && swingMsOf('smg') < swingMsOf('lmg'));
  for (const gun of ['pistol', 'lmg'] as const) {
    const swing = swingMsOf(gun);
    const at = (ms: number) => carryAt(ms, swing, 1);
    assert.equal(at(0), 1, 'starts in the carry');
    assert.ok(at(swing * 0.5) > 0.5, `${gun}: still mostly low half way up (${at(swing * 0.5)})`);
    for (let ms = 0; ms < swing; ms += swing / 20) assert.ok(at(ms + swing / 20) <= at(ms) + 1e-12);
    assert.ok(Math.abs(at(swing)) < 1e-9, 'on the aim at the end of the swing');
    const past = Array.from({ length: 20 }, (_, i) => at(swing + (i / 20) * CARRY.overshootMs));
    assert.ok(Math.min(...past) < -0.05 && Math.min(...past) >= -CARRY.overshoot, 'swings a hair past the aim');
    assert.equal(at(swing + CARRY.overshootMs), 0);
  }
  // A short sprint that only got the gun 30% into the carry comes up from there, and swings past the aim only 30% as far.
  assert.equal(carryAt(0, 200, 0.3), 0.3);
  assert.ok(Math.abs(carryAt(100, 200, 0.3) - 0.3 * carryAt(100, 200, 1)) < 1e-12);
  const swing = (from: number) => Math.min(...Array.from({ length: 20 }, (_, i) => carryAt(200 + (i / 20) * CARRY.overshootMs, 200, from)));
  assert.ok(Math.abs(swing(0.3) - 0.3 * swing(1)) < 1e-12, `overshoot scales with the carry (${swing(0.3)} vs ${swing(1)})`);
});

test('a body drops into the carry over CARRY.downMs while it sprints and swings back up over its swing; reduced motion snaps', () => {
  const swing = 200;
  // id 101: first seen walking, then sprints for 70 ms (half the drop), then stops.
  assert.equal(stepCarry(101, false, swing, 1000, false), 0);
  let a = 0;
  for (let now = 1000; now <= 1070; now += 10) a = stepCarry(101, true, swing, now, false);
  assert.ok(Math.abs(a - 70 / CARRY.downMs) < 1e-9, `half way down after 70 ms (${a})`);
  assert.equal(stepCarry(101, false, swing, 1080, false), a, 'the sprint just ended: still where it got to');
  assert.ok(Math.abs(stepCarry(101, false, swing, 1080 + swing / 2, false) - carryAt(swing / 2, swing, a)) < 1e-12, 'then rises on carryAt from there');
  assert.equal(stepCarry(101, false, swing, 1080 + swing + CARRY.overshootMs, false), 0, 'and is on the aim once it settles');
  assert.equal(stepCarry(102, true, swing, 0, true), 1);
  assert.equal(stepCarry(102, false, swing, 10, true), 1);
  assert.equal(stepCarry(102, false, swing, 10 + swing - 1, true), 1, 'no easing');
  assert.equal(stepCarry(102, false, swing, 10 + swing, true), 0, 'and no overshoot');
});

test('the watch reads a dead soldier\'s gun as ready, and denies nothing for the dead or after the round', () => {
  const watch = createRaiseWatch();
  const sprinting = settle(NO_FIRING, { ...SERVER, sprint: true }, 10, 0, []).firing;
  watch.step(sprinting, 0);
  const dead = settle(sprinting, { ...SERVER, sprint: true, alive: false }, 11, 0, []).firing;
  watch.step(dead, 16);
  assert.equal(watch.phase, 'ready');
  assert.equal(watch.click(dead, 16), false, 'dead');
  assert.equal(watch.click(settle(NO_FIRING, { ...SERVER, armed: false }, 10, 0, []).firing, 16), false, 'round over');
  assert.equal(gunPhaseOf(sprinting, 0), 'ready');
});

test('a bolt-action\'s reticle greys while the bolt is worked after each shot and brightens the moment the next round is chambered', () => {
  const sv: ServerGun = { ...SERVER, gun: 'sniper', mag: GUNS.sniper.mag, reloadMs: GUNS.sniper.reloadMs, ammo: GUNS.sniper.mag };
  let f = settle(NO_FIRING, sv, 0, 0, []).firing;
  let seq = 0;
  const send = (input: Parameters<typeof stepTrigger>[1]) => { seq++; const r = stepTrigger(f.trigger, input, seq * TICK_MS); f = { ...f, trigger: r.t, sent: { seq, at: seq * TICK_MS } }; return r.fired; };
  const still = { up: false, down: false, left: false, right: false, reload: false };
  for (let i = 0; i < 20; i++) send({ ...still, fire: false, shots: 0 });
  assert.equal(gunPhaseOf(f, seq * TICK_MS), 'ready');
  assert.equal(send({ ...still, fire: true, shots: 1 }), true, 'fires');
  const watch = createRaiseWatch();
  watch.step(f, seq * TICK_MS);
  assert.equal(watch.phase, 'cycling');
  assert.ok(Math.abs(boltLeftOf(f, seq * TICK_MS) - GUNS.sniper.fireMs) <= TICK_MS, 'the bolt is worked for the whole fire interval');
  assert.equal(watch.click(f, seq * TICK_MS), true, 'a click this early is a "not yet"');
  const look = reticleLook('cycling', 12, -Infinity, Infinity);
  assert.deepEqual([look.grey, look.dot, look.gap], [true, 0, 12], 'grey and dotless, at its own (bloomed) gap rather than splayed');
  let up = -1;
  while (up < 0) { send({ ...still, fire: false, shots: 1 }); watch.step(f, seq * TICK_MS); if ((watch.phase as string) === 'ready') up = seq * TICK_MS; }
  assert.ok(Math.abs(up - TICK_MS * 21 - GUNS.sniper.fireMs) <= 2 * TICK_MS, `chambered after ${up - TICK_MS * 21}ms`);
  const snap = reticleLook('ready', 12, watch.sinceReady(seq * TICK_MS + 10), Infinity);
  assert.ok(snap.flash > 0 && !snap.grey && snap.gap === 12, 'a chambered round flashes bright with no splay to snap in from');
  // A semi-auto works nothing by hand: its reticle never greys between shots.
  const semi = settle(NO_FIRING, { ...sv, gun: 'semiAuto' }, 0, 0, []).firing;
  const shot = stepTrigger(semi.trigger, { ...still, fire: true, shots: 1 }, TICK_MS);
  assert.equal(shot.fired, true);
  assert.equal(boltLeftOf({ ...semi, trigger: shot.t, sent: { seq: 1, at: TICK_MS } }, TICK_MS), 0);
});
