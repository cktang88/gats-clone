import type { MapId } from './maps.ts';
import { RADIO_POOL } from './radiopool.ts';

/** The soundtrack library, one track per map (see src/client/musictracks.ts and musicstream.ts); a radio tunes between them and the extras. */
export const TRACK_IDS = ['march', 'oldtown', 'quarry', 'harbor', 'market', 'museum', 'subpen', 'park', 'railyard', 'summit', 'embassy', 'airbase', 'wasteland', 'range', 'outpost'] as const;
export type TrackId = (typeof TRACK_IDS)[number];

/** Radio-only stations: recorded tracks no map plays (see src/client/musicstream.ts for what and whose they are). */
export const EXTRA_IDS = ['groove', 'dizzy', 'chibi', 'dekalb', 'wraghstep'] as const;
export type ExtraId = (typeof EXTRA_IDS)[number];
/** Anything the director can play: a map's track or a radio-only one. */
export type SongId = TrackId | ExtraId;

/** What a radio can be tuned to: a track, or off. */
export type StationId = SongId | 'off';
export const STATION_IDS: readonly StationId[] = [...TRACK_IDS, ...EXTRA_IDS, 'off'];
export const isStationId = (v: unknown): v is StationId => typeof v === 'string' && (STATION_IDS as readonly string[]).includes(v);

/** The rooms with a shared radio: the Zombies squad's, and the range (a room of one). The server drops the message anywhere else. */
export const RADIO_MODES: readonly string[] = ['ZOM', 'RNG'];
/** One station change per client per this long; the server drops the rest without a word. */
export const RADIO_INTERVAL_MS = 350;
/** How near a player must stand for a radio's prompt (px from its centre). */
export const RADIO_REACH = 90;

/** Where the fixed radio stands: by the range booth (beside the firing pad, off the walkway) and by the Bastion core (clear of the squad pads, outside its ring of walls). */
export const FIXED_RADIO: Partial<Record<MapId, { x: number; y: number }>> = {
  range: { x: 176, y: 1158 },
  outpost: { x: 1628, y: 1366 },
};

/**
 * The station after `current` when a radio is pressed. A fixed radio (`withDefault` false) steps through the tracks and Off, starting from the first
 * track while untuned (so a first press never lands on Off); a hidden one adds "Map default" (null) to the loop, so you can always get back.
 */
export function cycleStation(current: StationId | null, withDefault: boolean): StationId | null {
  const loop: (StationId | null)[] = withDefault ? [null, ...STATION_IDS] : [...STATION_IDS];
  const at = current === null && !withDefault ? -1 : loop.indexOf(current);
  return loop[(at + 1) % loop.length] ?? null;
}

// ---- hidden radios ----

/** What names a round to the clients, so every player's hidden radios agree: the clock's end (versus rounds), or the Last Squad round's start. */
export const roundKeyOf = (snap: { match: { roundEndsAt: number | null }; royale?: { round: number } }): number | null => snap.match.roundEndsAt ?? snap.royale?.round ?? null;

/** Fewest and most hidden radios in a round, and the least distance between two of them. */
export const HIDDEN_RADIOS = { min: 6, max: 8, gap: 900, minGap: 600 } as const;

const mulberry = (seed: number) => {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
};
const hashOf = (s: string, n: number): number => {
  let h = 2166136261 ^ Math.floor(n);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
};

/**
 * Where this round's hidden radios are: two to four of the map's pooled spots (scripts/radio-pool.ts), chosen by a generator seeded from the map
 * and the round, so every client agrees and a new round moves them. Nothing here touches the simulation's random numbers.
 */
export function hiddenRadios(mapId: string, roundKey: number): { x: number; y: number }[] {
  const pool = RADIO_POOL[mapId];
  if (!pool?.length) return [];
  const r = mulberry(hashOf(mapId, roundKey));
  const want = HIDDEN_RADIOS.min + Math.floor(r() * (HIDDEN_RADIOS.max - HIDDEN_RADIOS.min + 1));
  const order = pool.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
  const out: { x: number; y: number }[] = [];
  // Spread them out: first only spots `gap` apart, then, if the map's pool can't fit that many, ones `minGap` apart.
  for (const gap of [HIDDEN_RADIOS.gap, HIDDEN_RADIOS.minGap]) {
    for (const i of order) {
      if (out.length >= want) break;
      const [x, y] = pool[i]!;
      if (out.every((o) => Math.hypot(o.x - x, o.y - y) >= gap)) out.push({ x, y });
    }
  }
  return out;
}
