import { WORLD } from '../defs.ts';

/**
 * A gun round leaves the muzzle at `1 + boost` times its gun's `bulletSpeed` (`boost` is its class's `muzzleBoost`, `MUZZLE.boost` for most) and eases down to that cruise speed, the
 * extra fading by e every `fadePx` it flies. Up close it lands near instantly; at range it is slow enough to read and sidestep.
 * Speed against distance flown is `c * (1 + boost * e^(-d / fadePx))`, which integrates in closed form, so the server's
 * ticks and the client's drawn rounds put a round in the same place at the same age.
 */
export const MUZZLE = { boost: 4, fadePx: 150 } as const;

const { fadePx: F } = MUZZLE;

/** How far a round with cruise speed `cruise` (px/s) and muzzle `boost` has flown `sec` seconds after leaving the muzzle having already flown `from` px. */
export const flownAfter = (cruise: number, sec: number, from = 0, boost: number = MUZZLE.boost): number =>
  F * Math.log((Math.exp(from / F) + boost) * Math.exp((cruise * sec) / F) - boost);

/** How fast a round with cruise speed `cruise` and muzzle `boost` is flying once it has flown `d` px. */
export const speedAt = (cruise: number, d: number, boost: number = MUZZLE.boost): number => cruise * (1 + boost * Math.exp(-d / F));

/** Seconds a round with cruise speed `cruise` and muzzle `boost` takes to fly `d` px from the muzzle. */
export const flightSec = (cruise: number, d: number, boost: number = MUZZLE.boost): number => (F / cruise) * Math.log((Math.exp(d / F) + boost) / (1 + boost));

/** How far out of the body a round starts. */
export const MUZZLE_PX = WORLD.playerRadius + 4;

type Point = { x: number; y: number };

/**
 * Where to aim so a round fired from `from` meets a target moving at (vx, vy): the round's flight time depends on how far the
 * meeting point is, and the meeting point on the flight time, so a few rounds of refinement settle it. Rounds leave from
 * `muzzle` px out, and `leadMul` scales the lead as the shooter judges it.
 */
export function intercept(from: Point, e: Point & { vx: number; vy: number }, cruise: number, boost: number, muzzle: number, leadMul = 1): Point & { sec: number } {
  let at: Point = e, sec = 0;
  for (let i = 0; i < 4; i++) {
    sec = flightSec(cruise, Math.max(0, Math.hypot(at.x - from.x, at.y - from.y) - muzzle), boost) * leadMul;
    at = { x: e.x + e.vx * sec, y: e.y + e.vy * sec };
  }
  return { ...at, sec };
}

/**
 * Where in its spread (0..1, 0.5 dead on) pellet `pellet` of shot `n` by player `owner` flies: a hash of the three, not a draw
 * from the world's stream, so the page that drew the shot ahead of the server draws the very round the server flies.
 */
export function spreadPick(owner: number, n: number, pellet: number): number {
  let h = Math.imul(owner + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(n + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(pellet + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
