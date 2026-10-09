import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CEIL, GLSL_SHOULDER, GLSL_TONE, LIGHT_CEIL, litGround, postField, shoulder, tone } from '../src/client/exposure.ts';
import { ALARM_COLOR, BEACON_COLOR, EXIT_COLOR, FLOOD_COLOR, LAMP_COLOR, TUBE_COLOR, WINDOW_COLOR, WORK_COLOR } from '../src/client/fixturelight.ts';
import { gradeFor } from '../src/client/fxparams.ts';
import { ambientFor, parseColor, TIERS, type RGB } from '../src/client/lighting.ts';
import { SCENE_FRAG } from '../src/client/lightshaders.ts';
import { MOODS } from '../src/client/mood.ts';
import { CAP, GLOW_CAP, glowAlpha } from '../src/client/nightfx.ts';
import { PRESET_IDS, knobsFor } from '../src/client/quality.ts';

/**
 * No map may sear the eyes. A lit floor (a quay lined with sodium lamps, a wet street, a snow field under a window) must read as
 * warm light, never as a flat blowout. This drives the real exposure math (exposure.ts, which the scene shader is built from,
 * and the post pass's mirror) over every map's mood at every graphics preset, at its worst: any number of lamps stacked on one
 * spot, every light colour the maps use, the brightest floor the art bible allows, a puddle and a glint on it, fog lit through.
 *
 * Thresholds are on the 0..255 picture: luma (Rec.709) of a lit floor stays under HOT, and no channel reaches CLIP. The same
 * numbers flag a screenshot in the in-game sweep (.claude/skills/verify/scripts/brightness.ts).
 */
const HOT = 215;
const CLIP = 250;
const luma = (c: readonly number[]) => 255 * (0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!);
const top = (c: readonly number[]) => 255 * Math.max(c[0]!, c[1]!, c[2]!);

/** Every light colour a map throws on its floor: fixtures, the harbour's sodium, ship lamps, the lighthouse, fire, plain white. */
const LIGHTS: readonly string[] = [LAMP_COLOR, WORK_COLOR, TUBE_COLOR, EXIT_COLOR, WINDOW_COLOR, BEACON_COLOR, ALARM_COLOR, FLOOD_COLOR, '#ffa94d', '#fff0d0', '#ffe9b0', '#ff9a3c', '#fff0c8', '#ffffff'];
/** Floors: the night-op concrete, the harbour's quay and cobble, bone paint (the brightest floor paint allowed), snow, sand. */
const FLOORS: readonly RGB[] = ['#615d54', '#6f7479', '#9a9d9a', '#7d776a', '#b79a4a', '#d2cab4', '#c9d3dc', '#cdb48a', '#8a6a46'].map((c) => parseColor(c));
/** Raw light buffer levels: nothing, a pool's edge, a lamp's heart, and a dozen lamps stacked. */
const RAW = [0, 0.1, 0.25, 0.5, 1, 2, 4, 12];

const versus = Object.entries(MOODS);

test('the scene shader is built from the exposure constants (no hand-copied numbers to drift)', () => {
  assert.ok(SCENE_FRAG.includes(GLSL_TONE), 'tone curve');
  assert.ok(SCENE_FRAG.includes(GLSL_SHOULDER.trim()), 'shoulder');
  assert.ok(/lit = shoulder\(lit, unlit, /.test(SCENE_FRAG), 'the shoulder runs on the lit ground');
  assert.ok(!/L \* 1\.15|glint \* 2\.4/.test(SCENE_FRAG), 'the old 1.15x puddle and 2.4x glint are gone');
});

test('tone curve: a mood\'s gain steepens it but never lifts the ceiling', () => {
  for (const [id, m] of versus) {
    const g = ambientFor(m.dusk, false, m).gain;
    for (const r of RAW) for (const c of tone([r, r, r], g)) assert.ok(c <= LIGHT_CEIL + 1e-9, `${id} raw ${r}`);
  }
  const soft = tone([0.3, 0.3, 0.3], 1)[0], hard = tone([0.3, 0.3, 0.3], 1.5)[0];
  assert.ok(hard > soft, 'more gain is a brighter pool');
});

test('shoulder: passes darks untouched, rolls highlights under CEIL, keeps hue, and never dims an unlit bright surface', () => {
  assert.deepEqual(shoulder([0.3, 0.2, 0.1], 0.1), [0.3, 0.2, 0.1]);
  const hot = shoulder([2, 1.2, 0.5], 0.1);
  assert.ok(Math.max(...hot) < CEIL + 1e-9);
  assert.ok(Math.abs(hot[1] / hot[0] - 0.6) < 1e-9, 'same hue');
  const day = shoulder([0.75, 0.7, 0.6], 0.75);
  assert.deepEqual(day, [0.75, 0.7, 0.6], 'a surface already that bright unlit is left alone');
  const glass = shoulder([1, 0.9, 0.7], 0.2, 1);
  assert.ok(glass[0] > 0.95, 'lamp glass (a near-white surface) stays a bright source');
});

test('every map, every preset with the lighting pass: no lit floor blows out, even under a dozen stacked lamps on wet ground', () => {
  const worst: string[] = [];
  for (const preset of PRESET_IDS) {
    const k = knobsFor(preset);
    if (!k.lighting) continue;
    const weather = TIERS[k.tier]!.weather;
    for (const [id, m] of versus) {
      const amb = ambientFor(m.dusk, false, m);
      const grade = gradeFor({ night: m.dusk, storm: false });
      const bloom = grade.bloomStrength * k.bloom * amb.glow * (1 + 0.35 * Math.min(1, m.dusk));
      let peak = { y: 0, c: 0, at: '' };
      for (const col of LIGHTS) {
        const rgb = parseColor(col);
        for (const base of FLOORS) {
          // A pale surface on a day map is already near HOT with no lamp on it (daylight, not glare); there lights may add a
          // little, never a blowout. On every night map the unlit floor is far darker and HOT alone governs.
          const unlit = postField(litGround({ base, raw: [0, 0, 0], amb: amb.rgb, gain: amb.gain }), grade, bloom);
          const hot = Math.max(HOT, luma(unlit) + 32), clip = CLIP;
          for (const r of RAW) for (const pud of [0, 1]) for (const glint of [0, 1]) for (const fogCover of [0, 1]) {
          const ground = litGround({
            base, raw: rgb.map((v) => v * r) as unknown as RGB, amb: amb.rgb, gain: amb.gain,
            wet: weather ? amb.wet : 0, pud, glint, fog: weather && amb.fog ? amb.fog.rgb : undefined, fogCover,
          });
          const px = postField(ground, grade, bloom);
          const y = luma(px), c = top(px);
          if (y - hot > peak.y - HOT || c - clip > peak.c - CLIP) peak = { y: y - hot + HOT, c: c - clip + CLIP, at: `${col} on ${base.map((v) => v.toFixed(2))} raw ${r}, unlit luma ${luma(unlit).toFixed(0)}` };
        }
        }
      }
      if (peak.y >= HOT || peak.c >= CLIP) worst.push(`${id} @ ${preset}: luma ${peak.y.toFixed(0)}, top channel ${peak.c.toFixed(0)} against the limits (${peak.at})`);
    }
  }
  assert.deepEqual(worst, [], 'searing floors');
});

test('Low (the plain canvas night): the pools\' ceilings keep a lit floor under the same thresholds on every map', () => {
  const worst: string[] = [];
  for (const [id, m] of versus) {
    const amb = ambientFor(m.dusk, false, m);
    const shade = Math.max(CAP, ...amb.rgb), a = glowAlpha(m.dusk);
    const glow = [GLOW_CAP, GLOW_CAP * 0.85, GLOW_CAP * 0.7].map((v) => v * a);
    for (const base of FLOORS) {
      // Multiply by the light at its ceiling, then screen the glow at its ceiling: the brightest a floor can get on Low.
      const px = base.map((b, i) => 1 - (1 - b * shade) * (1 - glow[i]!));
      if (luma(px) >= HOT || top(px) >= CLIP) worst.push(`${id}: luma ${luma(px).toFixed(0)} on ${base.map((v) => v.toFixed(2))}`);
    }
  }
  assert.deepEqual(worst, []);
});

test('lights still read: a lamp\'s pool is clearly brighter than the dark around it on every night map', () => {
  for (const [id, m] of versus) {
    if (m.dusk < 0.85) continue;
    const amb = ambientFor(m.dusk, false, m);
    const base = parseColor('#615d54'), lamp = parseColor(LAMP_COLOR);
    const dark = luma(litGround({ base, raw: [0, 0, 0], amb: amb.rgb, gain: amb.gain }));
    const pool = luma(litGround({ base, raw: lamp.map((v) => v * 0.5) as unknown as RGB, amb: amb.rgb, gain: amb.gain }));
    assert.ok(pool > dark * 1.6 && pool - dark > 25, `${id}: pool ${pool.toFixed(0)} vs dark ${dark.toFixed(0)}`);
  }
});
