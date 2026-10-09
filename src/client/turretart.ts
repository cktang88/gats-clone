import { MAX_LEVEL, type TurretKind } from '../shared/defs.ts';
import { INK, PALETTE, shadeHex, tint } from './palette.ts';
import { celPart, ellipse, polygon, roundBox, TAU, type Trace } from './cel.ts';
import { glowSprite } from './coreart.ts';
import { LIGHT } from './tilt.ts';

/**
 * The squad's turrets as toy emplacements (docs/art/STYLE.md): a sandbagged ring on the cell's pad (bolted steel plates from
 * the second level, a riveted steel collar at the third) round a turntable, and on it the kind's gun head, which turns to
 * aim. Everything is in the kit's chunky cel style: ink outlines, flat paint, a light step toward the key light and a dark
 * one away from it, a front face hanging below each top face.
 *
 * Both halves are baked once into cached sprites at the drawn scale: the base per kind, level and wear, the head per kind,
 * level, wear and one of `BUCKETS` aim angles (painted at that angle so its light stays top-left), turned by the small rest
 * of the aim when drawn. Per frame a turret costs two `drawImage` calls; what moves (muzzle flash, light pool, status lamp,
 * ammo gauge, the coil's glow) is drawn over the night's shade by `drawTurretLights`.
 */

/** How many aim angles each head is baked at; the rest of the aim (at most half a step) turns the nearest one. */
export const HEAD_BUCKETS = 24;
const SCALE_STEP = 20;
const SCALES_KEPT = 3;
const PER_SCALE = 420;
/** Half the side of a base sprite and a head sprite, in world px. */
const BASE_HALF = 46;
const HEAD_HALF = 48;
/** Heads are painted this much larger than their plan, so the gun reads over its emplacement. */
export const HEAD_SCALE = 1.2;
/** The turntable's top stands this far above the pad, so the head turns about a point that far up-screen of the cell centre. */
export const MOUNT_RISE = 3;

const GUNMETAL = '#4f5560';
const GUNMETAL_DARK = '#3d4450';
const BARREL = '#2c3037';
const KHAKI = '#b4a07a';
const KHAKI_DARK = '#978562';
const OLIVE = '#6c7356';
const RUST = '#a8552e';
const BRASS = '#b79a4a';
const BONE = '#e2dccb';
const STEEL = '#808a99';
const SCORCH = 'rgba(24, 20, 17, 0.5)';

/** Each kind's paint: the head's body tone and the accent stripe that also lights its ammo gauge (and its minimap dot). */
export const TURRET_LOOK: Record<TurretKind, { body: string; accent: string }> = {
  sentry: { body: STEEL, accent: '#e0a43a' },
  cannon: { body: '#848b68', accent: '#d0573a' },
  scatter: { body: '#78808c', accent: '#5fa595' },
  mortar: { body: '#5f6b50', accent: '#9a86c4' },
  tesla: { body: RUST, accent: '#8fb8ff' },
};

/**
 * How a standing building has worn, from its health in tenths (1..10, rounded up, so 3 is anything up to 30%):
 * 0 sound (over half); 1 worn, at half or less: dented, scorch-streaked, a few bags slumped, a loose plate, wisps of smoke
 * and a lamp that stutters; 2 badly damaged, at 30% or less: blackened and charred, bags burst and gone, a crooked barrel,
 * an ember glow, sparks and a steady dark plume. A building at 0 is gone from the sim and leaves a wreck (wrecks.ts).
 */
export type Wear = 0 | 1 | 2;
export const WORN_AT = 5;
export const BAD_AT = 3;
export const wearStage = (hpTenths: number): Wear => (hpTenths <= BAD_AT ? 2 : hpTenths <= WORN_AT ? 1 : 0);
/** How far a badly damaged gun's barrels are knocked crooked, in radians. */
export const BEND = 0.22;

/** The nearest baked aim and the rest of the angle to turn it by. */
export function headBucket(angle: number): { index: number; rest: number } {
  const step = TAU / HEAD_BUCKETS;
  const raw = Math.round(angle / step);
  return { index: ((raw % HEAD_BUCKETS) + HEAD_BUCKETS) % HEAD_BUCKETS, rest: angle - raw * step };
}

// ---- the sprite cache ----

const byScale = new Map<number, Map<string, HTMLCanvasElement>>();
let lastScale = 0;
/** How many sprites have been painted, for the test that proves a steady frame paints none. */
export const turretBakes = { count: 0 };

/**
 * A sprite baked once per drawn scale and `key`, `half` world px each side of its centre, which `paint` draws about in world
 * units. Shared by the siege's baked art (turrets, depots, posts, wrecks): a few scales are kept, the least recent dropped.
 */
export function bakedSprite(key: string, half: number, pxPerUnit: number, paint: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const px = Math.max(0.25, Math.round(pxPerUnit * SCALE_STEP) / SCALE_STEP);
  let sprites = byScale.get(px);
  if (sprites) { if (lastScale !== px) { byScale.delete(px); byScale.set(px, sprites); } }
  else {
    byScale.set(px, (sprites = new Map()));
    for (const old of byScale.keys()) { if (byScale.size <= SCALES_KEPT) break; byScale.delete(old); }
  }
  lastScale = px;
  let image = sprites.get(key);
  if (!image) {
    if (sprites.size >= PER_SCALE) sprites.delete(sprites.keys().next().value!);
    image = document.createElement('canvas');
    image.width = image.height = Math.ceil(half * 2 * px);
    const g = image.getContext('2d')!;
    g.scale(px, px);
    g.translate(half, half);
    paint(g);
    turretBakes.count++;
    sprites.set(key, image);
  }
  return image;
}

// ---- small cel helpers ----

/** A part drawn turned by `turn` (the sprite's frame) after moving to `x`, `y` and turning by `a` within it. */
function partAt(g: CanvasRenderingContext2D, turn: number, x: number, y: number, a: number, trace: Trace, base: string, size: number, ink: number, lip: number, rise: number) {
  g.save();
  g.translate(x, y);
  if (a) g.rotate(a);
  celPart(g, trace, base, turn + a, size, ink, lip, rise);
  g.restore();
}

/** Where the up-screen direction points in a frame turned by `turn`: a part standing `h` high is drawn shifted this far. */
const upIn = (turn: number, h: number): [number, number] => [-h * Math.sin(turn), -h * Math.cos(turn)];
/** The key light's direction in a frame turned by `turn`. */
const lightIn = (turn: number): [number, number] => [LIGHT.x * Math.cos(turn) + LIGHT.y * Math.sin(turn), -LIGHT.x * Math.sin(turn) + LIGHT.y * Math.cos(turn)];

function dots(g: CanvasRenderingContext2D, pts: readonly (readonly [number, number])[], r: number, color = INK) {
  g.fillStyle = color;
  g.beginPath();
  for (const [x, y] of pts) { g.moveTo(x + r, y); g.arc(x, y, r, 0, TAU); }
  g.fill();
}

/** A round toy form's single specular dot, on the lit side of a part whose top face is centred at (`x`, `y`). */
function spec(g: CanvasRenderingContext2D, turn: number, x: number, y: number, reach: number, r = 1.1) {
  const [lx, ly] = lightIn(turn);
  g.fillStyle = 'rgba(255, 252, 240, 0.8)';
  g.beginPath();
  g.arc(x - lx * reach, y - ly * reach, r, 0, TAU);
  g.fill();
}

/** Seeded so a sprite is the same every time it is baked. */
export function seeded(seed: number) {
  let s = seed | 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

/** Soot and claw gouges: darker than whatever they sit on, chunky, never hairline. */
function scorch(g: CanvasRenderingContext2D, rnd: () => number, n: number, spread: number, size: number) {
  g.fillStyle = SCORCH;
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU, d = spread * (0.3 + 0.7 * rnd()), r = size * (0.6 + 0.6 * rnd());
    g.beginPath();
    g.ellipse(Math.cos(a) * d, Math.sin(a) * d, r, r * 0.7, a, 0, TAU);
    g.fill();
  }
}

/** Soot streaks blown out from the middle: long chunky smears, each pointing away from the centre, never hairline. */
export function streaks(g: CanvasRenderingContext2D, rnd: () => number, n: number, from: number, to: number, wide: number, color = SCORCH) {
  g.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU, d0 = from * (0.6 + 0.4 * rnd()), d1 = to * (0.7 + 0.3 * rnd()), w = wide * (0.7 + 0.6 * rnd());
    const mx = Math.cos(a) * (d0 + d1) / 2, my = Math.sin(a) * (d0 + d1) / 2;
    g.beginPath();
    g.ellipse(mx, my, (d1 - d0) / 2 + w, w, a, 0, TAU);
    g.fill();
  }
}

/** A dent: a dark pit with a lit lip on the side away from the key light, as a hammered toy would show it. */
export function dent(g: CanvasRenderingContext2D, x: number, y: number, r: number, light: readonly [number, number] = [LIGHT.x, LIGHT.y]) {
  const [lx, ly] = light;
  g.fillStyle = 'rgba(16, 18, 24, 0.5)';
  g.beginPath();
  g.ellipse(x, y, r, r * 0.8, 0, 0, TAU);
  g.fill();
  g.fillStyle = 'rgba(255, 250, 235, 0.32)';
  g.beginPath();
  g.ellipse(x + lx * r * 0.45, y + ly * r * 0.45, r * 0.6, r * 0.45, 0, 0, TAU);
  g.fill();
  g.fillStyle = 'rgba(16, 18, 24, 0.55)';
  g.beginPath();
  g.ellipse(x - lx * r * 0.2, y - ly * r * 0.2, r * 0.55, r * 0.42, 0, 0, TAU);
  g.fill();
}

/** Bullet and claw pocks: small punched ink holes. */
function pocks(g: CanvasRenderingContext2D, rnd: () => number, n: number, spread: number) {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) { const a = rnd() * TAU, d = spread * Math.sqrt(rnd()); pts.push([Math.cos(a) * d, Math.sin(a) * d]); }
  dots(g, pts, 0.95);
}

/** Charring: whatever is already painted is blackened, patchily, without touching the transparent ground round it. */
export function char(g: CanvasRenderingContext2D, rnd: () => number, wash: number, patches: number, spread: number) {
  g.save();
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = `rgba(22, 19, 17, ${wash})`;
  g.fillRect(-200, -200, 400, 400);
  g.fillStyle = 'rgba(14, 12, 11, 0.55)';
  for (let i = 0; i < patches; i++) {
    const a = rnd() * TAU, d = spread * Math.sqrt(rnd()), r = spread * (0.25 + 0.25 * rnd());
    g.beginPath();
    g.ellipse(Math.cos(a) * d, Math.sin(a) * d, r, r * 0.75, a, 0, TAU);
    g.fill();
  }
  g.restore();
}

// ---- the base ----

const RING = 19;

/** How a sandbag sits: sound, slumped (sagged outward and flattened), or burst (split open, its sand spilled on the floor). */
type BagState = 'sound' | 'slumped' | 'burst';
const SAND = '#c9b48a';

/** One sandbag of the ring at `a`, its long side along the ring. */
function bag(g: CanvasRenderingContext2D, a: number, r: number, tone: string, state: BagState = 'sound') {
  const turn = a + Math.PI / 2;
  const out = state === 'slumped' ? 3.6 : state === 'burst' ? 3.2 : 0;
  const x = Math.cos(a) * (r + out), y = Math.sin(a) * (r + out);
  if (state === 'burst') {
    // The sand runs out onto the floor beyond it: a low khaki fan, a step darker at its edge.
    g.fillStyle = shadeHex(SAND, 0.78);
    g.beginPath();
    g.ellipse(Math.cos(a) * (r + 9), Math.sin(a) * (r + 9), 7.4, 4.6, turn, 0, TAU);
    g.fill();
    g.fillStyle = SAND;
    g.beginPath();
    g.ellipse(Math.cos(a) * (r + 8), Math.sin(a) * (r + 8) - 0.6, 5.6, 3.2, turn, 0, TAU);
    g.fill();
  }
  const sag = state === 'sound' ? 0 : state === 'slumped' ? 0.32 : -0.4;
  const tall = state === 'sound' ? 4 : state === 'slumped' ? 2.4 : 1.4;
  const half = state === 'burst' ? 2.6 : 3.7;
  partAt(g, 0, x, y, turn + sag, roundBox(-6.4, -half, 6.4, half, Math.min(3.2, half)), tone, 5, 0.9, tall, 0);
  // The tied ends, pinched in: two short ink ticks on its top face; a burst bag shows its split instead.
  const [ux, uy] = upIn(0, tall);
  g.save();
  g.translate(x + ux, y + uy);
  g.rotate(turn + sag);
  if (state === 'burst') {
    g.fillStyle = INK;
    g.beginPath();
    g.moveTo(-3.6, -1.4); g.lineTo(-1, 0.4); g.lineTo(1.2, -0.8); g.lineTo(3.8, 1.2); g.lineTo(1, 1.8); g.lineTo(-1.2, 1.2); g.closePath();
    g.fill();
  } else {
    g.strokeStyle = shadeHex(tone, 0.62);
    g.lineWidth = 1.2;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(-4.4, -2); g.lineTo(-4.4, 2); g.moveTo(4.4, -2); g.lineTo(4.4, 2);
    if (state === 'slumped') { g.moveTo(-1.6, -1.2); g.lineTo(1.4, 1.4); }
    g.stroke();
  }
  g.restore();
}

/** A riveted steel plate standing on the ring at `a`; a loose one hangs askew off its bolts, a fallen one lies flat beyond the ring. */
function plate(g: CanvasRenderingContext2D, a: number, r: number, w: number, tone: string, holed: boolean, hang: 'fast' | 'loose' | 'fallen' = 'fast') {
  const turn = a + Math.PI / 2 + (hang === 'loose' ? 0.42 : hang === 'fallen' ? 0.9 : 0);
  const out = hang === 'loose' ? 1.6 : hang === 'fallen' ? 8 : 0;
  const tall = hang === 'fallen' ? 1.2 : hang === 'loose' ? 4.5 : 6;
  const x = Math.cos(a) * (r + out), y = Math.sin(a) * (r + out);
  partAt(g, 0, x, y, turn, roundBox(-w / 2, -2.4, w / 2, 2.4, 1.2), tone, 4, 0.9, tall, 0);
  const [ux, uy] = upIn(0, tall);
  g.save();
  g.translate(x + ux, y + uy);
  g.rotate(turn);
  dots(g, hang === 'fast' ? [[-w / 2 + 1.8, 0], [w / 2 - 1.8, 0]] : [[w / 2 - 1.8, 0]], 0.9);
  if (holed) {
    g.fillStyle = INK;
    g.beginPath();
    g.moveTo(-1, -2.4); g.lineTo(1.6, -2.4); g.lineTo(0.4, 0.6); g.closePath();
    g.moveTo(-w / 2 + 2.6, 2.4); g.lineTo(-w / 2 + 4.6, 2.4); g.lineTo(-w / 2 + 3.4, 0.2); g.closePath();
    g.fill();
  }
  g.restore();
}

/** The kind's supply on the pad's lower-right corner: the box its rounds come from. */
function supply(g: CanvasRenderingContext2D, kind: TurretKind) {
  const x = 17, y = 17;
  switch (kind) {
    case 'sentry':
      partAt(g, 0, x, y, 0, roundBox(-4.5, -3.2, 4.5, 3.2, 1), OLIVE, 3, 0.8, 4, 0);
      g.fillStyle = BRASS;
      g.fillRect(x - 3, y - 4.6 - 1.2, 6, 1.6);
      break;
    case 'cannon':
      for (const dy of [-3, 0.5, 4]) {
        partAt(g, 0, x, y + dy, 0, roundBox(-5, -1.5, 3, 1.5, 1.4), BRASS, 2, 0.75, 2, 0);
        partAt(g, 0, x + 4, y + dy, 0, roundBox(-1.2, -1.5, 1.6, 1.5, 1.4), GUNMETAL_DARK, 1.5, 0.75, 2, 0);
      }
      break;
    case 'scatter':
      partAt(g, 0, x, y, 0, roundBox(-4.5, -3.5, 4.5, 3.5, 1), OLIVE, 3, 0.8, 3, 0);
      dots(g, [[x - 2.2, y - 4], [x, y - 4], [x + 2.2, y - 4]], 1.1, RUST);
      break;
    case 'mortar':
      partAt(g, 0, x, y, 0, roundBox(-5, -3.6, 5, 3.6, 1), OLIVE, 3, 0.8, 3, 0);
      for (const dx of [-2.4, 2.4]) partAt(g, 0, x + dx, y - 3, 0, ellipse(0, 0, 1.8, 1.8), KHAKI_DARK, 1.5, 0.7, 2, 0);
      break;
    case 'tesla':
      break;
  }
}

/** The status lamp's housing on the pad's lower-left corner; its light is drawn live over the night. */
export const LAMP_AT = { x: -18, y: 17 } as const;
/** The ammo gauge's plate, hung on the emplacement's front; its cells are lit live over the night. */
export const GAUGE = { y: 23, half: 12, rise: 2 } as const;
/** The gauge plate; on a worn emplacement it hangs a little crooked off one loose bolt. */
function gaugePlate(g: CanvasRenderingContext2D, wear: Wear = 0) {
  partAt(g, 0, 0, GAUGE.y, wear ? 0.07 : 0, roundBox(-GAUGE.half - 1.5, -3, GAUGE.half + 1.5, 3, 1.2), GUNMETAL_DARK, 3, 0.9, GAUGE.rise, 0);
}
function lampHousing(g: CanvasRenderingContext2D) {
  partAt(g, 0, LAMP_AT.x, LAMP_AT.y + 3, 0, roundBox(-3, -3, 3, 3, 1.2), GUNMETAL_DARK, 2, 0.8, 3, 0);
  dots(g, [[LAMP_AT.x, LAMP_AT.y]], 1.7, INK);
}

function paintRingBase(g: CanvasRenderingContext2D, kind: TurretKind, lv: number, wear: Wear) {
  const rnd = seeded(lv * 31 + wear * 7 + kind.length);
  // Soot first, on the floor under the ring: streaks blown out from a hit, more and blacker the worse it is.
  if (wear > 0) streaks(g, rnd, wear === 2 ? 9 : 5, RING * 0.6, RING + (wear === 2 ? 15 : 10), wear === 2 ? 3.4 : 2.4, wear === 2 ? 'rgba(18, 15, 13, 0.62)' : SCORCH);
  // Sandbags round the turntable, back to front so nearer bags overlap farther ones; steel plates take over at the top level.
  // Worn, three of them sag outward; badly damaged, two are gone and three more have burst and spilled.
  const n = 10;
  const items: { a: number; draw: () => void }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + Math.PI / n;
    const gone = wear === 2 && (i === 2 || i === 7);
    if (lv >= 3) {
      const hang = wear === 2 && i === 4 ? 'fallen' : wear >= 1 && i === 8 ? 'loose' : 'fast';
      items.push({ a, draw: () => plate(g, a, RING + 0.5, 12.4, i % 5 === 1 ? tint(STEEL, 0.1) : STEEL, wear === 2 && i % 3 === 0, hang) });
    } else if (!gone) {
      const state: BagState = wear === 2 && (i === 1 || i === 4 || i === 8) ? 'burst' : wear >= 1 && (i === 1 || i === 4 || i === 8 || (wear === 2 && i === 5)) ? 'slumped' : 'sound';
      const tone = state !== 'sound' ? shadeHex(KHAKI, 0.82) : i % 3 === 0 ? KHAKI_DARK : KHAKI;
      items.push({ a, draw: () => bag(g, a, RING, tone, state) });
    }
  }
  // Bolted plates over the bags at the second level, on the four diagonals: worn, one hangs loose; badly damaged, one has fallen.
  if (lv === 2) {
    [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4].forEach((a, i) => {
      const hang = wear === 2 && i === 0 ? 'fallen' : wear >= 1 && i === 2 ? 'loose' : 'fast';
      items.push({ a: a + 0.01, draw: () => plate(g, a, RING + 2.6, 9, GUNMETAL_DARK, wear === 2, hang) });
    });
  }
  items.sort((p, q) => Math.sin(p.a) - Math.sin(q.a));
  for (const it of items) it.draw();
  if (lv >= 3) {
    // Hazard chevrons painted across the collar's front, and a pair of bags shoring up each front corner.
    const [ux, uy] = upIn(0, 6);
    g.save();
    g.translate(ux, uy);
    g.beginPath();
    g.arc(0, 0, RING + 2.4, Math.PI * 0.32, Math.PI * 0.68);
    g.arc(0, 0, RING - 2.4, Math.PI * 0.68, Math.PI * 0.32, true);
    g.closePath();
    g.clip();
    g.fillStyle = BRASS;
    g.fillRect(-12, RING - 4, 24, 8);
    g.fillStyle = INK;
    for (let x = -12; x < 12; x += 5) { g.beginPath(); g.moveTo(x, RING - 4); g.lineTo(x + 2.5, RING - 4); g.lineTo(x + 5, RING + 4); g.lineTo(x + 2.5, RING + 4); g.closePath(); g.fill(); }
    g.restore();
  }
  // The turntable, bolted down.
  partAt(g, 0, 0, 0, 0, ellipse(0, 0, 12.5, 12.5), GUNMETAL_DARK, 7, 1, MOUNT_RISE, 0);
  const bolts: [number, number][] = [];
  for (let i = 0; i < 8; i++) if (!(wear === 2 && (i === 1 || i === 5))) bolts.push([Math.cos((i / 8) * TAU) * 9.6, Math.sin((i / 8) * TAU) * 9.6 - MOUNT_RISE]);
  dots(g, bolts, 0.95);
  supply(g, kind);
  lampHousing(g);
  gaugePlate(g, wear);
  if (wear > 0) {
    scorch(g, rnd, wear === 2 ? 7 : 3, RING, wear === 2 ? 5 : 3.5);
    dent(g, -RING * 0.55, -RING * 0.62, 2.6);
    dent(g, RING * 0.7, -RING * 0.15, 2.2);
    pocks(g, rnd, wear === 2 ? 10 : 5, RING + 2);
  }
  if (wear === 1) char(g, rnd, 0.1, 3, RING);
  if (wear === 2) {
    char(g, rnd, 0.42, 6, RING + 4);
    // A jagged chunk blown out of the turntable's rim.
    g.fillStyle = INK;
    g.beginPath();
    g.moveTo(8, -9 - MOUNT_RISE); g.lineTo(12.6, -4 - MOUNT_RISE); g.lineTo(9, -3.4 - MOUNT_RISE); g.lineTo(9.8, -6.4 - MOUNT_RISE); g.closePath();
    g.fill();
  }
}

/** The coil's tower: a plinth, insulators, the copper winding and its orb, more of it at each level. */
export const COIL_TOP = (lv: number) => 26 + 3 * lv;
function paintCoilBase(g: CanvasRenderingContext2D, lv: number, wear: Wear) {
  const rnd = seeded(lv * 13 + wear);
  if (wear > 0) streaks(g, rnd, wear === 2 ? 9 : 5, 10, wear === 2 ? 32 : 26, wear === 2 ? 3.4 : 2.4, wear === 2 ? 'rgba(18, 15, 13, 0.62)' : SCORCH);
  partAt(g, 0, 0, 0, 0, polygon([-14, -6], [-6, -14], [6, -14], [14, -6], [14, 6], [6, 14], [-6, 14], [-14, 6]), GUNMETAL, 9, 1, 5, 0);
  dots(g, [[-9, -5 - 5], [9, -5 - 5], [-9, 5 - 5], [9, 5 - 5]], 1);
  // Capacitor pylons round it from the second level: two, then four, each a gunmetal can with a bone insulator cap, cabled in.
  const pylons: [number, number][] = lv >= 3 ? [[-17, -12], [17, -12], [-17, 12], [17, 12]] : lv === 2 ? [[-17, 9], [17, 9]] : [];
  const cable = (x: number, y: number) => {
    g.strokeStyle = INK;
    g.lineWidth = 1.6;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x, y - 9);
    g.quadraticCurveTo(x * 0.4, y * 0.4 - 4, 0, -12);
    g.stroke();
  };
  for (const [x, y] of pylons.filter(([, y]) => y < 0)) { partAt(g, 0, x, y, 0, ellipse(0, 0, 3.6, 3.6), GUNMETAL_DARK, 3, 0.9, 8, 0); partAt(g, 0, x, y - 8, 0, ellipse(0, 0, 2.6, 2.6), BONE, 2, 0.8, 2.5, 0); }
  // Three ceramic insulator discs, then the winding: a tall copper drum banded by its turns.
  for (let i = 0; i < 3; i++) partAt(g, 0, 0, -5 - i * 2.4, 0, ellipse(0, 0, 6.5 - i * 0.6, 6.5 - i * 0.6), BONE, 4, 0.9, 2, 0);
  const base = -12, tall = 11 + 2 * lv;
  partAt(g, 0, 0, base, 0, ellipse(0, 0, 7, 7), RUST, 5, 1, tall, 0);
  // The turns across its front face: chunky dark bands following the drum's curve.
  g.strokeStyle = shadeHex(RUST, 0.6);
  g.lineWidth = 1.3;
  g.beginPath();
  for (let y = base - tall + 2.6; y < base - 0.5; y += 2.8) { g.moveTo(7 * Math.cos(0.2), y + 7 * Math.sin(0.2)); g.arc(0, y, 7, 0.2, Math.PI - 0.2); }
  g.stroke();
  const top = base - tall;
  // The top: an orb on a collar, and from the top level a steel toroid ring round it.
  if (lv >= 3) {
    partAt(g, 0, 0, top - 1, 0, (gg) => { gg.moveTo(12, 0); gg.ellipse(0, 0, 12, 8, 0, 0, TAU); gg.moveTo(6, 0); gg.ellipse(0, 0, 6, 3.8, 0, 0, TAU, true); }, STEEL, 6, 1, 3, 0);
  }
  partAt(g, 0, 0, top, 0, ellipse(0, 0, 4, 4), GUNMETAL_DARK, 3, 0.9, 2, 0);
  partAt(g, 0, 0, top - 2 - lv, 0, ellipse(0, 0, 4.6 + lv, 4.6 + lv), STEEL, 4, 1, 1, 0);
  spec(g, 0, 0, top - 3 - lv, 2 + lv * 0.6, 1.2);
  for (const [x, y] of pylons.filter(([, y]) => y >= 0)) { partAt(g, 0, x, y, 0, ellipse(0, 0, 3.6, 3.6), GUNMETAL_DARK, 3, 0.9, 8, 0); partAt(g, 0, x, y - 8, 0, ellipse(0, 0, 2.6, 2.6), BONE, 2, 0.8, 2.5, 0); }
  for (const [x, y] of pylons) cable(x, y);
  lampHousing(g);
  gaugePlate(g, wear);
  if (wear > 0) {
    scorch(g, rnd, wear === 2 ? 6 : 3, 12, 3.5);
    dent(g, -8, -4, 2.4);
    dent(g, 4, base - tall * 0.5, 2);
    pocks(g, rnd, wear === 2 ? 9 : 4, 14);
  }
  if (wear === 1) char(g, rnd, 0.1, 3, 14);
  if (wear === 2) {
    char(g, rnd, 0.42, 5, 16);
    // A cracked insulator disc and a slipped turn of the winding.
    g.fillStyle = INK;
    g.beginPath();
    g.moveTo(-6, -7); g.lineTo(-2.6, -9.4); g.lineTo(-3.4, -6.2); g.closePath();
    g.fill();
  }
}

function baseSprite(kind: TurretKind, lv: number, wear: Wear, pxPerUnit: number) {
  return bakedSprite(`b|${kind}|${lv}|${wear}`, BASE_HALF, pxPerUnit, (g) => {
    // The contact shadow, tight and crisp, down and to the right.
    g.fillStyle = PALETTE.contact;
    g.beginPath();
    g.ellipse(LIGHT.x * 3, LIGHT.y * 3 + 1, RING + 4, RING + 3, 0, 0, TAU);
    g.fill();
    if (kind === 'tesla') paintCoilBase(g, lv, wear);
    else paintRingBase(g, kind, lv, wear);
  });
}

// ---- the heads ----

/** Draws a head's barrels knocked `bend` crooked about the mount: the frame is turned, and the light with it, so the cel steps stay true. */
function crooked(g: CanvasRenderingContext2D, turn: number, bend: number, draw: (turn: number) => void) {
  if (!bend) { draw(turn); return; }
  g.save();
  g.rotate(bend);
  draw(turn + bend);
  g.restore();
}

/** Where a head's barrels end at rest, in its own frame (+x along the aim): one entry per barrel, `y` across it; a crooked gun's are turned by `bend`. */
export function muzzlesOf(kind: TurretKind, lv: number, bend = 0): { x: number; y: number; a: number }[] {
  if (bend) { const c = Math.cos(bend), s = Math.sin(bend); return muzzlesOf(kind, lv).map((m) => ({ x: m.x * c - m.y * s, y: m.x * s + m.y * c, a: m.a + bend })); }
  switch (kind) {
    case 'sentry': return sentryRows(lv).map((y) => ({ x: 28, y, a: 0 }));
    case 'cannon': return [{ x: 34, y: 0, a: 0 }];
    case 'scatter': return scatterFan(lv).map((a) => ({ x: Math.cos(a) * 23.5, y: Math.sin(a) * 23.5, a }));
    case 'mortar': return mortarTubes(lv).map(([y]) => ({ x: 15, y, a: 0 }));
    case 'tesla': return [];
  }
}
const sentryRows = (lv: number) => (lv <= 1 ? [-3.2, 3.2] : lv === 2 ? [-4.6, 0, 4.6] : [-6, -2, 2, 6]);
const scatterFan = (lv: number) => { const n = lv <= 1 ? 3 : lv === 2 ? 5 : 7; return Array.from({ length: n }, (_, i) => (i / (n - 1) - 0.5) * 0.44); };
const mortarTubes = (lv: number): [number, number][] => (lv <= 1 ? [[0, 10]] : lv === 2 ? [[-5.4, 8.4], [5.4, 8.4]] : [[-8.2, 7.2], [0, 7.2], [8.2, 7.2]]);

function accent(g: CanvasRenderingContext2D, turn: number, kind: TurretKind, x: number, h: number, rise: number) {
  const [ux, uy] = upIn(turn, rise);
  g.save();
  g.translate(ux, uy);
  g.fillStyle = TURRET_LOOK[kind].accent;
  g.strokeStyle = INK;
  g.lineWidth = 1;
  g.beginPath();
  roundBox(x, -h, x + 2.6, h, 1)(g);
  g.fill();
  g.stroke();
  g.restore();
}

/** Rivets on a top face standing `rise` high, in the head's frame. */
function rivets(g: CanvasRenderingContext2D, turn: number, rise: number, pts: readonly (readonly [number, number])[]) {
  const [ux, uy] = upIn(turn, rise);
  dots(g, pts.map(([x, y]) => [x + ux, y + uy] as const), 0.85);
}

/** A sighting optic: a dark tube with a glass lens at its front, `rise` high. */
function optic(g: CanvasRenderingContext2D, turn: number, x0: number, x1: number, y: number, rise: number) {
  partAt(g, turn, 0, 0, 0, roundBox(x0, y - 1.7, x1, y + 1.7, 1.5), BARREL, 2, 0.8, 1.6, rise);
  const [ux, uy] = upIn(turn, rise + 1.6);
  dots(g, [[x1 - 0.6 + ux, y + uy]], 1.5, '#26304a');
  dots(g, [[x1 - 1 + ux, y - 0.5 + uy]], 0.6, BONE);
}

function paintSentry(g: CanvasRenderingContext2D, turn: number, lv: number, bend = 0) {
  const body = TURRET_LOOK.sentry.body, rows = sentryRows(lv), span = Math.max(...rows) + 2.4;
  // The belt feeding in from the left at the first level; side shields cover it from the second.
  if (lv === 1) {
    partAt(g, turn, 0, 0, 0, roundBox(-8, -12, 1, -8.6, 1), BRASS, 2, 0.75, 1.5, 1);
    const [ux, uy] = upIn(turn, 2.5);
    g.strokeStyle = shadeHex(BRASS, 0.55);
    g.lineWidth = 1;
    g.beginPath();
    for (let x = -6; x < 1; x += 2.3) { g.moveTo(x + ux, -12 + uy); g.lineTo(x + ux, -8.6 + uy); }
    g.stroke();
  }
  if (lv >= 2) for (const s of [-1, 1]) partAt(g, turn, 0, 0, 0, polygon([-7, 8.6 * s], [5, 8.6 * s], [8, 12.6 * s], [-4, 12.6 * s]), GUNMETAL_DARK, 3, 0.9, 3, 1);
  if (lv >= 3) partAt(g, turn, 0, 0, 0, roundBox(4.5, -13, 9, 13, 2), GUNMETAL_DARK, 3, 1, 5, 0);
  // The receiver: a rounded box with a lid, hatch line and the kind's stripe.
  partAt(g, turn, 0, 0, 0, roundBox(-11, -8.4, 7.5, 8.4, 4), body, 8, 1, 4, 0);
  // Barrels: thin dark tubes with cooling jackets (one perforated shroud over them from the second level) and muzzle caps.
  const r = lv >= 3 ? 5.5 : 4;
  crooked(g, turn, bend, (turn) => {
  if (lv === 1) for (const y of rows) partAt(g, turn, 0, 0, 0, roundBox(5, y - 2.4, 15, y + 2.4, 2), tint(GUNMETAL, 0.1), 2, 0.85, 1.5, r - 0.5);
  for (const y of rows) partAt(g, turn, 0, 0, 0, roundBox(5, y - 1.5, 26.5, y + 1.5, 1.4), BARREL, 1.5, 0.85, 1.2, r);
  for (const y of rows) partAt(g, turn, 0, 0, 0, roundBox(25, y - 2.1, 28.4, y + 2.1, 1), BARREL, 1.5, 0.8, 1.2, r + 0.2);
  if (lv >= 2) {
    partAt(g, turn, 0, 0, 0, roundBox(5.5, -span, 13, span, 2.2), tint(GUNMETAL, 0.1), 4, 0.9, 1.6, r + 0.6);
    const [ux, uy] = upIn(turn, r + 2.2);
    const holes: [number, number][] = [];
    for (const x of [8, 10.6]) for (const y of rows) holes.push([x + ux, y + uy]);
    dots(g, holes, 0.75);
  } else {
    const [ux, uy] = upIn(turn, r + 1);
    dots(g, rows.flatMap((y) => [[8 + ux, y + uy], [11.5 + ux, y + uy]] as [number, number][]), 0.7);
  }
  });
  accent(g, turn, 'sentry', -9.4, 4, 4);
  rivets(g, turn, 4, [[-8.6, -6], [-8.6, 6], [4.6, -6], [4.6, 6]]);
  if (lv >= 3) optic(g, turn, -5, 4, -5.2, 4);
  spec(g, turn, -2 + upIn(turn, 4)[0], upIn(turn, 4)[1], 5);
}

function paintCannon(g: CanvasRenderingContext2D, turn: number, lv: number, bend = 0) {
  const body = TURRET_LOOK.cannon.body, w = 3.5 + 0.5 * (lv - 1);
  if (lv >= 2) for (const s of [-1, 1]) partAt(g, turn, 0, 0, 0, roundBox(-10, s < 0 ? -13.4 : 10, 7, s < 0 ? -10 : 13.4, 1.5), shadeHex(OLIVE, 0.82), 3, 0.9, 3.5, 0.5);
  // The breech housing, heavy and rounded, with a sloped glacis bolted on at the top level.
  partAt(g, turn, 0, 0, 0, roundBox(-12.5, -10.5, 8.5, 10.5, 4.5), body, 10, 1, 5, 0);
  if (lv >= 3) {
    partAt(g, turn, 0, 0, 0, polygon([6, -10], [11.5, -6.5], [11.5, 6.5], [6, 10]), tint(OLIVE, 0.12), 5, 0.9, 2, 4);
    partAt(g, turn, 0, 0, 0, roundBox(-10, -7.5, 1.5, 7.5, 2), tint(GUNMETAL, 0.1), 6, 0.9, 1.5, 5);
    rivets(g, turn, 6.5, [[-8.4, -5.8], [-8.4, 5.8], [-0.2, -5.8], [-0.2, 5.8]]);
  }
  crooked(g, turn, bend, (turn) => {
  // Recoil cylinders alongside the barrel at the top level.
  if (lv >= 3) for (const s of [-1, 1]) partAt(g, turn, 0, 0, 0, roundBox(6, s * 6.6 - 1.5, 19, s * 6.6 + 1.5, 1.4), GUNMETAL_DARK, 1.5, 0.8, 1.6, 4.5);
  // The barrel, a band round it, a bore evacuator from the second level, and the muzzle brake with its side vents.
  partAt(g, turn, 0, 0, 0, roundBox(6, -w, 28, w, w * 0.8), GUNMETAL_DARK, w * 1.4, 1, 2, 4);
  partAt(g, turn, 0, 0, 0, roundBox(11, -w - 0.8, 14, w + 0.8, 1), GUNMETAL, 2, 0.8, 2, 4.2);
  if (lv >= 2) partAt(g, turn, 0, 0, 0, ellipse(20, 0, 3.6, w + 1.4), GUNMETAL, 3, 0.9, 2, 4.2);
  partAt(g, turn, 0, 0, 0, roundBox(27, -w - 1.6, 34, w + 1.6, 1.6), BARREL, 3, 1, 2.2, 4);
  {
    const [ux, uy] = upIn(turn, 6.2);
    g.fillStyle = INK;
    for (const x of [28.6, 31.4]) g.fillRect(x + ux, -w - 0.4 + uy, 1.4, 2 * w + 0.8);
  }
  });
  accent(g, turn, 'cannon', -11, 5, 5);
  rivets(g, turn, 5, [[-10, -8.4], [-10, 8.4], [6, -8.4], [6, 8.4]]);
  if (lv >= 3) optic(g, turn, -8, -1, -8.2, 6.5);
  else spec(g, turn, -3 + upIn(turn, 5)[0], upIn(turn, 5)[1], 6);
}

function paintScatter(g: CanvasRenderingContext2D, turn: number, lv: number, bend = 0) {
  const body = TURRET_LOOK.scatter.body, fan = scatterFan(lv), bw = lv >= 3 ? 1.5 : 1.8;
  if (lv >= 3) partAt(g, turn, 0, 0, 0, ellipse(-4, -10.5, 5, 5), OLIVE, 4, 1, 4, 0);
  if (lv >= 2) for (const s of [-1, 1]) partAt(g, turn, 0, 0, 0, roundBox(-7, s < 0 ? -11.6 : 8.4, 3, s < 0 ? -8.4 : 11.6, 1.2), GUNMETAL_DARK, 2, 0.85, 3, 1);
  partAt(g, turn, 0, 0, 0, ellipse(0, 0, 10, 9.5), body, 9, 1, 4, 0);
  // A fan of short fat barrels splayed to the spread the pellets fly at, more of them each level, strapped by a clamp.
  crooked(g, turn, bend, (turn) => {
  for (const a of fan) partAt(g, turn, 0, 0, a, roundBox(5, -bw, 21.5, bw, bw * 0.8), BARREL, 1.5, 0.8, 1.4, 4.5);
  for (const a of fan) partAt(g, turn, 0, 0, a, roundBox(20, -bw - 0.7, 23.6, bw + 0.7, 1), BARREL, 1.5, 0.8, 1.4, 4.7);
  const half = Math.sin(Math.max(...fan)) * 12 + bw + 1.6;
  partAt(g, turn, 0, 0, 0, roundBox(10, -half, 13.4, half, 1.5), tint(GUNMETAL, 0.15), 2, 0.9, 1.4, 5.6);
  });
  if (lv >= 3) {
    const [ux, uy] = upIn(turn, 4);
    dots(g, [[-4 + ux, -10.5 + uy]], 1.6);
    partAt(g, turn, 0, 0, 0, roundBox(-6, -4, 2, 4, 2), tint(GUNMETAL, 0.12), 4, 0.9, 1.4, 4);
    rivets(g, turn, 5.4, [[-4, -2.4], [-4, 2.4], [0, -2.4], [0, 2.4]]);
  }
  accent(g, turn, 'scatter', -8.6, 3.4, 4);
  spec(g, turn, -1 + upIn(turn, 4)[0], upIn(turn, 4)[1], 5);
}

function paintMortar(g: CanvasRenderingContext2D, turn: number, lv: number, bend = 0) {
  const tubes = mortarTubes(lv);
  // The traverse cradle with its elevation wheel, then for each tube a bipod and the tube raised toward the aim.
  partAt(g, turn, 0, 0, 0, roundBox(-9, -7, 1, 7, 2), GUNMETAL, 5, 1, 3, 0);
  {
    const [ux, uy] = upIn(turn, 3);
    g.strokeStyle = INK;
    g.lineWidth = 1.6;
    g.beginPath();
    g.arc(-4 + ux, -9 + uy, 2.6, 0, TAU);
    g.moveTo(-6.6 + ux, -9 + uy); g.lineTo(-1.4 + ux, -9 + uy);
    g.stroke();
  }
  if (lv >= 3) partAt(g, turn, 0, 0, 0, roundBox(-12, -4, -7, 4, 1.2), OLIVE, 3, 0.9, 4, 0);
  for (const [y, w] of tubes) {
    // Bipod legs from mid-tube out to its feet.
    const [ux, uy] = upIn(turn, 2);
    g.lineCap = 'round';
    for (const [col, lw] of [[INK, 3.6], [GUNMETAL_DARK, 1.6]] as const) {
      g.strokeStyle = col;
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(7 + ux, y + uy); g.lineTo(3.5, y - w * 0.75);
      g.moveTo(7 + ux, y + uy); g.lineTo(3.5, y + w * 0.75);
      g.stroke();
    }
  }
  crooked(g, turn, bend, (turn) => {
  for (const [y, w] of tubes) {
    const body = TURRET_LOOK.mortar.body;
    partAt(g, turn, 0, y, 0, roundBox(-6, -w / 2, 13.5, w / 2, w / 2), body, w * 0.8, 1, 3, 3);
    partAt(g, turn, 0, y, 0, roundBox(3, -w / 2 - 0.6, 5.4, w / 2 + 0.6, 1), shadeHex(body, 0.78), 1.5, 0.8, 3, 3.1);
    // The mouth, tilted up toward the viewer: a gunmetal rim round a dark bore.
    partAt(g, turn, 15, y, 0, ellipse(0, 0, w * 0.36, w / 2 + 0.7), GUNMETAL, w * 0.5, 1, 2, 4.5);
    const [ux, uy] = upIn(turn, 6.5);
    g.fillStyle = INK;
    g.beginPath();
    g.ellipse(15.3 + ux, y + uy, w * 0.22, w / 2 - 1, 0, 0, TAU);
    g.fill();
    spec(g, turn, 4 + upIn(turn, 6)[0], y + upIn(turn, 6)[1], w * 0.3, 0.9);
  }
  });
  accent(g, turn, 'mortar', -8, 3.4, 3);
}

function headSprite(kind: TurretKind, lv: number, wear: Wear, index: number, pxPerUnit: number) {
  return bakedSprite(`h|${kind}|${lv}|${wear}|${index}`, HEAD_HALF, pxPerUnit, (out) => {
    // The head is painted apart, then stamped once with a crisp shadow cast down and to the right onto its emplacement.
    const px = out.getTransform().a;
    const flat = document.createElement('canvas');
    flat.width = flat.height = out.canvas.width;
    const g = flat.getContext('2d')!;
    g.setTransform(px, 0, 0, px, HEAD_HALF * px, HEAD_HALF * px);
    paintHead(g, kind, lv, wear, index);
    out.save();
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.shadowColor = PALETTE.contact;
    out.shadowOffsetX = LIGHT.x * 3 * px;
    out.shadowOffsetY = LIGHT.y * 3 * px;
    out.drawImage(flat, 0, 0);
    out.restore();
  });
}

function paintHead(g: CanvasRenderingContext2D, kind: TurretKind, lv: number, wear: Wear, index: number) {
  const turn = (index / HEAD_BUCKETS) * TAU;
  g.rotate(turn);
  g.scale(HEAD_SCALE, HEAD_SCALE);
  const bend = wear === 2 ? BEND : 0;
  if (kind === 'sentry') paintSentry(g, turn, lv, bend);
  else if (kind === 'cannon') paintCannon(g, turn, lv, bend);
  else if (kind === 'scatter') paintScatter(g, turn, lv, bend);
  else if (kind === 'mortar') paintMortar(g, turn, lv, bend);
  if (!wear) return;
  // Battered: dents hammered into the housing, soot streaked back off the muzzle, pocks where rounds and claws struck.
  // Badly damaged: all of it charred black, and chunks knocked out of its edges.
  const rnd = seeded(index + lv * 7 + wear * 3);
  const [ux, uy] = upIn(turn, 4);
  const light = lightIn(turn);
  g.save();
  g.translate(ux, uy);
  streaks(g, rnd, wear === 2 ? 5 : 3, 2, 12, 1.8, wear === 2 ? 'rgba(18, 15, 13, 0.6)' : SCORCH);
  dent(g, -5, -3.6, 2.2, light);
  dent(g, 2.4, 4.2, 1.8, light);
  if (wear === 2) dent(g, -7.6, 3, 2, light);
  pocks(g, rnd, wear === 2 ? 6 : 3, 7);
  g.restore();
  if (wear === 1) char(g, rnd, 0.08, 2, 10);
  if (wear === 2) {
    char(g, rnd, 0.4, 4, 12);
    g.save();
    g.translate(ux, uy);
    g.fillStyle = INK;
    g.beginPath();
    g.moveTo(-6, -8.6); g.lineTo(-2, -8.6); g.lineTo(-4.2, -5.4); g.closePath();
    g.moveTo(-10, 4); g.lineTo(-10, 7.4); g.lineTo(-7.2, 5.4); g.closePath();
    g.moveTo(3, 8.4); g.lineTo(6.6, 8.4); g.lineTo(5, 5.6); g.closePath();
    g.fill();
    g.restore();
  }
}

// ---- drawing ----

/** How long a shot kicks the gun back and how far, by kind: snap back, then ease home. */
const KICK: Record<TurretKind, { ms: number; px: number }> = {
  sentry: { ms: 70, px: 1.8 }, cannon: { ms: 260, px: 6 }, scatter: { ms: 150, px: 3.5 }, mortar: { ms: 180, px: 2.6 }, tesla: { ms: 1, px: 0 },
};
/** How far back a gun sits `ms` after a shot: the full kick at once, eased home (cubic). */
export function kickOf(kind: TurretKind, ms: number): number {
  const k = KICK[kind];
  if (ms < 0 || ms >= k.ms) return 0;
  const t = 1 - ms / k.ms;
  return k.px * t * t * t;
}

export type TurretDraw = { kind: TurretKind; lv: number; hp: number; x: number; y: number; angle: number; sinceShot: number };

/** A turret on its pad: the base, then the head turned to `angle` and kicked back by its last shot. (`x`, `y`) is the cell centre. */
export function drawTurret(ctx: CanvasRenderingContext2D, t: TurretDraw, pxPerUnit: number) {
  const lv = Math.min(MAX_LEVEL, Math.max(1, t.lv)), wear = wearStage(t.hp);
  const base = baseSprite(t.kind, lv, wear, pxPerUnit);
  ctx.drawImage(base, t.x - BASE_HALF, t.y - BASE_HALF, BASE_HALF * 2, BASE_HALF * 2);
  if (t.kind === 'tesla') return;
  const { index, rest } = headBucket(t.angle);
  const head = headSprite(t.kind, lv, wear, index, pxPerUnit);
  const kick = kickOf(t.kind, t.sinceShot);
  ctx.save();
  ctx.translate(t.x - Math.cos(t.angle) * kick, t.y - MOUNT_RISE - Math.sin(t.angle) * kick);
  if (rest) ctx.rotate(rest);
  ctx.drawImage(head, -HEAD_HALF, -HEAD_HALF, HEAD_HALF * 2, HEAD_HALF * 2);
  ctx.restore();
}

// ---- the lit layer, over the night ----

const FLASH: Record<TurretKind, number> = { sentry: 60, cannon: 130, scatter: 90, mortar: 150, tesla: 160 };
const LAMP = '#ffb347';
const COIL = '#8fc4ff';

export type TurretLit = TurretDraw & { ammo: number | null };

/** A star of fire at a muzzle: hot white core, yellow, orange tips, sized by `len`, fading with `k` (0 fresh, 1 gone). */
function flashStar(ctx: CanvasRenderingContext2D, len: number, wide: number, k: number) {
  const fade = 1 - k, l = len * (0.75 + 0.25 * fade);
  for (const [col, s] of [['#ff9a3c', 1], ['#ffe08a', 0.66], ['#fffbe8', 0.34]] as const) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(-1, -wide * s);
    ctx.lineTo(l * s * 0.45, -wide * s * 1.1);
    ctx.lineTo(l * s, 0);
    ctx.lineTo(l * s * 0.45, wide * s * 1.1);
    ctx.lineTo(-1, wide * s);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * What a turret lights, drawn over the night's shade so it reads in the dark: its shot (a muzzle flash at the barrel that
 * fired and a warm pool on the floor, a mortar's ring of smoke, a coil's crown of sparks), the coil's orb, the status lamp
 * (steady amber when loaded, blinking amber when low, red when dry) and the ammo gauge; at night a small work light over it.
 */
export function drawTurretLit(ctx: CanvasRenderingContext2D, t: TurretLit, now: number, pxPerUnit: number, reduced = false, dark = 0) {
  const lv = Math.min(MAX_LEVEL, Math.max(1, t.lv)), wear = wearStage(t.hp);
  const ms = t.sinceShot, flash = ms >= 0 && ms < FLASH[t.kind] ? ms / FLASH[t.kind] : -1;
  const px = t.x, py = t.y - MOUNT_RISE;
  // At night the gun's work light picks it out of the dark: a small warm pool over the emplacement, so its silhouette reads.
  if (dark > 0.05 && t.kind !== 'tesla') {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.3 * dark;
    ctx.drawImage(glowSprite(LAMP, pxPerUnit), px - 34, py - 34, 68, 68);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
  if (t.kind === 'tesla') {
    const top = { x: t.x, y: t.y - COIL_TOP(lv) + 1 };
    const pulse = 0.5 + 0.5 * Math.sin(now / (520 - 90 * lv));
    const glow = glowSprite(COIL, pxPerUnit);
    ctx.globalCompositeOperation = 'lighter';
    const reach = 22 + 4 * lv + (flash >= 0 ? 26 * (1 - flash) : 0);
    ctx.globalAlpha = 0.35 + 0.15 * pulse + (flash >= 0 ? 0.5 * (1 - flash) : 0);
    ctx.drawImage(glow, top.x - reach, top.y - reach, reach * 2, reach * 2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = flash >= 0 ? '#ffffff' : '#bfe3ff';
    ctx.beginPath();
    ctx.arc(top.x, top.y, 2.2 + lv * 0.5 + (flash >= 0 ? 1.5 * (1 - flash) : 0), 0, TAU);
    ctx.fill();
    if (flash >= 0 && !reduced) {
      // A crown of short bolts leaping off the orb, chunky and gone in a blink.
      const rnd = seeded(Math.floor(now / 40));
      ctx.strokeStyle = '#bfe3ff';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 1 - flash;
      ctx.beginPath();
      for (let i = 0; i < 3 + lv; i++) {
        let a = rnd() * TAU, x = top.x + Math.cos(a) * 4, y = top.y + Math.sin(a) * 4;
        ctx.moveTo(x, y);
        for (let j = 0; j < 3; j++) { a += (rnd() - 0.5) * 1.4; x += Math.cos(a) * 4.5; y += Math.sin(a) * 4.5; ctx.lineTo(x, y); }
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  } else if (flash >= 0) {
    const c = Math.cos(t.angle), s = Math.sin(t.angle);
    const kick = kickOf(t.kind, ms);
    const all = muzzlesOf(t.kind, lv, wear === 2 ? BEND : 0);
    // A sentry's barrels take turns; everything else fires them all at once.
    const fired = t.kind === 'sentry' ? [all[Math.floor(Math.abs(now - ms) / 16) % all.length]!] : all;
    const warm = glowSprite(LAMP, pxPerUnit);
    const big = t.kind === 'cannon' ? 1.8 : t.kind === 'scatter' ? 1.3 : t.kind === 'mortar' ? 1 : 0.8;
    const tip = (m: { x: number; y: number }) => ({ x: px + c * (m.x * HEAD_SCALE - kick) - s * m.y * HEAD_SCALE, y: py + s * (m.x * HEAD_SCALE - kick) + c * m.y * HEAD_SCALE });
    const mid = tip({ x: all.reduce((n, m) => n + m.x, 0) / all.length, y: 0 });
    // The floor lights round the gun for a blink.
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.55 * (1 - flash) * (1 - flash);
    const pool = 46 * big;
    ctx.drawImage(warm, mid.x - pool, mid.y - pool, pool * 2, pool * 2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (t.kind === 'mortar') {
      // A thump of smoke off each tube's mouth, a ring that spreads and thins.
      for (const m of fired) {
        const p = tip(m), e = 1 - (1 - flash) * (1 - flash);
        ctx.globalAlpha = 0.8 * (1 - flash);
        ctx.strokeStyle = '#5a5550';
        ctx.lineWidth = 3.5 * (1 - flash) + 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 + 9 * e, 0, TAU);
        ctx.stroke();
        if (flash < 0.4) {
          ctx.globalAlpha = 1 - flash / 0.4;
          ctx.fillStyle = '#ffe08a';
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3.4, 0, TAU);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    } else {
      for (const m of fired) {
        const p = tip(m);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(t.angle + m.a);
        ctx.globalAlpha = 1 - flash * 0.6;
        if (t.kind === 'cannon') {
          flashStar(ctx, 20, 6, flash);
          // The brake throws fire out of its side vents.
          ctx.save(); ctx.translate(-4, -4); ctx.rotate(-Math.PI / 2 - 0.25); flashStar(ctx, 9, 3, flash); ctx.restore();
          ctx.save(); ctx.translate(-4, 4); ctx.rotate(Math.PI / 2 + 0.25); flashStar(ctx, 9, 3, flash); ctx.restore();
        } else flashStar(ctx, t.kind === 'scatter' ? 9 : 11, t.kind === 'scatter' ? 2.6 : 3, flash);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
  }
  if (wear === 2) drawEmbers(ctx, t.x, t.y, now, pxPerUnit, reduced, 1);
  // The status lamp: a light source too, so it has a little pool of its own. A battered one's wiring is loose, so it stutters.
  if (t.ammo !== null) {
    const dry = t.ammo === 0, low = !dry && t.ammo <= 3;
    const on = (dry ? Math.floor(now / 250) % 2 === 0 : low ? Math.floor(now / 500) % 2 === 0 : true) && !(wear > 0 && !reduced && lampStutters(t.x + t.y, now, wear));
    const color = dry ? PALETTE.hpBad : LAMP;
    const lx = t.x + LAMP_AT.x, ly = t.y + LAMP_AT.y;
    if (on) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = dry ? 0.5 : 0.3;
      const glow = glowSprite(dry ? '#ff5a3c' : LAMP, pxPerUnit);
      ctx.drawImage(glow, lx - 9, ly - 9, 18, 18);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = on ? color : shadeHex(dry ? PALETTE.hpBad : LAMP, 0.35);
    ctx.beginPath();
    ctx.arc(lx, ly, 1.5, 0, TAU);
    ctx.fill();
    // The gauge: five cells on its plate, lit in the kind's accent, red and blinking when dry.
    const cells = 5, gw = GAUGE.half * 2, gx = t.x - GAUGE.half, gy = t.y + GAUGE.y - GAUGE.rise - 1.8, ch = 3.6, cw = gw / cells;
    const lit = dry ? 0 : Math.max(1, Math.ceil((t.ammo / 10) * cells));
    for (let i = 0; i < cells; i++) {
      ctx.fillStyle = i < lit ? TURRET_LOOK[t.kind].accent : dry && on ? PALETTE.hpBad : '#2a2e36';
      ctx.fillRect(gx + i * cw + 0.5, gy, cw - 1, ch);
    }
  }
}

/**
 * Whether a battered lamp is dark this instant: a loose contact drops it for a beat now and then, about one 80 ms dropout in
 * every 1.6 s when worn and a ragged double blink every 0.7 s when badly damaged. Seeded per turret so a base never blinks in step.
 */
export function lampStutters(seed: number, now: number, wear: Wear): boolean {
  if (!wear) return false;
  const period = wear === 2 ? 700 : 1600, offset = (Math.abs(Math.sin(seed * 12.9898)) * 43758.5453 % 1) * period;
  const t = (now + offset) % period;
  return t < 80 || (wear === 2 && t > 150 && t < 200);
}

/**
 * A smouldering ember glow on a charred emplacement or wreck, over the night: a low orange pool that breathes, and a few hot
 * coals in the char that flicker. `heat` (0..1) fades it as a wreck cools; reduced motion holds it steady.
 */
export function drawEmbers(ctx: CanvasRenderingContext2D, x: number, y: number, now: number, pxPerUnit: number, reduced: boolean, heat: number, spread = 14) {
  if (heat <= 0) return;
  const seed = Math.abs(Math.sin(x * 0.0123 + y * 0.0457)) * 1000;
  const breathe = reduced ? 0.8 : 0.7 + 0.3 * Math.sin(now / 420 + seed);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.42 * heat * breathe;
  const reach = spread * 1.9;
  ctx.drawImage(glowSprite('#ff7a2f', pxPerUnit), x - reach, y - reach * 0.8, reach * 2, reach * 2);
  ctx.globalCompositeOperation = 'source-over';
  const rnd = seeded(Math.floor(seed));
  for (let i = 0; i < 5; i++) {
    const a = rnd() * TAU, d = spread * (0.2 + 0.8 * rnd()), ph = rnd() * TAU;
    const f = reduced ? 0.8 : 0.55 + 0.45 * Math.sin(now / (180 + 90 * i) + ph);
    ctx.globalAlpha = Math.min(1, heat * 1.2) * f;
    ctx.fillStyle = i % 2 ? '#ff9a3c' : '#ffe08a';
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.8, 1.3 + rnd() * 0.9, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** The level in pips on a building's top-left corner: gold for each level it has, dark for each it could still gain. */
export function drawPips(ctx: CanvasRenderingContext2D, lv: number, top: number, x: number, y: number) {
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.4;
  for (let i = 0; i < top; i++) {
    const px = x + 7 + i * 7.5, py = y + 6.5;
    ctx.fillStyle = i < lv ? PALETTE.gold : 'rgba(20, 22, 28, 0.75)';
    ctx.beginPath();
    ctx.moveTo(px, py - 3.4); ctx.lineTo(px + 3.4, py); ctx.lineTo(px, py + 3.4); ctx.lineTo(px - 3.4, py);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}
