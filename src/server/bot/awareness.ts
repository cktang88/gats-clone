import { GUNS, WORLD, type GunId, type WeaponId } from '../../shared/defs.ts';
import { DEFAULT_VIEW_ASPECT, viewExtents, type PlayerView, type SelfView, type Snapshot, type Team, type ZoneView } from '../../shared/protocol.ts';
import type { Rect } from '../../shared/sim/movement.ts';
import { SHARPNESS, TICK_MS } from './aim.ts';
import type { BotArena } from './arena.ts';
import { FLASH } from '../../shared/sim/abilities.ts';
import { sightBlocked, type Smoke } from '../../shared/sim/vision.ts';
import { BOT_HEARING } from '../../shared/sim/hearing.ts';
import { clearShot, dist, type Point } from './nav.ts';

type Contact = { id: number; x: number; y: number; seenTick: number; gun: GunId };

type Lead = { x: number; y: number; tick: number; hunted: boolean };

/** The last enemy round fired this bot's way from where it was heard (it may be out of sight): where from, by whom, with what. */
export type ShotAt = { x: number; y: number; tick: number; owner: number; gun: GunId };

export type Awareness = {
  contacts: readonly Contact[];
  heard: readonly Lead[];
  mates: readonly { id: number; x: number; y: number }[];
  hitTick: number;
  /** Flashbangs this bot has had in sight, and when each first came into view, so it can "notice" one after a reaction delay. */
  nades?: readonly { id: number; tick: number }[];
  shotAt?: ShotAt | null;
  /** Who last hit it, and when: the one it turns on first (see `shooters`). */
  hitBy?: { owner: number; tick: number } | null;
};

export const freshAwareness = (): Awareness => ({ contacts: [], heard: [], mates: [], hitTick: -Infinity, nades: [] });

export type Threat = { p: PlayerView; d: number };

export type Perception = {
  tick: number;
  me: PlayerView;
  self: SelfView;
  weapon: WeaponId;
  hpFrac: number;
  team: Team;
  threats: readonly Threat[];
  lastSeen: Contact | null;
  lead: Lead | null;
  underFire: boolean;
  zones: readonly ZoneView[];
  solids: readonly Rect[];
  allies: readonly Point[];
  /** How flashed the bot is, from the same server flash state a human's screen shows (0 clear, 1 whiteout). */
  flash: number;
  /** Smoke clouds in sight, as `snap.thrown` shows them. */
  smokes: readonly Smoke[];
  /** A flashbang it has noticed in the air and has a line to, which it should look away from. */
  incomingFlash: Point | null;
  /** An enemy round fired at this bot lately (`SHOT_AT_MS`), seen or not: the line it should get off. */
  shotAt?: ShotAt | null;
  /** Enemies in sight that hit it or fired its way lately (`SHOOTER_MS`): the ones it answers first, ahead of the one it was fighting. */
  shooters?: readonly number[];
};

/** At this much flash a bot sees nothing at all: no new sightings, no minimap, no ears. Below it vision is back but its aim is still ruined. */
export const BLIND_AT = 0.2;
const NOTICE_ODDS = 0.6;
const NOTICE_MS = 250;

/** Whether this bot spots this throw at all: hashed from the grenade and the bot, so it leaves the random stream alone. A thrower always knows. */
const noticesThrow = (id: number, me: number) => {
  const v = Math.sin(id * 12.9898 + me * 78.233) * 43758.5453;
  return v - Math.floor(v) < NOTICE_ODDS;
};

const FORGET_MS = 8000;
const HEARD_MS = 4000;
/** A heard shot this close to one remembered is the same fight: the fresh one replaces it (heard places are blurred, so not exact). */
const HEARD_SAME_PX = 200;
const UNDER_FIRE_MS = 500;
/** Rounds cracking past count as being under fire, as they would for a person: an LMG burst or a sniper's near miss, not a lone pistol round. */
const SUPPRESSED_UNDER_FIRE = 0.25;
const MATE_MARK_PX = 40;
const SHOT_AT_MS = 1500;
/** A round counts as fired at this bot when its heading passes within this many body widths of him. */
const SHOT_AT_BODIES = 3;
/** An enemy that hit it or fired its way this lately is shooting at it: it turns on him first. */
const SHOOTER_MS = 1500;

const crateRect = (c: { x: number; y: number; size: number }): Rect => ({ x: c.x, y: c.y, w: c.size, h: c.size });

const danger = (p: PlayerView) => (p.hunted ? SHARPNESS.length : p.kind === 'human' ? p.level : 0);

/**
 * The enemy to fight: the one it is fighting while it can see him, unless one more dangerous is in sight, or another is shooting at it and
 * he is not (a flanker opening up on it is answered, not left to shoot it in the side while it duels the first).
 */
export function focus(v: Perception, target: number): Threat | undefined {
  const top = v.threats[0];
  const mine = v.threats.find((x) => x.p.id === target);
  const shoots = (t: Threat) => v.shooters?.includes(t.p.id) ?? false;
  if (!mine || !top || mine === top) return top;
  return danger(mine.p) >= danger(top.p) && !(shoots(top) && !shoots(mine)) ? mine : top;
}

export function perceive(snap: Snapshot, arena: BotArena, me: PlayerView, prev: Awareness): { awareness: Awareness; view: Perception } {
  const tick = snap.tick;
  const solids: Rect[] = [...arena.sightWalls, ...snap.crates.map(crateRect)];
  const sight = viewExtents(snap.self.viewRadius, DEFAULT_VIEW_ASPECT);
  const enemy = (p: PlayerView) => p.id !== me.id && (me.team === null || p.team !== me.team);
  const inSight = (p: PlayerView) => enemy(p) && !p.spawnShield && Math.abs(p.x - me.x) <= sight.halfW && Math.abs(p.y - me.y) <= sight.halfH && clearShot(solids, me, p);
  // A flashed bot is blind: whatever the snapshot holds, it takes in no new sighting. Only stale memory (`prev.contacts`) is left.
  const flash = snap.self.flash ?? 0;
  const blind = flash > BLIND_AT;
  const standing = blind ? [] : snap.players.filter((p) => p.alive && inSight(p));
  const visible = (standing.length || !snap.royale || blind ? standing : snap.players.filter((p) => p.downed && inSight(p))).map((p) => ({ p, d: dist(p, me) }))
    .sort((a, b) => danger(b.p) - danger(a.p) || a.d - b.d);

  const seen = new Set(visible.map((t) => t.p.id));
  const contacts = [
    ...visible.map(({ p }) => ({ id: p.id, x: p.x, y: p.y, seenTick: tick, gun: p.gun })),
    ...prev.contacts.filter((c) => !seen.has(c.id) && (tick - c.seenTick) * TICK_MS < FORGET_MS),
  ];
  const killed = new Set(snap.events.flatMap((e) => (e.e === 'kill' ? [e.victimId] : [])));
  const live = contacts.filter((c) => !killed.has(c.id));

  const mates = snap.players.filter((p) => p.id !== me.id && me.team !== null && p.team === me.team && p.alive).map((p) => ({ id: p.id, x: p.x, y: p.y }));
  const mateMarks = snap.minimap.filter((m) => me.team !== null && m.team === me.team);
  const teamOf = new Map<number, Team>([...snap.leaderboard.map((r) => [r.id, r.team] as const), ...snap.players.map((p) => [p.id, p.team] as const)]);
  const hostile = (owner: number, at: Point) => {
    if (owner === me.id) return false;
    if (me.team === null) return true;
    const team = teamOf.get(owner);
    return team !== undefined ? team !== me.team : !mateMarks.some((m) => dist(m, at) < MATE_MARK_PX);
  };
  // Gunfire is heard, not seen: a rough place (`snap.heard`, blurred by distance) within a bot's earshot (`BOT_HEARING`, wider than a person's), never a minimap dot. A flashed bot is deaf.
  const heardNow: Lead[] = blind ? [] : (snap.heard ?? []).map((h) => ({ x: h.x, y: h.y, tick, hunted: false }));
  let hitTick = prev.hitTick;
  let hitBy = prev.hitBy && (tick - prev.hitBy.tick) * TICK_MS < SHOOTER_MS ? prev.hitBy : null;
  let shotAt = prev.shotAt && (tick - prev.shotAt.tick) * TICK_MS < SHOT_AT_MS ? prev.shotAt : null;
  for (const e of snap.events) {
    // Rounds fired its way: it hears where they came from, exactly enough to read the line to get off (where to search is the rough `heardNow` above).
    if (e.e === 'shot' && !blind && hostile(e.owner, e) && (!e.silenced || dist(e, me) <= BOT_HEARING.silencedPx)) {
      const d = dist(e, me);
      const off = Math.atan2(me.y - e.y, me.x - e.x) - e.angle;
      if (d <= GUNS[e.gun].range && Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) < Math.atan2(WORLD.playerRadius * SHOT_AT_BODIES, d)) shotAt = { x: e.x, y: e.y, tick, owner: e.owner, gun: e.gun };
    }
    else if (e.e === 'dmg' && e.kind === 'player' && e.victim === me.id) {
      hitTick = tick;
      if (e.attacker !== null && e.attacker !== me.id) hitBy = { owner: e.attacker, tick };
    }
    else if (e.e === 'kill') {
      const mate = prev.mates.find((m) => m.id === e.victimId);
      if (mate) heardNow.push({ x: mate.x, y: mate.y, tick, hunted: false });
    }
  }
  // Those shooting at it come first, then the most dangerous, then the nearest.
  const shooting = new Set([hitBy?.owner, shotAt && (tick - shotAt.tick) * TICK_MS < SHOOTER_MS ? shotAt.owner : undefined].filter((x): x is number => x !== undefined));
  const shoots = (p: PlayerView) => (shooting.has(p.id) ? 1 : 0);
  const threats = shooting.size ? [...visible].sort((a, b) => shoots(b.p) - shoots(a.p)) : visible;
  const shooters = threats.filter((t) => shooting.has(t.p.id)).map((t) => t.p.id);
  const heard = [...heardNow, ...prev.heard.filter((h) => (tick - h.tick) * TICK_MS < HEARD_MS && !heardNow.some((n) => dist(n, h) < HEARD_SAME_PX))];
  const marks: Lead[] = blind ? [] : snap.minimap
    .filter((m) => me.team === null || m.team !== me.team)
    .map((m) => ({ x: m.x, y: m.y, tick, hunted: m.pingAge !== null }));
  const leads = [...marks, ...heard];
  const nearest = (xs: readonly Lead[]) => xs.reduce<Lead | null>((best, l) => (best && dist(best, me) <= dist(l, me) ? best : l), null);
  const lead = nearest(leads.filter((l) => l.hunted)) ?? nearest(leads);

  const flashes = snap.thrown.filter((t) => t.kind === 'flashbang' && dist(t, me) <= FLASH.radius + 120 && clearShot(solids, me, t));
  const nades = flashes.map((t) => ({ id: t.id, tick: prev.nades?.find((n) => n.id === t.id)?.tick ?? tick }));
  const noticed = flashes.find((t) => (t.owner === me.id || noticesThrow(t.id, me.id)) && (tick - (nades.find((n) => n.id === t.id)?.tick ?? tick)) * TICK_MS >= (t.owner === me.id ? 0 : NOTICE_MS));
  const lastSeen = live.filter((c) => !seen.has(c.id)).reduce<Contact | null>((best, c) => (best && best.seenTick >= c.seenTick ? best : c), null);
  return {
    awareness: { contacts: live, heard, mates, hitTick, nades, shotAt, hitBy },
    view: {
      tick, me, self: snap.self, weapon: GUNS[me.gun].base, hpFrac: me.hp / me.maxHp, team: me.team,
      threats, lastSeen, lead, underFire: (tick - hitTick) * TICK_MS <= UNDER_FIRE_MS || snap.self.suppression >= SUPPRESSED_UNDER_FIRE, zones: snap.zones, solids, allies: mates,
      flash, incomingFlash: noticed ? { x: noticed.x, y: noticed.y } : null, shotAt, ...(shooters.length && { shooters }),
      smokes: snap.thrown.filter((t) => t.kind === 'smokeCloud').map((t) => ({ x: t.x, y: t.y, r: t.r })),
    },
  };
}

