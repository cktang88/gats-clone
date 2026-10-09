/**
 * Draws a map's polygons, doors and roofs, and feeds them to the lighting pass. The generic look follows docs/art/STYLE.md: a top face that is the
 * collision footprint, a darker front face hanging below every south-facing edge, two hard cel steps and an ink outline. A theme may paint any of
 * them itself through the hooks on `Theme` (see themes/registry.ts); returning true from a hook means "drawn".
 */
import { doorLeaves, type DoorLeaf, type DoorView } from '../shared/sim/doors.ts';
import { unflat, type MapDoor, type MapPoly, type MapRoof, type Pt } from '../shared/geom.ts';
import type { MapDef } from '../shared/maps.ts';
import { polyParts } from '../shared/mapgeo.ts';
import type { Occluder } from './lighting.ts';
import { setLight } from './lighting.ts';
import { INK } from './palette.ts';
import { LIGHT } from './tilt.ts';
import { themeOf } from './themes/registry.ts';
import { kitShadowed } from './vehicleshadow.ts';
import { paintRoofMaterial } from './roofart.ts';
import { clipNotches, drawNotchRims, roofNotches } from './doorwayart.ts';

export type GeoView = { x0: number; y0: number; x1: number; y1: number };
export type PolyLook = { top: string; front: string; lit: string; shade: string };
export type GeoInfo = { now: number; view: GeoView; dark: number; map: MapDef };

const mixHex = (hex: string, to: number, t: number): string => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (to - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};
const look = (top: string): PolyLook => ({ top, front: mixHex(top, 0, 0.42), lit: mixHex(top, 255, 0.24), shade: mixHex(top, 0, 0.3) });

const TOPS: Record<string, string> = {
  fuselage: '#9aa4b2', hull: '#5d7479', tank: '#8c949f', boxcar: '#8a4a3a', kiosk: '#b4a07a', concrete: '#78808c', steel: '#808a99',
  rock: '#7d776a', wood: '#9b6a3b', glass: '#8fb4b6', sandstone: '#b4a07a', brick: '#8a4a3a',
};
const LOOKS = new Map<string, PolyLook>();
export function lookOf(material: string): PolyLook {
  let l = LOOKS.get(material);
  if (!l) LOOKS.set(material, (l = look(TOPS[material] ?? TOPS.steel!)));
  return l;
}

/** The debug overlay: `?geo=1` in the address or `localStorage.skirmishGeo = '1'`. */
export const geoDebug = (): boolean => {
  try { return /[?&]geo=1/.test(location.search) || localStorage.getItem('skirmishGeo') === '1'; } catch { return false; }
};

type Shape = { poly: MapPoly; pts: Pt[]; x0: number; y0: number; x1: number; y1: number; area: number };
const SHAPES = new WeakMap<MapPoly, Shape>();
function shapeOf(poly: MapPoly): Shape {
  let s = SHAPES.get(poly);
  if (!s) {
    let a = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const p = poly.points;
    for (let i = 0; i < p.length; i++) {
      const q = p[i]!, r = p[(i + 1) % p.length]!;
      a += q.x * r.y - r.x * q.y;
      x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
    }
    s = { poly, pts: a < 0 ? [...p].reverse() : [...p], x0, y0, x1, y1, area: Math.abs(a / 2) };
    SHAPES.set(poly, s);
  }
  return s;
}

const trace = (g: CanvasRenderingContext2D, pts: readonly Pt[]) => {
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.closePath();
};

/** South-facing edges of a positive-area polygon: the ones that run leftward on screen. */
const southEdges = (pts: readonly Pt[]): [Pt, Pt][] => {
  const out: [Pt, Pt][] = [];
  for (let i = 0; i < pts.length; i++) { const a = pts[i]!, b = pts[(i + 1) % pts.length]!; if (b.x < a.x - 0.5) out.push([a, b]); }
  return out;
};

/** The front face under every south edge. */
function drawFront(g: CanvasRenderingContext2D, pts: readonly Pt[], h: number, l: PolyLook) {
  if (h <= 0) return;
  g.fillStyle = l.front;
  g.strokeStyle = INK;
  g.lineWidth = 2;
  g.lineJoin = 'round';
  for (const [a, b] of southEdges(pts)) {
    g.beginPath();
    g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.lineTo(b.x, b.y + h); g.lineTo(a.x, a.y + h);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(a.x, a.y + h); g.lineTo(b.x, b.y + h);
    g.stroke();
  }
}

/** Taller tops are a step brighter than the floor and than low cover: a pale wash over the path just traced. */
function liftTop(g: CanvasRenderingContext2D, h: number) {
  if (h <= 14) return;
  g.fillStyle = `rgba(255, 246, 228, ${(0.09 + 0.17 * Math.min(1, (h - 14) / 44)).toFixed(3)})`;
  g.fill();
}

/** The top face: flat paint, a light band on edges that face the light, a dark band on the far ones, an ink outline. */
function drawTop(g: CanvasRenderingContext2D, pts: readonly Pt[], l: PolyLook, alpha = 1, h = 0) {
  g.save();
  g.globalAlpha *= alpha;
  trace(g, pts);
  g.fillStyle = l.top;
  g.fill();
  liftTop(g, h);
  g.clip();
  g.lineWidth = 8;
  g.lineCap = 'butt';
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1) continue;
    const facing = ((b.y - a.y) * LIGHT.x - (b.x - a.x) * LIGHT.y) / len;
    if (Math.abs(facing) < 0.35) continue;
    g.strokeStyle = facing < 0 ? l.lit : l.shade;
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  }
  g.restore();
  trace(g, pts);
  g.strokeStyle = INK;
  g.lineWidth = 2;
  g.lineJoin = 'round';
  g.stroke();
}

/** A solid prism in the game's three-quarter view: the shape is the footprint, `h` px of front face hang below its south edges. */
export function drawExtruded(g: CanvasRenderingContext2D, pts: readonly Pt[], h: number, l: PolyLook): void {
  drawFront(g, pts, h, l);
  drawTop(g, pts, l);
}

const touches = (s: Shape, v: GeoView, pad: number) => s.x1 >= v.x0 - pad && s.x0 <= v.x1 + pad && s.y1 >= v.y0 - pad && s.y0 <= v.y1 + pad + 80;

/** Every polygon on the map in view. Taller ones are drawn after shorter ones of a group, and groups from north to south. */
export function drawPolys(g: CanvasRenderingContext2D, info: GeoInfo): void {
  const polys = info.map.polys;
  if (!polys?.length) return;
  const theme = themeOf(info.map.theme);
  const shapes = polys.map(shapeOf).filter((s) => touches(s, info.view, 40));
  if (!shapes.length) return;
  g.save();
  g.lineJoin = 'round';
  // Contact shade hugging every base, then the cast shadow: the footprint (lowered by the front face) swept along the key light, one flat dark fill.
  const cast = shapes.filter((s) => (s.poly.height ?? 14) > 0 && !kitShadowed(s.poly));
  g.strokeStyle = 'rgba(10,12,18,0.10)';
  g.lineWidth = 16;
  for (const s of cast) { trace(g, s.pts.map((p) => ({ x: p.x, y: p.y + (s.poly.height ?? 14) * 0.5 }))); g.stroke(); }
  g.strokeStyle = 'rgba(10,12,18,0.16)';
  g.lineWidth = 7;
  for (const s of cast) { trace(g, s.pts.map((p) => ({ x: p.x, y: p.y + (s.poly.height ?? 14) * 0.5 }))); g.stroke(); }
  g.fillStyle = 'rgba(10,12,18,0.34)';
  g.beginPath();
  for (const s of cast) {
    const h = s.poly.height ?? 14, len = Math.min(120, h * 1.8);
    const vx = LIGHT.x * len, vy = h + LIGHT.y * len, n = s.pts.length;
    s.pts.forEach((p, i) => (i ? g.lineTo(p.x + vx, p.y + vy) : g.moveTo(p.x + vx, p.y + vy)));
    g.closePath();
    for (let i = 0; i < n; i++) {
      const a = s.pts[i]!, b = s.pts[(i + 1) % n]!;
      const sign = (b.x - a.x) * vy - (b.y - a.y) * vx;
      // Every subpath wound the same way, so one nonzero fill is the union.
      if (sign >= 0) { g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.lineTo(b.x + vx, b.y + vy); g.lineTo(a.x + vx, a.y + vy); }
      else { g.moveTo(a.x, a.y); g.lineTo(a.x + vx, a.y + vy); g.lineTo(b.x + vx, b.y + vy); g.lineTo(b.x, b.y); }
      g.closePath();
    }
  }
  g.fill('nonzero');
  g.restore();
  const groups = new Map<string, Shape[]>();
  shapes.forEach((s, i) => { const k = s.poly.group ?? `#${i}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(s); });
  const ordered = [...groups.values()].sort((a, b) => Math.max(...a.map((s) => s.y1)) - Math.max(...b.map((s) => s.y1)));
  for (const group of ordered) {
    if (theme?.drawSetPiece?.(g, group.map((s) => s.poly), info)) continue;
    const mine = group.filter((s) => {
      if (!theme?.drawPoly?.(g, s.poly, info)) return true;
      // A theme's own top gets the same lift, so it stands off the floor like every other raised top.
      if (s.poly.material !== 'glass') { trace(g, s.pts); liftTop(g, s.poly.height ?? 14); }
      return false;
    });
    mine.sort((a, b) => (a.poly.height ?? 14) - (b.poly.height ?? 14));
    for (const s of mine) drawFront(g, s.pts, s.poly.height ?? 14, lookOf(s.poly.material));
    for (const s of mine) drawTop(g, s.pts, lookOf(s.poly.material), 1, s.poly.height ?? 14);
  }
}

/** The convex parts of the map's polygons in view as lighting occluders (shadow casters); polygons that do not block sight cast none. */
export function polyOccluders(map: MapDef, view: GeoView): Occluder[] {
  const polys = map.polys;
  if (!polys?.length) return [];
  const out: Occluder[] = [];
  for (const p of polyParts(map)) {
    if (p.ns || p.x + p.w < view.x0 || p.x > view.x1 || p.y + p.h + 90 < view.y0 || p.y > view.y1) continue;
    out.push({ x: p.x, y: p.y, w: p.w, h: p.h, face: polys[p.pid]?.height ?? 14, pts: p.pts });
  }
  return out;
}

// ---- doors ----

type Anim = { shown: number; vel: number; sign: 1 | -1; at: number };
const ANIMS = new Map<string, Anim>();

/** Where each door is drawn this frame (0..~275), eased from the server's value: sliders settle smoothly, swing leaves overshoot a touch and settle. */
export function doorShown(map: MapDef, views: readonly DoorView[] | undefined, now: number): { d: MapDoor; open: number; sign: 1 | -1 }[] {
  const doors = map.doors;
  if (!doors?.length) return [];
  const byIdx = new Map((views ?? []).map((v) => [v[0], v] as const));
  return doors.map((d, i) => {
    const key = `${map.name}:${d.id}`;
    const v = byIdx.get(i);
    const target = v?.[1] ?? 0;
    let a = ANIMS.get(key);
    if (!a || now < a.at) { a = { shown: target, vel: 0, sign: v?.[2] ?? d.side ?? 1, at: now }; ANIMS.set(key, a); }
    if (v) a.sign = v[2];
    const dt = Math.min(0.05, Math.max(0, (now - a.at) / 1000));
    a.at = now;
    const swing = d.kind === 'swing' || d.kind === 'double-swing';
    const w = swing ? 15 : 24, zeta = swing ? 0.69 : 1;
    // Normalised spring toward the server's value.
    const x = a.shown / 255, tx = target / 255;
    a.vel += (w * w * (tx - x) - 2 * zeta * w * a.vel) * dt;
    const nx = x + a.vel * dt;
    a.shown = Math.max(0, Math.min(swing ? 1.07 : 1, nx)) * 255;
    if (a.shown <= 0 && a.vel < 0) a.vel = 0;
    if (Math.abs(a.shown - target) < 0.4 && Math.abs(a.vel) < 0.01) { a.shown = target; a.vel = 0; }
    return { d, open: a.shown, sign: a.sign };
  });
}

const DOOR_LOOKS: Record<string, PolyLook> = {
  metal: { top: '#9aa4b2', front: '#4a5361', lit: '#b9c2cf', shade: '#6a7380' },
  wood: { top: '#a8743f', front: '#5a3a1e', lit: '#c28d58', shade: '#7e5330' },
  glass: { top: 'rgba(170,214,232,0.5)', front: 'rgba(90,130,150,0.45)', lit: 'rgba(225,244,252,0.75)', shade: 'rgba(110,160,180,0.55)' },
};
const FRAME_LOOK = look('#5b616c');
export const DOOR_HEIGHT = 22;

const leafPts = (l: DoorLeaf): Pt[] => (l.pts ? unflat(l.pts) : [{ x: l.x, y: l.y }, { x: l.x + l.w, y: l.y }, { x: l.x + l.w, y: l.y + l.h }, { x: l.x, y: l.y + l.h }]);

/** Doors in view: frame posts, the sliding track, leaves at their eased openness, and the light that leaks from an open door. */
export function drawDoors(g: CanvasRenderingContext2D, info: GeoInfo, views: readonly DoorView[] | undefined): void {
  const theme = themeOf(info.map.theme);
  for (const { d, open, sign } of doorShown(info.map, views, info.now)) {
    const h = d.axis === 'h';
    const x1 = d.x + (h ? d.w : 0), y1 = d.y + (h ? 0 : d.w);
    if (Math.max(d.x, x1) < info.view.x0 - 60 || Math.min(d.x, x1) > info.view.x1 + 60 || Math.max(d.y, y1) < info.view.y0 - 60 || Math.min(d.y, y1) > info.view.y1 + 90) continue;
    const t = d.thick ?? 12;
    const leaves = doorLeaves(d, open, sign);
    const f = Math.min(1, open / 255);
    if (theme?.door?.(g, d, leaves, f, info)) continue;
    // The light of the room it opens into.
    if (d.glow && f > 0.05) {
      const cx = (d.x + x1) / 2, cy = (d.y + y1) / 2;
      setLight(`door:${info.map.name}:${d.id}`, { x: cx, y: cy, radius: 190, color: d.glow, intensity: 0.55 * f, size: 14, inside: 60 });
      g.save();
      g.globalCompositeOperation = 'lighter';
      const gr = g.createRadialGradient(cx, cy, 6, cx, cy, 130);
      gr.addColorStop(0, d.glow); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = 0.16 * f * (1 - 0.6 * info.dark);
      g.fillStyle = gr;
      g.fillRect(cx - 130, cy - 130, 260, 260);
      g.restore();
    }
    if (d.kind === 'slide' || d.kind === 'double-slide') {
      g.strokeStyle = 'rgba(10,12,18,0.5)';
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(d.x, d.y); g.lineTo(x1, y1); g.stroke();
    }
    const l = DOOR_LOOKS[d.material] ?? DOOR_LOOKS.metal!;
    const glass = d.material === 'glass';
    for (const leaf of leaves) {
      const pts = leafPts(leaf);
      if (glass) { drawFront(g, pts, 10, l); drawTop(g, pts, l); } else drawExtruded(g, pts, DOOR_HEIGHT, l);
    }
    // Frame posts at the span's ends, over the leaf's pocket.
    for (const [px, py] of [[d.x, d.y], [x1, y1]] as const) {
      drawExtruded(g, [{ x: px - t / 2 - 2, y: py - t / 2 - 2 }, { x: px + t / 2 + 2, y: py - t / 2 - 2 }, { x: px + t / 2 + 2, y: py + t / 2 + 2 }, { x: px - t / 2 - 2, y: py + t / 2 + 2 }], DOOR_HEIGHT + 2, FRAME_LOOK);
    }
    if (d.kind === 'swing' || d.kind === 'double-swing') {
      g.fillStyle = INK;
      const hinges = d.kind === 'double-swing' ? [[d.x, d.y], [x1, y1]] : (d.hinge ?? 'start') === 'start' ? [[d.x, d.y]] : [[x1, y1]];
      for (const [hx, hy] of hinges as [number, number][]) { g.beginPath(); g.arc(hx, hy, 4, 0, Math.PI * 2); g.fill(); }
    }
  }
}

/** Door leaves as shadow casters for the lighting pass (glass lets light through). */
export function doorOccluders(leaves: readonly DoorLeaf[], view: GeoView): Occluder[] {
  const out: Occluder[] = [];
  for (const l of leaves) {
    if (l.ns || l.x + l.w < view.x0 || l.x > view.x1 || l.y + l.h + 40 < view.y0 || l.y > view.y1) continue;
    out.push({ x: l.x, y: l.y, w: l.w, h: l.h, face: DOOR_HEIGHT, ...(l.pts && { pts: l.pts }) });
  }
  return out;
}

// ---- roofs ----

const ROOF_FADE = { inside: 0.1, perSec: 7 } as const;
const roofAlpha = new Map<string, { a: number; at: number }>();

const inPoly = (p: Pt, pts: readonly Pt[]): boolean => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!, b = pts[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

/** The ids of the roofs any of `who` stands under. */
export const roofsOver = (roofs: readonly MapRoof[], who: readonly Pt[]): Set<string> =>
  new Set(roofs.filter((r) => who.some((p) => inPoly(p, r.points))).map((r) => r.id));

/** How opaque each roof is drawn now: opaque while nobody of yours is under it, `ROOF_FADE.inside` while one is. */
export function roofAlphas(map: MapDef, who: readonly Pt[], now: number): Map<string, number> {
  const out = new Map<string, number>();
  const under = roofsOver(map.roofs ?? [], who);
  for (const r of map.roofs ?? []) {
    const key = `${map.name}:${r.id}`;
    let s = roofAlpha.get(key);
    if (!s || now < s.at) s = { a: under.has(r.id) ? ROOF_FADE.inside : 1, at: now };
    const dt = Math.min(0.1, Math.max(0, (now - s.at) / 1000));
    const target = under.has(r.id) ? ROOF_FADE.inside : 1;
    s.a = s.a < target ? Math.min(target, s.a + ROOF_FADE.perSec * dt) : Math.max(target, s.a - ROOF_FADE.perSec * dt);
    s.at = now;
    roofAlpha.set(key, s);
    out.set(r.id, s.a);
  }
  return out;
}

const ROOF_LOOK = look('#6b6459');
/** Roofs, drawn over the bodies: a slab top with tile seams and a lip along the south edge. */
export function drawRoofs(g: CanvasRenderingContext2D, info: GeoInfo, who: readonly Pt[]): void {
  const roofs = info.map.roofs;
  if (!roofs?.length) return;
  const theme = themeOf(info.map.theme);
  const alphas = roofAlphas(info.map, who, info.now);
  for (const r of roofs) {
    const a = alphas.get(r.id) ?? 1;
    if (a < 0.02) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of r.points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    if (x1 < info.view.x0 || x0 > info.view.x1 || y1 < info.view.y0 - 20 || y0 > info.view.y1) continue;
    g.save();
    g.globalAlpha = a;
    // From outside, each doorway shows through a notch in the roof's edge (doorwayart.ts).
    const notches = roofNotches(info.map, r.id);
    clipNotches(g, notches, { x0, y0, x1, y1 });
    if (theme?.roof?.(g, r, a, info) || (r.material && paintRoofMaterial(g, r, info))) { drawNotchRims(g, notches); g.restore(); continue; }
    const pts = [...r.points];
    const area = pts.reduce((s, p, i) => s + (p.x * pts[(i + 1) % pts.length]!.y - pts[(i + 1) % pts.length]!.x * p.y), 0);
    const ccw = area < 0 ? pts.reverse() : pts;
    const l = r.tint ? look(r.tint) : ROOF_LOOK;
    drawFront(g, ccw, 10, l);
    trace(g, ccw);
    g.fillStyle = l.top;
    g.fill();
    g.save();
    g.clip();
    g.strokeStyle = l.shade;
    g.lineWidth = 2;
    g.globalAlpha = a * 0.55;
    for (let y = Math.ceil(y0 / 40) * 40; y < y1; y += 40) { g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); }
    g.globalAlpha = a;
    g.lineWidth = 8;
    g.strokeStyle = l.lit;
    for (let i = 0; i < ccw.length; i++) {
      const p = ccw[i]!, q = ccw[(i + 1) % ccw.length]!;
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len < 1 || ((q.y - p.y) * LIGHT.x - (q.x - p.x) * LIGHT.y) / len > -0.35) continue;
      g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
    }
    if (info.dark > 0) { g.fillStyle = `rgba(20,28,60,${0.5 * info.dark})`; g.fillRect(x0, y0, x1 - x0, y1 - y0); }
    g.restore();
    trace(g, ccw);
    g.strokeStyle = INK;
    g.lineWidth = 2;
    g.stroke();
    drawNotchRims(g, notches);
    g.restore();
  }
}

// ---- debug ----

/** Collision outlines of every convex part, bounding boxes, door leaves and roof outlines. */
export function drawGeoDebug(g: CanvasRenderingContext2D, info: GeoInfo, leaves: readonly DoorLeaf[]): void {
  g.save();
  g.lineWidth = 2;
  for (const p of polyParts(info.map)) {
    if (p.x + p.w < info.view.x0 || p.x > info.view.x1 || p.y + p.h < info.view.y0 || p.y > info.view.y1) continue;
    g.strokeStyle = 'rgba(0,255,255,0.35)';
    g.strokeRect(p.x, p.y, p.w, p.h);
    g.strokeStyle = p.nb ? '#ffd34d' : '#ff2bd6';
    trace(g, unflat(p.pts));
    g.stroke();
  }
  g.strokeStyle = '#3dff8a';
  for (const l of leaves) { if (l.pts) trace(g, unflat(l.pts)); else { g.beginPath(); g.rect(l.x, l.y, l.w, l.h); } g.stroke(); }
  g.setLineDash([10, 8]);
  g.strokeStyle = '#ff9a3c';
  for (const r of info.map.roofs ?? []) { trace(g, r.points); g.stroke(); }
  g.restore();
}
