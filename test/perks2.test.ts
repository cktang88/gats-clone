/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PERK_ICONS } from '../src/client/icons.ts';
import { ARMORS, GUNS, PERK_INFO, PERK_TIERS, pickOptions, settleRulesOf, SPRINT, TIER2_OFFER, WORLD, type PerkId } from '../src/shared/defs.ts';
import { loadOf, sprintShareOf } from '../src/shared/handling.ts';
import { step } from '../src/shared/sim.ts';
import { damagePlayer, explode } from '../src/shared/sim/combat.ts';
import { applyKnock } from '../src/shared/sim/knock.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { abilityCooldownMs, bloomRecoverMul, choosePick, drawTier2Offer, effectiveStats, hasPerk, pendingPick, PERK_RULES, spreadFor } from '../src/shared/sim/stats.ts';
import { pullTrigger, type TriggerState } from '../src/shared/sim/trigger.ts';
import { createWorld, type Player, type World } from '../src/shared/sim/world.ts';
import { ROTATION } from '../src/shared/maps.ts';
import { emptyWorld, equip, grantPerks, hpOf, offerPerks, press, run, spawnAt, TICK_MS } from './helpers.ts';

type P2 = (typeof PERK_TIERS)[2][number];
const TIER2: readonly P2[] = PERK_TIERS[2];
const inPool = (p: PerkId) => (TIER2 as readonly PerkId[]).includes(p);
const NEW_PERKS = TIER2.filter((p) => p !== 'shield' && p !== 'thickSkin' && p !== 'firstAid');

/** A player holding `perk` as their tier-2 pick (nothing else), so only that perk's effect is in play. */
function holding(w: World, perk: P2, x = 500, y = 500, opts: Parameters<typeof spawnAt>[3] = {}): Player {
  const p = spawnAt(w, x, y, opts);
  p.perks = { 2: perk };
  return p;
}

const hit = (w: World, victim: Player, attacker: Player | null, amount: number, via: 'bullet' | 'blast' = 'bullet') =>
  damagePlayer(w, victim, amount, { attacker, team: attacker?.team ?? null, label: 'test', piercing: false, via, fromX: victim.x - 100, fromY: victim.y, gun: 'pistol', dirX: 1, dirY: 0 });

test('the tier-2 pool holds the three old perks and twelve new ones, each described, iconned and free of reserve-ammo wording', () => {
  assert.equal(TIER2.length, 15);
  for (const old of ['shield', 'thickSkin', 'firstAid'] as const) assert.ok(TIER2.includes(old));
  assert.equal(NEW_PERKS.length, 12);
  assert.ok(!(TIER2 as readonly string[]).includes('scavenger'), 'ammo is unlimited, so no ammo perk');
  const names = new Set<string>();
  for (const perk of TIER2) {
    const { name, desc } = PERK_INFO[perk];
    assert.ok(name.length > 0 && desc.length > 12, perk);
    assert.ok(!names.has(name), `${name} is unique`);
    names.add(name);
    assert.ok(!/ammo|reserve|rounds left/i.test(desc), `${perk}: "${desc}" must not imply a finite reserve`);
    assert.ok(PERK_ICONS[perk].length > 10, `${perk} has an icon`);
  }
  assert.ok(/magazine/.test(PERK_INFO.fastHands.desc) && /reload 25% faster/i.test(PERK_INFO.fastHands.desc));
});

test('the README names every tier-2 perk and documents sprint', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const perk of TIER2) assert.ok(readme.includes(PERK_INFO[perk].name), `README lists ${PERK_INFO[perk].name}`);
  assert.ok(/\| `?Shift`? \|/.test(readme) || /Shift/.test(readme), 'README documents Shift');
  assert.ok(/sprint/i.test(readme));
});

test('a level-up offers four of the tier-2 pool, drawn per life from the world rng, so a replay offers the same four', () => {
  const lives = (seed: number) => {
    const w = createWorld('FFA', seed, ROTATION.FFA[0]);
    return Array.from({ length: 24 }, () => drawTier2Offer(w));
  };
  const a = lives(1), b = lives(1), c = lives(2);
  assert.deepEqual(a, b, 'same seed, same offers');
  assert.notDeepEqual(a, c, 'another seed deals differently');
  for (const offer of a) {
    assert.equal(offer.length, TIER2_OFFER);
    assert.equal(new Set(offer).size, TIER2_OFFER, 'no repeats');
    assert.ok(offer.every(inPool));
    assert.deepEqual(offer, TIER2.filter((p) => offer.includes(p)), 'listed in pool order');
  }
  assert.ok(new Set(a.map((o) => o.join())).size > 12, 'the offers vary life to life');
  const seen = new Set(a.flat());
  assert.ok(seen.size >= 13, `over many lives nearly every perk comes up (${seen.size}/15)`);
});

test('every spawn draws a fresh offer; the pick opens with it and choosePick takes only what was offered', () => {
  const w = emptyWorld();
  const p = spawnAt(w, 500, 500);
  assert.equal(p.tier2Offer.length, TIER2_OFFER);
  p.level = 3;
  assert.ok(choosePick(w, p.id, 2, 'handCannon'));
  assert.ok(choosePick(w, p.id, 1, 'lightweight'));
  const pending = pendingPick(p)!;
  assert.deepEqual([pending.k === 'perk' && pending.tier, pending.k === 'perk' && pending.offer], [2, p.tier2Offer]);
  assert.deepEqual(pickOptions(pending, p.gun), p.tier2Offer);
  assert.deepEqual(snapshotFor(w, p.id).self.pending, pending, 'the client is told the offer');
  const notOffered = TIER2.find((perk) => !p.tier2Offer.includes(perk))!;
  assert.equal(choosePick(w, p.id, 3, notOffered), false, 'a perk outside the offer is refused');
  assert.equal(p.perks[2], undefined);
  assert.ok(choosePick(w, p.id, 3, p.tier2Offer[2]!));
  assert.equal(p.perks[2], p.tier2Offer[2]);
  // Tiers 1 and 3 keep their menus.
  p.level = 4;
  const abilities = pendingPick(p)!;
  assert.deepEqual(pickOptions(abilities, p.gun), PERK_TIERS[3]);
});

test('Marathon: sprint 15% faster and the post-sprint settle half as long', () => {
  const w = emptyWorld();
  const p = holding(w, 'marathon');
  const s = effectiveStats(p);
  const share = sprintShareOf(loadOf(GUNS[p.gun].kg, GUNS[p.gun].cm, ARMORS[p.loadout.armor].kg));
  assert.ok(Math.abs(s.sprintSpeed - s.speed * (1 + (SPRINT.speedMul - 1) * share) * 1.15) < 1e-9);
  assert.equal(s.settleMs, settleRulesOf(GUNS[p.gun]).ms / 2);
  const plain = spawnAt(w, 900, 900);
  assert.equal(effectiveStats(plain).settleMs, settleRulesOf(GUNS[plain.gun]).ms);
});

test('Steady Hands: bloom builds 40% slower, recovers 60% faster, and the settle is a quarter shorter', () => {
  const plain = { 2: 'firstAid' } as const, steady = { 2: 'steadyHands' } as const;
  const bloomAt = (perks: typeof plain | typeof steady) => spreadFor('assault', perks, true, 6) / spreadFor('assault', perks, true, 0);
  assert.ok(Math.abs((bloomAt(steady) - 1) / (bloomAt(plain) - 1) - 0.6) < 0.02, `bloom builds at ${(bloomAt(steady) - 1) / (bloomAt(plain) - 1)} of the pace`);
  assert.equal(bloomRecoverMul(steady), 1.6);
  const sprayAfter = (recover: number) => {
    const s: TriggerState = { ammo: 30, reloadUntil: null, nextFireAt: 0, burstLeft: 0, pressUntil: -Infinity, spray: 8, firedAt: -10_000, spin: 0 };
    for (let i = 0; i < 2; i++) pullTrigger(s, { def: GUNS.assault, mag: 30, reloadMs: 2000, armed: true, bloomRecover: recover }, { pressed: false, fire: false, reload: false }, i * TICK_MS, TICK_MS);
    return s.spray;
  };
  assert.ok(sprayAfter(1.6) < sprayAfter(1) - 0.3, 'the bloom drains faster');
  const w = emptyWorld();
  const held = holding(w, 'steadyHands');
  assert.equal(effectiveStats(held).settleMs, settleRulesOf(GUNS[held.gun]).ms * 0.75);
});

test('Second Wind: once a life, dropping under 25% health gives 2 s of +30% speed and half damage', () => {
  const w = emptyWorld();
  const p = holding(w, 'secondWind');
  const foe = spawnAt(w, 900, 500);
  const speed = () => snapshotFor(w, p.id).self.speed;
  const base = effectiveStats(p).speed;
  hit(w, p, foe, 60);
  assert.equal(speed(), base, 'at 40% health nothing happens');
  hit(w, p, foe, 20);
  assert.ok(hpOf(p) < 25 && hpOf(p) > 0);
  assert.ok(Math.abs(speed() - base * PERK_RULES.secondWind.speedMul) < 1e-9, 'sped up');
  assert.equal(snapshotFor(w, foe.id).players.find((q) => q.id === p.id)?.rush, true, 'others see it');
  const before = hpOf(p);
  hit(w, p, foe, 10);
  assert.ok(Math.abs(before - hpOf(p) - 5) < 0.01, `half damage (${before - hpOf(p)})`);
  run(w, 2100);
  assert.equal(speed(), base, 'over after 2 s');
  if (p.life.k === 'alive') p.life.hp = 50;
  hit(w, p, foe, 40);
  assert.equal(speed(), base, 'and it does not come back this life');
  assert.ok(hasPerk(p, 'secondWind'));
});

test('Adrenaline: a kill grants +20% speed for 3 s', () => {
  const w = emptyWorld();
  const p = holding(w, 'adrenaline');
  const victim = spawnAt(w, 900, 500);
  const base = effectiveStats(p).speed;
  hit(w, victim, p, 500);
  assert.equal(victim.life.k, 'dead');
  const speed = () => snapshotFor(w, p.id).self.speed;
  assert.ok(Math.abs(speed() - base * 1.2) < 1e-9);
  run(w, 2900);
  assert.ok(speed() > base);
  run(w, 300);
  assert.equal(speed(), base);
  const other = spawnAt(w, 1500, 1500);
  assert.equal(snapshotFor(w, other.id).self.speed, effectiveStats(other).speed, 'only the killer');
});

test('Adrenaline speed carries into movement', () => {
  const dist = (perk: P2 | null) => {
    const w = emptyWorld();
    const p = spawnAt(w, 300, 500);
    if (perk) p.perks = { 2: perk };
    const v = spawnAt(w, 1500, 1500);
    hit(w, v, p, 500);
    press(w, p, { right: true });
    run(w, 1000);
    return p.x - 300;
  };
  assert.ok(Math.abs(dist('adrenaline') / dist(null) - 1.2) < 0.03);
});

test('Bloodlust: heal 15% of the damage you deal', () => {
  const w = emptyWorld();
  const p = holding(w, 'bloodlust');
  const plain = spawnAt(w, 500, 900);
  const victim = spawnAt(w, 900, 500, { kind: 'bot' });
  if (p.life.k === 'alive') p.life.hp = 50;
  if (plain.life.k === 'alive') plain.life.hp = 50;
  hit(w, victim, p, 20);
  hit(w, victim, plain, 20);
  assert.ok(Math.abs(hpOf(p) - (50 + 0.15 * 20)) < 1e-9, `healed to ${hpOf(p)}`);
  assert.equal(hpOf(plain), 50);
  const human = spawnAt(w, 1500, 500, { kind: 'human' });
  if (human.life.k === 'alive') human.life.hp = 100;
  human.perks = { 2: 'bloodlust' };
  hit(w, victim, human, 20);
  assert.ok(Math.abs(hpOf(human) - (100 + 0.15 * 20 * 4)) < 1e-9, 'a human heals in its own bigger health scale');
  if (p.life.k === 'alive') p.life.hp = effectiveStats(p).maxHp - 1;
  hit(w, victim, p, 20);
  assert.equal(hpOf(p), effectiveStats(p).maxHp, 'never past full health');
});

test('Recon: +8% view radius, and you see enemies reload', () => {
  const w = emptyWorld();
  const spotter = holding(w, 'recon', 500, 500);
  const plain = spawnAt(w, 600, 900);
  const foe = spawnAt(w, 700, 500);
  assert.ok(Math.abs(effectiveStats(spotter).viewRadius - WORLD.viewRadius * 1.08) < 1e-9);
  if (foe.life.k === 'alive') { foe.life.ammo = 1; }
  press(w, foe, { reload: true });
  step(w, TICK_MS);
  assert.equal(foe.life.k === 'alive' && foe.life.reloadUntil !== null, true);
  const mark = (viewer: Player) => snapshotFor(w, viewer.id).players.find((q) => q.id === foe.id)?.reloading;
  assert.equal(mark(spotter), true);
  assert.equal(mark(plain), undefined, 'without Recon the reload is not shown');
  assert.equal(snapshotFor(w, foe.id).players.find((q) => q.id === foe.id)?.reloading, undefined, 'and never on yourself');
});

test('Ninja: a hunted shot never pings you on enemy minimaps (only the timed ping does), and your sprint is silent and unseen', () => {
  const pingAfterShot = (perk: P2 | null) => {
    const w = emptyWorld();
    const p = spawnAt(w, 2600, 2600);
    const enemy = spawnAt(w, 300, 300);
    if (perk) p.perks = { 2: perk };
    equip(p, 'juggernaut');
    step(w, TICK_MS);
    press(w, p, { left: true });
    run(w, 1000);
    press(w, p, { left: true, fire: true, shots: p.input.shots + 1 });
    step(w, TICK_MS);
    return snapshotFor(w, enemy.id).minimap.map((m) => Math.round(m.x))[0];
  };
  assert.equal(pingAfterShot('ninja'), 2600, 'the Ninja stays where the timed ping caught them');
  assert.ok(pingAfterShot(null)! < 2550, 'without it the shot pings them where they fired');
  const w = emptyWorld();
  const ninja = holding(w, 'ninja');
  const watcher = spawnAt(w, 800, 500);
  press(w, ninja, { right: true, sprint: true });
  run(w, TICK_MS * 3);
  assert.equal(snapshotFor(w, ninja.id).self.sprint, true, 'you still sprint');
  assert.equal(snapshotFor(w, watcher.id).players.find((q) => q.id === ninja.id)?.sprint, undefined, 'others neither see nor hear it');
  const plain = spawnAt(w, 500, 900);
  press(w, plain, { right: true, sprint: true });
  run(w, TICK_MS * 3);
  assert.equal(snapshotFor(w, watcher.id).players.find((q) => q.id === plain.id)?.sprint, true);
});

test('Overclock: abilities recharge 30% sooner', () => {
  assert.equal(abilityCooldownMs('dash', { 2: 'overclock' }), 3500 * 0.7);
  assert.equal(abilityCooldownMs('dash', {}), 3500);
  const w = emptyWorld();
  const p = spawnAt(w, 500, 500);
  grantPerks(w, p, ['extended', 'overclock', 'dash']);
  press(w, p, { ability: true, right: true });
  step(w, TICK_MS);
  assert.ok(Math.abs(p.abilityReadyAt - w.now - 2450) < 1, `ready in ${p.abilityReadyAt - w.now}`);
  assert.ok(snapshotFor(w, p.id).self.abilityReadyIn <= 2450);
});

test('Demolitions: your blasts hit 30% harder and wider, and you take 30% less blast damage', () => {
  const dmgAt = (perk: P2 | null, distance: number, victimPerk: P2 | null = null) => {
    const w = emptyWorld();
    const a = spawnAt(w, 300, 300);
    if (perk) a.perks = { 2: perk };
    const v = spawnAt(w, 1000, 1000, { kind: 'human' });
    if (victimPerk) v.perks = { 2: victimPerk };
    v.x = 1000 + distance;
    const before = hpOf(v);
    explode(w, 1000, 1000, 100, 60, { attacker: a, team: null, label: 'Grenade' });
    return { lost: before - hpOf(v), booms: w.events.filter((e) => e.e === 'boom') };
  };
  const plain = dmgAt(null, 0), strong = dmgAt('demolitions', 0);
  assert.ok(Math.abs(strong.lost / plain.lost - 1.3) < 1e-6, `${strong.lost} vs ${plain.lost}`);
  const rim = 100 + WORLD.playerRadius + 10;
  assert.equal(dmgAt(null, rim).lost, 0, 'outside a plain blast');
  assert.ok(dmgAt('demolitions', rim).lost > 0, 'inside the widened one');
  assert.equal((strong.booms[0] as { r: number }).r, 130);
  assert.ok(Math.abs(dmgAt(null, 0, 'demolitions').lost / plain.lost - 0.7) < 1e-6, 'and 30% less to the one standing in it');
});

test('Fast Hands: reload 25% faster, and an evolution refills the magazine', () => {
  const w = emptyWorld();
  const p = holding(w, 'fastHands');
  assert.ok(Math.abs(effectiveStats(p).reloadMs - GUNS.pistol.reloadMs * 0.75) < 1e-9);
  const q = spawnAt(w, 900, 900);
  assert.equal(effectiveStats(q).reloadMs, GUNS.pistol.reloadMs);
  const evolved = (perk: P2 | null) => {
    const world = emptyWorld();
    const x = spawnAt(world, 500, 500);
    if (perk) x.perks = { 2: perk };
    x.level = 2;
    if (x.life.k === 'alive') x.life.ammo = 2;
    assert.ok(choosePick(world, x.id, 2, 'handCannon'));
    return x.life.k === 'alive' ? x.life.ammo : -1;
  };
  assert.equal(evolved('fastHands'), GUNS.handCannon.mag);
  assert.ok(evolved(null) < GUNS.handCannon.mag);
});

test('Tracker: enemies you damage are marked on your minimap for 4 s', () => {
  const w = emptyWorld();
  const hunter = holding(w, 'tracker', 300, 300);
  const prey = spawnAt(w, 2500, 2500);
  const bystander = spawnAt(w, 2000, 300);
  const marks = (viewer: Player) => snapshotFor(w, viewer.id).minimap;
  assert.equal(marks(hunter).length, 0, 'nobody is shown before a hit');
  hit(w, prey, hunter, 10);
  const shown = marks(hunter);
  assert.equal(shown.length, 1);
  assert.deepEqual([Math.round(shown[0]!.x), shown[0]!.marked], [Math.round(prey.x), true]);
  assert.equal(marks(bystander).length, 0, 'only the tracker sees it');
  run(w, 3900);
  assert.equal(marks(hunter).length, 1, 'still there at 3.9 s');
  run(w, 300);
  assert.equal(marks(hunter).length, 0, 'gone after 4 s');
  hit(w, prey, hunter, 10);
  assert.equal(marks(hunter).length, 1, 'a new hit marks again');
});

test('Brace: take 60% less knockback and deal 15% more', () => {
  const shoved = (p: Player) => (p.life.k === 'alive' && p.life.knock ? Math.hypot(p.life.knock.vx, p.life.knock.vy) : 0);
  const w = emptyWorld();
  const braced = holding(w, 'brace', 500, 500), plain = spawnAt(w, 900, 500);
  applyKnock(w, braced, 1, 0, 100);
  applyKnock(w, plain, 1, 0, 100);
  assert.ok(Math.abs(shoved(braced) / shoved(plain) - 0.4) < 1e-9);
  const dealt = (perk: P2 | null) => {
    const world = emptyWorld();
    const a = spawnAt(world, 500, 500);
    if (perk) a.perks = { 2: perk };
    const v = spawnAt(world, 580, 500, { kind: 'human' });
    hit(world, v, a, 20);
    return shoved(v);
  };
  assert.ok(Math.abs(dealt('brace') / dealt(null) - 1.15) < 1e-9);
});

test('the three older tier-2 perks still work', () => {
  const w = emptyWorld();
  const p = holding(w, 'thickSkin');
  assert.equal(effectiveStats(p).maxHp, WORLD.baseHp + 40);
  assert.equal(effectiveStats(holding(w, 'firstAid', 900, 900)).regenPerSec, WORLD.regenPerSec * 3);
  assert.equal(effectiveStats(holding(w, 'shield', 1300, 900)).shield, true);
});
