/**
 * Bots that stand frozen with a threat about: the engine of `scripts/bench-freeze.ts`, shared with its regression test.
 * A match of bots only; every tick, for each live bot, the threats it knows of (enemies it saw in the last `KNOWN_MS`, where each stands
 * now while the bot still sees him, else where it last saw him) and whether the bot faces one of them and moves. A *freeze* is a spell of
 * standing still (`STILL_PX` a tick) facing more than `FROZEN_OFF_RAD` off every one of them (and off the corner each would come round,
 * `edgeToward`); spells past `FROZEN_MS` count. Facing one, or his corner, within `FACING_RAD` counts as facing a threat.
 * It also counts how bots fight: peeks begun, time outnumbered (1vN) in a fight, deaths while outnumbered, fights begun and lost.
 */
import { WORLD, type ModeId } from '../../src/shared/defs.ts';
import type { MapId } from '../../src/shared/maps.ts';
import { addPlayer, step } from '../../src/shared/sim.ts';
import { crateRect, createWorld, isEnemy, rand, type World } from '../../src/shared/sim/world.ts';
import { newBotMemory, randomLoadout, type BotMemory } from '../../src/server/bots.ts';
import { VETERAN } from '../../src/server/bot/aim.ts';
import { thinkBots } from '../../src/server/bot/tick.ts';
import { arenaFor } from '../../src/server/bot/arena.ts';
import { edgeToward } from '../../src/server/bot/tactics.ts';
import { clearShot } from '../../src/server/bot/nav.ts';

const TICK_MS = 1000 / WORLD.tickHz;
export const KNOWN_MS = 3000;
export const STILL_PX = 0.5;
export const FROZEN_OFF_RAD = (45 * Math.PI) / 180;
export const FACING_RAD = (30 * Math.PI) / 180;
export const FROZEN_MS = 1000;

export type Freeze = { id: number; startMs: number; ms: number; intent: string; x: number; y: number };
export type FreezeResult = {
  botMs: number; threatMs: number; facingMs: number; frozenMs: number; freezes: Freeze[];
  kills: number; thinkMs: number; ticks: number;
  /** Spells of peek-and-hide past `LOOP_MS` without a round fired. */
  loops: number;
  /** Peeks begun (a peek-and-hide going from hide to peek). */
  pokes: number;
  /** Ticks a bot had an enemy with a line on it within `FIGHT_PX` (in a fight), and of those, ticks it had more such enemies than mates by it plus one (1vN). */
  fightMs: number; outnumberedMs: number;
  deaths: number; outnumberedDeaths: number;
  /** Fights begun (an `engage` intent started) and of those, the ones it died in. */
  engages: number; engagesLost: number;
};
const LOOP_MS = 8000;
/** An enemy with a line on a bot this near is in a fight with it; a mate this near backs it up. */
const FIGHT_PX = 700;
const BACKUP_PX = 450;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** `watched`: every bot thinks at the pace of one on a human's screen (as the bots a person sees do), not a third as often as one off every screen. */
export function freezeScan(mode: ModeId, map: MapId, seed: number, seconds: number, players = WORLD.minPlayers, watched = true): FreezeResult {
  const w: World = createWorld(mode, seed, map);
  const r = () => rand(w);
  const mems = new Map<number, BotMemory>();
  for (let i = 0; i < players; i++) mems.set(addPlayer(w, `bot${i}`, randomLoadout(r)).id, newBotMemory(r, { skill: VETERAN }));
  const out: FreezeResult = { botMs: 0, threatMs: 0, facingMs: 0, frozenMs: 0, freezes: [], kills: 0, thinkMs: 0, ticks: 0, loops: 0, pokes: 0, fightMs: 0, outnumberedMs: 0, deaths: 0, outnumberedDeaths: 0, engages: 0, engagesLost: 0 };
  const outnumbered = new Set<number>(), engaging = new Set<number>(), phase = new Map<number, string>();
  const spell = new Map<number, { startMs: number; intent: string; x: number; y: number }>();
  const peek = new Map<number, { since: number; fired: boolean }>();
  const close = (id: number) => {
    const s = spell.get(id);
    if (!s) return;
    spell.delete(id);
    const ms = w.now - s.startMs;
    if (ms >= FROZEN_MS) { out.frozenMs += ms; out.freezes.push({ id, ms, ...s }); }
  };
  const last = new Map<number, { x: number; y: number }>();
  for (let tick = 0; tick < (seconds * 1000) / TICK_MS; tick++) {
    const t0 = performance.now();
    thinkBots(w, mems, r, { watched });
    out.thinkMs += performance.now() - t0;
    out.ticks++;
    step(w, TICK_MS);
    const fired = new Set<number>();
    for (const e of w.events) {
      if (e.e === 'kill') {
        out.kills++;
        if (!mems.has(e.victimId)) continue;
        out.deaths++;
        if (outnumbered.has(e.victimId)) out.outnumberedDeaths++;
        if (engaging.has(e.victimId)) out.engagesLost++;
      } else if (e.e === 'shot') fired.add(e.owner);
    }
    const solids = [...arenaFor(w).sightWalls, ...w.crates.filter((c) => c.respawnAt === null).map(crateRect)];
    const alive = [...w.players.values()].filter((p) => p.life.k === 'alive');
    for (const [id, mem] of mems) {
      const p = w.players.get(id);
      const was = last.get(id);
      if (!p || p.life.k !== 'alive') { close(id); peek.delete(id); last.delete(id); outnumbered.delete(id); engaging.delete(id); phase.delete(id); continue; }
      last.set(id, { x: p.x, y: p.y });
      if (!was) continue;
      out.botMs += TICK_MS;
      const on = alive.filter((o) => isEnemy(p, o) && Math.hypot(o.x - p.x, o.y - p.y) < FIGHT_PX && clearShot(solids, p, o)).length;
      const mates = alive.filter((o) => o !== p && !isEnemy(p, o) && Math.hypot(o.x - p.x, o.y - p.y) < BACKUP_PX).length;
      outnumbered.delete(id);
      if (on > 0) {
        out.fightMs += TICK_MS;
        if (on > mates + 1) { out.outnumberedMs += TICK_MS; outnumbered.add(id); }
      }
      const now = mem.intent ? (mem.intent.k === 'peekAndHide' ? `peek:${mem.intent.phase}` : mem.intent.k) : '-';
      const before = phase.get(id);
      if (now === 'peek:peek' && before !== now) out.pokes++;
      if (now === 'engage' && before !== 'engage') { out.engages++; engaging.add(id); }
      else if (now !== 'engage') engaging.delete(id);
      phase.set(id, now);
      if (mem.intent?.k === 'peekAndHide') {
        const pk = peek.get(id) ?? { since: w.now, fired: false };
        pk.fired ||= fired.has(id);
        if (!pk.fired && w.now - pk.since > LOOP_MS) { out.loops++; pk.fired = true; }
        peek.set(id, pk);
      } else peek.delete(id);
      const known: { x: number; y: number }[] = [];
      for (const c of mem.awareness.contacts) {
        if ((w.tick - c.seenTick) * TICK_MS > KNOWN_MS) continue;
        const foe = w.players.get(c.id);
        if (!foe || foe.life.k !== 'alive' || !isEnemy(p, foe)) continue;
        const at = (w.tick - c.seenTick) * TICK_MS <= 250 ? foe : c;
        if (Math.hypot(at.x - p.x, at.y - p.y) >= 30) known.push({ x: at.x, y: at.y });
      }
      if (!known.length) { close(id); continue; }
      out.threatMs += TICK_MS;
      // Facing one of them counts, and so does facing the corner he would come round (the nearest clear lane toward him, see `edgeToward`).
      const offTo = (at: { x: number; y: number }) => Math.abs(wrap(Math.atan2(at.y - p.y, at.x - p.x) - p.angle));
      const off = Math.min(...known.map((k) => Math.min(offTo(k), offTo(edgeToward(p, k, solids) ?? k))));
      if (off <= FACING_RAD) out.facingMs += TICK_MS;
      const still = Math.hypot(p.x - was.x, p.y - was.y) < STILL_PX;
      if (still && off > FROZEN_OFF_RAD) {
        if (!spell.has(id)) {
          const i = mem.intent;
          spell.set(id, { startMs: w.now, intent: i ? (i.k === 'peekAndHide' ? `peekAndHide:${i.phase}` : i.k) : '-', x: Math.round(p.x), y: Math.round(p.y) });
        }
      } else close(id);
    }
  }
  for (const id of [...spell.keys()]) close(id);
  return out;
}
