/// <reference types="node" />
// Usage: node scripts/bench-zombie-guns.ts [runs|drill|all] [seeds] [guns] [humans] [jobs]
//   seeds: comma-separated, default 1,2,3. guns: comma-separated gun ids, `classes` (the six class guns), or `all` (default, every gun).
//   humans: how many of the four seats are bot-brained humans held to the gun (default 2; the first builds on the squad bots' plan). jobs: worker processes, default 4.
// Does any gun earn its place in Zombies? Each gun is held by `humans` squad players for whole seeded runs with no perks (scripts/lib/zombieguns.ts `playGunRun`),
// the rest of the squad bots with random guns. Per gun it prints the mean night reached, the holders' kills, harm dealt and the scrap their kills paid, the core
// health lost, and a contribution score: the mean of night reached, holders' scrap and holders' kills, each over its mean across the guns benched (1.00 is average).
// It prints the `HORDE_DPS` table the Zombies scrap bounty reads (`zombieBounty` in defs.ts): each gun's harm over the seconds its holders stood at night, over every run.
// `drill` holds each gun south of the core against packs of one kind at a time (`gunDrill`) and prints harm a second against each kind, and leaks, by gun and by class.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as defs from '../src/shared/defs.ts';
import { GUN_IDS, GUNS, WEAPON_IDS, ZOMBIE_KINDS, type GunId, type ZombieKind } from '../src/shared/defs.ts';
import { gunDrill, playGunRun, type Drill, type GunRun } from './lib/zombieguns.ts';

/** Runs stop at the Tide's dawn, so a squad that holds every listed night reads as night 11 rather than playing the endless nights on. */
const TIDE = defs.NIGHTS.length;

type Job = { k: 'run'; seed: number; gun: GunId; humans: number } | { k: 'drill'; seed: number; gun: GunId; kind: ZombieKind };

if (process.argv[2] === '--worker') {
  process.on('message', (job: Job) => {
    const out = job.k === 'run' ? playGunRun(job.seed, job.gun, job.humans, TIDE) : gunDrill(job.gun, job.kind, { seed: job.seed });
    process.send!({ job, out });
  });
} else {
  const what = process.argv[2] ?? 'all';
  const seeds = (process.argv[3] ?? '1,2,3').split(',').map(Number);
  const gunArg = process.argv[4] ?? 'all';
  const guns: GunId[] = gunArg === 'all' ? [...GUN_IDS] : gunArg === 'classes' ? [...WEAPON_IDS] : gunArg.split(',') as GunId[];
  const humans = Number(process.argv[5] ?? 2);
  const jobsN = Number(process.argv[6] ?? 4);
  const drillKinds: ZombieKind[] = ['walker', 'runner', 'plated', 'bloater', 'brute'];
  const jobs: Job[] = [
    ...(what === 'drill' ? [] : guns.flatMap((gun) => seeds.map((seed) => ({ k: 'run' as const, seed, gun, humans })))),
    ...(what === 'runs' ? [] : guns.flatMap((gun) => drillKinds.flatMap((kind) => seeds.map((seed) => ({ k: 'drill' as const, seed, gun, kind }))))),
  ];
  const runs: GunRun[] = [], drills: Drill[] = [];
  const t0 = performance.now();
  await new Promise<void>((done) => {
    let next = 0, finished = 0;
    if (jobs.length === 0) { done(); return; }
    for (let i = 0; i < Math.min(jobsN, jobs.length); i++) {
      const child = fork(fileURLToPath(import.meta.url), ['--worker']);
      const feed = () => { if (next < jobs.length) child.send(jobs[next++]!); else child.kill(); };
      child.on('message', ({ job, out }: { job: Job; out: GunRun | Drill }) => {
        if (job.k === 'run') runs.push(out as GunRun); else drills.push(out as Drill);
        if (++finished % 10 === 0) process.stderr.write(`${finished}/${jobs.length} ${((performance.now() - t0) / 1000).toFixed(0)}s\n`);
        if (finished === jobs.length) done();
        feed();
      });
      feed();
    }
  });
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const f = (x: number, d = 0) => x.toFixed(d);
  /** The gun's scrap bounty in Zombies, where the build has one (read loosely, so the bench also runs on a build from before it). */
  const bounty = (g: GunId): number => (defs as { zombieBounty?: (g: GunId) => number }).zombieBounty?.(g) ?? 1;

  if (runs.length) {
    const rows = guns.map((gun) => {
      const rs = runs.filter((r) => r.gun === gun);
      const kinds = Object.fromEntries(ZOMBIE_KINDS.map((k) => [k, mean(rs.map((r) => r.byKind[k]))])) as Record<ZombieKind, number>;
      return {
        gun, night: mean(rs.map((r) => r.night)), wins: rs.filter((r) => r.won).length, nights: rs.map((r) => `${r.night}`).join(','),
        kills: mean(rs.map((r) => r.kills)), dealt: mean(rs.map((r) => r.dealt)), scrap: mean(rs.map((r) => r.scrap)),
        bank: mean(rs.map((r) => r.bank)), core: mean(rs.map((r) => r.coreLost)), minutes: mean(rs.map((r) => r.minutes)), kinds,
        dps: rs.reduce((n, r) => n + r.dealt, 0) / Math.max(1, rs.reduce((n, r) => n + r.nightSec, 0)), downs: mean(rs.map((r) => r.downs)),
      };
    });
    const mNight = mean(rows.map((r) => r.night)), mScrap = mean(rows.map((r) => r.scrap)), mKills = mean(rows.map((r) => r.kills));
    const scored = rows.map((r) => ({ ...r, score: (r.night / mNight + r.scrap / mScrap + r.kills / mKills) / 3 })).sort((a, b) => b.score - a.score);
    console.log(`\n${humans} of 4 seats held to each gun, seeds ${seeds.join(',')}: means per run (holders' kills, harm, scrap; per-minute rates over the run's length)`);
    console.log('gun            | class   | bounty | nights      | night | kills | dealt  | dps | downs | scrap | scrap/min | bank  | core lost | brute | plated | runner | score');
    for (const r of scored) {
      console.log(`${r.gun.padEnd(14)} | ${GUNS[r.gun].base.padEnd(7)} | ${`x${f(bounty(r.gun), 2)}`.padStart(6)} | ${r.nights.padEnd(11)} | ${f(r.night, 1).padStart(5)} | ${f(r.kills).padStart(5)} | ${f(r.dealt).padStart(6)} | ${f(r.dps).padStart(3)} | ${f(r.downs, 1).padStart(5)} | ${f(r.scrap).padStart(5)} | ${f(r.scrap / r.minutes, 1).padStart(9)} | ${f(r.bank).padStart(5)} | ${f(r.core).padStart(9)} | ${f(r.kinds.brute, 1).padStart(5)} | ${f(r.kinds.plated, 1).padStart(6)} | ${f(r.kinds.runner, 1).padStart(6)} | ${f(r.score, 2)}`);
    }
    const byClass = WEAPON_IDS.map((c) => { const cs = scored.filter((r) => GUNS[r.gun].base === c); return { c, score: mean(cs.map((r) => r.score)), night: mean(cs.map((r) => r.night)), scrap: mean(cs.map((r) => r.scrap)), kills: mean(cs.map((r) => r.kills)), bank: mean(cs.map((r) => r.bank)), core: mean(cs.map((r) => r.core)), perKill: mean(cs.map((r) => r.scrap / Math.max(1, r.kills))) }; })
      .filter((x) => !Number.isNaN(x.score) && x.score > 0).sort((a, b) => b.score - a.score);
    console.log('\nclass   | guns score | night | scrap | kills | scrap/kill | bank  | core lost');
    for (const c of byClass) console.log(`${c.c.padEnd(7)} | ${f(c.score, 2).padStart(10)} | ${f(c.night, 1).padStart(5)} | ${f(c.scrap).padStart(5)} | ${f(c.kills).padStart(5)} | ${f(c.perKill, 2).padStart(10)} | ${f(c.bank).padStart(5)} | ${f(c.core).padStart(9)}`);
    const best = (k: 'night' | 'scrap' | 'kills' | 'bank' | 'perKill') => [...byClass].sort((a, b) => b[k] - a[k])[0]!.c;
    console.log(`class with the most nights: ${best('night')}; the most scrap: ${best('scrap')}; the most kills: ${best('kills')}; the most scrap a kill: ${best('perKill')}; `
      + `the biggest squad bank: ${best('bank')}; the least core lost: ${[...byClass].sort((a, b) => a.core - b.core)[0]!.c}`);
    if (guns.length === GUN_IDS.length) {
      // The bounty's measure: each gun's harm a second to the horde while its holders stand at night, over every run.
      const sorted = rows.map((r) => r.dps).sort((a, b) => a - b);
      const median = (sorted[(sorted.length - 1) >> 1]! + sorted[sorted.length >> 1]!) / 2;
      console.log(`\nHORDE_DPS for defs.ts (median ${f(median)}, BOUNTY.ref):\n{ ${GUN_IDS.map((g) => `${g}: ${f(rows.find((r) => r.gun === g)!.dps)}`).join(', ')} }`);
      const drift = GUN_IDS.filter((g) => Math.abs(rows.find((r) => r.gun === g)!.dps / defs.HORDE_DPS[g] - 1) > 0.15);
      console.log(drift.length ? `drifted more than 15% from defs.ts HORDE_DPS: ${drift.join(', ')}` : 'every gun within 15% of defs.ts HORDE_DPS');
    }
    const top = scored[0]!, low = scored[scored.length - 1]!;
    console.log(`spread: best gun ${top.gun} ${f(top.score, 2)} / worst ${low.gun} ${f(low.score, 2)} = ${f(top.score / low.score, 2)}x; best class ${byClass[0]!.c} / worst ${byClass.at(-1)!.c} = ${f(byClass[0]!.score / byClass.at(-1)!.score, 2)}x`);
  }

  if (drills.length) {
    console.log(`\nDrill: harm a second against packs of each kind, night 4 health, 45 s, mean of seeds ${seeds.join(',')} (kills / leaked through in brackets)`);
    console.log(`gun            | bounty | ${drillKinds.map((k) => k.padStart(15)).join(' | ')} | mean dps`);
    const lines = guns.map((gun) => {
      const ds = drillKinds.map((kind) => {
        const of = drills.filter((d) => d.gun === gun && d.kind === kind);
        return { gun, kind, seconds: of[0]!.seconds, dealt: mean(of.map((d) => d.dealt)), kills: mean(of.map((d) => d.kills)), leaked: mean(of.map((d) => d.leaked)) };
      });
      return { gun, ds, dps: mean(ds.map((d) => d.dealt / d.seconds)) };
    }).sort((a, b) => b.dps - a.dps);
    for (const { gun, ds, dps } of lines) console.log(`${gun.padEnd(14)} | ${`x${f(bounty(gun), 2)}`.padStart(6)} | ${ds.map((d) => `${f(d.dealt / d.seconds).padStart(4)} (${f(d.kills)}/${f(d.leaked)})`.padStart(15)).join(' | ')} | ${f(dps)}`);
    const classes = WEAPON_IDS.map((c) => {
      const ls = lines.filter((l) => GUNS[l.gun].base === c);
      return { c, ls, kinds: drillKinds.map((_, i) => mean(ls.map((l) => l.ds[i]!.dealt / l.ds[i]!.seconds))), leaked: mean(ls.map((l) => l.ds.reduce((n, d) => n + d.leaked, 0))), dps: mean(ls.map((l) => l.dps)) };
    }).filter((c) => c.ls.length);
    console.log(`\nclass   | ${drillKinds.map((k) => k.padStart(7)).join(' | ')} | leaked | mean dps`);
    for (const c of classes) console.log(`${c.c.padEnd(7)} | ${c.kinds.map((k) => f(k).padStart(7)).join(' | ')} | ${f(c.leaked, 1).padStart(6)} | ${f(c.dps)}`);
    for (const [i, k] of drillKinds.entries()) console.log(`class best against ${k}: ${[...classes].sort((a, b) => b.kinds[i]! - a.kinds[i]!)[0]!.c}`);
    console.log(`class with the fewest leaked: ${[...classes].sort((a, b) => a.leaked - b.leaked)[0]!.c}`);
    for (const kind of drillKinds) {
      const leaks = (c: (typeof classes)[number]) => mean(c.ls.map((l) => l.ds[drillKinds.indexOf(kind)]!.leaked));
      console.log(`class letting the fewest ${kind}s through: ${[...classes].sort((a, b) => leaks(a) - leaks(b))[0]!.c} (${classes.map((c) => `${c.c} ${f(leaks(c), 1)}`).join(', ')})`);
    }
    for (const k of drillKinds) {
      const best = [...lines].sort((a, b) => b.ds[drillKinds.indexOf(k)]!.dealt - a.ds[drillKinds.indexOf(k)]!.dealt)[0]!;
      console.log(`best against ${k}: ${best.gun} (${GUNS[best.gun].base})`);
    }
  }
}
