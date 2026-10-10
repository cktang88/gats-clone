/**
 * What a good player reads off his screen between shots, for a bot to read too (see docs/bots/GAP.md): how each enemy he has seen stood
 * when he last saw him (where, facing which way, holding still or moving, reloading), which way the next one will come from (the edge of
 * the cover he went behind, which a person pre-aims), whether a fight is one to take (`fightOdds`), whom to shoot first (`rankThreats`), and
 * whether a corner it means to come round is held (`holdsAngle`). Everything here comes from what the bot's own view showed it: no wallhacks.
 */
import { armorShare, GUNS, WORLD, type GunId } from '../../shared/defs.ts';
import type { Rect } from '../../shared/sim/movement.ts';
import { falloffMul } from '../../shared/sim/stats.ts';
import { TICK_MS, wrapAngle } from './aim.ts';
import type { Awareness, Perception, Threat } from './awareness.ts';
import { clearShot, dist, type Point } from './nav.ts';
import { BOT_VIEW_ASPECT, type PlayerView } from '../../shared/protocol.ts';
import { screenDist } from '../../shared/lookahead.ts';

/** An enemy as the bot last saw him: where, facing which way, whether he stood (or crept) still, and the tick his reload ends (if he was reloading). */
export type Sighting = { id: number; x: number; y: number; angle: number; still: boolean; tick: number; reloadEnd: number | null; gun: GunId };

export type Tactics = {
  seen: readonly Sighting[];
  /** Where it pre-aims with no enemy in sight but one about (see `watchPoint`), or null with none. */
  watch: Point | null;
};

export const freshTactics = (): Tactics => ({ seen: [], watch: null });

/** A sighting older than this is no use for a read of how he stands. */
const SIGHTING_MS = 6000;
/** Moved less than this between two looks: he holds his spot (an angle, or he is planted). */
const STILL_PX = 24;
/** He faces this near the way to a spot: he has it pre-aimed. */
export const HELD_RAD = (15 * Math.PI) / 180;
/** An enemy seen this lately counts for where the bot pre-aims. */
const WATCH_MS = 5000;
const EDGE_STEP = (6 * Math.PI) / 180;
const EDGE_STEPS = 14;
const EDGE_RAY_PX = 420;
/** How far out along a lane it judges which corner he reaches first. */
const EDGE_NEAR_PX = 250;

/** The sightings after this think: those in sight now (as they stand), the rest kept a while. */
export function observe(prev: Tactics, v: Perception): Tactics['seen'] {
  const out: Sighting[] = [];
  for (const t of v.threats) {
    const was = prev.seen.find((s) => s.id === t.p.id);
    const still = was ? dist(was, t.p) < STILL_PX * Math.max(1, (v.tick - was.tick) / 6) : false;
    const reloadEnd = t.p.rl ? v.tick + Math.ceil((t.p.rl[1] - t.p.rl[0]) / TICK_MS) : null;
    out.push({ id: t.p.id, x: t.p.x, y: t.p.y, angle: t.p.angle, still, tick: v.tick, reloadEnd, gun: t.p.gun });
  }
  for (const s of prev.seen) if (!out.some((o) => o.id === s.id) && (v.tick - s.tick) * TICK_MS < SIGHTING_MS) out.push(s);
  return out;
}

/** Whether the enemy seen as `s` had `at` pre-aimed when last seen: still, and facing within `HELD_RAD` of it. */
export function holdsAngle(s: Sighting | undefined, at: Point, tick: number): boolean {
  if (!s || !s.still || (tick - s.tick) * TICK_MS > SIGHTING_MS) return false;
  return Math.abs(wrapAngle(Math.atan2(at.y - s.y, at.x - s.x) - s.angle)) < HELD_RAD;
}

/**
 * Where a bot with no enemy in sight but one about points its gun: at the edge of whatever hides him where he would come out (see
 * `edgeToward`), as a person holds the corner a man went behind. The one it watches is the one who shot at it lately, else the freshest and
 * nearest it has seen. Null with nobody about.
 */
export function watchPoint(v: Perception, seen: readonly Sighting[], solids: readonly Rect[]): Point | null {
  if (v.threats.length) return null;
  let src: Point | null = null, best = Infinity;
  for (const s of seen) {
    const age = (v.tick - s.tick) * TICK_MS;
    if (age > WATCH_MS) continue;
    const score = dist(s, v.me) + age * 0.15;
    if (score < best) { best = score; src = s; }
  }
  if (v.shotAt && (v.tick - v.shotAt.tick) * TICK_MS < 1500) src = v.shotAt;
  return src ? edgeToward(v.me, src, solids) : null;
}

/**
 * Where to point a gun at someone at `src` it cannot see: at him if nothing hides him, else along the first clear lane round whatever
 * does, on the side he reaches soonest (the corner on his side of the cover), as far out as he is. Null when he stands on top of it.
 */
export function edgeToward(me: Point, src: Point, solids: readonly Rect[]): Point | null {
  const d = dist(src, me);
  if (d < 1) return null;
  if (clearShot(solids, me, src)) return { x: src.x, y: src.y };
  const a0 = Math.atan2(src.y - me.y, src.x - me.x), ray = Math.min(d, EDGE_RAY_PX);
  // The first clear lane each way round, and of the two the one he reaches soonest (the corner on his side of the cover).
  let pick: { a: number; walk: number } | null = null;
  for (const side of [1, -1]) {
    for (let k = 1; k <= EDGE_STEPS; k++) {
      const a = a0 + side * k * EDGE_STEP;
      if (!clearShot(solids, me, { x: me.x + Math.cos(a) * ray, y: me.y + Math.sin(a) * ray })) continue;
      const near = Math.min(d, EDGE_NEAR_PX);
      const at = { x: me.x + Math.cos(a) * near, y: me.y + Math.sin(a) * near };
      // A lane he has no straight way into (the cover itself between) counts as the long way round.
      const walk = dist(src, at) + (clearShot(solids, src, at) ? 0 : EDGE_RAY_PX);
      if (!pick || walk < pick.walk) pick = { a, walk };
      break;
    }
  }
  return pick ? { x: me.x + Math.cos(pick.a) * d, y: me.y + Math.sin(pick.a) * d } : { x: src.x, y: src.y };
}

/** Damage a second a gun puts on a body at `d`, through `armor`, over its magazine and reload, with the share of rounds a bot or a person lands. */
function dps(gun: GunId, d: number, blockFrac: number): number {
  const def = GUNS[gun];
  if (d > def.range) return 0;
  const cone = Math.max(def.spread, 0.004);
  const hit = Math.min(1, Math.max(0.15, WORLD.playerRadius / (d * Math.tan(cone) + 1)));
  const perMs = (def.damage * def.pellets * falloffMul(gun, d) * (1 - blockFrac) * hit) / def.fireMs;
  const cycle = def.mag * def.fireMs;
  return perMs * 1000 * (cycle / (cycle + def.reloadMs));
}

/** The share of a hit `p`'s armor stops as their view shows it: none once its pool reads empty (`ap` 0), the tier's share otherwise. */
const shareOf = (p: Pick<PlayerView, 'armorTier' | 'ap'>): number => armorShare(p.armorTier, p.ap ?? 255);

/** How long a turn from facing `angle` round to `at` takes a person (or a bot) before his first aimed round: a reaction plus the turn. */
const OFF_ANGLE_MS = 320;

/**
 * Whether this fight is one to take, as a person weighs it at a glance: the log of the time he needs to kill it over the time it needs to
 * kill him, from both health bars, both guns at this range, both armors, who has whom pre-aimed, who is reloading or just sprinted (a lowered
 * gun) or just fired a slow gun at it (its bolt still cycling), its own suppression and post-sprint bloom, and the mates and enemies close by. Above 0 it should win; each 0.7 is about twice the margin.
 */
export function fightOdds(v: Perception, t: Threat, seen: readonly Sighting[]): number {
  const me = v.me, him = t.p, d = Math.max(30, t.d);
  const mine = dps(me.gun, d, shareOf(him)), his = dps(him.gun, d, shareOf(me));
  // Health by share of a full bar.
  let toKillHim = ((WORLD.baseHp * him.hp) / Math.max(1, him.maxHp) / Math.max(1e-3, mine)) * 1000;
  let toKillMe = ((WORLD.baseHp * me.hp) / Math.max(1, me.maxHp) / Math.max(1e-3, his)) * 1000;
  // Who has whom in front of his gun: one turned away loses a reaction and a turn.
  const myOff = Math.abs(wrapAngle(Math.atan2(him.y - me.y, him.x - me.x) - me.angle));
  const hisOff = Math.abs(wrapAngle(Math.atan2(me.y - him.y, me.x - him.x) - him.angle));
  if (hisOff > HELD_RAD * 2) toKillMe += OFF_ANGLE_MS * Math.min(1, hisOff / (Math.PI / 2));
  if (myOff > HELD_RAD * 2) toKillHim += OFF_ANGLE_MS * Math.min(1, myOff / (Math.PI / 2));
  const reload = seen.find((s) => s.id === him.id)?.reloadEnd;
  if (him.rl) toKillMe += Math.max(0, him.rl[1] - him.rl[0]);
  else if (reload !== null && reload !== undefined && reload > v.tick) toKillMe += (reload - v.tick) * TICK_MS;
  if (v.self.reloading) toKillHim += GUNS[me.gun].reloadMs * (1 - v.self.reloadFrac);
  else if (v.self.ammo === 0) toKillHim += GUNS[me.gun].reloadMs;
  if (him.sprint) toKillMe += 250;
  // A slow gun (a bolt-action, a slug) that has just fired at it is still cycling: the time to its next round is the window to push him.
  const cycle = GUNS[him.gun].fireMs;
  if (v.shotAt?.owner === him.id && cycle >= BOLT_MS) toKillMe += Math.max(0, cycle - (v.tick - v.shotAt.tick) * TICK_MS);
  toKillHim *= 1 + v.self.suppression * 0.5 + (v.self.settle ?? 0) * 0.5;
  let odds = Math.max(-ODDS_CAP, Math.min(ODDS_CAP, Math.log(toKillMe / toKillHim)));
  // One nearly dead that it drops in a moment is worth finishing, whoever is coming.
  if (him.hp / Math.max(1, him.maxHp) < 0.3 && toKillHim < FINISH_MS) odds += 0.5;
  // Numbers: never a 1v2. Each other enemy that can get on it (in sight close by, or seen lately and close: coming up on it) weighs on
  // the fight, one turned on someone else (busy in a fight of his own) less; each mate by it weighs the other way.
  const mates = v.allies.filter((m) => dist(m, me) < MATES_PX).length;
  odds += NUMBERS_WEIGHT * (Math.min(2, mates) - Math.min(3, othersOn(v, t, seen)));
  return odds;
}

const FINISH_MS = 600;
/** A gun this slow between rounds leaves a window to push its man once he has fired. */
const BOLT_MS = 600;
/** A gun that cannot reach him at all is a lost fight, not an infinitely lost one. */
const ODDS_CAP = 3;
const MATES_PX = 500;
const OTHERS_PX = 750;
const NUMBERS_WEIGHT = 0.45;

/**
 * The enemies besides `t` that can get on this bot: in sight within `OTHERS_PX` (0.6 if turned away, fighting someone else), or seen there in
 * the last 2.5 s (half). Those in sight are already on its screen-shaped sight box; one only remembered counts within the screen's shape
 * (`screenDist`): 750 px to either side, 422 above or below.
 */
export function othersOn(v: Perception, t: Threat | null, seen: readonly Sighting[]): number {
  const near = (p: Point) => screenDist(p.x - v.me.x, p.y - v.me.y, BOT_VIEW_ASPECT) <= OTHERS_PX;
  let n = 0;
  for (const x of v.threats) {
    if (x === t || x.d > OTHERS_PX) continue;
    n += Math.abs(wrapAngle(Math.atan2(v.me.y - x.p.y, v.me.x - x.p.x) - x.p.angle)) < Math.PI / 4 ? 1 : 0.6;
  }
  for (const s of seen) {
    if (s.id === t?.p.id || v.threats.some((x) => x.p.id === s.id) || (v.tick - s.tick) * TICK_MS > 2500 || !near(s)) continue;
    n += 0.5;
  }
  return n;
}

/**
 * Whom to shoot first, as a person picks: whoever is shooting at it, then the most dangerous (a hunted enemy, a climbed human), then
 * whoever it would drop soonest (low health, reloading, close), those facing it before those turned away. The order `perceive` gave breaks ties.
 */
export function rankThreats(v: Perception, seen: readonly Sighting[]): readonly Threat[] {
  if (v.threats.length < 2) return v.threats;
  const shoots = (t: Threat) => (v.shooters?.includes(t.p.id) ? 1 : 0);
  const score = (t: Threat) => {
    const facing = Math.abs(wrapAngle(Math.atan2(v.me.y - t.p.y, v.me.x - t.p.x) - t.p.angle)) < HELD_RAD * 2 ? 0.25 : 0;
    const s = seen.find((x) => x.id === t.p.id);
    const reloading = t.p.rl || (s?.reloadEnd ?? -1) > v.tick ? 0.3 : 0;
    return (1 - t.p.hp / Math.max(1, t.p.maxHp)) * 0.6 + facing + reloading - t.d / 1500;
  };
  // A hunted enemy or a climbed human stays first, as `perceive` put him (the one most worth the bot's sharpest aim).
  const danger = (t: Threat) => (t.p.hunted ? 99 : t.p.kind === 'human' ? t.p.level : 0);
  return [...v.threats].map((t, i) => ({ t, i, s: score(t) })).sort((a, b) => shoots(b.t) - shoots(a.t) || danger(b.t) - danger(a.t) || b.s - a.s || a.i - b.i).map((x) => x.t);
}

/** Whether the bot stands hidden from every place it last saw an enemy lately (`within` ms): a safe spot to reload. */
export function hiddenFromSeen(me: Point, seen: readonly Sighting[], solids: readonly Rect[], tick: number, within = 3000): boolean {
  return seen.every((s) => (tick - s.tick) * TICK_MS > within || !clearShot(solids, me, s));
}

/**
 * A think's read of the fight, from what `perceive` gave it: the sightings kept for enemies it still remembers alive (`prev` is null on a
 * fresh life), its threats re-ranked by whom to shoot first, and where it pre-aims.
 */
export function readTactics(prev: Tactics | null, view: Perception, awareness: Awareness): { view: Perception; tactics: Tactics } {
  const live = new Set(awareness.contacts.map((c) => c.id));
  const seen = observe(prev ?? freshTactics(), view).filter((s) => live.has(s.id));
  const ranked = { ...view, threats: rankThreats(view, seen) };
  return { view: ranked, tactics: { seen, watch: watchPoint(ranked, seen, view.solids) } };
}
