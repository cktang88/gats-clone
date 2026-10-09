import { GUNS, rulesOf, WORLD, type AbilityId, type GunId, type PerkId, type Tier } from '../../shared/defs.ts';
import { BOT_VIEW_ASPECT, viewExtents, type CrateView, type InputState, type Snapshot } from '../../shared/protocol.ts';
import { FLASH, GRENADE_FUSE_MS } from '../../shared/sim/abilities.ts';
import { circleHitsRect, KNIFE_LUNGE, KNIFE_REACH, segmentBlocked, type Rect } from '../../shared/sim/movement.ts';
import { BOT_BLOOM_DECAY_MUL, BOT_SPREAD_MUL, bloomRecoverMul, settleShare, spreadFor } from '../../shared/sim/stats.ts';
import { aimAndTrigger, aimSigma, bearingSpin, drift, engage, freshAim, GRENADES, handFor, HANDS, intercept, landingErr, MUZZLE_PX, sharpnessAgainst, TICK_MS, wrapAngle, type AimState, type Engagement, type Hand, type Look, type Sharpness } from './aim.ts';
import { clearOfLeaves, doorCentre, leavesCrossed, navAround, takeReplan, type BotArena, type StandingLeaf } from './arena.ts';
import { doorLeaves, swingArcAt, swingHinges, SWING_MAX } from '../../shared/sim/doors.ts';
import type { MapDoor } from '../../shared/geom.ts';
import { barrelToShoot, seenBarrels, shotWouldBurnMe } from './barrels.ts';
import { hazardState, hazardsOf, propToShoot, seenProps, shotWouldHurtMe } from './props.ts';
import { BLIND_AT, focus, type Perception, type Threat } from './awareness.ts';
import { sightBlocked } from '../../shared/sim/vision.ts';
import { justLost, lane, type Intent, type IntentCtx } from './intent.ts';
import { hiddenFromSeen } from './tactics.ts';
import { between, clearShot, dist, findPath, isOpen, walkable, type Point } from './nav.ts';
import { boltCue, DODGE_AT, dangerTo, dodgeLeg, dodgeStyle, nextDodge, weave, type Dodge, type DodgeStyle } from './evade.ts';

export type Motor = {
  /**
   * `around`: the standing door leaves (see `BotArena.leaves`) it was routed round, by key; `blocked`, those of them there was no
   * way round (one swung across the only corridor out), which it walks up to and waits at until they swing shut.
   */
  route: { goal: Point; points: readonly Point[]; version: number; partial: boolean; around: readonly string[]; blocked?: readonly string[] } | null;
  dir: number | null;
  dirSince: number;
  pace: { lastDir: number | null; lastTurnBackTick: number };
  stance: { step: 0 | 1 | -1; since: number; until: number; heading: number | null; planted: boolean };
  last: Point;
  stuckTicks: number;
  /** Where the bot last made real headway, and when, with its walk left then and whether it has run into anything since; see `CRAWL`. */
  progress: { x: number; y: number; tick: number; left: number; rubbed: boolean };
  /** A sidestep at right angles to the way it wants to go, held until `until`, round something the nav grid does not hold. */
  detour: { side: 1 | -1; until: number } | null;
  /** A squad bot's next step toward its errand, kept a while so two equal ways round a turret never flip it side to side. */
  siegeStep: { to: Point; at: Point; tick: number; kite: boolean } | null;
  /** Where a squad bot is tending, kept so it finishes a job it has started instead of leaving at the threshold that sent it. */
  tending: Point | null;
  engaged: Engagement | null;
  engagedSeen: number;
  aim: AimState | null;
  shots: number;
  /**
   * Burst-tapping (see `tapRhythm`): when the current tap began and until when the trigger is let go; and its read of its own bloom
   * (see `ownBloom`): the spray it reckons its gun is at, from the rounds it has seen leave its magazine, and the tick the last one left.
   */
  tap?: { since: number | null; pauseUntil: number; spray?: number; ammo?: number; firedTick?: number };
  /** Getting off a long gun's line of fire (see evade.ts): the current leg, or null when nothing worth dodging has it in its sights. */
  dodge?: Dodge | null;
  /** What the last think decided, which `motorTick` carries out every tick until the next think. */
  hold?: Hold | null;
};

type Keys = Pick<InputState, 'up' | 'down' | 'left' | 'right'>;

/**
 * Where a bot points its gun when it is not tracking an enemy: at a spot (`follow` keeps it on the tracked enemy as he moves, before it has
 * taken him in), down its route, or at a bearing fixed when it decided (a throw, its back to a flash). `sigma` is a blind spray's shake.
 */
export type Gaze =
  | { k: 'point'; at: Point; minPx: number; hand: Hand; sigma: number; fire: boolean; follow?: boolean }
  | { k: 'ahead' }
  | { k: 'fixed'; want: number; d: number; hand: Hand; err?: number };

/**
 * A think's decision, carried out tick by tick by `motorTick` until the next think (see tick.ts): where to go (`to` along the route, a fixed
 * point `at` off it, or a strafe or dodge leg run on a `heading`), keys forced for the moment (a dash, out of fire), what to look at or
 * track, whether to fire, use its ability, reload or sprint, and the tick by which it must think again (`wakeAt`: a leg or a peek ends).
 */
export type Hold = {
  tick: number;
  to: Point | null;
  at: Point | null;
  heading: number | null;
  keys: Keys | null;
  gaze: Gaze;
  /** The enemy it is fighting: tracked from where he is each tick, leading him, with its own aim error; `shoot` a barrel or prop by him instead. */
  track: { id: number; sharp: Sharpness; shoot: Point | null; fire: boolean } | null;
  /** A look that overrides the aim for now (a throw, smoke at its feet, its back to a flash), and whether it holds its fire meanwhile. */
  turn: { gaze: Gaze; holdFire: boolean } | null;
  ability: AbilityId | null;
  /** A planted gun moving off its spot holds its fire until its keys are up. */
  stillToFire: boolean;
  reload: boolean;
  sprint: boolean;
  mag: number;
  rhythm: Rhythm | null;
  /** Its gun's post-sprint settle, ms (the snapshot's `settleMs`), for reading the bloom off `Body.settleLeftMs`. */
  settleMs?: number;
  /** Fire now whatever its bloom (see `holdsFire`): it is being shot, or the enemy is about to break its line of sight. */
  urgent?: boolean;
  wakeAt: number;
  /** A planted gun thinks again the tick after its round leaves (not on every pull of a trigger still cycling), to move off its spot (see `nextDodge`, `thinkBots`). */
  wakeOnFire: boolean;
  /** It was pre-aiming an angle with nobody in sight (see `watchPoint`), so one who shows there is taken in quickly (`PRE_AIMED_REACT`). */
  watching?: boolean;
  /** Whether it stood at `to` when it decided, so only arriving there later wakes it to plan the next move. */
  arrived: boolean;
  /** The nav grid it routed on (a barrel going up or coming back makes a new one), and the door on its way and whether it stood open. */
  nav: number;
  door: { i: number; open: boolean } | null;
};

export const freshMotor = (): Motor => ({
  route: null, dir: null, dirSince: 0, pace: { lastDir: null, lastTurnBackTick: -Infinity }, stance: { step: 0, since: 0, until: 0, heading: null, planted: true }, last: { x: 0, y: 0 }, stuckTicks: 0, progress: { x: 0, y: 0, tick: 0, left: Infinity, rubbed: false }, detour: null, siegeStep: null, tending: null, engaged: null, engagedSeen: -Infinity, aim: null, shots: 0,
});

/** What a bot weighs when deciding whether its ability helps right now. `threat` is the enemy it is fighting, once its reaction delay has passed. */
export type Situation = {
  threat: { d: number } | null; hurting: boolean; underFire: boolean; onContestedZone: boolean;
  /** An enemy it saw lately but cannot see now (behind a corner or in cover), and how far off he was. */
  lastKnown?: { d: number } | null;
};

/** Lunge plus reach, leaving the target's radius as slack so a strafing target is still caught. */
const KNIFE_REACH_PX = KNIFE_LUNGE + KNIFE_REACH;
const throwRange = (s: Situation) => s.threat !== null && s.threat.d >= 150 && s.threat.d <= 450;

export const ABILITY_RULES: Record<AbilityId, (s: Situation) => boolean> = {
  knife: (s) => s.threat !== null && s.threat.d <= KNIFE_REACH_PX,
  grenade: throwRange,
  fragGrenade: throwRange,
  gasGrenade: throwRange,
  // A flash thrown at the enemy lands past its own reach, so only the target is caught: at a visible enemy, or at the corner or cover an unseen one went to.
  flashbang: (s) => [s.threat, s.lastKnown].some((t) => t && t.d >= FLASH.radius + 20 && t.d <= 480),
  // Smoke is a screen to back off behind: thrown at the enemy's side of a bot that is hurting or under his fire.
  smokeGrenade: (s) => s.threat !== null && s.threat.d >= 120 && (s.hurting || s.underFire),
  landMine: (s) => (s.hurting && s.threat !== null) || s.onContestedZone,
  dash: (s) => s.hurting && s.threat !== null,
  engineer: (s) => s.underFire && s.threat !== null && s.threat.d >= 200 && s.threat.d <= 500,
};

export const HURTING_HP_FRAC = 0.4;
const KNIFE_CHASE_PX = 300;
/** A smoke grenade is thrown this far toward the enemy, so the cloud blooms over the bot and the ground between. */
const SMOKE_THROW_PX = 100;
const REACQUIRE_TICKS = Math.round(600 / TICK_MS);
/** Leaving a sprint throws the post-sprint bloom on its gun, so a bot only breaks into one after this long out of any fight (no flicking it on and off at the edge of one). */
const SPRINT_CALM_TICKS = Math.round(1500 / TICK_MS);
const RETREAT_STEP = 240 + WORLD.playerRadius;
const WAYPOINT_PX = 16;
const ARRIVED_PX = 14;
const MIN_HOLD_TICKS = 3;
const HOLD_SLACK = (35 * Math.PI) / 180;
const STUCK_TICKS = 12;
const BLOCKED_TICKS = 3;
const REPLAN_PX = 48;
/** How far a goal may shift and still keep its route on a strategic think (bent to it at the end), and the search budget for a way back onto a route. */
const REUSE_PX = 160;
const REJOIN_EXPANSIONS = 400;
const NEAR_GOAL_PX = 300;
const MAX_EXPANSIONS = 6000;
/**
 * A bot pressing its keys that has made no headway (see `headway`) within `ticks` is crawling along a wall: the per-tick
 * stuck count misses it, since sliding a pixel along the wall reads as gaining on the waypoint. Its route is
 * then replanned with no search budget, which finds the way round when a far goal outran the budgeted search; and since
 * crates are not in the nav grid, it also sidesteps at right angles for `detourTicks`, alternating sides each time.
 */
const CRAWL = { px: 60, ticks: 30, detourTicks: 24 } as const;
const STAND_MS: readonly [number, number] = [700, 1500];
const STEP_MS: readonly [number, number] = [300, 700];
const UNDER_FIRE_STEP_ODDS = 0.75;
const STRAFE_MS: readonly [number, number] = [450, 1000];
const STRAFE_PX = 120;
/** A strafe leg that would end this near a mate is flipped the other way, so a pair side by side do not pile into one spot. */
const MATE_CLEAR_PX = 90;
/** Mates closer than this push a bot's goal away from them, softly (full push at touching, none at this range). */
const MATE_SPACE_PX = 150;
const MATE_SHOVE_PX = 260;
const MATE_SHOVE_MIN = 0.35;
/** Enemies within this of a bot are a crowd, and each one past the first widens the distance it holds. */
const CROWD_PX = 400;
const CROWD_HOLD = 0.5;
const PEEK_SWAY_PX = 70;
const SWAY_PAUSE_MS: readonly [number, number] = [100, 250];
export const MIN_TURN_BACK_MS = 400;
const MIN_LEG_TICKS = Math.round(MIN_TURN_BACK_MS / TICK_MS);

const crateRect = (c: CrateView): Rect => ({ x: c.x, y: c.y, w: c.size, h: c.size });
const anyKey = (k: Pick<InputState, 'up' | 'down' | 'left' | 'right'>) => k.up || k.down || k.left || k.right;

function retreatHeading(me: Point, away: number, arena: BotArena): number {
  const headings = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4)
    .filter((h) => Math.cos(h - away) > 0)
    .sort((a, b) => Math.cos(b - away) - Math.cos(a - away));
  const clear = headings.find((h) => {
    const dx = Math.cos(h) * RETREAT_STEP, dy = Math.sin(h) * RETREAT_STEP;
    const ex = me.x + dx, ey = me.y + dy, r = WORLD.playerRadius;
    if (ex < r || ey < r || ex > arena.size - r || ey > arena.size - r) return false;
    return !segmentBlocked(arena.walls, me.x, me.y, dx, dy) && !segmentBlocked(arena.barrels, me.x, me.y, dx, dy);
  });
  return clear ?? headings[0] ?? away;
}

function awayFrom(me: Point, threat: Point, arena: BotArena, step: number): Point {
  const h = retreatHeading(me, Math.atan2(me.y - threat.y, me.x - threat.x), arena);
  return { x: me.x + Math.cos(h) * step, y: me.y + Math.sin(h) * step };
}

/** The nearest crate centre in sight, in range and in the clear, so a bot with nobody to fight still earns score. */
function crateInSight(me: Point, crates: readonly CrateView[], walls: readonly Rect[], range: number, sight: { halfW: number; halfH: number }): Point | null {
  let best: Point | null = null, bestD = Infinity;
  for (const c of crates) {
    const at = { x: c.x + c.size / 2, y: c.y + c.size / 2 };
    const d = dist(at, me);
    if (d > range || d >= bestD || Math.abs(at.x - me.x) > sight.halfW || Math.abs(at.y - me.y) > sight.halfH) continue;
    if (!clearShot([...walls, ...crates.filter((o) => o.id !== c.id).map(crateRect)], me, at)) continue;
    best = at;
    bestD = d;
  }
  return best;
}

/** `heading` is set when `to` is the end of a strafe or dodge leg: between thinks the bot keeps running that way rather than stopping there. */
type Steer = { to: Point | null; face: Point | null; reload: boolean; crates: boolean; heading?: number | null };

const LOOK_HOLD_INSIDE_PX = 150;
/** An enemy in sight this far off where its gun points catches it off-angle (see `HANDS.startle`). */
const STARTLE_RAD = (40 * Math.PI) / 180;
const LOOK_AHEAD_PX = 400;
/** An enemy who comes into sight this near where its gun points was pre-aimed: it takes him in in `PRE_AIMED_REACT` of its usual time. */
const PRE_AIMED_RAD = (10 * Math.PI) / 180;
const PRE_AIMED_REACT = 0.6;
/** Below this share of its magazine it reloads even in an enemy's line. */
const OPEN_RELOAD_FRAC = 0.2;

function lookAt(at: Point | null, me: Point, mine: Point, minPx = LOOK_HOLD_INSIDE_PX): { want: number; spin: number; d: number } | null {
  if (!at || dist(at, me) < Math.max(1, minPx)) return null;
  const rx = at.x - me.x, ry = at.y - me.y;
  return { want: Math.atan2(ry, rx), spin: bearingSpin(rx, ry, -mine.x, -mine.y), d: dist(at, me) };
}

function routeAhead(me: Point, route: Motor['route']): Point | null {
  let from = me, left = LOOK_AHEAD_PX;
  for (const p of route?.points ?? []) {
    const d = dist(from, p);
    if (d >= left) return { x: from.x + ((p.x - from.x) * left) / d, y: from.y + ((p.y - from.y) * left) / d };
    left -= d;
    from = p;
  }
  return from === me ? null : from;
}

/** A planted LMG is an easy target up close, where strafing wins, so it settles in only once the fight is past half its reach. */
function plants(v: Perception, c: IntentCtx, d: number, fromCover: boolean): boolean {
  if (c.persona.plantsFromCover && fromCover && d >= c.band.ideal) return true;
  const gun = GUNS[v.me.gun];
  const { plant } = rulesOf(gun);
  return plant === 'always' || (plant === 'atRange' && d >= gun.range / 2);
}

/**
 * Burst-tapping: an assault-class gun's bloom starts after its first few rounds, so its bot lets go after that many and takes the gun back to
 * rest before it fires again, instead of holding a spray that drifts off the target (from `TAP_FROM_PX` out; closer, the cone swallows any bloom). A rusher or a machine gun hoses.
 */
export const TAP_FROM_PX = 280;
export function tapRhythm(gun: GunId, rushes: boolean): { windowMs: number; pauseMs: number } | null {
  const def = GUNS[gun];
  const { bloom } = rulesOf(def);
  if (!bloom || bloom.free > 4 || rushes) return null;
  const perRound = def.burst ? ((def.burst.count - 1) * def.burst.gapMs + def.fireMs) / def.burst.count : def.fireMs;
  return { windowMs: bloom.free * perRound - 1, pauseMs: bloom.settleMs + (0.5 * bloom.recoverMs) / BOT_BLOOM_DECAY_MUL };
}

/**
 * A tapping gun's rhythm with what its bot weighs before each shot (see `holdsFire`): `patienceMs`, the longest it waits on its bloom after a
 * round has left (the gun's pause, scaled by temper: a hothead's `commitMul` is short, a marksman's long, never over `PATIENCE_CAP_MS`), and its
 * perks and suppression for reading its own cone, and `recover` for reading its bloom come back down (Steady Hands and `BOT_BLOOM_DECAY_MUL`).
 */
export type Rhythm = { windowMs: number; pauseMs: number; patienceMs: number; recover: number; perks: Partial<Record<Tier, PerkId>>; suppression: number };
export const PATIENCE_CAP_MS = 1600;
export function fireRhythm(gun: GunId, rushes: boolean, commitMul: number, perks: Partial<Record<Tier, PerkId>> = {}, suppression = 0): Rhythm | null {
  const tap = tapRhythm(gun, rushes);
  if (!tap) return null;
  return { ...tap, patienceMs: Math.min(PATIENCE_CAP_MS, tap.pauseMs * commitMul), recover: bloomRecoverMul(perks, true), perks, suppression };
}

/**
 * What a bot reads before a shot: its bloom (`spray`, see `ownBloom`), whether it stands still, how far the enemy is and how fast he crosses
 * its line (px/s), how long since its last round left or its last sprint ended (whichever is later), whether it must fire now (`urgent`), whether
 * it is resting between taps (`pausing`) and the post-sprint bloom still on its gun (`settle`, 0..1, as the snapshot gives it; 0 if left out).
 */
export type ShotRead = { spray: number; still: boolean; d: number; lateral: number; sinceShotMs: number; urgent: boolean; pausing: boolean; settle?: number };

/** A shot this sure of landing, against what the gun at rest would give it, is good enough: waiting longer gains little. */
export const GOOD_SHOT = 0.9;
/** How much of a crossing enemy's travel in a round's flight its lead gets wrong (so a moving target is a wider cone however settled the gun). */
const LEAD_SLOP = 0.3;

/** The odds a round lands, roughly: the body's half-width against the cone's half-width at that range plus the lead it may get wrong. */
function hitChance(gun: GunId, r: Rhythm, sprayShot: number, s: ShotRead, settle = 0): number {
  const def = GUNS[gun];
  const cone = spreadFor(gun, r.perks, s.still, sprayShot, r.suppression, settle) * BOT_SPREAD_MUL;
  const slop = (s.lateral * s.d / def.bulletSpeed) * LEAD_SLOP;
  const body = WORLD.playerRadius;
  return body / Math.max(body, s.d * Math.tan(cone) + slop);
}

/**
 * Whether a tapping bot holds its next round for its bloom to come down, a shot's or a sprint's. It fires once the cone at the enemy's range
 * fits him about as well as it would at rest (`GOOD_SHOT` of the rested odds; between taps, for the whole of the next tap), once it has waited
 * `patienceMs` since its last round or sprint, and at once up close (inside `TAP_FROM_PX`, where the cone swallows any bloom) or when `urgent`.
 */
export function holdsFire(gun: GunId, r: Rhythm, s: ShotRead): boolean {
  if (s.urgent || s.d < TAP_FROM_PX || s.sinceShotMs >= r.patienceMs) return false;
  const rounds = s.pausing ? Math.max(1, rulesOf(GUNS[gun]).bloom?.free ?? 1) : 1;
  return hitChance(gun, r, s.spray + rounds, s, s.settle ?? 0) < GOOD_SHOT * hitChance(gun, r, rounds, s);
}

/**
 * Its own bloom as the bot reckons it, the way a person watches the reticle: a round gone from the magazine kicks it a shot, a reload
 * settles it, and with nothing fired for the gun's `settleMs` it comes back down at the sim's rate (`Rhythm.recover`).
 */
function ownBloom(r: Rhythm | null, gun: GunId, tap: Motor['tap'], ammo: number, tick: number): { spray: number; firedTick: number } {
  const { bloom } = rulesOf(GUNS[gun]);
  let spray = tap?.spray ?? 0, firedTick = tap?.firedTick ?? -Infinity;
  if (!r || !bloom) return { spray: 0, firedTick };
  const was = tap?.ammo ?? ammo;
  const max = bloom.free + (bloom.maxMul - 1) / bloom.perShot;
  if (ammo < was) { spray = Math.min(max, spray + (was - ammo)); firedTick = tick - 1; }
  else if (ammo > was) spray = 0;
  else if ((tick - firedTick) * TICK_MS > bloom.settleMs) spray = Math.max(0, spray - (max * TICK_MS * r.recover) / bloom.recoverMs);
  return { spray, firedTick };
}

/** How fast `e` crosses the line from `me` to him, px/s. */
const crossing = (me: Point, e: Engagement | null): number => {
  if (!e) return 0;
  const dx = e.x - me.x, dy = e.y - me.y, k = Math.hypot(dx, dy) || 1;
  return Math.abs((e.vx * dy - e.vy * dx) / k);
};

/** How far ahead it looks for the enemy it is fighting walking out of its sight (behind a wall or into smoke): a shot it must take now. */
const BREAK_LOOK_MS = 350;
function breaksSight(me: Point, e: Engagement | null, solids: readonly Rect[], smokes: Perception['smokes']): boolean {
  if (!e || (e.vx === 0 && e.vy === 0)) return false;
  const k = BREAK_LOOK_MS / 1000, fx = e.x + e.vx * k, fy = e.y + e.vy * k;
  return segmentBlocked(solids, me.x, me.y, fx - me.x, fy - me.y) || sightBlocked(smokes, me.x, me.y, fx, fy);
}

function nextStance(m: Motor, v: Perception, c: IntentCtx, planted: boolean, legMs: readonly [number, number] = STRAFE_MS): Motor['stance'] {
  const age = v.tick - m.stance.since;
  if (planted === m.stance.planted ? v.tick < m.stance.until : age < MIN_LEG_TICKS) return m.stance;
  const legFor = (step: Motor['stance']['step'], ms: readonly [number, number]) => ({ step, since: v.tick, until: v.tick + Math.max(MIN_LEG_TICKS, Math.round(between(ms, c.rand) / TICK_MS)), heading: null, planted });
  if (!planted) return legFor(m.stance.step === 0 ? (c.rand() < 0.5 ? 1 : -1) : (-m.stance.step as 1 | -1), legMs);
  const odds = v.underFire ? Math.max(UNDER_FIRE_STEP_ODDS, c.persona.sidestepOdds) : c.persona.sidestepOdds;
  const step = m.stance.step === 0 && c.rand() < odds ? (c.rand() < 0.5 ? 1 : -1) : 0;
  return legFor(step, step === 0 ? STAND_MS : STEP_MS);
}

/** A strafe leg's heading round `at`: closing in (45 degrees off head-on), side on (90), or backing off (135, back and sideways). */
type Leg = 'in' | 'side' | 'out';
const LEG_ANGLE: Record<Leg, number> = { in: Math.PI / 4, side: Math.PI / 2, out: (3 * Math.PI) / 4 };

function legHeading(me: Point, at: Point, step: 1 | -1, leg: Leg): number {
  const a = Math.atan2(at.y - me.y, at.x - me.x) + step * LEG_ANGLE[leg];
  return Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
}

function legPoint(me: Point, heading: number, arena: BotArena, mates: readonly Point[] = []): Point | null {
  const p = { x: me.x + Math.cos(heading) * STRAFE_PX, y: me.y + Math.sin(heading) * STRAFE_PX };
  return isOpen(arena.nav, p) && walkable(arena.nav, me, p) && clearOfLeaves(arena, me, p) && !mates.some((m) => dist(m, p) < MATE_CLEAR_PX && dist(m, p) < dist(m, me)) ? p : null;
}

/** Which way the mates crowding a bot would have it step: the sum of their pushes, each strongest when touching, or null when none is near. */
function shove(me: Point, mates: readonly Point[], id: number): Point | null {
  let x = 0, y = 0;
  for (const m of mates) {
    const d = dist(m, me);
    if (d >= MATE_SPACE_PX) continue;
    // Two bots on one pixel part along each one's own lane, so they do not both pick the same way.
    const [ux, uy] = d < 1 ? [Math.cos(lane(id, 2) * Math.PI * 2), Math.sin(lane(id, 2) * Math.PI * 2)] : [(me.x - m.x) / d, (me.y - m.y) / d];
    const k = 1 - d / MATE_SPACE_PX;
    x += ux * k; y += uy * k;
  }
  const len = Math.hypot(x, y);
  return len === 0 ? null : { x: x / Math.max(1, len), y: y / Math.max(1, len) };
}

function steer(intent: Intent, v: Perception, c: IntentCtx, m: Motor, readyAbility: AbilityId | null, dodge: Dodge | null, danger: Point | null): { steer: Steer; stance: Motor['stance']; dodge?: Dodge | null } {
  const me = v.me;
  const idle = (to: Point | null, face: Point | null): Steer => ({ to, face, reload: false, crates: true });
  switch (intent.k) {
    case 'patrol': return { steer: idle(intent.goal, null), stance: m.stance };
    case 'takePosition': return { steer: idle(intent.spot, intent.facing), stance: m.stance };
    case 'search': return { steer: { to: intent.at, face: intent.at, reload: false, crates: false }, stance: m.stance };
    case 'resupply': return { steer: { to: intent.at, face: null, reload: false, crates: false }, stance: m.stance };
    case 'blinded': {
      const to = intent.mode === 'fallBack' ? awayFrom(me, intent.at, c.arena, RETREAT_STEP) : null;
      return { steer: { to, face: intent.mode === 'hold' ? null : intent.at, reload: v.self.ammo < v.self.mag / 2 && intent.mode !== 'spray', crates: false }, stance: m.stance };
    }
    case 'flank': return { steer: { to: intent.via, face: intent.lastKnown, reload: false, crates: false }, stance: m.stance };
    case 'hold': {
      const there = dist(me, intent.spot) < WAYPOINT_PX * 2;
      return { steer: { to: intent.spot, face: intent.watch, reload: there && v.threats.length === 0 && v.self.ammo < v.self.mag, crates: false }, stance: m.stance };
    }
    case 'peekAndHide': {
      const t = focus(v, intent.target);
      const face = t ? t.p : v.lastSeen ?? intent.peek;
      const reload = intent.phase === 'hide' && !t && v.self.ammo < v.self.mag;
      const peeking = (to: Point, stance: Motor['stance']) => ({ steer: { to, face, reload, crates: false }, stance });
      if (intent.phase === 'hide') return peeking(intent.spot, m.stance);
      const crossMs = (PEEK_SWAY_PX / v.self.speed) * 1000;
      const stance = nextStance(m, v, c, plants(v, c, t?.d ?? 0, true), [crossMs + SWAY_PAUSE_MS[0], crossMs + SWAY_PAUSE_MS[1]]);
      if (stance.step === 0) return peeking(intent.peek, stance);
      const out = Math.atan2(intent.peek.y - intent.spot.y, intent.peek.x - intent.spot.x);
      const wide = { x: intent.peek.x + Math.cos(out) * PEEK_SWAY_PX, y: intent.peek.y + Math.sin(out) * PEEK_SWAY_PX };
      return peeking(stance.step === 1 && isOpen(c.arena.nav, wide) ? wide : intent.peek, stance);
    }
    case 'reloadInCover': {
      const safe = v.threats.length === 0 || dist(me, intent.spot) < WAYPOINT_PX * 2;
      return { steer: { to: intent.spot, face: v.threats[0]?.p ?? intent.threat, reload: safe || v.self.ammo === 0, crates: false }, stance: m.stance };
    }
    case 'retreatAndHeal': {
      const to = intent.spot ?? awayFrom(me, intent.threat, c.arena, RETREAT_STEP);
      return { steer: { to, face: v.threats[0]?.p ?? intent.threat, reload: v.threats.length === 0 && v.self.ammo < v.self.mag, crates: false }, stance: m.stance };
    }
    case 'engage': {
      const t = focus(v, intent.target);
      if (!t) {
        const leg = justLost(v) && m.stance.heading !== null ? legPoint(me, m.stance.heading, c.arena) : null;
        return { steer: { to: leg ?? (justLost(v) ? null : v.lastSeen), face: v.lastSeen, reload: false, crates: false, heading: leg ? m.stance.heading : null }, stance: m.stance };
      }
      const fight = (to: Point | null, heading: number | null = null): Steer => ({ to, face: t.p, reload: false, crates: false, heading: to ? heading : null });
      if (readyAbility === 'knife' && t.d < KNIFE_CHASE_PX) return { steer: fight(t.p), stance: m.stance };
      const closing = t.d > c.band.max || (c.band.rushes && t.d > c.band.ideal);
      // It holds its gun's range: with an enemy inside it (more of them, further out) it backs off while it fires, rather than trading at arm's length.
      const crowd = v.threats.filter((x) => x.d < CROWD_PX).length;
      const backing = !c.band.rushes && t.d < c.band.hold * (1 + CROWD_HOLD * Math.min(2, Math.max(0, crowd - 1)));
      const leg: Leg = closing ? 'in' : backing ? 'out' : 'side';
      // In a long gun's sights (or a planted gun between its own shots): it runs its dodge legs across his line instead of its usual strafe.
      if (dodge && (danger || !closing && !backing)) {
        const from = closing || backing || !danger ? t.p : danger;
        const run = dodgeLeg(me, from, dodge, leg, c.arena, v.solids, v.tick);
        const stance = { ...m.stance, step: run.to ? run.dodge.side : 0, heading: run.heading, planted: dodge.stop } as Motor['stance'];
        return { steer: fight(run.to ?? (closing && !dodge.stop ? t.p : null), run.to ? run.heading : null), stance, dodge: run.dodge };
      }
      const stance = nextStance(m, v, c, !closing && !backing && plants(v, c, t.d, false));
      const step = stance.step;
      if (step === 0) return { steer: fight(null), stance };
      let heading = stance.heading ?? legHeading(me, t.p, step, leg);
      if (backing && Math.cos(heading - Math.atan2(t.p.y - me.y, t.p.x - me.x)) > 0.2) heading = legHeading(me, t.p, step, 'out');
      const ahead = legPoint(me, heading, c.arena, v.allies);
      if (ahead) return { steer: fight(ahead, heading), stance: { ...stance, heading } };
      const back = step === 1 ? -1 : 1;
      const turned = legHeading(me, t.p, back, leg);
      const until = v.tick + Math.round(between(STRAFE_MS, c.rand) / TICK_MS);
      const turnedTo = legPoint(me, turned, c.arena, v.allies);
      return { steer: fight(turnedTo ?? (closing ? t.p : null), turnedTo ? turned : null), stance: { ...stance, step: back, heading: turned, since: v.tick, until } };
    }
  }
}

/** Intents that travel, which weave under long-range fire (see `weave`); cover, a retreat and a peek go straight. */
const WEAVES = new Set<Intent['k']>(['patrol', 'takePosition', 'search', 'flank', 'engage']);

/** Intents that wander or travel, which a mate's shadow may bend; a held spot, cover or a retreat is never moved off. */
const SPACED = new Set<Intent['k']>(['patrol', 'takePosition', 'search', 'flank', 'engage']);

/**
 * Soft separation: a bot with mates inside `MATE_SPACE_PX` steers a step away from them, so a squad does not stack in a
 * doorway or on one line of travel. Only as a bend of where it is already going (or a step apart when it stands still),
 * and only onto ground it can walk to; at a spot it is holding it stays put.
 */
function spaced(intent: Intent, me: Point & { id: number }, at: Point | null, to: Point | null, mates: readonly Point[], arena: BotArena): Point | null {
  if (!SPACED.has(intent.k) || mates.length === 0) return at;
  if (to && at && intent.k !== 'engage' && dist(me, to) < MATE_SPACE_PX) return at;
  if (intent.k !== 'engage' && doorTurn(me, at, mates, arena)) return me;
  const push = shove(me, mates, me.id);
  if (!push || (!at && Math.hypot(push.x, push.y) < MATE_SHOVE_MIN)) return at;
  const base = at ?? me;
  const k = Math.hypot(push.x, push.y);
  const bent = { x: base.x + push.x * MATE_SHOVE_PX, y: base.y + push.y * MATE_SHOVE_PX };
  return k > 0 && isOpen(arena.nav, bent) && walkable(arena.nav, me, bent) && clearOfLeaves(arena, me, bent) ? bent : at;
}

/** How far past a swing leaf's reach a spot it moves out of its sweep lands. */
const SWING_CLEAR_PX = 16;

/**
 * A spot to make for is never in the sweep of a swing door that stands open: a body there stops the leaf where it touches
 * it (leaves never crush), so a bot parked there holds the door half open and whoever pushed it is left pressing into the
 * leaf. The spot moves just out of the sweep, straight back from the door or else away from the hinge, onto open ground.
 */
function clearOfSwings(to: Point, doors: Snapshot['doors'], arena: BotArena): Point {
  for (const [i, open, sign] of doors ?? []) {
    const d = arena.doors[i];
    const h = d && open > 0 ? swingArcAt(d, sign, to, WORLD.playerRadius) : null;
    const out = d && h ? outOfSweep(to, d, sign, h, arena) : null;
    if (out) return out;
  }
  return to;
}

/** The spot just out of the sweep of hinge `h` of swing door `d` (swinging toward `sign`) nearest `to`: straight back from the door, or else away from the hinge, on open ground. */
function outOfSweep(to: Point, d: MapDoor, sign: 1 | -1, h: { x: number; y: number; len: number }, arena: BotArena): Point | null {
  const r = WORLD.playerRadius;
  const reach = h.len + r + SWING_CLEAR_PX;
  const ux = d.axis === 'h' ? 1 : 0, uy = 1 - ux, nx = uy * sign, ny = ux * sign;
  const along = (to.x - h.x) * ux + (to.y - h.y) * uy, back = (to.x - h.x) * nx + (to.y - h.y) * ny;
  const k = Math.hypot(to.x - h.x, to.y - h.y) || 1, push = Math.sqrt(Math.max(0, reach * reach - along * along)) - back;
  return [{ x: to.x + nx * push, y: to.y + ny * push }, { x: h.x + ((to.x - h.x) / k) * reach, y: h.y + ((to.y - h.y) / k) * reach }]
    .find((p) => p.x > r && p.y > r && p.x < arena.size - r && p.y < arena.size - r && isOpen(arena.nav, p)) ?? null;
}

/**
 * Where a bot stands in the way of a swing leaf on the move: the leaf stops on it (leaves never crush), and a bot that means to go
 * past it, or whoever pushed it, is left pressing into the leaf. A leaf swinging open stops on anyone in the arc it has still to
 * sweep; one swinging shut, on a bot between it and its doorway that walks into it (one going on through the doorway, out of
 * its way, is not stopped). Such a bot backs out of the sweep instead and lets the leaf swing: open, it then walks round it (see
 * `plan`); shut, it pushes it open away from itself. Null when no leaf has it in its way. Behind a leaf is not in its way.
 */
function inSweep(me: Point, at: Point, arena: BotArena): Point | null {
  const r = WORLD.playerRadius;
  for (const l of arena.swings) {
    const d = arena.doors[l.door];
    if (!d) continue;
    const a = (Math.min(255, l.open) / 255) * SWING_MAX;
    for (const h of swingHinges(d)) {
      const vx = me.x - h.x, vy = me.y - h.y, k = Math.hypot(vx, vy);
      if (k >= h.len + r) continue;
      // The leaf's shut direction from this hinge (into the doorway), and the way it swings.
      const sx = d.axis === 'h' ? (h.x === d.x ? 1 : -1) : 0, sy = d.axis === 'v' ? (h.y === d.y ? 1 : -1) : 0;
      const nx = d.axis === 'v' ? l.sign : 0, ny = d.axis === 'h' ? l.sign : 0;
      const phi = Math.atan2(vx * nx + vy * ny, vx * sx + vy * sy);
      // A leaf cannot pass a body, so a body on the far side of it from where it is going is behind it whole.
      if (l.opening ? phi <= a || phi > SWING_MAX + 0.6 : phi >= a || phi < 0 || !intoLeaf(me, at, d, l)) continue;
      // Just out of reach of the leaf: straight back or away from the hinge if it can walk there, else round the arc to where it can.
      const reach = h.len + r + SWING_CLEAR_PX;
      const near = [outOfSweep(me, d, l.sign, h, arena), ...Array.from({ length: 16 }, (_, i) => {
        const t = (i / 15) * (SWING_MAX + 0.6);
        return { x: h.x + (sx * Math.cos(t) + nx * Math.sin(t)) * reach, y: h.y + (sy * Math.cos(t) + ny * Math.sin(t)) * reach };
      })].filter((p): p is Point => p !== null && p.x > r && p.y > r && p.x < arena.size - r && p.y < arena.size - r && isOpen(arena.nav, p) && walkable(arena.nav, me, p));
      const out = near.reduce<Point | null>((best, p) => (!best || dist(p, me) < dist(best, me) ? p : best), null);
      if (out) return out;
    }
  }
  return null;
}

const INTO_LEAF_PX = 40;

/** Whether the bot's next few strides toward `at` run into the leaves of swing door `d` where they stand now. */
function intoLeaf(me: Point, at: Point, d: MapDoor, l: { open: number; sign: 1 | -1 }): boolean {
  const k = Math.min(1, INTO_LEAF_PX / Math.max(1, dist(me, at)));
  const to = { x: me.x + (at.x - me.x) * k, y: me.y + (at.y - me.y) * k };
  const leaves = doorLeaves(d, l.open, l.sign);
  for (let i = 0; i <= 4; i++) {
    const x = me.x + ((to.x - me.x) * i) / 4, y = me.y + ((to.y - me.y) * i) / 4;
    if (leaves.some((rect) => circleHitsRect(x, y, WORLD.playerRadius + 2, rect))) return true;
  }
  return false;
}

const DOOR_QUEUE_PX = 150;
const DOOR_CLEAR_PX = 110;
const LEVEL_PX = 8;

/** Whether `c` lies close to the straight way from `a` to `b` (and not behind `a`). */
function onTheWay(a: Point, b: Point, c: Point): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  if (len2 < 1) return false;
  const t = ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2;
  return t > 0 && dist(c, { x: a.x + dx * Math.min(1, t), y: a.y + dy * Math.min(1, t) }) < DOOR_QUEUE_PX * 0.5;
}

/**
 * Clearing a room: a bot heading through a door a mate is already at the door of waits its turn instead of stacking in the
 * doorway behind him. Once it is itself in the doorway it carries on, so nobody stalls there.
 */
function doorTurn(me: Point, at: Point | null, mates: readonly Point[], arena: BotArena): boolean {
  if (!at) return false;
  for (const d of arena.doors) {
    const c = doorCentre(d), mine = dist(me, c);
    if (!onTheWay(me, at, c) || mine < DOOR_CLEAR_PX || mine > DOOR_QUEUE_PX * 3) continue;
    // Whoever is nearer the door goes first; level, the one standing further west (then north) does, so two never both wait.
    const first = (m: Point) => { const dm = dist(m, c); return dm < mine - LEVEL_PX || (dm <= mine + LEVEL_PX && (m.x < me.x || (m.x === me.x && m.y < me.y))); };
    if (mates.some((m) => dist(m, c) < DOOR_QUEUE_PX && first(m))) return true;
  }
  return false;
}

/** How far down a route a fresh plan looks for standing door leaves to go round, and how far ahead a bot walking one keeps looking. */
const LEAF_PLAN_PX = 700;
const LEAF_AHEAD_PX = 260;
const LEAF_PLANS = 3;

/** The standing door leaves (not those in `skip`) on the first `px` of the walk from `me` along `points`. */
function leafAhead(arena: BotArena, me: Point, points: readonly Point[], skip: readonly string[], px: number): StandingLeaf[] {
  const out: StandingLeaf[] = [];
  if (arena.leaves.length === 0) return out;
  let from = me, left = px;
  for (const p of points) {
    const d = dist(from, p);
    const to = d > left ? { x: from.x + ((p.x - from.x) * left) / d, y: from.y + ((p.y - from.y) * left) / d } : p;
    leavesCrossed(arena, from, to, skip, out);
    left -= d;
    if (left <= 0) break;
    from = p;
  }
  return out;
}

const LEAF_WAIT_PX = 30;

/** Whether one of the `blocked` leaves still stands within `LEAF_WAIT_PX` of the bot on its way to `at`. */
function waitsAtLeaf(arena: BotArena, me: Point, at: Point, blocked: readonly string[]): boolean {
  const d = dist(me, at);
  if (d < 1 || !arena.leaves.some((l) => blocked.includes(l.key))) return false;
  const k = Math.min(1, LEAF_WAIT_PX / d);
  return leavesCrossed(arena, me, { x: me.x + (at.x - me.x) * k, y: me.y + (at.y - me.y) * k }).some((l) => blocked.includes(l.key));
}

/**
 * A route to `to` on the nav grid, and round any door leaf standing open across the near part of it: the grid has no doors in
 * it (they open), so a leaf swung out across a corridor is planned round as a solid that comes and goes, on a grid with it in
 * (`navAround`), rather than walked into. With no leaf in the way, as almost always, it costs one look down the route.
 */
function plan(arena: BotArena, me: Point, to: Point, budget = MAX_EXPANSIONS, around: readonly string[] = []): NonNullable<Motor['route']> {
  let keys = around.filter((k) => arena.leaves.some((l) => l.key === k));
  const routeOf = (found: Point[] | null, blocked?: readonly string[]): NonNullable<Motor['route']> => {
    const last = found?.[found.length - 1];
    return { goal: to, points: found ?? [to], version: arena.version, partial: last !== undefined && dist(last, to) > WAYPOINT_PX, around: keys, ...(blocked && { blocked }) };
  };
  for (let i = 0; ; i++) {
    const found = findPath(navAround(arena, keys), me, to, budget);
    if (!found && keys.length) {
      // No way round them: the way through, waiting at the leaf for it to swing shut (see `nextWaypoint`).
      const through = findPath(arena.nav, me, to, budget);
      if (through) return routeOf(through, keys);
    }
    const route = routeOf(found);
    const hit = i < LEAF_PLANS - 1 && found ? leafAhead(arena, me, found, keys, LEAF_PLAN_PX) : [];
    if (hit.length === 0) return route;
    keys = [...keys, ...hit.map((l) => l.key)];
  }
}

/**
 * The next point to walk to on the way to `to`, replanning the route when it has to (the goal moved, the walls moved, it is stuck). `plans`
 * is false between strategic thinks: a goal that has only moved along keeps the route it has, its last leg bent to the new goal, so long as
 * that leg is walkable; and on the per-tick motor (`plans` null) it never replans, only walks on.
 */
function nextWaypoint(m: Motor, me: Point, to: Point, arena: BotArena, tick: number, crawling = false, plans: boolean | null = true): { at: Point; route: Motor['route']; replanned: boolean } {
  const old = m.route;
  if (crawling && plans !== null) {
    const route = plan(arena, me, to, Infinity, old?.around);
    const points = route.partial ? route.points : [...route.points.slice(0, -1), to];
    return { at: points[0]!, route: { ...route, points }, replanned: true };
  }
  const wallsMoved = plans !== null && old !== null && old.version !== arena.version && !walkable(arena.nav, me, old.points[0] ?? to);
  // A door leaf has swung out across the way it is walking: a new route round it, even between thinks (it would rub along the leaf till then).
  const leafy = old !== null && arena.leaves.length > 0 && leafAhead(arena, me, old.points, old.around, LEAF_AHEAD_PX).length > 0;
  const partEnded = old !== null && old.partial && dist(me, old.points[old.points.length - 1]!) < WAYPOINT_PX * 2;
  const shift = old === null ? Infinity : dist(old.goal, to);
  const bendable = () => old !== null && walkable(arena.nav, old.points.length > 1 ? old.points[old.points.length - 2]! : me, to);
  // A goal that has only shifted keeps its route, bent to it at the end, if the last leg still walks; a strategic think re-plans one that moved further.
  const moved = shift > REPLAN_PX && (shift > (plans === true ? REUSE_PX : Infinity) || !bendable());
  const stuck = m.stuckTicks > STUCK_TICKS;
  // Knocked off its route (a strafe, a shove, a door leaf) with the rest of it still good: a short way back onto it, not a new route.
  const back = old?.points[0];
  const rejoin = plans !== null && back && wallsMoved && !moved && !partEnded && !stuck && !leafy ? findPath(navAround(arena, old.around), me, back, REJOIN_EXPANSIONS) : null;
  const rejoined = rejoin?.length && back && dist(rejoin[rejoin.length - 1]!, back) <= WAYPOINT_PX ? rejoin : null;
  // The rest waits for a strategic think, unless the old route cannot take it to the goal at all.
  const wanted = !old || stuck || moved || leafy || (plans === true && !rejoined && (wallsMoved || partEnded));
  const fresh = wanted && (!old || ((plans !== null || leafy) && takeReplan(arena, tick)));
  const route = fresh || !old ? plan(arena, me, to, MAX_EXPANSIONS, old && !moved ? old.around : [])
    : rejoined ? { ...old, points: [...rejoined.slice(0, -1), ...old.points], version: arena.version } : { ...old, version: arena.version };
  const tail = route.partial ? route.points : [...route.points.slice(0, -1), to];
  let points = dist(me, to) < NEAR_GOAL_PX && walkable(arena.nav, me, to) && clearOfLeaves(arena, me, to) ? [to] : tail;
  while (points.length > 1 && dist(me, points[0]!) < WAYPOINT_PX) points = points.slice(1);
  // A leaf it found no way round stands just ahead: it waits there, off the leaf, until the door swings shut (it then walks on through).
  if (route.blocked && waitsAtLeaf(arena, me, points[0]!, route.blocked)) return { at: me, route: { ...route, points }, replanned: fresh };
  return { at: points[0]!, route: { ...route, points }, replanned: fresh };
}

/**
 * Real headway since `m.progress`: its walk left shrank by `CRAWL.px` (or grew by it: a fresh, longer route starts the count
 * again), or, so long as it has not run into anything since, it got `CRAWL.px` away (a strafe or a dodge goes nowhere along
 * its route). Sliding to and fro along a wall or a half-open door leaf covers ground too, but it rubs, and gets no nearer.
 */
const headway = (m: Motor, me: Point, left: number) =>
  Math.abs(m.progress.left - left) > CRAWL.px || (!m.progress.rubbed && dist(me, m.progress) > CRAWL.px);

/** How far the bot still has to walk along its route; Infinity with none. */
function routeLeft(me: Point, route: Motor['route']): number {
  if (!route?.points.length) return Infinity;
  let left = dist(me, route.points[0]!);
  for (let i = 1; i < route.points.length; i++) left += dist(route.points[i - 1]!, route.points[i]!);
  return left;
}

const sidestepOctant = (stuckTicks: number) =>
  stuckTicks < 2 * BLOCKED_TICKS ? 0 : Math.floor((stuckTicks - 2 * BLOCKED_TICKS) / MIN_LEG_TICKS) % 2 ? -1 : 1;

type Drive = { keys: Pick<InputState, 'up' | 'down' | 'left' | 'right'>; dir: number | null; dirSince: number; pace: Motor['pace'] };

const octantGap = (a: number, b: number) => Math.min((a - b + 8) % 8, (b - a + 8) % 8);

function keysToward(m: Motor, me: Point, at: Point | null, tick: number): Drive {
  const none = { up: false, down: false, left: false, right: false };
  if (!at || dist(me, at) < ARRIVED_PX) return { keys: none, dir: null, dirSince: tick, pace: m.pace };
  const want = Math.atan2(at.y - me.y, at.x - me.x);
  const octant = ((Math.round(want / (Math.PI / 4)) % 8) + 8) % 8;
  const off = m.dir === null ? Infinity : Math.abs(Math.atan2(Math.sin(want - (m.dir * Math.PI) / 4), Math.cos(want - (m.dir * Math.PI) / 4)));
  const blocked = m.stuckTicks >= BLOCKED_TICKS;
  const hold = !blocked && m.dir !== null && (off < HOLD_SLACK || (tick - m.dirSince < MIN_HOLD_TICKS && off < Math.PI / 2));
  const detour = m.detour && tick < m.detour.until ? m.detour.side * 2 : 0;
  const dir = detour ? (octant + detour + 8) % 8 : hold && m.dir !== null ? m.dir : (octant + sidestepOctant(m.stuckTicks) + 8) % 8;
  const turnsBack = m.pace.lastDir !== null && octantGap(dir, m.pace.lastDir) >= 3;
  if (turnsBack && tick - m.pace.lastTurnBackTick < MIN_LEG_TICKS) return { keys: none, dir: null, dirSince: tick, pace: m.pace };
  const a = (dir * Math.PI) / 4, cx = Math.cos(a), cy = Math.sin(a);
  return {
    keys: { up: cy < -0.38, down: cy > 0.38, left: cx < -0.38, right: cx > 0.38 }, dir, dirSince: hold ? m.dirSince : tick,
    pace: { lastDir: dir, lastTurnBackTick: turnsBack ? tick : m.pace.lastTurnBackTick },
  };
}

/** How the gun points this tick for a `Gaze` (see there); `fire` whether it means to shoot there. */
function gazeLook(g: Gaze, me: Point, mine: Point, before: AimState, route: Motor['route'], rand: () => number, follow: Point | null = null): { look: Look; fire: boolean } {
  const rest = { want: before.want, spin: 0, d: 300 };
  switch (g.k) {
    case 'ahead': return { look: { ...(lookAt(routeAhead(me, route), me, mine) ?? rest), hand: HANDS.calm, err: before.err }, fire: false };
    case 'fixed': return { look: { want: g.want, spin: 0, d: g.d, hand: g.hand, err: g.err ?? before.err }, fire: false };
    case 'point': {
      const err = g.sigma > 0 ? drift(before.err, g.sigma, TICK_MS, rand) : before.err;
      const at = lookAt(g.follow && follow ? follow : g.at, me, mine, g.minPx);
      if (!at) return { look: { ...rest, hand: g.hand, err: before.err }, fire: false };
      return { look: { ...at, want: at.want + (g.sigma > 0 ? err : 0), hand: g.hand, err: g.sigma > 0 ? err : before.err }, fire: g.fire };
    }
  }
}

/** The aim on an enemy it has taken in: led to where he will be, off by its own drifting error; at `shoot` (a barrel or prop by him) instead if set. */
function trackLook(e: Engagement, me: Point, mine: Point, gun: GunId, sharp: Sharpness, tick: number, flash: number, before: AimState, rand: () => number, shoot: Point | null): Look {
  const def = GUNS[gun];
  const sigma = aimSigma(e, me, sharp, tick, flash);
  const err = tick === e.noticeAtTick ? landingErr(sigma, rand) : drift(before.err, sigma, TICK_MS, rand);
  if (shoot) {
    const bx = shoot.x - me.x, by = shoot.y - me.y;
    return { want: Math.atan2(by, bx) + err, spin: bearingSpin(bx, by, -mine.x, -mine.y), hand: handFor(sharp), d: Math.hypot(bx, by), err };
  }
  const meet = intercept(me, { x: e.x, y: e.y, vx: e.vx, vy: e.vy }, def.bulletSpeed, rulesOf(def).muzzleBoost, MUZZLE_PX, e.leadMul);
  const rx = meet.x - me.x, ry = meet.y - me.y;
  return { want: Math.atan2(ry, rx) + err, spin: bearingSpin(rx, ry, e.vx - mine.x, e.vy - mine.y), hand: handFor(sharp), d: dist(e, me), err };
}

/** Burst-tapping's state after this tick (see `tapRhythm`), with its read of its bloom (`ownBloom`) and the magazine it read it from. */
function nextTap(rhythm: Hold['rhythm'], fire: boolean, tap: Motor['tap'], tick: number, own: { spray: number; firedTick: number }, ammo: number): Motor['tap'] {
  if (rhythm === null) return undefined;
  const read = { spray: own.spray, firedTick: own.firedTick, ammo };
  if (!fire) return { since: null, pauseUntil: tap?.pauseUntil ?? -Infinity, ...read };
  if ((tick - (tap?.since ?? tick)) * TICK_MS >= rhythm.windowMs) return { since: null, pauseUntil: tick + Math.round(rhythm.pauseMs / TICK_MS), ...read };
  return { since: tap?.since ?? tick, pauseUntil: tap?.pauseUntil ?? -Infinity, ...read };
}

/** Whether it holds its fire this tick for its bloom (see `holdsFire`); `d` null is no enemy tracked, which it never waits on. */
function resting(rhythm: Hold['rhythm'], gun: GunId, own: { spray: number; firedTick: number }, read: { d: number | null; still: boolean; lateral: number; urgent: boolean; settle: number; settleMs: number }, tap: Motor['tap'], tick: number): boolean {
  if (rhythm === null || read.d === null) return false;
  // The patience clock runs from its last round or the end of its last sprint, whichever is later (a sprint that just ended has run none of its settle).
  const sinceSprintMs = read.settle > 0 ? (1 - read.settle) * read.settleMs : Infinity;
  return holdsFire(gun, rhythm, { ...read, d: read.d, spray: own.spray, sinceShotMs: Math.min((tick - own.firedTick) * TICK_MS, sinceSprintMs), pausing: tick < (tap?.pauseUntil ?? -Infinity) });
}

/** The per-tick bookkeeping of where it is pressing and whether it gets anywhere (see `headway`, `CRAWL`). */
function walked(m: Motor, me: Point, at: Point | null, drive: Drive, route: Motor['route'], tick: number, replanned: boolean, crawling: boolean): Pick<Motor, 'stuckTicks' | 'progress' | 'last' | 'dir' | 'dirSince' | 'pace' | 'route'> {
  const gained = at ? dist(m.last, at) - dist(me, at) : 0;
  const pressing = drive.dir !== null;
  const left = routeLeft(me, route);
  return {
    route, dir: drive.dir, dirSince: drive.dirSince, pace: drive.pace, last: { x: me.x, y: me.y },
    stuckTicks: pressing && gained < 1 && !replanned ? m.stuckTicks + 1 : 0,
    progress: !pressing || crawling || headway(m, me, left) ? { x: me.x, y: me.y, tick, left, rubbed: false } : { ...m.progress, rubbed: m.progress.rubbed || m.stuckTicks >= BLOCKED_TICKS },
  };
}

export function act(intent: Intent, v: Perception, c: IntentCtx, m: Motor, snap: Snapshot): { input: InputState; motor: Motor } {
  const me = v.me;
  const readyAbility = snap.self.abilityReadyIn === 0 ? snap.self.ability : null;
  const fighting = intent.k === 'engage' ? focus(v, intent.target) : undefined;
  const danger = dangerTo(v, m.engaged);
  // Out of a fight (on its way somewhere, the shooter maybe out of sight) any gun just weaves; in one, it dodges the way its gun fights.
  const style: DodgeStyle = fighting ? dodgeStyle(me.gun, c.band.rushes && fighting.d > c.band.ideal) : { k: 'zigzag' };
  // A slow plant-to-aim gun in a fight moves off its spot after each shot whatever it faces; anyone else dodges only a gun worth dodging.
  const dodging = (danger !== null && danger.w * c.persona.evasion >= DODGE_AT) || (style.k === 'plant' && fighting !== undefined && plants(v, c, fighting.d, false));
  const fired = snap.events.some((e) => e.e === 'shot' && e.owner === me.id);
  const dangerAt = danger && danger.w * c.persona.evasion >= DODGE_AT ? danger : null;
  const cue = dangerAt && v.shotAt?.owner === dangerAt.id ? boltCue(v.shotAt, me) : null;
  const dodgeNow = dodging ? nextDodge(m.dodge ?? null, v.tick, c, style, fired, v.self.reloading, cue) : null;
  const steered = steer(intent, v, c, m, readyAbility, dodgeNow, dangerAt);
  const { steer: s, stance } = steered;
  const dodge = steered.dodge !== undefined ? steered.dodge : dodgeNow;
  const crawling = m.dir !== null && v.tick - m.progress.tick > CRAWL.ticks;
  // Out of an open swing door's sweep, whether making for a spot or standing still (see `clearOfSwings`).
  const off = clearOfSwings(s.to ?? me, snap.doors, c.arena);
  const to = s.to ? off : off !== me ? off : null;
  const routed = to ? nextWaypoint(m, me, to, c.arena, v.tick, crawling, c.strategic !== false) : { at: null, route: m.route, replanned: false };
  // In the way of a leaf on the move: out of its way first, then on (see `inSweep`).
  const stepOut = routed.at && c.arena.swings.length ? inSweep(me, routed.at, c.arena) : null;
  const bent = stepOut ?? spaced(intent, me, routed.at, to, v.allies, c.arena);
  // On its way somewhere with a long gun shooting at it from afar: it zig-zags there rather than walking his lane.
  const weaving = dodge && dangerAt && bent && WEAVES.has(intent.k) && !(intent.k === 'engage' && fighting);
  const way = { ...routed, at: weaving ? weave(me, bent, dodge, c.arena, v.solids) : bent };
  const detour = crawling ? { side: (m.detour?.side === 1 ? -1 : 1) as 1 | -1, until: v.tick + CRAWL.detourTicks } : m.detour;
  const drive = keysToward({ ...m, detour }, me, way.at, v.tick);
  const gun = GUNS[me.gun];

  const t: Threat | undefined = intent.k === 'engage' || intent.k === 'peekAndHide' || intent.k === 'flank' ? focus(v, intent.target) : v.threats[0];
  const aimSurvivesCover = (id: number) => intent.k === 'peekAndHide' && intent.target === id;
  const held = (id: number) => m.engaged?.id === id && (v.tick - m.engagedSeen <= REACQUIRE_TICKS || aimSurvivesCover(id));
  let engaged = t ? null : m.engaged && held(m.engaged.id) ? m.engaged : null;
  const before = m.aim ?? freshAim(me.angle);
  const mine = m.aim ? { x: (me.x - m.last.x) * WORLD.tickHz, y: (me.y - m.last.y) * WORLD.tickHz } : { x: 0, y: 0 };
  // An enemy in sight is what it looks at, whatever it was about (a reload, a walk, the spot the last one was), and one well off its
  // facing it turns to quickly (`HANDS.startle`); it takes him in, and aims and fires, only once its reaction time has passed.
  // With nobody in sight but someone about, it pre-aims where he would come from (`watchPoint`: the edge of the cover he is behind, or the
  // way a shot came), whatever it is doing, as a person keeps his crosshair on the angle rather than on his own feet.
  const watch = intent.k !== 'blinded' && !t ? c.tac?.watch ?? null : null;
  const faceAt = (intent.k !== 'blinded' ? t?.p : undefined) ?? watch ?? s.face ?? v.lastSeen ?? v.lead;
  const startled = t !== undefined && faceAt === t.p && Math.abs(wrapAngle(Math.atan2(t.p.y - me.y, t.p.x - me.x) - before.angle)) > STARTLE_RAD;
  let gaze: Gaze = faceAt ? { k: 'point', at: { x: faceAt.x, y: faceAt.y }, minPx: LOOK_HOLD_INSIDE_PX, hand: startled ? HANDS.startle : HANDS.calm, sigma: 0, fire: false, follow: t !== undefined && faceAt === t.p } : { k: 'ahead' };
  const barrels = seenBarrels(snap.barrels);
  const props = seenProps(snap.props);
  let track: Hold['track'] = null;
  let threat: Situation['threat'] = null;
  if (t) {
    const tracked = held(t.p.id) ? m.engaged : null;
    const sharp = sharpnessAgainst(t.p);
    // An enemy who steps into the angle its gun already holds is shot on sight: the reaction a person has for a target he was waiting for.
    const preAimed = !tracked && !!m.hold?.watching && Math.abs(wrapAngle(Math.atan2(t.p.y - me.y, t.p.x - me.x) - before.angle)) < PRE_AIMED_RAD;
    engaged = engage(tracked, t.p, sharp, v.tick, c.rand, v.flash, c.persona.reactMul * (preAimed ? PRE_AIMED_REACT : 1));
    const shot = barrelToShoot(me, barrels, v.threats.map((x) => x.p), v.allies, c.arena.walls, gun.range)
      ?? propToShoot(me, props, v.threats.map((x) => x.p), v.allies, c.arena.walls, gun.range);
    const blocked = !shot && (shotWouldBurnMe(barrels, me, t.p) || shotWouldHurtMe(props, me, t.p));
    track = { id: t.p.id, sharp, shoot: shot ? { x: shot.x, y: shot.y } : null, fire: !blocked };
    if (v.tick >= engaged.noticeAtTick) threat = { d: t.d };
  } else if (s.crates && snap.self.ammo >= snap.self.mag / 2 && !snap.self.reloading) {
    const crate = crateInSight(me, snap.crates, [...c.arena.walls, ...c.arena.barrels], gun.range * 0.95, viewExtents(snap.self.viewRadius, BOT_VIEW_ASPECT));
    if (crate) gaze = { k: 'point', at: crate, minPx: 0, hand: HANDS.calm, sigma: 0, fire: true };
  }
  // Blind or half-blind, it still has a trigger: it rakes the spot the enemy was last in, with an error that only a flash gives.
  if (!t && intent.k === 'blinded' && intent.mode === 'spray') gaze = { k: 'point', at: intent.at, minPx: 1, hand: HANDS.calm, sigma: 0.3, fire: snap.self.ammo > 0 };
  const tracking = t !== undefined && engaged !== null && v.tick >= engaged.noticeAtTick;
  let look: Look, wantsFire: boolean;
  if (tracking) {
    look = trackLook(engaged!, me, mine, me.gun, track!.sharp, v.tick, v.flash, before, c.rand, track!.shoot);
    wantsFire = track!.shoot !== null || (t!.d < gun.range * 0.95 && track!.fire);
  } else ({ look, fire: wantsFire } = gazeLook(gaze, me, mine, before, way.route, c.rand));

  let throwAt: { x: number; y: number; err: number } | null = null;
  if (tracking) {
    const fuse = GRENADE_FUSE_MS / 1000;
    throwAt = { x: t!.p.x + engaged!.vx * fuse, y: t!.p.y + engaged!.vy * fuse, err: look.err };
  }
  // An enemy it cannot see but has just lost behind cover: a flash there is the way to push him.
  const lostFor = v.lastSeen && !t ? (v.tick - v.lastSeen.seenTick) * TICK_MS : Infinity;
  const lastKnown = v.lastSeen && !t && lostFor < 2500 && intent.k !== 'blinded' && !sightBlocked(v.smokes, me.x, me.y, v.lastSeen.x, v.lastSeen.y) ? { d: dist(v.lastSeen, me) } : null;
  if (lastKnown && v.lastSeen) throwAt = { x: v.lastSeen.x, y: v.lastSeen.y, err: drift(before.err, 0.08, TICK_MS, c.rand) };
  const situation: Situation = {
    lastKnown,
    threat, hurting: v.hpFrac < HURTING_HP_FRAC, underFire: v.underFire,
    onContestedZone: v.zones.some((z) => z.owner !== me.team && dist(z, me) < z.r),
  };
  const wanted = readyAbility !== null && ABILITY_RULES[readyAbility](situation) ? readyAbility : null;
  let keys = drive.keys;
  if (wanted === 'dash' && t) {
    const away = awayFrom(me, t.p, c.arena, RETREAT_STEP);
    keys = keysToward({ ...m, dir: null, stuckTicks: 0, pace: { lastDir: null, lastTurnBackTick: -Infinity } }, me, away, v.tick).keys;
  }
  // Fire and gas: out of a slick or cloud it stands in, and held at the edge of one on its way.
  const hazard = hazardState(hazardsOf(snap.thrown, me.id), me, way.at);
  if (hazard.k === 'in') keys = keysToward({ ...m, dir: null, stuckTicks: 0, pace: { lastDir: null, lastTurnBackTick: -Infinity } }, me, awayFrom(me, hazard.h, c.arena, RETREAT_STEP), v.tick).keys;
  else if (hazard.k === 'entering') keys = { up: false, down: false, left: false, right: false };
  let turn: Hold['turn'] = null;
  if (wanted === 'smokeGrenade' && t) {
    turn = { gaze: { k: 'fixed', want: Math.atan2(t.p.y - me.y, t.p.x - me.x), d: SMOKE_THROW_PX, hand: look.hand }, holdFire: false };
  } else if (throwAt && GRENADES.has(wanted)) {
    turn = { gaze: { k: 'fixed', want: Math.atan2(throwAt.y - me.y, throwAt.x - me.x) + throwAt.err, d: Math.hypot(throwAt.x - me.x, throwAt.y - me.y), hand: look.hand }, holdFire: false };
  }
  // A flashbang it has noticed in the air: it turns its back on it instead of watching it go off, and holds its fire while it does.
  const turnAway = v.incomingFlash !== null && v.flash <= BLIND_AT;
  if (v.incomingFlash && turnAway) turn = { gaze: { k: 'fixed', want: Math.atan2(me.y - v.incomingFlash.y, me.x - v.incomingFlash.x), d: 300, hand: HANDS.flick, err: 0 }, holdFire: true };
  if (turn) {
    const g = turn.gaze as Extract<Gaze, { k: 'fixed' }>;
    look = { ...look, want: g.want, spin: 0, d: g.d, hand: g.hand, err: g.err ?? look.err };
    if (turn.holdFire) wantsFire = false;
  }
  // A planted gun moving off its spot between shots lets go of the trigger: its next round waits until it has stopped again.
  const stillToFire = style.k === 'plant' && !!dodge && !dodge.stop;
  if (stillToFire && anyKey(keys)) wantsFire = false;
  const rhythm = fireRhythm(me.gun, c.band.rushes, c.persona.commitMul, snap.self.perks, snap.self.suppression);
  // Being shot, or the enemy about to walk out of its sight: the round goes now, bloom or not.
  const urgent = v.underFire || (t !== undefined && breaksSight(me, engaged, v.solids, v.smokes));
  const own = ownBloom(rhythm, me.gun, m.tap, snap.self.ammo, v.tick);
  const ability0 = turnAway && wanted !== null ? null : wanted;
  const rests = resting(rhythm, me.gun, own, { d: t?.d ?? null, still: !anyKey(keys), lateral: crossing(me, engaged), urgent, settle: snap.self.settle ?? 0, settleMs: snap.self.settleMs ?? 0 }, m.tap, v.tick);
  const { aim, fire, ability, shots } = aimAndTrigger(before, look, wantsFire && !rests, ability0, m.shots);
  const tap = nextTap(rhythm, fire, m.tap, v.tick, own, snap.self.ammo);
  const angle = aim.angle, aimDist = Math.max(1, look.d);
  // Not in the open with an enemy about: a half-empty magazine waits for cover from where it last saw him (a dry one never waits).
  const exposed = !!c.tac && !hiddenFromSeen(me, c.tac.seen, v.solids, v.tick);
  const reloadWish = s.reload || (!t && snap.self.ammo < snap.self.mag / 2 && (!exposed || snap.self.ammo < snap.self.mag * OPEN_RELOAD_FRAC));
  const reload = !fire && snap.self.ammo < snap.self.mag && !snap.self.reloading && reloadWish;
  // A bot sprints only to travel: with no enemy in sight (or its fight just ended) or when running to cover to heal. Anything else, it walks, so it can fire.
  const travelling = anyKey(keys);
  const calm = v.tick - m.engagedSeen > SPRINT_CALM_TICKS;
  const sprintWish = intent.k === 'retreatAndHeal' || (!t && engaged === null && v.threats.length === 0 && calm);
  const sprint = travelling && !fire && !wantsFire && wanted === null && sprintWish;

  // What the motor keeps doing until the next think: a leg is run on its heading, a bend off the route (a mate's shadow, a weave, a wait at a door) held as a point.
  const heading = weaving && way.at !== bent ? Math.atan2(way.at!.y - me.y, way.at!.x - me.x) : s.heading != null && to === s.to && bent === routed.at ? s.heading : null;
  const timers = [
    intent.k === 'engage' || intent.k === 'peekAndHide' ? stance.until : Infinity,
    intent.k === 'peekAndHide' ? intent.phaseUntil : Infinity,
    dodge && !(dodge.stop && style.k === 'plant') ? dodge.until : Infinity,
    dodge?.turnAt ?? Infinity,
    engaged && t ? engaged.noticeAtTick : Infinity,
  ].filter((x) => x > v.tick);
  const hold: Hold = {
    tick: v.tick, to, at: heading === null && way.at !== routed.at ? way.at : null, heading, keys: keys !== drive.keys ? keys : null,
    gaze, track, turn, ability: ability0, stillToFire, reload: reloadWish, sprint: sprintWish && wanted === null, mag: snap.self.mag, rhythm, settleMs: snap.self.settleMs ?? 0, urgent,
    wakeAt: Math.min(Infinity, ...timers), wakeOnFire: style.k === 'plant' && fighting !== undefined, arrived: to !== null && dist(me, to) < ARRIVED_PX * 2,
    nav: c.arena.nav.serial, door: doorOnWay(me, way.at, c.arena, snap.doors), ...(watch && faceAt === watch && { watching: true }),
  };
  return {
    input: { ...keys, angle, fire, shots, reload, ability, aimDist, use: false, sprint },
    motor: {
      ...walked(m, me, way.at, drive, way.route, v.tick, way.replanned, crawling),
      stance, detour, siegeStep: null, tending: null, engaged, engagedSeen: t ? v.tick : m.engagedSeen, aim, shots, ...(tap && { tap }),
      ...((dodge || m.dodge) && { dodge }), hold,
    },
  };
}

/** What the motor reads off the world each tick for its bot: where it is and its gun, its magazine, whether its ability is up, how flashed it is, and where a player stands (alive), by id. */
export type Body = {
  me: Point & { id: number; gun: GunId; angle: number };
  ammo: number; reloading: boolean; abilityReady: boolean; flash: number;
  /** The post-sprint bloom still to ease out on its gun, ms (see `settleShare`); left out, none. */
  settleLeftMs?: number;
  find: (id: number) => Point | null;
};

const LEG_PX = 120;

/** The door it is about to go through, if any (on its way to its next point, within a few strides), and whether it stands open now. */
function doorOnWay(me: Point, at: Point | null, arena: BotArena, doors: Snapshot['doors']): Hold['door'] {
  if (!at) return null;
  const near = DOOR_QUEUE_PX * 2;
  const i = arena.doors.findIndex((d) => {
    const c = doorCentre(d);
    return Math.abs(c.x - me.x) < near && Math.abs(c.y - me.y) < near && dist(me, c) < near && onTheWay(me, at, c);
  });
  return i < 0 ? null : { i, open: (doors ?? []).some(([j, open]) => j === i && open > 0) };
}

/**
 * Whether the bot must think before this tick's motor: its plan has nothing to run on (`strategic`), it is stuck or crawling along a wall
 * or has got where it was going (the route needs planning), a timed leg or peek is up (`Hold.wakeAt`). One not `timed` (off every screen)
 * lets its legs run on and waits at its goal for its next think; the door on its way has opened or
 * shut, or a barrel has gone up across its route. Everything it reads is already on the bot or the arena, so it costs a few comparisons.
 */
export function motorWake(m: Motor, me: Point, tick: number, arena: BotArena, doorOpen: (i: number) => boolean, timed = true): 'tactical' | 'strategic' | null {
  const h = m.hold;
  if (!h) return 'strategic';
  if (m.stuckTicks > STUCK_TICKS || (m.dir !== null && tick - m.progress.tick > CRAWL.ticks)) return 'strategic';
  if (timed && h.to && !h.arrived && h.heading === null && dist(me, h.to) < ARRIVED_PX * 2) return 'strategic';
  if (timed && tick >= h.wakeAt) return 'tactical';
  if (h.door && doorOpen(h.door.i) !== h.door.open) return 'tactical';
  const next = m.route?.points[0];
  if (h.nav !== arena.nav.serial && h.to && next && !walkable(arena.nav, me, next)) return 'strategic';
  return null;
}

/**
 * One tick of the bot's hands between thinks, carrying out `m.hold`: it walks its route (or runs its leg, or holds its spot) with the same
 * key logic and stuck bookkeeping as a think, turns its gun toward what it looks at by this tick's time, tracking its enemy where he
 * stands now and leading him, and pulls the trigger once it is on him. No snapshot, no sight lines, no planning: a few hundred operations.
 */
export function motorTick(m: Motor, b: Body, arena: BotArena, tick: number, rand: () => number): { input: InputState; motor: Motor } {
  const h = m.hold!;
  const me = b.me;
  let at: Point | null = null, route = m.route;
  if (h.heading !== null) {
    const p = { x: me.x + Math.cos(h.heading) * LEG_PX, y: me.y + Math.sin(h.heading) * LEG_PX };
    at = isOpen(arena.nav, p) && walkable(arena.nav, me, p) && clearOfLeaves(arena, me, p) ? p : null;
  } else if (h.at) at = h.at;
  else if (h.to) ({ at, route } = nextWaypoint(m, me, h.to, arena, tick, false, null));
  const drive = h.keys ? { keys: h.keys, dir: m.dir, dirSince: m.dirSince, pace: m.pace } : keysToward(m, me, at, tick);
  const keys = drive.keys;

  const before = m.aim ?? freshAim(me.angle);
  const mine = m.aim ? { x: (me.x - m.last.x) * WORLD.tickHz, y: (me.y - m.last.y) * WORLD.tickHz } : { x: 0, y: 0 };
  const foe = h.track ? b.find(h.track.id) : null;
  let engaged = m.engaged, engagedSeen = m.engagedSeen, d: number | null = null;
  let look: Look, wantsFire: boolean;
  if (h.track && foe && engaged?.id === h.track.id) {
    engaged = engage(engaged, { id: h.track.id, x: foe.x, y: foe.y }, h.track.sharp, tick, rand, b.flash);
    engagedSeen = tick;
    if (tick >= engaged.noticeAtTick) {
      look = trackLook(engaged, me, mine, me.gun, h.track.sharp, tick, b.flash, before, rand, h.track.shoot);
      d = dist(foe, me);
      wantsFire = h.track.shoot !== null || (d < GUNS[me.gun].range * 0.95 && h.track.fire);
    } else ({ look, fire: wantsFire } = gazeLook(h.gaze, me, mine, before, route, rand, foe));
  } else ({ look, fire: wantsFire } = gazeLook(h.gaze, me, mine, before, route, rand, foe));
  if (h.turn) {
    const g = h.turn.gaze as Extract<Gaze, { k: 'fixed' }>;
    look = { ...look, want: g.want, spin: 0, d: g.d, hand: g.hand, err: g.err ?? look.err };
    if (h.turn.holdFire) wantsFire = false;
  }
  if (h.stillToFire && anyKey(keys)) wantsFire = false;
  const own = ownBloom(h.rhythm, me.gun, m.tap, b.ammo, tick);
  const settleMs = h.settleMs ?? 0;
  const rests = resting(h.rhythm, me.gun, own, { d, still: !anyKey(keys), lateral: crossing(me, engaged), urgent: !!h.urgent, settle: settleShare(b.settleLeftMs ?? 0, settleMs), settleMs }, m.tap, tick);
  const { aim, fire, ability, shots } = aimAndTrigger(before, look, wantsFire && !rests, b.abilityReady ? h.ability : null, m.shots);
  const tap = nextTap(h.rhythm, fire, m.tap, tick, own, b.ammo);
  const reload = !fire && b.ammo < h.mag && !b.reloading && h.reload;
  const sprint = anyKey(keys) && !fire && !wantsFire && h.sprint;
  return {
    input: { ...keys, angle: aim.angle, fire, shots, reload, ability, aimDist: Math.max(1, look.d), use: false, sprint },
    motor: {
      ...m, ...walked(m, me, at, drive, route, tick, false, false), engaged, engagedSeen, aim, shots, ...(tap && { tap }),
      hold: h,
    },
  };
}
