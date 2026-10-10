/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WORLD } from '../src/shared/defs.ts';
import type { Snapshot, ThrownKind } from '../src/shared/protocol.ts';
import { step } from '../src/shared/sim.ts';
import { BLAST_RADIUS } from '../src/shared/sim/abilities.ts';
import { abilityHint } from '../src/client/hud.ts';
import { makeCamera } from '../src/client/camera.ts';
import { createPool } from '../src/client/particles.ts';
import { createCracks } from '../src/client/decals.ts';
import { drawWorld } from '../src/client/render.ts';
import type { Session } from '../src/client/state.ts';
import { emptyWorld, hpOf, spawnAt, TICK_MS } from './helpers.ts';

test('an empty ability slot says the score that unlocks it, from the level ladder', () => {
  assert.deepEqual(abilityHint(null), ['Ability', 'at 900']);
  assert.deepEqual(abilityHint({ level: 2, k: 'evolve' }), ['Ability', 'at 900']);
  assert.deepEqual(abilityHint({ level: 3, k: 'perk', tier: 2 }), ['Ability', 'at 900']);
  assert.deepEqual(abilityHint({ level: 4, k: 'perk', tier: 3 }), ['Pick an', 'ability'], 'once the ability tier is pending, the slot points at the perk dock');
});

type Arc = { x: number; y: number; r: number };

function arcsDrawnFor(kind: ThrownKind): Arc[] {
  const arcs: Arc[] = [];
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'arc') return (x: number, y: number, r: number) => arcs.push({ x, y, r });
      if (prop === 'measureText') return () => ({ width: 0 });
      if (typeof prop === 'string' && prop.startsWith('create')) return () => ({ addColorStop() {} });
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  Object.assign(globalThis, { document: { createElement: () => ({ getContext: () => ctx }) } });
  const snap = {
    players: [], bullets: [], crates: [], zones: [], minimap: [], leaderboard: [], events: [],
    thrown: [{ id: 1, kind, x: 1234, y: 987, r: 10, owner: 2 }], match: { map: 'Boneyard' }, self: { nemesis: null },
  } as unknown as Snapshot;
  const s = { myId: 1, worldSize: 3000, walls: [], hurtAt: new Map(), cracks: createCracks(), effects: [], corpses: [], zombieCorpses: { list: [], dawnAt: null }, particles: createPool(), feedback: { numbers: [] } } as unknown as Session;
  drawWorld(ctx, { snap, s, cam: makeCamera({ x: 1234, y: 987 }, 1280, 800, WORLD.viewRadius), dpr: 1, now: 0, selfAngle: null, killerId: null });
  return arcs.filter((a) => a.x === 1234 && a.y === 987);
}

test('a live grenade or frag grenade shows a danger ring at its blast radius', () => {
  for (const kind of ['fragGrenade', 'fragGrenade'] as const) {
    assert.ok(arcsDrawnFor(kind).some((a) => a.r === BLAST_RADIUS[kind]), `${kind} ring at ${BLAST_RADIUS[kind]}`);
  }
  assert.ok(!arcsDrawnFor('gasGrenade').some((a) => a.r > 20), 'a gas grenade has no blast ring');
});

test('the blast reaches exactly the bodies the ring touches', () => {
  for (const kind of ['fragGrenade', 'fragGrenade'] as const) {
    const w = emptyWorld();
    const owner = spawnAt(w, 200, 200);
    const reach = BLAST_RADIUS[kind] + WORLD.playerRadius;
    const inside = spawnAt(w, 1000 + reach - 2, 1000);
    const outside = spawnAt(w, 1000, 1000 + reach + 2);
    w.thrown.push({ id: 999, kind, owner: owner.id, team: owner.team, x: 1000, y: 1000, vx: 0, vy: 0, explodeAt: w.now });
    step(w, TICK_MS);
    assert.ok(hpOf(inside) < WORLD.baseHp, `${kind}: a body whose edge is inside the ring is hurt`);
    assert.equal(hpOf(outside), WORLD.baseHp, `${kind}: a body just outside the ring is untouched`);
  }
});
