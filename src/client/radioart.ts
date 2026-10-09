/**
 * The radio prop's drawing: a chunky toy radio in the house style (ink outline, two hard cel steps, a lip that shows its top face), with a
 * warm practical light, a speaker grille that thumps on the beat, a dial whose needle follows the tuning, an antenna, drifting music notes,
 * and the E keycap prompt with its station label. Pure drawing: radio.ts decides what, where and when.
 */
import { celPart, ellipse, roundBox, TAU } from './cel.ts';
import { INK, shade, tint } from './palette.ts';

export type RadioLook = {
  x: number;
  y: number;
  /** 1 for the fixed radio, a little less for a hidden one. */
  scale: number;
  now: number;
  /** 1 on the beat, falling to 0. */
  pulse: number;
  /** 0 (day) to 1 (night): a warm light matters more in the dark. */
  dark: number;
  /** The needle, 0..1 across the dial. */
  needle: number;
  /** Mid-sputter after being shot: jitter, a dead light and static on the grille. */
  sputter: number;
  /** Tuned to Off: the light dims and no notes rise. */
  off: boolean;
  /** A hidden radio shows a fainter glow and slower notes so it does not shout. */
  quiet: boolean;
  /** The player is close: a gentle bob of the whole radio, a brighter glow. */
  near: boolean;
  reduced: boolean;
};

const BODY = '#d4562e';
const FACE = '#efe2bd';
const AMBER = '#ffc65a';

/** A single music note, drawn at the origin. */
function note(ctx: CanvasRenderingContext2D, s: number, color: string, flag: boolean) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2.2 * s;
  ctx.strokeStyle = INK;
  ctx.beginPath();
  ctx.ellipse(0, 0, 3.4 * s, 2.5 * s, -0.4, 0, TAU);
  ctx.moveTo(3 * s, -0.6 * s); ctx.lineTo(3 * s, -10 * s);
  if (flag) { ctx.lineTo(7 * s, -7 * s); }
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(0, 0, 3.4 * s, 2.5 * s, -0.4, 0, TAU);
  ctx.fill();
  ctx.lineWidth = 1.4 * s;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(3 * s, -0.6 * s); ctx.lineTo(3 * s, -10 * s);
  if (flag) ctx.lineTo(7 * s, -7 * s);
  ctx.stroke();
}

/** The notes drifting up off the speaker: three at staggered phases, each fading as it climbs. */
function notes(ctx: CanvasRenderingContext2D, look: RadioLook) {
  if (look.off || look.sputter > 0.2) return;
  const period = look.quiet ? 3800 : 2600;
  const n = look.quiet ? 2 : 3;
  for (let i = 0; i < n; i++) {
    const t = ((look.now / period + i / n) % 1 + 1) % 1;
    const sway = Math.sin(t * 7 + i * 2.1) * 6 * (look.reduced ? 0.3 : 1);
    ctx.save();
    ctx.globalAlpha = Math.min(1, t * 5) * (1 - t) ** 1.4 * (look.quiet ? 0.7 : 1);
    ctx.translate(-8 + sway + i * 5, -16 - t * (look.quiet ? 30 : 40));
    ctx.rotate(Math.sin(t * 5 + i) * 0.25);
    note(ctx, 0.9 * look.scale, i % 2 ? AMBER : FACE, i !== 1);
    ctx.restore();
  }
}

/** The warm light the radio gives off, and the dial lamp. */
function glow(ctx: CanvasRenderingContext2D, look: RadioLook) {
  const lit = look.off ? 0.35 : 1;
  const flicker = look.sputter > 0 ? (Math.floor(look.now / 55) % 2 ? 0.2 : 1) : 1;
  const r = (look.quiet ? 40 : 56) * look.scale * (look.near ? 1.15 : 1);
  const a = (0.16 + 0.1 * look.dark + (look.near ? 0.07 : 0)) * lit * flicker * (look.quiet ? 0.7 : 1);
  const g = ctx.createRadialGradient(0, -2, 2, 0, -2, r);
  g.addColorStop(0, `rgba(255, 190, 90, ${a * 2.2})`);
  g.addColorStop(1, 'rgba(255, 170, 70, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, -2, r, 0, TAU);
  ctx.fill();
}

export function drawRadio(ctx: CanvasRenderingContext2D, look: RadioLook) {
  const s = look.scale;
  const bob = look.near && !look.reduced ? Math.sin(look.now / 260) * 1.6 : 0;
  const jitter = look.sputter > 0 && !look.reduced ? (Math.floor(look.now / 45) % 3 - 1) * 1.2 : 0;
  ctx.save();
  ctx.translate(look.x + jitter, look.y);
  ctx.scale(s, s);
  glow(ctx, look);
  // Contact shadow.
  ctx.fillStyle = 'rgba(10, 12, 18, 0.34)';
  ctx.beginPath(); ctx.ellipse(0, 9, 24, 7, 0, 0, TAU); ctx.fill();
  ctx.translate(0, bob);
  // Antenna: a thin telescopic rod leaning back, with a bead.
  const sway = look.reduced ? 0 : Math.sin(look.now / 700) * 1.5;
  ctx.lineCap = 'round';
  ctx.strokeStyle = INK; ctx.lineWidth = 4.2;
  ctx.beginPath(); ctx.moveTo(12, -10); ctx.lineTo(24 + sway, -34); ctx.stroke();
  ctx.strokeStyle = '#cfd3da'; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.moveTo(12, -10); ctx.lineTo(24 + sway, -34); ctx.stroke();
  ctx.fillStyle = look.off ? '#8a8f99' : AMBER; ctx.strokeStyle = INK; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(24 + sway, -35, 2.6, 0, TAU); ctx.fill(); ctx.stroke();
  // Handle and body.
  celPart(ctx, roundBox(-9, -17, 9, -13, 2), '#7c5a3a', 0, 4, 1.6, 2);
  celPart(ctx, roundBox(-21, -12, 21, 9, 6), BODY, 0, 14, 2.2, 8, -2);
  // Faceplate and the two halves: speaker left, dial right.
  celPart(ctx, roundBox(-17, -8, 17, 5, 3), FACE, 0, 8, 1.4, 0, 0);
  const thump = look.off || look.sputter > 0 ? 0 : look.pulse;
  ctx.save();
  ctx.translate(-8, -1.5);
  const k = 1 + 0.14 * thump;
  ctx.scale(k, k);
  celPart(ctx, ellipse(0, 0, 6.2, 5.2), shade(FACE, 0.82), 0, 5, 1.4, 0, 0);
  ctx.strokeStyle = INK; ctx.lineWidth = 1.1;
  for (const y of [-2.4, 0, 2.4]) { ctx.beginPath(); ctx.moveTo(-4, y); ctx.lineTo(4, y); ctx.stroke(); }
  ctx.restore();
  if (thump > 0.05) {
    ctx.strokeStyle = `rgba(255, 220, 150, ${0.5 * thump})`; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.ellipse(-8, -1.5, 6.2 + 5 * (1 - thump), 5.2 + 4 * (1 - thump), 0, 0, TAU); ctx.stroke();
  }
  if (look.sputter > 0) {
    // Static speckles over the grille.
    for (let i = 0; i < 9; i++) {
      const h = Math.sin(look.now * 0.07 + i * 12.9898) * 43758.5453;
      const fx = h - Math.floor(h), fy = (h * 7.13) - Math.floor(h * 7.13);
      ctx.fillStyle = (i + Math.floor(look.now / 50)) % 2 ? '#ffffff' : '#9aa0aa';
      ctx.fillRect(-13 + fx * 10, -6 + fy * 9, 1.8, 1.8);
    }
  }
  // Dial: a window with ticks and a red needle that follows the tuning.
  celPart(ctx, roundBox(2, -6.5, 15, 1.5, 2), '#2b2e36', 0, 3, 1.2, 0, 0);
  ctx.strokeStyle = 'rgba(239, 226, 189, 0.7)'; ctx.lineWidth = 0.8;
  for (let i = 0; i < 6; i++) { const x = 3.6 + i * 2; ctx.beginPath(); ctx.moveTo(x, -5.4); ctx.lineTo(x, i % 2 ? -3.4 : -4.2); ctx.stroke(); }
  const nx = 3.4 + 10.2 * Math.min(1, Math.max(0, look.needle));
  ctx.strokeStyle = '#ff4a3a'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(nx, -6.2); ctx.lineTo(nx, 1.2); ctx.stroke();
  // A tuning knob under the dial, turned by the needle.
  ctx.save();
  ctx.translate(8.5, 9 - 7);
  celPart(ctx, ellipse(0, 0, 3.4, 3.4), '#3a3e48', 0, 3, 1.2, 0, 0);
  ctx.rotate(look.needle * 5);
  ctx.strokeStyle = FACE; ctx.lineWidth = 1.1;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -2.6); ctx.stroke();
  ctx.restore();
  // The lamp: a bead on the faceplate's corner, amber when tuned in.
  ctx.fillStyle = look.off || look.sputter > 0 ? '#6b4a2c' : tint(AMBER, 0.2);
  ctx.strokeStyle = INK; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(-15, 6.6, 1.9, 0, TAU); ctx.fill(); ctx.stroke();
  // A dial-side foot pair, to sit it on the floor.
  ctx.fillStyle = INK;
  ctx.fillRect(-16, 8.2, 6, 2.4); ctx.fillRect(10, 8.2, 6, 2.4);
  ctx.restore();
  // Notes are in world space, above the body.
  ctx.save();
  ctx.translate(look.x, look.y + bob * s);
  ctx.scale(s, s);
  notes(ctx, look);
  ctx.restore();
}

const KEY_FONT = '800 15px "Barlow Condensed", system-ui, sans-serif';
const LABEL_FONT = '700 13px "Barlow Condensed", system-ui, sans-serif';

/** A keycap with a lit top, a lip and an ink edge, centred on (x, y). */
function keycap(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, press: number) {
  const w = text.length > 1 ? 34 : 24, h = 24;
  ctx.save();
  ctx.translate(x, y + press * 2);
  celPart(ctx, roundBox(-w / 2, -h / 2, w / 2, h / 2, 6), '#f3ead2', 0, 7, 2, 4, 0);
  ctx.fillStyle = INK;
  ctx.font = KEY_FONT;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, -2.5);
  ctx.restore();
}

/** A rounded label plate whose text is centred at (x, y). */
function plate(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, fill: string, ink = '#f6efe0') {
  ctx.font = LABEL_FONT;
  const w = ctx.measureText(text).width + 16, h = 20;
  celPart(ctx, roundBox(x - w / 2, y - h / 2, x + w / 2, y + h / 2, 7), fill, 0, 5, 1.6, 2, 0);
  ctx.fillStyle = ink;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y - 1.5);
}

/** The "E · Radio · <station>" prompt that floats over a radio when you are close, bobbing gently. `key` is "E" or "TAP". The cabinets' "E · Open …" prompt is the same one (`drawKeyPrompt`). */
export function drawRadioPrompt(ctx: CanvasRenderingContext2D, x0: number, y0: number, now: number, label: string, key: string, reduced: boolean, k = 1) {
  const x = 0, y = 0;
  const bob = reduced ? 0 : Math.sin(now / 330) * 2.2;
  const press = reduced ? 0 : (Math.sin(now / 330 + 1.2) > 0.85 ? 1 : 0);
  ctx.save();
  ctx.translate(x0, y0);
  ctx.scale(k, k);
  ctx.font = LABEL_FONT;
  const tw = ctx.measureText(label).width + 16;
  const kw = key.length > 1 ? 34 : 24;
  const total = kw + 6 + tw;
  const left = x - total / 2;
  keycap(ctx, left + kw / 2, y + bob, key, press);
  plate(ctx, left + kw + 6 + tw / 2, y + bob, label, '#3b4452', '#f6efe0');
  ctx.restore();
}

/** The keycap-and-plate prompt over anything E acts on (a radio, a cabinet). */
export const drawKeyPrompt = drawRadioPrompt;

/** A small toast over the radio: a station name after tuning, or "Found a radio!". `age` 0..1 through its life. */
export function drawRadioToast(ctx: CanvasRenderingContext2D, x0: number, y0: number, text: string, age: number, tone: 'station' | 'found', k = 1) {
  const rise = Math.min(1, age * 5) * 8 + age * 6;
  const a = age < 0.8 ? 1 : 1 - (age - 0.8) / 0.2;
  ctx.save();
  ctx.translate(x0, y0);
  ctx.scale(k, k);
  ctx.globalAlpha = Math.max(0, a);
  plate(ctx, 0, -rise, text, tone === 'found' ? '#c8452f' : '#2f6f5e', '#fff6dc');
  ctx.restore();
}

/** The little speaker-wave rings on a radio that was just tuned, expanding and fading over `age` 0..1. */
export function drawTuneRings(ctx: CanvasRenderingContext2D, x: number, y: number, age: number, k = 1) {
  ctx.save();
  ctx.strokeStyle = `rgba(255, 214, 140, ${0.7 * (1 - age)})`;
  ctx.lineWidth = 2;
  for (let i = 0; i < 2; i++) {
    const t = Math.min(1, Math.max(0, age * 1.4 - i * 0.25));
    ctx.beginPath(); ctx.arc(x, y - 2, (14 + t * 34) * k, 0, TAU); ctx.globalAlpha = 1 - t; ctx.stroke();
  }
  ctx.restore();
}


