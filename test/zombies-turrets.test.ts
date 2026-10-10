import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASTION_GUN, BUILDINGS, ZOM, ZOMBIES, type TurretKind, type ZombieKind } from '../src/shared/defs.ts';
import { removePlayer, step } from '../src/shared/sim.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { createWorld, newId, type Turret, type World } from '../src/shared/sim/world.ts';
import { scheduleEffects } from '../src/client/eventclock.ts';
import { press, run, spawnAt, TICK_MS } from './helpers.ts';

/** A turret on open ground well west of the core. */
const T = { cx: 20, cy: 30 }, TX = (T.cx + 0.5) * ZOM.cell, TY = (T.cy + 0.5) * ZOM.cell;
const SENTRY = BUILDINGS.sentry.turret;

/** A night with nothing left to spawn and no map cover, so only what a test places counts. */
function nightWorld(): World {
  const w = createWorld('ZOM', 1, 'outpost');
  w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  w.walls = [];
  w.crates = [];
  w.wallsVersion++;
  return w;
}

function addTurret(w: World, kind: TurretKind, owner: number, over: Partial<Turret> = {}): Turret {
  const t: Turret = { id: newId(w), kind, ...T, hp: BUILDINGS[kind].hp, owner, ammo: BUILDINGS[kind].turret.ammo, nextFireAt: 0, ...over };
  w.buildings.push(t);
  w.buildingsVersion++;
  return t;
}

function addZombie(w: World, kind: ZombieKind, x: number, y: number, hp = 1e9) {
  const z = { id: newId(w), kind, x, y, hp, attackAt: Infinity, vx: 0, vy: 0 };
  w.zombies.push(z);
  return z;
}

const shotsIn = (w: World) => w.events.flatMap((e) => (e.e === 'turret' ? [e] : []));

test('a turret fires one round at its nearest zombie in range, spending one of its ammo', () => {
  const w = nightWorld();
  const t = addTurret(w, 'sentry', spawnAt(w, TX, TY + 300).id);
  addZombie(w, 'walker', TX - 300, TY);
  addZombie(w, 'walker', TX, TY - 200);
  step(w, TICK_MS);
  const shots = shotsIn(w);
  assert.equal(shots.length, 1);
  assert.deepEqual([shots[0]!.kind, shots[0]!.x, shots[0]!.y], ['sentry', TX, TY]);
  assert.ok(Math.abs(shots[0]!.angle + Math.PI / 2) < 0.1, `aimed north at the nearer zombie, angle ${shots[0]!.angle.toFixed(2)}`);
  assert.equal(t.ammo, SENTRY.ammo - 1);
  assert.deepEqual(w.bullets.map((b) => b.turret), ['sentry']);
});

test('a cannon picks a brute in range over a nearer walker, and a sentry a walker over a nearer brute', () => {
  for (const [kind, near, far, angle] of [['cannon', 'walker', 'brute', Math.PI], ['sentry', 'brute', 'walker', Math.PI]] as const) {
    const w = nightWorld();
    addTurret(w, kind, spawnAt(w, TX, TY + 300).id);
    addZombie(w, near, TX, TY - 150);
    addZombie(w, far, TX - 350, TY);
    step(w, TICK_MS);
    assert.ok(Math.abs(Math.sin((shotsIn(w)[0]!.angle - angle) / 2)) < 0.05, `${kind} aimed at the ${far}, angle ${shotsIn(w)[0]!.angle.toFixed(2)}`);
  }
});

function oneRound(turret: TurretKind, kind: ZombieKind): number {
  const w = nightWorld();
  addTurret(w, turret, spawnAt(w, TX, TY + 300).id, { ammo: 1 });
  const z = addZombie(w, kind, TX, TY - 150);
  run(w, 1500);
  return 1e9 - z.hp;
}

test('plating blocks little of a cannon shell and none of a mortar\'s blast', () => {
  assert.equal(oneRound('sentry', 'walker'), SENTRY.damage);
  assert.ok(oneRound('cannon', 'plated') >= BUILDINGS.cannon.turret.damage * 0.9, 'a cannon shell gets through');
  for (const kind of ['walker', 'plated'] as const) {
    assert.ok(oneRound('mortar', kind) >= BUILDINGS.mortar.turret.lobbed!.damage * 0.9, `a mortar's burst takes nearly its full damage off a ${kind}`);
  }
});

test('a mortar lobs its shell over map cover a sentry cannot see past, and the burst catches the crowd round its target', () => {
  for (const kind of ['sentry', 'mortar'] as const) {
    const w = nightWorld();
    w.walls.push({ x: TX - 100, y: TY - 120, w: 200, h: 40, built: false, material: 'concrete', expiresAt: Infinity });
    w.wallsVersion++;
    addTurret(w, kind, spawnAt(w, TX, TY + 300).id);
    const target = addZombie(w, 'walker', TX, TY - 300);
    const beside = addZombie(w, 'walker', TX + 60, TY - 300);
    run(w, 2000);
    const hurt = [1e9 - target.hp, 1e9 - beside.hp];
    if (kind === 'sentry') assert.deepEqual(hurt, [0, 0], 'the sentry holds fire with the wall in the way');
    else assert.ok(hurt.every((d) => d > 0), `the shell burst over the wall onto both, ${hurt.join(', ')}`);
  }
});

test('a scatter fires a fan of pellets in one shot, and only at close range', () => {
  const w = nightWorld();
  const t = addTurret(w, 'scatter', spawnAt(w, TX, TY + 300).id);
  const z = addZombie(w, 'walker', TX, TY - 120);
  step(w, TICK_MS);
  assert.equal(shotsIn(w).length, 1, 'one shot');
  const rounds = w.bullets.filter((b) => b.turret === 'scatter');
  assert.equal(rounds.length, BUILDINGS.scatter.turret.pellets);
  const viewer = w.players.values().next().value!;
  const drawn = scheduleEffects(snapshotFor(w, viewer.id, w.events), 0).flatMap(({ fx }) => (fx.kind === 'tracer' && fx.turret === 'scatter' ? [fx.angle] : []));
  assert.deepEqual(rounds.map((b) => Math.atan2(b.vy, b.vx).toFixed(1)), drawn.map((a) => a.toFixed(1)), 'the tracers a client draws are where the pellets fly');
  assert.equal(t.ammo, BUILDINGS.scatter.turret.ammo - 1, 'for one round of ammo');
  run(w, 300);
  assert.ok(1e9 - z.hp >= 3 * BUILDINGS.scatter.turret.damage, `most pellets hit up close, ${1e9 - z.hp}`);
  const far = nightWorld();
  addTurret(far, 'scatter', spawnAt(far, TX, TY + 300).id);
  addZombie(far, 'walker', TX, TY - BUILDINGS.scatter.turret.range - 40);
  run(far, 1000);
  assert.equal(far.bullets.length, 0, 'a zombie past its range draws no fire');
});

test('a zombie out of range or behind cover draws no fire, but the squad\'s own walls hide nothing', () => {
  const w = nightWorld();
  const owner = spawnAt(w, TX, TY + 300).id;
  const t = addTurret(w, 'sentry', owner);
  addZombie(w, 'walker', TX, TY - SENTRY.range - 30);
  step(w, TICK_MS);
  assert.deepEqual([shotsIn(w).length, t.ammo], [0, SENTRY.ammo], 'out of range');

  w.zombies = [];
  w.walls.push({ x: TX - 50, y: TY - 120, w: 100, h: 20, built: false, material: 'concrete', expiresAt: Infinity });
  w.wallsVersion++;
  addZombie(w, 'walker', TX, TY - 200);
  step(w, TICK_MS);
  assert.equal(shotsIn(w).length, 0, 'behind cover');

  w.walls = [];
  w.wallsVersion++;
  w.buildings.push({ id: newId(w), kind: 'wall', cx: T.cx, cy: T.cy - 2, hp: BUILDINGS.wall.hp });
  w.buildingsVersion++;
  const z = w.zombies[0]!;
  run(w, 500);
  assert.ok(t.ammo < SENTRY.ammo && z.hp < 1e9, 'fired over the squad wall and hit');
});

test('a turret stops firing once its ammo runs out', () => {
  const w = nightWorld();
  const t = addTurret(w, 'sentry', spawnAt(w, TX, TY + 300).id, { ammo: 3 });
  addZombie(w, 'walker', TX, TY - 200);
  let shots = 0;
  for (let ms = 0; ms < 3000; ms += TICK_MS) { step(w, TICK_MS); shots += shotsIn(w).length; }
  assert.deepEqual([shots, t.ammo], [3, 0]);
});

test('a turret\'s rounds pass a squad player by and leave them whole', () => {
  const w = nightWorld();
  const mate = spawnAt(w, TX, TY - 100);
  addTurret(w, 'cannon', spawnAt(w, TX, TY + 300).id);
  const z = addZombie(w, 'walker', TX, TY - 220);
  const hp = mate.life.k === 'alive' ? mate.life.hp : 0;
  run(w, 300);
  assert.equal(z.hp, 1e9 - BUILDINGS.cannon.turret.damage, 'the round reached the zombie');
  assert.equal(mate.life.k === 'alive' && mate.life.hp, hp);
});

test('a turret\'s kill pays the squad its scrap and the builder its score, and counts as the turret\'s kill, not the builder\'s', () => {
  const w = nightWorld();
  const builder = spawnAt(w, TX, TY + 300);
  addTurret(w, 'cannon', builder.id);
  addZombie(w, 'brute', TX, TY - 200, 1);
  addZombie(w, 'walker', 60, 60);
  const scrap = w.run!.scrap;
  let zkill = null;
  for (let ms = 0; ms < 1000 && !zkill; ms += TICK_MS) { step(w, TICK_MS); zkill = w.events.find((e) => e.e === 'zkill') ?? null; }
  assert.deepEqual(zkill && { ...zkill, x: 0, y: 0, id: 0 }, { e: 'zkill', id: 0, kind: 'brute', x: 0, y: 0, by: null, scrap: ZOMBIES.brute.scrap });
  assert.equal(w.run!.scrap - scrap, ZOMBIES.brute.scrap);
  assert.deepEqual([builder.score, builder.kills, w.run!.stats.get(builder.id)?.kills ?? 0], [Math.round(ZOMBIES.brute.score * ZOM.levelScoreMul), 0, 0]);
  assert.deepEqual(w.run!.turretKills.cannon.brute, 1);
  assert.equal(Object.values(w.run!.turretKills).flatMap((k) => Object.values(k)).reduce((a, b) => a + b), 1, 'and no other');

  removePlayer(w, builder.id);
  addZombie(w, 'walker', TX, TY - 200, 1);
  run(w, BUILDINGS.cannon.turret.fireMs + 500);
  assert.equal(w.run!.turretKills.cannon.walker, 1, 'a turret keeps firing after its builder leaves');
  assert.equal(w.run!.scrap - scrap, ZOMBIES.brute.scrap + ZOMBIES.walker.scrap);
});

test('zombies bite a turret down like a wall', () => {
  const w = nightWorld();
  const owner = spawnAt(w, 1500, 1700).id;
  const line = Array.from({ length: 60 }, (_, cy) => addTurret(w, 'sentry', owner, { cx: 10, cy, ammo: 0 }));
  const t = line[30]!;
  const z = addZombie(w, 'brute', 10 * ZOM.cell - ZOMBIES.brute.radius - 2, 30.5 * ZOM.cell);
  z.attackAt = 0;
  step(w, TICK_MS);
  assert.equal(BUILDINGS.sentry.hp - t.hp, ZOMBIES.brute.damage * ZOMBIES.brute.buildingDamageMul);
  t.hp = 1;
  z.attackAt = 0;
  const version = w.buildingsVersion;
  step(w, TICK_MS);
  assert.ok(!w.buildings.includes(t) && w.buildingsVersion > version, 'the bitten-through turret is gone');
});

test('holding use by a turret short of ammo reloads it for scrap up to a full load, mending a worn one first', () => {
  const w = nightWorld();
  // An assault rifle reloads at the plain rate; a sidearm would reload faster (`ZombieRole.mend`).
  const p = spawnAt(w, TX, TY + 100, { loadout: { weapon: 'assault' } });
  const t = addTurret(w, 'sentry', p.id, { ammo: 0, hp: BUILDINGS.sentry.hp - 200 });
  w.run!.scrap = 1000;
  press(w, p, { use: true });
  run(w, 1000);
  assert.equal(t.ammo, 0, 'mended before reloaded');
  assert.ok(t.hp > BUILDINGS.sentry.hp - 200);

  t.hp = BUILDINGS.sentry.hp;
  t.ammo = 0.3;
  let scrap = w.run!.scrap;
  run(w, 1000);
  const loaded = t.ammo - 0.3;
  assert.ok(Math.abs(loaded - (SENTRY.ammo * 1000) / ZOM.refillMs) <= (SENTRY.ammo * TICK_MS) / ZOM.refillMs + 1e-6, `reloaded ${loaded.toFixed(1)}`);
  assert.ok(Math.abs(scrap - w.run!.scrap - loaded * SENTRY.scrapPerRound) < 1e-6, 'for scrap by the round');

  run(w, ZOM.refillMs);
  scrap = w.run!.scrap;
  run(w, 1000);
  assert.deepEqual([t.ammo, w.run!.scrap], [SENTRY.ammo, scrap], 'full, and no scrap spent past it');

  t.ammo = 0;
  w.run!.scrap = 0;
  run(w, 1000);
  assert.equal(t.ammo, 0, 'no scrap, no reload');
});

test('a turret\'s ammo shows in tenths, and its aim and rounds only in its shot events, so the sticky buildings field holds still while it fires', () => {
  const w = nightWorld();
  const p = spawnAt(w, TX, TY + 300);
  const t = addTurret(w, 'sentry', p.id);
  addZombie(w, 'walker', TX, TY - 200);
  step(w, TICK_MS);
  const first = snapshotFor(w, p.id);
  assert.deepEqual(first.buildings, [{ kind: 'sentry', cx: T.cx, cy: T.cy, hp: 10, ammo: 9 }], 'short of a full load after one round');
  assert.deepEqual([first.bullets.length, w.bullets.length], [0, 1], 'its round flies on the server but stays off the wire');
  run(w, 500);
  assert.ok(t.ammo < SENTRY.ammo - 1, 'it kept firing');
  assert.deepEqual(snapshotFor(w, p.id).buildings, first.buildings);
  t.ammo = 0.5;
  const view = snapshotFor(w, p.id).buildings![0]!;
  assert.equal('ammo' in view && view.ammo, 0, 'empty once it cannot fire a whole round');
});

test('the Bastion\'s survivors shoot what reaches its door, slower the fewer are left, and leave the far horde alone', () => {
  const dealt = (survivors: number, d: number) => {
    const w = nightWorld();
    w.run!.survivors = survivors;
    const z = addZombie(w, 'walker', 1500, 1500 - ZOM.coreHalf - d);
    for (let t = 0; t < 3000; t += TICK_MS) { z.x = 1500; z.y = 1500 - ZOM.coreHalf - d; step(w, TICK_MS); }
    return 1e9 - z.hp;
  };
  const all = dealt(ZOM.survivors, 100);
  assert.ok(all >= 5 * BASTION_GUN.damage, `all of them landed ${all}`);
  assert.ok(dealt(ZOM.survivors / 5, 100) < all / 3, 'a fifth of them fire far slower');
  assert.equal(dealt(ZOM.survivors, BASTION_GUN.range + 100), 0, 'out of its reach');
});

test('a mortar\'s kill counts as the mortar\'s, not its builder\'s', () => {
  const w = nightWorld();
  const builder = spawnAt(w, TX, TY + 300);
  addTurret(w, 'mortar', builder.id);
  addZombie(w, 'plated', TX, TY - 400, 1);
  addZombie(w, 'walker', 60, 60);
  run(w, 2500);
  assert.equal(w.run!.turretKills.mortar.plated, 1);
  assert.deepEqual([builder.kills, builder.score], [0, Math.round(ZOMBIES.plated.score * ZOM.levelScoreMul)]);
});

test('the Bastion\'s kills count as the Bastion\'s, and its hits send no hit marker', () => {
  const w = nightWorld();
  const z = addZombie(w, 'walker', 1500, 1500 - ZOM.coreHalf - 100, BASTION_GUN.damage);
  addZombie(w, 'walker', 60, 60);
  let markers = 0;
  for (let t = 0; t < 2000 && w.run!.bastionKills === 0; t += TICK_MS) {
    z.x = 1500; z.y = 1500 - ZOM.coreHalf - 100;
    step(w, TICK_MS);
    markers += w.events.filter((e) => e.e === 'dmg' && e.kind === 'zombie').length;
  }
  assert.equal(w.run!.bastionKills, 1);
  assert.equal(markers, 0);
  assert.equal(w.zombies.includes(z), false);
});

test('the Bastion\'s survivors never fire sooner than their count allows, even as they fall between shots', () => {
  const w = nightWorld();
  const z = addZombie(w, 'walker', 1500, 1500 - ZOM.coreHalf - 100);
  const fired: { at: number; gap: number }[] = [];
  const seen = new Set<number>();
  for (let t = 0; t < 8000; t += TICK_MS) {
    z.x = 1500; z.y = 1500 - ZOM.coreHalf - 100;
    w.run!.survivors = Math.max(5, ZOM.survivors - Math.floor(t / 150));
    step(w, TICK_MS);
    for (const b of w.bullets) if (b.turret === 'bastion' && !seen.has(b.id)) {
      seen.add(b.id);
      fired.push({ at: w.now, gap: (BASTION_GUN.fireMs * ZOM.survivors) / w.run!.survivors });
    }
  }
  assert.ok(fired.length > 5, `${fired.length} shots`);
  for (let i = 1; i < fired.length; i++) {
    const since = fired[i]!.at - fired[i - 1]!.at;
    assert.ok(since >= fired[i - 1]!.gap - TICK_MS - 1e-6, `shot ${i} came ${since}ms after the last, its gap ${fired[i - 1]!.gap}ms`);
  }
});

test('a sentry or scatter leaves zombies whose plating eats most of its round to heavier guns, and fires on what it can hurt', () => {
  for (const turret of ['sentry', 'scatter'] as const) {
    for (const armored of ['plated', 'colossus'] as const) {
      const w = nightWorld();
      const t = addTurret(w, turret, spawnAt(w, TX, TY + 300).id);
      const tough = addZombie(w, armored, TX, TY - 100);
      run(w, 1000);
      assert.deepEqual([t.ammo, tough.hp], [BUILDINGS[turret].turret.ammo, 1e9], `a ${turret} spends nothing on a ${armored}`);
      const walker = addZombie(w, 'walker', TX + 180, TY);
      run(w, 1000);
      assert.ok(walker.hp < 1e9 && tough.hp === 1e9, `the ${turret} shoots the walker beside the ${armored}`);
    }
  }
  const w = nightWorld();
  const z = addZombie(w, 'plated', 1500, 1500 - ZOM.coreHalf - 100);
  for (let t = 0; t < 1000; t += TICK_MS) { z.x = 1500; z.y = 1500 - ZOM.coreHalf - 100; step(w, TICK_MS); }
  assert.ok(z.hp < 1e9, 'the Bastion\'s heavier rounds still get through');
});

test('a mortar leads a zombie walking in, so its shell comes down on it', () => {
  for (const kind of ['walker', 'runner'] as const) {
    const w = nightWorld();
    w.run!.core.hp = 1e9;
    w.run!.bastionFireAt = Infinity;
    w.buildings.push({ id: newId(w), kind: 'mortar', cx: 32, cy: 30, hp: 1e9, owner: -1, ammo: 1, nextFireAt: 0 });
    w.buildingsVersion++;
    const z = addZombie(w, kind, 1500, 1500 - 700);
    z.attackAt = 0;
    run(w, 3000);
    const dealt = 1e9 - z.hp;
    assert.ok(dealt >= BUILDINGS.mortar.turret.lobbed!.damage * 0.3, `a ${kind} took ${dealt.toFixed(0)} of the shell`);
  }
});
