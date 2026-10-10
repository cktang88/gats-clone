import { GUNS, type GunId } from '../../shared/defs.ts';
import type { ZoneView } from '../../shared/protocol.ts';
import { TICK_MS } from './aim.ts';
import { doorLanes, openSpot, type BotArena } from './arena.ts';
import { aimsAtLead, type Perception, type Threat } from './awareness.ts';
import { coverNear, pickCover } from './cover.ts';
import { between, clearShot, dist, isOpen, nearestOpenPoint, type Point } from './nav.ts';
import type { Supply } from './supplies.ts';
import { fightOdds, holdsAngle, type Tactics } from './tactics.ts';

export const PERSONALITY_IDS = ['aggressive', 'cautious', 'marksman'] as const;
export type PersonalityId = (typeof PERSONALITY_IDS)[number];

export type Personality = {
  rangeMul: number;
  retreatHp: number;
  healedHp: number;
  peekMs: readonly [number, number];
  hideMs: readonly [number, number];
  peekOdds: number;
  flankOdds: number;
  pushOdds: number;
  sidestepOdds: number;
  plantsFromCover: boolean;
  commitMul: number;
  /** How readily it gets out of a long gun's line of fire (see `dangerTo` in evade.ts), and how long its dodge legs run. */
  evasion: number;
  dodgeMs: readonly [number, number];
  /** Scales how long it takes to take in an enemy that comes into its sight (`noticeMs` in aim.ts): a hothead is quickest on the draw. */
  reactMul: number;
  /**
   * The worst odds (`fightOdds`) it takes a fight on: below them it breaks the enemy's line and holds an angle on him from cover (`hold`)
   * instead, and a fight it is in that sinks `ODDS_SLACK` below them it leaves. A hothead takes worse fights than a careful one.
   */
  takesOdds: number;
};

export const PERSONALITIES: Record<PersonalityId, Personality> = {
  aggressive: { rangeMul: 0.8, retreatHp: 0.1, healedHp: 0.35, peekMs: [1000, 1800], hideMs: [250, 500], peekOdds: 0.2, flankOdds: 0.5, pushOdds: 1, sidestepOdds: 0.8, plantsFromCover: false, commitMul: 0.8, evasion: 0.8, dodgeMs: [500, 1300], reactMul: 0.8, takesOdds: -0.45 },
  cautious: { rangeMul: 1, retreatHp: 0.2, healedHp: 0.45, peekMs: [700, 1200], hideMs: [500, 900], peekOdds: 0.4, flankOdds: 0.2, pushOdds: 0.85, sidestepOdds: 0.5, plantsFromCover: false, commitMul: 1.2, evasion: 1, dodgeMs: [700, 2000], reactMul: 0.95, takesOdds: -0.05 },
  marksman: { rangeMul: 1.15, retreatHp: 0.15, healedHp: 0.4, peekMs: [900, 1500], hideMs: [400, 800], peekOdds: 0.5, flankOdds: 0.1, pushOdds: 0.7, sidestepOdds: 0.2, plantsFromCover: true, commitMul: 1.3, evasion: 0.65, dodgeMs: [600, 1500], reactMul: 0.85, takesOdds: -0.2 },
};

/**
 * How far from an enemy a gun wants to fight, by what the gun is for (src/shared/roles.ts): `max` is the farthest it will let a fight sit before it
 * closes in, `ideal` where it settles (and where a rusher stops closing), `headOn` the nearest it is comfortable being found. Rushers close to
 * `ideal` and never back off; every other gun backs off from half its `ideal`. Guns whose rounds fade (`falloff`) fight inside the fade; a plant-to-aim
 * gun fights from the far side of it.
 */
type Reach = readonly [headOn: number, ideal: number, max: number, rushes?: 'rush'];
export const GUN_BAND: Record<GunId, Reach> = {
  pistol: [150, 320, 430], handCannon: [200, 380, 520], machinePistol: [60, 200, 330, 'rush'], executioner: [260, 520, 720], gunslinger: [90, 230, 380, 'rush'], akimbo: [40, 150, 280, 'rush'], hailstorm: [200, 380, 520],
  smg: [60, 180, 280, 'rush'], skirmisher: [40, 160, 260, 'rush'], heavySmg: [90, 220, 360], phantom: [50, 160, 260, 'rush'], hornet: [30, 110, 200, 'rush'], ripper: [140, 300, 460], bulldog: [100, 240, 380],
  shotgun: [0, 130, 220, 'rush'], slugGun: [220, 420, 620], doubleBarrel: [0, 110, 200, 'rush'], railSlug: [300, 560, 780], boomSlug: [200, 380, 560], sawedOff: [0, 70, 140, 'rush'], streetSweeper: [0, 130, 230, 'rush'],
  assault: [220, 380, 480], battleRifle: [260, 460, 680], carbine: [160, 330, 500], marksman: [320, 580, 760], grenadier: [200, 360, 520], specter: [160, 330, 500], scout: [300, 560, 780],
  sniper: [420, 650, 840], longshot: [450, 700, 910], semiAuto: [350, 560, 760], piercer: [500, 760, 1020], artillery: [420, 700, 980], repeater: [260, 480, 700], ghost: [330, 560, 780],
  lmg: [200, 380, 520], heavyLmg: [240, 430, 600], lightMg: [150, 300, 420], minigun: [180, 360, 520], juggernaut: [240, 430, 620], ranger: [140, 300, 440], twinMg: [140, 280, 400],
};

/** `hold` is the closest a gun that is not a rusher lets an enemy come before its bot backs off to fight from the band again. */
type Band = { headOn: number; ideal: number; max: number; hold: number; rushes: boolean };
const HOLD_OF_IDEAL = 0.5;
export const bandFor = (gun: GunId, p: Personality): Band => {
  const [headOn, ideal, max, rush] = GUN_BAND[gun];
  const rushes = rush === 'rush';
  const k = p.rangeMul;
  return { headOn: headOn * k, ideal: ideal * k, max: max * k, hold: rushes ? 0 : Math.max(headOn, ideal * HOLD_OF_IDEAL) * k, rushes };
};

/** A number in [0, 1) that is the same for one bot every time, so a squad fans out the same way each time without spending the random stream. */
export const lane = (id: number, salt = 0): number => {
  const v = Math.sin((id + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

type Role = 'anchor' | 'rotate';
export const roleFor = (id: number, team: string | null): Role | null => (team === null ? null : id % 3 === 0 ? 'anchor' : 'rotate');

export type Plan =
  | { k: 'patrol'; goal: Point }
  | { k: 'takePosition'; spot: Point; facing: Point }
  | { k: 'engage'; target: number }
  /** `phaseSince` when the phase began; `waits` how many times it put off a peek into an angle the enemy holds (see `advancePeekPhase`). */
  | { k: 'peekAndHide'; target: number; spot: Point; peek: Point; phase: 'hide' | 'peek'; phaseUntil: number; phaseSince?: number; waits?: number }
  /** A fight not worth taking: hidden from him at `spot`, it holds the angle he would come from (`watch`) until `until`, firing first if he shows. */
  | { k: 'hold'; target: number; spot: Point; watch: Point; until: number }
  | { k: 'reloadInCover'; spot: Point; threat: Point }
  | { k: 'retreatAndHeal'; spot: Point | null; threat: Point }
  /** `committed`: sent at him after holding an angle he never walked into, so it takes the fight it finds (no holding off again). */
  | { k: 'flank'; target: number; via: Point; lastKnown: Point; committed?: boolean }
  | { k: 'search'; at: Point; giveUpAt: number; committed?: boolean }
  /** Off to a pack on the floor (walking over it takes it) or a cabinet (`open`: it walks to `at`, against a face, and it opens as the bot comes in reach), with nobody to fight. */
  | { k: 'resupply'; at: Point; id: number; open: boolean };

export type Intent = Plan & { since: number; holdUntil: number };
type IntentKind = Plan['k'];
type Of<K extends IntentKind> = Extract<Intent, { k: K }>;

/**
 * `strategic` is false on a think that only reacts (see `nextIntent`); `lastPlan` is the tick of this bot's last strategic think, so a rule
 * that weighs its odds once a tick, or waits for one exact tick, still does over the ticks since then.
 */
export type IntentCtx = {
  tick: number; persona: Personality; role: Role | null; band: Band; arena: BotArena; rand: () => number; home?: { at: Point; r: number; face: Point }; strategic?: boolean; lastPlan?: number;
  /** The pack or cabinet it needs and could fetch (supplies.ts), if any. */
  supply?: Supply | null;
  /** Its read of the fight (tactics.ts): sightings and where it pre-aims; absent in a test or a mode that gives it none. */
  tac?: Tactics;
};

/** The ticks since this bot last planned (1 when it plans every tick). */
const sincePlan = (c: IntentCtx) => Math.max(1, Math.min(60, c.tick - (c.lastPlan ?? c.tick - 1)));
/** Odds `p` a tick, over every tick since the last plan. */
const overTicks = (p: number, c: IntentCtx) => 1 - (1 - p) ** sincePlan(c);
/** Whether tick `at` came round since the last plan. */
const cameRound = (at: number, c: IntentCtx) => c.tick - sincePlan(c) < at && at <= c.tick;

const MIN_COMMIT_MS: Record<IntentKind, number> = {
  patrol: 0, takePosition: 7000, engage: 1200, peekAndHide: 2500, reloadInCover: 0, retreatAndHeal: 3000, flank: 3500, search: 2500, resupply: 0, hold: 1200,
};
/** How long a bot holds an angle on an enemy it would rather not fight before it moves on him another way (see `hold`). */
const HOLD_MS: readonly [number, number] = [2500, 4500];
/** A fight in hand sinking this far below its `takesOdds` is one it leaves; one this far above them it commits to (no peeking, it pushes). */
const ODDS_SLACK = 0.3;
const COMMIT_ODDS = 0.6;
/** Under these odds a fight is not clearly its own: it pokes it from cover (seen coming, it takes cover first), `POKE_MORE` likelier than its temper's `peekOdds`. */
const POKE_ODDS = 0.3;
/** A bot poking from cover leaves it to push only on odds this good (he is caught reloading, nearly dead, or outnumbered). */
const PUSH_FROM_COVER_ODDS = 0.9;
const POKE_MORE = 0.3;
const HUNTED_ODDS = 1;
/** A peek into an angle the enemy holds is put off this long, at most `PEEK_WAITS` times, before it goes round another way. */
const PEEK_WAIT_MS: readonly [number, number] = [500, 900];
const PEEK_WAITS = 2;
/** Shot at this long into a peek, it ducks back (a poke is a burst and back before he answers, not a stand). */
const POKE_ANSWERED_MS = 250;
/** Being hit, it breaks off a fight only for cover this near; further, it fights on. */
const UNDER_FIRE_COVER_PX = 140;
const SEARCH_MS = 5000;
const GUNFIRE_PULL_PX = 2500;
const FLANK_MS = 8000;
const STALEMATE_MS = 6000;
const ARRIVED_PX = 60;
const COVER_REACH_PX = 320;
const RETREAT_REACH_PX = 600;
const CORNERED_PX = 220;
const FLEE_FROM_PX = CORNERED_PX + 60;
const OPEN_ESCAPE_PX = 500;
const OUTNUMBERED_BY = 2;
const OUTNUMBERED_HP = 0.5;
/** Mates this near count as backing a bot up when it weighs the odds. */
const BACKUP_PX = 450;
/** Where a squad spreads its errand goals: within this of the spot, fanned by lane to either side of the way in. */
const SPREAD_PX = 180;
const SPREAD_ARC = Math.PI * 0.9;
const ZONE_RING = 0.6;
/** Cover a mate already holds, or is next to, is not taken by a second bot: it picks one this far from every mate. */
const MATE_COVER_PX = 120;
const LOW_AMMO = 0.25;

const ticks = (ms: number) => Math.round(ms / TICK_MS);
const pos = (t: Threat): Point => ({ x: t.p.x, y: t.p.y });

const LOST_GRACE_MS = 500;
export const justLost = (v: Perception) => v.lastSeen !== null && (v.tick - v.lastSeen.seenTick) * TICK_MS < LOST_GRACE_MS;

export function startIntent(plan: Plan, c: IntentCtx): Intent {
  return { ...plan, since: c.tick, holdUntil: c.tick + ticks(MIN_COMMIT_MS[plan.k] * c.persona.commitMul) };
}

function hideFrom(v: Perception, c: IntentCtx, threat: Point): Point | null {
  const threats = v.threats.length ? v.threats.map(pos) : [threat];
  return pickCover(c.arena.cover, c.arena.nav, v.solids, v.me, threats, { reach: RETREAT_REACH_PX, range: 0, peek: false, taken: v.allies })?.spot ?? null;
}

/** A fight near a door is held from beside it: no cover in the door's lane, at either side of it. */
const DOOR_WATCH_PX = 500;

/** `from` is every enemy the cover must hide it from (`t`, the one it peeks at, first); by default only `t`. */
function peekPlan(v: Perception, c: IntentCtx, t: Threat, from: readonly Point[] = [pos(t)]): Plan | null {
  const taken = [...v.allies, ...doorLanes(c.arena, pos(t), DOOR_WATCH_PX)];
  const pick = pickCover(c.arena.cover, c.arena.nav, v.solids, v.me, from, { reach: COVER_REACH_PX, range: c.band.ideal, peek: true, taken, takenPx: MATE_COVER_PX });
  if (!pick?.peek) return null;
  const travel = dist(v.me, pick.spot) / v.self.speed * 1000;
  return { k: 'peekAndHide', target: t.p.id, spot: pick.spot, peek: pick.peek, phase: 'hide', phaseUntil: c.tick + ticks(travel + between(c.persona.hideMs, c.rand)) };
}

/** This bot's odds on `t` (see `fightOdds`), or null with no read of the fight (a test or a mode that gives it no tactics). */
const oddsOn = (v: Perception, c: IntentCtx, t: Threat): number | null => (c.tac ? fightOdds(v, t, c.tac.seen) : null);

/**
 * A fight not worth taking: cover that hides it from every enemy it sees (and a lane to shoot from when he comes), holding the angle he
 * would come from. A person breaks line and makes the other man walk into his pre-aim rather than trade on even or worse terms. Null with no such cover.
 */
function holdPlan(v: Perception, c: IntentCtx, t: Threat): Plan | null {
  const from = [pos(t), ...v.threats.filter((x) => x !== t).map(pos)];
  const taken = [...v.allies, ...doorLanes(c.arena, pos(t), DOOR_WATCH_PX)];
  // Under his fire, cover a long walk off is a walk in the open with its back to him: it only goes for cover a step or two away.
  const reach = v.underFire ? UNDER_FIRE_COVER_PX : COVER_REACH_PX;
  const pick = pickCover(c.arena.cover, c.arena.nav, v.solids, v.me, from, { reach, range: c.band.ideal, peek: false, taken, takenPx: MATE_COVER_PX });
  if (!pick) return null;
  return { k: 'hold', target: t.p.id, spot: pick.spot, watch: pos(t), until: c.tick + ticks(between(HOLD_MS, c.rand)) };
}

/** Whether a fight with `t` is one to leave or not take: its odds under `takesOdds` (less `slack`), and him not on top of it (where running is worse). */
const badFight = (v: Perception, c: IntentCtx, t: Threat, slack = 0) => {
  const odds = oddsOn(v, c, t);
  // A hunted enemy (a stage-2 gun, marked on every minimap) is the room's quarry: it is fought on worse odds, the whole room being on him.
  return odds !== null && odds < c.persona.takesOdds - slack - (t.p.hunted ? HUNTED_ODDS : 0) && t.d > CORNERED_PX;
};

/** The side of an enemy to flank round: +1 or -1 for the one holding fewer of this bot's mates, or null when they are even or there are none. */
function emptierSide(v: Perception, at: Point): 1 | -1 | null {
  const ux = v.me.x - at.x, uy = v.me.y - at.y;
  const lean = v.allies.reduce((sum, m) => (dist(m, v.me) < BACKUP_PX * 2 ? sum + Math.sign(ux * (m.y - at.y) - uy * (m.x - at.x)) : sum), 0);
  return lean === 0 ? null : lean > 0 ? -1 : 1;
}

/** A goal a squad shares (where gunfire was, where a foe was lost) is a ring each bot takes its own bit of, so they do not arrive in one file. */
function spreadGoal(v: Perception, c: IntentCtx, at: Point): Point {
  if (v.team === null || dist(v.me, at) < SPREAD_PX * 2) return at;
  const a = Math.atan2(v.me.y - at.y, v.me.x - at.x) + (lane(v.me.id) - 0.5) * SPREAD_ARC;
  const r = Math.min(SPREAD_PX, c.band.ideal * 0.6);
  const p = { x: at.x + Math.cos(a) * r, y: at.y + Math.sin(a) * r };
  return isOpen(c.arena.nav, p) ? p : nearestOpenPoint(c.arena.nav, p, 200) ?? at;
}

function flankPlan(v: Perception, c: IntentCtx, target: number, at: Point): Plan {
  const from = Math.atan2(v.me.y - at.y, v.me.x - at.x);
  const side = emptierSide(v, at) ?? (c.rand() < 0.5 ? 1 : -1);
  const a = from + side * (Math.PI / 2);
  const via = openSpot(c.arena, c.rand, { at: { x: at.x + Math.cos(a) * c.band.ideal, y: at.y + Math.sin(a) * c.band.ideal }, r: 120 });
  return { k: 'flank', target, via, lastKnown: at };
}

const searchPlan = (v: Perception, c: IntentCtx, lead: Point): Plan => {
  // A sound is placed roughly (and a last sighting may be against a wall): it heads for open ground there, a point it can walk to, never into a wall.
  const spread = spreadGoal(v, c, lead);
  const at = isOpen(c.arena.nav, spread) ? { x: spread.x, y: spread.y } : nearestOpenPoint(c.arena.nav, spread, 200) ?? { x: spread.x, y: spread.y };
  return { k: 'search', at, giveUpAt: c.tick + ticks(SEARCH_MS + (dist(v.me, at) / v.self.speed) * 1000) };
};

function zoneToHold(v: Perception, c: IntentCtx): ZoneView | null {
  const owned = v.zones.filter((z) => z.owner === v.team), open = v.zones.filter((z) => z.owner !== v.team);
  const pool = c.role === 'anchor' ? (owned.length ? owned : v.zones) : open.length ? open : owned;
  return pool.reduce<ZoneView | null>((best, z) => (best && dist(best, v.me) <= dist(z, v.me) ? best : z), null);
}

function idlePlan(v: Perception, c: IntentCtx): Plan {
  if (c.home) {
    const spots = coverNear(c.arena.cover, c.home.at, c.home.r);
    return spots.length ? { k: 'takePosition', spot: spots[Math.floor(c.rand() * spots.length)]!, facing: c.home.face } : { k: 'patrol', goal: openSpot(c.arena, c.rand, c.home) };
  }
  const centre = { x: c.arena.size / 2, y: c.arena.size / 2 };
  const zone = zoneToHold(v, c);
  // Each bot holds its own stretch of the zone's ring (DOM pressure is spread round the point, not piled on it).
  if (zone) {
    const a = lane(v.me.id, 1) * Math.PI * 2, r = zone.r * ZONE_RING;
    return { k: 'takePosition', spot: openSpot(c.arena, c.rand, { at: { x: zone.x + Math.cos(a) * r, y: zone.y + Math.sin(a) * r }, r: 50 }), facing: centre };
  }
  if (v.lead && c.role !== 'anchor') return searchPlan(v, c, v.lead);
  if (c.role === 'anchor' || (v.weapon === 'sniper' && c.persona.rangeMul > 1)) {
    const free = (ps: readonly Point[]) => { const apart = ps.filter((q) => v.allies.every((m) => dist(m, q) >= MATE_COVER_PX)); return apart.length ? apart : ps; };
    const spots = free(coverNear(c.arena.cover, openSpot(c.arena, c.rand, { at: centre, r: c.arena.size / 4 }), 300));
    const spot = spots.length ? spots[Math.floor(c.rand() * spots.length)]! : openSpot(c.arena, c.rand, { at: centre, r: c.arena.size / 4 });
    return { k: 'takePosition', spot, facing: v.lead && aimsAtLead(v.lead, v.me) ? v.lead : centre };
  }
  return { k: 'patrol', goal: openSpot(c.arena, c.rand, c.rand() < 0.5 ? { at: centre, r: c.arena.size / 3 } : undefined) };
}

function lostSight(v: Perception, c: IntentCtx, target: number): Plan {
  const last = v.lastSeen;
  if (!last) return idlePlan(v, c);
  // He was last seen planted with this way pre-aimed: walking round his corner is walking into his crosshair. It goes round another way,
  // or holds the angle on him from cover until he moves.
  const held = holdsAngle(c.tac?.seen.find((s) => s.id === last.id), v.me, v.tick);
  if (c.rand() < c.persona.flankOdds || (held && c.rand() < 0.5)) return flankPlan(v, c, target, last);
  if (held) {
    const spot = pickCover(c.arena.cover, c.arena.nav, v.solids, v.me, [last], { reach: COVER_REACH_PX, range: c.band.ideal, peek: false, taken: v.allies, takenPx: MATE_COVER_PX })?.spot ?? v.me;
    return { k: 'hold', target, spot, watch: last, until: c.tick + ticks(between(HOLD_MS, c.rand)) };
  }
  if (c.rand() < c.persona.pushOdds) return searchPlan(v, c, last);
  const taken = [...v.allies, ...doorLanes(c.arena, last, DOOR_WATCH_PX)];
  const spot = pickCover(c.arena.cover, c.arena.nav, v.solids, v.me, [last], { reach: COVER_REACH_PX, range: c.band.ideal, peek: false, taken, takenPx: MATE_COVER_PX })?.spot ?? v.me;
  return { k: 'takePosition', spot, facing: last };
}

const losing = (v: Perception, p: Personality) => {
  const lone = v.threats.length === 1 ? v.threats[0]!.p : null;
  const finishableLone = lone !== null && lone.hp / lone.maxHp < v.hpFrac;
  const backup = v.allies.filter((m) => dist(m, v.me) < BACKUP_PX).length;
  const outnumbered = v.threats.length >= backup + OUTNUMBERED_BY;
  return !finishableLone && (v.threats.length > 0 || v.underFire) && (v.hpFrac < p.retreatHp || (outnumbered && v.hpFrac < OUTNUMBERED_HP));
};

type Interrupt = (cur: Intent, v: Perception, c: IntentCtx) => Plan | null;

const fleeLosingFight: Interrupt = (cur, v, c) => {
  const near = v.threats[0];
  if (cur.k === 'retreatAndHeal' || !losing(v, c.persona) || (near && near.d < FLEE_FROM_PX)) return null;
  const threat = near ? pos(near) : v.lastSeen ?? v.me;
  const spot = hideFrom(v, c, threat);
  if (!spot && near && near.d < OPEN_ESCAPE_PX) return null;
  return { k: 'retreatAndHeal', spot, threat };
};

const turnOnPursuerOrRehide: Interrupt = (cur, v, c) => {
  const near = v.threats[0];
  if (cur.k !== 'retreatAndHeal' || !near) return null;
  if (near.d < CORNERED_PX) return { k: 'engage', target: near.p.id };
  if (!cur.spot || dist(v.me, cur.spot) > ARRIVED_PX) return null;
  const spot = hideFrom(v, c, pos(near));
  return spot && dist(spot, cur.spot) > ARRIVED_PX ? { k: 'retreatAndHeal', spot, threat: pos(near) } : null;
};

const reloadWhenDry: Interrupt = (cur, v, c) => {
  if (cur.k === 'reloadInCover' || cur.k === 'retreatAndHeal' || v.self.reloading || v.self.ammo > v.self.mag * LOW_AMMO) return null;
  const near = v.threats[0];
  const recent = v.lastSeen !== null && v.tick - v.lastSeen.seenTick < ticks(3000) ? v.lastSeen : null;
  const threat = near ? pos(near) : recent;
  if (!threat || (near && near.d < CORNERED_PX && v.self.ammo > 0)) return null;
  const spot = hideFrom(v, c, threat);
  return spot ? { k: 'reloadInCover', spot, threat } : null;
};

/** The cover spot an intent holds or makes for, if it has one. */
const coverSpot = (cur: Intent): Point | null =>
  cur.k === 'peekAndHide' || cur.k === 'reloadInCover' || cur.k === 'hold' ? cur.spot : cur.k === 'retreatAndHeal' ? cur.spot : null;

/**
 * Cover that no longer covers: an enemy it can see has a clear line into the spot it hides at (he came round the wall, or a second one
 * holds the other side). A person does not sit on in the open there: it takes cover that hides it from everyone it can see now (or at
 * least from the one in its face), a rusher in reach pushes him instead, and with nowhere to go it fights him from where it stands,
 * strafing (`engage`) rather than standing still on its old spot. A peek that he sees is a peek, not blown cover: only the hiding spot counts.
 */
const coverBlown: Interrupt = (cur, v, c) => {
  const spot = coverSpot(cur);
  if (!spot) return null;
  const open = v.threats.filter((t) => clearShot(v.solids, spot, t.p));
  const t = open[0];
  if (!t) return null;
  const all = v.threats.map(pos);
  if (cur.k === 'reloadInCover' || cur.k === 'retreatAndHeal') {
    const hide = hideFrom(v, c, pos(t));
    if (hide && dist(hide, spot) > ARRIVED_PX) return { ...cur, spot: hide, threat: pos(t) };
    // Nowhere to hide from him: a gun with rounds left fights; a dry one, or one fleeing, keeps backing off from him.
    return cur.k === 'reloadInCover' && v.self.ammo > 0 ? { k: 'engage', target: t.p.id } : { k: 'retreatAndHeal', spot: null, threat: pos(t) };
  }
  if (cur.k === 'hold') {
    // Seen where it meant to hold an angle from: a fight worth taking it takes; else other cover from all of them, or it fights from here.
    const hold = badFight(v, c, t) ? holdPlan(v, c, t) : null;
    return hold && hold.k === 'hold' && dist(hold.spot, spot) > ARRIVED_PX ? hold : { k: 'engage', target: t.p.id };
  }
  if (c.band.rushes && t.d < c.band.max) return { k: 'engage', target: t.p.id };
  const next = peekPlan(v, c, t, all) ?? (all.length > 1 ? peekPlan(v, c, t) : null);
  return next && next.k === 'peekAndHide' && dist(next.spot, spot) > ARRIVED_PX ? next : { k: 'engage', target: t.p.id };
};

const engageOnSight: Interrupt = (cur, v, c) => {
  const calm = cur.k === 'patrol' || cur.k === 'takePosition' || cur.k === 'search' || cur.k === 'flank' || cur.k === 'resupply';
  const t = v.threats[0];
  if (!calm || !t) return null;
  // Holding a zone, it lets a far enemy walk by; not one shooting at it.
  if (cur.k === 'takePosition' && v.zones.length > 0 && t.d > 400 && !v.underFire && v.shotAt?.owner !== t.p.id) return null;
  // A fight it would lose (outgunned, hurt, or one of two on it): it breaks his line and holds the angle instead of walking into it.
  const committed = (cur.k === 'flank' || cur.k === 'search') && cur.committed;
  if (!committed && badFight(v, c, t)) {
    const hold = holdPlan(v, c, t);
    if (hold) return hold;
  }
  // An even fight seen coming, out of his fire: it takes cover with a lane on him and pokes from it, rather than meet him in the open.
  const odds = oddsOn(v, c, t);
  if (!committed && odds !== null && odds < POKE_ODDS && !c.band.rushes && !v.underFire && t.d >= c.band.headOn) {
    const poke = peekPlan(v, c, t, v.threats.map(pos));
    if (poke) return poke;
  }
  return { k: 'engage', target: t.p.id };
};

const investigateGunfire: Interrupt = (cur, v, c) => {
  const idle = cur.k === 'patrol' || (cur.k === 'takePosition' && v.zones.length === 0);
  if (!idle || c.role === 'anchor' || !v.lead || v.lead.tick !== v.tick || dist(v.lead, v.me) > GUNFIRE_PULL_PX) return null;
  if (cur.k === 'takePosition' && dist(v.lead, cur.facing) < GUNFIRE_PULL_PX / 3) return null;
  return searchPlan(v, c, v.lead);
};

/**
 * Nobody to fight and short of health or rounds: it goes for the pack or cabinet it needs (supplies.ts), from a patrol, a post, a search, or a
 * retreat nobody is chasing. An enemy in sight takes it straight back to the fight (`engageOnSight` counts a supply run as calm).
 */
const fetchSupplies: Interrupt = (cur, v, c) => {
  const s = c.supply;
  if (!s || v.threats.length > 0 || v.underFire) return null;
  const free = cur.k === 'patrol' || cur.k === 'takePosition' || cur.k === 'search' || (cur.k === 'retreatAndHeal' && cur.spot === null);
  return free ? { k: 'resupply', at: s.at, id: s.id, open: s.open } : null;
};

/**
 * A fight that has turned (a second enemy coming up on it, its health gone, his mate arriving): it breaks off to cover that hides it from
 * all of them before the newcomer gets on it, rather than fight one with another in its side. One nearly dead it finishes (see `fightOdds`).
 */
const leaveTurnedFight: Interrupt = (cur, v, c) => {
  if (cur.k !== 'engage' && cur.k !== 'peekAndHide') return null;
  const t = v.threats.find((x) => x.p.id === cur.target) ?? v.threats[0];
  if (!t || !badFight(v, c, t, ODDS_SLACK)) return null;
  return holdPlan(v, c, t);
};

/**
 * He stands past its gun's reach: poking at him from cover is no use, it goes in (`engage` closes to its band). A bot sees that far down
 * its aim (the look-ahead, as a person does), so two could otherwise peek at each other from out of reach and never fire.
 */
const outOfReach = (v: Perception, t: Threat) => t.d > GUNS[v.me.gun].range;

const INTERRUPTS: readonly Interrupt[] = [fleeLosingFight, turnOnPursuerOrRehide, reloadWhenDry, coverBlown, leaveTurnedFight, engageOnSight, fetchSupplies, investigateGunfire];

const RULES: { [K in IntentKind]: (cur: Of<K>, v: Perception, c: IntentCtx) => Plan | null } = {
  patrol: (cur, v, c) => {
    const next = idlePlan(v, c);
    return next.k !== 'patrol' || dist(v.me, cur.goal) < ARRIVED_PX ? next : null;
  },
  takePosition: (_cur, v, c) => idlePlan(v, c),
  engage: (cur, v, c) => {
    const t = v.threats[0];
    if (!t) return justLost(v) ? null : lostSight(v, c, cur.target);
    // Outranged by a long gun that is hitting it: it does not trade in his lane but breaks his sight behind cover and works in from there.
    if (!c.band.rushes && v.underFire && t.d > c.band.max && GUN_BAND[t.p.gun][1] > c.band.max) {
      const hide = peekPlan(v, c, t);
      if (hide) return hide;
    }
    // A fight well in hand (he is hurt, reloading, outnumbered) is pressed, not peeked.
    const odds = oddsOn(v, c, t);
    if (odds !== null && odds > COMMIT_ODDS) return null;
    // A fight not clearly in hand is poked from cover more readily than one going its way.
    const peekOdds = c.persona.peekOdds + (odds !== null && odds < POKE_ODDS ? POKE_MORE : 0);
    if (c.band.rushes || t.d < c.band.headOn * 0.7 || outOfReach(v, t) || c.rand() >= overTicks(peekOdds, c)) return null;
    return peekPlan(v, c, t);
  },
  peekAndHide: (cur, v, c) => {
    const t = v.threats.find((x) => x.p.id === cur.target) ?? v.threats[0];
    if (t && (t.d < c.band.headOn * 0.7 || (outOfReach(v, t) && !v.underFire))) return { k: 'engage', target: t.p.id };
    // He is caught out (reloading, hurt, alone against it and a mate): the poking stops and it pushes him.
    const odds = t ? oddsOn(v, c, t) : null;
    if (t && odds !== null && odds > PUSH_FROM_COVER_ODDS) return { k: 'engage', target: t.p.id };
    // A mate got to this cover first: it takes another bit of the wall rather than standing on his shoulder.
    const crowded = v.allies.some((m) => dist(m, cur.spot) < MATE_COVER_PX * 0.75 && dist(m, cur.spot) < dist(v.me, cur.spot));
    if (crowded && t) return peekPlan(v, c, t);
    const at = t ? pos(t) : v.lastSeen;
    if (at && cameRound(cur.since + ticks(STALEMATE_MS), c) && c.rand() < c.persona.flankOdds) return flankPlan(v, c, cur.target, at);
    if (t || (v.lastSeen && v.tick - v.lastSeen.seenTick < ticks(2500))) return null;
    return lostSight(v, c, cur.target);
  },
  reloadInCover: (_cur, v, c) => {
    if (v.self.reloading || v.self.ammo < v.self.mag * 0.9) return null;
    const t = v.threats[0];
    return t ? { k: 'engage', target: t.p.id } : v.lastSeen ? searchPlan(v, c, v.lastSeen) : idlePlan(v, c);
  },
  retreatAndHeal: (cur, v, c) => {
    if (v.hpFrac >= c.persona.healedHp) return v.lastSeen && c.rand() < c.persona.pushOdds ? searchPlan(v, c, v.lastSeen) : idlePlan(v, c);
    if (!v.underFire) return null;
    const threat = v.threats[0] ? pos(v.threats[0]) : cur.threat;
    return { k: 'retreatAndHeal', spot: hideFrom(v, c, threat), threat };
  },
  flank: (cur, v, c) => {
    if (v.tick - cur.since > ticks(FLANK_MS) || dist(v.me, cur.via) < ARRIVED_PX) return { ...searchPlan(v, c, cur.lastKnown), ...(cur.committed && { committed: true }) };
    return null;
  },
  hold: (cur, v, c) => {
    const t = v.threats.find((x) => x.p.id === cur.target) ?? v.threats[0];
    if (t) {
      // He walked into its angle, or the odds came round (he is reloading, hurt, its mates are up): it takes the fight now.
      const odds = oddsOn(v, c, t);
      if (odds === null || odds >= c.persona.takesOdds || t.d < CORNERED_PX) return { k: 'engage', target: t.p.id };
      return v.tick > cur.until ? holdPlan(v, c, t) ?? { k: 'engage', target: t.p.id } : null;
    }
    if (v.tick <= cur.until) return null;
    // He did not come: it goes to him another way (he holds the way it came), or, a hothead, looks for him.
    const last = v.lastSeen;
    return last && last.id === cur.target ? { ...(c.rand() < 0.5 + c.persona.flankOdds ? flankPlan(v, c, cur.target, last) : searchPlan(v, c, last)), committed: true } : idlePlan(v, c);
  },
  resupply: (cur, v, c) => {
    const s = c.supply;
    // Taken, gone, or no longer needed: back to its business. A cabinet it opened becomes the pack to walk over.
    if (!s) return idlePlan(v, c);
    return s.id !== cur.id || s.open !== cur.open || dist(s.at, cur.at) > 1 ? { k: 'resupply', at: s.at, id: s.id, open: s.open } : null;
  },
  search: (cur, v, c) => {
    // Fresh news since it last planned (heard on a quick think in between counts too), not only news on this very tick.
    if (v.lead && dist(v.lead, cur.at) > 300 && cameRound(v.lead.tick, c)) return searchPlan(v, c, v.lead);
    return dist(v.me, cur.at) < ARRIVED_PX * 1.5 || v.tick > cur.giveUpAt ? idlePlan(v, c) : null;
  },
};

function advancePeekPhase(cur: Intent, v: Perception, c: IntentCtx): Intent {
  if (cur.k !== 'peekAndHide') return cur;
  const since = cur.phaseSince ?? cur.since;
  const seen = c.tac?.seen.find((s) => s.id === cur.target);
  // A poke is a burst and back: shot at a moment into the peek, it ducks before his answer lands.
  const answered = cur.phase === 'peek' && v.underFire && (v.tick - since) * TICK_MS >= POKE_ANSWERED_MS;
  // He was last seen reloading: the hide is cut short to catch him at it.
  const caught = cur.phase === 'hide' && seen?.reloadEnd !== null && seen?.reloadEnd !== undefined && seen.reloadEnd > v.tick + ticks(300) && (v.tick - since) * TICK_MS >= 200;
  if (!answered && !caught && v.tick < cur.phaseUntil) return cur;
  const unansweredPeek = !answered && cur.phase === 'peek' && !v.underFire && v.threats.some((t) => t.p.id === cur.target);
  if (unansweredPeek) return cur;
  // He holds the angle it would peek into (planted, aimed at its peek): it waits him out a little, then goes round another way.
  if (cur.phase === 'hide' && !caught && holdsAngle(seen, cur.peek, v.tick)) {
    const waits = cur.waits ?? 0;
    if (waits >= PEEK_WAITS && seen) return startIntent(flankPlan(v, c, cur.target, seen), c);
    return { ...cur, waits: waits + 1, phaseUntil: v.tick + ticks(between(PEEK_WAIT_MS, c.rand)) };
  }
  const phase = cur.phase === 'hide' ? 'peek' : 'hide';
  const ms = between(phase === 'peek' ? c.persona.peekMs : c.persona.hideMs, c.rand);
  return { ...cur, phase, phaseUntil: v.tick + ticks(ms), phaseSince: v.tick };
}

/**
 * The intent for this think. The interrupts (a losing fight, an empty gun, an enemy in sight, gunfire) are reactions and run on
 * every think; the rules that move a settled intent on to the next (arrived, lost him, healed, waited long enough) are the bot's plan,
 * and run only on a strategic think (`c.strategic`, a couple of times a second), as a person re-plans rather than re-decides every frame.
 */
export function nextIntent(cur: Intent, v: Perception, c: IntentCtx): Intent {
  for (const rule of INTERRUPTS) {
    const plan = rule(cur, v, c);
    if (plan) return startIntent(plan, c);
  }
  if (c.tick < cur.holdUntil || c.strategic === false) return advancePeekPhase(cur, v, c);
  const plan = (RULES[cur.k] as (cur: Intent, v: Perception, c: IntentCtx) => Plan | null)(cur, v, c);
  return plan ? startIntent(plan, c) : advancePeekPhase(cur, v, c);
}
