import { byTurret, WORLD, ZOM, ZOMBIE_KINDS, ZOMBIES } from '../defs.ts';
import type {
  BulletView, CrateView, GameEvent, LeaderRow, MatchView, MinimapMark, PlayerView, RunView, SelfView, Snapshot, ThrownKind, ThrownView, WallView, ZombieView, ZoneView,
} from '../protocol.ts';
import { rankRows, DEFAULT_VIEW_ASPECT, VIEW_PRELOAD_MARGIN, viewExtents } from '../protocol.ts';
import { MAP_NOTICE_MS, MAPS, nextMap } from '../maps.ts';
import { GAS_RADIUS } from './abilities.ts';
import { dist2 } from './movement.ts';
import { abilityOf, effectiveStats, isHunted, pendingPick } from './stats.ts';
import { zombieMaxHp } from './run.ts';
import { buildingView, tenths } from './build.ts';
import { isEnemy, sameTeam, type Player, type Run, type World } from './world.ts';

const GHILLIE_STILL_MS = 600;
const HIDDEN_REVEAL_DIST = 140;

export function wallViews(w: World): WallView[] {
  return w.walls.map(({ expiresAt: _, ...view }) => view);
}

function isHidden(w: World, p: Player): boolean {
  return p.life.k === 'alive' && !isHunted(w, p) && effectiveStats(p).ghillie && w.now - p.life.lastMoveAt >= GHILLIE_STILL_MS && w.now >= p.revealedUntil;
}

/** Hunted as `me` sees it: an enemy holding a stage-2 gun, or me holding one. A teammate's never reads as a threat. */
const huntedFor = (w: World, me: Player, p: Player) => isHunted(w, p) && (p.id === me.id || isEnemy(me, p));

function playerView(w: World, p: Player, me: Player): PlayerView {
  const life = p.life;
  const stats = effectiveStats(p);
  const alive = life.k === 'alive';
  return {
    id: p.id, name: p.name, x: p.x, y: p.y, angle: p.angle,
    hp: alive ? Math.ceil(life.hp) : 0, maxHp: stats.maxHp,
    color: p.loadout.color, gun: p.gun, team: p.team,
    alive, hidden: isHidden(w, p), shield: stats.shield, dashing: alive && life.dash !== null,
    score: p.score, level: p.level, armorTier: p.loadout.armor, kind: p.kind, hunted: huntedFor(w, me, p),
    ...(life.k === 'downed' && { downed: { revive: life.reviveProgress / ZOM.reviveMs, bleedOutAt: life.bleedOutAt } }),
  };
}

function selfView(w: World, p: Player): SelfView {
  const life = p.life;
  const stats = effectiveStats(p);
  const ability = abilityOf(p);
  return {
    id: p.id,
    ammo: life.k === 'alive' ? life.ammo : 0,
    mag: stats.mag,
    speed: stats.speed,
    reloading: life.k === 'alive' && life.reloadUntil !== null,
    reloadFrac: life.k === 'alive' && life.reloadUntil !== null
      ? Math.min(1, Math.max(0, 1 - (life.reloadUntil - w.now) / stats.reloadMs))
      : 0,
    perks: { ...p.perks },
    // The restart wipes every pick, so none is offered during the round-end ceasefire or a fallen run's report.
    pending: w.match.k === 'over' || w.run?.phase.k === 'over' ? null : pendingPick(p),
    ability,
    abilityReadyIn: ability ? Math.max(0, p.abilityReadyAt - w.now) : 0,
    alive: life.k === 'alive',
    dash: life.k === 'alive' ? life.dash : null,
    // A squad player who bled out waits for dawn, which the run view times.
    respawnIn: life.k === 'dead' && Number.isFinite(life.respawnAt) ? Math.max(0, Math.ceil(life.respawnAt - w.now)) : 0,
    kills: p.kills,
    deaths: p.deaths,
    viewRadius: stats.viewRadius,
  };
}

const leaderboard = (w: World): LeaderRow[] => rankRows([...w.players.values()].map((p) => ({ id: p.id, name: p.name, score: p.score, kills: p.kills, deaths: p.deaths, team: p.team })));

function matchView(w: World): MatchView {
  const untilChange = w.mapChangeAt - w.now;
  return {
    mode: w.mode,
    map: MAPS[w.map].name,
    nextMap: MAPS[nextMap(w.mode, w.map)].name,
    mapChangeIn: untilChange <= MAP_NOTICE_MS ? Math.max(0, untilChange) : 0,
    teamScore: { red: Math.floor(w.teamScore.red), blue: Math.floor(w.teamScore.blue) },
    winner: w.match.k === 'over' ? w.match.winner : null,
    restartIn: w.match.k === 'over' ? Math.max(0, w.match.restartAt - w.now) : 0,
    roundEndsAt: w.match.k === 'playing' && Number.isFinite(w.mapChangeAt) ? w.mapChangeAt : null,
  };
}

const THROWN_RADIUS: Record<ThrownKind, number> = { grenade: 10, fragGrenade: 10, gasGrenade: 10, landMine: 14, gasCloud: GAS_RADIUS };

export function snapshotFor(w: World, id: number, events: readonly GameEvent[] = w.events, aspect: number = DEFAULT_VIEW_ASPECT): Snapshot {
  const me = w.players.get(id);
  if (!me) throw new Error(`no player ${id}`);
  const stats = effectiveStats(me);
  const visible = viewExtents(stats.viewRadius, aspect);
  const halfW = visible.halfW + VIEW_PRELOAD_MARGIN, halfH = visible.halfH + VIEW_PRELOAD_MARGIN;
  const inView = (x: number, y: number, pad = 0) => Math.abs(x - me.x) <= halfW + pad && Math.abs(y - me.y) <= halfH + pad;

  const players: PlayerView[] = [];
  for (const p of w.players.values()) {
    if (p.id !== me.id) {
      if (p.life.k === 'dead' || !inView(p.x, p.y, WORLD.playerRadius)) continue;
      const seesHidden = !isEnemy(me, p) || stats.thermal || dist2(p.x, p.y, me.x, me.y) < HIDDEN_REVEAL_DIST ** 2;
      if (isHidden(w, p) && !seesHidden) continue;
    }
    players.push(playerView(w, p, me));
  }
  const bullets: BulletView[] = w.bullets
    .filter((b) => (b.turret === null || b.turret === 'bastion') && inView(b.x, b.y, 100))
    .map((b) => ({ id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, owner: b.owner, gun: b.gun }));
  const crates: CrateView[] = w.crates
    .filter((c) => c.respawnAt === null && inView(c.x, c.y, c.size))
    .map((c) => ({ id: c.id, x: c.x, y: c.y, hp: c.hp, size: c.size }));
  const thrown: ThrownView[] = w.thrown
    .filter((t) => inView(t.x, t.y, THROWN_RADIUS[t.kind]))
    .filter((t) => {
      if (t.kind !== 'landMine' || t.owner === me.id || stats.thermal) return true;
      const owner = w.players.get(t.owner);
      return !!owner && !isEnemy(me, owner);
    })
    .map((t) => ({ id: t.id, kind: t.kind, x: t.x, y: t.y, r: THROWN_RADIUS[t.kind], owner: t.owner }));
  const zones: ZoneView[] = w.zones.map((z) => ({ id: z.id, x: z.x, y: z.y, r: z.r, owner: z.owner, capturing: z.capturing, progress: z.progress }));
  const minimap: MinimapMark[] = [];
  for (const p of w.players.values()) {
    if (p.id === me.id || p.life.k !== 'alive') continue;
    if (huntedFor(w, me, p)) {
      if (p.huntedPing) minimap.push({ x: p.huntedPing.x, y: p.huntedPing.y, team: p.team, pingAge: w.now - p.huntedPing.at });
    } else if (sameTeam(me, p) || w.now < p.revealedUntil) minimap.push({ x: p.x, y: p.y, team: p.team, pingAge: null });
  }
  // A horde draws more hits than the wire can carry, so each player hears only of their own hits on zombies.
  const visibleEvents = events.filter((e) => e.e === 'kill' || e.e === 'hunted' || e.e === 'life'
    || (inView(e.x, e.y, 300) && !(e.e === 'dmg' && e.kind === 'zombie' && e.attacker !== me.id)));

  return {
    t: 'snap', tick: w.tick, ackSeq: me.seq, self: selfView(w, me),
    players, bullets, crates, thrown, zones, minimap, leaderboard: leaderboard(w), match: matchView(w), events: visibleEvents,
    ...(w.run && siegeViews(w, w.run, inView)),
  };
}

function runView(w: World, run: Run): RunView {
  const core = MAPS[w.map].siege!.core;
  const phase = run.phase;
  return {
    phase: phase.k,
    night: run.night,
    phaseEndsAt: phase.k === 'day' ? phase.endsAt : phase.k === 'over' ? phase.restartAt : Number.isFinite(phase.dawnAt) ? phase.dawnAt : null,
    scrap: Math.floor(run.scrap),
    core: { x: core.x, y: core.y, hp: Math.ceil(run.core.hp), maxHp: ZOM.coreHp },
    aliveZombies: w.zombies.length,
    waveLeft: w.zombies.length + (phase.k === 'night' ? phase.toSpawn.reduce((n, u) => n + u.n, 0) : 0),
    survivors: run.survivors,
    lost: run.lost,
    ready: [...run.ready],
    report: phase.k === 'over'
      ? {
        night: phase.night, won: phase.won, survivors: run.survivors, durationMs: phase.restartAt - ZOM.restartMs - run.startedAt, players: [...run.stats.values()].map((s) => ({ ...s })),
        turretKills: byTurret((t) => ZOMBIE_KINDS.reduce((n, z) => n + run.turretKills[t][z], 0)), bastionKills: run.bastionKills,
      }
      : null,
  };
}

function siegeViews(w: World, run: Run, inView: (x: number, y: number, pad?: number) => boolean) {
  const zombies: ZombieView[] = [];
  for (const z of w.zombies) {
    if (!inView(z.x, z.y, ZOMBIES[z.kind].radius)) continue;
    zombies.push([z.id, ZOMBIE_KINDS.indexOf(z.kind), Math.round(z.x), Math.round(z.y), tenths(z.hp, zombieMaxHp(z.kind, run.night, run.share))]);
  }
  const buildings = w.buildings.map(buildingView);
  return { zombies, buildings, run: runView(w, run) };
}
