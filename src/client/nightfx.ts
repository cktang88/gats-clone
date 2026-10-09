import type { Point } from './camera.ts';
import { ambientFor, resolveLights, selectLights, type ResolvedLight } from './lighting.ts';
import type { Mood } from './mood.ts';
import { seeded } from './grain.ts';

/**
 * The plain-canvas night: what a device without the shader pass sees. It paints the same lights the GL pass would
 * (lighting.ts collects them either way), without shadows: the world multiplied by the map's ambient colour, coloured
 * pools added to that, a second additive pass so a pool glows above the floor instead of merely un-darkening it, visible
 * beams for the cones that have them, drifting fog banks and rain streaks. All of it is drawn small and scaled up, so the
 * cost is a few gradient fills on a thumbnail and two blits, cheap enough for a software canvas.
 */

const CELL = 4;
const MAX_LIGHTS = 30;
/** The ceilings of the plain night (exported for the brightness test): the light multiplied in, and the glow screened over it. */
export const CAP = 0.92, GLOW_CAP = 0.56;
/** How strongly the glow layer is screened over the world at a dusk. */
export const glowAlpha = (dark: number): number => Math.min(0.7, 0.15 + 0.5 * dark);
let shade: HTMLCanvasElement | null = null;
let glow: HTMLCanvasElement | null = null;
let fogc: HTMLCanvasElement | null = null;
let mask: HTMLCanvasElement | null = null;

/** Pushes a light's colour toward its own hue (the weaker channels fall away), so stacked pools stay amber or neon and do not drift to grey. */
const rich = (rgb: readonly number[]): number[] => { const m = Math.max(rgb[0]!, rgb[1]!, rgb[2]!, 0.01); return rgb.map((c) => c * Math.pow(c / m, 1.15)); };
/** The night between the pools: moonlight, a notch darker than the mood's ambient and pushed toward blue so warm lamps have something cold to stand against. */
const cool = (rgb: readonly number[]): number[] => [rgb[0]! * 0.5, rgb[1]! * 0.62, Math.min(1, rgb[2]! * 0.82)];
const css = (rgb: readonly number[], a: number) => `rgba(${Math.round(rgb[0]! * 255)}, ${Math.round(rgb[1]! * 255)}, ${Math.round(rgb[2]! * 255)}, ${a})`;

/** One pool: bright at the heart, falling off with a long tail, so it reads as light and not as a disc. */
function pool(g: CanvasRenderingContext2D, x: number, y: number, r: number, rgb: readonly number[], a: number) {
  const gr = g.createRadialGradient(x, y, r * 0.04, x, y, r);
  gr.addColorStop(0, css(rgb, Math.min(1, a)));
  gr.addColorStop(0.16, css(rgb, Math.min(1, a) * 0.62));
  gr.addColorStop(0.4, css(rgb, Math.min(1, a) * 0.2));
  gr.addColorStop(0.62, css(rgb, Math.min(1, a) * 0.05));
  gr.addColorStop(1, css(rgb, 0));
  g.fillStyle = gr;
  g.fillRect(x - r, y - r, r * 2, r * 2);
}

/** A cone: the same pool clipped to a wedge, with the edge feathered by two nested wedges. */
function wedge(g: CanvasRenderingContext2D, x: number, y: number, r: number, angle: number, half: number, rgb: readonly number[], a: number) {
  for (const [k, w] of [[1, 0.55], [0.55, 0.45]] as const) {
    const gr = g.createRadialGradient(x, y, r * 0.05, x, y, r);
    gr.addColorStop(0, css(rgb, Math.min(1, a * w)));
    gr.addColorStop(0.5, css(rgb, Math.min(1, a * w) * 0.5));
    gr.addColorStop(1, css(rgb, 0));
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(x, y);
    g.arc(x, y, r, angle - half * k, angle + half * k);
    g.closePath();
    g.fill();
  }
}

/** A beam: a long thin wedge that stays bright toward its far end more than a pool does, as a shaft through the air. */
function shaft(g: CanvasRenderingContext2D, x: number, y: number, r: number, angle: number, half: number, rgb: readonly number[], a: number) {
  const gr = g.createLinearGradient(x, y, x + Math.cos(angle) * r, y + Math.sin(angle) * r);
  gr.addColorStop(0, css(rgb, Math.min(1, a)));
  gr.addColorStop(0.35, css(rgb, Math.min(1, a) * 0.5));
  gr.addColorStop(1, css(rgb, 0));
  for (const k of [1, 0.55, 0.28]) {
    g.fillStyle = gr;
    g.globalAlpha = k === 1 ? 0.5 : k === 0.55 ? 0.6 : 0.7;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(angle - half * k) * r, y + Math.sin(angle - half * k) * r);
    g.lineTo(x + Math.cos(angle + half * k) * r, y + Math.sin(angle + half * k) * r);
    g.closePath();
    g.fill();
  }
  g.globalAlpha = 1;
}

const fogSeed = (() => { const rand = seeded(44); return Array.from({ length: 9 }, () => ({ x: rand(), y: rand(), r: 0.5 + rand() * 0.6, v: 0.6 + rand() * 0.8, ph: rand() * 6.28 })); })();
const rainSeed = (() => { const rand = seeded(17); return Array.from({ length: 150 }, () => ({ x: rand(), y: rand(), v: 0.8 + rand() * 0.7, len: 0.6 + rand() * 0.8 })); })();

/**
 * Paints the night over the world drawn so far. `dark` is the eased 0..1 dusk. Returns the number of lights painted, for the dev probe.
 * `lights` defaults to every live light (lighting.ts); the view is culled and capped.
 */
export function drawNightFx(ctx: CanvasRenderingContext2D, tl: Point, br: Point, dark: number, now: number, mood: Mood | undefined, lights?: readonly ResolvedLight[]): number {
  const vw = br.x - tl.x, vh = br.y - tl.y;
  const w = Math.max(8, Math.ceil(vw / CELL)), h = Math.max(8, Math.ceil(vh / CELL));
  if (!shade) { shade = document.createElement('canvas'); glow = document.createElement('canvas'); fogc = document.createElement('canvas'); mask = document.createElement('canvas'); }
  if (shade.width !== w || shade.height !== h) { shade.width = w; shade.height = h; glow!.width = w; glow!.height = h; fogc!.width = w; fogc!.height = h; mask!.width = w; mask!.height = h; }
  const amb = ambientFor(dark, false, mood);
  const view = { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y };
  const picked = selectLights(lights ?? resolveLights(now), view, MAX_LIGHTS, 0);
  const g = shade.getContext('2d')!, gg = glow!.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  gg.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.fillStyle = css(cool(amb.rgb), 1);
  g.fillRect(0, 0, w, h);
  gg.globalCompositeOperation = 'source-over';
  // Opaque black base: the glow is added to the world with 'screen', and the soft ceiling below (a darken) needs pixels to clamp.
  gg.fillStyle = '#000';
  gg.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'lighter';
  gg.globalCompositeOperation = 'lighter';
  const mk = mask!.getContext('2d')!;
  mk.setTransform(1, 0, 0, 1, 0, 0);
  mk.globalCompositeOperation = 'source-over';
  mk.clearRect(0, 0, w, h);
  mk.globalCompositeOperation = 'lighter';
  const to = (x: number, y: number): [number, number] => [(x - tl.x) / CELL, (y - tl.y) / CELL];
  // A crowded view (a market full of stalls) would add up to a flat wash, so every light gives a little back as the count climbs.
  const k = amb.gain * 1.25 * Math.min(1, 30 / Math.max(1, picked.length));
  const cx = (tl.x + br.x) / 2, cy = (tl.y + br.y) / 2, span = Math.max(vw, vh) * 0.75;
  // How much other light already falls on a point: a lamp standing inside someone else's pool adds less, so overlaps do not stack to white.
  const crowd = (l: ResolvedLight) => {
    let c = 0;
    for (const o of picked) {
      if (o === l || o.cone) continue;
      const d = Math.hypot(o.x - l.x, o.y - l.y) / o.radius;
      if (d < 1) c += o.level * (1 - d) * (1 - d);
    }
    return 1 / (1 + 1.6 * c);
  };
  for (const l0 of picked) {
    const l = { ...l0, rgb: rich(l0.rgb) };
    // A big lamp (radius 400+) is drawn as a tighter pool in the plain path, so posts along a quay stay separate pools with dark gaps.
    const reach = !l.cone && l.radius > 140 ? 140 + (l.radius - 140) * 0.6 : l.radius;
    // Own lamp: a small flashlight pool, and lights far from the centre of the view give a little back.
    const mine = (l0.pri ?? 0) >= 40;
    const [x, y] = to(l.x, l.y), r = (mine ? Math.min(reach, 120) : reach) / CELL;
    const lv = l.level * k * (mine ? 0.45 : 1) * (1 - 0.3 * Math.min(1, Math.hypot(l.x - cx, l.y - cy) / span));
    if (l.cone) {
      const own = crowd(l0);
      wedge(g, x, y, r * 1.0, l.cone.angle, l.cone.half * 0.8, l.rgb, lv * 0.32 * (0.65 + 0.35 * own));
      wedge(gg, x, y, r * 1.0, l.cone.angle, l.cone.half * 0.8, l.rgb, lv * 0.12 * own);
      if (l.beam > 0 && amb.shafts > 0.01) shaft(gg, x, y, r * 1.25, l.cone.angle, l.cone.half * 0.8 + 0.04, l.rgb, lv * l.beam * 0.5);
      // The source itself: a small pool, so a lamp is lit even when its cone faces away.
      pool(g, x, y, Math.min(r * 0.35, 40), l.rgb, lv * 0.4 * own);
      if (amb.fog) wedge(mk, x, y, r, l.cone.angle, l.cone.half * 0.8, [1, 1, 1], Math.min(1, lv * 0.6));
    } else {
      pool(g, x, y, r, l.rgb, lv * 1.3);
      pool(gg, x, y, r * 0.85, l.rgb, lv * 0.36);
      if (amb.fog) pool(mk, x, y, r * 0.9, [1, 1, 1], Math.min(1, lv));
    }
  }
  // Fog: a few big soft banks, drifting, lit a little by the pools they sit in.
  if (amb.fog) {
    const t = now / 1000, [dx, dy] = amb.fog.drift;
    const fc = fogc!.getContext('2d')!;
    fc.setTransform(1, 0, 0, 1, 0, 0);
    fc.globalCompositeOperation = 'source-over';
    fc.clearRect(0, 0, w, h);
    fc.globalCompositeOperation = 'lighter';
    for (const f of fogSeed) {
      const fx = (((f.x * vw * 1.6 + t * dx * f.v - tl.x * 0.4) % (vw * 1.6)) + vw * 1.6) % (vw * 1.6) - vw * 0.3;
      const fy = (((f.y * vh * 1.6 + t * dy * f.v + Math.sin(t * 0.07 + f.ph) * 40 - tl.y * 0.4) % (vh * 1.6)) + vh * 1.6) % (vh * 1.6) - vh * 0.3;
      const r = Math.max(vw, vh) * 0.32 * f.r / CELL, x = fx / CELL, y = fy / CELL;
      pool(fc, x, y, r, amb.fog.rgb, amb.fog.density * 0.22 * (0.6 + 0.4 * Math.sin(t * 0.2 + f.ph)));
    }
    // Haze is only seen where light falls on it: it never lifts the dark floor.
    fc.globalCompositeOperation = 'destination-in';
    fc.drawImage(mask!, 0, 0);
    gg.globalCompositeOperation = 'lighter';
    gg.drawImage(fogc!, 0, 0);
  }
  // Soft ceiling: however many pools stack, no channel of the light passes CAP and the glow stays a tint, so a pool is a colour and never white.
  g.globalCompositeOperation = 'darken';
  g.globalAlpha = 1;
  const top = Math.max(...amb.rgb);
  g.fillStyle = css([Math.max(CAP, top), Math.max(CAP, top), Math.max(CAP, top)], 1);
  g.fillRect(0, 0, w, h);
  gg.globalCompositeOperation = 'darken';
  gg.fillStyle = css([GLOW_CAP, GLOW_CAP * 0.85, GLOW_CAP * 0.7], 1);
  gg.fillRect(0, 0, w, h);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 1;
  ctx.drawImage(shade, tl.x, tl.y, vw, vh);
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = glowAlpha(dark);
  ctx.drawImage(glow!, tl.x, tl.y, vw, vh);
  if (amb.rain > 0) {
    const t = now / 1000, len = 26 * (vh / 900 + 0.4);
    ctx.globalAlpha = 0.16 + 0.18 * amb.rain;
    ctx.strokeStyle = 'rgb(180, 205, 245)';
    ctx.lineWidth = Math.max(1, vw / 1100);
    ctx.beginPath();
    const n = Math.round(rainSeed.length * (0.4 + 0.6 * amb.rain));
    for (let i = 0; i < n; i++) {
      const d = rainSeed[i]!;
      const x = ((d.x * vw * 1.2 + t * 60 * d.v) % (vw * 1.2)) - vw * 0.1;
      const y = ((d.y * (vh + len * 2) + t * 900 * d.v) % (vh + len * 2)) - len;
      ctx.moveTo(tl.x + x, tl.y + y);
      ctx.lineTo(tl.x + x - 5 * d.len, tl.y + y + len * d.len);
    }
    ctx.stroke();
  }
  ctx.restore();
  return picked.length;
}
