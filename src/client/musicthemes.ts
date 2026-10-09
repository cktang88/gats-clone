/**
 * The map themes: one `PopSpec` each, arranged by musicpop.ts to the rules in docs/music/CRAFT.md. Each theme has one hook (a 4-8 note motif in its
 * first bar, stated again in its third), one four-chord loop and its own tempo, key, groove and band. Melodies are musichook.ts notes (C4 is middle
 * C, lengths in sixteenths, `|` between bars); bass riffs are chord degrees, so they follow the chords, with `~` for an 808 glide.
 */
import { Q, type Deg, type PopSpec } from './musicpop.ts';

const d = (root: number, tones: readonly number[]): Deg => [root, tones];
const { maj, min, maj7, min7, dom7 } = Q;
// Pitch classes.
const C = 0, D = 2, E = 4, F = 5, G = 7, A = 9, B = 11, Eb = 3;

/** Old Town: a Balkan street band at a kolo's pace, round the Andalusian cadence. */
export const OLDTOWN: PopSpec = {
  id: 'oldtown', label: 'Cobblestone Kolo', bpm: 136, tonic: A, minor: true,
  prog: [d(0, min), d(10, maj), d(8, maj), d(7, maj)], progName: 'i-VII-VI-V',
  hook: 'A4:2 A4:1 C5:1 E5:2 A5:4 G#5:2 A5:4 | G5:2 F5:1 E5:1 D5:2 B4:4 D5:2 G5:4 | A4:2 A4:1 C5:1 F5:2 A5:4 G5:2 A5:4 | B4:2 C5:1 B4:1 G#4:2 B4:4 r:2 E5:4',
  counter: 'E5:4 C5:4 A4:4 C5:4 | D5:4 B4:4 G4:4 B4:4 | C5:4 A4:4 F4:4 A4:4 | B4:4 G#4:4 E4:4 G#4:4',
  bass: '1:4 5,:4 1:4 5,:4', dropBass: '1:2 8:2 5,:2 8:2 1:2 8:2 5,:2 8:2',
  calm: 'bandoneon', lead: 'violin', counterInst: 'flute', bassInst: 'tuba', bassLo: 40, dropInst: 'tuba', pad: 'accordion',
  comp: { inst: 'honky', pat: '..7...7...7...7.', alt: '..7...7...7.7.7.', lo: 60, vel: 0.45 },
  kit: { kick: 'kbb', snare: 'snare', hat: 'tamb', fill: ['tom', 45], crash: 'crash' },
  beat: { calmKick: '9.......9.......', kick: '9...6...9...6...', snare: '....8.......8...', calmHat: '..5...5...5...5.', hat: '..5.4.5.4.5.4.5.' },
};

/** Quarry: drift phonk for the diggers: a cowbell hook in a 3-3-2 tresillo, a distorted 808 and a half-time drop. */
export const QUARRY: PopSpec = {
  id: 'quarry', label: 'Rockfall Phonk', bpm: 144, tonic: G, minor: true,
  prog: [d(0, min), d(8, maj), d(5, min), d(7, maj)], progName: 'i-VI-iv-V',
  hook: 'G5:3 G5:3 Bb5:2 D6:3 C6:3 Bb5:2 | Bb5:2 Bb5:2 G5:2 Eb5:2 F5:3 G5:3 r:2 | G5:3 G5:3 C6:2 Eb6:3 D6:3 C6:2 | F#5:3 A5:3 D6:2 C6:2 A5:2 F#5:2 D5:2',
  counter: 'G4:2 D5:2 Bb4:2 D5:2 G4:2 D5:2 Bb4:2 D5:2 | G4:2 Eb5:2 Bb4:2 Eb5:2 G4:2 Eb5:2 Bb4:2 Eb5:2 | G4:2 Eb5:2 C5:2 Eb5:2 G4:2 Eb5:2 C5:2 Eb5:2 | F#4:2 D5:2 A4:2 D5:2 F#4:2 D5:2 A4:2 C5:2',
  bass: '1:3 1:3 1:2 r:4 8~:2 1~:2', dropBass: '1:10 r:2 8~:2 5~:2',
  calm: 'cowbell', lead: 'saw', leadShift: -12, counterInst: 'pluck', bassInst: 'b808d', bassLo: 31, dropInst: 'b808d', pad: 'dread', padLo: 55,
  kit: { kick: 'k909', snare: 'clap', hat: 'hat', perc: 'ohat', fill: ['tom', 43], crash: 'crash' },
  beat: { calmKick: '9.........9.....', kick: '9.....9...9..9..', snare: '....9.......9...', calmHat: '5.5.5.5.5.5.5.5.', hat: '5555555555555555', perc: '..5.......5.....' },
  halfTimeDrop: true,
};

/** Causeway: a stomp-and-clap sea shanty, swung, for the harbour. */
export const HARBOR: PopSpec = {
  id: 'harbor', label: 'Harbour Lights', bpm: 112, tonic: D, minor: true, swing: 0.3,
  prog: [d(0, min), d(10, maj), d(8, maj), d(10, maj)], progName: 'i-VII-VI-VII',
  hook: 'A4:3 A4:1 D5:2 D5:2 F5:3 E5:1 D5:4 | E5:3 E5:1 G5:2 E5:2 C5:4 r:4 | A4:3 A4:1 D5:2 D5:2 F5:3 E5:1 D5:4 | G5:3 F5:1 E5:2 D5:2 C5:2 E5:2 G5:4',
  counter: 'D6:4 A5:4 F5:4 A5:4 | E5:4 G5:4 C6:8 | D6:4 Bb5:4 F5:4 D5:4 | E5:4 G5:4 C6:4 E6:4',
  bass: '1:6 1:2 5:4 8:4', dropBass: '1:2 1:2 8:2 1:2 5:2 1:2 8:2 5:2',
  calm: 'accordion', lead: 'fiddle', counterInst: 'flute', bassInst: 'upright', bassLo: 33, dropInst: 'upright', pad: 'organ', padLo: 57,
  comp: { inst: 'steel', pat: '9...7.6.9...7.6.', alt: '9.6.7.6.9.6.7.6.', lo: 55, vel: 0.45, stagger: 0.12 },
  kit: { kick: 'stomp', snare: 'clap', hat: 'shaker', perc: ['bongo', 62], fill: ['tom', 45], crash: 'crash' },
  beat: { calmKick: '9.......9.......', kick: '9...9...9...9...', snare: '....9.......9...', calmHat: '..4...4...4...4.', hat: '4.4.4.4.4.4.4.4.', perc: '7..5..5.7..5..5.' },
  extra: (cx) => {
    if (cx.at.part === 'breakdown' && cx.at.barIn === 0) cx.add('calm', 'foghorn', 0, 12, 38, 0.6);
    if (cx.at.part === 'breakdown' && cx.at.barIn === 2) cx.add('calm', 'gull', 6, 3, 86, 0.4);
  },
};

/** Night Market: an eight-bit arcade tune (the stand-in while Eric Skiff's recording, the map's own, loads). */
export const MARKET: PopSpec = {
  id: 'market', label: 'Lantern Arcade', bpm: 132, tonic: E, minor: false,
  prog: [d(0, maj), d(7, maj), d(9, min), d(5, maj)], progName: 'I-V-vi-IV',
  hook: 'B4:2 E5:2 G#5:2 B5:2 A5:3 G#5:3 E5:2 | F#5:2 D#5:2 B4:4 C#5:2 D#5:2 F#5:4 | C#5:2 E5:2 G#5:2 C#6:2 B5:3 G#5:3 E5:2 | E5:2 F#5:2 A5:4 G#5:2 F#5:2 E5:4',
  counter: 'E6:4 B5:4 G#5:4 B5:4 | D#6:4 B5:4 F#5:8 | E6:4 C#6:4 G#5:8 | C#6:4 A5:4 E5:8',
  bass: '1:2 1:2 8:2 1:2 5:2 1:2 8:2 5:2', dropBass: '1:1 1:1 8:2 1:1 1:1 8:2 1:1 1:1 8:2 5:2 8:2',
  calm: 'pluck', lead: 'square', counterInst: 'chime', bassInst: 'tri', bassLo: 40, dropInst: 'tri', pad: 'padair',
  comp: { inst: 'square', pat: '..4...4...4...4.', alt: '6.4.6.4.6.4.6.4.', lo: 64, vel: 0.4, arp: true },
  kit: { kick: 'k909', snare: ['chip', 40], hat: 'chip', fill: ['chip', 40], crash: 'crash' },
  beat: { calmKick: '9.......9.......', kick: '9.....6.9.......', snare: '....9.......9...', calmHat: '..5...5...5...5.', hat: '5.5.5.5.5.5.5.5.' },
};

/** Museum: a tip-toe heist in swung jazz: vibes and sax over a walking bass and finger snaps. */
export const MUSEUM: PopSpec = {
  id: 'museum', label: 'Velvet Rope', bpm: 100, tonic: E, minor: true, swing: 0.4,
  prog: [d(0, min), d(5, min), d(10, maj), d(3, maj)], progName: 'i-iv-VII-III',
  hook: 'E4:1 r:1 G4:1 r:1 B4:2 A#4:1 B4:1 r:2 E5:2 D5:4 | C5:1 r:1 B4:1 r:1 A4:2 E4:2 r:2 A4:2 C5:4 | D4:1 r:1 F#4:1 r:1 A4:2 G#4:1 A4:1 r:2 D5:2 C5:4 | B4:1 r:1 D5:1 r:1 E5:2 D5:2 r:2 B4:2 G4:4',
  counter: 'E4:2 G4:2 B4:2 G4:2 E4:2 G4:2 B4:4 | A4:2 C5:2 E5:2 C5:2 A4:2 r:2 E5:4 | F#4:2 A4:2 D5:2 A4:2 F#4:2 A4:2 D5:4 | G4:2 B4:2 D5:2 B4:2 G4:4 B4:4',
  bass: '1:4 3:4 5:4 ^:4', dropBass: '1:2 8:2 1:2 8:2 5:2 8:2 ^:4',
  calm: 'vibes', lead: 'sax', counterInst: 'pluck', bassInst: 'upright', bassLo: 33, dropInst: 'upright', pad: 'padair',
  comp: { inst: 'piano', pat: '6..5............', alt: '......5...6..5..', lo: 55, vel: 0.5 },
  kit: { kick: 'kbb', snare: 'snap', hat: 'ride', perc: 'brush', fill: ['tom', 45] },
  beat: { calmKick: '9.........6.....', kick: '9.....6...6.....', snare: '....8.......8...', calmHat: '6...6.4.6...6.4.', hat: '..3.......3.....', perc: '4.4.4.4.4.4.4.4.' },
  // The heist goes loud on the drop: brass stabs.
  extra: (cx) => {
    if (cx.at.part !== 'drop') return;
    for (const s of [0, 6]) for (const t of cx.chord.tones) cx.add('combat', 'synbrass', s, 2, 60 + ((cx.chord.rootPc + t - 60) % 12 + 12) % 12, 0.45);
  },
};

/** Sub Pen: dark trap under the water: a sonar-ping hook, 808 glides and a half-time drop. */
export const SUBPEN: PopSpec = {
  id: 'subpen', label: 'Deep Contact', bpm: 140, tonic: F, minor: true,
  prog: [d(0, min), d(8, maj), d(3, maj), d(10, maj)], progName: 'i-VI-III-VII',
  hook: 'C5:3 F5:3 Ab5:2 G5:4 F5:2 Eb5:2 | F5:3 Ab5:3 Db6:2 C6:4 Ab5:4 | C5:3 Eb5:3 Ab5:2 G5:4 F5:2 Eb5:2 | G5:3 Bb5:3 Eb6:2 D6:2 Bb5:2 G5:4',
  counter: 'F4:2 Ab4:2 C5:2 Ab4:2 F4:2 Ab4:2 C5:2 Ab4:2 | F4:2 Ab4:2 Db5:2 Ab4:2 F4:2 Ab4:2 Db5:2 Ab4:2 | Eb4:2 Ab4:2 C5:2 Ab4:2 Eb4:2 Ab4:2 C5:2 Ab4:2 | Eb4:2 G4:2 Bb4:2 G4:2 Eb4:2 G4:2 Bb4:2 G4:2',
  bass: '1:8 r:4 1:2 8~:2', dropBass: '1:4 1:2 r:2 8~:4 5~:2 1~:2',
  calm: 'sonar', lead: 'acid', leadShift: -12, counterInst: 'pluck', bassInst: 'b808', bassLo: 29, dropInst: 'b808', pad: 'dread', padLo: 53,
  kit: { kick: 'k909', snare: 'clap', hat: 'hat', perc: 'rim', fill: ['tom', 41], crash: 'crash' },
  beat: { calmKick: '9.........9.....', kick: '9.....9...9...6.', snare: '........9.......', calmHat: '5.5.5.5.5.5.5.5.', hat: '5555555555555555', perc: '...6......6.....' },
  halfTimeDrop: true,
  // A long sonar ping sounds through the breakdown.
  extra: (cx) => { if (cx.at.part === 'breakdown' && cx.at.barIn % 2 === 0) cx.add('calm', 'sonar', 0, 8, 89, 0.4); },
};

/** Park: sunny indie pop: glockenspiel and flute over a strummed ukulele and hand claps. */
export const PARK: PopSpec = {
  id: 'park', label: 'Picnic Parade', bpm: 118, tonic: C, minor: false,
  prog: [d(0, maj), d(7, maj), d(9, min), d(5, maj)], progName: 'I-V-vi-IV',
  hook: 'E5:2 E5:1 G5:3 C6:2 B5:2 G5:6 | B4:3 D5:3 G5:2 F5:2 E5:2 D5:4 | E5:2 E5:1 G5:3 C6:2 B5:2 A5:6 | A5:3 G5:3 F5:2 E5:2 D5:2 C5:4',
  counter: 'C5:4 G4:2 A4:2 B4:4 G4:4 | B4:4 D5:2 B4:2 G4:8 | A4:4 C5:2 E5:2 A4:8 | F4:2 A4:2 C5:2 F5:2 E5:4 D5:4',
  bass: '1:6 1:2 5:4 8:2 5:2', dropBass: '1:2 8:2 1:2 8:2 1:2 8:2 5:2 8:2',
  calm: 'glock', lead: 'flute', counterInst: 'harp', bassInst: 'fbass', bassLo: 36, dropInst: 'fbass', pad: 'padair', padLo: 60,
  comp: { inst: 'uke', pat: '9.6..6.69.6..6.6', alt: '9.6.9.6.9.6.9.6.', lo: 64, vel: 0.32, stagger: 0.1 },
  kit: { kick: 'kick', snare: 'clap', hat: 'shaker', perc: 'tamb', fill: ['tom', 47], crash: 'crash' },
  beat: { calmKick: '9.......9.......', kick: '9.....6.9.......', snare: '....9.......9...', calmHat: '..5...5...5...5.', hat: '5.5.5.5.5.5.5.5.', perc: '....6.......6...' },
};

/** Rail Yard: a freight-train boogie in A mixolydian: a clean-guitar lick, harmonica in a fight, and the chug of the train. */
export const RAILYARD: PopSpec = {
  id: 'railyard', label: 'Freight Boogie', bpm: 126, tonic: A, minor: false, swing: 0.45,
  prog: [d(0, maj), d(10, maj), d(5, maj), d(0, maj)], progName: 'I-bVII-IV-I',
  hook: 'E5:2 A5:2 r:1 A5:1 G5:2 E5:2 C#5:2 E5:4 | D5:2 G5:2 r:1 G5:1 F5:2 D5:2 B4:2 D5:4 | E5:2 A5:2 r:1 A5:1 F#5:2 D5:2 A4:2 D5:4 | C#5:2 E5:2 G5:2 A5:2 G5:1 E5:1 C#5:2 A4:4',
  counter: 'A4:4 C#5:4 E5:4 C#5:4 | B4:4 D5:4 G5:4 D5:4 | A4:4 D5:4 F#5:4 D5:4 | A4:4 C#5:4 E5:4 G5:4',
  bass: '1:2 3:2 5:2 6:2 7:2 6:2 5:2 3:2', dropBass: '1:2 8:2 5:2 8:2 6:2 8:2 7:2 8:2',
  calm: 'twang', lead: 'harmonica', counterInst: 'organ', bassInst: 'fbass', bassLo: 33, dropInst: 'fbass', pad: 'organ', padLo: 60,
  comp: { inst: 'honky', pat: '..6...6...6...6.', alt: '..6.6...6.6...6.', lo: 60, vel: 0.4 },
  kit: { kick: 'krock', snare: 'srock', hat: 'chug', perc: 'tamb', fill: ['tom', 45], crash: 'crash' },
  beat: { calmKick: '9.......9.......', kick: '9...9...9...9...', snare: '....9.......9...', calmHat: '6.4.6.4.6.4.6.4.', hat: '6464646464646464', perc: '....6.......6...' },
  extra: (cx) => {
    // The crossing bell rings the train in, and the whistle blows on the drop.
    if (cx.at.part === 'intro') for (const s of [0, 8]) cx.add('calm', 'rbell', s, 4, 81, 0.35);
    if (cx.at.part === 'drop' && cx.at.barIn === 0) for (const m of [73, 76]) cx.add('combat', 'harmonica', 0, 6, m, 0.5);
  },
};

/** Summit: an epic winter fanfare: chimes and French horn, sleigh bells, and a half-time drop of big drums. */
export const SUMMIT: PopSpec = {
  id: 'summit', label: 'Whiteout', bpm: 128, tonic: B, minor: true,
  prog: [d(0, min), d(8, maj), d(3, maj), d(10, maj)], progName: 'i-VI-III-VII',
  hook: 'F#4:4 B4:2 C#5:2 D5:3 C#5:1 B4:2 F#5:2 | G5:4 F#5:2 E5:2 D5:4 B4:4 | F#4:4 A4:2 B4:2 D5:3 C#5:1 A4:2 F#5:2 | E5:4 C#5:2 E5:2 A5:4 E5:4',
  counter: 'D5:8 F#5:8 | D5:8 B4:8 | A4:8 D5:8 | C#5:8 E5:8',
  bass: '1:6 1:2 1:4 8:4', dropBass: '1:12 8~:4',
  calm: 'chime', calmVel: 1.7, lead: 'horn', counterInst: 'choir', bassInst: 'synbass', bassLo: 35, dropInst: 'b808', pad: 'padair',
  comp: { inst: 'harp', pat: '6.4.6.4.6.4.6.4.', alt: '6.4.4.6.4.4.6.4.', lo: 59, vel: 0.4, arp: true },
  kit: { kick: 'krock', snare: 'snare', hat: 'sleigh', perc: ['tom', 43], fill: ['tom', 45], crash: 'crash' },
  beat: { calmKick: '9.......9.......', kick: '9.....9.9.....9.', snare: '....9.......9...', calmHat: '5.5.5.5.5.5.5.5.', hat: '5555555555555555', perc: '9..6..6.9..6..6.' },
  halfTimeDrop: true,
};

/** Embassy: nu-disco at the gala: a piano stab hook, muted trumpet, slap-bass octaves and string runs over four on the floor. */
export const EMBASSY: PopSpec = {
  id: 'embassy', label: 'Gala Night', bpm: 116, tonic: F, minor: false,
  prog: [d(2, min7), d(7, dom7), d(0, maj7), d(9, min7)], progName: 'ii-V-I-vi',
  hook: 'F5:1 F5:1 r:2 D5:2 F5:2 G5:3 F5:1 D5:4 | E5:2 G5:2 Bb5:4 A5:2 G5:2 E5:4 | F5:1 F5:1 r:2 C5:2 F5:2 A5:3 G5:1 E5:4 | D5:2 F5:2 A5:2 C6:2 A5:4 F5:4',
  counter: 'Bb5:2 A5:2 G5:4 D6:8 | C6:2 Bb5:2 G5:4 E6:8 | C6:2 A5:2 F5:4 E6:8 | A5:2 C6:2 D6:4 F6:8',
  bass: '1:2 8:2 1:2 8:2 1:2 8:2 1:2 8:2', dropBass: '1:2 8:2 1:2 8:2 5:2 8:2 1:2 8:2',
  calm: 'piano', lead: 'trumpet', counterInst: 'violin', bassInst: 'slap', bassLo: 31, dropInst: 'slap', pad: 'violin', padLo: 60,
  comp: { inst: 'twang', pat: '..6...6...6...6.', alt: '..6..56...6..56.', lo: 62, vel: 0.4 },
  kit: { kick: 'k909', snare: 'clap', hat: 'hat', perc: 'ohat', fill: ['tom', 45], crash: 'crash' },
  beat: { calmKick: '9...9...9...9...', kick: '9...9...9...9...', snare: '....9.......9...', calmHat: '..5...5...5...5.', hat: '5.5.5.5.5.5.5.5.', perc: '..6...6...6...6.' },
};

/** Airbase: a trap anthem for the scramble: trumpets up the triad, synth brass in a fight, a half-time 808 drop. */
export const AIRBASE: PopSpec = {
  id: 'airbase', label: 'Scramble', bpm: 150, tonic: C, minor: false,
  prog: [d(9, min), d(5, maj), d(0, maj), d(7, maj)], progName: 'vi-IV-I-V',
  hook: 'A4:2 C5:2 E5:4 r:2 E5:2 G5:2 E5:2 | F5:4 E5:2 C5:2 A4:8 | G4:2 C5:2 E5:4 r:2 E5:2 G5:2 E5:2 | D5:4 B4:2 D5:2 G5:4 F5:2 D5:2',
  counter: 'E5:2 A5:2 C6:2 A5:2 E5:2 A5:2 C6:2 A5:2 | F5:2 A5:2 C6:2 A5:2 F5:2 A5:2 C6:2 A5:2 | E5:2 G5:2 C6:2 G5:2 E5:2 G5:2 C6:2 G5:2 | D5:2 G5:2 B5:2 G5:2 D5:2 G5:2 B5:2 D6:2',
  bass: '1:6 1:2 1:4 8:2 1:2', dropBass: '1:8 r:2 1:2 8~:2 5~:2',
  calm: 'tpt', calmVel: 1.25, lead: 'synbrass', counterInst: 'saw', bassInst: 'synbass', bassLo: 33, dropInst: 'b808', pad: 'padair',
  comp: { inst: 'synbrass', pat: '9.....7.....7...', alt: '9.....7...7.7...', lo: 55, vel: 0.35 },
  kit: { kick: 'k909', snare: 'clap', hat: 'hat', perc: 'snare', fill: ['tom', 43], crash: 'crash' },
  beat: { calmKick: '9.......9.......', kick: '9.....9.9.....6.', snare: '....9.......9...', calmHat: '5.5.5.5.5.5.5.5.', hat: '5555555555555555', perc: '...3..3....3.33.' },
  halfTimeDrop: true,
  // The propellers spin up under the intro and the breakdown.
  extra: (cx) => { if ((cx.at.part === 'intro' || cx.at.part === 'breakdown') && cx.at.barIn % 4 === 0) cx.add('calm', 'drone', 0, 64, 33 + ((cx.chord.rootPc - 33) % 12 + 12) % 12, 0.5); },
};

/** Wasteland: western phonk: a lone whistle and a slide guitar over an 808, with a cowbell counter-melody. */
export const WASTELAND: PopSpec = {
  id: 'wasteland', label: 'Dust Devil', bpm: 96, tonic: E, minor: true,
  prog: [d(0, min), d(8, maj), d(10, maj), d(7, maj)], progName: 'i-VI-VII-V',
  hook: 'E5:6 B5:2 A5:2 G5:2 F#5:4 | G5:6 E5:2 C5:4 E5:4 | D5:6 A5:2 G5:2 F#5:2 E5:4 | D#5:6 F#5:2 B5:4 A5:2 F#5:2',
  counter: 'E6:2 B5:2 G5:2 B5:2 E6:2 B5:2 G5:2 B5:2 | E6:2 C6:2 G5:2 C6:2 E6:2 C6:2 G5:2 C6:2 | D6:2 A5:2 F#5:2 A5:2 D6:2 A5:2 F#5:2 A5:2 | D#6:2 B5:2 F#5:2 B5:2 D#6:2 B5:2 F#5:2 A5:2',
  bass: '1:6 1:2 r:4 5~:2 1~:2', dropBass: '1:10 8~:2 1~:4',
  calm: 'steel', lead: 'whistle', counterInst: 'cowbell', bassInst: 'b808', bassLo: 28, dropInst: 'b808d', pad: 'choir', padLo: 55,
  kit: { kick: 'k909', snare: 'clap', hat: 'hat', perc: 'rim', fill: ['tom', 41], crash: 'crash' },
  beat: { calmKick: '9.......9.......', kick: '9.....9...9.....', snare: '....9.......9...', calmHat: '5.5.5.5.5.5.5.5.', hat: '5555555555555555', perc: '..6..6....6..6..' },
  halfTimeDrop: true,
  // The wind blows through the breakdown.
  extra: (cx) => { if (cx.at.part === 'breakdown' && cx.at.barIn === 0) cx.add('calm', 'wind', 0, 64, 0, 0.8); },
};

/** Range: lo-fi for the firing lanes: a Rhodes sigh, nylon guitar in a fight, a dusty boom-bap kit, swung hard. */
export const RANGE: PopSpec = {
  id: 'range', label: 'Practice Lane', bpm: 84, tonic: Eb, minor: false, swing: 0.5,
  prog: [d(5, maj7), d(7, dom7), d(4, min7), d(9, min7)], progName: 'IV-V-iii-vi',
  hook: 'Eb5:2 G5:2 Bb5:3 Ab5:1 G5:4 Eb5:4 | F5:2 Ab5:2 D5:4 F5:2 Eb5:2 D5:4 | D5:2 G5:2 Bb5:3 Ab5:1 G5:4 D5:4 | C5:2 Eb5:2 G5:4 Bb4:2 C5:2 Eb5:4',
  counter: 'C5:8 Eb5:8 | D5:8 F5:8 | Bb4:8 D5:8 | Eb5:8 G5:8',
  bass: '1:6 1:2 r:2 5:2 8:4', dropBass: '1:4 1:2 5:2 8:4 5:4',
  calm: 'epiano', lead: 'uke', counterInst: 'vibes', bassInst: 'upright', bassLo: 32, dropInst: 'upright', pad: 'padair',
  comp: { inst: 'piano', pat: '6.....5.........', alt: '6.....5...4.....', lo: 55, vel: 0.4 },
  kit: { kick: 'kbb', snare: 'sbb', hat: 'hat', perc: 'dust', fill: 'rim' },
  beat: { calmKick: '9.........9.....', kick: '9......69.6.....', snare: '....9.......9...', calmHat: '..4...4...4...4.', hat: '4.4.4.4.4.4.4.4.', perc: '3..3.3..3..3.3..' },
};

/** Outpost by day: a bouncy build theme: marimba, tuba and bongos while the squad builds its defences. */
export const OUTPOST_DAY: PopSpec = {
  id: 'outpost', label: 'Bastion', bpm: 112, tonic: G, minor: false,
  prog: [d(0, maj), d(9, min), d(5, maj), d(7, maj)], progName: 'I-vi-IV-V',
  hook: 'D5:1 E5:1 G5:2 G5:2 B5:2 A5:2 G5:2 E5:4 | E5:2 G5:2 B5:4 A5:2 G5:2 E5:4 | D5:1 E5:1 G5:2 G5:2 C6:2 B5:2 G5:2 E5:4 | F#5:2 A5:2 D6:4 C6:2 A5:2 F#5:4',
  counter: 'B5:4 D6:4 B5:4 G5:4 | B5:4 G5:4 E5:8 | C6:4 E6:4 C6:4 G5:4 | A5:4 F#5:4 D5:4 F#5:4',
  bass: '1:4 5,:2 5,:2 1:4 5,:4', dropBass: '1:2 8:2 5,:2 8:2 1:2 8:2 5,:2 8:2',
  calm: 'marimba', lead: 'harp', counterInst: 'whistle', bassInst: 'tuba', bassLo: 36, dropInst: 'tuba', pad: 'padair',
  comp: { inst: 'steel', pat: '9.7.9.7.9.7.9.7.', alt: '9..79..79..79.7.', lo: 62, vel: 0.32, stagger: 0.1 },
  kit: { kick: 'kick', snare: 'clap', hat: 'shaker', perc: ['bongo', 66], fill: ['tom', 47], crash: 'crash' },
  beat: { calmKick: '9.......9.......', kick: '9.....6.9.......', snare: '....9.......9...', calmHat: '..4...4...4...4.', hat: '4.4.4.4.4.4.4.4.', perc: '..5..5..5..5.5..' },
  // Hammers at work on the groove.
  extra: (cx) => { if (cx.at.part === 'groove') cx.add('calm', 'clank', 6, 1, 84, 0.3); },
};

/** Outpost by night: the horde: a bell through the raised seventh, a horror organ in a fight, a heartbeat, and a half-time 808 drop. */
export const OUTPOST_NIGHT: PopSpec = {
  id: 'outpost', label: 'Horde Night', bpm: 108, tonic: G, minor: true,
  prog: [d(0, min), d(5, min), d(8, maj), d(7, maj)], progName: 'i-iv-VI-V',
  hook: 'G4:2 Bb4:2 D5:2 F#5:2 G5:4 D5:4 | Eb5:2 D5:2 C5:4 G4:4 C5:4 | G4:2 Bb4:2 Eb5:2 F5:2 G5:4 Eb5:4 | F#5:2 D5:2 A4:4 C5:2 A4:2 F#4:4',
  counter: 'D5:8 Bb4:8 | C5:8 Eb5:8 | Bb4:8 G4:8 | A4:8 F#4:8',
  bass: '1:2 1:2 1:2 1:2 1:2 1:2 1:2 1:2', dropBass: '1:8 r:2 1:2 8~:2 1~:2',
  calm: 'bell', lead: 'organ', counterInst: 'saw', bassInst: 'synbass', bassLo: 31, dropInst: 'b808', pad: 'choir', padLo: 55,
  kit: { kick: 'stomp', snare: 'sgate', hat: 'hat', perc: ['tom', 43], fill: ['tom', 45], crash: 'crash' },
  beat: { calmKick: '9.......9.......', kick: '9.....9.9.......', snare: '....9.......9...', calmHat: '..4...4...4...4.', hat: '4.4.4.4.4.4.4.4.', perc: '9.....6.........' },
  halfTimeDrop: true,
  night: true,
};

/** Every theme a map plays (the Outpost has two, day and night). */
export const THEMES: readonly PopSpec[] = [OLDTOWN, QUARRY, HARBOR, MARKET, MUSEUM, SUBPEN, PARK, RAILYARD, SUMMIT, EMBASSY, AIRBASE, WASTELAND, RANGE, OUTPOST_DAY, OUTPOST_NIGHT];
