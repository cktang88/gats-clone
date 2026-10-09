import type { MapDef } from '../../shared/maps.ts';
import { GANTRY, LAMPS, PLACED_SHIPS, ROOMS, SIGNPOSTS, SIZE, districtAt } from '../../shared/maps/causewaydata.ts';
import { setLight } from '../lighting.ts';
import { INK } from '../palette.ts';
import { drawHarborDecor, drawHarborDecorGround, drawHarborDecorOver } from './harbordecor.ts';
import { paintHarborFloor } from './harborfloor.ts';
import { C, TAU, calm, clock, hexA, inView, plate } from './harborkit.ts';
import { drawHarborSet } from './harborpolys.ts';
import { drawHarborDoor, drawHarborRoof } from './harborroofs.ts';
import { bobOf, drawGangways, drawMoorings, drawShips } from './harborships.ts';
import { FACE, drawWater, prepWater, type WaterLight } from './harborwater.ts';
import { registerTheme, type ThemeView } from './registry.ts';

/**
 * Causeway Harbour, at the blue hour: registers the theme. The floor is baked in harborfloor.ts, the water is its own pass
 * (harborwater.ts), set pieces and ships are painted by harborpolys.ts and harborships.ts, hand-placed stories live in
 * harbordecor.ts. This file is the living part: lamps, nav lights, the lighthouse and the gantry cranes. Every glow is tied to a
 * fixture and every movement is slower than 1 Hz; under reduced motion all of it holds still.
 */

type Ctx = CanvasRenderingContext2D;
const HULLS = PLACED_SHIPS.map((s) => s.hull);
const waterLights: WaterLight[] = [];
const rgbOf = (hex: string): [number, number, number] => { const v = parseInt(hex.slice(1), 16); return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; };

/** Lanterns hung on the ships' decks, each swaying on its hook with the swell: the trawler's by the wheelhouse door, the cargo ship's aft, the patrol boat's by its cabin. */
const LANTERNS = [
  { x: 804, y: 4310, ship: 'trawler' }, { x: 832, y: 3790, ship: 'kestrel' }, { x: 850, y: 1400, ship: 'patrol' },
  { x: SIZE - 804, y: SIZE - 4310, ship: 'trawler~' }, { x: SIZE - 832, y: SIZE - 3790, ship: 'kestrel~' }, { x: SIZE - 850, y: SIZE - 1400, ship: 'patrol~' },
];

/** The two lighthouses and their sweep. */
/** The quay lamps burn sodium orange against the cold teal of the harbour. */
const SODIUM = '#ffa94d';
const LIGHTHOUSES = [{ x: 520, y: 800 }, { x: SIZE - 520, y: SIZE - 800 }];
/** Nav lights at each bow: red to port, green to starboard. */
const navLights = PLACED_SHIPS.flatMap((s) => {
  let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
  for (const p of s.hull) { top = Math.min(top, p.y); bottom = Math.max(bottom, p.y); left = Math.min(left, p.x); right = Math.max(right, p.x); }
  const bowY = s.east ? bottom : top, dir = s.east ? -1 : 1;
  const cx = (left + right) / 2;
  return [
    { id: `${s.id}:p`, x: cx - 52, y: bowY + dir * 120, color: '#ff4a40', ship: s.id },
    { id: `${s.id}:s`, x: cx + 52, y: bowY + dir * 120, color: '#46e08a', ship: s.id },
  ];
});

/**
 * Lamps on every deck and a row of portholes along the quay side of each hull: the ships are lit things at night, warm
 * windows over cold water. Computed once from the hulls; each rides the same swell as the ship (bobOf).
 */
const SHIP_LIGHTS = PLACED_SHIPS.flatMap((s) => {
  let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
  for (const p of s.hull) { top = Math.min(top, p.y); bottom = Math.max(bottom, p.y); left = Math.min(left, p.x); right = Math.max(right, p.x); }
  const cx = (left + right) / 2, quaySide = s.east ? left + 16 : right - 16;
  const out: { key: string; ship: string; x: number; y: number; lamp: boolean }[] = [];
  for (let y = top + 150, i = 0; y < bottom - 100; y += 250, i++) out.push({ key: `hb:deck:${s.id}:${i}`, ship: s.id, x: cx, y, lamp: true });
  for (let y = top + 110, i = 0; y < bottom - 80; y += 170, i++) out.push({ key: `hb:port:${s.id}:${i}`, ship: s.id, x: quaySide, y, lamp: false });
  return out;
});

/* -- the ground: water, quay faces, decks ----------------------------------------------------------------------- */

function quayFaces(ctx: Ctx, view: ThemeView, map: MapDef): void {
  const prep = prepWater(map, HULLS);
  ctx.save();
  ctx.lineJoin = 'round';
  for (const f of prep.faces) {
    const x0 = Math.min(f.a.x, f.b.x), x1 = Math.max(f.a.x, f.b.x), y = Math.min(f.a.y, f.b.y);
    if (x1 < view.x0 || x0 > view.x1 || y > view.y1 || y + FACE < view.y0) continue;
    ctx.beginPath();
    ctx.moveTo(f.a.x, f.a.y); ctx.lineTo(f.b.x, f.b.y); ctx.lineTo(f.b.x, f.b.y + FACE); ctx.lineTo(f.a.x, f.a.y + FACE); ctx.closePath();
    ctx.fillStyle = C.quayFace; ctx.fill();
    ctx.strokeStyle = 'rgba(20,22,26,0.4)'; ctx.lineWidth = 2;
    ctx.beginPath(); for (let x = Math.ceil(x0 / 64) * 64; x < x1; x += 64) { ctx.moveTo(x, f.a.y); ctx.lineTo(x, f.a.y + FACE); } ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(Math.min(f.a.x, f.b.x), Math.min(f.a.y, f.b.y), Math.abs(f.b.x - f.a.x), 4);
    ctx.strokeStyle = INK; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(f.a.x, f.a.y + FACE); ctx.lineTo(f.b.x, f.b.y + FACE); ctx.stroke();
  }
  ctx.restore();
}

function ground(ctx: Ctx, now: number, view: ThemeView, map: MapDef): void {
  drawWater(ctx, now, view, map, HULLS, waterLights);
  quayFaces(ctx, view, map);
  drawHarborDecorGround(ctx, now, view);
  drawShips(ctx, now, view);
  drawGangways(ctx, now, view);
  drawMoorings(ctx, now, view);
}

/* -- lamps and lights -------------------------------------------------------------------------------------------- */

function lampPost(ctx: Ctx, x: number, y: number, color: string, glow: number): void {
  // A glow pool on the ground, a squat base, the post's shadow and the lamp head.
  const g = ctx.createRadialGradient(x, y + 10, 4, x, y + 10, 120);
  g.addColorStop(0, hexA(color, 0.18 * glow)); g.addColorStop(1, hexA(color, 0));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g; ctx.fillRect(x - 120, y - 110, 240, 240);
  ctx.restore();
  ctx.fillStyle = 'rgba(10,12,16,0.34)'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 40, y + 34); ctx.lineTo(x + 46, y + 30); ctx.lineTo(x + 6, y - 4); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#3a3f46'; ctx.beginPath(); ctx.arc(x, y, 9, 0, TAU); ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#5b626b'; ctx.beginPath(); ctx.arc(x - 1.5, y - 1.5, 5, 0, TAU); ctx.fill();
  // The head, up and to the north in the three-quarter view.
  ctx.strokeStyle = INK; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 46); ctx.stroke();
  ctx.strokeStyle = '#6a727a'; ctx.lineWidth = 2.6; ctx.stroke();
  ctx.fillStyle = '#2f343c'; ctx.beginPath(); ctx.ellipse(x, y - 50, 13, 8, 0, 0, TAU); ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = hexA(color, 0.5 + 0.5 * glow); ctx.beginPath(); ctx.ellipse(x, y - 49, 8, 4.4, 0, 0, TAU); ctx.fill();
}

function under(ctx: Ctx, now: number, view: ThemeView): void {
  const t = clock(now);
  waterLights.length = 0;
  const near = (x: number, y: number, r: number) => inView(view, x, y, r);
  for (const [i, l] of LAMPS.entries()) {
    if (!near(l.x, l.y, 520)) continue;
    const d = districtAt(l.x, l.y).d;
    const flick = calm ? 1 : 0.94 + 0.06 * Math.sin(t * 0.002 + i * 1.7) * Math.sin(t * 0.00077 + i);
    if (near(l.x, l.y, 140)) lampPost(ctx, l.x, l.y, d.light, flick);
    setLight(`hb:l${i}${l.east ? 'e' : ''}`, { x: l.x, y: l.y - 36, radius: 390, color: SODIUM, intensity: 0.92 * flick, size: 12, shadows: true });
    waterLights.push({ x: l.x, y: l.y - 10, r: 300, k: 0.7 * flick, rgb: rgbOf(d.light) });
  }
  // The rooms' lit windows light the floor round them and the yards beside them.
  for (const [i, r] of [...ROOMS, ...ROOMS.map((q) => ({ ...q, x: SIZE - q.x - q.w, y: SIZE - q.y - q.h }))].entries()) {
    if (r.material === 'cabin' || !near(r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w, r.h))) continue;
    const d = districtAt(r.x + r.w / 2, r.y + r.h / 2).d;
    setLight(`hb:r${i}`, { x: r.x + r.w / 2, y: r.y + r.h / 2, radius: Math.max(r.w, r.h) * 0.8, color: r.material === 'cafe' ? '#ffd9a0' : d.light, intensity: 0.5, size: 40, shadows: true });
  }
  // Navigation lights on every bow, riding the swell.
  for (const n of navLights) {
    if (!near(n.x, n.y, 160)) continue;
    const dy = bobOf(n.ship, now).dy;
    setLight(`hb:n${n.id}`, { x: n.x, y: n.y + dy, radius: 170, color: n.color, intensity: 0.85, size: 6, shadows: false });
    waterLights.push({ x: n.x, y: n.y + dy, r: 150, k: 0.65, rgb: rgbOf(n.color) });
    ctx.fillStyle = '#23272d'; ctx.beginPath(); ctx.arc(n.x, n.y + dy, 8, 0, TAU); ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = n.color; ctx.beginPath(); ctx.arc(n.x, n.y + dy, 4.2, 0, TAU); ctx.fill();
  }
  // Deck lamps and portholes.
  for (const l of SHIP_LIGHTS) {
    if (!near(l.x, l.y, 260)) continue;
    const dy = bobOf(l.ship, now).dy;
    waterLights.push({ x: l.x, y: l.y + dy, r: l.lamp ? 240 : 100, k: l.lamp ? 0.5 : 0.4, rgb: l.lamp ? [1, 0.94, 0.82] : [1, 0.78, 0.5] });
    setLight(l.key, l.lamp ? { x: l.x, y: l.y + dy, radius: 300, color: '#fff0d0', intensity: 0.85, size: 8, shadows: false } : { x: l.x, y: l.y + dy, radius: 120, color: '#ffc880', intensity: 0.6, size: 4, flicker: calm ? undefined : 0.06, shadows: false });
  }
  // Hurricane lanterns, swaying on their hooks.
  for (const [i, l] of LANTERNS.entries()) {
    if (!near(l.x, l.y, 200)) continue;
    const dy = bobOf(l.ship, now).dy, sw = calm ? 0 : Math.sin(t * 0.0017 + i * 2.1) * 0.14;
    const hx = l.x, hy = l.y - 30 + dy, lx = hx + Math.sin(sw) * 30, ly = hy + Math.cos(sw) * 30;
    const glow = calm ? 1 : 0.9 + 0.1 * Math.sin(t * 0.004 + i);
    setLight(`hb:lan${i}`, { x: lx, y: ly + 20, radius: 240, color: '#ffb347', intensity: 0.95 * glow, size: 6, flicker: calm ? undefined : 0.15, shadows: false });
    ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(lx, ly); ctx.stroke();
    ctx.fillStyle = '#2f343c'; ctx.beginPath(); ctx.arc(hx, hy, 4, 0, TAU); ctx.fill();
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(lx, ly + 8, 2, lx, ly + 8, 70); g.addColorStop(0, `rgba(255,179,71,${0.3 * glow})`); g.addColorStop(1, 'rgba(255,179,71,0)');
    ctx.fillStyle = g; ctx.fillRect(lx - 70, ly - 62, 140, 140); ctx.restore();
    ctx.fillStyle = '#3a3f46'; ctx.fillRect(lx - 6, ly, 12, 18); ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.strokeRect(lx - 6, ly, 12, 18);
    ctx.fillStyle = `rgba(255,214,130,${0.7 + 0.3 * glow})`; ctx.fillRect(lx - 3.5, ly + 3, 7, 11);
  }
  // The lighthouses: a steady lamp, and the beam turning once in about sixteen seconds.
  for (const [i, lh] of LIGHTHOUSES.entries()) {
    if (!near(lh.x, lh.y, 1400)) continue;
    const a = calm ? 0.9 : t * 0.00039 + i * Math.PI;
    setLight(`hb:lh${i}`, { x: lh.x, y: lh.y, radius: 1500, color: '#ffe9b0', intensity: 1.35, size: 30, cone: { angle: a, half: 0.13 }, beam: 1.4, shadows: false });
    setLight(`hb:lh${i}b`, { x: lh.x, y: lh.y, radius: 700, color: '#bfe0ff', intensity: 0.5, size: 30, cone: { angle: a + Math.PI, half: 0.09 }, beam: 0.5, shadows: false });
    setLight(`hb:lg${i}`, { x: lh.x, y: lh.y, radius: 420, color: '#ffe9b0', intensity: 0.8, size: 30, shadows: false });
    waterLights.push({ x: lh.x, y: lh.y + 60, r: 420, k: 0.8, rgb: rgbOf('#ffe9b0') });
  }
  // The gantry cranes carry a slow red warning light.
  for (const east of [false, true]) {
    const [cx, cy] = east ? [SIZE - 957, SIZE - 2927] : [957, 2927];
    if (!near(cx, cy, 700)) continue;
    const on = calm || Math.floor(t / 1100) % 2 === 0;
    if (on) setLight(`hb:cr${east ? 'e' : 'w'}`, { x: cx, y: cy, radius: 260, color: '#ff4a40', intensity: 0.8, size: 8, shadows: false });
  }
  drawHarborDecor(ctx, now, view);
}

/* -- over the players: cranes, the lighthouse beam, signs --------------------------------------------------------- */

/** One gantry: portal frames over the quay and a boom reaching out over the ship, a trolley creeping along it with a box on a cable. */
function crane(ctx: Ctx, east: boolean, t: number, view: ThemeView): void {
  const P = (x: number, y: number, up = 0): [number, number] => (east ? [SIZE - x, SIZE - y - up] : [x, y - up]);
  const cx = GANTRY.boom.x, cy = GANTRY.boom.y;
  const [bx, by] = P(cx, cy);
  if (!inView(view, bx, by, 700)) return;
  const UP = 92;
  const line = (ax: number, ay: number, bx2: number, by2: number, w: number, col: string, up = UP) => {
    const [x1, y1] = P(ax, ay, up), [x2, y2] = P(bx2, by2, up);
    ctx.strokeStyle = INK; ctx.lineWidth = w + 3; ctx.lineCap = 'butt'; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke();
  };
  ctx.save();
  ctx.fillStyle = 'rgba(8,10,14,0.2)';
  for (const [ax, ay, w, h] of [[957, 2770, 24, 312], [1222, 2770, 24, 312], [440, 2899, 540, 56]] as const) {
    const [x, y] = P(ax, ay, -14), [x2, y2] = P(ax + w, ay + h, -14);
    ctx.fillRect(Math.min(x, x2) + 26, Math.min(y, y2) + 38, Math.abs(x2 - x), Math.abs(y2 - y));
  }
  ctx.restore();
  line(957, 2770, 957, 3082, 24, '#d8d4c0');
  line(1222, 2770, 1222, 3082, 24, '#d8d4c0');
  line(957, 2772, 1222, 2772, 16, '#c24a38');
  line(957, 3080, 1222, 3080, 16, '#c24a38');
  for (const y of [2772, 3080]) for (const x of [957, 1222]) {
    const [tx, ty] = P(x, y, UP), [gx, gy] = P(x, y, 0);
    ctx.strokeStyle = INK; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(gx, gy); ctx.stroke();
    ctx.strokeStyle = '#e4e0cc'; ctx.lineWidth = 4; ctx.stroke();
  }
  line(957, cy, cx - GANTRY.boom.reach, cy, 34, '#d8d4c0');
  line(957, cy - 14, cx - GANTRY.boom.reach, cy - 14, 6, '#c24a38');
  line(957, cy + 14, cx - GANTRY.boom.reach, cy + 14, 6, '#c24a38');
  const k = calm ? 0.4 : 0.5 - 0.5 * Math.cos(t * 0.00012 * Math.PI);
  const tx = cx - 60 - (GANTRY.boom.reach - 120) * k;
  const [tpx, tpy] = P(tx, cy, UP);
  const load = k > 0.15 && k < 0.85;
  const [gx, gy] = P(tx, cy, UP * 0.2);
  ctx.strokeStyle = INK; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(tpx, tpy); ctx.lineTo(gx, gy); ctx.stroke();
  ctx.strokeStyle = '#4a4f56'; ctx.lineWidth = 2; ctx.stroke();
  if (load) {
    ctx.fillStyle = '#3f6b8c'; ctx.fillRect(gx - 20, gy - 8, 40, 100); ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.strokeRect(gx - 20, gy - 8, 40, 100);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); for (let y = gy; y < gy + 92; y += 10) { ctx.moveTo(gx - 20, y); ctx.lineTo(gx + 20, y); } ctx.stroke();
  }
  ctx.fillStyle = '#c24a38'; ctx.fillRect(tpx - 20, tpy - 14, 40, 28); ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.strokeRect(tpx - 20, tpy - 14, 40, 28);
  ctx.fillStyle = '#ffdc7a'; ctx.beginPath(); ctx.arc(tpx, tpy, 4, 0, TAU); ctx.fill();
  const [cabx, caby] = P(957, 2927, UP + 6);
  ctx.fillStyle = '#e8e4d0'; ctx.fillRect(cabx - 24, caby - 22, 48, 44); ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.strokeRect(cabx - 24, caby - 22, 48, 44);
  ctx.fillStyle = '#33485a'; ctx.fillRect(cabx - 18, caby - 14, 36, 14);
  plate(ctx, east ? 'BERTH 4' : 'BERTH 1', cabx, caby - 46, 17);
  const flap = calm ? 0 : Math.sin(t * 0.0021) * 5;
  const [fx, fy] = P(1222, 2772, UP + 4);
  ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx, fy - 56); ctx.stroke();
  ctx.fillStyle = east ? '#e8c040' : '#c24a38'; ctx.beginPath(); ctx.moveTo(fx, fy - 56); ctx.lineTo(fx + 34, fy - 48 + flap); ctx.lineTo(fx, fy - 38); ctx.closePath(); ctx.fill(); ctx.stroke();
}

function signposts(ctx: Ctx, view: ThemeView): void {
  for (const s of SIGNPOSTS) {
    if (!inView(view, s.x, s.y, 200)) continue;
    ctx.fillStyle = 'rgba(10,12,16,0.3)'; ctx.fillRect(s.x + 4, s.y - 2, 12, 8);
    ctx.fillStyle = '#4a4f56'; ctx.fillRect(s.x - 5, s.y - 4, 10, 8); ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.strokeRect(s.x - 5, s.y - 4, 10, 8);
    ctx.strokeStyle = INK; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x, s.y - 78); ctx.stroke();
    ctx.strokeStyle = '#7a828a'; ctx.lineWidth = 3; ctx.stroke();
    s.lines.forEach((l, i) => {
      const y = s.y - 66 + i * 26, right = Math.cos(l.angle) >= -0.05;
      ctx.save(); ctx.translate(s.x, y);
      ctx.font = '700 15px "Barlow Condensed", "Arial Narrow", sans-serif';
      const w = ctx.measureText(l.text).width + 34;
      const x0 = right ? 0 : -w;
      ctx.fillStyle = '#2f343c'; ctx.beginPath();
      if (right) { ctx.moveTo(0, -10); ctx.lineTo(w - 12, -10); ctx.lineTo(w + 2, 0); ctx.lineTo(w - 12, 10); ctx.lineTo(0, 10); } else { ctx.moveTo(0, -10); ctx.lineTo(-w + 12, -10); ctx.lineTo(-w - 2, 0); ctx.lineTo(-w + 12, 10); ctx.lineTo(0, 10); }
      ctx.closePath(); ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#ece6d6'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillText(l.text, x0 + (right ? 8 : 14), 1);
      ctx.restore();
    });
  }
}

function over(ctx: Ctx, now: number, view: ThemeView): void {
  const t = clock(now);
  crane(ctx, false, t, view);
  crane(ctx, true, t, view);
  signposts(ctx, view);
  drawHarborDecorOver(ctx, now, view);
}

registerTheme('harbor', {
  dusk: 0.12,
  floor: paintHarborFloor,
  ground,
  under,
  over,
  drawSetPiece: drawHarborSet,
  roof: drawHarborRoof,
  door: drawHarborDoor,
});
