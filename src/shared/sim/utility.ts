import { UTILITY, ZOM, type ZombieKind } from '../defs.ts';
import { auraOf, levelOf, maxHpOf, reachAt, turretDef, wallTier } from './build.ts';
import { damageZombie } from './run.ts';
import { effectiveStats } from './stats.ts';
import { dist2 } from './movement.ts';
import type { Building, Run, World, Zombie } from './world.ts';

/**
 * What the utilities do besides stand there: spike strips slow, hurt and wear under the horde that walks over them, a steel wall shrugs off part of each bite,
 * and a depot or a repair post tends everything in its reach. The horde's own tick (horde.ts) knows none of it, so each hook here is handed what it needs
 * from just before that tick and corrects the result after it: a slowed zombie keeps `slow` of the step it took, an armoured wall gets back its share of the bites.
 */

const key = (cx: number, cy: number) => cx * 4096 + cy;
const heavy: ReadonlySet<ZombieKind> = new Set<ZombieKind>(['brute', 'bloater', 'colossus']);
const everySecond = (w: World, dtMs: number) => Math.floor(w.now / 1000) !== Math.floor((w.now - dtMs) / 1000);

/**
 * How much of its step a zombie standing at (`x`, `y`) keeps: `UTILITY.spikes.slow` over a spike strip, 1 anywhere else. `tickTraps` applies it after the horde's tick;
 * a zombie AI that wants to slow its own walk instead can multiply its speed by this and drop the correction.
 */
export const spikeSlowAt = (w: World, x: number, y: number): number => {
  const cx = Math.floor(x / ZOM.cell), cy = Math.floor(y / ZOM.cell);
  return w.floor.some((s) => s.cx === cx && s.cy === cy) ? UTILITY.spikes.slow : 1;
};

type TrapWatch = Map<Zombie, { x: number; y: number }>;

/** Zombies standing on a spike strip, where they stand before the horde moves. Null with no strips down. */
export function trapWatch(w: World): TrapWatch | null {
  if (w.floor.length === 0 || w.zombies.length === 0) return null;
  const strips = new Set(w.floor.map((s) => key(s.cx, s.cy)));
  const on: TrapWatch = new Map();
  for (const z of w.zombies) if (strips.has(key(Math.floor(z.x / ZOM.cell), Math.floor(z.y / ZOM.cell)))) on.set(z, { x: z.x, y: z.y });
  return on.size ? on : null;
}

/** Slows and hurts what was on a strip, and wears the strip by its weight; a strip worn through is gone. */
export function tickTraps(w: World, dtMs: number, on: TrapWatch | null) {
  if (!on) return;
  const wear = new Map<number, number>();
  for (const [z, from] of on) {
    if (z.hp <= 0 || !w.zombies.includes(z)) continue;
    z.x = from.x + (z.x - from.x) * UTILITY.spikes.slow;
    z.y = from.y + (z.y - from.y) * UTILITY.spikes.slow;
    z.vx *= UTILITY.spikes.slow;
    z.vy *= UTILITY.spikes.slow;
    const at = key(Math.floor(from.x / ZOM.cell), Math.floor(from.y / ZOM.cell));
    wear.set(at, (wear.get(at) ?? 0) + ((heavy.has(z.kind) ? UTILITY.spikes.heavyWear : UTILITY.spikes.wear) * dtMs) / 1000);
    damageZombie(w, z, (UTILITY.spikes.dps * dtMs) / 1000, null, 'blast');
  }
  for (const strip of [...w.floor]) {
    const worn = wear.get(key(strip.cx, strip.cy));
    if (!worn) continue;
    strip.hp -= worn;
    if (strip.hp > 0) continue;
    w.floor = w.floor.filter((s) => s !== strip);
    w.events.push({ e: 'boom', x: (strip.cx + 0.5) * ZOM.cell, y: (strip.cy + 0.5) * ZOM.cell, r: ZOM.cell / 2 });
  }
}

const centerOf = (b: { cx: number; cy: number }) => ({ x: (b.cx + 0.5) * ZOM.cell, y: (b.cy + 0.5) * ZOM.cell });

/**
 * A depot tops up the neediest turret in its reach, at `ammoPerSec` of that turret's load a second for `scrapShare` of the usual price, and fills the guns of squad players there.
 * A post mends squad players and the other buildings in its reach, free. Each says so, at most once a second, in an `aid` event.
 */
export function tickUtilities(w: World, run: Run, dtMs: number) {
  const dt = dtMs / 1000;
  const say = everySecond(w, dtMs);
  for (const u of w.buildings) {
    if (u.kind !== 'depot' && u.kind !== 'post') continue;
    const lv = levelOf(u), aura = auraOf(lv), at = centerOf(u);
    const base = UTILITY[u.kind].reach;
    const reach = reachAt(base, lv);
    let did = false;
    if (u.kind === 'depot') {
      let needy: (Building & { ammo: number }) | null = null, share = 1;
      for (const t of w.buildings) {
        if (!('ammo' in t)) continue;
        const c = centerOf(t), max = turretDef(t.kind, levelOf(t)).ammo, f = t.ammo / max;
        if (f < share && dist2(at.x, at.y, c.x, c.y) <= reach ** 2) { needy = t; share = f; }
      }
      if (needy && 'ammo' in needy) {
        const def = turretDef(needy.kind, levelOf(needy));
        const per = def.scrapPerRound * UTILITY.depot.scrapShare;
        const rounds = Math.min(def.ammo * UTILITY.depot.ammoPerSec * aura * dt, def.ammo - needy.ammo, per > 0 ? run.scrap / per : Infinity);
        if (rounds > 0) { needy.ammo += rounds; run.scrap -= rounds * per; did = true; }
      }
      for (const p of w.players.values()) {
        if (p.life.k !== 'alive' || dist2(p.x, p.y, at.x, at.y) > reach ** 2) continue;
        const mag = effectiveStats(p).mag;
        if (p.life.reloadUntil !== null) { p.life.reloadUntil = Math.min(p.life.reloadUntil, w.now); did = true; }
        else if (p.life.ammo < mag) { p.life.ammo = Math.min(mag, p.life.ammo + mag * 0.5 * aura * dt); did = true; }
      }
    } else {
      for (const p of w.players.values()) {
        if (p.life.k !== 'alive' || dist2(p.x, p.y, at.x, at.y) > reach ** 2) continue;
        const max = effectiveStats(p).maxHp;
        if (p.life.hp < max) { p.life.hp = Math.min(max, p.life.hp + UTILITY.post.playerHp * aura * dt); did = true; }
      }
      for (const b of w.buildings) {
        if (b === u) continue;
        const c = centerOf(b), max = maxHpOf(b.kind, levelOf(b));
        if (b.hp < max && dist2(at.x, at.y, c.x, c.y) <= reach ** 2) { b.hp = Math.min(max, b.hp + UTILITY.post.buildingHp * aura * dt); did = true; }
      }
    }
    if (did && say) w.events.push({ e: 'aid', kind: u.kind, x: at.x, y: at.y });
  }
}
