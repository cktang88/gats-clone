/**
 * Offline renders of the per-map scores through the real music rig and master bus (compressor + limiter), for measuring and listening.
 * No Node imports, so it bundles for a browser too: headless Chrome's OfflineAudioContext is the faithful one (its compressor is the one players
 * hear); node-web-audio-api's compressor has no make-up gain and runs hotter, so use it for structure checks, not loudness.
 * `renderTour`: a tour through every intensity state (calm, combat, hype, finale, calm) with kill stings, ending on the win cadence.
 * `renderCrossfade`: a map change from one track to another.
 * `renderSample`: a short listening sample of a theme, calm into a fight: the bass coming in and the hook in calm, then the build and the drop
 * in a fight with kill stings, then the hook again (the groove and breakdown are skipped for time). The march plays through its own voices.
 */
import { createBus } from '../src/client/audio.ts';
import { createRig } from '../src/client/musicsynth.ts';
import { createClassicVoices } from '../src/client/musicclassic.ts';
import { instsOf, TRACKS, TRACK_IDS, type TrackId } from '../src/client/musictracks.ts';
import { createSampleBank } from '../src/client/musicsamples.ts';
import { crossfade, heartTier, IDLE_INPUT, layerTargets, LAYER_IDS, levelGain, modeOf, type LayerId, type MusicInput } from '../src/client/musictheory.ts';
export const SAMPLE_RATE = 44100;
export type Rendered = { left: Float32Array; right: Float32Array; seconds: number };
export type Waa = { OfflineAudioContext: new (channels: number, length: number, rate: number) => OfflineAudioContext };
/** Reads a file published under public/ (the sampled instruments); without one the render uses the synth voices only. */
export type FetchBytes = (path: string) => Promise<ArrayBuffer>;
const BUS_GAIN = 0.32;
const TAIL_S = 4;

/** The intensity states of the tour, in seconds from the start. */
export const TOUR: readonly { to: number; label: string; input: Partial<MusicInput> }[] = [
  { to: 10, label: 'calm', input: {} },
  { to: 20, label: 'combat', input: { heat: 0.8 } },
  { to: 32, label: 'hype', input: { heat: 1, streak: 4 } },
  { to: 44, label: 'finale', input: { heat: 1, streak: 4, finale: true } },
  { to: 54, label: 'calm again', input: {} },
];
export const STINGS: readonly { t: number; streak: number; bounty?: boolean }[] = [
  { t: 14, streak: 1 }, { t: 16, streak: 2 }, { t: 23, streak: 3 }, { t: 25, streak: 4, bounty: true }, { t: 37, streak: 5 },
];
export const CADENCE_AT = 54;

const inputAt = (t: number, base: Partial<MusicInput>): MusicInput => {
  const phase = TOUR.find((p) => t < p.to) ?? TOUR.at(-1)!;
  return { ...IDLE_INPUT, phase: 'play', ...base, ...phase.input };
};

/** Renders a track through the real rig. `night` renders the Zombies night (minor, heartbeat); `day` the Zombies day (calm only). */
export async function renderTour(waa: Waa, id: TrackId, o: { seed?: number; night?: boolean; day?: boolean; seconds?: number; tour?: boolean; fetchBytes?: FetchBytes } = {}): Promise<Rendered> {
  const seed = o.seed ?? 12345;
  const total = o.seconds ?? CADENCE_AT + TAIL_S + 4;
  const base: Partial<MusicInput> = o.night ? { mode: 'zombies', night: true, horde: 1 } : o.day ? { mode: 'zombies', day: true } : {};
  const lead = Math.round(0.2 * SAMPLE_RATE);
  const ctx = new waa.OfflineAudioContext(2, lead + Math.ceil(total * SAMPLE_RATE), SAMPLE_RATE);
  const master = createBus(ctx, ctx.destination);
  const bank = o.fetchBytes ? createSampleBank(ctx, o.fetchBytes) : null;
  await bank?.load(instsOf(id));
  const rig = createRig(ctx, master, bank);
  rig.volume.gain.value = BUS_GAIN;
  const track = TRACKS[id];
  const deck = rig.newDeck(track.trim);
  deck.fade.gain.value = 1;
  const t0 = 0.2;
  let t = t0, bar = 0;
  const tour = o.tour ?? true;
  const cadenceT = t0 + CADENCE_AT;
  while (t < t0 + total - TAIL_S - 2 && !(tour && t >= cadenceT)) {
    const rel = t - t0;
    const input = tour ? inputAt(rel, base) : { ...IDLE_INPUT, phase: 'play' as const, ...base, heat: 1, streak: 4, finale: !o.day && !o.night, ...(o.day ? {} : {}) };
    const mode = modeOf(input);
    const spb = 60 / track.bpm(input);
    const target = layerTargets(input);
    for (const l of LAYER_IDS) deck.layers[l].gain.setTargetAtTime(levelGain(target[l]), t, 0.25);
    const on = {} as Record<LayerId, boolean>;
    for (const l of LAYER_IDS) on[l] = target[l] > 0.02;
    const b = track.bar(seed, mode, bar);
    rig.playBar({ ...b, events: b.events.filter((e) => on[e.layer]) }, t, spb, heartTier(input.horde), deck);
    if (tour) for (const s of STINGS) {
      const end = t + spb * 4;
      if (t0 + s.t >= t && t0 + s.t < end) rig.playSting(b.chord, mode, s.streak, t0 + s.t, s.bounty, track.sting);
    }
    t += spb * 4; bar++;
  }
  if (tour) {
    for (const l of LAYER_IDS) deck.layers[l].gain.setTargetAtTime(0, cadenceT, 0.12);
    rig.playCadence('win', track.tonic(seed), cadenceT + 0.12);
  }
  const buf = await ctx.startRendering();
  return { left: buf.getChannelData(0).slice(lead), right: buf.getChannelData(1).slice(lead), seconds: total };
}

/** A map change: `from` plays four bars at hype, then `to` crossfades in over `xfade` seconds (the same curves as music.ts). */
export async function renderCrossfade(waa: Waa, from: TrackId, to: TrackId, xfade = 3.5, seed = 777, fetchBytes?: FetchBytes): Promise<Rendered> {
  const input: MusicInput = { ...IDLE_INPUT, phase: 'play', heat: 1, streak: 4 };
  const A = TRACKS[from], B = TRACKS[to];
  const barsA = 6, spbA = 60 / A.bpm(input), spbB = 60 / B.bpm(input);
  const swapAt = 0.2 + barsA * spbA * 4;
  const total = Math.ceil(swapAt + xfade + 6 * spbB * 4 + 3);
  const ctx = new waa.OfflineAudioContext(2, Math.ceil(total * SAMPLE_RATE), SAMPLE_RATE);
  const master = createBus(ctx, ctx.destination);
  const bank = fetchBytes ? createSampleBank(ctx, fetchBytes) : null;
  await bank?.load([...instsOf(from), ...instsOf(to)]);
  const rig = createRig(ctx, master, bank);
  rig.volume.gain.value = BUS_GAIN;
  const target = layerTargets(input);
  const mk = (tr: typeof A) => { const d = rig.newDeck(tr.trim); for (const l of LAYER_IDS) d.layers[l].gain.value = levelGain(target[l]); return d; };
  const da = mk(A), db = mk(B);
  da.fade.gain.value = 1;
  const curve = (f: (x: number) => number) => Float32Array.from({ length: 32 }, (_, i) => f(i / 31));
  da.fade.gain.setValueAtTime(1, swapAt);
  da.fade.gain.setValueCurveAtTime(curve((x) => crossfade(x).a), swapAt, xfade);
  db.fade.gain.setValueAtTime(0, 0);
  db.fade.gain.setValueCurveAtTime(curve((x) => crossfade(x).b), swapAt, xfade);
  const on = {} as Record<LayerId, boolean>;
  for (const l of LAYER_IDS) on[l] = target[l] > 0.02;
  let t = 0.2;
  for (let n = 0; t < swapAt + xfade; n++, t += spbA * 4) { const b = A.bar(seed, 'major', n); rig.playBar({ ...b, events: b.events.filter((e) => on[e.layer]) }, t, spbA, 0, da); }
  t = swapAt;
  for (let n = 0; t < total - 3; n++, t += spbB * 4) { const b = B.bar(seed, 'major', n); rig.playBar({ ...b, events: b.events.filter((e) => on[e.layer]) }, t, spbB, 0, db); }
  const buf = await ctx.startRendering();
  return { left: buf.getChannelData(0), right: buf.getChannelData(1), seconds: total };
}


/** The bars a sample plays (a theme's local bar numbers), and the state each is played in. */
export const SAMPLE_PLAN: readonly { bars: readonly number[]; label: string; input: Partial<MusicInput> }[] = [
  { bars: [4, 5, 6, 7, 8, 9, 10, 11], label: 'calm: the bass comes in, then the hook', input: {} },
  { bars: [28, 29, 30, 31], label: 'combat: the build', input: { heat: 0.8 } },
  { bars: [32, 33, 34, 35, 36, 37, 38, 39], label: 'hype: the drop', input: { heat: 1, streak: 4 } },
  { bars: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23], label: 'hype: the hook again', input: { heat: 1, streak: 4 } },
];

/**
 * A listening sample of a track, `seconds` long (see `SAMPLE_PLAN`), through the real rig and master bus, with layer gains easing as they do in
 * the game. Returns the render and when each part of the plan starts. `night` and `day` render the Zombies night and day.
 */
export async function renderSample(waa: Waa, id: TrackId, o: { seconds?: number; night?: boolean; day?: boolean; seed?: number; fetchBytes?: FetchBytes } = {}): Promise<Rendered & { parts: { at: number; label: string }[]; hook: { t: number; dur: number; midi: number }[] }> {
  const seconds = o.seconds ?? 45, seed = o.seed ?? 12345;
  const base: Partial<MusicInput> = o.night ? { mode: 'zombies', night: true, horde: 0.8 } : o.day ? { mode: 'zombies', day: true } : {};
  const lead = Math.round(0.2 * SAMPLE_RATE);
  const ctx = new waa.OfflineAudioContext(2, lead + Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const master = createBus(ctx, ctx.destination);
  const bank = o.fetchBytes ? createSampleBank(ctx, o.fetchBytes) : null;
  await bank?.load(instsOf(id));
  const rig = createRig(ctx, master, bank);
  rig.volume.gain.value = BUS_GAIN;
  const track = TRACKS[id];
  const classic = track.voice === 'classic' ? createClassicVoices(ctx, rig.direct) : null;
  const deck = rig.newDeck(track.trim);
  deck.fade.gain.value = 1;
  const t0 = 0.2;
  let t = t0;
  const parts: { at: number; label: string }[] = [];
  let first = true;
  let stings = 0;
  // The hook's notes as played (one per onset), for checking that the render carries it.
  const hook: { t: number; dur: number; midi: number }[] = [];
  for (const part of SAMPLE_PLAN) {
    parts.push({ at: t - t0, label: part.label });
    for (const n of part.bars) {
      if (t - t0 >= seconds) break;
      const input: MusicInput = { ...IDLE_INPUT, phase: 'play', ...base, ...part.input };
      const mode = modeOf(input);
      const spb = 60 / track.bpm(input);
      const target = layerTargets(input);
      for (const l of LAYER_IDS) {
        if (first) deck.layers[l].gain.setValueAtTime(levelGain(target[l]), t);
        else deck.layers[l].gain.setTargetAtTime(levelGain(target[l]), t, target[l] > 0 ? 0.5 : 1.3);
      }
      first = false;
      const on = {} as Record<LayerId, boolean>;
      for (const l of LAYER_IDS) on[l] = target[l] > 0.02;
      const b = track.bar(seed, mode, n);
      const bar = { ...b, events: b.events.filter((e) => on[e.layer]) };
      if (classic) classic.playBar(bar, t, spb, heartTier(input.horde), deck); else rig.playBar(bar, t, spb, heartTier(input.horde), deck);
      const sung = new Map<number, { t: number; dur: number; midi: number }>();
      for (const e of bar.events) if (e.tag === 'hook' && !sung.has(e.step)) sung.set(e.step, { t: t - t0 + (e.step * spb) / 4, dur: (e.dur * spb) / 4, midi: e.midi });
      hook.push(...sung.values());
      // Kills in the fight: a sting on the second beat of every other bar of the drop.
      if ((part.input.streak ?? 0) > 0 && n % 2 === 1 && stings < 6) {
        stings++;
        if (classic) classic.playSting(b.chord, mode, stings + 1, t + spb, false); else rig.playSting(b.chord, mode, stings + 1, t + spb, false, track.sting);
      }
      t += spb * 4;
    }
  }
  const buf = await ctx.startRendering();
  return { left: buf.getChannelData(0).slice(lead), right: buf.getChannelData(1).slice(lead), seconds, parts, hook };
}
