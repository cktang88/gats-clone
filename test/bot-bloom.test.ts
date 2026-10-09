/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bloomRecoverMul } from '../src/shared/sim/stats.ts';
import { fireRhythm, holdsFire, PATIENCE_CAP_MS, TAP_FROM_PX, type ShotRead } from '../src/server/bot/motor.ts';
import { PERSONALITIES } from '../src/server/bot/intent.ts';
import { emptyWorld, equip, press, run, spawnAt, TICK_MS } from './helpers.ts';
import { step } from '../src/shared/sim.ts';

const sprayOf = (p: { life: { k: string; spray?: number } }) => (p.life.k === 'alive' ? p.life.spray! : -1);

test("a bot's bloom comes back down exactly as a person's does on the same gun", () => {
  assert.equal(bloomRecoverMul({}), 1, 'the gun\'s own rate');
  const w = emptyWorld();
  const human = spawnAt(w, 500, 500, { loadout: { weapon: 'sniper' }, kind: 'human' });
  const bot = spawnAt(w, 500, 900, { loadout: { weapon: 'sniper' }, kind: 'bot' });
  for (const p of [human, bot]) { equip(p, 'sniper'); press(w, p, { angle: Math.PI, fire: true, shots: p.input.shots + 1 }); }
  step(w, TICK_MS);
  for (const p of [human, bot]) press(w, p, { fire: false });
  assert.equal(sprayOf(human), 1);
  assert.equal(sprayOf(bot), 1, 'the same kick');
  for (let t = 0; t < 2000; t += TICK_MS) {
    step(w, TICK_MS);
    assert.equal(sprayOf(bot), sprayOf(human), `the same bloom at ${Math.round(t)} ms`);
  }
});

const read = (over: Partial<ShotRead>): ShotRead => ({ spray: 0, still: true, d: 700, lateral: 0, sinceShotMs: 300, urgent: false, pausing: false, ...over });

test('a bolt bot fires once the cone at that range fits the body, not after a full settle', () => {
  const r = fireRhythm('sniper', false, 1)!;
  assert.equal(holdsFire('sniper', r, read({ spray: 1 })), true, 'just kicked: the cone is wider than him at 700 px');
  assert.equal(holdsFire('sniper', r, read({ spray: 0.1 })), false, 'nearly settled is good enough');
  assert.equal(holdsFire('sniper', r, read({ spray: 0.4, d: 400 })), false, 'closer, a wider cone still fits');
  assert.equal(holdsFire('sniper', r, read({ spray: 0.4, d: 1000 })), true, 'farther, it waits longer');
});

test('a tapping bot fires at its patience cap, and a hothead is less patient than a marksman', () => {
  const hot = fireRhythm('sniper', false, PERSONALITIES.aggressive.commitMul)!, calm = fireRhythm('sniper', false, PERSONALITIES.marksman.commitMul)!;
  assert.ok(hot.patienceMs < calm.patienceMs);
  assert.ok(hot.patienceMs >= 900 && calm.patienceMs <= PATIENCE_CAP_MS, `${hot.patienceMs}..${calm.patienceMs}`);
  assert.equal(holdsFire('sniper', hot, read({ spray: 1.5, sinceShotMs: hot.patienceMs - 50 })), true);
  assert.equal(holdsFire('sniper', hot, read({ spray: 1.5, sinceShotMs: hot.patienceMs })), false, 'out of patience: it fires');
});

test('a tapping bot fires at once when it must: close in, shot at, or about to lose him', () => {
  const r = fireRhythm('sniper', false, 1.3)!;
  assert.equal(holdsFire('sniper', r, read({ spray: 1.5, d: TAP_FROM_PX - 1 })), false, 'close');
  assert.equal(holdsFire('sniper', r, read({ spray: 1.5, urgent: true })), false, 'urgent');
  assert.equal(holdsFire('sniper', r, read({ spray: 1.5 })), true);
});

test('assault burst-tapping keeps its rhythm but ends a pause once the next tap would land', () => {
  const r = fireRhythm('assault', false, 1)!;
  assert.ok(r.windowMs > 0 && r.pauseMs > 0);
  assert.equal(holdsFire('assault', r, read({ spray: 3, d: 1000, pausing: true, sinceShotMs: 50 })), true, 'right after a tap it rests at long range');
  assert.equal(holdsFire('assault', r, read({ spray: 0, d: 1000, pausing: true, sinceShotMs: 50 })), false, 'settled: the pause ends early');
  assert.equal(fireRhythm('smg', true, 1), null, 'rushers still hose');
  assert.equal(fireRhythm('lmg', false, 1), null, 'machine guns still hose');
});
