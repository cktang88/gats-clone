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

/**
 * What the cursor is over decides how it looks: the crosshair over the game, a plain arrow over any other piece of the UI (a
 * popup, the chat, a panel), and a pointing hand over something that takes a click (a button, a link, a name on the board).
 */
export type PointerKind = 'crosshair' | 'arrow' | 'hand';
/** What takes a click, for the hand. */
export const CLICKABLE = 'button, a[href], [role="button"], input, select, textarea, label, summary, .chat-name';
type Hit = { closest(selector: string): unknown } | null;

/** The look for the element under the cursor (`hit`), `game` being the game canvas, where the crosshair aims. */
export function pointerFor(hit: Hit, game: unknown): PointerKind {
  if (!hit || hit === game) return 'crosshair';
  return hit.closest(CLICKABLE) ? 'hand' : 'arrow';
}

type PathCtx = {
  beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void;
  roundRect(x: number, y: number, w: number, h: number, r: number): void; fill(): void; stroke(): void;
  fillStyle: unknown; strokeStyle: unknown; lineWidth: number; lineJoin: unknown;
};

/** A plain OS-style cursor in CSS px, tip (or fingertip) at (x, y): white with a dark outline, so it reads on any floor or panel. */
export function drawPointer(ctx: PathCtx, kind: 'arrow' | 'hand', x: number, y: number) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#111317';
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  if (kind === 'arrow') {
    const pts = [[0, 0], [0, 17], [4.2, 13.2], [7.2, 20], [10, 18.8], [7.1, 12.2], [12.6, 12.2]] as const;
    ctx.moveTo(x, y);
    for (const [px, py] of pts.slice(1)) ctx.lineTo(x + px, y + py);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    return;
  }
  // A pointing hand: the index finger up from a rounded palm, the thumb out to the left.
  const ox = x - 5.5, oy = y;
  for (const [rx, ry, rw, rh, r] of [[ox + 4, oy + 9, 11.5, 11, 3.5], [ox, oy + 10.5, 6, 4.2, 2.1], [ox + 4, oy, 4, 13, 2]] as const) {
    ctx.beginPath();
    ctx.roundRect(rx, ry, rw, rh, r);
    ctx.fill();
    ctx.stroke();
  }
  // Fill over the seams where the finger and thumb meet the palm, so it reads as one hand.
  ctx.beginPath();
  ctx.roundRect(ox + 4.8, oy + 9.8, 9.9, 3.5, 1);
  ctx.roundRect(ox + 3.2, oy + 11.2, 2.4, 2.8, 1);
  ctx.fill();
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
    /** The context set for CSS px, to draw a plain cursor (`drawPointer`) at the aim point in place of the crosshair. */
    css(): C {
      dirty = true;
      ctx.setTransform(dpr, 0, 0, dpr, -box.x * dpr, -box.y * dpr);
      return ctx;
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
