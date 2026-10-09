/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUN_IDS, GUNS, rulesOf, WORLD, type GunId } from '../src/shared/defs.ts';
import { INTERP_DELAY_MS, type GameEvent } from '../src/shared/protocol.ts';
import { TARGETS, targetAim, targetBody, targetPos } from '../src/shared/range.ts';
import { addPlayer, setInput, step } from '../src/shared/sim.ts';
import { intercept, MUZZLE_PX } from '../src/shared/sim/ballistics.ts';
import { flyThroughPast, rewindCapFor } from '../src/shared/sim/combat.ts';
import { easedSpread } from '../src/shared/sim/stats.ts';
import { setRangeLoadout } from '../src/shared/sim/targets.ts';
import { createWorld, IDLE_INPUT, type Bullet } from '../src/shared/sim/world.ts';
import { drawnRounds, fireRounds, meetBodies, type Body, type LocalRound } from '../src/client/rounds.ts';
import { heldMuzzleReach, muzzleTip } from '../src/client/gunart.ts';
import { emptyWorld, press, run, spawnAt, TICK_MS } from './helpers.ts';

/**
 * Hit registration end to end: the server's sim judges each round while the page's own code (fireRounds, meetBodies, drawnRounds)
 * draws it, and the two must agree. "I see it cross the target but no hit registers" was five bugs: the rewound round flew its
 * firing tick twice and stayed a tick ahead of the world it was judged in, a body was judged frozen where each step ends, the
 * range's boards stood above the circle rounds met, the page drew its own random spread and its own muzzle start, and a 150 ms
 * ping's rewind was clipped.
 */

const R = WORLD.playerRadius;
let seq = 1;
const hitOn = (events: readonly GameEvent[], id: number) => events.some((e) => e.e === 'dmg' && e.victim === id);

/** A pose track recorded after every step, read back at any time between, as the page interpolates it. */
function track() {
  const at: { t: number; x: number; y: number }[] = [];
  return {
    note: (t: number, p: { x: number; y: number }) => at.push({ t, x: p.x, y: p.y }),
    pose(t: number) {
      let a = at[0]!;
      for (const f of at) {
        if (f.t > t) { if (f === a) return a; const k = (t - a.t) / (f.t - a.t); return { x: a.x + (f.x - a.x) * k, y: a.y + (f.y - a.y) * k }; }
        a = f;
      }
      return a;
    },
  };
}

/**
 * The page's view of one shot: drawn from the drawn muzzle along `angle` at view time `viewAt`, against the bodies as drawn at each
 * moment (`bodiesAt(view ms)`). Returns how far inside the nearest body's edge the drawn round passed (negative: outside), so a
 * hair's-breadth graze can be told apart, and whether the page's frames (16 ms, `meetBodies`) stopped it on a body.
 */
function drawnShot(gun: GunId, from: { x: number; y: number }, angle: number, owner: number, n: number, spread: number, viewAt: number, bodiesAt: (ms: number) => Body[]) {
  const lead = Math.max(0, heldMuzzleReach(gun, R, angle) - MUZZLE_PX);
  let rounds: LocalRound[] = fireRounds({ owner, gun, range: GUNS[gun].range, spread, n }, muzzleTip(from.x, from.y, angle, gun, R), angle, { solids: [], bodies: [] }, 0, -1, undefined, lead);
  let depth = -Infinity;
  // How deep the drawn round went into a body, sampled finely along its whole flight; the page's own frames (`meetBodies`) stop it there.
  for (let t = 0; t < 3000; t += 0.25) {
    for (const r of rounds) for (const v of drawnRounds([], [r], new Map(), t)) {
      for (const b of bodiesAt(viewAt + t)) {
        const cy = Math.max(b.y - (b.up ?? 0), Math.min(b.y, v.y));
        depth = Math.max(depth, b.r - Math.hypot(v.x - b.x, v.y - cy));
      }
    }
  }
  for (let t = 0; t < 3000; t += 16) rounds = meetBodies(rounds, () => bodiesAt(viewAt + t), t);
  const stopped = rounds.some((r) => r.reach < GUNS[gun].range - 1e-6);
  return { hit: depth > 0, depth, stopped };
}

/** A strafing victim (`y` bounded), and a shooter `dist` px west who sees the world `rttMs` plus the render delay and a queue wait ago. */
function duel(gun: GunId, dist: number) {
  const w = emptyWorld();
  const shooter = spawnAt(w, 300, 1000, { kind: 'human' });
  const victim = spawnAt(w, 300 + dist, 1000);
  shooter.gun = gun;
  const seen = track();
  let dir = 1, flipAt = 0, rng = 7;
  const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647);
  const tick = (events?: GameEvent[]) => {
    if (w.now >= flipAt) { dir = rand() < 0.5 ? -1 : 1; flipAt = w.now + 250 + rand() * 900; }
    if (Math.abs(victim.y - 1000) > 220) dir = victim.y > 1000 ? -1 : 1;
    setInput(w, victim.id, seq++, { ...IDLE_INPUT, up: dir < 0, down: dir > 0 });
    step(w, TICK_MS);
    events?.push(...w.events);
    seen.note(w.now, victim);
    if (victim.life.k === 'alive') { victim.life.hp = 1e6; victim.life.lastDamageAt = w.now; victim.life.shieldUntil = -Infinity; }
  };
  return { w, shooter, victim, seen, tick, rand };
}

/** Fires `shots` rounds with `gun` at a strafing victim from a client `rttMs` away, aimed (and led) at the body as drawn, `off` px either side. */
function agreeOnPlayers(gun: GunId, dist: number, rttMs: number, shots: number) {
  const { w, shooter, victim, seen, tick, rand } = duel(gun, dist);
  let drawnHits = 0, agree = 0, judged = 0;
  const disagreements: string[] = [];
  for (let i = 0; i < shots; i++) {
    if (shooter.life.k === 'alive') { shooter.life.ammo = 99; shooter.life.nextFireAt = 0; shooter.life.reloadUntil = null; }
    setInput(w, shooter.id, seq++, { ...IDLE_INPUT, shots: shooter.input.shots, left: i % 3 === 0 });
    for (let k = 0; k < 18; k++) tick();
    const queue = rand() * TICK_MS;
    const viewAt = w.now + TICK_MS - (rttMs + INTERP_DELAY_MS + queue);
    const off = (rand() * 2 - 1) * R;
    const at = seen.pose(viewAt), before = seen.pose(viewAt - 100);
    const meet = intercept(shooter, { x: at.x, y: at.y + off, vx: (at.x - before.x) * 10, vy: (at.y - before.y) * 10 }, GUNS[gun].bulletSpeed, rulesOf(GUNS[gun]).muzzleBoost, heldMuzzleReach(gun, R, 0));
    const angle = Math.atan2(meet.y - shooter.y, meet.x - shooter.x);
    const from = { x: shooter.x, y: shooter.y }, n = shooter.fired;
    setInput(w, shooter.id, seq++, { ...IDLE_INPUT, angle, fire: true, shots: shooter.input.shots + 1 }, viewAt, rewindCapFor(rttMs) + TICK_MS);
    const events: GameEvent[] = [];
    tick(events);
    // The page respreads its shot to the spread the input that fired it settled (fire.ts `respreadShot`).
    const spread = easedSpread(shooter.life.k === 'alive' ? shooter.life.spreadHist : []);
    setInput(w, shooter.id, seq++, { ...IDLE_INPUT, angle, shots: shooter.input.shots });
    for (let k = 0; k < 45; k++) tick(events);
    const drawn = drawnShot(gun, from, angle, shooter.id, n, spread, viewAt, (ms) => [{ ...seen.pose(ms), r: R, id: victim.id }]);
    if (drawn.hit) drawnHits++;
    // The page stops what it draws at the body it went through (and only there, give or take a frame's walk of the body).
    if (Math.abs(drawn.depth) > 3) assert.equal(drawn.stopped, drawn.hit, `shot ${i}: drawn ${drawn.depth.toFixed(1)}px inside, stopped ${drawn.stopped}`);
    // A line that passes within half a pixel of the edge is a coin toss for any two samplings of the same motion.
    if (Math.abs(drawn.depth) < 0.5) continue;
    judged++;
    if (drawn.hit === hitOn(events, victim.id)) agree++;
    else disagreements.push(`shot ${i}: drawn ${drawn.hit ? 'hit' : 'miss'} (${drawn.depth.toFixed(1)}px inside), server ${drawn.hit ? 'missed' : 'hit'}`);
  }
  return { drawnHits, agree, judged, disagreements };
}

test('no tunnelling: a round meets a body at any speed, from the first step out of the muzzle to the end of its range', () => {
  for (const speed of [200, 900, 3000, 12_000, 60_000, 400_000]) {
    for (const dist of [MUZZLE_PX + R - 4, 60, 200, 700]) {
      const w = emptyWorld();
      const shooter = spawnAt(w, 500, 500);
      const victim = spawnAt(w, 500 + dist, 500 + R - 2);
      w.events = [];
      const round: Bullet = { id: 9999, owner: shooter.id, team: null, x: 500 + MUZZLE_PX, y: 500, vx: speed, vy: 0, left: 800, damage: 10, piercing: false, label: 'Test', gun: null, turret: null, lobbed: false, penetrate: 0, passed: [], blast: null, volley: 1 };
      w.bullets.push(round);
      const events: GameEvent[] = [];
      for (let t = 0; t < 4500; t += TICK_MS) { step(w, TICK_MS); events.push(...w.events); }
      assert.ok(hitOn(events, victim.id), `a ${speed} px/s round grazing a body ${dist} px out`);
    }
  }
  // Every gun's own round on its own speed curve, spread aside, at a body overlapping the muzzle, just past it, and grazed at the end of its reach.
  for (const gun of GUN_IDS) {
    for (const [dist, dy] of [[MUZZLE_PX, 0], [MUZZLE_PX + R + 4, R - 2], [MUZZLE_PX + GUNS[gun].range + R - 2, 0]] as const) {
      const w = emptyWorld();
      const shooter = spawnAt(w, 300, 500);
      const victim = spawnAt(w, 300 + dist, 500 + dy);
      if (victim.life.k === 'alive') victim.life.hp = 1e6;
      w.bullets.push({ id: 99_999, owner: shooter.id, team: null, x: 300 + MUZZLE_PX, y: 500, vx: GUNS[gun].bulletSpeed, vy: 0, left: GUNS[gun].range, damage: 1, piercing: false, label: 'Test', gun, turret: null, lobbed: false, penetrate: 0, passed: [], blast: null, volley: 1 });
      const events: GameEvent[] = [];
      for (let t = 0; t < 2500; t += TICK_MS) { step(w, TICK_MS); events.push(...w.events); }
      assert.ok(hitOn(events, victim.id), `${gun} at a body ${dist} px out, ${dy} px off the line`);
    }
  }
});

test('no tunnelling past a moving body: a round crossing a strafer\'s path mid-step meets them where they are then, not where the step ends', () => {
  // A sniper round on its way 800 px out crosses the path of a body running across it at full speed: aimed to graze it, 3 px inside its edge.
  let hits = 0, tries = 0;
  for (let phase = 0; phase < 1; phase += 0.1) {
    for (const side of [-1, 1]) {
      const w = emptyWorld();
      const shooter = spawnAt(w, 200, 1000);
      const victim = spawnAt(w, 1000, 1000 - side * 200);
      run(w, phase * TICK_MS);
      press(w, victim, side > 0 ? { down: true } : { up: true });
      run(w, 500);
      const speed = Math.abs(victim.y - (w.history.at(-2)!.poses.get(victim.id)!.y)) / (TICK_MS / 1000);
      assert.ok(speed > 150, `the victim runs (${speed.toFixed(0)} px/s)`);
      // Lead it: where it will be when a level sniper round from the muzzle reaches its x, 3 px inside its trailing edge. No spread: the line is exact.
      const meet = intercept({ x: shooter.x, y: 1000 }, { x: victim.x, y: victim.y, vx: 0, vy: side * speed }, GUNS.sniper.bulletSpeed, 0, MUZZLE_PX);
      const aimY = meet.y - side * (R - 3);
      const a = Math.atan2(aimY - shooter.y, meet.x - shooter.x - MUZZLE_PX);
      const sp = GUNS.sniper.bulletSpeed;
      w.bullets.push({ id: 99_999, owner: shooter.id, team: null, x: shooter.x + MUZZLE_PX, y: shooter.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, left: 1200, damage: 1, piercing: false, label: 'Test', gun: null, turret: null, lobbed: false, penetrate: 0, passed: [], blast: null, volley: 1 });
      const events: GameEvent[] = [];
      for (let t = 0; t < 1500; t += TICK_MS) { step(w, TICK_MS); events.push(...w.events); }
      tries++;
      if (hitOn(events, victim.id)) hits++;
    }
  }
  assert.equal(hits, tries, `${hits} of ${tries} grazing shots on a runner landed`);
});

test('the tracer the page draws is the server\'s round: the same start, the same line for every pellet, the same place at every age', () => {
  for (const gun of ['sniper', 'assault', 'shotgun', 'smg', 'lmg', 'pistol'] as const) {
    const w = emptyWorld();
    const p = spawnAt(w, 500, 500, { kind: 'human' });
    p.gun = gun;
    // Walking, so the gun sprays: a planted sniper's pinpoint would hide a spread drawn differently.
    press(w, p, { right: true, angle: 0.3 });
    run(w, 400);
    for (let shot = 0; shot < 4; shot++) {
      const n = p.fired;
      w.bullets = [];
      press(w, p, { right: true, angle: 0.3, fire: true, shots: p.input.shots + 1 });
      step(w, TICK_MS);
      const shotEvent = w.events.find((e) => e.e === 'shot' && e.owner === p.id);
      assert.ok(shotEvent && shotEvent.e === 'shot' && shotEvent.n === n, `${gun}: the shot event names the shot's number`);
      const spread = easedSpread(p.life.k === 'alive' ? p.life.spreadHist : []);
      assert.ok(spread > 0, `${gun} sprays on the move`);
      const server = w.bullets.filter((b) => b.owner === p.id);
      assert.equal(server.length, GUNS[gun].pellets);
      const from = { x: p.x, y: p.y };
      const lead = Math.max(0, heldMuzzleReach(gun, R, 0.3) - MUZZLE_PX);
      const drawn = fireRounds({ owner: p.id, gun, range: GUNS[gun].range, spread, n }, muzzleTip(from.x, from.y, 0.3, gun, R), 0.3, { solids: [], bodies: [] }, 0, -1, undefined, lead);
      for (const [i, b] of server.entries()) {
        const r = drawn[i]!;
        assert.ok(Math.abs(Math.atan2(r.vy, r.vx) - Math.atan2(b.vy, b.vx)) < 1e-9, `${gun} pellet ${i}: drawn along the server's line`);
        // The server's round has flown one tick from where it started; the drawn one, one tick old, is in the same place.
        const [v] = drawnRounds([], [r], new Map(), TICK_MS);
        assert.ok(v && Math.hypot(v.x - b.x, v.y - b.y) < 0.01, `${gun} pellet ${i}: one tick out, drawn at (${v?.x.toFixed(2)}, ${v?.y.toFixed(2)}), the server's at (${b.x.toFixed(2)}, ${b.y.toFixed(2)})`);
      }
      press(w, p, { right: true, angle: 0.3 });
      run(w, Math.max(GUNS[gun].fireMs, 100) + 2 * TICK_MS);
      if (p.life.k === 'alive') { p.life.ammo = 99; p.life.reloadUntil = null; }
    }
  }
});

for (const rttMs of [0, 160, 300]) {
  test(`lag-compensated sniper and assault rounds at a ${rttMs} ms round trip hit a strafing player exactly when the drawn round meets them`, () => {
    for (const [gun, dist] of [['sniper', 750], ['sniper', 450], ['assault', 450]] as const) {
      const { drawnHits, agree, judged, disagreements } = agreeOnPlayers(gun, dist, rttMs, 50);
      assert.ok(drawnHits >= 5, `${gun} at ${dist}px: enough drawn hits to judge (${drawnHits})`);
      assert.equal(agree, judged, `${gun} at ${dist}px: ${disagreements.join('; ')}`);
    }
  });
}

/** Each kind's drawn board (targetart.ts), as a box about its base: half its width, and its top and bottom above the base. */
const BOARD = { paper: { w: 19, top: 64, bottom: 14 }, rail: { w: 19, top: 68, bottom: 18 }, plank: { w: 24, top: 66, bottom: 10 }, dummy: { w: 17, top: 64, bottom: 14 } } as const;

test('range boards: a round the page draws through the board hits, a sliding one too, whatever the ping, and one drawn clear of it misses', () => {
  const w = createWorld('RNG', 7, 'range');
  const layout = w.range!;
  const p = addPlayer(w, 'me', { weapon: 'sniper', armor: 'none', color: 'red' }, { at: { x: 380, y: 500 }, kind: 'human' });
  setRangeLoadout(w, p, { gun: 'sniper' });
  const sliders = layout.targets.filter((t) => t.def.rail);
  const boards = layout.targets.filter((t) => !t.def.rail && t.def.y < 1900);
  assert.ok(sliders.length === 2 && boards.length >= 6);
  let through = 0, clear = 0;
  const shoot = (t: (typeof layout.targets)[number], standY: number, rttMs: number, up: number) => {
    p.x = 380; p.y = standY;
    for (const o of layout.targets) { o.hp = o.maxHp = 1e9; o.respawnAt = o === t ? null : Infinity; }
    if (p.life.k === 'alive') { p.life.ammo = 99; p.life.nextFireAt = 0; p.life.reloadUntil = null; }
    for (let k = 0; k < 20; k++) { setInput(w, p.id, seq++, { ...IDLE_INPUT, shots: p.input.shots }); step(w, TICK_MS); }
    const viewAt = w.now + TICK_MS - (rttMs + INTERP_DELAY_MS + TICK_MS / 2);
    const seen = targetPos(t.def, viewAt), soon = targetPos(t.def, viewAt + 50), ago = targetPos(t.def, viewAt - 50);
    const meet = intercept(p, { x: seen.x, y: seen.y - up, vx: (soon.x - ago.x) * 10, vy: (soon.y - ago.y) * 10 }, GUNS.sniper.bulletSpeed, rulesOf(GUNS.sniper).muzzleBoost, heldMuzzleReach('sniper', R, 0));
    const angle = Math.atan2(meet.y - p.y, meet.x - p.x);
    const n = p.fired, from = { x: p.x, y: p.y };
    setInput(w, p.id, seq++, { ...IDLE_INPUT, angle, fire: true, shots: p.input.shots + 1 }, viewAt, rewindCapFor(rttMs) + TICK_MS);
    const events: GameEvent[] = [];
    step(w, TICK_MS);
    events.push(...w.events);
    const spread = easedSpread(p.life.k === 'alive' ? p.life.spreadHist : []);
    setInput(w, p.id, seq++, { ...IDLE_INPUT, angle, shots: p.input.shots });
    for (let k = 0; k < 50; k++) { step(w, TICK_MS); events.push(...w.events); }
    // Where the page draws the round against where it draws the board, frame by frame: through its face (3 px in), or never within 8 px of it.
    const box = BOARD[t.def.kind];
    const [r] = fireRounds({ owner: p.id, gun: 'sniper', range: GUNS.sniper.range, spread, n }, muzzleTip(from.x, from.y, angle, 'sniper', R), angle, { solids: [], bodies: [] }, 0, -1, undefined, Math.max(0, heldMuzzleReach('sniper', R, angle) - MUZZLE_PX));
    let inside = false, near = false;
    for (let ms = 0; ms < 2000; ms += 2) {
      const [v] = drawnRounds([], [r!], new Map(), ms);
      if (!v) continue;
      const b = targetPos(t.def, viewAt + ms), x = v.x - b.x, y = b.y - v.y;
      if (Math.abs(x) <= box.w - 3 && y >= box.bottom + 3 && y <= box.top - 3) inside = true;
      if (Math.abs(x) <= box.w + 8 && y >= box.bottom - 8 - 30 && y <= box.top + 8) near = true;
    }
    const hit = hitOn(events, t.id);
    const what = `${t.def.kind}${t.def.rail ? ' slider' : ''} at ${t.def.x - 380}px, aimed ${up}px up, ${rttMs}ms round trip`;
    if (inside) { through++; assert.ok(hit, `drawn through the board of the ${what}, but no hit`); }
    if (!near) { clear++; assert.ok(!hit, `drawn clear of the ${what}, but a hit`); }
  };
  for (const rttMs of [0, 160, 300]) {
    for (const t of [...boards, ...sliders]) {
      const standY = t.def.rail ? t.def.y : targetAim(t.def.kind, t.def).y;
      const { top } = TARGETS[t.def.kind];
      // The bullseye (32 px up the paper), near the top of the board, its middle, and a hand's width over its top.
      for (const up of [32, top - 8, top / 2, top + 24]) shoot(t, standY, rttMs, up);
    }
  }
  assert.ok(through >= 40 && clear >= 8, `enough shots judged: ${through} through a board, ${clear} clear of one`);
  // What a round meets of each kind covers its drawn board, from the base plate to the top.
  for (const kind of ['paper', 'plank', 'rail', 'dummy'] as const) {
    const b = targetBody(kind, { x: 0, y: 0 });
    assert.ok(b.y + b.r >= 5 && b.y - b.up - b.r <= -BOARD[kind].top + 0.01, `${kind}: ${JSON.stringify(b)}`);
  }
});

test('a rewound round flies its firing tick once: it is never judged a tick ahead of the world the shooter saw', () => {
  // A body crossing the line at 260 px/s: judged a tick early it stands 8 px off where the shooter saw the round meet it.
  const { w, shooter, victim, seen, tick } = duel('sniper', 600);
  for (let k = 0; k < 30; k++) tick();
  const viewAt = w.now + TICK_MS - 250;
  const b: Bullet = { id: 99_999, owner: shooter.id, team: null, x: shooter.x + MUZZLE_PX, y: shooter.y, vx: 2000, vy: 0, left: 1000, damage: 1, piercing: false, label: 'Test', gun: null, turret: null, lobbed: false, penetrate: 0, passed: [], blast: null, volley: 1 };
  step(w, TICK_MS);
  seen.note(w.now, victim);
  flyThroughPast(w, b, w.now - viewAt);
  // Flown through the past it has reached the start of this tick: its age then.
  assert.ok(Math.abs(b.x - (shooter.x + MUZZLE_PX) - 2000 * (w.now - TICK_MS - viewAt) / 1000) < 1e-6, `flown ${(b.x - shooter.x - MUZZLE_PX).toFixed(2)} px`);
});
