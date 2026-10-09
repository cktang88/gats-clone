import { ROYALE, WORLD } from '../shared/defs.ts';
import type { BuildingView, CrateView, RunView, WallView } from '../shared/protocol.ts';
import { cellRect, coreRectAt } from '../shared/sim/build.ts';
import { paintFloor, stencil, type FloorPlan } from './floor.ts';
import { paintFoliage, paintGrain, paintHazard, seeded, type Grain } from './grain.ts';
import { PALETTE } from './palette.ts';
import { paintThemedSolids } from './themes/registry.ts';
import { onMapChange } from './mapscope.ts';

export const LIGHT = { x: 0.62, y: 0.78 } as const;
const SHADOW_PER_HEIGHT = 3.3;
export const LIP = 4;

export type SolidKind = 'hangar' | 'cinder' | 'sbags' | 'gse' | 'bunk' | 'pallet' | 'jersey' | 'stall' | 'shopfront' | 'stack' | 'cart' | 'shrine' | 'gallery' | 'marble' | 'vitrine' | 'plinth' | 'counter' | 'sandstone' | 'concrete' | 'curb' | 'planter' | 'slate' | 'brick' | 'pad' | 'core' | 'crate' | 'supply' | 'wood' | 'sandbag' | 'steel' | 'hull' | 'tower' | 'bulkhead' | 'rack' | 'water' | 'hedge' | 'pond' | 'parkstone' | 'trunk' | 'bench' | 'play' | 'terminus' | 'ironwork' | 'boxcar' | 'sleepers' | 'kiosk' | 'coalheap' | 'timber' | 'hearth' | 'bartop' | 'drift' | 'machine' | 'embwall' | 'embglass' | 'embfurn' | 'embrack' | 'embhedge' | 'rubble' | 'scrap';
type Bed = { inset: number; ground: string; leaves: readonly (readonly [string, number])[] };
type Material = { top: string; grain: Grain; height: number; bed?: Bed };

/**
 * The world wears the same kit as the interface (style.css): gunmetal, khaki and olive with an ink outline, each solid
 * cel-shaded in two hard steps, a light edge toward the light and a dark one away from it, over the bone concrete floor.
 * Surfaces stay quiet so a solid reads by its colour and its edges, as the guns and bodies do.
 */
const GRAIN: Grain = { specks: 120, blotches: 0, scratches: 0.2, seams: null, tile: 160 };

/**
 * Every solid is seen slightly from the front: its top face is its collision rect, and below the south edge hangs a darker
 * front face. Bodies are drawn over it, so a player standing at a wall's foot is in front of the wall. These are the heights
 * the painters (this file and the theme kits, which mirror them) draw a front face at; `FACE` is how tall it ends up on screen.
 */
export const PAINT_FACE: Record<SolidKind, number> = { hangar: 18, cinder: 16, sbags: 13, gse: 12, bunk: 10, pallet: 10, jersey: 12, stall: 14, shopfront: 18, stack: 12, cart: 10, shrine: 16, gallery: 18, marble: 16, vitrine: 14, plinth: 22, counter: 14, sandstone: 15, concrete: 16, slate: 14, brick: 12, planter: 12, crate: 12, supply: 13, pad: 6, curb: 0, core: 0, wood: 10, sandbag: 13, steel: 15, hull: 14, tower: 24, bulkhead: 16, rack: 12, water: 0, hedge: 18, pond: 8, parkstone: 16, trunk: 14, bench: 9, play: 13, terminus: 18, ironwork: 10, boxcar: 16, sleepers: 12, kiosk: 14, coalheap: 10, timber: 18, hearth: 16, bartop: 14, drift: 10, machine: 16, embwall: 16, embglass: 14, embfurn: 12, embrack: 14, embhedge: 18, rubble: 16, scrap: 14 };
/** The sprite's own pixel height is untouched until it is baked, then its front face is stretched to this much. */
const FACE_PER_HEIGHT = 0.5;
const FACE_MAX = 26;

export const MATERIALS: Record<SolidKind, Material> = {
  // Night Market (themes/market.ts paints these itself; the numbers here drive shadow reach and the loose-sprite size).
  stall: { top: '#7a5a3a', grain: GRAIN, height: 22 },
  shopfront: { top: '#4b4650', grain: GRAIN, height: 50 },
  stack: { top: '#8a6a40', grain: GRAIN, height: 30 },
  cart: { top: '#8a8f96', grain: GRAIN, height: 24 },
  shrine: { top: '#8a8478', grain: GRAIN, height: 38 },
  // Museum (themes/museum.ts paints these itself; the numbers here drive shadow reach and the loose-sprite size).
  gallery: { top: '#8a3a47', grain: GRAIN, height: 46 },
  marble: { top: '#cfc6b0', grain: GRAIN, height: 40 },
  vitrine: { top: '#8fb4b6', grain: GRAIN, height: 26 },
  plinth: { top: '#b0a07c', grain: GRAIN, height: 30 },
  counter: { top: '#8a5a34', grain: GRAIN, height: 22 },
  // Sub Pen (themes/subpen.ts paints these itself; the numbers here drive shadow reach and the loose-sprite size).
  hull: { top: '#5d7479', grain: GRAIN, height: 30 },
  tower: { top: '#6d868b', grain: GRAIN, height: 54 },
  bulkhead: { top: '#6b7480', grain: GRAIN, height: 46 },
  rack: { top: '#4a525c', grain: GRAIN, height: 22 },
  water: { top: '#1b2f37', grain: GRAIN, height: 0 },
  // Park (themes/park*.ts paints these itself; the heights set how long their shadows fall).
  hedge: { top: '#4f7040', grain: GRAIN, height: 40 },
  pond: { top: '#2f565a', grain: GRAIN, height: 0 },
  parkstone: { top: '#bab29c', grain: GRAIN, height: 38 },
  trunk: { top: '#6a4b32', grain: GRAIN, height: 54 },
  bench: { top: '#8d6b44', grain: GRAIN, height: 14 },
  play: { top: '#c9a23c', grain: GRAIN, height: 34 },
  // Rail Yard (themes/railyard*.ts paints these itself; the numbers here drive shadow reach and the loose-sprite size).
  terminus: { top: '#8a4a3a', grain: GRAIN, height: 60 },
  ironwork: { top: '#3f5a4a', grain: GRAIN, height: 50 },
  boxcar: { top: '#7a3a2a', grain: GRAIN, height: 44 },
  sleepers: { top: '#5a4632', grain: GRAIN, height: 24 },
  kiosk: { top: '#4a6a56', grain: GRAIN, height: 28 },
  coalheap: { top: '#2a2c30', grain: GRAIN, height: 26 },
  // Summit (themes/summit*.ts paints these itself; the numbers here drive shadow reach and the loose-sprite size).
  timber: { top: '#8a6a44', grain: GRAIN, height: 48 },
  hearth: { top: '#7d776a', grain: GRAIN, height: 54 },
  bartop: { top: '#8a5a34', grain: GRAIN, height: 22 },
  drift: { top: '#9fb0c4', grain: GRAIN, height: 20 },
  machine: { top: '#5a6672', grain: GRAIN, height: 40 },
  // Airbase (themes/airbase*.ts paints these itself; the numbers here drive shadow reach and the loose-sprite size).
  hangar: { top: '#6f7a78', grain: GRAIN, height: 56 },
  cinder: { top: '#8a8f7c', grain: GRAIN, height: 44 },
  sbags: { top: '#a8946a', grain: GRAIN, height: 26 },
  gse: { top: '#8b8f58', grain: GRAIN, height: 22 },
  bunk: { top: '#6c7356', grain: GRAIN, height: 18 },
  pallet: { top: '#a3814f', grain: GRAIN, height: 20 },
  jersey: { top: '#c8c2b0', grain: GRAIN, height: 20 },
  // Embassy (themes/embassy*.ts paints these itself; the numbers here drive shadow reach and the loose-sprite size).
  embwall: { top: '#b9b2a2', grain: GRAIN, height: 50 },
  embglass: { top: '#8fb8c4', grain: GRAIN, height: 46 },
  embfurn: { top: '#7a5232', grain: GRAIN, height: 24 },
  embrack: { top: '#3d4654', grain: GRAIN, height: 44 },
  embhedge: { top: '#3f6a3a', grain: GRAIN, height: 40 },
  // Wasteland (themes/wasteland*.ts paints these itself; the numbers here drive shadow reach and the loose-sprite size).
  rubble: { top: '#7d776a', grain: GRAIN, height: 44 },
  scrap: { top: '#8a6a4a', grain: GRAIN, height: 36 },
  // Sandbags: stacked, stitched and lit along their crowns.
  sandstone: { top: '#b4a07a', grain: { ...GRAIN, seams: 'bags', tile: 96 }, height: 46 },
  concrete: { top: '#78808c', grain: { ...GRAIN, seams: 'panel', tile: 200, rivets: true }, height: 46 },
  curb: { top: '#2b2e34', grain: GRAIN, height: 20 },
  planter: { top: '#6c7356', grain: GRAIN, height: 26, bed: { inset: 6, ground: '#252b1d', leaves: [['#3a4429', 0.45], ['#4d5934', 0.35], ['#66744a', 0.2]] } },
  slate: { top: '#667080', grain: { ...GRAIN, seams: 'panel', tile: 50, rivets: true }, height: 36 },
  // A squad's own wall: riveted khaki plate, a shade darker than the map's sandstone so it reads as built, not found.
  brick: { top: '#a8946b', grain: { ...GRAIN, seams: 'panel', tile: 50, rivets: true }, height: 28 },
  pad: { top: '#5a626e', grain: GRAIN, height: 14 },
  // The squad's three walls, each of its own stuff: weathered boards, stacked sandbags, riveted steel plate. They are drawn lower, then taller, then tallest, so a tier reads by its height as well as its colour.
  wood: { top: '#93724a', grain: { ...GRAIN, specks: 90, scratches: 0, seams: 'planks', tile: 64 }, height: 20 },
  sandbag: { top: '#a8946a', grain: { ...GRAIN, specks: 60, scratches: 0, seams: 'bags', tile: 96 }, height: 30 },
  steel: { top: '#808a99', grain: { ...GRAIN, specks: 50, scratches: 0.5, seams: 'panel', tile: 50, rivets: true }, height: 44 },
  // Supply crates: wooden slatted boxes in the map, olive-drab metal cases for royale drops.
  crate: { top: '#a3814f', grain: { ...GRAIN, specks: 200, tile: 88 }, height: 28 },
  supply: { top: '#59653f', grain: { ...GRAIN, tile: 88 }, height: 30 },
  core: { top: '#4d535f', grain: GRAIN, height: 56 },
};

/**
 * How tall each solid's front face is drawn: its height times a constant, never less than the painter's own, so low cover
 * (crates, sandbags, benches) hangs a short face and full walls and buildings a tall one. A solid's sprite is painted at
 * `PAINT_FACE` and its face is then stretched to this (spriteOf), whoever painted it, so the theme kits get the volume too.
 */
export const FACE: Record<SolidKind, number> = Object.fromEntries(
  (Object.keys(PAINT_FACE) as SolidKind[]).map((k) => [k, PAINT_FACE[k] ? Math.min(FACE_MAX, Math.max(PAINT_FACE[k], Math.round(MATERIALS[k].height * FACE_PER_HEIGHT))) : 0]),
) as Record<SolidKind, number>;
/** How far below its rect a solid's drawing can reach: its front face and the rubble at its foot. */
export const FOOT = 30 + Math.max(...(Object.keys(FACE) as SolidKind[]).map((k) => FACE[k] - PAINT_FACE[k]));

/** The arena's edge is hazard tape in the interface's orange, so the map is framed like every other piece of kit. */
const HAZARD = { a: '#2b2e34', b: '#d9541f', band: 12 } as const;

const INK_EDGE = '#1c1f26';
const LIP_COLOR = '#2a2d34';
/** The two hard cel steps, `edge` px wide, on every top face. */
const BEVEL = { light: 'rgba(255, 255, 255, 0.24)', dark: 'rgba(10, 12, 16, 0.32)', edge: 4 } as const;

export type Solid = { kind: SolidKind; x: number; y: number; w: number; h: number; wear?: number };

/**
 * The shadow a solid throws on the floor: its footprint on the ground (the top face's rect, lowered by the front face)
 * swept along the key light, as far as the solid is tall. The top rect is kept in the outline so nothing peeks out behind it.
 */
export function shadowHull({ kind, x, y, w, h }: Solid): number[] {
  const len = MATERIALS[kind].height * SHADOW_PER_HEIGHT;
  const dx = LIGHT.x * len, dy = LIGHT.y * len, f = FACE[kind];
  return [x, y, x + w, y, x + w + dx, y + f + dy, x + w + dx, y + h + f + dy, x + dx, y + h + f + dy, x, y + h + f, x, y + h];
}

const CURB = 18;
const mapWallKind = (w: WallView): SolidKind => (w.built ? 'slate' : w.material);

/** Polygon parts (`pts`) are drawn by geoart.ts from the map's polygons, not as boxes. */
export const wallSolids = (walls: readonly WallView[]): Solid[] => walls.filter((w) => !w.pts).map((w) => ({ kind: mapWallKind(w), x: w.x, y: w.y, w: w.w, h: w.h }));

export const curbSolids = (size: number): Solid[] => [
  { kind: 'curb', x: -CURB, y: -CURB, w: size + CURB * 2, h: CURB },
  { kind: 'curb', x: -CURB, y: 0, w: CURB, h: size },
  { kind: 'curb', x: size, y: 0, w: CURB, h: size },
  { kind: 'curb', x: -CURB, y: size, w: size + CURB * 2, h: CURB },
];

export const crateSolid = (c: CrateView): Solid => ({ kind: c.drop ? 'supply' : 'crate', x: c.x, y: c.y, w: c.size, h: c.size, wear: 1 - c.hp / (c.drop ? ROYALE.dropHp : WORLD.crateHp) });

/** A wall's tier is its upgrade level: boards, then sandbags, then steel. Everything else that stands is a pad under its own head (siege.ts). */
const WALL_SOLID: readonly SolidKind[] = ['wood', 'sandbag', 'steel'];

export const buildingSolid = (b: BuildingView): Solid => ({ kind: b.kind === 'wall' ? WALL_SOLID[Math.min(WALL_SOLID.length, b.lv ?? 1) - 1]! : 'pad', ...cellRect(b.cx, b.cy), wear: 1 - b.hp / 10 });

/** Spike strips lie on the floor and are walked over, so they are drawn by siege.ts and cast no shadow. */
export const standsUp = (b: BuildingView): boolean => b.kind !== 'spikes';

export const coreSolid = (run: RunView): Solid => ({ kind: 'core', ...coreRectAt(run.core) });


type GroundLayer = { canvas: HTMLCanvasElement; x: number; y: number; scale: number };

const LAYER_PAD = 120;
const LAYER_SCALE = 0.5;
/** Crisp, graphic drop shadows rather than soft photographic ones. */
const BLUR_PX = 1.2;
const SHADOW_ALPHA = 0.52;
const FLOOR_SEED = 7;
const AO_COLOR = 'rgba(16, 18, 24, ';

function layerCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = Math.ceil((size + LAYER_PAD * 2) * LAYER_SCALE);
  const g = c.getContext('2d')!;
  g.setTransform(LAYER_SCALE, 0, 0, LAYER_SCALE, LAYER_PAD * LAYER_SCALE, LAYER_PAD * LAYER_SCALE);
  return [c, g];
}

function fillHulls(g: CanvasRenderingContext2D, solids: readonly Solid[]) {
  g.fillStyle = '#000';
  g.beginPath();
  for (const s of solids) {
    const p = shadowHull(s);
    g.moveTo(p[0]!, p[1]!);
    for (let i = 2; i < p.length; i += 2) g.lineTo(p[i]!, p[i + 1]!);
    g.closePath();
  }
  g.fill();
}

/**
 * Ambient occlusion: the floor darkens where a solid meets it, a wide soft halo and a tight dark contact line. It is laid
 * under the solid, which hides the part of it inside the footprint, so only the rim shows.
 */
function fillAO(g: CanvasRenderingContext2D, solids: readonly Solid[], reach = 1) {
  if (!solids.length) return;
  g.save();
  // The floor sinks into every wall's foot: a wide soft halo, a tighter shade, and a dark contact line hugging the base.
  for (const [grow, blur, alpha] of [[26 * reach, 12, 0.16], [10 * reach, 5, 0.2], [3 * reach, 1.4, 0.32]] as const) {
    g.filter = `blur(${blur * LAYER_SCALE}px)`;
    g.fillStyle = `${AO_COLOR}${alpha})`;
    g.beginPath();
    for (const s of solids) g.rect(s.x - grow, s.y - grow, s.w + grow * 2, s.h + FACE[s.kind] + grow * 2);
    g.fill();
  }
  g.restore();
}

/* Which solids stand taller than a neighbour and so throw a shadow across its top: worked out once per map, read by spriteOf. */
const CASTER_CELL = 256;
let casterGrid = new Map<number, Solid[]>();
const castersOn = new Map<string, number[][]>();
const cellKey = (cx: number, cy: number) => cx * 4096 + cy;

function registerCasters(solids: readonly Solid[]): void {
  casterGrid = new Map();
  castersOn.clear();
  for (const s of solids) {
    if (MATERIALS[s.kind].height <= 0) continue;
    const hull = shadowHull(s);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < hull.length; i += 2) { x0 = Math.min(x0, hull[i]!); x1 = Math.max(x1, hull[i]!); y0 = Math.min(y0, hull[i + 1]!); y1 = Math.max(y1, hull[i + 1]!); }
    for (let cx = Math.floor(x0 / CASTER_CELL); cx <= Math.floor(x1 / CASTER_CELL); cx++) {
      for (let cy = Math.floor(y0 / CASTER_CELL); cy <= Math.floor(y1 / CASTER_CELL); cy++) {
        const k = cellKey(cx, cy);
        const list = casterGrid.get(k);
        if (list) list.push(s); else casterGrid.set(k, [s]);
      }
    }
  }
}

/** The shadows of every taller registered solid that reach `s`'s top or front face, as polygons. */
function shadowsOn(s: Solid): number[][] {
  const key = `${s.kind}${s.x},${s.y},${s.w},${s.h}`;
  const known = castersOn.get(key);
  if (known) return known;
  const out: number[][] = [];
  const mine = MATERIALS[s.kind].height, bottom = s.y + s.h + FACE[s.kind];
  const seen = new Set<Solid>();
  for (let cx = Math.floor(s.x / CASTER_CELL); cx <= Math.floor((s.x + s.w) / CASTER_CELL); cx++) {
    for (let cy = Math.floor(s.y / CASTER_CELL); cy <= Math.floor(bottom / CASTER_CELL); cy++) {
      for (const t of casterGrid.get(cellKey(cx, cy)) ?? []) {
        if (seen.has(t)) continue;
        seen.add(t);
        if (t.x === s.x && t.y === s.y && t.w === s.w && t.h === s.h) continue;
        if (MATERIALS[t.kind].height < mine + 8) continue;
        const hull = shadowHull(t);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let i = 0; i < hull.length; i += 2) { x0 = Math.min(x0, hull[i]!); x1 = Math.max(x1, hull[i]!); y0 = Math.min(y0, hull[i + 1]!); y1 = Math.max(y1, hull[i + 1]!); }
        // Only the part of the shadow beyond the caster's own foot lies on its neighbours.
        if (x1 <= s.x || x0 >= s.x + s.w || y1 <= s.y || y0 >= bottom) continue;
        out.push(hull);
      }
    }
  }
  if (castersOn.size > 6000) castersOn.clear();
  castersOn.set(key, out);
  return out;
}

const solidKey = (solids: readonly Solid[]) => solids.map((s) => `${s.kind}${s.x},${s.y},${s.w},${s.h}`).join('|');

export function createGroundCache() {
  let layout: unknown = null;
  let size = 0;
  let floor: HTMLCanvasElement | null = null;
  let hard: HTMLCanvasElement | null = null;
  let movingKey: string | null = null;
  let layer: GroundLayer | null = null;
  let bakes = 0;
  const get = (nextLayout: unknown, worldSize: number, statics: () => readonly Solid[], moving: readonly Solid[] | 'static', plan?: FloorPlan): GroundLayer => {
    const key = solidKey(moving === 'static' ? [] : moving);
    if (nextLayout === layout && worldSize === size && key === movingKey && layer) return layer;
    if (nextLayout !== layout || worldSize !== size || !floor || !hard) {
      layout = nextLayout;
      size = worldSize;
      const placed = statics();
      registerCasters(placed);
      const [f, fg] = layerCanvas(size);
      fg.fillStyle = PALETTE.outside;
      fg.fillRect(-LAYER_PAD, -LAYER_PAD, size + LAYER_PAD * 2, size + LAYER_PAD * 2);
      paintFloor(fg, size, FLOOR_SEED, plan);
      // Walkable ground sits a step lower in value than every top face, whoever painted it.
      fg.fillStyle = 'rgba(12, 14, 20, 0.12)';
      fg.fillRect(-LAYER_PAD, -LAYER_PAD, size + LAYER_PAD * 2, size + LAYER_PAD * 2);
      fillAO(fg, placed);
      floor = f;
      const [h, hg] = layerCanvas(size);
      fillHulls(hg, placed);
      hard = h;
    }
    movingKey = key;
    let source = hard;
    if (moving !== 'static' && moving.length) {
      const [all, g] = layerCanvas(size);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(hard, 0, 0);
      g.setTransform(LAYER_SCALE, 0, 0, LAYER_SCALE, LAYER_PAD * LAYER_SCALE, LAYER_PAD * LAYER_SCALE);
      fillHulls(g, moving);
      source = all;
    }
    const [out, o] = layerCanvas(size);
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.drawImage(floor, 0, 0);
    if (moving !== 'static' && moving.length) {
      o.setTransform(LAYER_SCALE, 0, 0, LAYER_SCALE, LAYER_PAD * LAYER_SCALE, LAYER_PAD * LAYER_SCALE);
      fillAO(o, moving);
      o.setTransform(1, 0, 0, 1, 0, 0);
    }
    o.filter = `blur(${BLUR_PX * LAYER_SCALE}px)`;
    o.globalAlpha = SHADOW_ALPHA;
    o.drawImage(source, 0, 0);
    bakes++;
    if (moving === 'static') floor = hard = null;
    layer = { canvas: out, x: -LAYER_PAD, y: -LAYER_PAD, scale: LAYER_SCALE };
    return layer;
  };
  return { get, bakes: () => bakes };
}

export function drawGround(ctx: CanvasRenderingContext2D, layer: GroundLayer, x0: number, y0: number, x1: number, y1: number) {
  const lx1 = layer.x + layer.canvas.width / layer.scale, ly1 = layer.y + layer.canvas.height / layer.scale;
  if (x0 < layer.x || y0 < layer.y || x1 > lx1 || y1 > ly1) {
    ctx.fillStyle = PALETTE.outside;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  const ax = Math.max(layer.x, x0), ay = Math.max(layer.y, y0);
  const bx = Math.min(lx1, x1), by = Math.min(ly1, y1);
  if (bx <= ax || by <= ay) return;
  // The layer is already blurred; smoothed upscaling of it costs a software canvas about 4ms a frame.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(layer.canvas, (ax - layer.x) * layer.scale, (ay - layer.y) * layer.scale, (bx - ax) * layer.scale, (by - ay) * layer.scale, ax, ay, bx - ax, by - ay);
  ctx.imageSmoothingEnabled = true;
}

const looseShadows = new Map<string, HTMLCanvasElement>();
const LOOSE_PAD = 16;

export function drawLooseShadows(ctx: CanvasRenderingContext2D, solids: readonly Solid[]) {
  const pad = LOOSE_PAD;
  for (const s of solids) {
    const key = `${s.kind}${s.w}x${s.h}`;
    let image = looseShadows.get(key);
    if (!image) {
      const reach = MATERIALS[s.kind].height * SHADOW_PER_HEIGHT;
      image = document.createElement('canvas');
      image.width = Math.ceil((s.w + LIGHT.x * reach + pad * 2) * LAYER_SCALE);
      image.height = Math.ceil((s.h + LIGHT.y * reach + pad * 2) * LAYER_SCALE);
      const g = image.getContext('2d')!;
      g.setTransform(LAYER_SCALE, 0, 0, LAYER_SCALE, pad * LAYER_SCALE, pad * LAYER_SCALE);
      fillAO(g, [{ kind: s.kind, x: 0, y: 0, w: s.w, h: s.h }]);
      g.filter = `blur(${BLUR_PX * LAYER_SCALE}px)`;
      g.globalAlpha = SHADOW_ALPHA;
      fillHulls(g, [{ kind: s.kind, x: 0, y: 0, w: s.w, h: s.h }]);
      looseShadows.set(key, image);
    }
    ctx.drawImage(image, s.x - pad, s.y - pad, image.width / LAYER_SCALE, image.height / LAYER_SCALE);
  }
}

const tops = new Map<SolidKind, CanvasPattern>();
const beds = new Map<SolidKind, CanvasPattern>();

function patternOf(ctx: CanvasRenderingContext2D, cache: Map<SolidKind, CanvasPattern>, kind: SolidKind, paint: () => HTMLCanvasElement): CanvasPattern {
  let p = cache.get(kind);
  if (!p) cache.set(kind, (p = ctx.createPattern(paint(), 'repeat')!));
  return p;
}

/* ------------------------------------------------------------------------------------------------------------------ *
 * Per-solid character. Everything below is worked out once per solid from its position (so it never changes between
 * frames or clients) and drawn in a handful of batched paths.
 * ------------------------------------------------------------------------------------------------------------------ */

/** What lies under a top face when it is chipped away: the darker core of each material. */
const CORE: Record<SolidKind, { dark: string; lit: string }> = {
  stall: { dark: '#2e1e10', lit: '#4a3320' }, shopfront: { dark: '#25232a', lit: '#3a3742' }, stack: { dark: '#2e1e0d', lit: '#4a3319' }, cart: { dark: '#2a2e35', lit: '#3d424b' }, shrine: { dark: '#2e2c28', lit: '#4a4740' },
  gallery: { dark: '#3c1a22', lit: '#5e2a35' }, marble: { dark: '#5a5448', lit: '#8a8372' }, vitrine: { dark: '#2c3a3c', lit: '#46585a' }, plinth: { dark: '#4a4130', lit: '#6e6248' }, counter: { dark: '#2e1c10', lit: '#4e3320' },
  hull: { dark: '#273238', lit: '#3d4e55' }, tower: { dark: '#273238', lit: '#3d4e55' }, bulkhead: { dark: '#25282e', lit: '#383c44' }, rack: { dark: '#25282e', lit: '#383c44' }, water: { dark: '#10181c', lit: '#1b2a30' },
  hedge: { dark: '#223820', lit: '#3a5632' }, pond: { dark: '#22403f', lit: '#2f565a' }, parkstone: { dark: '#7b7562', lit: '#9a937d' }, trunk: { dark: '#46321f', lit: '#6a4b32' }, bench: { dark: '#664a2d', lit: '#8d6b44' }, play: { dark: '#8a6f2a', lit: '#c9a23c' },
  terminus: { dark: '#3c1f19', lit: '#5e342a' }, ironwork: { dark: '#1f2e26', lit: '#34503f' }, boxcar: { dark: '#3a1c14', lit: '#5c3022' }, sleepers: { dark: '#2e2216', lit: '#4a3826' }, kiosk: { dark: '#233328', lit: '#3a5644' }, coalheap: { dark: '#14151a', lit: '#25272e' },
  hangar: { dark: '#2a3234', lit: '#444f50' }, cinder: { dark: '#3a3d33', lit: '#585c4a' }, sbags: { dark: '#6e5d40', lit: '#8a7752' }, gse: { dark: '#3a3d22', lit: '#58602f' }, bunk: { dark: '#262b1e', lit: '#3a4229' }, pallet: { dark: '#2e1e0d', lit: '#4a3319' }, jersey: { dark: '#4a4840', lit: '#6a665a' },
  timber: { dark: '#46301d', lit: '#6e4d2e' }, hearth: { dark: '#4f4a42', lit: '#78725f' }, bartop: { dark: '#2e1c10', lit: '#4e3320' }, drift: { dark: '#7f90a6', lit: '#aebed2' }, machine: { dark: '#2a323a', lit: '#46525e' },
  embwall: { dark: '#4a463e', lit: '#6c675b' }, embglass: { dark: '#2c3f46', lit: '#4a6670' }, embfurn: { dark: '#3a2412', lit: '#5a3a20' }, embrack: { dark: '#1e242e', lit: '#323b48' }, embhedge: { dark: '#1f3a20', lit: '#38602f' },
  rubble: { dark: '#3a3833', lit: '#5a574e' }, scrap: { dark: '#3a2a1e', lit: '#5c4330' },
  sandstone: { dark: '#6e5d40', lit: '#8a7752' },
  concrete: { dark: '#25282e', lit: '#383c44' },
  slate: { dark: '#2a2e35', lit: '#3d424b' },
  brick: { dark: '#4d4128', lit: '#6a5a38' },
  wood: { dark: '#3a2616', lit: '#5c4129' },
  sandbag: { dark: '#6e5d40', lit: '#8a7752' },
  steel: { dark: '#272a31', lit: '#3d424b' },
  planter: { dark: '#262b1e', lit: '#3a4229' },
  crate: { dark: '#2e1e0d', lit: '#4a3319' },
  supply: { dark: '#232a1b', lit: '#364029' },
  pad: { dark: '#23262c', lit: '#383c44' },
  curb: { dark: '#1f2126', lit: '#2f3238' },
  core: { dark: '#23262c', lit: '#383c44' },
};
const REBAR: ReadonlySet<SolidKind> = new Set(['concrete', 'slate', 'brick', 'pad', 'core']);
const SPLINTERS: ReadonlySet<SolidKind> = new Set(['crate', 'supply', 'planter', 'wood']);

type Feature =
  | { thr: number; type: 'crater'; pts: number[]; halo: number[]; lit: number[]; sticks: number[] }
  | { thr: number; type: 'streak'; pts: number[] }
  | { thr: number; type: 'bite'; pts: number[]; edge: number[] };
type Plate = { t: 0 | 1 | 2; x: number; y: number; w: number; h: number };
type Layout = { rubble: number[]; tint: number; bolts: number[]; plates: Plate[]; bushes: number[]; feats: Feature[]; variant: number; horiz: boolean; stencil: string };

const layouts = new Map<string, Layout>();
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function craterAt(rand: () => number, s: Solid, thr: number, r: number, cx?: number, cy?: number): Feature {
  const m = 3;
  const px = cx ?? s.x + r + m + rand() * Math.max(0, s.w - 2 * (r + m)), py = cy ?? s.y + r + m + rand() * Math.max(0, s.h - 2 * (r + m));
  const n = 9, pts: number[] = [], halo: number[] = [], lit: number[] = [], sticks: number[] = [];
  const cl = (x: number, y: number): [number, number] => [clamp(x, s.x + 0.5, s.x + s.w - 0.5), clamp(y, s.y + 0.5, s.y + s.h - 0.5)];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand() * 0.3, k = r * (0.55 + rand() * 0.5);
    pts.push(...cl(px + Math.cos(a) * k * 1.15, py + Math.sin(a) * k));
    halo.push(...cl(px + Math.cos(a) * r * (1.5 + rand() * 0.5), py + Math.sin(a) * r * (1.4 + rand() * 0.45)));
    lit.push(...cl(px + 1.6 + Math.cos(a) * k * 0.7, py + 2 + Math.sin(a) * k * 0.62));
  }
  for (let i = 0; i < 2; i++) {
    const a = rand() * Math.PI * 2, l = r * (0.7 + rand() * 0.5);
    const [x0, y0] = cl(px + Math.cos(a) * r * 0.2, py + Math.sin(a) * r * 0.2);
    const [x1, y1] = cl(px + Math.cos(a) * l, py + Math.sin(a) * l);
    sticks.push(x0, y0, x1, y1);
  }
  return { thr, type: 'crater', pts, halo, lit, sticks };
}

/** A jagged bite out of a corner (or, with `along`, out of an edge), the way a shell or a pry bar leaves one. */
function biteAt(rand: () => number, base: Solid, thr: number, c: number, corner: number, edgeAt = 0.5): Feature {
  // A bite at a bottom corner is cut through the front face too.
  const s = corner >= 2 ? { ...base, h: base.h + PAINT_FACE[base.kind] } : base;
  c = Math.min(c, Math.min(s.w, s.h) * 0.45);
  const right = corner === 1 || corner === 3, bottom = corner === 2 || corner === 3;
  const ox = right ? s.x + s.w : s.x, oy = bottom ? s.y + s.h : s.y;
  const sx = right ? -1 : 1, sy = bottom ? -1 : 1;
  const j = () => 0.7 + rand() * 0.6;
  const edge = [c * j(), 0, c * 0.78 * j(), c * 0.28, c * 0.6, c * 0.34 * j(), c * 0.52 * j(), c * 0.62, c * 0.26, c * 0.7 * j(), 0, c * j()];
  const rel: number[] = [];
  for (let i = 0; i < edge.length; i += 2) rel.push(ox + sx * edge[i]!, oy + sy * edge[i + 1]!);
  void edgeAt;
  return { thr, type: 'bite', pts: [ox, oy, ...rel], edge: rel };
}

function edgeBiteAt(rand: () => number, base: Solid, thr: number, c: number, side: number): Feature {
  const s = side === 2 || side === 1 || side === 3 ? { ...base, h: base.h + PAINT_FACE[base.kind] } : base;
  const t = 0.2 + rand() * 0.6, d = Math.min(c * 0.7, Math.min(s.w, s.h) * 0.35), l = Math.min(c * 1.4, (side % 2 ? s.h : s.w) * 0.4);
  const pts: number[] = [];
  const along = (u: number, v: number): [number, number] => {
    switch (side) {
      case 0: return [s.x + s.w * t + u, s.y + v];
      case 1: return [s.x + s.w - v, s.y + s.h * t + u];
      case 2: return [s.x + s.w * t + u, s.y + s.h - v];
      default: return [s.x + v, s.y + s.h * t + u];
    }
  };
  const edge: number[] = [];
  const prof: [number, number][] = [[0, 0], [l * 0.12, d * 0.55], [l * 0.3, d * (0.7 + rand() * 0.3)], [l * 0.5, d * (0.35 + rand() * 0.3)], [l * 0.7, d * (0.8 + rand() * 0.2)], [l * 0.88, d * 0.45], [l, 0]];
  for (const [u, v] of prof) edge.push(...along(u, v));
  pts.push(...along(0, 0), ...edge, ...along(l, 0));
  return { thr, type: 'bite', pts, edge };
}

const layoutOfObject = new WeakMap<Solid, Layout>();

/** A solid's layout, remembered on the object for the frame and by position across frames. */
function layoutOf(s: Solid): Layout {
  let L = layoutOfObject.get(s);
  if (!L) layoutOfObject.set(s, (L = layoutAt(s)));
  return L;
}

function layoutAt(s: Solid): Layout {
  const key = `${s.kind}${s.x},${s.y},${s.w},${s.h}`;
  const known = layouts.get(key);
  if (known) return known;
  const rand = seeded(((Math.round(s.x) * 73856093) ^ (Math.round(s.y) * 19349663) ^ (Math.round(s.w) * 83492791) ^ (Math.round(s.h) * 2654435761)) >>> 0);
  const { x, y, w, h, kind } = s;
  const m = Math.min(w, h), long = Math.max(w, h), alongX = w >= h;
  const L: Layout = { rubble: [], tint: rand() - 0.5, bolts: [], plates: [], bushes: [], feats: [], variant: Math.floor(rand() * 3), horiz: rand() < 0.5, stencil: String(1 + Math.floor(rand() * 98)).padStart(2, '0') };
  const corners = (inset: number) => { for (const [cx, cy] of [[x + inset, y + inset], [x + w - inset, y + inset], [x + inset, y + h - inset], [x + w - inset, y + h - inset]] as const) L.bolts.push(cx, cy); };
  if ((kind === 'concrete' || kind === 'slate') && m >= 30) {
    corners(7);
    if (long >= 90) for (let i = 0; i < long / 20; i++) { if (i % 3 === 1) { const t = 12 + (i / (long / 20)) * (long - 24); L.bolts.push(alongX ? x + t : x + 7, alongX ? y + 7 : y + t, alongX ? x + t : x + w - 7, alongX ? y + h - 7 : y + t); } }
    const n = m >= 40 ? Math.min(5, Math.floor(long / 130)) : 0;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, type = Math.floor(rand() * 3) as 0 | 1 | 2;
      const pw = type === 0 ? 30 : type === 1 ? 26 : 22, ph = type === 0 ? 18 : type === 1 ? 10 : 22;
      const cu = (alongX ? x : y) + long * t + (rand() - 0.5) * Math.min(20, long / n - pw - 4), cv = (alongX ? y + h / 2 : x + w / 2) + (rand() - 0.5) * Math.max(0, m - ph - 24);
      const bw = alongX ? pw : ph, bh = alongX ? ph : pw;
      L.plates.push({ t: type, x: (alongX ? cu : cv) - bw / 2, y: (alongX ? cv : cu) - bh / 2, w: bw, h: bh });
    }
  } else if (kind === 'brick' || kind === 'steel') corners(6);
  else if (kind === 'wood') corners(5);
  else if (kind === 'pad') corners(5);
  else if (kind === 'planter' && m >= 30) {
    const step = 30, ix = x + 11, iy = y + 11, iw = w - 22, ih = h - 22;
    for (let by = 0; by <= Math.max(0, ih - 14); by += step) {
      for (let bx = 0; bx <= Math.max(0, iw - 14); bx += step) {
        const r = 7.5 + rand() * 4.5;
        L.bushes.push(clamp(ix + bx + 8 + rand() * 12, x + r + 7, x + w - r - 7), clamp(iy + by + 8 + rand() * 12, y + r + 7, y + h - r - 7), r, Math.floor(rand() * 3));
      }
    }
  }
  // Old battle damage the map was born with: a pit, a streak of soot and a bitten corner or two on bigger solids.
  if (kind !== 'curb' && kind !== 'core' && kind !== 'pad' && kind !== 'brick' && kind !== 'supply' && kind !== 'wood' && kind !== 'sandbag' && kind !== 'steel' && m >= 36) {
    if (rand() < 0.75) L.feats.push(craterAt(rand, s, -1, clamp(m * 0.13, 5, 11)));
    if (long >= 100 && rand() < 0.6) L.feats.push(craterAt(rand, s, -1, clamp(m * 0.1, 4, 8)));
    if (rand() < 0.65) L.feats.push(biteAt(rand, s, -1, 5 + rand() * 7, Math.floor(rand() * 4)));
    if (long >= 120 && rand() < 0.6) L.feats.push(edgeBiteAt(rand, s, -1, 8 + rand() * 6, Math.floor(rand() * 4)));
    if (rand() < 0.7) {
      const sx = x + 8 + rand() * Math.max(1, w - 24), sy = y + 6 + rand() * Math.max(1, h - 18), len = 12 + rand() * 18, wd = 3 + rand() * 4;
      const cl = (px: number, py: number) => [clamp(px, x + 0.5, x + w - 0.5), clamp(py, y + 0.5, y + h - 0.5)];
      L.feats.push({ thr: -1, type: 'streak', pts: [...cl(sx, sy), ...cl(sx + wd, sy), ...cl(sx + wd * 1.6 + len * LIGHT.x * 0.4, sy + len), ...cl(sx - wd * 0.2, sy + len * 0.85)] });
    }
  }
  // Damage taken in play: each stage adds to the last, so a solid visibly comes apart in steps.
  if (kind !== 'curb' && kind !== 'core' && m >= 28) {
    const big = clamp(m * 0.2, 6, 15);
    L.feats.push(
      craterAt(rand, s, 0.12, big * 0.55),
      craterAt(rand, s, 0.26, big * 0.8),
      edgeBiteAt(rand, s, 0.36, big * 0.9, Math.floor(rand() * 4)),
      craterAt(rand, s, 0.48, big),
      biteAt(rand, s, 0.58, big * 1.1, Math.floor(rand() * 4)),
      craterAt(rand, s, 0.68, big * 1.1),
      edgeBiteAt(rand, s, 0.76, big * 1.2, Math.floor(rand() * 4)),
      biteAt(rand, s, 0.84, big * 1.5, Math.floor(rand() * 4)),
      craterAt(rand, s, 0.9, big * 1.3),
    );
  }
  // Rubble at the foot: a little on old walls, and more of it with every stage of damage.
  if (PAINT_FACE[kind] > 0 && kind !== 'pad') {
    const foot = y + h + PAINT_FACE[kind];
    const chunk = (thr: number, big: number) => L.rubble.push(x + 3 + rand() * Math.max(1, w - 6), foot + 1 + rand() * 6, (2.4 + rand() * 2.6) * big, rand() * 6.28, thr);
    if (long >= 90) for (let i = 0, n = Math.floor(rand() * 4); i < n; i++) chunk(-1, 1);
    for (let i = 0; i < 10; i++) chunk(0.18 + i * 0.08, 1 + i * 0.07);
  }
  if (layouts.size > 3000) layouts.clear();
  layouts.set(key, L);
  return L;
}

const visible = (f: Feature, wear: number) => f.thr < 0 || f.thr < wear;
const polygon = (ctx: CanvasRenderingContext2D, pts: readonly number[]) => {
  ctx.moveTo(pts[0]!, pts[1]!);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
  ctx.closePath();
};

/** Soot, scorch halos, spalled craters with their lit far wall, exposed rebar or splintered wood, by material. */
function drawCraters(ctx: CanvasRenderingContext2D, kind: SolidKind, list: readonly Solid[]) {
  const core = CORE[kind];
  const found: { f: Feature; wear: number }[] = [];
  for (const s of list) {
    const wear = s.wear ?? 0;
    for (const f of layoutOf(s).feats) if (f.type !== 'bite' && visible(f, wear)) found.push({ f, wear });
  }
  if (!found.length) return;
  ctx.fillStyle = 'rgba(14, 14, 18, 0.2)';
  ctx.beginPath();
  for (const { f } of found) if (f.type === 'crater') polygon(ctx, f.halo);
  ctx.fill();
  ctx.fillStyle = 'rgba(14, 14, 18, 0.26)';
  ctx.beginPath();
  for (const { f } of found) if (f.type === 'streak') polygon(ctx, f.pts);
  ctx.fill();
  ctx.fillStyle = core.dark;
  ctx.beginPath();
  for (const { f } of found) if (f.type === 'crater') polygon(ctx, f.pts);
  ctx.fill();
  ctx.fillStyle = core.lit;
  ctx.beginPath();
  for (const { f } of found) if (f.type === 'crater') polygon(ctx, f.lit);
  ctx.fill();
  ctx.strokeStyle = INK_EDGE;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const { f } of found) if (f.type === 'crater') polygon(ctx, f.pts);
  ctx.stroke();
  if (REBAR.has(kind) || SPLINTERS.has(kind)) {
    const bars = REBAR.has(kind);
    ctx.lineCap = 'round';
    for (const [color, width] of [[INK_EDGE, 2.4], [bars ? '#8f5a38' : '#dcbe86', 1.2]] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const { f, wear } of found) {
        if (f.type !== 'crater' || f.thr < 0 || wear < f.thr + 0.1) continue;
        for (let i = 0; i < f.sticks.length; i += 4) { ctx.moveTo(f.sticks[i]!, f.sticks[i + 1]!); ctx.lineTo(f.sticks[i + 2]!, f.sticks[i + 3]!); }
      }
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }
  ctx.lineJoin = 'miter';
}

/** Bites out of corners and edges, cut after the outline so the top face really is missing there. */
function drawBites(ctx: CanvasRenderingContext2D, solids: readonly Solid[]) {
  const byKind = new Map<SolidKind, Feature[]>();
  for (const s of solids) {
    if (s.kind === 'curb' || s.kind === 'core') continue;
    const wear = s.wear ?? 0;
    for (const f of layoutOf(s).feats) if (f.type === 'bite' && visible(f, wear)) { const l = byKind.get(s.kind); if (l) l.push(f); else byKind.set(s.kind, [f]); }
  }
  ctx.lineJoin = 'round';
  for (const [kind, feats] of byKind) {
    ctx.fillStyle = CORE[kind].dark;
    ctx.beginPath();
    for (const f of feats) if (f.type === 'bite') polygon(ctx, f.pts);
    ctx.fill();
    ctx.strokeStyle = INK_EDGE;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (const f of feats) if (f.type === 'bite') { ctx.moveTo(f.edge[0]!, f.edge[1]!); for (let i = 2; i < f.edge.length; i += 2) ctx.lineTo(f.edge[i]!, f.edge[i + 1]!); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const f of feats) if (f.type === 'bite') { ctx.moveTo(f.edge[0]! + 1.2, f.edge[1]! + 1.6); for (let i = 2; i < f.edge.length; i += 2) ctx.lineTo(f.edge[i]! + 1.2, f.edge[i + 1]! + 1.6); }
    ctx.stroke();
  }
  ctx.lineJoin = 'miter';
}

function drawBolts(ctx: CanvasRenderingContext2D, list: readonly Solid[], radius: number) {
  ctx.fillStyle = 'rgba(14, 16, 20, 0.7)';
  ctx.beginPath();
  for (const s of list) { const b = layoutOf(s).bolts; for (let i = 0; i < b.length; i += 2) { ctx.moveTo(b[i]! + radius, b[i + 1]!); ctx.arc(b[i]!, b[i + 1]!, radius, 0, Math.PI * 2); } }
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.beginPath();
  for (const s of list) { const b = layoutOf(s).bolts; for (let i = 0; i < b.length; i += 2) { ctx.moveTo(b[i]! - 0.2 + radius * 0.4, b[i + 1]! - 0.6); ctx.arc(b[i]! - 0.6, b[i + 1]! - 0.6, radius * 0.4, 0, Math.PI * 2); } }
  ctx.fill();
}

function drawPlates(ctx: CanvasRenderingContext2D, list: readonly Solid[]) {
  const all = list.flatMap((s) => layoutOf(s).plates);
  if (!all.length) return;
  const of = (t: number) => all.filter((p) => p.t === t);
  // Vents: a dark housing with louvres.
  const vents = of(0);
  ctx.fillStyle = '#1f2227';
  ctx.beginPath();
  for (const p of vents) ctx.rect(p.x, p.y, p.w, p.h);
  ctx.fill();
  ctx.fillStyle = '#4b515b';
  ctx.beginPath();
  for (const p of vents) for (let i = 0; i < 4; i++) { const gx = p.x + 3 + i * ((p.w - 6) / 4); ctx.rect(gx, p.y + 3, (p.w - 6) / 4 - 2, p.h - 6); }
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.beginPath();
  for (const p of vents) ctx.rect(p.x, p.y, p.w, 1.5);
  ctx.fill();
  // Hazard plates: a diagonal-striped warning tag.
  const tags = of(1);
  ctx.fillStyle = '#c9a23c';
  ctx.beginPath();
  for (const p of tags) ctx.rect(p.x, p.y, p.w, p.h);
  ctx.fill();
  ctx.fillStyle = '#25282e';
  ctx.beginPath();
  for (const p of tags) for (let i = 0; i < 4; i++) { const gx = p.x + 2 + i * 6.5; ctx.moveTo(gx, p.y + p.h); ctx.lineTo(gx + 3, p.y + p.h); ctx.lineTo(Math.min(gx + 3 + p.h * 0.6, p.x + p.w), p.y); ctx.lineTo(Math.min(gx + p.h * 0.6, p.x + p.w), p.y); ctx.closePath(); }
  ctx.fill();
  // Hatches: a square cover with a handle and a hinge.
  const hatches = of(2);
  ctx.fillStyle = 'rgba(14, 16, 20, 0.5)';
  ctx.beginPath();
  for (const p of hatches) ctx.rect(p.x, p.y, p.w, p.h);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.beginPath();
  for (const p of hatches) ctx.rect(p.x + 2, p.y + 2, p.w - 4, p.h - 4);
  ctx.fill();
  ctx.fillStyle = '#2d3036';
  ctx.beginPath();
  for (const p of hatches) { ctx.rect(p.x + p.w * 0.3, p.y + p.h * 0.45, p.w * 0.4, 3); }
  ctx.fill();
  ctx.strokeStyle = INK_EDGE;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (const p of [...vents, ...tags, ...hatches]) ctx.rect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
  ctx.stroke();
}

const BUSH = [['#44502d', '#5a6a3c'], ['#4d5934', '#66774a'], ['#3a4429', '#56653a']] as const;

function drawBushes(ctx: CanvasRenderingContext2D, list: readonly Solid[]) {
  const all = list.map((s) => layoutOf(s).bushes);
  ctx.fillStyle = 'rgba(10, 14, 8, 0.42)';
  ctx.beginPath();
  for (const b of all) for (let i = 0; i < b.length; i += 4) { ctx.moveTo(b[i]! + 3 + b[i + 2]!, b[i + 1]! + 4); ctx.ellipse(b[i]! + 3, b[i + 1]! + 4, b[i + 2]!, b[i + 2]! * 0.92, 0, 0, Math.PI * 2); }
  ctx.fill();
  for (let c = 0; c < 3; c++) {
    ctx.fillStyle = BUSH[c]![0];
    ctx.beginPath();
    for (const b of all) for (let i = 0; i < b.length; i += 4) if (b[i + 3] === c) { ctx.moveTo(b[i]! + b[i + 2]!, b[i + 1]!); ctx.arc(b[i]!, b[i + 1]!, b[i + 2]!, 0, Math.PI * 2); }
    ctx.fill();
    ctx.fillStyle = BUSH[c]![1];
    ctx.beginPath();
    for (const b of all) for (let i = 0; i < b.length; i += 4) if (b[i + 3] === c) { ctx.moveTo(b[i]! - 1.5 + b[i + 2]! * 0.62, b[i + 1]! - 2); ctx.arc(b[i]! - 1.5, b[i + 1]! - 2, b[i + 2]! * 0.62, 0, Math.PI * 2); }
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(16, 20, 12, 0.7)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (const b of all) for (let i = 0; i < b.length; i += 4) { ctx.moveTo(b[i]! + b[i + 2]!, b[i + 1]!); ctx.arc(b[i]!, b[i + 1]!, b[i + 2]!, 0, Math.PI * 2); }
  ctx.stroke();
  // A few small bright leaf tips so the bushes catch the light.
  ctx.fillStyle = 'rgba(190, 215, 130, 0.5)';
  ctx.beginPath();
  for (const b of all) for (let i = 0; i < b.length; i += 4) { ctx.moveTo(b[i]! - 3.2 + 1.6, b[i + 1]! - 4); ctx.arc(b[i]! - 3.2, b[i + 1]! - 4, 1.6, 0, Math.PI * 2); }
  ctx.fill();
}

/** Crossed braces, as on a plank door: the built wall's own mark, so it never reads as a map wall. */
function drawBraces(ctx: CanvasRenderingContext2D, list: readonly Solid[]) {
  ctx.lineCap = 'butt';
  for (const [color, width, off] of [[INK_EDGE, 6.5, 0], ['#6a5a3a', 4, 0], ['rgba(255, 244, 214, 0.28)', 1.2, -1]] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const s of list) {
      if (Math.min(s.w, s.h) < 30) continue;
      const i = 7;
      ctx.moveTo(s.x + i + off, s.y + i + off); ctx.lineTo(s.x + s.w - i + off, s.y + s.h - i + off);
      ctx.moveTo(s.x + s.w - i + off, s.y + i + off); ctx.lineTo(s.x + i + off, s.y + s.h - i + off);
    }
    ctx.stroke();
  }
}

/** The barricade: a diagonal brace nailed across its boards, the way a door is boarded up. */
function drawBarricades(ctx: CanvasRenderingContext2D, list: readonly Solid[]) {
  ctx.lineCap = 'butt';
  for (const [color, width, off] of [[INK_EDGE, 7, 0], ['#a98859', 4.4, 0], ['rgba(255, 238, 200, 0.32)', 1.2, -1.2]] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const s of list) {
      const i = 6;
      ctx.moveTo(s.x + i + off, s.y + s.h - i + off); ctx.lineTo(s.x + s.w - i + off, s.y + i + off);
    }
    ctx.stroke();
  }
}

/** Sandbags stacked three courses deep, each a stuffed bag with an ink outline, a lit crown and a stitched seam, the rows staggered. */
function drawBagCourses(ctx: CanvasRenderingContext2D, list: readonly Solid[]) {
  const bags: { x: number; y: number; w: number; h: number; shade: number }[] = [];
  for (const s of list) {
    const rows = 3, rh = (s.h - 4) / rows;
    for (let r = 0; r < rows; r++) {
      const n = r % 2 ? 3 : 2, bw = (s.w - 4) / (r % 2 ? 2.5 : 2);
      for (let i = 0; i < n; i++) {
        const x = s.x + 2 + (r % 2 ? (i - 0.5) * bw : i * bw), w = bw;
        const x0 = Math.max(s.x + 2, x), x1 = Math.min(s.x + s.w - 2, x + w);
        if (x1 - x0 > 8) bags.push({ x: x0, y: s.y + 2 + r * rh, w: x1 - x0, h: rh, shade: (r * 3 + i) % 3 });
      }
    }
  }
  ctx.lineJoin = 'round';
  for (const [shade, fill] of [[0, '#b39e72'], [1, '#a8946a'], [2, '#9a875f']] as const) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    for (const b of bags) if (b.shade === shade) ctx.roundRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 5);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255, 246, 224, 0.3)';
  ctx.beginPath();
  for (const b of bags) ctx.roundRect(b.x + 3, b.y + 2, b.w - 8, b.h * 0.34, 3);
  ctx.fill();
  ctx.fillStyle = 'rgba(40, 30, 14, 0.22)';
  ctx.beginPath();
  for (const b of bags) ctx.rect(b.x + 3, b.y + b.h - 4, b.w - 6, 2);
  ctx.fill();
  ctx.strokeStyle = INK_EDGE;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (const b of bags) ctx.roundRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 5);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(46, 36, 22, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const b of bags) { ctx.moveTo(b.x + b.w * 0.3, b.y + b.h * 0.55); ctx.lineTo(b.x + b.w * 0.7, b.y + b.h * 0.55); }
  ctx.stroke();
  ctx.lineJoin = 'miter';
}

/** The steel wall: a heavy plate inset in the frame, riveted at its corners and down the middle, with a hazard tab. */
function drawSteelPlates(ctx: CanvasRenderingContext2D, list: readonly Solid[]) {
  ctx.fillStyle = 'rgba(14, 16, 20, 0.34)';
  ctx.beginPath();
  for (const s of list) { ctx.rect(s.x + 4, s.y + 4, s.w - 8, s.h - 8); }
  ctx.fill();
  ctx.fillStyle = '#7f8996';
  ctx.beginPath();
  for (const s of list) ctx.rect(s.x + 6, s.y + 6, s.w - 12, s.h - 12);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.beginPath();
  for (const s of list) { ctx.rect(s.x + 6, s.y + 6, s.w - 12, 2.5); ctx.rect(s.x + 6, s.y + 6, 2.5, s.h - 12); }
  ctx.fill();
  ctx.fillStyle = 'rgba(10, 12, 16, 0.28)';
  ctx.beginPath();
  for (const s of list) { ctx.rect(s.x + 6, s.y + s.h - 8.5, s.w - 12, 2.5); ctx.rect(s.x + s.w - 8.5, s.y + 6, 2.5, s.h - 12); }
  ctx.fill();
  ctx.strokeStyle = INK_EDGE;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (const s of list) ctx.rect(s.x + 6, s.y + 6, s.w - 12, s.h - 12);
  ctx.stroke();
  // A hazard tab across the plate's middle.
  ctx.save();
  ctx.beginPath();
  for (const s of list) ctx.rect(s.x + 12, s.y + s.h / 2 - 4, s.w - 24, 8);
  ctx.clip();
  ctx.fillStyle = '#c9a23c';
  for (const s of list) ctx.fillRect(s.x + 12, s.y + s.h / 2 - 4, s.w - 24, 8);
  ctx.restore();
  ctx.fillStyle = '#25282e';
  ctx.beginPath();
  for (const s of list) {
    const y = s.y + s.h / 2 - 4;
    for (let x = s.x + 12; x < s.x + s.w - 12; x += 8) { ctx.moveTo(x, y + 8); ctx.lineTo(x + 4, y + 8); ctx.lineTo(Math.min(x + 8, s.x + s.w - 12), y); ctx.lineTo(Math.min(x + 4, s.x + s.w - 12), y); ctx.closePath(); }
  }
  ctx.fill();
  ctx.strokeStyle = INK_EDGE;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (const s of list) ctx.rect(s.x + 12.5, s.y + s.h / 2 - 3.5, s.w - 25, 7);
  ctx.stroke();
}

/** A wooden supply crate: framed slats, then either a plank brace, steel straps or a stencilled lid, and it splinters as it is shot. */
function drawCrates(ctx: CanvasRenderingContext2D, list: readonly Solid[]) {
  for (const s of list) {
    const L = layoutOf(s), wear = s.wear ?? 0;
    const { x, y, w, h } = s;
    const e = 5, ix = x + e, iy = y + e, iw = w - e * 2, ih = h - e * 2;
    ctx.fillStyle = 'rgba(48, 30, 10, 0.34)';
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.rect(ix, iy, iw, ih);
    ctx.fill('evenodd');
    // Slats.
    const n = 3;
    ctx.fillStyle = 'rgba(255, 226, 172, 0.13)';
    ctx.beginPath();
    for (let i = 0; i < n; i += 2) { if (L.horiz) ctx.rect(ix, iy + (ih / n) * i, iw, ih / n); else ctx.rect(ix + (iw / n) * i, iy, iw / n, ih); }
    ctx.fill();
    ctx.strokeStyle = 'rgba(40, 26, 10, 0.6)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let i = 1; i < n; i++) { if (L.horiz) { ctx.moveTo(ix, iy + (ih / n) * i); ctx.lineTo(ix + iw, iy + (ih / n) * i); } else { ctx.moveTo(ix + (iw / n) * i, iy); ctx.lineTo(ix + (iw / n) * i, iy + ih); } }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(40, 26, 10, 0.5)';
    ctx.strokeRect(ix + 0.5, iy + 0.5, iw - 1, ih - 1);
    if (L.variant === 0) {
      for (const [color, width, off] of [['rgba(34, 22, 8, 0.85)', 6, 0], ['#b08c58', 3.6, 0], ['rgba(255, 240, 200, 0.3)', 1, -0.8]] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(ix + 2 + off, iy + 2 + off); ctx.lineTo(ix + iw - 2 + off, iy + ih - 2 + off);
        ctx.moveTo(ix + iw - 2 + off, iy + 2 + off); ctx.lineTo(ix + 2 + off, iy + ih - 2 + off);
        ctx.stroke();
      }
    } else if (L.variant === 1) {
      ctx.fillStyle = '#383b42';
      for (const f of [0.26, 0.74]) ctx.fillRect(x + w * f - 2.8, y, 5.6, h);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      for (const f of [0.26, 0.74]) ctx.fillRect(x + w * f - 2.8, y, 1.4, h);
      ctx.fillStyle = '#e0661f';
      ctx.fillRect(x + w * 0.5 - 6, y + h * 0.5 - 5, 12, 3);
      ctx.fillRect(x + w * 0.5 - 6, y + h * 0.5 + 1, 12, 3);
    } else {
      ctx.fillStyle = 'rgba(30, 24, 18, 0.7)';
      ctx.beginPath();
      ctx.moveTo(x + w / 2, y + h / 2 - 8); ctx.lineTo(x + w / 2 + 7, y + h / 2 + 2); ctx.lineTo(x + w / 2 + 2.5, y + h / 2 + 2); ctx.lineTo(x + w / 2 + 2.5, y + h / 2 + 8); ctx.lineTo(x + w / 2 - 2.5, y + h / 2 + 8); ctx.lineTo(x + w / 2 - 2.5, y + h / 2 + 2); ctx.lineTo(x + w / 2 - 7, y + h / 2 + 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#383b42';
      ctx.fillRect(x + w / 2 - 4, y + h - 9, 8, 5);
    }
    ctx.fillStyle = 'rgba(14, 16, 20, 0.72)';
    ctx.beginPath();
    for (const [bx, by] of [[x + 3, y + 3], [x + w - 3, y + 3], [x + 3, y + h - 3], [x + w - 3, y + h - 3]] as const) { ctx.moveTo(bx + 1.4, by); ctx.arc(bx, by, 1.4, 0, Math.PI * 2); }
    ctx.fill();
    // Damage to the slats: a snapped board, then a missing one with splinters.
    if (wear > 0.28) {
      const px = L.horiz ? ix : ix + (iw / n), py = L.horiz ? iy + ih / n : iy;
      ctx.strokeStyle = 'rgba(22, 14, 6, 0.9)';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      if (L.horiz) { ctx.moveTo(ix + iw * 0.1, py + 2); ctx.lineTo(ix + iw * 0.3, py + ih / n - 3); ctx.lineTo(ix + iw * 0.46, py + 3); ctx.lineTo(ix + iw * 0.62, py + ih / n - 2); }
      else { ctx.moveTo(px + 2, iy + ih * 0.1); ctx.lineTo(px + iw / n - 3, iy + ih * 0.3); ctx.lineTo(px + 3, iy + ih * 0.46); ctx.lineTo(px + iw / n - 2, iy + ih * 0.62); }
      ctx.stroke();
    }
    if (wear > 0.56) {
      const bx = L.horiz ? ix : ix + (iw / n) * 2, by = L.horiz ? iy + (ih / n) * 2 : iy, bw = L.horiz ? iw : iw / n, bh = L.horiz ? ih / n : ih;
      ctx.fillStyle = 'rgba(20, 12, 4, 0.92)';
      ctx.fillRect(bx + 1, by + 1, bw - 2, bh - 2);
      ctx.fillStyle = '#dcbe86';
      ctx.strokeStyle = INK_EDGE;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        if (L.horiz) { const sx = bx + 4 + i * (bw / 4); ctx.moveTo(sx, by + 1); ctx.lineTo(sx + 4, by + 1); ctx.lineTo(sx + 2, by + 6 + (i % 2) * 3); } else { const sy = by + 4 + i * (bh / 4); ctx.moveTo(bx + 1, sy); ctx.lineTo(bx + 1, sy + 4); ctx.lineTo(bx + 6 + (i % 2) * 3, sy + 2); }
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
    }
  }
}

/** A royale supply case: olive-drab steel, a lid line, latches, an orange band and a stencilled serial. */
function drawSupply(ctx: CanvasRenderingContext2D, list: readonly Solid[]) {
  for (const s of list) {
    const { x, y, w, h } = s, L = layoutOf(s);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 5, y + 5, w - 10, h - 10);
    ctx.fillStyle = '#e0661f';
    ctx.fillRect(x + 5, y + h * 0.5 - 4, w - 10, 8);
    ctx.fillStyle = '#2a2d33';
    for (const f of [0.3, 0.7]) ctx.fillRect(x + w * f - 4, y + 2, 8, 6);
    ctx.fillStyle = 'rgba(20, 22, 26, 0.75)';
    stencil(ctx, L.stencil, x + w / 2 - 8.8, y + h * 0.5 - 3.2, 6.4);
  }
}


const FRONT: Record<SolidKind, string> = {
  hangar: '#434d4c', cinder: '#5a5e4c', sbags: '#8b7a56', gse: '#555a33', bunk: '#434b36', pallet: '#7d6038', jersey: '#8a8678',
  embwall: '#8d8676', embglass: '#52707a', embfurn: '#4a2f1a', embrack: '#262c36', embhedge: '#2c4c28', rubble: '#4e4b44', scrap: '#5a4030',
  stall: '#553a22', shopfront: '#2f2c36', stack: '#6a4e2c', cart: '#5a5f66', shrine: '#5e5a50',
  gallery: '#5a2431', marble: '#9b937f', vitrine: '#5f8087', plinth: '#7d6f55', counter: '#55371f',
  hull: '#35464c', tower: '#3f555b', bulkhead: '#454c57', rack: '#2f343c', water: '#10181c', hedge: '#2f4a2b', pond: '#22403f', parkstone: '#7b7562', trunk: '#46321f', bench: '#664a2d', play: '#8a6f2a',
  terminus: '#5e3028', ironwork: '#26382e', boxcar: '#52281c', sleepers: '#3c2c1e', kiosk: '#2e4538', coalheap: '#1a1b20',
  timber: '#4e3720', hearth: '#58534a', bartop: '#55371f', drift: '#7488a0', machine: '#303a44',
  sandstone: '#8e7d5a', concrete: '#484d56', slate: '#3b4049', brick: '#756748', planter: '#585e45',
  crate: '#7d6038', supply: '#454f31', pad: '#363a42', curb: '#25282e', core: '#2e323a', wood: '#6e5337', sandbag: '#8b7a56', steel: '#4d5560',
};

/** The front faces: flat, darker than the tops, with their own seams, rivets and baseboard, laid before any top so nearer solids cover them. */
function drawFronts(ctx: CanvasRenderingContext2D, byKind: ReadonlyMap<SolidKind, readonly Solid[]>) {
  for (const [kind, list] of byKind) {
    const fh = PAINT_FACE[kind];
    if (!fh) continue;
    ctx.fillStyle = FRONT[kind];
    ctx.beginPath();
    for (const s of list) ctx.rect(s.x, s.y + s.h, s.w, fh);
    ctx.fill();
    // Wear darkens the face along with the top.
    for (const s of list) { if (!s.wear) continue; ctx.fillStyle = `rgba(20, 22, 28, ${(0.4 * s.wear).toFixed(3)})`; ctx.fillRect(s.x, s.y + s.h, s.w, fh); }
    // Light catching the upper edge, shade pooling at the foot.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.13)';
    ctx.beginPath();
    for (const s of list) ctx.rect(s.x, s.y + s.h, s.w, 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(10, 12, 16, 0.34)';
    ctx.beginPath();
    for (const s of list) ctx.rect(s.x, s.y + s.h + fh - Math.max(3, fh * 0.28), s.w, Math.max(3, fh * 0.28));
    ctx.fill();
    ctx.strokeStyle = 'rgba(14, 16, 20, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const s of list) {
      const y0 = s.y + s.h;
      if (kind === 'sandstone' || kind === 'sandbag') {
        // Two courses of sandbags, staggered.
        for (let c = 0; c < 2; c++) {
          const cy = y0 + (fh / 2) * c;
          if (c) { ctx.moveTo(s.x, cy + 0.5); ctx.lineTo(s.x + s.w, cy + 0.5); }
          for (let x = s.x + 12 + c * 12; x < s.x + s.w - 2; x += 24) { ctx.moveTo(x + 0.5, cy + 1); ctx.lineTo(x + 0.5, cy + fh / 2); }
        }
      } else if (kind === 'crate' || kind === 'wood') {
        for (let x = s.x + (kind === 'wood' ? 9 : 11); x < s.x + s.w - 3; x += kind === 'wood' ? 9 : 11) { ctx.moveTo(x + 0.5, y0 + 1); ctx.lineTo(x + 0.5, y0 + fh - 1); }
      } else if (kind === 'concrete' || kind === 'slate' || kind === 'planter' || kind === 'steel') {
        ctx.moveTo(s.x, y0 + fh * 0.5 + 0.5); ctx.lineTo(s.x + s.w, y0 + fh * 0.5 + 0.5);
        for (let x = s.x + 50; x < s.x + s.w - 4; x += 50) { ctx.moveTo(x + 0.5, y0 + 1); ctx.lineTo(x + 0.5, y0 + fh * 0.5); }
      } else if (kind === 'brick' || kind === 'supply') {
        ctx.moveTo(s.x, y0 + fh * 0.5 + 0.5); ctx.lineTo(s.x + s.w, y0 + fh * 0.5 + 0.5);
      }
    }
    ctx.stroke();
    if (kind === 'concrete' || kind === 'slate' || kind === 'brick' || kind === 'steel') {
      ctx.fillStyle = 'rgba(14, 16, 20, 0.6)';
      ctx.beginPath();
      for (const s of list) for (let x = s.x + 8; x < s.x + s.w - 4; x += 16) { ctx.moveTo(x + 1.3, s.y + s.h + fh * 0.3); ctx.arc(x, s.y + s.h + fh * 0.3, 1.3, 0, Math.PI * 2); }
      ctx.fill();
    }
    if (kind === 'supply') {
      ctx.fillStyle = '#e0661f';
      ctx.beginPath();
      for (const s of list) ctx.rect(s.x, s.y + s.h + 3, s.w, 3);
      ctx.fill();
    }
    if (kind === 'planter') {
      // Moss and trailing leaves over the lip.
      ctx.fillStyle = '#4d5934';
      ctx.beginPath();
      for (const s of list) for (let x = s.x + 6; x < s.x + s.w - 4; x += 17 + ((x * 7) % 9)) { ctx.moveTo(x - 4, s.y + s.h); ctx.lineTo(x + 5, s.y + s.h); ctx.lineTo(x + 1, s.y + s.h + 6 + ((x * 13) % 5)); ctx.closePath(); }
      ctx.fill();
    }
    ctx.strokeStyle = INK_EDGE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const s of list) ctx.rect(s.x, s.y + s.h, s.w, fh);
    ctx.stroke();
  }
}

/** Chunks of fallen wall at each solid's foot, over the front faces and under the tops. */
function drawRubble(ctx: CanvasRenderingContext2D, solids: readonly Solid[]) {
  const pieces: { x: number; y: number; r: number; a: number; kind: SolidKind }[] = [];
  for (const s of solids) {
    if (!PAINT_FACE[s.kind] || s.kind === 'pad') continue;
    const r = layoutOf(s).rubble, wear = s.wear ?? 0;
    for (let i = 0; i < r.length; i += 5) if (r[i + 4]! < 0 || r[i + 4]! < wear) pieces.push({ x: r[i]!, y: r[i + 1]!, r: r[i + 2]!, a: r[i + 3]!, kind: s.kind });
  }
  if (!pieces.length) return;
  const poly = (pc: (typeof pieces)[number]) => {
    for (let i = 0; i < 5; i++) {
      const a = pc.a + i * 1.2566, k = pc.r * (0.75 + 0.25 * Math.sin(pc.a * 7 + i * 2.3));
      const px = pc.x + Math.cos(a) * k * 1.2, py = pc.y + Math.sin(a) * k * 0.85;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.closePath();
  };
  ctx.fillStyle = 'rgba(14, 16, 20, 0.28)';
  ctx.beginPath();
  for (const pc of pieces) { ctx.moveTo(pc.x + pc.r * 1.6 + 2, pc.y + 2); ctx.ellipse(pc.x + 2, pc.y + 2.2, pc.r * 1.6, pc.r, 0, 0, Math.PI * 2); }
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK_EDGE;
  ctx.lineWidth = 1.2;
  for (const pc of pieces) {
    ctx.fillStyle = MATERIALS[pc.kind].top;
    ctx.beginPath();
    poly(pc);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.fillRect(pc.x - pc.r * 0.7, pc.y - pc.r * 0.55, pc.r * 0.9, 1);
  }
  ctx.lineJoin = 'miter';
}

function drawDetails(ctx: CanvasRenderingContext2D, kind: SolidKind, list: readonly Solid[]) {
  switch (kind) {
    case 'concrete': case 'slate': drawPlates(ctx, list); drawBolts(ctx, list, 1.9); break;
    case 'brick': drawBraces(ctx, list); drawBolts(ctx, list, 1.8); break;
    case 'wood': drawBarricades(ctx, list); drawBolts(ctx, list, 1.5); break;
    case 'sandbag': drawBagCourses(ctx, list); break;
    case 'steel': drawSteelPlates(ctx, list); drawBolts(ctx, list, 2.2); break;
    case 'pad': drawBolts(ctx, list, 1.6); break;
    case 'planter': drawBushes(ctx, list); break;
    case 'crate': drawCrates(ctx, list); break;
    case 'supply': drawSupply(ctx, list); break;
    default: break;
  }
}

function drawTints(ctx: CanvasRenderingContext2D, list: readonly Solid[]) {
  for (const [color, sign] of [['rgba(255, 244, 220, 0.07)', 1], ['rgba(12, 14, 18, 0.09)', -1]] as const) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const s of list) if (layoutOf(s).tint * sign > 0.18) ctx.rect(s.x, s.y, s.w, s.h);
    ctx.fill();
  }
}

/**
 * Paints solids straight onto `ctx`: lips, front faces, rubble, tops with their details and damage, bevels, outlines and
 * bites. The game does not call this every frame; `drawSolids` paints each solid once into a sprite and blits that.
 */
export function paintSolids(ctx: CanvasRenderingContext2D, all: readonly Solid[]) {
  const solids = paintThemedSolids(ctx, all);
  const byKind = new Map<SolidKind, Solid[]>();
  for (const s of solids) {
    const list = byKind.get(s.kind);
    if (list) list.push(s);
    else byKind.set(s.kind, [s]);
  }
  ctx.lineJoin = 'miter';
  ctx.fillStyle = LIP_COLOR;
  ctx.strokeStyle = INK_EDGE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const s of solids) ctx.rect(s.x + LIP / 2, s.y + LIP / 2, s.w + LIP / 2, s.h + LIP / 2);
  ctx.fill();
  ctx.stroke();
  drawFronts(ctx, byKind);
  drawRubble(ctx, solids);
  for (const [kind, list] of byKind) drawTops(ctx, kind, list);
  const e = BEVEL.edge;
  ctx.fillStyle = BEVEL.light;
  ctx.beginPath();
  for (const s of solids) {
    if (s.kind === 'curb') continue;
    ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + s.w, s.y); ctx.lineTo(s.x + s.w - e, s.y + e); ctx.lineTo(s.x + e, s.y + e); ctx.lineTo(s.x + e, s.y + s.h - e); ctx.lineTo(s.x, s.y + s.h); ctx.closePath();
  }
  ctx.fill();
  ctx.fillStyle = BEVEL.dark;
  ctx.beginPath();
  for (const s of solids) {
    if (s.kind === 'curb') continue;
    ctx.moveTo(s.x + s.w, s.y); ctx.lineTo(s.x + s.w, s.y + s.h); ctx.lineTo(s.x, s.y + s.h); ctx.lineTo(s.x + e, s.y + s.h - e); ctx.lineTo(s.x + s.w - e, s.y + s.h - e); ctx.lineTo(s.x + s.w - e, s.y + e); ctx.closePath();
  }
  ctx.fill();
  ctx.strokeStyle = INK_EDGE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const s of solids) ctx.rect(s.x, s.y, s.w, s.h);
  ctx.stroke();
  drawBites(ctx, solids);
}

function drawTops(ctx: CanvasRenderingContext2D, kind: SolidKind, list: readonly Solid[]) {
  const m = MATERIALS[kind];
  ctx.fillStyle = patternOf(ctx, tops, kind, () => (kind === 'curb' ? paintHazard(HAZARD.a, HAZARD.b, HAZARD.band) : paintGrain(m.top, m.grain, kind.length * 7919)));
  ctx.beginPath();
  for (const s of list) ctx.rect(s.x, s.y, s.w, s.h);
  // Grain needs no filtering, and filtered pattern fills cost a software canvas 2-3ms a frame across the 6000 maps' big blocks.
  ctx.imageSmoothingEnabled = false;
  ctx.fill();
  ctx.imageSmoothingEnabled = true;
  if (m.bed) drawBeds(ctx, kind, m.bed, list);
  if (kind !== 'curb' && kind !== 'core') drawTints(ctx, list);
  drawDetails(ctx, kind, list);
  for (const s of list) {
    if (!s.wear) continue;
    ctx.fillStyle = `rgba(20, 22, 28, ${(0.4 * s.wear).toFixed(3)})`;
    ctx.fillRect(s.x, s.y, s.w, s.h);
  }
  if (kind !== 'curb' && kind !== 'core') drawCraters(ctx, kind, list);
  drawWearCracks(ctx, list);
}

function drawBeds(ctx: CanvasRenderingContext2D, kind: SolidKind, bed: Bed, list: readonly Solid[]) {
  ctx.fillStyle = patternOf(ctx, beds, kind, () => paintFoliage(bed.ground, bed.leaves, 64, 31));
  ctx.beginPath();
  for (const s of list) ctx.rect(s.x + bed.inset, s.y + bed.inset, s.w - bed.inset * 2, s.h - bed.inset * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(20, 24, 18, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const s of list) {
    ctx.moveTo(s.x + bed.inset, s.y + s.h - bed.inset);
    ctx.lineTo(s.x + bed.inset, s.y + bed.inset);
    ctx.lineTo(s.x + s.w - bed.inset, s.y + bed.inset);
  }
  ctx.stroke();
}

const CRACK_STEPS = [0.15, 0.45, 0.75] as const;
const crackCache = new Map<string, number[][]>();

function cracksAt(s: Solid): number[][] {
  const key = `${s.x},${s.y},${s.w}`;
  let lines = crackCache.get(key);
  if (lines) return lines;
  let seed = (Math.round(s.x) * 73856093) ^ (Math.round(s.y) * 19349663);
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  lines = CRACK_STEPS.map(() => {
    const x = s.w * (0.2 + rnd() * 0.6), y = s.h * (0.15 + rnd() * 0.3);
    const cx = (v: number) => Math.min(s.w - 2, Math.max(2, v)), cy = (v: number) => Math.min(s.h - 2, Math.max(2, v));
    return [x, y, cx(x + (rnd() - 0.5) * s.w * 0.45), cy(y + s.h * (0.15 + rnd() * 0.2)), cx(x + (rnd() - 0.5) * s.w * 0.6), cy(y + s.h * (0.35 + rnd() * 0.25))];
  });
  if (crackCache.size > 2000) crackCache.clear();
  crackCache.set(key, lines);
  return lines;
}

/** Fractures between the craters: a dark fissure with a pale lip beside it, so they read as breaks and not as pen lines. */
function drawWearCracks(ctx: CanvasRenderingContext2D, list: readonly Solid[]) {
  ctx.lineJoin = 'round';
  for (const [color, width, off] of [['rgba(255, 255, 255, 0.22)', 1.2, 1.4], ['rgba(20, 18, 22, 0.8)', 2.2, 0]] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const s of list) {
      const n = CRACK_STEPS.filter((t) => (s.wear ?? 0) > t).length;
      for (const c of cracksAt(s).slice(0, n)) {
        ctx.moveTo(s.x + c[0]! + off, s.y + c[1]! + off); ctx.lineTo(s.x + c[2]! + off, s.y + c[3]! + off); ctx.lineTo(s.x + c[4]! + off, s.y + c[5]! + off);
      }
    }
    ctx.stroke();
  }
  ctx.lineJoin = 'miter';
}

const SPRITE_PAD = 8;
const SPRITE_BUDGET = 48_000_000;
const sprites = new Map<string, HTMLCanvasElement>();
let spritePixels = 0;
onMapChange(() => { sprites.clear(); spritePixels = 0; });
/** Anything this big (the map-edge curbs, the core) is cheaper to paint directly than to cache. */
const DIRECT = (s: Solid) => s.kind === 'curb' || s.kind === 'core' || s.w > 900 || s.h > 900;

let scratch: HTMLCanvasElement | null = null;

/**
 * The finishing pass every solid gets after it is painted, whoever painted it: the front face is stretched to its drawn
 * height, then the light is laid over the whole sprite (only where it already has paint, `source-atop`): a bright rim
 * along the top face's lit edges, a lift on tall tops so they sit above the floor and lower cover, a darker band at the
 * foot of the face, and the shadows of any taller neighbour.
 */
function finishSprite(g: CanvasRenderingContext2D, s: Solid, scale: number): void {
  const m = MATERIALS[s.kind], face = FACE[s.kind];
  if (m.height <= 0) return;
  g.save();
  g.setTransform(scale, 0, 0, scale, (SPRITE_PAD - s.x) * scale, (SPRITE_PAD - s.y) * scale);
  g.globalCompositeOperation = 'source-atop';
  const { x, y, w, h } = s;
  // Taller tops are brighter, so full walls and buildings stand out from crates and sandbags and every top from the floor.
  const lift = Math.max(0, Math.min(1, (m.height - 14) / 44));
  if (lift > 0) { g.fillStyle = `rgba(255, 246, 228, ${(0.09 + 0.17 * lift).toFixed(3)})`; g.fillRect(x, y, w, h); }
  if (face > 0) {
    g.fillStyle = 'rgba(8, 10, 16, 0.2)';
    g.fillRect(x, y + h + face * 0.55, w, face * 0.45);
    g.fillStyle = 'rgba(255, 255, 255, 0.16)';
    g.fillRect(x + 2, y + h + 2, w - 4, 1.5);
  }
  // The rim: a hard pale line along the north and west edges (toward the light) and a thin dark seam south and east.
  g.fillStyle = 'rgba(255, 255, 255, 0.5)';
  g.fillRect(x + 1, y + 1, w - 2, 2);
  g.fillRect(x + 1, y + 3, 2, h - 4);
  g.fillStyle = 'rgba(255, 255, 255, 0.2)';
  g.fillRect(x + 3, y + 3, w - 6, 2);
  g.fillRect(x + 3, y + 5, 2, h - 8);
  g.fillStyle = 'rgba(8, 10, 16, 0.34)';
  g.fillRect(x + 3, y + h - 2, w - 4, 2);
  g.fillRect(x + w - 2, y + 3, 2, h - 5);
  // A raised lip throws a hard inner shadow onto the recessed top, along the edges that face the light.
  if (m.height >= 30 && w > 24 && h > 24) {
    const d = Math.min(7, 2 + (m.height - 30) / 6);
    g.fillStyle = 'rgba(8, 10, 18, 0.2)';
    g.fillRect(x + 3, y + 3, w - 6, d);
    g.fillRect(x + 3, y + 3 + d, d, h - 6 - d);
  }
  const cast = shadowsOn(s);
  if (cast.length) {
    g.beginPath();
    g.rect(x, y, w, h + face);
    g.clip();
    g.fillStyle = 'rgba(8, 10, 18, 0.32)';
    g.beginPath();
    for (const hull of cast) { g.moveTo(hull[0]!, hull[1]!); for (let i = 2; i < hull.length; i += 2) g.lineTo(hull[i]!, hull[i + 1]!); g.closePath(); }
    g.fill();
  }
  g.restore();
}

function spriteOf(s: Solid, scale: number): HTMLCanvasElement {
  const wear = s.wear ? Math.round(s.wear * 20) / 20 : 0;
  const cast = shadowsOn(s).length;
  const key = `${s.kind}${s.x},${s.y},${s.w},${s.h}|${wear}|${scale}|${cast}`;
  let image = sprites.get(key);
  if (image) return image;
  const W = Math.ceil((s.w + LIP + SPRITE_PAD * 2) * scale), H = Math.ceil((s.h + FOOT + LIP + SPRITE_PAD * 2) * scale);
  const pf = PAINT_FACE[s.kind], extra = FACE[s.kind] - pf;
  image = document.createElement('canvas');
  image.width = W;
  image.height = H;
  if (spritePixels + W * H > SPRITE_BUDGET) { sprites.clear(); spritePixels = 0; }
  spritePixels += W * H;
  const stretch = pf >= 8 && extra > 0;
  let g = image.getContext('2d')!;
  if (stretch) {
    // Paint at the painter's own face height, then pull the middle of the face down: its top line and its foot stay crisp.
    scratch ??= document.createElement('canvas');
    scratch.width = W;
    scratch.height = H;
    g = scratch.getContext('2d')!;
  }
  g.setTransform(scale, 0, 0, scale, (SPRITE_PAD - s.x) * scale, (SPRITE_PAD - s.y) * scale);
  paintSolids(g, [{ ...s, wear }]);
  if (stretch) {
    const out = image.getContext('2d')!;
    const top = Math.round((SPRITE_PAD + s.h + 3) * scale), foot = Math.round((SPRITE_PAD + s.h + pf - 4) * scale), add = Math.round(extra * scale);
    out.imageSmoothingEnabled = true;
    out.drawImage(scratch!, 0, 0, W, top, 0, 0, W, top);
    out.drawImage(scratch!, 0, top, W, foot - top, 0, top, W, foot - top + add);
    out.drawImage(scratch!, 0, foot, W, H - foot - add, 0, foot + add, W, H - foot - add);
    scratch!.width = scratch!.height = 1;
  }
  finishSprite(image.getContext('2d')!, s, scale);
  sprites.set(key, image);
  return image;
}

/**
 * Draws solids as cached sprites, farthest first so a nearer solid's top covers the front face of the one behind it. A
 * sprite is painted once per solid and damage stage, so all the detail above costs one blit a frame.
 */
export function drawSolids(ctx: CanvasRenderingContext2D, solids: readonly Solid[]) {
  const direct = solids.filter(DIRECT);
  if (direct.length) paintSolids(ctx, direct);
  const cached = solids.filter((s) => !DIRECT(s)).sort((a, b) => a.y + a.h - (b.y + b.h));
  if (!cached.length) return;
  const k = ctx.getTransform().a || 1;
  const scale = k > 1.25 ? 2 : 1;
  ctx.imageSmoothingEnabled = Math.abs(k - scale) > 0.01;
  for (const s of cached) {
    const image = spriteOf(s, scale);
    ctx.drawImage(image, s.x - SPRITE_PAD, s.y - SPRITE_PAD, image.width / scale, image.height / scale);
  }
  ctx.imageSmoothingEnabled = true;
}
