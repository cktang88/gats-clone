import type { MapDef } from '../../shared/maps.ts';
import { setLight } from '../lighting.ts';
import { reducedMotion } from '../screenfx.ts';
import type { ThemeView } from './registry.ts';
import { C, DISTRICTS, MID, PARK, districtAt, hash, inside, isBasin, openSides, wallsOf, type Foliage } from './parkkit.ts';
import * as P from './parkprops.ts';
import { onMapChange } from '../mapscope.ts';

/**
 * What moves, and what stands, in the Park. `parkUnder` runs after the walls and before bodies: tree shadows, water with its
 * lily pads, ducks, lanterns and boat, the fountain, swings, and every hand-placed vignette. `parkOver` runs above bodies:
 * the tree canopies (which thin out when anyone stands beneath), the pergola, bunting, a hot-air balloon, a kite caught
 * in a tree, fireflies and a few drifting leaves. All of it is slow (nothing above 1 Hz but a firefly's blink), and with
 * reduced motion it holds still.
 */
type G = CanvasRenderingContext2D;
const TAU = Math.PI * 2;
const SCALE = 2;
const MS = { fade: 160 } as const;

/* --------------------------------------------------------- sprite cache */

const sprites = new Map<string, HTMLCanvasElement>();
onMapChange(() => sprites.clear());
function sprite(key: string, s: P.Sprite): HTMLCanvasElement {
  let c = sprites.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = s.w * SCALE; c.height = s.h * SCALE;
  const g = c.getContext('2d')!;
  g.scale(SCALE, SCALE);
  g.translate(s.ax, s.ay);
  s.draw(g);
  sprites.set(key, c);
  return c;
}
function put(g: G, key: string, s: () => P.Sprite, x: number, y: number, o: { rot?: number; alpha?: number; dx?: number; dy?: number } = {}) {
  const proto = specs.get(key) ?? (specs.set(key, s()), specs.get(key)!);
  const c = sprite(key, proto);
  if (o.rot || o.alpha !== undefined) {
    g.save(); g.translate(x + (o.dx ?? 0), y + (o.dy ?? 0)); if (o.rot) g.rotate(o.rot); if (o.alpha !== undefined) g.globalAlpha = o.alpha;
    g.drawImage(c, -proto.ax, -proto.ay, proto.w, proto.h);
    g.restore();
  } else g.drawImage(c, x - proto.ax + (o.dx ?? 0), y - proto.ay + (o.dy ?? 0), proto.w, proto.h);
}
const specs = new Map<string, P.Sprite>();

const inV = (v: ThemeView, x: number, y: number, r: number) => x + r > v.x0 && x - r < v.x1 && y + r > v.y0 && y - r < v.y1;

/* ------------------------------------------------------ hand-placed set */

type Prop = { key: string; make: () => P.Sprite; x: number; y: number; r: number };
const prop = (key: string, make: () => P.Sprite, x: number, y: number, r = 120): Prop => ({ key, make, x, y, r });
const cell = (c: number) => c * 50;

const SIGNS: [string, number, number, 1 | -1, string?][] = [
  ['BANDSTAND GREEN', 1700, 1430, 1, 'STAGE 8PM'], ['PLAYGROUND', 2330, 1620, -1, 'KIDS FIRST'], ['LANTERN POND', 4120, 1080, 1, 'NO SWIMMING'],
  ['ROSE GARDEN', 560, 2330, 1, 'KEEP OFF BEDS'], ['FOUNTAIN PLAZA', 3400, 2580, 1, 'MAKE A WISH'], ['SPORTS COURTS', 5130, 3250, -1, 'BOOK AT KIOSK'],
  ['BOATHOUSE POND', 1500, 3760, 1, 'BOAT HIRE'], ['PICNIC MEADOW', 2400, 5180, 1, 'BYO BLANKET'], ['ORCHARD', 5080, 5420, 1, 'PLEASE PICK!'],
];

const PROPS: Prop[] = [
  ...SIGNS.map(([n, x, y, d, sub]) => prop(`sign:${n}`, () => P.signpost(n, d, sub), x, y, 130)),
  // Bandstand green: the festival that ran out of evening.
  prop('speaker', P.speakerStack, 960, 1590), prop('chairs', P.stackedChairs, 1290, 1560), prop('banner', P.banner, 1125, 1495, 150),
  prop('cone', P.iceCream, 1585, 2112, 60), prop('flyers1', () => P.flyers(1), 760, 905, 90), prop('flyers2', () => P.flyers(2), 1540, 1020, 90),
  prop('coil', P.buntingCoil, 840, 1880), prop('ladder', P.stepLadder, 1760, 1480),
  // Playground.
  prop('hopscotch', P.hopscotch, 1510, 1230, 110), prop('castle', P.sandcastle, 2250, 1300), prop('trike', P.tricycle, 2230, 700),
  // Lantern pond.
  prop('fishing', P.fishingSpot, 4560, 1850), prop('flyers3', () => P.flyers(3), 3940, 1500, 90),
  // Rose garden.
  prop('can', P.wateringCan, 700, 2560), prop('bike', P.bicycle, 520, 2640), prop('urn1', () => P.flowerUrn(C.rose), 1000, 2260, 60), prop('urn2', () => P.flowerUrn('#e6b2b6'), 1200, 2260, 60),
  // Plaza.
  prop('ball', P.dogBall, 3215, 3188, 60),
  // Courts.
  prop('basketball', P.basketball, 4960, 2740, 60), prop('hoop', P.hoop, 4875, 2300, 130),
  // Boathouse pond.
  prop('ring', P.lifeRing, 1130, 4930, 90), prop('boot', P.boot, 1900, 4700, 60), prop('flyers4', () => P.flyers(4), 1050, 3960, 90),
  // Meadow.
  prop('blanket', P.blanket, 2620, 5420, 150), prop('bike2', P.bicycle, 3040, 5080), prop('ants', P.sandwichAnts, 2250, 5560, 150), prop('kite2', P.kiteOnGrass, 2000, 4760, 90),
  // Orchard.
  prop('scarecrow', P.scarecrow, 5240, 5330, 140), prop('crates', P.appleCrates, 4680, 5290), prop('ladder2', P.stepLadder, 4930, 4870), prop('treasure', P.treasure, 5850, 5150),
];
void DISTRICTS;

/* ------------------------------------------------------------ the trees */

type Tree = { key: string; x: number; y: number; cx: number; cy: number; r: number; fol: Foliage; big: boolean; fade: number; hash: number };
const trees: Tree[] = wallsOf('trunk').map((t) => {
  const big = t.w > 60, x = t.x + t.w / 2, y = t.y + t.h / 2, r = big ? 215 : 128;
  return { key: `${t.x},${t.y}`, x, y, cx: x, cy: y - (big ? 70 : 46), r, fol: districtAt(x, y).foliage, big, fade: 1, hash: hash(t.x, t.y, 5) };
});

function canopyOf(t: Tree): HTMLCanvasElement {
  const key = `canopy:${t.key}`;
  let c = sprites.get(key);
  if (c) return c;
  const pad = 14, R = t.r + pad;
  c = document.createElement('canvas');
  c.width = c.height = Math.ceil(R * 2 * 1.25);
  const g = c.getContext('2d')!;
  g.scale(1.25, 1.25);
  g.translate(R, R);
  const lobes: [number, number, number][] = [];
  const n = t.big ? 11 : 8;
  for (let i = 0; i < n; i++) { const a = (i / n) * TAU + t.hash * 6; const d = t.r * (0.5 + 0.12 * hash(i, t.hash * 1000, 1)); lobes.push([Math.cos(a) * d, Math.sin(a) * d * 0.9, t.r * (0.4 + 0.1 * hash(i, t.hash * 1000, 2))]); }
  lobes.push([0, 0, t.r * 0.62], [-t.r * 0.2, -t.r * 0.15, t.r * 0.5]);
  const path = (dx = 0, dy = 0, k = 1) => { g.beginPath(); for (const [x, y, r] of lobes) { g.moveTo(x * k + dx + r * k, y * k + dy); g.arc(x * k + dx, y * k + dy, r * k, 0, TAU); } };
  // Ink silhouette first (stroked wide, then the fill covers the inner half), then base, shade, two lit steps.
  path(); g.strokeStyle = C.ink; g.lineWidth = 5; g.lineJoin = 'round'; g.stroke();
  path(); g.fillStyle = t.fol.base; g.fill();
  g.save(); path(); g.clip();
  g.fillStyle = t.fol.lo; g.fillRect(-R, -R, R * 2, R * 2);
  path(-t.r * 0.05, -t.r * 0.07); g.fillStyle = t.fol.base; g.fill();
  path(-t.r * 0.1, -t.r * 0.14, 0.88); g.fillStyle = t.fol.mid; g.fill();
  path(-t.r * 0.16, -t.r * 0.22, 0.6); g.fillStyle = t.fol.hi; g.fill();
  // Leaf notches and a few blossoms or fruit.
  g.strokeStyle = t.fol.lo; g.lineWidth = 2.2; g.lineCap = 'round';
  g.beginPath();
  for (let i = 0; i < 26; i++) { const a = hash(i, t.hash * 999, 7) * TAU, d = t.r * (0.2 + 0.7 * hash(i, t.hash * 999, 8)); const x = Math.cos(a) * d, y = Math.sin(a) * d * 0.9; g.moveTo(x - 6, y + 2); g.quadraticCurveTo(x, y - 6, x + 6, y + 2); }
  g.stroke();
  if (t.fol.fruit) { g.fillStyle = t.fol.fruit; for (let i = 0; i < 14; i++) { const a = hash(i, t.hash * 999, 9) * TAU, d = t.r * 0.75 * hash(i, t.hash * 999, 10); g.beginPath(); g.arc(Math.cos(a) * d, Math.sin(a) * d * 0.9, 4.4, 0, TAU); g.fill(); } }
  g.restore();
  // Willows let their fringe hang.
  if (t.big) {
    g.strokeStyle = t.fol.mid; g.lineWidth = 3; g.lineCap = 'round';
    g.beginPath(); for (let i = 0; i < 26; i++) { const a = Math.PI * (0.05 + 0.9 * (i / 25)); const x = Math.cos(a) * t.r * 0.96, y = Math.sin(a) * t.r * 0.86; g.moveTo(x, y); g.lineTo(x * 1.02, y + 16 + 10 * hash(i, 3, 3)); }
    g.stroke();
  }
  // Dusk: the lit sky is already in the ambient pass, so the canopy sits a little cool.
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = 'rgba(26, 36, 78, 0.2)';
  g.fillRect(-R, -R, R * 2, R * 2);
  sprites.set(key, c);
  return c;
}

/* --------------------------------------------------------------- water */

type WaterRect = { x: number; y: number; w: number; h: number; id: number };
const water: WaterRect[] = [];
{
  let id = 0;
  for (const w of wallsOf('pond')) {
    const o = openSides('pond', w);
    const i = { n: o.n ? 9 : 0, e: o.e ? 9 : 0, s: o.s ? 9 : 0, w: o.w ? 9 : 0 };
    water.push({ x: w.x + i.w, y: w.y + i.n, w: w.w - i.w - i.e, h: w.h - i.n - i.s, id: id++ });
  }
  for (const w of wallsOf('parkstone')) {
    if (!isBasin(w)) continue;
    const o = openSides('parkstone', w);
    const i = { n: o.n ? 12 : 0, e: o.e ? 12 : 0, s: o.s ? 12 : 0, w: o.w ? 12 : 0 };
    water.push({ x: w.x + i.w, y: w.y + i.n, w: w.w - i.w - i.e, h: w.h - i.n - i.s, id: id++ });
  }
}
let waveTile: HTMLCanvasElement | null = null;
function waves(): HTMLCanvasElement {
  if (waveTile) return waveTile;
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  const g = c.getContext('2d')!;
  g.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    const x = hash(i, 1, 1) * 160, y = hash(i, 2, 1) * 160, w = 22 + hash(i, 3, 1) * 20;
    for (const [dx, dy] of [[0, 0], [-160, 0], [160, 0], [0, -160], [0, 160]]) {
      g.strokeStyle = 'rgba(190, 232, 222, 0.34)'; g.lineWidth = 3.4;
      g.beginPath(); g.moveTo(x + dx! - w / 2, y + dy!); g.quadraticCurveTo(x + dx!, y + dy! - 5, x + dx! + w / 2, y + dy!); g.stroke();
      g.strokeStyle = 'rgba(10, 30, 36, 0.28)'; g.lineWidth = 2.4;
      g.beginPath(); g.moveTo(x + dx! - w / 2 + 6, y + dy! + 8); g.quadraticCurveTo(x + dx! + 6, y + dy! + 4, x + dx! + w / 2 + 6, y + dy! + 8); g.stroke();
    }
  }
  return (waveTile = c);
}

function drawWater(g: G, v: ThemeView, now: number, still: boolean) {
  const pat = g.createPattern(waves(), 'repeat');
  if (!pat) return;
  const t = still ? 0 : now;
  g.save();
  for (const r of water) {
    if (r.x > v.x1 || r.x + r.w < v.x0 || r.y > v.y1 || r.y + r.h < v.y0) continue;
    g.save();
    g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
    for (const [sx, sy, a] of [[0.006, 0.0035, 1], [-0.0045, 0.0055, 0.6]] as const) {
      pat.setTransform(new DOMMatrix().translate(t * sx * 10, t * sy * 10 + (a < 1 ? 40 : 0)));
      g.globalAlpha = a;
      g.fillStyle = pat;
      g.fillRect(r.x, r.y, r.w, r.h);
    }
    g.globalAlpha = 1;
    // Glints that come and go on the surface.
    const n = Math.max(1, Math.floor((r.w * r.h) / 7000));
    for (let i = 0; i < n; i++) {
      const k = Math.sin(t * 0.0013 + hash(r.id, i, 2) * 40);
      if (k < 0.82) continue;
      const a = (k - 0.82) / 0.18, x = r.x + 12 + hash(r.id, i, 3) * Math.max(1, r.w - 24), y = r.y + 12 + hash(r.id, i, 4) * Math.max(1, r.h - 24);
      g.fillStyle = `rgba(230, 250, 240, ${(0.85 * a).toFixed(2)})`;
      g.fillRect(x - 1.5, y - 5 * a, 3, 10 * a); g.fillRect(x - 5 * a, y - 1.5, 10 * a, 3);
    }
    g.restore();
  }
  g.restore();
}

/* ------------------------------------------------------ lobes and ducks */

type Lobe = { x0: number; y0: number; x1: number; y1: number; cx: number; cy: number; rx: number; ry: number; district: string };
const lobes: Lobe[] = [];
{
  const rects = wallsOf('pond').map((r) => ({ ...r, g: -1 }));
  let n = 0;
  for (const r of rects) {
    if (r.g >= 0) continue;
    r.g = n;
    const stack = [r];
    while (stack.length) {
      const a = stack.pop()!;
      for (const b of rects) if (b.g < 0 && b.x <= a.x + a.w && b.x + b.w >= a.x && b.y <= a.y + a.h && b.y + b.h >= a.y) { b.g = n; stack.push(b); }
    }
    n++;
  }
  for (let i = 0; i < n; i++) {
    const m = rects.filter((r) => r.g === i);
    const x0 = Math.min(...m.map((r) => r.x)), y0 = Math.min(...m.map((r) => r.y)), x1 = Math.max(...m.map((r) => r.x + r.w)), y1 = Math.max(...m.map((r) => r.y + r.h));
    lobes.push({ x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, rx: (x1 - x0) / 2, ry: (y1 - y0) / 2, district: districtAt((x0 + x1) / 2, (y0 + y1) / 2).id });
  }
}

function drawDuck(g: G, x: number, y: number, dir: number, s: number, now: number, mother = false) {
  const bob = Math.sin(now * 0.002 + x * 0.05) * 0.8;
  g.save();
  g.translate(x, y + bob); g.scale(s * dir, s);
  // Wake behind it.
  g.strokeStyle = 'rgba(210, 240, 232, 0.5)'; g.lineWidth = 2.4;
  g.beginPath(); g.moveTo(-14, 4); g.quadraticCurveTo(-26, 2, -34, 8); g.moveTo(-14, 8); g.quadraticCurveTo(-24, 10, -32, 15); g.stroke();
  g.fillStyle = 'rgba(10, 24, 28, 0.3)'; g.beginPath(); g.ellipse(2, 8, 14, 5, 0, 0, TAU); g.fill();
  g.beginPath(); g.ellipse(0, 2, 13, 8.5, 0, 0, TAU); g.fillStyle = mother ? '#b79e72' : '#e8d9a0'; g.fill(); g.strokeStyle = C.ink; g.lineWidth = 2 / s; g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(-7, -2, 8, 2.4);
  g.beginPath(); g.ellipse(-9, 2, 5, 3, -0.4, 0, TAU); g.fillStyle = mother ? '#9a8258' : '#d6c47e'; g.fill(); g.stroke();
  g.beginPath(); g.arc(11, -6, 6, 0, TAU); g.fillStyle = mother ? '#3f6b4a' : '#e8d9a0'; g.fill(); g.stroke();
  g.beginPath(); g.moveTo(16, -6); g.lineTo(24, -4); g.lineTo(16, -2); g.closePath(); g.fillStyle = C.mustard; g.fill(); g.stroke();
  g.fillStyle = C.ink; g.fillRect(12, -8, 2, 2);
  g.restore();
}

function ducks(g: G, v: ThemeView, now: number, still: boolean) {
  lobes.forEach((l, i) => {
    if (!inV(v, l.cx, l.cy, Math.max(l.rx, l.ry))) return;
    const t = still ? 0 : now;
    const family = l.district === 'lanterns' && i === lobes.findIndex((q) => q.district === 'lanterns');
    const track = (phase: number, speed: number, k: number, ox = 0) => {
      const a = t * speed + phase;
      return { x: l.cx + Math.cos(a) * l.rx * k + ox, y: l.cy + Math.sin(a) * l.ry * k * 0.9, dx: -Math.sin(a) * Math.sign(speed || 1) };
    };
    const rider = (phase: number, speed: number, k: number, s: number, mother = false) => {
      const p = track(phase, speed, k);
      if (inside('pond', p.x, p.y)) drawDuck(g, p.x, p.y, p.dx >= 0 ? 1 : -1, s, now, mother);
    };
    rider(i * 2.1, 0.000055, 0.5, 1);
    rider(i * 2.1 + 3.4, -0.00004, 0.36, 0.9);
    if (family) {
      rider(1.1, 0.00005, 0.62, 1.15, true);
      for (let k = 1; k <= 3; k++) rider(1.1 - k * 0.075, 0.00005, 0.62, 0.55);
    }
  });
}

/** Lily pads, bobbing a pixel, some with a bloom. */
function lilies(g: G, v: ThemeView, now: number, still: boolean) {
  for (const [i, r] of water.entries()) {
    if (r.x > v.x1 || r.x + r.w < v.x0 || r.y > v.y1 || r.y + r.h < v.y0 || r.w < 80 || r.h < 80) continue;
    const n = Math.floor((r.w * r.h) / 14000);
    for (let k = 0; k < n; k++) {
      const x = r.x + 24 + hash(i, k, 10) * (r.w - 48), y = r.y + 24 + hash(i, k, 11) * (r.h - 48), rad = 10 + hash(i, k, 12) * 6;
      const bob = still ? 0 : Math.sin(now * 0.0012 + k * 1.7 + i) * 1.2;
      g.save(); g.translate(x, y + bob); g.rotate(hash(i, k, 13) * TAU);
      g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, rad, 0.35, TAU - 0.35); g.closePath();
      g.fillStyle = '#4c7a45'; g.fill(); g.strokeStyle = C.ink; g.lineWidth = 1.8; g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.2)'; g.beginPath(); g.arc(-2, -2, rad * 0.45, 3.4, 5); g.fill();
      g.restore();
      if (hash(i, k, 14) > 0.7) { g.fillStyle = '#e6b2b6'; g.beginPath(); g.arc(x + 2, y + bob - 1, 4.2, 0, TAU); g.fill(); g.strokeStyle = C.ink; g.lineWidth = 1.4; g.stroke(); g.fillStyle = '#e8c868'; g.fillRect(x + 1, y + bob - 2, 2, 2); }
    }
  }
}

/* ------------------------------------------------------------ fountain */

function fountain(g: G, v: ThemeView, now: number, still: boolean) {
  if (!inV(v, MID, MID, 200)) return;
  g.save();
  g.beginPath(); g.arc(MID, MID, 128, 0, TAU); g.clip();
  const pat = g.createPattern(waves(), 'repeat');
  if (pat) { pat.setTransform(new DOMMatrix().translate((still ? 0 : now) * 0.02, (still ? 0 : now) * 0.011)); g.fillStyle = pat; g.fillRect(MID - 130, MID - 130, 260, 260); }
  // Coins on the bottom that catch the light, and ripples spreading from where the spray lands.
  for (let i = 0; i < 9; i++) {
    const a = hash(i, 5, 5) * TAU, d = 30 + hash(i, 6, 5) * 80, k = Math.sin((still ? 0 : now) * 0.0011 + i * 2.3);
    g.fillStyle = k > 0.55 ? 'rgba(235, 244, 230, 0.95)' : 'rgba(176, 190, 190, 0.5)';
    g.beginPath(); g.arc(MID + Math.cos(a) * d, MID + Math.sin(a) * d, 2.4, 0, TAU); g.fill();
  }
  g.strokeStyle = 'rgba(220, 248, 240, 0.45)'; g.lineWidth = 2.4;
  for (let i = 0; i < 4; i++) {
    const k = ((still ? 0.3 : now / 2800) + i / 4) % 1;
    g.beginPath(); g.arc(MID, MID, 20 + 100 * k, 0, TAU); g.globalAlpha = 1 - k; g.stroke();
  }
  g.globalAlpha = 1;
  g.restore();
  // The spout: a stone boss with the spray rising and falling in arcs round it.
  g.fillStyle = 'rgba(10, 24, 28, 0.3)'; g.beginPath(); g.ellipse(MID + 7, MID + 9, 30, 13, 0, 0, TAU); g.fill();
  g.beginPath(); g.arc(MID, MID, 24, 0, TAU); g.fillStyle = C.stone; g.fill(); g.strokeStyle = C.ink; g.lineWidth = 2.4; g.stroke();
  g.beginPath(); g.arc(MID - 3, MID - 3, 14, 0, TAU); g.fillStyle = C.stoneHi; g.fill(); g.stroke();
  const jets = 10;
  for (let j = 0; j < jets; j++) {
    const a = (j / jets) * TAU;
    for (let d = 0; d < 6; d++) {
      const k = ((still ? 0.4 : now / 1600) + d / 6 + j * 0.07) % 1;
      const r = 14 + 74 * k, lift = Math.sin(k * Math.PI) * 38;
      g.fillStyle = `rgba(228, 248, 245, ${(0.9 * (1 - k * 0.5)).toFixed(2)})`;
      g.beginPath(); g.arc(MID + Math.cos(a) * r, MID + Math.sin(a) * r - lift, 3.4 - 1.2 * k, 0, TAU); g.fill();
    }
  }
}

/* ------------------------------------------------------ swings and boats */

function swings(g: G, v: ThemeView, now: number, still: boolean) {
  for (const w of wallsOf('play')) {
    if (w.w < w.h * 4 || !inV(v, w.x + w.w / 2, w.y, w.w)) continue;
    for (let i = 0; i < 3; i++) {
      const cx = w.x + w.w * (0.22 + i * 0.28), sway = still ? 0 : Math.sin(now * 0.0016 + i * 1.3 + w.x) * (i === 1 ? 0.22 : 0.08);
      const len = 46, sx = cx + Math.sin(sway) * len, sy = w.y + w.h + Math.cos(sway) * len;
      g.strokeStyle = C.ink; g.lineWidth = 3.4; g.beginPath(); g.moveTo(cx - 8, w.y + w.h - 6); g.lineTo(sx - 8, sy); g.moveTo(cx + 8, w.y + w.h - 6); g.lineTo(sx + 8, sy); g.stroke();
      g.strokeStyle = '#8b94a1'; g.lineWidth = 1.4; g.stroke();
      g.fillStyle = 'rgba(14,18,24,0.28)'; g.beginPath(); g.ellipse(sx + 6, sy + 10, 14, 5, 0, 0, TAU); g.fill();
      g.fillStyle = [C.rust, C.mustard, C.teal][i]!; g.fillRect(sx - 12, sy - 4, 24, 8); g.strokeStyle = C.ink; g.lineWidth = 2; g.strokeRect(sx - 12, sy - 4, 24, 8);
    }
  }
}

function boatAndJetty(g: G, v: ThemeView, now: number, still: boolean) {
  const l = lobes.find((q) => q.district === 'boathouse');
  if (!l || !inV(v, l.cx, l.cy, l.rx + 100)) return;
  // A jetty reaching out over the water from the pond's north bank, and the boat tied alongside.
  const jx = l.cx - l.rx * 0.34, jy = l.y0 + 6;
  g.fillStyle = 'rgba(10,24,28,0.3)'; g.fillRect(jx + 6, jy + 8, 46, 190);
  g.fillStyle = C.wood; g.fillRect(jx, jy, 46, 184);
  for (let y = jy + 6; y < jy + 184; y += 14) { g.fillStyle = (y / 14) % 2 ? C.woodHi : C.wood; g.fillRect(jx + 1, y, 44, 12); g.fillStyle = 'rgba(8,6,4,0.45)'; g.fillRect(jx + 1, y + 12, 44, 2); }
  g.strokeStyle = C.ink; g.lineWidth = 2.4; g.strokeRect(jx, jy, 46, 184);
  for (const [px, py] of [[jx - 2, jy + 10], [jx + 48, jy + 10], [jx - 2, jy + 170], [jx + 48, jy + 170]]) { g.fillStyle = C.woodLo; g.beginPath(); g.arc(px!, py!, 5, 0, TAU); g.fill(); g.stroke(); }
  put(g, 'rowboat', P.rowboat, jx + 100, jy + 110 + (still ? 0 : Math.sin(now * 0.0013) * 2), { rot: 1.4 + (still ? 0 : Math.sin(now * 0.0009) * 0.03) });
  void v;
}

/* ------------------------------------------------------- lanterns, light */

type Lantern = { lobe: number; phase: number; speed: number; k: number };
const lanterns: Lantern[] = [];
lobes.forEach((l, i) => { if (l.district === 'lanterns') for (let n = 0; n < 4; n++) lanterns.push({ lobe: i, phase: n * 1.6 + 0.4, speed: 0.00003 * (n % 2 ? -1 : 1), k: 0.22 + n * 0.12 }); });

function lanternPos(l: Lantern, now: number, still: boolean) {
  const b = lobes[l.lobe]!, a = (still ? 0 : now) * l.speed + l.phase;
  return { x: b.cx + Math.cos(a) * b.rx * l.k * 1.6, y: b.cy + Math.sin(a) * b.ry * l.k * 1.5 };
}

function lanternSprite(g: G, x: number, y: number, now: number, still: boolean) {
  const bob = still ? 0 : Math.sin(now * 0.0017 + x) * 1.1;
  const glow = g.createRadialGradient(x, y + bob, 2, x, y + bob, 30);
  glow.addColorStop(0, 'rgba(255, 190, 100, 0.55)'); glow.addColorStop(1, 'rgba(255, 190, 100, 0)');
  g.fillStyle = glow; g.fillRect(x - 30, y + bob - 30, 60, 60);
  g.beginPath(); g.moveTo(x - 8, y + bob - 7); g.lineTo(x + 8, y + bob - 7); g.lineTo(x + 10, y + bob + 5); g.lineTo(x - 10, y + bob + 5); g.closePath();
  g.fillStyle = '#ffd088'; g.fill(); g.strokeStyle = C.ink; g.lineWidth = 2; g.stroke();
  g.fillStyle = '#c0522e'; g.fillRect(x - 9, y + bob - 9, 18, 3); g.fillRect(x - 9, y + bob + 4, 18, 3);
}

/* ------------------------------------------------------------- the lights */

const GLOW_R = 620;
function lights(v: ThemeView, now: number) {
  for (const d of DISTRICTS) {
    const x = d.col === 0 ? 900 : d.col === 1 ? 3000 : 5100, y = d.row === 0 ? 900 : d.row === 1 ? 3000 : 5100;
    if (inV(v, x, y, GLOW_R)) setLight(`park:glow:${d.id}`, { x, y, radius: GLOW_R, color: d.light, intensity: d.glow * 0.7, shadows: false, size: 40 });
  }
  if (inV(v, MID, MID, 400)) setLight('park:fountain', { x: MID, y: MID, radius: 330, color: '#c8ecff', intensity: 0.55, flicker: 0.08, shadows: false, size: 30 });
  // The lanterns on the pond, each a candle.
  for (const [i, l] of lanterns.entries()) { const p = lanternPos(l, now, false); if (inV(v, p.x, p.y, 140)) setLight(`park:lantern:${i}`, { x: p.x, y: p.y, radius: 130, color: '#ffb766', intensity: 0.7, flicker: 0.2, shadows: false, size: 6 }); }
  // Floodlights over the courts, bulbs on the bandstand's bunting, a lamp at each shell.
  for (const [i, [x, y]] of ([[4480, 2180], [5320, 2180], [4480, 2860], [5320, 2860]] as const).entries()) if (inV(v, x, y, 480)) setLight(`park:flood:${i}`, { x, y: y - 60, radius: 440, color: '#e4ecff', intensity: 0.8, shadows: false, size: 18 });
  for (const [i, [x, y]] of BULBS.entries()) if (inV(v, x, y, 200)) setLight(`park:bulb:${i}`, { x, y, radius: 190, color: '#ffc27a', intensity: 0.55, flicker: 0.1, shadows: false, size: 8 });
  void now;
}

/* ------------------------------------------------------------- bunting */

type Span = { x0: number; y0: number; x1: number; y1: number; sag: number; dangling?: boolean; bulbs?: boolean };
const SPANS: Span[] = [
  { x0: 760, y0: 1180, x1: 1090, y1: 1130, sag: 34, bulbs: true }, { x0: 1090, y0: 1130, x1: 1470, y1: 1210, sag: 38, bulbs: true },
  { x0: 1470, y0: 1210, x1: 1560, y1: 1560, sag: 30, dangling: true },
  { x0: 4160, y0: 880, x1: 4440, y1: 840, sag: 30, bulbs: true }, { x0: 4440, y0: 840, x1: 4740, y1: 900, sag: 34, bulbs: true },
];
const BULBS: [number, number][] = [];
for (const s of SPANS) if (s.bulbs) for (let i = 1; i < 5; i++) { const t = i / 5; BULBS.push([s.x0 + (s.x1 - s.x0) * t, s.y0 + (s.y1 - s.y0) * t + Math.sin(t * Math.PI) * s.sag - 4]); }

function bunting(g: G, v: ThemeView, now: number, still: boolean) {
  const cols = [C.rust, C.mustard, C.cream, C.teal, C.rose];
  for (const [si, s] of SPANS.entries()) {
    if (!inV(v, (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, 360)) continue;
    const at = (t: number) => ({ x: s.x0 + (s.x1 - s.x0) * t, y: s.y0 + (s.y1 - s.y0) * t + Math.sin(t * Math.PI) * s.sag * (s.dangling ? 1 + t : 1) + (s.dangling ? t * t * 130 : 0) });
    g.strokeStyle = '#4a3f2e'; g.lineWidth = 2.2; g.beginPath();
    for (let i = 0; i <= 24; i++) { const p = at(i / 24); if (i) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); }
    g.stroke();
    const n = Math.round(Math.hypot(s.x1 - s.x0, s.y1 - s.y0) / 30);
    for (let i = 1; i < n; i++) {
      const p = at(i / n), sw = still ? 0 : Math.sin(now * 0.0011 + i * 0.9 + si) * 1.8;
      g.beginPath(); g.moveTo(p.x - 8, p.y); g.lineTo(p.x + 8, p.y); g.lineTo(p.x + sw, p.y + 17); g.closePath();
      g.fillStyle = cols[(i + si) % 5]!; g.fill(); g.strokeStyle = C.ink; g.lineWidth = 1.8; g.lineJoin = 'round'; g.stroke();
    }
    if (s.bulbs) for (let i = 1; i < 5; i++) {
      const p = at(i / 5);
      const glow = g.createRadialGradient(p.x, p.y + 4, 1, p.x, p.y + 4, 22);
      glow.addColorStop(0, 'rgba(255, 210, 130, 0.6)'); glow.addColorStop(1, 'rgba(255, 210, 130, 0)');
      g.fillStyle = glow; g.fillRect(p.x - 22, p.y - 18, 44, 44);
      g.fillStyle = '#ffe3a0'; g.beginPath(); g.arc(p.x, p.y + 4, 3.6, 0, TAU); g.fill(); g.strokeStyle = C.ink; g.lineWidth = 1.4; g.stroke();
    }
  }
}

/* ---------------------------------------------------------- tall things */

function pergola(g: G, v: ThemeView, bodies: readonly { x: number; y: number }[], x0 = 925, x1 = 1125, wisteria = false) {
  // Four stone posts in the boulevard carry a lattice of beams and vine; thin where anyone stands.
  const y0 = 2875, y1 = 3125;
  if (!inV(v, (x0 + x1) / 2, (y0 + y1) / 2, 220)) return;
  const under = bodies.some((b) => b.x > x0 - 20 && b.x < x1 + 70 && b.y > y0 - 60 && b.y < y1 + 20);
  g.save();
  g.globalAlpha = under ? 0.3 : 0.92;
  for (const [ax, ay, bx, by, w] of [[x0, y0 - 24, x0, y1 - 24, 9], [x1, y0 - 24, x1, y1 - 24, 9]] as const) { g.strokeStyle = C.ink; g.lineWidth = w + 4; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke(); g.strokeStyle = '#d6d0bd'; g.lineWidth = w; g.stroke(); }
  for (let y = y0 - 24; y <= y1 - 24; y += 25) { g.strokeStyle = C.ink; g.lineWidth = 8; g.beginPath(); g.moveTo(x0 - 14, y); g.lineTo(x1 + 14, y); g.stroke(); g.strokeStyle = '#c4bda6'; g.lineWidth = 4; g.stroke(); }
  for (let i = 0; i < 46; i++) {
    const x = x0 - 8 + hash(i, 1, 77) * (x1 - x0 + 16), y = y0 - 28 + hash(i, 2, 77) * (y1 - y0 + 8);
    g.fillStyle = hash(i, 3, 77) > 0.35 ? '#4f7a40' : '#3a5f31'; g.beginPath(); g.ellipse(x, y, 9, 5.5, hash(i, 4, 77) * TAU, 0, TAU); g.fill(); g.strokeStyle = C.ink; g.lineWidth = 1.4; g.stroke();
    if (hash(i, 5, 77) > (wisteria ? 0.45 : 0.8)) { g.fillStyle = wisteria ? '#a58ad0' : '#e6b2b6'; g.beginPath(); g.arc(x + 2, y, 4, 0, TAU); g.fill(); g.stroke(); }
  }
  g.restore();
}

function tallThings(g: G, v: ThemeView, bodies: readonly { x: number; y: number }[], now: number, still: boolean) {
  for (const [x, y] of [[4480, 2180], [5320, 2180], [4480, 2860], [5320, 2860]] as const) if (inV(v, x, y, 140)) put(g, 'flood', P.floodlight, x, y);
  void bodies; void now; void still;
}

function balloon(g: G, v: ThemeView, now: number, bodies: readonly { x: number; y: number }[], still: boolean) {
  const bx = 2700, by = 4930, bob = still ? 0 : Math.sin(now * 0.0005) * 5;
  if (!inV(v, bx, by, 260)) return;
  const under = bodies.some((b) => Math.hypot(b.x - bx, b.y - by) < 130);
  g.save();
  g.globalAlpha = under ? 0.3 : 0.94;
  // Basket and ropes down to the peg in the grass.
  g.strokeStyle = '#d9cfa8'; g.lineWidth = 2.2; g.beginPath(); g.moveTo(bx - 40, by + 80 + bob); g.lineTo(bx - 12, by + 138); g.moveTo(bx + 40, by + 80 + bob); g.lineTo(bx + 12, by + 138); g.moveTo(bx, by + 150); g.lineTo(bx + 60, by + 290); g.stroke();
  g.fillStyle = C.woodHi; g.fillRect(bx - 16, by + 134 + bob * 0.5, 32, 24); g.strokeStyle = C.ink; g.lineWidth = 2.2; g.strokeRect(bx - 16, by + 134 + bob * 0.5, 32, 24);
  // The envelope, in gores of rust, cream and teal.
  const r = 112;
  g.beginPath(); g.ellipse(bx, by + bob, r, r * 1.08, 0, 0, TAU); g.fillStyle = C.cream; g.fill();
  g.save(); g.beginPath(); g.ellipse(bx, by + bob, r, r * 1.08, 0, 0, TAU); g.clip();
  const gores = [C.rust, C.cream, C.teal, C.mustard, C.cream, C.rose, C.cream];
  for (let i = 0; i < 7; i++) { g.fillStyle = gores[i]!; g.beginPath(); g.moveTo(bx, by + bob - r * 1.1); g.quadraticCurveTo(bx - r + (i * 2 * r) / 7 - 12, by + bob, bx - 0.5 * r + (i * r) / 7 - 20, by + bob + r * 1.1); g.lineTo(bx - 0.5 * r + ((i + 1) * r) / 7 - 20, by + bob + r * 1.1); g.quadraticCurveTo(bx - r + ((i + 1) * 2 * r) / 7 - 12, by + bob, bx, by + bob - r * 1.1); g.fill(); }
  g.fillStyle = 'rgba(8,12,20,0.3)'; g.beginPath(); g.ellipse(bx + r * 0.35, by + bob + r * 0.15, r * 0.9, r * 1.1, 0, -1.2, 1.6); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.22)'; g.beginPath(); g.ellipse(bx - r * 0.38, by + bob - r * 0.38, r * 0.2, r * 0.32, -0.5, 0, TAU); g.fill();
  g.restore();
  g.beginPath(); g.ellipse(bx, by + bob, r, r * 1.08, 0, 0, TAU); g.strokeStyle = C.ink; g.lineWidth = 3; g.stroke();
  g.restore();
}

/* ------------------------------------------------------------ fireflies */

function fireflies(g: G, v: ThemeView, now: number, still: boolean) {
  const cell = 380, c0x = Math.floor(v.x0 / cell), c1x = Math.floor(v.x1 / cell), c0y = Math.floor(v.y0 / cell), c1y = Math.floor(v.y1 / cell);
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) {
    const n = hash(cx, cy, 31) < 0.55 ? 1 : 0;
    if (!n) continue;
    const t = still ? 0 : now;
    const x = cx * cell + cell / 2 + Math.sin(t * 0.00031 + cx * 3.1) * 90 + Math.cos(t * 0.00053 + cy) * 40, y = cy * cell + cell / 2 + Math.cos(t * 0.00027 + cy * 2.3) * 90 + Math.sin(t * 0.00047 + cx) * 40;
    if (inside('hedge', x, y) || inside('pond', x, y)) continue;
    const blink = still ? 0.6 : Math.max(0, Math.sin(t * 0.0026 + hash(cx, cy, 32) * 20)) ** 2;
    if (blink < 0.05) continue;
    const grd = g.createRadialGradient(x, y, 0, x, y, 20);
    grd.addColorStop(0, `rgba(210, 255, 120, ${(0.55 * blink).toFixed(2)})`); grd.addColorStop(1, 'rgba(210, 255, 120, 0)');
    g.fillStyle = grd; g.fillRect(x - 20, y - 20, 40, 40);
    g.fillStyle = `rgba(250, 255, 200, ${(0.9 * blink).toFixed(2)})`; g.beginPath(); g.arc(x, y, 1.8, 0, TAU); g.fill();
  }
  g.restore();
}

function leaves(g: G, v: ThemeView, now: number, still: boolean) {
  if (still) return;
  const cell = 520;
  for (let cy = Math.floor(v.y0 / cell); cy <= Math.floor(v.y1 / cell); cy++) for (let cx = Math.floor(v.x0 / cell); cx <= Math.floor(v.x1 / cell); cx++) {
    if (hash(cx, cy, 51) > 0.5) continue;
    const d = districtAt(cx * cell, cy * cell);
    const k = ((now * 0.00004 + hash(cx, cy, 52)) % 1);
    const x = cx * cell + k * cell * 1.3 + Math.sin(k * 14) * 24, y = cy * cell + hash(cx, cy, 53) * cell + k * 120 + Math.cos(k * 11) * 12;
    g.save(); g.translate(x, y); g.rotate(k * 9);
    g.beginPath(); g.ellipse(0, 0, 6, 3, 0, 0, TAU); g.fillStyle = d.id === 'orchard' ? '#d9803a' : d.id === 'roses' ? '#e6b2b6' : '#a8b45a'; g.globalAlpha = 0.9; g.fill(); g.strokeStyle = C.ink; g.lineWidth = 1.2; g.stroke();
    g.restore();
  }
}

/** The kite caught in the playground oak, tail trailing through the leaves. */
function kiteInTree(g: G, v: ThemeView, alpha: number) {
  const t = trees.find((q) => Math.abs(q.x - 2425) < 30 && Math.abs(q.y - 175) < 30);
  if (!t || !inV(v, t.cx, t.cy, t.r)) return;
  g.save(); g.globalAlpha = Math.min(1, alpha + 0.15);
  g.translate(t.cx + 40, t.cy - 70); g.rotate(0.5);
  g.beginPath(); g.moveTo(0, -30); g.lineTo(20, 0); g.lineTo(0, 34); g.lineTo(-20, 0); g.closePath(); g.fillStyle = C.mustard; g.fill(); g.strokeStyle = C.ink; g.lineWidth = 2; g.stroke();
  g.fillStyle = C.rose; g.beginPath(); g.moveTo(0, -30); g.lineTo(20, 0); g.lineTo(0, 0); g.closePath(); g.fill();
  g.strokeStyle = C.ink; g.lineWidth = 1.4; g.beginPath(); g.moveTo(0, -30); g.lineTo(0, 34); g.moveTo(-20, 0); g.lineTo(20, 0); g.stroke();
  g.strokeStyle = '#d9cfa8'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(0, 34); g.bezierCurveTo(-14, 52, 10, 64, -6, 84); g.stroke();
  for (const [x, y] of [[-6, 50], [3, 62], [-4, 78]]) { g.fillStyle = C.teal; g.beginPath(); g.moveTo(x! - 5, y! - 3); g.lineTo(x! + 5, y! + 2); g.lineTo(x! - 4, y! + 5); g.closePath(); g.fill(); g.stroke(); }
  g.restore();
}

/** The map's edge: a stone kerb over the standard hazard curb, with a few mossy joints. */
function kerb(g: G, v: ThemeView) {
  const S = 6000, T = 18;
  const strips: [number, number, number, number][] = [[-T, -T, S + 2 * T, T], [-T, S, S + 2 * T, T], [-T, 0, T, S], [S, 0, T, S]];
  for (const [x, y, w, h] of strips) {
    if (x > v.x1 || x + w < v.x0 || y > v.y1 || y + h < v.y0) continue;
    g.fillStyle = '#9a9381'; g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(255, 252, 230, 0.2)'; g.fillRect(x, y, w, 4);
    g.fillStyle = 'rgba(8, 12, 18, 0.28)'; g.fillRect(x, y + h - 5, w, 5);
    g.strokeStyle = 'rgba(40, 38, 32, 0.55)'; g.lineWidth = 2; g.beginPath();
    const horiz = w > h;
    const from = Math.max(horiz ? x : y, horiz ? v.x0 : v.y0), to = Math.min(horiz ? x + w : y + h, horiz ? v.x1 : v.y1);
    for (let t = Math.floor(from / 100) * 100; t < to; t += 100) { if (horiz) { g.moveTo(t, y); g.lineTo(t, y + h); } else { g.moveTo(x, t); g.lineTo(x + w, t); } }
    g.stroke();
    g.strokeStyle = C.ink; g.lineWidth = 2; g.strokeRect(x, y, w, h);
  }
}

/* --------------------------------------------------------- entry points */

export function parkUnder(g: G, now: number, v: ThemeView, _map: MapDef) {
  const still = reducedMotion();
  kerb(g, v);
  // Tree shadows first, soft and low, so players under a canopy still pop.
  g.fillStyle = 'rgba(12, 20, 14, 0.2)';
  for (const t of trees) if (inV(v, t.x + 40, t.y + 60, t.r)) { g.beginPath(); g.ellipse(t.x + t.r * 0.32, t.y + t.r * 0.38, t.r * 0.82, t.r * 0.52, 0, 0, TAU); g.fill(); }
  drawWater(g, v, now, still);
  lilies(g, v, now, still);
  boatAndJetty(g, v, now, still);
  ducks(g, v, now, still);
  for (const [i, l] of lanterns.entries()) { const p = lanternPos(l, now, still); if (inV(v, p.x, p.y, 40)) lanternSprite(g, p.x, p.y, now, still || i < 0); }
  fountain(g, v, now, still);
  swings(g, v, now, still);
  for (const p of PROPS) if (inV(v, p.x, p.y, p.r)) put(g, p.key, p.make, p.x, p.y);
  // Net across the clay court.
  if (inV(v, 5250, 3600, 360)) put(g, 'net', () => P.net(300), 5100, 3580);
  void MS;
  lights(v, now);
}

export function parkOver(g: G, now: number, v: ThemeView, _map: MapDef, bodies: readonly { x: number; y: number }[] = []) {
  const still = reducedMotion();
  const dt = Math.min(100, now - lastOver);
  lastOver = now;
  tallThings(g, v, bodies, now, still);
  bunting(g, v, now, still);
  pergola(g, v, bodies);
  pergola(g, v, bodies, 4875, 5075, true);
  balloon(g, v, now, bodies, still);
  for (const t of trees) {
    if (!inV(v, t.cx, t.cy, t.r + 20)) continue;
    const under = bodies.some((b) => Math.hypot(b.x - t.cx, (b.y - t.cy) * 1.05) < t.r * 0.86);
    const target = under ? 0.3 : 0.9;
    t.fade = still ? target : t.fade + (target - t.fade) * Math.min(1, dt / MS.fade);
    const c = canopyOf(t);
    g.globalAlpha = t.fade;
    g.drawImage(c, t.cx - c.width / 2.5, t.cy - c.height / 2.5, c.width / 1.25, c.height / 1.25);
    g.globalAlpha = 1;
    if (t.key === '2400,150') kiteInTree(g, v, t.fade);
  }
  leaves(g, v, now, still);
  fireflies(g, v, now, still);
  // The gnome in the rose garden's hedge: a red hat, if you look.
  if (inV(v, 330, 2160, 40)) put(g, 'gnome', P.gnome, 336, 2158);
  void inside;
}
let lastOver = 0;

export function parkLights(): void {}
