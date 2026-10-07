import { clampAspect, viewExtents } from '../shared/protocol.ts';

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
