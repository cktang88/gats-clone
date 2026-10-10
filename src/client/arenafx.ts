import { AIRDROP, BARREL } from '../shared/defs.ts';
import { planeAt, type AirdropView, type BarrelView, type Snapshot } from '../shared/protocol.ts';
import { markBlast } from './blastfx.ts';
import { seeded } from './grain.ts';
import { INK } from './palette.ts';
import { LIGHT } from './tilt.ts';

/**
 * The arena's surprises, drawn in the toy-soldier kit (docs/art/STYLE.md): rust explosive barrels with a bold ink outline, two hard cel
 * steps and a hanging front face; a supply plane's crisp shadow crossing the map; a parachute crate floating down on signal-orange silk;
 * and the gold sheen on a golden gun. A barrel's burst is a blast like any other (blastfx.ts, blastdraw.ts); what stays here is the scorch that
 * holds until the barrel stands again.
 */

const TAU = Math.PI * 2;
const RUST = '#a8552e', RUST_FACE = '#7f3d20', RUST_DARK = '#5e2b16';
const BONE = '#ece6d6', AMBER = '#ffb347', SPARK = '#ffd27a', SMOKE = '#5a5550';
const SIGNAL = '#ff5a1f', GOLD = '#ffd34d';
const SHADOW = 'rgba(10, 12, 18, 0.4)', CONTACT = 'rgba(10, 12, 18, 0.42)';
const HIGHLIGHT = 'rgba(255, 255, 255, 0.24)', SHADE = 'rgba(10, 12, 16, 0.3)';

/** A barrel's top is a circle of this radius (its footprint is `BARREL.size` square) and its front face hangs `FACE` below its south edge. */
export const BARREL_LOOK = { r: BARREL.size / 2 - 1, face: 10 } as const;
const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const ease = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

type View = { x0: number; y0: number; x1: number; y1: number };
const visible = (v: View, x: number, y: number, pad: number) => x > v.x0 - pad && x < v.x1 + pad && y > v.y0 - pad && y < v.y1 + pad;

// ---------------------------------------------------------------------------------------------------------------- barrels

type Seen = { x: number; y: number; hp: number; litAt: number | null; hurtAt: number };
type Scorch = { x: number; y: number; seed: number; born: number };
type Mem = { map: string; seen: Map<number, Seen>; scorches: Map<number, Scorch>; landed: Set<number>; dusts: { x: number; y: number; born: number }[] };

const mem: Mem = { map: '', seen: new Map(), scorches: new Map(), landed: new Set(), dusts: [] };
const FLASH_MS = 130;

/** The bits of the client's world this module remembers between frames: which barrels stood, so one that vanishes bursts, and where scorch lies. */
export function resetArenaFx() {
  mem.map = '';
  mem.seen.clear();
  mem.scorches.clear();
  mem.landed.clear();
  mem.dusts.length = 0;
}

function observe(snap: Pick<Snapshot, 'barrels' | 'match'>, now: number) {
  if (mem.map !== snap.match.map) { resetArenaFx(); mem.map = snap.match.map; }
  const here = new Map<number, BarrelView>((snap.barrels ?? []).map((b) => [b[0], b]));
  for (const [id, was] of mem.seen) {
    if (here.has(id)) continue;
    mem.seen.delete(id);
    // The burst itself (flash, fireball, staves, smoke, light) is the blast's: it learns here that a barrel went.
    markBlast('barrel', was.x, was.y, now);
    mem.scorches.set(id, { x: was.x, y: was.y, seed: id, born: now });
  }
  for (const [id, x, y, hp] of here.values()) {
    const was = mem.seen.get(id);
    mem.scorches.delete(id);
    if (!was) { mem.seen.set(id, { x, y, hp, litAt: hp === 0 ? now : null, hurtAt: -Infinity }); continue; }
    if (hp < was.hp) was.hurtAt = now;
    if (hp === 0 && was.litAt === null) was.litAt = now;
    was.hp = hp;
  }
}

function capsule(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, face: number) {
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx - r, cy + face);
  ctx.arc(cx, cy + face, r, Math.PI, 0, true);
  ctx.lineTo(cx + r, cy);
  ctx.arc(cx, cy, r, 0, Math.PI, true);
  ctx.closePath();
}

/** A toy barrel at (`cx`, `cy`): ink outline, hoops and a lid, lit from the top left in two hard steps. `flare` 0..1 washes it toward fire. */
function barrelBody(ctx: CanvasRenderingContext2D, cx: number, cy: number, hp: number, flare: number) {
  const { r, face } = BARREL_LOOK;
  ctx.save();
  capsule(ctx, cx, cy, r, face);
  ctx.fillStyle = RUST_FACE;
  ctx.fill();
  ctx.save();
  ctx.clip();
  // The front face's two cel steps: a lit edge on the left, a shade on the right, both hard.
  ctx.fillStyle = HIGHLIGHT;
  ctx.fillRect(cx - r, cy, r * 0.5, face + r);
  ctx.fillStyle = SHADE;
  ctx.fillRect(cx + r * 0.42, cy, r, face + r);
  // Two bone hoops following the barrel's round foot, each edged in ink.
  for (const [a, b] of [[face * 0.18, face * 0.46], [face * 0.62, face * 0.9]] as const) {
    ctx.beginPath();
    ctx.arc(cx, cy + a, r + 2, 0, Math.PI);
    ctx.arc(cx, cy + b, r + 2, Math.PI, 0, true);
    ctx.closePath();
    ctx.fillStyle = '#c9bfa6';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }
  // Dents and a split seam as the barrel is shot: pits and cutouts, never hairlines.
  if (hp <= 7 && hp > 0) { ctx.fillStyle = 'rgba(28, 31, 38, 0.8)'; ctx.fillRect(cx - r * 0.55, cy + face * 0.3, 5, 4); }
  if (hp <= 4 && hp > 0) { ctx.fillStyle = 'rgba(28, 31, 38, 0.8)'; ctx.fillRect(cx + r * 0.2, cy + face * 0.7, 6, 4); ctx.fillRect(cx - r * 0.1, cy + face * 0.5, 4, 4); }
  ctx.restore();
  capsule(ctx, cx, cy, r, face);
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK;
  ctx.stroke();

  // The lid: the top face is the footprint, so it is a plain circle with a rolled rim.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fillStyle = flare > 0.5 ? '#ffe08a' : RUST;
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
  ctx.beginPath();
  ctx.arc(cx, cy, r - 4.5, 0, TAU);
  ctx.fillStyle = flare > 0.5 ? '#ffb347' : RUST_DARK;
  ctx.globalAlpha = 0.9;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = INK;
  ctx.stroke();
  // A flame stencil on the lid says what is inside.
  ctx.fillStyle = flare > 0.5 ? RUST_DARK : AMBER;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 6.5);
  ctx.quadraticCurveTo(cx + 5.6, cy - 1.2, cx + 3.4, cy + 3.6);
  ctx.quadraticCurveTo(cx, cy + 6.2, cx - 3.4, cy + 3.6);
  ctx.quadraticCurveTo(cx - 5, cy - 0.4, cx - 1.4, cy - 2.4);
  ctx.quadraticCurveTo(cx - 1.2, cy - 4.4, cx, cy - 6.5);
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // One specular dot on the lit side of the rim.
  ctx.beginPath();
  ctx.arc(cx - r * 0.55, cy - r * 0.55, 2.2, 0, TAU);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.restore();
}

/** The cast shadow, falling down and to the right with every other shadow, and the tight contact shadow at the foot. */
function barrelShadow(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  const { r, face } = BARREL_LOOK;
  const len = 24 * 2.6;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = SHADOW;
  ctx.lineWidth = r * 1.9;
  ctx.beginPath();
  ctx.moveTo(cx, cy + face);
  ctx.lineTo(cx + LIGHT.x * len, cy + face + LIGHT.y * len);
  ctx.stroke();
  ctx.fillStyle = CONTACT;
  ctx.beginPath();
  ctx.ellipse(cx, cy + face + 2, r + 2, r * 0.7, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

const SCORCH_MS = BARREL.respawnMs;

/** Burnt pads where barrels stood: one flat char each, fading over the barrel's wait, so a fought-over spot tells its story and then clears. */
function scorchMarks(ctx: CanvasRenderingContext2D, list: readonly Scorch[], now: number) {
  for (const s of list) {
    const rand = seeded(s.seed);
    ctx.fillStyle = `rgba(6, 6, 8, ${0.6 * clamp01(1 - (now - s.born) / SCORCH_MS)})`;
    ctx.beginPath();
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * TAU, r = 26 + rand() * 12;
      const px = s.x + Math.cos(a) * r, py = s.y + 6 + Math.sin(a) * r * 0.85;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }
}

/** Wisps and sparks leaking from a barrel that has taken a hit, stateless on the clock so there is nothing to keep. */
function hiss(ctx: CanvasRenderingContext2D, cx: number, cy: number, hp: number, id: number, now: number) {
  const { r } = BARREL_LOOK;
  const lit = hp === 0;
  const puffs = lit ? 4 : 2;
  const period = lit ? 520 : 900;
  for (let i = 0; i < puffs; i++) {
    const t = ((now + id * 137 + i * (period / puffs)) % period) / period;
    const px = cx + r * 0.5 + Math.sin(t * 5 + i) * 3, py = cy - r * 0.2 - t * 26;
    ctx.globalAlpha = (1 - t) * (lit ? 0.7 : 0.5);
    ctx.fillStyle = SMOKE;
    ctx.beginPath();
    ctx.arc(px, py, 2.5 + t * 5, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (!lit && hp > 5) return;
  // Sparks spit from the seam, a quick flicker, as a fuse does.
  const flick = Math.floor((now + id * 31) / 70);
  const rand = seeded(flick * 977 + id);
  ctx.fillStyle = SPARK;
  for (let i = 0; i < (lit ? 4 : 2); i++) {
    const a = -Math.PI / 2 + (rand() - 0.5) * 2.2, d = 5 + rand() * 12;
    ctx.fillRect(cx + r * 0.5 + Math.cos(a) * d - 1.2, cy - r * 0.2 + Math.sin(a) * d - 1.2, 2.4, 2.4);
  }
}

/** A warm pool on the floor from a lit thing: additive amber, so at night it is the light. */
function pool(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number, core = '#ffe08a') {
  if (alpha <= 0.01) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, core);
  g.addColorStop(0.35, AMBER);
  g.addColorStop(1, 'rgba(255, 150, 60, 0)');
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** Scorch, shadows and the barrels themselves: laid after the solids and before any body, so a player at a barrel's foot stands in front of it. */
export function drawBarrels(ctx: CanvasRenderingContext2D, snap: Pick<Snapshot, 'barrels' | 'match'>, now: number, view: View) {
  observe(snap, now);
  scorchMarks(ctx, [...mem.scorches.values()].filter((s) => visible(view, s.x, s.y, 60)), now);
  const list = (snap.barrels ?? []).filter((b) => visible(view, b[1], b[2], 80));
  for (const [, x, y] of list) barrelShadow(ctx, x, y);
  for (const [id, x, y, hp] of list) {
    const was = mem.seen.get(id);
    const lit = hp === 0;
    const litFor = lit && was?.litAt != null ? now - was.litAt : 0;
    // Anticipation: a lit barrel swells and shudders, and flashes between rust and white-hot at 4 Hz.
    const flare = lit && Math.floor(now / 125) % 2 === 0 ? 1 : 0;
    const swell = lit && !REDUCED ? 1 + 0.07 * Math.min(1, litFor / 250) : 1;
    const hit = was ? clamp01(1 - (now - was.hurtAt) / FLASH_MS) : 0;
    ctx.save();
    ctx.translate(x, y + BARREL_LOOK.face + BARREL_LOOK.r);
    if (lit && !REDUCED) ctx.translate((Math.sin(now / 22) * 0.8), 0);
    ctx.scale(swell, 2 - swell);
    ctx.translate(-x, -(y + BARREL_LOOK.face + BARREL_LOOK.r));
    barrelBody(ctx, x, y, hp, flare);
    if (hit > 0 && !lit) {
      ctx.globalAlpha = hit * 0.7;
      ctx.fillStyle = BONE;
      ctx.beginPath();
      ctx.arc(x, y, BARREL_LOOK.r - 1, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    if (hp < 10) hiss(ctx, x, y, hp, id, now);
  }
}

/** The warm light of every lit barrel, over the floor (a burst is the blast's, in blastdraw.ts). */
export function drawArenaLight(ctx: CanvasRenderingContext2D, snap: Pick<Snapshot, 'barrels'>, now: number, view: View) {
  for (const [id, x, y, hp] of snap.barrels ?? []) {
    if (hp !== 0 || !visible(view, x, y, 160)) continue;
    const was = mem.seen.get(id);
    const t = clamp01(((was?.litAt != null ? now - was.litAt : 0)) / BARREL.fuseMs);
    pool(ctx, x, y, 84 + 40 * t, 0.2 + 0.4 * t * (0.7 + 0.3 * Math.sin(now / 40)));
  }
  mem.dusts = mem.dusts.filter((d) => now - d.born < 700);
  for (const d of mem.dusts) if (visible(view, d.x, d.y, 160)) drawDust(ctx, d, now);
}

function drawDust(ctx: CanvasRenderingContext2D, d: { x: number; y: number; born: number }, now: number) {
  const t = clamp01((now - d.born) / 700);
  ctx.save();
  ctx.globalAlpha = (1 - t) * 0.55;
  ctx.fillStyle = '#d9d2bf';
  const rand = seeded(Math.round(d.x * 3 + d.y));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + rand(), dist = 18 + ease(t) * (30 + rand() * 30);
    ctx.beginPath();
    ctx.arc(d.x + Math.cos(a) * dist, d.y + Math.sin(a) * dist * 0.7, 7 + 6 * t, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------------------------- airdrops

/** How high the crate hangs above the ground when it is first cut loose, in world px. */
const ALTITUDE = 560;
const CANOPY_W = 118, CANOPY_H = 54;

/** A toy cargo plane seen from straight above, nose along +x, as one silhouette. */
function planePath(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  ctx.moveTo(110, 0);
  ctx.quadraticCurveTo(100, -15, 60, -16);
  ctx.lineTo(24, -16);
  ctx.lineTo(-6, -104); ctx.lineTo(-32, -104); ctx.lineTo(-22, -16);
  ctx.lineTo(-84, -14);
  ctx.lineTo(-100, -50); ctx.lineTo(-116, -50); ctx.lineTo(-112, 0);
  ctx.lineTo(-116, 50); ctx.lineTo(-100, 50); ctx.lineTo(-84, 14);
  ctx.lineTo(-22, 16);
  ctx.lineTo(-32, 104); ctx.lineTo(-6, 104); ctx.lineTo(24, 16);
  ctx.lineTo(60, 16);
  ctx.quadraticCurveTo(100, 15, 110, 0);
  ctx.closePath();
}

/** The supply plane's shadow, crossing the map: crisp, falling down and to the right like every shadow, and a little propwash behind it. */
export function drawPlaneShadow(ctx: CanvasRenderingContext2D, air: AirdropView | null | undefined, serverNow: number | null, view: View) {
  if (!air || serverNow === null) return;
  const p = planeAt(air, serverNow);
  const x = p.x + LIGHT.x * 150, y = p.y + LIGHT.y * 150;
  if (!visible(view, x, y, 300)) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(air.a);
  planePath(ctx);
  ctx.fillStyle = 'rgba(10, 12, 18, 0.42)';
  ctx.fill();
  // Two propeller discs, faint and hard-edged.
  ctx.fillStyle = 'rgba(20, 24, 32, 0.12)';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(70, side * 56, 5, 22, 0, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function silk(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number, sway: number) {
  const gores = 5;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(sway);
  ctx.beginPath();
  ctx.moveTo(-w / 2, 0);
  ctx.quadraticCurveTo(-w / 2, -h * 1.25, 0, -h * 1.25);
  ctx.quadraticCurveTo(w / 2, -h * 1.25, w / 2, 0);
  ctx.closePath();
  ctx.save();
  ctx.clip();
  for (let i = 0; i < gores; i++) {
    ctx.fillStyle = i % 2 === 0 ? SIGNAL : BONE;
    ctx.fillRect(-w / 2 + (w / gores) * i, -h * 1.4, w / gores + 0.5, h * 1.5);
  }
  ctx.fillStyle = HIGHLIGHT;
  ctx.fillRect(-w / 2, -h * 1.4, w * 0.22, h * 1.5);
  ctx.fillStyle = SHADE;
  ctx.fillRect(w * 0.24, -h * 1.4, w, h * 1.5);
  ctx.restore();
  // The scalloped hem, a bite out of each gore.
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.beginPath();
  ctx.moveTo(-w / 2, 0);
  ctx.quadraticCurveTo(-w / 2, -h * 1.25, 0, -h * 1.25);
  ctx.quadraticCurveTo(w / 2, -h * 1.25, w / 2, 0);
  for (let i = gores - 1; i >= 0; i--) ctx.quadraticCurveTo(-w / 2 + (w / gores) * (i + 0.5), h * 0.28, -w / 2 + (w / gores) * i, 0);
  ctx.closePath();
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-w * 0.2, -h * 0.95, 2.4, 0, TAU);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fill();
  ctx.restore();
}

/** The airborne crate: olive steel with an orange band, drawn as the landed crate is (top face and a front face), on its chute. */
function floatingCrate(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const face = 13, h = size / 2;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.fillStyle = '#454f31';
  ctx.fillRect(x - h, y + h - 2, size, face);
  ctx.fillStyle = SHADE;
  ctx.fillRect(x + h * 0.4, y + h - 2, h * 0.6, face);
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.strokeRect(x - h, y + h - 2, size, face);
  ctx.fillStyle = '#59653f';
  ctx.fillRect(x - h, y - h, size, size);
  ctx.fillStyle = HIGHLIGHT;
  ctx.fillRect(x - h, y - h, size * 0.5, 5);
  ctx.fillRect(x - h, y - h, 5, size * 0.5);
  ctx.fillStyle = SHADE;
  ctx.fillRect(x - h, y + h - 5, size, 5);
  ctx.fillStyle = SIGNAL;
  ctx.fillRect(x - h + 5, y - 4, size - 10, 8);
  ctx.fillStyle = '#2a2d33';
  for (const f of [0.3, 0.7]) ctx.fillRect(x - h + size * f - 4, y - h + 2, 8, 6);
  ctx.strokeRect(x - h, y - h, size, size);
  ctx.beginPath();
  ctx.arc(x - h + 8, y - h + 8, 2, 0, TAU);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fill();
  ctx.restore();
}

/**
 * The crate on its parachute, from the moment the plane cuts it loose until it lands: the silk snaps open, the crate sways and eases
 * down, its shadow tightening on the ground as it nears, and a puff of dust on touchdown. Drawn over everything, since it is in the air.
 */
export function drawParachute(ctx: CanvasRenderingContext2D, air: AirdropView | null | undefined, serverNow: number | null, now: number, view: View) {
  if (!air || serverNow === null) return;
  const t = (serverNow - air.dropAt) / AIRDROP.fallMs;
  if (t < 0) return;
  if (t >= 1) {
    if (!mem.landed.has(air.landAt)) { mem.landed.add(air.landAt); mem.dusts.push({ x: air.x, y: air.y, born: now }); }
    return;
  }
  if (!visible(view, air.x, air.y - ALTITUDE, 300)) return;
  const alt = ALTITUDE * (1 - t) ** 1.7;
  const sway = Math.sin(serverNow / 520) * Math.min(1, alt / 120) * 0.16;
  const swing = Math.sin(serverNow / 520) * 22 * (alt / ALTITUDE);
  const x = air.x + swing, y = air.y - alt;
  // Its shadow on the ground, small and faint from far up and growing crisp as it lands.
  const near = 1 - alt / ALTITUDE;
  ctx.save();
  ctx.fillStyle = `rgba(20, 24, 32, ${0.14 + 0.18 * near})`;
  ctx.fillRect(air.x - AIRDROP.size / 2 + LIGHT.x * alt * 0.12, air.y - AIRDROP.size / 2 + LIGHT.y * alt * 0.12, AIRDROP.size, AIRDROP.size);
  ctx.restore();
  // Silk snaps open with a little overshoot.
  const open = t < 0.08 ? 0.15 + 0.85 * (1 + 2.7 * (t / 0.08 - 1) ** 3 + 1.7 * (t / 0.08 - 1) ** 2) : 1;
  const top = y - AIRDROP.size / 2 - 64 * open;
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = INK;
  const spread = (CANOPY_W / 2) * open;
  ctx.beginPath();
  for (const f of [-1, -0.34, 0.34, 1]) {
    ctx.moveTo(x + f * spread * 0.95 + Math.sin(sway) * 4, top);
    ctx.lineTo(x + f * (AIRDROP.size / 2 - 4), y - AIRDROP.size / 2);
  }
  ctx.stroke();
  ctx.restore();
  floatingCrate(ctx, x, y, AIRDROP.size);
  silk(ctx, x + Math.sin(sway) * 4, top, CANOPY_W * open, CANOPY_H * open, sway);
}

/** Beacon brackets, pulsing slowly in signal orange around the landed crate: what you can act on. */
export function drawBeacon(ctx: CanvasRenderingContext2D, air: AirdropView | null | undefined, serverNow: number | null, now: number, view: View) {
  if (!air || serverNow === null || serverNow < air.landAt || !visible(view, air.x, air.y, 120)) return;
  const pulse = 0.5 + 0.5 * Math.sin(now / 300);
  const h = AIRDROP.size / 2 + 9 + 3 * pulse, len = 13;
  ctx.save();
  ctx.strokeStyle = SIGNAL;
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'square';
  ctx.globalAlpha = 0.65 + 0.35 * pulse;
  ctx.beginPath();
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    ctx.moveTo(air.x + sx * h, air.y + sy * (h - len));
    ctx.lineTo(air.x + sx * h, air.y + sy * h);
    ctx.lineTo(air.x + sx * (h - len), air.y + sy * h);
  }
  ctx.stroke();
  ctx.restore();
  pool(ctx, air.x, air.y, 110, 0.12 + 0.08 * pulse, '#ffd9a8');
}

// ---------------------------------------------------------------------------------------------------------------- gold

/** A glint that crosses a golden gun's muzzle every couple of seconds, and a few gold motes drifting off the player: gold means reward. */
export function drawGoldShine(ctx: CanvasRenderingContext2D, x: number, y: number, tip: { x: number; y: number }, id: number, now: number) {
  const period = 1900;
  const t = ((now + id * 311) % period) / 260;
  ctx.save();
  if (t < 1 && !REDUCED) {
    const k = Math.sin(t * Math.PI);
    ctx.translate(tip.x - 6, tip.y - 2);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#fff4c2';
    ctx.beginPath();
    const r = 11 * k, w = 2.4 * k;
    ctx.moveTo(0, -r); ctx.lineTo(w, -w); ctx.lineTo(r, 0); ctx.lineTo(w, w); ctx.lineTo(0, r); ctx.lineTo(-w, w); ctx.lineTo(-r, 0); ctx.lineTo(-w, -w);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.save();
  ctx.fillStyle = GOLD;
  for (let i = 0; i < 3; i++) {
    const u = ((now + id * 97 + i * 600) % 1800) / 1800;
    ctx.globalAlpha = (1 - u) * 0.8;
    const a = i * 2.1 + id;
    ctx.fillRect(x + Math.cos(a) * (20 + u * 10) - 1.5, y + Math.sin(a) * (14 + u * 8) - u * 18 - 1.5, 3, 3);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------------------------- minimap & feed

/** The supply plane's track, its target and then the landed crate on the minimap: a dashed line, a moving plane, a pulsing orange ring. */
export function drawAirdropMap(ctx: CanvasRenderingContext2D, air: AirdropView | null | undefined, serverNow: number | null, now: number, x: number, y: number, k: number, size: number, alpha: number) {
  if (!air || serverNow === null) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.clip();
  const tx = x + air.x * k, ty = y + air.y * k;
  const landed = serverNow >= air.landAt;
  if (serverNow < air.dropAt + 2500) {
    const reach = size * 2;
    ctx.globalAlpha = alpha * 0.55;
    ctx.strokeStyle = SIGNAL;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(tx - Math.cos(air.a) * reach, ty - Math.sin(air.a) * reach);
    ctx.lineTo(tx + Math.cos(air.a) * reach, ty + Math.sin(air.a) * reach);
    ctx.stroke();
    ctx.setLineDash([]);
    const p = planeAt(air, serverNow);
    ctx.globalAlpha = alpha;
    ctx.translate(x + p.x * k, y + p.y * k);
    ctx.rotate(air.a);
    ctx.fillStyle = BONE;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(6, 0); ctx.lineTo(-4, -5); ctx.lineTo(-2, 0); ctx.lineTo(-4, 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, size, size);
    ctx.clip();
  }
  const pulse = 0.5 + 0.5 * Math.sin(now / 260);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = SIGNAL;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(tx, ty, landed ? 5 : 5 + 4 * pulse, 0, TAU);
  ctx.stroke();
  ctx.fillStyle = SIGNAL;
  ctx.fillRect(tx - 2.5, ty - 2.5, 5, 5);
  ctx.restore();
}

/**
 * The Shield ability's barrier: a pane of blue energy, bright along the face rounds leave by, with chevrons pointing the way they
 * pass (`out`): its owner's side shoots out through it, and nothing shoots back in.
 */
export function drawShields(ctx: CanvasRenderingContext2D, walls: readonly { x: number; y: number; w: number; h: number; out?: readonly [number, number]; ends?: number }[], now: number, serverAt: number | null = null) {
  for (const wall of walls) {
    if (!wall.out) continue;
    const [ox, oy] = wall.out;
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);
    const left = wall.ends !== undefined && serverAt !== null ? Math.max(0, wall.ends - serverAt) : null;
    ctx.save();
    // Its last three seconds it flickers, faster as it runs out, so nobody is surprised when it drops.
    if (left !== null && left < 3000) ctx.globalAlpha = Math.sin(now / (40 + left / 25)) > -0.3 ? 1 : 0.35;
    ctx.fillStyle = `rgba(90, 190, 255, ${0.28 + 0.1 * pulse})`;
    ctx.fillRect(wall.x, wall.y, wall.w, wall.h);
    ctx.strokeStyle = 'rgba(150, 220, 255, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(wall.x + 0.75, wall.y + 0.75, wall.w - 1.5, wall.h - 1.5);
    // The face rounds leave by: a hot line.
    ctx.strokeStyle = '#c9f0ff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (ox) { const fx = ox > 0 ? wall.x + wall.w : wall.x; ctx.moveTo(fx, wall.y); ctx.lineTo(fx, wall.y + wall.h); }
    else { const fy = oy > 0 ? wall.y + wall.h : wall.y; ctx.moveTo(wall.x, fy); ctx.lineTo(wall.x + wall.w, fy); }
    ctx.stroke();
    // Chevrons along the pane, pointing out.
    const along = ox ? wall.h : wall.w, n = Math.max(2, Math.floor(along / 34));
    const cx0 = wall.x + wall.w / 2, cy0 = wall.y + wall.h / 2, s = 5;
    ctx.strokeStyle = `rgba(230, 248, 255, ${0.6 + 0.3 * pulse})`;
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const t = ((i + 0.5) / n - 0.5) * along;
      const px = cx0 + (ox ? 0 : t), py = cy0 + (ox ? t : 0);
      // The chevron's tip leads along `out`; its arms trail back and to each side.
      const tx = px + ox * s * 0.6, ty = py + oy * s * 0.6;
      ctx.moveTo(tx - ox * s - oy * s, ty - oy * s - ox * s);
      ctx.lineTo(tx, ty);
      ctx.lineTo(tx - ox * s + oy * s, ty - oy * s + ox * s);
    }
    ctx.stroke();
    // The seconds it has left, small over its middle.
    if (left !== null) {
      ctx.globalAlpha = 1;
      ctx.font = '800 13px "Barlow Condensed", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(20, 24, 30, 0.85)';
      const label = `${Math.ceil(left / 1000)}`;
      ctx.strokeText(label, cx0, cy0);
      ctx.fillStyle = '#e6f8ff';
      ctx.fillText(label, cx0, cy0);
    }
    ctx.restore();
  }
}

/**
 * A plate over every standing supply crate that says what it is and what breaking it gives, so a gold box is never a mystery:
 * your next level pick (named for whoever is looking) and a full resupply, or a golden gun once every pick is made.
 */
export function drawDropLabels(ctx: CanvasRenderingContext2D, crates: readonly { x: number; y: number; size: number; drop?: true }[], nextPick: string | null, now: number, view: View) {
  const sub = nextPick ? `Shoot it open: your next ${nextPick} + resupply` : 'Shoot it open: golden gun + resupply';
  for (const c of crates) {
    if (!c.drop) continue;
    const x = c.x + c.size / 2, y = c.y - 12 - 2 * Math.sin(now / 400);
    if (!visible(view, x, y, 200)) continue;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 19px "Barlow Condensed", system-ui, sans-serif';
    const head = 'SUPPLY DROP';
    const w1 = ctx.measureText(head).width;
    ctx.font = '700 14px "Barlow Condensed", system-ui, sans-serif';
    const w2 = ctx.measureText(sub).width;
    const w = Math.max(w1, w2) + 20, h = 44;
    ctx.fillStyle = 'rgba(28, 31, 38, 0.88)';
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h, w, h, 6);
    ctx.fill();
    ctx.stroke();
    // A little tail down to the crate.
    ctx.fillStyle = GOLD;
    ctx.beginPath();
    ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 7); ctx.closePath();
    ctx.fill();
    ctx.font = '900 19px "Barlow Condensed", system-ui, sans-serif';
    ctx.fillStyle = GOLD;
    ctx.fillText(head, x, y - h + 15);
    ctx.font = '700 14px "Barlow Condensed", system-ui, sans-serif';
    ctx.fillStyle = '#ece6d6';
    ctx.fillText(sub, x, y - h + 32);
    ctx.restore();
  }
}

/** The kill feed's line for an airdrop event, and what colour its marker takes. */
export function airdropLine(ev: Extract<Snapshot['events'][number], { e: 'airdrop' }>): { text: string; color: string } | null {
  switch (ev.k) {
    case 'inbound': return { text: 'Supply drop inbound', color: SIGNAL };
    case 'landed': return { text: 'Supply drop has landed', color: SIGNAL };
    case 'taken': return { text: `${ev.by ?? 'Someone'} ${ev.gold ? 'took the golden gun' : ev.level ? 'cracked a supply drop: level up' : 'took the supplies'}`, color: GOLD };
  }
}
