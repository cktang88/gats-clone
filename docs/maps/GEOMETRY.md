# Map geometry API: polygon walls, doors, roofs

Status: implemented. Types and helpers: `src/shared/geom.ts`, `src/shared/mapgeo.ts`, `src/shared/shapes.ts`, `MapDef` in `src/shared/maps.ts`; doors in `src/shared/sim/doors.ts`; art in `src/client/geoart.ts`. Example map: `src/shared/maps/geotest.ts`.

## Scale

`WORLD.playerRadius` is 24 px, so a player is 48 px wide. Set pieces use **`PX_PER_M = 64`** (exported from `src/shared/shapes.ts`): a player is about 0.75 m wide, a door about 1.5 to 2 m (96 to 128 px), a room 6 m (384 px). Never author a gap narrower than **64 px** (corridor) and prefer 96+; the nav grid and the circle need 48 px plus slack. Maps are 6000 px (about 94 m) square, so a plane is a big landmark, not the whole map.

## Adding geometry to a map

```ts
import { gridMap } from '../mapgrid.ts';
import { withGeometry } from '../mapgeo.ts';
import { poly, halfTurn } from '../geom.ts';
import { cargoPlane, place } from '../shapes.ts';

export const MYMAP: MapDef = withGeometry(gridMap('My Map', ASCII, 'mytheme'), {
  // Everything listed here is for the WEST/north-west half; withGeometry adds the half-turn twin
  // (180 degrees about the map centre) of each polygon, door and roof so the map stays fair.
  // Pass `twin: false` for pieces that are already symmetric or sit on the centre.
  polys: [...place(cargoPlane, { x: 1500, y: 2200, rot: -0.3 }, 'fuselage', { id: 'plane' })],
  doors: [{ id: 'lab-a', kind: 'double-slide', x: 900, y: 1300, w: 128, axis: 'h', material: 'metal', auto: true }],
  roofs: [{ id: 'lab', points: poly.rect(700, 1000, 500, 300) }],
});
```

`withGeometry(def, { polys?, doors?, roofs?, twin? })` returns a new `MapDef`. With `twin` (default true) each poly/door/roof gets a twin: ids get the suffix `~` (`plane` -> `plane~`), points are `halfTurn`ed. Do not touch `walls` for these; grid walls stay rects.

## Polygons (`MapDef.polys`)

```ts
type Pt = { x: number; y: number };
type MapPoly = {
  points: readonly Pt[];       // simple polygon, convex OR concave, either winding. >= 3 points, no self-crossing
  material: string;            // free string: theme decides the art ('fuselage', 'hull', 'rock', ...)
  height?: number;             // px of south-facing front face in the tilt art (default 14; a fuselage ~ 40)
  blocksBullets?: boolean;     // default true. false: bodies are stopped, rounds fly over (low planter, crate)
  blocksSight?: boolean;       // default true. false: bodies stopped, sight/light pass (fence, glass, railing)
  id?: string;                 // unique within the map when present (twins get '~')
  group?: string;              // parts of one set piece share a group; art draws the group as one object
  part?: string;               // 'fuselage' | 'wing-l' | ... name inside the group (set by shapes.ts)
  shape?: string;              // shape name ('cargoPlane') so a theme can paint the whole piece
};
```
Overlapping polygons in a group are fine (a wing overlapping a fuselage); they are all solid. Concave polygons are split into convex parts internally (ear clipping + Hertel-Mehlhorn merge; `decompose(points)` in `geom.ts`). Parts reach the sim as **wall rects with an extra `pts` field** (flat `[x0,y0,x1,y1,...]`, counter-clockwise, convex) plus the AABB in `x,y,w,h`; `nb`/`ns` flags mean "does not block bullets/sight". Every function that takes `Rect[]` solids (`slide`, `moveStep`, `knifeLunge`, `circleHitsRect`, `segmentEntersRectAt`, bullets, grenades, bot nav/LOS, prediction) understands them with no API change. They are in `World.walls` (so `coverRects`/`solidRects` include them) and in the `walls` wire message.

Authoring helpers (all return `Pt[]`):

| helper | meaning |
|---|---|
| `poly.rect(x, y, w, h)` | axis-aligned box |
| `poly.circle(cx, cy, r, segments = 16)` | regular polygon |
| `poly.capsule(x1, y1, x2, y2, r, segments = 8)` | stadium between two points (`segments` per cap) |
| `poly.fromPath(path)` | `[[x,y],...]`, flat `[x,y,x,y,...]`, or the string `"x,y x,y ..."` |
| `poly.transform(points, { x, y, rot, scale, flipX })` | order: flipX, scale, rotate (radians, about the origin), translate |
| `poly.arc(cx, cy, rIn, rOut, a0, a1, segments)` | curved wall (annular sector) |
| `halfTurn(pointsOrPoly, size)` | 180 degree turn about the map centre |
| `poly.area(points)`, `poly.bounds(points)`, `poly.centroid(points)` | utilities |
| `make(points, material, opts)` | build a `MapPoly` |

`src/shared/shapes.ts` holds a library of set pieces, each a `Shape = { name, parts: { part: string; points: Pt[]; height?: number; blocksSight?: boolean; blocksBullets?: boolean }[] }` in local metres-times-`PX_PER_M` px, centred on (0,0), **nose toward +x**. `place(shape, { x, y, rot, scale, flipX }, material, { id, group, ...overrides }) -> MapPoly[]`.
Library: `cargoPlane` (~24 m span, 22 m long), `fighterJet`, `helicopter`, `trainCar`, `locomotive`, `tank`, `truck`, `boat`, `roundTank`, `pillar`, `lShape`, `arcWall`, `hexKiosk`. Each exports its nominal size (`cargoPlane.size = { w, h }` in px).

### Collision facts you can rely on
- Players are circles (r 24). They slide along any edge; vertices never stick. Min gap to author: 64 px.
- Bullets stop at the earliest entry into a part with `blocksBullets !== false`.
- Grenades bounce off the polygon edge normal.
- Bot nav treats cells within radius of a poly as blocked; map-lint (`node scripts/map-lint.ts`) checks polys for reachability, spawns inside polys, sightlines and symmetry.
- Keep polys inside the world and do not put crates/barrels/props/spawns/zones inside them (lint flags it).

## Doors (`MapDef.doors`)

```ts
type MapDoor = {
  id: string;                                   // unique in the map (twin gets '~')
  kind: 'slide' | 'swing' | 'double-slide' | 'double-swing';
  x: number; y: number;                         // START of the span on the door's centre line (px)
  w: number;                                    // span length in px (opening width): 96..160 typical
  axis: 'h' | 'v';                              // 'h': span runs along +x from (x,y); 'v': along +y
  hinge?: 'start' | 'end';                      // single leaves only: which end the leaf is anchored/retracts to (default 'start')
  material: 'metal' | 'wood' | 'glass' | string;
  auto?: boolean;                               // slide kinds: opens when anyone is within 90 px, closes after delay. Default true for slide, ignored for swing
  locked?: boolean;                             // default false. true: never opens (decoration or objective gating); bots treat it as a wall
  thick?: number;                               // leaf thickness px (default 12)
  side?: 1 | -1;                                // swing only: restrict to one swing side (+1 = toward +y / +x). Default: swings away from the pusher
  closeMs?: number;                             // delay before closing (slide 1400, swing 2500)
  glow?: string;                                // css colour of the light that leaks out when open (lit room)
};
```
Cut a **gap in the grid walls** exactly `w` wide (at least 96 px) and put the door in it; the door sits on the wall's centre line. The door is not a grid cell, so the cell row/column on both sides of the gap must be floor.

Behaviour (server-authoritative, tick based):
- `slide`: the leaf retracts into the wall pocket (toward `hinge`); collision is the remaining rect. `double-slide`: two leaves of `w/2`, each retracting to its own end. Auto: opens when an alive player is within 90 px of the span, closes `closeMs` after the last one leaves. Never closes onto a body.
- `swing`: the leaf rotates up to ~95 degrees about its hinge end. Walking into it pushes it open **away from the pusher** (no key). It swings back after `closeMs` if nothing is in the way. Anything in the leaf's path stops it; it never crushes. Explosions blow swing doors open. `double-swing`: two leaves hinged at both ends.
- Closed doors block bullets and sight and bodies. `glass` blocks bullets and bodies but not sight (and not light).
- Manual doors (`auto: false`): hold use (E) within 80 px to toggle. Bots only path through `auto` slide doors and swing doors.
- Doors are in `World.walls` as rect/poly leaves (`door` field = the door id) so all collision code sees them; `wallViews` (the wire) leaves them out and the client rebuilds the leaves from the map def and `Snapshot.doors`.
- Wire: `Snapshot.doors?: [index, open0to255, sign][]`, only doors that are not fully closed (absent = closed). `sign` is -1 or 1, the swing side.

## Roofs (`MapDef.roofs`)

```ts
type MapRoof = { id: string; points: readonly Pt[]; material?: string; tint?: string };
```
`material` picks the roof surface when the theme paints none itself (`src/client/roofart.ts`): `slate`, `vault` (steel plate), `tile`, `corrugated`, `tar`, `shingle`, `metal` (standing seam) or `copper`. Name the building's real roof. Rooms made of wall polygons (a hollow box with door gaps, the door that fills a gap, the roof over it, rounded rectangles, octagons and cigars) are built by `src/shared/maps/roomkit.ts`; the retrofitted maps use it (`museumgeo.ts`, `subpengeo.ts`, `marketgeo.ts`, `parkgeo.ts`, `yardgeo.ts`).

A roof is drawn above players over an interior. It fades to ~12% alpha while you (or a teammate) stand inside it, and is opaque elsewhere. It never reveals enemies: visibility is still the normal line of sight. A roof must cover the whole room including its wall tops; doors on its boundary are fine.

## Doorways

Every way into a building is marked so it reads from any side, not only through a south wall's front face (`src/client/doorways.ts` finds them, `src/client/doorwayart.ts` draws them). A doorway is a door that is not locked, or a gap in the walls along a roof's edge with wall on both sides (between 56 and 340 px wide, on an edge that is at least 30% wall, so a canopy's open sides are not doorways). Each gets a darker worn passage through the wall with a steel sill at each face and, outside a building, a doormat; a door-frame jamb at each side, standing proud of both wall faces and a step above the wall top; and, from outside, a notch in its roof's edge so the frame and the door show through the roof. Floors and jambs are baked once per doorway into small sprites the first time they come into view. Author nothing for it: cut the gap and put the door in it as above. `test/doorways.test.ts` checks every door that opens is marked, no locked one is, every marker sits on a clear opening between two walls, and every doorway from outside shows through a notch in its roof.

## Themes

`Theme` (src/client/themes/registry.ts) gains optional hooks; each returns true when it drew the thing (anything else falls back to the generic extrusion):
- `drawSetPiece(ctx, group: MapPoly[], info)` paint a whole `group` (a plane) in one go; runs first;
- `drawPoly(ctx, poly, info)` paint one polygon;
- `door(ctx, door, leaves, open01, info)` paint a door (`leaves` are its solid pieces right now);
- `roof(ctx, roof, alpha, info)` paint a roof (globalAlpha is already set).
`info = { now, view, dark, map }` (`GeoInfo`). `drawExtruded(ctx, pts, height, look)` and `lookOf(material)` in `geoart.ts` give the generic top-face-plus-front-face look to build on. Generic look: top face in the material colour (`fuselage`, `hull`, `tank`, `boxcar`, `kiosk`, `concrete`, `steel`, `wood`, `glass`, else steel), a light band on edges facing the light, a dark band on the far ones, ink outline, and a darker front face hanging `height` px below every south-facing edge.

## Bots

Bots see polygons and door leaves everywhere they already used walls: line of sight (`arena.sightWalls`, glass excluded), shots and retreat headings (`arena.walls`, `blocksBullets:false` excluded), barrel and prop checks, and cover (`coverIndex` lays cover points along each polygon part's own edges, not its bounding box). Doors are open road for the planner except locked ones and manual (`auto:false`) sliders; no cover point is taken within 110 px of a doorway. Helpers: `coverPointsNear(index, at, within)` in `bot/cover.ts`, `losClear(arena, a, b, 'shot' | 'sight', extra?)` in `bot/arena.ts`.

## Wire

Polygon parts ride in the `walls` message as wall rects with `pts` (and `pid`, `nb`, `ns`); `welcome` and `walls` also carry `map` (the map id) so the client can rebuild door leaves. Door state is `Snapshot.doors`, sticky (sent only when it changes, `[]` when all shut), only for doors near the view.

## Debug and dev

- `?geo=1` in the page address (or `localStorage.skirmishGeo = '1'`) draws collision outlines, bounding boxes, door leaves (green) and roof outlines (orange dashes).
- `SKIRMISH_MAP=geo-test node src/server/main.ts` starts the FFA, TDM and DOM rooms on `geo-test` (dev only, in no rotation).
- `node scripts/map-lint.ts` lints polygons (twins, bounds), doors (twins, sit in a gap, both sides standable) and prints longest sightlines with doors open and shut. `node scripts/map-overview.ts <dir> geo-test` draws polygons, doors and roof outlines.
