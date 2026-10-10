import { armorShare, EVOLUTIONS, GUN_IDS, GUNS, WEAPON_IDS, WORLD, type ArmorId, type GunId } from '../../src/shared/defs.ts';
import { addPlayer } from '../../src/shared/sim.ts';
import { effectiveStats, falloffMul, spreadFor } from '../../src/shared/sim/stats.ts';
import { pullTrigger } from '../../src/shared/sim/trigger.ts';
import { createWorld } from '../../src/shared/sim/world.ts';
import { lookReach } from '../../src/shared/lookahead.ts';

export const DPS_RANGES = [150, 400, 700, 1000] as const;

export const AXES = [
  ...DPS_RANGES.map((d) => `still@${d}` as const), ...DPS_RANGES.map((d) => `moving@${d}` as const),
  'perPull', 'magSeconds', 'range', 'bulletSpeed', 'moveMul', 'uptime', 'reloadMs', 'penetrate', 'blast', 'silenced',
] as const;
export type Axis = (typeof AXES)[number];
export type GunScore = Record<Axis, number>;
const LOWER_BETTER: ReadonlySet<Axis> = new Set(['reloadMs']);

const msPerRound = (id: GunId) => { const g = GUNS[id]; return g.burst ? ((g.burst.count - 1) * g.burst.gapMs + g.fireMs) / g.burst.count : g.fireMs; };

const HOLD_MS = 2000;
const TICK_MS = 1000 / WORLD.tickHz;

/** The spray index of every shot over the first two seconds of a held trigger, reloads, spin-up and bloom included, through the sim's own trigger. */
const heldTrigger = (id: GunId, holdMs: number) => {
  const g = GUNS[id];
  const s = { ammo: g.mag, reloadUntil: null as number | null, nextFireAt: 0, burstLeft: 0, pressUntil: -Infinity, spray: 0, firedAt: -Infinity, spin: 0 };
  const shots: { at: number; spray: number }[] = [];
  for (let now = 0; now < holdMs; now += TICK_MS) {
    if (pullTrigger(s, { def: g, mag: g.mag, reloadMs: g.reloadMs, armed: true }, { fire: true, reload: false, pressed: true }, now, TICK_MS)) shots.push({ at: now, spray: s.spray });
  }
  return shots;
};
const heldShots = new Map(GUN_IDS.map((id) => [id, heldTrigger(id, HOLD_MS).map((s) => s.spray)] as const));

/** Shots over the 8 seconds after the first, with reloads, for time to kill. */
export const TTK_HOLD_MS = 8000;
const heldLong = new Map(GUN_IDS.map((id) => [id, heldTrigger(id, TTK_HOLD_MS)] as const));

/** Expected hit share of one pellet at range `d`: the body's cone over the spread. */
const hitShare = (id: GunId, d: number, still: boolean, spray: number) => {
  const spread = spreadFor(id, {}, still, spray, 0, 0, still);
  return spread <= 0 ? 1 : Math.min(1, Math.atan(WORLD.playerRadius / d) / spread);
};

/** The damage one round does to a body at `d` after the damage fade, before armor (a blast round counts its blast on a direct hit). */
const roundDamage = (id: GunId, d: number) => GUNS[id].damage * falloffMul(id, d) + (GUNS[id].blast?.damage ?? 0);

export function dpsAt(id: GunId, d: number, still: boolean): number {
  const g = GUNS[id];
  if (d > g.range) return 0;
  const hits = heldShots.get(id)!.reduce((sum, spray) => sum + hitShare(id, d, still, spray), 0);
  return (g.pellets * hits * roundDamage(id, d) * 1000) / HOLD_MS;
}

/**
 * Milliseconds from a gun's first round to a kill on a full-health bot in `armor` at range `d`, by expected damage per round
 * (pellets landing, bloom, damage fade, reloads); null when it cannot kill within `TTK_HOLD_MS` or `d` is past its range.
 */
export function ttkMs(id: GunId, d: number, armor: ArmorId, still: boolean): number | null {
  const g = GUNS[id];
  if (d > g.range) return null;
  let dealt = 0;
  const first = heldLong.get(id)![0]?.at ?? 0;
  for (const shot of heldLong.get(id)!) {
    dealt += g.pellets * hitShare(id, d, still, shot.spray) * roundDamage(id, d) * (1 - armorShare(armor));
    if (dealt >= WORLD.baseHp - 1e-9) return shot.at - first;
  }
  return null;
}

export function scoreGun(id: GunId): GunScore {
  const g = GUNS[id];
  const firing = g.mag * msPerRound(id);
  const dps = (still: boolean) => DPS_RANGES.map((d) => dpsAt(id, d, still));
  const [s150, s400, s700, s1000] = dps(true);
  const [m150, m400, m700, m1000] = dps(false);
  return {
    'still@150': s150!, 'still@400': s400!, 'still@700': s700!, 'still@1000': s1000!,
    'moving@150': m150!, 'moving@400': m400!, 'moving@700': m700!, 'moving@1000': m1000!,
    perPull: g.pellets * (g.damage + (g.blast?.damage ?? 0)) * (g.burst?.count ?? 1),
    magSeconds: firing / 1000, range: g.range, bulletSpeed: g.bulletSpeed,
    moveMul: g.moveMul, uptime: firing / (firing + g.reloadMs), reloadMs: g.reloadMs,
    penetrate: g.penetrate ?? 0, blast: g.blast ? 1 : 0, silenced: g.silenced ? 1 : 0,
  };
}

const EPS = 1e-9;
const atLeast = (axis: Axis, a: number, b: number) => (LOWER_BETTER.has(axis) ? a <= b + EPS : a >= b - EPS);
export const dominates = (a: GunScore, b: GunScore) => AXES.every((k) => atLeast(k, a[k], b[k])) && AXES.some((k) => !atLeast(k, b[k], a[k]));

export const TREE_ORDER: readonly GunId[] = WEAPON_IDS.flatMap((base) => [base, ...EVOLUTIONS[base].flatMap((g) => [g, ...EVOLUTIONS[g]])]);

export type Pair = readonly [winner: GunId, loser: GunId];
export const gunsOfStage = (stage: 0 | 1 | 2) => GUN_IDS.filter((id) => GUNS[id].stage === stage);

export function dominatedPairs(stage: 0 | 1 | 2): Pair[] {
  const ids = gunsOfStage(stage);
  const scores = new Map(ids.map((id) => [id, scoreGun(id)]));
  return ids.flatMap((a) => ids.filter((b) => a !== b && dominates(scores.get(a)!, scores.get(b)!)).map((b) => [a, b] as const));
}

/** Guns whose range passes what their owner sees down the aim: the view radius plus the full aim look-ahead (lookahead.ts), with no perks. */
export function rangeBeyondView(): { id: GunId; range: number; view: number }[] {
  const w = createWorld('FFA', 1, 'plaza');
  return GUN_IDS.flatMap((id) => {
    const p = addPlayer(w, id, { weapon: GUNS[id].base, armor: 'none', color: 'red' });
    p.gun = id;
    const s = effectiveStats(p);
    const view = s.viewRadius + lookReach(s.viewRadius, id);
    return s.range > view + 1e-6 ? [{ id, range: s.range, view }] : [];
  });
}

/** A gun's felt edges over another: every axis it leads by `margin` or more, a lead too small to notice in play being no edge. */
export function edgesOver(a: GunId, b: GunId, margin = 1.2): Axis[] {
  const sa = scoreGun(a), sb = scoreGun(b);
  return AXES.filter((k) => (LOWER_BETTER.has(k) ? sb[k] >= sa[k] * margin && sa[k] > 0 : sa[k] >= Math.max(sb[k], EPS) * margin));
}
