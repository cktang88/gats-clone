import { EVOLUTIONS, GUN_IDS, GUNS, MEDALS, STREAK, ZOM, type MedalTier, type GunId, type TurretKind, type WeaponId } from '../shared/defs.ts';
import { planeAt, type Snapshot } from '../shared/protocol.ts';
import { selfOf } from './derive.ts';
import { TICK_MS } from './interp.ts';
import { ringMoved } from './royale.ts';
import { FOLEY, actionCycle, type FoleyId } from './foley.ts';

export type SoundId =
  | `shot:${GunId}` | 'shot:silenced' | FoleyId
  | 'hit' | 'hurt' | 'boom' | 'slash' | 'kill' | `kill:${KillStep}` | `medal:${MedalTier}` | 'fanfare' | 'bounty' | 'death' | 'levelup' | 'evolve' | 'perk' | 'click' | 'notReady'
  | 'bite' | 'splat' | 'wallHit' | 'wallUp' | 'wallDown' | 'coreHit' | 'horn' | 'chime' | 'downed' | 'revived' | `turret:${TurretKind}`
  | 'build:wood' | 'build:sandbag' | 'build:steel' | 'build:spikes' | 'upgrade' | 'aid:depot' | 'aid:post'
  | 'knock' | 'ring' | 'step' | 'stepSprint' | 'tink' | 'spawn' | 'impact:flesh' | 'impact:wall' | 'impact:crate' | 'impact:zombie'
  | 'barrel:hurt' | 'barrel:fuse' | 'barrel:burst' | 'barrel:chain'
  | 'prop:whoosh' | 'prop:hiss' | 'prop:zap' | 'prop:fire' | 'prop:glass' | 'prop:pickup' | 'prop:splat'
  | 'plane' | 'chute' | 'crate:land' | 'crate:break' | 'crate:gold' | 'crate:supply'
  | 'flashbang' | 'flashRing' | 'smoke' | 'slowmo:in' | 'slowmo:out' | 'emote' | 'confetti' | 'firework'
  | 'amb:flutter' | 'amb:caw' | 'amb:gull'
  | 'zone:tick' | 'zone:taken' | 'zone:lost' | 'zone:contest';

/** Each kill in a streak sounds two semitones above the last, up to the fifth. */
export type KillStep = 2 | 3 | 4 | 5;
const KILL_STEPS: readonly KillStep[] = [2, 3, 4, 5];

type Wave = 'sine' | 'square' | 'sawtooth' | 'triangle';
/** `selfOnly` layers (shell casings, bolt clacks) are only heard from your own gun, so a distant firefight is not a pile of tinkles. */
type Timing = { ms: number; gain: number; delayMs?: number; attackMs?: number; selfOnly?: true };
export type Layer =
  | ({ src: 'tone'; wave: Wave; pitchHz: readonly [number, number] } & Timing)
  | ({ src: 'noise'; filter: 'lowpass' | 'highpass' | 'bandpass'; q: number; cutoffHz: readonly [number, number] } & Timing);
type Recipe = readonly Layer[];

const crack = (cutoffHz: number, ms: number, gain: number): Layer => ({ src: 'noise', filter: 'bandpass', q: 0.9, cutoffHz: [cutoffHz, cutoffHz * 0.4], ms, gain });
const thump = (pitchHz: number, ms: number, gain: number): Layer => ({ src: 'tone', wave: 'triangle', pitchHz: [pitchHz, pitchHz * 0.35], ms, gain });
const note = (pitchHz: number, delayMs: number, ms = 110, gain = 0.25): Layer => ({ src: 'tone', wave: 'square', pitchHz: [pitchHz, pitchHz], ms, gain, delayMs });
const bell = (pitchHz: number, delayMs: number, ms: number, gain: number): Layer => ({ src: 'tone', wave: 'triangle', pitchHz: [pitchHz, pitchHz * 0.996], ms, gain, delayMs });
/** A pure sine ping: the glassy top of a chime or the ring of struck metal. */
const ping = (hz: number, delayMs: number, ms: number, gain: number): Layer => ({ src: 'tone', wave: 'sine', pitchHz: [hz, hz * 0.997], ms, gain, delayMs });
/** A 3-8 ms burst of bright noise: the transient click that makes a shot or a hit feel like it has an edge. */
const snap = (hz: number, gain: number, delayMs = 0, ms = 8): Layer => ({ src: 'noise', filter: 'highpass', q: 0.7, cutoffHz: [hz, hz], ms, gain, delayMs });
const air = (hz0: number, hz1: number, ms: number, gain: number, delayMs = 0): Layer => ({ src: 'noise', filter: 'lowpass', q: 0.7, cutoffHz: [hz0, hz1], ms, gain, delayMs });
const shimmer = (ms: number, gain: number, delayMs: number): Layer => ({ src: 'noise', filter: 'highpass', q: 0.8, cutoffHz: [6500, 10000], ms, gain, delayMs });
/** A rising air sweep: the whoosh under a level-up or evolution. */
const whoosh = (from: number, to: number, ms: number, gain: number, delayMs = 0): Layer => ({ src: 'noise', filter: 'bandpass', q: 1.6, cutoffHz: [from, to], ms, gain, delayMs });

/** Little glints scattered over a span, at fixed pseudo-random times and pitches so a cue is always the same cue. */
function sparkles(n: number, fromMs: number, spanMs: number, baseHz: number, gain: number): Layer[] {
  const out: Layer[] = [];
  for (let i = 0; i < n; i++) {
    const r = (Math.sin(i * 12.9898 + baseHz) * 43758.5453) % 1, q = Math.abs(r);
    out.push(ping(baseHz * (1 + Math.floor(q * 5) / 4), fromMs + (i / n) * spanMs + q * 30, 120 + q * 160, gain * (1 - 0.5 * i / n)));
  }
  return out;
}

/**
 * A real gunshot, layer by layer: a 4 ms supersonic crack (high-passed noise), the muzzle blast body (a pitch-dropping sine thump
 * under a low-passed noise burst), a mid "bark" that gives the class its character, a quiet mechanical action (own gun only),
 * a falling brass tinkle (own gun only) and a multi-tap reflection tail (delayed low-passed noise, no convolver). The heavier
 * the class the lower and longer the body and the tail. Only a silenced gun is allowed to be small (see SILENCED below).
 */
type Tap = readonly [delayMs: number, ms: number, gain: number];
type ShotSpec = {
  crack: readonly [hz: number, gain: number];
  body: readonly [hz0: number, hz1: number, ms: number, gain: number];
  blast: readonly [hz0: number, hz1: number, ms: number, gain: number];
  bark: readonly [hz0: number, hz1: number, ms: number, gain: number];
  taps: readonly Tap[];
  action: readonly [hz: number, delayMs: number, gain: number];
  brassHz: number;
};
const SHOT_SPECS: Record<WeaponId, ShotSpec> = {
  pistol: { crack: [3000, 0.5], body: [165, 60, 90, 0.6], blast: [1600, 300, 70, 0.8], bark: [1400, 700, 50, 0.6], taps: [[25, 150, 0.13], [90, 200, 0.06]], action: [1700, 60, 0.12], brassHz: 3200 },
  smg: { crack: [3200, 0.3], body: [185, 70, 65, 0.85], blast: [1100, 260, 50, 0.7], bark: [900, 520, 40, 0.38], taps: [[18, 110, 0.1], [60, 140, 0.04]], action: [1900, 40, 0.1], brassHz: 3600 },
  assault: { crack: [3200, 0.6], body: [135, 52, 115, 0.65], blast: [1300, 250, 90, 0.9], bark: [1000, 550, 70, 0.7], taps: [[30, 230, 0.17], [110, 300, 0.08]], action: [1500, 70, 0.12], brassHz: 3000 },
  lmg: { crack: [2800, 0.5], body: [112, 46, 135, 0.7], blast: [1050, 200, 110, 1], bark: [800, 420, 80, 0.7], taps: [[35, 320, 0.2], [130, 430, 0.1]], action: [1300, 80, 0.12], brassHz: 2600 },
  shotgun: { crack: [2200, 0.8], body: [90, 36, 230, 0.8], blast: [1100, 140, 190, 1.1], bark: [700, 300, 120, 1], taps: [[40, 420, 0.22], [170, 520, 0.1]], action: [1200, 430, 0.18], brassHz: 2300 },
  sniper: { crack: [3500, 1.2], body: [85, 34, 270, 0.8], blast: [1000, 150, 210, 1], bark: [850, 350, 130, 0.9], taps: [[150, 450, 0.2], [330, 600, 0.12]], action: [1100, 540, 0.18], brassHz: 2600 },
};

function gunShot(s: ShotSpec, k: number, w: number, cycle: Layer[] | null = null): Layer[] {
  const g = w ** 1.5;
  const [cHz, cGain] = s.crack, [b0, b1, bMs, bGain] = s.body, [l0, l1, lMs, lGain] = s.blast, [r0, r1, rMs, rGain] = s.bark;
  return [
    { src: 'noise', filter: 'highpass', q: 0.7, cutoffHz: [cHz * k, cHz * k], ms: 4, gain: cGain * g },
    { src: 'tone', wave: 'sine', pitchHz: [b0 * k, b1 * k], ms: bMs * w, gain: bGain * g },
    { src: 'noise', filter: 'lowpass', q: 0.8, cutoffHz: [l0 * k, l1 * k], ms: lMs * w, gain: lGain * g },
    { src: 'noise', filter: 'bandpass', q: 0.9, cutoffHz: [r0 * k, r1 * k], ms: rMs * w, gain: rGain * g },
    ...s.taps.map(([d, ms, gain]): Layer => ({ src: 'noise', filter: 'lowpass', q: 0.7, cutoffHz: [650 * k, 170 * k], ms: ms * w, gain: gain * g, delayMs: d })),
    // A bolt-action or a pump works its action by hand (see `actionCycle`); every other gun just clacks.
    ...(cycle ?? [{ src: 'noise', filter: 'bandpass', q: 2, cutoffHz: [s.action[0], s.action[0] * 0.6], ms: 12, gain: s.action[2], delayMs: s.action[1], selfOnly: true } as Layer]),
    { ...ping(s.brassHz, 230, 70, 0.03), selfOnly: true },
  ];
}

/** The silenced "thup": a low-passed puff, a soft low thump and a mechanical click. No crack, nothing above a muffle. */
const silencedShot = (k: number): Layer[] => [
  { src: 'noise', filter: 'lowpass', q: 0.8, cutoffHz: [900 * k, 220 * k], ms: 55, gain: 0.4 },
  { src: 'tone', wave: 'sine', pitchHz: [150 * k, 70 * k], ms: 50, gain: 0.3 },
  { src: 'noise', filter: 'bandpass', q: 1.5, cutoffHz: [1500 * k, 900 * k], ms: 10, gain: 0.1, delayMs: 14 },
];

const BRANCH_PITCH = [[0.84, 1.18], [0.92, 1.09]] as const;

function pitchOf(gun: GunId): number {
  const { from, stage } = GUNS[gun];
  if (!from) return 1;
  return pitchOf(from) * (BRANCH_PITCH[stage - 1]?.[EVOLUTIONS[from].indexOf(gun)] ?? 1);
}

/** How heavy a gun sounds next to its class gun, from its damage per round: a hand cannon is weightier than a pistol, a hornet lighter than an SMG. */
const weightOf = (gun: GunId): number => Math.max(0.85, Math.min(1.2, (GUNS[gun].damage / GUNS[GUNS[gun].base as GunId].damage) ** 0.15));

function shotRecipe(gun: GunId): Recipe {
  const g = GUNS[gun];
  const w = weightOf(gun);
  // The branch pitch only nudges (a fifth root-ish): a real gun family sounds like one family.
  const k = pitchOf(gun) ** 0.4 / w;
  if (g.silenced) return silencedShot(k);
  const layers = gunShot(SHOT_SPECS[g.base], k, w, actionCycle(g.base, g.fireMs, g.mag));
  if (g.blast) layers.push({ src: 'tone', wave: 'sine', pitchHz: [70 * k, 26 * k], ms: 260, gain: 0.5 });
  if (g.pellets > 1 && g.base !== 'shotgun') layers.push({ src: 'tone', wave: 'sine', pitchHz: [120 * k, 50 * k], ms: 70, gain: 0.5, delayMs: 14 });
  return layers;
}

/** The "ka-ching" of a kill: a register bell and a spill of coin glints, bigger the longer the streak. */
const ching = (size: number): Layer[] => [
  ping(2637, 40, 360, 0.16 * size), ping(3951, 60, 420, 0.12 * size), ping(5274, 90, 300, 0.07 * size),
  snap(7000, 0.12 * size, 40, 25), ...sparkles(Math.round(3 * size), 110, 220, 3136, 0.05 * size),
];

function killSteps(): Record<`kill:${KillStep}`, Recipe> {
  const out: Partial<Record<`kill:${KillStep}`, Recipe>> = {};
  for (const n of KILL_STEPS) {
    const k = 2 ** (((n - 1) * 2) / 12);
    // From the third kill a high third note joins, so a streak sounds like it is climbing to something.
    out[`kill:${n}`] = [note(880 * k, 0), note(1320 * k, 70, 160), ...(n >= 3 ? [note(1760 * k, 140, 200, 0.2)] : []), ...ching(1 + (n - 1) * 0.15)];
  }
  return out as Record<`kill:${KillStep}`, Recipe>;
}

function shotSounds(): Record<`shot:${GunId}`, Recipe> {
  const out: Partial<Record<`shot:${GunId}`, Recipe>> = {};
  for (const id of GUN_IDS) out[`shot:${id}`] = shotRecipe(id);
  return out as Record<`shot:${GunId}`, Recipe>;
}

const mechClick = (hz: number, delayMs: number, gain = 0.25): Layer[] => [snap(hz, gain, delayMs, 14), { src: 'tone', wave: 'square', pitchHz: [hz / 5, hz / 9], ms: 22, gain: gain * 0.45, delayMs }];
const thunk = (hz: number, delayMs: number, gain = 0.3): Layer => ({ src: 'tone', wave: 'triangle', pitchHz: [hz, hz * 0.5], ms: 70, gain, delayMs });

// The reload's own sounds (mag out, rack, bolt, pump...) are `FOLEY` in foley.ts, fired by reloadsfx.ts on the animation's beats.

/** The debris of a blast pattering back down: short filtered bursts, thinning out. */
const debris = (n: number, fromMs: number, spanMs: number, gain: number): Layer[] => {
  const out: Layer[] = [];
  for (let i = 0; i < n; i++) {
    const q = Math.abs((Math.sin(i * 78.233 + 3) * 43758.5453) % 1), t = i / n;
    out.push({ src: 'noise', filter: 'bandpass', q: 3, cutoffHz: [1800 + q * 3000, 900 + q * 1200], ms: 25 + q * 40, gain: gain * (1 - 0.7 * t), delayMs: fromMs + t * spanMs + q * 40 });
  }
  return out;
};

/** Scales a recipe's loudness, for sounds that measured too quiet against the stings. */
const louder = (recipe: Recipe, k: number): Recipe => recipe.map((l) => ({ ...l, gain: Math.min(1, l.gain * k) }));

/** Bright little ticks at fixed pseudo-random pitches and times: sizzling fuse, firework crackle. */
function crackle(n: number, fromMs: number, spanMs: number, gain: number, lowHz = 5000): Layer[] {
  const out: Layer[] = [];
  for (let i = 0; i < n; i++) {
    const q = Math.abs((Math.sin(i * 39.346 + lowHz) * 43758.5453) % 1), t = i / n;
    out.push(snap(lowHz + q * 4000, gain * (1 - 0.65 * t) * (0.6 + 0.4 * q), fromMs + t * spanMs + q * (spanMs / n), 6 + q * 6));
  }
  return out;
}

/** The plane's drone is this long and swells to its peak this far in; the cue is delayed so the peak is the pass over the drop point. */
export const PLANE_MS = 7000;
export const PLANE_PEAK_MS = 3000;

const MEDAL_CHORD = [1568, 1976, 2349, 3136];

const RAW: Record<SoundId, Recipe> = {
  ...shotSounds(),
  ...FOLEY,
  'shot:silenced': silencedShot(1),
  // Your own hit: a crunchy tick (click + crunch + glassy ping) over a flesh thock.
  hit: louder([snap(5000, 0.3, 0, 10), { src: 'tone', wave: 'square', pitchHz: [1500, 700], ms: 45, gain: 0.16 }, { src: 'noise', filter: 'bandpass', q: 1.5, cutoffHz: [3800, 1500], ms: 55, gain: 0.3 }, ping(2400, 0, 80, 0.12), thump(210, 70, 0.3)], 2),
  'impact:flesh': louder([{ src: 'noise', filter: 'bandpass', q: 1, cutoffHz: [1400, 400], ms: 70, gain: 0.35 }, thump(190, 60, 0.3)], 1.6),
  'impact:wall': louder([snap(5500, 0.35, 0, 6), ping(2800, 0, 160, 0.14), ping(4100, 0, 90, 0.06),
    { src: 'tone', wave: 'sine', pitchHz: [3400, 900], ms: 180, gain: 0.07, delayMs: 25 }, { ...ping(2300, 70, 110, 0.04) }], 1.6),
  'impact:crate': louder([{ src: 'tone', wave: 'triangle', pitchHz: [320, 150], ms: 80, gain: 0.5 }, { src: 'noise', filter: 'bandpass', q: 2, cutoffHz: [1100, 500], ms: 50, gain: 0.35 }, ping(780, 0, 60, 0.08)], 1.6),
  'impact:zombie': louder([{ src: 'noise', filter: 'bandpass', q: 1.3, cutoffHz: [800, 160], ms: 120, gain: 0.4 }, { src: 'tone', wave: 'triangle', pitchHz: [240, 60], ms: 100, gain: 0.25 }, { src: 'noise', filter: 'lowpass', q: 4, cutoffHz: [500, 150], ms: 160, gain: 0.18, delayMs: 30 }], 1.6),
  hurt: [{ src: 'tone', wave: 'sawtooth', pitchHz: [220, 90], ms: 140, gain: 0.3 }, { src: 'noise', filter: 'lowpass', q: 1, cutoffHz: [800, 200], ms: 120, gain: 0.3 }],
  boom: [
    { src: 'tone', wave: 'sine', pitchHz: [62, 28], ms: 1000, gain: 0.95 },
    { src: 'noise', filter: 'lowpass', q: 0.7, cutoffHz: [1600, 60], ms: 700, gain: 0.9 }, thump(90, 500, 0.8),
    snap(2500, 0.4, 0, 20), crack(1200, 160, 0.5),
    air(500, 70, 950, 0.25, 120),
    ...debris(9, 180, 620, 0.2), ping(2200, 260, 90, 0.04), ping(3100, 420, 70, 0.03),
  ],
  // A flashbang: a hard white crack, then (for whoever it caught) a thin tinnitus ring that rings out under the muffled mix. Smoke is a long soft hiss.
  flashbang: [snap(3200, 0.7, 0, 22), crack(4200, 120, 0.7), { src: 'tone', wave: 'sine', pitchHz: [220, 70], ms: 260, gain: 0.5 }, air(3000, 400, 420, 0.3, 10), ping(5200, 20, 500, 0.06)],
  flashRing: [ping(3900, 0, 2600, 0.16), ping(4310, 0, 2200, 0.08), ping(7800, 30, 1400, 0.04)],
  smoke: [{ src: 'noise', filter: 'bandpass', q: 0.7, cutoffHz: [2600, 900], ms: 900, gain: 0.3, attackMs: 60 }, thump(120, 220, 0.3), air(1500, 300, 700, 0.12, 80)],
  slash: [
    { src: 'noise', filter: 'bandpass', q: 2.5, cutoffHz: [5200, 1400], ms: 150, gain: 0.55 },
    { src: 'tone', wave: 'triangle', pitchHz: [1100, 500], ms: 60, gain: 0.12, delayMs: 50 },
  ],
  kill: [note(880, 0), note(1320, 70, 160), ...ching(1)],
  // A medal rings like struck metal, brighter and fuller up the tiers.
  'medal:bronze': [bell(1047, 0, 380, 0.16), bell(1568, 60, 300, 0.1), ping(2093, 30, 260, 0.06), ...sparkles(2, 120, 150, 3136, 0.04)],
  'medal:silver': [bell(1175, 0, 420, 0.17), bell(1760, 70, 360, 0.12), bell(2349, 140, 300, 0.08), ping(3520, 60, 360, 0.06), ...sparkles(4, 150, 250, 3520, 0.05)],
  'medal:gold': [bell(1319, 0, 520, 0.2), bell(1661, 80, 480, 0.15), bell(1976, 160, 520, 0.14), ping(2637, 40, 600, 0.08), ping(3951, 240, 500, 0.06),
    { src: 'noise', filter: 'highpass', q: 0.8, cutoffHz: [7000, 9000], ms: 420, gain: 0.08, delayMs: 160 }, whoosh(600, 5000, 260, 0.1), ...sparkles(6, 200, 350, 3951, 0.05)],
  // Platinum is an event: a sub swell under a rising whoosh, a six-bell run, a held shimmering chord and a shower of glints.
  'medal:platinum': [
    { src: 'tone', wave: 'sine', pitchHz: [98, 196], ms: 900, gain: 0.35, attackMs: 40 },
    whoosh(300, 7000, 380, 0.16),
    bell(1047, 0, 700, 0.18), bell(1319, 70, 700, 0.17), bell(1568, 140, 760, 0.18), bell(1976, 210, 800, 0.17),
    ...MEDAL_CHORD.map((hz, i) => ping(hz, 300 + i * 20, 1500, 0.16 - i * 0.015)),
    ping(4186, 360, 1100, 0.07), ping(6272, 420, 900, 0.04),
    snap(6000, 0.14, 300, 30), shimmer(1100, 0.1, 280),
    ...sparkles(14, 320, 800, 3136, 0.06),
  ],
  // A lifetime medal: a brass-like fanfare (do-mi-sol-do) with a ringing chord, bigger even than platinum's.
  fanfare: [
    { src: 'tone', wave: 'sine', pitchHz: [82, 131], ms: 1300, gain: 0.35, attackMs: 60 },
    whoosh(250, 6000, 420, 0.14),
    ...[523, 659, 784, 1047].map((hz, i): Layer => ({ src: 'tone', wave: 'sawtooth', pitchHz: [hz, hz], ms: i === 3 ? 1100 : 170, gain: i === 3 ? 0.17 : 0.13, delayMs: 120 + i * 140 })),
    ...[1047, 1319, 1568, 2093].map((hz, i) => bell(hz, 680 + i * 25, 1500, 0.16)),
    ...[2093, 3136, 4186].map((hz, i) => ping(hz, 720 + i * 40, 1400, 0.07)),
    // A toy-military march: a snare roll leading into the chord.
    ...[0, 60, 120, 180, 230, 280, 330, 380, 430].map((d, i): Layer => ({ src: 'noise', filter: 'bandpass', q: 1.2, cutoffHz: [3200, 2200], ms: 40, gain: 0.1 + i * 0.012, delayMs: d })),
    shimmer(1300, 0.1, 650), ...sparkles(16, 700, 900, 3136, 0.06),
  ],
  ...killSteps(),
  death: [{ src: 'tone', wave: 'sawtooth', pitchHz: [440, 55], ms: 900, gain: 0.35 }, { src: 'noise', filter: 'lowpass', q: 1, cutoffHz: [900, 80], ms: 600, gain: 0.3 }],
  levelup: [note(523, 0, 120, 0.2), note(659, 90, 120, 0.2), note(784, 180, 260, 0.22), whoosh(400, 4500, 260, 0.12), ping(1568, 180, 500, 0.08), ping(2093, 240, 450, 0.06), ...sparkles(4, 220, 220, 3136, 0.04)],
  evolve: [
    { src: 'tone', wave: 'sawtooth', pitchHz: [180, 720], ms: 420, gain: 0.16 },
    note(392, 60, 120, 0.18), note(587, 170, 120, 0.2), note(784, 280, 380, 0.24),
    { src: 'noise', filter: 'highpass', q: 0.8, cutoffHz: [6000, 9000], ms: 500, gain: 0.12, delayMs: 280 },
    whoosh(250, 6500, 400, 0.2), { src: 'tone', wave: 'sine', pitchHz: [70, 140], ms: 500, gain: 0.3, attackMs: 30 },
    ping(1568, 290, 800, 0.1), ping(2349, 320, 800, 0.08), ...sparkles(8, 300, 450, 3520, 0.05),
  ],
  perk: [{ src: 'tone', wave: 'triangle', pitchHz: [660, 660], ms: 60, gain: 0.22 }, { src: 'tone', wave: 'triangle', pitchHz: [990, 990], ms: 90, gain: 0.22, delayMs: 60 }, ping(1980, 60, 200, 0.06)],
  bounty: [note(988, 0, 80, 0.22), note(1319, 80, 320, 0.24), { src: 'noise', filter: 'highpass', q: 1, cutoffHz: [7000, 7000], ms: 200, gain: 0.1, delayMs: 80 }, ...ching(1.5)],
  click: [{ src: 'tone', wave: 'square', pitchHz: [1800, 1800], ms: 18, gain: 0.15 }],
  // A click while a bolt is still being worked: a dull, soft wooden tick, nothing like a shot or a dry fire.
  notReady: [{ src: 'noise', filter: 'bandpass', q: 2.5, cutoffHz: [900, 700], ms: 22, gain: 0.14 }, { src: 'tone', wave: 'sine', pitchHz: [320, 260], ms: 35, gain: 0.07 }],
  bite: [{ src: 'noise', filter: 'bandpass', q: 1.4, cutoffHz: [900, 260], ms: 130, gain: 0.5 }, { src: 'tone', wave: 'sawtooth', pitchHz: [150, 60], ms: 110, gain: 0.22 }],
  splat: [{ src: 'noise', filter: 'bandpass', q: 1.2, cutoffHz: [700, 180], ms: 110, gain: 0.35 }, { src: 'tone', wave: 'triangle', pitchHz: [210, 70], ms: 90, gain: 0.25 },
    { src: 'noise', filter: 'bandpass', q: 4, cutoffHz: [500, 200], ms: 80, gain: 0.2, delayMs: 60 }, snap(3500, 0.08, 0, 10)],
  step: [{ src: 'noise', filter: 'lowpass', q: 0.8, cutoffHz: [900, 350], ms: 45, gain: 0.07 }, { src: 'tone', wave: 'sine', pitchHz: [130, 70], ms: 50, gain: 0.05 }],
  // A sprint's boots land harder and brighter, a scuff then a thud, on a quicker beat.
  // A dropped magazine hitting the floor: a tiny metal tink.
  tink: [snap(5200, 0.12, 0, 6), ping(3300, 0, 70, 0.1), ping(4700, 4, 45, 0.05)],
  stepSprint: [{ src: 'noise', filter: 'bandpass', q: 0.9, cutoffHz: [1600, 500], ms: 55, gain: 0.1 }, { src: 'tone', wave: 'sine', pitchHz: [150, 75], ms: 55, gain: 0.07 }],
  // Dropping into the world: a whistle falling away, then the landing.
  spawn: louder([{ src: 'tone', wave: 'sine', pitchHz: [1100, 220], ms: 200, gain: 0.07 }, { src: 'tone', wave: 'sine', pitchHz: [150, 38], ms: 420, gain: 0.7, delayMs: 170 },
    air(1000, 100, 260, 0.3, 170), snap(1800, 0.12, 170, 14), ping(1100, 200, 200, 0.04)], 0.6),
  // Explosive barrels. A hit is a metal tink and a leak of gas; a lit one sizzles; the burst is a clang and a fiery whoomp, never the grenade's boom.
  'barrel:hurt': [snap(4800, 0.3, 0, 6), ping(1450, 0, 170, 0.2), ping(2210, 0, 110, 0.1), { src: 'noise', filter: 'highpass', q: 0.7, cutoffHz: [6500, 4200], ms: 240, gain: 0.16, delayMs: 15 }],
  'barrel:fuse': [{ src: 'noise', filter: 'highpass', q: 0.8, cutoffHz: [5000, 8500], ms: 440, gain: 0.2, attackMs: 40 }, { src: 'tone', wave: 'sine', pitchHz: [600, 1900], ms: 420, gain: 0.04 }, ...crackle(7, 10, 380, 0.16)],
  'barrel:burst': [
    ping(310, 0, 560, 0.34), ping(467, 0, 460, 0.24), ping(821, 0, 380, 0.18), ping(1366, 0, 280, 0.1), snap(3000, 0.4, 0, 16),
    { src: 'tone', wave: 'sine', pitchHz: [95, 34], ms: 650, gain: 0.85 },
    { src: 'noise', filter: 'lowpass', q: 0.8, cutoffHz: [250, 1300], ms: 520, gain: 0.6, attackMs: 70 }, thump(60, 420, 0.7),
    air(700, 110, 700, 0.2, 90), ...debris(6, 120, 500, 0.12),
  ],
  'barrel:chain': [{ src: 'noise', filter: 'lowpass', q: 0.7, cutoffHz: [600, 110], ms: 950, gain: 0.35, attackMs: 140 }, thump(75, 300, 0.45), { ...thump(68, 300, 0.4), delayMs: 140 }, { ...thump(62, 320, 0.35), delayMs: 290 }, ping(380, 200, 320, 0.08), ping(540, 330, 260, 0.06)],
  // The other props: a tank's rocket whoosh, a canister's long hiss, a generator's electric crackle, an oil drum's fire whump and crackle, breaking glass, a pickup chime and a paint splat.
  'prop:whoosh': [whoosh(500, 3200, 520, 0.4), air(2200, 300, 520, 0.2), { src: 'noise', filter: 'highpass', q: 0.8, cutoffHz: [4000, 7500], ms: 420, gain: 0.12 }, thump(110, 240, 0.4)],
  'prop:hiss': [{ src: 'noise', filter: 'highpass', q: 0.8, cutoffHz: [4200, 7800], ms: 900, gain: 0.3, attackMs: 40 }, air(1800, 600, 700, 0.14), snap(3000, 0.3, 0, 12), thump(150, 160, 0.35)],
  'prop:zap': [snap(6000, 0.45, 0, 10), ...crackle(14, 0, 520, 0.3, 3500), { src: 'tone', wave: 'sawtooth', pitchHz: [120, 118], ms: 520, gain: 0.1 }, { src: 'tone', wave: 'square', pitchHz: [2400, 300], ms: 180, gain: 0.08, delayMs: 480 }],
  'prop:fire': [{ src: 'noise', filter: 'lowpass', q: 0.8, cutoffHz: [350, 1400], ms: 360, gain: 0.55, attackMs: 60 }, thump(70, 360, 0.55), ...crackle(12, 120, 700, 0.18, 4200), air(900, 200, 600, 0.12, 100)],
  'prop:glass': [snap(7000, 0.4, 0, 12), ping(3136, 0, 300, 0.14), ping(4186, 10, 240, 0.1), ping(2349, 20, 360, 0.1), ...debris(9, 20, 360, 0.2), shimmer(280, 0.14, 10)],
  'prop:pickup': [bell(1319, 0, 220, 0.18), bell(1760, 70, 320, 0.18), ping(3520, 70, 300, 0.07)],
  'prop:splat': [{ src: 'noise', filter: 'bandpass', q: 1.1, cutoffHz: [900, 260], ms: 140, gain: 0.4 }, thump(190, 100, 0.3), snap(3000, 0.1, 0, 10)],
  // A supply drop: a plane's drone passing over, the chute's fwump and flutter, the crate's thud and break, then the prize.
  plane: [
    { src: 'tone', wave: 'sawtooth', pitchHz: [96, 80], ms: PLANE_MS, gain: 0.075, attackMs: PLANE_PEAK_MS },
    { src: 'tone', wave: 'sawtooth', pitchHz: [101, 84], ms: PLANE_MS, gain: 0.065, attackMs: PLANE_PEAK_MS },
    { src: 'tone', wave: 'triangle', pitchHz: [192, 160], ms: PLANE_MS, gain: 0.05, attackMs: PLANE_PEAK_MS },
    { src: 'noise', filter: 'bandpass', q: 1.2, cutoffHz: [300, 200], ms: PLANE_MS, gain: 0.12, attackMs: PLANE_PEAK_MS },
  ],
  chute: [air(1800, 300, 220, 0.3), ...[180, 300, 430, 570, 730, 910].map((d, i): Layer => ({ src: 'noise', filter: 'bandpass', q: 2, cutoffHz: [1400, 900], ms: 70, gain: 0.12 * (1 - i * 0.12), delayMs: d })), air(1100, 500, 700, 0.06, 200)],
  'crate:land': [thump(130, 200, 0.8), { src: 'tone', wave: 'triangle', pitchHz: [320, 140], ms: 90, gain: 0.4 }, { src: 'noise', filter: 'lowpass', q: 0.8, cutoffHz: [900, 150], ms: 220, gain: 0.5 }, ...debris(3, 40, 150, 0.1)],
  'crate:break': [crack(1800, 160, 0.6), snap(3500, 0.4, 0, 10), thump(180, 140, 0.5), ...debris(10, 30, 420, 0.22), { src: 'noise', filter: 'lowpass', q: 0.8, cutoffHz: [1400, 200], ms: 260, gain: 0.35 }],
  // The golden gun is a blade drawn, a bright metallic shing; a resupply is a softer three-note jingle with coins.
  'crate:gold': [whoosh(1200, 9000, 160, 0.1), ping(2093, 0, 900, 0.2), ping(3136, 30, 800, 0.16), ping(4186, 60, 700, 0.12), ping(6272, 80, 500, 0.06), shimmer(260, 0.12, 20), bell(1568, 120, 900, 0.15), ...sparkles(6, 150, 500, 3951, 0.05)],
  'crate:supply': [bell(1319, 0, 260, 0.18), bell(1568, 80, 260, 0.18), bell(1976, 160, 320, 0.18), ...ching(0.8).map((l) => ({ ...l, delayMs: (l.delayMs ?? 0) + 120 }))],
  // Slow motion: a low whoosh and a heartbeat into it; a reverse swell and a tick back out.
  'slowmo:in': [{ src: 'noise', filter: 'bandpass', q: 1.1, cutoffHz: [2400, 160], ms: 700, gain: 0.5, attackMs: 60 }, { src: 'tone', wave: 'sine', pitchHz: [180, 45], ms: 700, gain: 0.45 }],
  'slowmo:out': [{ src: 'noise', filter: 'bandpass', q: 1.2, cutoffHz: [180, 3200], ms: 420, gain: 0.4, attackMs: 380 }, { src: 'tone', wave: 'sine', pitchHz: [60, 180], ms: 420, gain: 0.3, attackMs: 380 }, snap(4000, 0.2, 400, 10)],
  // Ambient life (ambient.ts): a flock's wing-claps, a crow's two caws, a gull's cry. Quiet, and the first thing dropped from a busy mix.
  'amb:flutter': [...[0, 40, 85, 120, 170, 215].map((d, i): Layer => ({ src: 'noise', filter: 'bandpass', q: 1.4, cutoffHz: [2600 - i * 150, 1500], ms: 38, gain: 0.1 - i * 0.01, delayMs: d }))],
  'amb:caw': [0, 190].map((d, i): Layer => ({ src: 'tone', wave: 'sawtooth', pitchHz: [820 - i * 80, 420], ms: 150, gain: 0.07, delayMs: d, attackMs: 14 })).concat([{ src: 'noise', filter: 'bandpass', q: 3, cutoffHz: [1500, 900], ms: 330, gain: 0.05, delayMs: 0, attackMs: 20 }]),
  'amb:gull': [{ src: 'tone', wave: 'triangle', pitchHz: [1500, 2300], ms: 200, gain: 0.07, attackMs: 30 }, { src: 'tone', wave: 'triangle', pitchHz: [2300, 1350], ms: 340, gain: 0.07, delayMs: 200, attackMs: 10 }],
  emote: [{ src: 'tone', wave: 'sine', pitchHz: [700, 320], ms: 70, gain: 0.3 }, { src: 'noise', filter: 'bandpass', q: 2, cutoffHz: [1800, 900], ms: 25, gain: 0.2 }, ping(1500, 10, 80, 0.06)],
  // The round-end party: a confetti cannon is a thump, a puff of air and paper; a firework a whistle up, a crack and a crackle.
  confetti: [thump(150, 150, 0.7), crack(2000, 60, 0.5), snap(5000, 0.35, 0, 12), air(3000, 600, 260, 0.45), ...debris(14, 40, 500, 0.12)],
  firework: [{ src: 'tone', wave: 'sine', pitchHz: [500, 1900], ms: 260, gain: 0.05, attackMs: 30 }, { ...thump(120, 200, 0.5), delayMs: 260 }, { ...crack(2800, 90, 0.5), delayMs: 260 }, ...crackle(14, 300, 800, 0.18)],
  'turret:sentry': [crack(4200, 35, 0.3), { src: 'tone', wave: 'square', pitchHz: [1400, 900], ms: 25, gain: 0.08 }],
  'turret:cannon': [crack(900, 300, 0.7), thump(70, 380, 0.75), { src: 'noise', filter: 'lowpass', q: 0.7, cutoffHz: [700, 80], ms: 420, gain: 0.35 }],
  'turret:scatter': [crack(2600, 120, 0.45), { src: 'noise', filter: 'bandpass', q: 0.9, cutoffHz: [2400, 600], ms: 140, gain: 0.3 }],
  'turret:mortar': [thump(120, 220, 0.6), { src: 'noise', filter: 'lowpass', q: 0.8, cutoffHz: [500, 120], ms: 260, gain: 0.3 }],
  'turret:tesla': [{ src: 'tone', wave: 'sawtooth', pitchHz: [2600, 180], ms: 110, gain: 0.16 }, snap(5000, 0.3, 0, 14), ...crackle(7, 10, 140, 0.22, 4200), { src: 'noise', filter: 'bandpass', q: 1.2, cutoffHz: [3200, 900], ms: 150, gain: 0.2 }],
  // Building is a different knock for each stuff: hammered boards, a sandbag's soft double thud, steel's ring; a spike strip rattles down; an upgrade climbs a chime over a hammer tick.
  'build:wood': [snap(2600, 0.3, 0, 10), thump(560, 45, 0.5), { ...snap(2600, 0.3, 0, 10), delayMs: 95 }, { ...thump(500, 45, 0.5), delayMs: 95 }, { ...snap(2400, 0.25, 0, 10), delayMs: 190 }, { ...thump(440, 55, 0.5), delayMs: 190 }],
  'build:sandbag': [thump(140, 140, 0.6), air(1000, 200, 170, 0.3), { ...thump(110, 170, 0.65), delayMs: 100 }, { ...air(900, 180, 200, 0.28), delayMs: 100 }],
  'build:steel': [crack(3200, 30, 0.4), thump(170, 80, 0.45), ping(1180, 0, 560, 0.24), ping(1770, 0, 380, 0.14), ping(2760, 0, 220, 0.08), { ...ping(1000, 0, 420, 0.14), delayMs: 120 }, { ...crack(2400, 25, 0.25), delayMs: 120 }],
  'build:spikes': [...crackle(9, 0, 170, 0.2, 3400), ping(1500, 0, 90, 0.08), thump(220, 60, 0.3)],
  upgrade: [snap(3000, 0.25, 0, 12), thump(260, 60, 0.4), bell(784, 70, 240, 0.2), bell(1047, 150, 240, 0.2), bell(1568, 230, 460, 0.22), ...sparkles(3, 240, 220, 3136, 0.05)],
  'aid:depot': [...mechClick(2600, 0, 0.16), thunk(200, 20, 0.22), ...mechClick(3000, 90, 0.12)],
  'aid:post': [bell(1047, 0, 200, 0.12), bell(1319, 70, 280, 0.12)],
  wallHit: [thump(150, 90, 0.4), { src: 'noise', filter: 'lowpass', q: 1, cutoffHz: [1400, 300], ms: 80, gain: 0.3 }],
  wallUp: [thump(320, 50, 0.45), thump(240, 70, 0.45), { ...thump(240, 70, 0.4), delayMs: 80 }],
  wallDown: [{ src: 'noise', filter: 'lowpass', q: 0.8, cutoffHz: [1500, 90], ms: 480, gain: 0.6 }, thump(85, 300, 0.55), ...debris(5, 100, 380, 0.15)],
  coreHit: [{ src: 'tone', wave: 'square', pitchHz: [240, 190], ms: 130, gain: 0.16 }, thump(95, 160, 0.5)],
  horn: [
    { src: 'tone', wave: 'sawtooth', pitchHz: [110, 98], ms: 1300, gain: 0.22 },
    { src: 'tone', wave: 'triangle', pitchHz: [165, 147], ms: 1300, gain: 0.2 },
    { src: 'noise', filter: 'lowpass', q: 0.7, cutoffHz: [400, 120], ms: 900, gain: 0.15 },
  ],
  chime: [
    { src: 'tone', wave: 'triangle', pitchHz: [659, 659], ms: 420, gain: 0.22 },
    { src: 'tone', wave: 'triangle', pitchHz: [880, 880], ms: 420, gain: 0.22, delayMs: 140 },
    { src: 'tone', wave: 'triangle', pitchHz: [1175, 1175], ms: 700, gain: 0.24, delayMs: 280 },
  ],
  downed: [{ src: 'tone', wave: 'sawtooth', pitchHz: [330, 110], ms: 650, gain: 0.3 }, { src: 'noise', filter: 'lowpass', q: 1, cutoffHz: [700, 120], ms: 400, gain: 0.25 }],
  revived: [note(523, 0, 110, 0.2), note(784, 100, 260, 0.22)],
  knock: [thump(240, 110, 0.45), note(740, 0, 80, 0.2), note(554, 80, 170, 0.2)],
  // Domination: a glassy tick each tenth of a capture you stand in (pitched up the climb by the cue), a bugle up for a point your
  // team takes, the same falling for one it loses, and a two-tone buzz while both teams stand on a point.
  'zone:tick': [ping(1320, 0, 70, 0.2), snap(4200, 0.08, 0, 6), { src: 'tone', wave: 'triangle', pitchHz: [660, 660], ms: 50, gain: 0.08 }],
  'zone:taken': [note(523, 0, 120, 0.18), note(659, 110, 120, 0.18), note(784, 220, 360, 0.22), bell(1568, 220, 520, 0.09), whoosh(600, 2400, 300, 0.12), ...sparkles(4, 260, 260, 2093, 0.05)],
  'zone:lost': [note(659, 0, 140, 0.18), note(523, 130, 140, 0.18), note(392, 260, 420, 0.2), thump(140, 260, 0.3), air(900, 200, 380, 0.1, 240)],
  'zone:contest': [
    { src: 'tone', wave: 'sawtooth', pitchHz: [196, 190], ms: 150, gain: 0.13 }, { src: 'tone', wave: 'square', pitchHz: [98, 96], ms: 150, gain: 0.06 },
    { src: 'tone', wave: 'sawtooth', pitchHz: [165, 160], ms: 170, gain: 0.13, delayMs: 170 }, { src: 'tone', wave: 'square', pitchHz: [82, 80], ms: 170, gain: 0.06, delayMs: 170 },
  ],
  ring: [
    { src: 'tone', wave: 'sawtooth', pitchHz: [82, 62], ms: 1500, gain: 0.16 },
    { src: 'tone', wave: 'triangle', pitchHz: [123, 93], ms: 1500, gain: 0.14 },
    { src: 'noise', filter: 'lowpass', q: 0.7, cutoffHz: [420, 140], ms: 1300, gain: 0.16 },
  ],
};

/**
 * The mix. Your own gunshots and hits are the reference (about -15 dBFS peak through the bus): reload clicks sit well under
 * them, the spawn is a modest thump, footsteps are subtle but audible, and the medals and fanfare are the loudest moments.
 * Factors multiply every layer of a cue (unclamped), measured by an offline render (see docs/art/STYLE.md, "Sound and music").
 */
const TRIM: Partial<Record<SoundId, number>> = {
  // Own feedback.
  hit: 2.37, hurt: 3.16, 'shot:silenced': 2.4, slash: 1.64, bite: 2.6, splat: 2.45, step: 5.37,
  // Quieter than the shots: the spawn thump (the reload foley is trimmed in foley.ts).
  spawn: 0.39, wallUp: 0.47,
  // Kills sit under the medals, which sit under the lifetime fanfare and the platinum.
  kill: 0.68, 'kill:2': 0.62, 'kill:3': 0.65, 'kill:4': 0.7, 'kill:5': 0.66, bounty: 0.72, boom: 0.6, flashbang: 0.7, flashRing: 0.5, smoke: 0.6, evolve: 0.81, levelup: 0.88,
  'medal:bronze': 1.72, 'medal:silver': 1.48, 'medal:gold': 1.6, fanfare: 1.15,
  // Barrels, airdrops, slow motion, emotes and the round-end party.
  'barrel:hurt': 0.92, 'barrel:fuse': 0.37, 'barrel:burst': 0.62, 'barrel:chain': 0.45, plane: 0.4, chute: 1.15, 'crate:land': 1.2, 'crate:break': 1.72, 'crate:gold': 1.06, 'crate:supply': 0.62,
  'prop:whoosh': 0.6, 'prop:hiss': 0.5, 'prop:zap': 0.6, 'prop:fire': 0.6, 'prop:glass': 0.8, 'prop:pickup': 1.2, 'prop:splat': 1.5,
  'slowmo:in': 0.54, 'slowmo:out': 0.3, emote: 3.43, confetti: 1.76, firework: 0.17,
};
/** Gunshots are balanced by class: the light guns come up, the shotgun and sniper families (already loud) come down a touch. */
const SHOT_TRIM: Record<WeaponId, number> = { pistol: 2.1, smg: 2.1, assault: 2.5, lmg: 2.4, shotgun: 1.85, sniper: 1.55 };
const trimOf = (id: SoundId): number => (id.startsWith('shot:') && id !== 'shot:silenced' ? (GUNS[id.slice(5) as GunId].silenced ? TRIM['shot:silenced']! : SHOT_TRIM[GUNS[id.slice(5) as GunId].base]) : TRIM[id] ?? 1);

export const SOUNDS: Record<SoundId, Recipe> = Object.fromEntries(
  (Object.keys(RAW) as SoundId[]).map((id) => [id, trimOf(id) === 1 ? RAW[id] : RAW[id].map((l) => ({ ...l, gain: l.gain * trimOf(id) }))]),
) as Record<SoundId, Recipe>;

/**
 * How far a cue's pitch and loudness wander each time it plays (a fraction, either way), so a held trigger does not
 * machine-gun one identical sample. Melodic cues stay in tune.
 */
export function varianceOf(id: SoundId): { pitch: number; gain: number } {
  if (id.startsWith('shot:')) return { pitch: 0.025, gain: 0.1 };
  if (id.startsWith('turret:')) return { pitch: 0.06, gain: 0.12 };
  if (id === 'step' || id === 'stepSprint') return { pitch: 0.18, gain: 0.3 };
  if (id === 'hit' || id.startsWith('impact:') || id === 'wallHit' || id === 'bite' || id === 'splat' || id === 'slash') return { pitch: 0.07, gain: 0.12 };
  if (id === 'boom' || id === 'wallDown') return { pitch: 0.04, gain: 0.06 };
  if (id.startsWith('foley:')) return { pitch: 0.03, gain: 0.08 };
  if (id.startsWith('build:')) return { pitch: 0.05, gain: 0.08 };
  if (id === 'barrel:hurt') return { pitch: 0.07, gain: 0.12 };
  if (id.startsWith('prop:')) return { pitch: 0.05, gain: 0.08 };
  if (id === 'barrel:burst' || id === 'barrel:chain' || id.startsWith('crate:')) return { pitch: 0.04, gain: 0.06 };
  if (id === 'emote' || id === 'confetti' || id === 'firework') return { pitch: 0.06, gain: 0.1 };
  return { pitch: 0, gain: 0 };
}

/** 0 = ambience that may be dropped when the mix is busy, 1 = ordinary, 2 = feedback the player must never miss. */
export function priorityOf(cue: { id: SoundId; self: boolean }): 0 | 1 | 2 {
  const { id } = cue;
  if (id === 'step' || id === 'stepSprint' || id === 'emote' || id.startsWith('amb:') || id.startsWith('impact:') || id.startsWith('turret:')) return 0;
  if (id.startsWith('shot:')) return cue.self ? 1 : 0;
  // Your own reload is part of the feel of the gun; another soldier's is the first thing dropped from a full mix.
  if (id.startsWith('foley:')) return cue.self ? 1 : 0;
  if (id === 'hit' || id === 'hurt' || id === 'death' || id === 'boom' || id === 'fanfare' || id === 'spawn' || id === 'levelup' || id === 'evolve' || id === 'bounty' || id === 'barrel:burst' || id === 'prop:pickup' || id === 'crate:gold' || id === 'crate:supply' || id === 'zone:taken' || id === 'zone:lost' || id.startsWith('medal:') || id.startsWith('kill')) return 2;
  return 1;
}

/** The least time between two plays of one cue from other players, so a crowd's gunfire is a roar rather than a buzz. */
export function minGapMs(id: SoundId): number {
  if (id.startsWith('shot:') || id.startsWith('turret:')) return 28;
  if (id.startsWith('impact:') || id === 'barrel:hurt') return 60;
  if (id === 'emote') return 150;
  // Another soldier's reload clicks: a crowd reloading at once is a murmur, not a machine gun.
  if (id.startsWith('foley:')) return 40;
  return 0;
}

/** Distance moved between steps. Crossing a cell of this size sounds one footstep, so the cadence follows speed. */
const STEP_PX = 64;
const SPRINT_STEP_PX = 46;

/** A bounty, revenge or shutdown gets the fanfare, a Last Squad knock its own thud; any other kill climbs in pitch with the streak it extends. */
function killSound(ev: Extract<Snapshot['events'][number], { e: 'kill' }>, streak: number): Exclude<SoundId, 'hurt'> {
  if (ev.bounty || ev.revenge || ev.ended >= STREAK.shutdownAt) return 'bounty';
  if (ev.knock) return 'knock';
  return streak <= 1 ? 'kill' : `kill:${Math.min(5, streak) as KillStep}`;
}

/** Each 100 hp the core loses sounds once, so a crowd chewing on it reads as a steady alarm rather than a buzz. */
const CORE_HIT_STEP = 100;

/** `r` is a boom's blast radius, which sets how hard it shakes the camera. */
export type SoundCue = {
  x: number; y: number; self: boolean; gain: number; r?: number;
  /** Multiplies the cue's pitch (a heavier gun's foley is lower). */
  pitch?: number;
  /** Starts this long from now, for a ripple of blasts. */
  delayMs?: number;
  /** A fixed stereo position (-1 left, 1 right) at full volume, for sounds that belong to the screen rather than the world. */
  pan?: number;
  /** The source travels from (`x`, `y`) to this point over `ms`, so a plane's drone pans across the field. */
  sweep?: { x: number; y: number; ms: number };
}
  & ({ id: 'hurt'; damageFrac: number } | { id: Exclude<SoundId, 'hurt'> });

/** A screen-space cue (a UI or celebration sound): at the listener, optionally panned. */
export const screenCue = (id: Exclude<SoundId, 'hurt'>, gain = 1, pan?: number): SoundCue => ({ id, x: 0, y: 0, self: true, gain, ...(pan === undefined ? {} : { pan }) });

/** The pop of an emote bubble over player `pid`: full for your own, quieter and placed in the world for everyone else's. */
export function emoteCue(snap: Snapshot, pid: number): SoundCue | null {
  if (pid === snap.self.id) return { id: 'emote', x: 0, y: 0, self: true, gain: 1 };
  const p = snap.players.find((q) => q.id === pid);
  return p ? { id: 'emote', x: p.x, y: p.y, self: false, gain: 0.45 } : null;
}

/** Moments big enough that the score steps back for them; `musicDuck` takes these, so the music and the effects agree on what is big. */
export const DUCKS: Partial<Record<SoundId, { depth: number; holdMs: number }>> = {
  boom: { depth: 0.5, holdMs: 300 }, 'barrel:burst': { depth: 0.55, holdMs: 280 },
  kill: { depth: 0.78, holdMs: 100 }, 'kill:2': { depth: 0.78, holdMs: 100 }, 'kill:3': { depth: 0.78, holdMs: 100 }, 'kill:4': { depth: 0.76, holdMs: 100 }, 'kill:5': { depth: 0.74, holdMs: 120 },
  bounty: { depth: 0.7, holdMs: 200 }, knock: { depth: 0.78, holdMs: 100 },
  'medal:silver': { depth: 0.75, holdMs: 250 }, 'medal:gold': { depth: 0.62, holdMs: 450 }, 'medal:platinum': { depth: 0.5, holdMs: 700 }, fanfare: { depth: 0.45, holdMs: 900 },
  flashbang: { depth: 0.55, holdMs: 400 }, flashRing: { depth: 0.3, holdMs: 1800 },
  evolve: { depth: 0.7, holdMs: 300 }, 'crate:gold': { depth: 0.7, holdMs: 300 }, 'slowmo:in': { depth: 0.65, holdMs: 500 },
};

/** How far the score should duck for `cue` heard from `listener`, or null: a far-off blast ducks it less, one out of earshot not at all. */
export function duckFor(cue: SoundCue, listener: { x: number; y: number }, viewRadius: number): { depth: number; holdMs: number } | null {
  const d = DUCKS[cue.id];
  if (!d) return null;
  if (cue.self || cue.pan !== undefined) return d;
  const fall = Math.max(0, 1 - Math.hypot(cue.x - listener.x, cue.y - listener.y) / (viewRadius * 1.2)) ** 2;
  return fall < 0.05 ? null : { depth: 1 - (1 - d.depth) * fall, holdMs: d.holdMs };
}

export const shotCue = (gun: GunId, silenced: boolean, at: { x: number; y: number }, self: boolean): SoundCue =>
  ({ id: silenced ? 'shot:silenced' : `shot:${gun}`, x: at.x, y: at.y, self, gain: 1 });

const BARREL_RIPPLE_MS = 90;

/** A prop's event, voiced: a tank launching whooshes, a canister hisses, a generator crackles, a drum whumps into flame, glass breaks, a pack chimes, paint splats. */
function propCue(ev: Extract<Snapshot['events'][number], { e: 'prop' }>, me: { x: number; y: number } | undefined): SoundCue {
  const id: Exclude<SoundId, 'hurt'> = ev.k === 'launch' ? 'prop:whoosh' : ev.k === 'arc' || ev.k === 'emp' ? 'prop:zap'
    : ev.k === 'pick' ? 'prop:pickup' : ev.k === 'relight' ? 'prop:pickup'
      : ev.kind === 'gas' ? 'prop:hiss' : ev.kind === 'oil' ? 'prop:fire' : ev.kind === 'paint' ? 'prop:splat' : 'prop:glass';
  const mineToo = ev.k === 'pick' && me !== undefined && Math.hypot(me.x - ev.x, me.y - ev.y) < 60;
  return { id, x: ev.x, y: ev.y, self: mineToo, gain: ev.k === 'relight' ? 0.4 : 1 };
}

/** The supply plane's drone panning across the field, the crate landing, and the crate cracked open for its golden gun or a resupply. */
function airdropCues(ev: Extract<Snapshot['events'][number], { e: 'airdrop' }>, next: Snapshot, myName: string | undefined): SoundCue[] {
  if (ev.k === 'landed') return [{ id: 'crate:land', x: ev.x, y: ev.y, self: false, gain: 1 }];
  if (ev.k === 'taken') {
    const self = ev.by !== undefined && ev.by === myName, gain = self ? 1 : 0.8;
    return [{ id: 'crate:break', x: ev.x, y: ev.y, self, gain }, { id: ev.gold ? 'crate:gold' : 'crate:supply', x: ev.x, y: ev.y, self, gain }];
  }
  const f = next.airdrop, now = next.tick * TICK_MS;
  if (!f) return [{ id: 'plane', x: ev.x, y: ev.y, self: false, gain: 1 }];
  const delay = Math.max(0, f.dropAt - now - PLANE_PEAK_MS);
  const from = planeAt(f, now + delay), to = planeAt(f, now + delay + PLANE_MS);
  return [{ id: 'plane', x: from.x, y: from.y, self: false, gain: 1, delayMs: delay, sweep: { x: to.x, y: to.y, ms: PLANE_MS } }];
}

/** A capture tick sounds each tenth of the way; the contested buzz repeats this often while you stand in it. */
const ZONE_TICKS = 10;
const CONTEST_BUZZ_MS = 1200;

/**
 * Domination, heard from your side: a tick rising in pitch with the capture of a point you stand in (lower while it drains), a
 * stinger when your team takes a point (softer for turning an enemy one neutral) or loses one, and a buzz when a point you are
 * on or near becomes contested, repeated while you hold your ground in it.
 */
export function zoneCues(prev: Snapshot, next: Snapshot, viewRadius: number): SoundCue[] {
  const me = selfOf(next), team = me?.team;
  if (!team || !next.zones.length) return [];
  const cues: SoundCue[] = [];
  for (const z of next.zones) {
    const was = prev.zones.find((o) => o.id === z.id);
    if (!was) continue;
    const at = { x: z.x, y: z.y };
    if (z.owner !== was.owner) {
      if (z.owner === team) cues.push(screenCue('zone:taken'));
      else if (z.owner !== null || was.owner === team) cues.push(screenCue('zone:lost', z.owner ? 0.7 : 1));
      else if (z.capturing === team) cues.push(screenCue('zone:taken', 0.55));
      continue;
    }
    const d = me ? Math.hypot(me.x - z.x, me.y - z.y) : Infinity;
    const on = me?.alive === true && d <= z.r;
    if (on && !z.contested && z.capturing && z.capturing === was.capturing && Math.floor(z.progress * ZONE_TICKS) !== Math.floor(was.progress * ZONE_TICKS)) {
      const rising = z.progress > was.progress;
      cues.push({ id: 'zone:tick', ...at, self: true, gain: 0.8, pitch: rising ? 0.85 + 0.75 * z.progress : 0.75 - 0.2 * z.progress });
    }
    const buzzBeat = Math.floor((next.tick * TICK_MS) / CONTEST_BUZZ_MS) !== Math.floor((prev.tick * TICK_MS) / CONTEST_BUZZ_MS);
    if (z.contested && ((!was.contested && d <= Math.max(z.r, viewRadius * 0.7)) || (was.contested && on && buzzBeat))) cues.push({ id: 'zone:contest', ...at, self: on, gain: on ? 0.9 : 0.6 });
  }
  return cues;
}

/** The sounds a snapshot's events and changes make. Your own shots are left out: the page voices them as it fires them. */
export function soundsFor(prev: Snapshot | null, next: Snapshot): SoundCue[] {
  const me = selfOf(next);
  const at = { x: me?.x ?? 0, y: me?.y ?? 0 };
  const cues: SoundCue[] = [];
  const mine = (id: Exclude<SoundId, 'hurt'>) => cues.push({ id, ...at, self: true, gain: 1 });
  // Barrels: ids from either snapshot (a hit one may be gone by the next), and the ones that burst this tick (gone, with a boom on the spot).
  const barrels = new Map([...(prev?.barrels ?? []), ...(next.barrels ?? [])].map((b) => [b[0], b] as const));
  const gone = prev?.barrels && next.barrels ? prev.barrels.filter((b) => !next.barrels!.some((n) => n[0] === b[0])) : [];
  let bursts = 0;
  for (const ev of next.events) {
    switch (ev.e) {
      case 'shot':
        if (ev.owner !== next.self.id) cues.push(shotCue(ev.gun, ev.silenced, ev, false));
        break;
      case 'dmg': {
        const iHitSomeone = (ev.kind === 'player' || ev.kind === 'zombie' || ev.kind === 'target') && ev.attacker === next.self.id && ev.victim !== next.self.id;
        if (iHitSomeone && !cues.some((c) => c.id === 'hit')) mine('hit');
        // What a hit lands on has its own voice, one per kind a snapshot so a shotgun blast is one thwack.
        if (ev.kind === 'crate' && barrels.has(ev.victim)) {
          if ((next.barrels?.find((b) => b[0] === ev.victim)?.[3] ?? 0) > 0 && !cues.some((c) => c.id === 'barrel:hurt')) cues.push({ id: 'barrel:hurt', x: ev.x, y: ev.y, self: false, gain: 0.9 });
          break;
        }
        const surface = ev.kind === 'crate' || ev.kind === 'target' ? 'impact:crate' : ev.kind === 'zombie' ? 'impact:zombie' : ev.kind === 'player' && ev.victim !== next.self.id && ev.attacker !== null ? 'impact:flesh' : null;
        if (surface && !(surface === 'impact:flesh' && iHitSomeone) && !cues.some((c) => c.id === surface)) cues.push({ id: surface, x: ev.x, y: ev.y, self: false, gain: 0.8 });
        break;
      }
      case 'boom': {
        // A barrel's burst has its own voice: a clang and a whoomp, each further barrel of a chain a beat after the last.
        const i = gone.findIndex((b) => Math.hypot(b[1] - ev.x, b[2] - ev.y) < 4);
        if (i < 0) { cues.push({ id: 'boom', x: ev.x, y: ev.y, self: false, gain: 1, r: ev.r }); break; }
        gone.splice(i, 1);
        cues.push({ id: 'barrel:burst', x: ev.x, y: ev.y, self: false, gain: 1, r: ev.r, delayMs: bursts++ * BARREL_RIPPLE_MS });
        if (bursts === 2) cues.push({ id: 'barrel:chain', x: ev.x, y: ev.y, self: false, gain: 1 });
        break;
      }
      case 'flashburst': cues.push({ id: 'flashbang', x: ev.x, y: ev.y, self: false, gain: 1, r: 0 }); break;
      case 'airdrop': cues.push(...airdropCues(ev, next, me?.name)); break;
      case 'prop': cues.push(propCue(ev, me)); break;
      // An armor pack taken chimes like a cabinet's pack, at your ear when it was yours.
      case 'pack': cues.push({ id: 'prop:pickup', x: ev.x, y: ev.y, self: me !== undefined && Math.hypot(me.x - ev.x, me.y - ev.y) < 60, gain: 1 }); break;
      // A target clatters down and pings back up on its spring.
      case 'target': cues.push(ev.k === 'down' ? { id: 'impact:crate', x: ev.x, y: ev.y, self: false, gain: 1 } : { id: 'tink', x: ev.x, y: ev.y, self: false, gain: 0.6 }); break;
      case 'slash': cues.push({ id: 'slash', x: ev.x, y: ev.y, self: ev.owner === next.self.id, gain: 1 }); break;
      case 'kill':
        if (ev.killerId === next.self.id && ev.victimId !== next.self.id) mine(killSound(ev, next.self.streak));
        break;
      case 'impact':
        if (!cues.some((c) => c.id === 'impact:wall')) cues.push({ id: 'impact:wall', x: ev.x, y: ev.y, self: false, gain: 0.8 });
        break;
      case 'medal':
        break;
      case 'zkill':
        if (ev.by === next.self.id) cues.push({ id: 'splat', x: ev.x, y: ev.y, self: true, gain: 1 });
        break;
      case 'turret':
        // A row of sentries fires several rounds a snapshot; one cue per kind keeps it a rattle instead of a roar.
        if (!cues.some((c) => c.id === `turret:${ev.kind}`)) cues.push({ id: `turret:${ev.kind}`, x: ev.x, y: ev.y, self: false, gain: 1 });
        break;
      case 'coil':
        if (!cues.some((c) => c.id === 'turret:tesla')) cues.push({ id: 'turret:tesla', x: ev.x, y: ev.y, self: false, gain: 1 });
        break;
      case 'aid':
        if (!cues.some((c) => c.id === `aid:${ev.kind}`)) cues.push({ id: `aid:${ev.kind}`, x: ev.x, y: ev.y, self: false, gain: 1 });
        break;
      case 'life':
        if (ev.id === next.self.id && (ev.k === 'downed' || ev.k === 'bledOut' || ev.k === 'finished')) mine(ev.k === 'downed' ? 'downed' : 'death');
        else if ((ev.k === 'revived' && (ev.id === next.self.id || ev.by === next.self.id)) || (ev.k === 'redeployed' && ev.id === next.self.id)) mine('revived');
        else if (ev.k === 'finished' && ev.by === next.self.id) mine('kill');
        break;
    }
  }
  // One sting per snapshot, for the best medal in it.
  const TIERS: readonly MedalTier[] = ['bronze', 'silver', 'gold', 'platinum'];
  const won = next.events.flatMap((ev) => (ev.e === 'medal' && ev.id === next.self.id ? [TIERS.indexOf(MEDALS[ev.medal].tier)] : []));
  if (won.length) mine(`medal:${TIERS[Math.max(...won)]!}`);
  for (const ev of next.events) {
    if (ev.e !== 'dmg') continue;
    if (ev.kind === 'building' && !cues.some((c) => c.id === 'wallHit')) cues.push({ id: 'wallHit', x: ev.x, y: ev.y, self: false, gain: 1 });
    if (ev.kind === 'player' && ev.victim === next.self.id && ev.attacker === null && next.run && !cues.some((c) => c.id === 'bite')) mine('bite');
  }
  // Caught by a flashbang: a ring in the ears, as the page muffles the mix until it passes.
  if ((next.self.flash ?? 0) > (prev?.self.flash ?? 0) + 0.05) mine('flashRing');
  if (!prev) return cues;
  cues.push(...zoneCues(prev, next, next.self.viewRadius));
  for (const t of next.thrown) if (t.kind === 'smokeCloud' && !prev.thrown.some((o) => o.id === t.id)) cues.push({ id: 'smoke', x: t.x, y: t.y, self: false, gain: 1 });
  // A barrel just lit: it hisses until its fuse runs out.
  const lit = (next.barrels ?? []).find((b) => b[3] === 0 && (prev.barrels?.find((p) => p[0] === b[0])?.[3] ?? 0) > 0);
  if (lit) cues.push({ id: 'barrel:fuse', x: lit[1], y: lit[2], self: false, gain: 1 });
  // The supply crate leaves the plane: its chute opens.
  const drop = next.airdrop;
  if (drop && prev.airdrop?.dropAt === drop.dropAt && prev.tick * TICK_MS < drop.dropAt && drop.dropAt <= next.tick * TICK_MS) cues.push({ id: 'chute', x: drop.x, y: drop.y, self: false, gain: 1 });
  if (ringMoved(prev.royale, next.royale, prev.tick * TICK_MS, next.tick * TICK_MS)) mine('ring');
  const run = next.run, ran = prev.run;
  if (run && ran) {
    if (ran.phase === 'day' && run.phase === 'night') mine('horn');
    if (ran.phase === 'night' && run.phase === 'day') mine('chime');
    if (run.phase !== 'over' && Math.floor(run.core.hp / CORE_HIT_STEP) < Math.floor(ran.core.hp / CORE_HIT_STEP)) cues.push({ id: 'coreHit', ...at, self: true, gain: 0.7 });
    const cells = (b: Snapshot['buildings']) => new Set((b ?? []).map((w) => `${w.cx},${w.cy}`));
    const had = cells(prev.buildings), has = cells(next.buildings);
    const up = (next.buildings ?? []).find((w) => !had.has(`${w.cx},${w.cy}`));
    const down = (prev.buildings ?? []).find((w) => !has.has(`${w.cx},${w.cy}`));
    if (up) cues.push({ id: up.kind === 'wall' ? (['build:wood', 'build:sandbag', 'build:steel'] as const)[Math.min(3, up.lv ?? 1) - 1]! : up.kind === 'spikes' ? 'build:spikes' : 'wallUp', x: (up.cx + 0.5) * ZOM.cell, y: (up.cy + 0.5) * ZOM.cell, self: false, gain: 1 });
    // A building that stood in both and gained a level.
    const before = new Map((prev.buildings ?? []).map((b) => [`${b.cx},${b.cy}`, b.lv ?? 1]));
    const better = (next.buildings ?? []).find((b) => (before.get(`${b.cx},${b.cy}`) ?? Infinity) < (b.lv ?? 1));
    if (better) cues.push({ id: 'upgrade', x: (better.cx + 0.5) * ZOM.cell, y: (better.cy + 0.5) * ZOM.cell, self: false, gain: 1 });
    if (down && run.phase !== 'over') cues.push({ id: 'wallDown', x: (down.cx + 0.5) * ZOM.cell, y: (down.cy + 0.5) * ZOM.cell, self: false, gain: 1 });
  }
  const was = selfOf(prev);
  if (was?.alive && me?.alive) {
    const damage = was.hp - me.hp;
    if (damage > 0) {
      const damageFrac = Math.min(1, damage / me.maxHp);
      cues.push({ id: 'hurt', ...at, self: true, gain: 0.5 + 0.5 * damageFrac, damageFrac });
    }
    if (GUNS[me.gun].stage > GUNS[was.gun].stage) mine('evolve');
    // A sprint lands a boot every `SPRINT_STEP_PX`, a quicker, heavier beat than a walk's.
    const sprinting = next.self.sprint === true;
    const grid = sprinting ? SPRINT_STEP_PX : STEP_PX;
    const gridCell = (p: { x: number; y: number }) => [Math.floor(p.x / grid), Math.floor(p.y / grid)];
    const [gx0, gy0] = gridCell(was), [gx1, gy1] = gridCell(me);
    if ((gx0 !== gx1 || gy0 !== gy1) && !me.dashing && Math.hypot(me.x - was.x, me.y - was.y) < STEP_PX * 3) cues.push({ id: sprinting ? 'stepSprint' : 'step', ...at, self: true, gain: 1 });
    // Others' sprints carry too; a Ninja's PlayerView never says it is sprinting, so theirs is silent.
    for (const q of next.players) {
      const o = q.id === me.id || !q.sprint ? null : prev.players.find((x) => x.id === q.id);
      if (!o) continue;
      const [ox, oy] = gridCell(o), [qx, qy] = gridCell(q);
      if ((ox !== qx || oy !== qy) && Math.hypot(q.x - o.x, q.y - o.y) < STEP_PX * 3) cues.push({ id: 'stepSprint', x: q.x, y: q.y, self: false, gain: 0.8 });
    }
    if (Object.keys(next.self.perks).length > Object.keys(prev.self.perks).length) mine('perk');
  }
  if (me?.alive && was && !was.alive && !was.downed) mine('spawn');
  if (next.self.pending !== null && next.self.pending.level !== prev.self.pending?.level) mine('levelup');
  if (!next.self.alive && prev.self.alive && !me?.downed) mine('death');
  return cues;
}
