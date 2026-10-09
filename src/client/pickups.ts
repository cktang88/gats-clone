/**
 * Pickups, as the player sees them:
 * - the gain popups: whatever you just took (a health pack's +hp, an ammo pack's +rounds, the ability back, a golden gun) pops up over
 *   your own soldier as small toy chips, an icon and a number on a gunmetal plate, and rises and fades. What lands at once shares a row
 *   (and a second pack of the same kind adds to its chip); a later pickup starts a new row under it and lifts the older ones. Only you see
 *   your own: nobody else's gains are on your wire (sim/snapshot.ts).
 * There is no key for supplies: a standing medical cabinet or ammo crate opens by itself as you come up to it needing what it holds, and a
 * pack on the floor is taken by walking over it (sim/props.ts).
 */
import { WORLD } from '../shared/defs.ts';
import type { GameEvent, Snapshot } from '../shared/protocol.ts';
import { celPart, polygon, roundBox } from './cel.ts';
import { INK, shade } from './palette.ts';

// ---------------------------------------------------------------------------------------------------------------- gain popups

export type GainKind = 'hp' | 'ammo' | 'ability' | 'gold';
export type GainIn = Partial<Record<GainKind, number>>;
export type GainChip = { kind: GainKind; amount: number; touched: number; from: number };
export type GainRow = { chips: GainChip[]; born: number; touched: number; push: number; pushFrom: number; pushedAt: number };

/**
 * `mergeMs`: gains this close together share a row; `holdMs` then `fadeMs` after a row's last touch it is gone; it rises `rise` world px over
 * its life; a newer row lifts the older ones by `gap`. `cap` rows at most.
 */
export const GAIN = { mergeMs: 350, holdMs: 950, fadeMs: 420, rise: 26, gap: 30, cap: 4, popMs: 170 } as const;
export const GAIN_LIFE_MS = GAIN.holdMs + GAIN.fadeMs;

/** Each kind's icon colour (art bible: heal mint, lamp amber, spark, reward gold). */
export const GAIN_COLOR: Record<GainKind, string> = { hp: '#8ff0c4', ammo: '#ffb347', ability: '#ffd27a', gold: '#ffd34d' };
const ORDER: readonly GainKind[] = ['hp', 'ammo', 'ability', 'gold'];

/** Your gains in a snapshot's events, one per `gain` event; an event that gave nothing is dropped. */
export function gainsOf(events: readonly GameEvent[], myId: number): GainIn[] {
  const out: GainIn[] = [];
  for (const e of events) {
    if (e.e !== 'gain' || e.id !== myId) continue;
    const g: GainIn = {};
    if (e.hp && e.hp > 0) g.hp = e.hp;
    if (e.ammo && e.ammo > 0) g.ammo = e.ammo;
    if (e.ability) g.ability = 1;
    if (e.gold) g.gold = 1;
    if (Object.keys(g).length) out.push(g);
  }
  return out;
}

const easeOut = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
const popBack = (t: number): number => { const c = Math.min(1, Math.max(0, t)), k = 1.9; return 1 + (k + 1) * (c - 1) ** 3 + k * (c - 1) ** 2; };
const pushOf = (r: GainRow, now: number) => r.pushFrom + (r.push - r.pushFrom) * easeOut((now - r.pushedAt) / 180);

export const isLiveRow = (r: GainRow, now: number) => now - r.touched < GAIN_LIFE_MS;

/** Adds one pickup's gains: into the newest row if it is still fresh (a same-kind chip sums and pops again), else a new row that lifts the rest. */
export function addGain(rows: GainRow[], g: GainIn, now: number): void {
  const kinds = ORDER.filter((k) => (g[k] ?? 0) > 0);
  if (!kinds.length) return;
  const open = rows.at(-1);
  if (open && now - open.born < GAIN.mergeMs && isLiveRow(open, now)) {
    for (const k of kinds) {
      const chip = open.chips.find((c) => c.kind === k);
      if (chip) { chip.amount += g[k]!; chip.touched = now; chip.from = 1.35; }
      else open.chips.push({ kind: k, amount: g[k]!, touched: now, from: 0.35 });
    }
    open.chips.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    open.touched = now;
    return;
  }
  for (const r of rows) { r.pushFrom = pushOf(r, now); r.push += GAIN.gap; r.pushedAt = now; }
  rows.push({ chips: kinds.map((k) => ({ kind: k, amount: g[k]!, touched: now, from: 0.35 })), born: now, touched: now, push: 0, pushFrom: 0, pushedAt: now });
  if (rows.length > GAIN.cap) rows.splice(0, rows.length - GAIN.cap);
}

export const sweepGains = (rows: GainRow[], now: number): void => {
  for (let i = rows.length - 1; i >= 0; i--) if (!isLiveRow(rows[i]!, now)) rows.splice(i, 1);
};

export const rowAlpha = (r: GainRow, now: number): number => {
  const k = (now - r.touched - GAIN.holdMs) / GAIN.fadeMs;
  return k <= 0 ? 1 : Math.max(0, 1 - k * k);
};

/** World px above the soldier's anchor the row sits: the rise of its life plus the lift newer rows gave it. */
export const rowLift = (r: GainRow, now: number, reduced = false): number => pushOf(r, now) + (reduced ? 0.4 : 1) * GAIN.rise * easeOut((now - r.born) / GAIN_LIFE_MS);

export const chipLabel = (c: Pick<GainChip, 'kind' | 'amount'>): string => (c.kind === 'ability' ? 'READY' : c.kind === 'gold' ? 'GOLDEN GUN' : `+${Math.round(c.amount)}`);

const FONT = '"Barlow Condensed", system-ui, sans-serif';
const TEXT = 16, ICON = 16, PAD = 6, H = 24, CHIP_GAP = 6;
/** The chips are drawn this much bigger than their world size, like the radio's prompt, to read at the game's wide camera. */
const SCALE = 1.5;
const PLATE = '#3d4450';

/** The icons, centred on the origin, `ICON` px across: a chunky cross, a round of ammo, a lightning bolt, a star. */
function icon(ctx: CanvasRenderingContext2D, kind: GainKind) {
  const c = GAIN_COLOR[kind];
  if (kind === 'hp') {
    const a = 2.6, b = 7;
    celPart(ctx, polygon([-a, -b], [a, -b], [a, -a], [b, -a], [b, a], [a, a], [a, b], [-a, b], [-a, a], [-b, a], [-b, -a], [-a, -a]), c, 0, 12, 1.4);
  } else if (kind === 'ammo') {
    ctx.save();
    ctx.rotate(0.5);
    // The case (amber brass) and the ogive (rust copper), with a rim line between.
    celPart(ctx, roundBox(-3.2, -1.5, 3.2, 8, 1.2), c, -0.5, 7, 1.3);
    celPart(ctx, (g) => { g.moveTo(-3.2, -1.5); g.lineTo(-3.2, -3.5); g.quadraticCurveTo(-3.2, -8.5, 0, -9.5); g.quadraticCurveTo(3.2, -8.5, 3.2, -3.5); g.lineTo(3.2, -1.5); g.closePath(); }, '#a8552e', -0.5, 7, 1.3);
    ctx.fillStyle = INK;
    ctx.fillRect(-3.2, 5.4, 6.4, 1.2);
    ctx.restore();
  } else if (kind === 'ability') {
    celPart(ctx, polygon([1.5, -8.5], [-5, 1], [-0.5, 1], [-2, 8.5], [5, -1.5], [0.5, -1.5]), c, 0, 10, 1.3);
  } else {
    const pts: [number, number][] = [];
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 3.6 : 8.2; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
    celPart(ctx, polygon(...pts), c, 0, 12, 1.3);
  }
}

/** One chip's width at world size: icon, gap, label, and the plate's padding. */
function chipWidth(ctx: CanvasRenderingContext2D, c: GainChip): number {
  ctx.font = `900 ${TEXT}px ${FONT}`;
  return PAD + ICON + 4 + ctx.measureText(chipLabel(c)).width + PAD + 2;
}

function drawChip(ctx: CanvasRenderingContext2D, c: GainChip, x: number, w: number) {
  // The plate: matte gunmetal with a toy lip.
  celPart(ctx, roundBox(x, -H / 2, x + w, H / 2, 7), PLATE, 0, 8, 1.4, 3);
  ctx.save();
  ctx.translate(x + PAD + ICON / 2 + 1, -1.5);
  icon(ctx, c.kind);
  ctx.restore();
  const label = chipLabel(c);
  ctx.font = `900 ${TEXT}px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const tx = x + PAD + ICON + 4, ty = -2;
  ctx.lineWidth = 3.4;
  ctx.strokeStyle = INK;
  ctx.fillStyle = shade(GAIN_COLOR[c.kind], 0.6);
  ctx.strokeText(label, tx, ty + 1.6);
  ctx.fillText(label, tx, ty + 1.6);
  ctx.strokeText(label, tx, ty);
  ctx.fillStyle = GAIN_COLOR[c.kind];
  ctx.fillText(label, tx, ty);
}

/** Where each chip of a row sits, left edges from the row's centre, at world size (for the drawing and the tests). */
export function rowLayout(ctx: CanvasRenderingContext2D, r: GainRow): { x: number; w: number }[] {
  const ws = r.chips.map((c) => chipWidth(ctx, c));
  const total = ws.reduce((a, b) => a + b, 0) + CHIP_GAP * (ws.length - 1);
  let x = -total / 2;
  return ws.map((w) => { const at = { x, w }; x += w + CHIP_GAP; return at; });
}

/** Draws the live rows over the soldier at (`x`, `y`), the top of the head. World coordinates, over the night shade. */
export function drawGainRows(ctx: CanvasRenderingContext2D, rows: readonly GainRow[], now: number, x: number, y: number, reduced = false) {
  for (const r of rows) {
    if (!isLiveRow(r, now)) continue;
    const a = rowAlpha(r, now);
    if (a <= 0) continue;
    const layout = rowLayout(ctx, r);
    ctx.save();
    ctx.translate(x, y - rowLift(r, now, reduced));
    ctx.scale(SCALE, SCALE);
    r.chips.forEach((c, i) => {
      const at = layout[i]!;
      const sc = reduced ? 1 : c.from + (1 - c.from) * popBack((now - c.touched) / GAIN.popMs);
      ctx.save();
      const cx = at.x + at.w / 2;
      ctx.translate(cx, 0);
      ctx.scale(sc, sc);
      ctx.globalAlpha = a;
      drawChip(ctx, c, -at.w / 2, at.w);
      ctx.restore();
    });
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

let rows: GainRow[] = [];
let rowsFor = -1;

/** Takes your gains out of a fresh snapshot (call once per snapshot). `now` is the page clock the popups run on. */
export function noteGains(snap: Pick<Snapshot, 'events'>, myId: number, now: number) {
  if (myId !== rowsFor) { rows = []; rowsFor = myId; }
  for (const g of gainsOf(snap.events, myId)) addGain(rows, g, now);
}

/** The popups over your own soldier, drawn at its drawn place (`self`, null when you are not standing: they keep their clock and wait). */
export function drawGains(ctx: CanvasRenderingContext2D, now: number, self: { x: number; y: number } | null, reduced: boolean) {
  sweepGains(rows, now);
  if (!self || !rows.length) return;
  drawGainRows(ctx, rows, now, self.x, self.y - WORLD.playerRadius - 30, reduced);
}

/** The popups showing; for tests and the dev probe. */
export const pickupDebug = () => ({ rows: rows.map((r) => r.chips.map((c) => chipLabel(c))) });

export const __test = { reset() { rows = []; rowsFor = -1; } };
