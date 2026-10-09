import { PALETTE } from './palette.ts';
import { knobs, scaled } from './quality.ts';

/**
 * `chip` is a spinning ink-edged fleck of debris, `spark` a hot streak along its flight, `ember` a glowing mote that drifts up,
 * `smoke` a flat cel-shaded puff that swells and climbs, `casing` a spent case left on the floor.
 */
export type ParticleShape = 'chip' | 'spark' | 'ember' | 'smoke' | 'casing';

/**
 * Launch conditions only: position at any time follows from them, so redrawing a frame never advances anything.
 * `rise` is a steady climb up the screen in px/s (smoke and embers float up out of the top-down view), `spin` turns a chip
 * in radians per px travelled, `wind` a steady drift in px/s (x, then y) that carries smoke off on the breeze.
 */
export type Particle = {
  x: number; y: number; vx: number; vy: number;
  drag: number; born: number; life: number;
  size: number; grow: number; color: string; shape: ParticleShape;
  rise?: number; spin?: number; wind?: readonly [number, number];
};

export type ParticlePool = { readonly slots: readonly Particle[]; next: number };

const PARTICLE_CAP = 500;

const deadParticle = (): Particle => ({ x: 0, y: 0, vx: 0, vy: 0, drag: 0, born: -Infinity, life: 0, size: 0, grow: 0, color: '', shape: 'chip', rise: 0, spin: 0, wind: undefined });

export function createPool(capacity = PARTICLE_CAP): ParticlePool {
  // The graphics preset sizes the pool a match starts with.
  return { slots: Array.from({ length: Math.max(1, scaled(capacity, knobs().particles)) }, deadParticle), next: 0 };
}

/** Writes over the oldest slot, so a pool never grows: past its cap the oldest particle simply ends early. */
export function emit(pool: ParticlePool, p: Particle) {
  const slot = pool.slots[pool.next]!;
  Object.assign(slot, p);
  if (p.rise === undefined) slot.rise = 0;
  if (p.spin === undefined) slot.spin = 0;
  if (p.wind === undefined) slot.wind = undefined;
  pool.next = (pool.next + 1) % pool.slots.length;
}

export const isLive = (p: Particle, now: number) => now >= p.born && now - p.born < p.life;

export const liveCount = (pool: ParticlePool, now: number) => pool.slots.reduce((n, p) => n + (isLive(p, now) ? 1 : 0), 0);

/** Where a particle is at `now` and how far through its life, with velocity decaying exponentially at `drag` per second. */
export function particleAt(p: Particle, now: number): { x: number; y: number; k: number } {
  const t = (now - p.born) / 1000;
  const travel = p.drag > 0 ? (1 - Math.exp(-p.drag * t)) / p.drag : t;
  const wx = p.wind ? p.wind[0] * t : 0, wy = p.wind ? p.wind[1] * t : 0;
  return { x: p.x + p.vx * travel + wx, y: p.y + p.vy * travel - (p.rise ?? 0) * t + wy, k: (now - p.born) / p.life };
}

export type BurstKind =
  | 'spark' | 'rubble' | 'debris' | 'smoke' | 'puff' | 'gore' | 'casing'
  | 'hotSparks' | 'zap' | 'chips' | 'plume' | 'embers' | 'dust' | 'bone' | 'muzzleSmoke' | 'mend' | 'pall' | 'wisp';

type BurstSpec = {
  count: number; speed: [number, number]; life: [number, number]; size: [number, number];
  grow: number; drag: number; spread: number; colors: readonly string[]; shape: ParticleShape;
  rise?: [number, number]; spin?: number;
};

const CONCRETE = ['#5f636c', '#7d818a', '#9a9ea6', '#4c5059'] as const;

/** `spread` is the cone half-angle in radians around the burst direction; π sprays all round. */
export const BURSTS: Record<BurstKind, BurstSpec> = {
  spark: { count: 3, speed: [200, 420], life: [90, 180], size: [1.4, 2.2], grow: 0, drag: 9, spread: 1.0, colors: ['#fff3c4', '#ffffff'], shape: 'spark' },
  rubble: { count: 5, speed: [70, 230], life: [2600, 4200], size: [1.6, 3.6], grow: 0, drag: 10, spread: 1.1, colors: CONCRETE, shape: 'chip', spin: 0.08 },
  debris: { count: 22, speed: [240, 720], life: [380, 720], size: [4, 9], grow: 0, drag: 4.5, spread: Math.PI, colors: ['#3a3631', '#5a5249', '#ffb347', '#ff7a2f'], shape: 'chip', spin: 0.05 },
  smoke: { count: 7, speed: [40, 150], life: [600, 1000], size: [12, 22], grow: 1.4, drag: 2.5, spread: Math.PI, colors: ['#a3a09a', '#8c8984', '#b6b3ad'], shape: 'smoke', rise: [10, 30] },
  gore: { count: 12, speed: [140, 380], life: [260, 520], size: [3, 7], grow: 0, drag: 7, spread: Math.PI, colors: ['#4c6e22', '#2f3a1c', '#a3c766'], shape: 'chip', spin: 0.06 },
  puff: { count: 16, speed: [90, 300], life: [360, 560], size: [4, 6], grow: 0, drag: 5, spread: Math.PI, colors: ['#ffffff'], shape: 'spark' },
  casing: { count: 1, speed: [90, 160], life: [1400, 1800], size: [4, 4], grow: 0, drag: 5, spread: 0.4, colors: [PALETTE.casing], shape: 'casing' },
  /** Metal on claw: a fan of hot streaks that die fast, the punch of a hit. */
  hotSparks: { count: 6, speed: [260, 620], life: [110, 260], size: [1.6, 2.8], grow: 0, drag: 7, spread: 0.85, colors: ['#fff6d6', '#ffd27a', '#ff9a3c'], shape: 'spark' },
  /** The core's charge arcing out of a crack. */
  zap: { count: 5, speed: [180, 460], life: [120, 280], size: [1.4, 2.4], grow: 0, drag: 6, spread: 0.7, colors: ['#e8fdff', '#7fe6f5', '#4fd1e8'], shape: 'spark' },
  /** Flecks of armour plate knocked off a building. */
  chips: { count: 4, speed: [120, 300], life: [380, 700], size: [2.4, 4.4], grow: 0, drag: 6, spread: 0.9, colors: ['#3c414b', '#5d636d', '#2c3037', '#d9541f'], shape: 'chip', spin: 0.09 },
  /** A slow column of smoke off a burning building: few big puffs that swell and climb. */
  plume: { count: 1, speed: [6, 26], life: [1400, 2200], size: [7, 11], grow: 1.6, drag: 1.2, spread: Math.PI, colors: ['#5a5550', '#6b655f', '#4a4642'], shape: 'smoke', rise: [26, 44] },
  embers: { count: 2, speed: [20, 90], life: [600, 1100], size: [1.4, 2.4], grow: 0, drag: 2, spread: Math.PI, colors: ['#ffe08a', '#ff9a3c', '#d9541f'], shape: 'ember', rise: [30, 60] },
  /** Grit kicked up off the floor by a blow. */
  dust: { count: 3, speed: [40, 120], life: [320, 520], size: [5, 8], grow: 1.1, drag: 5, spread: 1.2, colors: ['#c9c2b2', '#b4ad9c'], shape: 'smoke', rise: [4, 12] },
  /** A zombie coming apart: pale bone flecks to go with the gore. */
  bone: { count: 5, speed: [160, 420], life: [300, 560], size: [2.4, 4.2], grow: 0, drag: 7, spread: Math.PI, colors: ['#e8dfc8', '#cfc4a8'], shape: 'chip', spin: 0.12 },
  muzzleSmoke: { count: 2, speed: [30, 90], life: [380, 620], size: [4, 7], grow: 1.3, drag: 4, spread: 0.5, colors: ['#bdb9b1', '#a7a39c'], shape: 'smoke', rise: [8, 20] },
  /** A wreck's smoke: big, slow, near-black puffs that swell a long way and climb, so a few of them stack into a thick column. */
  pall: { count: 1, speed: [4, 18], life: [2600, 3800], size: [9, 14], grow: 2.2, drag: 1, spread: Math.PI, colors: ['#2e2b28', '#3f3c38', '#8c8984'], shape: 'smoke', rise: [22, 38] },
  /** A battered gun's light wisps: small pale puffs that thin fast. */
  wisp: { count: 1, speed: [4, 14], life: [1100, 1700], size: [3, 5], grow: 1.6, drag: 1.5, spread: Math.PI, colors: ['#a7a39c', '#8c8984'], shape: 'smoke', rise: [16, 28] },
  /** Repair: cool motes lifting off a mended surface. */
  mend: { count: 4, speed: [20, 70], life: [500, 900], size: [1.6, 2.6], grow: 0, drag: 2, spread: Math.PI, colors: ['#8ff0c4', '#e8fdff', '#8ff0c4'], shape: 'ember', rise: [30, 60] },
};

const between = ([lo, hi]: [number, number], r: number) => lo + (hi - lo) * r;

/** `scale` multiplies the count (rounded, at least one when above zero), so a busy scene can thin its bursts. */
export function burst(pool: ParticlePool, kind: BurstKind, x: number, y: number, angle: number, now: number, rand: () => number = Math.random, tint?: string, scale = 1, wind?: readonly [number, number]) {
  const b = BURSTS[kind];
  const count = scale === 1 ? b.count : scale <= 0 ? 0 : Math.max(1, Math.round(b.count * scale));
  for (let i = 0; i < count; i++) {
    const a = angle + (rand() * 2 - 1) * b.spread;
    const speed = between(b.speed, rand());
    emit(pool, {
      x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, drag: b.drag, born: now, life: between(b.life, rand()),
      size: between(b.size, rand()), grow: b.grow, color: tint && i % 3 !== 2 ? tint : b.colors[i % b.colors.length]!, shape: b.shape,
      rise: b.rise ? between(b.rise, rand()) : 0, spin: b.spin ? b.spin * (rand() < 0.5 ? -1 : 1) : 0, ...(wind && { wind }),
    });
  }
}

/**
 * A token bucket for effects: `perSec` tokens refill each second up to `max`. `take` says how many of `want` may be spent
 * now, so a horde of hundreds chewing the core thins its sparks instead of flooding the pool.
 */
export type Budget = { tokens: number; at: number; readonly perSec: number; readonly max: number };

export const createBudget = (perSec: number, max = perSec): Budget => ({ tokens: max, at: -Infinity, perSec, max });

export function take(b: Budget, now: number, want = 1): number {
  b.tokens = b.at === -Infinity ? b.max : Math.min(b.max, b.tokens + ((now - b.at) / 1000) * b.perSec);
  b.at = now;
  const got = Math.max(0, Math.min(want, Math.floor(b.tokens)));
  b.tokens -= got;
  return got;
}
