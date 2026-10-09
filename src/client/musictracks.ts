/**
 * The synthesized library: one composition per map, all in the adaptive framework (calm, combat, hype, finale and, for the Zombies night, heart).
 * The menu's and Plaza's march is the original (musicclassic.ts, restored from commit af4983a); the rest are `TrackSpec`s from musictracksa/b/c.ts
 * written by musicgen.ts. Every map but the Plaza now plays a licensed recording (musicstream.ts); these stand in while it loads or if it fails.
 */
import { generateTrackBar, formBars, formOf } from './musicgen.ts';
import { AIRBASE, EMBASSY, RAILYARD, RANGE, SUMMIT, WASTELAND, OUTPOST } from './musictracksb.ts';
import { HARBOR, MARKET, MUSEUM, PARK, SUBPEN } from './musictracksa.ts';
import { OLDTOWN, QUARRY } from './musictracksc.ts';
import type { TrackSpec } from './musicgen.ts';
import { tempoFor, type Bar, type Inst, type Mode, type MusicInput } from './musictheory.ts';
import { CLASSIC_INSTS, classicBar, classicKeyOfSeed } from './musicclassic.ts';
import type { Theme } from './musichook.ts';

import { TRACK_IDS, type SongId, type StationId, type TrackId } from '../shared/radio.ts';
export { TRACK_IDS, type SongId, type TrackId };

export type TrackDef = {
  id: TrackId;
  /** Shown on the radio. */
  label: string;
  /** The key the track plays in (every written track keeps its own; the original march takes a new key with each seed). */
  tonic(seed: number): number;
  /** Beats per minute for the moment. */
  bpm(input: Pick<MusicInput, 'mode' | 'night' | 'day'>): number;
  /** Loudness trim so every track sits at about the same level. */
  trim: number;
  /** The bell or pluck a kill rings on. */
  sting: Inst;
  bar(seed: number, mode: Mode, barNo: number): Bar;
  /** Bars before the form repeats, in each mode. */
  formBars: Record<Mode, number>;
  /** The track's spec, for the written tracks (the march is generated in musictheory.ts). */
  spec?: TrackSpec;
  /** The signature tune: the same notes every time the track plays (musichook.ts). The original march has none: its tunes are seeded. */
  theme?: Theme;
  /** 'classic': voiced by musicclassic.ts's own synth (the original march), not the shared rig. */
  voice?: 'classic';
  /** The bar its hook first sounds (after the intro): a radio retune starts the station there, so the tune is heard at once. */
  hookStart: Record<Mode, number>;
};

const instsSeen = new Map<TrackId, Set<Inst>>();
/** Every instrument a track plays, in either mode: what to load before it starts (its sampled ones). */
export function instsOf(id: TrackId): Set<Inst> {
  let seen = instsSeen.get(id);
  if (!seen && id === 'march') { seen = new Set(CLASSIC_INSTS); instsSeen.set(id, seen); }
  if (!seen) {
    seen = new Set();
    const t = TRACKS[id];
    for (const mode of ['major', 'minor'] as const) for (let n = 0; n < t.formBars[mode]; n++) for (const e of t.bar(1, mode, n).events) seen.add(e.inst);
    instsSeen.set(id, seen);
  }
  return seen;
}
const firstA = (spec: TrackSpec, mode: Mode) => { let at = 0; for (const s of formOf(spec, mode)) { if (s.kind === 'A') return at; at += s.bars; } return 0; };

const fromSpec = (spec: TrackSpec, label: string, bpm: number | ((i: Pick<MusicInput, 'night' | 'day'>) => number), trim: number, sting: Inst): TrackDef => ({
  id: spec.id as TrackId, label, tonic: () => spec.tonic, bpm: typeof bpm === 'number' ? () => bpm : bpm, trim, sting,
  bar: (seed, mode, barNo) => generateTrackBar(spec, seed, mode, barNo),
  formBars: { major: formBars(formOf(spec, 'major')), minor: formBars(formOf(spec, 'minor')) }, spec, theme: spec.theme,
  hookStart: { major: firstA(spec, 'major'), minor: firstA(spec, 'minor') },
});

/** The original march (af4983a): seeded, so each round writes a new one in a new key; its phrases are eight bars and never form a fixed loop. */
const march = (label: string, trim: number, sting: Inst): TrackDef => ({
  id: 'march', label, tonic: (seed) => classicKeyOfSeed(seed), bpm: (i) => tempoFor(i), trim, sting, voice: 'classic',
  bar: (seed, mode, barNo) => classicBar(seed, mode, barNo), formBars: { major: 32, minor: 32 }, hookStart: { major: 0, minor: 0 },
});

export const TRACKS: Record<TrackId, TrackDef> = {
  march: march('Toy March (original)', 1.0, 'glock'),
  oldtown: fromSpec(OLDTOWN, 'Cobblestone Tango', 118, 1.24, 'piano'),
  quarry: fromSpec(QUARRY, 'Quarry Rockfall', 144, 0.98, 'od'),
  harbor: fromSpec(HARBOR, 'Harbour Shanty', 108, 1.07, 'accordion'),
  market: fromSpec(MARKET, 'Lantern Night', 118, 1.09, 'epiano'),
  museum: fromSpec(MUSEUM, 'After Hours', 112, 1.11, 'vibes'),
  subpen: fromSpec(SUBPEN, 'Deep Sonar', 128, 1.64, 'sonar'),
  park: fromSpec(PARK, 'Picnic Parade', 124, 1.16, 'glock'),
  railyard: fromSpec(RAILYARD, 'Night Freight', 120, 1.08, 'rbell'),
  summit: fromSpec(SUMMIT, 'Alpine Bells', 140, 0.97, 'glock'),
  embassy: fromSpec(EMBASSY, 'Diplomatic Cover', 126, 1.13, 'twang'),
  airbase: fromSpec(AIRBASE, 'Runway Anthem', 116, 1.06, 'glock'),
  wasteland: fromSpec(WASTELAND, 'Dust and Wire', 107, 1.21, 'bell'),
  range: fromSpec(RANGE, 'Practice Lane', 86, 1.53, 'vibes'),
  outpost: fromSpec(OUTPOST, 'Bastion', (i) => (i.night ? 108 : 112), 1.23, 'marimba'),
};

/** Which track plays on which map. Unknown maps (the geometry test room) get the march. */
export const MAP_TRACK: Record<string, TrackId> = {
  plaza: 'march', oldtown: 'oldtown', quarry: 'quarry', causeway: 'harbor', market: 'market', museum: 'museum', subpen: 'subpen', park: 'park',
  railyard: 'railyard', summit: 'summit', embassy: 'embassy', airbase: 'airbase', wasteland: 'wasteland', range: 'range', outpost: 'outpost',
};

/** The track for a map; the menu (no map) and any map without its own plays the march. */
export const trackIdFor = (mapId: string | undefined): TrackId => (mapId ? MAP_TRACK[mapId] ?? 'march' : 'march');

/** Seconds before the form comes round again, at the track's own tempo. */
export function formSeconds(t: TrackDef, mode: Mode): number {
  const bpm = t.bpm({ mode: 'arena', night: mode === 'minor', day: mode === 'major' && t.id === 'outpost' });
  return (t.formBars[mode] * 240) / bpm;
}

/**
 * The track to play: the radio's station if one is tuned, else the map's own. A Zombies night keeps the Bastion's night score (its heartbeat and
 * menace are the night's alarm) whatever the radio says, and the station comes back at dawn; Off stays off, which is silence.
 */
export function pickTrack(mapTrack: TrackId, station: StationId | null, night: boolean): SongId {
  if (night && mapTrack === 'outpost' && station !== 'off') return 'outpost';
  return station && station !== 'off' ? station : mapTrack;
}
