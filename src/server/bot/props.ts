import { PROP_FX, PROP_KINDS, PROPS, WORLD, type PropKind } from '../../shared/defs.ts';
import type { PropView, ThrownView } from '../../shared/protocol.ts';
import { CLAYMORE, GAS_RADIUS } from '../../shared/sim/abilities.ts';
import { segmentEntersRectAt, type Rect } from '../../shared/sim/movement.ts';
import { clearShot, dist, type Point } from './nav.ts';

/** A prop as the bot sees it; `standing` while a round can still set it off. */
export type SeenProp = Point & { id: number; kind: PropKind; standing: boolean };
export const seenProps = (views: readonly PropView[] | undefined): SeenProp[] =>
  (views ?? []).map(([id, k, x, y, state]) => ({ id, kind: PROP_KINDS[k]!, x, y, standing: state >= 1 && state <= 10 }));

/** How far each shootable hazard reaches, and the kinds a bot shoots to hurt the enemy (a lamp, cabinet, crate and paint can do nothing to anyone). */
const REACH: Partial<Record<PropKind, number>> = { gas: GAS_RADIUS, oil: PROP_FX.oil.radius, generator: PROP_FX.generator.radius, propane: PROP_FX.propane.radius };
/** A bot stays this far past a hazard's reach (its body and a margin) when it sets one off. */
const SAFE_MARGIN = WORLD.playerRadius + 40;
const FIRING_RANGE_FRAC = 0.9;
/** A propane tank shot flies this far along the round's heading, and an enemy within this of that line is in its path. */
const PROPANE_PATH_PX = 560, PROPANE_PATH_HALF = 44;
const AIM_SLACK_PX = 6;

const box = (q: Point, kind: PropKind, grow = 0): Rect => { const h = PROPS[kind].size / 2 + grow; return { x: q.x - h, y: q.y - h, w: 2 * h, h: 2 * h }; };

/** The first standing prop a round from `from` toward `to` meets, if any. */
export function propOnLine(props: readonly SeenProp[], from: Point, to: Point, grow = 0): SeenProp | null {
  let best: SeenProp | null = null, bestT = Infinity;
  for (const q of props) {
    const t = segmentEntersRectAt(from.x, from.y, to.x - from.x, to.y - from.y, box(q, q.kind, grow));
    if (t !== null && t < bestT) { best = q; bestT = t; }
  }
  return best;
}

/** True when a hit prop at `q` shot from `me` would hurt `at`: its hazard reaches them (a propane tank, the line it would fly). */
function reaches(q: SeenProp, me: Point, at: Point, walls: readonly Rect[]): boolean {
  if (q.kind === 'propane') {
    const dx = q.x - me.x, dy = q.y - me.y, len = Math.hypot(dx, dy) || 1;
    const along = ((at.x - q.x) * dx + (at.y - q.y) * dy) / len;
    const across = Math.abs((at.x - q.x) * dy - (at.y - q.y) * dx) / len;
    return along > 0 && along < PROPANE_PATH_PX && across < PROPANE_PATH_HALF && clearShot(walls, q, at);
  }
  const r = REACH[q.kind];
  return r !== undefined && dist(q, at) < r && clearShot(walls, q, at);
}

/** True when a shot from `me` to `to` would meet a standing hazard prop that would reach `me`, so a bot holds fire rather than gas, burn or shock itself. */
export function shotWouldHurtMe(props: readonly SeenProp[], me: Point, to: Point): boolean {
  const hit = propOnLine(props.filter((q) => q.standing && REACH[q.kind] !== undefined), me, to, AIM_SLACK_PX);
  if (!hit) return false;
  if (hit.kind === 'propane') return dist(hit, me) < PROP_FX.propane.radius + SAFE_MARGIN;
  return dist(hit, me) < REACH[hit.kind]! + SAFE_MARGIN;
}

/** The hazard prop a bot at `me` should shoot with a gun reaching `range`, or null: one that would reach an enemy and nobody on its own side, with the shooter out of its reach. */
export function propToShoot(
  me: Point, props: readonly SeenProp[], enemies: readonly Point[], allies: readonly Point[], walls: readonly Rect[], range: number,
): SeenProp | null {
  if (enemies.length === 0) return null;
  const standing = props.filter((q) => q.standing);
  let best: SeenProp | null = null, bestScore = 0;
  for (const q of standing) {
    const reach = REACH[q.kind];
    if (reach === undefined || dist(q, me) > range * FIRING_RANGE_FRAC || !clearShot(walls, me, q)) continue;
    if (propOnLine(standing, me, q) !== q) continue;
    if (dist(q, me) < (q.kind === 'propane' ? PROP_FX.propane.radius : reach) + SAFE_MARGIN) continue;
    if (allies.some((a) => reaches(q, me, a, walls))) continue;
    const hit = enemies.filter((e) => reaches(q, me, e, walls));
    if (hit.length > bestScore) { best = q; bestScore = hit.length; }
  }
  return best;
}

/**
 * Fire slicks, gas clouds and enemy claymores it has spotted, as circles a bot keeps out of; its own (harmless to it) excepted. A
 * claymore's circle covers its trigger cone (centred out along its facing), and is a `trap`: one that stays, so a bot walks round it
 * rather than wait at its edge. `friendly` says whether a thrower is on the bot's side (their claymores never fire at it).
 */
export type Hazard = Point & { r: number; trap?: true };
export function hazardsOf(thrown: readonly ThrownView[], myId: number, friendly: (owner: number) => boolean = () => false): Hazard[] {
  const out: Hazard[] = [];
  for (const t of thrown) {
    if (t.owner === myId) continue;
    if (t.kind === 'gasCloud' || t.kind === 'fireSlick') out.push({ x: t.x, y: t.y, r: t.r });
    else if (t.kind === 'claymore' && !friendly(t.owner)) {
      out.push({ ...trapCircle(t, t.angle ?? 0), trap: true });
    }
  }
  return out;
}

/** A circle round a claymore's trigger cone, a body's width wider all round: centred halfway out along its facing, through the cone's far corners. */
function trapCircle(t: Point, a: number): Hazard {
  const far = CLAYMORE.reach + WORLD.playerRadius * 2, side = CLAYMORE.cone + 0.15, mid = far / 2;
  return { x: t.x + Math.cos(a) * mid, y: t.y + Math.sin(a) * mid, r: Math.hypot(far * Math.cos(side) - mid, far * Math.sin(side)) };
}

/** Where to walk to get round trap `h` on the way from `me` to `to`: abreast of it, on the side the way already leans to, clear of it. */
export function aroundTrap(h: Hazard, me: Point, to: Point): Point {
  const dx = h.x - me.x, dy = h.y - me.y, d = Math.hypot(dx, dy) || 1;
  const side = (to.x - me.x) * dy - (to.y - me.y) * dx > 0 ? -1 : 1;
  const k = (h.r + WORLD.playerRadius * 3) / d;
  return { x: h.x - dy * k * side, y: h.y + dx * k * side };
}

const toSegment = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return dist(p, { x: a.x + dx * t, y: a.y + dy * t });
};

/** Where `me` stands relative to the hazards: `in` one (get out), `entering` one on the way to `to` (hold at its edge), or clear. */
export function hazardState(hazards: readonly Hazard[], me: Point, to: Point | null): { k: 'clear' } | { k: 'in' | 'entering'; h: Hazard } {
  const pad = WORLD.playerRadius * 0.5;
  for (const h of hazards) if (dist(h, me) < h.r + pad) return { k: 'in', h };
  if (to) for (const h of hazards) if (dist(h, me) < h.r + 160 && toSegment(h, me, to) < h.r + pad) return { k: 'entering', h };
  return { k: 'clear' };
}
