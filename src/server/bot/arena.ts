import { WORLD } from '../../shared/defs.ts';
import type { MapDoor } from '../../shared/geom.ts';
import { landmarks, MAPS, type MapId } from '../../shared/maps.ts';
import { doorAuto, doorLeaves, isSwing, mapDoors } from '../../shared/sim/doors.ts';
import { circleHitsRect } from '../../shared/sim/movement.ts';
import type { WallView } from '../../shared/protocol.ts';
import { segmentBlocked, type Rect } from '../../shared/sim/movement.ts';
import { barrelRect, crateRect, createWorld, propRect, propSolid, type Crate, type Wall, type World } from '../../shared/sim/world.ts';
import { coverIndex, type CoverIndex } from './cover.ts';
import { addField, isOpen, navGrid, nearestOpenPoint, withSolids, type NavGrid, type Point } from './nav.ts';

export type BotArena = {
  size: number;
  version: number;
  /** What stops a round: map walls, polygon parts, built walls and door leaves (not low cover flagged `nb`). */
  walls: readonly WallView[];
  /** What stops sight (not glass or other walls flagged `ns`). */
  sightWalls: readonly WallView[];
  /** Barrels and props standing now: solid to bodies and bullets, and in `nav`. */
  barrels: readonly Rect[];
  nav: NavGrid;
  cover: CoverIndex;
  replans: { tick: number; left: number };
  /** The map's doors, for bots that hold an angle on one or wait their turn at one. */
  doors: readonly MapDoor[];
  /** Swing leaves standing open (or swinging open), where they stand once open: solids that come and go, not in `nav` (see `swingLeaves`). */
  leaves: readonly StandingLeaf[];
  /** Swing doors whose leaves are on the move (or held part way on a body), where they are and which way they are going (see `inSweep` in motor.ts). */
  swings: readonly SwingingLeaf[];
};

export type SwingingLeaf = { door: number; open: number; sign: 1 | -1; opening: boolean };

/** A swing door's leaves where they stand wide open, `key` naming the door and the side they stand on, `box` round them all. */
export type StandingLeaf = { key: string; rects: readonly Rect[]; box: Rect };

/**
 * The swing leaves that stand out from their wall now: every swing door open or swinging open, with its leaves where they will
 * stand (a leaf on its way there, or held up on a body in its sweep, gets there soon; a bot routed round its half-way spot would
 * only walk into it later). A door swinging shut is not one: it ends in its doorway, which a bot pushes open again. Nor is a
 * slider, whose panels open into its wall. Doors are not in the nav grid (they open), so a bot routes round these on a grid of
 * its own (`navAround`) only when its route runs into one (see `leafAhead` in motor.ts).
 */
function swingLeaves(w: World): Pick<BotArena, 'leaves' | 'swings'> {
  const defs = mapDoors(w.map);
  if (!defs.length) return { leaves: [], swings: [] };
  const out: StandingLeaf[] = [], swings: SwingingLeaf[] = [];
  for (const s of w.doors) {
    const d = defs[s.idx]!;
    if (!isSwing(d) || d.locked) continue;
    if (s.open !== s.target) swings.push({ door: s.idx, open: s.open, sign: s.sign, opening: s.target === 255 });
    if (s.open === 0 || s.target !== 255) continue;
    const rects = doorLeaves(d, 255, s.sign);
    const x0 = Math.min(...rects.map((r) => r.x)), y0 = Math.min(...rects.map((r) => r.y));
    const x1 = Math.max(...rects.map((r) => r.x + r.w)), y1 = Math.max(...rects.map((r) => r.y + r.h));
    out.push({ key: `${s.idx}${s.sign > 0 ? '+' : '-'}`, rects, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  }
  return { leaves: out, swings };
}

/** How far clear of a standing leaf a route on `navAround` keeps, past a body's radius (a cell is 25 px; a smoothed leg cuts corners). */
const LEAF_PAD_PX = 6;
const LEAF_NAVS_KEPT = 12;
/** Grids with standing leaves stamped in, by base grid and the leaves' keys: the same few doors open and shut all round, and a squad shares one. */
const LEAF_NAVS = new WeakMap<NavGrid, Map<string, NavGrid>>();

/** The nav grid with the standing leaves named by `keys` in it as solids (those still standing); the plain grid when none are. */
export function navAround(a: BotArena, keys: readonly string[]): NavGrid {
  const leaves = keys.length ? a.leaves.filter((l) => keys.includes(l.key)) : [];
  if (!leaves.length) return a.nav;
  const key = leaves.map((l) => l.key).sort().join();
  let kept = LEAF_NAVS.get(a.nav);
  if (!kept) LEAF_NAVS.set(a.nav, (kept = new Map()));
  let nav = kept.get(key);
  if (nav) kept.delete(key);
  else nav = withSolids(a.nav, leaves.flatMap((l) => l.rects), WORLD.playerRadius + LEAF_PAD_PX);
  kept.set(key, nav);
  if (kept.size > LEAF_NAVS_KEPT) kept.delete(kept.keys().next().value!);
  return nav;
}

const LEAF_STEP_PX = 8;
/** A body touching a leaf this close counts as running into it (what the bot's stuck checks would see as rubbing). */
const LEAF_TOUCH_PX = 2;

/** The standing leaves (other than those in `skip`) a body walking straight from `a` to `b` would run into, added to `out`. */
export function leavesCrossed(arena: BotArena, a: Point, b: Point, skip: readonly string[] = [], out: StandingLeaf[] = []): StandingLeaf[] {
  const r = WORLD.playerRadius + LEAF_TOUCH_PX;
  const len = Math.hypot(b.x - a.x, b.y - a.y), steps = Math.max(1, Math.ceil(len / LEAF_STEP_PX));
  for (const l of arena.leaves) {
    const { box } = l;
    if (out.includes(l) || skip.includes(l.key) || Math.max(a.x, b.x) < box.x - r || Math.min(a.x, b.x) > box.x + box.w + r || Math.max(a.y, b.y) < box.y - r || Math.min(a.y, b.y) > box.y + box.h + r) continue;
    for (let i = 0; i <= steps; i++) {
      const x = a.x + ((b.x - a.x) * i) / steps, y = a.y + ((b.y - a.y) * i) / steps;
      if (l.rects.some((rect) => circleHitsRect(x, y, r, rect))) { out.push(l); break; }
    }
  }
  return out;
}

/** Whether a body walks straight from `a` to `b` clear of every standing leaf (see `leavesCrossed`). */
export const clearOfLeaves = (arena: BotArena, a: Point, b: Point): boolean => arena.leaves.length === 0 || leavesCrossed(arena, a, b).length === 0;

const REPLANS_PER_TICK = 3;

export function takeReplan(a: BotArena, tick: number): boolean {
  if (a.replans.tick !== tick) a.replans = { tick, left: REPLANS_PER_TICK };
  if (a.replans.left <= 0) return false;
  a.replans.left--;
  return true;
}

type Layout = { walls: readonly Wall[]; crates: readonly Crate[]; nav: NavGrid; cover: CoverIndex };

const ARENAS = new WeakMap<World, { arena: BotArena; layout: Layout; solids: readonly Rect[]; wallsVersion: number; drops: string }>();

const same = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameLayout = (l: Layout, walls: readonly Wall[], crates: readonly Crate[]) => same(l.crates, crates) && same(l.walls, walls);

/**
 * Supply drops (an airdrop's crate, a Last Squad drop) land and break during a round, so they are solids that come and go, like barrels,
 * not part of the map's layout: a landing would otherwise rebuild the whole grid (and file a one-off layout under its own key), and a
 * broken one would stay a wall in the grid until the map changes. `drops` names the ones standing (a landing, a break or an expiry also moves `wallsVersion`).
 */
const dropsStanding = (w: World) => w.crates.filter((c) => c.drop && c.respawnAt === null);
const dropsKey = (w: World) => dropsStanding(w).map((c) => c.id).join();

const sameRects = (a: readonly Rect[], b: readonly Rect[]) =>
  a.length === b.length && a.every((r, i) => { const o = b[i]!; return r === o || (r.x === o.x && r.y === o.y && r.w === o.w && r.h === o.h && r.pts === o.pts); });

export function arenaFor(w: World): BotArena {
  const cached = ARENAS.get(w);
  const version = w.wallsVersion + w.doorsVersion;
  const drops = dropsKey(w);
  if (cached && cached.arena.version === version && cached.drops === drops) return cached.arena;
  if (cached && cached.wallsVersion === w.wallsVersion && cached.drops === drops) {
    // Only a door leaf moved: the same grid, cover and solids, with the leaves where they are now.
    const arena = { ...cached.arena, version, walls: w.walls.filter((wall) => !wall.nb), sightWalls: w.walls.filter((wall) => !wall.ns), replans: { tick: -1, left: 0 }, ...swingLeaves(w) };
    ARENAS.set(w, { ...cached, arena });
    return arena;
  }
  const size = MAPS[w.map].size;
  const mapWalls = w.walls.filter((wall) => !wall.built && wall.door === undefined);
  const mapCrates = w.crates.filter((c) => !c.drop);
  const layout = cached && sameLayout(cached.layout, mapWalls, mapCrates) ? cached.layout : mapLayout(size, mapWalls, mapCrates, w.map);
  const barrels = [...w.barrels.filter((b) => b.respawnAt === null).map(barrelRect), ...w.props.filter(propSolid).map(propRect)];
  const solids: Rect[] = [...w.walls.filter((wall) => wall.built), ...barrels, ...dropsStanding(w).map(crateRect)];
  // A door swinging changes the version every tick it moves, but not the nav grid (doors are not in it): keep the one built for the same solids.
  const nav = cached && cached.layout === layout && sameRects(cached.solids, solids) ? cached.arena.nav : solids.length ? withSolids(layout.nav, solids, WORLD.playerRadius) : layout.nav;
  const arena: BotArena = {
    size, version, walls: w.walls.filter((wall) => !wall.nb), sightWalls: w.walls.filter((wall) => !wall.ns), barrels, cover: layout.cover, replans: { tick: -1, left: 0 }, doors: mapDoors(w.map), nav, ...swingLeaves(w),
  };
  ARENAS.set(w, { arena, layout, solids, wallsVersion: w.wallsVersion, drops });
  return arena;
}

/** Doors a bot cannot pass: locked ones, and sliders that wait for a button. Every other door is open road to the planner. */
const shutDoors = (map: MapId): Rect[] => mapDoors(map).filter((d) => d.locked || (!isSwing(d) && !doorAuto(d))).flatMap((d) => doorLeaves(d, 0, 1));

/**
 * Nav grids and cover indexes by map and crate layout, shared by every room: a map's walls are the same in every world, so a room
 * waking or rotating onto a map another room has played reuses its grids instead of stalling a tick building them (60-100 ms on
 * a wall-heavy map). Nothing changes a layout once built: `withSolids` copies the grid, and the A* scratch is used one search at a time.
 */
const LAYOUTS = new Map<string, { nav: NavGrid; cover: CoverIndex }>();
const LAYOUTS_KEPT = 48;

/** How many map layouts are kept (dev measurement). */
export const layoutCount = (): number => LAYOUTS.size;

function mapLayout(size: number, walls: readonly Wall[], crates: readonly Crate[], map: MapId): Layout {
  // Keyed by the geometry itself, not just the map: a test or the range may lay walls of its own on a map.
  const key = `${map}|${walls.map((r) => `${r.x},${r.y},${r.w},${r.h},${r.pts?.join(',') ?? ''},${r.nb ? 1 : 0}${r.ns ? 1 : 0}`).join(';')}|${crates.map((c) => `${c.x},${c.y},${c.size}`).join(';')}`;
  let built = LAYOUTS.get(key);
  if (!built) {
    built = buildLayout(size, walls, crates, map, shutDoors(map));
    LAYOUTS.set(key, built);
    if (LAYOUTS.size > LAYOUTS_KEPT) LAYOUTS.delete(LAYOUTS.keys().next().value!);
  }
  return { walls, crates, nav: built.nav, cover: built.cover };
}

/** Builds the bot layout of every map ahead of play, one map per call of `next`, so no room pays for it in a tick. */
export function warmLayouts(maps: readonly MapId[], next: (go: () => void) => void): void {
  const left = [...maps];
  const one = () => {
    const map = left.shift();
    if (!map) return;
    // A world fresh on the map has its walls and crates exactly as a room's does, so the layout lands under the room's key.
    arenaFor(createWorld('FFA', 0, map));
    next(one);
  };
  next(one);
}

function buildLayout(size: number, walls: readonly Wall[], crates: readonly Crate[], mapId: MapId, doors: readonly Rect[] = []): Layout {
  const solids: Rect[] = [...walls, ...crates.map(crateRect), ...doors];
  const nav = navGrid(size, solids, WORLD.playerRadius);
  // A distance field to each place bots keep making for (see `flowField` in nav.ts): a route that ends by one is read off it, not searched.
  for (const at of landmarks(mapId)) addField(nav, at);
  return { walls, crates, nav, cover: coverIndex(nav, solids, WORLD.playerRadius, mapDoors(mapId)) };
}


const NEAR_SNAP_PX = 300;

/**
 * A spot a bot can stand on: random tries within `near` (or anywhere), then the nearest open cell to `near.at`, then anywhere.
 * Never a closed point, which a bot would drive at for ever (the route to it is empty, so it walks straight into the wall).
 */
export function openSpot(a: BotArena, rand: () => number, near?: { at: Point; r: number }): Point {
  const tryRandom = (box?: { at: Point; r: number }): Point | null => {
    for (let i = 0; i < 20; i++) {
      const p = box
        ? { x: box.at.x + (rand() * 2 - 1) * box.r, y: box.at.y + (rand() * 2 - 1) * box.r }
        : { x: rand() * a.size, y: rand() * a.size };
      if (p.x > 0 && p.y > 0 && p.x < a.size && p.y < a.size && isOpen(a.nav, p)) return p;
    }
    return null;
  };
  return tryRandom(near) ?? (near ? nearestOpenPoint(a.nav, near.at, NEAR_SNAP_PX) : null) ?? tryRandom() ?? near?.at ?? { x: a.size / 2, y: a.size / 2 };
}

/**
 * Whether a straight line between two points is clear right now: `'shot'` is what stops a round (polygons, closed doors, walls),
 * `'sight'` what stops the eye (glass and other see-through walls do not). Crates and barrels are not counted; add them with `extra`.
 */
export function losClear(arena: BotArena, a: Point, b: Point, kind: 'shot' | 'sight' = 'shot', extra: readonly Rect[] = []): boolean {
  const walls = kind === 'shot' ? arena.walls : arena.sightWalls;
  return !segmentBlocked(walls, a.x, a.y, b.x - a.x, b.y - a.y) && !segmentBlocked(extra, a.x, a.y, b.x - a.x, b.y - a.y);
}

export const doorCentre = (d: MapDoor): Point => (d.axis === 'h' ? { x: d.x + d.w / 2, y: d.y } : { x: d.x, y: d.y + d.w / 2 });

const LANE_STEP_PX = 60;
const LANE_LEN_PX = 420;

/**
 * Points down the line a door opens along, both sides of it, for the doors within `reach` of `near`. Fed to cover choice as ground
 * that is taken, they keep a bot holding a room off the doorway and out of the lane through it: it takes an angle to the side instead.
 */
export function doorLanes(a: BotArena, near: Point, reach: number): Point[] {
  const out: Point[] = [];
  for (const d of a.doors) {
    const c = doorCentre(d);
    if (Math.hypot(c.x - near.x, c.y - near.y) > reach) continue;
    for (let t = -LANE_LEN_PX; t <= LANE_LEN_PX; t += LANE_STEP_PX) out.push(d.axis === 'h' ? { x: c.x, y: c.y + t } : { x: c.x + t, y: c.y });
  }
  return out;
}
