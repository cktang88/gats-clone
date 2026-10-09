/**
 * Bringing the gun up after a sprint, as the player sees it. The sim lets the gun fire the moment a sprint ends, but wild: its spread opens to
 * the post-sprint bloom and eases back over the gun's settle, which the reticle shows on its own (it draws the eased spread, see fire.ts
 * `spreadOf`). This module shows the gun on the soldier: it drops into the carry across the chest while sprinting and swings back up to the
 * aim in a short, purely cosmetic `swingMsOf`. A bolt-action's reticle greys while the bolt is worked after each shot (`cycling`), at its
 * true (bloomed) gap, and snaps bright the moment the next round is chambered; a click made too early for the bolt gives a soft "not yet" shake.
 */
import { GUNS, PRESS_BUFFER_MS, settleRulesOf, type GunId } from '../shared/defs.ts';
import { boltLeftOf, type Firing } from './fire.ts';

/* --------------------------------------------------------------- the body ------------------------------------------------------------ */

/** How fast the gun drops into the sprint carry (ms for the whole way), the overshoot past the aim once it is up, and the swing back up (ms, see `swingMsOf`). */
export const CARRY = { downMs: 140, overshoot: 0.16, overshootMs: 140, lift: 0.12, liftK: 0.2, ease: 1.5, swingMinMs: 150, swingMaxMs: 300 } as const;

/** How long the gun's swing from the carry back up to the aim takes on the soldier (cosmetic: it can fire all along): a light gun flicks up, a heavy one swings. */
export const swingMsOf = (gun: GunId): number => Math.round(Math.min(CARRY.swingMaxMs, Math.max(CARRY.swingMinMs, 120 + settleRulesOf(GUNS[gun]).ms * 0.07)));

/**
 * The carry pose `sinceEnd` ms after a sprint ended, the gun having been `from` (0..1) of the way into the carry: 1 is
 * fully across the chest, 0 on the aim, and a little below 0 swung just past it. It lifts off the chest a touch first,
 * then swings up faster and faster so it lands on the aim after `swingMs`, overshoots and settles.
 */
export function carryAt(sinceEnd: number, swingMs: number, from: number): number {
  if (sinceEnd < 0) return from;
  if (sinceEnd < swingMs) {
    const k = sinceEnd / swingMs;
    if (k < CARRY.liftK) return from * (1 - CARRY.lift * (k / CARRY.liftK));
    const t = (k - CARRY.liftK) / (1 - CARRY.liftK);
    return from * (1 - CARRY.lift) * (1 - t ** CARRY.ease);
  }
  const u = (sinceEnd - swingMs) / CARRY.overshootMs;
  if (u >= 1) return 0;
  return -CARRY.overshoot * from * Math.sin(Math.PI * Math.min(1, u * 1.6)) * (1 - u);
}

type Track = { sprint: boolean; amount: number; t: number; endAt: number; from: number };
const tracks = new Map<number, Track>();
let prunedAt = 0;

/**
 * Each body's carry this frame: the gun drops into the carry quickly while it sprints, and swings back up over its gun's
 * `swingMs` from the moment the sprint ends (see `carryAt`). `reduced` (reduced motion) skips the overshoot and the easing.
 */
export function stepCarry(id: number, sprinting: boolean, swingMs: number, now: number, reduced: boolean): number {
  const prev = tracks.get(id);
  let tr: Track;
  if (!prev) tr = { sprint: sprinting, amount: sprinting ? 1 : 0, t: now, endAt: -Infinity, from: 0 };
  else if (sprinting) {
    const dt = Math.min(100, Math.max(0, now - prev.t));
    tr = { ...prev, sprint: true, amount: reduced ? 1 : Math.min(1, (prev.sprint ? prev.amount : Math.max(0, prev.amount)) + dt / CARRY.downMs), t: now };
  } else {
    const ended = prev.sprint;
    const endAt = ended ? now : prev.endAt;
    const from = ended ? prev.amount : prev.from;
    const since = now - endAt;
    const amount = reduced ? (since < swingMs ? from : 0) : carryAt(since, swingMs, from);
    tr = { sprint: false, amount, t: now, endAt, from };
  }
  tracks.set(id, tr);
  if (now - prunedAt > 5000) {
    prunedAt = now;
    for (const [k, v] of tracks) if (now - v.t > 5000) tracks.delete(k);
  }
  return tr.amount;
}

/* ------------------------------------------------------------- the reticle ----------------------------------------------------------- */

export type GunPhase = 'cycling' | 'ready';

/** Your gun's state as of the newest input sent: working the bolt (at the page clock `now`, if given) or ready. A sprint is no phase: the reticle just draws its bloom. */
export const gunPhaseOf = (f: Firing, now?: number): GunPhase => (now !== undefined && boltLeftOf(f, now) > 0 ? 'cycling' : 'ready');

/** A worked bolt's reticle is this faint; once chambered its dot pops in over `snapMs` with a flash; a click too early for the bolt shakes it. */
export const RETICLE_BOLT = { lowAlpha: 0.55, snapMs: 160, flashMs: 220, shakeMs: 240, shakePx: 4 } as const;

export type ReticleLook = {
  /** The gap from the centre to each arm, px. */
  gap: number;
  alpha: number;
  /** Drawn grey instead of in the crosshair's own colour (the bolt is being worked). */
  grey: boolean;
  /** The centre dot (none while the bolt is worked; it pops in once chambered). */
  dot: number;
  /** 0..1, a white flash over the arms as the round chambers. */
  flash: number;
  /** Sideways jolt, px, after a click the bolt was not ready for. */
  shake: number;
};

const easeOutBack = (u: number) => { const c = 1.9; return 1 + (c + 1) * (u - 1) ** 3 + c * (u - 1) ** 2; };

/**
 * How the reticle is drawn for the gun's `phase`, `gap` being the eased spread's own gap (wide off a sprint, tightening as it settles: the
 * reticle is how you read the post-sprint bloom). While a bolt is worked (`cycling`) it is grey, faint and dotless at its own gap, so the
 * bloom of the shot just fired shows; `sinceReady` ms after the round chambers it flashes and pops its dot; `sinceDenied` ms after a click
 * the bolt was not ready for, it shakes.
 */
export function reticleLook(phase: GunPhase, gap: number, sinceReady: number, sinceDenied: number): ReticleLook {
  const shakeK = sinceDenied >= 0 && sinceDenied < RETICLE_BOLT.shakeMs ? sinceDenied / RETICLE_BOLT.shakeMs : 1;
  const shake = shakeK < 1 ? Math.sin(shakeK * Math.PI * 5) * RETICLE_BOLT.shakePx * (1 - shakeK) : 0;
  if (phase === 'cycling') return { gap, alpha: RETICLE_BOLT.lowAlpha, grey: true, dot: 0, flash: 0, shake };
  if (sinceReady < 0 || sinceReady >= RETICLE_BOLT.flashMs) return { gap, alpha: 1, grey: false, dot: 1, flash: 0, shake };
  const u = Math.min(1, sinceReady / RETICLE_BOLT.snapMs);
  const e = easeOutBack(u);
  return {
    gap, alpha: RETICLE_BOLT.lowAlpha + (1 - RETICLE_BOLT.lowAlpha) * Math.min(1, u * 2), grey: false,
    dot: Math.min(1.6, e * 1.3), flash: 1 - sinceReady / RETICLE_BOLT.flashMs, shake,
  };
}

/** Tracks your gun's phase frame to frame: when the bolt last chambered (for the flash) and when a click last came too early for it. */
export function createRaiseWatch() {
  let phase: GunPhase = 'ready';
  let readyAt = -Infinity;
  let deniedAt = -Infinity;
  return {
    /** Steps to this frame's phase. */
    step(f: Firing | null, now: number): void {
      const next = f && f.trigger.alive ? gunPhaseOf(f, now) : 'ready';
      if (next === 'ready' && phase === 'cycling') readyAt = now;
      if (next !== 'ready') readyAt = -Infinity;
      phase = next;
    },
    /** A click was made: true (and noted, for the shake) when the bolt is too far from home to keep it, so it fires nothing. A sprint never refuses a click. */
    click(f: Firing | null, now: number): boolean {
      const down = !!f && f.trigger.alive && f.trigger.armed && !f.trigger.sprint && boltLeftOf(f, now) > PRESS_BUFFER_MS;
      if (down) deniedAt = now;
      return down;
    },
    get phase() { return phase; },
    sinceReady: (now: number) => now - readyAt,
    sinceDenied: (now: number) => now - deniedAt,
  };
}

/** The one watch for your own gun, shared by the HUD (which draws and steps it) and the page (which reports clicks). */
export const raiseWatch = createRaiseWatch();
