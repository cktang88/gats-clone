/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPointerLock, LOCK_TIMING, lockWanted, type LockContext, type LockDeps, type LockEnv } from '../src/client/pointerlock.ts';
import { clampSensitivity, clampToView, CURSOR_GUARD, guardDelta, NO_CAL, noteUnits, SENSITIVITY, stepCursor, unitOf, type StepOpts } from '../src/client/virtualcursor.ts';
import { DEFAULTS, sanitize } from '../src/client/settings.ts';

// ---- the virtual cursor ----

const opts = (o: Partial<StepOpts> = {}): StepOpts => ({ w: 1600, h: 900, sensitivity: 1, unit: 1, sinceLockMs: 10_000, ...o });

test('the cursor follows movement and stops at every edge, then slides along it', () => {
  let c = { x: 800, y: 450 };
  c = stepCursor(c, 30, -20, opts());
  assert.deepEqual(c, { x: 830, y: 430 });
  for (let i = 0; i < 40; i++) c = stepCursor(c, 100, 0, opts());
  assert.deepEqual(c, { x: 1599, y: 430 }, 'pinned to the right edge, not lost past it');
  // Pushing on into the edge while moving down slides along it: x stays pinned, y keeps going.
  c = stepCursor(c, 80, 50, opts());
  assert.deepEqual(c, { x: 1599, y: 480 });
  // One move back out leaves the edge at once: no stored overshoot to unwind.
  c = stepCursor(c, -10, 0, opts());
  assert.deepEqual(c, { x: 1589, y: 480 });
  for (let i = 0; i < 40; i++) c = stepCursor(c, -100, 0, opts());
  assert.equal(c.x, 0);
});

test('the corners hold both axes, and each axis comes back out on its own', () => {
  let c = { x: 10, y: 10 };
  for (let i = 0; i < 5; i++) c = stepCursor(c, -120, -120, opts());
  assert.deepEqual(c, { x: 0, y: 0 });
  c = stepCursor(c, -50, 5, opts());
  assert.deepEqual(c, { x: 0, y: 5 }, 'sliding down the left edge out of the corner');
  c = { x: 1590, y: 890 };
  for (let i = 0; i < 5; i++) c = stepCursor(c, 120, 120, opts());
  assert.deepEqual(c, { x: 1599, y: 899 });
  assert.deepEqual(clampToView({ x: NaN, y: Infinity }, 1600, 900), { x: 799.5, y: 449.5 }, "a non-finite point comes back to the middle");
});

test('sensitivity scales the travel and is kept to the slider range', () => {
  assert.deepEqual(stepCursor({ x: 500, y: 500 }, 10, -10, opts({ sensitivity: 2 })), { x: 520, y: 480 });
  assert.deepEqual(stepCursor({ x: 500, y: 500 }, 10, -10, opts({ sensitivity: 0.5 })), { x: 505, y: 495 });
  assert.equal(clampSensitivity(99), SENSITIVITY.max);
  assert.equal(clampSensitivity(0), SENSITIVITY.min);
  assert.equal(clampSensitivity(NaN), 1);
  assert.equal(clampSensitivity(1.234), 1.25);
  assert.equal(DEFAULTS.mouseSensitivity, 1);
  assert.equal(sanitize({ mouseSensitivity: 1.5 }).mouseSensitivity, 1.5);
  assert.equal(sanitize({ mouseSensitivity: 'fast' }).mouseSensitivity, 1);
  assert.equal(sanitize({ mouseSensitivity: 50 }).mouseSensitivity, SENSITIVITY.max);
  assert.equal(sanitize({}).mouseSensitivity, 1);
});

test('spike guard: a big jump right after the lock is dropped, and no single event flings the aim across the screen', () => {
  const at = { x: 800, y: 450 };
  // The bogus first event some browsers send (here, the distance to the screen's middle).
  assert.equal(guardDelta(-640, 300, opts({ sinceLockMs: 5 })), null);
  assert.deepEqual(stepCursor(at, -640, 300, opts({ sinceLockMs: 5 })), at);
  // Small moves in the settle window still count, so a player already moving keeps aiming.
  assert.deepEqual(stepCursor(at, 6, 4, opts({ sinceLockMs: 5 })), { x: 806, y: 454 });
  // Later, a rogue event is capped in length but keeps its direction.
  const cap = Math.max(CURSOR_GUARD.minStep, CURSOR_GUARD.maxStepShare * 900);
  const d = guardDelta(5000, 0, opts())!;
  assert.equal(d.y, 0);
  assert.ok(Math.abs(d.x - cap) < 1e-9, `capped at ${cap}`);
  // A fast but real flick under the cap passes untouched.
  assert.deepEqual(guardDelta(200, -100, opts()), { x: 200, y: -100 });
  assert.equal(guardDelta(NaN, 3, opts()), null);
  // A small window still takes a flick of minStep.
  assert.equal(guardDelta(150, 0, opts({ w: 300, h: 200 }))!.x, 150);
});

test('DPR: movement reported in device pixels is learned from unlocked moves and moves the cursor in CSS pixels', () => {
  // Until there is evidence, the spec's unit (1 movementX = 1 CSS px).
  assert.equal(unitOf(NO_CAL, 2), 1);
  let hidpi = NO_CAL, spec = NO_CAL, zoomed = NO_CAL;
  for (let i = 0; i < 12; i++) {
    hidpi = noteUnits(hidpi, 15, 5, 30, 10);
    spec = noteUnits(spec, 15, 5, 15, 5);
    zoomed = noteUnits(zoomed, 10, 0, 13, 0);
  }
  assert.equal(unitOf(hidpi, 2), 2);
  assert.equal(unitOf(spec, 2), 1);
  assert.ok(Math.abs(unitOf(zoomed, 1) - 1.3) < 1e-9, 'page zoom gives its own ratio');
  // A re-entering cursor's jump is not a sample.
  assert.deepEqual(noteUnits(NO_CAL, 900, 0, 3, 0), NO_CAL);
  // At DPR 2 with device-pixel movement, 40 units is 20 CSS px; the position never depends on the DPR itself.
  assert.deepEqual(stepCursor({ x: 100, y: 100 }, 40, -20, opts({ unit: unitOf(hidpi, 2) })), { x: 120, y: 90 });
  assert.deepEqual(stepCursor({ x: 100, y: 100 }, 40, -20, opts({ unit: unitOf(spec, 2) })), { x: 140, y: 80 });
});

// ---- the controller ----

type Ev = { type: string; fn: (e: never) => void; capture: boolean };

function harness(o: { coarse?: boolean; noApi?: boolean; refuse?: 'event' | 'promise' | 'throw' | 'silent' | null; activation?: boolean } = {}) {
  const evs: Ev[] = [];
  const on = (type: string, fn: (e: never) => void, opts?: boolean | AddEventListenerOptions) => { evs.push({ type, fn, capture: typeof opts === 'object' ? !!opts.capture : !!opts }); };
  let now = 1000;
  const timers: { at: number; fn: () => void }[] = [];
  const calls = { request: 0, exit: 0, forwarded: [] as unknown[], userExits: 0 };
  let refuse = o.refuse ?? null;
  const fire = (type: string, e: object = {}) => { for (const l of evs.filter((x) => x.type === type)) (l.fn as (e: object) => void)(e); };
  const canvas = {
    addEventListener: on,
    ...(o.noApi ? {} : {
      requestPointerLock() {
        calls.request++;
        if (refuse === 'throw') throw new Error('NotSupportedError');
        if (refuse === 'event') { queueMicrotask(() => fire('pointerlockerror')); return undefined; }
        if (refuse === 'promise') return Promise.reject(new Error('SecurityError'));
        if (refuse === 'silent') return undefined;
        doc.pointerLockElement = canvas;
        fire('pointerlockchange');
        return Promise.resolve();
      },
    }),
  };
  const button = { id: 'perk-tile' };
  const doc = {
    pointerLockElement: null as unknown,
    focused: true,
    hidden: false,
    under: canvas as unknown,
    addEventListener: on,
    hasFocus() { return this.focused; },
    exitPointerLock() { calls.exit++; doc.pointerLockElement = null; fire('pointerlockchange'); },
    elementFromPoint() { return this.under; },
  };
  const ctx: LockContext & { inMatch: boolean } = { phase: 'playing', touch: !!o.coarse, typing: false, paused: false, rangeOpen: false, inMatch: true };
  const deps: LockDeps = {
    inMatch: () => ctx.phase === 'playing' || ctx.phase === 'dead',
    want: () => lockWanted(ctx),
    sensitivity: () => 1,
    origin: () => ({ x: 50, y: 60 }),
    onUserExit: () => { calls.userExits++; ctx.paused = true; },
  };
  const env: LockEnv = {
    target: canvas as LockEnv['target'],
    doc: doc as unknown as LockEnv['doc'],
    win: { addEventListener: on } as LockEnv['win'],
    now: () => now,
    activation: () => o.activation,
    coarse: () => !!o.coarse,
    view: () => ({ w: 1600, h: 900, dpr: 1 }),
    setTimeout: (fn, ms) => { timers.push({ at: now + ms, fn }); return 0; },
    forward: (el) => { calls.forwarded.push(el); },
  };
  const lock = createPointerLock(env, deps);
  let stopped = 0;
  const down = (x: number, y: number, extra: Partial<{ target: unknown; isTrusted: boolean; pointerType: string; button: number }> = {}) => {
    fire('pointerdown', { pointerType: extra.pointerType ?? 'mouse' });
    const e = { clientX: x, clientY: y, button: extra.button ?? 0, target: extra.target ?? canvas, isTrusted: extra.isTrusted ?? true, preventDefault() {}, stopImmediatePropagation() { stopped++; } };
    fire('mousedown', e);
  };
  return {
    lock, ctx, calls, doc, canvas, button, down,
    stopped: () => stopped,
    setRefuse: (r: typeof refuse) => { refuse = r; },
    tick: (ms: number) => { now += ms; for (const t of timers.splice(0)) if (t.at <= now) t.fn(); else timers.push(t); },
    esc: () => { doc.pointerLockElement = null; fire('pointerlockchange'); },
    listensCapture: (type: string) => evs.some((e) => e.type === type && e.capture),
  };
}

test('a desktop click into a live match takes the lock, and the cursor starts where the click was', () => {
  const h = harness();
  assert.ok(h.listensCapture('mousedown'), 'sees the click before the game handlers do');
  h.down(321, 222);
  assert.equal(h.calls.request, 1);
  assert.equal(h.lock.locked(), true);
  assert.equal(h.stopped(), 0, 'the click still reaches the game and fires');
  assert.deepEqual(h.lock.move({ clientX: 321, clientY: 222, movementX: 0, movementY: 0 }), { x: 321, y: 222 });
  // Locked, clientX freezes and only movement counts; the cursor slides along the bottom edge.
  h.tick(500);
  let p = h.lock.move({ clientX: 321, clientY: 222, movementX: 10, movementY: 300 });
  assert.equal(p.x, 331);
  p = h.lock.move({ clientX: 321, clientY: 222, movementX: 10, movementY: 300 });
  p = h.lock.move({ clientX: 321, clientY: 222, movementX: 10, movementY: 300 });
  assert.deepEqual(p, { x: 351, y: 899 });
});

test('no lock from a click outside a live match, off the canvas, or synthetic', () => {
  for (const phase of ['menu', 'dead', 'reconnecting']) {
    const h = harness();
    h.ctx.phase = phase;
    h.down(10, 10);
    assert.equal(h.calls.request, 0, phase);
  }
  const h = harness();
  h.down(10, 10, { target: h.button });
  h.down(10, 10, { isTrusted: false });
  assert.equal(h.calls.request, 0);
  h.ctx.paused = true;
  h.down(10, 10);
  assert.equal(h.calls.request, 0);
});

test('touch never asks: not on a coarse screen, and not for a touch tap on a desktop', () => {
  const phone = harness({ coarse: true });
  phone.down(100, 100, { pointerType: 'touch' });
  phone.down(100, 100);
  phone.lock.sync();
  assert.equal(phone.calls.request, 0);
  assert.equal(lockWanted({ phase: 'playing', touch: true, typing: false, paused: false, rangeOpen: false }), false);
  const hybrid = harness();
  hybrid.down(100, 100, { pointerType: 'touch' });
  assert.equal(hybrid.calls.request, 0);
  hybrid.down(100, 100, { pointerType: 'pen' });
  assert.equal(hybrid.calls.request, 0);
});

test('chat, the pause menu, the range panel, the death card and the menu each let the lock go; it comes back when they close', () => {
  for (const [key, open, shut] of [
    ['typing', true, false], ['paused', true, false], ['rangeOpen', true, false], ['phase', 'dead', 'playing'],
  ] as const) {
    const h = harness();
    h.down(100, 100);
    assert.equal(h.lock.locked(), true);
    (h.ctx as Record<string, unknown>)[key] = open;
    h.lock.sync();
    assert.equal(h.lock.locked(), false, `${key} releases`);
    assert.equal(h.calls.userExits, 0, 'our own release does not open the pause menu');
    (h.ctx as Record<string, unknown>)[key] = shut;
    h.lock.sync();
    assert.equal(h.lock.locked(), true, `${key} closed: the lock is back without a click`);
  }
  // Leaving to the menu forgets it: the next match waits for its own first click.
  const h = harness();
  h.down(100, 100);
  h.ctx.phase = 'menu';
  h.lock.sync();
  assert.equal(h.lock.locked(), false);
  h.ctx.phase = 'playing';
  h.lock.sync();
  assert.equal(h.lock.locked(), false);
  assert.equal(h.calls.request, 1);
});

test('Esc: the browser drops the lock, the pause menu opens, and its own Esc key does not close it again', () => {
  const h = harness();
  h.down(100, 100);
  h.lock.move({ clientX: 100, clientY: 100, movementX: 40, movementY: 0 });
  h.esc();
  assert.equal(h.calls.userExits, 1);
  assert.equal(h.ctx.paused, true);
  assert.equal(h.lock.escapeSpent(1000 + 50), true, 'an Escape keydown right behind the release is spent');
  assert.equal(h.lock.escapeSpent(1000 + LOCK_TIMING.escWindowMs + 1), false);
  // Closing the menu by key (no click) does not grab the mouse back: the player gets a click in first.
  h.ctx.paused = false;
  h.lock.sync();
  assert.equal(h.lock.locked(), false);
  // A click back into the game takes it again, starting at the real cursor.
  h.tick(2000);
  h.lock.move({ clientX: 700, clientY: 300, movementX: 3, movementY: 0 });
  h.down(700, 300);
  assert.equal(h.lock.locked(), true);
  assert.deepEqual(h.lock.probe().cursor, { x: 700, y: 300 });
});

test('Resume re-locks; too soon after Esc the refusal is retried once the wait is over', () => {
  const h = harness();
  h.down(100, 100);
  h.esc();
  h.lock.move({ clientX: 640, clientY: 360, movementX: 1, movementY: 1 });
  h.ctx.paused = false;
  h.setRefuse('promise');
  h.tick(200);
  h.lock.resume();
  assert.equal(h.calls.request, 2);
  return Promise.resolve().then(() => {
    assert.equal(h.lock.locked(), false);
    assert.equal(h.lock.probe().disabled, false, 'a cool-down refusal is not a failure');
    h.setRefuse(null);
    h.tick(LOCK_TIMING.cooldownMs);
    assert.equal(h.lock.locked(), true, 'the scheduled retry took it');
    assert.deepEqual(h.lock.probe().cursor, { x: 640, y: 360 }, 'starting where the real cursor was');
  });
});

test('a lost focus (alt-tab) drops the lock without pausing', () => {
  const h = harness();
  h.down(100, 100);
  h.doc.focused = false;
  h.esc();
  assert.equal(h.calls.userExits, 0);
  assert.equal(h.ctx.paused, false);
});

test('while locked a click over a DOM control goes to that control, not the gun', () => {
  const h = harness();
  h.down(100, 100);
  h.doc.under = h.button;
  h.down(100, 100);
  assert.deepEqual(h.calls.forwarded, [h.button]);
  assert.equal(h.stopped(), 1);
  h.doc.under = h.canvas;
  h.down(100, 100);
  assert.equal(h.stopped(), 1, 'over the game the click fires as usual');
});

test('every refusal is quiet and aim falls back to the real cursor; repeated refusals stop the asking', async () => {
  for (const refuse of ['event', 'promise', 'throw'] as const) {
    const h = harness({ refuse });
    for (let i = 0; i < 5; i++) { h.down(10 * i, 10); await Promise.resolve(); await Promise.resolve(); h.tick(10); }
    assert.equal(h.lock.locked(), false, refuse);
    assert.equal(h.calls.request, LOCK_TIMING.maxFailures, `${refuse}: gives up after ${LOCK_TIMING.maxFailures}`);
    assert.deepEqual(h.lock.move({ clientX: 333, clientY: 444, movementX: 9, movementY: 9 }), { x: 333, y: 444 });
  }
  // Safari answering with nothing: one request at a time, and a new click may ask again once it has gone stale.
  const s = harness({ refuse: 'silent' });
  s.down(1, 1); s.down(2, 2);
  assert.equal(s.calls.request, 1);
  s.tick(LOCK_TIMING.pendingMs + 1);
  s.down(3, 3);
  assert.equal(s.calls.request, 2);
  // No API at all (an old browser): nothing is asked and nothing breaks.
  const none = harness({ noApi: true });
  none.down(5, 5);
  none.lock.sync();
  assert.equal(none.lock.locked(), false);
  assert.deepEqual(none.lock.move({ clientX: 5, clientY: 6 }), { x: 5, y: 6 });
});
