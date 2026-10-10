import { HEAL_POLE } from '../shared/sim/abilities.ts';
import type { Snapshot, ThrownView } from '../shared/protocol.ts';
import { addLight } from './lighting.ts';
import { INK } from './palette.ts';

/**
 * The defensive and intel gadgets, drawn in the art bible's terms: the radar sensor (a puck with a blinking eye that tumbles to a
 * stop, then sends one sweeping ring out over everything it tags) and the heal pole (a post with a mint cross whose reach glows
 * on the floor and pulses with each heal).
 */
const TAU = Math.PI * 2;
const MINT = '#8ff0c4';
const RADAR_BLUE = '#7fd4ff';

export const isGadget = (kind: ThrownView['kind']): kind is 'radar' | 'healPole' => kind === 'radar' || kind === 'healPole';

/** The radar puck in flight, or the heal pole where it stands. */
export function drawGadgetBody(ctx: CanvasRenderingContext2D, t: ThrownView, now: number) {
  if (t.kind === 'radar') return drawPuck(ctx, t, now);
  if (t.kind === 'healPole') return drawPole(ctx, t, now);
}

function drawPuck(ctx: CanvasRenderingContext2D, t: ThrownView, now: number) {
  ctx.fillStyle = 'rgba(10, 12, 18, 0.42)';
  ctx.beginPath();
  ctx.ellipse(t.x + 3, t.y + 5, 10, 5, 0, 0, TAU);
  ctx.fill();
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.rotate(now / 140 + t.id);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.fillStyle = '#4f5661';
  ctx.beginPath();
  ctx.arc(0, 0, 9, 0, TAU);
  ctx.fill();
  ctx.stroke();
  // A short antenna, and the eye that blinks blue.
  ctx.beginPath();
  ctx.moveTo(0, -9);
  ctx.lineTo(0, -15);
  ctx.stroke();
  const on = Math.sin(now / 90 + t.id) > 0;
  ctx.fillStyle = on ? RADAR_BLUE : '#2c4a5c';
  ctx.beginPath();
  ctx.arc(0, 0, 4, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawPole(ctx: CanvasRenderingContext2D, t: ThrownView, now: number) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 250 + t.id);
  // Its reach on the floor: a soft mint disc with a ring that breathes.
  ctx.save();
  ctx.fillStyle = `rgba(143, 240, 196, ${0.1 + 0.06 * pulse})`;
  ctx.beginPath();
  ctx.arc(t.x, t.y, HEAL_POLE.radius, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = `rgba(143, 240, 196, ${0.5 + 0.3 * pulse})`;
  ctx.lineWidth = 2.5;
  ctx.setLineDash([10, 8]);
  ctx.lineDashOffset = -now / 40;
  ctx.beginPath();
  ctx.arc(t.x, t.y, HEAL_POLE.radius, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
  // The post: a dark base, a pole leaning up-screen, and a mint cross on top.
  ctx.fillStyle = 'rgba(10, 12, 18, 0.4)';
  ctx.beginPath();
  ctx.ellipse(t.x + 4, t.y + 4, 11, 6, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.fillStyle = '#3d4450';
  ctx.beginPath();
  ctx.arc(t.x, t.y, 8, 0, TAU);
  ctx.fill();
  ctx.stroke();
  ctx.lineCap = 'round';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(t.x, t.y);
  ctx.lineTo(t.x, t.y - 26);
  ctx.stroke();
  ctx.strokeStyle = '#9aa0a8';
  ctx.lineWidth = 3;
  ctx.stroke();
  const cy = t.y - 30, a = 3, b = 8;
  ctx.fillStyle = MINT;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(t.x - a, cy - b); ctx.lineTo(t.x + a, cy - b); ctx.lineTo(t.x + a, cy - a); ctx.lineTo(t.x + b, cy - a); ctx.lineTo(t.x + b, cy + a);
  ctx.lineTo(t.x + a, cy + a); ctx.lineTo(t.x + a, cy + b); ctx.lineTo(t.x - a, cy + b); ctx.lineTo(t.x - a, cy + a); ctx.lineTo(t.x - b, cy + a);
  ctx.lineTo(t.x - b, cy - a); ctx.lineTo(t.x - a, cy - a); ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  if (pulse > 0.97) addLight({ x: t.x, y: t.y - 20, radius: HEAL_POLE.radius, color: MINT, intensity: 0.5, life: 300, size: 20 });
}

// ---------------------------------------------------------------- the radar's sweep

const SWEEP_MS = 1100;
type Sweep = { x: number; y: number; r: number; born: number };
const sweeps: Sweep[] = [];
const seenSweeps = new Set<string>();

function noteSweeps(snap: Snapshot, now: number) {
  for (const ev of snap.events) {
    if (ev.e !== 'radar') continue;
    const key = `${snap.tick}:${Math.round(ev.x)}:${Math.round(ev.y)}`;
    if (seenSweeps.has(key)) continue;
    seenSweeps.add(key);
    if (seenSweeps.size > 64) seenSweeps.delete(seenSweeps.values().next().value!);
    sweeps.push({ x: ev.x, y: ev.y, r: ev.r, born: now });
    addLight({ x: ev.x, y: ev.y, radius: 220, color: RADAR_BLUE, intensity: 1.1, life: 500, size: 30 });
  }
  while (sweeps.length && now - sweeps[0]!.born > SWEEP_MS) sweeps.shift();
}

/** One bright ring racing out to the sensor's full reach (`RADAR.radius`), with a faint wash behind it. */
function drawSweep(ctx: CanvasRenderingContext2D, s: Sweep, now: number) {
  const k = (now - s.born) / SWEEP_MS;
  if (k < 0 || k >= 1) return;
  const r = s.r * (1 - (1 - k) ** 2), fade = 1 - k;
  ctx.save();
  ctx.strokeStyle = `rgba(127, 212, 255, ${0.85 * fade})`;
  ctx.lineWidth = 4 + 6 * fade;
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, TAU);
  ctx.stroke();
  ctx.fillStyle = `rgba(127, 212, 255, ${0.08 * fade})`;
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** What the gadgets draw over the world: the radar's sweeps. */
export function drawGadgetFx(ctx: CanvasRenderingContext2D, snap: Snapshot, now: number) {
  noteSweeps(snap, now);
  for (const s of sweeps) drawSweep(ctx, s, now);
}
