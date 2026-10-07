import { GUNS, rulesOf, WORLD, type AbilityId } from '../../shared/defs.ts';
import { DEFAULT_VIEW_ASPECT, viewExtents, type CrateView, type InputState, type Snapshot } from '../../shared/protocol.ts';
import { GRENADE_FUSE_MS } from '../../shared/sim/abilities.ts';
import { KNIFE_LUNGE, KNIFE_REACH, segmentEntersRectAt, type Rect } from '../../shared/sim/movement.ts';
import { aimAndTrigger, aimSigma, bearingSpin, drift, engage, freshAim, GRENADES, handFor, HANDS, landingErr, leadSeconds, sharpnessAgainst, TICK_MS, type AimState, type Engagement, type Look } from './aim.ts';
import { takeReplan, type BotArena } from './arena.ts';
import { focus, type Perception, type Threat } from './awareness.ts';
import { justLost, type Intent, type IntentCtx } from './intent.ts';
import { between, clearShot, dist, findPath, isOpen, walkable, type Point } from './nav.ts';

export type Motor = {
  route: { goal: Point; points: readonly Point[]; version: number; partial: boolean } | null;
  dir: number | null;
  dirSince: number;
  pace: { lastDir: number | null; lastTurnBackTick: number };
  stance: { step: 0 | 1 | -1; since: number; until: number; heading: number | null; planted: boolean };
  last: Point;
  stuckTicks: number;
  engaged: Engagement | null;
  engagedSeen: number;
  aim: AimState | null;
  shots: number;
};

export const freshMotor = (): Motor => ({
  route: null, dir: null, dirSince: 0, pace: { lastDir: null, lastTurnBackTick: -Infinity }, stance: { step: 0, since: 0, until: 0, heading: null, planted: true }, last: { x: 0, y: 0 }, stuckTicks: 0, engaged: null, engagedSeen: -Infinity, aim: null, shots: 0,
});

/** What a bot weighs when deciding whether its ability helps right now. `threat` is the enemy it is fighting, once its reaction delay has passed. */
export type Situation = { threat: { d: number } | null; hurting: boolean; underFire: boolean; onContestedZone: boolean };

/** Lunge plus reach, leaving the target's radius as slack so a strafing target is still caught. */
const KNIFE_REACH_PX = KNIFE_LUNGE + KNIFE_REACH;
const throwRange = (s: Situation) => s.threat !== null && s.threat.d >= 150 && s.threat.d <= 450;

export const ABILITY_RULES: Record<AbilityId, (s: Situation) => boolean> = {
  knife: (s) => s.threat !== null && s.threat.d <= KNIFE_REACH_PX,
  grenade: throwRange,
  fragGrenade: throwRange,
  gasGrenade: throwRange,
  landMine: (s) => (s.hurting && s.threat !== null) || s.onContestedZone,
  dash: (s) => s.hurting && s.threat !== null,
  engineer: (s) => s.underFire && s.threat !== null && s.threat.d >= 200 && s.threat.d <= 500,
};

export const HURTING_HP_FRAC = 0.4;
const KNIFE_CHASE_PX = 300;
const REACQUIRE_TICKS = Math.round(600 / TICK_MS);
const RETREAT_STEP = 240 + WORLD.playerRadius;
const WAYPOINT_PX = 16;
const ARRIVED_PX = 14;
const MIN_HOLD_TICKS = 3;
const HOLD_SLACK = (35 * Math.PI) / 180;
const STUCK_TICKS = 12;
const BLOCKED_TICKS = 3;
const REPLAN_PX = 48;
const NEAR_GOAL_PX = 300;
const MAX_EXPANSIONS = 6000;
const STAND_MS: readonly [number, number] = [700, 1500];
const STEP_MS: readonly [number, number] = [300, 700];
const UNDER_FIRE_STEP_ODDS = 0.75;
const STRAFE_MS: readonly [number, number] = [450, 1000];
const STRAFE_PX = 120;
const PEEK_SWAY_PX = 70;
const SWAY_PAUSE_MS: readonly [number, number] = [100, 250];
export const MIN_TURN_BACK_MS = 400;
const MIN_LEG_TICKS = Math.round(MIN_TURN_BACK_MS / TICK_MS);

const crateRect = (c: CrateView): Rect => ({ x: c.x, y: c.y, w: c.size, h: c.size });

function retreatHeading(me: Point, away: number, arena: BotArena): number {
  const headings = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4)
    .filter((h) => Math.cos(h - away) > 0)
    .sort((a, b) => Math.cos(b - away) - Math.cos(a - away));
  const clear = headings.find((h) => {
    const dx = Math.cos(h) * RETREAT_STEP, dy = Math.sin(h) * RETREAT_STEP;
    const ex = me.x + dx, ey = me.y + dy, r = WORLD.playerRadius;
    if (ex < r || ey < r || ex > arena.size - r || ey > arena.size - r) return false;
    return !arena.walls.some((w) => segmentEntersRectAt(me.x, me.y, dx, dy, w) !== null);
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

type Steer = { to: Point | null; face: Point | null; reload: boolean; crates: boolean };

const LOOK_HOLD_INSIDE_PX = 150;
const LOOK_AHEAD_PX = 400;

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

function nextStance(m: Motor, v: Perception, c: IntentCtx, planted: boolean, legMs: readonly [number, number] = STRAFE_MS): Motor['stance'] {
  const age = v.tick - m.stance.since;
  if (planted === m.stance.planted ? v.tick < m.stance.until : age < MIN_LEG_TICKS) return m.stance;
  const legFor = (step: Motor['stance']['step'], ms: readonly [number, number]) => ({ step, since: v.tick, until: v.tick + Math.max(MIN_LEG_TICKS, Math.round(between(ms, c.rand) / TICK_MS)), heading: null, planted });
  if (!planted) return legFor(m.stance.step === 0 ? (c.rand() < 0.5 ? 1 : -1) : (-m.stance.step as 1 | -1), legMs);
  const odds = v.underFire ? Math.max(UNDER_FIRE_STEP_ODDS, c.persona.sidestepOdds) : c.persona.sidestepOdds;
  const step = m.stance.step === 0 && c.rand() < odds ? (c.rand() < 0.5 ? 1 : -1) : 0;
  return legFor(step, step === 0 ? STAND_MS : STEP_MS);
}

function legHeading(me: Point, at: Point, step: 1 | -1, advance: boolean): number {
  const a = Math.atan2(at.y - me.y, at.x - me.x) + (step * Math.PI) / (advance ? 4 : 2);
  return Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
}

function legPoint(me: Point, heading: number, arena: BotArena): Point | null {
  const p = { x: me.x + Math.cos(heading) * STRAFE_PX, y: me.y + Math.sin(heading) * STRAFE_PX };
  return isOpen(arena.nav, p) && walkable(arena.nav, me, p) ? p : null;
}

function steer(intent: Intent, v: Perception, c: IntentCtx, m: Motor, readyAbility: AbilityId | null): { steer: Steer; stance: Motor['stance'] } {
  const me = v.me;
  const idle = (to: Point | null, face: Point | null): Steer => ({ to, face, reload: false, crates: true });
  switch (intent.k) {
    case 'patrol': return { steer: idle(intent.goal, null), stance: m.stance };
    case 'takePosition': return { steer: idle(intent.spot, intent.facing), stance: m.stance };
    case 'search': return { steer: { to: intent.at, face: intent.at, reload: false, crates: false }, stance: m.stance };
    case 'flank': return { steer: { to: intent.via, face: intent.lastKnown, reload: false, crates: false }, stance: m.stance };
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
      return { steer: { to: intent.spot, face: intent.threat, reload: safe || v.self.ammo === 0, crates: false }, stance: m.stance };
    }
    case 'retreatAndHeal': {
      const to = intent.spot ?? awayFrom(me, intent.threat, c.arena, RETREAT_STEP);
      return { steer: { to, face: v.threats[0]?.p ?? intent.threat, reload: v.threats.length === 0 && v.self.ammo < v.self.mag, crates: false }, stance: m.stance };
    }
    case 'engage': {
      const t = focus(v, intent.target);
      if (!t) {
        const leg = justLost(v) && m.stance.heading !== null ? legPoint(me, m.stance.heading, c.arena) : null;
        return { steer: { to: leg ?? (justLost(v) ? null : v.lastSeen), face: v.lastSeen, reload: false, crates: false }, stance: m.stance };
      }
      const fight = (to: Point | null): Steer => ({ to, face: t.p, reload: false, crates: false });
      if (readyAbility === 'knife' && t.d < KNIFE_CHASE_PX) return { steer: fight(t.p), stance: m.stance };
      const closing = t.d > c.band.max || (c.band.rushes && t.d > c.band.ideal);
      const stance = nextStance(m, v, c, !closing && plants(v, c, t.d, false));
      const step = stance.step;
      if (step === 0) return { steer: fight(null), stance };
      const heading = stance.heading ?? legHeading(me, t.p, step, closing);
      const ahead = legPoint(me, heading, c.arena);
      if (ahead) return { steer: fight(ahead), stance: { ...stance, heading } };
      const back = step === 1 ? -1 : 1;
      const turned = legHeading(me, t.p, back, closing);
      const until = v.tick + Math.round(between(STRAFE_MS, c.rand) / TICK_MS);
      return { steer: fight(legPoint(me, turned, c.arena) ?? (closing ? t.p : null)), stance: { ...stance, step: back, heading: turned, since: v.tick, until } };
    }
  }
}

function plan(arena: BotArena, me: Point, to: Point): NonNullable<Motor['route']> {
  const found = isOpen(arena.nav, me) || walkable(arena.nav, me, to) ? findPath(arena.nav, me, to, MAX_EXPANSIONS) : null;
  const last = found?.[found.length - 1];
  return { goal: to, points: found ?? [to], version: arena.version, partial: last !== undefined && dist(last, to) > WAYPOINT_PX };
}

function nextWaypoint(m: Motor, me: Point, to: Point, arena: BotArena, tick: number): { at: Point; route: Motor['route']; replanned: boolean } {
  const old = m.route;
  const wallsMoved = old !== null && old.version !== arena.version && !walkable(arena.nav, me, old.points[0] ?? to);
  const partEnded = old !== null && old.partial && dist(me, old.points[old.points.length - 1]!) < WAYPOINT_PX * 2;
  const wanted = !old || wallsMoved || partEnded || dist(old.goal, to) > REPLAN_PX || m.stuckTicks > STUCK_TICKS;
  const fresh = wanted && (!old || takeReplan(arena, tick));
  const route = fresh || !old ? plan(arena, me, to) : { ...old, version: arena.version };
  const tail = route.partial ? route.points : [...route.points.slice(0, -1), to];
  let points = dist(me, to) < NEAR_GOAL_PX && walkable(arena.nav, me, to) ? [to] : tail;
  while (points.length > 1 && dist(me, points[0]!) < WAYPOINT_PX) points = points.slice(1);
  return { at: points[0]!, route: { ...route, points }, replanned: fresh };
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
  const dir = hold && m.dir !== null ? m.dir : (octant + sidestepOctant(m.stuckTicks) + 8) % 8;
  const turnsBack = m.pace.lastDir !== null && octantGap(dir, m.pace.lastDir) >= 3;
  if (turnsBack && tick - m.pace.lastTurnBackTick < MIN_LEG_TICKS) return { keys: none, dir: null, dirSince: tick, pace: m.pace };
  const a = (dir * Math.PI) / 4, cx = Math.cos(a), cy = Math.sin(a);
  return {
    keys: { up: cy < -0.38, down: cy > 0.38, left: cx < -0.38, right: cx > 0.38 }, dir, dirSince: hold ? m.dirSince : tick,
    pace: { lastDir: dir, lastTurnBackTick: turnsBack ? tick : m.pace.lastTurnBackTick },
  };
}

export function act(intent: Intent, v: Perception, c: IntentCtx, m: Motor, snap: Snapshot): { input: InputState; motor: Motor } {
  const me = v.me;
  const readyAbility = snap.self.abilityReadyIn === 0 ? snap.self.ability : null;
  const { steer: s, stance } = steer(intent, v, c, m, readyAbility);
  const way = s.to ? nextWaypoint(m, me, s.to, c.arena, v.tick) : { at: null, route: m.route, replanned: false };
  const drive = keysToward(m, me, way.at, v.tick);
  const moved = dist(me, m.last);
  const pressing = drive.dir !== null;
  const gun = GUNS[me.gun];

  const t: Threat | undefined = intent.k === 'engage' || intent.k === 'peekAndHide' || intent.k === 'flank' ? focus(v, intent.target) : v.threats[0];
  const aimSurvivesCover = (id: number) => intent.k === 'peekAndHide' && intent.target === id;
  const held = (id: number) => m.engaged?.id === id && (v.tick - m.engagedSeen <= REACQUIRE_TICKS || aimSurvivesCover(id));
  let engaged = t ? null : m.engaged && held(m.engaged.id) ? m.engaged : null;
  const before = m.aim ?? freshAim(me.angle);
  const mine = m.aim ? { x: (me.x - m.last.x) * WORLD.tickHz, y: (me.y - m.last.y) * WORLD.tickHz } : { x: 0, y: 0 };
  const idle = lookAt(s.face ?? v.lastSeen ?? v.lead ?? routeAhead(me, way.route), me, mine);
  let look: Look = { ...(idle ?? { want: before.want, spin: 0, d: 300 }), hand: HANDS.calm, err: before.err };
  let wantsFire = false;
  let threat: Situation['threat'] = null;
  let throwAt: { x: number; y: number; err: number } | null = null;
  if (t) {
    const tracked = held(t.p.id) ? m.engaged : null;
    const sharp = sharpnessAgainst(t.p);
    engaged = engage(tracked, t.p, sharp, v.tick, c.rand);
    if (v.tick >= engaged.noticeAtTick) {
      const sigma = aimSigma(engaged, me, sharp, v.tick);
      const err = v.tick === engaged.noticeAtTick ? landingErr(sigma, c.rand) : drift(before.err, sigma, TICK_MS, c.rand);
      const flight = leadSeconds(t.d, gun.bulletSpeed);
      const rx = t.p.x + engaged.vx * flight - me.x, ry = t.p.y + engaged.vy * flight - me.y;
      look = { want: Math.atan2(ry, rx) + err, spin: bearingSpin(rx, ry, engaged.vx - mine.x, engaged.vy - mine.y), hand: handFor(sharp), d: t.d, err };
      wantsFire = t.d < gun.range * 0.95;
      threat = { d: t.d };
      const fuse = GRENADE_FUSE_MS / 1000;
      throwAt = { x: t.p.x + engaged.vx * fuse, y: t.p.y + engaged.vy * fuse, err };
    }
  } else if (s.crates && snap.self.ammo >= snap.self.mag / 2 && !snap.self.reloading) {
    const crate = crateInSight(me, snap.crates, c.arena.walls, gun.range * 0.95, viewExtents(snap.self.viewRadius, DEFAULT_VIEW_ASPECT));
    if (crate) {
      look = { ...look, ...lookAt(crate, me, mine, 0) };
      wantsFire = true;
    }
  }

  const situation: Situation = {
    threat, hurting: v.hpFrac < HURTING_HP_FRAC, underFire: v.underFire,
    onContestedZone: v.zones.some((z) => z.owner !== me.team && dist(z, me) < z.r),
  };
  const wanted = readyAbility !== null && ABILITY_RULES[readyAbility](situation) ? readyAbility : null;
  let keys = drive.keys;
  if (wanted === 'dash' && t) {
    const away = awayFrom(me, t.p, c.arena, RETREAT_STEP);
    keys = keysToward({ ...m, dir: null, stuckTicks: 0, pace: { lastDir: null, lastTurnBackTick: -Infinity } }, me, away, v.tick).keys;
  }
  if (throwAt && GRENADES.has(wanted)) {
    look = { ...look, want: Math.atan2(throwAt.y - me.y, throwAt.x - me.x) + throwAt.err, spin: 0, d: Math.hypot(throwAt.x - me.x, throwAt.y - me.y) };
  }
  const { aim, fire, ability, shots } = aimAndTrigger(before, look, wantsFire, wanted, m.shots);
  const angle = aim.angle, aimDist = Math.max(1, look.d);
  const reload = !fire && snap.self.ammo < snap.self.mag && !snap.self.reloading && (s.reload || (!t && snap.self.ammo < snap.self.mag / 2));
  return {
    input: { ...keys, angle, fire, shots, reload, ability, aimDist, use: false },
    motor: {
      route: way.route, dir: drive.dir, dirSince: drive.dirSince, pace: drive.pace, stance, last: { x: me.x, y: me.y },
      stuckTicks: pressing && moved < 1 && !way.replanned ? m.stuckTicks + 1 : 0, engaged, engagedSeen: t ? v.tick : m.engagedSeen, aim, shots,
    },
  };
}
