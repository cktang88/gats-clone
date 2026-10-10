/// <reference types="node" />
// Usage: node scripts/measure-bandwidth.ts [humans=6] [seconds=8] [room=ffa]
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { WORLD } from '../src/shared/defs.ts';
import { startServer } from '../src/server/main.ts';
import { median, quantile } from './lib/stats.ts';

const humans = Number(process.argv[2] ?? 6);
const seconds = Number(process.argv[3] ?? 8);
const room = process.argv[4] ?? 'ffa';
const WARMUP_MS = 1500;
let seed = 12345;
const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

const dataDir = await mkdtemp(join(tmpdir(), 'skirmish-bw-'));
const server = await startServer({ port: 0, dataDir, limits: { humansPerRoom: humans + 1, socketsPerIp: humans + 1, messagesPerSec: 1000, messageBurst: 1000 } });

type Tally = { bytes: number; snaps: number; fields: Map<string, number>; snapAt: number[] };
const tallies: Tally[] = [];
let measuring = false;
const sockets: WebSocket[] = [];

for (let i = 0; i < humans; i++) {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws?room=${room}`);
  const tally: Tally = { bytes: 0, snaps: 0, fields: new Map(), snapAt: [] };
  tallies.push(tally);
  sockets.push(ws);
  let seq = 0, shots = 0;
  let dir = { up: false, down: false, left: false, right: false };
  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'join', name: `Bw${i}`, loadout: { weapon: 'smg', armor: 'light', color: 'blue' } }));
    setInterval(() => {
      if (seq % 45 === 0) dir = { up: random() < 0.5, down: random() < 0.3, left: random() < 0.5, right: random() < 0.3 };
      const fire = seq % 20 < 6;
      if (seq % 20 === 0) shots++;
      ws.send(JSON.stringify({ t: 'input', seq: ++seq, input: { ...dir, angle: seq / 10, aimDist: 300, fire, shots, reload: false, ability: false } }));
      if (seq % 90 === 0) ws.send(JSON.stringify({ t: 'respawn', loadout: { weapon: 'smg', armor: 'light', color: 'blue' } }));
    }, 1000 / 30);
  });
  ws.on('message', (data: Buffer) => {
    if (!measuring) return;
    tally.bytes += data.length;
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    if (msg.t !== 'snap') return;
    tally.snaps++;
    tally.snapAt.push(performance.now());
    for (const [k, v] of Object.entries(msg)) tally.fields.set(k, (tally.fields.get(k) ?? 0) + JSON.stringify(v).length + k.length + 4);
  });
}

await new Promise((r) => setTimeout(r, WARMUP_MS));
// What crossed the socket, frames and any permessage-deflate compression included, as against the decoded messages tallied below.
const socketBytes = () => sockets.reduce((n, ws) => n + ((ws as unknown as { _socket?: { bytesRead: number } })._socket?.bytesRead ?? 0), 0);
const readBefore = socketBytes();
const cpuBefore = process.cpuUsage();
measuring = true;
await new Promise((r) => setTimeout(r, seconds * 1000));
measuring = false;
const onWire = (socketBytes() - readBefore) / sockets.length / seconds;
const cpu = process.cpuUsage(cpuBefore);

const perClient = tallies.map((t) => t.bytes / seconds);
const avg = perClient.reduce((a, b) => a + b, 0) / perClient.length;
const snaps = tallies.reduce((a, t) => a + t.snaps, 0);
const fields = new Map<string, number>();
for (const t of tallies) for (const [k, v] of t.fields) fields.set(k, (fields.get(k) ?? 0) + v);
console.log(`room=${room} humans=${humans} players>=${Math.max(humans, WORLD.minPlayers)} seconds=${seconds}`);
console.log(`bytes/sec per client: avg ${(avg / 1024).toFixed(1)} KB/s, min ${(Math.min(...perClient) / 1024).toFixed(1)}, max ${(Math.max(...perClient) / 1024).toFixed(1)}`);
console.log(`on the wire per client: ${(onWire / 1024).toFixed(1)} KB/s (${server.deflate ? 'permessage-deflate' : 'uncompressed'})`);
console.log(`process CPU (server and these clients): ${(((cpu.user + cpu.system) / 1000 / (seconds * 1000)) * 100).toFixed(1)}% of a core`);
console.log(`snapshots/sec per client: ${(snaps / tallies.length / seconds).toFixed(1)}, avg snapshot ${(avg * seconds / (snaps / tallies.length)).toFixed(0)} B`);
const gaps = tallies.flatMap((t) => t.snapAt.slice(1).map((at, i) => at - t.snapAt[i]!));
console.log(`snapshot arrival gaps: median ${median(gaps).toFixed(1)}ms p95 ${quantile(gaps, 0.95).toFixed(1)}ms max ${quantile(gaps, 1).toFixed(1)}ms`);
console.log('avg bytes per snapshot by field:');
for (const [k, v] of [...fields].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${(v / snaps).toFixed(0)}`);

for (const ws of sockets) ws.terminate();
await server.close();
await rm(dataDir, { recursive: true, force: true });
process.exit(0);
