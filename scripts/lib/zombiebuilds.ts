import { BUILDINGS, hordeCount, nightOf, UTILITY, WALL_TIERS, WORLD, ZOM, ZOMBIE_KINDS, ZOMBIES, type TurretKind, type ZombieKind } from '../../src/shared/defs.ts';
import { MAPS } from '../../src/shared/maps.ts';
import { step } from '../../src/shared/sim.ts';
import { cellRect, investedOf, maxHpOf, repairScrapPerHp, turretDef, upgradeCost, wallTier } from '../../src/shared/sim/build.ts';
import { rectsOverlap } from '../../src/shared/sim/movement.ts';
import { zombieMaxHp } from '../../src/shared/sim/run.ts';
import { coverRects, createWorld, newId, rand, type Building, type Turret, type World, type Zombie } from '../../src/shared/sim/world.ts';

const TICK_MS = 1000 / WORLD.tickHz;
/** The ring's half-width in cells round the core's center cell, and the walk from the spawn line to the ring. */
const RING = 4, SPAWN_PX = 700;
/** How long a dry turret waits for someone to come and refill it, when it is tended. */
const TEND_MS = 3000;

export type FortSetup = {
  night: number; seed?: number; ms?: number;
  /** The zombies that walk in: the night's own mix (default), or packs of only these kinds. */
  kinds?: readonly ZombieKind[];
  turrets?: readonly { kind: TurretKind; lv: number }[];
  /** The ring's south face at this wall tier with its real health; otherwise the whole ring stands unbreakable. */
  southTier?: number;
  /** A utility one cell further in, behind the turrets. */
  depot?: number; post?: number;
  /** A row of spike strips laid along the outside of the south face. */
  spikes?: boolean;
  /** Whether a dry turret is refilled (after `TEND_MS`), as a squad does; without it only a depot refills it. */
  tend?: boolean;
  /** Keep streaming zombies while fewer than this are alive. */
  alive?: number;
};
export type FortRun = {
  /** Health the horde lost in all, and its kills. */
  harm: number; kills: number; byKind: Record<ZombieKind, number>;
  /** Rounds the turrets fired, the scrap the refills cost (a depot's at its share) and the scrap mending the turrets' wear would cost; a turret lost is its whole price. */
  rounds: number; ammoScrap: number; /** The scrap the kills paid into the bank. */ income: number; repairScrap: number; turretsLost: number;
  /** What the horde took off the south face, before its armor, the scrap mending it would cost, and the first second a wall of it fell (null if none did). */
  wallBitten: number; wallRepairScrap: number; breachSec: number | null;
  /** Health a repair post gave back to the buildings, and what mending that by hand would have cost. */
  mended: number; mendedScrap: number;
  seconds: number;
};

const coreCell = (w: World) => Math.floor(MAPS[w.map].siege!.core.x / ZOM.cell);

/**
 * A scripted lane: the Outpost's core walled in by a ring of walls `RING` cells out (unbreakable but for a south face at `southTier`), turrets just inside the
 * south face, and packs of night `night`'s zombies (its mix, at its health and bite) streaming in from `SPAWN_PX` south while fewer than `alive` stand.
 * The Bastion's own gun is silenced (no survivors), so the horde's losses are the buildings' work. Measures what the buildings did and what they cost to keep.
 */
export function playFort(s: FortSetup): FortRun {
  const w = createWorld('ZOM', s.seed ?? 1, 'outpost');
  const run = w.run!;
  const ms = s.ms ?? 90_000, night = s.night, c = coreCell(w);
  run.night = night;
  run.core.hp = 1e12;
  run.survivors = 0;
  run.scrap = 1e9;
  run.phase = { k: 'night', toSpawn: [{ kind: 'walker', side: 'north', n: 1 }], nextSpawnAt: Infinity, dawnAt: Infinity };
  const cover = coverRects(w);
  const free = (cx: number, cy: number) => !cover.some((r) => rectsOverlap(r, cellRect(cx, cy)));
  const south: Building[] = [];
  for (let cy = c - RING; cy <= c + RING; cy++) {
    for (let cx = c - RING; cx <= c + RING; cx++) {
      if (Math.max(Math.abs(cx - c), Math.abs(cy - c)) !== RING || !free(cx, cy)) continue;
      const real = s.southTier !== undefined && cy === c + RING;
      const lv = real ? s.southTier! : 3;
      const b: Building = { id: newId(w), kind: 'wall', cx, cy, hp: real ? wallTier(lv).hp : 1e9, ...(lv > 1 && { lv }) };
      w.buildings.push(b);
      if (real) south.push(b);
    }
  }
  const turrets: Turret[] = (s.turrets ?? []).map((t, i, all) => {
    const cx = c + i - Math.floor((all.length - 1) / 2);
    const b: Turret = { id: newId(w), kind: t.kind, cx, cy: c + RING - 1, hp: maxHpOf(t.kind, t.lv), ...(t.lv > 1 && { lv: t.lv }), owner: -1, ammo: turretDef(t.kind, t.lv).ammo, nextFireAt: 0 };
    w.buildings.push(b);
    return b;
  });
  if (s.depot) w.buildings.push({ id: newId(w), kind: 'depot', cx: c - 1, cy: c + RING - 2, hp: maxHpOf('depot', s.depot), ...(s.depot > 1 && { lv: s.depot }) });
  const post = s.post ? { id: newId(w), kind: 'post' as const, cx: c + 1, cy: c + RING - 2, hp: maxHpOf('post', s.post), ...(s.post > 1 && { lv: s.post }) } : null;
  if (post) w.buildings.push(post);
  if (s.spikes) for (let cx = c - RING; cx <= c + RING; cx++) if (free(cx, c + RING + 1)) w.floor.push({ id: newId(w), kind: 'spikes', cx, cy: c + RING + 1, hp: maxHpOf('spikes') });
  w.buildingsVersion++;

  const r = () => rand(w);
  const mix: ZombieKind[] = [];
  const def = nightOf(night).horde;
  for (const kind of s.kinds ?? ZOMBIE_KINDS) {
    const n = s.kinds ? ZOMBIES[kind].pack * 4 : hordeCount(kind, def[kind] ?? 0, 1);
    for (let left = n; left > 0; left -= ZOMBIES[kind].pack) mix.push(kind);
  }
  for (let i = mix.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [mix[i], mix[j]] = [mix[j]!, mix[i]!]; }
  const core = MAPS[w.map].siege!.core;
  let next = 0, spawnAt = 0;
  const spawnPack = (kind: ZombieKind) => {
    const n = ZOMBIES[kind].pack, x0 = core.x + (r() - 0.5) * 300;
    for (let i = 0; i < n; i++) {
      w.zombies.push({ id: newId(w), kind, x: x0 + (i - (n - 1) / 2) * 44, y: core.y + SPAWN_PX + (r() - 0.5) * 60 + (i % 2) * 40, hp: zombieMaxHp(kind, night, 1), attackAt: 0, vx: 0, vy: 0, pack: 1 });
    }
  };

  const byKind = Object.fromEntries(ZOMBIE_KINDS.map((k) => [k, 0])) as Record<ZombieKind, number>;
  const out: FortRun = { harm: 0, kills: 0, byKind, rounds: 0, ammoScrap: 0, income: 0, repairScrap: 0, turretsLost: 0, wallBitten: 0, wallRepairScrap: 0, breachSec: null, mended: 0, mendedScrap: 0, seconds: ms / 1000 };
  const dryAt = new Map<Turret, number>();
  const hpOf = new Map<Zombie, number>();
  for (let t = 0; t < ms; t += TICK_MS) {
    if (w.now >= spawnAt && w.zombies.length < (s.alive ?? 30)) {
      spawnPack(mix[next++ % mix.length]!);
      spawnAt = w.now + 1200;
    }
    for (const z of w.zombies) hpOf.set(z, z.hp);
    const ammo = turrets.map((b) => b.ammo), hp = turrets.map((b) => b.hp), wallHp = south.map((b) => b.hp), postHp = w.buildings.filter((b) => b !== post).map((b) => [b, b.hp] as const);
    const scrapWas = run.scrap;
    step(w, TICK_MS);
    let paid = 0;
    for (const e of w.events) if (e.e === 'zkill') { out.kills++; byKind[e.kind]++; paid += e.scrap ?? 0; }
    out.income += paid;
    // The bank fell by what a depot charged and rose by what the kills paid.
    out.ammoScrap += scrapWas - run.scrap + paid;
    for (const [z, was] of hpOf) out.harm += w.zombies.includes(z) ? Math.max(0, was - z.hp) : Math.max(0, was);
    hpOf.clear();
    // A post mends before the horde's next bite: what it gave back is any rise in a building's health this tick.
    if (post) for (const [b, was] of postHp) if (b.hp > was && w.buildings.includes(b)) { out.mended += b.hp - was; out.mendedScrap += (b.hp - was) * repairScrapPerHp(b.kind, b.lv ?? 1); }
    turrets.forEach((b, i) => {
      const lv = b.lv ?? 1, tdef = turretDef(b.kind, lv);
      if (b.ammo < ammo[i]!) out.rounds += Math.round(ammo[i]! - b.ammo);
      const alive = w.buildings.includes(b);
      if (!alive) { if (hp[i]! > 0) { out.turretsLost++; b.hp = 0; } return; }
      if (b.hp < hp[i]!) out.repairScrap += (hp[i]! - b.hp) * repairScrapPerHp(b.kind, lv);
      if (s.tend && b.ammo < 1) {
        if (!dryAt.has(b)) dryAt.set(b, w.now);
        else if (w.now - dryAt.get(b)! >= TEND_MS) { out.ammoScrap += (tdef.ammo - b.ammo) * tdef.scrapPerRound; b.ammo = tdef.ammo; dryAt.delete(b); }
      }
    });
    south.forEach((b, i) => {
      const lost = wallHp[i]! - Math.max(0, b.hp);
      if (lost <= 0) return;
      // What came off it after its armor gave its share back is what mending costs; before it, what the horde bit.
      out.wallBitten += lost / (1 - wallTier(b.lv ?? 1).armor);
      out.wallRepairScrap += lost * repairScrapPerHp('wall', b.lv ?? 1);
      if (b.hp <= 0 && out.breachSec === null) out.breachSec = w.now / 1000;
    });
  }
  for (const b of turrets) if (!w.buildings.includes(b) && b.hp !== 0) out.turretsLost++;
  // A turret lost must be built again: its whole price, less the mending already counted for it.
  out.repairScrap += turrets.filter((b) => b.hp === 0).reduce((n, b) => n + investedOf(b.kind, b.lv ?? 1) * (1 - ZOM.repairShare), 0);
  return out;
}

/** The scrap a building stands for: its price and every step up. */
export const priceOf = (kind: TurretKind | 'depot' | 'post' | 'spikes', lv: number) => investedOf(kind, lv);
export const NIGHTS_LIFE = 3;
/**
 * Value a scrap: the horde's health a building takes off over `NIGHTS_LIFE` nights like this one, over its price plus that many nights' upkeep (ammo and mending).
 */
export const valuePerScrap = (harm: number, price: number, upkeep: number) => (NIGHTS_LIFE * harm) / (price + NIGHTS_LIFE * upkeep);
export { BUILDINGS };

/** The axes a buildable is judged on, each higher-is-better (see `buildMatrix`). */
export const AXES = [
  'vsWalker', 'vsRunner', 'vsPlated', 'vsBloater', 'vsBrute', 'vsMix', 'range', 'cheap', 'hpPerScrap', 'burstHpPerScrap', 'hpPerCell', 'mendSpeed', 'harmPerUpkeep', 'resupply', 'mending', 'slow',
] as const;
export type Axis = (typeof AXES)[number];
export type Group = 'turret' | 'wall' | 'utility';
export type MatrixRow = { name: string; group: Group; price: number; at: Record<Axis, number> };
const KIND_AXES: readonly [ZombieKind, Axis][] = [['walker', 'vsWalker'], ['runner', 'vsRunner'], ['plated', 'vsPlated'], ['bloater', 'vsBloater'], ['brute', 'vsBrute']];
const zeroAxes = () => Object.fromEntries(AXES.map((a) => [a, 0])) as Record<Axis, number>;

/**
 * Every buildable at its first level (each wall tier as its own) on every axis that matters, higher better:
 * - `vs<Kind>` and `vsMix`: the horde health it takes off a scrap (`valuePerScrap`, `playFort` against packs of that kind at night `kindNight`, and the real mix of `nights`); spikes are used up, so theirs is one night's.
 * - `range`; `cheap` (one over its price); `hpPerScrap`, `burstHpPerScrap` and `hpPerCell`: its health against bites (a wall's armor counted) and against a bloater's burst (a wall's `blast`), a scrap and in its one cell;
 *   `mendSpeed`: how fast holding use mends it; `harmPerUpkeep`: the harm it does a scrap of ammo and mending.
 * - What a utility does that nothing else does: a depot's `resupply` (share of a load a second), a post's `mending` (health a second) and spikes' `slow`.
 */
export function buildMatrix({ seeds = [1], nights = [3, 5, 7], kindNight = 5, ms = 90_000 } = {}): MatrixRow[] {
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const rows: MatrixRow[] = [];
  for (const kind of ['sentry', 'scatter', 'cannon', 'mortar', 'tesla'] as const) {
    const def = turretDef(kind, 1), price = investedOf(kind, 1), at = zeroAxes();
    const runs = (s: Omit<FortSetup, 'night' | 'seed'>, ns: readonly number[]) => ns.flatMap((night) => seeds.map((seed) => playFort({ ...s, night, seed, ms })));
    const judge = (rs: FortRun[]) => {
      const harm = mean(rs.map((r) => r.harm)) * (90_000 / ms), upkeep = mean(rs.map((r) => r.rounds * def.scrapPerRound + r.repairScrap)) * (90_000 / ms);
      return { harm, upkeep, value: valuePerScrap(harm, price, upkeep) };
    };
    const mix = judge(runs({ turrets: [{ kind, lv: 1 }], tend: true }, nights));
    at.vsMix = mix.value;
    at.harmPerUpkeep = mix.harm / Math.max(1, mix.upkeep);
    for (const [z, axis] of KIND_AXES) at[axis] = judge(runs({ turrets: [{ kind, lv: 1 }], tend: true, kinds: [z] }, [kindNight])).value;
    at.range = def.range;
    at.cheap = 1 / price;
    at.hpPerScrap = at.burstHpPerScrap = maxHpOf(kind, 1) / price;
    at.hpPerCell = maxHpOf(kind, 1);
    at.mendSpeed = 1;
    rows.push({ name: BUILDINGS[kind].name, group: 'turret', price, at });
  }
  for (const [i, t] of WALL_TIERS.entries()) {
    const at = zeroAxes(), ehp = t.hp / (1 - t.armor);
    Object.assign(at, { cheap: 1 / t.cost, hpPerScrap: ehp / t.cost, burstHpPerScrap: t.hp / t.blast / t.cost, hpPerCell: ehp, mendSpeed: t.repairMul });
    rows.push({ name: t.name, group: 'wall', price: investedOf('wall', i + 1), at });
  }
  for (const kind of ['depot', 'post'] as const) {
    const price = BUILDINGS[kind].cost, hp = maxHpOf(kind, 1), at = zeroAxes();
    Object.assign(at, { cheap: 1 / price, hpPerScrap: hp / price, burstHpPerScrap: hp / price, hpPerCell: hp, mendSpeed: 1 });
    if (kind === 'depot') at.resupply = UTILITY.depot.ammoPerSec; else at.mending = UTILITY.post.buildingHp;
    rows.push({ name: BUILDINGS[kind].name, group: 'utility', price, at });
  }
  const strips = seeds.map((seed) => nights.map((night) => playFort({ night, seed, ms, spikes: true })));
  const laid = 2 * RING + 1, spikePrice = BUILDINGS.spikes.cost;
  const at = zeroAxes();
  at.vsMix = mean(strips.flat().map((r) => r.harm)) * (90_000 / ms) / (laid * spikePrice);
  at.harmPerUpkeep = at.vsMix;
  Object.assign(at, { cheap: 1 / spikePrice, hpPerScrap: maxHpOf('spikes', 1) / spikePrice, hpPerCell: maxHpOf('spikes', 1), slow: 1 - UTILITY.spikes.slow });
  rows.push({ name: BUILDINGS.spikes.name, group: 'utility', price: spikePrice, at });
  return rows;
}

/** `b` dominates `a` when it is at least as good on every axis and better on one. */
export const dominates = (b: MatrixRow, a: MatrixRow) => AXES.every((x) => b.at[x] >= a.at[x]) && AXES.some((x) => b.at[x] > a.at[x]);
/** Every pair where one buildable dominates another, as [the dominated, by]. */
export const dominatedPairs = (rows: readonly MatrixRow[]): [string, string][] =>
  rows.flatMap((a) => rows.filter((b) => b !== a && dominates(b, a)).map((b) => [a.name, b.name] as [string, string]));
/** The axes on which each buildable is the strict best of its group: where it is the buy. */
export function winsOf(rows: readonly MatrixRow[]): Map<string, Axis[]> {
  return new Map(rows.map((a) => {
    const peers = rows.filter((b) => b.group === a.group && b !== a);
    return [a.name, AXES.filter((x) => a.at[x] > 0 && peers.every((b) => a.at[x] > b.at[x]))];
  }));
}

export type UpgradeRoi = { kind: TurretKind; copy: number; steps: [number, number]; levels: [number, number, number] };
/**
 * Whether a turret's steps up pay: the value a scrap (`valuePerScrap`) of each step against the night's own mix (or packs of only `kinds`), set beside a second level-I copy built next to the first
 * (where space allows), all tended. `levels` is the value a scrap of the whole turret at each level.
 */
export function upgradeRoi(kind: TurretKind, { seeds = [1], nights = [5], ms = 90_000, kinds = undefined as readonly ZombieKind[] | undefined } = {}): UpgradeRoi {
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const play = (turrets: { kind: TurretKind; lv: number }[]) => {
    const rs = nights.flatMap((night) => seeds.map((seed) => playFort({ night, seed, ms, turrets, tend: true, kinds })));
    const per = turretDef(kind, turrets[0]!.lv).scrapPerRound;
    return { harm: mean(rs.map((r) => r.harm)) * (90_000 / ms), upkeep: mean(rs.map((r) => r.rounds * per + r.repairScrap)) * (90_000 / ms) };
  };
  const one = play([{ kind, lv: 1 }]), two = play([{ kind, lv: 1 }, { kind, lv: 1 }]), l2 = play([{ kind, lv: 2 }]), l3 = play([{ kind, lv: 3 }]);
  const step = (from: typeof one, to: typeof one, cost: number) => valuePerScrap(to.harm - from.harm, cost, to.upkeep - from.upkeep);
  return {
    kind, copy: step(one, two, investedOf(kind, 1)), steps: [step(one, l2, upgradeCost(kind, 1)!), step(l2, l3, upgradeCost(kind, 2)!)],
    levels: [valuePerScrap(one.harm, investedOf(kind, 1), one.upkeep), valuePerScrap(l2.harm, investedOf(kind, 2), l2.upkeep), valuePerScrap(l3.harm, investedOf(kind, 3), l3.upkeep)],
  };
}
