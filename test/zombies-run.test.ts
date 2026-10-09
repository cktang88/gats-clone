import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILDINGS, hordeCount, LEVELS, NIGHTS, SIDES, ZOM, ZOMBIE_KINDS, ZOMBIES, type Side, type ZombieKind } from '../src/shared/defs.ts';
import { MAPS } from '../src/shared/maps.ts';
import { toggleReady } from '../src/shared/sim/run.ts';
import { hurtCore } from '../src/shared/sim/horde.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { createWorld, newId, type World } from '../src/shared/sim/world.ts';
import { run, spawnAt, TICK_MS } from './helpers.ts';
import { step } from '../src/shared/sim.ts';

const zomWorld = (): World => createWorld('ZOM', 1, 'outpost');
const phaseOf = (w: World) => w.run!.phase.k;

const SPAWN_EDGE_SLACK_PX = 40;
const onSide = (side: Side, x: number, y: number) => {
  const r = MAPS.outpost.siege!.horde[side];
  return x >= r.x - SPAWN_EDGE_SLACK_PX && x <= r.x + r.w + SPAWN_EDGE_SLACK_PX && y >= r.y - SPAWN_EDGE_SLACK_PX && y <= r.y + r.h + SPAWN_EDGE_SLACK_PX;
};

/** Everything night `night`'s row sends a squad with this share of the horde. */
const nightSize = (night: number, share: number) => Object.entries(NIGHTS[night - 1]!.horde).reduce((n, [k, listed]) => n + hordeCount(k as ZombieKind, listed, share), 0);

function runUntil(w: World, done: () => boolean, maxMs: number) {
  for (let t = 0; t < maxMs && !done(); t += TICK_MS) step(w, TICK_MS);
  assert.ok(done(), `condition not met within ${maxMs}ms`);
}

test('a run opens on a day with the starting scrap and a whole core, and night falls when the day runs out', () => {
  const w = zomWorld();
  assert.deepEqual({ phase: phaseOf(w), night: w.run!.night, scrap: w.run!.scrap, core: w.run!.core.hp }, { phase: 'day', night: 1, scrap: ZOM.startScrap, core: ZOM.coreHp });
  run(w, ZOM.dayMs - 500);
  assert.equal(phaseOf(w), 'day');
  run(w, 1000);
  assert.equal(phaseOf(w), 'night');
});

test('the night trickles its wave in from the horde edges and stays dark until the whole wave is spawned and dead', () => {
  const w = zomWorld();
  w.run!.core.hp = 1e9;
  for (let i = 0; i < 4; i++) spawnAt(w, 1380, 1450 + i * 30, { kind: i === 0 ? 'human' : 'bot' });
  run(w, ZOM.dayMs + TICK_MS);
  const night = w.run!.phase;
  assert.ok(night.k === 'night');
  const wave = night.toSpawn.reduce((n, u) => n + u.n, 0) + w.zombies.length;
  assert.equal(wave, nightSize(1, ZOM.hordeShare({ humans: 1, bots: 3 })));
  const seen = new Set<number>();
  for (let t = 0; t < 1000; t += TICK_MS) {
    for (const z of w.zombies.filter((z) => !seen.has(z.id))) {
      seen.add(z.id);
      assert.ok(SIDES.some((side) => onSide(side, z.x, z.y)), `zombie at ${z.x},${z.y} came from no edge`);
    }
    step(w, TICK_MS);
  }
  assert.ok(w.zombies.length > 1 && w.zombies.length < wave, `${w.zombies.length} of ${wave} spawned after a second`);

  w.zombies = [];
  run(w, TICK_MS * 2);
  assert.equal(phaseOf(w), 'night', 'killing what has spawned does not end the night while more are to come');

  runUntil(w, () => w.run!.phase.k === 'night' && w.run!.phase.toSpawn.length === 0, 120_000);
  assert.ok(w.zombies.length > 0);
  run(w, 1000);
  assert.equal(phaseOf(w), 'night', 'a fully spawned wave still alive holds the night');

  w.zombies = [];
  run(w, TICK_MS);
  assert.deepEqual({ phase: phaseOf(w), night: w.run!.night }, { phase: 'day', night: 2 });
});

test('the core falling ends the run with the night reached, and the restart wipes the run and everyone\'s progress', () => {
  const w = zomWorld();
  const p = spawnAt(w, 1300, 1500, { kind: 'human' });
  run(w, ZOM.dayMs + 2000);
  p.score = LEVELS[3].score;
  p.level = 3;
  p.kills = 7;
  w.run!.scrap = 3;
  w.buildings.push({ id: newId(w), kind: 'wall', cx: 25, cy: 25, hp: BUILDINGS.wall.hp });
  w.run!.core.hp = 0;
  run(w, TICK_MS);
  const over = w.run!.phase;
  assert.ok(over.k === 'over');
  assert.equal(over.night, 1);
  assert.equal(w.zombies.length, 0, 'the horde leaves the field once the core falls');

  run(w, ZOM.restartMs - 1000);
  assert.equal(phaseOf(w), 'over');
  run(w, 1000 + TICK_MS);
  assert.deepEqual(
    { phase: phaseOf(w), night: w.run!.night, scrap: w.run!.scrap, core: w.run!.core.hp, buildings: w.buildings.length, score: p.score, level: p.level, kills: p.kills, alive: p.life.k },
    { phase: 'day', night: 1, scrap: ZOM.startScrap, core: ZOM.coreHp, buildings: 0, score: 0, level: 0, kills: 0, alive: 'alive' },
  );
  // The restart ends the run's life as a versus round's restart ends one, so the score it wipes is still paid to the profile.
  assert.deepEqual(w.lifeRecords.filter((r) => r.id === p.id).map((r) => ({ score: r.score, died: r.died })), [{ score: LEVELS[3].score, died: false }]);
});


function eveOf(night: number): World {
  const w = zomWorld();
  for (let i = 0; i < 4; i++) spawnAt(w, 1380, 1450 + i * 30);
  w.run!.core.hp = 1e9;
  w.run!.night = night;
  return w;
}

test('each night spawns its row of the night table, every zombie from one of the sides it names', () => {
  for (const night of [1, 4, 5, 10]) {
    const w = eveOf(night);
    run(w, ZOM.dayMs + TICK_MS);
    const counts = new Map<ZombieKind, number>();
    const row = NIGHTS[night - 1]!;
    const strays: string[] = [];
    runUntil(w, () => {
      for (const z of w.zombies) {
        counts.set(z.kind, (counts.get(z.kind) ?? 0) + 1);
        if (!row.from.some((side) => onSide(side, z.x, z.y))) strays.push(`${z.kind} at ${z.x.toFixed(0)},${z.y.toFixed(0)}`);
      }
      w.zombies = [];
      return w.run!.phase.k === 'night' && w.run!.phase.toSpawn.length === 0;
    }, 300_000);
    assert.deepEqual(Object.fromEntries(ZOMBIE_KINDS.flatMap((k) => (counts.get(k) ? [[k, counts.get(k)]] : []))), row.horde, `night ${night} brings its row`);
    assert.deepEqual(strays, [], `night ${night} comes only from the ${row.from.join(', ')}`);
  }
});

test('a lone human\'s night brings at least one of every kind on its row', () => {
  const w = zomWorld();
  spawnAt(w, 1380, 1450, { kind: 'human' });
  w.run!.core.hp = 1e9;
  w.run!.night = 5;
  run(w, ZOM.dayMs + TICK_MS);
  const night = w.run!.phase;
  assert.ok(night.k === 'night');
  assert.deepEqual(new Set([...night.toSpawn, ...w.zombies].map((u) => u.kind)), new Set(Object.keys(NIGHTS[4]!.horde)));
});

test('every bit of harm the core takes costs survivors, however well it is mended between, and losing the last loses the run', () => {
  const w = zomWorld();
  const r = w.run!;
  hurtCore(r, ZOM.survivorHp * 2.5);
  assert.deepEqual([r.survivors, r.lost], [ZOM.survivors - 2, 2]);
  r.core.hp = ZOM.coreHp;
  run(w, TICK_MS);
  assert.equal(r.survivors, ZOM.survivors - 2, 'mending the core raises no one');
  hurtCore(r, ZOM.survivorHp * 0.5);
  assert.equal(r.survivors, ZOM.survivors - 3, 'and the next bite after mending still counts the harm before it');
  r.core.hp = 1e9;
  hurtCore(r, ZOM.survivorHp * ZOM.survivors);
  run(w, TICK_MS);
  assert.ok(r.core.hp > 0, 'the core still stands');
  assert.deepEqual({ survivors: r.survivors, phase: phaseOf(w) }, { survivors: 0, phase: 'over' });
});

test('dawn pays the bank for every survivor left', () => {
  const w = zomWorld();
  run(w, ZOM.dayMs + TICK_MS);
  w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  w.zombies = [];
  w.run!.survivors = 37;
  const scrap = w.run!.scrap;
  run(w, TICK_MS);
  assert.deepEqual({ phase: phaseOf(w), paid: w.run!.scrap - scrap }, { phase: 'day', paid: 37 * ZOM.scrapPerSurvivor });
});

test('holding through the Tide ends the run won with the survivors counted, and only the Tide does', () => {
  const w = zomWorld();
  const p = spawnAt(w, 1300, 1500, { kind: 'human' });
  w.run!.night = NIGHTS.length - 1;
  w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  run(w, TICK_MS);
  assert.deepEqual({ phase: phaseOf(w), night: w.run!.night }, { phase: 'day', night: NIGHTS.length }, 'the night before the Tide dawns as any other');
  w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  hurtCore(w.run!, ZOM.survivorHp * 20);
  run(w, TICK_MS);
  const over = snapshotFor(w, p.id).run!;
  assert.deepEqual([over.phase, over.report?.night, over.report?.won, over.report?.survivors], ['over', NIGHTS.length, true, ZOM.survivors - 20]);
  assert.ok(w.run!.stats.has(p.id), 'the squad gets its report rows');
  run(w, ZOM.restartMs + TICK_MS);
  assert.deepEqual({ phase: phaseOf(w), night: w.run!.night }, { phase: 'day', night: 1 }, 'a fresh run follows the victory');
});

test('the night falls early once every living human is ready, and not before', () => {
  const w = zomWorld();
  const ann = spawnAt(w, 1300, 1500, { kind: 'human' }), bo = spawnAt(w, 1300, 1560, { kind: 'human' });
  const bot = spawnAt(w, 1300, 1620);
  toggleReady(w, ann.id);
  toggleReady(w, bot.id);
  run(w, 1000);
  assert.equal(phaseOf(w), 'day', 'one human of two ready, and a bot asking means nothing');
  toggleReady(w, ann.id);
  toggleReady(w, bo.id);
  run(w, 1000);
  assert.equal(phaseOf(w), 'day', 'ready taken back');
  toggleReady(w, ann.id);
  run(w, TICK_MS);
  assert.equal(phaseOf(w), 'night');
  assert.equal(w.run!.ready.size, 0, 'nightfall clears the ready');
  toggleReady(w, ann.id);
  assert.equal(w.run!.ready.size, 0, 'no readying by night');
});

test('a squad of bots alone waits out the day', () => {
  const w = zomWorld();
  for (let i = 0; i < 4; i++) spawnAt(w, 1380, 1450 + i * 30);
  run(w, ZOM.dayMs - 1000);
  assert.equal(phaseOf(w), 'day');
});

test('a boss comes alone for any squad, its health scaled by the squad\'s share of the horde, and shows whole', () => {
  for (const humans of [1, 4]) {
    const w = zomWorld();
    for (let i = 0; i < humans; i++) spawnAt(w, 1380, 1450 + i * 30, { kind: 'human' });
    w.run!.core.hp = 1e9;
    // Nobody shoots, so the horde's bites on the core would cost every survivor before the boss walks in.
    w.run!.survivors = 1e9;
    w.run!.night = 5;
    run(w, ZOM.dayMs + TICK_MS);
    const night = w.run!.phase;
    assert.ok(night.k === 'night');
    const share = ZOM.hordeShare({ humans, bots: 0 });
    assert.equal(night.toSpawn.filter((u) => u.kind === 'colossus').length + w.zombies.filter((z) => z.kind === 'colossus').length, 1, `${humans} humans meet one colossus`);
    runUntil(w, () => w.zombies.some((z) => z.kind === 'colossus'), 300_000);
    const colossus = w.zombies.find((z) => z.kind === 'colossus')!;
    assert.ok(Math.abs(colossus.hp - ZOMBIES.colossus.hp * ZOM.nightMul(5).hp * share) < ZOMBIES.colossus.hp * 0.05, `${humans} humans: ${colossus.hp} hp`);
    const view = snapshotFor(w, [...w.players.keys()][0]!).zombies!.find(([id]) => id === colossus.id);
    if (view) assert.ok(view[4] >= 9, 'its health bar reads near whole');
  }
});

test('a later night sends its packs in waves, several at once', () => {
  const w = eveOf(9);
  runUntil(w, () => phaseOf(w) === 'night', ZOM.dayMs + 1000);
  const night = w.run!.phase;
  assert.ok(night.k === 'night');
  const packs = night.toSpawn.length;
  step(w, TICK_MS);
  assert.ok(ZOM.packsPerWave(9) > 1);
  assert.equal(packs - night.toSpawn.length, ZOM.packsPerWave(9), 'the first wave brings its packs together');
  run(w, ZOM.packsPerWave(9) * ZOM.packGapMs(9) - 2 * TICK_MS);
  assert.equal(packs - night.toSpawn.length, ZOM.packsPerWave(9), 'and the next waits its turn');
});

test('first light burns what is left of the horde a while after its last pack walks in, for no scrap', () => {
  const w = eveOf(1);
  w.run!.phase = { k: 'night', toSpawn: [{ kind: 'brute', side: 'north', n: 1 }], nextSpawnAt: 0, dawnAt: Infinity };
  step(w, TICK_MS);
  const night = w.run!.phase;
  assert.ok(night.k === 'night' && night.toSpawn.length === 0 && Number.isFinite(night.dawnAt));
  assert.equal(snapshotFor(w, [...w.players.keys()][0]!).run!.phaseEndsAt, night.dawnAt, 'the client can count down to first light');
  for (const z of w.zombies) z.hp = 1e9;
  const scrap = w.run!.scrap;
  run(w, ZOM.stragglersMs - 1000);
  assert.equal(phaseOf(w), 'night', 'the night holds while the straggler lives');
  run(w, 1000 + 2 * TICK_MS);
  assert.deepEqual({ phase: phaseOf(w), zombies: w.zombies.length, night: w.run!.night }, { phase: 'day', zombies: 0, night: 2 });
  assert.equal(w.run!.scrap - scrap, w.run!.survivors * ZOM.scrapPerSurvivor, 'only the dawn pay, nothing for the burned');
});
