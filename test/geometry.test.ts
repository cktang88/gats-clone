/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { navGrid, isOpen, clearShot } from '../src/server/bot/nav.ts';
import { solidsOf, predictInput, reconcile, selfMotion, NO_PREDICTION, type Prediction } from '../src/client/predict.ts';
import { WORLD } from '../src/shared/defs.ts';
import { convexOverlap, decompose, halfTurn, partRect, poly, type Pt } from '../src/shared/geom.ts';
import { polyParts, withGeometry } from '../src/shared/mapgeo.ts';
import { MAPS } from '../src/shared/maps.ts';
import { cargoPlane, place, SHAPES, lShape } from '../src/shared/shapes.ts';
import { setInput, step } from '../src/shared/sim.ts';
import { tickThrown } from '../src/shared/sim/abilities.ts';
import { circleHitsRect, earliestHit, rectsOverlap, segmentEntersCircleAt, segmentEntersRectAt, slide, moveStep, type Rect } from '../src/shared/sim/movement.ts';
import { snapshotFor, wallViews } from '../src/shared/sim/snapshot.ts';
import { IDLE_INPUT } from '../src/shared/sim/world.ts';
import { emptyWorld, spawnAt, press, run, TICK_MS } from './helpers.ts';

const R = WORLD.playerRadius;
const area = (pts: readonly Pt[]) => poly.area(pts);
const part = (pts: Pt[]): Rect => ({ ...partRect(decompose(pts)[0]!) });
/** A box turned 30 degrees: a slope for sliding along. */
const SLOPE = poly.transform(poly.rect(-300, -20, 600, 40), { x: 1000, y: 1000, rot: Math.PI / 6 });

test('a concave polygon splits into convex parts that cover exactly its area', () => {
  const ell = poly.transform(lShape.parts[0]!.points, { x: 500, y: 500 });
  const parts = decompose(ell);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(poly.isConvex(p));
  assert.ok(Math.abs(parts.reduce((s, p) => s + area(p), 0) - area(ell)) < 1e-3);
  const plane = place(cargoPlane, { x: 0, y: 0 }, 'fuselage');
  for (const pl of plane) for (const p of decompose(pl.points)) assert.ok(poly.isConvex(p));
});

test('a circle is pushed off a polygon along its face and slides along an angled edge without tunnelling or sticking', () => {
  const slope = part(SLOPE);
  // Walk straight east into the 30 degree face from the west at sprint speed for two seconds.
  let m: { x: number; y: number; dash: null } = { x: 700, y: 1000, dash: null };
  let travelled = 0;
  for (let i = 0; i < 60; i++) {
    const before = m.x * 0 + m.y;
    m = { ...moveStep([slope], m, { up: false, down: false, left: false, right: true }, 420, TICK_MS, 6000), dash: null };
    assert.ok(!circleHitsRect(m.x, m.y, R - 0.01, slope), `inside the face on tick ${i}`);
    travelled += Math.abs(m.y - before);
  }
  assert.ok(travelled > 100, 'kept sliding along the face');
});

test('a dash at the polygon never crosses it', () => {
  const slope = part(SLOPE);
  for (let a = -0.6; a <= 0.6; a += 0.1) {
    let at = { x: 700, y: 1000 };
    const d = { dirX: Math.cos(a), dirY: Math.sin(a) };
    for (let i = 0; i < 8; i++) at = slide([slope], at.x, at.y, d.dirX * 30, d.dirY * 30, R, 6000);
    assert.ok(!circleHitsRect(at.x, at.y, R - 0.01, slope), `through the polygon at angle ${a}`);
  }
});

test('walking into a vertex head on slides off it instead of sticking', () => {
  const tri = part([{ x: 1000, y: 900 }, { x: 1200, y: 1000 }, { x: 1000, y: 1100 }]);
  let at = { x: 1400, y: 1000 };
  for (let i = 0; i < 30; i++) at = slide([tri], at.x, at.y, -12, 0.2, R, 6000);
  assert.ok(at.x < 1200 - R + 1 || Math.abs(at.y - 1000) > 5, 'did not stick on the tip');
  assert.ok(!circleHitsRect(at.x, at.y, R - 0.01, tri));
});

test('a round enters a polygon at the earliest face and lines of sight go around it, not through', () => {
  const slope = part(SLOPE);
  const t = segmentEntersRectAt(500, 1000, 1000, 0, slope);
  assert.ok(t !== null && t > 0.1 && t < 0.9);
  const hit = earliestHit([slope, { x: 5000, y: 0, w: 10, h: 10 }], 500, 1000, 1000, 0);
  assert.equal(hit?.b, slope);
  assert.equal(clearShot([slope], { x: 600, y: 1000 }, { x: 1400, y: 1000 }), false);
  assert.equal(clearShot([slope], { x: 600, y: 1300 }, { x: 1400, y: 1300 }), true);
  // The bounding box alone would say the corner is covered; the polygon says it is open.
  const tri = part([{ x: 1000, y: 1000 }, { x: 1200, y: 1000 }, { x: 1000, y: 1200 }]);
  assert.equal(segmentEntersRectAt(1150, 1150, 40, 0, tri), null);
  assert.equal(rectsOverlap(tri, { x: 1150, y: 1150, w: 40, h: 40 }), false);
});

test('a round stops on a polygon wall and spares what stands behind it', () => {
  const w = emptyWorld();
  w.walls = polyParts({ polys: [{ points: poly.rect(1000, 900, 40, 200), material: 'hull' }] }).map((r) => ({ ...r, built: false as const, expiresAt: Infinity }));
  const shooter = spawnAt(w, 700, 1000, { loadout: { weapon: 'assault' } });
  const victim = spawnAt(w, 1300, 1000);
  press(w, shooter, { angle: 0, fire: true, shots: 1 });
  run(w, 1200);
  assert.equal(victim.life.k === 'alive' ? victim.life.hp : 0, 100);
});

test('a grenade glances off a polygon face instead of stopping dead, and a flat wall still stops it', () => {
  const w = emptyWorld();
  const slope = part(SLOPE);
  w.walls = [{ ...slope, built: false, material: 'concrete', expiresAt: Infinity }];
  w.thrown.push({ id: 1, kind: 'fragGrenade', owner: 0, team: null, x: 800, y: 1000, vx: 600, vy: 0, explodeAt: 99999 });
  for (let i = 0; i < 40; i++) tickThrown(w, 1 / 30);
  const g = w.thrown[0]!;
  assert.ok('vx' in g && Math.hypot(g.vx, g.vy) < 600 && Math.hypot(g.vx, g.vy) > 0, 'glanced off, slower');
  assert.ok(!circleHitsRect(g.x, g.y, 1, slope), 'still outside');
  w.walls = [{ x: 900, y: 900, w: 40, h: 200, built: false, material: 'concrete', expiresAt: Infinity }];
  w.thrown = [{ id: 2, kind: 'fragGrenade', owner: 0, team: null, x: 800, y: 1000, vx: 600, vy: 0, explodeAt: 99999 }];
  for (let i = 0; i < 10; i++) tickThrown(w, 1 / 30);
  const f = w.thrown[0]!;
  assert.ok('vx' in f && f.vx === 0);
});

test('bots plan around a polygon: its nav cells are shut exactly where the body would touch', () => {
  const slope = part(SLOPE);
  const nav = navGrid(2000, [slope], R);
  assert.equal(isOpen(nav, { x: 1000, y: 1000 }), false);
  assert.equal(isOpen(nav, { x: 700, y: 1000 }), true);
  for (let y = 0; y < 2000; y += 25) for (let x = 0; x < 2000; x += 25) {
    const c = { x: x + 12.5, y: y + 12.5 };
    if (c.x < R || c.y < R || c.x > 2000 - R || c.y > 2000 - R) continue;
    assert.equal(isOpen(nav, c), !circleHitsRect(c.x, c.y, R, slope));
  }
});

test('half turn: a polygon turned twice is itself, and withGeometry twins it', () => {
  const sq = poly.rect(100, 200, 50, 80);
  const back = halfTurn(halfTurn(sq, 1000), 1000);
  assert.deepEqual(back, sq);
  const base = { ...MAPS.plaza, polys: undefined, doors: undefined, roofs: undefined };
  const m = withGeometry(base, { polys: [{ points: sq, material: 'hull', id: 'a' }] });
  assert.equal(m.polys!.length, 2);
  assert.equal(m.polys![1]!.id, 'a~');
  assert.throws(() => withGeometry(base, { polys: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }], material: 'x' }] }), /crosses itself/);
});

test('every shape in the library is a valid, world-sized set piece', () => {
  for (const s of Object.values(SHAPES)) {
    assert.ok(s.size.w > 40 && s.size.h > 40, s.name);
    for (const p of s.parts) assert.ok(decompose(p.points).length >= 1, `${s.name}/${p.part}`);
  }
  assert.ok(cargoPlane.size.h > 1200, 'a cargo plane is tens of players across');
});

test('prediction replays the server exactly across polygon walls', () => {
  const w = emptyWorld();
  w.walls = polyParts({ polys: [{ points: SLOPE, material: 'hull' }] }).map((r) => ({ ...r, built: false as const, expiresAt: Infinity }));
  const p = spawnAt(w, 700, 950);
  const first = snapshotFor(w, p.id);
  const walls = wallViews(w);
  let pred: Prediction = reconcile(NO_PREDICTION, selfMotion(first).at, first.ackSeq, solidsOf(walls, first), selfMotion(first).speed, 6000);
  for (let i = 1; i <= 90; i++) {
    const input = { ...IDLE_INPUT, right: i < 60, down: i % 20 < 10, angle: 0 };
    setInput(w, p.id, i, input);
    step(w, TICK_MS);
    pred = predictInput(pred, { seq: i, input, dtMs: TICK_MS, ability: null }, solidsOf(walls, first), selfMotion(first).speed, i * TICK_MS, 6000);
    assert.ok(Math.hypot(pred.afterNewest!.x - p.x, pred.afterNewest!.y - p.y) < 1e-6, `drift on tick ${i}`);
  }
});

test('convex overlap: touching is not overlapping', () => {
  assert.equal(convexOverlap([0, 0, 10, 0, 10, 10, 0, 10], [10, 0, 20, 0, 20, 10, 10, 10]), false);
  assert.equal(convexOverlap([0, 0, 10, 0, 10, 10, 0, 10], [9, 0, 20, 0, 20, 10, 9, 10]), true);
});

test('a segment enters a circle where it first crosses the rim, at 0 when it starts inside, and never behind its start or past its end', () => {
  // A circle of radius 10 at (100, 0); a segment along +x from x = 0.
  assert.equal(segmentEntersCircleAt(0, 0, 200, 0, 100, 0, 10), 90 / 200, 'crosses the rim at x = 90');
  assert.equal(segmentEntersCircleAt(0, 0, 50, 0, 100, 0, 10), null, 'ends short of it');
  assert.equal(segmentEntersCircleAt(150, 0, 100, 0, 100, 0, 10), null, 'the circle lies behind the start');
  assert.equal(segmentEntersCircleAt(100, 5, 100, 0, 100, 0, 10), 0, 'starting inside is a hit at once');
  assert.equal(segmentEntersCircleAt(0, 20, 200, 0, 100, 0, 10), null, 'passes beside it');
  assert.equal(segmentEntersCircleAt(0, 0, 0, 0, 100, 0, 10), null, 'a standing point outside hits nothing');
});
