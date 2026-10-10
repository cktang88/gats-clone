/// <reference types="node" />
// Usage: node scripts/bench-tick.ts [mode=FFA] [maps=airbase,wasteland,embassy] [humans=1] [players=18] [seconds=120] [seed=1]
// Times a full room's server tick the way room.ts runs it, split into bot think, step, snapshot build and encode, and prints snapshot bytes per human per second.
import { WORLD, type ModeId } from '../src/shared/defs.ts';
import { MAPS, type MapId } from '../src/shared/maps.ts';
import { DEFAULT_VIEW_ASPECT, type InputState } from '../src/shared/protocol.ts';
import { holdLook, NO_LOOK, type LookSides } from '../src/shared/lookahead.ts';
import { addPlayer, canRespawn, respawn, setInput, step } from '../src/shared/sim.ts';
import { interestLook, snapshotFor } from '../src/shared/sim/snapshot.ts';
import { pendingPick, choosePick } from '../src/shared/sim/stats.ts';
import { pickOptions } from '../src/shared/defs.ts';
import { createWorld, rand, type Player, type World } from '../src/shared/sim/world.ts';
import { makeSnapshotEncoder } from '../src/shared/wire.ts';
import { newBotMemory, randomLoadout, type BotMemory } from '../src/server/bots.ts';
import { thinkBots } from '../src/server/bot/tick.ts';
import { median, quantile } from './lib/stats.ts';

const mode = (process.argv[2] ?? 'FFA') as ModeId;
const maps = (process.argv[3] ?? 'airbase,wasteland,embassy').split(',') as MapId[];
const humanCount = Number(process.argv[4] ?? 1);
const playerCount = Number(process.argv[5] ?? WORLD.minPlayers);
const seconds = Number(process.argv[6] ?? 120);
const seed = Number(process.argv[7] ?? 1);
const TICK_MS = 1000 / WORLD.tickHz;
const WARMUP = 300;

function nearestEnemy(w: World, me: Player): Player | null {
  let best: Player | null = null, bestD = Infinity;
  for (const p of w.players.values()) {
    if (p.id === me.id || p.life.k !== 'alive' || (me.team !== null && p.team === me.team)) continue;
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    if (d < bestD) { best = p; bestD = d; }
  }
  return best;
}

function humanInput(w: World, h: Player, phase: number): InputState {
  const target = nearestEnemy(w, h);
  const angle = target ? Math.atan2(target.y - h.y, target.x - h.x) : (w.tick / 40) % (Math.PI * 2);
  const dist = target ? Math.hypot(target.x - h.x, target.y - h.y) : 0;
  const strafe = Math.floor((w.tick + phase) / 45) % 5;
  return {
    up: strafe === 0 || (strafe < 4 && dist > 400 && Math.sin(angle) < -0.3),
    down: strafe === 2 || (strafe < 4 && dist > 400 && Math.sin(angle) > 0.3),
    left: strafe === 3 || (strafe < 4 && dist > 400 && Math.cos(angle) < -0.3),
    right: strafe === 1 || (strafe < 4 && dist > 400 && Math.cos(angle) > 0.3),
    angle, fire: dist < 600 && Math.floor(w.tick / 60) % 2 === 0, shots: h.input.shots + ((w.tick + phase) % 7 === 0 && dist < 800 ? 1 : 0),
    reload: (w.tick + phase) % 211 === 0, ability: (w.tick + phase) % 37 === 0, aimDist: Math.min(dist, 500), use: false,
    sprint: dist > 500 && Math.floor((w.tick + phase) / 40) % 2 === 0,
  };
}

type Phase = 'bots' | 'step' | 'snap' | 'encode';
const fmt = (n: number) => n.toFixed(3);
const all: Record<Phase | 'tick', number[]> = { bots: [], step: [], snap: [], encode: [], tick: [] };
let bytes = 0, sent = 0;
for (const map of maps) {
  const w = createWorld(mode, seed, map);
  const r = () => rand(w);
  const bots = new Map<number, BotMemory>();
  const humans: { p: Player; look: LookSides | null; lookAt: number; encode: ReturnType<typeof makeSnapshotEncoder> }[] = [];
  for (let i = 0; i < humanCount; i++) {
    const p = addPlayer(w, `human${i}`, { weapon: i % 2 ? 'sniper' : 'assault', armor: 'medium', color: 'blue' }, { kind: 'human' });
    humans.push({ p, look: null, lookAt: w.now, encode: makeSnapshotEncoder() });
  }
  for (let i = humanCount; i < playerCount; i++) bots.set(addPlayer(w, `bot${i}`, randomLoadout(r)).id, newBotMemory(r));
  const ticks = Math.round((seconds * 1000) / TICK_MS);
  const per: Record<Phase | 'tick', number[]> = { bots: [], step: [], snap: [], encode: [], tick: [] };
  let mapBytes = 0;
  for (let tick = 0; tick < WARMUP + ticks; tick++) {
    humans.forEach((h, i) => {
      setInput(w, h.p.id, tick + 1, humanInput(w, h.p, i * 17), null);
      const pending = pendingPick(h.p);
      if (pending) choosePick(w, h.p.id, pending.level, pickOptions(pending, h.p.gun)[tick % 2]!);
      if (canRespawn(w, h.p.id)) respawn(w, h.p.id, h.p.loadout);
    });
    const t0 = performance.now();
    thinkBots(w, bots, r);
    const t1 = performance.now();
    step(w, TICK_MS);
    const t2 = performance.now();
    let snapMs = 0, encMs = 0;
    for (const h of humans) {
      const s0 = performance.now();
      const me = w.players.get(h.p.id)!;
      h.look = holdLook(h.look, me ? interestLook(w, me) : NO_LOOK, w.now - h.lookAt);
      h.lookAt = w.now;
      const snap = snapshotFor(w, h.p.id, w.events, DEFAULT_VIEW_ASPECT, h.look);
      const s1 = performance.now();
      const data = h.encode(snap);
      encMs += performance.now() - s1;
      snapMs += s1 - s0;
      if (tick >= WARMUP) { mapBytes += data.length; sent++; }
    }
    if (tick < WARMUP) continue;
    per.bots.push(t1 - t0); per.step.push(t2 - t1); per.snap.push(snapMs); per.encode.push(encMs); per.tick.push(t2 - t0 + snapMs + encMs);
  }
  bytes += mapBytes;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(`${map} ${MAPS[map].size}px ${mode} ${humanCount}h/${playerCount}p: tick avg ${fmt(avg(per.tick))} ms p50 ${fmt(median(per.tick))} p99 ${fmt(quantile(per.tick, 0.99))} max ${fmt(Math.max(...per.tick))} | bots ${fmt(avg(per.bots))} step ${fmt(avg(per.step))} snap ${fmt(avg(per.snap))} encode ${fmt(avg(per.encode))} | ${Math.round(mapBytes / humanCount / seconds)} B/s per human`);
  for (const k of Object.keys(all) as (keyof typeof all)[]) all[k].push(...per[k]);
}
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const tickAvg = avg(all.tick);
console.log(`ALL: tick avg ${fmt(tickAvg)} ms (${((tickAvg * WORLD.tickHz) / 10).toFixed(1)}% of a core) p50 ${fmt(median(all.tick))} p99 ${fmt(quantile(all.tick, 0.99))} | bots ${fmt(avg(all.bots))} step ${fmt(avg(all.step))} snap ${fmt(avg(all.snap))} encode ${fmt(avg(all.encode))} | ${Math.round(bytes / sent)} B/snapshot, ${Math.round((bytes / sent) * WORLD.tickHz)} B/s per human`);
