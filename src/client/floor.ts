import { MAPS, type MapDef, type ThemeId } from '../shared/maps.ts';
import type { Rect } from '../shared/sim/movement.ts';
import { FLOOR } from './palette.ts';
import { blotch, canvas, seeded, speckle } from './grain.ts';
import { themeOf } from './themes/registry.ts';
import { planDecor, wantsDecor, type DecorPlan } from './decor.ts';
import { paintDecor } from './decorart.ts';

/**
 * The arena floor: poured bone concrete in big slabs, laid out like a real yard. Every mark on it is placed from a seeded
 * stream, so a map always looks the same, and all of it is baked once into the cached ground layer: it costs nothing per frame.
 * The detail is kept quiet and low-contrast. Players, bullets and zombies are the loudest things on screen by design.
 */
export type FloorPlan = {
  walls: readonly Rect[];
  /** Deployment pads: where players appear. `team` tints the corner brackets. */
  pads: readonly (Rect & { team: 'red' | 'blue' | null })[];
  zones: readonly { x: number; y: number }[];
  zoneRadius: number;
  core?: { x: number; y: number };
  /** A quiet floor: no scattered arrows or drains, for a map that paints its own markings (the range). */
  calm?: true;
  /** The map's theme (src/client/themes), which may paint the whole floor itself. */
  theme?: ThemeId;
  /** Where the yard's practical lights and set dressing go (decor.ts); the marks are baked below, the fixtures drawn per frame (fixtures.ts). */
  decor?: DecorPlan;
};

export function floorPlan(map: MapDef): FloorPlan {
  const seen = new Set<string>();
  const pads: (Rect & { team: 'red' | 'blue' | null })[] = [];
  for (const [team, list] of [['red', map.spawns.red], ['blue', map.spawns.blue], [null, map.spawns.ffa]] as const) {
    for (const r of list) {
      const key = `${r.x},${r.y},${r.w},${r.h}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pads.push({ ...r, team });
    }
  }
  return { walls: map.walls, pads: map.range ? [] : pads, zones: map.zones, zoneRadius: 180, core: map.siege?.core, ...(map.range && { calm: true as const }), ...(map.theme && { theme: map.theme }), ...(wantsDecor(map) && { decor: planDecor(map) }) };
}

const plans = new Map<string, FloorPlan>();
const planOfMap = new WeakMap<MapDef, FloorPlan>();
const mapOf = (idOrName: string): MapDef | undefined => {
  const maps = MAPS as Record<string, MapDef>;
  return maps[idOrName] ?? Object.values(maps).find((m) => m.name === idOrName);
};
/**
 * The plan for a map by id or by its display name (what a snapshot carries), made once per map whichever it is asked by (planning
 * a big map's decor takes a while). An unknown map gets no plan, and so a plain floor.
 */
export function floorPlanOf(idOrName: string): FloorPlan | undefined {
  let plan = plans.get(idOrName);
  if (plan) return plan;
  const map = mapOf(idOrName);
  if (!map) return undefined;
  plan = planOfMap.get(map) ?? floorPlan(map);
  planOfMap.set(map, plan);
  plans.set(idOrName, plan);
  return plan;
}

/**
 * A plan as plain data, to post from a worker that has made it (groundworker.ts): the decor's keep-out tests are planning's own
 * and are left behind (`adoptFloorPlan` stands blunt ones in).
 */
export function portablePlan(plan: FloorPlan): FloorPlan {
  if (!plan.decor) return plan;
  const { lanes, pads, circles } = plan.decor.keep;
  return { ...plan, decor: { ...plan.decor, keep: { lanes, pads, circles } as DecorPlan['keep'] } };
}
/** Takes a plan made elsewhere (a worker's, `portablePlan`) for a map, unless one is made here already: the page need not plan it again. */
export function adoptFloorPlan(idOrName: string, plan: FloorPlan): void {
  const map = mapOf(idOrName);
  if (!map || planOfMap.has(map)) return;
  // The walls are the map's own (the ground cache knows a map's layer by them); the keep-out is only ever asked while planning.
  const keep = plan.decor && { ...plan.decor.keep, blocked: () => true, inWall: () => true };
  planOfMap.set(map, { ...plan, walls: map.walls, ...(plan.decor && keep && { decor: { ...plan.decor, keep } }) });
}



const TAU = Math.PI * 2;

/** `#rrggbb` as an rgba() string at alpha `a`. */
function hexA(hex: string, a: number): string {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${Math.min(1, a).toFixed(3)})`;
}

// Seven-segment stencil glyphs: the gaps between segments read as the bridges of a spray stencil.
const SEGS: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
  A: 'abcefg', C: 'adef', E: 'adefg', F: 'aefg', H: 'bcefg', L: 'def', P: 'abefg', U: 'bcdef', b: 'cdefg', d: 'bcdeg', J: 'bcde',
  // The rest of the alphabet, so a painted word never drops letters: i/j are the centre bar's halves, k/o/q/l/m/n the diagonals.
  B: 'abcdefg', D: 'abcdef', G: 'acdef', I: 'adij', K: 'efqm', M: 'bcefko', N: 'bcefn', O: 'abcdef', R: 'abefm', S: 'acdfg', T: 'aij',
  V: 'bcdef', W: 'bcdefj', X: 'nl', Y: 'bcdfg', Z: 'adl',
};

/** Stencils `text` with its top-left at (x, y), `h` tall. The caller sets the fill. */
export function stencil(g: CanvasRenderingContext2D, text: string, x: number, y: number, h: number) {
  const w = h * 0.52, t = h * 0.15, gap = t * 0.45, adv = w + t * 1.6;
  g.beginPath();
  for (const [i, ch] of [...text].entries()) {
    const ox = x + i * adv, segs = SEGS[ch] ?? '';
    const horiz = (yy: number) => g.rect(ox + gap, yy, w - gap * 2, t);
    const vert = (xx: number, y0: number) => g.rect(xx, y0 + gap, t, h / 2 - t - gap * 2 + t / 2);
    if (segs.includes('a')) horiz(y);
    if (segs.includes('g')) horiz(y + h / 2 - t / 2);
    if (segs.includes('d')) horiz(y + h - t);
    if (segs.includes('f')) vert(ox, y);
    if (segs.includes('b')) vert(ox + w - t, y);
    if (segs.includes('e')) vert(ox, y + h / 2 - t / 2);
    if (segs.includes('c')) vert(ox + w - t, y + h / 2 - t / 2);
    if (segs.includes('i')) g.rect(ox + (w - t) / 2, y + gap, t, h / 2 - t / 2 - gap);
    if (segs.includes('j')) g.rect(ox + (w - t) / 2, y + h / 2 + t / 2, t, h / 2 - t / 2 - gap);
    // Diagonals are clockwise parallelograms like the rects, so overlaps never cancel: k and o come from the top corners down
    // to the centre, q from the top-right to the centre-left, l from the top-right to the bottom-left, m from the centre to the
    // bottom-right, n from the top-left to the bottom-right.
    const diag = (x0: number, y0: number, x1: number, y1: number) => { g.moveTo(x0 - t / 2, y0); g.lineTo(x0 + t / 2, y0); g.lineTo(x1 + t / 2, y1); g.lineTo(x1 - t / 2, y1); g.closePath(); };
    const mid = y + h / 2;
    if (segs.includes('k')) diag(ox + w - t / 2, y + t, ox + w / 2, mid);
    if (segs.includes('o')) diag(ox + t / 2, y + t, ox + w / 2, mid);
    if (segs.includes('q')) diag(ox + w - t / 2, y + t, ox + t * 1.2, mid);
    if (segs.includes('l')) diag(ox + w - t / 2, y + t, ox + t / 2, y + h - t);
    if (segs.includes('m')) diag(ox + w * 0.45, mid, ox + w - t / 2, y + h - t);
    if (segs.includes('n')) diag(ox + t / 2, y + t, ox + w - t / 2, y + h - t);
  }
  g.fill();
}

const stencilWidth = (text: string, h: number) => text.length * (h * 0.52 + h * 0.15 * 1.6);

/** A tile of flat paint with a few specks worn out of it, so every marking looks scuffed by boots and tyres rather than printed. */
function wornPaint(g: CanvasRenderingContext2D, color: string, seed: number): CanvasPattern {
  const [c, p] = canvas(96);
  const rand = seeded(seed);
  p.fillStyle = color;
  p.fillRect(0, 0, 96, 96);
  p.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 90; i++) {
    p.globalAlpha = 0.45 + rand() * 0.5;
    p.fillRect(rand() * 96, rand() * 96, 1 + rand() * 3.5, 1 + rand() * 1.6);
  }
  return g.createPattern(c, 'repeat')!;
}

function blob(g: CanvasRenderingContext2D, rand: () => number, x: number, y: number, r: number) {
  const n = 9, pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU, k = r * (0.62 + rand() * 0.55);
    pts.push([x + Math.cos(a) * k * 1.25, y + Math.sin(a) * k]);
  }
  g.beginPath();
  g.moveTo((pts[0]![0] + pts[n - 1]![0]) / 2, (pts[0]![1] + pts[n - 1]![1]) / 2);
  for (let i = 0; i < n; i++) {
    const p = pts[i]!, q = pts[(i + 1) % n]!;
    g.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
  }
  g.closePath();
  g.fill();
}

function crack(g: CanvasRenderingContext2D, rand: () => number, x: number, y: number, len: number, depth: number) {
  let a = rand() * TAU;
  g.moveTo(x, y);
  const steps = 6 + Math.floor(rand() * 4);
  for (let i = 0; i < steps; i++) {
    a += (rand() - 0.5) * 1.1;
    x += Math.cos(a) * (len / steps);
    y += Math.sin(a) * (len / steps);
    g.lineTo(x, y);
    if (depth > 0 && rand() < 0.2) {
      const sx = x, sy = y;
      crack(g, rand, sx, sy, len * 0.4, depth - 1);
      g.moveTo(sx, sy);
    }
  }
}

function pathBetween(a: { x: number; y: number }, b: { x: number; y: number }, bendFirst: boolean): [number, number][] {
  return bendFirst ? [[a.x, a.y], [b.x, a.y], [b.x, b.y]] : [[a.x, a.y], [a.x, b.y], [b.x, b.y]];
}

function strokeRoute(g: CanvasRenderingContext2D, route: readonly [number, number][]) {
  g.beginPath();
  g.moveTo(route[0]![0], route[0]![1]);
  for (let i = 1; i < route.length; i++) g.lineTo(route[i]![0], route[i]![1]);
  g.stroke();
}

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export function paintFloor(g: CanvasRenderingContext2D, size: number, seed: number, plan?: FloorPlan) {
  const themed = plan && themeOf(plan.theme)?.floor;
  if (themed) return themed(g, size, seed, plan);
  const rand = seeded(seed);
  const slab = FLOOR.slab;
  g.fillStyle = FLOOR.base;
  g.fillRect(0, 0, size, size);

  // Slabs: each a shade lighter or darker, a touch warmer or cooler, so the ground has a calm patchwork rhythm.
  for (let y = 0; y < size; y += slab) {
    for (let x = 0; x < size; x += slab) {
      const k = (rand() - 0.5) * 2 * FLOOR.slabShift;
      g.fillStyle = k > 0 ? hexA(FLOOR.slabA, k * 20) : hexA(FLOOR.slabB, -k * 20);
      g.fillRect(x, y, slab, slab);
      const hue = rand();
      if (hue < 0.18) { g.fillStyle = 'rgba(110, 130, 160, 0.05)'; g.fillRect(x, y, slab, slab); }
      else if (hue > 0.86) { g.fillStyle = 'rgba(170, 120, 70, 0.06)'; g.fillRect(x, y, slab, slab); }
      // A patched slab: a newer pour with its own hard-edged border.
      if (rand() < 0.045) {
        const pw = 60 + rand() * 90, ph = 50 + rand() * 80, px = x + 20 + rand() * (slab - pw - 40), py = y + 20 + rand() * (slab - ph - 40);
        g.fillStyle = 'rgba(190, 180, 160, 0.06)';
        g.fillRect(px, py, pw, ph);
        g.strokeStyle = hexA(FLOOR.seam, 0.45);
        g.lineWidth = 2;
        g.strokeRect(px, py, pw, ph);
      }
    }
  }
  const area = (size * size) / 1_000_000;
  for (let i = 0; i < 20 * area; i++) blotch(g, rand() * size, rand() * size, 60 + rand() * 200, '30, 28, 24', 0.05 + rand() * 0.05);
  speckle(g, rand, size, 600 * area, FLOOR.grime, FLOOR.wear);

  // Saw-cut score lines inside each slab, and the slab joints themselves.
  g.fillStyle = hexA(FLOOR.seam, 0.2);
  for (let x = 80; x < size; x += 80) if (x % slab) g.fillRect(x - 0.5, 0, 1, size);
  for (let y = 80; y < size; y += 80) if (y % slab) g.fillRect(0, y - 0.5, size, 1);
  g.fillStyle = hexA(FLOOR.seam, 0.85);
  for (let x = slab; x < size; x += slab) g.fillRect(x - 1, 0, 2, size);
  for (let y = slab; y < size; y += slab) g.fillRect(0, y - 1, size, 2);
  // Joint filler: a dark dowel plate where four slabs meet.
  g.fillStyle = hexA(FLOOR.grime, 0.6);
  for (let y = slab; y < size; y += slab) for (let x = slab; x < size; x += slab) g.fillRect(x - 3, y - 3, 6, 6);

  if (!plan) return;
  const walls = plan.walls;
  const mid = { x: size / 2, y: size / 2 };

  // Soft light pools and hard-edged window light: warm areas on an otherwise even floor.
  const pool = (x: number, y: number, r: number, a: number) => blotch(g, x, y, r, '255, 226, 170', a);
  for (const z of plan.zones) pool(z.x, z.y, 340, 0.1);
  for (const p of plan.pads) { const c = center(p); pool(c.x, c.y, 260 + Math.max(p.w, p.h) * 0.4, 0.07); }
  if (plan.core) pool(plan.core.x, plan.core.y, 420, 0.11);
  const lightRand = seeded(seed ^ 0x1234);
  g.fillStyle = 'rgba(255, 236, 190, 0.03)';
  for (let i = 0; i < 16 * area; i++) {
    const x = lightRand() * size, y = lightRand() * size, w = 40 + lightRand() * 50, h = 120 + lightRand() * 200;
    g.beginPath();
    g.moveTo(x, y); g.lineTo(x + w, y); g.lineTo(x + w + h * 0.8, y + h); g.lineTo(x + h * 0.8, y + h);
    g.closePath();
    g.fill();
  }

  // Worn traffic: every pad and zone leads somewhere, and the ground remembers it.
  const nodes = [...plan.zones, ...(plan.core ? [plan.core] : [])];
  const routeRand = seeded(seed ^ 0x7777);
  const routes: [number, number][][] = [];
  const hubs = nodes.length ? nodes : [mid];
  for (const p of plan.pads) {
    const c = center(p);
    let best = hubs[0]!, bd = Infinity;
    for (const h of hubs) { const d = Math.hypot(h.x - c.x, h.y - c.y); if (d < bd) { bd = d; best = h; } }
    routes.push(pathBetween(c, best, routeRand() < 0.5));
  }
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) routes.push(pathBetween(nodes[i]!, nodes[j]!, routeRand() < 0.5));
  if (nodes.length) for (const n of nodes) routes.push(pathBetween(n, mid, routeRand() < 0.5));
  g.lineJoin = 'round';
  g.lineCap = 'round';
  for (const [w, a] of [[170, 0.05], [90, 0.06]] as const) {
    g.strokeStyle = `rgba(30, 26, 20, ${a})`;
    g.lineWidth = w;
    for (const r of routes) strokeRoute(g, r);
  }
  // Tyre ruts and a dashed lane line down the long straights.
  g.lineCap = 'butt';
  g.strokeStyle = 'rgba(22, 20, 16, 0.2)';
  g.lineWidth = 3;
  g.setLineDash([60, 24, 18, 40]);
  for (const r of routes) for (const off of [-24, 24]) strokeRoute(g, r.map(([x, y], i) => (i % 2 === 0 ? [x + off, y + off] : [x - off, y + off]) as [number, number]));
  g.setLineDash([]);
  const lane = wornPaint(g, FLOOR.paint, seed ^ 0x51);
  g.strokeStyle = lane;
  g.globalAlpha = 0.5;
  g.lineWidth = 5;
  g.setLineDash([44, 36]);
  for (const r of routes) strokeRoute(g, r);
  g.setLineDash([]);
  g.globalAlpha = 1;
  g.lineJoin = 'miter';

  // Oil stains, with a dark core and a hard rim.
  const oil = seeded(seed ^ 0x0112);
  for (let i = 0; i < 4 * area; i++) {
    const x = oil() * size, y = oil() * size, r = 12 + oil() * 24;
    g.fillStyle = 'rgba(14, 14, 18, 0.14)';
    blob(g, oil, x, y, r * 1.35);
    g.fillStyle = 'rgba(14, 14, 18, 0.24)';
    blob(g, oil, x + r * 0.1, y, r);
    g.fillStyle = 'rgba(10, 10, 14, 0.24)';
    blob(g, oil, x + r * 0.15, y + r * 0.1, r * 0.45);
  }

  // Painted markings: pads, zone rings and sector numbers.
  const white = wornPaint(g, '#928d7f', seed ^ 0x52); // worn paint: the floor's value plus 10 to 15 percent at half alpha, never near-white
  const ink = wornPaint(g, '#2b2e34', seed ^ 0x53);
  const mustard = wornPaint(g, FLOOR.paint, seed ^ 0x54);
  const hazardTile = (() => {
    const [c, p] = canvas(24);
    p.fillStyle = FLOOR.paint;
    p.fillRect(0, 0, 24, 24);
    p.fillStyle = '#2b2e34';
    p.beginPath();
    for (const o of [-24, 0, 24]) { p.moveTo(o, 24); p.lineTo(o + 12, 24); p.lineTo(o + 36, 0); p.lineTo(o + 24, 0); p.closePath(); }
    p.fill();
    return g.createPattern(c, 'repeat')!;
  })();
  for (const [i, pad] of plan.pads.entries()) {
    const tint = pad.team === 'red' ? FLOOR.red : pad.team === 'blue' ? FLOOR.blue : null;
    g.globalAlpha = 0.55;
    // A hazard band hugging the pad, a painted floor tint inside it, and bracket corners.
    const e = 16, b = 10;
    g.fillStyle = hazardTile;
    g.beginPath();
    g.rect(pad.x - e, pad.y - e, pad.w + e * 2, pad.h + e * 2);
    g.rect(pad.x - e + b, pad.y - e + b, pad.w + (e - b) * 2, pad.h + (e - b) * 2);
    g.fill('evenodd');
    g.globalAlpha = 0.16;
    g.fillStyle = tint ?? '#20242c';
    g.fillRect(pad.x, pad.y, pad.w, pad.h);
    g.globalAlpha = 0.75;
    g.fillStyle = tint ? wornPaint(g, tint, seed ^ (0x60 + i)) : mustard;
    const arm = Math.min(46, pad.w / 2, pad.h / 2), t = 7;
    for (const [cx, cy, sx, sy] of [[pad.x, pad.y, 1, 1], [pad.x + pad.w, pad.y, -1, 1], [pad.x, pad.y + pad.h, 1, -1], [pad.x + pad.w, pad.y + pad.h, -1, -1]] as const) {
      g.fillRect(Math.min(cx, cx + sx * arm), Math.min(cy, cy + sy * t), arm, t);
      g.fillRect(Math.min(cx, cx + sx * t), Math.min(cy, cy + sy * arm), t, arm);
    }
    g.globalAlpha = 1;
    const text = pad.team === 'red' ? `A${(i % 9) + 1}` : pad.team === 'blue' ? `b${(i % 9) + 1}` : `P${(i % 9) + 1}`;
    const th = Math.min(34, pad.h * 0.4, pad.w * 0.5);
    if (th >= 16) {
      const c = center(pad);
      g.globalAlpha = 0.5;
      g.fillStyle = white;
      stencil(g, text, c.x - stencilWidth(text, th) / 2, c.y - th / 2, th);
      g.globalAlpha = 1;
    }
  }

  for (const z of plan.zones) {
    const r = plan.zoneRadius;
    g.globalAlpha = 0.14;
    g.fillStyle = '#16181d';
    g.beginPath(); g.arc(z.x, z.y, r - 6, 0, TAU); g.fill();
    g.globalAlpha = 0.6;
    g.fillStyle = hazardTile;
    // Hazard ring in 24 segments with gaps, outside the live capture ring so the two never fight.
    for (let k = 0; k < 24; k++) {
      const a0 = (k / 24) * TAU + 0.03, a1 = ((k + 0.62) / 24) * TAU;
      g.beginPath();
      g.arc(z.x, z.y, r + 12, a0, a1);
      g.arc(z.x, z.y, r + 22, a1, a0, true);
      g.closePath();
      g.fill();
    }
    g.globalAlpha = 0.5;
    g.fillStyle = white;
    for (let k = 0; k < 4; k++) {
      g.save();
      g.translate(z.x, z.y);
      g.rotate((k * TAU) / 4);
      g.beginPath();
      g.moveTo(r + 44, 0); g.lineTo(r + 74, -20); g.lineTo(r + 74, -8); g.lineTo(r + 98, 0); g.lineTo(r + 74, 8); g.lineTo(r + 74, 20);
      g.closePath();
      g.restore();
      g.fill();
    }
    g.globalAlpha = 1;
  }
  if (plan.core) {
    const { x, y } = plan.core;
    g.globalAlpha = 0.5;
    g.fillStyle = hazardTile;
    for (let k = 0; k < 32; k++) {
      const a0 = (k / 32) * TAU, a1 = ((k + 0.58) / 32) * TAU;
      g.beginPath();
      g.arc(x, y, 150, a0, a1);
      g.arc(x, y, 164, a1, a0, true);
      g.closePath();
      g.fill();
    }
    g.fillStyle = ink;
    g.globalAlpha = 0.22;
    g.beginPath(); g.arc(x, y, 138, 0, TAU); g.arc(x, y, 128, 0, TAU, true); g.fill();
    g.globalAlpha = 1;
  }

  // Directional arrows and bays: big painted arrows along a few straights.
  const arr = seeded(seed ^ 0x999);
  g.fillStyle = white;
  g.globalAlpha = 0.5;
  for (let i = 0; i < (plan.calm || plan.decor ? 0 : 4 * area); i++) { // with decor, lane arrows come from decor.ts (real lanes, runs of two or three)
    const x = arr() * size, y = arr() * size, a = Math.floor(arr() * 4) * (Math.PI / 2);
    // Arrows keep clear of the decor's stencils and district plans (decor.ts `avoid`).
    if (plan.decor?.avoid.some((b) => Math.hypot(b.x - x, b.y - y) < b.r + 60)) continue;
    g.save();
    g.translate(x, y);
    g.rotate(a);
    g.beginPath();
    g.moveTo(-40, -9); g.lineTo(10, -9); g.lineTo(10, -22); g.lineTo(46, 0); g.lineTo(10, 22); g.lineTo(10, 9); g.lineTo(-40, 9);
    g.closePath();
    g.restore();
    g.fill();
  }
  g.globalAlpha = 1;

  // Cracks, long and thin, with the odd branch.
  const cr = seeded(seed ^ 0xc4ac);
  g.strokeStyle = 'rgba(20, 18, 14, 0.38)';
  g.lineWidth = 1.6;
  g.lineJoin = 'round';
  g.beginPath();
  for (let i = 0; i < 8 * area; i++) crack(g, cr, cr() * size, cr() * size, 60 + cr() * 140, 1);
  g.stroke();
  g.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  g.lineWidth = 1;
  g.lineJoin = 'miter';

  // Drains and manholes, rusting stains beneath them.
  const dr = seeded(seed ^ 0xd2a1);
  for (let i = 0; i < (plan.calm || plan.decor ? 0 : 3 * area); i++) { // with decor, a few drains along kerbs come from decor.ts
    const x = Math.round((dr() * size) / 50) * 50, y = Math.round((dr() * size) / 50) * 50 + 0.5, grate = dr() < 0.55;
    g.fillStyle = 'rgba(138, 90, 56, 0.16)';
    blob(g, dr, x + 14, y + 30, 38);
    if (grate) {
      g.fillStyle = '#2b2e34';
      g.fillRect(x - 24, y - 15, 48, 30);
      g.fillStyle = '#4a4f59';
      for (let k = 0; k < 6; k++) g.fillRect(x - 20 + k * 7.5, y - 11, 3.4, 22);
      g.strokeStyle = FLOOR.ink;
      g.lineWidth = 2;
      g.strokeRect(x - 24, y - 15, 48, 30);
    } else {
      g.fillStyle = '#464a53';
      g.beginPath(); g.arc(x, y, 18, 0, TAU); g.fill();
      g.strokeStyle = FLOOR.ink;
      g.lineWidth = 2;
      g.stroke();
      g.strokeStyle = 'rgba(20, 22, 28, 0.55)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(x, y, 11, 0, TAU);
      g.moveTo(x - 11, y); g.lineTo(x + 11, y);
      g.moveTo(x, y - 11); g.lineTo(x, y + 11);
      g.stroke();
    }
  }

  // Litter: it gathers against walls like it does in real life, and thinly across open ground.
  const lit = seeded(seed ^ 0x1177);
  const heavy = walls.length ? walls : [{ x: 0, y: 0, w: size, h: size }];
  const total = Math.floor(210 * area);
  g.globalAlpha = 0.6; // quiet: players must pop against the floor
  for (let i = 0; i < total; i++) {
    let x = lit() * size, y = lit() * size;
    if (lit() < 0.5) {
      const w = heavy[Math.floor(lit() * heavy.length)]!;
      const side = Math.floor(lit() * 4), t = lit(), o = 4 + lit() * 26;
      x = side === 0 ? w.x + w.w * t : side === 1 ? w.x + w.w * t : side === 2 ? w.x - o : w.x + w.w + o;
      y = side === 0 ? w.y - o : side === 1 ? w.y + w.h + o : w.y + w.h * t;
      if (side === 3) { x += 12; y += 8; }
    }
    const kind = lit(), a = lit() * TAU;
    g.save();
    g.translate(x, y);
    g.rotate(a);
    if (kind < 0.3) {
      g.fillStyle = 'rgba(150, 144, 130, 0.5)';
      g.beginPath(); g.ellipse(0, 0, 2.6 + lit() * 2, 2 + lit() * 1.5, 0, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255, 255, 255, 0.35)';
      g.fillRect(-1.2, -1.4, 1.6, 1);
    } else if (kind < 0.5) {
      g.fillStyle = 'rgba(214, 208, 190, 0.8)';
      g.fillRect(-4, -3, 8 + lit() * 4, 5 + lit() * 3);
      g.fillStyle = 'rgba(30, 28, 24, 0.4)';
      g.fillRect(-3, -1, 6, 0.8);
    } else if (kind < 0.62) {
      g.fillStyle = 'rgba(40, 42, 48, 0.55)';
      g.beginPath(); g.arc(0, 0, 3, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(200, 200, 205, 0.5)';
      g.lineWidth = 0.8;
      g.stroke();
    } else if (kind < 0.78) {
      g.fillStyle = 'rgba(34, 32, 28, 0.6)';
      g.beginPath(); g.moveTo(-5, 1); g.lineTo(-1, -4); g.lineTo(5, -2); g.lineTo(4, 3); g.lineTo(-2, 4); g.closePath(); g.fill();
      g.fillStyle = 'rgba(170, 164, 148, 0.55)';
      g.beginPath(); g.moveTo(-1, -4); g.lineTo(5, -2); g.lineTo(2, 0); g.closePath(); g.fill();
    } else if (kind < 0.88) {
      g.fillStyle = 'rgba(178, 104, 62, 0.8)';
      g.fillRect(-5, -2, 10, 3.6);
      g.fillStyle = 'rgba(240, 235, 220, 0.7)';
      g.fillRect(-1, -2, 2, 3.6);
    } else if (kind < 0.95) {
      g.fillStyle = 'rgba(36, 33, 29, 0.6)';
      g.fillRect(-9, -0.8, 18, 1.6);
      g.fillRect(6, -2.6, 3, 5);
    } else {
      // A pale chalk X from somebody's tally.
      g.strokeStyle = 'rgba(220, 214, 196, 0.6)';
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(-6, -6); g.lineTo(6, 6); g.moveTo(6, -6); g.lineTo(-6, 6); g.stroke();
    }
    g.restore();
  }
  g.globalAlpha = 1;

  // The map's edge: grime gathers along the hazard curb, and the ground fades toward it.
  const rim = 150;
  for (const [x0, y0, x1, y1, rx, ry, rw, rh] of [
    [0, 0, 0, rim, 0, 0, size, rim], [0, size, 0, size - rim, 0, size - rim, size, rim],
    [0, 0, rim, 0, 0, 0, rim, size], [size, 0, size - rim, 0, size - rim, 0, rim, size],
  ] as const) {
    const grad = g.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, 'rgba(16, 14, 12, 0.45)');
    grad.addColorStop(0.35, 'rgba(16, 14, 12, 0.16)');
    grad.addColorStop(1, 'rgba(16, 14, 12, 0)');
    g.fillStyle = grad;
    g.fillRect(rx, ry, rw, rh);
  }
  g.fillStyle = mustard;
  g.globalAlpha = 0.45;
  const line = 40, th = 6;
  g.fillRect(line, line, size - line * 2, th);
  g.fillRect(line, size - line - th, size - line * 2, th);
  g.fillRect(line, line, th, size - line * 2);
  g.fillRect(size - line - th, line, th, size - line * 2);
  g.globalAlpha = 1;
  if (plan.decor) paintDecor(g, plan.decor);
}
