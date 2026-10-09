import type { MedalId } from '../shared/defs.ts';
import type { Snapshot } from '../shared/protocol.ts';
import type { Point } from './camera.ts';
import { serverMs } from './replaybuf.ts';

/**
 * Render-only time dilation. The server and the shared sim never slow down: the client simply draws a moment further
 * back along the snapshots it already holds (`lag`), advancing that drawn time at `speed` instead of 1, then catches up.
 * Timeline in real ms: ramp down, hold at `rate`, ramp up (together `durationMs`, the celebration limit), then a short
 * catch-up faster than real time until the lag is gone.
 */
export const SLOWMO = {
  rate: 0.25, rampInMs: 100, durationMs: 1200, rampOutMs: 300, catchUp: 1.8, zoom: 0.32, focus: 0.5, cooldownMs: 6000,
  /** The drawn time never trails the newest snapshot by more than this, so it stays inside the 1 s the interpolation buffer keeps. */
  maxLagMs: 780,
} as const;

/** The timeline's shape, so another moment (the menu's attract mode) can slow down by its own numbers. */
export type SlowShape = { readonly rate: number; readonly rampInMs: number; readonly durationMs: number; readonly rampOutMs: number };

/** The medals big enough to stop the clock for. */
export const SLOWMO_MEDALS: ReadonlySet<MedalId> = new Set<MedalId>(['quadKill', 'massacre', 'reaper']);

export type Warp = {
  /** How far behind normal the drawn time is, in ms. */
  lag: number;
  /** Real time the slow part began, null while there is none. */
  startedAt: number | null;
  focus: Point | null;
  /** A trigger waiting for the drawn time to reach `at` (server ms). */
  pending: { at: number; focus: Point | null } | null;
  /** Real time the last one began, for the cooldown. */
  lastAt: number;
};

export const IDLE_WARP: Warp = { lag: 0, startedAt: null, focus: null, pending: null, lastAt: -Infinity };

/** Playback speed t ms into the slow part: 1 before it, `rate` through the hold, back to 1 at the end. */
export function speedAt(t: number, s: SlowShape = SLOWMO): number {
  if (t <= 0) return 1;
  if (t < s.rampInMs) return 1 + (s.rate - 1) * (t / s.rampInMs);
  const out = s.durationMs - s.rampOutMs;
  if (t < out) return s.rate;
  if (t < s.durationMs) return s.rate + (1 - s.rate) * ((t - out) / s.rampOutMs);
  return 1;
}

/** The lag the whole slow part builds up: what the speed curve gives away relative to real time. Used to check it fits `maxLagMs`. */
export function totalLag(s: SlowShape = SLOWMO): number {
  const dt = 5;
  let lag = 0;
  for (let t = 0; t < s.durationMs; t += dt) lag += (1 - speedAt(t + dt / 2, s)) * dt;
  return lag;
}

const easeOut = (x: number) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;

/** How far into the cinematic look (zoom, bars) the slow part is, 0 to 1: eased in with the ramp, eased out with the last stretch. */
export function intensityAt(t: number | null, s: SlowShape = SLOWMO): number {
  if (t === null || t < 0 || t >= s.durationMs) return 0;
  return Math.min(easeOut(t / s.rampInMs), easeOut((s.durationMs - t) / s.rampOutMs));
}

/** Whether the render is behind at all, for the things that follow it (the banner waits, the hands stop predicting). */
export const warping = (w: Warp): boolean => w.startedAt !== null || w.lag > 0.5;

/**
 * Advances the warp by one frame of `dtMs` real ms. `base` is the undelayed drawn server time (what the clock would show without
 * dilation); returns the new warp. Starts a waiting trigger once `base` reaches it.
 */
export function stepWarp(w: Warp, now: number, dtMs: number, base: number): Warp {
  const dt = Math.min(Math.max(dtMs, 0), 100);
  let { lag, startedAt, pending, lastAt, focus } = w;
  if (pending && startedAt === null && base - lag >= pending.at - 160) {
    startedAt = now; lastAt = now; focus = pending.focus; pending = null;
  }
  if (startedAt !== null) {
    const t = now - startedAt;
    lag = Math.min(SLOWMO.maxLagMs, lag + (1 - speedAt(t + dt / 2)) * dt);
    if (t >= SLOWMO.durationMs) startedAt = null;
  } else if (lag > 0) {
    lag = Math.max(0, lag - (SLOWMO.catchUp - 1) * dt);
  }
  return { lag, startedAt, focus: startedAt === null && lag === 0 ? null : focus, pending, lastAt };
}

/** Asks for a slow part to start when the drawn time reaches `at`; a request while one runs or waits is ignored, and so is one inside the cooldown unless `force`d (the round's last kill). */
export const requestSlowmo = (w: Warp, now: number, at: number, focus: Point | null, force = false): Warp =>
  (w.pending || w.startedAt !== null || w.lag > 0 || (!force && now - w.lastAt < SLOWMO.cooldownMs) ? w : { ...w, pending: { at, focus } });

export type Trigger = { why: 'final' | 'medal'; at: number; focus: Point | null; label: string | null };

/**
 * Whether the snapshot that just arrived holds a moment worth stopping the clock for: the kill that ended the round, or a big
 * multi-kill or Reaper medal of yours. The focus is where that kill landed.
 */
export function slowmoTrigger(prev: Snapshot | null, snap: Snapshot): Trigger | null {
  if (snap.run) return null;
  const kills = snap.events.filter((e) => e.e === 'kill');
  const fall = (id: number | undefined): Point | null => {
    if (id === undefined) return null;
    const blow = snap.events.filter((e) => e.e === 'dmg' && e.kind === 'player' && e.victim === id).at(-1);
    if (blow?.e === 'dmg') return { x: blow.x, y: blow.y };
    return prev?.players.find((p) => p.id === id) ?? null;
  };
  const last = kills[kills.length - 1];
  const lastVictim = last?.e === 'kill' ? last.victimId : undefined;
  if (prev && !prev.match.winner && snap.match.winner && last) return { why: 'final', at: serverMs(snap), focus: fall(lastVictim), label: null };
  const medal = snap.events.find((e) => e.e === 'medal' && e.id === snap.self.id && SLOWMO_MEDALS.has(e.medal));
  if (medal?.e === 'medal') {
    const mine = kills.filter((k) => k.e === 'kill' && k.killerId === snap.self.id).at(-1);
    return { why: 'medal', at: serverMs(snap), focus: fall(mine?.e === 'kill' ? mine.victimId : undefined), label: medal.medal };
  }
  return null;
}

/** The camera for the slow part: its center drawn toward the kill and its view radius narrowed, both by the look's intensity. */
export function dilatedView(center: Point, focus: Point | null, radius: number, intensity: number, reduced: boolean): { center: Point; radius: number } {
  if (reduced || intensity <= 0) return { center, radius };
  const k = intensity * SLOWMO.focus * (focus ? 1 : 0);
  return {
    center: focus ? { x: center.x + (focus.x - center.x) * k, y: center.y + (focus.y - center.y) * k } : center,
    radius: radius / (1 + SLOWMO.zoom * intensity),
  };
}
