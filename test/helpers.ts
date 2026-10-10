import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { EVOLUTIONS, LEVELS, MEDALS, PERK_TIERS, TIER2_OFFER, type GunId, type ModeId, type PerkId, type PlayerKind } from '../src/shared/defs.ts';
import { ROTATION } from '../src/shared/maps.ts';
import type { ClientMsg, GameEvent, InputState, Loadout, ServerMsg, Team } from '../src/shared/protocol.ts';
import { addPlayer, setInput, step } from '../src/shared/sim.ts';
import type { Rect } from '../src/shared/sim/movement.ts';
import { choosePick, effectiveStats, pendingPick } from '../src/shared/sim/stats.ts';
import { createWorld, IDLE_INPUT, type Player, type World } from '../src/shared/sim/world.ts';

export const TICK_MS = 1000 / 30;
export const PISTOL: Loadout = { weapon: 'pistol', armor: 'none', color: 'red' };

/** What the medals among `events` paid player `id` (before any catch-up multiplier). */
export const medalPay = (events: readonly GameEvent[], id: number): number =>
  events.reduce((sum, e) => sum + (e.e === 'medal' && e.id === id ? MEDALS[e.medal].score : 0), 0);

export function emptyWorld(mode: ModeId = 'FFA'): World {
  const w = createWorld(mode, 1, ROTATION[mode][0]);
  w.walls = [];
  w.crates = [];
  w.barrels = [];
  w.props = [];
  w.packs = [];
  w.airdrops = { due: [], flight: null };
  return w;
}

/** A body placed for a test, its spawn shield already spent unless `shielded`. */
export function spawnAt(w: World, x: number, y: number, opts: { loadout?: Partial<Loadout>; team?: Team; name?: string; kind?: PlayerKind; shielded?: true } = {}): Player {
  const p = addPlayer(w, opts.name ?? `p${w.nextId}`, { ...PISTOL, ...opts.loadout }, { at: { x, y }, team: opts.team, kind: opts.kind });
  if (!opts.shielded && p.life.k === 'alive') p.life.shieldUntil = -Infinity;
  return p;
}

let seq = 1;
export function press(w: World, p: Player, input: Partial<InputState>) {
  setInput(w, p.id, seq++, { ...IDLE_INPUT, angle: p.input.angle, shots: p.input.shots, ...input });
}

export function run(w: World, ms: number) {
  for (let t = 0; t < ms; t += TICK_MS) step(w, TICK_MS);
}

export function shootOnce(w: World, p: Player, angle: number, ms = 500) {
  press(w, p, { angle, fire: true, shots: p.input.shots + 1 });
  step(w, TICK_MS);
  press(w, p, { angle });
  run(w, ms);
}

/** Picks each perk in ladder order, taking the first evolution whenever one is in the way, then hands back the class gun so its shots still deal class damage. */
export function grantPerks(w: World, p: Player, perks: PerkId[]) {
  p.level = LEVELS.length - 1;
  for (const perk of perks) {
    for (let pending = pendingPick(p); pending?.k === 'evolve'; pending = pendingPick(p)) {
      const next = EVOLUTIONS[p.gun][0];
      if (!next || !choosePick(w, p.id, pending.level, next)) throw new Error(`could not evolve ${p.gun}`);
    }
    // A tier-2 pick offers only a few of its perks; the test names the one it wants, so make sure it is on offer.
    if (PERK_TIERS[2].some((t) => t === perk) && !p.tier2Offer.includes(perk)) p.tier2Offer = [...p.tier2Offer.slice(0, TIER2_OFFER - 1), perk];
    const pending = pendingPick(p);
    if (!pending || !choosePick(w, p.id, pending.level, perk)) throw new Error(`could not choose ${perk}`);
  }
  p.gun = p.loadout.weapon;
  if (p.life.k === 'alive') p.life.ammo = Math.min(p.life.ammo, effectiveStats(p).mag);
}

/** Puts the named tier-2 perks on `p`'s offer (the draw is random per life), so a test can choose them. */
export function offerPerks(p: Player, ...perks: PerkId[]) {
  p.tier2Offer = [...perks, ...p.tier2Offer.filter((o) => !perks.includes(o))].slice(0, Math.max(TIER2_OFFER, perks.length));
}

/** Hands `p` an evolved gun with a full magazine, skipping the score it would take to evolve into it. */
export function equip(p: Player, gun: GunId) {
  p.gun = gun;
  if (p.life.k === 'alive') p.life.ammo = effectiveStats(p).mag;
}

export function hpOf(p: Player): number {
  return p.life.k === 'alive' ? p.life.hp : 0;
}

export function shootUntilDead(w: World, shooter: Player, victim: Player, angle = 0) {
  for (let i = 0; i < 40 && victim.life.k === 'alive'; i++) shootOnce(w, shooter, angle, 300);
  if (victim.life.k === 'alive') throw new Error('victim survived');
}

/** A socket a room can be connected to: `send` delivers a client message, `sent` holds what the room sent back, `pings` the payloads it pinged with. */
export function fakeSocket() {
  const sent: ServerMsg[] = [];
  const pings: string[] = [];
  const ws = Object.assign(new EventEmitter(), {
    OPEN: 1, readyState: 1,
    send: (data: string) => { sent.push(JSON.parse(data)); },
    close: () => {}, ping: (data?: unknown) => { pings.push(String(data ?? '')); }, terminate: () => {},
  });
  return {
    socket: ws as unknown as WebSocket,
    sent,
    pings,
    send: (msg: ClientMsg) => { ws.emit('message', Buffer.from(JSON.stringify(msg)), false); },
    pong: (data: string) => { ws.emit('pong', Buffer.from(data)); },
    close: () => { ws.emit('close'); },
  };
}

/** Puts exactly these walls in the world, as the map would, so the sim and the bots' arena both see them. */
export function setWalls(w: World, walls: readonly Rect[]) {
  w.walls = walls.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, built: false, material: 'concrete' as const, expiresAt: Infinity }));
  w.wallsVersion++;
}
