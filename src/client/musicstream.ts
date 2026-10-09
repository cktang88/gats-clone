/**
 * The recordings: Eric Skiff's "We're All Under the Stars" on Night Market (players asked to keep it), and the radio-only stations. Every
 * other map plays its synthesized theme (musicthemes.ts), and the menu and the Plaza the original march. Each file is in public/music/tracks/,
 * trimmed, loudness-matched to -16 LUFS and credited in public/music/tracks/CREDITS.md (scripts/music-credits.ts writes it) and the pause menu's
 * credits. Files stream through an <audio> element into the music bus (so a track costs a few hundred kilobytes of memory, not the ~70 MB a
 * decoded buffer would); while one loads, or if it fails, a synthesized theme plays instead.
 */
import type { ExtraId, SongId, TrackId } from '../shared/radio.ts';
import { TRACK_IDS } from '../shared/radio.ts';

export type Licence = 'CC BY 4.0' | 'CC BY 3.0' | 'CC0 1.0';
export const LICENCE_URL: Record<Licence, string> = {
  'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'CC BY 3.0': 'https://creativecommons.org/licenses/by/3.0/',
  'CC0 1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
};
export type Credit = { title: string; artist: string; source: string; licence: Licence; licenceUrl: string; changes: string };

/** A file the director can stream. `tonic`/`minor` are the key the kill stings ring in (null: the track's key is unclear, so stings are unpitched). */
export type StreamDef = {
  key: StreamKey;
  file: string;
  /** Beats per minute, for the beat clock and for landing stings on the groove. */
  bpm: number;
  tonic: number | null;
  minor: boolean;
  credit: Credit;
  /** Why it is this map's (or station's) track. */
  why: string;
};
/** The songs with a recording: Night Market's, and the radio-only stations. */
export type StreamKey = 'market' | ExtraId;

const MACLEOD = 'Kevin MacLeod (incompetech.com)';
const SKIFF = 'Eric Skiff (ericskiff.com)';
const mac = (title: string, isrc: string, changes: string): Credit => ({
  title, artist: MACLEOD, source: `https://incompetech.com/music/royalty-free/index.html?isrc=${isrc}`, licence: 'CC BY 4.0', licenceUrl: LICENCE_URL['CC BY 4.0'], changes,
});
const skiff = (title: string, changes: string): Credit => ({ title, artist: SKIFF, source: 'https://ericskiff.com/music/', licence: 'CC BY 4.0', licenceUrl: LICENCE_URL['CC BY 4.0'], changes });
const STD = 'Trimmed of silence, loudness-normalised to -16 LUFS, faded at the loop point, re-encoded to MP3';
const CUT = (s: number) => `Cut to its first ${s} s, ${STD.charAt(0).toLowerCase()}${STD.slice(1)}`;
// Pitch classes: D 2, E 4, F 5, G 7 (keys estimated from each file's chroma, kept only where the estimate was clear).
const D = 2, E = 4, F = 5, G = 7;

const def = (key: StreamKey, bpm: number, tonic: number | null, minor: boolean, credit: Credit, why: string): StreamDef => ({ key, file: `music/tracks/${key}.mp3`, bpm, tonic, minor, credit, why });

export const STREAMS: Record<StreamKey, StreamDef> = {
  market: def('market', 132, E, false, skiff("We're All Under the Stars", `Starts at 0:45 of the original (where the hook comes in), cut to 200 s; ${STD.charAt(0).toLowerCase()}${STD.slice(1)}`),
    'Warm, singable 8-bit melody under neon: the night market as an arcade, catchy from the first bar.'),
  groove: def('groove', 140, null, false, mac('Laser Groove', 'USUAN1700017', STD),
    'Radio only: 80s synthwave mutated by trap drums.'),
  dizzy: def('dizzy', 150, G, true, skiff('A Night Of Dizzy Spells', STD),
    'Radio only: a fast, fizzing chiptune anthem.'),
  chibi: def('chibi', 140, F, false, skiff('Chibi Ninja', STD),
    'Radio only: bright, bouncing chiptune.'),
  dekalb: def('dekalb', 72, D, true, mac('Lewis and Dekalb', 'USUAN1600027', CUT(200)),
    'Radio only: southern-trap low end, deep sub bass and a slow, menacing swagger.'),
  wraghstep: def('wraghstep', 140, null, false, {
    title: 'Wraghstep [v2]', artist: 'Of Far Different Nature (opengameart.org)', source: 'https://opengameart.org/content/huge-loop-box-2-heavy-bass-music-for-action-racing-fighting-rpg-adventure-and-cutscenes',
    licence: 'CC BY 4.0', licenceUrl: LICENCE_URL['CC BY 4.0'], changes: STD,
  }, 'Radio only: a heavy dubstep loop, the bass drop on repeat.'),
};

/** The hype drop: a few seconds of Wraghstep's drop, played over the track (which ducks under it) on a big streak. */
export const DROP = {
  file: 'music/tracks/drop.mp3',
  /** Seconds from the start of the file to the drop itself. */
  hitAt: 0.95,
  credit: { ...STREAMS.wraghstep.credit, changes: 'A 5.2 s excerpt (9.3 s to 14.5 s, the drop) used as a sting, faded out and loudness-normalised' } satisfies Credit,
};

/** The synthesized music (no files), credited in the same list: the original march and every map's theme. */
export const MARCH_CREDIT = 'Toy March (original) and the map themes: composed for Tinwar and synthesized live in the browser';

/** The file a song plays from, if it has one (Night Market and the radio-only stations); every other song is synthesized. */
export const streamKeyFor = (song: SongId): StreamKey | null => (song in STREAMS ? (song as StreamKey) : null);

const SYNTH: ReadonlySet<string> = new Set(TRACK_IDS);
/** The synthesized track that plays a song, or stands in for its recording while the file loads (radio-only stations borrow the march). */
export const synthFor = (song: SongId): TrackId => (SYNTH.has(song) ? (song as TrackId) : 'march');

/** The radio's name for a station with a recording: the recording's title (the pause menu's credits name the artists); null for a synthesized one. */
export const songLabel = (song: SongId): string | null => STREAMS[song as StreamKey]?.credit.title ?? null;
export const isExtra = (song: SongId): song is ExtraId => !SYNTH.has(song);

/** Every credit, once each, in the order the soundtrack lists them. */
export function allCredits(): Credit[] {
  const seen = new Set<string>();
  const out: Credit[] = [];
  for (const s of Object.values(STREAMS)) if (!seen.has(s.credit.title)) { seen.add(s.credit.title); out.push(s.credit); }
  return out;
}

// ---- playing a file ----

/**
 * One file playing into the graph. `ready` turns true once it can play through; `failed` if it cannot load at all. `start` begins it (from the
 * top, looping) as soon as it can; `stop` ends it for good and lets the browser drop the file.
 */
export type StreamPlayer = { output: AudioNode; ready(): boolean; failed(): boolean; start(): void; stop(): void };
export type StreamFactory = (ctx: BaseAudioContext, file: string) => StreamPlayer;

/** A player that never loads: where there is no <audio> (tests, an offline render), the synth stands in. */
const nullPlayer = (ctx: BaseAudioContext): StreamPlayer => {
  const g = ctx.createGain();
  return { output: g, ready: () => false, failed: () => true, start() {}, stop() { g.disconnect(); } };
};

/**
 * The files as blobs, fetched once and kept (a few megabytes each, compressed) so a retune never waits on the network twice and the <audio>
 * element can seek and loop freely whatever the server says about ranges. At most `BLOB_KEEP` are kept; the oldest one not playing goes first.
 */
const BLOB_KEEP = 8;
type Blobbed = { url: Promise<string>; users: number; at: number };
const blobs = new Map<string, Blobbed>();
let blobClock = 0;
function blobFor(file: string): Blobbed {
  let b = blobs.get(file);
  if (!b) {
    const url = fetch(file).then((r) => { if (!r.ok) throw new Error(`${file}: ${r.status}`); return r.blob(); }).then((blob) => URL.createObjectURL(blob));
    b = { url, users: 0, at: 0 };
    blobs.set(file, b);
    url.catch(() => { if (blobs.get(file) === b) blobs.delete(file); });
    if (blobs.size > BLOB_KEEP) {
      const old = [...blobs.entries()].filter(([, x]) => x.users === 0 && x !== b).sort((x, y) => x[1].at - y[1].at)[0];
      if (old) { blobs.delete(old[0]); void old[1].url.then((u) => URL.revokeObjectURL(u), () => {}); }
    }
  }
  b.at = ++blobClock;
  return b;
}

/** The browser's: an <audio> element (its source the file's blob) through a MediaElementAudioSourceNode. */
export const mediaElementPlayer: StreamFactory = (ctx, file) => {
  if (typeof Audio === 'undefined' || typeof fetch !== 'function' || typeof URL?.createObjectURL !== 'function' || !('createMediaElementSource' in ctx)) return nullPlayer(ctx);
  const el = new Audio();
  el.preload = 'auto';
  el.loop = true;
  let ok = false, bad = false, playing = false, stopped = false;
  el.addEventListener('canplaythrough', () => { ok = true; });
  el.addEventListener('error', () => { if (el.getAttribute('src')) bad = true; });
  // A belt to the loop's braces: should the element ever end, it starts again from the top.
  el.addEventListener('ended', () => { if (!stopped) { el.currentTime = 0; void el.play().catch(() => {}); } });
  const blob = blobFor(file);
  blob.users++;
  blob.url.then((u) => { if (!stopped) { el.src = u; el.load(); } }, () => { bad = true; });
  let node: AudioNode;
  try { node = (ctx as AudioContext).createMediaElementSource(el); } catch { bad = true; node = ctx.createGain(); }
  return {
    output: node,
    ready: () => !!el.getAttribute('src') && (ok || el.readyState >= 4),
    failed: () => bad,
    start() {
      if (playing || stopped) return;
      playing = true;
      el.currentTime = 0;
      void el.play().catch(() => { playing = false; bad = true; });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      blob.users--;
      el.pause();
      el.removeAttribute('src');
      el.load();
      node.disconnect();
    },
  };
};

let factory: StreamFactory = mediaElementPlayer;
/** Swap how files play (tests use a fake; the default is an <audio> element). */
export const setStreamFactory = (f: StreamFactory | null) => { factory = f ?? mediaElementPlayer; };
export const createStreamPlayer = (ctx: BaseAudioContext, key: StreamKey): StreamPlayer => factory(ctx, STREAMS[key].file);

/** Files that failed this session, and when: the synth plays for them, and they are tried again after a while. */
const failedAt = new Map<StreamKey, number>();
export const RETRY_MS = 60_000;
export const markFailed = (key: StreamKey, now: number) => { failedAt.set(key, now); };
export const knownBad = (key: StreamKey, now: number) => { const at = failedAt.get(key); return at !== undefined && now - at < RETRY_MS; };
export const resetStreamFailures = () => failedAt.clear();

/** Fetches a file the radio is likely to tune to next, so the switch is near-instant. */
export function prefetchStream(key: StreamKey) {
  if (typeof fetch !== 'function' || typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return;
  blobFor(STREAMS[key].file);
}

// ---- stings over a recording ----

/** An unpitched kill sting for a track whose key is unclear: a tom pickup and a bright metallic hit, bigger with the streak. */
export function playHitSting(ctx: BaseAudioContext, dest: AudioNode, streak: number, t: number) {
  const n = 2 + Math.min(3, Math.max(0, streak - 1));
  const env = (at: number, peak: number, release: number) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(peak, at + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, at + release);
    g.connect(dest);
    return g;
  };
  for (let k = 0; k < n; k++) {
    const at = t + k * 0.05;
    const o = ctx.createOscillator();
    o.type = 'sine'; o.frequency.setValueAtTime(260 + k * 40, at); o.frequency.exponentialRampToValueAtTime(120 + k * 20, at + 0.12);
    o.connect(env(at, 0.32, 0.18)); o.start(at); o.stop(at + 0.22);
  }
  const hit = t + (n - 1) * 0.05;
  for (const hz of [1870, 2790, 4210]) {
    const o = ctx.createOscillator();
    o.type = 'square'; o.frequency.value = hz;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 3000;
    o.connect(f).connect(env(hit, 0.035, 0.35)); o.start(hit); o.stop(hit + 0.4);
  }
}
