/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TurretKind, ZombieKind } from '../src/shared/defs.ts';
import { buildMatrix, dominatedPairs, upgradeRoi, winsOf } from '../scripts/lib/zombiebuilds.ts';

// What a scrap buys (scripts/bench-zombie-builds.ts has the whole table): each buildable in the scripted lane of scripts/lib/zombiebuilds.ts, the core
// walled in and the horde streaming in from the south. The runs are seeded, so the numbers are the same every time.
const rows = buildMatrix({ seeds: [1], nights: [5], ms: 60_000 });

test('no buildable is dominated: none is at least as good as another on every axis and better on one', () => {
  assert.deepEqual(dominatedPairs(rows), [], rows.map((r) => `${r.name}: ${JSON.stringify(r.at)}`).join('\n'));
});

test('every turret, wall tier and utility is the best of its kind somewhere, and each is the buy it is meant to be', () => {
  const wins = winsOf(rows);
  for (const [name, axes] of wins) assert.ok(axes.length > 0, `${name} wins nowhere`);
  const has = (name: string, axis: string) => assert.ok(wins.get(name)?.includes(axis as never), `${name} wins ${wins.get(name)?.join(', ')}, not ${axis}`);
  has('Sentry', 'cheap');
  has('Scatter', 'vsRunner');
  has('Cannon', 'vsBrute');
  has('Mortar', 'vsPlated');
  has('Mortar', 'range');
  has('Tesla coil', 'vsMix');
  has('Barricade', 'cheap');
  has('Barricade', 'mendSpeed');
  has('Sandbag wall', 'hpPerScrap');
  has('Steel wall', 'hpPerCell');
  has('Steel wall', 'burstHpPerScrap');
  has('Ammo depot', 'resupply');
  has('Repair post', 'mending');
  has('Spike strip', 'slow');
});

test('a step up pays at least what a second level-I copy would where the turret is built for, and a maxed turret is not twice the buy of a fresh one', () => {
  // Each turret against what it is for: the cheap sentry and the coil against the night's own mix, the rest against their kind.
  const niche: Record<TurretKind, ZombieKind[] | undefined> = { sentry: undefined, scatter: ['runner'], cannon: ['brute'], mortar: ['plated'], tesla: undefined };
  for (const [kind, kinds] of Object.entries(niche) as [TurretKind, ZombieKind[] | undefined][]) {
    const roi = upgradeRoi(kind, { kinds, nights: kinds ? [5] : [3, 5, 7], ms: 60_000 });
    const say = `${kind}: copy ${roi.copy.toFixed(1)}, steps ${roi.steps.map((s) => s.toFixed(1)).join(' ')}, levels ${roi.levels.map((s) => s.toFixed(1)).join(' ')}`;
    assert.ok(roi.steps.every((s) => s >= roi.copy), say);
    assert.ok(roi.levels[2] < 2 * roi.levels[0], say);
  }
});
