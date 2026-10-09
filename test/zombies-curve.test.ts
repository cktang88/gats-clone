/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { playCurve } from '../scripts/lib/zombiecurve.ts';

// The difficulty curve (scripts/bench-zombie-curve.ts has the whole table): one human and three squad bots, the human a bot brain with a human's health and share.
// A squad that never builds must fall by night 3; the same seed with the human building on the squad bots' plan must hold past it.
for (const seed of [1, 3]) {
  test(`seed ${seed}: a squad that never builds falls by night 3, and one that builds holds past it`, () => {
    const passive = playCurve(seed, 1, 'passive', 3);
    assert.ok(passive.cause === 'core' || passive.cause === 'survivors', `the passive squad fell (${passive.cause}): ${passive.trace}`);
    assert.ok(passive.night <= 3, `the passive squad fell on night ${passive.night}: ${passive.trace}`);
    const building = playCurve(seed, 1, 'build', 3);
    assert.equal(building.cause, 'capped', `the building squad held through night 3: ${building.trace}`);
    assert.ok(building.built >= 4, `${building.built} buildings stood`);
  });
}
