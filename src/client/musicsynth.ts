/**
 * The voices of the soundtrack: synthesized drums and voices, and sampled instruments (musicsamples.ts) wherever their samples have loaded.
 * Everything takes a BaseAudioContext, so the same rig plays live and renders offline (the offline render is how the mix is measured).
 */
import { LAYER_IDS, MID_C, midiToHz, STEPS_PER_BAR, type Bar, type Chord, type Inst, type LayerId, type Mode } from './musictheory.ts';
import { createVoices } from './musicvoices.ts';
import type { SampleBank } from './musicsamples.ts';

/** One track's set of layer gains. A map change crossfades between two decks; each fades under its own gain. */
export type Deck = { layers: Record<LayerId, GainNode>; trim: GainNode; fade: GainNode };

export type Rig = {
  ctx: BaseAudioContext;
  /**
   * A fresh deck for a track, with the track's loudness `trim`. Dispose it once it has faded out. A `raw` deck (a finished recording) skips the
   * synth's compressor and hall, which would squash and blur a mastered mix, but keeps the duck, the dead muffle and the volume.
   */
  newDeck(trim: number, raw?: boolean): Deck;
  disposeDeck(deck: Deck): void;
  /** Ducks the layers (not stings or cadences) for big sound effects. */
  duck: GainNode;
  /** The muffle used when you are dead: a lowpass whose cutoff the engine moves. */
  tone: BiquadFilterNode;
  /** The raw decks' own duck and muffle, moved with `duck` and `tone`. */
  rawDuck: GainNode;
  rawTone: BiquadFilterNode;
  /** Music volume and mute; the only node that meets the outside world. */
  volume: GainNode;
  /** Radio sounds (tune-in static, dial clicks): they skip the music's own gate so turning the radio Off still clicks. */
  fx: GainNode;
  /** Stings and cadences: after the duck, into the tone filter, so a big effect never ducks them. */
  direct: GainNode;
  /** The sampled instruments, if any: a note whose instrument has loaded plays the sample, any other the synth voice. */
  samples: SampleBank | null;
  playTuneIn(t: number): void;
  playBar(bar: Bar, t0: number, spb: number, heartTier: 0 | 1 | 2, deck: Deck): void;
  playSting(chord: Chord, mode: Mode, streak: number, t: number, bounty?: boolean, inst?: Inst): void;
  /** Plays the round's closing phrase in the key and returns how long it lasts, in seconds. */
  playCadence(kind: 'win' | 'loss', tonic: number, t: number): number;
};

const LEVEL: Partial<Record<Inst, number>> & Record<'kick' | 'snare' | 'hat' | 'tom' | 'bass' | 'pad' | 'glock' | 'stab' | 'lead' | 'heart', number> = { kick: 0.9, snare: 0.55, hat: 0.2, tom: 0.7, bass: 0.55, pad: 0.07, glock: 0.2, stab: 0.07, lead: 0.12, heart: 0.9 };

function makeNoise(ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let a = 12345;
  for (let i = 0; i < d.length; i++) { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; d[i] = a / 2147483648 - 1; }
  return buf;
}

/** A small hall: decaying noise, so brass and bells bloom. */
function makeReverb(ctx: BaseAudioContext): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 1.3);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let a = 777 + c * 91;
    for (let i = 0; i < len; i++) { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; d[i] = (a / 2147483648 - 1) * (1 - i / len) ** 2.6; }
  }
  return buf;
}

export function createRig(ctx: BaseAudioContext, out: AudioNode, samples: SampleBank | null = null): Rig {
  const noise = makeNoise(ctx);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.18;
  const volume = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass'; tone.frequency.value = 18000; tone.Q.value = 0.4;
  const duck = ctx.createGain();
  const sum = ctx.createGain();
  const direct = ctx.createGain(); // stings and cadences skip the duck
  const verb = ctx.createConvolver();
  verb.buffer = makeReverb(ctx);
  const verbIn = ctx.createGain();
  verbIn.gain.value = 0.22;
  const verbOut = ctx.createGain();
  verbOut.gain.value = 0.9;
  sum.connect(duck).connect(tone);
  direct.connect(tone);
  tone.connect(comp);
  tone.connect(verbIn).connect(verb).connect(verbOut).connect(comp);
  comp.connect(volume).connect(out);
  const fx = ctx.createGain();
  fx.gain.value = 1;
  fx.connect(out);
  // The recordings' path: their own duck and muffle, straight to the volume (no compressor, no hall).
  const rawSum = ctx.createGain();
  const rawDuck = ctx.createGain();
  const rawTone = ctx.createBiquadFilter();
  rawTone.type = 'lowpass'; rawTone.frequency.value = 18000; rawTone.Q.value = 0.4;
  rawSum.connect(rawDuck).connect(rawTone).connect(volume);

  function newDeck(trimGain: number, raw = false): Deck {
    const layers = {} as Record<LayerId, GainNode>;
    const trim = ctx.createGain();
    trim.gain.value = trimGain;
    const fade = ctx.createGain();
    trim.connect(fade).connect(raw ? rawSum : sum);
    for (const id of LAYER_IDS) { layers[id] = ctx.createGain(); layers[id].gain.value = 0; layers[id].connect(trim); }
    return { layers, trim, fade };
  }
  function disposeDeck(deck: Deck) {
    for (const id of LAYER_IDS) deck.layers[id].disconnect();
    deck.trim.disconnect(); deck.fade.disconnect();
  }

  const env = (dest: AudioNode, t: number, peak: number, attack: number, hold: number, release: number) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    g.connect(dest);
    return g;
  };
  const osc = (type: OscillatorType, hz: number, t: number, end: number, dest: AudioNode, detune = 0) => {
    const o = ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(hz, t); o.detune.value = detune;
    o.connect(dest); o.start(t); o.stop(end);
    return o;
  };
  const noiseHit = (t: number, dur: number, type: BiquadFilterType, hz: number, q: number, peak: number, dest: AudioNode) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = hz; f.Q.value = q;
    const g = env(dest, t, peak, 0.002, 0, dur);
    src.connect(f).connect(g);
    src.start(t, (t * 7.31) % 0.5, dur + 0.05);
  };

  function kick(t: number, v: number, dest: AudioNode) {
    const g = env(dest, t, LEVEL.kick * v, 0.002, 0.02, 0.2);
    const o = osc('sine', 150, t, t + 0.3, g);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.13);
    noiseHit(t, 0.02, 'highpass', 2500, 0.5, 0.15 * v, dest);
  }
  function snare(t: number, v: number, dest: AudioNode) {
    noiseHit(t, 0.12, 'bandpass', 2400, 0.7, LEVEL.snare * v, dest);
    noiseHit(t, 0.07, 'highpass', 5000, 0.4, LEVEL.snare * 0.4 * v, dest);
    const g = env(dest, t, 0.25 * v, 0.001, 0.01, 0.07);
    osc('triangle', 210, t, t + 0.12, g);
  }
  function hat(t: number, v: number, dest: AudioNode) { noiseHit(t, 0.045, 'highpass', 7500, 0.6, LEVEL.hat * v, dest); }
  function tom(t: number, midi: number, v: number, dest: AudioNode) {
    const hz = midiToHz(midi);
    const g = env(dest, t, LEVEL.tom * v, 0.002, 0.03, 0.26);
    const o = osc('sine', hz * 1.6, t, t + 0.4, g);
    o.frequency.exponentialRampToValueAtTime(hz, t + 0.09);
    noiseHit(t, 0.03, 'bandpass', 900, 1, 0.12 * v, dest);
  }
  function bass(t: number, midi: number, dur: number, v: number, dest: AudioNode) {
    const hz = midiToHz(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(1400, t); f.frequency.exponentialRampToValueAtTime(260, t + Math.min(0.2, dur));
    const g = env(dest, t, LEVEL.bass * v, 0.004, Math.max(0, dur * 0.6), dur * 0.5 + 0.06);
    f.connect(g);
    osc('square', hz, t, t + dur * 1.2 + 0.1, f);
    osc('triangle', hz, t, t + dur * 1.2 + 0.1, g);
  }
  function pad(t: number, midi: number, dur: number, v: number, dest: AudioNode) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 1500;
    const g = env(dest, t, LEVEL.pad * v, 0.2, Math.max(0, dur - 0.5), 0.4);
    f.connect(g);
    osc('triangle', midiToHz(midi), t, t + dur + 0.7, f, -5);
    osc('triangle', midiToHz(midi), t, t + dur + 0.7, f, 5);
  }
  function glock(t: number, midi: number, v: number, dest: AudioNode) {
    const hz = midiToHz(midi);
    const g = env(dest, t, LEVEL.glock * v, 0.001, 0.005, 0.9);
    osc('sine', hz, t, t + 1, g);
    const g2 = env(dest, t, LEVEL.glock * 0.35 * v, 0.001, 0.003, 0.35);
    osc('sine', hz * 2.76, t, t + 0.5, g2);
    const g3 = env(dest, t, LEVEL.glock * 0.15 * v, 0.001, 0.002, 0.15);
    osc('sine', hz * 5.4, t, t + 0.3, g3);
  }
  /** A brass note: detuned saws through a filter that blooms on the attack. `dark` makes it the muted night horn. */
  function brass(t: number, midi: number, dur: number, v: number, level: number, dark: boolean, dest: AudioNode, vibrato = true) {
    const hz = midiToHz(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = dark ? 1 : 2.5;
    const top = dark ? 1500 : 3600;
    f.frequency.setValueAtTime(dark ? 500 : 900, t);
    f.frequency.linearRampToValueAtTime(top, t + 0.06);
    f.frequency.exponentialRampToValueAtTime(dark ? 800 : 1500, t + Math.max(0.1, dur));
    const g = env(dest, t, level * v, 0.015, Math.max(0, dur - 0.05), 0.09);
    f.connect(g);
    const end = t + dur + 0.2;
    const a = osc('sawtooth', hz, t, end, f, -7);
    const b = osc('sawtooth', hz, t, end, f, 7);
    osc('square', hz, t, end, f);
    if (vibrato && dur > 0.35) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 5.2; depth.gain.setValueAtTime(0, t); depth.gain.linearRampToValueAtTime(7, t + dur * 0.8);
      lfo.connect(depth); depth.connect(a.detune); depth.connect(b.detune);
      lfo.start(t); lfo.stop(end);
    }
  }
  function heart(t: number, v: number, dest: AudioNode) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 140;
    const g = env(dest, t, LEVEL.heart * v, 0.004, 0.02, 0.16);
    f.connect(g);
    const o = osc('sine', 78, t, t + 0.3, f);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.12);
  }
  function pedal(t: number, midi: number, dur: number, v: number, dest: AudioNode) {
    const g = env(dest, t, 0.32 * v, 0.4, Math.max(0, dur - 0.8), 0.5);
    osc('sine', midiToHz(midi), t, t + dur + 1, g);
  }

  const extra = createVoices({ ctx, noise, env, osc });

  function playBar(bar: Bar, t0: number, spb: number, heartTier: 0 | 1 | 2, deck: Deck) {
    const step = (spb * 4) / STEPS_PER_BAR;
    const dark = bar.mode === 'minor';
    for (const e of bar.events) {
      if (e.tier !== undefined && e.tier > heartTier) continue;
      const t = t0 + e.step * step;
      const dest = deck.layers[e.layer];
      const dur = e.dur * step;
      const sampled = samples?.voice(e.inst);
      if (sampled) { sampled(t, e.midi, dur, e.vel, dest); continue; }
      switch (e.inst) {
        case 'kick': kick(t, e.vel, dest); break;
        case 'snare': snare(t, e.vel, dest); break;
        case 'hat': hat(t, e.vel, dest); break;
        case 'tom': tom(t, e.midi, e.vel, dest); break;
        case 'bass': if (e.layer === 'heart') pedal(t, e.midi, dur, e.vel, dest); else bass(t, e.midi, dur, e.vel, dest); break;
        case 'pad': pad(t, e.midi, dur, e.vel, dest); break;
        case 'glock': glock(t, e.midi, e.vel, dest); break;
        case 'stab': brass(t, e.midi, step * 0.9, e.vel, LEVEL.stab, dark, dest, false); break;
        case 'lead': brass(t, e.midi, dur, e.vel, LEVEL.lead * (e.layer === 'finale' ? 0.8 : 1), dark, dest); break;
        case 'heart': heart(t, e.vel, dest); break;
        default: extra[e.inst]?.(t, e.midi, dur, e.vel, dest);
      }
    }
  }

  /** Chord tones climbing from the chord's root, so a kill rings in the key the march is in. */
  function playSting(chord: Chord, mode: Mode, streak: number, t: number, bounty = false, inst: Inst = 'glock') {
    const sampled = samples?.voice(inst);
    const bell = (tt: number, m: number, v: number) => (sampled ? sampled(tt, m, 0.3, v, direct) : inst === 'glock' ? glock(tt, m, v, direct) : extra[inst]?.(tt, m, 0.3, v, direct) ?? glock(tt, m, v, direct));
    const root = MID_C + 12 + ((chord.rootPc - 0) % 12);
    const climb: number[] = [];
    const count = 3 + Math.min(3, Math.max(0, streak - 1));
    for (let k = 0; k < count; k++) climb.push(root + chord.tones[k % chord.tones.length]! + 12 * Math.floor(k / chord.tones.length));
    climb.forEach((m, k) => {
      const tt = t + k * 0.055;
      bell(tt, m, 0.9);
      const g = env(direct, tt, 0.05, 0.004, 0.02, 0.14);
      osc('square', midiToHz(m - 12), tt, tt + 0.25, g);
    });
    const last = climb[climb.length - 1]!;
    brass(t + (count - 1) * 0.055, last - 12, 0.28, 1, 0.09, mode === 'minor', direct, false);
    if (bounty) { bell(t + count * 0.055, last + 12, 1); bell(t + count * 0.055 + 0.07, last + 19, 0.8); }
  }

  function playCadence(kind: 'win' | 'loss', tonic: number, t: number): number {
    const base = 48 + tonic; // tonic around C3
    const triad = (r: number, minor: boolean) => [r, r + (minor ? 3 : 4), r + 7];
    if (kind === 'win') {
      const spb = 60 / 138;
      // Pickup: V triplet, then a big I with the bells running up over it.
      for (let k = 0; k < 3; k++) for (const m of triad(base + 7 + 12, false)) brass(t + k * spb * 0.5, m, spb * 0.45, 1, 0.1, false, direct, false);
      const hit = t + spb * 2;
      for (const r of [base, base + 12, base + 24]) for (const m of triad(r, false)) brass(hit, m, spb * 3, 1, 0.07, false, direct);
      kick(hit, 1, direct); snare(hit, 1, direct); tom(hit, 41, 1, direct);
      noiseHit(hit, 1.4, 'highpass', 6500, 0.4, 0.2, direct);
      for (let k = 0; k < 8; k++) tom(t + k * spb * 0.25, 48 + (k % 2) * 3, 0.5 + k * 0.07, direct);
      const run = [0, 4, 7, 12, 16, 19, 24, 28, 31];
      run.forEach((s, k) => glock(hit + k * 0.06, MID_C + 12 + tonic + s, 0.9, direct));
      glock(hit + 0.6, MID_C + 12 + tonic + 36, 1, direct);
      return spb * 6;
    }
    // Loss: a sad trombone, wah wah wah waaah, down a semitone each time, then a minor chord falling away.
    const spb = 60 / 76;
    const start = 55 + tonic;
    const notes = [start, start - 1, start - 2, start - 3];
    notes.forEach((m, k) => {
      const tt = t + k * spb * 0.8;
      const last = k === 3;
      const dur = last ? spb * 2.6 : spb * 0.7;
      const hz = midiToHz(m);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.Q.value = 3;
      f.frequency.setValueAtTime(350, tt);
      f.frequency.linearRampToValueAtTime(1500, tt + 0.12);
      f.frequency.exponentialRampToValueAtTime(380, tt + dur);
      const g = env(direct, tt, 0.13, 0.03, dur - 0.1, 0.12);
      f.connect(g);
      for (const d of [-6, 6]) {
        const o = osc('sawtooth', hz, tt, tt + dur + 0.2, f, d);
        o.frequency.setValueAtTime(hz, tt);
        o.frequency.linearRampToValueAtTime(hz * 0.97, tt + dur * (last ? 0.5 : 1));
        if (last) o.frequency.exponentialRampToValueAtTime(hz * 0.84, tt + dur);
        if (last) {
          const lfo = ctx.createOscillator(); const depth = ctx.createGain();
          lfo.frequency.value = 5.5; depth.gain.value = 22; lfo.connect(depth).connect(o.detune); lfo.start(tt + 0.5); lfo.stop(tt + dur + 0.2);
        }
      }
    });
    const chordAt = t + spb * 2.4;
    for (const m of triad(base - 12 + 12, true)) pad(chordAt, m, spb * 3, 3, direct);
    for (const m of triad(base, true)) brass(chordAt, m, spb * 2.6, 1, 0.05, true, direct);
    tom(chordAt, 38, 0.9, direct);
    return spb * 6;
  }

  /** A radio being tuned: static swept across the band in crackling bursts, with a dial click either end. */
  function playTuneIn(t: number) {
    const click = (tt: number, hz: number) => {
      const g = env(fx, tt, 0.22, 0.001, 0, 0.03);
      osc('square', hz, tt, tt + 0.06, g);
      noiseHit(tt, 0.02, 'highpass', 3000, 0.5, 0.12, fx);
    };
    click(t, 1500);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(700, t); f.frequency.exponentialRampToValueAtTime(3600, t + 0.12); f.frequency.exponentialRampToValueAtTime(1100, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    // Crackle: the static is gated in short bursts that thin out as the station comes in.
    // About a quarter of a second: a sweep across the dial while the old station drops out and the new one comes in under it.
    for (let i = 0; i < 6; i++) {
      const a = t + 0.01 + i * 0.04;
      g.gain.setValueAtTime(0.0001, a);
      g.gain.linearRampToValueAtTime(0.2 * (1 - i / 8), a + 0.005);
      g.gain.setValueAtTime(0.2 * (1 - i / 8), a + 0.022);
      g.gain.exponentialRampToValueAtTime(0.0001, a + 0.036);
    }
    src.connect(f).connect(g).connect(fx);
    src.start(t, 0, 0.3); src.stop(t + 0.3);
    click(t + 0.25, 1100);
  }

  return { ctx, newDeck, disposeDeck, duck, tone, rawDuck, rawTone, volume, fx, direct, samples, playTuneIn, playBar, playSting, playCadence };
}
