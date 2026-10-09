import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUNS, WORLD } from '../src/shared/defs.ts';
import { VIEW_PRELOAD_MARGIN, viewExtents } from '../src/shared/protocol.ts';
import { holdLook, LOOK_AHEAD, lookReach, lookSides, NO_LOOK } from '../src/shared/lookahead.ts';
import { interestLook, snapshotFor } from '../src/shared/sim/snapshot.ts';
import { effectiveStats } from '../src/shared/sim/stats.ts';
import { boundLean, cursorPush, followLook, lookAhead, makeCamera, NO_LOOKCAM, screenToWorld, visibleHalf, worldToScreen, type LookCam } from '../src/client/camera.ts';
import { viewMulFor } from '../src/shared/sim/stats.ts';
import { DEFAULTS, lookAheadFactor, sanitize } from '../src/client/settings.ts';
import { emptyWorld, spawnAt } from './helpers.ts';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

test('look-ahead: no lean at the middle, the full reach at the edge, clamped past it, eased in between', () => {
  const w = 1600, h = 900;
  assert.equal(cursorPush({ x: w / 2, y: h / 2 }, w, h), 0);
  const full = (h / 2) * LOOK_AHEAD.fullAt;
  assert.ok(near(cursorPush({ x: w / 2 + (w / 2) * LOOK_AHEAD.fullAt, y: h / 2 }, w, h), 1), 'full at fullAt of the way to the side edge');
  assert.ok(near(cursorPush({ x: w / 2 + full, y: h / 2 }, w, h), full / (w / 2) / LOOK_AHEAD.fullAt), 'measured against the half width sideways');
  for (const [cw, ch] of [[1600, 900], [2560, 1080], [844, 390], [390, 844]]) {
    for (const edge of [{ x: cw - 1, y: ch / 2 }, { x: 1, y: ch / 2 }, { x: cw / 2, y: 1 }, { x: cw / 2, y: ch - 1 }]) assert.equal(cursorPush(edge, cw, ch), 1, `${cw}x${ch}: a cursor at any edge is a full push`);
  }
  assert.equal(cursorPush({ x: w, y: 0 }, w, h), 1, 'a corner is clamped to a full push');
  assert.ok(near(cursorPush({ x: w / 2, y: h / 2 + full / 2 }, w, h), 0.5));
  assert.equal(cursorPush({ x: 3, y: 3 }, 0, 0), 0, 'no screen, no push');
  assert.deepEqual(lookAhead({ x: 3, y: 0 }, 0, 100), { x: 0, y: 0 });
  assert.deepEqual(lookAhead({ x: 0, y: 0 }, 1, 100), { x: 0, y: 0 }, 'no aim, no lean');
  const at1 = lookAhead({ x: 0, y: -5 }, 1, 100);
  assert.ok(near(at1.x, 0) && near(at1.y, -100), 'a full push leans the whole reach, along the aim');
  assert.ok(near(Math.hypot(...Object.values(lookAhead({ x: 3, y: 4 }, 7, 100)) as [number, number]), 100), 'a push past 1 is clamped');
  const half = lookAhead({ x: 1, y: 0 }, 0.5, 100);
  assert.ok(near(half.x, 100 * 0.5 ** LOOK_AHEAD.ease) && half.x < 50, 'eased: half a push leans less than half the reach');
  const diag = lookAhead({ x: 1, y: 1 }, 1, 100);
  assert.ok(near(Math.atan2(diag.y, diag.x), Math.PI / 4), 'the lean points exactly along the aim');
  assert.deepEqual(lookAhead({ x: 1, y: 0 }, NaN, 100), { x: 0, y: 0 });
});

test('look-ahead reach scales with the view and the gun: a scope leans furthest, a shotgun or an SMG least', () => {
  const R = WORLD.viewRadius;
  // Pinned: about 2.5x the first port's shares (pistol 0.13, SMG 0.11, shotgun 0.1, assault and LMG 0.14, sniper 0.19), which read as too subtle.
  assert.deepEqual({ ...LOOK_AHEAD.share }, { pistol: 0.32, smg: 0.28, shotgun: 0.26, assault: 0.36, sniper: 0.5, lmg: 0.34 });
  assert.equal(LOOK_AHEAD.maxShare, 0.6);
  const old = { pistol: 101, smg: 86, shotgun: 78, assault: 109, lmg: 109, sniper: 202 } as const;
  for (const [id, was] of Object.entries(old) as [keyof typeof old, number][]) {
    const reach = lookReach(R * viewMulFor(id, {}), id);
    assert.ok(reach >= 2.3 * was && reach <= 2.7 * was, `${id} leans ${reach.toFixed(0)} px, about 2.5x its old ${was}`);
  }
  const assault = lookReach(R, 'assault');
  assert.ok(near(assault, 0.36 * R) && near(lookReach(R * viewMulFor('sniper', {}), 'sniper'), 0.5 * R * viewMulFor('sniper', {})));
  assert.ok(lookReach(R, 'sniper') > assault && lookReach(R, 'smg') < assault && lookReach(R, 'shotgun') < assault);
  for (const id of ['pistol', 'smg', 'shotgun', 'assault', 'lmg'] as const) {
    assert.ok(lookReach(R * viewMulFor('sniper', {}), 'sniper') > lookReach(R * viewMulFor(id, {}), id), `a scoped sniper leans further than a ${id}`);
  }
  assert.ok(R * 1.35 + lookReach(R * 1.35, 'sniper') > R + lookReach(R, 'sniper'), 'a wider view sees further down the aim');
  assert.ok(lookReach(R * 1.35, 'smg') > lookReach(R, 'smg'), 'and a class share leans further with it');
  for (const id of Object.keys(GUNS) as (keyof typeof GUNS)[]) {
    const reach = lookReach(R, id);
    assert.ok(reach <= LOOK_AHEAD.maxShare * R + 1e-9, `${id} never leans past ${LOOK_AHEAD.maxShare} of the view`);
    assert.ok(R + reach >= Math.min(GUNS[id].range, R * (1 + LOOK_AHEAD.maxShare)) - 1e-9, `${id}'s full lean shows its range down the aim`);
  }
  for (const id of Object.keys(GUNS) as (keyof typeof GUNS)[]) assert.ok(lookReach(R, id) > 0, id);
});

test('look-ahead bound: your own soldier stays at least a fifth of the screen from every edge, on every screen, gun and aim', () => {
  const screens = { '16:9': [1600, 900], '21:9': [2560, 1080], '32:9': [3840, 1080], 'phone landscape': [844, 390], 'phone portrait': [390, 844], square: [1000, 1000] } as const;
  const self = { x: 3000, y: 3000 };
  for (const [name, [w, h]] of Object.entries(screens)) {
    for (const id of Object.keys(GUNS) as (keyof typeof GUNS)[]) {
      const R = WORLD.viewRadius * viewMulFor(id, {}), half = visibleHalf(w, h, R);
      for (const touch of [false, true]) {
        const edge = touch ? LOOK_AHEAD.touchEdge : LOOK_AHEAD.edge, reach = lookReach(R, id) * (touch ? LOOK_AHEAD.touch : 1);
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * Math.PI * 2;
          const lean = boundLean(lookAhead({ x: Math.cos(a), y: Math.sin(a) }, 1, reach), half, edge);
          const len = Math.hypot(lean.x, lean.y);
          assert.ok(len <= reach + 1e-9 && len > 0, `${name} ${id}: leans, never past its reach`);
          assert.ok(Math.abs(Math.atan2(Math.sin(Math.atan2(lean.y, lean.x) - a), Math.cos(Math.atan2(lean.y, lean.x) - a))) < 1e-9, 'the bound shortens the lean, never turns it');
          const at = worldToScreen(makeCamera({ x: self.x + lean.x, y: self.y + lean.y }, w, h, R), self);
          const gap = (1 - edge) / 2 - 1e-6;
          assert.ok(at.x >= gap * w && at.x <= w - gap * w && at.y >= gap * h && at.y <= h - gap * h,
            `${name} ${id}${touch ? ' (touch)' : ''} aimed at ${(a * 180 / Math.PI).toFixed(0)}: soldier drawn at ${at.x.toFixed(0)},${at.y.toFixed(0)} of ${w}x${h}`);
        }
      }
    }
  }
  // A full lean down the long side of a 16:9 screen is not cut short: an assault rifle aimed at the side edge shows its whole reach.
  const half = visibleHalf(1600, 900, WORLD.viewRadius), reach = lookReach(WORLD.viewRadius, 'assault');
  assert.ok(near(boundLean({ x: reach, y: 0 }, half).x, reach));
  assert.ok(boundLean({ x: 0, y: reach }, half).y < reach, 'up or down, the short side, is held to the bound');
  assert.deepEqual(boundLean({ x: NaN, y: 0 }, half), { x: 0, y: 0 });
  // A phone held upright crops the view's sides (cover scale): the bound uses what is actually on screen.
  const portrait = visibleHalf(390, 844, WORLD.viewRadius);
  assert.ok(portrait.halfW < WORLD.viewRadius * 0.5 && near(portrait.halfH, WORLD.viewRadius));
});

test('follow: exponential, the same after one long frame as after several short ones, and snapping on a jump or a new eye', () => {
  const eye = { x: 1000, y: 1000 }, target = { x: 120, y: -40 };
  const start: LookCam = { ...followLook(NO_LOOKCAM, eye, 'a', { x: 0, y: 0 }, 16, 6) };
  assert.deepEqual([start.x, start.y], [0, 0], 'the first frame snaps to the target');
  let fine = start;
  for (let i = 0; i < 6; i++) fine = followLook(fine, eye, 'a', target, 100 / 6, 6);
  const coarse = followLook(start, eye, 'a', target, 100, 6);
  assert.ok(near(fine.x, coarse.x, 1e-9) && near(fine.y, coarse.y, 1e-9), `30 fps ${coarse.x} vs 60 fps ${fine.x}`);
  assert.ok(near(coarse.x, 120 * (1 - Math.exp(-0.6))), 'a 100 ms step at rate 6 covers 1 - e^-0.6 of the way');
  assert.ok(near(followLook(start, eye, 'a', target, 5000, 6).x, 120, 1e-6), 'and settles');
  assert.equal(followLook(start, eye, 'a', target, -50, 6).x, 0, 'a negative step stands still');
  const jumped = followLook(start, { x: 1000 + LOOK_AHEAD.snapPx + 1, y: 1000 }, 'a', target, 16, 6);
  assert.deepEqual([jumped.x, jumped.y], [120, -40], 'a respawn or teleport snaps');
  assert.deepEqual([followLook(start, eye, 'b', target, 16, 6).x], [120], 'another eye or map snaps');
  assert.deepEqual([followLook({ ...start, snap: true }, eye, 'a', target, 16, 6).x], [120], 'a resync snaps');
  const walked = followLook(start, { x: 1010, y: 1000 }, 'a', target, 16, 6);
  assert.ok(walked.x > 0 && walked.x < 120, 'walking eases');
});

test('aim stays exact under a leaning camera: the screen point of the cursor maps back to the world point under it', () => {
  const self = { x: 2000, y: 1500 }, w = 1600, h = 900;
  for (const cursor of [{ x: 1580, y: 450 }, { x: 10, y: 890 }, { x: 800, y: 3 }, { x: 1200, y: 600 }]) {
    let cam = makeCamera(self, w, h, WORLD.viewRadius), lean = { x: 0, y: 0 };
    // Run the page's loop: aim from where the soldier is drawn, lean along it, rebuild the camera, until it settles.
    for (let i = 0; i < 60; i++) {
      const at = worldToScreen(cam, self);
      const aim = { x: (cursor.x - at.x) / cam.scale, y: (cursor.y - at.y) / cam.scale };
      const want = boundLean(lookAhead(aim, cursorPush(cursor, w, h), lookReach(WORLD.viewRadius, 'sniper')), visibleHalf(w, h, WORLD.viewRadius));
      lean = { x: lean.x + (want.x - lean.x) * 0.3, y: lean.y + (want.y - lean.y) * 0.3 };
      cam = makeCamera({ x: self.x + lean.x, y: self.y + lean.y }, w, h, WORLD.viewRadius);
    }
    assert.ok(Math.hypot(lean.x, lean.y) > 1, 'the camera leans');
    const under = screenToWorld(cam, cursor);
    const at = worldToScreen(cam, self);
    const aim = { x: (cursor.x - at.x) / cam.scale, y: (cursor.y - at.y) / cam.scale };
    assert.ok(near(self.x + aim.x, under.x, 1e-9) && near(self.y + aim.y, under.y, 1e-9), 'the aim vector ends on the world point under the cursor');
    const back = worldToScreen(cam, under);
    assert.ok(near(back.x, cursor.x, 1e-9) && near(back.y, cursor.y, 1e-9), 'and that point is drawn under the cursor');
    const angle = Math.atan2(aim.y, aim.x), leanAngle = Math.atan2(lean.y, lean.x);
    assert.ok(Math.abs(Math.atan2(Math.sin(angle - leanAngle), Math.cos(angle - leanAngle))) < 0.01, 'the lean settles along the aim angle the server gets');
  }
});

test('server interest: an enemy only the look-ahead brings on screen is sent, on the aimed side only', () => {
  const w = emptyWorld();
  const me = spawnAt(w, 3000, 3000, { loadout: { weapon: 'assault' } });
  const R = effectiveStats(me).viewRadius, reach = lookReach(R, me.gun);
  const past = R + VIEW_PRELOAD_MARGIN + WORLD.playerRadius + reach / 2;
  const right = spawnAt(w, me.x + past, me.y), left = spawnAt(w, me.x - past, me.y);
  me.angle = 0;
  const ids = (look = NO_LOOK) => new Set(snapshotFor(w, me.id, [], 16 / 9, look).players.map((p) => p.id));
  assert.ok(!ids().has(right.id) && !ids().has(left.id), 'beyond the centred view neither is sent');
  const look = interestLook(w, me);
  assert.ok(near(look.r, reach) && look.l === 0, `aiming right widens the right edge by the reach (${look.r})`);
  assert.ok(ids(look).has(right.id), 'the enemy the lean reveals is sent');
  assert.ok(!ids(look).has(left.id), 'the far side is not widened');
  me.angle = Math.PI;
  assert.ok(ids(interestLook(w, me)).has(left.id) && !ids(interestLook(w, me)).has(right.id), 'turning round swaps the sides');
  // A leaning camera never shows more than the server sends: the leaned view sits inside the widened interest.
  for (const angle of [0, 0.7, 2, -2.5, Math.PI / 2]) {
    me.angle = angle;
    const s = interestLook(w, me), v = viewExtents(R, 16 / 9);
    const lean = { x: Math.cos(angle) * reach, y: Math.sin(angle) * reach };
    assert.ok(lean.x + v.halfW <= v.halfW + s.r + 1e-9 && -lean.x + v.halfW <= v.halfW + s.l + 1e-9, `x at ${angle}`);
    assert.ok(lean.y + v.halfH <= v.halfH + s.d + 1e-9 && -lean.y + v.halfH <= v.halfH + s.u + 1e-9, `y at ${angle}`);
  }
  me.life = { ...me.life, k: 'dead' } as typeof me.life;
  assert.deepEqual(interestLook(w, me), NO_LOOK, 'no lean for the dead');
});

test('server interest: smoke still culls an enemy the look-ahead would reveal', () => {
  const w = emptyWorld();
  const me = spawnAt(w, 2000, 2000, { loadout: { weapon: 'assault' } });
  const R = effectiveStats(me).viewRadius, reach = lookReach(R, me.gun);
  const target = spawnAt(w, me.x + R + VIEW_PRELOAD_MARGIN + reach / 2, me.y);
  me.angle = 0;
  assert.ok(snapshotFor(w, me.id, [], 16 / 9, interestLook(w, me)).players.some((p) => p.id === target.id));
  w.thrown.push({ id: 900, kind: 'smokeCloud', owner: me.id, team: null, x: me.x + 400, y: me.y, vx: 0, vy: 0, bornAt: w.now - 2000, expiresAt: w.now + 8000 });
  assert.ok(!snapshotFor(w, me.id, [], 16 / 9, interestLook(w, me)).players.some((p) => p.id === target.id), 'behind smoke: not sent');
});

test('the held widening always covers a camera easing away from an old lean, at any frame and tick rate', () => {
  const reach = 150;
  let held = holdLook(null, lookSides(0, reach), 0);
  let cam = followLook(NO_LOOKCAM, { x: 0, y: 0 }, 'a', { x: reach, y: 0 }, 16, LOOK_AHEAD.rate);
  const flick = lookSides(Math.PI, reach);
  for (let t = 16; t <= 2000; t += 16) {
    cam = followLook(cam, { x: 0, y: 0 }, 'a', { x: -reach, y: 0 }, 16, LOOK_AHEAD.rate);
    // The server steps its widening once per snapshot (every 48 ms here), for the time since the last one.
    if (t % 48 === 0) held = holdLook(held, flick, 48);
    assert.ok(cam.x <= held.r + 1e-9, `at ${t} ms the camera's right lean ${cam.x.toFixed(1)} is inside the held ${held.r.toFixed(1)}`);
    assert.ok(-cam.x <= held.l + 1e-9);
  }
  assert.equal(held.r, 0, 'and the old side closes once the camera has gone');
  assert.deepEqual(holdLook(lookSides(0, 100), NO_LOOK, 1e9), NO_LOOK);
  assert.deepEqual(lookSides(NaN, 100), NO_LOOK);
});

test('the look-ahead setting: Normal by default, Low about the old subtle lean, Off removes it, junk falls back', () => {
  assert.equal(DEFAULTS.lookAhead, 'normal');
  assert.deepEqual(['off', 'low', 'normal'].map((m) => lookAheadFactor(m as 'off')), [0, 0.4, 1]);
  assert.equal(sanitize({ lookAhead: 'low' }).lookAhead, 'low');
  assert.equal(sanitize({ lookAhead: 'huge' }).lookAhead, 'normal');
});
