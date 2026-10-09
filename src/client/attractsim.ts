import { WORLD } from '../shared/defs.ts';
import { MAPS, type MapId } from '../shared/maps.ts';
import type { Snapshot, Team, WallView } from '../shared/protocol.ts';
import { addPlayer, canRespawn, respawn, step } from '../shared/sim.ts';
import { circleBlocked } from '../shared/sim/movement.ts';
import { snapshotFor, wallViews } from '../shared/sim/snapshot.ts';
import { createWorld, rand, solidRects, type World } from '../shared/sim/world.ts';
import { newBotMemory, randomLoadout, type BotMemory } from '../server/bots.ts';
import { arenaFor } from '../server/bot/arena.ts';
import { isOpen } from '../server/bot/nav.ts';
import { thinkBots } from '../server/bot/tick.ts';

/**
 * The menu's attract mode, the match half: a Team Deathmatch of bots on a real map, run by the real shared sim and the real bot
 * brains (src/server/bot, which is plain TypeScript with no Node in it), plus a director that decides what the camera watches.
 * No DOM here: it runs in a worker (attractworker.ts) so neither the sim nor building a map's nav grid ever stalls the menu, and
 * the same code runs in the tests. Everything is drawn from the world's own seeded random numbers, so one seed is one film.
 *
 * The fight is kept dense for a camera: both teams start a few hundred px either side of the map's middle and come back there
 * when they respawn, and the director follows whoever is in the thick of it (shots, hits and kills, decaying in about a second),
 * holds on a fallen subject for a beat and then follows the one who dropped him. A kill near the subject, now and then, is
 * marked for the page to slow down for (see `ATTRACT.slowGapMs`).
 */
export const ATTRACT = {
  mode: 'TDM',
  /** Ticks run before the first frame, so the camera opens on a fight already moving. */
  preRollMs: 3000,
  /** How far either side of the middle each team stands, in px, and how far up or down. */
  sideMin: 320, sideMax: 680, spreadY: 460,
  /** Heat: what a shot, a hit (given or taken) and a kill add, and how much is left each tick (about a second's half-life). */
  shotHeat: 1, hitHeat: 3, killHeat: 8, keep: 0.977,
  /** The subject is kept at least this long, at most this long, and given up for one this much hotter. */
  minHoldMs: 5000, maxHoldMs: 14_000, hotter: 1.6,
  /** On a fallen subject the camera stays on the spot this long before it follows the killer. */
  wakeMs: 1300,
  /** A kill this close to what the camera watches can be slowed down for, at most once in this long. */
  slowNearPx: 650, slowGapMs: 12_000, slowFirstMs: 7000,
  /** Extra px of world on each side of the subject's view sent in each frame, so a camera easing behind it still has the world. */
  lookPx: 520,
} as const;

export type AttractOpts = { seed: number; map: MapId; bots: number; aspect?: number };
/** What the camera should look at in a frame: a point, and whose (null on a fallen subject's spot). */
export type Focus = { x: number; y: number; id: number | null };
/** A kill to slow down for: its time (sim ms, as `serverMs` reads a snapshot) and where it fell. */
export type Mark = { at: number; x: number; y: number };
export type AttractFrame = { snap: Snapshot; focus: Focus; mark: Mark | null };
export type AttractWorld = { map: MapId; worldSize: number; walls: WallView[] };

const TICK_MS = 1000 / WORLD.tickHz;

export type AttractSim = ReturnType<typeof createAttractSim>;

/** The world a match with these options will be played in (its map and walls), without playing it: for baking its ground ahead. */
export function peekWorld(o: AttractOpts): AttractWorld {
  return { map: o.map, worldSize: MAPS[o.map].size, walls: wallViews(createWorld(ATTRACT.mode, o.seed, o.map)) };
}

export function createAttractSim(o: AttractOpts) {
  const w: World = createWorld(ATTRACT.mode, o.seed, o.map);
  // Ids far above any a real room hands out, so the renderer's per-body memories (reload arms, strides) never mix the two.
  w.nextId = 1_000_000;
  const r = () => rand(w);
  const size = MAPS[o.map].size;
  const nav = arenaFor(w).nav;
  const solids = solidRects(w);
  let aspect = o.aspect ?? 16 / 9;

  /** An open spot on `team`'s side of the middle, found by walking out from a random point there. */
  const sidePoint = (team: Team) => {
    const side = team === 'blue' ? 1 : -1;
    const x0 = size / 2 + side * (ATTRACT.sideMin + r() * (ATTRACT.sideMax - ATTRACT.sideMin));
    const y0 = size / 2 + (r() - 0.5) * 2 * ATTRACT.spreadY;
    const rad = WORLD.playerRadius + 8;
    for (let k = 0; k < 600; k++) {
      const a = r() * Math.PI * 2, d = k * 6;
      const x = x0 + Math.cos(a) * d, y = y0 + Math.sin(a) * d;
      if (x > rad && y > rad && x < size - rad && y < size - rad && !circleBlocked(solids, x, y, rad) && isOpen(nav, { x, y })) return { x, y };
    }
    return undefined;
  };

  const bots = new Map<number, BotMemory>();
  for (let i = 0; i < o.bots; i++) {
    const team: Team = i % 2 ? 'blue' : 'red';
    const p = addPlayer(w, `bot${i}`, randomLoadout(r), { team, at: sidePoint(team) });
    bots.set(p.id, newBotMemory(r));
  }

  const heat = new Map<number, number>();
  let subject: number | null = null;
  let heldSince = 0;
  /** A fallen subject: where he fell, when, and who dropped him. */
  let wake: { x: number; y: number; at: number; killer: number | null } | null = null;
  let lastMark = -Infinity;

  const alive = (id: number | null) => (id === null ? undefined : [...w.players.values()].find((p) => p.id === id && p.life.k === 'alive'));
  const hottest = (except: number | null) => {
    let best: number | null = null, score = -1;
    for (const p of w.players.values()) {
      if (p.life.k !== 'alive' || p.id === except) continue;
      const s = heat.get(p.id) ?? 0;
      if (s > score) { score = s; best = p.id; }
    }
    return best;
  };
  const pick = (id: number | null) => { subject = id; heldSince = w.now; wake = null; };

  /** One tick: bots think, the world steps, the fallen get back up near the fight, and the director looks round. */
  const tick = () => {
    thinkBots(w, bots, r, { respawn: false, watched: true });
    for (const id of bots.keys()) {
      if (!canRespawn(w, id) || !respawn(w, id, randomLoadout(r))) continue;
      const p = w.players.get(id)!;
      const at = sidePoint(p.team);
      if (at) { p.x = at.x; p.y = at.y; }
    }
    step(w, TICK_MS);
    for (const [id, h] of heat) heat.set(id, h * ATTRACT.keep);
    const bump = (id: number | null, by: number) => { if (id !== null) heat.set(id, (heat.get(id) ?? 0) + by); };
    let mark: Mark | null = null;
    for (const e of w.events) {
      if (e.e === 'shot') bump(e.owner, ATTRACT.shotHeat);
      else if (e.e === 'dmg' && e.kind === 'player') { bump(e.attacker, ATTRACT.hitHeat); bump(e.victim, ATTRACT.hitHeat); }
      else if (e.e === 'kill') {
        bump(e.killerId, ATTRACT.killHeat);
        const v = w.players.get(e.victimId);
        if (!v) continue;
        if (e.victimId === subject) wake = { x: v.x, y: v.y, at: w.now, killer: e.killerId };
        const f = focusPoint();
        if (!mark && w.now >= ATTRACT.slowFirstMs && w.now - lastMark >= ATTRACT.slowGapMs && Math.hypot(v.x - f.x, v.y - f.y) <= ATTRACT.slowNearPx) {
          mark = { at: w.tick * TICK_MS, x: v.x, y: v.y };
          lastMark = w.now;
        }
      }
    }
    direct();
    return mark;
  };

  const direct = () => {
    if (wake) {
      if (w.now - wake.at < ATTRACT.wakeMs) return;
      pick(alive(wake.killer) ? wake.killer : hottest(null));
      return;
    }
    const cur = alive(subject);
    if (!cur) { pick(hottest(null)); return; }
    const held = w.now - heldSince;
    if (held < ATTRACT.minHoldMs) return;
    const other = hottest(subject);
    const mine = heat.get(subject!) ?? 0, theirs = other === null ? 0 : heat.get(other) ?? 0;
    if (held >= ATTRACT.maxHoldMs || theirs > mine * ATTRACT.hotter + 3) pick(other ?? subject);
  };

  const focusPoint = (): Focus => {
    if (wake) return { x: wake.x, y: wake.y, id: null };
    const p = subject === null ? undefined : w.players.get(subject);
    return p ? { x: p.x, y: p.y, id: p.id } : { x: size / 2, y: size / 2, id: null };
  };

  /** The frame the page draws: the world as the subject's view (widened) sees it, without what only a HUD reads. */
  const frame = (mark: Mark | null): AttractFrame => {
    const viewer = subject !== null && w.players.has(subject) ? subject : bots.keys().next().value!;
    const look = { l: ATTRACT.lookPx, r: ATTRACT.lookPx, u: ATTRACT.lookPx, d: ATTRACT.lookPx };
    const snap = snapshotFor(w, viewer, w.events, aspect, look);
    snap.minimap = [];
    snap.leaderboard = [];
    snap.self = { ...snap.self, nemesis: null, pending: null };
    delete snap.heard;
    return { snap, focus: focusPoint(), mark };
  };

  for (let t = 0; t < Math.round(ATTRACT.preRollMs / TICK_MS); t++) tick();
  if (subject === null) pick(hottest(null));

  return {
    world: (): AttractWorld => ({ map: o.map, worldSize: size, walls: wallViews(w) }),
    get tick() { return w.tick; },
    /** Steps one tick and returns its frame. */
    step: (): AttractFrame => frame(tick()),
    setAspect(a: number) { if (a > 0 && Number.isFinite(a)) aspect = a; },
  };
}
