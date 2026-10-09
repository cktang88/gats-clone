import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVOLUTIONS, GUN_IDS, GUNS, rulesOf, settleRulesOf, SPRINT, WEAPON_IDS, WORLD, type GunId, type WeaponId } from '../src/shared/defs.ts';
import type { MapDoor } from '../src/shared/geom.ts';
import { MAPS, type MapDef } from '../src/shared/maps.ts';
import { CLASS_ROLES, GUN_ROLES, TRAIT_IDS, TRAITS } from '../src/shared/roles.ts';
import { easedSpread, falloffMul, isDeployed, isSteady, spreadFor } from '../src/shared/sim/stats.ts';
import { bulletShove } from '../src/shared/sim/knock.ts';
import { createWorld, type World } from '../src/shared/sim/world.ts';
import { bandFor, GUN_BAND, PERSONALITIES } from '../src/server/bot/intent.ts';
import { gunWeight } from '../src/server/bots.ts';
import { tapRhythm } from '../src/server/bot/motor.ts';
import { TRAIT_ICONS } from '../src/client/icons.ts';
import { duel } from '../scripts/lib/duel.ts';
import { dpsAt, ttkMs } from '../scripts/lib/gunscore.ts';
import { emptyWorld, equip, hpOf, press, run, shootOnce, spawnAt, TICK_MS } from './helpers.ts';

/** How long a gun's post-sprint bloom takes to ease out. */
const settleMsOf = (id: GunId): number => settleRulesOf(GUNS[id]).ms;

/** The ways a gun plays that no stat sheet shows: what it does with the trigger, the body, the round and the map. */
function mechanics(id: GunId): Set<string> {
  const g = GUNS[id], r = rulesOf(g);
  const m = new Set<string>();
  m.add(g.burst ? `burst${g.burst.count}` : g.auto ? 'auto' : 'semi');
  if (g.pellets > 1) m.add('pellets');
  if (g.penetrate) m.add('pierce');
  if (g.blast) m.add('blast');
  if (g.silenced) m.add('quiet');
  if (r.falloff && r.falloff.startPx < 350) m.add('closeFade');
  if (r.deploy) m.add('deploy');
  if (r.spinUp) m.add('rev');
  if (r.bloom) m.add('bloom');
  if (r.movingSpreadMul <= 1 && r.movingSpreadAdd === 0) m.add('movesFree');
  if (r.movingSpreadMul >= 1.5 || r.movingSpreadAdd > 0.04) m.add('movesLoose');
  if (r.steadyMs > 0) m.add('plants');
  if (r.viewMul > 1.03) m.add('scope');
  if (r.shoveMul >= 2) m.add('shove');
  if (r.breach) m.add('breach');
  if (r.suppress >= 0.1 && r.suppress < 0.3) m.add('pins');
  if (settleMsOf(id) <= 800) m.add('quickDraw');
  if (settleMsOf(id) >= 2200) m.add('slowDraw');
  if (g.moveMul >= 1.08) m.add('fast');
  if (g.moveMul <= 0.82) m.add('slow');
  if (r.sprintMul < 0.5) m.add('noSprint');
  if (g.mag >= 45) m.add('deepMag');
  if (r.viewMul >= 1.35) m.add('farScope');
  if (g.bulletSpeed <= 1500 && g.range >= 900) m.add('slowRound');
  if (g.damage >= 30 && g.pellets === 1) m.add('heavyRound');
  if (g.mag <= 2) m.add('twoShells');
  if (!g.auto && !g.burst && g.fireMs <= 300) m.add('quickCycle');
  return m;
}

const differing = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).length + [...b].filter((x) => !a.has(x)).length;

test('every gun states its role in a line and two or three real traits, and every class has a one-line job', () => {
  for (const id of GUN_IDS) {
    const { role, traits } = GUN_ROLES[id];
    assert.ok(role.length >= 12 && role.length <= 60, `${id}: role "${role}" is ${role.length} chars`);
    assert.ok(traits.length >= 2 && traits.length <= 3, `${id}: ${traits.length} traits`);
    assert.equal(new Set(traits).size, traits.length, `${id}: repeated trait`);
    for (const t of traits) assert.ok(TRAIT_IDS.includes(t), `${id}: unknown trait ${t}`);
  }
  for (const t of TRAIT_IDS) assert.ok(TRAITS[t].label.length <= 14 && TRAITS[t].hint.length > 8, t);
  assert.deepEqual(Object.keys(TRAIT_ICONS).sort(), [...TRAIT_IDS].sort(), 'every trait has an icon for the evolve tile, and no icon is orphaned');
  assert.equal(new Set(Object.values(TRAIT_ICONS)).size, TRAIT_IDS.length, 'no two traits share an icon');
  for (const weapon of WEAPON_IDS) assert.ok(CLASS_ROLES[weapon].length > 20, weapon);
});

test('the traits a gun advertises are true of its numbers', () => {
  const claims: Partial<Record<(typeof TRAIT_IDS)[number], (id: GunId) => boolean>> = {
    quiet: (id) => GUNS[id].silenced === true,
    pierce: (id) => (GUNS[id].penetrate ?? 0) > 0,
    blast: (id) => GUNS[id].blast !== undefined,
    burst: (id) => GUNS[id].burst !== undefined || GUNS[id].pellets > 1 || GUNS[id].mag <= 2,
    auto: (id) => GUNS[id].auto || GUNS[id].fireMs <= 90,
    rev: (id) => rulesOf(GUNS[id]).spinUp !== null,
    deploy: (id) => rulesOf(GUNS[id]).deploy !== null,
    breach: (id) => rulesOf(GUNS[id]).breach || GUNS[id].blast !== undefined,
    shove: (id) => rulesOf(GUNS[id]).shoveMul > 1,
    quickdraw: (id) => settleMsOf(id) <= 800 || settleMsOf(id) <= 0.8 * settleMsOf(GUNS[id].base),
    scope: (id) => rulesOf(GUNS[id]).viewMul > 1,
    plant: (id) => rulesOf(GUNS[id]).steadyMs > 0 || rulesOf(GUNS[id]).movingSpreadMul >= 1.2 || rulesOf(GUNS[id]).movingSpreadAdd > 0,
    strafe: (id) => rulesOf(GUNS[id]).movingSpreadMul <= 1 && rulesOf(GUNS[id]).movingSpreadAdd <= 0.05,
    heavy: (id) => GUNS[id].damage >= 30 || GUNS[id].damage * GUNS[id].pellets >= 100 || (GUNS[id].burst !== undefined && GUNS[id].damage * GUNS[id].burst.count >= 90),
    close: (id) => rulesOf(GUNS[id]).falloff !== null || GUNS[id].range <= 440,
    fast: (id) => GUNS[id].moveMul >= 1,
    slow: (id) => GUNS[id].moveMul <= 0.93 || settleMsOf(id) >= 2200,
    deep: (id) => GUNS[id].mag >= 40 || GUNS[id].pellets > 1 || GUNS[id].mag >= 24,
    reach: (id) => GUNS[id].range >= 800,
    pin: (id) => rulesOf(GUNS[id]).suppress >= 0.09,
  };
  for (const id of GUN_IDS) for (const t of GUN_ROLES[id].traits) {
    const check = claims[t];
    if (check) assert.ok(check(id), `${GUNS[id].name} claims "${t}" but its numbers do not show it`);
  }
});

test('an evolution is not just more stats: it differs from its parent, and the two choices at each step differ from each other, in how they play', () => {
  for (const parent of GUN_IDS) {
    const kids = EVOLUTIONS[parent];
    const up = mechanics(parent);
    for (const kid of kids) assert.ok(differing(up, mechanics(kid)) >= 1, `${GUNS[kid].name} plays like its parent ${GUNS[parent].name}`);
    if (kids.length === 2) {
      const [a, b] = kids as [GunId, GunId];
      const gap = differing(mechanics(a), mechanics(b));
      assert.ok(gap >= 3, `${GUNS[a].name} and ${GUNS[b].name} differ in only ${gap} ways of playing: ${[...mechanics(a)].join(',')} vs ${[...mechanics(b)].join(',')}`);
      const ta = new Set(GUN_ROLES[a].traits), tb = new Set(GUN_ROLES[b].traits);
      assert.ok([...ta].filter((t) => tb.has(t)).length <= 1, `${GUNS[a].name} and ${GUNS[b].name} advertise the same traits`);
    }
  }
});

test('stage-2 siblings of one class are also unlike each other across the class, so no two ends of a tree are the same job', () => {
  for (const base of WEAPON_IDS) {
    const leaves = GUN_IDS.filter((id) => GUNS[id].base === base && GUNS[id].stage === 2);
    for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
      const gap = differing(mechanics(leaves[i]!), mechanics(leaves[j]!));
      assert.ok(gap >= 2, `${GUNS[leaves[i]!].name} and ${GUNS[leaves[j]!].name} differ in only ${gap}`);
    }
  }
});

test('SMG rushes: no accuracy lost on the move, quick off a sprint, and rounds that fade hard past 350 px', () => {
  assert.equal(spreadFor('smg', {}, false), spreadFor('smg', {}, true));
  assert.ok(settleMsOf('smg') <= 650 && settleMsOf('smg') * 3 <= settleMsOf('assault') && settleMsOf('smg') < SPRINT.settleMs * 0.35);
  assert.equal(falloffMul('smg', 100), 1);
  assert.ok(falloffMul('smg', 350) < 0.55 && falloffMul('smg', 600) <= 0.3 + 1e-9, 'a third of its punch by 350 px, the floor past it');
  assert.ok(dpsAt('smg', 150, false) > dpsAt('assault', 150, false), 'the SMG out-damages the assault rifle up close');
  assert.ok(dpsAt('assault', 600, true) > 4 * dpsAt('smg', 600, true), 'the assault rifle out-damages the SMG far out by a wide margin');
  assert.ok(ttkMs('smg', 100, 'none', false)! < ttkMs('assault', 100, 'none', false)!);
  assert.equal(ttkMs('smg', 700, 'none', true), null, 'the SMG cannot finish a fight at 700 px');
});

test('assault anchors: tight when it stands and taps, loose when it runs or sprays, and slow to settle off a sprint', () => {
  assert.ok(spreadFor('assault', {}, false) >= 1.6 * spreadFor('assault', {}, true), 'running costs most of its accuracy');
  assert.ok(spreadFor('assault', {}, false, 20) > 2 * spreadFor('assault', {}, false, 3), 'a long spray widens');
  assert.ok(spreadFor('assault', {}, true, 20) > 1.5 * spreadFor('assault', {}, true, 3), 'standing too, if less');
  assert.ok(spreadFor('assault', {}, true) < spreadFor('smg', {}, true) / 2, 'standing, it is far tighter than an SMG');
  assert.equal(isSteady('assault', 50), false);
  assert.equal(isSteady('assault', 150), true);
  assert.ok(settleMsOf('assault') >= 1800);
  assert.ok(GUNS.assault.moveMul < GUNS.smg.moveMul);
  for (const id of ['assault', 'battleRifle', 'carbine'] as const) assert.ok(tapRhythm(id, false), `${id} bots tap`);
  assert.equal(tapRhythm('smg', true), null, 'rushers hose');
  assert.equal(tapRhythm('lmg', false), null, 'machine guns hose');
});

test('shotgun breaks doors: close blasts, a shove, and pellets that blow a swing door open', () => {
  assert.ok(falloffMul('shotgun', 100) === 1 && falloffMul('shotgun', 500) <= 0.3 + 1e-9);
  assert.ok(rulesOf(GUNS.shotgun).breach && rulesOf(GUNS.sawedOff).breach);
  assert.ok(bulletShove('shotgun', 17) > bulletShove('assault', 17) * 2, 'a pellet shoves harder than an assault round of the same damage');
  const door: MapDoor = { id: 'breach-test', kind: 'swing', x: 1000, y: 1000, w: 100, axis: 'h', material: 'wood' };
  const was = MAPS['geo-test'];
  (MAPS as Record<string, MapDef>)['geo-test'] = { ...was, doors: [door] };
  try {
    for (const [gun, opens] of [['shotgun', true], ['assault', false], ['boomSlug', true]] as const) {
      const w: World = createWorld('FFA', 1, 'geo-test');
      w.walls = w.walls.filter((x) => x.door !== undefined);
      w.crates = []; w.barrels = []; w.props = [];
      const p = spawnAt(w, 1050, 1120, { loadout: { weapon: GUNS[gun].base } });
      equip(p, gun);
      assert.equal(w.doors[0]!.open, 0);
      shootOnce(w, p, -Math.PI / 2, 600);
      assert.equal(w.doors[0]!.open > 0, opens, `${gun} ${opens ? 'blows the door open' : 'leaves it shut'} (${w.doors[0]!.open})`);
    }
  } finally { (MAPS as Record<string, MapDef>)['geo-test'] = was; }
});

test('pistol is the quick sidearm: handles fast, no worse on the move; the Hand Cannon trades rate for a shove', () => {
  assert.equal(spreadFor('pistol', {}, false), spreadFor('pistol', {}, true));
  assert.ok(settleMsOf('pistol') <= 550);
  assert.ok(bulletShove('handCannon', GUNS.handCannon.damage) > 2.5 * bulletShove('pistol', GUNS.pistol.damage));
  assert.ok(bulletShove('executioner', GUNS.executioner.damage) >= bulletShove('handCannon', GUNS.handCannon.damage));
  assert.ok(GUNS.handCannon.fireMs > 2 * GUNS.pistol.fireMs);
});

test('sniper stays the long pick: one shot on the unarmored, planted before it is accurate, slow to settle off a sprint; the Ghost plants faster than the Longshot', () => {
  assert.ok(GUNS.sniper.damage >= WORLD.baseHp && settleMsOf('sniper') >= 2200);
  assert.ok(ttkMs('sniper', 900, 'none', true)! === 0, 'one shot on the unarmored at 900 px');
  assert.ok(rulesOf(GUNS.ghost).steadyMs < rulesOf(GUNS.longshot).steadyMs);
  assert.ok(rulesOf(GUNS.repeater).steadyMs < rulesOf(GUNS.semiAuto).steadyMs);
  assert.ok(ttkMs('sniper', 900, 'heavy', true)! > 0, 'but not through armor: that takes a Longshot, a Piercer or a second round');
});

test('LMG suppresses: rev-up, a bipod that plants the gun, the heaviest pinning, and heavy feet; the Minigun cannot sprint', () => {
  const lmg = rulesOf(GUNS.lmg);
  assert.ok(lmg.spinUp && lmg.suppress >= 0.14 && settleMsOf('lmg') >= 2200);
  assert.equal(lmg.deploy, null, 'the belt-fed LMG revs but has no bipod; the Heavy LMG brings it');
  assert.equal(isDeployed('heavyLmg', 400), false);
  assert.equal(isDeployed('heavyLmg', 500), true);
  assert.equal(isDeployed('smg', 5000), false, 'only guns with a bipod plant');
  assert.ok(spreadFor('heavyLmg', {}, true, 0, 0, 0, true) <= 0.35 * spreadFor('heavyLmg', {}, true, 0, 0, 0, false) + 1e-12, 'planted, the spread falls to a third');
  assert.equal(spreadFor('heavyLmg', {}, false, 0, 0, 0, true), spreadFor('heavyLmg', {}, false), 'a walking LMG gets no bipod');
  assert.equal(rulesOf(GUNS.lightMg).spinUp, null);
  assert.equal(rulesOf(GUNS.lightMg).deploy, null);
  assert.ok(rulesOf(GUNS.minigun).spinUp!.upMs > rulesOf(GUNS.lmg).spinUp!.upMs, 'the Minigun takes longer to rev');
  const pins = Math.max(...WEAPON_IDS.filter((c) => c !== 'sniper').map((c) => rulesOf(GUNS[c]).suppress));
  assert.equal(rulesOf(GUNS.lmg).suppress, pins);
  const speed = (gun: GunId) => {
    const w = emptyWorld();
    const p = spawnAt(w, 500, 500, { loadout: { weapon: 'lmg' } });
    equip(p, gun);
    press(w, p, { right: true, sprint: true });
    run(w, 1000);
    const sprinted = p.x - 500;
    const q = spawnAt(w, 500, 1500, { loadout: { weapon: 'lmg' } });
    equip(q, gun);
    press(w, q, { right: true });
    run(w, 1000);
    return sprinted / (q.x - 500);
  };
  assert.ok(speed('minigun') < 1.1, `a sprinting Minigun is barely faster than walking (${speed('minigun').toFixed(2)}x)`);
  assert.ok(speed('lightMg') > 1.3, 'a Light MG sprints as well as anyone');
});

test('quick off a sprint: everyone fires at once, but the SMG\'s cone is tight again long before the assault rifle\'s', () => {
  /** How long after a sprint ends the gun's eased spread is back within 10% of its standing spread. */
  const settled = (gun: GunId) => {
    const w = emptyWorld();
    const p = spawnAt(w, 500, 500, { loadout: { weapon: GUNS[gun].base } });
    equip(p, gun);
    press(w, p, { right: true, sprint: true });
    run(w, 400);
    const at = w.now;
    press(w, p, {});
    const rest = spreadFor(gun, {}, true);
    for (let t = 0; t < 4000; t += TICK_MS) {
      step1(w);
      if (p.life.k === 'alive' && easedSpread(p.life.spreadHist) <= rest * 1.1) return w.now - at;
    }
    return Infinity;
  };
  const smg = settled('smg'), assault = settled('assault'), pistol = settled('pistol');
  assert.ok(pistol <= 700 && smg <= 800, `pistol ${pistol}, smg ${smg}`);
  assert.ok(assault >= 1400, `assault ${assault}`);
  assert.ok(smg * 2 < assault);
});

function step1(w: World) { run(w, TICK_MS); }

test('damage fades with the distance a round has flown, and only for guns that have a fade', () => {
  for (const id of GUN_IDS) {
    const f = rulesOf(GUNS[id]).falloff;
    assert.equal(falloffMul(id, 0), 1);
    if (!f) { assert.equal(falloffMul(id, 5000), 1, id); continue; }
    assert.ok(f.endPx > f.startPx && f.minMul > 0 && f.minMul < 1, id);
    assert.equal(falloffMul(id, f.startPx), 1);
    assert.ok(Math.abs(falloffMul(id, f.endPx) - f.minMul) < 1e-9 && Math.abs(falloffMul(id, f.endPx * 2) - f.minMul) < 1e-9, id);
    assert.ok(falloffMul(id, (f.startPx + f.endPx) / 2) < 1 && falloffMul(id, (f.startPx + f.endPx) / 2) > f.minMul, id);
  }
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500, { loadout: { weapon: 'smg' } });
  const near = spawnAt(w, 560, 500), far = spawnAt(w, 500 + 24 + 4 + 380, 700);
  // A single round fired straight at each: the far one has lost most of its punch.
  const fire = (target: { x: number; y: number }) => {
    const b = { id: 9000 + w.nextId++, owner: a.id, team: a.team, x: a.x, y: a.y, vx: Math.cos(Math.atan2(target.y - a.y, target.x - a.x)) * GUNS.smg.bulletSpeed, vy: Math.sin(Math.atan2(target.y - a.y, target.x - a.x)) * GUNS.smg.bulletSpeed, left: 520, damage: GUNS.smg.damage, piercing: false, label: 'SMG', gun: 'smg' as const, turret: null, lobbed: false, penetrate: 0, passed: [], blast: null, volley: 1 };
    w.bullets.push(b);
  };
  fire(near); fire(far);
  run(w, 800);
  const lostNear = WORLD.baseHp - hpOf(near), lostFar = WORLD.baseHp - hpOf(far);
  assert.ok(Math.abs(lostNear - GUNS.smg.damage) < 1e-6, `point blank loses ${lostNear}`);
  assert.ok(lostFar > 0 && lostFar < GUNS.smg.damage * 0.6, `a round from 400 px away does ${lostFar}`);
});

test('every gun has a bot band that fits its job: ordered, inside its reach, rushers close and the rest hold', () => {
  const calm = PERSONALITIES.cautious;
  for (const id of GUN_IDS) {
    const [headOn, ideal, max, rush] = GUN_BAND[id];
    const g = GUNS[id];
    assert.ok(headOn <= ideal && ideal <= max, `${id}: ${headOn}/${ideal}/${max} out of order`);
    assert.ok(max <= g.range, `${id}: a bot settles at ${max} but the gun reaches ${g.range}`);
    const f = rulesOf(g).falloff;
    if (f) assert.ok(ideal <= f.endPx * 0.6 + 120, `${id}: it settles at ${ideal} past where its rounds fade (${f.startPx}-${f.endPx})`);
    if (g.pellets >= 5) assert.equal(rush, 'rush', `${id}: a shotgun closes in`);
    assert.equal(bandFor(id, calm).rushes, rush === 'rush');
    assert.equal(bandFor(id, calm).hold === 0, rush === 'rush', `${id}: only rushers never back off`);
  }
  const ideal = (id: GunId) => GUN_BAND[id][1];
  assert.ok(ideal('smg') < ideal('pistol') && ideal('pistol') < ideal('assault') && ideal('assault') < ideal('sniper'), 'bands run SMG, pistol, assault, sniper from near to far');
  assert.ok(ideal('shotgun') < ideal('smg'), 'a shotgun fights closer than an SMG');
  assert.ok(ideal('slugGun') > ideal('doubleBarrel') * 2 && ideal('marksman') > ideal('carbine'), 'a mid-range evolution holds farther than its close-range sibling');
});

test('role edges hold in the numbers: each class leads somewhere and trails somewhere else', () => {
  const dps = (id: GunId, d: number) => dpsAt(id, d, true);
  const bases = WEAPON_IDS.filter((c) => c !== 'sniper');
  for (const d of [100, 150] as const) assert.equal(bases.map((c) => [c, dps(c, d)] as const).sort((x, y) => y[1] - x[1])[0]![0] === 'smg' || bases.map((c) => [c, dps(c, d)] as const).sort((x, y) => y[1] - x[1])[0]![0] === 'shotgun', true, `close range at ${d} px belongs to the SMG or shotgun`);
  assert.equal(ttkMs('shotgun', 80, 'none', false), 0, 'one blast at arm\'s length');
  assert.ok(ttkMs('assault', 80, 'none', false)! > 400 && ttkMs('smg', 80, 'none', false)! > 300, 'which no other class can match');
  assert.equal(ttkMs('shotgun', 450, 'none', true), null, 'a shotgun has nothing at 450 px');
  assert.ok(dps('heavyLmg', 600) > dps('pistol', 600), 'a bipod lane beats a pistol far out');
});

test('balance smoke: bot duels between the six class guns leave none dominant or hopeless, and the close-range classes win close and lose far', () => {
  const ranges = [200, 450, 750] as const;
  const ids = WEAPON_IDS;
  const score = new Map<string, { sum: number; n: number }>();
  const add = (gun: GunId, range: number, s: number) => {
    for (const key of [`${gun}`, `${gun}@${range}`]) { const t = score.get(key) ?? { sum: 0, n: 0 }; t.sum += s; t.n++; score.set(key, t); }
  };
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) for (const range of ranges) for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) for (const swap of [false, true]) {
    const r = duel({ a: ids[i]!, b: ids[j]!, range, seed, swap, armor: 'none' });
    add(ids[i]!, range, r.score);
    add(ids[j]!, range, 1 - r.score);
  }
  const share = (key: string) => score.get(key)!.sum / score.get(key)!.n;
  for (const id of ids) assert.ok(share(id) > 0.2 && share(id) < 0.8, `${id} wins ${(100 * share(id)).toFixed(0)}% of its duels`);
  for (const id of ['smg', 'shotgun'] as const) assert.ok(share(`${id}@200`) > share(`${id}@750`), `${id}: ${(100 * share(`${id}@200`)).toFixed(0)}% at 200 px vs ${(100 * share(`${id}@750`)).toFixed(0)}% at 750`);
  assert.ok(share('assault@750') > share('assault@200'), 'the assault rifle fights better far out than up close');
});

test('bots lean to evolutions that suit their temper: rushers for the aggressive, long guns for the marksman, lane holders for the careful', () => {
  assert.ok(gunWeight('machinePistol', 'aggressive') > gunWeight('handCannon', 'aggressive'));
  assert.ok(gunWeight('skirmisher', 'aggressive') > gunWeight('heavySmg', 'aggressive'));
  assert.ok(gunWeight('executioner', 'marksman') > gunWeight('gunslinger', 'marksman'));
  assert.ok(gunWeight('marksman', 'marksman') > gunWeight('grenadier', 'marksman') - 1e-9 && gunWeight('scout', 'marksman') > gunWeight('specter', 'marksman'));
  assert.ok(gunWeight('slugGun', 'cautious') > gunWeight('doubleBarrel', 'cautious'));
  for (const id of GUN_IDS) for (const p of ['aggressive', 'cautious', 'marksman'] as const) assert.ok(gunWeight(id, p) >= 1 && gunWeight(id, p) <= 2);
});
