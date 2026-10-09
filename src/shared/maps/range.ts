import type { PropKind } from '../defs.ts';
import type { RangeLayout, TargetDef } from '../range.ts';
import type { Center, MapDef, MapWall, WallMaterial } from '../maps.ts';

/**
 * The shooting range: a firing line on the west edge and one open field running east, with the distances painted across it from the
 * line (100, 200, 400, 700, 1000 and 1250 px) and one target standing at each, stepped along a diagonal so none hides another. A
 * narrow bay to the north holds two sliders, and one to the south a training dummy and a small blast corner. The map is not a
 * half-turn pair like the versus maps; it has one spawn, no zones and no crates, and only the Range mode plays it.
 */
const SIZE = 2400;
const LINE = 400;
const MARKS = [100, 200, 400, 700, 1000, 1250] as const;
const at = (d: number) => LINE + d;

/** Three bays, north to south: the sliders, the open field, the dummy and the blast corner. */
const BAYS = [
  { y0: 300, y1: 700, label: 'MOVING' },
  { y0: 700, y1: 1700, label: 'FIELD' },
  { y0: 1700, y1: 2100, label: 'BLAST' },
] as const;

const wall = (x: number, y: number, w: number, h: number, material: WallMaterial): MapWall => ({ x, y, w, h, material });

/** Booth: a concrete back wall with a doorway where you walk in, and a short sandstone divider at each bay's edge, behind the line. */
const BOOTH: MapWall[] = [
  wall(100, 150, 50, 900, 'concrete'),
  wall(100, 1350, 50, 900, 'concrete'),
  ...[300, 700, 1700, 2100].map((y) => wall(250, y - 25, 200, 50, 'sandstone')),
];

/** A low wall in the blast corner to lob a grenade over, and a planter at each rim to dress the edges. */
const COVER: MapWall[] = [
  wall(780, 1890, 50, 160, 'sandstone'),
  wall(1100, 150, 100, 50, 'planter'),
  wall(1100, 2150, 100, 50, 'planter'),
];

const paper = (x: number, y: number): TargetDef => ({ kind: 'paper', x, y });
const plank = (x: number, y: number): TargetDef => ({ kind: 'plank', x, y });
const dummy = (x: number, y: number): TargetDef => ({ kind: 'dummy', x, y });
const rail = (x: number, y: number, speed: number, phase: number): TargetDef => ({ kind: 'rail', x, y, rail: { axis: 'y', reach: 130, speed, phase } });

const TARGETS: TargetDef[] = [
  // The field: one stand-up at each painted distance on a bowed diagonal, near ones south of the pad and far ones north. The bow keeps
  // any three off one straight line, so from anywhere on the line hardly one hides another.
  paper(at(100), 1580), paper(at(200), 1500), paper(at(400), 1420), plank(at(700), 1240), plank(at(1000), 1030),
  // The last board only the farther-reaching snipers carry to from the line.
  plank(at(1250), 830),
  // Two sliders across the line of fire, a slow one at 400 px and a quick one at 700.
  rail(at(400), 480, 170, 0), rail(at(700), 520, 300, 0.5),
  // A training dummy with a lot of health, for reading damage per second, and a paper soldier behind the blast corner's low wall.
  dummy(at(200), 1800), paper(at(500), 1970),
];

const BARRELS: Center[] = [{ x: 960, y: 1880 }, { x: 960, y: 1940 }];
const PROPS: (Center & { kind: PropKind })[] = [{ x: 1010, y: 2030, kind: 'propane' }, { x: 940, y: 2040, kind: 'oil' }];

const spawn = { x: 170, y: 1210, w: 110, h: 80 };

const RANGE: RangeLayout = { pad: spawn, targets: TARGETS, line: LINE, marks: MARKS, lanes: BAYS };

export const RANGE_MAP: MapDef = {
  name: 'Range',
  size: SIZE,
  walls: [...BOOTH, ...COVER],
  zones: [],
  spawns: { red: [spawn], blue: [spawn], ffa: [spawn] },
  crates: [],
  barrels: BARRELS,
  props: PROPS,
  range: RANGE,
};
