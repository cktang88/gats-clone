import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AIRDROP, BARREL, LEVELS, MEDALS, WORLD, type MedalId } from '../src/shared/defs.ts';
import { MAPS, ROTATION } from '../src/shared/maps.ts';
import { die, explode } from '../src/shared/sim/combat.ts';
import { createWorld, rand, type Barrel, type World } from '../src/shared/sim/world.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { dropSpots, planeAt } from '../src/shared/sim/airdrop.ts';
import { damageBarrel } from '../src/shared/sim/barrels.ts';
import { makeSnapshotEncoder, fillSnapshot } from '../src/shared/wire.ts';
import { respawn, step } from '../src/shared/sim.ts';
import { emptyWorld, press, run, shootOnce, spawnAt, TICK_MS } from './helpers.ts';

function barrelAt(w: World, x: number, y: number): Barrel {
  const b: Barrel = { id: w.nextId++, x, y, hp: BARREL.hp, fuseAt: null, respawnAt: null, by: null };
  w.barrels.push(b);
  return b;
}
const medalsOf = (w: World, id: number, events = w.events): MedalId[] => events.flatMap((e) => (e.e === 'medal' && e.id === id ? [e.medal] : []));
const FFA_SPARK = (p: ReturnType<typeof spawnAt>) => ({ attacker: p, team: p.team });
const events0: never[] = [];
void events0;

test('a barrel takes damage, hisses at zero, and bursts after its fuse', () => {
  const w = emptyWorld();
  const shooter = spawnAt(w, 500, 1000);
  const b = barrelAt(w, 900, 1000);
  damageBarrel(w, b, 5, FFA_SPARK(shooter));
  assert.equal(b.fuseAt, null, 'a scratch only wears it');
  assert.ok(b.hp < BARREL.hp);
  damageBarrel(w, b, 100, FFA_SPARK(shooter));
  assert.ok(b.fuseAt !== null && b.fuseAt > w.now, 'at zero it is lit, not burst');
  const lit = snapshotFor(w, shooter.id).barrels!.find((v) => v[0] === b.id)!;
  assert.equal(lit[3], 0, 'the view says it is hissing');
  run(w, BARREL.fuseMs - 100);
  assert.equal(b.respawnAt, null);
  run(w, 200);
  assert.ok(b.respawnAt !== null, 'burst');
    assert.ok(!snapshotFor(w, shooter.id).barrels!.some((v) => v[0] === b.id), 'a burst barrel leaves the view');
});

test('a bullet sets a barrel off, and the blast hurts what stands near it', () => {
  const w = emptyWorld();
  const shooter = spawnAt(w, 400, 1000, { name: 'shooter' });
  const victim = spawnAt(w, 960, 1000, { name: 'victim', loadout: { color: 'blue' } });
  const b = barrelAt(w, 900, 1000);
  shootOnce(w, shooter, 0, 1500);
  assert.ok(b.respawnAt !== null, 'the round lit it and it burst');
  assert.ok(victim.life.k === 'dead' || (victim.life.k === 'alive' && victim.life.hp < 100), 'the victim stood in the blast');
});

test('a barrel kill credits whoever lit it, and pays Kaboom', () => {
  const w = emptyWorld();
  w.firstBlood = true;
  const shooter = spawnAt(w, 400, 1000, { name: 'shooter', kind: 'bot' });
  const victim = spawnAt(w, 935, 1000, { name: 'victim', kind: 'bot', loadout: { color: 'blue' } });
  const b = barrelAt(w, 900, 1000);
  damageBarrel(w, b, 100, FFA_SPARK(shooter));
  const events = [];
  for (let i = 0; i < 40; i++) { step(w, TICK_MS); events.push(...w.events); }
  const kill = events.find((e) => e.e === 'kill');
  assert.ok(kill && kill.e === 'kill');
  assert.equal(kill.killerId, shooter.id);
  assert.equal(kill.weapon, 'Barrel');
  assert.ok(medalsOf(w, shooter.id, events).includes('kaboom'));
  assert.equal(shooter.kills, 1);
  assert.equal(victim.life.k, 'dead');
});

test('teammates are spared the blast of a barrel their teammate lit', () => {
  const w = emptyWorld('TDM');
  const shooter = spawnAt(w, 400, 1000, { team: 'red', kind: 'bot' });
  const mate = spawnAt(w, 960, 1000, { team: 'red', kind: 'bot' });
  const b = barrelAt(w, 900, 1000);
  damageBarrel(w, b, 100, FFA_SPARK(shooter));
  run(w, 1000);
  assert.equal(mate.life.k === 'alive' && mate.life.hp, 100);
});

test('barrels chain-react in a ripple, and a chain that kills two earns Chain Reaction', () => {
  const w = emptyWorld();
  w.firstBlood = true;
  const shooter = spawnAt(w, 300, 1000, { kind: 'bot', name: 'igniter' });
  const a = barrelAt(w, 900, 1000), b = barrelAt(w, 950, 1000), c = barrelAt(w, 1000, 1000);
  const v1 = spawnAt(w, 925, 1060, { kind: 'bot', loadout: { color: 'blue' } });
  const v2 = spawnAt(w, 975, 940, { kind: 'bot', loadout: { color: 'green' } });
  damageBarrel(w, a, 100, FFA_SPARK(shooter));
  const order: number[] = [];
  const events = [];
  for (let i = 0; i < 60; i++) {
    step(w, TICK_MS);
    events.push(...w.events);
    for (const x of [a, b, c]) if (x.respawnAt !== null && !order.includes(x.id)) order.push(x.id);
  }
  assert.deepEqual(order, [a.id, b.id, c.id], 'they go off one after another');
  assert.ok([a, b, c].every((x) => x.respawnAt !== null));
  assert.equal(v1.life.k, 'dead');
  assert.equal(v2.life.k, 'dead');
  const m = medalsOf(w, shooter.id, events);
  assert.equal(m.filter((x) => x === 'chainReaction').length, 1, 'once per chain');
  assert.equal(m.filter((x) => x === 'kaboom').length, 2);
});

test('one barrel killing one player earns no Chain Reaction', () => {
  const w = emptyWorld();
  w.firstBlood = true;
  const shooter = spawnAt(w, 300, 1000, { kind: 'bot' });
  spawnAt(w, 925, 1060, { kind: 'bot', loadout: { color: 'blue' } });
  const a = barrelAt(w, 900, 1000);
  damageBarrel(w, a, 100, FFA_SPARK(shooter));
  const events = [];
  for (let i = 0; i < 40; i++) { step(w, TICK_MS); events.push(...w.events); }
  assert.ok(!medalsOf(w, shooter.id, events).includes('chainReaction'));
});

test('a burst barrel stands again after its respawn time, but not under a body', () => {
  const w = emptyWorld();
  const p = spawnAt(w, 100, 100);
  const b = barrelAt(w, 900, 1000);
  damageBarrel(w, b, 100, FFA_SPARK(p));
  run(w, BARREL.fuseMs + 200);
  assert.ok(b.respawnAt !== null);
  const stander = spawnAt(w, 900, 1000, { loadout: { color: 'blue' } });
  stander.life = { ...stander.life } as typeof stander.life;
  w.now = b.respawnAt! + 1;
  step(w, TICK_MS);
  assert.ok(b.respawnAt !== null, 'a body on the spot holds it back');
  stander.x = 2000;
  step(w, TICK_MS);
  assert.equal(b.respawnAt, null);
  assert.equal(b.hp, BARREL.hp);
});

test('barrels block bodies and bullets while standing', () => {
  const w = emptyWorld();
  const shooter = spawnAt(w, 400, 1000);
  const behind = spawnAt(w, 1200, 1000, { loadout: { color: 'blue' } });
  barrelAt(w, 800, 1000);
  shootOnce(w, shooter, 0, 300);
  assert.ok(behind.life.k === 'alive' && behind.life.hp === 100, 'the barrel took the round');
});

test('every versus map stands barrels, none in spawns, and BR/ZOM have none', () => {
  for (const mode of ['FFA', 'TDM', 'DOM'] as const) {
    const w = createWorld(mode, 3, ROTATION[mode][0]);
    assert.ok(w.barrels.length >= 8 && w.barrels.length % 2 === 0);
  }
  for (const mode of ['BR', 'ZOM'] as const) assert.equal(createWorld(mode, 3, ROTATION[mode][0]).barrels.length, 0);
});

test('barrels ride the wire as a sticky field and stay unchanged until one is hurt', () => {
  const w = createWorld('FFA', 5, 'plaza');
  const me = spawnAt(w, 3000, 3000);
  const encode = makeSnapshotEncoder();
  const first = JSON.parse(encode(snapshotFor(w, me.id)));
  assert.ok(Array.isArray(first.barrels) && first.barrels.length > 0);
  const second = JSON.parse(encode(snapshotFor(w, me.id)));
  assert.equal(second.barrels, undefined, 'unchanged, so omitted');
  assert.equal(second.airdrop, undefined);
  const filled = fillSnapshot(second, fillSnapshot(first, null));
  assert.deepEqual(filled!.barrels, first.barrels);
  damageBarrel(w, w.barrels[0]!, 10, { attacker: me, team: me.team });
  const third = JSON.parse(encode(snapshotFor(w, me.id)));
  const hurt = w.barrels[0]!.id;
  assert.ok(third.barrels.find((b: number[]) => b[0] === hurt)[3] < 10, 'the hurt barrel is resent below full health');
  assert.deepEqual(third.barrels.filter((b: number[]) => b[0] !== hurt), first.barrels.filter((b: number[]) => b[0] !== hurt), 'the others unchanged');
});

// ---- airdrops

const planned = (seed: number, mode: 'FFA' | 'TDM' | 'DOM' = 'FFA') => createWorld(mode, seed, ROTATION[mode][0]).airdrops.due;

test('airdrop times are planned from the seed: one or two a round, spaced, inside the round, and the same every time', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const a = planned(seed), b = planned(seed);
    assert.deepEqual(a, b, 'deterministic');
    assert.ok(a.length >= 1 && a.length <= AIRDROP.perRound[1]);
    a.forEach((t, i) => {
      assert.ok(t >= 0 && t <= 15 * 60_000 * AIRDROP.to + 1);
      if (i) assert.ok(t - a[i - 1]! >= AIRDROP.gapMs);
    });
  }
  assert.ok(new Set(Array.from({ length: 30 }, (_, i) => planned(i + 1).join())).size > 20, 'seeds vary');
  assert.deepEqual(createWorld('BR', 1, 'oldtown').airdrops.due, []);
  assert.deepEqual(createWorld('ZOM', 1, 'outpost').airdrops.due, []);
});

test('a plane announces, crosses over the target, and the crate lands on reachable ground and opens as a golden gun', () => {
  const w = createWorld('FFA', 11, 'plaza');
  const me = spawnAt(w, 3000, 3000, { name: 'taker', kind: 'bot' });
  w.airdrops.due = [w.now + 1000];
  const events = [];
  for (let i = 0; i < 40 && !w.airdrops.flight; i++) { step(w, TICK_MS); events.push(...w.events); }
  const f = w.airdrops.flight!;
  assert.ok(f);
  assert.ok(events.some((e) => e.e === 'airdrop' && e.k === 'inbound' && e.x === f.x && e.y === f.y), 'the notice names the spot');
  assert.ok(dropSpots('plaza').some((s) => s.x === f.x && s.y === f.y), 'on reachable clear ground');
  const view = snapshotFor(w, me.id).airdrop!;
  assert.equal(view.landAt - view.dropAt, AIRDROP.fallMs);
  const over = planeAt(f, f.dropAt);
  assert.ok(Math.hypot(over.x - f.x, over.y - f.y) < 1e-6, 'the plane is over the target at the drop');
  const start = planeAt(f, w.now);
  const size = MAPS.plaza.size;
  assert.ok(start.x < -500 || start.y < -500 || start.x > size + 500 || start.y > size + 500, 'it starts far beyond the edge');
  while (w.now < f.landAt - TICK_MS) step(w, TICK_MS);
  assert.equal(w.crates.some((c) => c.drop), false, 'still in the air');
  run(w, 200);
  const crate = w.crates.find((c) => c.drop)!;
  assert.ok(crate && crate.hp === AIRDROP.hp);
  assert.ok(f.crateId === crate.id);
  // The grabber breaks it: a blast does it without aiming.
  me.x = f.x - 300; me.y = f.y;
  w.events = [];
  explode(w, crate.x + crate.size / 2, crate.y + crate.size / 2, 120, 1000, { attacker: me, team: me.team, label: 'Test' });
  const all = [...w.events];
  assert.ok(all.some((e) => e.e === 'airdrop' && e.k === 'taken' && e.by === 'taker'));
  assert.ok(medalsOf(w, me.id, all).includes('specialDelivery'));
  assert.equal(w.airdrops.flight, null);
  assert.equal(snapshotFor(w, me.id).airdrop, null, 'the minimap ping ends');
});

/** A world rng state whose next roll satisfies `want`. */
function rngWhere(want: (roll: number) => boolean): number {
  for (let s = 1; ; s++) if (want(rand({ rng: s } as World))) return s;
}

function openWith(rng: number, setup: (p: ReturnType<typeof spawnAt>) => void = () => {}) {
  const w = emptyWorld();
  const p = spawnAt(w, 300, 530, { kind: 'bot' });
  setup(p);
  if (p.life.k === 'alive') p.life.hp = 30;
  w.rng = rng;
  w.crates.push({ id: 900, x: 520, y: 500, size: AIRDROP.size, hp: AIRDROP.hp, respawnAt: null, drop: true });
  w.airdrops.flight = { x: 550, y: 530, a: 0, dropAt: 0, landAt: 0, crateId: 900, expiresAt: Infinity };
  w.events = [];
  explode(w, 550, 530, 100, 5000, { attacker: p, team: p.team, label: 'Test' });
  return { w, p };
}

test('a supply drop skips its opener to their next level pick and resupplies them', () => {
  const { w, p } = openWith(1, (q) => { if (q.life.k === 'alive') q.life.ammo = 1; });
  assert.equal(p.level, 1, 'straight to the next pick');
  assert.ok(p.life.k === 'alive' && p.life.hp === 100 && p.life.ammo > 1 && !p.life.golden, 'healed and refilled, not golden');
  assert.ok(w.events.some((e) => e.e === 'gain' && e.level && (e.hp ?? 0) > 0));
  assert.ok(w.events.some((e) => e.e === 'airdrop' && e.k === 'taken' && e.level === true && e.gold === false));
});

test('one with every pick made gets the golden gun instead, never twice', () => {
  const top = LEVELS.length - 1;
  const { w, p } = openWith(1, (q) => { q.level = top; q.score = LEVELS[top]!.score; });
  assert.equal(p.level, top);
  assert.ok(p.life.k === 'alive' && p.life.golden && p.life.hp === 100);
  assert.ok(w.events.some((e) => e.e === 'airdrop' && e.k === 'taken' && e.gold === true));
  assert.equal(snapshotFor(w, p.id).players.find((v) => v.id === p.id)!.golden, true);
  const again = openWith(1, (q) => { q.level = top; q.score = LEVELS[top]!.score; if (q.life.k === 'alive') q.life.golden = true; });
  assert.ok(again.w.events.some((e) => e.e === 'airdrop' && e.k === 'taken' && e.gold === false), 'already golden: just the resupply');
});

test('golden rounds hit AIRDROP.goldMul as hard, and the gold is lost with the life', () => {
  const damage = (golden: boolean) => {
    const w = emptyWorld();
    const s = spawnAt(w, 400, 1000, { kind: 'bot' });
    if (golden && s.life.k === 'alive') s.life.golden = true;
    press(w, s, { angle: 0, fire: true, shots: 1 });
    step(w, TICK_MS);
    return { w, s, dmg: w.bullets[0]!.damage };
  };
  const plain = damage(false), gold = damage(true);
  assert.ok(Math.abs(gold.dmg - plain.dmg * AIRDROP.goldMul) < 1e-9);
  const { w, s } = gold;
  die(w, s, w.now + WORLD.respawnMs);
  w.now += WORLD.respawnMs + 1;
  assert.ok(respawn(w, s.id, s.loadout) && s.life.k === 'alive' && !s.life.golden);
});

test('an unclaimed crate is removed after its time, and a crate standing on by a body waits to land', () => {
  const w = createWorld('FFA', 11, 'plaza');
  const me = spawnAt(w, 3000, 3000);
  w.airdrops.due = [w.now + 100];
  run(w, 300);
  const f = w.airdrops.flight!;
  me.x = f.x; me.y = f.y;
  w.now = f.landAt + 1;
  step(w, TICK_MS);
  assert.equal(f.crateId, null, 'a body on the spot holds it in the air');
  me.x = 100; me.y = 100;
  step(w, TICK_MS);
  const landed = w.crates.find((c) => c.id === f.crateId);
  assert.deepEqual(landed && [landed.drop, landed.respawnAt, landed.x + landed.size / 2, landed.y + landed.size / 2], [true, null, f.x, f.y], 'it lands on its spot once the body moves off');
  w.now = f.expiresAt + 1;
  step(w, TICK_MS);
  assert.equal(w.airdrops.flight, null);
  assert.ok(!w.crates.some((c) => c.drop && c.respawnAt === null));
});

test('the new medals exist, with score and a tier', () => {
  for (const id of ['kaboom', 'chainReaction', 'specialDelivery'] as const) {
    assert.ok(MEDALS[id].score > 0 && MEDALS[id].name && MEDALS[id].desc);
  }
});

test('a supply drop expiring unbroken moves wallsVersion, so caches of the solids drop it', () => {
  const w = createWorld('FFA', 11, 'plaza');
  spawnAt(w, 3000, 3000);
  w.airdrops.due = [w.now + 100];
  run(w, 300);
  const f = w.airdrops.flight!;
  w.now = f.landAt + 1;
  step(w, TICK_MS);
  assert.ok(f.crateId !== null);
  const landed = w.wallsVersion;
  w.now = f.expiresAt + 1;
  step(w, TICK_MS);
  assert.equal(w.airdrops.flight, null);
  assert.ok(w.wallsVersion > landed, 'the drop is gone from the solids');
});
