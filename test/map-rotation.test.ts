import assert from 'node:assert/strict';
import { polyParts } from '../src/shared/mapgeo.ts';
import { test } from 'node:test';
import { WORLD, type ModeId } from '../src/shared/defs.ts';
import { MAP_MS, MAP_NOTICE_MS, MAPS, ROTATION, rotationMap, type MapId } from '../src/shared/maps.ts';

/** The first two maps a seed-1 room deals (the rotation is a seeded shuffle; see `rotationMap`). */
const dealt = (mode: keyof typeof ROTATION): [MapId, MapId] => [rotationMap(mode, 1, 0), rotationMap(mode, 1, 1)];
import { addPlayer } from '../src/shared/sim.ts';
import { circleHitsRect } from '../src/shared/sim/movement.ts';
import { snapshotFor, wallViews } from '../src/shared/sim/snapshot.ts';
import { createWorld, type World } from '../src/shared/sim/world.ts';
import type { Accounts } from '../src/server/accounts.ts';
import { createRoom } from '../src/server/room.ts';
import { fakeSocket, PISTOL, run, TICK_MS } from './helpers.ts';

/** A team player stands in its side's spawns; a free-for-all player anywhere clear on the new map. */
function assertStandingInSpawns(w: World, map: MapId) {
  for (const p of w.players.values()) {
    if (p.life.k !== 'alive') continue;
    const size = MAPS[map].size;
    assert.ok(p.x > 0 && p.y > 0 && p.x < size && p.y < size, `${p.name} at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}) is off the ${MAPS[map].name} map`);
    if (p.team === 'red' || p.team === 'blue') {
      const regions = MAPS[map].spawns[p.team];
      assert.ok(regions.some((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h), `${p.name} at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}) is outside the ${MAPS[map].name} spawns`);
    }
    assert.ok(!w.walls.some((wall) => circleHitsRect(p.x, p.y, WORLD.playerRadius, wall)), `${p.name} stands in a wall`);
  }
}

function populate(w: World) {
  for (let i = 0; i < 8; i++) addPlayer(w, `p${i}`, PISTOL);
}

for (const [mode, winScore, side] of [['TDM', WORLD.tdmWinScore, 'red'], ['DOM', WORLD.domWinScore, 'blue']] as const) {
  test(`${mode}: the round restart loads the next map and moves every living player into its spawns`, () => {
    const [first, second] = dealt(mode);
    const w = createWorld(mode, 1, first);
    populate(w);
    const viewer = [...w.players.values()][0];
    w.teamScore[side] = winScore;
    run(w, TICK_MS);
    const over = snapshotFor(w, viewer.id).match;
    assert.equal(over.map, MAPS[first].name);
    assert.equal(over.nextMap, MAPS[second].name);
    assert.ok(over.mapChangeIn > 0 && over.mapChangeIn <= WORLD.roundRestartMs, `announces the change ${over.mapChangeIn}ms ahead`);
    assert.equal(w.map, first, 'the map holds during the end-of-round banner');

    run(w, WORLD.roundRestartMs + 100);
    assert.equal(w.map, second);
    assert.equal(snapshotFor(w, viewer.id).match.map, MAPS[second].name);
    assert.deepEqual(wallViews(w), [...MAPS[second].walls, ...polyParts(MAPS[second])].map((r) => ({ ...r, built: false })));
    assert.equal(w.zones.length, mode === 'DOM' ? 3 : 0);
    assertStandingInSpawns(w, second);
  });
}

test('FFA announces the next map, then loads it on a timer and moves everyone into its spawns', () => {
  const [first, second] = dealt('FFA');
  const w = createWorld('FFA', 1, first);
  populate(w);
  const viewer = [...w.players.values()][0];
  run(w, MAP_MS.FFA - MAP_NOTICE_MS - 1000);
  assert.equal(snapshotFor(w, viewer.id).match.mapChangeIn, 0, 'quiet until the notice window');
  run(w, 2000);
  const notice = snapshotFor(w, viewer.id).match;
  assert.ok(notice.mapChangeIn > 0 && notice.mapChangeIn <= MAP_NOTICE_MS, `notice ${notice.mapChangeIn}`);
  assert.equal(notice.nextMap, MAPS[second].name);
  assert.equal(w.map, first);
  run(w, MAP_NOTICE_MS);
  assert.equal(w.map, second);
  assertStandingInSpawns(w, second);
});

test('FFA: the first human to the kill target wins the round, and the next round starts on the next map with kills reset', () => {
  const [first, second] = dealt('FFA');
  const w = createWorld('FFA', 1, first);
  populate(w);
  const viewer = [...w.players.values()][0];
  const leader = addPlayer(w, 'Human', PISTOL, { kind: 'human' });
  leader!.kills = WORLD.ffaWinKills - 1;
  viewer!.score = 500;
  run(w, TICK_MS);
  assert.equal(w.match.k, 'playing', 'one short of the target');
  leader!.kills = WORLD.ffaWinKills;
  run(w, TICK_MS);
  const over = snapshotFor(w, viewer!.id);
  assert.equal(over.match.winner?.name, leader!.name);
  assert.deepEqual(over.leaderboard[0], { id: leader!.id, name: leader!.name, score: leader!.score, kills: WORLD.ffaWinKills, deaths: 0, team: null, human: true }, 'the leaderboard ranks by kills');
  assert.equal(w.map, first, 'the map holds during the end-of-round banner');
  run(w, WORLD.roundRestartMs + 100);
  assert.deepEqual([w.match.k, w.map, leader!.kills], ['playing', second, 0]);
  assertStandingInSpawns(w, second);
});

test('FFA: a bot at the kill target does not end the round', () => {
  const w = createWorld('FFA', 1, rotationMap('FFA', 1, 0));
  populate(w);
  const bot = [...w.players.values()][0]!;
  bot.kills = WORLD.ffaWinKills + 5;
  run(w, MAP_MS.FFA - 1000);
  assert.equal(w.match.k, 'playing', 'the round runs to the timer');
  run(w, 1000 + TICK_MS);
  assert.equal(snapshotFor(w, bot.id).match.winner?.name, bot.name, 'the bot wins on the timer');
});

test('FFA: a timer finish with tied kills goes to the player with fewer deaths', () => {
  const w = createWorld('FFA', 1, rotationMap('FFA', 1, 0));
  populate(w);
  const [a, b] = [...w.players.values()];
  a!.kills = 6;
  a!.deaths = 4;
  b!.kills = 6;
  b!.deaths = 2;
  run(w, MAP_MS.FFA + TICK_MS);
  const over = snapshotFor(w, b!.id);
  assert.equal(over.match.winner?.name, b!.name);
  assert.equal(over.leaderboard[0]!.id, b!.id, 'the leaderboard breaks the tie the same way');
});

test('TDM: when the time limit runs out the team ahead wins, on kills if the score is level, and a dead heat starts a fresh round', () => {
  const finish = (red: number, blue: number, redKills: number, blueKills: number) => {
    const w = createWorld('TDM', 1, rotationMap('TDM', 1, 0));
    const [r, b] = [addPlayer(w, 'r', PISTOL, { team: 'red' }), addPlayer(w, 'b', PISTOL, { team: 'blue' })];
    r.kills = redKills;
    b.kills = blueKills;
    w.teamScore = { red, blue };
    run(w, MAP_MS.TDM - 1000);
    assert.equal(w.match.k, 'playing', 'the round runs to the limit');
    run(w, 1000 + TICK_MS);
    return { w, winner: snapshotFor(w, r.id).match.winner };
  };
  assert.deepEqual(finish(30, 34, 30, 34).winner, { name: 'Blue team', id: null, note: 'Time ran out' });
  assert.equal(finish(30, 30, 12, 9).winner?.name, 'Red team', 'level on score, red has more kills');
  const draw = finish(30, 30, 9, 9);
  assert.deepEqual([draw.w.match.k, draw.winner, draw.w.map, draw.w.teamScore], ['playing', null, rotationMap('TDM', 1, 1), { red: 0, blue: 0 }]);
});

test('the snapshot carries when the round\'s clock runs out, unchanged through the round, and a fresh time for the next one', () => {
  const w = createWorld('TDM', 1, rotationMap('TDM', 1, 0));
  const viewer = addPlayer(w, 'v', PISTOL, { team: 'red' });
  const endsAt = () => snapshotFor(w, viewer.id).match.roundEndsAt;
  assert.equal(endsAt(), MAP_MS.TDM);
  run(w, 60_000);
  assert.equal(endsAt(), MAP_MS.TDM, 'the same end time a minute in, so the match field is not resent');
  w.teamScore.red = WORLD.tdmWinScore;
  run(w, TICK_MS);
  assert.equal(endsAt(), null, 'no clock under the winner banner');
  run(w, WORLD.roundRestartMs + 100);
  assert.ok(endsAt()! - w.now > MAP_MS.TDM - 1000, 'the next round starts a full clock');
  const dom = createWorld('DOM', 1, rotationMap('DOM', 1, 0));
  assert.equal(snapshotFor(dom, addPlayer(dom, 'd', PISTOL).id).match.roundEndsAt, MAP_MS.DOM, 'DOM runs a clock too');
});

test('FFA: a timer finish with no kills starts a fresh round on the next map without a winner', () => {
  const [first, second] = dealt('FFA');
  const w = createWorld('FFA', 1, first);
  populate(w);
  const [a] = [...w.players.values()];
  a!.score = 150;
  a!.deaths = 3;
  run(w, MAP_MS.FFA + TICK_MS);
  const snap = snapshotFor(w, a!.id);
  assert.deepEqual([w.match.k, snap.match.winner, w.map], ['playing', null, second]);
  assert.deepEqual([a!.score, a!.deaths], [0, 0], 'the old round\'s score and deaths are cleared');
  assert.ok(w.mapChangeAt - w.now > MAP_MS.FFA - 1000, 'the new round runs a full timer of its own');
});

test('FFA: a human reaching the kill target behind a bot wins, says why, and keeps a place on the board', () => {
  const w = createWorld('FFA', 1, rotationMap('FFA', 1, 0));
  for (let i = 0; i < 12; i++) addPlayer(w, `bot${i}`, PISTOL).kills = 30 + i;
  const human = addPlayer(w, 'Kestrel', PISTOL, { kind: 'human' });
  human.kills = WORLD.ffaWinKills;
  run(w, TICK_MS);
  const over = snapshotFor(w, human.id);
  assert.deepEqual(over.match.winner, { name: 'Kestrel', id: human.id, note: `Kestrel reached ${WORLD.ffaWinKills} kills` });
  assert.equal(over.leaderboard.length, w.players.size, 'every player has a row');
  assert.ok(over.leaderboard.some((r) => r.id === human.id), 'the winner is on the board though twelve players out-killed them');
});

test('FFA: when the map timer runs out, the player with the most kills wins the round', () => {
  const [first, second] = dealt('FFA');
  const w = createWorld('FFA', 1, first);
  populate(w);
  const [a, b, viewer] = [...w.players.values()];
  a!.kills = 4;
  b!.kills = 7;
  run(w, MAP_MS.FFA + TICK_MS);
  assert.equal(snapshotFor(w, viewer!.id).match.winner?.name, b!.name);
  assert.equal(w.map, first);
  run(w, WORLD.roundRestartMs + 100);
  assert.equal(w.map, second);
});

test('a map change places players apart on the new map, not apart from where the others stood on the old one', () => {
  const close: string[] = [];
  for (let seed = 1; seed <= 60; seed++) {
    const w = createWorld('FFA', seed, rotationMap('FFA', seed, 0));
    for (let i = 0; i < 8; i++) addPlayer(w, `p${i}`, PISTOL);
    w.mapChangeAt = w.now;
    run(w, TICK_MS);
    const ps = [...w.players.values()];
    close.push(...ps.flatMap((a, i) => ps.slice(i + 1).filter((b) => Math.hypot(a.x - b.x, a.y - b.y) < 200).map((b) => `seed ${seed}: ${a.name}-${b.name}`)));
  }
  assert.deepEqual(close, [], 'eight players fit the FFA spawns with nobody on top of anyone');
});

test('a joined client receives the new map\'s walls when the round restarts', () => {
  const mode: ModeId = 'TDM';
  const [first, second] = dealt(mode);
  const room = createRoom('tdm', mode, 1, { stats: () => null, credit: () => {} } as unknown as Accounts);
  const ws = fakeSocket();
  room.connect(ws.socket);
  ws.send({ t: 'join', name: 'Tester', loadout: PISTOL, aspect: 1.5 });
  const welcome = ws.sent.find((m) => m.t === 'welcome');
  assert.ok(welcome && welcome.t === 'welcome');
  assert.deepEqual(welcome.walls, [...MAPS[first].walls, ...polyParts(MAPS[first])].map((r) => ({ ...r, built: false })));

  room.world.teamScore.red = WORLD.tdmWinScore;
  for (let t = 0; t <= WORLD.roundRestartMs + 500; t += TICK_MS) room.tick();
  ws.close();
  const walls = ws.sent.filter((m) => m.t === 'walls');
  assert.equal(walls.length, 1, 'one walls message for the one map change');
  assert.deepEqual(walls[0].t === 'walls' && walls[0].walls, [...MAPS[second].walls, ...polyParts(MAPS[second])].map((r) => ({ ...r, built: false })));
});

test('DOM: when both teams pass the target in the same tick, the team further ahead wins, not always red', () => {
  const w = createWorld('DOM', 1, dealt('DOM')[0]);
  w.teamScore = { red: WORLD.domWinScore + 0.05, blue: WORLD.domWinScore + 0.15 };
  run(w, TICK_MS);
  assert.ok(w.match.k === 'over', 'the round is over');
  assert.equal(w.match.winner.name, 'Blue team');
  const tie = createWorld('DOM', 1, dealt('DOM')[0]);
  tie.teamScore = { red: WORLD.domWinScore + 0.1, blue: WORLD.domWinScore + 0.1 };
  run(tie, TICK_MS);
  assert.ok(tie.match.k === 'over', 'a dead heat over the target still ends the round');
});
