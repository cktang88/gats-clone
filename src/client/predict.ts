import { BARREL, ZOM } from '../shared/defs.ts';
import type { InputState, Snapshot, WallView } from '../shared/protocol.ts';
import { cellRect, coreRectAt } from '../shared/sim/build.ts';
import { propViewRect } from '../shared/sim/propview.ts';
import { knifeLunge, moveStep, startDash, type Motion, type Rect } from '../shared/sim/movement.ts';
import { sprintWanted } from '../shared/sim/stats.ts';
import { leavesFromViews } from '../shared/sim/doors.ts';
import type { MapDoor } from '../shared/geom.ts';
import { MAPS, type MapId } from '../shared/maps.ts';
import { lerp } from './interp.ts';

type Point = { x: number; y: number };
export type PredictedAbility = { k: 'dash' } | { k: 'knife'; enemies: readonly Point[] };
/** `dashing`: a dash was running as the input was taken (the motion before it), which the trigger needs (fire.ts). */
export type PendingInput = { seq: number; input: InputState; dtMs: number; ability: PredictedAbility | null; dashing?: boolean };

export type Prediction = {
  pending: PendingInput[];
  afterNewest: Motion | null;
  beforeNewest: Point | null;
  sampledAt: number;
  smoothingCorrection: Point;
};

export const NO_PREDICTION: Prediction = {
  pending: [], afterNewest: null, beforeNewest: null, sampledAt: 0, smoothingCorrection: { x: 0, y: 0 },
};

/** Walking and sprinting speed; a plain number is a speed with no sprint. */
export type Pace = number | { walk: number; sprint: number };
const paceFor = (pace: Pace, input: InputState): number => (typeof pace === 'number' ? pace : sprintWanted(input) ? pace.sprint : pace.walk);

const MAX_PENDING = 90;
export const SNAP_DIST = 150;
const SMOOTH_MS = 60;

/** The doors of the map in play, which the snapshot's door state opens and shuts. */
export const doorsOf = (s: { mapId?: MapId }): readonly MapDoor[] | undefined => (s.mapId ? MAPS[s.mapId]?.doors : undefined);

/** What stops the local player, as the server's solidRects: cover, and in a zombies run the squad's walls and the core. */
export const solidsOf = (walls: readonly WallView[], snap: Pick<Snapshot, 'crates' | 'buildings' | 'run' | 'props' | 'doors' | 'barrels'> | null, doors?: readonly MapDoor[]): Rect[] => [
  ...walls,
  // Door leaves, rebuilt from the map's doors and the snapshot's door state exactly as the server holds them.
  ...leavesFromViews(doors, snap?.doors),
  ...(snap?.crates ?? []).map((c) => ({ x: c.x, y: c.y, w: c.size, h: c.size })),
  ...(snap?.props ?? []).flatMap((q) => propViewRect(q) ?? []),
  // A standing barrel (lit or not) stops a body, as `barrelRect`.
  ...(snap?.barrels ?? []).map(([, x, y]) => ({ x: x - BARREL.size / 2, y: y - BARREL.size / 2, w: BARREL.size, h: BARREL.size })),
  // A spike strip lies on the floor and is walked over.
  ...(snap?.buildings ?? []).filter((b) => b.kind !== 'spikes').map((b) => cellRect(b.cx, b.cy)),
  ...(snap?.run ? [coreRectAt(snap.run.core)] : []),
];

/** Where the server has the local player and how fast they move: a downed player crawls, and a dead one has no position to predict from. */
export function selfMotion(snap: Snapshot): { at: Motion | null; speed: Pace } {
  const me = snap.players.find((p) => p.id === snap.self.id);
  const crawling = !!me?.downed;
  return { at: me && (me.alive || crawling) ? { x: me.x, y: me.y, dash: snap.self.dash, ...(!crawling && snap.self.knock && { knock: snap.self.knock }) } : null, speed: crawling ? snap.self.speed * ZOM.crawlMul : { walk: snap.self.speed, sprint: snap.self.sprintSpeed ?? snap.self.speed } };
}

export function predictAbility(pred: Prediction, input: InputState, latest: Snapshot, friends: ReadonlySet<number> = new Set()): PredictedAbility | null {
  const { self } = latest;
  const busy = !!pred.afterNewest?.dash || pred.pending.some((p) => p.ability);
  if (!input.ability || !self.alive || latest.match.winner !== null || self.abilityReadyIn > 0 || busy) return null;
  switch (self.ability) {
    case 'dash': return { k: 'dash' };
    case 'knife': {
      const team = latest.players.find((p) => p.id === self.id)?.team ?? null;
      // Friends are never knifed (the server passes over them), so the lunge is not predicted to stop at one.
      return { k: 'knife', enemies: latest.players.filter((p) => p.alive && p.id !== self.id && (team === null || p.team !== team) && !friends.has(p.id)) };
    }
    default: return null;
  }
}

function stepInput(solids: readonly Rect[], at: Motion, p: PendingInput, speed: Pace, size: number): Motion {
  const moved = moveStep(solids, at, p.input, paceFor(speed, p.input), p.dtMs, size);
  switch (p.ability?.k) {
    case 'dash': return moved.dash ? moved : { ...moved, dash: startDash(p.input) };
    case 'knife': {
      const { x, y } = knifeLunge(solids, moved, p.input.angle, p.ability.enemies, size);
      return { ...moved, x, y };
    }
    case undefined: return moved;
  }
}

/** Replays `pending` from `start`, noting on each input whether a dash was running as it was taken. */
function replay(solids: readonly Rect[], start: Motion, pending: readonly PendingInput[], speed: Pace, size: number): { at: Motion; pending: PendingInput[] } {
  let at = start;
  const noted = pending.map((p) => {
    const dashing = !!at.dash;
    at = stepInput(solids, at, p, speed, size);
    return p.dashing === dashing ? p : { ...p, dashing };
  });
  return { at, pending: noted };
}

export function predictInput(pred: Prediction, entry: PendingInput, solids: readonly Rect[], speed: Pace, now: number, size: number): Prediction {
  const was = pred.afterNewest;
  const pending = [...pred.pending, was ? { ...entry, dashing: !!was.dash } : entry].slice(-MAX_PENDING);
  if (!was) return { ...pred, pending };
  return { ...pred, pending, beforeNewest: was, afterNewest: stepInput(solids, was, entry, speed, size), sampledAt: now };
}

export function reconcile(pred: Prediction, server: Motion | null, ackSeq: number, solids: readonly Rect[], speed: Pace, size: number): Prediction {
  const unacked = pred.pending.filter((p) => p.seq > ackSeq);
  if (!server) return { ...NO_PREDICTION, pending: unacked };
  const { at: afterNewest, pending } = replay(solids, server, unacked, speed, size);
  const was = pred.afterNewest;
  if (!was || !pred.beforeNewest || Math.hypot(afterNewest.x - was.x, afterNewest.y - was.y) > SNAP_DIST) {
    return { pending, afterNewest, beforeNewest: afterNewest, sampledAt: pred.sampledAt, smoothingCorrection: { x: 0, y: 0 } };
  }
  const dx = afterNewest.x - was.x, dy = afterNewest.y - was.y;
  return {
    pending, afterNewest, sampledAt: pred.sampledAt,
    beforeNewest: { x: pred.beforeNewest.x + dx, y: pred.beforeNewest.y + dy },
    smoothingCorrection: { x: pred.smoothingCorrection.x - dx, y: pred.smoothingCorrection.y - dy },
  };
}

export function decayCorrection(pred: Prediction, dtMs: number): Prediction {
  const k = Math.exp(-Math.max(0, dtMs) / SMOOTH_MS);
  const x = pred.smoothingCorrection.x * k, y = pred.smoothingCorrection.y * k;
  return { ...pred, smoothingCorrection: Math.hypot(x, y) < 0.01 ? { x: 0, y: 0 } : { x, y } };
}

export function drawnPosition(pred: Prediction, now: number, stepMs: number): Point | null {
  const { beforeNewest: a, afterNewest: b, smoothingCorrection: c } = pred;
  if (!a || !b) return null;
  const t = Math.min(1, Math.max(0, (now - pred.sampledAt) / stepMs));
  return { x: lerp(a.x, b.x, t) + c.x, y: lerp(a.y, b.y, t) + c.y };
}
