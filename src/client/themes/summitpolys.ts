import type { MapDoor, MapPoly, MapRoof, Pt } from '../../shared/geom.ts';
import type { DoorLeaf } from '../../shared/sim/doors.ts';
import { unflat } from '../../shared/geom.ts';
import { DOOR_HEIGHT, drawExtruded, type GeoInfo, type PolyLook } from '../geoart.ts';
import { INK } from '../palette.ts';
import { drawVehicle, vehicleSprite } from '../vehicleart.ts';
import { paintDome, paintGable } from './summitroof.ts';
import { C, SIZE, TAU, baseId, ell, hash, hexA, isTwin, shade, type G } from './summitkit.ts';
import { onMapChange } from '../mapscope.ts';

/**
 * Summit's polygons, doors and roofs. Every polygon is painted once into a small sprite and blitted; the pine groves are
 * painted a group at a time so a clump of overlapping blobs reads as one snow-laden stand. The twin of every one-off is
 * another thing entirely (ids end in `~`): a hot tub and a cold plunge, a pylon and an ice obelisk, a groomer and a
 * gondola cabin, an observatory and a fuel house.
 */
const look = (top: string, front: string, lit: string, sh: string): PolyLook => ({ top, front, lit, shade: sh });
type Bounds = { x0: number; y0: number; x1: number; y1: number };
const bounds = (pts: readonly Pt[]): Bounds => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); } return { x0, y0, x1, y1 }; };
const trace = (g: G, pts: readonly Pt[]) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); };
const centroid = (pts: readonly Pt[]): Pt => { let x = 0, y = 0; for (const p of pts) { x += p.x; y += p.y; } return { x: x / pts.length, y: y / pts.length }; };
const scaled = (pts: readonly Pt[], k: number, dx = 0, dy = 0): Pt[] => { const c = centroid(pts); return pts.map((p) => ({ x: c.x + (p.x - c.x) * k + dx, y: c.y + (p.y - c.y) * k + dy })); };

const PAD = 40;
let sprites = new WeakMap<object, { c: HTMLCanvasElement; x: number; y: number }>();
onMapChange(() => { sprites = new WeakMap(); });
/** Paints `draw` once into a canvas covering `pts` (plus a front face and a margin) and blits it from then on. */
function cached(g: G, key: object, pts: readonly Pt[], extraH: number, draw: (g: G) => void) {
  let s = sprites.get(key);
  if (!s) {
    const b = bounds(pts), w = Math.ceil(b.x1 - b.x0 + 2 * PAD), h = Math.ceil(b.y1 - b.y0 + 2 * PAD + extraH);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cg = c.getContext('2d')!;
    cg.translate(PAD - b.x0, PAD - b.y0);
    draw(cg);
    s = { c, x: b.x0 - PAD, y: b.y0 - PAD };
    sprites.set(key, s);
  }
  g.drawImage(s.c, s.x, s.y);
}

/* -- snow on a shape ------------------------------------------------------------------------------------------------------ */

function snowOn(g: G, pts: readonly Pt[], k = 0.62, dx = -4, dy = -5, a = 0.92) {
  trace(g, scaled(pts, k, dx, dy)); g.fillStyle = hexA(C.snowCap, a); g.fill();
  trace(g, scaled(pts, k * 0.7, dx * 1.6, dy * 1.6)); g.fillStyle = 'rgba(255, 255, 255, 0.3)'; g.fill();
}

/* -- pine groves ------------------------------------------------------------------------------------------------------------ */

/** A closed path through the midpoints of a polygon's edges, so a low-poly blob paints as a soft one. */
const soft = (g: G, pts: readonly Pt[]) => {
  const n = pts.length, mid = (i: number) => ({ x: (pts[i % n]!.x + pts[(i + 1) % n]!.x) / 2, y: (pts[i % n]!.y + pts[(i + 1) % n]!.y) / 2 });
  g.beginPath(); const m0 = mid(0); g.moveTo(m0.x, m0.y);
  for (let i = 1; i <= n; i++) { const q = pts[i % n]!, m = mid(i); g.quadraticCurveTo(q.x, q.y, m.x, m.y); }
  g.closePath();
};

/** One bough tier: a scalloped, pointed star of drooping boughs with two cel steps (lit upper left, shaded lower right) and snow on the lit tips. */
function tier(g: G, cx: number, cy: number, r: number, seed: number, col: [string, string, string], snowK: number) {
  const n = 11, pts: Pt[] = [];
  for (let i = 0; i < n * 2; i++) { const a = (i / (n * 2)) * TAU + hash(seed, 1) * 6, rr0 = i % 2 ? r * (0.74 + hash(seed, i) * 0.06) : r * (0.96 + hash(seed, i + 40) * 0.1); pts.push({ x: cx + Math.cos(a) * rr0, y: cy + Math.sin(a) * rr0 * 0.92 }); }
  g.beginPath(); pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]!; if (i === 0) g.moveTo(p.x, p.y); g.quadraticCurveTo(p.x * 0.5 + q.x * 0.5 + (cx - (p.x + q.x) / 2) * 0.08, p.y * 0.5 + q.y * 0.5 + (cy - (p.y + q.y) / 2) * 0.08, q.x, q.y); }); g.closePath();
  g.fillStyle = col[0]; g.fill(); g.strokeStyle = INK; g.lineWidth = 2.4; g.lineJoin = 'round'; g.stroke();
  g.save(); g.clip();
  g.fillStyle = col[1]; ell(g, cx - r * 0.18, cy - r * 0.2, r * 0.78, r * 0.7); g.fill();
  g.fillStyle = col[2]; ell(g, cx - r * 0.3, cy - r * 0.32, r * 0.46, r * 0.4); g.fill();
  g.fillStyle = 'rgba(8, 14, 30, 0.34)'; ell(g, cx + r * 0.62, cy + r * 0.62, r * 0.6, r * 0.5); g.fill();
  g.strokeStyle = 'rgba(8, 20, 14, 0.5)'; g.lineWidth = 2;
  for (let i = 0; i < n; i++) { const a = (i / n) * TAU + hash(seed, 1) * 6; g.beginPath(); g.moveTo(cx + Math.cos(a) * r * 0.3, cy + Math.sin(a) * r * 0.3); g.lineTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.85); g.stroke(); }
  g.restore();
  // Snow caught on the upper-left boughs: chunky scallops, a lit top and a shaded foot.
  for (let i = 0; i < n * 2; i += 2) {
    const p = pts[i]!, dx = p.x - cx, dy = p.y - cy;
    if (dx * 0.62 + dy * 0.78 > r * 0.2) continue;
    const sx = cx + dx * snowK, sy = cy + dy * snowK, w = r * 0.2;
    g.fillStyle = C.snowLo; ell(g, sx + 1, sy + 3, w, w * 0.66, Math.atan2(dy, dx)); g.fill();
    g.fillStyle = C.snowCap; ell(g, sx, sy, w, w * 0.66, Math.atan2(dy, dx)); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.45)'; ell(g, sx - w * 0.25, sy - w * 0.2, w * 0.5, w * 0.25, Math.atan2(dy, dx)); g.fill();
  }
}

/** A conifer from above: shadow, then three tiers of boughs from the broad skirt up to the snow-capped tip. */
function conifer(g: G, c: Pt, R: number, seed: number, tiers = 3) {
  g.fillStyle = 'rgba(8, 12, 28, 0.32)'; ell(g, c.x + R * 0.18, c.y + R * 0.62, R * 1.0, R * 0.5); g.fill();
  const cols: [string, string, string][] = [['#1a3328', '#2a4f3c', '#386650'], ['#1f3b2e', '#31594a', '#42725c'], ['#244434', '#386a54', '#4e8468']];
  for (let t = 0; t < tiers; t++) {
    const k = 1 - t * (0.62 / tiers), up = t * R * 0.2;
    tier(g, c.x, c.y + R * 0.14 - up, R * k, seed + t * 7, cols[Math.min(t, 2)]!, 0.8);
  }
  g.fillStyle = C.snowCap; ell(g, c.x - R * 0.06, c.y - R * 0.18 - (tiers - 1) * R * 0.2, R * 0.18, R * 0.13); g.fill(); g.strokeStyle = INK; g.lineWidth = 1.6; g.stroke();
}

function pineGroup(g: G, group: readonly MapPoly[], farm: boolean) {
  const sorted = [...group].sort((a, b) => centroid(a.points).y - centroid(b.points).y);
  const lights = ['#ffb347', '#ff6a4a', '#8fd8ff', '#ffe08a'];
  for (const p of sorted) {
    const c = centroid(p.points), R = Math.max(...p.points.map((q) => Math.hypot(q.x - c.x, q.y - c.y))) * 1.04;
    conifer(g, c, R, Math.round(c.x + c.y), R > 70 ? 3 : 2);
    if (farm) for (let i = 0; i < 6; i++) { const a = hash(c.x, c.y, i) * TAU, rr2 = R * (0.2 + hash(c.y, c.x, i) * 0.6); g.fillStyle = lights[i % lights.length]!; g.beginPath(); g.arc(c.x + Math.cos(a) * rr2, c.y + Math.sin(a) * rr2 * 0.8, 2.6, 0, TAU); g.fill(); }
  }
}

function rockPoly(g: G, p: MapPoly) {
  const pts = p.points, h = p.height ?? 46, c = centroid(pts);
  // Front face: the south edges drop straight down in dark rock.
  soft2(g, pts.map((q) => ({ x: q.x, y: q.y + h * 0.4 }))); g.fillStyle = C.rockDeep; g.fill(); g.strokeStyle = INK; g.lineWidth = 2.5; g.lineJoin = 'round'; g.stroke();
  const top = pts.map((q, i) => ({ x: q.x + (hash(q.x, q.y, 1) - 0.5) * 4, y: q.y - (i % 2 ? 0 : 2) }));
  // A fan of planes from a raised peak: each plane takes a value from the way it faces the light.
  const peak = { x: c.x - 5, y: c.y - 8 };
  top.forEach((a, i) => {
    const b = top[(i + 1) % top.length]!;
    const nx = (a.y + b.y) / 2 - peak.y, ny = peak.x - (a.x + b.x) / 2, len = Math.hypot(nx, ny) || 1;
    const lit = (nx * -0.62 + ny * -0.78) / len;
    g.fillStyle = lit > 0.35 ? C.rockHi : lit > -0.25 ? C.rock : lit > -0.65 ? C.rockLo : C.rockDeep;
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.lineTo(peak.x, peak.y); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(14, 14, 18, 0.7)'; g.lineWidth = 2; g.beginPath(); g.moveTo(peak.x, peak.y); g.lineTo(a.x, a.y); g.stroke();
    // Snow settles on the planes that face up and toward the light.
    if (lit > 0.1) { g.fillStyle = hexA(C.snowCap, 0.9); g.beginPath(); g.moveTo(a.x + (peak.x - a.x) * 0.1, a.y + (peak.y - a.y) * 0.1); g.lineTo(b.x + (peak.x - b.x) * 0.1, b.y + (peak.y - b.y) * 0.1); g.lineTo(peak.x + (a.x - peak.x) * 0.45, peak.y + (a.y - peak.y) * 0.45); g.closePath(); g.fill(); }
  });
  soft2(g, top); g.strokeStyle = INK; g.lineWidth = 2.6; g.stroke();
}
/** A softened closed path (midpoint quadratics). */
const soft2 = (g: G, pts: readonly Pt[]) => soft(g, pts);

/* -- everything else ----------------------------------------------------------------------------------------------------------- */

const LOOKS: Record<string, PolyLook> = {
  board: look('#d2dae6', '#3a5fa8', '#f0f4fa', '#9aa8bc'),
  net: look('rgba(230, 236, 246, 0.35)', '#8a2e2a', '#ffffff', '#6a7280'),
  rail: look('#a47848', '#5a3a1e', '#c4986a', '#7a5630'),
  rope: look('#c8402e', '#6a1e14', '#e8e0d0', '#7a2a1e'),
  pylon: look('#8a96a4', '#46525e', '#b4becb', '#5a6672'),
  car: look('#6a8a9c', '#2e4654', '#9ab6c4', '#46606e'),
  sled: look('#d9541f', '#7a2e12', '#f08a56', '#a8401a'),
  groomer: look('#b8402e', '#6a241a', '#d8604a', '#8a2e22'),
  tub: look('#a47848', '#5a3a1e', '#c4986a', '#7a5630'),
  sauna: look('#b08050', '#5a3a1e', '#cc9a68', '#845a34'),
  wheelhouse: look('#8a96a4', '#46525e', '#b4becb', '#5a6672'),
  snowman: look('#b3c1d6', '#6a7c96', '#e4ecf6', '#8c9cb4'),
  ringwall: look('#c8c2b0', '#6a6658', '#e8e4d4', '#8a8678'),
  pier: look('#8a96a4', '#46525e', '#b4becb', '#5a6672'),
  iceridge: look('#9ccfe2', '#3f7a96', '#e0f4fc', '#5c9ab4'),
  elder: look('#2c4a3a', '#18291f', '#4e7a60', '#1f3629'),
};
const ICE_LOOK = look('#8ed0e6', '#3f7a96', '#e0f6fe', '#5ca4be');

function extra(g: G, p: MapPoly, tw: boolean) {
  const pts = p.points, c = centroid(pts), b = bounds(pts);
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  switch (p.material) {
    case 'tub': {
      g.fillStyle = INK; ell(g, c.x, c.y, 86, 86); g.fill();
      if (!tw) {
        for (let k = 0; k < 20; k++) { const a = (k / 20) * TAU; g.strokeStyle = k % 2 ? 'rgba(40, 24, 10, 0.5)' : 'rgba(255, 220, 160, 0.15)'; g.lineWidth = 2; g.beginPath(); g.moveTo(c.x + Math.cos(a) * 88, c.y + Math.sin(a) * 88); g.lineTo(c.x + Math.cos(a) * 100, c.y + Math.sin(a) * 100); g.stroke(); }
        const gr = g.createRadialGradient(c.x - 12, c.y - 12, 4, c.x, c.y, 82); gr.addColorStop(0, '#5ec8c0'); gr.addColorStop(1, '#2a7c88'); g.fillStyle = gr; ell(g, c.x, c.y, 80, 80); g.fill();
        g.strokeStyle = 'rgba(220, 255, 250, 0.4)'; g.lineWidth = 2; for (const r of [26, 48, 66]) { ell(g, c.x, c.y, r, r); g.stroke(); }
        g.fillStyle = 'rgba(255, 255, 255, 0.4)'; ell(g, c.x - 30, c.y - 34, 12, 6, -0.6); g.fill();
        g.fillStyle = C.steelHi; ell(g, c.x + 70, c.y - 40, 8, 8); g.fill(); g.strokeStyle = INK; g.lineWidth = 2; g.stroke();
      } else {
        g.fillStyle = 'rgba(220, 245, 252, 0.8)'; ell(g, c.x, c.y, 86, 86); g.fill();
        const gr = g.createRadialGradient(c.x, c.y, 4, c.x, c.y, 76); gr.addColorStop(0, '#0e2a40'); gr.addColorStop(1, '#1c4a64'); g.fillStyle = gr; ell(g, c.x, c.y, 74, 74); g.fill();
        g.fillStyle = 'rgba(200, 235, 250, 0.9)'; for (let i = 0; i < 4; i++) { const a = hash(c.x, i) * TAU; ell(g, c.x + Math.cos(a) * 36, c.y + Math.sin(a) * 36, 14, 9, a); g.fill(); }
        g.strokeStyle = C.brass; g.lineWidth = 3; g.beginPath(); g.moveTo(c.x + 70, c.y - 30); g.lineTo(c.x + 70, c.y + 30); g.stroke();
      }
      break;
    }
    case 'sauna': {
      for (let k = -4; k <= 4; k++) { g.strokeStyle = k % 2 ? 'rgba(40, 24, 10, 0.55)' : 'rgba(255, 220, 160, 0.2)'; g.lineWidth = 3; g.beginPath(); g.moveTo(c.x + k * 22, c.y - 118); g.lineTo(c.x + k * 22, c.y + 118); g.stroke(); }
      g.strokeStyle = C.steelLo; g.lineWidth = 6; for (const dy of [-60, 60]) { g.beginPath(); g.moveTo(c.x - 112, c.y + dy); g.lineTo(c.x + 112, c.y + dy); g.stroke(); }
      g.fillStyle = C.steelLo; g.fillRect(c.x + 50, c.y - 50, 14, 14); g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(c.x + 50, c.y - 50, 14, 14);
      snowOn(g, pts, 0.7, 0, -6, 0.5);
      break;
    }
    case 'pylon': {
      if (tw) { g.fillStyle = 'rgba(255,255,255,0.4)'; g.beginPath(); g.moveTo(c.x - 12, c.y + 10); g.lineTo(c.x, c.y - 24); g.lineTo(c.x + 4, c.y + 10); g.closePath(); g.fill(); break; }
      g.strokeStyle = INK; g.lineWidth = 3; g.beginPath(); g.moveTo(c.x - 16, c.y + 16); g.lineTo(c.x + 16, c.y - 16); g.moveTo(c.x + 16, c.y + 16); g.lineTo(c.x - 16, c.y - 16); g.stroke();
      g.strokeStyle = C.steelHi; g.lineWidth = 1.6; g.stroke(); g.fillStyle = C.yellow; g.fillRect(c.x - 12, c.y + 12, 24, 3);
      break;
    }
    case 'wheelhouse': {
      if (tw) { for (let k = 0; k < 8; k++) { g.strokeStyle = 'rgba(30, 20, 10, 0.5)'; g.lineWidth = 2; g.beginPath(); g.moveTo(c.x + Math.cos((k / 8) * TAU) * 18, c.y + Math.sin((k / 8) * TAU) * 18); g.lineTo(c.x + Math.cos((k / 8) * TAU) * 80, c.y + Math.sin((k / 8) * TAU) * 80); g.stroke(); } g.fillStyle = '#a47848'; ell(g, c.x, c.y, 40, 40); g.fill(); g.strokeStyle = INK; g.lineWidth = 2; g.stroke(); break; }
      g.fillStyle = C.steelLo; ell(g, c.x, c.y, 62, 62); g.fill(); g.strokeStyle = INK; g.lineWidth = 3; g.stroke();
      g.fillStyle = C.steel; ell(g, c.x - 3, c.y - 4, 56, 54); g.fill(); g.fillStyle = C.steelHi; ell(g, c.x - 12, c.y - 14, 36, 30); g.fill();
      g.strokeStyle = INK; g.lineWidth = 6; ell(g, c.x, c.y, 40, 40); g.stroke(); g.strokeStyle = '#a8b4c2'; g.lineWidth = 3; ell(g, c.x, c.y, 40, 40); g.stroke();
      for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU; g.strokeStyle = INK; g.lineWidth = 5; g.beginPath(); g.moveTo(c.x, c.y); g.lineTo(c.x + Math.cos(a) * 40, c.y + Math.sin(a) * 40); g.stroke(); g.strokeStyle = '#a8b4c2'; g.lineWidth = 2; g.stroke(); }
      g.fillStyle = C.red; ell(g, c.x, c.y, 11, 11); g.fill(); g.strokeStyle = INK; g.lineWidth = 2; g.stroke(); g.fillStyle = '#fff'; ell(g, c.x - 3, c.y - 3, 2.4, 2.4); g.fill();
      g.fillStyle = hexA(C.snowCap, 0.8); ell(g, c.x - 34, c.y - 36, 16, 8, -0.7); g.fill();
      break;
    }
    case 'car': {
      const rot = Math.atan2(pts[1]!.y - pts[0]!.y, pts[1]!.x - pts[0]!.x);
      g.save(); g.translate(c.x, c.y); g.rotate(rot);
      if (!tw) { g.fillStyle = 'rgba(190, 215, 240, 0.8)'; rr2(g, -60, -48, 76, 96, 8); g.fillStyle = C.snowCap; g.fillRect(-150, -58, 320, 36); g.fillRect(-150, 20, 320, 34); g.fillStyle = 'rgba(255, 255, 255, 0.35)'; g.fillRect(-150, -58, 320, 5); }
      else { g.fillStyle = '#e8a33a'; g.fillRect(-160, -60, 320, 120); g.fillStyle = 'rgba(190, 225, 245, 0.85)'; for (let i = -4; i < 3; i++) g.fillRect(i * 40, -46, 30, 20); g.fillStyle = INK; g.fillRect(-160, -4, 320, 3); g.fillStyle = '#e2dccb'; g.font = '700 13px "Barlow Condensed", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('SHUTTLE', 0, 22); }
      g.restore();
      break;
    }
    // The sled, groomer and car cases are the fallback while the vehicle kit bakes their models (kitVehicle above).
    case 'sled': {
      const rot = Math.atan2(pts[1]!.y - pts[0]!.y, pts[1]!.x - pts[0]!.x);
      g.save(); g.translate(c.x, c.y); g.rotate(rot);
      if (!tw) { g.fillStyle = INK; g.fillRect(-26, -10, 40, 20); g.fillStyle = '#2a2e36'; g.fillRect(-24, -8, 36, 16); g.fillStyle = 'rgba(255, 255, 255, 0.5)'; g.fillRect(-40, -22, 70, 8); g.fillStyle = C.hazard; g.fillRect(18, -6, 22, 12); g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(18, -6, 22, 12); }
      else { g.fillStyle = '#6a7a88'; g.fillRect(-46, -26, 92, 52); g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(-46, -26, 92, 52); g.fillStyle = '#c8402e'; g.fillRect(-30, -18, 28, 36); g.fillStyle = '#3d6b52'; g.fillRect(2, -18, 28, 36); }
      g.restore();
      break;
    }
    case 'groomer': {
      const body = p.part === 'body';
      const rot = Math.atan2(pts[1]!.y - pts[0]!.y, pts[1]!.x - pts[0]!.x);
      g.save(); g.translate(c.x, c.y); g.rotate(rot);
      if (body && !tw) {
        // Tracks, a cab with a lamp bar, an amber beacon; "SUMMIT GROOMING" along the flank.
        g.fillStyle = '#26282e'; g.fillRect(-170, -88, 340, 30); g.fillRect(-170, 58, 340, 30);
        g.fillStyle = '#3a3e46'; for (let i = -8; i < 8; i++) { g.fillRect(i * 21, -88, 4, 30); g.fillRect(i * 21, 58, 4, 30); }
        g.fillStyle = 'rgba(190, 220, 240, 0.85)'; rr2(g, -10, -50, 110, 100, 10);
        g.fillStyle = '#e8e0cc'; g.fillRect(-130, -38, 100, 76); g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(-130, -38, 100, 76);
        g.fillStyle = '#ffe9a8'; for (let i = 0; i < 4; i++) g.fillRect(95, -40 + i * 26, 6, 14);
        g.fillStyle = '#e08a2a'; ell(g, -80, 0, 11, 11); g.fill(); g.strokeStyle = INK; g.stroke();
      } else if (body) {
        g.fillStyle = '#e2dccb'; g.fillRect(-170, -88, 340, 176); g.fillStyle = 'rgba(180, 215, 238, 0.85)'; for (let i = -3; i < 3; i++) g.fillRect(i * 52 + 6, -60, 40, 120);
        g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(-170, -88, 340, 176); g.fillStyle = C.red; g.fillRect(-170, -88, 340, 14); g.fillRect(-170, 74, 340, 14);
        g.fillStyle = C.steelLo; g.fillRect(-26, -96, 52, 10);
      } else if (!tw) { g.fillStyle = '#d9a02a'; g.fillRect(-13, -118, 26, 236); for (let i = -5; i < 5; i++) { g.fillStyle = i % 2 ? INK : '#d9a02a'; g.fillRect(-13, i * 22, 26, 11); } g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(-13, -118, 26, 236); }
      else { g.fillStyle = '#d9a02a'; g.fillRect(-13, -118, 26, 236); }
      g.restore();
      break;
    }
    case 'snowman': {
      if (!tw) { g.fillStyle = '#d4deec'; ell(g, c.x, c.y + 4, 40, 38); g.fill(); g.strokeStyle = INK; g.lineWidth = 2; g.stroke(); g.fillStyle = '#e4ecf6'; ell(g, c.x - 6, c.y - 12, 26, 24); g.fill(); g.stroke(); g.fillStyle = '#26282c'; for (const dy of [-6, 10]) { ell(g, c.x - 4, c.y + dy, 3, 3); g.fill(); } g.fillStyle = '#d9541f'; g.beginPath(); g.moveTo(c.x - 6, c.y - 26); g.lineTo(c.x + 28, c.y - 20); g.lineTo(c.x - 6, c.y - 18); g.closePath(); g.fill(); }
      else { g.fillStyle = 'rgba(160, 220, 240, 0.85)'; ell(g, c.x, c.y, 40, 38); g.fill(); g.strokeStyle = INK; g.lineWidth = 2; g.stroke(); g.fillStyle = 'rgba(240, 252, 255, 0.7)'; ell(g, c.x - 10, c.y - 12, 14, 8, -0.5); g.fill(); g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 2; g.beginPath(); g.moveTo(c.x - 20, c.y + 10); g.lineTo(c.x, c.y - 26); g.lineTo(c.x + 20, c.y + 10); g.stroke(); }
      break;
    }
    case 'ringwall': {
      if (!tw) { g.fillStyle = 'rgba(138, 80, 48, 0.45)'; trace(g, pts); g.fill(); g.strokeStyle = 'rgba(30, 20, 14, 0.5)'; g.lineWidth = 2; for (let i = 0; i < pts.length; i += 3) { const q = pts[i]!; g.beginPath(); g.moveTo(q.x, q.y); g.lineTo(centroid(pts).x * 0 + q.x + 1, q.y + 1); g.stroke(); } }
      snowOn(g, pts, 0.8, 0, -3, 0.45);
      break;
    }
    case 'pier': {
      if (tw) { g.strokeStyle = C.brass; g.lineWidth = 4; g.beginPath(); g.moveTo(c.x, c.y); g.lineTo(c.x + 30, c.y - 40); g.stroke(); g.fillStyle = C.steelLo; ell(g, c.x, c.y, 14, 14); g.fill(); g.strokeStyle = INK; g.lineWidth = 2; g.stroke(); }
      else { g.fillStyle = C.yellow; ell(g, c.x, c.y, 22, 22); g.fill(); g.strokeStyle = INK; g.lineWidth = 2; g.stroke(); g.fillStyle = C.hazard; ell(g, c.x, c.y, 8, 8); g.fill(); }
      break;
    }
    case 'iceridge': { for (let i = 0; i < 5; i++) { g.fillStyle = 'rgba(235, 250, 255, 0.5)'; g.beginPath(); const x = b.x0 + (i + 0.5) * (w / 5); g.moveTo(x - 8, c.y + 6); g.lineTo(x, c.y - 18); g.lineTo(x + 8, c.y + 6); g.closePath(); g.fill(); } break; }
    case 'board': { if (w > h) { g.fillStyle = 'rgba(176, 56, 44, 0.8)'; for (let x = b.x0 + 40; x < b.x1 - 60; x += 220) g.fillRect(x, b.y0 + 3, 90, h - 6); } break; }
    case 'net': { g.strokeStyle = 'rgba(240, 244, 250, 0.7)'; g.lineWidth = 1.2; for (let i = 1; i < 7; i++) { g.beginPath(); g.moveTo(b.x0 + (w * i) / 7, b.y0); g.lineTo(b.x0 + (w * i) / 7, b.y1); g.stroke(); } for (let i = 1; i < 12; i++) { g.beginPath(); g.moveTo(b.x0, b.y0 + (h * i) / 12); g.lineTo(b.x1, b.y0 + (h * i) / 12); g.stroke(); } g.strokeStyle = '#b4402e'; g.lineWidth = 4; g.strokeRect(b.x0 + 1, b.y0 + 1, w - 2, h - 2); break; }
    default: break;
  }
  void SIZE; void shade;
}
function rr2(g: G, x: number, y: number, w: number, h: number, r: number) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); g.fill(); g.strokeStyle = INK; g.lineWidth = 2; g.stroke(); }

/** Open water: the pool is black, ringed with broken ice, a skin of frost at the edge; the ripples are drawn live. */
function pool(g: G, p: MapPoly) {
  const pts = p.points, c = centroid(pts);
  // Snowbank rim: a lit lumpy ring with a shaded front, then a shelf of grey ice, then the dark thin-ice centre.
  soft(g, scaled(pts, 1.14, 0, 8)); g.fillStyle = C.snowDeep; g.fill();
  soft(g, scaled(pts, 1.14)); g.fillStyle = C.snowHi; g.fill(); g.strokeStyle = INK; g.lineWidth = 2.6; g.lineJoin = 'round'; g.stroke();
  g.save(); soft(g, scaled(pts, 1.14)); g.clip();
  g.strokeStyle = 'rgba(255, 255, 255, 0.4)'; g.lineWidth = 6; soft(g, scaled(pts, 1.1, -3, -3)); g.stroke();
  g.strokeStyle = 'rgba(50, 70, 112, 0.35)'; g.lineWidth = 7; soft(g, scaled(pts, 1.1, 4, 5)); g.stroke();
  g.restore();
  soft(g, scaled(pts, 1.0)); g.fillStyle = '#6a98ae'; g.fill(); g.strokeStyle = INK; g.lineWidth = 2.4; g.stroke();
  g.save(); soft(g, scaled(pts, 1.0)); g.clip();
  // Depth bands, outside in: pale ice, teal, deep green-black.
  for (const [k, col] of [[0.9, '#4f8aa2'], [0.76, '#2f6482'], [0.6, '#1d4660'], [0.42, '#12293e'], [0.24, '#0a1a2a']] as const) { soft(g, scaled(pts, k, 4 * (1 - k), 5 * (1 - k))); g.fillStyle = col; g.fill(); }
  // Chunky crack wedges from the shelf toward the centre.
  for (let i = 0; i < pts.length; i += 3) {
    const q = pts[i]!, dx = c.x - q.x, dy = c.y - q.y, l = Math.hypot(dx, dy), len = l * (0.28 + hash(q.x, q.y, 5) * 0.2), ux = dx / l, uy = dy / l;
    g.fillStyle = 'rgba(200, 228, 240, 0.8)'; g.beginPath(); g.moveTo(q.x - uy * 5, q.y + ux * 5); g.lineTo(q.x + ux * len + uy * 1, q.y + uy * len - ux * 1); g.lineTo(q.x + uy * 5, q.y - ux * 5); g.closePath(); g.fill();
  }
  // Wind-swept snow on the ice at the lit side, and a glint on the dark water.
  for (let i = 0; i < 5; i++) { const a = hash(c.x, c.y, i + 9) * TAU, d = 0.55 + hash(c.y, c.x, i) * 0.3, rr0 = Math.hypot(pts[0]!.x - c.x, pts[0]!.y - c.y); g.fillStyle = 'rgba(190, 210, 232, 0.5)'; ell(g, c.x + Math.cos(a) * rr0 * d, c.y + Math.sin(a) * rr0 * d, 22 + hash(i, c.x) * 24, 7 + hash(c.y, i) * 6, a + 1.5); g.fill(); }
  g.fillStyle = 'rgba(160, 215, 235, 0.35)'; ell(g, c.x - 40, c.y - 40, 40, 12, -0.6); g.fill();
  g.restore();
}

function elderTree(g: G, p: MapPoly, tw: boolean) {
  const c = centroid(p.points), R = 182;
  g.fillStyle = 'rgba(8, 12, 28, 0.34)'; ell(g, c.x + 34, c.y + 120, R * 1.05, R * 0.55); g.fill();
  const cols: [string, string, string][] = [['#17301f', '#25503a', '#336a4c'], ['#1b3825', '#2d5c44', '#3d775a'], ['#1f4029', '#356a4e', '#478464'], ['#234630', '#3b7358', '#52906e'], ['#274c35', '#427d62', '#5b9b78'], ['#2b543b', '#4a8a6c', '#66a886']];
  for (let t = 0; t < 6; t++) tier(g, c.x, c.y + 20 - t * 17, R * (1 - t * 0.14), 31 + t * 5, cols[t]!, 0.8);
  const lc = tw ? ['#ff5a4a', '#ffe08a', '#ffffff', '#8fd8ff'] : ['#ffb347', '#ffe08a', '#ff7a4a', '#9fe0ff', '#c8a0ff'];
  for (let i = 0; i < 56; i++) { const a = hash(i, 1, 2) * TAU, r = 24 + hash(i, 2, 2) * 150; g.fillStyle = lc[i % lc.length]!; g.beginPath(); g.arc(c.x + Math.cos(a) * r, c.y - 6 + Math.sin(a) * r * 0.8, 3.4, 0, TAU); g.fill(); g.strokeStyle = INK; g.lineWidth = 1; g.stroke(); g.fillStyle = 'rgba(255,255,255,0.7)'; g.fillRect(c.x + Math.cos(a) * r - 1, c.y - 8 + Math.sin(a) * r * 0.8, 1.6, 1.6); }
  g.fillStyle = C.snowCap; ell(g, c.x - 6, c.y - 92, 26, 15); g.fill(); g.strokeStyle = INK; g.lineWidth = 2; g.stroke();
  g.fillStyle = C.yellow; g.beginPath(); for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + (k / 10) * TAU, r = k % 2 ? 8 : 18; g.lineTo(c.x + Math.cos(a) * r, c.y - 100 + Math.sin(a) * r); } g.closePath(); g.fill(); g.strokeStyle = INK; g.lineWidth = 2; g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.8)'; ell(g, c.x - 4, c.y - 106, 3, 3); g.fill();
  if (tw) for (const [dx, col] of [[-60, '#c8402e'], [-30, '#2c4a6b'], [20, '#3d6b52']] as const) { g.fillStyle = col; g.fillRect(c.x + dx, c.y + 130, 28, 22); g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(c.x + dx, c.y + 130, 28, 22); g.fillStyle = C.yellow; g.fillRect(c.x + dx + 12, c.y + 130, 4, 22); }
}

/** One polygon, drawn into a sprite on first sight. */
/** The lot's pickups, the sleds and the groomer (and their twins) are toy models from the vehicle kit (docs/maps/VEHICLES.md). */
function kitVehicle(g: G, p: MapPoly, tw: boolean, info: GeoInfo): boolean {
  const kind = p.material === 'car' ? (tw ? 'van' : 'pickup') : p.material === 'sled' ? 'snowmobile' : p.material === 'groomer' ? (tw ? 'gondola' : 'snowcat') : null;
  if (!kind) return false;
  const pts = p.points;
  if (p.material === 'groomer' && p.part === 'blade') return !!vehicleSprite(kind, { x: 0, y: 0, rot: Math.atan2(pts[1]!.y - pts[0]!.y, pts[1]!.x - pts[0]!.x) });
  const c = centroid(pts);
  // A capsule's first edge is on its cap, so a sled takes the long axis of its points instead.
  let sxx = 0, syy = 0, sxy = 0;
  for (const q of pts) { sxx += (q.x - c.x) ** 2; syy += (q.y - c.y) ** 2; sxy += (q.x - c.x) * (q.y - c.y); }
  const rot = p.material === 'sled' ? 0.5 * Math.atan2(2 * sxy, sxx - syy) : Math.atan2(pts[1]!.y - pts[0]!.y, pts[1]!.x - pts[0]!.x);
  return drawVehicle(g, kind, {
    x: c.x, y: c.y, rot, t: info.now, polys: [p],
    ...(kind === 'van' && { livery: 'yellow' }), ...(kind === 'pickup' && { livery: ['red', 'blue', 'green', 'cream', 'rust'][Math.round(c.x / 400) % 5]!, variant: 'snowed' }),
    ...(kind === 'snowmobile' && { livery: tw ? 'blue' : 'red', scale: 0.85 }),
  });
}

export function drawSummitPoly(g: G, p: MapPoly, _info: GeoInfo): boolean {
  const tw = isTwin(p.id);
  if (kitVehicle(g, p, tw, _info)) return true;
  if (p.material === 'pine' || p.material === 'rock' || p.material === 'openwater' || p.material === 'elder') {
    const extraH = p.material === 'openwater' ? 0 : 30;
    cached(g, p, p.points, extraH, (cg) => {
      if (p.material === 'rock') rockPoly(cg, p);
      else if (p.material === 'openwater') pool(cg, p);
      else if (p.material === 'elder') elderTree(cg, p, tw);
      else pineGroup(cg, [p], tw && centroid(p.points).x > 4400);
    });
    return true;
  }
  const lk = tw && (p.material === 'pylon' || p.material === 'iceridge' || p.material === 'rope' || p.material === 'snowman') ? ICE_LOOK : p.material === 'ringwall' && !tw ? look('#8a5a3a', '#4a2c1a', '#aa7a54', '#6a4228') : p.material === 'car' && tw ? look('#e8a33a', '#7a5a1c', '#ffcf7a', '#a87a24') : p.material === 'groomer' && tw ? look('#e2dccb', '#6a6658', '#fff', '#a8a290') : p.material === 'tub' && tw ? look('#b4d4e4', '#4a7a94', '#e8f6fc', '#7aa0b4') : LOOKS[p.material];
  if (!lk) return false;
  cached(g, p, p.points, (p.height ?? 14) + 6, (cg) => { drawExtruded(cg, p.points, p.material === 'openwater' ? 0 : (p.height ?? 14), lk); extra(cg, p, tw); });
  return true;
}

/** A grove painted as one stand: every blob of the group, back to front. */
export function drawSummitGroup(g: G, group: readonly MapPoly[], _info: GeoInfo): boolean {
  const first = group[0]!;
  if (first.material !== 'pine') return false;
  const all = group.flatMap((p) => p.points);
  const tw = isTwin(first.id) && centroid(all).x > 4400;
  cached(g, first, all, 30, (cg) => pineGroup(cg, group, tw));
  return true;
}

/* -- doors ------------------------------------------------------------------------------------------------------------------ */

const leafPts = (l: DoorLeaf): Pt[] => (l.pts ? unflat(l.pts) : [{ x: l.x, y: l.y }, { x: l.x + l.w, y: l.y }, { x: l.x + l.w, y: l.y + l.h }, { x: l.x, y: l.y + l.h }]);

/** The doors that are more than their material: the chained gate, the louvred saloon doors, the roll-up shutter. Everything else uses the generic wood, glass and steel. */
export function drawSummitDoor(g: G, d: MapDoor, leaves: readonly DoorLeaf[], open: number, _info: GeoInfo): boolean {
  const id = baseId(d.id);
  const h = d.axis === 'h';
  const x1 = d.x + (h ? d.w : 0), y1 = d.y + (h ? 0 : d.w);
  const cx = (d.x + x1) / 2, cy = (d.y + y1) / 2;
  if (id === 'lift-gate') {
    for (const l of leaves) drawExtruded(g, leafPts(l), DOOR_HEIGHT, look('#7a8490', '#3a444f', '#a4aebb', '#566270'));
    // Chain across, padlock, the sign.
    g.strokeStyle = INK; g.lineWidth = 5; g.beginPath(); g.moveTo(d.x - 4, d.y - 6); g.quadraticCurveTo(cx, cy + 20, x1 + 4, y1 - 6); g.stroke();
    g.strokeStyle = '#9aa4b0'; g.lineWidth = 2.4; g.setLineDash([6, 4]); g.stroke(); g.setLineDash([]);
    g.fillStyle = C.yellow; g.fillRect(cx - 8, cy + 8, 16, 14); g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(cx - 8, cy + 8, 16, 14);
    return true;
  }
  if (id === 'saloon') {
    for (const l of leaves) {
      const pts = leafPts(l);
      drawExtruded(g, pts, 14, look('#a8743f', '#5a3a1e', '#c28d58', '#7e5330'));
      const b = bounds(pts);
      g.strokeStyle = 'rgba(40, 20, 6, 0.7)'; g.lineWidth = 1.6;
      const vert = b.y1 - b.y0 > b.x1 - b.x0;
      for (let i = 1; i < 6; i++) { g.beginPath(); if (vert) { g.moveTo(b.x0, b.y0 + ((b.y1 - b.y0) * i) / 6); g.lineTo(b.x1, b.y0 + ((b.y1 - b.y0) * i) / 6); } else { g.moveTo(b.x0 + ((b.x1 - b.x0) * i) / 6, b.y0); g.lineTo(b.x0 + ((b.x1 - b.x0) * i) / 6, b.y1); } g.stroke(); }
    }
    return false;
  }
  if (id === 'shutter' || id === 'gar-big' || id === 'gar-sleds') {
    for (const l of leaves) {
      const pts = leafPts(l);
      drawExtruded(g, pts, DOOR_HEIGHT, look('#a3aeb9', '#566470', '#c8d2dc', '#7e8a96'));
      const b = bounds(pts), horiz = b.x1 - b.x0 > b.y1 - b.y0;
      g.strokeStyle = 'rgba(30, 40, 52, 0.6)'; g.lineWidth = 1.6;
      for (let i = 1; i < 10; i++) { g.beginPath(); if (horiz) { g.moveTo(b.x0 + ((b.x1 - b.x0) * i) / 10, b.y0); g.lineTo(b.x0 + ((b.x1 - b.x0) * i) / 10, b.y1); } else { g.moveTo(b.x0, b.y0 + ((b.y1 - b.y0) * i) / 10); g.lineTo(b.x1, b.y0 + ((b.y1 - b.y0) * i) / 10); } g.stroke(); }
      if (id !== 'shutter') hazardStrip(g, b);
    }
    return true;
  }
  void open;
  return false;
}
function hazardStrip(g: G, b: Bounds) { g.save(); g.beginPath(); g.rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.clip(); g.fillStyle = 'rgba(217, 160, 42, 0.7)'; const horiz = b.x1 - b.x0 > b.y1 - b.y0; for (let i = 0; i < 40; i += 2) { if (horiz) g.fillRect(b.x0 + i * 8, b.y0, 8, b.y1 - b.y0); else g.fillRect(b.x0, b.y0 + i * 8, b.x1 - b.x0, 8); } g.restore(); }

/* -- roofs ------------------------------------------------------------------------------------------------------------------ */

/** A roof is a pitched roof (summitroof.ts), painted once into a sprite; only the night tint is applied per frame. */
export function drawSummitRoof(g: G, r: MapRoof, alpha: number, info: GeoInfo): boolean {
  const dome = baseId(r.id) === 'dome';
  cached(g, r, r.points, 20, (cg) => (dome ? paintDome(cg, r) : paintGable(cg, r)));
  if (info.dark > 0) { trace(g, r.points); g.fillStyle = `rgba(20, 28, 60, ${0.4 * info.dark})`; g.fill(); }
  void alpha;
  return true;
}
