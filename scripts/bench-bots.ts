/// <reference types="node" />
// Usage: node scripts/bench-bots.ts [minutes=10] [seeds=10] [abilityMinutes=3] [--skill mixed|rookie|regular|veteran|all] [--variant idle|strafe|...] [--aim-range seconds] [--duels seconds]
// minutes=0 or abilityMinutes=0 skips that section. `--skill` sets every bot's skill tier (a value drawn inside its band) for the human's
// rooms; `mixed` (the default) draws each bot's as a room does, and `all` runs the four in turn. The ability arenas are always mixed.
import { EVOLUTIONS, GUNS, LEVELS, PERK_TIERS, pickOptions, WORLD, type AbilityId, type GunId } from '../src/shared/defs.ts';
import { MAPS } from '../src/shared/maps.ts';
import type { InputState, Loadout, PlayerView, Snapshot, WallView } from '../src/shared/protocol.ts';
import { addPlayer, canRespawn, respawn, setInput, step } from '../src/shared/sim.ts';
import { segmentEntersRectAt } from '../src/shared/sim/movement.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { choosePick, effectiveStats, levelForScore, pendingPick } from '../src/shared/sim/stats.ts';
import { createWorld, IDLE_INPUT, rand, type Player, type World } from '../src/shared/sim/world.ts';
import { newBotMemory, randomLoadout, type BotMemory } from '../src/server/bots.ts';
import { BOT_SKILL, skillOf, type SkillTier } from '../src/server/bot/aim.ts';
import { arenaFor } from '../src/server/bot/arena.ts';
import { thinkBots } from '../src/server/bot/tick.ts';
import { flightSec } from '../src/shared/sim/ballistics.ts';
import { median } from './lib/stats.ts';

const skillAt = process.argv.indexOf('--skill');
const skillArg = skillAt >= 0 ? process.argv[skillAt + 1] ?? 'mixed' : 'mixed';
const variantAt = process.argv.indexOf('--variant');
const variantArg = variantAt >= 0 ? process.argv[variantAt + 1] : null;
const FLAGS = ['--skill', '--variant', '--aim-range', '--duels'];
const args = process.argv.slice(2).filter((_, i, all) => !FLAGS.includes(all[i]!) && !FLAGS.includes(all[i - 1]!));
const minutes = Number(args[0] ?? 10);
const seeds = Number(args[1] ?? 10);
const abilityMinutes = Number(args[2] ?? 3);
type RoomSkill = SkillTier | 'mixed';
const ROOM_SKILLS: readonly RoomSkill[] = skillArg === 'all' ? ['mixed', 'rookie', 'regular', 'veteran'] : [skillArg as RoomSkill];
/** A bot's memory for a room of `skill`: mixed draws its skill as a room does; a tier draws a value inside that tier's band (one draw either way). */
export function botMemoryFor(skill: RoomSkill, r: () => number): BotMemory {
  if (skill === 'mixed') return newBotMemory(r);
  const { bands } = BOT_SKILL;
  const [lo, hi] = skill === 'rookie' ? [0, bands.rookie] : skill === 'regular' ? [bands.rookie, bands.regular] : [bands.regular, 1];
  return newBotMemory(r, { skill: skillOf(lo + r() * (hi - lo) * 0.999999) });
}
const TICK_MS = 1000 / WORLD.tickHz;
const HUMAN_LOADOUT: Loadout = { weapon: 'assault', armor: 'medium', color: 'blue' };
const HUMAN_REACTION_MS = [220, 380] as const;
const HUMAN_AIM_SIGMA = 0.04;
const HUMAN_AIM_SIGMA_PER_RAD_PER_SEC = 0.15;
const HUMAN_AIM_CORRELATION = 0.9;
const HUMAN_LEAD = 0.5;
const HUMAN_VIEW_ASPECT = 1280 / 800;

type HumanStyle = 'idle' | 'strafe';
type HumanMind = { target: number | null; fireAtTick: number; aimErr: number; strafe: 1 | -1; flipAtTick: number; seen: { id: number; x: number; y: number } | null; shots: number; wanderX: number; wanderY: number };

const gaussian = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

function visibleEnemies(snap: Snapshot, me: PlayerView, walls: readonly WallView[]): PlayerView[] {
  return snap.players.filter((p) => p.id !== me.id && p.alive && !p.hidden
    && !walls.some((w) => segmentEntersRectAt(me.x, me.y, p.x - me.x, p.y - me.y, w) !== null));
}

function humanThink(snap: Snapshot, walls: readonly WallView[], mind: HumanMind, style: HumanStyle, r: () => number): { input: InputState; mind: HumanMind } {
  const me = snap.players.find((p) => p.id === snap.self.id);
  if (!me || !me.alive || style === 'idle') return { input: { ...IDLE_INPUT, shots: mind.shots }, mind };
  const next = { ...mind };
  const enemy = visibleEnemies(snap, me, walls).sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0] ?? null;
  if (snap.tick >= next.flipAtTick) {
    next.strafe = next.strafe === 1 ? -1 : 1;
    next.flipAtTick = snap.tick + Math.round((300 + r() * 600) / TICK_MS);
  }
  if (Math.hypot(me.x - next.wanderX, me.y - next.wanderY) < 80) { next.wanderX = r() * MAPS.plaza.size; next.wanderY = r() * MAPS.plaza.size; }
  let angle = Math.atan2(next.wanderY - me.y, next.wanderX - me.x);
  let moveAngle = angle;
  let fire = false, aimDist = 300;
  if (enemy) {
    if (enemy.id !== next.target) {
      next.target = enemy.id;
      next.fireAtTick = snap.tick + Math.round((HUMAN_REACTION_MS[0] + r() * (HUMAN_REACTION_MS[1] - HUMAN_REACTION_MS[0])) / TICK_MS);
    }
    const d = Math.hypot(enemy.x - me.x, enemy.y - me.y);
    const vel = next.seen?.id === enemy.id ? { x: enemy.x - next.seen.x, y: enemy.y - next.seen.y } : { x: 0, y: 0 };
    const flightTicks = flightSec(GUNS[me.gun].bulletSpeed, d) * WORLD.tickHz * HUMAN_LEAD;
    const bearing = Math.atan2(enemy.y - me.y, enemy.x - me.x);
    const angularSpeed = next.seen?.id === enemy.id ? Math.abs(Math.atan2(Math.sin(bearing - Math.atan2(next.seen.y - me.y, next.seen.x - me.x)), Math.cos(bearing - Math.atan2(next.seen.y - me.y, next.seen.x - me.x)))) * WORLD.tickHz : 0;
    const sigma = HUMAN_AIM_SIGMA + HUMAN_AIM_SIGMA_PER_RAD_PER_SEC * angularSpeed;
    next.aimErr = next.aimErr * HUMAN_AIM_CORRELATION + Math.sqrt(1 - HUMAN_AIM_CORRELATION ** 2) * sigma * gaussian(r);
    angle = Math.atan2(enemy.y + vel.y * flightTicks - me.y, enemy.x + vel.x * flightTicks - me.x) + next.aimErr;
    aimDist = d;
    fire = snap.tick >= next.fireAtTick && d < GUNS[me.gun].range * 0.95;
    moveAngle = Math.atan2(enemy.y - me.y, enemy.x - me.x) + (Math.PI / 2) * next.strafe;
  } else {
    next.target = null;
  }
  next.seen = enemy ? { id: enemy.id, x: enemy.x, y: enemy.y } : null;
  if (fire) next.shots++;
  const mx = Math.cos(moveAngle), my = Math.sin(moveAngle);
  return {
    input: { up: my < -0.38, down: my > 0.38, left: mx < -0.38, right: mx > 0.38, angle, fire, shots: next.shots, reload: !enemy && snap.self.ammo < snap.self.mag / 2, ability: false, aimDist, use: false },
    mind: next,
  };
}

type Tally = { lives: number[]; levels: number[]; botLevels: number[]; kills: number; deaths: number; botOnBotKills: number; botsKilledByHuman: number; damageTaken: number; botRounds: number; botHits: number; roundsAtHuman: number; hitsOnHuman: number };
const emptyTally = (): Tally => ({ lives: [], levels: [], botLevels: [], kills: 0, deaths: 0, botOnBotKills: 0, botsKilledByHuman: 0, damageTaken: 0, botRounds: 0, botHits: 0, roundsAtHuman: 0, hitsOnHuman: 0 });

/** A stage-2 gun of the human's class, standing in for a human who has reached the hunted stage. */
const HUNTED_GUN: GunId = EVOLUTIONS[EVOLUTIONS[HUMAN_LOADOUT.weapon][0]!][0]!;

function arm(p: Player, gun: GunId | null) {
  if (!gun) return;
  p.gun = gun;
  if (p.life.k === 'alive') p.life.ammo = effectiveStats(p).mag;
}

export function simulate(seed: number, style: HumanStyle, forcedGun: GunId | null, skill: RoomSkill = 'mixed', simMinutes = minutes): Tally {
  const w: World = createWorld('FFA', seed, 'plaza');
  const r = () => rand(w);
  const bots = new Map<number, BotMemory>();
  for (let i = 0; i < WORLD.minPlayers - 1; i++) bots.set(addPlayer(w, `bot${i}`, randomLoadout(r)).id, botMemoryFor(skill, r));
  const human = addPlayer(w, 'human', HUMAN_LOADOUT, { kind: 'human' });
  arm(human, forcedGun);
  let mind: HumanMind = { target: null, fireAtTick: 0, aimErr: 0, strafe: 1, flipAtTick: 0, seen: null, shots: 0, wanderX: r() * MAPS[w.map].size, wanderY: r() * MAPS[w.map].size };
  let bornAt = w.now;
  const tally = emptyTally();
  const ticks = Math.round((simMinutes * 60_000) / TICK_MS);
  for (let t = 0; t < ticks; t++) {
    thinkBots(w, bots, r);
    const snap = snapshotFor(w, human.id, w.events, HUMAN_VIEW_ASPECT);
    const h = humanThink(snap, arenaFor(w).walls, mind, style, r);
    mind = h.mind;
    setInput(w, human.id, w.tick, h.input);
    const pending = pendingPick(human);
    if (pending) choosePick(w, human.id, pending.level, pickOptions(pending, human.gun)[0]!);
    if (canRespawn(w, human.id) && respawn(w, human.id, HUMAN_LOADOUT)) { bornAt = w.now; arm(human, forcedGun); }
    step(w, TICK_MS);
    for (const e of w.events) {
      if (e.e === 'dmg' && e.kind === 'player' && e.victim === human.id && e.attacker !== human.id) tally.damageTaken += e.amount;
      // Bots' rounds fired and rounds that hit someone (a shotgun's pellets each count as a hit), for their share of rounds landed.
      if (e.e === 'shot' && bots.has(e.owner)) tally.botRounds++;
      if (e.e === 'dmg' && e.kind === 'player' && e.attacker !== null && e.attacker !== e.victim && bots.has(e.attacker)) tally.botHits++;
      // Rounds a bot sent the human's way (within 12 degrees of him, inside its gun's reach) and the hits he took from bots: its miss rate on him.
      if (e.e === 'shot' && bots.has(e.owner) && human.life.k === 'alive') {
        const d = Math.hypot(human.x - e.x, human.y - e.y), off = Math.atan2(human.y - e.y, human.x - e.x) - e.angle;
        if (d <= GUNS[e.gun].range && Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) < (12 * Math.PI) / 180) tally.roundsAtHuman += GUNS[e.gun].pellets;
      }
      if (e.e === 'dmg' && e.kind === 'player' && e.victim === human.id && e.attacker !== null && bots.has(e.attacker)) tally.hitsOnHuman++;
      if (e.e !== 'kill') continue;
      if (e.victimId === human.id) tally.lives.push((w.now - bornAt) / 1000);
      else if (e.killerId === human.id) tally.botsKilledByHuman++;
      else if (e.killerId !== null && bots.has(e.killerId)) tally.botOnBotKills++;
    }
    for (const rec of w.lifeRecords.splice(0)) (rec.id === human.id ? tally.levels : tally.botLevels).push(levelForScore(rec.score));
  }
  tally.kills = human.kills;
  tally.deaths = human.deaths;
  return tally;
}

const reachLabel = (levels: number[]) => LEVELS.flatMap((l, level) => (l.pick
  ? [`${l.pick.k === 'perk' ? `t${l.pick.tier}` : 'evo'} ${((100 * levels.filter((x) => x >= level).length) / Math.max(1, levels.length)).toFixed(0)}%`]
  : [])).join(' ');

const VARIANTS: { label: string; style: HumanStyle; gun: GunId | null }[] = [
  { label: 'idle', style: 'idle', gun: null },
  { label: 'strafe', style: 'strafe', gun: null },
  { label: `strafe, always ${GUNS[HUNTED_GUN].name}`, style: 'strafe', gun: HUNTED_GUN },
];

const isMain = import.meta.url === `file://${process.argv[1]}`;
for (const skill of isMain && minutes > 0 ? ROOM_SKILLS : []) {
  console.log(`human (same health, bots deal 0.75x to him) vs ${WORLD.minPlayers - 1} ${skill} bots, ${minutes} min x ${seeds} seeds`);
  for (const { label, style, gun } of VARIANTS.filter((x) => !variantArg || x.label === variantArg)) {
    const all = emptyTally();
    for (let seed = 1; seed <= seeds; seed++) {
      const t = simulate(seed, style, gun, skill);
      all.lives.push(...t.lives);
      all.levels.push(...t.levels);
      all.botLevels.push(...t.botLevels);
      all.kills += t.kills; all.deaths += t.deaths; all.botOnBotKills += t.botOnBotKills; all.botsKilledByHuman += t.botsKilledByHuman; all.damageTaken += t.damageTaken;
      all.botRounds += t.botRounds; all.botHits += t.botHits; all.roundsAtHuman += t.roundsAtHuman; all.hitsOnHuman += t.hitsOnHuman;
    }
    const simMinutes = minutes * seeds;
    console.log([
      `  ${label.padEnd(26)}`,
      `median life ${median(all.lives).toFixed(1)}s`,
      `deaths ${all.deaths}`,
      `kills ${all.kills}`,
      `K/D ${(all.kills / Math.max(1, all.deaths)).toFixed(2)}`,
      `damage taken/min ${(all.damageTaken / simMinutes).toFixed(0)}`,
      `bot-on-bot kills/min ${(all.botOnBotKills / simMinutes).toFixed(1)}`,
      `bot hits/round ${(all.botHits / Math.max(1, all.botRounds)).toFixed(3)}`,
      `bot misses on him ${(100 * (1 - all.hitsOnHuman / Math.max(1, all.roundsAtHuman))).toFixed(1)}% of ${all.roundsAtHuman}`,
      `human lives reaching ${reachLabel(all.levels)}`,
      `bot lives reaching ${reachLabel(all.botLevels)}`,
    ].join('  '));
  }
}

/**
 * The aim range: one bot of `skill` against one scripted human in an open field, `range` px off, who stands, or strafes side to side
 * (`strafe`) and never shoots back and never dies. Every round the bot fires is at him, so its share of rounds that miss is its aim alone
 * (its reaction, hand, tracking, lead and trigger discipline), as it would play a fight on its own gun.
 */
export function aimRange(skill: RoomSkill, seed: number, opts: { range: number; strafe: boolean; seconds: number }): { rounds: number; hits: number } {
  const w: World = createWorld('FFA', seed, 'plaza');
  w.walls = []; w.crates = []; w.barrels = []; w.props = [];
  const r = () => rand(w);
  const loadout = randomLoadout(r);
  const bot = addPlayer(w, 'bot', loadout, { at: { x: 2000, y: 2000 } });
  const bots = new Map<number, BotMemory>([[bot.id, botMemoryFor(skill, r)]]);
  const human = addPlayer(w, 'human', HUMAN_LOADOUT, { kind: 'human', at: { x: 2000 + opts.range, y: 2000 } });
  if (human.life.k === 'alive') human.life.shieldUntil = -Infinity;
  let rounds = 0, hits = 0, dir = 1, flipAt = 0;
  const ticks = Math.round((opts.seconds * 1000) / TICK_MS);
  for (let t = 0; t < ticks; t++) {
    thinkBots(w, bots, r, { picks: false });
    if (opts.strafe && t >= flipAt) { dir = -dir; flipAt = t + Math.round((300 + r() * 600) / TICK_MS); }
    // He keeps his spot on the bot's ring (it may wander), side-stepping across its line.
    const away = Math.hypot(human.x - bot.x, human.y - bot.y);
    setInput(w, human.id, w.tick, { ...IDLE_INPUT, up: opts.strafe && dir < 0, down: opts.strafe && dir > 0, left: away > opts.range + 60 && human.x > bot.x, right: away < opts.range - 60 && human.x > bot.x });
    step(w, TICK_MS);
    for (const e of w.events) {
      if (e.e === 'shot' && e.owner === bot.id) rounds += GUNS[e.gun].pellets;
      if (e.e === 'dmg' && e.kind === 'player' && e.victim === human.id && e.attacker === bot.id) hits++;
    }
    if (human.life.k === 'alive') human.life.hp = effectiveStats(human).maxHp;
    if (canRespawn(w, bot.id)) respawn(w, bot.id, loadout);
  }
  return { rounds, hits };
}

/**
 * Duels: the scripted human against one bot of `skill` in an open field, each fight from 450 px apart with full health and no spawn shield,
 * the two set back apart after every kill (the bot on a random gun per seed, the same gun for every skill on one seed). His K/D and the
 * damage he takes a minute measure one bot's fight, which a full room's crossfire buries.
 */
export function duels(skill: RoomSkill, seed: number, seconds: number): { kills: number; deaths: number; damageTaken: number } {
  const w: World = createWorld('FFA', seed, 'plaza');
  w.walls = []; w.crates = []; w.barrels = []; w.props = [];
  const r = () => rand(w);
  const loadout = randomLoadout(r);
  const at = { x: 2000, y: 2000 };
  const bot = addPlayer(w, 'bot', loadout, { at });
  const bots = new Map<number, BotMemory>([[bot.id, botMemoryFor(skill, r)]]);
  const human = addPlayer(w, 'human', HUMAN_LOADOUT, { kind: 'human', at: { x: at.x + 450, y: at.y } });
  let mind: HumanMind = { target: null, fireAtTick: 0, aimErr: 0, strafe: 1, flipAtTick: 0, seen: null, shots: 0, wanderX: at.x, wanderY: at.y };
  const out = { kills: 0, deaths: 0, damageTaken: 0 };
  const reset = () => {
    for (const [p, l, x] of [[bot, loadout, at.x], [human, HUMAN_LOADOUT, at.x + 450]] as const) {
      if (p.life.k !== 'alive') respawn(w, p.id, l);
      p.x = x; p.y = at.y;
      if (p.life.k === 'alive') { p.life.hp = effectiveStats(p).maxHp; p.life.shieldUntil = -Infinity; p.life.ammo = effectiveStats(p).mag; }
    }
  };
  reset();
  let downAt: number | null = null;
  const ticks = Math.round((seconds * 1000) / TICK_MS);
  for (let t = 0; t < ticks; t++) {
    thinkBots(w, bots, r, { picks: false, respawn: false });
    const h = humanThink(snapshotFor(w, human.id, w.events, HUMAN_VIEW_ASPECT), [], mind, 'strafe', r);
    mind = { ...h.mind, wanderX: bot.x, wanderY: bot.y };
    setInput(w, human.id, w.tick, h.input);
    step(w, TICK_MS);
    for (const e of w.events) {
      if (e.e === 'dmg' && e.kind === 'player' && e.victim === human.id && e.attacker === bot.id) out.damageTaken += e.amount;
      if (e.e === 'kill') { if (e.victimId === human.id) out.deaths++; else out.kills++; downAt ??= t; }
    }
    if (downAt !== null && (canRespawn(w, bot.id) || bot.life.k === 'alive') && (canRespawn(w, human.id) || human.life.k === 'alive')) { reset(); downAt = null; }
  }
  return out;
}

const duelsAt = process.argv.indexOf('--duels');
if (isMain && duelsAt >= 0) {
  const secs = Number(process.argv[duelsAt + 1] ?? 120);
  console.log(`\nduels: the scripted human against one bot in an open field, ${secs} s x ${seeds} seeds (the bot on a random gun each seed)`);
  for (const skill of ['rookie', 'regular', 'veteran', 'mixed'] as const) {
    let kills = 0, deaths = 0, dmg = 0;
    for (let seed = 1; seed <= seeds; seed++) { const d = duels(skill, seed, secs); kills += d.kills; deaths += d.deaths; dmg += d.damageTaken; }
    console.log(`  ${skill.padEnd(8)} human kills ${String(kills).padStart(4)}  deaths ${String(deaths).padStart(4)}  K/D ${(kills / Math.max(1, deaths)).toFixed(2)}  damage taken/min ${(dmg / ((secs / 60) * seeds)).toFixed(0)}`);
  }
}

const rangeAt = process.argv.indexOf('--aim-range');
if (isMain && rangeAt >= 0) {
  const secs = Number(process.argv[rangeAt + 1] ?? 60);
  console.log(`\naim range: one bot against a human who never shoots back, ${secs} s x ${seeds} seeds (a random gun each seed); share of its rounds that miss`);
  for (const [range, strafe] of [[250, false], [450, false], [250, true], [450, true]] as const) {
    const row: string[] = [];
    for (const skill of ['rookie', 'regular', 'veteran'] as const) {
      let rounds = 0, hits = 0;
      for (let seed = 1; seed <= seeds; seed++) { const x = aimRange(skill, seed, { range, strafe, seconds: secs }); rounds += x.rounds; hits += x.hits; }
      row.push(`${skill} ${(100 * (1 - hits / Math.max(1, rounds))).toFixed(1)}% of ${rounds}`);
    }
    console.log(`  ${String(range).padStart(3)} px ${strafe ? 'strafing' : 'standing'}  ${row.join('  ')}`);
  }
}

const ABILITY_KILL_LABEL: Partial<Record<AbilityId, string>> = { fragGrenade: 'Frag', gasGrenade: 'Gas', claymore: 'Claymore', knife: 'Knife' };

/** Every bot carries `ability` from spawn, so the rule that fires it is measured without waiting for bots to reach tier 3. */
function abilityArena(ability: AbilityId, seed: number): { uses: number; kills: number; deaths: number } {
  const w: World = createWorld('FFA', seed, 'plaza');
  const r = () => rand(w);
  const bots = new Map<number, BotMemory>();
  for (let i = 0; i < WORLD.minPlayers; i++) bots.set(addPlayer(w, `bot${i}`, randomLoadout(r)).id, newBotMemory(r));
  let uses = 0, kills = 0, deaths = 0;
  const ticks = Math.round((abilityMinutes * 60_000) / TICK_MS);
  for (let t = 0; t < ticks; t++) {
    const readyAt = new Map<number, number>();
    for (const id of bots.keys()) {
      const p = w.players.get(id)!;
      p.perks[3] = ability;
      readyAt.set(id, p.abilityReadyAt);
    }
    thinkBots(w, bots, r, { picks: false });
    step(w, TICK_MS);
    for (const [id, at] of readyAt) if (w.players.get(id)!.abilityReadyAt > at) uses++;
    for (const e of w.events) {
      if (e.e !== 'kill') continue;
      deaths++;
      if (e.weapon === ABILITY_KILL_LABEL[ability]) kills++;
    }
  }
  return { uses, kills, deaths };
}

if (isMain && abilityMinutes > 0) console.log(`\nability arena: ${WORLD.minPlayers} bots all holding one ability, ${abilityMinutes} min x ${seeds} seeds`);
for (const ability of isMain && abilityMinutes > 0 ? PERK_TIERS[3] : []) {
  let uses = 0, kills = 0, deaths = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const a = abilityArena(ability, seed);
    uses += a.uses; kills += a.kills; deaths += a.deaths;
  }
  const simMinutes = abilityMinutes * seeds;
  console.log([
    `  ${ability.padEnd(12)}`,
    `uses/min ${(uses / simMinutes).toFixed(1).padStart(5)}`,
    `ability kills/min ${(kills / simMinutes).toFixed(2).padStart(5)}`,
    `share of kills ${((100 * kills) / Math.max(1, deaths)).toFixed(1).padStart(5)}%`,
    `deaths/min ${(deaths / simMinutes).toFixed(1)}`,
  ].join('  '));
}

/** Each bot life draws one ability at random, so holders of different abilities fight each other and their K/D shows which one wins fights. */
function mixedArena(seed: number, kills: Map<AbilityId, number>, deaths: Map<AbilityId, number>) {
  const w: World = createWorld('FFA', seed, 'plaza');
  const r = () => rand(w);
  const bots = new Map<number, BotMemory>();
  const holds = new Map<number, AbilityId>();
  const draw = (id: number) => holds.set(id, PERK_TIERS[3][Math.floor(r() * PERK_TIERS[3].length)]!);
  for (let i = 0; i < WORLD.minPlayers; i++) {
    const id = addPlayer(w, `bot${i}`, randomLoadout(r)).id;
    bots.set(id, newBotMemory(r));
    draw(id);
  }
  const ticks = Math.round((abilityMinutes * 60_000) / TICK_MS);
  for (let t = 0; t < ticks; t++) {
    for (const id of bots.keys()) w.players.get(id)!.perks[3] = holds.get(id)!;
    thinkBots(w, bots, r, { picks: false, onDecision: (id, _snap, _before, _d, respawned) => { if (respawned) draw(id); } });
    step(w, TICK_MS);
    for (const e of w.events) {
      if (e.e !== 'kill') continue;
      const victim = holds.get(e.victimId), killer = e.killerId === null ? undefined : holds.get(e.killerId);
      if (victim) deaths.set(victim, (deaths.get(victim) ?? 0) + 1);
      if (killer && e.killerId !== e.victimId) kills.set(killer, (kills.get(killer) ?? 0) + 1);
    }
  }
}

if (isMain && abilityMinutes > 0) {
  const kills = new Map<AbilityId, number>(), deaths = new Map<AbilityId, number>();
  for (let seed = 1; seed <= seeds; seed++) mixedArena(seed, kills, deaths);
  console.log(`\nmixed ability arena: each bot life holds a random ability, ${abilityMinutes} min x ${seeds} seeds; K/D by ability held`);
  for (const ability of PERK_TIERS[3]) console.log(`  ${ability.padEnd(12)} kills ${String(kills.get(ability) ?? 0).padStart(4)}  deaths ${String(deaths.get(ability) ?? 0).padStart(4)}  K/D ${((kills.get(ability) ?? 0) / Math.max(1, deaths.get(ability) ?? 0)).toFixed(2)}`);
}
