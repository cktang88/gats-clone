/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILDING_KINDS, WALL_TIERS, ZOM } from '../src/shared/defs.ts';
import { MAPS } from '../src/shared/maps.ts';
import { parseClientMsg } from '../src/shared/protocol.ts';
import { lineCells, linesOf, planLine } from '../src/shared/sim/build.ts';
import { build, buildLine } from '../src/shared/sim/run.ts';
import { snapshotFor, wallViews } from '../src/shared/sim/snapshot.ts';
import { createWorld, newId } from '../src/shared/sim/world.ts';
import { buildSiteOf, lineGhostAt } from '../src/client/zombies.ts';
import { spawnAt } from './helpers.ts';

/** The builder stands just west of the core; column 26 beside them runs north and south within reach. */
const AT = { x: 1380, y: 1525 };
const column = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => [26, from + i] as [number, number]);

function dayWorld() {
  const w = createWorld('ZOM', 1, 'outpost');
  const p = spawnAt(w, AT.x, AT.y);
  return { w, p };
}
const wallsAt = (w: ReturnType<typeof dayWorld>['w']) => w.buildings.filter((b) => b.kind === 'wall').map((b) => [b.cx, b.cy]).sort((a, b) => a[1]! - b[1]!);

test('a drag lays a straight line from where it began along the axis it went farther, capped', () => {
  const at = (cx: number, cy: number) => ({ cx, cy });
  assert.deepEqual(lineCells(at(10, 10), at(14, 11)), [at(10, 10), at(11, 10), at(12, 10), at(13, 10), at(14, 10)], 'mostly across: a row, the drift down ignored');
  assert.deepEqual(lineCells(at(10, 10), at(9, 7)), [at(10, 10), at(10, 9), at(10, 8), at(10, 7)], 'mostly up: a column, toward the cursor');
  assert.deepEqual(lineCells(at(10, 10), at(7, 13)), [at(10, 10), at(9, 10), at(8, 10), at(7, 10)], 'a tie lays a row');
  assert.deepEqual(lineCells(at(10, 10), at(10, 10)), [at(10, 10)], 'a press let go where it began is one cell');
  const long = lineCells(at(0, 5), at(40, 6));
  assert.equal(long.length, ZOM.lineMax);
  assert.ok(long.every((c, i) => c.cx === i && c.cy === 5));
  for (const [dx, dy] of [[3, 1], [-5, 2], [1, -6], [-2, 9], [0, 0], [4, -4]] as const) {
    const cells = lineCells(at(20, 20), at(20 + dx, 20 + dy));
    assert.ok(cells.every((c) => c.cy === 20) || cells.every((c) => c.cx === 20), `${dx},${dy} is straight`);
  }
});

test('the server builds a line cell by cell, charging each wall it puts up', () => {
  const { w, p } = dayWorld();
  w.run!.scrap = 500;
  const refusals = buildLine(w, p.id, 'wall', column(27, 33), 2);
  assert.deepEqual(refusals, Array(7).fill(null));
  assert.deepEqual(wallsAt(w), column(27, 33));
  assert.ok(w.buildings.every((b) => b.lv === 2));
  assert.equal(w.run!.scrap, 500 - 7 * WALL_TIERS[1].cost);
  assert.equal(w.run!.stats.get(p.id)?.built, 7);
});

test('a line passes over the cells it cannot build and stops short where the scrap runs out', () => {
  const { w, p } = dayWorld();
  w.buildings.push({ id: newId(w), kind: 'wall', cx: 26, cy: 29, hp: 1 });
  w.walls.push({ x: 26 * ZOM.cell + 10, y: 31 * ZOM.cell, w: 20, h: 20, built: true, expiresAt: Infinity });
  w.run!.scrap = 4 * WALL_TIERS[0].cost + 5;
  const cells = column(27, 34);
  const site = buildSiteOf(snapshotFor(w, p.id), wallViews(w), p)!;
  const preview = planLine(site, 'wall', cells.map(([cx, cy]) => ({ cx, cy })));
  const refusals = buildLine(w, p.id, 'wall', cells);
  assert.deepEqual(refusals, [null, null, 'taken', null, 'cover', null, 'scrap', 'scrap']);
  assert.deepEqual(preview.map((c) => c.refusal), refusals, "the client's preview judges the line as the server builds it");
  assert.equal(w.run!.scrap, 5);
  assert.deepEqual(wallsAt(w), [[26, 27], [26, 28], [26, 29], [26, 30], [26, 32]]);
});

test('a line out past reach, at night, or of a kind that is not laid in lines builds nothing', () => {
  {
    const { w, p } = dayWorld();
    const refusals = buildLine(w, p.id, 'wall', Array.from({ length: 8 }, (_, i) => [26 - i, 30] as [number, number]));
    assert.deepEqual(refusals.slice(0, 4), [null, null, null, null]);
    assert.ok(refusals.slice(5).every((r) => r === 'outOfReach'), JSON.stringify(refusals));
  }
  {
    const { w, p } = dayWorld();
    w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
    p.gun = 'assault';
    const scrap = w.run!.scrap;
    assert.ok(buildLine(w, p.id, 'wall', column(28, 30)).every((r) => r === 'notDay'));
    assert.deepEqual([w.buildings.length, w.run!.scrap], [0, scrap]);
  }
  {
    const { w, p } = dayWorld();
    w.run!.scrap = 1000;
    assert.ok(buildLine(w, p.id, 'sentry', column(28, 30)).every((r) => r !== null));
    assert.ok(buildLine(w, p.id, 'wall', column(14, 14 + ZOM.lineMax)).every((r) => r !== null), 'longer than the cap');
    assert.deepEqual([w.buildings.length, w.run!.scrap], [0, 1000]);
  }
  {
    const { w, p } = dayWorld();
    assert.deepEqual(buildLine(w, p.id, 'spikes', column(28, 30)), [null, null, null]);
    assert.equal(w.floor.length, 3);
  }
  assert.deepEqual(BUILDING_KINDS.filter(linesOf), ['wall', 'spikes']);
});

test('a single build is the line of one', () => {
  const a = dayWorld(), b = dayWorld();
  assert.equal(build(a.w, a.p.id, 'wall', 26, 30), null);
  assert.deepEqual(buildLine(b.w, b.p.id, 'wall', [[26, 30]]), [null]);
  assert.deepEqual([a.w.run!.scrap, wallsAt(a.w)], [b.w.run!.scrap, wallsAt(b.w)]);
});

test("the line's ghost shows every cell, red where it is passed over, and what the line costs", () => {
  const { w, p } = dayWorld();
  w.buildings.push({ id: newId(w), kind: 'wall', cx: 26, cy: 29, hp: 10 });
  w.run!.scrap = 3 * WALL_TIERS[0].cost;
  const site = buildSiteOf(snapshotFor(w, p.id), wallViews(w), p)!;
  const g = lineGhostAt(site, 'wall', { cx: 26, cy: 27 }, { x: 26.5 * ZOM.cell + 30, y: 32.5 * ZOM.cell }, MAPS[w.map].size, 1);
  assert.deepEqual(g.line!.map((c) => [c.cx, c.cy, c.refusal]), [[26, 27, null], [26, 28, null], [26, 29, 'taken'], [26, 30, null], [26, 31, 'scrap'], [26, 32, 'scrap']]);
  assert.deepEqual([g.cx, g.cy, g.refusal], [26, 32, null]);
  assert.equal(g.label, `Barricade × 3 of 6 · ${3 * WALL_TIERS[0].cost} scrap`);
  assert.equal(g.detail, '1 taken · 2 short of scrap');
});

test('a line message parses, and a crooked, gapped, overlong or turret line is refused', () => {
  assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'build', kind: 'wall', cells: [[3, 4], [4, 4], [5, 4]], lv: 3 })), { t: 'build', kind: 'wall', cells: [[3, 4], [4, 4], [5, 4]], lv: 3 });
  assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'build', kind: 'spikes', cells: [[3, 9], [3, 8]] })), { t: 'build', kind: 'spikes', cells: [[3, 9], [3, 8]] });
  assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'build', kind: 'wall', cells: [[3, 9]] })), { t: 'build', kind: 'wall', cells: [[3, 9]] });
  const long = Array.from({ length: ZOM.lineMax + 1 }, (_, i) => [i, 2]);
  const bad: unknown[] = [
    { kind: 'wall', cells: [] }, { kind: 'wall', cells: long }, { kind: 'wall', cells: 'x' }, { kind: 'wall', cells: { 0: [1, 1] } },
    { kind: 'wall', cells: [[1, 1], [2, 2]] }, { kind: 'wall', cells: [[1, 1], [3, 1]] }, { kind: 'wall', cells: [[1, 1], [2, 1], [1, 1]] }, { kind: 'wall', cells: [[1, 1], [2, 1], [3, 2]] },
    { kind: 'wall', cells: [[1, 1], [1, 1]] }, { kind: 'wall', cells: [[1, 1], [2, 1], [2, 2]] }, { kind: 'wall', cells: [[1.5, 1]] }, { kind: 'wall', cells: [[-1, 1]] },
    { kind: 'wall', cells: [[1, 1, 1]] }, { kind: 'wall', cells: [['1', 1]] }, { kind: 'wall', cells: [[1e9, 1]] }, { kind: 'wall', cells: [null] },
    { kind: 'sentry', cells: [[1, 1], [2, 1]] }, { kind: 'depot', cells: [[1, 1]] }, { kind: 'nope', cells: [[1, 1]] },
    { kind: 'wall', cells: [[1, 1]], cx: 1, cy: 1 }, { kind: 'wall', cells: [[1, 1]], lv: 4 },
  ];
  for (const b of bad) assert.equal(parseClientMsg(JSON.stringify({ t: 'build', ...(b as object) })), null, JSON.stringify(b));
});
