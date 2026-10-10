import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { BOUNTY, BUILDINGS, GUN_IDS, HORDE_GUN_MUL, GUNS, HORDE_DPS, WEAPON_IDS, ZOM, zombieBounty, zombieRole, ZOMBIE_CLASS_ROLES, ZOMBIES, type GunId, type ZombieKind } from '../src/shared/defs.ts';
import { step } from '../src/shared/sim.ts';
import { zombieMaxHp } from '../src/shared/sim/run.ts';
import { createWorld, newId, type World, type Zombie } from '../src/shared/sim/world.ts';
import { playGunRun } from '../scripts/lib/zombieguns.ts';
import { emptyWorld, equip, hpOf, press, run, shootOnce, spawnAt, TICK_MS } from './helpers.ts';
/** Harm to the tenth of a millionth: a product of multipliers is not exact in floating point. */
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const near = (actual: number, expected: number, message?: string) => (message === undefined ? assert.equal(r6(actual), r6(expected)) : assert.equal(r6(actual), r6(expected), message));


// What each gun does to the horde in Zombies (`ZombieRole`, `zombieBounty` in defs.ts; scripts/bench-zombie-guns.ts measures it), and that none of it reaches versus.

function nightWorld(): World {
  const w = createWorld('ZOM', 1, 'outpost');
  // A pack still to come that never does, so the night never turns to a dawn that pays the survivors.
  w.run!.phase = { k: 'night', toSpawn: [{ kind: 'walker', side: 'north', n: 1 }], nextSpawnAt: Infinity, dawnAt: Infinity };
  w.run!.core.hp = 1e9;
  return w;
}
const X = 1475, Y = 1700, DOWN = Math.PI / 2;
/** Holds a zombie where it stands (a hold at no pace), so a file of them stays a file while a slow round flies down it. */
const stand = (z: Zombie) => { z.slow = { mul: 0, until: Infinity }; return z; };
function addZombie(w: World, kind: ZombieKind, x: number, y: number, hp = zombieMaxHp(kind, 1, 1)) {
  const z: Zombie = { id: newId(w), kind, x, y, hp, attackAt: Infinity, vx: 0, vy: 0 };
  w.zombies.push(z);
  return z;
}

test('the bounty follows sustained harm, starkly: slower guns pay much more, the belt-fed guns about half, all within the clamp', () => {
  for (const g of GUN_IDS) {
    const b = zombieBounty(g);
    assert.ok(b >= BOUNTY.min && b <= BOUNTY.max, `${g} x${b}`);
  }
  const slowest = [...GUN_IDS].sort((a, b) => HORDE_DPS[a] - HORDE_DPS[b])[0]!, fastest = [...GUN_IDS].sort((a, b) => HORDE_DPS[b] - HORDE_DPS[a])[0]!;
  assert.ok(zombieBounty(slowest) > 1.3, `${slowest} pays x${zombieBounty(slowest)}`);
  assert.equal(zombieBounty(fastest), BOUNTY.min, `${fastest} pays the least`);
  assert.ok(zombieBounty('shotgun') > zombieBounty('lmg') && zombieBounty('pistol') > zombieBounty('minigun'));
  // The spread is stark: every machine gun pays at most 0.6, the bolt-actions at least 2.5, the shotguns at least 2 and the assault rifle the plain price.
  for (const g of GUN_IDS.filter((id) => GUNS[id].base === 'lmg')) assert.ok(zombieBounty(g) <= 0.6, `${g} x${zombieBounty(g)}`);
  for (const g of ['sniper', 'longshot', 'piercer'] as const) assert.ok(zombieBounty(g) >= 2.5, `${g} x${zombieBounty(g)}`);
  for (const g of ['shotgun', 'slugGun', 'doubleBarrel', 'sawedOff'] as const) assert.ok(zombieBounty(g) >= 2, `${g} x${zombieBounty(g)}`);
  assert.equal(zombieBounty('assault'), 1);
  // Mag size and reload count: the LMG's 100-round belt out-harms an assault rifle through a whole night of fire.
  assert.ok(HORDE_DPS.lmg > HORDE_DPS.assault && HORDE_DPS.assault > HORDE_DPS.sniper);
});

test('a kill pays the zombie\'s scrap times the killer\'s gun bounty, in the bank, the run stats and the zkill event; a turret\'s kill pays the plain price', () => {
  for (const gun of ['shotgun', 'minigun', 'pistol'] as GunId[]) {
    const w = nightWorld();
    const p = spawnAt(w, X, Y);
    equip(p, gun);
    const z = addZombie(w, 'walker', X, Y + 120, 1);
    const scrap = w.run!.scrap;
    shootOnce(w, p, DOWN, 100);
    assert.ok(!w.zombies.includes(z), `${gun} killed it`);
    const paid = Math.round(ZOMBIES.walker.scrap * zombieBounty(gun) * 100) / 100;
    assert.ok(Math.abs(w.run!.scrap - scrap - paid) < 1e-9, `${gun}: the bank took ${w.run!.scrap - scrap}, not ${paid}`);
    assert.equal(w.run!.stats.get(p.id)!.scrap, paid);
  }
  const w = nightWorld();
  const p = spawnAt(w, X, Y);
  equip(p, 'shotgun');
  addZombie(w, 'walker', X, Y + 120, 1);
  press(w, p, { angle: DOWN, fire: true, shots: p.input.shots + 1 });
  let ev = null;
  for (let i = 0; i < 20 && !ev; i++) { step(w, TICK_MS); ev = w.events.find((e) => e.e === 'zkill') ?? null; }
  assert.deepEqual(ev && { by: ev.by, scrap: ev.scrap }, { by: p.id, scrap: Math.round(ZOMBIES.walker.scrap * zombieBounty('shotgun') * 100) / 100 }, 'the event says what the kill paid');

  const t = nightWorld();
  const owner = spawnAt(t, 300, 300);
  t.buildings.push({ id: newId(t), kind: 'sentry', cx: Math.floor(X / ZOM.cell), cy: Math.floor(Y / ZOM.cell), hp: BUILDINGS.sentry.hp, owner: owner.id, ammo: 120, nextFireAt: 0 });
  t.buildingsVersion++;
  addZombie(t, 'walker', X, Y + 150, 1);
  const before = t.run!.scrap;
  let kill = null;
  for (let i = 0; i < 60 && !kill; i++) { step(t, TICK_MS); kill = t.events.find((e) => e.e === 'zkill') ?? null; }
  assert.ok(kill, 'the sentry killed it');
  assert.equal(kill.scrap, ZOMBIES.walker.scrap);
  assert.equal(t.run!.scrap - before, ZOMBIES.walker.scrap);
});

test('a sniper round pierces a line of zombies; a pistol round stops in the first', () => {
  const w = nightWorld();
  const p = spawnAt(w, X, Y);
  const line = [0, 1, 2, 3, 4].map((i) => addZombie(w, 'walker', X, Y + 120 + i * 45, 1000));
  shootOnce(w, p, DOWN);
  assert.deepEqual(line.map((z) => 1000 - z.hp).map(r6), [GUNS.pistol.damage * HORDE_GUN_MUL, 0, 0, 0, 0].map(r6));
  const v = nightWorld();
  const s = spawnAt(v, X, Y);
  equip(s, 'sniper');
  // Walkers die to the bolt's round outright, so each one it reached is gone or hurt; the one after the last it may pass is untouched.
  const row = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => stand(addZombie(v, 'walker', X, Y + 120 + i * 45, 1000)));
  // A bolt-action is pinpoint once planted and steady, so it stands a moment first.
  press(v, s, { angle: DOWN });
  run(v, 600);
  shootOnce(v, s, DOWN, 600);
  const pierce = zombieRole('sniper').pierce;
  assert.ok(pierce >= 5, `a bolt-action pierces ${pierce}`);
  assert.deepEqual(row.map((z) => z.hp < 1000), row.map((_, i) => i <= pierce), `the round passes ${pierce} and stops in the next`);
});

test('a bolt-action one-shots every walker and runner in its lane, far out on the Tide', () => {
  const w = nightWorld();
  w.run!.night = 10;
  const s = spawnAt(w, X, Y);
  equip(s, 'sniper');
  const lane = [0, 1, 2, 3, 4, 5, 6].map((i) => stand(addZombie(w, i % 2 ? 'runner' : 'walker', X, Y + 300 + i * 40, zombieMaxHp(i % 2 ? 'runner' : 'walker', 10, 1))));
  press(w, s, { angle: DOWN });
  run(w, 600);
  shootOnce(w, s, DOWN, 900);
  assert.deepEqual(lane.map((z) => w.zombies.includes(z)), lane.map(() => false), 'one round, seven dead, out to 540 px');
  const semi = nightWorld();
  const q = spawnAt(semi, X, Y);
  equip(q, 'repeater');
  const z = addZombie(semi, 'walker', X, Y + 200, 5000);
  shootOnce(semi, q, DOWN, 400);
  assert.ok(z.hp > 0, 'a quick-firing marksman rifle earns no one-shot');
});

test('kinds take each class\'s multiplier, plating comes off by the role, and blasts lose half to plate', () => {
  const hit = (gun: GunId, kind: ZombieKind) => {
    const w = nightWorld();
    const p = spawnAt(w, X, Y);
    equip(p, gun);
    const z = addZombie(w, kind, X, Y + 110, 5000);
    shootOnce(w, p, DOWN, 400);
    return 5000 - z.hp;
  };
  near(hit('sniper', 'brute'), GUNS.sniper.damage * HORDE_GUN_MUL * zombieRole('sniper').vs.brute!, 'a bolt hits a brute harder');
  assert.ok(zombieRole('sniper').vs.brute! > 1);
  near(hit('lmg', 'walker'), GUNS.lmg.damage * HORDE_GUN_MUL, 'every player round reaches the horde at HORDE_GUN_MUL');
  near(hit('smg', 'runner'), GUNS.smg.damage * HORDE_GUN_MUL * 1.75, 'an SMG round hits a runner 1.75 times as hard');
  near(hit('pistol', 'runner'), GUNS.pistol.damage * HORDE_GUN_MUL * 1.5);
  near(hit('assault', 'plated'), (GUNS.assault.damage - ZOMBIES.plated.plate / 2) * HORDE_GUN_MUL, 'an assault round loses only half the plate');
  near(hit('lmg', 'plated'), (GUNS.lmg.damage - ZOMBIES.plated.plate) * HORDE_GUN_MUL, 'an LMG round loses all of it');
  // A boom slug's blast on a plated zombie and on a walker side by side, past the slug's own hit: the plate takes half of it.
  const blast = (kind: ZombieKind) => {
    const w = nightWorld();
    const p = spawnAt(w, X, Y);
    equip(p, 'boomSlug');
    addZombie(w, 'brute', X, Y + 150, 1e6);
    const z = addZombie(w, kind, X + 45, Y + 150, 5000);
    shootOnce(w, p, DOWN, 300);
    return 5000 - z.hp;
  };
  const walker = blast('walker'), plated = blast('plated');
  assert.ok(walker > 0, 'the blast reached the walker');
  assert.ok(Math.abs(plated / walker - 0.5) < 0.08, `plated took ${plated} of the walker's ${walker}`);
});

test('a shotgun staggers what it hits and an LMG suppresses it: both walk slower for a while', () => {
  const walked = (gun: GunId | null) => {
    const w = nightWorld();
    const p = spawnAt(w, X, Y);
    const z = addZombie(w, 'walker', X, Y + 300, 1e6);
    run(w, 600);
    if (gun) {
      equip(p, gun);
      press(w, p, { angle: Math.atan2(z.y - p.y, z.x - p.x), fire: true, shots: p.input.shots + 1 });
      step(w, TICK_MS);
      press(w, p, { angle: DOWN });
      step(w, TICK_MS);
      step(w, TICK_MS);
      assert.ok(z.slow && z.slow.until > w.now, `${gun} held it`);
      assert.equal(z.slow.mul, zombieRole(gun).slow!.mul);
    } else run(w, 3 * TICK_MS);
    const y0 = z.y;
    run(w, 400);
    return y0 - z.y;
  };
  const free = walked(null), staggered = walked('shotgun'), suppressed = walked('lmg');
  assert.ok(staggered < free * 0.6, `staggered ${staggered.toFixed(0)} px against ${free.toFixed(0)}`);
  assert.ok(suppressed < free * 0.9, `suppressed ${suppressed.toFixed(0)} px against ${free.toFixed(0)}`);
  assert.equal(ZOMBIE_CLASS_ROLES.shotgun.shove, 2, 'and the shotgun shoves packs twice as hard');
});

test('a sidearm holder mends a wall faster than an LMG holder', () => {
  const mended = (gun: GunId) => {
    const w = createWorld('ZOM', 1, 'outpost');
    w.run!.scrap = 1e6;
    const p = spawnAt(w, X, Y);
    equip(p, gun);
    const b = { id: newId(w), kind: 'wall' as const, cx: Math.floor(X / ZOM.cell), cy: Math.floor((Y + 100) / ZOM.cell), hp: 10, lv: 3 };
    w.buildings.push(b);
    w.buildingsVersion++;
    press(w, p, { use: true });
    run(w, 1000);
    return b.hp - 10;
  };
  assert.ok(Math.abs(mended('pistol') / mended('lmg') - ZOMBIE_CLASS_ROLES.pistol.mend) < 0.05, `${mended('pistol')} against ${mended('lmg')}`);
});

/**
 * Versus is untouched: every gun's round, and its blast, into a player in FFA lands exactly as before the zombie roles. The hash is of each gun's harm and shove
 * on a player and on a second one behind them, recorded before the roles were added (at bf1c693).
 */
test('versus: every gun hits players exactly as before the zombie roles', () => {
  const out: string[] = [];
  for (const gun of GUN_IDS) {
    const w = emptyWorld('FFA');
    const p = spawnAt(w, 500, 500, { kind: 'human' });
    const a = spawnAt(w, 500, 640, { kind: 'human', loadout: { armor: 'medium' } });
    const b = spawnAt(w, 500, 700, { kind: 'human' });
    equip(p, gun);
    shootOnce(w, p, DOWN, 300);
    const knock = (q: typeof a) => (q.life.k === 'alive' && q.life.knock ? `${q.life.knock.vx.toFixed(3)},${q.life.knock.vy.toFixed(3)}` : '-');
    out.push(`${gun}:${hpOf(a).toFixed(4)}:${hpOf(b).toFixed(4)}:${a.y.toFixed(3)}:${b.y.toFixed(3)}:${knock(a)}:${knock(b)}`);
  }
  assert.equal(createHash('sha256').update(out.join('|')).digest('hex').slice(0, 16), VERSUS_HASH, out.join('\n'));
});
const VERSUS_HASH = '3d83714161d22d23';

test('a seeded zombies squad: the lowest-harm class gun is not strictly dominated by the highest', () => {
  const lowest = [...WEAPON_IDS].sort((x, y) => HORDE_DPS[x] - HORDE_DPS[y])[0]!, highest = [...WEAPON_IDS].sort((x, y) => HORDE_DPS[y] - HORDE_DPS[x])[0]!;
  const lo = playGunRun(1, lowest, 2, 3), hi = playGunRun(1, highest, 2, 3);
  // Strictly dominated would be worse on every count at once: the squad's bank (what it could build), the night reached, the core health lost, and each kind's kills.
  const wins = {
    bank: lo.bank > hi.bank, night: lo.night > hi.night, core: lo.coreLost < hi.coreLost,
    ...Object.fromEntries((['walker', 'runner', 'plated', 'bloater', 'brute'] as const).map((k) => [k, lo.byKind[k] > hi.byKind[k]])),
  };
  assert.ok(Object.values(wins).some(Boolean), `${lowest} wins nothing against ${highest}: ${JSON.stringify({ lo, hi })}`);
  assert.ok(lo.bank >= 0.9 * hi.bank, `the ${lowest} squad banked ${lo.bank.toFixed(0)} against the ${highest} squad's ${hi.bank.toFixed(0)}`);
});
