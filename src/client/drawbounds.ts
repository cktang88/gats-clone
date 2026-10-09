/**
 * Where a drawing puts ink, without painting it: `recordBounds()` hands out a stand-in 2D context that follows the transform,
 * the path, the clip and the line width, and grows a box over everything filled, stroked, written or stamped through it. The
 * menu's item previews use it to fit each soldier and item inside its card (preview.ts), and the tests use it to prove none of
 * them is cut off by the canvas edge.
 *
 * Images stamped into it count only their inked part: an image that carries its own `inkBounds()` (a canvas painted through
 * another recorder) reports that, a real canvas is scanned once for its non-transparent pixels, and anything else counts whole.
 * Paths are traced, not hulled (curves and arcs are sampled), strokes grow by half their width and joins are taken as round.
 */
export type Bounds = { x0: number; y0: number; x1: number; y1: number };
type M = [number, number, number, number, number, number];
type Pt = [number, number];

const ARC_STEPS = 24, CURVE_STEPS = 8;

export const unionBounds = (a: Bounds | null, b: Bounds | null): Bounds | null =>
  !a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
const intersect = (a: Bounds, b: Bounds | null): Bounds | null => {
  if (!b) return a;
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return r.x0 > r.x1 || r.y0 > r.y1 ? null : r;
};
const boxOf = (pts: readonly Pt[], grow = 0): Bounds | null => {
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0: x0 - grow, y0: y0 - grow, x1: x1 + grow, y1: y1 + grow };
};

const scanned = new WeakMap<object, Bounds | null>();
type Img = { width?: number; height?: number; inkBounds?: () => Bounds | null; getContext?: (k: '2d') => CanvasRenderingContext2D | null };

/** The inked part of an image, in its own pixels: its `inkBounds()`, a scan of its pixels, or else the whole of it. */
export function imageInk(img: Img): Bounds | null {
  const w = Number(img.width) || 0, h = Number(img.height) || 0;
  const whole = { x0: 0, y0: 0, x1: w, y1: h };
  if (typeof img.inkBounds === 'function') { const b = img.inkBounds(); return b && intersect(b, whole); }
  if (scanned.has(img)) return scanned.get(img)!;
  let found: Bounds | null = whole;
  try {
    const data = w > 0 && h > 0 ? img.getContext?.('2d')?.getImageData(0, 0, w, h).data : undefined;
    if (data) {
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3]! > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      found = x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
    }
  } catch { found = whole; }
  scanned.set(img, found);
  return found;
}

const fontPx = (font: string): number => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);

export function recordBounds(): { ctx: CanvasRenderingContext2D; bounds(): Bounds | null } {
  let m: M = [1, 0, 0, 1, 0, 0];
  let clip: Bounds | null = null;
  let path: Pt[] = [];
  let at: Pt = [0, 0];
  let start: Pt = [0, 0];
  let ink: Bounds | null = null;
  const props: Record<string, unknown> = {
    globalAlpha: 1, lineWidth: 1, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', fillStyle: '#000',
    strokeStyle: '#000', globalCompositeOperation: 'source-over', lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, filter: 'none',
    shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', shadowOffsetX: 0, shadowOffsetY: 0, imageSmoothingEnabled: true, lineDashOffset: 0,
  };
  const stack: { m: M; clip: Bounds | null; props: Record<string, unknown> }[] = [];
  const tx = (x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const scaleOf = () => Math.sqrt(Math.max(m[0] * m[0] + m[1] * m[1], m[2] * m[2] + m[3] * m[3]));
  const mul = (a: number, b: number, c: number, d: number, e: number, f: number) => {
    m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]];
  };
  const add = (b: Bounds | null) => {
    if (!b) return;
    const blur = Number(props.shadowBlur) || 0;
    const grown = blur > 0 && !/rgba\([^)]*,\s*0\)$/.test(String(props.shadowColor))
      ? unionBounds(b, { x0: b.x0 - blur + Number(props.shadowOffsetX), y0: b.y0 - blur + Number(props.shadowOffsetY), x1: b.x1 + blur + Number(props.shadowOffsetX), y1: b.y1 + blur + Number(props.shadowOffsetY) })
      : b;
    ink = unionBounds(ink, grown && intersect(grown, clip));
  };
  const point = (x: number, y: number) => { at = [x, y]; path.push(tx(x, y)); };
  const ellipsePts = (cx: number, cy: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw = false) => {
    const TAU = Math.PI * 2;
    let span = a1 - a0;
    if (Math.abs(span) >= TAU) span = Math.sign(span) * TAU;
    else if (!ccw && span < 0) span += TAU;
    else if (ccw && span > 0) span -= TAU;
    const steps = Math.max(2, Math.ceil((ARC_STEPS * Math.abs(span)) / (Math.PI * 2)));
    const cr = Math.cos(rot), sr = Math.sin(rot);
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (span * i) / steps, ex = Math.cos(a) * rx, ey = Math.sin(a) * ry;
      point(cx + ex * cr - ey * sr, cy + ex * sr + ey * cr);
    }
  };
  const rectPts = (x: number, y: number, w: number, h: number): Pt[] => [tx(x, y), tx(x + w, y), tx(x + w, y + h), tx(x, y + h)];
  const strokeGrow = () => (Number(props.lineWidth) || 0) * scaleOf() / 2;
  const textBox = (text: string, x: number, y: number, stroke: boolean, maxWidth?: number) => {
    const size = fontPx(String(props.font)), w = Math.min(String(text).length * size * 0.62, maxWidth ?? Infinity);
    const align = String(props.textAlign), base = String(props.textBaseline);
    const left = align === 'center' ? x - w / 2 : align === 'right' || align === 'end' ? x - w : x;
    const top = base === 'middle' ? y - size * 0.6 : base === 'top' || base === 'hanging' ? y : base === 'bottom' || base === 'ideographic' ? y - size * 1.2 : y - size * 0.95;
    add(boxOf(rectPts(left, top, w, size * 1.2), stroke ? strokeGrow() : 0));
  };
  const gradient = () => ({ addColorStop() {} });

  const api: Record<string, unknown> = {
    canvas: { width: 0, height: 0 },
    save() { stack.push({ m: [...m] as M, clip, props: { ...props } }); },
    restore() { const s = stack.pop(); if (s) { m = s.m; clip = s.clip; Object.assign(props, s.props); } },
    translate(x: number, y: number) { mul(1, 0, 0, 1, x, y); },
    scale(x: number, y: number) { mul(x, 0, 0, y, 0, 0); },
    rotate(a: number) { const c = Math.cos(a), s = Math.sin(a); mul(c, s, -s, c, 0, 0); },
    transform(a: number, b: number, c: number, d: number, e: number, f: number) { mul(a, b, c, d, e, f); },
    setTransform(a?: number | { a: number; b: number; c: number; d: number; e: number; f: number }, b = 0, c = 0, d = 1, e = 0, f = 0) {
      if (a === undefined) m = [1, 0, 0, 1, 0, 0];
      else if (typeof a === 'object') m = [a.a, a.b, a.c, a.d, a.e, a.f];
      else m = [a, b, c, d, e, f];
    },
    resetTransform() { m = [1, 0, 0, 1, 0, 0]; },
    getTransform() { const [a, b, c, d, e, f] = m; return { a, b, c, d, e, f, is2D: true }; },
    beginPath() { path = []; },
    moveTo(x: number, y: number) { point(x, y); start = [x, y]; },
    lineTo(x: number, y: number) { point(x, y); },
    closePath() { at = start; },
    quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
      const [x0, y0] = at;
      for (let i = 1; i <= CURVE_STEPS; i++) { const t = i / CURVE_STEPS, u = 1 - t; point(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y); }
    },
    bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) {
      const [x0, y0] = at;
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS, u = 1 - t;
        point(u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x, u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y);
      }
    },
    // The rounded corner never leaves the hull of the corner it rounds.
    arcTo(x1: number, y1: number, x2: number, y2: number) { point(x1, y1); point(x2, y2); },
    arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean) { ellipsePts(x, y, r, r, 0, a0, a1, ccw); },
    ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw?: boolean) { ellipsePts(x, y, rx, ry, rot, a0, a1, ccw); },
    rect(x: number, y: number, w: number, h: number) { path.push(...rectPts(x, y, w, h)); at = start = [x, y]; },
    roundRect(x: number, y: number, w: number, h: number) { path.push(...rectPts(x, y, w, h)); at = start = [x, y]; },
    fill() { add(boxOf(path)); },
    stroke() { add(boxOf(path, strokeGrow())); },
    clip() { const b = boxOf(path); clip = b ? intersect(b, clip) ?? { x0: 0, y0: 0, x1: 0, y1: 0 } : clip; },
    fillRect(x: number, y: number, w: number, h: number) { add(boxOf(rectPts(x, y, w, h))); },
    strokeRect(x: number, y: number, w: number, h: number) { add(boxOf(rectPts(x, y, w, h), strokeGrow())); },
    clearRect() {},
    fillText(t: string, x: number, y: number, max?: number) { textBox(t, x, y, false, max); },
    strokeText(t: string, x: number, y: number, max?: number) { textBox(t, x, y, true, max); },
    measureText(t: string) { const size = fontPx(String(props.font)); return { width: String(t).length * size * 0.62, actualBoundingBoxAscent: size * 0.75, actualBoundingBoxDescent: size * 0.2 }; },
    drawImage(img: Img, ...n: number[]) {
      const iw = Number(img.width) || 0, ih = Number(img.height) || 0;
      let [sx, sy, sw, sh] = [0, 0, iw, ih];
      let [dx, dy, dw, dh] = [n[0]!, n[1]!, iw, ih];
      if (n.length === 4) [dx, dy, dw, dh] = n as [number, number, number, number];
      else if (n.length >= 8) [sx, sy, sw, sh, dx, dy, dw, dh] = n as [number, number, number, number, number, number, number, number];
      if (!sw || !sh) return;
      const b = imageInk(img);
      const src = b && intersect(b, { x0: sx, y0: sy, x1: sx + sw, y1: sy + sh });
      if (!src) return;
      const kx = dw / sw, ky = dh / sh;
      add(boxOf(rectPts(dx + (src.x0 - sx) * kx, dy + (src.y0 - sy) * ky, (src.x1 - src.x0) * kx, (src.y1 - src.y0) * ky)));
    },
    createLinearGradient: gradient, createRadialGradient: gradient, createConicGradient: gradient,
    createPattern() { return { setTransform() {} }; },
    setLineDash() {}, getLineDash() { return []; },
    getImageData(_x: number, _y: number, w: number, h: number) { return { width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)) }; },
    putImageData() {},
    isPointInPath() { return false; },
  };
  const ctx = new Proxy(api, {
    get: (t, k: string) => (k in t ? t[k] : k in props ? props[k] : () => undefined),
    set: (t, k: string, v) => { if (k in t) t[k] = v; else props[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, bounds: () => ink };
}
