import { MAPS } from '../shared/maps.ts';
import { RANGE, TARGETS, targetPos, type RangeLayout, type TargetDef, type TargetKind } from '../shared/range.ts';
import type { GameEvent, Snapshot } from '../shared/protocol.ts';
import { celPart, ellipse, polygon, roundBox, TAU, type Trace } from './cel.ts';
import { stencil } from './floor.ts';
import { FLOOR, INK, PALETTE, shade } from './palette.ts';
import { reducedMotion } from './screenfx.ts';
import { LIGHT } from './tilt.ts';

/**
 * The range's toy targets, drawn in the art bible's three-quarter view: a thin ink-outlined board standing up-screen of its
 * footprint on a base plate, two hard cel steps lit from the top left, a contact shadow down and to the right. A hit wobbles it
 * and chips paper or splinters off; a kill tips it backward onto its base (anticipation, snap, a small rebound), and when it
 * regenerates it springs up with a stretch and settles. Where a target stands is a pure function of the server clock, so a
 * slider costs the wire nothing (shared/range.ts); everything here is timed on the same render clock as the other effects.
 */
const BONE = '#e9e2cc', KHAKI = '#b4a07a', KHAKI_D = '#978562', GUNMETAL = '#4f5560', OLIVE = '#6c7356', ORANGE = '#ff5a1f', RUST = '#a8552e', MUSTARD = FLOOR.paint;

const FALL_MS = 300, UP_MS = 420, HIT_MS = 300, FLASH_MS = 110;
/** How far a target tips: the board's height is squashed by the cosine of this, and it never quite vanishes. */
const LIE = (82 * Math.PI) / 180;
const easeOut = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
const backOut = (t: number) => { const c = Math.min(1, Math.max(0, t)); return 1 + 2.4 * (c - 1) ** 3 + 1.4 * (c - 1) ** 2; };

export type TargetState = { down: boolean; fallAt: number; upAt: number; hitAt: number; hitSide: number; holes: number; tenths: number };
const states = new Map<number, TargetState>();
export const freshTargetState = (): TargetState => ({ down: false, fallAt: -Infinity, upAt: -Infinity, hitAt: -Infinity, hitSide: 1, holes: 0, tenths: 10 });
export const stateOf = (i: number): TargetState => { let s = states.get(i); if (!s) states.set(i, (s = freshTargetState())); return s; };

type Chip = { x: number; y: number; z: number; vx: number; vy: number; vz: number; rot: number; vr: number; born: number; life: number; size: number; color: string };
let chips: Chip[] = [];
type Ring = { x: number; y: number; born: number };
let rings: Ring[] = [];
const CHIP_CAP = 160;

/** Events wait for the render clock to reach their tick, like every other effect. */
let pending: { at: number; ev: GameEvent }[] = [];

export function resetTargetArt() {
  states.clear();
  chips = [];
  rings = [];
  pending = [];
}

const layouts = new Map<string, RangeLayout | undefined>();
export function layoutOf(mapName: string): RangeLayout | undefined {
  if (!layouts.has(mapName)) layouts.set(mapName, Object.values(MAPS).find((m) => m.name === mapName)?.range);
  return layouts.get(mapName);
}

export function noteTargetEvents(snap: Snapshot, serverMs: number) {
  for (const ev of snap.events) if (ev.e === 'target' || (ev.e === 'dmg' && ev.kind === 'target')) pending.push({ at: serverMs, ev });
  if (pending.length > 400) pending.splice(0, pending.length - 400);
}

const chipColor = (kind: TargetKind, r: number) => (kind === 'plank' ? (r < 0.5 ? KHAKI : KHAKI_D) : kind === 'dummy' ? (r < 0.5 ? OLIVE : '#c9c4b4') : r < 0.7 ? BONE : r < 0.85 ? ORANGE : '#cfc7b3');

function burst(def: TargetDef | undefined, x: number, y: number, n: number, now: number, power: number) {
  if (reducedMotion() || !def) return;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, sp = (40 + Math.random() * 90) * power;
    chips.push({ x, y, z: 14 + Math.random() * 30, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.5, vz: 60 + Math.random() * 120 * power, rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 16, born: now, life: 420 + Math.random() * 300, size: 2.2 + Math.random() * 2.6, color: chipColor(def.kind, Math.random()) });
  }
  if (chips.length > CHIP_CAP) chips.splice(0, chips.length - CHIP_CAP);
}

/** Lands what is due at `renderMs`; `now` is the drawing clock the animations are born at. `layout` is the range's, to find a target's spot. */
export function releaseTargetFx(renderMs: number, now: number, layout: RangeLayout | undefined) {
  if (!pending.length) return;
  const due = pending.filter((p) => p.at <= renderMs);
  pending = pending.filter((p) => p.at > renderMs);
  for (const { ev } of due) {
    if (ev.e === 'dmg') {
      const i = ev.victim - RANGE.idBase, def = layout?.targets[i];
      const s = stateOf(i);
      s.hitAt = now;
      s.hitSide = -s.hitSide;
      s.holes++;
      burst(def, ev.x, ev.y, 3 + Math.min(4, Math.round(ev.amount / 20)), now, 0.7);
    } else if (ev.e === 'target') {
      const s = stateOf(ev.i), def = layout?.targets[ev.i];
      if (ev.k === 'down') { s.down = true; s.fallAt = now; s.hitSide = ev.i % 2 ? 1 : -1; burst(def, ev.x, ev.y, 10, now, 1.2); }
      else { s.down = false; s.upAt = now; s.holes = 0; rings.push({ x: ev.x, y: ev.y, born: now }); }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------- bodies

export type Pose = { /** 1 standing, down to a sliver while lying. */ rise: number; /** Squash across while it overshoots. */ across: number; lean: number; flash: number; lying: number };

/** How target `s` is posed at `now`: tipped, springing up, wobbling from a hit. */
export function targetPose(s: TargetState, now: number): Pose {
  const flash = Math.max(0, 1 - (now - s.hitAt) / FLASH_MS);
  const wob = reducedMotion() ? 0 : Math.sin((now - s.hitAt) / 24) * Math.max(0, 1 - (now - s.hitAt) / HIT_MS) ** 2 * 0.17 * s.hitSide;
  const minRise = Math.cos(LIE);
  if (s.down) {
    const t = (now - s.fallAt) / FALL_MS;
    // A short lean back (anticipation), then the snap over, then a small rebound off the floor.
    const p = t < 0.18 ? -0.08 * (t / 0.18) : t < 0.8 ? -0.08 + 1.08 * easeOut((t - 0.18) / 0.62) : 1 + 0.05 * Math.sin(Math.min(1, (t - 0.8) / 0.2) * Math.PI);
    const theta = Math.max(-0.08, p) * LIE;
    return { rise: Math.max(minRise, Math.cos(theta)), across: 1, lean: (s.hitSide * Math.min(1, Math.max(0, t))) * 0.22 + wob, flash, lying: Math.min(1, Math.max(0, t)) };
  }
  const t = (now - s.upAt) / UP_MS;
  if (t >= 1) return { rise: 1, across: 1, lean: wob, flash, lying: 0 };
  const k = backOut(t);
  const rise = minRise + (1 - minRise) * k;
  return { rise, across: 1 - 0.1 * Math.max(0, rise - 1) * 4 - 0.04 * (1 - Math.min(1, t * 3)), lean: wob + (1 - Math.min(1, t * 1.6)) * s.hitSide * 0.22, flash, lying: Math.max(0, 1 - t * 2.4) };
}

const holesOf = (n: number, seed: number): [number, number][] => {
  const out: [number, number][] = [];
  for (let i = 0; i < Math.min(n, 9); i++) {
    const a = (seed * 7.1 + i * 2.399) % TAU, r = 3 + ((i * 5 + seed) % 9);
    out.push([Math.cos(a) * r * 1.1, -32 + Math.sin(a) * r * 1.5]);
  }
  return out;
};

const paperTrace: Trace = (g) => {
  ellipse(0, -55, 8.5, 9)(g);
  polygon([-9, -48], [-17, -43], [-19, -14], [19, -14], [17, -43], [9, -48])(g);
};

function paperFace(g: CanvasRenderingContext2D, flash: number, holes: [number, number][], oy = 0) {
  g.save();
  g.translate(0, oy);
  celPart(g, paperTrace, BONE, 0, 36, 2);
  // The scoring rings are signal orange: what you act on.
  g.lineWidth = 2.4;
  g.strokeStyle = ORANGE;
  for (const r of [14, 9]) { g.beginPath(); g.arc(0, -32, r, 0, TAU); g.stroke(); }
  g.fillStyle = ORANGE;
  g.beginPath(); g.arc(0, -32, 4.6, 0, TAU); g.fill();
  g.lineWidth = 1.4;
  g.strokeStyle = INK;
  g.beginPath(); g.arc(0, -32, 14, 0, TAU); g.stroke();
  g.beginPath(); g.arc(0, -32, 4.6, 0, TAU); g.stroke();
  // Holes: punched-out dark pits with a bright torn rim.
  for (const [hx, hy] of holes) {
    g.fillStyle = '#f4efe0';
    g.beginPath(); g.arc(hx, hy, 3.1, 0, TAU); g.fill();
    g.fillStyle = INK;
    g.beginPath(); g.arc(hx, hy, 1.9, 0, TAU); g.fill();
  }
  if (flash > 0) { g.globalAlpha = flash * 0.85; g.fillStyle = '#ffffff'; g.beginPath(); paperTrace(g); g.fill(); g.globalAlpha = 1; }
  g.restore();
}

function basePlate(g: CanvasRenderingContext2D, w: number) {
  celPart(g, roundBox(-w, -5, w, 5, 4), GUNMETAL, 0, 24, 2, 5, 0);
}

function stake(g: CanvasRenderingContext2D, x: number, top: number) {
  celPart(g, roundBox(x - 2.6, top, x + 2.6, 0, 1.5), KHAKI_D, 0, 8, 1.6);
}

/** What stays on the floor when the board tips: the base plate, or the cart on its wheels. */
function drawBase(g: CanvasRenderingContext2D, kind: TargetKind) {
  if (kind === 'rail') {
    for (const wx of [-13, 13]) { g.fillStyle = INK; g.beginPath(); g.arc(wx, 0, 5.2, 0, TAU); g.fill(); g.fillStyle = BONE; g.beginPath(); g.arc(wx - 0.8, -0.8, 2.4, 0, TAU); g.fill(); }
    celPart(g, roundBox(-20, -7, 20, 3, 3), GUNMETAL, 0, 26, 2, 4, 0);
  } else basePlate(g, kind === 'paper' ? 17 : kind === 'plank' ? 25 : 27);
}

/** The board that stands up and tips over: drawn from the base's top edge up. */
function drawBoard(g: CanvasRenderingContext2D, kind: TargetKind, holes: [number, number][], flash: number) {
  if (kind === 'paper') {
    stake(g, 0, -20);
    paperFace(g, flash, holes);
  } else if (kind === 'rail') {
    paperFace(g, flash, holes, -4);
  } else if (kind === 'plank') {
    stake(g, -15, -22);
    stake(g, 15, -22);
    celPart(g, roundBox(-24, -66, 24, -10, 4), KHAKI, 0, 46, 2.2);
    g.strokeStyle = 'rgba(28, 31, 38, 0.42)';
    g.lineWidth = 1.4;
    for (const y of [-52, -38, -24]) { g.beginPath(); g.moveTo(-23, y); g.lineTo(23, y); g.stroke(); }
    // A painted bullseye.
    for (const [r, c] of [[16, BONE], [11, ORANGE], [6, BONE], [2.6, INK]] as const) { g.fillStyle = c; g.beginPath(); g.arc(0, -38, r, 0, TAU); g.fill(); }
    g.strokeStyle = INK; g.lineWidth = 1.6; g.beginPath(); g.arc(0, -38, 16, 0, TAU); g.stroke();
    for (const [hx, hy] of holes) { g.fillStyle = INK; g.beginPath(); g.arc(hx * 1.3, hy - 6, 2.2, 0, TAU); g.fill(); }
    if (flash > 0) { g.globalAlpha = flash * 0.8; g.fillStyle = '#ffffff'; roundBox(-24, -66, 24, -10, 4)(g); g.fill(); g.globalAlpha = 1; }
  } else {
    // The dummy: a sandbag soldier on a post, arms out on a crossbar, a gunmetal helmet.
    stake(g, 0, -34);
    celPart(g, roundBox(-27, -56, 27, -49, 3), KHAKI_D, 0, 30, 2);
    celPart(g, roundBox(-17, -64, 17, -14, 9), OLIVE, 0, 38, 2.2);
    g.strokeStyle = RUST;
    g.lineWidth = 3;
    for (const y of [-52, -40, -28]) { g.beginPath(); g.moveTo(-15, y); g.lineTo(15, y); g.stroke(); }
    g.strokeStyle = INK;
    g.lineWidth = 1.2;
    for (const y of [-52, -40, -28]) { g.beginPath(); g.moveTo(-15, y + 2); g.lineTo(15, y + 2); g.stroke(); }
    celPart(g, ellipse(0, -76, 10.5, 11), '#c9c4b4', 0, 22, 2);
    celPart(g, (c) => { c.moveTo(-11, -77); c.arc(0, -77, 11.5, Math.PI, 0); c.closePath(); }, GUNMETAL, 0, 22, 2);
    if (flash > 0) { g.globalAlpha = flash * 0.7; g.fillStyle = '#ffffff'; roundBox(-17, -64, 17, -14, 9)(g); g.fill(); g.globalAlpha = 1; }
  }
}

const HEIGHT: Record<TargetKind, number> = { paper: 72, rail: 72, plank: 76, dummy: 90 };

type View = { x0: number; y0: number; x1: number; y1: number };

/** A target standing at the origin, for the menu's range diorama: shadow, base plate and board, in the same art as the range. */
export function drawTargetProp(g: CanvasRenderingContext2D, kind: TargetKind, holes: [number, number][] = [], flash = 0) {
  drawShadow(g, kind, 1);
  drawBase(g, kind);
  drawBoard(g, kind, holes, flash);
}

function drawShadow(g: CanvasRenderingContext2D, kind: TargetKind, rise: number) {
  const r = TARGETS[kind].r;
  g.fillStyle = PALETTE.contact;
  g.beginPath(); g.ellipse(r * 0.28, r * 0.12, r * 1.05, r * 0.5, 0, 0, TAU); g.fill();
  // The board's own shadow falls down and to the right, away from the key light.
  const h = HEIGHT[kind] * rise * 0.42, w = r * 0.85;
  g.fillStyle = 'rgba(10, 12, 18, 0.28)';
  g.beginPath();
  g.moveTo(-w, 0); g.lineTo(w, 0); g.lineTo(w + h * LIGHT.x, h * LIGHT.y * 0.55); g.lineTo(-w + h * LIGHT.x, h * LIGHT.y * 0.55);
  g.closePath(); g.fill();
}

function drawBar(g: CanvasRenderingContext2D, kind: TargetKind, tenths: number) {
  const w = kind === 'dummy' ? 40 : 32, y = -HEIGHT[kind] - 8;
  g.fillStyle = 'rgba(19, 21, 25, 0.8)';
  g.fillRect(-w / 2 - 2, y - 2, w + 4, 7);
  g.fillStyle = tenths <= 3 ? PALETTE.hpBad : '#ece6d6';
  g.fillRect(-w / 2, y, (w * tenths) / 10, 3);
}

export function drawTargets(g: CanvasRenderingContext2D, snap: Pick<Snapshot, 'targets' | 'match'>, serverMs: number | null, now: number, view: View) {
  const layout = layoutOf(snap.match.map);
  if (!layout || !snap.targets) return;
  const t = serverMs ?? 0;
  const drawn: { i: number; def: TargetDef; x: number; y: number }[] = [];
  snap.targets.forEach((tenths, i) => {
    const def = layout.targets[i];
    if (!def) return;
    const s = stateOf(i);
    // A view that disagrees with what the events said (a join mid-fall, a missed event) is trusted over them.
    if (tenths === 0 && !s.down) { s.down = true; s.fallAt = -Infinity; }
    else if (tenths > 0 && s.down) { s.down = false; s.upAt = now; }
    if (tenths === 10 && s.tenths < 10) s.holes = 0;
    s.tenths = tenths;
    const p = targetPos(def, t);
    if (p.x + 60 < view.x0 || p.x - 60 > view.x1 || p.y + 110 < view.y0 || p.y - 60 > view.y1) return;
    drawn.push({ i, def, x: p.x, y: p.y });
  });
  drawn.sort((a, b) => a.y - b.y);
  for (const { i, def, x, y } of drawn) {
    const s = stateOf(i), pose = targetPose(s, now);
    g.save();
    g.translate(x, y);
    drawShadow(g, def.kind, pose.rise);
    drawBase(g, def.kind);
    g.rotate(pose.lean);
    g.scale(pose.across, pose.rise);
    drawBoard(g, def.kind, holesOf(s.holes, i + 3), pose.flash);
    if (pose.lying > 0.5 || (s.down && now - s.fallAt > FALL_MS)) {
      // Lying on its back it faces the sky, so it takes the light a step lighter.
      g.globalAlpha = 0.16;
      g.fillStyle = '#ffffff';
      g.fillRect(-30, -90, 60, 92);
      g.globalAlpha = 1;
    }
    g.restore();
    if (!s.down && s.tenths < 10) {
      g.save();
      g.translate(x, y);
      drawBar(g, def.kind, s.tenths);
      g.restore();
    }
  }
  for (const r of rings) {
    const k = (now - r.born) / 420;
    if (k >= 1) continue;
    g.globalAlpha = (1 - k) * 0.6;
    g.strokeStyle = '#ece6d6';
    g.lineWidth = 2.2;
    g.beginPath(); g.ellipse(r.x, r.y, 14 + 34 * easeOut(k), 6 + 15 * easeOut(k), 0, 0, TAU); g.stroke();
  }
  g.globalAlpha = 1;
  rings = rings.filter((r) => now - r.born < 420);
  chips = chips.filter((c) => now - c.born < c.life);
  for (const c of chips) {
    const age = (now - c.born) / 1000;
    const z = Math.max(0, c.z + c.vz * age - 330 * age * age);
    const cx = c.x + c.vx * age, cy = c.y + c.vy * age;
    g.globalAlpha = Math.min(1, (1 - (now - c.born) / c.life) * 1.6);
    g.save();
    g.translate(cx, cy - z);
    g.rotate(c.rot + c.vr * age);
    g.fillStyle = c.color;
    g.strokeStyle = INK;
    g.lineWidth = 1;
    g.fillRect(-c.size, -c.size * 0.7, c.size * 2, c.size * 1.4);
    g.strokeRect(-c.size, -c.size * 0.7, c.size * 2, c.size * 1.4);
    g.restore();
  }
  g.globalAlpha = 1;
}

// ---------------------------------------------------------------------------------------------------------------- the floor

let hazard: CanvasPattern | null = null;

function hazardPattern(g: CanvasRenderingContext2D): CanvasPattern {
  if (hazard) return hazard;
  const c = document.createElement('canvas');
  c.width = c.height = 24;
  const p = c.getContext('2d')!;
  p.fillStyle = MUSTARD;
  p.fillRect(0, 0, 24, 24);
  p.fillStyle = '#2b2e34';
  p.beginPath();
  for (const o of [-24, 0, 24]) { p.moveTo(o, 24); p.lineTo(o + 12, 24); p.lineTo(o + 36, 0); p.lineTo(o + 24, 0); p.closePath(); }
  p.fill();
  hazard = g.createPattern(c, 'repeat')!;
  return hazard;
}

/** True when a distance number stencilled at (`x`, `y`), its top left beside the bar, would sit under a target or a slider's run. */
function underTarget(layout: RangeLayout, x: number, y: number): boolean {
  return layout.targets.some((d) => {
    const half = d.rail ? d.rail.reach : 0;
    const ax = d.rail?.axis === 'x' ? half : 0, ay = d.rail?.axis === 'y' ? half : 0;
    return d.x + ax + 40 > x - 10 && d.x - ax - 40 < x + 80 && d.y + ay + 40 > y - 10 && d.y - ay - 70 < y + 34;
  });
}

/** Stencil paint on the range floor: pale bone, so numbers read on the dark concrete. */
const PAINT = '#d2cab4';

/** The painted range: lane bands, the firing line and its hazard strip, each distance in stencilled digits, a bay number and name at each booth, and the rails the sliders ride. */
export function drawRangeFloor(g: CanvasRenderingContext2D, layout: RangeLayout, size: number, view: View) {
  const { line, marks, lanes, pad } = layout;
  const inX = (x: number, w = 0) => x + w >= view.x0 && x <= view.x1;
  g.save();
  // Alternate lanes sit a shade darker, like swept and unswept slabs.
  g.fillStyle = 'rgba(20, 18, 14, 0.12)';
  for (const [i, l] of lanes.entries()) if (i % 2 === 0 && l.y1 >= view.y0 && l.y0 <= view.y1) g.fillRect(line, l.y0, size - line - 60, l.y1 - l.y0);
  // Lane edges: a dashed mustard line each.
  g.strokeStyle = MUSTARD;
  g.globalAlpha = 0.5;
  g.lineWidth = 3;
  g.setLineDash([36, 28]);
  for (const l of [...lanes.map((o) => o.y0), lanes.at(-1)!.y1]) {
    if (l < view.y0 || l > view.y1) continue;
    g.beginPath(); g.moveTo(line, l); g.lineTo(size - 60, l); g.stroke();
  }
  g.setLineDash([]);
  g.globalAlpha = 1;
  // Rails under the sliding targets: a gunmetal strip with sleepers and stops at each end.
  for (const d of layout.targets) {
    if (!d.rail) continue;
    const { axis, reach } = d.rail;
    const len = reach * 2 + 54;
    const x0 = axis === 'x' ? d.x - len / 2 : d.x - 7, y0 = axis === 'y' ? d.y - len / 2 : d.y - 7;
    const w = axis === 'x' ? len : 14, h = axis === 'y' ? len : 14;
    if (x0 + w < view.x0 || x0 > view.x1 || y0 + h < view.y0 || y0 > view.y1) continue;
    g.fillStyle = 'rgba(28, 31, 38, 0.3)';
    g.fillRect(x0 + 2, y0 + 3, w, h);
    g.fillStyle = KHAKI_D;
    for (let k = 0; k <= len; k += 22) { if (axis === 'y') g.fillRect(d.x - 12, y0 + k, 24, 5); else g.fillRect(x0 + k, d.y - 12, 5, 24); }
    g.fillStyle = GUNMETAL;
    g.fillRect(x0, y0, w, h);
    g.strokeStyle = INK;
    g.lineWidth = 2;
    g.strokeRect(x0, y0, w, h);
    g.fillStyle = '#3d4450';
    for (const e of [0, 1]) { const ex = axis === 'x' ? x0 + e * (len - 8) : d.x - 11, ey = axis === 'y' ? y0 + e * (len - 8) : d.y - 11; g.fillRect(ex, ey, axis === 'x' ? 8 : 22, axis === 'y' ? 8 : 22); g.strokeRect(ex, ey, axis === 'x' ? 8 : 22, axis === 'y' ? 8 : 22); }
  }
  // The distance marks: a painted bar across each lane and its number in stencil beside it, repeated down a tall bay so one is always in view.
  g.fillStyle = PAINT;
  for (const l of lanes) {
    if (l.y1 < view.y0 || l.y0 > view.y1) continue;
    const rows = Math.max(1, Math.round((l.y1 - l.y0) / 360));
    const pitch = (l.y1 - l.y0) / rows;
    for (const m of marks) {
      const x = line + m;
      if (!inX(x, 120)) continue;
      g.globalAlpha = 0.62;
      g.fillRect(x - 3, l.y0 + 34, 6, l.y1 - l.y0 - 68);
      g.globalAlpha = 0.72;
      // A number a target (or a slider's run) stands on moves to the foot of the bar, or is left out where another row shows it.
      const ys = Array.from({ length: rows }, (_, k) => l.y0 + 38 + k * pitch);
      let clear = ys.filter((y) => !underTarget(layout, x, y));
      if (!clear.length && !underTarget(layout, x, l.y1 - 62)) clear = [l.y1 - 62];
      for (const y of clear) stencil(g, String(m), x + 12, y, 24);
    }
  }
  g.globalAlpha = 1;
  // Where you arrive: a hazard-banded pad with mustard corner brackets.
  if (pad.x + pad.w + 40 >= view.x0 && pad.x - 40 <= view.x1 && pad.y + pad.h + 40 >= view.y0 && pad.y - 40 <= view.y1) {
    const e = 14, b = 9;
    g.globalAlpha = 0.6;
    g.fillStyle = hazardPattern(g);
    g.beginPath();
    g.rect(pad.x - e, pad.y - e, pad.w + e * 2, pad.h + e * 2);
    g.rect(pad.x - e + b, pad.y - e + b, pad.w + (e - b) * 2, pad.h + (e - b) * 2);
    g.fill('evenodd');
    g.globalAlpha = 0.8;
    g.fillStyle = MUSTARD;
    const arm = 30, t = 6;
    for (const [cx, cy, sx, sy] of [[pad.x, pad.y, 1, 1], [pad.x + pad.w, pad.y, -1, 1], [pad.x, pad.y + pad.h, 1, -1], [pad.x + pad.w, pad.y + pad.h, -1, -1]] as const) {
      g.fillRect(Math.min(cx, cx + sx * arm), Math.min(cy, cy + sy * t), arm, t);
      g.fillRect(Math.min(cx, cx + sx * t), Math.min(cy, cy + sy * arm), t, arm);
    }
    g.globalAlpha = 1;
  }
  // The firing line: a hazard strip with a white edge, the whole length of the range.
  const top = lanes[0]!.y0, bottom = lanes.at(-1)!.y1;
  g.fillStyle = hazardPattern(g);
  g.fillRect(line - 22, top, 14, bottom - top);
  g.fillStyle = '#f6f1e3';
  g.globalAlpha = 0.95;
  g.fillRect(line - 4, top, 8, bottom - top);
  g.globalAlpha = 1;
  // Bays: a number and a name at each booth.
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  for (const [i, l] of lanes.entries()) {
    // Near the top of a tall bay, so the name stays clear of the pad in its middle.
    const yc = Math.min((l.y0 + l.y1) / 2, l.y0 + 200);
    if (yc + 60 < view.y0 || yc - 60 > view.y1) continue;
    g.fillStyle = PAINT;
    g.globalAlpha = 0.62;
    stencil(g, String(i + 1), line - 168, yc - 24, 46);
    g.font = '800 30px "Barlow Condensed", system-ui, sans-serif';
    g.fillText(l.label, line - 168, yc + 44);
  }
  g.restore();
}
