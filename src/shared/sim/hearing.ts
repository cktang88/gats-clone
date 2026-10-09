import { GUNS, type WeaponId } from '../defs.ts';
import type { GameEvent, HeardShot } from '../protocol.ts';
import { isEnemy, type Player, type World } from './world.ts';

/**
 * How bots hear gunfire, in place of the minimap dots firing used to leave. A person's mix fades another's shot out at 1.2 times their
 * view radius (`duckFor` in `src/client/sfx.ts`); bots hear further than that on purpose, to keep them competitive:
 * - `earshotMul`: an unsilenced shot carries this many view radii to a bot (twice a person's earshot);
 * - `loudMul`: the loud classes carry further still;
 * - `silencedPx`: a silenced shot is a muffled thup, heard only this close, so a silencer still keeps you off a bot's ears across the map;
 * - `blur`: where a heard shot came from is only roughly known, off by up to this share of its distance in a random direction.
 * A flashed bot hears nothing (`perceive`).
 */
export const BOT_HEARING = {
  earshotMul: 2.4,
  loudMul: { sniper: 1.25, lmg: 1.25, shotgun: 1.1 } as Partial<Record<WeaponId, number>>,
  silencedPx: 350,
  blur: 0.2,
} as const;

/** A hash of the shot and the listener in [0, 1), so the blur is fixed for a replay and leaves the world's random stream alone. */
const hash = (a: number, b: number, c: number) => {
  const v = Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453;
  return v - Math.floor(v);
};

/** How far a bot with this view radius hears a shot from this gun (`BOT_HEARING`). */
export const botEarshot = (e: Extract<GameEvent, { e: 'shot' }>, viewRadius: number): number =>
  e.silenced ? BOT_HEARING.silencedPx : viewRadius * BOT_HEARING.earshotMul * (BOT_HEARING.loudMul[GUNS[e.gun].base] ?? 1);

/**
 * The enemy shots bot `me` heard among `events`, each within its earshot (`botEarshot`) and placed only roughly (`BOT_HEARING.blur`), the
 * farther the rougher: a direction and a rough distance, never a dot on the minimap.
 */
export function heardShots(w: World, me: Player, events: readonly GameEvent[], viewRadius: number): HeardShot[] {
  const out: HeardShot[] = [];
  for (const e of events) {
    if (e.e !== 'shot' || e.owner === me.id) continue;
    const owner = w.players.get(e.owner);
    if (owner && !isEnemy(me, owner)) continue;
    const d = Math.hypot(e.x - me.x, e.y - me.y);
    if (d > botEarshot(e, viewRadius)) continue;
    const off = d * BOT_HEARING.blur * Math.sqrt(hash(e.x, e.y, me.id)), a = hash(e.y, e.x, me.id + e.owner) * Math.PI * 2;
    out.push({ x: Math.round(e.x + Math.cos(a) * off), y: Math.round(e.y + Math.sin(a) * off) });
  }
  return out;
}
