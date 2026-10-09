/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WORLD } from '../src/shared/defs.ts';
import { knifeLunge, moveStep, startDash, walks, KNIFE_LUNGE, type Motion } from '../src/shared/sim/movement.ts';
import { settleShare } from '../src/shared/sim/stats.ts';
import { emptyWorld, press, run, spawnAt } from './helpers.ts';

const SIZE = 3000;
const NO_KEYS = { up: false, down: false, left: false, right: false };

/** Steps `from` with `keys` for `ms` in `dtMs` ticks over open ground. */
function walk(from: Motion, keys: Partial<typeof NO_KEYS>, ms: number, dtMs: number, speed = 200): Motion {
  let m = from;
  for (let t = 0; t < ms - 1e-9; t += dtMs) m = moveStep([], m, { ...NO_KEYS, ...keys }, speed, dtMs, SIZE);
  return m;
}

test('walking covers speed px a second straight or diagonally: a diagonal is no faster', () => {
  const at: Motion = { x: 1000, y: 1000, dash: null };
  const straight = walk(at, { right: true }, 1000, 25);
  assert.ok(Math.abs(straight.x - 1200) < 1e-6 && straight.y === 1000, JSON.stringify(straight));
  const diagonal = walk(at, { right: true, down: true }, 1000, 25);
  assert.ok(Math.abs(Math.hypot(diagonal.x - 1000, diagonal.y - 1000) - 200) < 1e-6, `diagonal covered ${Math.hypot(diagonal.x - 1000, diagonal.y - 1000)}`);
  assert.ok(Math.abs(diagonal.x - diagonal.y) < 1e-9, 'at 45 degrees');
});

test('opposite keys cancel: holding left and right, or up and down, is standing still', () => {
  assert.equal(walks({ ...NO_KEYS, left: true, right: true }), false);
  assert.equal(walks({ ...NO_KEYS, up: true, down: true }), false);
  assert.equal(walks({ ...NO_KEYS, up: true, down: true, left: true }), true);
  const at: Motion = { x: 1000, y: 1000, dash: null };
  assert.deepEqual(walk(at, { left: true, right: true, up: true, down: true }, 500, 25), at);
  // In the sim, a body holding opposite keys counts as still, so its gun steadies.
  const w = emptyWorld();
  const p = spawnAt(w, 1000, 1000);
  press(w, p, { left: true, right: true });
  run(w, 500);
  assert.ok(p.life.k === 'alive' && w.now - p.life.lastMoveAt >= 400, 'the last step was long ago');
  assert.deepEqual([p.x, p.y], [1000, 1000]);
});

test('a dash covers its 240px and no more, however the ticks fall across its end', () => {
  for (const dtMs of [1000 / 30, 30, 45, 70]) {
    const m = walk({ x: 1000, y: 1000, dash: startDash({ ...NO_KEYS, right: true, angle: 2 }) }, {}, 600, dtMs);
    assert.ok(Math.abs(m.x - 1240) < 1e-6 && Math.abs(m.y - 1000) < 1e-9, `${dtMs}ms ticks: ended at ${m.x}, ${m.y}`);
    assert.equal(m.dash, null, 'and is over');
  }
  const still = startDash({ ...NO_KEYS, angle: Math.PI / 2 });
  assert.ok(Math.abs(still.dirX) < 1e-9 && Math.abs(still.dirY - 1) < 1e-9, 'with no keys it follows the aim');
  const diag = startDash({ ...NO_KEYS, up: true, left: true, angle: 0 });
  assert.ok(Math.abs(diag.dirX + Math.SQRT1_2) < 1e-9 && Math.abs(diag.dirY + Math.SQRT1_2) < 1e-9, 'keys win over the aim, as a unit direction');
});

test('a knife reaches only enemies in front of it: one beside or behind, in reach, is not cut', () => {
  const from = { x: 1000, y: 1000 };
  for (const [label, enemy] of [['behind', { x: 940, y: 1000 }], ['beside', { x: 1000, y: 1060 }]] as const) {
    const lunge = knifeLunge([], from, 0, [enemy], SIZE);
    assert.equal(lunge.victim, null, label);
    assert.ok(Math.abs(lunge.x - (from.x + KNIFE_LUNGE)) < 1e-6, `${label}: a whiff lunges the full way`);
  }
  assert.ok(knifeLunge([], from, 0, [{ x: 1080, y: 1030 }], SIZE).victim, 'one ahead and a little off the line is cut');
  assert.ok(knifeLunge([], from, 0, [{ x: 1000 + WORLD.playerRadius - 4, y: 1000 }], SIZE).victim, 'and one overlapping the knifer, whatever the angle');
});

test('after a sprint the post-sprint bloom eases out over settleMs, with no wait for the gun', () => {
  assert.equal(settleShare(500, 500), 1, 'full the moment the sprint ends');
  assert.equal(settleShare(250, 500), 0.5, 'halfway settled');
  assert.equal(settleShare(0, 500), 0);
  assert.equal(settleShare(900, 500), 1, 'never more than full');
  assert.equal(settleShare(300, 0), 0, 'a gun with no settle has none');
});
