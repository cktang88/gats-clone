import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILDINGS, LEVELS, WALL_TIERS, ZOM } from '../src/shared/defs.ts';
import { MAPS } from '../src/shared/maps.ts';
import { canRespawn, step } from '../src/shared/sim.ts';
import { repairScrapPerHp } from '../src/shared/sim/build.ts';
import { effectiveStats } from '../src/shared/sim/stats.ts';
import { createWorld, newId, type Player, type World } from '../src/shared/sim/world.ts';
import type { Accounts } from '../src/server/accounts.ts';
import { createRoom } from '../src/server/room.ts';
import { fakeSocket, PISTOL, press, run, spawnAt, TICK_MS } from './helpers.ts';

const X = 1475, Y = 1700;
/** Reads the life afresh, past what an earlier assertion narrowed it to. */
const lifeOf = (p: Player) => p.life;

function nightWorld(): World {
  const w = createWorld('ZOM', 1, 'outpost');
  w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  w.run!.core.hp = 1e9;
  return w;
}

/** Keeps the night from ending while a test runs, with a zombie far off that never reaches anyone. */
function holdNight(w: World) {
  w.zombies.push({ id: newId(w), kind: 'walker', x: 60, y: 60, hp: 1e9, attackAt: Infinity, vx: 0, vy: 0 });
}

function downByBite(w: World, p: Player) {
  if (p.life.k === 'alive') p.life.hp = 1;
  w.zombies.push({ id: newId(w), kind: 'walker', x: p.x, y: p.y + 30, hp: 1e9, attackAt: 0, vx: 0, vy: 0 });
  step(w, TICK_MS);
  w.zombies.pop();
}

test('a fatal bite downs a squad player: they crawl, cannot shoot, and the horde leaves them be', () => {
  const w = nightWorld();
  holdNight(w);
  const p = spawnAt(w, X, Y);
  downByBite(w, p);
  assert.equal(p.life.k, 'downed');
  assert.ok(w.events.some((e) => e.e === 'life' && e.k === 'downed' && e.id === p.id));

  press(w, p, { down: true, fire: true, shots: p.input.shots + 1 });
  run(w, 1000);
  const crawl = effectiveStats(p).speed * ZOM.crawlMul;
  assert.ok(Math.abs(p.y - Y - crawl) < 5, `crawled ${(p.y - Y).toFixed(0)}px in a second, expected about ${crawl.toFixed(0)}`);
  assert.equal(w.bullets.length, 0, 'no shots from the ground');

  const z = { id: newId(w), kind: 'walker' as const, x: p.x, y: p.y + 40, hp: 1e9, attackAt: 0, vx: 0, vy: 0 };
  w.zombies.push(z);
  press(w, p, {});
  run(w, 1000);
  assert.ok(Math.hypot(z.x - p.x, z.y - p.y) > 60, 'the zombie walked off toward the core');
});

test('a squadmate holding use beside a downed player for the revive time gets them up, keeping what they earned', () => {
  const w = nightWorld();
  holdNight(w);
  const p = spawnAt(w, X, Y);
  const mate = spawnAt(w, X + 40, Y);
  p.score = LEVELS[2].score;
  p.level = 2;
  p.gun = 'handCannon';
  downByBite(w, p);

  press(w, mate, { use: true });
  run(w, ZOM.reviveMs / 2);
  press(w, mate, {});
  run(w, TICK_MS * 2);
  press(w, mate, { use: true });
  run(w, ZOM.reviveMs - 200);
  assert.equal(p.life.k, 'downed', 'letting go restarts the revive');
  run(w, 400);
  const life = lifeOf(p);
  assert.equal(life.k === 'alive' && life.hp, effectiveStats(p).maxHp * ZOM.reviveHpFrac);
  assert.deepEqual({ score: p.score, level: p.level, gun: p.gun }, { score: LEVELS[2].score, level: 2, gun: 'handCannon' });
  assert.equal(w.run!.stats.get(mate.id)?.revives, 1);
});

test('use held out of reach revives nobody', () => {
  const w = nightWorld();
  holdNight(w);
  const p = spawnAt(w, X, Y);
  const mate = spawnAt(w, X + ZOM.reviveRange + 20, Y);
  downByBite(w, p);
  press(w, mate, { use: true });
  run(w, ZOM.reviveMs + 500);
  assert.equal(p.life.k, 'downed');
});

test('a downed player nobody revives bleeds out, then gets up at the core when dawn comes', () => {
  const w = nightWorld();
  holdNight(w);
  const p = spawnAt(w, X, Y + 600);
  p.score = LEVELS[1].score;
  p.level = 1;
  downByBite(w, p);
  run(w, ZOM.bleedOutMs - 500);
  assert.equal(p.life.k, 'downed');
  run(w, 1000);
  assert.equal(lifeOf(p).k, 'dead');
  assert.equal(p.deaths, 1);
  run(w, 5000);
  assert.ok(!canRespawn(w, p.id), 'no respawn before dawn');

  w.zombies = [];
  run(w, TICK_MS);
  assert.equal(w.run!.phase.k, 'day');
  assert.equal(lifeOf(p).k, 'alive');
  const core = MAPS.outpost.siege!.core;
  assert.ok(Math.hypot(p.x - core.x, p.y - core.y) <= 2 * ZOM.coreHalf + 2 * ZOM.cell, `back at the core, at ${p.x},${p.y}`);
  assert.deepEqual({ score: p.score, level: p.level }, { score: LEVELS[1].score, level: 1 });
});

test('holding use beside a damaged wall mends it for scrap, and stops when the scrap runs out', () => {
  const w = nightWorld();
  holdNight(w);
  // An assault rifle mends at the plain rate; a sidearm would mend faster (`ZombieRole.mend`).
  const p = spawnAt(w, X, Y, { loadout: { weapon: 'assault' } });
  const wall = { id: newId(w), kind: 'wall' as const, cx: Math.floor(X / ZOM.cell), cy: Math.floor((Y + 150) / ZOM.cell), hp: 100 };
  w.buildings.push(wall);
  w.buildingsVersion++;
  w.run!.scrap = 10;
  press(w, p, { use: true });
  run(w, 1000);
  const mended = wall.hp - 100;
  const rate = ZOM.repairHpPerSec * WALL_TIERS[0].repairMul;
  assert.ok(Math.abs(mended - rate) <= rate * TICK_MS / 1000 + 0.01, `mended ${mended}`);
  assert.ok(Math.abs(10 - w.run!.scrap - mended * repairScrapPerHp('wall')) < 1e-6);

  w.run!.scrap = 0;
  const before = wall.hp;
  run(w, 1000);
  assert.equal(wall.hp, before, 'no scrap, no repair');

  w.run!.scrap = 1000;
  run(w, 60_000);
  assert.equal(wall.hp, BUILDINGS.wall.hp, 'mends to full and no further');

  const far = { ...wall, id: newId(w), cy: wall.cy + Math.ceil(ZOM.reachPx / ZOM.cell) + 1, hp: 100 };
  w.buildings.push(far);
  run(w, 1000);
  assert.equal(far.hp, 100, 'out of reach');
});

test('holding use by the worn core mends it for scrap at the core\'s dearer rate, by night as by day, up to full', () => {
  const w = nightWorld();
  holdNight(w);
  const core = MAPS.outpost.siege!.core;
  const p = spawnAt(w, core.x, core.y + ZOM.reachPx - 20, { loadout: { weapon: 'assault' } });
  w.run!.core.hp = ZOM.coreHp - 500;
  w.run!.scrap = 1000;
  press(w, p, { use: true });
  run(w, 1000);
  const mended = w.run!.core.hp - (ZOM.coreHp - 500);
  assert.ok(Math.abs(mended - ZOM.repairHpPerSec) <= ZOM.repairHpPerSec * TICK_MS / 1000 + 0.01, `mended ${mended}`);
  assert.ok(Math.abs(1000 - w.run!.scrap - mended * ZOM.coreRepairScrapPerHp) < 1e-6, 'at the core\'s rate');
  run(w, 60_000);
  assert.equal(w.run!.core.hp, ZOM.coreHp, 'to full and no further');

  w.run!.core.hp = ZOM.coreHp - 500;
  p.y = core.y + ZOM.reachPx + 20;
  run(w, 1000);
  assert.equal(w.run!.core.hp, ZOM.coreHp - 500, 'out of reach');
});

test('dawn gets a downed player up too', () => {
  const w = nightWorld();
  holdNight(w);
  const p = spawnAt(w, X, Y);
  downByBite(w, p);
  w.zombies = [];
  run(w, TICK_MS);
  assert.equal(w.run!.phase.k, 'day');
  assert.equal(lifeOf(p).k, 'alive');
});

test('a human who joins or rejoins by night sits out until dawn, so leaving cannot skip going down; by day they join on their feet', (t) => {
  const accounts = { stats: () => null, nameForToken: () => null, credit: () => {} } as unknown as Accounts;
  const room = createRoom('z-test', 'ZOM', 1, accounts);
  const w = room.world;
  const join = () => {
    const ws = fakeSocket();
    room.connect(ws.socket);
    t.after(ws.close);
    ws.send({ t: 'join', name: 'Ann', loadout: PISTOL, aspect: 1.5 });
    const welcome = ws.sent.find((m) => m.t === 'welcome');
    return { ws, p: w.players.get(welcome?.t === 'welcome' ? welcome.id : -1)! };
  };
  const first = join();
  assert.equal(first.p.life.k, 'alive', 'joins on their feet by day');

  w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  w.run!.core.hp = 1e9;
  holdNight(w);
  downByBite(w, first.p);
  assert.equal(first.p.life.k, 'downed');
  first.ws.close();

  const back = join();
  assert.deepEqual(back.p.life, { k: 'dead', respawnAt: Infinity }, 'back as out of the fight, not at full health');
  back.ws.send({ t: 'respawn', loadout: PISTOL });
  assert.equal(lifeOf(back.p).k, 'dead', 'no respawning out of it');

  w.zombies = [];
  room.tick();
  assert.equal(w.run!.phase.k, 'day');
  assert.equal(lifeOf(back.p).k, 'alive', 'up at dawn');
});

test('a player who bleeds out at night is sent back from the Bastion after a wait, for survivors, and waits for dawn once too few are left', () => {
  const w = nightWorld();
  holdNight(w);
  const p = spawnAt(w, X, Y + 600);
  downByBite(w, p);
  w.zombies = w.zombies.filter((z) => z.attackAt === Infinity);
  run(w, ZOM.bleedOutMs + 500);
  assert.equal(lifeOf(p).k, 'dead');
  const before = w.run!.survivors;
  run(w, ZOM.reinforce.ms - 1000);
  assert.equal(lifeOf(p).k, 'dead', 'not before the wait');
  run(w, 1500);
  assert.equal(lifeOf(p).k, 'alive', 'back after the wait');
  const core = MAPS.outpost.siege!.core;
  assert.ok(Math.hypot(p.x - core.x, p.y - core.y) < 200, 'at the Bastion');
  const cost = ZOM.reinforce.survivors(w.run!.night);
  assert.equal(w.run!.survivors, before - cost);
  assert.equal(w.run!.lost, cost);
  assert.ok(ZOM.reinforce.survivors(10) > ZOM.reinforce.survivors(1), 'and sending one back costs more the later the night');

  w.run!.survivors = cost - 1;
  downByBite(w, p);
  w.zombies = w.zombies.filter((z) => z.attackAt === Infinity);
  run(w, ZOM.bleedOutMs + ZOM.reinforce.ms + 1000);
  assert.equal(lifeOf(p).k, 'dead', 'too few left to send');
  assert.equal(w.run!.survivors, cost - 1);
  assert.equal(w.run!.phase.k, 'night', 'and the run goes on');
});
