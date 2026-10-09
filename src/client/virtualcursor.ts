/**
 * The aim point while the mouse is captured (pointerlock.ts). Under pointer lock the browser hides the OS cursor and stops moving
 * `clientX`/`clientY`; it reports only relative motion (`movementX`/`movementY`). This keeps a cursor of our own from that motion,
 * clamped to the viewport, so pushing past an edge slides the aim along it (and into a corner) instead of losing it off the window.
 *
 * Everything here is in CSS pixels, the space `clientX`, the camera and the HUD all use, so the device pixel ratio and the UI
 * scale never enter the position. They enter only through `unit`: how many `movementX` units one CSS pixel of cursor travel is.
 * The spec says one, but some browsers report device pixels (HiDPI) or ignore page zoom, so `unit` is learned from ordinary
 * unlocked moves, where both `movementX` and a `clientX` delta arrive for the same motion (`noteUnits`).
 *
 * Pure and DOM-free so it is unit-tested in node.
 */

export type Point = { x: number; y: number };

/** Mouse sensitivity while captured (settings.ts `mouseSensitivity`): the slider's range and its default. */
export const SENSITIVITY = { min: 0.2, max: 3, step: 0.05, default: 1 } as const;

export const CURSOR_GUARD = {
  /** Right after a lock some browsers send one bogus jump (the distance to the screen's middle, or a stale delta): drop big moves this soon. */
  settleMs: 120,
  /** Within `settleMs`, a move longer than this (CSS px, before sensitivity) is dropped as that jump. */
  settlePx: 48,
  /** At any time one event moves the cursor at most this share of the viewport's shorter side... */
  maxStepShare: 0.35,
  /** ...and never less than this many CSS px, so a small window still takes a fast flick. */
  minStep: 160,
} as const;

/** Keeps a point on the screen: [0, w-1] x [0, h-1], so the crosshair is always drawn and the aim always has a direction. */
export function clampToView(p: Point, w: number, h: number): Point {
  const maxX = Math.max(0, w - 1), maxY = Math.max(0, h - 1);
  const x = Number.isFinite(p.x) ? p.x : maxX / 2;
  const y = Number.isFinite(p.y) ? p.y : maxY / 2;
  return { x: Math.min(maxX, Math.max(0, x)), y: Math.min(maxY, Math.max(0, y)) };
}

export const clampSensitivity = (v: number): number => {
  if (!Number.isFinite(v)) return SENSITIVITY.default;
  const snapped = Math.round(v / SENSITIVITY.step) * SENSITIVITY.step;
  return Math.round(Math.min(SENSITIVITY.max, Math.max(SENSITIVITY.min, snapped)) * 100) / 100;
};

export type StepOpts = {
  /** The viewport in CSS px. */
  w: number;
  h: number;
  sensitivity: number;
  /** `movementX` units per CSS px (see `unitOf`); 1 by the spec. */
  unit: number;
  /** Time since the lock was granted, for the settle guard. */
  sinceLockMs: number;
};

/**
 * One `movementX`/`movementY` pair turned into CSS px of cursor travel, with the spike guard applied: null drops the event (a jump
 * just after the lock), otherwise the travel, its length capped so one rogue event cannot fling the aim across the screen.
 */
export function guardDelta(mx: number, my: number, o: Pick<StepOpts, 'w' | 'h' | 'unit' | 'sinceLockMs'>): Point | null {
  if (!Number.isFinite(mx) || !Number.isFinite(my)) return null;
  const unit = Number.isFinite(o.unit) && o.unit > 0 ? o.unit : 1;
  const dx = mx / unit, dy = my / unit;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: 0, y: 0 };
  if (o.sinceLockMs >= 0 && o.sinceLockMs < CURSOR_GUARD.settleMs && len > CURSOR_GUARD.settlePx) return null;
  const cap = Math.max(CURSOR_GUARD.minStep, CURSOR_GUARD.maxStepShare * Math.min(o.w, o.h));
  const k = len > cap ? cap / len : 1;
  return { x: dx * k, y: dy * k };
}

/** The cursor after one locked mouse move: guarded, scaled by sensitivity, clamped to the viewport. */
export function stepCursor(c: Point, mx: number, my: number, o: StepOpts): Point {
  const d = guardDelta(mx, my, o);
  if (!d) return clampToView(c, o.w, o.h);
  const s = clampSensitivity(o.sensitivity);
  return clampToView({ x: c.x + d.x * s, y: c.y + d.y * s }, o.w, o.h);
}

// ---- learning what a movementX unit is ----

export type UnitCal = { movement: number; client: number; samples: number };
export const NO_CAL: UnitCal = { movement: 0, client: 0, samples: 0 };

/** Ignores moves too small to compare and jumps (a cursor re-entering the window) too big to be one motion. */
const SAMPLE = { minPx: 1, maxPx: 200, needPx: 120, needSamples: 8 } as const;

/** Adds one unlocked move, where the same motion arrives as a `clientX` delta and as `movementX`. */
export function noteUnits(cal: UnitCal, clientDx: number, clientDy: number, mx: number, my: number): UnitCal {
  const c = Math.hypot(clientDx, clientDy), m = Math.hypot(mx, my);
  if (!Number.isFinite(c) || !Number.isFinite(m) || c < SAMPLE.minPx || m < SAMPLE.minPx || c > SAMPLE.maxPx || m > SAMPLE.maxPx * 4) return cal;
  return { movement: cal.movement + m, client: cal.client + c, samples: cal.samples + 1 };
}

/**
 * `movementX` units per CSS px. Until enough motion is seen it is 1 (the spec). Then the measured ratio, snapped to 1 or to the
 * device pixel ratio when it is close to either (the two cases browsers actually have), and kept within 0.5..4.
 */
export function unitOf(cal: UnitCal, dpr: number): number {
  if (cal.samples < SAMPLE.needSamples || cal.client < SAMPLE.needPx) return 1;
  const r = cal.movement / cal.client;
  if (Math.abs(r - 1) < 0.15) return 1;
  if (dpr > 0 && Math.abs(r - dpr) < 0.15 * dpr) return dpr;
  return Math.min(4, Math.max(0.5, r));
}
