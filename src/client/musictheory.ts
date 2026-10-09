/**
 * The pure half of the soundtrack: the yard marches' bar generation, the state-to-layer mapping and the fade maths.
 * Nothing here touches WebAudio, so it is deterministic and unit tested; musicsynth.ts voices it and music.ts runs it.
 */
import { bassBar, diatonic, sparse, theme, type HookNote, type Theme } from './musichook.ts';

export type LayerId = 'calm' | 'combat' | 'hype' | 'finale' | 'heart';
export const LAYER_IDS: readonly LayerId[] = ['calm', 'combat', 'hype', 'finale', 'heart'];
export type Mode = 'major' | 'minor';
export type Inst =
  | 'kick' | 'snare' | 'hat' | 'tom' | 'bass' | 'pad' | 'glock' | 'stab' | 'lead' | 'heart'
  // Voices added for the per-map scores (musicvoices.ts).
  | 'fife' | 'harp' | 'accordion' | 'foghorn' | 'gull' | 'koto' | 'chime' | 'epiano' | 'vibes' | 'trumpet' | 'upright' | 'sonar' | 'tbass' | 'acid'
  | 'metal' | 'whistle' | 'uke' | 'marimba' | 'harmonica' | 'rbell' | 'yodel' | 'twang' | 'bgtr' | 'tuba' | 'fbass' | 'padair' | 'dread' | 'clank'
  | 'brush' | 'swirl' | 'clap' | 'bongo' | 'sleigh' | 'shaker' | 'rim' | 'chug' | 'ohat' | 'stomp' | 'wind' | 'scrape' | 'drone' | 'dust'
  // Sampled instruments (musicsamples.ts), each with a synth stand-in until its samples load.
  | 'piano' | 'honky' | 'tpt' | 'horn' | 'bone' | 'timp' | 'bell' | 'pbass' | 'slap' | 'steel' | 'dist' | 'od' | 'organ' | 'bandoneon' | 'violin' | 'fiddle'
  | 'flute' | 'sax' | 'synbrass' | 'choir'
  // Synth leads and basses, and the genre drum kits: a 909, a boom-bap, a rock kit, a gated-reverb snare, cymbals, 8-bit noise, a tambourine.
  | 'square' | 'saw' | 'synbass' | 'k909' | 'kbb' | 'krock' | 'sbb' | 'srock' | 'sgate' | 'crash' | 'ride' | 'chip' | 'tamb'
  // The pop themes' additions (musicpop.ts): an 808 (clean and gritty) that glides, the phonk cowbell, a synth pluck, an eight-bit triangle bass,
  // a finger snap, and the drop's riser and impact.
  | 'b808' | 'b808d' | 'cowbell' | 'pluck' | 'tri' | 'snap' | 'riser' | 'impact';

export const STEPS_PER_BAR = 16;
export const BARS_PER_PHRASE = 8;
export const MID_C = 60;

/**
 * One note or hit. `step` is in 16ths from the bar's start, `dur` in 16ths, `midi` is ignored by the drums, `tier` thins the heartbeat,
 * `from` is the pitch an 808 glides in from, and `tag` marks the hook's notes (and a theme's counter-melody) for tests and tools.
 */
export type MusicEvent = { layer: LayerId; inst: Inst; step: number; dur: number; midi: number; vel: number; tier?: 0 | 1 | 2; tag?: 'hook' | 'counter'; from?: number };
export type Chord = { rootPc: number; tones: readonly number[] };
export type Bar = { barNo: number; mode: Mode; tonic: number; chord: Chord; degree: number; events: MusicEvent[] };

/** mulberry32: a tiny seeded generator, so one seed always writes the same march. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const hash = (...n: number[]): number => {
  let h = 2166136261;
  for (const v of n) { h ^= v | 0; h = Math.imul(h, 16777619); h ^= h >>> 13; }
  return h >>> 0;
};
const pick = <T,>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length) % list.length]!;

export const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

const MAJ = [0, 4, 7], MIN = [0, 3, 7], DOM7 = [0, 4, 7, 10];
type Deg = readonly [rootOffset: number, tones: readonly number[]];
const I: Deg = [0, MAJ], ii: Deg = [2, MIN], IV: Deg = [5, MAJ], V: Deg = [7, MAJ], V7: Deg = [7, DOM7], vi: Deg = [9, MIN];

/** The plaza's march: a toy-soldier brass band in C, with the chords under its A and B. */
export const MARCH_TONIC = 0;
type March = { theme: Theme; A: readonly Deg[]; B: readonly Deg[]; scale: readonly number[] };
export const MARCH: March = {
  // A toy-soldier fanfare: a dotted pickup and a leap up the C chord to the top (C, C-E-G-C'), stepping back down to answer on G7.
  theme: theme({
    A: 'C5:3 C5:1 E5:2 G5:2 C6:4 G5:4 | B5:3 A5:1 G5:2 F5:2 D5:8 | C5:3 C5:1 F5:2 A5:2 C6:4 A5:4 | G5:3 A5:1 G5:2 F5:2 D5:4 r:4 |'
      + ' C5:3 C5:1 E5:2 G5:2 C6:4 G5:4 | C6:3 B5:1 A5:2 G5:2 E5:8 | D6:3 C6:1 B5:2 A5:2 G5:4 F5:4 | E5:4 G5:2 E5:2 C5:8',
    B: 'A5:6 G5:2 F5:4 A5:4 | G5:8 E5:4 C5:4 | F5:6 E5:2 D5:4 F5:4 | B4:4 D5:4 G5:8 | A5:6 G5:2 F5:4 A5:4 | C6:8 G5:4 E5:4 | F5:4 E5:4 D5:4 B4:4 | C5:12 r:4',
    bass: '1:4 5,:4 1:2 3:2 5:2 ^:2',
  }),
  A: [I, V7, IV, V, I, vi, V7, I], B: [IV, I, ii, V, IV, I, V7, I], scale: [0, 2, 4, 5, 7, 9, 11],
};

const mod12 = (n: number) => ((n % 12) + 12) % 12;
/** A major tune or chord heard in the parallel (harmonic) minor: the third and sixth flattened, the leading tone kept. */
const toMinor = (pc: number) => (pc === 4 || pc === 9 ? pc - 1 : pc);
function minorChord(deg: Deg): Deg {
  const pcs = deg[1].map((t) => toMinor(mod12(deg[0] + t)));
  return [pcs[0]!, pcs.map((p) => mod12(p - pcs[0]!))];
}

/** Which part of the 32-bar form a phrase is: 0 the A, 1 its second verse, 2 the B (the trio), 3 the breakdown and build. */
export const phraseForm = (phrase: number) => phrase % 4;

/** The chord under `barNo`: the A's chords, the B's, then the breakdown rocking on the hook's first two and the build on the A's first half. */
export function chordAt(mode: Mode, barNo: number): { chord: Chord; degree: number } {
  const form = phraseForm(Math.floor(barNo / BARS_PER_PHRASE)), at = barNo % BARS_PER_PHRASE;
  let deg = form === 2 ? MARCH.B[at]! : form === 3 ? MARCH.A[at < 4 ? at % 2 : at - 4]! : MARCH.A[at]!;
  if (mode === 'minor') deg = minorChord(deg);
  return { chord: { rootPc: (MARCH_TONIC + deg[0]) % 12, tones: deg[1] }, degree: deg[0] };
}

/** The march's tune for a bar: the A (twice), the B, then the hook's opening teased in the breakdown and silence in the build. */
function marchHook(mode: Mode, barNo: number): readonly HookNote[] {
  const th = MARCH.theme;
  const form = phraseForm(Math.floor(barNo / BARS_PER_PHRASE)), at = barNo % BARS_PER_PHRASE;
  const notes = form === 2 ? th.B[at]! : form === 3 ? (at < 4 ? th.A[at % 2]! : []) : th.A[at]!;
  if (mode === 'major') return notes;
  return notes.map((n) => ({ ...n, midi: n.midi - mod12(n.midi - MARCH_TONIC) + toMinor(mod12(n.midi - MARCH_TONIC)) }));
}

const chordNotes = (c: Chord, lo: number, hi: number): number[] => {
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) if (c.tones.some((t) => (m - c.rootPc - t) % 12 === 0)) out.push(m);
  return out;
};

/** The plaza march's bar: the same (seed, mode, barNo) always returns the same bar; the seed only picks fills and sparkles. */
export function generateBar(seed: number, mode: Mode, barNo: number): Bar {
  const m = MARCH;
  const tonic = MARCH_TONIC;
  const { chord, degree } = chordAt(mode, barNo);
  const next = chordAt(mode, barNo + 1).chord;
  const phrase = Math.floor(barNo / BARS_PER_PHRASE);
  const inPhrase = barNo % BARS_PER_PHRASE;
  const cycle = Math.floor(barNo / (4 * BARS_PER_PHRASE));
  const form = phraseForm(phrase);
  const trio = form === 2, breakdown = form === 3 && inPhrase < 4, build = form === 3 && inPhrase >= 4, second = form === 1;
  const r = rng(hash(seed, barNo, mode === 'major' ? 3 : 4));
  const pr = rng(hash(seed, phrase, 99));
  const ev: MusicEvent[] = [];
  const add = (layer: LayerId, inst: Inst, step: number, dur: number, midi: number, vel: number, tier?: 0 | 1 | 2) => ev.push({ layer, inst, step, dur, midi, vel, tier });
  const sing = (layer: LayerId, inst: Inst, notes: readonly HookNote[], vel: number, shift = 0) => {
    for (const n of notes) ev.push({ layer, inst, step: n.step, dur: n.dur, midi: n.midi + shift, vel: vel * (n.step % 4 === 0 ? 1 : 0.85), tag: 'hook' });
  };
  const root = 36 + chord.rootPc;
  const fill = inPhrase === 7, miniFill = inPhrase === 3;
  const smallFill = (inPhrase === 1 || inPhrase === 5) && hash(seed, phrase, inPhrase, 41) % 3 === 0;
  const march = Math.floor(pr() * 3);

  // calm: pad, the bass riff, brushed kick and hats, the tune's skeleton on the bells and a sparkle or two.
  for (const t of chord.tones) add('calm', 'pad', 0, 16, 60 + chord.rootPc + t - (chord.rootPc > 6 ? 12 : 0), trio ? 0.65 : 0.5);
  for (const n of bassBar(m.theme, inPhrase, chord, next, 36)) add('calm', 'tuba', n.step, n.dur, n.midi, n.step % 4 === 0 ? 0.9 : 0.75);
  add('calm', 'kick', 0, 1, 0, 0.55); add('calm', 'kick', 8, 1, 0, 0.45);
  for (let s = 2; s < 16; s += 4) add('calm', 'hat', s, 1, 0, trio ? 0.5 : 0.35);
  const spark = chordNotes(chord, MID_C + 12, MID_C + 31);
  const nSpark = breakdown || build ? 3 + Math.floor(r() * 2) : Math.floor(r() * 2);
  for (let k = 0; k < nSpark; k++) add('calm', 'glock', Math.floor(r() * 8) * 2 + 1, 2, pick(r, spark), 0.4 + r() * 0.2);

  // combat: snare march, oom-pah brass stabs, driving kick. The breakdown drops to a half-time thump, the build rolls back in.
  const snareMarch: readonly (readonly number[])[] = [[4, 12, 7, 15], [4, 12, 6, 7, 14, 15], [3, 4, 11, 12, 14]];
  if (breakdown) {
    add('combat', 'kick', 0, 1, 0, 0.85); add('combat', 'kick', 8, 1, 0, 0.8);
    add('combat', 'snare', 12, 1, 0, 0.8); add('combat', 'tom', 4, 1, 45, 0.5);
  } else {
    add('combat', 'kick', 0, 1, 0, 0.8); add('combat', 'kick', 8, 1, 0, 0.75); add('combat', 'kick', 10, 1, 0, 0.55);
    add('combat', 'snare', 4, 1, 0, 0.9); add('combat', 'snare', 12, 1, 0, 0.95);
    for (const s of snareMarch[march]!) if (s !== 4 && s !== 12) add('combat', 'snare', s, 1, 0, 0.4);
    for (const s of [2, 6, 10, 14]) for (const t of chord.tones) add('combat', 'stab', s, 1, 55 + ((((chord.rootPc + t - 55) % 12) + 12) % 12), build && inPhrase === 4 ? 0.3 : 0.4);
  }
  if (miniFill) for (let s = 12; s < 16; s++) add('combat', 'snare', s, 1, 0, 0.5 + (s - 12) * 0.12);
  if (smallFill) { add('combat', 'tom', 14, 1, 50, 0.7); add('combat', 'tom', 15, 1, 45, 0.75); }
  if (build && inPhrase >= 6) for (let s = inPhrase === 7 ? 0 : 8; s < 16; s++) add('combat', 'snare', s, 1, 0, 0.3 + s * 0.04);

  // The tune: its skeleton on the calm voice, the whole of it in combat (the second verse and every other time round on the alternate voice),
  // a double in hype (a harmony a third under in the second verse), the harmony in the finale. The breakdown teases it on the calm voice.
  const notes = marchHook(mode, barNo);
  const harmony = diatonic(notes, tonic, mode === 'minor' ? [0, 2, 3, 5, 7, 8, 11] : m.scale, -2);
  // The band: trumpets lead (French horns the second verse and every other time round), a glockenspiel rings the skeleton.
  if (breakdown) sing('calm', 'glock', notes, 0.55);
  else if (notes.length) {
    sing('calm', 'glock', form === 0 ? notes : sparse(notes), 0.4);
    sing('combat', second !== (cycle % 2 === 1) ? 'horn' : 'tpt', notes, 0.85);
    if (second) sing('hype', 'tpt', harmony, 0.5);
    else sing('hype', 'glock', notes, 0.4, 12);
    sing('finale', 'horn', second ? notes.map((n) => ({ ...n, midi: n.midi - 12 })) : harmony, 0.45);
  }
  // hype: a bell arpeggio under the trio, a snare roll into each phrase turn.
  if (trio) { const arp = chordNotes(chord, MID_C + 12, MID_C + 28); for (let s = 0; s < 16; s += 4) add('hype', 'glock', s + 2, 2, arp[(s / 4 + inPhrase) % arp.length]!, 0.25); }
  if (fill) for (let s = 8; s < 16; s++) add('hype', 'snare', s, 1, 0, 0.35 + (s - 8) * 0.09);
  if (fill) add('hype', 'tom', 15, 1, 43, 0.9);
  if (inPhrase === 0) add('hype', 'tom', 0, 1, 50, 0.8);

  // finale: sixteenth hats, octave-pumping bass, tom rolls.
  for (let s = 0; s < 16; s++) add('finale', 'hat', s, 1, 0, s % 4 === 0 ? 0.5 : 0.3);
  for (let s = 0; s < 16; s += 2) add('finale', 'bass', s, 1, root + (s % 4 === 2 ? 12 : 0), 0.7);
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

/** How many heartbeat tiers are voiced for a horde of 0..1. */
export const heartTier = (horde: number): 0 | 1 | 2 => (horde < 0.3 ? 0 : horde < 0.7 ? 1 : 2);

/** Beats per minute by mood: a light build theme by day, a steady march, a quickened night op. */
export function tempoFor(input: Pick<MusicInput, 'mode' | 'night' | 'day'>): number {
  if (input.night) return 126;
  if (input.day) return 120;
  return 132;
}

// ---------- state -> layers ----------

export type MusicInput = {
  phase: 'menu' | 'play' | 'dead';
  mode: 'arena' | 'zombies';
  day: boolean; night: boolean;
  /** 0..1 how big the horde is. */
  horde: number;
  /** 0..1 heat: enemies near, firing, damage dealt and taken (see `stepHeat`). */
  heat: number;
  streak: number;
  /** A multi-kill landed in the last few seconds. */
  multi: boolean;
  hunted: boolean;
  /** Last 60 s of a round, or a boss on the field. */
  finale: boolean;
};
export const IDLE_INPUT: MusicInput = { phase: 'menu', mode: 'arena', day: false, night: false, horde: 0, heat: 0, streak: 0, multi: false, hunted: false, finale: false };

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const modeOf = (i: Pick<MusicInput, 'night'>): Mode => (i.night ? 'minor' : 'major');

/** Target level 0..1 of each layer. Layers stack: each louder tier adds to the one below instead of replacing it. */
export function layerTargets(i: MusicInput): Record<LayerId, number> {
  if (i.phase === 'menu') return { calm: 1, combat: 0, hype: 0, finale: 0, heart: 0 };
  if (i.phase === 'dead') return { calm: 0.45, combat: 0, hype: 0, finale: 0, heart: i.night ? 0.3 : 0 };
  // The day of a Zombies run is a light build theme: no snare, just the bouncy bass and bells.
  if (i.day) return { calm: 1, combat: 0, hype: 0, finale: 0, heart: 0 };
  const hot = i.streak >= 3 || i.multi || i.hunted;
  const combat = clamp01(i.heat * 1.4);
  return {
    calm: 1,
    combat: hot ? Math.max(combat, 0.8) : combat,
    hype: hot ? 1 : 0,
    finale: i.finale ? 1 : 0,
    heart: i.night ? 0.35 + 0.65 * clamp01(i.horde) : 0,
  };
}

/** Equal-power crossfade gains for a mix position x in 0..1: a is 1 at 0, b is 1 at 1, and a² + b² is always 1. */
export function crossfade(x: number): { a: number; b: number } {
  const c = clamp01(x);
  return { a: Math.cos(c * Math.PI / 2), b: Math.sin(c * Math.PI / 2) };
}
/** A level 0..1 as the gain that sounds like that fraction of loudness when stacked with others. */
export const levelGain = (level: number) => Math.sin(clamp01(level) * Math.PI / 2);

/** One step of exponential smoothing toward `target` over `dt` seconds with time constant `tau`. */
export const approach = (cur: number, target: number, dt: number, tau: number) => target + (cur - target) * Math.exp(-dt / tau);

/** Fade in over ~1.2 s, out over ~3 s, so a fight swells in fast and drains slowly. */
export const fadeTau = (cur: number, target: number) => (target > cur ? 0.5 : 1.3);

/** Combat heat: rises while you fire, hit or are hit or enemies crowd you, and drains over a few seconds. */
export function stepHeat(heat: number, dt: number, f: { near: number; firing: boolean; hurt: boolean; dealt: boolean }): number {
  const drive = Math.max(f.near * 0.7, f.firing ? 0.6 : 0, f.hurt ? 1 : 0, f.dealt ? 0.9 : 0);
  const next = drive > heat ? approach(heat, drive, dt, 0.4) : approach(heat, drive, dt, 5);
  return clamp01(next);
}

// ---------- beat clock maths ----------

export type BarClock = { t0: number; spb: number; barNo: number };
/** Where `t` falls within the scheduled bars (ascending by t0): the beat count since bar 0 and phase in the beat. Null before the first bar. */
export function beatAt(bars: readonly BarClock[], t: number): { beat: number; phase: number; bar: number; step: number; beatInBar: number } | null {
  let cur: BarClock | null = null;
  for (const b of bars) if (b.t0 <= t) cur = b;
  if (!cur) return null;
  const beats = Math.min((t - cur.t0) / cur.spb, 4 - 1e-9);
  const beatInBar = Math.floor(beats);
  return { beat: cur.barNo * 4 + beats, phase: beats - beatInBar, bar: cur.barNo, step: Math.floor(beats * 4), beatInBar };
}
