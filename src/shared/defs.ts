export const WEAPON_IDS = ['pistol', 'smg', 'shotgun', 'assault', 'sniper', 'lmg'] as const;
export type WeaponId = (typeof WEAPON_IDS)[number];

export const GUN_IDS = [
  ...WEAPON_IDS,
  'handCannon', 'machinePistol', 'executioner', 'gunslinger', 'akimbo', 'hailstorm',
  'skirmisher', 'heavySmg', 'phantom', 'hornet', 'ripper', 'bulldog',
  'slugGun', 'doubleBarrel', 'railSlug', 'boomSlug', 'sawedOff', 'streetSweeper',
  'battleRifle', 'carbine', 'marksman', 'grenadier', 'specter', 'scout',
  'longshot', 'semiAuto', 'piercer', 'artillery', 'repeater', 'ghost',
  'heavyLmg', 'lightMg', 'minigun', 'juggernaut', 'ranger', 'twinMg',
] as const;
export type GunId = (typeof GUN_IDS)[number];

import { handlingOf, loadOf, walkMulOf, HANDLING, type CalibreId, type Handling } from './handling.ts';

export type Blast = { radius: number; damage: number };

/** `hands: 2` draws a whole gun in each hand rather than one gun with more barrels. */
export type GunLook = { length: number; width: number; barrels: 1 | 2 | 3; hands?: 2; accent: string; bullet: { r: number; color: string } };

export type GunDef = {
  name: string;
  desc: string;
  base: WeaponId;
  stage: 0 | 1 | 2;
  from: GunId | null;
  damage: number;
  fireMs: number;
  pellets: number;
  spread: number;
  range: number;
  bulletSpeed: number;
  mag: number;
  reloadMs: number;
  /** What it physically is (see handling.ts): weight, length and round. Its handling and how fast it lets you move are worked out from these. */
  kg: number;
  cm: number;
  calibre: CalibreId;
  /** Walk speed as a share of base with no armor, from its load (derived: `walkMulOf`; armor adds its own weight in `effectiveStats`). */
  moveMul: number;
  auto: boolean;
  /** One press fires `count` rounds `gapMs` apart, one ammo each, then waits `fireMs`. */
  burst?: { count: number; gapMs: number };
  /** Players a bullet passes through before it stops. */
  penetrate?: number;
  /** The bullet explodes wherever it stops. */
  blast?: Blast;
  silenced?: true;
  /** Hits that kill a full-health target through heavy armor; a pellet gun counts a whole point-blank blast as one hit. */
  breakpoint?: 1 | 2;
  rules?: Partial<RuleSpec>;
  /** Explicit, marked overrides of what handling.ts works out for this gun, where its role needs one. Kept rare on purpose. */
  overrides?: Partial<Handling>;
  look: GunLook;
};
/** A gun as written below: everything but what is derived from its build. */
type GunSpec = Omit<GunDef, 'moveMul'>;

/**
 * How a class handles beyond its numbers. Under `bloom` each round of a spray after the first `free` blooms spread along a curve up to
 * `maxMul` of itself (`bloomShare` in sim/stats.ts): the first adds `shape x perShot` of the spread and each later one less, so the cap is
 * reached at `(maxMul - 1) / perShot` rounds and never passed; once no shot has left for `settleMs` it comes back down the same curve to
 * nothing within `recoverMs`. `perShot`, `maxMul`, `shape`, `recoverMs` and `still` are worked out from the gun's build (handling.ts: the
 * round's kick over the gun's weight and length), as are `movingSpreadAdd`, `minSpread` and `settle`; the rules written for a gun name only
 * `free`, `tap` and `settleMs` (a burst gun's `free` is at least its burst and one more: a burst flies on its first round's cone, and a
 * held burst gun's cone is back on it before the next burst). `tap` is how many
 * rounds a disciplined tap fires (a bot's tap rhythm, the Disciplined medal). Under `spinUp` holding the trigger takes the shot interval from `startMul` times `fireMs` down to
 * `fireMs` over `upMs`, and letting go spins it back over `downMs`. `viewMul` is the gun's scope: one view bonus (`viewMul - 1`), combined with the others with diminishing returns (`VIEW`).
 */
/**
 * Moving spread is `spread + movingSpreadAdd`, the sway of carrying the gun on the move (heavy, long guns sway most); it keeps a tight sniper cone from staying a sure hit on the run.
 * Bloom grows from the round after the first `free` of a spray (fastest at first, slower as it nears its cap) and cools once no shot has left for `settleMs`, so single taps stay tight whatever the button does.
 * Every gun blooms; standing still it grows only `still` of what it grows on the move (and a set-down bipod only its `deploy.bloom`), on top of the gun's floor.
 * `steadyMs`: how long after the last step the still spread takes hold, so planting your feet is a commitment rather than a flick.
 * `plant`: when a bot stands still to shoot.
 * `pinpoint`: once steady and unsuppressed the gun has no spread at all, so a planted sniper puts every round exactly where it aims.
 * `suppress`: how much each of its rounds (each pellet, for a shotgun) suppresses an enemy it passes close to (see `SUPPRESSION`).
 * `muzzleBoost`: how much faster than `bulletSpeed` a round leaves the muzzle (see `MUZZLE` in sim/ballistics.ts).
 */
export type GunRules = {
  /** Derived: the gun's sway on the move (handling.ts `sway`). */
  movingSpreadAdd: number;
  steadyMs: number;
  plant: 'never' | 'atRange' | 'always';
  bloom: { free: number; tap: number; perShot: number; maxMul: number; shape: number; settleMs: number; recoverMs: number; still: number } | null;
  spinUp: { startMul: number; upMs: number; downMs: number } | null;
  viewMul: number;
  pinpoint: boolean;
  suppress: number;
  muzzleBoost: number;
  /**
   * Derived: the post-sprint bloom. The moment a sprint ends (you can fire at once) spread opens to `mul` times the gun's moving spread and
   * eases back over `ms` to whatever your stance gives; a light, short gun settles far faster than a heavy, long one (handling.ts `settleMs`).
   */
  settle: { mul: number; ms: number };
  /** A round's damage fades with the distance it has flown: full out to `startPx`, then down to `minMul` of itself by `endPx`, and no further. Null is no fade. */
  falloff: { startPx: number; endPx: number; minMul: number } | null;
  /** Standing still for `ms` plants the gun (a bipod set down): the still spread is `spreadMul` times itself from then on, floored at `minSpread` (radians) instead of the gun's own floor, and bloom grows `bloom` of its moving growth. Null is never. */
  deploy: { ms: number; spreadMul: number; minSpread: number; bloom: number } | null;
  /** Scales the shove each of its hits lands (see `KNOCK`). */
  shoveMul: number;
  /** Its rounds blow a swing door they strike open (a door-breaker). */
  breach: boolean;
  /** Derived: the gun's least spread (radians, half-angle) however still, planted or perked the shooter (handling.ts `floor`): no gun is ever a laser. */
  minSpread: number;
};
/** The derived parts of the rules (worked out from the gun's build); the rest is written per class and evolution. */
type Derived = 'movingSpreadAdd' | 'settle' | 'minSpread';
type BloomSpec = { free: number; tap: number; settleMs: number };
export type RuleSpec = Omit<GunRules, Derived | 'bloom'> & { bloom: BloomSpec | null };

const STEADY: RuleSpec = { steadyMs: 0, plant: 'never', bloom: null, spinUp: null, viewMul: 1, pinpoint: false, suppress: 0, muzzleBoost: 4, falloff: null, deploy: null, shoveMul: 1, breach: false };
/**
 * A full-auto class's bloom `settleMs` sits just past the longest gap between held rounds of any gun in it (the Heavy SMG's and Ripper's 100 ms,
 * the Juggernaut's 133 ms at full spin, the assault rifle's 133 ms, each on the 30 Hz tick), so a held trigger never cools between rounds but a
 * let-go one starts cooling at once: a short pause between bursts is not spent waiting for the bloom to start coming down.
 */
export const GUN_RULES: Record<WeaponId, RuleSpec> = {
  // Sidearm: settles fast off a sprint and no worse on the run than standing.
  pistol: { ...STEADY, suppress: 0.04, bloom: { free: 5, tap: 5, settleMs: 160 } },
  // Rusher: no penalty for moving, the post-sprint bloom settles fast, bloom comes quickly and the rounds fade hard past ~350 px.
  smg: { ...STEADY, suppress: 0.05, bloom: { free: 1, tap: 4, settleMs: 105 }, falloff: { startPx: 180, endPx: 380, minMul: 0.3 } },
  // Door-breaker: the blast fades past 130 px, shoves, and a pellet that strikes a swing door blows it open.
  shotgun: { ...STEADY, suppress: 0.02, falloff: { startPx: 170, endPx: 400, minMul: 0.3 }, shoveMul: 1.5, breach: true, bloom: { free: 2, tap: 5, settleMs: 300 } },
  // Anchor: laser-straight standing and tapping, drifting if sprayed or run with, slow to settle off a sprint.
  assault: { ...STEADY, steadyMs: 120, suppress: 0.08, bloom: { free: 1, tap: 3, settleMs: 140 } },
  sniper: { ...STEADY, steadyMs: 450, plant: 'always', viewMul: 1.28, pinpoint: true, suppress: 0.3, muzzleBoost: 0.4, bloom: { free: 1, tap: 1, settleMs: 400 } },
  // Suppression: revs up, plants down for a tight lane, pins whoever it fires near, and is slow to run with or settle off a sprint.
  lmg: { ...STEADY, steadyMs: 200, plant: 'atRange', suppress: 0.16, bloom: { free: 1, tap: 4, settleMs: 140 }, spinUp: { startMul: 1.5, upMs: 350, downMs: 600 } },
};


const BASE_BULLET = { r: 1.6, color: '#25211c' };
const BASE_LOOK: GunLook = { length: 1, width: 1, barrels: 1, accent: '#7b8494', bullet: BASE_BULLET };

const GUN_SPECS: Record<GunId, GunSpec> = {
  pistol: { name: 'Pistol', desc: 'Quick off a sprint, steady on the run', base: 'pistol', stage: 0, from: null, damage: 25, fireMs: 200, pellets: 1, spread: 0.04, range: 700, bulletSpeed: 900, mag: 12, reloadMs: 1000, kg: 0.9, cm: 20, calibre: '9mm', auto: false, look: BASE_LOOK },
  handCannon: { name: 'Hand Cannon', desc: 'Slow, heavy hits that shove them back; two drop any armor', base: 'pistol', stage: 1, from: 'pistol', damage: 66, fireMs: 480, pellets: 1, spread: 0.025, range: 780, bulletSpeed: 990, mag: 6, reloadMs: 1300, kg: 1.8, cm: 30, calibre: '.44 Mag', auto: false, breakpoint: 2,
    rules: { shoveMul: 2.2 },
    look: { length: 1.2, width: 1.3, barrels: 1, accent: '#c8553d', bullet: { r: 2.6, color: '#7a2e1f' } } },
  machinePistol: { name: 'Machine Pistol', desc: 'Three-round bursts you can fire at a run', base: 'pistol', stage: 1, from: 'pistol', damage: 28, fireMs: 380, pellets: 1, spread: 0.055, range: 600, bulletSpeed: 900, mag: 24, reloadMs: 1000, kg: 1.4, cm: 30, calibre: '9mm', auto: false, burst: { count: 3, gapMs: 60 },
    rules: { falloff: { startPx: 250, endPx: 450, minMul: 0.5 } },
    look: { length: 1.1, width: 1, barrels: 1, accent: '#3fa7b5', bullet: { r: 1.6, color: '#1f5560' } } },
  executioner: { name: 'Executioner', desc: 'Plant your feet: one round punches through two bodies', base: 'pistol', stage: 2, from: 'handCannon', damage: 93, fireMs: 520, pellets: 1, spread: 0.018, range: 950, bulletSpeed: 1250, mag: 5, reloadMs: 1500, kg: 2, cm: 32, calibre: '.50 AE', auto: false, penetrate: 1, breakpoint: 2,
    rules: { steadyMs: 180, shoveMul: 2.5, viewMul: 1.05 },
    look: { length: 1.45, width: 1.35, barrels: 1, accent: '#e5484d', bullet: { r: 3.2, color: '#b3261e' } } },
  gunslinger: { name: 'Gunslinger', desc: 'Fast-draw revolver: strong inside 350, light on its feet', base: 'pistol', stage: 2, from: 'handCannon', damage: 66, fireMs: 300, pellets: 1, spread: 0.04, range: 600, bulletSpeed: 960, mag: 6, reloadMs: 1100, kg: 1.1, cm: 26, calibre: '.357', auto: false, breakpoint: 2,
    rules: { shoveMul: 1.4, falloff: { startPx: 320, endPx: 560, minMul: 0.55 } },
    look: { length: 1.05, width: 1.2, barrels: 1, accent: '#3fa7b5', bullet: { r: 2.4, color: '#1f5560' } } },
  akimbo: { name: 'Akimbo', desc: 'Two pistols: a wide six-round burst, brutal up close', base: 'pistol', stage: 2, from: 'machinePistol', damage: 13, fireMs: 330, pellets: 2, spread: 0.085, range: 540, bulletSpeed: 900, mag: 36, reloadMs: 1700, kg: 2.4, cm: 22, calibre: '9mm', auto: false, burst: { count: 3, gapMs: 55 },
    rules: { falloff: { startPx: 200, endPx: 420, minMul: 0.4 } },
    look: { length: 1.05, width: 1, barrels: 1, hands: 2, accent: '#30c0a0', bullet: { r: 1.7, color: '#11806a' } } },
  hailstorm: { name: 'Hailstorm', desc: 'Full-auto stream that pins enemies down', base: 'pistol', stage: 2, from: 'machinePistol', damage: 15, fireMs: 85, pellets: 1, spread: 0.07, range: 640, bulletSpeed: 900, mag: 45, reloadMs: 1400, kg: 2, cm: 40, calibre: '9mm', auto: true,
    rules: { falloff: null, bloom: { free: 1, tap: 4, settleMs: 150 }, suppress: 0.12 },
    look: { length: 1.25, width: 1.1, barrels: 1, accent: '#5b8def', bullet: { r: 1.7, color: '#2b55b8' } } },

  smg: { name: 'SMG', desc: 'Run-and-gun rusher: deadly up close, fades fast past 350', base: 'smg', stage: 0, from: null, damage: 17, fireMs: 66, pellets: 1, spread: 0.11, range: 520, bulletSpeed: 840, mag: 32, reloadMs: 1300, kg: 2.3, cm: 50, calibre: '9mm', auto: true, look: BASE_LOOK },
  skirmisher: { name: 'Skirmisher', desc: 'Fastest feet in the fight: flank and close', base: 'smg', stage: 1, from: 'smg', damage: 15, fireMs: 56, pellets: 1, spread: 0.11, range: 480, bulletSpeed: 870, mag: 30, reloadMs: 1100, kg: 1.5, cm: 40, calibre: '4.6mm', auto: true,
    look: { length: 0.9, width: 0.95, barrels: 1, accent: '#3fa7b5', bullet: { r: 1.5, color: '#1f5560' } } },
  heavySmg: { name: 'Heavy SMG', desc: 'Tighter and harder-hitting: stand and trade', base: 'smg', stage: 1, from: 'smg', damage: 19, fireMs: 85, pellets: 1, spread: 0.08, range: 620, bulletSpeed: 900, mag: 30, reloadMs: 1500, kg: 4.2, cm: 72, calibre: '.45 ACP', auto: true,
    rules: { falloff: { startPx: 260, endPx: 500, minMul: 0.45 } },
    look: { length: 1.15, width: 1.2, barrels: 1, accent: '#c8553d', bullet: { r: 2, color: '#7a2e1f' } } },
  phantom: { name: 'Phantom', desc: 'Suppressed: heard only up close, never pinged. Strike from behind', base: 'smg', stage: 2, from: 'skirmisher', damage: 17, fireMs: 60, pellets: 1, spread: 0.11, range: 460, bulletSpeed: 870, mag: 30, reloadMs: 1100, kg: 1.8, cm: 50, calibre: '4.6mm', auto: true, silenced: true,
    rules: { falloff: { startPx: 170, endPx: 340, minMul: 0.3 } },
    look: { length: 1.15, width: 0.9, barrels: 1, accent: '#8e4ec6', bullet: { r: 1.4, color: '#5a2d85' } } },
  hornet: { name: 'Hornet', desc: 'Shreds anything at arm\'s length and empties in under two seconds', base: 'smg', stage: 2, from: 'skirmisher', damage: 11, fireMs: 31, pellets: 1, spread: 0.13, range: 460, bulletSpeed: 870, mag: 56, reloadMs: 900, kg: 2.6, cm: 50, calibre: '5.7mm', auto: true,
    rules: { bloom: { free: 1, tap: 3, settleMs: 120 }, falloff: { startPx: 180, endPx: 340, minMul: 0.3 } },
    look: { length: 1, width: 1.05, barrels: 1, accent: '#f5c400', bullet: { r: 1.5, color: '#a88600' } } },
  ripper: { name: 'Ripper', desc: 'Rounds punch through a body; reaches farthest of the SMGs', base: 'smg', stage: 2, from: 'heavySmg', damage: 21, fireMs: 85, pellets: 1, spread: 0.075, range: 680, bulletSpeed: 960, mag: 30, reloadMs: 1600, kg: 4, cm: 72, calibre: '5.7mm', auto: true, penetrate: 1,
    rules: { falloff: { startPx: 280, endPx: 540, minMul: 0.5 } },
    look: { length: 1.3, width: 1.25, barrels: 1, accent: '#e5484d', bullet: { r: 2.2, color: '#b3261e' } } },
  bulldog: { name: 'Bulldog', desc: 'Sixty-round drum: outlasts a whole squad', base: 'smg', stage: 2, from: 'heavySmg', damage: 18, fireMs: 75, pellets: 1, spread: 0.09, range: 580, bulletSpeed: 900, mag: 60, reloadMs: 2400, kg: 6.8, cm: 75, calibre: '.45 ACP', auto: true,
    rules: { falloff: { startPx: 240, endPx: 460, minMul: 0.4 }, suppress: 0.09 },
    look: { length: 1.15, width: 1.4, barrels: 1, accent: '#5b8def', bullet: { r: 2, color: '#2b55b8' } } },

  shotgun: { name: 'Shotgun', desc: 'Door-breaker: devastating inside 200, blows swing doors open', base: 'shotgun', stage: 0, from: null, damage: 17, fireMs: 800, pellets: 8, spread: 0.19, range: 420, bulletSpeed: 780, mag: 5, reloadMs: 1800, kg: 3.4, cm: 100, calibre: '12 ga', auto: false, breakpoint: 1, look: BASE_LOOK },
  slugGun: { name: 'Slug Gun', desc: 'One heavy slug: holds a mid-range lane, two hits drop anything', base: 'shotgun', stage: 1, from: 'shotgun', damage: 70, fireMs: 560, pellets: 1, spread: 0.015, range: 800, bulletSpeed: 1080, mag: 6, reloadMs: 1800, kg: 3.4, cm: 100, calibre: '12 ga slug', auto: false, breakpoint: 2,
    rules: { falloff: null, steadyMs: 80, shoveMul: 1.2 },
    look: { length: 1.2, width: 0.9, barrels: 1, accent: '#c8553d', bullet: { r: 3, color: '#7a2e1f' } } },
  doubleBarrel: { name: 'Double Barrel', desc: 'Two blasts back to back, then a long reload', base: 'shotgun', stage: 1, from: 'shotgun', damage: 19, fireMs: 260, pellets: 9, spread: 0.22, range: 440, bulletSpeed: 780, mag: 2, reloadMs: 1500, kg: 3.2, cm: 110, calibre: '12 ga', auto: false, breakpoint: 1,
    rules: { falloff: { startPx: 150, endPx: 380, minMul: 0.3 }, shoveMul: 1.8 },
    look: { length: 0.95, width: 1.1, barrels: 2, accent: '#3fa7b5', bullet: { r: 1.7, color: '#1f5560' } } },
  railSlug: { name: 'Rail Slug', desc: 'Hypersonic slug through two bodies, down any lane', base: 'shotgun', stage: 2, from: 'slugGun', damage: 75, fireMs: 540, pellets: 1, spread: 0.01, range: 950, bulletSpeed: 2400, mag: 5, reloadMs: 1900, kg: 4.2, cm: 115, calibre: '12 ga slug', auto: false, penetrate: 2, breakpoint: 2,
    rules: { falloff: null, steadyMs: 200, viewMul: 1.05 },
    look: { length: 1.5, width: 0.85, barrels: 1, accent: '#e5484d', bullet: { r: 2.6, color: '#ff3b30' } } },
  boomSlug: { name: 'Boom Slug', desc: 'Explodes on impact: flush cover, blow doors, splash two', base: 'shotgun', stage: 2, from: 'slugGun', damage: 55, fireMs: 540, pellets: 1, spread: 0.02, range: 700, bulletSpeed: 900, mag: 5, reloadMs: 1900, kg: 3.8, cm: 105, calibre: '12 ga slug', auto: false, blast: { radius: 90, damage: 45 }, breakpoint: 2,
    rules: { falloff: null },
    look: { length: 1.2, width: 1.25, barrels: 1, accent: '#f76b15', bullet: { r: 3.8, color: '#e0661a' } } },
  sawedOff: { name: 'Sawed-off', desc: 'Both barrels at arm\'s reach: sprint in and delete', base: 'shotgun', stage: 2, from: 'doubleBarrel', damage: 20, fireMs: 300, pellets: 18, spread: 0.3, range: 360, bulletSpeed: 780, mag: 1, reloadMs: 1300, kg: 2.2, cm: 55, calibre: '12 ga', auto: false, breakpoint: 1,
    rules: { falloff: { startPx: 120, endPx: 320, minMul: 0.2 }, shoveMul: 2.2 },
    look: { length: 0.75, width: 1.3, barrels: 2, accent: '#c8553d', bullet: { r: 1.8, color: '#7a2e1f' } } },
  streetSweeper: { name: 'Street Sweeper', desc: 'Automatic drum: holds a doorway, but never one-shots', base: 'shotgun', stage: 2, from: 'doubleBarrel', damage: 17, fireMs: 300, pellets: 7, spread: 0.24, range: 400, bulletSpeed: 780, mag: 12, reloadMs: 2600, kg: 5.5, cm: 95, calibre: '12 ga', auto: true,
    rules: { falloff: { startPx: 130, endPx: 340, minMul: 0.2 }, shoveMul: 1.2 },
    look: { length: 1.15, width: 1.35, barrels: 1, accent: '#5b8def', bullet: { r: 1.7, color: '#2b55b8' } } },

  assault: { name: 'Assault', desc: 'Anchor: stand and tap threes for lasers; spray and it drifts', base: 'assault', stage: 0, from: null, damage: 17, fireMs: 110, pellets: 1, spread: 0.035, range: 800, bulletSpeed: 1050, mag: 30, reloadMs: 1500, kg: 3.6, cm: 90, calibre: '5.56mm', auto: true, look: BASE_LOOK },
  battleRifle: { name: 'Battle Rifle', desc: 'Heavy three-round bursts at range; one clean burst drops the unarmored', base: 'assault', stage: 1, from: 'assault', damage: 34, fireMs: 680, pellets: 1, spread: 0.03, range: 900, bulletSpeed: 1100, mag: 24, reloadMs: 1700, kg: 4.4, cm: 100, calibre: '7.62x51', auto: true, burst: { count: 3, gapMs: 70 },
    rules: { viewMul: 1.05 },
    look: { length: 1.15, width: 1.1, barrels: 1, accent: '#c8553d', bullet: { r: 2, color: '#7a2e1f' } } },
  carbine: { name: 'Carbine', desc: 'Double-tap on the move: stays accurate while you strafe', base: 'assault', stage: 1, from: 'assault', damage: 21, fireMs: 280, pellets: 1, spread: 0.045, range: 760, bulletSpeed: 1050, mag: 30, reloadMs: 1200, kg: 2.9, cm: 76, calibre: '5.56mm', auto: true, burst: { count: 2, gapMs: 55 },
    rules: { steadyMs: 0 },
    look: { length: 0.9, width: 0.95, barrels: 1, accent: '#3fa7b5', bullet: { r: 1.6, color: '#1f5560' } } },
  marksman: { name: 'Marksman', desc: 'Semi-auto three-taps: accurate shots from 500 to 900', base: 'assault', stage: 2, from: 'battleRifle', damage: 42, fireMs: 270, pellets: 1, spread: 0.02, range: 900, bulletSpeed: 1400, mag: 14, reloadMs: 1700, kg: 4.5, cm: 105, calibre: '7.62x51', auto: false,
    rules: { bloom: { free: 3, tap: 5, settleMs: 300 }, steadyMs: 100, viewMul: 1.07 },
    look: { length: 1.4, width: 1, barrels: 1, accent: '#e5484d', bullet: { r: 2.4, color: '#b3261e' } } },
  grenadier: { name: 'Grenadier', desc: 'Bursts of exploding rounds: punish anyone behind a corner', base: 'assault', stage: 2, from: 'battleRifle', damage: 24, fireMs: 560, pellets: 1, spread: 0.05, range: 720, bulletSpeed: 900, mag: 18, reloadMs: 1800, kg: 6, cm: 105, calibre: '7.62x51', auto: true, burst: { count: 3, gapMs: 70 }, blast: { radius: 55, damage: 14 },
    look: { length: 1.2, width: 1.35, barrels: 1, accent: '#f76b15', bullet: { r: 2.8, color: '#e0661a' } } },
  specter: { name: 'Specter', desc: 'Suppressed double-tap: heard only up close', base: 'assault', stage: 2, from: 'carbine', damage: 24, fireMs: 280, pellets: 1, spread: 0.045, range: 740, bulletSpeed: 1050, mag: 30, reloadMs: 1200, kg: 3, cm: 85, calibre: '5.56mm', auto: true, burst: { count: 2, gapMs: 55 }, silenced: true,
    look: { length: 1.2, width: 0.9, barrels: 1, accent: '#8e4ec6', bullet: { r: 1.5, color: '#5a2d85' } } },
  scout: { name: 'Scout', desc: 'Scoped carbine: sees farther, double-taps from 950', base: 'assault', stage: 2, from: 'carbine', damage: 24, fireMs: 300, pellets: 1, spread: 0.03, range: 950, bulletSpeed: 1160, mag: 25, reloadMs: 1300, kg: 3.4, cm: 88, calibre: '6.5mm', auto: true, burst: { count: 2, gapMs: 55 },
    rules: { viewMul: 1.12, steadyMs: 100 },
    look: { length: 1.2, width: 0.95, barrels: 1, accent: '#3fa7b5', bullet: { r: 1.7, color: '#1f5560' } } },

  sniper: { name: 'Bolt-action', desc: 'Long-range pick: one shot drops the unarmored, two any armor; plant your feet', base: 'sniper', stage: 0, from: null, damage: 105, fireMs: 1750, pellets: 1, spread: 0.01, range: 1200, bulletSpeed: 1760, mag: 5, reloadMs: 2200, kg: 6.5, cm: 120, calibre: '.338', auto: false, breakpoint: 2, look: BASE_LOOK },
  longshot: { name: 'Longshot', desc: 'Heavier, farther: one shot drops light armor, with a bigger scope', base: 'sniper', stage: 1, from: 'sniper', damage: 115, fireMs: 1920, pellets: 1, spread: 0.008, range: 1300, bulletSpeed: 2560, mag: 5, reloadMs: 2100, kg: 10.5, cm: 130, calibre: '.338', auto: false, breakpoint: 2,
    rules: { viewMul: 1.33, shoveMul: 2.5 },
    look: { length: 1.2, width: 1.05, barrels: 1, accent: '#c8553d', bullet: { r: 2.2, color: '#7a2e1f' } } },
  semiAuto: { name: 'Semi-auto Rifle', desc: 'Two hits drop any armor, with quick follow-ups', base: 'sniper', stage: 1, from: 'sniper', damage: 68, fireMs: 390, pellets: 1, spread: 0.015, range: 1150, bulletSpeed: 2000, mag: 10, reloadMs: 1900, kg: 5, cm: 110, calibre: '7.62x51', auto: false, breakpoint: 2,
    rules: { steadyMs: 250, bloom: { free: 2, tap: 2, settleMs: 400 } },
    look: { length: 1, width: 1.1, barrels: 1, accent: '#3fa7b5', bullet: { r: 1.8, color: '#1f5560' } } },
  piercer: { name: 'Piercer', desc: 'Rounds pass through three bodies and one-shot medium armor: punish a lane', base: 'sniper', stage: 2, from: 'longshot', damage: 125, fireMs: 1920, pellets: 1, spread: 0.006, range: 1400, bulletSpeed: 2880, mag: 5, reloadMs: 2200, kg: 10, cm: 135, calibre: '.50 BMG', auto: false, penetrate: 3, breakpoint: 2,
    rules: { viewMul: 1.36 },
    look: { length: 1.45, width: 1, barrels: 1, accent: '#e5484d', bullet: { r: 2.4, color: '#ff3b30' } } },
  artillery: { name: 'Artillery', desc: 'Slow shells with a wide blast: flush cover, blow doors', base: 'sniper', stage: 2, from: 'longshot', damage: 35, fireMs: 1700, pellets: 1, spread: 0.01, range: 1300, bulletSpeed: 1440, mag: 4, reloadMs: 2300, kg: 10, cm: 135, calibre: '.50 BMG', auto: false, blast: { radius: 130, damage: 80 }, breakpoint: 2,
    look: { length: 1.3, width: 1.45, barrels: 1, accent: '#f76b15', bullet: { r: 4, color: '#e0661a' } } },
  repeater: { name: 'Repeater', desc: 'Fastest follow-ups: shoot while you jog', base: 'sniper', stage: 2, from: 'semiAuto', damage: 55, fireMs: 250, pellets: 1, spread: 0.018, range: 1100, bulletSpeed: 2080, mag: 14, reloadMs: 1800, kg: 3.4, cm: 95, calibre: '7.62x39', auto: false,
    rules: { steadyMs: 100, viewMul: 1.2, bloom: { free: 2, tap: 2, settleMs: 300 } },
    look: { length: 1.05, width: 1.2, barrels: 1, accent: '#5b8def', bullet: { r: 1.9, color: '#2b55b8' } } },
  ghost: { name: 'Ghost', desc: 'Suppressed marksman rifle: plants in a heartbeat', base: 'sniper', stage: 2, from: 'semiAuto', damage: 68, fireMs: 390, pellets: 1, spread: 0.012, range: 1150, bulletSpeed: 2080, mag: 10, reloadMs: 1900, kg: 4.8, cm: 118, calibre: '7.62x51', auto: false, silenced: true, breakpoint: 2,
    rules: { steadyMs: 150 },
    look: { length: 1.25, width: 0.95, barrels: 1, accent: '#8e4ec6', bullet: { r: 1.6, color: '#5a2d85' } } },

  lmg: { name: 'LMG', desc: 'Belt-fed: rev up and hose a lane', base: 'lmg', stage: 0, from: null, damage: 17, fireMs: 90, pellets: 1, spread: 0.055, range: 850, bulletSpeed: 960, mag: 100, reloadMs: 3500, kg: 9, cm: 110, calibre: '7.62x51', auto: true, look: BASE_LOOK },
  heavyLmg: { name: 'Heavy LMG', desc: 'Bipod: stand half a second and it locks in tight', base: 'lmg', stage: 1, from: 'lmg', damage: 23, fireMs: 100, pellets: 1, spread: 0.055, range: 900, bulletSpeed: 1020, mag: 100, reloadMs: 3800, kg: 10, cm: 112, calibre: '7.62x51', auto: true,
    rules: { deploy: { ms: 500, spreadMul: 0.35, minSpread: 0.012, bloom: 0.3 }, suppress: 0.22 },
    look: { length: 1.15, width: 1.2, barrels: 1, accent: '#c8553d', bullet: { r: 2.1, color: '#7a2e1f' } } },
  lightMg: { name: 'Light MG', desc: 'Fires from the hip on the walk, no rev-up', base: 'lmg', stage: 1, from: 'lmg', damage: 15, fireMs: 75, pellets: 1, spread: 0.07, range: 800, bulletSpeed: 960, mag: 80, reloadMs: 3000, kg: 6.5, cm: 100, calibre: '5.56mm', auto: true,
    rules: { spinUp: null, deploy: null },
    look: { length: 0.95, width: 0.95, barrels: 1, accent: '#3fa7b5', bullet: { r: 1.6, color: '#1f5560' } } },
  minigun: { name: 'Minigun', desc: 'Revs for a second, then a torrent of lead; too heavy to sprint', base: 'lmg', stage: 2, from: 'heavyLmg', damage: 16, fireMs: 33, pellets: 1, spread: 0.065, range: 900, bulletSpeed: 960, mag: 200, reloadMs: 4500, kg: 18, cm: 90, calibre: '7.62x51', auto: true,
    rules: { spinUp: { startMul: 2.5, upMs: 900, downMs: 800 }, deploy: { ms: 700, spreadMul: 0.7, minSpread: 0.012, bloom: 0.3 } },
    look: { length: 1.2, width: 1.25, barrels: 3, accent: '#f5c400', bullet: { r: 1.6, color: '#a88600' } } },
  juggernaut: { name: 'Juggernaut', desc: 'Biggest rounds: plant a fortress and own the lane', base: 'lmg', stage: 2, from: 'heavyLmg', damage: 30, fireMs: 105, pellets: 1, spread: 0.05, range: 900, bulletSpeed: 1080, mag: 150, reloadMs: 4500, kg: 10, cm: 115, calibre: '.338', auto: true,
    rules: { spinUp: null, deploy: { ms: 450, spreadMul: 0.3, minSpread: 0.012, bloom: 0.3 }, suppress: 0.25 },
    look: { length: 1.3, width: 1.45, barrels: 1, accent: '#e5484d', bullet: { r: 2.3, color: '#b3261e' } } },
  ranger: { name: 'Ranger', desc: 'Lightest MG: keeps pace and stays accurate on the move', base: 'lmg', stage: 2, from: 'lightMg', damage: 16, fireMs: 75, pellets: 1, spread: 0.06, range: 800, bulletSpeed: 990, mag: 75, reloadMs: 2400, kg: 4.5, cm: 90, calibre: '5.56mm', auto: true,
    rules: { suppress: 0.1 },
    look: { length: 1, width: 0.95, barrels: 1, accent: '#3fa7b5', bullet: { r: 1.6, color: '#1f5560' } } },
  twinMg: { name: 'Twin MG', desc: 'Paired barrels: double the rounds, double the pinning', base: 'lmg', stage: 2, from: 'lightMg', damage: 11, fireMs: 85, pellets: 2, spread: 0.09, range: 760, bulletSpeed: 960, mag: 100, reloadMs: 3200, kg: 11, cm: 110, calibre: '5.56mm', auto: true,
    rules: { suppress: 0.12 },
    look: { length: 1.05, width: 1.3, barrels: 2, accent: '#30c0a0', bullet: { r: 1.7, color: '#11806a' } } },
};

/** The guns, each with its walk speed worked out from its weight and length (see handling.ts). */
export const GUNS: Record<GunId, GunDef> = byGun((id) => ({ ...GUN_SPECS[id], moveMul: walkMulOf(loadOf(GUN_SPECS[id].kg, GUN_SPECS[id].cm, 0)) }));

export function byGun<T>(f: (id: GunId) => T): Record<GunId, T> {
  const out: Partial<Record<GunId, T>> = {};
  for (const id of GUN_IDS) out[id] = f(id);
  return out as Record<GunId, T>;
}

/** An evolution keeps its parent's written rules and overrides only what it names, so a Specter plants like the Carbine it came from. */
const specOf = (def: GunSpec): RuleSpec => ({ ...(def.from ? specOf(GUN_SPECS[def.from]) : GUN_RULES[def.base]), ...def.rules });
/** Rounds per second on a held trigger, a burst averaged out. */
export const roundsPerSec = (def: { fireMs: number; burst?: { count: number; gapMs: number } }): number => 1000 / (def.burst ? ((def.burst.count - 1) * def.burst.gapMs + def.fireMs) / def.burst.count : def.fireMs);
/** What handling.ts works out for this gun from its build, with its explicit `overrides` on top. */
export const handlingOfGun = (def: GunSpec): Handling => {
  const spec = specOf(def);
  const h = handlingOf({ kg: def.kg, cm: def.cm, calibre: def.calibre, spread: def.spread, rps: roundsPerSec(def), pinpoint: spec.pinpoint, bolt: def.base === 'sniper' && def.fireMs >= 1000,
    rounds: def.base === 'shotgun' ? 1 : def.pellets });
  const settleMs = def.base === 'shotgun' ? Math.round(h.settleMs * HANDLING.shotgunSettleMul) : h.settleMs;
  return { ...h, settleMs, ...def.overrides };
};
const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;
/** The written rules with the derived ones filled in: sway, floor, the post-sprint settle and the bloom's kick (relative to the gun's spread), cap, recovery and standing share. */
function resolveRules(def: GunSpec): GunRules {
  const spec = specOf(def), h = handlingOfGun(def);
  const bloom = spec.bloom && {
    ...spec.bloom, free: Math.max(spec.bloom.free, def.burst ? def.burst.count + 1 : 1),
    perShot: round4(h.kick / def.spread), maxMul: round4(1 + h.cap / def.spread), shape: h.shape, recoverMs: h.recoverMs, still: h.still,
  };
  return { ...spec, bloom, movingSpreadAdd: h.sway, minSpread: h.floor, settle: { mul: HANDLING.sprintBloom, ms: h.settleMs } };
}
const RULES = new Map(GUN_IDS.map((id) => [GUNS[id], resolveRules(GUN_SPECS[id])]));
export const rulesOf = (def: GunDef): GunRules => RULES.get(def)!;

/**
 * The least spread (radians) this gun ever fires with: its own floor (handling.ts), or a set-down bipod's small floor while `deployed`.
 * A planted sniper is pinpoint down to this, so a centred shot still lands at 1000 px but one on a strafing body's edge can miss.
 */
export const minSpreadOf = (def: GunDef, deployed = false): number => {
  const rules = rulesOf(def);
  return deployed && rules.deploy ? rules.deploy.minSpread : rules.minSpread;
};

export const EVOLUTIONS: Record<GunId, readonly GunId[]> = byGun((id) => GUN_IDS.filter((child) => GUNS[child].from === id));

export const ARMOR_IDS = ['none', 'light', 'medium', 'heavy'] as const;
export type ArmorId = (typeof ARMOR_IDS)[number];
/** `kg`: what the armor weighs; it adds to the load you carry (see handling.ts `loadOf`), slowing your walk and your sprint. */
export const ARMORS: Record<ArmorId, { name: string; blockFrac: number; kg: number }> = {
  none: { name: 'No armor', blockFrac: 0, kg: 0 },
  light: { name: 'Light', blockFrac: 0.08, kg: 3 },
  medium: { name: 'Medium', blockFrac: 0.16, kg: 6 },
  heavy: { name: 'Heavy', blockFrac: 0.24, kg: 9 },
};

/** The least share of base speed any load can leave you, so the heaviest loadout is slow but still moves (about 148 px/s). */
export const LOAD_SPEED_FLOOR = HANDLING.load.floor;
/** The share of base walk speed a loadout gives: its gun's weight and length and its armor's weight (see handling.ts). */
export const loadoutWalkMul = (gun: GunDef, armor: ArmorId): number => walkMulOf(loadOf(gun.kg, gun.cm, ARMORS[armor].kg));

/**
 * Sprint: held with movement, it multiplies move speed by up to `speedMul` (after the loadout floor, so Lightweight stacks) and lowers the gun.
 * You cannot fire while sprinting (a click ends the sprint and fires), but you can reload. There is no wait once it ends: the gun fires at
 * once, but wild. The post-sprint bloom opens spread to `settleMul` times the gun's moving spread (wider than any walk) and eases it out
 * (quadratically) over the gun's settle time to whatever your stance gives, walking or standing. The settle time comes from the gun's
 * build (handling.ts `settleMs`): a light, short gun is steady almost at once (a pistol ~0.3 s, an SMG ~0.6 s), a heavy, long one swings
 * for seconds (an assault rifle 2 s, a sniper or LMG ~2.5 s). How much faster than a walk you sprint comes from your load (`sprintShareOf`).
 */
export const SPRINT = { speedMul: 1.65, settleMul: HANDLING.sprintBloom } as const;
/**
 * Spread never jumps: every change of it (a stance, a sprint, a perk, suppression, a gun swap) eases in over at least `ms`, the same on
 * the server and on your reticle. Only a shot's own bloom kick lands at once (it still comes back down over at least `ms`).
 */
export const SPREAD_EASE = { ms: 250 } as const;
/** How wild this gun is the moment a sprint ends (`mul` times its moving spread) and how long it takes to settle (`ms`, before perks). */
export const settleRulesOf = (def: GunDef): { mul: number; ms: number } => rulesOf(def).settle;
/** How many of the tier-2 pool a level-up offers, drawn per life. */
export const TIER2_OFFER = 4;

export const COLOR_IDS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type ColorId = (typeof COLOR_IDS)[number];
export const byColor = <T>(f: (c: ColorId) => T) => Object.fromEntries(COLOR_IDS.map((c) => [c, f(c)])) as Record<ColorId, T>;
export const COLORS: Record<ColorId, string> = {
  red: '#e5484d', orange: '#f76b15', yellow: '#f5c400', green: '#30a46c', blue: '#3e63dd', purple: '#8e4ec6',
};

export const PERK_TIERS = {
  1: ['optics', 'thermal', 'ghillie', 'piercing', 'extended', 'grip', 'silencer', 'lightweight', 'longRange', 'quickReload', 'choke'],
  2: ['shield', 'thickSkin', 'firstAid', 'marathon', 'steadyHands', 'secondWind', 'adrenaline', 'bloodlust', 'recon', 'ninja', 'overclock', 'demolitions', 'fastHands', 'tracker', 'brace'],
  3: ['grenade', 'fragGrenade', 'gasGrenade', 'landMine', 'knife', 'engineer', 'dash', 'flashbang', 'smokeGrenade'],
} as const;
export type Tier = keyof typeof PERK_TIERS;
export type PerkId = (typeof PERK_TIERS)[Tier][number];
export type AbilityId = (typeof PERK_TIERS)[3][number];

export const PERK_INFO: Record<PerkId, { name: string; desc: string }> = {
  optics: { name: 'Optics', desc: '+12% view radius (view bonuses stack with diminishing returns)' },
  thermal: { name: 'Thermal', desc: 'Reveal hidden enemies' },
  ghillie: { name: 'Ghillie suit', desc: 'Nearly invisible while still' },
  piercing: { name: 'AP rounds', desc: 'Bullets ignore armor' },
  extended: { name: 'Extended mag', desc: '+50% magazine' },
  grip: { name: 'Grip', desc: '-40% spread' },
  silencer: { name: 'Silencer', desc: 'Your shots are heard only up close' },
  lightweight: { name: 'Lightweight', desc: '+25% move speed' },
  longRange: { name: 'Long range', desc: '+40% bullet range' },
  quickReload: { name: 'Quick reload', desc: 'Reload 35% faster' },
  choke: { name: 'Choke', desc: '-25% pellet spread' },
  shield: { name: 'Shield', desc: 'Blocks 33% of bullet damage from the front' },
  thickSkin: { name: 'Thick skin', desc: '+40 health: outlast a one- or two-hit gun' },
  firstAid: { name: 'First aid', desc: 'Regenerate health 3x faster, starting 1.6s after a hit' },
  marathon: { name: 'Marathon', desc: 'Sprint 15% faster, and your gun settles 50% sooner after a sprint' },
  steadyHands: { name: 'Steady hands', desc: 'Spray bloom builds 40% slower and recovers 60% faster; the post-sprint settle is 25% shorter' },
  secondWind: { name: 'Second wind', desc: 'Once a life, dropping under 25% health gives 2s of +30% speed and half damage taken' },
  adrenaline: { name: 'Adrenaline', desc: 'A kill grants +20% move speed for 3s' },
  bloodlust: { name: 'Bloodlust', desc: 'Heal 15% of the damage you deal to players' },
  recon: { name: 'Recon', desc: '+8% view radius (view bonuses stack with diminishing returns), and enemies in view show a mark while they reload' },
  ninja: { name: 'Ninja', desc: 'Your sprint makes no noise, and while hunted your shots never ping you on enemy minimaps' },
  overclock: { name: 'Overclock', desc: 'Ability cooldown 30% shorter' },
  demolitions: { name: 'Demolitions', desc: 'Your blasts hit 30% harder and 30% wider; you take 30% less blast damage' },
  fastHands: { name: 'Fast hands', desc: 'Reload 25% faster, and an evolution refills your magazine' },
  tracker: { name: 'Tracker', desc: 'Enemies you damage show on your minimap for 4s' },
  brace: { name: 'Brace', desc: 'Take 60% less knockback and deal 15% more' },
  grenade: { name: 'Grenade', desc: 'Thrown explosive' },
  fragGrenade: { name: 'Frag grenade', desc: 'Explodes into shrapnel' },
  gasGrenade: { name: 'Gas grenade', desc: 'Lingering damage cloud' },
  landMine: { name: 'Land mine', desc: 'Hidden explosive at your feet, two at a time' },
  knife: { name: 'Knife', desc: 'Lunge melee strike' },
  engineer: { name: 'Engineer', desc: 'Build a wall' },
  dash: { name: 'Dash', desc: 'Burst of speed' },
  flashbang: { name: 'Flashbang', desc: 'Blinds everyone who sees it burst, you and your team too' },
  smokeGrenade: { name: 'Smoke', desc: 'A dense cloud nobody can see through; bullets still fly' },
};

export const ABILITY_COOLDOWN_MS: Record<AbilityId, number> = {
  grenade: 6000, fragGrenade: 7000, gasGrenade: 8000, landMine: 9000, knife: 4000, engineer: 10000, dash: 3500, flashbang: 9000, smokeGrenade: 12000,
};

export const PLAYER_KINDS = ['human', 'bot'] as const;
export type PlayerKind = (typeof PLAYER_KINDS)[number];
/**
 * The one rule that tells a bot from a person: a bot's damage to a person counts this share (every path: rounds, blasts, the knife, gas,
 * fire, mines, turrets). Bot on bot, person on person and person on bot are all at full. Health, speed, spread, bloom and every other stat
 * are the same for both; the only other difference is the touch aim assist a person on a phone gets (`src/client/aimassist.ts`).
 */
export const BOT_DAMAGE_TO_HUMAN = 0.75;

export type Pick = { k: 'perk'; tier: Tier; /** The tier-2 perks offered this life (`TIER2_OFFER` of the pool, drawn at spawn); absent means the whole tier. */ offer?: readonly PerkId[] } | { k: 'evolve' };
export type PendingPick = { level: number } & Pick;
export type PickOption = PerkId | GunId;

export const LEVELS = [
  // A new gun is the best reward there is, so it is earned: the first evolve lands around the second or third kill of a life
  // and the second around the sixth or seventh, with the attachment before the first and the two perks between them, so a
  // pick comes about every kill. Set on the score a life really has after each kill, medals included
  // (scripts/level-scale.ts prints it, and test/balance.test.ts holds it).
  { score: 0, pick: null }, { score: 220, pick: { k: 'perk', tier: 1 } }, { score: 450, pick: { k: 'evolve' } },
  { score: 700, pick: { k: 'perk', tier: 2 } }, { score: 900, pick: { k: 'perk', tier: 3 } }, { score: 1100, pick: { k: 'evolve' } },
] as const satisfies readonly { score: number; pick: Pick | null }[];

type Attachment = (typeof PERK_TIERS)[1][number];

export const ATTACHMENTS: Record<WeaponId, readonly Attachment[]> = {
  pistol: ['extended', 'quickReload', 'silencer', 'lightweight', 'optics'],
  smg: ['grip', 'extended', 'silencer', 'longRange', 'lightweight'],
  shotgun: ['choke', 'quickReload', 'extended', 'lightweight', 'piercing'],
  assault: ['grip', 'extended', 'silencer', 'optics', 'piercing'],
  sniper: ['extended', 'thermal', 'ghillie', 'silencer', 'quickReload'],
  lmg: ['quickReload', 'grip', 'lightweight', 'piercing', 'extended'],
};

const DOES_NOTHING: Partial<Record<Attachment, (def: GunDef) => boolean>> = {
  silencer: (def) => def.silenced ?? false,
  choke: (def) => def.pellets < 2,
  extended: (def) => def.mag < 2,
};

export const pickOptions = (pick: Pick, gun: GunId): readonly PickOption[] =>
  pick.k === 'evolve' ? EVOLUTIONS[gun]
    : pick.tier === 1 ? ATTACHMENTS[GUNS[gun].base].filter((perk) => !DOES_NOTHING[perk]?.(GUNS[gun]))
      : pick.tier === 2 && pick.offer ? pick.offer : PERK_TIERS[pick.tier];

export const isPerkId = (option: PickOption): option is PerkId => Object.hasOwn(PERK_INFO, option);

export const PICK_OPTIONS: readonly PickOption[] = [...PERK_TIERS[1], ...PERK_TIERS[2], ...PERK_TIERS[3], ...GUN_IDS];

/** How long a press waits past the gun's cooldown or reload to fire, so a tap a moment early is not lost. */
export const PRESS_GRACE_MS = 100;
/** How far ahead of the gun being ready a click is kept; an earlier click is dropped rather than firing later on its own. */
export const PRESS_BUFFER_MS = 200;

/**
 * An enemy gun round passing within `px` of a player's edge suppresses them by its gun's `suppress`, once per round, hit or miss.
 * It holds `holdMs` after the last such round and then fades at `decayPerSec`, so only fire faster than the hold keeps
 * stacking: a machine gun pins a player down while a pistol or a sniper only makes them flinch. Full suppression widens
 * spread by `spread` of itself, breaks a planted sniper's pinpoint once past `breaksPinpoint`, and shades the screen's edges.
 */
export const SUPPRESSION = { px: 60, holdMs: 150, decayPerSec: 0.8, spread: 0.25, breaksPinpoint: 0.05 } as const;

/**
 * Knockback: a round or blast that lands shoves its victim along its line. A hit adds `perDamage[gun class]` px/s per point of
 * damage (before the human health multiplier, after armor), the sum is capped at `cap` (`blastCap` for blasts, which push `blastPerDamage`
 * per point), and the shove bleeds off with time constant `tauMs`, so a spray of light rounds barely moves anyone while a point-blank
 * shotgun or a sniper round visibly rocks them. `armor` is the share of a shove each armor lets through; `zombie` the share a horde kind takes
 * (light kinds fly, brutes and the colossus do not budge).
 */
export const KNOCK = {
  perDamage: { pistol: 0.6, smg: 0.35, shotgun: 0.9, assault: 0.6, sniper: 0.9, lmg: 0.4 } as Record<WeaponId, number>,
  blastPerDamage: 1.6, cap: 120, blastCap: 180, tauMs: 80, floor: 6,
  armor: { none: 1, light: 0.93, medium: 0.85, heavy: 0.7 } as Record<ArmorId, number>,
  zombie: { walker: 1.15, runner: 1.4, plated: 0.7, bloater: 0.8, brute: 0, colossus: 0 } as Record<ZombieKind, number>,
} as const;

/**
 * A kill refuels the killer at once: `heal` of their max health and `ammo` of their mag back (not mid-reload), so winning
 * a fight carries you into the next one instead of sending you off to wait out the regen delay.
 */
export const KILL_REWARD = { heal: 0.35, ammo: 0.5 } as const;

/**
 * Kills in one life make a streak. Others see it beside your name from `showAt`; whoever ends a streak of `shutdownAt` or
 * more earns `shutdownScore`. Whoever killed you last is your nemesis, and killing them pays `revengeScore`.
 */
export const STREAK = { showAt: 3, shutdownAt: 5, shutdownScore: 100, revengeScore: 50 } as const;

/**
 * Medals are earned in the moment, Call of Duty style, and each pays its `score` on top of the kill. `tier` sets the
 * medal's metal on screen. The bounty, shutdown and revenge medals carry the bonuses those rules always paid.
 * A medal is a bonus, not the bulk of the score: the everyday ones land on no more than about one kill in five of their
 * kind and the rare ones on a few in a hundred, and in rooms of bots medals pay about a fifth of a life's score.
 */
export const MEDAL_IDS = [
  'firstBlood', 'doubleKill', 'tripleKill', 'quadKill', 'massacre', 'longShot', 'pointBlank', 'clutch', 'closeCall',
  'revenge', 'shutdown', 'bounty', 'onFire', 'rampage', 'unstoppable', 'untouchable', 'legendary', 'ghost',
  // Each weapon class has feats of its own (`WEAPON_MEDALS`).
  'doubleTap', 'deadeye', 'runAndGun', 'twoBirds', 'longBarrel', 'disciplined', 'oneShot', 'noScope', 'eagleEye', 'reaper',
  'pinnedDown', 'beltFed',
  // The arena's surprises: a barrel kill, a barrel chain, and the supply drop.
  'kaboom', 'chainReaction', 'specialDelivery',
  // The other props (`PROPS`): a propane kill, a kill while shocked by a generator you shorted, a fire kill, and a splash of paint on an enemy.
  'liftoff', 'shockTherapy', 'arsonist', 'picasso',
] as const;
export type MedalId = (typeof MEDAL_IDS)[number];
export type MedalTier = 'bronze' | 'silver' | 'gold' | 'platinum';
export const MEDALS: Record<MedalId, { name: string; desc: string; score: number; tier: MedalTier }> = {
  firstBlood: { name: 'First Blood', desc: 'The first kill of the round', score: 50, tier: 'silver' },
  doubleKill: { name: 'Double Kill', desc: 'Two kills within 3 seconds', score: 25, tier: 'bronze' },
  tripleKill: { name: 'Triple Kill', desc: 'Three kills, each within 3 seconds of the last', score: 50, tier: 'silver' },
  quadKill: { name: 'Quad Kill', desc: 'Four kills, each within 3 seconds of the last', score: 100, tier: 'gold' },
  massacre: { name: 'Massacre', desc: 'Five or more kills, each within 3 seconds of the last', score: 200, tier: 'platinum' },
  longShot: { name: 'Long Shot', desc: 'A kill from 650 px or more away', score: 30, tier: 'bronze' },
  pointBlank: { name: 'Point Blank', desc: 'A kill from 90 px or closer', score: 25, tier: 'bronze' },
  clutch: { name: 'Clutch', desc: 'Kill whoever is hurting you, on 20% health or less', score: 50, tier: 'silver' },
  closeCall: { name: 'Close Call', desc: 'Drop under 10% health and live another 6 seconds', score: 30, tier: 'bronze' },
  revenge: { name: 'Revenge', desc: 'Kill the player who last killed you', score: STREAK.revengeScore, tier: 'silver' },
  shutdown: { name: 'Shutdown', desc: 'End a streak of 5 or more', score: STREAK.shutdownScore, tier: 'gold' },
  bounty: { name: 'Bounty', desc: 'Kill a hunted player', score: 150, tier: 'gold' },
  onFire: { name: 'On Fire', desc: '3 kills without dying', score: 25, tier: 'bronze' },
  rampage: { name: 'Rampage', desc: '5 kills without dying', score: 50, tier: 'silver' },
  unstoppable: { name: 'Unstoppable', desc: '8 kills without dying', score: 100, tier: 'gold' },
  untouchable: { name: 'Untouchable', desc: '12 kills without dying', score: 200, tier: 'platinum' },
  legendary: { name: 'Legendary', desc: '20 kills without dying', score: 300, tier: 'platinum' },
  ghost: { name: 'Ghost', desc: 'Cover 6000 px in one life without firing a shot', score: 25, tier: 'bronze' },
  doubleTap: { name: 'Double Tap', desc: 'Pistol: two kills from one magazine', score: 30, tier: 'bronze' },
  deadeye: { name: 'Deadeye', desc: 'Pistol: a kill from 500 px or more', score: 50, tier: 'silver' },
  runAndGun: { name: 'Run and Gun', desc: 'SMG: a kill on the move, straight out of a sprint', score: 30, tier: 'bronze' },
  twoBirds: { name: 'Two Birds', desc: 'Shotgun: one blast hits two enemies', score: 40, tier: 'bronze' },
  longBarrel: { name: 'Long Barrel', desc: 'Shotgun: a kill from 400 px or more', score: 50, tier: 'silver' },
  disciplined: { name: 'Disciplined', desc: 'Assault: a kill from 500 px or more inside a short tap', score: 30, tier: 'bronze' },
  oneShot: { name: 'One Shot', desc: 'Sniper: a kill with one hit from full health, from 550 px or more', score: 40, tier: 'silver' },
  noScope: { name: 'No Scope', desc: 'Sniper: a kill from 160 px or closer', score: 60, tier: 'silver' },
  eagleEye: { name: 'Eagle Eye', desc: 'Sniper: a kill from 900 px or more', score: 75, tier: 'gold' },
  reaper: { name: 'Reaper', desc: 'Sniper: three one-hit kills in one life', score: 150, tier: 'platinum' },
  pinnedDown: { name: 'Pinned Down', desc: 'Machine gun: kill an enemy you have pinned with suppression, from 450 px or more', score: 30, tier: 'bronze' },
  beltFed: { name: 'Belt Fed', desc: 'Machine gun: three kills from one belt', score: 75, tier: 'gold' },
  kaboom: { name: 'Kaboom', desc: 'Kill with an explosive barrel you set off', score: 30, tier: 'bronze' },
  chainReaction: { name: 'Chain Reaction', desc: 'One barrel chain kills two or more', score: 100, tier: 'gold' },
  specialDelivery: { name: 'Special Delivery', desc: 'Crack open a supply drop', score: 50, tier: 'silver' },
  liftoff: { name: 'Liftoff', desc: 'Kill with a propane tank you sent flying', score: 50, tier: 'silver' },
  shockTherapy: { name: 'Shock Therapy', desc: 'Kill an enemy while a generator you shorted still has them shocked', score: 50, tier: 'silver' },
  arsonist: { name: 'Arsonist', desc: 'Kill with a burning oil slick you spilled', score: 40, tier: 'bronze' },
  picasso: { name: 'Picasso', desc: 'Splatter a paint can over an enemy', score: 25, tier: 'bronze' },
};
/** The streak at which each streak medal is earned. */
export const STREAK_MEDALS: readonly (readonly [number, MedalId])[] = [[3, 'onFire'], [5, 'rampage'], [8, 'unstoppable'], [12, 'untouchable'], [20, 'legendary']];
/** The chain of kills each multi-kill medal names, from the second kill. */
export const MULTI_MEDALS: readonly MedalId[] = ['doubleKill', 'tripleKill', 'quadKill', 'massacre'];
export const MEDAL_RULES = { multiMs: 3000, longShotPx: 650, pointBlankPx: 90, clutchHp: 0.2, clutchMs: 5000, closeCallHp: 0.1, closeCallMs: 6000, closeCallReset: 0.5, ghostPx: 6000 } as const;
/**
 * The weapon feats, judged on the gun that fired the killing round (or blast of pellets): kills from one magazine, the
 * range, a kill in one hit from full health at range, a spray that had not bloomed yet at range, a far victim pinned by
 * suppression, and a kill on the move within `runAndGunMs` of a sprint ending.
 */
export const WEAPON_MEDALS = {
  doubleTapKills: 2, deadeyePx: 500, twoBirdsHits: 2, longBarrelPx: 400, oneShotPx: 550, oneShotsForReaper: 3, noScopePx: 160, eagleEyePx: 900,
  pinnedSuppression: 0.95, beltFedKills: 3, runAndGunMs: 1000, disciplinedPx: 500, pinnedPx: 450,
} as const;

/**
 * Lifetime medals: career tracks kept on a player's profile for good, each with a bronze, silver, gold and platinum
 * medal at the counts in `at`. Every rung pays `CAREER_PAY` of its tier on the spot and gets its own unlock, and the
 * rarest one a player holds is worn by their name in every match. A track counts a career stat or one of the medals.
 */
export const CAREER_IDS = [
  'kills', 'games', 'streak', 'longShot', 'pointBlank', 'multiKill', 'tripleKill', 'massacre', 'clutch', 'closeCall',
  'revenge', 'shutdown', 'bounty', 'firstBlood', 'distance', 'ghost',
  'pistolKills', 'smgKills', 'shotgunKills', 'assaultKills', 'sniperKills', 'lmgKills', 'oneShot', 'twoBirds',
  // Zombies (`ZOM_CAREER_IDS`): each counts one of the `ZOM_STATS` a human's runs add to their profile.
  'zNights', 'zBestNight', 'zWins', 'zKills', 'zBuilt', 'zMaxed', 'zRepaired', 'zRounds', 'zRevives', 'zColossus', 'zFlawless',
] as const;
export type CareerId = (typeof CAREER_IDS)[number];
/**
 * What a human's Zombies runs keep on their profile, for the Zombies lifetime medals. Each counts only a seated human's own play in a squad
 * room (never a bot's, never the range's): `nights` survived, the furthest night reached in one run (`bestNight`, a best, not a sum), runs
 * won (`wins`), zombies killed with their own gun, blade or blast (`kills`), buildings put up (`built`), upgrades to the top level (`maxed`),
 * health mended on the squad's buildings and the core (`repaired`), rounds fired (`rounds`), squadmates revived (`revives`), Colossi felled
 * with a hit of their own in them (`colossi`), and nights the core came through without a scratch (`flawless`).
 */
export const ZOM_STATS = ['nights', 'bestNight', 'wins', 'kills', 'built', 'maxed', 'repaired', 'rounds', 'revives', 'colossi', 'flawless'] as const;
export type ZomStat = (typeof ZOM_STATS)[number];
/** `km` is career distance walked, at `KM_PX` px to the km: a body is about a metre across, so a km is some 3 minutes on foot. */
export type CareerStat = 'kills' | 'games' | 'bestStreak' | 'km' | `kills:${WeaponId}` | `zom:${ZomStat}`;
export const KM_PX = 48_000;
export const CAREER_TIERS: readonly MedalTier[] = ['bronze', 'silver', 'gold', 'platinum'];
/** `desc`, when given, says what counts toward a track beyond its `unit`, for its tooltip. */
export const CAREER: Record<CareerId, { name: string; unit: string; needs: CareerStat | MedalId; at: readonly [number, number, number, number]; desc?: string }> = {
  kills: { name: 'Centurion', unit: 'career kills', needs: 'kills', at: [100, 500, 1500, 5000] },
  games: { name: 'Veteran', unit: 'matches played', needs: 'games', at: [10, 50, 150, 500] },
  streak: { name: 'Iron Will', unit: 'kills in one life', needs: 'bestStreak', at: [5, 10, 15, 25] },
  longShot: { name: 'Marksman', unit: 'Long Shots', needs: 'longShot', at: [10, 50, 150, 400] },
  pointBlank: { name: 'Brawler', unit: 'Point Blank kills', needs: 'pointBlank', at: [10, 50, 150, 400] },
  multiKill: { name: 'Double Trouble', unit: 'Double Kills', needs: 'doubleKill', at: [10, 50, 150, 400] },
  tripleKill: { name: 'Chain Reaction', unit: 'Triple Kills', needs: 'tripleKill', at: [3, 15, 50, 150] },
  massacre: { name: 'Butcher', unit: 'Massacres', needs: 'massacre', at: [1, 5, 15, 50] },
  clutch: { name: 'Clutch Master', unit: 'Clutches', needs: 'clutch', at: [5, 25, 75, 200] },
  closeCall: { name: 'Survivor', unit: 'Close Calls', needs: 'closeCall', at: [5, 25, 75, 200] },
  revenge: { name: 'Avenger', unit: 'Revenges', needs: 'revenge', at: [5, 25, 75, 200] },
  shutdown: { name: 'Giant Slayer', unit: 'Shutdowns', needs: 'shutdown', at: [3, 15, 50, 150] },
  bounty: { name: 'Headhunter', unit: 'Bounties claimed', needs: 'bounty', at: [3, 15, 50, 150] },
  firstBlood: { name: 'Opener', unit: 'First Bloods', needs: 'firstBlood', at: [3, 15, 50, 150] },
  distance: { name: 'Marathon', unit: 'km walked', needs: 'km', at: [10, 50, 200, 800] },
  ghost: { name: 'Phantom', unit: 'Ghost medals', needs: 'ghost', at: [5, 25, 75, 200] },
  pistolKills: { name: 'Sidearm', unit: 'pistol kills', needs: 'kills:pistol', at: [50, 250, 750, 2500] },
  smgKills: { name: 'Spray Master', unit: 'SMG kills', needs: 'kills:smg', at: [50, 250, 750, 2500] },
  shotgunKills: { name: 'Buckshot', unit: 'shotgun kills', needs: 'kills:shotgun', at: [50, 250, 750, 2500] },
  assaultKills: { name: 'Rifleman', unit: 'assault rifle kills', needs: 'kills:assault', at: [50, 250, 750, 2500] },
  sniperKills: { name: 'Sharpshooter', unit: 'sniper kills', needs: 'kills:sniper', at: [50, 250, 750, 2500] },
  lmgKills: { name: 'Gunner', unit: 'machine gun kills', needs: 'kills:lmg', at: [50, 250, 750, 2500] },
  oneShot: { name: 'Silencer', unit: 'One Shots', needs: 'oneShot', at: [10, 50, 150, 400] },
  twoBirds: { name: 'Scattergun', unit: 'Two Birds', needs: 'twoBirds', at: [10, 50, 150, 400] },
  // Zombies. A first run or two brings a bronze or three; platinum is months of nights.
  zNights: { name: 'Night Owl', unit: 'zombie nights survived', needs: 'zom:nights', at: [5, 25, 100, 400], desc: 'each night of a Zombies run you were seated for from dusk and saw end' },
  zBestNight: { name: 'Last Light', unit: 'best night reached', needs: 'zom:bestNight', at: [3, 5, 8, 10], desc: 'the deepest night of one Zombies run you were seated for from its dusk; night 10 is the Tide' },
  zWins: { name: 'Held the Line', unit: 'runs won', needs: 'zom:wins', at: [1, 3, 10, 30], desc: 'Zombies runs where the Bastion held through the Tide, night 10' },
  zKills: { name: 'Pest Control', unit: 'zombies killed', needs: 'zom:kills', at: [100, 1000, 5000, 20000], desc: 'zombies felled by your own gun, blade or blast (a turret\'s kills are the turret\'s)' },
  zBuilt: { name: 'Bricklayer', unit: 'buildings put up', needs: 'zom:built', at: [25, 250, 1000, 5000], desc: 'every wall, turret, utility and spike strip you build, each cell of a dragged line counting one' },
  zMaxed: { name: 'Chief Engineer', unit: 'upgrades to level 3', needs: 'zom:maxed', at: [3, 25, 100, 400], desc: 'buildings you step up to their top level: a steel wall, or a level 3 turret or utility' },
  zRepaired: { name: 'Handyman', unit: 'health mended', needs: 'zom:repaired', at: [2000, 25000, 100000, 500000], desc: 'health you put back into the squad\'s buildings and the Bastion by holding use' },
  zRounds: { name: 'Trigger Happy', unit: 'rounds fired', needs: 'zom:rounds', at: [1000, 10000, 50000, 250000], desc: 'every pull of the trigger in a Zombies run, a shotgun\'s blast counting one' },
  zRevives: { name: 'Field Medic', unit: 'squadmates revived', needs: 'zom:revives', at: [3, 25, 100, 400], desc: 'downed squadmates you held use over until they stood again' },
  zColossus: { name: 'Titan Toppler', unit: 'Colossi felled', needs: 'zom:colossi', at: [1, 5, 20, 60], desc: 'every Colossus that dies with one of your own hits in it, the killing blow or not' },
  zFlawless: { name: 'Not a Scratch', unit: 'nights without a scratch', needs: 'zom:flawless', at: [1, 5, 20, 60], desc: 'nights you saw out whole in which the horde never laid a finger on the Bastion' },
};
/** The Zombies lifetime tracks, which the profile page shows in a section of their own. */
export const ZOM_CAREER_IDS: readonly CareerId[] = CAREER_IDS.filter((t) => CAREER[t].needs.startsWith('zom:'));
/** Score a lifetime medal pays the moment it is earned, by tier. */
export const CAREER_PAY: Record<MedalTier, number> = { bronze: 100, silver: 200, gold: 400, platinum: 800 };
/** One rung of a career track: which track, and which tier of it (0 bronze to 3 platinum). */
export type Badge = { track: CareerId; tier: 0 | 1 | 2 | 3 };
export const badgeKey = (b: Badge) => `${b.track}:${b.tier}`;

/**
 * Explosive barrels stand on the versus maps. A barrel is a `size` px square with `hp`; at zero it hisses for `fuseMs`, then
 * bursts as a blast of `radius` and `damage`. A barrel caught in a blast lights a shorter fuse (`chainBaseMs` plus `chainPerPx`
 * a px from the burst), so a row of them goes off in a ripple. It stands again `respawnMs` after bursting.
 */
export const BARREL = {
  size: 36, hp: 24, fuseMs: 420, chainBaseMs: 120, chainPerPx: 1.1, radius: 170, damage: 150, respawnMs: 45_000,
  /** Maps keep barrels this far (px, beyond the player's body) from every spawn region. */
  spawnGap: 120,
} as const;

/**
 * Airdrops (versus modes): `perRound` of them at random times between `from` and `to` of the round's clock, at least `gapMs` apart.
 * A plane crosses the map at `planeSpeed` px/s, drops a crate where it passes the target, and the crate falls `fallMs` under its
 * chute, landing as a crate of `hp` that stands `lifeMs` unless broken. Whoever breaks it gets a golden gun (`goldMul` damage for the life) or, `supplyChance` of the time
 * or if they already hold one, a full heal, a full magazine and `supplyScore`.
 */
export const AIRDROP = {
  perRound: [1, 2] as const, from: 0.15, to: 0.8, gapMs: 120_000, planeSpeed: 1000, fallMs: 5000, hp: 300, size: 64, lifeMs: 75_000,
  goldMul: 1.2, supplyChance: 0.4, supplyScore: 150, edge: 400,
} as const;

/**
 * The props that stand beside the barrels on the versus maps, one `PropKind` each. A prop is a `size` px square with `hp`; shot to
 * zero it does its thing (see `sim/props.ts`) and, but for a lamp, hides until `respawnMs` after (a lamp stays up, dark, and relights
 * then; a cabinet leaves a pack on the floor for `packMs` first). Maps keep props `spawnGap` px from every spawn region.
 */
export const PROP_KINDS = ['propane', 'gas', 'generator', 'oil', 'lamp', 'medic', 'ammo', 'paint'] as const;
export type PropKind = (typeof PROP_KINDS)[number];
export const PROPS: Record<PropKind, { name: string; desc: string; size: number; hp: number; respawnMs: number }> = {
  propane: { name: 'Propane tank', desc: 'Shot, it rockets off the way the round came and bursts where it lands', size: 28, hp: 28, respawnMs: 40_000 },
  gas: { name: 'Gas canister', desc: 'Bursts into a lingering toxic cloud', size: 28, hp: 30, respawnMs: 45_000 },
  generator: { name: 'Generator', desc: 'Shorts out in an EMP: slows everyone near and locks abilities', size: 40, hp: 50, respawnMs: 60_000 },
  oil: { name: 'Oil drum', desc: 'Spills a burning slick', size: 32, hp: 45, respawnMs: 45_000 },
  lamp: { name: 'Streetlamp', desc: 'Shoot the bulb to darken its pool of light', size: 20, hp: 20, respawnMs: 90_000 },
  medic: { name: 'Medical cabinet', desc: 'Opens as you walk up hurt, or to a shot; drops a health pack', size: 36, hp: 40, respawnMs: 60_000 },
  ammo: { name: 'Ammo crate', desc: 'Opens as you walk up short of ammo, or to a shot; drops a full magazine and a fresh ability', size: 36, hp: 40, respawnMs: 60_000 },
  paint: { name: 'Paint can', desc: 'Splatters your colour on the floor', size: 22, hp: 10, respawnMs: 30_000 },
};
/** The numbers behind each prop's effect. Speeds are px/s, times ms. */
export const PROP_FX = {
  spawnGap: 100,
  /** A tank rockets off at `speed`, skids (its speed bleeds off at `drag` per second) and bursts on touching a wall, body or prop, or after `lifeMs`. */
  propane: { speed: 700, drag: 0.9, lifeMs: 1800, body: 14, radius: 120, damage: 95 },
  /** The gas cloud lasts `cloudMs` (damage is the gas grenade's). */
  gas: { cloudMs: 7000 },
  /** A shorted generator arcs for `arcMs`, then pulses: everyone within `radius` is slowed to `slowMul` for `slowMs` and cannot use an ability for `lockMs`. */
  generator: { arcMs: 600, radius: 210, slowMs: 2600, slowMul: 0.55, lockMs: 2000 },
  /** The slick burns everyone in `radius` (but its spiller) at `dps` for `burnMs`, in half-second pulses (`dotPulses` in sim/dot.ts). */
  oil: { radius: 100, burnMs: 6000, dps: 18 },
  /**
   * A broken-open cabinet's pack lies `packMs`, taken by the first player who walks over it (a body within `pickR` of its centre) and needs it.
   * A standing cabinet opens by itself for the first player within `openR` of its centre who needs what it holds: a body pressed to any side
   * of it, corners too, with room to spare.
   */
  medic: { heal: 50, packMs: 25_000, pickR: 40, openR: 70 },
  ammo: { packMs: 25_000, pickR: 40, openR: 70 },
  paint: { radius: 90, picassoPx: 80 },
} as const;

/**
 * How view bonuses (a gun's scope, `GunRules.viewMul`, and the Optics and Recon perks) combine: each bonus `b` closes `b / cap` of the
 * gap still left to the class's `cap`, so the view radius is `WORLD.viewRadius * (1 + cap * (1 - Π(1 - b / cap)))` (`viewMulFor` in
 * sim/stats.ts). The first bonus gives all of its value, each further one less, and nothing ever passes `1 + cap`: a sniper with every
 * bonus sees under 1.45 times the base view, any other class under 1.18 times. Every bonus is kept below its class's cap.
 */
export const VIEW = {
  cap: { pistol: 0.18, smg: 0.18, shotgun: 0.18, assault: 0.18, sniper: 0.45, lmg: 0.18 } satisfies Record<WeaponId, number>,
} as const;

export const MODE_IDS = ['FFA', 'TDM', 'DOM', 'ZOM', 'BR', 'RNG'] as const;
export type ModeId = (typeof MODE_IDS)[number];

export const WORLD = {
  playerRadius: 24,
  baseHp: 100,
  baseSpeed: 255,
  regenDelayMs: 4000,
  regenPerSec: 5,
  tickHz: 30,
  /**
   * Half the width of the world a player sees with no view bonus (see `VIEW` for the bonuses): 700, zoomed in about 10% from 780 so bodies
   * and rounds read bigger. The stronger aim look-ahead (shared/lookahead.ts) gives back the ground down the aim, so a sniper sees as far as before.
   */
  viewRadius: 700,
  crateHp: 40,
  crateScore: 10,
  killScore: 100,
  bountyScore: 150,
  assistScore: 50,
  /** Score multiplier while your level trails the other living players' average. */
  catchUpMul: 1.5,
  respawnMs: 3000,
  /** Outside a zombies run, a fresh life takes no damage this long, or until its owner fires or uses an ability, so a spawn is never a free kill. */
  spawnShieldMs: 5000,
  domWinScore: 3000,
  tdmWinScore: 150,
  /** A human who reaches this ends the FFA round early; otherwise the round runs until MAP_MS.FFA and the top killer, bot or human, wins. */
  ffaWinKills: 30,
  roundRestartMs: 8000,
  minPlayers: 18,
} as const;

/** A burst's blast, and its blows to each building and to the core (before the core's armor) within its radius. */
export type Burst = Blast & { building: number; core: number };
export const ZOMBIE_KINDS = ['walker', 'brute', 'runner', 'plated', 'bloater', 'colossus'] as const;
export type ZombieKind = (typeof ZOMBIE_KINDS)[number];
/**
 * `damage` is per bite and `buildingDamageMul` scales it against walls; `hp` and `damage` grow each night (see `ZOM.nightMul`).
 * A zombie turns on a squad player within `aggroPx`, in sight, instead of marching on the core; one with none never does.
 * `plate` comes off every bullet that hits it, down to 1, unless the round pierces armor; blasts get through whole.
 * A zombie with a `burst` blows up where it dies, hurting the squad and the walls round it. `pack` of them walk in together.
 */
export const ZOMBIES: Record<ZombieKind, {
  name: string; many: string; hp: number; speed: number; radius: number; damage: number; attackMs: number; buildingDamageMul: number; aggroPx: number; score: number; scrap: number;
  plate: number; burst: Burst | null; pack: number;
}> = {
  walker: { name: 'Walker', many: 'walkers', hp: 50, speed: 120, radius: 16, damage: 8, attackMs: 900, buildingDamageMul: 0.5, aggroPx: 160, score: 10, scrap: 3, plate: 0, burst: null, pack: 6 },
  brute: { name: 'Brute', many: 'brutes', hp: 900, speed: 75, radius: 24, damage: 40, attackMs: 1400, buildingDamageMul: 1, aggroPx: 0, score: 60, scrap: 15, plate: 0, burst: null, pack: 2 },
  runner: { name: 'Runner', many: 'runners', hp: 30, speed: 210, radius: 12, damage: 9, attackMs: 600, buildingDamageMul: 0.25, aggroPx: 360, score: 8, scrap: 2, plate: 0, burst: null, pack: 6 },
  plated: { name: 'Plated', many: 'plated', hp: 200, speed: 95, radius: 19, damage: 12, attackMs: 1000, buildingDamageMul: 0.6, aggroPx: 120, score: 30, scrap: 7, plate: 10, burst: null, pack: 3 },
  bloater: {
    name: 'Bloater', many: 'bloaters', hp: 120, speed: 80, radius: 22, damage: 10, attackMs: 1200, buildingDamageMul: 1, aggroPx: 0, score: 25, scrap: 6, plate: 0,
    burst: { radius: 110, damage: 70, building: 600, core: 250 }, pack: 2,
  },
  colossus: { name: 'Colossus', many: 'a colossus', hp: 6000, speed: 55, radius: 40, damage: 80, attackMs: 1600, buildingDamageMul: 2.5, aggroPx: 0, score: 500, scrap: 80, plate: 8, burst: null, pack: 1 },
};

export const SIDES = ['north', 'east', 'south', 'west'] as const;
export type Side = (typeof SIDES)[number];
/**
 * One row per night, the last the Tide: how many of each kind come for a squad of four bots, and the sides they walk in from.
 */
export type NightDef = { name?: string; horde: Partial<Record<ZombieKind, number>>; from: readonly Side[] };
export const NIGHTS: readonly NightDef[] = [
  { horde: { walker: 24, brute: 1 }, from: ['north'] },
  { horde: { walker: 32, runner: 8, brute: 7 }, from: ['east'] },
  { horde: { walker: 44, runner: 14, plated: 8, bloater: 2, brute: 14 }, from: ['south', 'west', 'north'] },
  { horde: { walker: 52, runner: 16, plated: 12, bloater: 4, brute: 14 }, from: ['north', 'east'] },
  { name: 'The Colossus', horde: { walker: 56, runner: 16, plated: 12, brute: 12, colossus: 1 }, from: ['west', 'south'] },
  { horde: { walker: 70, runner: 20, bloater: 10, plated: 18, brute: 18 }, from: SIDES },
  { horde: { walker: 74, runner: 28, plated: 16, bloater: 12, brute: 20 }, from: ['north', 'south', 'west'] },
  { horde: { walker: 80, runner: 28, plated: 18, bloater: 14, brute: 20, colossus: 1 }, from: SIDES },
  { horde: { walker: 84, runner: 30, plated: 20, bloater: 14, brute: 22 }, from: SIDES },
  { name: 'The Tide', horde: { walker: 90, runner: 32, plated: 20, bloater: 14, brute: 22, colossus: 2 }, from: SIDES },
];
/**
 * Past the table the nights never end: each is built from the Tide, every kind from every side. Each kind's count grows `growth` a night
 * for `growNights` nights past the Tide and then holds, so the horde stops growing in numbers (and `ZOM.maxAlive` caps how many walk at
 * once) while `ZOM.nightMul` keeps raising its health and bite. Another Colossus joins every `colossusEvery` nights, up to `colossusMax`.
 */
export const ENDLESS = { growth: 0.08, growNights: 10, colossusEvery: 2, colossusMax: 6 } as const;
const endlessNights = new Map<number, NightDef>();
/** Night `night`'s row: the table's, or past the Tide one built from it (`ENDLESS`), the same for the same night every time. */
export function nightOf(night: number): NightDef {
  if (night <= NIGHTS.length) return NIGHTS[Math.max(1, night) - 1]!;
  let def = endlessNights.get(night);
  if (!def) {
    const tide = NIGHTS.at(-1)!.horde, past = night - NIGHTS.length, grow = 1 + ENDLESS.growth * Math.min(past, ENDLESS.growNights);
    const horde = Object.fromEntries(ZOMBIE_KINDS.map((k) => [k, isBoss(k)
      ? Math.min(ENDLESS.colossusMax, (tide[k] ?? 1) + Math.floor(past / ENDLESS.colossusEvery))
      : Math.round((tide[k] ?? ZOMBIES[k].pack) * grow)]));
    endlessNights.set(night, (def = { horde, from: SIDES }));
  }
  return def;
}
/** True for a night past the table's: the run goes on after the Tide until the core falls. */
export const isEndless = (night: number) => night > NIGHTS.length;
/** A boss is a kind that walks alone (`pack: 1`): it comes as listed for any squad, its health scaled by the squad's share instead. */
export const isBoss = (kind: ZombieKind) => ZOMBIES[kind].pack === 1;
/** How many of a kind listed `listed` times come for a squad with this share of the horde. */
export const hordeCount = (kind: ZombieKind, listed: number, share: number) => (!listed || isBoss(kind) ? listed : Math.max(1, Math.round(listed * share)));

export const TURRET_KINDS = ['sentry', 'cannon', 'scatter', 'mortar', 'tesla'] as const;
export type TurretKind = (typeof TURRET_KINDS)[number];
/** Utility kinds: an ammo `depot` and a `post` that mends are solid like a wall, `spikes` lie on the floor and are walked over. */
export const UTILITY_KINDS = ['depot', 'post', 'spikes'] as const;
export type UtilityKind = (typeof UTILITY_KINDS)[number];
export const BUILDING_KINDS = ['wall', ...TURRET_KINDS, ...UTILITY_KINDS] as const;
export type BuildingKind = (typeof BUILDING_KINDS)[number];
export const isTurretKind = (kind: BuildingKind): kind is TurretKind => (TURRET_KINDS as readonly string[]).includes(kind);
export const byTurret = <T>(f: (kind: TurretKind) => T) => Object.fromEntries(TURRET_KINDS.map((k) => [k, f(k)])) as Record<TurretKind, T>;

/**
 * A turret holds `ammo` rounds and fires `pellets` of `damage` each every `fireMs` at the nearest zombie of the kind it `prefers` in `range`, else the nearest of any kind.
 * Its rounds leave the barrel `muzzle` px from the cell's center; a refill costs `scrapPerRound`.
 * A `lobbed` round flies over everything to where its target will be when it lands and bursts there, so a lobbing turret needs no line of sight.
 */
export type TurretDef = {
  prefers: ZombieKind; range: number; fireMs: number; damage: number; pellets: number; bulletSpeed: number; spread: number; ammo: number; scrapPerRound: number;
  muzzle: number; bullet: { r: number; color: string }; lobbed: Blast | null;
  /** A coil's arc: it leaps from its first target to up to `jumps` more within `reach` px of the last, each hit `falloff` as hard as the one before. No round flies. */
  arc?: { jumps: number; reach: number; falloff: number };
};
/**
 * A wall comes in three tiers, each an upgrade of the one below: `armor` is the share of a zombie's bite it shrugs off and `blast` scales a bloater's burst on it.
 * Walls are the only buildings priced by tier; `BUILDINGS.wall` is the first.
 */
export type WallTier = { name: string; cost: number; hp: number; armor: number; blast: number; repairMul: number };
export const WALL_TIERS = [
  { name: 'Barricade', cost: 10, hp: 800, armor: 0, blast: 1, repairMul: 1.5 },
  { name: 'Sandbag wall', cost: 24, hp: 2000, armor: 0.1, blast: 0.75, repairMul: 1 },
  { name: 'Steel wall', cost: 60, hp: 4800, armor: 0.3, blast: 0.5, repairMul: 0.8 },
] as const satisfies readonly WallTier[];
/**
 * Upgrades: one level up costs `costShare[lv - 1]` of the building's base price (a wall pays the difference of its tiers' prices instead),
 * and each level scales a turret's `damage`, `fireMs`, `range` and `ammo`, every building's `hp`, and a utility's `aura` (how fast it works) and `reach`.
 */
export const MAX_LEVEL = 3;
export const UPGRADE = {
  costShare: [0.65, 1.15],
  damage: [1, 1.4, 1.9], fireMs: [1, 0.85, 0.7], range: [1, 1.1, 1.2], ammo: [1, 1.5, 2.2], hp: [1, 1.4, 1.9], aura: [1, 1.6, 2.4], reach: [1, 1.15, 1.3],
} as const;
/**
 * Utilities: the ammo `depot` tops up every turret within `reach` px, `ammoPerSec` as a share of a turret's load a second, for `scrapShare` of a round's price, and reloads a squad player's gun at once there.
 * The `post` mends every squad player within `reach` px `playerHp` health a second and every building there `buildingHp`, free.
 * `spikes` slow a zombie on them to `slow` of its speed, hurt it `dps` a second, and wear `wear` hp a second per zombie, `heavyWear` per heavy one (brute, bloater, colossus).
 */
export const UTILITY = {
  depot: { reach: 175, ammoPerSec: 0.1, scrapShare: 0.6 },
  post: { reach: 175, playerHp: 4, buildingHp: 14 },
  spikes: { slow: 0.45, dps: 14, wear: 7, heavyWear: 24 },
} as const;
type BuildingDef = { name: string; cost: number; hp: number };
export const BUILDINGS: { wall: BuildingDef & { turret: null } } & Record<TurretKind, BuildingDef & { turret: TurretDef }> & Record<UtilityKind, BuildingDef & { turret: null }> = {
  wall: { name: WALL_TIERS[0].name, cost: WALL_TIERS[0].cost, hp: WALL_TIERS[0].hp, turret: null },
  depot: { name: 'Ammo depot', cost: 90, hp: 900, turret: null },
  post: { name: 'Repair post', cost: 110, hp: 800, turret: null },
  spikes: { name: 'Spike strip', cost: 12, hp: 450, turret: null },
  tesla: {
    name: 'Tesla coil', cost: 260, hp: 1100,
    turret: { prefers: 'walker', range: 230, fireMs: 1000, damage: 40, pellets: 1, bulletSpeed: 0, spread: 0, ammo: 36, scrapPerRound: 1.5, muzzle: 0, bullet: { r: 2, color: '#8fd3ff' }, lobbed: null, arc: { jumps: 3, reach: 120, falloff: 0.75 } },
  },
  sentry: {
    name: 'Sentry', cost: 70, hp: 1000,
    turret: { prefers: 'walker', range: 420, fireMs: 140, damage: 14, pellets: 1, bulletSpeed: 2000, spread: 0.06, ammo: 120, scrapPerRound: 0.25, muzzle: 28, bullet: { r: 1.8, color: '#a88600' }, lobbed: null },
  },
  cannon: {
    name: 'Cannon', cost: 180, hp: 1500,
    turret: { prefers: 'brute', range: 560, fireMs: 2200, damage: 260, pellets: 1, bulletSpeed: 2600, spread: 0.01, ammo: 10, scrapPerRound: 4, muzzle: 33, bullet: { r: 4.2, color: '#3b3f4a' }, lobbed: null },
  },
  scatter: {
    name: 'Scatter', cost: 90, hp: 1200,
    turret: { prefers: 'runner', range: 260, fireMs: 650, damage: 11, pellets: 7, bulletSpeed: 1600, spread: 0.22, ammo: 40, scrapPerRound: 0.5, muzzle: 24, bullet: { r: 1.6, color: '#2f9e8f' }, lobbed: null },
  },
  mortar: {
    name: 'Mortar', cost: 220, hp: 1000,
    turret: {
      prefers: 'plated', range: 750, fireMs: 2600, damage: 0, pellets: 1, bulletSpeed: 700, spread: 0.04, ammo: 8, scrapPerRound: 5, muzzle: 18, bullet: { r: 5, color: '#4a3f35' },
      lobbed: { radius: 120, damage: 160 },
    },
  },
};

/** The survivors shoot from the Bastion's walls at what comes close; all of them fire a round every `fireMs`, fewer of them slower. */
export const BASTION_GUN: TurretDef = {
  prefers: 'brute', range: 220, fireMs: 300, damage: 20, pellets: 1, bulletSpeed: 1800, spread: 0.08, ammo: Infinity, scrapPerRound: 0, muzzle: 50,
  bullet: { r: 1.6, color: '#4fd1e8' }, lobbed: null,
};

export const ZOM = {
  /** Zombie kill score is scaled by this, since a run pays no medals, so a run climbs the same `LEVELS` over its nights. */
  levelScoreMul: 1.6,
  /** One grid cell in px; a building fills one cell and the horde's flow field runs on the same grid. */
  cell: 50,
  coreHp: 4000,
  /**
   * Who shelters in the core: one is lost for every `survivorHp` of harm the core takes, mended or not. Losing the last of them does not end the
   * run (only the core's fall does), but each one left pays `scrapPerSurvivor` at dawn, mans the Bastion's gun and pays for reinforcements.
   */
  survivors: 50,
  survivorHp: 100,
  scrapPerSurvivor: 3,
  /** A squad player who bleeds out at night is back at the Bastion after `ms`, and `survivors(night)` of those sheltering there are lost to send them; with too few left they wait for dawn, when everyone stands up free. */
  reinforce: { ms: 15_000, survivors: (night: number) => 1 + Math.ceil(night / 2) },
  /** The share of each bite the core shrugs off, so a breach is an emergency the squad can answer rather than the end. */
  coreArmor: 0.4,
  /** Half the side of the square core at the map's center. */
  coreHalf: 50,
  dayMs: 40_000,
  /** How far from the core's center a building may stand. */
  buildRadius: 600,
  /** How far from the builder's center a building may be placed, repaired or reloaded. */
  reachPx: 250,
  /** The kinds build mode lays in a dragged line, and the most cells one line holds: past the reach's whole width, so reach, not the cap, ends a line. */
  lineKinds: ['wall', 'spikes'],
  lineMax: 12,
  reviveMs: 3000,
  reviveRange: 70,
  bleedOutMs: 25_000,
  crawlMul: 0.3,
  /** Health back after a revive, as a share of max. */
  reviveHpFrac: 0.4,
  repairHpPerSec: 80,
  /** Mending a building costs this share of its price for the share of it that is worn. */
  repairShare: 0.5,
  /** How long holding use takes to fill an empty turret. */
  refillMs: 2500,
  /** Dearer than a wall's, so the core wears down over the nights instead of being made whole every day. */
  coreRepairScrapPerHp: 0.2,
  /** The share of a building's price paid back for taking it down whole; a worn one pays back less. */
  demolishRefund: 0.5,
  startScrap: 140,
  squadSize: 4,
  /** The most zombies alive at once: a wave brings only the packs that fit under it, and spawning waits while none does. */
  maxAlive: 200,
  /** How far past touching a zombie's bite reaches. */
  biteReach: 10,
  /** What walking through a wall cell costs the flow field, in orthogonal steps; high enough that the horde takes any open way round. */
  wallCostCells: 40,
  hordeShare: (squad: { humans: number; bots: number }) => (squad.bots + 1.5 * squad.humans) / 4,
  /** Each wave of a night brings this many packs at once, from their own sides, then waits `packGapMs` for each before the next, so later nights come in fewer, bigger waves. */
  packsPerWave: (night: number) => Math.max(1, night - 1),
  packGapMs: (night: number) => Math.max(1000, 2600 - 120 * night),
  /** First light comes this long after the night's last pack walks in, and burns whatever of the horde is still out. */
  stragglersMs: 90_000,
  nightMul: (night: number) => ({ hp: 1 + 0.22 * (night - 1), damage: 1 + 0.12 * (night - 1), speed: 1 + 0.025 * Math.min(night - 1, 8) }),
  restartMs: 20_000,
} as const;

/**
 * Last Squad's ring, one row per phase: the safe circle holds for `waitMs`, then closes over `shrinkMs` to `radius`, inside the circle it closes from.
 * Outside the circle a body loses `dps` of its max health a second (half that each half second, `dotPulses` in sim/dot.ts), through armor and the spawn shield, and does not regenerate.
 */
export type RingPhase = { waitMs: number; shrinkMs: number; radius: number; dps: number };
export const RING: readonly RingPhase[] = [
  { waitMs: 60_000, shrinkMs: 30_000, radius: 3200, dps: 0.02 },
  { waitMs: 45_000, shrinkMs: 25_000, radius: 2500, dps: 0.03 },
  { waitMs: 40_000, shrinkMs: 20_000, radius: 1900, dps: 0.05 },
  { waitMs: 30_000, shrinkMs: 20_000, radius: 1300, dps: 0.08 },
  { waitMs: 25_000, shrinkMs: 15_000, radius: 700, dps: 0.12 },
  { waitMs: 20_000, shrinkMs: 15_000, radius: 0, dps: 0.2 },
];

export const ROYALE = {
  squadSize: 3,
  /** Redeploys stay open until this many ring phases have closed; after that every life is the last. */
  redeployPhases: 3,
  redeployMs: (deaths: number) => 15_000 + 10_000 * Math.max(0, deaths - 1),
  /** A knocked player's own health, as a share of their max, which enemies shoot through to finish them. */
  knockHpFrac: 0.5,
  crateScore: 25,
  /** Each phase's supply drop lands this long into the phase's wait; minimaps show it `dropNoticeMs` before it lands. */
  dropLandMs: 20_000,
  dropNoticeMs: 10_000,
  dropHp: 300,
  dropSize: 64,
} as const;
