/// <reference types="node" />
/**
 * Chat commands exercise UI states: /die, /level, /win, /walls.
 *
 *   npm run build && node scripts/mock-server.ts [port]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { ABILITY_COOLDOWN_MS, ARMOR_IDS, ARMORS, EVOLUTIONS, GUNS, isPerkId, loadoutWalkMul, PERK_TIERS, WORLD, type AbilityId, type GunId, type ModeId, type PendingPick } from '../src/shared/defs.ts';
import {
  parseClientMsg, type BulletView, type GameEvent, type InputState, type Loadout, type PlayerView, type ServerMsg,
  type Snapshot, type ThrownView, type WallView, type ZoneView,
} from '../src/shared/protocol.ts';
import { viewMulFor } from '../src/shared/sim/stats.ts';

const PORT = Number(process.argv[2] ?? 8787);
const ROOT = join(import.meta.dirname, '..', 'public');
const ROOMS: { id: string; mode: ModeId }[] = [{ id: '1', mode: 'FFA' }, { id: '2', mode: 'TDM' }, { id: '3', mode: 'DOM' }];
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };
const SIZE = 3000;
const DT = 1 / WORLD.tickHz;
const GRENADE_FUSE_MS = 900;

const WALLS: WallView[] = [
  { x: 1300, y: 1200, w: 400, h: 40, built: false, material: 'concrete' },
  { x: 1300, y: 1760, w: 400, h: 40, built: false, material: 'concrete' },
  { x: 900, y: 1300, w: 40, h: 400, built: false, material: 'concrete' },
  { x: 2060, y: 1300, w: 40, h: 400, built: false, material: 'concrete' },
];

const json = (res: import('node:http').ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api/servers') return json(res, ROOMS.map((r) => ({ id: r.id, mode: r.mode, players: 7, humans: 1 })));
  if (url.pathname === '/api/login' || url.pathname === '/api/register') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { name, password } = JSON.parse(body || '{}');
    if (!name || !password) return json(res, { error: 'Name and password required' });
    if (password === 'wrong') return json(res, { error: 'Invalid name or password' });
    return json(res, { token: `mock-${name}`, name });
  }
  if (url.pathname.startsWith('/api/stats/')) {
    const name = decodeURIComponent(url.pathname.slice('/api/stats/'.length));
    return json(res, { name, kills: 42, deaths: 17, score: 6400, games: 9, best: 1800 });
  }
  if (url.pathname === '/api/leaderboard') return json(res, []);
  const file = normalize(join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(ROOT)) return json(res, { error: 'not found' }, 404);
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    json(res, { error: 'not found' }, 404);
  }
});

type Bot = PlayerView & { phase: number; orbit: number; cx: number; cy: number; cooldown: number };

function makeWorld(mode: ModeId) {
  const teams = mode !== 'FFA';
  const bots: Bot[] = Array.from({ length: 6 }, (_, i): Bot => ({
    id: 100 + i, name: ['Ash', 'Birch', 'Cedar', 'Dune', 'Ember', 'Frost'][i]!, x: 0, y: 0, angle: 0,
    hp: 100, maxHp: 100,
    color: (['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const)[i]!, gun: (['pistol', 'heavySmg', 'shotgun', 'battleRifle', 'sniper', 'juggernaut'] as const)[i]!,
    team: teams ? (i % 2 ? 'blue' : 'red') : null, alive: true, hidden: i === 4, shield: i === 2, dashing: false,
    score: 50 * i, level: 1, armorTier: ARMOR_IDS[i % 4]!, kind: 'bot', hunted: i === 5, phase: i, orbit: 220 + 40 * i, cx: 1500 + (i % 3 - 1) * 250, cy: 1500 + (i < 3 ? -150 : 150), cooldown: 0,
  }));
  const crates = Array.from({ length: 12 }, (_, i) => ({ id: 500 + i, x: 1100 + (i % 4) * 260, y: 1050 + Math.floor(i / 4) * 450, hp: WORLD.crateHp * ((i % 3) + 1) / 3, size: 50 }));
  const zones: ZoneView[] = mode === 'DOM'
    ? [{ id: 1, x: 1000, y: 1000, r: 160, owner: 'red', capturing: null, progress: 1 }, { id: 2, x: 1500, y: 1500, r: 160, owner: null, capturing: 'blue', progress: 0.4 }, { id: 3, x: 2000, y: 2000, r: 160, owner: 'blue', capturing: null, progress: 1 }]
    : [];
  return { mode, bots, crates, zones, walls: [...WALLS], tick: 0, bulletId: 1 };
}

const wss = new WebSocketServer({ noServer: true });
http.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => serve(ws, ROOMS.find((r) => r.id === url.searchParams.get('room'))?.mode ?? 'FFA'));
});

function serve(ws: WebSocket, mode: ModeId) {
  const out = (m: ServerMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  const w = makeWorld(mode);
  const myId = 1;
  let loadout: Loadout | null = null;
  let name = 'You';
  let input: InputState | null = null;
  let ackSeq = 0;
  const me = { x: 1500, y: 1350, hp: 100, alive: true, score: 90, kills: 0, deaths: 0, respawnAt: 0, ammo: 12, reloadUntil: 0, fireAt: 0, abilityAt: 0, dashUntil: 0 };
  const perks: Snapshot['self']['perks'] = {};
  let pending: PendingPick | null = { level: 1, k: 'perk', tier: 1 };
  let gun: GunId = 'pistol';
  let ability: AbilityId | null = null;
  let winnerUntil = 0;
  let bullets: (BulletView & { life: number })[] = [];
  let thrown: ThrownView[] = [];
  const fuseEndsAt = new Map<number, number>();
  let events: GameEvent[] = [];

  ws.on('message', (raw) => {
    const msg = parseClientMsg(String(raw));
    if (!msg) return;
    switch (msg.t) {
      case 'join':
        loadout = msg.loadout;
        name = msg.name;
        gun = loadout.weapon;
        me.ammo = GUNS[gun].mag;
        out({ t: 'welcome', id: myId, mode, worldSize: SIZE, walls: w.walls, account: msg.token?.startsWith('mock-') ? msg.token.slice('mock-'.length) : null });
        out({ t: 'chat', from: 'Ash', text: 'gl hf', team: w.bots[0]!.team });
        return;
      case 'input': input = msg.input; ackSeq = msg.seq; return;
      case 'pick': {
        if (msg.level !== pending?.level) return;
        const option = msg.option;
        if (pending.k === 'evolve') {
          const next = EVOLUTIONS[gun].find((g) => g === option);
          if (next) { gun = next; me.ammo = GUNS[gun].mag; pending = null; }
          return;
        }
        if (!isPerkId(option)) return;
        if (pending.tier === 1) perks[1] = PERK_TIERS[1].find((p) => p === option);
        if (pending.tier === 2) perks[2] = PERK_TIERS[2].find((p) => p === option);
        if (pending.tier === 3) { perks[3] = PERK_TIERS[3].find((p) => p === option); ability = perks[3] ?? null; }
        pending = null;
        return;
      }
      case 'respawn':
        if (!me.alive && Date.now() >= me.respawnAt) { loadout = msg.loadout; gun = loadout.weapon; Object.assign(me, { alive: true, hp: 100, x: 1500, y: 1350, ammo: GUNS[gun].mag }); }
        return;
      case 'chat': {
        const cmd = msg.text;
        if (cmd === '/die') { me.alive = false; me.deaths++; me.respawnAt = Date.now() + WORLD.respawnMs; events.push({ e: 'kill', killer: 'Ember', victim: name, killerId: 104, victimId: myId, weapon: 'Bolt-action', bounty: false, assisters: [], ended: 0, revenge: false }); }
        else if (cmd === '/level') pending = !perks[2] ? { level: 3, k: 'perk', tier: 2 } : { level: 4, k: 'perk', tier: 3 };
        else if (cmd === '/evolve') pending = { level: GUNS[gun].stage === 0 ? 2 : 5, k: 'evolve' };
        else if (cmd === '/win') winnerUntil = Date.now() + WORLD.roundRestartMs;
        else if (cmd === '/walls') { w.walls.push({ x: me.x + 60, y: me.y - 60, w: 30, h: 120, built: true }); out({ t: 'walls', worldSize: SIZE, walls: w.walls }); }
        else out({ t: 'chat', from: name, text: cmd, team: mode === 'FFA' ? null : 'red' });
        return;
      }
    }
  });

  const timer = setInterval(() => {
    if (!loadout) return;
    const now = Date.now();
    w.tick++;
    const weapon = GUNS[gun];
    const speed = WORLD.baseSpeed * loadoutWalkMul(weapon, loadout.armor) * (me.dashUntil > now ? 2.4 : 1);
    if (me.alive && input) {
      const dx = Number(input.right) - Number(input.left);
      const dy = Number(input.down) - Number(input.up);
      const len = Math.hypot(dx, dy) || 1;
      me.x = Math.max(30, Math.min(SIZE - 30, me.x + (dx / len) * speed * DT));
      me.y = Math.max(30, Math.min(SIZE - 30, me.y + (dy / len) * speed * DT));
      if (me.reloadUntil && now >= me.reloadUntil) { me.reloadUntil = 0; me.ammo = weapon.mag; }
      if (input.reload && !me.reloadUntil && me.ammo < weapon.mag) me.reloadUntil = now + weapon.reloadMs;
      if (input.fire && !me.reloadUntil && now >= me.fireAt && me.ammo > 0) {
        me.fireAt = now + weapon.fireMs;
        me.ammo--;
        if (me.ammo === 0) me.reloadUntil = now + weapon.reloadMs;
        for (let p = 0; p < weapon.pellets; p++) {
          const a = input.angle + (Math.random() - 0.5) * weapon.spread;
          bullets.push({ id: w.bulletId++, x: me.x + Math.cos(a) * 40, y: me.y + Math.sin(a) * 40, vx: Math.cos(a) * weapon.bulletSpeed, vy: Math.sin(a) * weapon.bulletSpeed, owner: myId, gun, life: weapon.range / weapon.bulletSpeed });
        }
        events.push({ e: 'shot', x: me.x, y: me.y, angle: input.angle, silenced: false, owner: myId, gun });
      }
      if (input.ability && ability && now >= me.abilityAt) {
        me.abilityAt = now + ABILITY_COOLDOWN_MS[ability];
        if (ability === 'dash') me.dashUntil = now + 250;
        else {
          fuseEndsAt.set(w.bulletId, now + GRENADE_FUSE_MS);
          thrown.push({ id: w.bulletId++, kind: ability === 'landMine' ? 'landMine' : ability === 'gasGrenade' ? 'gasGrenade' : ability === 'fragGrenade' ? 'fragGrenade' : 'grenade', x: me.x + Math.cos(input.angle) * Math.min(400, input.aimDist), y: me.y + Math.sin(input.angle) * Math.min(400, input.aimDist), r: 140, owner: myId });
        }
      }
    }

    for (const b of w.bots) {
      b.phase += DT * (0.4 + (b.id % 3) * 0.15);
      b.x = b.cx + Math.cos(b.phase) * b.orbit;
      b.y = b.cy + Math.sin(b.phase) * b.orbit;
      b.angle = Math.atan2(me.y - b.y, me.x - b.x);
      b.dashing = b.id === 105 && Math.sin(b.phase * 3) > 0.7;
      if (now >= b.cooldown && Math.hypot(me.x - b.x, me.y - b.y) < 700) {
        b.cooldown = now + 900 + (b.id % 3) * 300;
        bullets.push({ id: w.bulletId++, x: b.x, y: b.y, vx: Math.cos(b.angle) * 1400, vy: Math.sin(b.angle) * 1400, owner: b.id, gun: b.gun, life: 0.5 });
      }
    }

    bullets = bullets.filter((b) => {
      b.x += b.vx * DT; b.y += b.vy * DT; b.life -= DT;
      if (b.owner === myId) {
        const hit = w.bots.find((bot) => Math.hypot(bot.x - b.x, bot.y - b.y) < WORLD.playerRadius);
        if (hit) {
          events.push({ e: 'dmg', attacker: myId, victim: hit.id, amount: weapon.damage, x: hit.x, y: hit.y, kind: 'player' });
          hit.hp -= weapon.damage;
          if (hit.hp <= 0) { hit.hp = hit.maxHp; me.score += WORLD.killScore; me.kills++; events.push({ e: 'kill', killer: name, victim: hit.name, killerId: myId, victimId: hit.id, weapon: weapon.name, bounty: hit.hunted, assisters: [], ended: 0, revenge: false }); }
          return false;
        }
      }
      return b.life > 0;
    });
    const clouds: ThrownView[] = [];
    thrown = thrown.filter((t) => {
      if (t.kind === 'gasCloud') { t.r -= 0.5; return t.r > 20; }
      if (t.kind === 'landMine') return true;
      if (now < (fuseEndsAt.get(t.id) ?? 0)) return true;
      events.push({ e: 'boom', x: t.x, y: t.y, r: t.r });
      if (t.kind === 'gasGrenade') clouds.push({ ...t, id: w.bulletId++, kind: 'gasCloud', r: 160 });
      return false;
    }).concat(clouds);
    if (me.alive && me.hp < 100) me.hp = Math.min(100, me.hp + WORLD.regenPerSec * DT);
    if (w.tick % 90 === 0 && me.alive) { me.hp = Math.max(1, me.hp - 15); events.push({ e: 'dmg', attacker: 101, victim: myId, amount: 15, x: me.x, y: me.y, kind: 'player' }); }
    if (w.tick % 150 === 0) events.push({ e: 'kill', killer: 'Birch', victim: 'Cedar', killerId: 101, victimId: 102, weapon: 'Juggernaut', bounty: true, assisters: [], ended: 0, revenge: false });

    const selfView: PlayerView = {
      id: myId, name, x: me.x, y: me.y, angle: input?.angle ?? 0, hp: me.hp, maxHp: 100,
      color: loadout.color, gun,
      team: mode === 'FFA' ? null : 'red', alive: me.alive, hidden: false, shield: perks[2] === 'shield', dashing: me.dashUntil > now,
      score: me.score, level: 1, armorTier: loadout.armor, kind: 'human', hunted: GUNS[gun].stage === 2,
    };
    const players: PlayerView[] = [selfView, ...w.bots.map(({ phase, orbit, cx, cy, cooldown, ...p }) => p)];
    const winner = winnerUntil > now ? (mode === 'FFA' ? { name, id: myId, note: null } : { name: 'Red team', id: null, note: null }) : null;
    out({
      t: 'snap', tick: w.tick, ackSeq,
      self: {
        id: myId, ammo: me.ammo, mag: weapon.mag, speed: WORLD.baseSpeed * weapon.moveMul, reloading: me.reloadUntil > 0, reloadFrac: 0, perks: { ...perks }, pending,
        ability, abilityReadyIn: Math.max(0, me.abilityAt - now), alive: me.alive, dash: null, respawnIn: me.alive ? 0 : Math.max(0, me.respawnAt - now),
        kills: me.kills, deaths: me.deaths, viewRadius: WORLD.viewRadius * viewMulFor(gun, perks), suppression: 0, streak: me.kills, nemesis: null,
      },
      players,
      bullets: bullets.map(({ life, ...b }) => b),
      crates: w.crates, thrown, zones: w.zones,
      minimap: w.bots.filter((b) => b.id % 2).map((b) => ({ x: b.x, y: b.y, team: b.team, pingAge: b.hunted ? now % 2500 : null })),
      leaderboard: players.map((p) => ({ id: p.id, name: p.name, score: p.score, kills: p.id === myId ? me.kills : 0, deaths: p.id === myId ? me.deaths : 0, team: p.team })),
      match: { mode, map: 'Boneyard', nextMap: 'Old Town', mapChangeIn: Math.max(0, winnerUntil - now), teamScore: { red: 23, blue: 31 }, winner, restartIn: Math.max(0, winnerUntil - now), roundEndsAt: null },
      events,
    });
    events = [];
  }, 1000 / WORLD.tickHz);
  ws.on('close', () => clearInterval(timer));
}

http.listen(PORT, () => console.log(`mock server on http://localhost:${PORT}`));
