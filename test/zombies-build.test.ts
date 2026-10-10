import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILDINGS, TURRET_KINDS, WORLD, ZOM } from '../src/shared/defs.ts';
import { MAPS } from '../src/shared/maps.ts';
import { parseClientMsg } from '../src/shared/protocol.ts';
import { build, demolish } from '../src/shared/sim/run.ts';
import { circleHitsRect } from '../src/shared/sim/movement.ts';
import { createWorld, newId, solidRects, spawnPoint, type Player, type World } from '../src/shared/sim/world.ts';
import { press, run, spawnAt } from './helpers.ts';
import { repairScrapPerHp } from '../src/shared/sim/build.ts';

/** The builder stands just west of the core; cell (26, 30) is beside them. */
const AT = { x: 1380, y: 1525 }, CELL = { cx: 26, cy: 30 };

function dayWorld() {
  const w = createWorld('ZOM', 1, 'outpost');
  const p = spawnAt(w, AT.x, AT.y);
  return { w, p };
}

test('a wall goes up on a clear cell by day for its cost, counts toward the builder, and blocks the way', () => {
  const { w, p } = dayWorld();
  const scrap = w.run!.scrap, version = w.buildingsVersion;
  assert.equal(build(w, p.id, 'wall', CELL.cx, CELL.cy), null);
  assert.deepEqual(w.buildings.map((b) => [b.kind, b.cx, b.cy, b.hp]), [['wall', CELL.cx, CELL.cy, BUILDINGS.wall.hp]]);
  assert.equal(scrap - w.run!.scrap, BUILDINGS.wall.cost);
  assert.ok(w.buildingsVersion > version);
  assert.equal(w.run!.stats.get(p.id)?.built, 1);
  press(w, p, { left: true });
  run(w, 1000);
  assert.ok(p.x >= (CELL.cx + 1) * ZOM.cell + 24 - 0.01, `walked into the wall to x ${p.x.toFixed(1)}`);
});

const refusals: [string, (w: World, p: Player) => { cx: number; cy: number; by?: { x: number; y: number } }][] = [
  // Only a pistol-class gun builds by night (`ZombieRole.nightBuild`), so the builder holds an SMG.
  ['notDay', (w, p) => { p.gun = 'smg'; w.run!.phase = { k: 'night', toSpawn: [{ kind: 'walker', side: 'north', n: 1 }], nextSpawnAt: Infinity, dawnAt: Infinity }; return CELL; }],
  ['farFromCore', () => ({ cx: 17, cy: 30, by: { x: 17.5 * ZOM.cell + 60, y: 1525 } })],
  ['outOfReach', () => ({ cx: CELL.cx - 5, cy: CELL.cy })],
  ['cover', (w) => { w.walls.push({ x: CELL.cx * ZOM.cell + 10, y: CELL.cy * ZOM.cell, w: 24, h: 140, built: true, expiresAt: Infinity }); return CELL; }],
  ['core', () => ({ cx: 29, cy: 30 })],
  ['body', (w) => { w.zombies.push({ id: newId(w), kind: 'walker', x: (CELL.cx + 0.5) * ZOM.cell, y: CELL.cy * ZOM.cell - 5, hp: 1, attackAt: Infinity, vx: 0, vy: 0 }); return CELL; }],
  ['body', (w) => { spawnAt(w, (CELL.cx + 0.5) * ZOM.cell, (CELL.cy + 0.5) * ZOM.cell); return CELL; }],
  ['taken', (w) => { w.buildings.push({ id: newId(w), kind: 'wall', cx: CELL.cx, cy: CELL.cy, hp: 1 }); return CELL; }],
  ['taken', (w) => {
    w.buildings.push({ id: newId(w), kind: 'wall', cx: CELL.cx, cy: CELL.cy, hp: 1 });
    w.zombies.push({ id: newId(w), kind: 'walker', x: CELL.cx * ZOM.cell - 15, y: (CELL.cy + 0.5) * ZOM.cell, hp: 1, attackAt: Infinity, vx: 0, vy: 0 });
    return CELL;
  }],
  ['scrap', (w) => { w.run!.scrap = BUILDINGS.wall.cost - 1; return CELL; }],
];

for (const [reason, arrange] of refusals) {
  test(`a wall is refused with ${reason}, and nothing is spent`, () => {
    const { w, p } = dayWorld();
    const { cx, cy, by } = arrange(w, p);
    if (by) { p.x = by.x; p.y = by.y; }
    const scrap = w.run!.scrap, walls = w.buildings.length;
    assert.equal(build(w, p.id, 'wall', cx, cy), reason);
    assert.deepEqual([w.run!.scrap, w.buildings.length], [scrap, walls]);
  });
}

test('a wall comes down by day for half its cost back, but not at night without a pistol', () => {
  const { w, p } = dayWorld();
  build(w, p.id, 'wall', CELL.cx, CELL.cy);
  p.gun = 'smg';
  const scrap = w.run!.scrap;
  w.run!.phase = { k: 'night', toSpawn: [{ kind: 'walker', side: 'north', n: 1 }], nextSpawnAt: Infinity, dawnAt: Infinity };
  assert.equal(demolish(w, p.id, CELL.cx, CELL.cy), false);
  w.run!.phase = { k: 'day', endsAt: Infinity };
  assert.equal(demolish(w, p.id, CELL.cx, CELL.cy), true);
  assert.deepEqual([w.buildings.length, w.run!.scrap - scrap], [0, BUILDINGS.wall.cost * ZOM.demolishRefund]);
});

for (const kind of TURRET_KINDS) {
  test(`a ${kind} goes up like a wall for its own cost, loaded and firing for its builder, blocks the way, and comes down for half back`, () => {
    const { w, p } = dayWorld();
    w.run!.scrap = BUILDINGS[kind].cost - 1;
    assert.equal(build(w, p.id, kind, CELL.cx, CELL.cy), 'scrap');
    w.run!.scrap = 1000;
    assert.equal(build(w, p.id, kind, CELL.cx, CELL.cy), null);
    assert.equal(1000 - w.run!.scrap, BUILDINGS[kind].cost);
    assert.deepEqual(w.buildings.map((b) => ({ ...b, id: 0 })), [{ id: 0, kind, cx: CELL.cx, cy: CELL.cy, hp: BUILDINGS[kind].hp, owner: p.id, ammo: BUILDINGS[kind].turret.ammo, nextFireAt: 0 }]);
    assert.equal(build(w, p.id, 'wall', CELL.cx, CELL.cy), 'taken');
    assert.equal(w.run!.stats.get(p.id)?.built, 1);
    press(w, p, { left: true });
    run(w, 1000);
    assert.ok(p.x >= (CELL.cx + 1) * ZOM.cell + 24 - 0.01, `walked into the ${kind} to x ${p.x.toFixed(1)}`);
    const scrap = w.run!.scrap;
    assert.equal(demolish(w, p.id, CELL.cx, CELL.cy), true);
    assert.deepEqual([w.buildings.length, w.run!.scrap - scrap], [0, Math.floor(BUILDINGS[kind].cost * ZOM.demolishRefund)]);
  });
}

test('build and demolish messages carry whole grid cells only', () => {
  assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'build', kind: 'sentry', cx: 3, cy: 59 })), { t: 'build', kind: 'sentry', cx: 3, cy: 59 });
  assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'demolish', cx: 0, cy: 0 })), { t: 'demolish', cx: 0, cy: 0 });
  for (const bad of [{ cx: 1.5, cy: 2 }, { cx: -1, cy: 2 }, { cx: 60, cy: 2 }, { cx: '3', cy: 2 }, { cy: 2 }, { cx: 3, cy: 2, kind: 'tower' }, { cx: 3, cy: 2, kind: undefined }]) {
    assert.equal(parseClientMsg(JSON.stringify({ t: 'build', kind: 'wall', ...bad })), null, JSON.stringify(bad));
  }
});

test('a wall ring over the squad spawn strips sends a squad spawn to clear ground near the core, never into a wall', () => {
  const w = createWorld('ZOM', 1, 'outpost');
  for (let cy = 27; cy <= 32; cy++) for (let cx = 27; cx <= 32; cx++) {
    if (cx === 27 || cx === 32 || cy === 27 || cy === 32) w.buildings.push({ id: newId(w), kind: 'wall', cx, cy, hp: BUILDINGS.wall.hp });
  }
  w.buildingsVersion++;
  for (let i = 0; i < 20; i++) {
    const at = spawnPoint(w, 'red');
    assert.ok(!solidRects(w).some((r) => circleHitsRect(at.x, at.y, WORLD.playerRadius, r)), `spawned inside a solid at ${at.x},${at.y}`);
    assert.ok(Math.hypot(at.x - MAPS.outpost.size / 2, at.y - MAPS.outpost.size / 2) < 300, `spawned far from the core at ${at.x},${at.y}`);
  }
});

test('a squad respawns inside a closed wall ring, not on the far side of it', () => {
  const w = createWorld('ZOM', 1, 'outpost');
  const lo = 27, hi = 32;
  for (let c = lo; c <= hi; c++) for (const [cx, cy] of [[c, lo], [c, hi], [lo, c], [hi, c]] as const) {
    if (!w.buildings.some((b) => b.cx === cx && b.cy === cy)) w.buildings.push({ id: newId(w), kind: 'wall', cx, cy, hp: BUILDINGS.wall.hp });
  }
  w.buildingsVersion++;
  for (let i = 0; i < 30; i++) {
    const at = spawnPoint(w, 'red');
    assert.ok(at.x > (lo + 1) * 50 && at.x < hi * 50 && at.y > (lo + 1) * 50 && at.y < hi * 50, `spawned outside the ring at ${at.x},${at.y}`);
    assert.ok(!solidRects(w).some((r) => circleHitsRect(at.x, at.y, WORLD.playerRadius, r)), `spawned inside a solid at ${at.x},${at.y}`);
  }
});

test('a worn building pays back less when taken down, and mending it costs less than taking it down and building it again', () => {
  for (const kind of ['wall', ...TURRET_KINDS] as const) {
    const { w, p } = dayWorld();
    w.run!.scrap = 1e6;
    build(w, p.id, kind, CELL.cx, CELL.cy);
    w.buildings[0]!.hp = BUILDINGS[kind].hp * 0.3;
    const scrap = w.run!.scrap;
    assert.equal(demolish(w, p.id, CELL.cx, CELL.cy), true);
    const refund = w.run!.scrap - scrap;
    assert.equal(refund, Math.floor(BUILDINGS[kind].cost * ZOM.demolishRefund * 0.3), `${kind} at 30% pays back 30% of the whole refund`);
    const mend = BUILDINGS[kind].hp * 0.7 * repairScrapPerHp(kind);
    assert.ok(mend < BUILDINGS[kind].cost - refund, `${kind}: mending costs ${mend}, tearing down and building again ${BUILDINGS[kind].cost - refund}`);
  }
});

test('by day, holding E repairs a damaged turret and then reloads it, the same as by night', () => {
  const w = createWorld('ZOM', 1, 'outpost');
  const p = spawnAt(w, 1380, 1525);
  w.run!.scrap = 1000;
  assert.equal(w.run!.phase.k, 'day');
  assert.equal(build(w, p.id, 'sentry', Math.floor(1380 / ZOM.cell), Math.floor(1525 / ZOM.cell) + 1), null);
  const b = w.buildings.at(-1)! as typeof w.buildings[number] & { ammo: number };
  b.hp = 100;
  b.ammo = 0;
  press(w, p, { use: true });
  run(w, 3000);
  assert.equal(w.run!.phase.k, 'day');
  assert.ok(b.hp > 100, `repaired by day to ${b.hp}`);
  run(w, 6000);
  assert.ok(b.ammo > 0, `reloaded by day to ${b.ammo}`);
});
