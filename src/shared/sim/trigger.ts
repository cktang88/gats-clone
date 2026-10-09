import { PRESS_BUFFER_MS, PRESS_GRACE_MS, rulesOf, type GunDef } from '../defs.ts';
import type { InputState } from '../protocol.ts';
import { clamp } from './movement.ts';
import type { Life } from './world.ts';

export type TriggerState = Pick<Extract<Life, { k: 'alive' }>, 'ammo' | 'reloadUntil' | 'nextFireAt' | 'burstLeft' | 'pressUntil' | 'spray' | 'firedAt' | 'spin'>;
/** `bloomRecover` scales how fast spray bloom settles (Steady Hands). */
export type HeldGun = { def: GunDef; mag: number; reloadMs: number; armed: boolean; bloomRecover?: number };
export type Pull = Pick<InputState, 'fire' | 'reload'> & { pressed: boolean };

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
  const maxSpray = bloom ? bloom.free + (bloom.maxMul - 1) / bloom.perShot : 0;
  if (bloom && now - s.firedAt > bloom.settleMs) s.spray = Math.max(0, s.spray - (maxSpray * tickMs * (gun.bloomRecover ?? 1)) / bloom.recoverMs);
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
  if (bloom) s.spray = Math.min(maxSpray, s.spray + 1);
  s.firedAt = now;
  const keepsGunRate = now - s.nextFireAt < tickMs;
  s.nextFireAt = (keepsGunRate ? s.nextFireAt : now) + (s.burstLeft > 0 && def.burst ? def.burst.gapMs : fireMs);
  return true;
}
