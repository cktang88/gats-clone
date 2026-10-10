import { AIRDROP, ARMORS, PROPS, WORLD } from '../defs.ts';
import { MAPS, type MapId } from '../maps.ts';
export { planeAt } from '../protocol.ts';
import { award } from './combat.ts';
import { circleHitsRect, rectsOverlap, type Rect } from './movement.ts';
import { staticSolids } from '../mapgeo.ts';
import { abilityOf, addScore, effectiveStats } from './stats.ts';
import { crateRect, newId, rand, type Crate, type Player, type Pose, type World } from './world.ts';

const CELL = 50;
/** The plane starts this far past the map's edge, beyond any view, so it is never seen popping in. */
const PLANE_MARGIN = 1100;
/** Soonest the plane may arrive after the notice, so there is time to read it and run. */
const MIN_LEAD_MS = 5000;
/** A drop wants this much clear floor around its center: its half width, a body and some room to stand and shoot. */
const CLEAR_R = AIRDROP.size / 2 + WORLD.playerRadius + 24;

const spotCache = new Map<string, Pose[]>();

/** Spots on `map` a player can walk to from a spawn, clear of every wall, crate and barrel, and away from the edge: where a supply crate may land. */
export const dropSpots = (map: MapId): readonly Pose[] => openSpots(map, CLEAR_R, AIRDROP.edge);

/**
 * The centres of the `CELL` px grid on `map` a player can walk to from a spawn with `clearR` px of floor clear of every wall, crate, barrel
 * and prop round them, at least `edge` px in from the map's edge. Cached per map and size.
 */
export function openSpots(map: MapId, clearR: number, edge: number): readonly Pose[] {
  const cacheKey = `${map}:${clearR}:${edge}`;
  const cached = spotCache.get(cacheKey);
  if (cached) return cached;
  const def = MAPS[map];
  const n = Math.ceil(def.size / CELL);
  const at = (i: number) => (i + 0.5) * CELL;
  const solids: Rect[] = [
    ...staticSolids(def),
    ...def.crates.map((c) => ({ x: c.x - 22, y: c.y - 22, w: 44, h: 44 })),
    ...def.barrels.map((b) => ({ x: b.x - 18, y: b.y - 18, w: 36, h: 36 })),
    ...def.props.map((q) => { const h = PROPS[q.kind].size / 2; return { x: q.x - h, y: q.y - h, w: 2 * h, h: 2 * h }; }),
  ];
  const blocked = (r: number): Uint8Array => {
    const out = new Uint8Array(n * n);
    for (const s of solids) {
      const i0 = Math.max(0, Math.floor((s.x - r) / CELL)), i1 = Math.min(n - 1, Math.floor((s.x + s.w + r) / CELL));
      const j0 = Math.max(0, Math.floor((s.y - r) / CELL)), j1 = Math.min(n - 1, Math.floor((s.y + s.h + r) / CELL));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (circleHitsRect(at(i), at(j), r, s)) out[j * n + i] = 1;
    }
    return out;
  };
  const body = blocked(WORLD.playerRadius), wide = blocked(clearR);
  const seen = new Uint8Array(n * n);
  const queue: number[] = [];
  for (const r of [...def.spawns.red, ...def.spawns.blue, ...def.spawns.ffa]) {
    for (let j = Math.floor(r.y / CELL); j <= Math.floor((r.y + r.h) / CELL); j++) for (let i = Math.floor(r.x / CELL); i <= Math.floor((r.x + r.w) / CELL); i++) {
      const c = j * n + i;
      if (i >= 0 && j >= 0 && i < n && j < n && !body[c] && !seen[c]) { seen[c] = 1; queue.push(c); }
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head]!, i = c % n, j = Math.floor(c / n);
    for (const [ni, nj] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]] as const) {
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const k = nj * n + ni;
      if (!seen[k] && !body[k]) { seen[k] = 1; queue.push(k); }
    }
  }
  const spots: Pose[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const c = j * n + i, x = at(i), y = at(j);
    if (seen[c] && !wide[c] && x >= edge && y >= edge && x <= def.size - edge && y <= def.size - edge) spots.push({ x, y });
  }
  spotCache.set(cacheKey, spots);
  return spots;
}

/** How far a ray from (x, y) heading (dx, dy) runs before it leaves a square map of `size`. */
const toEdge = (x: number, y: number, dx: number, dy: number, size: number): number =>
  Math.min(dx > 0 ? (size - x) / dx : dx < 0 ? -x / dx : Infinity, dy > 0 ? (size - y) / dy : dy < 0 ? -y / dy : Infinity);

function startFlight(w: World) {
  const spots = dropSpots(w.map);
  if (!spots.length) return;
  const spot = spots[Math.floor(rand(w) * spots.length)]!;
  const a = rand(w) * Math.PI * 2;
  const size = MAPS[w.map].size;
  const away = toEdge(spot.x, spot.y, -Math.cos(a), -Math.sin(a), size) + PLANE_MARGIN;
  const dropAt = w.now + Math.max(MIN_LEAD_MS, (away / AIRDROP.planeSpeed) * 1000);
  w.airdrops.flight = { x: spot.x, y: spot.y, a, dropAt, landAt: dropAt + AIRDROP.fallMs, crateId: null, expiresAt: Infinity };
  w.events.push({ e: 'airdrop', k: 'inbound', x: spot.x, y: spot.y });
}

/** A body (alive or knocked) overlaps `r`: a solid may not appear there yet. */
export const standsOn = (w: World, r: Rect) => [...w.players.values()].some((p) => p.life.k !== 'dead' && rectsOverlap(r, { x: p.x, y: p.y, w: 0, h: 0 }, WORLD.playerRadius));

/** Runs the round's supply planes: the notice, the plane, the crate's landing, and its end if nobody breaks it. */
export function tickAirdrops(w: World) {
  const air = w.airdrops, f = air.flight;
  if (w.match.k !== 'playing') return;
  if (!f) {
    if (air.due.length && w.now >= air.due[0]!) { air.due.shift(); startFlight(w); }
    return;
  }
  if (f.crateId === null) {
    const half = AIRDROP.size / 2;
    const crate: Crate = { id: 0, x: f.x - half, y: f.y - half, size: AIRDROP.size, hp: AIRDROP.hp, respawnAt: null, drop: true };
    if (w.now < f.landAt || standsOn(w, crateRect(crate))) return;
    crate.id = newId(w);
    w.crates = [...w.crates, crate];
    w.wallsVersion++;
    f.crateId = crate.id;
    f.expiresAt = w.now + AIRDROP.lifeMs;
    w.events.push({ e: 'airdrop', k: 'landed', x: f.x, y: f.y });
    return;
  }
  const crate = w.crates.find((c) => c.id === f.crateId);
  if (!crate || crate.respawnAt !== null) { air.flight = null; return; }
  if (w.now >= f.expiresAt) {
    crate.respawnAt = Infinity;
    w.wallsVersion++;
    w.events.push({ e: 'boom', x: f.x, y: f.y, r: AIRDROP.size });
    air.flight = null;
  }
}

/**
 * Cracking a supply drop open: a golden gun for the rest of the life (and a full magazine), or, `AIRDROP.supplyChance` of the time
 * or when the gun is golden already, a full heal, full armor, a full magazine, the abilities back and score. Either way it is a Special Delivery.
 */
export function openAirdrop(w: World, p: Player, crate: Crate) {
  const life = p.life;
  w.airdrops.flight = null;
  const roll = rand(w);
  if (life.k !== 'alive') return;
  const stats = effectiveStats(p);
  const gold = !life.golden && roll >= AIRDROP.supplyChance;
  const rounds = Math.max(0, stats.mag - life.ammo), healed = Math.round(Math.max(0, stats.maxHp - life.hp)), cooling = w.now < p.abilityReadyAt && abilityOf(p) !== null;
  const plates = Math.round(Math.max(0, ARMORS[p.loadout.armor].points - life.armor));
  life.ammo = stats.mag;
  life.reloadUntil = null;
  if (gold) life.golden = true;
  else {
    life.hp = stats.maxHp;
    life.armor = ARMORS[p.loadout.armor].points;
    p.abilityReadyAt = 0;
    addScore(w, p, AIRDROP.supplyScore);
  }
  w.events.push({ e: 'gain', id: p.id, from: 'airdrop', ...(rounds > 0 && { ammo: rounds }), ...(gold ? { gold: true as const } : { ...(healed > 0 && { hp: healed }), ...(plates > 0 && { armor: plates }), ...(cooling && { ability: true as const }) }) });
  const h = crate.size / 2;
  w.events.push({ e: 'airdrop', k: 'taken', x: crate.x + h, y: crate.y + h, by: p.name, gold });
  award(w, p, 'specialDelivery');
}
