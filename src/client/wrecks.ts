import { isTurretKind, ZOM, type BuildingKind } from '../shared/defs.ts';
import type { BuildingView, Snapshot } from '../shared/protocol.ts';
import { levelOf } from '../shared/sim/build.ts';
import { celPart, ellipse, polygon, roundBox, TAU, type Trace } from './cel.ts';
import { INK, PALETTE, shadeHex } from './palette.ts';
import { bakedSprite, char, drawEmbers, seeded, streaks, TURRET_LOOK } from './turretart.ts';

/**
 * What a building leaves when the horde brings it down. The sim deletes a building at 0 health (horde.ts `biteBuilding`),
 * so the wreck is the client's alone, like the corpses and scorches: a steaming pile of black and grey junk on charred
 * ground, baked once per kind, level and variant (wreck art below), with thick smoke and embers that thin over `smokeMs`
 * (siegefx.ts) and leave a cold wreck. It is cleared the moment anything is built on its cell, and otherwise fades after
 * `keepMs`, as a bullet hole does.
 */
export type Wreck = { id: number; cx: number; cy: number; kind: BuildingKind; lv: number; born: number };

export const WRECK = {
  /** Smoke pours thick at first and thins to nothing over this long. */
  smokeMs: 25_000,
  /** The embers' glow outlasts the smoke a little. */
  emberMs: 30_000,
  /** A cold wreck lies this long, then fades over `fadeMs`. */
  keepMs: 240_000,
  fadeMs: 3_000,
  /** At most this many wrecks are kept; the oldest goes first. */
  cap: 40,
} as const;

let wreckIds = 0;
/** The wrecks on the field now; the session's own, cleared with the run. */
export const wrecks: { list: Wreck[] } = { list: [] };

const cellOf = (b: Pick<BuildingView, 'cx' | 'cy'>) => `${b.cx},${b.cy}`;

/**
 * Notes the buildings the horde destroyed between two snapshots. A building gone from one to the next was destroyed when its
 * cell went up in the sim's `boom` or the night was on (only daylight demolishes, and that leaves nothing). Spike strips lie
 * on the floor and simply wear away. Answers the wrecks still lying: new ones added, any whose cell has been built on again
 * or that have faded dropped, and all of them dropped when the run ends or a new one starts.
 */
export function noteWrecks(list: readonly Wreck[], prev: Pick<Snapshot, 'run' | 'buildings'> | null | undefined, next: Pick<Snapshot, 'run' | 'buildings' | 'events'>, now: number): Wreck[] {
  if (!next.run || (prev?.run?.phase === 'over' && next.run.phase !== 'over')) return list.length ? [] : (list as Wreck[]);
  const standing = new Set((next.buildings ?? []).map(cellOf));
  const out = list.filter((w) => !standing.has(cellOf(w)) && now - w.born < WRECK.keepMs + WRECK.fadeMs);
  if (prev?.run && prev.buildings && next.buildings) {
    const night = prev.run.phase === 'night' || next.run.phase === 'night';
    for (const b of prev.buildings) {
      if (b.kind === 'spikes' || standing.has(cellOf(b))) continue;
      const at = { x: (b.cx + 0.5) * ZOM.cell, y: (b.cy + 0.5) * ZOM.cell };
      const boom = next.events.some((e) => e.e === 'boom' && Math.abs(e.x - at.x) < 1 && Math.abs(e.y - at.y) < 1);
      if (!boom && !night) continue;
      out.push({ id: ++wreckIds, cx: b.cx, cy: b.cy, kind: b.kind, lv: levelOf(b), born: now });
    }
  }
  return out.length > WRECK.cap ? out.slice(-WRECK.cap) : out;
}

/** How hard a wreck smokes, 1 when fresh down to 0 once cold: it pours for a few seconds, then thins. */
export function wreckHeat(w: Pick<Wreck, 'born'>, now: number, span: number = WRECK.smokeMs): number {
  const k = (now - w.born) / span;
  if (k < 0) return 1;
  if (k >= 1) return 0;
  return k < 0.15 ? 1 : Math.pow(1 - (k - 0.15) / 0.85, 1.4);
}

/** A wreck's opacity: whole until `keepMs`, then fading out. */
export const wreckAlpha = (w: Pick<Wreck, 'born'>, now: number) => Math.max(0, Math.min(1, 1 - (now - w.born - WRECK.keepMs) / WRECK.fadeMs));

// ---- the wreck's art, baked ----

const HALF = 44;
const GUNMETAL = '#4f5560';
const GUNMETAL_DARK = '#3d4450';
const BARREL = '#2c3037';
const STEEL = '#808a99';
const KHAKI = '#b4a07a';
const SAND = '#c9b48a';
const OLIVE = '#6c7356';
const RUST = '#a8552e';
const BRASS = '#b79a4a';
const BONE = '#e2dccb';
const WOOD = '#93724a';
const CHAR_GROUND = 'rgba(16, 13, 11, 0.6)';

/** A part in the kit's cel style at (`x`, `y`) turned by `a`, lying `rise` high with a `lip` of front face. */
function part(g: CanvasRenderingContext2D, x: number, y: number, a: number, trace: Trace, base: string, lip: number, rise = 0, ink = 0.9) {
  g.save();
  g.translate(x, y);
  g.rotate(a);
  celPart(g, trace, base, a, 4, ink, lip, rise);
  g.restore();
}

/** A shard of torn plate: a jagged quad, ink-edged, some bent into a V. */
function shard(g: CanvasRenderingContext2D, rnd: () => number, x: number, y: number, size: number, tone: string) {
  const a = rnd() * TAU, k = () => size * (0.55 + 0.45 * rnd());
  const bent = rnd() < 0.4;
  const pts: [number, number][] = bent
    ? [[-k(), -k() * 0.4], [0, -k() * 0.15], [k(), -k() * 0.5], [k() * 0.9, k() * 0.2], [0, k() * 0.35], [-k() * 0.8, k() * 0.3]]
    : [[-k(), -k() * 0.5], [k() * 0.7, -k() * 0.6], [k(), k() * 0.4], [-k() * 0.4, k() * 0.6]];
  part(g, x, y, a, polygon(...pts), tone, 1.6);
}

/** A sandbag burst flat on the floor, its sand fanned out beside it. */
function spilledBag(g: CanvasRenderingContext2D, x: number, y: number, a: number) {
  g.fillStyle = shadeHex(SAND, 0.78);
  g.beginPath();
  g.ellipse(x + Math.cos(a) * 6, y + Math.sin(a) * 6, 7.5, 4.6, a + Math.PI / 2, 0, TAU);
  g.fill();
  g.fillStyle = SAND;
  g.beginPath();
  g.ellipse(x + Math.cos(a) * 5, y + Math.sin(a) * 5 - 0.5, 5.4, 3, a + Math.PI / 2, 0, TAU);
  g.fill();
  part(g, x, y, a + Math.PI / 2 + 0.3, roundBox(-6, -2.6, 6, 2.6, 2.4), shadeHex(KHAKI, 0.82), 1.4);
  g.fillStyle = INK;
  g.save();
  g.translate(x, y - 1.4);
  g.rotate(a + Math.PI / 2 + 0.3);
  g.beginPath();
  g.moveTo(-3.2, -1.2); g.lineTo(-0.8, 0.4); g.lineTo(1.4, -0.8); g.lineTo(3.6, 1); g.lineTo(0.8, 1.6); g.lineTo(-1.2, 1); g.closePath();
  g.fill();
  g.restore();
}

/** A gun barrel toppled onto the floor: a dark tube on its side with its muzzle cap, a hole for a bore. */
function toppledBarrel(g: CanvasRenderingContext2D, x: number, y: number, a: number, len: number, w: number, cap = true) {
  part(g, x, y, a, roundBox(-len / 2, -w, len / 2, w, w * 0.8), BARREL, w * 0.9);
  if (cap) part(g, x + Math.cos(a) * (len / 2 - 2), y + Math.sin(a) * (len / 2 - 2), a, roundBox(-2.4, -w - 1.2, 2.4, w + 1.2, 1.2), GUNMETAL_DARK, w * 0.9);
  g.fillStyle = INK;
  g.beginPath();
  g.ellipse(x + Math.cos(a) * (len / 2 + 0.6), y + Math.sin(a) * (len / 2 + 0.6) - w * 0.9, 1, w * 0.7, a, 0, TAU);
  g.fill();
}

/** Brass rounds spilled from a broken box. */
function rounds(g: CanvasRenderingContext2D, rnd: () => number, n: number, spread: number) {
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU, d = spread * (0.3 + 0.7 * rnd());
    part(g, Math.cos(a) * d, Math.sin(a) * d, rnd() * TAU, roundBox(-2.2, -0.9, 2.2, 0.9, 0.9), BRASS, 0.8, 0, 0.6);
  }
}

/** The kind's own remains: what is left of its gun, its stock or its walls, heaped in the middle. */
function remains(g: CanvasRenderingContext2D, kind: BuildingKind, lv: number, rnd: () => number) {
  if (isTurretKind(kind) && kind !== 'tesla') {
    // The emplacement's ring torn open: burst bags (or plates at the top level) flung out round it.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + rnd() * 0.5, d = 15 + rnd() * 6;
      if (lv >= 3 || (lv === 2 && i % 2 === 0)) shard(g, rnd, Math.cos(a) * d, Math.sin(a) * d, 6, i % 2 ? STEEL : GUNMETAL_DARK);
      else spilledBag(g, Math.cos(a) * d, Math.sin(a) * d, a);
    }
    // The turntable knocked askew and the head's housing split on it, the barrel toppled off across the pile.
    part(g, -2, 2, 0.3, ellipse(0, 0, 11, 8.5), GUNMETAL_DARK, 2.2);
    part(g, 2, -1, -0.5 + rnd() * 0.4, roundBox(-9, -6.5, 7, 6.5, 3.5), shadeHex(TURRET_LOOK[kind].body, 0.8), 3.2, 1);
    if (kind === 'sentry') { toppledBarrel(g, 9, 6, 0.5, 20, 1.6); toppledBarrel(g, 4, 11, 0.9, 18, 1.5); }
    else if (kind === 'cannon') toppledBarrel(g, 6, 9, 0.35, 28, 3.6);
    else if (kind === 'scatter') { for (const k of [-1, 0, 1]) toppledBarrel(g, 10 + k * 2, 5 + k * 4, 0.6 + k * 0.25, 15, 1.8, false); }
    else {
      // A mortar tube lies on its side, its mouth a dark ring.
      part(g, 8, 8, 0.7, roundBox(-9, -4.5, 9, 4.5, 4.4), shadeHex(TURRET_LOOK.mortar.body, 0.85), 3.4);
      part(g, 8 + Math.cos(0.7) * 9, 8 + Math.sin(0.7) * 9, 0.7, ellipse(0, 0, 2.2, 4.8), GUNMETAL, 3.4);
    }
  } else if (kind === 'tesla') {
    // The coil's tower toppled: its copper drum lying on its side, banded, the orb rolled off, insulators shattered.
    part(g, -1, 2, 0.4, polygon([-12, -5], [-5, -12], [5, -12], [12, -5], [12, 5], [5, 12], [-5, 12], [-12, 5]), GUNMETAL_DARK, 2.4);
    part(g, 4, 4, -0.5, roundBox(-13, -6, 11, 6, 5), RUST, 4.6, 1);
    g.strokeStyle = shadeHex(RUST, 0.5);
    g.lineWidth = 1.4;
    g.save();
    g.translate(4, 4 - 5.6);
    g.rotate(-0.5);
    g.beginPath();
    for (let x = -10; x < 10; x += 3) { g.moveTo(x, -5); g.lineTo(x, 5); }
    g.stroke();
    g.restore();
    part(g, -14, 12, 0, ellipse(0, 0, 4.6, 4.6), STEEL, 2.4);
    for (let i = 0; i < 4; i++) shard(g, rnd, -10 + rnd() * 24, -14 + rnd() * 8, 3.2, BONE);
    for (let i = 0; i < 4; i++) shard(g, rnd, (rnd() - 0.5) * 36, (rnd() - 0.5) * 36, 5, i % 2 ? STEEL : GUNMETAL);
  } else if (kind === 'depot') {
    // The crates smashed to planks and their rounds strewn about.
    for (let i = 0; i < 7; i++) {
      const a = rnd() * TAU, d = 4 + rnd() * 16;
      part(g, Math.cos(a) * d, Math.sin(a) * d, rnd() * TAU, roundBox(-7, -1.8, 7, 1.8, 0.8), i % 3 ? OLIVE : '#59614a', 1.6);
    }
    part(g, -3, -2, 0.25, roundBox(-9, -6, 7, 6, 1.2), '#4f5640', 2.4);
    rounds(g, rnd, 12, 20);
    part(g, 8, 6, -0.4, roundBox(-6, -1.6, 6, 1.6, 0.8), '#e0661f', 1);
  } else if (kind === 'post') {
    // The locker crumpled flat, its cross plate face down beside it, the antenna snapped.
    part(g, -1, 0, -0.2, polygon([-13, -8], [-2, -10], [12, -7], [13, 6], [1, 9], [-12, 7]), GUNMETAL_DARK, 3);
    part(g, 10, 10, 0.5, roundBox(-5, -4, 5, 4, 1), '#2f6e52', 1.2);
    part(g, -12, 10, 1.1, roundBox(-8, -0.9, 8, 0.9, 0.9), GUNMETAL, 0.8);
    for (let i = 0; i < 4; i++) shard(g, rnd, (rnd() - 0.5) * 36, (rnd() - 0.5) * 36, 5, i % 2 ? STEEL : GUNMETAL);
  } else {
    // A wall's rubble: boards for a barricade, burst bags for a sandbag wall, torn plates for steel.
    for (let i = 0; i < 9; i++) {
      const a = rnd() * TAU, d = 3 + rnd() * 18, x = Math.cos(a) * d, y = Math.sin(a) * d;
      if (lv <= 1) part(g, x, y, rnd() * TAU, roundBox(-9, -2.4, 9, 2.4, 0.8), i % 2 ? WOOD : shadeHex(WOOD, 0.8), 2);
      else if (lv === 2) spilledBag(g, x, y, a);
      else shard(g, rnd, x, y, 8, i % 2 ? STEEL : GUNMETAL_DARK);
    }
  }
}

/** One wreck's sprite: charred ground, junk scattered and heaped, everything blackened; `variant` turns up a different heap. */
export function paintWreck(g: CanvasRenderingContext2D, kind: BuildingKind, lv: number, variant: number) {
  const rnd = seeded(variant * 97 + lv * 13 + kind.length * 7 + 3);
  // The ground burned black under it, blast streaks reaching out past the cell.
  g.fillStyle = CHAR_GROUND;
  for (let i = 0; i < 7; i++) {
    const a = rnd() * TAU, d = 9 * rnd(), r = 17 + rnd() * 9;
    g.beginPath();
    g.ellipse(Math.cos(a) * d, Math.sin(a) * d, r, r * 0.82, a, 0, TAU);
    g.fill();
  }
  streaks(g, rnd, 7, 16, 34, 4.4, 'rgba(16, 13, 11, 0.45)');
  // The contact shadow of the heap.
  g.fillStyle = PALETTE.contact;
  g.beginPath();
  g.ellipse(2, 3, 18, 14, 0, 0, TAU);
  g.fill();
  // Twisted metal flung clear of the pile first, then the kind's own remains on top.
  for (let i = 0; i < 5; i++) {
    const a = rnd() * TAU, d = 20 + rnd() * 14;
    shard(g, rnd, Math.cos(a) * d, Math.sin(a) * d, 3.4 + rnd() * 2.6, i % 2 ? STEEL : GUNMETAL);
  }
  remains(g, kind, lv, rnd);
  // Blackened all over, patchily: black and grey junk.
  char(g, rnd, 0.2, 4, 24);
  // A few hot coals baked in as dull red, under the live ember glow.
  g.fillStyle = 'rgba(110, 38, 18, 0.55)';
  for (let i = 0; i < 3; i++) { const a = rnd() * TAU, d = 14 * rnd(); g.beginPath(); g.arc(Math.cos(a) * d, Math.sin(a) * d, 1.3 + rnd(), 0, TAU); g.fill(); }
}

export const WRECK_VARIANTS = 3;
const variantOf = (w: Pick<Wreck, 'cx' | 'cy'>) => ((w.cx * 7 + w.cy * 13) % WRECK_VARIANTS + WRECK_VARIANTS) % WRECK_VARIANTS;

export const wreckSprite = (kind: BuildingKind, lv: number, variant: number, pxPerUnit: number) =>
  bakedSprite(`w|${kind}|${lv}|${variant}`, HALF, pxPerUnit, (g) => paintWreck(g, kind, lv, variant));

type View = { x0: number; y0: number; x1: number; y1: number };
const seen = (w: Wreck, v: View) => {
  const x = (w.cx + 0.5) * ZOM.cell, y = (w.cy + 0.5) * ZOM.cell;
  return x + HALF > v.x0 && x - HALF < v.x1 && y + HALF > v.y0 && y - HALF < v.y1;
};

/** The wrecks on the floor, under bodies and the night's shade: one baked sprite each. */
export function drawWrecks(ctx: CanvasRenderingContext2D, list: readonly Wreck[], view: View, now: number, pxPerUnit: number) {
  for (const w of list) {
    if (!seen(w, view)) continue;
    const a = wreckAlpha(w, now);
    if (a <= 0) continue;
    const x = (w.cx + 0.5) * ZOM.cell, y = (w.cy + 0.5) * ZOM.cell;
    ctx.globalAlpha = a;
    ctx.drawImage(wreckSprite(w.kind, w.lv, variantOf(w), pxPerUnit), x - HALF, y - HALF, HALF * 2, HALF * 2);
  }
  ctx.globalAlpha = 1;
}

/**
 * What a hot wreck lights, over the night: its embers' glow, cooling over `emberMs`. With reduced motion the smoke is not
 * flown as particles (siegefx.ts), so a still pall stands over the heap instead and thins as it cools.
 */
export function drawWreckGlow(ctx: CanvasRenderingContext2D, list: readonly Wreck[], view: View, now: number, pxPerUnit: number, reduced: boolean) {
  for (const w of list) {
    if (!seen(w, view)) continue;
    const heat = wreckHeat(w, now, WRECK.emberMs);
    if (heat <= 0) continue;
    const x = (w.cx + 0.5) * ZOM.cell, y = (w.cy + 0.5) * ZOM.cell;
    drawEmbers(ctx, x, y, now, pxPerUnit, reduced, heat, 18);
    if (reduced) {
      const smoke = wreckHeat(w, now);
      ctx.fillStyle = '#3a3633';
      for (let i = 0; i < 3; i++) {
        ctx.globalAlpha = 0.32 * smoke;
        ctx.beginPath();
        ctx.arc(x + 6 + i * 7, y - 14 - i * 12, 10 + i * 4, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }
}
