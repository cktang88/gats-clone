/// <reference types="node" />
// Usage: node scripts/bench-royale.ts [--seeds 8] [--seed-base 1] [--maps oldtown,quarry,plaza,causeway] [--no-proxy] [--workers N]
import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { GUNS, RING, ROYALE, WORLD } from '../src/shared/defs.ts';
import { ROTATION, type MapId } from '../src/shared/maps.ts';
import type { GameEvent } from '../src/shared/protocol.ts';
import { addPlayer, step } from '../src/shared/sim.ts';
import { closedPhases, placeOf, stillIn } from '../src/shared/sim/royale.ts';
import { createWorld, rand, type World } from '../src/shared/sim/world.ts';
import { newBotMemory, randomLoadout, type BotMemory } from '../src/server/bots.ts';
import { thinkBots } from '../src/server/bot/tick.ts';
import { median } from './lib/stats.ts';

const TICK_MS = 1000 / WORLD.tickHz;
const CAP_MS = 15 * 60_000;
const PHASES = RING.length + 1;
const CONTEST_PX = 500;
const SAMPLE_TICKS = 15;

type Spec = { map: MapId; seed: number; proxy: boolean };
type Result = {
  spec: Spec; won: boolean; ms: number; ringDeaths: number; playerDeaths: number; ringOuts: number; outs: number;
  takedownsByPhase: number[]; phaseMs: number[];
  aliveByMinute: number[]; lastFightPhase: number; survivorStages: number[];
  drops: number; contested: number; caches: number; opened: number; openedByMinute: number[]; towersTaken: number;
  thinkMs: number; ticks: number; proxy: number | null; proxyPlace: number | null; winner: number | null;
};

const hash = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return h >>> 0; };

function play(spec: Spec): Result {
  const w: World = createWorld('BR', hash(`${spec.map}:${spec.seed}`), spec.map);
  const r = () => rand(w);
  const mems = new Map<number, BotMemory>();
  const proxySeat = spec.proxy ? spec.seed % ROYALE.players : -1;
  let proxy: number | null = null;
  for (let i = 0; i < ROYALE.players; i++) {
    const kind = i === proxySeat ? 'human' : 'bot';
    const p = addPlayer(w, `bot${i}`, randomLoadout(r), { kind });
    if (kind === 'human') proxy = p.id;
    mems.set(p.id, newBotMemory(r));
  }
  const res: Result = {
    spec, won: false, ms: 0, ringDeaths: 0, playerDeaths: 0, ringOuts: 0, outs: 0, takedownsByPhase: Array(PHASES).fill(0), phaseMs: Array(PHASES).fill(0),
    aliveByMinute: [], lastFightPhase: -1, survivorStages: [], drops: 0, contested: 0, caches: w.royale!.caches.length, opened: 0, openedByMinute: [], towersTaken: 0,
    thinkMs: 0, ticks: 0, proxy, proxyPlace: null, winner: null,
  };
  const dropSeen = new Map<number, boolean>();
  const lastCause = new Map<number, 'ring' | 'player'>();
  const ringBlow = (e: GameEvent) => (e.e === 'kill' && e.weapon === 'Ring') || (e.e === 'life' && e.k === 'finished' && e.by === null);
  while (w.match.k === 'playing' && w.now < CAP_MS) {
    const t0 = performance.now();
    thinkBots(w, mems, r);
    res.thinkMs += performance.now() - t0;
    const before = new Map([...w.players.values()].map((p) => [p.id, p.life.k]));
    step(w, TICK_MS);
    res.ticks++;
    const royale = w.royale!;
    const phase = closedPhases(royale.ring);
    res.phaseMs[phase] += TICK_MS;
    for (const e of w.events) {
      if (e.e === 'kill' || (e.e === 'life' && e.k === 'finished')) {
        const victim = e.e === 'kill' ? e.victimId : e.id;
        lastCause.set(victim, ringBlow(e) ? 'ring' : 'player');
      }
      if (e.e === 'kill' && e.weapon !== 'Ring') { res.takedownsByPhase[phase]++; res.lastFightPhase = phase; }
      if (e.e === 'wiped') {
        res.outs++;
        if (lastCause.get(e.id) === 'ring') res.ringOuts++;
      }
      if (e.e === 'tower') res.towersTaken++;
    }
    for (const p of w.players.values()) {
      if (p.life.k !== 'dead' || before.get(p.id) === 'dead') continue;
      if (lastCause.get(p.id) === 'ring') res.ringDeaths++;
      else res.playerDeaths++;
    }
    if (w.tick % Math.round(60_000 / TICK_MS) === 0) {
      res.aliveByMinute.push(stillIn(royale).length);
      res.openedByMinute.push(royale.caches.filter((c) => c.open).length);
    }
    if (w.tick % SAMPLE_TICKS === 0) {
      for (const c of w.crates) {
        if (!c.drop) continue;
        if (!dropSeen.has(c.id)) dropSeen.set(c.id, false);
        if (c.respawnAt !== null || dropSeen.get(c.id)) continue;
        const near = [...w.players.values()].filter((p) => p.life.k === 'alive' && Math.hypot(p.x - c.x, p.y - c.y) < CONTEST_PX);
        if (near.length >= 2) dropSeen.set(c.id, true);
      }
    }
  }
  res.ms = w.now;
  res.drops = dropSeen.size;
  res.contested = [...dropSeen.values()].filter(Boolean).length;
  res.opened = w.royale!.caches.filter((c) => c.open).length;
  if (proxy !== null) res.proxyPlace = placeOf(w, w.royale!, proxy);
  if (w.match.k === 'over') {
    res.won = true;
    const royale = w.royale!;
    res.winner = stillIn(royale)[0] ?? royale.out.at(-1) ?? null;
    res.survivorStages = [...w.players.values()].filter((p) => p.life.k === 'alive').map((p) => GUNS[p.gun].stage);
  }
  return res;
}

if (!isMainThread) {
  parentPort!.postMessage((workerData as Spec[]).map(play));
} else {
  const { values: args } = parseArgs({ options: {
    seeds: { type: 'string', default: '8' }, 'seed-base': { type: 'string', default: '1' }, maps: { type: 'string', default: ROTATION.BR.join(',') },
    'no-proxy': { type: 'boolean', default: false }, workers: { type: 'string', default: String(availableParallelism()) },
  } });
  const maps = args.maps.split(',') as MapId[];
  const seeds = Array.from({ length: Number(args.seeds) }, (_, i) => Number(args['seed-base']) + i);
  const specs = maps.flatMap((map) => seeds.map((seed) => ({ map, seed, proxy: !args['no-proxy'] })));
  const n = Math.max(1, Math.min(Number(args.workers), specs.length));
  const started = performance.now();
  const results = (await Promise.all(Array.from({ length: n }, (_, i) => specs.filter((_, j) => j % n === i)).map((chunk) => new Promise<Result[]>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: chunk });
    worker.once('message', resolve);
    worker.once('error', reject);
  })))).flat();

  const pc = (x: number) => `${(x * 100).toFixed(0)}%`;
  const min = (ms: number) => (ms / 60_000).toFixed(2);
  const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
  const summarize = (label: string, rs: readonly Result[]) => {
    const won = rs.filter((x) => x.won);
    const deaths = sum(rs.map((x) => x.ringDeaths + x.playerDeaths));
    const lastTwo = won.filter((x) => x.lastFightPhase >= RING.length - 2).length;
    const proxied = rs.filter((x) => x.proxy !== null);
    const stages = rs.flatMap((x) => x.survivorStages);
    console.log(`${label.padEnd(10)} matches ${rs.length}  winner ${won.length}/${rs.length}  median ${min(median(rs.map((x) => x.ms)))} min (${min(Math.min(...rs.map((x) => x.ms)))}..${min(Math.max(...rs.map((x) => x.ms)))})` +
      `  ring deaths ${pc(sum(rs.map((x) => x.ringDeaths)) / Math.max(1, deaths))} of ${deaths}  ring outs ${sum(rs.map((x) => x.ringOuts))}/${sum(rs.map((x) => x.outs))}` +
      `  last fight in last two phases ${lastTwo}/${won.length}  drops contested ${sum(rs.map((x) => x.contested))}/${sum(rs.map((x) => x.drops))}` +
      `  think ${(sum(rs.map((x) => x.thinkMs)) / sum(rs.map((x) => x.ticks))).toFixed(2)} ms/tick` +
      (proxied.length ? `  proxy wins ${proxied.filter((x) => x.winner === x.proxy).length}/${proxied.length} (${pc(proxied.filter((x) => x.winner === x.proxy).length / proxied.length)})` +
        `  proxy median place ${median(proxied.map((x) => x.proxyPlace ?? 0))}` : ''));
    const perMin = Array.from({ length: PHASES }, (_, i) => sum(rs.map((x) => x.takedownsByPhase[i]!)) / Math.max(1e-9, sum(rs.map((x) => x.phaseMs[i]!)) / 60_000));
    console.log(`${''.padEnd(10)} fights/min by phase ${perMin.map((f, i) => `${i < RING.length ? i + 1 : 'shut'}:${f.toFixed(1)}`).join(' ')}` +
      `  last fight phase ${won.map((x) => x.lastFightPhase + 1).join('')}` +
      `  survivor gun stage ${[0, 1, 2].map((s) => `${s}:${stages.filter((x) => x === s).length}`).join(' ')}`);
    const minutes = Math.max(...rs.map((x) => x.aliveByMinute.length));
    const byMinute = (f: (x: Result) => readonly number[]) => Array.from({ length: minutes }, (_, m) => (sum(rs.map((x) => f(x)[m] ?? f(x).at(-1) ?? 0)) / rs.length).toFixed(1)).join(' ');
    console.log(`${''.padEnd(10)} players in by minute ${byMinute((x) => x.aliveByMinute)}  caches opened by minute ${byMinute((x) => x.openedByMinute)}` +
      ` (of ${(sum(rs.map((x) => x.caches)) / rs.length).toFixed(0)}; ${(sum(rs.map((x) => x.opened)) / rs.length).toFixed(1)} by the end)  towers taken ${(sum(rs.map((x) => x.towersTaken)) / rs.length).toFixed(1)}/match`);
  };
  console.log(`bench-royale: ${specs.length} bot matches (${seeds.length} seeds x ${maps.join('/')}), ${args['no-proxy'] ? 'no proxy' : 'one proxy "human" seat run by a bot'}, cap ${CAP_MS / 60_000} min, ${((performance.now() - started) / 1000).toFixed(0)}s`);
  for (const map of maps) summarize(map, results.filter((x) => x.spec.map === map));
  summarize('all', results);
}
