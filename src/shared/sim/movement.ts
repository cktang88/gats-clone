import { KNOCK, WORLD } from '../defs.ts';
import type { Dash, InputState } from '../protocol.ts';
import { boxPts, circleHitsConvex, convexOverlap, pushOutConvex, segmentEntersConvexAt, type Convex } from '../geom.ts';
import { prefixGrid } from './rectgrid.ts';

/**
 * A solid's box. A convex polygon part also carries its points in `pts` (flat, positive area) and `x, y, w, h` is its bounding box,
 * so everything that takes `Rect[]` handles polygons without knowing. `nb`: rounds fly over it. `ns`: sight and light pass it.
 */
export type Rect = { x: number; y: number; w: number; h: number; pts?: Convex; nb?: true; ns?: true };

const DASH_MS = 200;
const DASH_DISTANCE = 240;
export const MAX_SUBSTEP = WORLD.playerRadius / 2;

export const walks = (i: { up: boolean; down: boolean; left: boolean; right: boolean }): boolean => i.right !== i.left || i.down !== i.up;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const dist2 = (ax: number, ay: number, bx: number, by: number) => (ax - bx) ** 2 + (ay - by) ** 2;

export function rectsOverlap(a: Rect, b: Rect, pad = 0) {
  if (!(a.x - pad < b.x + b.w && a.x + a.w + pad > b.x && a.y - pad < b.y + b.h && a.y + a.h + pad > b.y)) return false;
  // Boxes meet; a polygon part still has to touch for real.
  if (!a.pts && !b.pts) return true;
  return convexOverlap(a.pts ?? boxPts(a.x, a.y, a.w, a.h, pad), b.pts ?? boxPts(b.x, b.y, b.w, b.h, a.pts ? pad : 0));
}

export function circleHitsRect(x: number, y: number, r: number, b: Rect) {
  const cx = clamp(x, b.x, b.x + b.w), cy = clamp(y, b.y, b.y + b.h);
  if (dist2(x, y, cx, cy) >= r * r) return false;
  return b.pts ? circleHitsConvex(x, y, r, b.pts) : true;
}

export function angleDiff(a: number, b: number) {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

export function segmentEntersCircleAt(px: number, py: number, dx: number, dy: number, cx: number, cy: number, r: number): number | null {
  const fx = px - cx, fy = py - cy;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  const disc = b * b - 4 * a * c;
  if (disc < 0 || a === 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}

/**
 * Where (0..1) the segment (p, p + d) enters the upright capsule of radius `r` round the line from (cx, cy) up to (cx, cy - up),
 * or null: the union of the two end circles and the box between them, so the earliest entry of the three.
 */
export function segmentEntersCapsuleAt(px: number, py: number, dx: number, dy: number, cx: number, cy: number, up: number, r: number): number | null {
  const ts = [
    segmentEntersCircleAt(px, py, dx, dy, cx, cy, r),
    segmentEntersCircleAt(px, py, dx, dy, cx, cy - up, r),
    up > 0 ? segmentEntersRectAt(px, py, dx, dy, { x: cx - r, y: cy - up, w: 2 * r, h: up }) : null,
  ].filter((t): t is number => t !== null);
  return ts.length ? Math.min(...ts) : null;
}

/**
 * Where (0..1) the segment (p, p + d) enters the rect, or null. The slab test runs for every wall against every round, sight
 * line and step, so it allocates nothing: written over a tuple loop it built three arrays a call, and on a map of 500+ walls
 * that garbage alone was a seventh of the server's time (and its GC pauses stalled whole ticks).
 */
export function segmentEntersRectAt(px: number, py: number, dx: number, dy: number, r: Rect): number | null {
  let t0 = 0, t1 = 1;
  if (dx === 0) { if (px < r.x || px > r.x + r.w) return null; }
  else {
    let a = (r.x - px) / dx, b = (r.x + r.w - px) / dx;
    if (a > b) { const s = a; a = b; b = s; }
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  if (dy === 0) { if (py < r.y || py > r.y + r.h) return null; }
  else {
    let a = (r.y - py) / dy, b = (r.y + r.h - py) / dy;
    if (a > b) { const s = a; a = b; b = s; }
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  if (r.pts) return segmentEntersConvexAt(px, py, dx, dy, r.pts);
  return t0;
}

/** The solid the segment (p, p + d) enters first, and where along it (0..1), or null. On a tie the earlier in `solids` wins. */
export function earliestHit<T extends Rect>(solids: readonly T[], px: number, py: number, dx: number, dy: number): { t: number; b: T } | null {
  let best: { t: number; b: T } | null = null;
  const g = prefixGrid(solids);
  let i = 0;
  if (g) {
    const n = g.segment(px, py, dx, dy, true);
    for (let j = 0; j < n; j++) {
      const b = g.rects[g.buf[j]!] as T;
      const t = segmentEntersRectAt(px, py, dx, dy, b);
      if (t !== null && (!best || t < best.t)) best = { t, b };
    }
    i = g.k;
  }
  for (; i < solids.length; i++) {
    const b = solids[i]!;
    const t = segmentEntersRectAt(px, py, dx, dy, b);
    if (t !== null && (!best || t < best.t)) best = { t, b };
  }
  return best;
}

/** Whether the segment (p, p + d) enters any of `solids`, leaving out those flagged `skip` (`nb`: rounds fly over, `ns`: sight passes). */
export function segmentBlocked(solids: readonly Rect[], px: number, py: number, dx: number, dy: number, skip?: 'nb' | 'ns'): boolean {
  const g = prefixGrid(solids);
  let i = 0;
  if (g) {
    const n = g.segment(px, py, dx, dy, false);
    for (let j = 0; j < n; j++) {
      const b = g.rects[g.buf[j]!]!;
      if (!(skip && b[skip]) && segmentEntersRectAt(px, py, dx, dy, b) !== null) return true;
    }
    i = g.k;
  }
  for (; i < solids.length; i++) {
    const b = solids[i]!;
    if (!(skip && b[skip]) && segmentEntersRectAt(px, py, dx, dy, b) !== null) return true;
  }
  return false;
}

/** Every solid the segment (p, p + d) enters and where (0..1), in `solids` order, leaving out those flagged `skip`. */
export function segmentHits<T extends Rect>(solids: readonly T[], px: number, py: number, dx: number, dy: number, skip?: 'nb' | 'ns'): { t: number; b: T }[] {
  const out: { t: number; b: T }[] = [];
  const g = prefixGrid(solids);
  let i = 0;
  if (g) {
    const n = g.segment(px, py, dx, dy, true);
    for (let j = 0; j < n; j++) {
      const b = g.rects[g.buf[j]!] as T;
      if (skip && b[skip]) continue;
      const t = segmentEntersRectAt(px, py, dx, dy, b);
      if (t !== null) out.push({ t, b });
    }
    i = g.k;
  }
  for (; i < solids.length; i++) {
    const b = solids[i]!;
    if (skip && b[skip]) continue;
    const t = segmentEntersRectAt(px, py, dx, dy, b);
    if (t !== null) out.push({ t, b });
  }
  return out;
}

/** Whether a circle at (x, y) of radius `r` overlaps any of `solids`. */
export function circleBlocked(solids: readonly Rect[], x: number, y: number, r: number): boolean {
  const g = prefixGrid(solids);
  let i = 0;
  if (g) {
    const n = g.box(x - r, y - r, x + r, y + r, false);
    for (let j = 0; j < n; j++) if (circleHitsRect(x, y, r, g.rects[g.buf[j]!]!)) return true;
    i = g.k;
  }
  for (; i < solids.length; i++) if (circleHitsRect(x, y, r, solids[i]!)) return true;
  return false;
}

/** The circle `resolveCircle` is settling; module state so a push allocates nothing (it never re-enters). */
let atX = 0, atY = 0, bent = false;

function pushOff(b: Rect, r: number): void {
  const x = atX, y = atY;
  const cx = clamp(x, b.x, b.x + b.w), cy = clamp(y, b.y, b.y + b.h);
  const d2 = dist2(x, y, cx, cy);
  if (d2 >= r * r) return;
  if (b.pts) {
    const out = pushOutConvex(x, y, r, b.pts);
    if (out) { atX = out.x; atY = out.y; bent = true; }
    return;
  }
  if (d2 > 0) {
    const d = Math.sqrt(d2);
    atX = cx + ((x - cx) / d) * r;
    atY = cy + ((y - cy) / d) * r;
  } else {
    const exits = [
      { x: b.x - r, y, depth: x - b.x },
      { x: b.x + b.w + r, y, depth: b.x + b.w - x },
      { x, y: b.y - r, depth: y - b.y },
      { x, y: b.y + b.h + r, depth: b.y + b.h - y },
    ];
    const shallowest = exits.reduce((m, o) => (o.depth < m.depth ? o : m));
    atX = shallowest.x;
    atY = shallowest.y;
  }
}

function settleOff(b: Rect, r: number): void {
  if (!b.pts) return;
  if (dist2(atX, atY, clamp(atX, b.x, b.x + b.w), clamp(atY, b.y, b.y + b.h)) >= r * r) return;
  const out = pushOutConvex(atX, atY, r, b.pts);
  if (out) { atX = out.x; atY = out.y; bent = true; }
}

/**
 * Runs `visit` over `solids` in order, as a linear pass would, but through the grid: only the solids near the circle. A solid
 * left out is one the circle cannot reach while it stays inside the box the candidates were taken for, so visiting it would do
 * nothing; if a push carries the circle out of that box, the pass carries on linearly from there.
 */
function sweep(solids: readonly Rect[], r: number, visit: (b: Rect, r: number) => void): void {
  const g = prefixGrid(solids);
  let i = 0;
  if (g) {
    const reach = 2 * r;
    const x0 = atX - reach, y0 = atY - reach, x1 = atX + reach, y1 = atY + reach;
    const n = g.box(x0, y0, x1, y1, true);
    i = g.k;
    for (let j = 0; j < n; j++) {
      const id = g.buf[j]!;
      visit(g.rects[id]!, r);
      if (atX - r <= x0 + 0.5 || atX + r >= x1 - 0.5 || atY - r <= y0 + 0.5 || atY + r >= y1 - 0.5) { i = id + 1; break; }
    }
  }
  // The rest (door leaves, crates, barrels, props) linearly, passing over at a glance any whose box is clear of the circle by a pixel or more.
  for (; i < solids.length; i++) {
    const b = solids[i]!;
    if (b.x > atX + r + 1 || b.y > atY + r + 1 || b.x + b.w < atX - r - 1 || b.y + b.h < atY - r - 1) continue;
    visit(b, r);
  }
}

function resolveCircle(solids: readonly Rect[], nx: number, ny: number, r: number, size: number): { x: number; y: number } {
  atX = clamp(nx, r, size - r);
  atY = clamp(ny, r, size - r);
  bent = false;
  sweep(solids, r, pushOff);
  // Pushed off a polygon, the push can land in a neighbour (an angled hull next to a wall), so settle again.
  for (let pass = 0; bent && pass < 3; pass++) {
    bent = false;
    sweep(solids, r, settleOff);
  }
  return { x: clamp(atX, r, size - r), y: clamp(atY, r, size - r) };
}

type MoveKeys = Pick<InputState, 'up' | 'down' | 'left' | 'right'>;
/** A shove still bleeding off, in px/s (see `KNOCK`). */
export type Knock = { vx: number; vy: number };
export type Motion = { x: number; y: number; dash: Dash | null; knock?: Knock | null };

/** Adds a shove of `mag` px/s along (dirX, dirY) to whatever one is running, the sum held to `cap`. */
export function addKnock(k: Knock | null | undefined, dirX: number, dirY: number, mag: number, cap: number): Knock {
  const len = Math.hypot(dirX, dirY);
  let vx = (k?.vx ?? 0) + (len > 0 ? (dirX / len) * mag : 0), vy = (k?.vy ?? 0) + (len > 0 ? (dirY / len) * mag : 0);
  const speed = Math.hypot(vx, vy);
  if (speed > cap) { vx = (vx / speed) * cap; vy = (vy / speed) * cap; }
  return { vx, vy };
}

/** A shove after `dtMs` of bleeding off, or null once it is too slow to matter. */
export function decayKnock(k: Knock, dtMs: number): Knock | null {
  const f = Math.exp(-dtMs / KNOCK.tauMs);
  const vx = k.vx * f, vy = k.vy * f;
  return Math.hypot(vx, vy) < KNOCK.floor ? null : { vx, vy };
}

const keyAxes = (keys: MoveKeys) => ({ mx: (keys.right ? 1 : 0) - (keys.left ? 1 : 0), my: (keys.down ? 1 : 0) - (keys.up ? 1 : 0) });

export function startDash(input: MoveKeys & Pick<InputState, 'angle'>): Dash {
  const { mx, my } = keyAxes(input);
  const len = Math.hypot(mx, my);
  return len > 0
    ? { dirX: mx / len, dirY: my / len, leftMs: DASH_MS }
    : { dirX: Math.cos(input.angle), dirY: Math.sin(input.angle), leftMs: DASH_MS };
}

export function slide(solids: readonly Rect[], x: number, y: number, dx: number, dy: number, r: number, size: number): { x: number; y: number } {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / MAX_SUBSTEP));
  let at = { x, y };
  for (let i = 0; i < steps; i++) at = resolveCircle(solids, at.x + dx / steps, at.y + dy / steps, r, size);
  return at;
}

export const KNIFE_LUNGE = 90;
export const KNIFE_REACH = 70;
const KNIFE_ARC = Math.PI / 3;

type Point = { x: number; y: number };

const insideWorld = (x: number, y: number, size: number) =>
  x >= WORLD.playerRadius && x <= size - WORLD.playerRadius && y >= WORLD.playerRadius && y <= size - WORLD.playerRadius;

function knifeTarget<T extends Point>(at: Point, angle: number, enemies: readonly T[], solids: readonly Rect[]): T | null {
  let best: T | null = null, bestD = Infinity;
  for (const v of enemies) {
    const d = Math.sqrt(dist2(at.x, at.y, v.x, v.y));
    if (d > KNIFE_REACH + WORLD.playerRadius || d >= bestD) continue;
    if (d > WORLD.playerRadius && angleDiff(Math.atan2(v.y - at.y, v.x - at.x), angle) > KNIFE_ARC) continue;
    if (segmentBlocked(solids, at.x, at.y, v.x - at.x, v.y - at.y)) continue;
    best = v;
    bestD = d;
  }
  return best;
}

export function knifeLunge<T extends Point>(solids: readonly Rect[], from: Point, angle: number, enemies: readonly T[], size: number): Point & { victim: T | null } {
  const steps = Math.ceil(KNIFE_LUNGE / MAX_SUBSTEP);
  const sx = (Math.cos(angle) * KNIFE_LUNGE) / steps, sy = (Math.sin(angle) * KNIFE_LUNGE) / steps;
  let { x, y } = from;
  let victim = knifeTarget(from, angle, enemies, solids);
  for (let i = 0; i < steps && !victim; i++) {
    const nx = x + sx, ny = y + sy;
    if (!insideWorld(nx, ny, size) || circleBlocked(solids, nx, ny, WORLD.playerRadius)) break;
    x = nx;
    y = ny;
    victim = knifeTarget({ x, y }, angle, enemies, solids);
  }
  return { x, y, victim };
}

/** Walking, dashing and being shoved: the shove slides through the same collision as a step, so nobody is pushed into a wall. */
export function moveStep(solids: readonly Rect[], from: Motion, keys: MoveKeys, speed: number, dtMs: number, size: number): Motion {
  const walked = walkStep(solids, from, keys, speed, dtMs, size);
  const k = from.knock;
  if (!k) return walked;
  const at = slide(solids, walked.x, walked.y, (k.vx * dtMs) / 1000, (k.vy * dtMs) / 1000, WORLD.playerRadius, size);
  return { ...walked, x: at.x, y: at.y, knock: decayKnock(k, dtMs) };
}

function walkStep(solids: readonly Rect[], from: Motion, keys: MoveKeys, speed: number, dtMs: number, size: number): Motion {
  const { dash } = from;
  if (dash) {
    const d = (DASH_DISTANCE * Math.min(dtMs, dash.leftMs)) / DASH_MS;
    const leftMs = dash.leftMs - dtMs;
    return { ...slide(solids, from.x, from.y, dash.dirX * d, dash.dirY * d, WORLD.playerRadius, size), dash: leftMs > 0 ? { ...dash, leftMs } : null };
  }
  const { mx, my } = keyAxes(keys);
  if (mx === 0 && my === 0) return from;
  const d = (speed * dtMs) / 1000 / Math.hypot(mx, my);
  return { ...slide(solids, from.x, from.y, mx * d, my * d, WORLD.playerRadius, size), dash: null };
}
