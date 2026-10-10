import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILDINGS, GUNS, HORDE_GUN_MUL, ZOM, ZOMBIES, zombieBounty, zombieRole, type ZombieKind } from '../src/shared/defs.ts';

/** A player's round reaches the horde at `HORDE_GUN_MUL` of its harm (test/zombies-gunroles.test.ts has the gun roles on top). */
const ON_HORDE = HORDE_GUN_MUL;
import { explode } from '../src/shared/sim/combat.ts';
import { zombieMaxHp } from '../src/shared/sim/run.ts';
import { createWorld, newId, type World } from '../src/shared/sim/world.ts';
import { equip, grantPerks, hpOf, press, run, shootOnce, spawnAt, TICK_MS } from './helpers.ts';
/** Harm to the tenth of a millionth: a product of multipliers is not exact in floating point. */
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const near = (actual: number, expected: number, message?: string) => (message === undefined ? assert.equal(r6(actual), r6(expected)) : assert.equal(r6(actual), r6(expected), message));


/** A quiet night, so only what a test places takes part. Tests line up on the open ground due south of the core, where a zombie walks straight at the shooter. */
function nightWorld(): World {
  const w = createWorld('ZOM', 1, 'outpost');
  w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  w.run!.core.hp = 1e9;
  return w;
}

const X = 1475, Y = 1700, DOWN = Math.PI / 2;

function addZombie(w: World, kind: ZombieKind, x: number, y: number, hp = zombieMaxHp(kind, 1, 1)) {
  const z = { id: newId(w), kind, x, y, hp, attackAt: Infinity, vx: 0, vy: 0 };
  w.zombies.push(z);
  return z;
}

test('shooting a zombie dead pays the shooter its score and kill, and the squad its scrap', () => {
  const w = nightWorld();
  const p = spawnAt(w, X, Y);
  const z = addZombie(w, 'walker', X, Y + 300);
  addZombie(w, 'walker', 100, 100);
  const shots = Math.ceil(z.hp / (GUNS.pistol.damage * ON_HORDE));
  const scrap = w.run!.scrap;
  // The walker comes on with a lane and sway of its own, so each shot is aimed at where it is.
  for (let i = 0; i < shots; i++) shootOnce(w, p, Math.atan2(z.y - p.y, z.x - p.x), 300);
  assert.ok(!w.zombies.includes(z), 'the zombie is gone');
  assert.deepEqual(
    { score: p.score, kills: p.kills, scrap: w.run!.scrap - scrap, stats: w.run!.stats.get(p.id)?.kills },
    // The squad's scrap comes with the pistol's bounty (`zombieBounty`; test/zombies-gunroles.test.ts has the rest).
    { score: Math.round(ZOMBIES.walker.score * ZOM.levelScoreMul), kills: 1, scrap: Math.round(ZOMBIES.walker.scrap * zombieBounty('pistol') * 100) / 100, stats: 1 },
  );
});

test('a bullet stops in the first zombie it hits unless the gun pierces', () => {
  const w = nightWorld();
  const p = spawnAt(w, X, Y);
  const front = addZombie(w, 'brute', X, Y + 200, 1000);
  const back = addZombie(w, 'brute', X, Y + 300, 1000);
  shootOnce(w, p, DOWN);
  assert.deepEqual([1000 - front.hp, 1000 - back.hp].map(r6), [GUNS.pistol.damage * ON_HORDE, 0].map(r6));
  equip(p, 'railSlug');
  shootOnce(w, p, DOWN);
  near(1000 - back.hp, GUNS.railSlug.damage * ON_HORDE * zombieRole('railSlug').vs.brute!, 'a piercing round reaches the second (a rail hits a brute harder in Zombies)');
});

test('a plated zombie\'s plate comes off every round, unless the round pierces armor', () => {
  const w = nightWorld();
  const p = spawnAt(w, X, Y);
  const plated = addZombie(w, 'plated', X, Y + 200, 1000);
  shootOnce(w, p, DOWN);
  near(1000 - plated.hp, (GUNS.pistol.damage - ZOMBIES.plated.plate) * ON_HORDE);
  const piercer = spawnAt(w, X + 300, Y);
  piercer.perks = { 1: 'piercing' };
  const bare = addZombie(w, 'plated', X + 300, Y + 200, 1000);
  shootOnce(w, piercer, DOWN);
  near(1000 - bare.hp, GUNS.pistol.damage * ON_HORDE, 'an armor-piercing round takes no notice of the plate');
});

test('a piercing round that ends a tick inside a zombie hits it once', () => {
  const w = nightWorld();
  const p = spawnAt(w, X, Y);
  equip(p, 'railSlug');
  const z = addZombie(w, 'brute', X, Y + 120, 1000);
  shootOnce(w, p, DOWN);
  near(1000 - z.hp, GUNS.railSlug.damage * ON_HORDE * zombieRole('railSlug').vs.brute!);
});

test('the squad shoots over its own walls', () => {
  const w = nightWorld();
  const p = spawnAt(w, X, Y);
  w.buildings.push({ id: newId(w), kind: 'wall', cx: Math.floor(X / ZOM.cell), cy: Math.floor((Y + 100) / ZOM.cell), hp: BUILDINGS.wall.hp });
  w.buildingsVersion++;
  const z = addZombie(w, 'brute', X, Y + 250, 1000);
  shootOnce(w, p, DOWN);
  near(1000 - z.hp, GUNS.pistol.damage * ON_HORDE);
});

test('a blast hurts every zombie in its radius, less with distance, and credits its owner', () => {
  const w = nightWorld();
  const p = spawnAt(w, X, Y);
  const near = addZombie(w, 'brute', 1000, 2000, 1000);
  const far = addZombie(w, 'brute', 1100, 2000, 1000);
  const out = addZombie(w, 'brute', 1180, 2000, 1000);
  const kill = addZombie(w, 'walker', 990, 1990, 1);
  explode(w, 1000, 2000, 130, 90, { attacker: p, team: p.team, label: 'test' });
  assert.equal(1000 - near.hp, 90);
  assert.ok(1000 - far.hp > 0 && 1000 - far.hp < 90, `${1000 - far.hp} at range`);
  assert.equal(out.hp, 1000);
  assert.ok(!w.zombies.includes(kill));
  assert.equal(p.kills, 1);
});

test('knife, gas and land mines work on zombies too', () => {
  const knifeWorld = nightWorld();
  const knifer = spawnAt(knifeWorld, X, Y);
  grantPerks(knifeWorld, knifer, ['optics', 'shield', 'knife']);
  const cut = addZombie(knifeWorld, 'brute', X, Y + 100, 1000);
  press(knifeWorld, knifer, { ability: true, angle: DOWN });
  run(knifeWorld, TICK_MS);
  assert.ok(cut.hp < 1000, 'the knife cut');

  const gasWorld = nightWorld();
  const gasser = spawnAt(gasWorld, X, Y);
  const choking = addZombie(gasWorld, 'brute', X, Y + 400, 1000);
  gasWorld.thrown.push({ id: newId(gasWorld), kind: 'gasCloud', owner: gasser.id, team: gasser.team, x: X, y: Y + 400, bornAt: gasWorld.now, expiresAt: Infinity });
  run(gasWorld, 1000);
  assert.ok(choking.hp < 1000, 'the gas choked');

  const mineWorld = nightWorld();
  const miner = spawnAt(mineWorld, X, Y);
  mineWorld.thrown.push({ id: newId(mineWorld), kind: 'landMine', owner: miner.id, team: miner.team, x: X, y: Y + 400, armedAt: 0, expiresAt: Infinity });
  const stepper = addZombie(mineWorld, 'brute', X, Y + 410, 1000);
  run(mineWorld, TICK_MS);
  assert.ok(stepper.hp < 1000, 'the mine went off under the zombie');
  assert.equal(mineWorld.thrown.length, 0);
});

test('a human shoots zombies for plain damage: the fourfold-health handicap is only against bots', () => {
  const w = nightWorld();
  const p = spawnAt(w, X, Y, { kind: 'human' });
  const z = addZombie(w, 'brute', X, Y + 300, 1000);
  shootOnce(w, p, DOWN);
  near(1000 - z.hp, GUNS.pistol.damage * ON_HORDE);
});

test('in a run only bites hurt the squad: a blast at a player\'s own feet leaves them whole', () => {
  const w = nightWorld();
  const p = spawnAt(w, X, Y);
  const before = hpOf(p);
  explode(w, X, Y, 130, 90, { attacker: p, team: p.team, label: 'test' });
  assert.equal(hpOf(p), before);
});

test('a shotgun blast into one zombie reads as one hit marker carrying all its pellets', () => {
  const w = nightWorld();
  const p = spawnAt(w, X, Y, { loadout: { weapon: 'shotgun' } });
  const z = addZombie(w, 'brute', X, Y + 60, 10_000);
  press(w, p, { angle: DOWN, fire: true, shots: p.input.shots + 1 });
  run(w, TICK_MS);
  const marks = w.events.filter((e) => e.e === 'dmg' && e.victim === z.id);
  assert.equal(marks.length, 1);
  // The marker sums each pellet's harm to the tenth, so it may sit a twentieth a pellet off the exact total.
  assert.ok(marks[0]!.e === 'dmg' && Math.abs(marks[0]!.amount - (10_000 - z.hp)) <= 0.05 * GUNS.shotgun.pellets + 1e-9, `${marks[0]!.e === 'dmg' && marks[0]!.amount} against ${10_000 - z.hp}`);
  assert.ok(10_000 - z.hp > GUNS.shotgun.damage * ON_HORDE * zombieRole('shotgun').vs.walker!, 'more than one pellet landed');
});
