import { WORLD } from '../shared/defs.ts';
import type { Snapshot } from '../shared/protocol.ts';
import type { Camera } from './camera.ts';
import { addCorpse, explosiveDeath } from './corpses.ts';
import { createCracks } from './decals.ts';
import { startEffect } from './effects.ts';
import { scheduleEffects } from './eventclock.ts';
import { NO_FEEDBACK } from './feedback.ts';
import { gunFxOf, impact as gunImpact, muzzleFlash } from './gunfx.ts';
import { muzzleTip } from './gunart.ts';
import { NO_MOMENTS } from './moments.ts';
import { createPool } from './particles.ts';
import { bodyColor, drawWorld } from './render.ts';
import { serverMs } from './replaybuf.ts';
import type { Session } from './state.ts';

/**
 * Where a replay is drawn. It is the real session with its drifting, per-moment parts swapped for empty ones (effects, corpses,
 * sparks, damage numbers), so the live fight's leftovers never show in a replay and a replay never leaks into the live
 * game. The world is drawn by the normal `drawWorld`, so a replay looks like the game; the stage only replays what the events
 * of each frame would have made (impacts, flashes, a fallen body) as the playhead crosses them.
 */
export type Stage = { shadow: Session; clip: readonly Snapshot[]; fired: number };

export function createStage(s: Session, clip: readonly Snapshot[]): Stage {
  const shadow: Session = {
    ...s, effects: [], corpses: [], zombieCorpses: { list: [], dawnAt: null }, rounds: [], roundCover: new Map(), pendingFx: [], pendingShots: [],
    feedback: NO_FEEDBACK, moments: NO_MOMENTS, hurtAt: new Map(), cracks: createCracks(), particles: createPool(160),
    coreHitAt: -Infinity, turretAims: new Map(),
  };
  return { shadow, clip, fired: -1 };
}

const lastSeen = (clip: readonly Snapshot[], upTo: number, id: number) => {
  for (let i = Math.min(upTo, clip.length - 1); i >= 0; i--) {
    const p = clip[i]!.players.find((q) => q.id === id);
    if (p) return p;
  }
  return undefined;
};

/** Plays the events of every frame whose time the playhead (server ms) has reached since the last call. */
export function advanceStage(stage: Stage, playhead: number, now: number): void {
  const { clip, shadow } = stage;
  while (stage.fired + 1 < clip.length && serverMs(clip[stage.fired + 1]!) <= playhead) {
    const i = ++stage.fired;
    const frame = clip[i]!;
    for (const { fx } of scheduleEffects(frame, serverMs(frame))) {
      if (fx.kind === 'impact') {
        startEffect(shadow, fx, now);
        gunImpact(gunFxOf(shadow), fx.surface, fx, { walls: shadow.walls, crates: frame.crates, buildings: frame.buildings, run: frame.run }, now);
      } else if (fx.kind === 'death') {
        const victim = lastSeen(clip, i, fx.victim);
        const killer = fx.by === null || fx.by === fx.victim ? undefined : lastSeen(clip, i, fx.by);
        startEffect(shadow, fx, now, victim && bodyColor(victim));
        if (victim) {
          const blow = killer && Math.hypot(fx.x - killer.x, fx.y - killer.y) > 1 ? Math.atan2(fx.y - killer.y, fx.x - killer.x) : null;
          shadow.corpses = addCorpse(shadow.corpses, { victim: victim.id, x: fx.x, y: fx.y, angle: victim.angle, color: bodyColor(victim), gun: victim.gun, map: frame.match.map, born: now, blow, blast: explosiveDeath(fx.weapon) });
        }
      } else if (fx.kind === 'boom') startEffect(shadow, fx, now);
    }
    for (const ev of frame.events) {
      if (ev.e !== 'shot') continue;
      const p = frame.players.find((q) => q.id === ev.owner && q.alive);
      const angle = p?.angle ?? ev.angle;
      const muzzle = muzzleTip((p ?? ev).x, (p ?? ev).y, angle, ev.gun, WORLD.playerRadius);
      shadow.effects.push({ kind: 'flash', ...muzzle, angle, owner: ev.owner, born: now });
      muzzleFlash(gunFxOf(shadow), muzzle, angle, ev.gun, now);
    }
  }
  shadow.effects = shadow.effects.filter((e) => now - e.born < 800);
}

/**
 * What the world renderer reads from the session besides the frame itself, pinned to the replayed instant: the server clock
 * (airdrop, downed and royale animations are timed against it) and the point the roofs thin out around and the sound listens
 * from. Left as the shadow session copied them they would be the live game's: the clock at the live instant and the spot you died.
 */
export function replayView(frame: Snapshot, now: number, myId: number, fallback: { x: number; y: number }): { clockOffset: number; self: { x: number; y: number } } {
  const me = frame.players.find((p) => p.id === myId);
  return { clockOffset: serverMs(frame) - now, self: me ? { x: me.x, y: me.y } : fallback };
}

/** Draws one replayed frame through the normal world renderer. */
export function drawStage(ctx: CanvasRenderingContext2D, stage: Stage, snap: Snapshot, cam: Camera, dpr: number, now: number, killerId: number | null): void {
  const v = replayView(snap, now, stage.shadow.myId, stage.shadow.lastSelf);
  stage.shadow.snaps = { snaps: stage.shadow.snaps.snaps, serverClockOffset: v.clockOffset };
  stage.shadow.lastSelf = v.self;
  drawWorld(ctx, { snap, s: stage.shadow, cam, dpr, now, selfAngle: null, killerId });
}
