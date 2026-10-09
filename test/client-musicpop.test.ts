/// <reference types="node" />
/**
 * The map themes follow the songwriting rules in docs/music/CRAFT.md: one hook that keeps coming back, one four-chord loop, an arc that adds
 * voices as it builds, a change every eight bars, and the hooks of the game (stings in key, the night's heartbeat) still wired in.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chordOf, counterBars, FORM_BARS, hookBars, INTRO_BARS, isMotif, LOOP_BARS, motifOf, placeOf, popBar, SECTION_BARS, unswing, type Part, type PopSpec } from '../src/client/musicpop.ts';
import { THEMES } from '../src/client/musicthemes.ts';
import { hookDistance, isChordTone, type HookNote } from '../src/client/musichook.ts';
import { MAP_TRACK, TRACKS } from '../src/client/musictracks.ts';
import type { Bar, LayerId, Mode } from '../src/client/musictheory.ts';

const modeOf = (s: PopSpec): Mode => (s.night ? 'minor' : 'major');
const name = (s: PopSpec) => `${s.id}${s.night ? ' (night)' : ''}`;
const bar = (s: PopSpec, n: number, seed = 1) => popBar(s, seed, modeOf(s), n);
/** The hook as one layer sings it in a bar: one note per onset, at the steps as written. */
const sung = (s: PopSpec, b: Bar, layer: LayerId, inst = s.calm): HookNote[] => {
  const seen = new Map<number, HookNote>();
  for (const e of b.events) if (e.tag === 'hook' && e.layer === layer && e.inst === inst) { const step = unswing(s, e.step); if (!seen.has(step)) seen.set(step, { step, dur: e.dur, midi: e.midi }); }
  return [...seen.values()].sort((a, b) => a.step - b.step);
};
const loopBars = (s: PopSpec, cycle = 0) => Array.from({ length: LOOP_BARS }, (_, k) => bar(s, INTRO_BARS + cycle * LOOP_BARS + k));

test('every map but the Plaza plays a theme, and there are fifteen, the Outpost\'s night its own', () => {
  assert.equal(THEMES.length, 15);
  for (const [map, id] of Object.entries(MAP_TRACK)) {
    if (map === 'plaza') { assert.equal(TRACKS[id].voice, 'classic', 'the Plaza keeps the original march'); continue; }
    assert.ok(TRACKS[id].pop, `${map} plays a theme`);
  }
  assert.equal(TRACKS.outpost.pop!.minor.night, true);
  assert.equal(TRACKS.outpost.pop!.minor.tonic, TRACKS.outpost.pop!.major.tonic, 'day and night share a tonic, so the cadences fit both');
});

test('each theme has one hook: a 4-8 note motif in its first bar, stated again in its third, recurring at least twelve times a loop', () => {
  for (const s of THEMES) {
    const m = motifOf(s);
    assert.ok(m.length >= 4 && m.length <= 8, `${name(s)}: a motif of ${m.length} notes`);
    assert.ok(new Set(m.map((n) => n.dur)).size >= 2 || m.some((n) => n.step % 4 !== 0), `${name(s)}: the motif has a rhythm of its own, not even quarters`);
    const A = hookBars(s);
    assert.ok(isMotif(A[2]!, m), `${name(s)}: the third bar states the call again`);
    assert.ok(!isMotif(A[1]!, m) || !isMotif(A[3]!, m), `${name(s)}: the answers are not all the call`);
    // What a player hears: the calm layer sings the motif, bar after bar, through the loop.
    let calm = 0, fight = 0;
    for (const b of loopBars(s)) { if (isMotif(sung(s, b, 'calm'), m)) calm++; if (isMotif(sung(s, b, 'combat', s.lead).map((n) => ({ ...n, midi: n.midi })), m)) fight++; }
    assert.ok(calm >= 12, `${name(s)}: the motif is heard ${calm} times a loop in calm`);
    assert.ok(fight >= 10, `${name(s)}: and ${fight} times on the lead in a fight`);
  }
});

test('the hooks are singable and land: within an octave and a third, each answer ending on its chord', () => {
  for (const s of THEMES) {
    const A = hookBars(s);
    const all = A.flat().map((n) => n.midi);
    assert.ok(Math.max(...all) - Math.min(...all) <= 16, `${name(s)}: a range of ${Math.max(...all) - Math.min(...all)} semitones`);
    for (const k of [1, 3]) assert.ok(isChordTone(A[k]!.at(-1)!.midi, chordOf(s, k)), `${name(s)}: answer ${k} ends on a chord tone`);
    assert.equal(counterBars(s).length, 4);
  }
});

test('no two themes share an opening hook or a lead voice', () => {
  for (let i = 0; i < THEMES.length; i++) for (let j = i + 1; j < THEMES.length; j++) {
    const dist = hookDistance(hookBars(THEMES[i]!).slice(0, 2), hookBars(THEMES[j]!).slice(0, 2));
    assert.ok(dist >= 0.35, `${name(THEMES[i]!)} and ${name(THEMES[j]!)} open alike (${dist.toFixed(2)})`);
  }
  assert.equal(new Set(THEMES.map((s) => s.lead)).size, THEMES.length, 'every theme has its own lead');
  assert.equal(new Set(THEMES.map((s) => `${s.bpm} ${s.tonic} ${s.minor}`)).size, THEMES.length, 'and its own tempo and key');
});

// The proven loops, as semitones above the tonic and the chord's quality.
const PROGRESSIONS: Record<string, readonly string[]> = {
  'I-V-vi-IV': ['0M', '7M', '9m', '5M'], 'vi-IV-I-V': ['9m', '5M', '0M', '7M'], 'I-vi-IV-V': ['0M', '9m', '5M', '7M'], 'IV-V-iii-vi': ['5M', '7M', '4m', '9m'],
  'ii-V-I-vi': ['2m', '7M', '0M', '9m'], 'I-bVII-IV-I': ['0M', '10M', '5M', '0M'],
  'i-VI-III-VII': ['0m', '8M', '3M', '10M'], 'i-VII-VI-VII': ['0m', '10M', '8M', '10M'], 'i-VII-VI-V': ['0m', '10M', '8M', '7M'], 'i-VI-iv-V': ['0m', '8M', '5m', '7M'],
  'i-iv-VII-III': ['0m', '5m', '10M', '3M'], 'i-VI-VII-V': ['0m', '8M', '10M', '7M'], 'i-iv-VI-V': ['0m', '5m', '8M', '7M'],
};
test('each theme loops one proven four-chord progression, a chord a bar, all the way round', () => {
  for (const s of THEMES) {
    const want = PROGRESSIONS[s.progName];
    assert.ok(want, `${name(s)}: ${s.progName} is a known progression`);
    const got = s.prog.map((d) => `${d[0]}${d[1][1] === 3 ? 'm' : 'M'}`);
    assert.deepEqual(got, want, `${name(s)} plays ${s.progName}`);
    for (let n = 0; n < FORM_BARS * 2; n++) {
      const c = bar(s, n).chord;
      assert.deepEqual(c, chordOf(s, placeOf(n).barIn % 4), `${name(s)} bar ${n}`);
    }
    assert.equal(new Set(Array.from({ length: LOOP_BARS }, (_, k) => bar(s, INTRO_BARS + k).chord.rootPc + '/' + bar(s, INTRO_BARS + k).chord.tones.join())).size, new Set(want).size);
  }
});

/** Voices playing in a bar, every layer on but the night's heartbeat. */
const voices = (b: Bar, layers?: readonly LayerId[]) => new Set(b.events.filter((e) => e.layer !== 'heart' && (!layers || layers.includes(e.layer))).map((e) => `${e.layer}:${e.inst}`));
const partVoices = (s: PopSpec, part: Part, layers?: readonly LayerId[]) => {
  const all = new Set<string>();
  for (let n = 0; n < FORM_BARS; n++) if (placeOf(n).part === part) for (const v of voices(bar(s, n), layers)) all.add(v);
  return all.size;
};
test('the arc builds in layers: beat and pad, then the bass, then the hook and the groove, a thinner breakdown, and the drop the fullest', () => {
  for (const s of THEMES) {
    const v = (p: Part, l?: readonly LayerId[]) => partVoices(s, p, l);
    const calm: LayerId[] = ['calm'];
    assert.ok(v('intro', calm) < v('bassin', calm) && v('intro', calm) < v('hook', calm), `${name(s)}: calm voices ${v('intro', calm)} < ${v('bassin', calm)}, ${v('hook', calm)}`);
    assert.ok(v('intro') < v('bassin') && v('bassin') < v('hook') && v('hook') <= v('groove'), `${name(s)}: ${v('intro')} < ${v('bassin')} < ${v('hook')} <= ${v('groove')}`);
    assert.ok(v('breakdown') < v('hook'), `${name(s)}: the breakdown thins out (${v('breakdown')} against ${v('hook')})`);
    assert.ok(v('drop') >= v('hook'), `${name(s)}: the drop (${v('drop')}) is at least as full as the hook (${v('hook')})`);
    // The intro has no hook and no backbeat yet; the bass arrives in its second half; the drop opens on an impact after a riser.
    assert.equal(sung(s, bar(s, 0), 'calm').length, 0);
    assert.ok(bar(s, 0).events.every((e) => !(e.layer === 'calm' && e.inst === s.bassInst && e.midi < 60)), `${name(s)}: no bass in the first bars`);
    assert.ok(bar(s, 4).events.some((e) => e.layer === 'calm' && e.inst === s.bassInst), `${name(s)}: the bass comes in at bar 5`);
    assert.ok(bar(s, INTRO_BARS + 20).events.some((e) => e.inst === 'riser') && bar(s, INTRO_BARS + 24).events.some((e) => e.inst === 'impact'));
    assert.ok(bar(s, INTRO_BARS + 24).events.some((e) => e.layer === 'calm' && e.inst === s.dropInst), `${name(s)}: the drop's bass`);
  }
});

test('the music changes every eight bars: no section arranged like the last, a fill to close each, and the next time round different again', () => {
  const sig = (b: Bar) => JSON.stringify(b.events.filter((e) => e.layer !== 'heart').map((e) => [e.layer, e.inst, e.step]).sort());
  for (const s of THEMES) {
    for (let start = 0; start + SECTION_BARS < FORM_BARS; start += SECTION_BARS) {
      const a = Array.from({ length: SECTION_BARS }, (_, k) => sig(bar(s, start + k))).join('|');
      const b = Array.from({ length: SECTION_BARS }, (_, k) => sig(bar(s, start + SECTION_BARS + k))).join('|');
      assert.notEqual(a, b, `${name(s)}: bars ${start + 1}-${start + 16} are two different sections`);
    }
    for (let n = INTRO_BARS; n < FORM_BARS; n += SECTION_BARS) {
      const last = bar(s, n + 7), mid = bar(s, n + 3);
      assert.notEqual(sig(last), sig(mid), `${name(s)}: the section at bar ${n + 1} closes on a fill`);
    }
    assert.notEqual(loopBars(s, 0).map(sig).join(), loopBars(s, 1).map(sig).join(), `${name(s)}: the second time round is not the first`);
    // The tune and the chords never depend on the seed, only the fills do.
    const tune = (seed: number) => JSON.stringify(Array.from({ length: FORM_BARS }, (_, n) => sung(s, bar(s, n, seed), 'calm')));
    assert.equal(tune(1), tune(999));
    assert.notEqual(loopBars(s).map(sig).join(), Array.from({ length: LOOP_BARS }, (_, k) => sig(bar(s, INTRO_BARS + k, 4242))).join());
  }
});

test('the beat before the drop is silent but for the riser, and the drop of the trap and phonk themes goes half-time on an 808', () => {
  const phonk = THEMES.filter((s) => s.halfTimeDrop && [s.bassInst, s.dropInst].some((i) => i === 'b808' || i === 'b808d'));
  assert.ok(phonk.length >= 4, `the bass-drop themes: ${phonk.map(name).join(', ')}`);
  assert.ok(THEMES.some((s) => s.calm === 'cowbell' || s.counterInst === 'cowbell'), 'a phonk cowbell melody');
  assert.ok(phonk.some((s) => [s.bass, s.dropBass].some((r) => r.includes('~'))), 'with 808 glides');
  for (const s of THEMES) {
    const pre = bar(s, INTRO_BARS + 23);
    assert.ok(pre.events.every((e) => e.step < 12 || e.inst === 'riser'), `${name(s)}: a gap before the drop`);
    if (!s.halfTimeDrop) continue;
    const drop = bar(s, INTRO_BARS + 25);
    const back = drop.events.filter((e) => e.layer === 'combat' && e.inst === (typeof s.kit.snare === 'string' ? s.kit.snare : s.kit.snare[0]) && e.vel > 0.6).map((e) => e.step);
    assert.deepEqual(back, [8], `${name(s)}: the drop's backbeat is on beat three`);
    const slides = Array.from({ length: 8 }, (_, k) => bar(s, INTRO_BARS + 24 + k).events).flat().filter((e) => e.from !== undefined);
    if (s.dropBass.includes('~')) assert.ok(slides.length > 0, `${name(s)}: the 808 glides`);
  }
});

test('kill stings ring in key: every chord a theme plays is in its key, so a sting built on the bar\'s chord always fits', () => {
  for (const s of THEMES) {
    // The key's notes, with the minor's raised seventh (its major V) and the mixolydian's flat seventh.
    const key = new Set((s.minor ? [0, 2, 3, 5, 7, 8, 10, 11] : [0, 2, 4, 5, 7, 9, 10, 11]).map((p) => (p + s.tonic) % 12));
    for (let n = 0; n < FORM_BARS; n++) {
      const b = bar(s, n);
      for (const t of b.chord.tones) assert.ok(key.has((b.chord.rootPc + t) % 12), `${name(s)} bar ${n}: chord tone ${(b.chord.rootPc + t) % 12}`);
      assert.equal(b.tonic, s.tonic);
    }
  }
});

test('the Zombies night keeps its heartbeat tiers, and no day theme has one', () => {
  for (const s of THEMES) {
    const heart = bar(s, 12).events.filter((e) => e.layer === 'heart');
    if (!s.night) { assert.equal(heart.length, 0, name(s)); continue; }
    for (const tier of [0, 1, 2]) assert.ok(heart.some((e) => e.inst === 'heart' && e.tier === tier), `tier ${tier}`);
  }
});
