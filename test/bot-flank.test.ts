/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WeaponId } from '../src/shared/defs.ts';
import { step } from '../src/shared/sim.ts';
import { effectiveStats } from '../src/shared/sim/stats.ts';
import { rand, type World } from '../src/shared/sim/world.ts';
import { arenaFor } from '../src/server/bot/arena.ts';
import { focus, freshAwareness, perceive, unseenShooter, type Awareness } from '../src/server/bot/awareness.ts';
import { bandFor, nextIntent, PERSONALITIES, PERSONALITY_IDS, startIntent, type Intent, type IntentCtx, type Plan } from '../src/server/bot/intent.ts';
import { clearShot } from '../src/server/bot/nav.ts';
import { botSnapshot, TACTICAL_TICKS, thinkBots } from '../src/server/bot/tick.ts';
import { newBotMemory, type BotMemory } from '../src/server/bots.ts';
import { flank } from '../scripts/lib/flank.ts';
import { emptyWorld, setWalls, spawnAt, TICK_MS } from './helpers.ts';

const seeded = (seed: number) => { let x = seed; return () => ((x = (x * 16807) % 2147483647) / 2147483647); };

/** A slab east of a bot at (1000, 1000): its spot is hidden from an enemy at (1500, 1000), and a step south of it, its peek, is not. */
const SLAB = { x: 1040, y: 900, w: 30, h: 130 };

function view(w: World, id: number, aware: Awareness = freshAwareness()) {
  const snap = botSnapshot(w, id);
  return perceive(snap, arenaFor(w), snap.players.find((p) => p.id === id)!, aware).view;
}

function decide(w: World, id: number, cur: Plan, weapon: WeaponId = 'assault'): Intent {
  const v = view(w, id);
  const persona = PERSONALITIES.cautious;
  const ctx: IntentCtx = { tick: v.tick, persona, role: null, band: bandFor(weapon, persona), arena: arenaFor(w), rand: seeded(3), strategic: false };
  return nextIntent(startIntent(cur, ctx), v, ctx);
}

test('cover that an enemy in sight can see into is left: for cover from him, or a fight, never the old spot', () => {
  const w = emptyWorld();
  setWalls(w, [SLAB]);
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  const first = spawnAt(w, 1500, 1000);
  const hide: Plan = { k: 'peekAndHide', target: first.id, spot: { x: 1000, y: 1000 }, peek: { x: 1000, y: 1060 }, phase: 'hide', phaseUntil: 1e9 };
  const held = decide(w, bot.id, hide);
  assert.ok(held.k === 'peekAndHide' && held.spot.x === 1000 && held.spot.y === 1000, `the wall still hides it from the one it hid from: ${JSON.stringify(held)}`);

  // A second comes round the wall's end, north of the bot, with a clear line into its spot.
  const flanker = spawnAt(w, 1000, 640);
  const solids = view(w, bot.id).solids;
  const next = decide(w, bot.id, hide);
  if (next.k === 'peekAndHide') {
    assert.ok(next.spot.x !== 1000 || next.spot.y !== 1000, 'a new spot');
    assert.ok(!clearShot(solids, next.spot, flanker), `its new spot ${JSON.stringify(next.spot)} is hidden from the flanker`);
  } else assert.ok(next.k === 'engage' && next.target === flanker.id, `fights the flanker: ${JSON.stringify(next)}`);
});

test('a rusher caught in blown cover pushes the enemy who caught it; a dry gun re-hides its reload from him', () => {
  const w = emptyWorld();
  setWalls(w, [SLAB]);
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'shotgun' } });
  const first = spawnAt(w, 1500, 1000);
  const flanker = spawnAt(w, 1000, 800);
  const rush = decide(w, bot.id, { k: 'peekAndHide', target: first.id, spot: { x: 1000, y: 1000 }, peek: { x: 1000, y: 1060 }, phase: 'hide', phaseUntil: 1e9 }, 'shotgun');
  assert.ok(rush.k === 'engage' && rush.target === flanker.id, `a shotgun 200 px from him goes at him: ${JSON.stringify(rush)}`);

  const reload = decide(w, bot.id, { k: 'reloadInCover', spot: { x: 1000, y: 1000 }, threat: { x: 1500, y: 1000 } });
  const solids = view(w, bot.id).solids;
  assert.ok(reload.k !== 'reloadInCover' || !clearShot(solids, reload.spot, flanker), `reloads out of the flanker's sight, or fights: ${JSON.stringify(reload)}`);
  assert.ok(reload.k === 'reloadInCover' || reload.k === 'engage', reload.k);
});

test('a bot answers the enemy shooting at it before the one it was fighting, turning to find him when he shoots from off its screen', () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  bot.angle = 0;
  const target = spawnAt(w, 1300, 1000);
  const shooter = spawnAt(w, 1000, 1300);
  const calm = view(w, bot.id);
  assert.equal(focus(calm, target.id)?.p.id, target.id, 'keeps its own target over another it merely sees');
  const struck = { ...freshAwareness(), hitTick: w.tick, hitBy: { owner: shooter.id, tick: w.tick } };
  const hit = view(w, bot.id, struck);
  assert.equal(hit.threats[0]?.p.id, shooter.id, 'the one hitting it comes first');
  assert.equal(focus(hit, target.id)?.p.id, shooter.id, 'and it turns on him');
  assert.equal(unseenShooter(hit), null, 'he is on its screen: nothing to turn to');

  // 420 px beside it while it aims along the x axis he is off its 16:9 screen: it cannot see him, but it reads where his rounds come from.
  Object.assign(shooter, { x: 1000, y: 1420 });
  const shotAt = { x: shooter.x, y: shooter.y, tick: w.tick, owner: shooter.id, gun: shooter.gun };
  const blind = view(w, bot.id, { ...struck, shotAt });
  assert.ok(!blind.threats.some((t) => t.p.id === shooter.id), 'off its screen it does not see him');
  assert.deepEqual(unseenShooter(blind), { x: shooter.x, y: shooter.y }, 'so it turns to where the rounds came from');
  bot.angle = Math.PI / 2;
  const turned = view(w, bot.id, { ...struck, shotAt });
  assert.equal(turned.threats[0]?.p.id, shooter.id, 'turned his way, it sees him first');
  assert.equal(focus(turned, target.id)?.p.id, shooter.id, 'and answers him');
  assert.equal(unseenShooter(turned), null);
});

test('an enemy stepping out from behind a wall in its view wakes a bot that tick; one standing hidden there does not keep waking it', () => {
  const setup = (foeAt: { x: number; y: number }) => {
    const w = emptyWorld();
    setWalls(w, [{ x: 1150, y: 900, w: 40, h: 200 }]);
    const r = () => rand(w);
    const bot = spawnAt(w, 1000, 1000, { kind: 'bot', loadout: { weapon: 'assault' } });
    const foe = spawnAt(w, foeAt.x, foeAt.y, { kind: 'human', loadout: { armor: 'heavy' } });
    const mems = new Map<number, BotMemory>([[bot.id, newBotMemory(r)]]);
    const tick = (pin: boolean) => {
      let thought = false;
      thinkBots(w, mems, r, { respawn: false, onDecision: (_id, snap) => { thought ||= snap !== null; } });
      if (foe.life.k === 'alive') foe.life.hp = effectiveStats(foe).maxHp;
      step(w, TICK_MS);
      // Both stay where the test puts them, so only the wall stands between them.
      if (pin) { Object.assign(bot, { x: 1000, y: 1000 }); Object.assign(foe, foeAt); }
      return thought;
    };
    return { w, bot, foe, tick };
  };
  const thinks = (foeAt: { x: number; y: number }) => { const { tick } = setup(foeAt); return Array.from({ length: 90 }, () => tick(true)).filter(Boolean).length; };
  // A sighting that does not stand up to its think (no line after all) would wake it again every tick.
  const hidden = thinks({ x: 1400, y: 1000 });
  assert.ok(hidden < 90 / 3, `hidden in its view box he does not keep waking it: ${hidden} thinks in 90 ticks`);

  const { w, bot, foe, tick } = setup({ x: 1400, y: 1000 });
  for (let i = 0; i < 30; i++) tick(true);
  // Just past a scheduled think, he steps out from behind the wall.
  while ((w.tick + bot.id) % TACTICAL_TICKS !== 1) tick(true);
  foe.y = 1400;
  assert.equal(tick(false), true, 'it sees him the tick he has a line on it');
});

/** The flank harness's runs (scripts/lib/flank.ts): a human walks round a bot's cover, or steps out at its side, and fires. */
const runs = (scenario: 'cover' | 'side', guns: readonly WeaponId[]) =>
  guns.flatMap((gun) => PERSONALITY_IDS.flatMap((persona) => ([1, -1] as const).map((side) => ({ gun, persona, side, r: flank(scenario, gun, persona, 1, side) }))));

test('a bot flanked in cover turns, fires back and gets off its spot within a person\'s reaction, and does not stand there', () => {
  for (const { gun, persona, side, r } of runs('cover', ['pistol', 'smg', 'assault'])) {
    const at = `${gun} ${persona} side ${side}`;
    // He first has his line from about 410 px off its side (his camera leans toward it), just past its own 16:9 screen's 394: it sees him
    // as he steps onto its screen, or turns on his first round, nine or ten ticks on (seven while bots saw a square view).
    assert.ok(r.face !== null && r.face <= 334, `${at}: faces him ${r.face}ms after he has a line`);
    assert.ok(r.fire !== null && r.fire <= 600, `${at}: fires back ${r.fire}ms after`);
    assert.ok(r.move !== null && r.move <= 400, `${at}: off its spot ${r.move}ms after`);
    assert.ok((r.still ?? 1) <= 0.5, `${at}: stood still ${((r.still ?? 1) * 100).toFixed(0)}% of the next 2 s`);
  }
});

test('a bot holding a spot turns on an enemy who steps out at its side without a 180-degree snap, but well inside half a second', () => {
  for (const { gun, persona, side, r } of runs('side', ['pistol', 'assault'])) {
    const at = `${gun} ${persona} side ${side}`;
    // As above: he steps out about 410 px beside it, a few px off its 16:9 screen, so it takes him in a tick or two after he has his line.
    assert.ok(r.face !== null && r.face >= 150 && r.face <= 334, `${at}: faces him ${r.face}ms after he has a line`);
    assert.ok(r.fire !== null && r.fire <= 500, `${at}: fires ${r.fire}ms after`);
  }
});
