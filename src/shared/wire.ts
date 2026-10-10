import type { Cos } from './cosmetics.ts';
import { MINIMAP_EVERY, STICKY_KEYS, type PlayerView, type Snapshot, type SnapshotWire } from './protocol.ts';

const DECIMALS: Readonly<Record<string, number>> = { angle: 2, push: 2, progress: 2, reloadFrac: 2, suppression: 2, settle: 2, vx: 0, vy: 0, dirX: 3, dirY: 3, abilityReadyIn: 0, respawnIn: 0, restartIn: 0, mapChangeIn: 0 };

const POW = [1, 10, 100, 1000];

const round = (key: string, v: unknown) => {
  if (typeof v !== 'number' || Number.isInteger(v)) return v;
  const f = POW[DECIMALS[key] ?? 1]!;
  return Math.round(v * f) / f;
};

/**
 * `JSON.stringify(v, round)`, to the byte. A replacer function takes V8 off its fast path (three times slower), so the numbers are
 * rounded into a copy that the plain stringify then writes. Array items are rounded as `round` rounds them (no key names one).
 */
function rounded(key: string, v: unknown): unknown {
  if (typeof v === 'number') return round(key, v);
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const out: unknown[] = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = rounded('', v[i]);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const k in v) out[k] = rounded(k, (v as Record<string, unknown>)[k]);
  return out;
}

const stringify = (v: unknown) => JSON.stringify(rounded('', v));

/**
 * Whether `v` would go on the wire as `was` (a `rounded` copy) did, walked in place: comparing the sticky fields by stringifying
 * them every tick cost more than writing the snapshot. Keys in another order count as the same (the client reads by name).
 */
function sameRounded(key: string, v: unknown, was: unknown): boolean {
  if (typeof v === 'number') return round(key, v) === was;
  if (v === null || typeof v !== 'object') return v === was || (v === undefined && was === undefined);
  if (was === null || typeof was !== 'object') return false;
  if (Array.isArray(v)) {
    if (!Array.isArray(was) || was.length !== v.length) return false;
    for (let i = 0; i < v.length; i++) if (!sameRounded('', v[i], was[i])) return false;
    return true;
  }
  if (Array.isArray(was)) return false;
  const a = v as Record<string, unknown>, b = was as Record<string, unknown>;
  let n = 0, m = 0;
  for (const k in a) {
    if (a[k] === undefined) continue;
    n++;
    if (!(k in b) || !sameRounded(k, a[k], b[k])) return false;
  }
  for (const k in b) if (b[k] !== undefined) m++;
  return n === m;
}

export function makeSnapshotEncoder(): (snap: Snapshot) => string {
  const lastSent = new Map<string, unknown>();
  let marksSent = -1;
  let sinceMinimap = MINIMAP_EVERY;
  /** Whether `v` differs from what last went out under `key`; if so it is noted as sent. */
  const changed = (key: string, v: unknown) => {
    if (lastSent.has(key) && sameRounded('', v, lastSent.get(key))) return false;
    lastSent.set(key, rounded('', v));
    return true;
  };
  return (snap) => {
    const wire: SnapshotWire = { ...snap, minimap: snap.minimap.map((m) => ({ ...m, x: Math.round(m.x), y: Math.round(m.y) })) };
    // A mark appearing or going rides at once; one only moving waits its turn.
    if (++sinceMinimap < MINIMAP_EVERY && marksSent === snap.minimap.length) delete wire.minimap;
    else { sinceMinimap = 0; marksSent = snap.minimap.length; }
    // Cosmetics change rarely, so they ride apart from the players and are resent only when the set in view changes.
    if (snap.players.some((p) => p.cos)) {
      const cos: Record<number, Cos> = {};
      wire.players = snap.players.map(({ cos: c, ...rest }) => { if (c) cos[rest.id] = c; return rest as PlayerView; });
      if (changed('cos', cos)) wire.cos = cos;
    } else if (lastSent.has('cos') && changed('cos', {})) wire.cos = {};
    for (const key of STICKY_KEYS) if (!changed(key, snap[key])) delete wire[key];
    return stringify(wire);
  };
}

export function fillSnapshot(wire: SnapshotWire, last: Snapshot | null): Snapshot | null {
  const crates = wire.crates ?? last?.crates;
  const leaderboard = wire.leaderboard ?? last?.leaderboard;
  const zones = wire.zones ?? last?.zones;
  const match = wire.match ?? last?.match;
  if (!crates || !leaderboard || !zones || !match) return null;
  const buildings = wire.buildings ?? last?.buildings, run = wire.run ?? last?.run, royale = wire.royale ?? last?.royale;
  const barrels = wire.barrels ?? last?.barrels, props = wire.props ?? last?.props, targets = wire.targets ?? last?.targets, doors = wire.doors ?? last?.doors;
  const airdrop = wire.airdrop !== undefined ? wire.airdrop : last?.airdrop;
  const minimap = wire.minimap ?? last?.minimap ?? [];
  const { cos: sentCos, ...rest } = wire;
  const known: Record<number, Cos> = sentCos ?? Object.fromEntries((last?.players ?? []).filter((p) => p.cos).map((p) => [p.id, p.cos!]));
  const players = Object.keys(known).length ? wire.players.map((p) => (known[p.id] ? { ...p, cos: known[p.id] } : p)) : wire.players;
  return { ...rest, minimap, players, crates, leaderboard, zones, match, ...(buildings && { buildings }), ...(run && { run }), ...(royale && { royale }), ...(barrels && { barrels }), ...(props && { props }), ...(targets && { targets }), ...(doors && { doors }), ...(airdrop !== undefined && { airdrop }) };
}
