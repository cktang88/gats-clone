/**
 * Handling: how a gun handles, worked out from what it physically is rather than hand-set per gun. Every gun and evolution has a weight
 * (`kg`), a length (`cm`) and a calibre (`CALIBRES`: the round's muzzle energy, all of a shell's pellets together); each armor tier has a
 * weight. From those, a few documented formulas give:
 *
 * - `floor`: the least spread it ever fires with (bigger rounds and short barrels group worse).
 * - `sway`: the spread walking adds on top of the still spread (the gun's moment of inertia, kg x length squared, past a light gun's free swing).
 * - `kick`: the bloom one round adds (radians), from its energy, soaked by the gun's weight and steadied by its length. Bloom then grows at
 *   `kick x rounds per second` (`growthPerSec`), never a constant of its own, up to `cap`, and comes back down at `decayPerSec`.
 * - `still`: the share of its moving bloom a gun grows standing (a heavy gun leans on the body better).
 * - `settleMs`: how long the post-sprint bloom takes to ease out (a light, short gun is steady at once; a heavy, long one swings for seconds).
 * - `swingMs`: the cosmetic swing from the sprint carry up to the aim.
 * - walk speed and sprint speed, from the whole load carried: the gun (its weight, plus a little for its length) and the armor.
 *
 * A pinpoint (scoped) gun's kick, cap, decay and sway are scaled by `SCOPE` (the sight picture is lost and found again, not just the muzzle
 * moved), and a bolt-action's further by `BOLT` (working the bolt breaks the cheek weld). Those are the only factors that are not physics;
 * everything a gun's role needs beyond them lives in its rules (bursts, bipods, rev-up, falloff, the pellet pattern) and in the handful of
 * explicit, marked overrides on the gun itself (`GunDef.overrides`). scripts/handling-table.ts prints the table.
 */

/** A round: its bore (mm, for show) and its muzzle energy in joules (a shotgun shell's, all pellets together). */
export const CALIBRES = {
  '4.6mm': { mm: 4.6, joules: 500 },
  '5.7mm': { mm: 5.7, joules: 540 },
  '9mm': { mm: 9, joules: 500 },
  '.45 ACP': { mm: 11.4, joules: 560 },
  '.357': { mm: 9.1, joules: 800 },
  '.44 Mag': { mm: 10.9, joules: 1500 },
  '.50 AE': { mm: 12.7, joules: 1800 },
  '5.56mm': { mm: 5.56, joules: 1750 },
  '6.5mm': { mm: 6.5, joules: 2600 },
  '7.62x39': { mm: 7.62, joules: 2100 },
  '7.62x51': { mm: 7.62, joules: 3500 },
  '.338': { mm: 8.6, joules: 6500 },
  '.50 BMG': { mm: 12.7, joules: 17000 },
  '12 ga': { mm: 18.5, joules: 3000 },
  '12 ga slug': { mm: 18.5, joules: 3300 },
} as const satisfies Record<string, { mm: number; joules: number }>;
export type CalibreId = keyof typeof CALIBRES;

/** What a gun physically is. `pinpoint` and `bolt` come from its rules and its action; `rps` is rounds per second (a burst averaged out). */
export type Build = { kg: number; cm: number; calibre: CalibreId; spread: number; rps: number; pinpoint: boolean; bolt: boolean };

/**
 * The constants of the formulas below. A reference gun (`REF`: an assault rifle, 3.6 kg, 90 cm, 5.56 mm) sits at the reference values;
 * every other gun is scaled from it by ratios of weight, length and energy raised to these powers. Tune these, not per-gun numbers.
 */
export const HANDLING = {
  REF: { kg: 3.6, cm: 90, joules: 1750 },
  /** floor = floor0 x energy^e / length^l */
  floor: { at: 0.0105, energy: 0.1, length: 0.6 },
  /** sway = sway0 x sqrt(max(0, inertia - free)), inertia = kg x (cm / 90)^2 */
  sway: { at: 0.0169, free: 1.5 },
  /** kick = kick0 x energy^e / (weight^w x length^l) */
  kick: { at: 0.0049, energy: 0.6, weight: 0.7, length: 0.3 },
  /** cap = cap0 x energy^e / weight^w: the most bloom a spray can stack */
  cap: { at: 0.056, energy: 0.3, weight: 0.3 },
  /** decay = cap / recover, recover = recover0 x weight^w x length^l ms (a heavy gun takes longer to bring back on) */
  recover: { at: 190, weight: 0.5, length: 0.3 },
  /** still = still0 / weight^w, clamped */
  still: { at: 0.5, weight: 0.25, min: 0.35, max: 0.7 },
  /** The post-sprint bloom opens spread to this many times the gun's moving spread (every gun alike; how long it lasts is `settle`). */
  sprintBloom: 4,
  /** settleMs = min + span x inertia^n / (inertia^n + mid^n): a Hill curve, light guns near min, heavy ones near min + span */
  settle: { min: 300, span: 2200, mid: 2.14, n: 2.32 },
  /** swingMs = min + span x inertia / (inertia + mid) */
  swing: { min: 150, span: 150, mid: 4 },
  /** A scoped gun's and a bolt-action's kick, cap and recovery multipliers (see the module note). */
  SCOPE: { kick: 8.2, cap: 1.4, recover: 6.7, sway: 1.85 },
  BOLT: { kick: 3.8, cap: 1, recover: 1.6, sway: 1 },
  /**
   * Load (kg) = gun kg + gun cm x `perCm` + armor kg. Walk speed (share of base) = `top` - `perKg` x load, never under `floor`. The share
   * of the sprint bonus kept = clamp(`min`, `max`, `max` - (load / `soft`)^2): a light load sprints hardest, a heavy one barely.
   */
  load: { perCm: 0.01, top: 1.06, perKg: 0.032, floor: 0.58 },
  sprint: { max: 1.15, min: 0.1, soft: 14 },
} as const;

export type Handling = {
  floor: number; sway: number; kick: number; cap: number; recoverMs: number; still: number; settleMs: number; swingMs: number;
  /** Bloom growth while the trigger is held: `kick` x `rps`, radians per second. */
  growthPerSec: number;
  /** How fast a spray's bloom comes back down, radians per second (`cap` over `recoverMs`). */
  decayPerSec: number;
};

const H = HANDLING;
/** Derived numbers are kept to a sensible precision, so the table reads cleanly and a formula's float noise never reaches the sim. */
const round = (x: number, places: number): number => Math.round(x * 10 ** places) / 10 ** places;
/** A gun's moment of inertia, roughly: kg x (cm / 90)^2. A pistol is ~0.04, an SMG ~1, an assault rifle 3.6, an LMG ~13. */
export const inertiaOf = (kg: number, cm: number): number => kg * (cm / 90) ** 2;

export function handlingOf(b: Build): Handling {
  const e = CALIBRES[b.calibre].joules / H.REF.joules, m = b.kg / H.REF.kg, l = b.cm / H.REF.cm, inertia = inertiaOf(b.kg, b.cm);
  const ONE = { kick: 1, cap: 1, recover: 1, sway: 1 }, scope = b.pinpoint ? H.SCOPE : ONE, bolt = b.bolt ? H.BOLT : ONE;
  const kick = round(H.kick.at * e ** H.kick.energy / (m ** H.kick.weight * l ** H.kick.length) * scope.kick * bolt.kick, 5);
  const cap = round(H.cap.at * e ** H.cap.energy / m ** H.cap.weight * scope.cap * bolt.cap, 4);
  const recoverMs = Math.round(H.recover.at * m ** H.recover.weight * l ** H.recover.length * scope.recover * bolt.recover);
  const hill = inertia ** H.settle.n / (inertia ** H.settle.n + H.settle.mid ** H.settle.n);
  return {
    floor: round(H.floor.at * e ** H.floor.energy / l ** H.floor.length, 5),
    sway: round(H.sway.at * Math.sqrt(Math.max(0, inertia - H.sway.free)) * scope.sway * bolt.sway, 5),
    kick, cap, recoverMs,
    still: round(Math.min(H.still.max, Math.max(H.still.min, H.still.at / m ** H.still.weight)), 2),
    settleMs: Math.round(H.settle.min + H.settle.span * hill),
    swingMs: Math.round(H.swing.min + (H.swing.span * inertia) / (inertia + H.swing.mid)),
    growthPerSec: kick * b.rps,
    decayPerSec: cap / (recoverMs / 1000),
  };
}

/** The load (kg) a soldier carries: the gun, a little more for a long one (it swings and snags), and the armor. */
export const loadOf = (gunKg: number, gunCm: number, armorKg: number): number => gunKg + gunCm * H.load.perCm + armorKg;
/** Walk speed as a share of the base speed under `load` kg; nobody crawls (`HANDLING.load.floor`). */
export const walkMulOf = (load: number): number => Math.max(H.load.floor, H.load.top - H.load.perKg * load);
/** How much of the sprint bonus (`SPRINT.speedMul`) a soldier under `load` kg keeps: over 1 for a light load, near none for the heaviest. */
export const sprintShareOf = (load: number): number => Math.min(H.sprint.max, Math.max(H.sprint.min, H.sprint.max - (load / H.sprint.soft) ** 2));
