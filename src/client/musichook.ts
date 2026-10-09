/**
 * The written tunes: every track's signature theme (an eight-bar A, a contrasting eight-bar B) and its bass riff, as text, so a hook is
 * the same notes every time the track plays. Pure and dependency-free; musicgen.ts and musictheory.ts arrange them into the layers.
 *
 * A melody is bars separated by `|`, each bar notes as `<name><octave>:<length>` (`C5:3`, `Bb4:1`, `F#5:2`; C4 is midi 60), `r:<length>`
 * a rest, and a note with no `:<length>` keeps the length before it. Lengths are sixteenths in a 4/4 bar (16 a bar) or eighths in a
 * 12/8 bar (12 a bar), and every bar must add up exactly.
 *
 * A bass riff is the same shape but its notes name chord degrees, so it follows whatever chord is under it: `1` root, `3` the chord's
 * third, `5` its fifth, `7` its seventh (a minor seventh on a triad), `8` the octave, `2` `4` `6` the major second, fourth and sixth,
 * `@n` n semitones above the root, `^` a semitone under the next bar's root (a walk into the change); a `'` or `,` after one moves it
 * an octave up or down, and a `~` after that slides into the note from the one before it (the 808's glide).
 */
import type { Chord } from './musictheory.ts';

/** `from`: the pitch the note slides in from (an 808 glide), when it has one. */
export type HookNote = { step: number; dur: number; midi: number; from?: number };
/** One bar of notes, steps in sixteenths of the bar. */
export type HookBar = readonly HookNote[];
export type BassNote = { step: number; dur: number; deg: string; oct: number; slide?: boolean };
export type ThemeSrc = {
  /** Units in a bar: 16 (sixteenths of 4/4) or 12 (eighths of 12/8). */
  meter?: 12 | 16;
  /** The hook: eight bars (twelve for a blues). */
  A: string;
  /** The contrasting theme. */
  B: string;
  /** The bass riff, one or two bars, looping. */
  bass: string;
};
export type Theme = { meter: 12 | 16; A: readonly HookBar[]; B: readonly HookBar[]; bass: readonly (readonly BassNote[])[]; src: ThemeSrc };

const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** `C4` is 60, `Bb3` 58, `F#5` 78. */
function noteMidi(name: string): number {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) throw new Error(`not a note: ${name}`);
  return 12 * (Number(m[3]) + 1) + LETTER[m[1]!]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const midiName = (m: number) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

function tokens<T>(src: string, meter: number, read: (pitch: string) => T): { step: number; dur: number; v: T }[][] {
  const scale = 16 / meter;
  return src.split('|').map((bar, b) => {
    let at = 0, len = 0;
    const out: { step: number; dur: number; v: T }[] = [];
    for (const tok of bar.trim().split(/\s+/)) {
      if (!tok) continue;
      const [pitch, l] = tok.split(':');
      if (l !== undefined) len = Number(l);
      if (!(len > 0)) throw new Error(`bar ${b + 1}: no length for ${tok}`);
      if (pitch !== 'r') out.push({ step: at * scale, dur: len * scale, v: read(pitch!) });
      at += len;
    }
    if (Math.abs(at - meter) > 1e-9) throw new Error(`bar ${b + 1} of "${src.slice(0, 40)}..." is ${at} units long, not ${meter}`);
    return out;
  });
}

const parseMelody = (src: string, meter: 12 | 16): HookBar[] => tokens(src, meter, noteMidi).map((bar) => bar.map(({ step, dur, v }) => ({ step, dur, midi: v })));

function parseBass(src: string, meter: 12 | 16): BassNote[][] {
  return tokens(src, meter, (p) => {
    const m = /^(@\d+|[1-8^])([',]*)(~?)$/.exec(p);
    if (!m) throw new Error(`not a bass degree: ${p}`);
    const oct = [...m[2]!].reduce((o, c) => o + (c === "'" ? 1 : -1), 0);
    return m[3] ? { deg: m[1]!, oct, slide: true } : { deg: m[1]!, oct };
  }).map((bar) => bar.map(({ step, dur, v }) => ({ step, dur, ...v })));
}

export function theme(src: ThemeSrc): Theme {
  const meter = src.meter ?? 16;
  return { meter, A: parseMelody(src.A, meter), B: parseMelody(src.B, meter), bass: parseBass(src.bass, meter), src };
}

const mod = (n: number, m: number) => ((n % m) + m) % m;
/** Semitones above the chord's root for a bass degree. */
function degOffset(deg: string, chord: Chord): number {
  const t = chord.tones;
  switch (deg) {
    case '1': return 0;
    case '2': return 2;
    case '3': return t[1]!;
    case '4': return 5;
    case '5': return t[2]! < 12 ? t[2]! : 7;
    case '6': return 9;
    case '7': return t[3] !== undefined && t[3] < 12 ? t[3] : 10;
    case '8': return 12;
    default: return Number(deg.slice(1));
  }
}

/** The riff's notes for one bar as midi, its root the lowest root at or above `lo`. */
export function bassBar(th: Theme, bar: number, chord: Chord, next: Chord, lo: number): HookNote[] {
  const root = lo + mod(chord.rootPc - lo, 12);
  const nextRoot = lo + mod(next.rootPc - lo, 12);
  const out: HookNote[] = [];
  for (const n of th.bass[bar % th.bass.length]!) {
    const base = n.deg === '^' ? (Math.abs(nextRoot - 1 - root) <= 6 ? nextRoot - 1 : nextRoot - 1 + (nextRoot > root ? -12 : 12)) : root + degOffset(n.deg, chord);
    const prev = out.at(-1);
    out.push(n.slide && prev ? { step: n.step, dur: n.dur, midi: base + 12 * n.oct, from: prev.midi } : { step: n.step, dur: n.dur, midi: base + 12 * n.oct });
  }
  return out;
}

/** True when `midi` is one of the chord's tones. */
export const isChordTone = (midi: number, chord: Chord) => chord.tones.some((t) => mod(midi - chord.rootPc - t, 12) === 0);

/** The same notes moved `steps` places along a scale (pitch classes above `tonic`); a third below is -2. Notes off the scale snap to the nearest one under. */
export function diatonic(notes: readonly HookNote[], tonic: number, scale: readonly number[], steps: number): HookNote[] {
  return notes.map((n) => {
    let m = n.midi;
    while (!scale.includes(mod(m - tonic, 12))) m--;
    let k = Math.abs(steps);
    while (k > 0) { m += Math.sign(steps); if (scale.includes(mod(m - tonic, 12))) k--; }
    return { ...n, midi: m };
  });
}

/** The skeleton of a bar: the notes on a beat and the long ones, for the quiet layer. */
export const sparse = (notes: readonly HookNote[]): HookNote[] => notes.filter((n, i) => i === 0 || Math.abs(n.step % 4) < 0.01 || n.dur >= 3);

/** A tune's shape for comparing hooks: the onsets and the moves between successive notes. */
function contour(bars: readonly HookBar[]): { onsets: number[]; moves: number[] } {
  const notes = bars.flatMap((b, i) => b.map((n) => ({ ...n, step: n.step + 16 * i })));
  return { onsets: notes.map((n) => n.step), moves: notes.slice(1).map((n, i) => n.midi - notes[i]!.midi) };
}

/**
 * How unlike two hooks are, 0 (the same tune) to 1: half from their rhythm (the onsets the two do not share), half from their
 * contour (the moves from note to note that differ by more than a semitone, an extra or missing move counting as different).
 */
export function hookDistance(a: readonly HookBar[], b: readonly HookBar[]): number {
  const ca = contour(a), cb = contour(b);
  const grid = (o: number[]) => new Set(o.map((s) => Math.round(s * 2)));
  const ga = grid(ca.onsets), gb = grid(cb.onsets);
  const shared = [...ga].filter((s) => gb.has(s)).length;
  const rhythm = 1 - shared / new Set([...ga, ...gb]).size;
  const n = Math.max(ca.moves.length, cb.moves.length);
  let differ = 0;
  for (let i = 0; i < n; i++) { const x = ca.moves[i], y = cb.moves[i]; if (x === undefined || y === undefined || Math.abs(x - y) > 1) differ++; }
  return (rhythm + (n ? differ / n : 0)) / 2;
}
