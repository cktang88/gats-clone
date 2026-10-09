import type { MapPoly, Pt } from '../../shared/geom.ts';
import { ROOMS } from '../../shared/maps/causewaydata.ts';
import { SIZE } from '../../shared/maps/causewaydata.ts';
import type { GeoInfo } from '../geoart.ts';
import { INK } from '../palette.ts';
import { LIGHT } from '../tilt.ts';
import { BOX_PAINT, C, LINES, TAU, hash2, hexA, mix, rrect, sprite, stamp, trace, type Sprite } from './harborkit.ts';
import { bobOf, kitHulls, liveryOf } from './harborships.ts';
import { claimShadows } from '../vehicleshadow.ts';
import { onMapChange } from '../mapscope.ts';

/**
 * Every solid of the harbour, painted once into a sprite and stamped each frame: containers in faded paint with corrugated sides,
 * the gunwales of the moored ships in their owners' colours, deckhouses and sheds with their windows, brick pump house, timber
 * net loft, the scrap heaps and the hull on blocks. Each is the generic three-quarter extrusion (footprint on top, a darker
 * front face under every south edge, two cel bands, an ink outline) with the material's own detail on it.
 */

type G = CanvasRenderingContext2D;
type Look = { top: string; front: string };

const LOOKS: Record<string, Look> = {
  cabin: { top: '#d9d4c3', front: '#b3ae9c' },
  shed: { top: '#8fa5ab', front: '#617880' },
  office: { top: '#b6c1aa', front: '#8f9a82' },
  cafe: { top: '#e4d3a6', front: '#bfa264' },
  navy: { top: '#8c9c96', front: '#5f6e69' },
  plant: { top: '#a06c56', front: '#70463a' },
  loft: { top: '#8c6c4a', front: '#5e4832' },
  dockwall: { top: '#a3a59f', front: '#6d706c' },
  hatch: { top: '#7f8a82', front: '#566159' },
  console: { top: '#6a727c', front: '#454b54' },
  winch: { top: '#d4a43c', front: '#8a6a22' },
  coil: { top: '#b9a074', front: '#8c7650' },
  lifeboat: { top: '#e08a3c', front: '#a05a22' },
  fishcrate: { top: '#4f8ca8', front: '#336478' },
  frame: { top: '#9aa4ae', front: '#5d6670' },
  turret: { top: '#8a959c', front: '#59636a' },
  rack: { top: '#7a8590', front: '#505a64' },
  drydockhull: { top: '#6d7d84', front: '#8a2e22' },
  scaffold: { top: '#b09060', front: '#7a5e38' },
  crane: { top: '#d8d4c0', front: '#9a9680' },
  lighthouse: { top: '#e8e2d0', front: '#c8c2b0' },
  pump: { top: '#7f9a9a', front: '#4e6868' },
  cabinet: { top: '#8a949c', front: '#555e66' },
  table: { top: '#e8ddbe', front: '#a89a74' },
  icebench: { top: '#c6dfe2', front: '#7ea3a8' },
  counter: { top: '#a8784a', front: '#6e4a2c' },
  scanner: { top: '#46505a', front: '#2c333b' },
  scrap: { top: '#8a5a3c', front: '#5a3a28' },
  wreck: { top: '#8c5a3a', front: '#5c3a26' },
  tyres: { top: '#34363a', front: '#1f2124' },
  crates: { top: '#a8844e', front: '#6e5430' },
  container: { top: '#a8442e', front: '#6e2c1e' },
  hull: { top: '#c8c4b4', front: '#2c3e57' },
};
const FALLBACK: Look = { top: '#808a99', front: '#4d5560' };

const cached = new WeakMap<MapPoly, { pts: Pt[]; x0: number; y0: number; x1: number; y1: number; east: boolean }>();
function shapeOf(p: MapPoly) {
  let s = cached.get(p);
  if (s) return s;
  let a = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const q = p.points;
  for (let i = 0; i < q.length; i++) { const u = q[i]!, v = q[(i + 1) % q.length]!; a += u.x * v.y - v.x * u.y; x0 = Math.min(x0, u.x); y0 = Math.min(y0, u.y); x1 = Math.max(x1, u.x); y1 = Math.max(y1, u.y); }
  s = { pts: a < 0 ? [...q].reverse() : [...q], x0, y0, x1, y1, east: !!p.id?.endsWith('~') };
  cached.set(p, s);
  return s;
}

/** South-facing edges: the ones that run leftward on screen. */
const southEdges = (pts: readonly Pt[]): [Pt, Pt][] => {
  const out: [Pt, Pt][] = [];
  for (let i = 0; i < pts.length; i++) { const a = pts[i]!, b = pts[(i + 1) % pts.length]!; if (b.x < a.x - 0.5) out.push([a, b]); }
  return out;
};

function front(g: G, pts: readonly Pt[], h: number, fill: string | CanvasPattern, after?: (a: Pt, b: Pt, h: number) => void): void {
  if (h <= 0) return;
  g.fillStyle = fill; g.strokeStyle = INK; g.lineWidth = 2; g.lineJoin = 'round';
  for (const [a, b] of southEdges(pts)) {
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.lineTo(b.x, b.y + h); g.lineTo(a.x, a.y + h); g.closePath(); g.fill();
    after?.(a, b, h);
    g.beginPath(); g.moveTo(a.x, a.y + h); g.lineTo(b.x, b.y + h); g.stroke();
    g.beginPath(); g.moveTo(a.x, a.y + h); g.lineTo(a.x, a.y); g.moveTo(b.x, b.y + h); g.lineTo(b.x, b.y); g.stroke();
  }
}

/** The top face: flat paint, a light band on the lit edges, a dark band on the far ones, an ink outline. `detail` paints inside the clip. */
function top(g: G, pts: readonly Pt[], fill: string, detail?: () => void): void {
  g.save();
  trace(g, pts); g.fillStyle = fill; g.fill(); g.clip();
  detail?.();
  g.lineWidth = 7; g.lineCap = 'butt';
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1) continue;
    const facing = ((b.y - a.y) * LIGHT.x - (b.x - a.x) * LIGHT.y) / len;
    if (Math.abs(facing) < 0.35) continue;
    g.strokeStyle = facing < 0 ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.26)';
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  }
  g.restore();
  trace(g, pts); g.strokeStyle = INK; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
}

const rectOf = (pts: readonly Pt[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/* -- containers -------------------------------------------------------------------------------------------------- */

const UNIT_W = 156, UNIT_L = 390;

function container(g: G, poly: MapPoly, pts: Pt[], h: number): void {
  const r = rectOf(pts);
  const long = r.w >= r.h ? 'x' : 'y';
  const lenAxis = long === 'x' ? r.w : r.h, widAxis = long === 'x' ? r.h : r.w;
  const nl = Math.max(1, Math.round(lenAxis / UNIT_L)), nw = Math.max(1, Math.round(widAxis / UNIT_W));
  const ul = lenAxis / nl, uw = widAxis / nw;
  const cells: { x: number; y: number; w: number; h: number; paint: string; k: number }[] = [];
  for (let i = 0; i < nl; i++) for (let j = 0; j < nw; j++) {
    const k = hash2(Math.round(r.x) + i * 7, Math.round(r.y) + j * 13);
    const x = long === 'x' ? r.x + i * ul : r.x + j * uw, y = long === 'x' ? r.y + j * uw : r.y + i * ul;
    cells.push({ x, y, w: long === 'x' ? ul : uw, h: long === 'x' ? uw : ul, paint: BOX_PAINT[Math.floor(k * BOX_PAINT.length)]!, k });
  }
  // Front faces, a container at a time.
  for (const c of cells) {
    const fp = mix(c.paint, 0, 0.42);
    g.fillStyle = fp; g.strokeStyle = INK; g.lineWidth = 2;
    g.fillRect(c.x, c.y + c.h, c.w, h);
    g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 1.5;
    g.beginPath();
    for (let x = c.x + 7; x < c.x + c.w - 2; x += 9) { g.moveTo(x, c.y + c.h + 2); g.lineTo(x, c.y + c.h + h - 2); }
    g.stroke();
    g.strokeStyle = INK; g.lineWidth = 2;
    g.strokeRect(c.x, c.y + c.h, c.w, h);
  }
  for (const c of cells) {
    const lit = mix(c.paint, 255, 0.0);
    g.fillStyle = lit; g.fillRect(c.x, c.y, c.w, c.h);
    g.save();
    g.beginPath(); g.rect(c.x, c.y, c.w, c.h); g.clip();
    // Corrugation along the long axis, a light edge on the lit side.
    g.strokeStyle = 'rgba(0,0,0,0.2)'; g.lineWidth = 2;
    g.beginPath();
    if (long === 'x') for (let y = c.y + 8; y < c.y + c.h; y += 11) { g.moveTo(c.x, y); g.lineTo(c.x + c.w, y); }
    else for (let x = c.x + 8; x < c.x + c.w; x += 11) { g.moveTo(x, c.y); g.lineTo(x, c.y + c.h); }
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 2;
    g.beginPath();
    if (long === 'x') for (let y = c.y + 9.5; y < c.y + c.h; y += 11) { g.moveTo(c.x, y); g.lineTo(c.x + c.w, y); }
    else for (let x = c.x + 9.5; x < c.x + c.w; x += 11) { g.moveTo(x, c.y); g.lineTo(x, c.y + c.h); }
    g.stroke();
    // Door end: two leaves with locking bars; the other end plain. Weathering and a patch of rust.
    g.fillStyle = 'rgba(0,0,0,0.2)';
    const endLen = 26;
    if (long === 'x') g.fillRect(c.k < 0.5 ? c.x : c.x + c.w - endLen, c.y, endLen, c.h); else g.fillRect(c.x, c.k < 0.5 ? c.y : c.y + c.h - endLen, c.w, endLen);
    g.strokeStyle = 'rgba(20,20,24,0.55)'; g.lineWidth = 2;
    if (long === 'x') { const ex = c.k < 0.5 ? c.x + endLen / 2 : c.x + c.w - endLen / 2; g.beginPath(); g.moveTo(ex, c.y + 4); g.lineTo(ex, c.y + c.h - 4); g.moveTo(ex - 6, c.y + c.h * 0.3); g.lineTo(ex + 6, c.y + c.h * 0.3); g.moveTo(ex - 6, c.y + c.h * 0.7); g.lineTo(ex + 6, c.y + c.h * 0.7); g.stroke(); }
    else { const ey = c.k < 0.5 ? c.y + endLen / 2 : c.y + c.h - endLen / 2; g.beginPath(); g.moveTo(c.x + 4, ey); g.lineTo(c.x + c.w - 4, ey); g.moveTo(c.x + c.w * 0.3, ey - 6); g.lineTo(c.x + c.w * 0.3, ey + 6); g.moveTo(c.x + c.w * 0.7, ey - 6); g.lineTo(c.x + c.w * 0.7, ey + 6); g.stroke(); }
    if (c.k > 0.55) { g.fillStyle = hexA(C.rust, 0.25); g.beginPath(); g.ellipse(c.x + c.w * (0.3 + c.k * 0.4), c.y + c.h * 0.5, 22, 12, c.k * 3, 0, TAU); g.fill(); }
    // The line's name along the box, and a box number.
    if (ul >= 300 || uw >= 300) {
      g.fillStyle = 'rgba(244, 240, 226, 0.78)';
      g.font = '800 30px "Barlow Condensed", "Arial Narrow", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      (g as unknown as { letterSpacing: string }).letterSpacing = '4px';
      g.save();
      g.translate(c.x + c.w / 2, c.y + c.h / 2);
      if (long === 'y') g.rotate(-Math.PI / 2);
      g.fillText(LINES[Math.floor(c.k * 997) % LINES.length]!, 0, -3);
      g.font = '700 13px "Barlow Condensed", sans-serif';
      (g as unknown as { letterSpacing: string }).letterSpacing = '2px';
      g.fillStyle = 'rgba(244, 240, 226, 0.5)';
      g.fillText(`${LINES[Math.floor(c.k * 997) % LINES.length]!.slice(0, 4)} ${Math.floor(c.k * 900000 + 100000)} 7`, 0, 22);
      g.restore();
    }
    g.restore();
    g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(c.x, c.y, c.w, c.h);
  }
  // A light band on the whole stack's lit edges.
  g.fillStyle = 'rgba(255,255,255,0.22)';
  g.fillRect(r.x, r.y, r.w, 4);
  g.fillRect(r.x, r.y, 4, r.h);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(r.x + r.w - 4, r.y, 4, r.h);
  void poly;
}

/* -- walls ------------------------------------------------------------------------------------------------------- */

const roomOf = (id: string | undefined) => (id ? ROOMS.find((r) => id.startsWith(`${r.id}:`)) : undefined);

function window(g: G, x: number, y: number, w: number, h: number, lit: boolean): void {
  g.fillStyle = lit ? '#ffd98a' : '#33485a';
  g.fillRect(x, y, w, h);
  g.fillStyle = lit ? 'rgba(255,255,255,0.45)' : 'rgba(180,215,235,0.35)';
  g.beginPath(); g.moveTo(x + 2, y + h - 2); g.lineTo(x + w * 0.45, y + 2); g.lineTo(x + w * 0.7, y + 2); g.lineTo(x + w * 0.25, y + h - 2); g.closePath(); g.fill();
  g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(x, y, w, h);
}

function wall(g: G, poly: MapPoly, pts: Pt[], h: number): void {
  const room = roomOf(poly.id);
  const look = LOOKS[poly.material] ?? FALLBACK;
  const r = rectOf(pts);
  const horizontal = r.w >= r.h;
  const exterior = !room || !(horizontal && r.y + r.h / 2 < room.y + room.h / 2 && r.w > 60 && Math.abs(r.y - room.y) < 2) ? true : false;
  // Is this a strip on the room's north side? Its front face then looks into the room.
  const interior = !!room && horizontal && Math.abs(r.y - room.y) < 2;
  void exterior;
  const frontFill = interior ? mix(look.top, 255, 0.12) : look.front;
  front(g, pts, h, frontFill, (a, b, hh) => {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y) + 0;
    g.save();
    g.beginPath(); g.rect(x0, y0, x1 - x0, hh); g.clip();
    switch (poly.material) {
      case 'shed': { g.strokeStyle = 'rgba(0,0,0,0.22)'; g.lineWidth = 2; g.beginPath(); for (let x = x0 + 5; x < x1; x += 10) { g.moveTo(x, y0); g.lineTo(x, y0 + hh); } g.stroke(); g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x0, y0, x1 - x0, 4); break; }
      case 'plant': { g.strokeStyle = 'rgba(30,14,10,0.35)'; g.lineWidth = 1.5; g.beginPath(); for (let y = y0 + 9; y < y0 + hh; y += 9) { g.moveTo(x0, y); g.lineTo(x1, y); } for (let row = 0; row * 9 < hh; row++) for (let x = x0 + (row % 2) * 13; x < x1; x += 26) { g.moveTo(x, y0 + row * 9); g.lineTo(x, y0 + row * 9 + 9); } g.stroke(); break; }
      case 'loft': { g.strokeStyle = 'rgba(30,20,10,0.35)'; g.lineWidth = 1.6; g.beginPath(); for (let x = x0 + 8; x < x1; x += 12) { g.moveTo(x, y0); g.lineTo(x, y0 + hh); } g.stroke(); g.strokeStyle = 'rgba(30,20,10,0.5)'; g.lineWidth = 3; g.beginPath(); for (let x = x0 + 30; x < x1 - 40; x += 90) { g.moveTo(x, y0 + hh - 4); g.lineTo(x + 40, y0 + 4); } g.stroke(); break; }
      case 'navy': { g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x0, y0 + hh - 8, x1 - x0, 8); g.fillStyle = 'rgba(230,226,210,0.6)'; g.font = '800 15px "Barlow Condensed", sans-serif'; g.textBaseline = 'middle'; if (!interior && x1 - x0 > 130) g.fillText('N-4', x0 + 12, y0 + hh * 0.5); break; }
      case 'dockwall': { g.strokeStyle = 'rgba(20,22,24,0.35)'; g.lineWidth = 2; g.beginPath(); for (let x = x0 + 30; x < x1; x += 60) { g.moveTo(x, y0); g.lineTo(x, y0 + hh); } g.moveTo(x0, y0 + hh / 2); g.lineTo(x1, y0 + hh / 2); g.stroke(); break; }
      case 'office': case 'cafe': case 'cabin': {
        // A band of windows along the front of any strip long enough.
        if (!interior && x1 - x0 > 90) {
          const n = Math.floor((x1 - x0 - 20) / (poly.material === 'cabin' ? 46 : 62));
          const step = (x1 - x0 - 20) / Math.max(1, n);
          for (let i = 0; i < n; i++) window(g, x0 + 10 + i * step + step * 0.12, y0 + hh * 0.2, step * 0.76, hh * 0.46, poly.material === 'cafe' || (poly.material === 'office' && i % 2 === 0));
          if (poly.material === 'office') { g.fillStyle = '#4e7a56'; g.fillRect(x0, y0 + hh - 7, x1 - x0, 7); }
          if (poly.material === 'cafe') { g.fillStyle = '#b4442e'; g.fillRect(x0, y0 + hh - 6, x1 - x0, 6); }
        }
        break;
      }
      default: break;
    }
    g.restore();
  });
  top(g, pts, look.top, () => {
    g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 1.5;
    if (horizontal) { g.beginPath(); g.moveTo(r.x, r.y + r.h / 2); g.lineTo(r.x + r.w, r.y + r.h / 2); g.stroke(); }
  });
}

/* -- ships' gunwales and deck fittings --------------------------------------------------------------------------- */

function gunwale(g: G, poly: MapPoly, pts: Pt[], h: number): void {
  const lv = liveryOf(poly.group ?? '');
  front(g, pts, h, lv.hull, (a, b, hh) => {
    g.save();
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    g.fillStyle = lv.stripe;
    const slope = (b.y - a.y) / (b.x - a.x || 1);
    g.beginPath(); g.moveTo(a.x, a.y + hh - 6); g.lineTo(b.x, b.y + hh - 6); g.lineTo(b.x, b.y + hh); g.lineTo(a.x, a.y + hh); g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.lineTo(b.x, b.y + 3); g.lineTo(a.x, a.y + 3); g.closePath(); g.fill();
    void x0; void x1; void slope;
    g.restore();
  });
  top(g, pts, lv.cap, () => {
    // Rivets along the rail cap.
    g.fillStyle = 'rgba(30, 34, 40, 0.5)';
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      for (let t = 12; t < len - 6; t += 30) { g.beginPath(); g.arc(a.x + ((b.x - a.x) * t) / len, a.y + ((b.y - a.y) * t) / len, 1.5, 0, TAU); g.fill(); }
    }
  });
}

function round(g: G, poly: MapPoly, pts: Pt[], h: number, look: Look, detail: (cx: number, cy: number, r: number) => void): void {
  const r = rectOf(pts);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, rad = Math.min(r.w, r.h) / 2;
  // A cylinder: a front face hung under the south half, then the top disc.
  g.fillStyle = look.front; g.strokeStyle = INK; g.lineWidth = 2;
  g.beginPath(); g.moveTo(cx - rad, cy); g.lineTo(cx - rad, cy + h); g.arc(cx, cy + h, rad, Math.PI, 0, true); g.lineTo(cx + rad, cy); g.arc(cx, cy, rad, 0, Math.PI); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.14)'; g.beginPath(); g.ellipse(cx - rad * 0.4, cy + h * 0.55, rad * 0.12, h * 0.4, 0, 0, TAU); g.fill();
  g.beginPath(); g.arc(cx, cy, rad, 0, TAU); g.fillStyle = look.top; g.fill();
  g.save(); g.clip(); detail(cx, cy, rad); g.restore();
  g.strokeStyle = INK; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, rad, 0, TAU); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.3)'; g.beginPath(); g.ellipse(cx - rad * 0.35, cy - rad * 0.38, rad * 0.16, rad * 0.1, -0.6, 0, TAU); g.fill();
  void poly;
}

function paintOne(g: G, poly: MapPoly, pts: Pt[]): void {
  const h = poly.height ?? 14;
  const look = LOOKS[poly.material] ?? FALLBACK;
  const r = rectOf(pts);
  switch (poly.material) {
    case 'container': container(g, poly, pts, h); return;
    case 'hull': gunwale(g, poly, pts, h); return;
    case 'cabin': case 'shed': case 'office': case 'cafe': case 'navy': case 'plant': case 'loft': case 'dockwall': wall(g, poly, pts, h); return;
    case 'lighthouse': {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2, rad = r.w / 2;
      const stripes = 5, bodyH = 96;
      // The tower as a striped cylinder hanging down the screen, then its gallery and lantern room on top.
      for (let i = 0; i < stripes; i++) {
        const y0 = cy + (bodyH * i) / stripes, y1 = cy + (bodyH * (i + 1)) / stripes;
        g.fillStyle = i % 2 ? '#c24a38' : '#ece6d2';
        g.beginPath(); g.moveTo(cx - rad, y0); g.lineTo(cx - rad, y1); g.arc(cx, y1, rad, Math.PI, 0, true); g.lineTo(cx + rad, y0); g.arc(cx, y0, rad, 0, Math.PI); g.closePath(); g.fill();
        g.fillStyle = 'rgba(0,0,0,0.28)'; g.beginPath(); g.moveTo(cx + rad * 0.3, y0 + 0); g.lineTo(cx + rad, y0); g.arc(cx, y0, rad, 0, Math.PI * 0.45); g.closePath(); g.globalAlpha = 1;
      }
      g.strokeStyle = INK; g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx - rad, cy); g.lineTo(cx - rad, cy + bodyH); g.arc(cx, cy + bodyH, rad, Math.PI, 0, true); g.lineTo(cx + rad, cy); g.stroke();
      g.fillStyle = 'rgba(0,0,0,0.22)'; g.beginPath(); g.moveTo(cx + rad * 0.35, cy); g.lineTo(cx + rad * 0.35, cy + bodyH + 4); g.arc(cx, cy + bodyH, rad, 0.35, 0); g.lineTo(cx + rad, cy); g.closePath(); g.fill();
      // Gallery ring and the lantern.
      g.beginPath(); g.arc(cx, cy, rad + 8, 0, TAU); g.fillStyle = '#4a4f58'; g.fill(); g.stroke();
      g.beginPath(); g.arc(cx, cy, rad - 6, 0, TAU); g.fillStyle = '#e8e2d0'; g.fill(); g.stroke();
      g.beginPath(); g.arc(cx, cy, rad * 0.55, 0, TAU); g.fillStyle = '#ffe9b0'; g.fill(); g.stroke();
      g.fillStyle = '#c24a38'; g.beginPath(); g.arc(cx, cy, rad * 0.3, 0, TAU); g.fill(); g.stroke();
      return;
    }
    case 'drydockhull': {
      const lv = liveryOf('cutter');
      front(g, pts, h, lv.stripe, (a, b, hh) => { g.fillStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.moveTo(a.x, a.y + hh * 0.5); g.lineTo(b.x, b.y + hh * 0.5); g.lineTo(b.x, b.y + hh); g.lineTo(a.x, a.y + hh); g.closePath(); g.fill(); });
      top(g, pts, '#6f7f86', () => {
        g.strokeStyle = 'rgba(30,34,40,0.35)'; g.lineWidth = 2;
        g.beginPath(); for (let y = r.y + 14; y < r.y + r.h; y += 22) { g.moveTo(r.x, y); g.lineTo(r.x + r.w, y); } g.stroke();
        g.fillStyle = '#4a545a'; g.fillRect(r.x + r.w / 2 - 34, r.y + r.h * 0.38, 68, 96);
        g.strokeStyle = INK; g.strokeRect(r.x + r.w / 2 - 34, r.y + r.h * 0.38, 68, 96);
        g.fillStyle = '#c9c4b2'; g.beginPath(); g.arc(r.x + r.w / 2, r.y + r.h * 0.22, 15, 0, TAU); g.fill(); g.stroke();
        g.strokeStyle = '#a8442e'; g.lineWidth = 6; g.strokeRect(r.x + 14, r.y + 14, r.w - 28, r.h - 28);
      });
      return;
    }
    case 'turret': round(g, poly, pts, h, look, (cx, cy, rad) => { g.fillStyle = '#4e585e'; g.fillRect(cx - 6, cy - rad - 28, 12, rad + 24); g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(cx - 6, cy - rad - 28, 12, rad + 24); g.fillStyle = look.top; g.beginPath(); g.arc(cx, cy, rad * 0.62, 0, TAU); g.fill(); g.stroke(); }); return;
    case 'winch': round(g, poly, pts, h, look, (cx, cy, rad) => { g.strokeStyle = 'rgba(40,30,10,0.6)'; g.lineWidth = 3; for (let k = 1; k < 4; k++) { g.beginPath(); g.arc(cx, cy, (rad * k) / 4 + 2, 0, TAU); g.stroke(); } g.fillStyle = '#3a3220'; g.beginPath(); g.arc(cx, cy, 5, 0, TAU); g.fill(); }); return;
    case 'pump': round(g, poly, pts, h, look, (cx, cy, rad) => { g.strokeStyle = '#2c3e3e'; g.lineWidth = 6; g.beginPath(); g.moveTo(cx - rad, cy); g.lineTo(cx + rad, cy); g.moveTo(cx, cy - rad); g.lineTo(cx, cy + rad); g.stroke(); g.fillStyle = '#c24a38'; g.beginPath(); g.arc(cx, cy, rad * 0.26, 0, TAU); g.fill(); g.strokeStyle = INK; g.lineWidth = 2; g.stroke(); }); return;
    case 'coil': {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2, rad = Math.min(r.w, r.h) / 2;
      g.fillStyle = look.front; g.beginPath(); g.ellipse(cx, cy + 4, rad, rad, 0, 0, TAU); g.fill();
      for (let k = 0; k < 5; k++) { g.fillStyle = k % 2 ? '#b09468' : '#c9b080'; g.beginPath(); g.arc(cx, cy, rad * (1 - k * 0.18), 0, TAU); g.fill(); g.strokeStyle = 'rgba(40,30,15,0.55)'; g.lineWidth = 1.6; g.stroke(); }
      g.strokeStyle = INK; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, rad, 0, TAU); g.stroke();
      return;
    }
    case 'tyres': round(g, poly, pts, h, look, (cx, cy, rad) => { g.fillStyle = '#16171a'; g.beginPath(); g.arc(cx, cy, rad * 0.5, 0, TAU); g.fill(); g.strokeStyle = '#4a4c52'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, rad * 0.78, 0, TAU); g.stroke(); }); return;
    case 'lifeboat': {
      front(g, pts, h, look.front);
      top(g, pts, look.top, () => {
        g.fillStyle = '#f2ead6'; g.fillRect(r.x, r.y + r.h * 0.46, r.w, 8);
        g.fillStyle = '#d4c6a0'; g.fillRect(r.x + r.w * 0.2, r.y + 10, r.w * 0.6, r.h - 20);
        g.strokeStyle = 'rgba(60,40,20,0.5)'; g.lineWidth = 2; g.beginPath(); g.moveTo(r.x + r.w / 2, r.y + 10); g.lineTo(r.x + r.w / 2, r.y + r.h - 10); g.stroke();
      });
      return;
    }
    case 'hatch': {
      front(g, pts, h, look.front);
      top(g, pts, look.top, () => {
        g.strokeStyle = '#d6c14a'; g.lineWidth = 4; g.strokeRect(r.x + 6, r.y + 6, r.w - 12, r.h - 12);
        g.strokeStyle = 'rgba(30,34,30,0.45)'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(r.x + 8, r.y + 8); g.lineTo(r.x + r.w - 8, r.y + r.h - 8); g.moveTo(r.x + r.w - 8, r.y + 8); g.lineTo(r.x + 8, r.y + r.h - 8); g.stroke();
      });
      return;
    }
    case 'console': {
      front(g, pts, h, look.front);
      top(g, pts, look.top, () => {
        const n = Math.max(1, Math.floor(r.w / 46));
        for (let i = 0; i < n; i++) { g.fillStyle = '#16303a'; g.fillRect(r.x + 8 + i * (r.w - 16) / n, r.y + 6, (r.w - 16) / n - 6, Math.min(26, r.h - 12)); g.fillStyle = '#6fe0d0'; g.fillRect(r.x + 11 + i * (r.w - 16) / n, r.y + 9, (r.w - 16) / n - 12, 4); }
        g.fillStyle = '#c24a38'; g.beginPath(); g.arc(r.x + r.w - 10, r.y + r.h - 10, 4, 0, TAU); g.fill();
      });
      return;
    }
    case 'fishcrate': {
      front(g, pts, h, look.front);
      top(g, pts, look.top, () => {
        g.strokeStyle = 'rgba(10,30,40,0.5)'; g.lineWidth = 2;
        for (let x = r.x; x <= r.x + r.w; x += 34) { g.beginPath(); g.moveTo(x, r.y); g.lineTo(x, r.y + r.h); g.stroke(); }
        for (let y = r.y; y <= r.y + r.h; y += 34) { g.beginPath(); g.moveTo(r.x, y); g.lineTo(r.x + r.w, y); g.stroke(); }
        g.fillStyle = '#cfe6ec';
        for (let x = r.x + 17; x < r.x + r.w; x += 34) for (let y = r.y + 17; y < r.y + r.h; y += 34) { g.beginPath(); g.ellipse(x, y, 9, 4, (x + y) % 3, 0, TAU); g.fill(); }
      });
      return;
    }
    case 'icebench': {
      front(g, pts, h, look.front);
      top(g, pts, '#a9c3c7', () => {
        g.fillStyle = '#e4f1f4';
        for (let i = 0; i < r.w / 12; i++) { g.beginPath(); g.ellipse(r.x + 8 + hash2(i, r.x) * (r.w - 16), r.y + 8 + hash2(r.y, i) * (r.h - 16), 7, 4, i, 0, TAU); g.fill(); }
        g.fillStyle = '#6a8fa0';
        for (let i = 0; i < r.w / 52; i++) { g.beginPath(); g.ellipse(r.x + 24 + i * 52 + hash2(i, 5) * 10, r.y + r.h / 2, 18, 7, hash2(i, 9) - 0.5, 0, TAU); g.fill(); g.strokeStyle = 'rgba(20,40,50,0.6)'; g.lineWidth = 1.5; g.stroke(); }
      });
      return;
    }
    case 'counter': {
      front(g, pts, h, look.front);
      top(g, pts, look.top, () => {
        g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(r.x, r.y, r.w, 8);
        g.fillStyle = '#2f343c'; g.fillRect(r.x + r.w * 0.2, r.y + r.h * 0.2, 26, 18); g.fillStyle = '#6fe0d0'; g.fillRect(r.x + r.w * 0.2 + 3, r.y + r.h * 0.2 + 3, 20, 6);
        g.fillStyle = '#e4dcc8'; g.fillRect(r.x + r.w * 0.6, r.y + r.h * 0.45, 22, 14);
      });
      return;
    }
    case 'table': round(g, poly, pts, h, look, (cx, cy, rad) => { g.fillStyle = '#b4442e'; g.beginPath(); g.arc(cx, cy, rad * 0.8, 0, TAU); g.fill(); g.strokeStyle = '#f2ead6'; g.lineWidth = 3; for (let k = -1; k <= 1; k++) { g.beginPath(); g.moveTo(cx - rad, cy + k * 10); g.lineTo(cx + rad, cy + k * 10); g.stroke(); } g.fillStyle = '#f2ead6'; g.beginPath(); g.arc(cx, cy, 4, 0, TAU); g.fill(); }); return;
    case 'scanner': {
      front(g, pts, h, look.front);
      top(g, pts, look.top, () => { g.fillStyle = '#d6c14a'; for (let y = r.y; y < r.y + r.h; y += 20) g.fillRect(r.x, y, r.w, 8); g.fillStyle = '#16303a'; g.fillRect(r.x + 12, r.y + 12, r.w - 24, r.h - 24); g.fillStyle = '#6fe0d0'; g.fillRect(r.x + r.w / 2 - 14, r.y + r.h / 2 - 5, 28, 10); });
      return;
    }
    case 'rack': {
      front(g, pts, h, look.front);
      top(g, pts, look.top, () => {
        const n = Math.max(2, Math.floor(Math.max(r.w, r.h) / 28));
        g.fillStyle = '#44505a';
        for (let i = 0; i < n; i++) {
          const x = r.w >= r.h ? r.x + 6 + (i + 0.5) * ((r.w - 12) / n) : r.x + r.w / 2, y = r.w >= r.h ? r.y + r.h / 2 : r.y + 6 + (i + 0.5) * ((r.h - 12) / n);
          g.beginPath(); g.arc(x, y, Math.min(11, Math.min(r.w, r.h) / 2 - 3), 0, TAU); g.fill(); g.strokeStyle = INK; g.lineWidth = 1.6; g.stroke();
        }
      });
      return;
    }
    case 'crates': {
      front(g, pts, h, look.front);
      top(g, pts, look.top, () => {
        g.strokeStyle = 'rgba(40,26,10,0.5)'; g.lineWidth = 2.4;
        g.strokeRect(r.x + 5, r.y + 5, r.w - 10, r.h - 10);
        g.beginPath(); g.moveTo(r.x + 5, r.y + 5); g.lineTo(r.x + r.w - 5, r.y + r.h - 5); g.moveTo(r.x + r.w - 5, r.y + 5); g.lineTo(r.x + 5, r.y + r.h - 5); g.stroke();
      });
      return;
    }
    case 'crane': {
      front(g, pts, h, look.front, (a, b, hh) => { g.strokeStyle = 'rgba(40,40,30,0.5)'; g.lineWidth = 3; const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x); g.beginPath(); g.moveTo(x0, a.y); g.lineTo(x1, a.y + hh); g.moveTo(x1, a.y); g.lineTo(x0, a.y + hh); g.stroke(); });
      top(g, pts, look.top, () => { g.fillStyle = '#c24a38'; g.fillRect(r.x, r.y, r.w, 12); g.strokeStyle = 'rgba(40,40,30,0.5)'; g.lineWidth = 3; g.strokeRect(r.x + 10, r.y + 10, r.w - 20, r.h - 20); });
      return;
    }
    case 'frame': {
      front(g, pts, h, look.front);
      top(g, pts, look.top, () => { g.fillStyle = '#c24a38'; g.fillRect(r.x, r.y, r.w, 8); g.strokeStyle = 'rgba(30,34,40,0.5)'; g.lineWidth = 3; g.beginPath(); g.moveTo(r.x, r.y); g.lineTo(r.x + r.w, r.y + r.h); g.moveTo(r.x + r.w, r.y); g.lineTo(r.x, r.y + r.h); g.stroke(); });
      return;
    }
    case 'scrap': case 'wreck': {
      front(g, pts, h, look.front);
      top(g, pts, look.top, () => {
        const rr = (i: number) => hash2(Math.round(r.x) + i, Math.round(r.y) * 3 + i);
        const sheets = ['#8a5a3c', '#6e4a30', '#a46a44', '#5a5348', '#7a6a58', '#96432e'];
        for (let i = 0; i < 14; i++) {
          g.fillStyle = sheets[Math.floor(rr(i) * sheets.length)]!;
          g.save(); g.translate(r.x + rr(i + 20) * r.w, r.y + rr(i + 40) * r.h); g.rotate(rr(i + 60) * TAU);
          g.fillRect(-18 - rr(i) * 14, -8, 36 + rr(i + 3) * 28, 16 + rr(i + 5) * 10);
          g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 1.5; g.strokeRect(-18 - rr(i) * 14, -8, 36 + rr(i + 3) * 28, 16 + rr(i + 5) * 10);
          g.restore();
        }
        if (poly.material === 'wreck') { g.fillStyle = '#2c3640'; const long = r.w >= r.h; if (long) { g.fillRect(r.x + r.w * 0.55, r.y + 12, r.w * 0.2, r.h - 24); g.fillRect(r.x + r.w * 0.15, r.y + 12, r.w * 0.2, r.h - 24); } }
        g.fillStyle = 'rgba(0,0,0,0.16)'; g.fillRect(r.x, r.y + r.h * 0.7, r.w, r.h * 0.3);
      });
      return;
    }
    case 'scaffold': {
      front(g, pts, h, look.front);
      top(g, pts, look.top, () => { g.strokeStyle = 'rgba(50,34,16,0.55)'; g.lineWidth = 2; for (let y = r.y; y < r.y + r.h; y += 16) { g.beginPath(); g.moveTo(r.x, y); g.lineTo(r.x + r.w, y); g.stroke(); } g.strokeStyle = '#7a7e82'; g.lineWidth = 4; g.strokeRect(r.x + 3, r.y + 3, r.w - 6, r.h - 6); });
      return;
    }
    case 'cabinet': {
      front(g, pts, h, look.front);
      top(g, pts, look.top, () => { g.strokeStyle = 'rgba(30,34,40,0.55)'; g.lineWidth = 2; for (let x = r.x + 18; x < r.x + r.w; x += 28) { g.beginPath(); g.moveTo(x, r.y + 4); g.lineTo(x, r.y + r.h - 4); g.stroke(); } g.fillStyle = '#d6c14a'; g.fillRect(r.x + 4, r.y + 4, 8, 8); });
      return;
    }
    default: {
      front(g, pts, h, look.front);
      top(g, pts, look.top);
    }
  }
}

/* -- the set-piece hook ------------------------------------------------------------------------------------------ */

let sprites = new WeakMap<MapPoly, Sprite>();
onMapChange(() => { sprites = new WeakMap(); });

function spriteOf(poly: MapPoly): Sprite {
  let s = sprites.get(poly);
  if (s) return s;
  const sh = shapeOf(poly);
  const h = poly.height ?? 14;
  const pad = 12 + (poly.material === 'lighthouse' ? 100 : 0);
  s = sprite(`harbor:${poly.id ?? `${sh.x0},${sh.y0}`}`, sh.x1 - sh.x0, sh.y1 - sh.y0 + h, pad, (g) => {
    g.translate(-sh.x0, -sh.y0);
    paintOne(g, poly, sh.pts);
  });
  sprites.set(poly, s);
  return s;
}

const SHIP_GROUPS = new Set(['kestrel', 'trawler', 'patrol']);
const shipId = (group: string | undefined): string | null => {
  if (!group) return null;
  const base = group.endsWith('~') ? group.slice(0, -1) : group;
  return SHIP_GROUPS.has(base) ? group : null;
};

/** Paints a whole group (a ship with everything on its deck, a stack of containers, a building's walls) in depth order. */
export function drawHarborSet(g: CanvasRenderingContext2D, group: readonly MapPoly[], info: GeoInfo): boolean {
  const drawn = group.filter((p) => p.material !== 'water');
  if (!drawn.length) return true;
  const ship = shipId(drawn[0]!.group);
  const bob = ship ? bobOf(ship, info.now) : null;
  const ordered = [...drawn].sort((a, b) => {
    // A ship's gunwale goes first, then its fittings north to south; everything else north to south, low before tall.
    const ga = a.material === 'hull' ? 0 : 1, gb = b.material === 'hull' ? 0 : 1;
    if (ship && ga !== gb) return ga - gb;
    const ya = shapeOf(a).y1, yb = shapeOf(b).y1;
    return ya - yb || (a.height ?? 14) - (b.height ?? 14);
  });
  g.save();
  if (bob) g.translate(0, bob.dy);
  for (const p of ordered) {
    const sh = shapeOf(p);
    if (sh.x1 < info.view.x0 - 60 || sh.x0 > info.view.x1 + 60 || sh.y1 + 140 < info.view.y0 || sh.y0 > info.view.y1) continue;
    // The vehicle kit's hull carries the gunwale once it has baked (harborships.ts drawShips).
    if (p.material === 'hull' && kitHulls.has(p.group ?? '')) { claimShadows([p]); continue; }
    stamp(g, spriteOf(p), sh.x0, sh.y0);
  }
  g.restore();
  void SIZE;
  return true;
}
