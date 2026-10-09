import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROP_FX, RING } from '../src/shared/defs.ts';
import type { GameEvent } from '../src/shared/protocol.ts';
import { step } from '../src/shared/sim.ts';
import { GAS_DPS } from '../src/shared/sim/abilities.ts';
import { DOT_MS, DOT_SHARE, dotPulses } from '../src/shared/sim/dot.ts';
import { effectiveStats } from '../src/shared/sim/stats.ts';
import { createWorld, newId, type Player, type World } from '../src/shared/sim/world.ts';
import { emptyWorld, hpOf, spawnAt, TICK_MS } from './helpers.ts';

/** Steps `ms`, and returns every step's events with the time they fell at. */
function steps(w: World, ms: number): { at: number; ev: GameEvent }[] {
  const seen: { at: number; ev: GameEvent }[] = [];
  for (let t = 0; t < ms - 1e-9; t += TICK_MS) {
    step(w, TICK_MS);
    for (const ev of w.events) seen.push({ at: w.now, ev });
  }
  return seen;
}

const hitsOn = (seen: readonly { at: number; ev: GameEvent }[], victim: number) =>
  seen.flatMap(({ at, ev }) => (ev.e === 'dmg' && ev.victim === victim ? [{ at, amount: ev.amount }] : []));

function cloud(w: World, owner: Player, x: number, y: number, kind: 'gasCloud' | 'fireSlick' = 'gasCloud', lifeMs = 5000) {
  const t = { id: newId(w), kind, owner: owner.id, team: owner.team, x, y, bornAt: w.now, expiresAt: w.now + lifeMs };
  w.thrown.push(t);
  return t;
}

/** A gas-maker far off and one human standing in its cloud (a human's own hits are not scaled, so the amounts read plain). */
function gassed() {
  const w = emptyWorld();
  w.firstBlood = true;
  const owner = spawnAt(w, 300, 300, { name: 'o', kind: 'human' });
  const victim = spawnAt(w, 1000, 1000, { name: 'v', kind: 'human', loadout: { color: 'blue', armor: 'heavy' } });
  return { w, owner, victim };
}

test('a pulse clock falls every DOT_MS from its start, never at the start, and counts one at its end', () => {
  const all = (from: number, until: number, ms: number) => {
    const at: number[] = [];
    for (let now = from + TICK_MS; now <= from + ms + 1e-9; now += TICK_MS) for (let i = dotPulses(from, now, TICK_MS, until); i > 0; i--) at.push(now - from);
    return at;
  };
  const at = all(1234.5, 1234.5 + 2000, 3000);
  assert.equal(at.length, 4, 'four pulses in a two-second life');
  for (const [i, t] of at.entries()) assert.ok(t >= (i + 1) * DOT_MS - 1e-6 && t < (i + 1) * DOT_MS + TICK_MS, `pulse ${i} at ${t}`);
  assert.equal(dotPulses(0, 1000, 1000), 2, 'a long step catches every pulse in it');
  assert.equal(dotPulses(0, 499, 499), 0);
});

test('gas lands in half-second pulses of half its damage a second, and nothing between them', () => {
  const { w, owner, victim } = gassed();
  const start = w.now;
  cloud(w, owner, victim.x, victim.y);
  const hits = hitsOn(steps(w, 2000), victim.id);
  assert.deepEqual(hits.map((h) => h.amount), [7, 7, 7, 7], 'four hits of 7, piercing the heavy armor');
  assert.equal(GAS_DPS * DOT_SHARE, 7);
  for (const [i, h] of hits.entries()) assert.ok(h.at - start >= (i + 1) * DOT_MS - 1e-6 && h.at - start < (i + 1) * DOT_MS + TICK_MS, `pulse ${i} at ${h.at - start} ms`);
  assert.equal(hpOf(victim), 100 - 28);
});

test('a cloud deals its damage a second over its whole life, within one pulse', () => {
  for (const [kind, dps] of [['gasCloud', GAS_DPS], ['fireSlick', PROP_FX.oil.dps]] as const) {
    const { w, owner, victim } = gassed();
    cloud(w, owner, victim.x, victim.y, kind, 4000);
    steps(w, 6000);
    const lost = 100 - hpOf(victim);
    assert.ok(Math.abs(lost - dps * 4) <= dps * DOT_SHARE, `${kind}: lost ${lost} over four seconds, wants ${dps * 4}`);
    assert.equal(lost, dps * 4, `${kind}: its last pulse lands at its last moment`);
    assert.ok(!w.thrown.length, `${kind} is gone`);
  }
});

test('one who steps out between pulses takes nothing more', () => {
  const { w, owner, victim } = gassed();
  cloud(w, owner, victim.x, victim.y);
  steps(w, 700);
  assert.equal(hpOf(victim), 93, 'one pulse');
  victim.x += 400;
  const later = hitsOn(steps(w, 2000), victim.id);
  assert.deepEqual(later, []);
  assert.equal(hpOf(victim), 93);
});

test('one damage event per pulse per victim, credited to the cloud\'s maker', () => {
  const { w, owner, victim } = gassed();
  const second = spawnAt(w, 1040, 1000, { name: 'v2', kind: 'human', loadout: { color: 'green' } });
  cloud(w, owner, victim.x, victim.y);
  const seen = steps(w, 1500);
  for (const p of [victim, second]) {
    const hits = seen.filter(({ ev }) => ev.e === 'dmg' && ev.victim === p.id);
    assert.equal(hits.length, 3, `${p.name}: one a pulse`);
    assert.equal(new Set(hits.map((h) => h.at)).size, 3, 'each in its own step');
    assert.ok(hits.every(({ ev }) => ev.e === 'dmg' && ev.attacker === owner.id));
  }
});

test('a burning slick kill still pays its spiller the kill and Arsonist', () => {
  const { w, owner, victim } = gassed();
  if (victim.life.k === 'alive') victim.life.hp = 10;
  cloud(w, owner, victim.x, victim.y, 'fireSlick');
  const seen = steps(w, 1100);
  const kill = seen.find(({ ev }) => ev.e === 'kill')?.ev;
  assert.ok(kill?.e === 'kill' && kill.killerId === owner.id && kill.weapon === 'Fire');
  assert.ok(seen.some(({ ev }) => ev.e === 'medal' && ev.id === owner.id && ev.medal === 'arsonist'));
});

test('range targets and zombies burn in the same pulses', () => {
  const r = emptyWorld('RNG');
  const t = r.range!.targets.find((o) => !o.def.rail)!;
  const p = spawnAt(r, t.x - 300, t.y);
  cloud(r, p, t.x, t.y);
  const onTarget = hitsOn(steps(r, 1100), t.id);
  assert.deepEqual(onTarget.map((h) => h.amount), [7, 7]);

  const z = createWorld('ZOM', 1, 'outpost');
  z.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  z.run!.core.hp = 1e9;
  const maker = spawnAt(z, 1475, 1700);
  const zombie = { id: newId(z), kind: 'brute' as const, x: 1475, y: 2100, hp: 1000, attackAt: Infinity, vx: 0, vy: 0 };
  z.zombies.push(zombie);
  cloud(z, maker, zombie.x, zombie.y);
  const seen: number[] = [];
  for (let i = 0; i < 33; i++) { const before = zombie.hp; step(z, TICK_MS); if (zombie.hp !== before) seen.push(before - zombie.hp); }
  assert.deepEqual(seen, [7, 7], 'two pulses in 1.1 s');
});

test('the ring burns in half-second pulses of half its share of max health a second, one number each', () => {
  const w = emptyWorld('BR');
  w.royale!.ring = { k: 'waiting', phase: 1, circle: { x: 1000, y: 1000, r: 400 }, next: { x: 1000, y: 1000, r: 400 }, shrinkAt: Infinity };
  const outside = spawnAt(w, 2000, 1000, { team: 'red' });
  spawnAt(w, 200, 200, { team: 'blue' });
  const per = RING[1]!.dps * effectiveStats(outside).maxHp * DOT_SHARE;
  const hits = hitsOn(steps(w, 2000), outside.id);
  assert.equal(hits.length, 4);
  assert.ok(hits.every((h) => Math.abs(h.amount - per) < 0.06), `${hits.map((h) => h.amount)} each, wants ${per}`);
  assert.ok(hits.every((h) => Math.abs(h.at / DOT_MS - Math.round(h.at / DOT_MS)) * DOT_MS < TICK_MS), 'on the world\'s half-seconds');
  outside.x = 1000;
  assert.deepEqual(hitsOn(steps(w, 1000), outside.id), [], 'back inside, nothing more');
});
