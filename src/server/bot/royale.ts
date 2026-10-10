import { LOOT, TOWER } from '../../shared/defs.ts';
import { ringAt, type CacheView, type Circle, type PlayerView, type RingView, type RoyaleView, type Snapshot, type TowerView } from '../../shared/protocol.ts';
import type { BotDecision, BotMemory } from '../bots.ts';
import { skillKnobs, TICK_MS } from './aim.ts';
import { openSpot, type BotArena } from './arena.ts';
import { perceive, type Perception } from './awareness.ts';
import { bandFor, lane, nextIntent, PERSONALITIES, skilledPersona, startIntent, type Intent, type IntentCtx } from './intent.ts';
import { act } from './motor.ts';
import { dist, isOpen, nearestOpenPoint, type Point } from './nav.ts';

/**
 * Last Standing, every player for themselves. A bot plays it as a person would: it keeps inside the safe circle and heads for the next
 * one in time; with nobody to fight it loots, walking from cache to cache (the rarer ones first) inside the next circle, sometimes takes a
 * recon tower or goes for a supply drop; and it fights as it does in versus when an enemy shows, without chasing him across the ring.
 */

const LEAVE_MARGIN_MS = 15_000;
const WALK_DETOUR = 1.4;
const EDGE_PX = 120;
const ANCHOR_EDGE_PX = 400;
const ANCHOR_REACH = 0.6;
const HOME_R = 220;
const DROP_ODDS = 0.5;
const DROP_REACH_PX = 1800;
/** Caches it looks to first: within this of it; past it, it goes for the best one anywhere in the circle. */
const LOOT_REACH_PX = 1400;
/** What a cache of each tier is worth to it against the walk (`lootScore`): an epic one is worth a long walk past commons. */
const TIER_VALUE = [1, 3, 6] as const;
const LOOT_WALK_PAD = 250;
/** Another player this much nearer a cache gets there first: it looks for another. */
const BEATEN_TO_PX = 150;
const TOWER_REACH_PX = 900;
const TOWER_ODDS = 0.5;
/** Where it stands on a tower: well inside its circle, so a step aside does not start the hold over. */
const TOWER_STAND_PX = TOWER.radius * 0.4;
/** A fight that has gone quiet this long is over: it goes back to its errand. */
const QUIET_MS = 3000;
/** The farthest a lone bot goes after an enemy it lost sight of (a flank or a search), so it never chases him across the ring. */
const CHASE_PX = 650;

const inside = (p: Point, c: Circle, margin: number) => dist(p, c) <= Math.max(c.r - margin, c.r / 2);

function goalCircle(ring: RingView, me: Point, speed: number, now: number): { circle: Circle; urgent: boolean } {
  if (now >= ring.shrinkAt) return { circle: ring.to, urgent: true };
  const walkMs = (Math.max(0, dist(me, ring.to) - ring.to.r + EDGE_PX) / speed) * 1000 * WALK_DETOUR;
  return ring.shrinkAt - now < walkMs + LEAVE_MARGIN_MS ? { circle: ring.to, urgent: true } : { circle: ringAt(ring, now), urgent: false };
}

/** Whether bot `id` goes for this drop: about half of them do, the same ones each time for the same drop. */
const goesForDrop = (id: number, phase: number, drop: Point) => lane(id, phase * 31 + Math.floor(drop.x + drop.y)) < DROP_ODDS;
/** Whether bot `id` takes this tower when it passes near it ready: about half of them do. */
export const takesTower = (id: number, tower: Point) => lane(id, 7 + Math.floor(tower.x * 3 + tower.y)) < TOWER_ODDS;

/** Open ground toward the circle's middle from `at`, far enough in to be safe a while (`ANCHOR_EDGE_PX`), as near `at` as that allows. */
function anchorFor(at: Point, circle: Circle, arena: BotArena): Point {
  const d = dist(at, circle);
  const reach = Math.max(circle.r - ANCHOR_EDGE_PX, circle.r * ANCHOR_REACH);
  const k = d > reach ? reach / d : 1;
  for (let f = k; f >= 0; f -= 0.1) {
    const p = { x: circle.x + (at.x - circle.x) * f, y: circle.y + (at.y - circle.y) * f };
    if (p.x > 0 && p.y > 0 && p.x < arena.size && p.y < arena.size && isOpen(arena.nav, p)) return p;
  }
  return circle;
}

const cacheAt = (c: CacheView): Point => ({ x: c[1], y: c[2] });

/** The unopened cache inside the circle most worth the walk, by its tier's value over the way there; one another player is clearly nearer is left to him. */
export function lootTarget(snap: Snapshot, royale: RoyaleView, me: PlayerView, circle: Circle): CacheView | null {
  const others = snap.players.filter((p) => p.id !== me.id && p.alive);
  const open = royale.caches.filter((c) => c[4] === 0 && inside(cacheAt(c), circle, EDGE_PX)
    && !others.some((o) => dist(o, cacheAt(c)) < dist(me, cacheAt(c)) - BEATEN_TO_PX));
  const score = (c: CacheView) => TIER_VALUE[c[3]] / (dist(me, cacheAt(c)) + LOOT_WALK_PAD);
  const best = (cs: readonly CacheView[]) => cs.reduce<CacheView | null>((b, c) => (b && score(b) >= score(c) ? b : c), null);
  return best(open.filter((c) => dist(me, cacheAt(c)) <= LOOT_REACH_PX)) ?? best(open);
}

const ready = (t: TowerView, now: number) => t.readyAt <= now;

/** A ready tower near it, inside the circle and not being taken by someone else, that this bot is one to take. */
export function towerTarget(royale: RoyaleView, me: PlayerView, circle: Circle, now: number): TowerView | null {
  return royale.towers.find((t) => ready(t, now) && (t.holder === undefined || t.holder === me.id) && dist(me, t) <= TOWER_REACH_PX
    && inside(t, circle, EDGE_PX) && takesTower(me.id, t)) ?? null;
}

/** Where it stands to take a tower, and which way it looks while it does: out over the circle, the way people come from. */
function towerPost(t: TowerView, me: PlayerView, circle: Circle, arena: BotArena): { spot: Point; facing: Point } {
  const a = lane(me.id, 3) * Math.PI * 2;
  const near = { x: t.x + Math.cos(a) * TOWER_STAND_PX * 0.5, y: t.y + Math.sin(a) * TOWER_STAND_PX * 0.5 };
  const spot = isOpen(arena.nav, near) ? near : isOpen(arena.nav, t) ? { x: t.x, y: t.y } : nearestOpenPoint(arena.nav, t, TOWER_STAND_PX) ?? { x: t.x, y: t.y };
  const out = dist(t, circle) > 150 ? Math.atan2(circle.y - t.y, circle.x - t.x) : a;
  return { spot, facing: { x: t.x + Math.cos(out) * 600, y: t.y + Math.sin(out) * 600 } };
}

type Errand = { k: 'drop' | 'loot' | 'roam'; at: Point } | { k: 'tower'; at: Point; facing: Point };

function errandFor(snap: Snapshot, royale: RoyaleView, me: PlayerView, circle: Circle, arena: BotArena, now: number): Errand {
  const drop = royale.drops.find((d) => inside(d, circle, 0) && dist(d, me) < DROP_REACH_PX && goesForDrop(me.id, royale.ring.phase, d));
  if (drop) return { k: 'drop', at: { x: drop.x, y: drop.y } };
  const tower = towerTarget(royale, me, circle, now);
  if (tower) { const post = towerPost(tower, me, circle, arena); return { k: 'tower', at: post.spot, facing: post.facing }; }
  const cache = lootTarget(snap, royale, me, circle);
  if (cache) return { k: 'loot', at: cacheAt(cache) };
  return { k: 'roam', at: anchorFor(me, circle, arena) };
}

/** In a fight, or just out of one: an enemy in sight, a round at it, or one it lost sight of moments ago. */
const engaged = (v: Perception) => v.threats.some((t) => t.p.alive) || v.underFire || (v.lastSeen !== null && (v.tick - v.lastSeen.seenTick) * TICK_MS < QUIET_MS);

const goalOf = (i: Intent): Point | null => {
  switch (i.k) {
    case 'patrol': return i.goal;
    case 'resupply': return i.at;
    case 'takePosition': case 'peekAndHide': case 'reloadInCover': case 'retreatAndHeal': case 'hold': return i.spot;
    case 'search': return i.at;
    case 'flank': return i.via;
    case 'engage': return null;
  }
};

/** A plan that takes it out of the circle, or after an enemy farther than a lone player should go. */
const strays = (intent: Intent, circle: Circle, me: Point) => {
  const goal = goalOf(intent);
  if (goal === null) return false;
  return !inside(goal, circle, EDGE_PX) || ((intent.k === 'search' || intent.k === 'flank') && dist(goal, me) > CHASE_PX);
};

export function royaleThink(snap: Snapshot, royale: RoyaleView, me: PlayerView, arena: BotArena, mem: BotMemory, rand: () => number): Omit<BotDecision, 'pick'> {
  const now = snap.tick * TICK_MS;
  const { awareness, view } = perceive(snap, arena, me, mem.awareness);
  const skill = skillKnobs(mem.skill);
  const persona = skilledPersona(PERSONALITIES[mem.persona], skill);
  const { circle, urgent } = goalCircle(royale.ring, me, snap.self.speed, now);
  const current = ringAt(royale.ring, now);
  const outside = !inside(me, circle, EDGE_PX) && (urgent || dist(me, current) > current.r);
  const errand = outside ? { k: 'roam' as const, at: anchorFor(me, circle, arena) } : errandFor(snap, royale, me, circle, arena, now);
  const home = { at: inside(me, circle, EDGE_PX) && errand.k === 'roam' ? { x: me.x, y: me.y } : errand.at, r: HOME_R, face: { x: circle.x, y: circle.y } };
  const ctx: IntentCtx = { tick: snap.tick, persona, role: null, band: bandFor(view.me.gun, persona), arena, rand, home, skill };
  const prev = mem.intent ?? startIntent({ k: 'patrol', goal: errand.at }, ctx);
  const walkTo = (goal: Point, slack: number) => (prev.k === 'patrol' && dist(prev.goal, goal) < slack ? prev : startIntent({ k: 'patrol', goal }, ctx));
  const errandIntent = (): Intent => {
    if (errand.k !== 'tower') return walkTo(errand.at, errand.k === 'roam' ? HOME_R : 30);
    return prev.k === 'takePosition' && dist(prev.spot, errand.at) < 30 ? prev : startIntent({ k: 'takePosition', spot: errand.at, facing: errand.facing }, ctx);
  };
  let intent: Intent;
  if (outside) intent = walkTo(errand.at, 60);
  else if (engaged(view)) {
    intent = nextIntent(prev, view, ctx);
    if (strays(intent, circle, me)) intent = startIntent({ k: 'patrol', goal: openSpot(arena, rand, { at: me, r: HOME_R }) }, ctx);
  } else {
    // Nobody about: a dry gun or a bad wound is seen to first (the versus rules), else it is off on its errand.
    const planned = nextIntent(prev, view, ctx);
    intent = (planned.k === 'reloadInCover' || planned.k === 'retreatAndHeal') && !strays(planned, circle, me) ? planned : errandIntent();
  }
  const { input, motor } = act(intent, view, ctx, mem.motor, snap);
  return { input, mem: { ...mem, intent, awareness, motor } };
}
