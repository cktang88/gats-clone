import type { RGB } from './lighting.ts';

/**
 * How bright lit ground may get: the exposure curve of the lighting pass, kept here as numbers and pure functions so the
 * shader (lightshaders.ts SCENE_FRAG builds its lines from these constants) and the tests share one source of truth.
 *
 * Lamps add up. A quay lined with sodium posts, a wet street and a bloom pass on top would otherwise stack past white into a
 * flat orange blowout that reads as lava, not light. Three things stop that:
 *  1. The light buffer is tone-mapped to a fixed ceiling (`LIGHT_CEIL`); a mood's `gain` steepens the curve (a lamp's pool
 *     comes up faster) but never raises the ceiling, so overlapping pools saturate to a warm pool rather than past it.
 *  2. Wet ground mirrors the light as a sheen at well under its own strength (`PUDDLE`, `GLINT`), not 1.15x and 2.4x.
 *  3. A soft highlight shoulder on the lit ground (`KNEE` to `CEIL`, on the brightest channel) rolls anything still hot
 *     toward a ceiling below the bloom threshold, so a lit floor never blooms; only the soldiers and effects, drawn unlit
 *     over it, and real light sources keep the brightest values on screen. Unlit ground is never darkened by it.
 */

/** The light buffer's ceiling after tone mapping, per channel. */
export const LIGHT_CEIL = 0.9;
/** The tone curve's slope at zero light; a mood's gain multiplies it. */
export const TONE_K = 1.25;
/** How strongly a puddle mirrors the light falling on it, and how hot a glint on wet stone gets. */
export const PUDDLE = 0.42;
export const GLINT = 0.8;
export const GLINT_WHITE = 0.18;
/** The highlight shoulder on lit ground: the brightest channel passes unchanged up to KNEE and eases toward CEIL above it. */
export const KNEE = 0.55;
export const CEIL = 0.8;
/**
 * A surface painted near-white or full lamp colour (a lamp's glass, a lit window pane) is the light source itself: its knee
 * rises toward 1 as its brightest unlit channel goes from SOURCE_LO to SOURCE_HI, so lamps still glow and bloom. Floors are
 * mid-dark by the art bible (snow included), far under SOURCE_LO.
 */
export const SOURCE_LO = 0.84;
export const SOURCE_HI = 0.97;
/** The emissive wash: a little of the light's own colour added regardless of the surface (lightgl.ts passes it as wx.w). */
export const WASH = 0.1;

/** A number as a GLSL float literal (an integer needs its point). */
export const glf = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const f = glf;

/** GLSL: the tone-mapped light from the raw buffer value and the mood's gain. */
export const GLSL_TONE = `vec3 L = (1.0 - exp(-${f(TONE_K)} * gain * raw)) * ${f(LIGHT_CEIL)};`;

/**
 * GLSL: `vec3 shoulder(vec3 c, float unlit, float src)`. `src` is the surface's brightest channel (see SOURCE_LO). `unlit` is the brightest channel the pixel would have with no lights at all, so
 * a bright surface by day (bone paint, snow under the moon) keeps its value and only what the lights add is rolled off.
 */
export const GLSL_SHOULDER = `
vec3 shoulder(vec3 c, float unlit, float src){
  float m = max(c.r, max(c.g, c.b));
  float knee = max(max(${f(KNEE)}, unlit), smoothstep(${f(SOURCE_LO)}, ${f(SOURCE_HI)}, src));
  float top = max(${f(CEIL)}, knee + 0.06);
  if (m <= knee) return c;
  float span = top - knee;
  float mm = knee + span * (1.0 - exp(-(m - knee) / span));
  return c * (mm / m);
}`;

const lum = (c: readonly number[]): number => 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!;

export function tone(raw: RGB, gain: number): RGB {
  return [0, 1, 2].map((i) => (1 - Math.exp(-TONE_K * gain * raw[i]!)) * LIGHT_CEIL) as unknown as RGB;
}

const smoothstep = (a: number, b: number, v: number): number => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

export function shoulder(c: RGB, unlit: number, src = 0): RGB {
  const m = Math.max(c[0], c[1], c[2]);
  const knee = Math.max(KNEE, unlit, smoothstep(SOURCE_LO, SOURCE_HI, src)), top = Math.max(CEIL, knee + 0.06);
  if (m <= knee) return c;
  const span = top - knee, mm = knee + span * (1 - Math.exp(-(m - knee) / span));
  return c.map((v) => v * (mm / m)) as unknown as RGB;
}

export type GroundInput = {
  /** The unlit surface colour, 0..1. */
  base: RGB;
  /** The raw light buffer value (lightAt * 2 + shafts). */
  raw: RGB;
  amb: RGB;
  gain: number;
  /** Ambient occlusion factor, 1 in the open. */
  ao?: number;
  /** Wet ground, the puddle mask and the glint at this pixel, 0..1. */
  wet?: number;
  pud?: number;
  glint?: number;
  /** Fog colour and coverage at this pixel (0 for none). */
  fog?: RGB;
  fogCover?: number;
  /** Additive beam and rain over the ground. */
  extra?: RGB;
};

/**
 * The lit ground colour as SCENE_FRAG computes it (before the overlay of soldiers and effects goes on top, and before the post
 * pass): the test mirror of the shader. The water's deepening is left out: it only ever darkens.
 */
export function litGround(p: GroundInput): RGB {
  const { base: b, amb, gain } = p;
  const a = p.ao ?? 1;
  const L = tone(p.raw, gain);
  const strength = Math.min(1, Math.max(0, lum(L) * 1.5));
  let lit = [0, 1, 2].map((i) => b[i]! * (amb[i]! * a * (1 - 0.8 * strength) + L[i]!) + L[i]! * WASH);
  const unlit = Math.max(...[0, 1, 2].map((i) => b[i]! * amb[i]! * a));
  const wet = p.wet ?? 0;
  if (wet > 0) {
    const pud = (p.pud ?? 0) * wet, glint = (p.glint ?? 0) * wet, l = lum(L);
    lit = lit.map((v, i) => v + ((v * 0.72 + L[i]! * PUDDLE * (0.5 + 0.5 * a) + amb[i]! * 0.1) - v) * pud * 0.85);
    const white = [0.9, 0.95, 1];
    lit = lit.map((v, i) => v + L[i]! * glint * GLINT * (0.25 + l) + white[i]! * glint * l * GLINT_WHITE);
  }
  if (p.fog && (p.fogCover ?? 0) > 0) {
    const fc = p.fogCover!;
    lit = lit.map((v, i) => v + (p.fog![i]! * (amb[i]! * 0.75 + L[i]! * 1.7 + 0.04) - v) * fc * 0.55);
  }
  if (p.extra) lit = lit.map((v, i) => v + p.extra![i]!);
  return shoulder(lit as unknown as RGB, unlit, Math.max(b[0], b[1], b[2]));
}

export type PostGrade = { lift: readonly number[]; gain: readonly number[]; gamma: number; sat: number; bloomThreshold: number };

/**
 * The post pass (postfx.ts BRIGHT and COMPOSITE) over a wide, even field of colour `c`, the worst case for bloom since the blur
 * then gives back the field itself: its bloom screen-blended on, then the grade. `bloom` is the strength postfx uploads
 * (grade strength x preset x mood glow x night lift). Vignette and grain are left out: one only darkens, the other averages out.
 */
export function postField(c: RGB, g: PostGrade, bloom: number): RGB {
  const luma = (v: readonly number[]) => 0.299 * v[0]! + 0.587 * v[1]! + 0.114 * v[2]!;
  const m = 0.5 * (luma(c) + Math.max(c[0], c[1], c[2]));
  const w = Math.min(1, Math.max(0, (m - g.bloomThreshold) / (1 - g.bloomThreshold))) ** 2;
  const tint = [1, 0.88, 0.7];
  let out = c.map((v, i) => 1 - (1 - v) * (1 - Math.min(v * w * 1.5 * bloom * tint[i]!, 0.95)));
  out = out.map((v, i) => Math.max(v * g.gain[i]! + g.lift[i]! * (1 - v), 0) ** (1 / g.gamma));
  const l = luma(out);
  return out.map((v) => l + (v - l) * g.sat) as unknown as RGB;
}
