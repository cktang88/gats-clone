/**
 * The map themes' composer, written to the rules in docs/music/CRAFT.md: one hook, one four-chord loop, and an arc that builds in layers.
 * An 8-bar intro (beat and pad, then the bass with the hook teased) leads into a 32-bar loop of four 8-bar sections: the hook, a
 * call-and-response groove, a breakdown and build, and the drop. The loop then comes round to the hook again. Each theme is a `PopSpec`
 * (musicthemes.ts) of a few strings and voices; this file arranges it bar by bar across the director's intensity layers. Pure and deterministic:
 * the same (spec, seed, mode, barNo) always returns the same bar. The hook, chords and bass never depend on the seed, which only picks fills.
 */
import { bassBar, diatonic, theme, type HookNote, type Theme } from './musichook.ts';
import { hash, type Bar, type Chord, type Inst, type LayerId, type Mode, type MusicEvent } from './musictheory.ts';
import { SAMPLES } from './musicsamples.ts';

export type Deg = readonly [root: number, tones: readonly number[]];
/** Chord shapes, as semitones above the root. */
export const Q = { maj: [0, 4, 7], min: [0, 3, 7], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], dom7: [0, 4, 7, 10] } as const;

export type Part = 'intro' | 'bassin' | 'hook' | 'groove' | 'breakdown' | 'build' | 'drop';
/** The intro plays once, before the loop. */
export const INTRO_BARS = 8;
export const SECTION_BARS = 8;
/** The loop: hook, groove, break (breakdown and build), drop. */
export const LOOP_BARS = 32;
/** The intro and one time round the loop: every bar a theme can write. */
export const FORM_BARS = INTRO_BARS + LOOP_BARS;

/** A drum voice, with the pitch it takes if it takes one (the chip snare, a tom). */
export type Drum = Inst | readonly [Inst, number];

export type PopSpec = {
  id: string;
  /** Shown on the radio. */
  label: string;
  bpm: number;
  /** The key: its tonic's pitch class, and whether it is minor (for the harmony under the hook). */
  tonic: number;
  minor: boolean;
  /** The four chords, one a bar, as offsets from the tonic, and their Roman numerals. */
  prog: readonly [Deg, Deg, Deg, Deg];
  progName: string;
  /** Off-beat sixteenths pushed late, in sixteenths (0.67 is a full triplet swing). */
  swing?: number;
  /** The hook phrase: four bars of melody (call, answer, the call again or its sequence, the closing answer), as musichook.ts notes. */
  hook: string;
  /** The counter-melody, four bars over the same chords: the groove's answers and the streak layer's line. */
  counter: string;
  /** The bass riff (one or two bars, musichook.ts degrees), and the drop's (with `~` glides on the 808 themes). */
  bass: string;
  dropBass: string;
  /** The hook's voice in calm, the lead that takes it in a fight, and the counter-melody's voice. */
  calm: Inst;
  lead: Inst;
  counterInst: Inst;
  /** Semitones each voice is moved by: the calm voice, the lead, and the lead's jump in the groove's second half (an octave unless set). */
  calmShift?: number;
  leadShift?: number;
  /** A level for the calm hook voice against the rest (1 unless a quiet voice needs bringing forward). */
  calmVel?: number;
  grooveShift?: number;
  bassInst: Inst;
  /** The bass riff's root is the lowest at or above this. */
  bassLo: number;
  dropInst: Inst;
  pad: Inst;
  /** Held chords are voiced from here up (keeps them out of the low mids). */
  padLo?: number;
  /** A rhythmic chord part: the pattern (see `hits`), an alternate for every other time round, and whether it arpeggiates. */
  comp?: { inst: Inst; pat: string; alt?: string; lo?: number; vel?: number; arp?: boolean; stagger?: number };
  kit: { kick: Drum; snare: Drum; hat: Drum; perc?: Drum; fill: Drum; crash?: Drum };
  /**
   * The beat as 16-character patterns (a digit is a hit's velocity, anything else a rest). The calm kick and hat play always; in a fight
   * `kick` and `hat` fill in around them, and `snare` brings the backbeat. `perc` joins in the groove and the drop.
   */
  beat: { calmKick: string; kick: string; snare: string; calmHat: string; hat: string; perc?: string };
  /** The drop goes half-time (the trap and phonk themes). */
  halfTimeDrop?: boolean;
  /** The Zombies night: a heartbeat that thickens with the horde, and a pedal under it. */
  night?: boolean;
  /** Map flavour on top of the arrangement (a foghorn, a crossing bell, the propellers). */
  extra?: (cx: PopCx) => void;
};

/** Where a bar falls in the arc. `barIn` is the bar within its 8-bar section (the intro's own bar in the intro). */
export type Place = { part: Part; barIn: number; section: number; cycle: number };
export function placeOf(n: number): Place {
  if (n < INTRO_BARS) return { part: n < 4 ? 'intro' : 'bassin', barIn: n, section: -1, cycle: 0 };
  const loop = n - INTRO_BARS;
  const at = ((loop % LOOP_BARS) + LOOP_BARS) % LOOP_BARS;
  const section = Math.floor(at / SECTION_BARS);
  const barIn = at % SECTION_BARS;
  const part: Part = section === 0 ? 'hook' : section === 1 ? 'groove' : section === 2 ? (barIn < 4 ? 'breakdown' : 'build') : 'drop';
  return { part, barIn, section, cycle: Math.floor(loop / LOOP_BARS) };
}

type Parsed = { th: Theme; drop: Theme };
const parsed = new WeakMap<PopSpec, Parsed>();
function parse(spec: PopSpec): Parsed {
  let p = parsed.get(spec);
  if (!p) {
    p = { th: theme({ A: spec.hook, B: spec.counter, bass: spec.bass }), drop: theme({ A: spec.hook, B: spec.counter, bass: spec.dropBass }) };
    if (p.th.A.length !== 4 || p.th.B.length !== 4) throw new Error(`${spec.id}: the hook and the counter-melody are four bars each`);
    parsed.set(spec, p);
  }
  return p;
}
/** The hook phrase's four bars, the counter-melody's, and the motif (the call: the hook's first bar). */
export const hookBars = (spec: PopSpec) => parse(spec).th.A;
export const counterBars = (spec: PopSpec) => parse(spec).th.B;
export const motifOf = (spec: PopSpec): readonly HookNote[] => parse(spec).th.A[0]!;

/**
 * Whether `notes` state the motif: the same rhythm, and a contour that moves the same way at every step and by no more than two semitones
 * more or less (so the call repeated exactly, moved along the scale, or transposed all count; a different tune does not).
 */
export function isMotif(notes: readonly HookNote[], motif: readonly HookNote[]): boolean {
  if (notes.length !== motif.length || notes.length < 2) return false;
  for (let i = 0; i < notes.length; i++) if (Math.abs(notes[i]!.step - motif[i]!.step) > 0.01 || Math.abs(notes[i]!.dur - motif[i]!.dur) > 0.01) return false;
  for (let i = 1; i < notes.length; i++) {
    const a = notes[i]!.midi - notes[i - 1]!.midi, b = motif[i]!.midi - motif[i - 1]!.midi;
    if (Math.sign(a) !== Math.sign(b) || Math.abs(a - b) > 2) return false;
  }
  return true;
}

/** A step as written, before the theme's swing pushed it late. */
export function unswing(spec: PopSpec, step: number): number {
  const sw = spec.swing ?? 0;
  if (!sw || Number.isInteger(step)) return step;
  for (const back of [sw, sw / 2]) { const s = step - back; if (Math.abs(s - Math.round(s)) < 1e-6) return Math.round(s); }
  return step;
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10];

/** Whether a sampled voice can play every note `shift` away (within a few semitones of its recorded range); a synth voice always can. */
function fits(inst: Inst, notes: readonly HookNote[], shift: number): boolean {
  const s = SAMPLES[inst];
  if (!s) return notes.every((n) => n.midi + shift >= 24 && n.midi + shift <= 108);
  const lo = s.notes[0]! - 4, hi = s.notes.at(-1)! + 4;
  return notes.every((n) => n.midi + shift >= lo && n.midi + shift <= hi);
}
/** An octave jump that the voice can play: up if it fits, else down, else none. */
export const octaveFor = (inst: Inst, notes: readonly HookNote[], base: number, want = 12): number =>
  fits(inst, notes, base + want) ? want : fits(inst, notes, base - Math.abs(want)) ? -Math.abs(want) : 0;
const mod = (n: number, m: number) => ((n % m) + m) % m;
export const chordOf = (spec: PopSpec, i: number): Chord => { const d = spec.prog[mod(i, 4)]!; return { rootPc: (spec.tonic + d[0]) % 12, tones: d[1] }; };

export type PopCx = {
  spec: PopSpec; seed: number; mode: Mode; barNo: number; at: Place; chord: Chord; next: Chord;
  add(layer: LayerId, inst: Inst, step: number, dur: number, midi: number, vel: number, more?: Partial<MusicEvent>): void;
  /** A pattern string's hits (see `PopSpec.beat`) as [step, velocity 0..1]. */
  hits(str: string): readonly (readonly [number, number])[];
};

const patCache = new Map<string, readonly (readonly [number, number])[]>();
function hits(str: string): readonly (readonly [number, number])[] {
  let p = patCache.get(str);
  if (!p) {
    const out: [number, number][] = [];
    for (let i = 0; i < str.length; i++) { const c = str[i]!; if (c >= '1' && c <= '9') out.push([(i * 16) / str.length, Number(c) / 9]); }
    patCache.set(str, p = out);
  }
  return p;
}
const drumOf = (d: Drum): [Inst, number] => (typeof d === 'string' ? [d, 0] : [d[0], d[1]]);

/** The bar `barNo` of a theme. */
export function popBar(spec: PopSpec, seed: number, mode: Mode, barNo: number): Bar {
  const { th, drop } = parse(spec);
  const at = placeOf(barNo);
  const { part, barIn, cycle } = at;
  const ci = barIn % 4;
  const chord = chordOf(spec, ci), next = chordOf(spec, ci + 1);
  const events: MusicEvent[] = [];
  const swing = spec.swing ?? 0;
  const add: PopCx['add'] = (layer, inst, step, dur, midi, vel, more) => {
    let s = step;
    if (swing && Number.isInteger(step)) { if (step % 4 === 2) s += swing; else if (step % 2 === 1) s += swing / 2; }
    events.push({ layer, inst, step: s, dur, midi, vel: Math.min(1, Math.max(0.01, vel)), ...more });
  };
  const cx: PopCx = { spec, seed, mode, barNo, at, chord, next, add, hits };
  const odd = cycle % 2 === 1;
  const full = part === 'hook' || part === 'groove' || part === 'drop';
  const half = part === 'drop' && !!spec.halfTimeDrop;
  const drum = (layer: LayerId, d: Drum, pat: string, vel: number, skip?: ReadonlySet<number>) => {
    const [inst, midi] = drumOf(d);
    for (const [s, v] of hits(pat)) if (!skip?.has(s)) add(layer, inst, s, 1, midi, v * vel);
  };
  const stepsOf = (pat: string) => new Set(hits(pat).map(([s]) => s));
  const notes = (layer: LayerId, inst: Inst, ns: readonly HookNote[], vel: number, shift = 0, tag?: MusicEvent['tag']) => {
    for (const n of ns) add(layer, inst, n.step, n.dur, n.midi + shift, vel * (Math.abs(n.step % 4) < 0.01 ? 1 : 0.85), tag ? { tag } : undefined);
  };
  const voicing = (layer: LayerId, inst: Inst, vel: number, lo: number) => {
    for (const t of chord.tones) add(layer, inst, 0, 16, lo + mod(chord.rootPc + t - lo, 12), vel);
  };

  // ---- harmony: a held pad in the intro and the break, a rhythmic comp under the hook ----
  const padLo = spec.padLo ?? 57;
  if (part === 'intro' || part === 'bassin' || part === 'build') voicing('calm', spec.pad, 0.5, padLo);
  if (part === 'breakdown') voicing('calm', spec.pad, 0.62, padLo);
  if (part === 'drop') voicing('finale', spec.pad, 0.4, padLo);
  const comp = spec.comp;
  if (comp && (full || (part === 'bassin' && barIn >= 6))) {
    const pat = (part === 'groove' || odd) && comp.alt ? comp.alt : comp.pat;
    const lo = comp.lo ?? 60;
    const tones = chord.tones.map((t) => lo + mod(chord.rootPc + t - lo, 12)).sort((a, b) => a - b);
    hits(pat).forEach(([s, v], i) => {
      if (comp.arp) add('calm', comp.inst, s, 2, tones[i % tones.length]!, v * (comp.vel ?? 0.5));
      else tones.forEach((m, k) => add('calm', comp.inst, s + k * (comp.stagger ?? 0), 2, m, v * (comp.vel ?? 0.5)));
    });
  }

  // ---- bass: in with the intro's second half, out for the breakdown, a pulse through the build, the big riff on the drop ----
  const riff = (layer: LayerId, inst: Inst, t: Theme, vel: number) => {
    for (const n of bassBar(t, barIn, chord, next, spec.bassLo)) add(layer, inst, n.step, n.dur, n.midi, vel * (Math.abs(n.step % 4) < 0.01 ? 1 : 0.82), n.from !== undefined ? { from: n.from } : undefined);
  };
  if (part === 'bassin' || part === 'hook' || part === 'groove') riff('calm', spec.bassInst, th, 0.85);
  if (part === 'build') {
    const root = spec.bassLo + mod(chord.rootPc - spec.bassLo, 12);
    for (let s = 0; s < (barIn === 7 ? 12 : 16); s += barIn >= 6 ? 2 : 4) add('calm', spec.bassInst, s, barIn >= 6 ? 2 : 4, root, 0.55 + barIn * 0.04);
  }
  if (part === 'drop') riff('calm', spec.dropInst, drop, 0.95);

  // ---- the beat ----
  const calmKick = spec.beat.calmKick, calmHat = spec.beat.calmHat;
  if (part === 'intro' || part === 'bassin' || part === 'hook' || part === 'groove') drum('calm', spec.kit.kick, calmKick, part === 'intro' ? 0.7 : 0.8);
  if (half) drum('calm', spec.kit.kick, '9.........7.....', 0.95);
  else if (part === 'drop') drum('calm', spec.kit.kick, calmKick, 0.9);
  if (part === 'build') drum('calm', spec.kit.kick, barIn >= 6 ? '9.7.9.7.9.7.....' : '9...7...9...7...', 0.55 + (barIn - 4) * 0.08);
  if (part === 'breakdown') drum('calm', spec.kit.hat, '..4...4...4...4.', 0.55);
  else drum('calm', spec.kit.hat, calmHat, part === 'intro' ? 0.6 : 0.75);
  if (spec.kit.perc && spec.beat.perc && (part === 'groove' || part === 'drop')) drum('calm', spec.kit.perc, spec.beat.perc, 0.7);
  // A fight fills the kit in around the calm beat and brings the backbeat.
  if (part !== 'breakdown' && part !== 'build') {
    if (!half) drum('combat', spec.kit.kick, spec.beat.kick, 0.85, stepsOf(calmKick));
    drum('combat', spec.kit.hat, spec.beat.hat, 0.7, stepsOf(calmHat));
    if (part !== 'intro') drum('combat', spec.kit.snare, half ? '........9.......' : spec.beat.snare, part === 'bassin' ? 0.65 : 0.9);
  }
  if (half) for (const s of [12, 12 + 2 / 3, 12 + 4 / 3, 14, 14.5, 15, 15.5]) add('combat', drumOf(spec.kit.hat)[0], s, 1, 0, 0.35 + (s - 12) * 0.08);
  if (part === 'build' && barIn >= 6) {
    const [sn, sm] = drumOf(spec.kit.snare);
    for (let s = 0; s < 16; s += barIn === 7 ? 1 : 2) add('combat', sn, s, 1, sm, 0.35 + s * 0.035 + (barIn - 6) * 0.15);
  }
  // Fills: a big one on each section's last bar, a small one halfway; the seed picks which.
  const fillKind = hash(seed, cycle, at.section, barIn, 61) % 3;
  const [fi, fm] = drumOf(spec.kit.fill);
  if (barIn === 7 && part !== 'build' && part !== 'breakdown') {
    if (fillKind === 0) for (let s = 12; s < 16; s++) add('combat', fi, s, 1, fm ? fm + 12 - (s - 12) * 3 : 0, 0.6 + (s - 12) * 0.1);
    else if (fillKind === 1) { const [sn, sm] = drumOf(spec.kit.snare); for (const s of [10, 11, 12, 13, 14, 15]) add('combat', sn, s, 1, sm, 0.45 + (s - 10) * 0.08); }
    else { add('combat', fi, 12, 1, fm ? fm + 7 : 0, 0.75); add('combat', fi, 14, 1, fm ? fm + 3 : 0, 0.8); add('combat', fi, 15, 1, fm, 0.85); }
    drum('calm', spec.kit.kick, '..............6.', 0.7);
  }
  if (barIn === 3 && full) { const [sn, sm] = drumOf(spec.kit.snare); add('combat', sn, 14, 1, sm, 0.4); add('combat', sn, 15, 1, sm, 0.5); }
  if (spec.kit.crash && barIn === 0 && full) { const [c] = drumOf(spec.kit.crash); add('combat', c, 0, 1, 0, 0.8); }
  if (part === 'drop' && barIn === 0) add('calm', 'impact', 0, 8, 0, 0.9);
  if (part === 'build' && barIn === 4) add('calm', 'riser', 0, 64, 0, 0.9);

  // ---- the hook ----
  const hookBar = th.A[ci]!, counterBar = th.B[ci]!;
  const call = ci % 2 === 0;
  const calmShift = spec.calmShift ?? 0, leadShift = spec.leadShift ?? 0, cv = spec.calmVel ?? 1;
  const scale = spec.minor ? MINOR : MAJOR;
  switch (part) {
    case 'bassin':
      // The tease: the call alone, softly, over the new bass.
      if (barIn >= 4 && call) notes('calm', spec.calm, hookBar, 0.5 * cv, calmShift, 'hook');
      break;
    case 'hook':
      notes('calm', spec.calm, hookBar, 0.68 * cv, calmShift, 'hook');
      notes('combat', spec.lead, hookBar, 0.8, leadShift, 'hook');
      notes('hype', spec.counterInst, counterBar, 0.5, 0, 'counter');
      break;
    case 'groove':
      // Call and response: the hook's voice calls, the counter voice answers; in a fight the lead jumps the octave for the second half.
      if (call) notes('calm', spec.calm, hookBar, 0.68 * cv, calmShift, 'hook');
      else notes('calm', spec.counterInst, counterBar, 0.6, 0, 'counter');
      notes('combat', spec.lead, hookBar, 0.8, leadShift + (barIn >= 4 ? octaveFor(spec.lead, th.A.flat(), leadShift, spec.grooveShift ?? 12) : 0), 'hook');
      if (call) notes('hype', spec.counterInst, counterBar, 0.42, 0, 'counter');
      break;
    case 'breakdown':
      if (call) notes('calm', spec.calm, hookBar, 0.55 * cv, calmShift, 'hook');
      notes('hype', spec.counterInst, counterBar, 0.3, 0, 'counter');
      break;
    case 'build':
      if (call) { notes('calm', spec.calm, hookBar, 0.6 * cv, calmShift, 'hook'); notes('combat', spec.lead, hookBar, 0.7, leadShift, 'hook'); }
      break;
    case 'drop':
      notes('calm', spec.calm, hookBar, 0.72 * cv, calmShift, 'hook');
      // Every other time round the drop doubles the hook an octave up.
      if (odd) { const o = octaveFor(spec.calm, th.A.flat(), calmShift); if (o) notes('calm', spec.calm, hookBar, 0.4 * cv, calmShift + o, 'hook'); }
      notes('combat', spec.lead, hookBar, 0.85, leadShift, 'hook');
      notes('hype', spec.counterInst, counterBar, 0.55, 0, 'counter');
      break;
    default:
  }
  // The finale: sixteenth hats, and the hook's harmony a third under on the lead.
  if (full) {
    for (let s = 0; s < 16; s++) add('finale', drumOf(spec.kit.hat)[0], s, 1, 0, s % 4 === 0 ? 0.45 : 0.28);
    notes('finale', spec.lead, diatonic(hookBar, spec.tonic, scale, -2), 0.42, leadShift);
  }

  // ---- the Zombies night: a heartbeat that thickens with the horde (tiers), and a pedal on the root ----
  if (spec.night) {
    const beat = (s: number, v: number, tier: 0 | 1 | 2) => add('heart', 'heart', s, 1, 0, v, { tier });
    beat(0, 1, 0); beat(2, 0.7, 0); beat(8, 1, 0); beat(10, 0.7, 0);
    beat(4, 0.9, 1); beat(6, 0.6, 1); beat(12, 0.9, 1); beat(14, 0.6, 1);
    for (const s of [3, 7, 11, 15]) beat(s, 0.5, 2);
    add('heart', 'bass', 0, 16, 36 + mod(chord.rootPc - 36, 12), 0.55, { tier: 0 });
  }
  spec.extra?.(cx);

  // The beat before the drop is silent but for the riser: the drop lands harder for it.
  const out = part === 'build' && barIn === 7 ? events.filter((e) => e.step < 12 || e.inst === 'riser') : events;
  return { barNo, mode, tonic: spec.tonic, chord, degree: mod(chord.rootPc - spec.tonic, 12), events: out };
}
