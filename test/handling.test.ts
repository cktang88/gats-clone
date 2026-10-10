/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARMOR_IDS, ARMORS, GUN_IDS, GUNS, handlingOfGun, LOAD_SPEED_FLOOR, roundsPerSec, rulesOf, settleRulesOf, SPRINT, WEAPON_IDS, WORLD, type GunId } from '../src/shared/defs.ts';
import { CALIBRES, HANDLING, handlingOf, loadOf, sprintShareOf, walkMulOf, type Build } from '../src/shared/handling.ts';
import { effectiveStats, spreadFor } from '../src/shared/sim/stats.ts';
import { emptyWorld, spawnAt } from './helpers.ts';

const REF: Build = { kg: 3.6, cm: 90, calibre: '5.56mm', spread: 0.035, rps: 9, pinpoint: false, bolt: false };

test('the formulas move the right way: heavier and longer settle slower, sway more and kick less; bigger rounds kick harder', () => {
  const at = (b: Partial<Build>) => handlingOf({ ...REF, ...b });
  for (const [lo, hi] of [[2, 3], [3.6, 5], [6, 12]] as const) {
    const a = at({ kg: lo }), b = at({ kg: hi });
    assert.ok(b.settleMs >= a.settleMs && b.swingMs >= a.swingMs, `${lo} -> ${hi} kg settles and swings slower`);
    assert.ok(b.kick < a.kick && b.cap < a.cap, `${lo} -> ${hi} kg soaks more of the kick`);
    assert.ok(b.sway >= a.sway && b.recoverMs > a.recoverMs && b.still <= a.still, `${lo} -> ${hi} kg sways more and comes back slower`);
  }
  for (const [lo, hi] of [[40, 70], [90, 120]] as const) {
    const a = at({ cm: lo }), b = at({ cm: hi });
    assert.ok(b.settleMs >= a.settleMs && b.sway >= a.sway, `${lo} -> ${hi} cm settles slower and sways more`);
    assert.ok(b.kick < a.kick && b.floor < a.floor, `${lo} -> ${hi} cm is steadier and groups tighter`);
  }
  const rounds = (['9mm', '5.56mm', '7.62x51', '.338'] as const).map((calibre) => at({ calibre }));
  for (let i = 1; i < rounds.length; i++) {
    assert.ok(rounds[i]!.kick > rounds[i - 1]!.kick && rounds[i]!.cap > rounds[i - 1]!.cap, 'a bigger round kicks harder and blooms wider');
    assert.ok(rounds[i]!.floor > rounds[i - 1]!.floor, 'and groups a hair worse');
  }
  assert.ok(at({ pinpoint: true }).kick > 5 * at({}).kick && at({ pinpoint: true, bolt: true }).kick > at({ pinpoint: true }).kick, 'a scope, and a bolt, lose the sight picture');
  for (let load = 0; load < 30; load += 0.5) {
    assert.ok(walkMulOf(load + 0.5) <= walkMulOf(load) && sprintShareOf(load + 0.5) <= sprintShareOf(load), `more load, slower (${load} kg)`);
  }
});

test('bloom growth starts at the first round\'s kick (shape x kick) times the rate of fire, for every gun', () => {
  for (const id of GUN_IDS) {
    const g = GUNS[id], h = handlingOfGun(g);
    assert.ok(Math.abs(h.growthPerSec - h.shape * h.kick * roundsPerSec(g)) < 1e-12, id);
    assert.ok(Math.abs(h.rounds - h.cap / h.kick) < 1e-12 && Math.abs(h.firstKick - h.shape * h.kick) < 1e-12, id);
    assert.ok(h.shape >= HANDLING.shape.min && h.shape <= HANDLING.shape.max, `${id}: shape ${h.shape}`);
    const b = rulesOf(g).bloom!;
    assert.ok(Math.abs(b.perShot * g.spread - h.kick) < 1e-4 * Math.max(1, h.kick / g.spread), `${id}: the sim's per-shot bloom is the kick`);
    assert.ok(Math.abs((b.maxMul - 1) * g.spread - h.cap) < 1e-4 * Math.max(1, h.cap / g.spread), `${id}: the sim's cap is the cap`);
    assert.ok(Math.abs(h.decayPerSec - h.cap / (h.recoverMs / 1000)) < 1e-9, `${id}: decay is the cap over the recovery`);
  }
});

test('every gun\'s handling stays within sane bounds, and comes from a real build', () => {
  for (const id of GUN_IDS) {
    const g = GUNS[id], h = handlingOfGun(g), r = rulesOf(g);
    assert.ok(g.kg >= 0.5 && g.kg <= 20 && g.cm >= 15 && g.cm <= 150 && CALIBRES[g.calibre], `${id}: a real build`);
    assert.ok(h.floor >= 0.004 && h.floor <= 0.025, `${id}: floor ${h.floor}`);
    assert.ok(h.sway >= 0 && h.sway <= 0.16, `${id}: sway ${h.sway}`);
    assert.ok(h.kick > 0 && h.kick <= 0.3 && h.cap > 0 && h.cap <= 0.2, `${id}: kick ${h.kick}, cap ${h.cap}`);
    assert.ok(h.recoverMs >= 15 && h.recoverMs <= 5000, `${id}: recovers in ${h.recoverMs} ms`);
    assert.ok(h.still >= HANDLING.still.min * HANDLING.SCOPE.still - 0.01 && h.still <= HANDLING.still.max, `${id}: still ${h.still}`);
    assert.ok(h.settleMs >= 300 && h.settleMs <= 2500 && h.swingMs >= 150 && h.swingMs <= 300, `${id}: settles in ${h.settleMs}, swings in ${h.swingMs}`);
    assert.equal(settleRulesOf(g).ms, h.settleMs);
    assert.equal(r.movingSpreadAdd, h.sway);
    assert.equal(r.minSpread, h.floor);
  }
});

test('every loadout walks above the floor and sprints faster than it walks; more armor is always slower', () => {
  for (const id of GUN_IDS) {
    let walk = Infinity, sprint = Infinity;
    for (const armor of ARMOR_IDS) {
      const w = emptyWorld();
      const p = spawnAt(w, 500, 500, { loadout: { weapon: GUNS[id].base, armor } });
      p.gun = id;
      const s = effectiveStats(p);
      assert.ok(s.speed >= WORLD.baseSpeed * LOAD_SPEED_FLOOR - 1e-9, `${id} in ${armor}: never crawls`);
      assert.ok(s.sprintSpeed > s.speed, `${id} in ${armor}: a sprint is always some faster`);
      assert.ok(s.speed <= walk && s.sprintSpeed <= sprint, `${id} in ${armor}: heavier armor, no faster`);
      walk = s.speed; sprint = s.sprintSpeed;
    }
  }
  assert.ok(ARMOR_IDS.every((a, i) => i === 0 || ARMORS[a].kg > ARMORS[ARMOR_IDS[i - 1]!].kg));
});

test('the roles survive the physics: the pistol and SMG are fastest off a sprint and on foot, the LMG slowest, the bipod tightest, the planted sniper sure', () => {
  const settle = (id: GunId) => settleRulesOf(GUNS[id]).ms;
  for (const light of ['pistol', 'smg'] as const) for (const heavy of ['shotgun', 'assault', 'sniper', 'lmg'] as const) {
    assert.ok(settle(light) * 2.5 < settle(heavy), `${light} settles off a sprint far faster than ${heavy}`);
    assert.ok(GUNS[light].moveMul > GUNS[heavy].moveMul, `${light} walks faster than ${heavy}`);
  }
  for (const id of ['skirmisher', 'gunslinger', 'machinePistol'] as const) assert.ok(settle(id) <= settle('smg'), `${id} is quickest of all off a sprint`);
  for (const c of WEAPON_IDS) if (c !== 'lmg') assert.ok(GUNS.lmg.moveMul < GUNS[c].moveMul, `the LMG is the slowest class (vs ${c})`);
  const share = (id: GunId) => sprintShareOf(loadOf(GUNS[id].kg, GUNS[id].cm, 0));
  assert.ok(share('minigun') <= 0.2 && share('juggernaut') < share('lmg'), 'the heaviest guns can barely sprint')
  assert.ok(share('skirmisher') > share('smg') && share('smg') > share('assault') && share('assault') > share('lmg'), 'a light load sprints hardest');
  const deployed = spreadFor('heavyLmg', {}, true, 0, 0, 0, true);
  for (const id of ['lmg', 'lightMg', 'ranger', 'twinMg'] as const) assert.ok(deployed < spreadFor(id, {}, true), `a set-down bipod is tighter than a ${id}`);
  assert.ok(spreadFor('lmg', {}, false) > 1.5 * spreadFor('lmg', {}, true), 'an LMG on the walk is sloppy');
  for (const id of ['sniper', 'longshot', 'piercer'] as const) assert.ok(spreadFor(id, {}, true) < Math.atan(WORLD.playerRadius / 1000), `a planted ${id} is sure at 1000 px`);
  assert.ok(handlingOfGun(GUNS.sniper).kick > 20 * handlingOfGun(GUNS.assault).kick, 'a bolt-action\'s big kick falls out of its round, its scope and its bolt');
  assert.equal(SPRINT.settleMul, HANDLING.sprintBloom);
});
