/// <reference types="node" />
// Usage: node scripts/handling-table.ts [--markdown]   (--markdown prints the README's shorter table)
// Every gun's build (weight, length, calibre) and the handling handling.ts works out from it: spread floor, walking sway, the bloom one
// round kicks on average, the curve's shape, the rounds it takes to the cap and the first round's kick (shape x kick), how fast a held
// trigger starts to grow it (first kick x rounds per second), its cap and how fast it decays, the standing share, the
// post-sprint settle, the cosmetic swing, and the walk and sprint speed of the load with no armor; then what each armor adds; then, for every
// gun, its spread over a held trigger (a semi-auto or burst gun clicked as fast as it cycles) at rounds 1, 3, 5, 10, 20 and 30, standing, on
// the move and (a bipod gun) set down, and the widest round of single taps four a second and of three-round bursts 450 ms apart against the
// first, through the sim's own trigger and spread (`--held` prints only that table).
import { parseArgs } from 'node:util';
import { ARMOR_IDS, ARMORS, GUNS, handlingOfGun, roundsPerSec, rulesOf, SPRINT, WORLD, type GunId } from '../src/shared/defs.ts';
import { CALIBRES, inertiaOf, loadOf, sprintShareOf, walkMulOf } from '../src/shared/handling.ts';
import { spreadFor } from '../src/shared/sim/stats.ts';
import { pullTrigger } from '../src/shared/sim/trigger.ts';
import { TREE_ORDER } from './lib/gunscore.ts';

const { values: args } = parseArgs({ options: { markdown: { type: 'boolean', default: false }, held: { type: 'boolean', default: false } } });
const deg = (rad: number) => ((rad * 180) / Math.PI).toFixed(2);
const head = ['gun', 'kg', 'cm', 'calibre', 'J', 'inertia', 'floor°', 'sway°', 'kick°', 'shape', 'to cap', 'first°', 'rps', 'growth°/s', 'cap°', 'decay°/s', 'still', 'settle ms', 'swing ms', 'load kg', 'walk px/s', 'sprint px/s'];
const rows = TREE_ORDER.map((id) => {
  const g = GUNS[id], h = handlingOfGun(g), c = CALIBRES[g.calibre], load = loadOf(g.kg, g.cm, 0), walk = WORLD.baseSpeed * walkMulOf(load);
  return [
    `${'  '.repeat(g.stage)}${g.name}`, g.kg.toFixed(1), String(g.cm), g.calibre, String(c.joules), inertiaOf(g.kg, g.cm).toFixed(2), deg(h.floor), deg(h.sway), deg(h.kick), h.shape.toFixed(2), h.rounds.toFixed(1), deg(h.firstKick),
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
const COMPACT = ['gun', 'kg', 'cm', 'calibre', 'floor°', 'sway°', 'kick°', 'shape', 'to cap', 'first°', 'growth°/s', 'cap°', 'decay°/s', 'settle ms', 'walk px/s', 'sprint px/s'];
const pick = (h: string[], r: string[][]) => { const ix = COMPACT.map((c) => h.indexOf(c)); return [ix.map((i) => h[i]!), r.map((row) => ix.map((i) => row[i]!))] as const; };

/** The rounds of a held trigger the held table reads. */
export const HELD_ROUNDS = [1, 3, 5, 10, 20, 30] as const;
/**
 * The spread (radians) of each of a held trigger's first `rounds` rounds, `still` or on the move (and `deployed`, a bipod down), no perks and
 * nobody suppressing: the trigger held (a burst or semi-auto gun pressed again as soon as it can fire) through the sim's own trigger, so a
 * burst gun's recovery between bursts and a machine gun's rev-up count, on a magazine deep enough never to reload. With `tap`, it fires
 * `tap.rounds` at a time and rests `tap.gapMs` between them instead.
 */
export function heldSpreads(id: GunId, still: boolean, deployed = false, rounds = 30, tap?: { rounds: number; gapMs: number }): number[] {
  const g = GUNS[id], tickMs = 1000 / WORLD.tickHz;
  const s = { ammo: 1e6, reloadUntil: null as number | null, nextFireAt: 0, burstLeft: 0, pressUntil: -Infinity, spray: 0, firedAt: -Infinity, spin: 0 };
  const out: number[] = [];
  let inTap = 0, restUntil = -Infinity;
  for (let now = 0; out.length < rounds && now < 120_000; now += tickMs) {
    const firing = now >= restUntil;
    if (pullTrigger(s, { def: g, mag: 1e6, reloadMs: g.reloadMs, armed: true }, { fire: firing, reload: false, pressed: firing }, now, tickMs)) {
      out.push(spreadFor(id, {}, still, s.spray, 0, 0, deployed));
      if (tap && ++inTap >= tap.rounds) { inTap = 0; restUntil = now + tap.gapMs; }
    }
  }
  return out;
}
/** Every gun: a held trigger blooms an automatic, and a semi-auto or burst gun clicked as fast as it cycles. */
export const HELD_GUNS: readonly GunId[] = TREE_ORDER;
/** The taps the table reads: single rounds four a second, and three-round bursts with 450 ms between them, each as its widest round over round 1. */
const TAPS = [{ rounds: 1, gapMs: 250 }, { rounds: 3, gapMs: 450 }] as const;
const heldCell = (id: GunId, still: boolean, deployed = false) => { const s = heldSpreads(id, still, deployed); return HELD_ROUNDS.map((n) => deg(s[n - 1]!)).join(' / '); };
const tapCell = (id: GunId, still: boolean) => TAPS.map((tap) => { const s = heldSpreads(id, still, false, 12, tap); return `${(Math.max(...s) / s[0]!).toFixed(2)}`; }).join(' / ');
const heldHead = ['gun', 'rps', `still° (round ${HELD_ROUNDS.join('/')})`, 'x round 1 at 3/10/30', `moving° (round ${HELD_ROUNDS.join('/')})`, `bipod° (round ${HELD_ROUNDS.join('/')})`, 'taps x1 / x3 still', 'taps x1 / x3 moving'];
const heldRows = HELD_GUNS.map((id) => {
  const g = GUNS[id], s = heldSpreads(id, true);
  return [`${'  '.repeat(g.stage)}${g.name}`, roundsPerSec(g).toFixed(1), heldCell(id, true), `${(s[2]! / s[0]!).toFixed(2)} / ${(s[9]! / s[0]!).toFixed(2)} / ${(s[29]! / s[0]!).toFixed(2)}`, heldCell(id, false), rulesOf(g).deploy ? heldCell(id, true, true) : '-', tapCell(id, true), tapCell(id, false)];
});

if (args.held) print(heldHead, heldRows);
else {
  if (args.markdown) print(...pick(head, rows)); else print(head, rows);
  print(armorHead, armorRows);
  print(heldHead, heldRows);
}
