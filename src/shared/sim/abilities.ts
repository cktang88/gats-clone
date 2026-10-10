import { PROP_FX, WORLD, ZOMBIES, type AbilityId } from '../defs.ts';
import { MAPS } from '../maps.ts';
import { damagePlayer, explode } from './combat.ts';
import { damageZombie } from './run.ts';
import { DOT_SHARE, dotPulses } from './dot.ts';
import { burnTargets, knifeTargets } from './targets.ts';
import { nearestEdge } from '../geom.ts';
import { circleHitsRect, clamp, dist2, earliestHit, knifeLunge, segmentBlocked, startDash } from './movement.ts';
import { areFriends, coverRects, friendly, isEnemy, newId, solidRects, type Player, type Thrown, type Wall, type World } from './world.ts';
import { effectiveStats } from './stats.ts';
import type { Team } from '../protocol.ts';

/** How long a Shield stands; its cooldown (`ABILITY_COOLDOWN_MS.engineer`) is longer, so one is never up all the time. */
export const SHIELD_MS = 10_000;
export const GAS_RADIUS = 140;
/** A gas cloud's damage a second, the grenade's and the canister's alike. */
export const GAS_DPS = 14;
export const GRENADE_FUSE_MS = 900;
export const BLAST_RADIUS = { fragGrenade: 90 } as const;
const THROW_SPEED = 700;

/**
 * A claymore: set at your feet facing your aim, armed after `armMs`. An enemy (or a zombie) stepping into the cone in front of it
 * (`reach` px, `cone` radians either side of its facing) with a clear line sets it off: `pellets` balls of shrapnel fly out across
 * `spread` radians either side of its facing, each `damage` and reaching `range`, so it only hurts what is in front of it and cover
 * stops the balls. Two at a time; it lasts `lifeMs`.
 */
export const CLAYMORE = { armMs: 800, reach: 190, cone: 0.7, pellets: 16, spread: 0.75, damage: 26, range: 320, lifeMs: 60_000, max: 2 } as const;

/** Whether (x, y) is in front of claymore `t`, inside its trigger cone. */
export function inClaymoreCone(t: { x: number; y: number; angle: number }, x: number, y: number, pad = 0): boolean {
  const dx = x - t.x, dy = y - t.y, d = Math.hypot(dx, dy);
  if (d > CLAYMORE.reach + pad || d < 1) return d < 1;
  let a = Math.atan2(dy, dx) - t.angle;
  a = Math.atan2(Math.sin(a), Math.cos(a));
  return Math.abs(a) <= CLAYMORE.cone + Math.asin(Math.min(1, pad / d));
}

/** A claymore going off: its shrapnel fans out in front of it, credited to its owner. */
export function blowClaymore(w: World, t: Extract<Thrown, { kind: 'claymore' }>) {
  w.events.push({ e: 'boom', x: t.x, y: t.y, r: 40 });
  for (let i = 0; i < CLAYMORE.pellets; i++) {
    const a = t.angle + ((i + 0.5) / CLAYMORE.pellets - 0.5) * 2 * CLAYMORE.spread;
    w.bullets.push({
      id: newId(w), owner: t.owner, team: t.team, x: t.x, y: t.y, vx: Math.cos(a) * 1300, vy: Math.sin(a) * 1300,
      left: CLAYMORE.range, damage: CLAYMORE.damage, piercing: false, label: 'Claymore', gun: null, turret: null, lobbed: false, penetrate: 0, passed: [], blast: null,
    });
  }
}

/** A radar sensor: lands after `fuseMs` and tags every enemy within `radius` (through walls) on everyone's minimap for `tagMs`. */
export const RADAR = { fuseMs: 700, radius: 900, tagMs: 30_000 } as const;
/** A heal pole: planted at your feet, it heals you, your teammates and your friends within `radius` by `hps` a second, in pulses, for `lifeMs`. */
export const HEAL_POLE = { radius: 150, hps: 18, lifeMs: 8000 } as const;

/** Whether `p` is on the other side from a sensor thrown by `owner` for `team`: not its thrower, a teammate or a friend. */
const radarFoe = (w: World, owner: number, team: Team, p: Player) => p.id !== owner && !friendly(team, p) && !areFriends(w, owner, p.id);

function pulseRadar(w: World, t: { owner: number; team: Team; x: number; y: number }) {
  let n = 0;
  for (const p of w.players.values()) {
    if (p.life.k !== 'alive' || !radarFoe(w, t.owner, t.team, p) || dist2(p.x, p.y, t.x, t.y) > RADAR.radius ** 2) continue;
    p.taggedUntil = w.now + RADAR.tagMs;
    n++;
  }
  w.events.push({ e: 'radar', x: t.x, y: t.y, r: RADAR.radius, owner: t.owner, n });
}

/** A heal pole's pulse: its owner, their teammates and their friends standing within reach heal `DOT_MS` worth of it. */
function healPulse(w: World, t: Extract<Thrown, { kind: 'healPole' }>, dtMs: number) {
  const pulses = dotPulses(t.bornAt, w.now, dtMs, t.expiresAt);
  if (pulses === 0) return;
  const amount = HEAL_POLE.hps * DOT_SHARE * pulses, r2 = HEAL_POLE.radius ** 2;
  for (const p of w.players.values()) {
    if (p.life.k !== 'alive' || dist2(p.x, p.y, t.x, t.y) > r2) continue;
    if (p.id !== t.owner && !friendly(t.team, p) && !areFriends(w, t.owner, p.id)) continue;
    p.life.hp = Math.min(effectiveStats(p).maxHp, p.life.hp + amount);
  }
}

function throwGrenade(kind: 'fragGrenade' | 'gasGrenade' | 'radar', fuseMs = GRENADE_FUSE_MS) {
  return (w: World, p: Player) => {
    const travel = clamp(p.input.aimDist, 60, THROW_SPEED * (fuseMs / 1000));
    const speed = travel / (fuseMs / 1000);
    w.thrown.push({
      id: newId(w), kind, owner: p.id, team: p.team, x: p.x, y: p.y,
      vx: Math.cos(p.angle) * speed, vy: Math.sin(p.angle) * speed, explodeAt: w.now + fuseMs,
    });
    return true;
  };
}

const KNIFE_DAMAGE = 50;
const MAX_MINES = 2;

export const ABILITIES: Record<AbilityId, (w: World, p: Player) => boolean> = {
  fragGrenade: throwGrenade('fragGrenade'),
  gasGrenade: throwGrenade('gasGrenade'),
  radar: throwGrenade('radar', RADAR.fuseMs),
  healPole: (w, p) => {
    w.thrown.push({ id: newId(w), kind: 'healPole', owner: p.id, team: p.team, x: p.x, y: p.y, bornAt: w.now, expiresAt: w.now + HEAL_POLE.lifeMs });
    return true;
  },
  claymore: (w, p) => {
    const mines = w.thrown.filter((t) => t.kind === 'claymore' && t.owner === p.id);
    if (mines.length >= CLAYMORE.max) w.thrown = w.thrown.filter((t) => t !== mines[0]);
    w.thrown.push({ id: newId(w), kind: 'claymore', owner: p.id, team: p.team, x: p.x, y: p.y, angle: p.angle, armedAt: w.now + CLAYMORE.armMs, expiresAt: w.now + CLAYMORE.lifeMs });
    return true;
  },
  knife: (w, p) => {
    const targets = [
      ...[...w.players.values()].filter((v) => v.life.k === 'alive' && isEnemy(p, v)).map((v) => ({
        x: v.x, y: v.y, strike: () => damagePlayer(w, v, KNIFE_DAMAGE, { attacker: p, team: p.team, label: 'Knife', piercing: true, via: 'knife', fromX: p.x, fromY: p.y }),
      })),
      ...w.zombies.map((z) => ({ x: z.x, y: z.y, strike: () => damageZombie(w, z, KNIFE_DAMAGE, p) })),
      ...knifeTargets(w, p, KNIFE_DAMAGE),
    ];
    const { x, y, victim } = knifeLunge(solidRects(w), p, p.angle, targets, MAPS[w.map].size);
    p.x = x;
    p.y = y;
    victim?.strike();
    w.events.push({ e: 'slash', x: p.x, y: p.y, angle: p.angle, owner: p.id });
    return true;
  },
  engineer: (w, p) => {
    const cx = p.x + Math.cos(p.angle) * 80, cy = p.y + Math.sin(p.angle) * 80;
    const acrossX = Math.abs(Math.cos(p.angle)) < Math.abs(Math.sin(p.angle));
    const [ww, hh] = acrossX ? [140, 24] : [24, 140];
    // A shield: its owner's side shoots out through it, and nothing shoots back in (`roundPasses`).
    const out: [number, number] = acrossX ? [0, Math.sign(Math.sin(p.angle)) || 1] : [Math.sign(Math.cos(p.angle)) || 1, 0];
    const wall: Wall = { x: cx - ww / 2, y: cy - hh / 2, w: ww, h: hh, built: true, expiresAt: w.now + SHIELD_MS, out, ends: w.now + SHIELD_MS };
    const blocked = [...w.players.values()].some((o) => o.life.k === 'alive' && circleHitsRect(o.x, o.y, WORLD.playerRadius, wall));
    if (blocked) return false;
    w.walls.push(wall);
    w.wallsVersion++;
    return true;
  },
  dash: (w, p) => {
    if (p.life.k === 'alive') p.life.dash = startDash(p.input);
    return true;
  },
};

/** A grenade that meets a polygon's face glances off it: reflected about the face, losing most of its speed. Flat walls stop it dead. */
const BOUNCE = { keep: 0.45, slip: 0.85, standoff: 1.5 } as const;
function bounceOff(t: { x: number; y: number; vx: number; vy: number }, pts: readonly number[], at: number, dx: number, dy: number) {
  const px = t.x + dx * at, py = t.y + dy * at;
  const { nx, ny } = nearestEdge(px, py, pts);
  const vn = t.vx * nx + t.vy * ny;
  if (vn < 0) {
    const tx = t.vx - vn * nx, ty = t.vy - vn * ny;
    t.vx = tx * BOUNCE.slip - vn * nx * BOUNCE.keep;
    t.vy = ty * BOUNCE.slip - vn * ny * BOUNCE.keep;
  }
  t.x = px + nx * BOUNCE.standoff;
  t.y = py + ny * BOUNCE.standoff;
}

/** What each lingering hazard deals: damage a second over a circle, in pulses (`dotPulses`). A kill by fire is an Arsonist. */
const HAZARDS = {
  gasCloud: { radius: GAS_RADIUS, dps: GAS_DPS, label: 'Gas', medal: undefined },
  fireSlick: { radius: PROP_FX.oil.radius, dps: PROP_FX.oil.dps, label: 'Fire', medal: 'arsonist' },
} as const;

/**
 * A cloud's or slick's pulse, when one falls in this step (up to and at its last moment): everyone in it then, players, zombies and range
 * targets alike, takes `DOT_MS` worth of its damage as one hit, credited to whoever made it. Its maker is spared (as `damagePlayer` spares a
 * non-blast hit on oneself), teammates too.
 */
function burnPulse(w: World, t: Extract<Thrown, { kind: 'gasCloud' | 'fireSlick' }>, owner: Player | null, dtMs: number) {
  const pulses = dotPulses(t.bornAt, w.now, dtMs, t.expiresAt);
  if (pulses === 0) return;
  const h = HAZARDS[t.kind], amount = h.dps * DOT_SHARE * pulses, r2 = h.radius ** 2;
  for (const p of w.players.values()) {
    if (dist2(p.x, p.y, t.x, t.y) < r2) damagePlayer(w, p, amount, { attacker: owner, team: t.team, label: h.label, piercing: true, via: 'gas', ...(h.medal && { medal: h.medal }), fromX: t.x, fromY: t.y });
  }
  for (const z of w.zombies) if (dist2(z.x, z.y, t.x, t.y) < r2) damageZombie(w, z, amount, owner);
  burnTargets(w, t.x, t.y, h.radius, amount, owner, h.label);
}

export function tickThrown(w: World, dt: number) {
  const keep: Thrown[] = [];
  for (const t of w.thrown) {
    const owner = w.players.get(t.owner) ?? null;
    const by = { attacker: owner, team: t.team };
    switch (t.kind) {
      case 'fragGrenade':
      case 'gasGrenade':
      case 'radar': {
        const nx = t.x + t.vx * dt, ny = t.y + t.vy * dt;
        const block = earliestHit(coverRects(w), t.x, t.y, nx - t.x, ny - t.y);
        if (block?.b.pts) bounceOff(t, block.b.pts, block.t, nx - t.x, ny - t.y);
        else if (block) { t.vx = 0; t.vy = 0; }
        else { t.x = nx; t.y = ny; }
        if (w.now < t.explodeAt) { keep.push(t); break; }
        if (t.kind === 'radar') pulseRadar(w, t);
        else if (t.kind === 'fragGrenade') {
          explode(w, t.x, t.y, BLAST_RADIUS.fragGrenade, 40, { ...by, label: 'Frag' });
          for (let i = 0; i < 16; i++) {
            const a = (i / 16) * Math.PI * 2;
            w.bullets.push({
              id: newId(w), owner: t.owner, team: t.team, x: t.x, y: t.y, vx: Math.cos(a) * 1100, vy: Math.sin(a) * 1100,
              left: 320, damage: 18, piercing: false, label: 'Frag', gun: null, turret: null, lobbed: false, penetrate: 0, passed: [], blast: null,
            });
          }
        } else {
          w.events.push({ e: 'boom', x: t.x, y: t.y, r: 40 });
          keep.push({ id: t.id, kind: 'gasCloud', owner: t.owner, team: t.team, x: t.x, y: t.y, bornAt: w.now, expiresAt: w.now + 5000 });
        }
        break;
      }
      case 'claymore': {
        if (w.now >= t.expiresAt || owner?.life.k !== 'alive') break;
        const seen = (x: number, y: number) => !segmentBlocked(solidRects(w), t.x, t.y, x - t.x, y - t.y);
        const tripped = w.now >= t.armedAt && ([...w.players.values()].some(
          (p) => p.life.k === 'alive' && isEnemy(owner, p) && !areFriends(w, owner.id, p.id) && inClaymoreCone(t, p.x, p.y, WORLD.playerRadius) && seen(p.x, p.y),
        ) || w.zombies.some((z) => inClaymoreCone(t, z.x, z.y, ZOMBIES[z.kind].radius) && seen(z.x, z.y)));
        if (tripped) blowClaymore(w, t);
        else keep.push(t);
        break;
      }
      case 'healPole': {
        healPulse(w, t, dt * 1000);
        if (w.now < t.expiresAt) keep.push(t);
        break;
      }
      case 'gasCloud':
      case 'fireSlick': {
        burnPulse(w, t, owner, dt * 1000);
        if (w.now < t.expiresAt) keep.push(t);
        break;
      }
    }
  }
  w.thrown = keep;
}
