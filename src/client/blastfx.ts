/**
 * Explosion, slash, dash and engineer-dust state. Everything here is launch conditions in fixed, capped ring buffers (the
 * oldest entry is overwritten), and a frame is drawn as a pure function of `now`, so redrawing never advances anything.
 * Drawing lives in blastdraw.ts (the blast, its debris and its scorch) and grenadeart.ts (the thrown bodies).
 *
 * A blast is told in layers, as the art bible asks: a white-hot flash and a light, then the shape (fireball, shock ring,
 * dust ring), then particles (debris that tumbles and bounces, sparks, embers, a smoke column that mushrooms), then the
 * residue (cinders on the floor, lingering smoke, a scorch decal). What kind of blast it is decides the mix.
 */
import { addLight, addShockwave, type LightSpec } from './lighting.ts';
import { reducedMotion } from './screenfx.ts';

export const SMOKE_WIND = { x: 16, y: -11 } as const;

export const CAPS = { particles: 1100, blasts: 24, scorches: 32, slashes: 16, shells: 12 } as const;

export type PKind = 'spark' | 'chip' | 'stave' | 'smoke' | 'ember' | 'dust' | 'streak' | 'cinder' | 'ichor';
export type Particle = {
  x: number; y: number; vx: number; vy: number; drag: number;
  born: number; life: number; size: number; grow: number;
  kind: PKind; tone: number; rot: number; spin: number;
  /** Launch height above the floor and upward speed, px and px/s; the particle falls under GRAVITY and, with `bounce`, rebounds. */
  z0: number; vz: number; bounce: number;
};
export type BlastKind = 'pop' | 'grenade' | 'frag' | 'gas' | 'mine' | 'slug' | 'shell' | 'barrel' | 'propane' | 'bloater';
export type Blast = { x: number; y: number; r: number; born: number; seed: number; pop: boolean; kind: BlastKind; calm: boolean };
/** `tone`: 0 charred floor, 1 churned dirt (a mine), 2 ichor (a bloater), 3 oil-black (a barrel). */
export type Scorch = { x: number; y: number; r: number; born: number; seed: number; tone: number };
export type Slash = { x: number; y: number; angle: number; born: number };
/** A mortar shell on its way: it leaves (x, y) along `angle`, lands `reach` px out, and arcs high between. */
export type Shell = { x: number; y: number; angle: number; reach: number; speed: number; born: number };

export const SCORCH_MS = 15000;
export const BLAST_MS = 700;
export const SLASH_MS = 240;
export const GRAVITY = 1500;

const blank = (): Particle => ({ x: 0, y: 0, vx: 0, vy: 0, drag: 0, born: -Infinity, life: 0, size: 0, grow: 0, kind: 'spark', tone: 0, rot: 0, spin: 0, z0: 0, vz: 0, bounce: 0 });
const BLANK: Particle = blank();

type Ring<T> = { slots: T[]; next: number };
const ring = <T>(n: number, make: () => T): Ring<T> => ({ slots: Array.from({ length: n }, make), next: 0 });
function put<T extends object>(r: Ring<T>, v: Partial<T> & Record<string, unknown>, defaults?: T) {
  const slot = r.slots[r.next]!;
  if (defaults) Object.assign(slot, defaults);
  Object.assign(slot, v);
  r.next = (r.next + 1) % r.slots.length;
}

export type BlastFx = {
  particles: Ring<Particle>;
  blasts: Ring<Blast>;
  scorches: Ring<Scorch>;
  slashes: Ring<Slash>;
  shells: Ring<Shell>;
};

export function createBlastFx(caps: typeof CAPS = CAPS): BlastFx {
  return {
    particles: ring(caps.particles, blank),
    blasts: ring(caps.blasts, () => ({ x: 0, y: 0, r: 0, born: -Infinity, seed: 0, pop: false, kind: 'grenade' as BlastKind, calm: false })),
    scorches: ring(caps.scorches, () => ({ x: 0, y: 0, r: 0, born: -Infinity, seed: 0, tone: 0 })),
    slashes: ring(caps.slashes, () => ({ x: 0, y: 0, angle: 0, born: -Infinity })),
    shells: ring(caps.shells, () => ({ x: 0, y: 0, angle: 0, reach: 0, speed: 700, born: -Infinity })),
  };
}

/** The one pool the client draws from; a new match simply lets the old entries expire. */
export const fx = createBlastFx();

/** A grenade-sized pop (a gas canister, a crate) rather than a real blast: no scorch and a small puff. */
export const isPop = (r: number) => r <= 48;
export const scaleOf = (r: number) => Math.min(1.8, Math.max(0.45, r / 100));
export const easeOut = (k: number) => 1 - (1 - k) * (1 - k) * (1 - k);
export const clamp01 = (k: number) => (k < 0 ? 0 : k > 1 ? 1 : k);

/**
 * Height above the floor `t` seconds after launch: a ballistic arc that, with `bounce`, rebounds off the floor (each
 * rebound keeps that share of the speed) until it comes to rest. `grounded` says it is lying on the floor.
 */
export function heightAt(p: Pick<Particle, 'z0' | 'vz' | 'bounce'>, t: number): { z: number; grounded: boolean } {
  if (t <= 0) return { z: p.z0, grounded: false };
  let z = p.z0, v = p.vz, left = t;
  for (let i = 0; i < 5; i++) {
    const tg = (v + Math.sqrt(v * v + 2 * GRAVITY * z)) / GRAVITY;
    if (left < tg) return { z: Math.max(0, z + v * left - 0.5 * GRAVITY * left * left), grounded: false };
    left -= tg;
    v = (GRAVITY * tg - v) * p.bounce;
    z = 0;
    if (v < 60) return { z: 0, grounded: true };
  }
  return { z: 0, grounded: true };
}

export type Where = { x: number; y: number; z: number; k: number; grounded: boolean };

/** Where a particle is, how high, and how far through its life: velocity decaying at `drag` per second, smoke also riding the wind. */
export function where(p: Particle, now: number, out: Where): Where {
  const t = (now - p.born) / 1000;
  const travel = p.drag > 0 ? (1 - Math.exp(-p.drag * t)) / p.drag : t;
  const wind = p.kind === 'smoke' ? t : p.kind === 'ember' ? t * 0.6 : 0;
  out.x = p.x + p.vx * travel + SMOKE_WIND.x * wind;
  out.y = p.y + p.vy * travel + SMOKE_WIND.y * wind;
  out.k = (now - p.born) / p.life;
  if (p.z0 !== 0 || p.vz !== 0) {
    const h = heightAt(p, t);
    out.z = h.z;
    out.grounded = h.grounded;
  } else {
    out.z = 0;
    out.grounded = true;
  }
  return out;
}

/** The same as `where`, as a fresh object with the height folded into y (the screen position). */
export function at(p: Particle, now: number): { x: number; y: number; k: number } {
  const w = where(p, now, { x: 0, y: 0, z: 0, k: 0, grounded: false });
  return { x: w.x, y: w.y - w.z, k: w.k };
}

export const liveCount = (pool: Ring<Particle>, now: number) => pool.slots.reduce((n, p) => n + (now >= p.born && now - p.born < p.life ? 1 : 0), 0);

/** A tiny deterministic generator so a blast or scorch draws the same shape every frame. */
export function seeded(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const lerp = (lo: number, hi: number, r: number) => lo + (hi - lo) * r;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- what kind of blast it is

/**
 * The server's blast event carries only a position and a radius, so the kind is read from the radius, and corrected by
 * what the client saw nearby just before: a grenade, frag, gas canister or mine in flight (`noteThrown`), or a barrel, a
 * propane tank or a bloater going (`markBlast`). The radius alone can only tell the sizes apart.
 */
export function kindOfRadius(r: number): BlastKind {
  if (r <= 48) return 'pop';
  if (r <= 105) return 'slug';
  if (r <= 115) return 'bloater';
  if (r <= 142) return 'shell';
  if (r <= 165) return 'grenade';
  return 'barrel';
}

type Seen = { kind: BlastKind; x: number; y: number; at: number };
const THROWN_KIND: Record<string, BlastKind> = { grenade: 'grenade', fragGrenade: 'frag', gasGrenade: 'gas', claymore: 'mine' };
const thrownSeen = new Map<number, Seen>();
const hints: (Seen & { used: boolean })[] = [];
const HINT_MS = 500, HINT_PX = 70;

/** The thrown-body drawing tells the blast what was flying: called every frame for every live grenade, gas canister and mine. */
export function noteThrown(id: number, kind: string, x: number, y: number, now: number) {
  const k = THROWN_KIND[kind];
  if (!k) return;
  const s = thrownSeen.get(id);
  if (s) { s.x = x; s.y = y; s.at = now; s.kind = k; } else thrownSeen.set(id, { kind: k, x, y, at: now });
  if (thrownSeen.size > 48) for (const [i, o] of thrownSeen) if (now - o.at > 3000 || o.at > now + 1000) thrownSeen.delete(i);
}

function takeThrown(x: number, y: number, now: number): BlastKind | null {
  let best: number | null = null, bd = HINT_PX * HINT_PX;
  for (const [id, s] of thrownSeen) {
    const d = (s.x - x) ** 2 + (s.y - y) ** 2;
    if (now - s.at <= HINT_MS && now - s.at >= -HINT_MS && d < bd) { bd = d; best = id; }
  }
  if (best === null) return null;
  const kind = thrownSeen.get(best)!.kind;
  thrownSeen.delete(best);
  return kind;
}

/**
 * Something that explodes names itself (a barrel that vanished, a propane tank that burst, a bloater that died). If the
 * blast already started it is upgraded in place, otherwise the hint waits a moment for it.
 */
export function markBlast(kind: BlastKind, x: number, y: number, now: number) {
  for (const b of fx.blasts.slots) {
    if (b.born < now - 400 || b.born > now + 50 || b.kind === kind || (b.x - x) ** 2 + (b.y - y) ** 2 > HINT_PX * HINT_PX) continue;
    if (!['slug', 'shell', 'grenade', 'barrel', 'bloater', 'propane', 'pop'].includes(b.kind)) continue;
    b.kind = kind;
    b.pop = kind === 'pop' || kind === 'gas';
    extras(b, now, seeded(b.seed ^ 0x9e3779b9));
    return;
  }
  hints.push({ kind, x, y, at: now, used: false });
  if (hints.length > 8) hints.shift();
}

function takeHint(x: number, y: number, now: number): BlastKind | null {
  for (let i = hints.length - 1; i >= 0; i--) {
    const h = hints[i]!;
    if (now - h.at > HINT_MS) { hints.splice(i, 1); continue; }
    if ((h.x - x) ** 2 + (h.y - y) ** 2 < HINT_PX * HINT_PX) { hints.splice(i, 1); return h.kind; }
  }
  return null;
}

// ---------------------------------------------------------------- lights

/**
 * What a blast lights, in the lighting pass: a white-hot flash that is gone in a few frames, the amber glow that gutters for
 * most of a second, and a smaller warm light up in the smoke column, so the smoke is lit from inside as it climbs.
 */
export function lightsFor(kind: BlastKind, x: number, y: number, r: number): LightSpec[] {
  const small = kind === 'pop' || kind === 'gas';
  const cool = kind === 'gas' || kind === 'bloater';
  const inside = r * 0.3 + 8;
  const flash: LightSpec = { x, y, radius: r * (small ? 2.8 : 4.2), color: cool ? '#f4f0b8' : '#fff0c8', intensity: small ? 0.9 : 1.6, life: small ? 110 : 170, size: r * 0.25, inside };
  const glow: LightSpec = { x, y, radius: r * (small ? 2.2 : 3.1), color: kind === 'gas' ? '#b8d85a' : '#ff9a3c', intensity: small ? 0.7 : 1.3, life: small ? 260 : 720, flicker: 0.45, size: r * 0.3, inside };
  if (small) return [flash, glow];
  const column: LightSpec = { x: x + SMOKE_WIND.x * 0.4, y: y - r * 0.55, radius: r * 1.7, color: '#ff8a34', intensity: 0.55, life: 900, flicker: 0.5, size: r * 0.3, inside: r, shadows: false };
  return [flash, glow, column];
}

// ---------------------------------------------------------------- spawning

function spray(
  now: number, x: number, y: number, count: number, kind: PKind,
  speed: [number, number], life: [number, number], size: [number, number], grow: number, drag: number, tones: number,
  rand: () => number, opt: { delay?: number; z0?: number; vz?: [number, number]; bounce?: number; spin?: number; ring?: number; up?: [number, number]; spread?: number; tone?: number; pal?: readonly number[] } = {},
) {
  for (let i = 0; i < count; i++) {
    const a = opt.ring !== undefined ? (i / count) * TAU + (rand() - 0.5) * opt.ring : rand() * TAU, v = lerp(speed[0], speed[1], rand());
    const sx = Math.cos(a) * v, sy = Math.sin(a) * v;
    const px = opt.spread ? (rand() - 0.5) * opt.spread : 0, py = opt.spread ? (rand() - 0.5) * opt.spread * 0.6 : 0;
    put(fx.particles, {
      x: x + px, y: y + py, vx: sx, vy: sy + (opt.up ? -lerp(opt.up[0], opt.up[1], rand()) : 0), drag, born: now + (opt.delay ?? 0) * rand(), life: lerp(life[0], life[1], rand()),
      size: lerp(size[0], size[1], rand()), grow, kind, tone: opt.pal ? opt.pal[Math.floor(rand() * opt.pal.length)]! : opt.tone ?? Math.floor(rand() * tones), rot: rand() * TAU, spin: (rand() - 0.5) * (opt.spin ?? 14),
      z0: opt.z0 ?? 0, vz: opt.vz ? lerp(opt.vz[0], opt.vz[1], rand()) : 0, bounce: opt.bounce ?? 0,
    }, BLANK);
  }
}

/** Debris colours per kind. A particle's `tone` indexes DEBRIS, so one palette serves every blast in flight. */
export const CHIP_TONES: Record<BlastKind, readonly string[]> = {
  pop: ['#b4a07a', '#978562', '#6c7356'],
  grenade: ['#4f5560', '#7a6a52', '#2f2c28'],
  frag: ['#4f5560', '#7a6a52', '#2f2c28'],
  gas: ['#6c7356', '#c7d84a', '#4b5a3a'],
  mine: ['#6b5238', '#8a6f4c', '#4f5560'],
  slug: ['#4f5560', '#8a8f98', '#2f2c28'],
  shell: ['#4f5560', '#6b5238', '#2f2c28'],
  barrel: ['#a8552e', '#4f5560', '#2f2c28'],
  propane: ['#c9bfa6', '#4f5560', '#a8552e'],
  bloater: ['#8a9a5b', '#6f7a4e', '#5c6b6e'],
};
const STAVE_TONES = ['#a8552e', '#c9bfa6', '#a8552e', '#4f5560'] as const;
export const DEBRIS: string[] = [];
const debrisIndex = (c: string) => { const i = DEBRIS.indexOf(c); if (i >= 0) return i; DEBRIS.push(c); return DEBRIS.length - 1; };
const PAL = Object.fromEntries(Object.entries(CHIP_TONES).map(([k, v]) => [k, v.map(debrisIndex)])) as Record<BlastKind, number[]>;
const PAL_STAVE = STAVE_TONES.map(debrisIndex);

/** What only one kind of blast throws: shrapnel, metal staves, ichor, dirt. Also used to upgrade a blast already begun. */
function extras(b: Blast, now: number, rand: () => number) {
  const { x, y, r, kind } = b, calm = b.calm;
  const n = (v: number) => Math.max(1, Math.round(v * (calm ? 0.5 : 1)));
  switch (kind) {
    case 'frag':
      // The sixteen real fragments the sim fires, at the same angles, each with the streak it leaves.
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU;
        put(fx.particles, { x, y, vx: Math.cos(a) * 1100, vy: Math.sin(a) * 1100, drag: 0, born: now, life: 290, size: 2.2, grow: 0, kind: 'streak', tone: i % 2, rot: a, spin: 0 }, BLANK);
      }
      break;
    case 'barrel':
    case 'propane':
      spray(now, x, y, n(kind === 'barrel' ? 8 : 6), 'stave', [180, 520], [1400, 2000], [11, 18], 0, 2.4, 2, rand, { z0: 6, vz: [200, 420], bounce: 0.34, spin: 16, pal: PAL_STAVE });
      break;
    case 'bloater':
      spray(now, x, y, n(11), 'ichor', [140, 460], [1300, 2100], [3.2, 6.4], 0, 2.8, 2, rand, { z0: 6, vz: [180, 380], bounce: 0.22, pal: PAL.bloater });
      break;
    case 'shell':
      // A mortar bomb digs in: gravel thrown high and a ring of dirt along the floor.
      spray(now, x, y, n(9), 'chip', [80, 360], [900, 1500], [3.4, 6.8], 0, 3, 3, rand, { z0: 4, vz: [320, 560], bounce: 0.3, spread: 20, pal: PAL.mine });
      break;
    case 'mine':
      spray(now, x, y, n(12), 'chip', [60, 280], [900, 1500], [3.4, 6.8], 0, 3, 3, rand, { z0: 4, vz: [380, 640], bounce: 0.3, spread: 16, pal: PAL.mine });
      break;
    default:
  }
}

/** A blast: `kind` overrides what the radius and the nearby things say it is. */
export function startBoom(x: number, y: number, r: number, now: number, rand: () => number = Math.random, kind?: BlastKind) {
  const k: BlastKind = kind ?? takeThrown(x, y, now) ?? takeHint(x, y, now) ?? kindOfRadius(r);
  const pop = k === 'pop' || k === 'gas', s = scaleOf(r), calm = reducedMotion();
  const n = (v: number) => Math.max(1, Math.round(v * (calm ? 0.55 : 1)));
  for (const l of lightsFor(k, x, y, r)) addLight(calm && l.life! < 200 ? { ...l, intensity: (l.intensity ?? 1) * 0.5, life: 260 } : l);
  if (!pop && !calm) addShockwave({ x, y, radius: r * (k === 'shell' ? 2.8 : 2.4), strength: Math.min(1.2, 0.5 + r / 220) * (k === 'mine' ? 0.7 : k === 'shell' ? 1.15 : 1) });
  const seed = Math.floor(rand() * 1e9);
  const blast: Blast = { x, y, r, born: now, seed, pop, kind: k, calm };
  put(fx.blasts, blast);
  if (!pop) put(fx.scorches, { x, y, r: r * (0.5 + 0.12 * rand()) * (k === 'shell' ? 1.15 : 1), born: now, seed: Math.floor(rand() * 1e9), tone: k === 'mine' ? 1 : k === 'bloater' ? 2 : k === 'barrel' || k === 'propane' ? 3 : 0 });
  const green = k === 'gas' || k === 'bloater';

  // Ground dust, kicked outward in a ring along the floor, riding the shock ring.
  if (!(calm && pop)) spray(now, x, y, n(pop ? 6 : 9 + 6 * s), 'dust', [r * 2.4, r * 3.4], [520, 820], [r * 0.06, r * 0.1], 0.9, 3.4, 1, rand, { ring: 0.5 });
  // The smoke column: a stem that climbs, a cap that spreads (the mushroom), and low puffs that linger and drift.
  const smokeTone = green ? 2 : k === 'mine' ? 1 : k === 'shell' ? 3 : 0;
  if (pop) {
    spray(now, x, y, n(k === 'gas' ? 9 : 5), 'smoke', [30, k === 'gas' ? 130 : 70], [k === 'gas' ? 1100 : 900, k === 'gas' ? 1800 : 1400], [r * (k === 'gas' ? 0.3 : 0.14), r * (k === 'gas' ? 0.5 : 0.26)], 1.5, 2.2, 1, rand, { delay: 60, up: [10, 40], tone: k === 'gas' ? 2 : 0 });
    if (k === 'gas') {
      for (let i = 0; i < 9; i++) put(fx.particles, { x, y, vx: (rand() - 0.5) * 220, vy: (rand() - 0.5) * 160, drag: 2.6, born: now + rand() * 60, life: 900 + rand() * 600, size: r * (0.3 + rand() * 0.3), grow: 1.1, kind: 'smoke', tone: 2, rot: 0, spin: 0 }, BLANK);
      spray(now, x, y, n(7), 'chip', [120, 380], [800, 1300], [2.8, 5], 0, 3, 3, rand, { z0: 4, vz: [200, 400], bounce: 0.35, pal: PAL.gas });
    } else {
      spray(now, x, y, n(5), 'chip', [100, 320], [700, 1100], [2.4, 4.4], 0, 3.2, 3, rand, { z0: 4, vz: [180, 360], bounce: 0.35, pal: PAL.pop });
    }
    return void extras(blast, now, rand);
  }
  const stem = n(5 * s + 3), cap = n(4 * s + 2), linger = n(3 * s + 2), lingerTone = green ? 2 : 3;
  const lift = Math.sqrt(s);
  spray(now, x, y, stem, 'smoke', [6, 30], [1400, 2300], [r * 0.15, r * 0.22], 1.3, 1.2, 1, rand, { delay: 240, up: [120 * lift, 240 * lift], spread: r * 0.25, tone: smokeTone });
  for (let i = 0; i < cap; i++) {
    put(fx.particles, {
      x: x + (rand() - 0.5) * r * 0.2, y: y - r * 0.5 * lift, vx: (i % 2 ? 1 : -1) * lerp(45, 110, rand()) * lift, vy: -lerp(22, 60, rand()), drag: 1.5, born: now + 300 + 150 * rand(),
      life: lerp(1500, 2400, rand()), size: r * lerp(0.2, 0.28, rand()), grow: 1.0, kind: 'smoke', tone: smokeTone, rot: 0, spin: 0,
    }, BLANK);
  }
  spray(now, x, y, linger, 'smoke', [10, 40], [2600, 3600], [r * 0.2, r * 0.28], 0.8, 2.0, 1, rand, { delay: 420, up: [8, 26], spread: r * 0.4, tone: lingerTone });

  const heavy = k === 'shell' || k === 'barrel' ? 1.2 : 1;
  // Debris that tumbles and bounces, then lies there.
  spray(now, x, y, n((10 * s + 5) * heavy), 'chip', [160, 620], [900, 1600], [3.2, 7], 0, 2.6, 3, rand, { z0: 6, vz: [180, 460], bounce: 0.42, spin: 18, pal: PAL[k] });
  // Sparks and embers: bright, quick streaks; slow floating embers; and cinders left glowing on the floor.
  spray(now, x, y, n(16 * s + 6), 'spark', [300, 960], [260, 640], [1.4, 2.2], 0, 3.6, 2, rand, { z0: 8, vz: [60, 260] });
  spray(now, x, y, n(8 * s + 2), 'ember', [30, 190], [900, 1700], [1.4, 2.6], 0, 1.4, 1, rand, { delay: 140, up: [30, 110] });
  spray(now, x, y, n(5 * s + 3), 'cinder', [80, 300], [2400, 4200], [1.8, 3.2], 0, 3.6, 1, rand, { delay: 90, z0: 4, vz: [100, 260], bounce: 0.25 });
  extras(blast, now, rand);
}

/** A mortar shell leaving its tube. */
export function startShell(x: number, y: number, angle: number, reach: number, speed: number, now: number) {
  put(fx.shells, { x, y, angle, reach, speed, born: now });
}

export function startSlash(x: number, y: number, angle: number, now: number) {
  put(fx.slashes, { x, y, angle, born: now });
}

/** An engineer's wall going up kicks dust from along its length. */
export function startDust(rect: { x: number; y: number; w: number; h: number }, now: number, rand: () => number = Math.random) {
  for (let i = 0; i < 9; i++) {
    const px = rect.x + rect.w * rand(), py = rect.y + rect.h * rand();
    const a = rand() * Math.PI * 2, v = lerp(20, 90, rand());
    put(fx.particles, { x: px, y: py, vx: Math.cos(a) * v, vy: Math.sin(a) * v, drag: 3, born: now, life: lerp(500, 900, rand()), size: lerp(7, 13, rand()), grow: 1.1, kind: 'smoke', tone: 1, rot: 0, spin: 0 }, BLANK);
  }
}

/** Dash afterimages: recent positions of each dashing player, keyed by player id. */
export type Ghost = { x: number; y: number; t: number };
export const GHOST_MS = 260;
const GHOST_GAP = 7;
const MAX_GHOSTS = 24;
const ghosts = new Map<number, Ghost[]>();

export function trackDash(players: readonly { id: number; x: number; y: number; dashing: boolean; alive: boolean }[], now: number) {
  const seen = new Set<number>();
  for (const p of players) {
    if (!p.dashing || !p.alive) continue;
    seen.add(p.id);
    const list = ghosts.get(p.id) ?? [];
    const last = list[list.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= GHOST_GAP) list.push({ x: p.x, y: p.y, t: now });
    if (list.length > MAX_GHOSTS) list.shift();
    ghosts.set(p.id, list);
  }
  for (const [id, list] of ghosts) {
    while (list.length && now - list[0]!.t > GHOST_MS) list.shift();
    if (!list.length && !seen.has(id)) ghosts.delete(id);
  }
}

export const ghostsOf = (id: number): readonly Ghost[] => ghosts.get(id) ?? [];
export const ghostPlayers = (): IterableIterator<number> => ghosts.keys();
