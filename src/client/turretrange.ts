import { isTurretKind, ZOM, type TurretKind } from '../shared/defs.ts';
import type { BuildingView } from '../shared/protocol.ts';
import { levelOf, maxLevelOf, turretDef, upgradeCost } from '../shared/sim/build.ts';
import type { Rect } from '../shared/sim/movement.ts';
import type { Ghost } from './zombies.ts';

/**
 * Turret ranges: which rings to show and what they cover. Each ring's radius is the sim's own `turretDef(kind, lv).range`, the
 * reach a turret picks targets within (turrets.ts), so a ring never promises what the gun cannot do. A direct-fire gun
 * (sentry, cannon, scatter) cannot shoot through the map's walls and crates, so its ring is shaded where cover hides the
 * floor from the turret's centre, by the same segment test the sim aims with; a mortar lobs over everything and a coil arcs
 * through it, so their rings are whole. No turret has a minimum range: a mortar's shell lands as close as its target.
 */

/** `place`: the ghost of one about to go up; `hover`: one built, under the cursor or the one U would upgrade; `next`: its next level's reach; `squad`: the faint always-on ring of every turret at night. */
export type RingRole = 'place' | 'hover' | 'next' | 'squad';
export type RangeRing = { kind: TurretKind; lv: number; x: number; y: number; r: number; role: RingRole };

/** How a kind's rounds reach their target: `direct` is stopped by cover, `lobbed` flies over it, `arc` leaps through it. */
export const fireOf = (kind: TurretKind): 'direct' | 'lobbed' | 'arc' => {
  const def = turretDef(kind);
  return def.arc ? 'arc' : def.lobbed ? 'lobbed' : 'direct';
};

const centre = (cx: number, cy: number) => ({ x: (cx + 0.5) * ZOM.cell, y: (cy + 0.5) * ZOM.cell });

export function ringOf(kind: TurretKind, lv: number, cx: number, cy: number, role: RingRole): RangeRing {
  return { kind, lv, ...centre(cx, cy), r: turretDef(kind, lv).range, role };
}

/** A built turret's ring, and by day the next level's beside it when it can still go up. */
function builtRings(b: BuildingView, day: boolean): RangeRing[] {
  if (!isTurretKind(b.kind)) return [];
  const lv = levelOf(b);
  const out = [ringOf(b.kind, lv, b.cx, b.cy, 'hover')];
  if (day && lv < maxLevelOf(b.kind) && upgradeCost(b.kind, lv) !== null) out.push(ringOf(b.kind, lv + 1, b.cx, b.cy, 'next'));
  return out;
}

export type RingInput = {
  /** Build mode's ghost: a turret about to go up shows its ring, a built one under it shows its own and the next level's. */
  ghost: Ghost | null;
  buildings: readonly BuildingView[];
  day: boolean;
  /** Outside build mode by day: the cursor in the world, whose turret shows its ring. */
  cursor: { x: number; y: number } | null;
  /** Outside build mode by day: the building U would upgrade, if any. */
  upgrade: BuildingView | null;
  /** The night's faint ring round every turret (the Turret ranges setting, at night). */
  squad: boolean;
};

/** Every ring to draw this frame: the focused turret's (ghost, hover or U's target) first, then at night the squad's faint ones. */
export function rangeRings(i: RingInput): RangeRing[] {
  const out: RangeRing[] = [];
  const at = (cx: number, cy: number) => i.buildings.find((b) => b.cx === cx && b.cy === cy) ?? null;
  if (i.ghost) {
    const taken = i.ghost.refusal === 'taken' ? at(i.ghost.cx, i.ghost.cy) : null;
    if (taken) out.push(...builtRings(taken, i.day));
    else if (!i.ghost.line && isTurretKind(i.ghost.kind)) out.push(ringOf(i.ghost.kind, 1, i.ghost.cx, i.ghost.cy, 'place'));
  } else if (i.day) {
    const under = i.cursor ? at(Math.floor(i.cursor.x / ZOM.cell), Math.floor(i.cursor.y / ZOM.cell)) : null;
    const focus = under && isTurretKind(under.kind) ? under : i.upgrade && isTurretKind(i.upgrade.kind) ? i.upgrade : null;
    if (focus) out.push(...builtRings(focus, true));
  }
  if (i.squad) {
    const shown = new Set(out.map((r) => `${r.x},${r.y}`));
    for (const b of i.buildings) {
      if (!isTurretKind(b.kind)) continue;
      const r = ringOf(b.kind, levelOf(b), b.cx, b.cy, 'squad');
      if (!shown.has(`${r.x},${r.y}`)) out.push(r);
    }
  }
  return out;
}

/**
 * The floor a direct-fire turret at (`x`, `y`) cannot see within `r`: one polygon per piece of cover in reach, from the cover's
 * two outermost corners as seen from the turret out past the ring. The sim tests the straight segment from the turret's
 * centre to its target against the same rectangles, so a target is hidden exactly when it stands in one of these.
 */
export function blindSpots(x: number, y: number, r: number, cover: readonly Rect[]): number[][] {
  const out: number[][] = [];
  const far = r * 1.25;
  for (const c of cover) {
    // In reach at all, and not the cell the turret stands on.
    const nx = Math.max(c.x, Math.min(x, c.x + c.w)), ny = Math.max(c.y, Math.min(y, c.y + c.h));
    if ((nx - x) ** 2 + (ny - y) ** 2 > r * r) continue;
    if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) continue;
    const mid = Math.atan2(c.y + c.h / 2 - y, c.x + c.w / 2 - x);
    let lo = Infinity, hi = -Infinity, loP: readonly [number, number] = [0, 0], hiP: readonly [number, number] = [0, 0];
    for (const p of [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]] as const) {
      let a = Math.atan2(p[1] - y, p[0] - x) - mid;
      a = Math.atan2(Math.sin(a), Math.cos(a));
      if (a < lo) { lo = a; loP = p; }
      if (a > hi) { hi = a; hiP = p; }
    }
    const a0 = mid + lo, a1 = mid + hi;
    // Out past the ring in steps of at most 30 degrees, so the far edge never dips inside it however wide the cover looms.
    const q = [loP[0], loP[1], hiP[0], hiP[1]];
    const steps = Math.max(1, Math.ceil((a1 - a0) / (Math.PI / 6)));
    for (let k = 0; k <= steps; k++) { const a = a1 - ((a1 - a0) * k) / steps; q.push(x + Math.cos(a) * far, y + Math.sin(a) * far); }
    out.push(q);
  }
  return out;
}

/**
 * The arcs of `ring` (as [from, to] angles, increasing) that lie outside every one of `others`: where two rings overlap, the
 * part of each inside the other is dropped, so many rings draw as the one edge of the ground they cover between them.
 */
export function openArcs(ring: Pick<RangeRing, 'x' | 'y' | 'r'>, others: readonly Pick<RangeRing, 'x' | 'y' | 'r'>[]): [number, number][] {
  const TAU = Math.PI * 2;
  const covered: [number, number][] = [];
  for (const o of others) {
    const d = Math.hypot(o.x - ring.x, o.y - ring.y);
    if (d + ring.r <= o.r) return [];
    if (d >= ring.r + o.r || d + o.r <= ring.r || d === 0) continue;
    const mid = Math.atan2(o.y - ring.y, o.x - ring.x);
    const half = Math.acos(Math.max(-1, Math.min(1, (ring.r * ring.r + d * d - o.r * o.r) / (2 * ring.r * d))));
    let a0 = mid - half;
    a0 = ((a0 % TAU) + TAU) % TAU;
    const a1 = a0 + half * 2;
    if (a1 > TAU) { covered.push([a0, TAU], [0, a1 - TAU]); } else covered.push([a0, a1]);
  }
  covered.sort((p, q) => p[0] - q[0]);
  const open: [number, number][] = [];
  let at = 0;
  for (const [c0, c1] of covered) {
    if (c0 > at) open.push([at, c0]);
    at = Math.max(at, c1);
  }
  if (at < TAU) open.push([at, TAU]);
  return open;
}

/** Ring paint from the kit: bone for what a turret covers, lamp amber for the reach an upgrade would add, ink to shade. */
const BONE = '226, 220, 203';
/** Lamp amber, apart from the build radius's signal orange so the two dashed circles never read as one. */
const AMBER = '255, 179, 71';
const INK = '28, 31, 38';

const blindCache = new Map<string, number[][]>();
let blindCover: readonly Rect[] | null = null;
function blindFor(ring: RangeRing, cover: readonly Rect[]) {
  if (cover !== blindCover) { blindCache.clear(); blindCover = cover; }
  const key = `${ring.x},${ring.y},${ring.r}`;
  let spots = blindCache.get(key);
  if (!spots) {
    if (blindCache.size > 64) blindCache.clear();
    blindCache.set(key, (spots = blindSpots(ring.x, ring.y, ring.r, cover)));
  }
  return spots;
}

/**
 * Draws the rings, thin and quiet: a dashed bone circle with a faint fill for the focused turret (even dashes for a direct
 * gun, long-short for a lobbing mortar, paired dots for a coil) with the cover it cannot see through shaded in ink inside it,
 * a dashed amber circle for its next level's reach with the band it gains tinted, and at night a dotted, fainter edge round
 * what each kind of the squad's turrets covers together. `scale` is the camera's, so lines keep their width on screen. `cover` is the map's walls and
 * crates, stable between frames, so each turret's blind spots are worked out once.
 */
export function drawRangeRings(ctx: CanvasRenderingContext2D, rings: readonly RangeRing[], cover: readonly Rect[], scale: number, now: number, reduced = false) {
  const px = 1 / Math.max(0.2, scale);
  const TAU = Math.PI * 2;
  ctx.save();
  ctx.lineCap = 'round';
  for (const ring of rings) {
    const { x, y, r } = ring;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    if (ring.role === 'squad') {
      // Only the edge of what the squad's guns of this kind cover together: arcs inside another of its rings are left out.
      ctx.beginPath();
      for (const [a0, a1] of openArcs(ring, rings.filter((o) => o !== ring && o.role === 'squad' && o.kind === ring.kind))) { ctx.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r); ctx.arc(x, y, r, a0, a1); }
      ctx.setLineDash([1, 8 * px]);
      ctx.lineDashOffset = 0;
      ctx.lineWidth = 2.4 * px;
      ctx.strokeStyle = `rgba(${BONE}, 0.34)`;
      ctx.stroke();
      continue;
    }
    if (ring.role === 'next') {
      const inner = rings.find((o) => o.role === 'hover' && o.x === x && o.y === y);
      if (inner) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.arc(x, y, inner.r, 0, TAU, true);
        ctx.fillStyle = `rgba(${AMBER}, 0.08)`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
      }
      ctx.setLineDash([7 * px, 6 * px]);
      ctx.lineDashOffset = reduced ? 0 : -now / 70;
      ctx.lineWidth = 1.8 * px;
      ctx.strokeStyle = `rgba(${AMBER}, 0.85)`;
      ctx.stroke();
      continue;
    }
    ctx.fillStyle = `rgba(${BONE}, 0.07)`;
    ctx.fill();
    const fire = fireOf(ring.kind);
    if (fire === 'direct') {
      const spots = blindFor(ring, cover);
      if (spots.length) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.clip();
        ctx.beginPath();
        for (const q of spots) { ctx.moveTo(q[0]!, q[1]!); for (let k = 2; k < q.length; k += 2) ctx.lineTo(q[k]!, q[k + 1]!); ctx.closePath(); }
        ctx.fillStyle = `rgba(${INK}, 0.24)`;
        ctx.fill('nonzero');
        ctx.restore();
      }
    }
    // A soft ink rule under the dashes, so the ring reads on light floor and dark alike.
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.setLineDash([]);
    ctx.lineWidth = 3.4 * px;
    ctx.strokeStyle = `rgba(${INK}, 0.3)`;
    ctx.stroke();
    ctx.setLineDash(fire === 'lobbed' ? [16 * px, 5 * px, 3 * px, 5 * px] : fire === 'arc' ? [3 * px, 4 * px, 3 * px, 9 * px] : [9 * px, 6 * px]);
    ctx.lineDashOffset = reduced || ring.role === 'hover' ? 0 : -now / 90;
    ctx.lineWidth = 1.6 * px;
    ctx.strokeStyle = `rgba(${BONE}, 0.85)`;
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}
