import type { MapDoor, MapPoly, MapRoof, Pt } from '../../shared/geom.ts';
import type { DoorLeaf } from '../../shared/sim/doors.ts';
import { drawExtruded, type PolyLook } from '../geoart.ts';
import { drawVehicle, vehicleSprite } from '../vehicleart.ts';
import type { GeoInfo } from '../geoart.ts';
import { C, TAU, bake, baseId, boundsOf, hash, hashStr, inPoly, isTwin, southEdges, trace, wound, wreckPlacement, type Sprite } from './wastelandkit.ts';
import { onMapChange } from '../mapscope.ts';

/**
 * Polygon art: every poly and roof is baked once into a sprite (the engine calls these hooks every frame) and doors are
 * drawn live because they move. Each twin of the map wears the other half's costume: the overpass girder is the airliner's
 * fuselage, the station's canopy the market's awning, the shanty's gate the bunker's blast door, the pool's glass roof the church's slates.
 */
type G = CanvasRenderingContext2D;

const mix = (hex: string, to: number, t: number): string => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (to - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};
const look = (top: string): PolyLook => ({ top, front: mix(top, 0, 0.42), lit: mix(top, 255, 0.24), shade: mix(top, 0, 0.3) });

/* ---------------------------------------------------------------- polygons */

let sprites = new WeakMap<MapPoly, { s: Sprite; pad: number }>();
onMapChange(() => { sprites = new WeakMap(); roofSprites.clear(); });

/** A crack as a chunk: a tapering wedge cut into the surface, dark with a lit lip on its low side. */
function wedgeCut(g: G, x: number, y: number, ang: number, len: number, w: number, seed: number) {
  const n = 5, up: Pt[] = [], dn: Pt[] = [];
  let cx = x, cy = y, a = ang;
  for (let i = 0; i <= n; i++) {
    const ww = Math.sin((i / n) * Math.PI) * w;
    up.push({ x: cx + Math.cos(a + 1.57) * ww, y: cy + Math.sin(a + 1.57) * ww }); dn.push({ x: cx - Math.cos(a + 1.57) * ww, y: cy - Math.sin(a + 1.57) * ww });
    a += (hash(seed, i, 41) - 0.5) * 0.9; cx += (Math.cos(a) * len) / n; cy += (Math.sin(a) * len) / n;
  }
  g.fillStyle = 'rgba(255,244,214,0.16)'; trace(g, [...up, ...[...dn].reverse()].map((q) => ({ x: q.x + 1.5, y: q.y + 2 }))); g.fill();
  g.fillStyle = 'rgba(22,19,16,0.62)'; trace(g, [...up, ...[...dn].reverse()]); g.fill();
}

/** Ribbed sheet metal: lit ridges and shaded troughs across `b`, with ink panel joints, bolts and rust streaks. */
function ribbed(g: G, b: { x0: number; y0: number; x1: number; y1: number }, vertical: boolean, seed: number, pitch = 26) {
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  for (let t = 0; t < (vertical ? w : h); t += pitch) {
    g.fillStyle = 'rgba(8,8,12,0.22)'; if (vertical) g.fillRect(b.x0 + t + pitch * 0.55, b.y0, pitch * 0.45, h); else g.fillRect(b.x0, b.y0 + t + pitch * 0.55, w, pitch * 0.45);
    g.fillStyle = 'rgba(255,248,226,0.2)'; if (vertical) g.fillRect(b.x0 + t + 2, b.y0, 4, h); else g.fillRect(b.x0, b.y0 + t + 2, w, 4);
  }
  g.strokeStyle = C.ink; g.lineWidth = 2;
  const J = 170;
  for (let t = J; t < (vertical ? h : w); t += J) {
    g.beginPath(); if (vertical) { g.moveTo(b.x0, b.y0 + t); g.lineTo(b.x1, b.y0 + t); } else { g.moveTo(b.x0 + t, b.y0); g.lineTo(b.x0 + t, b.y1); } g.stroke();
    for (let k = 12; k < (vertical ? w : h); k += 34) { g.fillStyle = '#2b2a2a'; g.beginPath(); if (vertical) g.arc(b.x0 + k, b.y0 + t + 6, 2.4, 0, TAU); else g.arc(b.x0 + t + 6, b.y0 + k, 2.4, 0, TAU); g.fill(); }
  }
  g.fillStyle = 'rgba(130,56,24,0.5)';
  for (let k = 0; k < Math.round((vertical ? w : h) / 60); k++) {
    const px = b.x0 + hash(seed, k, 50) * w, py = vertical ? b.y0 + hash(seed, k, 52) * h * 0.3 : b.y0 + hash(seed, k, 53) * h, ln = 26 + hash(seed, k, 54) * 40;
    g.beginPath(); g.moveTo(px - 4, py); g.lineTo(px + 4, py); g.lineTo(px + 1.5, py + ln); g.lineTo(px - 1.5, py + ln); g.closePath(); g.fill();
  }
}

function topClip(g: G, pts: readonly Pt[], paint: () => void) { g.save(); trace(g, pts); g.clip(); paint(); g.restore(); }

/** Chunky rebar tufts sprouting from a broken edge. */
function rebarAt(g: G, x: number, y: number, a: number, n: number, seed: number) {
  for (let i = 0; i < n; i++) {
    const aa = a + (hash(seed, i, 1) - 0.5) * 0.9, len = 14 + hash(seed, i, 2) * 16, ox = (i - (n - 1) / 2) * 9;
    const bx = x + Math.cos(a + Math.PI / 2) * ox, by = y + Math.sin(a + Math.PI / 2) * ox;
    g.lineCap = 'round';
    g.strokeStyle = C.ink; g.lineWidth = 5.4; g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + Math.cos(aa) * len, by + Math.sin(aa) * len); g.stroke();
    g.strokeStyle = C.rust; g.lineWidth = 3; g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + Math.cos(aa) * len, by + Math.sin(aa) * len); g.stroke();
  }
}

/** A boulder of crater rock: facets fanned from an inner point, each lit by the key light (top left) in three hard steps, ink seams between them, a lit lip along the lit edges, moss in the low corners and a few pits. */
function rockFacets(g: G, pts: readonly Pt[], seed: number) {
  const b = boundsOf(pts), n = pts.length;
  const segDist = (px: number, py: number, a: Pt, c: Pt) => {
    const dx = c.x - a.x, dy = c.y - a.y, t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(px - a.x - t * dx, py - a.y - t * dy);
  };
  // the inner point: the spot inside the polygon farthest from every edge
  let cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, far = -1;
  for (let k = 0; k < 90; k++) {
    const x = b.x0 + hash(seed, k, 60) * (b.x1 - b.x0), y = b.y0 + hash(seed, k, 61) * (b.y1 - b.y0);
    if (!inPoly(x, y, pts)) continue;
    let d = Infinity;
    for (let i = 0; i < n; i++) d = Math.min(d, segDist(x, y, pts[i]!, pts[(i + 1) % n]!));
    if (d > far) { far = d; cx = x; cy = y; }
  }
  const base = '#5f6a54';
  const lit = mix(base, 255, 0.28), mid = mix(base, 255, 0.04), shade = mix(base, 0, 0.3), deep = mix(base, 0, 0.5);
  const facets: { a: Pt; c: Pt; k: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!, c = pts[(i + 1) % n]!, mx = (a.x + c.x) / 2 - cx, my = (a.y + c.y) / 2 - cy, ml = Math.hypot(mx, my) || 1;
    const k = -(0.62 * mx + 0.78 * my) / ml;
    facets.push({ a, c, k });
    g.fillStyle = k > 0.4 ? lit : k > -0.15 ? mid : k > -0.6 ? shade : deep;
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(c.x, c.y); g.lineTo(cx, cy); g.closePath(); g.fill();
  }
  // seams between the facets, and a lit lip on the edges that face the light
  g.lineJoin = 'round'; g.strokeStyle = 'rgba(28,31,38,0.6)'; g.lineWidth = 2;
  g.beginPath(); for (const f of facets) { g.moveTo(cx, cy); g.lineTo(f.a.x, f.a.y); } g.stroke();
  g.strokeStyle = mix(base, 255, 0.5); g.lineWidth = 3; g.lineCap = 'round';
  for (const f of facets) if (f.k > 0.55) {
    const ix = (cx - (f.a.x + f.c.x) / 2) * 0.06, iy = (cy - (f.a.y + f.c.y) / 2) * 0.06;
    g.beginPath(); g.moveTo(f.a.x + ix, f.a.y + iy); g.lineTo(f.c.x + ix, f.c.y + iy); g.stroke();
  }
  // moss gathers in the south and east corners; a few pits and chips on the face
  g.fillStyle = 'rgba(107,139,75,0.55)';
  for (const f of facets) if (f.k < -0.3 && hash(seed, Math.round(f.a.x), 62) < 0.6) { g.beginPath(); g.ellipse(f.a.x - (f.a.x - cx) * 0.12, f.a.y - (f.a.y - cy) * 0.12, 11 + hash(seed, Math.round(f.a.y), 63) * 8, 7, 0.3, 0, TAU); g.fill(); }
  for (let k = 0; k < 4; k++) {
    const x = cx + (hash(seed, k, 64) - 0.5) * (b.x1 - b.x0) * 0.6, y = cy + (hash(seed, k, 65) - 0.5) * (b.y1 - b.y0) * 0.6;
    if (!inPoly(x, y, pts)) continue;
    g.fillStyle = 'rgba(22,26,22,0.5)'; g.beginPath(); g.ellipse(x, y, 7 + hash(seed, k, 66) * 5, 4.5, 0.4, 0, TAU); g.fill();
    g.fillStyle = 'rgba(214,230,196,0.22)'; g.beginPath(); g.ellipse(x - 1.5, y + 2.5, 7 + hash(seed, k, 66) * 5, 3, 0.4, 0, TAU); g.fill();
  }
}

// TODO(vehicleart): when docs/maps/VEHICLES.md's drawVehicle lands, paint the 'wreck' shapes (car, bus, truck) and the airliner halves
// (twin of spanA/spanB) with it at wreckPlacement(p); this hand-drawn version is the fallback and the collision stays as is.
function paintPoly(g: G, p: MapPoly, pts: Pt[]) {
  const id = p.id ?? '', twin = isTwin(id), seed = Math.floor(hashStr(baseId(id)) * 1e6), h = p.height ?? 14;
  const mat = p.material;
  const top = (() => {
    switch (mat) {
      case 'span': return twin ? C.alu : C.concrete;
      case 'wreck': return mix(['#8a4a3a', '#6f7f7a', '#9a8a64', '#7a4a3a', '#4f6f78', '#8a6a4a'][Math.floor(hash(seed, 3) * 6)]!, 0, 0.12);
      case 'frame': return twin ? C.steelLo : C.rust;
      case 'rim': return '#5f6a54';
      case 'sign': return '#3f4a52';
      case 'barrel': return '#8a4a2e';
      case 'post': return C.steel;
      case 'low': return id.startsWith('pew') ? (twin ? C.paintTeal : C.wood) : C.concreteHi;
      case 'ruin': return C.concreteHi;
      default: return C.steel;
    }
  })();
  const l = look(top);
  drawExtruded(g, pts, h, l);
  const b = boundsOf(pts);
  topClip(g, pts, () => {
    if (mat === 'span') {
      if (p.part === 'shell') {
        const horiz = b.x1 - b.x0 > b.y1 - b.y0;
        if (twin) {
          // fuselage skin: seams, a row of dark windows and the airline's stripe
          g.fillStyle = C.paintBlue; if (horiz) g.fillRect(b.x0, b.y0 + (b.y1 - b.y0) * 0.55, b.x1 - b.x0, 8);
          for (let x = b.x0 + 14; x < b.x1 - 10; x += 38) { if (hash(seed, x, 4) < 0.1) continue; g.fillStyle = '#26303c'; g.fillRect(x, b.y0 + 8, 16, 11); g.fillStyle = 'rgba(180,215,240,0.4)'; g.fillRect(x, b.y0 + 8, 16, 3); }
          g.fillStyle = 'rgba(40,50,64,0.5)'; for (let x = b.x0 + 60; x < b.x1; x += 120) g.fillRect(x, b.y0, 3, b.y1 - b.y0);
        } else {
          // parapet: faded edge line and chipped concrete
          g.fillStyle = hashStr(id) < 0.5 ? 'rgba(210,196,120,0.55)' : 'rgba(225,220,200,0.5)'; if (horiz) g.fillRect(b.x0, b.y0 + 14, b.x1 - b.x0, 6);
          for (let x = b.x0 + 50; x < b.x1; x += 110) wedgeCut(g, x, b.y0 + 4, 1.4, 30, 3.4, seed + x);
          g.fillStyle = C.ink; for (let x = b.x0 + 120; x < b.x1; x += 180) g.fillRect(x, b.y0, 2, b.y1 - b.y0);
        }
      } else if (p.part === 'cap' && twin) {
        g.fillStyle = '#26303c'; for (let i = 0; i < 3; i++) { const cx = (b.x0 + b.x1) / 2 + (hash(seed, 5) < 0.5 ? 1 : -1) * 10; g.fillRect(cx - 16, b.y0 + (b.y1 - b.y0) / 2 - 24 + i * 16, 14, 11); }
      } else if (p.part === 'wing' || p.part === 'tailplane' || p.part === 'fallen') {
        if (twin && p.part !== 'fallen') { g.fillStyle = C.paintRed; g.fillRect(b.x0, b.y0, b.x1 - b.x0, 14); g.fillStyle = 'rgba(40,50,64,0.5)'; for (let y = b.y0 + 40; y < b.y1; y += 46) g.fillRect(b.x0, y, b.x1 - b.x0, 3); }
        else if (p.part === 'fallen') { ribbed(g, b, true, seed, 24); g.fillStyle = 'rgba(14,12,10,0.4)'; g.fillRect(b.x0, b.y1 - 40, b.x1 - b.x0, 40); }
        else if ((p.part as string) === 'fallen') { ribbed(g, b, true, seed, 24); g.fillStyle = 'rgba(14,12,10,0.4)'; g.fillRect(b.x0, b.y1 - 40, b.x1 - b.x0, 40); }
        else { g.fillStyle = 'rgba(225,220,200,0.45)'; g.fillRect(b.x0, (b.y0 + b.y1) / 2 - 3, b.x1 - b.x0, 6); for (let k = 0; k < 5; k++) wedgeCut(g, b.x0 + hash(seed, k, 6) * (b.x1 - b.x0), b.y0 + hash(seed, k, 7) * (b.y1 - b.y0), hash(seed, k, 8) * 6, 36, 4, seed + k); g.fillStyle = C.ink; for (let y = b.y0 + 110; y < b.y1; y += 140) g.fillRect(b.x0, y, b.x1 - b.x0, 2); }
      } else if (p.part === 'engine') {
        g.fillStyle = twin ? '#8a95a3' : '#6c6a62'; for (let k = 0; k < 6; k++) g.fillRect(b.x0 + 8 + k * 12, b.y0 + 4, 5, b.y1 - b.y0 - 8);
      }
    } else if (mat === 'wreck') {
      const pl = wreckPlacement(p);
      g.fillStyle = 'rgba(120,52,24,0.45)'; for (let k = 0; k < 5; k++) { g.beginPath(); g.ellipse(b.x0 + hash(seed, k, 8) * (b.x1 - b.x0), b.y0 + hash(seed, k, 9) * (b.y1 - b.y0), 14, 8, 0.4, 0, TAU); g.fill(); }
      if (pl) {
        g.save(); g.translate(pl.x, pl.y); g.rotate(pl.rot); g.scale(pl.scale, pl.scale);
        const shape = p.shape;
        g.fillStyle = '#242a32';
        if (shape === 'car') { g.fillRect(-60, -48, 40, 96 * 0.0 + 8); g.beginPath(); g.moveTo(-18, -54); g.lineTo(50, -58); g.lineTo(60, -36); g.lineTo(60, 36); g.lineTo(50, 52); g.lineTo(-18, 50); g.closePath(); g.globalAlpha = 0.0; g.fill(); g.globalAlpha = 1;
          g.fillStyle = '#242a32'; g.beginPath(); g.moveTo(-26, -42); g.lineTo(6, -46); g.lineTo(10, 44); g.lineTo(-26, 40); g.closePath(); g.fill();
          g.fillStyle = 'rgba(190,215,235,0.25)'; g.fillRect(-22, -40, 4, 76);
          g.fillStyle = 'rgba(20,18,16,0.5)'; g.fillRect(40, -28, 70, 56); }
        else if (shape === 'bus') { for (let x = -330; x < 330; x += 58) { g.fillStyle = '#242a32'; g.fillRect(x, -70, 38, 20); g.fillRect(x, 50, 38, 20); }
          g.fillStyle = hexOf(C.mustard); g.fillRect(-380, -8, 760, 14); g.fillStyle = 'rgba(70,110,50,0.7)'; for (let k = 0; k < 16; k++) { g.beginPath(); g.arc(-360 + hash(seed, k, 10) * 720, (hash(seed, k, 11) - 0.5) * 140, 14 + hash(seed, k, 12) * 14, 0, TAU); g.fill(); } }
        else { g.fillStyle = '#242a32'; g.fillRect(150, -60, 56, 40); g.fillRect(150, 20, 56, 40); g.fillStyle = 'rgba(0,0,0,0.25)'; for (let x = -220; x < 100; x += 24) g.fillRect(x, -76, 5, 152); }
        g.restore();
      }
    } else if (mat === 'frame') {
      g.strokeStyle = 'rgba(40,20,10,0.55)'; g.lineWidth = 3;
      if (p.part === 'tank') { for (const f of [0.35, 0.65]) { g.beginPath(); g.arc((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.x1 - b.x0) * f * 0.5, 0, TAU); g.stroke(); } g.fillStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.ellipse((b.x0 + b.x1) / 2 - 30, (b.y0 + b.y1) / 2 - 36, 30, 12, -0.5, 0, TAU); g.fill();
        g.fillStyle = hexOf(C.bone); g.font = '800 30px "Barlow Condensed", "Arial Narrow", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(twin ? 'RELAY 3' : 'HOPE', (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2); }
      else { for (let x = b.x0 + 20; x < b.x1; x += 44) { g.beginPath(); g.moveTo(x, b.y0); g.lineTo(x + 30, b.y1); g.moveTo(x + 30, b.y0); g.lineTo(x, b.y1); g.stroke(); } }
    } else if (mat === 'rim') {
      rockFacets(g, pts, seed);
    } else if (mat === 'barrel') {
      g.fillStyle = '#2a2420'; g.beginPath(); g.arc((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, 17, 0, TAU); g.fill(); g.fillStyle = 'rgba(255,150,60,0.6)'; g.beginPath(); g.arc((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, 10, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(20,12,8,0.6)'; g.lineWidth = 2; g.beginPath(); g.arc((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, 22, 0, TAU); g.stroke();
    } else if (mat === 'sign') {
      /* painted in the front face below */
    } else if (mat === 'low' && id.startsWith('pew')) {
      g.strokeStyle = 'rgba(20,12,6,0.5)'; g.lineWidth = 2; const horiz = b.x1 - b.x0 > b.y1 - b.y0; g.beginPath(); for (let t = 0; t < 4; t++) { if (horiz) { g.moveTo(b.x0, b.y0 + 6 + t * 8); g.lineTo(b.x1, b.y0 + 6 + t * 8); } else { g.moveTo(b.x0 + 12, b.y0 + t * 40); g.lineTo(b.x0 + 12, b.y0 + t * 40 + 4); } } g.stroke();
    } else if (mat === 'ruin') {
      g.strokeStyle = 'rgba(30,27,22,0.5)'; g.lineWidth = 2; for (let y = b.y0 + 20; y < b.y1; y += 26) { g.beginPath(); g.moveTo(b.x0, y); g.lineTo(b.x1, y); g.stroke(); }
    }
  });
  // front-face artwork: the billboard and the fallen gantry carry their message on the face people see
  if (mat === 'sign') {
    const [e0] = southEdges(pts);
    if (e0) {
      const x0 = Math.min(e0[0].x, e0[1].x), x1 = Math.max(e0[0].x, e0[1].x), y = Math.min(e0[0].y, e0[1].y);
      g.save(); g.beginPath(); g.rect(x0, y, x1 - x0, h); g.clip();
      if (id === 'billboard') {
        g.fillStyle = '#d9cfa8'; g.fillRect(x0, y, x1 - x0, h);
        g.fillStyle = '#6f9aa8'; g.fillRect(x0, y, x1 - x0, h * 0.5);
        g.fillStyle = '#d9a84a'; g.beginPath(); g.arc(x0 + 60, y + 24, 14, 0, TAU); g.fill();
        g.fillStyle = '#3e5a36'; g.beginPath(); g.moveTo(x0, y + h * 0.5); for (let x = 0; x <= x1 - x0; x += 30) g.lineTo(x0 + x, y + h * 0.35 + (x % 60 ? 6 : -4)); g.lineTo(x1, y + h * 0.5); g.closePath(); g.fill();
        g.fillStyle = '#2e2a26'; g.font = '800 17px "Barlow Condensed", "Arial Narrow", sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText('SUNNY ACRES', x0 + 90, y + 22); g.font = '700 11px "Barlow Condensed", "Arial Narrow", sans-serif'; g.fillText('A GREAT PLACE TO LIVE', x0 + 92, y + 40);
        g.save(); g.translate(x0 + 270, y + 52); g.rotate(-0.06); g.fillStyle = '#b4382e'; g.font = '800 22px "Barlow Condensed", "Arial Narrow", sans-serif'; g.fillText('NOT ANYMORE', 0, 0); g.restore();
      } else {
        g.fillStyle = '#2f6a4a'; g.fillRect(x0, y, x1 - x0, h); g.fillStyle = hexOf(C.bone); g.font = '800 15px "Barlow Condensed", "Arial Narrow", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('EXIT 9  ▸  WATER 2 CANS', (x0 + x1) / 2, y + h / 2);
      }
      g.restore();
      g.strokeStyle = C.ink; g.lineWidth = 2; g.strokeRect(x0, y, x1 - x0, h);
    }
  }
  // rebar at the broken ends of the overpass and the torn edges of the plane
  if (mat === 'span' && (p.part === 'shell' || p.part === 'wing' || p.part === 'fallen')) {
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i]!, c = pts[(i + 1) % n]!;
      const len = Math.hypot(c.x - a.x, c.y - a.y);
      if (len > 50 || len < 30) continue;
      if (twin && p.part === 'shell') { g.strokeStyle = C.flare; g.lineWidth = 3; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo((a.x + c.x) / 2 + 6, (a.y + c.y) / 2 + 9); g.lineTo(c.x, c.y); g.stroke(); continue; }
      if (!twin) rebarAt(g, (a.x + c.x) / 2, (a.y + c.y) / 2, Math.atan2(c.y - a.y, c.x - a.x) - Math.PI / 2, 3, seed + i);
    }
  }
}

const hexOf = (c: string) => c;

/** Wrecks drawn by the vehicle kit (docs/maps/VEHICLES.md): which model each wreck shape is, and the airliner's two halves. */
const WRECK_KIND = { car: ['sedan', 'pickup'], bus: ['schoolBus'], truck: ['boxTruck'] } as const;
const LIVERIES = ['rust', 'blue', 'cream', 'red', 'green'] as const;
const AIRLINER = { 'spanA-cap~': { kind: 'airlinerFront', x: 5285, y: 4500 }, 'spanB-cap~': { kind: 'airlinerTail', x: 4080, y: 4500 } } as const;

function kitPoly(g: G, p: MapPoly, info: GeoInfo): boolean {
  const id = p.id ?? '';
  if (p.material === 'wreck') {
    const pl = wreckPlacement(p), kinds = WRECK_KIND[p.shape as keyof typeof WRECK_KIND];
    if (!pl || !kinds) return false;
    const seed = hashStr(baseId(id));
    const kind = kinds[Math.floor(seed * 7) % kinds.length]!;
    return drawVehicle(g, kind, { ...pl, livery: kind === 'schoolBus' ? 'yellow' : LIVERIES[Math.floor(seed * 1e3) % LIVERIES.length], variant: isTwin(id) || kind === 'schoolBus' ? 'vines' : 'wreck', t: info.now, polys: [p] });
  }
  // The overpass's twin is the airliner: one hollow half drawn whole at its cap, the shell's other walls left to it.
  if (p.material === 'span' && isTwin(id) && /^span[AB]-/.test(id)) {
    const a = AIRLINER[id as keyof typeof AIRLINER];
    if (a) return drawVehicle(g, a.kind, { x: a.x, y: a.y, rot: 0, variant: 'hollow', t: info.now, polys: [p] });
    return p.part === 'shell' && !!vehicleSprite(id.startsWith('spanA') ? 'airlinerFront' : 'airlinerTail', { x: 0, y: 0, variant: 'hollow' });
  }
  return false;
}

export function drawPoly(g: G, p: MapPoly, info: GeoInfo): boolean {
  if (kitPoly(g, p, info)) return true;
  let e = sprites.get(p);
  if (!e) {
    const pts = wound(p.points);
    const b = boundsOf(pts), pad = 44;
    e = { s: bake(b.x0 - pad, b.y0 - pad, b.x1 + pad, b.y1 + (p.height ?? 14) + pad, (c) => paintPoly(c, p, pts)), pad };
    sprites.set(p, e);
  }
  g.drawImage(e.s.canvas, e.s.x, e.s.y);
  return true;
}

/* ---------------------------------------------------------------- roofs */

const roofSprites = new Map<string, Sprite>();

function roofPaint(g: G, r: MapRoof, pts: Pt[]) {
  const id = baseId(r.id), twin = isTwin(r.id), seed = Math.floor(hashStr(id) * 1e6);
  const b = boundsOf(pts);
  const kind = id.startsWith('spanA') || id.startsWith('spanB') ? (twin ? 'fuselage' : 'deck')
    : id === 'hall' ? (twin ? 'slate' : 'glass')
    : id === 'gs-canopy' ? (twin ? 'awning' : 'canopy')
    : id === 'gs-wash' ? (twin ? 'tarp' : 'tin')
    : id === 'gs-store' ? (twin ? 'tarp' : 'flat')
    : id.startsWith('sh') ? (twin ? 'slab' : 'tin')
    : id === 'redcamp-tarp' ? 'tarp'
    : id === 'vestry' ? (twin ? 'slate' : 'flat')
    : r.material ?? 'tin';
  const baseTop = { deck: C.concreteHi, fuselage: C.aluHi, slate: '#5a5e68', glass: '#7fa8a8', canopy: '#a8a090', awning: C.paintRed, tin: C.scrapA, flat: C.concreteHi, tarp: C.tarpBlue, slab: '#6a6e74', sheet: C.scrapC }[kind] ?? C.scrapA;
  const l = look(baseTop);
  drawExtruded(g, pts, 10, l);
  g.save(); trace(g, pts); g.clip();
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  if (kind === 'tin' || kind === 'sheet') {
    // One corrugated-iron roof, not a rug: a single main colour (the sheets differ only a little in value), ribs running down the
    // slope, two repair sheets in a second colour lapped over it, ink laps with bolt rows, and the eave shaded and the ridge lit.
    const mains = [C.scrapA, C.scrapB, C.scrapC, C.scrapD] as const;
    const main = mains[Math.floor(hash(seed, 0, 40) * mains.length)]!;
    const others = [C.scrapE, C.scrapF, C.scrapA, C.scrapB, C.scrapD].filter((c) => c !== main);
    const patchCol = others[Math.floor(hash(seed, 1, 40) * others.length)]!;
    const sh = 66, rib = 11, nSheets = Math.ceil(w / sh);
    const patched = new Set([Math.floor(hash(seed, 2, 41) * nSheets), Math.floor(hash(seed, 3, 41) * nSheets)]);
    const ribs = (x: number, y: number, ww: number, hh: number) => {
      for (let rx = x + 2; rx < x + ww - 2; rx += rib) {
        g.fillStyle = 'rgba(255,244,220,0.2)'; g.fillRect(rx, y, rib * 0.38, hh);
        g.fillStyle = 'rgba(8,8,10,0.24)'; g.fillRect(rx + rib * 0.62, y, rib * 0.38, hh);
      }
    };
    for (let x = b.x0, i = 0; x < b.x1; x += sh, i++) {
      g.fillStyle = mix(main, (hash(seed, i, 1) - 0.5) * 0.1 > 0 ? 255 : 0, Math.abs(hash(seed, i, 1) - 0.5) * 0.2); g.fillRect(x, b.y0, sh, h);
      ribs(x, b.y0, sh, h);
      if (patched.has(i)) {
        const py = b.y0 + h * (0.12 + hash(seed, i, 42) * 0.4), ph = Math.min(h * 0.42, 190);
        g.fillStyle = mix(patchCol, 0, 0.08); g.fillRect(x + 3, py, sh - 6, ph);
        ribs(x + 3, py, sh - 6, ph);
        g.fillStyle = 'rgba(8,8,12,0.22)'; g.fillRect(x + 3, py + ph - 6, sh - 6, 6);
        g.strokeStyle = C.ink; g.lineWidth = 2; g.strokeRect(x + 3, py, sh - 6, ph);
        g.fillStyle = '#2b2a2a'; for (const cxb of [x + 8, x + sh - 8]) for (const cyb of [py + 8, py + ph - 8]) { g.beginPath(); g.arc(cxb, cyb, 2.4, 0, TAU); g.fill(); }
      }
      // the lap: ink line, a lit lip on the near side of it and a shade on the sheet that tucks under
      g.strokeStyle = C.ink; g.lineWidth = 2; g.beginPath(); g.moveTo(x, b.y0); g.lineTo(x, b.y1); g.stroke();
      g.fillStyle = 'rgba(255,248,226,0.24)'; g.fillRect(x + 2, b.y0, 4, h); g.fillStyle = 'rgba(8,8,12,0.28)'; g.fillRect(x + sh - 8, b.y0, 6, h);
      for (let yb = b.y0 + 16; yb < b.y1; yb += 40) { g.fillStyle = '#2b2a2a'; g.beginPath(); g.arc(x + 12, yb, 2.4, 0, TAU); g.fill(); g.beginPath(); g.arc(x + sh - 12, yb, 2.4, 0, TAU); g.fill(); }
      g.fillStyle = 'rgba(130,56,24,0.45)'; const rx0 = x + 14 + hash(seed, i, 30) * (sh - 30); g.beginPath(); g.moveTo(rx0, b.y0); g.lineTo(rx0 + 8, b.y0); g.lineTo(rx0 + 4, b.y0 + 30 + hash(seed, i, 31) * 60); g.closePath(); g.fill();
      if (hash(seed, i, 32) < 0.2) wedgeCut(g, x + 18, b.y0 + h * 0.3 + hash(seed, i, 33) * h * 0.4, 0.3, 40, 4.5, seed + i);
    }
    g.fillStyle = 'rgba(255,248,226,0.2)'; g.fillRect(b.x0, b.y0, w, 9);
    g.fillStyle = 'rgba(8,8,12,0.26)'; g.fillRect(b.x0, b.y1 - 14, w, 14);
    // weights on top: a few tyres and bricks
    for (let k = 0; k < Math.round((w * h) / 60000); k++) { const x = b.x0 + 30 + hash(seed, k, 2) * (w - 60), y = b.y0 + 30 + hash(seed, k, 3) * (h - 60); g.fillStyle = '#25272b'; g.beginPath(); g.arc(x, y, 9, 0, TAU); g.fill(); g.fillStyle = '#4a4d52'; g.beginPath(); g.arc(x, y, 4, 0, TAU); g.fill(); g.strokeStyle = C.ink; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 9, 0, TAU); g.stroke(); }
  } else if (kind === 'awning') {
    // a striped canvas awning: red and bone bands, each lit on its top edge and shaded on its low one, sagging at the front
    const sh = 40;
    for (let x = b.x0, i = 0; x < b.x1; x += sh, i++) {
      g.fillStyle = i % 2 ? C.bone : C.paintRed; g.fillRect(x, b.y0, sh, h);
      g.fillStyle = 'rgba(255,248,226,0.2)'; g.fillRect(x, b.y0, sh, 6); g.fillStyle = 'rgba(8,8,12,0.2)'; g.fillRect(x + sh - 6, b.y0, 6, h);
    }
    g.strokeStyle = C.ink; g.lineWidth = 2; g.beginPath(); for (let x = b.x0 + sh; x < b.x1; x += sh) { g.moveTo(x, b.y0); g.lineTo(x, b.y1); } g.stroke();
    g.fillStyle = 'rgba(10,10,14,0.18)'; g.fillRect(b.x0, b.y1 - h * 0.18, w, h * 0.18);
  } else if (kind === 'tarp') {
    // one tarp lashed over a frame: a single colour, long diagonal folds (lit crest, shaded trough), a stitched patch of another
    // colour, rope and grommets round the hem, and the sag shaded at the low edge
    const col = id === 'redcamp-tarp' ? C.tarpOrange : [C.tarpBlue, C.tarpOrange, C.tarpGreen][Math.floor(hash(seed, 0, 43) * 3)]!;
    const alt = col === C.tarpBlue ? C.tarpOrange : C.tarpBlue;
    g.fillStyle = col; g.fillRect(b.x0, b.y0, w, h);
    const slant = 0.42, span = h * slant;
    for (let k = 0, x = b.x0 - span; x < b.x1; k++, x += 58 + hash(seed, k, 44) * 30) {
      const fw = 12 + hash(seed, k, 45) * 10;
      g.fillStyle = 'rgba(255,250,235,0.17)'; trace(g, [{ x, y: b.y0 }, { x: x + fw, y: b.y0 }, { x: x + fw + span, y: b.y1 }, { x: x + span, y: b.y1 }]); g.fill();
      g.fillStyle = 'rgba(8,8,12,0.2)'; trace(g, [{ x: x + fw, y: b.y0 }, { x: x + fw * 2.1, y: b.y0 }, { x: x + fw * 2.1 + span, y: b.y1 }, { x: x + fw + span, y: b.y1 }]); g.fill();
    }
    const pw = Math.min(w * 0.34, 150), ph = Math.min(h * 0.3, 110), px = b.x0 + w * (0.18 + hash(seed, 1, 46) * 0.4), py = b.y0 + h * (0.18 + hash(seed, 2, 46) * 0.35);
    g.fillStyle = alt; g.fillRect(px, py, pw, ph); g.fillStyle = 'rgba(8,8,12,0.2)'; g.fillRect(px, py + ph - 7, pw, 7);
    g.strokeStyle = C.ink; g.lineWidth = 2; g.strokeRect(px, py, pw, ph);
    g.strokeStyle = 'rgba(232,224,200,0.7)'; g.lineWidth = 2; g.setLineDash([6, 5]); g.strokeRect(px + 5, py + 5, pw - 10, ph - 10); g.setLineDash([]);
    g.fillStyle = 'rgba(10,10,14,0.2)'; g.fillRect(b.x0, b.y1 - h * 0.16, w, h * 0.16);
    g.fillStyle = 'rgba(255,248,226,0.16)'; g.fillRect(b.x0, b.y0, w, 8);
    for (let x = b.x0 + 30; x < b.x1 - 10; x += 74) {
      for (const [gx, gy, ex, ey] of [[x, b.y0 + 9, x - 6, b.y0 - 4], [x, b.y1 - 9, x + 5, b.y1 + 4]] as const) {
        g.strokeStyle = C.woodLo; g.lineWidth = 3; g.beginPath(); g.moveTo(gx, gy); g.lineTo(ex, ey); g.stroke();
        g.fillStyle = '#2b2a2a'; g.beginPath(); g.arc(gx, gy, 4.2, 0, TAU); g.fill(); g.strokeStyle = C.ink; g.lineWidth = 1.6; g.stroke();
      }
    }
  } else if (kind === 'deck') {
    // slab: panels with ink expansion joints, a worn road marking chipped back to the concrete, spalled chunks, parapet bands
    g.fillStyle = '#76746c'; g.fillRect(b.x0, b.y0, w, h);
    for (let x = b.x0, i = 0; x < b.x1; x += 150, i++) { g.fillStyle = i % 2 ? 'rgba(255,248,226,0.07)' : 'rgba(8,8,12,0.07)'; g.fillRect(x, b.y0, 150, h); g.fillStyle = C.ink; g.fillRect(x - 1, b.y0, 3, h); }
    g.fillStyle = 'rgba(214,198,118,0.85)'; g.fillRect(b.x0, b.y0 + h / 2 - 4, w, 8);
    g.fillStyle = 'rgba(232,226,204,0.8)'; for (let x = b.x0 + 10; x < b.x1; x += 120) { g.fillRect(x, b.y0 + h * 0.26, 64, 6); g.fillRect(x, b.y0 + h * 0.74, 64, 6); }
    g.fillStyle = '#76746c'; for (let k = 0; k < Math.round(w / 40); k++) { const cx = b.x0 + hash(seed, k, 21) * w, cy = b.y0 + h * (hash(seed, k, 22) < 0.5 ? 0.5 : hash(seed, k, 23) < 0.5 ? 0.26 : 0.74); g.fillRect(cx, cy - 5, 8 + hash(seed, k, 24) * 12, 10); }
    g.fillStyle = '#a29f94'; g.fillRect(b.x0, b.y0, w, 14); g.fillRect(b.x0, b.y1 - 14, w, 14); g.fillStyle = 'rgba(8,8,12,0.3)'; g.fillRect(b.x0, b.y0 + 14, w, 4); g.fillRect(b.x0, b.y1 - 18, w, 4);
    for (let k = 0; k < Math.round(w / 110); k++) wedgeCut(g, b.x0 + hash(seed, k, 7) * w, b.y0 + 24 + hash(seed, k, 8) * (h - 48), hash(seed, k, 9) * 6, 44, 4.5, seed + k);
    for (let k = 0; k < 6; k++) { const cx = b.x0 + hash(seed, k, 25) * w, cy = hash(seed, k, 26) < 0.5 ? b.y0 + 4 : b.y1 - 4; g.fillStyle = '#8f8c82'; trace(g, [{ x: cx - 9, y: cy + 2 }, { x: cx - 3, y: cy - 8 }, { x: cx + 9, y: cy - 4 }, { x: cx + 6, y: cy + 8 }]); g.fill(); g.strokeStyle = C.ink; g.lineWidth = 1.6; g.stroke(); }
  } else if (kind === 'fuselage') {
    g.fillStyle = C.aluHi; g.fillRect(b.x0, b.y0, w, h);
    g.fillStyle = C.paintBlue; g.fillRect(b.x0, b.y0 + h * 0.5 - 7, w, 14);
    g.fillStyle = '#26303c'; for (let x = b.x0 + 18; x < b.x1 - 12; x += 40) { g.fillRect(x, b.y0 + 12, 17, 11); g.fillRect(x, b.y1 - 23, 17, 11); }
    g.strokeStyle = 'rgba(60,70,84,0.55)'; g.lineWidth = 1.8; for (let x = b.x0 + 80; x < b.x1; x += 100) { g.beginPath(); g.moveTo(x, b.y0); g.lineTo(x, b.y1); g.stroke(); }
    g.fillStyle = '#34507a'; g.font = '800 38px "Barlow Condensed", "Arial Narrow", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; if (id === 'spanA-roof' || id === 'spanB-roof') g.fillText(id === 'spanA-roof' ? 'FLIGHT 217' : 'ATLAS AIR', (b.x0 + b.x1) / 2, b.y0 + h * 0.5 - 22);
    // a torn hole in the skin where something fell through
    g.fillStyle = '#1b222c'; g.beginPath(); g.moveTo(b.x0 + w * 0.5, b.y0 + h * 0.55); g.lineTo(b.x0 + w * 0.5 + 60, b.y0 + h * 0.6); g.lineTo(b.x0 + w * 0.5 + 40, b.y0 + h * 0.9); g.lineTo(b.x0 + w * 0.5 - 10, b.y0 + h * 0.82); g.closePath(); g.fill();
  } else if (kind === 'slate' || kind === 'glass') {
    const t = kind === 'glass' ? 50 : 22;
    for (let y = b.y0, row = 0; y < b.y1; y += t, row++) for (let x = b.x0 - (row % 2) * t; x < b.x1; x += t * 2) {
      const k = hash(Math.round(x), Math.round(y), 9);
      if (kind === 'glass') { g.fillStyle = k < 0.07 ? '#3f5a5c' : k < 0.5 ? '#93bcbc' : '#7fa9ab'; g.fillRect(x, y, t * 2, t); g.fillStyle = 'rgba(255,255,255,0.14)'; g.beginPath(); g.moveTo(x + 8, y + t); g.lineTo(x + 30, y); g.lineTo(x + 42, y); g.lineTo(x + 20, y + t); g.closePath(); g.fill(); g.strokeStyle = 'rgba(30,40,44,0.75)'; g.lineWidth = 3; g.strokeRect(x, y, t * 2, t); }
      else { g.fillStyle = k < 0.1 ? '#2a2d34' : k < 0.5 ? '#5c606a' : '#4e525c'; g.fillRect(x, y, t * 2 - 2, t - 2); g.fillStyle = 'rgba(255,255,255,0.1)'; g.fillRect(x, y, t * 2 - 2, 3); }
    }
    g.fillStyle = 'rgba(70,110,60,0.5)'; for (let k = 0; k < 18; k++) { g.beginPath(); g.arc(b.x0 + hash(seed, k, 10) * w, b.y0 + hash(seed, k, 11) * h, 8 + hash(seed, k, 12) * 12, 0, TAU); g.fill(); }
    g.strokeStyle = '#2a2d34'; g.lineWidth = 6; g.beginPath(); g.moveTo(b.x0, b.y0 + h / 2); g.lineTo(b.x1, b.y0 + h / 2); g.stroke();
  } else if (kind === 'slab') {
    // a poured bunker roof: 100 px panels that differ a little in value, a lit lip on each panel's north and west joints, a
    // raised parapet round the edge, stains and moss, a cracked corner, two louvred vents and a hatch
    g.fillStyle = '#7a7e84'; g.fillRect(b.x0, b.y0, w, h);
    for (let x = b.x0, i = 0; x < b.x1; x += 100, i++) for (let y = b.y0, j = 0; y < b.y1; y += 100, j++) {
      const k = hash(seed, i, 70 + j);
      g.fillStyle = k < 0.35 ? 'rgba(8,8,12,0.07)' : k > 0.7 ? 'rgba(255,248,226,0.07)' : 'rgba(0,0,0,0)'; g.fillRect(x, y, 100, 100);
      g.fillStyle = 'rgba(255,248,226,0.2)'; g.fillRect(x + 2, y + 2, 96, 3); g.fillRect(x + 2, y + 2, 3, 96);
      g.fillStyle = 'rgba(8,8,12,0.16)'; g.fillRect(x + 4, y + 95, 96, 4); g.fillRect(x + 95, y + 4, 4, 96);
    }
    g.strokeStyle = C.ink; g.lineWidth = 2; g.beginPath(); for (let x = b.x0 + 100; x < b.x1; x += 100) { g.moveTo(x, b.y0); g.lineTo(x, b.y1); } for (let y = b.y0 + 100; y < b.y1; y += 100) { g.moveTo(b.x0, y); g.lineTo(b.x1, y); } g.stroke();
    g.fillStyle = 'rgba(70,64,54,0.16)'; for (let k = 0; k < 5; k++) { g.beginPath(); g.ellipse(b.x0 + hash(seed, k, 13) * w, b.y0 + hash(seed, k, 14) * h, 30 + hash(seed, k, 17) * 24, 18, hash(seed, k, 18) * 3, 0, TAU); g.fill(); }
    g.fillStyle = 'rgba(80,120,60,0.45)'; for (let k = 0; k < 4; k++) { const mx = b.x0 + 14 + hash(seed, k, 19) * (w - 28), my = hash(seed, k, 20) < 0.5 ? b.y0 + 16 : b.y1 - 20; g.beginPath(); g.ellipse(mx, my, 14 + hash(seed, k, 21) * 10, 8, 0.2, 0, TAU); g.fill(); }
    for (let k = 0; k < 2; k++) wedgeCut(g, b.x0 + w * (0.12 + 0.6 * hash(seed, k, 22)), b.y0 + h * (0.12 + 0.6 * hash(seed, k, 23)), 0.8 + k, 70, 5, seed + k);
    // vents and a hatch
    const vent = (cx: number, cy: number) => {
      g.fillStyle = 'rgba(8,8,12,0.28)'; g.fillRect(cx - 28, cy - 14, 64, 44); g.fillStyle = '#4f5560'; g.fillRect(cx - 30, cy - 20, 60, 40);
      g.fillStyle = 'rgba(255,248,226,0.2)'; g.fillRect(cx - 30, cy - 20, 60, 4); g.fillStyle = '#2a2d34'; for (let q = 0; q < 4; q++) g.fillRect(cx - 24, cy - 12 + q * 8, 48, 4);
      g.strokeStyle = C.ink; g.lineWidth = 2; g.strokeRect(cx - 30, cy - 20, 60, 40);
    };
    vent(b.x0 + w * 0.3, b.y0 + h * 0.62); if (w > 300) vent(b.x0 + w * 0.7, b.y0 + h * 0.3);
    const hx = b.x0 + w * 0.5, hy = b.y0 + h * 0.5;
    g.fillStyle = 'rgba(8,8,12,0.28)'; g.fillRect(hx - 22, hy - 14, 52, 46); g.fillStyle = C.rustLo; g.fillRect(hx - 24, hy - 20, 48, 40); g.fillStyle = 'rgba(255,248,226,0.22)'; g.fillRect(hx - 24, hy - 20, 48, 4);
    g.strokeStyle = C.ink; g.lineWidth = 2; g.strokeRect(hx - 24, hy - 20, 48, 40); g.fillStyle = '#2a2d34'; g.fillRect(hx - 8, hy - 3, 16, 6);
    // the parapet
    g.fillStyle = '#9a9d98'; g.fillRect(b.x0, b.y0, w, 14); g.fillRect(b.x0, b.y1 - 14, w, 14); g.fillRect(b.x0, b.y0, 14, h); g.fillRect(b.x1 - 14, b.y0, 14, h);
    g.fillStyle = 'rgba(255,248,226,0.24)'; g.fillRect(b.x0, b.y0, w, 4); g.fillRect(b.x0, b.y0, 4, h);
    g.fillStyle = 'rgba(8,8,12,0.3)'; g.fillRect(b.x0 + 14, b.y0 + 14, w - 28, 4); g.fillRect(b.x0 + 14, b.y0 + 14, 4, h - 28);
  } else if (kind === 'canopy') {
    g.fillStyle = '#b9b2a2'; g.fillRect(b.x0, b.y0, w, h);
    ribbed(g, b, true, seed, 28);
    g.fillStyle = C.paintRed; g.fillRect(b.x0, b.y0 + h - 40, w, 20); g.fillStyle = C.bone; g.fillRect(b.x0, b.y0 + h - 20, w, 12);
    g.fillStyle = 'rgba(8,8,12,0.28)'; g.fillRect(b.x0, b.y0 + h - 8, w, 8);
    g.fillStyle = '#d8e08a'; for (const fx of [0.3, 0.7]) { g.fillRect(b.x0 + w * fx - 44, b.y0 + h * 0.42, 88, 12); g.strokeStyle = C.ink; g.lineWidth = 2; g.strokeRect(b.x0 + w * fx - 44, b.y0 + h * 0.42, 88, 12); }
    for (let k = 0; k < 4; k++) wedgeCut(g, b.x0 + hash(seed, k, 15) * w, b.y0 + hash(seed, k, 16) * h * 0.6, 1.5, 40, 4, seed + k);
  } else if (kind === 'flat') {
    g.fillStyle = C.concreteHi; g.fillRect(b.x0, b.y0, w, h);
    for (let x = b.x0, i = 0; x < b.x1; x += 130, i++) { g.fillStyle = i % 2 ? 'rgba(255,248,226,0.08)' : 'rgba(8,8,12,0.08)'; g.fillRect(x, b.y0, 130, h); g.fillStyle = C.ink; g.fillRect(x - 1, b.y0, 3, h); }
    g.fillStyle = '#4f5560'; g.fillRect(b.x0 + w * 0.7, b.y0 + h * 0.3, 70, 52); g.fillStyle = 'rgba(255,255,255,0.16)'; g.fillRect(b.x0 + w * 0.7, b.y0 + h * 0.3, 70, 8); g.fillStyle = 'rgba(8,8,12,0.3)'; g.fillRect(b.x0 + w * 0.7, b.y0 + h * 0.3 + 44, 70, 8); g.strokeStyle = C.ink; g.lineWidth = 2; g.strokeRect(b.x0 + w * 0.7, b.y0 + h * 0.3, 70, 52);
    g.fillStyle = '#2a2d34'; for (let k = 0; k < 4; k++) g.fillRect(b.x0 + w * 0.7 + 8 + k * 15, b.y0 + h * 0.3 + 18, 8, 22);
    for (let k = 0; k < 3; k++) wedgeCut(g, b.x0 + hash(seed, k, 17) * w, b.y0 + hash(seed, k, 18) * h, hash(seed, k, 19) * 6, 40, 4, seed + k);
    g.fillStyle = 'rgba(70,110,60,0.6)'; for (let k = 0; k < 6; k++) { g.beginPath(); g.arc(b.x0 + hash(seed, k, 19) * w, b.y0 + hash(seed, k, 20) * h, 9, 0, TAU); g.fill(); g.strokeStyle = C.ink; g.lineWidth = 1.4; g.stroke(); }
  }
  g.restore();
  trace(g, pts); g.strokeStyle = C.ink; g.lineWidth = 2.2; g.lineJoin = 'round'; g.stroke();
  void inPoly;
}

export function drawRoof(g: G, r: MapRoof, _alpha: number, _info: GeoInfo): boolean {
  void _alpha; void _info;
  let s = roofSprites.get(r.id);
  if (!s) {
    const pts = wound(r.points);
    const b = boundsOf(pts);
    s = bake(b.x0 - 24, b.y0 - 24, b.x1 + 24, b.y1 + 40, (c) => roofPaint(c, r, pts));
    roofSprites.set(r.id, s);
  }
  g.drawImage(s.canvas, s.x, s.y);
  return true;
}

/* ---------------------------------------------------------------- doors */

function leafBox(l: DoorLeaf): Pt[] {
  const anyL = l as DoorLeaf & { pts?: readonly number[] };
  if (anyL.pts) { const out: Pt[] = []; for (let i = 0; i < anyL.pts.length; i += 2) out.push({ x: anyL.pts[i]!, y: anyL.pts[i + 1]! }); return out; }
  return [{ x: l.x, y: l.y }, { x: l.x + l.w, y: l.y }, { x: l.x + l.w, y: l.y + l.h }, { x: l.x, y: l.y + l.h }];
}

export function drawDoor(g: G, d: MapDoor, leaves: readonly DoorLeaf[], open: number, info: GeoInfo): boolean {
  void info;
  const twin = isTwin(d.id);
  const h = d.axis === 'h';
  const x1 = d.x + (h ? d.w : 0), y1 = d.y + (h ? 0 : d.w);
  const blast = twin && d.kind === 'double-slide';
  const base = d.material === 'glass' ? 'rgba(170,214,232,0.5)' : blast ? '#59626e' : d.material === 'tin' ? C.scrapB : d.material === 'wood' ? C.wood : C.steel;
  // a door frame post at each end, and the track a slider runs on
  g.strokeStyle = 'rgba(10,12,18,0.5)'; g.lineWidth = 3;
  if (d.kind === 'slide' || d.kind === 'double-slide') { g.beginPath(); g.moveTo(d.x, d.y); g.lineTo(x1, y1); g.stroke(); }
  for (const l of leaves) {
    const pts = wound(leafBox(l));
    drawExtruded(g, pts, d.material === 'glass' ? 10 : 22, look(base.startsWith('rgba') ? '#9fc6d4' : base));
    const b = boundsOf(pts);
    g.save(); trace(g, pts); g.clip();
    if (d.material === 'tin' && !blast) { g.fillStyle = 'rgba(8,8,10,0.25)'; if (h) for (let x = b.x0; x < b.x1; x += 7) g.fillRect(x, b.y0, 3, b.y1 - b.y0); else for (let y = b.y0; y < b.y1; y += 7) g.fillRect(b.x0, y, b.x1 - b.x0, 3); }
    if (blast) { g.fillStyle = '#d9c24a'; const n = h ? Math.ceil((b.x1 - b.x0) / 16) : Math.ceil((b.y1 - b.y0) / 16); for (let i = 0; i < n; i += 2) { g.beginPath(); if (h) { g.moveTo(b.x0 + i * 16, b.y1); g.lineTo(b.x0 + i * 16 + 8, b.y1); g.lineTo(b.x0 + i * 16 + 16, b.y0); g.lineTo(b.x0 + i * 16 + 8, b.y0); } else { g.moveTo(b.x1, b.y0 + i * 16); g.lineTo(b.x1, b.y0 + i * 16 + 8); g.lineTo(b.x0, b.y0 + i * 16 + 16); g.lineTo(b.x0, b.y0 + i * 16 + 8); } g.closePath(); g.fill(); } }
    if (d.material === 'wood') { g.strokeStyle = 'rgba(20,12,6,0.5)'; g.lineWidth = 1.6; g.beginPath(); if (h) { for (let x = b.x0 + 8; x < b.x1; x += 12) { g.moveTo(x, b.y0); g.lineTo(x, b.y1); } } else { for (let y = b.y0 + 8; y < b.y1; y += 12) { g.moveTo(b.x0, y); g.lineTo(b.x1, y); } } g.stroke(); }
    g.restore();
  }
  for (const [px, py] of [[d.x, d.y], [x1, y1]] as const) drawExtruded(g, [{ x: px - 8, y: py - 8 }, { x: px + 8, y: py - 8 }, { x: px + 8, y: py + 8 }, { x: px - 8, y: py + 8 }], 24, look(blast ? '#3d4450' : C.steelLo));
  if (d.material === 'glass' && open < 40) { g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 2; g.beginPath(); g.moveTo(d.x + (h ? 14 : -3), d.y + (h ? -3 : 14)); g.lineTo(d.x + (h ? 30 : -3), d.y + (h ? -3 : 30)); g.stroke(); }
  return true;
}

export const WASTELAND_GEO = { drawPoly, roof: drawRoof, door: drawDoor };
