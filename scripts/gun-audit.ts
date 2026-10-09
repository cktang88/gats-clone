/// <reference types="node" />
// Usage: node scripts/gun-audit.ts [--moving] [--roles]
// Every gun's numbers, the damage it does per second and the time it takes to kill a full-health bot in each armor at 150/400/700/1000 px
// (expected damage through spread, bloom, damage fade and reloads; "-" is out of range or no kill within 8 s). `--moving` judges it on the move;
// `--roles` also prints each gun's one-line role and the traits the evolve pick shows.
import { parseArgs } from 'node:util';
import { ARMOR_IDS, GUNS, rulesOf, type GunId } from '../src/shared/defs.ts';
import { GUN_ROLES } from '../src/shared/roles.ts';
import { DPS_RANGES, dpsAt, ttkMs, TREE_ORDER } from './lib/gunscore.ts';

const { values: args } = parseArgs({ options: { moving: { type: 'boolean', default: false }, roles: { type: 'boolean', default: false } } });
const still = !args.moving;
const num = (n: number, w: number, digits = 0) => n.toFixed(digits).padStart(w);
const cell = (ms: number | null, w = 6) => (ms === null ? '-' : (ms / 1000).toFixed(2)).padStart(w);

const traits = (id: GunId): string => {
  const g = GUNS[id], r = rulesOf(g);
  return [
    g.burst && `burst${g.burst.count}`, g.auto ? 'auto' : 'semi', g.pellets > 1 && `x${g.pellets}`, g.penetrate && `pierce${g.penetrate}`, g.blast && `blast${g.blast.radius}`, g.silenced && 'quiet',
    r.falloff && `fade${r.falloff.startPx}-${r.falloff.endPx}`, r.deploy && `deploy${r.deploy.ms}`, r.spinUp && `spin${r.spinUp.upMs}`, r.bloom && `bloom${r.bloom.maxMul}`,
    r.settle !== null && `settle${r.settle.mul}x${r.settle.ms}`, r.shoveMul !== 1 && `shove${r.shoveMul}`, r.breach && 'breach', `${g.kg}kg/${g.cm}cm/${g.calibre}`,
    r.movingSpreadAdd ? `sway${r.movingSpreadAdd.toFixed(3)}` : '', r.steadyMs ? `steady${r.steadyMs}` : '', r.viewMul !== 1 ? `view${r.viewMul}` : '', r.suppress ? `sup${r.suppress}` : '',
  ].filter(Boolean).join(' ');
};

console.log(`${still ? 'planted/still' : 'moving'}; DPS at ${DPS_RANGES.join('/')}px, then seconds-to-kill per armor (${ARMOR_IDS.join('/')}) at each range`);
console.log(`${'gun'.padEnd(18)} dmg*pel  ms/rd mag  rel  rng  spd  move | ${DPS_RANGES.map((d) => `dps${d}`.padStart(7)).join('')} | ${DPS_RANGES.map((d) => `@${d} ${ARMOR_IDS.join('/')}`).join(' | ')}`);
for (const id of TREE_ORDER) {
  const g = GUNS[id];
  const msPer = g.burst ? ((g.burst.count - 1) * g.burst.gapMs + g.fireMs) / g.burst.count : g.fireMs;
  const dps = DPS_RANGES.map((d) => num(dpsAt(id, d, still), 7)).join('');
  const ttks = DPS_RANGES.map((d) => ARMOR_IDS.map((a) => cell(ttkMs(id, d, a, still), 5)).join('')).join(' |');
  console.log(`${`${'  '.repeat(g.stage)}${g.name}`.padEnd(18)} ${`${g.damage}*${g.pellets}`.padStart(7)} ${num(msPer, 6)} ${num(g.mag, 3)} ${num(g.reloadMs, 5)} ${num(g.range, 4)} ${num(g.bulletSpeed, 4)} ${num(g.moveMul, 5, 2)} |${dps} |${ttks}`);
  console.log(`${''.padEnd(18)} ${traits(id)}${args.roles ? `   [${GUN_ROLES[id].role}] ${GUN_ROLES[id].traits.join(', ')}` : ''}`);
}
