import { ARMORS, hordeCount, isBoss, NIGHTS, nightOf, WALL_TIERS, WORLD, ZOM, ZOMBIE_KINDS, ZOMBIES, zombieBounty, zombieRole, type BuildingKind, type Burst, type ZombieKind } from '../defs.ts';
import { MAPS } from '../maps.ts';
import { biteBuilding, distToRect, hurtCore, tickHorde } from './horde.ts';
import { explode } from './combat.ts';
import { tickTurrets } from './turrets.ts';
import { buildingView, buildRefusal, buildsNow, cellRect, linesOf, costOf, levelOf, maxHpOf, refundFor, repairScrapPerHp, serviceTarget, turretDef, upgradeCost, upgradeRefusal, wallTier, type BuildRefusal, type BuildSite, type UpgradeRefusal } from './build.ts';
import { armorWatch, tickArmor, tickTraps, tickUtilities, trapWatch } from './utility.ts';
import { circleBlocked, clamp, dist2, type Rect } from './movement.ts';
import { addScore, freshLife, resetProgress } from './stats.ts';
import { tickDowned } from './downed.ts';
import { coreRect, coverRects, loadMap, newId, newRun, rand, solidRects, spawnPoint, type HordeUnit, type Player, type Run, type RunStats, type Shooter, type World, type Zombie } from './world.ts';

function squadOf(w: World) {
  const squad = { humans: 0, bots: 0 };
  for (const p of w.players.values()) squad[p.kind === 'human' ? 'humans' : 'bots']++;
  return squad;
}

export const zombieMaxHp = (kind: ZombieKind, night: number, share: number) => ZOMBIES[kind].hp * ZOM.nightMul(night).hp * (isBoss(kind) ? share : 1);

function statsFor(run: Run, p: Player): RunStats {
  let s = run.stats.get(p.id);
  if (!s) run.stats.set(p.id, (s = { name: p.name, kills: 0, revives: 0, built: 0, scrap: 0, dealt: 0 }));
  return s;
}

function tickSquadmate(w: World, run: Run, p: Player, dtMs: number, revivers: Set<Player>) {
  const outcome = tickDowned(w, p, dtMs, revivers);
  if (outcome === 'bledOut') {
    p.life = { k: 'dead', respawnAt: w.now + ZOM.reinforce.ms };
    p.deaths++;
  } else if (outcome) statsFor(run, outcome).revives++;
}

function service(w: World, run: Run, p: Player, dtMs: number) {
  const core = MAPS[w.map].siege!.core;
  const target = serviceTarget(p, { ...core, hp: Math.ceil(run.core.hp), maxHp: ZOM.coreHp }, w.buildings.map((b) => ({ ...buildingView(b), b })));
  if (!target) return;
  // A sidearm leaves the hands free: its holder mends buildings and reloads turrets faster (`ZombieRole.mend`), but the core at the plain rate.
  const hands = target.on === 'core' ? 1 : zombieRole(p.gun).mend;
  const mend = (it: { hp: number }, max: number, perHp: number, speed = 1) => {
    const hp = Math.min((ZOM.repairHpPerSec * hands * speed * dtMs) / 1000, max - it.hp, run.scrap / perHp);
    it.hp += hp;
    run.scrap -= hp * perHp;
    if (hp > 0) (run.mended ??= new Map()).set(p.id, (run.mended.get(p.id) ?? 0) + hp);
  };
  if (target.on === 'core') { mend(run.core, ZOM.coreHp, ZOM.coreRepairScrapPerHp); return; }
  const b = target.on.b;
  if (target.job === 'repair' || !('ammo' in b)) { mend(b, maxHpOf(b.kind, levelOf(b)), repairScrapPerHp(b.kind, levelOf(b)), b.kind === 'wall' ? wallTier(levelOf(b)).repairMul : 1); return; }
  const def = turretDef(b.kind, levelOf(b));
  const rounds = Math.min((def.ammo * hands * dtMs) / ZOM.refillMs, def.ammo - b.ammo, run.scrap / def.scrapPerRound);
  b.ammo += rounds;
  run.scrap -= rounds * def.scrapPerRound;
}

function reinforce(w: World, run: Run) {
  for (const p of w.players.values()) {
    const cost = ZOM.reinforce.survivors(run.night);
    // Sending the last of them is allowed now that their loss no longer ends the run; with too few left the dead wait for dawn.
    if (p.life.k !== 'dead' || w.now < p.life.respawnAt || run.survivors < cost) continue;
    run.survivors -= cost;
    run.lost += cost;
    placeAtCore(w, p);
    p.life = freshLife(p, w.now);
    w.events.push({ e: 'life', id: p.id, name: p.name, k: 'revived', by: null });
  }
}

function tickSquad(w: World, run: Run, dtMs: number) {
  if (run.phase.k === 'night') reinforce(w, run);
  const revivers = new Set<Player>();
  for (const p of w.players.values()) tickSquadmate(w, run, p, dtMs, revivers);
  for (const p of w.players.values()) if (p.life.k === 'alive' && p.input.use && !revivers.has(p)) service(w, run, p, dtMs);
}

const cellCenter = (cx: number, cy: number) => ({ x: (cx + 0.5) * ZOM.cell, y: (cy + 0.5) * ZOM.cell });

function siteFor(w: World, run: Run, p: Player, core: Rect): BuildSite {
  const bodies = [
    ...[...w.players.values()].filter((o) => o.life.k !== 'dead').map((o) => ({ x: o.x, y: o.y, r: WORLD.playerRadius })),
    ...w.zombies.map((z) => ({ x: z.x, y: z.y, r: ZOMBIES[z.kind].radius })),
  ];
  return { canBuild: buildsNow(run.phase.k, p.gun), builder: p.life.k === 'alive' ? p : null, core, cover: coverRects(w), bodies, buildings: [...w.buildings, ...w.floor].map(buildingView), scrap: run.scrap };
}

/** Puts `kind` up on a cell for its price; a wall goes up at tier `lv` (1 to 3), anything else at its first level. */
export function build(w: World, id: number, kind: BuildingKind, cx: number, cy: number, lv = 1): BuildRefusal | null {
  const p = w.players.get(id);
  const run = w.run;
  const core = coreRect(w);
  if (!p || !run || !core) return 'notDay';
  const level = kind === 'wall' ? Math.min(WALL_TIERS.length, Math.max(1, Math.floor(lv))) : 1;
  const refusal = buildRefusal(siteFor(w, run, p, core), kind, cx, cy, level);
  if (refusal) return refusal;
  run.scrap -= costOf(kind, level);
  const at = { id: newId(w), cx, cy, hp: maxHpOf(kind, level), ...(level > 1 && { lv: level }) };
  if (kind === 'spikes') w.floor.push({ ...at, kind });
  else {
    w.buildings.push(kind === 'wall' || kind === 'depot' || kind === 'post' ? { ...at, kind } : { ...at, kind, owner: p.id, ammo: turretDef(kind).ammo, nextFireAt: 0 });
    w.buildingsVersion++;
  }
  statsFor(run, p).built++;
  return null;
}

/**
 * A line dragged out in build mode: each cell in order from its start goes up by the single build's rules (the hour, reach, a free cell, the scrap),
 * so the line stands as far as the scrap lasts and a cell that cannot take it is passed over. Answers each cell's refusal, null for those built.
 */
export function buildLine(w: World, id: number, kind: BuildingKind, cells: readonly (readonly [number, number])[], lv = 1): (BuildRefusal | null)[] {
  if (!linesOf(kind) || cells.length > ZOM.lineMax) return cells.map(() => 'notDay');
  return cells.map(([cx, cy]) => build(w, id, kind, cx, cy, lv));
}

const standingAt = (w: World, cx: number, cy: number) => w.buildings.find((b) => b.cx === cx && b.cy === cy) ?? w.floor.find((b) => b.cx === cx && b.cy === cy);

/**
 * Steps the wall, turret or utility on a cell up a level for the price of the step, by day (or by night with a gun that builds then), within reach. Its health and load keep their share, so a worn building stays worn.
 * A turret's builder keeps the credit for its kills.
 */
export function upgrade(w: World, id: number, cx: number, cy: number): UpgradeRefusal | null {
  const p = w.players.get(id);
  const run = w.run;
  const core = coreRect(w);
  if (!p || !run || !core) return 'notDay';
  const refusal = upgradeRefusal(siteFor(w, run, p, core), cx, cy);
  if (refusal) return refusal;
  const b = standingAt(w, cx, cy)!;
  const lv = levelOf(b);
  run.scrap -= upgradeCost(b.kind, lv)!;
  const hpShare = b.hp / maxHpOf(b.kind, lv);
  const ammoShare = 'ammo' in b ? b.ammo / turretDef(b.kind, lv).ammo : 0;
  b.lv = lv + 1;
  b.hp = hpShare * maxHpOf(b.kind, lv + 1);
  if ('ammo' in b) b.ammo = ammoShare * turretDef(b.kind, lv + 1).ammo;
  w.buildingsVersion++;
  return null;
}

export function demolish(w: World, id: number, cx: number, cy: number): boolean {
  const p = w.players.get(id);
  const run = w.run;
  const building = standingAt(w, cx, cy);
  if (!p || !run || !building || !buildsNow(run.phase.k, p.gun) || p.life.k !== 'alive') return false;
  const at = cellCenter(cx, cy);
  if (dist2(at.x, at.y, p.x, p.y) > ZOM.reachPx ** 2) return false;
  if (building.kind === 'spikes') w.floor = w.floor.filter((b) => b !== building);
  else {
    w.buildings = w.buildings.filter((b) => b !== building);
    w.buildingsVersion++;
  }
  run.scrap += refundFor(buildingView(building));
  return true;
}

/** One hit marker per zombie and attacker a tick, so a shotgun's pellets in one zombie read as one hit. */
function markHit(w: World, z: Zombie, dealt: number, attacker: number | null) {
  const same = w.events.find((e) => e.e === 'dmg' && e.kind === 'zombie' && e.victim === z.id && e.attacker === attacker);
  const amount = Math.round(((same?.e === 'dmg' ? same.amount : 0) + dealt) * 10) / 10;
  if (same?.e === 'dmg') same.amount = amount;
  else w.events.push({ e: 'dmg', attacker, victim: z.id, amount, x: z.x, y: z.y, kind: 'zombie' });
}

/**
 * Only a player's own direct hit is sent to the client: a blast's boom already shows, and a crowd's worth of blast or turret hits would fill the snapshot.
 */
export function damageZombie(w: World, z: Zombie, amount: number, attacker: Player | null, via: 'hit' | 'blast' | Shooter = 'hit') {
  const run = w.run;
  if (!run || z.hp <= 0) return;
  const dealt = Math.min(z.hp, amount);
  z.hp -= amount;
  if (via === 'hit') markHit(w, z, dealt, attacker?.id ?? null);
  if (attacker && (via === 'hit' || via === 'blast')) statsFor(run, attacker).dealt += dealt;
  if (z.hp > 0) return;
  const def = ZOMBIES[z.kind];
  const shooter = via === 'hit' || via === 'blast' ? null : via;
  w.zombies = w.zombies.filter((o) => o !== z);
  // A player's own kill pays the bounty of the gun in their hand (`zombieBounty`): a gun slow to kill the horde pays more for each.
  const by = shooter ? null : attacker;
  const scrap = Math.round(def.scrap * (by ? zombieBounty(by.gun) : 1) * 100) / 100;
  run.scrap += scrap;
  w.events.push({ e: 'zkill', id: z.id, kind: z.kind, x: z.x, y: z.y, by: by?.id ?? null, scrap });
  if (shooter === 'bastion') run.bastionKills++;
  else if (shooter) run.turretKills[shooter][z.kind]++;
  else if (attacker) { attacker.kills++; const s = statsFor(run, attacker); s.kills++; s.scrap += scrap; }
  // Versus levels are scaled up for the medals a kill pays there; the horde pays no medals, so its score is scaled to match.
  if (attacker) addScore(w, attacker, def.score * ZOM.levelScoreMul);
  if (def.burst) burst(w, run, z, def.burst);
}

function burst(w: World, run: Run, z: Zombie, { radius, damage, building, core: coreBlow }: Burst) {
  explode(w, z.x, z.y, radius, damage, { attacker: null, team: null, label: ZOMBIES[z.kind].name });
  for (const b of [...w.buildings]) if (distToRect(z.x, z.y, cellRect(b.cx, b.cy)) <= radius) biteBuilding(w, b, building * (b.kind === 'wall' ? wallTier(levelOf(b)).blast : 1));
  if (distToRect(z.x, z.y, coreRect(w)!) <= radius) hurtCore(run, coreBlow * (1 - ZOM.coreArmor));
}

function burnStragglers(w: World) {
  for (const z of w.zombies) w.events.push({ e: 'zkill', id: z.id, kind: z.kind, x: z.x, y: z.y, by: null });
  w.zombies = [];
}

function hordeOf(w: World, night: number, share: number): HordeUnit[] {
  const def = nightOf(night);
  const units: HordeUnit[] = [];
  for (const kind of ZOMBIE_KINDS) {
    for (let left = hordeCount(kind, def.horde[kind] ?? 0, share); left > 0; left -= ZOMBIES[kind].pack) {
      units.push({ kind, side: def.from[Math.floor(rand(w) * def.from.length)]!, n: Math.min(left, ZOMBIES[kind].pack) });
    }
  }
  for (let i = units.length - 1; i > 0; i--) {
    const j = Math.floor(rand(w) * (i + 1));
    [units[i], units[j]] = [units[j]!, units[i]!];
  }
  return units;
}

const PACK_SPREAD = 140;
/** A pack walks in as sub-groups of up to `SUB_GROUP`, each at its own spot up to this far along the edge from the pack's. */
const SUB_GROUP = 3, SUB_SPREAD = 350, EDGE_MARGIN = 250;

function spawnUnit(w: World, run: Run, { kind, side, n }: HordeUnit) {
  const edge = MAPS[w.map].siege!.horde[side];
  const alongX = edge.w >= edge.h;
  // Keep clear of the strip's ends, so a zombie in from a corner is never nearer another side's cone than its own.
  const strip = alongX ? { ...edge, x: edge.x + EDGE_MARGIN, w: edge.w - 2 * EDGE_MARGIN } : { ...edge, y: edge.y + EDGE_MARGIN, h: edge.h - 2 * EDGE_MARGIN };
  const solids = solidRects(w);
  const r = ZOMBIES[kind].radius;
  const ax = strip.x + rand(w) * strip.w, ay = strip.y + rand(w) * strip.h;
  for (let left = n; left > 0; left -= SUB_GROUP) {
    const want = Math.min(left, SUB_GROUP), shift = (rand(w) - 0.5) * 2 * SUB_SPREAD * (n > SUB_GROUP ? 1 : 0);
    // A sub-group shifted past the strip's end is pulled back in, so its spread never piles onto the end and its crush shoves it off its side.
    const half = PACK_SPREAD / 2;
    const sx = alongX ? clamp(ax + shift, strip.x + half, strip.x + strip.w - half) : ax, sy = alongX ? ay : clamp(ay + shift, strip.y + half, strip.y + strip.h - half);
    let pack: number | undefined;
    for (let placed = 0, tries = 0; placed < want && tries < 20 * want; tries++) {
      const x = clamp(sx + (rand(w) - 0.5) * (alongX ? PACK_SPREAD : strip.w), strip.x, strip.x + strip.w), y = clamp(sy + (rand(w) - 0.5) * (alongX ? strip.h : PACK_SPREAD), strip.y, strip.y + strip.h);
      if (circleBlocked(solids, x, y, r)) continue;
      const id = newId(w);
      pack ??= id;
      w.zombies.push({ id, kind, x, y, hp: zombieMaxHp(kind, run.night, run.share), attackAt: 0, vx: 0, vy: 0, pack });
      placed++;
    }
  }
}

function placeAtCore(w: World, p: Player) {
  const at = spawnPoint(w, p.team);
  p.x = at.x;
  p.y = at.y;
}

/**
 * The night is held: the run goes on, past the Tide too (the room pays Held the Line for that one), and every squad player down or out stands up free.
 * Bites wear armor as bullets do, and the outpost has no armor packs, so the squad re-kits at dawn: whoever is standing gets a full pool again.
 */
function dawn(w: World, run: Run) {
  run.scrap += run.survivors * ZOM.scrapPerSurvivor;
  run.night++;
  run.phase = { k: 'day', endsAt: w.now + ZOM.dayMs };
  for (const p of w.players.values()) {
    if (p.life.k === 'alive') { p.life.armor = ARMORS[p.loadout.armor].points; continue; }
    placeAtCore(w, p);
    p.life = freshLife(p, w.now);
  }
}

/** Only the core's fall ends a run. The report counts it `won` when the squad held through the Tide on the way. */
function endRun(w: World, run: Run) {
  for (const p of w.players.values()) statsFor(run, p);
  run.lost += run.survivors;
  run.survivors = 0;
  run.phase = { k: 'over', night: run.night, won: run.night > NIGHTS.length, restartAt: w.now + ZOM.restartMs };
  w.zombies = [];
}

export function toggleReady(w: World, id: number) {
  const run = w.run, p = w.players.get(id);
  if (!run || run.phase.k !== 'day' || p?.kind !== 'human') return;
  if (!run.ready.delete(id)) run.ready.add(id);
}

function squadReady(w: World, run: Run) {
  const humans = [...w.players.values()].filter((p) => p.kind === 'human' && p.life.k === 'alive');
  return humans.length > 0 && humans.every((p) => run.ready.has(p.id));
}

function restartRun(w: World) {
  loadMap(w, w.map);
  w.run = newRun(w.now);
  const players = [...w.players.values()];
  for (const p of players) { p.x = -Infinity; p.y = -Infinity; }
  for (const p of players) {
    // The run's life ends here, as a versus round's does at its restart, so what it scored is paid before it is wiped (a squad keeps its progress through a death, so the dead too).
    w.lifeRecords.push({ id: p.id, name: p.name, kills: p.lifeKills, score: p.score, died: false });
    p.lifeKills = 0;
    resetProgress(p, w);
    p.kills = 0;
    p.deaths = 0;
    placeAtCore(w, p);
    p.life = freshLife(p, w.now);
  }
}

/** How many of the next packs walk in together: up to `packs`, and only as many as fit under the live cap's `room`, so the endless nights stay bounded. */
function waveSize(toSpawn: readonly HordeUnit[], packs: number, room: number): number {
  let n = 0;
  while (n < Math.min(packs, toSpawn.length) && toSpawn[n]!.n <= room) room -= toSpawn[n++]!.n;
  return n;
}

export function tickRun(w: World, dtMs: number) {
  const run = w.run;
  if (!run) return;
  const phase = run.phase;
  switch (phase.k) {
    case 'day':
      if (w.now >= phase.endsAt || squadReady(w, run)) {
        run.share = ZOM.hordeShare(squadOf(w));
        run.phase = { k: 'night', toSpawn: hordeOf(w, run.night, run.share), nextSpawnAt: w.now, dawnAt: Infinity };
        run.ready.clear();
        run.lost = 0;
      }
      break;
    case 'night':
      if (phase.toSpawn.length > 0 && w.now >= phase.nextSpawnAt && w.zombies.length < ZOM.maxAlive) {
        const wave = phase.toSpawn.splice(0, waveSize(phase.toSpawn, ZOM.packsPerWave(run.night), ZOM.maxAlive - w.zombies.length));
        for (const unit of wave) spawnUnit(w, run, unit);
        phase.nextSpawnAt = w.now + wave.length * ZOM.packGapMs(run.night);
        if (phase.toSpawn.length === 0) phase.dawnAt = w.now + ZOM.stragglersMs;
      }
      if (w.now >= phase.dawnAt) burnStragglers(w);
      if (phase.toSpawn.length === 0 && w.zombies.length === 0) dawn(w, run);
      break;
    case 'over':
      if (w.now >= phase.restartAt) restartRun(w);
      return;
  }
  const traps = trapWatch(w), armor = armorWatch(w);
  tickHorde(w, run, dtMs);
  tickTraps(w, dtMs, traps);
  tickArmor(w, armor);
  tickUtilities(w, run, dtMs);
  tickTurrets(w, run, MAPS[w.map].siege!.core, dtMs);
  tickSquad(w, run, dtMs);
  if (run.core.hp <= 0) endRun(w, run);
}
