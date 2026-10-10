/** A bot caught in cover by a human who comes round it: the engine of `scripts/bench-flank.ts`, shared with its regression test. */
import { GUNS, WORLD, type GunId, type WeaponId } from '../../src/shared/defs.ts';
import { MAPS, type MapId } from '../../src/shared/maps.ts';
import { DEFAULT_VIEW_ASPECT, viewExtents } from '../../src/shared/protocol.ts';
import { addPlayer, setInput, step } from '../../src/shared/sim.ts';
import { effectiveStats } from '../../src/shared/sim/stats.ts';
import { crateRect, createWorld, IDLE_INPUT, rand, type Player, type Wall, type World } from '../../src/shared/sim/world.ts';
import { arenaFor } from '../../src/server/bot/arena.ts';
import { clearShot, dist, findPath, isOpen, type Point } from '../../src/server/bot/nav.ts';
import { segmentBlocked } from '../../src/shared/sim/movement.ts';
import { lookReach } from '../../src/shared/lookahead.ts';
import { boundLean, visibleHalf } from '../../src/client/camera.ts';
import { newBotMemory, type BotMemory } from '../../src/server/bots.ts';
import { VETERAN } from '../../src/server/bot/aim.ts';
import { startIntent, type PersonalityId } from '../../src/server/bot/intent.ts';
import { thinkBots } from '../../src/server/bot/tick.ts';

const TICK_MS = 1000 / WORLD.tickHz;
const WINDOW_MS = 6000;

export type Scenario = 'prior' | 'cover' | 'side' | 'behind';
export type FlankResult = { face: number | null; fire: number | null; move: number | null; hitsOn: number; hitsBy: number; hid: boolean; still?: number };

const wall = (x: number, y: number, w: number, h: number): Wall => ({ x, y, w, h, expiresAt: Infinity } as Wall);

function world(seed: number, walls: Wall[]): World {
  const w = createWorld('FFA', seed * 7919 + 17, 'plaza');
  w.walls = walls; w.crates = []; w.barrels = []; w.props = []; w.airdrops = { due: [], flight: null };
  w.wallsVersion++;
  return w;
}

const join = (w: World, gun: GunId, x: number, y: number, kind: 'bot' | 'human'): Player => {
  const p = addPlayer(w, `${kind}${w.nextId}`, { weapon: GUNS[gun].base, armor: 'none', color: 'red' }, { at: { x, y }, kind });
  p.gun = gun;
  if (p.life.k === 'alive') Object.assign(p.life, { ammo: effectiveStats(p).mag, shieldUntil: -Infinity });
  return p;
};

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/**
 * Whether the human has a line on the bot: in the view a person on a 16:9 screen has while aiming at it (his view radius, his camera leaned
 * toward it by the aim look-ahead and held by `boundLean`, as the client does) and with no wall between them.
 */
const sees = (w: World, a: Player, b: Player) => {
  const R = effectiveStats(a).viewRadius, half = visibleHalf(1600, 900, R);
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, reach = lookReach(R, a.gun);
  const lean = boundLean({ x: (dx / d) * reach, y: (dy / d) * reach }, half);
  return Math.abs(dx - lean.x) <= half.halfW && Math.abs(dy - lean.y) <= half.halfH && !segmentBlocked(w.walls.filter((x) => !x.ns), a.x, a.y, dx, dy);
};

/** Keys toward `to` for the human (8 ways, as a keyboard). */
const keysTo = (p: Player, to: { x: number; y: number }) => {
  const dx = to.x - p.x, dy = to.y - p.y, d = Math.hypot(dx, dy);
  if (d < 8) return { up: false, down: false, left: false, right: false };
  return { up: dy / d < -0.38, down: dy / d > 0.38, left: dx / d < -0.38, right: dx / d > 0.38 };
};

/** The cover in `cover`: a slab 30 wide and 200 tall, a box 120 across, or a real map's (`mapSetup`). The bot holds its east face. */
export type Shape = 'slab' | 'box' | MapId;

/**
 * A real map's cover for `cover`: a cover point the bot hides at, a spot `R` px off in a bearing its cover shields (where the human stands
 * at first, out of its sight), and one 90-130 degrees round from there with a line on it (where he walks to, by the map's own ways).
 */
function mapSetup(map: MapId, seed: number): { spot: Point; from: Point; to: Point } | null {
  const w = createWorld('FFA', 1, map);
  const arena = arenaFor(w);
  const solids = [...arena.sightWalls, ...w.crates.map(crateRect)];
  const pts = arena.cover.cells.flat();
  let h = seed * 2654435761 >>> 0;
  const next = () => (h = (Math.imul(h ^ (h >>> 15), 2246822519) + 0x9e3779b9) >>> 0) / 2 ** 32;
  const R = 400;
  const sight = viewExtents(WORLD.viewRadius, DEFAULT_VIEW_ASPECT);
  for (let tries = 0; tries < 4000; tries++) {
    const c = pts[Math.floor(next() * pts.length)]!;
    if (!isOpen(arena.nav, c)) continue;
    const k = Math.floor(next() * 16);
    if (!(c.shieldedBearings & (1 << k))) continue;
    const a = (2 * Math.PI * k) / 16;
    const from = { x: c.x + Math.cos(a) * R, y: c.y + Math.sin(a) * R };
    if (!isOpen(arena.nav, from) || clearShot(solids, c, from)) continue;
    const side = next() < 0.5 ? 1 : -1;
    for (const deg of [100, 115, 130, 90]) {
      const b = a + side * (deg * Math.PI) / 180;
      const to = { x: c.x + Math.cos(b) * R, y: c.y + Math.sin(b) * R };
      if (Math.abs(to.x - c.x) > sight.halfW - 40 || Math.abs(to.y - c.y) > sight.halfH - 40) continue;
      if (!isOpen(arena.nav, to) || !clearShot(solids, c, to)) continue;
      const path = findPath(arena.nav, from, to);
      if (!path || path.reduce((s, p, i) => s + dist(p, i ? path[i - 1]! : from), 0) > R * 3) continue;
      return { spot: { x: c.x, y: c.y }, from, to };
    }
  }
  return null;
}

/**
 * One run (see the scenarios in `scripts/bench-flank.ts`): `side` is which way round the human goes, `shape` the cover (on the plaza, or a map's).
 * With FLANK_TRACE set it prints the bot's state each tick of the first 3 s after the human's first line.
 */
export function flank(scenario: Scenario, gun: WeaponId, persona: PersonalityId, seed: number, side: 1 | -1 = seed % 2 ? 1 : -1, humanGun: GunId = 'assault', shape: Shape = 'slab'): FlankResult {
  const onMap = shape !== 'slab' && shape !== 'box';
  const setup = onMap ? mapSetup(shape, seed * 2 + (side > 0 ? 1 : 0)) : null;
  if (onMap && !setup) return { face: null, fire: null, move: null, hitsOn: 0, hitsBy: 0, hid: false };
  const mid = MAPS.plaza.size / 2;
  const cover = shape === 'box' ? wall(mid - 90, mid - 60, 120, 120) : wall(mid, mid - 100, 30, 200);
  const spot = setup?.spot ?? { x: mid + 30 + WORLD.playerRadius + 8, y: mid };
  const facing = 0; // east, away from the wall, in the unseen scenarios
  const off = scenario === "side" ? Math.PI / 2 : (125 * Math.PI) / 180;
  const R = 380;
  const reveal = facing + side * off;
  // A blind the human starts behind for the unseen scenarios: across his line to the bot, 120 px short of him.
  const blindAt = { x: spot.x + Math.cos(reveal) * (R - 70), y: spot.y + Math.sin(reveal) * (R - 70) };
  const blind = scenario === 'prior' ? null : wall(blindAt.x - 50, blindAt.y - 50, 100, 100);
  const w = onMap ? createWorld('FFA', seed * 7919 + 17, shape) : world(seed, blind ? [cover, blind] : [cover]);
  if (onMap) { w.barrels = []; w.props = []; w.airdrops = { due: [], flight: null }; }
  const r = () => rand(w);
  // In `prior` the bot starts out in the open south-east of the wall and the human stands west; it hides behind the wall when it does.
  const bot = scenario === 'prior' ? join(w, gun, mid + 70, mid + 190, 'bot') : join(w, gun, spot.x, spot.y, 'bot');
  const humanStart = setup ? setup.from : scenario === 'prior' || scenario === 'cover' ? { x: mid - 420, y: mid } : (() => {
    // Out of the bot's sight behind the blind, stepped off his line to the bot by a body or two so stepping out is a short walk.
    const a = reveal, d = R + 40;
    return { x: spot.x + Math.cos(a) * d, y: spot.y + Math.sin(a) * d };
  })();
  const human = join(w, humanGun, humanStart.x, humanStart.y, 'human');
  const mem: BotMemory = { ...newBotMemory(r, { skill: VETERAN }), persona };
  const mems = new Map<number, BotMemory>([[bot.id, mem]]);
  // Unseen: the bot holds the wall's east face looking east until the human first has a line on it (its plan pinned there till then, as a
  // minimap blip would otherwise send it off to look).
  const holdSpot = () => {
    if (scenario === 'prior') return;
    const m = mems.get(bot.id)!;
    if (scenario === 'cover') {
      const out = Math.atan2(humanStart.y - spot.y, humanStart.x - spot.x) + Math.PI / 2;
      const plan = { k: 'peekAndHide' as const, target: human.id, spot, peek: { x: spot.x + Math.cos(out) * 65, y: spot.y + Math.sin(out) * 65 }, phase: 'hide' as const, phaseUntil: w.tick + 20 };
      mems.set(bot.id, { ...m, intent: m.intent?.k === 'peekAndHide' ? { ...m.intent, ...plan } : startIntent(plan, { tick: w.tick, persona: { commitMul: 1 } as never } as never) });
      return;
    }
    mems.set(bot.id, { ...m, intent: startIntent({ k: 'takePosition', spot, facing: { x: spot.x + 600, y: spot.y } }, { tick: w.tick, persona: { commitMul: 1 } as never } as never) });
  };
  if (scenario === 'side' || scenario === 'behind') bot.angle = facing;
  if (scenario === 'cover') {
    // It saw him a moment ago, behind its cover, and faces where he was.
    bot.angle = Math.atan2(humanStart.y - spot.y, humanStart.x - spot.x);
    mems.set(bot.id, { ...mem, awareness: { ...mem.awareness, contacts: [{ id: human.id, x: human.x, y: human.y, seenTick: w.tick - 5, gun: human.gun }] } });
  }
  let shots = 0;
  const humanTick = (to: { x: number; y: number } | null, fire: boolean) => {
    const los = sees(w, human, bot) && human.life.k === 'alive';
    const shoot = fire && los && Math.hypot(bot.x - human.x, bot.y - human.y) < GUNS[human.gun].range * 0.9;
    if (shoot) shots++;
    setInput(w, human.id, w.tick + 1, { ...IDLE_INPUT, ...(to ? keysTo(human, to) : {}), angle: Math.atan2(bot.y - human.y, bot.x - human.x), fire: shoot, shots, aimDist: 400 });
  };
  const tick = () => {
    thinkBots(w, mems, r, { picks: false, respawn: false });
    step(w, TICK_MS);
    for (const p of [bot, human]) if (p.life.k === 'alive') Object.assign(p.life, { hp: effectiveStats(p).maxHp, ammo: p === human ? effectiveStats(p).mag : p.life.ammo });
  };

  let hid = true;
  if (scenario === 'prior') {
    // The human fights from the west until the bot has been out of his sight for half a second (12 s at most).
    let hidden = 0;
    hid = false;
    for (let t = 0; t < 12_000 / TICK_MS; t++) {
      humanTick(null, true);
      tick();
      // Hidden from him and settled in cover: out of his sight, behind cover by its plan, and standing still.
      const k = mems.get(bot.id)!.intent?.k;
      const covered = k === 'peekAndHide' || k === 'reloadInCover' || k === 'retreatAndHeal' || k === 'takePosition';
      const still = !(bot.input.up || bot.input.down || bot.input.left || bot.input.right);
      hidden = sees(w, human, bot) || !covered || !still ? 0 : hidden + 1;
      if (hidden * TICK_MS >= 400 && w.now > 1500) { hid = true; break; }
    }
    if (!hid) return { face: null, fire: null, move: null, hitsOn: 0, hitsBy: 0, hid };
  }

  // The walk: round the bot (about where it hides now) by 100 degrees in `prior`, or out from behind the blind sideways.
  const centre = { x: bot.x, y: bot.y };
  const a0 = Math.atan2(human.y - centre.y, human.x - centre.x);
  const R0 = Math.hypot(human.x - centre.x, human.y - centre.y);
  const arcEnd = a0 + side * (100 * Math.PI) / 180;
  const stepOut = scenario === 'prior' || scenario === 'cover' ? null : (() => {
    // Round toward the bot's front, out of the shadow of the wall at its back.
    const a = Math.atan2(human.y - centre.y, human.x - centre.x) - side * Math.PI / 2;
    return { x: human.x + Math.cos(a) * 320, y: human.y + Math.sin(a) * 320 };
  })();
  const route = setup ? findPath(arenaFor(w).nav, human, setup.to) ?? [setup.to] : null;
  const nextPoint = () => {
    // On a map he walks its ways round to his flanking spot, and stands there.
    if (route) {
      while (route.length > 1 && dist(human, route[0]!) < 16) route.shift();
      return dist(human, route[0]!) < 8 ? null : route[0]!;
    }
    // Stepping out from behind the blind he stops once he has a line on the bot, and steps on if he loses it.
    if (stepOut) return sees(w, human, bot) ? null : stepOut;
    const a = Math.atan2(human.y - centre.y, human.x - centre.x);
    const left = wrap(arcEnd - a) * side;
    if (left <= 0.02) return null;
    const na = a + side * Math.min(left, 0.35);
    return { x: centre.x + Math.cos(na) * R0, y: centre.y + Math.sin(na) * R0 };
  };

  let t0: number | null = null, face: number | null = null, fire: number | null = null, move: number | null = null, hitsOn = 0, hitsBy = 0;
  let at0 = { x: bot.x, y: bot.y }, still = 0, ticks2s = 0;
  for (let t = 0; t < 12_000 / TICK_MS; t++) {
    humanTick(nextPoint(), true);
    if (t0 === null) holdSpot();
    tick();
    if (t0 === null && sees(w, human, bot)) { t0 = w.now; at0 = { x: bot.x, y: bot.y }; }
    if (t0 === null) continue;
    const ms = w.now - t0;
    if (ms > WINDOW_MS) break;
    if (face === null && Math.abs(wrap(bot.angle - Math.atan2(human.y - bot.y, human.x - bot.x))) < (12 * Math.PI) / 180) face = ms;
    if (fire === null && w.events.some((e) => e.e === 'shot' && e.owner === bot.id)) fire = ms;
    if (move === null && Math.hypot(bot.x - at0.x, bot.y - at0.y) > 40) move = ms;
    if (process.env.FLANK_TRACE && ms <= 3000) {
      const m = mems.get(bot.id)!, it = m.intent;
      console.log(`  ${ms.toFixed(0).padStart(5)} ${it?.k}${it?.k === 'peekAndHide' ? ':' + it.phase : ''} off ${(wrap(bot.angle - Math.atan2(human.y - bot.y, human.x - bot.x)) * 180 / Math.PI).toFixed(0).padStart(4)} at ${bot.x.toFixed(0)},${bot.y.toFixed(0)} d ${Math.hypot(human.x - bot.x, human.y - bot.y).toFixed(0)} track ${m.motor.hold?.track?.id ?? '-'} eng ${m.motor.engaged?.id ?? '-'}@${m.motor.engaged ? m.motor.engaged.noticeAtTick - w.tick : ''} thought ${m.beat?.thought === w.tick - 1 ? 'Y' : ' '} fire ${bot.input.fire ? 'F' : ' '} ammo ${bot.life.k === 'alive' ? bot.life.ammo : 0} keys ${['up','down','left','right'].filter((k) => (bot.input as never)[k]).join('')}`);
    }
    if (ms <= 2000) { ticks2s++; if (!(bot.input.up || bot.input.down || bot.input.left || bot.input.right)) still++; }
    if (ms <= 2000) for (const e of w.events) if (e.e === 'dmg' && e.kind === 'player') {
      if (e.attacker === human.id && e.victim === bot.id) hitsOn++;
      if (e.attacker === bot.id && e.victim === human.id) hitsBy++;
    }
  }
  return { face, fire, move, hitsOn, hitsBy, hid, still: ticks2s ? still / ticks2s : 0 };
}
