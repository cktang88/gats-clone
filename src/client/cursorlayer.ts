import type { Point } from './virtualcursor.ts';

/**
 * The crosshair's own layer. On a desktop the crosshair is the cursor (pointer lock hides the OS one, see pointerlock.ts), so it must
 * never slip under a DOM overlay: the cosmetic-unlock card, medal and challenge toasts, the level-up pill. The reticle, its reload
 * ring and the hit marker are drawn on a small canvas fixed above everything, moved to the aim point each frame, instead of on the
 * game canvas under the HUD's DOM.
 *
 * - Small on purpose: a square `LAYER.radius` CSS px (times the HUD's UI scale when that is above 1) round the aim point, so each
 *   frame is one clear and one tiny draw, and the compositor moves a small texture rather than re-uploading a full-screen one.
 * - Crisp: drawn at the full device pixel ratio, its corner snapped to whole device pixels, so nothing is resampled.
 * - Shown only while the crosshair is the cursor: playing on a desktop, the mouse seen, nothing open that needs a real cursor (the
 *   pause menu, the range panel); hidden on the menu and the death card. Then every element hides the OS cursor too (`ON_CLASS`),
 *   so an unlocked mouse over a popup shows just the crosshair, as a locked one does. When it is hidden in a match the game canvas
 *   gets its OS crosshair back (`REAL_CLASS`), so a real cursor is never missing.
 * - Touch screens never use it: the reticle and hit marker stay on the game canvas exactly as before.
 *
 * `createCursorLayer` takes its canvas and root so the rules are unit-tested in node; `installCursorLayer` is the browser glue.
 */

/** Above every overlay the page has (the highest is the pause toast at 70); test/client-cursorlayer.test.ts checks every stylesheet. */
export const CURSOR_LAYER_Z = 2147483000;

/** Half the layer's side in CSS px at UI scale 1: the widest bloom gap (120) plus a tick, the line widths and a bolt shake fit inside. */
export const LAYER = { radius: 160 } as const;

export const LAYER_CLASS = 'cursor-layer';
/** On the root while the crosshair is the cursor: no element shows the OS cursor. */
export const ON_CLASS = 'crosshair-cursor';
/** On the root while in a match with the crosshair hidden for a real cursor: the game canvas shows the OS crosshair again. */
export const REAL_CLASS = 'real-cursor';

export const CURSOR_LAYER_CSS = `
.${LAYER_CLASS} { position: fixed; left: 0; top: 0; z-index: ${CURSOR_LAYER_Z}; pointer-events: none; will-change: transform; contain: strict; }
html.${ON_CLASS}, html.${ON_CLASS} * { cursor: none !important; }
html.${REAL_CLASS} #game.aiming { cursor: crosshair; }
`;

export type CrosshairContext = { phase: string; touch: boolean; mouseAiming: boolean; paused: boolean; rangeOpen: boolean };

/** Whether the crosshair is the cursor now: never on a touch screen (main.ts does not even draw to the layer there). */
export const crosshairShown = (c: CrosshairContext): boolean => !c.touch && c.phase === 'playing' && c.mouseAiming && !c.paused && !c.rangeOpen;

export type LayerBox = {
  /** The layer's top left corner in CSS px, on a whole device pixel. */
  x: number;
  y: number;
  /** Its side in device pixels (the canvas's backing size) and in CSS px. */
  px: number;
  css: number;
};

/** Where the layer sits for an aim point `at` (CSS px), at device pixel ratio `dpr` and HUD scale `k`. */
export function layerBox(at: Point, dpr: number, k = 1): LayerBox {
  const d = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  const half = Math.ceil(LAYER.radius * Math.max(1, k) * d);
  return { x: (Math.round(at.x * d) - half) / d, y: (Math.round(at.y * d) - half) / d, px: half * 2, css: (half * 2) / d };
}

type Ctx = { setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void; clearRect(x: number, y: number, w: number, h: number): void };
export type LayerCanvas = { width: number; height: number; style: { width: string; height: string; transform: string; display: string } };
type Root = { classList: { toggle(name: string, on?: boolean): unknown } };

export function createCursorLayer<C extends Ctx>(canvas: LayerCanvas, ctx: C, root: Root, ratio: () => number) {
  let box: LayerBox = { x: 0, y: 0, px: 0, css: 0 };
  let dpr = 1;
  let shown: boolean | null = null;
  let inMatch: boolean | null = null;
  let dirty = false;
  let at: Point = { x: 0, y: 0 };
  /** The HUD's UI scale last drawn with, so the layer is not resized back and forth each frame. */
  let scale = 1;

  function size(k: number) {
    const b = layerBox(at, dpr, k);
    if (b.px !== canvas.width) {
      canvas.width = canvas.height = b.px;
      canvas.style.width = canvas.style.height = `${b.css}px`;
      dirty = false;
    }
    if (b.x !== box.x || b.y !== box.y) canvas.style.transform = `translate(${b.x}px, ${b.y}px)`;
    box = b;
  }

  const layer = {
    ctx,
    /**
     * Each frame, before anything is drawn: clears last frame's drawing, follows the aim point `p`, and shows or hides the layer
     * (`show`, see `crosshairShown`; `match`, whether a match is on, for the canvas's real cursor).
     */
    frame(p: Point, show: boolean, match: boolean) {
      at = { x: p.x, y: p.y };
      dpr = ratio() || 1;
      if (dirty) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; }
      size(scale);
      if (show !== shown) { canvas.style.display = show ? '' : 'none'; root.classList.toggle(ON_CLASS, show); shown = show; }
      const real = match && !show;
      if (real !== inMatch) { root.classList.toggle(REAL_CLASS, real); inMatch = real; }
      return layer;
    },
    /** The context set up for the HUD's own units (`k` its UI scale, a HUD unit being `k` CSS px), ready to draw the reticle. */
    hud(k: number): C {
      if (k !== scale) { scale = k; size(k); }
      dirty = true;
      const s = dpr * k;
      ctx.setTransform(s, 0, 0, s, -box.x * dpr, -box.y * dpr);
      return ctx;
    },
    /** A screen point (CSS px) in the layer's own CSS px, for drawers that set a bare device-pixel-ratio transform (killfx's hit marker). */
    local(p: Point): Point {
      dirty = true;
      return { x: p.x - box.x, y: p.y - box.y };
    },
    probe: () => ({ shown: shown === true, x: box.x + box.css / 2, y: box.y + box.css / 2, size: box.css, dpr, z: CURSOR_LAYER_Z }),
  };
  return layer;
}

export type CursorLayer = ReturnType<typeof createCursorLayer<CanvasRenderingContext2D>>;

/** The browser glue: the layer's canvas and stylesheet appended last to the page, and `?dev`'s `skirmishDev.cursorLayer()`. */
export function installCursorLayer(doc: Document): CursorLayer {
  const style = doc.createElement('style');
  style.textContent = CURSOR_LAYER_CSS;
  doc.head.append(style);
  const canvas = doc.createElement('canvas');
  canvas.className = LAYER_CLASS;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.display = 'none';
  doc.body.append(canvas);
  const layer = createCursorLayer(canvas, canvas.getContext('2d')!, doc.documentElement, () => devicePixelRatio);
  if (new URLSearchParams(location.search).has('dev')) {
    const w = window as unknown as { skirmishDev?: { cursorLayer?: unknown } };
    // devprobe.ts may replace skirmishDev once, so this is set again on a later frame if it went missing.
    const put = () => { (w.skirmishDev ??= {}).cursorLayer ??= layer.probe; };
    put();
    setInterval(put, 1000);
  }
  return layer;
}
