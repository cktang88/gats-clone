import { BUILDINGS, MAX_LEVEL, UPGRADE, WALL_TIERS, ZOM, zombieRole, type BuildingKind, type GunId, type TurretDef, type TurretKind, type WallTier } from '../defs.ts';
import type { BuildingView } from '../protocol.ts';
import { circleHitsRect, dist2, rectsOverlap, type Rect } from './movement.ts';
import type { Building, FloorItem } from './world.ts';

/**
 * Whether a player holding `gun` may build, upgrade and take down in this phase of the run: anyone by day, and by night a gun whose role
 * says so (the pistol class's field mechanic, `ZombieRole.nightBuild`). Its current gun, so swapping off one at night ends it.
 */
export const buildsNow = (phase: 'day' | 'night' | 'over', gun: GunId | null | undefined): boolean =>
  phase === 'day' || (phase === 'night' && !!gun && zombieRole(gun).nightBuild);

/** Why a building cannot go up, or null once it may: `notDay` when it is not a time the builder may build (`buildsNow`). */
export type BuildRefusal = 'notDay' | 'farFromCore' | 'outOfReach' | 'cover' | 'core' | 'body' | 'taken' | 'scrap';
/** Why a building cannot be upgraded, or null once it may: `none` there to upgrade, `maxed` at its top level. */
export type UpgradeRefusal = 'notDay' | 'outOfReach' | 'none' | 'maxed' | 'scrap';

type Leveled = { kind: BuildingKind; lv?: number };
export const levelOf = (b: Pick<Leveled, 'lv'>): number => b.lv ?? 1;
/** The top level of a kind: a wall's third tier, a turret's or utility's third level, a spike strip's only one. */
export const maxLevelOf = (kind: BuildingKind): number => (kind === 'spikes' ? 1 : MAX_LEVEL);
export const wallTier = (lv: number): WallTier => WALL_TIERS[Math.min(WALL_TIERS.length, Math.max(1, lv)) - 1]!;
/** What a kind goes up at `lv` for: a wall by tier, anything else always at its first level. */
export const costOf = (kind: BuildingKind, lv = 1): number => (kind === 'wall' ? wallTier(lv).cost : BUILDINGS[kind].cost);
/** A wall's tier name, or a building's with its level in numerals past the first: Cannon, Cannon II, Cannon III. */
export const nameOf = (kind: BuildingKind, lv = 1): string => (kind === 'wall' ? wallTier(lv).name : lv > 1 ? `${BUILDINGS[kind].name} ${'I'.repeat(lv)}` : BUILDINGS[kind].name);
export const maxHpOf = (kind: BuildingKind, lv = 1): number => (kind === 'wall' ? wallTier(lv).hp : Math.round(BUILDINGS[kind].hp * UPGRADE.hp[Math.min(lv, MAX_LEVEL) - 1]!));

/** The scrap it takes to go from `lv` to the next level, or null at the top. A wall pays the difference of its tiers' prices. */
export function upgradeCost(kind: BuildingKind, lv: number): number | null {
  if (lv >= maxLevelOf(kind)) return null;
  return kind === 'wall' ? wallTier(lv + 1).cost - wallTier(lv).cost : Math.round(BUILDINGS[kind].cost * UPGRADE.costShare[lv - 1]!);
}

/** Everything spent to have `kind` standing at `lv`: its price plus each upgrade, so taking it down pays back a share of all of it. */
export function investedOf(kind: BuildingKind, lv = 1): number {
  if (kind === 'wall') return wallTier(lv).cost;
  let total = BUILDINGS[kind].cost;
  for (let l = 1; l < lv; l++) total += upgradeCost(kind, l) ?? 0;
  return total;
}

const defs = new Map<string, TurretDef>();
/** A turret's stats at `lv`: damage, rate, range and load scaled by `UPGRADE` (a lobbed round's blast with its damage). */
export function turretDef(kind: TurretKind, lv = 1): TurretDef {
  const base = BUILDINGS[kind].turret;
  const i = Math.min(Math.max(1, lv), MAX_LEVEL) - 1;
  if (i === 0) return base;
  const key = `${kind}${i}`;
  let def = defs.get(key);
  if (!def) {
    defs.set(key, def = {
      ...base, damage: base.damage * UPGRADE.damage[i]!, fireMs: base.fireMs * UPGRADE.fireMs[i]!, range: Math.round(base.range * UPGRADE.range[i]!), ammo: Math.round(base.ammo * UPGRADE.ammo[i]!),
      lobbed: base.lobbed && { ...base.lobbed, damage: base.lobbed.damage * UPGRADE.damage[i]! },
    });
  }
  return def;
}
/** A utility's work rate and reach at `lv`. */
export const auraOf = (lv: number) => UPGRADE.aura[Math.min(Math.max(1, lv), MAX_LEVEL) - 1]!;
export const reachAt = (reach: number, lv: number) => reach * UPGRADE.reach[Math.min(Math.max(1, lv), MAX_LEVEL) - 1]!;

type Pose = { x: number; y: number };

/** Everything the building rules look at. The server fills it from the world and the client from its snapshot, so the build preview judges a cell exactly as the server will. */
export type BuildSite = {
  /** The builder may build now (`buildsNow`): by day, or by night with a gun that builds by night. */
  canBuild: boolean;
  /** Null unless the builder is up. */
  builder: Pose | null;
  core: Rect;
  cover: readonly Rect[];
  /** Squad players not dead, downed included, and zombies. */
  bodies: readonly (Pose & { r: number })[];
  buildings: readonly BuildingView[];
  scrap: number;
};

export const cellRect = (cx: number, cy: number): Rect => ({ x: cx * ZOM.cell, y: cy * ZOM.cell, w: ZOM.cell, h: ZOM.cell });
export const cellOf = (x: number, y: number) => ({ cx: Math.floor(x / ZOM.cell), cy: Math.floor(y / ZOM.cell) });
export const coreRectAt = (center: Pose): Rect => ({ x: center.x - ZOM.coreHalf, y: center.y - ZOM.coreHalf, w: ZOM.coreHalf * 2, h: ZOM.coreHalf * 2 });

export function buildRefusal(site: BuildSite, kind: BuildingKind, cx: number, cy: number, lv = 1): BuildRefusal | null {
  if (!site.canBuild || !site.builder) return 'notDay';
  const at = { x: (cx + 0.5) * ZOM.cell, y: (cy + 0.5) * ZOM.cell };
  const { core } = site;
  if (dist2(at.x, at.y, core.x + core.w / 2, core.y + core.h / 2) > ZOM.buildRadius ** 2) return 'farFromCore';
  if (dist2(at.x, at.y, site.builder.x, site.builder.y) > ZOM.reachPx ** 2) return 'outOfReach';
  // Before bodies, so a building with someone pressed against it still offers to come down.
  if (site.buildings.some((b) => b.cx === cx && b.cy === cy)) return 'taken';
  const cell = cellRect(cx, cy);
  if (site.cover.some((r) => rectsOverlap(r, cell))) return 'cover';
  if (rectsOverlap(core, cell)) return 'core';
  // A spike strip lies flat, so anyone may stand on its cell.
  if (kind !== 'spikes' && site.bodies.some((b) => circleHitsRect(b.x, b.y, b.r, cell))) return 'body';
  if (site.scrap < costOf(kind, lv)) return 'scrap';
  return null;
}

export type Cell = { cx: number; cy: number };
/** Whether a kind may be dragged out in a line in build mode: walls and spike strips, cheap pieces laid in rows. A turret goes up one at a time. */
export const linesOf = (kind: BuildingKind) => (ZOM.lineKinds as readonly BuildingKind[]).includes(kind);

/**
 * The cells a drag from `a` to `b` lays: a straight line from `a` along whichever axis the drag went farther (across, on a tie), one cell for every
 * cell crossed, at most `max` of them.
 */
export function lineCells(a: Cell, b: Cell, max: number = ZOM.lineMax): Cell[] {
  const dx = b.cx - a.cx, dy = b.cy - a.cy, across = Math.abs(dx) >= Math.abs(dy);
  const n = Math.min(max, (across ? Math.abs(dx) : Math.abs(dy)) + 1), sx = across ? Math.sign(dx) : 0, sy = across ? 0 : Math.sign(dy);
  return Array.from({ length: Math.max(1, n) }, (_, i) => ({ cx: a.cx + sx * i, cy: a.cy + sy * i }));
}

/**
 * A line judged as the server builds it: cell by cell from its start, each by `buildRefusal` with the scrap the cells before it left,
 * so a cell that cannot be built is passed over and the line goes up as far as the scrap lasts.
 */
export function planLine(site: BuildSite, kind: BuildingKind, cells: readonly Cell[], lv = 1): (Cell & { refusal: BuildRefusal | null })[] {
  let scrap = site.scrap;
  return cells.map(({ cx, cy }) => {
    const refusal = buildRefusal({ ...site, scrap }, kind, cx, cy, lv);
    if (refusal === null) scrap -= costOf(kind, lv);
    return { cx, cy, refusal };
  });
}

export function upgradeRefusal(site: BuildSite, cx: number, cy: number): UpgradeRefusal | null {
  if (!site.canBuild || !site.builder) return 'notDay';
  const b = site.buildings.find((o) => o.cx === cx && o.cy === cy);
  if (!b) return 'none';
  if (dist2((cx + 0.5) * ZOM.cell, (cy + 0.5) * ZOM.cell, site.builder.x, site.builder.y) > ZOM.reachPx ** 2) return 'outOfReach';
  const cost = upgradeCost(b.kind, levelOf(b));
  if (cost === null) return 'maxed';
  return site.scrap < cost ? 'scrap' : null;
}

/** Tenths of whole, 1 to 10, where 10 means whole: anything short of whole reads 9 or less, so a rule judging tenths judges what the server holds. */
export const tenths = (v: number, max: number) => (v >= max ? 10 : Math.min(9, Math.max(1, Math.ceil((v / max) * 10))));
const loadTenths = (ammo: number, max: number) => (Math.floor(ammo) < 1 ? 0 : tenths(Math.floor(ammo), max));

export function buildingView(b: Building | FloorItem): BuildingView {
  const lv = levelOf(b);
  const at = { cx: b.cx, cy: b.cy, hp: tenths(b.hp, maxHpOf(b.kind, lv)), ...(lv > 1 && { lv }) };
  return 'ammo' in b ? { ...at, kind: b.kind, ammo: loadTenths(b.ammo, turretDef(b.kind, lv).ammo) } : { ...at, kind: b.kind };
}

/** Mending prices a building by what is invested in it, so a steel wall costs more a point than a barricade. */
export const repairScrapPerHp = (kind: BuildingKind, lv = 1) => (investedOf(kind, lv) / maxHpOf(kind, lv)) * ZOM.repairShare;
export const refundFor = (b: Pick<BuildingView, 'kind' | 'hp' | 'lv'>) => Math.floor(investedOf(b.kind, levelOf(b)) * ZOM.demolishRefund * (b.hp / 10));

export type CoreView = Pose & { hp: number; maxHp: number };
export type ServiceJob<B> = { job: 'repair' | 'reload'; on: B | 'core' };

/**
 * What holding use at `at` tends: the nearest worn building or worn core in reach, or the nearest turret short of a full load, a worn turret mended before it is reloaded.
 * The server tends by it and the client's hint names it, both from the same views.
 */
export function serviceTarget<B extends BuildingView>(at: Pose, core: CoreView, buildings: readonly B[]): ServiceJob<B> | null {
  let on: B | 'core' | null = null, bestD = ZOM.reachPx ** 2;
  const coreD = dist2(at.x, at.y, core.x, core.y);
  if (core.hp < core.maxHp && coreD <= bestD) { on = 'core'; bestD = coreD; }
  for (const b of buildings) {
    if (b.kind === 'spikes' || (b.hp >= 10 && (!('ammo' in b) || b.ammo >= 10))) continue;
    const d = dist2(at.x, at.y, (b.cx + 0.5) * ZOM.cell, (b.cy + 0.5) * ZOM.cell);
    if (d <= bestD) { on = b; bestD = d; }
  }
  return on && { on, job: on !== 'core' && on.hp >= 10 ? 'reload' : 'repair' };
}
