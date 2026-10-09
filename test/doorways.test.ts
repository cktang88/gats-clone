/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roofNotches } from '../src/client/doorwayart.ts';
import { doorwaysOf, MAX_DEPTH, type Doorway } from '../src/client/doorways.ts';
import { poly, type Pt } from '../src/shared/geom.ts';
import { staticSolids, withGeometry } from '../src/shared/mapgeo.ts';
import { gridMap } from '../src/shared/mapgrid.ts';
import { MAP_IDS, MAPS, type MapDef } from '../src/shared/maps.ts';
import { roomDoor, roomRoof, roomWalls, type RoomSpec } from '../src/shared/maps/roomkit.ts';
import type { Rect } from '../src/shared/sim/movement.ts';

const inSolid = (s: Rect, x: number, y: number): boolean => {
  if (x < s.x || x > s.x + s.w || y < s.y || y > s.y + s.h) return false;
  const p = s.pts;
  if (!p) return true;
  for (let i = 0; i < p.length; i += 2) {
    const ax = p[i]!, ay = p[i + 1]!, bx = p[(i + 2) % p.length]!, by = p[(i + 3) % p.length]!;
    if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < -1e-6) return false;
  }
  return true;
};
const solidAt = (solids: readonly Rect[], p: Pt) => solids.some((s) => inSolid(s, p.x, p.y));
const inPoly = (p: Pt, pts: readonly Pt[]): boolean => {
  let r = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!, b = pts[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r;
  }
  return r;
};
/** The point `s` px along the opening from `a` and `k` px out of the building from its outer face. */
const at = (d: Doorway, s: number, k: number): Pt => {
  const len = Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y);
  return { x: d.a.x + ((d.b.x - d.a.x) / len) * s + d.n.x * k, y: d.a.y + ((d.b.y - d.a.y) / len) * s + d.n.y * k };
};
const width = (d: Doorway) => Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y);
const side = (d: Doorway) => (d.n.y > 0.7 ? 's' : d.n.y < -0.7 ? 'n' : d.n.x > 0.7 ? 'e' : d.n.x < -0.7 ? 'w' : 'slant');

for (const id of MAP_IDS) {
  const map = MAPS[id];
  const ways = doorwaysOf(map);
  const solids = staticSolids(map);

  test(`${map.name}: every door that opens is marked as a doorway, and no locked one is`, () => {
    const marked = new Set(ways.flatMap((w) => (w.door ? [w.door] : [])));
    for (const d of map.doors ?? []) assert.equal(marked.has(d.id), !d.locked, `door ${d.id}${d.locked ? ' (locked)' : ''}`);
  });

  test(`${map.name}: every doorway marker sits on an opening, between two walls, never on a solid wall`, () => {
    for (const w of ways) {
      const name = w.door ?? `${w.roof} gap ${side(w)} at ${Math.round(w.a.x)},${Math.round(w.a.y)}`;
      assert.ok(w.depth >= 8 && w.depth <= MAX_DEPTH, `${name}: depth ${w.depth}`);
      const len = width(w), mid = -w.depth / 2;
      // The opening is clear: nothing static stands on its centre line from jamb to jamb, nor anywhere across it face to face clear of the
      // jambs (a curved wall's slanted cut end may reach a few px into its corners).
      for (let s = 2; s <= len - 2; s += 4) assert.ok(!solidAt(solids, at(w, s, mid)), `${name}: solid on the opening's centre line at ${s}`);
      for (let s = 14; s <= len - 14; s += 6) for (let k = -2; k >= -w.depth + 2; k -= 6) assert.ok(!solidAt(solids, at(w, s, k)), `${name}: solid inside the opening at ${s},${k}`);
      // And it is an opening in a wall: wall stands just past each jamb, halfway through it.
      assert.ok(solidAt(solids, at(w, -4, mid)), `${name}: no wall beside its first jamb`);
      assert.ok(solidAt(solids, at(w, len + 4, mid)), `${name}: no wall beside its second jamb`);
    }
  });

  test(`${map.name}: a doorway from outside leads under its roof, and out from under every roof`, () => {
    for (const w of ways) {
      if (!w.outside) continue;
      const name = w.door ?? `${w.roof} gap ${side(w)}`;
      const roof = map.roofs?.find((r) => r.id === w.roof);
      assert.ok(roof, `${name}: names no roof (${w.roof})`);
      assert.ok(inPoly(at(w, width(w) / 2, -w.depth - 10), roof.points), `${name}: its inner side is not under ${roof.id}`);
      // From outside it shows through a notch in that roof's edge: one notch holds the whole opening and reaches out past the roof.
      const notch = roofNotches(map, roof.id).find((q) => inPoly(at(w, width(w) / 2, -w.depth / 2), q));
      assert.ok(notch, `${name}: no notch in ${roof.id}`);
      for (const s of [0, width(w)]) assert.ok(inPoly(at(w, s + (s ? -1 : 1), -w.depth / 2), notch), `${name}: its jamb at ${s} is outside the notch`);
      const lip = at(w, width(w) / 2, Math.max(...notch.map((q) => (q.x - w.a.x) * w.n.x + (q.y - w.a.y) * w.n.y)) - 1);
      assert.ok(!inPoly(lip, roof.points), `${name}: its notch stops short of ${roof.id}'s edge`);
    }
  });

  test(`${map.name}: a door's doorway spans the door`, () => {
    for (const w of ways) {
      const d = w.door && map.doors?.find((x) => x.id === w.door);
      if (!d) continue;
      const ends = [{ x: d.x, y: d.y }, { x: d.x + (d.axis === 'h' ? d.w : 0), y: d.y + (d.axis === 'v' ? d.w : 0) }];
      // The doorway runs along the door's line and holds its whole span, reaching at most a little past it to where a curved wall ends.
      const p = at(w, 0, -w.depth / 2), q = at(w, width(w), -w.depth / 2);
      const along = (e: Pt) => ((e.x - p.x) * (q.x - p.x) + (e.y - p.y) * (q.y - p.y)) / width(w);
      const off = (e: Pt) => Math.abs((e.x - p.x) * (q.y - p.y) - (e.y - p.y) * (q.x - p.x)) / width(w);
      for (const e of ends) assert.ok(off(e) < 1.5, `${d.id}: the door's end ${e.x},${e.y} is off the doorway's line`);
      const [s0, s1] = ends.map(along).sort((x, y) => x - y) as [number, number];
      assert.ok(s0 > -1 && s0 < 25 && s1 < width(w) + 1 && s1 > width(w) - 25, `${d.id}: door spans ${s0}..${s1} of a ${width(w)} px doorway`);
    }
  });
}

test('the versus maps have doorways facing every way, not only south', () => {
  const sides = new Set<string>(MAP_IDS.flatMap((id) => doorwaysOf(MAPS[id]).map(side)));
  for (const s of ['n', 's', 'e', 'w']) assert.ok(sides.has(s), s);
});

// A walled room with an opening in each side (two doors, two open gaps), a locked door, a sealed room and a canopy with no walls under it.
const ROWS = Array.from({ length: 40 }, (_, r) => (r === 2 ? '.A' : r === 30 ? 'R.' : '..').padEnd(20, '.')).join('\n');
const ROOM: RoomSpec = { id: 'room', x: 200, y: 200, w: 500, h: 400, material: 'concrete', gaps: [{ side: 'n', at: 300, w: 120 }, { side: 'e', at: 300, w: 100 }, { side: 's', at: 400, w: 130, open: true }, { side: 'w', at: 350, w: 96, open: true }] };
const SEALED: RoomSpec = { id: 'sealed', x: 200, y: 900, w: 400, h: 300, material: 'concrete', gaps: [{ side: 'e', at: 1000, w: 100 }] };
const toy = (): MapDef => withGeometry(gridMap('Doorway Toy', ROWS), {
  twin: false,
  polys: [...roomWalls(ROOM), ...roomWalls(SEALED)],
  doors: [
    roomDoor(ROOM, ROOM.gaps[0]!, 'n', { kind: 'swing', material: 'wood' }),
    roomDoor(ROOM, ROOM.gaps[1]!, 'e', { kind: 'slide', material: 'metal' }),
    roomDoor(SEALED, SEALED.gaps[0]!, 'locked', { kind: 'swing', material: 'metal', locked: true }),
  ],
  roofs: [roomRoof(ROOM, 'room', 'tar'), roomRoof(SEALED, 'sealed', 'tar'), { id: 'canopy', points: poly.rect(1000, 200, 300, 300) }],
});

test('a toy map: one doorway per opening, on its side, sized to the gap and the wall, and none on the locked door or the canopy', () => {
  const ways = doorwaysOf(toy());
  const got = ways.map((w) => ({ id: w.door ?? w.roof, side: side(w), w: Math.round(width(w)), depth: Math.round(w.depth), outside: w.outside })).sort((a, b) => a.side.localeCompare(b.side));
  assert.deepEqual(got, [
    { id: 'e', side: 'e', w: 100, depth: 50, outside: true },
    { id: 'n', side: 'n', w: 120, depth: 50, outside: true },
    { id: 'room', side: 's', w: 130, depth: 50, outside: true },
    { id: 'room', side: 'w', w: 96, depth: 50, outside: true },
  ]);
  const w = ways.find((x) => side(x) === 'w')!;
  // The west gap's jambs stand on the wall's outer face (x 200), at the gap's ends (y 350 and 446).
  assert.deepEqual([Math.round(w.a.x), Math.round(w.b.x)], [200, 200]);
  assert.deepEqual([w.a.y, w.b.y].map(Math.round).sort((p, q) => p - q), [350, 446]);
  assert.ok(ways.every((x) => x.roof === 'room'), 'every opening leads under the room roof');
});
