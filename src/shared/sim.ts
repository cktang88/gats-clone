import { AIRDROP, GUNS, SUPPRESSION, WORLD, ZOM, type PlayerKind } from './defs.ts';
import type { InputState, Loadout, Team } from './protocol.ts';
import { ABILITIES, tickThrown } from './sim/abilities.ts';
import { standsOn, tickAirdrops } from './sim/airdrop.ts';
import { tickDoors } from './sim/doors.ts';
import { tickBarrels } from './sim/barrels.ts';
import { empMul, tickProps } from './sim/props.ts';
import { tickRange } from './sim/targets.ts';
import { MUZZLE_PX, spreadPick } from './sim/ballistics.ts';
import { flyThroughPast, MAX_REWIND_MS, recordPoses, tickBullets, watchCloseCalls } from './sim/combat.ts';
import { MAPS } from './maps.ts';
import { MODES, tickMatch } from './sim/modes.ts';
import { clamp, moveStep, walks } from './sim/movement.ts';
import { abilityCooldownMs, abilityOf, bloomRecoverMul, effectiveStats, freshLife, hasPerk, isDeployed, isHunted, isSteady, PERK_RULES, resetProgress, rushMul, settleShare, spreadFor, sprintWanted, easeDownTicks, easeSpread, easedSpread } from './sim/stats.ts';
import { consumePresses, pullTrigger } from './sim/trigger.ts';
import { crateRect, freshFeats, IDLE_INPUT, newId, solidRects, spawnPoint, type Bullet, type Player, type World } from './sim/world.ts';

/** An unsilenced shot gives a still ghillie away for this long (it is never a minimap mark: enemies only hear it). */
const REVEAL_MS = 2000;
const HUNTED_PING_MS = 2500;

type AddPlayerOpts = { team?: Team; at?: { x: number; y: number }; kind?: PlayerKind };

export function addPlayer(w: World, name: string, loadout: Loadout, opts: AddPlayerOpts = {}): Player {
  const team = opts.team !== undefined ? opts.team : MODES[w.mode].assignTeam(w);
  const p: Player = {
    id: newId(w), name, kind: opts.kind ?? 'bot', loadout, gun: loadout.weapon, team, x: 0, y: 0, angle: 0,
    input: IDLE_INPUT, seq: 0, viewAt: null, rewindCapMs: MAX_REWIND_MS, shotsSeen: 0, fired: 0, life: { k: 'dead', respawnAt: 0 },
    score: 0, level: 0, perks: {}, kills: 0, deaths: 0, lifeKills: 0, nemesis: null, badge: null, cos: null, chain: { count: 0, at: -Infinity }, lowAt: null, quiet: { px: 0, x: 0, y: 0, firedAt: -Infinity }, feats: freshFeats(), revealedUntil: 0, huntedPing: null, abilityReadyAt: 0, tier2Offer: [],
  };
  w.players.set(p.id, p);
  spawn(w, p, loadout, opts.at);
  return p;
}

function spawn(w: World, p: Player, loadout: Loadout, at?: { x: number; y: number }) {
  p.loadout = loadout;
  resetProgress(p, w);
  p.lifeKills = 0;
  p.feats = freshFeats();
  const pos = at ?? spawnPoint(w, p.team);
  p.x = pos.x;
  p.y = pos.y;
  p.life = freshLife(p, w.now);
}

export function removePlayer(w: World, id: number): void {
  const p = w.players.get(id);
  if (!p) return;
  // A knocked player's life has not ended in a death yet: leaving ends it, and it is paid like a standing one's.
  if (p.life.k !== 'dead') w.lifeRecords.push({ id, name: p.name, kills: p.lifeKills, score: p.score, died: false });
  w.players.delete(id);
}

export function setInput(w: World, id: number, seq: number, input: InputState, viewAt: number | null = null, rewindCapMs = MAX_REWIND_MS): void {
  const p = w.players.get(id);
  if (!p || seq < p.seq) return;
  p.seq = seq;
  p.input = input;
  p.viewAt = viewAt;
  p.rewindCapMs = rewindCapMs;
}

export function canRespawn(w: World, id: number): boolean {
  const p = w.players.get(id);
  return !!p && p.life.k === 'dead' && w.now >= p.life.respawnAt;
}

export function respawn(w: World, id: number, loadout: Loadout): boolean {
  const p = w.players.get(id);
  if (!p || !canRespawn(w, id)) return false;
  spawn(w, p, loadout);
  return true;
}

function tickPlayer(w: World, p: Player, dtMs: number) {
  const pressed = consumePresses(p, p.input.shots);
  const life = p.life;
  if (life.k === 'downed') {
    p.angle = p.input.angle;
    const m = moveStep(solidRects(w), { x: p.x, y: p.y, dash: null }, p.input, effectiveStats(p).speed * ZOM.crawlMul, dtMs, MAPS[w.map].size);
    p.x = m.x;
    p.y = m.y;
    return;
  }
  if (life.k !== 'alive') return;
  const gun = GUNS[p.gun];
  const dt = dtMs / 1000;
  const inp = p.input;
  p.angle = inp.angle;
  const moving = walks(inp) || life.dash !== null;
  if (moving) life.lastMoveAt = w.now;
  const shoved = life.knock !== null;
  if (w.now - life.suppressedAt >= SUPPRESSION.holdMs) life.suppression = Math.max(0, life.suppression - SUPPRESSION.decayPerSec * dt);
  const stats = effectiveStats(p);
  // Sprint is held while moving and not firing; a click ends it (and fires). The post-sprint bloom is full while it runs and eases out once it ends.
  const sprinting = life.dash === null && sprintWanted(inp) && !pressed;
  if (life.sprint && !sprinting) life.sprintEndAt = w.now;
  life.sprint = sprinting;
  life.settleLeft = sprinting ? stats.settleMs : Math.max(0, life.settleLeft - dtMs);
  if (moving || shoved) {
    const m = moveStep(solidRects(w), { x: p.x, y: p.y, dash: life.dash, knock: life.knock }, inp, (sprinting ? stats.sprintSpeed : stats.speed) * empMul(w, p) * rushMul(w, p), dtMs, MAPS[w.map].size);
    p.x = m.x;
    p.y = m.y;
    life.dash = m.dash;
    life.knock = m.knock ?? null;
  }

  const armed = w.match.k === 'playing';
  const wasReloading = life.reloadUntil !== null;
  const fired = pullTrigger(life, { def: gun, mag: stats.mag, reloadMs: stats.reloadMs, armed: armed && !sprinting, bloomRecover: bloomRecoverMul(p.perks) }, { pressed, fire: inp.fire, reload: inp.reload }, w.now, dtMs);
  // A fresh magazine starts the count of kills from one mag again.
  if (!wasReloading && life.reloadUntil !== null) p.feats.magKills = 0;
  // The spread eases toward its target every tick (see `easeSpread`), a shot's own bloom kick landing at once and falling bloom easing out at the gun's own pace; the shot fired this tick takes it as it stands.
  const sinceMove = moving ? 0 : w.now - life.lastMoveAt;
  const shot = fired ? life.spray : life.spray + 1;
  const spreadAt = (sprayShot: number) => spreadFor(p.gun, p.perks, isSteady(p.gun, sinceMove), sprayShot, life.suppression, settleShare(life.settleLeft, stats.settleMs), isDeployed(p.gun, sinceMove));
  const target = spreadAt(shot);
  life.spreadHist = easeSpread(life.spreadHist, target, shot > life.spreadShot && life.spreadHist.length > 0 ? target - spreadAt(life.spreadShot) : 0, spreadAt(0), easeDownTicks(p.gun));
  life.spreadShot = shot;
  if (fired) {
    life.shieldUntil = -Infinity;
    const muzzle = MUZZLE_PX;
    const spread = easedSpread(life.spreadHist);
    const rewindMs = p.viewAt === null ? 0 : clamp(w.now - p.viewAt, 0, p.rewindCapMs);
    for (let i = 0; i < gun.pellets; i++) {
      const a = p.angle + (spreadPick(p.id, p.fired, i) - 0.5) * spread * 2;
      const b: Bullet = {
        id: newId(w), owner: p.id, team: p.team, x: p.x + Math.cos(p.angle) * muzzle, y: p.y + Math.sin(p.angle) * muzzle,
        vx: Math.cos(a) * gun.bulletSpeed, vy: Math.sin(a) * gun.bulletSpeed,
        left: stats.range, damage: life.golden ? gun.damage * AIRDROP.goldMul : gun.damage, piercing: stats.piercing, label: gun.name,
        gun: p.gun, turret: null, lobbed: false, penetrate: gun.penetrate ?? 0, passed: [], blast: gun.blast ?? null, volley: w.tick,
      };
      if (flyThroughPast(w, b, rewindMs)) w.bullets.push(b);
    }
    if (!stats.silenced) {
      p.revealedUntil = w.now + REVEAL_MS;
      // A hunted player's shot pings enemy minimaps at once, unless they have Ninja (then only the timed ping finds them).
      if (isHunted(w, p) && !hasPerk(p, 'ninja')) p.huntedPing = { x: p.x, y: p.y, at: w.now };
    }
    w.events.push({ e: 'shot', x: p.x, y: p.y, angle: p.angle, silenced: stats.silenced, owner: p.id, gun: p.gun, n: p.fired });
    p.fired++;
  }

  const ability = abilityOf(p);
  // A rewound shot can kill its own shooter (a blast round on cover at point blank) before this point in the tick: the dead throw nothing.
  if (p.life.k === 'alive' && armed && inp.ability && ability && w.now >= p.abilityReadyAt && ABILITIES[ability](w, p)) {
    p.abilityReadyAt = w.now + abilityCooldownMs(ability, p.perks);
    if (p.life.k === 'alive') p.life.shieldUntil = -Infinity;
  }

  if (p.life.k === 'alive' && w.now - p.life.lastDamageAt >= stats.regenDelayMs) {
    p.life.hp = Math.min(stats.maxHp, p.life.hp + stats.regenPerSec * dt);
  }
}

function pingHunted(w: World, p: Player) {
  if (p.life.k !== 'alive' || !isHunted(w, p)) p.huntedPing = null;
  else if (!p.huntedPing || w.now - p.huntedPing.at >= HUNTED_PING_MS) p.huntedPing = { x: p.x, y: p.y, at: w.now };
}

/**
 * Players in the order a tick handles them: the roster turned by the tick count, so no player (or team, which the roster
 * interleaves by join order) always moves and fires first. The first to fire is first in `w.bullets`, which decides who lands
 * the round when two would kill each other in one tick. No rng draw, so a replay is exact.
 */
export function playersThisTick(w: World): Player[] {
  const all = [...w.players.values()];
  const turn = all.length ? w.tick % all.length : 0;
  return turn === 0 ? all : [...all.slice(turn), ...all.slice(0, turn)];
}

export function step(w: World, dtMs: number): void {
  w.events = w.queuedEvents;
  w.queuedEvents = [];
  w.now += dtMs;
  w.tick++;
  const dt = dtMs / 1000;
  for (const p of playersThisTick(w)) tickPlayer(w, p, dtMs);
  tickDoors(w, dtMs);
  for (const p of w.players.values()) pingHunted(w, p);
  tickBullets(w, dt);
  tickThrown(w, dt);
  tickBarrels(w);
  tickProps(w, dt, playersThisTick(w));
  if (w.range) tickRange(w);
  tickAirdrops(w);
  watchCloseCalls(w);
  for (const c of w.crates) {
    // Like a barrel or a prop, a crate waits for its spot to clear: standing up around a body would trap it inside.
    if (c.respawnAt !== null && w.now >= c.respawnAt && !standsOn(w, crateRect(c))) { c.respawnAt = null; c.hp = WORLD.crateHp; w.wallsVersion++; }
  }
  // The same array while nothing expires, so the lists built from it (coverRects, the wall grid's memo) hold across ticks.
  if (w.walls.some((wall) => !(w.now < wall.expiresAt))) {
    w.walls = w.walls.filter((wall) => w.now < wall.expiresAt);
    w.wallsVersion++;
  }
  tickMatch(w, dtMs);
  recordPoses(w);
}
