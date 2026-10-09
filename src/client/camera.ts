import { clampAspect, viewExtents } from '../shared/protocol.ts';
import { LOOK_AHEAD } from '../shared/lookahead.ts';

export type Camera = { x: number; y: number; scale: number; w: number; h: number; viewHalfW: number; viewHalfH: number };
export type Point = { x: number; y: number };

export const viewAspect = (w: number, h: number): number => clampAspect(w / h);

/**
 * Scale that makes the allowed view COVER the screen: the screen is filled edge to edge with no bars, and when its shape is outside the
 * allowed aspect clamp the overflow on the long axis is cropped. Since scale >= the fitting scale, nothing beyond the allowed view is ever
 * drawn, so a phone or ultrawide never sees more world than the server's aspect clamp grants.
 */
export const coverScale = (w: number, h: number, halfW: number, halfH: number): number => Math.max(w / (2 * halfW), h / (2 * halfH));

export function makeCamera(center: Point, w: number, h: number, viewRadius: number): Camera {
  const { halfW: viewHalfW, halfH: viewHalfH } = viewExtents(viewRadius, viewAspect(w, h));
  return { x: center.x, y: center.y, w, h, viewHalfW, viewHalfH, scale: coverScale(w, h, viewHalfW, viewHalfH) };
}

export const worldToScreen = (c: Camera, p: Point): Point => ({
  x: (p.x - c.x) * c.scale + c.w / 2,
  y: (p.y - c.y) * c.scale + c.h / 2,
});

export const screenToWorld = (c: Camera, p: Point): Point => ({
  x: (p.x - c.w / 2) / c.scale + c.x,
  y: (p.y - c.h / 2) / c.scale + c.y,
});

// ---- aim look-ahead (shared/lookahead.ts): the camera leans toward where you aim ----

/**
 * How far the cursor is pushed from the middle of the screen, 0..1, measured per axis against the screen's own half width and half height:
 * 1 at `fullAt` of the way to any edge and beyond, so a cursor at the edge leans fully on a wide screen and a tall one alike, and the
 * middle half of the screen still grades it.
 */
export function cursorPush(cursor: Point, w: number, h: number, fullAt: number = LOOK_AHEAD.fullAt): number {
  if (!(w > 0) || !(h > 0) || !(fullAt > 0)) return 0;
  const d = Math.hypot((cursor.x - w / 2) / (w / 2), (cursor.y - h / 2) / (h / 2)) / fullAt;
  return Number.isFinite(d) ? Math.min(1, d) : 0;
}

/** The world half width and half height actually on screen: the allowed view, less what `coverScale` crops off a phone held upright. */
export function visibleHalf(w: number, h: number, viewRadius: number): { halfW: number; halfH: number } {
  const c = makeCamera({ x: 0, y: 0 }, w, h, viewRadius);
  return c.scale > 0 ? { halfW: w / (2 * c.scale), halfH: h / (2 * c.scale) } : { halfW: 0, halfH: 0 };
}

/**
 * The lean shortened (never turned, so the server's widening along the aim still covers it) until your own soldier, drawn at the screen's
 * middle less the lean, sits inside `edge` of the visible half width and half height: an ellipse, so a lean toward a short side of the
 * screen (up on a wide one, sideways on one held upright) stops sooner than a lean down the long side.
 */
export function boundLean(lean: Point, half: { halfW: number; halfH: number }, edge: number = LOOK_AHEAD.edge): Point {
  const ax = half.halfW * edge, ay = half.halfH * edge;
  if (!(ax > 0) || !(ay > 0) || !Number.isFinite(lean.x) || !Number.isFinite(lean.y)) return { x: 0, y: 0 };
  const e = Math.hypot(lean.x / ax, lean.y / ay);
  return e <= 1 ? lean : { x: lean.x / e, y: lean.y / e };
}

/**
 * The lean in world px: exactly along the aim (the angle the server has, so its widened interest covers it), `reach` long at a full push,
 * eased so a cursor near the middle (or a thumb resting on the stick) barely moves the view.
 */
export function lookAhead(aim: Point, push: number, reach: number, ease: number = LOOK_AHEAD.ease): Point {
  const len = Math.hypot(aim.x, aim.y);
  const t = Math.min(1, Math.max(0, Number.isFinite(push) ? push : 0));
  if (!(len > 1e-6) || !(reach > 0) || t === 0) return { x: 0, y: 0 };
  const mag = reach * t ** ease;
  return { x: (aim.x / len) * mag, y: (aim.y / len) * mag };
}

/** The lean the camera has now, and the eye it leaned from (a jump of the eye, or another eye, snaps the lean instead of easing it). */
export type LookCam = { x: number; y: number; eye: Point | null; key: string | null; snap: boolean };
export const NO_LOOKCAM: LookCam = { x: 0, y: 0, eye: null, key: null, snap: true };

/**
 * One frame of the lean's exponential follow toward `target`, the same after one 33 ms step as after two of 16.5 (frame-rate independent).
 * It snaps when asked (`snap`, after a hidden tab or a killcam), on a new eye or map (`key`), or when the eye jumped past `snapPx`.
 */
export function followLook(c: LookCam, eye: Point, key: string, target: Point, dtMs: number, rate: number, snapPx: number = LOOK_AHEAD.snapPx): LookCam {
  const at = { x: eye.x, y: eye.y };
  if (c.snap || !c.eye || c.key !== key || Math.hypot(eye.x - c.eye.x, eye.y - c.eye.y) > snapPx) return { x: target.x, y: target.y, eye: at, key, snap: false };
  const k = 1 - Math.exp((-rate * Math.max(0, Number.isFinite(dtMs) ? dtMs : 0)) / 1000);
  return { x: c.x + (target.x - c.x) * k, y: c.y + (target.y - c.y) * k, eye: at, key, snap: false };
}
