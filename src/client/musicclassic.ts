/**
 * The original soundtrack, restored exactly as it was first written (commit af4983a, "Layered synthesized sound and an adaptive toy-military
 * soundtrack"): the seeded toy-military march (a new key, progressions and brass tunes each seed), its calm / combat / hype / finale layers and
 * night heartbeat, and its own synthesized voices, kill stings and win/loss cadences. It plays the menu and the Plaza, and is on every radio dial.
 * The generator and voices below are af4983a's code, renamed only where they would clash with today's; the director (music.ts) feeds the bars
 * into one of its decks, so the bus (compressor, hall, duck, mute and volume) is the same one it always had.
 */
import { hash, MID_C, midiToHz, rng, STEPS_PER_BAR, type Bar, type Chord, type Inst, type LayerId, type Mode, type MusicEvent } from './musictheory.ts';
import type { Deck } from './musicsynth.ts';

export const CLASSIC_BARS_PER_PHRASE = 8;
const BARS_PER_PHRASE = CLASSIC_BARS_PER_PHRASE;
const pick = <T,>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length) % list.length]!;
const chance = (r: () => number, p: number) => r() < p;

/** Tonics by pitch class: bright keys for brass. */
export const CLASSIC_KEYS = [0, 2, 5, 7, 10] as const;

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];
const MAJ = [0, 4, 7], MIN = [0, 3, 7], DIM = [0, 3, 6];

type Deg = readonly [rootOffset: number, tones: readonly number[]];
const I: Deg = [0, MAJ], ii: Deg = [2, MIN], iii: Deg = [4, MIN], IV: Deg = [5, MAJ], V: Deg = [7, MAJ], vi: Deg = [9, MIN];
const i: Deg = [0, MIN], iv: Deg = [5, MIN], III: Deg = [3, MAJ], VI: Deg = [8, MAJ], VII: Deg = [10, MAJ], iidim: Deg = [2, DIM];

/** Four-bar loops; a phrase plays one twice and turns round on the dominant. */
const PROGRESSIONS: Record<Mode, readonly (readonly Deg[])[]> = {
  major: [[I, V, vi, IV], [I, vi, IV, V], [I, IV, V, IV], [vi, IV, I, V], [I, iii, IV, V]],
  minor: [[i, VI, III, VII], [i, iv, VII, III], [i, VII, VI, V], [i, VI, iv, V], [i, iidim, V, i]],
};

export const classicKeyOfSeed = (seed: number) => CLASSIC_KEYS[hash(seed, 7) % CLASSIC_KEYS.length]!;

/** The chord under `barNo`, the phrase's last bar turning to the dominant so each phrase leans back into the next. */
export function classicChordAt(seed: number, mode: Mode, barNo: number): { chord: Chord; degree: number } {
  const tonic = classicKeyOfSeed(seed);
  const phrase = Math.floor(barNo / BARS_PER_PHRASE);
  const prog = PROGRESSIONS[mode][hash(seed, phrase, mode === 'major' ? 1 : 2) % PROGRESSIONS[mode].length]!;
  const inPhrase = barNo % BARS_PER_PHRASE;
  let deg = prog[inPhrase % 4]!;
  if (inPhrase === BARS_PER_PHRASE - 1) deg = V;
  return { chord: { rootPc: (tonic + deg[0]) % 12, tones: deg[1] }, degree: deg[0] };
}

const scaleOf = (mode: Mode) => (mode === 'major' ? MAJOR_SCALE : MINOR_SCALE);

/** Scale notes of the key between `lo` and `hi` (midi). */
function scaleNotes(tonic: number, mode: Mode, lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) if (scaleOf(mode).includes((((m - tonic) % 12) + 12) % 12)) out.push(m);
  return out;
}
const chordNotes = (c: Chord, lo: number, hi: number): number[] => {
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) if (c.tones.some((t) => (m - c.rootPc - t) % 12 === 0)) out.push(m);
  return out;
};

/** March rhythms for the lead: [step, duration] pairs inside one bar. */
const LEAD_RHYTHMS: readonly (readonly (readonly [number, number])[])[] = [
  [[0, 3], [3, 1], [4, 4], [8, 3], [11, 1], [12, 4]],
  [[0, 2], [2, 2], [4, 2], [6, 2], [8, 4], [12, 2], [14, 2]],
  [[0, 4], [4, 2], [6, 2], [8, 3], [11, 1], [12, 4]],
  [[0, 1], [1, 1], [2, 2], [4, 4], [8, 1], [9, 1], [10, 2], [12, 4]],
  [[0, 6], [6, 2], [8, 6], [14, 2]],
];

const LEAD_LO = 7, LEAD_HI = 26;

/** The four-bar lead motifs of a phrase; bars 4-7 answer 0-3 and the last bar closes on a chord tone. */
function leadFor(seed: number, mode: Mode, barNo: number, chord: Chord, tonic: number): MusicEvent[] {
  const phrase = Math.floor(barNo / BARS_PER_PHRASE);
  const inPhrase = barNo % BARS_PER_PHRASE;
  const answer = inPhrase >= 4;
  const r = rng(hash(seed, phrase, 31, mode === 'major' ? 1 : 2, answer && inPhrase !== 7 ? inPhrase - 4 : inPhrase));
  const lo = MID_C + tonic + LEAD_LO, hi = MID_C + tonic + LEAD_HI;
  const lows = scaleNotes(tonic, mode, lo, hi);
  const rhythm = pick(r, LEAD_RHYTHMS);
  const strong = chordNotes(chord, lo, hi);
  const events: MusicEvent[] = [];
  let cur = pick(r, strong);
  rhythm.forEach(([step, dur], idx) => {
    const onStrong = step % 8 === 0;
    const pool = onStrong ? strong : lows;
    // Stepwise motion, with the odd leap, tends to sound like a tune.
    const near = pool.filter((m) => Math.abs(m - cur) <= (chance(r, 0.25) ? 7 : 3));
    cur = pick(r, near.length ? near : pool);
    if (inPhrase === 7 && idx === rhythm.length - 1) cur = strong.reduce((best, m) => (Math.abs(m - (MID_C + tonic + 12)) < Math.abs(best - (MID_C + tonic + 12)) ? m : best), strong[0]!);
    events.push({ layer: 'hype', inst: 'lead', step, dur, midi: cur, vel: onStrong ? 1 : 0.8 });
  });
  return events;
}

/** The generated bar: the pure source of the whole soundtrack. Same (seed, mode, barNo) always returns the same bar. */
export function classicBar(seed: number, mode: Mode, barNo: number): Bar {
  const tonic = classicKeyOfSeed(seed);
  const { chord, degree } = classicChordAt(seed, mode, barNo);
  const phrase = Math.floor(barNo / BARS_PER_PHRASE);
  const inPhrase = barNo % BARS_PER_PHRASE;
  const r = rng(hash(seed, barNo, mode === 'major' ? 3 : 4));
  const pr = rng(hash(seed, phrase, 99));
  const ev: MusicEvent[] = [];
  const add = (layer: LayerId, inst: Inst, step: number, dur: number, midi: number, vel: number, tier?: 0 | 1 | 2) => ev.push({ layer, inst, step, dur, midi, vel, tier });
  const root = 36 + chord.rootPc;
  const fifth = root + 7;
  const third = root + chord.tones[1]!;
  const fill = inPhrase === 7, miniFill = inPhrase === 3;
  const bassStyle = Math.floor(pr() * 3);
  const march = Math.floor(pr() * 3);

  // calm: pad, bouncy bass, brushed kick and hats, glockenspiel sparkles.
  for (const t of chord.tones) add('calm', 'pad', 0, 16, 60 + chord.rootPc + t - (chord.rootPc > 6 ? 12 : 0), 0.5);
  if (bassStyle === 0) { add('calm', 'bass', 0, 3, root, 1); add('calm', 'bass', 4, 2, fifth, 0.8); add('calm', 'bass', 8, 3, root, 0.95); add('calm', 'bass', 12, 2, third, 0.8); add('calm', 'bass', 14, 2, fifth, 0.75); }
  else if (bassStyle === 1) { for (let s = 0; s < 16; s += 4) { add('calm', 'bass', s, 2, root, s === 0 ? 1 : 0.8); add('calm', 'bass', s + 2, 2, s % 8 === 4 ? fifth : root + 12, 0.7); } }
  else { add('calm', 'bass', 0, 2, root, 1); add('calm', 'bass', 3, 1, root + 12, 0.7); add('calm', 'bass', 6, 2, fifth, 0.85); add('calm', 'bass', 8, 2, root, 0.95); add('calm', 'bass', 11, 1, root + 12, 0.7); add('calm', 'bass', 14, 2, fifth, 0.85); }
  add('calm', 'kick', 0, 1, 0, 0.55); add('calm', 'kick', 8, 1, 0, 0.45);
  for (let s = 2; s < 16; s += 4) add('calm', 'hat', s, 1, 0, 0.35);
  const spark = chordNotes(chord, MID_C + 12, MID_C + 31);
  const nSpark = 3 + Math.floor(r() * 3);
  const used = new Set<number>();
  for (let k = 0; k < nSpark; k++) {
    let s = Math.floor(r() * 16);
    if (used.has(s)) s = (s + 1) % 16;
    used.add(s);
    add('calm', 'glock', s, 2, pick(r, spark), 0.5 + r() * 0.3);
  }

  // combat: snare march, oom-pah brass stabs, driving kick.
  const snareMarch: readonly (readonly number[])[] = [[4, 12, 7, 15], [4, 12, 6, 7, 14, 15], [3, 4, 11, 12, 14]];
  add('combat', 'kick', 0, 1, 0, 0.8); add('combat', 'kick', 8, 1, 0, 0.75); add('combat', 'kick', 10, 1, 0, 0.55);
  add('combat', 'snare', 4, 1, 0, 0.9); add('combat', 'snare', 12, 1, 0, 0.95);
  for (const s of snareMarch[march]!) if (s !== 4 && s !== 12) add('combat', 'snare', s, 1, 0, 0.4);
  for (const s of [2, 6, 10, 14]) for (const t of chord.tones) add('combat', 'stab', s, 1, 55 + ((((chord.rootPc + t - 55) % 12) + 12) % 12), 0.45);
  if (miniFill) for (let s = 12; s < 16; s++) add('combat', 'snare', s, 1, 0, 0.5 + (s - 12) * 0.12);

  // hype: the brass lead, bell doubling, a snare roll into each phrase turn.
  for (const e of leadFor(seed, mode, barNo, chord, tonic)) { ev.push(e); if (e.dur >= 3) add('hype', 'glock', e.step, 2, e.midi + 12, 0.45); }
  if (fill) for (let s = 8; s < 16; s++) add('hype', 'snare', s, 1, 0, 0.35 + (s - 8) * 0.09);
  if (fill) add('hype', 'tom', 15, 1, 43, 0.9);
  if (inPhrase === 0) add('hype', 'tom', 0, 1, 50, 0.8);

  // finale: sixteenth hats, octave-pumping bass, the lead's harmony a third up, tom rolls.
  for (let s = 0; s < 16; s++) add('finale', 'hat', s, 1, 0, s % 4 === 0 ? 0.5 : 0.3);
  for (let s = 0; s < 16; s += 2) add('finale', 'bass', s, 1, root + (s % 4 === 2 ? 12 : 0), 0.7);
  for (const e of leadFor(seed, mode, barNo, chord, tonic)) add('finale', 'lead', e.step, e.dur, e.midi + (mode === 'major' ? 4 : 3), 0.55);
  add('finale', 'tom', 6, 1, 45, 0.6); add('finale', 'tom', 14, 1, 40, 0.65); if (fill) for (let s = 12; s < 16; s++) add('finale', 'tom', s, 1, 55 - (s - 12) * 4, 0.8);

  // heart: lub-dub on the beat, thickening with tiers (see heartTier).
  add('heart', 'heart', 0, 1, 0, 1, 0); add('heart', 'heart', 2, 1, 0, 0.7, 0);
  add('heart', 'heart', 8, 1, 0, 1, 0); add('heart', 'heart', 10, 1, 0, 0.7, 0);
  add('heart', 'heart', 4, 1, 0, 0.9, 1); add('heart', 'heart', 6, 1, 0, 0.6, 1);
  add('heart', 'heart', 12, 1, 0, 0.9, 1); add('heart', 'heart', 14, 1, 0, 0.6, 1);
  for (const s of [3, 7, 11, 15]) add('heart', 'heart', s, 1, 0, 0.5, 2);
  // A dark pedal under the night: the root, two octaves down.
  if (mode === 'minor') add('heart', 'bass', 0, 16, root - 12 + (root - 12 < 24 ? 12 : 0), 0.6, 0);

  return { barNo, mode, tonic, chord, degree, events: ev };
}


// ---- the voices (af4983a's musicsynth.ts) ----

type ClassicInst = 'kick' | 'snare' | 'hat' | 'tom' | 'bass' | 'pad' | 'glock' | 'stab' | 'lead' | 'heart';
const LEVEL: Record<ClassicInst, number> = { kick: 0.9, snare: 0.55, hat: 0.2, tom: 0.7, bass: 0.55, pad: 0.07, glock: 0.2, stab: 0.07, lead: 0.12, heart: 0.9 };
export const CLASSIC_INSTS: readonly Inst[] = Object.keys(LEVEL) as Inst[];

function makeNoise(ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let a = 12345;
  for (let i = 0; i < d.length; i++) { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; d[i] = a / 2147483648 - 1; }
  return buf;
}

export type ClassicVoices = {
  playBar(bar: Bar, t0: number, spb: number, heartTier: 0 | 1 | 2, deck: Deck): void;
  playSting(chord: Chord, mode: Mode, streak: number, t: number, bounty?: boolean): void;
  /** Plays the round's closing phrase in the key and returns how long it lasts, in seconds. */
  playCadence(kind: 'win' | 'loss', tonic: number, t: number): number;
};

/** The march's own voices. Bars go into a deck's layers; stings and cadences into `direct` (the bus after the duck, as they always did). */
export function createClassicVoices(ctx: BaseAudioContext, direct: AudioNode): ClassicVoices {
  const noise = makeNoise(ctx);
  const env = (dest: AudioNode, t: number, peak: number, attack: number, hold: number, release: number) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    g.connect(dest);
    return g;
  };
  const osc = (type: OscillatorType, hz: number, t: number, end: number, dest: AudioNode, detune = 0) => {
    const o = ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(hz, t); o.detune.value = detune;
    o.connect(dest); o.start(t); o.stop(end);
    return o;
  };
  const noiseHit = (t: number, dur: number, type: BiquadFilterType, hz: number, q: number, peak: number, dest: AudioNode) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = hz; f.Q.value = q;
    const g = env(dest, t, peak, 0.002, 0, dur);
    src.connect(f).connect(g);
    src.start(t, (t * 7.31) % 0.5, dur + 0.05);
  };

  function kick(t: number, v: number, dest: AudioNode) {
    const g = env(dest, t, LEVEL.kick * v, 0.002, 0.02, 0.2);
    const o = osc('sine', 150, t, t + 0.3, g);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.13);
    noiseHit(t, 0.02, 'highpass', 2500, 0.5, 0.15 * v, dest);
  }
  function snare(t: number, v: number, dest: AudioNode) {
    noiseHit(t, 0.12, 'bandpass', 2400, 0.7, LEVEL.snare * v, dest);
    noiseHit(t, 0.07, 'highpass', 5000, 0.4, LEVEL.snare * 0.4 * v, dest);
    const g = env(dest, t, 0.25 * v, 0.001, 0.01, 0.07);
    osc('triangle', 210, t, t + 0.12, g);
  }
  function hat(t: number, v: number, dest: AudioNode) { noiseHit(t, 0.045, 'highpass', 7500, 0.6, LEVEL.hat * v, dest); }
  function tom(t: number, midi: number, v: number, dest: AudioNode) {
    const hz = midiToHz(midi);
    const g = env(dest, t, LEVEL.tom * v, 0.002, 0.03, 0.26);
    const o = osc('sine', hz * 1.6, t, t + 0.4, g);
    o.frequency.exponentialRampToValueAtTime(hz, t + 0.09);
    noiseHit(t, 0.03, 'bandpass', 900, 1, 0.12 * v, dest);
  }
  function bass(t: number, midi: number, dur: number, v: number, dest: AudioNode) {
    const hz = midiToHz(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(1400, t); f.frequency.exponentialRampToValueAtTime(260, t + Math.min(0.2, dur));
    const g = env(dest, t, LEVEL.bass * v, 0.004, Math.max(0, dur * 0.6), dur * 0.5 + 0.06);
    f.connect(g);
    osc('square', hz, t, t + dur * 1.2 + 0.1, f);
    osc('triangle', hz, t, t + dur * 1.2 + 0.1, g);
  }
  function pad(t: number, midi: number, dur: number, v: number, dest: AudioNode) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 1500;
    const g = env(dest, t, LEVEL.pad * v, 0.2, Math.max(0, dur - 0.5), 0.4);
    f.connect(g);
    osc('triangle', midiToHz(midi), t, t + dur + 0.7, f, -5);
    osc('triangle', midiToHz(midi), t, t + dur + 0.7, f, 5);
  }
  function glock(t: number, midi: number, v: number, dest: AudioNode) {
    const hz = midiToHz(midi);
    const g = env(dest, t, LEVEL.glock * v, 0.001, 0.005, 0.9);
    osc('sine', hz, t, t + 1, g);
    const g2 = env(dest, t, LEVEL.glock * 0.35 * v, 0.001, 0.003, 0.35);
    osc('sine', hz * 2.76, t, t + 0.5, g2);
    const g3 = env(dest, t, LEVEL.glock * 0.15 * v, 0.001, 0.002, 0.15);
    osc('sine', hz * 5.4, t, t + 0.3, g3);
  }
  /** A brass note: detuned saws through a filter that blooms on the attack. `dark` makes it the muted night horn. */
  function brass(t: number, midi: number, dur: number, v: number, level: number, dark: boolean, dest: AudioNode, vibrato = true) {
    const hz = midiToHz(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = dark ? 1 : 2.5;
    const top = dark ? 1500 : 3600;
    f.frequency.setValueAtTime(dark ? 500 : 900, t);
    f.frequency.linearRampToValueAtTime(top, t + 0.06);
    f.frequency.exponentialRampToValueAtTime(dark ? 800 : 1500, t + Math.max(0.1, dur));
    const g = env(dest, t, level * v, 0.015, Math.max(0, dur - 0.05), 0.09);
    f.connect(g);
    const end = t + dur + 0.2;
    const a = osc('sawtooth', hz, t, end, f, -7);
    const b = osc('sawtooth', hz, t, end, f, 7);
    osc('square', hz, t, end, f);
    if (vibrato && dur > 0.35) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 5.2; depth.gain.setValueAtTime(0, t); depth.gain.linearRampToValueAtTime(7, t + dur * 0.8);
      lfo.connect(depth); depth.connect(a.detune); depth.connect(b.detune);
      lfo.start(t); lfo.stop(end);
    }
  }
  function heart(t: number, v: number, dest: AudioNode) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 140;
    const g = env(dest, t, LEVEL.heart * v, 0.004, 0.02, 0.16);
    f.connect(g);
    const o = osc('sine', 78, t, t + 0.3, f);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.12);
  }
  function pedal(t: number, midi: number, dur: number, v: number, dest: AudioNode) {
    const g = env(dest, t, 0.32 * v, 0.4, Math.max(0, dur - 0.8), 0.5);
    osc('sine', midiToHz(midi), t, t + dur + 1, g);
  }

  function playBar(bar: Bar, t0: number, spb: number, heartTier: 0 | 1 | 2, deck: Deck) {
    const step = (spb * 4) / STEPS_PER_BAR;
    const dark = bar.mode === 'minor';
    for (const e of bar.events) {
      if (e.tier !== undefined && e.tier > heartTier) continue;
      const t = t0 + e.step * step;
      const dest = deck.layers[e.layer];
      const dur = e.dur * step;
      switch (e.inst) {
        case 'kick': kick(t, e.vel, dest); break;
        case 'snare': snare(t, e.vel, dest); break;
        case 'hat': hat(t, e.vel, dest); break;
        case 'tom': tom(t, e.midi, e.vel, dest); break;
        case 'bass': if (e.layer === 'heart') pedal(t, e.midi, dur, e.vel, dest); else bass(t, e.midi, dur, e.vel, dest); break;
        case 'pad': pad(t, e.midi, dur, e.vel, dest); break;
        case 'glock': glock(t, e.midi, e.vel, dest); break;
        case 'stab': brass(t, e.midi, step * 0.9, e.vel, LEVEL.stab, dark, dest, false); break;
        case 'lead': brass(t, e.midi, dur, e.vel, LEVEL.lead * (e.layer === 'finale' ? 0.8 : 1), dark, dest); break;
        case 'heart': heart(t, e.vel, dest); break;
      }
    }
  }

  /** Chord tones climbing from the chord's root, so a kill rings in the key the march is in. */
  function playSting(chord: Chord, mode: Mode, streak: number, t: number, bounty = false) {
    const root = MID_C + 12 + ((chord.rootPc - 0) % 12);
    const climb: number[] = [];
    const count = 3 + Math.min(3, Math.max(0, streak - 1));
    for (let k = 0; k < count; k++) climb.push(root + chord.tones[k % chord.tones.length]! + 12 * Math.floor(k / chord.tones.length));
    climb.forEach((m, k) => {
      const tt = t + k * 0.055;
      glock(tt, m, 0.9, direct);
      const g = env(direct, tt, 0.05, 0.004, 0.02, 0.14);
      osc('square', midiToHz(m - 12), tt, tt + 0.25, g);
    });
    const last = climb[climb.length - 1]!;
    brass(t + (count - 1) * 0.055, last - 12, 0.28, 1, 0.09, mode === 'minor', direct, false);
    if (bounty) { glock(t + count * 0.055, last + 12, 1, direct); glock(t + count * 0.055 + 0.07, last + 19, 0.8, direct); }
  }

  function playCadence(kind: 'win' | 'loss', tonic: number, t: number): number {
    const base = 48 + tonic; // tonic around C3
    const triad = (r: number, minor: boolean) => [r, r + (minor ? 3 : 4), r + 7];
    if (kind === 'win') {
      const spb = 60 / 138;
      // Pickup: V triplet, then a big I with the bells running up over it.
      for (let k = 0; k < 3; k++) for (const m of triad(base + 7 + 12, false)) brass(t + k * spb * 0.5, m, spb * 0.45, 1, 0.1, false, direct, false);
      const hit = t + spb * 2;
      for (const r of [base, base + 12, base + 24]) for (const m of triad(r, false)) brass(hit, m, spb * 3, 1, 0.07, false, direct);
      kick(hit, 1, direct); snare(hit, 1, direct); tom(hit, 41, 1, direct);
      noiseHit(hit, 1.4, 'highpass', 6500, 0.4, 0.2, direct);
      for (let k = 0; k < 8; k++) tom(t + k * spb * 0.25, 48 + (k % 2) * 3, 0.5 + k * 0.07, direct);
      const run = [0, 4, 7, 12, 16, 19, 24, 28, 31];
      run.forEach((s, k) => glock(hit + k * 0.06, MID_C + 12 + tonic + s, 0.9, direct));
      glock(hit + 0.6, MID_C + 12 + tonic + 36, 1, direct);
      return spb * 6;
    }
    // Loss: a sad trombone, wah wah wah waaah, down a semitone each time, then a minor chord falling away.
    const spb = 60 / 76;
    const start = 55 + tonic;
    const notes = [start, start - 1, start - 2, start - 3];
    notes.forEach((m, k) => {
      const tt = t + k * spb * 0.8;
      const last = k === 3;
      const dur = last ? spb * 2.6 : spb * 0.7;
      const hz = midiToHz(m);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.Q.value = 3;
      f.frequency.setValueAtTime(350, tt);
      f.frequency.linearRampToValueAtTime(1500, tt + 0.12);
      f.frequency.exponentialRampToValueAtTime(380, tt + dur);
      const g = env(direct, tt, 0.13, 0.03, dur - 0.1, 0.12);
      f.connect(g);
      for (const d of [-6, 6]) {
        const o = osc('sawtooth', hz, tt, tt + dur + 0.2, f, d);
        o.frequency.setValueAtTime(hz, tt);
        o.frequency.linearRampToValueAtTime(hz * 0.97, tt + dur * (last ? 0.5 : 1));
        if (last) o.frequency.exponentialRampToValueAtTime(hz * 0.84, tt + dur);
        if (last) {
          const lfo = ctx.createOscillator(); const depth = ctx.createGain();
          lfo.frequency.value = 5.5; depth.gain.value = 22; lfo.connect(depth).connect(o.detune); lfo.start(tt + 0.5); lfo.stop(tt + dur + 0.2);
        }
      }
    });
    const chordAt = t + spb * 2.4;
    for (const m of triad(base - 12 + 12, true)) pad(chordAt, m, spb * 3, 3, direct);
    for (const m of triad(base, true)) brass(chordAt, m, spb * 2.6, 1, 0.05, true, direct);
    tom(chordAt, 38, 0.9, direct);
    return spb * 6;
  }

  return { playBar, playSting, playCadence };
}
