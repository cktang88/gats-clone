/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAP_IDS } from '../src/shared/maps.ts';
import { ROTATION } from '../src/shared/maps.ts';
import { generateBar, IDLE_INPUT, LAYER_IDS, type Inst, type LayerId, type Mode } from '../src/client/musictheory.ts';
import { formSeconds, MAP_TRACK, TRACK_IDS, TRACKS, trackIdFor, type TrackId } from '../src/client/musictracks.ts';
import { EXTRA_INSTS } from '../src/client/musicvoices.ts';

const BUILT_IN: readonly Inst[] = ['kick', 'snare', 'hat', 'tom', 'bass', 'pad', 'glock', 'stab', 'lead', 'heart'];
const KNOWN = new Set<Inst>([...BUILT_IN, ...EXTRA_INSTS]);
/** The map themes: all but the original march, whose tunes are seeded. */
const WRITTEN = TRACK_IDS.filter((id) => id !== 'march');
const modesOf = (id: TrackId): Mode[] => (id === 'outpost' ? ['major', 'minor'] : ['major']);
const inputFor = (id: TrackId, mode: Mode) => ({ mode: id === 'outpost' ? ('zombies' as const) : ('arena' as const), night: mode === 'minor', day: id === 'outpost' && mode === 'major' });

test('every map has its own track, and the geometry test room and the menu fall back to the march', () => {
  for (const id of MAP_IDS) assert.ok(TRACKS[trackIdFor(id)], `${id} resolves`);
  assert.equal(new Set(MAP_IDS.map((id) => trackIdFor(id))).size, MAP_IDS.length, 'no two maps share a track');
  assert.deepEqual(new Set(Object.values(MAP_TRACK)), new Set(TRACK_IDS));
  assert.equal(trackIdFor('geo-test'), 'march');
  assert.equal(trackIdFor(undefined), 'march');
  assert.equal(trackIdFor('plaza'), 'march');
  assert.equal(trackIdFor('outpost'), 'outpost');
  for (const mode of ['FFA', 'TDM', 'DOM', 'BR', 'ZOM', 'RNG'] as const) for (const id of ROTATION[mode]) assert.ok(MAP_TRACK[id], `${mode}: ${id}`);
});

test('a seed always writes the same bars for every track, and other seeds vary the fills and ornaments', () => {
  for (const id of TRACK_IDS) for (const mode of modesOf(id)) {
    const t = TRACKS[id];
    const a = JSON.stringify(Array.from({ length: 40 }, (_, n) => t.bar(7, mode, n)));
    assert.equal(a, JSON.stringify(Array.from({ length: 40 }, (_, n) => t.bar(7, mode, n))), `${id} ${mode} is deterministic`);
    assert.notEqual(a, JSON.stringify(Array.from({ length: 40 }, (_, n) => t.bar(8, mode, n))), `${id} ${mode} varies with the seed`);
  }
  assert.deepEqual(generateBar(42, 'major', 5), generateBar(42, 'major', 5));
});

test('tempos span lo-fi to trap and the keys are the themes\' own', () => {
  const bpms = new Set<number>();
  for (const id of TRACK_IDS) for (const mode of modesOf(id)) {
    const bpm = TRACKS[id].bpm(inputFor(id, mode));
    assert.ok(bpm >= 80 && bpm <= 150, `${id} ${mode}: ${bpm} bpm`);
    bpms.add(bpm);
  }
  assert.ok(bpms.size >= 10 && Math.max(...bpms) - Math.min(...bpms) >= 50, `a spread of tempos: ${[...bpms].sort().join(' ')}`);
  for (const id of WRITTEN) assert.equal(TRACKS[id].tonic(1), TRACKS[id].tonic(99), `${id} keeps its key`);
  const tonics = new Set(TRACK_IDS.filter((id) => id !== 'march').map((id) => `${TRACKS[id].tonic(1)}`));
  assert.ok(tonics.size >= 6, 'a spread of keys');
});

test('every bar of every track is playable: known voices, sane steps, velocities and note ranges, and a bounded note count', () => {
  for (const id of TRACK_IDS) for (const mode of modesOf(id)) {
    const t = TRACKS[id];
    const bars = id === 'march' ? 96 : t.formBars[mode] * 2;
    for (let n = 0; n < bars; n++) {
      const bar = t.bar(11, mode, n);
      assert.ok(bar.events.length > 0 && bar.events.length < 220, `${id} bar ${n}: ${bar.events.length} events`);
      for (const e of bar.events) {
        assert.ok(KNOWN.has(e.inst), `${id}: unknown voice ${e.inst}`);
        assert.ok(e.step >= 0 && e.step < 16 && e.dur > 0 && e.vel > 0 && e.vel <= 1.0001, `${id} bar ${n}: ${JSON.stringify(e)}`);
        assert.ok(Number.isFinite(e.midi) && e.midi >= 0 && e.midi <= 120, `${id}: midi ${e.midi}`);
        if (e.inst !== 'heart' && !['kick', 'snare', 'hat', 'ohat', 'brush', 'swirl', 'clap', 'shaker', 'rim', 'chug', 'sleigh', 'stomp', 'dust', 'wind', 'scrape', 'tom', 'k909', 'kbb', 'krock', 'sbb', 'srock', 'sgate', 'crash', 'ride', 'chip', 'tamb', 'snap', 'riser', 'impact'].includes(e.inst)) assert.ok(e.midi >= 20, `${id}: ${e.inst} at midi ${e.midi}`);
      }
      assert.ok(bar.chord.tones.length >= 3);
    }
  }
});

test('each track writes every intensity layer, so calm, combat, hype and finale all work (and the night its heartbeat)', () => {
  for (const id of TRACK_IDS) for (const mode of modesOf(id)) {
    const t = TRACKS[id];
    const seen = new Set<LayerId>();
    for (let n = 0; n < (id === 'march' ? 64 : t.formBars[mode]); n++) for (const e of t.bar(3, mode, n).events) seen.add(e.layer);
    const want = id === 'outpost' && mode === 'major' ? (['calm', 'combat', 'hype'] as LayerId[]) : id === 'outpost' ? [...LAYER_IDS] : id === 'march' ? [...LAYER_IDS] : (['calm', 'combat', 'hype', 'finale'] as LayerId[]);
    for (const l of want) assert.ok(seen.has(l), `${id} ${mode} has ${l}`);
  }
});

test('the menu and Plaza march is the original (af4983a) note for note, in a new key each seed, and its own voices', async () => {
  const { classicBar, classicKeyOfSeed, CLASSIC_KEYS } = await import('../src/client/musicclassic.ts');
  const { createHash } = await import('node:crypto');
  assert.equal(TRACKS.march.voice, 'classic');
  assert.equal(TRACKS.march.label, 'Toy March (original)');
  // A fingerprint of the bars af4983a's generateBar wrote (taken from that commit's own code): any change to the march changes it.
  const bars = [1, 42, 0xbeef].flatMap((seed) => (['major', 'minor'] as const).flatMap((mode) => Array.from({ length: 24 }, (_, n) => classicBar(seed, mode, n))));
  assert.equal(createHash('sha256').update(JSON.stringify(bars)).digest('hex').slice(0, 16), CLASSIC_FINGERPRINT);
  const keys = new Set(Array.from({ length: 40 }, (_, s) => classicKeyOfSeed(s)));
  assert.ok(keys.size >= 3 && [...keys].every((k) => (CLASSIC_KEYS as readonly number[]).includes(k)), 'each seed picks one of the bright brass keys');
  assert.equal(TRACKS.march.tonic(5), classicKeyOfSeed(5));
  const layers = new Set(Array.from({ length: 16 }, (_, n) => classicBar(3, 'minor', n).events.map((e) => e.layer)).flat());
  assert.deepEqual([...layers].sort(), [...LAYER_IDS].sort(), 'calm, combat, hype, finale and the night\'s heartbeat');
  assert.equal(generateBar(9, 'major', 0).tonic, generateBar(9, 'major', 100).tonic);
});
const CLASSIC_FINGERPRINT = '9ba8aefab9881f6c';

test('every sampled note is within a few semitones of a recorded one, and the samples are on disk and small', async () => {
  const { SAMPLES, sampleFile } = await import('../src/client/musicsamples.ts');
  const { existsSync, statSync } = await import('node:fs');
  let bytes = 0;
  for (const [inst, spec] of Object.entries(SAMPLES)) for (const n of spec!.notes) {
    const file = new URL(`../public/${sampleFile(inst as Inst, n)}`, import.meta.url);
    assert.ok(existsSync(file), `${inst} ${n} is built (node scripts/build-music-samples.ts)`);
    bytes += statSync(file).size;
  }
  assert.ok(bytes < 5 * 1024 * 1024, `${(bytes / 1048576).toFixed(1)} MB of samples`);
  assert.ok(existsSync(new URL('../public/music/LICENSE.txt', import.meta.url)), 'with their licence');
  for (const id of TRACK_IDS) for (const mode of modesOf(id)) for (let n = 0; n < (id === 'march' ? 32 : TRACKS[id].formBars[mode]) * 2; n++) {
    for (const e of TRACKS[id].bar(1, mode, n).events) {
      const spec = SAMPLES[e.inst];
      if (!spec) continue;
      const near = Math.min(...spec.notes.map((m) => Math.abs(m - e.midi)));
      assert.ok(near <= 4, `${id} bar ${n}: ${e.inst} at ${e.midi} is ${near} semitones from a sample`);
    }
  }
});

// ---- the director: crossfade on a map change, the radio, the night ----

import { pickTrack } from '../src/client/musictracks.ts';
import { createRig } from '../src/client/musicsynth.ts';
import { EMPTY_BUFFER } from '../src/client/interp.ts';
import { loadWaa } from '../scripts/render-reload-sfx.ts';

test('a radio station replaces the map\'s track, a Zombies night keeps its own score, and Off is silence', () => {
  assert.equal(pickTrack('museum', null, false), 'museum');
  assert.equal(pickTrack('museum', 'park', false), 'park');
  assert.equal(pickTrack('outpost', 'park', false), 'park');
  assert.equal(pickTrack('outpost', 'park', true), 'outpost', 'the night overrides the station');
  assert.equal(pickTrack('outpost', null, true), 'outpost');
  assert.equal(pickTrack('outpost', 'off', true), 'outpost', 'off is handled by the music gate, not the track choice');
  assert.equal(pickTrack('range', 'harbor', true), 'harbor', 'only the outpost has a night score');
});

/**
 * A Web Audio stand-in good enough for the music scheduler, for when node-web-audio-api is not installed: every node takes any call and
 * plays nothing, sample files never decode (the synth voices play), and the clock is the test's own.
 */
function fakeAudioContext(now: () => number) {
  const param = () => { const p: Record<string, unknown> = { value: 0 }; for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime', 'setValueCurveAtTime']) p[m] = () => p; return p; };
  const node = (): never => {
    const n: Record<string, unknown> = { frequency: param(), gain: param(), detune: param(), Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), playbackRate: param(), pan: param(), start() {}, stop() {}, disconnect() {} };
    n.connect = (x: unknown) => x;
    return n as never;
  };
  return {
    sampleRate: 8000, get currentTime() { return now(); }, baseLatency: 0, outputLatency: 0, state: 'running', destination: node(), resume: () => Promise.resolve(),
    createBuffer: (_c: number, l: number) => ({ getChannelData: () => new Float32Array(l), duration: 1 }),
    createGain: node, createOscillator: node, createBiquadFilter: node, createBufferSource: node, createDynamicsCompressor: node, createConvolver: node, createStereoPanner: node,
    decodeAudioData: () => Promise.reject(new Error('no samples under test')),
  };
}

// Runs on a real offline context when node-web-audio-api is installed, and on the stand-in otherwise, so the scheduler is always exercised.
test('a map change crossfades to the new map\'s track and the old track fades out; a station change does the same', async () => {
  const waa = loadWaa();
  let clock = 0;
  const real = waa ? new waa.OfflineAudioContext(2, 44100 * 5, 44100) : null;
  const ctx = real
    ? new Proxy(real, { get: (target, prop) => (prop === 'currentTime' ? clock : typeof (target as never)[prop as never] === 'function' ? ((target as never)[prop as never] as () => unknown).bind(target) : (target as never)[prop as never]) })
    : fakeAudioContext(() => clock);
  const music = await import('../src/client/music.ts');
  // The test drives the scheduler itself (musicTick), so the page's own interval is not started.
  const interval = globalThis.setInterval;
  globalThis.setInterval = (() => 0) as never;
  try { music.musicStart(ctx as unknown as AudioContext, (real?.destination ?? (ctx as { destination: AudioNode }).destination) as AudioNode); } finally { globalThis.setInterval = interval; }
  const state = { phase: 'playing', s: { snaps: EMPTY_BUFFER, mapId: 'plaza' } } as never;
  const step = (dt: number) => { clock += dt; music.musicUpdate(state, clock * 1000, false); music.musicTick(); };
  for (let i = 0; i < 20; i++) step(0.1);
  assert.equal(music.getPlayingTrack(), 'march');
  assert.equal(music.getCrossfade(), null);
  (state as { s: { mapId: string } }).s.mapId = 'causeway'; // the harbour
  let steps = 0;
  while (music.getPlayingTrack() !== 'harbor' && steps++ < 400) step(0.1);
  assert.equal(music.getPlayingTrack(), 'harbor', 'the new map\'s track takes over at a bar line');
  assert.deepEqual(music.getCrossfade(), { from: 'march', to: 'harbor' });
  let fading = 0;
  for (; fading < 80 && music.getCrossfade(); fading++) step(0.1);
  assert.equal(music.getCrossfade(), null, 'and the old track is gone once the fade is over');
  assert.ok(fading * 0.1 >= 3 && fading * 0.1 <= 6, `a map change is a slow blend of both tracks, not a cut (${(fading * 0.1).toFixed(1)}s)`);
  // The radio: a station beats the map's track, null hands back.
  music.setRoomStation('wasteland');
  for (let i = 0; i < 400 && music.getPlayingTrack() !== 'wasteland'; i++) step(0.1);
  assert.equal(music.getPlayingTrack(), 'wasteland');
  music.setPersonalStation('summit');
  for (let i = 0; i < 400 && music.getPlayingTrack() !== 'summit'; i++) step(0.1);
  assert.equal(music.getPlayingTrack(), 'summit', 'your own radio wins over the room\'s');
  assert.equal(music.getStation(), 'summit');
  music.setPersonalStation(null);
  music.setRoomStation(null);
  for (let i = 0; i < 600 && music.getPlayingTrack() !== 'harbor'; i++) step(0.1);
  assert.equal(music.getPlayingTrack(), 'harbor', 'back to the map\'s track');
  // A radio retune is a real radio's: the new station is on at the next scheduler tick, mid-bar, with no crossfade, and on its hook.
  for (let i = 0; i < 80 && music.getCrossfade(); i++) step(0.1);
  for (const station of ['march', 'oldtown', 'quarry', 'harbor'] as const) {
    for (let i = 0; i < 7; i++) step(0.13); // somewhere in the middle of a bar
    music.setRoomStation(station);
    step(0.03);
    assert.equal(music.getPlayingTrack(), station, `${station} is on within a tick`);
    assert.equal(music.getCrossfade(), null, 'no crossfade: the old station is cut');
    const probe = music.musicProbe();
    assert.equal(probe.lastBar?.track, station);
    assert.ok(probe.lastBar!.at - clock < 0.06, `and its first bar starts at once (${(probe.lastBar!.at - clock).toFixed(3)} s from now)`);
    assert.ok(probe.lastBar!.tune.length > 0 || station === 'harbor' || station === 'march', `${station} comes in on its tune`);
  }
  music.setRoomStation(null);
});

test('every station on the dial has its own tune: what a radio plays first, the hook, never matches another station\'s', () => {
  // The bug this guards: the toy march and the old town's fife once played the same seeded tune, so retuning between them changed only the label.
  const sung = (id: TrackId) => {
    const ev = Array.from({ length: 8 }, (_, k) => TRACKS[id].bar(5, 'major', TRACKS[id].hookStart.major + k).events.filter((e) => e.tag === 'hook' && e.layer === 'calm')).flat();
    return JSON.stringify([ev.map((e) => Math.floor(e.step)), ev.slice(1).map((e, i) => e.midi - ev[i]!.midi)]);
  };
  assert.equal(new Set(WRITTEN.map(sung)).size, WRITTEN.length);
  for (const id of WRITTEN) assert.ok(TRACKS[id].bar(5, 'major', TRACKS[id].hookStart.major).events.some((e) => e.tag === 'hook'), `${id}: a retune lands on the hook`);
});

test('a bar of any track costs a bounded number of audio nodes', () => {
  let count = 0;
  const param = () => { const p: Record<string, unknown> = { value: 0 }; for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'cancelScheduledValues', 'setValueCurveAtTime']) p[m] = () => p; return p; };
  const node = (): never => {
    count++;
    const n: Record<string, unknown> = { frequency: param(), gain: param(), detune: param(), Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), start() {}, stop() {}, disconnect() {} };
    n.connect = (x: unknown) => x;
    return n as never;
  };
  const ctx = { sampleRate: 44100, currentTime: 0, createBuffer: (_c: number, l: number) => ({ getChannelData: () => new Float32Array(l) }), createGain: node, createOscillator: node, createBiquadFilter: node, createBufferSource: node, createDynamicsCompressor: node, createConvolver: node } as unknown as BaseAudioContext;
  const rig = createRig(ctx, node());
  const deck = rig.newDeck(1);
  for (const id of TRACK_IDS) for (const mode of modesOf(id)) {
    let worst = 0;
    for (let n = 0; n < (id === 'march' ? 64 : TRACKS[id].formBars[mode]); n++) { count = 0; rig.playBar(TRACKS[id].bar(1, mode, n), 0, 0.5, 2, deck); worst = Math.max(worst, count); }
    assert.ok(worst <= 900, `${id} ${mode}: ${worst} nodes in its busiest bar with every layer on`);
  }
});

test('a music volume that is not a number never reaches the bus or the saved setting', async () => {
  const music = await import('../src/client/music.ts');
  music.setMusicVolume(0.4);
  assert.equal(music.getMusicVolume(), 0.4);
  music.setMusicVolume(Number.NaN);
  assert.ok(Number.isFinite(music.getMusicVolume()), `volume ${music.getMusicVolume()}`);
  music.setMusicVolume(1);
});

test('leaving for the menu leaves the radio behind', async () => {
  const music = await import('../src/client/music.ts');
  music.setRoomStation('harbor');
  music.setPersonalStation('park');
  music.musicUpdate({ phase: 'playing', s: { snaps: EMPTY_BUFFER, mapId: 'plaza' } } as never, 1000, false);
  assert.equal(music.getStation(), 'park');
  music.musicUpdate({ phase: 'menu', status: { kind: 'idle' } } as never, 2000, false);
  assert.equal(music.getStation(), null);
  assert.equal(music.getRoomStation(), null);
});

test('every track carries a loudness trim that keeps the library level (measured offline in Chrome; see scripts/render-music.ts)', () => {
  for (const id of TRACK_IDS) assert.ok(TRACKS[id].trim >= 0.6 && TRACKS[id].trim <= 2.2, `${id}: trim ${TRACKS[id].trim}`);
  assert.ok(TRACKS.march.trim <= 1, 'the march, the loudest, is never boosted');
});
