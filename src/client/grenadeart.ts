import type { ThrownView } from '../shared/protocol.ts';
import { GRENADE_FUSE_MS } from '../shared/sim/abilities.ts';
import { clamp01, easeOut, noteThrown, SMOKE_WIND, seeded } from './blastfx.ts';
import { drawGadgetBody, isGadget } from './gadgetart.ts';
import { setLight } from './lighting.ts';
import { INK, PALETTE } from './palette.ts';
import { reducedMotion } from './screenfx.ts';
import { LIGHT } from './tilt.ts';

/**
 * Thrown things, in the art bible's terms: chunky toys with an ink outline and two hard cel steps, lit from the top left.
 * A grenade is a lob: it rises on an arc with its shadow staying on the floor, tumbles, bounces twice with a squash on
 * each landing, then sits ticking, its fuse sparking and its danger ring closing in. Everything is a pure function of
 * `now` and of when the client first saw the thing (its `Track`), so a redraw never advances anything.
 */
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- what the client has seen of each thrown thing

type Track = { kind: ThrownView['kind']; t0: number; x: number; y: number; vx: number; vy: number; at: number; peak: number; seed: number };
const tracks = new Map<number, Track>();
const cloudBorn = new Map<number, number>();

/** The track of a thrown thing, first made the frame it is first drawn, with its speed smoothed from frame to frame. */
function trackOf(t: ThrownView, now: number): Track {
  let tr = tracks.get(t.id);
  if (!tr) {
    tr = { kind: t.kind, t0: now, x: t.x, y: t.y, vx: 0, vy: 0, at: now, peak: 34, seed: t.id * 1.7 };
    tracks.set(t.id, tr);
    if (tracks.size > 64) for (const [id, o] of tracks) if (now - o.at > 4000 || o.at > now + 1000) tracks.delete(id);
  } else if (now > tr.at) {
    const dt = (now - tr.at) / 1000;
    if (dt < 0.25) {
      tr.vx += ((t.x - tr.x) / dt - tr.vx) * 0.4;
      tr.vy += ((t.y - tr.y) / dt - tr.vy) * 0.4;
    }
    tr.x = t.x; tr.y = t.y; tr.at = now;
    // The arc's height follows how far the throw will go: about 0.9 s of this speed.
    if (now - tr.t0 > 50 && now - tr.t0 < 90) tr.peak = Math.max(18, Math.min(58, 14 + Math.hypot(tr.vx, tr.vy) * 0.9 * 0.12));
  }
  tr.kind = t.kind;
  noteThrown(t.id, t.kind, t.x, t.y, now);
  return tr;
}

// ---------------------------------------------------------------- the lob

const T_AIR = 560, T_B1 = 190, T_B2 = 120;
export type Flight = { z: number; squash: number; angle: number; landed: boolean };

/**
 * A lob over `age` ms: a high first arc, two smaller bounces, then it lies. Each landing squashes the body for 90 ms. The spin
 * is steady in the air and bleeds off after the last bounce, so the grenade comes to rest tipped over, as a thrown thing does.
 */
export function flightAt(age: number, peak: number, spinBase: number): Flight {
  const w0 = 0.017, tAir = T_AIR + T_B1 + T_B2;
  let z = 0, since = Infinity;
  if (age < T_AIR) { const w = age / T_AIR; z = 12 * (1 - w) + peak * 4 * w * (1 - w); }
  else if (age < T_AIR + T_B1) { const w = (age - T_AIR) / T_B1; z = peak * 0.2 * 4 * w * (1 - w); }
  else if (age < tAir) { const w = (age - T_AIR - T_B1) / T_B2; z = peak * 0.07 * 4 * w * (1 - w); }
  for (const hit of [T_AIR, T_AIR + T_B1, tAir]) if (age >= hit) since = Math.min(since, age - hit);
  const squash = since < 90 ? 1 - since / 90 : 0;
  const angle = age < tAir ? spinBase + w0 * age : spinBase + w0 * tAir + w0 * 150 * (1 - Math.exp(-(age - tAir) / 150));
  return { z: Math.max(0, z), squash, angle, landed: age >= T_AIR };
}

// ---------------------------------------------------------------- shared bits

const shadow = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, z = 0) => {
  const s = 1 - Math.min(0.45, z / 110);
  ctx.fillStyle = PALETTE.contact;
  ctx.globalAlpha = 1 - Math.min(0.5, z / 120);
  ctx.beginPath();
  ctx.ellipse(x + LIGHT.x * (r * 0.5 + z * 0.35), y + LIGHT.y * (r * 0.5 + z * 0.1) + 1, r * 1.05 * s, r * 0.78 * s, 0, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
};

/** The light direction in the body's own turning frame, so cel steps stay put on the world while the body tumbles. */
const localLight = (a: number) => ({ x: -(Math.cos(a) * LIGHT.x + Math.sin(a) * LIGHT.y), y: -(-Math.sin(a) * LIGHT.x + Math.cos(a) * LIGHT.y) });

/** A rounded solid in two cel steps: base, a shade band on the far side, a lit band on the light side, ink edge. `path` draws its outline. */
function celSolid(ctx: CanvasRenderingContext2D, path: (c: CanvasRenderingContext2D, grow: number, dx: number, dy: number) => void, c: { base: string; lit: string; shade: string }, a: number, size: number) {
  const L = localLight(a);
  ctx.save();
  ctx.beginPath();
  path(ctx, 0, 0, 0);
  ctx.clip();
  ctx.fillStyle = c.shade;
  ctx.fillRect(-size * 2, -size * 2, size * 4, size * 4);
  ctx.fillStyle = c.base;
  ctx.beginPath();
  path(ctx, 0, L.x * size * 0.2, L.y * size * 0.2);
  ctx.fill();
  ctx.fillStyle = c.lit;
  ctx.beginPath();
  path(ctx, -size * 0.3, L.x * size * 0.36, L.y * size * 0.36);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  path(ctx, 0, 0, 0);
  ctx.stroke();
}

/** The world position of a point on the body (local to its centre), `back` ms ago: where a spark or a hiss left the body. */
function bodyPoint(tr: Track, x: number, y: number, age: number, back: number, lx: number, ly: number): { x: number; y: number } {
  const f = flightAt(Math.max(0, age - back), tr.peak, tr.seed), c = Math.cos(f.angle), s = Math.sin(f.angle);
  return { x: x - (tr.vx * back) / 1000 + c * lx - s * ly, y: y - (tr.vy * back) / 1000 - f.z + s * lx + c * ly };
}

// ---------------------------------------------------------------- the grenades

type Look = { base: string; lit: string; shade: string; band: string };
const LOOK: Record<'grenade' | 'fragGrenade' | 'gasGrenade', Look> = {
  grenade: { base: '#4b5a3a', lit: '#66784c', shade: '#36422a', band: '#c7c9cc' },
  fragGrenade: { base: '#5a5338', lit: '#7a7048', shade: '#3e3a28', band: '#e07a22' },
  gasGrenade: { base: '#4b5a3a', lit: '#66784c', shade: '#36422a', band: '#c7d84a' },
};
const METAL = { base: '#8a909a', lit: '#c7c9cc', shade: '#5a6068' };

export function drawThrownBody(ctx: CanvasRenderingContext2D, t: ThrownView, now: number) {
  if (t.kind === 'landMine') return drawMine(ctx, t, now);
  if (t.kind === 'gasCloud' || t.kind === 'fireSlick') return;
  if (isGadget(t.kind)) return drawGadgetBody(ctx, t, now);
  const tr = trackOf(t, now), age = now - tr.t0, u = clamp01(age / GRENADE_FUSE_MS);
  // A body that has stopped (cover) is on the floor from the start.
  const f = flightAt(age, tr.peak, tr.seed);
  const stopped = age > 140 && Math.hypot(tr.vx, tr.vy) < 12;
  const z = stopped ? 0 : f.z, squash = stopped ? 0 : f.squash;
  const look = LOOK[t.kind];
  shadow(ctx, t.x, t.y, t.kind === 'gasGrenade' ? 9 : 11, z);
  ctx.save();
  ctx.translate(t.x, t.y - z + 10);
  ctx.scale(1 + 0.22 * squash, 1 - 0.24 * squash);
  ctx.translate(0, -10);
  ctx.rotate(f.angle);
  if (t.kind === 'gasGrenade') gasBody(ctx, look, f.angle, u);
  else eggBody(ctx, look, f.angle, t.kind === 'fragGrenade', age);
  ctx.restore();
  if (t.kind === 'gasGrenade') gasLeak(ctx, tr, t, z, age, now, u);
  else fuseSpark(ctx, tr, t, age, now, u);
  setLight(`fuse:${t.id}`, { x: t.x, y: t.y - z, radius: 60 + 50 * u, color: t.kind === 'gasGrenade' ? '#c7d84a' : '#ffb347', intensity: t.kind === 'gasGrenade' ? 0.15 : 0.3 + 0.45 * u, flicker: 0.4, size: 4, inside: 12, shadows: false });
}

/** The classic body: an egg with a striker cap, a spoon that flings open as soon as it is thrown, a pull ring, and a band. Frag adds a segmented casing. */
function eggBody(ctx: CanvasRenderingContext2D, look: Look, a: number, frag: boolean, age: number) {
  const rx = 9.4, ry = 10.6, egg = (c: CanvasRenderingContext2D, g: number, dx: number, dy: number) => { c.moveTo(dx + rx + g, dy + 1); c.ellipse(dx, dy + 1, rx + g, ry + g, 0, 0, TAU); };
  // The spoon first, behind the body, swung out after the throw.
  const open = easeOut(clamp01(age / 120)) * 0.5;
  ctx.save();
  ctx.translate(3.4, -14);
  ctx.rotate(open);
  ctx.fillStyle = METAL.lit;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  ctx.moveTo(-1.8, 0);
  ctx.quadraticCurveTo(7.6, 5, 7.4, 17);
  ctx.lineTo(4.4, 17);
  ctx.quadraticCurveTo(4.6, 7, -1.8, 3.2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  celSolid(ctx, egg, look, a, 10);
  if (frag) {
    // Segmented casing: curved ink grooves, a lit corner on each cell.
    ctx.save();
    ctx.beginPath();
    egg(ctx, -0.8, 0, 0);
    ctx.clip();
    ctx.strokeStyle = INK;
    ctx.globalAlpha = 0.62;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const y of [-6, -0.5, 5]) { ctx.moveTo(-rx, y); ctx.quadraticCurveTo(0, y + 3, rx, y); }
    for (const x of [-4.8, 0, 4.8]) { ctx.moveTo(x, -ry); ctx.quadraticCurveTo(x * 1.35, 0, x, ry + 2); }
    ctx.stroke();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = '#fff';
    const L = localLight(a);
    for (const y of [-8, -2.5, 3]) for (const x of [-7.5, -2.5, 2.4]) ctx.fillRect(x + L.x * 0.8, y + L.y * 0.8, 3.6, 1.8);
    ctx.restore();
  }
  // The band.
  ctx.save();
  ctx.beginPath();
  egg(ctx, -0.8, 0, 0);
  ctx.clip();
  ctx.fillStyle = look.band;
  ctx.beginPath();
  ctx.moveTo(-rx, 4.2);
  ctx.quadraticCurveTo(0, 7.4, rx, 4.2);
  ctx.lineTo(rx, 8);
  ctx.quadraticCurveTo(0, 11.2, -rx, 8);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.1;
  ctx.stroke();
  ctx.restore();
  // Neck, striker cap and the pull ring.
  ctx.fillStyle = METAL.base;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.roundRect(-3.7, -14.4, 7.4, 5.4, 1.5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = METAL.lit;
  ctx.fillRect(-2.6, -13.2, 2.2, 3.4);
  ctx.fillStyle = METAL.shade;
  ctx.beginPath();
  ctx.roundRect(-5.2, -17.2, 10.4, 3.8, 1.8);
  ctx.fill();
  ctx.stroke();
  ctx.lineWidth = 3.6;
  ctx.strokeStyle = INK;
  ctx.beginPath();
  ctx.arc(-7.4, -14, 2.7, 0, TAU);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#e2d39a';
  ctx.stroke();
  // One small specular dot on the lit side.
  const L = localLight(a);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.beginPath();
  ctx.arc(L.x * 5, 1 + L.y * 5, 1.5, 0, TAU);
  ctx.fill();
}

/** A gas canister: a taller capsule, a hazard band, and a brass nozzle on top with its valve. */
function gasBody(ctx: CanvasRenderingContext2D, look: Look, a: number, u: number) {
  const cap = (c: CanvasRenderingContext2D, g: number, dx: number, dy: number) => { c.roundRect(dx - 7.4 - g, dy - 8.4 - g, 14.8 + 2 * g, 20 + 2 * g, 6.4 + g); };
  celSolid(ctx, cap, look, a, 10);
  ctx.save();
  ctx.beginPath();
  cap(ctx, -0.8, 0, 0);
  ctx.clip();
  // Hazard band with diagonal ink stripes.
  ctx.fillStyle = look.band;
  ctx.fillRect(-8, -1.4, 16, 6.4);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let x = -12; x < 10; x += 5) { ctx.moveTo(x, 5); ctx.lineTo(x + 5, -1.4); }
  ctx.stroke();
  ctx.lineWidth = 1.1;
  ctx.strokeRect(-8, -1.4, 16, 6.4);
  ctx.restore();
  // Nozzle and valve: a brass collar, a short spout, and a wheel that jitters as the pressure builds.
  ctx.fillStyle = '#c9a24a';
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.roundRect(-4.2, -12.4, 8.4, 4.6, 1.4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#8a6f2a';
  ctx.beginPath();
  ctx.roundRect(-2.2, -16.4, 4.4, 4.4, 1.2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#e6c970';
  ctx.fillRect(-3.4, -11.6, 2, 2.6);
  ctx.fillStyle = INK;
  ctx.fillRect(-1, -16, 2, 1.8);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(-7.4 + u, -10);
  ctx.lineTo(-4.4, -10);
  ctx.stroke();
  const L = localLight(a);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.beginPath();
  ctx.arc(L.x * 4.6, 2 + L.y * 5, 1.4, 0, TAU);
  ctx.fill();
}

/** The fuse: a flickering star where the cap is, and flecks that spit off it and fall behind, hotter and more of them as the blast nears. */
function fuseSpark(ctx: CanvasRenderingContext2D, tr: Track, t: ThrownView, age: number, now: number, u: number) {
  const p = bodyPoint(tr, t.x, t.y, age, 0, 0, -18.4);
  const hot = Math.sin(now / 38 + t.id) > -0.2, r = (hot ? 3.2 : 2.2) * (0.8 + 0.7 * u);
  ctx.globalAlpha = 0.2 + 0.2 * u;
  ctx.fillStyle = '#ffb347';
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 2.1, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff1b0';
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const rr = i % 2 ? r * 0.42 : r * (i % 4 === 0 ? 1.5 : 1), a = (i / 8) * TAU + now / 90;
    const x = p.x + Math.cos(a) * rr, y = p.y + Math.sin(a) * rr;
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  // Flecks thrown off, each emitted from where the cap was a moment ago.
  const n = 3 + Math.round(3 * u), span = 320;
  ctx.fillStyle = '#ffd27a';
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const ph = (now / span + i / n) % 1, cycle = Math.floor(now / span + i / n), rand = seeded(cycle * 977 + t.id * 31 + i);
    const o = bodyPoint(tr, t.x, t.y, age, ph * span, 0, -18.4), a = rand() * TAU, d = ph * (7 + rand() * 9);
    const fr = 1.5 * (1 - ph) + 0.3;
    ctx.moveTo(o.x + Math.cos(a) * d + fr, o.y + Math.sin(a) * d + ph * ph * 8);
    ctx.arc(o.x + Math.cos(a) * d, o.y + Math.sin(a) * d + ph * ph * 8, fr, 0, TAU);
  }
  ctx.fill();
}

/** The gas canister's hiss: puffs leave the nozzle, drift on the wind and swell; more and bigger as the pop nears. */
function gasLeak(ctx: CanvasRenderingContext2D, tr: Track, t: ThrownView, _z: number, age: number, now: number, u: number) {
  const n = 9 + Math.round(5 * u), life = 560;
  ctx.fillStyle = '#9cc23c';
  const caps: number[] = [];
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const ph = (now / life + i / n) % 1, o = bodyPoint(tr, t.x, t.y, age, ph * life, 0, -17), s = ph * life / 1000;
    const x = o.x + SMOKE_WIND.x * s * 1.5 + Math.sin(now / 200 + i * 2) * 1.5, y = o.y + SMOKE_WIND.y * s * 1.5 - ph * 16, r = (2.4 + ph * 7.5) * (0.85 + 0.45 * u);
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, TAU);
    caps.push(x - r * 0.28, y - r * 0.3, r * 0.52);
  }
  ctx.globalAlpha = 0.55 + 0.3 * u;
  ctx.fill();
  ctx.fillStyle = '#d6ec7a';
  ctx.beginPath();
  for (let i = 0; i < caps.length; i += 3) { ctx.moveTo(caps[i]! + caps[i + 2]!, caps[i + 1]!); ctx.arc(caps[i]!, caps[i + 1]!, caps[i + 2]!, 0, TAU); }
  ctx.fill();
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- the mine

/** A land mine: a squat puck seen three-quarter (top face and a darker front face), a press plate, studs, and a blinking light that is amber while it arms. */
function drawMine(ctx: CanvasRenderingContext2D, t: ThrownView, now: number) {
  const tr = trackOf(t, now), age = now - tr.t0;
  const rx = 14, ry = 12, depth = 5.5, x = t.x, y = t.y - 1;
  shadow(ctx, x, y + depth, 14);
  const settle = age < 160 ? 1 - age / 160 : 0;
  ctx.save();
  ctx.translate(x, y + depth);
  ctx.scale(1 + 0.12 * settle, 1 - 0.18 * settle);
  ctx.translate(-x, -(y + depth));
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  // Front face: the lower ellipse and the wall between.
  ctx.fillStyle = '#2a2e35';
  ctx.beginPath();
  ctx.ellipse(x, y + depth, rx, ry, 0, 0, TAU);
  ctx.fill();
  ctx.fillRect(x - rx, y, rx * 2, depth);
  ctx.beginPath();
  ctx.ellipse(x, y + depth, rx, ry, 0, 0, Math.PI);
  ctx.moveTo(x - rx, y);
  ctx.lineTo(x - rx, y + depth);
  ctx.moveTo(x + rx, y);
  ctx.lineTo(x + rx, y + depth);
  ctx.stroke();
  // Top face, with a lit band toward the light and a shade band away.
  ctx.fillStyle = '#3b4048';
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = '#4f5560';
  ctx.beginPath();
  ctx.ellipse(x - LIGHT.x * 2.4, y - LIGHT.y * 2.4, rx - 1.5, ry - 1.5, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
  ctx.stroke();
  // Studs around the rim.
  ctx.fillStyle = '#80868f';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.3, sx = x + Math.cos(a) * (rx - 3.4), sy = y + Math.sin(a) * (ry - 3);
    ctx.beginPath();
    ctx.arc(sx, sy, 1.5, 0, TAU);
    ctx.fill();
    ctx.stroke();
  }
  // The press plate: a raised disc with its own little front face, so it reads as something to step on.
  const px = x - 1, py = y - 0.6, pr = 7.2;
  ctx.lineWidth = 1.8;
  ctx.fillStyle = '#23272e';
  ctx.beginPath();
  ctx.ellipse(px, py + 2.4, pr, pr * 0.86, 0, 0, TAU);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#6b727d';
  ctx.beginPath();
  ctx.ellipse(px, py, pr, pr * 0.86, 0, 0, TAU);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#8c939e';
  ctx.beginPath();
  ctx.ellipse(px - LIGHT.x * 1.6, py - LIGHT.y * 1.4, pr * 0.58, pr * 0.46, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(px - pr * 0.7, py);
  ctx.lineTo(px + pr * 0.7, py);
  ctx.moveTo(px, py - pr * 0.55);
  ctx.lineTo(px, py + pr * 0.55);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
  // The light: steady amber while it arms (the first 600 ms), then a short red blink once a second.
  const arming = age < 600, phase = (now % 1000) / 1000, on = arming ? Math.floor(age / 100) % 2 === 0 : phase < 0.16;
  const glowK = arming ? (on ? 0.7 : 0.15) : on ? 1 - phase / 0.16 : 0;
  const lx = x + 8.6, ly = y + 5.6;
  if (glowK > 0) {
    ctx.globalAlpha = glowK * 0.4;
    ctx.fillStyle = arming ? '#ffb347' : '#ff4d4f';
    ctx.beginPath();
    ctx.arc(lx, ly, 8 + 4 * glowK, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
    setLight(`mine:${t.id}`, { x: lx, y: ly, radius: 70, color: arming ? '#ffb347' : '#ff4d4f', intensity: 0.5 * glowK, size: 3, inside: 14, shadows: false });
  }
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(lx, ly, 3.9, 0, TAU);
  ctx.fill();
  ctx.fillStyle = on ? (arming ? '#ffd27a' : '#ff6b6d') : arming ? '#7a5420' : '#6f2022';
  ctx.beginPath();
  ctx.arc(lx, ly, 2.8, 0, TAU);
  ctx.fill();
  if (on) {
    ctx.fillStyle = '#fff6f0';
    ctx.beginPath();
    ctx.arc(lx - 0.8, ly - 0.8, 1.1, 0, TAU);
    ctx.fill();
  }
}

// ---------------------------------------------------------------- the danger ring

/** How far through its fuse the live grenade at (x, y) is, 0..1: the nearest tracked grenade or frag. */
function fuseAt(x: number, y: number, now: number): number {
  let best = 0, bd = 44 * 44, found = false;
  for (const tr of tracks.values()) {
    if (tr.kind !== 'grenade' && tr.kind !== 'fragGrenade') continue;
    const d = (tr.x - x) ** 2 + (tr.y - y) ** 2;
    if (d < bd) { bd = d; best = clamp01((now - tr.t0) / GRENADE_FUSE_MS); found = true; }
  }
  return found ? best : 0;
}

/**
 * The danger radius of a live grenade: a quiet ink-and-red dashed ring at the blast's edge, and an inner ring that closes in as
 * the fuse runs down, throbbing faster and thicker until the last beat. It reads on any floor without shouting.
 */
export function drawBlastRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, now: number) {
  const u = fuseAt(x, y, now), tau = u * (GRENADE_FUSE_MS / 1000);
  // The throb quickens from 1.5 Hz to 4 Hz as the fuse burns.
  const phase = TAU * (1.5 * tau + (1.25 * tau * tau) / (GRENADE_FUSE_MS / 1000)), pulse = reducedMotion() ? 0.6 : 0.5 + 0.5 * Math.sin(phase + 1.2);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = `rgba(229, 72, 77, ${(0.045 + 0.04 * pulse + 0.05 * u).toFixed(3)})`;
  ctx.fill();
  // An ink underline so the red holds on a bright floor, then the red itself.
  ctx.setLineDash([16, 12]);
  ctx.lineDashOffset = -now / 50;
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(28, 31, 38, 0.16)';
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = `rgba(229, 72, 77, ${(0.5 + 0.35 * pulse).toFixed(3)})`;
  ctx.stroke();
  ctx.setLineDash([]);
  // Eight ticks pointing in, turning slowly.
  ctx.lineWidth = 3;
  ctx.strokeStyle = `rgba(229, 72, 77, ${(0.4 + 0.3 * pulse).toFixed(3)})`;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + now / 4000;
    ctx.moveTo(x + Math.cos(a) * (r - 2), y + Math.sin(a) * (r - 2));
    ctx.lineTo(x + Math.cos(a) * (r - 11), y + Math.sin(a) * (r - 11));
  }
  ctx.stroke();
  // The closing ring: from the edge in toward the grenade over the fuse.
  const close = u * u * 0.6 + u * 0.4, rin = r * (1 - 0.8 * close);
  ctx.beginPath();
  ctx.arc(x, y, rin, 0, TAU);
  ctx.lineWidth = 2 + 4 * u;
  ctx.strokeStyle = `rgba(229, 72, 77, ${(0.22 + 0.55 * u * (0.6 + 0.4 * pulse)).toFixed(3)})`;
  ctx.stroke();
  if (u > 0.82) {
    ctx.globalAlpha = (u - 0.82) / 0.18;
    ctx.fillStyle = 'rgba(255, 120, 110, 0.18)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------- the gas cloud

const PUFFS = 16;

/** A toxic cloud: two flat unions of drifting puffs (dark body, lighter lit caps), rising bubbles and a wobbling rim. It swells open over its first third of a second, from the pop. */
export function drawGasCloud(ctx: CanvasRenderingContext2D, t: ThrownView, now: number) {
  let born = cloudBorn.get(t.id);
  if (born === undefined) { born = now; cloudBorn.set(t.id, now); if (cloudBorn.size > 32) for (const [id, b] of cloudBorn) if (now - b > 12000) cloudBorn.delete(id); }
  const open = easeOut(clamp01((now - born) / 380)), R = t.r * (0.3 + 0.7 * open);
  const body: number[] = [t.x, t.y, R * 0.72], cap: number[] = [];
  const rand = seeded(t.id * 7919 + 13);
  for (let i = 0; i < PUFFS; i++) {
    const a0 = rand() * TAU, d0 = 0.25 + rand() * 0.6, size = 0.2 + rand() * 0.18, sp = (rand() - 0.5) * 0.0006, ph = rand() * TAU;
    const a = a0 + now * sp;
    const d = R * d0 * (0.9 + 0.1 * Math.sin(now / 900 + ph));
    const r = R * size * (1 + 0.14 * Math.sin(now / 600 + ph * 2));
    const x = t.x + Math.cos(a) * d, y = t.y + Math.sin(a) * d;
    body.push(x, y, r);
    cap.push(x - LIGHT.x * r * 0.28, y - LIGHT.y * r * 0.28, r * 0.62);
  }
  const fill = (color: string, alpha: number, list: number[]) => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < list.length; i += 3) { ctx.moveTo(list[i]! + list[i + 2]!, list[i + 1]!); ctx.arc(list[i]!, list[i + 1]!, list[i + 2]!, 0, TAU); }
    ctx.fill();
  };
  fill('#6f9a2c', 0.3, body);
  fill('#c1d84a', 0.22, cap);
  // Bubbles rising out of the cloud.
  ctx.strokeStyle = '#e4f08a';
  ctx.lineWidth = 1.4;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  for (let i = 0; i < 7; i++) {
    const p = (now / 1800 + rand()) % 1, a = rand() * TAU, d = rand() * R * 0.7;
    const bx = t.x + Math.cos(a) * d + Math.sin(now / 400 + i) * 3, by = t.y + Math.sin(a) * d - p * 26, br = 2 + rand() * 3.2;
    ctx.moveTo(bx + br, by);
    ctx.arc(bx, by, br * (1 - p * 0.4), 0, TAU);
  }
  ctx.stroke();
  // Wobbling rim.
  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = PALETTE.gasEdge;
  ctx.lineWidth = 3;
  ctx.setLineDash([22, 12]);
  ctx.lineDashOffset = -now / 70;
  ctx.beginPath();
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * TAU, rr = R * (0.97 + 0.03 * Math.sin(a * 5 + now / 500));
    const px = t.x + Math.cos(a) * rr, py = t.y + Math.sin(a) * rr;
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}
