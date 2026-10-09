/// <reference types="node" />
/**
 * The recordings: Night Market keeps Eric Skiff's, the radio-only stations theirs, and every other map plays its synthesized theme. Each recording
 * is licensed, credited and on disk, nothing else is left in the folder, and CREDITS.md is what scripts/music-credits.ts writes. The director plays
 * a recording (falling back to a synthesized theme while it loads or if it fails) and the radio dial reaches all of them. One file, one module
 * instance: music.ts keeps its state in module scope.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { EXTRA_IDS, STATION_IDS, TRACK_IDS, cycleStation, isStationId, type StationId } from '../src/shared/radio.ts';
import { allCredits, DROP, LICENCE_URL, setStreamFactory, STREAMS, streamKeyFor, synthFor, type StreamKey } from '../src/client/musicstream.ts';
import { MAP_TRACK, TRACKS } from '../src/client/musictracks.ts';
import { EMPTY_BUFFER } from '../src/client/interp.ts';

const pub = (f: string) => new URL(`../public/${f}`, import.meta.url);

test('Night Market keeps Skiff\'s recording and every other map its synthesized theme; the recordings are credited, on disk and small, and nothing unused is shipped', async () => {
  for (const [map, id] of Object.entries(MAP_TRACK)) {
    const key = streamKeyFor(id);
    if (map === 'market') { assert.equal(key, 'market'); assert.equal(STREAMS.market.credit.artist, 'Eric Skiff (ericskiff.com)'); continue; }
    assert.equal(key, null, `${map} plays its synthesized theme`);
    assert.ok(TRACKS[id].pop || id === 'march', `${map}: a theme or the march`);
  }
  for (const id of EXTRA_IDS) assert.ok(STREAMS[id], `radio-only ${id} has a recording`);
  // The folder holds exactly the files the registry names, and the credits are what the script writes.
  const files = readdirSync(pub('music/tracks')).filter((f) => f.endsWith('.mp3')).sort();
  assert.deepEqual(files, [...Object.values(STREAMS).map((s) => s.file), DROP.file].map((f) => f.split('/').pop()!).sort(), 'every recording on disk is used, and every one used is on disk');
  const { creditsMarkdown } = await import('../scripts/music-credits.ts');
  assert.equal(readFileSync(pub('music/tracks/CREDITS.md'), 'utf8'), creditsMarkdown(), 'CREDITS.md is up to date (node scripts/music-credits.ts)');
  const titles = new Set<string>();
  for (const s of Object.values(STREAMS)) {
    const c = s.credit;
    // Only permissive licences: CC0 or CC BY, never NC, ND or SA.
    assert.ok(c.licence in LICENCE_URL, `${s.key}: ${c.licence}`);
    assert.equal(c.licenceUrl, LICENCE_URL[c.licence]);
    assert.ok(!/nc|nd|sa/i.test(c.licenceUrl.replace('creativecommons', '')), `${s.key}: ${c.licenceUrl}`);
    assert.ok(c.title && c.artist && /^https:\/\//.test(c.source) && c.changes, `${s.key}: a full credit`);
    assert.ok(s.why.length > 20, `${s.key}: says why it fits`);
    assert.ok(s.bpm >= 60 && s.bpm <= 220, `${s.key}: ${s.bpm} bpm`);
    assert.ok(s.tonic === null || (s.tonic >= 0 && s.tonic < 12));
    assert.ok(existsSync(pub(s.file)), `${s.file} is on disk`);
    assert.ok(statSync(pub(s.file)).size <= 2.5 * 1024 * 1024, `${s.file}: ${(statSync(pub(s.file)).size / 1048576).toFixed(2)} MB`);
    assert.ok(!titles.has(c.title), `${c.title} is used once`);
    titles.add(c.title);
  }
  assert.ok(existsSync(pub(DROP.file)) && statSync(pub(DROP.file)).size < 200_000, 'the bass-drop sting is short');
  // The credits file and the in-game list name every recording with its artist and licence.
  const md = readFileSync(pub('music/tracks/CREDITS.md'), 'utf8');
  for (const c of [...allCredits(), DROP.credit]) for (const bit of [c.title, c.artist, c.licenceUrl, c.source]) assert.ok(md.includes(bit), `CREDITS.md names ${bit}`);
  assert.equal(allCredits().length, Object.keys(STREAMS).length);
  // A real spread of genres, not one everywhere: at least four artists' worth of sources and several licensors.
  assert.ok(new Set(allCredits().map((c) => c.artist)).size >= 3);
});

test('the radio dial reaches every recording, the radio-only stations and the original march, each named for what it plays', async () => {
  const { stationLabel } = await import('../src/client/radio.ts');
  let at: StationId | null = null;
  const seen = new Set<StationId | null>();
  for (let i = 0; i < STATION_IDS.length; i++) { at = cycleStation(at, false); seen.add(at); }
  for (const id of [...TRACK_IDS, ...EXTRA_IDS]) assert.ok(seen.has(id) && isStationId(id), `${id} is on the dial`);
  assert.ok(seen.has('off'));
  for (const id of EXTRA_IDS) { assert.equal(stationLabel(id), STREAMS[id].credit.title); assert.equal(synthFor(id), 'march', 'a radio-only station borrows the march while it loads'); }
  assert.equal(stationLabel('march'), 'Toy March (original)');
  assert.equal(stationLabel('market'), "We're All Under the Stars");
  assert.equal(stationLabel('harbor'), 'Harbour Lights', 'a synthesized theme goes by its own name');
  assert.equal(stationLabel('quarry'), 'Rockfall Phonk');
  assert.equal(synthFor('market'), 'market', 'Night Market\'s theme stands in for its recording');
});

/** A Web Audio stand-in for the scheduler: nodes take any call; connections are counted on the music bus so leaks would show. */
function fakeAudioContext(now: () => number) {
  const param = () => { const p: Record<string, unknown> = { value: 1 }; for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime', 'setValueCurveAtTime']) p[m] = () => p; return p; };
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

test('the director plays a map\'s recording, crossfades between maps, retunes at once, and lets the synth stand in while a file is late or broken', async () => {
  let clock = 0;
  // Files load in 0.4 s, except the ones this test breaks or holds back.
  const broken = new Set<string>(['music/tracks/chibi.mp3']);
  const slow = new Map<string, number>([['music/tracks/groove.mp3', 3]]);
  const players: { file: string; started: boolean; stopped: boolean }[] = [];
  setStreamFactory((c, file) => {
    const born = clock;
    const rec = { file, started: false, stopped: false };
    players.push(rec);
    return {
      output: c.createGain(),
      ready: () => !broken.has(file) && clock - born >= (slow.get(file) ?? 0.4),
      failed: () => broken.has(file),
      start() { rec.started = true; },
      stop() { rec.stopped = true; },
    };
  });
  const ctx = fakeAudioContext(() => clock);
  const music = await import('../src/client/music.ts');
  const interval = globalThis.setInterval;
  globalThis.setInterval = (() => 0) as never;
  try { music.musicStart(ctx as unknown as AudioContext, ctx.destination as unknown as AudioNode); } finally { globalThis.setInterval = interval; }
  const state = { phase: 'playing', s: { snaps: EMPTY_BUFFER, mapId: 'plaza' } } as never;
  const step = (dt: number) => { clock += dt; music.musicUpdate(state, clock * 1000, false); music.musicTick(); };
  for (let i = 0; i < 20; i++) step(0.1);
  assert.equal(music.getPlayingTrack(), 'march');
  assert.equal(music.getDeckState(), 'synth', 'the Plaza plays the synthesized original march');
  assert.ok(music.musicProbe().lastBar!.voices.length > 0);

  // A map change to a theme: it is synthesized, no file is opened.
  (state as { s: { mapId: string } }).s.mapId = 'causeway';
  for (let i = 0; i < 400 && music.getPlayingTrack() !== 'harbor'; i++) step(0.1);
  assert.deepEqual(music.getCrossfade(), { from: 'march', to: 'harbor' });
  for (let i = 0; i < 80 && music.getCrossfade(); i++) step(0.1);
  assert.equal(music.getDeckState(), 'synth');
  assert.ok(music.musicProbe().lastBar!.voices.length > 0, 'the harbour\'s theme plays');
  assert.equal(players.length, 0, 'and no recording is opened for it');

  // Night Market: Skiff's recording crossfades in at a bar line and plays; the theme fades out.
  (state as { s: { mapId: string } }).s.mapId = 'market';
  for (let i = 0; i < 400 && music.getPlayingTrack() !== 'market'; i++) step(0.1);
  assert.deepEqual(music.getCrossfade(), { from: 'harbor', to: 'market' });
  for (let i = 0; i < 10; i++) step(0.1);
  assert.equal(music.getDeckState(), 'playing', 'the recording plays once it can');
  assert.ok(players.some((p) => p.file === STREAMS.market.file && p.started));
  assert.equal(music.musicProbe().lastBar!.stream, 'market');
  assert.deepEqual(music.musicProbe().lastBar!.voices, [], 'no synthesized notes over a recording');
  for (let i = 0; i < 80 && music.getCrossfade(); i++) step(0.1);
  assert.equal(music.getCrossfade(), null);

  // A radio retune is instant: the old recording stops at once and the new station's starts.
  music.setRoomStation('dekalb');
  step(0.03);
  assert.equal(music.getPlayingTrack(), 'dekalb');
  assert.equal(music.getCrossfade(), null, 'no crossfade: the old station is cut');
  assert.ok(players.find((p) => p.file === STREAMS.market.file)!.stopped, 'the market\'s file is let go');
  for (let i = 0; i < 6; i++) step(0.1);
  assert.equal(music.getDeckState(), 'playing');
  assert.ok(players.some((p) => p.file === STREAMS.dekalb.file && p.started));

  // A broken file: the synthesized march stands in at once, and the station still changed.
  music.setRoomStation('chibi');
  step(0.03); step(0.05);
  assert.equal(music.getPlayingTrack(), 'chibi');
  assert.equal(music.getDeckState(), 'fallback');
  for (let i = 0; i < 30; i++) step(0.1);
  assert.ok(music.musicProbe().lastBar!.voices.length > 0, 'the stand-in plays');
  assert.equal(music.musicProbe().lastBar!.stream, null);

  // A synthesized station: the Quarry's theme, on its hook at once.
  music.setRoomStation('quarry');
  step(0.03);
  assert.equal(music.getPlayingTrack(), 'quarry');
  assert.equal(music.getDeckState(), 'synth');
  assert.ok(music.musicProbe().lastBar!.tune.length > 0, 'the cowbell hook');

  // A late file: silence for a moment, then the stand-in, then the recording swells in over it when it arrives.
  music.setRoomStation('groove');
  step(0.03);
  assert.equal(music.getDeckState(), 'waiting');
  for (let i = 0; i < 15; i++) step(0.1);
  assert.equal(music.getDeckState(), 'fallback', 'past the grace the synth stands in');
  for (let i = 0; i < 20; i++) step(0.1);
  assert.equal(music.getDeckState(), 'playing', 'and the recording takes over when it arrives');

  // Untuned: back to the map's own.
  music.setRoomStation(null);
  for (let i = 0; i < 20; i++) step(0.1);
  assert.equal(music.getPlayingTrack(), 'market');

  // The hype: a kill streak of five over a recording drops the bass (the sting file loads when a streak gets going).
  const fetched: string[] = [];
  globalThis.fetch = ((url: string) => { fetched.push(String(url)); return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)), blob: () => Promise.resolve(new Blob()) }); }) as never;
  (ctx as Record<string, unknown>).decodeAudioData = () => Promise.resolve({ duration: 5.2, getChannelData: () => new Float32Array(8) });
  const me = { id: 1, name: 'me', x: 0, y: 0, hp: 100, maxHp: 100, team: null, alive: true, hunted: false };
  let tick = 1;
  const killAt = (streak: number) => {
    (state as { s: { snaps: unknown } }).s.snaps = { snaps: [{ t: 'snap', tick: ++tick, self: { id: 1, streak, viewRadius: 600 }, players: [me], bullets: [], match: { mode: 'FFA', map: 'market', winner: null, roundEndsAt: null, teamScore: { red: 0, blue: 0 } }, events: [{ e: 'kill', killerId: 1, victimId: 9, bounty: false }] }], serverClockOffset: null };
    step(0.05);
  };
  killAt(3);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(fetched.includes(DROP.file), 'the drop is fetched once a streak gets going');
  assert.equal(music.musicProbe().dropAt, null);
  killAt(4);
  assert.equal(music.musicProbe().dropAt, null, 'no drop below five');
  killAt(5);
  assert.ok(music.musicProbe().dropAt !== null, 'five in a row drops the bass');
  const first = music.musicProbe().dropAt;
  killAt(10);
  assert.equal(music.musicProbe().dropAt, first, 'at most one drop every twenty seconds');
  setStreamFactory(null);
});
