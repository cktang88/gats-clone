/**
 * Sizing for the screen-filling canvases: the 2D one the world and HUD are drawn into (#game) and the shader pass's (#fx), which
 * shows that same world. Both take the visible area in CSS px (viewport.ts's measureLayout) as an explicit box, so their backing
 * store and CSS size always share one scale on both axes and the two layers sit pixel for pixel on each other.
 *
 * A layer sized by CSS units instead (100vh) breaks on iOS Safari: `vh` is the viewport with the toolbars collapsed, taller than
 * the visible area while the toolbar shows, so that layer stretches its pixels down while the HUD layer does not. That drew the
 * world tall and put your health ring above your soldier.
 */
export type CanvasBox = { width: number; height: number; cssW: number; cssH: number };

/** The backing store for a CSS box at `scale` canvas px per CSS px (the device pixel ratio, or less). */
export const canvasBox = (cssW: number, cssH: number, scale: number): CanvasBox => ({
  width: Math.max(1, Math.round(cssW * scale)),
  height: Math.max(1, Math.round(cssH * scale)),
  cssW,
  cssH,
});

/** What the shader pass's canvas takes to show `source`: its backing store as is, at the CSS box the source is shown in. */
export const layerBox = (source: { width: number; height: number }, cssW: number, cssH: number): CanvasBox => ({ width: source.width, height: source.height, cssW, cssH });

/** The window, as far as the visible area goes. */
export type ViewportSource = { innerWidth: number; innerHeight: number; visualViewport?: { width: number; height: number; scale: number } | null };

/**
 * The visible area in whole CSS px. iOS Safari's toolbars move, and visualViewport tracks them where innerHeight can lag (it fires
 * its own resize, without the window's, as the toolbar shows or hides); a pinch zoom (scale other than 1) falls back to the window.
 */
export function visibleSize(win: ViewportSource): { w: number; h: number } {
  const vv = win.visualViewport;
  const zoomed = !vv || vv.scale !== 1;
  return { w: Math.max(1, Math.round(zoomed ? win.innerWidth : vv.width)), h: Math.max(1, Math.round(zoomed ? win.innerHeight : vv.height)) };
}

export type Fittable = { width: number; height: number; style: { width: string; height: string } };

/** Sizes a canvas's backing store and CSS box together, touching only what changed (a resize clears the canvas). True if anything did. */
export function fitCanvas(el: Fittable, box: CanvasBox): boolean {
  let changed = false;
  if (el.width !== box.width) { el.width = box.width; changed = true; }
  if (el.height !== box.height) { el.height = box.height; changed = true; }
  const w = `${box.cssW}px`, h = `${box.cssH}px`;
  if (el.style.width !== w) { el.style.width = w; changed = true; }
  if (el.style.height !== h) { el.style.height = h; changed = true; }
  return changed;
}
