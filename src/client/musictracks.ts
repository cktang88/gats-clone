/**
 * The synthesized library: one theme per map, all in the adaptive framework (calm, combat, hype, finale and, for the Zombies night, heart).
 * The menu's and Plaza's march is the original (musicclassic.ts, restored from commit af4983a); every other map plays its pop theme from
 * musicthemes.ts, arranged by musicpop.ts to the rules in docs/music/CRAFT.md. Night Market alone plays a recording (Eric Skiff's, musicstream.ts);
 * its theme stands in while that loads.
 */
import { FORM_BARS, INTRO_BARS, popBar, type PopSpec } from './musicpop.ts';
import { AIRBASE, EMBASSY, HARBOR, MARKET, MUSEUM, OLDTOWN, OUTPOST_DAY, OUTPOST_NIGHT, PARK, QUARRY, RAILYARD, RANGE, SUBPEN, SUMMIT, WASTELAND } from './musicthemes.ts';
import { tempoFor, type Bar, type Inst, type Mode, type MusicInput } from './musictheory.ts';
import { CLASSIC_INSTS, classicBar, classicKeyOfSeed } from './musicclassic.ts';

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
  /** Every bar the track can write, in each mode: a theme's intro and one time round its loop. */
  formBars: Record<Mode, number>;
  /** The theme in each mode (the Outpost's night has its own); the original march has none: its tunes are seeded. */
  pop?: Record<Mode, PopSpec>;
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
/** A map's theme, with its own night (the Outpost) or the same one day and night. Loudness trims are measured in Chrome (scripts/render-music.ts). */
const fromPop = (spec: PopSpec, trim: number, sting: Inst, night: PopSpec = spec): TrackDef => ({
  id: spec.id as TrackId, label: spec.label, tonic: () => spec.tonic, bpm: (i) => (i.night ? night.bpm : spec.bpm), trim, sting,
  bar: (seed, mode, barNo) => popBar(mode === 'minor' ? night : spec, seed, mode, barNo),
  formBars: { major: FORM_BARS, minor: FORM_BARS }, pop: { major: spec, minor: night }, hookStart: { major: INTRO_BARS, minor: INTRO_BARS },
});

/** The original march (af4983a): seeded, so each round writes a new one in a new key; its phrases are eight bars and never form a fixed loop. */
const march = (label: string, trim: number, sting: Inst): TrackDef => ({
  id: 'march', label, tonic: (seed) => classicKeyOfSeed(seed), bpm: (i) => tempoFor(i), trim, sting, voice: 'classic',
  bar: (seed, mode, barNo) => classicBar(seed, mode, barNo), formBars: { major: 32, minor: 32 }, hookStart: { major: 0, minor: 0 },
});

export const TRACKS: Record<TrackId, TrackDef> = {
  march: march('Toy March (original)', 1.0, 'glock'),
  oldtown: fromPop(OLDTOWN, 1.18, 'bandoneon'),
  quarry: fromPop(QUARRY, 1.02, 'cowbell'),
  harbor: fromPop(HARBOR, 1.17, 'accordion'),
  market: fromPop(MARKET, 1.17, 'chime'),
  museum: fromPop(MUSEUM, 1.18, 'vibes'),
  subpen: fromPop(SUBPEN, 1.14, 'sonar'),
  park: fromPop(PARK, 1.17, 'glock'),
  railyard: fromPop(RAILYARD, 1.06, 'twang'),
  summit: fromPop(SUMMIT, 1.04, 'chime'),
  embassy: fromPop(EMBASSY, 1.2, 'piano'),
  airbase: fromPop(AIRBASE, 1.2, 'tpt'),
  wasteland: fromPop(WASTELAND, 0.99, 'steel'),
  range: fromPop(RANGE, 1.1, 'epiano'),
  outpost: fromPop(OUTPOST_DAY, 1.1, 'marimba', OUTPOST_NIGHT),
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
