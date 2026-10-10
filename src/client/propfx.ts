import { ARMOR_PACK, COLORS, PROP_FX, PROP_KINDS, PROPS, type PropKind } from '../shared/defs.ts';
import { markBlast } from './blastfx.ts';
import { lightingEnabled } from './lighting.ts';
import type { PackView, PropView, Snapshot, ThrownView } from '../shared/protocol.ts';
import { seeded } from './grain.ts';
import { INK } from './palette.ts';
import { LIGHT } from './tilt.ts';

/**
 * The props that stand beside the barrels (docs/art/STYLE.md), drawn in the toy-soldier kit: a three-quarter top face with a front face
 * hanging below it, a 2 px ink outline, two hard cel steps and one specular dot on the round ones. Every effect is a light first, then
 * the shape, then particles, then a residue: tanks vent, a generator arcs, a drum spills flame, glass shatters, paint splats and stays.
 * Drawing is stateless on the clock where it can be; `notePropEvents` keeps the little it must (event bursts, paint splats, EMPs).
 */

const TAU = Math.PI * 2;
const STEEL = '#8fb8ff', STEEL_DARK = '#5f7fb8', BONE = '#ece6d6', AMBER = '#ffb347', SPARK = '#ffd27a', SMOKE = '#5a5550', SIGNAL = '#ff5a1f', HEAL = '#8ff0c4', TOXIC = '#c7d84a', EMP = '#bfe6ff';
const GUNMETAL = '#4f5560', GUNMETAL_DARK = '#3d4450', OLIVE = '#6c7356', OLIVE_DARK = '#4e543c', RUST = '#a8552e';
const SHADOW = 'rgba(10, 12, 18, 0.46)', CONTACT = 'rgba(10, 12, 18, 0.42)';
const HIGHLIGHT = 'rgba(255, 255, 255, 0.24)', SHADE = 'rgba(10, 12, 16, 0.3)';
const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ease = (t: number) => 1 - (1 - clamp01(t)) ** 3;

type View = { x0: number; y0: number; x1: number; y1: number };
const visible = (v: View, x: number, y: number, pad: number) => x > v.x0 - pad && x < v.x1 + pad && y > v.y0 - pad && y < v.y1 + pad;

// ---------------------------------------------------------------------------------------------------------------- memory

/** `kind` 'armor' is an armor pack taken (sim/packs.ts), which bursts like a cabinet's pack in steel blue. */
type Burst = { k: 'pop' | 'launch' | 'emp' | 'pick' | 'relight'; kind: PropKind | 'armor'; x: number; y: number; born: number; seed: number; a: number; r: number; color: string };
type Splat = { x: number; y: number; born: number; seed: number; color: string };
type Mem = { map: string; bursts: Burst[]; splats: Splat[]; last: Map<number, { x: number; y: number }>; slicks: Map<number, number> };
const mem: Mem = { map: '', bursts: [], splats: [], last: new Map(), slicks: new Map() };
const BURST_CAP = 36, SPLAT_CAP = 40;
const BURST_MS = { pop: 700, launch: 450, emp: 800, pick: 600, relight: 450 } as const;
const SPLAT_MS = 90_000;
/** A generator's pulse darkens the lamps in its reach this long, stuttering back on at the end. */
const LAMP_OUT_MS = 2200;

export function resetPropFx() {
  mem.map = '';
  mem.bursts.length = 0;
  mem.splats.length = 0;
  mem.last.clear();
  mem.slicks.clear();
}

/** Takes in a snapshot's prop events: a burst per event (drawn by `drawPropTops`), and a splat that stays where a paint can went. */
export function notePropEvents(snap: Pick<Snapshot, 'events' | 'match'>, now: number) {
  if (mem.map !== snap.match.map) { resetPropFx(); mem.map = snap.match.map; }
  for (const ev of snap.events) {
    if (ev.e === 'pack') { mem.bursts.push({ k: 'pick', kind: 'armor', x: ev.x, y: ev.y, born: now, seed: Math.round(ev.x * 31 + ev.y * 17 + now), a: 0, r: 0, color: STEEL }); continue; }
    if (ev.e !== 'prop') continue;
    if (ev.k === 'arc') continue;
    // A tank that bursts is a blast (blastfx.ts): it throws its own staves, flash, fire and smoke, so it only names itself here.
    if (ev.kind === 'propane' && ev.k === 'pop') { markBlast('propane', ev.x, ev.y, now); continue; }
    const seed = Math.round(ev.x * 31 + ev.y * 17 + now);
    const color = ev.c ? COLORS[ev.c] : AMBER;
    mem.bursts.push({ k: ev.k, kind: ev.kind, x: ev.x, y: ev.y, born: now, seed, a: ev.a ?? 0, r: ev.r ?? 0, color });
    if (ev.kind === 'paint' && ev.k === 'pop') mem.splats.push({ x: ev.x, y: ev.y, born: now, seed, color });
  }
  if (mem.bursts.length > BURST_CAP) mem.bursts.splice(0, mem.bursts.length - BURST_CAP);
  if (mem.splats.length > SPLAT_CAP) mem.splats.splice(0, mem.splats.length - SPLAT_CAP);
}

// ---------------------------------------------------------------------------------------------------------------- lights

/** A light a prop casts: a warm or cold pool at (`x`, `y`) of radius `r`. */
/** `key` names the source, so a light that moves (a rocketing tank) stays one light rather than leaving a keyed light at every spot it passed. */
export type PropLight = { x: number; y: number; r: number; color: string; core: string; intensity: number; key: string };
let lightSink: ((lights: readonly PropLight[]) => void) | null = null;
/**
 * TODO(lighting): the WebGL lighting pass (another agent's `addLight(...)`, expected in src/client/lighting.ts) is not in the tree yet.
 * When it lands, call `setPropLightSink((lights) => lights.forEach((l) => addLight({ x: l.x, y: l.y, radius: l.r, color: l.color, intensity: l.intensity })))`
 * from main.ts, and drop the additive pools `drawPropTops` paints meanwhile (`FALLBACK_POOLS`).
 */
export const setPropLightSink = (sink: ((lights: readonly PropLight[]) => void) | null) => { lightSink = sink; };
const FALLBACK_POOLS = true;
/** By day the stand-in pools are a tint, not a flood; the lighting pass will own the night. */
const FALLBACK_GAIN = 0.4;

const lampOutAt = (x: number, y: number, now: number): number | null => {
  for (const b of mem.bursts) if (b.k === 'emp' && now - b.born < LAMP_OUT_MS && Math.hypot(b.x - x, b.y - y) < b.r + 40) return now - b.born;
  return null;
};
/** 0 when a lamp is dark, 1 lit: dark under an EMP, with a stutter as it comes back, and dark while its bulb is broken (`state` 11). */
function lampLit(q: PropView, now: number): number {
  if (q[4] === 11) return 0;
  const out = lampOutAt(q[2], q[3], now);
  if (out === null) return 1;
  return out < LAMP_OUT_MS - 500 ? 0 : Math.floor(now / 80) % 2 === 0 ? 0.3 : 1;
}

/** Every light the props cast right now: lit lamps, burning slicks, arcing generators, rocketing tanks, and the flashes of what just went off. */
export function propLights(snap: Pick<Snapshot, 'props' | 'thrown' | 'packs'>, now: number): PropLight[] {
  const out: PropLight[] = [];
  for (const [id, x, y] of snap.packs ?? []) out.push({ x, y, r: 60, color: STEEL, core: BONE, intensity: 0.28, key: `armor:${id}` });
  for (const q of snap.props ?? []) {
    const kind = PROP_KINDS[q[1]]!;
    if (kind === 'lamp') { const lit = lampLit(q, now); if (lit > 0) out.push({ x: q[2] + 6, y: q[3] + 16, r: 170, color: AMBER, core: '#ffe08a', intensity: 0.3 * lit, key: `lamp:${q[0]}` }); }
    if (kind === 'generator' && q[4] === 0) out.push({ x: q[2], y: q[3], r: 120, color: EMP, core: EMP, intensity: 0.35 + 0.3 * Math.sin(now / 25) ** 2, key: `gen:${q[0]}` });
    if (kind === 'propane' && q[4] === 0) out.push({ x: q[2], y: q[3], r: 120, color: '#ff9a3c', core: '#ffe08a', intensity: 0.6, key: `tank:${q[0]}` });
    if ((kind === 'medic' || kind === 'ammo') && q[4] === 11) out.push({ x: q[2], y: q[3], r: 56, color: kind === 'medic' ? HEAL : AMBER, core: BONE, intensity: 0.28, key: `pick:${q[0]}` });
  }
  for (const t of snap.thrown) if (t.kind === 'fireSlick') out.push({ x: t.x, y: t.y, r: t.r * 1.9, color: '#ff9a3c', core: '#ffe08a', intensity: 0.55 + 0.1 * Math.sin(now / 70 + t.id), key: `slick:${t.id}` });
  for (const b of mem.bursts) {
    const age = now - b.born;
    if (age > 320) continue;
    const k = 1 - age / 320, key = `burst:${b.k}:${b.kind}:${Math.round(b.x)},${Math.round(b.y)}`;
    if (b.k === 'emp') out.push({ x: b.x, y: b.y, r: b.r + 60, color: EMP, core: EMP, intensity: 0.7 * k, key });
    else if (b.k === 'launch') out.push({ x: b.x, y: b.y, r: 150, color: '#ff9a3c', core: '#ffe08a', intensity: 0.8 * k, key });
    else if (b.k === 'pop' && b.kind === 'oil') out.push({ x: b.x, y: b.y, r: 160, color: '#ff9a3c', core: '#ffe08a', intensity: 0.9 * k, key });
    else if (b.k === 'pop' && b.kind === 'lamp') out.push({ x: b.x, y: b.y - 40, r: 110, color: SPARK, core: '#ffffff', intensity: 0.7 * k, key });
  }
  return out;
}

function pool(ctx: CanvasRenderingContext2D, l: PropLight) {
  if (l.intensity <= 0.01) return;
  const g = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r);
  g.addColorStop(0, l.core);
  g.addColorStop(0.35, l.color);
  g.addColorStop(1, 'rgba(255, 150, 60, 0)');
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = Math.min(1, l.intensity * FALLBACK_GAIN);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(l.x, l.y, l.r, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------------------------- shapes

function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A cylinder: a round top at (`cx`, `cy`) with its body hanging `face` below. */
function capsule(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, face: number) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 0);
  ctx.lineTo(cx + r, cy + face);
  ctx.arc(cx, cy + face, r, 0, Math.PI);
  ctx.closePath();
}

function contact(ctx: CanvasRenderingContext2D, cx: number, baseY: number, rx: number, ry: number, castLen: number, castW: number) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = SHADOW;
  ctx.lineWidth = castW;
  ctx.beginPath();
  ctx.moveTo(cx, baseY);
  ctx.lineTo(cx + LIGHT.x * castLen * 1.6, baseY + LIGHT.y * castLen * 1.6);
  ctx.stroke();
  ctx.fillStyle = CONTACT;
  ctx.beginPath();
  ctx.ellipse(cx, baseY + 2, rx, ry, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

type Look = { r: number; face: number; top: string; side: string; band: string };
const TANKS: Partial<Record<PropKind, Look>> = {
  propane: { r: 12, face: 15, top: '#d9d2bf', side: '#a79f8a', band: SIGNAL },
  gas: { r: 14, face: 10, top: OLIVE, side: OLIVE_DARK, band: TOXIC },
  oil: { r: 15, face: 12, top: GUNMETAL, side: GUNMETAL_DARK, band: AMBER },
  paint: { r: 9, face: 7, top: '#8a919c', side: '#5f6672', band: BONE },
};

/** A tank, drum or can: ink-outlined, two hard cel steps on its side, a banded body, a lid with its mark and a specular dot, dented by damage. */
function tankBody(ctx: CanvasRenderingContext2D, kind: PropKind, cx: number, cy: number, hp: number, id: number, now: number, lidColor?: string) {
  const L = TANKS[kind]!;
  const { r, face } = L;
  ctx.save();
  capsule(ctx, cx, cy, r, face);
  ctx.fillStyle = L.side;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = HIGHLIGHT;
  ctx.fillRect(cx - r, cy, r * 0.5, face + r);
  ctx.fillStyle = SHADE;
  ctx.fillRect(cx + r * 0.42, cy, r, face + r);
  // The painted band round the body.
  ctx.fillStyle = L.band;
  ctx.fillRect(cx - r, cy + face * 0.42, 2 * r, face * 0.26);
  ctx.fillStyle = HIGHLIGHT;
  ctx.fillRect(cx - r, cy + face * 0.42, r * 0.5, face * 0.26);
  ctx.fillStyle = SHADE;
  ctx.fillRect(cx + r * 0.42, cy + face * 0.42, r, face * 0.26);
  // Damage reads as pits and cutouts, never hairlines.
  ctx.fillStyle = 'rgba(28, 31, 38, 0.82)';
  if (hp <= 7) ctx.fillRect(cx - r * 0.55, cy + face * 0.15, 5, 4);
  if (hp <= 4) { ctx.fillRect(cx + r * 0.2, cy + face * 0.75, 6, 4); ctx.fillRect(cx - r * 0.1, cy + face * 0.55, 4, 4); }
  ctx.restore();
  capsule(ctx, cx, cy, r, face);
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK;
  ctx.stroke();
  // The lid.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fillStyle = lidColor ?? L.top;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = HIGHLIGHT;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r * 0.2, cy - r); ctx.lineTo(cx - r, cy + r * 0.2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = SHADE;
  ctx.beginPath();
  ctx.moveTo(cx + r, cy + r); ctx.lineTo(cx - r * 0.2, cy + r); ctx.lineTo(cx + r, cy - r * 0.2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = INK;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 3.5, 0, TAU);
  ctx.stroke();
  // What is inside, stencilled on the lid.
  ctx.fillStyle = INK;
  if (kind === 'propane') {
    ctx.fillStyle = SIGNAL;
    ctx.beginPath(); ctx.arc(cx, cy, 3.6, 0, TAU); ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = INK; ctx.stroke();
    ctx.fillStyle = GUNMETAL; ctx.fillRect(cx - 1, cy - r + 1.5, 2, 4);
  } else if (kind === 'gas') {
    for (let i = 0; i < 3; i++) { const a = -Math.PI / 2 + i * (TAU / 3); ctx.beginPath(); ctx.arc(cx + Math.cos(a) * 5, cy + Math.sin(a) * 5, 2.2, 0, TAU); ctx.fillStyle = TOXIC; ctx.fill(); ctx.lineWidth = 1; ctx.stroke(); }
  } else if (kind === 'oil') {
    ctx.fillStyle = AMBER;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 6); ctx.quadraticCurveTo(cx + 5.4, cy + 1, cx + 3.2, cy + 4.2); ctx.quadraticCurveTo(cx, cy + 6.4, cx - 3.2, cy + 4.2); ctx.quadraticCurveTo(cx - 5.4, cy + 1, cx, cy - 6);
    ctx.fill(); ctx.lineWidth = 1.2; ctx.stroke();
  }
  // One specular dot on the lit side of the rim.
  ctx.beginPath();
  ctx.arc(cx - r * 0.55, cy - r * 0.55, kind === 'paint' ? 1.6 : 2.2, 0, TAU);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.restore();
  leak(ctx, kind, cx, cy, r, hp, id, now);
}

/** Wisps and drips leaking from a hurt prop, stateless on the clock. */
function leak(ctx: CanvasRenderingContext2D, kind: PropKind, cx: number, cy: number, r: number, hp: number, id: number, now: number) {
  if (hp > 6 || hp === 0) return;
  const color = kind === 'gas' ? TOXIC : kind === 'oil' ? INK : kind === 'paint' ? BONE : '#ece6d6';
  const puffs = hp <= 3 ? 3 : 2, period = 900;
  for (let i = 0; i < puffs; i++) {
    const t = ((now + id * 137 + i * (period / puffs)) % period) / period;
    ctx.globalAlpha = (1 - t) * 0.55;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx + r * 0.5 + Math.sin(t * 5 + i) * 3, cy - r * 0.2 - t * 24, 2.2 + t * 4.5, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

type Box = { w: number; h: number; face: number; top: string; side: string };
/** A box prop: a top face footprint with its front face hanging below, outlined and cel-shaded. */
function boxBody(ctx: CanvasRenderingContext2D, cx: number, cy: number, b: Box, hp: number) {
  const x = cx - b.w / 2, y = cy - b.h / 2;
  ctx.save();
  ctx.lineJoin = 'round';
  // Front face.
  rrect(ctx, x, y + b.h - 4, b.w, b.face + 4, 4);
  ctx.fillStyle = b.side;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = HIGHLIGHT;
  ctx.fillRect(x, y + b.h, b.w * 0.22, b.face);
  ctx.fillStyle = SHADE;
  ctx.fillRect(x + b.w * 0.74, y + b.h, b.w, b.face);
  ctx.restore();
  rrect(ctx, x, y + b.h - 4, b.w, b.face + 4, 4);
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.stroke();
  // Top face.
  rrect(ctx, x, y, b.w, b.h, 4);
  ctx.fillStyle = b.top;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = HIGHLIGHT;
  ctx.fillRect(x, y, b.w, b.h * 0.2);
  ctx.fillRect(x, y, b.w * 0.2, b.h);
  ctx.fillStyle = SHADE;
  ctx.fillRect(x, y + b.h * 0.82, b.w, b.h);
  ctx.fillRect(x + b.w * 0.82, y, b.w, b.h);
  ctx.fillStyle = 'rgba(28, 31, 38, 0.82)';
  if (hp <= 7) ctx.fillRect(x + b.w * 0.12, y + b.h * 0.6, 6, 5);
  if (hp <= 4) { ctx.fillRect(x + b.w * 0.62, y + b.h * 0.22, 7, 5); ctx.fillRect(x + b.w * 0.5, y + b.h * 0.7, 5, 5); }
  ctx.restore();
  rrect(ctx, x, y, b.w, b.h, 4);
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.restore();
}

function specular(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.beginPath();
  ctx.arc(x, y, 2, 0, TAU);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fill();
}

function bolt(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, fill: string) {
  ctx.beginPath();
  ctx.moveTo(cx + 0.2 * s, cy - s); ctx.lineTo(cx - 0.55 * s, cy + 0.1 * s); ctx.lineTo(cx - 0.05 * s, cy + 0.1 * s); ctx.lineTo(cx - 0.25 * s, cy + s); ctx.lineTo(cx + 0.6 * s, cy - 0.15 * s); ctx.lineTo(cx + 0.1 * s, cy - 0.15 * s);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = INK;
  ctx.stroke();
}

function cross(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, fill: string) {
  const a = s * 0.36;
  ctx.beginPath();
  ctx.moveTo(cx - a, cy - s); ctx.lineTo(cx + a, cy - s); ctx.lineTo(cx + a, cy - a); ctx.lineTo(cx + s, cy - a); ctx.lineTo(cx + s, cy + a); ctx.lineTo(cx + a, cy + a);
  ctx.lineTo(cx + a, cy + s); ctx.lineTo(cx - a, cy + s); ctx.lineTo(cx - a, cy + a); ctx.lineTo(cx - s, cy + a); ctx.lineTo(cx - s, cy - a); ctx.lineTo(cx - a, cy - a);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK;
  ctx.stroke();
}

function generatorBody(ctx: CanvasRenderingContext2D, cx: number, cy: number, hp: number) {
  const size = PROPS.generator.size, b: Box = { w: size, h: size - 6, face: 11, top: GUNMETAL, side: GUNMETAL_DARK };
  boxBody(ctx, cx, cy, b, hp);
  const x = cx - b.w / 2, y = cy - b.h / 2;
  // Vent slits on the top and hazard stripes along the front.
  ctx.fillStyle = INK;
  for (let i = 0; i < 3; i++) ctx.fillRect(x + 6, y + 6 + i * 5, b.w * 0.45, 2.4);
  ctx.save();
  rrect(ctx, x + 2, y + b.h + 1, b.w - 4, 7, 2);
  ctx.clip();
  ctx.fillStyle = SIGNAL;
  ctx.fillRect(x, y + b.h, b.w, 9);
  ctx.fillStyle = INK;
  for (let i = -1; i < 7; i++) { ctx.beginPath(); ctx.moveTo(x + i * 8, y + b.h + 9); ctx.lineTo(x + i * 8 + 4, y + b.h + 9); ctx.lineTo(x + i * 8 + 10, y + b.h); ctx.lineTo(x + i * 8 + 6, y + b.h); ctx.closePath(); ctx.fill(); }
  ctx.restore();
  bolt(ctx, cx + b.w * 0.22, cy + 2, 8, SPARK);
  specular(ctx, x + 5, y + 4);
}

function cabinetBody(ctx: CanvasRenderingContext2D, kind: 'medic' | 'ammo', cx: number, cy: number, hp: number) {
  const size = PROPS[kind].size, b: Box = kind === 'medic'
    ? { w: size - 4, h: size - 4, face: 10, top: '#e2dccb', side: '#b9b19c' }
    : { w: size - 2, h: size - 8, face: 10, top: OLIVE, side: OLIVE_DARK };
  boxBody(ctx, cx, cy, b, hp);
  const x = cx - b.w / 2, y = cy - b.h / 2;
  if (kind === 'medic') {
    cross(ctx, cx, cy, 7, HEAL);
    ctx.fillStyle = INK; ctx.fillRect(x + b.w / 2 - 1, y + b.h + 3, 2, 5);
  } else {
    // Bone stencilled rounds across the lid and an orange latch on the front.
    ctx.fillStyle = BONE;
    for (let i = 0; i < 3; i++) { ctx.fillRect(x + 7 + i * 8, y + 7, 4, 10); ctx.beginPath(); ctx.arc(x + 9 + i * 8, y + 7, 2, Math.PI, 0); ctx.fill(); }
    ctx.fillStyle = SIGNAL; ctx.fillRect(cx - 4, y + b.h + 2, 8, 5);
    ctx.lineWidth = 1.2; ctx.strokeStyle = INK; ctx.strokeRect(cx - 4, y + b.h + 2, 8, 5);
  }
  specular(ctx, x + 5, y + 4);
}

/** The pack a shattered cabinet leaves: bobbing on the floor with a ring that says it can be taken. */
function packBody(ctx: CanvasRenderingContext2D, kind: 'medic' | 'ammo', cx: number, cy: number, id: number, now: number) {
  const bob = Math.sin(now / 320 + id) * 2;
  const ring = kind === 'medic' ? HEAL : AMBER;
  ctx.save();
  ctx.strokeStyle = ring;
  ctx.globalAlpha = 0.5 + 0.3 * Math.sin(now / 260 + id);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, PROP_FX[kind].pickR - 6 + 2 * Math.sin(now / 260 + id), 0, TAU);
  ctx.stroke();
  ctx.restore();
  // Shards of the cabinet scattered round it.
  const rand = seeded(id * 7 + 3);
  ctx.fillStyle = kind === 'medic' ? '#e2dccb' : OLIVE_DARK;
  for (let i = 0; i < 6; i++) { const a = rand() * TAU, d = 18 + rand() * 10; ctx.fillRect(cx + Math.cos(a) * d - 2, cy + 6 + Math.sin(a) * d * 0.7 - 1.5, 4 + rand() * 3, 3); }
  contact(ctx, cx, cy + 10, 11, 5, 0, 0);
  const b: Box = { w: 22, h: 14, face: 7, top: kind === 'medic' ? '#e2dccb' : OLIVE, side: kind === 'medic' ? '#b9b19c' : OLIVE_DARK };
  boxBody(ctx, cx, cy + bob - 2, b, 10);
  if (kind === 'medic') cross(ctx, cx, cy + bob - 2, 4.6, HEAL);
  else { ctx.fillStyle = BONE; for (let i = 0; i < 3; i++) ctx.fillRect(cx - 7 + i * 5.5, cy + bob - 7, 3, 7); }
}

// ---------------------------------------------------------------------------------------------------------------- the ground pass

const splatPath = (ctx: CanvasRenderingContext2D, s: Splat) => {
  const rand = seeded(s.seed);
  ctx.beginPath();
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * TAU, r = (i % 2 ? 27 : 38) * (0.8 + rand() * 0.35);
    const px = s.x + Math.cos(a) * r, py = s.y + 4 + Math.sin(a) * r * 0.8;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  for (let i = 0; i < 5; i++) { const a = rand() * TAU, d = 46 + rand() * 30, r = 3 + rand() * 4; ctx.moveTo(s.x + Math.cos(a) * d + r, s.y + Math.sin(a) * d * 0.8); ctx.arc(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d * 0.8, r, 0, TAU); }
};

const shown = (q: PropView) => q[4] !== 0 || PROP_KINDS[q[1]] !== 'propane';

/** Paint splats, contact and cast shadows, and the props themselves: laid after the solids and before any body, so a player at a prop's foot stands in front of it. */
export function drawProps(ctx: CanvasRenderingContext2D, snap: Pick<Snapshot, 'props' | 'match' | 'events' | 'packs'>, now: number, view: View) {
  if (mem.map !== snap.match.map) { resetPropFx(); mem.map = snap.match.map; }
  mem.splats = mem.splats.filter((s) => now - s.born < SPLAT_MS);
  for (const s of mem.splats) {
    if (!visible(view, s.x, s.y, 90)) continue;
    ctx.globalAlpha = 0.55 * clamp01((SPLAT_MS - (now - s.born)) / 12_000);
    ctx.fillStyle = s.color;
    splatPath(ctx, s);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const list = (snap.props ?? []).filter((q) => visible(view, q[2], q[3], 90));
  for (const q of list) {
    const kind = PROP_KINDS[q[1]]!, x = q[2], y = q[3];
    if (kind === 'propane' && q[4] === 0) continue;
    if ((kind === 'medic' || kind === 'ammo') && q[4] === 11) continue;
    const tank = TANKS[kind];
    if (tank) contact(ctx, x, y + tank.face, tank.r + 2, tank.r * 0.7, 24 * (kind === 'propane' ? 1.8 : 1.2), tank.r * 1.9);
    else if (kind === 'lamp') contact(ctx, x, y + 6, 10, 5, 70, 8);
    else contact(ctx, x, y + PROPS[kind].size / 2 + 8, PROPS[kind].size / 2 + 1, 9, 30, PROPS[kind].size * 0.8);
  }
  for (const q of list) {
    const kind = PROP_KINDS[q[1]]!, id = q[0], x = q[2], y = q[3], hp = q[4];
    if (kind === 'propane' && hp === 0) continue;
    if (TANKS[kind]) tankBody(ctx, kind, x, y, hp, id, now, kind === 'paint' ? COLORS[(['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const)[id % 6]!] : undefined);
    else if (kind === 'generator') { generatorBody(ctx, x, y, hp === 0 ? 5 : hp); if (hp === 0) shortFlash(ctx, x, y, now); }
    else if (kind === 'lamp') lampBase(ctx, x, y, hp);
    else if (kind === 'medic' || kind === 'ammo') { if (hp === 11) packBody(ctx, kind, x, y, id, now); else cabinetBody(ctx, kind, x, y, hp); }
  }
  for (const k of snap.packs ?? []) if (visible(view, k[1], k[2], 60)) armorPackBody(ctx, k, now);
}

/**
 * An armor pack on the floor (sim/packs.ts): a gunmetal plate carrier with a steel-blue plate and a bone shield stencil, bobbing over its
 * contact shadow inside a pulsing steel ring the size of its pickup reach, the same toy kit and ring as a cabinet's pack.
 */
function armorPackBody(ctx: CanvasRenderingContext2D, [id, cx, cy]: PackView, now: number) {
  const still = REDUCED ? 0 : 1;
  const bob = Math.sin(now / 320 + id) * 2 * still;
  ctx.save();
  ctx.strokeStyle = STEEL;
  ctx.globalAlpha = 0.5 + 0.3 * Math.sin(now / 260 + id) * still;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, ARMOR_PACK.pickR - 6 + 2 * Math.sin(now / 260 + id) * still, 0, TAU);
  ctx.stroke();
  ctx.restore();
  contact(ctx, cx, cy + 10, 13, 5, 0, 0);
  const y = cy + bob - 3;
  // The carrier: shoulder straps over a vest body, one front face hanging below.
  boxBody(ctx, cx, y, { w: 26, h: 18, face: 6, top: GUNMETAL, side: GUNMETAL_DARK }, 10);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = INK;
  ctx.fillStyle = GUNMETAL_DARK;
  for (const sx of [-8, 5]) { rrect(ctx, cx + sx, y - 13, 4, 6, 1.5); ctx.fill(); ctx.stroke(); }
  // The plate, with its shield stencil.
  ctx.beginPath();
  ctx.moveTo(cx, y - 7); ctx.lineTo(cx + 7, y - 5); ctx.lineTo(cx + 6.4, y + 1.5); ctx.quadraticCurveTo(cx + 5, y + 6, cx, y + 8);
  ctx.quadraticCurveTo(cx - 5, y + 6, cx - 6.4, y + 1.5); ctx.lineTo(cx - 7, y - 5); ctx.closePath();
  ctx.fillStyle = STEEL;
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = STEEL_DARK;
  ctx.fillRect(cx + 1, y - 5, 4.6, 11);
  ctx.fillStyle = BONE;
  ctx.fillRect(cx - 0.8, y - 4.5, 1.6, 10);
  ctx.restore();
  specular(ctx, cx - 9, y - 5);
}

/** A generator that has just shorted flickers white along its edge. */
function shortFlash(ctx: CanvasRenderingContext2D, x: number, y: number, now: number) {
  if (Math.floor(now / 60) % 2 === 0) return;
  ctx.fillStyle = 'rgba(191, 230, 255, 0.4)';
  const h = PROPS.generator.size / 2;
  ctx.fillRect(x - h, y - h, 2 * h, 2 * h - 6);
}

function lampBase(ctx: CanvasRenderingContext2D, x: number, y: number, hp: number) {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  capsule(ctx, x, y, 9, 5);
  ctx.fillStyle = GUNMETAL_DARK;
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, TAU);
  ctx.fillStyle = GUNMETAL;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = HIGHLIGHT;
  ctx.fillRect(x - 9, y - 9, 9, 18);
  ctx.fillStyle = SHADE;
  ctx.fillRect(x + 3, y - 9, 9, 18);
  ctx.restore();
  ctx.stroke();
  if (hp <= 5) { ctx.fillStyle = 'rgba(28, 31, 38, 0.82)'; ctx.fillRect(x + 1, y + 1, 4, 3); }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------------------------- tall and airborne things

const POLE = 52;

function lampPole(ctx: CanvasRenderingContext2D, q: PropView, now: number) {
  const [id, , x, y, state] = q;
  const lit = lampLit(q, now);
  const top = y - POLE;
  ctx.save();
  ctx.lineCap = 'round';
  // The pole: an ink-outlined bar with a lit edge.
  ctx.strokeStyle = INK;
  ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, top); ctx.stroke();
  ctx.strokeStyle = GUNMETAL;
  ctx.lineWidth = 3.4;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, top); ctx.stroke();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(x - 1, y - 2); ctx.lineTo(x - 1, top); ctx.stroke();
  // The arm and the head.
  ctx.strokeStyle = INK;
  ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x + 9, top - 4); ctx.stroke();
  ctx.strokeStyle = GUNMETAL;
  ctx.lineWidth = 2.6;
  ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x + 9, top - 4); ctx.stroke();
  const hx = x + 9, hy = top - 5;
  rrect(ctx, hx - 8, hy - 3, 16, 9, 3);
  ctx.fillStyle = GUNMETAL_DARK;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.stroke();
  // The bulb: a lamp amber pip that lights its pool, or broken glass.
  if (state === 11 && lit === 0) {
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.moveTo(hx - 5, hy + 6); ctx.lineTo(hx - 2, hy + 9); ctx.lineTo(hx, hy + 6); ctx.lineTo(hx + 3, hy + 10); ctx.lineTo(hx + 5, hy + 6); ctx.closePath(); ctx.fill();
    // Sparks drop from the stump.
    const rand = seeded(Math.floor(now / 140) * 977 + id);
    ctx.fillStyle = SPARK;
    for (let i = 0; i < 3; i++) { const t = ((now + i * 220) % 700) / 700; if (rand() < 0.7) ctx.fillRect(hx + (rand() - 0.5) * 12 - 1, hy + 8 + t * 26, 2.2, 2.2); }
  } else if (lit === 0) {
    ctx.fillStyle = '#6a6458';
    ctx.beginPath(); ctx.ellipse(hx, hy + 7, 5.5, 3.2, 0, 0, TAU); ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = INK; ctx.stroke();
  } else {
    ctx.fillStyle = lit < 1 ? '#c9a04e' : '#ffe08a';
    ctx.beginPath(); ctx.ellipse(hx, hy + 7, 5.5, 3.2, 0, 0, TAU); ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = INK; ctx.stroke();
    specular(ctx, hx - 2, hy + 6);
  }
  ctx.restore();
}

/** The rocketing tank: spun by the distance it has flown, its jet streaming behind. */
function flyingTank(ctx: CanvasRenderingContext2D, q: PropView, now: number) {
  const [id, , x, y] = q;
  const was = mem.last.get(id);
  mem.last.set(id, { x, y });
  const dx = was ? x - was.x : 1, dy = was ? y - was.y : 0;
  const heading = dx === 0 && dy === 0 ? 0 : Math.atan2(dy, dx);
  const spin = (x + y) / 14;
  const L = TANKS.propane!;
  // The jet: a flame cone out of the back, flickering at fire speed.
  const flick = 0.75 + 0.25 * Math.sin(now / 30 + id);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading);
  for (const [len, w, c] of [[110, 20, '#d9541f'], [78, 14, '#ff9a3c'], [46, 8, '#ffe08a']] as const) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(-14, -w * 0.5); ctx.quadraticCurveTo(-14 - len * flick * 0.6, -w * 0.9, -14 - len * flick, 0); ctx.quadraticCurveTo(-14 - len * flick * 0.6, w * 0.9, -14, w * 0.5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // Smoke trails off behind.
  ctx.fillStyle = SMOKE;
  for (let i = 1; i <= 4; i++) { ctx.globalAlpha = 0.4 - i * 0.07; ctx.beginPath(); ctx.arc(x - Math.cos(heading) * (24 + i * 16), y - Math.sin(heading) * (24 + i * 16), 5 + i * 2, 0, TAU); ctx.fill(); }
  ctx.globalAlpha = 1;
  contact(ctx, x, y + 8, 14, 5, 0, 0);
  // The body tumbles end over end: a squashed capsule seen from above, banded.
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading + Math.sin(spin) * 0.35);
  const squash = 0.55 + 0.45 * Math.abs(Math.cos(spin));
  ctx.scale(1, squash);
  rrect(ctx, -18, -L.r, 36, 2 * L.r, 11);
  ctx.fillStyle = L.top;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = L.band;
  ctx.fillRect(-4, -L.r, 8, 2 * L.r);
  ctx.fillStyle = HIGHLIGHT;
  ctx.fillRect(-18, -L.r, 36, L.r * 0.5);
  ctx.fillStyle = SHADE;
  ctx.fillRect(-18, L.r * 0.5, 36, L.r);
  ctx.restore();
  ctx.lineWidth = 2 / squash;
  ctx.strokeStyle = INK;
  rrect(ctx, -18, -L.r, 36, 2 * L.r, 11);
  ctx.stroke();
  ctx.restore();
  specular(ctx, x - 4, y - 5);
}

/** Arcs leaping off a shorted generator, jagged and re-rolled at ~16 Hz. */
function generatorArcs(ctx: CanvasRenderingContext2D, q: PropView, now: number) {
  const [id, , x, y] = q;
  const rand = seeded(Math.floor(now / 60) * 7919 + id);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let i = 0; i < 5; i++) {
    let px = x + (rand() - 0.5) * 16, py = y - 6 + (rand() - 0.5) * 10;
    const a = rand() * TAU, len = 34 + rand() * 46;
    ctx.beginPath();
    ctx.moveTo(px, py);
    for (let s = 1; s <= 5; s++) { px = x + Math.cos(a) * len * (s / 5) + (rand() - 0.5) * 14; py = y - 6 + Math.sin(a) * len * (s / 5) * 0.8 + (rand() - 0.5) * 14; ctx.lineTo(px, py); }
    ctx.strokeStyle = EMP;
    ctx.lineWidth = 5;
    ctx.globalAlpha = 0.6;
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.globalAlpha = 1;
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------------------------- bursts

function drawBurst(ctx: CanvasRenderingContext2D, b: Burst, now: number) {
  const life = BURST_MS[b.k], age = now - b.born, t = clamp01(age / life), rand = seeded(b.seed);
  ctx.save();
  if (b.k === 'emp') {
    // A cold shockwave sweeping out to the reach of the pulse, then crackling sparks along it.
    const r = b.r * ease(t / 0.55);
    ctx.globalAlpha = (1 - t) * 0.14;
    ctx.fillStyle = EMP;
    ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, TAU); ctx.fill();
    ctx.globalAlpha = (1 - t) * 0.9;
    ctx.strokeStyle = EMP;
    ctx.lineWidth = 5 * (1 - t) + 1.5;
    ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, TAU); ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(b.x, b.y, r * 0.96, 0, TAU); ctx.stroke();
    ctx.fillStyle = SPARK;
    for (let i = 0; i < 18; i++) { const a = rand() * TAU; ctx.fillRect(b.x + Math.cos(a) * r - 1.2, b.y + Math.sin(a) * r * 0.9 - 1.2, 2.6, 2.6); }
  } else if (b.k === 'launch') {
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = BONE;
    for (let i = 0; i < 8; i++) { const a = b.a + Math.PI + (rand() - 0.5) * 1.4, d = ease(t) * (30 + rand() * 40); ctx.beginPath(); ctx.arc(b.x + Math.cos(a) * d, b.y + Math.sin(a) * d, 3 + rand() * 5 * t, 0, TAU); ctx.fill(); }
  } else if (b.k === 'pick' || b.k === 'relight') {
    const mint = b.kind === 'medic', c = b.kind === 'lamp' ? SPARK : mint ? HEAL : b.kind === 'armor' ? STEEL : AMBER;
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = c;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(b.x, b.y - (b.kind === 'lamp' ? POLE : 0), 10 + 30 * ease(t), 0, TAU); ctx.stroke();
    ctx.fillStyle = c;
    for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU + rand(); const d = 14 + 26 * ease(t); ctx.fillRect(b.x + Math.cos(a) * d - 1.5, b.y - (b.kind === 'lamp' ? POLE : 0) + Math.sin(a) * d - 1.5 - 14 * t, 3, 3); }
  } else if (b.kind === 'gas') {
    ctx.globalAlpha = (1 - t) * 0.7;
    ctx.fillStyle = '#c1d84a';
    for (let i = 0; i < 9; i++) { const a = rand() * TAU, d = ease(t) * (20 + rand() * 60); ctx.beginPath(); ctx.arc(b.x + Math.cos(a) * d, b.y + Math.sin(a) * d * 0.8, 10 + rand() * 12 * t, 0, TAU); ctx.fill(); }
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = OLIVE;
    for (let i = 0; i < 5; i++) { const a = rand() * TAU, d = ease(t) * (30 + rand() * 40); ctx.fillRect(b.x + Math.cos(a) * d - 2, b.y + Math.sin(a) * d - 2 - t * 10, 4, 3); }
  } else if (b.kind === 'oil') {
    // A fireball over a black splash.
    ctx.globalAlpha = 0.5 * (1 - t);
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.ellipse(b.x, b.y + 6, 24 + 40 * ease(t), 14 + 24 * ease(t), 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1 - t;
    for (const [rr, c] of [[1, '#d9541f'], [0.66, '#ff9a3c'], [0.36, '#ffe08a']] as const) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(b.x, b.y - 10 * ease(t), (14 + 34 * ease(t)) * rr * (1 - t * 0.4), 0, TAU); ctx.fill(); }
    ctx.fillStyle = SMOKE;
    for (let i = 0; i < 4; i++) { ctx.globalAlpha = (1 - t) * 0.5; ctx.beginPath(); ctx.arc(b.x + (rand() - 0.5) * 30, b.y - 20 - t * (30 + rand() * 20), 8 + t * 10, 0, TAU); ctx.fill(); }
  } else if (b.kind === 'paint') {
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = b.color;
    for (let i = 0; i < 12; i++) { const a = rand() * TAU, d = ease(t * 1.6) * (20 + rand() * 60); ctx.beginPath(); ctx.arc(b.x + Math.cos(a) * d, b.y + Math.sin(a) * d * 0.8 - 12 * Math.sin(t * Math.PI), 2 + rand() * 3, 0, TAU); ctx.fill(); }
  } else {
    // Glass or metal shards flying out, with sparks for a lamp.
    const top = b.kind === 'lamp' ? b.y - POLE : b.y;
    ctx.globalAlpha = 1 - t * t;
    ctx.fillStyle = b.kind === 'lamp' ? '#d6ecf2' : b.kind === 'medic' ? '#e2dccb' : OLIVE;
    for (let i = 0; i < 10; i++) { const a = rand() * TAU, d = ease(t) * (16 + rand() * 40); ctx.save(); ctx.translate(b.x + Math.cos(a) * d, top + Math.sin(a) * d * 0.7 + t * t * 30); ctx.rotate(rand() * TAU + t * 6); ctx.fillRect(-2.5, -1.5, 5, 3); ctx.restore(); }
    ctx.fillStyle = SPARK;
    for (let i = 0; i < 6; i++) { const a = rand() * TAU, d = ease(t) * (10 + rand() * 30); ctx.fillRect(b.x + Math.cos(a) * d - 1.2, top + Math.sin(a) * d * 0.7 + t * 18 - 1.2, 2.4, 2.4); }
  }
  ctx.restore();
}

/** A shocked player: arcs of white-blue skittering over their body. */
function shock(ctx: CanvasRenderingContext2D, x: number, y: number, id: number, now: number) {
  const rand = seeded(Math.floor(now / 70) * 131 + id);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < 4; i++) {
    const a = rand() * TAU;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * 10, y + Math.sin(a) * 10);
    for (let s = 1; s <= 4; s++) { const aa = a + (rand() - 0.5) * 1.4; ctx.lineTo(x + Math.cos(aa) * (10 + s * 8), y + Math.sin(aa) * (10 + s * 8)); }
    ctx.strokeStyle = EMP; ctx.lineWidth = 4; ctx.globalAlpha = 0.65; ctx.stroke();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.6; ctx.globalAlpha = 1; ctx.stroke();
  }
  ctx.restore();
}

/** Lamp poles, tumbling tanks, arcing generators, event bursts and shocked players over the bodies, then the props' light over the floor. */
export function drawPropTops(ctx: CanvasRenderingContext2D, snap: Pick<Snapshot, 'props' | 'thrown' | 'players'>, now: number, view: View) {
  const props = snap.props ?? [];
  const flying = new Set<number>();
  for (const q of props) {
    if (!visible(view, q[2], q[3], 140)) continue;
    const kind = PROP_KINDS[q[1]]!;
    if (kind === 'lamp') lampPole(ctx, q, now);
    else if (kind === 'propane' && q[4] === 0) { flying.add(q[0]); flyingTank(ctx, q, now); }
    else if (kind === 'generator' && q[4] === 0) generatorArcs(ctx, q, now);
  }
  for (const id of mem.last.keys()) if (!flying.has(id)) mem.last.delete(id);
  mem.bursts = mem.bursts.filter((b) => now - b.born < BURST_MS[b.k]);
  for (const b of mem.bursts) if (visible(view, b.x, b.y, b.r + 140)) drawBurst(ctx, b, now);
  for (const p of snap.players) if (p.emp && p.alive && visible(view, p.x, p.y, 60)) shock(ctx, p.x, p.y, p.id, now);
  const lights = propLights(snap, now).filter((l) => visible(view, l.x, l.y, l.r));
  lightSink?.(lights);
  // The GL lighting pass (lightfeed.ts's sink) owns prop light when it runs; the additive pools are only the 2D fallback.
  if (FALLBACK_POOLS && !lightingEnabled()) for (const l of lights) pool(ctx, l);
}

// ---------------------------------------------------------------------------------------------------------------- the burning slick

/** An oil drum's slick: a black puddle with tongues of fire licking up from it, flickering at fire speed and guttering out toward its end. */
export function drawFireSlick(ctx: CanvasRenderingContext2D, t: ThrownView, now: number) {
  const born = mem.slicks.get(t.id) ?? now;
  mem.slicks.set(t.id, born);
  if (mem.slicks.size > 24) for (const k of mem.slicks.keys()) { mem.slicks.delete(k); break; }
  const left = PROP_FX.oil.burnMs - (now - born);
  const burn = clamp01(left / 1000) * clamp01((now - born) / 160 + 0.4);
  const r = t.r;
  const rand = seeded(t.id * 9973 + 5);
  ctx.save();
  ctx.fillStyle = 'rgba(28, 31, 38, 0.6)';
  ctx.beginPath();
  for (let i = 0; i < 28; i++) { const a = (i / 28) * TAU, rr = r * (0.84 + rand() * 0.1); const px = t.x + Math.cos(a) * rr, py = t.y + 4 + Math.sin(a) * rr * 0.8; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
  ctx.closePath();
  ctx.fill();
  const tongues = 22;
  for (let i = 0; i < tongues; i++) {
    const a = rand() * TAU, d = Math.sqrt(rand()) * r * 0.82, ph = rand() * TAU, size = 0.7 + rand() * 0.6;
    const px = t.x + Math.cos(a) * d, py = t.y + Math.sin(a) * d * 0.8;
    const h = (22 + 24 * (0.5 + 0.5 * Math.sin(now / 90 + ph))) * size * burn;
    if (h < 2) continue;
    for (const [k, c] of [[1, '#d9541f'], [0.72, '#ff9a3c'], [0.42, '#ffe08a']] as const) {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(px - 9 * size * k, py);
      ctx.quadraticCurveTo(px - 8 * size * k, py - h * k * 0.6, px + Math.sin(now / 130 + ph) * 3, py - h * k);
      ctx.quadraticCurveTo(px + 8 * size * k, py - h * k * 0.6, px + 9 * size * k, py);
      ctx.closePath();
      ctx.fill();
    }
  }
  // Smoke curls up off the top.
  ctx.fillStyle = SMOKE;
  for (let i = 0; i < 4; i++) { const p = ((now / 1600) + i / 4) % 1; ctx.globalAlpha = (1 - p) * 0.4 * burn; ctx.beginPath(); ctx.arc(t.x + Math.sin(i * 2.1 + p * 4) * r * 0.4, t.y - 18 - p * 54, 8 + p * 12, 0, TAU); ctx.fill(); }
  ctx.restore();
}
