/**
 * Marks every doorway (doorways.ts) so it reads at a glance from any side, not only through a south wall's front face:
 *  - on the floor, a worn passage through the wall, a steel sill at each face and, outside a building, a doormat;
 *  - a door-frame jamb at each side of the opening, standing a step proud of the wall top and of both its faces;
 *  - from outside, a notch in the roof's edge over the opening, so the frame and the door show through it (geoart.ts `drawRoofs`).
 * Each floor and each jamb is baked into its own small sprite the first time it comes into view, then stamped each frame; nothing here is
 * painted per frame but the roof notch's rim. The world's lighting pass lights the sprites like every other wall.
 */
import type { Pt } from '../shared/geom.ts';
import type { MapDef } from '../shared/maps.ts';
import { doorwaysOf, type Doorway } from './doorways.ts';
import { INK } from './palette.ts';
import { FACE, LIGHT, type SolidKind } from './tilt.ts';

type View = { x0: number; y0: number; x1: number; y1: number };
type Look = { top: string; front: string; lit: string; shade: string };

/** Sprite resolution: jambs at twice the world's, so their ink stays crisp under the closest zoom; floors at the world's own (the ground under them is baked at half). */
const SCALE = 2, FLOOR_SCALE = 1;
/** How far a jamb reaches along the wall (into the wall, and into the opening), how far it stands proud of each face, and how high above the wall top. */
const JAMB = { inWall: 11, inOpening: 3, proud: 5, lift: 7 } as const;
/** How far past the outer face the roof notch cuts, to take the roof's own lip with it. */
const NOTCH_OUT = 14;

const STEEL: Look = { top: '#8a929e', front: '#3d4450', lit: '#b9c1cc', shade: '#5f6773' };
const TIMBER: Look = { top: '#9a6a3c', front: '#4f321a', lit: '#c08e5a', shade: '#6e4a2a' };
const SILL = { top: '#4f5560', lit: '#8d95a1' } as const;
const MAT = { field: '#7a6a4c', border: '#56492f', weave: 'rgba(28,31,38,0.28)' } as const;
/** Gaps (no door) take a frame in the stuff the theme builds in. */
const TIMBER_THEMES = new Set(['park', 'summit', 'market', 'wasteland']);

const lookFor = (map: MapDef, d: Doorway): Look => {
  const door = d.door ? map.doors?.find((x) => x.id === d.door) : undefined;
  if (door) return door.material === 'wood' ? TIMBER : STEEL;
  return TIMBER_THEMES.has(map.theme ?? '') ? TIMBER : STEEL;
};

/** The along-wall unit vector and the opening's width. */
const frame = (d: Doorway) => {
  const len = Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y);
  return { t: { x: (d.b.x - d.a.x) / len, y: (d.b.y - d.a.y) / len }, len };
};
/** The point `s` px along the wall from `a` and `k` px out of the building from the outer face. */
const at = (d: Doorway, t: Pt, s: number, k: number): Pt => ({ x: d.a.x + t.x * s + d.n.x * k, y: d.a.y + t.y * s + d.n.y * k });
/** A quad from wall distance s0..s1 and outward distance k0..k1. */
const quad = (d: Doorway, t: Pt, s0: number, s1: number, k0: number, k1: number): Pt[] => [at(d, t, s0, k0), at(d, t, s1, k0), at(d, t, s1, k1), at(d, t, s0, k1)];

const inPoly = (p: Pt, pts: readonly Pt[]): boolean => {
  let r = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!, b = pts[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r;
  }
  return r;
};
const trace = (g: CanvasRenderingContext2D, pts: readonly Pt[]) => {
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.closePath();
};
const positive = (pts: Pt[]): Pt[] => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i]!, q = pts[(i + 1) % pts.length]!; a += p.x * q.y - q.x * p.y; }
  return a < 0 ? pts.reverse() : pts;
};
const bounds = (pts: readonly Pt[], pad: number) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x: Math.floor(x0 - pad), y: Math.floor(y0 - pad), w: Math.ceil(x1 - x0 + 2 * pad), h: Math.ceil(y1 - y0 + 2 * pad) };
};
/** A small seeded random source, so a doorway's scuffs and mat sit the same way every time. */
const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

function bake(box: { x: number; y: number; w: number; h: number }, scale: number, paint: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(box.w * scale));
  c.height = Math.max(1, Math.ceil(box.h * scale));
  const g = c.getContext('2d')!;
  g.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
  g.lineJoin = 'round';
  paint(g);
  return c;
}

/** The floor of one doorway: a worn passage, boot scuffs, a steel sill at each face and a doormat outside. */
function paintFloor(g: CanvasRenderingContext2D, d: Doorway) {
  const { t, len } = frame(d);
  const D = d.depth;
  const rnd = seeded(Math.round(d.a.x * 7 + d.a.y * 13));
  // The passage is a step darker than open floor, so it reads as a way through rather than more wall top.
  trace(g, quad(d, t, 0, len, 0, -D));
  g.fillStyle = 'rgba(16,18,24,0.22)';
  g.fill();
  // Boots wear the floor pale along the way in.
  g.strokeStyle = 'rgba(226,220,203,0.11)';
  g.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    const s = len * (0.22 + 0.56 * rnd()), k0 = 18 + 14 * rnd(), k1 = -D - 6 - 14 * rnd();
    g.lineWidth = 2 + 2 * rnd();
    g.beginPath();
    const p = at(d, t, s, k0), q = at(d, t, s + (rnd() - 0.5) * 10, k1);
    g.moveTo(p.x, p.y); g.lineTo(q.x, q.y);
    g.stroke();
  }
  // A steel sill across each face of the wall; the outer one is the broader step.
  const sill = (k0: number, k1: number) => {
    const pts = quad(d, t, 0, len, k0, k1);
    trace(g, pts);
    g.fillStyle = SILL.top;
    g.fill();
    g.strokeStyle = SILL.lit;
    g.lineWidth = 1.5;
    const p = at(d, t, 1, (k0 + k1) / 2 + (k0 > k1 ? 1 : -1)), q = at(d, t, len - 1, (k0 + k1) / 2 + (k0 > k1 ? 1 : -1));
    g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
    trace(g, pts);
    g.strokeStyle = INK;
    g.lineWidth = 1.5;
    g.stroke();
  };
  sill(d.outside ? 1 : 0, d.outside ? -8 : -5);
  sill(-D + (d.outside ? 4 : 5), -D);
  if (!d.outside) return;
  // A coir doormat outside, laid a touch crooked.
  const mw = Math.min(len - 22, 104), mh = 26, k = 8 + mh / 2;
  const tilt = (rnd() - 0.5) * 0.08;
  const c = at(d, t, len / 2, k);
  g.save();
  g.translate(c.x, c.y);
  g.rotate(Math.atan2(t.y, t.x) + tilt);
  g.fillStyle = MAT.field;
  g.fillRect(-mw / 2, -mh / 2, mw, mh);
  g.strokeStyle = MAT.weave;
  g.lineWidth = 1;
  for (let x = -mw / 2 + 6; x < mw / 2 - 4; x += 5) { g.beginPath(); g.moveTo(x, -mh / 2 + 4); g.lineTo(x + 2, mh / 2 - 4); g.stroke(); }
  g.strokeStyle = MAT.border;
  g.lineWidth = 3;
  g.strokeRect(-mw / 2 + 2.5, -mh / 2 + 2.5, mw - 5, mh - 5);
  g.strokeStyle = INK;
  g.lineWidth = 1.5;
  g.strokeRect(-mw / 2, -mh / 2, mw, mh);
  g.restore();
}

/** A footprint raised `lift` px above its place with `face` px of front face below, cel bands and an ink outline: one jamb. */
function paintPost(g: CanvasRenderingContext2D, foot: Pt[], face: number, lift: number, l: Look) {
  const pts = positive(foot.map((p) => ({ x: p.x, y: p.y - lift })));
  g.lineWidth = 2;
  g.strokeStyle = INK;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
    if (!(b.x < a.x - 0.5)) continue;
    g.beginPath();
    g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.lineTo(b.x, b.y + face + lift); g.lineTo(a.x, a.y + face + lift);
    g.closePath();
    g.fillStyle = l.front;
    g.fill();
    g.stroke();
  }
  trace(g, pts);
  g.fillStyle = l.top;
  g.fill();
  g.save();
  g.clip();
  g.lineWidth = 5;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
    // The key light's cel steps, as geoart.ts gives every top: edges toward the light catch it, the far ones fall into shade.
    const len = Math.hypot(b.x - a.x, b.y - a.y), facing = ((b.y - a.y) * LIGHT.x - (b.x - a.x) * LIGHT.y) / (len || 1);
    if (Math.abs(facing) < 0.35) continue;
    g.strokeStyle = facing < 0 ? l.lit : l.shade;
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  }
  g.restore();
  trace(g, pts);
  g.strokeStyle = INK;
  g.lineWidth = 2;
  g.stroke();
}

/** The two jambs' footprints: across the whole wall and a step past each face. */
function jambFeet(d: Doorway): Pt[][] {
  const { t, len } = frame(d);
  const k0 = JAMB.proud, k1 = -d.depth - JAMB.proud;
  return [quad(d, t, -JAMB.inWall, JAMB.inOpening, k0, k1), quad(d, t, len - JAMB.inOpening, len + JAMB.inWall, k0, k1)];
}

const wallFace = (d: Doorway): number => d.wall.height ?? FACE[d.wall.material as SolidKind] ?? 16;

/** One baked piece: where it goes in the world and how to paint it, baked the first time it comes into view. */
type Piece = { x: number; y: number; w: number; h: number; scale: number; paint: (g: CanvasRenderingContext2D) => void; c?: HTMLCanvasElement | null };
type Baked = { floor: Piece; posts: Piece[] };
const BAKED = new WeakMap<MapDef, Baked[]>();

function baked(map: MapDef): Baked[] {
  let out = BAKED.get(map);
  if (out) return out;
  out = doorwaysOf(map).map((d) => {
    const { t, len } = frame(d);
    const face = wallFace(d), l = lookFor(map, d);
    // The farther jamb first, so the nearer one's top covers its face.
    const feet = jambFeet(d).sort((p, q) => Math.max(...p.map((v) => v.y)) - Math.max(...q.map((v) => v.y)));
    return {
      floor: { ...bounds(quad(d, t, -8, len + 8, 44, -d.depth - 26), 4), scale: FLOOR_SCALE, paint: (g) => paintFloor(g, d) },
      posts: feet.map((f) => {
        const b = bounds(f, 4);
        return { x: b.x, y: b.y - JAMB.lift, w: b.w, h: b.h + JAMB.lift + face + 4, scale: SCALE, paint: (g: CanvasRenderingContext2D) => paintPost(g, f, face, JAMB.lift, l) };
      }),
    };
  });
  BAKED.set(map, out);
  return out;
}

function stamp(g: CanvasRenderingContext2D, p: Piece, v: View) {
  if (p.x + p.w < v.x0 || p.x > v.x1 || p.y + p.h < v.y0 || p.y > v.y1) return;
  if (p.c === undefined) p.c = bake(p, p.scale, p.paint);
  if (p.c) g.drawImage(p.c, p.x, p.y, p.w, p.h);
}

/** Doorway floors in view: over the ground, under every wall, shadow and body. */
export function drawDoorwayFloors(g: CanvasRenderingContext2D, map: MapDef, view: View): void {
  for (const b of baked(map)) stamp(g, b.floor, view);
}

/** Doorway jambs in view: over the walls, under the doors. */
export function drawDoorwayJambs(g: CanvasRenderingContext2D, map: MapDef, view: View): void {
  for (const b of baked(map)) for (const p of b.posts) stamp(g, p, view);
}

const NOTCHES = new WeakMap<MapDef, Map<string, Pt[][]>>();
/** The notches to cut in one roof's edge: over each opening that leads in from outside, its jambs and the roof's lip. */
export function roofNotches(map: MapDef, roofId: string): readonly Pt[][] {
  let byRoof = NOTCHES.get(map);
  if (!byRoof) {
    byRoof = new Map();
    for (const d of doorwaysOf(map)) {
      const roof = d.outside ? map.roofs?.find((r) => r.id === d.roof) : undefined;
      if (!roof) continue;
      const { t, len } = frame(d);
      // A round roof can bulge past a door set in a chord of its wall: cut out to where the roof ends, then past its lip.
      let reach = 0;
      while (reach < 80 && [0, len / 2, len].some((s) => inPoly(at(d, t, s, reach), roof.points))) reach += 2;
      (byRoof.get(roof.id) ?? byRoof.set(roof.id, []).get(roof.id)!).push(quad(d, t, -JAMB.inWall, len + JAMB.inWall, reach + NOTCH_OUT, -d.depth));
    }
    NOTCHES.set(map, byRoof);
  }
  return byRoof.get(roofId) ?? [];
}

/** Clips everything after it to outside the notches (call inside a save, before painting the roof). */
export function clipNotches(g: CanvasRenderingContext2D, notches: readonly Pt[][], box: { x0: number; y0: number; x1: number; y1: number }): void {
  if (!notches.length) return;
  g.beginPath();
  g.rect(box.x0 - 60, box.y0 - 60, box.x1 - box.x0 + 120, box.y1 - box.y0 + 120);
  for (const q of notches) { g.moveTo(q[0]!.x, q[0]!.y); for (let i = 1; i < q.length; i++) g.lineTo(q[i]!.x, q[i]!.y); g.closePath(); }
  g.clip('evenodd');
}

/**
 * The roof's cut edge round each notch: the roof's thickness hanging into it below any edge the roof lies north of, a shade band where the
 * roof overhangs it, and an ink line. Its three cut edges are the notch's sides and its inner end (the quad's 1-2, 2-3 and 3-0 edges).
 */
export function drawNotchRims(g: CanvasRenderingContext2D, notches: readonly Pt[][]): void {
  for (const q of notches) {
    const edges: [Pt, Pt][] = [[q[1]!, q[2]!], [q[2]!, q[3]!], [q[3]!, q[0]!]];
    const cy = (q[0]!.y + q[2]!.y) / 2;
    g.save();
    trace(g, q);
    g.clip();
    g.lineCap = 'butt';
    for (const [a, b] of edges) {
      // The roof lies on the far side of this edge from the notch's centre.
      const my = (a.y + b.y) / 2;
      const roofNorth = my < cy - 1 && Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
      g.strokeStyle = 'rgba(14,16,22,0.30)';
      g.lineWidth = 12;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      if (roofNorth) {
        g.fillStyle = 'rgba(22,24,30,0.78)';
        g.fillRect(Math.min(a.x, b.x), my, Math.abs(b.x - a.x), 8);
      }
    }
    g.restore();
    g.beginPath();
    for (const [a, b] of edges) { g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); }
    g.strokeStyle = INK;
    g.lineWidth = 2;
    g.lineCap = 'round';
    g.stroke();
  }
}
