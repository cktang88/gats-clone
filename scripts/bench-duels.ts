/// <reference types="node" />
// Usage: node scripts/bench-duels.ts [--stage 0|1|2|all] [--seeds 18] [--seed-base 1] [--ranges 200,450,750] [--armor none] [--pairs] [--workers 8] [--trace]
import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { ARMOR_IDS, armorShare, GUNS, WORLD, type GunId } from '../src/shared/defs.ts';
import { duel, DUEL_CAP_MS, type DuelResult, type DuelSpec } from './lib/duel.ts';
import { median } from './lib/stats.ts';
import { gunsOfStage, TREE_ORDER } from './lib/gunscore.ts';

if (!isMainThread) {
  parentPort!.postMessage((workerData as DuelSpec[]).map(duel));
} else {
  const { values: args } = parseArgs({ options: {
    stage: { type: 'string', default: 'all' }, seeds: { type: 'string', default: '18' }, 'seed-base': { type: 'string', default: '1' },
    ranges: { type: 'string', default: '200,450,750' }, armor: { type: 'string', default: 'none' }, pairs: { type: 'boolean', default: false },
    workers: { type: 'string', default: String(availableParallelism()) }, trace: { type: 'boolean', default: false },
  } });
  const stages = args.stage === 'all' ? ([0, 1, 2] as const) : [Number(args.stage) as 0 | 1 | 2];
  const armor = ARMOR_IDS.find((x) => x === args.armor);
  if (!armor || stages.some((s) => ![0, 1, 2].includes(s))) throw new Error('--stage takes 0, 1, 2 or all; --armor takes none, light, medium or heavy');
  const seeds = Array.from({ length: Number(args.seeds) }, (_, i) => Number(args['seed-base']) + i);
  const ranges = args.ranges.split(',').map(Number);

  const specsOf = (stage: 0 | 1 | 2): DuelSpec[] => {
    const ids = gunsOfStage(stage);
    return ids.flatMap((a, i) => ids.slice(i + 1).flatMap((b) =>
      ranges.flatMap((range) => seeds.flatMap((seed) => [false, true].map((swap) => ({ a, b, range, seed, swap, armor }))))));
  };

  const runAll = async (specs: DuelSpec[]): Promise<DuelResult[]> => {
    const n = Math.max(1, Math.min(Number(args.workers), specs.length));
    if (n === 1) return specs.map(duel);
    const chunks = Array.from({ length: n }, (_, i) => specs.filter((_, j) => j % n === i));
    const parts = await Promise.all(chunks.map((chunk) => new Promise<DuelResult[]>((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: chunk });
      worker.once('message', resolve);
      worker.once('error', reject);
    })));
    return parts.flat();
  };

  const pc = (x: number) => `${(x * 100).toFixed(0)}%`;
  const shareOf = (results: readonly DuelResult[], gun: GunId, keep: (r: DuelResult) => boolean = () => true) => {
    let sum = 0, n = 0;
    for (const r of results) {
      if (!keep(r) || (r.spec.a !== gun && r.spec.b !== gun)) continue;
      sum += r.spec.a === gun ? r.score : 1 - r.score;
      n++;
    }
    return n ? sum / n : NaN;
  };

  console.log(`bot duels: thinkBots on both sides, open plaza, ${armor} armor, ranges ${ranges.join('/')}, seeds ${seeds[0]}..${seeds.at(-1)} x both sides, cap ${DUEL_CAP_MS / 1000}s counts half`);
  for (const stage of stages) {
    const started = performance.now();
    const results = await runAll(specsOf(stage));
    const wallS = (performance.now() - started) / 1000;
    const ids = gunsOfStage(stage);
    const overall = new Map(ids.map((id) => [id, shareOf(results, id)]));
    const engaged = results.map((r) => r.engagedMs).filter(Number.isFinite);
    console.log(`\nstage ${stage}: ${results.length} duels in ${wallS.toFixed(1)}s; median fight ${(median(results.map((r) => r.ms)) / 1000).toFixed(1)}s, ` +
      `first shot median ${(median(engaged) / 1000).toFixed(2)}s, never fired ${results.length - engaged.length}, capped ${results.filter((r) => r.capped).length}`);
    console.log(`  ${'gun'.padEnd(16)}${'overall'.padStart(8)}${ranges.map((d) => `@${d}`.padStart(7)).join('')}  flag`);
    for (const id of [...ids].sort((x, y) => overall.get(y)! - overall.get(x)!)) {
      const share = overall.get(id)!;
      const cells = ranges.map((d) => pc(shareOf(results, id, (r) => r.spec.range === d)).padStart(7)).join('');
      console.log(`  ${GUNS[id].name.padEnd(16)}${pc(share).padStart(8)}${cells}  ${share < 0.35 ? 'LOW' : share > 0.65 ? 'HIGH' : ''}`);
    }
    if (args.pairs) {
      console.log(`\n  pair matrix: row gun's win share against column gun, pooled over ranges and seeds`);
      console.log(`  ${''.padEnd(16)}${ids.map((id) => GUNS[id].name.slice(0, 6).padStart(7)).join('')}`);
      for (const row of ids) {
        const cells = ids.map((col) => (row === col ? '-' : pc(shareOf(results, row, (r) => r.spec.a === col || r.spec.b === col))).padStart(7)).join('');
        console.log(`  ${GUNS[row].name.padEnd(16)}${cells}`);
      }
    }
    if (args.trace) for (const r of results.filter((x) => x.capped || !Number.isFinite(x.engagedMs))) console.log(`  stalled: ${JSON.stringify(r)}`);
  }

  const kill = (perHit: number) => Math.ceil(WORLD.baseHp / perHit - 1e-9);
  console.log(`\nbreakpoints: hits to kill a still ${WORLD.baseHp} HP bot (a blast round counts its blast on a direct hit; pellet guns count pellets, pellets per pull in brackets)`);
  console.log(`  ${'gun'.padEnd(16)}${ARMOR_IDS.map((x) => x.padStart(8)).join('')}`);
  for (const id of TREE_ORDER) {
    const g = GUNS[id];
    const cells = ARMOR_IDS.map((x) => String(kill((g.damage + (g.blast?.damage ?? 0)) * (1 - armorShare(x)))).padStart(8)).join('');
    console.log(`  ${`${'  '.repeat(g.stage)}${g.name}`.padEnd(16)}${cells}${g.pellets > 1 ? `  [${g.pellets}]` : ''}`);
  }
}
