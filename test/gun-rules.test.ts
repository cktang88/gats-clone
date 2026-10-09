import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARMOR_IDS, ARMORS, ATTACHMENTS, GUN_IDS, GUNS, minSpreadOf, PICK_OPTIONS, pickOptions, rulesOf, SPREAD_EASE, WEAPON_IDS, WORLD, type GunId, type PickOption } from '../src/shared/defs.ts';
import type { InputState } from '../src/shared/protocol.ts';
import { step } from '../src/shared/sim.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { choosePick, isSteady, pendingPick, spreadFor } from '../src/shared/sim/stats.ts';
import type { Player, World } from '../src/shared/sim/world.ts';
import { emptyWorld, equip, grantPerks, offerPerks, press, run, spawnAt, TICK_MS } from './helpers.ts';

const TIER_1 = { k: 'perk', tier: 1 } as const;

function shooter(gun: GunId, mode: 'FFA' | 'ZOM' = 'FFA', kind: 'bot' | 'human' = 'bot'): { w: World; p: Player } {
  const w = emptyWorld(mode);
  const p = spawnAt(w, 2000, 2000, { loadout: { weapon: GUNS[gun].base }, kind });
  equip(p, gun);
  return { w, p };
}

function tick(w: World, p: Player, input: Partial<InputState>): number[] {
  const before = new Set(w.bullets.map((b) => b.id));
  press(w, p, { angle: 0, ...input });
  step(w, TICK_MS);
  return w.bullets.filter((b) => !before.has(b.id)).map((b) => Math.atan2(b.vy, b.vx));
}

function spray(gun: GunId, still: boolean, count: number): number[] {
  const { w, p } = shooter(gun);
  if (still) run(w, 400);
  const angles: number[] = [];
  while (angles.length < count) angles.push(...tick(w, p, { fire: true, shots: p.input.shots + 1, right: !still }));
  return angles;
}

const widest = (angles: readonly number[]) => Math.max(...angles.map(Math.abs));

test('pistol and SMG lose nothing on the move and a shotgun little; assault drifts a lot, LMG much more, a walking sniper misses past 300px', () => {
  // The sway is the gun's weight and length (handling.ts): [least, most] of the still spread on the move.
  const expected: Record<string, readonly [number, number]> = { pistol: [1, 1], smg: [1, 1], shotgun: [1, 1.2], assault: [1.6, 1.8], lmg: [1.9, 2.2] };
  for (const weapon of WEAPON_IDS.filter((w) => w !== 'sniper')) {
    const ratio = spreadFor(weapon, {}, false) / spreadFor(weapon, {}, true), [lo, hi] = expected[weapon]!;
    assert.ok(ratio >= lo - 1e-9 && ratio <= hi + 1e-9, `${weapon} moves at ${ratio}x spread`);
  }
  for (const gun of ['sniper', 'longshot', 'piercer'] as const) {
    assert.ok(spreadFor(gun, {}, false) > Math.atan(WORLD.playerRadius / 300), `a walking ${gun} can miss a body 300px off`);
    assert.ok(spreadFor(gun, {}, true) < Math.atan(WORLD.playerRadius / 1000), `a planted ${gun} is sure at 1000px`);
  }
});

test('a sniper settles almost half a second after its last step, an assault rifle a tenth, an LMG a fifth, and the rest at once', () => {
  assert.equal(isSteady('sniper', 0), false, 'walking');
  assert.equal(isSteady('sniper', 400), false, 'just stopped');
  assert.equal(isSteady('sniper', 450), true);
  assert.equal(isSteady('assault', 100), false);
  assert.equal(isSteady('assault', 120), true);
  assert.equal(isSteady('lmg', 150), false);
  assert.equal(isSteady('lmg', 200), true);
  assert.equal(isSteady('pistol', 1), true);
  assert.equal(isSteady('pistol', 0), false);
  const { w, p } = shooter('sniper');
  for (let i = 0; i < 5; i++) tick(w, p, { right: true });
  const flick = tick(w, p, { fire: true, shots: p.input.shots + 1 });
  assert.ok(flick.length === 1 && Math.abs(flick[0]!) <= spreadFor('sniper', {}, false), 'a shot the tick after stopping flies with the walking cone');
});

test('a sniper\'s patient rounds stay inside its still cone standing and stray far past it walking', () => {
  const cone = GUNS.sniper.spread;
  const { w, p } = shooter('sniper');
  // Planted (its steadyMs) and the pinpoint eased in (SPREAD_EASE: spread never jumps, even tightening).
  run(w, rulesOf(GUNS.sniper).steadyMs + SPREAD_EASE.ms + 100);
  const patient: number[] = [];
  while (patient.length < 5) {
    patient.push(...tick(w, p, { fire: true, shots: p.input.shots + 1 }));
    // Each round waits out the bloom of the last before it goes.
    for (let i = 0; i < Math.ceil(2600 / TICK_MS); i++) tick(w, p, {});
  }
  assert.ok(widest(patient) <= minSpreadOf(GUNS.sniper) && widest(patient) > 0, 'standing still, re-settled: within its small floor, never exactly on the line');
  assert.ok(widest(spray('sniper', false, 20)) > 2 * cone, 'walking');
  assert.ok(widest(spray('pistol', false, 20)) <= spreadFor('pistol', {}, false), 'a pistol walking stays in its slightly wider walking cone');
});

test('an assault rifle held down blooms after its first shots, up to two and a half times, and taps stay tight', () => {
  const { w, p } = shooter('assault');
  run(w, 400);
  const held: number[][] = [];
  while (held.length < 25) {
    const out = tick(w, p, { fire: true, shots: 1 });
    if (out.length) held.push(out);
  }
  const spray = p.life.k === 'alive' ? p.life.spray : 0;
  const bloom = rulesOf(GUNS.assault).bloom!, standingCap = GUNS.assault.spread * (1 + (bloom.maxMul - 1) * bloom.still);
  assert.ok(Math.abs(spreadFor('assault', {}, true, spray) - standingCap) < 1e-12, 'a long spray standing reaches its (smaller) standing cap');
  assert.ok(Math.abs(spreadFor('assault', {}, true, 1000) - standingCap) < 1e-12, 'and holds there, however long the spray');
  assert.ok(Math.abs(spreadFor('assault', {}, false, 1000) - bloom.maxMul * spreadFor('assault', {}, false)) < 1e-12, 'on the move it blooms the full way');
  assert.equal(spreadFor('assault', {}, true, 3), GUNS.assault.spread, 'the first three shots of a spray do not bloom');
  assert.ok(widest(held.slice(0, 3).flat()) <= GUNS.assault.spread);
  assert.ok(widest(held.slice(10).flat()) > GUNS.assault.spread, 'later rounds stray past the still cone');

  const tapped: number[] = [];
  const t = shooter('assault');
  run(t.w, 400);
  while (tapped.length < 20) {
    tapped.push(...tick(t.w, t.p, { fire: true, shots: t.p.input.shots + 1 }));
    for (let i = 0; i < 6; i++) tapped.push(...tick(t.w, t.p, {}));
  }
  assert.ok(widest(tapped) <= GUNS.assault.spread, 'four taps a second never bloom');
});

test('guns handle the same in Zombies as between players: a held trigger blooms just as far', () => {
  const spreads = (['FFA', 'ZOM'] as const).map((mode) => {
    const { w, p } = shooter('assault', mode);
    const rounds: number[][] = [];
    while (rounds.length < 25) {
      const out = tick(w, p, { fire: true, shots: 1 });
      if (out.length) rounds.push(out);
    }
    return widest(rounds.slice(10).flat());
  });
  assert.ok(spreads[1]! > GUNS.assault.spread, 'a long spray at the horde strays past the still cone');
  assert.ok(spreads[1]! <= rulesOf(GUNS.assault).bloom!.maxMul * GUNS.assault.spread + 1e-9);
});

test('assault bloom is gone a third of a second after letting go, and a reload clears it', () => {
  const { w, p } = shooter('assault');
  for (let i = 0; i < 40; i++) tick(w, p, { fire: true, shots: 1 });
  const sprayOf = () => (p.life.k === 'alive' ? p.life.spray : -1);
  assert.ok(sprayOf() > 5, `spray ${sprayOf()} under held fire`);
  for (let i = 0; i < 13; i++) tick(w, p, {});
  assert.equal(sprayOf(), 0, 'cooled within 13 ticks: a 150ms settle, then 190ms');
  for (let i = 0; i < 20; i++) tick(w, p, { fire: true, shots: 1 });
  tick(w, p, { fire: true, shots: 1, reload: true });
  assert.equal(sprayOf(), 0, 'reloading clears it even with the trigger held');
});

function gaps(w: World, p: Player, ticks: number): number[] {
  const fired: number[] = [];
  for (let i = 0; i < ticks; i++) if (tick(w, p, { fire: true, shots: 1 }).length) fired.push(i);
  return fired.slice(1).map((t, i) => t - fired[i]!);
}

test('a minigun spins up: its first shots come slowly and the held rate climbs to its fireMs, then spins back down after release', () => {
  const { w, p } = shooter('minigun');
  const first = gaps(w, p, 90);
  assert.ok(first[0]! * TICK_MS >= 2.5 * GUNS.minigun.fireMs, `first gap ${first[0]! * TICK_MS}ms`);
  const late = first.slice(-20);
  const meanMs = (late.reduce((a, b) => a + b, 0) * TICK_MS) / late.length;
  assert.ok(Math.abs(meanMs - GUNS.minigun.fireMs) < 2, `spun-up gap ${meanMs}ms`);
  for (let i = 0; i < 30; i++) tick(w, p, {});
  const again = gaps(w, p, 10);
  assert.ok(again[0]! * TICK_MS >= 2.5 * GUNS.minigun.fireMs, 'a second after release it starts slow again');
  const light = shooter('lightMg');
  assert.ok(gaps(light.w, light.p, 10)[0]! * TICK_MS < GUNS.lightMg.fireMs + TICK_MS, 'a light MG does not spin up');
});

test('a sniper sees 28% further, and the server sends what that view holds', () => {
  const w = emptyWorld();
  const sniper = spawnAt(w, 1000, 1000, { loadout: { weapon: 'sniper' } });
  const pistol = spawnAt(w, 1000, 1400);
  const target = spawnAt(w, 1950, 1200);
  assert.ok(Math.abs(snapshotFor(w, sniper.id).self.viewRadius - WORLD.viewRadius * 1.28) < 1e-9);
  assert.equal(snapshotFor(w, pistol.id).self.viewRadius, WORLD.viewRadius);
  assert.ok(snapshotFor(w, sniper.id).players.some((q) => q.id === target.id), 'the sniper sees 950px out');
  assert.ok(!snapshotFor(w, pistol.id).players.some((q) => q.id === target.id), 'the pistol does not');
});

test('each class is offered its own five attachments', () => {
  const menus: Record<string, string[]> = {
    pistol: ['extended', 'quickReload', 'silencer', 'lightweight', 'optics'],
    smg: ['grip', 'extended', 'silencer', 'longRange', 'lightweight'],
    shotgun: ['choke', 'quickReload', 'extended', 'lightweight', 'piercing'],
    assault: ['grip', 'extended', 'silencer', 'optics', 'piercing'],
    sniper: ['extended', 'thermal', 'ghillie', 'silencer', 'quickReload'],
    lmg: ['quickReload', 'grip', 'lightweight', 'piercing', 'extended'],
  };
  for (const weapon of WEAPON_IDS) assert.deepEqual([...pickOptions(TIER_1, weapon)], menus[weapon], weapon);
  const w = emptyWorld();
  const p = spawnAt(w, 500, 500);
  p.level = 2;
  assert.ok(choosePick(w, p.id, 2, 'handCannon'), 'level 2 is the gun evolve');
  assert.equal(choosePick(w, p.id, 1, 'grip'), false, 'a pistol cannot take an SMG attachment');
  assert.ok(choosePick(w, p.id, 1, 'silencer'));
});

test('an attachment that would change nothing for the gun in hand is never offered', () => {
  for (const gun of GUN_IDS) {
    const offered = pickOptions(TIER_1, gun);
    if (GUNS[gun].silenced) assert.ok(!offered.includes('silencer'), `${gun} is already silenced`);
    if (GUNS[gun].pellets < 2) assert.ok(!offered.includes('choke'), `${gun} fires no pellets to choke`);
    assert.ok(offered.every((o) => ATTACHMENTS[GUNS[gun].base].some((a) => a === o)));
  }
  assert.ok(pickOptions(TIER_1, 'specter').length === 4 && !pickOptions(TIER_1, 'specter').includes('silencer'));
  assert.ok(!pickOptions(TIER_1, 'slugGun').includes('choke'));
});

test('evolving into a gun an attachment does nothing for hands the attachment pick back, with the new gun\'s menu', () => {
  const w = emptyWorld();
  const p = spawnAt(w, 500, 500, { loadout: { weapon: 'smg' } });
  p.level = 4;
  assert.ok(choosePick(w, p.id, 2, 'skirmisher'));
  assert.ok(choosePick(w, p.id, 1, 'silencer'));
  assert.equal(p.perks[1], 'silencer', 'the Skirmisher still uses its silencer');
  offerPerks(p, 'shield');
  for (const [level, option] of [[3, 'shield'], [4, 'dash']] as const) assert.ok(choosePick(w, p.id, level, option));
  p.level = 5;
  assert.ok(choosePick(w, p.id, 5, 'phantom'));
  assert.equal(p.perks[1], undefined, 'the Phantom is silenced already');
  assert.deepEqual(pendingPick(p), { level: 1, k: 'perk', tier: 1 });
  assert.ok(choosePick(w, p.id, 1, 'grip'));
  assert.equal(p.perks[1], 'grip');
  assert.equal(p.perks[2], 'shield', 'the other picks stay');
});

test('Choke tightens a shotgun\'s pellets by a quarter and is never offered on a slug, nor Extended mag on a one-shell gun', () => {
  assert.ok(Math.abs(spreadFor('shotgun', { 1: 'choke' }, true) - 0.75 * GUNS.shotgun.spread) < 1e-12);
  assert.equal(spreadFor('slugGun', { 1: 'choke' }, true), GUNS.slugGun.spread);
  assert.ok(!pickOptions(TIER_1, 'slugGun').includes('choke'));
  assert.ok(!pickOptions(TIER_1, 'sawedOff').includes('extended'));
  assert.ok(pickOptions(TIER_1, 'doubleBarrel').includes('extended'));
});

test('Quick reload finishes a reload 35% sooner, and the reload bar runs at its pace', () => {
  const reloadTicks = (quick: boolean) => {
    const { w, p } = shooter('shotgun');
    if (quick) grantPerks(w, p, ['quickReload']);
    if (p.life.k === 'alive') p.life.ammo = 0;
    tick(w, p, {});
    const half = (GUNS.shotgun.reloadMs * (quick ? 0.65 : 1)) / 2;
    run(w, half);
    const frac = snapshotFor(w, p.id).self.reloadFrac;
    let n = Math.round(half / TICK_MS);
    while (p.life.k === 'alive' && p.life.reloadUntil !== null) { tick(w, p, {}); n++; }
    return { ms: n * TICK_MS, frac };
  };
  const plain = reloadTicks(false), quick = reloadTicks(true);
  assert.ok(Math.abs(quick.ms - 0.65 * plain.ms) < 3 * TICK_MS, `quick ${quick.ms}ms vs ${plain.ms}ms`);
  assert.ok(Math.abs(quick.frac - 0.5) < 0.05, `reload bar at ${quick.frac} halfway through`);
});

test('Bipod is gone as a perk: no menu offers it, and standing still tightens an assault rifle and an LMG but not a pistol or an SMG', () => {
  assert.ok(!PICK_OPTIONS.includes('bipod' as PickOption));
  for (const weapon of ['assault', 'lmg'] as const) assert.ok(spreadFor(weapon, {}, true) < spreadFor(weapon, {}, false));
  for (const weapon of ['pistol', 'smg'] as const) assert.equal(spreadFor(weapon, {}, true), spreadFor(weapon, {}, false));
});

test('no gun is ever a laser: each has a spread floor, wider for a short barrel or a big round, a bipod and a planted sniper small, an LMG never tight standing', () => {
  const deg = (rad: number) => (rad * 180) / Math.PI;
  const floor = (gun: GunId, deployed = false) => minSpreadOf(GUNS[gun], deployed);
  for (const [a, b] of [['assault', 'smg'], ['smg', 'pistol']] as const) assert.ok(floor(a) < floor(b), `${a}'s longer barrel holds tighter than ${b}`);
  assert.ok(floor('handCannon') > floor('machinePistol'), 'a bigger round from the same length of barrel groups wider');
  for (const gun of ['sniper', 'longshot', 'piercer', 'artillery', 'semiAuto', 'repeater', 'ghost'] as const) assert.ok(deg(floor(gun)) >= 0.35 && deg(floor(gun)) <= 0.65, `${gun} floor ${deg(floor(gun)).toFixed(2)} deg`);
  for (const gun of ['lmg', 'heavyLmg'] as const) assert.ok(deg(spreadFor(gun, { 1: 'grip' }, true)) >= 1.5, `a ${gun} standing never holds tighter than ~1.5 degrees, gripped or not`);
  assert.ok(deg(floor('heavyLmg', true)) >= 0.6 && deg(floor('heavyLmg', true)) <= 0.8, 'a set-down bipod gets its own small floor');
  // However planted, steady, unsuppressed and perked (a grip narrows spread), nothing fires under its floor.
  for (const gun of GUN_IDS) {
    for (const deployed of [false, true]) {
      const s = spreadFor(gun, { 1: 'grip' }, true, 0, 0, 0, deployed);
      assert.ok(s >= floor(gun, deployed && rulesOf(GUNS[gun]).deploy !== null) - 1e-12, `${gun}${deployed ? ' deployed' : ''} ${s} under its floor`);
    }
  }
});

test('every gun blooms; standing it blooms less than on the move, and a set-down bipod least', () => {
  for (const gun of GUN_IDS) {
    const r = rulesOf(GUNS[gun]);
    assert.ok(r.bloom, `${gun} blooms`);
    const grow = (still: boolean, deployed = false) => spreadFor(gun, {}, still, 60, 0, 0, deployed) - spreadFor(gun, {}, still, 0, 0, 0, deployed);
    assert.ok(grow(true) > 0 && grow(true) < grow(false), `${gun}: standing ${grow(true)} vs moving ${grow(false)}`);
    if (r.deploy) assert.ok(grow(true, true) < grow(true), `${gun}: a bipod blooms least`);
  }
});

test('a sniper\'s follow-up is wild and a re-settled shot precise: each round blooms the cone even planted, and it takes seconds to close again', () => {
  for (const gun of ['sniper', 'semiAuto', 'repeater'] as const) {
    // A person's gun (a bot's settles the same, see bot-bloom.test.ts).
    const { w, p } = shooter(gun, 'FFA', 'human');
    run(w, 600);
    const sprayNow = () => (p.life.k === 'alive' ? p.life.spray : 0);
    const at = (ms: number) => { for (let i = 0; i < Math.round(ms / TICK_MS); i++) tick(w, p, {}); return spreadFor(gun, {}, true, sprayNow() + 1); };
    // As many rounds as fly clean, each as soon as the gun allows; the next is the one the bloom catches.
    let quick = 0;
    for (let i = 0; i < rulesOf(GUNS[gun]).bloom!.free; i++) { tick(w, p, { fire: true, shots: p.input.shots + 1 }); quick = at(GUNS[gun].fireMs - TICK_MS); }
    assert.ok(quick > 1.5 * minSpreadOf(GUNS[gun]), `${gun}: the fastest follow-up (${quick.toFixed(4)}) is well past the floor`);
    const patient = at(2600);
    assert.equal(patient, minSpreadOf(GUNS[gun]), `${gun}: a patient shot is back on the floor`);
  }
  // A bolt-action's bloom outlasts its bolt cycle; a semi-auto's kick is smaller and settles sooner.
  const b = rulesOf(GUNS.sniper).bloom!, s = rulesOf(GUNS.semiAuto).bloom!;
  assert.ok(b.perShot > s.perShot && b.settleMs + b.recoverMs > s.settleMs + s.recoverMs);
});

test('sniper one-shots by armor: the bolt-action drops only the unarmored, Longshot light, Piercer medium, nothing heavy without Demolitions on Artillery', () => {
  const HP = WORLD.baseHp;
  const direct = (gun: GunId, demo = false) => GUNS[gun].damage + (GUNS[gun].blast ? GUNS[gun].blast!.damage * (demo ? 1.3 : 1) : 0);
  const oneShot = (gun: GunId, armor: keyof typeof ARMORS, demo = false) => direct(gun, demo) * (1 - ARMORS[armor].blockFrac) >= HP;
  const matrix: Record<string, readonly boolean[]> = {
    sniper: [true, false, false, false], longshot: [true, true, false, false], piercer: [true, true, true, false], artillery: [true, true, false, false],
    semiAuto: [false, false, false, false], repeater: [false, false, false, false], ghost: [false, false, false, false],
  };
  for (const [gun, row] of Object.entries(matrix)) assert.deepEqual(ARMOR_IDS.map((a) => oneShot(gun as GunId, a)), row, gun);
  assert.equal(oneShot('artillery', 'heavy', true), true, 'Artillery with Demolitions is the one heavy-armor one-shot');
  for (const gun of ['sniper', 'longshot', 'piercer'] as const) assert.equal(direct(gun) * (1 - ARMORS.heavy.blockFrac) * 2 >= HP, true, `${gun} drops heavy armor in two`);
});
