/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPlayer, step } from '../src/shared/sim.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { barrelRect, coverRects, crateRect, createWorld, propRect, propSolid, rand, solidRects, type World } from '../src/shared/sim/world.ts';
import { cellRect } from '../src/shared/sim/build.ts';
import { makeSnapshotEncoder } from '../src/shared/wire.ts';
import { newBotMemory, randomLoadout, type BotMemory } from '../src/server/bots.ts';
import { thinkBots } from '../src/server/bot/tick.ts';
import { TICK_MS } from './helpers.ts';

/** A full room on a door- and wall-heavy map: one person and 17 bots. */
function fullRoom(map: 'airbase' | 'embassy') {
  const w = createWorld('FFA', 2, map);
  const r = () => rand(w);
  const bots = new Map<number, BotMemory>();
  const me = addPlayer(w, 'me', { weapon: 'assault', armor: 'medium', color: 'blue' }, { kind: 'human' });
  for (let i = 0; i < 17; i++) bots.set(addPlayer(w, `bot${i}`, randomLoadout(r)).id, newBotMemory(r));
  return { w, me, tick: () => { thinkBots(w, bots, r, { watched: true }); step(w, TICK_MS); } };
}

/** The lists as they were built before they were kept: a fresh copy each call. */
const freshCover = (w: World) => [...w.walls, ...w.crates.filter((c) => c.respawnAt === null).map(crateRect), ...w.barrels.filter((b) => b.respawnAt === null).map(barrelRect), ...w.props.filter(propSolid).map(propRect)];

test('the kept cover and solid lists always hold what a fresh build would, as crates break, barrels blow and props fly', () => {
  const { w, tick } = fullRoom('airbase');
  let rebuilt = 0, last = coverRects(w);
  for (let t = 0; t < 900; t++) {
    tick();
    // Knock things about now and then, as fights do.
    if (t % 150 === 40) w.crates[t % w.crates.length]!.respawnAt = w.now + 5000;
    if (t % 150 === 90) { const q = w.props[t % w.props.length]!; q.x += 3; }
    const cover = coverRects(w);
    assert.deepEqual(cover, freshCover(w), `cover at tick ${t}`);
    assert.deepEqual(solidRects(w), [...freshCover(w), ...w.buildings.map((b) => cellRect(b.cx, b.cy))], `solids at tick ${t}`);
    if (cover !== last) rebuilt++;
    last = cover;
  }
  // Built once per change, not once per call: every player's move in a tick shares one list (a swinging door, which replaces
  // `w.walls`, still makes one new list a tick on a door-heavy map).
  assert.equal(coverRects(w), coverRects(w));
  assert.equal(solidRects(w), solidRects(w));
  assert.ok(rebuilt > 6, `the lists were rebuilt ${rebuilt} times in 900 ticks`);
});

test('a snapshot in a full room on a heavy map stays under its byte budget on the wire', () => {
  const { w, me, tick } = fullRoom('embassy');
  const encode = makeSnapshotEncoder();
  let bytes = 0, n = 0;
  for (let t = 0; t < 600; t++) {
    tick();
    if (t < 60) continue;
    bytes += encode(snapshotFor(w, me.id)).length;
    n++;
  }
  // About 1.1 KB today (players, self and rounds every tick; sticky fields only when they change). Before deflate.
  assert.ok(bytes / n < 1800, `average snapshot ${Math.round(bytes / n)} B`);
});

test('with deflate on, the server compresses snapshots on the socket (permessage-deflate), several times smaller than the JSON', { timeout: 30_000 }, async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { default: WebSocket } = await import('ws');
  const { startServer } = await import('../src/server/main.ts');
  const dataDir = await mkdtemp(join(tmpdir(), 'skirmish-deflate-'));
  const server = await startServer({ port: 0, dataDir, deflate: true });
  try {
    assert.equal(server.deflate, true);
    const ws = new WebSocket(`ws://localhost:${server.port}/ws?room=ffa`);
    let decoded = 0, snaps = 0;
    ws.on('message', (m: Buffer) => { decoded += m.length; if (String(m).startsWith('{"t":"snap"')) snaps++; });
    await new Promise((r) => ws.once('open', r));
    assert.ok(ws.extensions.includes('permessage-deflate'), `negotiated: ${ws.extensions}`);
    ws.send(JSON.stringify({ t: 'join', name: 'Squeeze', loadout: { weapon: 'smg', armor: 'light', color: 'blue' } }));
    for (let i = 0; i < 100 && snaps < 30; i++) await new Promise((r) => setTimeout(r, 50));
    const onWire = (ws as unknown as { _socket: { bytesRead: number } })._socket.bytesRead;
    ws.terminate();
    assert.ok(snaps >= 30, `${snaps} snapshots`);
    assert.ok(onWire * 3 < decoded, `${onWire} bytes on the wire for ${decoded} bytes of messages`);
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
