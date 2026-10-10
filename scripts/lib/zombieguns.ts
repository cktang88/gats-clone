import { GUNS, WORLD, ZOM, ZOMBIES, type GunId, type ZombieKind } from '../../src/shared/defs.ts';
import { addPlayer, step } from '../../src/shared/sim.ts';
import { zombieMaxHp } from '../../src/shared/sim/run.ts';
import { effectiveStats } from '../../src/shared/sim/stats.ts';
import { createWorld, newId, rand, type Player, type World } from '../../src/shared/sim/world.ts';
import { newBotMemory, randomLoadout, type BotMemory } from '../../src/server/bots.ts';
import { thinkBots } from '../../src/server/bot/tick.ts';

const TICK_MS = 1000 / WORLD.tickHz;
const SEATS = 4;

/**
 * Holds a player to one gun for a whole run with no perks, so the gun alone is measured: a bot brain would evolve it and pick an attachment,
 * a perk and an ability, each of which would blur one gun into another. An evolve the brain takes is undone, keeping the magazine no fuller than the gun's.
 */
function pin(p: Player, gun: GunId, ammo: number) {
  if (p.perks[1] || p.perks[2] || p.perks[3]) p.perks = {};
  if (p.gun === gun) return;
  // The evolve rescaled the magazine to the new gun's: the rounds it had are put back, or every tick's evolve would empty it.
  p.gun = gun;
  if (p.life.k === 'alive') p.life.ammo = Math.min(ammo, effectiveStats(p).mag);
}
const ammoOf = (p: Player) => (p.life.k === 'alive' ? p.life.ammo : 0);

export type GunRun = {
  gun: GunId; seed: number; night: number; won: boolean;
  /** The pinned players' own kills, harm dealt and the scrap their kills paid, summed; `byKind` their kills of each kind. */
  kills: number; dealt: number; scrap: number; byKind: Record<ZombieKind, number>;
  /** Everything the squad's bank took in over the run (kills, turrets, dawn pay), and the core health bitten off in all. */
  bank: number; coreLost: number; minutes: number;
  /** How often the holders went down, and the seconds they spent alive and standing at night. */
  downs: number; nightSec: number;
};

/**
 * One seeded zombies run on the Outpost with `humans` of the four seats bot brains flagged human, each held to `gun` (see `pin`); the first builds on the
 * squad bots' plan with the shared bank, as a human who builds sensibly, and the other seats are bots with their own random guns (the same for every gun on a seed).
 * Played to the core's fall, the Tide's dawn or night `untilNight`'s dawn.
 */
export function playGunRun(seed: number, gun: GunId | readonly GunId[], humans = 2, untilNight = Infinity): GunRun {
  const guns = typeof gun === 'string' ? Array.from({ length: humans }, () => gun) : gun;
  const w = createWorld('ZOM', seed, 'outpost');
  const r = () => rand(w);
  const bots = new Map<number, BotMemory>();
  const pinned = new Map<number, GunId>();
  for (let i = 0; i < SEATS; i++) {
    const human = i < guns.length;
    const loadout = randomLoadout(r);
    const g = guns[i];
    const p = addPlayer(w, `${human ? 'h' : 'bot'}${i}`, g ? { ...loadout, weapon: GUNS[g].base } : loadout, { kind: human ? 'human' : 'bot' });
    if (g) { pinned.set(p.id, g); pin(p, g, 0); if (p.life.k === 'alive') p.life.ammo = effectiveStats(p).mag; }
    bots.set(p.id, { ...newBotMemory(r), ...(human && { siegeBuild: i === 0 ? 'always' as const : 'never' as const }) });
  }
  const byKind = Object.fromEntries(Object.keys(ZOMBIES).map((k) => [k, 0])) as Record<ZombieKind, number>;
  let downs = 0, nightSec = 0;
  let bank = 0, coreLost = 0, scrapWas = w.run!.scrap, coreWas = w.run!.core.hp;
  const over = () => w.run!.phase.k === 'over';
  while (!over() && w.run!.night <= untilNight) {
    const ammo = new Map([...pinned.keys()].map((id) => [id, ammoOf(w.players.get(id)!)]));
    thinkBots(w, bots, r, { respawn: false });
    for (const [id, g] of pinned) pin(w.players.get(id)!, g, ammo.get(id)!);
    step(w, TICK_MS);
    for (const e of w.events) {
      if (e.e === 'zkill' && e.by !== null && pinned.has(e.by)) byKind[e.kind]++;
      if (e.e === 'life' && e.k === 'downed' && pinned.has(e.id)) downs++;
    }
    if (w.run!.phase.k === 'night') for (const id of pinned.keys()) if (w.players.get(id)!.life.k === 'alive') nightSec += TICK_MS / 1000;
    const run = w.run!;
    if (run.scrap > scrapWas) bank += run.scrap - scrapWas;
    scrapWas = run.scrap;
    if (run.core.hp < coreWas) coreLost += coreWas - Math.max(0, run.core.hp);
    coreWas = run.core.hp;
  }
  const run = w.run!;
  const end = run.phase.k === 'over' ? run.phase : null;
  let kills = 0, dealt = 0, scrap = 0;
  for (const id of pinned.keys()) {
    const s = run.stats.get(id);
    if (!s) continue;
    kills += s.kills;
    dealt += s.dealt;
    scrap += s.scrap;
  }
  return { gun: guns[0]!, seed, night: end ? end.night : run.night, won: !!end?.won, kills, dealt, scrap, byKind, bank, coreLost, minutes: w.now / 60_000, downs, nightSec };
}

export type Drill = { gun: GunId; kind: ZombieKind; kills: number; dealt: number; leaked: number; seconds: number };

/** Where the drill's shooter stands: the open ground due south of the core, where a pack walks straight at them. */
const AT = { x: 1475, y: 1700 };

/**
 * A shooting drill: one player held to `gun` with no perks, unhurt, stands south of the core while packs of `kind` walk in from 650 px beyond them,
 * night `night`'s health, a fresh pack once the last is dead or through. Counts the harm dealt and the kills in `ms`, and the zombies that got within
 * bite of the player or the core (each is then taken off, as through).
 */
export function gunDrill(gun: GunId, kind: ZombieKind, { night = 4, ms = 45_000, seed = 1, pack = Math.min(6, ZOMBIES[kind].pack * 2) } = {}): Drill {
  const w = createWorld('ZOM', seed, 'outpost');
  const run = w.run!;
  run.night = night;
  run.core.hp = 1e12;
  run.phase = { k: 'night', toSpawn: [{ kind: 'walker', side: 'north', n: 1 }], nextSpawnAt: Infinity, dawnAt: Infinity };
  const r = () => rand(w);
  const p = addPlayer(w, 'h0', { weapon: GUNS[gun].base, armor: 'none', color: 'red' }, { kind: 'human', at: AT });
  pin(p, gun, 0);
  if (p.life.k === 'alive') p.life.ammo = effectiveStats(p).mag;
  const bots = new Map([[p.id, { ...newBotMemory(r), siegeBuild: 'never' as const }]]);
  let leaked = 0, kills = 0;
  const spawnPack = () => {
    for (let i = 0; i < pack; i++) {
      const x = AT.x + (i - (pack - 1) / 2) * 44 + (r() - 0.5) * 20, y = AT.y + 650 + (r() - 0.5) * 60 + (i % 2) * 40;
      w.zombies.push({ id: newId(w), kind, x, y, hp: zombieMaxHp(kind, night, 1), attackAt: Infinity, vx: 0, vy: 0, pack: 1 });
    }
  };
  for (let t = 0; t < ms; t += TICK_MS) {
    if (w.zombies.length === 0) spawnPack();
    const ammo = ammoOf(p);
    thinkBots(w, bots, r, { respawn: false });
    pin(p, gun, ammo);
    if (p.life.k === 'alive') p.life.hp = 1e9;
    step(w, TICK_MS);
    for (const e of w.events) if (e.e === 'zkill' && e.by === p.id) kills++;
    const through = w.zombies.filter((z) => Math.hypot(z.x - p.x, z.y - p.y) < ZOMBIES[z.kind].radius + WORLD.playerRadius + ZOM.biteReach || z.y < AT.y - 60);
    leaked += through.length;
    if (through.length) w.zombies = w.zombies.filter((z) => !through.includes(z));
  }
  return { gun, kind, kills, dealt: run.stats.get(p.id)?.dealt ?? 0, leaked, seconds: ms / 1000 };
}
