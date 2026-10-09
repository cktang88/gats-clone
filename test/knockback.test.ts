import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARMORS, GUNS, KNOCK, type GunId } from '../src/shared/defs.ts';
import { step } from '../src/shared/sim.ts';
import { damagePlayer, explode } from '../src/shared/sim/combat.ts';
import { applyKnock, blastShove, bulletShove } from '../src/shared/sim/knock.ts';
import { decayKnock, moveStep } from '../src/shared/sim/movement.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { effectiveStats } from '../src/shared/sim/stats.ts';
import { makeSnapshotEncoder } from '../src/shared/wire.ts';
import { newId, type Player, type World } from '../src/shared/sim/world.ts';
import { emptyWorld, equip, press, setWalls, spawnAt, TICK_MS } from './helpers.ts';

const shoved = (p: Player) => (p.life.k === 'alive' ? p.life.knock : null);
const speedOf = (p: Player) => { const k = shoved(p); return k ? Math.hypot(k.vx, k.vy) : 0; };

/** Fires `gun` from (500, 500) along +x at a target 80px away and returns the target's shove the tick the round lands. */
function hitWith(gun: GunId, armor: 'none' | 'heavy' = 'none') {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500, { loadout: { weapon: GUNS[gun].base } });
  equip(a, gun);
  const b = spawnAt(w, 580, 500, { loadout: { armor }, kind: 'human' });
  // Thick Skin, so a point-blank blast lands as a shove rather than a kill (only a survivor is shoved).
  b.perks = { 2: 'thickSkin' };
  if (b.life.k === 'alive') b.life.hp = effectiveStats(b).maxHp;
  press(w, a, { angle: 0, fire: true, shots: a.input.shots + 1 });
  let peak = 0;
  for (let i = 0; i < 20; i++) { step(w, TICK_MS); peak = Math.max(peak, speedOf(b)); press(w, a, { angle: 0 }); }
  return { w, a, b, peak };
}

test('a round shoves its victim along the shot, by gun class: a pistol a little, a sniper hardest of any single round', () => {
  const pistol = hitWith('pistol'), sniper = hitWith('sniper'), smg = hitWith('smg');
  assert.ok(pistol.b.x > 580, 'pushed away from the shooter');
  assert.ok(Math.abs(pistol.b.y - 500) < 4, 'along the shot');
  assert.ok(Math.abs(pistol.peak - bulletShove('pistol', GUNS.pistol.damage)) < 1, `pistol ${pistol.peak}`);
  assert.ok(smg.peak < pistol.peak && pistol.peak < sniper.peak);
  assert.ok(Math.abs(sniper.peak - Math.min(KNOCK.cap, bulletShove('sniper', GUNS.sniper.damage))) < 1 && sniper.peak > KNOCK.cap * 0.75, `a sniper round shoves hard (${sniper.peak})`);
});

test('a point-blank shotgun stacks its pellets up to the cap and no further', () => {
  const { peak } = hitWith('shotgun');
  assert.ok(peak > 60 && peak <= KNOCK.cap + 1e-9, `${peak}`);
  assert.ok(bulletShove('shotgun', GUNS.shotgun.damage) * GUNS.shotgun.pellets > KNOCK.cap, 'eight pellets would exceed the cap uncapped');
});

test('every gun stays at or under the cap, and sprays of light rounds shove little', () => {
  for (const g of Object.keys(GUNS) as GunId[]) {
    assert.ok(Math.min(KNOCK.cap, bulletShove(g, GUNS[g].damage) * GUNS[g].pellets) <= KNOCK.cap);
    if (GUNS[g].damage <= 18 && GUNS[g].pellets === 1) assert.ok(bulletShove(g, GUNS[g].damage) <= 11, `${g} a round shoves ${bulletShove(g, GUNS[g].damage)} px/s`);
  }
  // A full-auto SMG for a second drifts its target by only a few px/s on average.
  const w = emptyWorld();
  const b = spawnAt(w, 600, 500);
  let max = 0;
  for (let i = 0; i < 30; i++) { applyKnock(w, b, 1, 0, bulletShove('smg', 14)); step(w, TICK_MS); max = Math.max(max, speedOf(b)); }
  assert.ok(max < 30, `sustained smg fire peaks at ${max} px/s`);
});

test('a shove bleeds off in a fraction of a second and is gone', () => {
  const w = emptyWorld();
  const b = spawnAt(w, 600, 500);
  applyKnock(w, b, 1, 0, 100);
  let ticks = 0;
  while (shoved(b) && ticks < 60) { step(w, TICK_MS); ticks++; }
  assert.equal(shoved(b), null);
  assert.ok(ticks * TICK_MS >= 150 && ticks * TICK_MS <= 450, `gone after ${ticks * TICK_MS}ms`);
  assert.ok(b.x > 600 && b.x < 640, `moved a few px (${b.x - 600})`);
  assert.equal(decayKnock({ vx: 3, vy: 0 }, TICK_MS), null, 'a crawl too slow to see is dropped');
});

test('a shove slides through the same collision as walking: nobody is pushed into a wall', () => {
  const w = emptyWorld();
  setWalls(w, [{ x: 640, y: 300, w: 40, h: 400 }]);
  const b = spawnAt(w, 600, 500);
  applyKnock(w, b, 1, 0, 120);
  for (let i = 0; i < 30; i++) step(w, TICK_MS);
  assert.ok(b.x <= 640 - 24 + 1e-6, `stopped by the wall (x=${b.x})`);
  const m = moveStep([{ x: 640, y: 300, w: 40, h: 400 }], { x: 610, y: 500, dash: null, knock: { vx: 500, vy: 0 } }, { up: false, down: false, left: false, right: false }, 200, 100, 3000);
  assert.ok(m.x <= 616 + 1e-6);
});

test('heavy armor resists a shove, and a shield-less spawn-protected player takes none', () => {
  const bare = hitWith('handCannon'), heavy = hitWith('handCannon', 'heavy');
  assert.ok(Math.abs(heavy.peak / bare.peak - KNOCK.armor.heavy) < 0.02, `${heavy.peak} vs ${bare.peak}`);
  assert.ok(KNOCK.armor.heavy < KNOCK.armor.medium && KNOCK.armor.medium < KNOCK.armor.light && KNOCK.armor.light < KNOCK.armor.none);
  assert.deepEqual(Object.keys(KNOCK.armor).sort(), Object.keys(ARMORS).sort());
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500);
  const p = spawnAt(w, 560, 500, { shielded: true });
  damagePlayer(w, p, 50, { attacker: a, team: a.team, label: 'x', piercing: false, via: 'bullet', fromX: 500, fromY: 500, gun: 'pistol', dirX: 1, dirY: 0 });
  assert.equal(shoved(p), null);
});

test('a blast shoves away from where it burst, harder than a round and under the blast cap', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 100, 100);
  const b = spawnAt(w, 600, 500);
  explode(w, 560, 500, 120, 100, { attacker: a, team: a.team, label: 'Grenade' });
  const k = shoved(b)!;
  assert.ok(k.vx > 0 && Math.abs(k.vy) < 1e-6);
  assert.ok(Math.hypot(k.vx, k.vy) > KNOCK.cap * 0.5 && Math.hypot(k.vx, k.vy) <= KNOCK.blastCap + 1e-9);
  assert.ok(blastShove(50) > bulletShove('assault', 50));
  const hit = w.events.find((e) => e.e === 'dmg' && e.victim === b.id);
  assert.ok(hit?.e === 'dmg' && hit.push !== undefined && Math.abs(hit.push) < 0.01, 'the dmg event carries the heading for the flinch');
});

test('zombies are knocked back by weight: runners and walkers fly, plated resist, brutes and the colossus do not move', () => {
  const thrown = (kind: 'walker' | 'runner' | 'plated' | 'brute' | 'colossus' | 'bloater') => {
    const w = emptyWorld('ZOM');
    const a = spawnAt(w, 500, 500, { loadout: { weapon: 'shotgun' } });
    equip(a, 'slugGun');
    w.zombies.push({ id: newId(w), kind, x: 600, y: 500, hp: 1e6, attackAt: Infinity, vx: 0, vy: 0 });
    const z = w.zombies[0]!;
    explode(w, 560, 500, 90, 40, { attacker: a, team: null, label: 'x' });
    return z.knock ? Math.hypot(z.knock.vx, z.knock.vy) : 0;
  };
  const [walker, runner, plated, bloater, brute, colossus] = [thrown('walker'), thrown('runner'), thrown('plated'), thrown('bloater'), thrown('brute'), thrown('colossus')];
  assert.ok(runner > walker && walker > bloater && bloater > plated && plated > 0, `${runner} ${walker} ${bloater} ${plated}`);
  assert.equal(brute, 0);
  assert.equal(colossus, 0);
});

test('a bullet knocks a zombie back along its flight', () => {
  const w = emptyWorld('ZOM');
  const a = spawnAt(w, 500, 500, { loadout: { weapon: 'sniper' } });
  equip(a, 'sniper');
  w.zombies.push({ id: newId(w), kind: 'walker', x: 700, y: 500, hp: 1e6, attackAt: Infinity, vx: 0, vy: 0 });
  const z = w.zombies[0]!;
  press(w, a, { angle: 0, fire: true, shots: a.input.shots + 1 });
  let peak = 0;
  for (let i = 0; i < 12; i++) { step(w, TICK_MS); peak = Math.max(peak, z.knock?.vx ?? 0); }
  assert.ok(peak > 60 && peak <= KNOCK.cap + 1e-9, `thrown along the shot at ${peak} px/s`);
});

test('the shove rides the self snapshot through the wire encoder and is gone with it', () => {
  const w = emptyWorld();
  const b = spawnAt(w, 600, 500);
  assert.equal(snapshotFor(w, b.id).self.knock ?? null, null);
  applyKnock(w, b, 0, 1, 90);
  const snap = snapshotFor(w, b.id);
  assert.ok(snap.self.knock && Math.abs(snap.self.knock.vy - 90) < 1e-9);
  const wire = JSON.parse(makeSnapshotEncoder()(snap)) as { self: { knock: { vx: number; vy: number } } };
  assert.deepEqual(wire.self.knock, { vx: 0, vy: 90 }, 'whole px/s on the wire');
  b.life.k === 'alive' && (b.life.knock = null);
  assert.equal(snapshotFor(w, b.id).self.knock, null);
});

test('a hit\'s shove heading reaches the client to the hundredth of a radian, for its flinch', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500), b = spawnAt(w, 600, 560);
  damagePlayer(w, b, 5, { attacker: a, team: a.team, label: 'Pistol', piercing: false, via: 'bullet', fromX: a.x, fromY: a.y, gun: 'pistol', dirX: 100, dirY: 60 });
  const snap = { ...snapshotFor(w, a.id), events: w.events };
  const sent = (JSON.parse(makeSnapshotEncoder()(snap)) as { events: { e: string; push?: number }[] }).events.find((e) => e.e === 'dmg');
  assert.equal(sent?.push, Math.round(Math.atan2(60, 100) * 100) / 100);
  assert.notEqual(sent?.push, Math.round(Math.atan2(60, 100)), 'not rounded away to whole radians');
});

test('knockback is deterministic: two worlds fed the same hits agree to the bit', () => {
  const play = () => {
    const w: World = emptyWorld();
    const a = spawnAt(w, 500, 500, { loadout: { weapon: 'shotgun' } });
    equip(a, 'shotgun');
    const b = spawnAt(w, 560, 520);
    press(w, a, { angle: 0.1, fire: true, shots: 1 });
    for (let i = 0; i < 20; i++) { step(w, TICK_MS); press(w, a, { angle: 0.1 }); }
    return [b.x, b.y];
  };
  assert.deepEqual(play(), play());
});
