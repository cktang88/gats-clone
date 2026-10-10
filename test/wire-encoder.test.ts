/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botCosmetics, type Cos } from '../src/shared/cosmetics.ts';
import type { ModeId } from '../src/shared/defs.ts';
import { MINIMAP_EVERY, STICKY_KEYS, type PlayerView, type Snapshot, type SnapshotWire } from '../src/shared/protocol.ts';
import type { MapId } from '../src/shared/maps.ts';
import { addPlayer, step } from '../src/shared/sim.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { createWorld, rand } from '../src/shared/sim/world.ts';
import { makeSnapshotEncoder } from '../src/shared/wire.ts';
import { newBotMemory, randomLoadout, type BotMemory } from '../src/server/bots.ts';
import { thinkBots } from '../src/server/bot/tick.ts';
import { TICK_MS } from './helpers.ts';

/** The encoder as it was before it stopped using a replacer: what goes on the wire must not change by a byte. */
function referenceEncoder(): (snap: Snapshot) => string {
  const DECIMALS: Readonly<Record<string, number>> = { angle: 2, push: 2, progress: 2, reloadFrac: 2, suppression: 2, settle: 2, vx: 0, vy: 0, dirX: 3, dirY: 3, abilityReadyIn: 0, respawnIn: 0, restartIn: 0, mapChangeIn: 0 };
  const round = (key: string, v: unknown) => {
    if (typeof v !== 'number' || Number.isInteger(v)) return v;
    const f = 10 ** (DECIMALS[key] ?? 1);
    return Math.round(v * f) / f;
  };
  const stringify = (v: unknown) => JSON.stringify(v, round);
  const lastSent = new Map<string, string>();
  let sinceMinimap = MINIMAP_EVERY;
  return (snap) => {
    const wire: SnapshotWire = { ...snap, minimap: snap.minimap.map((m) => ({ ...m, x: Math.round(m.x), y: Math.round(m.y) })) };
    const marks = String(snap.minimap.length);
    if (++sinceMinimap < MINIMAP_EVERY && lastSent.get('minimap') === marks) delete wire.minimap;
    else { sinceMinimap = 0; lastSent.set('minimap', marks); }
    if (snap.players.some((p) => p.cos)) {
      const cos: Record<number, Cos> = {};
      wire.players = snap.players.map(({ cos: c, ...rest }) => { if (c) cos[rest.id] = c; return rest as PlayerView; });
      const json = stringify(cos);
      if (lastSent.get('cos') !== json) { lastSent.set('cos', json); wire.cos = cos; }
    } else if (lastSent.has('cos') && lastSent.get('cos') !== '{}') { lastSent.set('cos', '{}'); wire.cos = {}; }
    for (const key of STICKY_KEYS) {
      const json = stringify(snap[key]);
      if (lastSent.get(key) === json) delete wire[key];
      else lastSent.set(key, json);
    }
    return stringify(wire);
  };
}

function match(mode: ModeId, map: MapId, ticks: number, check: (id: number, snap: Snapshot) => void) {
  const w = createWorld(mode, 5, map);
  const r = () => rand(w);
  const bots = new Map<number, BotMemory>();
  for (let i = 0; i < 12; i++) {
    const p = addPlayer(w, `bot${i}`, randomLoadout(r));
    bots.set(p.id, newBotMemory(r));
    // Some wear a look, some do not, and looks come and go, so the sticky `cos` map is sent, held and cleared.
    if (i % 3 === 0) p.cos = botCosmetics(p.name);
  }
  const watched = [...bots.keys()].slice(0, 3);
  for (let tick = 0; tick < ticks; tick++) {
    thinkBots(w, bots, r, { watched: true });
    step(w, TICK_MS);
    if (tick % 200 === 100) for (const p of w.players.values()) p.cos = p.cos ? null : botCosmetics(p.name);
    for (const id of watched) check(id, snapshotFor(w, id));
  }
}

test('the snapshot encoder writes exactly what the replacer-based encoder did, tick by tick, sticky fields and all', () => {
  const cases: [ModeId, MapId][] = [['FFA', 'airbase'], ['DOM', 'embassy'], ['TDM', 'railyard']];
  for (const [mode, map] of cases) {
    const fast = new Map<number, (s: Snapshot) => string>(), ref = new Map<number, (s: Snapshot) => string>();
    let n = 0, omitted = 0;
    match(mode, map, 400, (id, snap) => {
      if (!fast.has(id)) { fast.set(id, makeSnapshotEncoder()); ref.set(id, referenceEncoder()); }
      const want = ref.get(id)!(snap), got = fast.get(id)!(snap);
      assert.equal(got, want, `${mode} ${map} player ${id} tick ${snap.tick}`);
      n++;
      if (!('leaderboard' in JSON.parse(got))) omitted++;
    });
    assert.ok(n === 1200 && omitted > n / 2, `${mode}: ${omitted}/${n} snapshots left the unchanged leaderboard out`);
  }
});
