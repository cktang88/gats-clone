import { ARMOR_PACK, ARMORS } from '../defs.ts';
import { MAPS, type Center, type MapId } from '../maps.ts';
import type { PackView } from '../protocol.ts';
import { openSpots } from './airdrop.ts';
import { dist2 } from './movement.ts';
import { hasArenaSurprises, type ArmorPack, type Player, type World } from './world.ts';

/** A pack wants this much clear floor round it (a body and some room), and stays this far in from the map's edge. */
const CLEAR_R = 56;
const EDGE = 300;

const spotCache = new Map<MapId, Center[]>();

/**
 * Where a map's armor packs lie: four, two half-turn twin pairs, so neither side is nearer more of them. One pair sits halfway down the
 * lanes from the middle toward zones A and C (the fights over B spill there), the other on the flanks, square to that line and as far out,
 * where it is as near one spawn as the other. Each is snapped to the nearest floor a player can walk to with room round it whose twin is
 * clear too. Derived from the map, so a map edit moves them with it; none on a map with no zones (Zombies, the range).
 */
export function armorSpots(map: MapId): readonly Center[] {
  const cached = spotCache.get(map);
  if (cached) return cached;
  const def = MAPS[map];
  const out: Center[] = [];
  const [a, b] = def.zones;
  if (a && b) {
    const open = openSpots(map, CLEAR_R, EDGE);
    const keys = new Set(open.map((s) => `${s.x},${s.y}`));
    const turn = (s: Center): Center => ({ x: def.size - s.x, y: def.size - s.y });
    const vx = (a.x - b.x) / 2, vy = (a.y - b.y) / 2;
    for (const want of [{ x: b.x + vx, y: b.y + vy }, { x: b.x - vy, y: b.y + vx }]) {
      let best: Center | null = null, bestD = Infinity;
      for (const s of open) {
        const t = turn(s);
        if (!keys.has(`${t.x},${t.y}`) || out.some((o) => dist2(o.x, o.y, s.x, s.y) < 400 ** 2)) continue;
        const d = dist2(s.x, s.y, want.x, want.y);
        if (d < bestD) { best = s; bestD = d; }
      }
      if (best) out.push(best, turn(best));
    }
  }
  spotCache.set(map, out);
  return out;
}

/** Armor packs lie in the versus modes and Last Squad; the outpost has none (the squad re-kits at dawn, see run.ts) and the range none. */
export const hasArmorPacks = (w: Pick<World, 'mode'>): boolean => hasArenaSurprises(w.mode) || w.mode === 'BR';

/** A map's packs, fresh. Each is numbered by its place in `armorSpots`, not from the world's id sequence, so laying them shifts no other id. */
export const loadPacks = (w: World): ArmorPack[] => (hasArmorPacks(w) ? armorSpots(w.map).map((s, id) => ({ id, x: s.x, y: s.y, respawnAt: null })) : []);

/** Whether `p` would get anything from an armor pack: alive, wearing armor, and short of a full pool. */
export function wantsArmor(p: Player): boolean {
  return p.life.k === 'alive' && p.life.armor < ARMORS[p.loadout.armor].points;
}

/** Fills `p`'s armor pool to full, and says how many points it gave (a `gain` event) and that the pack went (a `pack` event). */
function takePack(w: World, k: ArmorPack, p: Player) {
  if (p.life.k !== 'alive') return;
  const full = ARMORS[p.loadout.armor].points;
  const gave = full - p.life.armor;
  p.life.armor = full;
  k.respawnAt = w.now + ARMOR_PACK.respawnMs;
  w.events.push({ e: 'gain', id: p.id, from: 'armor', armor: Math.max(1, Math.round(gave)) });
  w.events.push({ e: 'pack', k: 'pick', x: k.x, y: k.y });
}

/**
 * A lying pack goes to the first living player in the tick's turn order whose body is within `ARMOR_PACK.pickR` of it and who wants it
 * (`wantsArmor`); anyone at full armor, or with none, walks over it and leaves it. A taken pack lies again `respawnMs` later.
 */
export function tickPacks(w: World, order: readonly Player[]) {
  const r2 = ARMOR_PACK.pickR ** 2;
  for (const k of w.packs) {
    if (k.respawnAt !== null) {
      if (w.now >= k.respawnAt) k.respawnAt = null;
      continue;
    }
    for (const p of order) {
      if (p.life.k !== 'alive' || dist2(p.x, p.y, k.x, k.y) > r2 || !wantsArmor(p)) continue;
      takePack(w, k, p);
      break;
    }
  }
}

/** The packs lying now, for the wire (sticky: resent only when one is taken or comes back). */
export const packViews = (w: World): PackView[] => w.packs.filter((k) => k.respawnAt === null).map((k) => [k.id, Math.round(k.x), Math.round(k.y)]);

/** Armor points on the wire: the share of a full pool left, as a byte 0..255, rounded up so armor with anything left never reads empty. */
export const armorByte = (points: number, full: number): number => (full <= 0 ? 0 : Math.max(0, Math.min(255, Math.ceil((points / full) * 255 - 1e-9))));
