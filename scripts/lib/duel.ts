/** One bot duel on an open plaza: the engine of `scripts/bench-duels.ts`, shared with the balance smoke test. */
import { GUNS, WORLD, type ArmorId, type GunId } from '../../src/shared/defs.ts';
import { MAPS } from '../../src/shared/maps.ts';
import { addPlayer, step } from '../../src/shared/sim.ts';
import { effectiveStats } from '../../src/shared/sim/stats.ts';
import { createWorld, rand } from '../../src/shared/sim/world.ts';
import { newBotMemory, type BotMemory } from '../../src/server/bots.ts';
import { VETERAN } from '../../src/server/bot/aim.ts';
import { PERSONALITY_IDS } from '../../src/server/bot/intent.ts';
import { thinkBots } from '../../src/server/bot/tick.ts';

export const TICK_MS = 1000 / WORLD.tickHz;
export const DUEL_CAP_MS = 20_000;

export type DuelSpec = { a: GunId; b: GunId; range: number; seed: number; swap: boolean; armor: ArmorId };
export type DuelResult = { spec: DuelSpec; score: number; ms: number; capped: boolean; engagedMs: number };

const hash = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return h >>> 0; };
const personasOf = (seed: number) => [PERSONALITY_IDS[seed % 3]!, PERSONALITY_IDS[Math.floor(seed / 3) % 3]!] as const;

export function duel(spec: DuelSpec): DuelResult {
  const w = createWorld('FFA', hash(`${spec.seed}:${spec.a}:${spec.b}:${spec.range}:${spec.armor}`), 'plaza');
  w.walls = [];
  w.crates = [];
  w.wallsVersion++;
  const r = () => rand(w);
  const mid = MAPS.plaza.size / 2;
  const mems = new Map<number, BotMemory>();
  const personas = personasOf(spec.seed);
  const join = (gun: GunId, x: number) => {
    const p = addPlayer(w, gun, { weapon: GUNS[gun].base, armor: spec.armor, color: 'red' }, { at: { x, y: mid } });
    p.gun = gun;
    if (p.life.k === 'alive') Object.assign(p.life, { ammo: effectiveStats(p).mag, shieldUntil: -Infinity });
    mems.set(p.id, { ...newBotMemory(r, { skill: VETERAN }), persona: personas[mems.size]! });
    return p;
  };
  const [left, right] = spec.swap ? [spec.b, spec.a] : [spec.a, spec.b];
  const l = join(left, mid - spec.range / 2), rt = join(right, mid + spec.range / 2);
  const [a, b] = spec.swap ? [rt, l] : [l, rt];
  let engagedMs = Infinity;
  while (w.now < DUEL_CAP_MS) {
    thinkBots(w, mems, r, { picks: false, respawn: false, watched: true });
    step(w, TICK_MS);
    if (engagedMs === Infinity && w.events.some((e) => e.e === 'shot')) engagedMs = w.now;
    const aDead = a.life.k !== 'alive', bDead = b.life.k !== 'alive';
    if (aDead || bDead) return { spec, score: aDead && bDead ? 0.5 : bDead ? 1 : 0, ms: w.now, capped: false, engagedMs };
  }
  return { spec, score: 0.5, ms: w.now, capped: true, engagedMs };
}

