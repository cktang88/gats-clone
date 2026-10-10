import assert from 'node:assert/strict';
import { test } from 'node:test';
import { at, CAPS, createBlastFx, fx, isPop, liveCount, scaleOf, seeded, startBoom, startDust, trackDash, ghostsOf, GHOST_MS } from '../src/client/blastfx.ts';

test('pools are fixed-size rings that overwrite the oldest entry', () => {
  const sizes = [fx.particles.slots.length, fx.blasts.slots.length, fx.scorches.slots.length, fx.slashes.slots.length];
  for (let i = 0; i < 200; i++) startBoom(i, i, 160, i);
  for (let i = 0; i < 100; i++) startDust({ x: 0, y: 0, w: 100, h: 20 }, 1000 + i);
  assert.deepEqual([fx.particles.slots.length, fx.blasts.slots.length, fx.scorches.slots.length, fx.slashes.slots.length], sizes);
  assert.deepEqual(sizes, [CAPS.particles, CAPS.blasts, CAPS.scorches, CAPS.slashes]);
  assert.ok(liveCount(fx.particles, 150) <= CAPS.particles);
});

test('a pop leaves no scorch, a blast does', () => {
  const f = createBlastFx();
  assert.equal(f.scorches.slots.every((s) => s.born === -Infinity), true);
  assert.ok(isPop(40) && !isPop(90));
  assert.ok(scaleOf(10) === 0.45 && scaleOf(1000) === 1.8);
});

test('particles are a pure function of time and die at their life', () => {
  const p = { x: 0, y: 0, vx: 100, vy: 0, drag: 2, born: 0, life: 1000, size: 1, grow: 0, kind: 'spark' as const, tone: 0, rot: 0, spin: 0, z0: 0, vz: 0, bounce: 0 };
  assert.deepEqual(at(p, 500), at(p, 500));
  assert.ok(at(p, 1000).x < 50 && at(p, 1000).k === 1);
});

test('seeded random repeats', () => {
  const a = seeded(5), b = seeded(5);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test('dash ghosts age out and are capped', () => {
  for (let i = 0; i < 60; i++) trackDash([{ id: 1, x: i * 10, y: 0, dashing: true, alive: true }], i * 5);
  assert.ok(ghostsOf(1).length <= 24);
  trackDash([{ id: 1, x: 0, y: 0, dashing: false, alive: true }], 300 + GHOST_MS + 500);
  assert.equal(ghostsOf(1).length, 0);
});

import { BLAST_MS, DEBRIS, GRAVITY, heightAt, kindOfRadius, lightsFor, markBlast, noteThrown, SCORCH_MS, startShell, where } from '../src/client/blastfx.ts';
import { flightAt } from '../src/client/grenadeart.ts';
import { FIRE_RAMP, mixHex, rampAt } from '../src/client/blastdraw.ts';

const reset = () => { for (const r of [fx.particles, fx.blasts, fx.scorches, fx.slashes, fx.shells]) for (const s of r.slots as { born: number }[]) s.born = -Infinity; };
const lastBlast = () => fx.blasts.slots.reduce((a, b) => (b.born > a.born ? b : a));
const rng = () => { let s = 11; return () => (s = (s * 16807) % 2147483647) / 2147483647; };

test('the radius names the size of a blast, and what flew or burst nearby names the kind', () => {
  assert.deepEqual([36, 90, 110, 120, 160, 170].map(kindOfRadius), ['pop', 'slug', 'bloater', 'shell', 'grenade', 'barrel']);
  reset();
  noteThrown(7, 'fragGrenade', 100, 100, 1000);
  startBoom(104, 98, 90, 1010, rng());
  assert.equal(lastBlast().kind, 'frag');
  // Taken once: a second blast there is by the radius again.
  startBoom(104, 98, 90, 1020, rng());
  assert.equal(lastBlast().kind, 'slug');
  reset();
  noteThrown(8, 'gasGrenade', 0, 0, 2000);
  startBoom(0, 0, 40, 2000, rng());
  assert.equal(lastBlast().kind, 'gas');
  noteThrown(9, 'claymore', 500, 500, 2100);
  startBoom(500, 500, 130, 2100, rng());
  assert.equal(lastBlast().kind, 'mine');
});

test('a barrel or a tank names itself before or after its blast and the blast takes the kind', () => {
  reset();
  markBlast('barrel', 300, 300, 5000);
  startBoom(300, 300, 170, 5010, rng());
  assert.equal(lastBlast().kind, 'barrel');
  reset();
  startBoom(40, 40, 120, 6000, rng());
  assert.equal(lastBlast().kind, 'shell');
  markBlast('propane', 42, 38, 6005);
  assert.equal(lastBlast().kind, 'propane');
  // Far away it is not this blast's business.
  markBlast('barrel', 900, 900, 6006);
  assert.equal(lastBlast().kind, 'propane');
});

test('each kind throws its own debris, and a frag fires the sim\'s sixteen fragments at their angles', () => {
  reset();
  startBoom(0, 0, 90, 0, rng(), 'frag');
  const streaks = fx.particles.slots.filter((p) => p.kind === 'streak' && p.born === 0);
  assert.equal(streaks.length, 16);
  assert.ok(streaks.every((p, i) => Math.abs(p.rot - (i / 16) * Math.PI * 2) < 1e-9));
  reset();
  startBoom(0, 0, 170, 0, rng(), 'barrel');
  assert.ok(fx.particles.slots.some((p) => p.kind === 'stave' && p.born >= 0));
  reset();
  startBoom(0, 0, 110, 0, rng(), 'bloater');
  assert.ok(fx.particles.slots.some((p) => p.kind === 'ichor' && p.born >= 0));
  reset();
  startBoom(0, 0, 130, 0, rng(), 'mine');
  assert.ok(fx.particles.slots.some((p) => p.kind === 'chip' && p.born >= 0 && p.tone === DEBRIS.indexOf('#6b5238')));
});

test('layers: smoke climbs and a scorch is laid; a gas pop is green and leaves no scorch', () => {
  reset();
  startBoom(0, 0, 160, 0, rng(), 'grenade');
  const smoke = fx.particles.slots.filter((p) => p.kind === 'smoke' && p.born >= 0);
  const w = { x: 0, y: 0, z: 0, k: 0, grounded: false };
  const highest = Math.min(...smoke.map((p) => where(p, p.born + 1500, w).y));
  assert.ok(highest < -110, `the column rises screen-up (${highest})`);
  assert.equal(fx.scorches.slots.filter((s) => s.born === 0).length, 1);
  assert.ok(SCORCH_MS >= 14000 && SCORCH_MS <= 16000);
  reset();
  startBoom(0, 0, 40, 0, rng(), 'gas');
  assert.equal(fx.scorches.slots.filter((s) => s.born === 0).length, 0);
  assert.ok(fx.particles.slots.some((p) => p.kind === 'smoke' && p.born >= 0 && p.tone === 2));
});

test('debris arcs, bounces with less each time, and comes to rest', () => {
  const p = { z0: 6, vz: 500, bounce: 0.4 };
  assert.deepEqual(heightAt(p, 0.2), heightAt(p, 0.2));
  const peak = Math.max(...Array.from({ length: 60 }, (_, i) => heightAt(p, i / 60).z));
  assert.ok(peak > 60 && peak < 6 + (500 * 500) / (2 * GRAVITY) + 1);
  const tg = (500 + Math.sqrt(500 * 500 + 2 * GRAVITY * 6)) / GRAVITY;
  const second = Math.max(...Array.from({ length: 60 }, (_, i) => heightAt(p, tg + i / 120).z));
  assert.ok(second > 5 && second < peak * 0.4, `bounce ${second} vs ${peak}`);
  assert.equal(heightAt(p, 5).grounded, true);
  assert.equal(heightAt({ z0: 0, vz: 300, bounce: 0 }, 3).z, 0);
});

test('every explosion is a light: a flash, a glow, and for a big one a light in the smoke', () => {
  const big = lightsFor('grenade', 0, 0, 160), small = lightsFor('gas', 0, 0, 40);
  assert.equal(big.length, 3);
  assert.equal(small.length, 2);
  assert.ok(big[0]!.life! < 200 && big[1]!.life! >= 600 && big[2]!.y! < 0);
  assert.ok(big[1]!.radius > small[1]!.radius);
});

test('the fire ramp runs white to smoke along the bible stops, in hard steps', () => {
  assert.deepEqual([rampAt(0), rampAt(1), rampAt(2), rampAt(3), rampAt(4)], [...FIRE_RAMP]);
  assert.ok(rampAt(1.5) !== rampAt(1) && rampAt(1.5) !== rampAt(2));
  assert.equal(rampAt(-3), '#ffffff');
  assert.equal(rampAt(9), '#5a5550');
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
  assert.ok(BLAST_MS >= 600 && BLAST_MS <= 900);
});

test('a grenade lob: a high first arc, two smaller bounces, a squash on each landing, then it lies', () => {
  const z = (t: number) => flightAt(t, 40, 0).z;
  assert.ok(z(280) > 35 && z(280) <= 52);
  assert.ok(z(560 + 95) > 0 && z(560 + 95) < 12);
  assert.ok(z(560 + 190 + 60) > 0 && z(560 + 190 + 60) < 4);
  assert.equal(z(880), 0);
  assert.ok(flightAt(570, 40, 0).squash > 0.8 && flightAt(700, 40, 0).squash === 0);
  assert.equal(flightAt(280, 40, 0).landed, false);
  assert.equal(flightAt(600, 40, 0).landed, true);
  assert.deepEqual(flightAt(300, 40, 1), flightAt(300, 40, 1));
});

test('a mortar shell pool is capped and shells are told by where they land', () => {
  const before = fx.shells.slots.length;
  for (let i = 0; i < 40; i++) startShell(0, 0, 0, 500, 700, i);
  assert.equal(fx.shells.slots.length, before);
  assert.equal(before, CAPS.shells);
});
