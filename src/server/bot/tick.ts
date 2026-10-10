import { GUNS, WORLD, type GunId } from '../../shared/defs.ts';
import { BOT_VIEW_ASPECT, VIEW_ASPECT, VIEW_PRELOAD_MARGIN, viewExtents, type GameEvent, type Snapshot } from '../../shared/protocol.ts';
import { lookReach, type LookSides } from '../../shared/lookahead.ts';
import { canRespawn, respawn, setInput } from '../../shared/sim.ts';
import { flashAmount } from '../../shared/sim/abilities.ts';
import { build, upgrade } from '../../shared/sim/run.ts';
import { interestLook, snapshotFor } from '../../shared/sim/snapshot.ts';
import { abilityOf, choosePick, effectiveStats } from '../../shared/sim/stats.ts';
import { segmentBlocked, segmentEntersRectAt } from '../../shared/sim/movement.ts';
import { crateRect, IDLE_INPUT, isEnemy, type Player, type World } from '../../shared/sim/world.ts';
import { botThink, randomLoadout, type BotDecision, type BotMemory } from '../bots.ts';
import { arenaFor, type BotArena } from './arena.ts';
import { BLIND_AT, botSight, freshAwareness, inBotSight } from './awareness.ts';
import { freshMotor, motorTick, motorWake } from './motor.ts';
import { SLOW_GUN_MS } from './evade.ts';

export type BotTickOptions = {
  picks?: boolean;
  respawn?: boolean;
  /** Every bot counts as on a human's screen (a bench measuring bots as a player watching them would see them fight). */
  watched?: boolean;
  /** Called for every bot every tick. `snap` is what the bot thought on, or null on a tick its motor ran on its own (see `thinkBots`). */
  onDecision?: (id: number, snap: Snapshot | null, before: BotMemory, d: BotDecision, respawned: boolean) => void;
};

/**
 * A bot's brain runs in three tiers, as a person's does, staggered by bot id so each tick does about the same work:
 * - its motor, every tick: walking its route, turning its gun toward what it looks at by the tick's time, tracking its enemy and firing
 *   once on him, running a dodge leg (`motorTick`); cheap, and read straight off the world;
 * - a tactical think, `TACTICAL_TICKS` apart (5 a second): what it sees and hears (a snapshot, `perceive`), who it fights, whether
 *   to dodge, and the reactions (an enemy in sight, a losing fight, a dry gun, a flash);
 * - a strategic think, every `PLAN_EVERY`th tactical one (under twice a second): the plan itself, where to go and which cover, and routes.
 * Something that needs it now wakes it early: a hit or a shot fired at it by someone new, an enemy coming into its view, the enemy it
 * fights gone, a timed leg or peek ending, being stuck, arriving, the door on its way opening or shutting, a zone changing hands. A bot no
 * human can see, far from every human and on no human's team, thinks a third as often, and only news wakes it early (a hit, a shot at it,
 * its enemy gone, being stuck): its legs run on and it waits where it arrived. Its motor still runs every tick, so it never stands frozen
 * pressing stale keys or turns its gun at a third of its speed.
 * Zombies and Battle Royale squads keep thinking every tick (every third, off every screen): their brains read the run and the ring.
 */
export const TACTICAL_TICKS = 6;
export const PLAN_EVERY = 3;
export const OFFSCREEN_SLOWER = 3;
const OFFSCREEN_THINK_EVERY = 3;

/**
 * The most a human's 16:9 screen could show round him whatever way he aims: his view radius across (scope and perks counted) and the
 * screen's height, each widened by his gun's full lean (`lookReach`), with a margin. Past this from every human a bot is off every screen.
 * A plain view with an assault rifle reaches about 1140 px to either side and 830 up and down, a fully scoped sniper's about 1750 and 1320.
 */
function screenReach(h: Player): { x: number; y: number } {
  const r = effectiveStats(h).viewRadius, lean = lookReach(r, h.gun), half = viewExtents(r, BOT_VIEW_ASPECT), pad = VIEW_PRELOAD_MARGIN + WORLD.playerRadius;
  return { x: half.halfW + lean + pad, y: half.halfH + lean + pad };
}

/**
 * The snapshot a bot thinks on: the server's interest for a person with its gun, perks and aim on a 16:9 screen, the lean and all
 * (`interestLook`), so it holds everything the bot's sight box (`botSight`) can take in and nothing a person's screen would not show.
 * A Zombies squad bot fights the horde beside people, not against them, and keeps the square view it was tuned on (siege.ts reads its
 * own sight off it).
 */
export function botSnapshot(w: World, id: number, events: readonly GameEvent[] = w.events): Snapshot {
  const me = w.players.get(id);
  if (w.run) return snapshotFor(w, id, events, VIEW_ASPECT.min);
  return snapshotFor(w, id, events, BOT_VIEW_ASPECT, me ? interestLook(w, me) : undefined);
}

type Wake = 'tactical' | 'strategic' | null;

/** The last ticks' events, so a bot that thinks every few ticks still hears every shot and hit since it last thought. */
const HISTORY = new WeakMap<World, { tick: number; events: readonly GameEvent[] }[]>();
const HISTORY_TICKS = TACTICAL_TICKS * PLAN_EVERY * OFFSCREEN_SLOWER + 2;

function remember(w: World) {
  let h = HISTORY.get(w);
  if (!h) HISTORY.set(w, (h = []));
  if (h.at(-1)?.tick !== w.tick) h.push({ tick: w.tick, events: w.events });
  while (h.length > HISTORY_TICKS || (h.length > 0 && h[0]!.tick > w.tick)) h.shift();
  return h;
}

function eventsSince(h: readonly { tick: number; events: readonly GameEvent[] }[], tick: number | undefined): readonly GameEvent[] {
  const fresh = h.filter((x) => tick === undefined ? x === h.at(-1) : x.tick > tick);
  return fresh.length === 1 ? fresh[0]!.events : fresh.flatMap((x) => x.events);
}

/** A round fired at `me` this tick: its heading passes within three body widths of him, inside the gun's reach (as `perceive` judges it). */
function shotAt(e: Extract<GameEvent, { e: 'shot' }>, me: Player): boolean {
  const d = Math.hypot(e.x - me.x, e.y - me.y);
  const off = Math.atan2(me.y - e.y, me.x - e.x) - e.angle;
  return d <= GUNS[e.gun].range && Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) < Math.atan2(WORLD.playerRadius * 3, d);
}

const zonesKey = (w: World) => w.zones.map((z) => z.owner ?? '-').join();

/** Enemies standing in a bot's view box (not counting walls): a change wakes it to look properly. */
function enemiesInView(w: World, me: Player, sight: LookSides): number {
  let n = 0;
  for (const p of w.players.values()) if (p.life.k === 'alive' && isEnemy(me, p) && inBotSight(sight, me, p)) n++;
  return n;
}

/** Whether nothing that stops the eye (a wall, a standing crate) lies between a bot and an enemy, as `perceive` judges it from a snapshot. */
function inSightLine(w: World, arena: BotArena, me: Player, p: Player): boolean {
  const dx = p.x - me.x, dy = p.y - me.y;
  if (segmentBlocked(arena.sightWalls, me.x, me.y, dx, dy)) return false;
  const x0 = Math.min(me.x, p.x), x1 = Math.max(me.x, p.x), y0 = Math.min(me.y, p.y), y1 = Math.max(me.y, p.y);
  for (const c of w.crates) {
    if (c.respawnAt !== null || c.x > x1 || c.y > y1 || c.x + c.size < x0 || c.y + c.size < y0) continue;
    if (segmentEntersRectAt(me.x, me.y, dx, dy, crateRect(c)) !== null) return false;
  }
  return true;
}

const sightable = (w: World, me: Player, p: Player, sight: LookSides) =>
  p.life.k === 'alive' && w.now >= p.life.shieldUntil && isEnemy(me, p) && inBotSight(sight, me, p);

/** The enemies a bot has a line on in its view box, by id: what it last thought on (see `Beat.inSight`). */
function enemiesInSight(w: World, arena: BotArena, me: Player, sight: LookSides): number[] {
  const out: number[] = [];
  for (const p of w.players.values()) if (sightable(w, me, p, sight) && inSightLine(w, arena, me, p)) out.push(p.id);
  return out;
}

/**
 * An enemy in its view box it had no line on when it last thought has one now: he stepped out from behind a wall, came round its cover,
 * or it came round his. That is a sighting, and wakes it at once, the same tick a person would see him, rather than at its next think.
 * Only those it could not see are traced, so a bot in a fight with the enemy it already sees pays nothing for it.
 */
function newSighting(w: World, arena: BotArena, me: Player, sight: LookSides, seen: readonly number[]): boolean {
  for (const p of w.players.values()) if (!seen.includes(p.id) && sightable(w, me, p, sight) && inSightLine(w, arena, me, p)) return true;
  return false;
}

export function thinkBots(w: World, mems: Map<number, BotMemory>, rand: () => number, { picks = true, respawn: revive = true, watched = false, onDecision }: BotTickOptions = {}): { respawned: number[]; picked: number } {
  const arena = arenaFor(w);
  const respawned: number[] = [];
  let picked = 0;
  const history = remember(w);
  const humans = [...w.players.values()].filter((p) => p.kind === 'human').map((h) => ({ h, reach: screenReach(h) }));
  const onScreen = (p: Player) => watched || humans.some(({ h, reach }) => (h.team !== null && h.team === p.team) || (Math.abs(h.x - p.x) <= reach.x && Math.abs(h.y - p.y) <= reach.y));
  const tiered = w.run === null && w.royale === null;
  const hits: Extract<GameEvent, { e: 'dmg' }>[] = [], shots: Extract<GameEvent, { e: 'shot' }>[] = [];
  for (const e of w.events) {
    if (e.e === 'dmg' && e.kind === 'player') hits.push(e);
    else if (e.e === 'shot') shots.push(e);
  }
  /**
   * News that cannot wait for the next think: hit, or shot at, by someone other than the enemy it is already fighting (who it is already
   * reacting to, round by round), or by a slow gun's round (a bolt it reads to dodge the next one, see `boltCue`).
   */
  const news = (p: Player, mem: BotMemory) => {
    const fighting = mem.motor.hold?.track?.id ?? null;
    const fresh = (owner: number | null, gun: GunId | null) => owner !== fighting || (gun !== null && GUNS[gun].fireMs >= SLOW_GUN_MS);
    return hits.some((e) => e.victim === p.id && fresh(e.attacker, e.attacker === null ? null : w.players.get(e.attacker)?.gun ?? null))
      || shots.some((e) => e.owner !== p.id && fresh(e.owner, e.gun) && isEnemy(p, w.players.get(e.owner) ?? p) && shotAt(e, p));
  };
  const zones = zonesKey(w);
  const doorOpen = (i: number) => (w.doors[i]?.open ?? 0) > 0;
  const find = (id: number) => { const p = w.players.get(id); return p && p.life.k === 'alive' ? p : null; };
  /** The enemy it was fighting is gone (dead, or left): it looks round for the next. */
  const lost = (mem: BotMemory) => { const id = mem.motor.hold?.track?.id; return id !== undefined && find(id) === null; };
  /** A planted gun's round has just left: it moves off its spot (see `Hold.wakeOnFire`). */
  const fired = (id: number, mem: BotMemory) => !!mem.motor.hold?.wakeOnFire && shots.some((e) => e.owner === id);

  for (const [id, mem] of mems) {
    const p = w.players.get(id);
    const finish = (d: BotDecision, snap: Snapshot | null) => {
      mems.set(id, d.mem);
      setInput(w, id, w.tick, d.input);
      if (d.build) build(w, id, d.build.kind, d.build.cx, d.build.cy, d.build.lv);
      if (d.upgrade) upgrade(w, id, d.upgrade.cx, d.upgrade.cy);
      if (picks && d.pick && choosePick(w, id, d.pick.level, d.pick.option)) picked++;
      const back = revive && canRespawn(w, id) && respawn(w, id, randomLoadout(rand));
      if (back) respawned.push(id);
      onDecision?.(id, snap, mem, d, back);
    };
    const think = (tier: Wake) => {
      const snap = botSnapshot(w, id, eventsSince(history, mem.beat?.thought));
      const strategic = tier === 'strategic';
      const d = botThink(snap, arena, mem, rand, tiered ? { strategic, lastPlan: mem.beat?.planned } : {});
      if (tiered && p) {
        const view = snap.self.viewRadius, sight = botSight(view, p.gun, p.angle);
        const blinded = Math.round(flashAmount(p, w.now) * 100) / 100 > BLIND_AT;
        d.mem = { ...d.mem, beat: { thought: w.tick, planned: strategic ? w.tick : mem.beat?.planned ?? w.tick, seen: enemiesInView(w, p, sight), inSight: blinded ? [] : enemiesInSight(w, arena, p, sight), zones, view } };
      }
      finish(d, snap);
    };
    if (!p || !tiered) {
      // Zombies and royale: the old cadence, every tick on screen and every third off it; a skipped bot keeps pressing what it chose.
      if (!p || onScreen(p) || (w.tick + id) % OFFSCREEN_THINK_EVERY === 0) think(null);
      continue;
    }
    if (p.life.k !== 'alive') {
      // Dead: nothing to see or plan. It forgets the life it had, once, and waits to respawn.
      const forgotten = mem.intent ? { ...mem, intent: null, awareness: freshAwareness(), motor: { ...freshMotor(), shots: mem.motor.shots } } : mem;
      finish({ input: { ...IDLE_INPUT, shots: mem.motor.shots }, pick: null, mem: forgotten }, null);
      continue;
    }
    const slow = onScreen(p) ? 1 : OFFSCREEN_SLOWER;
    const phase = (w.tick + id) % (TACTICAL_TICKS * PLAN_EVERY * slow);
    let wake: Wake = !mem.beat || !mem.intent ? 'strategic' : phase === 0 ? 'strategic' : phase % (TACTICAL_TICKS * slow) === 0 ? 'tactical' : null;
    let beat = mem.beat;
    if (wake !== 'strategic' && beat) {
      // As the snapshot rounds it, so the think it wakes sees the same flash.
      const blind = Math.round(flashAmount(p, w.now) * 100) / 100 > BLIND_AT;
      const now = motorWake(mem.motor, p, w.tick, arena, doorOpen, slow === 1);
      // Its sight box follows its gun as it turns between thinks: an enemy it turns onto is news, as one walking into its view is.
      const sight = botSight(beat.view, p.gun, p.angle);
      const inView = slow === 1 ? enemiesInView(w, p, sight) : beat.seen;
      if (now === 'strategic' || zones !== beat.zones || (mem.intent?.k === 'blinded' && !blind)) wake = 'strategic';
      else if (now || blind !== (mem.intent?.k === 'blinded') || lost(mem) || (slow === 1 && (fired(id, mem) || inView > beat.seen || (!blind && newSighting(w, arena, p, sight, beat.inSight ?? [])))) || news(p, mem)) wake ??= 'tactical';
      // One leaving its view (or falling) lowers the count, so the next to come into it is news too, not only one past the count it last thought on.
      if (inView < beat.seen) beat = { ...beat, seen: inView };
    }
    if (wake) { think(wake); continue; }
    const ability = abilityOf(p);
    const { input, motor } = motorTick(mem.motor, {
      me: p, ammo: p.life.ammo, reloading: p.life.reloadUntil !== null, abilityReady: ability !== null && p.abilityReadyAt <= w.now, flash: flashAmount(p, w.now), settleLeftMs: p.life.settleLeft, find,
    }, arena, w.tick, rand);
    finish({ input, pick: null, mem: { ...mem, beat, motor } }, null);
  }
  return { respawned, picked };
}
