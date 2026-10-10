import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUN_IDS, GUNS, WORLD, type GunId } from '../src/shared/defs.ts';
import { DEFAULT_VIEW_ASPECT, VIEW_PRELOAD_MARGIN, viewExtents } from '../src/shared/protocol.ts';
import { lookReach, sightBox } from '../src/shared/lookahead.ts';
import { interestLook, snapshotFor } from '../src/shared/sim/snapshot.ts';
import { effectiveStats } from '../src/shared/sim/stats.ts';
import { BOT_EARSHOT_PX, botEarshot, BOT_HEARING, earDist } from '../src/shared/sim/hearing.ts';
import { arenaFor } from '../src/server/bot/arena.ts';
import { aimsAtLead, botSight, freshAwareness, perceive } from '../src/server/bot/awareness.ts';
import { botSnapshot } from '../src/server/bot/tick.ts';
import { bandFor, nextIntent, PERSONALITIES, startIntent, type IntentCtx } from '../src/server/bot/intent.ts';
import type { ChosenPerks, Player, World } from '../src/shared/sim/world.ts';
import { emptyWorld, equip, spawnAt } from './helpers.ts';

/** The enemies a bot at `bot` sees on a think, by id, as the server's bot tick gives it its snapshot. */
const seenBy = (w: World, bot: Player): number[] => {
  const snap = botSnapshot(w, bot.id, []);
  return perceive(snap, arenaFor(w), snap.players.find((p) => p.id === bot.id)!, freshAwareness()).view.threats.map((t) => t.p.id);
};

const KITS: [GunId, ChosenPerks][] = [['pistol', {}], ['assault', {}], ['sniper', {}], ['piercer', { 1: 'optics', 2: 'recon' }], ['scout', { 1: 'optics', 2: 'recon' }], ['minigun', { 2: 'recon' }]];

test("a bot sees what a person's 16:9 screen leaned toward its aim shows: not 600 px beside itself, but far down its aim at its scoped range", () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 3000, 3000, { kind: 'bot' });
  equip(bot, 'piercer');
  bot.perks = { 1: 'optics', 2: 'recon' };
  bot.angle = 0;
  const R = effectiveStats(bot).viewRadius, reach = lookReach(R, bot.gun);
  assert.ok(R > WORLD.viewRadius * 1.3, `a fully scoped sniper (${Math.round(R)} px)`);
  const beside = spawnAt(w, 3000, 3600), above = spawnAt(w, 3000 - 100, 3000 - 600), behind = spawnAt(w, 3000 - R - 60, 3000);
  const downAim = spawnAt(w, 3000 + R + reach - 40, 3000 + 100), past = spawnAt(w, 3000 + R + reach + 120, 3000);
  const seen = seenBy(w, bot);
  assert.ok(!seen.includes(beside.id), 'directly beside it, 600 px down, while it aims along the x axis: off its screen');
  assert.ok(!seen.includes(above.id), 'nor 600 px up');
  assert.ok(!seen.includes(behind.id), `nor past its view radius behind it (${Math.round(R)} px)`);
  assert.ok(seen.includes(downAim.id), `down its aim at its scoped range (${Math.round(R + reach)} px) it sees him`);
  assert.ok(!seen.includes(past.id), 'but no further');
  // Turned to face him, the one beside it comes into its sight: it has to turn to see.
  bot.angle = Math.PI / 2;
  assert.ok(seenBy(w, bot).includes(beside.id), 'once it turns his way');
});

test("sniper bots have no bigger vertical sight than a person: beside its aim every bot sees the 16:9 screen's half height", () => {
  for (const [gun, perks] of KITS) {
    const w = emptyWorld();
    const bot = spawnAt(w, 3000, 3000, { kind: 'bot' });
    bot.gun = gun;
    bot.perks = { ...perks };
    const R = effectiveStats(bot).viewRadius, halfH = viewExtents(R, DEFAULT_VIEW_ASPECT).halfH;
    for (const angle of [0, Math.PI]) {
      const box = botSight(R, gun, angle);
      assert.ok(Math.abs(box.u - halfH) < 1e-6 && Math.abs(box.d - halfH) < 1e-6, `${gun} aiming along x: ${box.u}/${box.d} up and down, a person's ${halfH}`);
      assert.ok(box.u < R * 0.6, `${gun}: well short of the old square view's ${Math.round(R)} px`);
    }
  }
  // The widest any bot sees beside its aim is a fully scoped sniper's: a person with the same kit sees the same.
  assert.ok(viewExtents(WORLD.viewRadius * 1.45, DEFAULT_VIEW_ASPECT).halfH < 600);
});

test("parity: a bot's sight box is the box a person with the same gun, perks and aim is sent, and it sees exactly the enemies that person's snapshot holds", () => {
  for (const [gun, perks] of KITS) {
    for (const angle of [0, 0.7, Math.PI / 2, 2.4, -2.9, -Math.PI / 2]) {
      const w = emptyWorld();
      const person = spawnAt(w, 1500, 1500, { kind: 'human' });
      const bot = spawnAt(w, 4500, 4500, { kind: 'bot' });
      for (const p of [person, bot]) { p.gun = gun; p.perks = { ...perks }; p.angle = angle; }
      const R = effectiveStats(person).viewRadius;
      const theirs = sightBox(viewExtents(R, DEFAULT_VIEW_ASPECT), interestLook(w, person));
      const mine = botSight(effectiveStats(bot).viewRadius, bot.gun, bot.angle);
      for (const k of ['l', 'r', 'u', 'd'] as const) assert.ok(Math.abs(mine[k] - theirs[k]) < 1e-9, `${gun} at ${angle}: ${k} ${mine[k]} vs ${theirs[k]}`);
    }
  }
  // End to end: enemies round each on a grid; whatever the person's snapshot holds (well inside its preload margin) the bot sees, and the
  // bot sees nobody that snapshot leaves out.
  for (const [gun, perks] of [KITS[1]!, KITS[3]!]) {
    const angle = 0.5;
    const pw = emptyWorld(), bw = emptyWorld();
    const person = spawnAt(pw, 3000, 3000, { kind: 'human' }), bot = spawnAt(bw, 3000, 3000, { kind: 'bot' });
    for (const p of [person, bot]) { p.gun = gun; p.perks = { ...perks }; p.angle = angle; }
    const box = botSight(effectiveStats(bot).viewRadius, gun, angle), slack = VIEW_PRELOAD_MARGIN + WORLD.playerRadius;
    const offsets: { dx: number; dy: number }[] = [];
    for (let dx = -2200; dx <= 2200; dx += 170) for (let dy = -1400; dy <= 1400; dy += 170) {
      const band = (v: number, lo: number, hi: number) => (v > hi && v <= hi + slack) || (v < -lo && v >= -lo - slack);
      if (Math.hypot(dx, dy) < 100 || band(dx, box.l, box.r) || band(dy, box.u, box.d)) continue;
      offsets.push({ dx, dy });
    }
    const pIds = offsets.map(({ dx, dy }) => spawnAt(pw, 3000 + dx, 3000 + dy).id);
    const bIds = offsets.map(({ dx, dy }) => spawnAt(bw, 3000 + dx, 3000 + dy).id);
    const sent = new Set(snapshotFor(pw, person.id, [], DEFAULT_VIEW_ASPECT, interestLook(pw, person)).players.map((p) => p.id));
    const seen = new Set(seenBy(bw, bot));
    let shown = 0;
    offsets.forEach((o, i) => {
      assert.equal(seen.has(bIds[i]!), sent.has(pIds[i]!), `${gun}: an enemy at (${o.dx}, ${o.dy}): the person ${sent.has(pIds[i]!) ? 'is' : 'is not'} sent him`);
      if (sent.has(pIds[i]!)) shown++;
    });
    assert.ok(shown > 20 && shown < offsets.length - 20, `${gun}: a real test (${shown} of ${offsets.length} on screen)`);
  }
});

test("a bot's ears are its own, not its scope's: a sniper hears no further than anyone, and aims only at what it heard without the loud bonus", () => {
  const shot = (gun: GunId, silenced = false) => ({ e: 'shot' as const, x: 0, y: 0, angle: 0, silenced, owner: 1, gun });
  assert.equal(botEarshot(shot('assault')), WORLD.viewRadius * BOT_HEARING.earshotMul);
  assert.equal(BOT_EARSHOT_PX, WORLD.viewRadius * BOT_HEARING.earshotMul, 'scaled to the base view, whatever the listener carries');
  assert.ok(botEarshot(shot('sniper')) <= WORLD.viewRadius * 3.1, `a loud gun carries at most about three base views (${botEarshot(shot('sniper'))})`);
  assert.equal(botEarshot(shot('ghost', true)), BOT_HEARING.silencedPx);
  for (const id of GUN_IDS) if (!GUNS[id].silenced) assert.ok(botEarshot(shot(id)) < 3000, `${id}: half the map is out of earshot`);
  // A sniper bot and an assault bot hear the same shot alike.
  const heard = (gun: GunId) => {
    const w = emptyWorld();
    const bot = spawnAt(w, 1000, 1000, { kind: 'bot' });
    equip(bot, gun);
    bot.perks = gun === 'piercer' ? { 1: 'optics', 2: 'recon' } : {};
    const shooter = spawnAt(w, 1000, 1000 + BOT_EARSHOT_PX + 200);
    return snapshotFor(w, bot.id, [{ ...shot('assault'), x: shooter.x, y: shooter.y, owner: shooter.id }]).heard?.length ?? 0;
  };
  assert.equal(heard('assault'), 0);
  assert.equal(heard('piercer'), 0, 'a fully scoped sniper bot did hear it (2436 px) before');
  assert.ok(aimsAtLead({ x: 1000 + BOT_EARSHOT_PX - 10, y: 1000 }, { x: 1000, y: 1000 }));
  assert.ok(!aimsAtLead({ x: 1000 + BOT_EARSHOT_PX + 10, y: 1000 }, { x: 1000, y: 1000 }), 'a shot placed only by the loud bonus is somewhere to go, not to aim');
  assert.ok(!aimsAtLead(null, { x: 0, y: 0 }));
});

test('an enemy it sees down its aim past its gun\'s reach is gone in on, not poked at from cover (two bots once peeked at each other from 1000 px for good)', () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { kind: 'bot', loadout: { weapon: 'assault' } });
  bot.angle = 0;
  const far = spawnAt(w, 1000 + GUNS.assault.range + 150, 1000);
  const snap = botSnapshot(w, bot.id, []);
  const v = perceive(snap, arenaFor(w), snap.players.find((p) => p.id === bot.id)!, freshAwareness()).view;
  assert.equal(v.threats[0]?.p.id, far.id, `it sees him ${GUNS.assault.range + 150} px down its aim`);
  const persona = PERSONALITIES.cautious;
  const ctx: IntentCtx = { tick: v.tick, persona, role: null, band: bandFor('assault', persona), arena: arenaFor(w), rand: () => 0.5, strategic: false };
  const peek = startIntent({ k: 'peekAndHide', target: far.id, spot: { x: 1000, y: 1000 }, peek: { x: 1000, y: 1060 }, phase: 'peek', phaseUntil: 1e9 }, ctx);
  const next = nextIntent(peek, v, ctx);
  assert.equal(next.k, 'engage', `out of reach it goes in: ${JSON.stringify(next)}`);
});

test('vertical parity: an enemy 450 px straight above a bot aiming sideways is neither seen nor known; 450 px to the side, down its aim, he is seen', () => {
  const look = (dx: number, dy: number) => {
    const w = emptyWorld();
    const bot = spawnAt(w, 3000, 3000, { kind: 'bot', loadout: { weapon: 'assault' } });
    bot.angle = 0;
    const foe = spawnAt(w, 3000 + dx, 3000 + dy);
    const snap = botSnapshot(w, bot.id, []);
    const { view, awareness } = perceive(snap, arenaFor(w), snap.players.find((p) => p.id === bot.id)!, freshAwareness());
    return { seen: view.threats.some((t) => t.p.id === foe.id), known: awareness.contacts.some((c) => c.id === foe.id) || view.lastSeen?.id === foe.id };
  };
  assert.deepEqual(look(0, -450), { seen: false, known: false }, 'straight above, off its 16:9 screen');
  assert.deepEqual(look(0, 450), { seen: false, known: false }, 'straight below');
  assert.deepEqual(look(450, 0), { seen: true, known: true }, 'to the side, down its aim');
});

test('vertical parity: a bot hears in its screen\'s shape, as far to the side as ever but only 1/1.78 of that above or below', () => {
  const heard = (dx: number, dy: number) => {
    const w = emptyWorld();
    const bot = spawnAt(w, 3000, 3000, { kind: 'bot' });
    const shooter = spawnAt(w, 3000 + dx, 3000 + dy);
    return (snapshotFor(w, bot.id, [{ e: 'shot' as const, x: shooter.x, y: shooter.y, angle: 0, silenced: false, owner: shooter.id, gun: 'assault' as const }]).heard?.length ?? 0) > 0;
  };
  assert.ok(heard(1500, 0), 'a shot 1500 px to the side is heard');
  assert.ok(!heard(0, 1500), 'one 1500 px straight below is not');
  assert.ok(heard(0, 900), 'one 900 px below is');
  assert.ok(Math.abs(earDist(0, 100) - 100 * DEFAULT_VIEW_ASPECT) < 1e-9 && earDist(100, 0) === 100);
  assert.ok(!aimsAtLead({ x: 0, y: BOT_EARSHOT_PX * 0.7 }, { x: 0, y: 0 }), 'nor does it aim at a lead far above it');
});
