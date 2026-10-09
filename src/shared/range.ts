/**
 * The shooting range (mode `RNG`): numbers shared by the simulation, the server and the client.
 * A target is a standing thing with health that every weapon and ability hurts through the normal damage path; knocked down
 * it lies for `RANGE.regenMs`, then springs back up whole. Its place is a pure function of the server clock (`targetPos`), so a
 * sliding target costs the wire nothing: the snapshot carries only each target's health.
 */
export const TARGET_KINDS = ['paper', 'plank', 'rail', 'dummy'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/**
 * `hp` is raw damage, so a pistol round (25) takes four to drop a paper target; `r` is the radius rounds and blasts see. `top` is how
 * far above its base (`targetPos`) the drawn board reaches (targetart.ts draws it standing up from the base), so a round meets what
 * you see: see `targetBody`.
 */
export const TARGETS: Record<TargetKind, { name: string; desc: string; hp: number; r: number; top: number }> = {
  paper: { name: 'Paper target', desc: 'A paper soldier on a stake', hp: 100, r: 24, top: 64 },
  plank: { name: 'Wood board', desc: 'A thick board on a post; takes a few hits', hp: 260, r: 28, top: 66 },
  rail: { name: 'Rail target', desc: 'A paper soldier on a cart that slides along its rail', hp: 100, r: 24, top: 68 },
  dummy: { name: 'Training dummy', desc: 'A sandbag soldier with a lot of stuffing', hp: 600, r: 27, top: 87 },
};

/** How far below its base a target's drawn base plate or cart reaches. */
const FOOT_PX = 6;

/**
 * What a round meets of a target standing at `at`: an upright capsule of radius `r` from just under its base plate to the top of its
 * board, `up` px tall between its end circles, with (x, y) the lower circle's centre. Only the base used to count, so a round through
 * the drawn bullseye (32 px up) passed over a circle of radius 24 at the base.
 */
export function targetBody(kind: TargetKind, at: { x: number; y: number }): { x: number; y: number; up: number; r: number } {
  const { r, top } = TARGETS[kind];
  return { x: at.x, y: at.y - (r - FOOT_PX), up: Math.max(0, top - 2 * r + FOOT_PX), r };
}

/** Where to aim at a target standing at `at`: the middle of what a round meets of it (`targetBody`), on its board. */
export function targetAim(kind: TargetKind, at: { x: number; y: number }): { x: number; y: number } {
  const b = targetBody(kind, at);
  return { x: b.x, y: b.y - b.up / 2 };
}

export const RANGE = {
  /** A knocked-down target stays down this long, then pops up with a full health bar. */
  regenMs: 4000,
  /** A target that is hurt and left alone heals back to full after this long without a hit. */
  healMs: 4000,
  /** Barrels and props stand again this long after they go off (they take 30 to 90 seconds in the versus modes). */
  propRespawnMs: 6000,
  /** The readout's DPS is the damage dealt over this long. */
  dpsWindowMs: 3000,
  /** Target ids sit far above any player's, crate's or barrel's, so `id - idBase` is the target's place in the layout. */
  idBase: 1_000_000,
} as const;

/** `axis` is the way a rail target slides across the lane, `reach` how far either side of (`x`, `y`), `speed` in px/s, `phase` 0..1 where in its run it starts. */
export type Rail = { axis: 'x' | 'y'; reach: number; speed: number; phase: number };
export type TargetDef = { kind: TargetKind; x: number; y: number; rail?: Rail };

/** `line` is the firing line's x; `marks` are the distances painted on the floor from it, and `lanes` each lane's band (for the floor paint). */
export type RangeLayout = {
  /** Where you stand when you arrive, painted as a pad. */
  pad: { x: number; y: number; w: number; h: number };
  targets: readonly TargetDef[];
  line: number;
  marks: readonly number[];
  lanes: readonly { y0: number; y1: number; label: string }[];
};

/** Where a target stands at server time `t` ms: its spot, or its place on the rail at constant speed, turning back at each end. */
export function targetPos(d: TargetDef, t: number): { x: number; y: number } {
  const rail = d.rail;
  if (!rail) return { x: d.x, y: d.y };
  const run = (4 * rail.reach) / rail.speed;
  const u = (((t / 1000 / run + rail.phase) % 1) + 1) % 1;
  const tri = u < 0.5 ? u * 2 : 2 - u * 2;
  const off = (tri * 2 - 1) * rail.reach;
  return rail.axis === 'x' ? { x: d.x + off, y: d.y } : { x: d.x, y: d.y + off };
}

/** What a snapshot says of each target, in layout order: tenths of full health 1..10 while it stands, 0 while it lies knocked down. */
export type TargetView = number;

/** The readout the range shows its one player: the last hit, damage per second, accuracy and the last time to kill. */
export type RangeView = {
  /** The last round or blast that landed: its damage, how far the shooter stood from the target, and the server time. */
  last: { dmg: number; dist: number; at: number } | null;
  /** Damage dealt over the last `RANGE.dpsWindowMs`, per second. */
  dps: number;
  /** Trigger pulls, and those that hit at least once. */
  shots: number; hits: number;
  /** Ms from the first hit on the last target you dropped to its fall, with how far away it stood, or null before the first. */
  ttk: { ms: number; dist: number; kind: TargetKind } | null;
  /** Targets dropped, and all damage dealt, since the stats were last reset. */
  downs: number; total: number;
};
