/**
 * The pure half of the post-processing pass: which look to apply for a context, and whether to run the shaders at all.
 * No DOM or GL in here, so the decisions are unit-tested; postfx.ts does the drawing.
 */

export type Vec3 = readonly [number, number, number];

export type Grade = {
  /** Colour lift: raises the blacks toward a tint (cool shadows). Tiny values. */
  lift: Vec3;
  /** Per-channel gain: the highlights' tint. */
  gain: Vec3;
  /** Midtone gamma (above 1 brightens). */
  gamma: number;
  /** 1 is unchanged, below desaturates. */
  sat: number;
  /** Luminance above which a pixel blooms. The bone floor sits near 0.86, so day stays above it. */
  bloomThreshold: number;
  bloomStrength: number;
  /** Film grain amplitude in 0..1 colour. */
  grain: number;
};

export type Context = { night: number; storm: boolean };

/** Soft overcast: warm highlights, cool shadows, a hair less saturated, bloom only on near-white light. */
export const DAY: Grade = { lift: [-0.004, 0.0, 0.014], gain: [1.03, 1.005, 0.965], gamma: 1.0, sat: 0.97, bloomThreshold: 0.9, bloomStrength: 0.42, grain: 0.011 };
/** Zombies night: deep steel shadows, amber lights kept warm and rich, and lamps that really glow. */
export const NIGHT: Grade = { lift: [0.0, 0.006, 0.026], gain: [1.04, 1.0, 0.97], gamma: 1.04, sat: 1.06, bloomThreshold: 0.84, bloomStrength: 0.85, grain: 0.02 };
/** Last Standing storm: a touch drained and cold, nothing else. */
export const STORM: Grade = { lift: [0.0, 0.006, 0.014], gain: [0.985, 1.0, 1.005], gamma: 1.0, sat: 0.82, bloomThreshold: 0.88, bloomStrength: 0.38, grain: 0.014 };

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

function blend(a: Grade, b: Grade, t: number): Grade {
  return {
    lift: mix3(a.lift, b.lift, t), gain: mix3(a.gain, b.gain, t), gamma: mix(a.gamma, b.gamma, t), sat: mix(a.sat, b.sat, t),
    bloomThreshold: mix(a.bloomThreshold, b.bloomThreshold, t), bloomStrength: mix(a.bloomStrength, b.bloomStrength, t), grain: mix(a.grain, b.grain, t),
  };
}

/** The grade for a moment: `night` is the 0..1 dusk fade the renderer already eases, so the grade follows it with no pop. */
export function gradeFor({ night, storm }: Context): Grade {
  const t = Math.min(1, Math.max(0, night));
  return blend(storm ? STORM : DAY, NIGHT, t);
}

export type FxMode = 'off' | 'calm' | 'full';

export type Env = {
  search: string;
  reducedMotion: boolean;
  saveData: boolean;
  deviceMemory?: number;
  /** The unmasked GL renderer string, if the browser would tell us. */
  renderer?: string;
  glOk: boolean;
};

export const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/**
 * Whether and how to run the shaders. `?nofx` always wins; `?fx` forces them on (even over a software renderer, which is
 * otherwise skipped because the plain 2D path is cheaper than a CPU-emulated GPU). Reduced motion keeps the grade and
 * bloom but drops grain animation and the hit pulse ('calm').
 */
export function decideFx(env: Env): { mode: FxMode; reason: string } {
  const q = new URLSearchParams(env.search);
  if (q.has('nofx')) return { mode: 'off', reason: 'nofx' };
  if (!env.glOk) return { mode: 'off', reason: 'no webgl' };
  const forced = q.has('fx');
  if (!forced) {
    if (env.renderer && SOFTWARE_GL.test(env.renderer)) return { mode: 'off', reason: 'software renderer' };
    if (env.saveData) return { mode: 'off', reason: 'save-data' };
    if (env.deviceMemory !== undefined && env.deviceMemory <= 2) return { mode: 'off', reason: 'low memory' };
  }
  return { mode: env.reducedMotion ? 'calm' : 'full', reason: forced ? 'forced' : 'ok' };
}

/** A running average of the CPU cost of the pass; trips when the path is clearly slower than the plain canvas would be. */
export function watchdog(limitMs = 5, frames = 90) {
  let n = 0, sum = 0;
  return (ms: number): boolean => {
    n++; sum += ms;
    if (n < frames) return false;
    const slow = sum / n > limitMs;
    n = 0; sum = 0;
    return slow;
  };
}

/** Chromatic pulse: starts at the given strength (0..1) and decays exponentially; strongest hit wins, never stacks past 1. */
export const PULSE_HALF_LIFE_MS = 110;
export function addPulse(current: number, strength: number): number { return Math.min(1, Math.max(current, strength)); }
export function decayPulse(current: number, dtMs: number): number {
  const next = current * 0.5 ** (Math.max(0, dtMs) / PULSE_HALF_LIFE_MS);
  return next < 0.004 ? 0 : next;
}

/** Vignette edge reach in screen fractions: the old gradient strips reached 26% of the view or 320 / 230 css px, whichever is less. */
export function vignetteReach(cssW: number, cssH: number): [number, number] {
  return [Math.min(0.26, 320 / cssW), Math.min(0.26, 230 / cssH)];
}

/**
 * Steps the lighting quality down when lit frames arrive slowly. Feed it each lit frame's interval; every `frames` frames it
 * looks at the average and, over `limitMs`, returns the next tier (cheaper), or -1 once there is no cheaper tier left.
 * Otherwise returns the tier it was given. It never steps back up, so quality cannot flap.
 */
export function tierGovernor(limitMs = 21, frames = 75) {
  let n = 0, sum = 0;
  return (dtMs: number, tier: number, lastTier: number): number => {
    n++; sum += dtMs;
    if (n < frames) return tier;
    const slow = sum / n > limitMs;
    n = 0; sum = 0;
    if (!slow) return tier;
    return tier >= lastTier ? -1 : tier + 1;
  };
}

const DISPLAY_PERIODS = [6.94, 8.33, 11.11, 16.67, 33.33] as const;
export type GovernorAction = 'none' | 'down' | 'up' | 'off' | 'plain';
export type GovernorStep = { action: GovernorAction; why: string };

/**
 * The lighting governor: steps the lighting tier down only when frames stay slow for a sustained stretch, steps it back up after
 * a long good one, and gives the lights up (then the whole shader pass) only as the last resort. It replaces a hair trigger
 * (one 1.5 s window averaging over 21 ms, or the pass's CPU cost averaging over 5 ms, switched lighting off for good) that a
 * 30 Hz power-saver display, a HiDPI canvas upload or one alt-tab could trip.
 *
 * Feed it every lit frame's interval and the pass's CPU cost. Judgement is by wall-clock buckets (`bucketMs`), so it does not
 * depend on the frame rate; a frame interval is judged against the display's own refresh (the quarter-fastest frames), so a
 * display held to 30 Hz is not "slow". Stalls (a hidden tab, a GC pause, over 250 ms) are not frame times and are skipped.
 */
export function lightGovernor(o: { bucketMs?: number; badBuckets?: number; offBuckets?: number; goodBuckets?: number; cpuLimitMs?: number } = {}) {
  const bucketMs = o.bucketMs ?? 2000, badBuckets = o.badBuckets ?? 3, offBuckets = o.offBuckets ?? 4, goodBuckets = o.goodBuckets ?? 10, cpuLimit = o.cpuLimitMs ?? 14;
  const recent: number[] = [];
  let at = -1, n = 0, dtSum = 0, cpuSum = 0, bad = 0, good = 0, floorBad = 0, cpuBad = 0, settle = 0;
  const fails: number[] = [];
  let lastAvg = 0, lastLimit = 0, holdUntil = 0;
  return {
    push(dtMs: number, cpuMs: number, now: number, tier: number, lastTier: number, lightsOn: boolean): GovernorStep {
      const none: GovernorStep = { action: 'none', why: '' };
      if (now < holdUntil) { dtSum = 0; cpuSum = 0; n = 0; at = now; bad = 0; return none; }
      if (at < 0) at = now;
      if (!(dtMs > 0) || dtMs > 250) { dtSum = 0; cpuSum = 0; n = 0; at = now; return none; }
      recent.push(dtMs); if (recent.length > 240) recent.shift();
      dtSum += dtMs; cpuSum += cpuMs; n++;
      if (now - at < bucketMs || n < 8) return none;
      const avg = dtSum / n, cpu = cpuSum / n;
      dtSum = 0; cpuSum = 0; n = 0; at = now;
      const sorted = [...recent].sort((a, b) => a - b);
      const q25 = sorted[Math.floor(sorted.length * 0.25)]!, q75 = sorted[Math.floor(sorted.length * 0.75)]!;
      // The display's own period, if the fast frames sit on one of the usual ones (and a slow one is perfectly regular: a power-saver cap, not a struggling GPU).
      const period = DISPLAY_PERIODS.find((p) => Math.abs(q25 - p) < p * 0.1 && (p < 20 || q75 - q25 < p * 0.1)) ?? 16.7;
      const limit = Math.max(26, period * 1.55);
      lastAvg = avg; lastLimit = limit;
      if (settle > 0) { settle--; return none; }
      const slow = avg > limit, heavy = cpu > cpuLimit;
      if (slow || heavy) { bad++; good = 0; if (heavy) cpuBad++; else cpuBad = 0; } else { bad = 0; floorBad = 0; cpuBad = 0; good++; }
      if (!lightsOn) {
        // Lighting is already off: only a CPU-heavy pass can still justify dropping the shaders altogether.
        return cpuBad >= 6 ? { action: 'plain', why: `shader pass cost ${cpu.toFixed(1)} ms of CPU a frame` } : none;
      }
      if (bad >= badBuckets) {
        bad = 0; settle = 1;
        if (tier < lastTier) { fails[tier] = (fails[tier] ?? 0) + 1; floorBad = 0; return { action: 'down', why: `${slow ? `frames averaged ${avg.toFixed(0)} ms (limit ${limit.toFixed(0)})` : `lighting CPU cost ${cpu.toFixed(1)} ms`} for ${((badBuckets * bucketMs) / 1000).toFixed(0)} s` }; }
        floorBad++;
        if (floorBad >= Math.ceil(offBuckets / badBuckets) + 1) { floorBad = 0; fails[tier] = (fails[tier] ?? 0) + 1; return { action: 'off', why: `still ${avg.toFixed(0)} ms a frame at the lowest tier` }; }
        return none;
      }
      if (good >= goodBuckets && tier > 0 && (fails[tier - 1] ?? 0) < 2) { good = 0; settle = 1; return { action: 'up', why: `smooth for ${((goodBuckets * bucketMs) / 1000).toFixed(0)} s` }; }
      return none;
    },
    /** Judges nothing until `now` (a tab just back from hidden is slow while it wakes, which is not the GPU's doing). */
    holdUntil(now: number) { holdUntil = now; dtSum = 0; cpuSum = 0; n = 0; at = -1; bad = 0; },
    /** The last bucket's average frame interval and the limit it was judged against, for the dev overlay. */
    last: () => ({ avg: lastAvg, limit: lastLimit }),
    reset() { recent.length = 0; at = -1; n = 0; dtSum = 0; cpuSum = 0; bad = 0; good = 0; floorBad = 0; cpuBad = 0; settle = 0; },
  };
}
