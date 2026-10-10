import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILDING_KINDS, BUILDINGS, MAX_LEVEL, TURRET_KINDS, UPGRADE, UTILITY, WALL_TIERS, ZOM, ZOMBIES, type TurretKind } from '../src/shared/defs.ts';
import { MAPS } from '../src/shared/maps.ts';
import { parseClientMsg } from '../src/shared/protocol.ts';
import { step } from '../src/shared/sim.ts';
import { auraOf, costOf, investedOf, levelOf, maxHpOf, repairScrapPerHp, turretDef, upgradeCost, wallTier } from '../src/shared/sim/build.ts';
import { damageZombie, build, demolish, upgrade } from '../src/shared/sim/run.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { tickTurrets } from '../src/shared/sim/turrets.ts';
import { createWorld, newId, type World } from '../src/shared/sim/world.ts';
import { nextBuildStep } from '../src/server/bot/siege.ts';
import { hpOf, press, run, spawnAt, TICK_MS } from './helpers.ts';

/** The builder stands just west of the core; cell (26, 30) is beside them. */
const AT = { x: 1380, y: 1525 }, CELL = { cx: 26, cy: 30 };
const CORE = MAPS.outpost.siege!.core;

function dayWorld(scrap = 10_000) {
  const w = createWorld('ZOM', 1, 'outpost');
  const p = spawnAt(w, AT.x, AT.y);
  w.run!.scrap = scrap;
  return { w, p };
}

/** A night with nothing left to spawn, so only what a test places takes part. */
function nightWorld(): World {
  const w = createWorld('ZOM', 1, 'outpost');
  w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  w.run!.core.hp = 1e9;
  return w;
}

const zombieAt = (w: World, x: number, y: number, kind: 'walker' | 'brute' | 'plated' | 'bloater' = 'walker', hp = 1e9) => {
  const z = { id: newId(w), kind, x, y, hp, attackAt: Infinity, vx: 0, vy: 0 };
  w.zombies.push(z);
  return z;
}

const cellCenter = (cx: number, cy: number) => ({ x: (cx + 0.5) * ZOM.cell, y: (cy + 0.5) * ZOM.cell });

test('the three walls cost, hold and pay back by tier, and only the first is the plain wall', () => {
  assert.deepEqual(WALL_TIERS.map((t) => [t.name, t.cost, t.hp]), [['Barricade', 10, 800], ['Sandbag wall', 24, 2000], ['Steel wall', 60, 4800]]);
  assert.ok(WALL_TIERS[0].cost < WALL_TIERS[1].cost && WALL_TIERS[1].cost < WALL_TIERS[2].cost);
  assert.ok(WALL_TIERS[0].hp < WALL_TIERS[1].hp && WALL_TIERS[1].hp < WALL_TIERS[2].hp);
  assert.deepEqual([BUILDINGS.wall.cost, BUILDINGS.wall.hp], [WALL_TIERS[0].cost, WALL_TIERS[0].hp]);
  for (const lv of [1, 2, 3]) {
    const { w, p } = dayWorld(500);
    assert.equal(build(w, p.id, 'wall', CELL.cx, CELL.cy, lv), null);
    const tier = WALL_TIERS[lv - 1]!;
    assert.equal(500 - w.run!.scrap, tier.cost, `tier ${lv} costs ${tier.cost}`);
    const b = w.buildings[0]!;
    assert.deepEqual([b.kind, b.hp, levelOf(b)], ['wall', tier.hp, lv]);
    assert.deepEqual(snapshotFor(w, p.id).buildings, [{ kind: 'wall', cx: CELL.cx, cy: CELL.cy, hp: 10, ...(lv > 1 && { lv }) }], 'the view names the tier from the second up');
    const scrap = w.run!.scrap;
    assert.equal(demolish(w, p.id, CELL.cx, CELL.cy), true);
    assert.equal(w.run!.scrap - scrap, Math.floor(tier.cost * ZOM.demolishRefund), `tier ${lv} pays half back`);
  }
  const { w, p } = dayWorld(500);
  assert.equal(build(w, p.id, 'wall', CELL.cx, CELL.cy), null, 'no tier asked for is a barricade');
  assert.equal(levelOf(w.buildings[0]!), 1);
  w.run!.scrap = WALL_TIERS[2].cost - 1;
  assert.equal(build(w, p.id, 'wall', CELL.cx, CELL.cy + 1, 3), 'scrap');
});

test('a wall steps up a tier for the difference of their prices, keeping its share of health, and a steel wall goes no further', () => {
  const { w, p } = dayWorld(500);
  build(w, p.id, 'wall', CELL.cx, CELL.cy);
  const b = w.buildings[0]!;
  b.hp = WALL_TIERS[0].hp / 2;
  let scrap = w.run!.scrap;
  assert.equal(upgrade(w, p.id, CELL.cx, CELL.cy), null);
  assert.deepEqual([scrap - w.run!.scrap, levelOf(b), b.hp], [WALL_TIERS[1].cost - WALL_TIERS[0].cost, 2, WALL_TIERS[1].hp / 2], 'the half-worn barricade is a half-worn sandbag wall');
  scrap = w.run!.scrap;
  assert.equal(upgrade(w, p.id, CELL.cx, CELL.cy), null);
  assert.deepEqual([scrap - w.run!.scrap, levelOf(b), b.hp], [WALL_TIERS[2].cost - WALL_TIERS[1].cost, 3, WALL_TIERS[2].hp / 2]);
  assert.equal(WALL_TIERS[2].cost - WALL_TIERS[0].cost, 50, 'wood to steel by steps pays what steel costs more than wood');
  scrap = w.run!.scrap;
  assert.equal(upgrade(w, p.id, CELL.cx, CELL.cy), 'maxed');
  assert.equal(w.run!.scrap, scrap);
  assert.equal(snapshotFor(w, p.id).buildings![0]!.hp, 5);
});

test('an upgrade is refused at night, out of reach, with nothing there and when the bank is short, and spends nothing', () => {
  const { w, p } = dayWorld(500);
  assert.equal(upgrade(w, p.id, CELL.cx, CELL.cy), 'none');
  build(w, p.id, 'sentry', CELL.cx, CELL.cy);
  w.run!.scrap = upgradeCost('sentry', 1)! - 1;
  assert.equal(upgrade(w, p.id, CELL.cx, CELL.cy), 'scrap');
  w.run!.scrap = 500;
  p.x = AT.x - 8 * ZOM.cell;
  assert.equal(upgrade(w, p.id, CELL.cx, CELL.cy), 'outOfReach');
  p.x = AT.x;
  w.run!.phase = { k: 'night', toSpawn: [{ kind: 'walker', side: 'north', n: 1 }], nextSpawnAt: Infinity, dawnAt: Infinity };
  p.gun = 'shotgun';
  assert.equal(upgrade(w, p.id, CELL.cx, CELL.cy), 'notDay');
  assert.deepEqual([w.run!.scrap, levelOf(w.buildings[0]!)], [500, 1]);
});

test('a turret has three levels: each costs a share of its price, raises damage, rate, range and load, and an upgrade pays back in the refund', () => {
  for (const kind of TURRET_KINDS) {
    const base = BUILDINGS[kind].turret;
    const [l1, l2, l3] = [1, 2, 3].map((lv) => turretDef(kind, lv)) as [typeof base, typeof base, typeof base];
    assert.equal(l1, base, `${kind} level 1 is the base`);
    if (base.damage > 0) assert.deepEqual([l2.damage / base.damage, l3.damage / base.damage], [UPGRADE.damage[1], UPGRADE.damage[2]], `${kind} damage`);
    assert.deepEqual([l2.fireMs / base.fireMs, l3.fireMs / base.fireMs], [UPGRADE.fireMs[1], UPGRADE.fireMs[2]], `${kind} fire rate`);
    assert.ok(l1.range < l2.range && l2.range < l3.range && l1.ammo < l2.ammo && l2.ammo < l3.ammo, `${kind} range and load grow`);
    if (base.lobbed) assert.equal(l3.lobbed!.damage, base.lobbed.damage * UPGRADE.damage[2], 'a lobbed shell\'s blast scales with it');
    assert.deepEqual([upgradeCost(kind, 1), upgradeCost(kind, 2), upgradeCost(kind, 3)], [Math.round(BUILDINGS[kind].cost * UPGRADE.costShare[0]), Math.round(BUILDINGS[kind].cost * UPGRADE.costShare[1]), null]);
    assert.ok(maxHpOf(kind, 3) > maxHpOf(kind, 1));
    const { w, p } = dayWorld();
    build(w, p.id, kind, CELL.cx, CELL.cy);
    const t = w.buildings[0]!;
    assert.equal('ammo' in t && t.ammo, base.ammo);
    t.hp = maxHpOf(kind, 1) / 2;
    if ('ammo' in t) t.ammo = base.ammo / 2;
    const before = w.run!.scrap;
    upgrade(w, p.id, CELL.cx, CELL.cy);
    upgrade(w, p.id, CELL.cx, CELL.cy);
    assert.equal(before - w.run!.scrap, upgradeCost(kind, 1)! + upgradeCost(kind, 2)!, `${kind} paid both steps`);
    assert.deepEqual([levelOf(t), t.hp, 'ammo' in t && t.ammo], [3, maxHpOf(kind, 3) / 2, l3.ammo / 2], `${kind} keeps its share of health and load`);
    const view = snapshotFor(w, p.id).buildings![0]!;
    assert.deepEqual([view.lv, view.hp, 'ammo' in view && view.ammo], [3, 5, 5]);
    t.hp = maxHpOf(kind, 3);
    const scrap = w.run!.scrap;
    demolish(w, p.id, CELL.cx, CELL.cy);
    assert.equal(w.run!.scrap - scrap, Math.floor(investedOf(kind, 3) * ZOM.demolishRefund), `${kind} pays back half of everything put in`);
    assert.ok(investedOf(kind, 3) > BUILDINGS[kind].cost);
  }
});

test('mending a building costs by what is invested in it, and a barricade mends quicker than steel', () => {
  assert.ok(repairScrapPerHp('wall', 3) > repairScrapPerHp('wall', 1) * 0.9);
  assert.equal(repairScrapPerHp('sentry', 3), (investedOf('sentry', 3) / maxHpOf('sentry', 3)) * ZOM.repairShare);
  const rate = (lv: number) => {
    const w = nightWorld();
    const p = spawnAt(w, 1475, 1700);
    w.zombies.push({ id: newId(w), kind: 'walker', x: 60, y: 60, hp: 1e9, attackAt: Infinity, vx: 0, vy: 0 });
    const wall = { id: newId(w), kind: 'wall' as const, cx: Math.floor(1475 / ZOM.cell), cy: Math.floor(1850 / ZOM.cell), hp: 100, lv };
    w.buildings.push(wall);
    w.buildingsVersion++;
    w.run!.scrap = 1e6;
    press(w, p, { use: true });
    run(w, 1000);
    return wall.hp - 100;
  };
  assert.ok(rate(1) > rate(2) && rate(2) > rate(3), 'wood, then sandbags, then steel, each slower to mend');
});

test('a steel wall turns aside a share of every bite, the lower tiers less, and a bloater\'s burst hurts steel least', () => {
  const taken = (lv: number) => {
    const w = nightWorld();
    for (let cy = 0; cy < 60; cy++) w.buildings.push({ id: newId(w), kind: 'wall', cx: 10, cy, hp: wallTier(lv).hp, lv });
    w.buildingsVersion++;
    const wall = w.buildings.find((b) => b.cy === 30)!;
    const z = zombieAt(w, 10 * ZOM.cell - ZOMBIES.brute.radius - 2, 30.5 * ZOM.cell, 'brute');
    z.attackAt = 0;
    run(w, TICK_MS);
    return wallTier(lv).hp - wall.hp;
  };
  const bite = ZOMBIES.brute.damage * ZOMBIES.brute.buildingDamageMul;
  for (const lv of [1, 2, 3]) assert.ok(Math.abs(taken(lv) - bite * (1 - wallTier(lv).armor)) < 1e-9, `tier ${lv} takes ${1 - wallTier(lv).armor} of a bite`);
  assert.ok(taken(3) < taken(2) && taken(2) < taken(1));
  const blast = (lv: number) => {
    const w = nightWorld();
    const wall = { id: newId(w), kind: 'wall' as const, cx: 10, cy: 30, hp: wallTier(lv).hp, lv };
    w.buildings.push(wall);
    w.buildingsVersion++;
    const bloater = zombieAt(w, 10 * ZOM.cell - ZOMBIES.bloater.radius - 2, 30.5 * ZOM.cell, 'bloater');
    damageZombie(w, bloater, 1e10, spawnAt(w, 100, 100));
    return wallTier(lv).hp - wall.hp;
  };
  assert.deepEqual([1, 2, 3].map(blast), [1, 2, 3].map((lv) => ZOMBIES.bloater.burst!.building * wallTier(lv).blast));
  assert.ok(blast(3) < blast(2) && blast(2) < blast(1));
});

test('a higher level turret deals more and fires faster: a level 3 sentry out-damages a level 1 over the same seconds', () => {
  const dealt = (lv: number, kind: TurretKind = 'sentry') => {
    const w = nightWorld();
    const x = 1325, y = 1525;
    const z = zombieAt(w, x + 200, y, 'brute', 1e9);
    z.attackAt = Infinity;
    w.buildings.push({ id: newId(w), kind, cx: 26, cy: 30, hp: 1e9, owner: -1, ammo: turretDef(kind, lv).ammo, nextFireAt: 0, ...(lv > 1 && { lv }) });
    w.buildingsVersion++;
    let shots = 0;
    for (let t = 0; t < 2000; t += TICK_MS) { step(w, TICK_MS); shots += w.events.filter((e) => e.e === 'turret').length; }
    return { damage: 1e9 - z.hp, shots };
  };
  const one = dealt(1), three = dealt(3);
  assert.ok(one.damage > 0);
  assert.ok(three.shots / one.shots > 1.2, `level 3 fired ${three.shots} rounds to level 1's ${one.shots}`);
  assert.ok(three.damage / one.damage > 1.8, `level 3 did ${(three.damage / one.damage).toFixed(2)}x level 1's damage`);
});

test('the tesla coil arcs to its target and on to the nearest zombies, each jump weaker, through cover and plating, for its builder\'s score', () => {
  const w = nightWorld();
  const p = spawnAt(w, 100, 100);
  const def = BUILDINGS.tesla.turret;
  const arc = def.arc!;
  w.buildings.push({ id: newId(w), kind: 'tesla', cx: 26, cy: 30, hp: 1e9, owner: p.id, ammo: def.ammo, nextFireAt: 0 });
  w.buildingsVersion++;
  const from = cellCenter(26, 30);
  const chain = [0, 1, 2, 3, 4].map((i) => zombieAt(w, from.x + 100 + i * 60, from.y, i === 1 ? 'plated' : 'walker', 1000));
  const far = zombieAt(w, from.x + 100 + 4 * 60 + arc.reach + 20, from.y, 'walker', 1000);
  tickTurrets(w, w.run!, CORE, TICK_MS);
  const dealt = chain.map((z) => 1000 - z.hp);
  assert.deepEqual(dealt.slice(0, 4).map((d) => Math.round(d * 100) / 100), [0, 1, 2, 3].map((i) => Math.round(def.damage * arc.falloff ** i * 100) / 100), 'target first, then each jump at three quarters of the last');
  assert.equal(dealt[4], 0, 'it stops after its jumps');
  assert.equal(far.hp, 1000, 'and does not reach what is farther than an arc');
  const coil = w.events.find((e) => e.e === 'coil');
  assert.ok(coil?.e === 'coil' && coil.p.length === 2 * 5 && coil.p[0] === Math.round(from.x), 'one event with the coil and four stops');
  assert.equal('ammo' in w.buildings[0]! && w.buildings[0]!.ammo, def.ammo - 1, 'one charge a zap');
  assert.ok(!w.events.some((e) => e.e === 'turret' && e.kind === 'tesla'), 'no round flies');
  // Shoots through map cover: a zombie behind a wall in range is still zapped.
  const w2 = nightWorld();
  w2.walls.push({ x: 1325 + 60, y: 1400, w: 24, h: 250, built: false, material: 'concrete', expiresAt: Infinity });
  w2.buildings.push({ id: newId(w2), kind: 'tesla', cx: 26, cy: 30, hp: 1e9, owner: -1, ammo: 10, nextFireAt: 0 });
  const behind = zombieAt(w2, from.x + 140, from.y, 'walker', 500);
  tickTurrets(w2, w2.run!, CORE, TICK_MS);
  assert.ok(behind.hp < 500, 'cover does not stop an arc');
  // Kills credit its builder and the squad's scrap.
  const w3 = nightWorld();
  const owner = spawnAt(w3, 100, 100);
  w3.buildings.push({ id: newId(w3), kind: 'tesla', cx: 26, cy: 30, hp: 1e9, owner: owner.id, ammo: 10, nextFireAt: 0 });
  zombieAt(w3, from.x + 100, from.y, 'walker', 10);
  const scrap = w3.run!.scrap;
  tickTurrets(w3, w3.run!, CORE, TICK_MS);
  assert.deepEqual([w3.zombies.length, w3.run!.scrap - scrap, owner.score > 0], [0, ZOMBIES.walker.scrap, true]);
  assert.equal(w3.run!.turretKills.tesla.walker, 1, 'the report counts it as a tesla kill');
});

test('a spike strip is floor: it goes up like a building, is walked over by squad and horde alike, and is not on the flow field', () => {
  const { w, p } = dayWorld(100);
  const version = w.buildingsVersion;
  assert.equal(build(w, p.id, 'spikes', CELL.cx, CELL.cy), null);
  assert.deepEqual([w.floor.length, w.buildings.length, w.buildingsVersion, 100 - w.run!.scrap], [1, 0, version, BUILDINGS.spikes.cost]);
  assert.deepEqual(snapshotFor(w, p.id).buildings, [{ kind: 'spikes', cx: CELL.cx, cy: CELL.cy, hp: 10 }]);
  assert.equal(build(w, p.id, 'wall', CELL.cx, CELL.cy), 'taken', 'one thing to a cell');
  press(w, p, { left: true });
  run(w, 1000);
  assert.ok(p.x < (CELL.cx + 0.5) * ZOM.cell, `the squad walked over the strip to x ${p.x.toFixed(0)}`);
  // Someone standing on the cell does not stop it going up, as they would a wall.
  const w2 = createWorld('ZOM', 1, 'outpost');
  spawnAt(w2, (CELL.cx + 0.5) * ZOM.cell, (CELL.cy + 0.5) * ZOM.cell);
  const q2 = spawnAt(w2, AT.x, AT.y);
  assert.equal(build(w2, q2.id, 'spikes', CELL.cx, CELL.cy), null);
  assert.equal(build(w2, q2.id, 'wall', CELL.cx, CELL.cy + 1), null);
  // It comes down for half its price.
  const scrap = w.run!.scrap;
  assert.equal(demolish(w, p.id, CELL.cx, CELL.cy), true);
  assert.deepEqual([w.floor.length, w.run!.scrap - scrap], [0, Math.floor(BUILDINGS.spikes.cost * ZOM.demolishRefund)]);
  // And it never upgrades.
  build(w, p.id, 'spikes', CELL.cx, CELL.cy);
  assert.equal(upgrade(w, p.id, CELL.cx, CELL.cy), 'maxed');
});

test('a zombie on a spike strip is slowed, hurt and wears it down, and heavy ones trample it quicker; a strip worn through is gone', () => {
  const walk = (strip: boolean, kind: 'walker' | 'brute' = 'walker') => {
    const w = nightWorld();
    const start = { x: 1475, y: 1900 };
    const z = zombieAt(w, start.x, start.y, kind);
    z.attackAt = Infinity;
    // The core's cell is the goal; a zombie due south walks straight north.
    if (strip) for (let cy = 35; cy <= 38; cy++) w.floor.push({ id: newId(w), kind: 'spikes', cx: 29, cy, hp: BUILDINGS.spikes.hp });
    const hp0 = z.hp;
    run(w, 1000);
    return { moved: Math.hypot(z.x - start.x, z.y - start.y), hurt: hp0 - z.hp, strip: w.floor[0]?.hp ?? null, w };
  };
  const free = walk(false), slowed = walk(true);
  assert.ok(slowed.moved < free.moved * 0.7, `slowed from ${free.moved.toFixed(0)} to ${slowed.moved.toFixed(0)}px a second`);
  assert.ok(slowed.hurt > UTILITY.spikes.dps * 0.5, `chipped ${slowed.hurt.toFixed(1)} hp`);
  assert.equal(free.hurt, 0);
  assert.ok(walk(true, 'brute').moved < walk(false, 'brute').moved, 'a brute is slowed too');
  // Trampling: a crowd on one strip wears it out.
  const w = nightWorld();
  w.floor.push({ id: newId(w), kind: 'spikes', cx: 29, cy: 36, hp: 30 });
  for (let i = 0; i < 4; i++) { const z = zombieAt(w, 1475 + i * 3, 1825, 'brute'); z.attackAt = Infinity; }
  run(w, 2000);
  assert.equal(w.floor.length, 0, 'four brutes trampled a worn strip flat');
});

test('spikes can kill: a weak zombie crossing a long field does not live to the other side', () => {
  const w = nightWorld();
  for (let cy = 33; cy <= 40; cy++) w.floor.push({ id: newId(w), kind: 'spikes', cx: 29, cy, hp: BUILDINGS.spikes.hp });
  const z = zombieAt(w, 1475, 2050, 'walker', ZOMBIES.walker.hp);
  z.attackAt = Infinity;
  zombieAt(w, 60, 60, 'walker', 1e9);
  const scrap = w.run!.scrap;
  run(w, 8000);
  assert.ok(!w.zombies.includes(z), 'the walker died on the strips');
  assert.equal(w.run!.scrap - scrap, ZOMBIES.walker.scrap, 'and its scrap came to the bank');
});

test('an ammo depot tops up the neediest turret in reach slowly for part of the scrap, none out of reach, and reloads a squad player beside it at once', () => {
  const w = nightWorld();
  const owner = spawnAt(w, 1475, 1900);
  w.zombies.push({ id: newId(w), kind: 'walker', x: 60, y: 60, hp: 1e9, attackAt: Infinity, vx: 0, vy: 0 });
  const mk = (kind: 'sentry' | 'cannon', cx: number, cy: number, ammo: number) => {
    const t = { id: newId(w), kind, cx, cy, hp: 1e9, owner: owner.id, ammo, nextFireAt: Infinity };
    w.buildings.push(t);
    return t;
  };
  const near = mk('sentry', 30, 33, 100), nearer = mk('cannon', 31, 34, 2), far = mk('sentry', 40, 40, 0);
  w.buildings.push({ id: newId(w), kind: 'depot', cx: 31, cy: 33, hp: 1e9 });
  w.buildingsVersion++;
  w.run!.scrap = 1000;
  run(w, 1000);
  const cannon = BUILDINGS.cannon.turret;
  const gained = nearer.ammo - 2;
  assert.ok(Math.abs(gained - cannon.ammo * UTILITY.depot.ammoPerSec) < 0.2, `the emptier cannon gained ${gained.toFixed(2)} rounds a second`);
  assert.equal(near.ammo, 100, 'the sentry waits while the cannon is the needier');
  assert.equal(far.ammo, 0, 'out of reach, nothing');
  assert.ok(Math.abs(1000 - w.run!.scrap - gained * cannon.scrapPerRound * UTILITY.depot.scrapShare) < 1e-6, 'for a share of the usual scrap');
  w.run!.scrap = 0;
  const before = nearer.ammo;
  run(w, 1000);
  assert.equal(nearer.ammo, before, 'no scrap, no rounds');
  // A player standing beside it is reloaded at once.
  const p = spawnAt(w, (31 + 0.5) * ZOM.cell + 60, (33 + 0.5) * ZOM.cell);
  assert.ok(p.life.k === 'alive');
  p.life.ammo = 0;
  p.life.reloadUntil = w.now + 5000;
  run(w, 100);
  assert.ok(p.life.k === 'alive' && p.life.reloadUntil === null && p.life.ammo > 0, 'the reload finished early');
});

test('a depot says so once a second in an aid event, and a post mends squad players and buildings in reach for free, and only up to whole', () => {
  const w = nightWorld();
  const p = spawnAt(w, (31 + 0.5) * ZOM.cell, (35 + 0.5) * ZOM.cell + 40);
  const out = spawnAt(w, 1000, 1000);
  w.zombies.push({ id: newId(w), kind: 'walker', x: 60, y: 60, hp: 1e9, attackAt: Infinity, vx: 0, vy: 0 });
  if (p.life.k !== 'alive' || out.life.k !== 'alive') throw new Error('alive');
  p.life.hp = 10;
  out.life.hp = 10;
  const wall = { id: newId(w), kind: 'wall' as const, cx: 32, cy: 35, hp: 100 };
  const farWall = { id: newId(w), kind: 'wall' as const, cx: 40, cy: 45, hp: 100 };
  w.buildings.push({ id: newId(w), kind: 'post', cx: 31, cy: 35, hp: 1e9 }, wall, farWall);
  w.buildingsVersion++;
  w.run!.scrap = 0;
  run(w, 2000);
  // Everyone regenerates a little; the post's share is what the one beside it gained over the one far off.
  assert.ok(Math.abs(p.life.hp - out.life.hp - UTILITY.post.playerHp * 2) < 0.3, `mended ${p.life.hp - out.life.hp} hp more in two seconds`);
  assert.ok(Math.abs(wall.hp - 100 - UTILITY.post.buildingHp * 2) < 0.6, `the wall mended ${wall.hp - 100}`);
  assert.equal(farWall.hp, 100);
  assert.equal(w.run!.scrap, 0, 'free');
  run(w, 200_000);
  assert.equal(wall.hp, maxHpOf('wall', 1), 'mends to whole and no further');
  const aid = w.events.filter((e) => e.e === 'aid');
  assert.ok(aid.length <= 1, 'at most one event a tick window of a second');
  // Higher levels work faster and reach farther.
  assert.ok(auraOf(3) > auraOf(2) && auraOf(2) > auraOf(1));
  const run1 = nightWorld(), run3 = nightWorld();
  for (const [wx, lv] of [[run1, 1], [run3, 3]] as const) {
    const q = spawnAt(wx, (31 + 0.5) * ZOM.cell, (35 + 0.5) * ZOM.cell + 40);
    wx.zombies.push({ id: newId(wx), kind: 'walker', x: 60, y: 60, hp: 1e9, attackAt: Infinity, vx: 0, vy: 0 });
    if (q.life.k === 'alive') q.life.hp = 10;
    wx.buildings.push({ id: newId(wx), kind: 'post', cx: 31, cy: 35, hp: 1e9, ...(lv > 1 && { lv }) });
    wx.buildingsVersion++;
    run(wx, 1000);
  }
  const hp = (wx: World): number => [...wx.players.values()].map((q) => hpOf(q)).find((h) => h > 0)!;
  assert.ok(Math.abs(hp(run3) - hp(run1) - UTILITY.post.playerHp * (auraOf(3) - auraOf(1))) < 0.3, 'a level 3 post mends 2.4 times as fast as a level 1');
});

test('building messages carry a wall tier, and an upgrade message carries a whole cell', () => {
  assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'build', kind: 'wall', cx: 3, cy: 4, lv: 3 })), { t: 'build', kind: 'wall', cx: 3, cy: 4, lv: 3 });
  assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'build', kind: 'tesla', cx: 3, cy: 4 })), { t: 'build', kind: 'tesla', cx: 3, cy: 4 });
  for (const lv of [0, 4, 1.5, '2', null]) assert.equal(parseClientMsg(JSON.stringify({ t: 'build', kind: 'wall', cx: 3, cy: 4, lv })), null, JSON.stringify(lv));
  assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'upgrade', cx: 0, cy: 59 })), { t: 'upgrade', cx: 0, cy: 59 });
  for (const bad of [{ cx: 1.5, cy: 2 }, { cx: -1, cy: 2 }, { cx: 60, cy: 2 }, { cx: '3', cy: 2 }, { cy: 2 }]) assert.equal(parseClientMsg(JSON.stringify({ t: 'upgrade', ...bad })), null, JSON.stringify(bad));
  for (const kind of BUILDING_KINDS) assert.ok(parseClientMsg(JSON.stringify({ t: 'build', kind, cx: 1, cy: 1 })), kind);
});

test('every kind has a price the economy can carry: a night\'s scrap buys the cheap tiers by the dozen and the dear things by the few', () => {
  for (const kind of BUILDING_KINDS) assert.ok(costOf(kind) > 0 && costOf(kind) <= 300, `${kind} ${costOf(kind)}`);
  assert.ok(MAX_LEVEL === 3);
  assert.ok(costOf('spikes') < costOf('wall', 2) && costOf('wall', 3) < costOf('sentry'), 'strips and walls are the cheap end');
  assert.ok(costOf('tesla') > costOf('cannon') && costOf('tesla') <= costOf('cannon') * 1.6, 'the coil is the dearest turret, but not by far');
  for (const kind of TURRET_KINDS) assert.ok(investedOf(kind, 3) < costOf(kind) * 3.2, `${kind} fully upgraded costs under about three of them`);
  assert.deepEqual(BUILDING_KINDS, ['wall', 'sentry', 'cannon', 'scatter', 'mortar', 'tesla', 'depot', 'post', 'spikes']);
});

test('squad bots by day step the ring up and out: turrets, the one facing the night first upgraded, then depot and post, sandbags across the way, spikes, steel, level 3', () => {
  const core = CORE;
  const cellOfStep = (s: NonNullable<ReturnType<typeof nextBuildStep>>) => ({ cx: s.cell.cx, cy: s.cell.cy });
  const standing: { kind: string; cx: number; cy: number; hp: number; lv?: number; ammo?: number }[] = [];
  const seen: string[] = [];
  for (let i = 0; i < 80; i++) {
    const s = nextBuildStep(1, standing as never, core);
    if (!s) break;
    seen.push(`${s.act} ${s.kind}${s.act === 'upgrade' ? ' to ' + s.lv : ''}`);
    const at = cellOfStep(s);
    const there = standing.find((b) => b.cx === at.cx && b.cy === at.cy);
    if (there) there.lv = s.lv; else standing.push({ kind: s.kind, ...at, hp: 10, lv: s.lv > 1 ? s.lv : undefined, ...(['sentry', 'cannon', 'scatter', 'mortar', 'tesla'].includes(s.kind) && { ammo: 10 }) });
  }
  assert.deepEqual(seen.slice(0, 9).map((l) => l.split(' ')[1]), ['sentry', 'sentry', 'scatter', 'sentry', 'cannon', 'mortar', 'scatter', 'sentry', 'cannon'], 'the ring, as before');
  assert.equal(seen[9], 'upgrade sentry to 2', 'then the turret facing night 1\'s north side steps up');
  const rest = seen.slice(10);
  assert.deepEqual(rest.slice(0, 3).map((l) => l.split(' ')[1]), ['mortar', 'scatter', 'scatter'], 'the rest of the ring');
  assert.deepEqual(rest.slice(3, 5), ['build depot', 'build post']);
  assert.ok(rest.includes('build wall') && rest.includes('build spikes') && rest.includes('build tesla') && rest.includes('upgrade wall to 3'));
  assert.ok(rest.indexOf('build spikes') > rest.indexOf('build wall'), 'the line before the strips');
  assert.ok(rest.at(-1)!.startsWith('upgrade') && rest.filter((l) => l === 'upgrade sentry to 3').length >= 1, 'level 3 at the end');
  const walls = standing.filter((b) => b.kind === 'wall');
  assert.deepEqual(walls.map((b) => b.lv), [3, 3, 3, 3]);
  assert.equal(new Set(walls.map((b) => b.cy)).size, 1, 'one line of walls');
  assert.equal(new Set(walls.map((b) => b.cx)).size, 4, 'four across, with no gap');
  assert.ok(Math.max(...walls.map((b) => b.cx)) - Math.min(...walls.map((b) => b.cx)) === 3);
});

test('a bot squad with scrap to spend builds the variety on its own and upgrades its turrets, by the real sim', async () => {
  const { newBotMemory } = await import('../src/server/bots.ts');
  const { thinkBots } = await import('../src/server/bot/tick.ts');
  const w = createWorld('ZOM', 1, 'outpost');
  for (let i = 0; i < 4; i++) spawnAt(w, CORE.x - 150 + i * 100, CORE.y + ZOM.coreHalf + 40, { kind: 'bot' });
  w.run!.scrap = 1e6;
  w.run!.phase = { k: 'day', endsAt: Infinity };
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const mems = new Map([...w.players.keys()].map((id) => [id, newBotMemory(rnd)]));
  for (let t = 0; t < 1_200_000; t += TICK_MS) {
    thinkBots(w, mems, rnd, { respawn: false });
    step(w, TICK_MS);
    if (w.floor.length >= 4 && w.buildings.every((b) => b.kind !== 'wall' || levelOf(b) === 3) && w.buildings.some((b) => b.kind === 'sentry' && levelOf(b) === 3)) break;
  }
  const kinds = new Map<string, number>();
  for (const b of [...w.buildings, ...w.floor]) kinds.set(b.kind, (kinds.get(b.kind) ?? 0) + 1);
  for (const kind of ['sentry', 'cannon', 'scatter', 'mortar', 'tesla', 'depot', 'post', 'wall', 'spikes']) assert.ok((kinds.get(kind) ?? 0) > 0, `built a ${kind}: ${JSON.stringify([...kinds])}`);
  assert.ok(w.buildings.some((b) => 'ammo' in b && levelOf(b) >= 2), 'a turret was upgraded');
  assert.ok(w.buildings.filter((b) => b.kind === 'wall').every((b) => levelOf(b) === 3), 'every wall steel');
  const turrets = w.buildings.filter((b) => 'ammo' in b);
  const best = Math.max(...turrets.map((b) => levelOf(b)));
  const north = turrets.filter((b) => b.cy < 30).map((b) => levelOf(b));
  assert.ok(best === 3 && north.some((l) => l === 3), `the north side, which night 1 comes from, got level 3: ${north}`);
});
