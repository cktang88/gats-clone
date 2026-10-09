/**
 * A big canvas bake, cut into slices that each fit a frame's time budget.
 *
 * A painter (a map's floor, the ground layer's occlusion and shadows) is a long run of synchronous canvas calls drawn from a
 * seeded stream, so it cannot be paused halfway. `recordPaint` runs it once against a stand-in context that only writes the
 * calls down (no pixels), with the device-space box each draw can touch. `replaySlice` then plays the calls onto the real canvas
 * in order, as many as fit the budget, and carries on from there next frame: the canvas keeps its own state (styles, transform,
 * path, save stack) between frames, so the result is the same pixels as painting it in one go. A draw too big for one slice (a
 * full-map fill, a blurred pass over every wall) is played in bands: the same call under a clip of whole device rows at a time,
 * so every pixel is painted exactly once and the bands meet without seams.
 *
 * The browser records canvas calls and rasterizes them later, so timing the calls alone says little: each slice ends by making
 * the canvas rasterize what it was given (`flush`), and the time that takes teaches the slicer how many pixels a millisecond
 * buys (`Replay.rate`), which then sizes the next slice and its bands.
 *
 * Painters must not redraw a canvas after stamping it with `drawImage` (it is stamped when replayed, not when recorded); every
 * floor painter only stamps canvases it made for good (sprites, patterns, washes).
 */

export type Box = [x0: number, y0: number, x1: number, y1: number];
/**
 * What a painter drew, as one flat list (a painter makes hundreds of thousands of calls; one object each would cost more than
 * the painting): a property set is `0, name, value`; a call `1, name, argc, ...args`; a draw (a call that puts pixels down)
 * `2, name, argc, ...args, x0, y0, x1, y1, kind`, with the device box it can touch (NaN: the whole canvas) and its kind (the
 * call, under a blur or shadow or not, in a flat colour or a gradient or pattern), whose pixels cost alike.
 */
export type Recording = { data: unknown[]; ops: number };
/** One entry of a recording, read back (for the tests and the dev probe). */
export type PaintOp = { k: 0 | 1 | 2; name: string; args: unknown[]; box: Box | null; kind: string };
export function opsOf(rec: Recording): PaintOp[] {
  const out: PaintOp[] = [];
  for (let i = 0; i < rec.data.length; i = next(rec.data, i)) out.push(readOp(rec.data, i));
  return out;
}
const next = (d: unknown[], i: number) => (d[i] === 0 ? i + 3 : d[i] === 1 ? i + 3 + (d[i + 2] as number) : i + 3 + (d[i + 2] as number) + 5);
function readOp(d: unknown[], i: number): PaintOp {
  const k = d[i] as 0 | 1 | 2, name = d[i + 1] as string;
  if (k === 0) return { k, name, args: [d[i + 2]], box: null, kind: '' };
  const n = d[i + 2] as number, args = d.slice(i + 3, i + 3 + n);
  if (k === 1) return { k, name, args, box: null, kind: '' };
  const j = i + 3 + n, x0 = d[j] as number;
  return { k, name, args, box: Number.isNaN(x0) ? null : [x0, d[j + 1] as number, d[j + 2] as number, d[j + 3] as number], kind: d[j + 4] as string };
}

/** Thrown while recording a painter that reads pixels back; the caller paints it directly instead. */
export class Unrecordable extends Error {}

const PROPS = [
  'fillStyle', 'strokeStyle', 'globalAlpha', 'globalCompositeOperation', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset',
  'font', 'textAlign', 'textBaseline', 'direction', 'filter', 'imageSmoothingEnabled', 'imageSmoothingQuality', 'shadowBlur', 'shadowColor',
  'shadowOffsetX', 'shadowOffsetY', 'letterSpacing', 'wordSpacing', 'fontKerning', 'fontStretch', 'fontVariantCaps', 'textRendering',
] as const;
const TEXT_PROPS = ['font', 'letterSpacing', 'wordSpacing', 'fontKerning', 'fontStretch', 'fontVariantCaps', 'textRendering', 'direction', 'textAlign', 'textBaseline'] as const;
/** Calls answered by the real context: they make objects (gradients, patterns) and draw nothing. */
const MAKERS = ['createLinearGradient', 'createRadialGradient', 'createConicGradient', 'createPattern', 'createImageData'] as const;
/** Calls that would read pixels or ask what only drawing can answer. */
const READS = ['getImageData', 'isPointInPath', 'isPointInStroke', 'drawFocusIfNeeded', 'reset', 'getContextAttributes', 'isContextLost'] as const;
/** Compositing that changes pixels outside what is drawn: such a draw touches the whole canvas. */
const WHOLE = new Set(['copy', 'source-in', 'source-out', 'destination-in', 'destination-atop']);
/** The props whose change can change how far a draw spills past its shape. */
const SPILLS = new Set(['filter', 'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY', 'globalCompositeOperation']);

type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const stretch = (m: M) => Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]));

/** The stand-in context: plain methods (no Proxy), as a painter calls them hundreds of thousands of times. */
class Rec {
  d: unknown[] = [];
  n = 0;
  m: M;
  p: Record<string, unknown> = {};
  dash: number[] = [];
  /** The clip's device box (null: no clip), so a draw under a clip is known to stay inside it. */
  clipBox: Box | null = null;
  stack: { m: M; p: Record<string, unknown>; dash: number[]; clipBox: Box | null }[] = [];
  x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity; known = true;
  readonly real: CanvasRenderingContext2D;
  readonly measure: CanvasRenderingContext2D;
  constructor(real: CanvasRenderingContext2D, measure: CanvasRenderingContext2D) {
    this.real = real;
    this.measure = measure;
    const t = real.getTransform?.();
    this.m = t ? [t.a, t.b, t.c, t.d, t.e, t.f] : [1, 0, 0, 1, 0, 0];
    for (const k of PROPS) { const v = (real as unknown as Record<string, unknown>)[k]; if (typeof v !== 'function') this.p[k] = v; }
  }
  get canvas() { return this.real.canvas; }
  call(name: string, args: unknown[]) {
    const d = this.d;
    d.push(1, name, args.length);
    for (let i = 0; i < args.length; i++) d.push(args[i]);
    this.n++;
  }
  pt(x: number, y: number, r = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r)) { this.known = false; return; }
    const m = this.m, dx = m[0] * x + m[2] * y + m[4], dy = m[1] * x + m[3] * y + m[5];
    // A radius under a scaled or turned transform: its largest stretch, so the box only ever errs large.
    const rr = r ? r * stretch(m) : 0;
    if (dx - rr < this.x0) this.x0 = dx - rr;
    if (dy - rr < this.y0) this.y0 = dy - rr;
    if (dx + rr > this.x1) this.x1 = dx + rr;
    if (dy + rr > this.y1) this.y1 = dy + rr;
  }
  userBox(x: number, y: number, w: number, h: number): Box {
    const m = this.m;
    if (m[1] === 0 && m[2] === 0) {
      const ax = m[0] * x + m[4], bx = m[0] * (x + w) + m[4], ay = m[3] * y + m[5], by = m[3] * (y + h) + m[5];
      return [ax < bx ? ax : bx, ay < by ? ay : by, ax < bx ? bx : ax, ay < by ? by : ay];
    }
    const xs = [m[0] * x + m[2] * y, m[0] * (x + w) + m[2] * y, m[0] * x + m[2] * (y + h), m[0] * (x + w) + m[2] * (y + h)];
    const ys = [m[1] * x + m[3] * y, m[1] * (x + w) + m[3] * y, m[1] * x + m[3] * (y + h), m[1] * (x + w) + m[3] * (y + h)];
    return [Math.min(...xs) + m[4], Math.min(...ys) + m[5], Math.max(...xs) + m[4], Math.max(...ys) + m[5]];
  }
  /** How far past its shape a draw can reach (blur and shadows, in device px; null: unknown) and whether it blurs; kept till a prop changes. */
  spilled: { reach: number | null; blur: boolean; whole: boolean } | null = null;
  spill(): { reach: number | null; blur: boolean; whole: boolean } {
    if (this.spilled) return this.spilled;
    let reach: number | null = 2, blur = false;
    const f = String(this.p.filter ?? 'none');
    if (f !== 'none' && f !== '') {
      const b = /^\s*blur\(\s*([\d.]+)px\s*\)\s*$/.exec(f);
      blur = true;
      reach = b ? reach + Number(b[1]) * 3 * Math.max(1, stretch(this.m)) : null;
    }
    const sb = Number(this.p.shadowBlur) || 0, sx = Number(this.p.shadowOffsetX) || 0, sy = Number(this.p.shadowOffsetY) || 0;
    if ((sb > 0 || sx || sy) && !/,\s*0\s*\)$/.test(String(this.p.shadowColor ?? '')) && this.p.shadowColor !== 'transparent') {
      if (reach !== null) reach += sb * 2 + Math.abs(sx) + Math.abs(sy);
      blur = true;
    }
    return (this.spilled = { reach, blur, whole: WHOLE.has(String(this.p.globalCompositeOperation)) });
  }
  draw(name: string, args: unknown[], shape: Box | null, extra = 0, paint?: unknown) {
    const { reach, blur, whole } = this.spill();
    let box: Box | null = null;
    if (shape && reach !== null && !whole && Number.isFinite(shape[0] + shape[1] + shape[2] + shape[3])) {
      const r = reach + extra;
      box = [Math.floor(shape[0] - r), Math.floor(shape[1] - r), Math.ceil(shape[2] + r), Math.ceil(shape[3] + r)];
    }
    // Nothing is drawn outside the clip, whatever the draw.
    const c = this.clipBox;
    if (c) box = box ? [Math.max(box[0], c[0]), Math.max(box[1], c[1]), Math.min(box[2], c[2]), Math.min(box[3], c[3])] : [...c];
    const kind = (blur ? 'blur:' : '') + name + (typeof paint === 'object' && paint !== null ? ':paint' : '');
    const d = this.d;
    d.push(2, name, args.length);
    for (let i = 0; i < args.length; i++) d.push(args[i]);
    if (box) d.push(box[0], box[1], box[2], box[3], kind);
    else d.push(NaN, NaN, NaN, NaN, kind);
    this.n++;
  }
  strokeReach() { return ((Number(this.p.lineWidth) || 1) / 2) * Math.max(Number(this.p.miterLimit) || 10, 1) * stretch(this.m) + 1; }
  pathBox(args: unknown[]): Box | null {
    if (args.some((a) => typeof a === 'object' && a !== null) || !this.known) return null; // a Path2D: its shape is not known here
    if (this.x0 > this.x1) return [0, 0, 0, 0]; // an empty path draws nothing
    return [this.x0, this.y0, this.x1, this.y1];
  }

  // State.
  save() { this.stack.push({ m: [...this.m], p: { ...this.p }, dash: [...this.dash], clipBox: this.clipBox }); this.call('save', []); }
  restore() {
    // A restore with nothing saved would pop the caller's own state off the real canvas: it is dropped.
    const s = this.stack.pop();
    if (!s) return;
    this.m = s.m; this.p = s.p; this.dash = s.dash; this.clipBox = s.clipBox; this.spilled = null;
    this.call('restore', []);
  }
  translate(x: number, y: number) { this.m = mul(this.m, [1, 0, 0, 1, x, y]); this.call('translate', [x, y]); }
  scale(x: number, y: number) { this.spilled = null; this.m = mul(this.m, [x, 0, 0, y, 0, 0]); this.call('scale', [x, y]); }
  rotate(a: number) { this.spilled = null; const c = Math.cos(a), s = Math.sin(a); this.m = mul(this.m, [c, s, -s, c, 0, 0]); this.call('rotate', [a]); }
  transform(...a: number[]) { this.spilled = null; this.m = mul(this.m, a.slice(0, 6) as M); this.call('transform', a); }
  setTransform(...a: unknown[]) {
    this.spilled = null;
    if (a.length >= 6) this.m = (a as number[]).slice(0, 6) as M;
    else if (a.length === 1 && a[0]) { const d = a[0] as DOMMatrix2DInit; this.m = [d.a ?? d.m11 ?? 1, d.b ?? d.m12 ?? 0, d.c ?? d.m21 ?? 0, d.d ?? d.m22 ?? 1, d.e ?? d.m41 ?? 0, d.f ?? d.m42 ?? 0]; }
    else this.m = [1, 0, 0, 1, 0, 0];
    this.call('setTransform', a.length === 1 && a[0] ? [{ ...(a[0] as object) }] : a);
  }
  resetTransform() { this.spilled = null; this.m = [1, 0, 0, 1, 0, 0]; this.call('resetTransform', []); }
  getTransform() { const m = this.m; return new DOMMatrixLike(m); }
  setLineDash(d: number[]) { this.dash = [...d]; this.call('setLineDash', [this.dash]); }
  getLineDash() { return [...this.dash]; }

  // The path.
  beginPath() { this.x0 = this.y0 = Infinity; this.x1 = this.y1 = -Infinity; this.known = true; this.call('beginPath', []); }
  closePath() { this.call('closePath', []); }
  moveTo(x: number, y: number) { this.pt(x, y); this.call('moveTo', [x, y]); }
  lineTo(x: number, y: number) { this.pt(x, y); this.call('lineTo', [x, y]); }
  quadraticCurveTo(a: number, b: number, x: number, y: number) { this.pt(a, b); this.pt(x, y); this.call('quadraticCurveTo', [a, b, x, y]); }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number) { this.pt(a, b); this.pt(c, d); this.pt(x, y); this.call('bezierCurveTo', [a, b, c, d, x, y]); }
  arc(...a: unknown[]) { const n = a as number[]; this.pt(n[0]!, n[1]!, Math.abs(n[2]!)); this.call('arc', a); }
  ellipse(...a: unknown[]) { const n = a as number[]; this.pt(n[0]!, n[1]!, Math.max(Math.abs(n[2]!), Math.abs(n[3]!))); this.call('ellipse', a); }
  arcTo(...a: number[]) { this.pt(a[0]!, a[1]!, Math.abs(a[4]!)); this.pt(a[2]!, a[3]!, Math.abs(a[4]!)); this.call('arcTo', a); }
  rect(x: number, y: number, w: number, h: number) { this.pt(x, y); this.pt(x + w, y); this.pt(x, y + h); this.pt(x + w, y + h); this.call('rect', [x, y, w, h]); }
  roundRect(...a: unknown[]) { const n = a as number[]; this.pt(n[0]!, n[1]!); this.pt(n[0]! + n[2]!, n[1]!); this.pt(n[0]!, n[1]! + n[3]!); this.pt(n[0]! + n[2]!, n[1]! + n[3]!); this.call('roundRect', a); }
  clip(...a: unknown[]) {
    const b = this.pathBox(a);
    if (b) {
      const c = this.clipBox;
      const f: Box = [Math.floor(b[0]) - 1, Math.floor(b[1]) - 1, Math.ceil(b[2]) + 1, Math.ceil(b[3]) + 1];
      this.clipBox = c ? [Math.max(c[0], f[0]), Math.max(c[1], f[1]), Math.min(c[2], f[2]), Math.min(c[3], f[3])] : f;
    }
    this.call('clip', a);
  }

  // Draws.
  fill(...a: unknown[]) { this.draw('fill', a, this.pathBox(a), 0, this.p.fillStyle); }
  stroke(...a: unknown[]) { this.draw('stroke', a, this.pathBox(a), this.strokeReach(), this.p.strokeStyle); }
  fillRect(x: number, y: number, w: number, h: number) { this.draw('fillRect', [x, y, w, h], this.userBox(x, y, w, h), 0, this.p.fillStyle); }
  clearRect(x: number, y: number, w: number, h: number) { this.draw('clearRect', [x, y, w, h], this.userBox(x, y, w, h)); }
  strokeRect(x: number, y: number, w: number, h: number) { this.draw('strokeRect', [x, y, w, h], this.userBox(x, y, w, h), this.strokeReach(), this.p.strokeStyle); }
  fillText(...a: unknown[]) { this.draw('fillText', a, null); }
  strokeText(...a: unknown[]) { this.draw('strokeText', a, null); }
  putImageData(...a: unknown[]) { this.draw('putImageData', a, null); }
  drawImage(...a: unknown[]) {
    const n = a as number[], img = a[0] as { width?: number; height?: number; videoWidth?: number; videoHeight?: number };
    const d = a.length >= 9 ? n.slice(5, 9) : a.length >= 5 ? n.slice(1, 5) : [n[1]!, n[2]!, Number(img.width ?? img.videoWidth) || 0, Number(img.height ?? img.videoHeight) || 0];
    this.draw('drawImage', a, this.userBox(d[0]!, d[1]!, d[2]!, d[3]!));
  }
  measureText(text: string) {
    for (const k of TEXT_PROPS) if (this.p[k] !== undefined) try { (this.measure as unknown as Record<string, unknown>)[k] = this.p[k]; } catch {}
    return this.measure.measureText(text);
  }
}
/** What `getTransform` answers while recording: the matrix's own numbers. */
class DOMMatrixLike {
  a: number; b: number; c: number; d: number; e: number; f: number;
  constructor(m: M) { [this.a, this.b, this.c, this.d, this.e, this.f] = m; }
}
for (const k of PROPS) {
  Object.defineProperty(Rec.prototype, k, {
    get(this: Rec) { return this.p[k]; },
    set(this: Rec, v: unknown) { this.p[k] = v; if (SPILLS.has(k)) this.spilled = null; this.d.push(0, k, v); this.n++; },
  });
}
for (const k of MAKERS) Object.defineProperty(Rec.prototype, k, { value(this: Rec, ...a: unknown[]) { return (this.real as unknown as Record<string, (...x: unknown[]) => unknown>)[k]!(...a); } });
for (const k of READS) Object.defineProperty(Rec.prototype, k, { value() { throw new Unrecordable(k); } });

/**
 * Runs `paint` against a stand-in for `real` and returns what it drew, in order. `real` answers only what makes objects (gradients,
 * patterns), `measure` (a scratch context) measures text; anything that would read pixels back throws `Unrecordable`.
 */
export function recordPaint(real: CanvasRenderingContext2D, paint: (g: CanvasRenderingContext2D) => void, measure: CanvasRenderingContext2D = real): Recording {
  const r = new Rec(real, measure);
  paint(r as unknown as CanvasRenderingContext2D);
  // Leave the real canvas's save stack as it was found.
  for (let i = r.stack.length; i > 0; i--) r.call('restore', []);
  return { data: r.d, ops: r.n };
}

/** Where a replay is up to: the next op, and for a draw played in bands, the next device row (NaN: not in one). */
export type Replay = {
  rec: Recording; /** The index in `rec.data` of the next op. */ at: number; row: number; done: boolean;
  /** The canvas's size in device px, for draws that touch all of it. */
  w: number; h: number;
  /** What a pixel of each kind of draw is seen to cost to rasterize, in ms; learnt slice by slice. */
  rates: Map<string, number>;
  /** Each kind's rate as each of its last few slices saw it. */
  seen: Map<string, number[]>;
  /** The last slice: pieces played, px given, ms spent playing and flushing, and the op it began at. */
  last?: { pieces: number; px: number; playMs: number; flushMs: number; predictedMs: number; from: number; kind: string };
};
export const SLICE = {
  /**
   * A first guess at ms per pixel, on the slow side (a throttled phone), so a kind's first slice errs short: a flat fill, and a
   * draw that blurs or casts a shadow. Then the rates are learnt within these bounds.
   */
  rate: 2e-5, blurRate: 2e-4, minRate: 5e-7, maxRate: 5e-3,
  /** A band takes at most this share of a slice's budget, and is never thinner than this many px. */
  bandShare: 0.4, minBandPx: 2048,
  /** A slice plans to fill this share of its budget, leaving the rest for what the rates do not foresee. */
  aim: 0.75,
  /** How many slices of a kind its rate remembers. */
  memory: 8,
};
export const startReplay = (rec: Recording, w: number, h: number): Replay => ({ rec, at: 0, row: NaN, done: rec.data.length === 0, w, h, rates: new Map(), seen: new Map() });
const rateOf = (r: Replay, kind: string) => r.rates.get(kind) ?? (kind.startsWith('blur:') ? SLICE.blurRate : SLICE.rate);

/** What of a draw's box lies on a `w` x `h` canvas (the whole canvas for a draw that may touch all of it), or null if none does. */
function onCanvas(box: Box | null, w: number, h: number): Box | null {
  const b: Box = box ? [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(w, box[2]), Math.min(h, box[3])] : [0, 0, w, h];
  return b[2] > b[0] && b[3] > b[1] ? b : null;
}
/**
 * The next band of a draw over `b` from device row `row`, at most `bandPx` px: whole rows, so bands meet without seams. It is
 * sized afresh for each piece, from what pixels are seen to cost by then.
 */
export function bandAt(b: Box, row: number, bandPx: number): Box {
  const rows = Math.max(1, Math.floor(bandPx / (b[2] - b[0])));
  return [b[0], row, b[2], Math.min(b[3], row + rows)];
}
const areaOf = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);

/** The canvas seams a replay needs: clipping to a device rect, and making the canvas rasterize what it has been given. */
export type Surface = { clip(x0: number, y0: number, x1: number, y1: number): void; flush(): void };
export function surfaceOf(g: CanvasRenderingContext2D): Surface {
  return {
    clip(x0, y0, x1, y1) {
      const t = g.getTransform();
      g.setTransform(1, 0, 0, 1, 0, 0);
      const p = new Path2D();
      p.rect(x0, y0, x1 - x0, y1 - y0);
      g.clip(p);
      g.setTransform(t);
    },
    // Reading one pixel back makes the canvas rasterize every call it has been given.
    flush() { g.getImageData(0, 0, 1, 1); },
  };
}

/** Plays the op at `i` of `d` onto `g` and returns the index of the next. */
function play(g: CanvasRenderingContext2D, d: unknown[], i: number): number {
  const k = d[i], name = d[i + 1] as string;
  if (k === 0) { (g as unknown as Record<string, unknown>)[name] = d[i + 2]; return i + 3; }
  const n = d[i + 2] as number, f = (g as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!;
  const a = i + 3;
  switch (n) {
    case 0: f.call(g); break;
    case 1: f.call(g, d[a]); break;
    case 2: f.call(g, d[a], d[a + 1]); break;
    case 3: f.call(g, d[a], d[a + 1], d[a + 2]); break;
    case 4: f.call(g, d[a], d[a + 1], d[a + 2], d[a + 3]); break;
    default: f.apply(g, d.slice(a, a + n));
  }
  return k === 1 ? a + n : a + n + 5;
}

/**
 * Plays `r` onto `g` for about `budgetMs` of `clock`, rasterizing included, and returns true once it is done. A piece is one call,
 * or one band of a big draw. Before each piece the slice adds up what it has spent and what the pixels given so far will cost to
 * rasterize (`rate`); it stops when the next piece would pass the budget, and always plays at least one. Then it flushes and
 * learns the rate from how long that took.
 */
export function replaySlice(g: CanvasRenderingContext2D, r: Replay, budgetMs: number, clock: () => number, s: Surface = surfaceOf(g)): boolean {
  const t0 = clock();
  const from = r.at;
  let predicted = 0, px = 0, n = 0;
  /** Each kind's share of the predicted raster time, to share out what the flush takes. */
  const share = new Map<string, number>();
  const d = r.rec.data;
  while (r.at < d.length) {
    const i = r.at;
    let cost = 0, area = 0, band: Box | null = null, after = -1, end = 0, kind = '';
    if (d[i] === 2) {
      const j = i + 3 + (d[i + 2] as number), x0 = d[j] as number;
      after = j + 5;
      kind = d[j + 4] as string;
      const rate = rateOf(r, kind);
      const b = onCanvas(Number.isNaN(x0) ? null : [x0, d[j + 1] as number, d[j + 2] as number, d[j + 3] as number], r.w, r.h);
      if (!b) { r.at = after; continue; } // wholly off the canvas
      end = b[3];
      const bandPx = Math.max(SLICE.minBandPx, (budgetMs * SLICE.bandShare) / rate);
      if (Number.isNaN(r.row) && areaOf(b) > bandPx) r.row = b[1];
      if (!Number.isNaN(r.row)) band = bandAt(b, r.row, bandPx);
      area = areaOf(band ?? b);
      cost = area * rate;
    }
    if (n > 0 && clock() - t0 + predicted + cost > budgetMs * SLICE.aim) break;
    if (band) {
      g.save();
      s.clip(band[0], band[1], band[2], band[3]);
      play(g, d, i);
      g.restore();
      r.row = band[3];
      if (r.row >= end) { r.at = after; r.row = NaN; }
    } else r.at = play(g, d, i);
    if (kind) share.set(kind, (share.get(kind) ?? 0) + cost);
    predicted += cost;
    px += area;
    n++;
  }
  const f0 = clock();
  s.flush();
  const flushMs = clock() - f0;

  r.last = { pieces: n, px, playMs: f0 - t0, flushMs, predictedMs: predicted, from, kind: from < d.length ? (readOp(d, from).kind || (d[from + 1] as string)) : '' };
  // Learn from how far off the guess was, each kind in proportion to its part of it, from slices that drew enough to time (in a
  // slice that drew little, what a flush always costs, reading a pixel back, would read as dear pixels). A kind's
  // rate is the dearest it was seen to cost over its last few slices: quick to believe a dear slice, slow to trust a cheap one
  // (pixels in one draw vary in cost; a band of empty rows costs nothing), since the bake would rather run long than make a frame late.
  if (predicted >= budgetMs * 0.25) {
    const k = Math.min(8, Math.max(0.125, flushMs / predicted));
    for (const [kind, c] of share) {
      const w = c / Math.max(predicted, 1e-9);
      const seen = Math.min(SLICE.maxRate, Math.max(SLICE.minRate, rateOf(r, kind) * Math.pow(k, w)));
      const recent = r.seen.get(kind) ?? [];
      recent.push(seen);
      if (recent.length > SLICE.memory) recent.shift();
      r.seen.set(kind, recent);
      r.rates.set(kind, k > 1 || recent.length >= SLICE.memory ? Math.max(...recent) : Math.max(rateOf(r, kind), ...recent));
    }
  }
  r.done = r.at >= d.length;
  return r.done;
}

/** Plays all of `rec` onto `g` at once (no bands): the same pixels as the painter drawing directly. */
export function replayAll(g: CanvasRenderingContext2D, rec: Recording): void {
  for (let i = 0; i < rec.data.length;) i = play(g, rec.data, i);
}
