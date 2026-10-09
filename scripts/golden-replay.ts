/// <reference types="node" />
// Usage: node scripts/golden-replay.ts [expectedHash]
// Replays fixed-seed matches and hashes every snapshot; a behavior-preserving sim refactor must keep the hash.
import { createHash } from 'node:crypto';
import { LEVELS, pickOptions, WORLD } from '../src/shared/defs.ts';
import { MAP_NOTICE_MS, MAPS, ROTATION } from '../src/shared/maps.ts';
import { VIEW_ASPECT, type InputState } from '../src/shared/protocol.ts';
import { addPlayer, canRespawn, removePlayer, respawn, setInput, step } from '../src/shared/sim.ts';
import { snapshotFor, wallViews } from '../src/shared/sim/snapshot.ts';
import { abilityOf, choosePick, pendingPick } from '../src/shared/sim/stats.ts';
import { createWorld, rand, type Player, type World } from '../src/shared/sim/world.ts';
import { newBotMemory, randomLoadout, type BotMemory } from '../src/server/bots.ts';
import { thinkBots } from '../src/server/bot/tick.ts';

const TICKS = 4000;
const SEEDS = [7, 8];
const TICK_MS = 1000 / WORLD.tickHz;

const hash = createHash('sha256');
const seen = { kills: 0, slashes: 0, booms: 0, rewoundShots: 0, abilityUses: {} as Record<string, number>, roundsOver: 0, mapChanges: 0, picks: 0, respawns: 0 };

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
  const tap = (w.tick + phase) % 7 === 0 && dist < 800;
  return {
    up: strafe === 0 || (strafe < 4 && dist > 400 && Math.sin(angle) < -0.3),
    down: strafe === 2 || (strafe < 4 && dist > 400 && Math.sin(angle) > 0.3),
    left: strafe === 3 || (strafe < 4 && dist > 400 && Math.cos(angle) < -0.3),
    right: strafe === 1 || (strafe < 4 && dist > 400 && Math.cos(angle) > 0.3),
    angle,
    fire: dist < 600 && Math.floor(w.tick / 60) % 2 === 0,
    shots: h.input.shots + (tap ? 1 : 0),
    reload: (w.tick + phase) % 211 === 0,
    ability: (w.tick + phase) % 37 === 0,
    aimDist: Math.min(dist, 500),
    use: false,
    // Far from any enemy the scripted players sprint in bursts, so the replay covers sprint speed, the lowered gun and the post-sprint bloom.
    sprint: dist > 500 && Math.floor((w.tick + phase) / 40) % 2 === 0,
  };
}

function feed(w: World) {
  for (const id of w.players.keys()) {
    hash.update(JSON.stringify(snapshotFor(w, id)));
    hash.update(JSON.stringify(snapshotFor(w, id, w.events, VIEW_ASPECT.min)));
  }
  hash.update(JSON.stringify(wallViews(w)));
  hash.update(JSON.stringify(w.lifeRecords.splice(0)));
}

let worldIndex = 0;
for (const mode of ['FFA', 'TDM', 'DOM'] as const) {
  for (const seed of SEEDS) {
    worldIndex++;
    const w = createWorld(mode, seed, ROTATION[mode][0]);
    const r = () => rand(w);
    const bots = new Map<number, BotMemory>();
    const addBot = (name: string) => bots.set(addPlayer(w, name, randomLoadout(r)).id, newBotMemory(r));
    for (let i = 0; i < 8; i++) addBot(`bot${i}`);
    const humans = [
      addPlayer(w, 'lagged', { weapon: 'assault', armor: 'light', color: 'red' }, { kind: 'human', at: { x: MAPS[w.map].size / 2, y: MAPS[w.map].size / 2 } }),
      addPlayer(w, 'local', { weapon: 'sniper', armor: 'medium', color: 'blue' }, { kind: 'human' }),
    ];
    for (const h of humans) h.level = LEVELS.length - 1;
    let seq = 1;
    for (let tick = 0; tick < TICKS; tick++) {
      const { respawned, picked } = thinkBots(w, bots, r);
      seen.picks += picked;
      seen.respawns += respawned.length;
      humans.forEach((h, i) => {
        const lagTicks = i === 0 ? 2 + (tick % 9) : null;
        const input = humanInput(w, h, i * 17);
        if (lagTicks !== null && h.life.k === 'alive' && input.shots > h.shotsSeen) seen.rewoundShots++;
        setInput(w, h.id, seq++, input, lagTicks === null ? null : w.now - lagTicks * TICK_MS);
        const pending = pendingPick(h);
        if (pending) {
          const options = pickOptions(pending, h.gun);
          const tier = pending.k === 'perk' ? pending.tier : null;
          const pick = tier === 3 ? worldIndex * 2 + i : tier === 1 && i === 1 ? options.indexOf('ghillie') : tick + h.id;
          if (choosePick(w, h.id, pending.level, options[pick % options.length]!)) seen.picks++;
        }
        if (canRespawn(w, h.id) && respawn(w, h.id, h.loadout)) seen.respawns++;
      });
      if (tick === 1500) {
        const leaving = [...bots.keys()][3];
        removePlayer(w, leaving);
        bots.delete(leaving);
        addBot('latecomer');
      }
      if (tick === 2500 && mode === 'TDM') w.teamScore.blue = WORLD.tdmWinScore - 1;
      if (tick === 2500 && mode === 'DOM') w.teamScore.red = WORLD.domWinScore - 5;
      if (tick === 2500 && mode === 'FFA') w.mapChangeAt = w.now + MAP_NOTICE_MS;
      const readyAt = [...w.players.values()].map((p) => p.abilityReadyAt);
      const wasOver = w.match.k === 'over';
      const mapBefore = w.map;
      step(w, TICK_MS);
      [...w.players.values()].forEach((p, i) => {
        const used = abilityOf(p);
        if (used && p.abilityReadyAt !== readyAt[i]) seen.abilityUses[used] = (seen.abilityUses[used] ?? 0) + 1;
      });
      if (!wasOver && w.match.k === 'over') seen.roundsOver++;
      if (w.map !== mapBefore) seen.mapChanges++;
      for (const e of w.events) {
        if (e.e === 'kill') seen.kills++;
        else if (e.e === 'slash') seen.slashes++;
        else if (e.e === 'boom') seen.booms++;
      }
      feed(w);
    }
  }
}

const digest = hash.digest('hex');
console.log(JSON.stringify(seen));
console.log(`golden ${digest}`);
const expected = process.argv[2];
if (expected && expected !== digest) {
  console.error(`MISMATCH expected ${expected}`);
  process.exit(1);
}
