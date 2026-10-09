import { WORLD } from '../../src/shared/defs.ts';
import { addPlayer, step } from '../../src/shared/sim.ts';
import { createWorld, rand } from '../../src/shared/sim/world.ts';
import { newBotMemory, randomLoadout, type BotMemory } from '../../src/server/bots.ts';
import { thinkBots } from '../../src/server/bot/tick.ts';

const TICK_MS = 1000 / WORLD.tickHz;
/** A squad room fills its four seats with bots. */
const SEATS = 4;

/**
 * `passive`: no human ever builds, upgrades, mends or reloads, and the squad bots keep the rule they follow with humans in the squad (they build nothing and mend the core only in an emergency).
 * `build`: the first human follows the squad bots' build plan with the shared bank, as a human who builds sensibly.
 */
export type CurveMode = 'passive' | 'build';
export type CurveRun = { night: number; won: boolean; cause: 'held' | 'core' | 'survivors' | 'capped'; built: number; minutes: number; trace: string };

/**
 * One seeded zombies run on the Outpost, `humans` of the four seats bot brains flagged human (a human's health and horde share), played to the core's fall,
 * the Tide's dawn or the dawn of night `untilNight`. `trace` is each night's core health lost, survivors, buildings standing and scrap at its dawn.
 */
export function playCurve(seed: number, humans: number, mode: CurveMode, untilNight = Infinity): CurveRun {
  const w = createWorld('ZOM', seed, 'outpost');
  const r = () => rand(w);
  const bots = new Map<number, BotMemory>();
  const roles = new Map<number, BotMemory['siegeBuild']>();
  for (let i = 0; i < SEATS; i++) {
    const human = i < humans;
    const p = addPlayer(w, `${human ? 'h' : 'bot'}${i}`, randomLoadout(r), { kind: human ? 'human' : 'bot' });
    bots.set(p.id, newBotMemory(r));
    if (human) roles.set(p.id, mode === 'build' && i === 0 ? 'always' : 'never');
  }
  let built = 0, night = 1, coreAt = w.run!.core.hp;
  const trace: string[] = [];
  const over = () => w.run!.phase.k === 'over';
  while (!over() && w.run!.night <= untilNight) {
    for (const [id, role] of roles) bots.set(id, { ...bots.get(id)!, siegeBuild: role });
    thinkBots(w, bots, r, { respawn: false });
    step(w, TICK_MS);
    built = Math.max(built, w.buildings.length + w.floor.length);
    const run = w.run!;
    if (run.night !== night || over()) {
      trace.push(`n${night} -${Math.round(coreAt - Math.max(0, run.core.hp))}hp ${run.survivors}s ${w.buildings.length + w.floor.length}b ${Math.floor(run.scrap)}$`);
      coreAt = run.core.hp;
      night = run.night;
    }
  }
  const run = w.run!;
  const end = run.phase.k === 'over' ? run.phase : null;
  return {
    night: end ? end.night : run.night, won: !!end?.won, cause: !end ? 'capped' : end.won ? 'held' : run.core.hp <= 0 ? 'core' : 'survivors',
    built, minutes: w.now / 60_000, trace: trace.join(' | '),
  };
}
