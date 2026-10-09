/**
 * Where a map's doorways are: every opening a soldier can walk through into a building, found once per map from its geometry. A doorway is
 * either a door that is not locked, or a gap in the walls along a roof's edge (a roof covers its whole building, wall tops included, so a run
 * of its edge with no wall under it and walls on both sides is a way in). The art that marks them is in doorwayart.ts.
 */
import { staticSolids } from '../shared/mapgeo.ts';
import type { MapDoor, MapRoof, Pt } from '../shared/geom.ts';
import type { MapDef } from '../shared/maps.ts';
import type { Rect } from '../shared/sim/movement.ts';

/**
 * One opening. `a` and `b` are the jambs where the wall's outer face meets the opening (`a` to `b` runs along the wall), `n` is the unit
 * normal pointing out of the building (or, for a door between two rooms or out in the open, the door's +y or +x side), and the opening runs
 * `depth` px back from the outer face along `-n`. `outside` is false when both sides are indoors or neither is, so nothing spills from it.
 */
export type Doorway = {
  a: Pt; b: Pt; n: Pt; depth: number; outside: boolean;
  /** The wall beside the opening: its material, and its front face's height when it is a polygon (a grid wall's comes from its material). */
  wall: { material: string; height?: number };
  /** The door that fills it, if any, and the roof of the building it leads into, if any. */
  door?: string; roof?: string;
};
type Solid = Rect & { material?: string; pid?: number };

/** A point inside a solid (grid rect or convex polygon part). */
const inside = (s: Rect, x: number, y: number): boolean => {
  if (x < s.x || x > s.x + s.w || y < s.y || y > s.y + s.h) return false;
  const p = s.pts;
  if (!p) return true;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const ax = p[i]!, ay = p[i + 1]!, bx = p[(i + 2) % n]!, by = p[(i + 3) % n]!;
    if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < -1e-6) return false;
  }
  return true;
};

const near = (solids: readonly Rect[], x0: number, y0: number, x1: number, y1: number, pad: number) =>
  solids.filter((s) => s.x + s.w >= x0 - pad && s.x <= x1 + pad && s.y + s.h >= y0 - pad && s.y <= y1 + pad);

const solidAt = (solids: readonly Rect[], x: number, y: number) => solids.some((s) => inside(s, x, y));

/** The wall at `p`, as a doorway names it. */
function wallOf(map: MapDef, solids: readonly Solid[], p: Pt): Doorway['wall'] {
  const s = solids.find((q) => inside(q, p.x, p.y));
  if (!s) return { material: 'concrete' };
  const poly = s.pid === undefined ? undefined : map.polys?.[s.pid];
  return poly ? { material: poly.material, height: poly.height ?? 14 } : { material: s.material ?? 'concrete' };
}

const inPoly = (p: Pt, pts: readonly Pt[]): boolean => {
  let r = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!, b = pts[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r;
  }
  return r;
};

/** How far a probe looks for wall across a roof's edge: from just outside it to a thick wall's inner face. */
const PROBE = { out: 8, in: 64, step: 6 } as const;
/** Openings this narrow or this wide are not doorways (a seam between two wall pieces; a building with a whole side open). */
const DOORWAY_MIN = 56, DOORWAY_MAX = 340;
/** The thickest wall a doorway is drawn through. */
export const MAX_DEPTH = 72;
/** A roof edge that is mostly open is a canopy's or a shelter's, not a wall with a way in. */
const WALLED_SHARE = 0.3;

/**
 * The wall across `at` along `-n` (into the building), searched from `from` to `to` px: where the run of solid nearest `from` starts and
 * stops, measured from `at` (negative is outside), or null when there is none.
 */
function wallSpan(solids: readonly Rect[], at: Pt, n: Pt, from: number = 1 - PROBE.out, to: number = PROBE.in): { lo: number; hi: number } | null {
  let lo = Infinity, hi = -Infinity;
  const step = to < from ? -2 : 2;
  for (let d = from; (to - d) * step >= 0; d += step) {
    if (!solidAt(solids, at.x - n.x * d, at.y - n.y * d)) { if (hi >= lo) break; continue; }
    lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  // Each probe stands for the 2 px round it.
  return hi >= lo ? { lo: lo - 1, hi: hi + 1 } : null;
}

/** The gaps in the walls along one roof's edge. */
function roofGaps(roof: MapRoof, all: readonly Rect[]): Doorway[] {
  const pts = roof.points;
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i]!, q = pts[(i + 1) % pts.length]!; area += p.x * q.y - q.x * p.y; }
  // With a positive signed area (y down), (dy, -dx) of each edge points out of the polygon.
  const sign = area > 0 ? 1 : -1;
  const out: Doorway[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, q = pts[(i + 1) % pts.length]!;
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len < DOORWAY_MIN + 2 * PROBE.step) continue;
    const t = { x: (q.x - p.x) / len, y: (q.y - p.y) / len }, n = { x: t.y * sign, y: -t.x * sign };
    const solids = near(all, Math.min(p.x, q.x), Math.min(p.y, q.y), Math.max(p.x, q.x), Math.max(p.y, q.y), PROBE.in + 12);
    const steps = Math.floor(len / PROBE.step);
    const walled: boolean[] = [];
    for (let k = 0; k <= steps; k++) {
      const s = (k * len) / steps;
      const at = { x: p.x + t.x * s, y: p.y + t.y * s };
      let hit = false;
      for (let d = -PROBE.out; d <= PROBE.in && !hit; d += PROBE.step) hit = solidAt(solids, at.x - n.x * d, at.y - n.y * d);
      walled.push(hit);
    }
    if (walled.filter(Boolean).length < WALLED_SHARE * walled.length) continue;
    for (let k = 1; k < walled.length; k++) {
      if (walled[k] || !walled[k - 1]) continue;
      let e = k;
      while (e < walled.length && !walled[e]) e++;
      if (e >= walled.length) break;
      // The opening runs from the last walled probe to the next one; refine each end to the pixel.
      const s0 = edgeOf(solids, p, t, n, ((k - 1) * len) / steps, (k * len) / steps);
      const s1 = edgeOf(solids, p, t, n, (e * len) / steps, ((e - 1) * len) / steps);
      k = e;
      if (s1 - s0 < DOORWAY_MIN || s1 - s0 > DOORWAY_MAX) continue;
      const left = wallSpan(solids, { x: p.x + t.x * (s0 - 6), y: p.y + t.y * (s0 - 6) }, n);
      const right = wallSpan(solids, { x: p.x + t.x * (s1 + 6), y: p.y + t.y * (s1 + 6) }, n);
      if (!left || !right) continue;
      const lo = Math.max(left.lo, right.lo), hi = Math.min(left.hi, right.hi, lo + MAX_DEPTH);
      if (hi - lo < 8) continue;
      out.push({
        a: { x: p.x + t.x * s0 - n.x * lo, y: p.y + t.y * s0 - n.y * lo },
        b: { x: p.x + t.x * s1 - n.x * lo, y: p.y + t.y * s1 - n.y * lo },
        n, depth: hi - lo, outside: true, roof: roof.id, wall: { material: 'concrete' },
      });
    }
  }
  return out;
}

/** Along the edge from `walledAt` (inside a wall) toward `openAt` (clear), the last distance that still has wall across it. */
function edgeOf(solids: readonly Rect[], p: Pt, t: Pt, n: Pt, walledAt: number, openAt: number): number {
  const walledThere = (s: number) => {
    for (let d = -PROBE.out; d <= PROBE.in; d += 2) if (solidAt(solids, p.x + t.x * s - n.x * d, p.y + t.y * s - n.y * d)) return true;
    return false;
  };
  let a = walledAt, b = openAt;
  for (let i = 0; i < 8; i++) { const m = (a + b) / 2; if (walledThere(m)) a = m; else b = m; }
  return Math.round(((a + b) / 2) * 2) / 2;
}

/** A door as a doorway: its span on the wall's centre line, the wall's faces found by probing beside its jambs. */
function doorway(d: MapDoor, solids: readonly Rect[], roofs: readonly MapRoof[]): Doorway | null {
  const t = d.axis === 'h' ? { x: 1, y: 0 } : { x: 0, y: 1 };
  let n = d.axis === 'h' ? { x: 0, y: 1 } : { x: 1, y: 0 };
  const mid = { x: d.x + t.x * d.w / 2, y: d.y + t.y * d.w / 2 };
  // Which side is outdoors: the side a roof does not cover.
  const probe = (k: number) => ({ x: mid.x + n.x * k, y: mid.y + n.y * k });
  const under = (k: number) => roofs.some((r) => inPoly(probe(k), r.points));
  const plus = under(70), minus = under(-70);
  const outside = plus !== minus;
  const roof = outside ? roofs.find((r) => inPoly(probe(plus ? 70 : -70), r.points))?.id : undefined;
  if (outside && plus) n = { x: -n.x, y: -n.y };
  // The wall the door stands in, beside each jamb: the run of solid across the door's centre line.
  // Only a run of wall through the centre line counts; a curved wall may curl away from it right at the jamb, so look a little further along.
  const across = (s: number) => {
    const q = { x: d.x + t.x * s, y: d.y + t.y * s };
    if (!solidAt(solids, q.x, q.y)) return null;
    const back = wallSpan(solids, q, n, 0, -80), on = wallSpan(solids, q, n, 0, 80);
    return back && on ? { lo: back.lo, hi: on.hi } : null;
  };
  // Where the wall really ends beside each end of the door, on its centre line: a curved wall's cut end can stand a little off the door's.
  const end = (from: number, dir: 1 | -1) => {
    for (let k = 0; k <= 24; k++) if (solidAt(solids, d.x + t.x * (from + dir * k), d.y + t.y * (from + dir * k))) return from + dir * k;
    return from;
  };
  const s0 = end(0, -1), s1 = end(d.w, 1);
  const left = across(s0 - 6) ?? across(s0 - 12), right = across(s1 + 6) ?? across(s1 + 12);
  // The door stands on the wall's centre line, so the wall is as thick as twice its nearer face; a wall that runs on along the normal (the
  // side of a passage the door closes) must not make it look deep.
  const face = (w: { lo: number; hi: number } | null) => (w ? Math.min(-w.lo, w.hi) : Infinity);
  const half = Math.min(face(left), face(right), MAX_DEPTH / 2);
  const lo = Number.isFinite(half) ? -half : -(d.thick ?? 12) / 2, hi = -lo;
  return {
    a: { x: d.x + t.x * s0 - n.x * lo, y: d.y + t.y * s0 - n.y * lo },
    b: { x: d.x + t.x * s1 - n.x * lo, y: d.y + t.y * s1 - n.y * lo },
    n, depth: hi - lo, outside, door: d.id, wall: { material: 'concrete' }, ...(roof !== undefined && { roof }),
  };
}

const CACHE = new WeakMap<MapDef, readonly Doorway[]>();

/** Every doorway on a map: its doors that open, then the open gaps along its roofs' edges that no door fills. Cached per map. */
export function doorwaysOf(map: MapDef): readonly Doorway[] {
  const hit = CACHE.get(map);
  if (hit) return hit;
  const solids = staticSolids(map) as readonly Solid[];
  const roofs = map.roofs ?? [];
  const out: Doorway[] = [];
  for (const d of map.doors ?? []) {
    if (d.locked) continue;
    const local = near(solids, Math.min(d.x, d.x + (d.axis === 'h' ? d.w : 0)), d.y, d.x + (d.axis === 'h' ? d.w : 0), d.y + (d.axis === 'v' ? d.w : 0), 140);
    const w = doorway(d, local, roofs);
    if (w) out.push(w);
  }
  const doorBoxes = (map.doors ?? []).map((d) => ({ x: d.x - 40, y: d.y - 40, w: (d.axis === 'h' ? d.w : 0) + 80, h: (d.axis === 'v' ? d.w : 0) + 80 }));
  for (const r of roofs) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of r.points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    for (const g of roofGaps(r, near(solids, x0, y0, x1, y1, PROBE.in + 20))) {
      const mid = { x: (g.a.x + g.b.x) / 2 - g.n.x * g.depth / 2, y: (g.a.y + g.b.y) / 2 - g.n.y * g.depth / 2 };
      if (doorBoxes.some((b) => mid.x >= b.x && mid.x <= b.x + b.w && mid.y >= b.y && mid.y <= b.y + b.h)) continue;
      // Two roofs that share a wall find the same gap from both sides; keep the first.
      if (out.some((o) => Math.hypot((o.a.x + o.b.x) / 2 - (g.a.x + g.b.x) / 2, (o.a.y + o.b.y) / 2 - (g.a.y + g.b.y) / 2) < 70)) continue;
      out.push(g);
    }
  }
  // Name the wall beside each opening, a little way along it from the first jamb.
  for (const o of out) {
    const len = Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y), tx = (o.b.x - o.a.x) / len, ty = (o.b.y - o.a.y) / len;
    o.wall = wallOf(map, solids, { x: o.a.x - tx * 8 - o.n.x * o.depth / 2, y: o.a.y - ty * 8 - o.n.y * o.depth / 2 });
  }
  CACHE.set(map, out);
  return out;
}
