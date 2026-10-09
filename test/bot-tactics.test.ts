/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setInput, step } from '../src/shared/sim.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import type { Player, World } from '../src/shared/sim/world.ts';
import { BOT_VIEW_ASPECT } from '../src/shared/protocol.ts';
import { botThink, newBotMemory, type BotMemory } from '../src/server/bots.ts';
import { arenaFor } from '../src/server/bot/arena.ts';
import { freshAwareness, perceive, type Awareness } from '../src/server/bot/awareness.ts';
import { bandFor, nextIntent, PERSONALITIES, startIntent, type Intent, type IntentCtx, type Personality, type Plan } from '../src/server/bot/intent.ts';
import { clearShot } from '../src/server/bot/nav.ts';
import { readTactics, type Sighting } from '../src/server/bot/tactics.ts';
import { freezeScan } from '../scripts/lib/freeze.ts';
import { emptyWorld, setWalls, spawnAt, TICK_MS } from './helpers.ts';

const seeded = (seed: number) => { let x = seed; return () => ((x = (x * 16807) % 2147483647) / 2147483647); };
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const bearing = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.atan2(b.y - a.y, b.x - a.x);

/** One think, as `botThink` makes it (sightings and all), with `seen` laid over what it read, on a reacting think unless `strategic`. */
function decide(w: World, id: number, cur: Plan | Intent, opts: { persona?: Personality; seen?: Sighting[]; strategic?: boolean; aware?: Awareness } = {}): Intent {
  const persona = opts.persona ?? PERSONALITIES.cautious;
  const snap = snapshotFor(w, id, w.events, BOT_VIEW_ASPECT);
  const me = snap.players.find((p) => p.id === id)!;
  const { view: raw, awareness } = perceive(snap, arenaFor(w), me, opts.aware ?? freshAwareness());
  const read = readTactics(null, raw, awareness);
  const tac = { ...read.tactics, seen: [...read.tactics.seen, ...(opts.seen ?? [])] };
  const ctx: IntentCtx = { tick: snap.tick, persona, role: null, band: bandFor(raw.me.gun, persona), arena: arenaFor(w), rand: seeded(3), strategic: opts.strategic ?? false, tac };
  const intent = 'since' in cur ? cur : startIntent(cur, ctx);
  return nextIntent(intent, read.view, ctx);
}

const face = (p: Player, at: { x: number; y: number }) => { p.angle = bearing(p, at); p.input.angle = p.angle; };
const setHp = (p: Player, frac: number) => { if (p.life.k === 'alive') p.life.hp = p.life.hp * frac; };

/** Cover east of a bot at (1000, 1000) from an enemy at (1500, 1000): its spot is hidden from him, and its peek a step south is in his sight. */
const coverEast = { x: 1040, y: 900, w: 30, h: 130 };
const PEEK = { x: 1000, y: 1080 };
type Hiding = Extract<Intent, { k: 'peekAndHide' }>;
const hiding = (target: number, tick: number): Extract<Plan, { k: 'peekAndHide' }> => ({ k: 'peekAndHide', target, spot: { x: 1000, y: 1000 }, peek: PEEK, phase: 'hide', phaseUntil: tick - 1 });

test('a bot does not peek into an angle the enemy holds: it waits him out, then goes round another way', () => {
  const w = emptyWorld();
  setWalls(w, [coverEast]);
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  const foe = spawnAt(w, 1500, 1000);
  const tick = w.tick;
  const sighting = (angle: number): Sighting => ({ id: foe.id, x: foe.x, y: foe.y, angle, still: true, tick, reloadEnd: null, gun: 'pistol' });
  const held = sighting(bearing(foe, PEEK));
  const cur = startIntent(hiding(foe.id, tick), { tick: tick - 90, persona: PERSONALITIES.cautious } as IntentCtx) as Hiding;
  const wait = decide(w, bot.id, cur, { seen: [held] });
  assert.ok(wait.k === 'peekAndHide' && wait.phase === 'hide' && wait.waits === 1 && wait.phaseUntil > tick, `stays in cover: ${JSON.stringify(wait)}`);
  const round = decide(w, bot.id, { ...cur, waits: 2 }, { seen: [held] });
  assert.equal(round.k, 'flank', 'after waiting him out twice it flanks');
  const free = decide(w, bot.id, cur, { seen: [sighting(bearing(foe, PEEK) + 0.8)] });
  assert.ok(free.k === 'peekAndHide' && free.phase === 'peek', 'an angle he does not hold is peeked as usual');
  const moving = decide(w, bot.id, cur, { seen: [{ ...held, still: false }] });
  assert.ok(moving.k === 'peekAndHide' && moving.phase === 'peek', 'one on the move holds nothing');
});

test('a bot that saw its enemy start a reload cuts its hide short and peeks to punish it', () => {
  const w = emptyWorld();
  setWalls(w, [coverEast]);
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  const foe = spawnAt(w, 1500, 1000);
  const tick = w.tick;
  const cur = startIntent({ ...hiding(foe.id, tick), phaseUntil: tick + 60 }, { tick: tick - 30, persona: PERSONALITIES.cautious } as IntentCtx) as Hiding;
  const reloading: Sighting = { id: foe.id, x: foe.x, y: foe.y, angle: Math.PI, still: false, tick, reloadEnd: tick + 45, gun: 'pistol' };
  const next = decide(w, bot.id, cur, { seen: [reloading] });
  assert.ok(next.k === 'peekAndHide' && next.phase === 'peek', `peeks at once: ${JSON.stringify(next)}`);
  const calm = decide(w, bot.id, cur, { seen: [{ ...reloading, reloadEnd: null }] });
  assert.ok(calm.k === 'peekAndHide' && calm.phase === 'hide', 'without a reload to catch it hides its full time');
});

test('a bot does not walk into a fight it would lose: it holds an angle from cover instead, and takes the one it would win', () => {
  const w = emptyWorld();
  setWalls(w, [{ x: 1080, y: 950, w: 40, h: 250 }]);
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'pistol' } });
  const foe = spawnAt(w, 1400, 700, { loadout: { weapon: 'assault' } });
  face(foe, bot);
  setHp(bot, 0.35);
  const bad = decide(w, bot.id, { k: 'patrol', goal: { x: 400, y: 400 } });
  assert.equal(bad.k, 'hold', `hurt, with a pistol against a rifle aimed at it: ${bad.k}`);
  assert.ok(bad.k === 'hold' && bad.target === foe.id && Math.abs(wrap(bearing(bad.spot, foe) - bearing(bad.spot, bad.watch))) < 0.2, 'it watches him');
  setHp(bot, 1 / 0.35);
  setHp(foe, 0.25);
  const good = decide(w, bot.id, { k: 'patrol', goal: { x: 400, y: 400 } });
  assert.equal(good.k, 'engage', 'against one nearly dead it fights');
  setHp(bot, 0.35);
  setHp(foe, 4);
  const careful = decide(w, bot.id, { k: 'patrol', goal: { x: 400, y: 400 } }, { persona: PERSONALITIES.cautious });
  assert.ok(PERSONALITIES.aggressive.takesOdds < PERSONALITIES.cautious.takesOdds, 'a hothead takes worse odds than a careful bot');
  assert.equal(careful.k, 'hold');
});

test('a bot in a fair 1v1 backs off to cover when a second enemy comes up on it, rather than fight one with another in its side', () => {
  const w = emptyWorld();
  setWalls(w, [{ x: 1080, y: 950, w: 40, h: 250 }]);
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  const a = spawnAt(w, 1450, 650, { loadout: { weapon: 'assault' } });
  face(a, bot);
  face(bot, a);
  const fight = startIntent({ k: 'engage', target: a.id }, { tick: w.tick, persona: PERSONALITIES.cautious } as IntentCtx);
  const one = decide(w, bot.id, { ...fight, holdUntil: Infinity });
  assert.equal(one.k, 'engage', 'one on one, even: it fights');
  const b = spawnAt(w, 1250, 600, { loadout: { weapon: 'assault' } });
  face(b, bot);
  const two = decide(w, bot.id, { ...fight, holdUntil: Infinity });
  assert.equal(two.k, 'hold', `a second one coming up on it: ${two.k}`);
  assert.ok(two.k === 'hold' && [a, b].every((p) => !clearShot(arenaFor(w).sightWalls, two.spot, p)), `hidden from both: ${JSON.stringify(two)}`);
  // Finishing one nearly dead is worth it, whoever is coming.
  setHp(a, 0.08);
  const finish = decide(w, bot.id, { ...fight, holdUntil: Infinity });
  assert.equal(finish.k, 'engage', 'it finishes the one nearly dead');
});

/**
 * A bot east of a wall saw an enemy go behind it, near its north end: it keeps its gun on that corner, and when he steps back out there it
 * takes him in sooner (its reaction, from sighting to aimed fire) than when he steps out at the far end, where it was not looking.
 */
function corner(seed: number, comeBack: { x: number; y: number }): { offEdge: number; reactMs: number | null } {
  const w = emptyWorld();
  setWalls(w, [{ x: 1300, y: 800, w: 30, h: 400 }]);
  const bot = spawnAt(w, 1600, 1000, { loadout: { weapon: 'assault' } });
  const foe = spawnAt(w, 1150, 880, { kind: 'human' });
  const full = foe.life.k === 'alive' ? foe.life.hp : 0;
  const r = seeded(seed);
  const hold = startIntent({ k: 'hold', target: foe.id, spot: { x: bot.x, y: bot.y }, watch: { x: foe.x, y: foe.y }, until: Infinity }, { tick: w.tick, persona: PERSONALITIES.cautious } as IntentCtx);
  const sighting: Sighting = { id: foe.id, x: foe.x, y: foe.y, angle: Math.PI / 2, still: false, tick: w.tick, reloadEnd: null, gun: foe.gun };
  const fresh = newBotMemory(r);
  let mem: BotMemory = {
    ...fresh, persona: 'cautious', intent: { ...hold, holdUntil: Infinity },
    awareness: { ...fresh.awareness, contacts: [{ id: foe.id, x: foe.x, y: foe.y, seenTick: w.tick, gun: foe.gun }] }, tactics: { seen: [sighting], watch: null },
  };
  let reactMs: number | null = null, offEdge = 0;
  for (let i = 1; i <= 100; i++) {
    if (foe.life.k === 'alive') foe.life.hp = full;
    if (i === 40) { foe.x = comeBack.x; foe.y = comeBack.y; }
    const d = botThink(snapshotFor(w, bot.id, w.events, BOT_VIEW_ASPECT), arenaFor(w), mem, r);
    mem = d.mem;
    setInput(w, bot.id, i, d.input);
    step(w, TICK_MS);
    if (i === 39) offEdge = Math.abs(wrap(bot.angle - bearing(bot, { x: 1315, y: 800 })));
    const e = mem.motor.engaged;
    if (i >= 40 && reactMs === null && e?.id === foe.id && e.acquiredTick >= w.tick - 1) reactMs = (e.noticeAtTick - e.acquiredTick) * TICK_MS;
  }
  return { offEdge, reactMs };
}

test('a bot pre-aims the corner an enemy went behind, and takes him in sooner when he steps back out there', () => {
  const watched: number[] = [], unwatched: number[] = [];
  for (let seed = 1; seed <= 8; seed++) {
    const back = corner(seed, { x: 1250, y: 700 });
    assert.ok(back.offEdge < (12 * Math.PI) / 180, `seed ${seed}: its gun is on the corner he went behind, ${(back.offEdge * 180 / Math.PI).toFixed(0)} degrees off`);
    const other = corner(seed, { x: 1150, y: 1350 });
    assert.ok(back.reactMs !== null && other.reactMs !== null, `seed ${seed}: sees him both times`);
    watched.push(back.reactMs!);
    unwatched.push(other.reactMs!);
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean(watched) < 0.75 * mean(unwatched), `pre-aimed ${mean(watched).toFixed(0)} ms vs off-angle ${mean(unwatched).toFixed(0)} ms to take him in`);
});

test('a bot with a threat about keeps its gun on him from cover rather than standing frozen facing away', () => {
  const r = freezeScan('TDM', 'plaza', 3, 45);
  const longest = r.freezes.reduce((m, f) => Math.max(m, f.ms), 0);
  assert.ok(longest < 2500, `longest freeze ${longest.toFixed(0)} ms`);
  assert.ok(r.frozenMs / (r.botMs / 60_000) < 300, `${(r.frozenMs / (r.botMs / 60_000)).toFixed(0)} ms frozen a bot-minute`);
  assert.ok(r.facingMs / r.threatMs > 0.9, `faces a known threat ${(100 * r.facingMs / r.threatMs).toFixed(0)}% of the time`);
});
