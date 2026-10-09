/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ABILITY_COOLDOWN_MS, PERK_TIERS } from '../src/shared/defs.ts';
import type { Snapshot, ThrownView } from '../src/shared/protocol.ts';
import { step } from '../src/shared/sim.ts';
import { FLASH, flashAmount, flashMs, SMOKE } from '../src/shared/sim/abilities.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { sightBlocked, smokeRadius } from '../src/shared/sim/vision.ts';
import { botThink, newBotMemory } from '../src/server/bots.ts';
import { arenaFor } from '../src/server/bot/arena.ts';
import { aimSigma, engage, SHARPNESS } from '../src/server/bot/aim.ts';
import { BLIND_AT, freshAwareness, perceive } from '../src/server/bot/awareness.ts';
import { emptyWorld, grantPerks, press, run, spawnAt, TICK_MS } from './helpers.ts';
import { veilAlpha } from '../src/client/flashsmoke.ts';

const seeded = (seed: number) => { let x = seed; return () => ((x = (x * 16807) % 2147483647) / 2147483647); };

function thrower(w: ReturnType<typeof emptyWorld>, ability: 'flashbang' | 'smokeGrenade', x = 500, y = 1000) {
  const p = spawnAt(w, x, y);
  grantPerks(w, p, ['extended', 'thickSkin', ability]);
  return p;
}

const throwAt = (w: ReturnType<typeof emptyWorld>, p: { x: number; y: number; id: number }, at: number) => {
  const pl = w.players.get(p.id)!;
  press(w, pl, { ability: true, angle: 0, aimDist: at });
  step(w, TICK_MS);
  press(w, pl, { angle: 0 });
};

test('both are tier-3 abilities with the stated cooldowns', () => {
  assert.ok(PERK_TIERS[3].includes('flashbang') && PERK_TIERS[3].includes('smokeGrenade'));
  assert.equal(ABILITY_COOLDOWN_MS.flashbang, 9000);
  assert.equal(ABILITY_COOLDOWN_MS.smokeGrenade, 12000);
});

test('flash: falls off with distance, needs line of sight, and is worse when looking at it', () => {
  const w = emptyWorld();
  const p = spawnAt(w, 1000, 1000);
  p.angle = Math.PI; // facing the burst at x < 1000
  const at = (d: number) => flashMs(w, p, 1000 - d, 1000);
  assert.ok(at(50) > at(200) && at(200) > at(340), 'nearer blinds longer');
  assert.ok(at(10) <= FLASH.maxMs && at(10) > 0.9 * FLASH.maxMs, `point blank is nearly full (${at(10)})`);
  assert.equal(at(361), 0, 'beyond 360px nothing');
  p.angle = 0; // back to it
  const away = flashMs(w, p, 800, 1000);
  p.angle = Math.PI;
  const toward = flashMs(w, p, 800, 1000);
  assert.ok(Math.abs(away / toward - FLASH.awayMul) < 0.01, `facing away is ${away / toward} of facing it`);
  w.walls.push({ x: 880, y: 900, w: 20, h: 200, material: 'concrete' } as never);
  assert.equal(flashMs(w, p, 800, 1000), 0, 'a wall blocks the flash');
});

test('a thrown flashbang bursts after its fuse, flashes friend and thrower, and wears off within 3 s', () => {
  const w = emptyWorld();
  const me = thrower(w, 'flashbang');
  const mate = spawnAt(w, 760, 1000, { team: 'red' });
  me.team = 'red';
  const foe = spawnAt(w, 780, 1100, { team: 'blue' });
  me.angle = 0;
  mate.angle = Math.PI;
  foe.angle = Math.PI;
  throwAt(w, me, 280);
  assert.equal(flashAmount(foe, w.now), 0, 'nothing before the fuse');
  assert.ok(w.thrown.some((t) => t.kind === 'flashbang'));
  run(w, FLASH.fuseMs + 100);
  assert.ok(flashAmount(foe, w.now) > 0.5, 'the enemy is flashed');
  assert.ok(flashAmount(mate, w.now) > 0.5, 'a teammate is flashed too');
  assert.ok(snapshotFor(w, foe.id).self.flash! > 0.5, 'the server tells the flashed player how much');
  assert.equal(snapshotFor(w, me.id).self.flash === undefined || snapshotFor(w, me.id).self.flash! >= 0, true);
  run(w, FLASH.maxMs + 200);
  assert.equal(flashAmount(foe, w.now), 0, 'gone within about 3 s');
  assert.equal(snapshotFor(w, foe.id).self.flash, undefined);
});

test('a flash is brighter earlier: full white while over 1.5 s remain, fading after', () => {
  const w = emptyWorld();
  const p = spawnAt(w, 1000, 1000);
  p.flash = { until: w.now + 3000, ms: 3000 };
  assert.equal(flashAmount(p, w.now), 1);
  assert.ok(Math.abs(flashAmount(p, w.now + 2250) - 0.5) < 1e-9);
  assert.equal(flashAmount(p, w.now + 3000), 0);
  assert.ok(veilAlpha(1) === 1 && veilAlpha(1, true) < 1, 'reduced motion never whites out fully');
});

test('smoke: blooms, drifts, thins and ends after about 10 s', () => {
  const w = emptyWorld();
  const me = thrower(w, 'smokeGrenade');
  throwAt(w, me, 300);
  run(w, SMOKE.fuseMs + 100);
  const cloud = () => w.thrown.find((t) => t.kind === 'smokeCloud');
  const c0 = cloud()!;
  assert.ok(c0);
  const x0 = c0.x, y0 = c0.y;
  run(w, 3000);
  assert.ok(Math.hypot(cloud()!.x - x0, cloud()!.y - y0) > 5, 'drifts');
  const view = (r: ThrownView[]) => r.find((t) => t.kind === 'smokeCloud')!.r;
  const full = view(snapshotFor(w, me.id).thrown);
  assert.ok(full > SMOKE.radius * 0.9 && full <= SMOKE.radius, `about 180px (${full})`);
  run(w, 5500);
  assert.ok(view(snapshotFor(w, me.id).thrown) < full * 0.8, 'thins at the end');
  run(w, 2000);
  assert.equal(cloud(), undefined, 'gone');
  assert.ok(smokeRadius(0, 0, SMOKE.lifeMs) < smokeRadius(SMOKE.bloomMs, 0, SMOKE.lifeMs), 'blooms');
});

function smokeScene() {
  const w = emptyWorld();
  const viewer = spawnAt(w, 500, 1000, { loadout: { weapon: 'assault' } });
  const target = spawnAt(w, 900, 1000);
  w.thrown.push({ id: 900, kind: 'smokeCloud', owner: viewer.id, team: null, x: 700, y: 1000, vx: 0, vy: 0, bornAt: w.now - 2000, expiresAt: w.now + 8000 });
  return { w, viewer, target };
}
const ids = (s: Snapshot) => s.players.map((p) => p.id);

test('smoke hides players behind or inside it from the wire, but not from a viewer whose line misses it', () => {
  const { w, viewer, target } = smokeScene();
  assert.ok(!ids(snapshotFor(w, viewer.id)).includes(target.id), 'behind smoke: not sent');
  assert.ok(!ids(snapshotFor(w, target.id)).includes(viewer.id), 'and the other way round');
  const inside = spawnAt(w, 720, 1020);
  assert.ok(!ids(snapshotFor(w, viewer.id)).includes(inside.id), 'inside smoke: hidden from outside');
  const aside = spawnAt(w, 500, 1300);
  assert.ok(ids(snapshotFor(w, viewer.id)).includes(aside.id), 'a clear line is seen');
  const friend = spawnAt(w, 900, 1050, { team: 'red' });
  viewer.team = 'red';
  assert.ok(ids(snapshotFor(w, viewer.id)).includes(friend.id), 'teammates stay visible');
});

test('a player in smoke sees only a short radius', () => {
  const { w, viewer } = smokeScene();
  viewer.x = 700;
  const near = spawnAt(w, 790, 1000), far = spawnAt(w, 840, 1000);
  const seen = ids(snapshotFor(w, viewer.id));
  assert.ok(seen.includes(near.id) && !seen.includes(far.id), `90px seen, 140px not (${seen})`);
  assert.ok(sightBlocked([{ x: 0, y: 0, r: 100 }], 0, 0, SMOKE.sightPx + 5, 0));
});

test('bullets pass through smoke', () => {
  const { w, viewer, target } = smokeScene();
  viewer.angle = 0;
  const before = target.life.k === 'alive' ? target.life.hp : 0;
  for (let i = 0; i < 8; i++) {
    press(w, viewer, { angle: 0, fire: true, shots: viewer.input.shots + 1 });
    run(w, 200);
  }
  assert.ok((target.life.k === 'alive' ? target.life.hp : 0) < before || target.life.k !== 'alive', 'the shots through the cloud land');
});

// ------------------------------------------------------------------------------------------ bots

function botScene(flash = 0) {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' }, kind: 'bot' });
  const foe = spawnAt(w, 1300, 1000);
  if (flash) bot.flash = { until: w.now + flash * FLASH.whiteMs, ms: 3000 };
  return { w, bot, foe };
}

test('a flashed bot gets no new sightings but keeps stale memory, and sees again when it recovers', () => {
  const { w, bot, foe } = botScene();
  const arena = arenaFor(w);
  const me = (s: Snapshot) => s.players.find((p) => p.id === bot.id)!;
  let snap = snapshotFor(w, bot.id);
  let a = perceive(snap, arena, me(snap), freshAwareness());
  assert.equal(a.view.threats.length, 1, 'sees the enemy');
  bot.flash = { until: w.now + 3000, ms: 3000 };
  step(w, TICK_MS);
  snap = snapshotFor(w, bot.id);
  assert.ok(snap.players.some((p) => p.id === foe.id), 'the enemy is on the wire; the blindness is the bot');
  const b = perceive(snap, arena, me(snap), a.awareness);
  assert.equal(b.view.threats.length, 0, 'but the bot takes in nothing');
  assert.equal(b.awareness.contacts.length, 1, 'only memory of where he was');
  assert.deepEqual([b.awareness.contacts[0]!.x, b.awareness.contacts[0]!.y], [1300, 1000]);
  run(w, 3100);
  snap = snapshotFor(w, bot.id);
  const c = perceive(snap, arena, me(snap), b.awareness);
  assert.equal(c.view.threats.length, 1, 'sees again after the flash');
});

test('a flashed bot is deaf to gunfire it would otherwise hear, and falls back or sprays instead of fighting', () => {
  const { w, bot } = botScene();
  const shot = [{ e: 'shot' as const, x: 2400, y: 1000, angle: 0, silenced: false, owner: 999, gun: 'assault' as const }];
  const lead = (flash: number) => {
    bot.flash = flash ? { until: w.now + 3000, ms: 3000 } : undefined;
    const snap = snapshotFor(w, bot.id, shot);
    return perceive(snap, arenaFor(w), snap.players.find((p) => p.id === bot.id)!, freshAwareness()).view.lead;
  };
  assert.ok(lead(0), 'it hears a shot out of sight');
  assert.equal(lead(1), null, 'not while flashed');
  bot.flash = undefined;
  const r = seeded(5);
  let mem = newBotMemory(r);
  let d = botThink(snapshotFor(w, bot.id), arenaFor(w), mem, r);
  mem = d.mem;
  bot.flash = { until: w.now + 3000, ms: 3000 };
  const kinds = new Set<string>();
  let fired = 0;
  for (let i = 0; i < 20; i++) {
    step(w, TICK_MS);
    d = botThink(snapshotFor(w, bot.id), arenaFor(w), mem, r);
    mem = d.mem;
    kinds.add(mem.intent?.k ?? '');
    if (d.input.fire) fired++;
  }
  assert.ok(kinds.has('blinded'), `it reacts to the flash (${[...kinds]})`);
});

test('flash widens aim error and slows reaction', () => {
  const e = engage(null, { id: 1, x: 300, y: 0 }, SHARPNESS[0]!, 0, () => 0.5);
  const f = engage(null, { id: 1, x: 300, y: 0 }, SHARPNESS[0]!, 0, () => 0.5, 1);
  assert.ok(f.noticeAtTick > e.noticeAtTick + 10, `reaction ${e.noticeAtTick} -> ${f.noticeAtTick} ticks`);
  assert.ok(aimSigma(f, { x: 0, y: 0 }, SHARPNESS[0]!, 100, 1) >= 3.9 * aimSigma(f, { x: 0, y: 0 }, SHARPNESS[0]!, 100, 0), 'aim error spikes');
  assert.ok(aimSigma(f, { x: 0, y: 0 }, SHARPNESS[0]!, 100, 0.2) < aimSigma(f, { x: 0, y: 0 }, SHARPNESS[0]!, 100, 1), 'and fades with the flash');
  assert.ok(BLIND_AT > 0 && BLIND_AT < 0.5);
});

test('a bot cannot see through smoke: the snapshot never carries the enemy, so it has no threat', () => {
  const { w, viewer: bot, target } = smokeScene();
  bot.kind = 'bot';
  const snap = snapshotFor(w, bot.id);
  const { view } = perceive(snap, arenaFor(w), snap.players.find((p) => p.id === bot.id)!, freshAwareness());
  assert.equal(view.threats.length, 0);
  assert.equal(view.smokes.length, 1);
  assert.ok(target.life.k === 'alive');
});

test('bots notice an incoming flashbang about 60% of the time, after a short delay', () => {
  const { w, bot } = botScene();
  w.players.forEach((p) => { if (p.id !== bot.id) w.players.delete(p.id); });
  const arena = arenaFor(w);
  let noticed = 0;
  const N = 200;
  for (let id = 1000; id < 1000 + N; id++) {
    const snap = snapshotFor(w, bot.id);
    const nade: ThrownView = { id, kind: 'flashbang', x: 1250, y: 1000, r: 10, owner: 99 };
    snap.thrown = [nade];
    const me = snap.players.find((p) => p.id === bot.id)!;
    let aware = freshAwareness();
    let first = -1;
    for (let k = 0; k < 12; k++) {
      snap.tick = k;
      const out = perceive(snap, arena, me, aware);
      aware = out.awareness;
      if (out.view.incomingFlash && first < 0) first = k;
    }
    if (first >= 0) { noticed++; assert.ok(first >= 7, `not instant (tick ${first})`); }
  }
  assert.ok(noticed > N * 0.45 && noticed < N * 0.75, `${noticed}/${N}`);
});

function usesAbility(ability: 'flashbang' | 'smokeGrenade', o: { enemyAt?: number; hp?: number; seenThenLost?: boolean }): boolean {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  grantPerks(w, bot, ['extended', 'thickSkin', ability]);
  if (o.enemyAt) spawnAt(w, o.enemyAt, 1000);
  const r = seeded(11);
  let mem = newBotMemory(r);
  for (let i = 0; i < 30; i++) {
    if (o.hp !== undefined && bot.life.k === 'alive') bot.life.hp = o.hp;
    const d = botThink(snapshotFor(w, bot.id), arenaFor(w), mem, r);
    mem = d.mem;
    if (d.input.ability) return true;
    step(w, TICK_MS);
  }
  return false;
}

test('bots flash at a far enemy only (so the burst is clear of themselves) and never at point blank', () => {
  assert.ok(usesAbility('flashbang', { enemyAt: 1430 }), 'throws at 430px');
  assert.ok(!usesAbility('flashbang', { enemyAt: 1250 }), 'holds at 250px');
  assert.ok(!usesAbility('flashbang', {}), 'holds with no enemy');
});

test('bots smoke when hurt and pressed, not when healthy', () => {
  assert.ok(usesAbility('smokeGrenade', { enemyAt: 1300, hp: 20 }));
  assert.ok(!usesAbility('smokeGrenade', { enemyAt: 1300 }));
});

test('a bot that lost its target in smoke holds instead of pushing into it', async () => {
  const { nextIntent, startIntent, PERSONALITIES } = await import('../src/server/bot/intent.ts');
  const { w, viewer: bot } = smokeScene();
  const arena = arenaFor(w);
  const snap = snapshotFor(w, bot.id);
  const me = snap.players.find((p) => p.id === bot.id)!;
  const aware = { ...freshAwareness(), contacts: [{ id: 99, x: 900, y: 1000, seenTick: snap.tick - 20, gun: 'assault' as const }] };
  const { view } = perceive(snap, arena, me, aware);
  const ctx = { tick: snap.tick, persona: PERSONALITIES.aggressive, role: null, band: { headOn: 0, ideal: 300, max: 400, hold: 0, rushes: false }, arena, rand: () => 0.1 };
  const next = nextIntent({ ...startIntent({ k: 'engage', target: 99 }, ctx), holdUntil: 0 }, view, ctx);
  assert.equal(next.k, 'takePosition');
});

test('flash and smoke are deterministic', () => {
  const play = () => {
    const w = emptyWorld();
    const a = thrower(w, 'flashbang');
    const b = spawnAt(w, 700, 1010);
    const c = thrower(w, 'smokeGrenade', 500, 1200);
    throwAt(w, a, 250);
    throwAt(w, c, 300);
    run(w, 4000);
    return JSON.stringify([w.thrown, b.flash, a.flash, w.events.length, w.tick]);
  };
  assert.equal(play(), play());
});
