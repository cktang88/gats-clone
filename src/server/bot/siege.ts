import { BUILDING_KINDS, BUILDINGS, GUNS, WORLD, ZOM, type BuildingKind } from '../../shared/defs.ts';
import { DEFAULT_VIEW_ASPECT, viewExtents, type BuildingView, type InputState, type PlayerView, type RunView, type Snapshot } from '../../shared/protocol.ts';
import { cellOf, cellRect, coreRectAt } from '../../shared/sim/build.ts';
import { circleHitsRect, segmentEntersRectAt } from '../../shared/sim/movement.ts';
import type { BotDecision, BotMemory } from '../bots.ts';
import { aimAndTrigger, aimSigma, bearingSpin, drift, engage, freshAim, HANDS, SHARPNESS, TICK_MS, type Engagement, type Look } from './aim.ts';
import type { BotArena } from './arena.ts';
import { findPath, withSolids, type NavGrid } from './nav.ts';
import { ABILITY_RULES, HURTING_HP_FRAC, type Situation } from './motor.ts';

export const DEAD_ZONE = 30;
const UNDER_FIRE_TICKS = Math.round(500 / TICK_MS);

const nearest = <T extends { x: number; y: number }>(me: { x: number; y: number }, xs: readonly T[]): T | null =>
  xs.reduce<T | null>((best, x) => (best && Math.hypot(best.x - me.x, best.y - me.y) <= Math.hypot(x.x - me.x, x.y - me.y) ? best : x), null);

type Watch = {
  me: PlayerView;
  core: { x: number; y: number };
  post: { x: number; y: number };
  zombie: { id: number; x: number; y: number; d: number } | null;
  downed: PlayerView | null;
  needsTending: { x: number; y: number } | null;
  dry: { x: number; y: number } | null;
  coreMendable: boolean;
  next: { kind: BuildingKind; cx: number; cy: number; x: number; y: number } | null;
};

type Errand = { x: number; y: number; use: boolean };

const GUARD_RADIUS = 550;
const WHOLE_TENTHS = 10;
const DRY_TENTHS = 2;
const CORE_EMERGENCY_FRAC = 0.5;
const HUMANS_RESERVE = Math.max(...BUILDING_KINDS.map((k) => BUILDINGS[k].cost));
const POST_RADIUS = 320;
const BUSY_ZOMBIE_PX = 300;
const KITE_PX = 140;

const mendAt = (s: Watch, at: { x: number; y: number }): Errand => ({ ...at, use: Math.hypot(at.x - s.me.x, at.y - s.me.y) <= ZOM.reachPx - 60 });
const hordeFar = (s: Watch) => !s.zombie || s.zombie.d > BUSY_ZOMBIE_PX;

type Rule = (s: Watch) => Errand | null;

const revive: Rule = (s) => s.downed && { x: s.downed.x, y: s.downed.y, use: Math.hypot(s.downed.x - s.me.x, s.downed.y - s.me.y) <= ZOM.reviveRange - 15 };
const mendBuilding: Rule = (s) => s.needsTending && hordeFar(s) ? mendAt(s, s.needsTending) : null;
const refillDry: Rule = (s) => s.dry && (!s.zombie || s.zombie.d > KITE_PX) ? mendAt(s, s.dry) : null;
const mendCore: Rule = (s) => s.coreMendable && hordeFar(s) ? mendAt(s, s.core) : null;
const buildNext: Rule = (s) => s.next && { x: s.next.x, y: s.next.y, use: false };
const holdPost: Rule = (s) => {
  const post = { ...s.post, use: false };
  if (!s.zombie || s.zombie.d > KITE_PX) return post;
  const away = Math.atan2(s.me.y - s.zombie.y, s.me.x - s.zombie.x);
  const steps = [away, away + Math.PI / 2, away - Math.PI / 2].map((a) => ({ x: s.me.x + Math.cos(a) * 200, y: s.me.y + Math.sin(a) * 200, use: false }));
  return steps.find((p) => Math.hypot(p.x - s.core.x, p.y - s.core.y) <= GUARD_RADIUS) ?? post;
};

const SIEGE_RULES: readonly Rule[] = [revive, refillDry, mendBuilding, buildNext, mendCore, holdPost];

const BASTION_PLAN: readonly { kind: BuildingKind; dx: number; dy: number }[] = [
  { kind: 'sentry', dx: 0, dy: -3 }, { kind: 'sentry', dx: 3, dy: 0 }, { kind: 'scatter', dx: 0, dy: 3 }, { kind: 'sentry', dx: -3, dy: 0 },
  { kind: 'cannon', dx: 3, dy: -3 }, { kind: 'mortar', dx: -3, dy: 3 }, { kind: 'scatter', dx: 0, dy: -4 }, { kind: 'sentry', dx: 0, dy: 4 },
  { kind: 'cannon', dx: -3, dy: -3 }, { kind: 'mortar', dx: 3, dy: 3 }, { kind: 'scatter', dx: 4, dy: 0 }, { kind: 'scatter', dx: -4, dy: 0 },
];

const BUILD_STANDOFF = 2 * ZOM.cell;

function nextBuild(run: RunView, buildings: readonly BuildingView[]) {
  const fromCoreEdge = (d: number) => (d + Math.sign(d) / 2) * ZOM.cell;
  const todo = BASTION_PLAN.map((p) => ({ kind: p.kind, ...cellOf(run.core.x + fromCoreEdge(p.dx), run.core.y + fromCoreEdge(p.dy)) }))
    .find((p) => !buildings.some((b) => b.cx === p.cx && b.cy === p.cy));
  if (!todo) return null;
  const x = (todo.cx + 0.5) * ZOM.cell, y = (todo.cy + 0.5) * ZOM.cell, d = Math.hypot(x - run.core.x, y - run.core.y);
  return { ...todo, x: x - ((y - run.core.y) / d) * BUILD_STANDOFF, y: y + ((x - run.core.x) / d) * BUILD_STANDOFF, cost: BUILDINGS[todo.kind].cost };
}

const SQUAD_NAV = new WeakMap<BotArena, { key: string; nav: NavGrid }>();
const MAX_EXPANSIONS = 4000;
const NAV_SLACK = 8;

function wayTo(arena: BotArena, core: { x: number; y: number }, buildings: readonly BuildingView[], me: { x: number; y: number }, to: { x: number; y: number }) {
  const key = buildings.map((b) => `${b.cx},${b.cy}`).join(' ');
  let cached = SQUAD_NAV.get(arena);
  if (cached?.key !== key) {
    cached = { key, nav: withSolids(arena.nav, [coreRectAt(core), ...buildings.map((b) => cellRect(b.cx, b.cy))], WORLD.playerRadius - NAV_SLACK) };
    SQUAD_NAV.set(arena, cached);
  }
  const path = findPath(cached.nav, me, to, MAX_EXPANSIONS);
  return path?.find((p) => Math.abs(p.x - me.x) > DEAD_ZONE || Math.abs(p.y - me.y) > DEAD_ZONE) ?? to;
}

function postFor(core: { x: number; y: number }, bearing: number, buildings: readonly BuildingView[]): { x: number; y: number } {
  const at = (d: number) => ({ x: core.x + Math.cos(bearing) * d, y: core.y + Math.sin(bearing) * d });
  const innermost = ZOM.coreHalf + WORLD.playerRadius + 1;
  for (let d = innermost; d <= POST_RADIUS; d += 5) {
    const { x, y } = at(d);
    if (buildings.some((b) => circleHitsRect(x, y, WORLD.playerRadius, cellRect(b.cx, b.cy)))) return at(Math.max(innermost, d - 5));
  }
  return at(POST_RADIUS);
}

function swingTo(prev: Engagement | null, zombie: NonNullable<Watch['zombie']>, tick: number, rand: () => number): Engagement {
  if (prev?.id === zombie.id) return engage(prev, zombie, SHARPNESS[0]!, tick, rand);
  const fresh = engage(null, zombie, SHARPNESS[0]!, tick, rand);
  return prev ? { ...fresh, acquiredTick: prev.acquiredTick, noticeAtTick: prev.noticeAtTick } : fresh;
}

export function siegeThink(snap: Snapshot, run: RunView, me: PlayerView, arena: BotArena, mem: BotMemory, rand: () => number): Omit<BotDecision, 'pick'> {
  const walls = arena.walls;
  const sight = viewExtents(snap.self.viewRadius, DEFAULT_VIEW_ASPECT);
  const zombies = (snap.zombies ?? [])
    .map(([id, , x, y]) => ({ id, x, y, d: Math.hypot(x - me.x, y - me.y) }))
    .filter((z) => Math.abs(z.x - me.x) <= sight.halfW && Math.abs(z.y - me.y) <= sight.halfH
      && !walls.some((r) => segmentEntersRectAt(me.x, me.y, z.x - me.x, z.y - me.y, r) !== null));
  const zombie = zombies.reduce<Watch['zombie']>((best, z) => (best && best.d <= z.d ? best : z), null);
  const down = snap.players.filter((p) => p.downed && p.id !== me.id);
  const downed = nearest(me, down.filter((p) => p.kind === 'human')) ?? nearest(me, down);
  const humansBank = snap.players.some((p) => p.kind === 'human' && p.id !== me.id);
  const spare = !humansBank || run.scrap > HUMANS_RESERVE;
  const guarded = (b: BuildingView) => Math.hypot((b.cx + 0.5) * ZOM.cell - run.core.x, (b.cy + 0.5) * ZOM.cell - run.core.y) <= GUARD_RADIUS;
  const at = (b: BuildingView) => ({ x: (b.cx + 0.5) * ZOM.cell, y: (b.cy + 0.5) * ZOM.cell });
  const worn = !spare ? [] : (snap.buildings ?? [])
    .filter((b) => guarded(b) && (b.hp < WHOLE_TENTHS || (b.kind !== 'wall' && b.ammo < WHOLE_TENTHS && run.scrap > 0))).map(at);
  const dry = run.scrap > 0 ? (snap.buildings ?? []).filter((b) => guarded(b) && b.kind !== 'wall' && b.ammo <= DRY_TENTHS).map(at) : [];
  const plan = humansBank ? null : nextBuild(run, snap.buildings ?? []);
  const buildable = plan && run.phase === 'day' && run.scrap >= plan.cost ? plan : null;
  const coreInDanger = run.phase === 'night' && run.core.hp < run.core.maxHp * CORE_EMERGENCY_FRAC;
  const post = postFor(run.core, me.id, snap.buildings ?? []);
  const watch: Watch = {
    me, core: run.core, post, zombie, downed, needsTending: nearest(post, worn), dry: nearest(post, dry), next: buildable,
    coreMendable: run.core.hp < run.core.maxHp && run.scrap > 0 && (coreInDanger || (spare && run.scrap > (run.phase === 'day' ? plan?.cost ?? 0 : 0))),
  };
  const errand = SIEGE_RULES.reduce<Errand | null>((found, rule) => found ?? rule(watch), null)!;
  const builds = buildable && errand.x === buildable.x && errand.y === buildable.y && Math.hypot(buildable.x - me.x, buildable.y - me.y) <= 2 * DEAD_ZONE;

  const outFromCore = { x: 2 * me.x - run.core.x, y: 2 * me.y - run.core.y };
  const face = errand.use ? errand : outFromCore;
  const before = mem.motor.aim ?? freshAim(me.angle);
  const want = Math.hypot(face.x - me.x, face.y - me.y) > 1 ? Math.atan2(face.y - me.y, face.x - me.x) : before.want;
  let look: Look = { want, spin: 0, hand: HANDS.calm, d: 300, err: before.err };
  let wantsFire = false;
  let threat: Situation['threat'] = null;
  let engaged: Engagement | null = null;
  if (zombie) {
    engaged = swingTo(mem.motor.engaged, zombie, snap.tick, rand);
    if (snap.tick >= engaged.noticeAtTick) {
      const err = drift(before.err, aimSigma(engaged, me, SHARPNESS[0]!, snap.tick), TICK_MS, rand);
      const rx = zombie.x - me.x, ry = zombie.y - me.y;
      look = { want: Math.atan2(ry, rx) + err, spin: bearingSpin(rx, ry, engaged.vx, engaged.vy), hand: HANDS.flick, d: zombie.d, err };
      wantsFire = zombie.d < GUNS[me.gun].range * 0.95;
      threat = { d: zombie.d };
    }
  }
  const hitTick = snap.events.some((e) => e.e === 'dmg' && e.kind === 'player' && e.victim === me.id) ? snap.tick : mem.awareness.hitTick;
  const situation: Situation = { threat, hurting: me.hp < me.maxHp * HURTING_HP_FRAC, underFire: snap.tick - hitTick <= UNDER_FIRE_TICKS, onContestedZone: false };
  const readyAbility = snap.self.abilityReadyIn === 0 ? snap.self.ability : null;
  const wanted = readyAbility !== null && readyAbility !== 'engineer' && ABILITY_RULES[readyAbility](situation) ? readyAbility : null;
  const { aim, fire, ability, shots } = aimAndTrigger(before, look, wantsFire, wanted, mem.motor.shots);
  const step = wayTo(arena, run.core, snap.buildings ?? [], me, errand);
  const mx = step.x - me.x, my = step.y - me.y;
  const still = errand.use;
  const input: InputState = {
    up: !still && my < -DEAD_ZONE, down: !still && my > DEAD_ZONE, left: !still && mx < -DEAD_ZONE, right: !still && mx > DEAD_ZONE,
    angle: aim.angle, fire, shots, reload: !zombie && snap.self.ammo < snap.self.mag / 2, ability, aimDist: look.d, use: errand.use,
  };
  const next = { ...mem, awareness: { ...mem.awareness, hitTick }, motor: { ...mem.motor, engaged, aim, shots } };
  return { input, mem: next, ...(builds && { build: { kind: buildable.kind, cx: buildable.cx, cy: buildable.cy } }) };
}
