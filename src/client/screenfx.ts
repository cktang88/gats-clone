import { motionReduced, settings } from './settings.ts';

/**
 * Screen-wide kill juice: a warm flash, a brief chromatic split, a zoom punch and the low-health heartbeat. All of it is
 * dropped under `prefers-reduced-motion` (the heartbeat stays as a steady, faint rim), and none of it touches input.
 */
/** Reduced motion: the pause menu's Motion option (follow the system, always, never) over `prefers-reduced-motion`. */
export const reducedMotion = (): boolean => motionReduced(settings().motion, systemReduced());

/** The query is made once and its live `matches` read after (it is asked several times a frame); a swapped `matchMedia` is asked anew. */
let reducedQuery: { of: typeof matchMedia; list: MediaQueryList } | null = null;
function systemReduced(): boolean {
  if (typeof matchMedia !== 'function') return false;
  if (reducedQuery?.of !== matchMedia) reducedQuery = { of: matchMedia, list: matchMedia('(prefers-reduced-motion: reduce)') };
  return reducedQuery.list.matches;
}

export const SCREEN = { flashMs: 150, chromaMs: 130, chromaPx: 2.5, punchMs: 240, punchZoom: 0.032, bigPunch: 0.018 } as const;

type Pulse = { at: number; strength: number };
const pulse: Pulse = { at: -Infinity, strength: 0 };

/** A kill of yours: strength 1 for a kill, less for a big hit that did not kill. */
export function pulseScreen(now: number, strength: number): void {
  if (reducedMotion()) return;
  pulse.at = now;
  pulse.strength = strength;
  onPulse?.(strength);
}

let onPulse: ((strength: number) => void) | null = null;
/** Lets the WebGL post pass take the chromatic split when it owns the world (the 2D canvas is cleared then). */
export const setPulseHook = (hook: ((strength: number) => void) | null) => { onPulse = hook; };

const easeOut = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/** The zoom factor for the camera: a quick snap in that eases back out. 1 when at rest. */
export function zoomAt(now: number, at = pulse.at, strength = pulse.strength): number {
  const age = now - at;
  if (age < 0 || age >= SCREEN.punchMs) return 1;
  const k = age / SCREEN.punchMs;
  const shape = k < 0.18 ? k / 0.18 : 1 - easeOut((k - 0.18) / 0.82);
  return 1 + SCREEN.punchZoom * strength * shape;
}

/** 0..1 flash strength, front-loaded. */
export const flashAt = (now: number, at = pulse.at, strength = pulse.strength): number => {
  const age = now - at;
  return age < 0 || age >= SCREEN.flashMs ? 0 : strength * (1 - age / SCREEN.flashMs) ** 2;
};

let scratch: HTMLCanvasElement | null = null;

/** Over the finished world, before the HUD: a lamp-amber wash and a red/cyan split that decays in about 130 ms. */
/**
 * `worldOnCanvas` is false when the WebGL post pass has taken the world and cleared this canvas for the HUD: the split then
 * has nothing to shift and would composite solid colour over the whole screen (a black-out on every kill), so it is the
 * post pass's chromatic pulse that plays instead, and only the faint amber wash is drawn here.
 */
export function drawScreenPulse(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, now: number, worldOnCanvas = true): void {
  const flash = flashAt(now);
  if (flash <= 0.01) return;
  const pw = Math.ceil(w * dpr), ph = Math.ceil(h * dpr);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const age = now - pulse.at;
  if (worldOnCanvas && age < SCREEN.chromaMs) {
    const d = Math.max(1, SCREEN.chromaPx * pulse.strength * (1 - age / SCREEN.chromaMs) * dpr);
    scratch ??= document.createElement('canvas');
    if (scratch.width !== pw || scratch.height !== ph) { scratch.width = pw; scratch.height = ph; }
    const g = scratch.getContext('2d')!;
    g.globalCompositeOperation = 'copy';
    g.drawImage(ctx.canvas, 0, 0);
    // The frame keeps green and blue, the copy keeps red and is laid back over it a few px aside.
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = '#ff0000';
    g.fillRect(0, 0, pw, ph);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = '#00ffff';
    ctx.fillRect(0, 0, pw, ph);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(scratch, d, 0);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.globalAlpha = 0.16 * flash;
  ctx.fillStyle = '#ffe08a';
  ctx.fillRect(0, 0, pw, ph);
  ctx.restore();
}

/** A heartbeat's strength 0..1 at `phase` (0..1 through a beat): a strong thump, a short rest, a softer second thump. */
export function heartbeat(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  const bump = (c: number, w: number) => Math.exp(-(((p - c) / w) ** 2));
  return Math.min(1, bump(0.04, 0.05) + 0.6 * bump(0.24, 0.06));
}

/** Beats per second climbs as health falls, never past 2.4 Hz. */
export const beatHz = (hpFrac: number): number => 1.1 + 1.3 * Math.max(0, 1 - hpFrac / 0.35);

export const LOW_HP = 0.35;

let rim: { w: number; h: number; image: HTMLCanvasElement } | null = null;

function rimImage(pw: number, ph: number, dpr: number): HTMLCanvasElement {
  if (rim && rim.w === pw && rim.h === ph) return rim.image;
  const image = rim?.image ?? document.createElement('canvas');
  image.width = pw;
  image.height = ph;
  const g = image.getContext('2d')!;
  const rx = Math.min(pw * 0.22, 260 * dpr), ry = Math.min(ph * 0.22, 190 * dpr);
  const strip = (x0: number, y0: number, x1: number, y1: number, x: number, y: number, ww: number, hh: number) => {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, 'rgba(217, 84, 31, 1)');
    gr.addColorStop(0.45, 'rgba(217, 84, 31, 0.35)');
    gr.addColorStop(1, 'rgba(217, 84, 31, 0)');
    g.fillStyle = gr;
    g.fillRect(x, y, ww, hh);
  };
  strip(0, 0, rx, 0, 0, 0, rx, ph);
  strip(pw, 0, pw - rx, 0, pw - rx, 0, rx, ph);
  strip(0, 0, 0, ry, 0, 0, pw, ry);
  strip(0, ph, 0, ph - ry, 0, ph - ry, pw, ry);
  rim = { w: pw, h: ph, image };
  return image;
}

/** Low health: the screen's rim throbs fire-ramp orange in time with a heartbeat. Cached strips, one blit. */
export function drawHeartbeat(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, now: number, hpFrac: number): void {
  if (!(hpFrac > 0) || hpFrac > LOW_HP) return;
  const reduced = reducedMotion();
  const depth = 1 - hpFrac / LOW_HP;
  const beat = reduced ? 0.35 : heartbeat(now * 0.001 * beatHz(hpFrac));
  const alpha = (0.07 + 0.2 * depth) * (0.3 + 0.7 * beat) * (reduced ? 0.6 : 1);
  if (alpha < 0.01) return;
  const pw = Math.ceil(w * dpr), ph = Math.ceil(h * dpr);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = Math.min(0.4, alpha);
  ctx.drawImage(rimImage(pw, ph, dpr), 0, 0);
  ctx.restore();
}
