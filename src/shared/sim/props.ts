import { HP_MULTIPLIER, PROP_FX, PROPS, WORLD, type MedalId } from '../defs.ts';
import type { Team } from '../protocol.ts';
import { award, explode } from './combat.ts';
import { clamp, dist2, rectsOverlap, segmentEntersCircleAt, segmentEntersRectAt } from './movement.ts';
import { abilityOf, effectiveStats } from './stats.ts';
import { isEnemy, newId, propRect, propSolid, solidRects, type Player, type Prop, type World } from './world.ts';
import { MAPS } from '../maps.ts';

/** Whoever set a prop off: their id (null once they have left) is kept on it, and their team then. */
export type PropSpark = { attacker: Player | null; team: Team };

const TENTHS = 10;

/** Hurts a standing prop; at zero it goes off (see `setOff`). `dir` is the heading of the round, or away from the burst, which sets where a propane tank flies. */
export function damageProp(w: World, q: Prop, amount: number, spark: PropSpark, dir: { x: number; y: number }): void {
  if (q.respawnAt !== null || q.phase !== 'stand') return;
  q.hp = Math.max(0, q.hp - amount);
  w.events.push({ e: 'dmg', attacker: spark.attacker?.id ?? null, victim: q.id, amount: Math.round(Math.min(PROPS[q.kind].hp, amount) * 10) / 10, x: q.x, y: q.y, kind: 'crate' });
  if (q.hp > 0) return;
  q.by = { attacker: spark.attacker?.id ?? null, team: spark.team };
  setOff(w, q, spark, dir);
}

/** It goes away, and back to its spot on the map to stand again there (a propane tank bursts wherever its flight ends). */
const gone = (w: World, q: Prop) => { q.respawnAt = w.now + PROPS[q.kind].respawnMs; q.x = q.home.x; q.y = q.home.y; w.wallsVersion++; };

function setOff(w: World, q: Prop, spark: PropSpark, dir: { x: number; y: number }) {
  const owner = spark.attacker?.id ?? -1;
  switch (q.kind) {
    case 'propane': {
      const a = dir.x === 0 && dir.y === 0 ? q.id * 2.399 : Math.atan2(dir.y, dir.x);
      q.vx = Math.cos(a) * PROP_FX.propane.speed;
      q.vy = Math.sin(a) * PROP_FX.propane.speed;
      q.phase = 'active';
      q.at = w.now + PROP_FX.propane.lifeMs;
      w.wallsVersion++;
      w.events.push({ e: 'prop', kind: 'propane', k: 'launch', x: q.x, y: q.y, a: Math.round(a * 100) / 100 });
      break;
    }
    case 'gas':
      w.thrown.push({ id: newId(w), kind: 'gasCloud', owner, team: spark.team, x: q.x, y: q.y, expiresAt: w.now + PROP_FX.gas.cloudMs });
      w.events.push({ e: 'prop', kind: 'gas', k: 'pop', x: q.x, y: q.y });
      gone(w, q);
      break;
    case 'generator':
      q.phase = 'active';
      q.at = w.now + PROP_FX.generator.arcMs;
      w.events.push({ e: 'prop', kind: 'generator', k: 'arc', x: q.x, y: q.y });
      break;
    case 'oil':
      w.thrown.push({ id: newId(w), kind: 'fireSlick', owner, team: spark.team, x: q.x, y: q.y, expiresAt: w.now + PROP_FX.oil.burnMs });
      w.events.push({ e: 'prop', kind: 'oil', k: 'pop', x: q.x, y: q.y });
      gone(w, q);
      break;
    case 'lamp':
      q.phase = 'spent';
      q.at = w.now + PROPS.lamp.respawnMs;
      w.events.push({ e: 'prop', kind: 'lamp', k: 'pop', x: q.x, y: q.y });
      break;
    case 'medic':
    case 'ammo':
      q.phase = 'spent';
      q.at = w.now + PROP_FX[q.kind].packMs;
      w.wallsVersion++;
      w.events.push({ e: 'prop', kind: q.kind, k: 'pop', x: q.x, y: q.y });
      break;
    case 'paint': {
      w.events.push({ e: 'prop', kind: 'paint', k: 'pop', x: q.x, y: q.y, c: spark.attacker?.loadout.color ?? 'orange' });
      const a = spark.attacker;
      if (a && [...w.players.values()].some((p) => p.life.k === 'alive' && isEnemy(a, p) && dist2(p.x, p.y, q.x, q.y) < (PROP_FX.paint.picassoPx + WORLD.playerRadius) ** 2)) award(w, a, 'picasso');
      gone(w, q);
      break;
    }
  }
}

const attackerOf = (w: World, q: Prop): Player | null => (q.by?.attacker == null ? null : w.players.get(q.by.attacker) ?? null);

function blowPropane(w: World, q: Prop) {
  const F = PROP_FX.propane;
  explode(w, q.x, q.y, F.radius, F.damage, { attacker: attackerOf(w, q), team: q.by?.team ?? null, label: 'Propane', medal: 'liftoff' });
  gone(w, q);
}

/** The rocketing tank skids along its heading, bleeding speed, and bursts on the first wall, body or prop in its way, or when its time or speed runs out. */
function flyPropane(w: World, q: Prop, dt: number) {
  const F = PROP_FX.propane;
  const drag = Math.exp(-F.drag * dt);
  q.vx *= drag;
  q.vy *= drag;
  const dx = q.vx * dt, dy = q.vy * dt;
  let t = 1;
  const grow = F.body;
  for (const r of solidRects(w)) {
    const hit = segmentEntersRectAt(q.x, q.y, dx, dy, { x: r.x - grow, y: r.y - grow, w: r.w + 2 * grow, h: r.h + 2 * grow });
    if (hit !== null && hit < t) t = hit;
  }
  for (const p of w.players.values()) {
    if (p.life.k !== 'alive') continue;
    const hit = segmentEntersCircleAt(q.x, q.y, dx, dy, p.x, p.y, WORLD.playerRadius + F.body);
    if (hit !== null && hit < t) t = hit;
  }
  const size = MAPS[w.map].size;
  const nx = q.x + dx * t, ny = q.y + dy * t;
  q.x = clamp(nx, F.body, size - F.body);
  q.y = clamp(ny, F.body, size - F.body);
  if (t < 1 || q.x !== nx || q.y !== ny || w.now >= q.at || Math.hypot(q.vx, q.vy) < 70) blowPropane(w, q);
}

function pulse(w: World, q: Prop) {
  const F = PROP_FX.generator;
  for (const p of w.players.values()) {
    if (p.life.k !== 'alive' || dist2(p.x, p.y, q.x, q.y) > (F.radius + WORLD.playerRadius) ** 2) continue;
    w.emps.set(p.id, { until: w.now + F.slowMs, by: q.by?.attacker ?? null });
    p.abilityReadyAt = Math.max(p.abilityReadyAt, w.now + F.lockMs);
  }
  w.events.push({ e: 'prop', kind: 'generator', k: 'emp', x: q.x, y: q.y, r: F.radius });
  gone(w, q);
}

/**
 * Gives pack `q` to `p` if they need it, and says what they got (a `gain` event, only the rounds and health that landed). A health pack
 * is not taken at full health, and an ammo pack not with a full magazine and the ability ready: it stays for whoever does need it.
 */
function takePack(w: World, q: Prop, p: Player): boolean {
  const life = p.life;
  if (life.k !== 'alive') return false;
  const stats = effectiveStats(p);
  if (q.kind === 'medic') {
    if (life.hp >= stats.maxHp - 1) return false;
    const was = life.hp;
    // In the player's own scale: a person's health counts `HP_MULTIPLIER` times a bot's, so their pack does too (the same share of either).
    life.hp = Math.min(stats.maxHp, life.hp + PROP_FX.medic.heal * HP_MULTIPLIER[p.kind]);
    w.events.push({ e: 'gain', id: p.id, from: 'medic', hp: Math.round(life.hp - was) });
  } else {
    const cooling = w.now < p.abilityReadyAt;
    if (life.ammo >= stats.mag && !cooling) return false;
    const rounds = Math.max(0, stats.mag - life.ammo);
    life.ammo = stats.mag;
    life.reloadUntil = null;
    p.abilityReadyAt = Math.min(p.abilityReadyAt, w.now);
    w.events.push({ e: 'gain', id: p.id, from: 'ammo', ...(rounds > 0 && { ammo: rounds }), ...(cooling && abilityOf(p) !== null && { ability: true as const }) });
  }
  w.events.push({ e: 'prop', kind: q.kind, k: 'pick', x: q.x, y: q.y });
  gone(w, q);
  return true;
}

/** A pack on the floor goes to the first player who walks over it and needs it, in the tick's turn order, so no one always wins a tie. */
function tryPickup(w: World, q: Prop, order: readonly Player[]) {
  const R = PROP_FX[q.kind as 'medic' | 'ammo'].pickR;
  for (const p of order) {
    if (p.life.k !== 'alive' || dist2(p.x, p.y, q.x, q.y) > R * R) continue;
    if (takePack(w, q, p)) return;
  }
}

/**
 * E at a standing cabinet: the first player within `openR` pressing use opens it, as a shot would (it is theirs), and takes the pack at once
 * if they need it; if not, the pack lies for whoever does. Space, the ability, opens nothing.
 */
function tryOpen(w: World, q: Prop, order: readonly Player[]) {
  const R = PROP_FX[q.kind as 'medic' | 'ammo'].openR;
  for (const p of order) {
    if (p.life.k !== 'alive' || !p.input.use || dist2(p.x, p.y, q.x, q.y) > R * R) continue;
    q.hp = 0;
    q.by = { attacker: p.id, team: p.team };
    setOff(w, q, { attacker: p, team: p.team }, { x: q.x - p.x, y: q.y - p.y });
    takePack(w, q, p);
    return;
  }
}

export function tickProps(w: World, dt: number, order: readonly Player[] = [...w.players.values()]) {
  for (const q of w.props) {
    if (q.respawnAt !== null) {
      const stood = [...w.players.values()].some((p) => p.life.k !== 'dead' && rectsOverlap(propRect(q), { x: p.x, y: p.y, w: 0, h: 0 }, WORLD.playerRadius));
      if (w.now >= q.respawnAt && !stood) { q.respawnAt = null; q.phase = 'stand'; q.hp = PROPS[q.kind].hp; q.vx = 0; q.vy = 0; q.by = null; w.wallsVersion++; }
    } else if (q.phase === 'stand') {
      if (q.kind === 'medic' || q.kind === 'ammo') tryOpen(w, q, order);
    } else if (q.phase === 'active') {
      if (q.kind === 'propane') flyPropane(w, q, dt);
      else if (q.kind === 'generator' && w.now >= q.at) pulse(w, q);
    } else if (q.phase === 'spent') {
      if (q.kind === 'lamp') {
        if (w.now >= q.at) { q.phase = 'stand'; q.hp = PROPS.lamp.hp; q.by = null; w.events.push({ e: 'prop', kind: 'lamp', k: 'relight', x: q.x, y: q.y }); }
      } else {
        tryPickup(w, q, order);
        if (q.respawnAt === null && w.now >= q.at) gone(w, q);
      }
    }
  }
  for (const [id, e] of w.emps) if (w.now >= e.until || w.players.get(id)?.life.k !== 'alive') w.emps.delete(id);
}

/** Standing props a blast at (x, y) reaches within `radius`, each with its distance from the burst. */
export function propsInBlast(w: World, x: number, y: number, radius: number): { q: Prop; d: number }[] {
  const out: { q: Prop; d: number }[] = [];
  for (const q of w.props) {
    if (q.phase !== 'stand' || !propSolid(q)) continue;
    const r = propRect(q);
    const d = Math.sqrt(dist2(x, y, clamp(x, r.x, r.x + r.w), clamp(y, r.y, r.y + r.h)));
    if (d < radius) out.push({ q, d });
  }
  return out;
}

/** The share of speed an EMP leaves `p` right now: 1 when they are not shocked. */
export const empMul = (w: World, p: Player): number => { const e = w.emps.get(p.id); return e && w.now < e.until ? PROP_FX.generator.slowMul : 1; };

/** The prop medals a kill earns: the one its damage carried (`medal`, not for the killer's own death), and Shock Therapy when the generator that has the victim shocked is the killer's. */
export function propMedals(w: World, killer: Player, victim: Player, medal: MedalId | undefined, own: boolean): MedalId[] {
  if (!own || killer.id === victim.id) return [];
  const out: MedalId[] = medal ? [medal] : [];
  const e = w.emps.get(victim.id);
  if (e && e.by === killer.id && w.now < e.until) out.push('shockTherapy');
  return out;
}

/** Props are tenths of full health on the wire; 0 while a tank flies or a generator arcs, 11 when spent (a dark lamp, a pack on the floor). */
export const propState = (q: Prop): number => (q.phase === 'active' ? 0 : q.phase === 'spent' ? TENTHS + 1 : Math.max(1, Math.ceil((q.hp / PROPS[q.kind].hp) * TENTHS)));
