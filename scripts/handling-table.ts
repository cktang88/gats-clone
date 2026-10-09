/// <reference types="node" />
// Usage: node scripts/handling-table.ts [--markdown]   (--markdown prints the README's shorter table)
// Every gun's build (weight, length, calibre) and the handling handling.ts works out from it: spread floor, walking sway, the bloom one
// round kicks, how fast a held trigger grows it (kick x rounds per second), its cap and how fast it decays, the standing share, the
// post-sprint settle, the cosmetic swing, and the walk and sprint speed of the load with no armor; then what each armor adds.
import { parseArgs } from 'node:util';
import { ARMOR_IDS, ARMORS, GUNS, handlingOfGun, roundsPerSec, SPRINT, WORLD } from '../src/shared/defs.ts';
import { CALIBRES, inertiaOf, loadOf, sprintShareOf, walkMulOf } from '../src/shared/handling.ts';
import { TREE_ORDER } from './lib/gunscore.ts';

const { values: args } = parseArgs({ options: { markdown: { type: 'boolean', default: false } } });
const deg = (rad: number) => ((rad * 180) / Math.PI).toFixed(2);
const head = ['gun', 'kg', 'cm', 'calibre', 'J', 'inertia', 'floor°', 'sway°', 'kick°', 'rps', 'growth°/s', 'cap°', 'decay°/s', 'still', 'settle ms', 'swing ms', 'load kg', 'walk px/s', 'sprint px/s'];
const rows = TREE_ORDER.map((id) => {
  const g = GUNS[id], h = handlingOfGun(g), c = CALIBRES[g.calibre], load = loadOf(g.kg, g.cm, 0), walk = WORLD.baseSpeed * walkMulOf(load);
  return [
    `${'  '.repeat(g.stage)}${g.name}`, g.kg.toFixed(1), String(g.cm), g.calibre, String(c.joules), inertiaOf(g.kg, g.cm).toFixed(2), deg(h.floor), deg(h.sway), deg(h.kick),
    roundsPerSec(g).toFixed(1), deg(h.growthPerSec), deg(h.cap), deg(h.decayPerSec), h.still.toFixed(2), String(h.settleMs), String(h.swingMs),
    load.toFixed(1), walk.toFixed(0), (walk * (1 + (SPRINT.speedMul - 1) * sprintShareOf(load))).toFixed(0),
  ];
});
const armorHead = ['armor', 'kg', 'walk cost (share of base)'];
const armorRows = ARMOR_IDS.map((a) => [ARMORS[a].name, String(ARMORS[a].kg), `${(walkMulOf(0) - walkMulOf(ARMORS[a].kg)).toFixed(3)}`]);

function print(h: string[], r: string[][]) {
  if (args.markdown) {
    console.log(`| ${h.join(' | ')} |`);
    console.log(`|${h.map(() => ' --- ').join('|')}|`);
    for (const row of r) console.log(`| ${row.map((x) => x.trim()).join(' | ')} |`);
  } else {
    const w = h.map((x, i) => Math.max(x.length, ...r.map((row) => row[i]!.length)));
    console.log(h.map((x, i) => (i === 0 ? x.padEnd(w[i]!) : x.padStart(w[i]!))).join('  '));
    for (const row of r) console.log(row.map((x, i) => (i === 0 ? x.padEnd(w[i]!) : x.padStart(w[i]!))).join('  '));
  }
  console.log('');
}
/** The README's table: the build and the handling a player feels. */
const COMPACT = ['gun', 'kg', 'cm', 'calibre', 'floor°', 'sway°', 'kick°', 'growth°/s', 'cap°', 'decay°/s', 'settle ms', 'walk px/s', 'sprint px/s'];
const pick = (h: string[], r: string[][]) => { const ix = COMPACT.map((c) => h.indexOf(c)); return [ix.map((i) => h[i]!), r.map((row) => ix.map((i) => row[i]!))] as const; };
if (args.markdown) print(...pick(head, rows)); else print(head, rows);
print(armorHead, armorRows);
