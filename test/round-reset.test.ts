import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Accounts } from '../src/server/accounts.ts';
import { navStats } from '../src/server/bot/nav.ts';
import { layoutCount } from '../src/server/bot/arena.ts';
import { createRoom } from '../src/server/room.ts';
import { fakeSocket, PISTOL } from './helpers.ts';

const accounts = { stats: () => null, nameForToken: () => null, credit: () => {} } as unknown as Accounts;
const TICKS_PER_MAP = 450;
const MAPS_PLAYED = 7;

/**
 * A long session in miniature: one human and a full room of bots fight through seven map changes. What a room holds (the world's
 * collections, each player's, the bots' memories, the bot nav grids and their path memos) must come back to the size it had after
 * the first map: a round end or a map change that left something behind would show here as growth that a real server, rotating
 * maps every ten minutes for days, would turn into lag.
 */
test('a room rotating through maps holds no more after seven maps than after one', () => {
  const room = createRoom('ffa', 'FFA', 1000, accounts);
  const ws = fakeSocket();
  room.connect(ws.socket);
  ws.send({ t: 'join', name: 'Soak', loadout: PISTOL, aspect: 1.6 });
  room.netStats();
  type Mark = { map: string; sizes: Record<string, number>; botMemKb: number; grids: number; paths: number; fields: number; layouts: number };
  const marks: Mark[] = [];
  const maps = new Set<string>();
  for (let m = 0; m < MAPS_PLAYED; m++) {
    for (let t = 0; t < TICKS_PER_MAP; t++) {
      room.tick();
      if (t % 60 === 0) ws.sent.length = 0;
    }
    const stats = room.netStats() as ReturnType<typeof room.netStats> & { sizes: Record<string, number>; botMemKb: number };
    const nav = navStats();
    maps.add(room.world.map);
    marks.push({ map: room.world.map, sizes: stats.sizes, botMemKb: stats.botMemKb, grids: nav.grids, paths: nav.paths, fields: nav.fields, layouts: layoutCount() });
    room.world.mapChangeAt = room.world.now;
  }
  room.close();
  ws.close();
  assert.ok(maps.size >= MAPS_PLAYED - 1, `played ${[...maps].join(', ')}`);
  const first = marks[0]!, last = marks.at(-1)!;
  const msg = () => JSON.stringify(marks.map((m) => ({ map: m.map, botMemKb: m.botMemKb, grids: m.grids, paths: m.paths, history: m.sizes.history, bullets: m.sizes.bullets, events: m.sizes.events })));
  // Per-tick and per-life buffers: drained every tick or capped by time, never carried from one map to the next.
  for (const k of ['events', 'queuedEvents', 'lifeRecords', 'thrown', 'emps', 'chains', 'zombies', 'buildings', 'floor']) {
    for (const mark of marks) assert.ok((mark.sizes[k] ?? 0) <= 64, `${k} holds ${mark.sizes[k]} on ${mark.map}: ${msg()}`);
  }
  for (const mark of marks) assert.ok((mark.sizes.history ?? 0) <= first.sizes.history! * 1.5 + 4, `the rewind history holds ${mark.sizes.history} on ${mark.map}: ${msg()}`);
  for (const mark of marks) assert.ok((mark.sizes.bullets ?? 0) <= 200, `bullets ${mark.sizes.bullets} on ${mark.map}`);
  // Every player's own collections, summed over the room.
  for (const [k, n] of Object.entries(last.sizes)) if (k.startsWith('p.')) assert.ok(n <= (first.sizes[k] ?? 0) * 2 + 64, `${k}: ${first.sizes[k]} -> ${n}`);
  assert.equal(last.sizes.players, first.sizes.players, 'the same seats');
  assert.ok(last.botMemKb <= first.botMemKb * 1.6 + 8, `bot memories ${first.botMemKb} KB -> ${last.botMemKb} KB: ${msg()}`);
  // Nav grids: the maps' layouts are kept (one per map, built up front in production), and the per-room copies and path memos are not.
  const gridsBound = first.grids + (last.layouts - first.layouts) * 2 + 24;
  assert.ok(last.grids <= gridsBound, `live nav grids ${first.grids} -> ${last.grids} (bound ${gridsBound}): ${msg()}`);
  assert.ok(last.paths <= 256 * (last.layouts + 8), `path memos ${last.paths}`);
});
