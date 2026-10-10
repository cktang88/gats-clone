import { ARMOR_IDS, GUNS, GUN_IDS, PERK_TIERS, PROPS, BARREL, type ArmorId, type GunId, type PerkId, type Tier } from '../defs.ts';
import { MAPS } from '../maps.ts';
import { RANGE, TARGETS, targetBody, targetPos, type RangeView, type TargetDef, type TargetView } from '../range.ts';
import { explode } from './combat.ts';
import { blowClaymore, inClaymoreCone } from './abilities.ts';
import { dist2, segmentEntersCapsuleAt } from './movement.ts';
import { effectiveStats } from './stats.ts';
import type { Player, World } from './world.ts';

/**
 * The shooting range's simulation (mode `RNG`). Targets hang off `World.range`, which only a Range world has, so every other
 * mode runs exactly as before: nothing here touches the world's random stream or its ids.
 *
 * A target is hurt through the same paths as anything else: a round meets it in `moveBullet`, a blast in `explode`, gas and
 * fire here in `tickRange`, a knife through the ability. When one drops it lies `RANGE.regenMs`, then stands again whole.
 */
export type Target = {
  /** `RANGE.idBase` plus its place in the layout, which is also the place the snapshot lists its health. */
  id: number;
  def: TargetDef;
  x: number; y: number;
  hp: number;
  maxHp: number;
  /** Set while it lies knocked down: when it stands again. */
  respawnAt: number | null;
  /** When it was first hurt in the fight it is in, and last hurt, for the time to kill and the heal. */
  firstHitAt: number;
  lastHitAt: number;
};

export type RangeStats = {
  hits: { at: number; dmg: number }[];
  last: RangeView['last'];
  shots: number;
  hitShots: number;
  ttk: RangeView['ttk'];
  downs: number;
  total: number;
  /** The trigger pulls that already counted as a hit (`pid:volley`), oldest first, so a shotgun's eight pellets are one hit. */
  counted: Set<number>;
};

export type RangeSim = { targets: Target[]; stats: Map<number, RangeStats> };

export const freshStats = (): RangeStats => ({ hits: [], last: null, shots: 0, hitShots: 0, ttk: null, downs: 0, total: 0, counted: new Set() });

export function newRange(w: World): RangeSim {
  const layout = MAPS[w.map].range;
  const targets = (layout?.targets ?? []).map((def, i): Target => {
    const hp = TARGETS[def.kind].hp, at = targetPos(def, w.now);
    return { id: RANGE.idBase + i, def, x: at.x, y: at.y, hp, maxHp: hp, respawnAt: null, firstHitAt: -Infinity, lastHitAt: -Infinity };
  });
  return { targets, stats: new Map() };
}

const statsOf = (r: RangeSim, pid: number): RangeStats => {
  let s = r.stats.get(pid);
  if (!s) r.stats.set(pid, (s = freshStats()));
  return s;
};

const round1 = (v: number) => Math.round(v * 10) / 10;
const standing = (t: Target) => t.respawnAt === null;

/** What lands on a target: who, with what, from which round (`volley`, so a shotgun blast counts once), and whether it is a slow burn (gas, fire), which the readout leaves out of "last hit". */
export type TargetBlow = { attacker: Player | null; label: string; volley?: number; burn?: boolean };

/** Hurts a standing target at `at` (where it stood when the round met it, which a lagged shot judges in the past). At zero it falls. */
export function damageTarget(w: World, t: Target, amount: number, by: TargetBlow, at: { x: number; y: number } = t): void {
  const r = w.range;
  if (!r || !standing(t) || amount <= 0) return;
  const dealt = Math.min(t.hp, amount);
  if (w.now - t.lastHitAt > RANGE.healMs || t.hp >= t.maxHp) t.firstHitAt = w.now;
  t.lastHitAt = w.now;
  t.hp -= amount;
  const a = by.attacker;
  const s = a ? statsOf(r, a.id) : null;
  if (a && s) {
    s.total += dealt;
    s.hits.push({ at: w.now, dmg: dealt });
    if (!by.burn) {
      s.last = { dmg: round1(dealt), dist: Math.round(Math.hypot(at.x - a.x, at.y - a.y)), at: w.now };
      if (by.volley !== undefined) {
        const key = a.id * 1_000_000_007 + by.volley;
        if (!s.counted.has(key)) {
          s.counted.add(key);
          s.hitShots++;
          if (s.counted.size > 256) s.counted.delete(s.counted.values().next().value!);
        }
      }
    }
  }
  w.events.push({ e: 'dmg', attacker: a?.id ?? null, victim: t.id, amount: round1(dealt), x: at.x, y: at.y, kind: 'target' });
  if (t.hp > 0) return;
  t.hp = 0;
  t.respawnAt = w.now + RANGE.regenMs;
  if (s && a) {
    s.downs++;
    s.ttk = { ms: Math.max(1, Math.round(w.now - t.firstHitAt)), dist: Math.round(Math.hypot(at.x - a.x, at.y - a.y)), kind: t.def.kind };
  }
  w.events.push({ e: 'target', i: t.id - RANGE.idBase, k: 'down', by: a?.id ?? null, x: at.x, y: at.y });
}

function standUp(w: World, t: Target) {
  t.hp = t.maxHp;
  t.respawnAt = null;
  t.firstHitAt = -Infinity;
  w.events.push({ e: 'target', i: t.id - RANGE.idBase, k: 'up', by: null, x: t.x, y: t.y });
}

/**
 * The hits a round flying from (`b.x`, `b.y`) by (`dx`, `dy`) would make on standing targets, as `moveBullet` weighs them; `at` is the time the shooter saw, for a sliding target, and `fell` what the round keeps of its damage at the hit point (its gun's falloff, as a body takes it).
 * The step took `stepMs`, over which a slider moved: the round meets it where it slides through the step, not frozen where the step ends;
 * `span` is the share of the step the round flies (less than all of it when it dies mid-step).
 */
export function targetHits(
  w: World, b: { x: number; y: number; damage: number; label: string; volley?: number; passed: readonly number[] }, dx: number, dy: number, owner: Player | null, at: number = w.now,
  fell: (x: number, y: number) => number = () => 1, stepMs = 0, span = 1,
): { t: number | null; victim: { id: number }; apply: (x: number, y: number) => void }[] {
  const r = w.range;
  if (!r) return [];
  const out: { t: number | null; victim: { id: number }; apply: (x: number, y: number) => void }[] = [];
  for (const t of r.targets) {
    if (!standing(t) || b.passed.includes(t.id)) continue;
    const p = targetPos(t.def, at), was = targetPos(t.def, at - stepMs);
    const body = targetBody(t.def.kind, was);
    const hit = segmentEntersCapsuleAt(b.x, b.y, dx - (p.x - was.x) * span, dy - (p.y - was.y) * span, body.x, body.y, body.up, body.r);
    if (hit === null) continue;
    out.push({ t: hit, victim: { id: t.id }, apply: (x: number, y: number) => damageTarget(w, t, b.damage * fell(x, y), { attacker: owner, label: b.label, ...(b.volley !== undefined && { volley: b.volley }) }, p) });
  }
  return out;
}

/** A blast at (x, y): every standing target within `radius` of its edge takes the blast's falloff, unless `sheltered` says a wall is between. */
export function blastTargets(w: World, x: number, y: number, radius: number, maxDamage: number, attacker: Player | null, label: string, sheltered: (tx: number, ty: number) => boolean): void {
  const r = w.range;
  if (!r) return;
  for (const t of r.targets) {
    if (!standing(t)) continue;
    const tr = TARGETS[t.def.kind].r;
    const d = Math.sqrt(dist2(t.x, t.y, x, y));
    if (d > radius + tr || sheltered(t.x, t.y)) continue;
    damageTarget(w, t, maxDamage * (1 - Math.max(0, d - tr) / radius), { attacker, label });
  }
}

/** A knife's reach: each standing target as a point to lunge at, with the blow it takes. */
export function knifeTargets(w: World, p: Player, damage: number): { x: number; y: number; strike: () => void }[] {
  return (w.range?.targets ?? []).filter(standing).map((t) => ({ x: t.x, y: t.y, strike: () => damageTarget(w, t, damage, { attacker: p, label: 'Knife' }) }));
}

/** Health of each target in layout order: tenths 1..10 standing, 0 knocked down. */
export const targetViews = (w: World): TargetView[] => (w.range?.targets ?? []).map((t) => (standing(t) ? Math.max(1, Math.ceil((t.hp / t.maxHp) * 10)) : 0));

export function rangeView(w: World, pid: number): RangeView {
  const s = w.range?.stats.get(pid) ?? freshStats();
  const from = w.now - RANGE.dpsWindowMs;
  while (s.hits.length && s.hits[0]!.at < from) s.hits.shift();
  const dps = s.hits.reduce((n, h) => n + h.dmg, 0) / (RANGE.dpsWindowMs / 1000);
  return { last: s.last, dps: Math.round(dps * 10) / 10, shots: s.shots, hits: s.hitShots, ttk: s.ttk, downs: s.downs, total: Math.round(s.total) };
}

/** A mine goes off under a target (gas and fire burn them in `burnTargets`), targets stand again, barrels and props come back, and the range keeps its one player at level 0. */
/** A gas cloud's or burning slick's pulse on the range: every standing target within `radius` of (x, y) takes `amount` as one hit. */
export function burnTargets(w: World, x: number, y: number, radius: number, amount: number, attacker: Player | null, label: string): void {
  if (!w.range) return;
  for (const t of w.range.targets) if (standing(t) && dist2(t.x, t.y, x, y) < radius * radius) damageTarget(w, t, amount, { attacker, label, burn: true });
}

export function tickRange(w: World): void {
  const r = w.range;
  if (!r) return;
  for (const t of r.targets) {
    const at = targetPos(t.def, w.now);
    t.x = at.x;
    t.y = at.y;
    if (t.respawnAt !== null) { if (w.now >= t.respawnAt) standUp(w, t); }
    else if (t.hp < t.maxHp && w.now - t.lastHitAt >= RANGE.healMs) { t.hp = t.maxHp; t.firstHitAt = -Infinity; }
  }
  for (const th of w.thrown) {
    const owner = w.players.get(th.owner) ?? null;
    if (th.kind === 'claymore' && w.now >= th.armedAt && owner?.life.k === 'alive') {
      const tripped = r.targets.some((t) => standing(t) && inClaymoreCone(th, t.x, t.y, TARGETS[t.def.kind].r));
      if (tripped) {
        w.thrown = w.thrown.filter((o) => o !== th);
        blowClaymore(w, th);
      }
    }
  }
  for (const b of w.barrels) if (b.respawnAt !== null && b.respawnAt > w.now + RANGE.propRespawnMs) { b.respawnAt = w.now + RANGE.propRespawnMs; }
  for (const q of w.props) if (q.respawnAt !== null && q.respawnAt > w.now + RANGE.propRespawnMs) q.respawnAt = w.now + RANGE.propRespawnMs;
  // Shots are counted from the events of this step, whoever's round they are.
  for (const e of w.events) if (e.e === 'shot') { const p = w.players.get(e.owner); if (p) statsOf(r, p.id).shots++; }
  for (const p of w.players.values()) { p.level = 0; p.score = 0; }
}

/** Starts the stats over and stands every target, barrel and prop up whole. */
export function resetRange(w: World, pid: number): void {
  const r = w.range;
  if (!r) return;
  r.stats.set(pid, freshStats());
  for (const t of r.targets) if (!standing(t) || t.hp < t.maxHp) standUp(w, t);
  for (const b of w.barrels) { b.hp = BARREL.hp; b.fuseAt = null; b.respawnAt = null; b.by = null; }
  for (const q of w.props) { q.hp = PROPS[q.kind].hp; q.respawnAt = null; q.phase = 'stand'; q.vx = 0; q.vy = 0; q.by = null; q.x = q.home.x; q.y = q.home.y; }
  w.wallsVersion++;
}

/** What the loadout panel may ask for: any gun, any armor, and each tier's perk set or cleared (`null`). A tier left out stays as it is. */
export type RangeLoadout = { gun?: GunId; armor?: ArmorId; perks?: { [T in Tier]?: PerkId | null } };

/** True when `l` names only real things in the right tiers (the parser has already checked, and the server checks again). */
export function validLoadout(l: RangeLoadout): boolean {
  if (l.gun !== undefined && !GUN_IDS.includes(l.gun)) return false;
  if (l.armor !== undefined && !ARMOR_IDS.includes(l.armor)) return false;
  for (const tier of [1, 2, 3] as const) {
    const perk = l.perks?.[tier];
    if (perk !== undefined && perk !== null && !(PERK_TIERS[tier] as readonly string[]).includes(perk)) return false;
  }
  return true;
}

/**
 * Puts a gun, armor and perks on the player at once, with a full health bar, magazine and ability: the range is for testing, so nothing waits on a level.
 * Any tier-1 perk is allowed on any gun, whether or not the class lists it as an attachment.
 */
export function setRangeLoadout(w: World, p: Player, l: RangeLoadout): boolean {
  if (!w.range || p.life.k !== 'alive' || !validLoadout(l)) return false;
  if (l.gun) { p.gun = l.gun; p.loadout = { ...p.loadout, weapon: GUNS[l.gun].base }; }
  if (l.armor) p.loadout = { ...p.loadout, armor: l.armor };
  const perks: Partial<Record<Tier, PerkId>> = { ...p.perks };
  for (const tier of [1, 2, 3] as const) {
    const perk = l.perks?.[tier];
    if (perk === undefined) continue;
    if (perk === null) delete perks[tier]; else perks[tier] = perk;
  }
  p.perks = perks as Player['perks'];
  p.level = 0;
  p.score = 0;
  const stats = effectiveStats(p);
  const life = p.life;
  life.hp = stats.maxHp;
  life.ammo = stats.mag;
  life.reloadUntil = null;
  life.burstLeft = 0;
  life.spray = 0;
  life.spin = 0;
  life.nextFireAt = 0;
  life.pressUntil = -Infinity;
  life.settleLeft = 0;
  life.spreadHist = [];
  life.spreadShot = 0;
  p.abilityReadyAt = 0;
  return true;
}

