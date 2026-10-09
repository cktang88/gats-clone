/// <reference types="node" />
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { startServer } from '../src/server/main.ts';
import type { Room } from '../src/server/room.ts';

/** Writes `request` on a raw TCP connection and resolves with whatever came back once the server hangs up. */
const raw = (port: number, request: string) => new Promise<string>((resolve) => {
  const sock = connect(port, '127.0.0.1', () => sock.write(request));
  let got = '';
  sock.on('data', (d) => { got += d; });
  sock.on('error', () => {});
  sock.on('close', () => resolve(got));
  // A server that never answers is a failure too, but one the assertions can name.
  sock.setTimeout(2000, () => sock.destroy());
});

const upgradeStatus = (port: number) => new Promise<number>((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=ffa`);
  ws.on('error', () => {});
  ws.once('open', () => { ws.close(); resolve(101); });
  ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
});

test('an upgrade request whose target is not a parseable URL is refused, not a process crash', { timeout: 10_000 }, async () => {
  const server = await startServer({ port: 0, dataDir: await mkdtemp(join(tmpdir(), 'skirmish-badurl-')) });
  try {
    const reply = await raw(server.port, 'GET //[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    assert.match(reply, /^HTTP\/1\.1 4\d\d/, 'the bad upgrade gets a 4xx');
    const res = await fetch(`http://127.0.0.1:${server.port}/api/servers`);
    assert.equal(res.status, 200, 'the server still answers');
  } finally {
    await server.close();
  }
});

test('upgrades that fail the websocket handshake do not use up the address\'s socket allowance', { timeout: 10_000 }, async () => {
  const server = await startServer({ port: 0, dataDir: await mkdtemp(join(tmpdir(), 'skirmish-badhandshake-')), limits: { socketsPerIp: 2 } });
  try {
    // No Sec-WebSocket-Key: ws aborts the handshake with a 400 and never hands back a socket.
    for (let i = 0; i < 3; i++) {
      const reply = await raw(server.port, 'GET /ws?room=ffa HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n');
      assert.match(reply, /^HTTP\/1\.1 400/);
    }
    assert.equal(await upgradeStatus(server.port), 101, 'a real client from the same address still gets in after failed handshakes');
  } finally {
    await server.close();
  }
});

test('a plain request whose target is not a parseable URL gets a 400, not a 500', { timeout: 10_000 }, async () => {
  const server = await startServer({ port: 0, dataDir: await mkdtemp(join(tmpdir(), 'skirmish-badroute-')) });
  try {
    const reply = await raw(server.port, 'GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(reply, /^HTTP\/1\.1 400/);
  } finally {
    await server.close();
  }
});

/** A stand-in room for the tick loop: counts its ticks, throws from them while `throws`, and notes its close. */
function fakeRoom(id: string, throws: boolean) {
  const room = {
    id, ticks: 0, closed: false, throws,
    world: {} as Room['world'],
    connect() {},
    tick() { room.ticks++; if (room.throws) throw new Error(`tick fault in ${id}`); },
    info: () => ({ id, mode: 'FFA' as const, players: 0, humans: 0 }),
    netStats: () => ({ id, mode: 'FFA' as const, humans: 0, players: 0, queues: [], bytes: 0, snaps: 0, skipped: 0, ticked: 0 }),
    forgetGuest() {},
    close() { room.closed = true; },
  };
  return room;
}

test('one room whose tick throws neither stops the loop for the others nor floods the log, and is closed and replaced if it keeps failing', { timeout: 10_000 }, async () => {
  const server = await startServer({ port: 0, dataDir: await mkdtemp(join(tmpdir(), 'skirmish-tickfault-')), limits: { faultyRoomMs: 400 } });
  const logged: unknown[][] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const rooms = server.rooms as Map<string, Room>;
    const bad = fakeRoom('bad', true), good = fakeRoom('good', false);
    rooms.set(bad.id, bad);
    rooms.set(good.id, good);
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(bad.ticks > 3, 'the faulty room is still ticked');
    assert.ok(good.ticks >= bad.ticks - 1, 'the room after it keeps ticking');
    assert.equal(logged.filter((a) => String(a.join(' ')).includes('bad')).length, 1, 'one log line for the room, not one per tick');
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(bad.closed, 'a room failing every tick for faultyRoomMs is closed');
    assert.notEqual(rooms.get('bad'), bad, 'and a fresh room takes its place');
    const ticked = good.ticks;
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(good.ticks > ticked, 'the loop runs on');
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status, 200);
  } finally {
    console.error = error;
    await server.close();
  }
});
