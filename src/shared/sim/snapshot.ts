import { ARMORS, BARREL, byTurret, PROP_FX, PROP_KINDS, LOOT, ROYALE, STREAK, TOWER, WORLD, ZOM, ZOMBIE_KINDS, ZOMBIES } from '../defs.ts';
import type {
  AirdropView, BarrelView, PropView, BulletView, CrateView, GameEvent, LeaderRow, CacheView, FloorArmorView, FloorGunView, MatchView, MinimapMark, PlayerView, RoyaleView, RunView, SelfView, Snapshot, ThrownKind, ThrownView, WallView, ZombieView, ZoneView,
} from '../protocol.ts';
import { rankRows, DEFAULT_VIEW_ASPECT, VIEW_PRELOAD_MARGIN, viewExtents } from '../protocol.ts';
import { lookReach, lookSides, NO_LOOK, type LookSides } from '../lookahead.ts';
import { MAP_NOTICE_MS, MAPS, nextMap } from '../maps.ts';
import { GAS_RADIUS, HEAL_POLE } from './abilities.ts';
import { doorViews } from './doors.ts';
import { heardShots } from './hearing.ts';
import { empMul, propState } from './props.ts';
import { armorByte, packViews } from './packs.ts';
import { dist2 } from './movement.ts';
import { abilityOf, effectiveStats, hasPerk, isHunted, pendingPick, rushMul } from './stats.ts';
import { zombieMaxHp } from './run.ts';
import { rangeView, targetViews } from './targets.ts';
import { buildingView, tenths } from './build.ts';
import { redeploysOpen, resultFor, ringView, stillIn } from './royale.ts';
import { areFriends, isEnemy, sameTeam, type Player, type Royale, type Run, type World } from './world.ts';

const GHILLIE_STILL_MS = 600;
const HIDDEN_REVEAL_DIST = 140;

/** The walls on the wire: map walls, polygon parts and built walls; door leaves are rebuilt by the client from the map and `Snapshot.doors`. */
export function wallViews(w: World): WallView[] {
  return w.walls.filter((wall) => wall.door === undefined).map(({ expiresAt: _, door: __, ...view }) => view);
}

function isHidden(w: World, p: Player): boolean {
  return p.life.k === 'alive' && !isHunted(w, p) && effectiveStats(p).ghillie && w.now - p.life.lastMoveAt >= GHILLIE_STILL_MS && w.now >= p.revealedUntil;
}

/** Hunted as `me` sees it: an enemy holding a stage-2 gun, or me holding one. A teammate's never reads as a threat. */
const huntedFor = (w: World, me: Player, p: Player) => isHunted(w, p) && (p.id === me.id || isEnemy(me, p));

/** `[elapsedMs, totalMs]` through a reload that ends at `until`, whole ms, clamped into the reload. */
export function reloadClock(until: number, now: number, total: number): [number, number] {
  const t = Math.max(1, Math.round(total));
  return [Math.min(t, Math.max(0, Math.round(t - (until - now)))), t];
}

function playerView(w: World, p: Player, me: Player): PlayerView {
  const life = p.life;
  const stats = effectiveStats(p);
  const alive = life.k === 'alive';
  return {
    id: p.id, name: p.name, x: p.x, y: p.y, angle: p.angle,
    hp: life.k === 'dead' ? 0 : Math.ceil(life.hp), maxHp: stats.maxHp,
    color: p.loadout.color, gun: p.gun, team: p.team,
    alive, hidden: isHidden(w, p), shield: stats.shield, dashing: alive && life.dash !== null,
    score: p.score, level: p.level, armorTier: p.loadout.armor, kind: p.kind, hunted: huntedFor(w, me, p),
    ...(alive && life.armor < ARMORS[p.loadout.armor].points && { ap: armorByte(life.armor, ARMORS[p.loadout.armor].points) }),
    ...(alive && !w.run && w.now < life.shieldUntil && { spawnShield: true as const }),
    ...(alive && p.lifeKills >= STREAK.showAt && { streak: p.lifeKills }),
    ...(alive && life.golden && { golden: true as const }),
    ...(alive && empMul(w, p) < 1 && { emp: true as const }),
    ...(alive && life.sprint && !hasPerk(p, 'ninja') && { sprint: true as const }),
    ...(alive && rushMul(w, p) > 1 && { rush: true as const }),
    ...(alive && life.reloadUntil !== null && isEnemy(me, p) && hasPerk(me, 'recon') && { reloading: true as const }),
    ...(alive && life.reloadUntil !== null && { rl: reloadClock(life.reloadUntil, w.now, stats.reloadMs) }),
    ...(p.badge && { badge: p.badge }),
    ...(p.cos && { cos: p.cos }),
    ...(life.k === 'downed' && { downed: { revive: life.reviveProgress / ZOM.reviveMs, bleedOutAt: life.bleedOutAt } }),
  };
}

function selfView(w: World, p: Player): SelfView {
  const life = p.life;
  const stats = effectiveStats(p);
  const ability = abilityOf(p);
  return {
    id: p.id,
    ...(life.k === 'alive' && w.now < p.taggedUntil && { tagged: Math.ceil((p.taggedUntil - w.now) / 1000) }),
    ammo: life.k === 'alive' ? life.ammo : 0,
    mag: stats.mag,
    speed: stats.speed * empMul(w, p) * rushMul(w, p),
    sprint: life.k === 'alive' && life.sprint,
    sprintSpeed: stats.sprintSpeed * empMul(w, p) * rushMul(w, p),
    // The share of the post-sprint bloom still to ease out, rounded up so a client never draws the reticle tighter than the server's.
    settle: life.k === 'alive' && stats.settleMs > 0 ? Math.max(0, Math.ceil((life.settleLeft / stats.settleMs) * 100 - 1e-9) / 100) : 0,
    settleMs: Math.round(stats.settleMs),
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
    knock: life.k === 'alive' ? life.knock : null,
    // A squad player who bled out waits for dawn, which the run view times.
    respawnIn: life.k === 'dead' && Number.isFinite(life.respawnAt) ? Math.max(0, Math.ceil(life.respawnAt - w.now)) : 0,
    kills: p.kills,
    deaths: p.deaths,
    viewRadius: stats.viewRadius,
    suppression: life.k === 'alive' ? Math.round(life.suppression * 100) / 100 : 0,
    fired: p.fired,
    streak: p.lifeKills,
    nemesis: p.nemesis,
  };
}

const leaderboard = (w: World): LeaderRow[] => rankRows([...w.players.values()].map((p) => ({ id: p.id, name: p.name, score: p.score, kills: p.kills, deaths: p.deaths, team: p.team, ...(p.kind === 'human' && { human: true as const }) })));

function matchView(w: World): MatchView {
  const untilChange = w.mapChangeAt - w.now;
  return {
    mode: w.mode,
    map: MAPS[w.map].name,
    nextMap: MAPS[nextMap(w).map].name,
    mapChangeIn: untilChange <= MAP_NOTICE_MS ? Math.max(0, untilChange) : 0,
    teamScore: { red: Math.floor(w.teamScore.red), blue: Math.floor(w.teamScore.blue) },
    winner: w.match.k === 'over' ? w.match.winner : null,
    restartIn: w.match.k === 'over' ? Math.max(0, w.match.restartAt - w.now) : 0,
    roundEndsAt: w.match.k === 'playing' && Number.isFinite(w.mapChangeAt) ? w.mapChangeAt : null,
  };
}

const barrelViews = (w: World): BarrelView[] => w.barrels.filter((b) => b.respawnAt === null).map((b) => [b.id, Math.round(b.x), Math.round(b.y), b.fuseAt !== null ? 0 : Math.max(1, Math.ceil((b.hp / BARREL.hp) * 10))]);

const propViews = (w: World): PropView[] => w.props.filter((q) => q.respawnAt === null).map((q) => [q.id, PROP_KINDS.indexOf(q.kind), Math.round(q.x), Math.round(q.y), propState(q)]);

const airdropView = (w: World): AirdropView | null => {
  const f = w.airdrops.flight;
  return f && { x: Math.round(f.x), y: Math.round(f.y), a: Math.round(f.a * 100) / 100, dropAt: Math.round(f.dropAt), landAt: Math.round(f.landAt) };
};

const THROWN_RADIUS: Record<ThrownKind, number> = { fragGrenade: 10, gasGrenade: 10, claymore: 14, gasCloud: GAS_RADIUS, fireSlick: PROP_FX.oil.radius, radar: 10, healPole: HEAL_POLE.radius };

/**
 * How far `me`'s camera may lean toward their aim this tick (lookahead.ts): the full lean along their angle while they are alive and
 * watching themselves, none while they are down, dead or watching a squadmate (the client leans only for a live soldier of its own).
 */
export function interestLook(w: World, me: Player): LookSides {
  if (me.life.k !== 'alive' || w.royale?.watching.has(me.id)) return NO_LOOK;
  return lookSides(me.angle, lookReach(effectiveStats(me).viewRadius, me.gun));
}

/**
 * `look` widens the interest rectangle past the aimed edges (the room holds it per client with `holdLook`), so an enemy that only the
 * camera's aim look-ahead brings on screen is sent; hiding still culls it. Bots and the replay see by the centred view.
 */
export function snapshotFor(w: World, id: number, events: readonly GameEvent[] = w.events, aspect: number = DEFAULT_VIEW_ASPECT, look: LookSides = NO_LOOK): Snapshot {
  const me = w.players.get(id);
  if (!me) throw new Error(`no player ${id}`);
  const stats = effectiveStats(me);
  const visible = viewExtents(stats.viewRadius, aspect);
  const halfW = visible.halfW + VIEW_PRELOAD_MARGIN, halfH = visible.halfH + VIEW_PRELOAD_MARGIN;
  const eye = w.players.get(w.royale?.watching.get(me.id) ?? -1) ?? me;
  const inView = (x: number, y: number, pad = 0) => {
    const dx = x - eye.x, dy = y - eye.y;
    return dx <= halfW + look.r + pad && -dx <= halfW + look.l + pad && dy <= halfH + look.d + pad && -dy <= halfH + look.u + pad;
  };

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
    .map((c) => ({ id: c.id, x: c.x, y: c.y, hp: c.hp, size: c.size, ...(c.drop && { drop: true as const }) }));
  const thrown: ThrownView[] = w.thrown
    .filter((t) => inView(t.x, t.y, THROWN_RADIUS[t.kind]))
    .filter((t) => {
      if (t.kind !== 'claymore' || t.owner === me.id || stats.thermal) return true;
      const owner = w.players.get(t.owner);
      return !!owner && !isEnemy(me, owner);
    })
    .map((t) => ({ id: t.id, kind: t.kind, x: t.x, y: t.y, r: THROWN_RADIUS[t.kind], owner: t.owner, ...(t.kind === 'claymore' && { angle: Math.round(t.angle * 100) / 100 }) }));
  const zones: ZoneView[] = w.zones.map((z) => ({ id: z.id, x: z.x, y: z.y, r: z.r, owner: z.owner, capturing: z.capturing, progress: z.progress, ...(z.crew > 0 && { crew: z.crew }), ...(z.contested && { contested: true as const }) }));
  const minimap: MinimapMark[] = [];
  for (const p of w.players.values()) {
    if (p.id === me.id || p.life.k !== 'alive') continue;
    const marked = me.life.k === 'alive' && w.now < (me.life.tracks[p.id] ?? -Infinity);
    if (marked) minimap.push({ x: p.x, y: p.y, team: p.team, pingAge: null, marked: true });
    else if (huntedFor(w, me, p)) {
      if (p.huntedPing) minimap.push({ x: p.huntedPing.x, y: p.huntedPing.y, team: p.team, pingAge: w.now - p.huntedPing.at });
    // Enemies are not on the minimap just for firing: only a Tracker mark or a hunted ping shows one (teammates and friends always show).
    } else if (areFriends(w, me.id, p.id)) minimap.push({ x: p.x, y: p.y, team: p.team, pingAge: null, friend: true });
    else if (sameTeam(me, p)) minimap.push({ x: p.x, y: p.y, team: p.team, pingAge: null });
    // A radar tag shows the tagged player to everyone not on their side, wherever they go, until it runs out.
    else if (w.now < p.taggedUntil) minimap.push({ x: p.x, y: p.y, team: p.team, pingAge: null, tagged: true });
  }
  // A horde draws more hits than the wire can carry, so each player hears only of their own hits on zombies.
  // A medal, and what a pickup gave, is news only to the player who earned it.
  const visibleEvents = events.filter((e) => e.e === 'kill' || e.e === 'airdrop' || e.e === 'hunted' || e.e === 'life' || e.e === 'wiped' || (e.e === 'medal' && e.id === me.id) || (e.e === 'gain' && e.id === me.id)
    || (e.e === 'radar' && inView(e.x, e.y, e.r))
    || (e.e !== 'medal' && e.e !== 'gain' && inView(e.x, e.y, 300) && !(e.e === 'dmg' && e.kind === 'zombie' && e.attacker !== me.id)));

  return {
    t: 'snap', tick: w.tick, ackSeq: me.seq, self: selfView(w, me),
    players, bullets, crates, thrown, zones, minimap, leaderboard: leaderboard(w), match: matchView(w), events: visibleEvents,
    barrels: barrelViews(w), props: propViews(w), airdrop: airdropView(w),
    ...(w.packs.length && { packs: packViews(w) }),
    ...(MAPS[w.map].doors?.length && { doors: doorViews(w).filter(([i]) => { const d = MAPS[w.map].doors![i]!; return inView(d.x + (d.axis === 'h' ? d.w / 2 : 0), d.y + (d.axis === 'v' ? d.w / 2 : 0), d.w + 300); }) }),
    ...(w.run && siegeViews(w, w.run, inView)),
    ...(w.royale && { royale: royaleView(w, w.royale, me) }),
    ...(w.range && { targets: targetViews(w), range: rangeView(w, me.id) }),
    ...(me.kind === 'bot' && { heard: heardShots(w, me, events) }),
  };
}

function royaleView(w: World, r: Royale, me: Player): RoyaleView {
  const half = ROYALE.dropSize / 2;
  return {
    ring: ringView(r.ring),
    redeploys: redeploysOpen(r),
    round: r.startedAt,
    alive: stillIn(r).length,
    total: r.entrants.length,
    redeployAt: r.redeployAt.get(me.id) ?? null,
    drops: [
      ...r.drops.filter((d) => d.landsAt - w.now <= ROYALE.dropNoticeMs),
      ...w.crates.filter((c) => c.drop && c.respawnAt === null).map((c) => ({ x: c.x + half, y: c.y + half, landsAt: 0 })),
    ],
    watch: r.watching.get(me.id) ?? null,
    result: resultFor(w, r, me),
    caches: r.caches.map((c): CacheView => [
      c.id, Math.round(c.x), Math.round(c.y), c.tier, c.open ? 1 : 0,
      !c.open && c.by != null ? Math.round(Math.min(1, (w.now - (c.since ?? w.now)) / LOOT.openMs) * 50) / 50 : 0, c.gun ? 1 : 0,
    ]),
    guns: r.guns.map((g): FloorGunView => [g.id, Math.round(g.x), Math.round(g.y), g.gun]),
    armors: r.armors.map((a): FloorArmorView => [a.id, Math.round(a.x), Math.round(a.y), a.tier]),
    towers: r.towers.map((t) => ({
      x: Math.round(t.x), y: Math.round(t.y), readyAt: w.now < t.readyAt ? t.readyAt : 0,
      ...(t.holder !== null && { holder: t.holder, progress: Math.round(Math.min(1, (w.now - t.since) / TOWER.holdMs) * 20) / 20 }),
    })),
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
        night: phase.night, won: phase.won, survivors: run.survivors, durationMs: phase.restartAt - ZOM.restartMs - run.startedAt, players: [...run.stats.values()].map(({ name, kills, revives, built }) => ({ name, kills, revives, built })),
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
  const buildings = [...w.buildings, ...w.floor].map(buildingView);
  return { zombies, buildings, run: runView(w, run) };
}
