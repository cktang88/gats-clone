import { randomBytes, randomInt } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import { WORLD, type ModeId } from '../shared/defs.ts';
import { cleanName } from '../shared/protocol.ts';
import { openAccounts, type Accounts } from './accounts.ts';
import { loadModerator } from './moderation.ts';
import { LIMITS, makeKeyedLimiter, type Limits } from './limits.ts';
import { createRoom, type Room } from './room.ts';

export type ServerOptions = { port: number; dataDir: string; publicDir?: string; stepsPerTick?: number; limits?: Partial<Limits>; trustProxy?: boolean };
export type RunningServer = { port: number; rooms: ReadonlyMap<string, Room>; close(): Promise<void> };

const PUBLIC_DIR = resolve(import.meta.dirname, '../../public');
const MAX_BODY = 4096;
const ROOM_MODES: [string, ModeId][] = [['ffa', 'FFA'], ['tdm', 'TDM'], ['dom', 'DOM']];
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.map': 'application/json', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

function parseCredentials(body: unknown): { name: string; password: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { name, password } = body as Record<string, unknown>;
  if (typeof name !== 'string' || typeof password !== 'string') return null;
  const clean = cleanName(name);
  if (clean !== name.trim() || clean.length < 3 || password.length < 4 || password.length > 128) return null;
  return { name: clean, password };
}

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.map', '.json', '.svg']);
const fileCache = new Map<string, { etag: string; data: Buffer; gz: Buffer | null }>();

async function loadStatic(file: string) {
  const st = await stat(file);
  const etag = `"${st.size.toString(36)}-${st.mtimeMs.toString(36)}"`;
  const hit = fileCache.get(file);
  if (hit?.etag === etag) return hit;
  const data = await readFile(file);
  const entry = { etag, data, gz: COMPRESSIBLE.has(extname(file)) ? gzipSync(data) : null };
  fileCache.set(file, entry);
  return entry;
}

async function serveStatic(publicDir: string, pathname: string, req: IncomingMessage, res: ServerResponse) {
  let file: string;
  try { file = resolve(publicDir, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname)); } catch { file = ''; }
  if (!file.startsWith(publicDir + sep)) { res.writeHead(404).end(); return; }
  try {
    const { etag, data, gz } = await loadStatic(file);
    const headers: Record<string, string> = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers).end(); return; }
    const useGzip = gz !== null && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    if (useGzip) headers['content-encoding'] = 'gzip';
    if (gz !== null) headers.vary = 'accept-encoding';
    res.writeHead(200, headers);
    res.end(useGzip ? gz : data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

type AuthLimiter = (key: string, now: number) => boolean;

const SQUAD_CODE_CHARS = 'abcdefghijklmnopqrstuvwxyz234567';
const squadCode = () => `z-${[...randomBytes(6)].map((b) => SQUAD_CODE_CHARS[b % 32]).join('')}`;

type Rooms = { all: Map<string, Room>; openSquad(): string | null };
type IpOf = (req: IncomingMessage) => string;

const socketIp: IpOf = (req) => req.socket.remoteAddress ?? '';
// Clients can send their own X-Forwarded-For; the one trusted proxy appends the address it saw, so only the last entry is real.
const forwardedIp: IpOf = (req) => {
  const header = req.headers['x-forwarded-for'];
  const last = (Array.isArray(header) ? header.at(-1) : header)?.split(',').at(-1)?.trim();
  return last || socketIp(req);
};

async function route(req: IncomingMessage, res: ServerResponse, rooms: Rooms, accounts: Accounts, publicDir: string, allowAuth: AuthLimiter, allowSquad: AuthLimiter, ipOf: IpOf) {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true, rooms: rooms.all.size });
  if (req.method === 'GET' && path === '/api/servers') return json(res, 200, [...rooms.all.values()].map((r) => r.info()).filter((info) => info.mode !== 'ZOM'));
  if (req.method === 'POST' && path === '/api/squads') {
    if (!allowSquad(ipOf(req), Date.now())) return json(res, 429, { error: 'Too many squads. Try again in a minute.' });
    const room = rooms.openSquad();
    return room ? json(res, 200, { room }) : json(res, 503, { error: 'Every squad slot is taken. Try again soon.' });
  }
  if (req.method === 'GET' && path === '/api/leaderboard') return json(res, 200, accounts.leaderboard(20));
  if (req.method === 'GET' && path.startsWith('/api/stats/')) {
    let name: string;
    try { name = decodeURIComponent(path.slice('/api/stats/'.length)); } catch { return json(res, 400, { error: 'Bad player name' }); }
    const stats = accounts.stats(name);
    return stats ? json(res, 200, stats) : json(res, 404, { error: 'No such player' });
  }
  if (req.method === 'POST' && (path === '/api/register' || path === '/api/login')) {
    if (!allowAuth(ipOf(req), Date.now())) return json(res, 429, { error: 'Too many attempts. Try again in a minute.' });
    const creds = parseCredentials(await readBody(req));
    if (!creds) return json(res, 400, { error: 'Name must be 3-16 letters/digits and password at least 4 characters' });
    if (path === '/api/register') {
      const session = await accounts.register(creds.name, creds.password);
      return session ? json(res, 200, session) : json(res, 409, { error: 'Name taken' });
    }
    const session = await accounts.login(creds.name, creds.password);
    return session ? json(res, 200, session) : json(res, 401, { error: 'Wrong name or password' });
  }
  if (path.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
  return serveStatic(publicDir, path, req, res);
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const limits: Limits = { ...LIMITS, ...opts.limits };
  const ipOf = opts.trustProxy ? forwardedIp : socketIp;
  const allowAuth = makeKeyedLimiter(limits.authPerMin / 60, limits.authPerMin);
  const socketsByIp = new Map<string, number>();
  const accounts = await openAccounts(opts.dataDir, limits.sessionMs);
  const moderator = await loadModerator(opts.dataDir);
  const publicDir = opts.publicDir ?? PUBLIC_DIR;
  const allowSquad = makeKeyedLimiter(limits.squadsPerMin / 60, limits.squadsPerMin);
  const newRoom = (id: string, mode: ModeId, seed: number) => createRoom(id, mode, seed, accounts, opts.stepsPerTick ?? 1, limits, moderator);
  const rooms = new Map<string, Room>(ROOM_MODES.map(([id, mode], i) => [id, newRoom(id, mode, 1000 + i)]));
  /** When each squad room last had a human in it; one empty for `squadIdleMs` closes. */
  const squadSeenAt = new Map<string, number>();
  const openSquad = (): string | null => {
    if (squadSeenAt.size >= limits.squadRooms) return null;
    let id = squadCode();
    while (rooms.has(id)) id = squadCode();
    rooms.set(id, newRoom(id, 'ZOM', randomInt(2 ** 31)));
    squadSeenAt.set(id, Date.now());
    return id;
  };
  const closeIdleSquads = (now: number) => {
    for (const [id, seenAt] of squadSeenAt) {
      const room = rooms.get(id)!;
      if (room.info().humans > 0) squadSeenAt.set(id, now);
      else if (now - seenAt >= limits.squadIdleMs) {
        room.close();
        rooms.delete(id);
        squadSeenAt.delete(id);
      }
    }
  };

  const http = createServer((req, res) => {
    route(req, res, { all: rooms, openSquad }, accounts, publicDir, allowAuth, allowSquad, ipOf).catch((err: unknown) => {
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: 'Internal error' });
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  wss.on('error', (err) => console.error('websocket server error', err));
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const room = url.pathname === '/ws' ? rooms.get(url.searchParams.get('room') ?? '') : undefined;
    if (!room) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    const ip = ipOf(req);
    const open = socketsByIp.get(ip) ?? 0;
    if (open >= limits.socketsPerIp) { socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return; }
    socketsByIp.set(ip, open + 1);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.once('close', () => {
        const left = (socketsByIp.get(ip) ?? 1) - 1;
        if (left > 0) socketsByIp.set(ip, left);
        else socketsByIp.delete(ip);
      });
      room.connect(ws);
    });
  });

  // setInterval drifts late every tick (28.8Hz measured), so game time ran slow and snapshot gaps wobbled.
  // Ticks are instead scheduled against the wall clock, catching up when a timer fires late.
  const TICK_MS = 1000 / WORLD.tickHz;
  let nextTickAt = performance.now();
  let timer: NodeJS.Timeout;
  const loop = () => {
    const now = performance.now();
    if (now - nextTickAt > 250) nextTickAt = now;
    while (now >= nextTickAt) {
      for (const r of rooms.values()) r.tick();
      nextTickAt += TICK_MS;
    }
    closeIdleSquads(Date.now());
    timer = setTimeout(loop, nextTickAt - performance.now());
  };
  loop();
  await new Promise<void>((done) => http.listen(opts.port, done));

  return {
    port: (http.address() as AddressInfo).port,
    rooms,
    async close() {
      clearTimeout(timer);
      for (const r of rooms.values()) r.close();
      wss.close();
      http.closeAllConnections();
      await new Promise<void>((done) => http.close(() => done()));
      await accounts.flush();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const port = Number(process.env.PORT ?? 8080);
  const dataDir = process.env.DATA_DIR ?? resolve(import.meta.dirname, '../../data');
  const server = await startServer({ port, dataDir, trustProxy: process.env.TRUST_PROXY === '1' });
  console.log(`Skirmish listening on http://localhost:${server.port}`);
  const shutdown = async (signal: string) => {
    console.log(`${signal}: saving and shutting down`);
    await server.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
