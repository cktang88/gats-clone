/// <reference types="node" />
// Usage: node scripts/bench-bots.ts [minutes=10] [seeds=10] [abilityMinutes=3]
// minutes=0 or abilityMinutes=0 skips that section.
import { EVOLUTIONS, GUNS, LEVELS, PERK_TIERS, pickOptions, WORLD, type AbilityId, type GunId } from '../src/shared/defs.ts';
import { MAPS } from '../src/shared/maps.ts';
import type { InputState, Loadout, PlayerView, Snapshot, WallView } from '../src/shared/protocol.ts';
import { addPlayer, canRespawn, respawn, setInput, step } from '../src/shared/sim.ts';
import { segmentEntersRectAt } from '../src/shared/sim/movement.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { choosePick, effectiveStats, levelForScore, pendingPick } from '../src/shared/sim/stats.ts';
import { createWorld, IDLE_INPUT, rand, type Player, type World } from '../src/shared/sim/world.ts';
import { newBotMemory, randomLoadout, type BotMemory } from '../src/server/bots.ts';
import { arenaFor } from '../src/server/bot/arena.ts';
import { thinkBots } from '../src/server/bot/tick.ts';
import { flightSec } from '../src/shared/sim/ballistics.ts';
import { median } from './lib/stats.ts';

const minutes = Number(process.argv[2] ?? 10);
const seeds = Number(process.argv[3] ?? 10);
const abilityMinutes = Number(process.argv[4] ?? 3);
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

type Tally = { lives: number[]; levels: number[]; botLevels: number[]; kills: number; deaths: number; botOnBotKills: number; botsKilledByHuman: number; damageTaken: number };

/** A stage-2 gun of the human's class, standing in for a human who has reached the hunted stage. */
const HUNTED_GUN: GunId = EVOLUTIONS[EVOLUTIONS[HUMAN_LOADOUT.weapon][0]!][0]!;

function arm(p: Player, gun: GunId | null) {
  if (!gun) return;
  p.gun = gun;
  if (p.life.k === 'alive') p.life.ammo = effectiveStats(p).mag;
}

function simulate(seed: number, style: HumanStyle, forcedGun: GunId | null): Tally {
  const w: World = createWorld('FFA', seed, 'plaza');
  const r = () => rand(w);
  const bots = new Map<number, BotMemory>();
  for (let i = 0; i < WORLD.minPlayers - 1; i++) bots.set(addPlayer(w, `bot${i}`, randomLoadout(r)).id, newBotMemory(r));
  const human = addPlayer(w, 'human', HUMAN_LOADOUT, { kind: 'human' });
  arm(human, forcedGun);
  let mind: HumanMind = { target: null, fireAtTick: 0, aimErr: 0, strafe: 1, flipAtTick: 0, seen: null, shots: 0, wanderX: r() * MAPS[w.map].size, wanderY: r() * MAPS[w.map].size };
  let bornAt = w.now;
  const tally: Tally = { lives: [], levels: [], botLevels: [], kills: 0, deaths: 0, botOnBotKills: 0, botsKilledByHuman: 0, damageTaken: 0 };
  const ticks = Math.round((minutes * 60_000) / TICK_MS);
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

console.log(`human (same health, bots deal 0.8x to him) vs ${WORLD.minPlayers - 1} bots, ${minutes} min x ${seeds} seeds`);
for (const { label, style, gun } of minutes > 0 ? VARIANTS : []) {
  const all: Tally = { lives: [], levels: [], botLevels: [], kills: 0, deaths: 0, botOnBotKills: 0, botsKilledByHuman: 0, damageTaken: 0 };
  for (let seed = 1; seed <= seeds; seed++) {
    const t = simulate(seed, style, gun);
    all.lives.push(...t.lives);
    all.levels.push(...t.levels);
    all.botLevels.push(...t.botLevels);
    all.kills += t.kills; all.deaths += t.deaths; all.botOnBotKills += t.botOnBotKills; all.botsKilledByHuman += t.botsKilledByHuman; all.damageTaken += t.damageTaken;
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
    `human lives reaching ${reachLabel(all.levels)}`,
    `bot lives reaching ${reachLabel(all.botLevels)}`,
  ].join('  '));
}

const ABILITY_KILL_LABEL: Partial<Record<AbilityId, string>> = { grenade: 'Grenade', fragGrenade: 'Frag', gasGrenade: 'Gas', landMine: 'Land mine', knife: 'Knife' };

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

if (abilityMinutes > 0) console.log(`\nability arena: ${WORLD.minPlayers} bots all holding one ability, ${abilityMinutes} min x ${seeds} seeds`);
for (const ability of abilityMinutes > 0 ? PERK_TIERS[3] : []) {
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

if (abilityMinutes > 0) {
  const kills = new Map<AbilityId, number>(), deaths = new Map<AbilityId, number>();
  for (let seed = 1; seed <= seeds; seed++) mixedArena(seed, kills, deaths);
  console.log(`\nmixed ability arena: each bot life holds a random ability, ${abilityMinutes} min x ${seeds} seeds; K/D by ability held`);
  for (const ability of PERK_TIERS[3]) console.log(`  ${ability.padEnd(12)} kills ${String(kills.get(ability) ?? 0).padStart(4)}  deaths ${String(deaths.get(ability) ?? 0).padStart(4)}  K/D ${((kills.get(ability) ?? 0) / Math.max(1, deaths.get(ability) ?? 0)).toFixed(2)}`);
}
