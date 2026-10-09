import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_LEVEL, TURRET_KINDS, ZOM, type TurretKind } from '../src/shared/defs.ts';
import type { BuildingView } from '../src/shared/protocol.ts';
import { turretDef } from '../src/shared/sim/build.ts';
import { segmentBlocked, type Rect } from '../src/shared/sim/movement.ts';
import { blindSpots, fireOf, openArcs, rangeRings, ringOf } from '../src/client/turretrange.ts';
import { drawTurret, headBucket, HEAD_BUCKETS, kickOf, turretBakes, wearStage } from '../src/client/turretart.ts';
import { drawSiegeLights, onPad } from '../src/client/siege.ts';
import { sanitize } from '../src/client/settings.ts';
import type { Ghost } from '../src/client/zombies.ts';

/** A 2D context that does nothing but note each call, and a document whose canvases hand it out, counting how many are made. */
function fakeCanvas() {
  const calls: { name: string; args: unknown[] }[] = [];
  const made = { count: 0 };
  const ctx: CanvasRenderingContext2D = new Proxy({} as Record<string, unknown>, {
    get: (_, name: string) => {
      if (name === 'canvas') return { width: 64, height: 64 };
      if (name === 'getTransform') return () => ({ a: 2 });
      return (...args: unknown[]) => { calls.push({ name, args }); return { addColorStop() {} }; };
    },
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
  Object.assign(globalThis, { document: { createElement: () => { made.count++; return { width: 0, height: 0, getContext: () => ctx }; } } });
  return { ctx, calls, made };
}

const levels = Array.from({ length: MAX_LEVEL }, (_, i) => i + 1);
const built = (kind: TurretKind, lv: number, cx = 30, cy = 33): BuildingView => ({ kind, cx, cy, hp: 10, ammo: 10, ...(lv > 1 && { lv }) }) as BuildingView;
const ghost = (kind: Ghost['kind'], cx: number, cy: number, refusal: Ghost['refusal'] = null): Ghost => ({ kind, lv: 1, cx, cy, refusal, label: '', detail: null, hover: null, upgrade: null });
const none = { ghost: null, buildings: [], day: true, cursor: null, upgrade: null, squad: false };

test('every turret kind at every level rings exactly the range the sim aims within, centred on its cell', () => {
  for (const kind of TURRET_KINDS) for (const lv of levels) {
    const ring = ringOf(kind, lv, 7, 9, 'hover');
    assert.equal(ring.r, turretDef(kind, lv).range, `${kind} ${lv}`);
    assert.deepEqual([ring.x, ring.y], [7.5 * ZOM.cell, 9.5 * ZOM.cell]);
  }
  // Upgrades reach farther, so a level's ring is never the one below's.
  for (const kind of TURRET_KINDS) assert.ok(turretDef(kind, 3).range > turretDef(kind, 2).range && turretDef(kind, 2).range > turretDef(kind, 1).range);
});

test('the placement ghost of a turret shows its first level\'s ring; a wall, a utility or a dragged line shows none', () => {
  for (const kind of TURRET_KINDS) {
    const rings = rangeRings({ ...none, ghost: ghost(kind, 12, 14) });
    assert.deepEqual(rings.map((r) => [r.role, r.r, r.x, r.y]), [['place', turretDef(kind, 1).range, 12.5 * ZOM.cell, 14.5 * ZOM.cell]], kind);
    // A refused cell still shows the reach, so the player sees what the gun would cover there.
    assert.equal(rangeRings({ ...none, ghost: ghost(kind, 12, 14, 'outOfReach') })[0]?.r, turretDef(kind, 1).range);
  }
  for (const kind of ['wall', 'depot', 'post', 'spikes'] as const) assert.deepEqual(rangeRings({ ...none, ghost: ghost(kind, 12, 14) }), []);
  assert.deepEqual(rangeRings({ ...none, ghost: { ...ghost('sentry', 12, 14), line: [{ cx: 12, cy: 14, refusal: null }] } }), []);
});

test('a built turret under the ghost or the cursor shows its own ring and, by day, the next level\'s; at its top level, or by night, only its own', () => {
  for (const kind of TURRET_KINDS) for (const lv of levels) {
    const b = built(kind, lv);
    const expect = lv < MAX_LEVEL ? [['hover', turretDef(kind, lv).range], ['next', turretDef(kind, lv + 1).range]] : [['hover', turretDef(kind, lv).range]];
    const viaGhost = rangeRings({ ...none, buildings: [b], ghost: ghost('wall', b.cx, b.cy, 'taken') });
    assert.deepEqual(viaGhost.map((r) => [r.role, r.r]), expect, `${kind} ${lv} in build mode`);
    const viaCursor = rangeRings({ ...none, buildings: [b], cursor: { x: (b.cx + 0.3) * ZOM.cell, y: (b.cy + 0.8) * ZOM.cell } });
    assert.deepEqual(viaCursor.map((r) => [r.role, r.r]), expect, `${kind} ${lv} under the cursor`);
    const atNight = rangeRings({ ...none, day: false, buildings: [b], ghost: ghost('wall', b.cx, b.cy, 'taken') });
    assert.deepEqual(atNight.map((r) => [r.role, r.r]), [['hover', turretDef(kind, lv).range]]);
  }
  // Outside build mode by day, the building U would upgrade shows its rings when the cursor is on nothing.
  const b = built('cannon', 2);
  assert.deepEqual(rangeRings({ ...none, buildings: [b], upgrade: b }).map((r) => r.r), [turretDef('cannon', 2).range, turretDef('cannon', 3).range]);
  assert.deepEqual(rangeRings({ ...none, buildings: [b], cursor: { x: 0, y: 0 } }), [], 'nothing focused, nothing shown');
});

test('at night with the setting on every turret gets a faint ring of its true range, and the focused one is not doubled', () => {
  const list = [built('sentry', 1, 10, 10), built('mortar', 3, 14, 10), { kind: 'depot', cx: 12, cy: 12, hp: 10 } as BuildingView];
  const rings = rangeRings({ ...none, day: false, buildings: list, squad: true });
  assert.deepEqual(rings.map((r) => [r.role, r.kind, r.r]), [['squad', 'sentry', turretDef('sentry', 1).range], ['squad', 'mortar', turretDef('mortar', 3).range]]);
  const focused = rangeRings({ ...none, day: false, buildings: list, squad: true, ghost: ghost('wall', 10, 10, 'taken') });
  assert.deepEqual(focused.map((r) => r.role), ['hover', 'squad']);
  assert.deepEqual(rangeRings({ ...none, day: false, buildings: list, squad: false }), []);
});

test('a direct-fire turret\'s blind spots are exactly where the sim\'s line of sight is blocked by cover; a mortar and a coil have none', () => {
  assert.deepEqual(TURRET_KINDS.map(fireOf), ['direct', 'direct', 'direct', 'lobbed', 'arc']);
  const x = 1000, y = 1000, r = turretDef('sentry', 2).range;
  const cover: Rect[] = [{ x: 1080, y: 950, w: 40, h: 120 }, { x: 860, y: 860, w: 60, h: 30 }, { x: 990, y: 1150, w: 200, h: 20 }, { x: 2000, y: 2000, w: 50, h: 50 }];
  const spots = blindSpots(x, y, r, cover);
  assert.equal(spots.length, 3, 'cover out of reach casts nothing');
  const inside = (q: number[], px: number, py: number) => {
    let hit = false;
    for (let i = 0, j = q.length - 2; i < q.length; j = i, i += 2) {
      if ((q[i + 1]! > py) !== (q[j + 1]! > py) && px < ((q[j]! - q[i]!) * (py - q[i + 1]!)) / (q[j + 1]! - q[i + 1]!) + q[i]!) hit = !hit;
    }
    return hit;
  };
  let seed = 7, checked = 0, hidden = 0;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let n = 0; n < 4000; n++) {
    const a = rnd() * Math.PI * 2, d = 30 + rnd() * (r - 30), px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
    if (cover.some((c) => px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h)) continue;
    const shaded = spots.some((q) => inside(q, px, py));
    const blocked = segmentBlocked(cover, x, y, px - x, py - y);
    // Points a hair from a shadow's edge can fall either way in floating point; everywhere else the two must agree.
    const edge = spots.some((q) => [0, 1].some((k) => { const ex = q[k * 2]! - x, ey = q[k * 2 + 1]! - y; return Math.abs((ex * (py - y) - ey * (px - x)) / Math.hypot(ex, ey)) < 0.5; }));
    if (edge) continue;
    checked++;
    if (blocked) hidden++;
    assert.equal(shaded, blocked, `(${px.toFixed(1)}, ${py.toFixed(1)})`);
  }
  assert.ok(checked > 3000 && hidden > 100, `${checked} points, ${hidden} hidden`);
});

test('the night\'s rings draw only the outer edge of what a kind covers together', () => {
  const a = { x: 0, y: 0, r: 100 }, b = { x: 120, y: 0, r: 100 };
  const arcs = openArcs(a, [b]);
  const half = Math.acos(120 / 200);
  assert.equal(arcs.length, 1);
  assert.ok(Math.abs(arcs[0]![0] - half) < 1e-9 && Math.abs(arcs[0]![1] - (Math.PI * 2 - half)) < 1e-9, JSON.stringify(arcs));
  for (const [a0, a1] of arcs) {
    const m = (a0 + a1) / 2;
    assert.ok(Math.hypot(Math.cos(m) * 100 - b.x, Math.sin(m) * 100) > b.r, 'what is left lies outside the other ring');
  }
  assert.deepEqual(openArcs(a, [{ x: 10, y: 0, r: 200 }]), [], 'a ring inside another draws nothing');
  assert.deepEqual(openArcs(a, [{ x: 500, y: 0, r: 100 }]), [[0, Math.PI * 2]], 'apart, it draws whole');
});

test('the ghost draws the ring: the lit pass strokes a circle of the turret\'s range round the ghost\'s cell', () => {
  for (const kind of TURRET_KINDS) {
    const { ctx, calls } = fakeCanvas();
    drawSiegeLights(ctx, {
      buildings: [], all: [], aims: new Map(), core: { x: 0, y: 0 }, day: true, ghost: ghost(kind, 20, 22), cursor: null, upgrade: null, squadRings: false,
      walls: [{ x: 1200, y: 1000, w: 30, h: 30 }], crates: [], now: 0, pxPerUnit: 2, scale: 1, reduced: true, dark: 0,
    });
    const circles = calls.filter((c) => c.name === 'arc' && c.args[0] === 20.5 * ZOM.cell && c.args[1] === 22.5 * ZOM.cell).map((c) => c.args[2]);
    assert.ok(circles.length > 0 && circles.every((r) => r === turretDef(kind, 1).range), `${kind}: ${circles.join(',')}`);
    assert.ok(calls.some((c) => c.name === 'setLineDash' && (c.args[0] as number[]).length > 0), 'dashed');
  }
});

test('turret art is baked once into cached sprites: steady frames, small turns and recoil paint nothing new', () => {
  const { ctx, made } = fakeCanvas();
  const draw = (angle: number, sinceShot = Infinity) => {
    for (const kind of TURRET_KINDS) for (const lv of levels) drawTurret(ctx, { kind, lv, hp: 10, x: 100, y: 100, angle, sinceShot }, 2);
  };
  draw(0.3);
  const bakes = turretBakes.count, canvases = made.count;
  assert.ok(bakes > 0);
  for (let frame = 0; frame < 30; frame++) draw(0.3 + (frame % 3) * 0.02, frame * 20);
  assert.equal(turretBakes.count, bakes, 'no sprite painted after the first frame');
  assert.equal(made.count, canvases, 'no canvas made after the first frame');
  // A full turn bakes each head once per aim bucket and no more, however often it turns.
  for (let k = 0; k < 3; k++) for (let a = 0; a < Math.PI * 2; a += 0.05) drawTurret(ctx, { kind: 'cannon', lv: 2, hp: 10, x: 0, y: 0, angle: a, sinceShot: Infinity }, 2);
  assert.ok(turretBakes.count - bakes <= HEAD_BUCKETS, `${turretBakes.count - bakes} new heads`);
});

test('a head is drawn from the nearest of its baked aims, turned by at most half a step', () => {
  for (let a = -9; a <= 9; a += 0.137) {
    const { index, rest } = headBucket(a);
    assert.ok(index >= 0 && index < HEAD_BUCKETS && Math.abs(rest) <= Math.PI / HEAD_BUCKETS + 1e-9);
    const back = (index / HEAD_BUCKETS) * Math.PI * 2 + rest;
    assert.ok(Math.abs(Math.sin(back - a)) < 1e-9 && Math.cos(back - a) > 0);
  }
});

test('a shot kicks the gun back at once and eases it home; wear shows in three stages; turrets stand on the floor, not a pad', () => {
  for (const kind of ['sentry', 'cannon', 'scatter', 'mortar'] as const) {
    assert.ok(kickOf(kind, 0) > 0 && kickOf(kind, 0) > kickOf(kind, 30) && kickOf(kind, 1000) === 0, kind);
  }
  assert.ok(kickOf('cannon', 0) > kickOf('sentry', 0), 'the cannon kicks hardest');
  assert.deepEqual([10, 6, 5, 3, 2, 1].map(wearStage), [0, 0, 1, 1, 2, 2]);
  assert.equal(onPad({ kind: 'sentry', cx: 0, cy: 0, hp: 10, ammo: 10 } as BuildingView), false);
  assert.equal(onPad({ kind: 'depot', cx: 0, cy: 0, hp: 10 } as BuildingView), true);
  assert.equal(onPad({ kind: 'spikes', cx: 0, cy: 0, hp: 10 } as BuildingView), false);
});

test('the night\'s turret rings are a setting, on unless turned off', () => {
  assert.equal(sanitize({}).turretRanges, true);
  assert.equal(sanitize({ turretRanges: false }).turretRanges, false);
  assert.equal(sanitize({ turretRanges: 'no' }).turretRanges, true);
});
