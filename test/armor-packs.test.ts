import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARMOR_IDS, ARMOR_PACK, ARMORS, armorBlock, armorShare, GUN_IDS, GUNS, WORLD, type ArmorId } from '../src/shared/defs.ts';
import { MAP_IDS, MAPS, ROTATION, type MapId } from '../src/shared/maps.ts';
import type { GameEvent, Snapshot, SnapshotWire } from '../src/shared/protocol.ts';
import { canRespawn, respawn, step } from '../src/shared/sim.ts';
import { openSpots } from '../src/shared/sim/airdrop.ts';
import { damagePlayer } from '../src/shared/sim/combat.ts';
import { armorByte, armorSpots } from '../src/shared/sim/packs.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { createWorld, type Player, type World } from '../src/shared/sim/world.ts';
import { fillSnapshot, makeSnapshotEncoder } from '../src/shared/wire.ts';
import { emptyWorld, PISTOL, press, run, spawnAt, TICK_MS } from './helpers.ts';

const hit = (w: World, victim: Player, amount: number, piercing = false) =>
  damagePlayer(w, victim, amount, { attacker: null, team: null, label: 'Test', piercing, via: 'bullet', fromX: victim.x - 100, fromY: victim.y });
const alive = (p: Player) => { assert.equal(p.life.k, 'alive'); return p.life as Extract<Player['life'], { k: 'alive' }>; };

test('every armor tier has a pool, heavier tiers soak more raw damage, and no armor has none', () => {
  assert.equal(ARMORS.none.points, 0);
  let soaked = 0;
  for (const a of ARMOR_IDS.slice(1)) {
    const raw = ARMORS[a].points / ARMORS[a].blockFrac;
    assert.ok(raw > soaked, `${a} lasts longer than the tier below (${raw} raw)`);
    soaked = raw;
  }
});

test('armor wears down: the share it stops comes off its pool', () => {
  const w = emptyWorld();
  const p = spawnAt(w, 500, 500, { loadout: { armor: 'medium' } });
  assert.equal(alive(p).armor, ARMORS.medium.points, 'a fresh life starts full');
  hit(w, p, 20);
  const blocked = 20 * ARMORS.medium.blockFrac;
  assert.equal(alive(p).hp, WORLD.baseHp - (20 - blocked));
  assert.ok(Math.abs(alive(p).armor - (ARMORS.medium.points - blocked)) < 1e-9);
});

test('an empty pool blocks nothing, and a nearly empty one only what it holds', () => {
  const w = emptyWorld();
  const p = spawnAt(w, 500, 500, { loadout: { armor: 'heavy' } });
  alive(p).armor = 1;
  hit(w, p, 20);
  assert.equal(alive(p).hp, WORLD.baseHp - 19, 'the last point stops one point of damage');
  assert.equal(alive(p).armor, 0);
  hit(w, p, 20);
  assert.equal(alive(p).hp, WORLD.baseHp - 19 - 20, 'empty, the hit lands whole');
  assert.equal(alive(p).armor, 0);
  assert.equal(armorShare('heavy', 0), 0);
  assert.equal(armorShare('heavy'), ARMORS.heavy.blockFrac, 'full by default');
  assert.deepEqual(armorBlock('none', 0, 30), { amount: 30, points: 0 });
});

test('AP rounds pass armor without wearing it', () => {
  const w = emptyWorld();
  const p = spawnAt(w, 500, 500, { loadout: { armor: 'light' } });
  hit(w, p, 30, true);
  assert.equal(alive(p).hp, WORLD.baseHp - 30);
  assert.equal(alive(p).armor, ARMORS.light.points);
});

test('a respawn refills the pool', () => {
  const w = emptyWorld();
  const p = spawnAt(w, 500, 500, { loadout: { armor: 'heavy' } });
  alive(p).armor = 3;
  hit(w, p, 500);
  assert.equal(p.life.k, 'dead');
  run(w, WORLD.respawnMs + 100);
  assert.ok(canRespawn(w, p.id));
  assert.ok(respawn(w, p.id, { ...PISTOL, armor: 'heavy' }));
  assert.equal(alive(p).armor, ARMORS.heavy.points);
});

test('the gun breakpoints hold against full armor: the pool never runs out before the hit that kills from full health', () => {
  for (const gun of GUN_IDS) {
    const g = GUNS[gun];
    const hits: number[] = [];
    for (let i = 0; i < 40; i++) { for (let k = 0; k < g.pellets; k++) hits.push(g.damage); if (g.blast) hits.push(g.blast.damage); }
    for (const a of ARMOR_IDS) {
      const count = (wear: boolean) => {
        let hp = WORLD.baseHp, pts = ARMORS[a].points, n = 0;
        for (const h of hits) {
          if (hp <= 0) break;
          if (wear) { const r = armorBlock(a, pts, h); hp -= r.amount; pts = r.points; } else hp -= h * (1 - ARMORS[a].blockFrac);
          n++;
        }
        return n;
      };
      assert.equal(count(true), count(false), `${gun} through ${a}`);
    }
  }
});

/** A world with one armor pack at (`x`, `y`), nothing else on the floor. */
function packWorld(x = 800, y = 800): World {
  const w = emptyWorld();
  w.packs = [{ id: 9999, x, y, respawnAt: null }];
  return w;
}

const gains = (events: readonly GameEvent[]) => events.filter((e): e is Extract<GameEvent, { e: 'gain' }> => e.e === 'gain');

test('walking over an armor pack refills the pool, says so, and takes the pack away until it respawns', () => {
  const w = packWorld();
  const p = spawnAt(w, 800, 800, { loadout: { armor: 'medium' } });
  alive(p).armor = 5;
  step(w, TICK_MS);
  assert.equal(alive(p).armor, ARMORS.medium.points);
  assert.deepEqual(gains(w.events).map((e) => [e.from, e.armor]), [['armor', ARMORS.medium.points - 5]]);
  assert.ok(w.events.some((e) => e.e === 'pack' && e.k === 'pick' && e.x === 800 && e.y === 800));
  const pack = w.packs[0]!;
  assert.equal(pack.respawnAt, w.now + ARMOR_PACK.respawnMs);
  assert.ok(ARMOR_PACK.respawnMs >= 30_000 && ARMOR_PACK.respawnMs <= 45_000);
  // Worn again while the pack is gone: standing on its spot gives nothing.
  alive(p).armor = 5;
  run(w, ARMOR_PACK.respawnMs - 2000);
  assert.equal(alive(p).armor, 5, 'no pack, no refill');
  assert.equal(snapshotFor(w, p.id).packs?.length, 0);
  run(w, 2500);
  assert.equal(alive(p).armor, ARMORS.medium.points, 'the pack came back on its timer and was taken again');
});

test('a full pool, or no armor at all, leaves the pack lying', () => {
  for (const armor of ['heavy', 'none'] as ArmorId[]) {
    const w = packWorld();
    const p = spawnAt(w, 800, 800, { loadout: { armor } });
    run(w, 500);
    assert.equal(w.packs[0]!.respawnAt, null, `${armor}: not consumed`);
    assert.equal(gains(w.events).length, 0);
    assert.equal(alive(p).armor, ARMORS[armor].points);
  }
});

test('a pack goes only to a body within its reach', () => {
  const w = packWorld();
  const p = spawnAt(w, 800 + ARMOR_PACK.pickR + 10, 800, { loadout: { armor: 'light' } });
  alive(p).armor = 0;
  step(w, TICK_MS);
  assert.equal(alive(p).armor, 0);
  press(w, p, { left: true });
  run(w, 500);
  assert.equal(alive(p).armor, ARMORS.light.points);
});

const turn = (map: MapId, s: { x: number; y: number }) => ({ x: MAPS[map].size - s.x, y: MAPS[map].size - s.y });

test('every versus map lays four armor packs, in half-turn twin pairs, on open floor a player can reach', () => {
  const versus = new Set([...ROTATION.FFA, ...ROTATION.TDM, ...ROTATION.DOM]);
  for (const map of MAP_IDS) {
    const spots = armorSpots(map);
    if (!versus.has(map)) { assert.equal(spots.length, 0, `${map} has none`); continue; }
    assert.equal(spots.length, 4, map);
    const open = new Set(openSpots(map, 56, 300).map((s) => `${s.x},${s.y}`));
    for (let i = 0; i < spots.length; i += 2) assert.deepEqual(spots[i + 1], turn(map, spots[i]!), `${map}: pair ${i / 2} are twins`);
    for (const s of spots) assert.ok(open.has(`${s.x},${s.y}`), `${map}: ${s.x},${s.y} is open and reachable`);
  }
});

test('packs lie in FFA, TDM, DOM and Last Squad, and not in Zombies or the range', () => {
  for (const mode of ['FFA', 'TDM', 'DOM', 'BR'] as const) assert.equal(createWorld(mode, 1, ROTATION[mode][0]).packs.length, 4, mode);
  for (const mode of ['ZOM', 'RNG'] as const) assert.equal(createWorld(mode, 1, ROTATION[mode][0]).packs.length, 0, mode);
});

test('armor points ride as a byte: absent when full, never 0 while any is left, 0 when empty', () => {
  assert.equal(armorByte(72, 72), 255);
  assert.equal(armorByte(0, 72), 0);
  assert.equal(armorByte(0.01, 72), 1);
  assert.equal(armorByte(36, 72), 128);
  assert.equal(armorByte(5, 0), 0);
  const w = emptyWorld();
  const p = spawnAt(w, 500, 500, { loadout: { armor: 'heavy' } });
  const viewOf = () => snapshotFor(w, p.id).players.find((v) => v.id === p.id)!;
  assert.equal(viewOf().ap, undefined, 'full: nothing on the wire');
  alive(p).armor = 18;
  assert.equal(viewOf().ap, 64);
  alive(p).armor = 0;
  assert.equal(viewOf().ap, 0);
  const bare = spawnAt(w, 700, 500);
  assert.equal(snapshotFor(w, bare.id).players.find((v) => v.id === bare.id)!.ap, undefined, 'no armor: nothing on the wire');
});

test('packs and armor points round-trip through the encoder; packs ride only when they change', () => {
  const w = createWorld('FFA', 3, ROTATION.FFA[0]);
  const [spot] = armorSpots(w.map);
  const p = spawnAt(w, spot!.x + 200, spot!.y, { name: 'Taker', loadout: { armor: 'medium' } });
  alive(p).armor = 10;
  const encode = makeSnapshotEncoder(), plain = (snap: Snapshot): Snapshot => JSON.parse(makeSnapshotEncoder()(snap));
  let last: Snapshot | null = null, sent = 0;
  for (let tick = 0; tick < 60; tick++) {
    press(w, p, { left: tick >= 10 && tick < 40, angle: Math.PI });
    step(w, TICK_MS);
    const snap = snapshotFor(w, p.id);
    const wire = JSON.parse(encode(snap)) as SnapshotWire;
    if (wire.packs !== undefined) sent++;
    const filled = fillSnapshot(wire, last);
    assert.deepEqual(filled, plain(snap), `tick ${tick}`);
    last = filled;
  }
  assert.equal(alive(p).armor, ARMORS.medium.points, 'walked onto the pack');
  assert.equal(last?.packs?.length, 3, 'one pack gone from the client too');
  assert.equal(last?.players.find((v) => v.id === p.id)?.ap, undefined, 'full again: off the wire');
  assert.equal(sent, 2, 'the pack list rode once at the start and once when the pack was taken');
});

test('the client pops an armor chip for what a pack gave you', async () => {
  const { gainsOf } = await import('../src/client/pickups.ts');
  assert.deepEqual(gainsOf([{ e: 'gain', id: 4, from: 'armor', armor: 31 }, { e: 'gain', id: 5, from: 'armor', armor: 9 }], 4), [{ armor: 31 }]);
});
