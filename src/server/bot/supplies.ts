import { PROP_FX, PROP_KINDS, PROPS, WORLD } from '../../shared/defs.ts';
import type { Snapshot } from '../../shared/protocol.ts';
import { dist, type Point } from './nav.ts';

/**
 * Supplies as a bot sees them: a pack on the floor it needs (it walks over it, as a person does, and the sim hands it over), or a standing
 * cabinet of the kind it needs (it walks up to its near face and presses E, the same `use` a person's key sends). Only with nobody to fight:
 * a bot never breaks off a fight for a pack. A hurt bot wants a health pack, a bot with half a magazine or its ability cooling an ammo pack.
 */
export type Supply = { id: number; at: Point; open: boolean };

/** How far a bot goes out of its way for a supply. */
export const SUPPLY_PX = 650;
/** Below this share of its health a bot wants a health pack. */
const HURT = 0.75;
/** An ability cooling at least this much longer (ms) is worth a walk to an ammo crate. */
const ABILITY_WAIT_MS = 6000;
/** A bot stands this far off a cabinet's centre to open it: its body against the face, well inside the E reach. */
const STAND_OFF = (side: 'medic' | 'ammo') => PROPS[side].size / 2 + WORLD.playerRadius + 12;

/** The supply `me` should fetch now, or null. `open` says whether a spot is walkable ground (the bot's nav grid). */
export function supplyFor(snap: Snapshot, me: Point & { hp: number; maxHp: number }, open: (p: Point) => boolean): Supply | null {
  const wantsHp = me.hp < me.maxHp * HURT;
  // Half a magazine, or an ability a long way off (a short cooldown is not worth the walk).
  const wantsAmmo = snap.self.ammo <= snap.self.mag / 2 || (snap.self.ability !== null && snap.self.abilityReadyIn > ABILITY_WAIT_MS);
  if (!wantsHp && !wantsAmmo) return null;
  let best: Supply | null = null, bestD = SUPPLY_PX;
  for (const [id, k, x, y, state] of snap.props ?? []) {
    const kind = PROP_KINDS[k];
    if (kind !== 'medic' && kind !== 'ammo') continue;
    if ((kind === 'medic' && !wantsHp) || (kind === 'ammo' && !wantsAmmo)) continue;
    const pack = state === 11, standing = state >= 1 && state <= 10;
    if (!pack && !standing) continue;
    const d = dist(me, { x, y });
    // A pack on the floor is worth a little more of a walk than a cabinet still to open.
    const cost = pack ? d * 0.8 : d;
    if (cost >= bestD) continue;
    if (pack) { best = { id, at: { x, y }, open: false }; bestD = cost; continue; }
    // A cabinet: the face nearest the bot that it can stand at (one against a wall has fewer).
    const r = STAND_OFF(kind);
    const faces = [{ x: x + r, y }, { x: x - r, y }, { x, y: y + r }, { x, y: y - r }].filter(open).sort((a, b) => dist(me, a) - dist(me, b));
    if (!faces.length) continue;
    best = { id, at: faces[0]!, open: true };
    bestD = cost;
  }
  return best;
}

/** Whether a bot heading for `s` is close enough to press E on it this tick. */
export function inOpenReach(me: Point, s: Supply | null, props: Snapshot['props']): boolean {
  if (!s?.open) return false;
  const q = props?.find((v) => v[0] === s.id);
  if (!q || q[4] < 1 || q[4] > 10) return false;
  const kind = PROP_KINDS[q[1]] as 'medic' | 'ammo';
  return dist(me, { x: q[2], y: q[3] }) <= PROP_FX[kind].openR - 6;
}
