import { circleHitsRect, segmentBlocked, type Rect } from '../../shared/sim/movement.ts';

export type Point = { x: number; y: number };

export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const between = (r: readonly [number, number], rand: () => number) => r[0] + rand() * (r[1] - r[0]);

export type NavGrid = {
  size: number; cell: number; n: number; open: Uint8Array;
  /** Which grid this is, for a bot to remember the grid it routed on without holding the grid itself. */
  serial: number;
  scratch: { g: Float64Array; from: Int32Array; seen: Uint32Array; stamp: number; heapC: number[]; heapF: number[] };
  /**
   * Searches already run on this grid, by start and goal cell (see `findPath`): a grid never changes once built (a change of solids is a new
   * grid), so the same two cells and budget always give the same cells back. Most recently used last; `PATHS_KEPT` at most.
   */
  paths: Map<number, Found>;
  /** Distance fields to the map's fixed goals (its zones and team spawns), shared by every copy of the grid; see `flowField`. */
  fields: Map<number, Float32Array>;
};

const NAV_CELL = 25;
const ORTH = 1, DIAG = Math.SQRT2;
const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
const SNAP_CELLS = 4;

let serials = 0;
/** Every grid built, weakly, for the dev load log (`navStats`): how many are alive and what their memos hold. */
const LIVE = new Set<WeakRef<NavGrid>>();
const track = (g: NavGrid): NavGrid => { LIVE.add(new WeakRef(g)); return g; };

/** Grids still alive and the paths and distance fields they hold (dev measurement; see SKIRMISH_NETSTATS in main.ts). */
export function navStats(): { grids: number; paths: number; fields: number; fieldMb: number } {
  let grids = 0, paths = 0, fieldBytes = 0;
  const fieldMaps = new Set<Map<number, Float32Array>>();
  for (const ref of LIVE) {
    const g = ref.deref();
    if (!g) { LIVE.delete(ref); continue; }
    grids++;
    paths += g.paths.size;
    fieldMaps.add(g.fields);
  }
  let fields = 0;
  for (const m of fieldMaps) for (const f of m.values()) { fields++; fieldBytes += f.byteLength; }
  return { grids, paths, fields, fieldMb: +(fieldBytes / 1e6).toFixed(1) };
}

export function navGrid(size: number, solids: readonly Rect[], radius: number, cell = NAV_CELL): NavGrid {
  const n = Math.ceil(size / cell);
  const open = new Uint8Array(n * n);
  const centre = (c: number) => (c + 0.5) * cell;
  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      const x = centre(cx), y = centre(cy);
      if (x >= radius && y >= radius && x <= size - radius && y <= size - radius) open[cy * n + cx] = 1;
    }
  }
  for (const r of solids) stamp(open, n, cell, radius, r);
  return track({ size, cell, n, open, serial: ++serials, scratch: { g: new Float64Array(n * n), from: new Int32Array(n * n), seen: new Uint32Array(n * n), stamp: 0, heapC: [], heapF: [] }, paths: new Map(), fields: new Map() });
}

function stamp(open: Uint8Array, n: number, cell: number, radius: number, r: Rect) {
  const centre = (c: number) => (c + 0.5) * cell;
  const x0 = Math.max(0, Math.floor((r.x - radius) / cell)), x1 = Math.min(n - 1, Math.floor((r.x + r.w + radius) / cell));
  const y0 = Math.max(0, Math.floor((r.y - radius) / cell)), y1 = Math.min(n - 1, Math.floor((r.y + r.h + radius) / cell));
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) if (circleHitsRect(centre(cx), centre(cy), radius, r)) open[cy * n + cx] = 0;
}

export function withSolids(base: NavGrid, solids: readonly Rect[], radius: number): NavGrid {
  const open = base.open.slice();
  for (const r of solids) stamp(open, base.n, base.cell, radius, r);
  // Its own path memo (the open cells differ), but the base grid's distance fields: a path read off one is checked against these cells.
  return track({ ...base, open, serial: ++serials, paths: new Map() });
}

const cellOf = (nav: NavGrid, p: Point) => {
  const cx = Math.min(nav.n - 1, Math.max(0, Math.floor(p.x / nav.cell))), cy = Math.min(nav.n - 1, Math.max(0, Math.floor(p.y / nav.cell)));
  return cy * nav.n + cx;
};
const centreOf = (nav: NavGrid, c: number): Point => ({ x: ((c % nav.n) + 0.5) * nav.cell, y: (Math.floor(c / nav.n) + 0.5) * nav.cell });

/** The centre of the open cell nearest `p` within `px`, or null if everything that close is solid. */
export function nearestOpenPoint(nav: NavGrid, p: Point, px: number): Point | null {
  const c = nearestOpen(nav, p, Math.ceil(px / nav.cell));
  return c === null ? null : centreOf(nav, c);
}

export const isOpen = (nav: NavGrid, p: Point) => nav.open[cellOf(nav, p)] === 1;

function nearestOpen(nav: NavGrid, p: Point, reach = SNAP_CELLS): number | null {
  const c = cellOf(nav, p);
  if (nav.open[c]) return c;
  const cx = c % nav.n, cy = Math.floor(c / nav.n);
  let best: number | null = null, bestD = Infinity;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= nav.n || y >= nav.n || !nav.open[y * nav.n + x]) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = y * nav.n + x; }
    }
  }
  return best;
}

export function walkable(nav: NavGrid, a: Point, b: Point): boolean {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (nav.cell / 2));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    if (!nav.open[cellOf(nav, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })]) return false;
  }
  return true;
}

const PATHS_KEPT = 256;

/**
 * A search's answer: the cells after the start (none when there is no way), whether they reach the goal, and how many cells it opened
 * with the `budget` it was given. A search that finished inside its budget comes out the same with any budget at least that big; one
 * that ran out of budget, only with the same budget.
 */
type Found = { budget: number; expanded: number; found: boolean; cells: Int32Array; end?: Point };
const holds = (f: Found, budget: number) => (f.expanded <= f.budget ? budget >= f.expanded : budget === f.budget);

/**
 * A walkable way from `from` to `to`, smoothed to the fewest straight legs, or null when there is none. With a finite `maxExpansions` a
 * far goal the search gives up on returns the way to the cell it got nearest. The cells between are remembered per grid (`NavGrid.paths`)
 * by start and goal cell, and read off a distance field when the goal lies by one of the map's fixed goals (`flowField`), so a squad
 * making for the same place, or a bot asking again, does not search again. Either way the answer is the one the search would give.
 */
export function findPath(nav: NavGrid, from: Point, to: Point, maxExpansions = Infinity): Point[] | null {
  const start = nearestOpen(nav, from), goal = nearestOpen(nav, to);
  if (start === null || goal === null) return null;
  const end = nav.open[cellOf(nav, to)] ? to : centreOf(nav, goal);
  if (walkable(nav, from, end)) return [end];
  const key = start * nav.n * nav.n + goal;
  let hit = nav.paths.get(key);
  // A route read off a field stops descending where the exact goal point comes into a straight walk, so with a field near, the
  // answer is remembered for that point (`end`), not for any point in the goal's cell.
  if (hit !== undefined && holds(hit, maxExpansions) && (hit.end === undefined || (hit.end.x === end.x && hit.end.y === end.y))) nav.paths.delete(key);
  else {
    const near = fieldsNear(nav, start, goal);
    hit = (near.length ? fieldCells(nav, near, start, goal, end) : null) ?? search(nav, start, goal, maxExpansions);
    if (near.length) hit = { ...hit, end: { x: end.x, y: end.y } };
  }
  nav.paths.set(key, hit);
  if (nav.paths.size > PATHS_KEPT) nav.paths.delete(nav.paths.keys().next().value!);
  if (hit.cells.length === 0) return hit.found ? [] : null;
  const cells: Point[] = Array.from(hit.cells, (c) => centreOf(nav, c));
  if (hit.found) cells[cells.length - 1] = end;
  return smooth(nav, from, cells);
}

/** A* from cell `start` to cell `goal`: the cells after `start` up to the goal (or, out of budget, up to the nearest it reached). */
function search(nav: NavGrid, start: number, goal: number, maxExpansions: number): Found {
  const { n, open } = nav;
  const s = nav.scratch;
  s.stamp++;
  const gx = goal % n, gy = Math.floor(goal / n);
  const h = (c: number) => {
    const dx = Math.abs((c % n) - gx), dy = Math.abs(Math.floor(c / n) - gy);
    return Math.max(dx, dy) + (DIAG - 1) * Math.min(dx, dy);
  };
  const hc = s.heapC, hf = s.heapF;
  hc.length = 0;
  hf.length = 0;
  const push = (c: number, f: number) => {
    let i = hc.length;
    hc.push(c);
    hf.push(f);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (hf[up]! <= f) break;
      hc[i] = hc[up]!;
      hf[i] = hf[up]!;
      i = up;
    }
    hc[i] = c;
    hf[i] = f;
  };
  const pop = (): number => {
    const top = hc[0]!;
    const c = hc.pop()!, f = hf.pop()!;
    const len = hc.length;
    if (len > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = -1, mf = f;
        if (l < len && hf[l]! < mf) { m = l; mf = hf[l]!; }
        if (r < len && hf[r]! < mf) { m = r; mf = hf[r]!; }
        if (m < 0) break;
        hc[i] = hc[m]!;
        hf[i] = hf[m]!;
        i = m;
      }
      hc[i] = c;
      hf[i] = f;
    }
    return top;
  };
  const known = (c: number) => s.seen[c] === s.stamp;
  s.seen[start] = s.stamp;
  s.g[start] = 0;
  s.from[start] = -1;
  push(start, h(start));
  let found = false, expanded = 0, best = start, bestH = h(start);
  while (hc.length > 0) {
    const f = hf[0]!;
    const c = pop();
    if (c === goal) { found = true; break; }
    if (++expanded > maxExpansions) break;
    const hc0 = h(c);
    if (hc0 < bestH) { best = c; bestH = hc0; }
    if (f > s.g[c]! + h(c) + 1e-9) continue;
    const cx = c % n, cy = Math.floor(c / n);
    for (const [dx, dy] of NEIGHBORS) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const next = y * n + x;
      if (!open[next]) continue;
      if (dx !== 0 && dy !== 0 && (!open[cy * n + x] || !open[y * n + cx])) continue;
      const g = s.g[c]! + (dx !== 0 && dy !== 0 ? DIAG : ORTH);
      if (known(next) && g >= s.g[next]!) continue;
      s.seen[next] = s.stamp;
      s.g[next] = g;
      s.from[next] = c;
      push(next, g + h(next));
    }
  }
  if (!found && (expanded <= maxExpansions || best === start)) return { budget: maxExpansions, expanded, found, cells: new Int32Array(0) };
  const last = found ? goal : best;
  const cells: number[] = [];
  for (let c = last; c !== start; c = s.from[c]!) cells.push(c);
  cells.reverse();
  return { budget: maxExpansions, expanded, found, cells: Int32Array.from(cells) };
}

/**
 * The walking distance (in cells) from every cell to `goal` over the grid, Infinity where it cannot be reached: one Dijkstra over the
 * whole map, built once per fixed goal (`addField`) so any path that ends there is read straight off it (`fieldCells`).
 */
export function flowField(nav: NavGrid, goal: number): Float32Array {
  const { n, open } = nav;
  const g = new Float32Array(n * n).fill(Infinity);
  if (!open[goal]) return g;
  const hc: number[] = [goal], hf: number[] = [0];
  g[goal] = 0;
  while (hc.length > 0) {
    // A plain binary heap on (cell, distance), popping the nearest.
    const c = hc[0]!, f = hf[0]!;
    const lc = hc.pop()!, lf = hf.pop()!;
    if (hc.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = -1, mf = lf;
        if (l < hc.length && hf[l]! < mf) { m = l; mf = hf[l]!; }
        if (r < hc.length && hf[r]! < mf) { m = r; mf = hf[r]!; }
        if (m < 0) break;
        hc[i] = hc[m]!; hf[i] = hf[m]!; i = m;
      }
      hc[i] = lc; hf[i] = lf;
    }
    if (f > g[c]!) continue;
    const cx = c % n, cy = Math.floor(c / n);
    for (const [dx, dy] of NEIGHBORS) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const next = y * n + x;
      if (!open[next] || (dx !== 0 && dy !== 0 && (!open[cy * n + x] || !open[y * n + cx]))) continue;
      // Rounded as the field stores it, so a distance it already holds is never pushed again.
      const d = Math.fround(f + (dx !== 0 && dy !== 0 ? DIAG : ORTH));
      if (d >= g[next]!) continue;
      g[next] = d;
      let i = hc.length;
      hc.push(next); hf.push(d);
      while (i > 0) {
        const up = (i - 1) >> 1;
        if (hf[up]! <= d) break;
        hc[i] = hc[up]!; hf[i] = hf[up]!; i = up;
      }
      hc[i] = next; hf[i] = d;
    }
  }
  return g;
}

/** Builds and keeps the distance field to the open cell nearest `at` (see `flowField`). */
export function addField(nav: NavGrid, at: Point): void {
  const goal = nearestOpen(nav, at);
  if (goal !== null && !nav.fields.has(goal)) nav.fields.set(goal, flowField(nav, goal));
}

/** How near a fixed goal a path's goal must lie for the path to be read off that goal's field. */
const FIELD_REACH_PX = 320;

/** The distance fields to fixed goals near `goal` that both `start` and `goal` can reach, with where each one's goal is. */
function fieldsNear(nav: NavGrid, start: number, goal: number): { fixedAt: Point; g: Float32Array }[] {
  if (nav.fields.size === 0) return [];
  const goalAt = centreOf(nav, goal);
  const out: { fixedAt: Point; g: Float32Array }[] = [];
  for (const [fixed, g] of nav.fields) {
    const fixedAt = centreOf(nav, fixed);
    if (dist(fixedAt, goalAt) <= FIELD_REACH_PX && Number.isFinite(g[start]!) && Number.isFinite(g[goal]!)) out.push({ fixedAt, g });
  }
  return out;
}

/**
 * The cells from `start` toward `goal` read off a distance field to a fixed goal near it (`fieldsNear`): downhill along the field until the
 * real goal is in a straight walk, then the goal. Null when the way down crosses a cell this grid has shut (the field is the base map's; a
 * barrel or a building may stand on it), so the caller searches instead.
 */
function fieldCells(nav: NavGrid, fields: readonly { fixedAt: Point; g: Float32Array }[], start: number, goal: number, end: Point): Found | null {
  const { n, open } = nav;
  const goalAt = centreOf(nav, goal);
  for (const { fixedAt, g } of fields) {
    const cells: number[] = [];
    let c = start, ok = true;
    const near = (dist(fixedAt, goalAt) + FIELD_REACH_PX) / nav.cell;
    while (c !== goal) {
      if (g[c]! <= near && walkable(nav, centreOf(nav, c), end)) { cells.push(goal); break; }
      const cx = c % n, cy = Math.floor(c / n);
      let best = -1, bestD = g[c]!;
      for (const [dx, dy] of NEIGHBORS) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const next = y * n + x;
        if (dx !== 0 && dy !== 0 && (!open[cy * n + x] || !open[y * n + cx])) continue;
        if (g[next]! < bestD) { best = next; bestD = g[next]!; }
      }
      if (best < 0 || !open[best] || cells.length > n * 4) { ok = false; break; }
      cells.push(best);
      c = best;
    }
    if (ok) return { budget: Infinity, expanded: 0, found: true, cells: Int32Array.from(cells) };
  }
  return null;
}

function smooth(nav: NavGrid, from: Point, cells: Point[]): Point[] {
  const out: Point[] = [];
  let at = from;
  for (let i = 0; i < cells.length;) {
    let j = i;
    while (j + 1 < cells.length && walkable(nav, at, cells[j + 1]!)) j++;
    out.push(cells[j]!);
    at = cells[j]!;
    i = j + 1;
  }
  return out;
}

export function clearShot(rects: readonly Rect[], a: Point, b: Point): boolean {
  return !segmentBlocked(rects, a.x, a.y, b.x - a.x, b.y - a.y);
}
