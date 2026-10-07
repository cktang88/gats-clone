import { GUNS, type GunId, type WeaponId } from '../../shared/defs.ts';
import { DEFAULT_VIEW_ASPECT, viewExtents, type PlayerView, type SelfView, type Snapshot, type Team, type ZoneView } from '../../shared/protocol.ts';
import type { Rect } from '../../shared/sim/movement.ts';
import { SHARPNESS, TICK_MS } from './aim.ts';
import type { BotArena } from './arena.ts';
import { clearShot, dist, type Point } from './nav.ts';

type Contact = { id: number; x: number; y: number; seenTick: number; gun: GunId };

type Lead = { x: number; y: number; tick: number; hunted: boolean };

export type Awareness = {
  contacts: readonly Contact[];
  heard: readonly Lead[];
  mates: readonly { id: number; x: number; y: number }[];
  hitTick: number;
};

export const freshAwareness = (): Awareness => ({ contacts: [], heard: [], mates: [], hitTick: -Infinity });

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
};

const FORGET_MS = 8000;
const HEARD_MS = 4000;
const UNDER_FIRE_MS = 500;
const SILENCED_HEARING_PX = 350;
const MATE_MARK_PX = 40;

const crateRect = (c: { x: number; y: number; size: number }): Rect => ({ x: c.x, y: c.y, w: c.size, h: c.size });

const danger = (p: PlayerView) => (p.hunted ? SHARPNESS.length : p.kind === 'human' ? p.level : 0);

export function focus(v: Perception, target: number): Threat | undefined {
  const top = v.threats[0];
  const mine = v.threats.find((x) => x.p.id === target);
  return mine && top && danger(mine.p) >= danger(top.p) ? mine : top;
}

export function perceive(snap: Snapshot, arena: BotArena, me: PlayerView, prev: Awareness): { awareness: Awareness; view: Perception } {
  const tick = snap.tick;
  const solids: Rect[] = [...arena.walls, ...snap.crates.map(crateRect)];
  const sight = viewExtents(snap.self.viewRadius, DEFAULT_VIEW_ASPECT);
  const enemy = (p: PlayerView) => p.id !== me.id && (me.team === null || p.team !== me.team);
  const threats = snap.players
    .filter((p) => enemy(p) && p.alive && !p.downed && Math.abs(p.x - me.x) <= sight.halfW && Math.abs(p.y - me.y) <= sight.halfH && clearShot(solids, me, p))
    .map((p) => ({ p, d: dist(p, me) }))
    .sort((a, b) => danger(b.p) - danger(a.p) || a.d - b.d);

  const seen = new Set(threats.map((t) => t.p.id));
  const contacts = [
    ...threats.map(({ p }) => ({ id: p.id, x: p.x, y: p.y, seenTick: tick, gun: p.gun })),
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
  const heardNow: Lead[] = [];
  let hitTick = prev.hitTick;
  for (const e of snap.events) {
    if (e.e === 'shot' && hostile(e.owner, e) && (!e.silenced || dist(e, me) <= SILENCED_HEARING_PX)) heardNow.push({ x: e.x, y: e.y, tick, hunted: false });
    else if (e.e === 'dmg' && e.kind === 'player' && e.victim === me.id) hitTick = tick;
    else if (e.e === 'kill') {
      const mate = prev.mates.find((m) => m.id === e.victimId);
      if (mate) heardNow.push({ x: mate.x, y: mate.y, tick, hunted: false });
    }
  }
  const heard = [...heardNow, ...prev.heard.filter((h) => (tick - h.tick) * TICK_MS < HEARD_MS && !heardNow.some((n) => dist(n, h) < 100))];
  const marks: Lead[] = snap.minimap
    .filter((m) => me.team === null || m.team !== me.team)
    .map((m) => ({ x: m.x, y: m.y, tick, hunted: m.pingAge !== null }));
  const leads = [...marks, ...heard];
  const nearest = (xs: readonly Lead[]) => xs.reduce<Lead | null>((best, l) => (best && dist(best, me) <= dist(l, me) ? best : l), null);
  const lead = nearest(leads.filter((l) => l.hunted)) ?? nearest(leads);

  const lastSeen = live.filter((c) => !seen.has(c.id)).reduce<Contact | null>((best, c) => (best && best.seenTick >= c.seenTick ? best : c), null);
  return {
    awareness: { contacts: live, heard, mates, hitTick },
    view: {
      tick, me, self: snap.self, weapon: GUNS[me.gun].base, hpFrac: me.hp / me.maxHp, team: me.team,
      threats, lastSeen, lead, underFire: (tick - hitTick) * TICK_MS <= UNDER_FIRE_MS, zones: snap.zones, solids, allies: mates,
    },
  };
}

