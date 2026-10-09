/// <reference types="node" />
// Usage: [TRACE=1] node scripts/bench-zombie-curve.ts [seeds] [humans] [modes]
//   seeds: comma-separated, default 1,2,3. humans: comma-separated squad sizes in humans, 1 to 4, default 1,2,3,4 (bots fill the other seats, as in a room).
//   modes: comma-separated of `passive` and `build`, default both (see scripts/lib/zombiecurve.ts). TRACE prints each night of each run.
// The difficulty curve of a zombies run, played to the core's fall or the Tide's dawn, each human a bot brain flagged human:
//   passive: nobody human builds or spends; build: the first human follows the squad bots' build plan.
// Prints each run (night reached, how it ended, what stood) and then a table of the night reached per squad size and mode.
import { playCurve, type CurveMode, type CurveRun } from './lib/zombiecurve.ts';

const seeds = (process.argv[2] ?? '1,2,3').split(',').map(Number);
const sizes = (process.argv[3] ?? '1,2,3,4').split(',').map(Number);
const modes = (process.argv[4] ?? 'passive,build').split(',') as CurveMode[];

const table = new Map<string, CurveRun[]>();
for (const humans of sizes) {
  for (const mode of modes) {
    for (const seed of seeds) {
      const t0 = performance.now();
      const res = playCurve(seed, humans, mode);
      console.log(`${humans}h ${mode.padEnd(7)} seed ${seed}: ${res.won ? 'WON' : `fell (${res.cause})`} on night ${res.night}, peak ${res.built} buildings, ${res.minutes.toFixed(1)} game min, ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      if (process.env.TRACE) console.log(`  ${res.trace}`);
      table.set(`${humans} ${mode}`, [...(table.get(`${humans} ${mode}`) ?? []), res]);
    }
  }
}
console.log('\nhumans | mode    | night reached per seed | mean');
for (const [key, rs] of table) {
  const [h, mode] = key.split(' ');
  console.log(`${h}      | ${mode!.padEnd(7)} | ${rs.map((x) => `${x.night}${x.won ? 'W' : ''}`).join(', ').padEnd(22)} | ${(rs.reduce((n, x) => n + x.night, 0) / rs.length).toFixed(1)}`);
}
