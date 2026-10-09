/// <reference types="node" />
// Usage: node scripts/handling-table.ts [--markdown]   (--markdown prints the README's shorter table)
// Every gun's build (weight, length, calibre) and the handling handling.ts works out from it: spread floor, walking sway, the bloom one
// round kicks, how fast a held trigger grows it (kick x rounds per second), its cap and how fast it decays, the standing share, the
// post-sprint settle, the cosmetic swing, and the walk and sprint speed of the load with no armor; then what each armor adds; then, for every
// gun that fires more than one round a press or a hold (automatics and bursts), its spread over a held trigger at rounds 1, 5, 10, 20 and 30,
// standing, on the move and (a bipod gun) set down, through the sim's own trigger and spread (`--held` prints only that table).
import { parseArgs } from 'node:util';
import { ARMOR_IDS, ARMORS, GUNS, handlingOfGun, roundsPerSec, rulesOf, SPRINT, WORLD, type GunId } from '../src/shared/defs.ts';
import { CALIBRES, inertiaOf, loadOf, sprintShareOf, walkMulOf } from '../src/shared/handling.ts';
import { spreadFor } from '../src/shared/sim/stats.ts';
import { pullTrigger } from '../src/shared/sim/trigger.ts';
import { TREE_ORDER } from './lib/gunscore.ts';

const { values: args } = parseArgs({ options: { markdown: { type: 'boolean', default: false }, held: { type: 'boolean', default: false } } });
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

/** The rounds of a held trigger the held table reads. */
export const HELD_ROUNDS = [1, 5, 10, 20, 30] as const;
/**
 * The spread (radians) of each of a held trigger's first `rounds` rounds, `still` or on the move (and `deployed`, a bipod down), no perks and
 * nobody suppressing: the trigger held (a burst gun pressed again as soon as it can fire) through the sim's own trigger, so a burst gun's
 * recovery between bursts and a machine gun's rev-up count, on a magazine deep enough never to reload.
 */
export function heldSpreads(id: GunId, still: boolean, deployed = false, rounds = 30): number[] {
  const g = GUNS[id], tickMs = 1000 / WORLD.tickHz;
  const s = { ammo: 1e6, reloadUntil: null as number | null, nextFireAt: 0, burstLeft: 0, pressUntil: -Infinity, spray: 0, firedAt: -Infinity, spin: 0 };
  const out: number[] = [];
  for (let now = 0; out.length < rounds && now < 60_000; now += tickMs) {
    if (pullTrigger(s, { def: g, mag: 1e6, reloadMs: g.reloadMs, armed: true }, { fire: true, reload: false, pressed: true }, now, tickMs)) out.push(spreadFor(id, {}, still, s.spray, 0, 0, deployed));
  }
  return out;
}
/** Guns that put more than one round out a press or a hold: the ones a held trigger blooms. */
export const HELD_GUNS: readonly GunId[] = TREE_ORDER.filter((id) => GUNS[id].auto || GUNS[id].burst !== undefined);
const heldCell = (id: GunId, still: boolean, deployed = false) => { const s = heldSpreads(id, still, deployed); return HELD_ROUNDS.map((n) => deg(s[n - 1]!)).join(' / '); };
const heldHead = ['gun', 'rps', `still° (round ${HELD_ROUNDS.join('/')})`, 'x round 1 at 10/30', `moving° (round ${HELD_ROUNDS.join('/')})`, `bipod° (round ${HELD_ROUNDS.join('/')})`];
const heldRows = HELD_GUNS.map((id) => {
  const g = GUNS[id], s = heldSpreads(id, true);
  return [`${'  '.repeat(g.stage)}${g.name}`, roundsPerSec(g).toFixed(1), heldCell(id, true), `${(s[9]! / s[0]!).toFixed(1)} / ${(s[29]! / s[0]!).toFixed(1)}`, heldCell(id, false), rulesOf(g).deploy ? heldCell(id, true, true) : '-'];
});

if (args.held) print(heldHead, heldRows);
else {
  if (args.markdown) print(...pick(head, rows)); else print(head, rows);
  print(armorHead, armorRows);
  print(heldHead, heldRows);
}
