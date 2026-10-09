/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setInput, step } from '../src/shared/sim.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import type { Player, World } from '../src/shared/sim/world.ts';
import { arenaFor } from '../src/server/bot/arena.ts';
import { freshAwareness, perceive } from '../src/server/bot/awareness.ts';
import { botThink, newBotMemory, type BotMemory } from '../src/server/bots.ts';
import { bandFor, nextIntent, PERSONALITIES, startIntent, type IntentCtx, type Plan } from '../src/server/bot/intent.ts';
import { createWorld } from '../src/shared/sim/world.ts';
import { emptyWorld, setWalls, spawnAt, TICK_MS } from './helpers.ts';

const seeded = (seed: number) => { let x = seed; return () => ((x = (x * 16807) % 2147483647) / 2147483647); };
const gap = (a: Player, b: Player) => Math.hypot(a.x - b.x, a.y - b.y);

/** Drives `bots` for `ticks` (anyone else stands where they are). Their triggers are held, so a one-shot sniper cannot end the fight being watched. */
function play(w: World, bots: readonly Player[], persona: 'aggressive' | 'cautious' | 'marksman', ticks: number, onTick?: (i: number) => void, intents?: (Plan | null)[]) {
  const r = seeded(11);
  const mems = new Map<number, BotMemory>(bots.map((b, i) => {
    const mem = { ...newBotMemory(r), persona };
    return [b.id, intents?.[i] ? { ...mem, intent: startIntent(intents[i]!, { tick: 0, persona: PERSONALITIES[persona] } as IntentCtx) } : mem];
  }));
  for (let i = 0; i < ticks; i++) {
    for (const p of w.players.values()) if (p.life.k === 'alive') { p.life.hp = 100; if (bots.includes(p)) p.life.nextFireAt = Infinity; }
    for (const b of bots) {
      const d = botThink(snapshotFor(w, b.id), arenaFor(w), mems.get(b.id)!, r);
      mems.set(b.id, d.mem);
      setInput(w, b.id, i + 1, d.input);
    }
    step(w, TICK_MS);
    onTick?.(i);
  }
}

for (const [weapon, from] of [['assault', 110], ['sniper', 250], ['lmg', 120]] as const) {
  test(`a ${weapon} bot with an enemy inside its class band backs off to fight from the band, not at arm's length`, () => {
    const w = emptyWorld();
    const bot = spawnAt(w, 2000, 2000, { loadout: { weapon } });
    const foe = spawnAt(w, 2000 + from, 2000);
    const persona = 'cautious';
    const band = bandFor(bot.gun, PERSONALITIES[persona]);
    const close: number[] = [];
    play(w, [bot], persona, 150, (i) => { if (i >= 75) close.push(gap(bot, foe)); });
    const nearest = Math.min(...close);
    assert.ok(nearest >= band.hold * 0.8, `${weapon}: closest after settling ${Math.round(nearest)}px, wants >= ${Math.round(band.hold * 0.8)} (hold ${Math.round(band.hold)})`);
    assert.ok(Math.max(...close) <= band.max * 1.15, `${weapon}: stayed within reach of its gun`);
  });
}

test('a shotgun bot is not held off: it closes to its short band', () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 2000, 2000, { loadout: { weapon: 'shotgun' } });
  const foe = spawnAt(w, 2400, 2000);
  // Once in, it weaves to and fro about its band, so it is judged on where it stays over the last two seconds, not on one tick.
  const late: number[] = [];
  play(w, [bot], 'aggressive', 150, (i) => { if (i >= 90) late.push(gap(bot, foe)); });
  const band = bandFor(bot.gun, PERSONALITIES.aggressive), mean = late.reduce((a, b) => a + b, 0) / late.length;
  assert.ok(mean <= band.ideal * 1.3, `stayed ${Math.round(mean)}px off, ideal ${Math.round(band.ideal)}`);
});

test('two mates sent the same way spread out rather than walking in a stack', () => {
  const w = emptyWorld('TDM');
  const a = spawnAt(w, 1500, 2000, { team: 'red', loadout: { weapon: 'assault' } });
  const b = spawnAt(w, 1530, 2010, { team: 'red', loadout: { weapon: 'assault' } });
  const goal = { x: 3000, y: 2000 };
  let parted = 0;
  play(w, [a, b], 'cautious', 180, (i) => { if (i >= 60 && gap(a, b) >= 110) parted++; }, [{ k: 'patrol', goal }, { k: 'patrol', goal }]);
  assert.ok(parted >= 100, `mates were 110px or more apart for ${parted} of 120 ticks`);
});

test('mates standing on one spot with an enemy to fight step apart', () => {
  const w = emptyWorld('TDM');
  const a = spawnAt(w, 2000, 2000, { team: 'red', loadout: { weapon: 'assault' } });
  const b = spawnAt(w, 2020, 2000, { team: 'red', loadout: { weapon: 'assault' } });
  spawnAt(w, 2400, 2000, { team: 'blue' });
  let apart = 0;
  play(w, [a, b], 'cautious', 180, (i) => { if (i >= 120) apart += gap(a, b) >= 90 ? 1 : 0; });
  assert.ok(apart >= 45, `apart for ${apart} of the last 60 ticks`);
});

test('a bot outnumbered with nobody beside it falls back behind cover while hurt, but a bot with mates beside it stays in', () => {
  const w = emptyWorld('TDM');
  setWalls(w, [{ x: 700, y: 900, w: 40, h: 200 }]);
  const bot = spawnAt(w, 1000, 1000, { team: 'red', loadout: { weapon: 'assault' } });
  spawnAt(w, 1500, 950, { team: 'blue' });
  spawnAt(w, 1500, 1050, { team: 'blue' });
  if (bot.life.k !== 'alive') throw new Error('alive');
  bot.life.hp = 100 * 0.45;
  const persona = PERSONALITIES.cautious;
  const decide = () => {
    const snap = snapshotFor(w, bot.id);
    const me = snap.players.find((p) => p.id === bot.id)!;
    const { view } = perceive(snap, arenaFor(w), me, freshAwareness());
    const ctx: IntentCtx = { tick: snap.tick, persona, role: null, band: bandFor(view.me.gun, persona), arena: arenaFor(w), rand: seeded(3) };
    return nextIntent({ ...startIntent({ k: 'engage', target: 0 }, ctx), holdUntil: 0 }, view, ctx);
  };
  assert.equal(decide().k, 'retreatAndHeal', 'two on one, hurt: it breaks off');
  spawnAt(w, 1000, 1100, { team: 'red' });
  assert.notEqual(decide().k, 'retreatAndHeal', 'with a mate beside it the odds are even');
});

const hall = () => { const w = createWorld('TDM', 1, 'geo-test'); w.crates = []; w.barrels = []; w.props = []; return w; };
const ROOM3_DOOR = { x: 3525, y: 525 };

test('a bot holding a room against a foe at its door takes cover beside the door, not in its lane', () => {
  const w = hall();
  const bot = spawnAt(w, 3525, 800, { team: 'red', loadout: { weapon: 'assault' } });
  spawnAt(w, 3525, 380, { team: 'blue' });
  const persona = PERSONALITIES.cautious;
  const snap = snapshotFor(w, bot.id);
  const me = snap.players.find((p) => p.id === bot.id)!;
  const aware = { ...freshAwareness(), contacts: [{ id: 99, x: 3525, y: 380, seenTick: snap.tick - 40, gun: 'assault' as const }] };
  const { view } = perceive(snap, arenaFor(w), me, aware);
  const ctx: IntentCtx = { tick: snap.tick, persona, role: null, band: bandFor(view.me.gun, persona), arena: arenaFor(w), rand: () => 0.99 };
  const next = nextIntent({ ...startIntent({ k: 'engage', target: 99 }, ctx), holdUntil: 0 }, view, ctx);
  if (next.k !== 'takePosition') return assert.fail(`wanted to hold a position, got ${next.k}`);
  assert.ok(Math.abs(next.spot.x - ROOM3_DOOR.x) >= 120, `cover at x ${Math.round(next.spot.x)} is in the door's lane (door at ${ROOM3_DOOR.x})`);
  assert.ok(Math.hypot(next.spot.x - ROOM3_DOOR.x, next.spot.y - ROOM3_DOOR.y) >= 110, 'and not in the doorway');
});

test('two mates clearing a room go through its door one after the other, not side by side in the doorway', () => {
  const w = hall();
  const a = spawnAt(w, 3490, 400, { team: 'red', loadout: { weapon: 'assault' } });
  const b = spawnAt(w, 3560, 400, { team: 'red', loadout: { weapon: 'assault' } });
  const goal = { x: 3525, y: 800 };
  let together = 0, through = 0;
  play(w, [a, b], 'cautious', 300, () => {
    const near = (p: Player) => Math.hypot(p.x - ROOM3_DOOR.x, p.y - ROOM3_DOOR.y) < 90;
    if (near(a) && near(b)) together++;
    if (a.y > 600 || b.y > 600) through++;
  }, [{ k: 'search', at: goal, giveUpAt: 1e9 }, { k: 'search', at: goal, giveUpAt: 1e9 }]);
  assert.ok(through > 0, 'someone got through the door');
  assert.ok(together <= 6, `both in the doorway together for ${together} ticks`);
});
