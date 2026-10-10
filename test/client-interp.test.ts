/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_BUFFER, lerpAngle, MAX_EXTRAPOLATE_MS, newestSnap, pushSnap, renderTime, sampleAt, serverNow, TICK_MS, type SnapBuffer,
} from '../src/client/interp.ts';
import { INTERP_DELAY_MS, type PlayerView, type Snapshot } from '../src/shared/protocol.ts';

const player = (id: number, x: number, y: number, angle = 0): PlayerView => ({
  id, name: `p${id}`, x, y, angle, hp: 100, maxHp: 100, color: 'red', gun: 'pistol',
  team: null, alive: true, hidden: false, shield: false, dashing: false, score: 0, level: 1, armorTier: 'none', kind: 'bot', hunted: false,
});

const snap = (tick: number, players: PlayerView[]): Snapshot => ({
  t: 'snap', tick, ackSeq: 0,
  self: { id: 1, ammo: 12, mag: 12, speed: 300, reloading: false, reloadFrac: 0, perks: {}, pending: null, ability: null, abilityReadyIn: 0, alive: true, dash: null, respawnIn: 0, kills: 0, deaths: 0, viewRadius: 900, suppression: 0, streak: 0, nemesis: null },
  players, bullets: [], crates: [], thrown: [], zones: [], minimap: [], leaderboard: [],
  match: { mode: 'FFA', map: 'Boneyard', nextMap: 'Old Town', mapChangeIn: 0, teamScore: { red: 0, blue: 0 }, winner: null, restartIn: 0, roundEndsAt: null }, events: [],
});

const walking = (tick: number) => snap(tick, [player(1, 0, 0), player(2, tick * 10, 0)]);
const xOf = (s: Snapshot | null, id = 2) => s?.players.find((p) => p.id === id)?.x;
const drawnAt = (buf: SnapBuffer, now: number) => sampleAt(buf.snaps, renderTime(buf, now));

test('others are drawn three ticks behind the server clock', () => {
  let buf = EMPTY_BUFFER;
  for (let tick = 1; tick <= 10; tick++) buf = pushSnap(buf, walking(tick), tick * TICK_MS);
  assert.equal(INTERP_DELAY_MS, 3 * TICK_MS);
  const x = xOf(drawnAt(buf, 10 * TICK_MS))!;
  assert.ok(Math.abs(x - 70) < 1e-9, `drawn at tick 7 (x=${x})`);
  const half = xOf(drawnAt(buf, 10.5 * TICK_MS))!;
  assert.ok(Math.abs(half - 75) < 1e-9, `interpolates between ticks (x=${half})`);
});

const STALL_MS = 191;

test(`a ${STALL_MS}ms arrival gap never moves anyone backward or jumps them forward`, () => {
  const arrivals: { at: number; tick: number }[] = [];
  for (let tick = 1; tick <= 60; tick++) arrivals.push({ tick, at: Math.max(tick * TICK_MS + 10, tick >= 20 ? 19 * TICK_MS + 10 + STALL_MS : 0) });
  let buf = EMPTY_BUFFER;
  const xs: number[] = [];
  for (let now = 0; now <= 60 * TICK_MS; now += 16) {
    for (const a of arrivals) if (a.at <= now && a.at > now - 16) buf = pushSnap(buf, walking(a.tick), a.at);
    if (now > 10 * TICK_MS) xs.push(xOf(drawnAt(buf, now))!);
  }
  const perFrame = (10 / TICK_MS) * 16;
  for (let i = 1; i < xs.length; i++) {
    const step = xs[i]! - xs[i - 1]!;
    assert.ok(step > 0, `frame ${i} ${step < 0 ? `moved backward by ${-step}` : 'froze'}`);
    assert.ok(step <= perFrame * 2.5, `frame ${i} jumped ${step.toFixed(1)}px (normal ${perFrame.toFixed(1)})`);
  }
});

test('under 0-40ms jitter with occasional 150ms stalls others move at a steady speed', () => {
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const arrivals: number[] = [];
  for (let tick = 1, prev = 0; tick <= 600; tick++) {
    prev = Math.max(prev, tick * TICK_MS + 10 + (rand() < 0.03 ? 150 : rand() * 40));
    arrivals[tick] = prev;
  }
  let buf = EMPTY_BUFFER, next = 1, last = 0;
  const perFrame = (10 / TICK_MS) * 16;
  for (let now = 0; now <= 600 * TICK_MS; now += 16) {
    while (next <= 600 && arrivals[next]! <= now) { buf = pushSnap(buf, walking(next), arrivals[next]!); next++; }
    const x = xOf(drawnAt(buf, now))!;
    if (now > 1000) {
      const speed = (x - last) / perFrame;
      assert.ok(speed > 0.8 && speed < 1.2, `at ${now}ms others moved at ${speed.toFixed(2)}x their real speed`);
    }
    last = x;
  }
});

test('a burst after a one second stall never draws anyone backward', () => {
  let buf = EMPTY_BUFFER;
  for (let tick = 1; tick <= 19; tick++) buf = pushSnap(buf, walking(tick), tick * TICK_MS);
  let last = xOf(drawnAt(buf, 19 * TICK_MS))!;
  for (let now = 19 * TICK_MS; now < 19 * TICK_MS + 1500; now += 16) {
    if (now >= 19 * TICK_MS + 1000 && newestSnap(buf)!.tick === 19) {
      for (let tick = 20; tick <= 50; tick++) buf = pushSnap(buf, walking(tick), now);
    }
    const x = xOf(drawnAt(buf, now))!;
    assert.ok(x >= last, `moved backward ${last} -> ${x} at ${now.toFixed(0)}ms`);
    last = x;
  }
});

test('when snapshots stop, others extrapolate for at most 100ms and then hold', () => {
  let buf = EMPTY_BUFFER;
  for (let tick = 1; tick <= 10; tick++) buf = pushSnap(buf, walking(tick), tick * TICK_MS);
  const shortly = xOf(drawnAt(buf, 10 * TICK_MS + INTERP_DELAY_MS + 50))!;
  assert.ok(Math.abs(shortly - (100 + (50 / TICK_MS) * 10)) < 1e-9, `still moving 50ms past the newest (x=${shortly})`);
  const later = xOf(drawnAt(buf, 10 * TICK_MS + 5000))!;
  assert.ok(Math.abs(later - (100 + (MAX_EXTRAPOLATE_MS / TICK_MS) * 10)) < 1e-9, `held after 100ms (x=${later})`);
});

test('the local player comes from the newest snapshot', () => {
  let buf = EMPTY_BUFFER;
  for (let tick = 1; tick <= 10; tick++) buf = pushSnap(buf, snap(tick, [player(1, tick, 0), player(2, 0, 0)]), tick * TICK_MS);
  assert.equal(xOf(drawnAt(buf, 10 * TICK_MS), 1), 10);
});

test('out-of-order and duplicate snapshots are ignored', () => {
  let buf = pushSnap(pushSnap(EMPTY_BUFFER, walking(5), 0), walking(6), 33);
  buf = pushSnap(pushSnap(buf, walking(4), 40), walking(6), 41);
  assert.deepEqual(buf.snaps.map((s) => s.tick), [5, 6]);
  assert.equal(newestSnap(buf)?.tick, 6);
  assert.equal(sampleAt([], 0), null);
});

const between = (a: PlayerView[], b: PlayerView[]) => sampleAt([snap(1, a), snap(2, b)], 1.5 * TICK_MS)!;

test('matches entities by id, not by array position', () => {
  const [a, b] = between([player(1, 0, 0), player(2, 200, 0), player(3, 0, 0)], [player(3, 20, 0), player(2, 220, 0)]).players;
  assert.equal(a?.id, 3);
  assert.ok(Math.abs(a!.x - 10) < 1e-9);
  assert.ok(Math.abs(b!.x - 210) < 1e-9);
});

test('new entities and teleports snap to their latest position; players that left are dropped', () => {
  const players = between([player(2, 0, 0), player(4, 0, 0)], [player(2, 2000, 0), player(3, 5, 5)]).players;
  assert.deepEqual(players.map((p) => [p.id, p.x]), [[2, 2000], [3, 5]]);
});

test('angles turn the short way across the wrap', () => {
  const a = Math.PI - 0.1;
  const b = -Math.PI + 0.1;
  assert.ok(Math.abs(Math.abs(lerpAngle(a, b, 0.5)) - Math.PI) < 1e-9);
  const p = between([player(2, 0, 0, a)], [player(2, 0, 0, b)]).players[0]!;
  assert.ok(Math.abs(Math.cos(p.angle) + 1) < 1e-9, 'should face west, not swing through east');
});

test('zombies glide between snapshots like players, and a fresh one appears where it spawned', () => {
  let buf = EMPTY_BUFFER;
  for (let tick = 1; tick <= 10; tick++) {
    const horde: NonNullable<Snapshot['zombies']> = [[50, 0, tick * 4, 100, 10]];
    if (tick >= 7) horde.push([51, 1, 900, 900, 10]);
    buf = pushSnap(buf, { ...walking(tick), zombies: horde }, tick * TICK_MS);
  }
  const drawn = drawnAt(buf, 10 * TICK_MS + TICK_MS / 2)?.zombies;
  assert.ok(Math.abs(drawn![0]![2] - 30) < 1e-9, `walker drawn between ticks 7 and 8 (x=${drawn![0]![2]})`);
  assert.deepEqual(drawn![1], [51, 1, 900, 900, 10]);
});

/** How far the drawn moment runs past the newest snapshot, in ms: past the extrapolation cap, others stand frozen. */
const aheadOfNewest = (buf: SnapBuffer, now: number) => renderTime(buf, now) - newestSnap(buf)!.tick * TICK_MS;

test('a server whose clock fell to half speed is followed, the drawn moment slowing with it but never running backward', () => {
  let buf = EMPTY_BUFFER;
  let tick = 0, at = 0, lastRender = -Infinity;
  for (; tick < 60; tick++, at += TICK_MS) buf = pushSnap(buf, walking(tick), at);
  // An overloaded server runs one tick for every two the wall clock allows: each snapshot is one tick on but two late.
  const start = at, ahead: number[] = [];
  for (let frame = start; frame < start + 8000; frame += 16) {
    while (at <= frame) { buf = pushSnap(buf, walking(tick++), at); at += 2 * TICK_MS; }
    const t = renderTime(buf, frame);
    assert.ok(t >= lastRender, `the drawn moment ran backward at ${frame.toFixed(0)}ms (${lastRender.toFixed(0)} -> ${t.toFixed(0)})`);
    lastRender = t;
    if ((frame - start) % 2000 < 16) ahead.push(Math.round(aheadOfNewest(buf, frame)));
  }
  // Half speed is as bad as an overload gets; the estimate trails it by its window, but no longer drifts seconds ahead.
  assert.ok(ahead.slice(1).every((ms) => ms < 600), `drawn this far past the newest snapshot every 2s: ${ahead}`);
});

test('a server crawling at a fifth of real time is still followed, the drawn moment never running backward', () => {
  let buf = EMPTY_BUFFER;
  let tick = 0, at = 0, lastRender = -Infinity;
  for (; tick < 60; tick++, at += TICK_MS) buf = pushSnap(buf, walking(tick), at);
  const start = at, ahead: number[] = [];
  for (let frame = start; frame < start + 10_000; frame += 16) {
    while (at <= frame) { buf = pushSnap(buf, walking(tick++), at); at += 5 * TICK_MS; }
    const t = renderTime(buf, frame);
    assert.ok(t >= lastRender, `the drawn moment ran backward at ${frame.toFixed(0)}ms`);
    lastRender = t;
    if ((frame - start) % 2000 < 16) ahead.push(Math.round(aheadOfNewest(buf, frame)));
  }
  assert.ok(ahead.slice(2).every((ms) => ms < 900), `drawn this far past the newest snapshot every 2s: ${ahead}`);
});

test('a server that lost a second of ticks is drawn interpolated again within three seconds, not left a second ahead', () => {
  let buf = EMPTY_BUFFER;
  let tick = 0, at = 0;
  for (; tick < 60; tick++, at += TICK_MS) buf = pushSnap(buf, walking(tick), at);
  // A one second pause the server does not pay back: the ticks resume where they stopped, a second late for good.
  at += 1000;
  const resumed = at;
  for (; at < resumed + 3000; tick++, at += TICK_MS) buf = pushSnap(buf, walking(tick), at);
  const ahead = aheadOfNewest(buf, at);
  assert.ok(ahead < 0, `drawn ${ahead.toFixed(0)}ms past the newest snapshot three seconds after the pause`);
});

test('a burst after a stall is late delivery, not a slower server: the clock estimate barely moves and the drawn moment stays in step', () => {
  let buf = EMPTY_BUFFER;
  for (let tick = 1; tick <= 19; tick++) buf = pushSnap(buf, walking(tick), tick * TICK_MS);
  const before = buf.serverClockOffset!;
  // The server kept its clock: ticks 20..50 were only held up for a second and arrive together, then delivery resumes on time.
  const at = 19 * TICK_MS + 1000;
  for (let tick = 20; tick <= 50; tick++) buf = pushSnap(buf, walking(tick), at);
  assert.ok(buf.serverClockOffset! - before > -100, `the estimate fell ${(before - buf.serverClockOffset!).toFixed(0)}ms for a burst`);
  let tick = 51, worst = 0;
  for (let now = at; now < at + 3000; now += 16) {
    while (tick * TICK_MS <= now) { buf = pushSnap(buf, walking(tick), tick * TICK_MS); tick++; }
    worst = Math.min(worst, renderTime(buf, now) - (now + before - INTERP_DELAY_MS));
  }
  assert.ok(worst > -100, `the drawn moment fell ${(-worst).toFixed(0)}ms behind after the burst`);
});

test('the server clock is the newest estimate with no interpolation delay, and unknown before the first snapshot', () => {
  assert.equal(serverNow(EMPTY_BUFFER, 1000), null);
  let buf = EMPTY_BUFFER;
  for (let tick = 1; tick <= 10; tick++) buf = pushSnap(buf, walking(tick), tick * TICK_MS + 40);
  assert.ok(Math.abs(serverNow(buf, 10 * TICK_MS + 40)! - 10 * TICK_MS) < 1e-9, 'the moment the newest snapshot arrived is its tick\'s time');
  assert.ok(Math.abs(serverNow(buf, 10 * TICK_MS + 140)! - (10 * TICK_MS + 100)) < 1e-9, 'and it runs on with the wall clock');
});

test('bullets glide between snapshots by id; thrown grenades and facing stop at the newest snapshot instead of extrapolating', () => {
  const at = (tick: number, x: number, angle: number): Snapshot => ({
    ...snap(tick, [player(1, 0, 0), player(2, 0, 0, angle)]),
    bullets: [{ id: 9, x, y: 0, vx: 900, vy: 0, owner: 2, gun: 'pistol' }],
    thrown: [{ id: 4, kind: 'fragGrenade', x, y: 0, r: 8, owner: 2 }],
  });
  const snaps = [at(1, 0, 0), at(2, 30, 0.6)];
  const mid = sampleAt(snaps, 1.5 * TICK_MS)!;
  assert.ok(Math.abs(mid.bullets[0]!.x - 15) < 1e-9, `bullet drawn halfway (x=${mid.bullets[0]!.x})`);
  assert.ok(Math.abs(mid.thrown[0]!.x - 15) < 1e-9, `grenade drawn halfway (x=${mid.thrown[0]!.x})`);
  assert.ok(Math.abs(mid.players.find((p) => p.id === 2)!.angle - 0.3) < 1e-9, 'facing turns halfway');
  const past = sampleAt(snaps, 2 * TICK_MS + 50)!;
  assert.ok(past.bullets[0]!.x > 30, 'a bullet flies on past the newest snapshot');
  assert.equal(past.thrown[0]!.x, 30, 'a grenade is not thrown past where the server last had it (it may have landed)');
  assert.equal(past.players.find((p) => p.id === 2)!.angle, 0.6, 'a soldier is not turned past the aim the server last sent');
});
