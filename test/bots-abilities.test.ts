/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AbilityId, ModeId } from '../src/shared/defs.ts';
import { MAPS } from '../src/shared/maps.ts';
import type { InputState, Snapshot, WallView } from '../src/shared/protocol.ts';
import { setInput, step } from '../src/shared/sim.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { botThink, newBotMemory } from '../src/server/bots.ts';
import { VETERAN } from '../src/server/bot/aim.ts';
import { arenaFor } from '../src/server/bot/arena.ts';
import { emptyWorld, grantPerks, setWalls, spawnAt, TICK_MS } from './helpers.ts';

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

const seeded = (seed: number) => { let x = seed; return () => ((x = (x * 16807) % 2147483647) / 2147483647); };

type Scene = {
  ability: AbilityId;
  botAt?: { x: number; y: number };
  enemyAt?: { x: number; y: number };
  hp?: number;
  mode?: ModeId;
  walls?: WallView[];
  hitEveryTick?: boolean;
};

/** The bot's inputs over its first second, standing at (1000, 1000) unless told otherwise, facing an idle enemy. */
function inputs(scene: Scene, ticks = 30): InputState[] {
  const w = emptyWorld(scene.mode);
  if (scene.walls) setWalls(w, scene.walls);
  const bot = spawnAt(w, scene.botAt?.x ?? 1000, scene.botAt?.y ?? 1000, { loadout: { weapon: 'assault' }, team: scene.mode === 'DOM' ? 'red' : undefined });
  grantPerks(w, bot, ['extended', 'thickSkin', scene.ability]);
  if (scene.enemyAt) spawnAt(w, scene.enemyAt.x, scene.enemyAt.y, { team: scene.mode === 'DOM' ? 'blue' : undefined });
  const r = seeded(11);
  let mem = newBotMemory(r);
  const out: InputState[] = [];
  for (let i = 0; i < ticks; i++) {
    if (scene.hp !== undefined && bot.life.k === 'alive') bot.life.hp = scene.hp;
    const snap: Snapshot = snapshotFor(w, bot.id);
    if (scene.hitEveryTick) snap.events = [...snap.events, { e: 'dmg', attacker: null, victim: bot.id, amount: 5, x: bot.x, y: bot.y, kind: 'player' }];
    const d = botThink(snap, arenaFor(w), mem, r);
    mem = d.mem;
    out.push(d.input);
    step(w, TICK_MS);
  }
  return out;
}

const uses = (xs: InputState[]) => xs.some((i) => i.ability);

test('a knife bot lunges only at an enemy inside its lunge reach', () => {
  assert.ok(uses(inputs({ ability: 'knife', enemyAt: { x: 1130, y: 1000 } })), 'stabs an enemy 130px away');
  assert.ok(!uses(inputs({ ability: 'knife', enemyAt: { x: 1350, y: 1000 } })), 'holds the knife at 350px');
});

test('a grenade bot throws only at mid range', () => {
  for (const ability of ['grenade', 'fragGrenade', 'gasGrenade'] as const) {
    assert.ok(uses(inputs({ ability, enemyAt: { x: 1300, y: 1000 } })), `${ability}: throws at 300px`);
    assert.ok(!uses(inputs({ ability, enemyAt: { x: 1080, y: 1000 } })), `${ability}: holds at 80px, inside its own blast`);
    assert.ok(!uses(inputs({ ability, enemyAt: { x: 1600, y: 1000 } })), `${ability}: holds at 600px`);
  }
});

test('a grenade bot does not throw before its reaction delay has passed', () => {
  const first = inputs({ ability: 'grenade', enemyAt: { x: 1300, y: 1000 } }).findIndex((i) => i.ability);
  assert.ok(first * TICK_MS >= 0.8 * 220 - TICK_MS / 2, `first throw after ${(first * TICK_MS).toFixed(0)}ms`);
});

test('a hurt dash bot dashes away from the enemy, and a healthy one does not dash', () => {
  const hurt = inputs({ ability: 'dash', enemyAt: { x: 1300, y: 1000 }, hp: 20 });
  const dashTick = hurt.find((i) => i.ability);
  assert.ok(dashTick, 'dashes when at 20 hp');
  assert.ok(dashTick.left && !dashTick.right, 'dashes away from an enemy to its right');
  assert.ok(!uses(inputs({ ability: 'dash', enemyAt: { x: 1300, y: 1000 } })), 'no dash at full health');
});

test('a hurt bot dashes around a wall behind it rather than into it', () => {
  const wall: WallView = { x: 900, y: 950, w: 40, h: 100, built: false, material: 'concrete' };
  const dash = inputs({ ability: 'dash', enemyAt: { x: 1300, y: 1000 }, hp: 20, walls: [wall] }).find((i) => i.ability);
  assert.ok(dash, 'dashes');
  assert.ok(dash.left && !dash.right && (dash.up || dash.down), 'dashes diagonally away, past the wall');
});

test('a bot drops a land mine when hurt in a fight or standing on a zone it does not own', () => {
  assert.ok(uses(inputs({ ability: 'landMine', enemyAt: { x: 1300, y: 1000 }, hp: 20 })), 'mines its retreat');
  assert.ok(!uses(inputs({ ability: 'landMine', enemyAt: { x: 1300, y: 1000 } })), 'keeps the mine at full health');
  const center = emptyWorld('DOM').zones[1]!;
  assert.ok(uses(inputs({ ability: 'landMine', mode: 'DOM', botAt: center }, 1)), 'mines a zone it is capturing');
  assert.ok(!uses(inputs({ ability: 'landMine', mode: 'DOM', botAt: { x: center.x - 400, y: center.y } }, 1)), 'no mine off the zone');
});

test('an engineer bot builds cover only while under fire at mid range', () => {
  assert.ok(uses(inputs({ ability: 'engineer', enemyAt: { x: 1350, y: 1000 }, hitEveryTick: true })), 'walls off a shooter 350px away');
  assert.ok(!uses(inputs({ ability: 'engineer', enemyAt: { x: 1350, y: 1000 } })), 'no wall when nobody is shooting');
  assert.ok(!uses(inputs({ ability: 'engineer', enemyAt: { x: 1100, y: 1000 }, hitEveryTick: true })), 'no wall against a shooter 100px away');
});

test('a bot with its knife ready closes on a nearby enemy instead of strafing at range', () => {
  const knife = inputs({ ability: 'knife', enemyAt: { x: 1250, y: 1000 } }, 1)[0]!;
  assert.ok(knife.right, 'steps toward an enemy 250px away');
  const grenade = inputs({ ability: 'grenade', enemyAt: { x: 1250, y: 1000 } }, 1)[0]!;
  assert.ok(!grenade.right, 'a grenade bot holds its distance');
});

test('a bot throws a grenade where a moving target will be when it lands', () => {
  const speed = 200, fuseS = 0.9;
  const offLanding: number[] = [], offNow: number[] = [], distErr: number[] = [];
  for (let seed = 1; seed <= 20; seed++) {
    const w = emptyWorld();
    const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
    grantPerks(w, bot, ['extended', 'thickSkin', 'grenade']);
    const target = spawnAt(w, 1350, 850);
    const r = seeded(seed);
    let mem = newBotMemory(r, { skill: VETERAN });
    for (let i = 0; i < 30; i++) {
      const d = botThink(snapshotFor(w, bot.id), arenaFor(w), mem, r);
      mem = d.mem;
      if (d.input.ability) {
        const landing = { x: target.x, y: target.y + speed * fuseS };
        offLanding.push(wrap(d.input.angle - Math.atan2(landing.y - bot.y, landing.x - bot.x)));
        offNow.push(wrap(d.input.angle - Math.atan2(target.y - bot.y, target.x - bot.x)));
        distErr.push(d.input.aimDist - Math.hypot(landing.x - bot.x, landing.y - bot.y));
        break;
      }
      target.y += speed * TICK_MS / 1000;
      step(w, TICK_MS);
    }
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.equal(offLanding.length, 20, 'every bot throws');
  assert.ok(Math.abs(mean(offLanding)) < 0.1, `aims ${mean(offLanding).toFixed(2)} rad off the landing point on average`);
  assert.ok(mean(offNow) > 0.3, `aims ${mean(offNow).toFixed(2)} rad ahead of where the target is now`);
  assert.ok(Math.abs(mean(distErr)) < 30, `throws ${mean(distErr).toFixed(0)}px past the landing point on average`);
});

test('a hurt bot without a dash and with no cover in reach keeps fighting a near enemy rather than turning its back', () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  spawnAt(w, 1300, 1000);
  const r = seeded(2);
  let mem = newBotMemory(r);
  for (let i = 0; i < 20; i++) {
    if (bot.life.k === 'alive') bot.life.hp = 20;
    const d = botThink(snapshotFor(w, bot.id), arenaFor(w), mem, r);
    mem = d.mem;
    setInput(w, bot.id, i + 1, d.input);
    assert.ok(!d.input.left, `tick ${i}: does not back away`);
    step(w, TICK_MS);
  }
});
