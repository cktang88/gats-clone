/**
 * The soundtrack director. The menu and the Plaza play the original seeded march (musicclassic.ts), and every other map its own synthesized
 * theme (musicthemes.ts, arranged by musicpop.ts), bar by bar, in layers that swell with the fight. Night Market and the radio-only stations
 * play recordings (musicstream.ts), opened up from a muffled low-pass when calm to full range in a fight, with kill stings in their key over them,
 * a bass drop on a big streak, and a synthesized theme standing in while the file loads or if it fails. Maps crossfade; radios retune at once
 * under the static. `musicStart` runs from a user gesture, `musicUpdate` once a frame; `onBeat` and `getBeat` give the visuals a clock.
 */
import { newestSnap } from './interp.ts';
import { createRig, type Deck, type Rig } from './musicsynth.ts';
import { instsOf, pickTrack, trackIdFor, TRACKS, type TrackDef, type TrackId } from './musictracks.ts';
import { createSampleBank } from './musicsamples.ts';
import { createClassicVoices, type ClassicVoices } from './musicclassic.ts';
import {
  createStreamPlayer, DROP, knownBad, markFailed, playHitSting, prefetchStream, streamKeyFor, STREAMS, synthFor, type StreamKey, type StreamPlayer,
} from './musicstream.ts';
import type { SongId, StationId } from '../shared/radio.ts';
import { NO_TRACKER, observe, type MusicCue, type MusicTracker } from './musicstate.ts';
import {
  approach, beatAt, crossfade, fadeTau, hash, heartTier, IDLE_INPUT, LAYER_IDS, layerTargets, levelGain, modeOf, STEPS_PER_BAR,
  type BarClock, type LayerId, type Mode, type MusicInput,
} from './musictheory.ts';
import type { ClientState } from './state.ts';

const SOUND_MUTE_KEY = 'skirmish.muted';
const MUSIC_MUTE_KEY = 'skirmish.music.muted';
const MUSIC_VOL_KEY = 'skirmish.music.volume';
/** The music bus sits well under the sound effects. */
const BUS_GAIN = 0.32;
const LOOKAHEAD_S = 0.3;
const TICK_MS = 30;
const IDLE_BPM = 128;
const DEAD_CUTOFF_HZ = 650;
const ZKILL_GAP_S = 0.35;
/** A map change crossfades the old track out and the new one in over this long. */
export const XFADE_S = 3.5;
/** A radio retune is a real radio's: the old station is cut this fast and the new one starts at once, under the tune-in static. */
export const RETUNE_CUT_S = 0.05;
/** How long a new deck stays silent waiting for its recording before the synthesized track stands in. */
export const STREAM_GRACE_S = 1.2;
/** A recording's low-pass when calm, and wide open in a fight: the track is there, but the fight is what opens it up. */
const CALM_HZ = 3200, OPEN_HZ = 20000;
/** A recording sits a little lower when calm. */
const CALM_GAIN = 0.8;
/**
 * The recordings are levelled to -16 LUFS and skip the synth's compressor; this brings them up to the march's loudness through the music bus
 * (measured in Chrome on the master, through its glue compressor: the original march about -12.5 LUFS, a recording in a fight about -19.5 before this and about -14 after).
 */
export const STREAM_TRIM = 2.7;
/** At most one bass drop this often. */
const DROP_GAP_S = 20;

export type BeatInfo = { beat: number; phase: number; bar: number; beatInBar: number; step: number; bpm: number; audible: boolean };
export type BeatEvent = { beat: number; bar: number; beatInBar: number; downbeat: boolean; time: number };

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* the setting lasts this tab only */ } },
};

let rig: Rig | null = null;
let classic: ClassicVoices | null = null;
let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let seed = hash(Date.now() & 0xffffff, 17);
let barNo = 0;
let nextBarT = 0;
let bars: BarClock[] = [];
let barModes = new Map<number, Mode>();
const barLocal = new Map<number, { local: number; track: TrackId }>();
/**
 * How a deck sounds: 'synth' a synthesized track (the march, or a song with no recording); 'waiting' silent for its recording (up to
 * `STREAM_GRACE_S`); 'fallback' the synthesized stand-in while the recording is late or failed; 'playing' the recording.
 */
export type DeckState = 'synth' | 'waiting' | 'fallback' | 'playing';
/** What the playing deck is: its song, the synthesized track that stands for it, its first global bar, and its recording if it has one. */
type Playing = {
  song: SongId; track: TrackDef; deck: Deck; startBar: number; map: TrackId; station: StationId | null; fadeIn: { t: number; x: number } | null;
  /** The recording this deck was made for (whether or not it loaded), and its player and nodes: player → lowpass → intensity → fade-in → calm layer. */
  stream: StreamKey | null; state: DeckState; player: StreamPlayer | null; lp: BiquadFilterNode | null; hot: GainNode | null; inGain: GainNode | null; waitUntil: number;
};
let current: Playing | null = null;
/** The deck fading out, still being fed its own bars until `endT`. */
let leaving: (Playing & { local: number; nextT: number; endT: number; mode: Mode; on: Record<LayerId, boolean> }) | null = null;
/** The song the map (or the radio) asks for. */
let wantTrack: SongId = 'march';
/** The room's radio (Zombies, range) and the player's own tuning (a hidden radio): a track id, 'off', or null for the map's own track. A personal choice wins. */
let roomStation: StationId | null = null;
let personalStation: StationId | null = null;
const effectiveStation = (): StationId | null => personalStation ?? roomStation;
let mapTrack: TrackId = 'march';
let input: MusicInput = IDLE_INPUT;
let tracker: MusicTracker = NO_TRACKER;
let phase: MusicInput['phase'] = 'menu';
let wasEnded = false;
const levels: Record<LayerId, number> = { calm: 0, combat: 0, hype: 0, finale: 0, heart: 0 };
let cadenceUntil = 0;
let lastUpdate = 0;
let lastZkillAt = -Infinity;
let firedBeat = -1;
let sfxMuted = store.get(SOUND_MUTE_KEY) === '1';
let musicMuted = store.get(MUSIC_MUTE_KEY) === '1';
let volume = Math.min(1, Math.max(0, Number(store.get(MUSIC_VOL_KEY) ?? 1) || 0)) || (store.get(MUSIC_VOL_KEY) === '0' ? 0 : 1);
const listeners = new Set<(e: BeatEvent) => void>();

let lastDropAt = -Infinity;
let dropBuf: AudioBuffer | null = null;
let dropLoading = false;

const audibleBase = () => !sfxMuted && !musicMuted && volume > 0;
const audible = () => audibleBase() && effectiveStation() !== 'off';

function applyVolume() {
  if (rig && ctx) {
    rig.volume.gain.setTargetAtTime(audible() ? BUS_GAIN * volume : 0, ctx.currentTime, 0.05);
    rig.fx.gain.setTargetAtTime(audibleBase() ? volume : 0, ctx.currentTime, 0.05);
  }
}

/** Starts the score on the page's audio graph. Call from a user gesture; later calls do nothing. `out` is the master bus music joins. */
export function musicStart(audioCtx: AudioContext, out: AudioNode) {
  if (rig) { void ctx?.resume(); return; }
  ctx = audioCtx;
  // The sampled instruments come from public/music/; until a track's arrive, its synth voices play.
  rig = createRig(ctx, out, createSampleBank(ctx, (path) => fetch(path).then((r) => { if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.arrayBuffer(); })));
  classic = createClassicVoices(ctx, rig.direct);
  applyVolume();
  nextBarT = ctx.currentTime + 0.12;
  current = newPlaying(wantTrack, nextBarT, barNo, null);
  timer = setInterval(tick, TICK_MS);
  (timer as { unref?: () => void }).unref?.();
  tick();
}

/** Reseeds the score's small ornaments (drum fills, sparkles); every track's tune, chords and key stay its own. Takes effect from the next bar. */
export function musicSeed(n: number) { seed = hash(n, 17); }

/** The recording a song plays, or null for a synthesized one. */
const wantStream = (song: SongId): StreamKey | null => streamKeyFor(song);

/** A new deck for `song`, starting at `t`: its recording opens at once and the deck waits for it, or it is synthesized. */
function newPlaying(song: SongId, t: number, startBar: number, fadeIn: Playing['fadeIn']): Playing {
  const r = rig!, c = ctx!;
  const track = TRACKS[synthFor(song)];
  const stream = wantStream(song);
  const live = stream !== null && !knownBad(stream, performance.now());
  const deck = r.newDeck(live ? STREAM_TRIM : track.trim, live);
  if (track.voice !== 'classic') void r.samples?.load(instsOf(track.id));
  const p: Playing = { song, track, deck, startBar, map: mapTrack, station: effectiveStation(), fadeIn, stream, state: 'synth', player: null, lp: null, hot: null, inGain: null, waitUntil: 0 };
  if (live) {
    const player = createStreamPlayer(c, stream);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 0.5; lp.frequency.value = CALM_HZ;
    const hot = c.createGain();
    hot.gain.value = CALM_GAIN;
    const inGain = c.createGain();
    inGain.gain.value = 1;
    player.output.connect(lp).connect(hot).connect(inGain).connect(deck.layers.calm);
    Object.assign(p, { state: 'waiting', player, lp, hot, inGain, waitUntil: t + STREAM_GRACE_S });
  }
  return p;
}

/** A deck is done with: its recording stops and every node it made lets go. */
function dropDeck(p: Playing) {
  p.player?.stop();
  p.lp?.disconnect(); p.hot?.disconnect(); p.inGain?.disconnect();
  rig?.disposeDeck(p.deck);
}

/** Moves a deck's recording along: start it once it can play, let the synth stand in if it is late or fails, and hand back when it arrives. */
function stepStream(p: Playing, now: number) {
  const pl = p.player;
  if (!pl || p.state === 'synth') return;
  // The stand-in plays at its own loudness trim; a recording is already levelled.
  const fallBack = () => { p.state = 'fallback'; p.deck.trim.gain.setValueAtTime(p.track.trim, now); };
  if (pl.failed()) {
    if (p.state !== 'fallback') { markFailed(p.stream!, performance.now()); fallBack(); }
    return;
  }
  if (p.state === 'waiting' && pl.ready()) { pl.start(); p.state = 'playing'; return; }
  if (p.state === 'waiting' && now >= p.waitUntil) { fallBack(); return; }
  if (p.state === 'fallback' && pl.ready()) {
    p.deck.trim.gain.setTargetAtTime(STREAM_TRIM, now, 0.35);
    // The recording arrived late: it swells in over the synthesized stand-in, whose bars stop from the next one.
    p.inGain!.gain.setValueAtTime(0, now);
    p.inGain!.gain.setTargetAtTime(1, now, 0.35);
    pl.start();
    p.state = 'playing';
  }
}

const streaming = (p: Playing | null): p is Playing & { stream: StreamKey } => !!p && p.stream !== null && (p.state === 'playing' || p.state === 'waiting');
const deckBpm = (p: Playing) => (streaming(p) ? STREAMS[p.stream].bpm : p.track.bpm(input));

/** Plays one bar of a deck: the whole synthesized bar, or nothing over a recording. */
function playDeckBar(p: Playing, bar: ReturnType<TrackDef['bar']>, t: number, spb: number, on: Record<LayerId, boolean>) {
  if (!rig || !audible()) return;
  const events = streaming(p) ? [] : bar.events.filter((e) => on[e.layer]);
  if (!events.length) return;
  if (p.track.voice === 'classic' && classic) classic.playBar({ ...bar, events }, t, spb, heartTier(input.horde), p.deck);
  else rig.playBar({ ...bar, events }, t, spb, heartTier(input.horde), p.deck);
}

/** Whether the playing deck is the one wanted: the same song, made for the same recording. */
const isWanted = (p: Playing) => p.song === wantTrack && p.stream === wantStream(wantTrack);

function activeLayers(): Record<LayerId, boolean> {
  const t = cadenceUntil > (ctx?.currentTime ?? 0) ? null : layerTargets(input);
  const on = {} as Record<LayerId, boolean>;
  for (const id of LAYER_IDS) on[id] = !!t && (levels[id] > 0.02 || t[id] > 0.02);
  return on;
}

/**
 * A radio retune, the way a real radio does it: the old station is cut within `RETUNE_CUT_S` and the new one starts right away, on its hook,
 * at `t` (a moment from now, mid-bar if need be), while the tune-in static covers the join. The bar clock restarts from the new station's bar.
 */
function retune(t: number, id: SongId) {
  if (!rig || !ctx || !current) return;
  const old = current;
  const g = old.deck.fade.gain;
  if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t); else { g.cancelScheduledValues(0); g.setValueAtTime(g.value, t); }
  g.linearRampToValueAtTime(0, t + RETUNE_CUT_S);
  // Whatever the old deck had scheduled plays on into silence; it goes once its last bar is over (a recording stops then too).
  old.player?.stop();
  setTimeout(() => dropDeck(old), (Math.max(nextBarT, t) - ctx.currentTime + 1.5) * 1000);
  if (leaving) { const gone = leaving; gone.player?.stop(); gone.deck.fade.gain.cancelScheduledValues(0); gone.deck.fade.gain.setValueAtTime(0, t); setTimeout(() => dropDeck(gone), 3000); leaving = null; }
  const synth = TRACKS[synthFor(id)];
  const p = newPlaying(id, t, barNo, null);
  // A synthesized station (or stand-in) starts on its hook, so the tune is heard at once; a recording starts from its top (trimmed to the catchy part).
  p.startBar = barNo - synth.hookStart[modeOf(input)];
  const deck = p.deck;
  for (const l of LAYER_IDS) deck.layers[l].gain.value = levelGain(levels[l]);
  deck.fade.gain.setValueAtTime(0, ctx.currentTime);
  deck.fade.gain.setValueAtTime(0, t);
  deck.fade.gain.linearRampToValueAtTime(1, t + RETUNE_CUT_S);
  current = p;
  nextBarT = t;
}

/** Begins the next track at `t` after a map change: the old deck keeps playing its own bars for an `XFADE_S` crossfade while the new one fades in. */
function switchTrack(t: number, id: SongId) {
  if (!rig || !ctx || !current) return;
  const old = current;
  const oldLocal = barNo - old.startBar;
  const on = activeLayers();
  const x = XFADE_S;
  // A deck still fading in (a quick second retune) fades out from where it had got to, not from full.
  const from = old.fadeIn && t < old.fadeIn.t + old.fadeIn.x ? crossfade(Math.max(0, t - old.fadeIn.t) / old.fadeIn.x).b : 1;
  const curveOut = Float32Array.from({ length: 32 }, (_, i) => from * crossfade(i / 31).a);
  const curveIn = Float32Array.from({ length: 32 }, (_, i) => crossfade(i / 31).b);
  const g = old.deck.fade.gain;
  try {
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t); else g.cancelScheduledValues(t);
    g.setValueCurveAtTime(curveOut, t, x);
  } catch {
    // Some engines refuse a curve over one still running: cut the old deck at once rather than leave it playing at full.
    g.cancelScheduledValues(0);
    g.setValueAtTime(0, t);
  }
  const p = newPlaying(id, t, barNo, { t, x });
  const deck = p.deck;
  for (const l of LAYER_IDS) deck.layers[l].gain.value = levelGain(levels[l]);
  deck.fade.gain.setValueAtTime(0, ctx.currentTime);
  deck.fade.gain.setValueCurveAtTime(curveIn, t, x);
  current = p;
  leaving = { ...old, local: oldLocal, nextT: t, endT: t + x, mode: barModes.get(barNo - 1) ?? 'major', on };
  setTimeout(() => dropDeck(old), (t - ctx.currentTime + x + 2.5) * 1000);
}

function tick() {
  if (!ctx || !rig || !current) return;
  const now = ctx.currentTime;
  // A stall (a long frame while a map loads, a throttled timer) can leave the next bar behind the clock. Start it now instead: a bar
  // scheduled in the past sounds all its overdue notes at once, and a crossfade curve begun in the past overlaps the new deck's own
  // automation (Chrome throws, every tick, until the clock is a whole fade past it, leaking a deck each time).
  if (nextBarT < now) nextBarT = now + 0.02;
  if (leaving && leaving.nextT < now) leaving.nextT = now + 0.02;
  // The radio retunes at once; a new map's track waits for the bar line and crossfades.
  if (!isWanted(current) && current.map === mapTrack && current.station !== effectiveStation()) retune(now + 0.02, wantTrack);
  stepStream(current, now);
  if (leaving) stepStream(leaving, now);
  while (nextBarT < now + LOOKAHEAD_S) {
    if (!isWanted(current)) switchTrack(nextBarT, wantTrack);
    const mode = modeOf(input);
    const spb = 60 / deckBpm(current);
    const local = barNo - current.startBar;
    const bar = current.track.bar(seed, mode, local);
    const on = activeLayers();
    playDeckBar(current, bar, nextBarT, spb, on);
    const sounding = streaming(current) ? [] : bar.events.filter((e) => on[e.layer]);
    lastBar = { track: current.song, stream: streaming(current) ? current.stream : null, at: nextBarT, voices: [...new Set(sounding.map((e) => e.inst))], tune: sounding.filter((e) => e.tag === 'hook').map((e) => e.midi) };
    bars.push({ t0: nextBarT, spb, barNo });
    barModes.set(barNo, mode);
    barLocal.set(barNo, { local, track: current.track.id });
    barNo++;
    nextBarT += spb * 4;
  }
  // The track fading out keeps playing its bars until the crossfade is over.
  while (leaving && leaving.nextT < Math.min(leaving.endT, now + LOOKAHEAD_S)) {
    const spb = 60 / deckBpm(leaving);
    const bar = leaving.track.bar(seed, leaving.mode, leaving.local);
    playDeckBar(leaving, bar, leaving.nextT, spb, leaving.on);
    leaving.local++;
    leaving.nextT += spb * 4;
  }
  // The crossfade is over once the old deck has faded out, not when its last bar was handed over.
  if (leaving && now >= leaving.endT) leaving = null;
  if (bars.length > 12) { for (const b of bars.slice(0, -12)) { barModes.delete(b.barNo); barLocal.delete(b.barNo); } bars = bars.slice(-12); }
  const at = beatAt(bars, now - (ctx.outputLatency || ctx.baseLatency || 0));
  if (at) {
    const whole = Math.floor(at.beat);
    if (firedBeat < 0) firedBeat = whole - 1;
    if (whole > firedBeat) {
      firedBeat = whole;
      const e: BeatEvent = { beat: whole, bar: at.bar, beatInBar: at.beatInBar, downbeat: at.beatInBar === 0, time: performance.now() };
      for (const fn of listeners) fn(e);
    }
  }
}

/** Subscribe to every beat as it is heard. Returns the unsubscribe. */
export function onBeat(fn: (e: BeatEvent) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The beat clock: audio-timed once the score is playing, a free-running 128 bpm before then so visuals still pulse in the menu. */
export function getBeat(): BeatInfo {
  if (ctx && rig) {
    const at = beatAt(bars, ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0));
    if (at) return { ...at, bpm: 60 / (bars.at(-1)?.spb ?? 60 / IDLE_BPM), audible: audible() };
  }
  const beat = (performance.now() / 1000) * (IDLE_BPM / 60);
  return { beat, phase: beat % 1, bar: Math.floor(beat / 4), beatInBar: Math.floor(beat % 4), step: Math.floor((beat % 4) * 4), bpm: IDLE_BPM, audible: false };
}
/** 0 on the beat, rising to 1 just before the next. */
export const beatPhase = () => getBeat().phase;
/** 1 on the beat, decaying to 0, a ready-made pulse for HUD juice. */
export const beatPulse = (decay = 3) => (1 - getBeat().phase) ** decay;

function duck(depth: number, holdS: number, recoverS = 0.25) {
  if (!ctx || !rig) return;
  const t = ctx.currentTime;
  for (const d of [rig.duck, rig.rawDuck]) {
    d.gain.cancelScheduledValues(t);
    d.gain.setTargetAtTime(depth, t, 0.012);
    d.gain.setTargetAtTime(1, t + holdS, recoverS);
  }
}

/** Whether a win or loss cadence is sounding, so a celebration can stay under it. */
export const cadencePlaying = () => !!ctx && cadenceUntil > ctx.currentTime;

/** Ducks the score under a big sound effect: the page calls it for every cue on sfx.ts's DUCKS list. */
export const musicDuck = (depth = 0.5, holdMs = 250) => duck(depth, holdMs / 1000);

function barClockAt(t: number): BarClock | undefined {
  let cur: BarClock | undefined;
  for (const b of bars) if (b.t0 <= t) cur = b;
  return cur;
}

function chordFor(t: number) {
  const at = beatAt(bars, t);
  const n = at?.bar ?? Math.max(0, barNo - 1);
  const info = barLocal.get(n);
  const track = info ? TRACKS[info.track] : current?.track ?? TRACKS.march;
  return track.bar(seed, barModes.get(n) ?? modeOf(input), info?.local ?? Math.max(0, n - (current?.startBar ?? 0))).chord;
}

/** Fetches the bass-drop sting once, the first time a streak gets going. */
function loadDrop() {
  if (dropBuf || dropLoading || !ctx || typeof fetch !== 'function') return;
  dropLoading = true;
  const c = ctx;
  fetch(DROP.file).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); })
    .then((b) => c.decodeAudioData(b)).then((buf) => { dropBuf = buf; }).catch(() => { dropLoading = false; });
}

/**
 * The hype moment on a big streak: the recording ducks right down and a few seconds of a dubstep drop land over it, the bass hitting on the
 * next beat. Only over a recording (the march has its own brass for that), and at most once every `DROP_GAP_S`.
 */
function playDrop(now: number) {
  if (!ctx || !rig || !dropBuf || now - lastDropAt < DROP_GAP_S) return false;
  lastDropAt = now;
  const cur = barClockAt(now);
  const beat = cur ? cur.spb : 0.5;
  let hit = cur ? cur.t0 + Math.ceil((now + DROP.hitAt + 0.02 - cur.t0) / beat) * beat : now + DROP.hitAt + 0.02;
  if (hit - DROP.hitAt < now + 0.02) hit += beat;
  const src = ctx.createBufferSource();
  src.buffer = dropBuf;
  const g = ctx.createGain();
  g.gain.value = 0.9;
  src.connect(g).connect(rig.direct);
  src.start(hit - DROP.hitAt);
  src.onended = () => { src.disconnect(); g.disconnect(); };
  const len = dropBuf.duration - DROP.hitAt;
  for (const d of [rig.duck, rig.rawDuck]) {
    d.gain.cancelScheduledValues(now);
    d.gain.setTargetAtTime(0.5, now, 0.05);
    d.gain.setTargetAtTime(0.12, hit - 0.05, 0.02);
    d.gain.setTargetAtTime(1, hit + len - 0.8, 0.5);
  }
  return true;
}

/** A kill sting: over a recording in its key (or unpitched where its key is unclear), over the march in the march's own voice, over a theme on its chord. */
function sting(chord: ReturnType<typeof chordFor>, mode: Mode, streak: number, t: number, bounty: boolean) {
  if (!rig || !ctx) return;
  if (streaming(current)) {
    const s = STREAMS[current.stream];
    if (s.tonic === null) playHitSting(ctx, rig.direct, streak, t);
    else rig.playSting({ rootPc: s.tonic, tones: s.minor ? [0, 3, 7] : [0, 4, 7] }, s.minor ? 'minor' : 'major', streak, t, bounty, 'glock');
  } else if (current?.track.voice === 'classic' && classic) classic.playSting(chord, mode, streak, t, bounty);
  else rig.playSting(chord, mode, streak, t, bounty, current?.track.sting);
}

function onCue(cue: MusicCue) {
  if (!ctx || !rig || !audible()) return;
  const now = ctx.currentTime;
  switch (cue.kind) {
    case 'kill': {
      // Land the sting on the next sixteenth so it rides the groove.
      const cur = barClockAt(now);
      const sixteenth = cur ? (cur.spb * 4) / STEPS_PER_BAR : 0.12;
      const t = cur ? now + sixteenth - ((now - cur.t0) % sixteenth) : now + 0.02;
      if (cue.streak >= 3) loadDrop();
      if (streaming(current) && cue.streak >= 5 && cue.streak % 5 === 0 && playDrop(now)) break;
      sting(chordFor(t), barModes.get(cur?.barNo ?? -1) ?? modeOf(input), cue.streak, t, cue.bounty);
      break;
    }
    case 'zkill':
      if (now - lastZkillAt > ZKILL_GAP_S) { lastZkillAt = now; sting(chordFor(now), modeOf(input), 1, now + 0.02, false); }
      break;
    // Ducking for kills, booms and the other big moments is the page's: it follows the sound effects' own list (sfx.ts DUCKS) through `musicDuck`.
    case 'win': case 'loss': {
      const t = now + 0.12;
      const dur = streaming(current) ? rig.playCadence(cue.kind, STREAMS[current.stream].tonic ?? 0, t)
        : current?.track.voice === 'classic' && classic ? classic.playCadence(cue.kind, current.track.tonic(seed), t)
          : rig.playCadence(cue.kind, current?.track.tonic(seed) ?? 0, t);
      cadenceUntil = t + dur;
      break;
    }
  }
}

/** Call once a frame with the client state; `firing` is whether the trigger is held. Reads the newest snapshot, so it needs no other hook. */
export function musicUpdate(state: ClientState, now: number, firing = false) {
  const snap = state.phase === 'menu' ? null : newestSnap(state.s.snaps);
  const next: MusicInput['phase'] = state.phase === 'menu' ? 'menu' : state.phase === 'dead' ? 'dead' : 'play';
  if (phase === 'menu' && next !== 'menu') musicSeed(Date.now());
  // Back at the menu the radios are left behind: it plays its own calm march again.
  if (phase !== 'menu' && next === 'menu' && (roomStation !== null || personalStation !== null)) { roomStation = null; personalStation = null; applyVolume(); }
  phase = next;
  const seen = observe(tracker, snap, phase, now, firing);
  tracker = seen.tracker;
  input = tracker.input;
  if (wasEnded && !tracker.ended) musicSeed(Date.now());
  wasEnded = tracker.ended;
  const map = phase === 'menu' ? 'march' : trackIdFor(state.phase === 'menu' ? undefined : state.s.mapId ?? snap?.match.map);
  // A new map warms its recording's file while the match is still coming up.
  if (map !== mapTrack) { const k = streamKeyFor(map); if (k) prefetchStream(k); }
  mapTrack = map;
  wantTrack = pickTrack(mapTrack, effectiveStation(), input.night);
  for (const cue of seen.cues) onCue(cue);
  if (!ctx || !rig) return;
  const dt = lastUpdate ? Math.min(0.25, (now - lastUpdate) / 1000) : 0;
  lastUpdate = now;
  const cadence = cadenceUntil > ctx.currentTime;
  const target = layerTargets(input);
  for (const id of LAYER_IDS) {
    const goal = cadence ? 0 : target[id];
    levels[id] = approach(levels[id], goal, dt, cadence ? 0.12 : fadeTau(levels[id], goal));
    if (current) current.deck.layers[id].gain.setTargetAtTime(levelGain(levels[id]), ctx.currentTime, 0.03);
  }
  // A recording opens up with the fight: the calm low-pass lifts and it comes up a touch as combat, hype or the finale rise.
  const hot = Math.max(levels.combat, levels.hype, levels.finale);
  for (const p of [current, leaving]) {
    if (!p?.lp || !p.hot) continue;
    p.lp.frequency.setTargetAtTime(CALM_HZ * (OPEN_HZ / CALM_HZ) ** hot, ctx.currentTime, 0.12);
    p.hot.gain.setTargetAtTime(CALM_GAIN + (1 - CALM_GAIN) * hot, ctx.currentTime, 0.12);
  }
  for (const f of [rig.tone, rig.rawTone]) f.frequency.setTargetAtTime(phase === 'dead' ? DEAD_CUTOFF_HZ : 18000, ctx.currentTime, 0.25);
}

// ---- mix controls ----

/** Follows the sound effects' mute (M): music is silent whenever sound is. */
export function setSoundMuted(muted: boolean) { sfxMuted = muted; applyVolume(); }
export const isMusicMuted = () => musicMuted;
/** The music's own toggle (Shift+M). Returns whether it is now muted. */
export function toggleMusicMuted(): boolean {
  musicMuted = !musicMuted;
  store.set(MUSIC_MUTE_KEY, musicMuted ? '1' : '0');
  applyVolume();
  return musicMuted;
}
/** Music volume 0..1, kept under the effects by the bus gain. */
export function setMusicVolume(v: number) {
  volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  store.set(MUSIC_VOL_KEY, String(volume));
  applyVolume();
}
export const getMusicVolume = () => volume;
/** The live gain of the music bus (0 while muted or off; null before the first gesture), for the `?dev` probe. */
export const musicGainNow = (): number | null => (rig ? rig.volume.gain.value : null);

// ---- radio and track selection ----

/** The station the player hears now: their own tuning, else the room's, else null (each map plays its own track). */
export const getStation = () => effectiveStation();
export const getRoomStation = () => roomStation;
export const getPersonalStation = () => personalStation;
/** The room's radio changed (the server's word in Zombies and the range). */
export function setRoomStation(next: StationId | null) { roomStation = next; applyVolume(); }
/** A hidden radio's tuning, for this player only; null hands back to the room's radio or the map's track. */
export function setPersonalStation(next: StationId | null) { personalStation = next; applyVolume(); }
/** The track the current map would play on its own. */
export const getMapTrack = () => mapTrack;
/** The song that is sounding (or about to). */
export const getPlayingTrack = (): SongId => (current?.song ?? wantTrack);
/** How the playing deck sounds: its recording, waiting for it, the synthesized stand-in, or a synthesized track. */
export const getDeckState = (): DeckState | null => current?.state ?? null;
/** The map change in progress, or null: the song going out and the one coming in. */
export const getCrossfade = (): { from: SongId; to: SongId } | null => (leaving && current ? { from: leaving.song, to: current.song } : null);
/** Warms the file of a song the player is likely to tune to next (the radio calls it for the next station on the dial). */
export function musicPrefetch(song: SongId) { const k = streamKeyFor(song); if (k) prefetchStream(k); }
/** The tune-in: a burst of static sweeping across the dial and a click. Honours mute and volume, but not Off (the click that turns it off is heard). */
export function playTuneIn() {
  if (rig && ctx && audibleBase()) rig.playTuneIn(ctx.currentTime + 0.01);
}
let lastBar: { track: SongId; stream: StreamKey | null; at: number; voices: string[]; tune: number[] } | null = null;
/** What the director is doing, for the `?dev` probe: the station, the track wanted and playing, the crossfade, and the last bar handed to the synth. */
export const musicProbe = () => ({ station: effectiveStation(), mapTrack, want: wantTrack, playing: current?.song ?? null, deck: current?.state ?? null, stream: current?.stream ?? null, dropAt: Number.isFinite(lastDropAt) ? lastDropAt : null, crossfade: getCrossfade(), now: ctx?.currentTime ?? null, lastBar });
/** The scheduler step; the page runs it on a timer, tests drive it. */
export const musicTick = tick;
