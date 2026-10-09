import { GUNS, rulesOf, WORLD, type GunId } from '../../shared/defs.ts';
import { flightSec } from '../../shared/sim/ballistics.ts';
import { TICK_MS, wrapAngle, type Engagement } from './aim.ts';
import type { BotArena } from './arena.ts';
import type { Perception } from './awareness.ts';
import { GUN_BAND, type IntentCtx } from './intent.ts';
import { between, clearShot, isOpen, walkable, type Point } from './nav.ts';

/**
 * Getting out of a long gun's line of fire. A bot that a sniper (or any long rifle) has its sights on does not stand in the lane: it moves
 * across the line in uneven legs (an ADAD rhythm, sometimes a quick juke back), so a round led at where it was going lands where it is not.
 * How it does that is down to its own gun (`DodgeStyle`) and how much the threat is worth dodging is down to the threat's gun (`dangerOf`)
 * and the bot's temper (`Personality.evasion`, `dodgeMs`). Against short guns it barely bothers: those it beats by holding its band.
 */
export type Dodge = {
  side: 1 | -1; until: number; stop: boolean;
  /** Reading a slow gun's bolt: the tick it cuts back the other way, timed to land just after his next round leaves (see `boltCue`). */
  turnAt?: number;
  /** The expected shot it has already timed a cut for, so it reads each one once. */
  cue?: number;
};
export type Danger = { x: number; y: number; id: number; w: number };

/** How much a gun aimed at a bot is worth dodging: a plant-to-aim pick most, a long rifle less, a mid-range gun some, a short gun barely. */
export function dangerOf(gun: GunId): number {
  const def = GUNS[gun];
  if (def.base === 'sniper' || rulesOf(def).plant === 'always') return 1;
  const ideal = GUN_BAND[gun][1];
  return ideal >= 450 ? 0.7 : ideal >= 300 ? 0.4 : 0.15;
}

/** A bot dodges when the threat's weight times its own `evasion` reaches this. */
export const DODGE_AT = 0.45;
/** A gun is pointed at a bot when its bearing is within this many body widths of him (plus a little slack). */
const AIM_BODIES = 3;
const AIM_SLACK = 0.08;
/** A threat not pointing at this bot, or running (gun down), is worth this share of its weight. */
const NOT_AIMED = 0.5;
const SPRINTING = 0.3;
/**
 * Inside a long gun's own comfortable range (its band's `headOn`) it is the one out of place: from there in to half of it the threat fades to
 * `CLOSE_MUL` of itself, and the bot fights him with its own band (a rusher rushes, a rifle strafes) rather than dancing.
 */
const CLOSE_MUL = 0.4;
const closeness = (gun: GunId, d: number) => {
  const near = GUN_BAND[gun][0];
  return CLOSE_MUL + (1 - CLOSE_MUL) * Math.min(1, Math.max(0, (d - near / 2) / Math.max(1, near / 2)));
};
/** A long gun standing still is set to fire: a little more worth dodging. */
const PLANTED_PX_S = 40;
const PLANTED_MUL = 1.15;

export const aimedAt = (from: Point & { angle: number }, me: Point): boolean => {
  const d = Math.hypot(me.x - from.x, me.y - from.y);
  return Math.abs(wrapAngle(from.angle - Math.atan2(me.y - from.y, me.x - from.x))) < Math.atan2(WORLD.playerRadius * AIM_BODIES, d) + AIM_SLACK;
};

/** The most dangerous gun pointed this bot's way: one in sight, else one heard firing at it from out of sight (`Perception.shotAt`). */
export function dangerTo(v: Perception, engaged: Engagement | null): Danger | null {
  let best: Danger | null = null;
  for (const t of v.threats) {
    let w = dangerOf(t.p.gun) * closeness(t.p.gun, t.d) * (aimedAt(t.p, v.me) ? 1 : NOT_AIMED) * (t.p.sprint ? SPRINTING : 1);
    if (engaged?.id === t.p.id && Math.hypot(engaged.vx, engaged.vy) < PLANTED_PX_S) w *= PLANTED_MUL;
    if (!best || w > best.w) best = { x: t.p.x, y: t.p.y, id: t.p.id, w };
  }
  const s = v.shotAt;
  if (s && v.threats.every((t) => t.p.id !== s.owner)) {
    const w = dangerOf(s.gun) * closeness(s.gun, Math.hypot(s.x - v.me.x, s.y - v.me.y));
    if (!best || w > best.w) best = { x: s.x, y: s.y, id: s.owner, w };
  }
  return best;
}

/**
 * How a bot's own gun moves under fire. `plant`: a slow plant-to-aim gun stands for its shot and moves only while the bolt cycles (or it
 * reloads), so it is never a still target between shots. `counter`: a gun that is worse on the move counter-strafes, a leg and then a short
 * stop to fire true. `zigzag`: a rusher closing in, or a gun with no move penalty, keeps moving.
 */
export type DodgeStyle = { k: 'plant'; moveMs: number } | { k: 'counter'; stopMs: readonly [number, number] } | { k: 'zigzag' };

/** The margin a planted gun leaves between the end of its repositioning and its next shot, on top of its steady time. */
const PLANT_MARGIN_MS = 250;
const MIN_MOVE_MS = 300;
/** A counter-strafe stop: the gun's steady time, then a tap. */
const STOP_TAP_MS: readonly [number, number] = [150, 350];

export function dodgeStyle(gun: GunId, rushing: boolean): DodgeStyle {
  const def = GUNS[gun], r = rulesOf(def);
  const moveMs = def.fireMs - r.steadyMs - PLANT_MARGIN_MS;
  if (r.plant === 'always' && moveMs >= MIN_MOVE_MS) return { k: 'plant', moveMs };
  if (rushing || (r.movingSpreadAdd <= 0.3 * def.spread && r.steadyMs === 0)) return { k: 'zigzag' };
  return { k: 'counter', stopMs: [r.steadyMs + STOP_TAP_MS[0], r.steadyMs + STOP_TAP_MS[1]] };
}

/** Most legs turn back the other way; the rest carry on, so the rhythm is not a metronome. */
const FLIP_ODDS = 0.8;
/** A quick juke: a short leg in the middle of the long ones. */
const JUKE_ODDS = 0.25;
const JUKE_MS: readonly [number, number] = [400, 650];
const COUNTER_STOP_ODDS = 0.6;
/** After a counter-strafe stop it more often goes back the way it came than on. */
const AFTER_STOP_FLIP_ODDS = 0.7;
/** How many ticks early a read of the bolt may come (too early, and he sees the new way and leads it). */
const CUE_EARLY = 2;
/** The share of bolts even the most careful bot reads (times its `evasion`). */
const CUE_READ = 0.85;
/** No leg is shorter than the motor's turn-back guard (`MIN_TURN_BACK_MS` in motor.ts), or it would just stand still. */
const MIN_LEG_MS = 400;

const ticks = (ms: number) => Math.max(1, Math.round(ms / TICK_MS));

/**
 * A slow gun (a bolt, a pump) that has just fired at this bot will fire again when its action is back: `at` is that tick and `flight` how
 * many ticks the round then takes to arrive. A change of direction while it is in the air is what makes a led shot miss. Null for a fast gun.
 */
export type Cue = { at: number; flight: number };
export const SLOW_GUN_MS = 600;
export function boltCue(shot: { x: number; y: number; tick: number; gun: GunId } | null | undefined, me: Point): Cue | null {
  if (!shot) return null;
  const def = GUNS[shot.gun];
  if (def.fireMs < SLOW_GUN_MS) return null;
  const sec = flightSec(def.bulletSpeed, Math.hypot(me.x - shot.x, me.y - shot.y), rulesOf(def).muzzleBoost);
  return { at: shot.tick + ticks(def.fireMs), flight: Math.max(1, Math.round((sec * 1000) / TICK_MS)) };
}

/**
 * The next dodge leg. `fired` is that this bot's own round left this tick (a planted gun moves off its spot then); `reloading` keeps a
 * planted gun moving. Uses only `c.rand`, so a seeded world plays out the same.
 */
export function nextDodge(prev: Dodge | null, tick: number, c: IntentCtx, style: DodgeStyle, fired: boolean, reloading: boolean, cue: Cue | null = null): Dodge {
  const flip = (side: 1 | -1, odds = FLIP_ODDS) => (c.rand() < odds ? (-side as 1 | -1) : side);
  const first = (): 1 | -1 => (c.rand() < 0.5 ? 1 : -1);
  // Cutting back on the read of his bolt: a fresh leg the other way, whatever was left of this one.
  if (prev?.turnAt !== undefined && tick >= prev.turnAt) {
    const { turnAt: _, ...rest } = prev;
    return { ...rest, side: -prev.side as 1 | -1, stop: false, until: tick + ticks(between(c.persona.dodgeMs, c.rand)) };
  }
  // His next round is due: it times a cut back for the moment it is in the air (a person's read of it, so a tick or two either way), unless it is
  // already turning then. Not every bot reads it, and a planted gun does its own thing.
  if (cue && style.k !== 'plant' && prev && !prev.stop && prev.cue !== cue.at && tick < cue.at && prev.until > cue.at) {
    const read = c.rand() < c.persona.evasion * CUE_READ;
    const turnAt = cue.at - CUE_EARLY + Math.floor(c.rand() * (cue.flight + CUE_EARLY));
    return read ? { ...prev, cue: cue.at, turnAt } : { ...prev, cue: cue.at };
  }
  if (style.k === 'plant') {
    if (fired || (reloading && (!prev || prev.stop))) return { side: prev ? flip(prev.side, 0.6) : first(), until: tick + ticks(fired ? style.moveMs : 600), stop: false };
    if (prev && tick < prev.until) return prev;
    return reloading ? { side: prev ? flip(prev.side) : first(), until: tick + ticks(600), stop: false } : { side: prev?.side ?? first(), until: tick + 1, stop: true };
  }
  if (prev && tick < prev.until) return prev;
  const leg = (side: 1 | -1): Dodge => ({ side, until: tick + ticks(Math.max(MIN_LEG_MS, c.rand() < JUKE_ODDS ? between(JUKE_MS, c.rand) : between(c.persona.dodgeMs, c.rand))), stop: false });
  if (!prev) return leg(first());
  if (prev.stop) return leg(flip(prev.side, AFTER_STOP_FLIP_ODDS));
  if (style.k === 'counter' && c.rand() < COUNTER_STOP_ODDS) return { side: prev.side, until: tick + ticks(between(style.stopMs, c.rand)), stop: true };
  return leg(flip(prev.side));
}

const LEG_PX = 120;
/** The way a dodge leg runs: across the line from `from` (side), angled in toward it (in) or away (out), snapped to the eight key directions. */
export function dodgeHeading(me: Point, from: Point, side: 1 | -1, lean: 'in' | 'side' | 'out'): number {
  const off = lean === 'in' ? Math.PI / 4 : lean === 'out' ? (3 * Math.PI) / 4 : Math.PI / 2;
  const a = Math.atan2(from.y - me.y, from.x - me.x) + side * off;
  return Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
}

/** Where a leg along `heading` ends, if the bot can get there: open ground on the nav grid, walkable, nothing solid (a crate) in the way. */
export function dodgePoint(me: Point, heading: number, arena: BotArena, solids: readonly { x: number; y: number; w: number; h: number }[], px = LEG_PX): Point | null {
  const p = { x: me.x + Math.cos(heading) * px, y: me.y + Math.sin(heading) * px };
  return isOpen(arena.nav, p) && walkable(arena.nav, me, p) && clearShot(solids, me, p) ? p : null;
}

/**
 * The leg to run this tick: on `dodge.side` if that way is clear, else the other way (and the dodge turns with it, so a wall ends a leg
 * early rather than pinning the bot against it). Null when both ways are shut, or the dodge is a stop.
 */
export function dodgeLeg(me: Point, from: Point, dodge: Dodge, lean: 'in' | 'side' | 'out', arena: BotArena, solids: Parameters<typeof dodgePoint>[3], tick: number): { to: Point | null; heading: number | null; dodge: Dodge } {
  if (dodge.stop) return { to: null, heading: null, dodge };
  for (const side of [dodge.side, -dodge.side as 1 | -1]) {
    const heading = dodgeHeading(me, from, side, lean);
    const to = dodgePoint(me, heading, arena, solids);
    if (to) return { to, heading, dodge: side === dodge.side ? dodge : { ...dodge, side, until: Math.max(dodge.until, tick + ticks(MIN_LEG_MS)) } };
  }
  return { to: null, heading: null, dodge };
}

/** Travelling while something is shooting at it from afar: the bot weaves, each step bent 45 degrees to the side its dodge is on. */
export function weave(me: Point, at: Point, dodge: Dodge, arena: BotArena, solids: Parameters<typeof dodgePoint>[3]): Point {
  if (dodge.stop || Math.hypot(at.x - me.x, at.y - me.y) < LEG_PX) return at;
  const heading = Math.atan2(at.y - me.y, at.x - me.x) + dodge.side * (Math.PI / 4);
  return dodgePoint(me, heading, arena, solids) ?? at;
}
