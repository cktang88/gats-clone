/// <reference types="node" />
// Usage: node scripts/bench-dodge.ts [--seeds 12] [--ranges 500,750,1000] [--duels 24]
// How often a sniper's rounds land on bots that are facing it: (A) a scripted sniper (planted, never misses its lead, cannot die) against a bot of
// each class and temper, the bot unable to die either, so it is measured over the whole run; (B) a bolt-action bot against a bot of each class.
import { parseArgs } from 'node:util';
import { GUNS, WEAPON_IDS, WORLD, type GunId, type WeaponId } from '../src/shared/defs.ts';
import { MAPS } from '../src/shared/maps.ts';
import { addPlayer, setInput, step } from '../src/shared/sim.ts';
import { intercept, MUZZLE_PX } from '../src/shared/sim/ballistics.ts';
import { effectiveStats } from '../src/shared/sim/stats.ts';
import { createWorld, IDLE_INPUT, rand, type Player, type World } from '../src/shared/sim/world.ts';
import { rulesOf } from '../src/shared/defs.ts';
import { newBotMemory, type BotMemory } from '../src/server/bots.ts';
import { VETERAN } from '../src/server/bot/aim.ts';
import { PERSONALITY_IDS, type PersonalityId } from '../src/server/bot/intent.ts';
import { thinkBots } from '../src/server/bot/tick.ts';

const TICK_MS = 1000 / WORLD.tickHz;
const { values: args } = parseArgs({ options: { seeds: { type: 'string', default: '12' }, ranges: { type: 'string', default: '500,750,1000' }, duels: { type: 'string', default: '24' } } });
const seeds = Array.from({ length: Number(args.seeds) }, (_, i) => i + 1);
const ranges = args.ranges.split(',').map(Number);

function arena(seed: number): World {
  const w = createWorld('FFA', seed * 7919 + 13, 'plaza');
  w.walls = []; w.crates = []; w.barrels = []; w.props = []; w.airdrops = { due: [], flight: null };
  w.wallsVersion++;
  return w;
}

const join = (w: World, gun: GunId, x: number, y: number, kind: 'bot' | 'human' = 'bot'): Player => {
  const p = addPlayer(w, `${gun}${w.nextId}`, { weapon: GUNS[gun].base, armor: 'none', color: 'red' }, { at: { x, y }, kind });
  p.gun = gun;
  if (p.life.k === 'alive') Object.assign(p.life, { ammo: effectiveStats(p).mag, shieldUntil: -Infinity });
  return p;
};

/** Counts the shooter's rounds and its hits on the victim; `far` only those fired from `FAR_PX` or more (a rusher that has closed in is not dodging). */
const FAR_PX = 350;
type Acc = { shots: number; hits: number; farShots?: number; farHits?: number; pending?: boolean[] };
const tally = (w: World, shooter: number, victim: Player, acc: Acc) => {
  for (const e of w.events) {
    if (e.e === 'shot' && e.owner === shooter) {
      acc.shots++;
      const far = Math.hypot(e.x - victim.x, e.y - victim.y) >= FAR_PX;
      (acc.pending ??= []).push(far);
      if (far) acc.farShots = (acc.farShots ?? 0) + 1;
    } else if (e.e === 'dmg' && e.attacker === shooter && e.victim === victim.id && e.kind === 'player') {
      acc.hits++;
      if (acc.pending?.[0]) acc.farHits = (acc.farHits ?? 0) + 1;
    }
  }
  // A sniper round is in the air well under a bolt cycle, so the oldest round still pending is the one that landed or missed by now.
  while ((acc.pending?.length ?? 0) > 1) acc.pending!.shift();
};

/** A planted sniper that leads its target exactly from the target's real velocity and fires each time the bolt is back. */
function scripted(weapon: WeaponId, persona: PersonalityId, range: number, seed: number) {
  const w = arena(seed);
  const mid = MAPS.plaza.size / 2;
  const sniper = join(w, 'sniper', mid - range / 2, mid, 'human');
  const bot = join(w, weapon as GunId, mid + range / 2, mid);
  const mems = new Map<number, BotMemory>([[bot.id, { ...newBotMemory(() => rand(w), { skill: VETERAN }), persona }]]);
  const acc: Acc = { shots: 0, hits: 0 };
  let last = { x: bot.x, y: bot.y }, shots = 0;
  const g = GUNS.sniper;
  for (let t = 0; t < 20_000 / TICK_MS; t++) {
    thinkBots(w, mems, () => rand(w), { picks: false, respawn: false });
    // Neither can die: a hit is soaked this tick and the bot sees itself at full health again the next.
    for (const p of [sniper, bot]) if (p.life.k === 'alive') Object.assign(p.life, { hp: 1e6, lastDamageAt: w.now });
    const v = { x: bot.x, y: bot.y, vx: (bot.x - last.x) * WORLD.tickHz, vy: (bot.y - last.y) * WORLD.tickHz };
    last = { x: bot.x, y: bot.y };
    const at = intercept(sniper, v, g.bulletSpeed, rulesOf(g).muzzleBoost, MUZZLE_PX, 1);
    const ready = sniper.life.k === 'alive' && w.now >= sniper.life.nextFireAt && Math.hypot(bot.x - sniper.x, bot.y - sniper.y) < g.range * 0.95;
    if (ready) shots++;
    setInput(w, sniper.id, t + 1, { ...IDLE_INPUT, angle: Math.atan2(at.y - sniper.y, at.x - sniper.x), fire: ready, shots, aimDist: 600 });
    step(w, TICK_MS);
    for (const p of [sniper, bot]) if (p.life.k === 'alive') p.life.hp = effectiveStats(p).maxHp;
    tally(w, sniper.id, bot, acc);
  }
  return acc;
}

/** A bolt-action bot against a bot of `weapon`, to a kill or 20 s; returns the sniper's shots and hits and who won. */
function botDuel(weapon: WeaponId, range: number, seed: number, swap: boolean) {
  const w = arena(seed * 31 + range);
  const mid = MAPS.plaza.size / 2;
  const [sx, vx] = swap ? [mid + range / 2, mid - range / 2] : [mid - range / 2, mid + range / 2];
  const sniper = join(w, 'sniper', sx, mid), bot = join(w, weapon as GunId, vx, mid);
  const r = () => rand(w);
  const mems = new Map<number, BotMemory>([[sniper.id, { ...newBotMemory(r, { skill: VETERAN }), persona: PERSONALITY_IDS[seed % 3]! }], [bot.id, { ...newBotMemory(r, { skill: VETERAN }), persona: PERSONALITY_IDS[Math.floor(seed / 3) % 3]! }]]);
  const acc = { shots: 0, hits: 0 };
  while (w.now < 20_000) {
    thinkBots(w, mems, r, { picks: false, respawn: false, watched: true });
    step(w, TICK_MS);
    tally(w, sniper.id, bot, acc);
    if (sniper.life.k !== 'alive' || bot.life.k !== 'alive') break;
  }
  const win = sniper.life.k === 'alive' && bot.life.k !== 'alive' ? 1 : sniper.life.k !== 'alive' && bot.life.k === 'alive' ? 0 : 0.5;
  return { ...acc, win };
}

const pc = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : '-').padStart(6);

console.log(`A) scripted sniper (planted, exact lead, cannot die) vs a bot that cannot die, 20 s, seeds 1..${seeds.length}; sniper hit rate`);
console.log(`  ${'class'.padEnd(10)}${PERSONALITY_IDS.map((p) => p.padStart(12)).join('')}${ranges.map((d) => `@${d}`.padStart(7)).join('')}${'all'.padStart(7)}${`${FAR_PX}+`.padStart(9)}`);
const totalA = { shots: 0, hits: 0, farShots: 0, farHits: 0 };
for (const weapon of WEAPON_IDS) {
  const byP = PERSONALITY_IDS.map(() => ({ shots: 0, hits: 0 })), byR = ranges.map(() => ({ shots: 0, hits: 0 })), far = { shots: 0, hits: 0 };
  PERSONALITY_IDS.forEach((persona, pi) => ranges.forEach((range, ri) => seeds.forEach((seed) => {
    const a = scripted(weapon, persona, range, seed);
    for (const x of [byP[pi]!, byR[ri]!, totalA]) { x.shots += a.shots; x.hits += a.hits; }
    far.shots += a.farShots ?? 0; far.hits += a.farHits ?? 0;
    totalA.farShots += a.farShots ?? 0; totalA.farHits += a.farHits ?? 0;
  })));
  const all = byP.reduce((s, x) => ({ shots: s.shots + x.shots, hits: s.hits + x.hits }), { shots: 0, hits: 0 });
  console.log(`  ${weapon.padEnd(10)}${byP.map((x) => pc(x.hits, x.shots).padStart(12)).join('')}${byR.map((x) => pc(x.hits, x.shots).padStart(7)).join('')}${pc(all.hits, all.shots).padStart(7)}${pc(far.hits, far.shots).padStart(9)}`);
}
console.log(`  overall ${pc(totalA.hits, totalA.shots)} of ${totalA.shots} shots; from ${FAR_PX}px+ ${pc(totalA.farHits, totalA.farShots)} of ${totalA.farShots}`);

const duels = Array.from({ length: Number(args.duels) }, (_, i) => i + 1);
const duelRanges = [450, 750];
console.log(`\nB) bolt-action bot vs a bot of each class, open plaza, ranges ${duelRanges.join('/')}, ${duels.length} seeds x both sides: sniper hit rate, sniper win share`);
const totalB = { shots: 0, hits: 0 };
for (const weapon of WEAPON_IDS) {
  const acc = { shots: 0, hits: 0, win: 0, n: 0 };
  for (const range of duelRanges) for (const seed of duels) for (const swap of [false, true]) {
    const d = botDuel(weapon, range, seed, swap);
    acc.shots += d.shots; acc.hits += d.hits; acc.win += d.win; acc.n++;
  }
  totalB.shots += acc.shots; totalB.hits += acc.hits;
  console.log(`  vs ${weapon.padEnd(10)} hit ${pc(acc.hits, acc.shots)} (${acc.shots} shots)  sniper wins ${pc(acc.win, acc.n)}`);
}
console.log(`  overall hit ${pc(totalB.hits, totalB.shots)} of ${totalB.shots} shots`);
