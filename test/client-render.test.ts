/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLORS } from '../src/shared/defs.ts';
import { TEAM_COLORS } from '../src/client/palette.ts';
import { bodyColor, mapWallsKey } from '../src/client/render.ts';
import type { WallView } from '../src/shared/protocol.ts';

test('team modes draw bodies in the team color, whatever color was picked', () => {
  assert.equal(bodyColor({ color: 'blue', team: 'red' }), TEAM_COLORS.red);
  assert.equal(bodyColor({ color: 'red', team: 'blue' }), TEAM_COLORS.blue);
});

test('free for all keeps the picked color', () => {
  assert.equal(bodyColor({ color: 'purple', team: null }), COLORS.purple);
});

test("the ground is keyed by the map's own walls, so an engineer's wall coming or going never rebakes it", () => {
  const long: WallView = { x: 0, y: 0, w: 100, h: 50, built: false, material: 'concrete' };
  const block: WallView = { x: 300, y: 0, w: 50, h: 50, built: false, material: 'sandstone' };
  const map = [long, block];
  const built: WallView = { x: 500, y: 500, w: 120, h: 40, built: true };
  const withBuilt: WallView[] = [...map, built];
  assert.equal(mapWallsKey(withBuilt), mapWallsKey([...map]));
  assert.notEqual(mapWallsKey([long, { ...block, material: 'planter' }]), mapWallsKey(map), 'a map wall changing rebakes');
  assert.notEqual(mapWallsKey([long]), mapWallsKey(map), 'a map wall going rebakes');
});

test('a door glow drawn after a long frame is stamped with this frame\'s light clock, so it does not lapse the frame it is set', async () => {
  const { MAPS } = await import('../src/shared/maps.ts');
  const { WORLD } = await import('../src/shared/defs.ts');
  const { makeCamera } = await import('../src/client/camera.ts');
  const { createPool } = await import('../src/client/particles.ts');
  const { createCracks } = await import('../src/client/decals.ts');
  const { NO_FEEDBACK } = await import('../src/client/feedback.ts');
  const { drawWorld } = await import('../src/client/render.ts');
  const { resetLighting, resolveLights } = await import('../src/client/lighting.ts');
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'getTransform') return () => ({ a: 1 });
      if (prop === 'measureText') return () => ({ width: 0 });
      if (typeof prop === 'string' && prop.startsWith('create')) return () => ({ addColorStop() {}, setTransform() {} });
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  Object.assign(globalThis, { document: { createElement: () => ({ getContext: () => ctx }) } });
  const map = MAPS.plaza;
  const i = map.doors!.findIndex((d) => d.glow);
  const door = map.doors![i]!;
  const snap = {
    t: 'snap', tick: 1, ackSeq: 0, self: { nemesis: null, viewRadius: 900 }, players: [], bullets: [], crates: [], thrown: [], zones: [], minimap: [], leaderboard: [], events: [],
    match: { mode: 'FFA', map: 'plaza' }, doors: [[i, 255, 1]],
  } as unknown as import('../src/shared/protocol.ts').Snapshot;
  const s = { myId: 1, worldSize: map.size, walls: [], lastSelf: { x: door.x, y: door.y }, hurtAt: new Map(), cracks: createCracks(), effects: [], corpses: [], zombieCorpses: { list: [], dawnAt: null }, particles: createPool(), feedback: NO_FEEDBACK } as unknown as import('../src/client/state.ts').Session;
  const cam = makeCamera({ x: door.x, y: door.y }, 1280, 800, WORLD.viewRadius);
  resetLighting();
  const cx = door.x + (door.axis === 'h' ? door.w / 2 : 0), cy = door.y + (door.axis === 'h' ? 0 : door.w / 2);
  const glow = (now: number) => resolveLights(now).filter((l) => Math.hypot(l.x - cx, l.y - cy) < 1 && l.radius === 190);
  for (let now = 1000; now <= 2000; now += 16) drawWorld(ctx, { snap, s, cam, dpr: 1, now, selfAngle: null, killerId: null });
  assert.equal(glow(2000).length, 1, 'the open door spills its room\'s light');
  // A hitch: the next frame comes half a second later.
  drawWorld(ctx, { snap, s, cam, dpr: 1, now: 2500, selfAngle: null, killerId: null });
  assert.equal(glow(2500).length, 1, 'and still does on the frame after a hitch');
  resetLighting();
});
