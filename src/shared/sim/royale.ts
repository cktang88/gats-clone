import { ARMOR_IDS, ARMORS, GUN_IDS, GUNS, LEVELS, LOOT, RING, ROYALE, TOWER, WORLD, type GunId, type LootTier } from '../defs.ts';
import { MAPS } from '../maps.ts';
import { ringAt, type Circle, type RingView, type RoundWinner, type RoyaleResult } from '../protocol.ts';
import { die, kill } from './combat.ts';
import { DOT_SHARE, dotPulses } from './dot.ts';
import { circleBlocked, dist2, rectsOverlap } from './movement.ts';
import { abilityOf, addScore, effectiveStats, freshLife, levelForScore, reopenUselessAttachment, resetProgress } from './stats.ts';
import { crackSupply } from './airdrop.ts';
import { coverRects, crateRect, freshFeats, newId, rand, solidRects, type Cache, type Player, type Pose, type Ring, type Royale, type RoyaleStats, type Tower, type World } from './world.ts';

/**
 * Last Standing: a battle royale where every player is on their own (friends excepted: they never hurt each other). Everyone drops in
 * with their class gun and no armor, spread over the map; loot caches (`LOOT`) are where armor, score and level picks come from, recon
 * towers (`TOWER`) show who is around, supply drops land each phase, and the ring (`RING`) closes everyone in. Until the second phase
 * closes a dead player redeploys inside the circle with nothing; after that, a death is out for good. The last one standing wins.
 */

export const closedPhases = (ring: Ring) => (ring.k === 'closed' ? RING.length : ring.phase);
export const redeploysOpen = (r: Royale) => closedPhases(r.ring) < ROYALE.redeployPhases;

export function ringView(ring: Ring): RingView {
  switch (ring.k) {
    case 'waiting': return { phase: ring.phase, from: ring.circle, to: ring.next, shrinkAt: ring.shrinkAt, closeAt: ring.shrinkAt + RING[ring.phase]!.shrinkMs };
    case 'shrinking': return { phase: ring.phase, from: ring.from, to: ring.to, shrinkAt: ring.startAt, closeAt: ring.closeAt };
    case 'closed': return { phase: RING.length, from: ring.circle, to: ring.circle, shrinkAt: ring.closedAt, closeAt: ring.closedAt };
  }
}

export const safeCircle = (r: Royale, now: number): Circle => ringAt(ringView(r.ring), now);

const ringDps = (ring: Ring) => RING[ring.k === 'closed' ? RING.length - 1 : ring.phase]!.dps;

function clearSpotIn(w: World, c: Circle, within: number, edge: number): { x: number; y: number } {
  const size = MAPS[w.map].size;
  const margin = Math.max(WORLD.playerRadius * 2, Math.min(edge, size / 2) * 0.6);
  const solids = coverRects(w);
  for (let i = 0; i < 80; i++) {
    const a = rand(w) * 2 * Math.PI, d = Math.sqrt(rand(w)) * within;
    const x = c.x + Math.cos(a) * d, y = c.y + Math.sin(a) * d;
    if (x < margin || y < margin || x > size - margin || y > size - margin) continue;
    if (!circleBlocked(solids, x, y, WORLD.playerRadius * 2)) return { x, y };
  }
  return { x: c.x, y: c.y };
}

const nextCircle = (w: World, from: Circle, r: number): Circle => ({ ...clearSpotIn(w, from, Math.max(0, from.r - r), r), r });

function scheduleDrop(w: World, r: Royale, into: Circle) {
  const at = clearSpotIn(w, into, into.r, 0);
  r.drops.push({ ...at, landsAt: w.now + ROYALE.dropLandMs });
}

/** Open spots over the whole map, each at least `spacing` from the others and `edge` from the map's sides, up to `count`. */
function spreadSpots(w: World, count: number, spacing: number, edge: number, clearance: number): Pose[] {
  const size = MAPS[w.map].size, solids = solidRects(w), out: Pose[] = [];
  for (let i = 0; i < count * 40 && out.length < count; i++) {
    const x = edge + rand(w) * (size - 2 * edge), y = edge + rand(w) * (size - 2 * edge);
    if (circleBlocked(solids, x, y, clearance)) continue;
    if (out.some((o) => dist2(o.x, o.y, x, y) < spacing * spacing)) continue;
    out.push({ x, y });
  }
  return out;
}

function lootTier(w: World): LootTier {
  const roll = rand(w);
  let acc = 0;
  for (let t = 0; t < LOOT.tiers.length; t++) {
    acc += LOOT.tiers[t]!.weight;
    if (roll < acc) return t as LootTier;
  }
  return 0;
}

export function newRoyale(w: World): Royale {
  const size = MAPS[w.map].size;
  const circle = { x: size / 2, y: size / 2, r: Math.hypot(size, size) / 2 + WORLD.playerRadius * 4 };
  const next = nextCircle(w, circle, RING[0]!.radius);
  const caches: Cache[] = spreadSpots(w, LOOT.count, LOOT.spacing, 200, LOOT.size).map((at) => {
    const tier = lootTier(w);
    // A weapon case holds a gun of its tier's stage: a class gun, a first evolution, or (rarest) a final one.
    const guns = GUN_IDS.filter((g) => GUNS[g].stage === tier);
    const gun = rand(w) < LOOT.weaponShare ? guns[Math.floor(rand(w) * guns.length)] : undefined;
    return { id: newId(w), ...at, tier, open: false, ...(gun && { gun }) };
  });
  // Towers stand far apart, each picked the farthest it can be from the ones already placed, so every part of the map has one in reach.
  const candidates = spreadSpots(w, 30, 500, 600, TOWER.radius * 0.6);
  const towers: Tower[] = [];
  while (towers.length < TOWER.count && candidates.length) {
    const far = (p: Pose) => Math.min(Infinity, ...towers.map((t) => dist2(t.x, t.y, p.x, p.y)), dist2(p.x, p.y, size / 2, size / 2) * (towers.length ? Infinity : 1));
    const best = candidates.reduce((a, b) => (far(b) > far(a) ? b : a));
    candidates.splice(candidates.indexOf(best), 1);
    towers.push({ x: best.x, y: best.y, readyAt: 0, holder: null, since: 0 });
  }
  const r: Royale = {
    startedAt: w.now,
    ring: { k: 'waiting', phase: 0, circle, next, shrinkAt: w.now + RING[0]!.waitMs },
    // A new match on a new map (the map changes after the round has started) takes in everyone standing.
    entrants: [...w.players.values()].filter((p) => p.life.k === 'alive').map((p) => p.id), out: [], caches, towers, guns: [], armors: [], tookAt: new Map(), redeployAt: new Map(), drops: [], stats: new Map(), killers: new Map(), watching: new Map(),
  };
  scheduleDrop(w, r, next);
  return r;
}

function statsFor(r: Royale, p: Player): RoyaleStats {
  let s = r.stats.get(p.id);
  if (!s) r.stats.set(p.id, (s = { name: p.name, kills: 0, loot: 0 }));
  return s;
}

/** A Last Standing life starts with no armor: armor comes from the loot caches. */
function stripArmor(p: Player) {
  if (p.loadout.armor !== 'none') p.loadout = { ...p.loadout, armor: 'none' };
}

/** Leaves `gun` on the floor at (x, y); the oldest gun lying about goes once there are more than `LOOT.maxGuns`. */
function dropGun(w: World, r: Royale, gun: GunId, x: number, y: number) {
  r.guns.push({ id: newId(w), x, y, gun });
  if (r.guns.length > LOOT.maxGuns) r.guns.shift();
}

function perish(w: World, r: Royale, p: Player, by: Player | null) {
  // The dead drop their gun and a box of armor (their own tier, light at least), so every kill pays: walk over the armor, E for the gun.
  if (p.life.k !== 'dead') {
    // Gun below the body, armor above, far enough apart that their name plates never overlap.
    dropGun(w, r, p.gun, p.x, p.y + 18);
    const tier = p.loadout.armor === 'none' ? 'light' : p.loadout.armor;
    r.armors.push({ id: newId(w), x: p.x, y: p.y - 24, tier });
    if (r.armors.length > LOOT.maxGuns) r.armors.shift();
  }
  die(w, p, Infinity);
  if (by && by.id !== p.id) r.killers.set(p.id, by.id);
  if (redeploysOpen(r)) r.redeployAt.set(p.id, w.now + ROYALE.redeployMs(p.deaths));
}

/** Every player is on their own, so nobody is ever knocked: a fall is a death. */
export function fall(w: World, r: Royale, victim: Player, by: Player | null): boolean {
  perish(w, r, victim, by);
  return false;
}

/** Nobody goes down in Last Standing; a downed body (none should be) is finished outright. */
export function hurtDowned(w: World, victim: Player, _amount: number, by: Player | null) {
  const r = w.royale;
  if (!r || victim.life.k !== 'downed') return;
  perish(w, r, victim, by);
}

export function openDrop(w: World, p: Player, at: { x: number; y: number }) {
  crackSupply(w, p, at, 'drop');
}

function advanceRing(w: World, r: Royale) {
  const ring = r.ring;
  if (ring.k === 'waiting' && w.now >= ring.shrinkAt) {
    r.ring = { k: 'shrinking', phase: ring.phase, from: ring.circle, to: ring.next, startAt: ring.shrinkAt, closeAt: ring.shrinkAt + RING[ring.phase]!.shrinkMs };
  } else if (ring.k === 'shrinking' && w.now >= ring.closeAt) {
    const phase = ring.phase + 1;
    const row = RING[phase];
    if (!row) r.ring = { k: 'closed', circle: ring.to, closedAt: w.now };
    else {
      const next = nextCircle(w, ring.to, row.radius);
      r.ring = { k: 'waiting', phase, circle: ring.to, next, shrinkAt: w.now + row.waitMs };
      scheduleDrop(w, r, next);
    }
    if (!redeploysOpen(r)) r.redeployAt.clear();
  }
}

function landDrops(w: World, r: Royale) {
  const half = ROYALE.dropSize / 2;
  r.drops = r.drops.filter((d) => {
    const crate = { id: 0, x: d.x - half, y: d.y - half, size: ROYALE.dropSize, hp: ROYALE.dropHp, respawnAt: null, drop: true as const };
    if (w.now < d.landsAt || [...w.players.values()].some((p) => p.life.k !== 'dead' && rectsOverlap(crateRect(crate), { x: p.x, y: p.y, w: 0, h: 0 }, WORLD.playerRadius))) return true;
    w.crates = [...w.crates, { ...crate, id: newId(w) }];
    w.wallsVersion++;
    return false;
  });
}

/**
 * Outside the circle a body loses `RING`'s share of its max health a second, in pulses on the world clock (`dotPulses` from time 0, so every
 * body outside burns on the same beat): each pulse is one hit, one number, of `DOT_MS` worth. One who steps back in between pulses takes nothing more.
 */
function burnOutside(w: World, r: Royale, dtMs: number) {
  const pulses = dotPulses(0, w.now, dtMs);
  if (pulses === 0) return;
  const c = safeCircle(r, w.now);
  const dps = ringDps(r.ring);
  for (const p of [...w.players.values()]) {
    const life = p.life;
    if (life.k !== 'alive' || dist2(p.x, p.y, c.x, c.y) <= c.r * c.r) continue;
    const amount = dps * effectiveStats(p).maxHp * DOT_SHARE * pulses;
    const dealt = Math.min(life.hp, amount);
    life.hp -= amount;
    life.lastDamageAt = w.now;
    w.events.push({ e: 'dmg', attacker: null, victim: p.id, amount: Math.round(dealt * 10) / 10, x: p.x, y: p.y, kind: 'player' });
    if (life.hp <= 0) kill(w, p, null, 'Ring');
  }
}

/** Where a solo comes back: open ground inside the safe circle, as far as it can find from everyone standing. */
export function soloSpawn(w: World, r: Royale | null, self: number): Pose {
  const size = MAPS[w.map].size, solids = solidRects(w), clearance = WORLD.playerRadius + 10;
  const c = r ? safeCircle(r, w.now) : { x: size / 2, y: size / 2, r: size };
  const within = Math.min(c.r * 0.85, size);
  const rivals = [...w.players.values()].filter((p) => p.id !== self && p.life.k === 'alive' && Number.isFinite(p.x));
  let best: (Pose & { safety: number }) | null = null;
  for (let i = 0, found = 0; i < 400 && found < 24; i++) {
    const a = rand(w) * 2 * Math.PI, d = Math.sqrt(rand(w)) * within;
    const x = c.x + Math.cos(a) * d, y = c.y + Math.sin(a) * d;
    if (x < clearance || y < clearance || x > size - clearance || y > size - clearance || circleBlocked(solids, x, y, clearance)) continue;
    found++;
    const safety = Math.min(Infinity, ...rivals.map((p) => dist2(p.x, p.y, x, y)));
    if (!best || safety > best.safety) best = { x, y, safety };
  }
  return best ? { x: best.x, y: best.y } : { x: c.x, y: c.y };
}

function redeploy(w: World, r: Royale) {
  for (const [id, at] of r.redeployAt) {
    const p = w.players.get(id);
    if (!p || p.life.k !== 'dead') { r.redeployAt.delete(id); continue; }
    if (w.now < at) continue;
    r.redeployAt.delete(id);
    resetProgress(p, w);
    stripArmor(p);
    p.lifeKills = 0;
    p.feats = freshFeats();
    p.taggedUntil = 0;
    const spot = soloSpawn(w, r, p.id);
    p.x = spot.x;
    p.y = spot.y;
    p.life = freshLife(p, w.now);
    w.events.push({ e: 'life', id: p.id, name: p.name, k: 'redeployed', by: null });
  }
}

/** Entrants who are dead with no redeploy coming are out, the fewest kills placing lowest when several go at once. */
function eliminate(w: World, r: Royale) {
  const gone = r.entrants.filter((id) => {
    if (r.out.includes(id)) return false;
    const p = w.players.get(id);
    return !p || (p.life.k !== 'alive' && !r.redeployAt.has(id));
  }).sort((a, b) => (w.players.get(a)?.kills ?? 0) - (w.players.get(b)?.kills ?? 0) || b - a);
  for (const id of gone) {
    const place = r.entrants.length - r.out.length;
    r.out.push(id);
    const p = w.players.get(id);
    if (p) w.events.push({ e: 'wiped', id, name: p.name, place });
  }
}

const alive = (p: Player | undefined): p is Player => !!p && p.life.k === 'alive';

function watch(w: World, r: Royale) {
  for (const p of w.players.values()) {
    if (p.life.k === 'alive') { r.watching.delete(p.id); continue; }
    if (alive(w.players.get(r.watching.get(p.id) ?? -1))) continue;
    const target = [w.players.get(r.killers.get(p.id) ?? -1)].find(alive) ?? [...w.players.values()].find((o) => o.id !== p.id && o.life.k === 'alive');
    if (target) r.watching.set(p.id, target.id);
    else r.watching.delete(p.id);
  }
}

/** Opening a cache: what its tier gives (`LOOT`), said in the opener's pickup chips and a `loot` event everyone near sees. */
function openCache(w: World, r: Royale, c: Cache, p: Player) {
  const life = p.life;
  if (life.k !== 'alive') return;
  c.open = true;
  statsFor(r, p).loot++;
  // A weapon case leaves its gun on the floor for whoever takes it with E.
  if (c.gun) {
    dropGun(w, r, c.gun, c.x, c.y);
    w.events.push({ e: 'loot', x: c.x, y: c.y, tier: c.tier, by: p.id, gun: c.gun });
    return;
  }
  const tier = LOOT.tiers[c.tier]!;
  let armorTo: (typeof ARMOR_IDS)[number] | undefined;
  const at = ARMOR_IDS.indexOf(p.loadout.armor);
  if (tier.armorUp && at < ARMOR_IDS.length - 1) {
    armorTo = ARMOR_IDS[Math.min(ARMOR_IDS.length - 1, at + tier.armorUp)]!;
    p.loadout = { ...p.loadout, armor: armorTo };
  }
  const plates = tier.armorUp ? Math.round(Math.max(0, ARMORS[p.loadout.armor].points - life.armor)) : 0;
  if (tier.armorUp) life.armor = ARMORS[p.loadout.armor].points;
  let level = false, xp = 0;
  if (tier.pick) {
    const next = LEVELS[p.level + 1];
    if (next) { p.score = Math.max(p.score, next.score); p.level = levelForScore(p.score); level = true; }
  } else if (tier.score) {
    const before = p.score;
    addScore(w, p, tier.score);
    xp = p.score - before;
  }
  const stats = effectiveStats(p);
  const healTo = tier.pick ? stats.maxHp : Math.min(stats.maxHp, life.hp + tier.heal);
  const healed = Math.round(Math.max(0, healTo - life.hp));
  life.hp = Math.max(life.hp, healTo);
  const rounds = Math.max(0, stats.mag - life.ammo);
  life.ammo = stats.mag;
  life.reloadUntil = null;
  const cooling = tier.pick && w.now < p.abilityReadyAt && abilityOf(p) !== null;
  if (tier.pick) p.abilityReadyAt = 0;
  w.events.push({
    e: 'gain', id: p.id, from: 'loot', ...(xp > 0 && { xp }), ...(healed > 0 && { hp: healed }), ...(rounds > 0 && { ammo: rounds }),
    ...(plates > 0 && { armor: plates }), ...(armorTo && { armorTo }), ...(level && { level: true as const }), ...(cooling && { ability: true as const }),
  });
  w.events.push({ e: 'loot', x: c.x, y: c.y, tier: c.tier, by: p.id });
}

/** A cache opens for a living player who stays within `LOOT.openPx` of it for `LOOT.openMs`; the first in turn order to come up has it, and leaving starts it over. */
function tickLoot(w: World, r: Royale) {
  const reach = (LOOT.openPx + WORLD.playerRadius) ** 2;
  const near = (p: Player | undefined, c: Cache) => !!p && p.life.k === 'alive' && dist2(p.x, p.y, c.x, c.y) <= reach;
  for (const c of r.caches) {
    if (c.open) continue;
    if (c.by == null || !near(w.players.get(c.by), c)) {
      const p = [...w.players.values()].find((o) => near(o, c));
      c.by = p?.id ?? null;
      c.since = w.now;
      if (!p) continue;
    }
    if (w.now - (c.since ?? w.now) >= LOOT.openMs) openCache(w, r, c, w.players.get(c.by!)!);
  }
}

/**
 * A living player pressing E (use) within `LOOT.takePx` of a gun on the floor takes the nearest one, with a full magazine of it, and
 * leaves the gun they had in its place; one take per `takeCooldownMs`, so holding E does not swap back and forth. An attachment the new
 * gun cannot use comes off, and the next evolve pick follows the new gun.
 */
function tickGuns(w: World, r: Royale) {
  if (!r.guns.length) return;
  const reach = (LOOT.takePx + WORLD.playerRadius) ** 2;
  for (const p of w.players.values()) {
    const life = p.life;
    if (life.k !== 'alive' || !p.input.use || w.now - (r.tookAt.get(p.id) ?? -Infinity) < LOOT.takeCooldownMs) continue;
    const near = r.guns.filter((g) => dist2(g.x, g.y, p.x, p.y) <= reach);
    if (!near.length) continue;
    const g = near.reduce((a, b) => (dist2(b.x, b.y, p.x, p.y) < dist2(a.x, a.y, p.x, p.y) ? b : a));
    const left = p.gun;
    r.guns = r.guns.filter((o) => o !== g);
    r.guns.push({ id: newId(w), x: g.x, y: g.y, gun: left });
    p.gun = g.gun;
    reopenUselessAttachment(p);
    life.ammo = effectiveStats(p).mag;
    life.reloadUntil = null;
    r.tookAt.set(p.id, w.now);
    w.events.push({ e: 'took', id: p.id, gun: g.gun, left, x: g.x, y: g.y });
  }
}

/** Armor on the floor is taken by the first living player to walk over it whom it would put in a better tier, or whose plates it would fill. */
function tickArmors(w: World, r: Royale) {
  if (!r.armors.length) return;
  const reach = (LOOT.takePx + WORLD.playerRadius) ** 2;
  r.armors = r.armors.filter((a) => {
    for (const p of w.players.values()) {
      const life = p.life;
      if (life.k !== 'alive' || dist2(a.x, a.y, p.x, p.y) > reach) continue;
      const mine = ARMOR_IDS.indexOf(p.loadout.armor), theirs = ARMOR_IDS.indexOf(a.tier);
      const better = theirs > mine, refill = theirs === mine && life.armor < ARMORS[a.tier].points;
      if (!better && !refill) continue;
      if (better) p.loadout = { ...p.loadout, armor: a.tier };
      const plates = Math.round(ARMORS[p.loadout.armor].points - life.armor);
      life.armor = ARMORS[p.loadout.armor].points;
      w.events.push({ e: 'gain', id: p.id, from: 'body', ...(plates > 0 && { armor: plates }), ...(better && { armorTo: a.tier }) });
      return false;
    }
    return true;
  });
}

/**
 * A ready tower is taken by one living player standing within `TOWER.radius` of it alone for `holdMs` (a second player inside, or
 * the holder stepping out, starts it over): every other living player within `revealPx` then shows on the holder's minimap for `revealMs`.
 */
function tickTowers(w: World, r: Royale) {
  for (const t of r.towers) {
    if (w.now < t.readyAt) { t.holder = null; continue; }
    const inside = [...w.players.values()].filter((p) => p.life.k === 'alive' && dist2(p.x, p.y, t.x, t.y) <= TOWER.radius ** 2);
    const lone = inside.length === 1 ? inside[0]! : null;
    if (!lone) { t.holder = null; continue; }
    if (t.holder !== lone.id) { t.holder = lone.id; t.since = w.now; continue; }
    if (w.now - t.since < TOWER.holdMs || lone.life.k !== 'alive') continue;
    const life = lone.life;
    let n = 0;
    for (const p of w.players.values()) {
      if (p.id === lone.id || p.life.k !== 'alive' || dist2(p.x, p.y, t.x, t.y) > TOWER.revealPx ** 2) continue;
      life.tracks[p.id] = w.now + TOWER.revealMs;
      n++;
    }
    w.events.push({ e: 'tower', x: t.x, y: t.y, r: TOWER.revealPx, by: lone.id, n });
    t.readyAt = w.now + TOWER.cooldownMs;
    t.holder = null;
  }
}

export function tickRoyale(w: World, dtMs: number) {
  const r = w.royale;
  if (!r) return;
  advanceRing(w, r);
  landDrops(w, r);
  burnOutside(w, r, dtMs);
  tickLoot(w, r);
  tickGuns(w, r);
  tickArmors(w, r);
  tickTowers(w, r);
  redeploy(w, r);
  eliminate(w, r);
  watch(w, r);
}

/** `id`'s place: set once they are out, 1 for the winner once the match is over, null while still in it. */
export function placeOf(w: World, r: Royale, id: number): number | null {
  const i = r.out.indexOf(id);
  if (i >= 0) return r.entrants.length - i;
  return w.match.k === 'over' && r.entrants.includes(id) ? 1 : null;
}

export const stillIn = (r: Royale) => r.entrants.filter((id) => !r.out.includes(id));

export function royaleWinner(w: World): RoundWinner | null {
  const r = w.royale;
  if (!r || r.entrants.length < 2) return null;
  const left = stillIn(r);
  if (left.length > 1) return null;
  const id = left[0] ?? r.out[r.out.length - 1]!;
  return { name: w.players.get(id)?.name ?? r.stats.get(id)?.name ?? 'Nobody', id, note: 'Last one standing' };
}

export function royaleKill(w: World, killer: Player, _victim: Player) {
  if (w.royale) statsFor(w.royale, killer).kills++;
}

export function startRoyale(w: World) {
  const r = w.royale;
  for (const p of w.players.values()) {
    p.team = null;
    stripArmor(p);
    p.life = freshLife(p, w.now);
    if (r && !r.entrants.includes(p.id)) r.entrants.push(p.id);
  }
}

/** A player added while the match is open (a bot filling the room) plays in it like the rest. */
export function enterRoyale(w: World, p: Player) {
  const r = w.royale;
  if (!r) return;
  p.team = null;
  stripArmor(p);
  if (p.life.k === 'alive') p.life = freshLife(p, w.now);
  if (!r.entrants.includes(p.id)) r.entrants.push(p.id);
}

const SEAT_ORDER = { alive: 0, dead: 1, downed: 2 } as const;

/** The bot a joining person takes the place of while redeploys are open: one still in the match, a standing one first. */
export function seatFor(w: World): Player | null {
  const r = w.royale;
  if (!r || w.match.k !== 'playing' || !redeploysOpen(r)) return null;
  const bots = [...w.players.values()].filter((p) => p.kind === 'bot' && r.entrants.includes(p.id) && !r.out.includes(p.id));
  return bots.sort((a, b) => SEAT_ORDER[a.life.k] - SEAT_ORDER[b.life.k])[0] ?? null;
}

/** `to` takes `from`'s place in the match: where it stood, the state it was in, and its redeploy. */
export function takeSeat(w: World, to: Player, from: Player) {
  const r = w.royale!;
  to.team = null;
  to.x = from.x;
  to.y = from.y;
  stripArmor(to);
  to.life = from.life.k === 'alive' ? freshLife(to, w.now) : { k: 'dead', respawnAt: Infinity };
  const redeployAt = r.redeployAt.get(from.id);
  r.redeployAt.delete(from.id);
  if (redeployAt !== undefined) r.redeployAt.set(to.id, redeployAt);
  r.entrants = r.entrants.filter((id) => id !== to.id).map((id) => (id === from.id ? to.id : id));
  if (!r.entrants.includes(to.id)) r.entrants.push(to.id);
}

/** A joiner too late to play watches until the next match seats them. */
export function benchUntilNextMatch(p: Player) {
  p.team = null;
  p.life = { k: 'dead', respawnAt: Infinity };
}

export function resultFor(w: World, r: Royale, p: Player): RoyaleResult | null {
  const place = placeOf(w, r, p.id);
  if (!place) return null;
  const s = r.stats.get(p.id);
  return { place, of: r.entrants.length, kills: s?.kills ?? 0, loot: s?.loot ?? 0 };
}
