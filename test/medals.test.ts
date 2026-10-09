import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUNS, MEDAL_RULES, MEDALS, rulesOf, WEAPON_MEDALS, WORLD, type GunId, type MedalId } from '../src/shared/defs.ts';
import { step } from '../src/shared/sim.ts';
import { damagePlayer } from '../src/shared/sim/combat.ts';
import { effectiveStats } from '../src/shared/sim/stats.ts';
import type { Player, World } from '../src/shared/sim/world.ts';
import { emptyWorld, spawnAt, TICK_MS } from './helpers.ts';

const hit = (w: World, by: Player, victim: Player, amount: number) =>
  damagePlayer(w, victim, amount, { attacker: by, team: by.team, label: 'Pistol', piercing: true, via: 'bullet', fromX: by.x, fromY: by.y });

/** `by` kills `victim` in one blow; the medals it earned, and the score they and the kill paid. */
function slay(w: World, by: Player, victim: Player): { medals: MedalId[]; gained: number } {
  w.events = [];
  const before = by.score;
  hit(w, by, victim, 10_000);
  return { medals: w.events.flatMap((e) => (e.e === 'medal' && e.id === by.id ? [e.medal] : [])), gained: by.score - before };
}

test('the round\'s first kill is First Blood, once', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500);
  const first = slay(w, a, spawnAt(w, 800, 500));
  assert.deepEqual(first.medals, ['firstBlood']);
  assert.equal(first.gained, WORLD.killScore + MEDALS.firstBlood.score, 'a medal pays its score');
  w.now += MEDAL_RULES.multiMs + 1;
  assert.deepEqual(slay(w, a, spawnAt(w, 800, 600)).medals, []);
});

test('kills in quick succession earn the multi-kill medals, and a pause resets the chain', () => {
  const w = emptyWorld();
  w.firstBlood = true;
  const a = spawnAt(w, 500, 500);
  const got = [0, 1, 2, 3, 4].map((i) => { w.now += 1000; return slay(w, a, spawnAt(w, 800, 300 + i * 60)).medals.filter((m) => m !== 'onFire' && m !== 'rampage'); });
  assert.deepEqual(got, [[], ['doubleKill'], ['tripleKill'], ['quadKill'], ['massacre']]);
  w.now += MEDAL_RULES.multiMs + 1;
  assert.deepEqual(slay(w, a, spawnAt(w, 800, 700)).medals, []);
});

test('range medals: a Long Shot from far, Point Blank from close, nothing between', () => {
  const w = emptyWorld();
  w.firstBlood = true;
  const a = spawnAt(w, 500, 500);
  const at = (dx: number) => { w.now += MEDAL_RULES.multiMs + 1; return slay(w, a, spawnAt(w, 500 + dx, 500)).medals.filter((m) => m !== 'onFire'); };
  assert.deepEqual(at(MEDAL_RULES.longShotPx), ['longShot']);
  assert.deepEqual(at(MEDAL_RULES.pointBlankPx), ['pointBlank']);
  assert.deepEqual(at(300), []);
});

test('Clutch: killing whoever is hurting you on your last legs', () => {
  const w = emptyWorld();
  w.firstBlood = true;
  const a = spawnAt(w, 500, 500), b = spawnAt(w, 800, 500);
  const max = effectiveStats(a).maxHp;
  hit(w, b, a, max * (1 - MEDAL_RULES.clutchHp) + 1);
  assert.deepEqual(slay(w, a, b).medals, ['clutch']);
  const c = spawnAt(w, 800, 700);
  w.now += MEDAL_RULES.multiMs + 1;
  assert.deepEqual(slay(w, a, c).medals, [], 'not against someone who never touched you');
});

test('Close Call: drop under a tenth of your health and live six more seconds, once until you heal', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500), b = spawnAt(w, 1500, 1500);
  hit(w, b, a, effectiveStats(a).maxHp * (1 - MEDAL_RULES.closeCallHp) + 1);
  const medals: MedalId[] = [];
  for (let t = 0; t < MEDAL_RULES.closeCallMs * 2; t += TICK_MS) {
    step(w, TICK_MS);
    for (const e of w.events) if (e.e === 'medal' && e.id === a.id) medals.push(e.medal);
  }
  assert.deepEqual(medals, ['closeCall']);
  const drop = () => { if (a.life.k === 'alive') a.life.hp = effectiveStats(a).maxHp * MEDAL_RULES.closeCallHp * 0.5; };
  const liveThrough = () => {
    const got: MedalId[] = [];
    for (let t = 0; t < MEDAL_RULES.closeCallMs + 500; t += TICK_MS) {
      step(w, TICK_MS);
      for (const e of w.events) if (e.e === 'medal' && e.id === a.id) got.push(e.medal);
    }
    return got;
  };
  // Healed a little, not past the reset, then down again: no second medal.
  if (a.life.k === 'alive') a.life.hp = effectiveStats(a).maxHp * (MEDAL_RULES.closeCallReset - 0.1);
  run1(w);
  drop();
  assert.deepEqual(liveThrough(), [], 'no second Close Call without healing past half');
  if (a.life.k === 'alive') a.life.hp = effectiveStats(a).maxHp * MEDAL_RULES.closeCallReset;
  run1(w);
  drop();
  assert.deepEqual(liveThrough(), ['closeCall'], 'healed past half, the next close call counts');
});

const run1 = (w: World) => step(w, TICK_MS);

test('Ghost: covering ghostPx without a shot pays once each time it is covered; a shot or a jump starts the count again', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 300, 1000);
  const speed = effectiveStats(a).speed;
  const G = MEDAL_RULES.ghostPx;
  let right = true, leg = 0;
  /** Walks `px` back and forth in legs of 1500px, so the field's edge never stops the count; the Ghost medals it paid. */
  const walk = (px: number) => {
    let n = 0;
    for (let t = 0; t < (px / speed) * 1000; t += TICK_MS) {
      a.input = { ...a.input, right, left: !right };
      step(w, TICK_MS);
      leg += (speed * TICK_MS) / 1000;
      if (leg >= 1500) { leg = 0; right = !right; }
      n += w.events.filter((e) => e.e === 'medal' && e.id === a.id && e.medal === 'ghost').length;
    }
    return n;
  };
  assert.equal(walk(G * 2 / 3), 0);
  a.x = 300; right = true; leg = 0;
  assert.equal(walk(G * 2 / 3), 0, 'a jump (a respawn, a teleport) starts the count again');
  assert.equal(walk(G / 3 + 100), 1, 'the last px of the count pays');
  assert.equal(walk(G / 2), 0, 'and starts a fresh count');
  if (a.life.k === 'alive') a.life.firedAt = w.now;
  assert.equal(walk(G * 0.55), 0, 'a shot resets it');
});

/** `by` lands one round of `gun` on `victim`; the medals that round earned. */
function shot(w: World, by: Player, victim: Player, gun: GunId, amount: number, volley = w.tick): MedalId[] {
  w.events = [];
  damagePlayer(w, victim, amount, { attacker: by, team: by.team, label: GUNS[gun].name, piercing: true, via: 'bullet', fromX: by.x, fromY: by.y, gun, volley });
  return w.events.flatMap((e) => (e.e === 'medal' && e.id === by.id ? [e.medal] : []));
}

test('a sniper\'s one-hit kill from far off earns every medal it qualifies for at once, and a third one-hit kill is a Reaper', () => {
  const w = emptyWorld();
  w.firstBlood = true;
  const a = spawnAt(w, 500, 500);
  const far = shot(w, a, spawnAt(w, 500 + WEAPON_MEDALS.eagleEyePx + 10, 500), 'sniper', 10_000);
  assert.deepEqual(far, ['longShot', 'oneShot', 'eagleEye'], 'Long Shot, One Shot and Eagle Eye all land on the one kill');
  w.now += MEDAL_RULES.multiMs + 1;
  assert.deepEqual(shot(w, a, spawnAt(w, 600, 500), 'sniper', 10_000), ['noScope'], 'a sniper kill up close is No Scope, and too close for One Shot');
  w.now += MEDAL_RULES.multiMs + 1;
  const third = shot(w, a, spawnAt(w, 500 + WEAPON_MEDALS.oneShotPx + 10, 500), 'sniper', 10_000);
  assert.ok(third.includes('oneShot') && !third.includes('reaper') && third.includes('onFire'), `${third}`);
  w.now += MEDAL_RULES.multiMs + 1;
  const fourth = shot(w, a, spawnAt(w, 500 + WEAPON_MEDALS.oneShotPx + 10, 700), 'sniper', 10_000);
  assert.ok(fourth.includes('oneShot') && fourth.includes('reaper'), `the third One Shot is a Reaper: ${fourth}`);
  w.now += MEDAL_RULES.multiMs + 1;
  const fifth = shot(w, a, spawnAt(w, 500 + WEAPON_MEDALS.oneShotPx + 10, 300), 'sniper', 10_000);
  assert.ok(fifth.includes('oneShot') && !fifth.includes('reaper'), `a fourth one-hit kill is no second Reaper: ${fifth}`);
  w.now += MEDAL_RULES.multiMs + 1;
  const hurt = spawnAt(w, 900, 600);
  if (hurt.life.k === 'alive') hurt.life.hp = 1;
  assert.ok(!shot(w, a, hurt, 'sniper', 10_000).includes('oneShot'), 'a kill on someone already hurt is not One Shot');
});

test('one shotgun blast landing on two enemies is Two Birds, once per blast', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500);
  const b = spawnAt(w, 600, 480), c = spawnAt(w, 600, 520);
  assert.deepEqual(shot(w, a, b, 'shotgun', 5, 7), []);
  assert.deepEqual(shot(w, a, b, 'shotgun', 5, 7), [], 'a second pellet on the same enemy is no second bird');
  assert.deepEqual(shot(w, a, c, 'shotgun', 5, 7), ['twoBirds']);
  assert.deepEqual(shot(w, a, b, 'shotgun', 5, 8), [], 'the next blast starts over');
  assert.deepEqual(shot(w, a, c, 'pistol', 5, 9), []);
});

test('two pistol kills from one magazine are a Double Tap, but not across a reload', () => {
  const w = emptyWorld();
  w.firstBlood = true;
  const a = spawnAt(w, 500, 500);
  shot(w, a, spawnAt(w, 600, 500), 'pistol', 10_000);
  w.now += MEDAL_RULES.multiMs + 1;
  assert.ok(shot(w, a, spawnAt(w, 600, 600), 'pistol', 10_000).includes('doubleTap'));
  w.now += MEDAL_RULES.multiMs + 1;
  assert.ok(!shot(w, a, spawnAt(w, 600, 700), 'pistol', 10_000).includes('doubleTap'), 'a third kill from the magazine is no second Double Tap');
  const b = spawnAt(w, 2000, 2000);
  shot(w, b, spawnAt(w, 2100, 2000), 'pistol', 10_000);
  if (b.life.k === 'alive') b.life.ammo = 1;
  b.input = { ...b.input, reload: true };
  for (let i = 0; i < 3; i++) step(w, TICK_MS);
  w.now += MEDAL_RULES.multiMs + 1;
  assert.ok(!shot(w, b, spawnAt(w, 2100, 2100), 'pistol', 10_000).includes('doubleTap'), 'a reload starts the count again');
});

test('a machine gun kill on a pinned enemy is Pinned Down, and three kills from one belt are Belt Fed', () => {
  const w = emptyWorld();
  w.firstBlood = true;
  const a = spawnAt(w, 500, 500);
  const near = spawnAt(w, 700, 500);
  if (near.life.k === 'alive') near.life.suppression = 1;
  assert.deepEqual(shot(w, a, near, 'lmg', 10_000), [], 'pinned, but too close to count');
  w.now += MEDAL_RULES.multiMs + 1;
  const loose = spawnAt(w, 500 + WEAPON_MEDALS.pinnedPx + 10, 600);
  if (loose.life.k === 'alive') loose.life.suppression = WEAPON_MEDALS.pinnedSuppression - 0.1;
  assert.deepEqual(shot(w, a, loose, 'lmg', 10_000), [], 'far, but not pinned');
  w.now += MEDAL_RULES.multiMs + 1;
  const pinned = spawnAt(w, 500 + WEAPON_MEDALS.pinnedPx + 10, 500);
  if (pinned.life.k === 'alive') pinned.life.suppression = WEAPON_MEDALS.pinnedSuppression;
  assert.ok(shot(w, a, pinned, 'lmg', 10_000).includes('pinnedDown'), 'pinned far off');
  w.now += MEDAL_RULES.multiMs + 1;
  assert.ok(!shot(w, a, spawnAt(w, 700, 700), 'lmg', 10_000).includes('beltFed'), 'a fourth kill from the belt is no second Belt Fed');
  const b = spawnAt(w, 2000, 2000);
  shot(w, b, spawnAt(w, 2100, 2000), 'lmg', 10_000);
  w.now += MEDAL_RULES.multiMs + 1;
  shot(w, b, spawnAt(w, 2100, 2100), 'lmg', 10_000);
  w.now += MEDAL_RULES.multiMs + 1;
  assert.ok(shot(w, b, spawnAt(w, 2100, 2200), 'lmg', 10_000).includes('beltFed'), 'three kills from one belt');
});

test('Run and Gun is an SMG kill on the move just out of a sprint; Disciplined an assault kill from range before the spray blooms', () => {
  const w = emptyWorld();
  w.firstBlood = true;
  const a = spawnAt(w, 500, 500, { loadout: { weapon: 'smg' } });
  const moving = (sprintEndedAgo: number) => {
    if (a.life.k !== 'alive') return;
    a.life.lastMoveAt = w.now;
    a.life.sprintEndAt = w.now - sprintEndedAgo;
  };
  moving(Infinity);
  assert.deepEqual(shot(w, a, spawnAt(w, 700, 500), 'smg', 10_000), [], 'on the move, but no sprint behind it');
  w.now += MEDAL_RULES.multiMs + 1;
  moving(WEAPON_MEDALS.runAndGunMs / 2);
  assert.deepEqual(shot(w, a, spawnAt(w, 700, 600), 'smg', 10_000), ['runAndGun']);
  w.now += MEDAL_RULES.multiMs + 1;
  moving(WEAPON_MEDALS.runAndGunMs + 100);
  assert.ok(!shot(w, a, spawnAt(w, 700, 700), 'smg', 10_000).includes('runAndGun'), 'too long out of the sprint');
  const r = spawnAt(w, 2000, 2000, { loadout: { weapon: 'assault' } });
  assert.deepEqual(shot(w, r, spawnAt(w, 2000 + WEAPON_MEDALS.disciplinedPx - 100, 2000), 'assault', 10_000), [], 'a controlled kill, but close');
  w.now += MEDAL_RULES.multiMs + 1;
  assert.deepEqual(shot(w, r, spawnAt(w, 2000 + WEAPON_MEDALS.disciplinedPx + 10, 2100), 'assault', 10_000), ['disciplined']);
  w.now += MEDAL_RULES.multiMs + 1;
  if (r.life.k === 'alive') r.life.spray = rulesOf(GUNS.assault).bloom!.tap + 1;
  assert.ok(!shot(w, r, spawnAt(w, 2000 + WEAPON_MEDALS.disciplinedPx + 10, 1900), 'assault', 10_000).includes('disciplined'), 'a bloomed spray');
});
