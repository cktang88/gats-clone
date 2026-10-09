import { BUILDING_KINDS, GUNS, nightOf, rulesOf, SIDES, WORLD, ZOM, type BuildingKind, type Side } from '../../shared/defs.ts';
import { DEFAULT_VIEW_ASPECT, viewExtents, type BuildingView, type InputState, type PlayerView, type RunView, type Snapshot } from '../../shared/protocol.ts';
import { cellOf, cellRect, coreRectAt, costOf, levelOf, maxLevelOf, upgradeCost } from '../../shared/sim/build.ts';
import { circleBlocked, circleHitsRect, segmentBlocked, type Rect } from '../../shared/sim/movement.ts';
import type { BotDecision, BotMemory } from '../bots.ts';
import { aimAndTrigger, aimSigma, bearingSpin, drift, engage, freshAim, HANDS, intercept, MUZZLE_PX, SHARPNESS, TICK_MS, type Engagement, type Look } from './aim.ts';
import type { BotArena } from './arena.ts';
import { findPath, isOpen, walkable, withSolids, type NavGrid, type Point } from './nav.ts';
import { ABILITY_RULES, HURTING_HP_FRAC, type Situation } from './motor.ts';

export const DEAD_ZONE = 30;
const STEP_HOLD_TICKS = 15;
const KITE_HOLD_TICKS = 5;
const STEP_GOAL_SLACK = 40;
const UNDER_FIRE_TICKS = Math.round(500 / TICK_MS);

const nearest = <T extends { x: number; y: number }>(me: { x: number; y: number }, xs: readonly T[]): T | null =>
  xs.reduce<T | null>((best, x) => (best && Math.hypot(best.x - me.x, best.y - me.y) <= Math.hypot(x.x - me.x, x.y - me.y) ? best : x), null);

type Watch = {
  me: PlayerView;
  core: { x: number; y: number };
  post: { x: number; y: number };
  zombie: { id: number; x: number; y: number; d: number } | null;
  /** Every zombie in sight, and those lately out of it where they were last seen (see `SiegeMemory`). */
  zombies: readonly { x: number; y: number }[];
  downed: PlayerView | null;
  needsTending: { x: number; y: number } | null;
  dry: { x: number; y: number } | null;
  tending: { x: number; y: number } | null;
  kiting: boolean;
  /** Where the bot was backing off to, if it was. */
  kiteTo: { x: number; y: number } | null;
  coreMendable: boolean;
  /** Whether it can walk straight from where it stands to a spot, past the map, the core and the buildings (see `clearWalk`). */
  clear: (to: { x: number; y: number }) => boolean;
  next: { act: 'build' | 'upgrade'; kind: BuildingKind; lv: number; cx: number; cy: number; x: number; y: number } | null;
};

type Errand = { x: number; y: number; use: boolean };

/**
 * Zombies a squad bot has had in sight lately, where it last saw them. One that slips out of view is still there, so a job judged clear of
 * zombies is judged on these, not only on what is in view this moment: otherwise a step toward a job that brought one into view would drop it,
 * the step back would lose sight of it and take the job up again, and the bot would shuttle at the edge of its view.
 */
export type SiegeMemory = { zombies: readonly { id: number; x: number; y: number; tick: number }[] };
/** How long a zombie out of view is kept in mind; one whose spot comes back into view without it is let go at once. */
const REMEMBER_TICKS = Math.round(2000 / TICK_MS);

const GUARD_RADIUS = 550;
const WHOLE_TENTHS = 10;
const DRY_TENTHS = 2;
/** A turret is topped up once it is down to this, not after every shot, so a squadmate's top-up never flips a bot between the turret and its post. */
const LOW_TENTHS = 7;
const CORE_EMERGENCY_FRAC = 0.5;
const HUMANS_RESERVE = Math.max(...BUILDING_KINDS.map((k) => costOf(k)));
const POST_RADIUS = 320;
const BUSY_ZOMBIE_PX = 300;
const KITE_PX = 140;

/** A job already under way carries on until a zombie is this much nearer than the distance that lets one start. */
const BUSY_SLACK_PX = 80;
const MEND_PX = ZOM.reachPx - 60;
const mendAt = (s: Watch, at: { x: number; y: number }): Errand => ({ ...at, use: Math.hypot(at.x - s.me.x, at.y - s.me.y) <= MEND_PX });
/** How near a zombie comes to the walk from `me` to where it stands to mend `at`. */
function nearestOnTheWay(s: Watch, at: { x: number; y: number }): number {
  const dx = s.me.x - at.x, dy = s.me.y - at.y, len = Math.hypot(dx, dy);
  const stand = len > MEND_PX ? { x: at.x + (dx * MEND_PX) / len, y: at.y + (dy * MEND_PX) / len } : s.me;
  const sx = stand.x - s.me.x, sy = stand.y - s.me.y, sl = sx * sx + sy * sy;
  return s.zombies.reduce((best, z) => {
    const u = sl > 0 ? Math.max(0, Math.min(1, ((z.x - s.me.x) * sx + (z.y - s.me.y) * sy) / sl)) : 0;
    return Math.min(best, Math.hypot(z.x - s.me.x - u * sx, z.y - s.me.y - u * sy));
  }, Infinity);
}
/**
 * A job starts only while no zombie is near the walk to it, and is dropped once one comes `BUSY_SLACK_PX` nearer. Measured along the walk rather than
 * from the bot, since walking toward a zombie by the job would otherwise close the gap itself, drop the job, walk back out, and pick it up again.
 */
const hordeFar = (s: Watch, at: { x: number; y: number }) => nearestOnTheWay(s, at) > BUSY_ZOMBIE_PX - (s.tending?.x === at.x && s.tending.y === at.y ? BUSY_SLACK_PX : 0);

type Rule = (s: Watch) => Errand | null;

const revive: Rule = (s) => s.downed && { x: s.downed.x, y: s.downed.y, use: Math.hypot(s.downed.x - s.me.x, s.downed.y - s.me.y) <= ZOM.reviveRange - 15 };
const mendBuilding: Rule = (s) => s.needsTending && hordeFar(s, s.needsTending) ? mendAt(s, s.needsTending) : null;
const refillDry: Rule = (s) => s.dry && !kiting(s) ? mendAt(s, s.dry) : null;
const mendCore: Rule = (s) => s.coreMendable && hordeFar(s, s.core) ? mendAt(s, s.core) : null;
const buildNext: Rule = (s) => s.next && { x: s.next.x, y: s.next.y, use: false };
/** Once backing off a zombie, a bot keeps backing off until it is this much farther than the distance that started it. */
const KITE_SLACK_PX = 60;
const kiting = (s: Watch) => !!s.zombie && s.zombie.d <= KITE_PX + (s.kiting ? KITE_SLACK_PX : 0);
/**
 * Done backing off, a bot whose way back to its post runs at the zombie holds where it is and shoots until the zombie is this near,
 * not walk straight back into kiting range: a bot outpaces a zombie, so it would otherwise shuttle back and forth between the two thresholds.
 */
const REGAIN_PX = KITE_PX + KITE_SLACK_PX + 100;
/** A way out kept while kiting may run this far off straight away from the zombie, a little past square, so a sideways step survives. */
const KEEP_KITE_COS = -0.2;
/**
 * The ways out a bot backing off tries, in turn: straight away from the zombie, then aslant, then square to either side. Each must be a straight walk, since a way
 * round the core or a turret may set off toward the zombie: with the core and a turret on either side of it the bot backs off along the gap between them.
 */
const KITE_TURNS = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];
const KITE_REACH_PX = [200, 150, 100];
const holdPost: Rule = (s) => {
  const post = { ...s.post, use: false };
  const z = s.zombie;
  if (!z) return post;
  if (!kiting(s)) {
    const towardZombie = (post.x - s.me.x) * (z.x - s.me.x) + (post.y - s.me.y) * (z.y - s.me.y) > 0;
    // A job the horde holds it off (the rules before this one took it otherwise) waits where the bot stands, as a person stops and shoots,
    // not back at its post: the zombie in the way falls soon, and the walk back out to the job would undo the walk to the post.
    const heldOff = !!s.needsTending || s.coreMendable;
    return heldOff || (z.d <= REGAIN_PX && towardZombie) ? { x: s.me.x, y: s.me.y, use: false } : post;
  }
  const inGuard = (p: { x: number; y: number }) => Math.hypot(p.x - s.core.x, p.y - s.core.y) <= GUARD_RADIUS;
  // Away from every zombie at hand, the nearer the more, not just the nearest: between two, backing off one walks into the other, and the
  // nearest would change sides with each step.
  const at = KITE_PX + KITE_SLACK_PX;
  const push = s.zombies.reduce((v, o) => {
    const d = Math.max(1, Math.hypot(s.me.x - o.x, s.me.y - o.y));
    return d > at ? v : { x: v.x + (s.me.x - o.x) / (d * d), y: v.y + (s.me.y - o.y) / (d * d) };
  }, { x: (s.me.x - z.x) / Math.max(1, z.d) ** 2, y: (s.me.y - z.y) / Math.max(1, z.d) ** 2 });
  const away = Math.atan2(push.y, push.x);
  const k = s.kiteTo, kx = k ? k.x - s.me.x : 0, ky = k ? k.y - s.me.y : 0, kd = Math.hypot(kx, ky);
  // Keep backing off the way it started while that still does not close on the zombies, so a fresh pick each moment never swings it from side to side.
  if (k && kd > DEAD_ZONE && inGuard(k) && s.clear(k) && (kx * Math.cos(away) + ky * Math.sin(away)) / kd > KEEP_KITE_COS) return { ...k, use: false };
  // Each way out as far as a straight walk goes, up to a full step, and only one that goes far enough to be worth the turn.
  const reach = (a: number) => KITE_REACH_PX.map((d) => ({ x: s.me.x + Math.cos(away + a) * d, y: s.me.y + Math.sin(away + a) * d, use: false })).find((p) => inGuard(p) && s.clear(p));
  // With no straight way out, straight away by the grid's way round.
  const back = { x: s.me.x + Math.cos(away) * KITE_REACH_PX[0]!, y: s.me.y + Math.sin(away) * KITE_REACH_PX[0]!, use: false };
  return KITE_TURNS.reduce<Errand | null>((found, a) => found ?? reach(a) ?? null, null) ?? (inGuard(back) ? back : post);
};

const SIEGE_RULES: readonly Rule[] = [revive, refillDry, mendBuilding, buildNext, mendCore, holdPost];

const BASTION_PLAN: readonly { kind: BuildingKind; dx: number; dy: number }[] = [
  { kind: 'sentry', dx: 0, dy: -3 }, { kind: 'sentry', dx: 3, dy: 0 }, { kind: 'scatter', dx: 0, dy: 3 }, { kind: 'sentry', dx: -3, dy: 0 },
  { kind: 'cannon', dx: 3, dy: -3 }, { kind: 'mortar', dx: -3, dy: 3 }, { kind: 'scatter', dx: 0, dy: -4 }, { kind: 'sentry', dx: 0, dy: 4 },
  { kind: 'cannon', dx: -3, dy: -3 }, { kind: 'mortar', dx: 3, dy: 3 }, { kind: 'scatter', dx: 4, dy: 0 }, { kind: 'scatter', dx: -4, dy: 0 },
];

const BUILD_STANDOFF = 2 * ZOM.cell;

/** The way each side's horde comes from, as a unit step out from the core. */
const OUT: Record<Side, { x: number; y: number }> = { north: { x: 0, y: -1 }, east: { x: 1, y: 0 }, south: { x: 0, y: 1 }, west: { x: -1, y: 0 } };
type Cell = { cx: number; cy: number };
type Wish = { kind: BuildingKind; cell: Cell; lv: number };
type Step = Wish & { act: 'build' | 'upgrade' };

/** The cell `out` cells beyond the core's edge on `side` and `along` cells across it, counted from the core's first cell on that edge. */
function onSide(core: { x: number; y: number }, side: Side, out: number, along: number): Cell {
  const lo = cellOf(core.x - ZOM.coreHalf + 1, core.y - ZOM.coreHalf + 1), hi = cellOf(core.x + ZOM.coreHalf - 1, core.y + ZOM.coreHalf - 1);
  switch (side) {
    case 'north': return { cx: lo.cx + along, cy: lo.cy - out };
    case 'south': return { cx: lo.cx + along, cy: hi.cy + out };
    case 'west': return { cx: lo.cx - out, cy: lo.cy + along };
    case 'east': return { cx: hi.cx + out, cy: lo.cy + along };
  }
}

/**
 * What a squad bot would do next by day, in order, from what stands and what the coming night brings (the forecast every squad sees): a ring of turrets round the Bastion,
 * the turret nearest the side the horde comes from stepping up once nine stand; the rest of the ring, then an ammo depot and a repair post behind that side's guns; a line of sandbags across its way, later
 * steel; spike strips ahead of the line and a tesla coil beside it; and every turret a level, the ones facing the horde first, and again.
 */
export function nextBuildStep(night: number, buildings: readonly BuildingView[], core: { x: number; y: number }): Step | null {
  const sides = nightOf(night).from;
  const side = sides[0] ?? SIDES[0]!;
  const fromEdge = (d: number) => (d + Math.sign(d) / 2) * ZOM.cell;
  const turrets = BASTION_PLAN.map((p) => ({ kind: p.kind, cell: cellOf(core.x + fromEdge(p.dx), core.y + fromEdge(p.dy)) }));
  const facing = (c: Cell) => Math.min(...sides.map((s) => Math.hypot((c.cx + 0.5) * ZOM.cell - core.x - OUT[s].x * 175, (c.cy + 0.5) * ZOM.cell - core.y - OUT[s].y * 175)));
  const byFacing = [...turrets].sort((a, b) => facing(a.cell) - facing(b.cell));
  const todo = (wish: Wish): Step | null => {
    const there = buildings.find((b) => b.cx === wish.cell.cx && b.cy === wish.cell.cy);
    if (!there) return { ...wish, act: 'build', lv: wish.kind === 'wall' ? Math.min(wish.lv, 2) : 1 };
    if (there.kind !== wish.kind || levelOf(there) >= Math.min(wish.lv, maxLevelOf(wish.kind))) return null;
    return { ...wish, act: 'upgrade', lv: levelOf(there) + 1 };
  };
  const first = (wishes: readonly Wish[]) => { for (const w of wishes) { const s = todo(w); if (s) return s; } return null; };
  const ring = (from: number, to: number): Wish[] => turrets.slice(from, to).map((t) => ({ ...t, lv: 1 }));
  const faced = (lv: number): Wish[] => byFacing.map((t) => ({ ...t, lv }));
  const line = (lv: number): Wish[] => [0, 1, -1, 2].map((along) => ({ kind: 'wall' as const, cell: onSide(core, side, 5, along), lv }));
  const strips: Wish[] = [0, 1, -1, 2].map((along) => ({ kind: 'spikes' as const, cell: onSide(core, side, 7, along), lv: 1 }));
  const depot: Wish = { kind: 'depot', cell: onSide(core, side, 3, 2), lv: 1 }, post: Wish = { kind: 'post', cell: onSide(core, side, 3, -1), lv: 1 };
  const coil: Wish = { kind: 'tesla', cell: onSide(core, side, 4, -2), lv: 1 };
  return first(ring(0, 9)) ?? first(faced(2).slice(0, 1)) ?? first(ring(9, 12)) ?? first([depot]) ?? first([post]) ?? first(line(2)) ?? first(faced(2)) ?? first(strips) ?? first([coil])
    ?? first(line(3)) ?? first(faced(3));
}

function nextBuild(run: RunView, buildings: readonly BuildingView[]): NonNullable<Watch['next']> & { cost: number } | null {
  const step = nextBuildStep(run.night, buildings, run.core);
  if (!step) return null;
  const { cx, cy } = step.cell;
  const x = (cx + 0.5) * ZOM.cell, y = (cy + 0.5) * ZOM.cell, d = Math.hypot(x - run.core.x, y - run.core.y);
  const cost = step.act === 'upgrade' ? upgradeCost(step.kind, step.lv - 1) ?? Infinity : costOf(step.kind, step.lv);
  // The bot stands to the side of the cell, round the core, or failing that behind it or ahead of it: a spot with a building on it would never be reached.
  const rx = (x - run.core.x) / d, ry = (y - run.core.y) / d;
  const solids = [coreRectAt(run.core), ...buildings.filter(solid).map((b) => cellRect(b.cx, b.cy))];
  const spots = [[-ry, rx], [ry, -rx], [-rx, -ry], [rx, ry]].map(([ux, uy]) => ({ x: x + ux! * BUILD_STANDOFF, y: y + uy! * BUILD_STANDOFF }));
  const stand = spots.find((p) => !circleBlocked(solids, p.x, p.y, WORLD.playerRadius)) ?? spots[0]!;
  return { act: step.act, kind: step.kind, lv: step.lv, cx, cy, x: stand.x, y: stand.y, cost };
}

/** A spike strip lies on the floor: a bot walks over it. */
const solid = (b: BuildingView) => b.kind !== 'spikes';
const squadSolids = (core: { x: number; y: number }, buildings: readonly BuildingView[]): Rect[] => [coreRectAt(core), ...buildings.filter(solid).map((b) => cellRect(b.cx, b.cy))];
const SQUAD_NAV = new WeakMap<BotArena, { key: string; nav: NavGrid }>();
const MAX_EXPANSIONS = 4000;
const NAV_SLACK = 8;

function wayTo(arena: BotArena, core: { x: number; y: number }, buildings: readonly BuildingView[], me: { x: number; y: number }, to: { x: number; y: number }) {
  const key = buildings.filter(solid).map((b) => `${b.cx},${b.cy}`).join(' ');
  let cached = SQUAD_NAV.get(arena);
  if (cached?.key !== key) {
    cached = { key, nav: withSolids(arena.nav, squadSolids(core, buildings), WORLD.playerRadius - NAV_SLACK) };
    SQUAD_NAV.set(arena, cached);
  }
  let path = findPath(cached.nav, me, to, MAX_EXPANSIONS);
  // A bot may stand closer to the core or a building than the grid's cells allow (`NAV_SLACK` rounds them out to whole cells), and a route from a shut cell starts at
  // whichever open cell is nearest, which can lie behind it: the bot would turn round for it, step back into the open, and set off forward again.
  // So the way runs from where the bot stands, past the legs it can walk straight by.
  if (path && !isOpen(cached.nav, me)) {
    const solids = squadSolids(core, buildings);
    let i = 0;
    while (i + 1 < path.length && clearWalk(arena.nav, solids, me, path[i + 1]!)) i++;
    path = path.slice(i);
  }
  return path?.find((p) => Math.abs(p.x - me.x) > DEAD_ZONE || Math.abs(p.y - me.y) > DEAD_ZONE) ?? to;
}

/** Whether a body walks straight from `a` to `b`: past the map as its grid has it, and past the core and buildings themselves, to the grid's `NAV_SLACK`, rather than their whole cells. */
function clearWalk(base: NavGrid, solids: readonly Rect[], a: Point, b: Point): boolean {
  if (!walkable(base, a, b)) return false;
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (base.cell / 2));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    if (circleBlocked(solids, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, WORLD.playerRadius - NAV_SLACK)) return false;
  }
  return true;
}

function postFor(core: { x: number; y: number }, bearing: number, buildings: readonly BuildingView[]): { x: number; y: number } {
  const at = (d: number) => ({ x: core.x + Math.cos(bearing) * d, y: core.y + Math.sin(bearing) * d });
  const innermost = ZOM.coreHalf + WORLD.playerRadius + 1;
  for (let d = innermost; d <= POST_RADIUS; d += 5) {
    const { x, y } = at(d);
    if (buildings.some((b) => solid(b) && circleHitsRect(x, y, WORLD.playerRadius, cellRect(b.cx, b.cy)))) return at(Math.max(innermost, d - 5));
  }
  return at(POST_RADIUS);
}

function swingTo(prev: Engagement | null, zombie: NonNullable<Watch['zombie']>, tick: number, rand: () => number): Engagement {
  if (prev?.id === zombie.id) return engage(prev, zombie, SHARPNESS[0]!, tick, rand);
  const fresh = engage(null, zombie, SHARPNESS[0]!, tick, rand);
  return prev ? { ...fresh, acquiredTick: prev.acquiredTick, noticeAtTick: prev.noticeAtTick, leadMul: prev.leadMul } : fresh;
}

export function siegeThink(snap: Snapshot, run: RunView, me: PlayerView, arena: BotArena, mem: BotMemory, rand: () => number): Omit<BotDecision, 'pick'> {
  const walls = arena.walls;
  const sight = viewExtents(snap.self.viewRadius, DEFAULT_VIEW_ASPECT);
  const inSight = (p: { x: number; y: number }) => Math.abs(p.x - me.x) <= sight.halfW && Math.abs(p.y - me.y) <= sight.halfH
    && !segmentBlocked(walls, me.x, me.y, p.x - me.x, p.y - me.y);
  const zombies = (snap.zombies ?? []).map(([id, , x, y]) => ({ id, x, y, d: Math.hypot(x - me.x, y - me.y) })).filter(inSight);
  const recalled = (mem.siege?.zombies ?? []).filter((z) => snap.tick - z.tick <= REMEMBER_TICKS && !inSight(z) && !zombies.some((s) => s.id === z.id));
  const siege: SiegeMemory = { zombies: [...zombies.map((z) => ({ id: z.id, x: z.x, y: z.y, tick: snap.tick })), ...recalled] };
  const zombie = zombies.reduce<Watch['zombie']>((best, z) => (best && best.d <= z.d ? best : z), null);
  const down = snap.players.filter((p) => p.downed && p.id !== me.id);
  const downed = nearest(me, down.filter((p) => p.kind === 'human')) ?? nearest(me, down);
  const humansBank = snap.players.some((p) => p.kind === 'human' && p.id !== me.id);
  const spare = !humansBank || run.scrap > HUMANS_RESERVE;
  const guarded = (b: BuildingView) => Math.hypot((b.cx + 0.5) * ZOM.cell - run.core.x, (b.cy + 0.5) * ZOM.cell - run.core.y) <= GUARD_RADIUS;
  const at = (b: BuildingView) => ({ x: (b.cx + 0.5) * ZOM.cell, y: (b.cy + 0.5) * ZOM.cell });
  const tending = mem.motor.tending;
  const started = (b: BuildingView) => tending?.x === at(b).x && tending.y === at(b).y;
  const worn = !spare ? [] : (snap.buildings ?? [])
    .filter((b) => solid(b) && guarded(b) && (b.hp < WHOLE_TENTHS || ('ammo' in b && b.ammo <= (started(b) ? WHOLE_TENTHS - 1 : LOW_TENTHS) && run.scrap > 0))).map(at);
  const dry = run.scrap > 0 ? (snap.buildings ?? []).filter((b) => guarded(b) && 'ammo' in b && b.ammo <= DRY_TENTHS).map(at) : [];
  const plan = humansBank ? null : nextBuild(run, snap.buildings ?? []);
  const buildable = plan && run.phase === 'day' && run.scrap >= plan.cost ? plan : null;
  const coreInDanger = run.phase === 'night' && run.core.hp < run.core.maxHp * CORE_EMERGENCY_FRAC;
  const post = postFor(run.core, me.id, snap.buildings ?? []);
  const solids = squadSolids(run.core, snap.buildings ?? []);
  const watch: Watch = {
    me, core: run.core, post, zombie, zombies: siege.zombies, downed, needsTending: nearest(post, worn), dry: nearest(post, dry), tending, clear: (to) => clearWalk(arena.nav, solids, me, to), kiting: !!mem.motor.siegeStep?.kite, kiteTo: mem.motor.siegeStep?.kite ? mem.motor.siegeStep.to : null, next: buildable,
    coreMendable: run.core.hp < run.core.maxHp && run.scrap > 0 && (coreInDanger || (spare && run.scrap > (run.phase === 'day' ? plan?.cost ?? 0 : 0))),
  };
  const errand = SIEGE_RULES.reduce<Errand | null>((found, rule) => found ?? rule(watch), null)!;
  const tended = [watch.needsTending, watch.dry, watch.coreMendable ? run.core : null].find((t) => t?.x === errand.x && t?.y === errand.y);
  const builds = buildable && errand.x === buildable.x && errand.y === buildable.y && Math.hypot(buildable.x - me.x, buildable.y - me.y) <= 2 * DEAD_ZONE;

  const outFromCore = { x: 2 * me.x - run.core.x, y: 2 * me.y - run.core.y };
  const face = errand.use ? errand : outFromCore;
  const before = mem.motor.aim ?? freshAim(me.angle);
  const want = Math.hypot(face.x - me.x, face.y - me.y) > 1 ? Math.atan2(face.y - me.y, face.x - me.x) : before.want;
  let look: Look = { want, spin: 0, hand: HANDS.calm, d: 300, err: before.err };
  let wantsFire = false;
  let threat: Situation['threat'] = null;
  let engaged: Engagement | null = null;
  if (zombie) {
    engaged = swingTo(mem.motor.engaged, zombie, snap.tick, rand);
    if (snap.tick >= engaged.noticeAtTick) {
      const err = drift(before.err, aimSigma(engaged, me, SHARPNESS[0]!, snap.tick), TICK_MS, rand);
      // Lead the zombie by the round's flight, as bots lead players, since slower rounds otherwise trail a walker.
      const meet = intercept(me, { x: zombie.x, y: zombie.y, vx: engaged.vx, vy: engaged.vy }, GUNS[me.gun].bulletSpeed, rulesOf(GUNS[me.gun]).muzzleBoost, MUZZLE_PX, engaged.leadMul);
      const rx = meet.x - me.x, ry = meet.y - me.y;
      look = { want: Math.atan2(ry, rx) + err, spin: bearingSpin(rx, ry, engaged.vx, engaged.vy), hand: HANDS.flick, d: zombie.d, err };
      wantsFire = zombie.d < GUNS[me.gun].range * 0.95;
      threat = { d: zombie.d };
    }
  }
  const hitTick = snap.events.some((e) => e.e === 'dmg' && e.kind === 'player' && e.victim === me.id) ? snap.tick : mem.awareness.hitTick;
  const situation: Situation = { threat, hurting: me.hp < me.maxHp * HURTING_HP_FRAC, underFire: snap.tick - hitTick <= UNDER_FIRE_TICKS, onContestedZone: false };
  const readyAbility = snap.self.abilityReadyIn === 0 ? snap.self.ability : null;
  const wanted = readyAbility !== null && readyAbility !== 'engineer' && ABILITY_RULES[readyAbility](situation) ? readyAbility : null;
  const { aim, fire, ability, shots } = aimAndTrigger(before, look, wantsFire, wanted, mem.motor.shots);
  const kite = !downed && !errand.use && kiting(watch) && (errand.x !== watch.post.x || errand.y !== watch.post.y);
  const kept = mem.motor.siegeStep;
  const sameGoal = kept && (kite ? kept.kite : !kept.kite && Math.hypot(kept.to.x - errand.x, kept.to.y - errand.y) < STEP_GOAL_SLACK);
  const keep = kept && sameGoal && snap.tick - kept.tick < (kite ? KITE_HOLD_TICKS : STEP_HOLD_TICKS)
    && (Math.abs(kept.at.x - me.x) > DEAD_ZONE || Math.abs(kept.at.y - me.y) > DEAD_ZONE);
  const step = keep ? kept.at : wayTo(arena, run.core, snap.buildings ?? [], me, errand);
  const siegeStep = keep ? kept : { to: { x: errand.x, y: errand.y }, at: step, tick: snap.tick, kite };
  const mx = step.x - me.x, my = step.y - me.y;
  const still = errand.use;
  const input: InputState = {
    up: !still && my < -DEAD_ZONE, down: !still && my > DEAD_ZONE, left: !still && mx < -DEAD_ZONE, right: !still && mx > DEAD_ZONE,
    angle: aim.angle, fire, shots, reload: !zombie && snap.self.ammo < snap.self.mag / 2, ability, aimDist: look.d, use: errand.use,
  };
  const next = { ...mem, siege, awareness: { ...mem.awareness, hitTick }, motor: { ...mem.motor, engaged, aim, shots, siegeStep, tending: tended ? { x: tended.x, y: tended.y } : null } };
  return { input, mem: next, ...(builds && (buildable.act === 'upgrade' ? { upgrade: { cx: buildable.cx, cy: buildable.cy } } : { build: { kind: buildable.kind, cx: buildable.cx, cy: buildable.cy, lv: buildable.lv } })) };
}
