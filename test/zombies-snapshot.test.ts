import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILDINGS, hordeCount, LEVELS, NIGHTS, ZOM, ZOMBIE_KINDS, type ZombieKind } from '../src/shared/defs.ts';
import type { Snapshot, SnapshotWire } from '../src/shared/protocol.ts';
import { step } from '../src/shared/sim.ts';
import { zombieMaxHp } from '../src/shared/sim/run.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { createWorld, newId, type World } from '../src/shared/sim/world.ts';
import { fillSnapshot, makeSnapshotEncoder } from '../src/shared/wire.ts';
import { run, spawnAt, TICK_MS } from './helpers.ts';

const zomWorld = (): World => createWorld('ZOM', 1, 'outpost');

test('a zombies snapshot shows the horde in view as compact tuples, the squad walls and the run', () => {
  const w = zomWorld();
  const p = spawnAt(w, 1380, 1500);
  w.buildings.push({ id: newId(w), kind: 'wall', cx: 26, cy: 28, hp: BUILDINGS.wall.hp * 0.35 });
  const near = { id: newId(w), kind: 'brute' as const, x: 1700.4, y: 1500.6, hp: zombieMaxHp('brute', 1, 1) / 2, attackAt: 0, vx: 0, vy: 0 };
  w.zombies.push(near, { id: newId(w), kind: 'walker', x: 60, y: 60, hp: 1, attackAt: 0, vx: 0, vy: 0 });
  const snap = snapshotFor(w, p.id);
  assert.deepEqual(snap.zombies, [[near.id, ZOMBIE_KINDS.indexOf('brute'), 1700, 1501, 5]]);
  assert.deepEqual(snap.buildings, [{ kind: 'wall', cx: 26, cy: 28, hp: 4 }]);
  assert.deepEqual(snap.run, {
    phase: 'day', night: 1, phaseEndsAt: ZOM.dayMs, scrap: ZOM.startScrap, core: { x: 1500, y: 1500, hp: ZOM.coreHp, maxHp: ZOM.coreHp },
    aliveZombies: 2, waveLeft: 2, survivors: ZOM.survivors, lost: 0, ready: [], report: null,
  });
});

test('the run view times the night by its wave and reports the run once the core falls, with a row for everyone', () => {
  const w = zomWorld();
  const p = spawnAt(w, 1380, 1500);
  const idle = spawnAt(w, 1380, 1600);
  run(w, ZOM.dayMs + TICK_MS);
  const night = snapshotFor(w, p.id).run!;
  assert.equal(night.phase, 'night');
  assert.equal(night.phaseEndsAt, null);
  const share = ZOM.hordeShare({ humans: 0, bots: 2 });
  assert.equal(night.waveLeft, Object.entries(NIGHTS[0]!.horde).reduce((n, [k, listed]) => n + hordeCount(k as ZombieKind, listed, share), 0));
  w.run!.stats.set(p.id, { name: p.name, kills: 4, revives: 1, built: 2 });
  const none = { walker: 0, brute: 0, runner: 0, plated: 0, bloater: 0, colossus: 0 };
  w.run!.turretKills = { sentry: { ...none, walker: 7, brute: 1 }, cannon: { ...none, brute: 2 }, scatter: { ...none, runner: 3 }, mortar: none, tesla: none };
  w.run!.bastionKills = 5;
  w.run!.core.hp = 0;
  step(w, TICK_MS);
  const over = snapshotFor(w, p.id).run!;
  assert.equal(over.phase, 'over');
  assert.equal(over.phaseEndsAt, w.now + ZOM.restartMs);
  assert.deepEqual(over.report, {
    night: 1, won: false, survivors: 0, durationMs: w.now, players: [{ name: p.name, kills: 4, revives: 1, built: 2 }, { name: idle.name, kills: 0, revives: 0, built: 0 }],
    turretKills: { sentry: 8, cannon: 2, scatter: 3, mortar: 0, tesla: 0 }, bastionKills: 5,
  });
});

test('squadmates see a downed player with the revive and bleed-out clocks; nobody sees one who bled out', () => {
  const w = zomWorld();
  const p = spawnAt(w, 1380, 1500);
  const mate = spawnAt(w, 1380, 1560);
  mate.life = { k: 'downed', bleedOutAt: 9000, reviveProgress: ZOM.reviveMs / 4, hp: 0 };
  assert.deepEqual(snapshotFor(w, p.id).players.find((v) => v.id === mate.id)?.downed, { revive: 0.25, bleedOutAt: 9000 });
  assert.equal(snapshotFor(w, p.id).players.find((v) => v.id === p.id)?.downed, undefined);
  mate.life = { k: 'dead', respawnAt: Infinity };
  assert.equal(snapshotFor(w, p.id).players.some((v) => v.id === mate.id), false);
  assert.equal(snapshotFor(w, mate.id).self.respawnIn, 0, 'a squad death has no respawn clock');
});

test('versus snapshots carry no zombie fields at all', () => {
  const w = createWorld('FFA', 1, 'plaza');
  const p = spawnAt(w, 1500, 1500);
  const snap = snapshotFor(w, p.id);
  assert.deepEqual(['zombies', 'buildings', 'run'].filter((k) => k in snap), []);
});

test('the wire omits unchanged walls and run, rebuilds them, and keeps a snapshot with 200 zombies in view under 6KB', () => {
  const w = zomWorld();
  const p = spawnAt(w, 1380, 1500);
  for (let cx = 24; cx <= 35; cx++) w.buildings.push({ id: newId(w), kind: 'wall', cx, cy: 24, hp: BUILDINGS.wall.hp });
  w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  for (let i = 0; i < ZOM.maxAlive; i++) {
    const a = (i / ZOM.maxAlive) * Math.PI * 2, r = 250 + (i % 7) * 40;
    w.zombies.push({ id: newId(w), kind: i % 9 === 0 ? 'brute' : 'walker', x: 1500 + Math.cos(a) * r * 1.6, y: 1500 + Math.sin(a) * r, hp: 1e6, attackAt: Infinity, vx: 0, vy: 0 });
  }
  const encode = makeSnapshotEncoder();
  let last: Snapshot | null = null;
  const sizes: number[] = [];
  for (let tick = 0; tick < 10; tick++) {
    step(w, TICK_MS);
    const snap = snapshotFor(w, p.id);
    const json = encode(snap);
    const wire = JSON.parse(json) as SnapshotWire;
    if (tick > 0) assert.equal(wire.buildings, undefined, 'unchanged walls are not resent');
    last = fillSnapshot(wire, last);
    assert.deepEqual(last?.buildings, snap.buildings);
    assert.deepEqual(last?.run, JSON.parse(JSON.stringify(snap.run)));
    sizes.push(json.length);
  }
  assert.ok(snapshotFor(w, p.id).zombies!.length >= 190, 'nearly the whole horde is in view');
  const steady = Math.max(...sizes.slice(1));
  assert.ok(steady < 6000, `${steady} bytes per snapshot`);
});

test('each squad player hears only of their own hits on zombies', () => {
  const w = zomWorld();
  const a = spawnAt(w, 1380, 1500);
  const b = spawnAt(w, 1380, 1560);
  w.events = [
    { e: 'dmg', attacker: a.id, victim: 99, amount: 5, x: 1400, y: 1600, kind: 'zombie' },
    { e: 'dmg', attacker: b.id, victim: 98, amount: 5, x: 1400, y: 1600, kind: 'zombie' },
  ];
  const victims = (id: number) => snapshotFor(w, id).events.map((e) => e.e === 'dmg' && e.victim);
  assert.deepEqual([victims(a.id), victims(b.id)], [[99], [98]]);
});

test('a fallen run offers no level-up pick, since the fresh run wipes it', () => {
  const w = zomWorld();
  const p = spawnAt(w, 1380, 1500);
  p.score = LEVELS[1].score;
  p.level = 1;
  assert.notEqual(snapshotFor(w, p.id).self.pending, null, 'offered while the run goes on');
  w.run!.phase = { k: 'over', night: 3, won: false, restartAt: Infinity };
  assert.equal(snapshotFor(w, p.id).self.pending, null);
});
