import { COLOR_IDS, LEVELS, RING, ROYALE, WORLD, type ColorId } from '../defs.ts';
import { MAPS } from '../maps.ts';
import { ringAt, type Circle, type RingView, type RoundWinner, type RoyaleResult, type Team } from '../protocol.ts';
import { die, kill } from './combat.ts';
import { DOT_SHARE, dotPulses } from './dot.ts';
import { goDown, tickDowned } from './downed.ts';
import { circleBlocked, dist2, rectsOverlap } from './movement.ts';
import { abilityOf, effectiveStats, freshLife, levelForScore, resetProgress } from './stats.ts';
import { coverRects, crateRect, freshFeats, newId, rand, spawnPoint, type Player, type Ring, type Royale, type RoyaleStats, type World } from './world.ts';

const squadName = (team: ColorId) => `${team[0]!.toUpperCase()}${team.slice(1)} squad`;

const standing = (w: World, team: Team) => [...w.players.values()].some((p) => p.team === team && p.life.k === 'alive');

export const closedPhases = (ring: Ring) => (ring.k === 'closed' ? RING.length : ring.phase);
export const redeploysOpen = (r: Royale) => closedPhases(r.ring) < ROYALE.redeployPhases;

export function ringView(ring: Ring): RingView {
  switch (ring.k) {
    case 'waiting': return { phase: ring.phase, from: ring.circle, to: ring.next, shrinkAt: ring.shrinkAt, closeAt: ring.shrinkAt + RING[ring.phase]!.shrinkMs };
    case 'shrinking': return { phase: ring.phase, from: ring.from, to: ring.to, shrinkAt: ring.startAt, closeAt: ring.closeAt };
    case 'closed': return { phase: RING.length, from: ring.circle, to: ring.circle, shrinkAt: ring.closedAt, closeAt: ring.closedAt };
  }
}

const safeCircle = (r: Royale, now: number): Circle => ringAt(ringView(r.ring), now);

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

export function newRoyale(w: World): Royale {
  const size = MAPS[w.map].size;
  const circle = { x: size / 2, y: size / 2, r: Math.hypot(size, size) / 2 + WORLD.playerRadius * 4 };
  const next = nextCircle(w, circle, RING[0]!.radius);
  const r: Royale = {
    startedAt: w.now,
    ring: { k: 'waiting', phase: 0, circle, next, shrinkAt: w.now + RING[0]!.waitMs },
    squads: [], out: [], redeployAt: new Map(), drops: [], stats: new Map(), killers: new Map(), watching: new Map(),
  };
  scheduleDrop(w, r, next);
  return r;
}

function statsFor(r: Royale, p: Player): RoyaleStats {
  let s = r.stats.get(p.id);
  if (!s) r.stats.set(p.id, (s = { name: p.name, kills: 0, knocks: 0, revives: 0 }));
  return s;
}

export function emptiestSquad(w: World, weigh: (p: Player) => number = () => 1): ColorId {
  const load = (team: ColorId) => [...w.players.values()].reduce((n, p) => n + (p.team === team ? weigh(p) : 0), 0);
  return COLOR_IDS.reduce((best, team) => (load(team) < load(best) ? team : best));
}

function perish(w: World, r: Royale, p: Player, by: Player | null) {
  die(w, p, Infinity);
  if (by && by.id !== p.id) r.killers.set(p.id, by.id);
  if (redeploysOpen(r)) r.redeployAt.set(p.id, w.now + ROYALE.redeployMs(p.deaths));
}

export function fall(w: World, r: Royale, victim: Player, by: Player | null): boolean {
  if (![...w.players.values()].some((p) => p.id !== victim.id && p.team === victim.team && p.life.k === 'alive')) {
    perish(w, r, victim, by);
    return false;
  }
  goDown(w, victim, effectiveStats(victim).maxHp * ROYALE.knockHpFrac);
  if (by && by.id !== victim.id) r.killers.set(victim.id, by.id);
  return true;
}

export function hurtDowned(w: World, victim: Player, amount: number, by: Player | null) {
  const r = w.royale, life = victim.life;
  if (!r || life.k !== 'downed') return;
  const dealt = Math.min(life.hp, amount);
  life.hp -= amount;
  if (by) w.events.push({ e: 'dmg', attacker: by.id, victim: victim.id, amount: Math.round(dealt * 10) / 10, x: victim.x, y: victim.y, kind: 'player' });
  if (life.hp > 0) return;
  w.events.push({ e: 'life', id: victim.id, name: victim.name, k: 'finished', by: by?.id ?? null });
  if (by && by.id !== victim.id) statsFor(r, by).kills++;
  perish(w, r, victim, by);
}

export function openDrop(w: World, p: Player) {
  const next = LEVELS[p.level + 1];
  if (next) {
    p.score = Math.max(p.score, next.score);
    p.level = levelForScore(p.score);
  } else if (p.life.k === 'alive') {
    const stats = effectiveStats(p);
    const rounds = Math.max(0, stats.mag - p.life.ammo), healed = Math.round(Math.max(0, stats.maxHp - p.life.hp)), cooling = w.now < p.abilityReadyAt && abilityOf(p) !== null;
    p.life.hp = stats.maxHp;
    p.life.ammo = stats.mag;
    p.life.reloadUntil = null;
    p.abilityReadyAt = 0;
    if (healed > 0 || rounds > 0 || cooling) w.events.push({ e: 'gain', id: p.id, from: 'drop', ...(healed > 0 && { hp: healed }), ...(rounds > 0 && { ammo: rounds }), ...(cooling && { ability: true as const }) });
  }
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
    if (life.k === 'dead' || dist2(p.x, p.y, c.x, c.y) <= c.r * c.r) continue;
    const amount = dps * effectiveStats(p).maxHp * DOT_SHARE * pulses;
    if (life.k === 'downed') {
      w.events.push({ e: 'dmg', attacker: null, victim: p.id, amount: Math.round(Math.min(life.hp, amount) * 10) / 10, x: p.x, y: p.y, kind: 'player' });
      hurtDowned(w, p, amount, null);
      continue;
    }
    const dealt = Math.min(life.hp, amount);
    life.hp -= amount;
    life.lastDamageAt = w.now;
    w.events.push({ e: 'dmg', attacker: null, victim: p.id, amount: Math.round(dealt * 10) / 10, x: p.x, y: p.y, kind: 'player' });
    if (life.hp <= 0) kill(w, p, null, 'Ring');
  }
}

function tickKnocked(w: World, r: Royale, dtMs: number) {
  const revivers = new Set<Player>();
  for (const p of w.players.values()) {
    const outcome = tickDowned(w, p, dtMs, revivers);
    if (outcome === 'bledOut') perish(w, r, p, null);
    else if (outcome) statsFor(r, outcome).revives++;
  }
}

function redeploy(w: World, r: Royale) {
  for (const [id, at] of r.redeployAt) {
    const p = w.players.get(id);
    if (!p || p.life.k !== 'dead') { r.redeployAt.delete(id); continue; }
    if (w.now < at || !standing(w, p.team)) continue;
    r.redeployAt.delete(id);
    resetProgress(p, w);
    p.lifeKills = 0;
    p.feats = freshFeats();
    const spot = spawnPoint(w, p.team);
    p.x = spot.x;
    p.y = spot.y;
    p.life = freshLife(p, w.now);
    w.events.push({ e: 'life', id: p.id, name: p.name, k: 'redeployed', by: null });
  }
}

const teamKills = (w: World, team: ColorId) => [...w.players.values()].reduce((n, p) => n + (p.team === team ? p.kills : 0), 0);

function eliminate(w: World, r: Royale) {
  for (const p of w.players.values()) if (p.team && !r.squads.includes(p.team)) r.squads.push(p.team);
  const fallen = r.squads.filter((s) => !r.out.includes(s) && !standing(w, s))
    .sort((a, b) => teamKills(w, a) - teamKills(w, b) || COLOR_IDS.indexOf(b) - COLOR_IDS.indexOf(a));
  for (const team of fallen) {
    const place = r.squads.length - r.out.length;
    r.out.push(team);
    for (const p of w.players.values()) {
      if (p.team !== team) continue;
      r.redeployAt.delete(p.id);
      if (p.life.k === 'downed') perish(w, r, p, null);
    }
    w.events.push({ e: 'wiped', team, place });
  }
}

const alive = (p: Player | undefined): p is Player => !!p && p.life.k !== 'dead';

function watch(w: World, r: Royale) {
  for (const p of w.players.values()) {
    if (p.life.k !== 'dead') { r.watching.delete(p.id); continue; }
    if (alive(w.players.get(r.watching.get(p.id) ?? -1))) continue;
    const others = [...w.players.values()].filter((o) => o.id !== p.id);
    const target = others.find((o) => o.team === p.team && o.life.k === 'alive') ?? others.find((o) => o.team === p.team && alive(o))
      ?? [w.players.get(r.killers.get(p.id) ?? -1)].find(alive) ?? others.find((o) => o.life.k === 'alive');
    if (target) r.watching.set(p.id, target.id);
    else r.watching.delete(p.id);
  }
}

export function tickRoyale(w: World, dtMs: number) {
  const r = w.royale;
  if (!r) return;
  advanceRing(w, r);
  landDrops(w, r);
  burnOutside(w, r, dtMs);
  tickKnocked(w, r, dtMs);
  redeploy(w, r);
  eliminate(w, r);
  watch(w, r);
}

export function placeOf(w: World, r: Royale, team: ColorId): number | null {
  const i = r.out.indexOf(team);
  if (i >= 0) return r.squads.length - i;
  return w.match.k === 'over' && r.squads.includes(team) ? 1 : null;
}

export function royaleWinner(w: World): RoundWinner | null {
  const r = w.royale;
  if (!r || r.squads.length < 2) return null;
  const left = r.squads.filter((s) => !r.out.includes(s));
  if (left.length > 1) return null;
  const team = left[0] ?? r.out[r.out.length - 1]!;
  return { name: squadName(team), id: null, note: 'Last squad standing' };
}

export function royaleKill(w: World, killer: Player, victim: Player) {
  if (!w.royale) return;
  const s = statsFor(w.royale, killer);
  if (victim.life.k === 'downed') s.knocks++;
  else s.kills++;
}

export function startRoyale(w: World) {
  for (const p of w.players.values()) {
    if (p.team === null) p.team = emptiestSquad(w, (o) => (o.kind === 'human' ? 1 : 0));
    p.life = freshLife(p, w.now);
  }
}

const SEAT_ORDER = { alive: 0, dead: 1, downed: 2 } as const;

export function seatFor(w: World): Player | null {
  const r = w.royale;
  if (!r || w.match.k !== 'playing' || !redeploysOpen(r)) return null;
  const humans = (team: Team) => [...w.players.values()].filter((p) => p.team === team && p.kind === 'human').length;
  const bots = [...w.players.values()].filter((p) => p.kind === 'bot' && p.team !== null && !r.out.includes(p.team));
  return bots.sort((a, b) => humans(a.team) - humans(b.team) || SEAT_ORDER[a.life.k] - SEAT_ORDER[b.life.k])[0] ?? null;
}

export function takeSeat(w: World, to: Player, from: Player) {
  const r = w.royale!;
  to.team = from.team;
  to.x = from.x;
  to.y = from.y;
  const life = from.life;
  if (life.k === 'alive') to.life = freshLife(to, w.now);
  else if (life.k === 'downed') to.life = { ...life, hp: life.hp * (effectiveStats(to).maxHp / effectiveStats(from).maxHp) };
  else to.life = { k: 'dead', respawnAt: Infinity };
  const redeploy = r.redeployAt.get(from.id);
  r.redeployAt.delete(from.id);
  if (redeploy !== undefined) r.redeployAt.set(to.id, redeploy);
}

export function benchUntilNextMatch(p: Player) {
  p.team = null;
  p.life = { k: 'dead', respawnAt: Infinity };
}

export function resultFor(w: World, r: Royale, p: Player): RoyaleResult | null {
  const place = p.team && placeOf(w, r, p.team);
  if (!place) return null;
  const s = r.stats.get(p.id);
  return { place, of: r.squads.length, kills: s?.kills ?? 0, knocks: s?.knocks ?? 0, revives: s?.revives ?? 0 };
}
