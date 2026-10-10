import { COLOR_IDS, ZOM } from '../../shared/defs.ts';
import { ringAt, type Circle, type InputState, type PlayerView, type RingView, type RoyaleView, type Snapshot } from '../../shared/protocol.ts';
import type { BotDecision, BotMemory } from '../bots.ts';
import { skillKnobs, TICK_MS } from './aim.ts';
import { openSpot, type BotArena } from './arena.ts';
import { perceive } from './awareness.ts';
import { bandFor, nextIntent, PERSONALITIES, skilledPersona, startIntent, type Intent, type IntentCtx } from './intent.ts';
import { act } from './motor.ts';
import { dist, isOpen, type Point } from './nav.ts';

const LEAVE_MARGIN_MS = 15_000;
const WALK_DETOUR = 1.4;
const EDGE_PX = 120;
const ANCHOR_EDGE_PX = 400;
const ANCHOR_REACH = 0.6;
const HOME_R = 220;
const REVIVE_REACH_PX = 900;
const REVIVE_STOP_PX = ZOM.reviveRange - 20;
const MATE_DEAD_ZONE = 30;
const DROP_ODDS = 0.5;
const DROP_REACH_PX = 1800;

const inside = (p: Point, c: Circle, margin: number) => dist(p, c) <= Math.max(c.r - margin, c.r / 2);

function goalCircle(ring: RingView, me: Point, speed: number, now: number): { circle: Circle; urgent: boolean } {
  if (now >= ring.shrinkAt) return { circle: ring.to, urgent: true };
  const walkMs = (Math.max(0, dist(me, ring.to) - ring.to.r + EDGE_PX) / speed) * 1000 * WALK_DETOUR;
  return ring.shrinkAt - now < walkMs + LEAVE_MARGIN_MS ? { circle: ring.to, urgent: true } : { circle: ringAt(ring, now), urgent: false };
}

const goesForDrop = (squad: number, phase: number, drop: Point) => ((squad * 7 + phase * 3 + Math.floor(drop.x + drop.y)) % 10) / 10 < DROP_ODDS;

function anchorFor(snap: Snapshot, royale: RoyaleView, me: PlayerView, circle: Circle, arena: BotArena): Point {
  const team = me.team!;
  const mates = [me, ...snap.minimap.filter((m) => m.team === team && m.pingAge === null)];
  const at = { x: mates.reduce((s, m) => s + m.x, 0) / mates.length, y: mates.reduce((s, m) => s + m.y, 0) / mates.length };
  const squad = COLOR_IDS.indexOf(team);
  const drop = royale.drops.find((d) => inside(d, circle, 0) && dist(d, at) < DROP_REACH_PX && goesForDrop(squad, royale.ring.phase, d));
  if (drop) return drop;
  const d = dist(at, circle);
  const reach = Math.max(circle.r - ANCHOR_EDGE_PX, circle.r * ANCHOR_REACH);
  const k = d > reach ? reach / d : 1;
  for (let f = k; f >= 0; f -= 0.1) {
    const p = { x: circle.x + (at.x - circle.x) * f, y: circle.y + (at.y - circle.y) * f };
    if (p.x > 0 && p.y > 0 && p.x < arena.size && p.y < arena.size && isOpen(arena.nav, p)) return p;
  }
  return circle;
}

const goalOf = (i: Intent): Point | null => {
  switch (i.k) {
    case 'patrol': return i.goal;
    case 'resupply': return i.at;
    case 'takePosition': case 'peekAndHide': case 'reloadInCover': case 'retreatAndHeal': case 'hold': return i.spot;
    case 'search': case 'flank': case 'engage': return null;
  }
};

const leavesSquadCover = (intent: Intent, circle: Circle, home: Point) => {
  const goal = goalOf(intent);
  return intent.k === 'search' || intent.k === 'flank' || (goal !== null && (!inside(goal, circle, EDGE_PX) || dist(goal, home) > HOME_R));
};

const nearestOf = (me: Point, xs: readonly PlayerView[]) => xs.reduce<PlayerView | null>((b, p) => (b && dist(b, me) <= dist(p, me) ? b : p), null);

export function crawlThink(snap: Snapshot, royale: RoyaleView, me: PlayerView, mem: BotMemory): Omit<BotDecision, 'pick'> {
  const mate = nearestOf(me, snap.players.filter((p) => p.id !== me.id && p.team === me.team && p.alive));
  const to = mate ?? ringAt(royale.ring, snap.tick * TICK_MS);
  const near = dist(me, to) < REVIVE_STOP_PX;
  const input: InputState = {
    up: !near && to.y < me.y - MATE_DEAD_ZONE, down: !near && to.y > me.y + MATE_DEAD_ZONE, left: !near && to.x < me.x - MATE_DEAD_ZONE, right: !near && to.x > me.x + MATE_DEAD_ZONE,
    angle: me.angle, fire: false, shots: mem.motor.shots, reload: false, ability: false, aimDist: 0, use: false,
  };
  return { input, mem };
}

export function royaleThink(snap: Snapshot, royale: RoyaleView, me: PlayerView, arena: BotArena, mem: BotMemory, rand: () => number): Omit<BotDecision, 'pick'> {
  const now = snap.tick * TICK_MS;
  const { awareness, view } = perceive(snap, arena, me, mem.awareness);
  const skill = skillKnobs(mem.skill);
  const persona = skilledPersona(PERSONALITIES[mem.persona], skill);
  const { circle, urgent } = goalCircle(royale.ring, me, snap.self.speed, now);
  const home = { at: anchorFor(snap, royale, me, circle, arena), r: HOME_R, face: { x: circle.x, y: circle.y } };
  const ctx: IntentCtx = { tick: snap.tick, persona, role: null, band: bandFor(view.me.gun, persona), arena, rand, home, skill };
  const current = ringAt(royale.ring, now);
  const outside = !inside(me, circle, EDGE_PX) && (urgent || dist(me, current) > current.r);
  const fighting = view.threats.some((t) => t.p.alive);
  const downed = nearestOf(me, snap.players.filter((p) => p.id !== me.id && p.team === me.team && p.downed && dist(p, me) < REVIVE_REACH_PX));
  const prev = mem.intent ?? startIntent({ k: 'patrol', goal: home.at }, ctx);
  const walkTo = (goal: Point, slack: number) => (prev.k === 'patrol' && dist(prev.goal, goal) < slack ? prev : startIntent({ k: 'patrol', goal }, ctx));
  let intent: Intent;
  if (outside) intent = walkTo(home.at, 60);
  else if (downed && !fighting) intent = walkTo(downed, 30);
  else {
    intent = nextIntent(prev, view, ctx);
    if (leavesSquadCover(intent, circle, home.at)) intent = startIntent({ k: 'patrol', goal: openSpot(arena, rand, home) }, ctx);
  }
  const { input, motor } = act(intent, view, ctx, mem.motor, snap);
  const reviving = !outside && !fighting && downed !== null && dist(me, downed) <= REVIVE_STOP_PX;
  return {
    input: reviving ? { ...input, up: false, down: false, left: false, right: false, use: true } : input,
    mem: { ...mem, intent, awareness, motor },
  };
}
