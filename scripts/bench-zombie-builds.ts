/// <reference types="node" />
// Usage: node scripts/bench-zombie-builds.ts [seeds] [quick]
//   seeds: comma-separated, default 1,2. quick: turrets at level I only, no walls or utilities.
// What does a scrap buy in Zombies? Every buildable at every level in a scripted lane (scripts/lib/zombiebuilds.ts `playFort`): the core walled in, the
// buildable just inside the south face, packs of the real horde streaming in from the south for 90 s at nights 3, 5 and 7 (and packs of one kind at a time
// at night 5). A turret's value a scrap is the horde health it takes off over three such nights over its price plus three nights' ammo and mending; a level's
// step is set beside building another level-I copy. Walls are bitten with nothing shooting; spikes, the depot and the post are measured by what they add.
import { BUILDINGS, TURRET_KINDS, UTILITY, WALL_TIERS, ZOM, type TurretKind, type ZombieKind } from '../src/shared/defs.ts';
import { investedOf, turretDef, upgradeCost } from '../src/shared/sim/build.ts';
import { NIGHTS_LIFE, playFort, valuePerScrap, type FortRun, type FortSetup } from './lib/zombiebuilds.ts';

const seeds = (process.argv[2] ?? '1,2').split(',').map(Number);
const NIGHTS = [3, 5, 7];
const quick = process.argv[3] === 'quick';
const LEVELS = quick ? 1 : 3;
const KINDS: ZombieKind[] = ['walker', 'runner', 'plated', 'bloater', 'brute'];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const f = (x: number, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const many = (s: Omit<FortSetup, 'seed' | 'night'>, nights = NIGHTS) => nights.flatMap((night) => seeds.map((seed) => playFort({ ...s, night, seed })));
/** A night's upkeep for a tended turret: every round it fired refilled at full price, and its wear mended. */
const upkeepOf = (r: FortRun, kind: TurretKind, lv: number) => r.rounds * turretDef(kind, lv).scrapPerRound + r.repairScrap;

console.log(`Turrets against the night's own mix, nights ${NIGHTS.join(',')}, seeds ${seeds.join(',')}, 90 s, tended (value a scrap over ${NIGHTS_LIFE} nights)`);
console.log('turret    | lv | price | harm/s | kills | ammo+mend/night | income/night | value/scrap | step value/scrap | 2nd copy');
const vps = new Map<string, number>();
const perKind = new Map<string, number[]>();
for (const kind of TURRET_KINDS) {
  let prev: { harm: number; upkeep: number } | null = null;
  // Where space allows, the alternative to a step up is a second level-I copy beside the first: what it adds, a scrap.
  const pair = many({ turrets: [{ kind, lv: 1 }, { kind, lv: 1 }], tend: true });
  let copy = NaN;
  for (let lv = 1; lv <= LEVELS; lv++) {
    const rs = many({ turrets: [{ kind, lv }], tend: true });
    const harm = mean(rs.map((r) => r.harm)), upkeep = mean(rs.map((r) => upkeepOf(r, kind, lv))), price = investedOf(kind, lv);
    const v = valuePerScrap(harm, price, upkeep);
    vps.set(`${kind}${lv}`, v);
    const step = prev ? valuePerScrap(harm - prev.harm, upgradeCost(kind, lv - 1)!, upkeep - prev.upkeep) : NaN;
    if (lv === 1) copy = valuePerScrap(mean(pair.map((r) => r.harm)) - harm, price, mean(pair.map((r) => upkeepOf(r, kind, 1))) - upkeep);
    console.log(`${kind.padEnd(9)} | ${lv}  | ${f(price).padStart(5)} | ${f(harm / 90).padStart(6)} | ${f(mean(rs.map((r) => r.kills))).padStart(5)} | ${f(upkeep).padStart(15)} | ${f(mean(rs.map((r) => r.income))).padStart(12)} | ${f(v, 1).padStart(11)} | ${f(step, 1).padStart(16)} | ${f(copy, 1).padStart(8)}`);
    prev = { harm, upkeep };
    perKind.set(`${kind}${lv}`, KINDS.map((z) => {
      const ks = many({ turrets: [{ kind, lv }], tend: true, kinds: [z] }, [5]);
      return valuePerScrap(mean(ks.map((r) => r.harm)), price, mean(ks.map((r) => upkeepOf(r, kind, lv))));
    }));
  }
}
console.log(`\nValue a scrap against packs of one kind, night 5`);
console.log(`turret    | lv | ${KINDS.map((k) => k.padStart(7)).join(' | ')} | range`);
for (const kind of TURRET_KINDS) for (let lv = 1; lv <= LEVELS; lv++) console.log(`${kind.padEnd(9)} | ${lv}  | ${perKind.get(`${kind}${lv}`)!.map((v) => f(v, 1).padStart(7)).join(' | ')} | ${turretDef(kind, lv).range}`);
for (const [i, z] of KINDS.entries()) {
  const best = TURRET_KINDS.map((k) => [k, perKind.get(`${k}1`)![i]!] as const).sort((a, b) => b[1] - a[1]);
  console.log(`best level-I buy against ${z}: ${best.map(([k, v]) => `${k} ${f(v, 1)}`).join(', ')}`);
}

if (quick) process.exit(0);
console.log(`\nWalls: the south face at one tier, nothing shooting, nights ${NIGHTS.join(',')}, 90 s`);
console.log('tier          | price | hp    | bite taken | first breach s | bitten/scrap of face | mending scrap per 1000 bitten');
for (let t = 1; t <= WALL_TIERS.length; t++) {
  const rs = many({ southTier: t, alive: 30 });
  const bitten = mean(rs.map((r) => r.wallBitten)), mend = mean(rs.map((r) => r.wallRepairScrap));
  const breach = mean(rs.map((r) => r.breachSec ?? 90));
  const tier = WALL_TIERS[t - 1]!;
  console.log(`${tier.name.padEnd(13)} | ${f(tier.cost).padStart(5)} | ${f(tier.hp).padStart(5)} | ${`${f(tier.armor * 100)}%`.padStart(10)} | ${f(breach, 1).padStart(14)} | ${f(tier.hp / (1 - tier.armor) / tier.cost, 1).padStart(20)} | ${f((mend / Math.max(1, bitten)) * 1000, 2).padStart(29)}`);
}

console.log(`\nUtilities, nights ${NIGHTS.join(',')}`);
const sp = many({ spikes: true });
const strips = 2 * 4 + 1;
console.log(`spike strips (a row of ${strips}, ${strips * BUILDINGS.spikes.cost} scrap): harm ${f(mean(sp.map((r) => r.harm)))} in 90 s, ${f(mean(sp.map((r) => r.harm)) / (strips * BUILDINGS.spikes.cost), 1)} a scrap (strips are used up)`);
const fed = [{ kind: 'sentry' as const, lv: 1 }, { kind: 'sentry' as const, lv: 1 }, { kind: 'sentry' as const, lv: 1 }, { kind: 'cannon' as const, lv: 1 }];
const dry = many({ turrets: fed, tend: false });
for (let lv = 1; lv <= 3; lv++) {
  const dep = many({ turrets: fed, tend: false, depot: lv });
  const gain = mean(dep.map((r) => r.harm)) - mean(dry.map((r) => r.harm)), price = investedOf('depot', lv), upkeep = mean(dep.map((r) => r.ammoScrap));
  console.log(`depot ${lv}: three unattended sentries and a cannon take off ${f(gain)} more in 90 s (ammo ${f(upkeep)} scrap at ${UTILITY.depot.scrapShare * 100}%), value a scrap ${f(valuePerScrap(gain, price, upkeep), 1)}`);
}
for (let lv = 1; lv <= 3; lv++) {
  const ps = many({ turrets: [{ kind: 'sentry', lv: 1 }], tend: true, southTier: 1, post: lv });
  const saved = mean(ps.map((r) => r.mendedScrap)), price = investedOf('post', lv);
  console.log(`post ${lv}: mends ${f(mean(ps.map((r) => r.mended)))} hp of barricades and turret in 90 s, ${f(saved, 1)} scrap of mending; pays back its ${price} in ${f(price / saved, 1)} nights`);
}
void ZOM;
