import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILDINGS, GUN_IDS, GUNS, ZOM, ZOMBIE_CLASS_ROLES, zombieRole } from '../src/shared/defs.ts';
import { buildsNow, levelOf } from '../src/shared/sim/build.ts';
import { build, buildLine, demolish, upgrade } from '../src/shared/sim/run.ts';
import { createWorld, newId, type World } from '../src/shared/sim/world.ts';
import { spawnAt } from './helpers.ts';

/** The builder stands just west of the core; cell (26, 30) is beside them. */
const AT = { x: 1380, y: 1525 }, CELL = { cx: 26, cy: 30 };

function nightWorld() {
  const w = createWorld('ZOM', 1, 'outpost');
  const p = spawnAt(w, AT.x, AT.y);
  w.run!.scrap = 1000;
  w.run!.phase = { k: 'night', toSpawn: [{ kind: 'walker', side: 'north', n: 1 }], nextSpawnAt: Infinity, dawnAt: Infinity };
  return { w, p };
}

const nightOf = (w: World) => w.run!.phase.k;

test('every pistol-class gun builds by night, and no other gun does', () => {
  assert.equal(ZOMBIE_CLASS_ROLES.pistol.nightBuild, true);
  for (const gun of GUN_IDS) assert.equal(zombieRole(gun).nightBuild, GUNS[gun].base === 'pistol', gun);
  for (const gun of ['pistol', 'handCannon', 'machinePistol', 'executioner', 'gunslinger', 'akimbo', 'hailstorm'] as const) assert.ok(buildsNow('night', gun), gun);
  assert.ok(ZOMBIE_CLASS_ROLES.pistol.perk.startsWith('Field mechanic: builds and upgrades by night'));
});

test('buildsNow: anyone by day, a pistol by night, nobody once the run is over', () => {
  assert.ok(buildsNow('day', 'sniper'));
  assert.ok(buildsNow('night', 'pistol'));
  assert.ok(!buildsNow('night', 'sniper'));
  assert.ok(!buildsNow('night', null));
  assert.ok(!buildsNow('over', 'pistol'));
});

test('a pistol holder builds, upgrades and takes down by night at the usual price', () => {
  const { w, p } = nightWorld();
  assert.equal(nightOf(w), 'night');
  const scrap = w.run!.scrap;
  assert.equal(build(w, p.id, 'sentry', CELL.cx, CELL.cy), null);
  assert.equal(scrap - w.run!.scrap, BUILDINGS.sentry.cost, 'the same scrap cost');
  assert.equal(upgrade(w, p.id, CELL.cx, CELL.cy), null);
  assert.equal(levelOf(w.buildings.find((b) => b.cx === CELL.cx && b.cy === CELL.cy)!), 2);
  assert.deepEqual(buildLine(w, p.id, 'wall', [[26, 29], [26, 28]]), [null, null], 'a line too');
  assert.equal(demolish(w, p.id, CELL.cx, CELL.cy), true);
  assert.ok(!w.buildings.some((b) => b.cx === CELL.cx && b.cy === CELL.cy));
});

test('by night a pistol is still held to reach, the core, cover and bodies in the way', () => {
  const { w, p } = nightWorld();
  assert.equal(build(w, p.id, 'wall', CELL.cx - 5, CELL.cy), 'outOfReach');
  assert.equal(build(w, p.id, 'wall', 29, 30), 'core');
  w.zombies.push({ id: newId(w), kind: 'walker', x: (CELL.cx + 0.5) * ZOM.cell, y: (CELL.cy + 0.5) * ZOM.cell, hp: 1, attackAt: Infinity, vx: 0, vy: 0 });
  assert.equal(build(w, p.id, 'wall', CELL.cx, CELL.cy), 'body');
  w.run!.scrap = 0;
  assert.equal(build(w, p.id, 'wall', CELL.cx, CELL.cy + 1), 'scrap');
});

test('any other gun is refused by night with notDay, and swapping guns mid-night turns it on and off', () => {
  const { w, p } = nightWorld();
  p.gun = 'smg';
  const scrap = w.run!.scrap;
  assert.equal(build(w, p.id, 'wall', CELL.cx, CELL.cy), 'notDay');
  assert.equal(w.run!.scrap, scrap);
  p.gun = 'executioner';
  assert.equal(build(w, p.id, 'wall', CELL.cx, CELL.cy), null, 'swapped to a pistol-class gun');
  p.gun = 'assault';
  assert.equal(upgrade(w, p.id, CELL.cx, CELL.cy), 'notDay');
  assert.equal(demolish(w, p.id, CELL.cx, CELL.cy), false);
  p.gun = 'pistol';
  assert.equal(upgrade(w, p.id, CELL.cx, CELL.cy), null);
  assert.equal(demolish(w, p.id, CELL.cx, CELL.cy), true);
});
