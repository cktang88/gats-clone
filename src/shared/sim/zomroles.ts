import { HORDE_GUN_MUL, KNOCK, ZOMBIES, zombieRole, type GunId } from '../defs.ts';
import type { Zombie } from './world.ts';

/**
 * Zombies only (see `ZombieRole` in defs.ts): how a player's gun treats the horde. Every caller is a path a round, blast or kill against a zombie takes,
 * so nothing here can reach a player or a versus room.
 */

/**
 * What a round of `damage` from `gun` does to `z`: its plate (the share of it the gun's role leaves on, none for an armor-piercing round), then, for a player's
 * gun, `HORDE_GUN_MUL` and the role's multiplier for the kind. A turret's round (no gun) loses only the plate.
 */
export function roundOnZombie(z: Zombie, gun: GunId | null, damage: number, piercing: boolean): number {
  const role = gun ? zombieRole(gun) : null;
  const plate = piercing ? 0 : ZOMBIES[z.kind].plate * (role?.plate ?? 1);
  const harm = Math.max(1, damage - plate) * (role ? HORDE_GUN_MUL * (role.vs[z.kind] ?? 1) : 1);
  // A bolt-action's round kills a walker or a runner outright, whatever the night or the range (`ZombieRole.oneShot`).
  return role?.oneShot.includes(z.kind) ? Math.max(harm, z.hp) : harm;
}

/** What a blast of `damage` from `gun` does to `z`: `HORDE_GUN_MUL`, the role's blast multiplier, and the share of it plating lets through. */
export function blastOnZombie(z: Zombie, gun: GunId | null, damage: number): number {
  if (!gun) return damage;
  const role = zombieRole(gun);
  return damage * HORDE_GUN_MUL * role.blast * (ZOMBIES[z.kind].plate > 0 ? role.blastPlated : 1);
}

/**
 * A hit from `gun` holds `z` to its role's share of its pace for a while; a stronger hold, or a longer one as strong, replaces the one it has.
 * What no shove moves (brutes and the Colossus, `KNOCK.zombie`) no hold slows either.
 */
export function holdZombie(z: Zombie, gun: GunId | null, now: number) {
  const slow = gun ? zombieRole(gun).slow : null;
  if (!slow || KNOCK.zombie[z.kind] <= 0) return;
  const cur = z.slow && z.slow.until > now ? z.slow : null;
  if (cur && cur.mul < slow.mul) return;
  z.slow = { mul: slow.mul, until: Math.max(now + slow.ms, cur && cur.mul === slow.mul ? cur.until : 0) };
}

/** The share of its pace a zombie keeps now: a hold's, or all of it. */
export const paceOf = (z: Zombie, now: number): number => (z.slow && z.slow.until > now ? z.slow.mul : 1);

/** How many zombies a round from `gun` passes through before the gun's own `penetrate` starts to count down. */
export const zombiePierce = (gun: GunId | null): number => (gun ? zombieRole(gun).pierce : 0);

/** Scales the shove a hit from `gun` gives a zombie. */
export const zombieShove = (gun: GunId | null): number => (gun ? zombieRole(gun).shove : 1);
