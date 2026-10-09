/// <reference types="node" />
// Usage: node scripts/bench-freeze.ts [--mode TDM] [--maps rotation] [--seeds 2] [--seconds 180] [--workers 8] [--verbose]
// Bots frozen with a threat about (see scripts/lib/freeze.ts), every bot thinking at the pace of one on a human's screen: per map, the
// seconds per bot-minute they stood still facing more than 45 degrees off every threat they knew of (and off the corner each would come
// round) for over a second, the share of the time with a threat known that they faced one (within 30 degrees), the longest freeze,
// peek-and-hide spells over 8 s without a round fired, kills a minute and the bot brain's ms a tick; and how bots fight: peeks a minute,
// the share of fight time spent outnumbered (1vN), deaths while outnumbered, fights lost and life length.
import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { MODE_IDS, type ModeId } from '../src/shared/defs.ts';
import { ROTATION, type MapId } from '../src/shared/maps.ts';
import { freezeScan, type FreezeResult } from './lib/freeze.ts';

type Job = { mode: ModeId; map: MapId; seed: number; seconds: number };

if (!isMainThread) {
  parentPort!.postMessage((workerData as Job[]).map((j) => ({ ...j, res: freezeScan(j.mode, j.map, j.seed, j.seconds) })));
} else {
  const { values: args } = parseArgs({ options: {
    mode: { type: 'string', default: 'TDM' }, maps: { type: 'string', default: 'rotation' }, seeds: { type: 'string', default: '2' },
    seconds: { type: 'string', default: '180' }, workers: { type: 'string', default: String(availableParallelism()) }, verbose: { type: 'boolean', default: false },
  } });
  const mode = MODE_IDS.find((m) => m === args.mode);
  if (!mode) throw new Error('--mode takes FFA, TDM or DOM');
  const maps = (args.maps === 'rotation' ? ROTATION[mode] : args.maps.split(',')) as MapId[];
  const jobs: Job[] = maps.flatMap((map) => Array.from({ length: Number(args.seeds) }, (_, i) => ({ mode, map, seed: i + 1, seconds: Number(args.seconds) })));
  const n = Math.max(1, Math.min(Number(args.workers), jobs.length));
  const parts = Array.from({ length: n }, (_, i) => jobs.filter((_, j) => j % n === i));
  const done = (await Promise.all(parts.map((part) => new Promise<(Job & { res: FreezeResult })[]>((ok, fail) => {
    const wk = new Worker(new URL(import.meta.url), { workerData: part });
    wk.once('message', ok);
    wk.once('error', fail);
  })))).flat();
  const sum = (xs: FreezeResult[]): FreezeResult => xs.reduce((a, r) => ({
    botMs: a.botMs + r.botMs, threatMs: a.threatMs + r.threatMs, facingMs: a.facingMs + r.facingMs, frozenMs: a.frozenMs + r.frozenMs,
    freezes: [...a.freezes, ...r.freezes], kills: a.kills + r.kills, thinkMs: a.thinkMs + r.thinkMs, ticks: a.ticks + r.ticks, loops: a.loops + r.loops,
    pokes: a.pokes + r.pokes, fightMs: a.fightMs + r.fightMs, outnumberedMs: a.outnumberedMs + r.outnumberedMs, deaths: a.deaths + r.deaths,
    outnumberedDeaths: a.outnumberedDeaths + r.outnumberedDeaths, engages: a.engages + r.engages, engagesLost: a.engagesLost + r.engagesLost,
  }));
  const row = (name: string, r: FreezeResult, minutes: number) => {
    const longest = r.freezes.reduce((m, f) => Math.max(m, f.ms), 0);
    console.log(`${name.padEnd(10)} frozen ${(r.frozenMs / 1000 / (r.botMs / 60000)).toFixed(2).padStart(5)} s/bot-min  (${String(r.freezes.length).padStart(3)} spells, longest ${(longest / 1000).toFixed(1).padStart(4)} s)  facing ${(100 * r.facingMs / Math.max(1, r.threatMs)).toFixed(1).padStart(5)}%  threat known ${(100 * r.threatMs / Math.max(1, r.botMs)).toFixed(0).padStart(3)}%  peek loops ${String(r.loops).padStart(3)}  kills/min ${(r.kills / minutes).toFixed(1).padStart(5)}  think ${(r.thinkMs / r.ticks).toFixed(3)} ms/tick`);
    console.log(`${''.padEnd(10)} pokes ${(r.pokes / (r.botMs / 60000)).toFixed(2)}/bot-min  1vN ${(100 * r.outnumberedMs / Math.max(1, r.fightMs)).toFixed(1)}% of fight time  deaths outnumbered ${(100 * r.outnumberedDeaths / Math.max(1, r.deaths)).toFixed(0)}%  fights lost ${(100 * r.engagesLost / Math.max(1, r.engages)).toFixed(0)}% of ${r.engages}  life ${(r.botMs / 1000 / Math.max(1, r.deaths)).toFixed(1)} s`);
  };
  console.log(`${mode}, seeds 1..${args.seeds}, ${args.seconds} s each`);
  for (const map of maps) {
    const rs = done.filter((d) => d.map === map);
    row(map, sum(rs.map((d) => d.res)), rs.reduce((m, d) => m + d.seconds / 60, 0));
  }
  const all = sum(done.map((d) => d.res));
  row('all', all, done.reduce((m, d) => m + d.seconds / 60, 0));
  const kinds = new Map<string, { n: number; ms: number }>();
  for (const f of all.freezes) { const k = kinds.get(f.intent) ?? { n: 0, ms: 0 }; k.n++; k.ms += f.ms; kinds.set(f.intent, k); }
  console.log(`freezes by intent: ${[...kinds].sort((a, b) => b[1].ms - a[1].ms).map(([k, v]) => `${k} ${v.n} (${(v.ms / 1000).toFixed(0)} s)`).join(', ')}`);
  if (args.verbose) {
    for (const d of done) for (const f of [...d.res.freezes].sort((a, b) => b.ms - a.ms).slice(0, 4)) {
      console.log(`  ${d.map} seed ${d.seed} bot ${f.id} at ${(f.startMs / 1000).toFixed(1)} s for ${(f.ms / 1000).toFixed(1)} s, ${f.intent} at (${f.x}, ${f.y})`);
    }
  }
}
