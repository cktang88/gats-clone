/// <reference types="node" />
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { ARMOR_IDS, HP_MULTIPLIER, WORLD, type ArmorId, type PlayerKind } from '../src/shared/defs.ts';

const H = HP_MULTIPLIER.human;
import { addPlayer, step } from '../src/shared/sim.ts';
import { damagePlayer } from '../src/shared/sim/combat.ts';
import { effectiveStats } from '../src/shared/sim/stats.ts';
import { startServer } from '../src/server/main.ts';
import { PISTOL, TICK_MS, emptyWorld, grantPerks, hpOf, press, run, spawnAt } from './helpers.ts';

test('humans carry multiplied health and regen, bots keep the base', () => {
  const w = emptyWorld();
  const human = addPlayer(w, 'Hu', PISTOL, { kind: 'human', at: { x: 500, y: 500 } });
  const bot = addPlayer(w, 'Bo', PISTOL, { at: { x: 900, y: 500 } });
  assert.equal(effectiveStats(human).maxHp, WORLD.baseHp * H);
  assert.equal(effectiveStats(bot).maxHp, WORLD.baseHp);
  assert.equal(effectiveStats(human).regenPerSec / effectiveStats(human).maxHp, effectiveStats(bot).regenPerSec / effectiveStats(bot).maxHp, 'healing to full takes the same time');
  grantPerks(w, human, ['optics', 'thickSkin']);
  assert.equal(effectiveStats(human).maxHp, (WORLD.baseHp + 40) * H, 'thick skin is multiplied too');
});

test('first aid starts healing 1.6s after a hit, three times as fast; without it healing waits 4s', () => {
  const w = emptyWorld();
  const medic = spawnAt(w, 500, 500);
  const plain = spawnAt(w, 900, 500);
  grantPerks(w, medic, ['optics', 'firstAid']);
  for (const p of [medic, plain]) if (p.life.k === 'alive') { p.life.hp = 50; p.life.lastDamageAt = w.now; }
  run(w, 1500);
  assert.deepEqual([hpOf(medic), hpOf(plain)], [50, 50], 'nobody heals within 1.5s');
  run(w, 1000);
  assert.ok(hpOf(medic) > 50 && hpOf(plain) === 50, `at 2.5s first aid heals (${hpOf(medic).toFixed(1)}) and plain waits`);
  const healed = hpOf(medic);
  run(w, 1000);
  assert.ok(Math.abs(hpOf(medic) - healed - 3 * WORLD.regenPerSec) < 0.5, `heals ${(hpOf(medic) - healed).toFixed(1)} in the next second`);
  run(w, 1000);
  assert.ok(hpOf(plain) > 50, 'plain heals after 4s');
});

test('humans kill each other as fast as bots kill each other, armored or not, and bots still need the human multiple of the time on a human', () => {
  const ttk = (shooterKind: PlayerKind, victimKind: PlayerKind, armor: ArmorId) => {
    const w = emptyWorld();
    const shooter = addPlayer(w, 'S', { ...PISTOL, weapon: 'smg' }, { kind: shooterKind, at: { x: 500, y: 500 } });
    const victim = addPlayer(w, 'V', { ...PISTOL, armor }, { kind: victimKind, at: { x: 700, y: 500 } });
    if (victim.life.k === 'alive') victim.life.shieldUntil = -Infinity;
    press(w, shooter, { angle: 0, fire: true, shots: 1 });
    let t = 0;
    for (; victim.life.k === 'alive' && t < 20_000; t += TICK_MS) step(w, TICK_MS);
    return Math.round(t);
  };
  for (const armor of ['none', 'medium'] as const) {
    assert.equal(ttk('human', 'human', armor), ttk('bot', 'bot', armor), `${armor} armor`);
    assert.equal(ttk('human', 'bot', armor), ttk('bot', 'bot', armor), `a human hits a bot for base damage (${armor} armor)`);
    assert.ok(ttk('bot', 'human', armor) >= 0.9 * H * ttk('bot', 'bot', armor), `a bot needs about the human multiple of the time on a human (${armor} armor)`);
    assert.ok(ttk('bot', 'human', armor) <= 1.2 * H * ttk('bot', 'bot', armor), `but no more than that (${armor} armor)`);
  }
});

const RAW_STEP = 0.5;

/** Raw damage, before any multiplier or armor, that `shooterKind` lands to kill a fresh `victimKind` wearing `armor`. */
function rawDamageToKill(shooterKind: PlayerKind, victimKind: PlayerKind, armor: ArmorId): number {
  const w = emptyWorld();
  const shooter = addPlayer(w, 'S', PISTOL, { kind: shooterKind, at: { x: 500, y: 500 } });
  const victim = addPlayer(w, 'V', { ...PISTOL, armor }, { kind: victimKind, at: { x: 900, y: 500 } });
  if (victim.life.k === 'alive') victim.life.shieldUntil = -Infinity;
  let raw = 0;
  while (victim.life.k === 'alive' && raw < 10_000) {
    damagePlayer(w, victim, RAW_STEP, { attacker: shooter, team: null, label: 'test', piercing: false, via: 'bullet', fromX: 500, fromY: 500 });
    raw += RAW_STEP;
  }
  return raw;
}

test('armor blocks the same share for humans and bots: a bot spends the human multiple of the raw damage on an armored human, and humans duel at bot pace in every armor', () => {
  for (const armor of ARMOR_IDS) {
    const botOnBot = rawDamageToKill('bot', 'bot', armor);
    assert.ok(Math.abs(rawDamageToKill('bot', 'human', armor) - H * botOnBot) <= H * RAW_STEP, `${armor}: bot on human ${rawDamageToKill('bot', 'human', armor)} vs ${H} x ${botOnBot}`);
    assert.ok(Math.abs(rawDamageToKill('human', 'human', armor) - botOnBot) <= RAW_STEP, `${armor}: human on human ${rawDamageToKill('human', 'human', armor)} vs bot on bot ${botOnBot}`);
  }
});

test('a player who joins through the server gets multiplied health while the room bots do not', { timeout: 10_000 }, async () => {
  const server = await startServer({ port: 0, dataDir: await mkdtemp(join(tmpdir(), 'skirmish-hp-')) });
  try {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws?room=ffa`);
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'join', name: 'Hero', loadout: PISTOL }));
    const snap = await new Promise<any>((resolve) => {
      let me = 0;
      ws.on('message', (m) => {
        const msg = JSON.parse(String(m));
        if (msg.t === 'welcome') me = msg.id;
        if (msg.t === 'snap' && msg.players.some((p: { id: number }) => p.id === me)) resolve({ me, msg });
      });
    });
    const self = snap.msg.players.find((p: { id: number }) => p.id === snap.me);
    assert.equal(self.maxHp, WORLD.baseHp * H);
    assert.equal(self.hp, WORLD.baseHp * H, 'spawns at full multiplied health');
    for (const other of snap.msg.players.filter((p: { id: number }) => p.id !== snap.me)) assert.equal(other.maxHp, WORLD.baseHp, `${other.name} is a bot at base health`);
    ws.close();
  } finally {
    await server.close();
  }
});
