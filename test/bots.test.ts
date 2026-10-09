/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUNS, WORLD, type PerkId, type WeaponId } from '../src/shared/defs.ts';
import type { InputState, WallView } from '../src/shared/protocol.ts';
import { setInput, step } from '../src/shared/sim.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { botName, botThink, newBotMemory, type BotMemory } from '../src/server/bots.ts';
import { arenaFor } from '../src/server/bot/arena.ts';
import type { PersonalityId } from '../src/server/bot/intent.ts';
import { emptyWorld, equip, grantPerks, setWalls, spawnAt } from './helpers.ts';

const rand = (() => { let x = 7; return () => ((x = (x * 16807) % 2147483647) / 2147483647); })();

const TICK_MS = 1000 / 30;
const seeded = (seed: number) => { let x = seed; return () => ((x = (x * 16807) % 2147483647) / 2147483647); };

type Look = { tick: number; angle: number; fire: boolean; bearing: number; leadAngle: number };

function watch(opts: { seed: number; ticks: number; weapon?: WeaponId; targetAt: { x: number; y: number }; targetVel?: { x: number; y: number }; walls?: (tick: number) => WallView[] }): Look[] {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: opts.weapon ?? 'assault' } });
  const target = spawnAt(w, opts.targetAt.x, opts.targetAt.y);
  const vel = opts.targetVel ?? { x: 0, y: 0 };
  const r = seeded(opts.seed);
  let mem = newBotMemory(r);
  const looks: Look[] = [];
  for (let i = 0; i < opts.ticks; i++) {
    if (opts.walls) setWalls(w, opts.walls(i));
    const d = botThink(snapshotFor(w, bot.id), arenaFor(w), mem, r);
    mem = d.mem;
    const flight = Math.hypot(target.x - bot.x, target.y - bot.y) / GUNS[bot.loadout.weapon].bulletSpeed;
    const leadAngle = Math.atan2(target.y + vel.y * flight - bot.y, target.x + vel.x * flight - bot.x);
    looks.push({ tick: i, angle: d.input.angle, fire: d.input.fire, bearing: Math.atan2(target.y - bot.y, target.x - bot.x), leadAngle });
    target.x += vel.x * TICK_MS / 1000;
    target.y += vel.y * TICK_MS / 1000;
    step(w, TICK_MS);
  }
  return looks;
}

const rms = (xs: number[]) => Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length);
const aimErrors = (looks: Look[], from: number, to: number) => looks.slice(from, to).map((l) => Math.atan2(Math.sin(l.angle - l.leadAngle), Math.cos(l.angle - l.leadAngle)));

test('a bot holds fire at an enemy behind a wall and fires once it can see them', () => {
  const wall: WallView = { x: 1180, y: 900, w: 40, h: 200, built: false, material: 'concrete' };
  const looks = watch({ seed: 3, ticks: 60, targetAt: { x: 1400, y: 1000 }, walls: (i) => (i < 30 ? [wall] : []) });
  assert.ok(looks.slice(0, 30).every((l) => !l.fire), 'no shots into the wall');
  assert.ok(looks.slice(30).some((l) => l.fire), 'fires with a clear line');
});

test('a bot waits a human-like reaction time after first seeing an enemy before it fires', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const firstFire = watch({ seed, ticks: 30, targetAt: { x: 1400, y: 1000 } }).find((l) => l.fire);
    assert.ok(firstFire, `seed ${seed}: fires eventually`);
    const ms = firstFire.tick * TICK_MS;
    // 220-350 ms, by temper: a hothead's quickest is 0.8 of that (`Personality.reactMul`).
    assert.ok(ms >= 0.8 * 220 - TICK_MS / 2 && ms <= 400 + TICK_MS, `seed ${seed}: first shot after ${ms.toFixed(0)}ms`);
  }
});

test('a bot misses a fast-strafing target by more than a still one', () => {
  const still: number[] = [], strafing: number[] = [];
  for (let seed = 1; seed <= 20; seed++) {
    still.push(...aimErrors(watch({ seed, ticks: 90, targetAt: { x: 1500, y: 1000 } }), 45, 90));
    strafing.push(...aimErrors(watch({ seed, ticks: 90, targetAt: { x: 1500, y: 700 }, targetVel: { x: 0, y: 300 } }), 45, 90));
  }
  assert.ok(rms(strafing) > 2 * rms(still), `strafing ${rms(strafing).toFixed(3)} rad vs still ${rms(still).toFixed(3)} rad`);
});

test('a bot aims more steadily the longer it tracks the same target', () => {
  const early: number[] = [], late: number[] = [];
  for (let seed = 1; seed <= 40; seed++) {
    const looks = watch({ seed, ticks: 90, targetAt: { x: 1500, y: 1000 } });
    const first = looks.findIndex((l) => l.fire);
    early.push(...aimErrors(looks, first, first + 10));
    late.push(...aimErrors(looks, 60, 90));
  }
  assert.ok(rms(early) > 1.5 * rms(late), `first 300ms of fire ${rms(early).toFixed(3)} rad vs after 2s ${rms(late).toFixed(3)} rad`);
});

test('a bot ignores an enemy in the snapshot preload margin beyond its 16:9 view', () => {
  const looks = watch({ seed: 5, ticks: 30, weapon: 'sniper', targetAt: { x: 1000, y: 1000 + WORLD.viewRadius + 30 } });
  assert.ok(looks.every((l) => !l.fire), 'never fires at what a player there could not see');
});

/** A bot of `persona` at (1000, 1000) fighting a still enemy 400px right in the open, both kept at full health, its inputs fed to the sim. */
function duel(persona: PersonalityId, seed: number, ticks: number, perks: PerkId[] = [], weapon: WeaponId = 'assault'): InputState[] {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon } });
  if (perks.length) grantPerks(w, bot, perks);
  const enemy = spawnAt(w, 1400, 1000);
  const r = seeded(seed);
  let mem: BotMemory = { ...newBotMemory(r), persona };
  const out: InputState[] = [];
  for (let i = 0; i < ticks; i++) {
    for (const p of [bot, enemy]) if (p.life.k === 'alive') p.life.hp = 100;
    const d = botThink(snapshotFor(w, bot.id), arenaFor(w), mem, r);
    mem = d.mem;
    setInput(w, bot.id, i + 1, d.input);
    out.push(d.input);
    step(w, TICK_MS);
  }
  return out;
}

const moving = (i: InputState) => i.up || i.down || i.left || i.right;
const keysOf = (i: InputState) => `${+i.up}${+i.down}${+i.left}${+i.right}`;

/** The share of its fire ticks a bot spends standing still, past its first half second (its first look, before its first strafe leg). */
const stillShare = (runs: InputState[][]) => {
  const shots = runs.flatMap((r) => r.slice(15)).filter((i) => i.fire);
  return shots.filter((i) => !moving(i)).length / shots.length;
};

test('assault bots strafe while they shoot, LMG bots strafe up close and plant out at their lane\'s length, and sniper bots plant', () => {
  for (const persona of ['aggressive', 'cautious', 'marksman'] as const) {
    const still = stillShare(Array.from({ length: 10 }, (_, s) => duel(persona, s + 1, 100, [], 'assault')));
    assert.ok(still < 0.1, `${persona}: ${(100 * still).toFixed(0)}% of assault shots fired standing still`);
  }
  const close = stillShare(Array.from({ length: 10 }, (_, s) => duel('aggressive', s + 1, 100, [], 'lmg')));
  assert.ok(close < 0.1, `${(100 * close).toFixed(0)}% of an aggressive LMG's shots at 100px fired standing still`);
  const far = stillShare(Array.from({ length: 10 }, (_, s) => duel('cautious', s + 1, 600, [], 'lmg')));
  assert.ok(far > 0.5, `${(100 * far).toFixed(0)}% of LMG shots at 600px fired standing still`);
  const planted = stillShare(Array.from({ length: 10 }, (_, s) => duel('cautious', s + 1, 150, [], 'sniper')));
  assert.ok(planted > 0.6, `${(100 * planted).toFixed(0)}% of sniper shots fired standing still`);
});

test('a strafing bot holds each leg\'s keys for at least a third of a second', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const keys = duel('aggressive', seed, 150).map(keysOf);
    const legs: number[] = [];
    for (let i = 1, run = 1; i <= keys.length; i++) {
      if (keys[i] === keys[i - 1]) run++;
      else { legs.push(run); run = 1; }
    }
    const short = legs.slice(1, -1).filter((n) => n < 10);
    assert.deepEqual(short, [], `seed ${seed}: legs of ${legs.join(', ')} ticks`);
  }
});

test('a bot\'s movement keys hold for a while instead of flickering tick to tick', () => {
  for (const persona of ['aggressive', 'cautious', 'marksman'] as const) {
    for (let seed = 1; seed <= 5; seed++) {
      const inputs = duel(persona, seed, 150);
      const changes = inputs.slice(1).filter((i, k) => keysOf(i) !== keysOf(inputs[k]!)).length;
      assert.ok(changes <= 12, `${persona} seed ${seed}: ${changes} key changes in 5s`);
    }
  }
});

test('a bot stepping out from cover onto the target it hid from fires at once, while one meeting it again in the open reacts afresh', () => {
  const firstShot = (k: 'peekAndHide' | 'engage') => {
    const w = emptyWorld();
    // Its spot is behind a wall from him; its peek, a step south, is not.
    setWalls(w, [{ x: 1040, y: 850, w: 30, h: 120 }]);
    const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
    const enemy = spawnAt(w, 1400, 1000);
    for (let i = 0; i < 90; i++) step(w, TICK_MS);
    const r = seeded(4);
    const mem = newBotMemory(r);
    const plan = k === 'peekAndHide'
      ? { k, target: enemy.id, spot: { x: 1000, y: 940 }, peek: { x: 1000, y: 1000 }, phase: 'peek' as const, phaseUntil: 1e9 }
      : { k, target: enemy.id };
    const lostLongAgo = { ...mem.motor, engaged: { id: enemy.id, x: enemy.x, y: enemy.y, vx: 0, vy: 0, acquiredTick: 0, noticeAtTick: 5, leadMul: 1 }, engagedSeen: 10 };
    return botThink(snapshotFor(w, bot.id), arenaFor(w), { ...mem, persona: 'cautious', intent: { ...plan, since: w.tick, holdUntil: 1e9 }, motor: lostLongAgo }, r).input.fire;
  };
  assert.equal(firstShot('peekAndHide'), true, 'aim held behind cover');
  assert.equal(firstShot('engage'), false, 'a fresh reaction first');
});

test('out on a peek at long range a marksman plants its feet, while a cautious bot sways at the edge of its cover', () => {
  const peekInputs = (persona: PersonalityId) => {
    const w = emptyWorld();
    setWalls(w, [{ x: 1030, y: 860, w: 40, h: 100 }]);
    const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
    const enemy = spawnAt(w, 1650, 1000);
    const r = seeded(5);
    const plan = { k: 'peekAndHide' as const, target: enemy.id, spot: { x: 1000, y: 910 }, peek: { x: 1000, y: 1000 }, phase: 'peek' as const, phaseUntil: 1e9 };
    let mem: BotMemory = { ...newBotMemory(r), persona, intent: { ...plan, since: 0, holdUntil: 1e9 } };
    const out: InputState[] = [];
    for (let i = 0; i < 90; i++) {
      for (const p of [bot, enemy]) if (p.life.k === 'alive') p.life.hp = 100;
      const d = botThink(snapshotFor(w, bot.id), arenaFor(w), mem, r);
      mem = d.mem;
      setInput(w, bot.id, i + 1, d.input);
      out.push(d.input);
      step(w, TICK_MS);
    }
    return out.slice(30);
  };
  const marksman = peekInputs('marksman');
  assert.ok(marksman.filter(moving).length / marksman.length < 0.2, `marksman moves ${marksman.filter(moving).length} of ${marksman.length} ticks`);
  const cautious = peekInputs('cautious');
  assert.ok(cautious.filter(moving).length / cautious.length > 0.5, `cautious moves ${cautious.filter(moving).length} of ${cautious.length} ticks`);
});

test('a bot fighting one enemy turns on a hunted one who comes into view, and keeps its own target over a mere nearer one', () => {
  const aimAfter = (hunted: boolean) => {
    const w = emptyWorld();
    const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
    const target = spawnAt(w, 1400, 1000);
    const other = spawnAt(w, 1000, 1250);
    if (hunted) equip(other, 'executioner');
    const r = seeded(6);
    let mem: BotMemory = { ...newBotMemory(r), persona: 'aggressive', intent: { k: 'engage', target: target.id, since: 0, holdUntil: 1e9 } };
    let angle = 0;
    for (let i = 0; i < 20; i++) {
      for (const p of [bot, target, other]) if (p.life.k === 'alive') p.life.hp = 100;
      const d = botThink(snapshotFor(w, bot.id), arenaFor(w), mem, r);
      mem = d.mem;
      angle = d.input.angle;
      step(w, TICK_MS);
    }
    return Math.atan2(Math.sin(angle), Math.cos(angle));
  };
  assert.ok(Math.abs(aimAfter(true) - Math.PI / 2) < 0.4, `aims down at the hunted enemy: ${aimAfter(true).toFixed(2)}`);
  assert.ok(Math.abs(aimAfter(false)) < 0.4, `stays on its target to the right: ${aimAfter(false).toFixed(2)}`);
});

test('a bot holding a key straight into a wall\'s end lets go of it and slides round to its goal', () => {
  const w = emptyWorld();
  setWalls(w, [{ x: 1000, y: 1000, w: 300, h: 50 }]);
  const bot = spawnAt(w, 1324, 1017);
  const goal = { x: 1213, y: 963 };
  const r = seeded(8);
  const base = newBotMemory(r);
  let mem: BotMemory = { ...base, intent: { k: 'patrol', goal, since: 0, holdUntil: 1e9 }, motor: { ...base.motor, dir: 4, dirSince: 0 } };
  for (let i = 0; i < 90 && Math.hypot(bot.x - goal.x, bot.y - goal.y) > 20; i++) {
    const d = botThink(snapshotFor(w, bot.id), arenaFor(w), mem, r);
    mem = d.mem;
    setInput(w, bot.id, i + 1, d.input);
    step(w, TICK_MS);
  }
  assert.ok(Math.hypot(bot.x - goal.x, bot.y - goal.y) <= 20, `reaches the goal within 3s, ends at (${bot.x.toFixed(0)}, ${bot.y.toFixed(0)})`);
});

test('a bot leads a target moving across its line of fire', () => {
  const offsets: number[] = [];
  for (let seed = 1; seed <= 10; seed++) {
    for (const l of watch({ seed, ticks: 60, weapon: 'sniper', targetAt: { x: 1800, y: 800 }, targetVel: { x: 0, y: 300 } }).slice(30)) offsets.push(l.angle - l.bearing);
  }
  const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
  assert.ok(mean > 0.01, `aims ahead (downward) of a target moving down: mean angle ${mean.toFixed(3)}`);
});

test('bot names never repeat a name already in the room, even once every plain gamertag is taken', () => {
  const taken = new Set<string>();
  // Past the couple of hundred plain names, so the numbered fallback is exercised too.
  for (let i = 0; i < 400; i++) {
    const n = botName(taken, rand);
    assert.ok(!taken.has(n), `${n} reused`);
    taken.add(n);
  }
  assert.ok([...taken].some((n) => / \d\d$/.test(n)), 'ran out of plain names and numbered some');
});
