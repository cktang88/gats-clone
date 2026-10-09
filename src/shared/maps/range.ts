import type { PropKind } from '../defs.ts';
import type { RangeLayout, TargetDef } from '../range.ts';
import type { Center, MapDef, MapWall, WallMaterial } from '../maps.ts';

/**
 * The shooting range: a firing line on the west edge and six lanes running east, each a different test. Distances are painted on
 * the floor from the line (100, 200, 400, 700, 1000 and 1250 px). The map is not a half-turn pair like the versus maps; it has one
 * spawn, no zones and no crates, and only the Range mode plays it.
 */
const SIZE = 2400;
const LINE = 400;
const MARKS = [100, 200, 400, 700, 1000, 1250] as const;
const at = (d: number) => LINE + d;

const LANE_PITCH = 330;
const LANE_Y = [330, 660, 990, 1320, 1650, 1980] as const;
const LANES = LANE_Y.map((y, i) => ({ y0: y - LANE_PITCH / 2, y1: y + LANE_PITCH / 2, label: ['CLOSE', 'STATIC', 'MOVING', 'LONG', 'DUMMY', 'BLAST'][i]! }));

const wall = (x: number, y: number, w: number, h: number, material: WallMaterial): MapWall => ({ x, y, w, h, material });

/** Booth: a concrete back wall with a doorway where you walk in, and a sandstone divider between each pair of bays. */
const BOOTH: MapWall[] = [
  wall(100, 150, 50, 900, 'concrete'),
  wall(100, 1350, 50, 900, 'concrete'),
  ...LANE_Y.slice(0, -1).map((y) => wall(250, y + LANE_PITCH / 2 - 25, 200, 50, 'sandstone')),
  wall(250, LANE_Y[0] - LANE_PITCH / 2 - 25, 200, 50, 'sandstone'),
  wall(250, LANE_Y[5] + LANE_PITCH / 2 - 25, 200, 50, 'sandstone'),
];

/** Cover to shoot round and lob over: a low wall with paper soldiers behind it, planters, a long concrete block. */
const COVER: MapWall[] = [
  wall(750, 1900, 50, 180, 'sandstone'),
  wall(1650, 1950, 150, 50, 'concrete'),
  wall(1100, 2150, 100, 50, 'planter'),
  wall(1100, 150, 100, 50, 'planter'),
  wall(700, 1500, 50, 50, 'planter'),
  wall(1300, 1500, 50, 50, 'planter'),
];

const paper = (x: number, y: number): TargetDef => ({ kind: 'paper', x, y });
const plank = (x: number, y: number): TargetDef => ({ kind: 'plank', x, y });
const dummy = (x: number, y: number): TargetDef => ({ kind: 'dummy', x, y });
const rail = (x: number, y: number, speed: number, phase: number): TargetDef => ({ kind: 'rail', x, y, rail: { axis: 'y', reach: 130, speed, phase } });

const TARGETS: TargetDef[] = [
  // Close quarters: a loose cluster inside 300 px, for a shotgun's spread.
  paper(at(80), LANE_Y[0] - 70), paper(at(80), LANE_Y[0] + 70), paper(at(150), LANE_Y[0]), paper(at(220), LANE_Y[0] - 100),
  paper(at(220), LANE_Y[0] + 100), paper(at(290), LANE_Y[0] - 40), paper(at(290), LANE_Y[0] + 40),
  // Static ladder: one at each painted distance, stepped off the line of fire so none shields the next.
  paper(at(100), LANE_Y[1] - 40), paper(at(200), LANE_Y[1] + 40), paper(at(400), LANE_Y[1] - 40), paper(at(700), LANE_Y[1] + 40), plank(at(1000), LANE_Y[1]),
  // Sliding targets across the line of fire at 200, 400, 700 and 1000 px, slow to quick.
  rail(at(200), LANE_Y[2], 150, 0), rail(at(400), LANE_Y[2], 220, 0.35), rail(at(700), LANE_Y[2], 300, 0.7), rail(at(1000), LANE_Y[2], 380, 0.15),
  // Long range for the bolt-action and the marksman's rifles; the last board, at 1250, only the farther-reaching snipers carry to from the line.
  plank(at(700), LANE_Y[3] - 50), plank(at(1000), LANE_Y[3] + 50), paper(at(1000), LANE_Y[3] - 70), plank(at(1250), LANE_Y[3]),
  // Training dummies: lots of health, for reading damage per second.
  dummy(at(150), LANE_Y[4] - 45), dummy(at(300), LANE_Y[4] + 45), dummy(at(500), LANE_Y[4] - 45),
  // Behind cover and beside the barrel row, for grenades and blasts.
  paper(at(480), LANE_Y[5] - 30), paper(at(480), LANE_Y[5] + 60), paper(at(1000), LANE_Y[5] - 100), paper(at(1000), LANE_Y[5] + 100),
];

const BARRELS: Center[] = [1860, 1920, 1980, 2040, 2100].map((y) => ({ x: 1250, y }));
const PROPS: (Center & { kind: PropKind })[] = [
  { x: 1000, y: 1880, kind: 'propane' }, { x: 1000, y: 1940, kind: 'gas' }, { x: 1000, y: 2020, kind: 'oil' },
  { x: 1000, y: 2090, kind: 'paint' }, { x: 1120, y: 1980, kind: 'generator' },
];

const spawn = { x: 170, y: 1210, w: 110, h: 80 };

const RANGE: RangeLayout = { pad: spawn, targets: TARGETS, line: LINE, marks: MARKS, lanes: LANES };

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
