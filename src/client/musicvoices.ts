/**
 * The extra voices of the per-map scores: reeds, plucks, mallets, brushes, hand percussion and the odd machine.
 * Everything is built from oscillators, filtered noise and envelopes (no samples). Most voices are one `ToneSpec`
 * read by a single `tone` builder, so a new instrument is a table row, and a note costs a handful of nodes.
 */
import { midiToHz, type Inst } from './musictheory.ts';

/** The rig's little toolbox of nodes, handed in so these voices run live and offline alike. */
export type Kit = {
  ctx: BaseAudioContext;
  noise: AudioBuffer;
  env(dest: AudioNode, t: number, peak: number, attack: number, hold: number, release: number): GainNode;
  osc(type: OscillatorType, hz: number, t: number, end: number, dest: AudioNode, detune?: number): OscillatorNode;
};
/** One note: start time, midi pitch (ignored by most drums), length in seconds, velocity 0..1, where it goes, and (an 808) the pitch it glides in from. */
export type Voice = (t: number, midi: number, dur: number, v: number, dest: AudioNode, from?: number) => void;

type Part = {
  w: OscillatorType;
  /** Frequency ratio to the note. */
  r?: number;
  /** Gain of this part. */
  g?: number;
  /** Multiplier on the release, so upper partials die sooner. */
  d?: number;
  /** Detune, cents. */
  c?: number;
};
type ToneSpec = {
  parts: readonly Part[];
  level: number;
  /** Attack, seconds. */
  att: number;
  /** Fraction of the note's length that is held at full level (0 is a pluck that decays at once). */
  sus: number;
  /** Release or decay, seconds. */
  rel: number;
  filt?: { type: BiquadFilterType; f0: number; f1: number; tf: number; q: number };
  vib?: { rate: number; cents: number; delay: number };
  trem?: { rate: number; depth: number };
  /** The note starts `cents` off and slides in over `time` seconds. */
  glide?: { cents: number; time: number };
  /** A burst of breath or pick noise at the start. */
  chiff?: { hz: number; q: number; level: number; ms: number };
};

const P = (w: OscillatorType, r = 1, g = 1, d = 1, c = 0): Part => ({ w, r, g, d, c });

const TONES: Partial<Record<Inst, ToneSpec>> = {
  fife: { parts: [P('square', 1, 0.5), P('triangle', 2, 0.5)], level: 0.08, att: 0.02, sus: 0.9, rel: 0.08, vib: { rate: 5.5, cents: 12, delay: 0.12 }, filt: { type: 'highpass', f0: 700, f1: 700, tf: 0.1, q: 0.5 }, chiff: { hz: 3200, q: 1, level: 0.05, ms: 40 } },
  harp: { parts: [P('triangle'), P('sine', 2, 0.4, 0.5), P('sine', 3, 0.15, 0.3)], level: 0.22, att: 0.002, sus: 0, rel: 0.6 },
  accordion: { parts: [P('sawtooth', 1, 1, 1, -9), P('sawtooth', 1, 1, 1, 9), P('square', 1, 0.5), P('sawtooth', 2, 0.25, 1, 3)], level: 0.05, att: 0.03, sus: 1, rel: 0.1, filt: { type: 'lowpass', f0: 2200, f1: 3200, tf: 0.05, q: 0.7 }, trem: { rate: 6.5, depth: 0.14 } },
  foghorn: { parts: [P('sawtooth', 1, 1, 1, -6), P('square', 1, 0.6, 1, 6), P('sine', 0.5, 0.8)], level: 0.2, att: 0.12, sus: 1, rel: 0.5, filt: { type: 'lowpass', f0: 220, f1: 600, tf: 0.15, q: 1.5 }, glide: { cents: 45, time: 0.3 } },
  gull: { parts: [P('triangle'), P('sine', 2, 0.35)], level: 0.13, att: 0.02, sus: 0.85, rel: 0.12, filt: { type: 'lowpass', f0: 3200, f1: 3200, tf: 0.1, q: 0.5 }, vib: { rate: 7, cents: 25, delay: 0.05 }, glide: { cents: -250, time: 0.06 } },
  koto: { parts: [P('sawtooth', 1, 0.7), P('triangle', 2, 0.4, 0.5), P('sine', 3.01, 0.2, 0.3)], level: 0.13, att: 0.002, sus: 0, rel: 0.65, filt: { type: 'lowpass', f0: 5000, f1: 700, tf: 0.3, q: 1.2 }, glide: { cents: 35, time: 0.04 } },
  chime: { parts: [P('sine'), P('sine', 2.76, 0.45, 0.6), P('sine', 5.4, 0.2, 0.35), P('sine', 8.93, 0.08, 0.2)], level: 0.1, att: 0.002, sus: 0, rel: 1.8 },
  epiano: { parts: [P('sine'), P('sine', 2, 0.3, 0.6), P('sine', 7, 0.1, 0.12), P('triangle', 0.5, 0.3)], level: 0.2, att: 0.003, sus: 0.15, rel: 0.9, trem: { rate: 4.5, depth: 0.25 } },
  vibes: { parts: [P('sine'), P('sine', 4, 0.22, 0.35), P('sine', 10, 0.08, 0.12)], level: 0.22, att: 0.002, sus: 0, rel: 1.6, trem: { rate: 5.2, depth: 0.5 } },
  trumpet: { parts: [P('sawtooth', 1, 1, 1, -5), P('sawtooth', 1, 1, 1, 5), P('square', 1, 0.4)], level: 0.09, att: 0.035, sus: 0.9, rel: 0.1, filt: { type: 'lowpass', f0: 700, f1: 2400, tf: 0.09, q: 3 }, vib: { rate: 5.4, cents: 14, delay: 0.2 }, chiff: { hz: 2500, q: 1, level: 0.03, ms: 30 } },
  upright: { parts: [P('triangle'), P('sine', 1, 0.6), P('sine', 2, 0.15, 0.3)], level: 0.32, att: 0.006, sus: 0.5, rel: 0.22, filt: { type: 'lowpass', f0: 900, f1: 350, tf: 0.3, q: 0.7 }, chiff: { hz: 1800, q: 1, level: 0.05, ms: 20 } },
  sonar: { parts: [P('sine'), P('sine', 2.01, 0.12, 0.5)], level: 0.2, att: 0.004, sus: 0, rel: 1.4 },
  tbass: { parts: [P('sawtooth'), P('square', 0.5, 0.6)], level: 0.42, att: 0.004, sus: 0.35, rel: 0.08, filt: { type: 'lowpass', f0: 1600, f1: 160, tf: 0.12, q: 7 } },
  acid: { parts: [P('sawtooth')], level: 0.09, att: 0.003, sus: 0.5, rel: 0.1, filt: { type: 'lowpass', f0: 3200, f1: 380, tf: 0.16, q: 9 } },
  metal: { parts: [P('square', 1, 0.5), P('square', 1.47, 0.4, 0.8), P('square', 2.09, 0.3, 0.6), P('square', 2.56, 0.25, 0.5)], level: 0.05, att: 0.001, sus: 0, rel: 0.5, filt: { type: 'bandpass', f0: 2200, f1: 1500, tf: 0.3, q: 1.5 } },
  whistle: { parts: [P('sine'), P('sine', 2, 0.08)], level: 0.15, att: 0.045, sus: 1, rel: 0.12, vib: { rate: 5.8, cents: 20, delay: 0.18 }, glide: { cents: -120, time: 0.05 }, chiff: { hz: 2800, q: 2, level: 0.05, ms: 60 } },
  uke: { parts: [P('triangle'), P('square', 1, 0.3, 1, 6), P('triangle', 2, 0.3, 0.5)], level: 0.15, att: 0.002, sus: 0, rel: 0.35, filt: { type: 'lowpass', f0: 3500, f1: 1100, tf: 0.2, q: 0.8 } },
  marimba: { parts: [P('sine'), P('sine', 4, 0.35, 0.15), P('sine', 9.2, 0.1, 0.06)], level: 0.3, att: 0.001, sus: 0, rel: 0.5 },
  harmonica: { parts: [P('sawtooth', 1, 1, 1, -8), P('square', 1, 0.5, 1, 8)], level: 0.2, att: 0.04, sus: 0.9, rel: 0.1, filt: { type: 'bandpass', f0: 1900, f1: 1900, tf: 0.1, q: 1.3 }, vib: { rate: 6, cents: 18, delay: 0.25 }, glide: { cents: -100, time: 0.05 }, chiff: { hz: 3500, q: 1, level: 0.05, ms: 40 } },
  rbell: { parts: [P('sine'), P('sine', 1.5, 0.5, 0.6), P('sine', 2.4, 0.3, 0.4)], level: 0.16, att: 0.001, sus: 0, rel: 0.9 },
  yodel: { parts: [P('sine'), P('triangle', 2, 0.25)], level: 0.16, att: 0.02, sus: 0.85, rel: 0.1, filt: { type: 'bandpass', f0: 1000, f1: 1500, tf: 0.2, q: 0.8 }, vib: { rate: 7.5, cents: 45, delay: 0.02 }, glide: { cents: -400, time: 0.07 } },
  twang: { parts: [P('sawtooth'), P('square', 1, 0.35, 1, 4)], level: 0.1, att: 0.002, sus: 0.3, rel: 0.55, filt: { type: 'lowpass', f0: 3800, f1: 1100, tf: 0.25, q: 2.5 }, trem: { rate: 6.5, depth: 0.28 }, glide: { cents: -30, time: 0.03 } },
  bgtr: { parts: [P('sawtooth'), P('triangle', 0.5, 0.7)], level: 0.26, att: 0.004, sus: 0.6, rel: 0.4, filt: { type: 'lowpass', f0: 1400, f1: 450, tf: 0.35, q: 1.2 }, glide: { cents: 25, time: 0.05 } },
  tuba: { parts: [P('sawtooth'), P('sine')], level: 0.45, att: 0.01, sus: 0.55, rel: 0.1, filt: { type: 'lowpass', f0: 700, f1: 350, tf: 0.2, q: 0.8 } },
  fbass: { parts: [P('sine'), P('triangle', 2, 0.25), P('sawtooth', 1, 0.3)], level: 0.5, att: 0.004, sus: 0.55, rel: 0.12, filt: { type: 'lowpass', f0: 1400, f1: 300, tf: 0.15, q: 1 } },
  padair: { parts: [P('triangle', 1, 1, 1, -8), P('triangle', 1, 1, 1, 8), P('sine', 2, 0.3), P('sine', 3, 0.12)], level: 0.05, att: 0.55, sus: 1, rel: 0.7, filt: { type: 'lowpass', f0: 3000, f1: 3000, tf: 0.1, q: 0.5 }, trem: { rate: 0.3, depth: 0.3 } },
  dread: { parts: [P('sawtooth', 1, 1, 1, -12), P('sawtooth', 1.0595, 0.7), P('sawtooth', 0.5, 0.6)], level: 0.08, att: 0.7, sus: 1, rel: 0.8, filt: { type: 'lowpass', f0: 220, f1: 520, tf: 1.2, q: 2 } },
  clank: { parts: [P('square', 1, 0.5), P('square', 2.76, 0.5, 0.6), P('sine', 5.4, 0.4, 0.35), P('sine', 8.9, 0.25, 0.2)], level: 0.1, att: 0.001, sus: 0, rel: 0.7, chiff: { hz: 3000, q: 1, level: 0.1, ms: 30 } },
  // Stand-ins for the sampled instruments (musicsamples.ts) while their samples load, or if they never do.
  piano: { parts: [P('triangle'), P('sine', 2, 0.45, 0.5), P('sine', 3, 0.18, 0.3), P('sine', 4.02, 0.08, 0.2)], level: 0.24, att: 0.002, sus: 0, rel: 1.1, filt: { type: 'lowpass', f0: 4200, f1: 1400, tf: 0.5, q: 0.6 } },
  honky: { parts: [P('triangle', 1, 1, 1, -14), P('triangle', 1, 1, 1, 14), P('sine', 2, 0.4, 0.5)], level: 0.16, att: 0.002, sus: 0, rel: 0.7, filt: { type: 'lowpass', f0: 4000, f1: 1500, tf: 0.3, q: 0.6 } },
  tpt: { parts: [P('sawtooth', 1, 1, 1, -4), P('sawtooth', 1, 1, 1, 4), P('square', 1, 0.3)], level: 0.085, att: 0.03, sus: 0.9, rel: 0.1, filt: { type: 'lowpass', f0: 900, f1: 3400, tf: 0.07, q: 2 }, vib: { rate: 5.5, cents: 12, delay: 0.25 } },
  horn: { parts: [P('sawtooth'), P('triangle', 1, 0.8, 1, 5)], level: 0.11, att: 0.06, sus: 0.9, rel: 0.18, filt: { type: 'lowpass', f0: 500, f1: 1300, tf: 0.12, q: 0.9 }, vib: { rate: 5, cents: 8, delay: 0.3 } },
  bone: { parts: [P('sawtooth'), P('sawtooth', 1, 0.6, 1, 6)], level: 0.1, att: 0.04, sus: 0.9, rel: 0.12, filt: { type: 'lowpass', f0: 450, f1: 1700, tf: 0.1, q: 1.4 } },
  timp: { parts: [P('sine'), P('sine', 1.51, 0.45, 0.5), P('sine', 1.99, 0.25, 0.4)], level: 0.5, att: 0.003, sus: 0, rel: 1.3, glide: { cents: 70, time: 0.06 }, chiff: { hz: 300, q: 0.8, level: 0.2, ms: 50 } },
  bell: { parts: [P('sine'), P('sine', 2, 0.55, 0.8), P('sine', 2.76, 0.4, 0.6), P('sine', 5.4, 0.2, 0.3)], level: 0.13, att: 0.002, sus: 0, rel: 3.2 },
  pbass: { parts: [P('sawtooth', 1, 0.6), P('sine')], level: 0.42, att: 0.003, sus: 0.6, rel: 0.1, filt: { type: 'lowpass', f0: 2600, f1: 500, tf: 0.12, q: 1.2 } },
  slap: { parts: [P('sawtooth', 1, 0.5), P('sine'), P('sine', 2, 0.3, 0.3)], level: 0.4, att: 0.002, sus: 0.4, rel: 0.1, filt: { type: 'lowpass', f0: 4200, f1: 450, tf: 0.08, q: 2 }, chiff: { hz: 2600, q: 1, level: 0.12, ms: 15 } },
  steel: { parts: [P('triangle'), P('sawtooth', 1, 0.3, 0.6)], level: 0.16, att: 0.002, sus: 0, rel: 1, filt: { type: 'lowpass', f0: 4200, f1: 1300, tf: 0.3, q: 0.8 }, glide: { cents: -200, time: 0.09 } },
  dist: { parts: [P('sawtooth', 1, 1, 1, -10), P('square', 1, 0.6, 1, 10), P('sawtooth', 2, 0.3)], level: 0.06, att: 0.003, sus: 0.85, rel: 0.06, filt: { type: 'lowpass', f0: 2600, f1: 1800, tf: 0.2, q: 1.6 } },
  od: { parts: [P('sawtooth', 1, 1, 1, -6), P('square', 1, 0.5, 1, 6)], level: 0.06, att: 0.005, sus: 0.9, rel: 0.12, filt: { type: 'lowpass', f0: 3000, f1: 2000, tf: 0.2, q: 2 }, vib: { rate: 5.8, cents: 18, delay: 0.25 } },
  organ: { parts: [P('sine'), P('sine', 2, 0.7), P('sine', 4, 0.35)], level: 0.06, att: 0.006, sus: 1, rel: 0.05, trem: { rate: 6.3, depth: 0.25 } },
  bandoneon: { parts: [P('sawtooth', 1, 1, 1, -6), P('sawtooth', 1, 1, 1, 6), P('square', 0.5, 0.4)], level: 0.05, att: 0.015, sus: 1, rel: 0.06, filt: { type: 'lowpass', f0: 1700, f1: 2400, tf: 0.05, q: 1 }, trem: { rate: 5, depth: 0.08 } },
  violin: { parts: [P('sawtooth', 1, 1, 1, -4), P('sawtooth', 1, 0.7, 1, 5)], level: 0.06, att: 0.06, sus: 0.95, rel: 0.15, filt: { type: 'lowpass', f0: 2800, f1: 3400, tf: 0.1, q: 1.2 }, vib: { rate: 5.6, cents: 20, delay: 0.15 } },
  fiddle: { parts: [P('sawtooth', 1, 1, 1, -5), P('sawtooth', 1, 0.6, 1, 6)], level: 0.06, att: 0.02, sus: 0.9, rel: 0.1, filt: { type: 'lowpass', f0: 3200, f1: 3200, tf: 0.1, q: 1.4 }, vib: { rate: 6, cents: 16, delay: 0.12 } },
  flute: { parts: [P('sine'), P('sine', 2, 0.18), P('triangle', 3, 0.05)], level: 0.16, att: 0.05, sus: 0.95, rel: 0.12, vib: { rate: 5, cents: 14, delay: 0.2 }, chiff: { hz: 2400, q: 1.5, level: 0.06, ms: 70 } },
  sax: { parts: [P('sawtooth'), P('square', 1, 0.5, 1, 4)], level: 0.075, att: 0.02, sus: 0.9, rel: 0.1, filt: { type: 'lowpass', f0: 700, f1: 2300, tf: 0.08, q: 2.2 }, vib: { rate: 5.2, cents: 16, delay: 0.25 } },
  synbrass: { parts: [P('sawtooth', 1, 1, 1, -10), P('sawtooth', 1, 1, 1, 10)], level: 0.06, att: 0.01, sus: 0.8, rel: 0.1, filt: { type: 'lowpass', f0: 700, f1: 3800, tf: 0.09, q: 1.5 } },
  choir: { parts: [P('triangle', 1, 1, 1, -9), P('triangle', 1, 1, 1, 9), P('sine', 2, 0.25)], level: 0.06, att: 0.35, sus: 1, rel: 0.6, filt: { type: 'lowpass', f0: 1800, f1: 1800, tf: 0.1, q: 0.7 }, vib: { rate: 4.5, cents: 10, delay: 0.3 } },
  // Synth leads and bass: an 8-bit square, a synthwave saw, a squelchy synth bass.
  square: { parts: [P('square')], level: 0.055, att: 0.002, sus: 0.85, rel: 0.03, vib: { rate: 6.5, cents: 22, delay: 0.2 } },
  saw: { parts: [P('sawtooth', 1, 1, 1, -9), P('sawtooth', 1, 1, 1, 9), P('sawtooth', 2, 0.2)], level: 0.055, att: 0.01, sus: 0.9, rel: 0.25, filt: { type: 'lowpass', f0: 1200, f1: 3200, tf: 0.15, q: 1.5 }, vib: { rate: 5.5, cents: 12, delay: 0.3 } },
  synbass: { parts: [P('sawtooth'), P('square', 0.5, 0.5)], level: 0.3, att: 0.003, sus: 0.6, rel: 0.06, filt: { type: 'lowpass', f0: 1500, f1: 260, tf: 0.12, q: 4 } },
  // The pop themes: a two-saw synth pluck whose filter snaps shut, and the eight-bit triangle bass (no filter, no frills).
  pluck: { parts: [P('sawtooth', 1, 1, 1, -7), P('sawtooth', 1, 1, 1, 7)], level: 0.075, att: 0.002, sus: 0, rel: 0.38, filt: { type: 'lowpass', f0: 4200, f1: 520, tf: 0.2, q: 2 } },
  tri: { parts: [P('triangle')], level: 0.4, att: 0.002, sus: 0.85, rel: 0.04 },
};

/** Builds the pitched voices from the table. */
function tone(k: Kit, s: ToneSpec): Voice {
  const { ctx } = k;
  return (t, midi, dur, v, dest) => {
    const hz = midiToHz(midi);
    let sink: AudioNode = dest;
    const hold = s.sus * Math.max(0, dur - s.att);
    const maxD = s.parts.reduce((m, p) => Math.max(m, p.d ?? 1), 0);
    const end = t + s.att + hold + s.rel * maxD + 0.1;
    if (s.trem) {
      const g = ctx.createGain();
      g.gain.value = 1 - s.trem.depth / 2;
      const lfo = ctx.createOscillator(), depth = ctx.createGain();
      lfo.frequency.value = s.trem.rate; depth.gain.value = s.trem.depth / 2;
      lfo.connect(depth).connect(g.gain); lfo.start(t); lfo.stop(end);
      g.connect(sink); sink = g;
    }
    if (s.filt) {
      const f = ctx.createBiquadFilter();
      f.type = s.filt.type; f.Q.value = s.filt.q;
      f.frequency.setValueAtTime(s.filt.f0, t);
      if (s.filt.f1 !== s.filt.f0) f.frequency.exponentialRampToValueAtTime(s.filt.f1, t + Math.max(0.02, s.filt.tf));
      f.connect(sink); sink = f;
    }
    let lfoGain: GainNode | null = null;
    if (s.vib && dur > s.vib.delay + 0.1) {
      const lfo = ctx.createOscillator();
      lfoGain = ctx.createGain();
      lfo.frequency.value = s.vib.rate;
      lfoGain.gain.setValueAtTime(0, t); lfoGain.gain.setValueAtTime(0, t + s.vib.delay); lfoGain.gain.linearRampToValueAtTime(s.vib.cents, t + s.vib.delay + 0.25);
      lfo.connect(lfoGain); lfo.start(t); lfo.stop(end);
    }
    for (const p of s.parts) {
      const g = k.env(sink, t, s.level * v * (p.g ?? 1), s.att, hold, s.rel * (p.d ?? 1));
      const o = k.osc(p.w, hz * (p.r ?? 1), t, end, g, p.c ?? 0);
      if (s.glide) { o.detune.setValueAtTime((p.c ?? 0) + s.glide.cents, t); o.detune.linearRampToValueAtTime(p.c ?? 0, t + s.glide.time); }
      if (lfoGain) lfoGain.connect(o.detune);
    }
    if (s.chiff) burst(k, t, 0.002, s.chiff.ms / 1000, 'bandpass', s.chiff.hz, s.chiff.q, s.chiff.level * v, dest);
  };
}

/** A short filtered noise hit: `att` to its peak, then a decay over `dur`; the cutoff may slide to `hz2`. */
function burst(k: Kit, t: number, att: number, dur: number, type: BiquadFilterType, hz: number, q: number, peak: number, dest: AudioNode, hz2?: number) {
  const src = k.ctx.createBufferSource();
  src.buffer = k.noise;
  const f = k.ctx.createBiquadFilter();
  f.type = type; f.Q.value = q; f.frequency.setValueAtTime(hz, t);
  if (hz2) f.frequency.exponentialRampToValueAtTime(hz2, t + att + dur);
  const g = k.env(dest, t, peak, att, 0, dur);
  src.connect(f).connect(g);
  // Each burst starts at its own place in the noise, so hits struck together do not add as one coherent sound.
  src.start(t, (t * 7.31 + (hits++ % 61) * 0.137) % 0.5, att + dur + 0.05);
}
let hits = 0;

/** The instruments the scores add to the original ten (kick, snare, hat, tom, bass, pad, glock, stab, lead, heart). */
export const EXTRA_INSTS: readonly Inst[] = [
  ...(Object.keys(TONES) as Inst[]),
  'brush', 'swirl', 'clap', 'bongo', 'sleigh', 'shaker', 'rim', 'chug', 'ohat', 'stomp', 'scrape', 'dust', 'wind', 'drone',
  'k909', 'kbb', 'krock', 'sbb', 'srock', 'sgate', 'crash', 'ride', 'chip', 'tamb',
  'b808', 'b808d', 'cowbell', 'snap', 'riser', 'impact',
];

/** All the voices the scores add, keyed by instrument. */
export function createVoices(k: Kit): Partial<Record<Inst, Voice>> {
  const { ctx } = k;
  const voices: Partial<Record<Inst, Voice>> = {};
  for (const [id, spec] of Object.entries(TONES)) voices[id as Inst] = tone(k, spec);

  voices.brush = (t, _m, _d, v, dest) => burst(k, t, 0.015, 0.13, 'highpass', 4500, 0.5, 0.13 * v, dest);
  voices.swirl = (t, _m, _d, v, dest) => burst(k, t, 0.08, 0.22, 'bandpass', 3000, 0.8, 0.1 * v, dest, 6000);
  voices.clap = (t, _m, _d, v, dest) => {
    for (const o of [0, 0.012, 0.026]) burst(k, t + o, 0.001, 0.03, 'bandpass', 1500, 1.2, 0.24 * v, dest);
    burst(k, t + 0.03, 0.002, 0.13, 'bandpass', 1400, 1, 0.2 * v, dest);
  };
  voices.bongo = (t, midi, _d, v, dest) => {
    const hz = midiToHz(midi || 66);
    const g = k.env(dest, t, 0.45 * v, 0.001, 0.005, 0.13);
    const o = k.osc('sine', hz * 1.15, t, t + 0.25, g);
    o.frequency.exponentialRampToValueAtTime(hz * 0.9, t + 0.07);
    burst(k, t, 0.001, 0.02, 'bandpass', 1800, 1, 0.1 * v, dest);
  };
  voices.sleigh = (t, _m, _d, v, dest) => {
    burst(k, t, 0.002, 0.12, 'highpass', 8000, 0.6, 0.1 * v, dest);
    for (const hz of [4100, 5230, 6340]) { const g = k.env(dest, t, 0.018 * v, 0.001, 0, 0.11); k.osc('sine', hz, t, t + 0.2, g); }
  };
  voices.shaker = (t, _m, _d, v, dest) => burst(k, t, 0.01, 0.05, 'bandpass', 6500, 0.8, 0.13 * v, dest);
  voices.rim = (t, _m, _d, v, dest) => {
    const g = k.env(dest, t, 0.22 * v, 0.001, 0, 0.025); k.osc('sine', 1700, t, t + 0.06, g);
    const w = k.env(dest, t, 0.14 * v, 0.001, 0, 0.04); k.osc('triangle', 420, t, t + 0.08, w);
    burst(k, t, 0.001, 0.02, 'highpass', 3000, 0.5, 0.14 * v, dest);
  };
  voices.chug = (t, _m, _d, v, dest) => burst(k, t, 0.012, 0.11, 'bandpass', 1200, 0.9, 0.26 * v, dest, 3600);
  voices.ohat = (t, _m, _d, v, dest) => burst(k, t, 0.002, 0.22, 'highpass', 7000, 0.6, 0.17 * v, dest);
  voices.stomp = (t, _m, _d, v, dest) => {
    const g = k.env(dest, t, 0.85 * v, 0.002, 0.02, 0.25);
    const o = k.osc('sine', 120, t, t + 0.35, g);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.1);
    burst(k, t, 0.002, 0.1, 'lowpass', 500, 0.7, 0.3 * v, dest);
  };
  voices.scrape = (t, _m, dur, v, dest) => burst(k, t, 0.1, Math.max(0.3, dur), 'bandpass', 2500, 8, 0.1 * v, dest, 600);
  voices.dust = (t, _m, _d, v, dest) => burst(k, t, 0.0005, 0.008, 'highpass', 1500, 0.5, 0.12 * v, dest);
  voices.wind = (t, _m, dur, v, dest) => {
    const src = ctx.createBufferSource();
    src.buffer = k.noise; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 1.5;
    f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(900, t + dur * 0.5); f.frequency.exponentialRampToValueAtTime(350, t + dur);
    const g = k.env(dest, t, 0.07 * v, dur * 0.4, 0, dur * 0.5);
    src.connect(f).connect(g);
    src.start(t, 0, dur + 0.1); src.stop(t + dur * 0.9 + 0.2);
  };
  // ---- the genre kits ----
  const thump = (t: number, v: number, dest: AudioNode, hz0: number, hz1: number, fall: number, decay: number, peak: number) => {
    const g = k.env(dest, t, peak * v, 0.002, 0.015, decay);
    const o = k.osc('sine', hz0, t, t + decay + 0.15, g);
    o.frequency.exponentialRampToValueAtTime(hz1, t + fall);
  };
  // A 909: a long, punchy sine drop with a sharp click.
  voices.k909 = (t, _m, _d, v, dest) => { thump(t, v, dest, 210, 48, 0.09, 0.42, 0.95); burst(k, t, 0.0005, 0.012, 'highpass', 3500, 0.6, 0.28 * v, dest); };
  // Boom-bap: round and dull, the top rolled off like an old record.
  voices.kbb = (t, _m, _d, v, dest) => { thump(t, v, dest, 120, 50, 0.12, 0.3, 0.9); burst(k, t, 0.002, 0.03, 'lowpass', 900, 0.7, 0.25 * v, dest); };
  // A rock kick: a beater's slap on top of the drop.
  voices.krock = (t, _m, _d, v, dest) => { thump(t, v, dest, 160, 55, 0.07, 0.24, 0.95); burst(k, t, 0.0005, 0.02, 'bandpass', 3200, 1, 0.3 * v, dest); };
  voices.sbb = (t, _m, _d, v, dest) => {
    burst(k, t, 0.002, 0.15, 'bandpass', 1700, 0.8, 0.42 * v, dest);
    const g = k.env(dest, t, 0.22 * v, 0.001, 0.01, 0.09); k.osc('triangle', 185, t, t + 0.15, g);
  };
  voices.srock = (t, _m, _d, v, dest) => {
    burst(k, t, 0.001, 0.2, 'bandpass', 2200, 0.6, 0.5 * v, dest);
    burst(k, t, 0.001, 0.08, 'highpass', 5500, 0.5, 0.25 * v, dest);
    const g = k.env(dest, t, 0.35 * v, 0.001, 0.02, 0.1); const o = k.osc('triangle', 200, t, t + 0.2, g); o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
  };
  // The eighties snare: a big burst of room that is shut off dead.
  voices.sgate = (t, _m, _d, v, dest) => {
    const src = ctx.createBufferSource(); src.buffer = k.noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1600; f.Q.value = 0.5;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.42 * v, t + 0.004); g.gain.setValueAtTime(0.3 * v, t + 0.22); g.gain.linearRampToValueAtTime(0.0001, t + 0.26);
    src.connect(f).connect(g).connect(dest); src.start(t, (t * 3.1) % 0.5, 0.3);
    const tg = k.env(dest, t, 0.3 * v, 0.001, 0.01, 0.1); k.osc('triangle', 190, t, t + 0.15, tg);
  };
  voices.crash = (t, _m, _d, v, dest) => { burst(k, t, 0.002, 1.5, 'highpass', 4800, 0.4, 0.13 * v, dest); burst(k, t, 0.002, 0.6, 'bandpass', 8200, 1.5, 0.06 * v, dest); };
  voices.ride = (t, _m, _d, v, dest) => {
    burst(k, t, 0.001, 0.45, 'highpass', 7000, 0.5, 0.05 * v, dest);
    for (const hz of [3150, 4720]) { const g = k.env(dest, t, 0.012 * v, 0.001, 0, 0.5); k.osc('square', hz, t, t + 0.55, g); }
  };
  // 8-bit noise: a short, hard-edged burst; a low `midi` makes it the snare, none the hat.
  voices.chip = (t, midi, _d, v, dest) => {
    const g = ctx.createGain(); const end = t + (midi ? 0.11 : 0.04);
    g.gain.setValueAtTime(0.16 * v, t); g.gain.setValueAtTime(0.16 * v, end - 0.005); g.gain.linearRampToValueAtTime(0.0001, end);
    const src = ctx.createBufferSource(); src.buffer = k.noise;
    const f = ctx.createBiquadFilter(); f.type = midi ? 'bandpass' : 'highpass'; f.frequency.value = midi ? 1400 : 7000; f.Q.value = 0.4;
    src.connect(f).connect(g).connect(dest); src.start(t, (t * 5.3) % 0.5, end - t + 0.02);
  };
  voices.tamb = (t, _m, _d, v, dest) => {
    burst(k, t, 0.002, 0.11, 'highpass', 6500, 0.5, 0.1 * v, dest);
    for (const hz of [5100, 6350, 7600]) { const g = k.env(dest, t, 0.012 * v, 0.001, 0, 0.12); k.osc('sine', hz, t, t + 0.15, g); }
  };
  // The propeller hum: two low saws and a wash of noise, chopped by a rotor at 24 Hz.
  voices.drone = (t, midi, dur, v, dest) => {
    const hz = midiToHz(midi);
    const chop = ctx.createGain();
    chop.gain.value = 0.7;
    const lfo = ctx.createOscillator(), depth = ctx.createGain();
    lfo.frequency.value = 24; depth.gain.value = 0.3;
    lfo.connect(depth).connect(chop.gain);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 300; f.Q.value = 0.8;
    f.connect(chop);
    const g = k.env(dest, t, 0.14 * v, 0.3, Math.max(0, dur - 0.3), 0.5);
    chop.connect(g);
    const end = t + dur + 0.6;
    lfo.start(t); lfo.stop(end);
    k.osc('sawtooth', hz, t, end, f, -8); k.osc('sawtooth', hz * 1.004, t, end, f, 8);
    burst(k, t, 0.3, dur, 'lowpass', 500, 0.5, 0.12 * v, chop);
  };
  // ---- the pop themes' voices ----
  // The 808: a sine sub with a second harmonic so it reads on small speakers, the pitch drop of the drum on its attack, and a glide in from
  // `from` (the slide). `grit` adds a lowpassed square for the distorted phonk 808.
  const b808 = (grit: number): Voice => (t, midi, dur, v, dest, from) => {
    const hz = midiToHz(midi);
    const len = Math.max(0.22, dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.6 * v, t + 0.004);
    g.gain.setValueAtTime(0.6 * v, t + len * 0.75);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.22);
    g.connect(dest);
    const end = t + len + 0.3;
    const parts: [OscillatorType, number, number][] = [['sine', 1, 1], ['sine', 2, 0.22]];
    if (grit) parts.push(['square', 1, grit]);
    for (const [w, r, lvl] of parts) {
      let sink: AudioNode = g;
      if (lvl !== 1) { const pg = ctx.createGain(); pg.gain.value = lvl; pg.connect(g); sink = pg; }
      if (w === 'square') { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900; f.Q.value = 0.7; f.connect(sink); sink = f; }
      const o = k.osc(w, hz * r, t, end, sink);
      if (from !== undefined) { o.frequency.setValueAtTime(midiToHz(from) * r, t); o.frequency.exponentialRampToValueAtTime(hz * r, t + Math.min(0.11, len * 0.5)); }
      else { o.frequency.setValueAtTime(hz * r * 2.2, t); o.frequency.exponentialRampToValueAtTime(hz * r, t + 0.035); }
    }
  };
  voices.b808 = b808(0);
  voices.b808d = b808(0.18);
  // The phonk cowbell: the 808's two detuned squares (a ratio of about 1.48) through a band-pass, tuned to the note and short.
  voices.cowbell = (t, midi, dur, v, dest) => {
    const hz = midiToHz(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = hz * 2; f.Q.value = 1.1;
    const g = k.env(dest, t, 0.13 * v, 0.001, 0.01, Math.min(0.34, Math.max(0.12, dur * 0.8)));
    f.connect(g);
    const end = t + 0.5;
    k.osc('square', hz, t, end, f);
    k.osc('square', hz * 1.4836, t, end, f);
    const body = k.env(dest, t, 0.05 * v, 0.001, 0, 0.12);
    k.osc('triangle', hz, t, t + 0.2, body);
  };
  voices.snap = (t, _m, _d, v, dest) => {
    burst(k, t, 0.0005, 0.035, 'bandpass', 2600, 2.5, 0.42 * v, dest);
    burst(k, t + 0.004, 0.0005, 0.06, 'highpass', 4500, 0.6, 0.12 * v, dest);
  };
  // The build's riser: noise sweeping up the band and swelling over the note's length, cut dead on the drop.
  voices.riser = (t, _m, dur, v, dest) => {
    const src = ctx.createBufferSource();
    src.buffer = k.noise; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 2.2;
    f.frequency.setValueAtTime(350, t); f.frequency.exponentialRampToValueAtTime(7500, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.11 * v, t + dur * 0.97); g.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, 0, dur + 0.05); src.stop(t + dur + 0.05);
  };
  // The drop's impact: a sub boom falling away under a burst of low noise.
  voices.impact = (t, _m, _d, v, dest) => {
    thump(t, v, dest, 90, 30, 0.8, 1.3, 0.75);
    burst(k, t, 0.003, 0.7, 'lowpass', 400, 0.7, 0.35 * v, dest, 90);
  };
  return voices;
}
