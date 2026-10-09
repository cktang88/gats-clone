import { GUN_IDS, GUNS, rulesOf, WORLD, ZOMBIE_KINDS, ZOMBIES, type GunId } from '../shared/defs.ts';
import type { BulletView, GameEvent, Snapshot, WallView } from '../shared/protocol.ts';
import { segmentEntersCapsuleAt, segmentEntersRectAt, type Rect } from '../shared/sim/movement.ts';
import { flightSec, flownAfter, speedAt, spreadPick } from '../shared/sim/ballistics.ts';
import { MAX_RANGE_MUL } from '../shared/sim/stats.ts';

type Point = { x: number; y: number };
/** A body a round stops at: a circle of radius `r`, or with `up` an upright capsule from (x, y) to (x, y - up), as a range target stands. */
export type Body = { x: number; y: number; r: number; up?: number; id?: number };
/** Seconds of flight a tracer's tail spans; long enough that slower rounds still trail a readable streak. */
export const TRACER = { tail: 0.045 } as const;
/** What stops a round as drawn: cover, and the bodies of the shooter's enemies, zombies and range targets where the page draws them. */
export type RoundScene = { solids: readonly Rect[]; bodies: readonly Body[] };
export type ShotEvent = Extract<GameEvent, { e: 'shot' }>;
/** `n` is the shot's number (`Player.fired`), which picks its spread as the server picks it; without one the page guesses. */
export type Shot = { owner: number; gun: GunId; range: number; spread: number; n?: number };
/**
 * A gun round as the page draws it, spawned from the shot event. (x, y) is where the server's round starts (`MUZZLE_PX` out of the
 * body, which is `lead` px short of the drawn muzzle), so at every age it is where the server's is; it is drawn only from the drawn
 * muzzle on (`shown` px along). `reach` is how far it flies before it stops, `met` how far along the bodies drawn so far have been
 * checked (`meetBodies`), and `pierce` how many more bodies it passes through. The server's copy of a human's round starts a round
 * trip plus the render delay down its line, because lag compensation flies it through the past they saw.
 */
export type LocalRound = { id: number; owner: number; x: number; y: number; vx: number; vy: number; reach: number; gun: GunId; born: number; shown?: number; met?: number; pierce?: number; passed?: readonly number[];
  /** The aim it left along, where in the spread it flies (0..1) and its range, so `respread` can widen or narrow it once the spread is known. */
  aim?: { angle: number; pick: number; range: number };
};

export function roundScene(snap: Pick<Snapshot, 'players' | 'crates' | 'zombies'>, walls: readonly Rect[], shooterId: number, targets: readonly Body[] = []): RoundScene {
  const team = snap.players.find((p) => p.id === shooterId)?.team ?? null;
  return {
    solids: [...walls.filter((w) => !w.nb), ...snap.crates.map((c) => ({ x: c.x, y: c.y, w: c.size, h: c.size }))],
    bodies: [
      ...snap.players.filter((p) => p.alive && p.id !== shooterId && (team === null || p.team !== team)).map((p) => ({ x: p.x, y: p.y, r: WORLD.playerRadius, id: p.id })),
      ...(snap.zombies ?? []).map(([id, k, x, y]) => ({ x, y, r: ZOMBIES[ZOMBIE_KINDS[k]!].radius, id })),
      ...targets,
    ],
  };
}

const bodyAt = (from: Point, dx: number, dy: number, b: Body): number | null => segmentEntersCapsuleAt(from.x, from.y, dx, dy, b.x, b.y, b.up ?? 0, b.r);

/** How far along (dx, dy), as a fraction, a round stops at cover. */
function wallAt(from: Point, dx: number, dy: number, scene: RoundScene): number {
  return Math.min(1, ...scene.solids.map((r) => segmentEntersRectAt(from.x, from.y, dx, dy, r) ?? 1));
}

/**
 * The rounds of one shot, drawn from the muzzle drawn at `muzzle`, `lead` px out past where the server's round starts. Each flies
 * the line the server's does: `shot.n` picks its spread as the server picks it (`spreadPick`). It stops at cover now; the bodies it
 * meets are met as they are drawn while it flies (`meetBodies`), as the server meets them in the past the shooter saw.
 */
export function fireRounds(shot: Shot, muzzle: Point, angle: number, scene: RoundScene, born: number, firstId: number,
  rand: (pellet: number) => number = shot.n === undefined ? Math.random : (i) => spreadPick(shot.owner, shot.n!, i), lead = 0): LocalRound[] {
  const { pellets, bulletSpeed, penetrate = 0 } = GUNS[shot.gun];
  const start = { x: muzzle.x - Math.cos(angle) * lead, y: muzzle.y - Math.sin(angle) * lead };
  return Array.from({ length: pellets }, (_, i) => {
    const pick = rand(i);
    const round: LocalRound = { id: firstId - i, owner: shot.owner, x: start.x, y: start.y, vx: 0, vy: 0, reach: 0, gun: shot.gun, born, shown: lead, met: 0, pierce: penetrate, aim: { angle, pick, range: shot.range } };
    return respread(round, shot.spread, scene.solids);
  });
}

/**
 * The round flying where its pick puts it in a spread of `spread`, stopping at the first of `solids` on that line. The page draws
 * your shot the moment you fire, a moment before the input that fires it settles the spread the server fires it with, then
 * respreads it to that: a few ms into its flight, so the line moves by a hair.
 */
export function respread(r: LocalRound, spread: number, solids: readonly Rect[]): LocalRound {
  if (!r.aim) return r;
  const { bulletSpeed } = GUNS[r.gun];
  const a = r.aim.angle + (r.aim.pick - 0.5) * spread * 2;
  const vx = Math.cos(a) * bulletSpeed, vy = Math.sin(a) * bulletSpeed;
  const reach = wallAt(r, (vx / bulletSpeed) * r.aim.range, (vy / bulletSpeed) * r.aim.range, { solids, bodies: [] }) * r.aim.range;
  // On its new line it meets the bodies afresh.
  return { ...r, vx, vy, reach, met: 0, passed: [], pierce: GUNS[r.gun].penetrate ?? 0 };
}

const flown = (r: LocalRound, now: number) => flownAfter(Math.hypot(r.vx, r.vy), Math.max(0, now - r.born) / 1000, 0, rulesOf(GUNS[r.gun]).muzzleBoost);

/**
 * Stops each round at the first body it meets as the page draws the bodies this frame (`bodiesOf` its owner: their enemies, zombies
 * and range targets), past the ones it pierces. The server judges a round of a given age against the world the shooter saw that much
 * later than the shot, which is what the page draws as the round flies, so the drawn round stops where the server's does.
 */
export function meetBodies(rounds: readonly LocalRound[], bodiesOf: (owner: number) => readonly Body[], now: number): LocalRound[] {
  const scenes = new Map<number, readonly Body[]>();
  return rounds.map((r) => {
    const from = r.met ?? 0, to = Math.min(flown(r, now), r.reach);
    if (to <= from) return r;
    const speed = Math.hypot(r.vx, r.vy), ux = r.vx / speed, uy = r.vy / speed;
    let bodies = scenes.get(r.owner);
    if (!bodies) scenes.set(r.owner, (bodies = bodiesOf(r.owner)));
    const at = { x: r.x + ux * from, y: r.y + uy * from }, len = to - from;
    const passed = r.passed ?? [];
    const hits = bodies.filter((b) => b.id === undefined || !passed.includes(b.id)).flatMap((b) => { const t = bodyAt(at, ux * len, uy * len, b); return t === null ? [] : [{ t, id: b.id }]; }).sort((a, b) => a.t - b.t);
    const pierce = r.pierce ?? 0;
    if (hits.length > pierce) return { ...r, met: to, reach: from + hits[pierce]!.t * len, pierce: 0 };
    return { ...r, met: to, pierce: pierce - hits.length, passed: [...passed, ...hits.flatMap((h) => (h.id === undefined ? [] : [h.id]))] };
  });
}

export const roundLive = (r: LocalRound, now: number): boolean => flown(r, now) <= r.reach;

const LONGEST_FLIGHT_MS = 1000 * Math.max(...GUN_IDS.map((g) => flightSec(GUNS[g].bulletSpeed, GUNS[g].range * MAX_RANGE_MUL, rulesOf(GUNS[g]).muzzleBoost)));

/** Who fired a shot whose event this page received recently enough that its rounds may still be flying, by the server time of each one's last shot. */
export function recentShooters(lastShotAt: ReadonlyMap<number, number>, renderMs: number): Set<number> {
  return new Set([...lastShotAt].filter(([, at]) => at >= renderMs - LONGEST_FLIGHT_MS).map(([id]) => id));
}

/**
 * Which of the server's gun rounds the page draws locally instead: those from shooters whose shot events it received.
 * Each round is judged the first frame it is seen, so none pops in or out mid-flight.
 */
export function coverServerRounds(prev: ReadonlyMap<number, boolean>, bullets: readonly BulletView[], shooters: ReadonlySet<number>): Map<number, boolean> {
  return new Map(bullets.filter((b) => b.gun !== null).map((b) => [b.id, prev.get(b.id) ?? shooters.has(b.owner)]));
}

/** The rounds to draw: the server's that are not covered, plus the local ones, their tails never reaching back past the muzzle. */
export function drawnRounds(bullets: readonly BulletView[], local: readonly LocalRound[], covered: ReadonlyMap<number, boolean>, now: number): BulletView[] {
  const views = local.filter((r) => roundLive(r, now) && (r.shown ?? 0) <= r.reach).map((r) => {
    const shown = r.shown ?? 0, d = Math.max(shown, flown(r, now)), speed = Math.hypot(r.vx, r.vy);
    // The tail streaks as far as the round flies in `TRACER.tail` at its current speed, so a fresh round's tail reaches back to the muzzle.
    const fast = speedAt(speed, d, rulesOf(GUNS[r.gun]).muzzleBoost) / speed;
    const k = Math.min(speed * fast * TRACER.tail, d - shown) / (speed * TRACER.tail);
    return { id: r.id, x: r.x + (r.vx / speed) * d, y: r.y + (r.vy / speed) * d, vx: r.vx * k, vy: r.vy * k, owner: r.owner, gun: r.gun };
  });
  return [...bullets.filter((b) => !covered.get(b.id)), ...views];
}
