import { PRESS_BUFFER_MS, PRESS_GRACE_MS, rulesOf, type GunDef, type GunRules } from '../defs.ts';
import { bloomCurve } from '../handling.ts';
import type { InputState } from '../protocol.ts';
import { clamp } from './movement.ts';
import type { Life } from './world.ts';

export type TriggerState = Pick<Extract<Life, { k: 'alive' }>, 'ammo' | 'reloadUntil' | 'nextFireAt' | 'burstLeft' | 'pressUntil' | 'spray' | 'firedAt' | 'spin'>;
/** `bloomRecover` scales how fast spray bloom settles (Steady Hands). */
export type HeldGun = { def: GunDef; mag: number; reloadMs: number; armed: boolean; bloomRecover?: number };
export type Pull = Pick<InputState, 'fire' | 'reload'> & { pressed: boolean };

type Bloom = NonNullable<GunRules['bloom']>;

/**
 * The bloom of a spray, the one implementation the sim, the client's prediction and a bot's read of its own cone all go through. `spray` is
 * the spray's heat in rounds: each round fired adds one, up to `sprayCap`, and it cools at a steady rate (`coolSpray`). The share (0..1) of
 * its cap the `sprayShot`th round blooms is the gun's curve (handling.ts `bloomCurve`) at the rounds past its first `free`: the round after
 * them adds the most and each later one less, so a held trigger bites at once and slows as it nears the cap, never past it. `build` scales
 * the heat a round adds (Steady Hands).
 */
export const bloomShare = (b: Bloom, sprayShot: number, build = 1): number => bloomCurve(build * Math.max(0, sprayShot - b.free), (b.maxMul - 1) / b.perShot, b.shape);
/** The most heat a spray holds: its free rounds and the rounds to its cap. */
export const sprayCap = (b: Bloom): number => b.free + (b.maxMul - 1) / b.perShot;
/**
 * A spray's heat `ms` later with no round fired (once `settleMs` has passed since the last): a full spray cools to nothing within `recoverMs`
 * (over `recover`, Steady Hands). Heat cools at a steady rate, so the cone comes back down the curve it climbed: slowly off the cap, then
 * quickly as it nears rest. A short burst, low on the curve where it is steep, clears in a blink; a long spray holds its width a while.
 */
export const coolSpray = (spray: number, b: Bloom, ms: number, recover = 1): number => Math.max(0, spray - (sprayCap(b) * ms * recover) / b.recoverMs);

export function consumePresses(seen: { shotsSeen: number }, shots: number): boolean {
  const pressed = shots > seen.shotsSeen;
  seen.shotsSeen = Math.max(seen.shotsSeen, shots);
  return pressed;
}

export function pullTrigger(s: TriggerState, gun: HeldGun, pull: Pull, now: number, tickMs: number): boolean {
  const { def } = gun;
  const { bloom, spinUp } = rulesOf(def);
  s.spin = spinUp ? clamp(s.spin + (pull.fire ? tickMs / spinUp.upMs : -tickMs / spinUp.downMs), 0, 1) : 0;
  const fireMs = spinUp ? def.fireMs * (1 + (spinUp.startMul - 1) * (1 - s.spin)) : def.fireMs;
  if (bloom && now - s.firedAt > bloom.settleMs) s.spray = coolSpray(s.spray, bloom, tickMs, gun.bloomRecover);
  if (s.reloadUntil !== null && now >= s.reloadUntil) { s.ammo = gun.mag; s.reloadUntil = null; }
  if (s.reloadUntil === null && (s.ammo <= 0 || (pull.reload && s.ammo < gun.mag))) {
    s.reloadUntil = now + gun.reloadMs;
    s.burstLeft = 0;
    s.spray = 0;
  }
  if (pull.pressed) {
    const cooledAt = s.burstLeft > 0 && def.burst ? s.nextFireAt + (s.burstLeft - 1) * def.burst.gapMs + fireMs : s.nextFireAt;
    const readyAt = Math.max(now, cooledAt, s.reloadUntil ?? 0);
    if (readyAt - now <= PRESS_BUFFER_MS) s.pressUntil = readyAt + PRESS_GRACE_MS;
  }
  // A lowered gun (a sprint, the round over) drops the rest of a burst, so it never fires on its own once the gun is back up.
  if (!gun.armed) s.burstLeft = 0;
  const bursting = s.burstLeft > 0;
  const wantsShot = bursting || now <= s.pressUntil || (def.auto && pull.fire);
  if (!gun.armed || !wantsShot || s.reloadUntil !== null || s.ammo <= 0 || now < s.nextFireAt) return false;
  if (!bursting) {
    s.pressUntil = -Infinity;
    s.burstLeft = def.burst?.count ?? 1;
  }
  s.ammo--;
  s.burstLeft = s.ammo > 0 ? s.burstLeft - 1 : 0;
  if (bloom) s.spray = Math.min(sprayCap(bloom), s.spray + 1);
  s.firedAt = now;
  const keepsGunRate = now - s.nextFireAt < tickMs;
  s.nextFireAt = (keepsGunRate ? s.nextFireAt : now) + (s.burstLeft > 0 && def.burst ? def.burst.gapMs : fireMs);
  return true;
}
